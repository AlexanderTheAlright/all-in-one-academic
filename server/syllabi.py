from __future__ import annotations
import settings

import re
import unicodedata
from pathlib import Path

import reading  # noqa: F401  (vault guard + mutators)

VAULT = reading.VAULT
SYLLABI_DIR = VAULT / "Preparation" / "Reading" / "Syllabi"
LISTS_DIR = VAULT / "Preparation" / "Reading" / "Lists"
CORPUS_DIR = VAULT / "Preparation" / "Reading" / "Corpus"
CITATIONS_DIR = VAULT / "Preparation" / "Reading" / "Citations"


# --------------------------------------------------------------------- parsing
def _split_frontmatter(text):
    if not (text or "").startswith("---"):
        return {}, text or ""
    m = re.match(r"(?s)^---\s*\n(.*?)\n---\s*\n?(.*)$", text)
    if not m:
        return {}, text
    meta = {}
    for ln in m.group(1).split("\n"):
        if ":" in ln and not ln.startswith((" ", "\t", "-", "#")):
            k, _, v = ln.partition(":")
            meta[k.strip().lower()] = v.strip().strip("\"'")
    return meta, m.group(2)


_ITEM_RE = re.compile(r"^(?:[-*]|\d+[.)])\s+(.*\S)\s*$")
_HEAD_RE = re.compile(r"^(#{2,4})\s+(.*\S)\s*$")


def parse_list(path):
    text = Path(path).read_text(encoding="utf-8")
    meta, body = _split_frontmatter(text)
    sections, cur_h2, cur = [], None, None

    def _open(name):
        nonlocal cur
        cur = {"name": name, "readings": []}
        sections.append(cur)

    for raw in body.split("\n"):
        m = _HEAD_RE.match(raw)
        if m:
            level, name = len(m.group(1)), m.group(2).strip()
            if level == 2:
                cur_h2 = name
                _open(name)
            else:
                _open(f"{cur_h2} — {name}" if cur_h2 else name)
            continue
        im = _ITEM_RE.match(raw.strip()) if not raw.startswith((" ", "\t")) else None
        if im and cur is not None:
            cur["readings"].append(im.group(1).strip())
        elif (raw.startswith((" ", "\t")) and raw.strip().startswith(("-", "*"))
              and cur is not None and cur["readings"]):
            # nested sub-bullet (e.g. chapter selections) — fold into the entry
            cur["readings"][-1] += " — " + raw.strip().lstrip("-* ").strip()
    return {"meta": meta,
            "sections": [s for s in sections if s["readings"]]}


# ------------------------------------------------------- citation -> board title
_YEAR_RE = re.compile(r"\b(1[89]\d{2}|20\d{2})[a-z]?\b")
_QUOTED_TITLE_RE = re.compile(r"[\"“]([^\"”]{4,220})[\"”]")
_ITALIC_TITLE_RE = re.compile(r"\*([^*]{4,220})\*")


def _clean(s):
    s = re.sub(r"\*+", "", s or "")
    return re.sub(r"\s+", " ", s).strip()


def board_title(citation):
    """An ASA-style citation -> the board's 'Author (Year) - Title' convention.
    Conservative: falls back to the (cleaned, truncated) citation itself when
    the pieces can't be extracted confidently."""
    c = _clean(citation)
    ym = _YEAR_RE.search(c)
    year = ym.group(0) if ym else None

    # lead author surname: text before the first comma or period
    lead = re.split(r"[,.]", c, 1)[0].strip()
    # "van den Berg" etc are fine; reject leads that are clearly not names
    if not lead or len(lead) > 40 or lead[0].islower() or lead[0].isdigit():
        lead = None
    etal = ""
    if lead and ym:
        pre = c[: ym.start()]
        heads = len(re.findall(r"\b(?:and|&)\b", pre))
        commas = pre.count(",")
        if heads >= 2 or commas >= 4:
            etal = " et al."
        elif heads == 1:
            m2 = re.search(r"(?:and|&)\s+([A-Z][^,.]{1,30}?)[,.]", pre)
            if m2:
                last = m2.group(1).strip().split()
                if last:
                    etal = " and " + last[-1]

    title = None
    qm = _QUOTED_TITLE_RE.search(citation)
    if qm:
        title = _clean(qm.group(1)).rstrip(".")
    elif year and ym:
        after = c[ym.end():].lstrip(" .)]")
        title = re.split(r"(?<=[a-z0-9?!])\.\s", after, 1)[0].strip().rstrip(".")
    if not title:
        im = _ITALIC_TITLE_RE.search(citation)
        if im:
            title = _clean(im.group(1)).rstrip(".")
    if title and len(title) > 140:
        title = title[:137].rstrip() + "…"

    if lead and year and title:
        return f"{lead}{etal} ({year}) - {title}"
    return (c[:160] + "…") if len(c) > 160 else c


# --------------------------------------------------------------- corpus matching
def _fold(s):
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    return re.sub(r"[^a-z0-9 ]+", " ", s.lower()).split()


_corpus_cache = None


def _corpus_index():
    """[(folded-token-set, stem, relpath)] for every Corpus PDF (cached)."""
    global _corpus_cache
    if _corpus_cache is None:
        idx = []
        if CORPUS_DIR.is_dir():
            for f in CORPUS_DIR.iterdir():
                if f.is_file() and f.suffix.lower() == ".pdf":
                    idx.append((set(_fold(f.stem)), f.stem,
                                "Preparation/Reading/Corpus/" + f.name))
        _corpus_cache = idx
    return _corpus_cache


_STOPWORDS = {"the", "and", "for", "with", "from", "into", "over", "under",
              "toward", "towards", "among", "between", "their", "does", "how",
              "what", "when", "why", "study", "studies", "essay", "essays"}


def match_corpus(citation):
    c = _clean(citation)
    ym = _YEAR_RE.search(c)
    if not ym:
        return None
    year = ym.group(0)[:4]
    lead = re.split(r"[,.(]", c, 1)[0].strip()
    lead_toks = _fold(lead)
    if not lead_toks:
        return None
    surname = lead_toks[-1]
    cit_toks = set(_fold(c))

    best, best_key = None, (0.0, 0)
    for toks, stem, rel in _corpus_index():
        if surname not in toks or year not in stem:
            continue
        # the stem's title part = tokens minus the author/year boilerplate
        head, _, tail = stem.partition(" - ")
        stem_title = [t for t in _fold(tail or stem)
                      if len(t) > 3 and t not in _STOPWORDS
                      and t != surname and t != year]
        if not stem_title:
            continue
        hit = sum(1 for t in stem_title if t in cit_toks)
        score = hit / len(stem_title)
        if (score, hit) > best_key:
            best, best_key = (stem, rel), (score, hit)
    if best and best_key[0] >= 0.75:
        stem, rel = best
        cit = CITATIONS_DIR / (stem + ".md")
        cit_rel = ("Preparation/Reading/Citations/" + cit.name) if cit.is_file() else None
        return {"pdf": rel, "citation": cit_rel, "stem": stem,
                "score": round(best_key[0], 2)}
    return None


_CITEY = re.compile(r"\b1[5-9]\d{2}\b|\b20\d{2}\b|\*[^*]{4,}\*|[\"“][^\"”]{4,}[\"”]")


_NAME_OK = re.compile(r"[^./\\\x00*?\[\]][^/\\\x00*?\[\]]*")


def _safe_name(name):
    """A caller-supplied slug as one plain file or folder name, or None."""
    name = name if isinstance(name, str) else ""
    if len(name) > 200 or ".." in name or not _NAME_OK.fullmatch(name):
        return None
    return name


def _inside(path, root):
    return path.resolve().is_relative_to(root.resolve())


def distill(syllabus_slug, force=False):
    slug = _safe_name(syllabus_slug)
    if slug is None:
        return {"error": "invalid syllabus name"}
    syllabus_slug = slug
    src = SYLLABI_DIR / syllabus_slug / "syllabus.md"
    out = LISTS_DIR / (syllabus_slug + "-readings.md")
    if not (_inside(src, SYLLABI_DIR) and _inside(out, LISTS_DIR)):
        return {"error": "invalid syllabus name"}
    if not src.is_file():
        return {"error": "unknown syllabus %r" % syllabus_slug}
    parsed = parse_list(src)
    meta = parsed["meta"]
    if out.exists() and not force:
        return {"error": "exists", "path": str(out)}
    _veto = re.compile(r"assignment|grading|grade|evaluation|polic|agreement|"
                       r"requirement|late|integrity|accessib|attendance|"
                       r"submission|deadline", re.I)
    kept = []
    _schedparent = re.compile(
        r"^[^—]*(schedule|topics?|readings|sessions?|core topics)[^—]*—\s*", re.I)
    for s in parsed["sections"]:
        if _veto.search(s["name"]):
            continue
        hits = sum(1 for r in s["readings"] if _CITEY.search(r))
        if hits and hits >= len(s["readings"]) / 2:
            # "Tentative Schedule and Topics — Week 10 — X" -> "Week 10 — X"
            s["name"] = _schedparent.sub("", s["name"]).strip()
            kept.append(s)
    parsed["sections"] = kept
    total = sum(len(s["readings"]) for s in parsed["sections"])
    lines = ["---",
             "kind: reading-list",
             "title: %s — Course Readings" % (meta.get("title") or syllabus_slug),
             "subtitle: %s" % " · ".join(x for x in (
                 meta.get("course"), meta.get("instructor"), meta.get("term")) if x),
             "program: %s" % (meta.get("institution") or settings.INSTITUTION),
             "term: %s" % (meta.get("term") or ""),
             "units: %d readings distilled from the course syllabus" % total,
             "---", ""]
    for s in parsed["sections"]:
        lines.append("## " + s["name"])
        lines.append("")
        for r in s["readings"]:
            lines.append("- " + r)
        lines.append("")
    LISTS_DIR.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(lines), encoding="utf-8")
    return {"ok": True, "path": str(out), "sections": len(parsed["sections"]),
            "readings": total}


# -------------------------------------------------------------------------- push
def push(list_slug, section=None, queue_downloads=True, board_name=None, note=None):
    slug = _safe_name(list_slug)
    if slug is None:
        return {"error": "invalid list name"}
    list_slug = slug
    src = LISTS_DIR / (list_slug if list_slug.endswith(".md") else list_slug + ".md")
    if not _inside(src, LISTS_DIR):
        return {"error": "invalid list name"}
    if not src.is_file():
        return {"error": "unknown list %r" % list_slug}
    parsed = parse_list(src)
    meta = parsed["meta"]
    sections = parsed["sections"]
    if section is not None:
        want = str(section).strip().lower()
        picked = [s for i, s in enumerate(sections)
                  if str(i) == want or s["name"].strip().lower() == want]
        if not picked:
            return {"error": "section %r not found" % section,
                    "sections": [s["name"] for s in sections]}
        sections = picked

    name = board_name or (meta.get("title") or src.stem)
    res = reading.list_create({
        "name": name,
        "note": note or ("Pushed from Lists/%s — %s" % (
            src.name, meta.get("subtitle") or meta.get("units") or "formatted list")),
    })
    if not res:
        return {"error": "list_create failed"}
    dated = res["name"]

    report = {"list": dated, "sections": [], "have": 0, "need": 0, "total": 0,
              "skipped": []}
    gi = -1  # index of the group actually ADDED — skipped sections must not
             # advance it, or every later item_add lands in the wrong group
    for s in sections:
        hits = sum(1 for r in s["readings"] if _CITEY.search(r))
        if not (hits and hits >= len(s["readings"]) / 2):
            report["skipped"].append({"name": s["name"],
                                      "readings": len(s["readings"]),
                                      "why": "no citation-like bullets — reads as "
                                             "syllabus scaffolding, not readings"})
            continue
        gi += 1
        reading.group_add({"list": dated, "name": s["name"]})
        have = need = 0
        for citation in s["readings"]:
            title = board_title(citation)
            hit = match_corpus(citation)
            reading.item_add({
                "list": dated, "group": gi, "title": title,
                "citationPath": (hit or {}).get("citation"),
                "pdfPath": (hit or {}).get("pdf"),
                "why": "From %s — %s" % (meta.get("title") or src.stem, s["name"]),
                "needsDownload": bool(queue_downloads and not hit),
            })
            if hit:
                have += 1
            else:
                need += 1
        report["sections"].append({"name": s["name"], "have": have, "need": need})
        report["have"] += have
        report["need"] += need
        report["total"] += have + need
    return report


# --------------------------------------------------------------------------- CLI
def _cli():
    import argparse
    import json
    p = argparse.ArgumentParser(prog="syllabi.py",
                                description="syllabus/reading-list board bridge")
    sub = p.add_subparsers(dest="cmd")
    sub.add_parser("lists", help="formatted lists on disk (JSON)")
    ss = sub.add_parser("sections", help="sections of one list (JSON)")
    ss.add_argument("--list", required=True)
    sd = sub.add_parser("distill", help="syllabus -> Lists/<slug>-readings.md")
    sd.add_argument("--syllabus", required=True)
    sd.add_argument("--force", action="store_true")
    sp = sub.add_parser("push", help="push a list (or one section) to the board")
    sp.add_argument("--list", required=True)
    sp.add_argument("--section", default=None)
    sp.add_argument("--name", default=None, help="board list name override")
    sp.add_argument("--no-downloads", action="store_true",
                    help="do NOT queue misses for download")
    sm = sub.add_parser("match", help="corpus-match one citation (debug)")
    sm.add_argument("--citation", required=True)
    a = p.parse_args()

    def emit(x):
        print(json.dumps(x, ensure_ascii=False, indent=1))

    if a.cmd == "lists":
        rows = []
        if LISTS_DIR.is_dir():
            for f in sorted(LISTS_DIR.iterdir()):
                if f.suffix.lower() == ".md" and not f.name.startswith((".", "_")):
                    d = parse_list(f)
                    rows.append({"slug": f.stem,
                                 "title": d["meta"].get("title") or f.stem,
                                 "sections": len(d["sections"]),
                                 "readings": sum(len(s["readings"]) for s in d["sections"])})
        emit(rows)
    elif a.cmd == "sections":
        if _safe_name(a.list) is None:
            emit({"error": "invalid list name"})
            return
        d = parse_list(LISTS_DIR / (a.list + ".md"))
        emit([{"i": i, "name": s["name"], "readings": len(s["readings"])}
              for i, s in enumerate(d["sections"])])
    elif a.cmd == "distill":
        emit(distill(a.syllabus, force=a.force))
    elif a.cmd == "push":
        emit(push(a.list, section=a.section, queue_downloads=not a.no_downloads,
                  board_name=a.name))
    elif a.cmd == "match":
        emit(match_corpus(a.citation) or {"match": None})
    else:
        p.print_help()


if __name__ == "__main__":
    _cli()
