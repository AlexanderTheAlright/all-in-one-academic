import os
import time
from pathlib import Path

import explore

INTERVAL = 20
RECENT_S = 24 * 3600
_FIG_DIRS = (("results",), ("replication", "exploration", "figures"), ("figures",))


def _projects(vault):
    """[(slug, dir)] for every project folder, in the forms explore.project_root takes."""
    base = Path(vault) / "Projects"
    out = []
    for parent in explore.PROJECT_PARENTS:
        try:
            entries = list(os.scandir(base / parent))
        except OSError:
            continue
        for e in entries:
            if not e.is_dir() or e.name.startswith("."):
                continue
            name = e.name[len(explore.PROJECT_PREFIX):] if e.name.startswith(explore.PROJECT_PREFIX) else e.name
            out.append((name, Path(e.path)))
    return out


def signature(proj):
    """((name, mtime_ns, size), ...) for the PNGs at the top of a project's figure folders,
    and the newest mtime among them (seconds; 0 when there are none)."""
    rows, newest = [], 0.0
    for parts in _FIG_DIRS:
        d = proj.joinpath(*parts)
        try:
            it = os.scandir(d)
        except OSError:
            continue
        with it:
            for e in it:
                if e.name.startswith(".") or not e.name.lower().endswith(".png"):
                    continue
                try:
                    st = e.stat()
                except OSError:
                    continue
                rows.append(("/".join(parts) + "/" + e.name, st.st_mtime_ns, st.st_size))
                newest = max(newest, st.st_mtime)
    return tuple(sorted(rows)), newest


def scan_once(vault, seen, first=False, now=None):
    """One pass. `seen` maps project dir -> last signature and is updated in place.
    -> the slugs whose previews were queued."""
    now = time.time() if now is None else now
    warmed = []
    for slug, proj in _projects(vault):
        sig, newest = signature(proj)
        key = str(proj)
        old = seen.get(key)
        seen[key] = sig
        if not sig or sig == old:
            continue
        # at start, only what moved lately; after that, any change (or a new project)
        if old is None and first and now - newest > RECENT_S:
            continue
        try:
            explore.project_gallery(vault, slug)   # queues the missing previews
            warmed.append(slug)
        except Exception:
            continue
    return warmed


def run(vault, interval=INTERVAL):
    """The daemon loop serve.py starts. Never raises."""
    seen = {}
    first = True
    while True:
        try:
            scan_once(vault, seen, first=first)
        except Exception:
            pass
        first = False
        time.sleep(interval)
