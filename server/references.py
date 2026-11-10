"""Reference engine for the Drafting/Publish flow — resolves ASA in-text cites,
builds the reference list in four styles, and emits the LaTeX bibliography."""
import settings
import json, os, re, time, unicodedata, tempfile
from pathlib import Path

PREFIX = settings.PROJECT_PREFIX
CIT_SUBDIR = ("Preparation", "Reading", "Citations")
INDEX_NAME = "citations-index.json"
RESOLVER_NAME = "resolver-index.json"
RESOLVER_V = 3
LIBRARY_BIB = ("Preparation", "Reading", "References", "library.bib")

STYLES = ("asa", "apa", "chicago", "mla")


def _norm_style(style):
    # normalize a requested style to a known one; unknown -> the default 'asa'
    # (so the style switcher can never silently write a mislabelled file).
    s = (style or "asa").lower().strip()
    return s if s in STYLES else "asa"


def _as_int(x):
    # tolerant int coercion for the concurrency token; None when truly unparseable
    # (a malformed base_mtime must not raise and crash the write handler).
    try:
        return int(x)
    except (TypeError, ValueError):
        try:
            return int(float(x))
        except (TypeError, ValueError):
            return None

_PARTICLES = {"van", "von", "de", "del", "della", "di", "da", "la", "le", "der",
              "den", "dos", "abu", "vander", "ten", "ter", "du", "dem", "st"}

_YEAR = r"(?:1[6-9]\d\d|20\d\d)"

# leading signal phrases inside a parenthetical cite: e.g., / i.e., / cf. / see (also) /
# "for a review, see" / "for reviews and meta-analyses, see"
_SIGNAL_RE = re.compile(
    r"^(?:(?:e\.g\.|i\.e\.|cf\.),?\s+|for\s+(?:an?\s+)?[\w\s-]{0,40}?,\s*see(?:\s+also)?\s+"
    r"|see(?:\s+also)?\s+|similar\s+to\s+)+", re.IGNORECASE)

_NAME_ATOM = (r"(?:\b(?i:" + "|".join(sorted(_PARTICLES, key=len, reverse=True))
              + r")\s+)*[A-Z][\w'’.\-]+")
_ETAL_TAIL = r"(?:\s+(?:et al\.?|and colleagues))?"


# --------------------------------------------------------------- small utils
def _read(p):
    # utf-8 read, replacement on bad bytes, None on OSError. mirror of drafting._read.
    try:
        return Path(p).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None


def _mt(p):
    # int-ms mtime, JS-Number safe, 0 on OSError.
    try:
        return int(round(Path(p).stat().st_mtime * 1000))
    except OSError:
        return 0


def _size(p):
    try:
        return int(Path(p).stat().st_size)
    except OSError:
        return 0


def _rel(vault, p):
    try:
        return str(Path(p).relative_to(vault)).replace("\\", "/")
    except ValueError:
        return ""


def _norm_match(s):
    # forgiving normalize for verbatim/malformation checks: unify smart punctuation,
    # collapse whitespace, lowercase.
    s = s or ""
    for a, b in (("“", '"'), ("”", '"'), ("‘", "'"), ("’", "'"),
                 ("–", "-"), ("—", "-"), ("…", "...")):
        s = s.replace(a, b)
    return re.sub(r"\s+", " ", s).strip().lower()


def _fold(s):
    # NFKD-fold diacritics for MATCH keys only (rendered text keeps the original).
    s = unicodedata.normalize("NFKD", s or "")
    return "".join(c for c in s if not unicodedata.combining(c))


def _norm_key(surname):
    # lead-surname match key: fold diacritics, lowercase, strip to [a-z].
    return re.sub(r"[^a-z]", "", _fold(surname).lower())


def _lead_surname_phrase(name):
    toks = [t for t in re.split(r"\s+", (name or "").strip()) if t]
    if not toks:
        return ""
    out = []
    i = 0
    while i < len(toks):
        t = toks[i]
        out.append(t)
        if _norm_key(t) in _PARTICLES and i + 1 < len(toks):
            i += 1
            continue
        break
    # out now holds [particle*, head]; but the loop above appends then breaks on a
    # non-particle, so it already includes the head token.
    return " ".join(out)


def _record_lead_key(author):
    a = (author or "").strip()
    if not a:
        return ""
    first = re.split(r",| and | & | et al", a, maxsplit=1)[0].strip()
    phrase = _lead_surname_phrase(first)
    return _norm_key(phrase)


# ----------------------------------------------------------------- cite tokenize
_GEO_QUAL = {"north", "south", "east", "west", "united", "new", "latin", "saudi",
             "costa", "sri", "hong", "great", "northern", "southern", "central",
             "middle", "puerto", "el", "san"}
_FULLNAME_NARR = re.compile(
    r"([A-Z][\w'’.\-]*(?:\s+[A-Z][\w'’.\-]*)+)"
    r"((?:(?:,?\s+and|\s*&|,)\s+[A-Z][\w'’.\-]*(?:\s+[A-Z][\w'’.\-]*)+)+)"
    r"\s+\((" + _YEAR + r"[a-z]?(?:,\s*" + _YEAR + r"[a-z]?)*)(?::[^)]*)?\)")


def _trailing_surname(name):
    toks = [t for t in re.split(r"\s+", (name or "").strip()) if t]
    if not toks:
        return ""
    i = len(toks) - 1
    out = [toks[i]]
    while i - 1 >= 0 and _norm_key(toks[i - 1]) in _PARTICLES:
        i -= 1
        out.insert(0, toks[i])
    return " ".join(out)


_MONTHS = frozenset((
    "january february march april may june july august september october november december "
    "jan feb mar apr jun jul aug sept sep oct nov dec"
).split())
_DAYNUM = re.compile(r"^(?:[1-9]|[12]\d|3[01])$")
_REGION_WORDS = frozenset(
    "europe asia africa antarctica oceania eurasia scandinavia americas".split())


def _looks_like_citation_name(name):
    n = re.sub(r"[*_`\\]", "", name or "").strip()          # strip markdown emphasis/code
    if not n:
        return False
    if re.match(r"(?:Figure|Table|Appendix|Panel)\s+[A-Z]?\d", n):
        return False
    lead = re.split(r",| and | & | et al", n, maxsplit=1)[0].strip()
    lead = re.sub(r"['’]s\b", "", lead).strip()             # drop a possessive
    lw = lead.split()
    if len(lw) == 1 and _norm_key(lw[0]) in _REGION_WORDS:  # bare 'Europe'/'Asia' = fragment
        return False
    phrase = _lead_surname_phrase(lead)
    toks = phrase.split()
    head = toks[-1] if toks else ""                         # the surname word itself
    if not head or not re.match(r"[A-Z]", head):            # real surnames/orgs are capitalized
        return False
    if re.search(r"[=%\d]", head):                          # 'N = 1,234' and other numeric stats
        return False
    if "=" in n:                                            # 'N = 1,234' (spaced
        return False                                        # form the head check misses)
    if _norm_key(head) in _MONTHS:
        if lead.strip() == n.strip():
            return False
    nt = n.split()                                          # 'November 30' is a date, not a cite
    for i in range(len(nt) - 1):
        if _norm_key(nt[i]) in _MONTHS and _DAYNUM.match(nt[i + 1].strip(",.")):
            return False
    return True


def extract_cites(para):
    # re-implemented ASA tokenizer: parenthetical groups split on ';', plus narrative
    # Author (Year[,Year]). Returns "Name Year[suffix]" tokens in source order, deduped.
    out, seen = [], set()

    def add(name, year):
        name = (name or "").strip().rstrip(",").strip()
        if not name:
            return
        if not _looks_like_citation_name(name):            # reject stats / dates / markdown
            return
        tok = name + " " + year
        k = tok.lower()
        if k not in seen:
            seen.add(k)
            out.append(tok)

    para = para or ""
    for grp in re.findall(r"\(([^()]+)\)", para):
        if not re.search(r"\b" + _YEAR + r"[a-z]?\b", grp):
            continue
        for part in grp.split(";"):
            part = _SIGNAL_RE.sub("", part.strip())
            m = re.search(r"^(.*?)\s+(" + _YEAR + r"[a-z]?)\b", part.strip())
            if not m:
                continue
            name = m.group(1)
            if "=" in name:
                chunks = name.split(",")
                while chunks and (("=" in chunks[0])
                                  or re.fullmatch(r"\s*[\d.\s%]*\s*", chunks[0])):
                    chunks.pop(0)
                name = ",".join(chunks).strip().lstrip(",").strip()
            if not re.search(r"[A-Z][a-z]", name) or re.search(r"\b" + _YEAR + r"\b", name):
                continue
            add(name, m.group(2))
            more = re.match(r"(?::\s*[\d\-–]+)?((?:\s*,\s*" + _YEAR + r"[a-z]?(?::\s*[\d\-–]+)?\b)+)",
                            part.strip()[m.end():])
            if more:
                for yr in re.findall(_YEAR + r"[a-z]?", more.group(1)):
                    add(name, yr)
    def _mask(m):
        inner = m.group(1)
        ym = re.search(r"\b" + _YEAR + r"[a-z]?\b", inner)
        if ym and re.search(r"[A-Za-z]", inner[:ym.start()]):
            return "(" + " " * len(inner) + ")"   # author-bearing cite -> blank inside
        return m.group(0)                          # bare (Year) -> keep for narrative
    masked = re.sub(r"\(([^()]+)\)", _mask, para)
    _mlist = list(masked)
    for m in _FULLNAME_NARR.finditer(masked):
        a1 = m.group(1).strip()
        if re.match(r"^(and|to|or|the|in|of|at|by|for|with|on)\b", a1, re.I):
            continue
        if _norm_key(a1.split()[0]) in _GEO_QUAL:
            continue
        surn = _trailing_surname(a1)
        for yr in re.findall(_YEAR + r"[a-z]?", m.group(3)):
            add(surn, yr)
        for i in range(m.start(), m.end()):
            _mlist[i] = " "
    masked = "".join(_mlist)
    for m in re.finditer(
            r"(" + _NAME_ATOM + r"(?:(?:,(?: and| &)?| and| &| et al\.)\s+"
            + _NAME_ATOM + r")*" + _ETAL_TAIL + r")\s+\(("
            # optional ':page' inside the paren — see _FULLNAME_NARR above.
            + _YEAR + r"[a-z]?(?:,\s*" + _YEAR + r"[a-z]?)*)(?::[^)]*)?\)", masked):
        name = m.group(1).strip()
        if re.match(r"^(and|to|or|the|in|of)\b", name, re.I):
            continue
        for yr in re.findall(_YEAR + r"[a-z]?", m.group(2)):
            add(name, yr)
    return out


def parse_cite_token(tok):
    raw = (tok or "").strip()
    page = None
    # strip page forms: ':12', ', p. 12', ' (p. 12)', ', pp. 12-15'
    pg = re.search(r"\s*(?::\s*(\d+(?:[-–]\d+)?)|,?\s*pp?\.?\s*(\d+(?:[-–]\d+)?))\s*$", raw)
    if pg:
        page = pg.group(1) or pg.group(2)
        raw = raw[:pg.start()].strip()
    m = re.search(r"^(.*?)\s+(" + _YEAR + r")([a-z])?\s*$", raw)
    if not m:
        return {"surname": "", "coauthors": [], "year": "", "suffix": "",
                "page": page, "etal": False, "raw": tok}
    namepart, year, suffix = m.group(1).strip(), m.group(2), (m.group(3) or "")
    # possessive strip on the whole name part
    namepart = re.sub(r"['’]s\b", "", namepart)
    _ETAL_WORDS = r"\bet al\.?|\band colleagues\b"
    etal = bool(re.search(_ETAL_WORDS, namepart))
    namepart = re.sub(_ETAL_WORDS, "", namepart).strip().rstrip(",").strip()
    namepart = re.sub(r"\s+and\s*$", "", namepart).strip().rstrip(",").strip()
    # split spelled-out authors on ' and ', ' & ', ','
    chunks = [c.strip() for c in re.split(r",| and | & ", namepart) if c.strip()]
    lead = chunks[0] if chunks else ""
    lead_phrase = _lead_surname_phrase(lead)
    coauthors = []
    for c in chunks[1:]:
        ck = _norm_key(_lead_surname_phrase(c))
        if ck:
            coauthors.append(ck)
    return {"surname": lead_phrase, "coauthors": coauthors, "year": year,
            "suffix": suffix, "page": page, "etal": etal, "raw": tok}


def cited_pairs(text):
    # set of (lead-surname-key, year) over the whole paper — feeds resolution + dedup.
    pairs = set()
    for tok in extract_cites(text or ""):
        d = parse_cite_token(tok)
        if d["surname"] and d["year"]:
            pairs.add((_norm_key(d["surname"]), d["year"]))
    return pairs


# --------------------------------------------------------------- resolver index
def build_resolver_index(here):
    here = Path(here)
    src = here / INDEX_NAME
    txt = _read(src)
    if txt is None:
        raise FileNotFoundError(str(src))
    data = json.loads(txt)              # JSONDecodeError -> ValueError, handled upstream
    mp = {}
    for r in data.get("records", []):
        author = (r.get("author") or "").strip()
        year = r.get("year")
        if not author or not year or r.get("dupOf"):
            continue
        intext = (r.get("intext") or author).strip()
        key = _record_lead_key(intext) + "|" + str(year)
        slim = {"citekey": r.get("citekey", ""), "rel": r.get("rel", ""),
                "stem": r.get("stem", ""), "author": author, "intext": intext,
                "suffix": r.get("suffix", ""),
                "title": r.get("title", ""), "year": year}
        mp.setdefault(key, []).append(slim)
        for alt in r.get("altYears") or []:
            akey = _record_lead_key(intext) + "|" + str(alt)
            if not any(x.get("rel") == slim["rel"] for x in mp.get(akey, [])):
                mp.setdefault(akey, []).append(dict(slim, year=alt, yearOf=year))
    cache = {"v": RESOLVER_V, "src": INDEX_NAME, "src_mtime": _mt(src),
             "src_size": _size(src), "built": int(time.time() * 1000), "map": mp}
    _write_json(here / RESOLVER_NAME, cache)
    return mp


def load_resolver_index(here):
    here = Path(here)
    src = here / INDEX_NAME
    cache_p = here / RESOLVER_NAME
    cur_mt, cur_sz = _mt(src), _size(src)
    cached = None
    ctxt = _read(cache_p)
    if ctxt is not None:
        try:
            c = json.loads(ctxt)
            if c.get("v") == RESOLVER_V and isinstance(c.get("map"), dict):
                cached = c
        except ValueError:
            cached = None
    fresh = (cached is not None
             and cached.get("src_mtime") == cur_mt
             and cached.get("src_size") == cur_sz)
    if fresh:
        return cached["map"]
    # drift (or no cache): rebuild, but never poison the cache on a partial source.
    try:
        return build_resolver_index(here)
    except (ValueError, FileNotFoundError, OSError):
        if cached is not None:
            return cached["map"]        # serve stale-but-valid, leave cache file intact
        raise


# ----------------------------------------------------------------- in-text resolve
def _multi_author(author):
    # does a note's author field record more than one name?
    return bool(re.search(r"\bet al\.?|\band\b|&|,", (author or "").strip()))


def _coauthors_match(tok, rec):
    auth = _norm_key(rec.get("author", "") + " " + (rec.get("intext") or ""))
    return all(c in auth for c in tok.get("coauthors", []))


def _coauthors_contradict(tok, rec):
    initials = r"(?:[A-Z]\.?[\s-]*)+"
    # the cite's co-author surnames, re-read from the raw token so APA initials
    # ('Fakename, A.M., Placeholder, C.J.') never count as co-authors
    namepart = re.sub(r"\s+" + _YEAR + r"[a-z]?.*$", "", tok.get("raw") or "")
    namepart = re.sub(r"['’]s\b", "", namepart)
    tchunks = [c.strip() for c in re.split(r",| and | & ", namepart) if c.strip()][1:]
    want = [_norm_key(_lead_surname_phrase(c)) for c in tchunks
            if not re.fullmatch(initials, c) and not re.search(r"\bet al", c)]
    want = [w for w in want if w]
    if not want:
        return False
    intext = rec.get("intext") or ""
    auth = rec.get("author", "") or ""
    if intext and not _multi_author(intext) and not _multi_author(auth):
        return True                   # a two-name cite never denotes a solo work
    if (len(want) == 1 and not tok.get("etal") and intext.endswith("et al.")
            and not re.search(r"\band\b|&|;", auth)):
        return True                   # nor a work of three or more authors
    chunks = [c.strip() for c in re.split(r",|;| and | & ", auth) if c.strip()]
    named = [c for c in chunks if not re.search(r"\bet al", c) and not re.fullmatch(initials, c)]
    if len(named) < 2:
        return False
    hay = _norm_key(auth + " " + intext)

    def _has(w):
        if w in hay:
            return True
        for p in sorted(_PARTICLES, key=len, reverse=True):
            if w.startswith(p) and len(w) > len(p) + 2 and w[len(p):] in hay:
                return True
        return False
    return not all(_has(w) for w in want)


def cite_pattern(tok):
    """'solo' | 'co:<second surname key>' | 'etal' for a parsed cite token."""
    co = tok.get("coauthors") or []
    if tok.get("etal") or len(co) >= 2:
        return "etal"
    if len(co) == 1:
        return "co:" + co[0]
    return "solo"


def _rec_pattern(rec):
    """'solo' | 'two' | 'two?' (two, or more the label hides) | 'etal' for an index record, or None when it does not
    say (a lead-only author field with no in-text label)."""
    intext = (rec.get("intext") or "").strip()
    auth = (rec.get("author") or "").strip()
    lab = intext or auth
    if re.search(r"\bet al", lab):
        return "etal"
    if re.search(r"\band\b|&", lab):
        names = [c for c in re.split(r",| and | & ", lab) if c.strip()]
        if len(names) >= 3:
            return "etal"
        if auth.count(",") >= 2 or auth.count(";") >= 2:
            return "two?"
        return "two"
    if intext and not re.search(r"\band\b|&|;|\bet al", auth):
        return "solo"
    return None


def _pattern_contradicts(tok, rec):
    """True when the cite's author pattern cannot denote this record's work."""
    rp = _rec_pattern(rec)
    if rp is None:
        return False
    tp = cite_pattern(tok)
    if tp == "etal":
        return rp not in ("etal", "two?")
    if tp == "solo":
        return rp != "solo"
    return rp not in ("two", "two?")


def resolve_one(tok, idx):
    # lookup '<key-surname>|<year>' (suffix ignored for the key); classify
    # resolved / unresolved / ambiguous. Never auto-picks hit[0].
    skey = _norm_key(tok.get("surname", ""))
    year = tok.get("year", "")
    if not skey or not year:
        return {"status": "unresolved", "token": tok}
    cands = idx.get(skey + "|" + year, [])
    if not cands:
        return {"status": "unresolved", "token": tok}
    # the author pattern narrows first: only works with the cite's shape can match
    cands = [c for c in cands if not _pattern_contradicts(tok, c)]
    if not cands:
        return {"status": "unresolved", "token": tok}
    if len(cands) == 1:
        c = cands[0]
        if tok.get("coauthors") and _coauthors_contradict(tok, c):
            return {"status": "unresolved", "token": tok}
        return {"status": "resolved", "citekey": c["citekey"], "rel": c["rel"],
                "stem": c["stem"], "suffix": c.get("suffix", ""), "token": tok}

    pool = cands
    narrowed = []
    if tok.get("coauthors"):
        narrowed = [c for c in pool if _coauthors_match(tok, c)]
        if narrowed:
            pool = narrowed
    if len(pool) == 1:
        c = pool[0]
        return {"status": "resolved", "citekey": c["citekey"], "rel": c["rel"],
                "stem": c["stem"], "suffix": c.get("suffix", ""), "token": tok}
    if narrowed and not tok.get("etal"):
        spelled = [c for c in pool if not (c.get("intext") or "").endswith("et al.")]
        if len(spelled) == 1:
            c = spelled[0]
            return {"status": "resolved", "citekey": c["citekey"], "rel": c["rel"],
                    "stem": c["stem"], "suffix": c.get("suffix", ""), "token": tok}
    if not tok.get("coauthors") and not tok.get("etal"):
        solo = [c for c in pool if not _multi_author(c.get("intext") or c.get("author", ""))]
        if len(solo) == 1:
            c = solo[0]
            return {"status": "resolved", "citekey": c["citekey"], "rel": c["rel"],
                    "stem": c["stem"], "suffix": c.get("suffix", ""), "token": tok}
    if tok.get("etal") and not tok.get("coauthors"):
        three = [c for c in pool if (c.get("intext") or "").endswith("et al.")]
        if len(three) == 1:
            c = three[0]
            return {"status": "resolved", "citekey": c["citekey"], "rel": c["rel"],
                    "stem": c["stem"], "suffix": c.get("suffix", ""), "token": tok}
    suf = tok.get("suffix", "")
    if suf:
        sm = [c for c in pool if c.get("suffix") == suf]
        if len(sm) != 1:
            sm = [c for c in pool if c["citekey"].lower().rstrip().endswith(str(tok["year"]) + suf)]
        if len(sm) == 1:
            c = sm[0]
            return {"status": "resolved", "citekey": c["citekey"], "rel": c["rel"],
                    "stem": c["stem"], "suffix": c.get("suffix", ""), "token": tok}
    cks = {c["citekey"] for c in pool if c.get("citekey")}
    if len(cks) == 1 and len({_norm_match(c.get("title", "")) for c in pool}) == 1:
        c = pool[0]
        return {"status": "resolved", "citekey": c["citekey"], "rel": c["rel"],
                "stem": c["stem"], "suffix": c.get("suffix", ""), "token": tok}
    # still ambiguous: surface ALL candidates (incl. same-citekey/different-rel works)
    # for human a/b disambiguation. Never silently pick one.
    return {"status": "ambiguous", "token": tok,
            "candidates": [{"citekey": c["citekey"], "rel": c["rel"],
                            "stem": c["stem"], "title": c["title"],
                            "author": c["author"]} for c in pool]}


def _resolve_trimmed(raw, idx, max_drop=6):
    words = raw.split()
    surnames = {k.split("|", 1)[0] for k in idx} if isinstance(idx, dict) else set()

    def _droppable(prefix):
        if prefix[-1] in ("&", "and"):
            return False
        if any(re.search(r"\d", w) or w[:1].islower() for w in prefix):
            return True
        if all(re.fullmatch(r"[A-Z]\.", w) for w in prefix):
            return True
        return all(_norm_key(w.strip(",")) not in surnames for w in prefix)

    for k in range(1, min(max_drop, len(words) - 2) + 1):
        rest = " ".join(words[k:]).lstrip(",").strip()
        if not re.match(r"[A-Z]", rest) or not _droppable(words[:k]):
            continue
        name = re.sub(r"\s+" + _YEAR + r"[a-z]?.*$", "", rest)
        if not _looks_like_citation_name(name):
            continue
        r = resolve_one(parse_cite_token(rest), idx)
        if r["status"] == "resolved":
            return r
    return None


def resolve_cites(text, idx):
    # feature-1 driver: tokenize the whole text, resolve each unique token, return
    # link payloads for resolved + flags for unresolved/ambiguous.
    resolved, unresolved, ambiguous = [], [], []
    seen = set()
    for raw in extract_cites(text or ""):
        tok = parse_cite_token(raw)
        dedup = (_norm_key(tok["surname"]),
                 tuple(_norm_key(c) for c in (tok.get("coauthors") or [])),
                 bool(tok.get("etal")), tok["year"], tok["suffix"])
        if dedup in seen:
            continue
        seen.add(dedup)
        r = resolve_one(tok, idx)
        if r["status"] == "unresolved":
            r = _resolve_trimmed(raw, idx) or r
        if r["status"] == "resolved":
            resolved.append({"token": raw, "citekey": r["citekey"], "rel": r["rel"],
                             "stem": r["stem"], "page": tok["page"],
                             "suffix": r.get("suffix", "")})
        elif r["status"] == "ambiguous":
            ambiguous.append({"token": raw, "candidates": r["candidates"]})
        else:
            unresolved.append(raw)
    return {"resolved": resolved, "unresolved": unresolved, "ambiguous": ambiguous}


def intext_display(tok, style="asa"):
    d = tok if isinstance(tok, dict) else parse_cite_token(tok)
    base = (d["surname"] + " " + d["year"] + d["suffix"]).strip()
    if d.get("page"):
        sep = ", " if style == "chicago" else ":"
        base = base + sep + d["page"]
    return "(" + base + ")"


# ----------------------------------------------------------------- note reading
def _cit_path(vault, rel):
    # confined resolve of a Citations note rel (mirrors drafting._source_ok, Citations
    # tree only). Rejects '..'/absolute/other-tree.
    rel = (rel or "").replace("\\", "/").strip().lstrip("/")
    if not rel or ".." in rel.split("/") or "\x00" in rel or not rel.endswith(".md"):
        return None
    try:
        p = (Path(vault) / rel).resolve()
    except OSError:
        return None
    cit = (Path(vault) / Path(*CIT_SUBDIR)).resolve()
    try:
        p.relative_to(cit)
    except ValueError:
        return None
    return p if p.is_file() else None


def raw_citation_line(vault, rel):
    p = _source_note_path(vault, rel)
    if p is None:
        return None
    txt = _read(p)
    if txt is None:
        return None
    txt = txt.replace("\r\n", "\n").replace("\r", "\n")
    m = re.search(r"^#{1,6}\s*Citation\s*$", txt, re.M)
    if not m:
        return None
    for ln in txt[m.end():].split("\n"):
        s = ln.strip()
        if s.startswith("#"):
            break          # next heading, block was empty
        if s:
            return re.sub(r"\s+", " ", s)
    return None


# keep raw_citation_line discoverable under the spec's alternate name
_read_citation_line = raw_citation_line


# ----------------------------------------------------------------- library.bib bridge
_BIB_TYPE_RE = re.compile(r"^@(\w+)\s*\{\s*([^,\s]+)", re.M)
_BIB_SRC_RE = re.compile(r"%\s*vault-source\s*=\s*(.+?)\s*$", re.M)


def load_bib_types(vault):
    # citekey -> {bibtype, rel} from library.bib, using the '% vault-source' comment.
    # Read-only from its absolute path (NOT under the confined Citations tree).
    p = Path(vault) / Path(*LIBRARY_BIB)
    txt = _read(p)
    out = {}
    if txt is None:
        return out
    # split on entry boundaries
    for m in re.finditer(r"@(\w+)\s*\{\s*([^,\s]+)\s*,(.*?)(?=\n@|\Z)", txt, re.S):
        bibtype, citekey, body = m.group(1).lower(), m.group(2).strip(), m.group(3)
        sm = _BIB_SRC_RE.search(body)
        rel = sm.group(1).strip().replace("\\", "/") if sm else ""
        out[citekey] = {"bibtype": bibtype, "rel": rel}
    return out


# ----------------------------------------------------------------- ASA-line parsing
def _detect_format(line):
    if re.search(r"\(\s*" + _YEAR + r"[a-z]?\s*\)\s*\.", line or ""):
        return "apa"
    return "asa"


_ASA_YEAR_SLOT = (r"(?:\[\s*(" + _YEAR + r")\s*\]\s*)?(" + _YEAR + r")([a-z])?"
                  r"(?:\s*[-–]\s*\d{2,4})?")


def _split_authors_year(line):
    fmt = _detect_format(line)
    if fmt == "apa":
        m = re.search(r"^(.*?)\s*\(\s*(" + _YEAR + r")([a-z])?\s*\)\s*\.\s*(.*)$", line)
        if m:
            return (m.group(1).strip(), m.group(2), m.group(3) or "", m.group(4).strip())
        return ("", "", "", "")
    m = re.search(r"^(.*?)\.\s*" + _ASA_YEAR_SLOT + r"\s*\.\s*(.*)$", line or "")
    if not m:
        return ("", "", "", "")
    return (m.group(1).strip(), m.group(3), m.group(4) or "", m.group(5).strip())


def _orig_year(line):
    # the bracketed original year of an ASA line ("[1848] 1973" -> "1848"), or ''.
    m = re.search(r"^(.*?)\.\s*" + _ASA_YEAR_SLOT + r"\s*\.", line or "")
    return (m.group(2) or "") if m else ""


def asa_entry_defects(line):
    s = (line or "").strip()
    out = []
    if "[INCOMPLETE" in s or "[UNVERIFIED" in s:
        out.append("marker")
    stamps = re.findall(r"(?:^|\.\s)(?:\[\s*" + _YEAR + r"\s*\]\s*)?" + _YEAR +
                        r"[a-z]?(?:\s*[-–]\s*\d{2,4})?\.\s", s)
    if len(stamps) > 1 or re.search(r"[^.\s]\.\.(?!\.)", s):
        out.append("run-together")
    authors_str, year, _suf, _rest = _split_authors_year(s)
    if year:
        toks = authors_str.split()
        if (len(toks) == 1 and "," not in authors_str and not authors_str.isupper()
                and re.match(r"^[A-ZÀ-Þ][a-zß-ÿ'’\-]+$", authors_str)):
            out.append("no-given-name")
    # each *italic* span on its own: a span running from one title's closing star to
    # the next title's opening star is not a title
    if any(re.search(r"\.\s+[A-Z][^:.]*:\s*\S", span) for span in re.findall(r"\*([^*]+)\*", s)):
        out.append("publisher-in-title")
    if re.search(r"\s\.\s\.\.(?!\.)", s):
        out.append("run-together")     # a spaced ellipsis with a stop glued on: ". .."
    return out


def _parse_authors(authors_str):
    s = (authors_str or "").strip().rstrip(",").strip()
    if not s:
        return []
    # peel the final author off the LAST "and" / ", and" joiner
    last = None
    ands = list(re.finditer(r",?\s+and\s+", s))
    if ands:
        last = s[ands[-1].end():].strip()
        s = s[:ands[-1].start()].strip().rstrip(",").strip()
    fields = [f.strip() for f in s.split(",") if f.strip()]
    authors = []
    if len(fields) == 1:
        authors.append(fields[0])                    # lone "Surname" / corporate author
    elif len(fields) >= 2:
        authors.append(fields[0] + ", " + fields[1])  # inverted first author "Surname, Given"
        authors += fields[2:]                          # remaining are natural-order "Given Surname"
    if last:
        authors.append(last)
    return [a for a in authors if a]


def _parse_asa_fields(asa_line, fm, bibtype):
    line = (asa_line or "").strip()
    fm = fm or {}
    fields = {"authors": [], "year": "", "suffix": "", "title": "", "container": "",
              "vol": "", "issue": "", "pages": "", "city": "", "publisher": "",
              "editor": "", "edition": "", "kind": "", "doi": "", "raw": line,
              "orig_year": "", "translator": "",
              "missing": [], "complete": True}

    if line:
        authors_str, year, suffix, rest = _split_authors_year(line)
        fields["authors"] = _parse_authors(authors_str)
        fields["year"] = year or str(fm.get("year", "") or "")
        fields["suffix"] = suffix
        fields["orig_year"] = _orig_year(line) if year else ""
        # quoted title => article/chapter; italic-only => book.
        qm = re.search(r'"([^"]+?)\.?"\s*(.*)$', rest)
        im = re.search(r"\*(.+?)\*", rest)
        if qm:
            fields["title"] = qm.group(1).strip()
            if re.search(r"\s\.\s\.$", fields["title"]):
                fields["title"] += " ."    # a spaced ellipsis ending the title stays whole
            tail = qm.group(2).strip()
            fields["kind"] = "chapter" if re.match(r"^Pp?\.", tail) else "article"
            cm = re.search(r"\*(.+?)\*", tail)
            if cm:
                fields["container"] = cm.group(1).strip()
            vm = re.search(r"(\d+)\s*\(([\dA-Za-z/\-–]+)\)\s*:\s*([\dA-Za-z\-–]+)", tail)
            if vm:
                fields["vol"], fields["issue"], fields["pages"] = vm.group(1), vm.group(2), vm.group(3)
            else:
                vm2 = re.search(r"\*\s*(\d+)\s*:\s*([\dA-Za-z\-–]+)", tail)
                if vm2:
                    fields["vol"], fields["pages"] = vm2.group(1), vm2.group(2)
            tail = re.sub(r"\s*(?:https?://(?:dx\.)?doi\.org/|doi:\s*)\S+\s*$", "", tail)
            cipm = re.search(r"\.\s*([^.:]+?):\s*([^.]+?)\.\s*$", tail)
            if fields["kind"] == "chapter" and cipm:
                fields["city"], fields["publisher"] = cipm.group(1).strip(), cipm.group(2).strip()
            if fields["kind"] == "chapter":
                # chapter page range "Pp. 395-415 in ..." (the article vol/issue regex
                # above never matches it) and the "edited by ..." editor segment.
                ppm = re.match(r"^Pp?\.\s*([\d]+(?:\s*[-–]\s*[\dA-Za-z]+)?)", tail)
                if ppm:
                    fields["pages"] = re.sub(r"\s*", "", ppm.group(1))
                edm = re.search(r"edited by\s+(.+?)\.(?=\s+[^.:]+:|\s*$)", tail)
                if edm:
                    fields["editor"] = edm.group(1).strip()
        elif im:
            fields["title"] = im.group(1).strip()
            fields["kind"] = "book"
            tail = rest[im.end():]
            tail = re.sub(r"\s*(?:https?://(?:dx\.)?doi\.org/|doi:\s*)\S+\s*$", "", tail)
            # a translated book keeps its translator (ASA: "Title. Translated by X.")
            trm = re.search(r"[Tt]ranslated(?: from the [A-Z][a-z]+)? by\s+(.+?)\.(?=\s+[A-Z0-9]|\s*$)", tail)
            if trm:
                fields["translator"] = trm.group(1).strip().rstrip(",")
            cpm = re.search(r"\.\s*([^.:]+?):\s*([^.]+?)\.?\s*$", tail)
            if cpm:
                fields["city"], fields["publisher"] = cpm.group(1).strip(), cpm.group(2).strip()
        else:
            fields["title"] = re.sub(r"\.\s*$", "", rest).strip()
            fields["kind"] = (bibtype or "").lower() or "misc"
            st0 = str(fm.get("source-type", "") or "").lower()
            if "book" in st0 or (bibtype or "").lower() == "book":
                bpm = re.match(r"^(.+?)\.\s+([A-Z][^.:]*?):\s*([^.]+?)\.?\s*$", rest)
                if bpm:
                    fields["title"] = bpm.group(1).strip()
                    fields["city"], fields["publisher"] = bpm.group(2).strip(), bpm.group(3).strip()
                fields["kind"] = "book"
        dm = re.search(r"\b(10\.\d{4,}/\S+)", rest)
        if dm:
            fields["doi"] = dm.group(1).rstrip(".")
        edn = re.search(r"\*[^*]+\*[.,]?\s*((?:\d+(?:st|nd|rd|th)|Rev\.|Revised|Enlarged|"
                        r"Expanded|Abridged|Updated|Rev\. and enl\.|Rev\. and exp\.)\s+ed\.)",
                        rest)
        if edn and fields["kind"] in ("book", "chapter"):
            fields["edition"] = edn.group(1)

    # frontmatter backstop for the structural primaries
    if not fields["title"]:
        fields["title"] = str(fm.get("title", "") or "").strip()
    if not fields["year"]:
        fields["year"] = str(fm.get("year", "") or "").strip()
    if not fields["authors"] and fm.get("author"):
        fields["authors"] = [str(fm["author"]).strip()]
    st = str(fm.get("source-type", "") or "").lower()
    if not fields["kind"]:
        # source-type / bibtype hint
        if "book" in st or bibtype == "book":
            fields["kind"] = "book"
        elif "chapter" in st or bibtype == "incollection":
            fields["kind"] = "chapter"
        else:
            fields["kind"] = "article" if bibtype == "article" else "misc"

    if any(w in st for w in ("report", "preprint", "working", "thesis", "web", "dataset")):
        fields["kind"] = "misc"

    _fm_src = str(fm.get("source", "") or fm.get("journal", "") or "").strip()
    if (fields["kind"] == "book" and _fm_src and fm.get("title")
            and fields["title"].strip().lower() == _fm_src.lower()):
        fields["kind"] = "article"
        fields["title"] = str(fm.get("title", "")).strip()
        fields["container"] = _fm_src
        fields["publisher"] = ""

    def _fmv(*keys):
        for k in keys:
            v = str(fm.get(k, "") or "").strip()
            if v:
                return v
        return ""
    if not fields["container"]:
        if fields["kind"] == "article":
            fields["container"] = _fmv("source", "journal", "container")
        elif fields["kind"] == "chapter":
            fields["container"] = _fmv("book", "book-title", "container")
    if not fields["vol"]:
        fields["vol"] = _fmv("volume", "vol")
    if not fields["issue"]:
        fields["issue"] = _fmv("issue", "number")
    if not fields["pages"]:
        fields["pages"] = _fmv("pages")
        if not fields["pages"]:
            fp, lp = _fmv("first-page"), _fmv("last-page")
            if fp and lp:
                fields["pages"] = "%s-%s" % (fp, lp)
            elif fp:
                fields["pages"] = fp
    if not fields["publisher"]:
        fields["publisher"] = _fmv("publisher") or (_fmv("source") if fields["kind"] == "book" else "")
    if not fields["city"]:
        fields["city"] = _fmv("city", "address")
    if not fields["doi"]:
        fields["doi"] = _fmv("doi")

    # completeness scan (per kind)
    miss = []
    if not fields["authors"]:
        miss.append("authors")
    if not fields["year"]:
        miss.append("year")
    if not fields["title"]:
        miss.append("title")
    if fields["kind"] == "article":
        if not fields["container"]:
            miss.append("journal")
        if not fields["pages"]:
            miss.append("pages")
    if fields["kind"] == "book":
        if not fields["publisher"]:
            miss.append("publisher")
    if fields["kind"] == "chapter":
        if not fields["container"]:
            miss.append("book")
        if not fields["publisher"]:
            miss.append("publisher")
    fields["missing"] = miss
    fields["complete"] = not miss
    return fields


# ----------------------------------------------------------------- frontmatter read
def _note_frontmatter(vault, rel):
    # minimal frontmatter read of a citation/clipping source note (author/year/title/source-type).
    p = _source_note_path(vault, rel)
    if p is None:
        return {}
    txt = _read(p)
    if txt is None:
        return {}
    txt = txt.replace("\r\n", "\n").replace("\r", "\n")
    lines = txt.split("\n")
    fm = {}
    if lines and lines[0].strip() == "---":
        for ln in lines[1:200]:
            if ln.strip() == "---":
                break
            if ":" in ln and not ln.startswith(" "):
                k, _, v = ln.partition(":")
                k, v = k.strip().lower(), v.strip().strip('"\'')
                if v:
                    fm[k] = v
    return fm


def _project_dir(vault, slug):
    slug = (slug or "").strip() if isinstance(slug, str) else ""
    if not slug or "/" in slug or "\\" in slug or ".." in slug or "\x00" in slug:
        return None
    from drafting import _canon_slug
    slug = _canon_slug(vault, slug)
    for base in ("papers", "grants"):
        try:
            root = (Path(vault) / "Projects" / base).resolve()
            d = (root / (PREFIX + slug)).resolve()
            d.relative_to(root)          # containment: a symlink can never escape
        except (ValueError, OSError):
            continue
        if d.is_dir():
            return d
    return None


def _writing_dir(vault, slug):
    # the project's writing/ dir, or None if the project is absent.
    d = _project_dir(vault, slug)
    return (d / "writing") if d else None


def load_prior_references(vault, slug):
    wdir = _writing_dir(vault, slug)
    if wdir is None:
        return {}
    txt = _read(wdir / "references.md")
    if txt is None:
        return {}
    txt = txt.replace("\r\n", "\n").replace("\r", "\n")
    out = {}
    for para in re.split(r"\n\s*\n", txt):
        line = " ".join(x.strip() for x in para.strip().split("\n")).strip()
        if not line or line.startswith("#"):
            continue
        if "[INCOMPLETE" in line or "[UNVERIFIED" in line:
            continue
        for key in (_prior_key(line), _prior_key(line, orig=True)):
            if key:
                out[key] = line
    return out


def _prior_key(line, orig=False):
    authors_str, year, suffix, _rest = _split_authors_year(line)
    if not year:
        return ""
    if orig:
        year = _orig_year(line)
        if not year:
            return ""
    lead = _parse_authors(authors_str)
    lead0 = lead[0] if lead else authors_str
    # the entry's lead surname is the text before the first comma (display order)
    surn = lead0.split(",")[0].strip()
    return _norm_key(_lead_surname_phrase(surn)) + "|" + year + suffix


def _prior_lines_all(vault, slug):
    wdir = _writing_dir(vault, slug)
    txt = _read(wdir / "references.md") if wdir else None
    out = {}
    for para in re.split(r"\n\s*\n", (txt or "").replace("\r\n", "\n")):
        line = " ".join(x.strip() for x in para.strip().split("\n")).strip()
        if line and not line.startswith("#"):
            for k in (_prior_key(line), _prior_key(line, orig=True)):
                if k:
                    out.setdefault(k, []).append(line)
    return out


# ----------------------------------------------------------------- LaTeX escaping
_TEX_MAP = {"&": r"\&", "%": r"\%", "$": r"\$", "#": r"\#", "_": r"\_",
            "{": r"\{", "}": r"\}", "~": r"\textasciitilde{}", "^": r"\textasciicircum{}"}


def _latex_escape(s):
    # escape TeX specials in a plain field; backslash first so it can't double-escape.
    s = (s or "").replace("\\", r"\textbackslash{}")
    for a, b in _TEX_MAP.items():
        s = s.replace(a, b)
    return s


def md_to_latex_emph(s):
    s = s or ""
    out = []
    i = 0
    for m in re.finditer(r"\*(.+?)\*", s):
        out.append(_escape_quotes(_latex_escape(s[i:m.start()])))
        out.append(r"\emph{" + _escape_quotes(_latex_escape(m.group(1))) + "}")
        i = m.end()
    out.append(_escape_quotes(_latex_escape(s[i:])))
    return "".join(out)


def _escape_quotes(s):
    # straight double quotes -> LaTeX ``...'' (best effort, paired left to right).
    res, open_q = [], True
    for ch in s:
        if ch == '"':
            res.append("``" if open_q else "''")
            open_q = not open_q
        else:
            res.append(ch)
    return "".join(res)


# ----------------------------------------------------------------- per-style format
def _name_initials(name):
    name = (name or "").strip()
    if "," in name:
        surn, _, given = name.partition(",")
    else:
        toks = name.split()
        if len(toks) < 2:
            return name
        surn, given = toks[-1], " ".join(toks[:-1])
    inits = []
    for tok in re.split(r"[\s.]+", given.strip()):
        tok = tok.strip(".")
        if tok:
            inits.append(tok[0].upper() + ".")
    return surn.strip() + (", " + " ".join(inits) if inits else "")


def _name_first_last(name):
    # "Surname, First Middle" -> "First Middle Surname" (MLA non-lead authors).
    if "," not in name:
        return name
    surn, _, given = name.partition(",")
    return (given.strip() + " " + surn.strip()).strip()


def _join_apa(authors):
    # APA author join: '&' before the last, initials. (No 21-author truncation here.)
    ns = [_name_initials(a) for a in authors]
    if not ns:
        return ""
    if len(ns) == 1:
        return ns[0]
    return ", ".join(ns[:-1]) + ", & " + ns[-1]


_SC_LOWER = frozenset((
    "a", "an", "the",
    "and", "but", "or", "nor", "for", "yet", "so",
    "as", "at", "by", "in", "of", "off", "on", "per", "to", "up", "via",
    "out", "from", "into", "onto", "over", "with", "upon", "down", "near",
    "than", "that", "this", "these", "those", "such",
    "is", "are", "was", "were", "be", "been", "being", "am",
    "do", "does", "did", "has", "have", "had",
    "it", "its", "we", "our", "you", "your", "their", "they", "them",
    "he", "she", "his", "her", "i",
    "between", "among", "about", "above", "below", "after", "before",
    "during", "through", "within", "without", "across", "around", "against",
    "still", "many", "much", "more", "most", "some", "any", "all", "both",
    "there", "here", "when", "where", "why", "how", "what", "who", "which",
    "while", "because", "if", "then", "else", "not", "no", "yes",
))


def _has_interior_cap(w):
    return any(c.isupper() for c in w[1:])


def _cap_first(w):
    # capitalize the first ALPHA character, preserve everything after it. Handles a
    # leading quote/paren ("'Quoted Title", "(Re)thinking") without eating the rest.
    for i, c in enumerate(w):
        if c.isalpha():
            return w[:i] + c.upper() + w[i + 1:]
        if c.isdigit():
            return w  # leading number, nothing to cap
    return w


def _sentence_case(title):
    def fix(seg):
        words = seg.split(" ")
        out = []
        first_done = False
        for w in words:
            if not w:
                out.append(w)
                continue
            if not first_done:
                out.append(_cap_first(w))
                first_done = True
                continue
            if w.isupper() or _has_interior_cap(w):
                out.append(w)                       # acronym / CamelCase / initialism
            elif w.strip(".,;:?!()[]'\"-").lower() in _SC_LOWER:
                out.append(w.lower())               # safe function word
            else:
                out.append(w)                       # preserve source casing (proper noun safe)
        return " ".join(out)
    parts = re.split(r"(:\s*)", title or "")
    res = []
    capnext = True
    for seg in parts:
        if seg.startswith(":"):
            res.append(seg)
            capnext = True
        else:
            if capnext and seg.strip():
                res.append(fix(seg))
            else:
                res.append(seg)
            capnext = False
    return "".join(res)


def _mark(field, label):
    # explicit marker for a missing field (never invent).
    return field if field else "[INCOMPLETE: missing " + label + "]"


def format_asa(rec, vault):
    flags = []
    prior = rec.get("prior")        # tier-1 verified line, if the project already has one
    fm = rec.get("fm") or {}
    asa_line = rec.get("citation_line") or ""
    bibtype = rec.get("bibtype") or ""
    fields = _parse_asa_fields(asa_line, fm, bibtype)
    if rec.get("suffix") and not fields.get("suffix"):
        fields["suffix"] = rec["suffix"]     # the list's 2018a matches the text's 2018a

    web = _web_source_line(rec, fm, asa_line)
    if prior and fields.get("edition") and fields["edition"].lower() not in prior.lower():
        prior = None
    if prior and asa_entry_defects(prior) and not web:
        fresh = _emit_asa(fields)
        if len(asa_entry_defects(fresh)) < len(asa_entry_defects(prior)):
            prior = None
            flags.append("prior-defective-replaced")
    if prior:
        # reuse the curated, verified entry verbatim (highest-quality text in system).
        text = prior
        conf = "verified-prior"
    elif web:
        text, conf = web, "complete"
    else:
        if not asa_line:
            flags.append("no-citation-line")
        elif _detect_format(asa_line) == "apa":
            flags.append("apa-normalized")     # the note's line was APA-shaped; reformatted
        text = _emit_asa(fields)
        conf = "complete" if fields["complete"] else "incomplete"
        if not fields["complete"]:
            flags.append("incomplete:" + ",".join(fields["missing"]))
        # malformation heuristics on the SOURCE line
        if re.search(r"\bal\.\.", asa_line) or re.search(r"\.\.", asa_line):
            flags.append("malformed-note")
    doi = re.sub(r"^(?:https?://(?:dx\.)?doi\.org/|doi:\s*)", "", (fields.get("doi") or "").strip(),
                 flags=re.IGNORECASE).rstrip(".")
    if doi and "doi.org/" not in text and "doi:" not in text.lower():
        text = text.rstrip() + " https://doi.org/" + doi
    flags += ["defect:" + d for d in asa_entry_defects(text) if d != "marker"]
    return {"text": text, "sortkey": sort_key(fields, "asa"),
            "confidence": conf, "flags": flags, "fields": fields}


_WEB_TYPES = ("blog", "government-release", "government-publication", "news", "press",
              "data-table", "web")
_MONTH_NAMES = ("January", "February", "March", "April", "May", "June", "July", "August",
                "September", "October", "November", "December")


def _web_source_line(rec, fm, line):
    st = str(fm.get("source-type", "") or "").lower()
    clip = "/Clippings/" in (rec.get("rel") or "")
    if not line or not (any(t in st for t in _WEB_TYPES) or (clip and st not in ("", "article"))):
        return ""
    authors_str, year, _suffix, _rest = _split_authors_year(line)
    if not authors_str or not year:
        return ""
    text = line.strip()
    if rec.get("suffix") is not None:
        text = re.sub(r"(\.\s*" + re.escape(year) + r")[a-z](?=\.)", r"\g<1>" + (rec.get("suffix") or ""),
                      text, count=1)
    url = str(fm.get("url", "") or "").strip()
    if url and "http" not in text:
        acc = str(fm.get("accessed", "") or "").strip()
        am = re.match(r"(\d{4})-(\d{2})-(\d{2})", acc)
        when = ("%s %d, %s " % (_MONTH_NAMES[int(am.group(2)) - 1], int(am.group(3)), am.group(1))
                if am else "")
        text = text.rstrip() + (" " if text.rstrip().endswith(".") else ". ") + \
            "Retrieved " + when + "(" + url + ")."
    return text


def _title_stop(title):
    return "" if (title or "").rstrip().endswith(("?", "!", ". . .", "…")) else "."


def _emit_asa(f):
    # canonical ASA entry from parsed fields. NOTE colon has NO trailing space:
    # 'Vol(Issue):Pages'. Missing required fields -> [INCOMPLETE: ...] markers.
    if not f["authors"] and not f["title"]:
        return "[UNVERIFIED — no citation note in vault]"
    auth = _join_asa_authors(f["authors"])
    yr = (f["year"] or "n.d.") + (f["suffix"] or "")
    if f.get("orig_year") and f["orig_year"] != f.get("year"):
        yr = "[" + f["orig_year"] + "] " + yr      # ASA 7th reprint/translation form
    stop = _title_stop(f["title"])
    if f["kind"] == "article":
        cont = _mark(f["container"], "journal")
        vi = ""
        if f["vol"]:
            vi = f["vol"] + ("(" + f["issue"] + ")" if f["issue"] else "")
        pg = _mark(f["pages"], "pages")
        loc = (vi + ":" + pg) if vi else pg
        return '%s. %s. "%s%s" *%s* %s.' % (auth, yr, f["title"], stop, cont, loc)
    def _pubseg(f):
        if f["publisher"]:
            return " " + ((f["city"] + ": ") if f["city"] else "") + f["publisher"] + "."
        return " [INCOMPLETE: missing publisher]"
    if f["kind"] == "chapter":
        cont = _mark(f["container"], "book")
        pg = f["pages"] or ""
        cp = _pubseg(f) if (f["city"] or f["publisher"]) else ""
        pp = ("Pp. " + pg + " ") if pg else ""
        edn = (", " + f["edition"]) if f.get("edition") else ""
        ed = (", edited by " + f["editor"]) if f.get("editor") else ""
        # an edition ending "ed." closes the segment itself: no doubled period
        close = "" if (edn + ed).endswith(".") else "."
        return '%s. %s. "%s%s" %sin *%s*%s%s%s%s' % (auth, yr, f["title"], stop, pp, cont, edn, ed, close, cp)
    if f["kind"] == "book":
        edn = (" " + f["edition"]) if f.get("edition") else ""
        trn = (" Translated by " + f["translator"] + ".") if f.get("translator") else ""
        return "%s. %s. *%s*%s%s%s%s" % (auth, yr, f["title"], stop, edn, trn, _pubseg(f))
    # misc / unknown kind
    return "%s. %s. %s." % (auth, yr, f["title"] or "[INCOMPLETE: missing title]")


def _join_asa_authors(authors):
    if not authors:
        return "[INCOMPLETE: missing authors]"
    if len(authors) == 1:
        return authors[0]
    return ", ".join(authors[:-1]) + ", and " + authors[-1]


def format_apa(fields):
    # APA 7 (the article and chapter paths are best-effort; flagged). Initials,
    # sentence-case title, parenthesized year, '&', no city for books.
    f = fields
    flags = ["best-effort-style"] if f["kind"] in ("article", "chapter") else []
    # APA sentence-casing is lexicon-free, so the rendered title is best-effort: function
    # words are lowered, proper nouns/acronyms preserved, content nouns left title-cased.
    if f["title"]:
        flags.append("title-approx")
    auth = _join_apa(f["authors"]) or "[INCOMPLETE: missing authors]"
    yr = "(" + (f["year"] or "n.d.") + (f["suffix"] or "") + ")"
    if f["kind"] == "article":
        title = _sentence_case(f["title"])
        cont = _mark(f["container"], "journal")
        vi = f["vol"] + ("(" + f["issue"] + ")" if f["issue"] else "") if f["vol"] else ""
        pg = _mark(f["pages"], "pages")
        loc = (", " + vi) if vi else ""
        text = "%s %s. %s. *%s*%s, %s." % (auth, yr, title, cont, loc, pg)
    elif f["kind"] == "book":
        edn = (" (" + f["edition"] + ")") if f.get("edition") else ""
        text = "%s %s. *%s*%s. %s." % (auth, yr, _sentence_case(f["title"]), edn,
                                       _mark(f["publisher"], "publisher"))
    elif f["kind"] == "chapter":
        # APA chapter: Author, A. A. (Year). Chapter title. In Editors (Eds.), *Book*
        # (pp. xx-xx). Publisher.  (editor kept in source order, flagged best-effort.)
        eds = ""
        if f.get("editor"):
            label = "Eds." if re.search(r"\band\b|&|,", f["editor"]) else "Ed."
            eds = f["editor"] + " (" + label + "), "
        pg = (" (pp. " + f["pages"] + ")") if f["pages"] else ""
        text = "%s %s. %s. In %s*%s*%s. %s." % (
            auth, yr, _sentence_case(f["title"]), eds, _mark(f["container"], "book"),
            pg, _mark(f["publisher"], "publisher"))
    else:
        text = "%s %s. %s." % (auth, yr, _sentence_case(f["title"]) or "[INCOMPLETE: missing title]")
    return {"text": text, "sortkey": sort_key(f, "apa"), "confidence": "reformatted",
            "flags": flags, "fields": f}


def _emit_chicago(f):
    if f["kind"] != "article":
        return _emit_asa(f)
    auth = _join_asa_authors(f["authors"])
    yr = (f["year"] or "n.d.") + (f["suffix"] or "")
    cont = _mark(f["container"], "journal")
    vi = ""
    if f["vol"]:
        vi = f["vol"] + (" (" + f["issue"] + ")" if f["issue"] else "")
    pg = _mark(f["pages"], "pages")
    loc = (vi + ": " + pg) if vi else pg
    return '%s. %s. "%s." *%s* %s.' % (auth, yr, f["title"], cont, loc)


def format_chicago(fields):
    # Chicago author-date: books/chapters identical to ASA; articles use Chicago
    # locator spacing (best-effort; flagged). In-text page separator handled in intext_display.
    out = {"text": _emit_chicago(fields), "sortkey": sort_key(fields, "chicago"),
           "confidence": "reformatted",
           "flags": (["best-effort-style"] if fields["kind"] == "article" else []),
           "fields": fields}
    return out


def format_mla(fields):
    # MLA (entirely best-effort, flagged): lead 'Surname, First', other authors
    # 'First Surname', container model, year near the end.
    f = fields
    flags = ["best-effort-style"]
    if not f["authors"]:
        auth = "[INCOMPLETE: missing authors]"
    else:
        names = [f["authors"][0]] + [_name_first_last(a) for a in f["authors"][1:]]
        if len(names) == 1:
            auth = names[0]
        elif len(names) == 2:
            auth = names[0] + ", and " + names[1]
        else:
            auth = names[0] + ", et al"
    yr = (f["year"] or "n.d.") + (f["suffix"] or "")
    if f["kind"] == "article":
        cont = _mark(f["container"], "journal")
        vi = ""
        if f["vol"]:
            vi = ", vol. " + f["vol"] + (", no. " + f["issue"] if f["issue"] else "")
        pg = (", pp. " + f["pages"]) if f["pages"] else ", [INCOMPLETE: missing pages]"
        text = '%s. "%s." *%s*%s, %s%s.' % (auth, f["title"], cont, vi, yr, pg)
    elif f["kind"] == "book":
        edn = (f["edition"] + ", ") if f.get("edition") else ""
        text = "%s. *%s*. %s%s, %s." % (auth, f["title"], edn, _mark(f["publisher"], "publisher"), yr)
    else:
        text = '%s. "%s." %s.' % (auth, f["title"] or "[INCOMPLETE: missing title]", yr)
    return {"text": text, "sortkey": sort_key(f, "mla"), "confidence": "reformatted",
            "flags": flags, "fields": f}


def format_entry(rec, vault, style="asa"):
    style = (style or "asa").lower()
    if style == "asa":
        return format_asa(rec, vault)
    src_line = rec.get("prior") or rec.get("citation_line") or ""
    fields = _parse_asa_fields(src_line, rec.get("fm") or {}, rec.get("bibtype") or "")
    if rec.get("prior") and not fields.get("edition") and rec.get("citation_line"):
        # the prior line may have lost the note's edition (see format_asa)
        nf = _parse_asa_fields(rec["citation_line"], rec.get("fm") or {}, rec.get("bibtype") or "")
        if nf.get("edition") and nf.get("kind") == fields.get("kind"):
            fields["edition"] = nf["edition"]
    if rec.get("suffix") and not fields.get("suffix"):
        fields["suffix"] = rec["suffix"]
    if style == "apa":
        e = format_apa(fields)
    elif style == "chicago":
        e = format_chicago(fields)
    elif style == "mla":
        e = format_mla(fields)
    else:
        return format_asa(rec, vault)
    if fields.get("missing"):
        flag = "incomplete:" + ",".join(fields["missing"])
        if flag not in e.get("flags", []):
            e["flags"] = list(e.get("flags", [])) + [flag]
        e["confidence"] = "incomplete"
    return e


def format_reference(rec, style="asa", vault=None):
    # spec-named alias for format_entry.
    return format_entry(rec, vault, style)


def sort_key(fields, style="asa"):
    f = fields if isinstance(fields, dict) else {}
    authors = f.get("authors") or []
    lead = authors[0] if authors else ""
    surn = lead.split(",")[0].strip() if lead else ""
    if style in ("asa", "chicago"):
        toks = [t for t in re.split(r"\s+", surn) if t]
        toks = [t for t in toks if not (_norm_key(t) in _PARTICLES and t[:1].islower())] or toks
        sk = _norm_key(" ".join(toks))
    else:
        sk = _norm_key(surn)
    surns = [surn] if authors else []
    for a in authors[1:]:
        # subsequent authors are usually "First Last" or "Last, First"; take the last
        # whitespace token unless there's a comma (then the pre-comma surname).
        if "," in a:
            surns.append(a.split(",")[0].strip())
        else:
            toks = [t for t in re.split(r"\s+", a.strip()) if t]
            surns.append(toks[-1] if toks else a)
    n_extra = max(0, len(authors) - 1)                # 0 (single author) sorts first
    coauthor_key = tuple(_norm_key(s) for s in surns[1:])
    return (sk, n_extra if n_extra == 0 else 1, coauthor_key,
            str(f.get("year") or "") + str(f.get("suffix") or ""), (f.get("title") or "").lower())


# ----------------------------------------------------------------- build references
_REFSEC_RE = re.compile(r"(?mi)^##[ \t]+(?:references|bibliography|works cited)[ \t]*$")
_NEXT_H2_RE = re.compile(r"(?m)^## ")


def _without_reference_section(text):
    text = text or ""
    m = _REFSEC_RE.search(text)
    if not m:
        return text
    nxt = _NEXT_H2_RE.search(text, m.end())
    return text[:m.start()] + (text[nxt.start():] if nxt else "")


def settle_ambiguous(res, vault, slug):
    corpus = _corpus_filenames(vault, slug)
    keep = []
    for amb in res["ambiguous"]:
        pick = pick_by_corpus(amb["candidates"], corpus)
        if pick:
            res["resolved"].append({"token": amb["token"], "citekey": pick["citekey"],
                                    "rel": pick["rel"], "stem": pick["stem"], "page": "",
                                    "suffix": ""})
        else:
            keep.append(amb)
    res["ambiguous"] = keep
    hints = _prior_lines_all(vault, slug)
    keep = []
    for amb in res["ambiguous"]:
        tok = parse_cite_token(amb["token"])
        pkey = _norm_key(tok["surname"]) + "|" + tok["year"] + tok["suffix"]
        picks = {id(p): p for p in (disambiguate_by_reference(amb["candidates"], ln)
                                    for ln in hints.get(pkey, [])) if p}
        if len(picks) == 1:
            pick = list(picks.values())[0]
            res["resolved"].append({"token": amb["token"], "citekey": pick["citekey"],
                                    "rel": pick["rel"], "stem": pick["stem"], "page": "",
                                    "suffix": ""})
        else:
            keep.append(amb)
    res["ambiguous"] = keep
    return res


def build_references(text, vault, idx, style="asa", slug=None, mark_unresolved=False):
    style = _norm_style(style)
    text = _without_reference_section(text)
    res = resolve_cites(text, idx)
    bibtypes = load_bib_types(vault)
    prior = load_prior_references(vault, slug) if slug else {}
    if slug:
        settle_ambiguous(res, vault, slug)

    seen, recs = set(), []
    for hit in res["resolved"]:
        key = (hit["citekey"], hit["rel"])           # dedup on (citekey, rel), not citekey
        if key in seen:
            continue
        seen.add(key)
        rel = hit["rel"]
        fm = _note_frontmatter(vault, rel)
        cline = raw_citation_line(vault, rel)
        bt = bibtypes.get(hit["citekey"], {}).get("bibtype", "")
        tok = parse_cite_token(hit["token"])
        pkey = _norm_key(tok["surname"]) + "|" + tok["year"] + tok["suffix"]
        pline = prior.get(pkey)
        ntitle = fm.get("title") if isinstance(fm.get("title"), str) else ""
        if pline and ntitle and _title_overlap(_ref_title(pline), ntitle) < 0.6:
            pline = None
        recs.append({"citekey": hit["citekey"], "rel": rel, "stem": hit["stem"],
                     "suffix": tok["suffix"],
                     "fm": fm, "citation_line": cline, "bibtype": bt,
                     "prior": pline, "token": hit["token"]})

    formatted = []
    for rec in recs:
        e = format_entry(rec, vault, style)
        e["citekey"] = rec["citekey"]
        e["rel"] = rec["rel"]
        formatted.append(e)

    def _prior_entry(raw, flag):
        tok = parse_cite_token(raw)
        if not tok["surname"] or not tok["year"]:
            return None
        pkey = _norm_key(tok["surname"]) + "|" + tok["year"] + tok["suffix"]
        line = prior.get(pkey)
        if not line:
            return None
        fields = _parse_asa_fields(line, {}, "")
        if style == "asa":
            e = {"text": line, "sortkey": sort_key(fields, "asa"),
                 "confidence": "verified-prior",
                 "flags": [flag] + ["defect:" + d for d in asa_entry_defects(line)],
                 "fields": fields}
        else:
            e = format_entry({"citation_line": line, "fm": {}, "bibtype": ""}, vault, style)
            e["flags"] = list(e["flags"]) + [flag]
        e["citekey"] = ""
        e["rel"] = ""
        return e

    rescued_unres, rescued_amb = [], []
    if prior:
        for raw in res["unresolved"]:
            e = _prior_entry(raw, "prior-only-no-note")
            if e is not None:
                formatted.append(e)
                rescued_unres.append(raw)
        for amb in res["ambiguous"]:
            e = _prior_entry(amb["token"], "prior-disambiguated")
            if e is not None:
                formatted.append(e)
                rescued_amb.append(amb["token"])
    res["unresolved"] = [u for u in res["unresolved"] if u not in rescued_unres]
    res["ambiguous"] = [a for a in res["ambiguous"] if a["token"] not in rescued_amb]

    if mark_unresolved:
        for raw in res["unresolved"]:
            tok = parse_cite_token(raw)
            formatted.append({"text": "[UNVERIFIED — NEEDS CITE: " + raw + ". Cited in the text; "
                              "no vault source matches this name and year.]",
                              "sortkey": (_norm_key(tok["surname"]), 0, (), tok["year"], ""),
                              "confidence": "unverified", "flags": ["not-found"],
                              "fields": {}, "citekey": "", "rel": ""})
        for amb in res["ambiguous"]:
            tok = parse_cite_token(amb["token"])
            formatted.append({"text": "[UNVERIFIED — AMBIGUOUS: " + amb["token"] + " matches "
                              + str(len(amb["candidates"])) + " vault works; the cite needs "
                              "its a/b letter.]",
                              "sortkey": (_norm_key(tok["surname"]), 0, (), tok["year"], ""),
                              "confidence": "unverified", "flags": ["ambiguous"],
                              "fields": {}, "citekey": "", "rel": ""})

    formatted.sort(key=lambda e: e["sortkey"])

    body = "\n\n".join(e["text"] for e in formatted)
    markdown = "# References\n\n" + body + ("\n" if body else "")

    complete = sum(1 for e in formatted if e["confidence"] in ("verified-prior", "complete"))
    incomplete = sum(1 for e in formatted
                     if any(fl.startswith("incomplete") or fl in
                            ("malformed-note", "apa-normalized", "no-citation-line")
                            for fl in e["flags"]))
    audit = {
        "style": style,
        "total": len(formatted),
        "complete": complete,
        "incomplete": incomplete,
        "ambiguous": len(res["ambiguous"]),
        "not_found": len(res["unresolved"]),
        # entries whose finished line fails the shape guard (asa_entry_defects)
        "defective": sum(1 for e in formatted
                         if any(fl.startswith("defect:") for fl in e["flags"])),
        "items":[{"citekey": e["citekey"], "rel": e["rel"],
                   "confidence": e["confidence"], "flags": e["flags"]} for e in formatted],
        "ambiguous_items": res["ambiguous"],
        "not_found_items": res["unresolved"],
    }
    return {"references": markdown, "markdown": markdown, "entries": formatted,
            "used": [e["citekey"] for e in formatted],
            "unresolved": res["unresolved"], "missing": res["unresolved"],
            "ambiguous": res["ambiguous"], "audit": audit, "style": style}


def audit_citations(text, vault, idx, slug=None):
    # standalone feature-2 audit (no write).
    b = build_references(text, vault, idx, "asa", slug)
    return b["audit"]


def _corpus_filenames(vault, slug):
    proj = _project_dir(vault, slug)
    if proj is None:
        return []
    try:
        d = proj / "corpus"
        rel = proj.relative_to(Path(vault).resolve()).as_posix()
        return [(p.name.lower(), rel + "/corpus/" + p.name)
                for p in d.iterdir() if p.suffix == ".md"]
    except (OSError, ValueError):
        return []


def pick_by_corpus(candidates, corpus):
    names = {fn for fn, _rel in corpus or []}
    hit = [c for c in candidates if ((c.get("stem") or "") + ".md").lower() in names]
    return hit[0] if len(hit) == 1 else None


_CORPUS_FN = re.compile(r"^(.*?)\s*\((" + _YEAR + r")([a-z]?)\)")


def _corpus_match(corpus, t):
    yr = str(t.get("year") or "")
    lead = _norm_key(t.get("surname", ""))
    if not yr or not lead:
        return ""
    hits = []
    for fn, rel in corpus:
        m = _CORPUS_FN.match(fn)
        if not m or m.group(2) != yr:
            continue
        if t.get("suffix") and m.group(3) and m.group(3) != t["suffix"]:
            continue
        auth = m.group(1).strip()
        if _record_lead_key(auth) != lead:
            continue
        if _pattern_contradicts(t, {"intext": auth, "author": auth}):
            continue
        if cite_pattern(t).startswith("co:") and cite_pattern(t)[3:] not in _norm_key(auth):
            continue
        hits.append(rel)
    return hits[0] if len(hits) == 1 else ""


def _cite_map_key(t, with_pattern=True):
    if not t["surname"] or not t["year"]:
        return None
    k = _norm_key(t["surname"]) + "|" + t["year"] + t["suffix"]
    pattern = cite_pattern(t)
    co = t.get("coauthors") or []
    if len(co) >= 2 and not t.get("etal"):
        # Fully named trios sharing a lead/year may be different works. Keep every
        # named coauthor in the map identity without changing resolver shape rules.
        pattern = "co:" + ",".join(co)
    return (k + "|" + pattern) if with_pattern else k


# --------------------------------------------------- reference-list disambiguation
_TITLE_STOP = frozenset(
    "a an the of and or in on to for with without into from by at as is are was were be "
    "been being how why what when where who whom whose this that these those its it their "
    "his her our your my not no do does can may".split())


def _ref_title(line):
    m = re.search(r"\(\s*" + _YEAR + r"[a-z]?\s*\)\.\s+([^*\"].+?[^A-Z])\.(?:\s|$)", line or "")
    if m:
        return m.group(1)
    m = re.search(r'"([^"]+)"', line or "")
    if m:
        return m.group(1)
    m = re.search(r"\*([^*]+)\*", line or "")
    if m:
        return m.group(1)
    return ""


def _title_toks(s):
    return {w for w in re.findall(r"[a-z0-9]+", _fold(s or "").lower())
            if w not in _TITLE_STOP and len(w) > 1}


def _title_overlap(a, b):
    # fraction of the shorter title's significant tokens shared -> [0,1].
    ta, tb = _title_toks(a), _title_toks(b)
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / min(len(ta), len(tb))


def disambiguate_by_reference(candidates, entry_line):
    rt = _ref_title(entry_line or "")
    if not rt or not candidates:
        return None
    scored = sorted(((c, _title_overlap(rt, c.get("title", ""))) for c in candidates),
                    key=lambda cs: -cs[1])
    best, bs = scored[0]
    if bs < 0.6:                          # no candidate clearly matches the entry title
        return None
    ties = [c for c, s in scored if bs - s < 1e-9]
    if len(ties) > 1:
        auth_toks = [w for w in _title_toks(re.split(r"(?:19|20)\d\d", entry_line, 1)[0])
                     if len(w) > 2]
        scores = [(c, sum(1 for w in auth_toks if w in c.get("citekey", "").lower()))
                  for c in ties]
        highest = max(s for _c, s in scores)
        winners = [c for c, s in scores if s == highest]
        return winners[0] if len(winners) == 1 else None
    second = scored[1][1] if len(scored) > 1 else 0.0
    if bs - second >= 0.15 or bs >= 0.95:
        return best
    return None


def cite_map(text, idx, vault=None, slug=None):
    res = resolve_cites(text, idx)
    prior = load_prior_references(vault, slug) if (vault and slug) else {}

    def _key(raw):
        return _cite_map_key(parse_cite_token(raw))

    out = {}
    for r in res["resolved"]:
        k = _key(r["token"])
        if k:
            out[k] = {"status": "resolved", "rel": r["rel"], "citekey": r["citekey"]}
    for amb in res["ambiguous"]:
        k = _key(amb["token"])
        if not k or k in out:
            continue
        t = parse_cite_token(amb["token"])
        pk = _norm_key(t["surname"]) + "|" + t["year"] + t["suffix"]
        pick = disambiguate_by_reference(amb["candidates"], prior.get(pk, "")) if prior else None
        if not pick and vault and slug:
            pick = pick_by_corpus(amb["candidates"], _corpus_filenames(vault, slug))
        if pick:
            out[k] = {"status": "resolved", "rel": pick.get("rel", ""),
                      "citekey": pick.get("citekey", "")}
        else:
            out[k] = {"status": "ambiguous", "rel": "", "candidates": len(amb["candidates"])}
    corpus = _corpus_filenames(vault, slug) if (vault and slug) else []
    for u in res["unresolved"]:
        k = _key(u)
        if not k or k in out:
            continue
        t = parse_cite_token(u)
        pk = _norm_key(t["surname"]) + "|" + t["year"] + t["suffix"]
        if prior.get(pk):
            out[k] = {"status": "prior", "rel": ""}
            continue
        crel = _corpus_match(corpus, t)
        if crel:
            out[k] = {"status": "resolved", "rel": crel, "citekey": ""}
        else:
            out[k] = {"status": "unresolved", "rel": ""}
    groups = {}
    for k, v in out.items():
        groups.setdefault(k.rsplit("|", 1)[0], []).append(v)
    aliases = {}
    for bare, vs in groups.items():
        if len({(v["status"], v.get("rel", "")) for v in vs}) == 1:
            aliases[bare] = dict(vs[0], alias=True)
    legacy_groups = {}
    for k, v in out.items():
        bare, pattern = k.rsplit("|", 1)
        if pattern.startswith("co:") and "," in pattern:
            legacy_groups.setdefault(bare + "|etal", []).append(v)
    for k, vs in legacy_groups.items():
        if k in out:
            continue
        identities = {(v["status"], v.get("rel", "")) for v in vs}
        aliases[k] = (dict(vs[0], alias=True) if len(identities) == 1 else
                      {"status": "ambiguous", "rel": "", "candidates": len(identities),
                       "alias": True})
    counts = {"resolved": 0, "unresolved": 0, "ambiguous": 0}
    for v in out.values():
        s = v["status"]
        if s in ("resolved", "prior"):
            counts["resolved"] += 1
        elif s == "ambiguous":
            counts["ambiguous"] += 1
        else:
            counts["unresolved"] += 1
    out.update(aliases)
    return {"map": out, "counts": counts}


# ----------------------------------------------------------------- atomic writes
def _prune_backups(bdir, label, keep=200):
    try:
        files = sorted(bdir.glob(label + ".*.md"))
    except OSError:
        return
    for f in files[:-keep]:
        try:
            f.unlink()
        except OSError:
            pass


def _atomic_write(p, old, text, label="references"):
    p = Path(p)
    p.parent.mkdir(parents=True, exist_ok=True)
    if old is not None:
        bdir = p.parent / ".writing-backups"
        try:
            bdir.mkdir(exist_ok=True)
            ts = time.strftime("%Y%m%d-%H%M%S-") + str(int(time.time() * 1000) % 1000).zfill(3)
            (bdir / (label + "." + ts + ".md")).write_text(old, encoding="utf-8")
            _prune_backups(bdir, label, keep=200)
        except OSError:
            pass
    fd, tmppath = tempfile.mkstemp(dir=str(p.parent), prefix="." + label + ".", suffix=".md.tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
            f.flush()
            try:
                os.fsync(f.fileno())
            except OSError:
                pass
        os.replace(tmppath, str(p))
    except OSError:
        try:
            os.unlink(tmppath)
        except OSError:
            pass
        raise


def _write_json(p, obj):
    p = Path(p)
    p.parent.mkdir(parents=True, exist_ok=True)
    fd, tmppath = tempfile.mkstemp(dir=str(p.parent), prefix="." + p.stem + ".", suffix=".json.tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False)
            f.flush()
            try:
                os.fsync(f.fileno())
            except OSError:
                pass
        try:
            os.chmod(tmppath, 0o644)   # mkstemp is 0600
        except OSError:
            pass
        os.replace(tmppath, str(p))
    except OSError:
        try:
            os.unlink(tmppath)
        except OSError:
            pass
        raise


def _references_path(vault, slug):
    wdir = _writing_dir(vault, slug)
    if wdir is None:
        return None
    return wdir / "references.md"


def write_references(vault, slug, style="asa", force=False, base_mtime=None,
                     idx=None, here=None, markdown=None):
    style = _norm_style(style)
    p = _references_path(vault, slug)
    if p is None:
        return {"error": "unknown paper or unsafe slug"}
    try:
        root = (Path(vault) / "Projects" / "papers").resolve()
        p.parent.resolve().relative_to(root)
    except (ValueError, OSError):
        return {"error": "unsafe path"}
    if markdown is None:
        if here is None:
            here = Path(__file__).resolve().parent
        if idx is None:
            idx = load_resolver_index(here)
        wdir = _writing_dir(vault, slug)
        paper = _read(wdir / "paper.md") or ""
        built = build_references(paper, vault, idx, style, slug)
        markdown = built["markdown"]
    old = None
    if p.exists():
        cur = _mt(p)
        if base_mtime is not None and not force:
            bm = _as_int(base_mtime)
            if bm is None:
                return {"error": "bad base_mtime"}
            if cur != bm:
                return {"conflict": True, "currentMtime": cur, "currentText": _read(p) or ""}
        old = _read(p)
    _atomic_write(p, old, markdown, label="references")
    return {"ok": True, "mtime": _mt(p), "rel": _rel(vault, p), "style": style}


# spec-named alias
def write_references_md(vault, slug, markdown, base_mtime=None, force=False):
    return write_references(vault, slug, force=force, base_mtime=base_mtime, markdown=markdown)


# ----------------------------------------------------------------- LaTeX output
def bibliographystyle_for(style):
    style = (style or "asa").lower()
    table = {
        "asa":     {"inline": True,  "bst": None,       "natbib": False, "compiles": True},
        "chicago": {"inline": True,  "bst": "chicago",  "natbib": False, "compiles": False},
        "apa":     {"inline": True,  "bst": "apalike",  "natbib": True,  "compiles": True},
        "mla":     {"inline": True,  "bst": None,       "natbib": False, "compiles": True},
    }
    m = table.get(style, table["asa"])
    note = ("inline transclusion (always compiles)" if m["inline"] else "")
    if m["bst"] and not m["compiles"]:
        note += "; bst '%s' MISSING on this TeX Live — route inline" % m["bst"]
    elif m["bst"] and m["natbib"]:
        note += "; real-bibtex available: \\usepackage{natbib}+\\bibliographystyle{%s}" % m["bst"]
    return dict(m, style=style, note=note)


def latex_bibliography(references, style="asa"):
    if isinstance(references, dict):
        references = references.get("markdown") or references.get("references") or ""
    if isinstance(references, list):
        lines = []
        for e in references:
            t = e["text"] if isinstance(e, dict) else str(e)
            lines.append(t)
        md = "# References\n\n" + "\n\n".join(lines)
    else:
        md = references or ""
    # drop the heading line; the cls env emits \section*{References}
    body = re.sub(r"^#\s*References\s*\n+", "", md)
    paras = [p.strip() for p in re.split(r"\n\s*\n", body) if p.strip()]
    latex = "\n\n".join(md_to_latex_emph(p) for p in paras)
    meta = bibliographystyle_for(style)
    return {"latex": latex, "markdown": md, "style": style,
            "bibliographystyle": meta["bst"], "inline": meta["inline"],
            "natbib": meta["natbib"], "compiles": meta["compiles"], "note": meta["note"]}


def thebibliography_block(references, style="asa"):
    # an explicit hanging-indent thebibliography-style block (alternative to the cls
    # env), for callers that want a self-contained fragment. Uses \hangindent.
    out = latex_bibliography(references, style)
    paras = [p for p in out["latex"].split("\n\n") if p.strip()]
    body = "\n\n".join(r"\noindent\hangindent=0.5in\hangafter=1 " + p + r"\par" for p in paras)
    return ("% hanging-indent reference list (style=%s)\n" % style
            + "\\begingroup\\parindent=0pt\\parskip=6pt\n" + body + "\n\\endgroup\n")


_SRC_DIRS = (("Preparation", "Reading", "Citations"),
             ("Preparation", "Reading", "Clippings"))
_BIB_FIELD_RE = re.compile(r"^[ \t]*([A-Za-z\-]+)[ \t]*=[ \t]*\{(.*)\}[ \t]*,?[ \t]*$")
_BIB_VSRC_LINE = re.compile(r"^[ \t]*%[ \t]*vault-source[ \t]*=[ \t]*(.+?)[ \t]*$")
_BIB_ORDER = ["author", "year", "title", "journal", "volume", "number", "pages",
              "publisher", "address", "booktitle", "editor", "doi", "url"]
_BIB_ESCAPE_FIELDS = {"title", "journal", "publisher", "booktitle", "address", "editor"}


def _source_note_path(vault, rel):
    rel = (rel or "").replace("\\", "/").strip().lstrip("/")
    if not rel or ".." in rel.split("/") or "\x00" in rel or not rel.endswith(".md"):
        return None
    try:
        p = (Path(vault) / rel).resolve()
    except OSError:
        return None
    for sub in _SRC_DIRS:
        try:
            p.relative_to((Path(vault) / Path(*sub)).resolve())
            return p if p.is_file() else None
        except ValueError:
            continue
    try:
        r = p.relative_to((Path(vault) / "Projects" / "papers").resolve())
        if len(r.parts) >= 3 and r.parts[1] == "corpus" and p.is_file():
            return p
    except ValueError:
        pass
    return None


def _one_line(text):
    # collapse a possibly multi-line edited reference to a single clean line.
    return re.sub(r"\s+", " ", (text or "").replace("\r", " ").replace("\n", " ")).strip()


def _yaml_scalar(v):
    v = (v or "").strip()
    if not v:
        return v
    need = (":" in v) or ("#" in v) or (v[0] in "[]{}>|@&*!%'\"-?,") or (v != v.strip())
    if need:
        return '"' + v.replace("\\", "\\\\").replace('"', '\\"') + '"'
    return v


def _bib_escape(s):
    # byte-identical to regen_bib.escape_bib so a direct edit and a full regen converge.
    if not s:
        return ""
    s = s.replace("\\", "\\textbackslash{}")
    return re.sub(r"([{}#$%&_])", r"\\\1", s)


def _invert_name(name):
    # 'Given Middle Surname' -> 'Surname, Given Middle' for a bibtex author field; an
    # already-inverted 'Surname, Given' or a mononym/corporate author is left as-is.
    name = (name or "").strip()
    if not name or "," in name:
        return name
    toks = [t for t in re.split(r"\s+", name) if t]
    if len(toks) < 2:
        return name
    i = len(toks) - 1
    surn = [toks[i]]
    while i - 1 >= 0 and _norm_key(toks[i - 1]) in _PARTICLES:
        i -= 1
        surn.insert(0, toks[i])
    given = toks[:i]
    return " ".join(surn) + (", " + " ".join(given) if given else "")


def _bib_authors(authors):
    inv = [_invert_name(a) for a in (authors or []) if a and a.strip()]
    return " and ".join(inv)


def _bibtype_for(kind, existing):
    return {"article": "article", "book": "book", "chapter": "incollection"}.get(
        kind, (existing or "article"))


def _parse_bib_entry(entry_text):
    # one '@type{citekey, ...}' block -> (bibtype, citekey, {field: value}, vault_source).
    lines = (entry_text or "").split("\n")
    bibtype = citekey = vsrc = ""
    fields = {}
    if lines:
        m = re.match(r"^@(\w+)\s*\{\s*([^,\s]+)", lines[0])
        if m:
            bibtype, citekey = m.group(1).lower(), m.group(2)
    for ln in lines[1:]:
        vm = _BIB_VSRC_LINE.match(ln)
        if vm:
            vsrc = vm.group(1).strip()
            continue
        fm = _BIB_FIELD_RE.match(ln)
        if fm:
            fields[fm.group(1).lower()] = fm.group(2)
    return bibtype, citekey, fields, vsrc


def _merge_bib_fields(asa_fields, existing, bibtype):
    # overlay parsed ASA fields onto the existing bib fields (non-empty wins), preserving
    # any unmanaged field (url, etc.). Returns an ordered [(key, value)].
    f = asa_fields
    cont = f.get("container") or ""
    merged = dict(existing or {})

    def setf(k, v):
        if v:
            merged[k] = v
    setf("author", _bib_authors(f.get("authors") or []))
    if f.get("year"):
        merged["year"] = f["year"] + (f.get("suffix") or "")
    setf("title", f.get("title"))
    if bibtype == "article":
        setf("journal", cont)
    elif bibtype == "book":
        setf("publisher", f.get("publisher"))
        setf("address", f.get("city"))
    elif bibtype == "incollection":
        setf("booktitle", cont)
        setf("editor", f.get("editor"))
    setf("volume", f.get("vol"))
    setf("number", f.get("issue"))
    setf("pages", f.get("pages"))
    setf("doi", f.get("doi"))
    out = [(k, merged[k]) for k in _BIB_ORDER if merged.get(k)]
    for k, v in merged.items():
        if k not in _BIB_ORDER and v:
            out.append((k, v))
    return out


def _emit_bib_entry(bibtype, citekey, kv, vault_source):
    # canonical entry matching the live library.bib (padded '=', '% vault-source' last,
    # every field keeps its trailing comma when the comment line follows).
    lines = ["@%s{%s," % (bibtype, citekey)]
    for k, v in kv:
        if k in _BIB_ESCAPE_FIELDS:
            v = _bib_escape(v)
        lines.append("  %-12s = {%s}," % (k, v))
    if vault_source:
        lines.append("  %% vault-source = %s" % vault_source)
    elif lines[-1].endswith(","):
        lines[-1] = lines[-1][:-1]
    lines.append("}")
    return "\n".join(lines)


def _replace_or_insert_bib(text, citekey, new_entry):
    pat = re.compile(r"(?ms)^@\w+\{\s*" + re.escape(citekey) + r"\s*,.*?^\}[ \t]*$")
    m = pat.search(text)
    if m:
        return text[:m.start()] + new_entry + text[m.end():], False
    ck_low = citekey.lower()
    for hm in re.finditer(r"(?m)^@\w+\{\s*([^,\s]+)", text):
        if hm.group(1).lower() > ck_low:
            ins = hm.start()
            return text[:ins] + new_entry + "\n\n" + text[ins:], True
    sep = "" if text.endswith("\n\n") else ("\n" if text.endswith("\n") else "\n\n")
    return text.rstrip("\n") + "\n\n" + new_entry + "\n", True


def _file_is_crlf(p):
    # detect the on-disk newline convention from RAW bytes — _read()/read_text apply
    # universal-newline translation, so an in-memory string never shows CRLF.
    try:
        with open(p, "rb") as f:
            return b"\r\n" in f.read(65536)
    except OSError:
        return False


def _restore_nl(new_lf, was_crlf):
    # round-trip helper: bring LF-edited text back to the file's original convention so a
    # surgical edit never flips a CRLF note wholesale to LF (which churns the sync diff).
    return new_lf.replace("\n", "\r\n") if was_crlf else new_lf


def _replace_citation_block(text, new_line):
    m = re.search(r"(?im)^#{1,6}[ \t]*Citation[ \t]*$", text)
    if not m and re.search(r"(?m)^## (Brief Summary|Key Points|Limitations|Notes|Quotes"
                           r"|Further Reading)[ \t]*$", text):
        import sys
        pass
        from citation_headers import insert_section
        fm = re.match(r"(?s)^(---\n.*?\n---[ \t]*\n)", text)
        head, body = (text[:fm.end()], text[fm.end():]) if fm else ("", text)
        return head + "\n".join(insert_section(body.split("\n"), "Citation", [new_line]))
    if not m:
        fm = re.match(r"(?s)^(---\n.*?\n---[ \t]*\n)", text)
        block = "## Citation\n\n" + new_line + "\n"
        if fm:
            return text[:fm.end()] + "\n" + block + "\n" + text[fm.end():]
        return block + "\n" + text
    line_end = text.find("\n", m.end())
    if line_end == -1:
        return text + "\n\n" + new_line + "\n"
    cursor = line_end + 1
    n = len(text)
    while cursor < n:
        nxt = text.find("\n", cursor)
        seg_end = n if nxt == -1 else nxt
        line = text[cursor:seg_end]
        if line.strip() == "":
            cursor = (seg_end + 1) if nxt != -1 else n
            continue
        if line.lstrip().startswith("#"):
            return text[:cursor] + new_line + "\n" + text[cursor:]
        return text[:cursor] + new_line + text[seg_end:]
    return text + "\n" + new_line + "\n"


def _update_frontmatter(text, updates):
    # LF-only. updates: [(key, value, mode)] with mode in {'fill','sync'}; never blanks a
    # field, never fabricates a frontmatter block. Preserves untouched keys + order.
    fmm = re.match(r"(?s)^(---\n)(.*?)(\n---[ \t]*\n?)", text)
    if not fmm:
        return text
    head, body, tail = fmm.group(1), fmm.group(2), fmm.group(3)
    lines = body.split("\n")

    def line_key(ln):
        if not ln or ln[0] in " \t-" or ":" not in ln:
            return None
        return ln.split(":", 1)[0].strip().lower()
    present = {}
    for i, ln in enumerate(lines):
        k = line_key(ln)
        if k is not None and k not in present:
            present[k] = i
    for key, val, mode in updates:
        if not val:
            continue
        sval = _yaml_scalar(val)
        if key in present:
            i = present[key]
            curval = lines[i].split(":", 1)[1].strip() if ":" in lines[i] else ""
            if mode == "fill" and curval:
                continue
            lines[i] = key + ": " + sval
        else:
            lines.append(key + ": " + sval)
            present[key] = len(lines) - 1
    return text[:fmm.start()] + head + "\n".join(lines) + tail + text[fmm.end():]


def _update_prior_reference(vault, slug, key, new_line):
    p = _references_path(vault, slug)
    if p is None or not p.exists():
        return False
    txt = _read(p)
    if txt is None:
        return False
    was_crlf = _file_is_crlf(p)
    norm = txt   # _read already normalized to LF
    paras = re.split(r"(\n\s*\n)", norm)   # keep separators so we can rejoin verbatim
    changed = False
    for i in range(0, len(paras), 2):
        para = paras[i]
        line = " ".join(x.strip() for x in para.strip().split("\n")).strip()
        if not line or line.startswith("#"):
            continue
        a_str, year, suffix, _rest = _split_authors_year(line)
        if not year:
            continue
        lead = _parse_authors(a_str)
        lead0 = lead[0] if lead else a_str
        surn = lead0.split(",")[0].strip()
        k = _norm_key(_lead_surname_phrase(surn)) + "|" + year + suffix
        if k == key:
            paras[i] = new_line
            changed = True
            break
    if not changed:
        return False
    _atomic_write(p, txt, _restore_nl("".join(paras), was_crlf), label="references")
    return True


def edit_reference(vault, slug, rel, citekey, text, here=None,
                   note_mtime=None, force=True):
    line = _one_line(text)
    if not line:
        return {"error": "empty reference text"}
    fields = _parse_asa_fields(line, {}, "")
    out = {"ok": True, "note": False, "frontmatter": False, "bib": False,
           "bibInserted": False, "refsMd": False, "entry": line}

    # 1) note: '## Citation' block + frontmatter (resolution keys fill-only)
    p = _source_note_path(vault, rel) if rel else None
    if p is not None:
        old = _read(p)
        if old is not None:
            was_crlf = _file_is_crlf(p)
            base = old   # _read already normalized to LF
            new = _replace_citation_block(base, line)
            cont = fields.get("container") or ""
            kind = fields.get("kind") or ""
            src = cont if kind in ("article", "chapter") else (fields.get("publisher") or "")
            ups = [
                ("author", _join_asa_authors(fields["authors"]) if fields.get("authors") else "", "fill"),
                ("year", (fields.get("year") or "") + (fields.get("suffix") or ""), "fill"),
                ("title", fields.get("title") or "", "sync"),
                ("source", src, "sync"),
                ("volume", fields.get("vol") or "", "sync"),
                ("issue", fields.get("issue") or "", "sync"),
                ("pages", fields.get("pages") or "", "sync"),
                ("doi", fields.get("doi") or "", "sync"),
                ("source-type", kind if kind in ("article", "book", "chapter") else "", "sync"),
            ]
            new_lf = _update_frontmatter(new, ups)
            if new_lf != base:
                cur = _mt(p)
                if note_mtime is not None and not force and cur != _as_int(note_mtime):
                    return {"conflict": True, "currentMtime": cur, "which": "note"}
                _atomic_write(p, old, _restore_nl(new_lf, was_crlf), label="citation")
                out["note"] = True
                out["frontmatter"] = base.lstrip().startswith("---")
                out["noteMtime"] = _mt(p)

    # 2) library.bib (keyed by citekey; merged + re-emitted)
    if citekey:
        bibp = Path(vault) / Path(*LIBRARY_BIB)
        btxt = _read(bibp)
        if btxt is not None:
            was_crlf = _file_is_crlf(bibp)
            base = btxt   # _read already normalized to LF
            ex_type, _ck, ex_fields, ex_vsrc = "", "", {}, ""
            mm = re.search(r"(?ms)^@\w+\{\s*" + re.escape(citekey) + r"\s*,.*?^\}[ \t]*$", base)
            if mm:
                ex_type, _ck, ex_fields, ex_vsrc = _parse_bib_entry(mm.group(0))
            bibtype = _bibtype_for(fields.get("kind"), ex_type)
            kv = _merge_bib_fields(fields, ex_fields, bibtype)
            vsrc = ex_vsrc or (rel or "").replace("\\", "/").lstrip("/")
            entry = _emit_bib_entry(bibtype, citekey, kv, vsrc)
            newb, inserted = _replace_or_insert_bib(base, citekey, entry)
            if newb != base:
                _atomic_write_bib(bibp, btxt, _restore_nl(newb, was_crlf))
                out["bib"] = True
                out["bibInserted"] = inserted

    if fields.get("authors") and fields.get("year"):
        lead0 = fields["authors"][0]
        surn = lead0.split(",")[0].strip()
        key = _norm_key(_lead_surname_phrase(surn)) + "|" + fields["year"] + (fields.get("suffix") or "")
        out["refsMd"] = _update_prior_reference(vault, slug, key, line)

    return out


def _atomic_write_bib(p, old, text):
    p = Path(p)
    p.parent.mkdir(parents=True, exist_ok=True)
    if old is not None:
        bdir = p.parent / ".bib-backups"
        try:
            bdir.mkdir(exist_ok=True)
            ts = time.strftime("%Y%m%d-%H%M%S-") + str(int(time.time() * 1000) % 1000).zfill(3)
            (bdir / ("library." + ts + ".bib")).write_text(old, encoding="utf-8")
            files = sorted(bdir.glob("library.*.bib"))
            for f in files[:-200]:
                try:
                    f.unlink()
                except OSError:
                    pass
        except OSError:
            pass
    fd, tmppath = tempfile.mkstemp(dir=str(p.parent), prefix=".library.", suffix=".bib.tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
            f.flush()
            try:
                os.fsync(f.fileno())
            except OSError:
                pass
        os.replace(tmppath, str(p))
    except OSError:
        try:
            os.unlink(tmppath)
        except OSError:
            pass
        raise


# ----------------------------------------------------------------- CLI
def _default_vault():
    return settings.VAULT


def _selftest(here):
    # tiny smoke test on the index (read-only).
    idx = load_resolver_index(here)
    print("resolver keys:", len(idx))
    sample = resolve_cites("(Fakename 2001; Placeholder 2002)", idx)
    print("resolved:", [(r["token"], r["citekey"]) for r in sample["resolved"]])
    print("unresolved:", sample["unresolved"])
    print("ambiguous:", [(a["token"], len(a["candidates"])) for a in sample["ambiguous"]])
    print("OK")


if __name__ == "__main__":
    import sys
    here = Path(__file__).resolve().parent
    args = sys.argv[1:]
    cmd = args[0] if args else "selftest"
    if cmd == "resolver":
        idx = build_resolver_index(here)
        print("built resolver-index.json with", len(idx), "keys")
    elif cmd == "refs":
        slug = args[1]
        style = args[2] if len(args) > 2 else "asa"
        vault = _default_vault()
        idx = load_resolver_index(here)
        wdir = _writing_dir(vault, slug)
        paper = _read(wdir / "paper.md") if wdir else None
        if paper is None:
            print("paper.md not found for slug:", slug); sys.exit(1)
        b = build_references(paper, vault, idx, style, slug)
        print(b["markdown"])
        print("\n--- audit ---")
        print(json.dumps(b["audit"], ensure_ascii=False, indent=2)[:2000])
    elif cmd == "write":
        slug = args[1]
        style = args[2] if len(args) > 2 and not args[2].startswith("--") else "asa"
        md = None
        if "--mark-unresolved" in args:
            vault = _default_vault()
            wdir = _writing_dir(vault, slug)
            paper = _read(wdir / "paper.md") if wdir else None
            if paper is None:
                print("paper.md not found for slug:", slug); sys.exit(1)
            md = build_references(paper, vault, load_resolver_index(here), style, slug,
                                  mark_unresolved=True)["markdown"]
        print(json.dumps(write_references(_default_vault(), slug, style, here=here, markdown=md),
                         ensure_ascii=False))
    else:
        _selftest(here)
