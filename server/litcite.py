"""litcite.py — citation metadata + BibTeX for the Reading Inbox triage."""
import settings
import json
import os
import re
import urllib.parse
import urllib.request

import sys
from pathlib import Path

import litinbox   # shared Inbox paths + PDF text/meta helpers
import reading    # vault paths

CITATION_SECTIONS = ("Brief Summary", "Citation", "Key Points", "Limitations",
                     "Notes", "Quotes", "Further Reading")


def render_sections(bodies=None):
    bodies = bodies or {}
    out = []
    for name in CITATION_SECTIONS:
        body = (bodies.get(name) or "").strip("\n")
        out.append(f"## {name}\n\n" + (f"{body}\n\n" if body else ""))
    return "".join(out).rstrip("\n") + "\n"


def insert_section(lines, name, body_lines=()):
    later = CITATION_SECTIONS[CITATION_SECTIONS.index(name) + 1:]
    idx = next((i for i, ln in enumerate(lines)
                if ln.startswith("## ") and ln[3:].strip() in later), len(lines))
    block = [f"## {name}", "", *body_lines] + ([""] if body_lines else [])
    if idx > 0 and lines[idx - 1].strip():
        block.insert(0, "")
    return list(lines[:idx]) + block + list(lines[idx:])

VAULT = reading.VAULT
CITATIONS = reading.CITATIONS_DIR
CORPUS_REL = "Preparation/Reading/Corpus"
LIBBIB = VAULT / "Preparation" / "Reading" / "References" / "library.bib"
EMAIL = settings.CONTACT_EMAIL
UA = f"all-in-one-academic/1.0 (mailto:{EMAIL})"

DOI_RE = re.compile(r"\b(10\.\d{4,9}/[-._;()/:A-Za-z0-9]+)\b")
ISBN_RE = re.compile(r"\b(97[89][-\s]?(?:\d[-\s]?){9}\d|\d[-\s]?(?:\d[-\s]?){8}[\dXx])\b")
STOP = {"the", "and", "for", "with", "from", "into", "about", "des", "les", "der"}

# canonical -> (bibtype, note source-type). The UI type dropdown uses these keys.
TYPES = {
    "book": ("book", "book"),
    "article": ("article", "article"),
    "chapter": ("incollection", "chapter"),
    "report": ("techreport", "report"),
    "thesis": ("phdthesis", "thesis"),
    "web": ("misc", "website"),
    "dataset": ("misc", "dataset"),
}
CROSSREF_TYPE = {
    "journal-article": "article", "proceedings-article": "article",
    "book": "book", "monograph": "book", "reference-book": "book",
    "book-chapter": "chapter", "book-part": "chapter", "book-section": "chapter",
    "report": "report", "dissertation": "thesis", "dataset": "dataset",
    "posted-content": "article",
}


# --------------------------------------------------------------------- helpers
def _tokens(s):
    return {t for t in re.findall(r"[a-z0-9]{3,}", (s or "").lower()) if t not in STOP}


def _get_json(url, timeout=15):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def _blank():
    return {"type": "", "authors": [], "year": "", "title": "", "container": "",
            "publisher": "", "address": "", "volume": "", "issue": "", "pages": "",
            "doi": "", "isbn": "", "editor": "", "edition": "", "url": ""}


def _score(rec, want_authors, want_title):
    want = _tokens(want_title)
    have = _tokens(rec.get("title"))
    overlap = len(want & have) / len(want) if want else 0
    a_hit = 0
    if want_authors and rec.get("authors"):
        hay = " ".join(rec["authors"]).lower()
        a_hit = 1 if any(a.lower() in hay for a in want_authors) else 0
    return round(overlap * 0.75 + a_hit * 0.25, 2)


_REVIEW_TITLE_RE = re.compile(
    r"\bbook\s+reviews?\b|\breviewed\s+works?\b|\breview(?:ed)?\s+by\b"
    r"|\breview\s+essays?\b|^\s*reviews?\s*[:.]|\s/\s*reviews?\b", re.I)
_BY_CREDIT_RE = re.compile(
    r"(?:\.\s*|\s)by\s+(?:(?:[A-Z]\.\s*)+[A-Z][\w'’-]+|[A-Z][\w'’-]+"
    r"(?:\s+(?:[A-Z]\.\s*)*[A-Z][\w'’-]+){1,3})\s*\.?\s*$")
REVIEW_MAX_PAGES = 4


def _surname(a):
    a = (a or "").strip()
    if not a:
        return ""
    s = a.split(",")[0] if "," in a else a.split()[-1]
    return re.sub(r"[^a-z]", "", s.lower())


def _page_span(pages):
    """Pages covered by 'p-q', or None when the record gives only a start page."""
    m = re.match(r"\s*(\d+)\s*[-–—]+\s*(\d+)\s*$", pages or "")
    if m:
        a, b = int(m.group(1)), int(m.group(2))
        return b - a + 1 if b >= a else None
    return None


def review_doi_reject(rec, want=None):
    want = want or {}
    ti = rec.get("title") or ""
    is_article = (rec.get("type") or "article") == "article"
    span = _page_span(rec.get("pages"))
    short = span is not None and span <= REVIEW_MAX_PAGES
    w_surs = [_surname(a) for a in (want.get("authors") or []) if _surname(a)]
    r_surs = [_surname(a) for a in (rec.get("authors") or []) if _surname(a)]
    author_absent = bool(w_surs) and bool(r_surs) and not any(s in r_surs for s in w_surs)
    wants_book = (want.get("type") or "") == "book"

    if _REVIEW_TITLE_RE.search(ti):
        return f"review-shaped title {ti[:60]!r}"
    if is_article and _BY_CREDIT_RE.search(ti):
        return f"reviewee credit in title {ti[:60]!r}"
    reviewer_first = (bool(w_surs) and len(r_surs) > 1 and w_surs[0] != r_surs[0]
                      and w_surs[0] in r_surs[1:])
    has_pages = bool((rec.get("pages") or "").strip())
    if is_article and reviewer_first and has_pages and (span is None or short):
        return (f"reviewer {r_surs[0]!r} filed ahead of the work's {w_surs[0]!r} "
                f"on a record in {rec.get('container') or 'a journal'}")
    if is_article and short and (author_absent or wants_book):
        return (f"{span}-page item in {rec.get('container') or 'a journal'}"
                + (" by a different author" if author_absent else " for a book"))
    if is_article and author_absent:
        return (f"first author {r_surs[0]!r} is not the note's {w_surs[0]!r}")
    if wants_book and is_article and rec.get("container") and not rec.get("isbn"):
        return f"a book, but the record is an article in {rec['container']!r}"
    return None


# --------------------------------------------------------------- source mappers
def _cr_authors(item):
    out = []
    for a in item.get("author", []) or []:
        fam, given = (a.get("family") or "").strip(), (a.get("given") or "").strip()
        if fam and given:
            out.append(f"{fam}, {given}")
        elif fam:
            out.append(fam)
        elif a.get("name"):
            out.append(a["name"].strip())
    return out


def _from_crossref(item):
    r = _blank()
    r["type"] = CROSSREF_TYPE.get(item.get("type", ""), "article")
    r["authors"] = _cr_authors(item)
    r["editor"] = "; ".join(
        f"{e.get('family','')}, {e.get('given','')}".strip(", ")
        for e in (item.get("editor") or []))
    dp = (item.get("issued", {}) or {}).get("date-parts", [[None]])
    r["year"] = str(dp[0][0]) if dp and dp[0] and dp[0][0] else ""
    r["title"] = (item.get("title") or [""])[0]
    cont = item.get("container-title") or []
    r["container"] = cont[0] if cont else ""
    r["publisher"] = item.get("publisher", "") or ""
    r["address"] = (item.get("publisher-location") or "")
    r["volume"] = str(item.get("volume", "") or "")
    r["issue"] = str(item.get("issue", "") or "")
    r["pages"] = item.get("page", "") or ""
    r["doi"] = (item.get("DOI") or "").lower()
    isbns = item.get("ISBN") or []
    r["isbn"] = (isbns[0] if isbns else "").replace("http://id.crossref.org/isbn/", "")
    r["edition"] = str(item.get("edition-number", "") or "")
    return r


def _from_openlibrary(data):
    r = _blank()
    r["type"] = "book"
    r["authors"] = [a.get("name", "") for a in (data.get("authors") or []) if a.get("name")]
    r["year"] = re.search(r"\d{4}", data.get("publish_date", "") or "")
    r["year"] = r["year"].group(0) if r["year"] else ""
    r["title"] = data.get("title", "") or ""
    pubs = data.get("publishers") or []
    r["publisher"] = (pubs[0].get("name") if pubs and isinstance(pubs[0], dict) else (pubs[0] if pubs else "")) or ""
    places = data.get("publish_places") or []
    r["address"] = (places[0].get("name") if places and isinstance(places[0], dict) else "") or ""
    ids = data.get("identifiers", {}) or {}
    r["isbn"] = (ids.get("isbn_13") or ids.get("isbn_10") or [""])[0]
    r["url"] = data.get("url", "") or ""
    return r


def _from_openalex(w):
    r = _blank()
    t = (w.get("type") or "").lower()
    r["type"] = {"book": "book", "book-chapter": "chapter", "dissertation": "thesis",
                 "report": "report", "dataset": "dataset"}.get(t, "article")
    r["authors"] = []
    for a in w.get("authorships", []) or []:
        nm = (a.get("author") or {}).get("display_name", "")
        if nm:
            parts = nm.split()
            r["authors"].append(f"{parts[-1]}, {' '.join(parts[:-1])}" if len(parts) > 1 else nm)
    r["year"] = str(w.get("publication_year", "") or "")
    r["title"] = w.get("title", "") or ""
    src = ((w.get("primary_location") or {}).get("source") or {})
    r["container"] = src.get("display_name", "") or ""
    r["publisher"] = src.get("host_organization_name", "") or ""
    biblio = w.get("biblio", {}) or {}
    r["volume"] = str(biblio.get("volume", "") or "")
    r["issue"] = str(biblio.get("issue", "") or "")
    fp, lp = biblio.get("first_page"), biblio.get("last_page")
    r["pages"] = f"{fp}-{lp}" if fp and lp else (fp or "")
    r["doi"] = (w.get("doi") or "").replace("https://doi.org/", "").lower()
    return r


# ------------------------------------------------------------------ suggestion
def suggest(name):
    """Metadata candidates for one Inbox PDF, from the PDF + CrossRef + Open
    Library + OpenAlex. Returns {detected, candidates, prefill}."""
    fn = litinbox._confine(name)
    if not fn:
        return {"error": "bad name"}
    p = litinbox.INBOX / fn
    if not p.is_file():
        return {"error": "not in the Inbox"}
    stem = os.path.splitext(fn)[0]
    parsed = litinbox._parse_stem(stem) if litinbox.CONV.match(stem) else None
    meta = litinbox._pdfinfo(p) or {}
    text = litinbox._first_pages_text(p)
    want_title = (parsed or {}).get("title") or litinbox._clean_field(meta.get("title", "")) or stem
    want_authors = re.findall(r"[A-Z][a-z]+", (parsed or {}).get("author", "")) if parsed else []

    doi = ""
    m = DOI_RE.search(text)
    if m:
        doi = m.group(1).rstrip(".").lower()
    isbn = ""
    mi = ISBN_RE.search(text)
    if mi:
        isbn = re.sub(r"[-\s]", "", mi.group(1))

    cands = []
    # 1) CrossRef by detected DOI (exact) — highest confidence
    if doi:
        try:
            it = _get_json(f"https://api.crossref.org/works/{urllib.parse.quote(doi)}?mailto={EMAIL}")
            rec = _from_crossref(it["message"])
            rec["_source"], rec["_score"] = "CrossRef (DOI in PDF)", 1.0
            cands.append(rec)
        except Exception:
            pass
    # 2) CrossRef bibliographic search
    try:
        q = urllib.parse.quote(f"{want_title} {' '.join(want_authors[:2])}".strip())
        url = (f"https://api.crossref.org/works?query.bibliographic={q}&rows=5"
               f"&select=DOI,title,author,editor,issued,container-title,publisher,"
               f"publisher-location,volume,issue,page,type,ISBN,edition-number&mailto={EMAIL}")
        for it in _get_json(url).get("message", {}).get("items", []):
            rec = _from_crossref(it)
            rec["_source"] = "CrossRef"
            rec["_score"] = _score(rec, want_authors, want_title)
            cands.append(rec)
    except Exception:
        pass
    # 3) Open Library — books, by ISBN (exact) then title+author
    try:
        if isbn:
            d = _get_json(f"https://openlibrary.org/api/books?bibkeys=ISBN:{isbn}&format=json&jscmd=data")
            for v in d.values():
                rec = _from_openlibrary(v)
                rec["isbn"] = rec["isbn"] or isbn
                rec["_source"], rec["_score"] = "Open Library (ISBN in PDF)", 0.95
                cands.append(rec)
        else:
            au = want_authors[0] if want_authors else ""
            d = _get_json("https://openlibrary.org/search.json?" + urllib.parse.urlencode(
                {"title": want_title, "author": au, "limit": 3, "fields":
                 "title,author_name,first_publish_year,publisher,isbn,place"}))
            for doc in d.get("docs", []):
                rec = _blank()
                rec["type"] = "book"
                rec["authors"] = doc.get("author_name", []) or []
                rec["year"] = str(doc.get("first_publish_year", "") or "")
                rec["title"] = doc.get("title", "") or ""
                rec["publisher"] = (doc.get("publisher") or [""])[0]
                rec["isbn"] = (doc.get("isbn") or [""])[0]
                rec["_source"] = "Open Library"
                rec["_score"] = _score(rec, want_authors, want_title)
                cands.append(rec)
    except Exception:
        pass
    # 4) OpenAlex fallback
    try:
        url = ("https://api.openalex.org/works?search=" + urllib.parse.quote(want_title) +
               f"&per_page=3&mailto={EMAIL}")
        for w in _get_json(url).get("results", []):
            rec = _from_openalex(w)
            rec["_source"] = "OpenAlex"
            rec["_score"] = _score(rec, want_authors, want_title)
            cands.append(rec)
    except Exception:
        pass

    # dedup on (doi or title-key), keep the highest score; drop obvious non-matches
    best = {}
    for rec in cands:
        if rec["_score"] < 0.34 and rec["_source"] not in (
                "CrossRef (DOI in PDF)", "Open Library (ISBN in PDF)"):
            continue
        key = rec["doi"] or re.sub(r"[^a-z0-9]", "", (rec["title"] or "").lower())[:40]
        if key and (key not in best or rec["_score"] > best[key]["_score"]):
            best[key] = rec
    ranked = sorted(best.values(), key=lambda r: -r["_score"])[:6]

    prefill = _blank()
    prefill["authors"] = ([f"{parsed['author']}"] if parsed and " and " not in parsed["author"]
                          and " et al" not in parsed["author"] else [])
    prefill["year"] = (parsed or {}).get("year", "")
    prefill["title"] = want_title
    if ranked:
        top = ranked[0]
        for k in _blank():
            if not prefill.get(k) and top.get(k):
                prefill[k] = top[k]
        prefill["type"] = prefill["type"] or top.get("type", "")
    prefill["doi"] = prefill["doi"] or doi
    prefill["isbn"] = prefill["isbn"] or isbn
    if not prefill["type"]:
        prefill["type"] = "book"

    return {"ok": True, "name": fn, "detected": {"doi": doi, "isbn": isbn},
            "candidates": ranked, "prefill": prefill}


# --------------------------------------------------------------------- bibtex
def _lead_surname(authors):
    if not authors:
        return "anon"
    first = authors[0]
    surname = first.split(",")[0] if "," in first else first.split()[-1]
    return re.sub(r"[^a-z]", "", surname.lower()) or "anon"


def _existing_keys():
    try:
        txt = LIBBIB.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return {}
    out = {}
    for m in re.finditer(r"@\w+\{([^,]+),(.*?)\n\}", txt, re.S):
        out[m.group(1).strip()] = m.group(0)
    return out


def make_citekey(fields, existing=None):
    existing = existing if existing is not None else _existing_keys()
    base = _lead_surname(fields.get("authors", [])) + (fields.get("year", "") or "nd")
    if base not in existing:
        return base
    # same key already used — if it's the SAME work (title match) reuse it, else suffix
    want = _tokens(fields.get("title"))
    for suf in [""] + list("abcdefghij"):
        k = base + suf
        if k not in existing:
            return k
        have = _tokens(re.search(r"title\s*=\s*\{(.*?)\}", existing[k], re.S).group(1)
                       if re.search(r"title\s*=\s*\{(.*?)\}", existing[k], re.S) else "")
        if want and have and len(want & have) / len(want) > 0.7:
            return k                    # same work -> reuse this exact key
    return base + "x"


def _bib_authors(authors):
    return " and ".join(authors) if authors else ""


def build_bibtex(fields, citekey, vault_source_rel=None):
    bibtype = TYPES.get(fields.get("type", "book"), ("misc", ""))[0]
    lines = [f"@{bibtype}{{{citekey},"]

    def add(k, v):
        v = (v or "").strip()
        if v:
            lines.append(f"  {k:<12} = {{{v}}},")

    add("author", _bib_authors(fields.get("authors", [])))
    add("editor", fields.get("editor"))
    add("year", fields.get("year"))
    add("title", fields.get("title"))
    if fields.get("type") == "article":
        add("journal", fields.get("container"))
    elif fields.get("type") == "chapter":
        add("booktitle", fields.get("container"))
    add("volume", fields.get("volume"))
    add("number", fields.get("issue"))
    add("pages", (fields.get("pages") or "").replace("-", "--") if fields.get("pages") else "")
    add("publisher", fields.get("publisher"))
    add("address", fields.get("address"))
    add("edition", fields.get("edition"))
    add("isbn", fields.get("isbn"))
    add("doi", fields.get("doi"))
    add("url", fields.get("url"))
    if vault_source_rel:
        lines.append(f"  % vault-source = {vault_source_rel}")
    lines.append("}")
    return "\n".join(lines)


def _asa_authors(authors):
    """ASA name order: first 'Surname, Given', rest 'Given Surname', 'and' before last."""
    def flip(a):
        if "," in a:
            fam, giv = [x.strip() for x in a.split(",", 1)]
            return f"{giv} {fam}".strip()
        return a
    if not authors:
        return ""
    if len(authors) == 1:
        return authors[0]
    rest = [flip(a) for a in authors[1:]]
    if len(authors) == 2:
        return f"{authors[0]} and {rest[0]}"
    return f"{authors[0]}, " + ", ".join(rest[:-1]) + f", and {rest[-1]}"


def build_citation(fields):
    """An ASA-shaped `## Citation` line — the round-trippable prose the vault uses."""
    au = _asa_authors(fields.get("authors", []))
    yr = fields.get("year", "") or "n.d."
    title = fields.get("title", "").strip()
    t = fields.get("type", "book")
    head = f"{au}. {yr}. "
    if t == "article":
        s = f'"{title}." *{fields.get("container","")}*'
        if fields.get("volume"):
            s += f" {fields['volume']}"
        if fields.get("issue"):
            s += f"({fields['issue']})"
        if fields.get("pages"):
            s += f":{fields['pages']}"
        return head + s.rstrip() + "."
    if t == "chapter":
        s = f'"{title}." Pp. {fields.get("pages","")} in *{fields.get("container","")}*'
        if fields.get("editor"):
            s += f", edited by {fields['editor']}"
        loc = ": ".join(x for x in (fields.get("address"), fields.get("publisher")) if x)
        return head + s + (f". {loc}" if loc else "") + "."
    # book / report / thesis / misc
    s = f"*{title}*"
    loc = ": ".join(x for x in (fields.get("address"), fields.get("publisher")) if x)
    return head + s + (f". {loc}" if loc else "") + "."


def preview(fields):
    ck = make_citekey(fields)
    return {"ok": True, "citekey": ck, "bibtex": build_bibtex(fields, ck),
            "citation": build_citation(fields)}


# ------------------------------------------------------------- write on filing
def _yaml_authors(authors):
    if not authors:
        return ""
    surs = [a.split(",")[0].strip() if "," in a else a.split()[-1] for a in authors]
    if len(surs) == 1:
        return surs[0]
    if len(surs) == 2:
        return f"{surs[0]} and {surs[1]}"
    return f"{surs[0]} et al."


def write_on_file(stem, fields, pdf_rel=None):
    if not fields or not (fields.get("title") or fields.get("authors")):
        return {"cited": False}

    doi_rejected = None
    if fields.get("doi"):
        want = _fields_from_title(stem)
        want["type"] = fields.get("type", "")
        doi_rejected = review_doi_reject(fields, want)
        if doi_rejected:
            fields = dict(fields, doi="")

    stem = str(stem or "")
    if not stem or stem.startswith(".") or "/" in stem or "\\" in stem or "\x00" in stem:
        return {"cited": False, "error": "bad note name"}
    note = CITATIONS / (stem + ".md")
    try:
        inside = note.resolve().is_relative_to(CITATIONS.resolve())
    except OSError:
        inside = False
    if not inside:
        return {"cited": False, "error": "bad note name"}
    src_rel = f"Preparation/Reading/Citations/{stem}.md"
    existing = _existing_keys()
    citekey = make_citekey(fields, existing)

    note_written = False
    if not note.exists():
        prel = pdf_rel or f"{CORPUS_REL}/{stem}.pdf"
        pname = os.path.basename(prel)
        fm = ["---",
              f"pdf-path: {prel}",
              f'pdf-file: "[[{prel}|{pname}]]"',
              f"author: {_yaml_authors(fields.get('authors', []))}",
              f"year: {fields.get('year','')}",
              f"title: {fields.get('title','')}",
              f"source: {fields.get('container') or fields.get('publisher','')}",
              f"source-type: {TYPES.get(fields.get('type','book'), ('','book'))[1]}",
              f"citekey: {citekey}"]
        if fields.get("doi"):
            fm += [f"doi: {fields['doi']}", "doi-verified: " + reading._today(), "verified: true"]
        else:
            fm.append("verified: false")
        if fields.get("isbn"):
            fm.append(f"isbn: {fields['isbn']}")
        fm += ["status: unread", "rating:", "tags:", "---", ""]
        body = render_sections({"Citation": build_citation(fields)})
        try:
            reading._atomic_write(note, "\n".join(fm) + "\n" + body)
            note_written = True
        except OSError:
            pass

    bib_written = _upsert_bib(citekey, build_bibtex(fields, citekey, src_rel), existing)
    out = {"cited": True, "citekey": citekey, "noteWritten": note_written,
           "bibWritten": bib_written}
    if doi_rejected:
        out["doiRejected"] = doi_rejected
    return out


def _upsert_bib(citekey, entry, existing):
    """Append the entry, or replace an existing same-citekey block. Atomic."""
    try:
        txt = LIBBIB.read_text(encoding="utf-8", errors="replace")
    except OSError:
        txt = ("% library.bib — Auto-generated from Obsidian vault citation notes\n"
               "% Source of truth: Preparation\\Reading\\Citations\\*.md\n\n")
    if citekey in existing and existing[citekey] in txt:
        new = txt.replace(existing[citekey], entry)
    else:
        new = txt.rstrip() + "\n\n" + entry + "\n"
    try:
        reading._atomic_write(LIBBIB, new, backup=True)
        return True
    except OSError:
        return False


def _fields_from_title(title):
    """Minimal, honest fields parsed from an 'Author (Year) - Title' reading line.
    No invention: only what the string actually states."""
    r = _blank()
    m = re.match(r"^(?P<a>.+?)\s*\((?P<y>[^)]*)\)\s*-\s*(?P<t>.+)$", title or "")
    if not m:
        r["title"] = (title or "").strip()
        return r
    y = re.search(r"\d{4}", m.group("y"))
    r["year"] = y.group(0) if y else ""
    r["title"] = m.group("t").strip()
    lead = m.group("a").strip()
    lead = re.sub(r"\s+et\s+al\.?$", "", lead, flags=re.I)
    r["authors"] = [p.strip() for p in re.split(r"\s*(?:,|\band\b|&)\s*", lead) if p.strip()]
    return r


def from_reading_item(title, doi=None, pdf_path=None):
    """Resolve metadata for a reading-list item and write its citation note."""
    fields, source, rejected = None, "title", None
    if doi:
        try:
            item = _get_json(f"https://api.crossref.org/works/{urllib.parse.quote(doi)}")
            fields, source = _from_crossref(item.get("message") or {}), "crossref"
        except Exception:  # noqa - a failed lookup falls back to the title
            fields = None
        if fields:
            rejected = review_doi_reject(fields, _fields_from_title(title))
            if rejected:
                fields, doi = None, None
    if not fields or not (fields.get("title") or fields.get("authors")):
        fields, source = _fields_from_title(title), "title"
    if doi and not fields.get("doi"):
        fields["doi"] = doi
    if not fields.get("type"):
        fields["type"] = "book" if not fields.get("container") else "article"

    # Prefer the PDF's own stem so the note sits beside the file it describes.
    stem = None
    if pdf_path:
        stem = os.path.splitext(os.path.basename(pdf_path))[0]
    if not stem:
        stem = re.sub(r'[\\/:*?"<>|#\[\]]', " ", title or "untitled")
        stem = re.sub(r"\s+", " ", stem).strip()[:180]

    res = write_on_file(stem, fields, pdf_rel=pdf_path or None)
    res.update({"stem": stem, "metadataFrom": source,
                "notePath": f"Preparation/Reading/Citations/{stem}.md"})
    if rejected:
        res["doiRejected"] = rejected
    return res
