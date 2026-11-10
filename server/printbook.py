import hashlib
import re
import threading
import urllib.parse

import litcite
import reading

CITATIONS = reading.CITATIONS_DIR
CIT_REL = "Preparation/Reading/Citations"
_WRITE = threading.Lock()

_STEM_BAD = re.compile(r'[\\/:*?"<>|#\[\]^]')
_PAGE_OK = re.compile(r"^[0-9ivxlcdm]+(?:\s*[-–]\s*[0-9ivxlcdm]+)?$", re.I)
_TAG_OK = re.compile(r"[^a-z0-9-]+")
_ANCHOR = re.compile(r"^>\s*\(\[\[[^\]|]*\|[^\]]*?,\s*pp?\.\s*([\w–-]+)\]\]\)\s*$")
_NOTE_LINE = re.compile(r"^-\s*pp?\.\s*([\w–-]+):\s*(.*)$")


# ------------------------------------------------------------------ lookup
def _isbn13(s):
    return re.sub(r"[^0-9Xx]", "", s or "")


def lookup(data):
    """Reference fields for one ISBN or DOI. CrossRef first (it carries the DOI and
    the subtitle), Open Library as the fallback for ISBNs CrossRef lacks."""
    isbn = _isbn13(data.get("isbn"))
    doi = (data.get("doi") or "").strip().lower()
    if not isbn and not doi:
        return {"ok": False, "error": "give an ISBN or a DOI"}
    item = None
    try:
        if doi:
            item = litcite._get_json(
                f"https://api.crossref.org/works/{urllib.parse.quote(doi)}?mailto={litcite.EMAIL}")["message"]
        else:
            res = litcite._get_json(
                f"https://api.crossref.org/works?filter=isbn:{isbn}&rows=100&mailto={litcite.EMAIL}")
            items = (res.get("message") or {}).get("items") or []
            # an ISBN also tags every chapter and back-matter record; keep the book
            whole = [x for x in items if x.get("type") in ("monograph", "book", "edited-book", "reference-book")]
            item = whole[0] if whole else None
    except Exception:  # noqa - a failed lookup falls through to Open Library
        item = None
    if item:
        f = litcite._from_crossref(item)
        sub = (item.get("subtitle") or [""])[0].strip()
        if sub and sub.lower() not in f["title"].lower():
            f["title"] = f"{f['title'].rstrip(':')}: {sub}"
        if f["type"] not in ("book", "chapter"):
            f["type"] = "book"
        return {"ok": True, "fields": f, "from": "crossref"}
    if isbn:
        try:
            ol = litcite._get_json(
                f"https://openlibrary.org/api/books?bibkeys=ISBN:{isbn}&format=json&jscmd=data")
            rec = ol.get(f"ISBN:{isbn}")
        except Exception:  # noqa
            rec = None
        if rec:
            f = litcite._from_openlibrary(rec)
            f["isbn"] = f["isbn"] or isbn
            return {"ok": True, "fields": f, "from": "openlibrary"}
    return {"ok": False, "error": "no record found; type the fields in"}


# ------------------------------------------------------------------ paths
def make_stem(fields):
    """`Author (Year) - Title`, the corpus convention; a subtitle colon becomes a space
    after the main title's own punctuation, as the reading lists already write it."""
    au = litcite._yaml_authors(fields.get("authors") or []) or "Anon"
    yr = (fields.get("year") or "n.d.").strip()
    title = re.sub(r":\s*", " ", (fields.get("title") or "").strip())
    title = _STEM_BAD.sub(" ", title)
    return re.sub(r"\s{2,}", " ", f"{au} ({yr}) - {title}").strip()


def _note_path(stem):
    """The note for a stem, or None when the stem could escape Citations/."""
    stem = stem.strip() if isinstance(stem, str) else ""
    if not stem or len(stem) > 240 or "\x00" in stem or "\n" in stem or ".." in stem or "/" in stem or "\\" in stem or stem.startswith(".") or _STEM_BAD.search(stem):
        return None
    p = CITATIONS / f"{stem}.md"
    try:
        p.resolve().relative_to(CITATIONS.resolve())
    except ValueError:
        return None
    return p


def _frontmatter(text):
    m = re.match(r"^---\n(.*?)\n---\n", text, re.S)
    if not m:
        return {}
    out = {}
    for ln in m.group(1).splitlines():
        k, sep, v = ln.partition(":")
        if sep and not ln.startswith((" ", "-")):
            out[k.strip()] = v.strip().strip('"')
    return out


def _is_print(text):
    return _frontmatter(text).get("format") == "print"


# ------------------------------------------------------------------ create
def create(data):
    f = dict(litcite._blank(), **{k: v for k, v in (data.get("fields") or {}).items() if v is not None})
    if isinstance(f.get("authors"), str):
        f["authors"] = [a.strip() for a in f["authors"].split(";") if a.strip()]
    for k, v in list(f.items()):                 # one line per frontmatter value
        if isinstance(v, str):
            f[k] = " ".join(v.split())
        elif isinstance(v, list):
            f[k] = [" ".join(x.split()) for x in v if isinstance(x, str) and x.strip()]
    f["type"] = f.get("type") or "book"
    if not (f.get("title") and f.get("authors") and f.get("year")):
        return {"ok": False, "error": "author, year and title are needed"}
    stem = data.get("stem") if isinstance(data.get("stem"), str) else ""
    stem = stem.strip() or make_stem(f)
    note = _note_path(stem)
    if note is None:
        return {"ok": False, "error": "bad stem"}
    rel = f"{CIT_REL}/{stem}.md"
    with _WRITE:
        if note.exists():
            text = reading.read_text(note) or ""
            if not _is_print(text):
                return {"ok": False, "error": "a citation note with this name exists and is not a print copy"}
            linked = _link_readings(stem, rel, f.get("doi"))
            return {"ok": True, "created": False, "stem": stem, "path": rel, "linked": linked}
        existing = litcite._existing_keys()
        citekey = litcite.make_citekey(f, existing)
        fm = ["---",
              "pdf-path:",
              f"author: {litcite._yaml_authors(f['authors'])}",
              f"year: {f['year']}",
              f"title: {f['title']}",
              f"source: {f.get('publisher') or f.get('container') or ''}",
              f"source-type: {litcite.TYPES.get(f['type'], ('', 'book'))[1]}",
              "format: print",
              f"citekey: {citekey}"]
        if f.get("doi"):
            fm += [f"doi: {f['doi']}", f'doi-verified: "{reading._today()}"', "verified: true"]
        else:
            fm.append("verified: false")
        for k in ("isbn", "edition"):
            if f.get(k):
                fm.append(f"{k}: {f[k]}")
        fm += ["status: unread", "rating:", "tags:", "---", "",
               f"# {stem}", "",
               "**Copy:** print", ""]
        body = litcite.render_sections({"Citation": litcite.build_citation(f)})
        reading._atomic_write(note, "\n".join(fm) + "\n" + body)
        bib = litcite._upsert_bib(citekey, litcite.build_bibtex(f, citekey, rel), existing)
        linked = _link_readings(stem, rel, f.get("doi"))
    return {"ok": True, "created": True, "stem": stem, "path": rel, "citekey": citekey,
            "bibWritten": bib, "linked": linked}


def _link_readings(stem, rel, doi):
    """Point every reading of this work (title or Source stem, or DOI) at the note."""
    want = reading._fold(stem)
    doi = (doi or "").strip().lower() or None
    linked = []
    try:
        with reading.locked(timeout=20):
            for kind, p in reading._sources():
                d = reading._load_path(p, kind)
                if d is None:
                    continue
                hit = False
                for L in d["lists"]:
                    for g in L["groups"]:
                        for x in g["items"]:
                            if x.get("citationPath"):
                                continue
                            same = (reading._fold(x.get("source")) == want
                                    or reading._fold(x["title"]) == want
                                    or (doi and (x.get("doi") or "").strip().lower() == doi))
                            if same:
                                reading._set_subbullet(x, "Citation", f"[[{rel}|{stem}]]")
                                linked.append(x["title"])
                                hit = True
                if hit:
                    reading._save(d)
    except reading.LockBusy:
        pass
    return linked


# ------------------------------------------------------------------ read
def _sections(lines):
    """{name: (start, end)} for each `## ` section; end is exclusive."""
    heads = [(i, l[3:].strip()) for i, l in enumerate(lines) if l.startswith("## ")]
    out = {}
    for n, (i, name) in enumerate(heads):
        out.setdefault(name, (i + 1, heads[n + 1][0] if n + 1 < len(heads) else len(lines)))
    return out


def _eid(kind, page, text):
    return hashlib.sha1(f"{kind}|{page}|{text}".encode()).hexdigest()[:10]


def _entries(lines):
    sec = _sections(lines)
    out = []
    if "Quotes" in sec:
        lo, hi = sec["Quotes"]
        i = lo
        while i < hi:
            m = _ANCHOR.match(lines[i].strip())
            if not m:
                i += 1
                continue
            tagline = lines[i - 1].strip() if i - 1 >= lo else ""
            tags = re.findall(r"#([A-Za-z0-9][\w-]*)", tagline) if tagline.startswith("#") else []
            j, buf = i + 1, []
            while j < hi and lines[j].startswith(">"):
                buf.append(lines[j][1:].strip())
                j += 1
            text = " ".join(buf).strip()
            out.append({"id": _eid("quote", m.group(1), text), "kind": "quote",
                        "page": m.group(1), "text": text, "tags": tags})
            i = j
    if "Notes" in sec:
        lo, hi = sec["Notes"]
        for i in range(lo, hi):
            m = _NOTE_LINE.match(lines[i].strip())
            if m:
                body = m.group(2)
                tags = re.findall(r"(?<![\w&/])#([A-Za-z][\w-]*)", body)
                text = re.sub(r"\s*(?<![\w&/])#[A-Za-z][\w-]*", "", body).strip()
                out.append({"id": _eid("note", m.group(1), text), "kind": "note",
                            "page": m.group(1), "text": text, "tags": tags})
    return out


def _page_key(p):
    m = re.match(r"\d+", p or "")
    return (0, int(m.group(0))) if m else (-1, 0)   # roman front matter first


def get(stem):
    note = _note_path(stem)
    if note is None or not note.is_file():
        return {"ok": False, "error": "no such note"}
    text = reading.read_text(note) or ""
    fm = _frontmatter(text)
    lines = text.splitlines()
    sec = _sections(lines)
    cit = ""
    if "Citation" in sec:
        lo, hi = sec["Citation"]
        cit = "\n".join(l for l in lines[lo:hi] if l.strip()).strip()
    entries = sorted(_entries(lines), key=lambda e: _page_key(e["page"]))
    return {"ok": True, "stem": stem, "path": f"{CIT_REL}/{stem}.md", "print": fm.get("format") == "print",
            "citation": cit, "citekey": fm.get("citekey", ""), "isbn": fm.get("isbn", ""),
            "doi": fm.get("doi", ""), "entries": entries}


def list_print(_data=None):
    """Every print-copy note, newest first, for the Library and Reading pickers."""
    out = []
    for p in CITATIONS.glob("*.md"):
        try:
            with open(p, encoding="utf-8") as fh:
                head = fh.read(2000)
        except OSError:
            continue
        if "\nformat: print" in head:
            out.append((p.stat().st_mtime, p.stem))
    return {"ok": True, "books": [s for _, s in sorted(out, reverse=True)]}


# ------------------------------------------------------------------ add / delete
def _clean_tags(tags):
    if isinstance(tags, str):
        tags = re.split(r"[\s,]+", tags)
    out = []
    for t in tags or []:
        t = _TAG_OK.sub("-", t.strip().lstrip("#").lower()).strip("-")
        if t and t not in out:
            out.append(t)
    return out


def add(data):
    stem = data.get("stem")
    note = _note_path(stem)
    if note is None or not note.is_file():
        return {"ok": False, "error": "no such note"}
    kind = data.get("kind")
    page = re.sub(r"\s+", "", str(data.get("page") or ""))
    text = re.sub(r"\s+", " ", str(data.get("text") or "")).strip()
    tags = _clean_tags(data.get("tags"))
    if kind not in ("quote", "note"):
        return {"ok": False, "error": "kind must be quote or note"}
    if not _PAGE_OK.match(page):
        return {"ok": False, "error": "page must be a printed page, e.g. 47, 47-48 or xii"}
    if not text:
        return {"ok": False, "error": "nothing to save"}
    rel = f"{CIT_REL}/{stem}.md"
    with _WRITE:
        cur = reading.read_text(note) or ""
        if not _is_print(cur):
            return {"ok": False, "error": "not a print-copy note"}
        lines = cur.splitlines()
        sec = _sections(lines)
        name = "Quotes" if kind == "quote" else "Notes"
        if name not in sec:                           # at its canonical position
            lines = litcite.insert_section(lines, name)
            sec = _sections(lines)
        lo, hi = sec[name]
        while hi > lo and not lines[hi - 1].strip():
            hi -= 1                                   # insert after the last content line
        if kind == "quote":
            tagline = " ".join(f"#{t}" for t in (tags or ["quote"])) + ":"
            block = ["", tagline, f"> ([[{rel[:-3]}|{stem}, p.{page}]])", f"> {text}"]
        else:
            block = [f"- p. {page}: {text}" + "".join(f" #{t}" for t in tags)]
            if hi == lo or not lines[hi - 1].startswith("- "):
                block.insert(0, "")
        lines[hi:hi] = block
        new = "\n".join(lines).rstrip("\n") + "\n"
        reading._atomic_write(note, new)
    return {"ok": True, "id": _eid(kind, page, text)}


def delete(data):
    """Remove one entry by id (the note-taker's undo for a typo)."""
    stem, eid = data.get("stem"), data.get("id")
    note = _note_path(stem)
    if note is None or not note.is_file() or not eid:
        return {"ok": False, "error": "no such entry"}
    with _WRITE:
        cur = reading.read_text(note) or ""
        if not _is_print(cur):
            return {"ok": False, "error": "not a print-copy note"}
        lines = cur.splitlines()
        sec = _sections(lines)
        for name in ("Quotes", "Notes"):
            if name not in sec:
                continue
            lo, hi = sec[name]
            for i in range(lo, hi):
                s = lines[i].strip()
                if name == "Quotes":
                    m = _ANCHOR.match(s)
                    if not m:
                        continue
                    j, buf = i + 1, []
                    while j < hi and lines[j].startswith(">"):
                        buf.append(lines[j][1:].strip())
                        j += 1
                    if _eid("quote", m.group(1), " ".join(buf).strip()) != eid:
                        continue
                    a = i - 1 if i - 1 >= lo and lines[i - 1].strip().startswith("#") else i
                    if a - 1 >= lo and not lines[a - 1].strip():
                        a -= 1
                    del lines[a:j]
                else:
                    m = _NOTE_LINE.match(s)
                    if not m:
                        continue
                    body = re.sub(r"\s*(?<![\w&/])#[A-Za-z][\w-]*", "", m.group(2)).strip()
                    if _eid("note", m.group(1), body) != eid:
                        continue
                    del lines[i]
                    if i - 1 >= 0 and not lines[i - 1].strip() and (i >= len(lines) or not lines[i].strip()):
                        del lines[i - 1]               # don't leave a doubled blank line
                reading._atomic_write(note, "\n".join(lines).rstrip("\n") + "\n")
                return {"ok": True}
    return {"ok": False, "error": "no such entry"}


OPS = {"lookup": lookup, "create": create, "add": add, "delete": delete, "list": list_print}
