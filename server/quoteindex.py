#!/usr/bin/env python3
"""quoteindex.py — deterministic quote-integrity index over the reading vault."""
import settings
import argparse
import hashlib
import json
import os
import re
import sqlite3
import sys
import time
import unicodedata
from pathlib import Path

NORM_VERSION = "qi-7"

B1_MAX_LOOSE = 24

W2B_MAX_SKIP = 1500
W2B_MIN_TAIL = 40
W2B_MIN_HEAD = 4

M7_FREQ_MAX = 3
M7_EDITR_MAX = 0.50
M7_ANCHOR_MIN_FRAC = 0.25

# ------------------------------------------------------------------ locations
VAULT = settings.VAULT
CITATIONS = VAULT / "Preparation/Reading/Citations"
CORPUS = VAULT / "Preparation/Reading/Corpus"
PAPERS = VAULT / "Projects/papers"



def db_path():
    env = os.environ.get("QUOTE_INDEX_DB")
    if env:
        return Path(env)
    base = settings.STATE_DIR
    try:
        base.mkdir(parents=True, exist_ok=True)
    except OSError:
        pass
    return base / "quote-integrity.sqlite"


# ------------------------------------------------------------ normalization (FROZEN)
_LIG = {"ﬁ": "fi", "ﬂ": "fl", "ﬀ": "ff", "ﬃ": "ffi", "ﬄ": "ffl", "ﬅ": "ft", "ﬆ": "st"}
_GREEK = {"α": "alpha", "β": "beta", "γ": "gamma", "δ": "delta", "ε": "epsilon",
          "ζ": "zeta", "η": "eta", "θ": "theta", "ι": "iota", "κ": "kappa",
          "λ": "lambda", "μ": "mu", "ν": "nu", "ξ": "xi", "π": "pi",
          "ρ": "rho", "σ": "sigma", "ς": "sigma", "τ": "tau", "υ": "upsilon",
          "φ": "phi", "χ": "chi", "ψ": "psi", "ω": "omega"}


def _fold(s):
    if not s:
        return ""
    s = unicodedata.normalize("NFKD", s)
    s = s.replace("­", "")
    for k, v in _LIG.items():
        s = s.replace(k, v)
    s = s.casefold()                               # F4
    if any(c in _GREEK for c in s):                # F5
        s = "".join(_GREEK.get(c, c) for c in s)
    return s


def qnorm_loose(s):
    return re.sub(r"[^a-z0-9]+", "", _fold(s))


def qnorm_words(s):
    s = _fold(s)
    s = re.sub(r"-\s*\n\s*", "", s)
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


LOOSE_MIN = 25   # M3
WORD_MIN = 10    # M3
LAYER_MEDIAN_WORDS = 40   # usable-text-layer floor
PROSE_MIN_LOOSE = 40      # prose-span capture floor


# ------------------------------------------------------------------ note parsing
LINK_RE = re.compile(
    r"\[\[(?P<file>[^\]#|]+\.pdf)"
    r"(?:#page=(?P<page>\d+))?"
    r"(?:&selection=(?P<sel>[0-9,]+))?"
    r"(?:&color=(?P<color>[A-Za-z]+))?"
    r"(?:\|(?P<disp>[^\]]+))?\]\]"
)
_PRINTED_RE = re.compile(r",\s*pp?\.\s*([0-9ivxlc]+)", re.I)
_QUOTED_SPAN = re.compile(r'["“]([^"“”]{20,2000})["”]')


def _read_note(path):
    return Path(path).read_text(encoding="utf-8", errors="replace")


def strip_block_apparatus(text):
    """P1 + P4/P5 + P2, applied to one quote block's assembled text."""
    t = (text or "").strip()
    t = re.sub(r"\(\s*pp?\.?\s*[0-9ivxlc][0-9ivxlc\-–—,\s]*\)\s*$", "", t,
               flags=re.I).strip()
    t = _TRAIL_ANNOT.sub("", t).strip()
    t = _TRAIL_ATTRIB_BRACKET.sub("", t).strip()
    if len(t) > 2 and t[0] in "\"“" and t[-1] in "\"”":
        t = t[1:-1].strip()
    return t


def parse_note_quotes(text):
    """Return [{kind, line, text, file, cited_phys, cited_printed, has_selection}]
    for one note. Deterministic, whole-body. Lines are 1-based."""
    lines = text.splitlines()
    # skip YAML frontmatter for prose scanning (block scan is link-anchored, safe)
    fm_end = 0
    if lines and lines[0].strip() == "---":
        for i in range(1, len(lines)):
            if lines[i].strip() == "---":
                fm_end = i
                break
    out = []
    covered = set()   # line indices consumed by block quotes
    cur = None
    in_fence = False

    def close(block):
        if block is None:
            return
        t = strip_block_apparatus(block["text"])
        if len(t) > 15:
            out.append(block | {"text": t})
        for i in block["lines"]:
            covered.add(i)

    for i, ln in enumerate(lines):
        s = ln.strip()
        if s.startswith("```"):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        m = LINK_RE.search(ln) if s.startswith(">") else None
        if m:
            close(cur)
            disp = (m.group("disp") or "").strip()
            pm = _PRINTED_RE.search(disp)
            cur = {
                "kind": "block", "line": i + 1, "text": "", "lines": [i],
                "file": Path(m.group("file")).name,
                "cited_phys": int(m.group("page")) if m.group("page") else None,
                "cited_printed": pm.group(1) if pm else None,
                "has_selection": 1 if (m.group("sel") and len(m.group("sel").split(",")) == 4
                                       and any(x != "0" for x in m.group("sel").split(","))) else 0,
            }
            raw_pre = ln[:m.start()].strip().lstrip(">").strip()
            cite_only = bool(raw_pre.startswith("(")
                             and not _CITE_PAREN.sub("", raw_pre).strip())
            pre = raw_pre.strip("(").strip()
            pre = pre.strip('"').strip("“”").strip()
            if len(pre) > 15 and not cite_only:
                cur["text"] += pre + " "
            tail = ln[m.end():].strip()
            if tail and tail not in (")", ""):
                cur["text"] += tail.lstrip(")").strip().strip('"').strip() + " "
            # alias form: display itself is the quote ("...")
            dq = re.search(r'["“](.{20,})["”]\s*$', disp)
            if dq and not cur["text"]:
                out.append({
                    "kind": "alias", "line": i + 1, "text": dq.group(1).strip(),
                    "file": cur["file"], "cited_phys": cur["cited_phys"],
                    "cited_printed": cur["cited_printed"],
                    "has_selection": cur["has_selection"],
                })
                covered.add(i)
                cur = None
            continue
        if cur is not None and s.startswith(">"):
            t = s.lstrip(">").strip()
            if t:
                cur["text"] += t + " "
                cur["lines"].append(i)
            continue
        if cur is not None:
            close(cur)
            cur = None
    close(cur)

    # prose spans (advisory): quoted strings outside blockquotes / fences / fm
    in_fence = False
    for i, ln in enumerate(lines):
        s = ln.strip()
        if s.startswith("```"):
            in_fence = not in_fence
            continue
        if in_fence or i <= fm_end or i in covered or s.startswith(">"):
            continue
        for m in _QUOTED_SPAN.finditer(ln):
            t = m.group(1).strip()
            if len(qnorm_loose(t)) >= PROSE_MIN_LOOSE:
                out.append({"kind": "prose", "line": i + 1, "text": t,
                            "file": None, "cited_phys": None,
                            "cited_printed": None, "has_selection": 0})
    for b in out:
        b.pop("lines", None)
    return out


# ------------------------------------------------------------------ schema
_SCHEMA = """
CREATE TABLE IF NOT EXISTS notes (
  note_path  TEXT PRIMARY KEY,   -- vault-relative, forward slashes
  surface    TEXT,               -- 'citations' | 'corpus'
  note_sha   TEXT,
  pdf_path   TEXT,               -- vault-relative or NULL
  pdf_sig    TEXT,               -- "size:mtime_ns" at last check
  n_quotes   INTEGER,
  norm_version TEXT,
  checked_at INTEGER
);
CREATE TABLE IF NOT EXISTS quotes (
  note_path     TEXT,
  quote_idx     INTEGER,
  kind          TEXT,            -- block | alias | prose
  advisory      INTEGER,         -- 1 for prose rows (excluded from headline counts)
  line          INTEGER,
  quote_text    TEXT,
  cited_phys    INTEGER,
  cited_printed TEXT,
  has_selection INTEGER,
  pdf_path      TEXT,
  verdict       TEXT,            -- VERIFIED | VIOLATION | UNVERIFIABLE
  reason        TEXT,            -- pdf_missing | pdf_unreadable | no_text_layer | too_short | not_in_pdf
  match_form    TEXT,            -- page | span | column | column-span | word
  found_page    INTEGER,
  page_ok       INTEGER,         -- 1 if found on its cited #page (NULL: no cite/no find)
  norm_version  TEXT,
  note_sha      TEXT,
  pdf_sha       TEXT,
  checked_at    INTEGER,
  PRIMARY KEY (note_path, quote_idx)
);
CREATE TABLE IF NOT EXISTS crosscheck (
  note_path  TEXT,
  quote_idx  INTEGER,
  doc_path   TEXT,               -- vault-relative manuscript path
  line       INTEGER,
  checked_at INTEGER,
  PRIMARY KEY (note_path, quote_idx, doc_path)
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE INDEX IF NOT EXISTS ix_quotes_verdict ON quotes(verdict);
CREATE INDEX IF NOT EXISTS ix_quotes_pdf ON quotes(pdf_path);
"""


def connect(path=None):
    p = Path(path) if path else db_path()
    con = sqlite3.connect(str(p), timeout=30)
    con.execute("PRAGMA busy_timeout=15000")
    con.execute("PRAGMA journal_mode=DELETE")
    con.executescript(_SCHEMA)
    return con


def _is_readonly(sql):
    s = sql.strip().lstrip("(").lstrip().lower()
    return s.startswith("select") or s.startswith("with")


def query(sql, path=None, as_dicts=False):
    if not _is_readonly(sql):
        raise ValueError("read-only: only SELECT / WITH queries are allowed")
    con = connect(path)
    try:
        con.row_factory = sqlite3.Row
        cur = con.execute(sql)
        rows = cur.fetchall()
        cols = [d[0] for d in cur.description] if cur.description else []
        if as_dicts:
            return [dict(r) for r in rows]
        return cols, [tuple(r) for r in rows]
    finally:
        con.close()


def summary(path=None):
    con = connect(path)
    try:
        con.row_factory = sqlite3.Row
        out = {"norm_version": NORM_VERSION, "db": str(path or db_path())}
        out["actionable"] = [dict(r) for r in con.execute(
            "SELECT verdict, COUNT(*) n FROM quotes WHERE advisory=0 "
            "GROUP BY verdict ORDER BY verdict")]
        out["advisory_prose"] = [dict(r) for r in con.execute(
            "SELECT verdict, COUNT(*) n FROM quotes WHERE advisory=1 "
            "GROUP BY verdict ORDER BY verdict")]
        out["reasons"] = [dict(r) for r in con.execute(
            "SELECT verdict, reason, COUNT(*) n FROM quotes WHERE advisory=0 "
            "AND verdict!='VERIFIED' GROUP BY verdict, reason ORDER BY n DESC")]
        out["surfaces"] = [dict(r) for r in con.execute(
            "SELECT n.surface, q.verdict, COUNT(*) n FROM quotes q "
            "JOIN notes n ON n.note_path=q.note_path WHERE q.advisory=0 "
            "GROUP BY n.surface, q.verdict ORDER BY n.surface, q.verdict")]
        out["notes_indexed"] = con.execute("SELECT COUNT(*) FROM notes").fetchone()[0]
        r = con.execute("SELECT value FROM meta WHERE key='last_sweep'").fetchone()
        out["last_sweep"] = r[0] if r else None
        return out
    finally:
        con.close()


def _pdf_pages(pdf):
    """One text string per page, in the PDF's own reading order."""
    fitz = settings.require_pymupdf()
    with fitz.open(str(pdf)) as doc:
        return [page.get_text() for page in doc]


def _pdf_pages_columns(pdf):
    """One text string per page with the left half's blocks before the right half's,
    for two-column pages whose stored order interleaves the columns."""
    fitz = settings.require_pymupdf()
    out = []
    with fitz.open(str(pdf)) as doc:
        for page in doc:
            mid = page.rect.width / 2
            blocks = [b for b in page.get_text("blocks") if len(b) > 6 and b[6] == 0]
            blocks.sort(key=lambda b: (b[0] >= mid, b[1], b[0]))
            out.append("\n".join(b[4] for b in blocks))
    return out


def _strip_running_heads(text):
    """Drop a short first and last line (running head, page number) from a page."""
    lines = [ln for ln in text.splitlines() if ln.strip()]
    if len(lines) > 2 and len(lines[0]) <= 80:
        lines = lines[1:]
    if len(lines) > 2 and len(lines[-1]) <= 80:
        lines = lines[:-1]
    return "\n".join(lines)


def _levenshtein(a, b, cap):
    """Edit distance between a and b, or cap + 1 as soon as it must exceed cap."""
    if abs(len(a) - len(b)) > cap:
        return cap + 1
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        if min(cur) > cap:
            return cap + 1
        prev = cur
    return prev[-1]


def _stat_sig(p):
    st = os.stat(p)
    return f"{st.st_size}:{st.st_mtime_ns}"


def _sha256_file(p):
    h = hashlib.sha256()
    with open(p, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _rel(p):
    try:
        return str(Path(p).relative_to(VAULT)).replace("\\", "/")
    except ValueError:
        return str(p).replace("\\", "/")


_SNAKE_IX = None


def _snake(s):
    return re.sub(r"_+", "_", re.sub(r"[^a-z0-9]+", "_", s.lower())).strip("_")


def _corpus_snake_index():
    """snake(stem) -> canonical Corpus PDF; project pdfs/ copies use
    snake_case names of the same works."""
    global _SNAKE_IX
    if _SNAKE_IX is None:
        _SNAKE_IX = {}
        for p in CORPUS.glob("*.pdf"):
            _SNAKE_IX.setdefault(_snake(p.stem), p)
    return _SNAKE_IX


def _resolve_pdf(fm_pdf_rel, link_file, note_dir):
    if fm_pdf_rel:
        cand = VAULT / fm_pdf_rel.replace("\\", "/")
        if cand.is_file():
            return cand
    if link_file:
        for cand in (CORPUS / link_file,
                     Path(note_dir) / link_file,
                     Path(note_dir) / "pdfs" / link_file):
            if cand.is_file():
                return cand
        sp = _corpus_snake_index().get(_snake(Path(link_file).stem))
        if sp is not None and sp.is_file():
            return sp
    return None


def _fm_pdf(text):
    m = re.search(r"^pdf-path:\s*(.+?)\s*$", text, re.M)
    if m:
        v = m.group(1).strip().strip('"').strip("'")
        if v.lower().endswith(".pdf"):
            return v
    return None


_CITE_PAREN = re.compile(
    r"\((?=[^()]{0,90}\))(?:[^()]*\b1[89]\d{2}[a-z]?\b[^()]*"
    r"|[^()]*\b20\d{2}[a-z]?\b[^()]*"
    r"|\s*(?:see|cf\.|e\.g\.|i\.e\.)[^()]*"
    r"|\s*pp?\.?\s*[0-9ivxlc][0-9ivxlc\-–—,\s]*)\)")


def _strip_cites(s):
    return _CITE_PAREN.sub(" ", s)


_ATTRIB_PAREN = re.compile(
    r"\([^()]{0,120}?\b(?:as\s+(?:quoted|cited)\s+(?:by|in)|quoted\s+in"
    r"|cited\s+in)\b[^()]{0,120}?\)", re.I)


def _strip_attrib(s):
    return _ATTRIB_PAREN.sub(" ", s)


_TRAIL_ANNOT = re.compile(r"\s*\*\s*Use for\s*:\s[^*]{10,}\*\s*$", re.S | re.I)
_TRAIL_ATTRIB_BRACKET = re.compile(
    r"\s*\[[^\]]{0,80}?\b(?:citing|cited(?:\s+in)?|quoting|quoted(?:\s+in)?"
    r"|see|cf\.)\b[^\]]{0,80}?\]\s*$", re.I)


_BRACKET_ALT = re.compile(r"\[(?!\s*(?:\.{3,}|…)\s*\])[^\[\]]{1,40}\]")


def _match_bracketed(qtext, pt):
    if not _BRACKET_ALT.search(qtext):
        return None, False
    raw_segs = _BRACKET_ALT.split(qtext)
    brackets = _BRACKET_ALT.findall(qtext)
    keep = [(i, qnorm_loose(s)) for i, s in enumerate(raw_segs)]
    segs = [(i, s) for i, s in keep if len(s) >= 8]   # drop connective crumbs
    if len(segs) < 2 or sum(len(s) for _, s in segs) < LOOSE_MIN:
        return None, False
    trip = False
    bracket_digits = [set(re.findall(r"\d+", b)) for b in brackets]
    for i, pg in enumerate(pt.loose):
        at, gaps, ok = 0, 0, True
        for n, (si, s) in enumerate(segs):
            j = pg.find(s, at)
            if j < 0:
                ok = False
                break
            if n:
                gap = j - at
                if gap > B1_MAX_LOOSE:               # the bound
                    ok = False
                    break
                skipped = pg[at:j]
                # brackets sitting between the previous kept segment and this
                # one are the only ones licensed to explain the skipped text
                allowed = set()
                for bi in range(segs[n - 1][0], si):
                    if bi < len(bracket_digits):
                        allowed |= bracket_digits[bi]
                if any(d not in allowed for d in re.findall(r"\d+", skipped)):
                    ok = False
                    trip = True          # matched but for the digit guard
                    break
                gaps += gap
            at = j + len(s)
        if ok:
            return (i + 1, gaps), trip
    return None, trip


_ELLIPSIS = re.compile(r"\[\s*(?:\.{3,}|…)\s*\]|\.{3,}|…")


class _PdfText:
    """Extracted, normalized page text for one PDF, computed once."""

    def __init__(self, pdf):
        self.pages_raw = _pdf_pages(pdf)
        self.loose = [qnorm_loose(p) for p in self.pages_raw]
        stripped = [_strip_running_heads(p) for p in self.pages_raw]
        self.span_loose = [qnorm_loose(stripped[i] + " " + stripped[i + 1])
                          for i in range(len(stripped) - 1)]
        self.words = [qnorm_words(p) for p in self.pages_raw]
        wc = sorted(len(w.split()) for w in self.words) or [0]
        self.median_words = wc[len(wc) // 2]
        self.has_layer = self.median_words >= LAYER_MEDIAN_WORDS
        self._col = None
        self._cites = None
        self._tokfreq = None
        self._pdf = pdf

    def col(self):
        if self._col is None:
            raw = _pdf_pages_columns(self._pdf)
            self._col = ([qnorm_loose(p) for p in raw],
                         [qnorm_loose(raw[i] + " " + raw[i + 1])
                          for i in range(len(raw) - 1)])
        return self._col

    def cites(self):
        if self._cites is None:
            raw = [_strip_cites(p) for p in self.pages_raw]
            self._cites = ([qnorm_loose(p) for p in raw],
                           [qnorm_loose(raw[i] + " " + raw[i + 1])
                            for i in range(len(raw) - 1)])
        return self._cites

    def tokfreq(self):
        if self._tokfreq is None:
            import collections
            c = collections.Counter()
            for p in self.pages_raw:
                c.update(_ctokens(p))
            self._tokfreq = c
        return self._tokfreq


def _digit_runs(qtext):
    """Digit runs of the quote (loose form keeps digits verbatim)."""
    return re.findall(r"[0-9]+", qnorm_loose(qtext))


def _degraded_match(qtext, pt):
    ql = qnorm_loose(qtext)
    cap = max(2, round(0.02 * len(ql)))
    offs = {0, len(ql) // 4, len(ql) // 2, 3 * len(ql) // 4, max(0, len(ql) - 24)}
    probes = [(o, ql[o:o + 24]) for o in sorted(offs) if len(ql[o:o + 24]) >= 12]
    druns = _digit_runs(qtext)
    cands = [(i + 1, pg) for i, pg in enumerate(pt.loose)] + \
            [(i + 1, pg) for i, pg in enumerate(pt.span_loose)]
    for pageno, pg in cands:
        for off, pr in probes:
            at = pg.find(pr)
            if at < 0:
                continue
            start = max(0, at - off)
            best = cap + 1
            for s in (start, max(0, start - cap)):
                for L in (len(ql) - cap, len(ql), len(ql) + cap):
                    d = _levenshtein(ql, pg[s:s + max(L, 1)], cap)
                    best = min(best, d)
            if best <= cap:
                # digit guard on the ALIGNED WINDOW only: every digit run of
                # the quote must sit verbatim inside the matched span
                window = pg[max(0, start - cap):start + len(ql) + cap]
                if all(dr in window for dr in druns):
                    return pageno, best
    return None


def _longest_prefix_at(ql, q, pg, p):
    """Longest L with ql[q:q+L] present in pg at/after p -> (L, position)."""
    lo, hi = 0, len(ql) - q
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if pg.find(ql[q:q + mid], p) >= 0:
            lo = mid
        else:
            hi = mid - 1
    if lo <= 0:
        return 0, -1
    return lo, pg.find(ql[q:q + lo], p)


def _try_cover(ql, pg, q, p, budget, min_piece=12):
    """Greedy left-to-right verbatim cover from quote pos q / page pos p.
    A DIGIT may never be skipped — a changed figure must never ride a hole."""
    used = 0
    while q < len(ql):
        L, pos = _longest_prefix_at(ql, q, pg, p)
        rem = len(ql) - q
        if L >= min_piece or (L == rem and L >= 4):
            q += L
            p = pos + L
            continue
        if ql[q].isdigit():
            return None
        used += 1
        q += 1
        if used > budget:
            return None
    return used


def _cover_match(qtext, pt):
    ql = qnorm_loose(qtext)
    budget = max(2, round(0.02 * len(ql)))
    min_piece = 12
    druns = _digit_runs(qtext)
    cands = [(i + 1, pg) for i, pg in enumerate(pt.loose)] + \
            [(i + 1, pg) for i, pg in enumerate(pt.span_loose)]
    for pageno, pg in cands:
        if druns and not all(dr in pg for dr in druns):
            continue
        # anchor: first exact min_piece slice of the quote (skipping up to
        # budget damaged leading chars), tried at its first 5 occurrences
        q0 = 0
        while q0 <= budget:
            if pg.find(ql[q0:q0 + min_piece]) >= 0:
                break
            q0 += 1
        anchor = ql[q0:q0 + min_piece]
        if len(anchor) < min_piece or pg.find(anchor) < 0:
            continue
        at, tries = pg.find(anchor), 0
        while at >= 0 and tries < 5:
            used = _try_cover(ql, pg, q0, at, budget - q0)
            if used is not None:
                return pageno, used + q0
            at = pg.find(anchor, at + 1)
            tries += 1
    return None


def _damage_scan(qtext, pt):
    ql = qnorm_loose(qtext)
    if len(ql) < LOOSE_MIN:
        return False
    best = None
    cands = list(pt.loose) + list(pt.span_loose)
    for pg in cands:
        q = p = covered = 0
        holes = []
        hole = 0
        while q < len(ql):
            L, pos = _longest_prefix_at(ql, q, pg, p)
            if L >= 8:
                if hole:
                    holes.append(hole)
                    hole = 0
                covered += L
                q += L
                p = pos + L
            else:
                hole += 1
                q += 1
        if hole:
            holes.append(hole)
        stat = (covered / len(ql), len(holes), max(holes) if holes else 0)
        if best is None or stat[0] > best[0]:
            best = stat
    if best is None:
        return False
    cov, nholes, maxhole = best
    return cov >= 0.60 and nholes >= 4 and maxhole <= 24


def _bridge_match(qtext, pt):
    """W2b: the quote splits at ONE cut across a page break, with page furniture
    (a table, an unrecognised footer) sitting between the halves on page A."""
    ql = qnorm_loose(qtext)
    if len(ql) < LOOSE_MIN:
        return None
    for i in range(len(pt.loose) - 1):
        a, b = pt.loose[i], pt.loose[i + 1]
        hi = len(ql) - W2B_MIN_TAIL
        for cut in range(hi, W2B_MIN_HEAD - 1, -1):
            if not b.startswith(ql[cut:]):
                continue
            head = ql[:cut]
            at = a.rfind(head)
            if at < 0:
                continue
            skipped = len(a) - (at + len(head))
            if skipped <= W2B_MAX_SKIP:
                return i + 1, cut, skipped
    return None


_HYPH_BREAK = re.compile(r"[-­]\s*\n\s*")
_CWORD = re.compile(r"[a-z0-9]+")


def _dehyphen(s):
    return _HYPH_BREAK.sub("", s)


def _ctokens(s):
    return _CWORD.findall(_dehyphen(s).lower())


def _edit_ratio(a, b):
    import difflib
    if not a or not b:
        return 1.0
    return 1.0 - difflib.SequenceMatcher(None, a, b).ratio()


def _best_page_run(ql, pages_loose):
    """Page whose LONGEST CONTIGUOUS matching block with the quote is largest.
    Not ratio(): a long page wins on ratio by accident, which picked wrong
    pages on the first attempt at this signal."""
    import difflib
    best = (0, None)
    for i, pg in enumerate(pages_loose):
        m = difflib.SequenceMatcher(None, ql, pg, autojunk=False)\
            .find_longest_match(0, len(ql), 0, len(pg))
        if m.size > best[0]:
            best = (m.size, i)
    return best


def _divergence_tokens(quote, page_raw):
    import difflib
    qw, pw = _ctokens(quote), _ctokens(page_raw)
    if not qw or not pw:
        return []
    anchor = difflib.SequenceMatcher(None, qw, pw, autojunk=False)\
        .find_longest_match(0, len(qw), 0, len(pw))
    if anchor.size == 0:
        return []
    pad = len(qw)
    lo = max(0, anchor.b - anchor.a - pad)
    hi = min(len(pw), anchor.b - anchor.a + len(qw) + pad)
    win = pw[lo:hi]
    out = []
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(
            None, qw, win, autojunk=False).get_opcodes():
        # 'insert' is page text the NOTE skipped, i.e. an elision that E1/M5
        # own; it says nothing about damage.
        if tag in ("replace", "delete"):
            out.append((tag, qw[i1:i2], win[j1:j2]))
    return out


def _contrastive_damage(qtext, pt):
    ql = qnorm_loose(qtext)
    if len(ql) < LOOSE_MIN:
        return False
    size, pi = _best_page_run(ql, pt.loose)
    if pi is None:
        return False
    # ANCHOR-QUALITY GATE: with no real alignment there is no divergence point
    # and the window is noise. Abstain, which leaves the VIOLATION standing.
    if size < M7_ANCHOR_MIN_FRAC * len(ql):
        return False
    ops = _divergence_tokens(qtext, pt.pages_raw[pi])
    if not ops:
        return False
    freq = pt.tokfreq()
    for tag, note_ws, page_ws in ops:
        explained = False
        for pwd in page_ws:
            if freq[pwd] > M7_FREQ_MAX:
                continue
            near = min((_edit_ratio(pwd, nwd) for nwd in note_ws), default=1.0)
            if near <= M7_EDITR_MAX:
                explained = True
                break
        if not explained:
            return False
    return True


def _match_segments(qtext, pt):
    segs = [s.strip() for s in _ELLIPSIS.split(qtext)]
    segs = [s for s in segs if s]
    if len(segs) < 2:
        return None
    last_page, first_page, checked = 0, None, 0
    for s in segs:
        if len(qnorm_loose(s)) < LOOSE_MIN:
            qw = qnorm_words(s)
            if len(qw) < WORD_MIN:
                if len(qw) >= 4:
                    if not any(f" {qw} " in f" {pg} " for pg in pt.words):
                        return None
                continue
            hit = next((i + 1 for i, pg in enumerate(pt.words)
                        if i + 1 >= last_page and f" {qw} " in f" {pg} "), None)
            if hit is None:
                return None
            checked += 1
            first_page = first_page or hit
            last_page = hit
            continue
        v, _, _, fp = _match_quote(s, pt, _elide=False)
        if v != "VERIFIED" or (fp or 0) < last_page:
            return None
        checked += 1
        first_page = first_page or fp
        last_page = fp
    return (first_page, checked) if checked >= 1 else None


def _match_quote(qtext, pt, _elide=True):
    """(verdict, reason, match_form, found_page). pt: _PdfText."""
    ql = qnorm_loose(qtext)
    if len(ql) >= LOOSE_MIN:
        for i, pg in enumerate(pt.loose):                      # W1
            if ql in pg:
                return "VERIFIED", None, "page", i + 1
        for i, pg in enumerate(pt.span_loose):                 # W2
            if ql in pg:
                return "VERIFIED", None, "span", i + 1
        cl, cs = pt.col()                                      # W3
        for i, pg in enumerate(cl):
            if ql in pg:
                return "VERIFIED", None, "column", i + 1
        for i, pg in enumerate(cs):
            if ql in pg:
                return "VERIFIED", None, "column-span", i + 1
        qs = qnorm_loose(_strip_cites(qtext))                  # W4
        if len(qs) >= LOOSE_MIN:
            csl, css = pt.cites()
            for i, pg in enumerate(csl):
                if qs in pg:
                    return "VERIFIED", None, "cite-stripped", i + 1
            for i, pg in enumerate(css):
                if qs in pg:
                    return "VERIFIED", None, "cite-stripped-span", i + 1
        hit = _bridge_match(qtext, pt)                          # W2b
        if hit:
            return "VERIFIED", f"bridge_skip:{hit[2]}", "page-bridge", hit[0]
        qa = qnorm_loose(_strip_attrib(qtext))                  # A1
        if len(qa) >= LOOSE_MIN and qa != ql:
            for i, pg in enumerate(pt.loose):
                if qa in pg:
                    return "VERIFIED", None, "attrib-stripped", i + 1
            for i, pg in enumerate(pt.span_loose):
                if qa in pg:
                    return "VERIFIED", None, "attrib-stripped-span", i + 1
        hit, bracket_trip = _match_bracketed(qtext, pt)        # B1
        if hit:
            return "VERIFIED", f"bracket_gaps:{hit[1]}", "bracketed", hit[0]
        if _elide and _ELLIPSIS.search(qtext):                 # E1
            hit = _match_segments(qtext, pt)
            if hit:
                return "VERIFIED", f"segments:{hit[1]}", "elided", hit[0]
        if pt.has_layer:            # M4
            hit = _degraded_match(qtext, pt)
            if hit:
                return "VERIFIED", f"ocr_edits:{hit[1]}", "degraded", hit[0]
        if pt.has_layer:                                       # M5
            hit = _cover_match(qtext, pt)
            if hit:
                return "VERIFIED", f"cover_skips:{hit[1]}", "cover", hit[0]
        if not pt.has_layer:
            return "UNVERIFIABLE", "no_text_layer", None, None
        if _damage_scan(qtext, pt):                            # M6
            return "UNVERIFIABLE", "text_layer_damaged", None, None
        if bracket_trip:                                       # B1 digit guard
            return "UNVERIFIABLE", "bracket_digits_unreadable", None, None
        return "VIOLATION", "not_in_pdf", None, None
    qw = qnorm_words(qtext)
    if len(qw) >= WORD_MIN:
        for i, pg in enumerate(pt.words):
            if f" {qw} " in f" {pg} ":
                return "VERIFIED", None, "word", i + 1
        return ("VIOLATION", "not_in_pdf", None, None) if pt.has_layer \
            else ("UNVERIFIABLE", "no_text_layer", None, None)
    return "UNVERIFIABLE", "too_short", None, None


def check_note_quotes(note_abs, surface, pdf_cache):
    """Verdict every quote of one note. Returns (note_row, quote_rows)."""
    note_abs = Path(note_abs)
    text = _read_note(note_abs)
    note_sha = hashlib.sha256(text.encode("utf-8", "replace")).hexdigest()
    quotes = parse_note_quotes(text)
    now = int(time.time() * 1000)
    fm_rel = _fm_pdf(text)

    # the note-level PDF: frontmatter, else the first block link's file
    first_file = next((q["file"] for q in quotes if q.get("file")), None)
    note_pdf = _resolve_pdf(fm_rel, first_file, note_abs.parent)

    qrows = []
    pdf_sig_note = None
    for idx, q in enumerate(quotes):
        pdf = _resolve_pdf(fm_rel, q.get("file"), note_abs.parent) \
            if q.get("file") else note_pdf
        verdict, reason, mform, fpage, psha = None, None, None, None, None
        if pdf is None:
            verdict, reason = "UNVERIFIABLE", "pdf_missing"
        else:
            key = str(pdf)
            if key not in pdf_cache:
                try:
                    pdf_cache[key] = (_PdfText(pdf),
                                      _sha256_file(pdf), _stat_sig(pdf))
                except Exception:
                    pdf_cache[key] = None
            entry = pdf_cache[key]
            if entry is None:
                verdict, reason = "UNVERIFIABLE", "pdf_unreadable"
            else:
                pt, psha, sig = entry
                pdf_sig_note = pdf_sig_note or (sig if pdf == note_pdf else pdf_sig_note)
                verdict, reason, mform, fpage = _match_quote(q["text"], pt)
        page_ok = None
        if verdict == "VERIFIED" and q.get("cited_phys"):
            page_ok = 1 if fpage == q["cited_phys"] else 0
        qrows.append((
            _rel(note_abs), idx, q["kind"], 1 if q["kind"] == "prose" else 0,
            q["line"], q["text"], q.get("cited_phys"), q.get("cited_printed"),
            q.get("has_selection", 0), _rel(pdf) if pdf else None,
            verdict, reason, mform, fpage, page_ok,
            NORM_VERSION, note_sha, psha, now,
        ))
    if pdf_sig_note is None and note_pdf is not None:
        try:
            pdf_sig_note = _stat_sig(note_pdf)
        except OSError:
            pdf_sig_note = None
    note_row = (_rel(note_abs), surface, note_sha,
                _rel(note_pdf) if note_pdf else None, pdf_sig_note,
                len(quotes), NORM_VERSION, now)
    return note_row, qrows


def _indexable(name):
    return "sync-conflict-" not in name


def _iter_notes(surface=None):
    if surface in (None, "citations") and CITATIONS.is_dir():
        for p in sorted(CITATIONS.glob("*.md")):
            if _indexable(p.name):
                yield p, "citations"
    if surface in (None, "corpus") and PAPERS.is_dir():
        for proj in sorted(PAPERS.iterdir()):
            cdir = proj / "corpus"
            if cdir.is_dir():
                for p in sorted(cdir.glob("*.md")):
                    if not p.name.startswith("0.") and _indexable(p.name):
                        yield p, "corpus"


def _needs_check(con, note_abs, surface):
    """True unless (note sha unchanged, pdf sig unchanged, same norm version)."""
    rel = _rel(note_abs)
    r = con.execute("SELECT note_sha, pdf_path, pdf_sig, norm_version "
                    "FROM notes WHERE note_path=?", (rel,)).fetchone()
    if not r or r[3] != NORM_VERSION:
        return True
    if r[1] is None:
        # no PDF resolved last time — always retry; a PDF that arrives later
        # (download, OCR, pdfs/ copy) must lift pdf_missing without a --full
        return True
    try:
        text = _read_note(note_abs)
    except OSError:
        return True
    if hashlib.sha256(text.encode("utf-8", "replace")).hexdigest() != r[0]:
        return True
    if r[1]:
        pdf = VAULT / r[1]
        if not pdf.is_file():
            return True
        try:
            if _stat_sig(pdf) != r[2]:
                return True
        except OSError:
            return True
    return False


def _sweep_worker(batch):
    """Subprocess unit: [(note_abs, surface)] -> [(note_row, qrows)] (JSON-safe)."""
    pdf_cache = {}
    out = []
    for note_abs, surface in batch:
        try:
            out.append(check_note_quotes(note_abs, surface, pdf_cache))
        except Exception as e:
            out.append(("ERROR", f"{note_abs}: {type(e).__name__}: {e}"))
    return out


def _prune_vanished(con, surface=None):
    if surface:
        rows = con.execute("SELECT note_path FROM notes WHERE surface=?",
                           (surface,)).fetchall()
    else:
        rows = con.execute("SELECT note_path FROM notes").fetchall()
    gone = [r[0] for r in rows
            if not (VAULT / r[0]).is_file()
            or not _indexable(Path(r[0]).name)]
    with con:
        for rel in gone:
            con.execute("DELETE FROM quotes WHERE note_path=?", (rel,))
            con.execute("DELETE FROM notes WHERE note_path=?", (rel,))
    return len(gone)


def verdict_key(quote_text, pdf_sha):
    h = hashlib.sha256()
    h.update(qnorm_loose(quote_text or "").encode("utf-8", "replace"))
    h.update(b"\x00")
    h.update((pdf_sha or "").encode("utf-8", "replace"))
    return h.hexdigest()


def dedupe_stats(path=None):
    """Collapse actionable rows by verdict_key and audit determinism: no two
    rows sharing a key may disagree. A conflict means the verdict is NOT a pure
    function of its inputs, which is the premise the whole index rests on."""
    con = connect(path)
    try:
        rows = con.execute(
            "SELECT note_path, quote_idx, quote_text, pdf_sha, verdict "
            "FROM quotes WHERE COALESCE(advisory,0)=0").fetchall()
    finally:
        con.close()
    groups, conflicts = {}, []
    for note_path, qidx, qtext, pdf_sha, verdict in rows:
        k = verdict_key(qtext, pdf_sha)
        g = groups.setdefault(k, {"verdicts": set(), "rows": []})
        g["verdicts"].add(verdict)
        g["rows"].append((note_path, qidx, verdict))
    for k, g in groups.items():
        if len(g["verdicts"]) > 1:
            conflicts.append({"key": k[:16], "verdicts": sorted(g["verdicts"]),
                              "rows": g["rows"][:6]})
    dupes = {k: g for k, g in groups.items() if len(g["rows"]) > 1}
    per_verdict = {}
    for k, g in groups.items():
        v = next(iter(g["verdicts"]))
        per_verdict[v] = per_verdict.get(v, 0) + 1
    return {"raw_rows": len(rows), "deduped": len(groups),
            "duplicate_groups": len(dupes), "conflicts": conflicts,
            "deduped_per_verdict": per_verdict}


def _guard_version(con, full):
    r = con.execute("SELECT value FROM meta WHERE key='norm_version'").fetchone()
    db_v = r[0] if r else None
    if db_v and db_v != NORM_VERSION and not full:
        return (f"DB norm_version={db_v} but this module is {NORM_VERSION}. An "
                f"incremental sweep would mix versions in one DB and silently "
                f"re-stamp rows the current code did not produce. Re-run with "
                f"--full (rewrites every row consistently).")
    return None


def sweep(full=False, jobs=8, limit=None, surface=None, path=None):
    settings.require_pymupdf()      # fail before any note is read
    con = connect(path)
    try:
        drift = _guard_version(con, full)
    finally:
        pass
    if drift:
        con.close()
        print(json.dumps({"ok": False, "error": "norm_version_drift",
                          "msg": drift}))
        return 2
    todo = []
    try:
        for note_abs, surf in _iter_notes(surface):
            if full or _needs_check(con, note_abs, surf):
                todo.append((str(note_abs), surf))
                if limit and len(todo) >= limit:
                    break
    finally:
        con.close()
    if not todo:
        # prune on this path too: "index up to date" has to actually mean it,
        # and a deleted note needs no re-check to be noticed.
        pruned = 0
        if not limit:
            con2 = connect(path)
            try:
                pruned = _prune_vanished(con2, surface)
            finally:
                con2.close()
        print(json.dumps({"ok": True, "checked": 0, "pruned": pruned,
                          "msg": "index up to date"}))
        return 0

    nb = max(1, len(todo) // max(jobs * 4, 1))
    batches = [todo[i:i + nb] for i in range(0, len(todo), nb)]
    results, errors = [], []
    t0 = time.time()
    if jobs > 1 and len(batches) > 1:
        import multiprocessing as mp
        with mp.Pool(processes=min(jobs, len(batches))) as pool:
            for out in pool.imap_unordered(_sweep_worker, batches):
                for item in out:
                    (errors if item[0] == "ERROR" else results).append(item)
                done = len(results) + len(errors)
                print(f"  …{done}/{len(todo)} notes ({time.time()-t0:.0f}s)",
                      file=sys.stderr, flush=True)
    else:
        for b in batches:
            for item in _sweep_worker(b):
                (errors if item[0] == "ERROR" else results).append(item)

    con = connect(path)
    try:
        with con:
            for note_row, qrows in results:
                con.execute("DELETE FROM quotes WHERE note_path=?", (note_row[0],))
                con.execute("DELETE FROM notes WHERE note_path=?", (note_row[0],))
                con.execute("INSERT INTO notes VALUES (?,?,?,?,?,?,?,?)", note_row)
                con.executemany(
                    "INSERT INTO quotes VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    qrows)
            con.execute("INSERT OR REPLACE INTO meta VALUES ('last_sweep',?)",
                        (json.dumps({"at": int(time.time() * 1000),
                                     "checked": len(results),
                                     "errors": len(errors),
                                     "norm_version": NORM_VERSION}),))
            con.execute("INSERT OR REPLACE INTO meta VALUES ('norm_version',?)",
                        (NORM_VERSION,))
        pruned = _prune_vanished(con, surface) if not limit else 0
    finally:
        con.close()
    print(json.dumps({"ok": not errors, "checked": len(results),
                      "pruned": pruned,
                      "errors": errors[:20], "n_errors": len(errors),
                      "secs": round(time.time() - t0, 1)}))
    return 0 if not errors else 1


# ------------------------------------------------------------------ crosscheck
def crosscheck(path=None):
    con = connect(path)
    try:
        rows = con.execute(
            "SELECT note_path, quote_idx, quote_text FROM quotes "
            "WHERE verdict='VIOLATION' AND advisory=0").fetchall()
    finally:
        con.close()
    if not rows:
        print(json.dumps({"ok": True, "violations": 0, "hits": []}))
        return 0
    docs = []
    for proj in sorted(PAPERS.iterdir()) if PAPERS.is_dir() else []:
        wdir = proj / "writing"
        if wdir.is_dir():
            docs.extend(p for p in sorted(wdir.glob("*.md")) if p.name.lower() != "notes.md")
    doc_loose = []
    for d in docs:
        try:
            t = _read_note(d)
        except OSError:
            continue
        doc_loose.append((d, t.splitlines(), qnorm_loose(t)))
    hits = []
    now = int(time.time() * 1000)
    for note_path, qidx, qtext in rows:
        ql = qnorm_loose(qtext)
        if len(ql) < LOOSE_MIN:
            continue
        wins = {ql, ql[:60], ql[-60:]}
        wins.update(ql[o:o + 60] for o in range(0, max(1, len(ql) - 59), 30))
        wins = {w for w in wins if len(w) >= min(60, len(ql))}
        for d, dlines, dl in doc_loose:
            w_hit = next((w for w in wins if w in dl), None)
            if w_hit:
                line = next((i + 1 for i, ln in enumerate(dlines)
                             if w_hit[:40] in qnorm_loose(ln)), None)
                hits.append((note_path, qidx, _rel(d), line, now))
    con = connect(path)
    try:
        with con:
            con.execute("DELETE FROM crosscheck")
            con.executemany("INSERT OR REPLACE INTO crosscheck VALUES (?,?,?,?,?)", hits)
    finally:
        con.close()
    print(json.dumps({"ok": True, "violations": len(rows), "manuscript_hits": [
        {"note": h[0], "quote_idx": h[1], "doc": h[2], "line": h[3]} for h in hits
    ]}, ensure_ascii=False, indent=2))
    return 0


# ------------------------------------------------------------------ probe (hand-check aid)
def probe(note_like, quote_idx=None, path=None):
    """Evidence dump for hand-checking a verdict: the quote next to the nearest
    matching context in its PDF (best contiguous word-run per difflib)."""
    import difflib
    con = connect(path)
    try:
        sql = ("SELECT note_path, quote_idx, verdict, reason, quote_text, pdf_path, "
               "cited_phys FROM quotes WHERE note_path LIKE ?")
        args = [f"%{note_like}%"]
        if quote_idx is not None:
            sql += " AND quote_idx=?"
            args.append(quote_idx)
        rows = con.execute(sql + " ORDER BY quote_idx", args).fetchall()
    finally:
        con.close()
    for note_path, qidx, verdict, reason, qtext, pdf_rel, cited in rows:
        print(f"\n### {note_path} [q{qidx}] {verdict} ({reason}) cited_phys={cited}")
        print(f"QUOTE: {qtext[:400]}")
        if not pdf_rel or not (VAULT / pdf_rel).is_file():
            print("  (no PDF on disk)")
            continue
        pages = _pdf_pages(VAULT / pdf_rel)
        qw = qnorm_words(qtext)
        best = (0.0, None, None)
        for i, pg in enumerate(pages):
            pw = qnorm_words(pg)
            m = difflib.SequenceMatcher(None, qw, pw, autojunk=False)\
                .find_longest_match(0, len(qw), 0, len(pw))
            if m.size > best[0]:
                best = (m.size, i + 1, (pw, m))
        size, pageno, ctx = best
        if not pageno:
            print("  NO overlap with any page")
            continue
        pw, m = ctx
        print(f"  best page {pageno}: longest common run {size} chars "
              f"({round(100 * size / max(1, len(qw)))}% of quote)")
        print(f"  PDF ctx: …{pw[max(0, m.b - 80):m.b + m.size + 80]}…")
        qa, qb = m.a, m.a + m.size
        print(f"  QUOTE unmatched head: {qw[:qa][-120:]!r}" if qa else
              "  QUOTE head fully matched")
        print(f"  QUOTE unmatched tail: {qw[qb:][:120]!r}" if qb < len(qw) else
              "  QUOTE tail fully matched")


# ------------------------------------------------------------------ CLI
def _print_table(cols, rows):
    if not cols:
        print("(no columns)")
        return
    widths = [len(c) for c in cols]
    srows = []
    for r in rows:
        cells = ["" if v is None else str(v)[:110] for v in r]
        srows.append(cells)
        for i, c in enumerate(cells):
            widths[i] = max(widths[i], len(c))
    print("  ".join(c.ljust(widths[i]) for i, c in enumerate(cols)))
    print("  ".join("-" * widths[i] for i in range(len(cols))))
    for cells in srows:
        print("  ".join(c.ljust(widths[i]) for i, c in enumerate(cells)))
    print(f"\n({len(rows)} rows)")


def main(argv=None):
    ap = argparse.ArgumentParser(description="deterministic quote-integrity index")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("sweep")
    p.add_argument("--full", action="store_true")
    p.add_argument("--jobs", type=int, default=8)
    p.add_argument("--limit", type=int)
    p.add_argument("--surface", choices=["citations", "corpus"])
    sub.add_parser("summary")
    p = sub.add_parser("issues")
    p.add_argument("--limit", type=int, default=200)
    p = sub.add_parser("query")
    p.add_argument("sql")
    p = sub.add_parser("note")
    p.add_argument("note")
    p = sub.add_parser("probe")
    p.add_argument("note")
    p.add_argument("--idx", type=int)
    sub.add_parser("crosscheck")
    sub.add_parser("dedupe")
    sub.add_parser("doctor")
    sub.add_parser("path")
    sub.add_parser("spec")
    a = ap.parse_args(argv)

    if a.cmd == "path":
        print(db_path())
        return 0
    if a.cmd == "spec":
        print(__doc__)
        return 0
    if a.cmd == "sweep":
        return sweep(full=a.full, jobs=a.jobs, limit=a.limit, surface=a.surface)
    if a.cmd == "summary":
        print(json.dumps(summary(), ensure_ascii=False, indent=2))
        return 0
    if a.cmd == "issues":
        cols, rows = query(
            "SELECT q.note_path, q.line, q.kind, substr(q.quote_text,1,80) AS quote, "
            "q.cited_phys, q.pdf_path, q.reason FROM quotes q "
            "WHERE q.verdict='VIOLATION' AND q.advisory=0 "
            f"ORDER BY q.note_path, q.quote_idx LIMIT {int(a.limit)}")
        _print_table(cols, rows)
        return 0
    if a.cmd == "query":
        cols, rows = query(a.sql)
        _print_table(cols, rows)
        return 0
    if a.cmd == "note":
        name = a.note if a.note.endswith(".md") else a.note + ".md"
        cols, rows = query(
            "SELECT quote_idx, kind, advisory, line, verdict, reason, match_form, "
            "found_page, cited_phys, page_ok, substr(quote_text,1,70) AS quote "
            f"FROM quotes WHERE note_path LIKE '%{Path(name).name}' ORDER BY quote_idx")
        _print_table(cols, rows)
        return 0
    if a.cmd == "probe":
        probe(a.note, a.idx)
        return 0
    if a.cmd == "crosscheck":
        return crosscheck()
    if a.cmd == "dedupe":
        st = dedupe_stats()
        print(json.dumps(st, ensure_ascii=False, indent=2))
        # a conflict means the verdict is not a pure function of its inputs —
        # the premise the whole index rests on. Fail loudly.
        return 2 if st["conflicts"] else 0
    if a.cmd == "doctor":
        con = connect()
        try:
            r = con.execute("SELECT value FROM meta WHERE key='norm_version'")\
                .fetchone()
            db_v = r[0] if r else None
            mixed = con.execute(
                "SELECT norm_version, COUNT(*) FROM quotes GROUP BY norm_version"
            ).fetchall()
        finally:
            con.close()
        ok = (db_v == NORM_VERSION) and len(mixed) <= 1
        print(json.dumps({"ok": ok, "code_norm_version": NORM_VERSION,
                          "db_norm_version": db_v,
                          "rows_per_norm_version": dict(mixed)}, indent=2))
        return 0 if ok else 2
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
