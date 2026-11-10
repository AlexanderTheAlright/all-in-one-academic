"""Explore view backend: the shared exploratory-figure store."""
import settings

import contextlib
import fcntl
import hashlib
import json
import os
import re
import subprocess
import sys
import threading
import time
import uuid
from datetime import datetime
from pathlib import Path
from urllib.parse import quote

# YYYYMMDD-HHMMSS-<slug>. Anything else never touches the filesystem.
ID_RE = re.compile(r"^[0-9]{8}-[0-9]{6}-[a-z0-9-]{1,40}$")

COMMENTS_NAME = ".figure-comments.json"
INDEX_NAME = "index.json"
RENDER_TIMEOUT = 20        # seconds, one chart
FIGTOOL_TIMEOUT = 120       # seconds, an index rebuild or a refetch
SCRIPTS_OFF = "running vault scripts is disabled (run_vault_scripts)"
MAX_SPEC_BYTES = 200 * 1024
THEMES = ("day", "night")


# --------------------------------------------------------------------- locations

def store_root(vault=None):
    env = (os.environ.get("EXPLORE_FIGURES") or "").strip()
    if env:
        return Path(env).expanduser()
    if vault is not None:
        return Path(vault) / "Projects" / "scratch" / "figures"
    return settings.VAULT / "Projects" / "scratch" / "figures"


def scripts_enabled():
    """The renderer and the figure producer are code kept in the vault's data folder;
    they run only when the run_vault_scripts setting is on."""
    return bool(settings.RUN_VAULT_SCRIPTS)


def hub_dir(vault=None):
    """The vault's data folder: cwd and PYTHONPATH for vlrender.py and `python -m figtool`."""
    if vault is not None:
        return Path(vault) / "Projects" / "data"
    return settings.VAULT / "Projects" / "data"


def hub_code_dir(vault=None):
    code = hub_dir(vault) / "hub"
    return code if code.is_dir() else hub_dir(vault)


def renderer_path(vault=None):
    """vlrender.py in the data folder; EXPLORE_VLRENDER overrides it."""
    env = (os.environ.get("EXPLORE_VLRENDER") or "").strip()
    return Path(env).expanduser() if env else hub_code_dir(vault) / "vlrender.py"


def hub_python():
    """The interpreter for the renderer: EXPLORE_PYTHON, else this server's own."""
    env = (os.environ.get("EXPLORE_PYTHON") or "").strip()
    if env:
        return Path(env).expanduser()
    return Path(sys.executable)


def queue_path(vault=None):
    """Comments flagged for follow-up, one JSON line each, in the state dir."""
    return settings.STATE_DIR / "explore" / "queue.jsonl"


def fig_dir(vault, fid):
    """The directory for `fid`, or None. Two gates, both required: the id must match
    ID_RE, and the resolved path must still sit inside the store (a symlinked figure
    directory pointing out of the store resolves out and is refused)."""
    fid = (fid or "").strip()
    if not ID_RE.match(fid):
        return None
    root = store_root(vault)
    try:
        rroot = root.resolve()
        p = (root / fid).resolve()
    except OSError:
        return None
    if p != rroot and rroot not in p.parents:
        return None
    return p if p.is_dir() else None


# ------------------------------------------------------------------ small helpers

def _read_json(p, default=None):
    try:
        raw = p.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return default
    try:
        return json.loads(raw) if raw.strip() else default
    except ValueError:
        return default


def _atomic_write_json(p, obj):
    tmp = Path(str(p) + ".tmp")
    tmp.parent.mkdir(parents=True, exist_ok=True)
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(str(tmp), str(p))


def _atomic_write_bytes(p, raw):
    tmp = Path(str(p) + ".tmp")
    tmp.parent.mkdir(parents=True, exist_ok=True)
    tmp.write_bytes(raw)
    os.replace(str(tmp), str(p))


def _mt(p):
    try:
        return int(p.stat().st_mtime)
    except OSError:
        return 0


def _now():
    return datetime.now().replace(microsecond=0).isoformat()


def _theme(t):
    t = (t or "day").strip().lower()
    return t if t in THEMES else "day"


_COMMENT_KEYS = ("id", "x", "y", "w", "h", "body", "resolved",
                 "author", "created", "updated", "reply", "for_agent")


def _comments_file(vault):
    return store_root(vault) / COMMENTS_NAME


def _version_of(cmap):
    raw = json.dumps(cmap or {}, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _clean_comment(c, fallback_author="owner"):
    """One stored comment, every field typed. Fractional coords are clamped to [0,1]:
    a whole-figure anchor is 0,0,1,1 and a point is w=h=0."""
    if not isinstance(c, dict):
        return None
    cid = str(c.get("id") or "").strip()
    if not cid:
        cid = uuid.uuid4().hex[:8]

    def frac(k, d=0.0):
        try:
            v = float(c.get(k, d))
        except (TypeError, ValueError):
            v = d
        return max(0.0, min(1.0, round(v, 5)))

    out = {
        "id": cid,
        "x": frac("x"), "y": frac("y"), "w": frac("w"), "h": frac("h"),
        "body": str(c.get("body") or "").strip(),
        "resolved": bool(c.get("resolved")),
        "author": str(c.get("author") or fallback_author).strip() or fallback_author,
        "created": str(c.get("created") or _now()),
        "updated": str(c.get("updated") or c.get("created") or _now()),
        "reply": str(c.get("reply") or ""),
        "for_agent": bool(c.get("for_agent")),
    }
    return out if out["body"] or out["reply"] else None


def _load_comment_map(vault):
    """-> (the RAW map as it sits on disk, its version)."""
    p = _comments_file(vault)
    data = _read_json(p, None)
    cmap = data.get("comments") if isinstance(data, dict) else None
    if not isinstance(cmap, dict):
        cmap = {}
    raw = {str(k): v for k, v in cmap.items()
           if ID_RE.match(str(k) or "") and isinstance(v, list) and v}
    return raw, _version_of(raw)


@contextlib.contextmanager
def _comment_lock(vault):
    """An exclusive flock on `.figure-comments.lock` around every read-merge-write, so
    two writers never race on the same file."""
    root = store_root(vault)
    try:
        root.mkdir(parents=True, exist_ok=True)
        lk = root / ".figure-comments.lock"
        lk.touch(exist_ok=True)
        fh = lk.open("r+")
    except OSError:
        yield None          # a store we cannot lock still works, just unserialised
        return
    try:
        fcntl.flock(fh, fcntl.LOCK_EX)
        yield fh
    finally:
        try:
            fcntl.flock(fh, fcntl.LOCK_UN)
        finally:
            fh.close()


def load_comments(vault, fid):
    """Comments for ONE figure plus the store-wide version the caller must pin to."""
    if not ID_RE.match((fid or "").strip()):
        return {"error": "bad id"}
    cmap, version = _load_comment_map(vault)
    items = [c for c in (_clean_comment(i) for i in cmap.get(fid, [])) if c]
    return {"ok": True, "id": fid, "comments": items, "version": version}


def save_comments(vault, fid, items, base_version):
    """Read-merge-write for ONE figure's list, pinned to a content hash of the whole
    store. A mismatch writes nothing and returns 409-shaped state."""
    if not ID_RE.match((fid or "").strip()):
        return {"error": "bad id"}
    if base_version is None:
        return {"error": "unversioned write: read before you write"}
    with _comment_lock(vault):
        cmap, version = _load_comment_map(vault)
        if str(base_version) != version:
            return {"conflict": True, "error": "the comment store moved under this save",
                    "currentComments": [c for c in (_clean_comment(i) for i in cmap.get(fid, [])) if c],
                    "currentVersion": version}
        cleaned = [c for c in (_clean_comment(i) for i in (items or [])) if c]
        # a figure with no comments leaves the map entirely, so the store stays small
        if cleaned:
            cmap[fid] = cleaned
        else:
            cmap.pop(fid, None)
        new_version = _version_of(cmap)
        _atomic_write_json(_comments_file(vault), {"version": new_version, "comments": cmap})
    _INDEX["stamp"] = None      # open-comment counts moved
    return {"ok": True, "id": fid, "comments": cleaned, "version": new_version}


def to_agent(vault, fid, comment_id):
    """Flag one comment `for_agent` and append a line to the queue file. The queue is
    append-only JSONL so a reader never has to lock it, and it carries the absolute
    spec path."""
    d = fig_dir(vault, fid)
    if d is None:
        return {"error": "unknown figure"}
    cid = str(comment_id or "").strip()
    if not cid:
        return {"error": "commentId required"}
    with _comment_lock(vault):
        cmap, _ = _load_comment_map(vault)
        items = cmap.get(fid) or []
        hit = next((c for c in items if str(c.get("id")) == cid), None)
        if hit is None:
            return {"error": "unknown comment"}
        hit["for_agent"] = True
        hit["updated"] = _now()
        new_version = _version_of(cmap)
        _atomic_write_json(_comments_file(vault), {"version": new_version, "comments": cmap})
    hit = _clean_comment(hit) or hit
    _INDEX["stamp"] = None
    _queue_line(vault, {"ts": _now(), "source": "open", "id": fid, "commentId": cid,
                        "body": hit.get("body") or "", "spec": str(d / "spec.json"),
                        "comments": str(_comments_file(vault))})
    return {"ok": True, "id": fid, "comment": hit, "version": new_version,
            "queue": str(queue_path(vault))}


def _queue_line(vault, obj):
    """One JSONL line in the queue file, with the absolute path of the comments file
    the remark came from."""
    q = queue_path(vault)
    q.parent.mkdir(parents=True, exist_ok=True)
    with open(q, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(obj, ensure_ascii=False) + "\n")
    return q


def to_agent_project(vault, slug, stem, comment_id):
    """The project twin of to_agent: flag the comment in the paper's own
    results/.figure-comments.json and queue it with that file's absolute path."""
    import drafting
    cid = str(comment_id or "").strip()
    if not cid:
        return {"error": "commentId required"}
    cur = drafting.load_figure_comments(vault, slug)
    if cur.get("error"):
        return cur
    items = list((cur.get("comments") or {}).get(stem) or [])
    hit = next((c for c in items if str(c.get("id")) == cid), None)
    if hit is None:
        return {"error": "unknown comment"}
    hit["for_agent"] = True
    res = drafting.save_figure_comments(vault, slug, stem, items,
                                        base_version=cur.get("version"))
    if not res.get("ok"):
        return res
    proj = drafting._project_dir(vault, slug or "")
    cfile = (proj / "results" / ".figure-comments.json") if proj else None
    _queue_line(vault, {"ts": _now(), "source": "project", "slug": slug, "stem": stem,
                        "commentId": cid, "body": hit.get("body") or "",
                        "spec": str(proj / "results" / (stem + ".spec.json")) if proj else "",
                        "comments": str(cfile) if cfile else ""})
    return {"ok": True, "slug": slug, "stem": stem, "comment": hit,
            "version": res.get("version"), "mtime": res.get("mtime"),
            "queue": str(queue_path(vault))}


_INDEX = {"stamp": None, "value": None}
_INDEX_LOCK = threading.Lock()


def _scan_index(root):
    """Rebuild the listing from the directories themselves. The producers own
    index.json; this is the fallback for a store whose index has not been written yet,
    so the view is never empty when figures exist."""
    figs = []
    try:
        names = sorted((p.name for p in root.iterdir() if p.is_dir()), reverse=True)
    except OSError:
        return {"generated": _now(), "figures": []}
    for name in names:
        if not ID_RE.match(name):
            continue
        spec = _read_json(root / name / "spec.json", None)
        if not isinstance(spec, dict):
            continue
        meta = _read_json(root / name / "data.meta.json", {}) or {}
        png = "figure.png" if (root / name / "figure.png").exists() else ""
        figs.append({
            "id": spec.get("id") or name,
            "title": spec.get("title") or spec.get("name") or name,
            "kind": spec.get("kind") or "vl",
            "lane": spec.get("lane") or "",
            "created": spec.get("created") or "",
            "updated": spec.get("updated") or spec.get("created") or "",
            "open_comments": 0,
            "n_rows": meta.get("n_rows") or (spec.get("source") or {}).get("n_rows") or 0,
            "png": png,
        })
    return {"generated": _now(), "figures": figs}


def rebuild_index(vault):
    """Write index.json ourselves, for when the producer's own index step is not
    available."""
    root = store_root(vault)
    root.mkdir(parents=True, exist_ok=True)
    idx = _scan_index(root)
    _atomic_write_json(root / INDEX_NAME, idx)
    _INDEX["stamp"] = None
    return idx


def load_index(vault):
    """The listing, newest first, with `openComments` merged from the comments store."""
    root = store_root(vault)
    ip = root / INDEX_NAME
    stamp = (str(root), _mt(ip), _mt(_comments_file(vault)), scripts_enabled())
    with _INDEX_LOCK:
        if _INDEX["stamp"] == stamp and _INDEX["value"] is not None:
            return _INDEX["value"]
    if not root.is_dir():
        out = {"ok": True, "generated": _now(), "figures": [], "root": str(root),
               "canRender": scripts_enabled(),
               "note": "the figure store does not exist yet"}
        with _INDEX_LOCK:
            _INDEX["stamp"], _INDEX["value"] = stamp, out
        return out
    idx = _read_json(ip, None)
    if not isinstance(idx, dict) or not isinstance(idx.get("figures"), list):
        idx = _scan_index(root)
    cmap, _ = _load_comment_map(vault)
    figs = []
    for f in idx.get("figures") or []:
        if not isinstance(f, dict):
            continue
        fid = str(f.get("id") or "")
        if not ID_RE.match(fid):
            continue
        open_n = sum(1 for c in cmap.get(fid, []) if not c.get("resolved"))
        agent_n = sum(1 for c in cmap.get(fid, []) if c.get("for_agent") and not c.get("resolved"))
        g = dict(f)
        g["openComments"] = open_n
        g["forAgent"] = agent_n
        g["open_comments"] = open_n     # the producers' own key, kept in step
        figs.append(g)
    out = {"ok": True, "generated": idx.get("generated") or _now(),
           "figures": figs, "root": str(root), "canRender": scripts_enabled()}
    with _INDEX_LOCK:
        _INDEX["stamp"], _INDEX["value"] = stamp, out
    return out


# ------------------------------------------------------------------------ one figure

def load_figure(vault, fid):
    """spec.json + data.meta.json + this figure's comments + the comments version."""
    d = fig_dir(vault, fid)
    if d is None:
        return {"error": "unknown figure"}
    spec = _read_json(d / "spec.json", None)
    if not isinstance(spec, dict):
        return {"error": "figure has no spec.json"}
    meta = _read_json(d / "data.meta.json", None)
    cmap, version = _load_comment_map(vault)
    return {
        "ok": True, "id": fid, "spec": spec, "meta": meta,
        "comments": cmap.get(fid, []), "version": version,
        "hasData": (d / "data.json").exists(),
        "hasSvg": (d / "figure.svg").exists(),
        "hasPng": (d / "figure.png").exists(),
        "canRender": scripts_enabled(),
        "dir": str(d),
    }


def data_bytes(vault, fid):
    """data.json verbatim. serve.py sends it through the shared payload path, which
    negotiates gzip/zstd for it like any other JSON."""
    d = fig_dir(vault, fid)
    if d is None:
        return None, {"error": "unknown figure"}
    p = d / "data.json"
    if not p.exists():
        return None, {"error": "no data.json for this figure"}
    try:
        return p.read_bytes(), None
    except OSError as exc:
        return None, {"error": str(exc)}


# ------------------------------------------------------------------------ rendering

def _run_renderer(vault, fig, spec_obj, theme, fmt):
    """One vlrender run. The spec goes in on stdin and the picture comes out on stdout,
    so nothing is written anywhere the caller did not ask for. Returns (bytes, None) or
    (None, {"error": ...}) with the renderer's own stderr folded in."""
    if not scripts_enabled():
        return None, {"error": SCRIPTS_OFF}
    rp = renderer_path(vault)
    if not rp.exists():
        return None, {"error": "renderer not installed: " + str(rp)}
    py = hub_python()
    if not py.exists():
        return None, {"error": "interpreter missing: " + str(py)}
    env = dict(os.environ)
    env["PYTHONPATH"] = str(hub_code_dir(vault)) + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")
    argv = [str(py), str(rp), "--spec", "-", "--data", str(fig),
            "--theme", _theme(theme), "--format", fmt, "--out", "-"]
    payload = json.dumps(spec_obj, ensure_ascii=False).encode("utf-8")
    try:
        proc = subprocess.run(argv, input=payload, cwd=str(hub_dir(vault)), env=env,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              timeout=RENDER_TIMEOUT)
    except subprocess.TimeoutExpired:
        return None, {"error": "render timed out after %ds" % RENDER_TIMEOUT}
    except OSError as exc:
        return None, {"error": str(exc)}
    if proc.returncode != 0 or not proc.stdout:
        err = (proc.stderr or b"").decode("utf-8", "replace").strip()
        detail = ""
        try:
            detail = (json.loads(err.splitlines()[-1]) or {}).get("error") or ""
        except Exception:
            pass
        return None, {"error": detail or err[-800:] or "render failed (exit %d)" % proc.returncode}
    return proc.stdout, None


_STAMP = "<!--explore-night-version:%d-->"
_STAMP_RE = re.compile(rb"<!--explore-night-version:(\d+)-->\s*$")


def render_saved(vault, fid, theme="day", version=None):
    """The picture for the SAVED spec. Day is the file the producer already wrote;
    night is rendered once per spec version and cached as figure.night.svg."""
    d = fig_dir(vault, fid)
    if d is None:
        return None, None, {"error": "unknown figure"}
    spec = _read_json(d / "spec.json", None)
    if not isinstance(spec, dict):
        return None, None, {"error": "figure has no spec.json"}
    theme = _theme(theme)
    kind = spec.get("kind") or "vl"
    svg, png = d / "figure.svg", d / "figure.png"

    if kind != "vl":
        # a static image carries no spec to re-theme: serve what the producer made
        if svg.exists():
            return svg.read_bytes(), "image/svg+xml", None
        if png.exists():
            return png.read_bytes(), "image/png", None
        return None, None, {"error": "no image for this figure"}

    if theme == "day":
        if svg.exists():
            return svg.read_bytes(), "image/svg+xml", None
        if png.exists():
            return png.read_bytes(), "image/png", None
        # never rendered: fall through and draw it now
        theme_spec = spec.get("vl")
        if not isinstance(theme_spec, dict):
            return None, None, {"error": "figure has no vl spec"}
        raw, err = _run_renderer(vault, d, theme_spec, "day", "svg")
        if err:
            return None, None, err
        _atomic_write_bytes(svg, raw)
        return raw, "image/svg+xml", None

    want = int(spec.get("version") or 1)
    night = d / "figure.night.svg"
    if night.exists():
        try:
            cached = night.read_bytes()
        except OSError:
            cached = b""
        m = _STAMP_RE.search(cached)
        if m and int(m.group(1)) == want:
            return cached, "image/svg+xml", None
    vl = spec.get("vl")
    if not isinstance(vl, dict):
        return None, None, {"error": "figure has no vl spec"}
    raw, err = _run_renderer(vault, d, vl, "night", "svg")
    if err:
        return None, None, err
    raw = raw + (_STAMP % want).encode("utf-8")
    try:
        _atomic_write_bytes(night, raw)
    except OSError:
        pass        # a read-only store still gets its picture, just not the cache
    return raw, "image/svg+xml", None


def render_preview(vault, fid, vl, theme="day"):
    """Render an UNSAVED spec -- the live preview behind every control in the Edit tab.
    Writes nothing. The body cap is checked by the caller before the JSON is parsed."""
    d = fig_dir(vault, fid)
    if d is None:
        return None, {"error": "unknown figure"}
    if not isinstance(vl, dict) or not vl:
        return None, {"error": "vl spec required"}
    return _run_renderer(vault, d, vl, theme, "svg")


# ------------------------------------------------------------------------ spec save

def _figtool(vault, args, timeout=FIGTOOL_TIMEOUT):
    """`python -m figtool <args>` in the data folder. Returns (ok, detail). Never
    raises: a missing module is a fallback, not a failure."""
    if not scripts_enabled():
        return False, SCRIPTS_OFF
    py = hub_python()
    if not py.exists():
        return False, "interpreter missing: " + str(py)
    env = dict(os.environ)
    env["PYTHONPATH"] = str(hub_code_dir(vault)) + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")
    try:
        proc = subprocess.run([str(py), "-m", "figtool"] + list(args),
                              cwd=str(hub_dir(vault)), env=env,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    except subprocess.TimeoutExpired:
        return False, "figtool timed out"
    except OSError as exc:
        return False, str(exc)
    if proc.returncode != 0:
        return False, (proc.stderr or b"").decode("utf-8", "replace").strip()[-800:]
    return True, (proc.stdout or b"").decode("utf-8", "replace").strip()[-800:]


def _rerender_saved(vault, d, spec):
    """Redraw figure.svg + figure.png from the saved spec and drop the stale night
    cache. Reported, never fatal: the spec is the record and it is already written."""
    out = {}
    vl = spec.get("vl")
    if not isinstance(vl, dict):
        return {"render": "no vl spec"}
    raw, err = _run_renderer(vault, d, vl, "day", "svg")
    if err:
        out["render"] = err.get("error")
    else:
        _atomic_write_bytes(d / "figure.svg", raw)
    png, perr = _run_renderer(vault, d, vl, "day", "png")
    if perr:
        out["renderPng"] = perr.get("error")
    else:
        _atomic_write_bytes(d / "figure.png", png)
    night = d / "figure.night.svg"
    if night.exists():
        try:
            night.unlink()
        except OSError:
            pass
    return out


def save_spec(vault, fid, vl, title=None, base_version=None, note="edited in the app"):
    """Rotate, bump, re-render. Pinned to the spec's integer `version`: a mismatch
    writes nothing and returns the current spec so the caller can reload."""
    d = fig_dir(vault, fid)
    if d is None:
        return {"error": "unknown figure"}
    spec = _read_json(d / "spec.json", None)
    if not isinstance(spec, dict):
        return {"error": "figure has no spec.json"}
    if (spec.get("kind") or "vl") != "vl":
        return {"error": "this is a static figure: comment only"}
    if not isinstance(vl, dict) or not vl:
        return {"error": "vl spec required"}
    cur = int(spec.get("version") or 1)
    try:
        base = int(base_version)
    except (TypeError, ValueError):
        return {"error": "unversioned write: read before you write"}
    if base != cur:
        return {"conflict": True, "error": "this figure was saved elsewhere (v%d)" % cur,
                "currentSpec": spec, "currentVersion": cur}
    # the spec must still point at the figure's own data or the renderer reads nothing
    data = vl.get("data")
    if isinstance(data, dict) and "url" in data:
        vl = dict(vl)
        vl["data"] = {"url": "data.json"}
    # rotate the OLD spec under its own version number, then bump
    try:
        _atomic_write_json(d / ("spec.v%d.json" % cur), spec)
    except OSError as exc:
        return {"error": "could not rotate the old spec: " + str(exc)}
    nxt = cur + 1
    spec = dict(spec)
    spec["version"] = nxt
    spec["vl"] = vl
    if title is not None and str(title).strip():
        spec["title"] = str(title).strip()
    spec["updated"] = _now()
    hist = list(spec.get("history") or [])
    hist.append({"version": nxt, "at": spec["updated"], "by": "app", "note": note})
    spec["history"] = hist
    _atomic_write_json(d / "spec.json", spec)
    out = {"ok": True, "id": fid, "spec": spec, "version": nxt}
    out.update(_rerender_saved(vault, d, spec))
    ok, detail = _figtool(vault, ["index"])
    if not ok:
        rebuild_index(vault)
        out["index"] = "rebuilt locally (" + (detail or "figtool unavailable") + ")"
    _INDEX["stamp"] = None
    return out


STEM_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$")


def project_target(vault, slug, stem):
    """-> (results dir, spec path) for a project figure, or (None, None). The stem is
    pattern-checked and the resolved spec must still sit inside results/."""
    if not STEM_RE.match((stem or "").strip()):
        return None, None
    try:
        import drafting
        proj = drafting._project_dir(vault, slug or "")
    except Exception:
        proj = None
    if not proj:
        return None, None
    try:
        res = (proj / "results").resolve()
        sp = (res / (str(stem).strip() + ".spec.json")).resolve()
    except OSError:
        return None, None
    if res not in sp.parents:
        return None, None
    return res, sp


def load_project_figure(vault, slug, stem):
    """The sibling spec for a project figure, if its producer left one."""
    res, sp = project_target(vault, slug, stem)
    if res is None:
        return {"error": "unknown project figure"}
    if not sp.exists():
        return {"ok": True, "hasSpec": False, "spec": None, "meta": None}
    spec = _read_json(sp, None)
    if not isinstance(spec, dict):
        return {"ok": True, "hasSpec": False, "spec": None, "meta": None}
    meta = _read_json(res / (stem + ".data.meta.json"), None)
    return {"ok": True, "hasSpec": True, "spec": spec, "meta": meta,
            "hasData": (res / (stem + ".data.json")).exists()}


def render_project_preview(vault, slug, stem, vl, theme="day"):
    res, sp = project_target(vault, slug, stem)
    if res is None:
        return None, {"error": "unknown project figure"}
    if not isinstance(vl, dict) or not vl:
        return None, {"error": "vl spec required"}
    return _run_renderer(vault, res, vl, theme, "svg")


def save_project_spec(vault, slug, stem, vl, title=None, base_version=None):
    """Rotate `<stem>.spec.v<N>.json`, bump, re-render `<stem>.svg`/`.png`, and leave a
    note in results/provenance.json so the integrity surfaces know the app touched it."""
    res, sp = project_target(vault, slug, stem)
    if res is None:
        return {"error": "unknown project figure"}
    if not sp.exists():
        return {"error": "this figure has no editable spec"}
    spec = _read_json(sp, None)
    if not isinstance(spec, dict):
        return {"error": "unreadable spec"}
    if not isinstance(vl, dict) or not vl:
        return {"error": "vl spec required"}
    cur = int(spec.get("version") or 1)
    try:
        base = int(base_version)
    except (TypeError, ValueError):
        return {"error": "unversioned write: read before you write"}
    if base != cur:
        return {"conflict": True, "error": "this figure was saved elsewhere (v%d)" % cur,
                "currentSpec": spec, "currentVersion": cur}
    try:
        _atomic_write_json(res / ("%s.spec.v%d.json" % (stem, cur)), spec)
    except OSError as exc:
        return {"error": "could not rotate the old spec: " + str(exc)}
    nxt = cur + 1
    spec = dict(spec)
    spec["version"] = nxt
    spec["vl"] = vl
    if title is not None and str(title).strip():
        spec["title"] = str(title).strip()
    spec["updated"] = _now()
    hist = list(spec.get("history") or [])
    hist.append({"version": nxt, "at": spec["updated"], "by": "app", "note": "edited in the app"})
    spec["history"] = hist
    _atomic_write_json(sp, spec)
    out = {"ok": True, "slug": slug, "stem": stem, "spec": spec, "version": nxt}
    raw, err = _run_renderer(vault, res, vl, "day", "svg")
    if err:
        out["render"] = err.get("error")
    else:
        _atomic_write_bytes(res / (stem + ".svg"), raw)
    png, perr = _run_renderer(vault, res, vl, "day", "png")
    if perr:
        out["renderPng"] = perr.get("error")
    else:
        _atomic_write_bytes(res / (stem + ".png"), png)
    night = res / (stem + ".night.svg")
    if night.exists():
        try:
            night.unlink()
        except OSError:
            pass
    # a note in the project's own provenance record, never a rewrite of it
    pp = res / "provenance.json"
    prov = _read_json(pp, None)
    if isinstance(prov, dict):
        entries = prov.get("entries")
        if isinstance(entries, dict):
            e = entries.get(stem)
            if isinstance(e, dict):
                e["manualNote"] = ("spec v%d edited in the app on %s" % (nxt, spec["updated"]))
                try:
                    _atomic_write_json(pp, prov)
                except OSError:
                    out["provenance"] = "could not write provenance.json"
    return out


def render_project_saved(vault, slug, stem, theme="day"):
    """The saved picture for a project figure with a spec: day is `<stem>.svg` on disk,
    night is rendered once per spec version and cached as `<stem>.night.svg`."""
    res, sp = project_target(vault, slug, stem)
    if res is None:
        return None, None, {"error": "unknown project figure"}
    theme = _theme(theme)
    svg, png = res / (stem + ".svg"), res / (stem + ".png")
    spec = _read_json(sp, None) if sp.exists() else None
    if theme == "day" or not isinstance(spec, dict) or not isinstance(spec.get("vl"), dict):
        if svg.exists():
            return svg.read_bytes(), "image/svg+xml", None
        if png.exists():
            return png.read_bytes(), "image/png", None
        return None, None, {"error": "no image for this figure"}
    want = int(spec.get("version") or 1)
    night = res / (stem + ".night.svg")
    if night.exists():
        try:
            cached = night.read_bytes()
        except OSError:
            cached = b""
        m = _STAMP_RE.search(cached)
        if m and int(m.group(1)) == want:
            return cached, "image/svg+xml", None
    raw, err = _run_renderer(vault, res, spec["vl"], "night", "svg")
    if err:
        return None, None, err
    raw = raw + (_STAMP % want).encode("utf-8")
    try:
        _atomic_write_bytes(night, raw)
    except OSError:
        pass
    return raw, "image/svg+xml", None


def refetch(vault, fid):
    """Re-pull this figure's data through the producer, then redraw it. The producer
    owns the query; this only asks and reports."""
    d = fig_dir(vault, fid)
    if d is None:
        return {"error": "unknown figure"}
    ok, detail = _figtool(vault, ["refetch", fid])
    if not ok:
        return {"error": detail if detail == SCRIPTS_OFF
                else "refetch failed: " + (detail or "figtool unavailable")}
    spec = _read_json(d / "spec.json", None) or {}
    out = {"ok": True, "id": fid, "detail": detail,
           "meta": _read_json(d / "data.meta.json", None), "spec": spec}
    out.update(_rerender_saved(vault, d, spec))
    _INDEX["stamp"] = None
    return out


GALLERY_EXT = (".png", ".svg")
IMAGE_TYPES = {".png": "image/png", ".svg": "image/svg+xml", ".jpg": "image/jpeg",
               ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif"}
GALLERY_SKIP = {"archive", "archives", "_archive", "_retired", "old",
                "build", ".cache", "__pycache__", "node_modules", ".ipynb_checkpoints"}
GALLERY_MAX = 120                      # a small pane, not a file manager
INTERACTIVE_DIR = "interactive"
INTERACTIVE_EXT = ".html"
INTERACTIVE_MAX = 25 * 1024 * 1024     # a self-contained plotly page, not a dataset
INTERACTIVE_ASSET_EXT = ".js"
INTERACTIVE_ASSET_MAX = 8 * 1024 * 1024
# the ONLY basenames the asset route will ever hand back: plotly's own bundle, however
# the version is spelled. Anything else in that directory is not reachable through it.
INTERACTIVE_ASSET_RE = re.compile(r"^plotly[\w.-]*\.min\.js$")
INTERACTIVE_CSP = ("default-src 'none'; script-src 'unsafe-inline' 'self'; "
                   "style-src 'unsafe-inline'; img-src data: blob:; font-src data:; "
                   "connect-src 'none'; worker-src blob:; child-src 'none'; "
                   "frame-ancestors 'self'; base-uri 'none'; form-action 'none'; "
                   "sandbox allow-scripts")
PROJECT_PARENTS = ("papers", "papers/archive", "grants", "briefs", "experiments")
PROJECT_PREFIX = settings.PROJECT_PREFIX
SCRIPT_EXT = (".py", ".r", ".do", ".ipynb", ".sql")
# stems are numbered and prefixed by convention; those parts never identify a script
STEM_NOISE = {"fig", "figure", "figs", "tab", "table", "plot", "chart", "png", "svg"}

_GALLERY = {}
_GALLERY_LOCK = threading.Lock()
_DIMS = {}


def _kebab(name):
    """lower, spaces to dashes, drop everything that is not alnum or dash, collapse
    runs, trim."""
    s = (name or "").lower().replace(" ", "-")
    s = re.sub(r"[^a-z0-9-]", "", s)
    return re.sub(r"-{2,}", "-", s).strip("-")


def project_root(vault, slug):
    """The project directory a gallery slug names, or None."""
    slug = (slug or "").strip()
    if not slug or "/" in slug or slug.startswith("."):
        return None
    try:
        import drafting
        p = drafting._project_dir(vault, slug)
        if p and Path(p).is_dir():
            return Path(p)
    except Exception:
        pass
    want = _kebab(slug)
    if not want:
        return None
    base = Path(vault) / "Projects"
    for parent in PROJECT_PARENTS:
        try:
            entries = list(os.scandir(base / parent))
        except OSError:
            continue
        for e in entries:
            if not e.is_dir():
                continue
            name = e.name[len(PROJECT_PREFIX):] if e.name.startswith(PROJECT_PREFIX) else e.name
            if name == slug or _kebab(name) == want:
                return Path(e.path)
    try:
        entries = list(os.scandir(base / "data"))
    except OSError:
        entries = []
    for e in entries:
        if e.name.startswith(".") or not e.is_dir():
            continue
        if (e.name == slug or _kebab(e.name) == want) and \
                os.path.isdir(os.path.join(e.path, "datasets")):
            return Path(e.path)
    return None


def _img_dims(path, mtime, size):
    key = (str(path), int(mtime), int(size))
    hit = _DIMS.get(key)
    if hit is not None:
        return hit
    w = h = 0
    try:
        with open(path, "rb") as fh:
            head = fh.read(2048)
        if head[:8] == b"\x89PNG\r\n\x1a\n" and head[12:16] == b"IHDR":
            w = int.from_bytes(head[16:20], "big")
            h = int.from_bytes(head[20:24], "big")
        else:
            m = re.search(rb'viewBox\s*=\s*["\']\s*[-0-9.]+[ ,]+[-0-9.]+[ ,]+([0-9.]+)[ ,]+([0-9.]+)', head)
            if m:
                w, h = int(float(m.group(1))), int(float(m.group(2)))
            else:
                mw = re.search(rb'\swidth\s*=\s*["\']([0-9.]+)', head)
                mh = re.search(rb'\sheight\s*=\s*["\']([0-9.]+)', head)
                if mw and mh:
                    w, h = int(float(mw.group(1))), int(float(mh.group(1)))
    except (OSError, ValueError):
        w = h = 0
    if len(_DIMS) > 4000:
        _DIMS.clear()
    _DIMS[key] = (w, h)
    return w, h


def _walk_images(root, base):
    """[(rel, mtime, size)] for every picture under `root`, relative to `base`."""
    out = []
    if not root.is_dir():
        return out
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in GALLERY_SKIP and not d.startswith("."))
        for fn in sorted(filenames):
            if fn.startswith(".") or not fn.lower().endswith(GALLERY_EXT):
                continue
            p = Path(dirpath) / fn
            try:
                st = p.stat()
            except OSError:
                continue
            out.append((str(p.relative_to(base)).replace(os.sep, "/"), st.st_mtime, st.st_size))
    return out


def _walk_interactive(root, base):
    """[(rel, mtime, size)] for every .html under `root`, relative to `base`. Same skip
    rules as the picture walk: an archived copy is still a file, never a card."""
    out = []
    if not root.is_dir():
        return out
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in GALLERY_SKIP and not d.startswith("."))
        for fn in sorted(filenames):
            if fn.startswith(".") or not fn.lower().endswith(INTERACTIVE_EXT):
                continue
            p = Path(dirpath) / fn
            try:
                st = p.stat()
            except OSError:
                continue
            if not p.is_file() or st.st_size > INTERACTIVE_MAX:
                continue
            out.append((str(p.relative_to(base)).replace(os.sep, "/"), st.st_mtime, st.st_size))
    return out


def _vstamp(path, mtime):
    """the image URL's version: `<mtime_ns hex>-<size hex>`, the same stamp /drafting/asset
    treats as immutable, so a re-render inside the same second still gets a new URL."""
    try:
        st = Path(path).stat()
        return "%x-%x" % (st.st_mtime_ns, st.st_size)
    except OSError:
        return str(int(mtime))


def _one_per_stem(rows):
    best = {}
    for rel, mtime, size in rows:
        stem = rel.rsplit("/", 1)[-1].rsplit(".", 1)[0]
        rank = (rel.count("/"), 0 if rel.lower().endswith(".png") else 1, -mtime)
        cur = best.get(stem)
        if cur is None or rank < cur[0]:
            best[stem] = (rank, rel, mtime, size)
    out = [(s, r, m, z) for s, (_, r, m, z) in best.items()]
    out.sort(key=lambda t: (-t[2], t[0]))
    return out


def _gallery_provenance(proj):
    """results/provenance.json, whichever shape is on disk: the flat {stem: entry} map
    the file carries, or the {"entries": {...}} the Drafting endpoint hands out."""
    d = _read_json(proj / "results" / "provenance.json", None)
    if isinstance(d, dict) and isinstance(d.get("entries"), dict):
        d = d["entries"]
    return d if isinstance(d, dict) else {}


def _script_index(proj):
    """Candidate producing scripts under replication/, each with its own token set."""
    out = []
    for sub in ("replication", "replication/exploration", "code", "scripts"):
        try:
            entries = list(os.scandir(proj / sub))
        except OSError:
            continue
        for e in entries:
            if not e.is_file() or not e.name.lower().endswith(SCRIPT_EXT):
                continue
            toks = {t for t in re.split(r"[^a-z0-9]+", e.name.lower().rsplit(".", 1)[0]) if t}
            out.append((sub + "/" + e.name, toks))
    return out


def _script_for(stem, prov, scripts):
    e = prov.get(stem)
    if isinstance(e, dict) and str(e.get("script") or "").strip():
        return str(e["script"]).strip()
    want = {t for t in re.split(r"[^a-z0-9]+", stem.lower()) if t and t not in STEM_NOISE and not t.isdigit()}
    if not want:
        return None
    for rel, toks in scripts:
        if want <= toks:
            return rel
    return None


def _norm_src(path):
    """A source path as a comparison key: `~` expanded, `.`/`..` folded away. Two
    snapshots of the same picture must collapse whichever form the importer wrote."""
    s = str(path or "").strip()
    return os.path.normpath(os.path.expanduser(s)) if s else ""


def _commented_ids(vault):
    """Store ids carrying at least one unresolved comment. Those stay listed even when a
    newer snapshot of the same file exists -- a comment is anchored to the id it was
    filed on, and collapsing it away would put the remark out of reach."""
    cmap, _ = _load_comment_map(vault)
    return {fid for fid, items in cmap.items()
            if any(isinstance(c, dict) and not c.get("resolved")
                   and (str(c.get("body") or "").strip() or str(c.get("reply") or "").strip())
                   for c in items)}


def _latest_per_source(rows, keep):
    """One card per source file, newest first. The store keeps every re-render as
    history and the gallery shows the last. A snapshot with no source path is its own card."""
    seen, out = set(), []
    for e in rows:
        key = e.pop("src", "")
        if not key or key not in seen:
            out.append(e)
            if key:
                seen.add(key)
        elif e["id"] in keep:
            out.append(e)
    return out


def _store_runs(vault, proj):
    """Store figures this project produced: spec.source.path or spec.code inside it."""
    root = store_root(vault)
    want = str(proj.resolve())
    out = []
    for f in (load_index(vault).get("figures") or []):
        fid = str(f.get("id") or "")
        if not ID_RE.match(fid):
            continue
        d = root / fid
        spec = _read_json(d / "spec.json", None)
        if not isinstance(spec, dict):
            continue
        src = str((spec.get("source") or {}).get("path") or "")
        code = str(spec.get("code") or "")
        if not (src.startswith(want + "/") or code.startswith(want + "/")):
            continue
        img = d / ((spec.get("image") or {}).get("png") or "figure.png")
        try:
            st = img.stat() if img.is_file() else (d / "spec.json").stat()
        except OSError:
            continue
        ver = int(spec.get("version") or 1)
        w, h = _img_dims(img, st.st_mtime, st.st_size) if img.is_file() else (0, 0)
        out.append({"name": str(f.get("title") or spec.get("title") or fid), "group": "runs",
                    "rel": fid, "mtime": int(st.st_mtime), "w": w, "h": h,
                    "script": code[len(want) + 1:] if code.startswith(want + "/") else None,
                    "id": fid, "ver": ver, "kind": "figure", "src": _norm_src(src),
                    "url": "/explore/render?id=" + fid + "&theme=day&v=" + str(ver)})
    out.sort(key=lambda e: (-e["mtime"], e["id"]))
    return _latest_per_source(out, _commented_ids(vault))


SUPP_GROUP = "supplementary"
_SUPP_NAME = re.compile(r"^figS\d")


def _is_supplementary(stem, rel):
    if _SUPP_NAME.match(stem):
        return True
    parts = rel.split("/")
    return len(parts) > 2 and parts[0] == "results" and parts[1] != INTERACTIVE_DIR


_FIG_NUM = re.compile(r"^fig\.?(S)?\.?(\d+)")


def _gallery_rank(e):
    if e["group"] not in ("results", SUPP_GROUP, INTERACTIVE_DIR):
        return (0, 0, -e["mtime"], e["name"])
    m = _FIG_NUM.match(e["name"])
    if not m:
        return (2, 0, -e["mtime"], e["name"])
    return (1 if m.group(1) else 0, int(m.group(2)), 0, e["name"])


def project_gallery(vault, slug):
    """{slug, name, root, stamp, count, figures:[...]} -- every figure this project has."""
    proj = project_root(vault, slug)
    if proj is None:
        return {"error": "unknown project", "slug": slug}
    res_rows = _walk_images(proj / "results", proj)
    exp_dir = proj / "replication" / "exploration" / "figures"
    if not exp_dir.is_dir():
        exp_dir = proj / "figures"
    exp_rows = _walk_images(exp_dir, proj)
    int_rows = _walk_interactive(proj / "results" / INTERACTIVE_DIR, proj)
    stamp = hashlib.sha1(repr((sorted(res_rows), sorted(exp_rows), sorted(int_rows),
                               _mt(store_root(vault) / INDEX_NAME),
                               _mt(store_root(vault) / COMMENTS_NAME))).encode("utf-8")).hexdigest()[:16]
    key = str(proj)
    with _GALLERY_LOCK:
        hit = _GALLERY.get(key)
    if hit and hit[0] == stamp:
        return hit[1]

    prov = _gallery_provenance(proj)
    scripts = _script_index(proj)
    figs = []

    by_rel = {rel: (mtime, size) for rel, mtime, size in res_rows}
    claimed = set()
    for stem, rel, mtime, _size in _one_per_stem(int_rows):
        d = rel.rsplit("/", 1)[0]
        thumb, w, h = None, 0, 0
        for ext in GALLERY_EXT:                      # png before svg: _one_per_stem's rule
            twin = d + "/" + stem + ext
            if twin in by_rel:
                claimed.add(twin)
                if thumb is None:
                    tm, tz = by_rel[twin]
                    w, h = _img_dims(proj / twin, tm, tz)
                    thumb = ("/w/figure/project/img?slug=" + quote(str(slug))
                             + "&rel=" + quote(twin) + "&v=" + _vstamp(proj / twin, tm))
        tail = rel[len("results/" + INTERACTIVE_DIR + "/"):]
        figs.append({"name": stem, "group": INTERACTIVE_DIR, "rel": rel, "kind": "interactive",
                     "thumb": thumb, "mtime": int(mtime), "w": w, "h": h,
                     "script": _script_for(stem, prov, scripts),
                     "url": "/w/figure/project/html/" + quote(str(slug), safe="")
                            + "/" + quote(tail) + "?v=" + _vstamp(proj / rel, mtime)})
    res_rows = [r for r in res_rows if r[0] not in claimed]

    jobs = []
    for base_group, rows in (("results", res_rows), ("exploration", exp_rows)):
        for stem, rel, mtime, size in _one_per_stem(rows):
            w, h = _img_dims(proj / rel, mtime, size)
            v = _vstamp(proj / rel, mtime)
            group = SUPP_GROUP if base_group == "results" and _is_supplementary(stem, rel) else base_group
            fig = {"name": stem, "group": group, "rel": rel, "mtime": int(mtime),
                   "w": w, "h": h, "script": _script_for(stem, prov, scripts), "kind": "figure",
                   "size": int(size),
                   "url": "/w/figure/project/img?slug=" + quote(str(slug))
                          + "&rel=" + quote(rel) + "&v=" + v}
            if _preview_wanted(rel, size, w, h):
                # the display copy; `url` stays the original, one click away in the viewer
                fig["preview"] = ("/w/figure/project/preview?slug=" + quote(str(slug))
                                  + "&rel=" + quote(rel) + "&v=" + v)
                try:
                    jobs.append((str((proj / rel).resolve()), v))
                except OSError:
                    pass
            figs.append(fig)
    _queue_previews(jobs)
    figs.extend(_store_runs(vault, proj))
    order = {"results": 0, SUPP_GROUP: 1, INTERACTIVE_DIR: 2, "exploration": 3, "runs": 4}
    figs.sort(key=lambda e: (order.get(e["group"], 9),) + _gallery_rank(e))
    figs = figs[:GALLERY_MAX]
    name = proj.name[len(PROJECT_PREFIX):] if proj.name.startswith(PROJECT_PREFIX) else proj.name
    out = {"ok": True, "slug": slug, "name": name, "root": str(proj), "stamp": stamp,
           "count": len(figs), "figures": figs}
    with _GALLERY_LOCK:
        if len(_GALLERY) > 24:
            _GALLERY.clear()
        _GALLERY[key] = (stamp, out)
    return out


def _project_image_path(vault, slug, rel):
    """(path, None) for a picture inside a project, else (None, {error}). The ONE place the
    confinement lives: the resolved file has to sit inside the project root and be a
    picture; '..', an absolute path and a link pointing out all resolve away and are refused."""
    proj = project_root(vault, slug)
    if proj is None:
        return None, {"error": "unknown project"}
    rel = (rel or "").replace("\\", "/").strip().lstrip("/")
    if not rel or ".." in rel.split("/"):
        return None, {"error": "bad path"}
    try:
        base = proj.resolve()
        p = (base / rel).resolve()
        p.relative_to(base)
    except (ValueError, OSError):
        return None, {"error": "bad path"}
    if not p.is_file() or p.suffix.lower() not in IMAGE_TYPES:
        return None, {"error": "not a figure"}
    return p, None


def project_image_stamp(vault, slug, rel):
    """the picture's `<mtime_ns hex>-<size hex>` stamp, "" when it cannot be had. serve.py
    sends `immutable` only when the URL's `v` equals this, so a stale or guessed `v` can
    never pin old bytes in a cache."""
    p, err = _project_image_path(vault, slug, rel)
    if err:
        return ""
    try:
        st = p.stat()
        return "%x-%x" % (st.st_mtime_ns, st.st_size)
    except OSError:
        return ""


PREVIEW_BOX = 1600
PREVIEW_MIN_BYTES = 160 * 1024
PREVIEW_DIR = settings.STATE_DIR / "figure-previews"
_PREVIEW_Q = []
_PREVIEW_QSET = set()
_PREVIEW_LOCK = threading.Lock()
_PREVIEW_WAKE = threading.Event()
_PREVIEW_THREAD = None


def _preview_wanted(rel, size, w, h):
    """a PNG big enough on the wire AND larger than the box -- anything else is served as is"""
    return (rel.lower().endswith(".png") and size >= PREVIEW_MIN_BYTES
            and max(int(w or 0), int(h or 0)) > PREVIEW_BOX)


def _preview_file(p, stamp):
    key = hashlib.sha1(("%s\0%s\0%d" % (p, stamp, PREVIEW_BOX)).encode("utf-8")).hexdigest()
    return PREVIEW_DIR / (key + ".webp")


def _build_preview(p, stamp):
    """write the display copy of `p` (a resolved, confined PNG) if it is not there yet;
    -> its path, or None when it cannot be made. Atomic: a reader never sees half a file."""
    out = _preview_file(p, stamp)
    if out.is_file():
        return out
    try:
        from PIL import Image
        PREVIEW_DIR.mkdir(parents=True, exist_ok=True)
        with Image.open(p) as im:
            im.load()
            img = im.convert("RGBA") if im.mode not in ("RGB", "RGBA") else im.copy()
        img.thumbnail((PREVIEW_BOX, PREVIEW_BOX), Image.LANCZOS)
        tmp = out.with_name(out.name + ".%d.tmp" % os.getpid())
        img.save(tmp, format="WEBP", lossless=True, method=4)
        os.replace(tmp, out)
        return out
    except Exception:
        return None


def _preview_worker():
    while True:
        _PREVIEW_WAKE.wait(30)
        while True:
            with _PREVIEW_LOCK:
                if not _PREVIEW_Q:
                    _PREVIEW_WAKE.clear()
                    break
                job = _PREVIEW_Q.pop(0)
                _PREVIEW_QSET.discard(job)
            _build_preview(Path(job[0]), job[1])


def _queue_previews(jobs):
    """hand (resolved path, stamp) pairs to the one background builder, deduplicated"""
    global _PREVIEW_THREAD
    fresh = [j for j in jobs if not _preview_file(Path(j[0]), j[1]).is_file()]
    if not fresh:
        return
    with _PREVIEW_LOCK:
        for j in fresh:
            if j not in _PREVIEW_QSET:
                _PREVIEW_QSET.add(j)
                _PREVIEW_Q.append(j)
        if _PREVIEW_THREAD is None or not _PREVIEW_THREAD.is_alive():
            _PREVIEW_THREAD = threading.Thread(target=_preview_worker, name="figure-previews",
                                               daemon=True)
            _PREVIEW_THREAD.start()
    _PREVIEW_WAKE.set()


def project_preview(vault, slug, rel):
    """(bytes, content type, None) for a project PNG's display copy -- built on demand if
    the background pass has not reached it yet -- or (None, None, {error}). Confined by
    _project_image_path, exactly like the original."""
    p, err = _project_image_path(vault, slug, rel)
    if err:
        return None, None, err
    if p.suffix.lower() != ".png":
        return None, None, {"error": "not a png"}
    try:
        st = p.stat()
    except OSError as exc:
        return None, None, {"error": str(exc)}
    out = _build_preview(p, "%x-%x" % (st.st_mtime_ns, st.st_size))
    if out is None:
        return None, None, {"error": "no preview"}
    try:
        return out.read_bytes(), "image/webp", None
    except OSError as exc:
        return None, None, {"error": str(exc)}


def project_image(vault, slug, rel):
    """One picture out of a project, by its project-relative path (confined by
    _project_image_path)."""
    p, err = _project_image_path(vault, slug, rel)
    if err:
        return None, None, err
    try:
        data = p.read_bytes()
    except OSError as exc:
        return None, None, {"error": str(exc)}
    return data, IMAGE_TYPES.get(p.suffix.lower(), "application/octet-stream"), None


def _project_interactive_path(vault, slug, rel, kind="html"):
    """(path, None) for an interactive figure page or its plotly bundle inside a project,
    else (None, {error})."""
    proj = project_root(vault, slug)
    if proj is None:
        return None, {"error": "unknown project"}
    rel = (rel or "").replace("\\", "/").strip().lstrip("/")
    if not rel or ".." in rel.split("/"):
        return None, {"error": "bad path"}
    try:
        base = proj.resolve()
        p = (base / rel).resolve()
        parts = p.relative_to(base).parts
    except (ValueError, OSError):
        return None, {"error": "bad path"}
    if any(seg.startswith(".") for seg in parts):
        return None, {"error": "bad path"}
    if len(parts) < 3 or parts[0] != "results" or INTERACTIVE_DIR not in parts[1:-1]:
        return None, {"error": "not an interactive figure"}
    try:
        if not p.is_file():
            return None, {"error": "not an interactive figure"}
        size = p.stat().st_size
    except OSError:
        return None, {"error": "not an interactive figure"}
    if kind == "asset":
        if p.suffix.lower() != INTERACTIVE_ASSET_EXT or not INTERACTIVE_ASSET_RE.match(p.name):
            return None, {"error": "not an interactive asset"}
        if size > INTERACTIVE_ASSET_MAX:
            return None, {"error": "asset too large"}
    else:
        if p.suffix.lower() != INTERACTIVE_EXT:
            return None, {"error": "not an interactive figure"}
        if size > INTERACTIVE_MAX:
            return None, {"error": "figure too large"}
    return p, None


def project_interactive_stamp(vault, slug, rel, kind="html"):
    """the file's `<mtime_ns hex>-<size hex>` stamp, "" when it cannot be had -- the same
    rule the image route uses, so only a `v` that EQUALS it is ever cached hard."""
    p, err = _project_interactive_path(vault, slug, rel, kind)
    if err:
        return ""
    try:
        st = p.stat()
        return "%x-%x" % (st.st_mtime_ns, st.st_size)
    except OSError:
        return ""


def project_interactive(vault, slug, rel, kind="html"):
    """(bytes, content_type, None) or (None, None, {error}). Nothing of the file is
    modified: the page is served at a PATH-shaped URL so its own relative
    `<script src="plotly.min.js">` lands on the asset route by itself."""
    p, err = _project_interactive_path(vault, slug, rel, kind)
    if err:
        return None, None, err
    try:
        data = p.read_bytes()
    except OSError:
        return None, None, {"error": "unreadable"}
    return data, ("text/javascript" if kind == "asset" else "text/html; charset=utf-8"), None


def interactive_rel(tail):
    """the project-relative path a path-shaped URL tail names, or "" when it is not one.
    `<stem>.html` -> `results/interactive/<stem>.html`. A tail that is empty, absolute or
    carries a dot-segment never becomes a rel; the helper above refuses the rest."""
    tail = (tail or "").replace("\\", "/").strip().lstrip("/")
    if not tail or any(seg in ("", ".", "..") or seg.startswith(".") for seg in tail.split("/")):
        return ""
    return "results/" + INTERACTIVE_DIR + "/" + tail
