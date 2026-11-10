#!/usr/bin/env python3
"""Project plan PROPOSE -> APPROVE -> COMMIT (the daily/weekly spine, for a BIG project)."""
import settings
import os
import re
import json
from pathlib import Path
from datetime import date, datetime, timedelta

import kanban

HERE = settings.STATE_DIR
VAULT = settings.VAULT
PLAN_FILE = HERE / "project-plan.json"
PLANS_DIR = HERE / "project-plans"
ARCHIVE_FILE = HERE / "project-plan-archive.json"

GOALS_FILE = VAULT / settings.GOALS_REL
DEADLINES_DIR = VAULT / "Preparation" / "Calendar" / "events" / "deadlines"
TASKS_BOARD = VAULT / settings.TASKS_BOARD_REL

PRIORITY_TAGS = {"high": "@high", "medium": "@medium", "low": "@low"}
_ISO = re.compile(r"^\d{4}-\d{2}-\d{2}$")


# ------------------------------------------------------------------ io
def _atomic_write(path, text):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def _plan_path(slug):
    return PLANS_DIR / f"{_slugify(slug)}.json"


def _migrate_legacy():
    """Copy the legacy singleton once. Never delete or rewrite the audit source."""
    if not PLAN_FILE.exists():
        return
    try:
        p = json.loads(PLAN_FILE.read_text(encoding="utf-8"))
    except Exception:
        return
    if not isinstance(p, dict) or not p:
        return
    slug = _slugify(p.get("slug") or p.get("title") or "project")
    dest = _plan_path(slug)
    if not dest.exists():
        PLANS_DIR.mkdir(parents=True, exist_ok=True)
        _atomic_write(dest, json.dumps(p, ensure_ascii=False, indent=1))


def list_plans(statuses=None):
    _migrate_legacy()
    allowed = set(statuses or [])
    out = []
    if PLANS_DIR.exists():
        for f in sorted(PLANS_DIR.glob("*.json")):
            try: p = json.loads(f.read_text(encoding="utf-8"))
            except Exception: continue
            if isinstance(p, dict) and (not allowed or p.get("status") in allowed): out.append(_healed(p))
    return out


def _resolve_slug(slug=None, statuses=None):
    if slug:
        return _slugify(slug)
    plans = list_plans(statuses)
    if len(plans) == 1:
        return plans[0].get("slug")
    if not plans:
        return None
    raise ValueError("multiple project plans match; specify slug: " + ", ".join(p.get("slug", "") for p in plans))


def _newest(statuses=None):
    """The most recently generated/edited plan among `statuses`, or None. What a slug-less
    READ falls back to when several plans match -- a read never raises for ambiguity."""
    plans = list_plans(statuses)
    if not plans:
        return None
    key = lambda p: str(p.get("editedAt") or p.get("generated") or "")
    return max(plans, key=key)


def _load(slug=None, statuses=None):
    slug = _resolve_slug(slug, statuses)
    if not slug: return None
    try: return json.loads(_plan_path(slug).read_text(encoding="utf-8"))
    except Exception: return None


def _write(p):
    slug = _slugify(p.get("slug") or p.get("title") or "project")
    p["slug"] = slug
    PLANS_DIR.mkdir(parents=True, exist_ok=True)
    _atomic_write(_plan_path(slug), json.dumps(p, ensure_ascii=False, indent=1))


def _today():
    return date.today()


def _d(s):
    return datetime.strptime(s, "%Y-%m-%d").date()


def _skip_weekend_back(d):
    while d.weekday() >= 5:
        d -= timedelta(days=1)
    return d


# ------------------------------------------------------------------ scheduling
def schedule(plan):
    p = json.loads(json.dumps(plan))   # deep copy
    today = _today()
    ms = p.get("milestones", [])
    by_id = {m["id"]: m for m in ms}
    alerts = []

    hard = p.get("hardDeadline") or {}
    hard_date = _d(hard["date"]) if hard.get("date") and _ISO.match(hard["date"]) else None

    # successors map: id -> [milestones that depend on it]
    succ = {m["id"]: [] for m in ms}
    for m in ms:
        for dep in m.get("dependsOn", []):
            if dep in succ:
                succ[dep].append(m["id"])

    # resolve dates in reverse-dependency order (repeat to a fixed point; chains are short)
    for _ in range(len(ms) + 1):
        for m in ms:
            if m.get("hard") and m.get("date") and _ISO.match(m["date"]):
                continue  # hard anchor: immovable, agent-provided
            if m.get("date") and _ISO.match(m.get("date", "")):
                continue  # already resolved this pass
            lead = int(m.get("lead", 5) or 5)
            succ_dates = [_d(by_id[s]["date"]) for s in succ.get(m["id"], [])
                          if by_id.get(s, {}).get("date") and _ISO.match(by_id[s].get("date", ""))]
            anchor = min(succ_dates) if succ_dates else hard_date
            if anchor is None:
                continue
            d = _skip_weekend_back(anchor - timedelta(days=lead))
            m["date"] = d.isoformat()

    # validate: dependency ordering, not-in-past, hard spacing
    for m in ms:
        if not (m.get("date") and _ISO.match(m.get("date", ""))):
            alerts.append(f"Milestone '{m.get('title', m['id'])}' could not be dated (missing lead/anchor).")
            continue
        md = _d(m["date"])
        if md < today:
            alerts.append(f"Milestone '{m.get('title', m['id'])}' lands in the past ({m['date']}) — the chain is compressed.")
        for dep in m.get("dependsOn", []):
            dm = by_id.get(dep)
            if dm and dm.get("date") and _ISO.match(dm["date"]) and _d(dm["date"]) >= md:
                alerts.append(f"'{m.get('title')}' ({m['date']}) is not after its dependency '{dm.get('title')}' ({dm['date']}).")

    # sub-task due dates: milestone date - offset working-ish days, clamped >= today
    for t in p.get("tasks", []):
        if t.get("due") and _ISO.match(t.get("due", "")):
            base = t["due"]
        else:
            m = by_id.get(t.get("milestone"))
            if not (m and m.get("date") and _ISO.match(m.get("date", ""))):
                continue
            off = int(t.get("offset", 0) or 0)
            base = _skip_weekend_back(_d(m["date"]) - timedelta(days=off)).isoformat()
        bd = _d(base)
        if bd < today:
            bd = today
            alerts.append(f"Task '{t.get('text','')[:40]}' pulled to today — its milestone window is tight.")
        t["due"] = bd.isoformat()

    p["alerts"] = sorted(set(alerts))
    return p


_PROSE_KEYS = ("note", "notes", "description")
_NOTE_ALERT = ("Milestone notes were dropped. Project detail belongs in the project "
               "README and logs, not on the calendar.")
_WORD_CAP = {"milestone": 6, "task": 10}
_DASH_SUB = re.compile(r"\s[-—–]\s")
_JUSTIFY = (
    (re.compile(r",\s*so\b", re.I), ", so"),
    (re.compile(r"\bso that\b", re.I), "so that"),
    (re.compile(r"\bin order to\b", re.I), "in order to"),
    (re.compile(r"\bbecause\b", re.I), "because"),
    (re.compile(r"\bgiven that\b", re.I), "given that"),
    (re.compile(r"\bgiven\s+(?:\d|\S+\s+\S+)", re.I), "given"),
)
_JARGON = (
    (re.compile(r"\bstage\s*\d+\b", re.I), "stage 1/stage 2"),
    (re.compile(r"\bgates?\b", re.I), "gate"),
    (re.compile(r"\bphases?\b", re.I), "phase"),
    (re.compile(r"\b(?:passes|passed)\b", re.I), "passed"),
    (re.compile(r"\bpipelines?\b", re.I), "pipeline"),
    (re.compile(r"\bworkstreams?\b", re.I), "workstream"),
    (re.compile(r"\bdeliverables?\b", re.I), "deliverable"),
)
_STATS = (
    (re.compile(r"\d*\.\d+"), "a decimal"),
    (re.compile(r"%"), "a percent sign"),
    (re.compile(r"\bpercent\b", re.I), "the word \"percent\""),
    (re.compile(r"\b\d+\s+of\s+\d+\b", re.I), "an N of M count"),
)


def _plainness(title, *, kind="milestone"):
    """Human-readable complaints about one title, or [] if it reads plainly. `kind`
    is "milestone" or "task" (the task cards carry a little more room)."""
    t = re.sub(r"\s+", " ", (title or "")).strip()
    if not t:
        return []
    cap = _WORD_CAP.get(kind, 10)
    out = []
    words = t.split(" ")
    if len(words) > cap:
        out.append(f'"{t}": {len(words)} words — a {kind} title is at most {cap}.')
    if ":" in t or ";" in t:
        out.append(f'"{t}": drop the colon/semicolon — one phrase, not a headline plus a gloss.')
    if _DASH_SUB.search(t):
        out.append(f'"{t}": drop the dash subtitle — one phrase, not a headline plus a gloss.')
    for rx, label in _JUSTIFY:
        if rx.search(t):
            out.append(f'"{t}": drop the "{label}" justification — the why belongs in the '
                       f"project README and logs.")
            break
    jargon = sorted({label for rx, label in _JARGON if rx.search(t)})
    if jargon:
        out.append(f'"{t}": pipeline jargon ({", ".join(jargon)}) — name the work, not the machinery.')
    stats = sorted({label for rx, label in _STATS if rx.search(t)})
    if stats:
        out.append(f'"{t}": no statistics or counts in a title ({", ".join(stats)}) — '
                   f"they belong in the project README and logs.")
    return out


def _plan_plainness(p):
    """Every plainness complaint across a plan's milestone and task titles."""
    out = []
    for m in p.get("milestones") or []:
        out.extend(_plainness(m.get("title"), kind="milestone"))
    for t in p.get("tasks") or []:
        out.extend(_plainness(t.get("text"), kind="task"))
    return out


def _carries_prose(intent):
    """True if any milestone or task arrived with a note/notes/description attached."""
    items = list(intent.get("milestones") or []) + list(intent.get("tasks") or [])
    return any(isinstance(i, dict) and any((i.get(k) or "") for k in _PROSE_KEYS) for i in items)


# ------------------------------------------------------------------ stage / read
def stage(intent, slug=None):
    raw = dict(intent or {})
    dropped = _carries_prose(raw)
    raw["milestones"] = _clean_milestones(raw.get("milestones"))
    raw["tasks"] = _clean_tasks(raw.get("tasks"))

    bad = _plan_plainness(raw)
    if bad:
        raise ValueError("these titles are not plain enough to put on the calendar — "
                         "rewrite them short and ordered, keep the reasoning in the "
                         "project README and logs, then re-stage:\n- " + "\n- ".join(bad))

    p = schedule(raw)
    p["status"] = "proposed"
    p["slug"] = _slugify(slug or p.get("slug") or p.get("title", "project"))
    p.setdefault("tag", p["slug"])
    p["generated"] = datetime.now().isoformat(timespec="minutes")
    if dropped:                               # one alert for the plan, not one per milestone
        p["alerts"] = sorted(set(p.get("alerts") or []) | {_NOTE_ALERT})
    _write(p)
    return {"ok": True, "status": "proposed", "slug": p["slug"],
            "milestones": len(p.get("milestones", [])), "tasks": len(p.get("tasks", [])),
            "alerts": p.get("alerts", [])}


def _slugify(s):
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", (s or "").lower())).strip("-") or "project"


# A milestone id becomes part of a file name, so it is one plain token: letters,
# digits, "_" and "-". Anything else is slugified, the same way everywhere it is
# referenced (dependsOn, a task's milestone), so references stay consistent.
_ID_OK = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,79}")


def _safe_id(mid):
    mid = mid.strip() if isinstance(mid, str) else ""
    if not mid:
        return ""
    return mid if _ID_OK.fullmatch(mid) else _slugify(mid)[:80].strip("-") or "m"


def read_proposal(slug=None):
    """The pending proposal for the dashboard card, or {'status':'none'}. Pending only
    while status=='proposed'. Milestones carry computed dates; tasks group under them."""
    try:
        p = _load(slug, ("proposed",))
    except ValueError:                        # several pending and no slug: the newest,
        p = _newest(("proposed",))            # never an error (the Calendar passes a slug)
    if not p or p.get("status") != "proposed":
        return {"status": "none"}
    out = {
        "status": "proposed",
        "slug": p.get("slug"), "title": p.get("title"), "tag": p.get("tag"),
        "generated": p.get("generated"), "boardPath": p.get("boardPath"),
        "source": p.get("source") or "agent", "editedAt": p.get("editedAt"),
        "hardDeadline": p.get("hardDeadline") or {},
        "milestones": _clean_milestones(p.get("milestones")),
        "tasks": _clean_tasks(p.get("tasks")),
        "alerts": p.get("alerts") or [],
    }
    if not slug:                              # a slug-less caller learns what else waits
        out["pending"] = [q.get("slug") for q in list_plans(("proposed",))]
    return out


def get_plan(slug=None):
    """One durable chain. With no slug and several plans on disk it returns
    {"status":"none","slugs":[...]} instead of raising -- the reader has to pick. Healed
    on the way out like read_proposal, and like it, without rewriting the file."""
    try:
        p = _load(slug)
    except ValueError:
        return {"status": "none", "slugs": [q.get("slug") for q in list_plans()]}
    return _healed(p) if p else {"status": "none"}


def _clean_milestone(m, i):
    # note/notes/description are NOT schema: the calendar carries the milestone name
    # and nothing else, so prose is dropped here and stage() says so once in alerts.
    mid = _safe_id(m.get("id")) or _safe_id(_slugify(m.get("title") or f"m{i + 1}"))
    out = {
        "id": mid,
        "title": " ".join(str(m.get("title") or "").split()) or mid,
        "date": (m.get("date") or "").strip() or None,
        "hard": bool(m.get("hard")),
        "dependsOn": [d for d in (_safe_id(x) for x in (m.get("dependsOn") or [])) if d],
        "goal": m.get("goal", True) is not False,
        "calendar": m.get("calendar", True) is not False,
        "status": m.get("status") or "open",
    }
    if m.get("lead") not in (None, ""):
        try:
            out["lead"] = int(m["lead"])
        except (TypeError, ValueError):
            pass
    if out["date"] and not _ISO.match(out["date"]):
        out["date"] = None
    return out


def _clean_est(est):
    """A bare number means MINUTES -- store it as "30m". kanban._parse_est reads a
    unitless @est(30) as 30 HOURS, so an int that reached a card unlabelled turned a
    half-hour task into a four-day one. "90m"/"2h"/"1.5h" pass through untouched."""
    if est is None or isinstance(est, bool):
        return None
    if isinstance(est, (int, float)):
        n = float(est)
    else:
        s = str(est).strip()
        if not s:
            return None
        if not re.fullmatch(r"\d+(?:\.\d+)?", s):
            return s                          # already carries a unit
        n = float(s)
    if n <= 0:
        return None
    return f"{int(n) if n == int(n) else round(n, 2)}m"


def _clean_task(t):
    text = " ".join(str(t.get("text") or t.get("title") or "").split())
    if not text:
        return None
    out = {"text": text, "milestone": _safe_id(t.get("milestone")) or None}
    due = (t.get("due") or "").strip()
    out["due"] = due if _ISO.match(due) else None
    if t.get("offset") not in (None, ""):     # the scheduler's backward window
        try:
            out["offset"] = int(t["offset"])
        except (TypeError, ValueError):
            pass
    pr = (t.get("priority") or "").strip().lower()
    if pr in PRIORITY_TAGS:
        out["priority"] = pr
    est = _clean_est(t.get("est"))
    if est:
        out["est"] = est
    return out


def _clean_milestones(milestones):
    return [_clean_milestone(m, i) for i, m in enumerate(milestones or [])]


def _clean_tasks(tasks):
    return [t for t in (_clean_task(t) for t in (tasks or [])) if t]


def _healed(p):
    if not isinstance(p, dict):
        return p
    out = dict(p)
    out["milestones"] = _clean_milestones(p.get("milestones"))
    out["tasks"] = _clean_tasks(p.get("tasks"))
    return out


def save(patch, slug=None):
    p = _load(slug or (patch or {}).get("slug"), ("proposed",))
    if not p or p.get("status") != "proposed":
        raise ValueError("no pending project plan to save")
    patch = dict(patch or {})

    for key in ("title", "tag", "boardPath"):
        if key in patch:
            p[key] = (patch.get(key) or "").strip()
    if "hardDeadline" in patch:
        hd = patch.get("hardDeadline") or {}
        d = (hd.get("date") or "").strip()
        p["hardDeadline"] = {"date": d if _ISO.match(d) else None,
                             "title": (hd.get("title") or "").strip()}
    if "milestones" in patch:
        p["milestones"] = _clean_milestones(patch.get("milestones"))
    if "tasks" in patch:
        ids = {m["id"] for m in p.get("milestones") or []}
        tasks = _clean_tasks(patch.get("tasks"))
        for t in tasks:                      # a task pointing at a deleted milestone
            if t["milestone"] not in ids:    # becomes loose rather than vanishing
                t["milestone"] = None
        p["tasks"] = tasks
    if not (p.get("title") or "").strip():
        raise ValueError("the plan needs a title")

    p["status"] = "proposed"
    p["editedAt"] = datetime.now().isoformat(timespec="minutes")
    p["alerts"] = _edit_alerts(p)
    _write(p)
    return read_proposal(p.get("slug"))


def _edit_alerts(p):
    out = []
    ms = {m["id"]: m for m in p.get("milestones") or []}
    final = (p.get("hardDeadline") or {}).get("date")
    for m in p.get("milestones") or []:
        if not m.get("date"):
            out.append(f"{m['title']}: no date set.")
        elif final and m["date"] > final:
            out.append(f"{m['title']} ({m['date']}) falls after the deadline {final}.")
        for dep in m.get("dependsOn") or []:
            if dep not in ms:
                out.append(f"{m['title']} depends on \"{dep}\", which is not a milestone.")
            elif ms[dep].get("date") and m.get("date") and ms[dep]["date"] > m["date"]:
                out.append(f"{m['title']} ({m['date']}) is due before {ms[dep]['title']} "
                           f"({ms[dep]['date']}), which it depends on.")
    for t in p.get("tasks") or []:
        m = ms.get(t.get("milestone") or "")
        if t.get("due") and m and m.get("date") and t["due"] > m["date"]:
            out.append(f"\"{t['text'][:48]}\" is due after its milestone {m['title']}.")
    out.extend(_plan_plainness(p))
    return out


def create(intent):
    """Start a plan from scratch IN THE APP -- no agent anywhere in the loop."""
    intent = dict(intent or {})
    title = (intent.get("title") or "").strip()
    if not title:
        raise ValueError("the plan needs a title")
    slug = _slugify(intent.get("slug") or title)
    hd = intent.get("hardDeadline") or {}
    d = (hd.get("date") or "").strip()
    p = {
        "status": "proposed",
        "slug": slug,
        "title": title,
        "tag": (intent.get("tag") or slug).strip().lstrip("#"),
        "boardPath": (intent.get("boardPath") or "").strip(),
        "generated": datetime.now().isoformat(timespec="minutes"),
        "source": "manual",
        "hardDeadline": {"date": d if _ISO.match(d) else None,
                         "title": (hd.get("title") or "").strip() or f"{title} due"},
        "milestones": _clean_milestones(intent.get("milestones")),
        "tasks": _clean_tasks(intent.get("tasks")),
        "alerts": [],
    }
    p["alerts"] = _edit_alerts(p)
    _write(p)
    return read_proposal(slug)


def _mark(status, slug=None):
    p = _load(slug)
    if not p:
        return
    p["status"] = status
    p[status + "At"] = datetime.now().isoformat(timespec="minutes")
    _write(p)


def dismiss(slug=None):
    p = _load(slug, ("proposed",))
    if not p or p.get("status") != "proposed":
        return {"ok": False, "status": "none"}
    _mark("dismissed", p.get("slug"))
    return {"ok": True, "status": "dismissed"}


def _archive_append(p):
    """Append a plan snapshot to project-plan-archive.json (a list, oldest first),
    deduped by (slug, finalizedAt) so re-archiving never doubles an entry."""
    try:
        arch = json.loads(ARCHIVE_FILE.read_text(encoding="utf-8"))
        if not isinstance(arch, list):
            arch = []
    except Exception:
        arch = []
    key = (p.get("slug"), p.get("finalizedAt"))
    arch = [a for a in arch if (a.get("slug"), a.get("finalizedAt")) != key]
    arch.append(p)
    _atomic_write(ARCHIVE_FILE, json.dumps(arch, ensure_ascii=False, indent=1))


def archive(slug=None):
    p = _load(slug, ("finalized",))
    if not p or p.get("status") != "finalized":
        return {"ok": False, "error": "no finalized plan to archive"}
    p["status"] = "archived"
    p["archivedAt"] = datetime.now().isoformat(timespec="minutes")
    _archive_append(p)
    _write(p)
    return {"ok": True, "status": "archived", "slug": p.get("slug")}


def history():
    """Every finalized chain, live or retired: the archive list plus the live file
    when it is finalized/archived, deduped by (slug, finalizedAt)."""
    items = []
    try:
        arch = json.loads(ARCHIVE_FILE.read_text(encoding="utf-8"))
        if isinstance(arch, list):
            items.extend(arch)
    except Exception:
        pass
    items.extend(list_plans(("finalized", "archived")))
    seen, out = set(), []
    for p in items:
        key = (p.get("slug"), p.get("finalizedAt"))
        if key in seen:
            continue
        seen.add(key)
        out.append(_healed(p))       # the archive file is read raw; heal it on the way out
    return out


def _goal_marker(slug, mid):
    return f"#m:{slug}-{mid}"


def write_goals(milestones, slug):
    goal_ms = [m for m in milestones if m.get("goal") and m.get("date") and _ISO.match(m.get("date", ""))]
    text = GOALS_FILE.read_text(encoding="utf-8") if GOALS_FILE.exists() else "# Goals\n\n"
    lines = text.split("\n")
    # find the '## Done' cut (active goals go above it); else end of file
    cut = next((i for i, l in enumerate(lines) if l.strip().lower() == "## done"), len(lines))

    desired = {}
    for m in goal_ms:
        tag = ("#" + slug.split("-")[0]) if slug else ""
        marker = _goal_marker(slug, m["id"])
        line = f"- [ ] {m['date']} — {m['title']}" + (f" {tag}" if tag else "") + f" {marker}"
        desired[marker] = line

    out, seen = [], set()
    for i, l in enumerate(lines):
        mk = next((mk for mk in desired if mk in l), None)
        managed = re.search(r"#m:" + re.escape(slug) + r"-", l)
        if i < cut and mk:                       # update an existing managed line in place
            out.append(desired[mk]); seen.add(mk)
        elif i < cut and managed:                # a managed line whose milestone is gone -> drop
            continue
        else:
            out.append(l)
    # append any new managed lines just before the cut (recompute cut over `out`)
    new = [desired[mk] for mk in desired if mk not in seen]
    if new:
        cut2 = next((i for i, l in enumerate(out) if l.strip().lower() == "## done"), len(out))
        # ensure a blank line context
        out = out[:cut2] + new + out[cut2:]
    new_text = "\n".join(out)
    if GOALS_FILE.exists():
        try:
            (HERE / "goals-last.bak.md").write_text(text, encoding="utf-8")
        except OSError:
            pass
    GOALS_FILE.parent.mkdir(parents=True, exist_ok=True)
    _atomic_write(GOALS_FILE, new_text)
    return len(desired)


# ------------------------------------------------------------------ calendar (id-keyed)
def _deadline_path(slug, mid):
    """The deadline file for one milestone; refuses anything but plain tokens."""
    if not (_ID_OK.fullmatch(str(slug)) and _ID_OK.fullmatch(str(mid))):
        raise ValueError("invalid plan slug or milestone id")
    path = DEADLINES_DIR / f"{slug}-{mid}.md"
    if path.resolve().parent != DEADLINES_DIR.resolve():
        raise ValueError("invalid plan slug or milestone id")
    return path


def write_deadlines(milestones, slug):
    if not _ID_OK.fullmatch(str(slug)):
        raise ValueError("invalid plan slug")
    cal_ms = {m["id"]: m for m in milestones if m.get("calendar") and m.get("date") and _ISO.match(m.get("date", ""))}
    paths = {mid: _deadline_path(slug, mid) for mid in cal_ms}   # validate all before writing any
    DEADLINES_DIR.mkdir(parents=True, exist_ok=True)
    source = f"**Source:** project plan ({slug})."
    live = []
    # write/overwrite
    for mid, m in cal_ms.items():
        path = paths[mid]
        title = m["title"].replace('"', "'")
        content = (
            "---\n"
            f'title: "{title}"\n'
            f"date: {m['date']}\n"
            "allDay: true\n"
            "calendarType: deadline\n"
            "tags:\n  - calendar\n  - deadline\n"
            f"  - {slug}\n"
            "---\n\n"
            f"{source} Milestone for the project's deadline chain.\n"
        )
        _atomic_write(path, content)
        live.append(str(path.relative_to(VAULT)).replace("\\", "/"))
    # delete deadline files this plan wrote whose milestone is gone
    keep = {p.name for p in paths.values()}
    for f in DEADLINES_DIR.iterdir():
        if not (f.is_file() and not f.is_symlink() and f.suffix == ".md"
                and f.name.startswith(slug + "-") and f.name not in keep):
            continue
        try:
            if source not in f.read_text(encoding="utf-8"):
                continue                      # another plan's file, or not ours at all
            f.unlink()
        except OSError:
            pass
    return live


# ------------------------------------------------------------------ board tasks
def _card_line(t, tag):
    parts = [(t.get("text") or "").strip()]
    if t.get("due") and _ISO.match(t.get("due", "")):
        parts.append(f"@due({t['due']})")
    pr = PRIORITY_TAGS.get((t.get("priority") or "").lower())
    if pr:
        parts.append(pr)
    if t.get("est"):
        parts.append(f"@est({t['est']})")
    if tag:
        parts.append("#" + tag)
    if t.get("milestone"):
        parts.append(f"#m:{t['milestone']}")
    return " ".join(x for x in parts if x).strip()


def _norm(s):
    """Tag/date-insensitive key for a card or task text: drop @tokens and #tags,
    collapse whitespace, lowercase. So dedup matches whether or not a card carries
    @due/#tag decoration (the bug that double-added a sub-task otherwise)."""
    return re.sub(r"\s+", " ", re.sub(r"(@\S+|#\S+)", "", s or "")).strip().lower()


def _all_card_texts(board_text):
    out = set()
    for ln in board_text.split("\n"):
        m = re.match(r"^\s*-\s*\[[ xX]\]\s*(.+)$", ln)
        if m:
            k = _norm(m.group(1))
            if k:
                out.add(k)
    return out


def commit_tasks(tasks, tag, board_file=None, lane="TODAY"):
    board_file = board_file or TASKS_BOARD
    try:
        board_text = board_file.read_text(encoding="utf-8")
    except OSError:
        return 0
    added = 0
    seen = _all_card_texts(board_text)
    for t in tasks or []:
        key = _norm(t.get("text"))
        body = _card_line(t, tag)
        if not body or not key or key in seen:
            continue
        nxt = kanban.add_card(board_text, lane, body)
        if nxt is not None:
            board_text = nxt
            seen.add(key)
            added += 1
    if added:
        try:
            (HERE / "tasks-last.bak.md").write_text(board_file.read_text(encoding="utf-8"), encoding="utf-8")
        except OSError:
            pass
        _atomic_write(board_file, board_text)
    return added


def _project_board(rel):
    rel = (rel or "").replace("\\", "/").strip()
    if not rel.endswith("PATH.md") or "Projects/papers/" not in rel:
        return None
    p = (VAULT / rel).resolve()
    try:
        p.relative_to((VAULT / "Projects" / "papers").resolve())
    except ValueError:
        return None
    return p if p.exists() else None


# ------------------------------------------------------------------ finalize
def finalize(override=None, slug=None):
    p = _load(slug or (override or {}).get("slug"), ("proposed",))
    if not p or p.get("status") != "proposed":
        raise ValueError("no pending project proposal to finalize")
    override = override or {}
    slug = _slugify(p.get("slug") or "project")
    tag = re.sub(r"[^A-Za-z0-9\-_/]", "", str(p.get("tag") or "")) or slug.split("-")[0]
    milestones = _clean_milestones(override.get("milestones", p.get("milestones") or []))
    tasks = _clean_tasks(override["tasks"] if "tasks" in override else (p.get("tasks") or []))

    goals_n = write_goals(milestones, slug)
    cal = write_deadlines(milestones, slug)

    cards = commit_tasks(tasks, tag)
    board_rel = settings.TASKS_BOARD_REL

    # the durable record goes to disk on-schema too (an override still only steers the
    # fan-out, as before -- it is not adopted into the stored chain)
    p["milestones"] = _clean_milestones(p.get("milestones"))
    p["tasks"] = _clean_tasks(p.get("tasks"))
    p["status"] = "finalized"
    p["finalizedAt"] = datetime.now().isoformat(timespec="minutes")
    p["lastFinalize"] = {"goals": goals_n, "calendar": cal, "cards": cards, "board": board_rel}
    _write(p)
    return {"slug": slug, "goals": goals_n, "calendar": cal, "cards": cards, "board": board_rel}


# ------------------------------------------------------------------ cli
if __name__ == "__main__":
    import sys
    cmd = sys.argv[1] if len(sys.argv) > 1 else "read"
    if cmd == "stage":
        src = sys.argv[2] if len(sys.argv) > 2 else None
        raw = Path(src).read_text(encoding="utf-8") if src else sys.stdin.read()
        print(json.dumps(stage(json.loads(raw))))
    elif cmd == "schedule":
        src = sys.argv[2] if len(sys.argv) > 2 else None
        raw = Path(src).read_text(encoding="utf-8") if src else sys.stdin.read()
        print(json.dumps(schedule(json.loads(raw)), indent=1))
    elif cmd == "finalize":
        try:
            print(json.dumps(finalize()))
        except ValueError as e:
            print(json.dumps({"error": str(e)}))
    elif cmd == "dismiss":
        print(json.dumps(dismiss()))
    elif cmd == "archive":
        print(json.dumps(archive()))
    elif cmd == "history":
        print(json.dumps(history(), ensure_ascii=False, indent=1))
    elif cmd == "plan":
        print(json.dumps(get_plan(), ensure_ascii=False, indent=1))
    else:
        print(json.dumps(read_proposal(), ensure_ascii=False, indent=1))
