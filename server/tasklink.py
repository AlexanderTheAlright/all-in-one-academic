"""Resolve a task's most-relevant destination(s) — the Today/Timeline smart links."""
import settings
import re
import time
from pathlib import Path

WIKILINK_RE = re.compile(r"\[\[([^\]|]+)")

READING_REL = "Preparation/Reading"
CITATIONS_REL = READING_REL + "/Citations"
CORPUS_REL = READING_REL + "/Corpus"
INBOX_REL = READING_REL + "/Inbox"
_READING_DIRS = (CITATIONS_REL.lower(), CORPUS_REL.lower(), INBOX_REL.lower())

PAPER_PREFIX = settings.PROJECT_PREFIX
_PROJECT_ROOTS = (
    ("Projects/papers", PAPER_PREFIX),
    ("Projects/grants", PAPER_PREFIX),
    ("Projects/briefs", ""),
)
# The manuscript filenames drafting.py compiles (DOC_KINDS), in the order we
# prefer when a folder has more than one. Keep in sync with drafting.DOC_KINDS.
DOC_ORDER = ("paper.md", "proposal.md", "dissertation.md", "oped.md", "report.md")

# tags that are never a project name (priority / kind markers)
_NON_PROJECT_TAGS = {"reading", "high", "medium", "low", "urgent", "today", "done"}

# words too common to identify a project or citation on their own
_STOP = {
    "the", "and", "for", "with", "from", "into", "about", "that", "this", "its",
    "your", "our", "are", "was", "were", "been", "have", "has", "had", "will",
    "when", "what", "which", "then", "than", "over", "under", "between", "after",
    "before", "first", "second", "next", "last", "new", "old", "one", "two",
    "paper", "grant", "draft", "drafts", "project", "proposal", "brief", "report",
    "work", "working", "write", "writing", "read", "reading", "review", "reviews",
    "revise", "section", "sections", "note", "notes", "task", "todo", "open",
    "finish", "continue", "check", "email", "send", "list", "plan", "week",
    "today", "tomorrow",
}

_TTL = 120.0
_index_cache = {}   # str(vault) -> (expiry, index dict)


def _rel(vault: Path, p: Path) -> str:
    return p.relative_to(vault).as_posix()


def _tokens(s: str):
    return {w for w in re.findall(r"[a-z]{4,}", (s or "").lower()) if w not in _STOP}


def _emphatic(text: str):
    out = set()
    for m in re.finditer(r"[A-Za-z]{4,}", text or ""):
        w = m.group(0)
        low = w.lower()
        if low in _STOP:
            continue
        if any(c.isupper() for c in w[1:]) or (w[0].isupper() and m.start() > 0):
            out.add(low)
    return out


def _short(name: str, cap: int = 26) -> str:
    name = (name or "").strip()
    if len(name) <= cap:
        return name
    cut = name[: cap - 1]
    if " " in cut:   # break on a word, not mid-word
        cut = cut[: cut.rfind(" ")]
    return cut.rstrip() + "…"


def _reading_label(basename: str) -> str:
    head = basename.split(" - ")[0].strip()
    if re.search(r"\((?:19|20)\d{2}[a-z]?\)$", head):
        return "Open " + _short(head, 34)
    return "Open " + _short(basename, 30)


# ------------------------------------------------------------------ vault index
def _index(vault: Path):
    """Cached per-vault scan: draft projects + citation basenames, with a
    signature-token map each (token -> the ONE entry it identifies)."""
    key = str(vault)
    now = time.time()
    hit = _index_cache.get(key)
    if hit and hit[0] > now:
        return hit[1]

    projects = []   # (rootrel, prefix, slug)
    tok2proj = {}   # token -> slug list (then reduced to unique)
    for rootrel, prefix in _PROJECT_ROOTS:
        root = vault / rootrel
        if not root.is_dir():
            continue
        for d in root.iterdir():
            if not d.is_dir():
                continue
            name = d.name
            if prefix and not name.startswith(prefix):
                continue
            if not prefix and (name.startswith(".") or name in ("archive", "successful examples")):
                continue
            slug = name[len(prefix):] if prefix else name
            # only projects the Drafting editor can actually open
            wdir = d / "writing"
            if not wdir.is_dir():
                continue
            projects.append((rootrel, prefix, slug))
            for t in _tokens(slug):
                tok2proj.setdefault(t, set()).add((rootrel, slug))
    proj_sig = {t: next(iter(s)) for t, s in tok2proj.items() if len(s) == 1}

    cites = []
    tok2cite = {}
    cdir = vault / CITATIONS_REL
    if cdir.is_dir():
        for f in cdir.iterdir():
            if f.suffix != ".md":
                continue
            base = f.stem
            cites.append(base)
            for t in _tokens(base):
                tok2cite.setdefault(t, set()).add(base)
    cite_sig = {t: next(iter(s)) for t, s in tok2cite.items() if len(s) == 1}

    idx = {"proj_sig": proj_sig, "projects": projects, "cite_sig": cite_sig}
    _index_cache[key] = (now + _TTL, idx)
    return idx


# ------------------------------------------------------------------ resolvers
def _resolve_wikilink(vault: Path, target: str):
    """A [[target]] (full path or bare basename) -> (kind, vault-rel file) or None."""
    target = (target or "").strip()
    if not target:
        return None

    if "/" in target:
        # explicit vault-relative path (what reading.py and the app's pins write)
        rel = target
        cand = vault / rel
        if not cand.suffix:  # Obsidian links often omit the extension
            if (vault / (rel + ".md")).exists():
                rel += ".md"
            elif (vault / (rel + ".pdf")).exists():
                rel += ".pdf"
            cand = vault / rel
        if not cand.is_file():   # a folder link is never a task destination
            return None
        if not cand.resolve().is_relative_to(vault.resolve()):
            return None
        low = rel.lower()
        kind = "reading" if any(low.startswith(d) for d in _READING_DIRS) else "note"
        return kind, rel

    if ".." in target or "\\" in target:
        return None
    note = vault / CITATIONS_REL / (target + ".md")
    if note.exists():
        return "reading", _rel(vault, note)
    for d in (CORPUS_REL, INBOX_REL):
        pdf = vault / d / (target + ".pdf")
        if pdf.exists():
            return "reading", _rel(vault, pdf)
    return None


def _wikilink_link(vault: Path, target: str):
    res = _resolve_wikilink(vault, target)
    if not res:
        return None
    kind, file = res
    base = Path(file).stem
    label = _reading_label(base) if kind == "reading" else "Open " + _short(base)
    return {"kind": kind, "label": label, "action": "open", "file": file}


def _draft_link(vault: Path, slug: str):
    """A paper/grant/brief slug -> its draft link (the in-app Drafting editor),
    or None if no such project folder. The compiled PDF, when present, rides
    along as an extra."""
    slug = (slug or "").strip()
    if not slug or "/" in slug or "\\" in slug or ".." in slug or "\x00" in slug:
        return None
    for rootrel, prefix in _PROJECT_ROOTS:
        wdir = vault / rootrel / (prefix + slug) / "writing"
        if not wdir.is_dir():
            continue
        doc = next((d for d in DOC_ORDER if (wdir / d).exists()), None)
        if not doc:
            mds = sorted(p for p in wdir.glob("*.md") if p.name.lower() != "notes.md")   # scratch page
            doc = mds[0].name if mds else None
        if not doc:
            return None
        noun = "brief" if rootrel.endswith("briefs") else "draft"
        link = {"kind": "draft", "label": f"Open {_short(slug, 22)} {noun}",
                "action": "drafting", "slug": slug, "doc": doc}
        if (wdir / (doc[:-3] + ".pdf")).exists():
            link["extras"] = [{"kind": "draft", "label": "PDF",
                               "action": "open-pdf", "slug": slug, "doc": doc}]
        return link
    return None


def _citation_for_reading(vault: Path, text: str):
    """Best-effort: a #reading task's free text -> its citation note (vault-rel)."""
    m = re.search(
        r"([A-Z][A-Za-z.'’-]+(?:\s+(?:and|&|et al\.?)\s+[A-Z][A-Za-z.'’-]+)?)"
        r"\s*\(?((?:19|20)\d{2})\)?",
        text or "")
    if m:
        author, year = m.group(1).strip(), m.group(2)
        cdir = vault / CITATIONS_REL
        if cdir.is_dir():
            hits = list(cdir.glob(f"{author} ({year})*.md"))
            if len(hits) == 1:
                return _rel(vault, hits[0])

    sig = _index(vault)["cite_sig"]
    emph = _emphatic(text)
    counts, has_emph = {}, {}
    for t in _tokens(text):
        base = sig.get(t)
        if base:
            counts[base] = counts.get(base, 0) + 1
            has_emph[base] = has_emph.get(base, False) or (t in emph)
    if len(counts) == 1:
        base, n = next(iter(counts.items()))
        if n >= 2 or has_emph[base]:
            note = vault / CITATIONS_REL / (base + ".md")
            if note.exists():
                return _rel(vault, note)
    return None


def _fuzzy_project(vault: Path, text: str):
    sig = _index(vault)["proj_sig"]
    emph = _emphatic(text)
    scores = {}   # (rootrel, slug) -> [count, has_emphatic, max_token_len]
    for t in _tokens(text):
        hit = sig.get(t)
        if hit:
            s = scores.setdefault(hit, [0, False, 0])
            s[0] += 1
            s[1] = s[1] or (t in emph)
            s[2] = max(s[2], len(t))
    if not scores:
        return None
    ranked = sorted(scores.items(), key=lambda kv: (kv[1][1], kv[1][0]), reverse=True)
    if len(ranked) > 1 and (ranked[0][1][1], ranked[0][1][0]) == (ranked[1][1][1], ranked[1][1][0]):
        return None
    top, (n, has_emph, longest) = ranked[0]
    if n == 1 and not has_emph and longest < 5:
        return None
    return top[1]   # (rootrel, slug) -> slug


def _resolve(vault: Path, card: dict, board_name: str, is_planning: bool):
    raw = card.get("raw") or ""
    text = card.get("text") or ""
    tags = [str(t) for t in (card.get("tags") or [])]
    tags_low = {t.lower() for t in tags}

    # 1. explicit pinned [[wikilink]]s -- the exact targets the card names.
    #    First resolvable link = the primary; the rest become extra buttons.
    links = []
    for m in WIKILINK_RE.finditer(raw):
        lk = _wikilink_link(vault, m.group(1))
        if lk:
            links.append(lk)
        if len(links) >= 4:
            break
    if links:
        primary = links[0]
        if len(links) > 1:
            primary = dict(primary)
            primary["extras"] = (primary.get("extras") or []) + links[1:4]
        return primary

    # 2. a #reading task -> its citation note (best-effort), else the Reading view
    if "reading" in tags_low:
        cit = _citation_for_reading(vault, text)
        if cit:
            return {"kind": "reading", "label": _reading_label(Path(cit).stem),
                    "action": "open", "file": cit}
        return {"kind": "reading", "label": "Open reading list", "action": "reading"}

    # 3. a paper/grant board task, or a #project tag naming a project folder
    candidates = []
    if not is_planning and board_name:
        candidates.append(board_name)
    for t in tags:
        if t.lower() in _NON_PROJECT_TAGS or ":" in t:   # #m:<id> milestone tags
            continue
        candidates.append(t)
        spaced = t.replace("-", " ").replace("_", " ")
        if spaced != t:
            candidates.append(spaced)
    for slug in candidates:
        d = _draft_link(vault, slug)
        if d:
            return d

    # 4. free-text project match (unique distinctive word -> the folder)
    slug = _fuzzy_project(vault, text)
    if slug:
        d = _draft_link(vault, slug)
        if d:
            return d

    # 5. nothing better -> the caller keeps "Open board"
    return None


def resolve(vault, card, board_name, is_planning):
    """Public entry. Returns a link dict or None. NEVER raises."""
    try:
        return _resolve(Path(vault), card or {}, board_name or "", bool(is_planning))
    except Exception:
        return None


