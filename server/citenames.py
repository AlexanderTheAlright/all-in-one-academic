import re
import unicodedata

PARTICLES = {"van", "von", "de", "del", "della", "di", "da", "la", "le", "der",
             "den", "dos", "abu", "vander", "ten", "ter", "du", "dem", "st"}
YEAR = r"(?:1[6-9]\d\d|20\d\d)"
_STEM = re.compile(r"^(.+?)\s+\((" + YEAR + r")([a-z]?)\)")
_INITIALS = re.compile(r"^(?:[A-Z]\.[\s-]*)+$|^[A-Z]{1,3}$")
_SUFFIX = re.compile(r"^(?:Jr\.?|Sr\.?|II|III|IV|eds?\.?|Eds?\.?|trans\.?)$")
_JOIN = re.compile(r"\s*(?:,\s*and\s+|,\s*&\s*|\s+and\s+|\s*&\s*|;\s*|,\s*)")


def fold(s):
    s = unicodedata.normalize("NFKD", s or "")
    return "".join(c for c in s if not unicodedata.combining(c))


def key(s):
    return re.sub(r"[^a-z]", "", fold(s).lower())


def _dewiki(s):
    return re.sub(r"\[\[([^\]|]+)(?:\|([^\]]*))?\]\]",
                  lambda m: (m.group(2) or m.group(1)).strip(), str(s or "")).strip()


def _trailing_surname(name):
    toks = [t for t in re.split(r"\s+", name.strip()) if t]
    while len(toks) > 1 and _SUFFIX.match(toks[-1].strip(",")):
        toks.pop()
    if not toks:
        return ""
    i = len(toks) - 1
    out = [toks[i]]
    while i - 1 >= 0 and key(toks[i - 1]) in PARTICLES:
        i -= 1
        out.insert(0, toks[i])
    return " ".join(out).strip(",")


def join(surnames, etal=False):
    """ASA 7th in-text label from an ordered surname list."""
    s = [x for x in surnames if x]
    if not s:
        return ""
    if etal or len(s) >= 3:
        return s[0] + " et al."
    if len(s) == 2:
        return s[0] + " and " + s[1]
    return s[0]


# ------------------------------------------------------------------ witness 1: filename
def from_stem(stem):
    m = _STEM.match(stem or "")
    if not m:
        return None
    lab = m.group(1).strip()
    if re.search(r"\bet al\.?$", lab):
        lead = re.sub(r",?\s*et al\.?$", "", lab).strip()
        return (lead + " et al.", m.group(2), m.group(3))
    parts = [p for p in _JOIN.split(lab) if p]
    return (join(parts), m.group(2), m.group(3))


# ------------------------------------------------------------------ witness 2: citation line
def _authors_part(line):
    line = re.sub(r"[*_]", "", line or "").strip()
    m = re.search(r"^(.*?)\s*\(\s*" + YEAR + r"[a-z]?\s*[,)]", line)
    if m and len(m.group(1)) < 400:
        return m.group(1).strip().rstrip(",").strip()
    m = re.search(r"^(.*?)\.\s*" + YEAR + r"[a-z]?\s*[.,]", line)          # ASA ". 2018."
    if m and len(m.group(1)) < 400:
        return m.group(1).strip()
    return None


def _natural(c):
    toks = c.split()
    return len(toks) >= 2 and not _INITIALS.match(toks[-1])


def from_citation(line):
    """Surnames from an ASA or APA reference line: {'surnames', 'etal', 'sure'}, or None."""
    a = _authors_part(line)
    if not a:
        return None
    a = re.sub(r"\s*\((?:eds?|Eds?)\.?\)\s*$|(?:,\s*|\s+)(?:eds?|editors?)\.?$", "", a).strip()
    a = re.split(r",\s+with\s+", a)[0]
    etal = bool(re.search(r"\bet al\b", a))
    a = re.sub(r",?\s*et al\.?", "", a).strip().rstrip(",").strip()
    chunks = [c.strip() for c in _JOIN.split(a) if c and c.strip()]
    chunks = [c for c in chunks if not _SUFFIX.match(c)]
    if not chunks:
        return None
    sure = False
    if len(chunks) == 1:
        names, sure = [chunks[0]], " " not in chunks[0] and not etal
    elif _natural(chunks[0]) and _natural(chunks[1]):
        names = [_trailing_surname(c) for c in chunks]
        sure = all(_natural(c) for c in chunks)
    elif len(chunks) == 2 and re.match(r"^[^,&;]+,[^,&;]+$", a) and " and " not in a:
        names, sure = [chunks[0]], True
    elif _INITIALS.match(chunks[1]) and all(
            _INITIALS.match(c) for c in chunks[1::2]) and len(chunks) % 2 == 0:
        # APA surname, initials pairs
        names, sure = chunks[0::2], True
    elif len(chunks) == 2 or all(_natural(c) for c in chunks[2:]):
        names = [chunks[0]] + [_trailing_surname(c) for c in chunks[2:]]
        sure = len(chunks) == 2 and not re.match(r"^[^,]+ and ", a) and (
            _INITIALS.match(chunks[1]) or etal) or len(chunks) > 2
        if len(chunks) == 2 and not re.match(r"^[^,;&]+,", a):
            names = [chunks[0], _trailing_surname(chunks[1])]
            sure = False
    else:
        # surname-only or inverted pairs without initials: every chunk a name, unsure
        names = [c if " " not in c else _trailing_surname(c) for c in chunks]
    names = [n if _INITIALS.match(n) else n.rstrip(".") for n in names]
    names = [n for n in names if n and re.match(r"[^\W\d]", n)]
    if not names:
        return None
    return {"surnames": names, "etal": etal, "sure": bool(sure)}


# ------------------------------------------------------------------ witness 3: frontmatter
def from_frontmatter(v):
    items = v if isinstance(v, list) else ([v] if v else [])
    items = [_dewiki(x).strip() for x in items if str(x or "").strip()]
    if not items:
        return None
    if len(items) == 1:
        s = items[0]
        if re.search(r"\bet al\b", s):
            return {"surnames": [re.split(r",|\s+et al", s)[0].strip()], "etal": True}
        if ";" in s:
            items = [x.strip() for x in s.split(";") if x.strip()]
        else:
            chunks = [c for c in _JOIN.split(s) if c]
            if len(chunks) == 1:
                return {"surnames": [chunks[0] if " " not in chunks[0] or re.search(
                    r"\b(of|for|and|the)\b|[A-Z]{2,}", chunks[0]) else _trailing_surname(chunks[0])],
                        "etal": False}
            if any(_INITIALS.match(c) for c in chunks[1:]):
                return {"surnames": [c for c in chunks if not _INITIALS.match(c)
                                     and " " not in c.strip()], "etal": False}
            return {"surnames": [_trailing_surname(c) if " " in c else c for c in chunks],
                    "etal": False}
    out = []
    for it in items:
        if "," in it:
            out.append(it.split(",")[0].strip())
        elif re.search(r"\b(of|for|and|the)\b|[A-Z]{2,}", it):
            out.append(it)                                # 'Bank of Somewhere', 'ABCD'
        else:
            out.append(_trailing_surname(it))             # 'Given M. Fakename'
    return {"surnames": out, "etal": False}


# ------------------------------------------------------------------ the decision
def _count(lab):
    return 3 if lab.endswith("et al.") else (2 if " and " in lab else 1)


def _lab(w):
    return join(w["surnames"], w["etal"]) if w else ""


def witnesses(stem, citation_line, fm_author):
    f = from_stem(stem)
    return {"filename": f[0] if f else "",
            "citation": _lab(from_citation(citation_line)),
            "frontmatter": _lab(from_frontmatter(fm_author))}


def _base(lab):
    toks = lab.split(" and ")[0].replace(" et al.", "").split()
    toks = [t for t in toks if key(t) not in PARTICLES] or toks
    return key(" ".join(toks[-1:]))


def _near(a, b):
    """edit distance <= 2 between two keys (a typo, a dropped accent)"""
    if abs(len(a) - len(b)) > 2:
        return False
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1] <= 2


def _same_people(fn, cit):
    f = [key(x) for x in fn.replace(" et al.", "").split(" and ")]
    c = [key(x) for x in cit.replace(" et al.", "").split(" and ")]
    if len(f) == len(c) == 2 and sorted(f) == sorted(c):
        return True
    lf, lc = f[0], c[0]
    if not lf or not lc:
        return False
    return (lf.endswith(lc) or lc.endswith(lf)       # 'givenfakename' / 'two-part-surname'
            or lf.startswith(lc)
            or _near(lf, lc))                        # a one-letter typo


_MOJIBAKE = re.compile(r"[ÃÂÄÔ][\x80-\xbf‡¸¼]|Ã|Ô")


def _better_spelled(fn, cit):
    if _MOJIBAKE.search(cit):
        return False
    lead_f = fn.split(" and ")[0].replace(" et al.", "")
    lead_c = cit.split(" and ")[0].replace(" et al.", "")
    if any(ord(ch) > 127 for ch in lead_f) and not any(ord(ch) > 127 for ch in lead_c):
        return False
    return True


def label(stem, citation_line, fm_author):
    """(label, witness, doubt) -- the in-text author, which witness supplied it, and a
    reason string when the witnesses disagree in a way a person should look at."""
    fn_t = from_stem(stem)
    fn = fn_t[0] if fn_t else ""
    cw = from_citation(citation_line)
    cit = _lab(cw)
    if not fn:
        if cit:
            return cit, "citation", ""
        return _lab(from_frontmatter(fm_author)), "frontmatter", ""
    if not cit or key(fn) == key(cit):
        return fn, "filename", ""
    if _base(fn) != _base(cit):
        if cw.get("sure") and _same_people(fn, cit) and _better_spelled(fn, cit):
            return cit, "citation", "filename names the author wrongly: %r -> %r" % (fn, cit)
        return fn, "filename", "lead author differs: filename %r, citation %r" % (fn, cit)
    if not cw.get("sure"):
        if _count(fn) != _count(cit):
            return fn, "filename", "author count unclear: filename %r, citation %r" % (fn, cit)
        return fn, "filename", ""
    if _count(fn) != _count(cit):
        return cit, "citation", "filename author count wrong: %r -> %r" % (fn, cit)
    fl, cl = fn.split(" and ")[0].replace(" et al.", ""), cit.split(" and ")[0].replace(" et al.", "")
    if len(cl) > len(fl) and cl.endswith(fl) and not re.search(r"[:;]", cl):
        return cit, "citation", "filename dropped a particle: %r -> %r" % (fn, cit)
    return fn, "filename", ""
