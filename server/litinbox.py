import json
import os
import re
import shutil
import threading
import datetime
from pathlib import Path

import reading                      # vault paths + the reading-list engine (link repoint)
from drafting import _native_run, _native_tool

INBOX = reading.READING_DIR / "Inbox"
CORPUS = reading.CORPUS_DIR
ARCHIVE = CORPUS / "archive"
CITATIONS = reading.CITATIONS_DIR
CORPUS_REL = "Preparation/Reading/Corpus"

# `Author (Year) - Title` — the corpus naming convention. Year accepts n.d. and
# classical forms (350BC) the corpus auditor already tolerates.
CONV = re.compile(r".+\((?:\d{4}|\d{3,4}\s?BCE?|n\.?\s?d\.?)\)\s*-\s*\S", re.I)
BAD_CHARS = re.compile(r'[\\/:*?"<>|#\[\]]')
MAX_STEM = 180

MIN_BYTES = 8 * 1024
HTML_MARKERS = (
    b"<!doctype html", b"<html", b"<head", b"<body", b"<?xml",
    b"<!DOCTYPE HTML", b"access denied", b"403 forbidden", b"404 not found",
    b"captcha", b"are you a robot", b"please enable javascript",
    b"sign in to", b"institutional login", b"subscribe to read",
    b"<title>", b"cloudflare", b"just a moment",
)

_lock = threading.Lock()
_detail_cache = {}
_CACHE_CAP = 64


# ------------------------------------------------------------------ fs helpers
def _stable_pdfs(passes=4):
    """Inbox *.pdf names, robust on a slow or network file system: union several
    listdir passes (a real file can flicker out of a single listing) and
    stat-confirm each entry so a phantom dirent is never surfaced."""
    seen = set()
    for _ in range(passes):
        try:
            seen.update(os.listdir(INBOX))
        except OSError:
            pass
    out = []
    for fn in sorted(seen):
        if not fn.lower().endswith(".pdf"):
            continue
        try:
            if (INBOX / fn).is_file():
                out.append(fn)
        except OSError:
            continue
    return out


def _confine(name):
    """An Inbox basename, or None. No separators, no traversal, must be a .pdf."""
    n = (name or "").strip()
    if not n or n != os.path.basename(n) or n in (".", "..") or not n.lower().endswith(".pdf"):
        return None
    return n


def _unique(dirpath, fn):
    dst = dirpath / fn
    i = 1
    while dst.exists():
        stem, ext = os.path.splitext(fn)
        dst = dirpath / f"{stem} ({i}){ext}"
        i += 1
    return dst


# ------------------------------------------------------------------ the gate
def _gate(path):
    """The corpus gate:
    GARBAGE never enters Corpus; SUSPECT (no text layer) is flagged but fileable
    because the triage human sees the rendered pages."""
    try:
        size = path.stat().st_size
    except OSError:
        return {"verdict": "GARBAGE", "reason": "file unreadable / vanished", "pages": None}
    if size < MIN_BYTES:
        return {"verdict": "GARBAGE", "reason": f"only {size} bytes — a truncated stub or error body", "pages": None}
    try:
        with open(path, "rb") as fh:
            head = fh.read(4096)
    except OSError:
        return {"verdict": "GARBAGE", "reason": "file unreadable", "pages": None}
    low = head.lower()
    pdf_at = low.find(b"%pdf")
    for m in HTML_MARKERS:
        idx = low.find(m)
        if idx != -1 and (pdf_at == -1 or idx < pdf_at):
            return {"verdict": "GARBAGE",
                    "reason": f"sniffs as an HTML/error page ({m.decode('latin1')!r})", "pages": None}
    if pdf_at == -1 or pdf_at > 1024:
        return {"verdict": "GARBAGE", "reason": "no %PDF magic — not a PDF at all", "pages": None}
    info = _pdfinfo(path)
    if info is None:
        return {"verdict": "GARBAGE", "reason": "no PDF engine can open it — corrupt or truncated", "pages": None}
    pages = info.get("pages")
    if not pages:
        return {"verdict": "GARBAGE", "reason": "opens but reports zero pages", "pages": 0}
    return {"verdict": "VALID", "reason": "", "pages": pages, "meta": info}


def _pdfinfo(path):
    """{'pages': n, 'title': ..., 'author': ..., 'created': ...} via pdfinfo, or None."""
    try:
        exe = _native_tool("pdfinfo")
        if not exe:
            return None
        r = _native_run([exe, str(Path(path).resolve())], path.parent, 30)
    except Exception:
        return None
    if r.returncode != 0:
        return None
    out = {"pages": None, "title": "", "author": "", "created": ""}
    for ln in (r.stdout or "").splitlines():
        if ":" not in ln:
            continue
        k, v = ln.split(":", 1)
        k, v = k.strip().lower(), v.strip()
        if k == "pages":
            try:
                out["pages"] = int(v)
            except ValueError:
                pass
        elif k == "title":
            out["title"] = v
        elif k == "author":
            out["author"] = v
        elif k == "creationdate":
            out["created"] = v
    return out


def _first_pages_text(path):
    try:
        exe = _native_tool("pdftotext")
        if not exe:
            return ""
        r = _native_run([exe, "-f", "1", "-l", "2", str(Path(path).resolve()), "-"], path.parent, 40)
    except Exception:
        return ""
    if r.returncode != 0:
        return ""
    txt = re.sub(r"[ \t]+", " ", (r.stdout or "")).strip()
    return txt[:2400]


# ------------------------------------------------------------------ suggestion
_STOPWORDS = {"the", "and", "for", "with", "from", "into", "about", "between",
              "their", "does", "how", "what", "why", "when", "are", "not"}


def _clean_field(s):
    s = BAD_CHARS.sub(" ", s or "")
    return re.sub(r"\s+", " ", s).strip()


def _author_surnames(meta_author):
    raw = _clean_field(meta_author)
    if not raw or "@" in raw or raw.lower().startswith(("adobe", "acrobat", "microsoft")):
        return ""
    parts = re.split(r"\s*(?:;|,|\band\b|&)\s*", raw)
    parts = [p for p in (x.strip() for x in parts) if p and len(p) > 1]
    surnames = []
    for p in parts:
        toks = p.split()
        if toks:
            surnames.append(toks[-1])
    if not surnames:
        return ""
    if len(surnames) == 1:
        return surnames[0]
    if len(surnames) == 2:
        return f"{surnames[0]} and {surnames[1]}"
    return f"{surnames[0]} et al."


def _year_guess(meta, text):
    """A publication-year prefill: a year printed on the opening page beats the
    file's CreationDate (which is often the download year)."""
    head = (text or "")[:800]
    for pat in (r"\((19|20)\d{2}\)", r"©\s*(19|20)\d{2}", r"\b(19|20)\d{2}\b"):
        m = re.search(pat, head)
        if m:
            y = re.search(r"(19|20)\d{2}", m.group(0))
            if y:
                return y.group(0)
    m = re.search(r"(19|20)\d{2}", (meta or {}).get("created", ""))
    return m.group(0) if m else ""


def _title_guess(meta):
    t = _clean_field((meta or {}).get("title", ""))
    if len(t) < 8 or t.lower().endswith((".pdf", ".dvi", ".doc", ".tex", ".indd")):
        return ""
    return t


def _parse_stem(stem):
    m = re.match(r"^(?P<author>.+?)\s*\((?P<year>[^)]+)\)\s*-\s*(?P<title>.+)$", stem)
    if not m:
        return None
    return {"author": m.group("author").strip(), "year": m.group("year").strip(),
            "title": m.group("title").strip()}


def _tokens(s):
    return {t for t in re.findall(r"[a-z0-9]{3,}", (s or "").lower()) if t not in _STOPWORDS}


def _queue_matches(fname, meta, text):
    """Download-queue items this file plausibly IS, scored by title-token overlap
    against the filename + metadata + opening-page text. Filing can link one,
    clearing its download flag (reading.item_download)."""
    hay = _tokens(f"{fname} {(meta or {}).get('title', '')} {(text or '')[:1200]}")
    out = []
    try:
        queue = reading.downloads()
    except Exception:
        return []
    for d in queue:
        want = _tokens(d.get("title", ""))
        if not want:
            continue
        score = len(want & hay) / len(want)
        if score >= 0.4:
            out.append({"list": d["list"], "group": d["group"], "item": d["item"],
                        "where": d.get("where") or "active", "file": d.get("file"),
                        "title": d["title"], "why": d.get("why"), "score": round(score, 2)})
    out.sort(key=lambda x: -x["score"])
    return out[:5]


def _linked_items(fname):
    return [{"list": h["list"], "title": h["title"]} for h in reading.linked_items({fname})]


# ------------------------------------------------------------------ API surface
def list_inbox():
    """The triage queue: every Inbox PDF with the cheap fields (no poppler here)."""
    items = []
    for fn in _stable_pdfs():
        p = INBOX / fn
        try:
            st = p.stat()
        except OSError:
            continue
        stem = os.path.splitext(fn)[0]
        items.append({"name": fn, "size": st.st_size, "mtime": int(st.st_mtime),
                      "stemOk": bool(CONV.match(stem)),
                      "dupInCorpus": (CORPUS / fn).exists()})
    return {"count": len(items), "items": items}


def detail(name):
    """Everything the triage panel needs for one file: gate verdict, pages, PDF
    metadata, opening-page text, a name suggestion, queue matches, linked items."""
    fn = _confine(name)
    if not fn:
        return {"error": "bad name"}
    p = INBOX / fn
    try:
        st = p.stat()
    except OSError:
        return {"error": "not in the Inbox"}
    key = (fn, st.st_size, int(st.st_mtime))
    with _lock:
        if key in _detail_cache:
            return _detail_cache[key]
    g = _gate(p)
    meta = g.pop("meta", None) or {}
    text = _first_pages_text(p) if g["verdict"] == "VALID" else ""
    if g["verdict"] == "VALID" and not text:
        g = {**g, "verdict": "SUSPECT",
             "reason": "no extractable text on the opening pages — likely an image scan; check the preview"}
    stem = os.path.splitext(fn)[0]
    parsed = _parse_stem(stem) if CONV.match(stem) else None
    suggestion = parsed or {"author": _author_surnames(meta.get("author", "")),
                            "year": _year_guess(meta, text),
                            "title": _title_guess(meta)}
    res = {"ok": True, "name": fn, "size": st.st_size,
           "verdict": g["verdict"], "reason": g["reason"], "pages": g["pages"],
           "stemOk": bool(CONV.match(stem)), "dupInCorpus": (CORPUS / fn).exists(),
           "meta": {"title": meta.get("title", ""), "author": meta.get("author", ""),
                    "created": meta.get("created", "")},
           "textHead": text[:1600], "suggestion": suggestion,
           "queueMatches": _queue_matches(fn, meta, text) if g["verdict"] != "GARBAGE" else [],
           "linkedItems": _linked_items(fn)}
    with _lock:
        if len(_detail_cache) >= _CACHE_CAP:
            _detail_cache.clear()
        _detail_cache[key] = res
    return res


def pdf_bytes(name):
    """The raw Inbox PDF for the preview iframe. Confined to the Inbox."""
    fn = _confine(name)
    if not fn:
        return None
    try:
        return (INBOX / fn).read_bytes(), "application/pdf"
    except OSError:
        return None


def check_stem(stem):
    """Live validation for the rename form: convention + illegal chars + collision."""
    s = (stem or "").strip().rstrip(". ")
    if not s:
        return {"valid": False, "problem": "empty"}
    if BAD_CHARS.search(s):
        bad = sorted(set(BAD_CHARS.findall(s)))
        return {"valid": False, "problem": "illegal characters: " + " ".join(bad)}
    if len(s) > MAX_STEM:
        return {"valid": False, "problem": f"too long ({len(s)} > {MAX_STEM} chars)"}
    if not CONV.match(s):
        return {"valid": False, "problem": "not `Author (Year) - Title`"}
    if (CORPUS / (s + ".pdf")).exists():
        note = (CITATIONS / (s + ".md")).exists()
        return {"valid": False, "problem": "a Corpus PDF with this exact name already exists",
                "collision": True, "noteExists": note}
    return {"valid": True, "noteExists": (CITATIONS / (s + ".md")).exists()}


def _repoint(old_fname, new_fname, corpus_rel):
    return [h["title"] for h in reading.repoint_pdf({old_fname, new_fname}, corpus_rel)]


def act(data):
    action = (data or {}).get("action")
    fn = _confine((data or {}).get("name"))
    if not fn:
        return {"error": "bad name"}
    with _lock:
        src = INBOX / fn
        if not src.is_file():
            return {"error": "not in the Inbox (already filed?)"}

        if action == "archive":
            ARCHIVE.mkdir(parents=True, exist_ok=True)
            dst = _unique(ARCHIVE, fn)
            shutil.move(str(src), str(dst))
            try:
                with open(ARCHIVE / "_triage_log.jsonl", "a", encoding="utf-8") as fh:
                    fh.write(json.dumps({"file": fn, "archived_as": dst.name,
                                         "reason": (data.get("reason") or "").strip(),
                                         "via": "inbox-triage",
                                         "date": datetime.date.today().isoformat()},
                                        ensure_ascii=False) + "\n")
            except OSError:
                pass
            _detail_cache.clear()
            return {"ok": True, "archived": dst.name}

        if action != "file":
            return {"error": "unknown action"}

        stem = (data.get("stem") or "").strip().rstrip(". ")
        chk = check_stem(stem)
        if not chk["valid"]:
            return {"error": chk["problem"], "collision": chk.get("collision", False)}
        g = _gate(src)
        if g["verdict"] == "GARBAGE":
            return {"error": "failed the corpus gate: " + g["reason"]}

        new_fname = stem + ".pdf"
        # the contract: rename while still in the Inbox, only then file
        if new_fname != fn:
            renamed = INBOX / new_fname
            if renamed.exists():
                return {"error": "another Inbox file already has that name"}
            os.replace(str(src), str(renamed))
            src = renamed
        corpus_rel = f"{CORPUS_REL}/{new_fname}"
        CORPUS.mkdir(parents=True, exist_ok=True)
        shutil.move(str(src), str(CORPUS / new_fname))
        # the file is already in Corpus: wait for the lock rather than leave its link behind
        with reading.locked():
            repointed = _repoint(fn, new_fname, corpus_rel)

            link = data.get("link")
            if isinstance(link, dict) and link.get("list") is not None:
                r = reading.item_download({"list": link.get("list"), "group": link.get("group"),
                                           "item": link.get("item"), "pdf": corpus_rel,
                                           "where": link.get("where") or "active",
                                           "file": link.get("file")})
                if r and link.get("title"):
                    repointed.append(link["title"])

        # optional: capture citation metadata + write the BibTeX entry now, so the
        # filed paper is citeable immediately (lazy import — litcite imports us back).
        cite = None
        citation = data.get("citation")
        if isinstance(citation, dict):
            try:
                import litcite
                cite = litcite.write_on_file(stem, citation)
            except Exception as e:
                cite = {"cited": False, "error": str(e)[:160]}

        _detail_cache.clear()
        return {"ok": True, "filed": new_fname, "corpusRel": corpus_rel,
                "repointed": repointed, "cite": cite,
                "needsNote": not (CITATIONS / (stem + ".md")).exists()}
