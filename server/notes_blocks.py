"""Typed section blocks over a note's markdown body, plus the attachment and
diagram store the Notes view draws from."""

import base64
import json
import re
import time
from pathlib import Path
from urllib.parse import quote

import notes_organizer as no

NOTES = no.NOTES
VAULT = no.VAULT

DIAGRAMS = VAULT / "Preparation" / "Diagrams"
ATTACHMENTS = NOTES / "attachments"
ASSET_ROOTS = (DIAGRAMS, ATTACHMENTS)

# what a note may embed and what we will hand back over HTTP
IMAGE_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
}

_HEADING = re.compile(r"^(#{2,6})\s+(.*)$")
_FENCE = re.compile(r"^\s*(```|~~~)")
# ![[target.png]] or ![[target.png|300]]  -- Obsidian embed, the only form we emit
_EMBED = re.compile(r"^!\[\[([^\]|]+?)\s*(?:\|[^\]]*)?\]\]$")


# --------------------------------------------------------------- path confinement
def _confined_attachment(name, roots=None):
    """Resolve a BARE filename inside one of the asset roots, preferring an existing
    file. Rejects any path separator, traversal, or extension we do not serve."""
    if not isinstance(name, str) or not name or "/" in name or "\\" in name or "\x00" in name \
            or name.startswith("."):
        return None
    if Path(name).suffix.lower() not in IMAGE_TYPES and Path(name).suffix.lower() != ".excalidraw":
        return None
    first = None
    for root in (roots or ASSET_ROOTS):
        p = (root / name).resolve()
        try:
            p.relative_to(root.resolve())
        except ValueError:
            continue
        if p.exists():
            return p
        first = first or p
    return first


def _sidecar(png_name):
    """The .excalidraw source that drew this .png, if it exists."""
    stem = Path(png_name).stem
    cand = _confined_attachment(stem + ".excalidraw")
    return (stem + ".excalidraw") if (cand and cand.exists()) else None


def _stem(text, fallback):
    """A slug safe to hang two extensions off: no dots, so Path.with_suffix() can
    swap .excalidraw for .png without eating half the name."""
    s = no._slug((text or "").replace(".", " "), 48)
    return s if s and s != "note" else fallback


# --------------------------------------------------------------- block parsing
def _embed_in(lines):
    """The single image embed in these lines, or None. Two embeds means the block
    is mixed prose, so it stays a text block and the caller renders it as markdown."""
    hits = []
    for ln in lines:
        m = _EMBED.match(ln.strip())
        if m and Path(m.group(1)).suffix.lower() in IMAGE_TYPES:
            hits.append(m.group(1))
    return hits[0] if len(hits) == 1 else None


def _classify(lines):
    """(kind, asset) for a block's body lines."""
    target = _embed_in(lines)
    if not target:
        return "text", None
    src = _sidecar(target)
    asset = {"png": target, "excalidraw": src}
    return ("diagram" if src else "image"), asset


def parse_blocks(body):
    """Split a note body into the preamble plus one record per `##` heading."""
    lines = body.split("\n")
    fenced, heads = False, []
    for i, ln in enumerate(lines):
        if _FENCE.match(ln):
            fenced = not fenced
            continue
        if fenced:
            continue
        m = _HEADING.match(ln)
        if m:
            heads.append((i, len(m.group(1)), m.group(2).strip()))

    bounds = [h[0] for h in heads] + [len(lines)]
    out = []

    pre = lines[: bounds[0]]
    kind, asset = _classify(pre)
    out.append({"i": 0, "kind": kind, "heading": None, "level": 0,
                "body": "\n".join(pre).strip(), "start": 0, "end": bounds[0],
                "asset": asset})

    for n, (ln_no, level, text) in enumerate(heads):
        start, end = ln_no, bounds[n + 1]
        blines = lines[start + 1: end]
        kind, asset = _classify(blines)
        out.append({"i": n + 1, "kind": kind, "heading": text, "level": level,
                    "body": "\n".join(blines).strip(), "start": start, "end": end,
                    "asset": asset})
    return out


def _decorate(blocks):
    """Attach the URL the frontend fetches each asset from."""
    for b in blocks:
        a = b.get("asset")
        if not a:
            continue
        p = _confined_attachment(a["png"])
        stamp = int(p.stat().st_mtime) if (p and p.exists()) else 0
        a["url"] = "/notes/attachment?name=%s&v=%d" % (quote(a["png"]), stamp)
        if a.get("excalidraw"):
            a["source_url"] = "/notes/diagram?name=" + quote(a["excalidraw"])
            # the real vault path, so "Open in Obsidian" works wherever the file lives
            src = _confined_attachment(a["excalidraw"])
            a["source_path"] = src.relative_to(VAULT).as_posix() if (src and src.exists()) else ""
    return blocks


def _render(block):
    """One block back to markdown lines."""
    body = (block.get("body") or "").strip()
    if block.get("heading") is None:
        return body.split("\n") if body else []
    head = "#" * max(2, int(block.get("level") or 2)) + " " + block["heading"].strip()
    return [head] + ([""] + body.split("\n") if body else [])


def _splice(lines, start, end, chunk):
    """Replace lines[start:end] with `chunk`, separated from its neighbours by
    exactly one blank line."""
    chunk = list(chunk)
    while chunk and not chunk[0].strip():
        chunk.pop(0)
    while chunk and not chunk[-1].strip():
        chunk.pop()
    head, tail = lines[:start], lines[end:]
    if chunk:
        if head and head[-1].strip():
            chunk.insert(0, "")
        if tail and tail[0].strip():
            chunk.append("")
    return head + chunk + tail


# --------------------------------------------------------------- read / write
def _read(rel):
    """(path, frontmatter_text, body) for an editable note, or None."""
    p = no._confined_editable_path(rel)
    if p is None or not p.exists():
        return None
    original = p.read_text(encoding="utf-8")
    head, stripped = "", original.lstrip("\ufeff")   # a BOM would hide the frontmatter
    if stripped.startswith("---"):
        end = stripped.find("\n---", 3)
        if end != -1:
            head = stripped[: end + 4]
    body = stripped[len(head):].lstrip("\n") if head else stripped
    return p, head, body


def _write(p, head, body):
    content = (head + "\n\n" + body.strip() + "\n") if head else (body.strip() + "\n")
    try:
        no.NOTE_BACKUP.write_text(p.read_text(encoding="utf-8"), encoding="utf-8")
    except OSError:
        pass
    no._atomic_write(p, content)
    return {"ok": True, "path": p.relative_to(VAULT).as_posix(), "mtime": int(p.stat().st_mtime)}


def read_blocks(rel):
    r = _read(rel)
    if r is None:
        return {"ok": False, "error": "not found"}
    p, _head, body = r
    meta, _ = no._split_frontmatter(p.read_text(encoding="utf-8"))
    return {"ok": True, "path": p.relative_to(VAULT).as_posix(),
            "title": meta.get("title") or p.stem, "type": meta.get("type", ""),
            "tags": meta.get("tags") or [], "mtime": int(p.stat().st_mtime),
            "blocks": _decorate(parse_blocks(body))}


def save_block(rel, index, heading=None, body=None):
    """Replace ONE block. Every other line of the note is preserved byte for byte."""
    r = _read(rel)
    if r is None:
        return {"ok": False, "error": "not found"}
    p, head, old = r
    blocks = parse_blocks(old)
    if not (0 <= index < len(blocks)):
        return {"ok": False, "error": "no such block"}

    b = dict(blocks[index])
    if body is not None:
        b["body"] = body
    if heading is not None and b["heading"] is not None:
        b["heading"] = heading

    lines = old.split("\n")
    return _write(p, head, "\n".join(_splice(lines, b["start"], b["end"], _render(b))))


def add_block(rel, kind="text", heading="", body="", after=None):
    """Append a new `##` section, or insert it directly after block `after`."""
    r = _read(rel)
    if r is None:
        return {"ok": False, "error": "not found"}
    p, head, old = r
    blocks = parse_blocks(old)
    new = {"heading": (heading or "New section").strip(), "level": 2, "body": body or ""}

    lines = old.split("\n")
    at = len(lines)
    if after is not None and 0 <= after < len(blocks):
        at = blocks[after]["end"]
    res = _write(p, head, "\n".join(_splice(lines, at, at, _render(new))))
    if res.get("ok"):
        res["kind"] = kind
        res["index"] = (after + 1) if after is not None else len(blocks)
    return res


def delete_block(rel, index):
    """Remove a `##` section. The preamble (block 0) is not deletable."""
    r = _read(rel)
    if r is None:
        return {"ok": False, "error": "not found"}
    p, head, old = r
    blocks = parse_blocks(old)
    if not (1 <= index < len(blocks)):
        return {"ok": False, "error": "no such block"}
    lines = old.split("\n")
    b = blocks[index]
    return _write(p, head, "\n".join(lines[: b["start"]] + lines[b["end"]:]))


def move_block(rel, index, to):
    """Reorder a `##` section. Preamble stays pinned at 0."""
    r = _read(rel)
    if r is None:
        return {"ok": False, "error": "not found"}
    p, head, old = r
    blocks = parse_blocks(old)
    n = len(blocks)
    if not (1 <= index < n) or not (1 <= to < n):
        return {"ok": False, "error": "out of range"}
    if index == to:
        return {"ok": True, "path": rel, "noop": True}

    order = list(range(n))
    order.insert(to, order.pop(index))
    rebuilt = [_render(blocks[0])]
    for i in order[1:]:
        rebuilt.append(_render(blocks[i]))
    flat = []
    for chunk in rebuilt:
        if not chunk:
            continue
        if flat:
            flat.append("")
        flat.extend(chunk)
    return _write(p, head, "\n".join(flat))


# --------------------------------------------------------------- create in section
def create_note(folder, title, body="", tags=None, ntype=None, summary=""):
    key = (folder or "").strip().lower()
    project = None
    if key.startswith("project:"):
        pdir = no._resolve_project_key((folder or "").strip()[len("project:"):])
        if pdir is None:
            return {"ok": False, "error": "unknown project '%s'" % folder}
        project = no.project_name(pdir.name)
        dest_dir_name, default_type = project, "note"
        dest_dir = pdir / "logs"
    elif key not in no.FOLDERS:
        return {"ok": False, "error": "unknown folder '%s' (use %s)" % (folder, ", ".join(no.FOLDERS))}
    else:
        dest_dir_name, default_type = no.FOLDERS[key]
        dest_dir = NOTES / dest_dir_name
    title = (title or "").strip()
    if not title:
        return {"ok": False, "error": "a title is required"}
    dest_dir.mkdir(parents=True, exist_ok=True)

    if isinstance(tags, str):
        tags = [t.strip() for t in re.split(r"[,\s]+", tags) if t.strip()]
    tags = list(dict.fromkeys(tags or []))

    meta = {"title": title, "created": no._now_stamp(), "type": (ntype or default_type),
            "source": "dashboard", "tags": tags}
    if project:
        meta["project"] = project
    if summary:
        meta["summary"] = summary
    fm = no._build_frontmatter(meta)
    if key == "concepts":
        fm = fm[:-len("---")] + "level:\nexplicandum:\nbuilt_from: []\n---"
    parts = [fm, "", "# " + title]
    if (body or "").strip():
        parts += ["", (body or "").strip()]
    content = "\n".join(parts) + "\n"

    stem = no._slug(title)
    if project:
        stem = meta["created"][:10] + "_" + stem
    dest = no._unique(dest_dir / (stem + ".md"))
    no._atomic_write(dest, content)
    return {"ok": True, "title": title, "folder": dest_dir_name, "type": meta["type"],
            "path": dest.relative_to(VAULT).as_posix(), "mtime": int(dest.stat().st_mtime)}


MEETING_SCAFFOLD = ("## Notes", "## Decisions", "## Follow-ups")

_WITH_IN_TITLE = re.compile(r"\bwith\s+(.+)$", re.IGNORECASE)


def _attendees_from_title(title):
    m = _WITH_IN_TITLE.search(title or "")
    if not m:
        return []
    tail = re.split(r"\s+(?:about|re|regarding|on|for)\b", m.group(1), 1)[0]
    parts = re.split(r",\s*|\s+and\s+|\s*&\s*", tail)
    out = []
    for p in parts:
        p = p.strip().strip(".").strip()
        # a name, not a trailing clause -- at most two capitalised words
        if p and len(p.split()) <= 2 and p[:1].isupper():
            out.append(p)
    return out


def _confined_event(rel):
    """Resolve a calendar meeting event path, confined to the meetings event dir."""
    if not rel:
        return None
    p = (VAULT / rel).resolve()
    if p.suffix.lower() != ".md":
        return None
    try:
        p.relative_to(no.MEETINGS_DIR.resolve())
    except ValueError:
        return None
    return p if p.is_file() else None


def find_meeting_note(event_rel):
    """The filed note already bound to this event, or None. Keeps the create path
    IDEMPOTENT -- clicking "notes" twice must never fork a second note."""
    d = NOTES / "Meetings"
    if not d.is_dir():
        return None
    for p in sorted(d.glob("*.md")):
        try:
            meta, _ = no._split_frontmatter(p.read_text(encoding="utf-8"))
        except OSError:
            continue
        if (meta.get("event") or "").strip() == event_rel:
            return p
    return None


def meeting_note(event_rel):
    """Open-or-create the filed note for a calendar meeting, bound by `event:`."""
    ev = _confined_event(event_rel)
    if ev is None:
        return {"ok": False, "error": "not a calendar meeting"}
    rel = ev.relative_to(VAULT).as_posix()

    existing = find_meeting_note(rel)
    if existing is not None:
        return {"ok": True, "created": False, "title": existing.stem,
                "path": existing.relative_to(VAULT).as_posix(),
                "mtime": int(existing.stat().st_mtime)}

    meta_ev, _ = no._split_frontmatter(ev.read_text(encoding="utf-8"))
    title = (meta_ev.get("title") or ev.stem).strip()
    date = (meta_ev.get("date") or "").strip()
    if not date:
        m = re.search(r"(\d{4}-\d{2}-\d{2})", ev.stem)
        date = m.group(1) if m else ""

    attendees = meta_ev.get("with") or []
    if isinstance(attendees, str):
        attendees = [a.strip() for a in attendees.strip().strip("[]").split(",") if a.strip()]
    if not attendees:
        attendees = _attendees_from_title(title)

    meta = {"title": title, "created": no._now_stamp(), "type": "meeting",
            "source": "dashboard", "date": date, "event": rel,
            "tags": ["meeting"], "with": attendees}
    body = "\n\n".join(MEETING_SCAFFOLD)
    content = "\n".join([no._build_frontmatter(meta), "", "# " + title, "", body]) + "\n"

    dest_dir = NOTES / "Meetings"
    dest_dir.mkdir(parents=True, exist_ok=True)
    stem = ((date + " " if date else "") + title)
    dest = no._unique(dest_dir / (no._slug(stem) + ".md"))
    no._atomic_write(dest, content)
    return {"ok": True, "created": True, "title": title,
            "path": dest.relative_to(VAULT).as_posix(), "mtime": int(dest.stat().st_mtime)}


# --------------------------------------------------------------- attachments
def _decode_data_url(data_url, want=("image/",)):
    """(bytes, ext) from a data: URL, or (None, error)."""
    if not data_url or not data_url.startswith("data:"):
        return None, "not a data url"
    try:
        header, b64 = data_url.split(",", 1)
    except ValueError:
        return None, "malformed data url"
    mime = header[5:].split(";")[0].strip().lower()
    if not any(mime.startswith(w) for w in want):
        return None, "unsupported type '%s'" % mime
    ext = {v: k for k, v in IMAGE_TYPES.items()}.get(mime)
    if not ext:
        return None, "unsupported image type '%s'" % mime
    try:
        return base64.b64decode(b64, validate=True), ext
    except Exception:
        return None, "bad base64"


def save_attachment(data_url, stem="pasted"):
    """Persist a pasted or dropped image. Returns the bare filename to embed."""
    raw, ext = _decode_data_url(data_url)
    if raw is None:
        return {"ok": False, "error": ext}
    if not raw:
        return {"ok": False, "error": "empty image"}
    ATTACHMENTS.mkdir(parents=True, exist_ok=True)
    dest = no._unique(ATTACHMENTS / (_stem(stem, "pasted") + ext))
    dest.write_bytes(raw)
    name = dest.name
    return {"ok": True, "name": name, "embed": "![[%s]]" % name,
            "url": "/notes/attachment?name=" + name,
            "path": dest.relative_to(VAULT).as_posix()}


def read_attachment(name):
    """(bytes, content_type) for an attachment, or (None, None)."""
    p = _confined_attachment(name)
    if p is None or not p.exists():
        return None, None
    ct = IMAGE_TYPES.get(p.suffix.lower(), "application/octet-stream")
    return p.read_bytes(), ct


# --------------------------------------------------------------- diagrams
def canvas_available():
    """Is the standalone Excalidraw canvas page deployed beside serve.py?"""
    return (Path(__file__).resolve().parent / "excalidraw" / "index.html").exists()


def read_diagram(name):
    """The .excalidraw scene JSON for a diagram, or None."""
    p = _confined_attachment(name)
    if p is None or not p.exists() or p.suffix.lower() != ".excalidraw":
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


# a freshly created diagram carries a 1x1 placeholder render until it is drawn on
_EMPTY_PNG_BYTES = 256


def _lib_entry(image, src=None):
    """One library card. `src` is the .excalidraw that drew `image`, when there is one."""
    st = image.stat()
    elements, empty = 0, False
    if src is not None:
        try:
            elements = len(json.loads(src.read_text(encoding="utf-8")).get("elements") or [])
        except (OSError, ValueError):
            elements = 0
        empty = st.st_size < _EMPTY_PNG_BYTES
    target = src or image
    return {
        "name": target.name, "png": image.name, "title": target.stem,
        "editable": src is not None, "elements": elements, "empty": empty,
        "editor": "excalidraw" if src is not None else None,
        "mtime": int(max(st.st_mtime, target.stat().st_mtime)),
        "embed": "![[%s]]" % image.name,
        "url": "/notes/attachment?name=%s&v=%d" % (quote(image.name), int(st.st_mtime)),
        "path": target.relative_to(VAULT).as_posix(),
    }


def list_diagrams():
    """The diagram library in Preparation/Diagrams, newest first — the vault's reusable
    visual vocabulary. Each card embeds into ANY note as ![[<file>]]."""
    out = []
    if not DIAGRAMS.is_dir():
        return out
    renders = set()
    for src in DIAGRAMS.glob("*.excalidraw"):
        png = src.with_suffix(".png")
        if not png.exists():
            continue
        renders.add(png.name)
        out.append(_lib_entry(png, src))
    for kind, ext in _SOURCE_EXT.items():
        for src in DIAGRAMS.glob("*" + ext):
            png = src.with_suffix(".png")
            if not png.exists() or png.name in renders:
                continue
            renders.add(png.name)
            e = _lib_entry(png)
            st = max(src.stat().st_mtime, png.stat().st_mtime)
            e.update({"name": src.name, "title": src.stem, "editable": True, "editor": kind,
                      "mtime": int(st), "path": src.relative_to(VAULT).as_posix()})
            if kind == "drawer":
                try:
                    e["elements"] = len(json.loads(src.read_text(encoding="utf-8")).get("elements") or [])
                except (OSError, ValueError, AttributeError):
                    pass
            out.append(e)
    for img in DIAGRAMS.iterdir():
        if img.is_file() and img.suffix.lower() in IMAGE_TYPES and img.name not in renders:
            out.append(_lib_entry(img))
    out.sort(key=lambda d: d["mtime"], reverse=True)
    return out


def create_diagram(title):
    """A new, empty diagram in the library. The canvas opens on it immediately; the
    1x1 placeholder render is replaced the first time it is saved."""
    title = (title or "").strip()
    if not title:
        return {"ok": False, "error": "a title is required"}
    blank = ("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ"
             "AAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")
    return save_diagram({"elements": [], "appState": {}}, blank, stem=title)


def save_diagram(scene, png_data_url, name=None, stem="diagram"):
    """Persist an Excalidraw drawing as BOTH its editable source and its render:
    <stem>.excalidraw (the scene) next to <stem>.png (what the note embeds)."""
    if not isinstance(scene, dict) or "elements" not in scene:
        return {"ok": False, "error": "scene must be excalidraw json with elements"}
    raw, ext = _decode_data_url(png_data_url)
    if raw is None:
        return {"ok": False, "error": "png: " + str(ext)}
    if ext != ".png":
        return {"ok": False, "error": "diagram render must be a png"}

    DIAGRAMS.mkdir(parents=True, exist_ok=True)
    if name:                                            # update in place
        src = _confined_attachment(name if name.endswith(".excalidraw") else name + ".excalidraw")
        if src is None:
            return {"ok": False, "error": "bad diagram name"}
        base = src.with_suffix("")
    else:
        # reserve BOTH extensions together -- a free .excalidraw whose .png is taken
        # would silently overwrite another diagram's render
        root, n = _stem(stem, "diagram"), 1
        while True:
            cand = DIAGRAMS / root if n == 1 else DIAGRAMS / ("%s-%d" % (root, n))
            if not cand.with_suffix(".excalidraw").exists() and not cand.with_suffix(".png").exists():
                base = cand
                break
            n += 1

    doc = {"type": "excalidraw", "version": 2, "source": "all-in-one-academic",
           "elements": scene.get("elements") or [],
           "appState": scene.get("appState") or {},
           "files": scene.get("files") or {}}
    no._atomic_write(base.with_suffix(".excalidraw"), json.dumps(doc, ensure_ascii=False, indent=2))
    base.with_suffix(".png").write_bytes(raw)

    png = base.with_suffix(".png").name
    src = base.with_suffix(".excalidraw")
    return {"ok": True, "name": src.name, "png": png, "title": base.name,
            "embed": "![[%s]]" % png,
            "url": "/notes/attachment?name=%s&v=%d" % (quote(png), int(base.with_suffix(".png").stat().st_mtime)),
            "path": src.relative_to(VAULT).as_posix()}


_SOURCE_EXT = {"drawio": ".drawio", "drawer": ".aioadraw"}
_SOURCE_MAX = 5 * 1024 * 1024
_PNG_MAX = 15 * 1024 * 1024


def _source_path(name, kind, root=None, verbatim=False):
    root = root or DIAGRAMS
    ext = _SOURCE_EXT[kind]
    name = name.strip() if isinstance(name, str) else ""
    if not name or "/" in name or "\\" in name or "\x00" in name or name.startswith("."):
        return None
    stem = name if verbatim else re.sub(r"(%s|\.png)$" % re.escape(ext), "", name, flags=re.I)
    if not stem:
        return None
    p = (root / (stem + ext)).resolve()
    try:
        p.relative_to(root.resolve())
    except ValueError:
        return None
    return p


def _read_source(name, kind):
    p = _source_path(name, kind)
    if p is None:
        return {"ok": False, "error": "bad diagram name"}
    if not p.exists():
        return {"ok": False, "error": "not found"}
    try:
        return {"ok": True, "name": p.name, "title": p.stem,
                "text": p.read_text(encoding="utf-8"), "mtime": int(p.stat().st_mtime)}
    except OSError:
        return {"ok": False, "error": "diagram unreadable"}


def _save_source(kind, name, title, text, png_data_url, base_mtime=None):
    ext = _SOURCE_EXT[kind]
    if len(text) > _SOURCE_MAX:
        return {"ok": False, "error": "diagram source too large"}
    raw, pext = _decode_data_url(png_data_url)
    if raw is None:
        return {"ok": False, "error": "png: " + str(pext)}
    if pext != ".png" or not raw.startswith(b"\x89PNG\r\n\x1a\n") or len(raw) > _PNG_MAX:
        return {"ok": False, "error": "bad png export"}

    DIAGRAMS.mkdir(parents=True, exist_ok=True)
    if name:
        src = _source_path(name, kind)
        if src is None:
            return {"ok": False, "error": "bad diagram name"}
        if src.exists() and base_mtime is not None and int(src.stat().st_mtime) != int(base_mtime):
            return {"ok": False, "conflict": True, "currentMtime": int(src.stat().st_mtime)}
    else:
        root, n = _stem(title, "diagram"), 1
        sibs = (".png", ".excalidraw") + tuple(_SOURCE_EXT.values())
        while True:
            cand = DIAGRAMS / (root if n == 1 else "%s-%d" % (root, n))
            if not any(cand.with_suffix(x).exists() for x in sibs):
                src = cand.with_suffix(ext)
                break
            n += 1
    if src.exists():
        try:
            bdir = DIAGRAMS / ".diagram-backups"
            bdir.mkdir(exist_ok=True)
            (bdir / ("%s.%s%s" % (src.stem, time.strftime("%Y%m%d-%H%M%S"), ext))).write_bytes(src.read_bytes())
        except OSError:
            pass
    try:
        no._atomic_write(src, text)
        src.with_suffix(".png").write_bytes(raw)
    except OSError as e:
        return {"ok": False, "error": "write failed: %s" % e}
    png = src.with_suffix(".png")
    return {"ok": True, "name": src.name, "png": png.name, "title": src.stem,
            "embed": "![[%s]]" % png.name, "mtime": int(src.stat().st_mtime),
            "url": "/notes/attachment?name=%s&v=%d" % (quote(png.name), int(png.stat().st_mtime)),
            "path": src.relative_to(VAULT).as_posix()}


def read_drawio(name):
    """{ok, name, title, xml, mtime} for a library draw.io diagram."""
    r = _read_source(name, "drawio")
    if r.get("ok"):
        r["xml"] = r.pop("text")
    return r


def save_drawio(name, title, xml, png_data_url, base_mtime=None):
    xml = xml or ""
    if "<mxfile" not in xml and "<mxGraphModel" not in xml:
        return {"ok": False, "error": "not a draw.io diagram"}
    return _save_source("drawio", name, title, xml, png_data_url, base_mtime)


def read_drawer(name):
    """{ok, name, title, doc, mtime} for a drawing from the app's own drawer."""
    r = _read_source(name, "drawer")
    if r.get("ok"):
        try:
            r["doc"] = json.loads(r.pop("text"))
        except ValueError:
            return {"ok": False, "error": "diagram source is not valid json"}
    return r


def save_drawer(name, title, doc, png_data_url, base_mtime=None):
    if not isinstance(doc, dict) or doc.get("type") != "aioadraw":
        return {"ok": False, "error": "not an aioadraw document"}
    if name and "font" not in doc:
        old = read_drawer(name).get("doc")
        if isinstance(old, dict):
            els = old.get("elements") if isinstance(old.get("elements"), list) else []
            locked = {e.get("id") for e in els if isinstance(e, dict) and e.get("locked") is True}
            if locked and isinstance(doc.get("elements"), list):
                doc = {**doc, "elements": [{**e, "locked": True} if isinstance(e, dict) and e.get("id") in locked else e
                                           for e in doc["elements"]]}
            if isinstance(old.get("font"), str):
                doc = {**doc, "font": old["font"]}
    return _save_source("drawer", name, title, json.dumps(doc, ensure_ascii=False, indent=1),
                        png_data_url, base_mtime)


_TEMPLATE_MAX = 512 * 1024          # one template's json
_TEMPLATE_NAME_MAX = 80
_TEMPLATES_LIST = (200, 4 * 1024 * 1024)   # most templates listed; bytes of docs inlined


def _templates_dir():
    return DIAGRAMS / "templates"


def _template_path(name):
    name = (name or "").strip() if isinstance(name, str) else ""
    if len(name) > _TEMPLATE_NAME_MAX or any(ord(c) < 32 or ord(c) == 127 for c in name):
        return None
    return _source_path(name, "drawer", _templates_dir(), verbatim=True)


def list_templates():
    tdir, out, spent = _templates_dir(), [], 0
    if not tdir.is_dir():
        return out
    for f in sorted(tdir.glob("*" + _SOURCE_EXT["drawer"]), key=lambda f: f.stem.lower()):
        if len(out) >= _TEMPLATES_LIST[0]:
            break
        try:
            if f.is_symlink() or not f.is_file():
                continue
            st = f.stat()
            if st.st_size > _TEMPLATE_MAX:
                out.append({"name": f.stem, "mtime": int(st.st_mtime), "elements": 0, "doc": None})
                continue
            raw = json.loads(f.read_text(encoding="utf-8"))
        except Exception:       # unreadable, not json, nested past the parser (RecursionError)
            continue
        if not isinstance(raw, dict) or raw.get("type") != "aioadraw" or not isinstance(raw.get("elements"), list):
            continue
        fits = spent + st.st_size <= _TEMPLATES_LIST[1]
        spent += st.st_size if fits else 0
        out.append({"name": f.stem, "mtime": int(st.st_mtime), "elements": len(raw["elements"]),
                    "doc": raw if fits else None})
    return out


def save_template(name, doc, overwrite=False):
    p = _template_path(name)
    if p is None:
        return {"ok": False, "error": "bad template name"}
    if not isinstance(doc, dict) or doc.get("type") != "aioadraw" or not isinstance(doc.get("elements"), list):
        return {"ok": False, "error": "not an aioadraw document"}
    if not doc["elements"]:
        return {"ok": False, "error": "nothing to save"}
    keep = {"type": "aioadraw", "version": 1}
    if isinstance(doc.get("font"), str) and len(doc["font"]) <= 32:
        keep["font"] = doc["font"]
    keep["elements"] = doc["elements"]
    text = json.dumps(keep, ensure_ascii=False, indent=1)
    if len(text.encode("utf-8")) > _TEMPLATE_MAX:
        return {"ok": False, "error": "template too large"}
    if p.exists() and not overwrite:
        return {"ok": False, "exists": True, "name": p.stem, "error": "a template with that name exists"}
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        if p.exists():
            bdir = p.parent / ".diagram-backups"
            bdir.mkdir(exist_ok=True)
            (bdir / ("%s.%s%s" % (p.stem, time.strftime("%Y%m%d-%H%M%S"), p.suffix))).write_bytes(p.read_bytes())
        no._atomic_write(p, text)
    except OSError as e:
        return {"ok": False, "error": "write failed: %s" % e}
    return {"ok": True, "name": p.stem, "mtime": int(p.stat().st_mtime),
            "path": p.relative_to(VAULT).as_posix()}


def delete_template(name):
    p = _template_path(name)
    if p is None:
        return {"ok": False, "error": "bad template name"}
    if not p.is_file():
        return {"ok": False, "error": "not found"}
    adir, day = DIAGRAMS / "archive", time.strftime("%Y-%m-%d")
    adir.mkdir(exist_ok=True)
    dest, n = adir / ("%s.%s%s" % (p.stem, day, p.suffix)), 2
    while dest.exists():
        dest, n = adir / ("%s.%s-%d%s" % (p.stem, day, n, p.suffix)), n + 1
    p.rename(dest)
    return {"ok": True, "name": p.stem, "archived": dest.relative_to(VAULT).as_posix()}


_DIAGRAM_EXTS = tuple(IMAGE_TYPES) + (".excalidraw",) + tuple(_SOURCE_EXT.values())


def archive_diagram(name):
    """Archive a library diagram by any of its files' names. Returns {ok, moved:
    [{from, to}]} -- the pairs restore_diagram takes to undo it."""
    name = name.strip() if isinstance(name, str) else ""
    if not name or "/" in name or "\\" in name or "\x00" in name or name.startswith("."):
        return {"ok": False, "error": "bad diagram name"}
    p = DIAGRAMS / name
    if p.suffix.lower() not in _DIAGRAM_EXTS or p.is_symlink() or not p.is_file():
        return {"ok": False, "error": "not found"}
    stem, day = p.stem, time.strftime("%Y-%m-%d")
    adir = DIAGRAMS / "archive"
    adir.mkdir(exist_ok=True)
    moved = []
    for f in sorted(DIAGRAMS.iterdir()):
        if not f.is_file() or f.stem != stem or f.suffix.lower() not in _DIAGRAM_EXTS:
            continue
        dest, n = adir / ("%s.%s%s" % (stem, day, f.suffix)), 2
        while dest.exists():
            dest, n = adir / ("%s.%s-%d%s" % (stem, day, n, f.suffix)), n + 1
        f.rename(dest)
        moved.append({"from": f.name, "to": dest.name})
    return {"ok": True, "moved": moved}


def _embed_notes(needle):
    """Vault notes whose text contains `needle` (rg -F when present, else a walk); dot
    folders skipped."""
    import shutil, subprocess
    rg = shutil.which("rg")
    if rg:
        try:
            out = subprocess.run([rg, "-l", "-F", "--no-ignore", "--glob", "*.md", "--", needle, str(VAULT)],
                                 capture_output=True, text=True, timeout=30).stdout
            return [Path(x) for x in out.splitlines() if x]
        except (OSError, subprocess.SubprocessError):
            pass
    hits = []
    for f in VAULT.rglob("*.md"):
        if any(part.startswith(".") for part in f.relative_to(VAULT).parts):
            continue
        try:
            if needle in f.read_text(encoding="utf-8", errors="ignore"):
                hits.append(f)
        except OSError:
            pass
    return hits


def rename_drawer(name, title):
    src = _source_path(name, "drawer")
    if src is None or not src.is_file():
        return {"ok": False, "error": "not found"}
    new = _stem(title, None)
    if not new:
        return {"ok": False, "error": "bad name"}
    old = src.stem
    if new != old:
        files = [f for f in DIAGRAMS.iterdir() if f.is_file() and f.stem == old and f.suffix.lower() in _DIAGRAM_EXTS]
        if any((DIAGRAMS / (new + x)).exists() for x in _DIAGRAM_EXTS):
            return {"ok": False, "error": "a diagram called %s already exists" % new, "exists": True}
        for f in files:
            f.rename(DIAGRAMS / (new + f.suffix))
    notes = 0
    if new != old:
        pairs = [("[[%s%s" % (old, x), "[[%s%s" % (new, x)) for x in (".png", ".aioadraw")]
        seen = set()
        for needle, _ in pairs:
            for f in _embed_notes(needle):
                if f in seen:
                    continue
                seen.add(f)
                try:
                    t = f.read_text(encoding="utf-8")
                    n = t
                    for a, b in pairs:
                        n = n.replace(a + "]]", b + "]]").replace(a + "|", b + "|")
                    if n != t:
                        no._atomic_write(f, n)
                        notes += 1
                except OSError:
                    pass
    dst, png = DIAGRAMS / (new + ".aioadraw"), DIAGRAMS / (new + ".png")
    out = {"ok": True, "name": dst.name, "title": new, "png": png.name, "embed": "![[%s]]" % png.name,
           "mtime": int(dst.stat().st_mtime), "notes": notes, "path": dst.relative_to(VAULT).as_posix()}
    if png.exists():
        out["url"] = "/notes/attachment?name=%s&v=%d" % (quote(png.name), int(png.stat().st_mtime))
    return out


def restore_diagram(moved):
    """Undo archive_diagram: move each archived file back if its old name is free."""
    adir = DIAGRAMS / "archive"
    back = []
    for m in moved or []:
        if not isinstance(m, dict):
            return {"ok": False, "error": "bad name"}
        src_name, dst_name = str(m.get("to") or ""), str(m.get("from") or "")
        if not src_name or not dst_name or any(c in src_name + dst_name for c in "/\\\x00") \
                or src_name.startswith(".") or dst_name.startswith("."):
            return {"ok": False, "error": "bad name"}
        src, dst = adir / src_name, DIAGRAMS / dst_name
        if src.suffix.lower() not in _DIAGRAM_EXTS or dst.suffix.lower() != src.suffix.lower():
            return {"ok": False, "error": "bad name"}
        if not src.is_file():
            continue
        if dst.exists():
            return {"ok": False, "error": "%s already exists" % dst_name, "restored": back}
        src.rename(dst)
        back.append(dst_name)
    return {"ok": True, "restored": back}
