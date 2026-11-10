"""Searchable citation index for the Drafting view's @-citation + quote workbench."""
import json, os, re
from collections import defaultdict

import citenames                              # the ASA in-text author label
import settings

CACHE_NAME = ".citation-index-cache.json"   # per-file mtime memo (internal, incremental)
INDEX_NAME = "citations-index.json"          # served aggregate (read by serve.py)
_VERSION = 8                                  # bump when extraction logic changes -> full rebuild

CIT_SUBDIR = ("Preparation", "Reading", "Citations")
CLIP_SUBDIR = ("Preparation", "Reading", "Clippings")
HIST_SUBDIR = tuple(settings.PRIMARY_SOURCES_REL.split("/")) + ("Citations",)
# (subdir, kind) pairs scanned by build(), in priority order
SOURCE_DIRS = ((CIT_SUBDIR, "citation"), (CLIP_SUBDIR, "clipping"),
               (HIST_SUBDIR, "historical"))
# kinds that carry a citation-note body and parse with _parse (not _parse_clipping)
NOTE_KINDS = ("citation", "historical")

MAX_KEYPOINTS = 8
MAX_QUOTES = 8
MAX_SNIPPET = 320
CLIP_HAY = 4000                              # web-clipping body chars folded into the search haystack

STRUCTURAL_TAGS = {"citation", "web-source", "corpus", "project-note", "finder",
                   "dashboard", "clipping", "clippings", "rss", "calendar", "flashcards"}

# a numbered Key Point: "1. **Bold claim.** rest..."  (the leading int + dot)
_NUMBERED = re.compile(r"^\s*\d+\.\s+(.*)$")
_INLINE_TAG = re.compile(r"(?<![\w&/])#([A-Za-z][\w\-]*)")

_PAGE_DISPLAY = re.compile(r"\bpp?\.?\s*(\d+(?:\s*[-–]\s*\d+)?)\b")
# the PDF page baked into the wikilink URL: "#page=17"
_PAGE_URL = re.compile(r"#page=(\d+)")
# a trailing page after the quote text: "...end of quote. (p. 47)" / "(pp. 47-48)"
_PAGE_TRAIL = re.compile(r"\(\s*pp?\.\s*(\d+(?:\s*[-–]\s*\d+)?)\s*\)\s*$")

_WIKILINK = re.compile(r"\[\[([^\]]*?)\]\]")
_LEAD_NUM = re.compile(r"^\s*\d+[.)]\s+")             # "1. " / "1) " quote-list marker
_QUOTE_WRAP = re.compile(r'^["“\'‘](.*)["”\'’]$', re.S)   # surrounding quotes (straight/smart)
_PAGE_RANGE = re.compile(r"\s*[-–]\s*")


def _unquote(s):
    s = (s or "").strip()
    if len(s) >= 2 and s[0] in "\"'" and s[-1] == s[0]:
        return s[1:-1]
    return s


def _strip_md(s):
    """Light inline-markdown strip for snippets: drop **bold**/*em*/`code`/#tags."""
    s = re.sub(r"`([^`]*)`", r"\1", s)
    s = re.sub(r"\*\*([^*]+)\*\*", r"\1", s)
    s = re.sub(r"\*([^*]+)\*", r"\1", s)
    s = re.sub(r"(?<![\w&/])#[A-Za-z][\w\-]*", "", s)
    return s.strip(" :").strip()


# --------------------------------------------------------------------------- frontmatter
def _frontmatter(lines):
    """Parse the top `---` block into a dict. Values are str, or list when the key
    is a YAML block/inline list (tags, multi-author clippings). Returns (fm, body_start)."""
    fm, body_start, cur_list = {}, 0, None
    if not (lines and lines[0].strip() == "---"):
        return {}, 0
    for k in range(1, min(len(lines), 300)):
        ln = lines[k]
        if ln.strip() == "---":
            body_start = k + 1
            break
        m = re.match(r"^\s+-\s+(.*)$", ln)
        if m and cur_list is not None:
            if not isinstance(fm.get(cur_list), list):
                fm[cur_list] = []
            fm[cur_list].append(_unquote(m.group(1)))
            continue
        if ":" in ln and not ln[:1].isspace():
            key, _, val = ln.partition(":")
            key, val = key.strip().lower(), val.strip()
            if val == "":
                cur_list = key                       # a block list (or just an empty scalar) follows
                fm.setdefault(key, "")
            elif val.startswith("[") and val.endswith("]"):
                cur_list = None
                fm[key] = [_unquote(x) for x in val[1:-1].split(",") if x.strip()]
            else:
                cur_list = None
                fm[key] = _unquote(val)
    return fm, body_start


def _scalar(v):
    if isinstance(v, list):
        return str(v[0]).strip() if v else ""
    return str(v or "").strip()


def _rating_from(v):
    """rating: is sparse and loosely 1-5 with stray outliers ("6", 8, 10). Coerce to an int, clamp to 0..5 (0 = unrated) so a facet/stars UI
    never has to defend against garbage."""
    s = _scalar(v)
    m = re.match(r"^\s*(\d+)", s)
    if not m:
        return 0
    return max(0, min(5, int(m.group(1))))


def _source_type(v):
    """source-type: values are unnormalized across the library ("journal-article",
    "journal article", "journalArticle", "edited volume", ...). Fold to a stable
    kebab-case key so filtering by type actually groups them."""
    s = _scalar(v).strip().lower()
    if not s:
        return ""
    s = re.sub(r"(?<=[a-z])(?=[A-Z])", "-", _scalar(v).strip())   # camelCase -> camel-Case
    s = re.sub(r"[\s_]+", "-", s.strip().lower())
    s = re.sub(r"-{2,}", "-", s).strip("-")
    return {"journalarticle": "article", "journal-article": "article",
            "edited-volume": "edited-volume"}.get(s, s)


def _dewiki(s):
    """[[Target|Display]] / [[Target]] -> the display (or target) text."""
    return re.sub(r"\[\[([^\]|]+)(?:\|([^\]]*))?\]\]",
                  lambda m: (m.group(2) or m.group(1)).strip(), str(s or "")).strip()


def _author_str(v):
    items = v if isinstance(v, list) else ([v] if v else [])
    names = [_dewiki(a).strip().strip(",") for a in items]
    names = [n for n in names if n]
    if not names:
        return ""
    if len(names) == 1:
        return names[0]
    if len(names) == 2:
        return names[0] + " and " + names[1]
    return names[0] + " et al."


def _year_from(*vals):
    for v in vals:
        m = re.search(r"\b(1[6-9]\d\d|20\d\d)\b", _scalar(v))
        if m:
            return int(m.group(1))
    return None


_GENERIC_HOSTS = {"cdn", "sanity", "substackcdn", "amazonaws", "s3", "cloudfront",
                  "googleusercontent", "files", "media", "assets", "static", "img"}


def _org_from_source(url):
    """A no-author web clipping still needs an in-text author. Derive a publisher
    org from the URL's second-level domain (skip generic CDN/file hosts)."""
    m = re.search(r"https?://([^/\s]+)", url or "")
    if not m:
        return ""
    host = re.sub(r"^www\.", "", m.group(1).lower())
    parts = [p for p in host.split(".") if p]
    sld = parts[-2] if len(parts) >= 2 else (parts[0] if parts else "")
    if not sld or sld in _GENERIC_HOSTS:
        return ""
    return sld[:1].upper() + sld[1:]


# --------------------------------------------------------------------------- quote parsing
def _link_info(s):
    m = _WIKILINK.search(s)
    if not m:
        return None, None, None
    target, _, display = m.group(1).partition("|")
    page = None
    if display:
        pm = _PAGE_DISPLAY.search(display)
        if pm:
            page = _PAGE_RANGE.sub("-", pm.group(1))
    if not page:
        um = _PAGE_URL.search(target)
        if um:
            page = um.group(1)
    return page, target.strip(), display.strip()


def _display_quote(display):
    """Format where the quote IS the wikilink display text: |"the quoted sentence"."""
    d = (display or "").strip()
    m = _QUOTE_WRAP.match(d)
    return m.group(1).strip() if m else None


def _clean_quote(s):
    """A raw quote line -> clean quote text: drop wikilinks, leading list number,
    trailing (p.N), inline markdown, and surrounding quote marks."""
    s = _WIKILINK.sub("", s)
    s = _LEAD_NUM.sub("", s.strip())
    s = _PAGE_TRAIL.sub("", s).strip()
    s = _strip_md(s).strip()
    for _ in range(2):
        m = _QUOTE_WRAP.match(s)
        if not m:
            break
        s = m.group(1).strip()
    s = re.sub(r"^\(\s*\)", "", s).strip()      # leftover "()" from a stripped "([[...]])"
    s = re.sub(r"\(\s*\)$", "", s).strip()
    return s


def _tag_text(s):
    """A tag/label line -> a short retrieval label. '#a-b #c:' -> 'a-b, c'; 'label:' -> 'label'."""
    tags = _INLINE_TAG.findall(s)
    if tags:
        return ", ".join(tags[:6])
    return _strip_md(s)


def _looks_quote_start(s):
    return bool(s) and (s[0] in "\"'“‘" or bool(_LEAD_NUM.match(s)))


def _extract_quotes(qlines):
    quotes, cur_tag = [], None
    i, n = 0, len(qlines)
    while i < n and len(quotes) < MAX_QUOTES:
        s = qlines[i].strip()
        i += 1
        if not s:
            cur_tag = None
            continue
        has_link = "[[" in s
        is_bq = s.startswith(">")
        body = s[1:].strip() if is_bq else s
        page, target, display = _link_info(s) if has_link else (None, None, None)
        if not page:
            tm = _PAGE_TRAIL.search(body)
            if tm:
                page = _PAGE_RANGE.sub("-", tm.group(1))
        text = _clean_quote(body)

        if has_link and not text:
            # a link-only line: the prose is the following blockquote line(s), OR (no
            # following prose) the quote is the wikilink display itself.
            buf = []
            while i < n:
                ns = qlines[i].strip()
                if not ns.startswith(">"):
                    break
                inner = ns[1:].strip()
                if "[[" in inner and not _clean_quote(inner):
                    break                       # next quote's own link header — leave it
                nb = _clean_quote(inner)
                if nb:
                    buf.append(nb)
                i += 1
            if buf:
                quotes.append({"text": " ".join(buf)[:MAX_SNIPPET], "page": page,
                               "tag": cur_tag, "link": target})
                cur_tag = None
                continue
            dq = _display_quote(display)
            if dq:
                quotes.append({"text": dq[:MAX_SNIPPET], "page": page,
                               "tag": cur_tag, "link": target})
                cur_tag = None
            continue

        if is_bq and text:
            quotes.append({"text": text[:MAX_SNIPPET], "page": page,
                           "tag": cur_tag, "link": target})
            cur_tag = None
            continue

        if not is_bq:
            if _looks_quote_start(s) and text:
                quotes.append({"text": text[:MAX_SNIPPET], "page": page,
                               "tag": cur_tag, "link": target})
                cur_tag = None
            elif s.startswith("#") or s.endswith(":"):
                cur_tag = _tag_text(s)
            # else: free-standing commentary under a quote -> ignore
    return quotes


def records(here):
    d = _load(here)
    return (d or {}).get("records", [])


# --------------------------------------------------------------------------- parse a note
def _section_of(body, names):
    """Collect the lines under the first heading whose text startswith any of `names`."""
    out, grabbing = [], False
    for ln in body:
        hm = re.match(r"^#{1,6}\s+(.*?)\s*$", ln)
        if hm:
            low = hm.group(1).strip().lower()
            if grabbing:
                break
            grabbing = any(low.startswith(p) for p in names)
            continue
        if grabbing:
            out.append(ln)
    return out


def _parse(path, name, mtime=0):
    """A citation note (a read paper) -> a search record, or None on read error."""
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            text = f.read()
    except OSError:
        return None
    lines = text.split("\n")
    fm, body_start = _frontmatter(lines)

    stem = name[:-3] if name.endswith(".md") else name
    author = _author_str(fm.get("author"))
    title = _scalar(fm.get("title"))
    citekey = _scalar(fm.get("citekey"))
    source = _scalar(fm.get("source"))
    year = _year_from(fm.get("year"))
    alt_years = sorted({y for y in (_year_from(fm.get(k)) for k in
                                    ("year-print-issue", "year-print", "year-online"))
                        if y and y != year})
    status = _scalar(fm.get("status")).lower()
    if status == "reading" and _scalar(fm.get("claimed_by")):
        status = "unread"
    rating = _rating_from(fm.get("rating"))
    stype = _source_type(fm.get("source-type"))
    tags = [t.strip().strip("\"'#").lower() for t in (fm.get("tags") if isinstance(fm.get("tags"), list) else [])]
    tags = [t for t in tags if t and t not in STRUCTURAL_TAGS]

    body = lines[body_start:]
    # ## Citation (first paragraph after the heading)
    citation, cite_buf = "", []
    for ln in _section_of(body, ("citation",)):
        sln = ln.strip()
        if sln:
            cite_buf.append(sln)
        elif cite_buf:
            break
    if cite_buf:
        citation = _strip_md(" ".join(cite_buf))[:600]
    # ## Key Points (numbered claims)
    keypoints = []
    for ln in _section_of(body, ("key point", "key points")):
        nm = _NUMBERED.match(ln)
        if nm and len(keypoints) < MAX_KEYPOINTS:
            snip = _strip_md(nm.group(1))[:MAX_SNIPPET]
            if snip:
                keypoints.append(snip)
    # ## Quotes (robust extraction)
    quotes = _extract_quotes(_section_of(body, ("quote",)))

    archival = _scalar(fm.get("archival-citation"))
    hay = " ".join([author, str(year or ""), title, citekey, source, archival, " ".join(tags),
                    " ".join(keypoints), " ".join(q["text"] for q in quotes), citation]).lower()
    rel = "/".join(CIT_SUBDIR) + "/" + name
    intext, _src, doubt = citenames.label(stem, citation, fm.get("author"))
    return {"stem": stem, "rel": rel, "kind": "citation", "author": author, "year": year,
            "altYears": alt_years,
            "title": title, "citekey": citekey, "source": source, "tags": tags[:8],
            "status": status, "rating": rating, "sourceType": stype,
            "citation": citation, "keyPoints": keypoints, "quotes": quotes, "hay": hay,
            "intext": intext or author, "intextDoubt": doubt,
            "doi": _doi(fm.get("doi")), "doiVerified": bool(_scalar(fm.get("doi-verified"))),
            "mtime": int(mtime)}


def _parse_clipping(path, name, mtime=0):
    """A web/news clipping -> a citable search record (no PDF pages; body folds into
    the haystack so keyword search finds it by content)."""
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            text = f.read()
    except OSError:
        return None
    lines = text.split("\n")
    fm, body_start = _frontmatter(lines)

    stem = name[:-3] if name.endswith(".md") else name
    title = _scalar(fm.get("title")) or stem
    source = _scalar(fm.get("source"))
    citekey = _scalar(fm.get("citekey"))
    desc = _scalar(fm.get("description"))
    year = _year_from(fm.get("year"), fm.get("published"), fm.get("created"), fm.get("date"))
    author = _author_str(fm.get("author"))
    if not author:
        author = _org_from_source(source) or (title.split(" - ")[0].strip() if title else stem)
    tags = [t.strip().strip("\"'#").lower() for t in (fm.get("tags") if isinstance(fm.get("tags"), list) else [])]
    tags = [t for t in tags if t and t not in STRUCTURAL_TAGS]

    body = lines[body_start:]
    body_txt = _strip_md(_WIKILINK.sub(" ", "\n".join(body)))[:CLIP_HAY]
    # a hand-added `## Citation` line (the citeable-clipping protocol) is the authoritative
    # reference text; fall back to the assembled author/year/title for an un-enriched clip.
    citation = ""
    for ln in _section_of(body, ("citation",)):
        s = ln.strip()
        if s:
            citation = _strip_md(s)[:600]
            break
    if not citation:
        citation = "; ".join([x for x in (author, str(year or ""), title) if x])
    hay = " ".join([author, str(year or ""), title, source, desc, " ".join(tags), body_txt]).lower()
    rel = "/".join(CLIP_SUBDIR) + "/" + name
    # an enriched clipping resolves like a note; a bare save keeps its org fallback
    intext = ""
    if fm.get("author"):
        intext, _src, _doubt = citenames.label(stem, citation, fm.get("author"))
    return {"stem": stem, "rel": rel, "kind": "clipping", "author": author, "year": year,
            "title": title, "citekey": citekey, "source": source, "tags": tags[:8],
            "status": _scalar(fm.get("status")).lower(), "rating": 0, "sourceType": "clipping",
            "citation": citation, "keyPoints": [], "quotes": [], "hay": hay,
            "intext": intext or author, "intextDoubt": "",
            "doi": _doi(fm.get("doi")), "doiVerified": False,
            "mtime": int(mtime)}


def _doi(v):
    d = _scalar(v).strip().lower()
    d = re.sub(r"^https?://(dx\.)?doi\.org/", "", d)
    return d if d.startswith("10.") else ""


def _ntitle(t):
    t = citenames.fold(str(t or "")).lower()
    t = re.sub(r"[^a-z0-9 ]+", " ", t)
    t = re.sub(r"\s+", " ", t).strip()
    return re.sub(r"^(the|a|an) ", "", t)


def _finalize(records):
    for r in records:
        r.pop("dupOf", None)
        r.pop("suffix", None)
    live = [r for r in records if r.get("year")]
    par = {id(r): r for r in live}
    root = {id(r): id(r) for r in live}

    def find(i):
        while root[i] != i:
            root[i] = root[root[i]]
            i = root[i]
        return i

    def union(a, b):
        ra, rb = find(id(a)), find(id(b))
        if ra != rb:
            root[rb] = ra

    by = defaultdict(list)
    for r in live:
        lead = citenames._base(r.get("intext") or r.get("author") or "")
        by[(lead, r["year"])].append(r)
    for (lead, _y), rs in by.items():
        if len(rs) < 2:
            continue
        for i in range(len(rs)):
            for j in range(i + 1, len(rs)):
                a, b = rs[i], rs[j]
                da, db = a.get("doi"), b.get("doi")
                if da and db:
                    same = da == db          # two DOIs decide it, whatever the titles say
                else:
                    ta, tb = _ntitle(a.get("title")), _ntitle(b.get("title"))
                    short, long_ = sorted((ta, tb), key=len)
                    same = len(ta) > 12 and len(tb) > 12 and (
                        ta == tb or (long_.startswith(short) and len(short) > 15
                                     and long_[len(short)] == " "))
                if same:
                    union(a, b)
    groups = defaultdict(list)
    for r in live:
        groups[find(id(r))].append(r)
    for g in groups.values():
        if len(g) < 2:
            continue
        keep = max(g, key=lambda r: (r.get("kind") == "citation", bool(r.get("doiVerified")),
                                     r.get("status") == "read", len(r.get("quotes") or []),
                                     len(r.get("hay") or ""), r.get("rel") or ""))
        for r in g:
            if r is not keep:
                r["dupOf"] = keep.get("rel")

    same = defaultdict(list)
    for r in live:
        if not r.get("dupOf"):
            same[(citenames.key(r.get("intext") or ""), r["year"])].append(r)
    for (k, y), rs in same.items():
        if not k or len(rs) < 2:
            continue
        ys = str(y)
        held, used = {}, set()
        for r in rs:
            m = re.search(re.escape(ys) + r"([a-z])$", r.get("citekey") or "")
            if m and m.group(1) not in used:
                held[id(r)] = m.group(1)          # statcan2023b keeps 'b'
                used.add(m.group(1))
        free = (c for c in "abcdefghijklmnopqrstuvwxyz" if c not in used)
        for r in sorted(rs, key=lambda r: (_ntitle(r.get("title")), r.get("rel") or "")):
            r["suffix"] = held.get(id(r)) or next(free, "")


# --------------------------------------------------------------------------- build
def build(vault, here):
    """Incrementally (re)build the citation index over every SOURCE_DIRS tree.
    `vault`/`here` are Path objects. Returns the number of notes reindexed this run."""
    here = str(here)
    cache_path = os.path.join(here, CACHE_NAME)
    try:
        with open(cache_path, encoding="utf-8") as f:
            cache = json.load(f)
    except (OSError, ValueError):
        cache = {}
    if cache.get("__v__") != _VERSION:    # extraction logic changed -> rebuild all
        cache = {"__v__": _VERSION}

    present, reindexed = set(), 0
    for subdir, kind in SOURCE_DIRS:
        d = os.path.join(str(vault), *subdir)
        if not os.path.isdir(d):
            continue
        parse = _parse if kind in NOTE_KINDS else _parse_clipping
        with os.scandir(d) as it:
            for entry in it:
                if not entry.name.endswith(".md") or not entry.is_file():
                    continue
                if entry.name.startswith("_"):
                    continue
                key = kind + "|" + entry.name
                present.add(key)
                try:
                    mtime = int(entry.stat().st_mtime)
                except OSError:
                    continue
                ent = cache.get(key)
                if ent and ent.get("m") == mtime:
                    continue
                rec = parse(entry.path, entry.name, mtime)
                if rec is None:
                    continue
                rec["kind"] = kind          # historical notes parse as citations but stay their own lane
                rec["rel"] = "/".join(subdir) + "/" + entry.name
                cache[key] = {"m": mtime, "rec": rec}
                reindexed += 1
    for key in [k for k in cache if k != "__v__" and k not in present]:
        del cache[key]

    cache["__v__"] = _VERSION
    try:
        with open(cache_path, "w", encoding="utf-8") as f:
            json.dump(cache, f, ensure_ascii=False)
    except OSError:
        pass

    records = [dict(ent["rec"]) for key, ent in cache.items()
               if key != "__v__" and isinstance(ent, dict) and ent.get("rec")]
    _finalize(records)
    out = {"count": len(records), "records": records}
    with open(os.path.join(here, INDEX_NAME), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False)
    return reindexed


# --------------------------------------------------------------------------- load + search
_loaded = {"mtime": 0.0, "data": None}


def _load(here):
    p = os.path.join(str(here), INDEX_NAME)
    try:
        mtime = os.stat(p).st_mtime
    except OSError:
        return None
    if _loaded["data"] is None or mtime != _loaded["mtime"]:
        try:
            with open(p, encoding="utf-8") as f:
                _loaded["data"] = json.load(f)
            _loaded["mtime"] = mtime
        except (OSError, ValueError):
            return None
    return _loaded["data"]


_STOPWORDS = {"the", "a", "an", "of", "and", "or", "in", "on", "to", "for", "with",
              "by", "as", "at", "from", "is", "are", "be", "that", "this", "&",
              "et", "al", "its", "into", "about", "how", "why", "what", "when",
              "s", "vs", "vol", "no", "pp", "p"}


def search(here, query, cited=None, limit=50):
    d = _load(here)
    if not d:
        return []
    raw = [t for t in re.split(r"\s+", (query or "").strip().lower()) if t]
    strong = [t for t in raw if t not in _STOPWORDS and len(t) > 1]
    n = len(strong)
    need = n if n <= 3 else n - max(1, n // 3)
    need = max(1, need) if strong else 0
    cited = cited or set()
    hits = []
    for rec in d["records"]:
        if rec.get("dupOf"):            # a second copy of a work: its keeper answers
            continue
        hay = rec["hay"]
        if strong:
            matched = [t for t in strong if t in hay]
            if len(matched) < need:
                continue
        elif raw:                       # query was nothing but stopwords -> fall back to AND
            if not all(t in hay for t in raw):
                continue
            matched = raw
        else:                           # empty query -> everything (browse)
            matched = []
        lab = rec.get("intext") or rec["author"] or ""
        surname = re.split(r"\s+and\s+|\s+et al\.", lab.strip())[0].lower() if lab else ""
        already = bool(surname) and (surname, str(rec["year"] or "")) in cited
        author_l = rec["author"].lower()
        title_l = rec["title"].lower()
        citekey_l = rec["citekey"].lower()
        tags_l = " ".join(rec.get("tags") or []).lower()
        score = 0.0
        if already:
            score += 1000
        score += 4.0 * len(matched)      # coverage: matching more query tokens ranks higher
        for tok in strong:
            if tok in author_l:
                score += 10          # the queried name is an AUTHOR of this work
            if tok in title_l:
                score += 3           # mentioned in the title
            if tok in tags_l:
                score += 2           # a curated tag
            if tok in citekey_l:
                score += 2
        if strong and all(tok in author_l for tok in strong):
            score += 30
        score += (rec["year"] or 0) / 100000.0   # gentle recency tiebreak within a tier
        hits.append((score, {
            "stem": rec["stem"], "rel": rec["rel"], "kind": rec.get("kind", "citation"),
            "author": rec["author"], "year": rec["year"], "title": rec["title"],
            "intext": rec.get("intext") or rec["author"], "suffix": rec.get("suffix") or "",
            "citekey": rec["citekey"], "source": rec["source"], "tags": rec["tags"],
            "citation": rec["citation"], "keyPoints": rec["keyPoints"],
            "quotes": rec["quotes"], "alreadyCited": already,
            "status": rec.get("status"), "rating": rec.get("rating")}))
    hits.sort(key=lambda h: -h[0])
    return [h[1] for h in hits[:limit]]


def status(here):
    d = _load(here)
    if not d:
        return {"ready": False, "count": 0}
    return {"ready": True, "count": d.get("count", 0)}
