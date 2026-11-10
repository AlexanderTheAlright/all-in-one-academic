"""Whole-vault tag index for the dashboard Tag explorer."""
import json, os, re

import settings

CACHE_NAME = ".tag-index-cache.json"   # per-file mtime memo (internal, incremental)
INDEX_NAME = "tags-index.json"          # served aggregate (read by serve.py)
_VERSION = 2                            # bump when extraction logic changes -> full rebuild

# directory names skipped anywhere in the tree
SKIP_DIRS = {".obsidian", ".git", "node_modules", ".trash", ".smart-env",
             ".smart-connections", ".parcel-cache", "dist", "__pycache__",
             ".snapshots"}
# vault-relative path prefixes skipped
SKIP_PREFIXES = tuple(settings.INDEX_SKIP)
# board files handled by serve.py's card path — skip here so cards aren't double-counted
SKIP_FILES = {settings.TASKS_BOARD_REL}
PATH_MD_RE = re.compile(r"^Projects/papers/" + settings.LIVE_PROJECT_RE + r"/PATH\.md$")

STRUCTURAL_TAGS = {"citation", "web-source", "corpus", "project-note", "finder",
                   "dashboard", "clipping", "rss", "calendar", "flashcards", "m"}

# inline obsidian-ish tag: not preceded by a word char / & / / , must start with a
# letter (so #2024 and url #fragments after a word are excluded), nestable a/b/c
INLINE_RE = re.compile(r"(?<![\w&/])#([A-Za-z][\w\-]*(?:/[A-Za-z][\w\-]*)*)")
FENCE_RE = re.compile(r"```.*?```", re.S)
WIKILINK_ONLY = re.compile(r"^!?\[\[[^\]]+\]\]$")
MAX_OCC_PER_TAG = 300
MAX_SNIPPET = 160


def _skip_rel(rel):
    if rel in SKIP_FILES or PATH_MD_RE.match(rel):
        return True
    return any(rel.startswith(p) for p in SKIP_PREFIXES)


def _clean_tag(t):
    return t.strip().strip("\"'#").strip().lstrip("/")


def _fm_tags_and_meta(fm_lines):
    """Parse a frontmatter block's `tags:` (block list / inline list / comma string)
    and pull a title if present. Returns (tags:list, title:str|None)."""
    tags, title, list_key = [], None, None
    for ln in fm_lines:
        m = re.match(r"^(\s+)-\s+(.*)$", ln)
        if m and list_key == "tags":
            tags.append(_clean_tag(m.group(2)))
            continue
        if ":" not in ln:
            continue
        key, _, val = ln.partition(":")
        key, val = key.strip().lower(), val.strip()
        if key == "tags":
            if val == "":
                list_key = "tags"
            else:
                list_key = None
                inner = val.strip().lstrip("[").rstrip("]")
                tags += [_clean_tag(x) for x in inner.split(",")]
        else:
            list_key = None
            if key == "title" and val:
                title = val.strip().strip("\"'")
    return [t for t in tags if t], title


def _summary(body_lines):
    """First meaningful body line: skip blanks, headings, list-bullets, wikilink-only
    embeds, and obsidian properties. Gives frontmatter-only tags some context."""
    for ln in body_lines:
        s = ln.strip()
        if not s or s.startswith("#") or s.startswith(">") or s == "---":
            continue
        if WIKILINK_ONLY.match(s):
            continue
        if re.match(r"^[\w][\w /’'-]{0,24}:\s*!?\[\[", s):     # "PDF: [[..]]" / "Citation/Notes: [[..]]"
            continue
        s = re.sub(r"^[-*+]\s+(\[[ xX]\]\s*)?", "", s)        # list / checkbox marker
        s = re.sub(r"[*_`]", "", s)                             # light md
        s = s.strip()
        if len(s) >= 3:
            return s[:MAX_SNIPPET]
    return ""


def _extract(path, rel):
    """(fm_tags:list, inline:list[(tag, snippet)], title:str) for one file.
    Inline tags are deduped per file (first line kept) so one file = one occurrence
    per tag, with the line it sat on as context."""
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            txt = f.read()
    except OSError:
        return [], [], None
    lines = txt.split("\n")
    fm_tags, title, body_start = [], None, 0
    if lines and lines[0].strip() == "---":
        for k in range(1, min(len(lines), 100)):
            if lines[k].strip() == "---":
                body_start = k + 1
                break
        if body_start:
            fm_tags, title = _fm_tags_and_meta(lines[1:body_start - 1])
    if not title:
        title = os.path.splitext(os.path.basename(rel))[0]
    body_lines = lines[body_start:]
    body = "\n".join(body_lines)
    body_nocode = FENCE_RE.sub("", body)
    seen, inline = set(), []
    for ln in body_nocode.split("\n"):
        for m in INLINE_RE.finditer(ln):
            tag = m.group(1)
            low = tag.lower()
            if low in seen:
                continue
            seen.add(low)
            snip = re.sub(r"^[-*+]\s+(\[[ xX]\]\s*)?", "", ln.strip())[:MAX_SNIPPET]
            inline.append((tag, snip))
    return fm_tags, inline, title, _summary(body_lines)


# --------------------------------------------------------------------------- build
def build(vault, here):
    """Incrementally (re)build the tag index. `vault`/`here` are Path objects.
    Returns the number of files reindexed this run."""
    vault, here = str(vault), str(here)
    cache_path = os.path.join(here, CACHE_NAME)
    try:
        with open(cache_path, encoding="utf-8") as f:
            cache = json.load(f)
    except (OSError, ValueError):
        cache = {}
    if cache.get("__v__") != _VERSION:    # extraction logic changed -> rebuild all
        cache = {"__v__": _VERSION}

    present, reindexed = set(), 0
    for root, dirs, files in os.walk(vault):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for fn in files:
            if not fn.endswith(".md"):
                continue
            full = os.path.join(root, fn)
            rel = os.path.relpath(full, vault).replace("\\", "/")
            if _skip_rel(rel):
                continue
            present.add(rel)
            try:
                mtime = int(os.stat(full).st_mtime)
            except OSError:
                continue
            ent = cache.get(rel)
            if ent and ent.get("m") == mtime:
                continue
            fm, inline, title, summary = _extract(full, rel)
            cache[rel] = {"m": mtime, "fm": fm, "inl": inline,
                          "title": title, "sum": summary,
                          "stem": os.path.splitext(fn)[0]}
            reindexed += 1
    for rel in [r for r in cache if r != "__v__" and r not in present]:
        del cache[rel]

    cache["__v__"] = _VERSION
    with open(cache_path, "w", encoding="utf-8") as f:
        json.dump(cache, f, ensure_ascii=False)

    # aggregate: lowercase tag key -> {count, occ[]}
    agg = {}
    for rel, ent in cache.items():
        if rel == "__v__":
            continue
        title, stem, summary = ent["title"], ent.get("stem", ""), ent.get("sum", "")
        for t in ent["fm"]:
            low = t.lower()
            if low in STRUCTURAL_TAGS or "/" in low and low.split("/")[0] in STRUCTURAL_TAGS:
                continue
            rec = agg.setdefault(low, {"count": 0, "occ": []})
            rec["count"] += 1
            if len(rec["occ"]) < MAX_OCC_PER_TAG:
                rec["occ"].append({"title": title, "path": rel, "link": stem,
                                   "source": "frontmatter", "snippet": summary})
        for t, snip in ent["inl"]:
            low = t.lower()
            if low in STRUCTURAL_TAGS or "/" in low and low.split("/")[0] in STRUCTURAL_TAGS:
                continue
            rec = agg.setdefault(low, {"count": 0, "occ": []})
            rec["count"] += 1
            if len(rec["occ"]) < MAX_OCC_PER_TAG:
                rec["occ"].append({"title": title, "path": rel, "link": stem,
                                   "source": "inline", "snippet": snip})

    tags = sorted(({"tag": t, "count": r["count"], "shown": len(r["occ"])}
                   for t, r in agg.items()), key=lambda r: (-r["count"], r["tag"]))
    out = {"tagCount": len(agg), "files": len(present), "tags": tags,
           "occ": {t: r["occ"] for t, r in agg.items()}}
    with open(os.path.join(here, INDEX_NAME), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False)
    return reindexed


# ---------------------------------------------------------------------------- load
_loaded = {"mtime": 0.0, "data": None}


def _index_path(here):
    return os.path.join(str(here), INDEX_NAME)


def _load(here):
    """Return the parsed index, reloading only when tags-index.json changes on disk."""
    p = _index_path(here)
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


def files(here, prefix=""):
    p = os.path.join(str(here), CACHE_NAME)
    try:
        with open(p, encoding="utf-8") as f:
            cache = json.load(f)
    except (OSError, ValueError):
        return []
    out = []
    for rel, ent in cache.items():
        if rel == "__v__" or not isinstance(ent, dict):
            continue
        if prefix and not rel.startswith(prefix):
            continue
        out.append({"path": rel, "title": ent.get("title", ""),
                    "tags": ent.get("fm", []), "mtime": ent.get("m", 0)})
    return out


def note_tag_counts(here):
    """lowercase tag -> count over notes (cards excluded). {} if not built yet."""
    d = _load(here)
    if not d:
        return {}
    return {row["tag"]: row["count"] for row in d["tags"]}


def note_occurrences(here, tag):
    """Note occurrences for `tag` (case-insensitive). [] if none / not built."""
    d = _load(here)
    if not d:
        return []
    return d["occ"].get(tag.lower(), [])


def status(here):
    d = _load(here)
    if not d:
        return {"ready": False, "tagCount": 0, "files": 0}
    return {"ready": True, "tagCount": d.get("tagCount", 0), "files": d.get("files", 0)}
