#!/usr/bin/env python3
import csv
import hashlib
import json
import os
import re
import sqlite3
import subprocess
import sys
import threading
import time
from collections import deque
from pathlib import Path
from urllib.parse import quote

import coding       # the Coding view's sets: a kind=coding event is checked against one
import drafting     # _confine / _table_pdf_stale: the same path discipline as the rest
import fignotes
import explore      # ID_RE and project_root -- the resolver the figure gallery uses
import settings

THREAD_NAME = "panel-profile"

# A session is whatever the client calls itself (a lane name, a pid). Never a path,
# never a shell word: this set cannot leave a JSON string.
SESSION_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,80}$")
STEM_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$")
# What a path dataset may be: an extension the profiler cannot read is a refusal here,
# not a job queued to fail there.
DATA_EXT = {".dta", ".sav", ".por", ".csv", ".tsv", ".parquet", ".feather", ".xlsx"}
PATH_MAX = 400
CTRL_RE = re.compile(r"[\x00-\x1f\x7f]")

RING_MAX = 64
PROFILE_KEEP = 80          # newest profiles kept on disk; the rest are pruned
TABLE_ROW_CAP = 500        # body rows per table response
PROFILE_TIMEOUT = 600
SUBPROC_TAIL = 400         # bytes of a failed profiler's output kept in the record

_HOME = str(Path.home())


# ------------------------------------------------------------------ state dir
_STATE = {"key": None, "root": None}


def state_dir():
    key = (os.environ.get("AIOA_PANEL_DIR") or "", str(settings.STATE_DIR))
    if _STATE["key"] == key and _STATE["root"] is not None:
        return _STATE["root"]
    override = os.environ.get("AIOA_PANEL_DIR")
    if override:
        root = Path(override).expanduser()
    else:
        root = settings.STATE_DIR / "panel"
    for p in (root, root / "profiles", root / "frames", root / "tables"):
        try:
            p.mkdir(parents=True, exist_ok=True)
            os.chmod(p, 0o700)
        except OSError:
            pass
    _STATE.update(key=key, root=root)
    return root


def _scrub(msg):
    return str(msg).replace(_HOME, "~")[:200]


def _home_rel(p):
    s = str(p)
    return "~" + s[len(_HOME):] if s.startswith(_HOME) else s


def _mt(p):
    try:
        return p.stat().st_mtime
    except OSError:
        return 0.0


def _read_json(p, default=None):
    try:
        with open(p, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return default


def host_ok(host, port=None, origins=()):
    """True when the Host header names one of the Board's own loopback origins."""
    h = (host or "").strip().lower()
    if not h or h.startswith("["):        # [::1] is not a Board origin; serve.py binds v4
        return False
    name, _, p = h.partition(":")
    if name not in ("127.0.0.1", "localhost"):
        return False
    if not p:
        return True                       # port 80: no listener, but no rebinding either
    allowed = set()
    for o in origins or ():
        tail = o.split("//", 1)[-1]
        if ":" in tail:
            allowed.add(tail.rsplit(":", 1)[-1])
    if port:
        allowed.add(str(port))            # a throwaway on a spare port is still loopback
    return p in allowed


def refuse(host, origin, port, cors_origins):
    """None when the request may proceed, else (code, body). Host always; Origin when
    one is present, because the only clients that need these routes (a local script,
    the app's own pane) either send the app's origin or send none at all."""
    if not host_ok(host, port, cors_origins):
        return 403, {"ok": False, "error": "bad Host header"}
    o = (origin or "").strip()
    if o and o not in (cors_origins or ()):
        return 403, {"ok": False, "error": "cross-origin request refused"}
    return None


# ------------------------------------------------------------------- the ring
_RING = deque(maxlen=RING_MAX)
_RING_LOCK = threading.Lock()
_SEQ = [0]


def _append(ev):
    with _RING_LOCK:
        _SEQ[0] += 1
        ev["seq"] = _SEQ[0]
        ev["ts"] = round(time.time(), 3)
        _RING.append(ev)
        return ev["seq"]


def _snapshot():
    with _RING_LOCK:
        return list(_RING), _SEQ[0]


def _in_scope(ev, session):
    """Which events a pane may see, and the asymmetry matters."""
    if not session:
        return True
    s = ev.get("session")
    if ev.get("kind") in ("dataset", "pdf"):
        return s == session
    return s is None or s == session


def reset():
    with _RING_LOCK:
        _RING.clear()
        _SEQ[0] = 0


# ------------------------------------------------------------ the data catalog
_CATALOG = {"key": None, "data": None}


def hub_dir(vault):
    return Path(vault) / "Projects" / "data"


def _catalog(vault):
    p = hub_dir(vault) / "catalog.json"
    try:
        key = (str(p), p.stat().st_mtime_ns)
    except OSError:
        return None
    if _CATALOG["key"] == key:
        return _CATALOG["data"]
    d = _read_json(p)
    if not isinstance(d, dict) or not isinstance(d.get("families"), dict):
        return None
    _CATALOG.update(key=key, data=d)
    return d


def _rebase(vault, recorded, recorded_hub):
    """The catalog records hub-relative paths (absolute ones in older builds). Root them on
    THIS machine's hub and confine the result: a catalog entry is data, and data that can
    name /etc/shadow is a path join that leaves the vault."""
    hub = hub_dir(vault)
    p = Path(recorded)
    if not p.is_absolute():
        p = hub / p
    if recorded_hub:
        try:
            p = hub / p.relative_to(recorded_hub)
        except ValueError:
            pass
    try:
        p = p.resolve()
        p.relative_to(hub.resolve())
    except (OSError, ValueError):
        return None
    return p


def _catalog_entry(vault, family, key):
    """-> ({path, relpath, format, bytes, mtime}, None) or (None, 'short reason')."""
    cat = _catalog(vault)
    if cat is None:
        return None, "no catalog.json"
    fam = cat["families"].get(family)
    if not isinstance(fam, dict):
        return None, "unknown family"
    ds = fam.get("datasets")
    if not isinstance(ds, dict) or key not in ds or not isinstance(ds[key], dict):
        return None, "unknown dataset"
    e = ds[key]
    p = _rebase(vault, e.get("path") or "", cat.get("hub") or "")
    if p is None:
        return None, "dataset path is outside the hub"
    famdir = hub_dir(vault) / family
    try:
        rel = str(p.relative_to(famdir)).replace(os.sep, "/")
    except ValueError:
        rel = p.name
    return {"path": p, "relpath": rel, "format": e.get("format"),
            "bytes": e.get("bytes"), "mtime": e.get("mtime")}, None


_ROOTS = {"key": None, "roots": None}


def data_roots(vault):
    """Every directory a path dataset may live under, resolved, widest first."""
    cat = _catalog(vault)                       # refreshes _CATALOG["key"] first
    key = (str(vault), _CATALOG["key"])
    if _ROOTS["key"] == key and _ROOTS["roots"] is not None:
        return _ROOTS["roots"]
    roots, seen = [], set()

    def add(raw):
        try:
            r = Path(raw).expanduser().resolve()
        except (OSError, ValueError, RuntimeError):
            return
        if len(r.parts) < 3 or r == Path.home().resolve() or not r.is_dir():
            return
        if str(r) not in seen:
            seen.add(str(r))
            roots.append(r)

    add(vault)                                  # first, so an in-vault file is judged
    add(hub_dir(vault))                         # by its vault-relative parts
    for fam in ((cat or {}).get("families") or {}).values():
        if isinstance(fam, dict) and isinstance(fam.get("path"), str):
            add(fam["path"])
    _ROOTS.update(key=key, roots=roots)
    return roots


def resolve_data_path(vault, raw):
    """(Path, None) for a file the pane may profile, else (None, 'short reason')."""
    s = (raw or "").strip()
    if not s:
        return None, "path is required"
    if len(s) > PATH_MAX or CTRL_RE.search(s):
        return None, "bad path"
    if not (s == "~" or s.startswith("~/") or s.startswith("/")):
        return None, "path must be absolute or start with ~/"
    if ".." in Path(s).parts:
        return None, "path must not contain '..'"
    try:
        p = Path(s).expanduser()
        if ".." in p.parts:                     # ~user expansion cannot reintroduce one
            return None, "path must not contain '..'"
        p = p.resolve()                         # follows every link in the chain
    except (OSError, ValueError, RuntimeError):
        return None, "path cannot be resolved"
    rel = None
    for root in data_roots(vault):
        try:
            rel = p.relative_to(root)
            break
        except ValueError:
            continue
    if rel is None:
        return None, "path is outside the data roots"
    if any(part.startswith(".") for part in rel.parts):
        return None, "path is inside a hidden directory"
    try:
        if p.is_dir():
            return None, "path is a directory"
        if not p.is_file():
            return None, "not a regular file"
        size = p.stat().st_size
    except OSError:
        return None, "no such file"
    if p.suffix.lower() not in DATA_EXT:
        return None, ("the panel cannot read %s files" % p.suffix.lstrip(".")
                      if p.suffix else "the panel cannot read a file with no extension")
    if size <= 0:
        return None, "file is empty"
    return p, None


_CAT_PATHS = {"key": None, "map": None}


def catalog_key_for(vault, path):
    """(family, key) when this file IS a registry dataset, else None."""
    cat = _catalog(vault)
    if cat is None:
        return None
    if _CAT_PATHS["key"] != _CATALOG["key"]:
        m, hub = {}, cat.get("hub") or ""
        for fam, f in cat["families"].items():
            ds = f.get("datasets") if isinstance(f, dict) else None
            if not isinstance(ds, dict):
                continue
            for k, e in ds.items():
                if not isinstance(e, dict):
                    continue
                q = _rebase(vault, e.get("path") or "", hub)
                if q is not None:
                    m.setdefault(str(q), (fam, k))
        _CAT_PATHS.update(key=_CATALOG["key"], map=m)
    return (_CAT_PATHS["map"] or {}).get(str(path))


# ----------------------------------------------------------- the instant layer
def _registry_rows(vault, family, relpath):
    """(file_row, [variable rows]) out of datasets.db. Read-only URI, per request,
    closed in a finally: a viewer must never be able to write the registry, and a
    connection held open across requests is a lock waiting to happen."""
    p = hub_dir(vault) / "datasets.db"
    if not p.is_file():
        return None, None
    con = None
    try:
        con = sqlite3.connect(p.as_uri() + "?mode=ro", uri=True, timeout=2.0)
        con.row_factory = sqlite3.Row
        f = con.execute(
            "select format, bytes, n_rows, n_cols from files "
            "where family = ? and relpath = ?", (family, relpath)).fetchone()
        rows = con.execute(
            "select name, label, dtype, ordinal from variables "
            "where family = ? and relpath = ? order by ordinal", (family, relpath)).fetchall()
        return (dict(f) if f else None), [dict(r) for r in rows]
    except sqlite3.Error:
        return None, None
    finally:
        if con is not None:
            try:
                con.close()
            except sqlite3.Error:
                pass


# ------------------------------------------------------------- profile records
def cache_id(path):
    """sha256(resolved path + mtime_ns + size)[:24]. The identity of a dataset AS IT IS
    NOW: edit the file and the id moves, so a stale profile can never be served -- there
    is no separate staleness check to get wrong."""
    try:
        st = os.stat(path)
    except OSError:
        return None
    h = hashlib.sha256()
    h.update(str(Path(path).resolve()).encode("utf-8"))
    h.update(b"\x00%d\x00%d" % (st.st_mtime_ns, st.st_size))
    return h.hexdigest()[:24]


def profile_path(cid):
    return state_dir() / "profiles" / (cid + ".json")


def profiler_enabled():
    """The profiler is a script kept in the vault, so it runs only when the
    run_vault_scripts setting is on."""
    return bool(settings.RUN_VAULT_SCRIPTS)


def profiler_path(vault):
    over = os.environ.get("AIOA_PANEL_PROFILER")
    return Path(over).expanduser() if over else (
        hub_dir(vault) / "hub" / "panel_profile.py"
        if (hub_dir(vault) / "hub").is_dir() else hub_dir(vault) / "panel_profile.py")


def _profiler_python():
    return sys.executable


_JOBS = {}
_ORDER = deque()
_CV = threading.Condition()
_STARTED = [False]
_RUNS = {"done": 0, "failed": 0}


def _enqueue(job):
    with _CV:
        if job["cacheid"] not in _JOBS:
            _ORDER.append(job["cacheid"])
        _JOBS[job["cacheid"]] = job
        _CV.notify()


def _run_profile(job):
    out = profile_path(job["cacheid"])
    if out.exists():
        return                              # another request already paid for this one
    script = job["script"]
    tmp = out.parent / (job["cacheid"] + ".part")
    argv = [_profiler_python(), str(script)]
    if job.get("family"):
        argv += ["--family", job["family"], "--key", job["key"]]
    else:
        argv += ["--path", str(job["path"])]
    argv += ["--out", str(tmp)]
    rec = None
    if not profiler_enabled() or not Path(script).is_file():
        return
    else:
        try:
            # argv list, never a shell; no stdin; the whole thing bounded.
            r = subprocess.run(argv, stdin=subprocess.DEVNULL, capture_output=True,
                               timeout=PROFILE_TIMEOUT)
        except subprocess.TimeoutExpired:
            rec = {"v": 1, "failed": True, "error": "profiler timed out after %ds"
                   % PROFILE_TIMEOUT}
        except OSError as e:
            rec = {"v": 1, "failed": True, "error": _scrub(e)}
        else:
            if r.returncode == 0 and tmp.exists():
                try:
                    os.replace(tmp, out)
                except OSError as e:
                    rec = {"v": 1, "failed": True, "error": _scrub(e)}
            else:
                tail = (r.stderr or r.stdout or b"")[-SUBPROC_TAIL:]
                rec = {"v": 1, "failed": True,
                       "error": "profiler exit %d" % r.returncode,
                       "output": _scrub(tail.decode("utf-8", "replace").strip())}
    if rec is not None:
        rec["source"] = {"family": job.get("family"), "key": job.get("key"),
                         "path": _home_rel(job["path"])}
        rec["built"] = time.strftime("%Y-%m-%dT%H:%M:%S")
        _write_json(out, rec)
        _RUNS["failed"] += 1
    else:
        _RUNS["done"] += 1
    try:
        if tmp.exists():
            os.remove(str(tmp))
    except OSError:
        pass
    _prune_profiles()


def _write_json(p, obj):
    tmp = p.parent / (p.name + ".tmp")
    try:
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(obj, fh)
        os.replace(tmp, p)
    except OSError:
        try:
            if tmp.exists():
                os.remove(str(tmp))
        except OSError:
            pass


def _prune_profiles():
    """Keep the newest PROFILE_KEEP. A profile is a cache of a file that still exists;
    losing one costs a rebuild, and an unbounded directory costs a disk."""
    d = state_dir() / "profiles"
    try:
        files = [e for e in os.scandir(d) if e.is_file() and e.name.endswith(".json")]
    except OSError:
        return
    if len(files) <= PROFILE_KEEP:
        return
    files.sort(key=lambda e: e.stat().st_mtime, reverse=True)
    for e in files[PROFILE_KEEP:]:
        try:
            os.remove(e.path)
        except OSError:
            pass


def _worker():
    while True:
        with _CV:
            while not _ORDER:
                _CV.wait()
            cid = _ORDER.popleft()
            job = _JOBS.pop(cid, None)
        if not job:
            continue
        try:
            _run_profile(job)
        except Exception:
            _RUNS["failed"] += 1


def start():
    if _STARTED[0]:
        return
    _STARTED[0] = True
    threading.Thread(target=_worker, name=THREAD_NAME, daemon=True).start()


def _request_profile(vault, path, family=None, key=None):
    """Enqueue a build for this exact (path, mtime, size) unless one is already on disk.
    Returns the cacheid, or None when the file has gone."""
    cid = cache_id(path)
    if cid is None:
        return None
    script = profiler_path(vault)
    if profiler_enabled() and not profile_path(cid).exists() and script.is_file():
        start()
        _enqueue({"cacheid": cid, "path": Path(path), "family": family, "key": key,
                  "script": script})
    return cid


# --------------------------------------------------------------- event posting
_DATASET_SHAPES = {
    "catalog": {"kind", "session", "project", "family", "key"},
    "frame": {"kind", "session", "project", "frame", "title"},
    "path": {"kind", "session", "project", "path", "title"},
}
_TABLE_SHAPES = {
    "name": {"kind", "session", "project", "name"},
    "id": {"kind", "session", "project", "id", "title"},
}


def _opt_str(data, field, rx=None, maxlen=200):
    """(value, error). Absent and null are the same thing: None."""
    if field not in data or data[field] is None:
        return None, None
    v = data[field]
    if not isinstance(v, str):
        return None, "%s must be a string" % field
    v = v.strip()
    if not v:
        return None, None
    if len(v) > maxlen:
        return None, "%s is too long" % field
    if rx is not None and not rx.match(v):
        return None, "bad %s" % field
    return v, None


def _clean_title(data):
    t, err = _opt_str(data, "title", None, 200)
    if err:
        return None, err
    if t:
        t = re.sub(r"[\x00-\x1f\x7f]", " ", t).strip()
    return (t or None), None


def _frame_file(fid):
    """frames/<id>.* -- the emitter picks the format (csv, parquet, feather). Only an
    id that matches ID_RE is looked up, so the scan cannot leave the state dir."""
    if not explore.ID_RE.match(fid or ""):
        return None
    d = state_dir() / "frames"
    try:
        hits = sorted(e.path for e in os.scandir(d)
                      if e.is_file() and e.name.startswith(fid + "."))
    except OSError:
        return None
    return Path(hits[0]) if hits else None


def _pushed_file(tid):
    if not explore.ID_RE.match(tid or ""):
        return None
    p = state_dir() / "tables" / (tid + ".json")
    return p if p.is_file() else None


def _project_table_csv(proj, name):
    """results/<name>.csv, then results/supplementary/<name>.csv, confined to the
    project. `name` already matched STEM_RE, so there is no directory part to escape
    with; _confine is the belt to that suspenders."""
    for sub in ("results", "results/supplementary"):
        p = drafting._confine(proj, "%s/%s.csv" % (sub, name))
        if p is not None and p.is_file():
            return p, ("supplementary" if sub.endswith("supplementary") else "results")
    return None, None


_CODING_FIELDS = {"kind", "session", "project", "set", "unit"}


def _post_coding(vault, data):
    extra = sorted(set(data) - _CODING_FIELDS)
    if extra:
        return 400, {"ok": False, "error": "unexpected field: %s" % extra[0]}
    vals = {}
    for field, rx, cap in (("session", SESSION_RE, 80), ("project", None, 120),
                           ("set", coding.SET_RE, 64), ("unit", None, 200)):
        vals[field], err = _opt_str(data, field, rx, cap)
        if err:
            return 400, {"ok": False, "error": err}
    if not vals["project"] or not vals["set"]:
        return 400, {"ok": False, "error": "a coding event needs project and set"}
    why = coding.event_check(vault, vals["project"], vals["set"], vals["unit"])
    if why:
        return 400, {"ok": False, "error": why}
    return 200, {"ok": True, "seq": _append(dict(vals, kind="coding"))}


_FIGURE_SHAPES = {
    "id": {"kind", "session", "project", "id", "title"},
    "rel": {"kind", "session", "project", "rel", "title"},
}


def _post_figure(vault, data):
    shape = "id" if "id" in data else ("rel" if "rel" in data else None)
    allowed = _FIGURE_SHAPES.get(shape)
    if allowed is None:
        return 400, {"ok": False, "error": "a figure event needs id or rel"}
    extra = sorted(set(data) - allowed)
    if extra:
        return 400, {"ok": False, "error": "unexpected field: %s" % extra[0]}
    session, err = _opt_str(data, "session", SESSION_RE, 80)
    if err:
        return 400, {"ok": False, "error": err}
    project, err = _opt_str(data, "project", None, 120)
    if err:
        return 400, {"ok": False, "error": err}
    title, err = _clean_title(data)
    if err:
        return 400, {"ok": False, "error": err}
    ev = {"kind": "figure", "session": session, "project": project, "title": title}
    if shape == "id":
        fid, err = _opt_str(data, "id", explore.ID_RE, 60)
        if err or not fid:
            return 400, {"ok": False, "error": err or "id is required"}
        d = explore.fig_dir(vault, fid)
        if d is None or not ((d / "figure.png").is_file() or (d / "figure.svg").is_file()):
            return 400, {"ok": False, "error": "unknown figure id"}
        ev.update(id=fid, rel=None, name=fid)
    else:
        rel, err = _opt_str(data, "rel", None, PATH_MAX)
        if err or not rel:
            return 400, {"ok": False, "error": err or "rel is required"}
        if not project:
            return 400, {"ok": False, "error": "a project figure needs its project"}
        p, why = explore._project_image_path(vault, project, rel)
        if p is None:
            return 400, {"ok": False, "error": (why or {}).get("error") or "not a figure"}
        rel = rel.replace("\\", "/").strip().lstrip("/")
        try:
            st = p.stat()
            v = "%x-%x" % (st.st_mtime_ns, st.st_size)
        except OSError:
            v = None
        ev.update(id=None, rel=rel, name=p.stem, v=v)
    return 200, {"ok": True, "seq": _append(ev)}


_PDF_SHAPES = {
    "hub": {"kind", "session", "project", "hub_rel", "page", "title"},
    "rel": {"kind", "session", "project", "rel", "page", "title"},
}


def _post_pdf(vault, data):
    shape = "hub" if "hub_rel" in data else ("rel" if "rel" in data else None)
    allowed = _PDF_SHAPES.get(shape)
    if allowed is None:
        return 400, {"ok": False, "error": "a pdf event needs hub_rel or project+rel"}
    extra = sorted(set(data) - allowed)
    if extra:
        return 400, {"ok": False, "error": "unexpected field: %s" % extra[0]}
    session, err = _opt_str(data, "session", SESSION_RE, 80)
    if err:
        return 400, {"ok": False, "error": err}
    project, err = _opt_str(data, "project", None, 120)
    if err:
        return 400, {"ok": False, "error": err}
    title, err = _clean_title(data)
    if err:
        return 400, {"ok": False, "error": err}
    page = data.get("page")
    if page is not None:
        if isinstance(page, bool) or not isinstance(page, int) or not 1 <= page <= 100000:
            return 400, {"ok": False, "error": "page must be a whole number from 1"}
    ev = {"kind": "pdf", "session": session, "project": project, "title": title,
          "page": page}
    if shape == "hub":
        raw, err = _opt_str(data, "hub_rel", None, PATH_MAX)
        if err or not raw:
            return 400, {"ok": False, "error": err or "hub_rel is required"}
        p, why = pdf_path(vault, hub_rel=raw)
        if p is None:
            return why[0], {"ok": False, "error": why[1]}
        ev.update(hub_rel=_hub_rel_of(vault, p), rel=None)
    else:
        raw, err = _opt_str(data, "rel", None, PATH_MAX)
        if err or not raw:
            return 400, {"ok": False, "error": err or "rel is required"}
        if not project:
            return 400, {"ok": False, "error": "a project pdf needs its project"}
        p, why = pdf_path(vault, project=project, rel=raw)
        if p is None:
            return why[0], {"ok": False, "error": why[1]}
        ev.update(hub_rel=None, rel=raw.replace("\\", "/").strip())
    ev.update(name=p.stem, v=_pdf_stamp(p))
    return 200, {"ok": True, "seq": _append(ev)}


def post_event(vault, data):
    if not isinstance(data, dict):
        return 400, {"ok": False, "error": "body must be an object"}
    kind = data.get("kind")
    if kind == "coding":
        return _post_coding(vault, data)
    if kind == "figure":
        return _post_figure(vault, data)
    if kind == "pdf":
        return _post_pdf(vault, data)
    if kind == "dataset":
        shape = "catalog" if ("family" in data or "key" in data) else (
            "frame" if "frame" in data else ("path" if "path" in data else None))
        allowed = _DATASET_SHAPES.get(shape)
    elif kind == "table":
        shape = "name" if "name" in data else ("id" if "id" in data else None)
        allowed = _TABLE_SHAPES.get(shape)
    else:
        return 400, {"ok": False,
                     "error": "kind must be 'dataset', 'table', 'figure', 'coding' or 'pdf'"}
    if allowed is None:
        return 400, {"ok": False, "error": "a %s event needs %s" % (
            kind, "family+key, frame or path" if kind == "dataset" else "name or id")}
    extra = sorted(set(data) - allowed)
    if extra:
        return 400, {"ok": False, "error": "unexpected field: %s" % extra[0]}

    session, err = _opt_str(data, "session", SESSION_RE, 80)
    if err:
        return 400, {"ok": False, "error": err}
    project, err = _opt_str(data, "project", None, 120)
    if err:
        return 400, {"ok": False, "error": err}
    proj = None
    if project:
        proj = explore.project_root(vault, project)
        if proj is None:
            return 400, {"ok": False, "error": "unknown project"}

    ev = {"kind": kind, "session": session, "project": project}

    if kind == "dataset" and shape == "catalog":
        family, err = _opt_str(data, "family", None, 80)
        key, err2 = _opt_str(data, "key", None, 160)
        if err or err2:
            return 400, {"ok": False, "error": err or err2}
        if not family or not key:
            return 400, {"ok": False, "error": "family and key are both required"}
        entry, why = _catalog_entry(vault, family, key)
        if entry is None:
            return 400, {"ok": False, "error": why}
        ev.update(family=family, key=key, frame=None, path=None, title=None)
        _request_profile(vault, entry["path"], family, key)

    elif kind == "dataset" and shape == "frame":
        fid, err = _opt_str(data, "frame", explore.ID_RE, 60)
        if err or not fid:
            return 400, {"ok": False, "error": err or "frame is required"}
        f = _frame_file(fid)
        if f is None:
            return 400, {"ok": False, "error": "unknown frame"}
        title, err = _clean_title(data)
        if err:
            return 400, {"ok": False, "error": err}
        ev.update(family=None, key=None, frame=fid, path=None, title=title)
        _request_profile(vault, f)

    elif kind == "dataset":
        raw, err = _opt_str(data, "path", None, PATH_MAX)
        if err or not raw:
            return 400, {"ok": False, "error": err or "path is required"}
        p, why = resolve_data_path(vault, raw)
        if p is None:
            return 400, {"ok": False, "error": why}
        title, err = _clean_title(data)
        if err:
            return 400, {"ok": False, "error": err}
        hit = catalog_key_for(vault, p)
        fam, k = hit if hit else (None, None)
        ev.update(family=fam, key=k, frame=None, path=_home_rel(p), title=title)
        _request_profile(vault, p, fam, k)

    elif shape == "name":
        name, err = _opt_str(data, "name", STEM_RE, 90)
        if err or not name:
            return 400, {"ok": False, "error": err or "name is required"}
        if proj is None:
            return 400, {"ok": False, "error": "a named table needs its project"}
        csv_path, group = _project_table_csv(proj, name)
        if csv_path is None:
            return 400, {"ok": False, "error": "no such table in this project"}
        ev.update(name=name, id=None, title=None, group=group)

    else:
        tid, err = _opt_str(data, "id", explore.ID_RE, 60)
        if err or not tid:
            return 400, {"ok": False, "error": err or "id is required"}
        if _pushed_file(tid) is None:
            return 400, {"ok": False, "error": "unknown table id"}
        title, err = _clean_title(data)
        if err:
            return 400, {"ok": False, "error": err}
        ev.update(name=None, id=tid, title=title, group="pushed")

    return 200, {"ok": True, "seq": _append(ev)}


PANE_FRESH_S = 70.0   # a pane on a hidden workspace can be throttled to one poll a minute
_PANES = {}
_PANES_LOCK = threading.Lock()


def _saw_pane(session):
    now = time.time()
    with _PANES_LOCK:
        _PANES[session] = now
        if len(_PANES) > 256:
            for k in sorted(_PANES, key=_PANES.get)[:len(_PANES) - 256]:
                _PANES.pop(k, None)


def pane_state(session):
    with _PANES_LOCK:
        t = _PANES.get(session)
    age = None if t is None else round(time.time() - t, 3)
    return {"ok": True, "session": session, "up": age is not None and age <= PANE_FRESH_S,
            "age": age}


def events(session=None, since=None):
    """{seq, events}. With `since` it is a tail read; without one it is 'what should this
    pane show right now', which is the newest event of each kind -- a pane opened after a
    dataset was loaded still finds it."""
    ring, latest = _snapshot()
    scoped = [e for e in ring if _in_scope(e, session)]
    if since is None:
        newest = {}
        for e in scoped:
            newest[e["kind"]] = e
        out = sorted(newest.values(), key=lambda e: e["seq"])
    else:
        out = [e for e in scoped if e["seq"] > since]
    return {"ok": True, "seq": latest, "events": out}


# ------------------------------------------------------------ the dataset view
_DS_CACHE = {}
_DS_ORDER = deque()
_DS_MAX = 16

# What a profile may contribute to a variable. Anything else the profiler emits is
# dropped here rather than forwarded blind: the pane renders these and nothing else.
_STAT_KEYS = ("n", "miss", "miss_pct", "uniq", "min", "median", "max", "mean", "sd",
              "top", "hist", "value_labels", "dtype", "storage", "label")
_TOP_CAP = 12
_LABELS_CAP = 40
_TRIM_BYTES = 1200 * 1024      # past this the heavy per-variable extras come off
_TRIM_HARD = 1800 * 1024       # past THIS the level breakdown goes too


def _merge_variable(base, stat):
    out = dict(base)
    for k in _STAT_KEYS:
        v = stat.get(k)
        if v is None:
            continue
        if k == "top" and isinstance(v, list):
            v = v[:_TOP_CAP]
        elif k == "value_labels" and isinstance(v, list):
            v = v[:_LABELS_CAP]
        out[k] = v
    return out


def _trim(variables):
    size = len(json.dumps(variables, default=str))
    if size <= _TRIM_BYTES:
        return variables, []
    dropped = ["hist", "value_labels"]
    out = []
    for v in variables:
        v = dict(v)
        v.pop("hist", None)
        v.pop("value_labels", None)
        if isinstance(v.get("top"), list):
            v["top"] = v["top"][:3]
        out.append(v)
    if len(json.dumps(out, default=str)) > _TRIM_HARD:
        dropped.append("top")
        for v in out:
            v.pop("top", None)
    return out, dropped


_PROF = {}
_PROF_ORDER = deque()
_PROF_MAX = 2


def _profile_load(cid, prof_mt):
    """(meta, {name: variable}) for a profile on disk, or (None, {}) when there is
    none. `meta` is everything but the variables, so `source`/`sampled` stay reachable."""
    if not prof_mt:
        return None, {}
    key = (cid, prof_mt)
    hit = _PROF.get(key)
    if hit is not None:
        return hit
    d = _read_json(profile_path(cid))
    if not isinstance(d, dict):
        val = ({"failed": True, "error": "unreadable profile"}, {})
    elif d.get("failed"):
        val = (d, {})
    elif d.get("v") == 1 and isinstance(d.get("variables"), list):
        idx = {}
        for v in d["variables"]:
            if isinstance(v, dict) and v.get("name"):
                idx.setdefault(str(v["name"]), v)
        val = ({k: v for k, v in d.items() if k != "variables"}, idx)
    else:
        val = ({"failed": True, "error": "unreadable profile"}, {})
    _PROF[key] = val
    _PROF_ORDER.append(key)
    while len(_PROF_ORDER) > _PROF_MAX:
        _PROF.pop(_PROF_ORDER.popleft(), None)
    return val


def _profile_state(vault, cid, prof_mt, path, family=None, key=None):
    """(meta, {name: variable}, state). Shared by the list view and the drill-down so
    both agree about what `ready` means and neither parses the file twice."""
    meta, stats = _profile_load(cid, prof_mt)
    if meta is None:
        state = "building" if profiler_enabled() and profiler_path(vault).is_file() else "none"
        _request_profile(vault, path, family, key)
        return {}, {}, state
    if meta.get("failed"):
        return meta, {}, "failed"
    return meta, stats, "ready"


def dataset(vault, family=None, key=None, frame=None, path=None):
    """One dataset: the instant layer always, the stats layer when it exists."""
    if frame:
        if not explore.ID_RE.match(frame):
            return {"ok": False, "error": "bad frame id"}
        src_path = _frame_file(frame)
        if src_path is None:
            return {"ok": False, "error": "unknown frame"}
        relpath = None
        file_row = None
        instant = []
        fmt = src_path.suffix.lstrip(".").lower()
    elif path:
        src_path, why = resolve_data_path(vault, path)
        if src_path is None:
            return {"ok": False, "error": why}
        hit = catalog_key_for(vault, src_path)
        if hit:
            return dataset(vault, hit[0], hit[1])      # it is a registry file after all
        relpath = None
        file_row = None
        instant = []
        fmt = src_path.suffix.lstrip(".").lower()
    else:
        if not family or not key:
            return {"ok": False, "error": "family and key are required"}
        entry, why = _catalog_entry(vault, family, key)
        if entry is None:
            return {"ok": False, "error": why}
        src_path = entry["path"]
        if not src_path.is_file():
            return {"ok": False, "error": "dataset file is gone"}
        relpath = entry["relpath"]
        file_row, rows = _registry_rows(vault, family, relpath)
        instant = [{"name": r["name"], "label": r["label"] or "",
                    "dtype": r["dtype"] or "", "ordinal": r["ordinal"]}
                   for r in (rows or [])]
        fmt = (file_row or {}).get("format") or entry.get("format") or ""

    cid = cache_id(src_path)
    if cid is None:
        return {"ok": False, "error": "dataset file is gone"}
    prof_p = profile_path(cid)
    try:
        prof_mt = prof_p.stat().st_mtime_ns
    except OSError:
        prof_mt = 0

    ck = (cid, prof_mt, len(instant))
    hit = _DS_CACHE.get(ck)
    if hit is not None:
        return hit

    prof, stats, state = _profile_state(vault, cid, prof_mt, src_path, family, key)

    if instant:
        variables = [_merge_variable(b, stats.get(b["name"], {})) for b in instant]
    elif state == "ready":
        variables = [_merge_variable(
            {"name": v.get("name"), "label": v.get("label") or "",
             "dtype": v.get("dtype") or "", "ordinal": v.get("ordinal", i)}, v)
            for i, v in enumerate(stats.values())]
    else:
        variables = []
    variables, trimmed = _trim(variables)

    st = None
    try:
        st = src_path.stat()
    except OSError:
        pass
    psrc = (prof or {}).get("source") or {}
    source = {
        "family": family, "key": key, "frame": frame,
        "path": _home_rel(src_path), "format": fmt,
        "bytes": st.st_size if st else None,
        "mtime": round(st.st_mtime, 3) if st else None,
        "n_rows": (file_row or {}).get("n_rows") or psrc.get("n_rows"),
        "n_cols": ((file_row or {}).get("n_cols") or psrc.get("n_cols")
                   or (len(variables) or None)),
    }
    stamp = hashlib.sha1(("%s|%s|%s|%d|%s" % (cid, state, prof_mt, len(variables),
                                              ",".join(trimmed))).encode("utf-8")).hexdigest()[:16]
    out = {"ok": True, "source": source, "profile": state, "stamp": stamp,
           "sampled": bool((prof or {}).get("sampled")), "variables": variables}
    if trimmed:
        out["trimmed"] = True
        out["trimmedFields"] = trimmed
    if state == "failed":
        out["error"] = _scrub((prof or {}).get("error") or "profile failed")
    if state == "ready" and prof.get("sample_rows") is not None:
        out["sampleRows"] = prof.get("sample_rows")

    _DS_CACHE[ck] = out
    _DS_ORDER.append(ck)
    while len(_DS_ORDER) > _DS_MAX:
        _DS_CACHE.pop(_DS_ORDER.popleft(), None)
    return out


VAR_RE = re.compile(r"^[A-Za-z0-9_.][A-Za-z0-9_.:# %()\[\]-]{0,127}$")

# Every field the drill-down promises, in order, so the shape is the same whether the
# profile has the number or not.
_VAR_FIELDS = ("name", "label", "dtype", "storage", "ordinal", "n", "miss", "miss_pct",
               "uniq", "min", "median", "max", "mean", "sd", "top", "hist",
               "value_labels")


def _registry_one(vault, family, relpath, name):
    p = hub_dir(vault) / "datasets.db"
    if not p.is_file():
        return None
    con = None
    try:
        con = sqlite3.connect(p.as_uri() + "?mode=ro", uri=True, timeout=2.0)
        con.row_factory = sqlite3.Row
        r = con.execute(
            "select name, label, dtype, ordinal from variables "
            "where family = ? and relpath = ? and name = ? limit 1",
            (family, relpath, name)).fetchone()
        return dict(r) if r else None
    except sqlite3.Error:
        return None
    finally:
        if con is not None:
            try:
                con.close()
            except sqlite3.Error:
                pass


def variable(vault, family=None, key=None, frame=None, name=None, path=None):
    """One variable, UNTRIMMED -- every level, the whole histogram, all the value labels."""
    name = (name or "").strip()
    if not name or not VAR_RE.match(name):
        return {"ok": False, "error": "bad variable name"}
    if frame:
        if not explore.ID_RE.match(frame):
            return {"ok": False, "error": "bad frame id"}
        src_path = _frame_file(frame)
        if src_path is None:
            return {"ok": False, "error": "unknown frame"}
        base = None
    elif path:
        src_path, why = resolve_data_path(vault, path)
        if src_path is None:
            return {"ok": False, "error": why}
        hit = catalog_key_for(vault, src_path)
        if hit:
            return variable(vault, hit[0], hit[1], None, name)
        base = None
    else:
        if not family or not key:
            return {"ok": False, "error": "family and key are required"}
        entry, why = _catalog_entry(vault, family, key)
        if entry is None:
            return {"ok": False, "error": why}
        src_path = entry["path"]
        if not src_path.is_file():
            return {"ok": False, "error": "dataset file is gone"}
        base = _registry_one(vault, family, entry["relpath"], name)

    cid = cache_id(src_path)
    if cid is None:
        return {"ok": False, "error": "dataset file is gone"}
    try:
        prof_mt = profile_path(cid).stat().st_mtime_ns
    except OSError:
        prof_mt = 0
    prof, stats, state = _profile_state(vault, cid, prof_mt, src_path, family, key)
    stat = stats.get(name)
    if base is None and stat is None:
        # the dataset's own variable list is the allowlist; anything else is a 404,
        # which is also what every traversal-shaped name lands on
        return {"ok": False, "error": "unknown variable"}

    merged = dict(base or {})
    merged.setdefault("name", name)
    for k, v in (stat or {}).items():
        if v is not None:
            merged[k] = v
    out = {k: merged.get(k) for k in _VAR_FIELDS}
    out["name"] = name
    res = {"ok": True, "source": {"family": family, "key": key, "frame": frame,
                                  "path": _home_rel(src_path) if path else None},
           "profile": state, "variable": out}
    if state == "failed":
        res["error"] = _scrub((prof or {}).get("error") or "profile failed")
    return res


_HEADS = {}


def _profile_head(entry):
    """{source, failed} out of a profile WITHOUT parsing the whole file."""
    try:
        st = entry.stat()
        key = (entry.path, st.st_mtime_ns, st.st_size)
    except OSError:
        return {}
    hit = _HEADS.get(key)
    if hit is not None:
        return hit
    out = None
    if st.st_size > 64 * 1024:
        # a big file is a real profile, never a failed record (those are a few lines)
        try:
            with open(entry.path, "r", encoding="utf-8", errors="replace") as fh:
                head = fh.read(8192)
            i = head.find('"source"')
            j = head.find("{", i + 8) if i >= 0 else -1
            if j >= 0:
                src, _ = json.JSONDecoder().raw_decode(head, j)
                out = {"source": src, "failed": False}
        except (OSError, ValueError):
            out = None
    if out is None and st.st_size <= 8 * 1024 * 1024:
        d = _read_json(entry.path) or {}
        out = {"source": d.get("source") or {}, "failed": bool(d.get("failed"))}
    if out is None:
        out = {}                  # an unusual layout is a blank menu row, not a stall
    if len(_HEADS) > 200:
        _HEADS.clear()
    _HEADS[key] = out
    return out


def _ds_ident(row):
    """What makes two menu rows the same dataset. The registry identity wins where there
    is one, so a path dataset that turned out to be a registry file merges with its own
    profile on disk instead of listing twice."""
    if row.get("family") or row.get("key"):
        return ("reg", row.get("family"), row.get("key"))
    if row.get("frame"):
        return ("frame", row.get("frame"))
    return ("path", row.get("path"))


_CATVIEW = {"key": None, "body": None}

_BULLET_RE = re.compile(r"^\s*[-*]\s+`([^`]+)`\s*(?:—|–|--|:)\s*(\S.*)$")
LABEL_MAX = 140
_STATA_NAME_RE = re.compile(r"[^A-Za-z0-9_]")


def _farm_name(name):
    """alnum + _, never leading-digit. A FILE stem, so it is not truncated -- the
    32-char cut belongs to the global name and to nothing else."""
    s = _STATA_NAME_RE.sub("_", str(name))
    if not s or not (s[0].isalpha() or s[0] == "_"):
        s = "_" + s
    return s


def _stata_name(name):
    """A Stata global's name, so 32 characters and no more."""
    return _farm_name(name)[:32]


def _stata_globals(cat):
    """{(family, key): global name} -- one global per family default, then one per
    dataset of the primary family (settings.DATA_FAMILY), de-duplicated."""
    fams = cat.get("families") or {}
    out, seen = {}, {"root"}
    for fam in sorted(fams):
        entry = fams[fam]
        if not isinstance(entry, dict):
            continue
        dflt = entry.get("default")
        if not dflt:
            continue
        name = _stata_name(fam)
        if name.lower() in seen:
            continue
        seen.add(name.lower())
        if name == _farm_name(fam):
            out[(fam, dflt)] = name
    primary = settings.DATA_FAMILY
    primary_sets = (fams.get(primary) or {}).get("datasets") or {}
    for key in sorted(primary_sets):
        raw = primary + "_" + key
        name = _stata_name(raw)
        if name.lower() in seen:
            continue
        seen.add(name.lower())
        if name != _farm_name(raw):
            continue
        out.setdefault((primary, key), name)
    return out


def _stata_taken(cat):
    """Every global name the catalog defines, lowered -- the cut ones too."""
    fams = cat.get("families") or {}
    taken = {"root", "data"}
    for fam in sorted(fams):
        entry = fams[fam]
        if isinstance(entry, dict) and entry.get("default"):
            taken.add(_stata_name(fam).lower())
    for key in (fams.get(settings.DATA_FAMILY) or {}).get("datasets") or {}:
        taken.add(_stata_name(settings.DATA_FAMILY + "_" + key).lower())
    return taken


_STEM_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,31}$")
_STEM_DIR = settings.DATA_FAMILY + "/datasets/"


def _stem_global(relpath, taken):
    """The bare-stem global for this file, or None."""
    rec = str(relpath or "").replace(os.sep, "/")
    if not rec.startswith(_STEM_DIR) or not rec.lower().endswith(".dta"):
        return None
    stem = rec[len(_STEM_DIR):-len(".dta")]
    if "/" in stem or not _STEM_RE.match(stem) or stem.lower() in taken:
        return None
    return stem


def _raw_label(rel):
    parts = (rel or "").split("/")[:-1]
    low = [p.lower() for p in parts]
    if "unprocessed" not in low:
        return ""
    if "unfiled data" in low and low[-1] != "unfiled data":
        return f"raw delivery: {parts[-1]}"
    return "unfiled data"


def _family_labels(famdir):
    labels = {}
    for src in (famdir / "README.md", famdir / "context" / "measures.md"):
        try:
            if not src.is_file():
                continue
            with open(src, "r", encoding="utf-8", errors="replace") as fh:
                lines = [next(fh, "") for _ in range(400)]
        except OSError:
            continue
        for line in lines:
            m = _BULLET_RE.match(line.rstrip("\n"))
            if not m:
                continue
            raw, text = m.group(1).strip(), m.group(2).strip()
            text = re.sub(r"\s+", " ", text)[:LABEL_MAX]
            base = raw.rsplit("/", 1)[-1]
            stem = base.rsplit(".", 1)[0]
            for k in (raw, base, stem, stem.lower(), re.sub(r"[^a-z0-9]", "_",
                                                            stem.lower()).strip("_")):
                if k:
                    labels.setdefault(k, text)
    return labels


def _shapes(vault):
    p = hub_dir(vault) / "datasets.db"
    if not p.is_file():
        return {}
    con = None
    try:
        con = sqlite3.connect(p.as_uri() + "?mode=ro", uri=True, timeout=2.0)
        rows = con.execute("select family, relpath, n_rows, n_cols from files").fetchall()
        shapes = {(f, r): (nr, nc) for f, r, nr, nc in rows}
        if any(nc is None for _, nc in shapes.values()):
            for f, r, n in con.execute("select family, relpath, count(*) from variables "
                                       "group by family, relpath"):
                nr, nc = shapes.get((f, r), (None, None))
                if nc is None and n:
                    shapes[(f, r)] = (nr, n)
        return shapes
    except sqlite3.Error:
        return {}
    finally:
        if con is not None:
            try:
                con.close()
            except sqlite3.Error:
                pass


def _farm_names(family, key, relpath, farm):
    """The dta farm's links that really name THIS file, its own name first."""
    if farm is None or not relpath:
        return []
    want = os.path.realpath(str(farm.parent / relpath))
    out = []
    for name in (relpath.rsplit("/", 1)[-1],
                 _farm_name("%s_%s" % (family, key)) + ".dta"):
        try:
            if os.path.realpath(str(farm / name)) == want:
                out.append(name)
        except OSError:
            continue
    return out


def _usage(family, key, fmt, is_default, gname, farm_ok, relpath=None, farm=None):
    """(usage, usage_short or None) -- the lines above, for one dataset."""
    use = {"python": 'df = load("%s", "%s")' % (family, key),
           "r": 'df <- load("%s", "%s")' % (family, key)}
    if fmt == "dta" and gname:
        use["stata"] = "use $%s, clear" % gname
    elif fmt == "dta":
        names = _farm_names(family, key, relpath, farm)
        own = _STEM_DIR + (relpath or "").rsplit("/", 1)[-1] == (relpath or "")
        if own:
            use["stata"] = 'use "$data/%s", clear' % relpath.rsplit("/", 1)[-1]
        elif names:
            use["stata"] = 'use "$dta/%s", clear' % names[0]
        elif relpath:
            use["stata"] = 'use "$root/%s", clear' % relpath
        else:
            use["stata"] = "dataload %s %s" % (family, key)
    else:
        use["stata"] = "dataload %s %s" % (family, key)
    if not is_default:
        return use, None
    short = {"python": 'df = load("%s")' % family,
             "r": 'df <- load("%s")' % family,
             "stata": ("use %s, clear" % _farm_name(family)) if farm_ok
                      else "dataload %s" % family}
    return use, short


def catalog(vault):
    hub = hub_dir(vault)
    cat = _catalog(vault)
    if cat is None:
        return {"ok": False, "error": "no catalog.json"}
    db = hub / "datasets.db"
    key = (str(vault), _CATALOG["key"], _mt(db))
    if _CATVIEW["key"] == key and _CATVIEW["body"] is not None:
        return _CATVIEW["body"]

    shapes = _shapes(vault)
    globals_ = _stata_globals(cat)
    taken = _stata_taken(cat)
    farm = hub / "dta"
    try:
        hubres = hub.resolve()
    except OSError:
        hubres = hub
    recorded_hub = cat.get("hub") or ""
    fams = []
    for fam in sorted(cat.get("families") or {}):
        entry = cat["families"][fam]
        if not isinstance(entry, dict):
            continue
        ds = entry.get("datasets") if isinstance(entry.get("datasets"), dict) else {}
        famdir = _rebase(vault, entry.get("path") or "", recorded_hub) or (hub / fam)
        dflt = entry.get("default") if entry.get("default") in ds else None
        labels = _family_labels(famdir) if ds else {}
        farm_ok = bool(dflt) and str(ds[dflt].get("path") or "").lower().endswith(".dta")
        rows = []
        for k in sorted(ds, key=lambda x: (x != dflt, x)):
            e = ds[k]
            if not isinstance(e, dict):
                continue
            p = _rebase(vault, e.get("path") or "", recorded_hub)
            fmt = str(e.get("format") or (p.suffix.lstrip(".") if p else "")).lower()
            rel = None
            if p is not None:
                try:
                    rel = str(p.relative_to(famdir)).replace(os.sep, "/")
                except ValueError:
                    rel = p.name
            n_rows, n_cols = shapes.get((fam, rel), (None, None)) if rel else (None, None)
            base = (rel or "").rsplit("/", 1)[-1]
            label = ""
            for cand in (rel, base, base.rsplit(".", 1)[0], k):
                if cand and cand in labels:
                    label = labels[cand]
                    break
            label = label or _raw_label(rel)
            hubrel = None
            if p is not None:
                try:
                    hubrel = str(p.relative_to(hubres)).replace(os.sep, "/")
                except ValueError:
                    hubrel = None
            gname = globals_.get((fam, k)) or _stem_global(hubrel, taken)
            usage, short = _usage(fam, k, fmt, k == dflt, gname, farm_ok,
                                  relpath=hubrel, farm=farm)
            row = {"key": k, "format": fmt, "bytes": e.get("bytes"),
                   "mtime": _epoch(e.get("mtime")), "rows": e.get("rows") or n_rows,
                   "cols": n_cols, "label": label, "usage": usage}
            if short:
                row["usage_short"] = short
            rows.append(row)
        fams.append({"family": fam, "path": _home_rel(famdir),
                     "readme": bool(entry.get("readme")), "default": dflt,
                     "n": len(rows), "datasets": rows})
    body = {"ok": True, "stamp": "%x-%x" % ((_CATALOG["key"] or (0, 0))[1] or 0,
                                            int(_mt(db) * 1e6)),
            "hub": _home_rel(hub), "families": fams}
    _CATVIEW.update(key=key, body=body)
    return body


def _epoch(raw):
    if isinstance(raw, (int, float)):
        return int(raw)
    s = str(raw or "").strip()
    if not s:
        return None
    for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
        try:
            return int(time.mktime(time.strptime(s[:19], fmt)))
        except ValueError:
            continue
    return None


def datasets(vault, session=None):
    """The waiting menu: what this session loaded recently, then whatever else has a
    profile on disk. Newest first, one entry per dataset."""
    ring, _ = _snapshot()
    out, seen = [], set()
    for e in reversed(ring):
        if e["kind"] != "dataset" or not _in_scope(e, session):
            continue
        ident = _ds_ident(e)
        if ident in seen:
            continue
        seen.add(ident)
        out.append({"family": e.get("family"), "key": e.get("key"),
                    "frame": e.get("frame"), "path": e.get("path"),
                    "title": e.get("title"),
                    "n_rows": None, "n_cols": None, "ts": e["ts"], "profile": None})
    try:
        files = sorted((e for e in os.scandir(state_dir() / "profiles")
                        if e.is_file() and e.name.endswith(".json")),
                       key=lambda e: e.stat().st_mtime, reverse=True)[:12]
    except OSError:
        files = []
    for e in files:
        d = _profile_head(e)
        src = d.get("source") or {}
        row = {"family": src.get("family"), "key": src.get("key"),
               "frame": src.get("frame"),
               "path": _home_rel(src["path"]) if src.get("path") else None,
               "title": src.get("title"),
               "n_rows": src.get("n_rows"), "n_cols": src.get("n_cols"),
               "ts": round(e.stat().st_mtime, 3),
               "profile": "failed" if d.get("failed") else "ready"}
        ident = _ds_ident(row)
        if ident in seen:
            for r in out:                       # fill the ring entry's blanks in place
                if _ds_ident(r) == ident:
                    r["profile"] = row["profile"]
                    r["n_rows"] = r["n_rows"] or row["n_rows"]
                    r["n_cols"] = r["n_cols"] or row["n_cols"]
                    r["title"] = r["title"] or row["title"]
                    r["path"] = r["path"] or row["path"]
            continue
        if ident == ("path", None):
            continue
        seen.add(ident)
        out.append(row)
    return {"ok": True, "datasets": out}


SCOPE_EXT = {".do", ".py", ".r", ".qmd", ".rmd", ".ipynb"}
SCOPE_SKIP = {"archive", "results", "logs", "node_modules", "__pycache__", "venv",
              "site-packages"}
SCOPE_FILE_MAX = 2 * 1024 * 1024      # bytes read per script
SCOPE_FILES_MAX = 4000                # scripts per project
SCOPE_TTL = 5.0                       # seconds a scope is trusted without re-walking
SCOPE_EVIDENCE_MAX = 5                # files named per dataset
FAMILY_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}$")
_SCOPE = {}
_SCOPE_LOCK = threading.Lock()
_SCOPE_IDX = {"key": None, "idx": None}

_TOK = r"[^\s\"'`,;()\[\]{}<>|\\]"
_HUBREF_RE = re.compile(r"(?:Projects/data|\$\{?root\}?)"
                        r"/([A-Za-z0-9][A-Za-z0-9_.-]*)((?:/" + _TOK + r"*)?)")
_LABREF_RE = re.compile(r"\$\{?data\}?/(" + _TOK + r"+)")
_DTAREF_RE = re.compile(r"\$\{?dta\}?/(" + _TOK + r"+)")
_GLOBAL_RE = re.compile(r"\$\{?([A-Za-z_][A-Za-z0-9_]{0,31})\}?")
_LOAD_RE = re.compile(r"\bload\(\s*[\"']([A-Za-z0-9][A-Za-z0-9_.-]*)(?:/([A-Za-z0-9_.-]+))?"
                      r"[\"']\s*(?:,\s*[\"']([A-Za-z0-9_.-]+)[\"'])?")
_DATALOAD_RE = re.compile(r"\bdataload[ \t]+([A-Za-z0-9][A-Za-z0-9_.-]*)"
                         r"(?:[ \t]+([A-Za-z0-9_.-]+))?")
_FILETOK_RE = re.compile(r"([A-Za-z0-9_.-]+\.(?:dta|csv|tsv|parquet|feather|sav|por|xlsx))\b",
                         re.I)
_USESTEM_RE = re.compile(r"\buse[ \t]+\"?[^\",\n]*/([A-Za-z0-9_-]{6,})\"?[ \t]*(?:,|$)", re.M)


def _hubrel_of(recorded, recorded_hub):
    """A catalog path as hub-relative text -- string work only, no stat, no resolve."""
    s = str(recorded or "").replace("\\", "/")
    h = str(recorded_hub or "").replace("\\", "/").rstrip("/")
    if h and s.startswith(h + "/"):
        s = s[len(h) + 1:]
    return s.lstrip("/")


def _scope_index(vault):
    """Every name a script might use for a catalogued dataset, keyed for lookup. Built
    once per catalog generation."""
    cat = _catalog(vault)
    if cat is None:
        return None
    if _SCOPE_IDX["key"] == _CATALOG["key"] and _SCOPE_IDX["idx"] is not None:
        return _SCOPE_IDX["idx"]
    hub = cat.get("hub") or ""
    fams, paths, base, farm, dflt, rels = {}, {}, {}, {}, {}, {}
    taken = _stata_taken(cat)
    glob = {v: k for k, v in _stata_globals(cat).items()}
    for fam, entry in (cat.get("families") or {}).items():
        ds = entry.get("datasets") if isinstance(entry, dict) else None
        if not isinstance(ds, dict):
            continue
        fams[fam] = sorted(k for k in ds if isinstance(ds[k], dict))
        if entry.get("default") in fams[fam]:
            dflt[fam] = entry["default"]
        fb = base.setdefault(fam, {})
        for k in fams[fam]:
            rel = _hubrel_of(ds[k].get("path"), hub)
            if not rel:
                continue
            rels[(fam, k)] = rel
            paths.setdefault(rel.lower(), (fam, k))
            b = rel.rsplit("/", 1)[-1].lower()
            fb[b] = (fam, k) if b not in fb else None      # two files, one name: neither
            if b.endswith(".dta"):
                farm[b] = (fam, k) if b not in farm else None
                farm.setdefault((_farm_name("%s_%s" % (fam, k)) + ".dta").lower(), (fam, k))
            g = _stem_global(rel, taken)
            if g:
                glob.setdefault(g, (fam, k))
    for g in ("root", "data", "dta"):
        glob.pop(g, None)
    idx = {"fams": fams, "paths": paths, "base": base, "farm": farm, "glob": glob,
           "default": dflt, "rels": rels}
    _SCOPE_IDX.update(key=_CATALOG["key"], idx=idx)
    return idx


def _scope_files(proj):
    """[(path, mtime_ns, size)] of the scripts a project's scope is read from. Never
    follows a symlink, never enters a dot-directory or a skipped one."""
    out, stack = [], [str(proj)]
    while stack and len(out) < SCOPE_FILES_MAX:
        d = stack.pop()
        try:
            it = list(os.scandir(d))
        except OSError:
            continue
        for e in it:
            if e.name.startswith("."):
                continue
            try:
                if e.is_dir(follow_symlinks=False):
                    if e.name.lower() not in SCOPE_SKIP:
                        stack.append(e.path)
                    continue
                if not e.is_file(follow_symlinks=False):
                    continue
                if os.path.splitext(e.name)[1].lower() not in SCOPE_EXT:
                    continue
                st = e.stat(follow_symlinks=False)
            except OSError:
                continue
            out.append((e.path, st.st_mtime_ns, st.st_size))
    out.sort()
    return out


def _frontmatter_datasets(readme):
    """The README frontmatter's `datasets:` entries, or None when it has none."""
    try:
        with open(readme, "r", encoding="utf-8", errors="replace") as fh:
            head = fh.read(16384)
    except OSError:
        return None
    lines = head.splitlines()
    if not lines or lines[0].strip() != "---":
        return None
    out, inside = None, False
    for ln in lines[1:]:
        if ln.strip() in ("---", "..."):
            break
        if inside:
            m = re.match(r"^\s+-\s*[\"']?([^\"'#]+?)[\"']?\s*(?:#.*)?$", ln)
            if m:
                out.append(m.group(1).strip())
                continue
            if ln.strip() and not ln.startswith((" ", "\t")):
                inside = False
            else:
                continue
        m = re.match(r"^datasets\s*:\s*(.*)$", ln)
        if m:
            out = []
            rest = m.group(1).split("#", 1)[0].strip()
            if rest.startswith("["):
                out += [x.strip().strip("\"'") for x in rest.strip("[]").split(",")]
            elif rest:
                out.append(rest.strip("\"'"))
            else:
                inside = True
    return [x for x in out if x] if out is not None else None


class _Hits:
    """Keys and families found, each with the files that named it."""

    def __init__(self):
        self.keys, self.fams = {}, {}

    def key(self, fam, k, rel):
        self._add(self.keys, "%s/%s" % (fam, k), rel)
        self._add(self.fams, fam, rel)

    def fam(self, fam, rel):
        self._add(self.fams, fam, rel)

    @staticmethod
    def _add(d, name, rel):
        ev = d.setdefault(name, [])
        if rel not in ev and len(ev) < SCOPE_EVIDENCE_MAX:
            ev.append(rel)


def _scan_text(text, rel, idx, hits, mentioned):
    fams, paths, glob = idx["fams"], idx["paths"], idx["glob"]
    text = text.replace("\\\\", "/").replace("\\", "/")
    for m in _HUBREF_RE.finditer(text):
        fam, rest = m.group(1), (m.group(2) or "").rstrip("/.:")
        if fam not in fams:
            continue
        mentioned.setdefault(fam, rel)
        hit = paths.get((fam + rest).lower()) if rest else None
        if hit is None and rest:
            hit = idx["base"].get(fam, {}).get(rest.rsplit("/", 1)[-1].lower())
        if hit:
            hits.key(hit[0], hit[1], rel)
    primary = settings.DATA_FAMILY
    if primary in fams:
        wb = idx["base"].get(primary, {})
        for m in _LABREF_RE.finditer(text):
            mentioned.setdefault(primary, rel)
            b = m.group(1).rsplit("/", 1)[-1].lower()
            hit = paths.get((_STEM_DIR + m.group(1)).lower()) \
                or wb.get(b) or wb.get(b + ".dta")
            if hit:
                hits.key(hit[0], hit[1], rel)
    for m in _DTAREF_RE.finditer(text):
        b = m.group(1).rsplit("/", 1)[-1].lower()
        hit = idx["farm"].get(b) or idx["farm"].get(b + ".dta")
        if hit:
            hits.key(hit[0], hit[1], rel)
    if rel.lower().endswith(".do"):
        for m in _GLOBAL_RE.finditer(text):
            hit = glob.get(m.group(1))
            if hit:
                hits.key(hit[0], hit[1], rel)
    for rx in (_LOAD_RE, _DATALOAD_RE):
        for m in rx.finditer(text):
            fam = m.group(1)
            k = m.group(2) or (m.group(3) if rx is _LOAD_RE else None)
            if fam not in fams:
                continue
            if k and k in fams[fam]:
                hits.key(fam, k, rel)
            else:
                mentioned.setdefault(fam, rel)


def _scan_project(proj, files, idx):
    hits, mentioned, texts = _Hits(), {}, []
    for path, _mtns, _size in files:
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as fh:
                text = fh.read(SCOPE_FILE_MAX)
        except OSError:
            continue
        rel = os.path.relpath(path, str(proj)).replace(os.sep, "/")
        _scan_text(text, rel, idx, hits, mentioned)
        texts.append((rel, text))
    # second pass: a family whose directory the project names also claims the dataset
    # file names it spells -- DATASETS / "grouped_x.dta", use "$data/grouped_x"
    if mentioned:
        for rel, text in texts:
            names = {t.lower() for t in _FILETOK_RE.findall(text)}
            if rel.lower().endswith(".do"):
                names |= {t.lower() + ".dta" for t in _USESTEM_RE.findall(text)}
            for fam in mentioned:
                fb = idx["base"].get(fam) or {}
                for n in names:
                    hit = fb.get(n)
                    if hit:
                        hits.key(hit[0], hit[1], rel)
    for fam, rel in mentioned.items():
        hits.fam(fam, rel)
    return hits


def _scope_none(project):
    return {"ok": True, "kind": "none", "project": project or "", "label": "",
            "families": [], "whole": [], "datasets": [], "evidence": {}, "stamp": "none"}


CORE_DIRS = {"datasets", "derived", "processed", "datasets/unprocessed", "unprocessed",
             "raw", "data/raw", "data/processed"}
BACKUP_RE = re.compile(r"\.pre_|\.bak\b|_bak\b|\.orig\b", re.I)


def _core_keys(fam, keys, idx):
    rels = idx.get("rels") or {}
    keep = []
    for k in keys:
        rel = rels.get((fam, k)) or ""
        parts = rel.split("/")[1:] if rel.split("/", 1)[0] == fam else rel.split("/")
        if len(parts) < 2 or BACKUP_RE.search(parts[-1]):
            continue
        if "/".join(parts[:-1]).lower() in CORE_DIRS:
            keep.append(k)
    return keep or list(keys)


def _scope_body(kind, project, label, hits, idx):
    """-> the wire shape. A family with no key of its own scopes whole. `datasets` is in
    the order the Variables view defaults by: the keys the most files name first, then
    each whole family with its default dataset first."""
    keyed = {k.split("/", 1)[0] for k in hits.keys}
    whole = sorted(f for f in hits.fams if f not in keyed)
    ds = sorted(hits.keys, key=lambda k: (-len(hits.keys[k]), k))
    for fam in whole:
        d = idx["default"].get(fam)
        ds += ["%s/%s" % (fam, k) for k in sorted(_core_keys(fam, idx["fams"].get(fam, []), idx),
                                                   key=lambda k: (k != d, k))]
    if not ds:
        return _scope_none(project)
    evidence = {k: hits.keys[k] for k in sorted(hits.keys)}
    for fam in whole:
        evidence[fam] = hits.fams[fam]
    body = {"ok": True, "kind": kind, "project": project, "label": label,
            "families": sorted(hits.fams), "whole": whole, "datasets": ds,
            "evidence": evidence}
    body["stamp"] = hashlib.sha1(json.dumps(body, sort_keys=True).encode()).hexdigest()[:16]
    return body


def _family_for_dir(idx, proj):
    """The catalog family a data project folder IS, or None."""
    if proj.name in idx["fams"]:
        return proj.name
    want = explore._kebab(proj.name)
    for fam in sorted(idx["fams"]):
        if explore._kebab(fam) == want:
            return fam
    return None


def scope(vault, project=None, family=None):
    """{ok, kind, project, label, families, whole, datasets, evidence, stamp}: the hub
    datasets this pane's project (or data group) uses. kind "none" = show everything."""
    idx = _scope_index(vault)
    if idx is None:
        return {"ok": False, "error": "no catalog.json"}
    if family:
        if not FAMILY_RE.match(family) or family not in idx["fams"]:
            return _scope_none(family if FAMILY_RE.match(family) else "")
        h = _Hits()
        h.fam(family, "catalog.json")
        return _scope_body("family", family, family, h, idx)
    slug = (project or "").strip()
    if not slug or len(slug) > 200 or CTRL_RE.search(slug):
        return _scope_none("")
    proj = explore.project_root(vault, slug)
    if proj is None:
        return _scope_none(slug)
    if proj.parent == hub_dir(vault):
        fam = _family_for_dir(idx, proj)
        if fam is None:
            return _scope_none(slug)
        h = _Hits()
        h.fam(fam, "catalog.json")
        return _scope_body("family", slug, fam, h, idx)

    now = time.monotonic()
    ck = (str(vault), str(proj))
    with _SCOPE_LOCK:
        hit = _SCOPE.get(ck)
    if hit and hit["cat"] == _CATALOG["key"] and now - hit["t"] < SCOPE_TTL:
        return hit["body"]
    readme = proj / "README.md"
    files = _scope_files(proj)
    sig = (_CATALOG["key"], _mt(readme), len(files),
           max((f[1] for f in files), default=0), sum(f[2] for f in files))
    if hit and hit["sig"] == sig:
        with _SCOPE_LOCK:
            hit["t"] = now
        return hit["body"]

    body = None
    fm = _frontmatter_datasets(readme)
    if fm:
        h = _Hits()
        for item in fm:
            fam, _, k = item.partition("/")
            if fam not in idx["fams"]:
                continue
            if k and k in idx["fams"][fam]:
                h.key(fam, k, "README.md")
            elif not k:
                h.fam(fam, "README.md")
        if h.fams:
            body = _scope_body("project", slug, slug, h, idx)
    if body is None:
        body = _scope_body("project", slug, slug, _scan_project(proj, files, idx), idx)
    with _SCOPE_LOCK:
        if len(_SCOPE) > 64:
            _SCOPE.clear()
        _SCOPE[ck] = {"t": now, "sig": sig, "cat": _CATALOG["key"], "body": body}
    return body


DICT_LANES = ("python", "r", "stata", "sql")
SHARED_LANES = ("all", "any", "general")

_CHEAT = {"key": None, "rows": None}
_MANIFEST = {"key": None, "data": None}
_DICTVIEW = {}                             # lane -> (key, body); four lanes, no eviction


def _mtns(p):
    """mtime_ns, 0 when the file is not there -- and 0 is a perfectly good cache key:
    the answer for a missing source is the same every time, and the day it appears its
    mtime is not 0."""
    try:
        return p.stat().st_mtime_ns
    except OSError:
        return 0


def cheat_path():
    """The command dictionary: the panel_cheat setting (AIOA_PANEL_CHEAT), else a file
    in the state dir."""
    over = str(settings.get("panel_cheat", "") or "")
    if over:
        return Path(over).expanduser()
    return settings.STATE_DIR / "panel" / "cheat.json"


def recipes_dir(vault):
    """The panel_recipes setting (AIOA_PANEL_RECIPES), else recipes/ in the data folder."""
    over = str(settings.get("panel_recipes", "") or "")
    if over:
        return Path(over).expanduser()
    return hub_dir(vault) / "recipes"


def _item_id(source, lane, label, cmd):
    """Stable across restarts and machines, so the pane can key a row on it: the source,
    the lane, the label and the body, NUL-joined and hashed."""
    joined = "\x00".join((source, lane, label, cmd))
    return hashlib.sha1(joined.encode("utf-8", "replace")).hexdigest()[:12]


def _text(v):
    """A string passes through untouched. Anything else is not text and is not shown."""
    return v if isinstance(v, str) else ""


PH_KINDS = ("variable", "variables", "family", "key", "path", "int", "number", "text")
_PH_RE = re.compile(r"\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}")
_PH_BY_NAME = {
    "variable": ("var", "x", "y", "by", "col", "column", "outcome", "group",
                 "weight", "id"),
    "variables": ("vars", "cols"),
    "family": ("family",),
    "key": ("key", "dataset"),
    "int": ("n", "k", "rows", "top"),
    "path": ("path", "file"),
}
_PH_KIND_OF = {name: kind for kind, names in _PH_BY_NAME.items() for name in names}


def _ph_kind(name):
    return _PH_KIND_OF.get(name.lower(), "text")


def _placeholders(cmd, inputs=None):
    """One entry per distinct {{hole}} in cmd, in order of first appearance."""
    spec = {}
    for inp in inputs or ():
        if isinstance(inp, dict) and isinstance(inp.get("name"), str):
            spec.setdefault(inp["name"], inp)
    out, seen = [], set()
    for m in _PH_RE.finditer(cmd or ""):
        name = m.group(1)
        if name in seen:
            continue
        seen.add(name)
        d = spec.get(name) or {}
        kind = _text(d.get("kind")).strip().lower()
        if kind not in PH_KINDS:
            kind = _ph_kind(name)
        default = d.get("default")
        out.append({"name": name, "kind": kind,
                    "default": default if isinstance(default, str) else None})
    return out


def _cheat_rows():
    p = cheat_path()
    key = (str(p), _mtns(p))
    if _CHEAT["key"] == key:
        return _CHEAT["rows"]
    d = _read_json(p)
    rows = [r for r in d if isinstance(r, dict)] if isinstance(d, list) else []
    _CHEAT.update(key=key, rows=rows)
    return rows


def _manifest(vault):
    """manifest.json's category ORDER and the category each action id belongs to, or
    None when it is missing or says neither -- and then every recipe lands in one group
    called `recipes`, because the manifest is what says how they divide up."""
    p = recipes_dir(vault) / "manifest.json"
    key = (str(p), _mtns(p))
    if _MANIFEST["key"] == key:
        return _MANIFEST["data"]
    d = _read_json(p)
    out = None
    if isinstance(d, dict):
        order = [c for c in (d.get("categories") or []) if isinstance(c, str) and c]
        cats = {}
        for a in (d.get("actions") or []):
            if isinstance(a, dict) and a.get("id") and _text(a.get("category")):
                cats[str(a["id"])] = a["category"]
        if order or cats:
            out = {"order": order, "cats": cats}
    _MANIFEST.update(key=key, data=out)
    return out


def _recipe_category(r, man):
    """The `category` field, else the first tag, else `other`. The manifest's own
    answer for the action wins when it has one."""
    if man:
        c = man["cats"].get(str(r.get("id") or ""))
        if c:
            return c
    c = _text(r.get("category")).strip()
    if c:
        return c
    tags = r.get("tags")
    if isinstance(tags, list) and tags and _text(tags[0]).strip():
        return tags[0]
    return "other"


def _group_into(groups, index, source, name, item):
    g = index.get(name)
    if g is None:
        g = {"name": name, "source": source, "items": []}
        index[name] = g
        groups.append(g)
    g["items"].append(item)


def _recipe_groups(vault, lane):
    """The lane's recipe file, grouped. Order: the manifest's category order first,
    then any category it does not name, in the order the file lists them."""
    doc = _read_json(recipes_dir(vault) / ("%s.json" % lane))
    recs = doc.get("recipes") if isinstance(doc, dict) else None
    if not isinstance(recs, list):
        return []
    doclang = _text(doc.get("lang")).strip()
    man = _manifest(vault)
    groups, index = [], {}
    for r in recs:
        if not isinstance(r, dict):
            continue
        cat = _recipe_category(r, man) if man else "recipes"
        rlane = _text(r.get("lang")).strip() or doclang or lane
        label = _text(r.get("title")) or _text(r.get("id"))
        cmd = _text(r.get("code"))
        if not (label or cmd):
            continue
        _group_into(groups, index, "recipes", cat,
                    {"id": _item_id("recipes", rlane, label, cmd), "lane": rlane,
                     "category": cat, "label": label, "desc": _text(r.get("description")),
                     "cmd": cmd, "multiline": "\n" in cmd, "kind": "code",
                     "placeholders": _placeholders(cmd, r.get("inputs"))})
    order = (man or {}).get("order") or []
    rank = {name: i for i, name in enumerate(order)}
    groups.sort(key=lambda g: (rank.get(g["name"], len(rank)),))
    return groups


def _dict_groups(lane):
    groups, index = [], {}
    kgroups, kindex = [], {}
    for r in _cheat_rows():
        rlane = _text(r.get("lane")).strip()
        low = rlane.lower()
        if low != lane and low not in SHARED_LANES:
            continue
        label, cmd = _text(r.get("label")), _text(r.get("cmd"))
        if not (label or cmd):
            continue
        cat = _text(r.get("category")).strip() or "other"
        if _text(r.get("kind")).strip().lower() == "keys":
            _group_into(kgroups, kindex, "keys", cat,
                        {"id": _item_id("keys", rlane or lane, label, cmd),
                         "lane": rlane or lane, "category": cat, "label": label,
                         "desc": _text(r.get("desc")), "cmd": cmd,
                         "multiline": False, "kind": "keys", "placeholders": []})
            continue
        _group_into(groups, index, "dictionary", cat,
                    {"id": _item_id("dictionary", rlane or lane, label, cmd),
                     "lane": rlane or lane, "category": cat, "label": label,
                     "desc": _text(r.get("desc")), "cmd": cmd,
                     "multiline": "\n" in cmd, "kind": "code",
                     "placeholders": _placeholders(cmd, r.get("inputs"))})
    return groups + kgroups


def dictionary(vault, lane=None):
    """One lane's dictionary: recipes first, then the cheat rows, then the editor keys
    (every lane gets the same keys; they are the lane-less `kind: keys` rows). Cached on the three
    source mtimes, so a second open costs a dict lookup and a 304."""
    lane = (lane or "").strip().lower()
    if lane not in DICT_LANES:
        return {"ok": False, "error": "unknown lane"}
    key = (str(vault), str(cheat_path()), _mtns(cheat_path()),
           _mtns(recipes_dir(vault) / ("%s.json" % lane)),
           _mtns(recipes_dir(vault) / "manifest.json"))
    hit = _DICTVIEW.get(lane)
    if hit and hit[0] == key:
        return hit[1]
    body = {"ok": True, "stamp": "%x-%x-%x" % key[2:], "lane": lane,
            "groups": _recipe_groups(vault, lane) + _dict_groups(lane)}
    _DICTVIEW[lane] = (key, body)
    return body


_BOLD_RE = re.compile(r"^\*\*(.+?)\*\*$")
_ITAL_RE = re.compile(r"^\*(.+?)\*$|^_(.+?)_$")
_SPAN_RE = re.compile(r"^(.*?)[\s]*[\(\[]\s*(.+?)\s*[\)\]]\s*$")
_PAIR_PRIMARY = re.compile(r"(?:^|\s+)(OR|B|Coef\.?|Est\.?|Estimate|b)\s*$", re.I)
_PAIR_SECOND = re.compile(r"(?:^|\s+)(CI|SE|S\.E\.?|95%?\s*CI)\s*$", re.I)
_STACK = "\x01"


def _emphasis(cell):
    c = (cell or "").strip()
    m = _BOLD_RE.match(c)
    if m:
        return m.group(1).strip(), True, False
    m = _ITAL_RE.match(c)
    if m:
        return (m.group(1) or m.group(2)).strip(), False, True
    return c, False, False


def _stub_level(raw):
    stripped = (raw or "").lstrip(" ")
    return (len(raw or "") - len(stripped)) // 2


def _merge_ci_columns(headers, rows):
    n = len(headers)
    pair_at, j = {}, 1
    while j + 1 < n:
        h1, h2 = headers[j], headers[j + 1]
        if (_PAIR_PRIMARY.search(h1) and _PAIR_SECOND.search(h2)
                and _PAIR_PRIMARY.sub("", h1).strip().lower()
                == _PAIR_SECOND.sub("", h2).strip().lower()):
            pair_at[j] = j + 1
            j += 2
        else:
            j += 1
    if not pair_at:
        return headers, rows
    new_headers, keep, k = [headers[0]], [], 1
    while k < n:
        new_headers.append(_PAIR_PRIMARY.sub("", headers[k]).strip() if k in pair_at
                           else headers[k])
        keep.append(k)
        k += 2 if k in pair_at else 1
    out_rows = []
    for r in rows:
        r = list(r) + [""] * (n - len(r))
        row = [r[0]]
        for idx in keep:
            if idx in pair_at:
                est, sec = r[idx].strip(), r[pair_at[idx]].strip()
                row.append(est + (_STACK + sec if sec else ""))
            else:
                row.append(r[idx])
        out_rows.append(row)
    return new_headers, out_rows


def _spanner(headers):
    """([(group, span)], [sub]) when every value header is 'Group (Sub)' with contiguous
    repeated groups, else None."""
    vals = headers[1:]
    if len(vals) < 2:
        return None
    parsed = []
    for h in vals:
        m = _SPAN_RE.match((h or "").strip())
        if not m:
            return None
        parsed.append((m.group(1).strip(), m.group(2).strip()))
    groups, subs = [], []
    for g, s in parsed:
        subs.append(s)
        if groups and groups[-1][0] == g:
            groups[-1] = (g, groups[-1][1] + 1)
        else:
            groups.append((g, 1))
    if len(groups) == len(vals):
        return None
    if len(groups) == 1 and len(set(subs)) == 1:
        return None
    return groups, subs


def _columns(headers):
    span = _spanner(headers)
    if not span:
        return [{"key": h, "label": h, "group": None} for h in headers[1:]]
    groups, subs = span
    flat = []
    for g, width in groups:
        flat += [g] * width
    return [{"key": headers[i + 1], "label": subs[i], "group": flat[i]}
            for i in range(len(subs))]


def _cell(v):
    txt, _, _ = _emphasis(v)
    return txt or None


def _parse_rows(headers, raw_rows):
    """-> [{stub, level, kind, cells}]. kind: 'panel' (a heading row, every cell empty),
    'sub' (a stacked SE/CI line, empty stub) or 'row'."""
    n = len(headers) - 1
    out = []
    for raw in raw_rows:
        cells_raw = list(raw) + [""] * (len(headers) - len(raw))
        stub_raw = cells_raw[0]
        vals = [(c or "").strip() for c in cells_raw[1:1 + n]]
        label, _, _ = _emphasis(stub_raw.strip())
        level = _stub_level(stub_raw)
        all_empty = all(v == "" for v in vals)
        if label == "" and not all_empty:
            kind = "sub"
        elif all_empty and label != "":
            kind = "panel"
        else:
            kind = "row"
        prim = [v.split(_STACK)[0] if _STACK in v else v for v in vals]
        secs = [v.split(_STACK, 1)[1] if _STACK in v else "" for v in vals]
        out.append({"stub": label, "level": level, "kind": kind,
                    "cells": [_cell(v) for v in prim]})
        if any(s for s in secs):
            # the CI/SE line the merged column carried: its own row, empty stub, one
            # size down in the render.
            out.append({"stub": "", "level": level, "kind": "sub",
                        "cells": [_cell(s) for s in secs]})
    return out


_NOTES = {"key": None, "map": None}


def _notes_for(proj, stem):
    fn = fignotes.notes(proj, stem)
    if fn:
        return [p[:600] for p in fn["paragraphs"][:6]]
    p = proj / "results" / "0.figure_notes.md"
    try:
        key = (str(p), p.stat().st_mtime_ns)
    except OSError:
        return []
    if _NOTES["key"] != key:
        sections, cur, buf = {}, None, []
        try:
            text = p.read_text(encoding="utf-8", errors="replace")
        except OSError:
            text = ""
        for line in text.splitlines():
            if line.startswith("## "):
                if cur:
                    sections[cur] = buf
                cur, buf = line[3:].strip(), []
            elif cur:
                buf.append(line)
        if cur:
            sections[cur] = buf
        _NOTES.update(key=key, map=sections)
    lines = (_NOTES["map"] or {}).get(stem) or []
    paras, cur = [], []
    for ln in lines:
        if ln.strip():
            cur.append(ln.strip())
        elif cur:
            paras.append(" ".join(cur))
            cur = []
    if cur:
        paras.append(" ".join(cur))
    return [p[:600] for p in paras[:6]]


def _csv_shape(path):
    """(rows, cols) without holding the file in memory. Cached by mtime+size, because
    the tables menu re-reads the same directory on every poll."""
    try:
        st = path.stat()
    except OSError:
        return None, None
    key = (str(path), st.st_mtime_ns, st.st_size)
    hit = _SHAPES.get(key)
    if hit:
        return hit
    rows = cols = 0
    try:
        with open(path, "r", encoding="utf-8", errors="replace", newline="") as fh:
            for i, r in enumerate(csv.reader(fh)):
                if i == 0:
                    cols = len(r)
                elif r:
                    rows += 1
                if i > 50000:
                    break
    except OSError:
        return None, None
    if len(_SHAPES) > 400:
        _SHAPES.clear()
    _SHAPES[key] = (rows, cols)
    return rows, cols


_SHAPES = {}
_TABLES_CACHE = {}


def _is_paper(proj):
    return "papers" in {p.name for p in Path(proj).parents}


def _has_pdf(proj, path, stem, paper):
    """Cheap availability only: an existing sibling PDF, or a paper project where
    _table_pdf_stale says one is buildable from this CSV. Nothing is built here."""
    if path.with_suffix(".pdf").exists():
        return True
    if not paper:
        return False
    try:
        return bool(drafting._table_pdf_stale(Path(proj), stem))
    except Exception:
        return False


PUSHED_MAX = 12                        # the newest handful, never a history
PUSHED_MAX_AGE = 7 * 24 * 3600         # a week; older scratch is not news


def _pushed_rows(session=None, project=None):
    """tables/*.json, addressed the way the emitters stamp them."""
    ring, _ = _snapshot()
    by_id = {e["id"]: e for e in ring if e.get("kind") == "table" and e.get("id")}
    want = explore._kebab(project or "") if project else ""
    cutoff = time.time() - PUSHED_MAX_AGE
    out = []
    try:
        entries = [e for e in os.scandir(state_dir() / "tables")
                   if e.is_file() and e.name.endswith(".json")]
    except OSError:
        return out
    for e in entries:
        tid = e.name[:-5]
        if not explore.ID_RE.match(tid):
            continue
        d = _read_json(e.path) or {}
        ev = by_id.get(tid) or {}
        mtime = e.stat().st_mtime
        ts = d.get("ts")
        if (ts if isinstance(ts, (int, float)) else mtime) < cutoff:
            continue
        if session:
            if (d.get("session") or ev.get("session")) != session:
                continue
        elif want:
            if explore._kebab(d.get("project") or ev.get("project") or "") != want:
                continue
        shape = d.get("shape") or [None, None]
        out.append({"name": tid, "rel": "tables/%s.json" % tid, "group": "pushed",
                    "mtime": round(mtime, 3),
                    "rows": shape[0] if len(shape) > 0 else None,
                    "cols": shape[1] if len(shape) > 1 else None,
                    "hasPdf": False, "id": tid,
                    "title": d.get("title") or ev.get("title")})
    out.sort(key=lambda r: -(r["mtime"] or 0))
    return out[:PUSHED_MAX]


def _project_name(proj):
    """The name the board addresses a project by: the folder without the live-paper
    prefix, which is what the emitters slug into a pushed table's `project`."""
    name = Path(proj).name
    return name[len(explore.PROJECT_PREFIX):] \
        if name.startswith(explore.PROJECT_PREFIX) else name


def tables(vault, slug=None, session=None):
    """{ok, stamp, tables} -- this project's tables, then anything pushed by the REPL."""
    if not slug:
        loose = _pushed_rows(session)
        return {"ok": True, "stamp": _stamp_of(loose), "tables": loose}
    proj = explore.project_root(vault, slug)
    if proj is None:
        return {"ok": False, "error": "unknown project", "slug": slug}
    pushed = _pushed_rows(session, None if session else _project_name(proj))
    res, sup = proj / "results", proj / "results" / "supplementary"
    key = (str(proj), _mt(res), _mt(sup), session or "", _stamp_of(pushed))
    hit = _TABLES_CACHE.get(key)
    if hit is not None:
        return hit

    paper = _is_paper(proj)
    groups = {"results": [], "supplementary": [], "output": []}
    for d, base in ((res, "results"), (sup, "results/supplementary")):
        try:
            entries = [e for e in os.scandir(d) if e.is_file() and e.name.endswith(".csv")]
        except OSError:
            continue
        for e in entries:
            stem = e.name[:-4]
            if not STEM_RE.match(stem):
                continue
            p = Path(e.path)
            rows, cols = _csv_shape(p)
            g = ("supplementary" if base != "results" else "results") \
                if stem.startswith("tab.") else "output"
            groups[g].append({
                "name": stem, "rel": "%s/%s" % (base, e.name), "group": g,
                "mtime": round(e.stat().st_mtime, 3), "rows": rows, "cols": cols,
                "hasPdf": _has_pdf(proj, p, stem, paper)})
    out = []
    for g in ("results", "supplementary", "output"):
        out += sorted(groups[g], key=lambda r: -(r["mtime"] or 0))
    out += pushed
    res_obj = {"ok": True, "slug": slug, "stamp": _stamp_of(out), "tables": out}
    if len(_TABLES_CACHE) > 32:
        _TABLES_CACHE.clear()
    _TABLES_CACHE[key] = res_obj
    return res_obj


def _stamp_of(obj):
    return hashlib.sha1(repr(obj).encode("utf-8")).hexdigest()[:16]


def _fmt_number(v):
    """Pushed cells only. Ints stay ints; a float gets at most four decimals, because a
    viewer that prints 0.30000000000000004 is a viewer nobody trusts."""
    if v is None:
        return None
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, int):
        return str(v)
    if isinstance(v, float):
        if v != v or v in (float("inf"), float("-inf")):
            return None
        if abs(v) >= 1e-4 and abs(v) < 1e15:
            s = ("%.4f" % v).rstrip("0").rstrip(".")
            return s if s not in ("", "-") else "0"
        return "%.4g" % v
    s = str(v).strip()
    return s or None


def _pushed_table(tid):
    p = _pushed_file(tid)
    if p is None:
        return {"ok": False, "error": "unknown table id"}
    d = _read_json(p)
    if not isinstance(d, dict) or d.get("v") != 1:
        return {"ok": False, "error": "unreadable pushed table"}
    cols = [str(c) for c in (d.get("columns") or [])]
    index = list(d.get("index") or [])
    raw = d.get("rows") or []
    rows = []
    for i, r in enumerate(raw[:TABLE_ROW_CAP]):
        stub = str(index[i]) if i < len(index) and index[i] is not None else ""
        cells = [_fmt_number(v) for v in (list(r) + [None] * len(cols))[:len(cols)]]
        rows.append({"stub": stub, "level": 0, "kind": "row", "cells": cells})
    shape = d.get("shape") or [len(raw), len(cols)]
    return {"ok": True, "name": tid, "title": d.get("title") or tid, "group": "pushed",
            "stubLabel": "", "columns": [{"key": c, "label": c, "group": None} for c in cols],
            "rows": rows, "notes": [], "png": None,
            "shape": [shape[0], shape[1]] if len(shape) > 1 else [len(raw), len(cols)],
            "truncated": bool(d.get("truncated")) or len(raw) > TABLE_ROW_CAP}


def table(vault, slug=None, name=None, tid=None):
    if tid:
        if not explore.ID_RE.match(tid):
            return {"ok": False, "error": "bad table id"}
        return _pushed_table(tid)
    if not name or not STEM_RE.match(name):
        return {"ok": False, "error": "bad table name"}
    if not slug:
        return {"ok": False, "error": "slug is required"}
    proj = explore.project_root(vault, slug)
    if proj is None:
        return {"ok": False, "error": "unknown project"}
    path, group = _project_table_csv(proj, name)
    if path is None:
        return {"ok": False, "error": "no such table in this project"}
    if not name.startswith("tab."):
        group = "output"
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return {"ok": False, "error": "table is unreadable"}
    # skipinitialspace stays False: the stub's leading spaces ARE the hierarchy.
    all_rows = [r for r in csv.reader(text.splitlines()) if r]
    if len(all_rows) < 2:
        return {"ok": False, "error": "table needs a header and a data row"}
    headers, body = all_rows[0], all_rows[1:]
    wide = [i + 2 for i, r in enumerate(body) if len(r) > len(headers)]
    if wide:
        # the unquoted-comma signature: every value past it sits under the wrong column.
        # table_to_latex refuses to render this and so does the pane.
        return {"ok": False, "error": "row %d is wider than the %d-column header"
                % (wide[0], len(headers))}
    headers, body = _merge_ci_columns(headers, body)
    rows = _parse_rows(headers, body)
    truncated = len(rows) > TABLE_ROW_CAP
    paper = _is_paper(proj)
    png = None
    if _has_pdf(proj, path, name, paper):
        png = "/drafting/table-png?slug=%s&name=%s" % (quote(slug), quote(name + ".pdf"))
    cols = _columns(headers)
    return {"ok": True, "name": name, "title": name, "group": group,
            "stubLabel": (headers[0] or "").strip(),
            "columns": cols, "rows": rows[:TABLE_ROW_CAP],
            "notes": _notes_for(proj, name), "png": png,
            "shape": [len(body), len(cols)], "truncated": truncated}


PDF_MAX = 256 * 1024 * 1024
_DOC_SKIP = {"archive", "archives", "_archive", "_retired", "old", "tests", "test",
             "__pycache__", "node_modules", "build"}
_DOC_WALK_CAP = 400         # PDFs read from one directory tree, at most
_DOCS_TTL = 120.0
_DOCS = {}
_DOCS_LOCK = threading.Lock()


def _pdf_under(base, rel):
    r = (rel or "").replace("\\", "/").strip()
    if not r or CTRL_RE.search(r):
        return None, (400, "bad path")
    if r.startswith(("/", "~")) or re.match(r"^[A-Za-z]:", r):
        return None, (400, "an absolute path is refused")
    parts = [x for x in r.split("/") if x]
    if any(x == ".." for x in parts):
        return None, (400, "bad path")
    if any(x.startswith(".") for x in parts):
        return None, (400, "bad path")
    if not r.lower().endswith(".pdf"):
        return None, (400, "not a pdf")
    try:
        root = Path(base).resolve()
        p = (root / "/".join(parts)).resolve()
        inner = p.relative_to(root)
    except (OSError, ValueError, RuntimeError):
        return None, (403, "outside the allowed folder")
    if any(x.startswith(".") for x in inner.parts) or p.suffix.lower() != ".pdf":
        return None, (403, "outside the allowed folder")
    try:
        if not p.is_file():
            return None, (404, "no such pdf")
        st = p.stat()
        if st.st_size <= 0 or st.st_size > PDF_MAX:
            return None, (400, "not a readable pdf")
        with open(p, "rb") as fh:
            head = fh.read(1024)
    except OSError:
        return None, (404, "no such pdf")
    if b"%PDF-" not in head:
        return None, (400, "not a pdf")
    return p, None


def pdf_path(vault, hub_rel=None, project=None, rel=None):
    """A hub document by its hub-relative path, or a project's PDF by (project, rel)."""
    if hub_rel:
        return _pdf_under(hub_dir(vault), hub_rel)
    if project and rel:
        proj = explore.project_root(vault, project)
        if proj is None:
            return None, (404, "unknown project")
        return _pdf_under(proj, rel)
    return None, (400, "a pdf needs hub_rel, or project and rel")


def pdf_request(vault, q):
    """The /w/panel/pdf query -> (path, stamp, None) or (None, None, (code, reason))."""
    def one(k):
        return (q.get(k) or [""])[0]
    p, why = pdf_path(vault, one("hub_rel").strip() or None,
                      one("project").strip() or None, one("rel").strip() or None)
    if p is None:
        return None, None, why
    return p, _pdf_stamp(p), None


def _pdf_stamp(p):
    try:
        st = p.stat()
        return "%x-%x" % (st.st_mtime_ns, st.st_size)
    except OSError:
        return ""


def _hub_rel_of(vault, p):
    try:
        return str(Path(p).relative_to(hub_dir(vault).resolve())).replace(os.sep, "/")
    except ValueError:
        return None


def _walk_pdfs(root):
    """Every PDF under `root`, sorted, skipping archive/tests copies and dot-dirs.
    Cached for a couple of minutes."""
    key = str(root)
    now = time.time()
    with _DOCS_LOCK:
        hit = _DOCS.get(key)
        if hit and now - hit[0] < _DOCS_TTL:
            return hit[1]
    out = []
    for dirpath, dirnames, filenames in os.walk(str(root)):
        dirnames[:] = sorted(d for d in dirnames
                             if not d.startswith(".") and d.lower() not in _DOC_SKIP
                             and not d.lower().startswith("_tmp"))
        for f in sorted(filenames):
            if f.lower().endswith(".pdf") and not f.startswith("."):
                out.append(Path(dirpath) / f)
                if len(out) >= _DOC_WALK_CAP:
                    break
        if len(out) >= _DOC_WALK_CAP:
            break
    with _DOCS_LOCK:
        _DOCS[key] = (now, out)
    return out


def _doc(vault, p):
    """A listed document: its hub-relative path (what /w/panel/pdf takes), a name, size
    and stamp. None when it fails the same confinement the route serves with."""
    hr = _hub_rel_of(vault, Path(p).resolve()) if Path(p).exists() else None
    if not hr:
        return None
    q, why = _pdf_under(hub_dir(vault), hr)
    if q is None:
        return None
    return {"hub_rel": hr, "name": q.stem, "bytes": q.stat().st_size, "v": _pdf_stamp(q)}


def _docs_group(vault, gid, label, paths, seen):
    docs = []
    for p in paths:
        d = _doc(vault, p)
        if d and d["hub_rel"] not in seen:
            seen.add(d["hub_rel"])
            docs.append(d)
    return {"id": gid, "label": label, "docs": docs}


def codebooks(vault, family=None, key=None, path=None):
    if path and not (family and key):
        p, _why = resolve_data_path(vault, path)
        hit = catalog_key_for(vault, p) if p is not None else None
        if hit:
            family, key = hit
    if not family or not key:
        return {"ok": True, "family": family or "", "key": key or "", "groups": []}
    entry, why = _catalog_entry(vault, family, key)
    if entry is None:
        return {"ok": False, "error": why, "family": family, "key": key, "groups": []}
    if not FAMILY_RE.match(family):
        return {"ok": False, "error": "bad family", "family": family, "key": key, "groups": []}
    hub = hub_dir(vault)
    try:
        famdir = (hub / family).resolve()
        inside = famdir.is_relative_to(hub.resolve())
    except OSError:
        inside = False
    if not inside:
        return {"ok": False, "error": "bad family", "family": family, "key": key, "groups": []}
    seen = set()
    allp = _walk_pdfs(famdir)
    k = key.lower()
    own = [p for p in allp if k in p.stem.lower()]
    fam = [p for p in allp if k not in p.stem.lower()]
    groups = [_docs_group(vault, "dataset", "This dataset", own, seen),
              _docs_group(vault, "family", "Family", fam, seen)]
    return {"ok": True, "family": family, "key": key,
            "groups": [g for g in groups if g["docs"]]}


# -------------------------------------------------------------------- dispatch
def handle_get(vault, path, q, port=None):
    """-> (code, body, no_store). serve.py owns the transport; this owns the answer.
    Nothing raises out of here: a missing datasets.db or a malformed CSV is an ok:false
    with a short reason, never a 500 that takes the pane down with it."""
    def one(k):
        return (q.get(k) or [""])[0].strip()

    try:
        if path == "/w/panel/events":
            raw = (q.get("since") or [""])[0].strip()
            try:
                since = int(raw) if raw else None
            except ValueError:
                since = None
            sess = one("session") or None
            if sess and SESSION_RE.match(sess):
                _saw_pane(sess)
            return 200, events(sess, since), True

        if path == "/w/panel/pane":
            sess = one("session")
            if not sess or not SESSION_RE.match(sess):
                return 400, {"ok": False, "error": "bad session"}, True
            return 200, pane_state(sess), True

        if path == "/w/panel/dataset":
            res = dataset(vault, one("family") or None, one("key") or None,
                          one("frame") or None, one("path") or None)
            return (200 if res.get("ok") else 404), res, False

        if path == "/w/panel/variable":
            res = variable(vault, one("family") or None, one("key") or None,
                           one("frame") or None, one("name") or None,
                           one("path") or None)
            return (200 if res.get("ok") else 404), res, False

        if path == "/w/panel/datasets":
            return 200, datasets(vault, one("session") or None), False

        if path == "/w/panel/catalog":
            res = catalog(vault)
            return (200 if res.get("ok") else 404), res, False

        if path == "/w/panel/scope":
            # cached and ETag'd by serve.py's _send_payload; `stamp` is a hash of the
            # body, so an unchanged scope is an unchanged ETag and a 304.
            res = scope(vault, one("project") or None, one("family") or None)
            return (200 if res.get("ok") else 404), res, False

        if path == "/w/panel/dictionary":
            res = dictionary(vault, one("lane"))
            return (200 if res.get("ok") else 400), res, False

        if path == "/w/panel/tables":
            res = tables(vault, one("slug") or None, one("session") or None)
            return (200 if res.get("ok") else 404), res, False

        if path == "/w/panel/table":
            res = table(vault, one("slug") or None, one("name") or None,
                        one("id") or None)
            return (200 if res.get("ok") else 404), res, False

        if path == "/w/panel/codebooks":
            res = codebooks(vault, one("family") or None, one("key") or None,
                            one("path") or None)
            return (200 if res.get("ok") else 404), res, False

        if path == "/w/panel/event":
            return 405, {"ok": False, "error": "POST only"}, False
    except Exception as e:
        return 200, {"ok": False, "error": "panel: %s" % _scrub(e)}, False
    return 404, {"ok": False, "error": "unknown panel route"}, False


start()
