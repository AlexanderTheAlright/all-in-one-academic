#!/usr/bin/env python3
"""Achievement archive for the Insights view -- the reflective record."""
import settings
import json
import re
from datetime import date, datetime, timedelta
from pathlib import Path

import kanban
import drafting
import projectplan

HERE = settings.STATE_DIR
GOAL_RE = re.compile(r"^\s*-\s*\[([ xX])\]\s*(?:(\d{4}-\d{2}-\d{2})\s*[—–-]+\s*)?(.+)$")
FM_RE = re.compile(r"^---\r?\n(.*?)\r?\n---", re.S)
TAG_STRIP = re.compile(r"#[\w:/-]+")


def _clean(text):
    """Display text for a goal/task line: tags (incl. #m: markers) dropped."""
    return re.sub(r"\s+", " ", TAG_STRIP.sub("", text or "")).strip(" -—·")


def _iso(s):
    try:
        return datetime.strptime(s, "%Y-%m-%d").date()
    except (TypeError, ValueError):
        return None


# ------------------------------------------------------------------ goals
def goals(vault):
    f = vault / settings.GOALS_REL
    out = []
    try:
        text = f.read_text(encoding="utf-8")
    except OSError:
        return out
    for ln in text.split("\n"):
        m = GOAL_RE.match(ln)
        if not m:
            continue
        title = _clean(m.group(3))
        if not title:
            continue
        out.append({"done": m.group(1).lower() == "x", "date": m.group(2), "title": title})
    return out


# ------------------------------------------------------------------ board tasks
def done_tasks(vault):
    f = vault / settings.TASKS_BOARD_REL
    try:
        text = f.read_text(encoding="utf-8")
    except OSError:
        return []
    out, lane = [], None
    for ln in text.split("\n"):
        ln = ln.rstrip("\r")
        h = kanban.HEAD_RE.match(ln)
        if h:
            lane = h.group(1)
            continue
        m = kanban.CARD_RE.match(ln)
        if not m or m.group(2).lower() != "x":
            continue
        body = m.group(3)
        due = kanban.DUE_RE.search(body)
        out.append({
            "text": re.sub(r"\s+", " ", kanban.META_RE.sub("", kanban._display(body))).strip(" -—·"),
            "due": due.group(1).strip() if due else None,
            "tags": kanban.TAG_RE.findall(body),
            "est": kanban._parse_est(body),
            "lane": lane,
        })
    return out


def _week_start(d):
    return d - timedelta(days=(d.weekday() + 1) % 7)


def weekly(tasks, weeks=16):
    """Tasks completed per week (by @due date -- the day the card was scheduled
    and worked), last `weeks` weeks, Sunday-start, zero-filled."""
    today = date.today()
    start = _week_start(today) - timedelta(weeks=weeks - 1)
    buckets = {}
    for t in tasks:
        d = _iso(t.get("due"))
        if not d:
            continue
        ws = _week_start(d)
        if ws < start or ws > today:
            continue
        b = buckets.setdefault(ws.isoformat(), {"count": 0, "minutes": 0})
        b["count"] += 1
        b["minutes"] += t.get("est") or 0
    out, w = [], start
    while w <= _week_start(today):
        b = buckets.get(w.isoformat(), {"count": 0, "minutes": 0})
        out.append({"week": w.isoformat(), "count": b["count"], "minutes": b["minutes"]})
        w += timedelta(weeks=1)
    return out


# ------------------------------------------------------------------ project chains
def chains():
    """Every finalized chain (live or retired) with per-milestone done flags.
    Done follows the timeline lane's convention: past date or status=='done'."""
    today = date.today().isoformat()
    out = []
    for p in projectplan.history():
        ms = [{
            "title": m.get("title"), "date": m.get("date"),
            "done": bool(m.get("status") == "done"
                         or (m.get("date") and m["date"] < today)),
        } for m in p.get("milestones") or []]
        out.append({
            "slug": p.get("slug"), "title": p.get("title"), "status": p.get("status"),
            "finalizedAt": p.get("finalizedAt"), "archivedAt": p.get("archivedAt"),
            "milestones": ms,
            "done": bool(ms) and all(m["done"] for m in ms),
            "completedOn": max((m["date"] for m in ms if m.get("date")), default=None),
        })
    out.sort(key=lambda c: c.get("completedOn") or "", reverse=True)
    return out


# ------------------------------------------------------------------ resolved events
def resolved_events(vault):
    """Calendar events carrying a truthy completed: stamp (the /events/resolve
    convention). Light frontmatter parse; recurring files never carry the stamp."""
    root = vault / "Preparation" / "Calendar" / "events"
    out = []
    if not root.is_dir():
        return out
    for sub in sorted(root.iterdir()):
        if not sub.is_dir():
            continue
        for f in sub.glob("*.md"):
            if f.name.startswith("_archive_"):
                continue
            try:
                text = f.read_text(encoding="utf-8")
            except OSError:
                continue
            if "completed:" not in text:
                continue
            fm = FM_RE.match(text)
            if not fm:
                continue
            comp = re.search(r"^completed:\s*(\S+)", fm.group(1), re.M)
            if not comp or comp.group(1).strip("'\"").lower() in ("false", "null", ""):
                continue
            title = re.search(r"^title:\s*[\"']?(.*?)[\"']?\s*$", fm.group(1), re.M)
            dt = re.search(r"^date:\s*(\d{4}-\d{2}-\d{2})", fm.group(1), re.M)
            out.append({
                "title": title.group(1) if title else f.stem,
                "date": dt.group(1) if dt else None,
                "category": sub.name,
                "completedAt": comp.group(1).strip("'\""),
            })
    return out


# ------------------------------------------------------------------ manuscript pipeline
def pipeline(vault):
    entries = []
    for lister in (drafting.list_papers, drafting.list_grants):
        try:
            entries.extend(lister(vault))
        except Exception:
            pass
    order = {"under_review": 0, "draft": 1, "published": 2}
    out = [{
        "slug": e.get("slug"), "doc": e.get("doc"), "kind": e.get("kind"),
        "label": e.get("label"), "title": e.get("title"),
        "status": e.get("status") or "draft",
        "words": e.get("words") or 0, "mtime": e.get("paperMtime") or 0,
    } for e in entries if e.get("kind") != "project"]
    out.sort(key=lambda e: (order.get(e["status"], 1), -e["mtime"]))
    return out


# ------------------------------------------------------------------ build
def build(vault):
    gs = goals(vault)
    tasks = done_tasks(vault)
    ch = chains()
    ev = resolved_events(vault)
    pipe = pipeline(vault)

    feed = [{"date": g["date"], "kind": "milestone", "title": g["title"]}
            for g in gs if g["done"] and g["date"]]
    seen_ms = {(x["date"], x["title"].lower()) for x in feed}
    feed += [{"date": e["date"], "kind": "deadline", "title": e["title"]}
             for e in ev if e["category"] == "deadlines" and e["date"]
             and (e["date"], (e["title"] or "").lower()) not in seen_ms]
    feed += [{"date": c["completedOn"], "kind": "project",
              "title": (c["title"] or c["slug"] or "Project") + " — chain complete"}
             for c in ch if c["done"] and c["completedOn"]]
    feed.sort(key=lambda x: x["date"], reverse=True)

    tag_counts = {}
    for t in tasks:
        for tg in t.get("tags") or []:
            if tg.startswith("m:") or tg.isdigit():
                continue
            tag_counts[tg] = tag_counts.get(tg, 0) + 1

    return {
        "kpis": {
            "underReview": sum(1 for p in pipe if p["status"] == "under_review"),
            "published": sum(1 for p in pipe if p["status"] == "published"),
            "milestonesDone": sum(1 for g in gs if g["done"]),
            "goalsTotal": len(gs),
            "tasksDone": len(tasks),
            "estMinutes": sum(t.get("est") or 0 for t in tasks),
        },
        "pipeline": pipe,
        "chains": ch,
        "timeline": feed[:80],
        "weekly": weekly(tasks),
        "tags": sorted(tag_counts.items(), key=lambda kv: (-kv[1], kv[0]))[:12],
        "recentTasks": sorted((t for t in tasks if t.get("due")),
                              key=lambda t: t["due"], reverse=True)[:15],
    }


if __name__ == "__main__":
    import sys
    vault = Path(sys.argv[1]) if len(sys.argv) > 1 else settings.VAULT
    print(json.dumps(build(vault), ensure_ascii=False, indent=1))
