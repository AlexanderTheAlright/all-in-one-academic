"""Claim-level search over the citation notes (SQLite FTS5)."""
import settings

import hashlib
import itertools
import json
import math
import os
import re
import sqlite3
import threading
import time
from pathlib import Path

DB_PATH = Path(os.environ.get("CLAIMS_INDEX_DB")
               or settings.STATE_DIR / "claims-index.sqlite")
VAULT = settings.VAULT


def _use_vault(vault):
    """One DB per vault: a QA copy must never rescan the real index away."""
    global DB_PATH, VAULT
    VAULT = Path(vault).expanduser().resolve()
    if os.environ.get("CLAIMS_INDEX_DB"):
        return
    name = "claims-index.sqlite"
    if VAULT != (settings.VAULT).resolve():
        name = f"claims-index-{hashlib.sha1(str(VAULT).encode()).hexdigest()[:10]}.sqlite"
    DB_PATH = settings.STATE_DIR / name


SCHEMA_VERSION = 5          # reindex native hashtag metadata in existing notes
RESCAN_SECS = 300
MAX_FILE_BYTES = 2 * 1024 * 1024
BATCH = 200
BATCH_PAUSE = 0.05
CITATION_ROOTS = ("Preparation/Reading/Citations", settings.PRIMARY_SOURCES_REL + "/Citations")
PROJECT_CONTAINERS = ("papers", "grants", "experiments", "briefs")

# bm25 column weights, in FTS column order (headline, tags, detail, quotes, evidence)
WEIGHTS = (8.0, 4.0, 2.0, 1.0, 1.0)
STRENGTH_BONUS = {"strong": 2.0, "some": 1.0, "weak": 0.0}
KINDS = ("empirical", "theoretical", "methodological", "normative")
STRENGTHS = ("strong", "some", "weak")
SUMMARY_MAX = 600
RELATED_MAX = 12
PAPER_REPEAT_PENALTY = 1.5
_STOP = set("""about above after again against also among because been before being below
between both could does doing down during each even from further have having here into
itself just more most much must never only other over same should some such than that their
them then there these they this those through under until very were what when where which
while with would your paper authors author study argues shows finds claim claims""".split())

_state = {"building": False, "last_build": None, "last_scan_secs": None,
          "claims": 0, "papers": 0, "errors": [], "started": False}
_state_lock = threading.Lock()
_local = threading.local()


# ---------------------------------------------------------------- schema

def _connect(readonly=False):
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH), timeout=10, check_same_thread=False)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    if readonly:
        conn.execute("PRAGMA query_only=1")
    return conn


def _ensure_schema(conn):
    ver = conn.execute("PRAGMA user_version").fetchone()[0]
    if ver != SCHEMA_VERSION:
        conn.executescript("""
            DROP TABLE IF EXISTS papers; DROP TABLE IF EXISTS claims; DROP TABLE IF EXISTS fts;
            DROP TABLE IF EXISTS claim_tags; DROP TABLE IF EXISTS claim_concepts;
            DROP TABLE IF EXISTS claim_links; DROP TABLE IF EXISTS corpus;
            DROP TABLE IF EXISTS members;""")
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS papers (
            id INTEGER PRIMARY KEY, path TEXT UNIQUE NOT NULL, stem TEXT,
            mtime REAL, size INTEGER, citekey TEXT, author TEXT, year INTEGER,
            title TEXT, source TEXT, rating REAL, structured INTEGER,
            summary TEXT, citation TEXT, limitations TEXT, unattached TEXT, n_quotes INTEGER,
            q_explicit INTEGER, q_inferred INTEGER, q_unattached INTEGER);
        CREATE INDEX IF NOT EXISTS papers_stem ON papers(stem);
        CREATE TABLE IF NOT EXISTS claims (
            id INTEGER PRIMARY KEY, cid TEXT UNIQUE NOT NULL, paper_id INTEGER, n INTEGER,
            headline TEXT, detail TEXT, pages TEXT, tags TEXT, kind TEXT, evidence TEXT,
            strength TEXT, scope TEXT, supports TEXT, contests TEXT, extends TEXT, quotes TEXT);
        CREATE INDEX IF NOT EXISTS claims_paper ON claims(paper_id);
        CREATE TABLE IF NOT EXISTS claim_tags (claim_id INTEGER, tag TEXT);
        CREATE INDEX IF NOT EXISTS claim_tags_tag ON claim_tags(tag);
        CREATE INDEX IF NOT EXISTS claim_tags_claim ON claim_tags(claim_id);
        CREATE TABLE IF NOT EXISTS claim_concepts (claim_id INTEGER, slug TEXT, strength TEXT, via TEXT);
        CREATE INDEX IF NOT EXISTS claim_concepts_slug ON claim_concepts(slug);
        CREATE INDEX IF NOT EXISTS claim_concepts_claim ON claim_concepts(claim_id);
        CREATE TABLE IF NOT EXISTS claim_links (claim_id INTEGER, rel TEXT, stem TEXT, n INTEGER);
        CREATE INDEX IF NOT EXISTS claim_links_dst ON claim_links(stem, n);
        CREATE INDEX IF NOT EXISTS claim_links_src ON claim_links(claim_id);
        CREATE TABLE IF NOT EXISTS corpus (
            path TEXT PRIMARY KEY, mtime REAL, size INTEGER, project TEXT, has_kp INTEGER);
        CREATE TABLE IF NOT EXISTS members (corpus_path TEXT, project TEXT, stem TEXT);
        CREATE INDEX IF NOT EXISTS members_stem ON members(stem);
        CREATE INDEX IF NOT EXISTS members_path ON members(corpus_path);
        CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
            headline, tags, detail, quotes, evidence,
            tokenize="unicode61 remove_diacritics 2", prefix='2 3');
    """)
    conn.execute(f"PRAGMA user_version={SCHEMA_VERSION}")
    conn.commit()


def _reader():
    conn = getattr(_local, "conn", None)
    if conn is None or getattr(_local, "path", None) != str(DB_PATH):
        conn = _connect(readonly=True)
        _local.conn, _local.path = conn, str(DB_PATH)
    return conn


def _error(msg):
    with _state_lock:
        _state["errors"] = (_state["errors"] + [f"{time.strftime('%H:%M:%S')} {msg}"])[-20:]


# ---------------------------------------------------------------- note parsing

_FM_KEY = re.compile(r"^([A-Za-z_][\w-]*)\s*:\s*(.*)$")
_HASHTAG = re.compile(r"(?<![\w/&])#((?=[\w/-]*[^\W\d])\w[\w/-]*)")
_TAG_JOINERS = {"and", "or", "versus", "vs", "vs.", "&", ",", "with", "/", "+"}
_ITEM = re.compile(r"^( {0,2})(?:(\d+)[.)]|[-*+])\s+(.*)$")
_FIELD = re.compile(r"^\s*(?:>\s*)?(kind|evidence|strength|scope|supports|contests|extends)::\s*(.*)$", re.I)
_NATIVE_KIND = re.compile(r"^[ \t]+#(empirical|theoretical|methodological|normative)\s*$", re.I)
_NATIVE_FIELD = re.compile(r"^([ \t]+)#(evidence|strength|scope|contests|extends):\s*$", re.I)
_CLAIM_LINE = re.compile(r"^\s*(?:[-*]\s+|>\s*)*claim::\s*(.*)$", re.I)
_SUPPORTS_LINE = re.compile(r"^\s*(?:[-*]\s+|>\s*)*supports::\s*(.*)$", re.I)
_PAIR = re.compile(r"\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]\s*(strong|some|weak)?", re.I)
_CLAIM_REF = re.compile(r"\[\[([^\]|#]+)(?:#\s*K(\d+))?(?:\|[^\]]*)?\]\](?:\s*#\s*K(\d+))?", re.I)
_KREF = re.compile(r"K\s*(\d+)", re.I)
_PAGES = re.compile(r"\bpp?\.\s*(\d+)(?:\s*[-–—]\s*(\d+))?")
_LINK = re.compile(r"\[\[([^\]|]+)(?:\|([^\]]*))?\]\]")
_WIKI_TARGET = re.compile(r"\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]")
_LINK_ONLY = re.compile(r"^\s*\(?\s*!?\[\[[^\]]+\]\]\s*\)?\s*$")


def _clean_scalar(v):
    v = v.strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
        v = v[1:-1]
    return v.strip()


def _split_frontmatter(text):
    text = text.lstrip("﻿")
    if not text.startswith("---"):
        return {}, text
    m = re.match(r"^---[ \t]*\r?\n(.*?)\r?\n---[ \t]*(?:\r?\n|$)", text, re.S)
    if not m:
        return {}, text
    fm, key = {}, None
    for line in m.group(1).splitlines():
        km = _FM_KEY.match(line)
        if km and not line.startswith((" ", "\t")):
            key, val = km.group(1).lower(), km.group(2).strip()
            if val.startswith("[") and val.endswith("]") and not val.startswith("[["):
                fm[key] = [_clean_scalar(x) for x in val[1:-1].split(",") if x.strip()]
            elif val:
                fm[key] = _clean_scalar(val)
            else:
                fm[key] = []
        elif key and line.lstrip().startswith("- "):
            item = _clean_scalar(line.lstrip()[2:])
            if not isinstance(fm.get(key), list):
                fm[key] = [fm[key]] if fm.get(key) else []
            if item:
                fm[key].append(item)
    return fm, text[m.end():]


def _scalar(fm, key):
    v = fm.get(key)
    if isinstance(v, list):
        v = ", ".join(str(x) for x in v)
    return str(v or "").strip()


def _year(v):
    m = re.search(r"\d{4}", v or "")
    return int(m.group(0)) if m else None


def _rating(v):
    """'4', '4/5', '4.5', '8' (out of 10) -> 0-5, or None."""
    m = re.match(r"^\s*(\d+(?:\.\d+)?)\s*(?:/\s*(\d+))?", v or "")
    if not m:
        return None
    x = float(m.group(1))
    den = float(m.group(2)) if m.group(2) else (10.0 if x > 5 else 5.0)
    return round(max(0.0, min(5.0, x * 5.0 / den)), 2) if den else None


def _slug(target):
    t = (target or "").strip().replace("\\", "/").rsplit("/", 1)[-1]
    if t.lower().endswith(".md"):
        t = t[:-3]
    return t.strip()


def _norm_concept(s):
    return re.sub(r"\s+", "-", _slug(s).lower())


def _tag_line(s):
    """'#a and #b:' or '**a:**' -> [tags], or None when the line is not a tag line."""
    s = s.strip()
    m = re.match(r"^\*\*([\w/-]+):?\*\*:?$", s)
    if m:
        return [m.group(1).lower()]
    if s.startswith("# ") or s.startswith("##"):
        return None
    tags = [t.rstrip("/-").lower() for t in _HASHTAG.findall(s)]
    if s.startswith("#") and tags:
        rest = _HASHTAG.sub(" ", s).rstrip(":").replace(",", " , ")
        if all(w.lower() in _TAG_JOINERS for w in rest.split()):
            return tags
    # an older label line: "morality at the center:" or "label #tag #tag:"
    if (s.endswith(":") and len(s) <= 140 and ". " not in s and "[[" not in s
            and "::" not in s and not re.match(r"^(?:\d+[.)]|[-*+>])\s", s) and not s.startswith("**")):
        if tags:
            return tags
        label = re.sub(r"[^\w]+", "-", s[:-1].strip().lower()).strip("-")
        return [label] if label else None
    return None


def _sections(body):
    """[(heading lower, [lines])] for every '## ' section."""
    out, name, cur = [], "", []
    for line in body.split("\n"):
        line = line.rstrip("\r")
        if line.startswith("## "):
            out.append((name, cur))
            name, cur = line[3:].strip().lower(), []
        else:
            cur.append(line)
    out.append((name, cur))
    return out


def _page_ranges(text):
    out = []
    for m in _PAGES.finditer(text or ""):
        lo = int(m.group(1))
        hi = int(m.group(2)) if m.group(2) else lo
        if hi < lo and len(m.group(2)) < len(m.group(1)):      # p.214-16 -> 214-216
            hi = int(m.group(1)[:len(m.group(1)) - len(m.group(2))] + m.group(2))
        if hi < lo or hi - lo > 400:
            hi = lo
        out.append((lo, hi))
    return out


def _strip_md(s):
    return re.sub(r"\s+", " ", (s or "").replace("**", "").replace("__", "")).strip()


def _headline(text):
    m = re.match(r"^\*\*(.+?)\*\*\s*[:.\-–—]?\s*(.*)$", text, re.S)
    if m:
        return _strip_md(m.group(1)).rstrip(".:").strip(), _strip_md(m.group(2))
    t = _strip_md(text)
    m = re.match(r"^(.{12,220}?[.!?])\s+(\S.*)$", t, re.S)
    if m:
        return m.group(1), m.group(2)
    if len(t) > 220:
        cut = t.rfind(" ", 0, 200)
        return t[:cut if cut > 0 else 200] + "…", t
    return t, ""


def _apply_field(item, key, val):
    key, val = key.lower(), val.strip()
    if key == "kind":
        v = val.lower().split()[0] if val else ""
        if v in KINDS:
            item["kind"] = v
    elif key == "strength":
        v = val.lower().split()[0] if val else ""
        if v in STRENGTHS:
            item["strength"] = v
    elif key in ("evidence", "scope"):
        if val:
            item[key] = (item.get(key, "") + " " + val).strip()[:1000] if item.get(key) else val[:1000]
    elif key == "supports":
        for m in _PAIR.finditer(val):
            item["supports"].append([_norm_concept(m.group(1)), (m.group(2) or "some").lower()])
    elif key in ("contests", "extends"):
        for m in _CLAIM_REF.finditer(val):
            k = m.group(2) or m.group(3)
            if k:
                item[key].append([_slug(m.group(1)), int(k)])


def _parse_key_points(lines):
    items, cur, tags = [], None, []
    pending, next_kind = None, ""

    def flush():
        nonlocal pending
        if pending is not None:
            owner, key, values, _ = pending
            _apply_field(owner, key, " ".join(values))
            pending = None

    for line in lines:
        s = line.strip()
        if not s:
            flush()
            continue
        # Metadata belongs to the active item, never the next topic-tag line.
        # Preserve the original field indentation; unindented topic tags remain tags.
        kind = _NATIVE_KIND.fullmatch(line)
        field = _NATIVE_FIELD.fullmatch(line)
        if cur is not None and kind:
            flush()
            _apply_field(cur, "kind", kind.group(1))
            continue
        if cur is not None and field:
            flush()
            pending = (cur, field.group(2), [], len(field.group(1)))
            continue
        if pending is not None:
            indent = len(line) - len(line.lstrip())
            if (indent >= pending[3] and not _ITEM.match(line)
                    and not _FIELD.match(line)
                    and not re.match(r'^#{1,6}\s', s)
                    and not s.startswith((">", "```", "~~~"))):
                pending[2].append(s)
                continue
            flush()
        if s.startswith((">", "```", "~~~")):
            cur = None
            continue
        tl = _tag_line(s)
        if tl is not None:
            if tl and tl[0] in KINDS:
                next_kind, tl = tl[0], tl[1:]
                if tl:
                    tags = tl
            else:
                next_kind, tags = "", tl
            cur = None
            continue
        f = _FIELD.match(line)
        if f and cur is not None:
            _apply_field(cur, f.group(1), f.group(2))
            continue
        m = _ITEM.match(line)
        if m and not s.startswith(">"):
            cur = {"num": int(m.group(2)) if m.group(2) else None, "text": m.group(3).strip(),
                   "tags": list(tags), "kind": next_kind, "evidence": "", "strength": "", "scope": "",
                   "supports": [], "contests": [], "extends": []}
            next_kind = ""
            items.append(cur)
            continue
        if cur is not None and not s.startswith(">"):
            cur["text"] += " " + s
    flush()
    nums = [it["num"] for it in items]
    use_num = all(n is not None for n in nums) and len(set(nums)) == len(nums)
    for i, it in enumerate(items):
        it["n"] = it["num"] if use_num else i + 1
        it["headline"], it["detail"] = _headline(it["text"])
        it["ranges"] = _page_ranges(it["text"])
        it["pages"] = ", ".join(f"{a}-{b}" if b != a else str(a) for a, b in it["ranges"])
    return items


def _parse_limitations(lines):
    out, cur = [], None
    for line in lines:
        s = line.strip()
        if not s:
            continue
        if _tag_line(s) is not None:
            cur = None
            continue
        m = _ITEM.match(line)
        if m:
            cur = [m.group(3).strip()]
            out.append(cur)
        elif cur is not None:
            cur.append(s)
    res = []
    for parts in out:
        t = _strip_md(" ".join(parts))
        res.append(t[:400] + ("…" if len(t) > 400 else ""))
    return res[:30]


def _quote_link(line):
    m = _LINK.search(line)
    if not m:
        return None
    target, alias = m.group(1), m.group(2) or ""
    pm = re.search(r"#page=(\d+)", target)
    am = re.search(r"\bpp?\.\s*(\d+)", alias)
    return {"pdf_link": target.strip(), "pdf_page": int(pm.group(1)) if pm else None,
            "page": int(am.group(1)) if am else (int(pm.group(1)) if pm else None)}


def _parse_quotes(lines):
    """-> [{text, page, pdf_page, pdf_link, tags, claims:[n], supports:[[slug, str]]}]."""
    quotes, cur, tags, open_, blanks = [], None, [], False, 0
    native_pending = False
    fence = False
    for line in lines:
        s = line.strip()
        if s.startswith(("```", "~~~")):
            fence = not fence
            native_pending, open_ = False, False
            continue
        if fence:
            continue
        cm = _CLAIM_LINE.match(line)
        sm = None if cm else _SUPPORTS_LINE.match(line)
        if cm or sm:
            if cur is not None and open_ and blanks <= 1:
                blanks = 0
                if cm:
                    cur["claims"].extend(int(k) for k in _KREF.findall(cm.group(1)))
                else:
                    for m in _PAIR.finditer(sm.group(1)):
                        cur["supports"].append([_norm_concept(m.group(1)), (m.group(2) or "some").lower()])
                cur["closed"] = True
            continue
        if s.startswith(">"):
            inner = s.lstrip(">").strip()
            if cur is None or not open_ or blanks or cur.get("closed"):
                cur = {"lines": [], "link": None, "tags": list(tags), "claims": [], "supports": [],
                       "native_claim": native_pending}
                quotes.append(cur)
                native_pending = False
            if cur["link"] is None and "[[" in inner:
                cur["link"] = _quote_link(inner)
            if inner and not _LINK_ONLY.match(inner):
                cur["lines"].append(inner)
            open_, blanks = True, 0
            continue
        if not s:
            blanks += 1
            native_pending = False
            continue
        tl = _tag_line(s)
        if tl is not None:
            tags = tl
        native_pending = tl is not None and "claim" in tl
        open_ = False
    out = []
    for q in quotes:
        text = re.sub(r"\s+", " ", " ".join(q["lines"])).strip()
        if not text:
            continue
        link = q["link"] or {}
        out.append({"text": text[:2000], "page": link.get("page"), "pdf_page": link.get("pdf_page"),
                    "pdf_link": link.get("pdf_link", ""),
                    "native_claim": q["native_claim"],
                    "tags": [t for t in q["tags"] if t != "claim" and not t.startswith("claim/")],
                    "claims": sorted(set(q["claims"])), "supports": q["supports"]})
    return out


def _infer(quote, items):
    """-> [(item, why)] for a quote with no claim:: line."""
    qtags = {t for t in quote["tags"] if not t.startswith("limitation")}
    pages = [p for p in (quote["page"], quote["pdf_page"]) if p is not None]

    def on_page(it):
        return bool(pages) and any(lo - 1 <= p <= hi + 1 for p in pages for lo, hi in it["ranges"])
    shared = [(it, qtags & set(it["tags"])) for it in items if not it.get("native_id")]
    out = [(it, "tag+page") for it, sh in shared if sh and on_page(it)]
    if out:
        return out
    out = [(it, "tags") for it, sh in shared if len(sh) >= 2]
    if out:
        return out
    tagged = [it for it, sh in shared if sh]
    if len(tagged) == 1 and not tagged[0]["ranges"]:
        return [(tagged[0], "tag")]
    return []


def parse_citation(rel, text):
    """A citation note -> paper dict with claims. Pure; used by the indexer and tests."""
    fm, body = _split_frontmatter(text)
    secs = _sections(body)
    kp_lines, lim, qlines, summary, citation = [], [], [], "", ""
    for name, lines in secs:
        if name.startswith("key points") or name.startswith("key themes") or name == "key claims":
            kp_lines += lines
        elif name.startswith("limitation"):
            lim += lines
        elif "quote" in name:
            qlines += lines + [""]
        elif name.startswith("brief summary") or name == "summary":
            summary = _strip_md(" ".join(lines))
        elif name == "citation":
            citation = _strip_md(" ".join(l for l in lines if l.strip()))
    items = _parse_key_points(kp_lines)
    quotes = _parse_quotes(qlines)
    by_n = {it["n"]: it for it in items}
    for it in items:
        it["quotes"] = []
    unattached = []
    explicit_any = False
    qstats = {"explicit": 0, "inferred": 0, "unattached": 0}
    native_seen = set()
    for q in quotes:
        rec = {k: q[k] for k in ("text", "page", "pdf_page", "pdf_link", "tags")}
        hit = None
        if q.get("native_claim"):
            # A native claim is this passage, not a guessed numbered Key Point.
            key = hashlib.sha256((q["pdf_link"] + "\n" + q["text"]).encode()).hexdigest()[:15]
            if key in native_seen:
                continue
            native_seen.add(key)
            topics = dict.fromkeys(q["tags"], "some")
            topics.update(dict(q["supports"]))
            items.append({"n": -int(key, 16), "native_id": "Q" + key,
                          "headline": q["text"], "detail": "", "pages": str(q["page"] or ""),
                          "tags": q["tags"], "kind": "", "evidence": "", "strength": "",
                          "scope": "", "supports": [], "contests": [], "extends": [],
                          "ranges": [], "quotes": [dict(rec, linked="explicit", supports=list(topics.items()))]})
            explicit_any = True
            qstats["explicit"] += 1
            continue
        if q["claims"]:
            explicit_any = True
            for n in q["claims"]:
                if n in by_n:
                    by_n[n]["quotes"].append(dict(rec, linked="explicit", supports=q["supports"]))
                    hit = "explicit"
        else:
            for it, why in _infer(q, items):
                it["quotes"].append(dict(rec, linked="inferred", why=why))
                hit = "inferred"
        qstats[hit or "unattached"] += 1
        if not hit:
            unattached.append(dict(rec, supports=q["supports"]) if q["supports"] else rec)
    structured = bool(fm.get("claims")) or explicit_any or any(
        it["kind"] or it["evidence"] or it["strength"] or it["scope"] or it["supports"]
        or it["contests"] or it["extends"] for it in items)
    stem = rel.rsplit("/", 1)[-1]
    stem = stem[:-3] if stem.lower().endswith(".md") else stem
    if len(summary) > SUMMARY_MAX:
        summary = summary[:SUMMARY_MAX - 1].rstrip() + "…"
    return {"path": rel, "stem": stem, "citekey": _scalar(fm, "citekey"),
            "author": _scalar(fm, "author"), "year": _year(_scalar(fm, "year")),
            "title": _scalar(fm, "title") or stem, "source": _scalar(fm, "source"),
            "rating": _rating(_scalar(fm, "rating")), "structured": structured,
            "summary": summary, "citation": citation[:1200], "limitations": _parse_limitations(lim),
            "unattached": unattached, "n_quotes": len(quotes), "qstats": qstats, "claims": items}


# ---------------------------------------------------------------- indexing

def _walk_md(root):
    if Path(root).name.startswith(".") or Path(root).name.lower() == "archive":
        return
    stack = [root]
    while stack:
        d = stack.pop()
        try:
            it = os.scandir(d)
        except OSError:
            continue
        with it:
            for e in it:
                try:
                    if e.is_dir(follow_symlinks=False):
                        if not e.name.startswith(".") and e.name.lower() != "archive":
                            stack.append(e.path)
                    elif not e.name.startswith(".") and e.name.lower().endswith(".md") and e.is_file(follow_symlinks=False):
                        st = e.stat(follow_symlinks=False)
                        yield e.path, st.st_mtime, st.st_size
                except OSError:
                    continue


def _corpus_files(vault):
    out = []
    for kind in PROJECT_CONTAINERS:
        try:
            projects = [d for d in os.scandir(os.path.join(vault, "Projects", kind))
                        if d.is_dir(follow_symlinks=False) and not d.name.startswith(".")
                        and d.name.lower() != "archive"]
        except OSError:
            continue
        for p in projects:
            try:
                for e in os.scandir(os.path.join(p.path, "corpus")):
                    if not e.name.startswith(".") and e.name.lower().endswith(".md") and e.is_file(follow_symlinks=False):
                        st = e.stat(follow_symlinks=False)
                        out.append((e.path, st.st_mtime, st.st_size, p.name))
            except OSError:
                continue
    return out


def _read(ap, size):
    if size > MAX_FILE_BYTES:
        return ""
    with open(ap, "r", encoding="utf-8", errors="replace") as f:
        return f.read()


def _delete_paper(conn, pid):
    ids = [(r[0],) for r in conn.execute("SELECT id FROM claims WHERE paper_id=?", (pid,))]
    if ids:
        conn.executemany("DELETE FROM fts WHERE rowid=?", ids)
        conn.executemany("DELETE FROM claim_tags WHERE claim_id=?", ids)
        conn.executemany("DELETE FROM claim_concepts WHERE claim_id=?", ids)
        conn.executemany("DELETE FROM claim_links WHERE claim_id=?", ids)
        conn.execute("DELETE FROM claims WHERE paper_id=?", (pid,))
    conn.execute("DELETE FROM papers WHERE id=?", (pid,))


def _index_paper(conn, rel, text, mtime, size, old_id):
    p = parse_citation(rel, text)
    if old_id is not None:
        _delete_paper(conn, old_id)
    pid = conn.execute(
        "INSERT INTO papers(path, stem, mtime, size, citekey, author, year, title, source, rating,"
        " structured, summary, citation, limitations, unattached, n_quotes, q_explicit, q_inferred,"
        " q_unattached) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (rel, p["stem"].lower(), mtime, size, p["citekey"], p["author"], p["year"], p["title"],
         p["source"], p["rating"], int(p["structured"]), p["summary"], p["citation"],
         json.dumps(p["limitations"]), json.dumps(p["unattached"]), p["n_quotes"],
         p["qstats"]["explicit"], p["qstats"]["inferred"], p["qstats"]["unattached"])).lastrowid
    seen = set()
    for it in p["claims"]:
        if it["n"] in seen:
            continue
        seen.add(it["n"])
        cid = rel + "#" + it.get("native_id", f"K{it['n']}")
        rid = conn.execute(
            "INSERT INTO claims(cid, paper_id, n, headline, detail, pages, tags, kind, evidence,"
            " strength, scope, supports, contests, extends, quotes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (cid, pid, it["n"], it["headline"], it["detail"], it["pages"], " ".join(it["tags"]),
             it["kind"], it["evidence"], it["strength"], it["scope"], json.dumps(it["supports"]),
             json.dumps(it["contests"]), json.dumps(it["extends"]), json.dumps(it["quotes"]))).lastrowid
        conn.execute("INSERT INTO fts(rowid, headline, tags, detail, quotes, evidence) VALUES (?,?,?,?,?,?)",
                     (rid, it["headline"], " ".join(t.replace("-", " ") for t in it["tags"]),
                      it["detail"], " ".join(q["text"] for q in it["quotes"]),
                      " ".join(x for x in (it["evidence"], it["scope"]) if x)))
        conn.executemany("INSERT INTO claim_tags(claim_id, tag) VALUES (?,?)",
                         [(rid, t) for t in dict.fromkeys(it["tags"])])
        conc = {}
        for slug, st in it["supports"]:
            conc[(slug, "claim")] = st
        for q in it["quotes"]:
            for slug, st in q.get("supports") or []:
                conc.setdefault((slug, "quote"), st)
        conn.executemany("INSERT INTO claim_concepts(claim_id, slug, strength, via) VALUES (?,?,?,?)",
                         [(rid, s, st, via) for (s, via), st in conc.items()])
        conn.executemany("INSERT INTO claim_links(claim_id, rel, stem, n) VALUES (?,?,?,?)",
                         [(rid, rel_, stem.lower(), n) for rel_ in ("contests", "extends")
                          for stem, n in it[rel_]])


def _corpus_targets(text, own_stem):
    fm, body = _split_frontmatter(text)
    stems = {own_stem.lower()}
    src = fm.get("source-note")
    for v in ([src] if isinstance(src, str) else (src or [])):
        for t in _WIKI_TARGET.findall(str(v)):
            stems.add(_slug(t).lower())
    for t in _WIKI_TARGET.findall(body):
        if not t.lower().endswith((".pdf", ".png", ".jpg", ".svg")):
            stems.add(_slug(t).lower())
    return stems


def rescan(vault, conn=None, pace=True):
    """One incremental pass over citation notes and project corpus notes."""
    own = conn is None
    if own:
        _use_vault(vault)
    vault = str(Path(vault).expanduser().resolve())
    conn = conn or _connect()
    t0 = time.time()
    try:
        _ensure_schema(conn)
        # 1. corpus notes -> project membership (and the few that carry their own key points)
        known_c = {p: (m, s) for p, m, s in conn.execute("SELECT path, mtime, size FROM corpus")}
        corpus, seen_c, pending = _corpus_files(vault), set(), 0
        has_kp = dict(conn.execute("SELECT path, has_kp FROM corpus"))
        for ap, mtime, size, project in corpus:
            rel = os.path.relpath(ap, vault).replace(os.sep, "/")
            seen_c.add(rel)
            old = known_c.get(rel)
            if old and old[0] == mtime and old[1] == size:
                continue
            try:
                text = _read(ap, size)
                stem = rel.rsplit("/", 1)[-1][:-3]
                kp = int(bool(re.search(r"^## Key (?:Points|Themes)", text, re.M)))
                conn.execute("DELETE FROM members WHERE corpus_path=?", (rel,))
                conn.executemany("INSERT INTO members(corpus_path, project, stem) VALUES (?,?,?)",
                                 [(rel, project, s) for s in _corpus_targets(text, stem)])
                conn.execute("INSERT OR REPLACE INTO corpus(path, mtime, size, project, has_kp)"
                             " VALUES (?,?,?,?,?)", (rel, mtime, size, project, kp))
                has_kp[rel] = kp
            except Exception as exc:
                _error(f"corpus {rel}: {type(exc).__name__}")
                continue
            pending += 1
            if pending >= BATCH:
                conn.commit()
                pending = 0
                if pace:
                    time.sleep(BATCH_PAUSE)
        for rel in known_c.keys() - seen_c:
            conn.execute("DELETE FROM members WHERE corpus_path=?", (rel,))
            conn.execute("DELETE FROM corpus WHERE path=?", (rel,))
        conn.commit()

        # 2. papers: every citation note, plus corpus notes with key points and no citation twin
        cands = {}
        for root in CITATION_ROOTS:
            for ap, mtime, size in _walk_md(os.path.join(vault, root)):
                rel = os.path.relpath(ap, vault).replace(os.sep, "/")
                cands[rel] = (ap, mtime, size)
        cite_stems = {r.rsplit("/", 1)[-1][:-3].lower() for r in cands}
        for ap, mtime, size, _ in corpus:
            rel = os.path.relpath(ap, vault).replace(os.sep, "/")
            if has_kp.get(rel) and rel.rsplit("/", 1)[-1][:-3].lower() not in cite_stems:
                cands[rel] = (ap, mtime, size)
        known = {p: (i, m, s) for i, p, m, s in conn.execute("SELECT id, path, mtime, size FROM papers")}
        for rel, (ap, mtime, size) in cands.items():
            old = known.get(rel)
            if old and old[1] == mtime and old[2] == size:
                continue
            try:
                _index_paper(conn, rel, _read(ap, size), mtime, size, old[0] if old else None)
            except Exception as exc:        # one bad note never stops the pass
                _error(f"index {rel}: {type(exc).__name__}: {exc}")
                continue
            pending += 1
            if pending >= BATCH:
                conn.commit()
                pending = 0
                _count(conn)
                if pace:
                    time.sleep(BATCH_PAUSE)
        gone = [known[p][0] for p in known.keys() - cands.keys()]
        for pid in gone:
            _delete_paper(conn, pid)
        conn.commit()
        _count(conn)
        with _state_lock:
            _state["last_build"] = time.time()
            _state["last_scan_secs"] = round(time.time() - t0, 2)
        return {"claims": _state["claims"], "papers": _state["papers"], "removed": len(gone),
                "secs": round(time.time() - t0, 2)}
    finally:
        if own:
            conn.close()


def _count(conn):
    c = conn.execute("SELECT count(*) FROM claims").fetchone()[0]
    p = conn.execute("SELECT count(*) FROM papers").fetchone()[0]
    with _state_lock:
        _state["claims"], _state["papers"] = c, p


def _loop(vault):
    try:
        os.setpriority(os.PRIO_PROCESS, threading.get_native_id(), 10)   # this thread only
    except (AttributeError, OSError):
        pass
    conn = _connect()
    while True:
        with _state_lock:
            _state["building"] = True
        try:
            rescan(vault, conn)
        except Exception as exc:
            _error(f"rescan: {type(exc).__name__}: {exc}")
        finally:
            with _state_lock:
                _state["building"] = False
        time.sleep(RESCAN_SECS)


def start_background(vault):
    with _state_lock:
        if _state["started"]:
            return
        _state["started"] = True
    _use_vault(vault)
    try:
        c = _connect()
        _ensure_schema(c)
        _count(c)
        c.close()
    except Exception as exc:
        _error(f"open: {type(exc).__name__}")
    threading.Thread(target=_loop, args=(VAULT,), name="claims-index", daemon=True).start()


def status():
    with _state_lock:
        return {"indexed_claims": _state["claims"], "indexed_papers": _state["papers"],
                "building": _state["building"], "last_build": _state["last_build"],
                "last_scan_secs": _state["last_scan_secs"], "db_path": str(DB_PATH),
                "errors": list(_state["errors"])}


# ---------------------------------------------------------------- query parsing

_WORD = re.compile(r"\w+", re.U)
_LEX = re.compile(r'(-?)(?:"([^"]*)"?|(\S+))')
_FILTER_KEYS = ("concept", "kind", "strength", "tag", "project", "year", "author", "paper", "has")


def _phrase(words, prefix=False):
    """A safe FTS5 phrase: only \\w tokens, always double-quoted."""
    words = [w.lower() for w in words]
    if not words:
        return None
    return '"' + " ".join(words) + '"' + ("*" if prefix else "")


def _word_term(raw):
    words = _WORD.findall(raw)
    if not words:
        return None
    if len(words) > 1:
        words = [w for w in words if len(w) >= 2] or words
    return _phrase(words, prefix=len(words[-1]) >= 2)


def _year_filter(val, f):
    val = val.strip()
    m = re.match(r"^(>=?|<=?)\s*(\d{4})$", val)
    if m:
        y = int(m.group(2))
        if m.group(1).startswith(">"):
            f["year_from"] = y + (0 if "=" in m.group(1) else 1)
        else:
            f["year_to"] = y - (0 if "=" in m.group(1) else 1)
        return
    m = re.match(r"^(\d{4})\s*[-–.]{1,2}\s*(\d{4})$", val)
    if m:
        f["year_from"], f["year_to"] = int(m.group(1)), int(m.group(2))
        return
    m = re.match(r"^(\d{4})$", val)
    if m:
        f["year_from"] = f["year_to"] = int(m.group(1))


def parse_query(q, filters=None):
    """Split a query into FTS clauses and structured filters. Never trusts raw text."""
    out = {"pos": [], "neg": [], "plain": [], "words": [], "hl": [],
           "concepts": [], "kinds": [], "strengths": [], "tags": [], "not_tags": [],
           "projects": [], "authors": [], "papers": [], "year_from": None, "year_to": None,
           "has_evidence": None}
    f = {}
    q = (q or "")[:500]
    pending_or = False
    for m in _LEX.finditer(q):
        neg, quoted, bare = m.group(1) == "-", m.group(2), m.group(3)
        term = None
        if quoted is not None:
            term = _phrase(_WORD.findall(quoted))
            if term and not neg:
                out["plain"].append(quoted.strip())
                out["hl"].append((_WORD.findall(quoted), False))
        elif bare == "OR" and not neg:
            pending_or = bool(out["pos"])
            continue
        elif bare in ("AND", "NOT") and not neg:
            continue
        elif ":" in bare and bare.split(":", 1)[0].lower() in _FILTER_KEYS:
            key, val = bare.split(":", 1)
            key, val = key.lower(), val.strip().strip('"').strip()
            if not val:
                continue
            if key == "tag":
                (out["not_tags"] if neg else out["tags"]).append(val.lstrip("#").lower())
            elif neg:
                continue
            elif key == "concept":
                out["concepts"].append(_norm_concept(val.strip("[]")))
            elif key == "kind" and val.lower() in KINDS:
                out["kinds"].append(val.lower())
            elif key == "strength" and val.lower() in STRENGTHS:
                out["strengths"].append(val.lower())
            elif key == "project":
                out["projects"].append(val.lower())
            elif key == "author":
                out["authors"].append(val.lower())
            elif key == "paper":
                out["papers"].append(val.lower())
            elif key == "year":
                _year_filter(val, f)
            elif key == "has" and val.lower() == "evidence":
                out["has_evidence"] = True
            continue
        elif bare.startswith("#") and len(bare) > 1:
            (out["not_tags"] if neg else out["tags"]).append(bare[1:].lower())
            continue
        else:
            term = _word_term(bare)
            if term and not neg:
                out["plain"].append(bare)
                out["words"].extend(w.lower() for w in _WORD.findall(bare))
                out["hl"].append((_WORD.findall(bare), True))
        if not term:
            continue
        if neg:
            out["neg"].append(term)
        elif pending_or and out["pos"]:
            prev = out["pos"].pop()
            out["pos"].append(f"({prev} OR {term})")
        else:
            out["pos"].append(term)
        pending_or = False
    filters = filters or {}

    def _s(k):
        v = filters.get(k)
        return str(v).strip()[:200] if v not in (None, "") else ""
    if _s("concept"):
        out["concepts"].append(_norm_concept(_s("concept").strip("[]")))
    if _s("kind").lower() in KINDS:
        out["kinds"].append(_s("kind").lower())
    if _s("strength").lower() in STRENGTHS:
        out["strengths"].append(_s("strength").lower())
    if _s("tag"):
        out["tags"].append(_s("tag").lstrip("#").lower())
    if _s("project"):
        out["projects"].append(_s("project").lower())
    if _s("paper"):
        out["papers"].append(_s("paper").lower())
    if _s("author"):
        out["authors"].append(_s("author").lower())
    for k in ("year_from", "year_to"):
        v = _s(k)
        if re.fullmatch(r"\d{4}", v):
            f[k] = int(v)
    he = filters.get("has_evidence")
    if he is True or str(he).lower() in ("1", "true", "yes"):
        out["has_evidence"] = True
    out["year_from"], out["year_to"] = f.get("year_from"), f.get("year_to")
    return out


def _match_expr(pos, neg):
    if not pos:
        return None
    expr = " AND ".join(pos)
    if neg:
        expr = f"({expr}) NOT ({' OR '.join(neg)})"
    return expr


def _like(s):
    return "%" + s.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


# ---------------------------------------------------------------- search

_CLAIM_COLS = ("c.id, c.cid, c.n, c.headline, c.detail, c.pages, c.tags, c.kind, c.evidence, "
               "c.strength, c.scope, c.supports, c.contests, c.extends, c.quotes, "
               "p.id, p.path, p.citekey, p.author, p.year, p.title, p.source, p.rating, p.structured, p.stem")


def _projects_of(conn, stems):
    out = {}
    stems = list(set(stems))
    for i in range(0, len(stems), 500):
        chunk = stems[i:i + 500]
        for stem, proj in conn.execute(
                f"SELECT DISTINCT stem, project FROM members WHERE stem IN ({','.join('?' * len(chunk))})",
                chunk):
            out.setdefault(stem, []).append(proj)
    return {k: sorted(v) for k, v in out.items()}


def _project_label(folder):
    return re.sub(r"^(done|submitted|published|paused)\s*-\s*", "", settings.strip_prefix(folder), flags=re.I)


def _claim_dict(r, projects=None, full=True):
    (cid_row, cid, n, headline, detail, pages, tags, kind, evidence, strength, scope, supports,
     contests, extends, quotes, pid, path, citekey, author, year, title, source, rating,
     structured, stem) = r
    quotes = json.loads(quotes or "[]")
    d = {"id": cid, "note": path, "n": n, "headline": headline or "", "pages": pages or "",
         "tags": tags.split() if tags else [], "kind": kind or "", "strength": strength or "",
         "citekey": citekey or "", "author": author or "", "year": year, "title": title or "",
         "source": source or "", "rating": rating, "structured": bool(structured),
         "evidence": evidence or "", "scope": scope or "",
         "supports": json.loads(supports or "[]"),
         "n_quotes": len(quotes),
         "projects": [{"folder": p, "name": _project_label(p)} for p in (projects or [])]}
    if full:
        d["detail"] = detail or ""
        d["contests"] = [f"{s}#K{k}" for s, k in json.loads(contests or "[]")]
        d["extends"] = [f"{s}#K{k}" for s, k in json.loads(extends or "[]")]
        d["quotes"] = quotes
    return d


def _allowed(conn, p):
    """The claim ids the structured filters allow, or None when there are none."""
    sets = []
    where, args = [], []
    if p["kinds"]:
        where.append(f"c.kind IN ({','.join('?' * len(p['kinds']))})")
        args += p["kinds"]
    if p["strengths"]:
        where.append(f"c.strength IN ({','.join('?' * len(p['strengths']))})")
        args += p["strengths"]
    if p["year_from"] is not None:
        where.append("p.year >= ?")
        args.append(p["year_from"])
    if p["year_to"] is not None:
        where.append("p.year <= ?")
        args.append(p["year_to"])
    if p["has_evidence"]:
        where.append("c.evidence != ''")
    for a in p["authors"]:
        where.append("lower(p.author) LIKE ? ESCAPE '\\'")
        args.append(_like(a))
    for x in p["papers"]:
        where.append("(lower(p.path) LIKE ? ESCAPE '\\' OR lower(p.title) LIKE ? ESCAPE '\\'"
                     " OR lower(p.citekey) = ?)")
        args += [_like(x), _like(x), x]
    if where:
        sets.append({r[0] for r in conn.execute(
            f"SELECT c.id FROM claims c JOIN papers p ON p.id = c.paper_id WHERE {' AND '.join(where)}",
            args)})
    for t in p["tags"]:
        sets.append({r[0] for r in conn.execute(
            "SELECT claim_id FROM claim_tags WHERE tag = ? OR tag LIKE ? ESCAPE '\\'",
            (t, t.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "-%"))})
    for c in p["concepts"]:
        sets.append({r[0] for r in conn.execute(
            "SELECT claim_id FROM claim_concepts WHERE slug = ?", (c,))})
    for pr in p["projects"]:
        stems = [r[0] for r in conn.execute(
            "SELECT DISTINCT stem FROM members WHERE lower(project) LIKE ? ESCAPE '\\'", (_like(pr),))]
        ids = set()
        for i in range(0, len(stems), 500):
            chunk = stems[i:i + 500]
            ids |= {r[0] for r in conn.execute(
                f"SELECT c.id FROM claims c JOIN papers p ON p.id = c.paper_id "
                f"WHERE p.stem IN ({','.join('?' * len(chunk))})", chunk)}
        sets.append(ids)
    allowed = None
    for s in sets:
        allowed = s if allowed is None else allowed & s
    if p["not_tags"]:
        bad = set()
        for t in p["not_tags"]:
            bad |= {r[0] for r in conn.execute("SELECT claim_id FROM claim_tags WHERE tag = ?", (t,))}
        if allowed is None:
            allowed = {r[0] for r in conn.execute("SELECT id FROM claims")}
        allowed -= bad
    return allowed


def _bonus(strength, structured, rating):
    return (STRENGTH_BONUS.get(strength or "", 0.0) + (1.0 if structured else 0.0)
            + 0.3 * (rating or 0.0))


def _make_snippet(text, hl, width=200):
    """About 20 words around the densest cluster of matches, matches in «…»."""
    alts = [r"\b" + r"\W+".join(re.escape(w) for w in ws) + (r"\w*" if pre else r"\b")
            for ws, pre in hl if ws]
    rx = re.compile("|".join(alts), re.I) if alts else None
    text = re.sub(r"\s+", " ", text or "").strip()
    ms = list(itertools.islice(rx.finditer(text), 300)) if rx else []
    if not ms:
        return text[:200] + ("…" if len(text) > 200 else "")
    best, best_n = ms[0], 0
    for i, m in enumerate(ms):
        n = len({x.group(0).lower() for x in ms[i:i + 12] if x.start() < m.start() + width})
        if n > best_n:
            best, best_n = m, n
    start = max(0, best.start() - 60)
    if start:
        sp = text.find(" ", start)
        start = sp + 1 if 0 <= sp < best.start() else start
    end = min(len(text), start + width + 60)
    if end < len(text):
        sp = text.rfind(" ", best.end(), end)
        end = sp if sp > 0 else end
    frag = rx.sub(lambda m: f"«{m.group(0)}»", text[start:end])
    return ("…" if start else "") + frag + ("…" if end < len(text) else "")


def _fetch(conn, ids):
    ids = list(ids)
    rows = {}
    for i in range(0, len(ids), 500):
        chunk = ids[i:i + 500]
        for r in conn.execute(f"SELECT {_CLAIM_COLS} FROM claims c JOIN papers p ON p.id = c.paper_id "
                              f"WHERE c.id IN ({','.join('?' * len(chunk))})", chunk):
            rows[r[0]] = r
    return rows


def search(q="", limit=40, filters=None):
    t0 = time.perf_counter()
    st = status()
    base = {"hits": [], "total": 0, "building": st["building"],
            "indexed_claims": st["indexed_claims"], "indexed_papers": st["indexed_papers"]}
    try:
        limit = max(1, min(int(limit or 40), 200))
        p = parse_query(q, filters if isinstance(filters, dict) else None)
        conn = _reader()
        allowed = _allowed(conn, p)
        expr = _match_expr(p["pos"], p["neg"])
        light = {}      # id -> (strength, structured, rating, year)
        if expr:
            w = ",".join(str(x) for x in WEIGHTS)
            bm, total = {}, 0
            for rid, b in conn.execute(f"SELECT rowid, bm25(fts, {w}) FROM fts WHERE fts MATCH ? "
                                       f"ORDER BY bm25(fts, {w})", [expr]):
                if allowed is not None and rid not in allowed:
                    continue
                total += 1
                if len(bm) < 400:
                    bm[rid] = -b
        else:
            if allowed is None and not p["neg"]:
                base["took_ms"] = round((time.perf_counter() - t0) * 1000, 1)
                return base
            ids = allowed
            if p["neg"]:
                bad = {r[0] for r in conn.execute("SELECT rowid FROM fts WHERE fts MATCH ?",
                                                  [" OR ".join(p["neg"])])}
                if ids is None:
                    ids = {r[0] for r in conn.execute("SELECT id FROM claims")}
                ids = ids - bad
            bm, total = {i: 0.0 for i in ids}, len(ids)
        if bm:
            keys = list(bm)
            for i in range(0, len(keys), 500):
                chunk = keys[i:i + 500]
                for rid, strength, structured, rating, year, pid in conn.execute(
                        f"SELECT c.id, c.strength, p.structured, p.rating, p.year, p.id FROM claims c "
                        f"JOIN papers p ON p.id = c.paper_id WHERE c.id IN ({','.join('?' * len(chunk))})",
                        chunk):
                    light[rid] = (strength, structured, rating, year, pid)
        scored = []
        for rid, s in bm.items():
            if rid not in light:
                continue
            strength, structured, rating, year, pid = light[rid]
            scored.append((s + _bonus(strength, structured, rating), year or 0, rid, pid))
        scored.sort(key=lambda x: (-x[0], -x[1]))
        # one paper's many key points should not bury every other paper: each further
        # hit from the same paper pays a growing penalty (text queries only)
        if expr:
            seen = {}
            div = []
            for sc, yr, rid, pid in scored:
                k = seen.get(pid, 0)
                seen[pid] = k + 1
                div.append((sc - PAPER_REPEAT_PENALTY * k, yr, rid, pid))
            scored = sorted(div, key=lambda x: (-x[0], -x[1]))
        top = scored[:limit]
        rows = _fetch(conn, [rid for _, _, rid, _ in top])
        projects = _projects_of(conn, [rows[r][24] for _, _, r, _ in top if r in rows])
        hits = []
        for s, _, rid, _ in top:
            r = rows.get(rid)
            if not r:
                continue
            d = _claim_dict(r, projects.get(r[24]), full=False)
            quotes = json.loads(r[14] or "[]")
            text = " — ".join(x for x in (r[3], r[4], r[8]) if x)
            text += " " + " ".join(f"“{qq['text']}”" for qq in quotes[:4])
            d["snippet"] = _make_snippet(text, p["hl"])
            d["score"] = round(s, 3)
            hits.append(d)
        base["hits"], base["total"] = hits, total
    except Exception as exc:
        base["error"] = type(exc).__name__
    base["took_ms"] = round((time.perf_counter() - t0) * 1000, 1)
    return base


def _row_by_cid(conn, cid):
    if not isinstance(cid, str) or not cid or len(cid) > 1000:
        return None
    return conn.execute(f"SELECT {_CLAIM_COLS} FROM claims c JOIN papers p ON p.id = c.paper_id "
                        f"WHERE c.cid = ?", (cid,)).fetchone()


def _short(r, projects, extra=None):
    d = _claim_dict(r, projects, full=False)
    if extra:
        d.update(extra)
    return d


def _resolve_refs(conn, pairs):
    """[(stem, n)] -> {(stem, n): row} for the targets that exist."""
    out = {}
    for stem, n in pairs:
        r = conn.execute(f"SELECT {_CLAIM_COLS} FROM claims c JOIN papers p ON p.id = c.paper_id "
                         f"WHERE p.stem = ? AND c.n = ? ORDER BY p.path LIKE 'Preparation/%' DESC LIMIT 1",
                         (stem.lower(), n)).fetchone()
        if r:
            out[(stem.lower(), n)] = r
    return out


def related(cid):
    """Claims in other papers sharing concepts and tags, plus explicit contests/extends both ways."""
    t0 = time.perf_counter()
    base = {"id": cid, "related": [], "contests": [], "contested_by": [], "extends": [], "extended_by": []}
    try:
        conn = _reader()
        r = _row_by_cid(conn, cid)
        if not r:
            base["error"] = "NotFound"
            return base
        rid, pid = r[0], r[15]
        n_claims = max(1, conn.execute("SELECT count(*) FROM claims").fetchone()[0])
        own = set((r[6] or "").split())
        qtags = [t for qq in json.loads(r[14] or "[]") for t in qq.get("tags") or []]
        tags = [t for t in dict.fromkeys(list(own) + qtags) if not t.startswith("limitation")]
        concepts = [x[0] for x in conn.execute("SELECT DISTINCT slug FROM claim_concepts WHERE claim_id=?",
                                               (rid,))]
        score, shared = {}, {}
        for t in tags:
            df = conn.execute("SELECT count(*) FROM claim_tags WHERE tag=?", (t,)).fetchone()[0]
            if df <= 1 or df > n_claims * 0.05:
                continue
            w = math.log(n_claims / df) * (1.0 if t in own else 0.5)    # a quote's tag counts half
            for (other,) in conn.execute("SELECT claim_id FROM claim_tags WHERE tag=? AND claim_id != ?",
                                         (t, rid)):
                score[other] = score.get(other, 0.0) + w
                shared.setdefault(other, []).append("#" + t)
        for c in concepts:
            for (other,) in conn.execute("SELECT DISTINCT claim_id FROM claim_concepts WHERE slug=? "
                                         "AND claim_id != ?", (c, rid)):
                score[other] = score.get(other, 0.0) + 6.0
                shared.setdefault(other, []).append("concept:" + c)
        # the claim's own words: an OR of its most telling headline and detail words
        words = [w for w in dict.fromkeys(x.lower() for x in _WORD.findall(f"{r[3]} {(r[4] or '')[:300]}"))
                 if len(w) >= 4 and w not in _STOP and not w.isdigit()][:14]
        if words:
            w_ = ",".join(str(x) for x in WEIGHTS)
            hits = conn.execute(
                f"SELECT rowid, bm25(fts, {w_}) FROM fts WHERE fts MATCH ? ORDER BY bm25(fts, {w_}) "
                f"LIMIT 121", [" OR ".join(_phrase([w]) for w in words)]).fetchall()
            top = max((-b for o, b in hits if o != rid), default=0.0) or 1.0
            for other, b in hits:
                if other != rid:                    # the best text match is worth one concept
                    score[other] = score.get(other, 0.0) + 6.0 * (-b) / top
                    shared.setdefault(other, []).append("text")
        cand = sorted(score, key=lambda k: -score[k])[:200]
        rows = _fetch(conn, cand)
        out, per_paper = [], {}
        for k in cand:
            rr = rows.get(k)
            if not rr or rr[15] == pid or per_paper.get(rr[15], 0) >= 2:
                continue
            per_paper[rr[15]] = per_paper.get(rr[15], 0) + 1
            out.append((k, rr))
            if len(out) >= RELATED_MAX:
                break
        # explicit links, forwards and backwards
        fwd = [(rel_, s, n) for rel_, s, n in conn.execute(
            "SELECT rel, stem, n FROM claim_links WHERE claim_id=?", (rid,))]
        targets = _resolve_refs(conn, [(s, n) for _, s, n in fwd])
        back = conn.execute("SELECT claim_id, rel FROM claim_links WHERE stem=? AND n=?",
                            (r[24], r[2])).fetchall()
        brows = _fetch(conn, [b[0] for b in back])
        stems = [rr[24] for _, rr in out] + [t[24] for t in targets.values()] + [b[24] for b in brows.values()]
        projects = _projects_of(conn, stems)
        base["related"] = [_short(rr, projects.get(rr[24]), {"score": round(score[k], 2),
                                                             "shared": shared[k][:8]})
                           for k, rr in out]
        for rel_, s, n in fwd:
            t = targets.get((s, n))
            item = _short(t, projects.get(t[24])) if t else {"id": None, "unresolved": f"{s}#K{n}"}
            base[rel_].append(item)
        for src, rel_ in back:
            b = brows.get(src)
            if b:
                base["contested_by" if rel_ == "contests" else "extended_by"].append(
                    _short(b, projects.get(b[24])))
    except Exception as exc:
        base["error"] = type(exc).__name__
    base["took_ms"] = round((time.perf_counter() - t0) * 1000, 1)
    return base


def claim(cid):
    """One claim in full, its paper's context and headlines, and related claims."""
    t0 = time.perf_counter()
    try:
        conn = _reader()
        r = _row_by_cid(conn, cid)
        if not r:
            return {"error": "NotFound", "id": cid}
        projects = _projects_of(conn, [r[24]])
        d = _claim_dict(r, projects.get(r[24]))
        p = conn.execute("SELECT summary, citation, limitations, unattached, n_quotes FROM papers "
                         "WHERE id=?", (r[15],)).fetchone()
        siblings = [{"id": c, "n": n, "headline": h, "kind": k or "", "strength": s or "",
                     "pages": pg or ""}
                    for c, n, h, k, s, pg in conn.execute(
                        "SELECT cid, n, headline, kind, strength, pages FROM claims WHERE paper_id=? "
                        "ORDER BY n", (r[15],))]
        paper = {"path": r[16], "citekey": r[17] or "", "author": r[18] or "", "year": r[19],
                 "title": r[20] or "", "source": r[21] or "", "rating": r[22],
                 "structured": bool(r[23]), "summary": p[0] or "", "citation": p[1] or "",
                 "limitations": json.loads(p[2] or "[]"), "unattached_quotes": json.loads(p[3] or "[]"),
                 "n_quotes": p[4] or 0, "projects": d["projects"]}
        rel = related(cid)
        rel.pop("id", None)
        rel.pop("took_ms", None)
        return {"claim": d, "paper": paper, "claims": siblings, "related": rel,
                "took_ms": round((time.perf_counter() - t0) * 1000, 1)}
    except Exception as exc:
        return {"error": type(exc).__name__, "id": cid}


def stats():
    t0 = time.perf_counter()
    out = dict(status())
    out.pop("errors", None)
    out["n_errors"] = len(_state["errors"])
    try:
        conn = _reader()
        one = lambda sql: conn.execute(sql).fetchone()[0]
        out.update({
            "claims": one("SELECT count(*) FROM claims"),
            "papers": one("SELECT count(*) FROM papers"),
            "papers_with_claims": one("SELECT count(DISTINCT paper_id) FROM claims"),
            "structured_notes": one("SELECT count(*) FROM papers WHERE structured=1"),
            "with_evidence": one("SELECT count(*) FROM claims WHERE evidence != ''"),
            "by_kind": dict(conn.execute("SELECT kind, count(*) FROM claims WHERE kind != '' GROUP BY kind")),
            "by_strength": dict(conn.execute(
                "SELECT strength, count(*) FROM claims WHERE strength != '' GROUP BY strength")),
            "quotes": dict(zip(("total", "explicit", "inferred", "unattached"), conn.execute(
                "SELECT coalesce(sum(n_quotes), 0), coalesce(sum(q_explicit), 0), "
                "coalesce(sum(q_inferred), 0), coalesce(sum(q_unattached), 0) FROM papers").fetchone())),
            "projects": one("SELECT count(DISTINCT project) FROM members"),
        })
    except Exception as exc:
        out["error"] = type(exc).__name__
    out["took_ms"] = round((time.perf_counter() - t0) * 1000, 1)
    return out
