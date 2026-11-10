#!/usr/bin/env python3
"""Local server for all-in-one-academic."""
import settings
import http.server, os, sys, subprocess, json, re, time, threading, socket
import gzip as _gzip, hashlib as _hashlib, io as _io
import urllib.request
from pathlib import Path
from datetime import date, timedelta, datetime
from urllib.parse import urlparse, parse_qs, quote, unquote
import chunkarchive   # immutable fallback for content-hashed lazy chunks
import kanban
import tasklink     # resolve a task's most-relevant destination (Open reading/draft/note)
import learning
import systems
import explore       # Explore view: the shared exploratory-figure store (Projects/scratch/figures)
import projectplan
import boardproposals
import achievements  # the reflective record: shipped chains/goals/tasks + manuscript pipeline (Insights Archive)
import reading       # reading lists v2: ordered groups, notes, download queue, archive
import syllabi       # syllabi + formatted reading lists: parse, corpus-match, board push
import litinbox
import litcite       # citation metadata (CrossRef/OpenLibrary/OpenAlex) + BibTeX for triage filing
import printbook     # citation notes + page-anchored notes for books owned in print
import openalex      # OpenAlex import: seed a download list (by author / pasted DOIs / topic)
import notes_organizer  # Notes quick-capture (inbox) and filing
import notes_blocks     # Notes: `##` sections as typed blocks + the attachment/diagram store
import all_in_one_academic
import calendar_links   # join links on events: validate a URL, keep the managed `Join:` body line
import ambient
import tagindex      # whole-vault tag index (notes) for the Tag explorer; built by build_cache.py
import drafting
import planning       # commitments ledger + the one commitments reader + the stage pipeline
import outline_pdf    # the outline typeset as a shareable PDF (co-author feedback copy)
import audit_index
import quoteindex     # deterministic quote-integrity index (verdict per quote vs its PDF)
import citationindex  # searchable citation index (built by build_cache.py) for the quote workbench
import semindex
import citeindex      # the compact reference index the citation picker searches in the browser
import references
import numberscheck   # the numbers citation system: prose statistic <-> source CSV cell bindings
import groundcheck    # verbatim quote/page/source-line verification (publish gates + /drafting/verify)
import panel          # /w/figure's Data + Tables panes: the event ring, datasets, tables
import coding

PORT = settings.PORT

PANE_MODE = (os.environ.get("AIOA_BOARD_MODE") or "").strip().lower() == "pane"


def _bg(fn, name):
    """Start a daemon worker -- unless this is the read-only pane, which has none."""
    if PANE_MODE:
        return None
    t = threading.Thread(target=fn, name=name, daemon=True)
    t.start()
    return t


# Every path the pane asks for, and nothing else. GET/HEAD only, except the one
# POST below. Prefixes end in "/", exact paths do not.
_PANE_GET_EXACT = frozenset((
    "/", "/index.html", "/sw.js", "/manifest.webmanifest", "/favicon.ico",
    "/surface", "/theme.css", "/theme.json", "/workflow.json",
    "/explore/figure", "/explore/data", "/explore/comments",
    "/explore/selection",
))
_PANE_GET_PREFIX = ("/w/", "/v/", "/assets/", "/icons/", "/fonts/")
# The bundle is content-hashed chunks at the root; a suffix test keeps the gate
# from having to know their names, and the handler below still owns path safety.
_PANE_STATIC_SUFFIX = (".js", ".css", ".map", ".png", ".svg", ".webp", ".ico",
                       ".woff", ".woff2", ".ttf", ".json", ".txt")
_PANE_REFUSE = ("/explore/comments-save", "/explore/spec-save", "/explore/to-agent",
                "/explore/refetch", "/explore/render", "/explore/index")
# in-memory state only: the event ring and the figure selection
_PANE_POST_OK = ("/w/panel/event", "/w/figure/select", "/explore/select", "/explore/selection")


def pane_allows(method, path):
    """True when the read-only pane may answer this request."""
    if not PANE_MODE:
        return True
    if path in _PANE_REFUSE or any(path.startswith(r + "/") for r in _PANE_REFUSE):
        return False
    if method == "POST":
        return path in _PANE_POST_OK
    if method not in ("GET", "HEAD", "OPTIONS"):
        return False
    if path in _PANE_GET_EXACT:
        return True
    if path.startswith(_PANE_GET_PREFIX):
        return True
    return "/" not in path.lstrip("/") and path.endswith(_PANE_STATIC_SUFFIX)

HERE = settings.STATE_DIR
VAULT = settings.VAULT
READING_VAULT = VAULT / ".vaults" / "Reading"
READING_PREFIX = ("Preparation/Reading/", "Preparation/Notes/Daily/")
VAULT_ID = READING_VAULT.name           # obsidian://open accepts the vault (folder) name


def _chunk_archive_info():
    try:
        state = chunkarchive.status()
        if not isinstance(state, dict):
            raise TypeError("chunk archive status must be an object")
    except Exception:
        state = {"healthy": False, "entries": 0}
    return {**state, "enabled": True, "version": 1}


def _surface_info():
    override = os.environ.get("BOARD_SURFACE")
    if override:
        machine = override.lower().strip()
    else:
        machine = settings.SURFACE
    return {
        "machine": machine,
        "webFonts": settings.WEB_FONTS,
        "hostname": socket.gethostname(),
        "canEdit": machine == "host",
        "chunkArchive": _chunk_archive_info(),
        "vault": str(VAULT),
        "pid": os.getpid(),
        "port": PORT,
        **_identity_fields(),
        "bundle": _bundle_identity(),
    }


def _identity_fields():
    """The served artifacts' identities, flat, for anything asking which build is served."""
    out = {}
    b = _file_identity(settings.WEB_DIST / "index.html")
    if b:
        out.update(bundle_md5=b["md5"], bundle_bytes=b["bytes"],
                   bundle_mtime=b["mtime"], bundle_age_sec=b["ageSec"])
    w = _file_identity(settings.WEB_DIST / "sw.js")
    if w:
        out.update(sw_md5=w["md5"], sw_bytes=w["bytes"],
                   sw_mtime=w["mtime"], sw_age_sec=w["ageSec"])
    try:
        rows = []
        for f in sorted(settings.WEB_DIST.glob("*.js")) + sorted(settings.WEB_DIST.glob("*.css")):
            if f.name == "sw.js":
                continue                      # already its own field above
            fid = _file_identity(f)
            if fid:
                rows.append({"name": f.name, "md5": fid["md5"], "bytes": fid["bytes"]})
            if len(rows) >= 50:
                break
        _check_immutable_chunks(rows)
        out["chunks"] = rows
        out["chunks_md5"] = _hashlib.md5(
            "".join(r["name"] + r["md5"] for r in rows).encode()).hexdigest()
    except Exception:
        pass
    return out


def _home_path(p):
    return drafting._home_form(p)


BACKUP = HERE / "board-last.bak.md"
DAILY_BACKUP = HERE / "daily-last.bak.md"   # daily-note writes get their OWN backup
settings.WEB_DIST.mkdir(parents=True, exist_ok=True)
os.chdir(str(settings.WEB_DIST))

PLANNING_BOARD_DEFAULT = (
    "---\n\nkanban-plugin: board\n\n---\n\n"
    "## INBOX\n\n\n"
    "## BACKLOG\n\n\n"
    "## TODAY\n\n\n"
    "## DONE\n\n\n"
    "***\n\n"
    "## Archive\n\n\n"
    "%% kanban:settings\n"
    "```\n"
    '{"kanban-plugin":"board","list-collapse":[false,false,false,false]}\n'
    "```\n"
    "%%\n"
)

# only these board files may be read/edited through the API
TASKS_BOARD_REL = settings.TASKS_BOARD_REL.replace("\\", "/").strip("/")
BOARD_OK = re.compile(r"^(" + re.escape(TASKS_BOARD_REL)
                      + r"|Projects/papers/" + settings.LIVE_PROJECT_RE + r"/PATH\.md)$")
ISO_DATE = re.compile(r"\b(20\d{2}-\d{2}-\d{2})\b")
LEAD_DATE = re.compile(r"^\s*(20\d{2}-\d{2}-\d{2})\b")


def card_due(c):
    """The card's REAL due date, or None."""
    due = (c.get("due") or "").strip()
    if due:
        return due if ISO_DATE.fullmatch(due) else None
    m = LEAD_DATE.match(c.get("text") or "")
    return m.group(1) if m else None

# Full Calendar event directories (mirrors plugin data.json)
EVENT_DIRS = [
    ("meetings",     "#4a90d9"),
    ("seminars",     "#7c3aed"),
    ("deadlines",    "#dc2626"),
    ("birthdays",    "#db2777"),
    ("holidays",     "#0d9488"),
    ("social",       "#16a34a"),
    ("teaching",     "#ea580c"),
    ("conferences",  "#0891b2"),
    ("travel",       "#a16207"),
]
EVENTS_ROOT = VAULT / "Preparation" / "Calendar" / "events"
DAILY_ROOT = VAULT / "Preparation" / "Notes" / "Daily"
DAILY_TEMPLATE = DAILY_ROOT / "Journal Template.md"
GOALS_FILE = VAULT / settings.GOALS_REL

# reading-list v2 mutation ops dispatched to the reading module (POST /reading/<op>)
READING_OPS = {"toggle", "add", "item/edit", "item/download", "item/requeue",
               "item/add", "item/delete",
               "item/move", "group/reorder", "group/add", "group/rename", "group/note",
               "group/delete", "list/note", "list/create", "list/rename", "list/archive",
               "list/restart", "list/delete", "item/make-citation",
               "queue/add", "list/to-queue", "queue/to-list",
               "item/next", "next/reorder", "item/due", "group/due"}
CLIPPINGS_DIR = VAULT / "Preparation" / "Reading" / "Clippings"
CITATIONS_DIR = VAULT / "Preparation" / "Reading" / "Citations"
LEARNING_ROOT = VAULT / "Preparation" / "Learning"
SYSTEMS_ROOT = VAULT / str(settings.get("systems_dir", "Planning/Systems"))   # systems.py confines every path here
CANON_FILE = VAULT / "Preparation" / "Notes" / "Canon.md"
DAY3 = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]   # index = date.weekday()
DAILY_NAME_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})(?:\s*\(\d+\))?\.md$")
GOAL_LINE_RE = re.compile(r"^- \[([ xX])\]\s+(\d{4}-\d{2}-\d{2})\s*[—\-:]\s*(.+?)\s*$")
HABIT_KEYS = list(settings.HABITS)
HABIT_TRACKING_START = str(settings.get("habit_tracking_start", "1970-01-01"))


# ------------------------------------------------------------- helpers (fs)
def board_path(rel):
    """Resolve a vault-relative board path, or None if not whitelisted/inside vault."""
    rel = (rel or "").replace("\\", "/").strip()
    if not BOARD_OK.match(rel):
        return None
    p = (VAULT / rel).resolve()
    try:
        p.relative_to(VAULT.resolve())
    except ValueError:
        return None
    return p if p.exists() else None


def read_text(p):
    try:
        return p.read_text(encoding="utf-8")
    except OSError:
        return None


def write_board(p, old, new):
    """Last-good backup, then atomic temp+replace so a failed write can't leave
    the board half-written."""
    try:
        BACKUP.write_text(old, encoding="utf-8")
    except OSError:
        pass
    tmp = p.with_suffix(".md.tmp")
    tmp.write_text(new, encoding="utf-8")
    os.replace(str(tmp), str(p))


def _atomic_write(p, text):
    tmp = p.with_name(p.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(str(tmp), str(p))


# ------------------------------------------------------------- frontmatter
_FM_KV = re.compile(r"^([A-Za-z_][\w\-]*)\s*:\s*(.*)$")


def parse_frontmatter(text):
    """Tiny YAML-ish frontmatter parser — enough for Full Calendar event files.
    Handles scalars, quoted strings, ISO dates/times, and ignores nested blocks."""
    if not text or not text.startswith("---"):
        return {}
    end = text.find("\n---", 3)
    if end < 0:
        return {}
    out = {}
    current_list = None
    for ln in text[3:end].splitlines():
        ln = ln.rstrip()
        stripped = ln.strip()
        if current_list and stripped.startswith("-"):
            out[current_list].append(stripped[1:].strip().strip('"\''))
            continue
        current_list = None
        if not ln or ln.startswith("#") or ln.startswith("-") or ln.startswith(" "):
            continue
        m = _FM_KV.match(ln)
        if not m:
            continue
        k, v = m.group(1), m.group(2).strip()
        if v.startswith('"') and v.endswith('"'):
            v = v[1:-1]
        elif v.startswith("'") and v.endswith("'"):
            v = v[1:-1]
        if v == "":
            out[k] = []
            current_list = k
            continue
        if v.startswith("[") and v.endswith("]"):
            v = [x.strip().strip('"\'') for x in v[1:-1].split(",") if x.strip()]
        elif v == "null":
            v = None
        elif v in ("true", "false"):
            v = (v == "true")
        out[k] = v
    return out


# ------------------------------------------------------------- board scan
PAPERS = VAULT / "Projects" / "papers"
_scan = {"t": 0.0, "data": None}


PLANNING_BOARD_FILE = VAULT / TASKS_BOARD_REL


def ensure_planning_board():
    p = PLANNING_BOARD_FILE
    text = read_text(p) if p.exists() else None
    if text and kanban.get_board(text)["lanes"]:
        return text   # already a valid board with lanes
    try:
        if text:
            (HERE / "tasks-last.bak.md").write_text(text, encoding="utf-8")
    except OSError:
        pass
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".md.tmp")
    tmp.write_text(PLANNING_BOARD_DEFAULT, encoding="utf-8")
    os.replace(str(tmp), str(p))
    return PLANNING_BOARD_DEFAULT


def all_boards():
    out = [PLANNING_BOARD_FILE]
    if PAPERS.is_dir():
        for d in sorted(PAPERS.iterdir()):
            b = d / "PATH.md"
            if d.is_dir() and settings.live_slug(d.name) and b.exists():
                out.append(b)
    return out


_PLACEHOLDER_CARD = re.compile(r"\(\s*(?:none|empty|n/?a)\b[^)]*\)\s*$", re.I)


def _strip_placeholder_cards(board):
    for lane in board["lanes"]:
        lane["cards"] = [c for c in lane["cards"]
                         if c["done"] or not _PLACEHOLDER_CARD.fullmatch(c["text"].strip())]
    return board


def scan_boards():
    now = time.time()
    if _scan["data"] is not None and now - _scan["t"] < 30:
        return _scan["data"]
    out = []
    for p in all_boards():
        text = read_text(p)
        if text is None:
            continue
        rel = str(p.relative_to(VAULT)).replace("\\", "/")
        planning_board = p == PLANNING_BOARD_FILE
        name = "Planning" if planning_board else settings.strip_prefix(p.parent.name)
        try:
            mtime = p.stat().st_mtime
        except OSError:
            mtime = 0
        out.append({"name": name, "path": rel, "isPlanning": planning_board,
                    "mtime": mtime, "board": _strip_placeholder_cards(kanban.get_board(text))})
    _scan["data"], _scan["t"] = out, now
    return out


def invalidate_scan():
    _scan["data"] = None
    # the tag cloud is built from this scan, so it is stale too (defined further
    # down; a call before the precompute block is imported is simply a no-op)
    try:
        _pre_dirty("tags")
    except NameError:
        pass


def _active_project_tags():
    try:
        plans = projectplan.list_plans(("finalized", "proposed"))
    except Exception:
        return []
    out = []
    for p in plans:
        t = (p.get("tag") or "").strip().lstrip("#").lower()
        if t and t not in out:
            out.append(t)
    return out


def _norm_card_key(s):
    """Tag/date-insensitive key for deduping a card across boards (drop #tags + @tokens)."""
    return re.sub(r"\s+", " ", re.sub(r"(@\S+|#\S+)", "", s or "")).strip().lower()


# ------------------------------------------------------------- events
_events_cache = {"t": 0.0, "data": None}


import calendar as _calendar

_WEEKDAY = {"MO": 0, "TU": 1, "WE": 2, "TH": 3, "FR": 4, "SA": 5, "SU": 6}


def _nth_weekday(year, month, weekday, n):
    """Date of the nth `weekday` (Mon=0) of (year, month). n>0 from the start,
    n<0 from the end (e.g. -1 = last). Returns None if it doesn't exist."""
    first_wd, days_in = _calendar.monthrange(year, month)
    if n > 0:
        day = 1 + (weekday - first_wd) % 7 + (n - 1) * 7
        return date(year, month, day) if day <= days_in else None
    last_wd = (first_wd + days_in - 1) % 7
    day = days_in - (last_wd - weekday) % 7 + (n + 1) * 7
    return date(year, month, day) if day >= 1 else None


def _parse_rrule(s):
    out = {}
    for part in (s or "").split(";"):
        if "=" in part:
            k, v = part.split("=", 1)
            out[k.strip().upper()] = v.strip().upper()
    return out


def _expand_recurrence(base_iso, rrule_str, win_start, win_end):
    try:
        base = date.fromisoformat(base_iso[:10])
    except Exception:
        return [base_iso]
    rr = _parse_rrule(rrule_str)
    freq = rr.get("FREQ", "")
    interval = max(1, int(rr.get("INTERVAL", "1") or 1))
    # UNTIL ends the series (a course's last class); RFC 5545 form, date or date-time
    m = re.match(r"(\d{4})(\d{2})(\d{2})", rr.get("UNTIL", ""))
    if m:
        win_end = min(win_end, date(int(m.group(1)), int(m.group(2)), int(m.group(3))))
    out = []
    if freq == "YEARLY":
        byday = rr.get("BYDAY")
        bymonth = int(rr.get("BYMONTH", base.month))
        for y in range(win_start.year, win_end.year + 1):
            occ = None
            if byday:
                m = re.match(r"(-?\d+)([A-Z]{2})", byday)
                if m and m.group(2) in _WEEKDAY:
                    occ = _nth_weekday(y, bymonth, _WEEKDAY[m.group(2)], int(m.group(1)))
            else:
                try:
                    occ = date(y, base.month, base.day)
                except ValueError:
                    occ = None          # e.g. Feb 29 in a non-leap year
            if occ and win_start <= occ <= win_end:
                out.append(occ.isoformat())
    elif freq in ("WEEKLY", "MONTHLY", "DAILY"):
        cur, guard = base, 0
        while cur <= win_end and guard < 4000:
            guard += 1
            if cur >= win_start:
                out.append(cur.isoformat())
            if freq == "MONTHLY":
                mo = cur.month - 1 + interval
                y, mo = cur.year + mo // 12, mo % 12 + 1
                cur = date(y, mo, min(cur.day, _calendar.monthrange(y, mo)[1]))
            else:
                cur = cur + timedelta(days=(1 if freq == "DAILY" else 7) * interval)
    else:
        out.append(base.isoformat())
    return out


def scan_events():
    now = time.time()
    if _events_cache["data"] is not None and now - _events_cache["t"] < 60:
        return _events_cache["data"]
    out, routine_ids = [], set()
    win_start = date.today() - timedelta(days=400)
    win_end = date.today() + timedelta(days=1100)
    if EVENTS_ROOT.is_dir():
        for sub, color in EVENT_DIRS:
            d = EVENTS_ROOT / sub
            if not d.is_dir():
                continue
            for f in d.iterdir():
                if not f.is_file() or not f.suffix == ".md":
                    continue
                if f.name.startswith("_archive_"):
                    continue
                text = read_text(f)
                if text is None:
                    continue
                fm = parse_frontmatter(text)
                rel = str(f.relative_to(VAULT)).replace("\\", "/")
                title = (fm.get("title") or f.stem).strip()
                # multi-day: endDate (Full Calendar convention) or "to" alias
                end_date = fm.get("endDate") or fm.get("end_date") or fm.get("to") or None
                recurring = str(fm.get("type", "")).lower() == "rrule" or fm.get("rrule")
                if recurring:
                    base = fm.get("startDate") or fm.get("date")
                    if not base:
                        m = re.match(r"^(\d{4}-\d{2}-\d{2})", f.name)
                        base = m.group(1) if m else None
                    if not base:
                        continue
                    dates = _expand_recurrence(base, fm.get("rrule") or "FREQ=YEARLY",
                                               win_start, win_end)
                    # skipDates (Full Calendar's field): holidays, reading week
                    skip = fm.get("skipDates") or []
                    if isinstance(skip, str): skip = [skip]
                    skip = {str(s).strip()[:10] for s in skip}
                    dates = [d for d in dates if str(d)[:10] not in skip]
                    end_date = None     # spans not supported for recurring entries
                else:
                    date_s = fm.get("date")
                    if not date_s:
                        m = re.match(r"^(\d{4}-\d{2}-\d{2})", f.name)
                        date_s = m.group(1) if m else None
                    dates = [date_s] if date_s else []
                tags = fm.get("tags") or []
                if isinstance(tags, str): tags = [tags]
                project = next((t for t in tags if t not in ("calendar", sub, "deadline")), None)
                routine = bool(recurring) and "always" not in tags and \
                    _parse_rrule(fm.get("rrule") or "FREQ=YEARLY").get("FREQ") != "YEARLY"
                for date_s in dates:
                    if routine:
                        routine_ids.add(len(out))
                    out.append({
                        "title": title,
                        "date": date_s,
                        "endDate": end_date,
                        "startTime": fm.get("startTime"),
                        "endTime": fm.get("endTime"),
                        "allDay": bool(fm.get("allDay")) if fm.get("allDay") is not None else (not fm.get("startTime")),
                        "category": sub,
                        "color": color,
                        "path": rel,
                        "recurring": bool(recurring),
                        # Full Calendar task convention: a truthy `completed`
                        # (ISO stamp) means handled; false/null/absent = open
                        "completed": bool(fm.get("completed")),
                        "mode": (str(fm.get("mode") or "").strip().lower() or None),
                        "link": (str(fm.get("link") or "").strip() or None),
                        "tags": tags, "project": project,
                    })
    vacations = [(str(e["date"]), str(e["endDate"] or e["date"])) for e in out
                 if "vacation" in e["tags"] and e["date"]]
    if vacations:
        out = [e for i, e in enumerate(out) if i not in routine_ids
               or not any(a <= str(e["date"]) <= b for a, b in vacations)]
    out.sort(key=lambda e: (e["date"], e["startTime"] or ""))
    _events_cache["data"], _events_cache["t"] = out, now
    return out


def _slug(s):
    return re.sub(r"[^a-z0-9]+", "-", (s or "").lower()).strip("-")


def create_event(data):
    title = (data.get("title") or "").strip()
    date_s = (data.get("date") or "").strip()
    category = (data.get("category") or "").strip().lower()
    if not title:
        return {"error": "title required"}
    if not re.match(r"^\d{4}-\d{2}-\d{2}$", date_s):
        return {"error": "date must be YYYY-MM-DD"}
    valid = {s for s, _ in EVENT_DIRS}
    if category not in valid:
        return {"error": f"unknown category (use one of {sorted(valid)})"}
    repeats = bool(data.get("repeatsYearly"))
    start_t = (data.get("startTime") or "").strip()
    end_t = (data.get("endTime") or "").strip()
    all_day = bool(data.get("allDay", True)) or not start_t
    try:                                       # join link: http/https only, no whitespace
        link = calendar_links.validate_link(data.get("link"))
    except calendar_links.LinkError as exc:
        return {"error": f"link: {exc}"}
    slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")[:50] or "event"
    dest_dir = EVENTS_ROOT / category
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / f"{date_s}_{slug}.md"
    i = 2
    while dest.exists():                       # never overwrite an existing event
        dest = dest_dir / f"{date_s}_{slug}-{i}.md"; i += 1
    try:
        dest.resolve().relative_to(EVENTS_ROOT.resolve())   # path confinement
    except Exception:
        return {"error": "path outside calendar tree"}
    q = title.replace('"', "'")
    lines = ["---", f'title: "{q}"']
    if repeats:
        lines += ["type: rrule", f"startDate: {date_s}", "rrule: FREQ=YEARLY", "allDay: true"]
    elif all_day:
        lines += [f"date: {date_s}", "allDay: true"]
    else:
        lines += [f"date: {date_s}", f'startTime: "{start_t}"']
        if end_t:
            lines.append(f'endTime: "{end_t}"')
        lines.append("allDay: false")
    tags = ["calendar", category]
    project = _slug((data.get("project") or "").strip()) if data.get("project") else None
    if project and project not in tags: tags.append(project)
    lines.append(f"calendarType: {category}")
    if link:                                   # CALLS: mode+link is what scan_events reads
        lines += ["mode: call", f'link: "{link}"']
    lines += ["tags:"] + [f"  - {t}" for t in tags] + ["---", ""]
    body = (data.get("note") or "").strip()
    if link:                                   # and one managed line, so Obsidian shows it too
        body = calendar_links.apply_join_line(body, link)
    if body:
        lines.append(body.rstrip("\n") + "\n")
    tmp = dest.with_suffix(".tmp")
    tmp.write_text("\n".join(lines), encoding="utf-8")
    os.replace(str(tmp), str(dest))
    _events_cache["data"] = None               # show on the next scan immediately
    return {"ok": True, "path": str(dest.relative_to(VAULT)).replace("\\", "/"),
            "category": category, "date": date_s, "repeats": repeats}


def _event_path(rel):
    """Resolve+confine a vault-relative event path to EVENTS_ROOT. Returns the
    Path or None if it's missing/outside the calendar tree."""
    if not rel:
        return None
    try:
        src = (VAULT / rel).resolve()
        src.relative_to(EVENTS_ROOT.resolve())
    except Exception:
        return None
    return src if src.is_file() else None


def _split_frontmatter(text):
    end = text.find("\n---", 3) if text.startswith("---") else -1
    body = text[end + 4:].lstrip("\n") if end >= 0 else text
    return end, body


def read_event_body(rel):
    src = _event_path((rel or "").strip())
    if not src:
        return {"error": "event not found"}
    _, body = _split_frontmatter(read_text(src) or "")
    return {"ok": True, "body": body.rstrip("\n")}


_EVENT_MANAGED_KEYS = {"title", "date", "endDate", "startTime", "endTime", "allDay", "type",
                       "startDate", "rrule", "calendarType", "mode", "link", "tags"}


def _event_extra_frontmatter(text):
    """Raw frontmatter lines for every key update_event does not manage (completed,
    location, whatever a later feature adds), continuation lines included, so an edit
    carries them over verbatim instead of dropping them."""
    if not text or not text.startswith("---"):
        return []
    end = text.find("\n---", 3)
    if end < 0:
        return []
    out, keep = [], False
    for ln in text[3:end].split("\n"):
        ln = ln.rstrip("\r")
        m = re.match(r"^([A-Za-z_][\w-]*)\s*:", ln)
        if m:
            keep = m.group(1) not in _EVENT_MANAGED_KEYS
        if keep and ln.strip():
            out.append(ln)
    return out


def update_event(data):
    src = _event_path((data.get("path") or "").strip())
    if not src:
        return {"error": "event not found"}
    title = (data.get("title") or "").strip()
    date_s = (data.get("date") or "").strip()
    category = (data.get("category") or "").strip().lower()
    if not title:
        return {"error": "title required"}
    if not re.match(r"^\d{4}-\d{2}-\d{2}$", date_s):
        return {"error": "date must be YYYY-MM-DD"}
    valid = {s for s, _ in EVENT_DIRS}
    if category not in valid:
        return {"error": f"unknown category (use one of {sorted(valid)})"}
    repeats = bool(data.get("repeatsYearly"))
    start_t = (data.get("startTime") or "").strip()
    end_t = (data.get("endTime") or "").strip()
    all_day = bool(data.get("allDay", True)) or not start_t

    old_text = read_text(src) or ""
    _, old_body = _split_frontmatter(old_text)
    if "note" in data:
        note = (data.get("note") or "").strip()
        body = note + "\n" if note else ""
    else:
        body = old_body
    old_fm = parse_frontmatter(old_text)
    old_type = str(old_fm.get("type") or "").strip().lower()
    if old_type not in ("", "single", "rrule"):
        return {"error": f"recurrence type '{old_type}' is not editable here; open the note"}
    # endDate: an explicit key wins ("" clears); otherwise the file's own span carries
    # over, moved by as many days as the start moved, so a multi-day event keeps its length.
    if "endDate" in data:
        end_d = (data.get("endDate") or "").strip()
        if end_d and not re.match(r"^\d{4}-\d{2}-\d{2}$", end_d):
            return {"error": "endDate must be YYYY-MM-DD"}
    else:
        end_d = str(old_fm.get("endDate") or "").strip()[:10]
        old_d = str(old_fm.get("date") or "").strip()[:10]
        try:
            if end_d and old_d and old_d != date_s:
                shift = date.fromisoformat(date_s) - date.fromisoformat(old_d)
                end_d = (date.fromisoformat(end_d) + shift).isoformat()
        except ValueError:
            pass
    if end_d and end_d < date_s:
        end_d = ""
    if "link" in data:
        try:
            link = calendar_links.validate_link(data.get("link"))
        except calendar_links.LinkError as exc:
            return {"error": f"link: {exc}"}
        mode = "call" if link else None
    else:
        link = str(old_fm.get("link") or "").strip() or None
        mode = "call" if (link or str(old_fm.get("mode") or "").strip().lower() == "call") else None
    old_rrule = str(old_fm.get("rrule") or "FREQ=YEARLY")
    was_recurring = str(old_fm.get("type", "")).lower() == "rrule" or bool(old_fm.get("rrule"))
    floating = was_recurring and "BYDAY" in old_rrule.upper()

    q = title.replace('"', "'")
    lines = ["---", f'title: "{q}"']
    if repeats:
        anchor = old_fm.get("startDate") if floating and old_fm.get("startDate") else date_s
        rrule_out = old_rrule if was_recurring else "FREQ=YEARLY"
        lines += ["type: rrule", f"startDate: {anchor}", f"rrule: {rrule_out}", "allDay: true"]
    elif all_day:
        lines += [f"date: {date_s}"] + ([f"endDate: {end_d}"] if end_d else []) + ["allDay: true"]
    else:
        lines += [f"date: {date_s}"] + ([f"endDate: {end_d}"] if end_d else []) + [f'startTime: "{start_t}"']
        if end_t:
            lines.append(f'endTime: "{end_t}"')
        lines.append("allDay: false")
    old_tags = old_fm.get("tags") or []
    if isinstance(old_tags, str): old_tags = [old_tags]
    project_raw = data.get("project") if "project" in data else next((t for t in old_tags if t not in ("calendar", category, "deadline", src.parent.name)), None)
    tags = ["calendar", category]
    project = _slug(str(project_raw).strip()) if project_raw else None
    if project and project not in tags: tags.append(project)
    lines.append(f"calendarType: {category}")
    if mode:
        lines.append(f"mode: {mode}")
    if link:
        lines.append('link: "' + str(link).replace('"', "'") + '"')
    lines += _event_extra_frontmatter(old_text)   # completed, location, anything unmanaged
    lines += ["tags:"] + [f"  - {t}" for t in tags] + ["---", ""]
    if link or "link" in data:                 # keep the one managed body line in step
        body = calendar_links.apply_join_line(body, link)
    new_text = "\n".join(lines) + ("\n" + body if body else "")

    dest_dir = EVENTS_ROOT / category
    dest = src
    if dest_dir.resolve() != src.parent.resolve():
        dest_dir.mkdir(parents=True, exist_ok=True)
        slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")[:50] or "event"
        dest = dest_dir / f"{date_s}_{slug}.md"
        i = 2
        while dest.exists():
            dest = dest_dir / f"{date_s}_{slug}-{i}.md"; i += 1

    tmp = dest.with_suffix(".md.tmp")
    tmp.write_text(new_text, encoding="utf-8")
    os.replace(str(tmp), str(dest))
    if dest != src:
        try:
            src.unlink()
        except OSError:
            pass
    _events_cache["data"] = None
    return {"ok": True, "path": str(dest.relative_to(VAULT)).replace("\\", "/"),
            "category": category, "date": date_s, "repeats": repeats}


def archive_event(rel):
    src = _event_path((rel or "").strip())
    if not src:
        return {"error": "event not found"}
    dest = src.parent / f"_archive_{src.name}"
    i = 2
    while dest.exists():
        dest = src.parent / f"_archive_{i}_{src.name}"; i += 1
    os.replace(str(src), str(dest))
    _events_cache["data"] = None
    return {"ok": True}


def resolve_event(data):
    src = _event_path((data.get("path") or "").strip())
    if not src:
        return {"error": "event not found"}
    done = bool(data.get("done", True))
    text = read_text(src) or ""
    end = text.find("\n---", 3) if text.startswith("---") else -1
    if end < 0:
        return {"error": "event has no frontmatter"}
    fm = parse_frontmatter(text)
    if str(fm.get("type", "")).lower() == "rrule" or fm.get("rrule"):
        return {"error": "recurring events can't be resolved — archive the file instead"}
    head = [ln for ln in text[3:end].splitlines()
            if not re.match(r"^completed\s*:", ln)]
    if done:
        head.append("completed: " + datetime.now().strftime("%Y-%m-%dT%H:%M:%S"))
    new_text = "---" + "\n".join(head) + text[end:]
    tmp = src.with_suffix(".md.tmp")
    tmp.write_text(new_text, encoding="utf-8")
    os.replace(str(tmp), str(src))
    _events_cache["data"] = None
    return {"ok": True, "completed": done,
            "path": str(src.relative_to(VAULT)).replace("\\", "/")}


# ------------------------------------------------------------- daily notes
_daily_cache = {"t": 0.0, "data": None}


def scan_daily():
    """Walk Preparation/Notes/Daily/ and return [{date, words, mtime}]. Cache 5min."""
    now = time.time()
    if _daily_cache["data"] is not None and now - _daily_cache["t"] < 300:
        return _daily_cache["data"]
    by_date = {}
    if DAILY_ROOT.is_dir():
        for f in DAILY_ROOT.iterdir():
            if not f.is_file():
                continue
            m = DAILY_NAME_RE.match(f.name)
            if not m:
                continue
            d = m.group(1)
            text = read_text(f)
            if text is None:
                continue
            # strip frontmatter from word count
            body = text
            if body.startswith("---"):
                e = body.find("\n---", 3)
                if e >= 0:
                    body = body[e + 4:]
            words = len(re.findall(r"\b\w+\b", body))
            try:
                mtime = f.stat().st_mtime
            except OSError:
                mtime = 0
            # if there are multiple files for one date, sum the words
            if d in by_date:
                by_date[d]["words"] += words
                by_date[d]["mtime"] = max(by_date[d]["mtime"], mtime)
            else:
                by_date[d] = {"date": d, "words": words, "mtime": mtime,
                              "path": str(f.relative_to(VAULT)).replace("\\", "/")}
    out = sorted(by_date.values(), key=lambda x: x["date"])
    _daily_cache["data"], _daily_cache["t"] = out, now
    return out


# ------------------------------------------------------------- goals
def scan_goals():
    if not GOALS_FILE.exists():
        return []
    text = read_text(GOALS_FILE)
    if text is None:
        return []
    today_iso = date.today().isoformat()
    out = []
    # only consider lines BEFORE the "## Done" heading
    cut = text.lower().find("\n## done")
    body = text if cut < 0 else text[:cut]
    for ln in body.splitlines():
        m = GOAL_LINE_RE.match(ln)
        if not m:
            continue
        done = m.group(1).lower() == "x"
        d = m.group(2)
        title = m.group(3).strip()
        raw_tags = re.findall(r"#([A-Za-z0-9\-_/:]+)", title)
        tags = [tg for tg in raw_tags if not tg.lower().startswith("m:")]
        clean = re.sub(r"\s*#[A-Za-z0-9\-_/:]+", "", title).strip()
        days = (date.fromisoformat(d) - date.today()).days
        # a STABLE id for check-off: the #m:<key> milestone key when present,
        # else date|title. The dashboard toggles a goal done by this key.
        mkey = next((tg[2:] for tg in raw_tags if tg.lower().startswith("m:")), None)
        out.append({
            "date": d, "title": clean, "tags": tags, "key": mkey or f"{d}|{clean}",
            "done": done, "daysLeft": days, "isPast": d < today_iso,
        })
    out.sort(key=lambda g: g["date"])
    return out


def toggle_goal(key):
    if not key or not GOALS_FILE.exists():
        return None
    text = read_text(GOALS_FILE)
    if text is None:
        return None
    lines = text.splitlines()
    hit = False
    for i, ln in enumerate(lines):
        m = GOAL_LINE_RE.match(ln)
        if not m:
            continue
        d, title_raw = m.group(2), m.group(3).strip()
        raw_tags = re.findall(r"#([A-Za-z0-9\-_/:]+)", title_raw)
        mkey = next((tg[2:] for tg in raw_tags if tg.lower().startswith("m:")), None)
        clean = re.sub(r"\s*#[A-Za-z0-9\-_/:]+", "", title_raw).strip()
        if (mkey or f"{d}|{clean}") == key:
            mark = " " if m.group(1).lower() == "x" else "x"
            lines[i] = re.sub(r"^- \[[ xX]\]", f"- [{mark}]", ln, count=1)
            hit = True
            break
    if not hit:
        return None
    new_text = "\n".join(lines)
    if text.endswith("\n") and not new_text.endswith("\n"):
        new_text += "\n"
    (HERE / "goals-last.bak.md").write_text(text, encoding="utf-8")
    _atomic_write(GOALS_FILE, new_text)
    return scan_goals()


# ------------------------------------------------------------- tags index
def scan_tags():
    """Aggregate #tags across all open and closed cards on all boards."""
    out = {}  # tag -> { count, openCount, boards: set }
    for b in scan_boards():
        for lane in b["board"]["lanes"]:
            for c in lane["cards"]:
                for t in c["tags"]:
                    rec = out.setdefault(t, {"tag": t, "count": 0, "openCount": 0, "boards": set()})
                    rec["count"] += 1
                    if not c["done"]:
                        rec["openCount"] += 1
                    rec["boards"].add(b["name"])
    rows = [{"tag": r["tag"], "count": r["count"], "openCount": r["openCount"],
             "boards": sorted(list(r["boards"]))[:8]} for r in out.values()]
    rows.sort(key=lambda r: -r["count"])
    return rows


def cards_for_tag(tag):
    want = tag.lstrip("#").lower()
    hits = []
    for b in scan_boards():
        for lane in b["board"]["lanes"]:
            for c in lane["cards"]:
                if any(t.lower() == want for t in c["tags"]):
                    hits.append({"board": b["name"], "path": b["path"], "lane": lane["name"],
                                 "text": c["text"], "done": c["done"], "raw": c["raw"],
                                 "due": c["due"], "priority": c["priority"]})
    return hits


def merged_tags():
    """Unified tag cloud: kanban-card tags (rich board/lane/done context) MERGED with
    every note tag (frontmatter + inline #tags) from the whole-vault index that
    build_cache.py maintains. Keyed case-insensitively; `count` = cards + notes."""
    out = {}  # lowercase tag -> row
    for r in scan_tags():
        low = r["tag"].lower()
        out[low] = {"tag": r["tag"], "count": r["count"], "openCount": r["openCount"],
                    "cardCount": r["count"], "noteCount": 0, "boards": r["boards"]}
    for low, n in tagindex.note_tag_counts(HERE).items():
        if low in out:
            out[low]["noteCount"] = n
            out[low]["count"] += n
        else:
            out[low] = {"tag": low, "count": n, "openCount": 0,
                        "cardCount": 0, "noteCount": n, "boards": []}
    rows = list(out.values())
    rows.sort(key=lambda r: (-r["count"], r["tag"]))
    return rows


def tag_occurrences(tag):
    return {"cards": cards_for_tag(tag), "notes": tagindex.note_occurrences(HERE, tag),
            "index": tagindex.status(HERE)}


# ------------------------------------------------------------- reading
def _openalex_import(data):
    """Preview (mode+query) or build (items+listName). Returns the OpenAlex payload
    for preview, or {built:{list,added}} when committing the list."""
    if data.get("build") and data.get("items"):
        note = "OpenAlex import — %s" % (data.get("query") or data.get("mode") or "")
        built = openalex.build_list(data["items"], data.get("listName") or "Download list",
                                    note=note[:120])
        return {"built": built}
    mode = (data.get("mode") or "author").strip()
    query = (data.get("query") or "").strip()
    if not query:
        return {"error": "empty query"}
    if mode == "author":
        return openalex.by_author(query)
    if mode in ("lines", "dois", "titles"):
        return openalex.resolve_lines(query)
    if mode == "topic":
        return openalex.by_topic(query, int(data.get("limit") or 40))
    return {"error": "unknown mode"}


def reading_inbox():
    """Recently clipped articles awaiting triage."""
    out = []
    for d, kind in [(CLIPPINGS_DIR, "clipping")]:
        if not d.is_dir():
            continue
        for f in d.iterdir():
            if f.is_file() and f.suffix == ".md" and f.stem != "Untitled":
                try:
                    mtime = f.stat().st_mtime
                except OSError:
                    mtime = 0
                out.append({"name": f.stem, "path": str(f.relative_to(VAULT)).replace("\\", "/"),
                            "kind": kind, "mtime": mtime})
    out.sort(key=lambda x: -x["mtime"])
    return out


def recent_citations(limit=12):
    if not CITATIONS_DIR.is_dir():
        return []
    out = []
    for f in CITATIONS_DIR.iterdir():
        if f.is_file() and f.suffix == ".md":
            try:
                mtime = f.stat().st_mtime
            except OSError:
                continue
            out.append({"name": f.stem,
                        "path": str(f.relative_to(VAULT)).replace("\\", "/"),
                        "mtime": mtime})
    out.sort(key=lambda x: -x["mtime"])
    return out[:limit]


CIT_REF_RE = re.compile(
    r"([A-Z][A-Za-z.'’\-]+(?:\s+(?:(?:and|&)\s+[A-Z][A-Za-z.'’\-]+|et\s+al\.?))*)\s*\((\d{4}|n\.d\.)\)")


def _citation_stems():
    if not CITATIONS_DIR.is_dir():
        return []
    return [f.stem for f in CITATIONS_DIR.iterdir() if f.is_file() and f.suffix == ".md"]


def _resolve_citation(surname, year, stems):
    prefix = (surname + " (" + year + ")").lower()
    for s in stems:
        if s.lower().startswith(prefix):
            return s
    pat = re.compile(r"^" + re.escape(surname) + r"\b.*\(" + re.escape(year) + r"\)", re.I)
    for s in stems:
        if pat.search(s):
            return s
    return None


def reading_today():
    today_iso = date.today().isoformat()
    stems = _citation_stems()
    out, seen = [], set()
    for b in scan_boards():
        for lane in b["board"]["lanes"]:
            for c in lane["cards"]:
                if c["done"] or "reading" not in [t.lower() for t in c["tags"]]:
                    continue
                due = card_due(c)
                if not due or due > today_iso:
                    continue   # future reads wait their turn; only today + overdue
                overdue = due < today_iso
                base = {"due": due, "overdue": overdue, "priority": c["priority"],
                        "taskText": c["text"], "raw": c["raw"], "boardPath": b["path"]}
                resolved = False
                for grp, year in CIT_REF_RE.findall(c["text"]):
                    stem = _resolve_citation(grp.split()[0], year, stems)
                    if not stem:
                        continue
                    path = "Preparation/Reading/Citations/" + stem + ".md"
                    if path in seen:
                        continue
                    seen.add(path)
                    resolved = True
                    out.append({**base, "label": stem, "path": path, "citationName": stem})
                if not resolved:
                    key = c["text"].strip().lower()
                    if key in seen:
                        continue
                    seen.add(key)
                    out.append({**base, "label": c["text"], "path": None, "citationName": None})
    out.sort(key=lambda x: (x["due"], x["label"]))   # oldest due first → overdue leads
    return out


# ------------------------------------------------------------- daily note
def daily_today():
    today = date.today().isoformat()
    p = DAILY_ROOT / (today + ".md")
    rel = "Preparation/Notes/Daily/" + today + ".md"
    if not p.exists():
        return {"exists": False, "path": rel, "date": today,
                "habits": {k: False for k in HABIT_KEYS}, "today": ""}
    text = read_text(p) or ""
    fm = parse_frontmatter(text)
    habits = {k: bool(fm.get(k)) for k in HABIT_KEYS}
    m = re.search(r"(?ms)^##\s+Today\s*$(.*?)(?=^---\s*$|^##\s+|\Z)", text)
    today_sec = (m.group(1).strip() if m else "")[:1500]
    return {"exists": True, "path": rel, "date": today, "habits": habits, "today": today_sec}


def toggle_habit(key):
    """Flip a habit boolean in today's daily-note frontmatter. Creates today's
    note from the template if missing. Frontmatter-only edit; body never
    touched. Returns the new habit map, or None on bad key."""
    if key not in HABIT_KEYS:
        return None
    today = date.today().isoformat()
    p = DAILY_ROOT / (today + ".md")
    created = False
    if not p.exists():
        tmpl = read_text(DAILY_TEMPLATE)
        if tmpl is None:
            return None
        text = tmpl.replace("- daily template", "- " + today)
        created = True
    else:
        text = read_text(p) or ""
    # operate only inside the frontmatter block (before the closing ---)
    end = text.find("\n---", 3) if text.startswith("---") else -1
    head = text[:end] if end > 0 else text
    tail = text[end:] if end > 0 else ""

    cur = re.search(r"(?m)^" + re.escape(key) + r":\s*(true|false)\s*$", head)
    new_val = not (cur and cur.group(1) == "true")  # the flipped value

    def set_key(h, k, val):
        rep = f"{k}: {'true' if val else 'false'}"
        h2, n = re.subn(r"(?m)^" + re.escape(k) + r":\s*(true|false)\s*$",
                        lambda mo: rep, h, count=1)
        return h2 if n else h.rstrip() + "\n" + rep  # insert if absent

    new_head = set_key(head, key, new_val)
    new_text = new_head + tail
    if not created:
        try:
            DAILY_BACKUP.write_text(text, encoding="utf-8")
        except OSError:
            pass
    tmp = p.with_suffix(".md.tmp")
    tmp.write_text(new_text, encoding="utf-8")
    os.replace(str(tmp), str(p))
    fm = parse_frontmatter(new_text)
    return {k: bool(fm.get(k)) for k in HABIT_KEYS}


# ------------------------------------------------------------- habits
def _daily_notes_habits(within_days=120):
    """date(iso) -> {habit: bool} for daily notes within the last `within_days`."""
    notes = {}
    cutoff = (date.today() - timedelta(days=within_days)).isoformat()
    if DAILY_ROOT.is_dir():
        for f in DAILY_ROOT.iterdir():
            if not f.is_file():
                continue
            m = DAILY_NAME_RE.match(f.name)
            if not m or m.group(1) < cutoff or m.group(1) < HABIT_TRACKING_START:
                continue
            t = read_text(f)
            if t is None:
                continue
            fm = parse_frontmatter(t)
            notes[m.group(1)] = {k: bool(fm.get(k)) for k in HABIT_KEYS}
    return notes


def habit_streaks(notes=None):
    notes = _daily_notes_habits() if notes is None else notes
    today = date.today()
    start = 0 if today.isoformat() in notes else 1
    out = {}
    for k in HABIT_KEYS:
        streak, d = 0, today - timedelta(days=start)
        while notes.get(d.isoformat(), {}).get(k):
            streak += 1
            d -= timedelta(days=1)
        out[k] = streak
    return out


def habit_stats(notes=None, days=30):
    notes = _daily_notes_habits() if notes is None else notes
    today = date.today()
    win = [(today - timedelta(days=i)).isoformat() for i in range(days)]   # newest first
    out = {}
    for k in HABIT_KEYS:
        logged = done = best = run = 0
        for ds in reversed(win):   # oldest -> newest so streak runs read correctly
            rec = notes.get(ds)
            if rec is None:
                run = 0
                continue
            logged += 1
            if rec.get(k):
                done += 1
                run += 1
                best = max(best, run)
            else:
                run = 0
        out[k] = {"done": done, "logged": logged, "days": days,
                  "rate": round(100 * done / logged) if logged else 0, "best": best}
    return out


def habit_grid(notes=None, days=14):
    """Last `days` days as [{date, done:{habit:bool}|None, exists}] oldest first."""
    notes = _daily_notes_habits() if notes is None else notes
    today = date.today()
    grid = []
    for i in range(days - 1, -1, -1):
        ds = (today - timedelta(days=i)).isoformat()
        rec = notes.get(ds)
        grid.append({"date": ds, "done": rec, "exists": rec is not None})
    return grid


def _section_text(text, header):
    """Body under a `## Header` or `### Header` up to the next header or `---`."""
    pat = r"(?ms)^#{2,3}\s+" + re.escape(header) + r"\s*$(.*?)(?=^---\s*$|^#{2,3}\s+|\Z)"
    m = re.search(pat, text)
    return (m.group(1).strip() if m else "")


def _valid_recent_date(s, back=31):
    """Validate an ISO date string is real, not in the future, and within the last
    `back` days. Returns the canonical ISO string or None. Bounds journal backfill
    so the dashboard can only ever write to recent daily notes."""
    try:
        d = datetime.strptime((s or "").strip(), "%Y-%m-%d").date()
    except (TypeError, ValueError):
        return None
    today = date.today()
    if d > today or d < today - timedelta(days=back):
        return None
    return d.isoformat()


def daily_sections(d=None):
    """A daily note's full section text (never truncated: the page saves these
    back) and a word count. `d` is an ISO date, today by default."""
    today = d or date.today().isoformat()
    p = DAILY_ROOT / (today + ".md")
    empty = {"exists": False, "dailyNotes": "", "work": "", "eodHappened": "", "eodTomorrow": "",
             "eodSentence": "", "morningFilled": False, "todayFilled": False, "workFilled": False,
             "eodFilled": False, "words": 0}
    if not p.exists():
        return empty
    text = read_text(p) or ""
    mc = _section_text(text, settings.DAILY_SECTIONS["daily-notes"]).strip()
    # the level-2 section only: a level-3 heading of the same name is not it
    m = re.search(r"(?ms)^##\s+" + re.escape(settings.DAILY_SECTIONS["work"])
                  + r"\s*$(.*?)(?=^---\s*$|^#{2,3}\s+|\Z)", text)
    work = m.group(1).strip() if m else ""
    today_sec = _section_text(text, "Today")
    happened = _section_text(text, settings.DAILY_SECTIONS["log-entry"])
    tomorrow = _section_text(text, settings.DAILY_SECTIONS["log-next"])
    sentence = _section_text(text, settings.DAILY_SECTIONS["log-summary"])
    # words written in these sections, not the template scaffolding
    written = " ".join(s for s in (mc, work, today_sec, happened, tomorrow, sentence) if s)
    words = len(re.findall(r"\b[\w']+\b", written))
    return {"exists": True, "dailyNotes": mc, "work": work, "eodHappened": happened,
            "eodTomorrow": tomorrow, "eodSentence": sentence,
            "morningFilled": bool(mc), "todayFilled": bool(today_sec), "workFilled": bool(work),
            "eodFilled": bool(happened or tomorrow or sentence), "words": words}


def daily_recent(days=6):
    """The last `days` days (today first) with light journal status, for the Today
    day-picker: which days already have morning/evening writing, and word counts."""
    days = max(1, min(int(days or 6), 14))
    out = []
    today = date.today()
    for i in range(days):
        d = (today - timedelta(days=i)).isoformat()
        s = daily_sections(d)
        out.append({"date": d, "weekday": DAY3[(today - timedelta(days=i)).weekday()],
                    "isToday": i == 0, "words": s["words"], "exists": s["exists"],
                    "morningFilled": s["morningFilled"], "eodFilled": s["eodFilled"]})
    return out


def daily_dates():
    """Every date that has a daily note, for the all-days browser calendar."""
    return sorted(p.stem for p in DAILY_ROOT.glob("20??-??-??.md"))


def daily_read(s):
    """One past daily note, READ-ONLY, for the day browser. Any existing date is
    readable; writes stay bounded by _valid_recent_date elsewhere. The strict
    date parse confines the path to DAILY_ROOT."""
    try:
        d = datetime.strptime((s or "").strip(), "%Y-%m-%d").date().isoformat()
    except (TypeError, ValueError):
        return None
    p = DAILY_ROOT / (d + ".md")
    if not p.exists():
        return None
    text = read_text(p) or ""
    body = re.sub(r"(?s)\A---\n.*?\n---\n?", "", text, count=1).strip()
    return {"date": d, "path": "Preparation/Notes/Daily/" + d + ".md", "text": body}


def routines_today():
    """Habits, streaks and today's journal sections in one payload."""
    notes = _daily_notes_habits()
    dt = daily_today()
    return {
        "date": date.today().isoformat(),
        "day": DAY3[date.today().weekday()],
        "habits": dt["habits"],
        "habitKeys": HABIT_KEYS,
        "streaks": habit_streaks(notes),
        "habitStats": habit_stats(notes, 30),
        "grid": habit_grid(notes, 30),
        "sections": daily_sections(),
        "dailyPath": dt["path"],
    }


# the daily-note sections the page may write: anchor -> (heading line, fixed first line)
_WRITABLE_SECTIONS = ("daily-notes", "work", "log-entry", "log-next", "log-summary")
SECTION_ANCHORS = {k: ("#" * (3 if k.startswith("log-") else 2) + " " + settings.DAILY_SECTIONS[k], None)
                   for k in _WRITABLE_SECTIONS if k in settings.DAILY_SECTIONS}


def set_daily_section(anchor, text, day=None):
    if anchor not in SECTION_ANCHORS:
        return None
    header, keep_line = SECTION_ANCHORS[anchor]
    today = day or date.today().isoformat()
    p = DAILY_ROOT / (today + ".md")
    existed = p.exists()
    if existed:
        cur = read_text(p) or ""
    else:
        tmpl = read_text(DAILY_TEMPLATE)
        if tmpl is None:
            return None
        cur = tmpl.replace("- daily template", "- " + today)
    lines = cur.split("\n")
    hi = next((i for i, l in enumerate(lines) if l.strip() == header), None)
    if hi is None:
        if not header.startswith("## ") or header.startswith("### "):
            return None
        eod = next((i for i, l in enumerate(lines) if l.strip() == "## " + settings.DAILY_LOG_HEADING), None)
        prev = "## " + settings.DAILY_SECTIONS["daily-notes"] if anchor == "work" else None
        pi = next((i for i, l in enumerate(lines) if l.strip() == prev), None) if prev else None
        after_prev = (next((i for i in range(pi + 1, len(lines)) if lines[i].startswith("## ")), None)
                      if pi is not None else None)
        if after_prev is not None:
            # right after its preceding section, before the next one
            lines[after_prev:after_prev] = [header, "", "---", ""]
            hi = after_prev
        elif eod is not None:
            lines[eod:eod] = [header, "", "---", ""]
            hi = eod
        else:
            if lines and lines[-1].strip():
                lines.append("")
            lines += [header, ""]
            hi = len(lines) - 2
    j = hi + 1
    while j < len(lines) and not (lines[j].startswith("## ") or lines[j].startswith("### ")
                                  or lines[j].strip() == "---"):
        j += 1
    block = [lines[hi]]
    if keep_line:
        block.append(keep_line)
    block.append("")
    body = (text or "").strip()
    if body:
        block.append(body)
        block.append("")
    new_text = "\n".join(lines[:hi] + block + lines[j:])
    if existed:
        try:
            DAILY_BACKUP.write_text(cur, encoding="utf-8")
        except OSError:
            pass
    tmp = p.with_suffix(".md.tmp")
    tmp.write_text(new_text, encoding="utf-8")
    os.replace(str(tmp), str(p))
    return {"ok": True, "anchor": anchor, "created": not existed}


# ------------------------------------------------------------- learning (flashcards)
_learn_cache = {"t": 0.0, "data": None}
SHELVED_FILE = HERE / "shelved_decks.json"   # decks paused from the due count


def load_shelved():
    """The set of deck names the user has shelved (paused from reviews)."""
    try:
        d = json.loads(SHELVED_FILE.read_text(encoding="utf-8"))
        return set(d) if isinstance(d, list) else set()
    except (OSError, ValueError):
        return set()


def save_shelved(s):
    try:
        SHELVED_FILE.write_text(json.dumps(sorted(s)), encoding="utf-8")
        return True
    except OSError:
        return False


LEARNING_FLAGS_FILE = HERE / "learning-flags.json"


def _flag_id(path, ordn):
    return _hashlib.sha256(f"{path}#{ordn}".encode("utf-8")).hexdigest()[:16]


def load_flags():
    """[{id, path, ord, deck, front, reason, created, status}], oldest first."""
    try:
        d = json.loads(LEARNING_FLAGS_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    rows = d.get("flags") if isinstance(d, dict) else None
    return [r for r in rows if isinstance(r, dict)] if isinstance(rows, list) else []


def save_flags(flags):
    try:
        _atomic_write(LEARNING_FLAGS_FILE, json.dumps(
            {"flags": list(flags)}, indent=2, ensure_ascii=False))
        return True
    except OSError:
        return False


LEARNING_BOARD_FILE = HERE / "learning_board.json"


def load_board():
    """The saved {inProgress, queue} deck order, or None when never arranged."""
    try:
        d = json.loads(LEARNING_BOARD_FILE.read_text(encoding="utf-8"))
        if (isinstance(d, dict) and isinstance(d.get("inProgress"), list)
                and isinstance(d.get("queue"), list)):
            return {"inProgress": [str(x) for x in d["inProgress"]],
                    "queue": [str(x) for x in d["queue"]]}
    except (OSError, ValueError):
        pass
    return None


def save_board(board):
    try:
        LEARNING_BOARD_FILE.write_text(json.dumps(
            {"inProgress": list(board.get("inProgress", [])),
             "queue": list(board.get("queue", []))}, indent=2), encoding="utf-8")
        return True
    except OSError:
        return False


def _apply_board(d):
    names = [r["deck"] for r in d["decks"]]
    present = set(names)
    board = load_board()
    if board is None:
        in_prog, queue = list(names), []
    else:
        in_prog = [n for n in board["inProgress"] if n in present]
        queue = [n for n in board["queue"] if n in present]
        placed = set(in_prog) | set(queue)
        queue += [n for n in names if n not in placed]   # new decks -> queue (end)
    section = {n: "inProgress" for n in in_prog}
    section.update({n: "queue" for n in queue})
    order = {n: i for i, n in enumerate(in_prog + queue)}
    for r in d["decks"]:
        r["section"] = section.get(r["deck"], "queue")
    d["decks"].sort(key=lambda r: order.get(r["deck"], 1 << 30))
    d["sections"] = {"inProgress": in_prog, "queue": queue}
    return d


def learn_scan():
    now = time.time()
    if _learn_cache["data"] is not None and now - _learn_cache["t"] < 30:
        d = _learn_cache["data"]
    else:
        d = learning.scan(str(LEARNING_ROOT), load_shelved())
        _learn_cache["data"], _learn_cache["t"] = d, now
    return _apply_board(d)


# ------------------------------------------------------------- canon (quotes)
def parse_canon():
    """Favourite quotes for the 'Some inspiration' button. Each blockquote is one
    quote; an italic line (`*Author, Source*`) or a leading em-dash line is the
    attribution. Returns [{text, attribution}]."""
    text = read_text(CANON_FILE)
    if not text:
        return []
    out, block = [], []

    def flush():
        if not block:
            return
        attr, lines = "", []
        for ln in block:
            s = ln.strip()
            mi = re.match(r"^\*(.+?)\*$", s)
            md = re.match(r"^[—–-]\s+(.+)$", s)
            if mi:
                attr = mi.group(1).strip()
            elif md:
                attr = md.group(1).strip()
            elif s:
                lines.append(s)
        q = " ".join(lines).strip().strip('"').strip("“”")
        if q:
            out.append({"text": q, "attribution": re.sub(r"\*", "", attr).strip()})

    for ln in text.split("\n"):
        if ln.lstrip().startswith(">"):
            block.append(ln.lstrip()[1:].lstrip())
        else:
            flush()
            block = []
    flush()
    return out


CACHE_FILE = HERE / "dashboard-data.json"
_rebuild_lock = threading.Lock()
_rebuild_timer = None


def _do_rebuild():
    # one rebuild at a time
    with _rebuild_lock:
        try:
            subprocess.run([sys.executable, str(settings.CODE_DIR / "build_cache.py")], timeout=180)
        except Exception:
            pass


def schedule_cache_rebuild(delay=8.0):
    """Coalesce rapid writes into a single rebuild `delay` seconds after the last one."""
    global _rebuild_timer
    if _rebuild_timer is not None:
        _rebuild_timer.cancel()
    _rebuild_timer = threading.Timer(delay, _do_rebuild)
    _rebuild_timer.daemon = True
    _rebuild_timer.start()


_cache_generated_memo = (None, None)     # ((mtime_ns, size), generated)


def cache_generated():
    global _cache_generated_memo
    try:
        st = CACHE_FILE.stat()
        key = (st.st_mtime_ns, st.st_size)
        memo = _cache_generated_memo
        if memo[0] == key:
            return memo[1]
        generated = json.loads(CACHE_FILE.read_text(encoding="utf-8")).get("generated")
        _cache_generated_memo = (key, generated)
        return generated
    except Exception:
        return None


# ------------------------------------------------------------- citation status
_CITATION_REL_RE = re.compile(r"Preparation/Reading/Citations/[^/\x00-\x1f]+")
_CITATION_STATE_RE = re.compile(r"[a-z][a-z-]{0,23}")


def _citation_note_path(rel):
    """The citation note a vault-relative path names, or None. The path must be
    exactly Preparation/Reading/Citations/<name>[.md], and the file it resolves to
    must sit directly inside that folder."""
    if not isinstance(rel, str):
        return None
    rel = rel.replace("\\", "/")
    name = rel.rsplit("/", 1)[-1]
    if not _CITATION_REL_RE.fullmatch(rel) or name.startswith("."):
        return None
    if not name.endswith(".md"):
        rel += ".md"
    try:
        root = CITATIONS_DIR.resolve()
        p = (VAULT / rel).resolve()
        if p.parent != root or not p.is_file():
            return None
    except (OSError, ValueError):
        return None
    return p


def set_citation_status(citation_path, state):
    """Set a citation note's `status:` frontmatter key. Frontmatter only; the body
    is untouched. Anything that is not a citation note is left alone."""
    p = _citation_note_path(citation_path)
    if p is None or not isinstance(state, str) or not _CITATION_STATE_RE.fullmatch(state):
        return
    t = read_text(p)
    if not t or not t.startswith("---"):
        return
    end = t.find("\n---", 3)
    if end < 0:
        return
    head, tail = t[:end], t[end:]
    new_head, n = re.subn(r"(?m)^status:\s*.*$", lambda _m: "status: " + state, head, count=1)
    if n == 0:
        new_head = head.rstrip() + "\nstatus: " + state
    if new_head != head:
        _atomic_write(p, new_head + tail)
        schedule_cache_rebuild()   # a read-state change shows in the analytics


# ------------------------------------------------------------- open URI
def open_uri(uri):
    try:
        argv = ["open", uri] if sys.platform == "darwin" else ["xdg-open", uri]
        proc = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL, start_new_session=True)
        threading.Thread(target=proc.wait, daemon=True).start()
        return proc
    except Exception:
        return None


def _peer_uid(client_address, server_address):
    try:
        pair = " ".join(
            "%08X:%04X" % (int.from_bytes(socket.inet_aton(a[0]), sys.byteorder), int(a[1]))
            for a in (client_address, server_address))
    except (OSError, TypeError, ValueError, IndexError):
        return None
    mapped = "0000000000000000FFFF0000"
    v6 = mapped + pair.replace(" ", " " + mapped)
    for table, want in (("/proc/net/tcp", pair), ("/proc/net/tcp6", v6)):
        try:
            with open(table) as fh:
                text = fh.read()
            at = text.find(" " + want + " ")
            if at < 0:
                continue
            return int(text[at:text.index("\n", at)].split()[6])
        except (OSError, ValueError, IndexError):
            continue
    return None


def _dry(q):
    return (q.get("dry") or [""])[0].strip().lower() in ("1", "true", "yes")


def home_path(p):
    try:
        return "~/" + str(Path(p).relative_to(Path.home()))
    except (ValueError, OSError):
        return str(p)


OBSIDIAN_OPEN_LOCK = threading.Lock()      # two quick opens never interleave URIs
OBSIDIAN_PANES = ("tab", "split")
# a bare citationName resolves inside these folders, in this order
_BARE_NAME_DIRS = (("Preparation/Reading/Citations", (".md",)),
                   ("Preparation/Reading/Corpus", ("", ".pdf")))


class ObsidianPathError(ValueError):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def obsidian_target(raw):
    s = (raw or "").strip().replace("\\", "/")
    if not s or "\x00" in s:
        raise ObsidianPathError(400, "empty path")
    form = "vault-relative"
    m = re.fullmatch(r"!?\[\[(.+?)\]\]", s)
    if m:
        s, form = m.group(1).strip(), "wikilink"
    if ".." in s.split("/"):
        raise ObsidianPathError(400, f"'..' is not allowed: {raw}")
    vault = VAULT.resolve()
    if s.startswith("~/"):
        s = str(Path.home()) + s[1:]
    if s.startswith("/"):
        for root in (VAULT, vault):
            try:
                s = Path(s).relative_to(root).as_posix()
                break
            except ValueError:
                continue
        else:
            raise ObsidianPathError(400, f"outside the vault: {raw}")
        if form != "wikilink":
            form = "absolute"
    segs = [x for x in s.split("/") if x not in ("", ".")]
    if not segs:
        raise ObsidianPathError(400, f"not a file: {raw}")
    rel = "/".join(segs)
    bases = [rel]
    if "|" in rel or "#" in rel:              # [[path|alias]] / [[path#heading]]
        bases.append(re.split(r"[|#]", rel, maxsplit=1)[0].rstrip())
    cands = []
    for b in bases:
        cands += [(b, form), (b + ".md", form + "+.md")]
        if "/" not in b:
            for d, exts in _BARE_NAME_DIRS:
                cands += [(f"{d}/{b}{e}", "bare-name") for e in exts]
    for cand, how in cands:
        if not cand or any(x.startswith(".") for x in cand.split("/")):
            continue
        p = VAULT / cand
        try:
            if not p.is_file():
                continue
            p.resolve().relative_to(vault)
        except ValueError:
            raise ObsidianPathError(400, f"resolves outside the vault: {raw}")
        except OSError:
            continue
        if not cand.startswith(READING_PREFIX):
            raise ObsidianPathError(404, f"not in the reading vault (Obsidian holds readings only): {raw}")
        return {"input": raw, "path": cand, "form": how}
    if any(x.startswith(".") for x in segs):
        raise ObsidianPathError(400, f"Obsidian does not index dot-folders: {raw}")
    raise ObsidianPathError(404, f"no such vault file: {raw}")


def obsidian_uri(rel, pane=None):
    uri = "obsidian://open?vault=" + quote(VAULT_ID, safe="") + "&file=" + quote(rel)
    return uri + ("&paneType=" + pane if pane else "")


def obsidian_open_plan(q):
    def arg(name):
        return (q.get(name) or [""])[0].strip()
    if not arg("file"):
        raise ObsidianPathError(400, "file is required")
    pane = arg("pane").lower() or None
    if pane and pane not in OBSIDIAN_PANES:
        raise ObsidianPathError(400, "pane must be tab or split")
    first = dict(obsidian_target(arg("file")), param="file")
    first["uri"] = obsidian_uri(first["path"], pane)
    opened = [first]
    if arg("pair"):
        second = dict(obsidian_target(arg("pair")), param="pair")
        second["uri"] = obsidian_uri(second["path"], "split")
        opened.append(second)
    steps = [{"do": "open-uri", "uri": first["uri"], "path": first["path"]}]
    if len(opened) > 1:
        steps += [{"do": "wait-handler", "timeout_s": 3}, {"do": "sleep", "ms": 450},
                  {"do": "open-uri", "uri": opened[1]["uri"], "path": opened[1]["path"]}]
    return {"opened": opened, "steps": steps}


def _run_obsidian_steps(steps):
    """Carry out a plan from obsidian_open_plan. Runs on a daemon thread, one plan
    at a time, so the request thread answers at once."""
    with OBSIDIAN_OPEN_LOCK:
        proc = None
        for st in steps:
            do = st.get("do")
            try:
                if do == "open-uri":
                    proc = open_uri(st["uri"])
                elif do == "wait-handler":
                    deadline = time.time() + st["timeout_s"]
                    while proc is not None and proc.returncode is None and time.time() < deadline:
                        time.sleep(0.05)
                elif do == "sleep":
                    time.sleep(st["ms"] / 1000)
            except Exception as e:
                print(f"[obsidian/open] step {do} failed: {e}", file=sys.stderr, flush=True)


def obsidian_open(q, act=True):
    """-> (status, body). With `act` false or dry=1 the plan comes back and nothing runs."""
    dry = _dry(q) or not act
    try:
        plan = obsidian_open_plan(q)
    except ObsidianPathError as e:
        return e.status, {"ok": False, "error": str(e)}
    if not dry:
        threading.Thread(target=_run_obsidian_steps, args=(plan["steps"],), daemon=True).start()
    return 200, {"ok": True, "dry": dry, "opened": plan["opened"], "steps": plan["steps"]}


PRESENT_STATE = {"active": False, "slug": "", "deck": "", "idx": 0, "ts": 0}
PRESENT_LOCK = threading.Lock()


BOARD_VIEWS = frozenset((
    "today", "learning",
    "calendar", "drafting", "reading", "library", "notes", "insights",
    "systems",
))
BOARD_WIDGETS = frozenset(("tasks", "journal", "timer", "capture", "now", "figure",
                           "diagram", "diagrams", "note"))
_DIAGRAM_PATH = re.compile(r"\A/w/diagram/[to]/[A-Za-z0-9][A-Za-z0-9_-]{0,79}/?\Z")

_FIG_SELECT = {}           # (session, project key) -> the newest selection for it
_FIG_SELECT_LOCK = threading.Lock()
_FIG_SELECT_MAX = 32       # distinct addresses kept; the oldest goes first
_FIG_SELECT_TTL = 6 * 3600
_FIG_SESSION_RE = re.compile(r"^[A-Za-z0-9._-]{1,96}$")
_FIG_SESSION_PATH = re.compile(r"^/w/figure/s/([A-Za-z0-9._-]{1,96})/?$")


def _fig_project_key(name):
    """A project name in one comparable form: the folder name, its prefixed
    form and a kebab-case spelling all compare equal."""
    s = settings.strip_prefix((name or "").strip()).lower()
    return re.sub(r"[^a-z0-9]+", "-", s).strip("-")


def _fig_select_target(sel):
    """The project key a selection is addressed to ("" = none)."""
    return _fig_project_key(sel.get("project") or
                            (sel.get("slug") if sel.get("source") == "project" else ""))


def _fig_select_put(sel):
    key = (sel.get("session") or "", _fig_select_target(sel))
    with _FIG_SELECT_LOCK:
        _FIG_SELECT[key] = sel
        cut = time.time() - _FIG_SELECT_TTL
        for k in [k for k, v in _FIG_SELECT.items() if v.get("ts", 0) < cut]:
            _FIG_SELECT.pop(k, None)
        while len(_FIG_SELECT) > _FIG_SELECT_MAX:
            _FIG_SELECT.pop(min(_FIG_SELECT, key=lambda k: _FIG_SELECT[k].get("ts", 0)), None)


def _fig_select_take(sessions, project, consume):
    """The newest selection this pane may take (see above), or {}. `sessions` is every
    name the pane answers to (its launch session and, after a lane switch, its current
    one); an empty list is a pane with no session."""
    pkey = _fig_project_key(project)
    with _FIG_SELECT_LOCK:
        best = None
        for k, v in _FIG_SELECT.items():
            s_ses, s_proj = k
            if sessions:
                fits = (s_ses in sessions) if s_ses else (s_proj == pkey)
            else:
                fits = not s_ses
            if fits and (best is None or v.get("ts", 0) > _FIG_SELECT[best].get("ts", 0)):
                best = k
        if best is None:
            return {}
        cur = dict(_FIG_SELECT[best])
        if consume:
            _FIG_SELECT.pop(best, None)
        return cur


_PRE = {}
_PRE_LOCK = threading.Lock()


class _Pre:
    """One precomputed value: a builder, a refresh interval, the last good result."""

    def __init__(self, name, build, every, local=True):
        self.name, self.build, self.every, self.local = name, build, every, local
        self.value = None
        self.built = 0.0
        self.ms = None
        self.error = None
        self.dirty = True
        self.builds = 0
        self.lock = threading.Lock()
        self.box = {"lock": threading.Lock(), "raw": None, "enc": {}}

    def due(self, now):
        return self.dirty or self.value is None or (now - self.built) >= self.every

    def refresh(self):
        # one builder at a time per entry; a second caller takes the last good value
        # rather than queueing behind a scan, which is the whole point of this class
        if not self.lock.acquire(blocking=False):
            return self.value
        try:
            t0 = time.time()
            self.dirty = False
            try:
                self.value = self.build()
                self.error = None
            except Exception as e:
                self.error = "%s: %s" % (type(e).__name__, e)
            self.built = time.time()
            self.ms = round((self.built - t0) * 1000, 1)
            self.builds += 1
            with self.box["lock"]:               # a new value invalidates its bytes
                self.box["raw"], self.box["enc"] = None, {}
            return self.value
        finally:
            self.lock.release()

    def get(self):
        """The request path: build ONLY when nothing has ever been built (the first
        second after a restart, before the refresher's first pass)."""
        return self.value if self.value is not None else self.refresh()

    def warm_bytes(self):
        """Serialize and compress this generation off the request path."""
        if self.value is None:
            return
        try:
            raw = json.dumps(self.value).encode("utf-8")
        except Exception:
            return
        with self.box["lock"]:
            self.box["raw"] = raw
        for accept in ("", ", ".join(_CODINGS)):
            key = frozenset(c for c in _CODINGS if c in _accepted_encodings(accept))
            with self.box["lock"]:
                if key in self.box["enc"]:
                    continue
            try:
                body, enc = _encode_body(raw, "application/json", accept)
                hit = (body, enc, _etag_for(raw, enc))
            except Exception:
                continue
            with self.box["lock"]:
                self.box["enc"][key] = hit

    def status(self):
        return {"ready": self.value is not None,
                "ageSec": round(time.time() - self.built, 1) if self.built else None,
                "buildMs": self.ms, "everySec": self.every, "builds": self.builds,
                "error": self.error}


def _pre_register(name, build, every, local=True):
    p = _Pre(name, build, every, local)
    with _PRE_LOCK:
        _PRE[name] = p
    return p


def _pre_get(name, fallback):
    """The value if the refresher has one, else compute it here. A caller always
    gets a correct answer; only a cold restart pays for it."""
    p = _PRE.get(name)
    if p is None:
        return fallback()
    v = p.get()
    return fallback() if v is None else v


def _pre_dirty(*names):
    for n in names:
        p = _PRE.get(n)
        if p is not None:
            p.dirty = True


def _pre_dirty_local():
    """A write landed: every vault-backed value rebuilds on the refresher's next
    tick (within a second), so nothing the board shows is older than the click."""
    for p in list(_PRE.values()):
        if p.local:
            p.dirty = True


def _pre_status():
    with _PRE_LOCK:
        return {n: p.status() for n, p in _PRE.items()}


def _reading_payload():
    root = _home_path(VAULT)
    return {"lists": reading.active_lists(),
            "archived": reading.archive_index(),
            "downloads": reading.downloads(),
            "queue": reading.queue_sources(),
            "next": reading.next_up(),
            "inbox": reading_inbox(), "recent": recent_citations(),
            "today": reading_today(),
            "vaultPath": root}


_STARTED_AT = time.time()

_BACKGROUND_THREADS = ("precompute", "analytics-rebuild", "notes-graph", panel.THREAD_NAME)


_LOG_DIR = settings.STATE_DIR / "logs"
_REQ_LOG = None
_REQ_LOG_LOCK = threading.Lock()


def _req_logger():
    global _REQ_LOG
    if _REQ_LOG is not None:
        return _REQ_LOG
    with _REQ_LOG_LOCK:
        if _REQ_LOG is not None:        # another thread finished while we waited
            return _REQ_LOG
        return _req_logger_init()


def _req_logger_init():
    global _REQ_LOG
    try:
        import logging
        import logging.handlers
        _LOG_DIR.mkdir(parents=True, exist_ok=True)
        lg = logging.getLogger("all_in_one_academic.board.requests")
        lg.setLevel(logging.INFO)
        lg.propagate = False
        if not lg.handlers:
            try:
                cap = int(os.environ.get("AIOA_REQLOG_MAX_BYTES") or 0)
            except ValueError:
                cap = 0
            h = logging.handlers.RotatingFileHandler(
                str(_LOG_DIR / "board-requests.log"),
                maxBytes=cap or 4 * 1024 * 1024, backupCount=5, encoding="utf-8")
            h.setFormatter(logging.Formatter("%(asctime)s %(message)s",
                                             datefmt="%Y-%m-%dT%H:%M:%S"))
            lg.addHandler(h)
        _REQ_LOG = lg
    except Exception:
        _REQ_LOG = False          # logging unavailable: serve anyway, never crash
    return _REQ_LOG


class _ReqStats:

    def __init__(self, keep=400):
        self.lock = threading.Lock()
        self.total = 0
        self.bytes = 0
        self.errors = 0
        self.over_1s = 0
        self.recent = []
        self.keep = keep
        self.slowest = None

    def add(self, method, path, status, ms, nbytes):
        with self.lock:
            self.total += 1
            self.bytes += nbytes or 0
            if status and status >= 500:
                self.errors += 1
            if ms >= 1000:
                self.over_1s += 1
            self.recent.append(ms)
            if len(self.recent) > self.keep:
                del self.recent[:len(self.recent) - self.keep]
            if self.slowest is None or ms > self.slowest[0]:
                self.slowest = (round(ms, 1), "%s %s" % (method, path))

    def snapshot(self):
        with self.lock:
            xs = sorted(self.recent)
            p = lambda q: (round(xs[min(len(xs) - 1, int(q * len(xs)))], 1) if xs else None)
            return {"total": self.total, "bytes": self.bytes, "errors": self.errors,
                    "over1s": self.over_1s, "recent": len(xs),
                    "p50Ms": p(0.50), "p95Ms": p(0.95),
                    "slowestMs": self.slowest[0] if self.slowest else None,
                    "slowest": self.slowest[1] if self.slowest else None,
                    "log": str(_LOG_DIR / "board-requests.log")}


_REQ_STATS = _ReqStats()


try:                                   # optional
    import brotli as _brotli
except Exception:
    try:
        import brotlicffi as _brotli
    except Exception:
        _brotli = None
try:                                   # Python 3.14 ships zstd in the stdlib (PEP 784)
    from compression import zstd as _zstd
except Exception:
    _zstd = None

_CODINGS = (("zstd",) if _zstd is not None else ()) + (("br",) if _brotli is not None else ()) + ("gzip",)
_ZSTD_STATIC_LEVEL = 19      # once per deploy, cached below
_ZSTD_DYNAMIC_LEVEL = 3      # per JSON response: faster than gzip 6 and about as small

# Compressed representations are cached by (path, mtime_ns, size), so a rebuilt
# bundle is picked up on the next request with no restart.
_ENC_CACHE = {}
_ENC_CACHE_LOCK = threading.Lock()
_ENC_CACHE_MAX_BYTES = 12 * 1024 * 1024     # do not hold a huge asset in RAM
_COMPRESS_MIN = 1024                        # below this, framing costs more than it saves

# text-ish types worth compressing; everything else (png/pdf/woff2) is already packed
_COMPRESSIBLE = (
    "text/", "application/json", "application/javascript", "application/xml",
    "image/svg+xml", "application/manifest+json",
)


def _compressible(ctype):
    c = (ctype or "").split(";")[0].strip().lower()
    return any(c.startswith(p) for p in _COMPRESSIBLE)


def _accepted_encodings(header):
    """Parse Accept-Encoding into the set of codings the client will take, honouring
    an explicit `q=0` (which means 'do not send me this')."""
    out = set()
    for part in (header or "").split(","):
        part = part.strip()
        if not part:
            continue
        bits = part.split(";")
        name = bits[0].strip().lower()
        q = 1.0
        for b in bits[1:]:
            b = b.strip()
            if b.lower().startswith("q="):
                try:
                    q = float(b[2:])
                except ValueError:
                    q = 1.0
        if q > 0:
            out.add(name)
    return out


def _encode_body(raw, ctype, accept, static=False):
    """-> (bytes, content_encoding|None). Never grows the payload. `static` picks the
    slow, small zstd level for bytes that are compressed once and cached."""
    if len(raw) < _COMPRESS_MIN or not _compressible(ctype):
        return raw, None
    enc = _accepted_encodings(accept)
    if _zstd is not None and "zstd" in enc:
        try:
            out = _zstd.compress(raw, level=_ZSTD_STATIC_LEVEL if static else _ZSTD_DYNAMIC_LEVEL)
            if len(out) < len(raw):
                return out, "zstd"
        except Exception:
            pass
    if _brotli is not None and "br" in enc:
        try:
            out = _brotli.compress(raw, quality=5)
            if len(out) < len(raw):
                return out, "br"
        except Exception:
            pass
    if "gzip" in enc:
        try:
            out = _gzip.compress(raw, 6, mtime=0)   # mtime=0 -> byte-stable, so the ETag is stable
            if len(out) < len(raw):
                return out, "gzip"
        except Exception:
            pass
    return raw, None


def _etag_for(raw, enc):
    """Strong ETag over the ORIGINAL bytes, tagged with the coding: two encodings of
    one file are different representations and must not share a validator."""
    h = _hashlib.sha256(raw).hexdigest()[:32]
    return '"%s%s"' % (h, ("-" + enc) if enc else "")


def _etag_core(etag):
    """The content hash inside a tag, with the coding suffix and any W/ removed."""
    t = (etag or "").strip()
    if t.startswith("W/"):
        t = t[2:].strip()
    t = t.strip('"')
    return t.split("-", 1)[0]


def _if_none_match_match(header, etag):
    """-> the client's OWN tag that matches `etag`, or None."""
    if not header:
        return None
    if header.strip() == "*":
        return etag
    want = _etag_core(etag)
    if not want:
        return None
    for cand in header.split(","):
        cand = cand.strip()
        if not cand:
            continue
        bare = cand[2:].strip() if cand.startswith("W/") else cand
        if bare == etag or _etag_core(bare) == want:
            return bare
    return None


def _if_none_match_hit(header, etag):
    return _if_none_match_match(header, etag) is not None


def _static_repr(path, ctype, accept):
    st = os.stat(path)
    key = (str(path), st.st_mtime_ns, st.st_size)
    with _ENC_CACHE_LOCK:
        entry = _ENC_CACHE.get(key)
    if entry is None:
        if st.st_size > _ENC_CACHE_MAX_BYTES:
            return None                      # too big to hold; caller streams it plain
        with open(path, "rb") as fh:
            raw = fh.read()
        entry = {"raw": raw, "etag_raw": _etag_for(raw, None)}
        body, enc = _encode_body(raw, ctype, "gzip", static=True)
        if enc:
            entry["etag_" + enc] = _etag_for(raw, enc)
            entry[enc] = body
        with _ENC_CACHE_LOCK:
            if len(_ENC_CACHE) > 64:
                _ENC_CACHE.clear()           # tiny working set; a stampede is cheaper than a leak
            _ENC_CACHE[key] = entry
        slow = [c for c in _CODINGS if c != "gzip"]
        if slow and enc:

            def fill(entry=entry, raw=raw):
                for coding in slow:
                    b, e = _encode_body(raw, ctype, coding, static=True)
                    if e:
                        with _ENC_CACHE_LOCK:
                            entry["etag_" + e] = _etag_for(raw, e)
                            entry[e] = b

            threading.Thread(target=fill, name="static-compress", daemon=True).start()
    enc_ok = _accepted_encodings(accept)
    with _ENC_CACHE_LOCK:
        etags = [v for k, v in entry.items() if k.startswith("etag_")]
        for coding in _CODINGS:
            if coding in enc_ok and coding in entry:
                return entry[coding], coding, entry["etag_" + coding], len(entry[coding]), etags
        return entry["raw"], None, entry["etag_raw"], len(entry["raw"]), etags


_RENDITION_DIR = settings.STATE_DIR / "renditions"
_RENDITION_WIDTHS = (320, 640, 960, 1280, 1920)      # a closed set; see _rendition()
_RENDITION_LOCK = threading.Lock()
_RENDITION_INFLIGHT = {}


def _rendition_tool():
    if getattr(_rendition_tool, "_cached", None) is None:
        tool = None
        from shutil import which
        if which("vipsthumbnail"):
            tool = "vips"
        else:
            try:
                import PIL  # noqa: F401
                tool = "pil"
            except Exception:
                tool = None
        _rendition_tool._cached = (tool,)
    return _rendition_tool._cached[0]


def _rendition_file(path, st, width):
    """(key, cache file) for `path` at `width`, given its os.stat result."""
    key = _hashlib.sha256(
        ("%s|%d|%d|%d" % (os.path.abspath(path), st.st_mtime_ns, st.st_size, width))
        .encode("utf-8")).hexdigest()[:32]
    return key, _RENDITION_DIR / ("%s.webp" % key)


def _rendition(path, width, source_mime, nice=False):
    """(bytes, mime) for `path` capped at `width`, or None to serve the original."""
    tool = _rendition_tool()
    if tool is None or source_mime == "image/svg+xml":
        return None
    try:
        st = os.stat(path)
    except OSError:
        return None
    key, out = _rendition_file(path, st, width)

    def _use(b):
        return (b, "image/webp") if (b and len(b) < st.st_size) else None

    try:
        if out.is_file() and out.stat().st_size > 0:
            return _use(out.read_bytes())
    except OSError:
        pass
    # one resize per key even under a burst: three lanes render at once on Today
    with _RENDITION_LOCK:
        ev = _RENDITION_INFLIGHT.get(key)
        if ev is None:
            ev = _RENDITION_INFLIGHT[key] = threading.Event()
            mine = True
        else:
            mine = False
    if not mine:
        ev.wait(timeout=20)
        try:
            if out.is_file() and out.stat().st_size > 0:
                return _use(out.read_bytes())
        except OSError:
            pass
        return None
    try:
        _RENDITION_DIR.mkdir(parents=True, exist_ok=True)
        tmp = _RENDITION_DIR / ("%s.%d.part.webp" % (key, os.getpid()))
        if tool == "vips":
            from shutil import which
            subprocess.run(
                (["nice", "-n", "10"] if nice and which("nice") else []) +
                ["vipsthumbnail", str(path), "--size", "%dx" % width,
                 "-o", "%s[Q=80,strip]" % str(tmp)],
                check=True, timeout=30,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        else:
            from PIL import Image
            with Image.open(path) as im:
                im = im.convert("RGB")
                if im.width > width:
                    im.thumbnail((width, im.height * width // im.width), Image.LANCZOS)
                im.save(str(tmp), "WEBP", quality=80, method=4)
        if tmp.is_file() and tmp.stat().st_size > 0:
            os.replace(str(tmp), str(out))      # atomic: a reader never sees a part file
            return _use(out.read_bytes())
    except Exception:
        pass                                    # any failure -> serve the original
    finally:
        try:
            if tmp.is_file():                   # a failed run leaves nothing behind
                tmp.unlink()
        except Exception:
            pass
        with _RENDITION_LOCK:
            _RENDITION_INFLIGHT.pop(key, None)
        ev.set()
    return None


class _HeadSink:
    """A write-through wrapper that swallows a HEAD response's BODY."""

    def __init__(self, wfile):
        self._w = wfile
        self.headers_done = False

    def write(self, b):
        if self.headers_done:
            return len(b)
        return self._w.write(b)

    def flush(self):
        return self._w.flush()

    def __getattr__(self, name):        # everything else is the real socket writer
        return getattr(self._w, name)


_FILE_ID = {}
_FILE_ID_LOCK = threading.Lock()


def _file_identity(path):
    """(md5, bytes, mtime, ageSec) for one served file, or None."""
    try:
        st = os.stat(path)
    except Exception:
        return None
    key = (str(path), st.st_mtime_ns, st.st_size)
    with _FILE_ID_LOCK:
        hit = _FILE_ID.get(key)
    if hit is not None:
        return dict(hit, ageSec=round(time.time() - st.st_mtime, 1))
    try:
        h = _hashlib.md5()
        with open(path, "rb") as fh:
            for chunk in iter(lambda: fh.read(1 << 20), b""):
                h.update(chunk)
    except Exception:
        return None
    val = {"md5": h.hexdigest(), "bytes": st.st_size,
           "mtime": datetime.fromtimestamp(st.st_mtime).isoformat(timespec="seconds")}
    with _FILE_ID_LOCK:
        if len(_FILE_ID) > 32:
            _FILE_ID.clear()
        _FILE_ID[key] = val
    return dict(val, ageSec=round(time.time() - st.st_mtime, 1))


_HASHED_RE = re.compile(r"[.\-_][0-9a-f]{8,}\.(?:js|css)$", re.I)
_CHUNK_SEEN = {}
_CHUNK_VIOLATIONS = []


def _check_immutable_chunks(rows):
    for r in rows:
        name, md5 = r.get("name") or "", r.get("md5") or ""
        if not _HASHED_RE.search(name):
            continue
        prev = _CHUNK_SEEN.get(name)
        if prev and prev != md5:
            msg = ("IMMUTABLE CHUNK CHANGED: %s was %s, now %s -- a hash-named chunk "
                   "must never change content under the same name; the service worker "
                   "caches it cache-first and will serve the old bytes forever"
                   % (name, prev[:12], md5[:12]))
            print("[chunk-guard] " + msg, flush=True)
            if msg not in _CHUNK_VIOLATIONS:
                _CHUNK_VIOLATIONS.append(msg)
                _CHUNK_VIOLATIONS[:] = _CHUNK_VIOLATIONS[-20:]
        _CHUNK_SEEN[name] = md5


_BUNDLE_ID = {"key": None, "val": None}
_BUNDLE_ID_LOCK = threading.Lock()


def _bundle_identity():
    """Which index.html this server is serving: md5, size, mtime."""
    try:
        p = settings.WEB_DIST / "index.html"
        st = p.stat()
    except Exception:
        return None
    key = (st.st_mtime_ns, st.st_size)
    with _BUNDLE_ID_LOCK:
        if _BUNDLE_ID["key"] == key:
            return _BUNDLE_ID["val"]
    try:
        h = _hashlib.md5()
        with open(p, "rb") as fh:
            for chunk in iter(lambda: fh.read(1 << 20), b""):
                h.update(chunk)
        val = {"md5": h.hexdigest(), "bytes": st.st_size,
               "mtime": datetime.fromtimestamp(st.st_mtime).isoformat(timespec="seconds"),
               "ageSec": round(time.time() - st.st_mtime, 1)}
    except Exception:
        return None
    with _BUNDLE_ID_LOCK:
        _BUNDLE_ID["key"], _BUNDLE_ID["val"] = key, val
    return val


def _vary_with(extra):
    parts = ["Accept-Encoding"]
    v = (extra or {}).get("Vary") or (extra or {}).get("vary")
    for piece in str(v or "").split(","):
        piece = piece.strip()
        if piece and piece.lower() not in (p.lower() for p in parts):
            parts.append(piece)
    return ", ".join(parts)


def _warm_bundle():
    """Compress the Board bundle at startup so the first window never pays for it."""
    try:
        p = settings.WEB_DIST / "index.html"
        if p.is_file():
            _static_repr(str(p), "text/html", ", ".join(_CODINGS))
    except Exception:
        pass


def _archived_chunk_path(raw_path):
    """A verified archived chunk for one missing root-level request, or None."""
    try:
        decoded = unquote(urlparse(raw_path).path, errors="strict")
    except (UnicodeDecodeError, ValueError):
        return None
    if len(decoded) < 2 or decoded[0] != "/" or "/" in decoded[1:]:
        return None
    name = decoded[1:]
    if chunkarchive.NAME_RE.fullmatch(name) is None:
        return None
    try:
        return chunkarchive.lookup(name)
    except Exception:
        return None


# ------------------------------------------------------------- HTTP
class Handler(http.server.SimpleHTTPRequestHandler):
    def list_directory(self, path):
        self.send_error(404, "File not found")
        return None

    protocol_version = "HTTP/1.1"
    disable_nagle_algorithm = True
    timeout = 120

    def send_pre_json(self, name, fallback):
        """GET a precomputed value, serialized and compressed ONCE per generation.
        Falls back to the ordinary path when the refresher has nothing yet."""
        p = _PRE.get(name)
        if p is None or p.value is None:
            return self.send_json(200, _pre_get(name, fallback))
        box = p.box
        with box["lock"]:
            raw = box["raw"]
        if raw is None:
            raw = json.dumps(p.value).encode("utf-8")
            with box["lock"]:
                box["raw"] = raw
        return self._send_payload(200, "application/json", raw, box=box)

    _CORS_ORIGINS = frozenset((
        "http://127.0.0.1:%d" % settings.PORT, "http://localhost:%d" % settings.PORT,
    ))
    _CORS_HEADERS = "If-None-Match, Accept-Encoding, Content-Type"

    def _cors_origin(self):
        """The request's Origin when it is one of the Board's own, else None."""
        o = (self.headers.get("Origin") or "").strip()
        return o if o in self._CORS_ORIGINS else None

    def _cors_extra(self, extra=None):
        """Merge the CORS headers into an `extra` dict for _send_payload. Vary carries
        Origin so a cache never serves one origin's response to another."""
        o = self._cors_origin()
        if not o:
            return extra
        out = dict(extra or {})
        out["Access-Control-Allow-Origin"] = o
        out["Access-Control-Expose-Headers"] = "ETag"
        out["Vary"] = "Origin"          # _send_payload appends Accept-Encoding itself
        return out

    def _send_payload(self, code, ctype, raw, cache="no-cache", extra=None, etag_ok=True,
                      box=None):
        accept = self.headers.get("Accept-Encoding")
        extra = self._cors_extra(extra)     # on the 304 path below as well as the 200
        if box is not None:
            # the same bytes for every client that takes the same codings, computed
            # once per generation of the value (see _Pre.box)
            key = frozenset(c for c in _CODINGS if c in _accepted_encodings(accept))
            with box["lock"]:
                hit = box["enc"].get(key)
            if hit is None:
                body, enc = _encode_body(raw, ctype, accept)
                hit = (body, enc, _etag_for(raw, enc) if etag_ok else None)
                with box["lock"]:
                    box["enc"][key] = hit
            body, enc, etag = hit
        else:
            body, enc = _encode_body(raw, ctype, accept)
            etag = _etag_for(raw, enc) if etag_ok else None
        held = (_if_none_match_match(self.headers.get("If-None-Match"), etag)
                if (etag and self.command in ("GET", "HEAD") and code == 200) else None)
        if held:
            self.send_response(304)
            self.send_header("ETag", held)   # the representation the client holds
            self.send_header("Cache-Control", cache)
            self.send_header("Vary", _vary_with(extra))
            for k, v in (extra or {}).items():
                if k.lower() == "vary":
                    continue                # folded into the header above
                self.send_header(k, v)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        if enc:
            self.send_header("Content-Encoding", enc)
        if etag:
            self.send_header("ETag", etag)
        self.send_header("Cache-Control", cache)
        self.send_header("Vary", _vary_with(extra))
        for k, v in (extra or {}).items():
            if k.lower() == "vary":
                continue                    # folded into the header above
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _serve_bundle(self):
        """Static files of the web bundle: compressed,
        revalidated, and cheap on a warm window. Anything this cannot handle falls back
        to SimpleHTTPRequestHandler untouched."""
        # the stock handler has one method per verb; a HEAD must fall back to do_HEAD
        # or the fallback would write a body after headers that promised none
        stock = (super(Handler, self).do_HEAD if self.command == "HEAD"
                 else super(Handler, self).do_GET)

        def fallback():
            try:
                return stock()
            except (UnicodeError, ValueError):
                return self.send_error(404, "File not found")

        try:
            fs = self.translate_path(self.path)
            if os.path.isdir(fs):
                if not urlparse(self.path).path.endswith("/"):
                    return fallback()
                for cand in ("index.html", "index.htm"):
                    p = os.path.join(fs, cand)
                    if os.path.isfile(p):
                        fs = p
                        break
                else:
                    return fallback()
            if not os.path.isfile(fs):
                archived = _archived_chunk_path(self.path)
                if archived is None or not os.path.isfile(archived):
                    return fallback()
                fs = str(archived)
            ctype = self.guess_type(fs)
            if not _compressible(ctype):
                return fallback()            # images/pdf/fonts: let the stock handler stream them
            rep = _static_repr(fs, ctype, self.headers.get("Accept-Encoding"))
            if rep is None:
                return fallback()
            body, enc, etag, length, all_etags = rep
            inm = self.headers.get("If-None-Match")
            held = None
            if self.command in ("GET", "HEAD"):
                for e in all_etags:
                    held = _if_none_match_match(inm, e)
                    if held:
                        break
            if held:
                self.send_response(304)
                self.send_header("ETag", held)   # the representation the client holds
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Vary", "Accept-Encoding")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            if enc:
                self.send_header("Content-Encoding", enc)
            self.send_header("ETag", etag)
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Vary", "Accept-Encoding")
            self.send_header("Content-Length", str(length))
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)
        except Exception:
            try:
                return fallback()
            except Exception:
                pass

    def do_OPTIONS(self):
        if self._gate_refused():
            return
        if not pane_allows("OPTIONS", urlparse(self.path).path):
            return self.send_json(403, {"ok": False,
                                        "error": "read-only pane: this route is not served here"})
        o = self._cors_origin()
        if not o:
            self.send_response(405)
            self.send_header("Allow", "GET, HEAD, POST")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", o)
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", self._CORS_HEADERS)
        self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Vary", "Origin")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_HEAD(self):
        if not pane_allows("HEAD", urlparse(self.path).path):
            return self.send_json(403, {"ok": False,
                                        "error": "read-only pane: this route is not served here"})
        u = urlparse(self.path)
        if u.path.startswith("/v/") or u.path.startswith("/w/"):
            name = u.path[3:].rstrip("/")
            if _FIG_SESSION_PATH.match(u.path):
                name = "figure"
            elif _DIAGRAM_PATH.match(u.path):
                name = "diagram"
            allowed = BOARD_VIEWS if u.path[1] == "v" else BOARD_WIDGETS
            if name in allowed:
                self.path = "/"
        real = self.wfile
        sink = _HeadSink(real)
        self._head_sink = sink
        self.wfile = sink
        try:
            return self.do_GET()
        finally:
            self.wfile = real
            self._head_sink = None

    def send_json(self, code, obj):
        payload = json.dumps(obj).encode("utf-8")
        self._send_payload(code, "application/json", payload)

    def _json_post(self, limit=64 * 1024):
        ct = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        if ct != "application/json":
            return None, (415, {"error": "Content-Type must be application/json"})
        try:
            length = int(self.headers.get("Content-Length", 0) or 0)
        except ValueError:
            length = 0
        if length > limit:
            return None, (413, {"error": "body too large (%d B > %d B)" % (length, limit)})
        raw = self.rfile.read(limit + 1) if length <= 0 else self.rfile.read(length)
        if len(raw) > limit:
            return None, (413, {"error": "body too large"})
        try:
            data = json.loads(raw or b"{}")
        except ValueError:
            return None, (400, {"error": "bad json"})
        if not isinstance(data, dict):
            return None, (400, {"error": "bad json"})
        return data, None

    def _note_json(self, limit=64 * 1024):
        """-> (data, None) or (None, (code, body)). The notes move/undo body: size-
        capped like _json_post, with Content-Type left to _gate_refused (the same
        rule every other /note/ POST already passes)."""
        try:
            length = int(self.headers.get("Content-Length", 0) or 0)
        except ValueError:
            length = 0
        if length > limit:
            return None, (413, {"ok": False, "error": "body too large"})
        try:
            data = json.loads(self.rfile.read(length) or b"{}") if length > 0 else {}
        except ValueError:
            return None, (400, {"ok": False, "error": "bad json"})
        if not isinstance(data, dict):
            return None, (400, {"ok": False, "error": "bad json"})
        return data, None

    _BOARD_ORIGIN_RE = re.compile(r"^https?://(?:localhost|127\.0\.0\.1)(?::\d+)?(?:/|$)", re.I)

    def _panel(self, u, q):
        bad = panel.refuse(self.headers.get("Host"), self.headers.get("Origin"),
                           PORT, self._CORS_ORIGINS)
        if bad:
            if u.path == "/w/panel/coding/media":
                return self._media_json(bad[0], bad[1])
            return self.send_json(bad[0], bad[1])
        cross = (self.headers.get("Sec-Fetch-Site") or "").strip().lower() == "cross-site"
        if cross and u.path.startswith("/w/panel/coding/"):
            refused = {"ok": False, "error": "cross-site request refused"}
            if u.path == "/w/panel/coding/media":
                return self._media_json(403, refused)
            return self.send_json(403, refused)
        if self.command == "POST" and u.path.startswith("/w/panel/coding/"):
            if (self.headers.get("Origin") or "").strip() not in self._CORS_ORIGINS:
                return self.send_json(403, {"ok": False, "error": "the Board page only"})
            data, err = self._json_post(limit=256 * 1024)
            if err:
                return self.send_json(err[0], err[1])
            code, body = coding.handle_post(VAULT, u.path, data)
            return self.send_json(code, body)
        if self.command == "POST":
            if u.path != "/w/panel/event":
                return self.send_json(404, {"ok": False, "error": "unknown panel route"})
            data, err = self._json_post(limit=64 * 1024)
            if err:
                return self.send_json(err[0], err[1])
            if cross and isinstance(data, dict) and data.get("kind") == "coding":
                return self.send_json(403, {"ok": False, "error": "cross-site request refused"})
            code, body = panel.post_event(VAULT, data)
            return self.send_json(code, body)
        if u.path == "/w/panel/coding/media":
            return self._panel_media(q)
        if u.path.startswith("/w/panel/coding/"):
            code, body = coding.handle_get(VAULT, u.path, q)
            return self.send_json(code, body)
        if u.path == "/w/panel/pdf":
            return self._panel_pdf(q)
        code, body, no_store = panel.handle_get(VAULT, u.path, q, PORT)
        if no_store:
            return self._send_payload(code, "application/json",
                                      json.dumps(body).encode("utf-8"),
                                      cache="no-store", etag_ok=False)
        return self.send_json(code, body)

    def _panel_pdf(self, q):
        """GET /w/panel/pdf?hub_rel=… | ?project=&rel=  [&v=]  -- the Reader tab's PDF."""
        p, stamp, err = panel.pdf_request(VAULT, q)
        if p is None:
            return self.send_json(err[0], {"ok": False, "error": err[1]})
        try:
            size = p.stat().st_size
        except OSError:
            return self.send_json(404, {"ok": False, "error": "no such pdf"})
        # no dash in the tag: _if_none_match_match reads a tag only up to its first dash,
        # so "pdf-<stamp>" matched every other pdf's tag and an edited file came back 304
        etag = '"pdf.%s"' % (stamp or str(size)).replace("-", ".")
        ver = (q.get("v") or [""])[0]
        cache = ("private, max-age=31536000, immutable" if (ver and stamp and ver == stamp)
                 else "no-cache")
        common = {
            "ETag": etag, "Cache-Control": cache, "Accept-Ranges": "bytes",
            "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
            "Cross-Origin-Resource-Policy": "same-origin",
            "Content-Security-Policy": "frame-ancestors 'self'",
            "Content-Disposition": "inline; filename*=UTF-8''" + quote(p.name, safe=""),
        }
        return self._send_ranged(p, "application/pdf", common)

    _MEDIA_GUARD = {"Cross-Origin-Resource-Policy": "same-origin",
                    "X-Content-Type-Options": "nosniff"}

    def _media_json(self, code, body):
        return self._send_payload(code, "application/json", json.dumps(body).encode("utf-8"),
                                  extra=dict(self._MEDIA_GUARD))

    def _panel_media(self, q):
        code, m = coding.media_request(VAULT, q)
        if code != 200:
            return self._media_json(code, m)
        common = {
            "ETag": m["etag"], "Cache-Control": m["cache"], "Accept-Ranges": "bytes",
            "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
            "Cross-Origin-Resource-Policy": "same-origin",
            "Content-Security-Policy": "default-src 'none'; frame-ancestors 'self'",
            "Content-Disposition": "inline",
        }
        return self._send_ranged(m["path"], m["mime"], common, guard=dict(
            self._MEDIA_GUARD, **{"Accept-Ranges": "bytes"}))

    def _send_ranged(self, p, ctype, common, guard=None):
        try:
            fh = open(p, "rb")
        except OSError:
            return self._send_payload(404, "application/json",
                                      json.dumps({"ok": False, "error": "no such file"}).encode("utf-8"),
                                      extra={k: v for k, v in (guard or {}).items() if k != "Accept-Ranges"})
        with fh:
            size = os.fstat(fh.fileno()).st_size
            etag = common["ETag"]
            if _if_none_match_match(self.headers.get("If-None-Match"), etag):
                self.send_response(304)
                for k, v in common.items():
                    self.send_header(k, v)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            start, end, status = 0, size - 1, 200
            rng = (self.headers.get("Range") or "").strip()
            if rng:
                m = re.match(r"^bytes=(\d{0,19})-(\d{0,19})$", rng)
                if not m or (not m.group(1) and not m.group(2)):
                    m = None
                else:
                    if m.group(1):
                        start = int(m.group(1))
                        end = min(int(m.group(2)), size - 1) if m.group(2) else size - 1
                    else:
                        start = max(0, size - int(m.group(2)))
                    if start > end or start >= size:
                        m = None
                if m is None:
                    self.send_response(416)
                    self.send_header("Content-Range", "bytes */%d" % size)
                    for k, v in (guard or {}).items():
                        self.send_header(k, v)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                status = 206
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            for k, v in common.items():
                self.send_header(k, v)
            if status == 206:
                self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
            self.send_header("Content-Length", str(end - start + 1))
            self.end_headers()
            if self.command == "HEAD":
                return
            left = end - start + 1
            try:
                fh.seek(start)
                while left > 0:
                    chunk = fh.read(min(256 * 1024, left))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    left -= len(chunk)
            except OSError:
                pass
            finally:
                if left > 0:
                    self.close_connection = True
    # ---- end viewer panel -------------------------------------------------------

    # Routes that act on the desktop or steer another window. POST only, and only
    # from the app's own page: the browser must send Sec-Fetch-Site: same-origin.
    _ACTION_PATHS = frozenset(("/open", "/obsidian/open", "/open-url", "/present/open",
                               "/w/figure/select", "/explore/select", "/explore/selection",
                               "/drafting/outline-pdf"))
    _MAX_BODY = 64 * 1024 * 1024

    @classmethod
    def _is_action(cls, path):
        return path in cls._ACTION_PATHS or path.startswith("/drafting/open-")

    _peer_uid_seen = None

    def _peer_is_me(self):
        uid = self._peer_uid_seen
        if uid is None:
            try:
                uid = _peer_uid(self.client_address, self.connection.getsockname())
            except Exception:
                uid = None
            self._peer_uid_seen = uid
        return uid is not None and uid == os.getuid()

    def _gate_refused(self):
        """True when the request was refused (the answer is already sent)."""
        origin = (self.headers.get("Origin") or "").strip()
        site = (self.headers.get("Sec-Fetch-Site") or "").strip().lower()
        err = None
        if not self._peer_is_me():
            err = (403, "caller is not this user")
        elif not panel.host_ok(self.headers.get("Host"), PORT, self._CORS_ORIGINS):
            err = (403, "bad Host header")
        elif self.command in ("GET", "HEAD", "OPTIONS"):
            site_ok = (site in ("", "none", "same-origin")
                       or (site == "same-site" and origin in self._CORS_ORIGINS))
            if not site_ok:
                err = (403, "cross-site request refused")
        else:
            ct = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
            if (origin and origin not in self._CORS_ORIGINS) or site == "cross-site":
                err = (403, "cross-origin request refused")
            elif ct != "application/json" and not origin:
                err = (415, "Content-Type must be application/json")
            elif self._is_action(urlparse(self.path).path) and site != "same-origin":
                err = (403, "this route answers the app's own page only")
        if err is None:
            return False
        self.close_connection = True      # any unread body must not frame a next request
        self.send_json(err[0], {"ok": False, "error": err[1]})
        return True

    def _fail(self, exc):
        """A handler raised. Log it, answer 500 when nothing has gone out yet, and
        drop the connection either way."""
        print("[error] %s %s: %s: %s" % (self.command, urlparse(self.path).path,
                                         type(exc).__name__, exc), file=sys.stderr, flush=True)
        self.close_connection = True
        if getattr(self, "_status", None) is None:
            try:
                self.send_json(500, {"ok": False, "error": "internal error"})
            except Exception:
                pass

    def do_GET(self):
        try:
            return self._do_GET()
        except (ConnectionError, TimeoutError):
            raise
        except Exception as e:
            return self._fail(e)

    def _no_content(self):
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _action(self, u, q, act):
        """The action routes. `act` is False for a GET, which only resolves the
        target (dry=1) and never opens or changes anything."""
        def arg(name, default=""):
            return (q.get(name) or [default])[0]
        dry = _dry(q) or not act

        def opened(target, is_url=False, **more):
            if dry:
                shown = {"url": target} if is_url else {"path": home_path(target)}
                return self.send_json(200, {"ok": True, "dry": True, **shown, **more})
            open_uri(str(target))
            return self.send_json(200, {"ok": True, **more})

        if u.path in ("/w/figure/select", "/explore/select"):
            sel = {
                "ts": time.time(),
                "source": "project" if arg("source", "open") == "project" else "open",
                "id": arg("id").strip(),
                "slug": arg("slug").strip(),
                "stem": (arg("stem") or arg("name")).strip(),
                "session": arg("session").strip(),
                "project": arg("project").strip(),
            }
            if sel["source"] == "open" and not explore.ID_RE.match(sel["id"]):
                return self.send_json(400, {"error": "bad figure id"})
            if sel["source"] == "project" and not (sel["slug"] and sel["stem"]):
                return self.send_json(400, {"error": "slug and name required"})
            if sel["session"] and not _FIG_SESSION_RE.match(sel["session"]):
                return self.send_json(400, {"error": "bad session"})
            if len(sel["project"]) > 200 or any(ord(c) < 32 for c in sel["project"]):
                return self.send_json(400, {"error": "bad project"})
            _fig_select_put(sel)
            return self.send_json(200, {"ok": True, **sel})

        if u.path == "/explore/selection":
            sessions = [s.strip() for s in (q.get("session") or [])[:4]
                        if _FIG_SESSION_RE.match(s.strip())]
            cur = _fig_select_take(sessions, arg("project"), True)
            return self._send_payload(200, "application/json", json.dumps(cur).encode("utf-8"),
                                      cache="no-store", etag_ok=False)

        if u.path == "/open":
            f = arg("file")
            if f and ".." not in f.split("/") and f.lstrip("/").startswith(READING_PREFIX):
                open_uri("obsidian://open?vault=" + quote(VAULT_ID, safe="") + "&file=" + quote(f))
            return self._no_content()

        if u.path == "/open-url":
            url = arg("url")
            if url and urlparse(url).scheme in ("http", "https"):
                open_uri(url)
            return self._no_content()

        if u.path == "/obsidian/open":
            status, body = obsidian_open(q, act)
            return self.send_json(status, body)

        if u.path == "/present/open":
            route = "audience?slug=%s&deck=%s" % (quote(arg("slug")), quote(arg("deck")))
            open_uri("http://localhost:%d/#/%s" % (PORT, route))
            return self.send_json(200, {"ok": True, "target": "browser"})

        if u.path == "/drafting/outline-pdf":
            slug, doc = arg("slug"), arg("doc", "paper.md")
            p, err = outline_pdf.build(VAULT, slug, doc)
            if err:
                return self.send_json(400, {"error": err})
            if arg("open") in ("1", "true"):
                open_uri("http://localhost:%d/drafting/outline-pdf?slug=%s&doc=%s&inline=1"
                         % (PORT, quote(slug), quote(doc)))
            return self.send_json(200, {"ok": True})

        if u.path == "/drafting/open-dir":
            which = arg("which", "project")
            proj = drafting._project_dir(VAULT, arg("slug"))
            if not proj:
                return self.send_json(404, {"error": "unknown project"})
            if which == "project":
                target = proj
            elif which == "writing":
                target = proj / "writing"
            else:
                return self.send_json(400, {"error": "which is project or writing"})
            if not target.is_dir():
                return self.send_json(404, {"error": "no such folder yet"})
            return opened(target)

        if u.path == "/drafting/open-report":
            p = drafting.report_html_path(VAULT, arg("id"))
            if not p:
                return self.send_json(404, {"error": "no report found"})
            return opened(p)

        if u.path == "/drafting/open-preview":
            url = drafting.doc_preview_url(VAULT, arg("slug"), arg("doc", "report.md"))
            if not url:
                return self.send_json(404, {"error": "no preview url"})
            return opened(url, is_url=True)

        if u.path == "/drafting/open-measure":
            p = drafting.measure_path(VAULT, arg("id"))
            if not p or not p.is_file():
                return self.send_json(404, {"error": "not found"})
            return opened(p)

        if u.path == "/drafting/open-pdf":
            p = drafting.pdf_path(VAULT, arg("slug"), arg("doc", "paper.md"),
                                  which=arg("which", "paper"))
            if not p:
                return self.send_json(404, {"error": "no compiled PDF yet — Publish first"})
            return opened(p, rel=drafting._rel(VAULT, p))

        if u.path == "/drafting/open-docx":
            p = drafting.docx_path(VAULT, arg("slug"), arg("doc", "paper.md"),
                                   which=arg("which", "paper"))
            if not p:
                return self.send_json(404, {"error": "no compiled .docx yet — Publish to Word first"})
            return opened(p, rel=drafting._rel(VAULT, p))

        if u.path == "/drafting/open-diff-pdf":
            p = drafting.diff_pdf_path(VAULT, arg("slug"), arg("doc", "paper.md"))
            if not p:
                return self.send_json(404, {"error": "no diff PDF yet — compile one first"})
            return opened(p, rel=drafting._rel(VAULT, p))

        return self.send_json(404, {"error": "unknown route"})

    def _do_GET(self):
        if urlparse(self.path).path == "/favicon.ico":
            self.send_response(204); self.send_header("Content-Length", "0"); self.end_headers(); return
        if self._gate_refused():
            return
        if urlparse(self.path).path == "/dashboard-data.json":      # the cache lives in the state dir
            try:
                return self._send_payload(200, "application/json", (HERE / "dashboard-data.json").read_bytes())
            except OSError:
                return self.send_json(404, {"error": "cache not built yet"})
        if not pane_allows("GET", urlparse(self.path).path):
            return self.send_json(403, {"ok": False,
                                        "error": "read-only pane: this route is not served here"})
        u = urlparse(self.path)
        q = parse_qs(u.query)

        if u.path == "/explore/selection":
            # a read: the newest selection, left in place (POST takes it)
            sessions = [s.strip() for s in (q.get("session") or [])[:4]
                        if _FIG_SESSION_RE.match(s.strip())]
            cur = _fig_select_take(sessions, (q.get("project") or [""])[0], False)
            return self._send_payload(200, "application/json",
                                      json.dumps(cur).encode("utf-8"),
                                      cache="no-store", etag_ok=False)

        if self._is_action(u.path) and u.path != "/drafting/outline-pdf":
            # a GET never acts; with dry=1 it resolves what a POST would open
            if _dry(q) and (u.path == "/obsidian/open" or u.path.startswith("/drafting/open-")):
                return self._action(u, q, act=False)
            return self._send_payload(405, "application/json",
                                      json.dumps({"ok": False, "error": "POST only"}).encode("utf-8"),
                                      extra={"Allow": "POST"})

        if u.path == "/w/figure/project":
            res = explore.project_gallery(VAULT, (q.get("slug") or [""])[0])
            return self.send_json(200 if not res.get("error") else 404, res)

        if u.path == "/w/figure/project/img":
            data, ctype, err = explore.project_image(
                VAULT, (q.get("slug") or [""])[0], (q.get("rel") or [""])[0])
            if err:
                return self.send_json(404, err)
            ver = (q.get("v") or [""])[0]
            stamp = explore.project_image_stamp(
                VAULT, (q.get("slug") or [""])[0], (q.get("rel") or [""])[0])
            etag = '"pg-%s"' % _hashlib.sha1((ctype + (stamp or str(len(data)))).encode("utf-8")).hexdigest()[:20]
            if self.headers.get("If-None-Match") == etag:
                self.send_response(304)
                self.send_header("ETag", etag)
                self.end_headers()
                return
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("ETag", etag)
            self.send_header("Cache-Control",
                             "public, max-age=31536000, immutable"
                             if (ver and stamp and ver == stamp) else "no-cache")
            self.end_headers()
            self.wfile.write(data)
            return

        if u.path == "/w/figure/project/preview":
            bad = panel.refuse(self.headers.get("Host"), self.headers.get("Origin"),
                               PORT, self._CORS_ORIGINS)
            if bad:
                return self.send_json(bad[0], bad[1])
            pslug = (q.get("slug") or [""])[0]
            prel = (q.get("rel") or [""])[0]
            ver = (q.get("v") or [""])[0]
            stamp = explore.project_image_stamp(VAULT, pslug, prel)
            etag = '"pv-%s"' % _hashlib.sha1(("webp" + (stamp or "")).encode("utf-8")).hexdigest()[:20]
            if stamp and self.headers.get("If-None-Match") == etag:
                self.send_response(304)
                self.send_header("ETag", etag)
                self.end_headers()
                return
            data, ctype, err = explore.project_preview(VAULT, pslug, prel)
            if err:
                return self.send_json(404, err)
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("ETag", etag)
            self.send_header("Cache-Control",
                             "public, max-age=31536000, immutable"
                             if (ver and stamp and ver == stamp) else "no-cache")
            self.end_headers()
            self.wfile.write(data)
            return

        if u.path.startswith("/w/figure/project/html") or u.path == "/w/figure/project/asset":
            bad = panel.refuse(self.headers.get("Host"), self.headers.get("Origin"),
                               PORT, self._CORS_ORIGINS)
            if bad:
                return self.send_json(bad[0], bad[1])
            slug = (q.get("slug") or [""])[0]
            rel = (q.get("rel") or [""])[0]
            kind = "asset" if u.path == "/w/figure/project/asset" else "html"
            if u.path.startswith("/w/figure/project/html/"):
                seg = [unquote(s) for s in u.path[len("/w/figure/project/html/"):].split("/")]
                slug, rel = seg[0], explore.interactive_rel("/".join(seg[1:]))
                kind = "asset" if rel.lower().endswith(".js") else "html"
            elif u.path != "/w/figure/project/html" and kind != "asset":
                return self.send_json(404, {"error": "unknown route"})
            data, ctype, err = explore.project_interactive(VAULT, slug, rel, kind)
            if err:
                return self.send_json(404, err)
            # the image route's stamp rule exactly: `immutable` ONLY when `v` is the
            # file's own `<mtime_ns hex>-<size hex>`, else revalidate.
            ver = (q.get("v") or [""])[0]
            stamp = explore.project_interactive_stamp(VAULT, slug, rel, kind)
            cache = ("public, max-age=31536000, immutable"
                     if (ver and stamp and ver == stamp) else "no-cache")
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            if kind == "html":
                self.send_header("Content-Security-Policy", explore.INTERACTIVE_CSP)
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Cross-Origin-Resource-Policy",
                             "same-origin" if kind == "html" else "cross-origin")
            self.send_header("Cache-Control", cache)
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(data)
            return
        # ---- end interactive figures --------------------------------------------
        # ---- end project gallery -----------------------------------------------

        # the Data and Tables panes (see _panel above). Matched BEFORE the /w/ shell
        # branch, which would otherwise 404 them as an unknown widget.
        if u.path.startswith("/w/panel/"):
            return self._panel(u, q)

        if u.path.startswith("/v/") or u.path.startswith("/w/"):
            # the SPA shell under a per-window path. Delegating with self.path="/"
            # returns byte-for-byte what the root serves, same headers and all.
            name = u.path[3:].rstrip("/")
            if _FIG_SESSION_PATH.match(u.path):
                name = "figure"            # /w/figure/s/<session>: the same pane shell
            elif _DIAGRAM_PATH.match(u.path):
                name = "diagram"           # /w/diagram/t|o/<slug>: the same diagram shell
            allowed = BOARD_VIEWS if u.path[1] == "v" else BOARD_WIDGETS
            if name not in allowed:
                kind = "view" if u.path[1] == "v" else "widget"
                return self.send_json(404, {"error": "unknown " + kind + ": " + name})
            self.path = "/"
            return self._serve_bundle()

        if u.path == "/glimpse":
            body, ms = glimpse.response()
            return self._send_payload(200, "application/json", body,
                                      extra={"X-Glimpse-Ms": ms})
        # ---- end glimpse ----

        if u.path == "/theme.css":
            return self._send_payload(200, "text/css; charset=utf-8", b"")

        if u.path == "/theme.json":
            return self.send_json(200, {})

        if u.path == "/surface":
            return self.send_json(200, _surface_info())

        if u.path == "/note/inbox":
            # notes still sitting in Preparation/Notes/Inbox. Newest first.
            items = notes_organizer.list_inbox()
            return self.send_json(200, {"count": len(items), "items": items})

        if u.path == "/notes/all":
            # every filed note (Authors/Concepts/Ideas/Reflections) with its
            # frontmatter, so the Notes view can search the library by title/tag/type.
            items = notes_organizer.list_all()
            return self.send_json(200, {"count": len(items), "items": items})

        if u.path == "/notes/graph":
            return self.send_json(200, notes_organizer.graph())

        if u.path == "/notes/search":
            query = (q.get("q") or [""])[0].strip()
            try:
                limit = max(1, min(160, int((q.get("limit") or ["80"])[0])))
            except ValueError:
                limit = 80
            if not query:
                return self.send_json(200, {"nodes": [], "count": 0})
            nodes = notes_organizer.search_notes(query, min(40, limit))
            seen_ids = {n["id"] for n in nodes}
            remaining = max(0, limit - len(nodes))
            cit_nodes = []
            if remaining:
                for h in citationindex.search(HERE, query, limit=remaining):
                    kind = h.get("kind") or "citation"
                    rel = h.get("rel") or ""
                    stem = Path(rel).stem if rel else (h.get("stem") or "")
                    yr = h.get("year")
                    title = h.get("title") or stem
                    label = f"{title} ({yr})" if yr and str(yr) not in title else title
                    if kind == "citation" and rel:
                        if rel in seen_ids:
                            continue
                        seen_ids.add(rel)
                        cit_nodes.append({
                            "id": rel, "title": label, "folder": "Citations", "type": "citation",
                            "tags": (h.get("tags") or [])[:6], "path": rel, "mtime": 0,
                            "ghost": False, "external": False, "degree": 0, "orphan": False,
                        })
                        continue
                    nid = "ext:" + (notes_organizer._norm_key(stem) or notes_organizer._norm_key(h.get("title") or ""))
                    if nid == "ext:" or nid in seen_ids:
                        continue
                    seen_ids.add(nid)
                    cit_nodes.append({
                        "id": nid, "title": label, "folder": "Clippings",
                        "type": kind, "tags": (h.get("tags") or [])[:6],
                        "path": rel, "mtime": 0, "ghost": False, "external": True,
                        "degree": 0, "orphan": False,
                    })
            return self.send_json(200, {"nodes": nodes + cit_nodes, "count": len(nodes) + len(cit_nodes)})

        if u.path == "/note/read":
            # one filed note's metadata + body, for the graph drawer (read/edit).
            rel = (q.get("path") or [""])[0]
            r = notes_organizer.read_note(rel)
            return self.send_json(200 if r.get("ok") else 404, r)

        if u.path == "/notes/related":
            # semantically nearest filed notes (cosine over the embedding cache) for the
            # graph drawer's "Related notes" panel. Empty list when no vectors exist.
            rel = (q.get("path") or [""])[0]
            try:
                k = max(1, min(12, int((q.get("k") or ["6"])[0])))
            except ValueError:
                k = 6
            return self.send_json(200, {"related": notes_organizer.related(rel, k) if rel else []})

        if u.path == "/notes/blocks":
            # a note's `##` sections as typed blocks (text | image | diagram) so the
            # Notes view can edit one section at a time instead of the whole body
            r = notes_blocks.read_blocks((q.get("path") or [""])[0])
            return self.send_json(200 if r.get("ok") else 404, r)

        if u.path == "/notes/attachment":
            # a note's embedded image as raw bytes, confined to Notes/attachments
            # (mirrors /drafting/asset; that one is confined to a paper's results/)
            data, ctype = notes_blocks.read_attachment((q.get("name") or [""])[0])
            if data is None:
                return self.send_json(404, {"error": "not found"})
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.write(data)
            return

        if u.path == "/notes/diagram":
            # the .excalidraw scene behind a diagram block, for the canvas editor
            scene = notes_blocks.read_diagram((q.get("name") or [""])[0])
            if scene is None:
                return self.send_json(404, {"error": "not found"})
            return self.send_json(200, scene)

        if u.path == "/notes/canvas":
            # is the Excalidraw drawing surface deployed? the Notes view hides its
            # drawing affordances when it isn't, and falls back to Obsidian
            return self.send_json(200, {"available": notes_blocks.canvas_available()})

        if u.path == "/notes/diagrams":
            items = notes_blocks.list_diagrams()
            return self.send_json(200, {"count": len(items), "items": items})

        if u.path == "/notes/drawer":
            res = notes_blocks.read_drawer((q.get("name") or [""])[0])
            return self.send_json(200 if res.get("ok") else 404, res)

        if u.path == "/notes/drawer-templates":
            items = notes_blocks.list_templates()
            return self.send_json(200, {"count": len(items), "items": items})

        if u.path == "/app/overview":
            return self.send_json(200, all_in_one_academic.overview())

        if u.path == "/app/authors":
            query = (q.get("q") or [""])[0].strip()
            sort = (q.get("sort") or ["works"])[0]
            return self.send_json(200, all_in_one_academic.authors(query, sort))

        if u.path == "/app/author":
            key = (q.get("key") or [""])[0].strip()
            r = all_in_one_academic.author_detail(key)
            return self.send_json(200 if r.get("ok") else 404, r)

        if u.path == "/app/citations":
            def _int(name, default=0):
                try:
                    return int((q.get(name) or [str(default)])[0])
                except ValueError:
                    return default
            return self.send_json(200, all_in_one_academic.citations_list(
                q=(q.get("q") or [""])[0].strip(),
                tag=(q.get("tag") or [""])[0].strip(),
                status=(q.get("status") or [""])[0].strip(),
                stype=(q.get("type") or [""])[0].strip(),
                author=(q.get("author") or [""])[0].strip(),
                year_from=_int("from"), year_to=_int("to"),
                sort=(q.get("sort") or ["-year"])[0],
                offset=_int("offset"), limit=_int("limit", 100)))

        if u.path == "/app/meetings":
            return self.send_json(200, all_in_one_academic.meetings_list())

        if u.path == "/app/projects":
            name = (q.get("name") or [""])[0].strip()
            return self.send_json(200, all_in_one_academic.project_notes(name) if name else all_in_one_academic.projects_list())

        if u.path == "/app/author-notes":
            # every note under Notes/Authors/**, as a flat list (the profile index
            # only matches bios to citation surnames; a filed note must still show)
            return self.send_json(200, all_in_one_academic.author_notes())

        if u.path == "/notes/project-targets":
            return self.send_json(200, notes_organizer.project_targets())

        if u.path == "/notes/project":
            r = notes_organizer.project_notes_of((q.get("key") or [""])[0])
            if not r.pop("ok", False):
                return self.send_json(404, r)
            return self.send_json(200, r)

        if u.path == "/note/history":
            try:
                limit = max(1, min(200, int((q.get("limit") or ["20"])[0])))
            except ValueError:
                limit = 20
            return self.send_json(200, notes_organizer.history(limit))

        if u.path == "/notes/archived":
            return self.send_json(200, notes_organizer.list_archived())

        # ---- whole-vault search (vault_search.py). Degrades to 503, never crashes.
        if u.path in ("/search/vault", "/search/vault/status"):
            vs = _vault_search_mod()
            if vs is None:
                return self.send_json(503, {"ok": False, "error": "vault search unavailable"})
            try:
                if u.path == "/search/vault/status":
                    return self.send_json(200, vs.status())
                try:
                    limit = max(1, min(200, int((q.get("limit") or ["40"])[0])))
                except ValueError:
                    limit = 40
                scope = (q.get("scope") or [""])[0].strip() or None
                return self.send_json(200, vs.search((q.get("q") or [""])[0][:500],
                                                     limit=limit, scope=scope))
            except Exception as e:
                return self.send_json(500, {"ok": False, "error": "vault search failed: %s" % type(e).__name__})

        # ---- claim-level search over the citation notes (claims_index.py). Read-only;
        # degrades to 503, never crashes.
        if u.path in ("/claims/search", "/claims/claim", "/claims/related", "/claims/stats"):
            ci = _claims_mod()
            if ci is None:
                return self.send_json(503, {"ok": False, "error": "claims index unavailable"})
            try:
                if u.path == "/claims/stats":
                    return self.send_json(200, ci.stats())
                if u.path in ("/claims/claim", "/claims/related"):
                    cid = (q.get("id") or [""])[0][:1000]
                    r = ci.claim(cid) if u.path == "/claims/claim" else ci.related(cid)
                    return self.send_json(404 if r.get("error") == "NotFound" else 200, r)
                try:
                    limit = max(1, min(200, int((q.get("limit") or ["40"])[0])))
                except ValueError:
                    limit = 40
                filters = {k: (q.get(k) or [""])[0][:200] for k in (
                    "concept", "kind", "strength", "tag", "project", "year_from", "year_to",
                    "has_evidence", "paper", "author")}
                return self.send_json(200, ci.search((q.get("q") or [""])[0][:500],
                                                     limit=limit, filters=filters))
            except Exception as e:
                return self.send_json(500, {"ok": False, "error": type(e).__name__})

        if u.path == "/drafting/papers":
            return self.send_pre_json(
                "drafting_papers", lambda: {"papers": drafting.list_papers(VAULT)})

        if u.path == "/drafting/presentations":
            return self.send_pre_json(
                "drafting_presentations",
                lambda: {"presentations": drafting.list_presentations(VAULT)})

        if u.path == "/drafting/reports":
            return self.send_pre_json(
                "drafting_reports", lambda: {"reports": drafting.list_reports(VAULT)})

        if u.path == "/drafting/grants":
            return self.send_pre_json(
                "drafting_grants", lambda: {"grants": drafting.list_grants(VAULT)})

        if u.path == "/planning/pipeline":
            lists = {
                "papers": _pre_get("drafting_papers",
                                   lambda: {"papers": drafting.list_papers(VAULT)}).get("papers"),
                "grants": _pre_get("drafting_grants",
                                   lambda: {"grants": drafting.list_grants(VAULT)}).get("grants"),
            }
            return self.send_json(200, {"items": planning.pipeline(VAULT, lists=lists,
                                                                   events=scan_events()),
                                        "week": planning.iso_week()})

        if u.path == "/planning/commitments":
            # the one commitments reader: ledger, deadline events and the hard
            # milestones of finalized plans, soonest first
            return self.send_json(200, {"commitments": planning.commitments(
                VAULT, events=scan_events())})

        if u.path == "/planning/countdown":
            # the nearest open commitment; {} when there is none
            return self.send_json(200, planning.countdown(VAULT, events=scan_events()))

        if u.path == "/drafting/report":
            res = drafting.read_report(VAULT, (q.get("id") or [""])[0])
            return self.send_json(200 if not res.get("error") else 404, res)

        if u.path == "/drafting/report-visual":
            res = drafting.report_visual(VAULT, (q.get("slug") or [""])[0])
            return self.send_json(200 if not res.get("error") else 404, res)

        if u.path == "/drafting/measures":
            return self.send_pre_json(
                "drafting_measures", lambda: {"measures": drafting.list_measures(VAULT)})

        if u.path == "/drafting/syllabi":
            return self.send_pre_json(
                "drafting_syllabi", lambda: {"syllabi": drafting.list_syllabi(VAULT)})

        if u.path == "/drafting/syllabus-text":
            # full markdown (frontmatter included) for the in-app editor
            res = drafting.read_syllabus_text(VAULT, (q.get("id") or [""])[0])
            return self.send_json(200 if not res.get("error") else 404, res)

        if u.path == "/drafting/syllabus-pdf":
            # the rendered PDF beside the source, streamed for the
            # in-app iframe viewer (same pattern as measure-pdf)
            p = drafting._syllabus_pdf_path(VAULT, (q.get("id") or [""])[0])
            if not p or not p.is_file():
                return self.send_json(404, {"error": "no rendered PDF — render first"})
            try:
                data = p.read_bytes()
            except OSError:
                return self.send_json(404, {"error": "could not read the PDF"})
            self.send_response(200)
            self.send_header("Content-Type", "application/pdf")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.write(data)
            return

        if u.path == "/drafting/syllabus-lists":
            # the formatted lists available for a syllabus's `include-lists:` picker
            # + each list's board-push section map
            try:
                rows = []
                if syllabi.LISTS_DIR.is_dir():
                    for f in sorted(syllabi.LISTS_DIR.iterdir()):
                        if f.suffix.lower() == ".md" and not f.name.startswith((".", "_")):
                            d = syllabi.parse_list(f)
                            rows.append({
                                "slug": f.stem,
                                "title": d["meta"].get("title") or f.stem,
                                "sections": [{"i": i, "name": s["name"],
                                              "readings": len(s["readings"])}
                                             for i, s in enumerate(d["sections"])],
                                "readings": sum(len(s["readings"]) for s in d["sections"]),
                            })
                return self.send_json(200, {"lists": rows})
            except Exception as e:
                return self.send_json(500, {"error": str(e)})

        if u.path == "/drafting/measure-pdf":
            p = drafting.measure_preview_pdf(VAULT, (q.get("id") or [""])[0])
            if not p:
                return self.send_json(404, {"error": "no PDF preview for this file"})
            try:
                data = p.read_bytes()
            except OSError:
                return self.send_json(404, {"error": "could not read the PDF"})
            self.send_response(200)
            self.send_header("Content-Type", "application/pdf")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.write(data)
            return

        if u.path == "/drafting/measure-text":
            res = drafting.read_measure_text(VAULT, (q.get("id") or [""])[0])
            return self.send_json(200 if not res.get("error") else 404, res)

        if u.path == "/drafting/deck":
            # render a Marp deck to per-slide SVGs (+ css) + speaker notes + the review
            # sidecar, for the flick-through-and-comment Deck viewer
            res = drafting.render_deck(VAULT, (q.get("slug") or [""])[0], (q.get("deck") or [""])[0])
            return self.send_json(200 if not res.get("error") else 404, res)

        if u.path == "/drafting/deck-review":
            # the deck's per-slide improvement-comments sidecar (text + mtime)
            return self.send_json(200, drafting.read_review(VAULT, (q.get("slug") or [""])[0],
                                                            (q.get("deck") or [""])[0]))

        if u.path == "/present/state":
            # the presenter's current slide, polled by the remote audience page
            with PRESENT_LOCK:
                return self.send_json(200, dict(PRESENT_STATE))

        if u.path == "/explore/index":
            return self.send_json(200, explore.load_index(VAULT))

        if u.path == "/explore/figure":
            if (q.get("source") or ["open"])[0] == "project":
                res = explore.load_project_figure(VAULT, (q.get("slug") or [""])[0],
                                                  (q.get("stem") or [""])[0])
            else:
                res = explore.load_figure(VAULT, (q.get("id") or [""])[0])
            return self.send_json(200 if not res.get("error") else 404, res)

        if u.path == "/explore/data":
            # the figure's rows verbatim, through the shared payload path so it is
            # gzip/zstd'd like any other JSON and carries an ETag
            raw, err = explore.data_bytes(VAULT, (q.get("id") or [""])[0])
            if err:
                return self.send_json(404, err)
            return self._send_payload(200, "application/json", raw)

        if u.path == "/explore/render":
            if (q.get("source") or ["open"])[0] == "project":
                raw, ctype, err = explore.render_project_saved(
                    VAULT, (q.get("slug") or [""])[0], (q.get("stem") or [""])[0],
                    (q.get("theme") or ["day"])[0])
            else:
                raw, ctype, err = explore.render_saved(
                    VAULT, (q.get("id") or [""])[0],
                    (q.get("theme") or ["day"])[0], (q.get("v") or [""])[0])
            if err:
                return self.send_json(404 if "unknown" in (err.get("error") or "") else 400, err)
            return self._send_payload(200, ctype, raw)

        if u.path == "/explore/comments":
            res = explore.load_comments(VAULT, (q.get("id") or [""])[0])
            return self.send_json(200 if not res.get("error") else 404, res)
        # ---- end Explore -------------------------------------------------------

        if u.path == "/drafting/doc":
            lite = (q.get("lite") or [""])[0]
            if lite not in ("", "0", "1"):
                return self.send_json(400, {"error": "lite must be 0 or 1"})
            if lite == "1":
                res = drafting.read_doc(VAULT, (q.get("slug") or [""])[0],
                                        (q.get("doc") or ["paper.md"])[0], lite=True)
                return self.send_json(200 if not res.get("error") else 404, res)
            res = drafting.read_doc(VAULT, (q.get("slug") or [""])[0],
                                    (q.get("doc") or ["paper.md"])[0])
            return self.send_json(200 if not res.get("error") else 404, res)

        if u.path == "/drafting/outline":
            res = drafting.read_outline(VAULT, (q.get("slug") or [""])[0],
                                        (q.get("doc") or ["paper.md"])[0])
            return self.send_json(200 if not res.get("error") else 404, res)

        if u.path == "/drafting/outline-pdf":
            slug = (q.get("slug") or [""])[0]
            doc = (q.get("doc") or ["paper.md"])[0]
            inline = (q.get("inline") or [""])[0] in ("1", "true")
            # a GET only serves the PDF a POST built; it never compiles
            p = outline_pdf.pdf_path(VAULT, slug, doc)
            if p is None:
                return self.send_json(404, {"error": "no outline PDF yet: POST to build it"})
            try:
                data = p.read_bytes()
            except OSError:
                return self.send_json(500, {"error": "could not read the outline PDF"})
            name = outline_pdf.download_name(VAULT, slug, doc)
            self.send_response(200)
            self.send_header("Content-Type", "application/pdf")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Content-Disposition", '%s; filename="%s"'
                             % ("inline" if inline else "attachment", name))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)
            return

        if u.path == "/drafting/supplements":
            # the paper's sibling docs (cover letter / response letter / appendix) +
            # whether each exists, for the Supplement dropdown
            res = drafting.list_supplements(VAULT, (q.get("slug") or [""])[0])
            return self.send_json(200 if not res.get("error") else 404, res)

        if u.path == "/drafting/supplement":
            # one supplement's content for the focused editor (response letter also returns
            # the reviewers' comments to show beside it)
            res = drafting.read_supplement(VAULT, (q.get("slug") or [""])[0], (q.get("name") or [""])[0])
            return self.send_json(200 if not res.get("error") else 404, res)

        if u.path == "/drafting/project-docs":
            res = drafting.list_project_docs(VAULT, (q.get("slug") or [""])[0])
            return self.send_json(200 if not res.get("error") else 404, res)

        if u.path == "/drafting/journals":
            # every journal in the journals folder + its docs — the picker for the
            # "Publication checklists" viewer (folded into the Supplements dropdown)
            return self.send_json(200, {"journals": drafting.list_journals(VAULT)})

        if u.path == "/drafting/journal":
            # one journal's checklist/guidelines markdown (defaults to its best doc)
            res = drafting.read_journal_doc(VAULT, (q.get("name") or [""])[0], (q.get("file") or [""])[0])
            return self.send_json(200 if not res.get("error") else 404, res)

        if u.path == "/drafting/checklist":
            res = drafting.read_checklist(VAULT, (q.get("slug") or [""])[0])
            return self.send_json(200 if not res.get("error") else 404, res)

        if u.path == "/drafting/suggested":
            res = drafting.read_suggested(VAULT, (q.get("slug") or [""])[0])
            return self.send_json(200 if not res.get("error") else 404, res)

        if u.path == "/drafting/checklist-sources":
            # what a checklist can pull from: journal KB docs + other papers' checklists
            return self.send_json(200, drafting.list_checklist_sources(VAULT, (q.get("slug") or [""])[0]))

        if u.path == "/drafting/concepts":
            return self.send_json(200, {"items": drafting.list_concepts(VAULT)})

        if u.path == "/drafting/concept":
            # one concept note's text + metadata (a scaffold + exists=false when new)
            res = drafting.read_concept(VAULT, (q.get("slug") or [""])[0],
                                        (q.get("name") or [None])[0])
            return self.send_json(200 if not res.get("error") else 400, res)

        if u.path == "/drafting/publish-setup":
            res = drafting.publish_setup(VAULT, (q.get("slug") or [""])[0], (q.get("doc") or ["paper.md"])[0],
                                         output=(q.get("output") or ["pdf"])[0])
            return self.send_json(200 if not res.get("error") else 404, res)

        if u.path == "/drafting/preview-status":
            res = drafting.preview_status(VAULT, (q.get("slug") or [""])[0], (q.get("doc") or ["paper.md"])[0],
                                          output=(q.get("output") or ["pdf"])[0])
            return self.send_json(200, res)

        if u.path == "/drafting/doc-status":
            res = drafting.doc_status(VAULT, (q.get("slug") or [""])[0], (q.get("doc") or ["paper.md"])[0])
            return self.send_json(200 if not res.get("error") else 404, res)

        if u.path == "/drafting/rewrite":
            # Review > Rewrite baselines for a manuscript (writing/versioning/rewrite.json)
            res = drafting.load_rewrite(VAULT, (q.get("slug") or [""])[0], (q.get("doc") or ["paper.md"])[0])
            return self.send_json(200 if not res.get("error") else 404, res)

        if u.path == "/drafting/comments":
            half = (q.get("resolved") or [""])[0]
            if half not in ("", "0", "1"):
                return self.send_json(400, {"error": "resolved must be 0 or 1"})
            if half:
                res = drafting.load_comments(VAULT, (q.get("slug") or [""])[0],
                                             (q.get("doc") or ["paper.md"])[0],
                                             resolved=(half == "1"))
                return self.send_json(200 if not res.get("error") else 404, res)
            res = drafting.load_comments(VAULT, (q.get("slug") or [""])[0], (q.get("doc") or ["paper.md"])[0])
            return self.send_json(200 if not res.get("error") else 404, res)

        if u.path == "/drafting/provenance":
            docs = tuple(q["doc"]) if q.get("doc") else ("paper.md", "appendix.md")
            slug = (q.get("slug") or [""])[0]
            res = drafting.provenance_status(VAULT, slug, docs=docs)
            if not res.get("error"):
                threading.Thread(target=audit_index.refresh_project, args=(VAULT, slug),
                                 kwargs={"status": res}, daemon=True).start()
            return self.send_json(200 if not res.get("error") else 404, res)

        if u.path == "/drafting/audit":
            try:
                rows = audit_index.query(
                    "SELECT slug, kind, n_embeds, n_broken, n_ungrounded, refreshed "
                    "FROM projects ORDER BY (n_broken+n_ungrounded) DESC, slug",
                    as_dicts=True)
                return self.send_json(200, {"ok": True, "projects": rows, "db": str(audit_index.db_path())})
            except ValueError as exc:
                return self.send_json(400, {"error": str(exc)})
            except Exception as exc:
                return self.send_json(500, {"error": str(exc)})

        if u.path == "/reading/quote-integrity":
            try:
                return self.send_json(200, {"ok": True, **quoteindex.summary()})
            except Exception as exc:
                return self.send_json(500, {"error": str(exc)})

        if u.path == "/drafting/numbers":
            proj = drafting._project_dir(VAULT, (q.get("slug") or [""])[0])
            if not proj:
                return self.send_json(404, {"error": "unknown slug"})
            try:
                res = numberscheck.check_project(
                    proj, doc=(q.get("doc") or ["paper.md"])[0],
                    all_docs=(q.get("all") or ["1"])[0] not in ("0", "false"),
                    inserted_only=(q.get("inserted") or ["0"])[0] in ("1", "true"))
                return self.send_json(200, res)
            except Exception as exc:
                return self.send_json(400, {"error": str(exc)})

        if u.path == "/drafting/numbers-catalogue":
            proj = drafting._project_dir(VAULT, (q.get("slug") or [""])[0])
            if not proj:
                return self.send_json(404, {"error": "unknown slug"})
            try:
                return self.send_json(200, numberscheck.catalogue(proj, (q.get("q") or [""])[0]))
            except Exception as exc:
                return self.send_json(400, {"error": str(exc)})

        if u.path == "/drafting/findings":
            res = drafting.list_findings(VAULT, (q.get("slug") or [""])[0])
            return self.send_json(200 if not res.get("error") else 404, res)

        if u.path == "/drafting/figure-comments":
            # coordinate-pinned comments on the results figures/tables themselves, keyed by
            # asset stem, with producing script/data joined per stem (the lightbox surface)
            res = drafting.load_figure_comments(VAULT, (q.get("slug") or [""])[0])
            return self.send_json(200 if not res.get("error") else 404, res)

        if u.path == "/drafting/file":
            # read-only script/data/notes viewer for the Results workbench — path
            # confined to the project dir, extension allow-listed, never writes
            res = drafting.read_project_file(VAULT, (q.get("slug") or [""])[0], (q.get("path") or [""])[0])
            return self.send_json(200 if not res.get("error") else 404, res)

        if u.path == "/drafting/readme-status":
            # section-by-section completeness of the project README against the
            # project-docs contract — the planning workspace's live checklist
            res = drafting.readme_status(VAULT, (q.get("slug") or [""])[0])
            return self.send_json(200 if not res.get("error") else 404, res)

        if u.path == "/drafting/logs":
            # the project's logs/ research record, newest first; entries open via
            # the existing /drafting/file viewer
            res = drafting.list_logs(VAULT, (q.get("slug") or [""])[0])
            return self.send_json(200 if not res.get("error") else 404, res)

        if u.path == "/drafting/datasets":
            res = drafting.dataset_search(VAULT, (q.get("q") or [""])[0])
            return self.send_json(200, res)

        if u.path == "/drafting/archived":
            # papers/archive/ — 'stalled - x' (paused) and 'complete - x' folders
            return self.send_json(200, drafting.list_archived(VAULT))

        if u.path == "/drafting/replication-files":
            res = drafting.list_replication_files(VAULT, (q.get("slug") or [""])[0])
            return self.send_json(200 if not res.get("error") else 404, res)

        if u.path == "/drafting/pdf-comments":
            # comments on the FINAL TYPESET output (target=pdf|docx) — distinct sidecar
            # from /drafting/comments, which annotates the source markdown
            res = drafting.load_publish_comments(VAULT, (q.get("slug") or [""])[0], (q.get("doc") or ["paper.md"])[0])
            return self.send_json(200 if not res.get("error") else 404, res)

        if u.path == "/drafting/pdf-text-layer":
            # per-page word bounding boxes for the click-to-comment overlay, and for
            # resolving a click into the nearest word/line (the comment's re-locatable quote)
            res = drafting.pdf_text_layer(VAULT, (q.get("slug") or [""])[0], (q.get("doc") or ["paper.md"])[0],
                                          target=(q.get("target") or ["pdf"])[0], which=(q.get("which") or ["paper"])[0])
            return self.send_json(200 if not res.get("error") else 404, res)

        if u.path == "/drafting/pdf-page-png":
            try:
                page = int((q.get("page") or ["1"])[0])
            except ValueError:
                page = 1
            r = drafting.pdf_page_png(VAULT, (q.get("slug") or [""])[0], (q.get("doc") or ["paper.md"])[0], page,
                                      target=(q.get("target") or ["pdf"])[0], which=(q.get("which") or ["paper"])[0])
            if not r:
                return self.send_json(404, {"error": "could not render that page"})
            data, ct = r
            self.send_response(200)
            self.send_header("Content-Type", ct)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.write(data)
            return

        if u.path == "/drafting/pdf":
            p = drafting.pdf_path(VAULT, (q.get("slug") or [""])[0], (q.get("doc") or ["paper.md"])[0],
                                  which=(q.get("which") or ["paper"])[0])
            if not p:
                return self.send_json(404, {"error": "no compiled PDF yet — Publish first"})
            try:
                data = p.read_bytes()
            except OSError:
                return self.send_json(404, {"error": "could not read the PDF"})
            self.send_response(200)
            self.send_header("Content-Type", "application/pdf")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.write(data)
            return

        if u.path == "/drafting/latex":
            res = drafting.latex_source(VAULT, (q.get("slug") or [""])[0], (q.get("doc") or ["paper.md"])[0],
                                        part=(q.get("part") or ["body"])[0])
            return self.send_json(200 if res.get("ok") else 404, res)

        if u.path == "/drafting/docx":
            which = (q.get("which") or ["paper"])[0]
            p = drafting.docx_path(VAULT, (q.get("slug") or [""])[0],
                                   (q.get("doc") or ["paper.md"])[0], which=which)
            if not p:
                return self.send_json(404, {"error": "no compiled .docx yet — Publish to Word first"})
            try:
                data = p.read_bytes()
            except OSError:
                return self.send_json(404, {"error": "could not read the .docx"})
            self.send_response(200)
            self.send_header("Content-Type",
                             "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
            self.send_header("Content-Disposition", f'attachment; filename="{p.name}"')
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.write(data)
            return

        if u.path == "/drafting/overleaf-info":
            # read-only: the Overleaf export zips beside the manuscript, with build times
            res = drafting.overleaf_info(VAULT, (q.get("slug") or [""])[0], (q.get("doc") or ["paper.md"])[0])
            return self.send_json(200 if res.get("ok") else 404, res)

        if u.path == "/drafting/overleaf-tex":
            # read-only: one self-contained main.tex (body, tables, class inlined) built
            # from the Overleaf zip, for the Publish panel's "Copy for Overleaf"
            res = drafting.overleaf_single_tex(VAULT, (q.get("slug") or [""])[0], (q.get("doc") or ["paper.md"])[0],
                                               anon=(q.get("anon") or [""])[0] in ("1", "true"))
            return self.send_json(200 if res.get("ok") else 404, res)

        if u.path == "/drafting/overleaf":
            # download one Overleaf export zip (anon=1: the anonymized one). Read-only GET;
            # the file is chosen by kind inside the paper's own writing/, never by a path.
            anon = (q.get("anon") or [""])[0] in ("1", "true")
            p = drafting.overleaf_zip_path(VAULT, (q.get("slug") or [""])[0],
                                           (q.get("doc") or ["paper.md"])[0], anon=anon)
            if not p:
                return self.send_json(404, {"error": "no Overleaf zip yet — run the Overleaf export"})
            try:
                data = p.read_bytes()
            except OSError:
                return self.send_json(404, {"error": "could not read the zip"})
            self.send_response(200)
            self.send_header("Content-Type", "application/zip")
            self.send_header("Content-Disposition", "attachment; filename*=UTF-8''" + quote(p.name, safe=""))
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)
            return

        if u.path == "/drafting/versions":
            # in-house version control: every saved checkpoint for a doc (newest first) +
            # the live doc's word/char count + whether it differs from the newest checkpoint
            res = drafting.list_versions(VAULT, (q.get("slug") or [""])[0],
                                         (q.get("doc") or ["paper.md"])[0])
            return self.send_json(200 if not res.get("error") else 404, res)

        if u.path == "/drafting/version":
            # one checkpoint's full content + metadata
            res = drafting.read_version(VAULT, (q.get("slug") or [""])[0],
                                        (q.get("id") or [""])[0], (q.get("doc") or [None])[0])
            return self.send_json(200 if not res.get("error") else 404, res)

        if u.path == "/drafting/version-artifact":
            which = (q.get("which") or ["pdf"])[0]
            p = drafting.version_artifact_path(VAULT, (q.get("slug") or [""])[0],
                                               (q.get("doc") or ["paper.md"])[0],
                                               (q.get("vid") or [""])[0], which)
            if not p:
                return self.send_json(404, {"error": "no snapshotted artifact for that version"})
            try:
                data = p.read_bytes()
            except OSError:
                return self.send_json(404, {"error": "could not read the artifact"})
            ct = ("application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                  if p.suffix.lower() == ".docx" else "application/pdf")
            self.send_response(200)
            self.send_header("Content-Type", ct)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-cache")
            if p.suffix.lower() == ".docx":
                self.send_header("Content-Disposition", f'attachment; filename="{p.name}"')
            self.end_headers()
            self.wfile.write(data)
            return

        if u.path == "/drafting/version-diff":
            # word-level redline between two checkpoints (a=old, b=new); either side may be
            # the literal "current" (the live doc)
            res = drafting.diff_versions(VAULT, (q.get("slug") or [""])[0],
                                         (q.get("a") or [""])[0], (q.get("b") or ["current"])[0],
                                         (q.get("doc") or ["paper.md"])[0])
            return self.send_json(200 if not res.get("error") else 404, res)

        if u.path == "/drafting/diff-pdf":
            # stream the last-compiled latexdiff redline PDF bytes (for the in-panel iframe)
            p = drafting.diff_pdf_path(VAULT, (q.get("slug") or [""])[0], (q.get("doc") or ["paper.md"])[0])
            if not p:
                return self.send_json(404, {"error": "no diff PDF yet — compile one first"})
            try:
                data = p.read_bytes()
            except OSError:
                return self.send_json(404, {"error": "could not read the diff PDF"})
            self.send_response(200)
            self.send_header("Content-Type", "application/pdf")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.write(data)
            return

        if u.path == "/drafting/asset":
            # serve a figure/image embed (![[fig.png]]) as raw bytes, confined to the project
            slug, name = (q.get("slug") or [""])[0], (q.get("name") or [""])[0]
            ver = (q.get("v") or [""])[0]
            etag = drafting.asset_etag(VAULT, slug, name)
            cache = ("public, max-age=31536000, immutable"
                     if (ver and etag and ver == etag.strip('"')) else "no-cache")
            if etag and self.headers.get("If-None-Match") == etag:
                self.send_response(304)
                self.send_header("ETag", etag)
                self.send_header("Cache-Control", cache)
                self.end_headers()
                return
            res = drafting.read_asset(VAULT, slug, name)
            if not res:
                return self.send_json(404, {"error": "not found"})
            data, ctype = res
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            if etag:
                self.send_header("ETag", etag)
            self.send_header("Cache-Control", cache)
            self.end_headers()
            self.wfile.write(data)
            return

        if u.path == "/drafting/table-png":
            res = drafting.table_png(VAULT, (q.get("slug") or [""])[0], (q.get("name") or [""])[0],
                                     (q.get("doc") or ["paper.md"])[0])
            if not res:
                return self.send_json(404, {"error": "not found"})
            data, ctype = res
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.write(data)
            return

        if u.path == "/drafting/embed":
            res = drafting.read_embed(VAULT, (q.get("slug") or [""])[0], (q.get("name") or [""])[0])
            return self.send_json(200 if not res.get("error") else 404, res)

        if u.path == "/drafting/diagram":
            # the draw.io XML source behind a results figure (concept-diagram editor)
            res = drafting.read_diagram(VAULT, (q.get("slug") or [""])[0], (q.get("name") or [""])[0])
            return self.send_json(200 if not res.get("error") else 404, res)

        if u.path == "/drafting/source":
            # full text of a citation/corpus source note + where the quote sits, so a
            # comment's citation deep-links to the exact evidence in-dashboard
            res = drafting.read_source(VAULT, (q.get("rel") or [""])[0], (q.get("quote") or [""])[0])
            return self.send_json(200 if not res.get("error") else 404, res)

        if u.path == "/drafting/cite-page":
            res = drafting.cite_pdf_target(VAULT, (q.get("rel") or [""])[0], (q.get("page") or [""])[0])
            return self.send_json(200 if not res.get("error") else 404, res)

        if u.path == "/drafting/source-pdf":
            # stream a SOURCE PDF (a read paper under Reading/Corpus or a project corpus/)
            # so the dashboard's PDF viewer can open it at a page via '#page=N'. Confined.
            p = drafting.source_pdf_path(VAULT, (q.get("rel") or [""])[0])
            if not p:
                return self.send_json(404, {"error": "source PDF not found"})
            try:
                data = p.read_bytes()
            except OSError:
                return self.send_json(404, {"error": "could not read the PDF"})
            self.send_response(200)
            self.send_header("Content-Type", "application/pdf")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.write(data)
            return

        if u.path == "/drafting/source-pdf-find":
            # Ctrl+F inside the source PDF: pages + snippets where the text occurs. Confined
            # by the same source_pdf_path as /drafting/source-pdf; read-only.
            res = drafting.source_pdf_find(VAULT, (q.get("rel") or [""])[0], (q.get("q") or [""])[0][:500])
            return self.send_json(200 if not res.get("error") else 404, res)

        if u.path == "/drafting/cite-index":
            return self.send_pre_json("cite_index", lambda: citeindex.compact(HERE))

        if u.path == "/drafting/cite-detail":
            # one source in full (quotes, key points, the citation line) for the quote
            # drill-down — a few KB, never a list
            return self.send_json(200, citeindex.detail(HERE, (q.get("rel") or [""])[0]))

        if u.path == "/drafting/cite-search":
            slug = (q.get("slug") or [""])[0]
            query = (q.get("q") or [""])[0]
            cited = set()
            if slug:
                paths = drafting._writing_paths(VAULT, slug, (q.get("doc") or ["paper.md"])[0])
                if paths and paths[0].exists():
                    cited = drafting.cited_pairs(drafting._read(paths[0]) or "")
            hits = citationindex.search(HERE, query, cited=cited, limit=50)
            return self.send_json(200, {"hits": hits, "count": len(hits),
                                        "index": citationindex.status(HERE)})

        if u.path == "/drafting/cite-map":
            # feature 1: the in-text-citation resolver map for the CM decorator.
            # {"surname|year": {status, rel, citekey}} over the manuscript's prose cites.
            slug = (q.get("slug") or [""])[0]
            doc = (q.get("doc") or ["paper.md"])[0]
            paths = drafting._writing_paths(VAULT, slug, doc)
            if not paths or not paths[0].exists():
                return self.send_json(200, {"map": {}, "counts": {"resolved": 0, "unresolved": 0, "ambiguous": 0}})
            try:
                idx = references.load_resolver_index(HERE)
                out = references.cite_map(drafting._read(paths[0]) or "", idx, VAULT, slug)
            except Exception as e:
                return self.send_json(200, {"map": {}, "counts": {"resolved": 0, "unresolved": 0, "ambiguous": 0}, "error": str(e)})
            return self.send_json(200, out)

        if u.path == "/drafting/references":
            # feature 2+4: build the reference list (no write) in a chosen style for the
            # References panel preview + audit (unresolved/ambiguous/incomplete).
            slug = (q.get("slug") or [""])[0]
            doc = (q.get("doc") or ["paper.md"])[0]
            style = references._norm_style((q.get("style") or ["asa"])[0])
            paths = drafting._writing_paths(VAULT, slug, doc)
            if not paths or not paths[0].exists():
                return self.send_json(404, {"error": "manuscript not found"})
            try:
                idx = references.load_resolver_index(HERE)
                built = references.build_references(drafting._read(paths[0]) or "", VAULT, idx, style, slug)
            except Exception as e:
                return self.send_json(500, {"error": str(e)})
            existing = drafting._read(paths[0].parent / "references.md")
            return self.send_json(200, {
                "style": style, "markdown": built["markdown"], "audit": built["audit"],
                "entries": [{"text": e["text"], "rel": e["rel"], "citekey": e["citekey"],
                             "confidence": e["confidence"], "flags": e["flags"]} for e in built["entries"]],
                "unresolved": built["unresolved"], "ambiguous": built["ambiguous"],
                "existing": existing, "existsMtime": references._mt(paths[0].parent / "references.md")})

        if u.path == "/drafting/corpus":
            slug = (q.get("slug") or [""])[0]
            doc = (q.get("doc") or ["paper.md"])[0]
            query = (q.get("q") or [""])[0]
            sort = (q.get("sort") or ["author"])[0]
            try:
                limit = max(1, min(int((q.get("limit") or ["400"])[0]), 2000))
            except ValueError:
                limit = 400
            cited = set()
            if slug:
                paths = drafting._writing_paths(VAULT, slug, doc)
                if paths and paths[0].exists():
                    cited = drafting.cited_pairs(drafting._read(paths[0]) or "")
            hits = citationindex.search(HERE, query, cited=cited, limit=limit)

            def _surn(h):
                a = (h.get("author") or "").strip()
                return re.split(r"[,\s]+", a)[0].lower() if a else "zzzz"
            if sort == "author":
                hits.sort(key=lambda h: (_surn(h), -(h.get("year") or 0)))
            elif sort == "year":
                hits.sort(key=lambda h: (-(h.get("year") or 0), _surn(h)))
            elif sort == "cited":
                hits.sort(key=lambda h: (not h.get("alreadyCited"), _surn(h)))
            # 'relevance' keeps the index's own ranking (meaningful only with a query)
            rows = [{"stem": h["stem"], "rel": h["rel"], "kind": h.get("kind", "citation"),
                     "author": h["author"], "year": h["year"], "title": h["title"],
                     "intext": h.get("intext") or h["author"], "suffix": h.get("suffix") or "",
                     "citekey": h["citekey"], "source": h["source"], "tags": h["tags"],
                     "citation": h["citation"], "keyPoints": (h.get("keyPoints") or [])[:2],
                     "nKeyPoints": len(h.get("keyPoints") or []),
                     "nQuotes": len(h.get("quotes") or []),
                     "alreadyCited": h.get("alreadyCited", False)} for h in hits]
            st = citationindex.status(HERE)
            return self.send_json(200, {"rows": rows, "count": len(rows),
                                        "total": st.get("count", 0), "sort": sort,
                                        "query": query, "index": st})

        if u.path == "/drafting/corpus-search":
            slug = (q.get("slug") or [""])[0]
            doc = (q.get("doc") or ["paper.md"])[0]
            query = (q.get("q") or [""])[0].strip()
            try:
                k = max(1, min(int((q.get("k") or ["40"])[0]), 200))
            except ValueError:
                k = 40
            if not query:
                return self.send_json(200, {"ok": True, "mode": "none", "hits": []})
            kinds = (q.get("kinds") or [""])[0] or None
            return self.send_json(200, semindex.search(
                VAULT, query, k=k, kinds=kinds, slug=slug, doc=doc, here=HERE))

        if u.path == "/drafting/corpus-index":
            return self.send_json(200, semindex.status())

        if u.path == "/board":
            p = board_path((q.get("path") or [""])[0])
            if p is None: return self.send_json(400, {"error": "bad board path"})
            text = read_text(p)
            if text is None: return self.send_json(500, {"error": "board not found"})
            return self.send_json(200, kanban.get_board(text))

        if u.path == "/projects":
            out = []
            for b in scan_boards():
                if b["isPlanning"]:
                    continue
                done = open_ = effort = undated = 0
                for lane in b["board"]["lanes"]:
                    for c in lane["cards"]:
                        if c["done"]:
                            done += 1
                        else:
                            open_ += 1
                            effort += c.get("est") or 0
                            if not card_due(c):
                                undated += 1
                # empty boards stay listed so they remain reachable via
                # search / the all-projects disclosure after a lane sweep
                out.append({"name": b["name"], "path": b["path"], "done": done, "open": open_,
                            "mtime": b["mtime"], "effort": effort, "undated": undated})
            for tag in _active_project_tags():
                seen, g_done, g_open, g_eff, g_und = set(), 0, 0, 0, 0
                for b in scan_boards():
                    for lane in b["board"]["lanes"]:
                        for c in lane["cards"]:
                            if tag not in [t.lower() for t in c.get("tags", [])]:
                                continue
                            k = _norm_card_key(c["text"])
                            if k in seen:
                                continue
                            seen.add(k)
                            if c["done"]:
                                g_done += 1
                            else:
                                g_open += 1
                                g_eff += c.get("est") or 0
                                if not card_due(c):
                                    g_und += 1
                for e in out:
                    if tag in e["name"].lower():
                        e["done"], e["open"], e["effort"], e["undated"] = g_done, g_open, g_eff, g_und
            return self.send_json(200, {"projects": out})

        if u.path == "/timeline":
            cutoff = (date.today() - timedelta(days=14)).isoformat()
            items = []
            for b in scan_boards():
                for lane in b["board"]["lanes"]:
                    for c in lane["cards"]:
                        if c["done"]:
                            continue
                        due = card_due(c)
                        if due and due >= cutoff:
                            item = {"board": b["name"], "path": b["path"], "lane": lane["name"],
                                    "text": c["text"], "due": due, "priority": c["priority"],
                                    "isPlanning": b["isPlanning"], "raw": c["raw"], "est": c.get("est"),
                                    "tags": c.get("tags", [])}
                            item["link"] = tasklink.resolve(VAULT, c, b["name"], b["isPlanning"])
                            items.append(item)
            return self.send_json(200, {"items": items})

        if u.path == "/events":
            # default window: today-14 → today+90, override with ?from=&to=
            today = date.today()
            d_from = q.get("from", [(today - timedelta(days=14)).isoformat()])[0]
            d_to   = q.get("to",   [(today + timedelta(days=90)).isoformat()])[0]
            scanned = scan_events()
            items = [e for e in scanned if d_from <= e["date"] <= d_to]
            items += [e for e in planning.calendar_events(VAULT, with_plans=True, events=scanned)
                      if d_from <= e["date"] <= d_to]
            items.sort(key=lambda e: (e["date"], e.get("startTime") or ""))
            return self.send_json(200, {"events": items, "categories": [
                {"key": s, "color": c} for s, c in EVENT_DIRS] + [
                {"key": planning.CAL_CATEGORY, "color": planning.CAL_COLOR, "virtual": True}]})

        if u.path == "/events/read":
            res = read_event_body((q.get("path") or [""])[0])
            return self.send_json(200 if res.get("ok") else 404, res)

        if u.path == "/daily":
            return self.send_json(200, {"days": scan_daily()})

        if u.path == "/activity":
            # boards with the most recent mtime
            bs = sorted(scan_boards(), key=lambda b: -b["mtime"])[:8]
            cutoff = time.time() - 14 * 86400
            out = []
            for b in bs:
                if b["mtime"] < cutoff:
                    continue
                open_ = sum(1 for l in b["board"]["lanes"] for c in l["cards"] if not c["done"])
                out.append({"name": b["name"], "path": b["path"], "mtime": b["mtime"],
                            "isPlanning": b["isPlanning"], "open": open_,
                            "ago": int(time.time() - b["mtime"])})
            return self.send_json(200, {"recent": out})

        if u.path == "/search":
            needle = (q.get("q") or [""])[0].lower().strip()
            if not needle or len(needle) < 2:
                return self.send_json(200, {"hits": []})
            hits = []
            for b in scan_boards():
                for lane in b["board"]["lanes"]:
                    for c in lane["cards"]:
                        if needle in c["text"].lower():
                            hits.append({"board": b["name"], "path": b["path"], "lane": lane["name"],
                                         "text": c["text"], "done": c["done"], "raw": c["raw"],
                                         "due": c["due"], "priority": c["priority"]})
                            if len(hits) >= 60:
                                break
                    if len(hits) >= 60: break
                if len(hits) >= 60: break
            return self.send_json(200, {"hits": hits})

        if u.path == "/goals":
            return self.send_json(200, {"goals": scan_goals()})

        if u.path == "/tags":
            return self.send_pre_json(
                "tags", lambda: {"tags": merged_tags(), "index": tagindex.status(HERE)})

        if u.path == "/tags/cards":   # kept for back-compat; cards only
            tag = (q.get("tag") or [""])[0].strip()
            if not tag:
                return self.send_json(200, {"hits": []})
            return self.send_json(200, {"hits": cards_for_tag(tag)})

        if u.path == "/tags/occurrences":   # cards (rich) + notes (file + snippet)
            tag = (q.get("tag") or [""])[0].strip()
            if not tag:
                return self.send_json(200, {"cards": [], "notes": [], "index": tagindex.status(HERE)})
            return self.send_json(200, tag_occurrences(tag))

        if u.path == "/health":
            live = {t.name for t in threading.enumerate() if t.is_alive()}
            threads = {n: (n in live) for n in _BACKGROUND_THREADS}
            caches = _pre_status()
            stale = [n for n, s in caches.items()
                     if not s["ready"] or (s["ageSec"] is not None
                                           and s["ageSec"] > s["everySec"] * 3 + 60)]
            analytics = None
            try:
                st = CACHE_FILE.stat()
                analytics = {"ageSec": round(time.time() - st.st_mtime, 1),
                             "bytes": st.st_size, "generated": cache_generated()}
            except Exception as e:
                analytics = {"error": str(e)}
            bundle = dict(_bundle_identity() or {}, **_identity_fields())
            try:
                with _ENC_CACHE_LOCK:
                    for k, v in _ENC_CACHE.items():
                        if k[0].endswith("index.html"):
                            bundle = dict(bundle,
                                          codings=sorted(c for c in _CODINGS if c in v))
                            break
            except Exception:
                pass
            ok = all(threads.values()) and not stale and not _CHUNK_VIOLATIONS
            return self.send_json(200, {
                "ok": ok, "vault": str(VAULT), "port": PORT, "pid": os.getpid(),
                "uptimeSec": round(time.time() - _STARTED_AT, 1),
                "surface": os.environ.get("BOARD_SURFACE") or socket.gethostname(),
                "threads": threads, "threadsDead": sorted(n for n, a in threads.items() if not a),
                "caches": caches, "cachesStale": stale,
                "analytics": analytics, "bundle": bundle,
                "chunkViolations": list(_CHUNK_VIOLATIONS),
                "boards": len(all_boards()), "events": len(scan_events()),
                "requests": _REQ_STATS.snapshot(),
            })

        if u.path == "/reading":
            return self.send_pre_json("reading", _reading_payload)

        if u.path == "/reading/next":
            # the read-next queue and read-by dates alone. Read-only.
            return self.send_json(200, reading.next_up())

        if u.path == "/printbook/get":
            # one print-copy note: its ASA citation and the quotes/notes taken so far
            return self.send_json(200, printbook.get((parse_qs(u.query).get("stem", [""])[0] or "").strip()))
        if u.path == "/printbook/list":
            return self.send_json(200, printbook.list_print())

        if u.path == "/reading/archive":
            q = (parse_qs(u.query).get("q", [""])[0] or "").strip()
            return self.send_json(200, {"archived": reading.archive_index(q or None)})

        if u.path == "/reading/inbox-pdfs":
            inbox = VAULT / "Preparation" / "Reading" / "Inbox"
            pdfs = []
            try:
                pdfs = sorted(p.name for p in inbox.iterdir()
                              if p.suffix.lower() == ".pdf")
            except OSError:
                pass
            return self.send_json(200, {"count": len(pdfs), "names": pdfs[:50]})

        if u.path == "/reading/inbox/list":
            return self.send_json(200, litinbox.list_inbox())

        if u.path == "/reading/inbox/detail":
            name = (parse_qs(u.query).get("name") or [""])[0]
            res = litinbox.detail(name)
            return self.send_json(200 if not res.get("error") else 404, res)

        if u.path == "/reading/inbox/check-stem":
            stem = (parse_qs(u.query).get("stem") or [""])[0]
            return self.send_json(200, litinbox.check_stem(stem))

        if u.path == "/reading/inbox/cite-suggest":
            name = (parse_qs(u.query).get("name") or [""])[0]
            res = litcite.suggest(name)
            return self.send_json(200 if not res.get("error") else 404, res)

        if u.path == "/reading/inbox/pdf":
            name = (parse_qs(u.query).get("name") or [""])[0]
            res = litinbox.pdf_bytes(name)
            if not res:
                return self.send_json(404, {"error": "not found"})
            data, ctype = res
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.write(data)
            return

        if u.path == "/reading/corpus-search":
            query = (q.get("q") or [""])[0].strip()
            hits = citationindex.search(HERE, query, limit=8) if query else []
            rows = [{"stem": h["stem"], "rel": h["rel"], "kind": h.get("kind", "citation"),
                     "author": h["author"], "year": h["year"], "title": h["title"],
                     "status": h.get("status")} for h in hits]
            return self.send_json(200, {"hits": rows})

        if u.path == "/cache-info":
            return self.send_json(200, {"generated": cache_generated()})

        if u.path == "/vault-path":
            root = _home_path(VAULT)
            return self.send_json(200, {"vaultPath": root})

        if u.path == "/daily-today":
            return self.send_json(200, daily_today())

        if u.path == "/routines":
            return self.send_pre_json("routines", routines_today)

        if u.path == "/ambient":
            # weather + sun + epigraph + on-this-day; never errors, degrades to nulls
            return self.send_json(200, ambient.payload())

        if u.path == "/project/plans":
            return self.send_json(200, {"plans": projectplan.list_plans()})

        if u.path == "/project/proposal":
            return self.send_json(200, projectplan.read_proposal((q.get("slug") or [None])[0]))

        if u.path == "/board/proposals":
            # cards an agent has PROPOSED (nothing on any board yet). ?all=1 includes
            # the ones already accepted/rejected, for the history disclosure.
            inc = (q.get("all", [""])[0] or "").lower() in ("1", "true", "yes")
            return self.send_json(200, boardproposals.listing(include_resolved=inc))

        if u.path == "/project/plan":
            # the DURABLE project plan (finalized or not) -- the timeline's active
            # project lane reads milestones + hard deadline from here.
            try:
                return self.send_json(200, projectplan.get_plan((q.get("slug") or [None])[0]))
            except Exception:
                return self.send_json(200, {"status": "none"})

        if u.path == "/insights/archive":
            try:
                return self.send_json(200, achievements.build(VAULT))
            except Exception as e:
                return self.send_json(500, {"error": str(e)})

        if u.path == "/daily/sections":
            d = _valid_recent_date((q.get("date") or [""])[0])
            if not d:
                return self.send_json(400, {"error": "bad date"})
            return self.send_json(200, {**daily_sections(d), "date": d,
                                        "dailyPath": "Preparation/Notes/Daily/" + d + ".md"})

        if u.path == "/daily/recent":
            try:
                n = int((q.get("days") or ["6"])[0])
            except ValueError:
                n = 6
            return self.send_json(200, {"days": daily_recent(n)})

        if u.path == "/daily/dates":
            return self.send_json(200, {"dates": daily_dates(), "today": date.today().isoformat()})

        if u.path == "/daily/read":
            r = daily_read((q.get("date") or [""])[0])
            if not r:
                return self.send_json(404, {"error": "no note for that date"})
            return self.send_json(200, r)

        if u.path == "/learning":
            return self.send_json(200, learn_scan())

        if u.path == "/learning/queue":
            deck = (q.get("deck") or ["all"])[0]
            module = (q.get("module") or [""])[0] or None   # full sub-deck tag, one unit
            ordered = (q.get("ordered") or ["0"])[0] in ("1", "true", "yes")
            shuffle = (q.get("random") or ["0"])[0] in ("1", "true", "yes")  # "All modules — random"
            image_only = (q.get("image") or ["0"])[0] in ("1", "true", "yes")  # legacy image-first mode
            try:
                lim = int((q.get("limit") or ["40"])[0])
            except ValueError:
                lim = 40
            return self.send_json(200, {"cards": learning.queue(
                str(LEARNING_ROOT), deck, lim, shelved=load_shelved(),
                module=module, ordered=ordered, image_only=image_only, shuffle=shuffle)})

        if u.path == "/learning/flags":
            st = (q.get("status") or [""])[0].strip()
            flags = load_flags()
            if st:
                flags = [f for f in flags if (f.get("status") or "open") == st]
            return self.send_json(200, {"flags": flags})

        if u.path == "/learning/atlas":
            # every image card, for the image-first "What is this?" gallery
            deck = (q.get("deck") or ["all"])[0]
            return self.send_json(200, {"cards": learning.atlas(
                str(LEARNING_ROOT), deck, shelved=load_shelved())})

        if u.path == "/learning/asset":
            # stream a flashcard's image embed (![[fig.png]]) as raw bytes, confined
            # to Preparation/Learning (mirrors /drafting/asset)
            hit = learning.asset_path(str(LEARNING_ROOT), (q.get("path") or [""])[0],
                                      (q.get("name") or [""])[0])
            if not hit:
                return self.send_json(404, {"error": "not found"})
            path, ctype = hit
            try:
                st = path.stat()
            except OSError:
                return self.send_json(404, {"error": "not found"})
            data, width = None, 0
            raw_w = (q.get("w") or [""])[0]
            if (re.fullmatch(r"[0-9]{1,6}", raw_w) and int(raw_w) > 0
                    and ctype not in ("image/svg+xml", "image/gif")):
                want = int(raw_w)
                width = min((x for x in _RENDITION_WIDTHS if x >= want),
                            default=_RENDITION_WIDTHS[-1])
                made = _rendition(str(path), width, ctype)
                if made:
                    data, ctype = made
                else:
                    width = 0                   # original bytes: the original's tag
            etag = '"%x.%x%s"' % (st.st_mtime_ns, st.st_size,
                                  (".w%d" % width) if width else "")
            if _if_none_match_hit(self.headers.get("If-None-Match"), etag):
                self.send_response(304)
                self.send_header("ETag", etag)
                self.send_header("Cache-Control", "public, max-age=604800")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            if data is None:
                try:
                    data = path.read_bytes()
                except OSError:
                    return self.send_json(404, {"error": "not found"})
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("ETag", etag)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "public, max-age=604800")
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(data)
            return

        if u.path.startswith("/systems/"):
            # Systems view (systems.py): /systems/tree, /systems/component, /systems/photo.
            # Ids are regex-checked and every file resolved inside SYSTEMS_ROOT there.
            code, ctype, body = systems.http_get(str(SYSTEMS_ROOT), u.path, q)
            if ctype == "json":
                return self.send_json(code, body)
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-cache")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(body)
            return

        if u.path == "/canon":
            return self.send_json(200, {"quotes": parse_canon()})

        if u.path == "/today":
            today_iso = date.today().isoformat()
            tomorrow = (date.today() + timedelta(days=1)).isoformat()
            week     = (date.today() + timedelta(days=7)).isoformat()
            events_today = [e for e in scan_events() if e["date"] == today_iso]
            events_week  = [e for e in scan_events() if today_iso < e["date"] <= week]
            overdue, due_today, due_soon, flagged = [], [], [], []
            for b in scan_boards():
                for lane in b["board"]["lanes"]:
                    for c in lane["cards"]:
                        if c["done"]:
                            continue
                        due = card_due(c)
                        item = {"board": b["name"], "path": b["path"], "lane": lane["name"],
                                "text": c["text"], "due": due, "priority": c["priority"],
                                "isPlanning": b["isPlanning"], "raw": c["raw"], "est": c.get("est"),
                                    "tags": c.get("tags", [])}
                        item["link"] = tasklink.resolve(VAULT, c, b["name"], b["isPlanning"])
                        if not due:
                            # high-priority work with no deadline — the stuff that
                            # silently never surfaces. Capture it so Up Next can.
                            if c["priority"] == "high":
                                flagged.append(item)
                            continue
                        if due < today_iso: overdue.append(item)
                        elif due == today_iso: due_today.append(item)
                        elif due <= week: due_soon.append(item)
            overdue.sort(key=lambda x: x["due"])
            # the task board's TODAY lane leads, in lane order (the sort is stable)
            due_today.sort(key=lambda x: (not x["isPlanning"], 0 if x["lane"] == "TODAY" else 1))
            due_soon.sort(key=lambda x: x["due"])
            return self.send_json(200, {
                "today": today_iso,
                "eventsToday": events_today,
                "eventsWeek": events_week,
                "overdue": overdue,
                "dueToday": due_today,
                "dueSoon": due_soon,
                "flagged": flagged,
            })

        return self._serve_bundle()

    def do_POST(self):
        try:
            return self._post()
        except (ConnectionError, TimeoutError):
            raise
        except Exception as e:
            return self._fail(e)

    def _post(self):
        if self._gate_refused():
            return
        if not pane_allows("POST", urlparse(self.path).path):
            return self.send_json(403, {"ok": False,
                                        "error": "read-only pane: this route is not served here"})

        def refuse(code, message):
            self.close_connection = True      # the body is never read
            return self.send_json(code, {"ok": False, "error": message})

        # the body is framed by one plain Content-Length and nothing else
        if self.headers.get("Transfer-Encoding"):
            return refuse(411, "Content-Length required")
        declared = self.headers.get_all("Content-Length") or []
        if len(declared) > 1 or (declared and not re.fullmatch(r"[0-9]{1,18}", declared[0].strip())):
            return refuse(400, "bad Content-Length")
        length = int(declared[0]) if declared else 0
        if length > self._MAX_BODY:
            return refuse(413, "request body too large")
        real = self.rfile
        body = real.read(length) if length else b""
        if body.lstrip()[:1] not in (b"", b"{"):      # every route takes a JSON object
            return self.send_json(400, {"ok": False, "error": "bad json"})
        try:
            self.rfile = _io.BytesIO(body)
            return self._do_POST()
        finally:
            self.rfile = real
            _pre_dirty_local()

    def _do_POST(self):
        u = urlparse(self.path)

        if u.path.startswith("/w/panel/"):
            return self._panel(u, parse_qs(u.query))    # see _panel: Host + Origin gate

        if self._is_action(u.path):
            data, err = self._json_post(limit=16 * 1024)
            if err:
                return self.send_json(err[0], err[1])
            q = parse_qs(u.query)             # body fields win over the query string
            for k, v in data.items():
                if isinstance(v, (list, tuple)):
                    q[k] = [str(x) for x in v]
                elif isinstance(v, bool):
                    q[k] = ["1" if v else "0"]
                elif v is not None:
                    q[k] = [str(v)]
            return self._action(u, q, act=True)

        if u.path == "/note/capture":
            data, err = self._note_json(2 * 1024 * 1024)
            if err:
                return self.send_json(err[0], err[1])
            if any(not isinstance(data.get(k) or "", str) for k in ("body", "title", "source")):
                return self.send_json(400, {"ok": False, "error": "bad note"})
            r = notes_organizer.capture(data.get("body") or "", data.get("title") or None,
                                        data.get("source") or "dashboard", data.get("clientId"))
            if not r.get("ok"):
                return self.send_json(400, r)
            try:
                r["inbox"] = len(notes_organizer.list_inbox())
            except Exception:
                r["inbox"] = 0
            return self.send_json(200, r)

        if u.path == "/note/save":
            # inline edit from the graph drawer: replace a filed note's BODY,
            # preserving its frontmatter; path-confined to the Notes tree + backed up.
            data, err = self._note_json(2 * 1024 * 1024)
            if err:
                return self.send_json(err[0], err[1])
            base_hash, base_mtime = data.get("baseHash"), data.get("baseMtime")
            if base_hash is not None and not (isinstance(base_hash, str) and re.fullmatch(r"[0-9a-f]{64}", base_hash)):
                return self.send_json(400, {"ok": False, "error": "bad baseHash"})
            if base_mtime is not None and (isinstance(base_mtime, bool) or not isinstance(base_mtime, (int, float))
                                           or base_mtime != base_mtime or base_mtime in (float("inf"), float("-inf"))):
                return self.send_json(400, {"ok": False, "error": "bad baseMtime"})
            if not isinstance(data.get("body") or "", str) or not isinstance(data.get("path") or "", str):
                return self.send_json(400, {"ok": False, "error": "bad note"})
            r = notes_organizer.save_note(data.get("path") or "", data.get("body") or "", base_mtime,
                                          base_hash, data.get("keepBackup") is True)
            return self.send_json(200 if r.get("ok") else 409 if r.get("conflict") else 400, r)

        if u.path == "/note/create":
            length = int(self.headers.get("Content-Length", 0) or 0)
            try:
                data = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                return self.send_json(400, {"error": "bad json"})
            r = notes_blocks.create_note(data.get("folder") or "", data.get("title") or "",
                                        data.get("body") or "", data.get("tags") or [],
                                        data.get("type") or None, data.get("summary") or "")
            if r.get("ok"):
                _notes_changed()
            return self.send_json(200 if r.get("ok") else 400, r)

        if u.path == "/meeting/note":
            length = int(self.headers.get("Content-Length", 0) or 0)
            try:
                data = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                return self.send_json(400, {"error": "bad json"})
            r = notes_blocks.meeting_note(data.get("event") or "")
            return self.send_json(200 if r.get("ok") else 400, r)

        if u.path in ("/note/block-save", "/note/block-add", "/note/block-delete", "/note/block-move"):
            # per-section editing. save/add/delete splice ONE block's line range back
            # into the body, so every other byte of a long note is left alone.
            length = int(self.headers.get("Content-Length", 0) or 0)
            try:
                data = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                return self.send_json(400, {"error": "bad json"})
            rel = data.get("path") or ""
            try:
                if u.path == "/note/block-save":
                    r = notes_blocks.save_block(rel, int(data.get("index")),
                                                data.get("heading"), data.get("body"))
                elif u.path == "/note/block-add":
                    after = data.get("after")
                    r = notes_blocks.add_block(rel, data.get("kind") or "text",
                                               data.get("heading") or "", data.get("body") or "",
                                               None if after is None else int(after))
                elif u.path == "/note/block-delete":
                    r = notes_blocks.delete_block(rel, int(data.get("index")))
                else:
                    r = notes_blocks.move_block(rel, int(data.get("index")), int(data.get("to")))
            except (TypeError, ValueError):
                return self.send_json(400, {"error": "index must be an integer"})
            return self.send_json(200 if r.get("ok") else 400, r)

        if u.path == "/note/attachment-save":
            # a pasted or dropped image -> Notes/attachments/<name>.png; returns the
            # ![[embed]] the caller drops into a block
            length = int(self.headers.get("Content-Length", 0) or 0)
            try:
                data = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                return self.send_json(400, {"error": "bad json"})
            r = notes_blocks.save_attachment(data.get("data") or "", data.get("stem") or "pasted")
            return self.send_json(200 if r.get("ok") else 400, r)

        if u.path in ("/note/diagram-archive", "/note/diagram-restore"):
            # Delete in the Diagrams library = MOVE the diagram's files into
            # Preparation/Diagrams/archive/ (never unlinked); restore is its undo
            length = int(self.headers.get("Content-Length", 0) or 0)
            try:
                data = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                return self.send_json(400, {"error": "bad json"})
            r = (notes_blocks.archive_diagram(data.get("name") or "")
                 if u.path == "/note/diagram-archive"
                 else notes_blocks.restore_diagram(data.get("moved") if isinstance(data.get("moved"), list) else []))
            return self.send_json(200 if r.get("ok") else 400, r)

        if u.path == "/note/drawer-save":
            length = int(self.headers.get("Content-Length", 0) or 0)
            try:
                data = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                return self.send_json(400, {"error": "bad json"})
            r = notes_blocks.save_drawer(data.get("name") or None, data.get("title") or "",
                                         data.get("doc"), data.get("png") or "",
                                         data.get("baseMtime"))
            return self.send_json(200 if r.get("ok") else 409 if r.get("conflict") else 400, r)

        if u.path == "/note/drawer-rename":
            data, bad = self._note_json(limit=16 * 1024)
            if bad:
                return self.send_json(*bad)
            r = notes_blocks.rename_drawer(str(data.get("name") or ""), str(data.get("title") or ""))
            return self.send_json(200 if r.get("ok") else 409 if r.get("exists") else 404 if r.get("error") == "not found" else 400, r)

        if u.path in ("/note/drawer-template-save", "/note/drawer-template-delete"):
            data, bad = self._note_json(limit=1024 * 1024)
            if bad:
                return self.send_json(*bad)
            if u.path == "/note/drawer-template-delete":
                r = notes_blocks.delete_template(data.get("name"))
                return self.send_json(200 if r.get("ok") else 404 if r.get("error") == "not found" else 400, r)
            r = notes_blocks.save_template(data.get("name"), data.get("doc"), data.get("overwrite") is True)
            return self.send_json(200 if r.get("ok") else 409 if r.get("exists") else 400, r)

        if u.path == "/note/file":
            length = int(self.headers.get("Content-Length", 0) or 0)
            try:
                data = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                return self.send_json(400, {"error": "bad json"})
            rel = (data.get("path") or "").strip()
            folder = (data.get("folder") or "").strip()
            try:
                src = (notes_organizer.VAULT / rel).resolve()
                notes_root = notes_organizer.NOTES.resolve()
                in_notes = notes_root in src.parents
                if not rel or src.suffix != ".md" or not src.exists() or not (
                        in_notes or notes_organizer._confined_project_note(rel) is not None):
                    return self.send_json(400, {"ok": False, "error": "not a fileable note"})
            except Exception:
                return self.send_json(400, {"ok": False, "error": "bad path"})
            r = notes_organizer.file_any(rel, folder)
            if r.get("ok"):
                _notes_changed()
            return self.send_json(200 if r.get("ok") else 400, r)

        if u.path == "/note/move":
            # move ANY note (Notes tree bar Daily/ and Archive/, or a project note, a dated log)
            # to a folder, the inbox, or "project:<key>". Undoable: {ok, path, from, undo_id}.
            data, err = self._note_json()
            if err:
                return self.send_json(err[0], err[1])
            rel, to = str(data.get("path") or "").strip(), str(data.get("to") or "").strip()
            if not rel or not to:
                return self.send_json(400, {"ok": False, "error": "path and to are required"})
            try:
                r = notes_organizer.move_note(rel, to)
            except (OSError, ValueError) as e:
                return self.send_json(500, {"ok": False, "error": "move failed: %s" % type(e).__name__})
            if r.get("ok"):
                _notes_changed()
            return self.send_json(200 if r.get("ok") else 400, r)

        if u.path == "/note/undo":
            # undo the most recent (or the named) file/move: original bytes back where
            # they came from; an edited moved copy is kept, never lost.
            data, err = self._note_json()
            if err:
                return self.send_json(err[0], err[1])
            try:
                r = notes_organizer.undo(data.get("undo_id") or None)
            except (OSError, ValueError) as e:
                return self.send_json(500, {"ok": False, "error": "undo failed: %s" % type(e).__name__})
            if r.get("ok"):
                _notes_changed()
            return self.send_json(200 if r.get("ok") else 400, r)

        if u.path in ("/note/archive", "/note/unarchive"):
            length = int(self.headers.get("Content-Length", 0) or 0)
            try:
                data = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                return self.send_json(400, {"error": "bad json"})
            rel = (data.get("path") or "").strip()
            fn = notes_organizer.archive_any if u.path == "/note/archive" else notes_organizer.unarchive_any
            r = fn(rel)
            if r.get("ok"):
                _notes_changed()
            return self.send_json(200 if r.get("ok") else 400, r)

        if u.path == "/app/author-profile":
            length = int(self.headers.get("Content-Length", 0) or 0)
            try:
                data = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                return self.send_json(400, {"error": "bad json"})
            r = all_in_one_academic.create_author_profile((data.get("name") or "").strip())
            return self.send_json(200 if r.get("ok") else 400, r)

        if u.path == "/events/create":
            # double-click-to-add on the dashboard calendar -> a vault event file
            # (mirrors straight into Obsidian's Full Calendar).
            length = int(self.headers.get("Content-Length", 0) or 0)
            try:
                data = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                return self.send_json(400, {"error": "bad json"})
            res = create_event(data)
            return self.send_json(200 if res.get("ok") else 400, res)

        if u.path == "/events/update":
            # click-an-event-to-edit popup on the dashboard calendar.
            length = int(self.headers.get("Content-Length", 0) or 0)
            try:
                data = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                return self.send_json(400, {"error": "bad json"})
            res = update_event(data)
            return self.send_json(200 if res.get("ok") else 400, res)

        if u.path == "/events/delete":
            # click-an-event delete button on the dashboard calendar (soft-delete).
            length = int(self.headers.get("Content-Length", 0) or 0)
            try:
                data = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                return self.send_json(400, {"error": "bad json"})
            res = archive_event((data.get("path") or "").strip())
            return self.send_json(200 if res.get("ok") else 400, res)

        if u.path == "/events/resolve":
            length = int(self.headers.get("Content-Length", 0) or 0)
            try:
                data = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                return self.send_json(400, {"error": "bad json"})
            res = resolve_event(data)
            return self.send_json(200 if res.get("ok") else 400, res)

        if u.path == "/daily/habit":
            length = int(self.headers.get("Content-Length", 0))
            try:
                data = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                return self.send_json(400, {"error": "bad json"})
            habits = toggle_habit(data.get("key", ""))
            if habits is None:
                return self.send_json(400, {"error": "bad habit key"})
            pre = _PRE.get("routines")
            if pre is not None:
                try:
                    pre.refresh()
                except Exception:
                    pass
            return self.send_json(200, {"habits": habits})
        if u.path == "/goals/toggle":
            length = int(self.headers.get("Content-Length", 0))
            try:
                data = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                return self.send_json(400, {"error": "bad json"})
            goals = toggle_goal(data.get("key", ""))
            if goals is None:
                return self.send_json(400, {"error": "goal not found"})
            return self.send_json(200, {"goals": goals})
        if u.path == "/daily/section":
            length = int(self.headers.get("Content-Length", 0))
            try:
                data = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                return self.send_json(400, {"error": "bad json"})
            day = None
            if data.get("date"):
                day = _valid_recent_date(data.get("date"))
                if not day:
                    return self.send_json(400, {"error": "bad date"})
            r = set_daily_section(data.get("anchor", ""), data.get("text", ""), day)
            return self.send_json(200, r) if r else self.send_json(400, {"error": "bad anchor"})
        if u.path == "/learning/review":
            length = int(self.headers.get("Content-Length", 0))
            try:
                data = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                return self.send_json(400, {"error": "bad json"})
            try:
                ordn = int(data.get("ord", -1))
            except (TypeError, ValueError):
                ordn = -1
            try:
                r = learning.review(str(LEARNING_ROOT), str(VAULT), data.get("path", ""), ordn, data.get("response", ""))
            except Exception as e:
                return self.send_json(500, {"error": str(e)})
            _learn_cache["data"] = None  # counts changed
            if r and r.get("ok"):
                return self.send_json(200, r)
            return self.send_json(400, {"error": (r or {}).get("error") or "review failed"})
        if u.path == "/learning/shelve":
            length = int(self.headers.get("Content-Length", 0))
            try:
                data = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                return self.send_json(400, {"error": "bad json"})
            deck = (data.get("deck") or "").strip()
            if not deck:
                return self.send_json(400, {"error": "bad deck"})
            s = load_shelved()
            s.add(deck) if data.get("shelved") else s.discard(deck)
            save_shelved(s)
            _learn_cache["data"] = None  # due count changed
            return self.send_json(200, {"shelved": sorted(s)})
        if u.path == "/learning/board":
            length = int(self.headers.get("Content-Length", 0))
            try:
                data = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                return self.send_json(400, {"error": "bad json"})
            in_prog = [str(x) for x in (data.get("inProgress") or [])]
            queue = [str(x) for x in (data.get("queue") or [])]
            # keep only decks that actually exist; drop dupes (in-progress wins)
            present = {r["deck"] for r in learn_scan()["decks"]}
            in_prog = [n for n in dict.fromkeys(in_prog) if n in present]
            in_set = set(in_prog)
            queue = [n for n in dict.fromkeys(queue) if n in present and n not in in_set]
            save_board({"inProgress": in_prog, "queue": queue})
            return self.send_json(200, learn_scan())
        if u.path == "/learning/flag":
            length = int(self.headers.get("Content-Length", 0))
            try:
                data = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                return self.send_json(400, {"error": "bad json"})
            path = (data.get("path") or "").strip()
            try:
                ordn = int(data.get("ord", -1))
            except (TypeError, ValueError):
                ordn = -1
            if not path or ordn < 0:
                return self.send_json(400, {"error": "bad card"})
            fid = _flag_id(path, ordn)
            flags = load_flags()
            if data.get("clear"):
                kept = [f for f in flags if f.get("id") != fid]
                if len(kept) != len(flags):
                    save_flags(kept)
                return self.send_json(200, {"ok": True, "cleared": True, "id": fid})
            now = datetime.now().isoformat(timespec="seconds")
            rec = next((f for f in flags if f.get("id") == fid), None)
            reason = str(data.get("reason") or "").strip()[:2000]
            if rec is None:
                rec = {"id": fid, "path": path, "ord": ordn,
                       "deck": str(data.get("deck") or "").strip(),
                       "front": str(data.get("front") or "").strip()[:400],
                       "reason": reason, "created": now, "status": "open"}
                flags.append(rec)
            else:
                rec["reason"] = reason or rec.get("reason", "")
                rec["deck"] = str(data.get("deck") or rec.get("deck") or "").strip()
                rec["front"] = str(data.get("front") or rec.get("front") or "").strip()[:400]
                rec["status"] = "open"
                rec["updated"] = now
            save_flags(flags)
            return self.send_json(200, {"ok": True, "flag": rec})
        if u.path == "/learning/flag-resolve":
            length = int(self.headers.get("Content-Length", 0))
            try:
                data = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                return self.send_json(400, {"error": "bad json"})
            fid = (data.get("id") or "").strip()
            status = (data.get("status") or "fixed").strip()
            if not fid or status not in ("open", "fixed"):
                return self.send_json(400, {"error": "bad flag"})
            flags = load_flags()
            rec = next((f for f in flags if f.get("id") == fid), None)
            if rec is None:
                return self.send_json(404, {"error": "no such flag"})
            rec["status"] = status
            rec["updated"] = datetime.now().isoformat(timespec="seconds")
            save_flags(flags)
            return self.send_json(200, {"ok": True, "flag": rec})
        if u.path == "/reading/openalex-import":
            length = int(self.headers.get("Content-Length", 0))
            try:
                data = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                return self.send_json(400, {"error": "bad json"})
            try:
                return self.send_json(200, _openalex_import(data))
            except Exception as e:
                return self.send_json(500, {"error": str(e)[:200]})
        if u.path == "/reading/inbox/cite-preview":
            length = int(self.headers.get("Content-Length", 0))
            try:
                data = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                return self.send_json(400, {"error": "bad json"})
            return self.send_json(200, litcite.preview(data.get("fields") or {}))
        if u.path == "/reading/inbox/act":
            length = int(self.headers.get("Content-Length", 0))
            try:
                data = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                return self.send_json(400, {"error": "bad json"})
            try:
                r = litinbox.act(data)
            except Exception as e:
                return self.send_json(500, {"error": str(e)[:200]})
            return self.send_json(200 if r.get("ok") else 400, r)
        if u.path == "/reading/status":
            origin = (self.headers.get("Origin") or "").strip()
            if origin and not self._BOARD_ORIGIN_RE.match(origin):
                return self.send_json(403, {"error": "cross-origin write refused"})
            length = int(self.headers.get("Content-Length", 0))
            try:
                data = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                return self.send_json(400, {"error": "bad json"})
            cp, state = (data or {}).get("citationPath"), (data or {}).get("state")
            if not isinstance(cp, str) or state not in ("read", "reading", "unread"):
                return self.send_json(400, {"error": "citationPath and state required"})
            if _citation_note_path(cp) is None:
                return self.send_json(400, {"error": "not a citation note"})
            set_citation_status(cp, state)
            invalidate_scan()
            return self.send_json(200, {"ok": True, "readState": state})
        if u.path.startswith("/reading/") and u.path[9:] in READING_OPS:
            op = u.path[9:]
            origin = (self.headers.get("Origin") or "").strip()
            if origin and not self._BOARD_ORIGIN_RE.match(origin):
                return self.send_json(403, {"error": "cross-origin write refused"})
            length = int(self.headers.get("Content-Length", 0))
            try:
                data = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                return self.send_json(400, {"error": "bad json"})
            if not isinstance(data, dict):
                return self.send_json(400, {"error": "bad json"})
            r = reading.handle(op, data)
            if r is None:
                return self.send_json(409, {"error": "not found"})
            if isinstance(r, dict) and r.get("ok") is False:
                return self.send_json(400, r)
            # toggle/edit may return a citation-note status to sync (authoritative read-state)
            cit = r.pop("citation", None) if isinstance(r, dict) else None
            if cit and cit.get("path"):
                set_citation_status(cit["path"], cit["state"])
            return self.send_json(200, r)
        if u.path.startswith("/printbook/") and u.path[11:] in printbook.OPS:
            origin = (self.headers.get("Origin") or "").strip()
            if origin and not self._BOARD_ORIGIN_RE.match(origin):
                return self.send_json(403, {"error": "cross-origin write refused"})
            length = int(self.headers.get("Content-Length", 0))
            try:
                data = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                return self.send_json(400, {"error": "bad json"})
            if not isinstance(data, dict):
                return self.send_json(400, {"error": "bad json"})
            r = printbook.OPS[u.path[11:]](data)
            if r.get("ok") and u.path[11:] in ("create", "add", "delete"):
                invalidate_scan()
                schedule_cache_rebuild()
            return self.send_json(200 if r.get("ok") else 400, r)
        if u.path == "/rebuild-cache":
            _do_rebuild()   # synchronous so the client can re-fetch fresh data right after
            return self.send_json(200, {"ok": True, "generated": cache_generated()})
        if u.path == "/project/proposal":
            length = int(self.headers.get("Content-Length", 0))
            try:
                data = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                return self.send_json(400, {"error": "bad json"})
            try:
                return self.send_json(200, projectplan.stage(data))
            except ValueError as e:
                return self.send_json(400, {"error": str(e)})
            except Exception as e:
                return self.send_json(500, {"error": str(e)})
        if u.path == "/project/finalize":
            length = int(self.headers.get("Content-Length", 0))
            try:
                override = json.loads(self.rfile.read(length) or b"{}") if length else {}
            except Exception:
                override = {}
            try:
                committed = projectplan.finalize(override, override.get("slug"))
            except ValueError as e:
                return self.send_json(400, {"error": str(e)})
            except Exception as e:
                return self.send_json(500, {"error": str(e)})
            invalidate_scan()
            return self.send_json(200, {"ok": True, "committed": committed})
        if u.path in ("/project/save", "/project/new"):
            length = int(self.headers.get("Content-Length", 0))
            try:
                data = json.loads(self.rfile.read(length) or b"{}") if length else {}
            except Exception:
                return self.send_json(400, {"error": "bad json"})
            fn = {"/project/save": projectplan.save, "/project/new": projectplan.create}[u.path]
            try:
                if u.path == "/project/save": return self.send_json(200, fn(data, data.get("slug")))
                return self.send_json(200, fn(data))
            except ValueError as e:
                return self.send_json(400, {"error": str(e)})
            except Exception as e:
                return self.send_json(500, {"error": str(e)})
        if u.path == "/project/dismiss":
            try:
                length = int(self.headers.get("Content-Length", 0)); data = json.loads(self.rfile.read(length) or b"{}") if length else {}
                return self.send_json(200, projectplan.dismiss(data.get("slug")))
            except Exception as e:
                return self.send_json(500, {"error": str(e)})
        if u.path == "/project/archive":
            # unpin the finalized chain from the timeline: snapshot to the durable
            # archive (Insights Archive reads it) + flip status to archived
            try:
                length = int(self.headers.get("Content-Length", 0)); data = json.loads(self.rfile.read(length) or b"{}") if length else {}
                return self.send_json(200, projectplan.archive(data.get("slug")))
            except Exception as e:
                return self.send_json(500, {"error": str(e)})
        if u.path in systems.POST_PATHS:
            data, err = self._json_post(limit=64 * 1024)
            if err:
                return self.send_json(*err)
            return self.send_json(*systems.http_post(str(SYSTEMS_ROOT), u.path, data))


        # ---- Drafting view: safe writes (mtime-guarded, backed up, atomic)
        if u.path == "/drafting/save":
            length = int(self.headers.get("Content-Length", 0) or 0)
            try:
                data = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                return self.send_json(400, {"error": "bad json"})
            res = drafting.save(VAULT, data.get("slug"), data.get("which"),
                                data.get("text"), data.get("baseMtime"),
                                False, data.get("doc") or "paper.md",
                                base_text=data.get("baseText"))
            # re-index this project's embeds after a manuscript save (throttled so a
            # burst of autosaves re-hashes the figures at most once every few seconds)
            if res.get("ok") and data.get("slug"):
                audit_index.refresh_project(VAULT, data.get("slug"), min_interval_ms=6000)
            code = 200 if res.get("ok") else (409 if res.get("conflict") else 400)
            return self.send_json(code, res)

        if u.path == "/drafting/file-save":
            length = int(self.headers.get("Content-Length", 0) or 0)
            try:
                data = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                return self.send_json(400, {"error": "bad json"})
            res = drafting.write_project_file(VAULT, data.get("slug"), data.get("path"),
                                              data.get("text"), data.get("baseMtime"))
            code = 200 if res.get("ok") else (409 if res.get("conflict") else 400)
            return self.send_json(code, res)

        if u.path == "/drafting/doc-create":
            length = int(self.headers.get("Content-Length", 0) or 0)
            try:
                data = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                return self.send_json(400, {"error": "bad json"})
            res = drafting.create_document(VAULT, data.get("slug"), data.get("name"),
                                           data.get("title") or "",
                                           kind=data.get("kind") or "")
            return self.send_json(200 if not res.get("error") else 400, res)

        if u.path == "/drafting/supplement-create":
            length = int(self.headers.get("Content-Length", 0) or 0)
            try:
                data = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                return self.send_json(400, {"error": "bad json"})
            res = drafting.create_supplement(VAULT, data.get("slug"), data.get("name"))
            return self.send_json(200 if not res.get("error") else 400, res)

        if u.path == "/drafting/measure-save":
            length = int(self.headers.get("Content-Length", 0) or 0)
            try:
                data = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                return self.send_json(400, {"error": "bad json"})
            res = drafting.save_measure(VAULT, data.get("id"), data.get("text"),
                                        data.get("baseMtime"), False)
            code = 200 if res.get("ok") else (409 if res.get("conflict") else 400)
            return self.send_json(code, res)

        if u.path == "/drafting/syllabus-save":
            length = int(self.headers.get("Content-Length", 0) or 0)
            try:
                data = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                return self.send_json(400, {"error": "bad json"})
            res = drafting.save_syllabus(VAULT, data.get("id"), data.get("text"),
                                         data.get("baseMtime"), False)
            code = 200 if res.get("ok") else (409 if res.get("conflict") else 400)
            return self.send_json(code, res)

        if u.path == "/drafting/syllabus-render":
            length = int(self.headers.get("Content-Length", 0) or 0)
            try:
                data = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                return self.send_json(400, {"error": "bad json"})
            res = drafting.render_syllabus(VAULT, data.get("id"))
            return self.send_json(200 if res.get("ok") else 500, res)

        if u.path == "/drafting/syllabus-push":
            length = int(self.headers.get("Content-Length", 0) or 0)
            try:
                data = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                return self.send_json(400, {"error": "bad json"})
            try:
                res = syllabi.push(data.get("list") or "", section=data.get("section"),
                                   queue_downloads=bool(data.get("queueDownloads", True)),
                                   board_name=data.get("name"))
            except Exception as e:
                return self.send_json(500, {"error": str(e)})
            return self.send_json(200 if not res.get("error") else 400, res)

        if u.path == "/drafting/syllabus-distill":
            length = int(self.headers.get("Content-Length", 0) or 0)
            try:
                data = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                return self.send_json(400, {"error": "bad json"})
            try:
                res = syllabi.distill(data.get("slug") or "", force=bool(data.get("force")))
            except Exception as e:
                return self.send_json(500, {"error": str(e)})
            return self.send_json(200 if res.get("ok") else 400, res)

        if u.path == "/drafting/status":
            length = int(self.headers.get("Content-Length", 0) or 0)
            try:
                data = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                return self.send_json(400, {"error": "bad json"})
            res = drafting.set_status(data.get("key"), data.get("status"))
            return self.send_json(200 if res.get("ok") else 400, res)

        if u.path in ("/planning/commitment", "/planning/commitment/delete",
                      "/planning/next", "/planning/focus"):
            data, err = self._json_post(limit=16 * 1024)
            if err:
                return self.send_json(*err)
            if u.path == "/planning/commitment":
                res = planning.save_commitment(VAULT, data)
            elif u.path == "/planning/commitment/delete":
                res = planning.archive_commitment(VAULT, data.get("id"))
            elif u.path == "/planning/next":
                res = planning.set_next(VAULT, data.get("key"), data.get("text"))
            else:
                res = planning.set_focus(VAULT, data.get("keys"))
            return self.send_json(200 if res.get("ok") else 400, res)

        if u.path == "/drafting/pin":
            # pin a library card so it always leads the library in its own section
            length = int(self.headers.get("Content-Length", 0) or 0)
            try:
                data = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                return self.send_json(400, {"error": "bad json"})
            res = drafting.set_pin(data.get("key"), bool(data.get("pinned")))
            return self.send_json(200 if res.get("ok") else 400, res)

        if u.path == "/drafting/create-project":
            # README-first project creation (project-docs contract): folder +
            # templated README + logs/; the full workflow scaffolds later
            length = int(self.headers.get("Content-Length", 0) or 0)
            try:
                data = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                return self.send_json(400, {"error": "bad json"})
            res = drafting.create_project(VAULT, data.get("title"), data.get("idea") or "",
                                          kind=data.get("kind") or "paper")
            return self.send_json(200 if res.get("ok") else 400, res)

        if u.path == "/drafting/scaffold-project":
            # grow a README-first project into the full replication/results layout
            length = int(self.headers.get("Content-Length", 0) or 0)
            try:
                data = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                return self.send_json(400, {"error": "bad json"})
            res = drafting.scaffold_project(VAULT, data.get("slug"))
            return self.send_json(200 if res.get("ok") else 400, res)

        if u.path == "/drafting/archive-project":
            length = int(self.headers.get("Content-Length", 0) or 0)
            try:
                data = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                return self.send_json(400, {"error": "bad json"})
            res = drafting.archive_project(VAULT, data.get("slug"), data.get("mode"))
            return self.send_json(200 if res.get("ok") else 400, res)

        if u.path == "/drafting/restore-project":
            # bring an archived project back to papers/<prefix><slug>
            length = int(self.headers.get("Content-Length", 0) or 0)
            try:
                data = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                return self.send_json(400, {"error": "bad json"})
            res = drafting.restore_project(VAULT, data.get("name"))
            return self.send_json(200 if res.get("ok") else 400, res)

        if u.path == "/drafting/appendix-sync":
            length = int(self.headers.get("Content-Length", 0) or 0)
            try:
                data = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                return self.send_json(400, {"error": "bad json"})
            res = drafting.sync_appendix(VAULT, data.get("slug"), bool(data.get("dryRun")))
            return self.send_json(200 if not res.get("error") else 400, res)

        if u.path == "/drafting/deck-review":
            # save a deck's per-slide improvement-comments sidecar (mtime-guarded)
            length = int(self.headers.get("Content-Length", 0) or 0)
            try:
                data = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                return self.send_json(400, {"error": "bad json"})
            res = drafting.save_review(VAULT, data.get("slug"), data.get("deck"),
                                       data.get("text"), data.get("baseMtime"), False)
            code = 200 if res.get("ok") else (409 if res.get("conflict") else 400)
            return self.send_json(code, res)

        if u.path == "/drafting/deck-note":
            # save ONE slide's speaker note back to the deck's companion notes file
            # (surgical, mtime-guarded — preserves every other section + trailing blocks)
            length = int(self.headers.get("Content-Length", 0) or 0)
            try:
                data = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                return self.send_json(400, {"error": "bad json"})
            res = drafting.save_deck_note(VAULT, data.get("slug"), data.get("deck"),
                                          data.get("slide"), data.get("text"),
                                          data.get("baseMtime"), False)
            code = 200 if res.get("ok") else (409 if res.get("conflict") else 400)
            return self.send_json(code, res)

        if u.path == "/drafting/concept":
            length = int(self.headers.get("Content-Length", 0) or 0)
            try:
                data = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                return self.send_json(400, {"error": "bad json"})
            res = drafting.save_concept(VAULT, data.get("slug"), data.get("text"),
                                        data.get("baseMtime"), False)
            code = 200 if res.get("ok") else (409 if res.get("conflict") else 400)
            return self.send_json(code, res)

        if u.path == "/drafting/sync-editor":
            length = int(self.headers.get("Content-Length", 0) or 0)
            try:
                data = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                return self.send_json(400, {"error": "bad json"})
            res = drafting.sync_editor(VAULT, data.get("slug"), data.get("baseMtime"),
                                       False, data.get("doc") or "paper.md")
            code = 200 if res.get("ok") else (409 if res.get("conflict") else 400)
            return self.send_json(code, res)

        if u.path == "/drafting/sync-outline":
            # regenerate the outline's section list from the manuscript headings,
            # preserving thesis/themes + per-section planning
            length = int(self.headers.get("Content-Length", 0) or 0)
            try:
                data = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                return self.send_json(400, {"error": "bad json"})
            res = drafting.sync_outline(VAULT, data.get("slug"), data.get("baseMtime"),
                                        False, data.get("doc") or "paper.md")
            code = 200 if res.get("ok") else (409 if res.get("conflict") else 400)
            return self.send_json(code, res)

        if u.path == "/drafting/overleaf-build":
            length = int(self.headers.get("Content-Length", 0) or 0)
            try:
                data = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                return self.send_json(400, {"error": "bad json"})
            res = drafting.build_overleaf(VAULT, data.get("slug"), data.get("doc") or "paper.md")
            return self.send_json(200 if res.get("ok") else (409 if res.get("stale") else 400), res)

        if u.path == "/drafting/publish":
            length = int(self.headers.get("Content-Length", 0) or 0)
            try:
                data = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                return self.send_json(400, {"error": "bad json"})
            _gw = []
            if not data.get("force"):
                try:
                    _slug = data.get("slug"); _doc = data.get("doc") or "paper.md"
                    _paths = drafting._writing_paths(VAULT, _slug, _doc)
                    _ptext = (drafting._read(_paths[0]) or "") if _paths and _paths[0] else ""
                    _cm = references.cite_map(_ptext, references.load_resolver_index(HERE), VAULT, _slug)
                    _bad = sorted(k for k, v in _cm.get("map", {}).items()
                                  if v.get("status") == "unresolved" and not v.get("alias"))
                    if _bad:
                        _gw.append({
                            "error": "ungrounded citations",
                            "unresolved": _bad,
                            "hint": "each in-text cite must resolve in the cite-map (a real "
                                    "Citations/corpus/Clipping note or a verified prior references.md "
                                    "entry) or be a visible [NEEDS CITE: ...] placeholder. Add the "
                                    "source note, or send force:true to override."})
                except Exception:
                    pass
            if not data.get("force"):
                try:
                    _proj = drafting._project_dir(VAULT, data.get("slug"))
                    if _proj:
                        _nrep = numberscheck.check_project(_proj, doc=data.get("doc") or "paper.md")
                        if _nrep.get("blocking"):
                            _gw.append({
                                "error": "numbers gate — an inserted Results-pane number no "
                                         "longer matches its source cell",
                                "numbers": _nrep["blocking"][:20],
                                "hint": "re-run the producing script and re-verify, then change "
                                        "the number in the document (the Numbers panel lists each "
                                        "one with Jump). Send force:true to override."})
                except Exception:
                    pass
            if not data.get("force"):
                try:
                    _qrep = groundcheck.verify_prose_quotes(
                        VAULT, data.get("slug"), data.get("doc") or "paper.md", HERE)
                    if _qrep.get("blocking"):
                        _gw.append({
                            "error": "quote gate — a page-cited quotation contradicts its "
                                     "source note",
                            "quotes": _qrep["blocking"][:20],
                            "hint": "fix the quote/page against the note (or the note against "
                                    "the PDF via a reading pass), or send force:true to override."})
                except Exception:
                    pass
            if not data.get("force"):
                try:
                    _off = drafting.external_stats_offenders(
                        VAULT, data.get("slug"), docs=(data.get("doc") or "paper.md",))
                    if _off:
                        _gw.append({
                            "error": "provenance gate — an embedded external asset displays "
                                     "statistics with no machine-checkable source",
                            "external": [{"doc": d, "stem": s, "reason": r, "detail": det}
                                         for d, s, r, det in _off][:20],
                            "hint": "give the external a statsSource {script, output, verifier} "
                                    "pointing at a committed re-runnable verifier, or replace it with a figure a script "
                                    "produces. Send force:true to override."})
                except Exception:
                    pass
            if (data.get("output") or "pdf").lower() == "docx":
                res = drafting.compile_docx(VAULT, data.get("slug"), data.get("doc") or "paper.md",
                                            options=data.get("options"))
            else:
                res = drafting.compile_pdf(VAULT, data.get("slug"), data.get("doc") or "paper.md",
                                           options=data.get("options"))
            if _gw and isinstance(res, dict):
                res["gateWarnings"] = _gw
            if isinstance(res, dict) and not settings.RUN_VAULT_SCRIPTS:
                res["verifiersSkipped"] = drafting.VERIFIERS_SKIPPED
            return self.send_json(200 if res.get("ok") else 400, res)

        if u.path == "/drafting/verify":
            length = int(self.headers.get("Content-Length", 0) or 0)
            try:
                data = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                return self.send_json(400, {"error": "bad json"})
            try:
                res = groundcheck.verify_all(VAULT, data.get("slug"),
                                             data.get("doc") or "paper.md", HERE)
                return self.send_json(200, res)
            except Exception as exc:
                return self.send_json(400, {"error": str(exc)})

        if u.path == "/drafting/verify-line":
            # gate a single source line (the @-menu insertion check): the quote must
            # exist verbatim in the LIVE note and any cited page must match.
            length = int(self.headers.get("Content-Length", 0) or 0)
            try:
                data = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                return self.send_json(400, {"error": "bad json"})
            try:
                ok, reason = groundcheck.verify_source_line(VAULT, data.get("line") or "")
                return self.send_json(200, {"ok": ok, "reason": reason})
            except Exception as exc:
                return self.send_json(200, {"ok": True, "reason": "gate error (fail-open): %s" % exc})

        if u.path == "/explore/render":
            data, err = self._json_post(explore.MAX_SPEC_BYTES)
            if err:
                return self.send_json(err[0], err[1])
            if (data.get("source") or "open") == "project":
                raw, rerr = explore.render_project_preview(
                    VAULT, data.get("slug"), data.get("stem"), data.get("vl"),
                    data.get("theme") or "day")
            else:
                raw, rerr = explore.render_preview(VAULT, data.get("id"), data.get("vl"),
                                                   data.get("theme") or "day")
            if rerr:
                return self.send_json(400, rerr)
            return self._send_payload(200, "image/svg+xml", raw, cache="no-store")

        if u.path == "/explore/spec-save":
            data, err = self._json_post(explore.MAX_SPEC_BYTES)
            if err:
                return self.send_json(err[0], err[1])
            if (data.get("source") or "open") == "project":
                res = explore.save_project_spec(VAULT, data.get("slug"), data.get("stem"),
                                                data.get("vl"), data.get("title"),
                                                data.get("baseVersion"))
            else:
                res = explore.save_spec(VAULT, data.get("id"), data.get("vl"),
                                        data.get("title"), data.get("baseVersion"))
            return self.send_json(200 if res.get("ok") else 409 if res.get("conflict") else 400, res)

        if u.path == "/explore/comments-save":
            data, err = self._json_post(256 * 1024)
            if err:
                return self.send_json(err[0], err[1])
            res = explore.save_comments(VAULT, data.get("id"), data.get("comments") or [],
                                        data.get("baseVersion"))
            return self.send_json(200 if res.get("ok") else 409 if res.get("conflict") else 400, res)

        if u.path == "/explore/to-agent":
            data, err = self._json_post()
            if err:
                return self.send_json(err[0], err[1])
            if (data.get("source") or "open") == "project":
                res = explore.to_agent_project(VAULT, data.get("slug"), data.get("stem"),
                                               data.get("commentId"))
            else:
                res = explore.to_agent(VAULT, data.get("id"), data.get("commentId"))
            return self.send_json(200 if res.get("ok") else 400, res)

        if u.path == "/explore/refetch":
            data, err = self._json_post()
            if err:
                return self.send_json(err[0], err[1])
            res = explore.refetch(VAULT, data.get("id"))
            return self.send_json(200 if res.get("ok") else 400, res)
        # ---- end Explore writes ------------------------------------------------

        if u.path == "/drafting/rewrite-save":
            length = int(self.headers.get("Content-Length", 0) or 0)
            if length > 4_000_000:
                return self.send_json(413, {"error": "too large"})
            try:
                data = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                return self.send_json(400, {"error": "bad json"})
            if not isinstance(data, dict):
                return self.send_json(400, {"error": "bad json"})
            res = drafting.save_rewrite(VAULT, data.get("slug"), data.get("doc") or "paper.md",
                                        data.get("set"), data.get("drop"))
            return self.send_json(200 if res.get("ok") else 400, res)

        if u.path == "/drafting/suggested-status":
            length = int(self.headers.get("Content-Length", 0) or 0)
            if length > 4_000:
                return self.send_json(413, {"error": "too large"})
            try:
                data = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                return self.send_json(400, {"error": "bad json"})
            if not isinstance(data, dict):
                return self.send_json(400, {"error": "bad json"})
            res = drafting.set_suggested_status(VAULT, data.get("slug"), data.get("id"), data.get("status"))
            return self.send_json(200 if res.get("ok") else 404 if res.get("error") in ("unknown paper", "not found", "no suggestions") else 400, res)

        if u.path in ("/drafting/checklist-save", "/drafting/checklist-template-save"):
            length = int(self.headers.get("Content-Length", 0) or 0)
            if length > 400_000:
                return self.send_json(413, {"error": "too large"})
            try:
                data = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                return self.send_json(400, {"error": "bad json"})
            if not isinstance(data, dict):
                return self.send_json(400, {"error": "bad json"})
            if u.path == "/drafting/checklist-save":
                res = drafting.save_checklist(VAULT, data.get("slug"), data.get("text"), data.get("baseMtime"))
            else:
                res = drafting.save_checklist_template(VAULT, data.get("journal"), data.get("text"))
            return self.send_json(200 if res.get("ok") else 409 if res.get("error") == "stale" else 400, res)

        if u.path == "/drafting/comments-save":
            length = int(self.headers.get("Content-Length", 0) or 0)
            try:
                data = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                return self.send_json(400, {"error": "bad json"})
            if not isinstance(data, dict):
                return self.send_json(400, {"error": "bad json"})
            if "partial" in data and not isinstance(data.get("partial"), bool):
                return self.send_json(400, {"error": "partial must be true or false"})
            res = drafting.save_comments(VAULT, data.get("slug"), data.get("doc") or "paper.md",
                                         data.get("comments") or [],
                                         data.get("baseMtime"), False,
                                         base_version=data.get("baseVersion"),
                                         partial=data.get("partial") is True,
                                         deleted_ids=data.get("deletedIds"))
            return self.send_json(200 if res.get("ok") else 409 if res.get("conflict") else 400, res)

        if u.path == "/drafting/figure-comments-save":
            length = int(self.headers.get("Content-Length", 0) or 0)
            try:
                data = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                return self.send_json(400, {"error": "bad json"})
            res = drafting.save_figure_comments(VAULT, data.get("slug"), data.get("stem"),
                                                data.get("items") or [],
                                                data.get("baseMtime"), False,
                                                data.get("baseVersion"))
            return self.send_json(200 if res.get("ok") else 409 if res.get("conflict") else 400, res)

        if u.path == "/drafting/numbers-bind":
            length = int(self.headers.get("Content-Length", 0) or 0)
            try:
                data = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                return self.send_json(400, {"error": "bad json"})
            proj = drafting._project_dir(VAULT, data.get("slug") or "")
            if not proj:
                return self.send_json(404, {"error": "unknown slug"})
            try:
                res = numberscheck.bind(proj, data.get("entry") or {})
            except Exception as exc:
                res = {"error": str(exc)}
            return self.send_json(200 if res.get("ok") else 400, res)

        if u.path == "/drafting/numbers-update":
            # pin/unpin a key number, edit its note, re-snapshot its source, or retire
            # a binding (kept under "retired" with a reason, never deleted)
            length = int(self.headers.get("Content-Length", 0) or 0)
            try:
                data = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                return self.send_json(400, {"error": "bad json"})
            proj = drafting._project_dir(VAULT, data.get("slug") or "")
            if not proj:
                return self.send_json(404, {"error": "unknown slug"})
            try:
                res = numberscheck.update_entry(proj, str(data.get("id") or ""), data.get("patch") or {})
            except Exception as exc:
                res = {"error": str(exc)}
            return self.send_json(200 if res.get("ok") else 400, res)

        if u.path == "/drafting/diagram-save":
            # persist a hand-drawn concept diagram: results/<stem>.drawio + exported
            # .png + the kind:"external" provenance upsert (drafting.save_diagram)
            length = int(self.headers.get("Content-Length", 0) or 0)
            try:
                data = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                return self.send_json(400, {"error": "bad json"})
            res = drafting.save_diagram(VAULT, data.get("slug"), data.get("name") or "",
                                        data.get("title") or "", data.get("xml") or "",
                                        data.get("png") or "", data.get("baseMtime"),
                                        False)
            return self.send_json(200 if res.get("ok") else 409 if res.get("conflict") else 400, res)

        if u.path == "/drafting/pdf-comments-save":
            length = int(self.headers.get("Content-Length", 0) or 0)
            try:
                data = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                return self.send_json(400, {"error": "bad json"})
            res = drafting.save_publish_comments(VAULT, data.get("slug"), data.get("doc") or "paper.md",
                                                 data.get("comments") or [],
                                                 data.get("baseMtime"), False,
                                                 data.get("baseVersion"))
            return self.send_json(200 if res.get("ok") else 409 if res.get("conflict") else 400, res)

        if u.path == "/present/state":
            # the presenter console publishes its current slide (and active flag) so a
            # remote audience page can follow along
            length = int(self.headers.get("Content-Length", 0) or 0)
            try:
                data = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                return self.send_json(400, {"error": "bad json"})
            try:
                idx = max(0, int(data.get("idx") or 0))
            except (TypeError, ValueError):
                idx = 0
            with PRESENT_LOCK:
                PRESENT_STATE.update({
                    "active": bool(data.get("active", True)),
                    "slug": str(data.get("slug") or "")[:200],
                    "deck": str(data.get("deck") or "")[:200],
                    "idx": idx, "ts": int(time.time() * 1000),
                    "src": "audience" if str(data.get("src") or "") == "audience" else "console",
                })
            return self.send_json(200, {"ok": True})

        if u.path == "/drafting/version-save":
            # checkpoint the doc's exact current bytes under writing/versions/ (no-op when
            # byte-identical to the newest checkpoint)
            length = int(self.headers.get("Content-Length", 0) or 0)
            try:
                data = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                return self.send_json(400, {"error": "bad json"})
            res = drafting.save_version(VAULT, data.get("slug"), data.get("doc") or "paper.md",
                                        data.get("label") or "", data.get("note") or "")
            return self.send_json(200 if res.get("ok") else 400, res)

        if u.path == "/drafting/version-update":
            # rename / re-note a checkpoint (metadata only)
            length = int(self.headers.get("Content-Length", 0) or 0)
            try:
                data = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                return self.send_json(400, {"error": "bad json"})
            res = drafting.update_version(VAULT, data.get("slug"), data.get("id"),
                                          data.get("label"), data.get("note"),
                                          data.get("doc"))
            return self.send_json(200 if res.get("ok") else 400, res)

        if u.path == "/drafting/version-delete":
            length = int(self.headers.get("Content-Length", 0) or 0)
            try:
                data = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                return self.send_json(400, {"error": "bad json"})
            res = drafting.delete_version(VAULT, data.get("slug"), data.get("id"),
                                          data.get("doc"))
            return self.send_json(200 if res.get("ok") else 400, res)

        if u.path == "/drafting/version-restore":
            # write a checkpoint back into the live doc (auto-checkpoints the current state
            # first so it's reversible); mtime-guarded like a normal save
            length = int(self.headers.get("Content-Length", 0) or 0)
            try:
                data = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                return self.send_json(400, {"error": "bad json"})
            res = drafting.restore_version(VAULT, data.get("slug"), data.get("id"),
                                           data.get("doc") or "paper.md",
                                           data.get("baseMtime"), False)
            code = 200 if res.get("ok") else (409 if res.get("conflict") else 400)
            return self.send_json(code, res)

        if u.path == "/drafting/diff-pdf":
            length = int(self.headers.get("Content-Length", 0) or 0)
            try:
                data = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                return self.send_json(400, {"error": "bad json"})
            res = drafting.diff_pdf(VAULT, data.get("slug"), data.get("doc") or "paper.md",
                                    a=data.get("a"), b=data.get("b") or "current")
            return self.send_json(200 if res.get("ok") else 400, res)

        if u.path == "/drafting/write-references":
            length = int(self.headers.get("Content-Length", 0) or 0)
            try:
                data = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                return self.send_json(400, {"error": "bad json"})
            slug = data.get("slug")
            style = references._norm_style(data.get("style") or "asa")
            doc = data.get("doc") or "paper.md"
            paths = drafting._writing_paths(VAULT, slug, doc)
            if not paths or not paths[0].exists():
                return self.send_json(404, {"error": "manuscript not found"})
            try:
                idx = references.load_resolver_index(HERE)
                built = references.build_references(drafting._read(paths[0]) or "", VAULT, idx, style, slug)
                res = references.write_references(VAULT, slug, style=style,
                                                  force=False,
                                                  base_mtime=data.get("baseMtime"),
                                                  markdown=built["markdown"])
            except Exception as e:
                return self.send_json(500, {"error": str(e)})
            if res.get("ok"):
                res["audit"] = built["audit"]
            code = 200 if res.get("ok") else (409 if res.get("conflict") else 400)
            return self.send_json(code, res)

        if u.path == "/drafting/edit-reference":
            length = int(self.headers.get("Content-Length", 0) or 0)
            try:
                data = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                return self.send_json(400, {"error": "bad json"})
            try:
                res = references.edit_reference(
                    VAULT, data.get("slug"), data.get("rel") or "",
                    (data.get("citekey") or "").strip(), data.get("text") or "",
                    here=HERE, note_mtime=data.get("noteMtime"),
                    force=False)
            except Exception as e:
                return self.send_json(500, {"error": str(e)})
            code = 200 if res.get("ok") else (409 if res.get("conflict") else 400)
            return self.send_json(code, res)

        if u.path.startswith("/board/proposals"):
            length = int(self.headers.get("Content-Length", 0))
            try:
                data = json.loads(self.rfile.read(length) or b"{}") if length else {}
            except Exception:
                return self.send_json(400, {"error": "bad json"})
            op = u.path[len("/board/proposals"):].strip("/")
            try:
                if op == "":            # an agent proposes a card; nothing is committed
                    return self.send_json(200, boardproposals.add(data))
                if op == "accept":
                    res = boardproposals.accept(data.get("id") or "", data.get("card"))
                    invalidate_scan()
                    return self.send_json(200, res)
                if op == "reject":
                    return self.send_json(200, boardproposals.reject(data.get("id") or ""))
            except ValueError as e:
                return self.send_json(400, {"error": str(e)})
            except Exception as e:
                return self.send_json(500, {"error": str(e)})
            return self.send_json(404, {"error": "unknown proposals op"})

        if not u.path.startswith("/board/"):
            return self.send_json(404, {"error": "unknown endpoint"})
        p = board_path((parse_qs(u.query).get("path") or [""])[0])
        if p is None:
            return self.send_json(400, {"error": "bad board path"})
        length = int(self.headers.get("Content-Length", 0))
        try:
            data = json.loads(self.rfile.read(length) or b"{}")
        except Exception:
            return self.send_json(400, {"error": "bad json"})
        text = read_text(p)
        if text is None:
            return self.send_json(500, {"error": "board not found"})
        # self-heal: a blank or corrupt personal board would 409 every op forever;
        # rebuild its scaffold so the task lands instead of vanishing.
        if p == PLANNING_BOARD_FILE and not kanban.get_board(text)["lanes"]:
            text = ensure_planning_board()
        op = u.path.rsplit("/", 1)[1]
        if op == "move":
            new = kanban.move_card(text, data.get("raw", ""), data.get("from", ""),
                                   data.get("to", ""), int(data.get("index", 0)))
        elif op == "toggle":
            new = kanban.toggle_card(text, data.get("raw", ""))
        elif op == "add":
            new = kanban.add_card(text, data.get("lane", ""), data.get("text", ""))
        elif op == "edit":
            new = kanban.edit_card(text, data.get("raw", ""), data.get("body", ""))
        elif op == "archive":
            new = kanban.archive_card(text, data.get("raw", ""))
        elif op == "archive_done":
            new = kanban.archive_done(text, data.get("lane") or None)
        elif op == "archive_lane":
            new = kanban.archive_lane(text, data.get("lane") or None)
        elif op == "delete":
            new = kanban.delete_card(text, data.get("raw", ""))
        else:
            return self.send_json(404, {"error": "unknown op"})
        if new is None:
            return self.send_json(409, {"error": "card not found or op failed"})
        write_board(p, text, new)
        invalidate_scan()
        return self.send_json(200, kanban.get_board(new))

    def send_header(self, keyword, value):
        # note a handler's own Cache-Control so the no-store default below defers to it
        k = keyword.lower()
        if k == "cache-control":
            self._own_cache_control = True
        elif k in ("content-length", "transfer-encoding"):
            self._framed = True
            if k == "content-length":
                try:                       # the request log's byte count
                    self._log_bytes = int(value)
                except (TypeError, ValueError):
                    pass
        elif k == "connection":
            self._sent_conn = True
        super().send_header(keyword, value)

    def send_response(self, *a, **kw):
        self._own_cache_control = False
        super().send_response(*a, **kw)

    def log_error(self, fmt, *args):
        if isinstance(fmt, str) and fmt.startswith("Request timed out"):
            return
        super().log_error(fmt, *args)

    def send_response_only(self, code, message=None):
        self._framed = False
        self._sent_conn = False
        self._status = int(code)
        self._log_bytes = 0
        super().send_response_only(code, message)

    def end_headers(self):
        status = getattr(self, "_status", None)
        if status is not None and status >= 200:
            if not getattr(self, "_framed", False) and status not in (204, 304):
                self.close_connection = True
            if self.close_connection and not getattr(self, "_sent_conn", False):
                self._sent_conn = True
                super().send_header("Connection", "close")
        if not getattr(self, "_own_cache_control", False):
            self.send_header("Cache-Control", "no-store")
        _buf = b"".join(getattr(self, "_headers_buffer", [])).lower()
        if b"content-type: image/svg" in _buf or b"/xml" in _buf:
            super().send_header("Content-Security-Policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'")
        super().send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()
        sink = getattr(self, "_head_sink", None)
        if sink is not None:            # a HEAD: the headers are out, drop the body
            sink.headers_done = True

    def handle_one_request(self):
        self._status = None
        self._log_bytes = 0
        self._t0 = None
        try:
            return super().handle_one_request()
        except (ConnectionResetError, BrokenPipeError, TimeoutError, socket.timeout):
            self.close_connection = True
        finally:
            if self._t0 is not None:
                self._record_request(round((time.perf_counter() - self._t0) * 1000, 1))

    def parse_request(self):
        ok = super().parse_request()
        self._t0 = time.perf_counter()      # server time starts here, not at readline
        return ok

    def _record_request(self, ms):
        cmd = getattr(self, "command", None)
        if not cmd or getattr(self, "_status", None) is None:
            return
        path = urlparse(getattr(self, "path", "") or "").path
        status = self._status
        nbytes = self._log_bytes or 0
        _REQ_STATS.add(cmd, path, status, ms, nbytes)
        lg = _req_logger()
        if lg:
            try:
                lg.info("%s %s %s %.1fms %dB", cmd, path, status, ms, nbytes)
            except Exception:
                pass

    def log_message(self, *a):
        pass


try:
    ensure_planning_board()
except Exception:
    pass

try:
    if not PANE_MODE:
        threading.Thread(target=semindex.warm, daemon=True).start()
except Exception:
    pass

# whole-vault search (vault_search.py): imported lazily and guarded, so a missing
# or broken module answers 503 on /search/vault and never stops the Board starting.
_VAULT_SEARCH = {"mod": None, "tried": False}


def _vault_search_mod():
    if not _VAULT_SEARCH["tried"]:
        _VAULT_SEARCH["tried"] = True
        try:
            import vault_search
            _VAULT_SEARCH["mod"] = vault_search
        except Exception:
            _VAULT_SEARCH["mod"] = None
    return _VAULT_SEARCH["mod"]


def _notes_changed():
    try:
        all_in_one_academic.invalidate_notes()
    except Exception:
        pass


try:
    if not PANE_MODE and _vault_search_mod() is not None:
        _vault_search_mod().start_background(VAULT)
except Exception:
    pass

# claim-level search (claims_index.py): lazy and guarded like vault_search.
_CLAIMS = {"mod": None, "tried": False}


def _claims_mod():
    if not _CLAIMS["tried"]:
        _CLAIMS["tried"] = True
        try:
            import claims_index
            _CLAIMS["mod"] = claims_index
        except Exception:
            _CLAIMS["mod"] = None
    return _CLAIMS["mod"]


try:
    if not PANE_MODE and _claims_mod() is not None:
        _claims_mod().start_background(VAULT)
except Exception:
    pass

try:
    import figwarm
    _bg(lambda: figwarm.run(VAULT), "figure-preview-warm")
except Exception:
    pass

try:
    if not PANE_MODE:
        subprocess.Popen([sys.executable, str(settings.CODE_DIR / "build_cache.py")])
except Exception:
    pass


def _periodic_rebuild():
    while True:
        time.sleep(1800)
        schedule_cache_rebuild(0.5)


_bg(_periodic_rebuild, "analytics-rebuild")


_pre_register("tags", lambda: {"tags": merged_tags(), "index": tagindex.status(HERE)}, 600)
_pre_register("reading", _reading_payload, 300)
_pre_register("routines", routines_today, 120)
_pre_register("drafting_papers", lambda: {"papers": drafting.list_papers(VAULT)}, 120)
_pre_register("drafting_grants", lambda: {"grants": drafting.list_grants(VAULT)}, 120)
_pre_register("drafting_reports", lambda: {"reports": drafting.list_reports(VAULT)}, 120)
_pre_register("drafting_presentations",
              lambda: {"presentations": drafting.list_presentations(VAULT)}, 120)
_pre_register("drafting_syllabi", lambda: {"syllabi": drafting.list_syllabi(VAULT)}, 120)
_pre_register("drafting_measures", lambda: {"measures": drafting.list_measures(VAULT)}, 120)
_pre_register("cite_index", lambda: citeindex.compact(HERE), 300)


def _periodic_precompute():
    """Build every registered value immediately, then keep each one inside its own
    interval. One second of granularity, so a write is reflected on the next tick."""
    while True:
        now = time.time()
        did = False
        for p in list(_PRE.values()):
            if p.due(now):
                try:
                    p.refresh()
                    p.warm_bytes()     # serialize + compress here, never in a handler
                except Exception:
                    pass
                did = True
                break
        time.sleep(0.25 if did else 1.0)


_bg(_periodic_precompute, "precompute")


def _sd_notify(state):
    addr = os.environ.get("NOTIFY_SOCKET")
    if not addr:
        return False
    try:
        if addr[0] == "@":                       # abstract namespace
            addr = "\0" + addr[1:]
        with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as s:
            s.connect(addr)
            s.sendall(state.encode("utf-8"))
        return True
    except Exception:
        return False


def _watchdog():
    # the service manager publishes its watchdog interval here, in microseconds
    usec = 0
    try:
        usec = int(os.environ.get("WATCHDOG_USEC") or 0)
    except ValueError:
        usec = 0
    _sd_notify("READY=1")
    if not usec or not os.environ.get("NOTIFY_SOCKET"):
        return                                   # no service manager: nothing to ping
    every = max(5.0, (usec / 1e6) / 4.0)         # four pings per interval: three may be lost
    url = "http://127.0.0.1:%d/health" % PORT
    while True:
        time.sleep(every)
        try:
            with urllib.request.urlopen(url, timeout=max(5.0, every)) as r:
                if r.status == 200:
                    r.read(1)
                    _sd_notify("WATCHDOG=1")
        except Exception:
            pass                                 # a missed ping is the signal; do not fake it


_bg(_watchdog, "watchdog")


def _periodic_notes_graph():
    while True:
        try:
            notes_organizer.graph()
        except Exception:
            pass
        time.sleep(max(60, notes_organizer._GRAPH_CACHE_SECS - 30))


_bg(_periodic_notes_graph, "notes-graph")


import glimpse
if not PANE_MODE:                      # the pane has no scanners to refresh
    glimpse.start(globals())
# ---- end glimpse ----

# compress the Board bundle now, off the request path (see _static_repr)
_bg(_warm_bundle, "warm-bundle")

class BoardServer(http.server.ThreadingHTTPServer):
    request_queue_size = 128


with BoardServer(("127.0.0.1", PORT), Handler) as httpd:
    print("Serving on http://127.0.0.1:%d" % PORT, flush=True)
    httpd.serve_forever()
