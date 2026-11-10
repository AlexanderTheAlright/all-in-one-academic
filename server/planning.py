"""Planning: the commitments ledger, the one commitments reader, and the pipeline."""
import json
import re
import threading
import uuid
from datetime import date, datetime, timedelta
from pathlib import Path

import drafting
import settings

LEDGER_REL = Path("Preparation") / "Calendar" / "commitments.json"
DEADLINES_REL = Path("Preparation") / "Calendar" / "events" / "deadlines"

TITLE_MAX = 200
NOTE_MAX = 1000
NEXT_MAX = 300
FOCUS_MAX = 3
STALE_DAYS = 21

_ISO = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_KEY = re.compile(r"^(paper|report|deck|measure|syllabus):[^\x00-\x1f\x7f]{1,280}$")

_LOCK = threading.Lock()


def _today():
    return date.today()


def iso_week(d=None):
    y, w, _ = ((d or _today()) + timedelta(days=1)).isocalendar()
    return "%d-W%02d" % (y, w)


def ledger_path(vault):
    return Path(vault) / LEDGER_REL


def _load(vault):
    try:
        data = json.loads(ledger_path(vault).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        data = {}
    if not isinstance(data, dict):
        data = {}
    rows = data.get("commitments")
    nxt = data.get("next")
    focus = data.get("focus")
    arch = data.get("archived")
    return {
        "commitments": [r for r in rows if isinstance(r, dict)] if isinstance(rows, list) else [],
        "next": nxt if isinstance(nxt, dict) else {},
        "focus": focus if isinstance(focus, dict) else {},
        "archived": arch if isinstance(arch, list) else [],
    }


def _save(vault, data):
    p = ledger_path(vault)
    p.parent.mkdir(parents=True, exist_ok=True)
    drafting._atomic_write_json(p, data)


def _days(iso):
    try:
        return (date.fromisoformat(iso) - _today()).days
    except (TypeError, ValueError):
        return None


def valid_key(k):
    return isinstance(k, str) and bool(_KEY.match(k))


def _valid_date(s):
    if not isinstance(s, str) or not _ISO.match(s):
        return False
    try:
        date.fromisoformat(s)
        return True
    except ValueError:
        return False


def _clean_text(s, cap):
    if not isinstance(s, str):
        return None
    s = re.sub(r"[\x00-\x08\x0b-\x1f\x7f]", "", s).strip()
    return s if len(s) <= cap else None


# ------------------------------------------------------------------ sources
def _ledger_items(data, include_done):
    out = []
    for r in data["commitments"]:
        d = r.get("date")
        days = _days(d)
        if days is None:
            continue
        done = bool(r.get("done"))
        if done and not include_done:
            continue
        out.append({"id": str(r.get("id") or ""), "title": str(r.get("title") or ""),
                    "date": d, "days": days, "source": "ledger",
                    "project": r.get("project") or None, "editable": True,
                    "done": done, "note": str(r.get("note") or "")})
    return out


def _fm(text):
    """Flat `key: value` frontmatter; enough for title/date/completed."""
    if not text.startswith("---"):
        return {}
    end = text.find("\n---", 3)
    if end < 0:
        return {}
    out = {}
    for line in text[3:end].splitlines():
        m = re.match(r"^([A-Za-z_][\w-]*):\s*(.*)$", line)
        if m:
            out[m.group(1)] = m.group(2).strip().strip('"').strip("'")
    return out


def _read_deadline_events(vault):
    root = Path(vault) / DEADLINES_REL
    out = []
    if not root.is_dir():
        return out
    for f in root.iterdir():
        if not f.is_file() or f.suffix != ".md" or f.name.startswith("_archive_"):
            continue
        try:
            fm = _fm(f.read_text(encoding="utf-8"))
        except OSError:
            continue
        if fm.get("rrule") or fm.get("type", "").lower() == "rrule":
            continue
        d = fm.get("date") or ""
        if not d:
            m = re.match(r"^(\d{4}-\d{2}-\d{2})", f.name)
            d = m.group(1) if m else ""
        out.append({"title": fm.get("title") or f.stem, "date": d,
                    "path": str(f.relative_to(vault)).replace("\\", "/"),
                    "completed": fm.get("completed", "").lower() not in ("", "false", "null", "no")})
    return out


def _event_items(vault, events):
    """events: serve.scan_events() rows (already cached there) or None to read the
    deadlines folder here. Only the deadlines category counts as a commitment."""
    if events is None:
        events = _read_deadline_events(vault)
    else:
        events = [e for e in events if e.get("category") == "deadlines"]
    out = []
    for e in events:
        d = str(e.get("date") or "")
        days = _days(d) if _ISO.match(d) else None
        if days is None or days < 0 or e.get("completed"):
            continue
        out.append({"id": "event:%s:%s" % (e.get("path") or "", d),
                    "title": str(e.get("title") or ""), "date": d, "days": days,
                    "source": "event", "project": None, "editable": False,
                    "done": False, "note": ""})
    return out


def _plan_dir():
    try:
        import projectplan
        return projectplan.PLANS_DIR
    except Exception:
        import settings
        return settings.STATE_DIR / "project-plans"


def _plan_items(plans_dir=None):
    """Hard milestones (and the hard deadline) of FINALIZED plans only. A proposed
    plan is an agent's suggestion, not a commitment."""
    d = Path(plans_dir) if plans_dir else _plan_dir()
    out = []
    if not d.is_dir():
        return out
    for f in sorted(d.glob("*.json")):
        try:
            p = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not isinstance(p, dict) or p.get("status") != "finalized":
            continue
        slug = str(p.get("slug") or f.stem)
        m = re.search(r"Projects/papers/(" + settings.LIVE_PROJECT_RE + r")/", str(p.get("boardPath") or ""))
        project = "paper:%s" % settings.strip_prefix(m.group(1)) if m else None
        rows = [dict(x, _mid=x.get("id")) for x in (p.get("milestones") or [])
                if isinstance(x, dict) and x.get("hard")]
        hd = p.get("hardDeadline")
        if isinstance(hd, dict) and hd.get("date"):
            rows.append({"title": hd.get("title") or p.get("title") or slug,
                         "date": hd.get("date"), "_mid": "deadline"})
        for x in rows:
            if str(x.get("status") or "open") == "done":
                continue
            dd = str(x.get("date") or "")
            days = _days(dd) if _ISO.match(dd) else None
            if days is None or days < 0:
                continue
            out.append({"id": "plan:%s:%s" % (slug, x.get("_mid") or ""),
                        "title": str(x.get("title") or ""), "date": dd, "days": days,
                        "source": "plan", "project": project, "editable": False,
                        "done": False, "note": ""})
    return out


# ------------------------------------------------------------------ readers
def commitments(vault, include_done=False, events=None, plans_dir=None):
    data = _load(vault)
    items = (_ledger_items(data, include_done)
             + _event_items(vault, events) + _plan_items(plans_dir))
    seen, out = set(), []
    for it in items:
        k = (it["date"], it["title"].strip().casefold())
        if k in seen:
            continue
        seen.add(k)
        out.append(it)
    out.sort(key=lambda it: (it["date"], it["title"].casefold()))
    return out


CAL_CATEGORY = "commitments"
CAL_COLOR = "#be123c"


def calendar_events(vault, with_plans=False, events=None, plans_dir=None):
    ledger = _ledger_items(_load(vault), include_done=False)
    items = list(ledger)
    if with_plans:
        seen = {(str(e.get("date") or ""), str(e.get("title") or "").strip().casefold())
                for e in (events or [])}
        seen |= {(it["date"], it["title"].strip().casefold()) for it in ledger}
        for it in _plan_items(plans_dir):
            k = (it["date"], it["title"].strip().casefold())
            if k not in seen:
                seen.add(k)
                items.append(it)
    out = []
    for it in items:
        out.append({
            "title": it["title"], "date": it["date"], "endDate": None,
            "startTime": None, "endTime": None, "allDay": True,
            "category": CAL_CATEGORY, "color": CAL_COLOR,
            "path": "commitment:%s" % it["id"], "recurring": False, "completed": False,
            "mode": None, "link": None, "opportunity": None,
            "tags": ["commitment"], "project": it["project"],
            "source": "commitment", "readOnly": True, "id": it["id"],
            "origin": it["source"],
            "note": it["note"], "days": it["days"],
        })
    return out


def countdown(vault, events=None, plans_dir=None):
    for it in commitments(vault, events=events, plans_dir=plans_dir):
        if it["days"] >= 0 and not it["done"]:
            return {"title": it["title"], "date": it["date"], "days": it["days"],
                    "project": it["project"]}
    return {}


def _this_focus(data):
    f = data["focus"]
    if f.get("week") != iso_week():
        return []
    return [k for k in (f.get("keys") or []) if isinstance(k, str)][:FOCUS_MAX]


def pipeline(vault, lists=None, events=None, plans_dir=None):
    if lists is None:
        lists = {}
        for name, fn in (("papers", drafting.list_papers), ("grants", drafting.list_grants)):
            try:
                lists[name] = fn(vault)
            except Exception:
                lists[name] = []
    statuses = drafting._load_statuses()
    data = _load(vault)
    focus = set(_this_focus(data))
    nxt = data["next"]
    # soonest open linked commitment per key (a "paper:<slug>" link covers every doc)
    linked = [c for c in commitments(vault, events=events, plans_dir=plans_dir)
              if c.get("project") and not c["done"]]
    now_ms = datetime.now().timestamp() * 1000   # library mtimes are epoch ms (drafting._mt)
    out = []
    for src in ("papers", "grants"):
        for e in lists.get(src) or []:
            if e.get("kind") == "project":
                continue
            key = "paper:%s:%s" % (e.get("slug"), e.get("doc"))
            kind = e.get("kind") or ("grant" if src == "grants" else "paper")
            mtime = e.get("paperMtime") or 0
            stage = statuses.get(key, "draft")
            if stage not in drafting.STATUSES:
                stage = "draft"
            com = next((c for c in linked
                        if c["project"] == key or key.startswith(c["project"] + ":")), None)
            out.append({
                "key": key, "title": e.get("title") or key, "kind": kind,
                "stage": stage, "next": nxt.get(key) or "",
                "commitment": com, "mtime": mtime,
                "stale": stage in ("idea", "draft") and bool(mtime)
                         and now_ms - mtime > STALE_DAYS * 86400 * 1000,
                "focus": key in focus,
            })
    return out


# ------------------------------------------------------------------ writers
def save_commitment(vault, body):
    """Add (no id) or update (id) one ledger row. -> {ok, commitment} or {error}."""
    if not isinstance(body, dict):
        return {"error": "bad body"}
    cid = body.get("id")
    fields = {}
    if "title" in body:
        t = _clean_text(body.get("title"), TITLE_MAX)
        if not t:
            return {"error": "title required, at most %d characters" % TITLE_MAX}
        fields["title"] = t
    if "date" in body:
        if not _valid_date(body.get("date")):
            return {"error": "date must be YYYY-MM-DD"}
        fields["date"] = body["date"]
    if "project" in body:
        p = body.get("project")
        if p in (None, ""):
            fields["project"] = None
        elif valid_key(p):
            fields["project"] = p
        else:
            return {"error": "project must be a library key like paper:<slug>:<doc>"}
    if "note" in body:
        n = _clean_text(body.get("note") if body.get("note") is not None else "", NOTE_MAX)
        if n is None:
            return {"error": "note at most %d characters" % NOTE_MAX}
        fields["note"] = n
    if "done" in body:
        if not isinstance(body.get("done"), bool):
            return {"error": "done must be true or false"}
        fields["done"] = body["done"]
    with _LOCK:
        data = _load(vault)
        if cid in (None, ""):
            if "title" not in fields or "date" not in fields:
                return {"error": "title and date required"}
            row = {"id": "c-" + uuid.uuid4().hex[:10], "title": fields["title"],
                   "date": fields["date"], "project": fields.get("project"),
                   "note": fields.get("note", ""), "done": fields.get("done", False),
                   "added": _today().isoformat()}
            data["commitments"].append(row)
        else:
            row = next((r for r in data["commitments"] if r.get("id") == cid), None)
            if row is None:
                return {"error": "no such commitment"}
            row.update(fields)
        _save(vault, data)
    return {"ok": True, "commitment": row}


def archive_commitment(vault, cid):
    if not isinstance(cid, str) or not cid:
        return {"error": "id required"}
    with _LOCK:
        data = _load(vault)
        row = next((r for r in data["commitments"] if r.get("id") == cid), None)
        if row is None:
            return {"error": "no such commitment"}
        data["commitments"] = [r for r in data["commitments"] if r is not row]
        data["archived"].append(dict(row, archived=_today().isoformat()))
        _save(vault, data)
    return {"ok": True, "id": cid}


def set_next(vault, key, text):
    if not valid_key(key):
        return {"error": "bad key"}
    t = _clean_text(text if text is not None else "", NEXT_MAX)
    if t is None:
        return {"error": "next step at most %d characters" % NEXT_MAX}
    with _LOCK:
        data = _load(vault)
        if t:
            data["next"][key] = t
        else:
            data["next"].pop(key, None)
        _save(vault, data)
    return {"ok": True, "key": key, "next": t}


def set_focus(vault, keys):
    if not isinstance(keys, list) or not all(valid_key(k) for k in keys):
        return {"error": "keys must be a list of library keys"}
    keys = list(dict.fromkeys(keys))
    if len(keys) > FOCUS_MAX:
        return {"error": "at most %d focus items" % FOCUS_MAX}
    with _LOCK:
        data = _load(vault)
        data["focus"] = {"week": iso_week(), "keys": keys}
        _save(vault, data)
    return {"ok": True, "week": iso_week(), "keys": keys}
