#!/usr/bin/env python3
"""Notes capture and filing."""
import settings
import hashlib
import json
import os
import re
import shutil
import sys
import threading
import time
from datetime import date, datetime
from pathlib import Path

import citationindex
import tagindex

HERE = settings.STATE_DIR
VAULT = settings.VAULT
NOTES = VAULT / "Preparation" / "Notes"
INBOX = NOTES / "Inbox"
ARCHIVE = NOTES / "Archive"                       # soft-delete destination; not one of
                                                  # FOLDERS, so list_all()/note_nodes() skip it
EXTERNAL_ARCHIVE = ARCHIVE / "_external"          # archived notes that came from the read-only
                                                  # source trees (calendar meetings, projects,
                                                  # citations) — restored to their EXACT origin
ORIGINS = EXTERNAL_ARCHIVE / ".origins.json"      # {archived_vault_rel: original_vault_rel}
LOG = HERE / "notes-organizer-log.jsonl"         # audit trail of every file move

# Folders the organizer is allowed to file into. Daily is excluded (daily notes
# are written elsewhere); the inbox itself is never a destination.
FOLDERS = {
    "authors": ("Authors", "author"),
    "concepts": ("Concepts", "concept"),
    "ideas": ("Ideas", "idea"),
    "reflections": ("Reflections", "reflection"),
    "meetings": ("Meetings", "meeting"),
}

MEETINGS_DIR = VAULT / "Preparation" / "Calendar" / "events" / "meetings"
PROJECTS_ROOT = VAULT / "Projects" / "papers"
CITATIONS_DIR = VAULT / "Preparation" / "Reading" / "Citations"


# --------------------------------------------------------------------- helpers

def as_list(v):
    """Frontmatter list fields are ALWAYS a list of strings by the time they leave here."""
    if v is None:
        return []
    if isinstance(v, (list, tuple, set)):
        return [str(x).strip() for x in v if str(x).strip()]
    if isinstance(v, str):
        t = v.strip()
        if t.startswith("[") and t.endswith("]"):
            t = t[1:-1]
        parts = [x.strip().strip("'\"") for x in t.split(",")]
        return [x for x in parts if x]
    return [str(v).strip()] if str(v).strip() else []

def _now_stamp():
    return datetime.now().strftime("%Y-%m-%dT%H:%M")


def _slug(text, maxlen=60):
    text = (text or "").strip()
    text = re.sub(r"\s+", " ", text)
    text = re.sub(r'[\\/:*?"<>|#\[\]\^]', "", text)
    text = text.strip(" .-")
    if len(text) > maxlen:
        text = text[:maxlen].rsplit(" ", 1)[0].strip()
    return text or "note"


def _yaml_escape(v):
    """Quote a scalar only when YAML needs it; keep clean values bare."""
    s = str(v)
    if s == "" or re.search(r'[:#\[\]{}",&*!|>%@`]', s) or s[:1] in "-?" or s != s.strip():
        return '"' + s.replace('"', '\\"') + '"'
    return s


def _build_frontmatter(meta):
    """meta: dict possibly containing title, created, type, source, status, summary,
    date, event, and the list keys tags / with. Emit a clean YAML block. None/empty
    values are skipped."""
    lines = ["---"]
    for key in ("title", "created", "type", "project", "source", "status", "summary", "date", "event"):
        val = meta.get(key)
        if val:
            lines.append(f"{key}: {_yaml_escape(val)}")
    for key in ("tags", "with"):
        items = [t for t in (meta.get(key) or []) if t]
        if items:
            lines.append(f"{key}:")
            for t in items:
                lines.append(f"  - {_yaml_escape(t)}")
    lines.append("---")
    return "\n".join(lines)


def _split_frontmatter(text):
    text = text.lstrip("﻿")
    if not text.startswith("---"):
        return {}, text.strip()
    end = text.find("\n---", 3)
    if end == -1:
        return {}, text.strip()
    head = text[3:end].strip("\n")
    body = text[end + 4:].lstrip("\n")
    meta, list_key = {}, None
    for line in head.split("\n"):
        if list_key and re.match(r"\s*-\s+", line):
            meta.setdefault(list_key, []).append(line.split("-", 1)[1].strip().strip('"').strip("'"))
            continue
        list_key = None
        m = re.match(r"([A-Za-z_]+):\s*(.*)$", line)
        if not m:
            continue
        key, val = m.group(1), m.group(2).strip()
        if val in ("", "[]"):
            list_key = key
            continue
        meta[key] = val.strip('"').strip("'")
    return meta, body.strip()


def _atomic_write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(str(tmp), str(path))


def _unique(path):
    """If path exists, suffix -2, -3, ... so we never clobber an existing note."""
    if not path.exists():
        return path
    stem, suffix, parent = path.stem, path.suffix, path.parent
    n = 2
    while True:
        cand = parent / f"{stem}-{n}{suffix}"
        if not cand.exists():
            return cand
        n += 1


def _first_line(body, maxlen=70):
    for line in (body or "").splitlines():
        s = re.sub(r"^#+\s*", "", line).strip()
        if s:
            return s[:maxlen]
    return ""


# --------------------------------------------------------------------- capture
def body_hash(body):
    """sha-256 of a note's body as save_note writes it (stripped): what a page holds
    as its base, so "changed since I read it" is a question about the words and a
    sync or a backup that only touches the mtime is not a change."""
    return hashlib.sha256((body or "").strip().encode("utf-8")).hexdigest()


_CLIENT_ID_RE = re.compile(r"\A[A-Za-z0-9_-]{8,64}\Z")
_CAPTURED = {}                 # clientId -> (inbox Path, time)
_CAPTURED_LOCK = threading.Lock()
_CAPTURED_MAX, _CAPTURED_TTL = 64, 900


def _captured(client_id):
    with _CAPTURED_LOCK:
        now = time.time()
        for k in [k for k, (_, t) in _CAPTURED.items() if now - t > _CAPTURED_TTL]:
            _CAPTURED.pop(k, None)
        hit = _CAPTURED.get(client_id)
    return hit[0] if hit and hit[0].is_file() else None


def _capture_result(path, repeat=False):
    try:
        body = _split_frontmatter(path.read_text(encoding="utf-8"))[1]
    except OSError:
        body = ""
    return {"ok": True, "id": path.stem, "filename": path.name, "path": str(path),
            "rel": path.relative_to(VAULT).as_posix(), "hash": body_hash(body),
            "mtime": int(path.stat().st_mtime), "repeat": repeat}


def capture(body, title=None, source="dashboard", client_id=None):
    body = (body or "").strip()
    if not body and not title:
        return {"ok": False, "error": "empty note"}
    client_id = client_id if isinstance(client_id, str) and _CLIENT_ID_RE.match(client_id) else None
    if client_id:
        made = _captured(client_id)
        if made is not None:
            return _capture_result(made, repeat=True)
    INBOX.mkdir(parents=True, exist_ok=True)
    title = (title or "").strip()
    derived = title or _first_line(body) or "note"
    meta = {"created": _now_stamp(), "source": source or "dashboard", "status": "inbox"}
    if title:
        meta["title"] = title
    fm = _build_frontmatter(meta)
    content = fm + "\n\n" + (("# " + title + "\n\n") if title else "") + body + "\n"
    stamp = datetime.now().strftime("%Y-%m-%d-%H%M")
    path = _unique(INBOX / f"{stamp} {_slug(derived)}.md")
    _atomic_write(path, content)
    if client_id:
        with _CAPTURED_LOCK:
            while len(_CAPTURED) >= _CAPTURED_MAX:
                _CAPTURED.pop(next(iter(_CAPTURED)))
            _CAPTURED[client_id] = (path, time.time())
    return _capture_result(path)


# --------------------------------------------------------------------- list
def list_inbox():
    """Pending notes still in the inbox, newest first."""
    out = []
    if not INBOX.exists():
        return out
    for p in sorted(INBOX.glob("*.md"), key=lambda x: x.stat().st_mtime, reverse=True):
        try:
            text = p.read_text(encoding="utf-8")
        except OSError:
            continue
        meta, body = _split_frontmatter(text)
        out.append({
            "id": p.stem,
            "filename": p.name,
            "title": meta.get("title") or _first_line(body) or p.stem,
            "preview": _first_line(body, 160),
            "created": meta.get("created", ""),
            "source": meta.get("source", ""),
            "mtime": int(p.stat().st_mtime),
        })
    return out


def list_all():
    out = []
    for folder, ntype in FOLDERS.values():
        d = NOTES / folder
        if not d.is_dir():
            continue
        for p in d.rglob("*.md"):
            if not p.is_file():
                continue
            try:
                text = p.read_text(encoding="utf-8")
            except OSError:
                continue
            meta, body = _split_frontmatter(text)
            rel = p.relative_to(VAULT).as_posix()
            out.append({
                "id": rel,
                "title": meta.get("title") or _first_line(body) or p.stem,
                "folder": folder,
                "type": meta.get("type") or ntype,
                "tags": as_list(meta.get("tags")),
                "aliases": as_list(meta.get("aliases")),
                "summary": meta.get("summary", "") or "",
                "preview": _first_line(body, 160),
                "created": meta.get("created", ""),
                "path": rel,
                "mtime": int(p.stat().st_mtime),
            })
    out.sort(key=lambda x: x["mtime"], reverse=True)
    return out


def _loose_root_notes():
    out = []
    if not NOTES.is_dir():
        return out
    for p in sorted(NOTES.glob("*.md")):
        if not p.is_file():
            continue
        try:
            meta, body = _split_frontmatter(p.read_text(encoding="utf-8"))
        except OSError:
            continue
        if not (meta.get("title") or body.strip()):
            continue                                     # skip genuinely empty stray files
        rel = p.relative_to(VAULT).as_posix()
        out.append({
            "id": rel, "title": meta.get("title") or _first_line(body) or p.stem,
            "folder": "Notes", "type": "inbox", "group": "",
            "tags": as_list(meta.get("tags")), "path": rel,
            "mtime": int(p.stat().st_mtime),
            "ghost": False, "external": False, "degree": 0, "readonly": False,
        })
    return out


def _meeting_nodes():
    out = []
    if not MEETINGS_DIR.is_dir():
        return out
    for p in sorted(MEETINGS_DIR.glob("*.md")):
        if not p.is_file():
            continue
        try:
            meta, body = _split_frontmatter(p.read_text(encoding="utf-8"))
        except OSError:
            continue
        rel = p.relative_to(VAULT).as_posix()
        out.append({
            "id": rel, "title": meta.get("title") or _first_line(body) or p.stem,
            "folder": "Meetings", "type": "meeting", "group": "",
            "tags": as_list(meta.get("tags")), "path": rel,
            "mtime": int(p.stat().st_mtime),
            "ghost": False, "external": False, "degree": 0, "readonly": True,
        })
    return out


def _project_display(dirname):
    return settings.strip_prefix(dirname).strip() or dirname


_PROJECT_NOTE_RE = re.compile(
    r"^Projects/(papers|grants|briefs|experiments)/([^/]+)/(logs|corpus)/[^/]+\.md$")
_DATED_LOG_RE = re.compile(r"^\d{4}-\d{2}-\d{2}_.+\.md$")


PROJECTS_DIR = VAULT / "Projects"
PROJECT_KINDS = ("papers", "grants", "briefs", "experiments")
FILE_KINDS = PROJECT_KINDS


def _kind_root(kind):
    return PROJECTS_DIR / kind


_PROJECT_STATUS_RE = re.compile(r"^(stalled|complete)\s*-\s*", re.I)


def project_name(dirname):
    """'<prefix>sample paper' / 'stalled - x' -> 'sample paper' / 'x'."""
    return _PROJECT_STATUS_RE.sub("", settings.strip_prefix(dirname)).strip() or dirname


def _project_status(dirname):
    m = _PROJECT_STATUS_RE.match(dirname)
    if m:
        return m.group(1).lower()
    return "in progress" if settings.live_slug(dirname) else ""


def _resolve_project_key(key):
    """A project key -> its resolved directory, or None. Exactly <kind>/<dir>, one of
    the four roots, no traversal, no dot or archive dirs, and the resolved directory
    must still sit directly under its root (a symlink out is refused)."""
    key = (key or "").strip().strip("/")
    if not key or "\\" in key or "\x00" in key:
        return None
    parts = key.split("/")
    if len(parts) != 2 or parts[0] not in FILE_KINDS:
        return None
    name = parts[1]
    if not name or name in (".", "..") or name.startswith(".") or name.lower() == "archive":
        return None
    root = _kind_root(parts[0]).resolve()
    d = (_kind_root(parts[0]) / name).resolve()
    if not d.is_dir() or d.parent != root:
        return None
    return d


def _project_dirs():
    """(kind, dir Path) for every live project directory under the four roots."""
    out = []
    for kind in FILE_KINDS:
        root = _kind_root(kind)
        if not root.is_dir():
            continue
        for d in sorted(root.iterdir()):
            if d.name.startswith(".") or d.name.lower() == "archive":
                continue
            if _resolve_project_key(f"{kind}/{d.name}") is not None:
                out.append((kind, d))
    return out


_targets_cache = {"t": 0.0, "value": None}


def project_targets():
    """Every project a note can be filed into: papers in progress, then stalled, then
    the other papers, then grants, briefs, experiments. Cached a minute."""
    now = time.time()
    if _targets_cache["value"] is not None and now - _targets_cache["t"] < 60:
        return _targets_cache["value"]
    rows = []
    for kind, d in _project_dirs():
        status = _project_status(d.name)
        if kind == "papers" and status == "in progress":
            first = 0
        elif kind == "papers" and status == "stalled":
            first = 1
        else:
            first = 2 + FILE_KINDS.index(kind)
        entry = dict(key=f"{kind}/{d.name}", name=project_name(d.name), root=kind, status=status)
        rows.append((first, entry["name"].lower(), entry))
    rows.sort(key=lambda r: r[:2])
    result = dict(projects=[r[2] for r in rows])
    _targets_cache["t"], _targets_cache["value"] = now, result
    return result


def _note_row(p):
    try:
        meta, body = _split_frontmatter(p.read_text(encoding="utf-8"))
    except OSError:
        return None
    return {"path": p.relative_to(VAULT).as_posix(),
            "title": meta.get("title") or _first_line(body) or p.stem,
            "created": meta.get("created", ""), "mtime": int(p.stat().st_mtime),
            "tags": as_list(meta.get("tags")), "aliases": as_list(meta.get("aliases"))}


def _project_note_files(d):
    """A project's dated logs."""
    nd = d / "logs"
    if not nd.is_dir():
        return []
    return [p for p in sorted(nd.glob("*.md")) if p.is_file() and _confined_project_note(
        p.relative_to(VAULT).as_posix()) is not None]


def project_notes_of(key):
    """One project's notes (its dated logs), newest first."""
    d = _resolve_project_key(key)
    if d is None:
        return {"ok": False, "error": "unknown project"}
    notes = []
    for p in _project_note_files(d):
        row = _note_row(p)
        if row:
            row.pop("tags", None)
            row["kind"] = "note"
            notes.append(row)
    notes.sort(key=lambda r: -r["mtime"])
    return {"ok": True, "key": key.strip().strip("/"), "name": project_name(d.name), "notes": notes}


# Heading case for project names, e.g. a README title from a folder name.
_SMALL_WORDS = {"a", "an", "and", "as", "at", "but", "by", "for", "in", "of", "on", "or",
                "the", "to", "vs"}
_ACRONYMS = {"ai": "AI", "ubi": "UBI", "covid": "COVID", "llm": "LLM", "llms": "LLMs",
             "ceo": "CEO", "ceos": "CEOs", "gpt": "GPT", "hr": "HR", "ses": "SES"}


def title_case(name):
    out = []
    for i, w in enumerate((name or "").split(" ")):
        if w.lower() in _ACRONYMS:
            out.append(_ACRONYMS[w.lower()])
        elif i and w.lower().strip(",;:.!?") in _SMALL_WORDS:
            out.append(w.lower())
        else:
            out.append(w[:1].upper() + w[1:])
    return " ".join(out)


def _project_nodes():
    out = []
    for f in tagindex.files(HERE, "Projects/"):
        m = _PROJECT_NOTE_RE.match(f["path"])
        if not m or m.group(2).lower() == "archive":
            continue
        if m.group(3) == "logs" and _DATED_LOG_RE.match(Path(f["path"]).name):
            continue

        display = _project_display(m.group(2)) if m.group(1) == "papers" else project_name(m.group(2))
        out.append({
            "id": f["path"], "title": f["title"] or Path(f["path"]).stem,
            "folder": display, "type": "project", "group": display,
            "tags": as_list(f.get("tags")), "path": f["path"],
            "mtime": int(f.get("mtime") or 0),
            "ghost": False, "external": False, "degree": 0, "readonly": True,
        })
    for kind, d in _project_dirs():
        display = _project_display(d.name) if kind == "papers" else project_name(d.name)
        for p in _project_note_files(d):
            row = _note_row(p)
            if not row:
                continue
            out.append({
                "id": row["path"], "title": row["title"],
                "folder": display, "type": "project", "group": display,
                "tags": row["tags"], "aliases": row["aliases"],
                "path": row["path"], "mtime": row["mtime"],
                "ghost": False, "external": False, "degree": 0, "readonly": False,
            })
    return out


CITATION_GROUP_CAP = 50   # distinct idea-groups shown as their own atlas sector; the
                          # long tail of one-off tag combinations folds into "Other" so
                          # the family stays a browsable ring, not hundreds of slivers


def _citation_nodes():
    recs = citationindex.records(HERE)
    if not recs:
        return []
    tag_counts = tagindex.note_tag_counts(HERE)
    prelim = []
    for r in recs:
        if r.get("kind") != "citation":
            continue
        rel = r.get("rel")
        if not rel:
            continue
        tags = r.get("tags") or []
        group = max(tags, key=lambda t: (tag_counts.get(t, 0), t)) if tags else "untagged"
        prelim.append((r, rel, tags, group))

    from collections import Counter
    group_counts = Counter(g for _, _, _, g in prelim)
    top_groups = {g for g, _ in group_counts.most_common(CITATION_GROUP_CAP)}

    out = []
    for r, rel, tags, group in prelim:
        title = r.get("title") or r.get("stem") or "citation"
        yr = r.get("year")
        label = f"{title} ({yr})" if yr and str(yr) not in title else title
        out.append({
            "id": rel, "title": label, "folder": "Citations", "type": "citation",
            "group": group if group in top_groups else "Other", "tags": tags, "path": rel,
            "mtime": int(r.get("mtime") or 0), "author": r.get("author") or "",
            "ghost": False, "external": False, "degree": 0, "readonly": True,
        })
    return out


def _author_key(author):
    if not author:
        return ""
    return re.split(r"[,\s]+", author.strip())[0].lower()


def note_nodes():
    out = []
    for n in list_all():
        out.append({
            "id": n["id"], "title": n["title"], "folder": n["folder"],
            "type": n["type"], "tags": n["tags"], "aliases": as_list(n.get("aliases")),
            "path": n["path"], "mtime": n["mtime"],
            "ghost": False, "external": False, "degree": 0,
            "group": "", "readonly": False,
        })
    if INBOX.exists():
        for p in sorted(INBOX.glob("*.md"), key=lambda x: x.stat().st_mtime, reverse=True):
            if not p.is_file():
                continue
            try:
                meta, body = _split_frontmatter(p.read_text(encoding="utf-8"))
            except OSError:
                continue
            rel = p.relative_to(VAULT).as_posix()
            out.append({
                "id": rel,
                "title": meta.get("title") or _first_line(body) or p.stem,
                "folder": "Inbox", "type": "inbox", "group": "",
                "tags": as_list(meta.get("tags")), "path": rel,
                "mtime": int(p.stat().st_mtime),
                "ghost": False, "external": False, "degree": 0, "readonly": False,
            })
    out.extend(_loose_root_notes())
    out.extend(_meeting_nodes())
    out.extend(_project_nodes())
    out.extend(_citation_nodes())
    return out


def search_notes(query, limit=40):
    toks = [t for t in (query or "").lower().split() if t]
    if not toks:
        return []
    out = []
    for n in note_nodes():
        hay = f"{n['title']} {' '.join(n['tags'])} {' '.join(n.get('aliases') or [])} " \
              f"{n['type']} {n['folder']} {Path(n['path']).stem}".lower()
        if not all(t in hay for t in toks) and n["type"] == "project" and not n.get("readonly", True):
            # a project's own notes (its dated logs): search their bodies too
            try:
                hay += " " + (VAULT / n["path"]).read_text(encoding="utf-8", errors="replace").lower()
            except OSError:
                pass
        if all(t in hay for t in toks):
            out.append(n)
            if len(out) >= limit:
                break
    return out


# --------------------------------------------------------------------- graph
_WIKILINK = re.compile(r"\[\[([^\]]+)\]\]")
# structural tags that would otherwise make uninformative tag-cliques in the graph
_TAG_STOPLIST = {"index", "concept", "idea", "author", "reflection", "dissertation"}


def _norm_key(s):
    """Normalize a link target / filename / title for resolution: lowercase, then
    collapse any run of non-alphanumerics to a single hyphen."""
    return re.sub(r"[^a-z0-9]+", "-", (s or "").lower()).strip("-")


_BULK_TYPES = {"inbox", "meeting", "project", "citation"}


def _derived_edges(notes):
    author_by_key, concept_by_key, citation_by_stem = {}, {}, {}
    for n in notes:
        if n["type"] == "author":
            author_by_key.setdefault(_author_key(n["title"]), n["id"])
        elif n["type"] == "concept":
            for alias in [n["title"]] + list(n.get("aliases") or []):
                k = _norm_key(alias)
                if k:
                    concept_by_key.setdefault(k, n["id"])
        elif n["type"] == "citation":
            k = _norm_key(Path(n["path"]).stem)
            if k:
                citation_by_stem.setdefault(k, n["id"])

    out = []
    for n in notes:
        if n["type"] == "citation":
            akey = _author_key(n.get("author", ""))
            aid = author_by_key.get(akey)
            if aid:
                out.append({"source": n["id"], "target": aid, "kind": "link"})
            matched = set()
            for tag in n["tags"]:
                cid = concept_by_key.get(_norm_key(tag))
                if cid and cid not in matched:
                    matched.add(cid)
                    out.append({"source": n["id"], "target": cid, "kind": "link"})
        elif n["type"] == "project":
            cid = citation_by_stem.get(_norm_key(Path(n["path"]).stem))
            if cid and cid != n["id"]:
                out.append({"source": n["id"], "target": cid, "kind": "link"})
    return out


_SIM_MIN_SHARED = 2     # minimum shared tags to count as a real connection (every
                        # member of a group already shares its GROUP tag — this
                        # requires at least one MORE, so it's a genuine extra tie)
_SIM_CAP_PER_NODE = 6   # cap so a maximally-tagged note doesn't fan out to everyone


def _similarity_edges(notes):
    from collections import defaultdict
    by_group = defaultdict(list)
    for n in notes:
        if n["type"] not in ("citation", "project"):
            continue
        by_group[(n["type"], n.get("group", ""))].append(n)

    out = []
    for (_, _), members in by_group.items():
        if len(members) < 2:
            continue
        tagsets = [(m["id"], set(t.lower() for t in (m.get("tags") or []))) for m in members]
        n = len(tagsets)
        pairs = []
        for i in range(n):
            id_i, tags_i = tagsets[i]
            if not tags_i:
                continue
            for j in range(i + 1, n):
                id_j, tags_j = tagsets[j]
                if not tags_j:
                    continue
                shared = len(tags_i & tags_j)
                if shared >= _SIM_MIN_SHARED:
                    pairs.append((shared, id_i, id_j))
        pairs.sort(key=lambda x: -x[0])
        degree = defaultdict(int)
        for shared, id_i, id_j in pairs:
            if degree[id_i] >= _SIM_CAP_PER_NODE or degree[id_j] >= _SIM_CAP_PER_NODE:
                continue
            degree[id_i] += 1
            degree[id_j] += 1
            out.append({"source": id_i, "target": id_j, "kind": "similar", "weight": shared})
    return out


def _graph_uncached(include_tag_edges=True):
    """Build the note knowledge graph from every browsable note + their [[wikilinks]]."""
    notes = note_nodes()
    resolve, nodes = {}, {}
    for n in notes:
        nid = n["id"]
        nodes[nid] = dict(n)
        key = _norm_key(Path(n["path"]).stem)
        if key:
            resolve.setdefault(key, nid)
    for n in notes:
        for a in n.get("aliases") or []:
            key = _norm_key(a)
            if key:
                resolve.setdefault(key, n["id"])
    for n in notes:
        key = _norm_key(n["title"])
        if key:
            resolve.setdefault(key, n["id"])

    edges, seen, ghosts = [], set(), {}
    for n in notes:
        if n["type"] == "citation":
            continue
        if n["type"] == "project" and n.get("readonly", True):
            continue    # corpus and undated logs come from tagindex's cache (title/tags
                         # only, no body). A project's own notes (its dated logs) ARE scanned.
        src = n["id"]
        try:
            _, body = _split_frontmatter((VAULT / n["path"]).read_text(encoding="utf-8"))
        except OSError:
            continue
        for m in _WIKILINK.finditer(body):
            # [[target#heading|display]], ![[embed]], and a table's escaped \| all
            # reduce to the bare target
            target = m.group(1).split("|", 1)[0].split("#", 1)[0].strip().rstrip("\\").strip()
            if target.lower().endswith(".md"):
                target = target[:-3]
            if not target:
                continue
            key = _norm_key(target)
            tgt = resolve.get(key)
            if tgt is None and "/" in target:           # a path-form link: its filename
                tgt = resolve.get(_norm_key(target.rsplit("/", 1)[-1]))
            if tgt is None:                              # not a filed note: external corpus ref or true ghost
                base = target.split("/")[-1].strip() or target
                cand = VAULT / (target if target.lower().endswith(".md") else target + ".md")
                external = ("/" in target) or cand.exists()
                if external:
                    rel = ""
                    try:
                        if cand.exists():
                            rel = cand.resolve().relative_to(VAULT.resolve()).as_posix()
                    except (ValueError, OSError):
                        rel = ""
                    # stem-based id so a citation reached via /notes/search lands on this node
                    gid = "ext:" + ((_norm_key(Path(rel).stem) if rel else "") or key)
                    ghosts.setdefault(gid, {
                        "id": gid, "title": base, "folder": "", "type": "external",
                        "tags": [], "path": rel, "mtime": 0,
                        "ghost": False, "external": True, "degree": 0,
                    })
                else:                                    # a link to a note that doesn't exist anywhere yet
                    gid = "ghost:" + key
                    ghosts.setdefault(gid, {
                        "id": gid, "title": base, "folder": "", "type": "ghost",
                        "tags": [], "path": "", "mtime": 0,
                        "ghost": True, "external": False, "degree": 0,
                    })
                tgt = gid
            if tgt == src:
                continue
            ek = (src, tgt, "link")
            if ek in seen:
                continue
            seen.add(ek)
            edges.append({"source": src, "target": tgt, "kind": "link"})

    for e in _derived_edges(notes):
        src, tgt = e["source"], e["target"]
        if src not in nodes or tgt not in nodes:
            continue          # derived edge to a node not built this pass — be safe
        ek = (src, tgt, "link")
        if ek in seen or (tgt, src, "link") in seen:
            continue
        seen.add(ek)
        edges.append(e)

    for e in _similarity_edges(notes):
        edges.append(e)   # kind='similar' — a distinct namespace, never collides with link/tag seen-keys

    allnodes = dict(nodes)
    allnodes.update(ghosts)

    if include_tag_edges:
        from itertools import combinations
        by_tag = {}
        for n in notes:
            if n["type"] in _BULK_TYPES:
                continue
            for t in n["tags"]:
                tl = t.lower()
                if tl not in _TAG_STOPLIST:
                    by_tag.setdefault(tl, []).append(n["id"])
        for tag, ids in by_tag.items():
            ids = sorted(set(ids))
            if len(ids) < 2:
                continue
            for a, b in combinations(ids, 2):
                if (a, b, "link") in seen or (b, a, "link") in seen:
                    continue                              # don't shadow a real link
                ek = (a, b, "tag")
                if ek in seen:
                    continue
                seen.add(ek)
                edges.append({"source": a, "target": b, "kind": "tag", "tag": tag})

    # degree + orphan flag from LINK edges only (the real structure)
    for e in edges:
        if e["kind"] != "link":
            continue
        for end in ("source", "target"):
            if e[end] in allnodes:
                allnodes[e[end]]["degree"] += 1
    for node in allnodes.values():
        node["orphan"] = (not node["ghost"]) and (not node["external"]) \
            and node["type"] not in _BULK_TYPES and node["degree"] == 0

    return {
        "nodes": list(allnodes.values()),
        "edges": edges,
        "folders": sorted({n["folder"] for n in notes if n["folder"]}),
        "types": sorted({nd["type"] for nd in allnodes.values()}),
        "tags": sorted({t for n in notes for t in n["tags"]}),
        "counts": {
            "notes": sum(1 for n in notes if n["type"] != "inbox"),
            "inbox": sum(1 for n in notes if n["type"] == "inbox"),
            "ghosts": sum(1 for nd in ghosts.values() if nd["ghost"]),
            "external": sum(1 for nd in ghosts.values() if nd["external"]),
            "links": sum(1 for e in edges if e["kind"] == "link"),
            "tagEdges": sum(1 for e in edges if e["kind"] == "tag"),
            "orphans": sum(1 for nd in allnodes.values() if nd.get("orphan")),
        },
    }


_GRAPH_CACHE_SECS = 330
                          # requests ALWAYS hit a prebuilt cache; ~5 min staleness
                          # is invisible (citations rebuild on a 30-min cycle anyway)
_graph_cache = {"t": 0.0, "data": None}


def graph(include_tag_edges=True):
    now = time.time()
    if _graph_cache["data"] is not None and now - _graph_cache["t"] < _GRAPH_CACHE_SECS:
        return _graph_cache["data"]
    data = _graph_uncached(include_tag_edges)
    _graph_cache["t"], _graph_cache["data"] = now, data
    return data


# ----------------------------------------------------------- read / save (drawer)
NOTE_BACKUP = HERE / "note-last.bak.md"          # last note-body edit keeps its own backup


def _confined_note_path(rel):
    if not isinstance(rel, str) or not rel or "\x00" in rel:
        return None
    p = (VAULT / rel).resolve()
    try:
        p.relative_to(NOTES.resolve())
    except ValueError:
        return None
    return p if p.suffix.lower() == ".md" else None


GRANTS_ROOT = VAULT / "Projects" / "grants"
BRIEFS_ROOT = VAULT / "Projects" / "briefs"
CLIPPINGS_READ_DIR = VAULT / "Preparation" / "Reading" / "Clippings"
_READONLY_ROOTS = (MEETINGS_DIR, PROJECTS_ROOT, CITATIONS_DIR, GRANTS_ROOT, BRIEFS_ROOT,
                   CLIPPINGS_READ_DIR)


def _confined_project_note(rel):
    if not isinstance(rel, str) or not rel or "\x00" in rel:
        return None
    p = (VAULT / rel).resolve()
    if p.suffix.lower() != ".md":
        return None
    try:
        parts = p.relative_to(PROJECTS_DIR.resolve()).parts
    except ValueError:
        return None
    if len(parts) != 4:
        return None
    if parts[2] != "logs" or not _DATED_LOG_RE.match(parts[3]):
        return None
    if _resolve_project_key(parts[0] + "/" + parts[1]) is None:
        return None
    return p


def _confined_editable_path(rel):
    """Every path the drawer and the block editor may WRITE: the Notes tree plus
    project notes (dated logs)."""
    return _confined_note_path(rel) or _confined_project_note(rel)


def _vault_read_path(rel):
    if not rel or "\x00" in rel:
        return None
    vault = VAULT.resolve()
    p = (VAULT / rel).resolve()
    if p.suffix.lower() != ".md":
        return None
    try:
        parts = p.relative_to(vault).parts
    except ValueError:
        return None
    low = "/".join(parts).lower()
    if any(x.startswith(".") or x == "node_modules" for x in parts) or "secret" in low:
        return None
    return p


def _confined_read_path(rel):
    if not isinstance(rel, str) or not rel or "\x00" in rel:
        return None
    p = (VAULT / rel).resolve()
    if p.suffix.lower() != ".md":
        return None
    for root in (NOTES,) + _READONLY_ROOTS:
        try:
            p.relative_to(root.resolve())
            return p
        except ValueError:
            continue
    return _vault_read_path(rel)


def read_note(rel):
    """A single note's metadata + body for the dashboard drawer (filed notes are
    editable; meetings/project/citation notes are read-only, see readonly above)."""
    p = _confined_read_path(rel)
    if p is None or not p.is_file():
        return {"ok": False, "error": "not found"}
    meta, body = _split_frontmatter(p.read_text(encoding="utf-8", errors="replace"))
    return {
        "ok": True, "path": p.relative_to(VAULT.resolve()).as_posix(),
        "title": meta.get("title") or _first_line(body) or p.stem,
        "type": meta.get("type", ""), "tags": as_list(meta.get("tags")),
        "summary": meta.get("summary", "") or "",
        "body": body, "mtime": int(p.stat().st_mtime), "hash": body_hash(body),
        "readonly": _confined_editable_path(rel) is None,
    }


NOTE_BACKUPS = HERE / "note-backups"


def save_note(rel, body, base_mtime=None, base_hash=None, keep_backup=False):
    """Replace a filed note's BODY, preserving its frontmatter block exactly. Backs
    up the prior file, writes atomically, path-confined to the Notes tree and
    project notes (dated logs)."""
    p = _confined_editable_path(rel)
    if p is None or not p.exists():
        return {"ok": False, "error": "not found"}
    original = p.read_text(encoding="utf-8")
    current = body_hash(_split_frontmatter(original)[1])
    st = int(p.stat().st_mtime)
    if isinstance(base_hash, str) and base_hash != current:
        return {"ok": False, "conflict": True, "currentMtime": st, "currentHash": current}
    if isinstance(base_mtime, (int, float)) and not isinstance(base_mtime, bool) and st != int(base_mtime):
        return {"ok": False, "conflict": True, "currentMtime": st, "currentHash": current}
    head, stripped = "", original.lstrip("\ufeff")
    if stripped.startswith("---"):
        end = stripped.find("\n---", 3)
        if end != -1:
            head = stripped[:end + 4]                    # keep "--- ... ---" verbatim
    content = (head + "\n\n" + (body or "").strip() + "\n") if head else ((body or "").strip() + "\n")
    try:
        NOTE_BACKUP.write_text(original, encoding="utf-8")
        if keep_backup:
            NOTE_BACKUPS.mkdir(exist_ok=True)
            kept = _unique(NOTE_BACKUPS / ("%s.%s.md" % (p.stem, datetime.now().strftime("%Y-%m-%d-%H%M%S"))))
            kept.write_text(original, encoding="utf-8")
    except OSError:
        if keep_backup:
            return {"ok": False, "error": "could not keep the replaced version; nothing was written"}
    _atomic_write(p, content)
    return {"ok": True, "path": p.relative_to(VAULT).as_posix(), "mtime": int(p.stat().st_mtime),
            "hash": body_hash(body)}


# ------------------------------------------------------------- semantic related
VECTORS_FILE = HERE / ".notes-vectors.json"


def _load_vectors():
    try:
        return json.loads(VECTORS_FILE.read_text(encoding="utf-8")).get("notes", {})
    except (OSError, ValueError):
        return {}


def related(rel, k=6, min_sim=0.35):
    """Top-k semantically nearest filed notes to the note at `rel`, by cosine over the
    embedding cache. Returns [] cleanly when vectors are absent (graceful degrade) — the
    drawer panel simply doesn't show. Never invents: every hit is a real cached note."""
    notes = _load_vectors()
    target = next(((nid, rec) for nid, rec in notes.items() if rec.get("path") == rel), None)
    if not target:
        return []
    tid, trec = target
    tv = trec.get("vec") or []
    tn = (sum(x * x for x in tv) ** 0.5) or 1.0
    out = []
    for nid, rec in notes.items():
        if nid == tid:
            continue
        v = rec.get("vec") or []
        if len(v) != len(tv):
            continue
        dot = sum(a * b for a, b in zip(tv, v))
        vn = (sum(x * x for x in v) ** 0.5) or 1.0
        sim = dot / (tn * vn)
        if sim >= min_sim:
            out.append({"id": nid, "title": rec.get("title", ""), "path": rec.get("path", ""),
                        "type": rec.get("type", ""), "tags": rec.get("tags", []), "sim": round(sim, 3)})
    out.sort(key=lambda r: -r["sim"])
    return out[:k]


# --------------------------------------------------------------------- file
_INBOX_NAME_RE = re.compile(r"[^./\\\x00*?\[\]][^/\\\x00*?\[\]]*\.md", re.I)


def _fileable_source(src):
    """The note file_note may rewrite and move, or None. A bare name is an Inbox file;
    an absolute path must already sit inside the Notes tree. Either way the resolved
    path has to be a .md file under Notes, so nothing outside it can be touched."""
    src = str(src or "")
    if not src or "\x00" in src:
        return None
    if Path(src).is_absolute():
        p = Path(src).resolve()
    else:
        if ".." in src or not _INBOX_NAME_RE.fullmatch(src):
            return None
        p = (INBOX / src).resolve()
        if p.parent != INBOX.resolve():
            return None
    if p.suffix.lower() != ".md" or not p.is_relative_to(NOTES.resolve()):
        return None
    return p


def file_note(src, folder, title=None, tags=None, ntype=None, summary=None):
    src = _fileable_source(src)
    if src is None:
        return {"ok": False, "error": "not a note in the Notes folder"}
    if not src.is_file():
        return {"ok": False, "error": f"not found: {src.name}"}
    key = (folder or "").strip().lower()
    if key not in FOLDERS:
        return {"ok": False, "error": f"unknown folder '{folder}' (use {', '.join(FOLDERS)})"}
    dest_dir_name, default_type = FOLDERS[key]
    dest_dir = NOTES / dest_dir_name

    old_meta, body = _split_frontmatter(src.read_text(encoding="utf-8"))
    # strip a leading "# title" line from the body; the title lives in frontmatter
    body = re.sub(r"^#\s+.+\n+", "", body, count=1).strip()
    title = (title or old_meta.get("title") or _first_line(body) or "note").strip()
    if isinstance(tags, str):
        tags = [t.strip() for t in re.split(r"[,\s]+", tags) if t.strip()]
    tags = list(dict.fromkeys(tags or []))            # dedupe, keep order
    created = old_meta.get("created") or _now_stamp()

    meta = {"title": title, "created": created, "type": (ntype or default_type),
            "source": old_meta.get("source", "note"), "tags": tags}
    if summary:
        meta["summary"] = summary
    content = _build_frontmatter(meta) + "\n\n# " + title + "\n\n" + body + "\n"

    # 1) write final content into the source (safe even if the move fails)
    _atomic_write(src, content)
    # 2) relocate into the destination folder (rename; no deletion)
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = _unique(dest_dir / f"{_slug(title)}.md")
    shutil.move(str(src), str(dest))

    rec = {"ts": _now_stamp(), "from": src.name, "to": str(dest.relative_to(NOTES)),
           "title": title, "tags": tags, "type": meta["type"]}
    try:
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    except OSError:
        pass
    return {"ok": True, "title": title, "dest": str(dest.relative_to(VAULT)),
            "folder": dest_dir_name, "tags": tags}


UNDO_DIR = HERE / "note-undo"
_UNDO_ID_RE = re.compile(r"^[0-9]{13}-[0-9a-f]{6}$")


def _parse_target(target):
    """-> ("folder", key) | ("inbox", None) | ("project", dir Path) | None."""
    t = (target or "").strip()
    if t.lower().startswith("project:"):
        d = _resolve_project_key(t[len("project:"):])
        return ("project", d) if d is not None else None
    k = t.lower()
    if k == "inbox":
        return ("inbox", None)
    if k in FOLDERS:
        return ("folder", k)
    return None


def _movable_source(rel):
    """A note that may be moved: anywhere in the Notes tree except Daily/ and
    Archive/, or a project note (dated log)."""
    p = _confined_note_path(rel)
    if p is not None:
        parts = p.relative_to(NOTES.resolve()).parts
        if len(parts) > 1 and parts[0] in ("Daily", "Archive"):
            return None
        return p
    return _confined_project_note(rel)


def _rewrite_frontmatter(text, sets, drops):
    """Set scalar keys and drop keys in a note's frontmatter, leaving every other
    line exactly as it was. A replaced or dropped key takes its indented list
    items with it. A note with no frontmatter gets one."""
    t = text.lstrip("﻿")
    if t.startswith("---"):
        end = t.find("\n---", 3)
        if end != -1:
            out, done, skipping = [], set(), False
            for line in t[3:end].strip("\n").split("\n"):
                m = re.match(r"([A-Za-z_]+):", line)
                if m:
                    key = m.group(1)
                    skipping = key in drops or key in sets
                    if key in sets and key not in done:
                        out.append(f"{key}: {_yaml_escape(sets[key])}")
                        done.add(key)
                    if skipping:
                        continue
                elif skipping and (line[:1] in (" ", "\t", "-") or not line.strip()):
                    continue
                else:
                    skipping = False
                out.append(line)
            for key, val in sets.items():
                if key not in done:
                    out.append(f"{key}: {_yaml_escape(val)}")
            return "---\n" + "\n".join(out) + "\n---" + t[end + 4:]
    head = "\n".join(["---"] + [f"{k}: {_yaml_escape(v)}" for k, v in sets.items()] + ["---"])
    return head + "\n\n" + t.lstrip("\n")


def _sha(b):
    import hashlib
    return hashlib.sha256(b).hexdigest()


def _write_bytes(path, raw):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_bytes(raw)
    os.replace(str(tmp), str(path))


def _undo_begin(original):
    """Save the original bytes BEFORE anything is written. Returns the new id."""
    import secrets
    uid = "%013d-%s" % (int(time.time() * 1000), secrets.token_hex(3))
    UNDO_DIR.mkdir(parents=True, exist_ok=True)
    _write_bytes(UNDO_DIR / (uid + ".orig"), original)
    return uid


def _undo_finish(uid, action, src_rel, dest, title):
    rec = {"id": uid, "ts": datetime.now().isoformat(timespec="seconds"),
           "action": action, "from": src_rel,
           "to": dest.relative_to(VAULT).as_posix(), "title": title,
           "to_sha256": _sha(dest.read_bytes()), "undone": False}
    _atomic_write(UNDO_DIR / (uid + ".json"), json.dumps(rec, ensure_ascii=False))
    try:
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(json.dumps({"ts": _now_stamp(), "op": action, "from": src_rel,
                                "to": rec["to"], "title": title, "undo_id": uid},
                               ensure_ascii=False) + "\n")
    except OSError:
        pass
    return rec


def _undo_entries():
    out = []
    if not UNDO_DIR.is_dir():
        return out
    for p in UNDO_DIR.glob("*.json"):
        try:
            out.append(json.loads(p.read_text(encoding="utf-8")))
        except (OSError, ValueError):
            continue
    out.sort(key=lambda r: r.get("id", ""), reverse=True)
    return out


def move_note(rel, to, action="move"):
    """Move a note to any filing target, rewriting only its frontmatter type (and
    project / status) and keeping every other key and the body as they were."""
    src = _movable_source(rel)
    if src is None or not src.is_file():
        return {"ok": False, "error": "not a movable note"}
    tgt = _parse_target(to)
    if tgt is None:
        return {"ok": False, "error": f"unknown target '{to}'"}
    kind, arg = tgt
    original = src.read_bytes()
    text = original.decode("utf-8", errors="replace")
    meta, body = _split_frontmatter(text)
    title = meta.get("title") or _first_line(body) or src.stem

    sets, drops = {}, set()
    if not meta.get("title"):
        sets["title"] = title
    if not meta.get("created"):
        sets["created"] = _now_stamp()
    name = src.name
    if kind == "inbox":
        dest_dir = INBOX
        sets["status"] = "inbox"
        drops |= {"type", "project"}
    else:
        if kind == "folder":
            dest_dir = NOTES / FOLDERS[arg][0]
            sets["type"] = FOLDERS[arg][1]
            drops.add("project")
        else:
            dest_dir = arg / "logs"
            sets["type"] = "note"
            sets["project"] = project_name(arg.name)
            day = str(meta.get("created") or "")[:10]
            if not re.match(r"^\d{4}-\d{2}-\d{2}$", day):
                day = date.today().isoformat()
            name = f"{day}_{_slug(title)}.md"
        if (meta.get("status") or "").strip().lower() == "inbox":
            drops.add("status")

    src_rel = src.relative_to(VAULT).as_posix()
    if src.parent.resolve() == dest_dir.resolve():
        return {"ok": True, "noop": True, "path": src_rel, "from": src_rel, "undo_id": None}

    uid = _undo_begin(original)
    _atomic_write(src, _rewrite_frontmatter(text, sets, drops))   # content first, then move
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = _unique(dest_dir / name)
    shutil.move(str(src), str(dest))
    _undo_finish(uid, action, src_rel, dest, title)
    return {"ok": True, "path": dest.relative_to(VAULT).as_posix(), "from": src_rel,
            "undo_id": uid, "title": title}


def file_any(rel, target):
    """/note/file: a FOLDERS target keeps file_note's full frontmatter rebuild; a
    project target moves the note there. "inbox" is not a filing target."""
    tgt = _parse_target(target)
    if tgt is None or tgt[0] == "inbox":
        return {"ok": False, "error": f"unknown folder '{target}'"}
    if tgt[0] == "project":
        return move_note(rel, target, action="file")
    src = _confined_note_path(rel)
    if src is None and _confined_project_note(rel) is not None:
        return move_note(rel, target, action="file")
    if src is None or not src.is_file():
        return {"ok": False, "error": "not a fileable note"}
    src_rel = src.relative_to(VAULT).as_posix()
    uid = _undo_begin(src.read_bytes())
    r = file_note(str(src), tgt[1])
    if not r.get("ok"):
        return r
    dest = VAULT / r["dest"]
    _undo_finish(uid, "file", src_rel, dest, r.get("title") or dest.stem)
    r.update({"path": dest.relative_to(VAULT).as_posix(), "from": src_rel, "undo_id": uid})
    return r


def undo(undo_id=None):
    """Put a filed or moved note back. The original bytes return to where the note
    came from (a unique name if that spot is taken). The moved copy goes away only
    if it is unchanged since the move; if it was edited, both are kept."""
    entries = _undo_entries()
    if undo_id:
        if not _UNDO_ID_RE.match(str(undo_id)):
            return {"ok": False, "error": "bad undo id"}
        rec = next((e for e in entries if e.get("id") == undo_id), None)
    else:
        rec = next((e for e in entries if not e.get("undone")), None)
    if rec is None:
        return {"ok": False, "error": "nothing to undo"}
    if rec.get("undone"):
        return {"ok": False, "error": "already undone"}
    uid = rec["id"]
    vault = VAULT.resolve()
    src = (VAULT / rec["from"]).resolve()
    moved = (VAULT / rec["to"]).resolve()
    if not (src.is_relative_to(vault) and moved.is_relative_to(vault)) or src.suffix != ".md":
        return {"ok": False, "error": "undo record points outside the vault"}
    try:
        original = (UNDO_DIR / (uid + ".orig")).read_bytes()
    except OSError:
        return {"ok": False, "error": "original bytes missing"}

    kept = None
    dest = _unique(src)
    dest.parent.mkdir(parents=True, exist_ok=True)
    if moved.is_file() and _sha(moved.read_bytes()) == rec.get("to_sha256"):
        _write_bytes(moved, original)
        shutil.move(str(moved), str(dest))
    else:
        _write_bytes(dest, original)
        if moved.is_file():
            kept = moved.relative_to(vault).as_posix()
    rec.update({"undone": True, "undone_ts": datetime.now().isoformat(timespec="seconds"),
                "restored": dest.relative_to(vault).as_posix(), "kept_edited": kept})
    _atomic_write(UNDO_DIR / (uid + ".json"), json.dumps(rec, ensure_ascii=False))
    try:
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(json.dumps({"ts": _now_stamp(), "op": "undo", "undo_id": uid,
                                "from": rec["to"], "to": rec["restored"],
                                "kept_edited": kept}, ensure_ascii=False) + "\n")
    except OSError:
        pass
    return {"ok": True, "path": rec["restored"], "undo_id": uid, "kept_edited": kept}


def history(limit=20):
    items = []
    for e in _undo_entries()[:max(1, min(200, int(limit)))]:
        items.append({"undo_id": e.get("id"), "ts": e.get("ts"), "action": e.get("action"),
                      "title": e.get("title"), "from": e.get("from"), "to": e.get("to"),
                      "undone": bool(e.get("undone")), "restored": e.get("restored")})
    return {"items": items}


def list_archived():
    """Every archived note, newest first. archived_at is the later of mtime and
    ctime: a move keeps mtime but stamps ctime, so this is when it was archived."""
    items = []
    if not ARCHIVE.is_dir():
        return {"items": items}
    origins = _load_origins()
    for p in ARCHIVE.rglob("*.md"):
        if not p.is_file():
            continue
        rest = p.relative_to(ARCHIVE).parts
        if any(x.startswith(".") for x in rest):
            continue
        rel = p.relative_to(VAULT).as_posix()
        try:
            meta, body = _split_frontmatter(p.read_text(encoding="utf-8", errors="replace"))
            st = p.stat()
        except OSError:
            continue
        row = {"path": rel, "title": meta.get("title") or _first_line(body) or p.stem,
               "from_folder": rest[0] if len(rest) > 1 else "",
               "archived_at": int(max(st.st_mtime, st.st_ctime))}
        if rest[0] == "_external" and len(rest) > 1:
            origin = origins.get(rel)
            row["from_folder"] = origin.split("/")[0] if origin else "external"
            if origin:
                row["origin"] = origin
        items.append(row)
    items.sort(key=lambda r: -r["archived_at"])
    return {"items": items}


# --------------------------------------------------------------------- archive
def archive_note(rel):
    p = _confined_note_path(rel)
    if p is None or not p.exists():
        return {"ok": False, "error": "not found"}
    try:
        p.relative_to(ARCHIVE.resolve())
        return {"ok": False, "error": "already archived"}
    except ValueError:
        pass
    meta, body = _split_frontmatter(p.read_text(encoding="utf-8"))
    title = meta.get("title") or _first_line(body) or p.stem
    # keep the source folder as the first path segment inside the archive, so
    # unarchive knows where to put it back (Ideas -> Archive/Ideas -> Ideas).
    parts = p.relative_to(NOTES).parts
    sub = parts[0] if len(parts) > 1 and parts[0] != "Archive" else ""
    dest_dir = (ARCHIVE / sub) if sub else ARCHIVE
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = _unique(dest_dir / p.name)
    shutil.move(str(p), str(dest))
    rec = {"ts": _now_stamp(), "op": "archive", "from": p.relative_to(NOTES).as_posix(),
           "to": dest.relative_to(NOTES).as_posix(), "title": title}
    try:
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    except OSError:
        pass
    return {"ok": True, "title": title, "archived": dest.relative_to(VAULT).as_posix()}


def unarchive_note(rel):
    """Restore an archived note back into its source folder (the segment right after
    Archive/ in its path; Ideas if none was recorded). The exact reverse of
    archive_note — the Undo path for the toast. Never deletes; path-confined."""
    p = _confined_note_path(rel)
    if p is None or not p.exists():
        return {"ok": False, "error": "not found"}
    try:
        rest = p.relative_to(ARCHIVE.resolve())
    except ValueError:
        return {"ok": False, "error": "not an archived note"}
    parts = rest.parts
    sub = parts[0] if len(parts) > 1 else "Ideas"    # default home if the archive was flat
    if sub not in {name for name, _ in FOLDERS.values()}:
        sub = "Ideas"
    dest_dir = NOTES / sub
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = _unique(dest_dir / p.name)
    shutil.move(str(p), str(dest))
    meta, body = _split_frontmatter(dest.read_text(encoding="utf-8"))
    title = meta.get("title") or _first_line(body) or dest.stem
    rec = {"ts": _now_stamp(), "op": "unarchive", "from": "Archive/" + rest.as_posix(),
           "to": dest.relative_to(NOTES).as_posix(), "title": title}
    try:
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    except OSError:
        pass
    return {"ok": True, "title": title, "path": dest.relative_to(VAULT).as_posix()}


def _load_origins():
    try:
        return json.loads(ORIGINS.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _save_origins(m):
    EXTERNAL_ARCHIVE.mkdir(parents=True, exist_ok=True)
    _atomic_write(ORIGINS, json.dumps(m, ensure_ascii=False, indent=2))


def _readonly_root_of(p):
    """Return the read-only source root p sits under, or None."""
    for root in _READONLY_ROOTS:
        try:
            p.relative_to(root.resolve())
            return root
        except ValueError:
            continue
    return None


def archive_any(rel):
    if not isinstance(rel, str) or not rel or "\x00" in rel:
        return {"ok": False, "error": "not found"}
    p = (VAULT / rel).resolve()
    if p.suffix.lower() != ".md" or not p.exists():
        return {"ok": False, "error": "not found"}
    # already archived?
    try:
        p.relative_to(ARCHIVE.resolve())
        return {"ok": False, "error": "already archived"}
    except ValueError:
        pass
    # editable Notes-tree note -> the original, unchanged behavior
    try:
        p.relative_to(NOTES.resolve())
        return archive_note(rel)
    except ValueError:
        pass
    # read-only source tree (meetings/projects/citations) or a project's own note
    # -> external archive, origin recorded
    if _readonly_root_of(p) is None and _confined_project_note(rel) is None:
        return {"ok": False, "error": "outside archivable scope"}
    meta, body = _split_frontmatter(p.read_text(encoding="utf-8"))
    title = meta.get("title") or _first_line(body) or p.stem
    origin = p.relative_to(VAULT).as_posix()
    EXTERNAL_ARCHIVE.mkdir(parents=True, exist_ok=True)
    dest = _unique(EXTERNAL_ARCHIVE / p.name)
    shutil.move(str(p), str(dest))
    archived_rel = dest.relative_to(VAULT).as_posix()
    origins = _load_origins()
    origins[archived_rel] = origin
    _save_origins(origins)
    rec = {"ts": _now_stamp(), "op": "archive", "from": origin,
           "to": archived_rel, "title": title, "external": True}
    try:
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    except OSError:
        pass
    return {"ok": True, "title": title, "archived": archived_rel}


def unarchive_any(rel):
    """Restore any archived note. An Archive/_external/ note goes back to its exact
    recorded origin; anything else takes the original unarchive_note path. The Undo
    action for the toast, whichever tree the note came from."""
    if not isinstance(rel, str) or not rel or "\x00" in rel:
        return {"ok": False, "error": "not found"}
    p = (VAULT / rel).resolve()
    try:
        p.relative_to(EXTERNAL_ARCHIVE.resolve())
    except ValueError:
        return unarchive_note(rel)                    # a normal Notes-tree archived note
    if p.suffix.lower() != ".md" or not p.exists():
        return {"ok": False, "error": "not found"}
    archived_rel = p.relative_to(VAULT).as_posix()
    origins = _load_origins()
    origin = origins.get(archived_rel)
    if not origin:
        return {"ok": False, "error": "origin unknown — restore manually"}
    target = (VAULT / str(origin)).resolve()
    if target.suffix.lower() != ".md" or (_readonly_root_of(target) is None
                                           and _confined_project_note(str(origin)) is None):
        return {"ok": False, "error": "recorded origin is outside the vault's note folders"}
    dest = _unique(target)
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(p), str(dest))
    origins.pop(archived_rel, None)
    _save_origins(origins)
    meta, body = _split_frontmatter(dest.read_text(encoding="utf-8"))
    title = meta.get("title") or _first_line(body) or dest.stem
    rec = {"ts": _now_stamp(), "op": "unarchive", "from": archived_rel,
           "to": dest.relative_to(VAULT).as_posix(), "title": title, "external": True}
    try:
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    except OSError:
        pass
    return {"ok": True, "title": title, "path": dest.relative_to(VAULT).as_posix()}


# --------------------------------------------------------------------- CLI
def _arg(flag, args, default=None):
    return args[args.index(flag) + 1] if flag in args and args.index(flag) + 1 < len(args) else default


def main(argv):
    if not argv:
        print("usage: notes_organizer.py {capture|inbox|file|archive|unarchive} ...", file=sys.stderr)
        return 2
    cmd, rest = argv[0], argv[1:]
    if cmd in ("archive", "unarchive"):
        if not rest or rest[0].startswith("--"):
            print(f"usage: notes_organizer.py {cmd} <vault-relative note path>", file=sys.stderr)
            return 2
        r = (archive_any if cmd == "archive" else unarchive_any)(rest[0])
        print(json.dumps(r, ensure_ascii=False))
        return 0 if r.get("ok") else 1
    if cmd == "capture":
        r = capture(_arg("--body", rest, ""), _arg("--title", rest), _arg("--source", rest, "cli"))
        print(json.dumps(r, ensure_ascii=False))
        return 0 if r.get("ok") else 1
    if cmd == "inbox":
        print(json.dumps(list_inbox(), ensure_ascii=False, indent=2))
        return 0
    if cmd == "file":
        if not rest or rest[0].startswith("--"):
            print("usage: notes_organizer.py file <inbox.md> --folder <F> [--title ..] [--tags ..]", file=sys.stderr)
            return 2
        r = file_note(rest[0], _arg("--folder", rest), _arg("--title", rest),
                      _arg("--tags", rest), _arg("--type", rest), _arg("--summary", rest))
        print(json.dumps(r, ensure_ascii=False))
        return 0 if r.get("ok") else 1
    print(f"unknown command: {cmd}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
