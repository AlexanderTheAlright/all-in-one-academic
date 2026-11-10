import json
import logging
import os
import re
import threading
import time
from datetime import date, datetime, timedelta
from pathlib import Path

import drafting
import settings
import kanban
import learning
import notes_organizer
import reading
import systems

VIEWS = ("today", "calendar", "drafting", "notes", "reading", "learning",
         "library", "systems", "insights")
REFRESH_SECS = 120
SLOW_MS = 500
FIRST_CALL_BUDGET_S = 2.5

log = logging.getLogger("glimpse")

_S = {}                                   # serve.py globals (late-bound)
_lock = threading.Lock()                  # guards _state
_first_lock = threading.Lock()            # one synchronous first compute at a time
_state = {"body": None, "ms": "", "slow": frozenset()}
_started = False


# ------------------------------------------------------------------ small helpers

def _now_iso():
    return datetime.now().isoformat(timespec="seconds")


def _clip(s, n=72):
    s = re.sub(r"\s+", " ", str(s or "")).strip()
    return s if len(s) <= n else s[: n - 1].rstrip() + "…"


_WIKI = re.compile(r"\[\[([^\]|]+)(?:\|([^\]]+))?\]\]")
_MDLINK = re.compile(r"\[([^\]]+)\]\([^)]+\)")
_TAG = re.compile(r"(?<!\S)#[\w/-]+")
_DATEMARK = re.compile("(?:[\U0001F4C5⏳\U0001F6EB✅➕]️?\\s*\\d{4}-\\d{2}-\\d{2}"
                       r"|@\{\d{4}-\d{2}-\d{2}\})")
_EMOJI = re.compile("[\U0001F000-\U0001FAFF⌀-⏿☀-➿⬀-⯿️‍]")


def _plain(s, n=72):
    """Card / note text as a bare label: links unwrapped, tags, date markers,
    emoji and markdown emphasis removed."""
    s = _WIKI.sub(lambda m: m.group(2) or m.group(1).split("/")[-1], str(s or ""))
    s = _MDLINK.sub(r"\1", s)
    s = _DATEMARK.sub("", s)
    s = _TAG.sub("", s)
    s = _EMOJI.sub("", s)
    s = re.sub(r"[*_`~]+", "", s)
    return _clip(s, n)


def _day(iso):
    try:
        d = date.fromisoformat(str(iso)[:10])
    except ValueError:
        return str(iso)
    return f"{d:%a %b} {d.day}"


def _ago(epoch):
    if not epoch:
        return ""
    if epoch > 1e11:                      # milliseconds
        epoch /= 1000.0
    days = (date.today() - date.fromtimestamp(epoch)).days
    if days <= 0:
        return "today"
    return f"{days}d ago" if days < 14 else f"{days // 7}w ago"


def _stat(label, value, tone=None):
    d = {"label": label, "value": value}
    if tone:
        d["tone"] = tone
    return d


def _row(title, meta=None, tone=None):
    d = {"title": title}
    if meta:
        d["meta"] = meta
    if tone:
        d["tone"] = tone
    return d


def _n(x):
    return f"{x:,}" if isinstance(x, int) else str(x)


def _bars(label, pairs, unit=None):
    """A bars series from (x, y) pairs; category labels clipped to 12 chars."""
    s = {"kind": "bars", "label": label,
         "points": [{"x": _clip(x, 12), "y": int(y or 0)} for x, y in pairs][-90:]}
    if unit:
        s["unit"] = unit
    return s


def _days_back(n):
    """The last n days as ISO dates, oldest first, ending today."""
    today = date.today()
    return [(today - timedelta(days=i)).isoformat() for i in range(n - 1, -1, -1)]


def _daily(label, by_day, days, unit=None):
    """A bars series over `days` from a date -> count dict (missing days are 0)."""
    s = {"kind": "bars", "label": label,
         "points": [{"x": d, "y": int(by_day.get(d) or 0)} for d in days]}
    if unit:
        s["unit"] = unit
    return s


def _epoch_day(epoch):
    """ISO day of a seconds (or milliseconds) epoch, or None."""
    try:
        e = float(epoch or 0)
    except (TypeError, ValueError):
        return None
    if e <= 0:
        return None
    if e > 1e11:
        e /= 1000.0
    return date.fromtimestamp(e).isoformat()


_analytics_cache = {"mtime": None, "data": None}
_cite_cache = {"mtime": None, "data": {}}


def _citation_index():
    """build_cache.py's per-note index (.citation-cache.json beside dashboard-data.json):
    note name -> {mtime, rec:{status, ...}}. Re-parsed only when its mtime moves; a
    missing or half-written file keeps the last parse. Nothing here writes it."""
    p = Path(_S["CACHE_FILE"]).with_name(".citation-cache.json")
    try:
        mt = p.stat().st_mtime
    except OSError:
        return _cite_cache["data"]
    if _cite_cache["mtime"] != mt:
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return _cite_cache["data"]
        if isinstance(data, dict):
            _cite_cache.update(mtime=mt, data=data)
    return _cite_cache["data"]


def _newest_notes(n):
    """The n most recently touched citation notes: (name, status, epoch)."""
    out = []
    for name, e in _citation_index().items():
        if not isinstance(e, dict):
            continue
        rec = e.get("rec") or {}
        out.append((e.get("mtime") or 0, name[:-3] if name.endswith(".md") else name,
                    str(rec.get("status") or "")))
    out.sort(key=lambda x: -x[0])
    return [(name, status, mt) for mt, name, status in out[:n]]


def _analytics():
    """dashboard-data.json, re-parsed only when its mtime moves. A half-written file
    (build_cache.py mid-write) keeps the last good parse."""
    p = Path(_S["CACHE_FILE"])
    mt = p.stat().st_mtime
    if _analytics_cache["mtime"] != mt:
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except ValueError:
            if _analytics_cache["data"] is None:
                raise
            return _analytics_cache["data"]
        _analytics_cache.update(mtime=mt, data=data)
    return _analytics_cache["data"]


# ------------------------------------------------------------------------- views

def v_today():
    today = date.today()
    t_iso, week = today.isoformat(), (today + timedelta(days=7)).isoformat()
    card_due = _S["card_due"]
    overdue, due_today, due_soon, flagged = [], [], [], []
    for b in _S["scan_boards"]():
        for lane in b["board"]["lanes"]:
            for c in lane["cards"]:
                if c["done"]:
                    continue
                due = card_due(c)
                it = {"due": due, "text": c["text"], "board": b["name"],
                      "planning": b["isPlanning"], "lane": lane["name"]}
                if not due:
                    if c.get("priority") == "high":
                        flagged.append(it)
                elif due < t_iso:
                    overdue.append(it)
                elif due == t_iso:
                    due_today.append(it)
                elif due <= week:
                    due_soon.append(it)
    overdue.sort(key=lambda x: x["due"])
    due_today.sort(key=lambda x: (not x["planning"], 0 if x["lane"] == "TODAY" else 1))
    due_soon.sort(key=lambda x: x["due"])

    words_by = {d["date"]: d["words"] for d in _S["scan_daily"]()}
    words = words_by.get(t_iso, 0)
    points = [{"x": (today - timedelta(days=i)).isoformat(),
               "y": words_by.get((today - timedelta(days=i)).isoformat(), 0)}
              for i in range(13, -1, -1)]

    rows = []
    for it in overdue:
        rows.append(_row(_plain(it["text"]), " · ".join(filter(None, [
            "overdue " + _day(it["due"]), None if it["planning"] else it["board"]])), "bad"))
    for it in due_today:
        rows.append(_row(_plain(it["text"]), " · ".join(filter(None, [
            "today", None if it["planning"] else it["board"]])), "warn"))
    for it in due_soon:
        rows.append(_row(_plain(it["text"]), " · ".join(filter(None, [
            _day(it["due"]), None if it["planning"] else it["board"]]))))
    for it in flagged:
        rows.append(_row(_plain(it["text"]), "high priority", "muted"))

    return {
        "headline": f"{len(due_today)} due today · {len(overdue)} overdue · {_n(words)} words",
        "stats": [_stat("Due today", len(due_today), "warn" if due_today else None),
                  _stat("Overdue", len(overdue), "bad" if overdue else "good"),
                  _stat("Words", words, None if words else "muted"),
                  _stat("Due 7d", len(due_soon)),
                  _stat("Flagged", len(flagged), None if flagged else "muted")],
        "series": {"kind": "bars", "label": "Words", "unit": "words", "points": points},
        "list": rows[:12],
    }


def v_calendar():
    today = date.today()
    t_iso = today.isoformat()
    in7, in21 = (today + timedelta(days=6)).isoformat(), (today + timedelta(days=20)).isoformat()
    evs = []
    for e in _S["scan_events"]():
        s = str(e.get("date") or "")[:10]
        if not s:
            continue
        en = str(e.get("endDate") or s)[:10]
        if en < s:
            en = s
        is_deadline = e.get("category") == "deadlines"
        if is_deadline and e.get("completed"):
            continue
        evs.append((s, en, is_deadline, e))

    events7 = [x for x in evs if not x[2] and x[0] <= in7 and x[1] >= t_iso]
    deadlines21 = [x for x in evs if x[2] and t_iso <= x[0] <= in21]
    soon = (today + timedelta(days=3)).isoformat()

    text = _S["read_text"](_S["PLANNING_BOARD_FILE"]) or ""
    floating = 0
    if text:
        for lane in kanban.get_board(text).get("lanes", []):
            if lane.get("name") in ("DONE", "Archive"):
                continue
            floating += sum(1 for c in lane.get("cards", []) if not c.get("done") and not c.get("due"))

    points = []
    for i in range(21):
        d = (today + timedelta(days=i)).isoformat()
        points.append({"x": d, "y": sum(1 for x in evs if x[0] <= d <= x[1])})

    upcoming = sorted((x for x in evs if x[1] >= t_iso),
                      key=lambda x: (max(x[0], t_iso), str(x[3].get("startTime") or "")))
    today_n = sum(1 for x in evs if x[0] <= t_iso <= x[1])
    next_dl = min((x[0] for x in evs if x[2] and x[0] >= t_iso), default=None)
    next_in = (date.fromisoformat(next_dl) - today).days if next_dl else None
    rows = []
    for s, en, is_deadline, e in upcoming[:12]:
        cat = str(e.get("category") or "")
        cat = cat[:-1] if cat.endswith("s") else cat
        when = _day(max(s, t_iso))
        if e.get("startTime") and s >= t_iso:
            when += " " + str(e["startTime"])[:5]
        rows.append(_row(_plain(e.get("title")), f"{when} · {cat}" if cat else when,
                         "warn" if is_deadline else None))

    return {
        "headline": f"{len(events7)} events 7d · {len(deadlines21)} deadlines 21d · "
                    f"{floating} floating",
        "stats": [_stat("Events 7d", len(events7)),
                  _stat("Deadlines 21d", len(deadlines21),
                        "warn" if any(x[0] <= soon for x in deadlines21) else None),
                  _stat("Floating", floating),
                  _stat("Today", today_n),
                  _stat("Next deadline", f"{next_in}d" if next_in is not None else "none",
                        "warn" if next_in is not None and next_in <= 3 else None)],
        "series": {"kind": "bars", "label": "Events", "unit": "events", "points": points},
        "list": rows,
    }


def v_drafting():
    vault = Path(_S["VAULT"])
    flags = drafting._load_flags()
    statuses = drafting._load_statuses()
    days = _days_back(30)
    words_day, comm_day = dict.fromkeys(days, 0), dict.fromkeys(days, 0)
    week_iso = days[-7]
    open_comments = ckpt7 = 0
    docs = []
    for tree in ("papers", "grants"):
        root = vault / "Projects" / tree
        if not root.is_dir():
            continue
        for d in sorted(root.iterdir()):
            if not d.is_dir() or not settings.live_slug(d.name):
                continue
            slug = settings.live_slug(d.name)
            wdir = d / "writing"
            if not wdir.is_dir():
                continue
            for docname, meta in drafting.DOC_KINDS.items():
                if meta.get("base", "papers") != "papers":
                    continue
                p = wdir / docname
                if not p.is_file():
                    continue
                txt = drafting._read(p) or ""
                key = "paper:%s:%s" % (slug, docname)
                docs.append({"title": drafting._paper_title(txt, slug),
                             "words": drafting._wordcount(txt), "mtime": drafting._mt(p),
                             "status": statuses.get(key, "draft"), "pinned": bool(flags.get(key))})
            # words per day: the growth between consecutive checkpoints in the versions
            # manifest (a read of versions.json, never a checkpoint)
            man = drafting._load_manifest(wdir / drafting.VERSIONS_DIR)
            vs = man.get("versions") or []
            for docname in {v.get("doc") or drafting.DEFAULT_DOC for v in vs}:
                seq = sorted(drafting._versions_for(man, docname), key=lambda v: v.get("ts") or 0)
                for a, b in zip(seq, seq[1:]):
                    k = _epoch_day(b.get("ts"))
                    if k in words_day:
                        words_day[k] += max(0, int(b.get("words") or 0) - int(a.get("words") or 0))
                    if k and k >= week_iso:
                        ckpt7 += 1
            # comments per day from the raw sidecars: drafting.load_comments absorbs sync
            # conflicts, which writes, so it is deliberately not called here
            vdir = wdir / "versioning"
            if vdir.is_dir():
                for p in vdir.glob("*comments.json"):
                    try:
                        raw = json.loads(drafting._read(p) or "{}")
                    except ValueError:
                        continue
                    for c in (raw if isinstance(raw, list) else (raw or {}).get("comments") or []):
                        if not isinstance(c, dict):
                            continue
                        if not c.get("resolved"):
                            open_comments += 1
                        k = _epoch_day(c.get("created"))
                        if k in comm_day:
                            comm_day[k] += 1
    active = [x for x in docs if x["status"] != "published"]
    pinned = [x for x in docs if x["pinned"]]
    review = [x for x in docs if x["status"] == "under_review"]
    published = [x for x in docs if x["status"] == "published"]
    week_ms = (time.time() - 7 * 86400) * 1000
    edited7 = sum(1 for x in docs if x["mtime"] >= week_ms)
    docs.sort(key=lambda x: (not x["pinned"], -x["mtime"]))
    rows = [_row(_plain(x["title"], 64), " · ".join(filter(None, [
                f"{_n(x['words'])} words", _ago(x["mtime"]),
                "under review" if x["status"] == "under_review" else
                "published" if x["status"] == "published" else None])),
                 "muted" if x["status"] == "published" else None)
            for x in docs[:12]]
    words30 = sum(words_day.values())
    # grouped as the Drafting library groups them: pinned leave their status group
    by_status = _bars("By status", [
        ("Pinned", len(pinned)),
        ("Drafting", sum(1 for x in docs if not x["pinned"] and x["status"] == "draft")),
        ("Review", sum(1 for x in docs if not x["pinned"] and x["status"] == "under_review")),
        ("Published", sum(1 for x in docs if not x["pinned"] and x["status"] == "published"))],
        "manuscripts")
    return {
        "headline": f"{len(active)} manuscripts · {len(pinned)} pinned · "
                    f"{len(review)} under review",
        "stats": [_stat("In progress", len(active)), _stat("Pinned", len(pinned)),
                  _stat("Under review", len(review)), _stat("Edited 7d", edited7),
                  _stat("Published", len(published)), _stat("Words 30d", words30, None if words30 else "muted"),
                  _stat("Open comments", open_comments, "warn" if open_comments else None),
                  _stat("Checkpoints 7d", ckpt7)],
        # a quiet month falls back to the status groups rather than an empty field
        "series": _daily("Words per day", words_day, days, "words") if words30 else by_status,
        "series2": _daily("Comments", comm_day, days, "comments"),
        "list": rows,
    }


def v_notes():
    inbox = notes_organizer.list_inbox()
    filed = notes_organizer.list_all()
    since = (date.today() - timedelta(days=6)).isoformat()
    week = time.time() - 7 * 86400
    both = [dict(n, folder="Inbox") for n in inbox] + filed
    new7 = sum(1 for n in both if str(n.get("created") or "")[:10] >= since)
    edited7 = sum(1 for n in both if (n.get("mtime") or 0) >= week)
    recent = sorted(both, key=lambda n: -(n.get("mtime") or 0))[:12]
    today = date.today()
    created = [str(n.get("created") or "")[:10] for n in both]
    days14 = [(today - timedelta(days=i)).isoformat() for i in range(13, -1, -1)]
    # the four largest sections (Ideas, Concepts, Meetings ...) as their own counts
    folders = {}
    for n in filed:
        f = str(n.get("folder") or "")
        if f and f not in ("Citations", "Inbox"):
            folders[f] = folders.get(f, 0) + 1
    top_folders = sorted(folders.items(), key=lambda kv: -kv[1])[:4]
    return {
        "headline": f"{len(inbox)} in inbox · {new7} new 7d · {edited7} edited 7d",
        "stats": [_stat("Inbox", len(inbox)), _stat("New 7d", new7),
                  _stat("Edited 7d", edited7), _stat("Filed", len(filed))]
                 + [_stat(_clip(f, 14), c) for f, c in top_folders],
        "series": {"kind": "bars", "label": "New notes", "unit": "notes",
                   "points": [{"x": d, "y": created.count(d)} for d in days14]},
        "list": [_row(_plain(n.get("title"), 64),
                      " · ".join(filter(None, [n.get("folder"), _ago(n.get("mtime"))])))
                 for n in recent],
    }


def _corpus_by_day(days):
    """PDFs that landed in Reading/Corpus per day (file mtime), over `days`."""
    out = dict.fromkeys(days, 0)
    corpus = Path(_S["VAULT"]) / "Preparation" / "Reading" / "Corpus"
    try:
        with os.scandir(corpus) as it:
            for e in it:
                if not e.name.lower().endswith(".pdf") or not e.is_file():
                    continue
                k = _epoch_day(e.stat().st_mtime)
                if k in out:
                    out[k] += 1
    except OSError:
        pass
    return out


def v_reading():
    downloads = reading.downloads()
    today = _S["reading_today"]()
    inbox = _S["reading_inbox"]()
    items = _analytics().get("items") or []
    now_reading = [i for i in items if i.get("status") == "reading"]
    lists = reading.active_lists()
    # "Read" = items marked read across the active reading lists (the view's read/total)
    read_total = sum(int(l.get("read") or 0) for l in lists)
    days = _days_back(30)
    added = _corpus_by_day(days)
    read_day = dict.fromkeys(days, 0)
    for e in _citation_index().values():
        if isinstance(e, dict) and (e.get("rec") or {}).get("status") == "read":
            k = _epoch_day(e.get("mtime"))
            if k in read_day:
                read_day[k] += 1
    rows = [_row(_plain(r.get("label"), 64), "overdue " + _day(r["due"]) if r.get("overdue")
                 else "today", "bad" if r.get("overdue") else None) for r in today[:12]]
    rows += [_row(_plain(i.get("name"), 64),
                  " ".join(filter(None, [str(i.get("author") or "").strip(),
                                         str(i.get("year") or "")])) or None)
             for i in now_reading[:12 - len(rows)]]
    if len(rows) < 12:
        rows += [_row(_plain(name, 64), " · ".join(filter(None, [status, _ago(mt)])) or None,
                      "good" if status == "read" else None)
                 for name, status, mt in _newest_notes(12 - len(rows))]
    added30 = sum(added.values())
    nxt = reading.next_up()
    queue, behind = nxt.get("queue") or [], int(nxt.get("behind") or 0)
    head = f"{_n(len(downloads))} to download · {len(today)} today · {len(now_reading)} in progress"
    if queue:
        head = f"Next: {_plain(queue[0].get('title'), 48)} · {head}"
    pipeline = _bars("Pipeline", [
        ("To download", len(downloads)), ("Inbox", len(inbox)), ("Today", len(today)),
        ("In progress", len(now_reading)), ("Read", read_total)], "items")
    return {
        "headline": head,
        "stats": [_stat("To download", len(downloads)), _stat("Today", len(today)),
                  _stat("Queue", len(queue)), _stat("Behind", behind, "warn" if behind else "muted"),
                  _stat("In progress", len(now_reading)), _stat("Inbox", len(inbox)),
                  _stat("Read", read_total), _stat("Read 30d", sum(read_day.values())),
                  _stat("Lists", len(lists)), _stat("PDFs 30d", added30, None if added30 else "muted")],
        # a month with no PDF landing falls back to the pipeline snapshot
        "series": _daily("PDFs added", added, days, "PDFs") if added30 else pipeline,
        "series2": _daily("Marked read", read_day, days, "notes"),
        "list": rows,
    }


_sr_lock = threading.Lock()
_sr_files = {}                            # path -> (mtime_ns, [last-review ISO date per card])


def _last_review_dates():
    """Each scheduled card's latest review day, from its SR comment. A review writes
    due = review day + interval (learning.review), so due - interval is exact for the
    most recent review. Per-file results are kept until the file's mtime moves."""
    root = Path(_S["LEARNING_ROOT"])
    out, seen = [], set()
    with _sr_lock:
        if root.is_dir():
            for f in root.rglob("*.md"):
                try:
                    mt = f.stat().st_mtime_ns
                except OSError:
                    continue
                key = str(f)
                seen.add(key)
                hit = _sr_files.get(key)
                if hit is None or hit[0] != mt:
                    text = learning._read(f)
                    dates = []
                    if text and "<!--SR:" in text:
                        for m in learning.SR.finditer(text):
                            last = None
                            for due, iv, _ease in learning.SCHED.findall(m.group(1)):
                                try:
                                    d = date.fromisoformat(due) - timedelta(days=int(iv))
                                except ValueError:
                                    continue
                                last = d if last is None or d > last else last
                            if last:
                                dates.append(last.isoformat())
                    hit = (mt, dates)
                    _sr_files[key] = hit
                out.extend(hit[1])
        for k in [k for k in _sr_files if k not in seen]:
            del _sr_files[k]
    return out


def v_learning():
    s = _S["learn_scan"]()
    t_iso = date.today().isoformat()
    days = _days_back(30)
    rev = dict.fromkeys(days, 0)
    for d in _last_review_dates():
        if d in rev:
            rev[d] += 1
    reviewed_today = rev[t_iso]
    rev7 = sum(rev[d] for d in days[-7:])
    total = s.get("total") or 0
    learned = round(100 * (s.get("reviewed") or 0) / total) if total else 0
    active = [d for d in s.get("decks") or [] if not d.get("shelved")]
    decks = sorted((d for d in active if d.get("due")), key=lambda d: -d["due"])
    return {
        "headline": f"{_n(s.get('due') or 0)} due · {_n(s.get('new') or 0)} new · "
                    f"{reviewed_today} reviewed today",
        "stats": [_stat("Due", s.get("due") or 0), _stat("New", s.get("new") or 0),
                  _stat("Reviewed today", reviewed_today, "good" if reviewed_today else "muted"),
                  _stat("Learned", f"{learned}%"),
                  _stat("Reviewed 7d", rev7, "good" if rev7 else "muted"),
                  _stat("Reviewed 30d", sum(rev.values())),
                  _stat("Decks", len(active)), _stat("Cards", total)],
        "series": _bars("Due by deck", [
            (d["deck"], d.get("due") or 0) for d in sorted(
                active, key=lambda d: -(d.get("due") or 0))[:6]], "cards"),
        "series2": _daily("Reviewed", rev, days, "cards"),
        "list": [_row(_plain(d["deck"], 48), f"{_n(d['due'])} due · {_n(d.get('new') or 0)} new")
                 for d in decks[:12]],
    }


def v_library():
    cache = _analytics()
    k = cache.get("kpi") or {}
    decades = [t for t in cache.get("decades") or [] if isinstance(t, (list, tuple)) and len(t) == 2]
    total, read_n = k.get("total") or 0, k.get("read") or 0
    missing = total - (k.get("withPdf") or 0)
    avg = k.get("avgRating")
    stats = [_stat("Sources", total), _stat("Read", read_n),
             _stat("Missing PDFs", missing, "warn" if missing else "good")]
    if avg is not None:
        stats.append(_stat("Avg rating", round(float(avg), 1)))
    stats += [_stat("Rated", k.get("rated") or 0),
              _stat("Read", f"{round(100 * read_n / total) if total else 0}%"),
              _stat("Projects", k.get("projects") or 0)]
    return {"headline": f"{_n(total)} sources · {_n(read_n)} read · {_n(missing)} missing PDFs",
            "stats": stats,
            "series": _bars("By decade", [(str(t[0]), t[1]) for t in decades], "sources"),
            "list": [_row(_plain(name, 64), " · ".join(filter(None, [status, _ago(mt)])) or None,
                          "good" if status == "read" else None)
                     for name, status, mt in _newest_notes(12)]}


def _dims_of(c):
    """Every {cm, estimated} number a component carries: interior, zones, item and
    proposal sizes (the same census the Size tab shows)."""
    out = []
    def add(o, keys):
        for k in keys:
            v = (o or {}).get(k) if isinstance(o, dict) else None
            if isinstance(v, dict) and "cm" in v:
                out.append(v)
    add(c.get("dims"), ("w", "d", "h"))
    for z in c.get("zones") or []:
        add(z, ("x", "y", "w", "h", "d"))
    for coll in ("items", "proposals"):
        for x in c.get(coll) or []:
            if isinstance(x, dict):
                add(x.get("size"), ("w", "d", "h"))
    return out


def v_systems():
    """The current place of every domain, its components read through systems.component
    (pure: fit is computed in memory, nothing is written)."""
    root = str(_S["SYSTEMS_ROOT"])
    comps = []                                          # (domain name, instance name, component)
    doms = systems.tree(root).get("domains") or []
    for d in doms:
        inst = next((i for i in d.get("instances") or [] if i.get("id") == d.get("current")), None)
        if not inst:
            continue
        for cref in inst.get("components") or []:
            try:
                c = systems.component(root, d["id"], inst["id"], cref.get("id"))["component"]
            except (LookupError, ValueError):
                continue
            comps.append((d.get("name") or d["id"], inst.get("name") or inst["id"], c))
    if not comps:
        live = sum(1 for d in doms if d.get("current"))
        tops = sum(1 for d in doms if not d.get("parent"))      # subsystems are not counted as systems
        return {"headline": f"{tops} systems · {live} started" if doms else "No systems yet",
                "stats": [_stat("Systems", tops, "muted")]}
    items = [it for _, _, c in comps for it in c.get("items") or [] if isinstance(it, dict)]
    zones = [z for _, _, c in comps for z in c.get("zones") or [] if isinstance(z, dict)]
    zone_ids = {(id(c), z.get("id")) for _, _, c in comps for z in c.get("zones") or [] if isinstance(z, dict)}
    placed = sum(1 for _, _, c in comps for it in c.get("items") or []
                 if isinstance(it, dict) and (id(c), it.get("zone")) in zone_ids)
    routines = [r for _, _, c in comps for r in c.get("routines") or [] if isinstance(r, dict)]
    steps = sum(len(r.get("steps") or []) for r in routines)
    props = [(c, p) for _, _, c in comps for p in c.get("proposals") or []
             if isinstance(p, dict) and p.get("status") != "dropped"]
    fits = sum(1 for _, p in props if (p.get("fit") or {}).get("state") == "fits")
    unknown = sum(1 for _, p in props if (p.get("fit") or {}).get("state", "unknown") == "unknown")
    nofit = len(props) - fits - unknown
    dims = [x for _, _, c in comps for x in _dims_of(c)]
    measured = sum(1 for x in dims if x.get("estimated") is False)
    share = round(100 * measured / len(dims)) if dims else 0
    hyg = {h: sum(1 for it in items if it.get("hygiene") == h) for h in systems.HYGIENE}
    hooks = sum(1 for z in zones if z.get("kind") == "hook")
    stats = [_stat("Items placed", placed, "warn" if placed < len(items) else None),
             _stat("Plan fits", f"{fits}/{len(props)}", "good" if props and fits == len(props) else None),
             _stat("Doesn't fit", nofit, "warn" if nofit else "muted"),
             _stat("Measured", f"{share}%", "warn" if dims and share < 50 else None),
             _stat("Zones", len(zones)),
             _stat("Valuables", hyg.get("valuables", 0)),
             _stat("Wet / used", hyg.get("wet/used", 0)),
             _stat("Routine steps", steps)]
    if unknown:
        stats.insert(3, _stat("Unchecked", unknown, "muted"))
    first = comps[0][2]
    zname = {z.get("id"): z.get("name") or z.get("id") for z in first.get("zones") or [] if isinstance(z, dict)}
    per_zone = [(zname[z], sum(1 for it in first.get("items") or [] if it.get("zone") == z))
                for z in zname]
    rows = []
    for dname, iname, c in comps:
        rows.append(_row(_plain(f"{c.get('name') or c.get('id')} · {iname}", 64),
                         f"{dname} · {len(c.get('items') or [])} items · {len(c.get('zones') or [])} zones"))
    for c, p in props:
        st = (p.get("fit") or {}).get("state", "unknown")
        rows.append(_row(_plain(p.get("name"), 64),
                         " · ".join(filter(None, [str(p.get("status") or ""), st,
                                                  (zname.get(p.get("zone")) or ("whole interior" if not p.get("zone") else None)) if c is first else None])),
                         "good" if st == "fits" else None if st == "unknown" else "warn"))
    head = (f"{placed} items in {len(zones)} zones · {fits} of {len(props)} plans fit · "
            f"{share}% measured")
    return {"headline": head, "stats": stats,
            "series": _bars(f"Items by zone, {first.get('name') or 'component'}", per_zone, "items"),
            "list": rows}


def v_insights():
    cache = _analytics()
    k = cache.get("kpi") or {}
    total = k.get("total") or 0
    read_pct = round(100 * (k.get("read") or 0) / total) if total else 0
    today = date.today()
    monday = today - timedelta(days=today.weekday())
    starts = [monday - timedelta(weeks=i) for i in range(11, -1, -1)]
    by_week = {s.isoformat(): 0 for s in starts}
    first = starts[0]
    for d in _S["scan_daily"]():
        try:
            dd = date.fromisoformat(d["date"])
        except ValueError:
            continue
        if dd < first or dd > today:
            continue
        wk = (dd - timedelta(days=dd.weekday())).isoformat()
        if wk in by_week:
            by_week[wk] += d.get("words") or 0
    tags = [t for t in cache.get("topTags") or [] if isinstance(t, (list, tuple)) and len(t) == 2]
    weeks = list(by_week.values())
    return {
        "headline": f"{read_pct}% read · {_n(k.get('rated') or 0)} rated · "
                    f"{k.get('projects') or 0} projects",
        "stats": [_stat("Read", f"{read_pct}%"), _stat("Rated", k.get("rated") or 0),
                  _stat("Projects", k.get("projects") or 0), _stat("Tasks", k.get("tasks") or 0),
                  _stat("Sources", total), _stat("Words this week", weeks[-1] if weeks else 0),
                  _stat("Words 12wk", sum(weeks)), _stat("Tags", len(tags))],
        "series": {"kind": "bars", "label": "Words per week", "unit": "words",
                   "points": [{"x": s, "y": v} for s, v in by_week.items()]},
        "list": [_row(_plain(str(t[0]).lstrip("#"), 48), f"{_n(t[1])} sources") for t in tags[:12]],
    }


_COMPUTE = {"today": v_today, "calendar": v_calendar, "drafting": v_drafting, "notes": v_notes,
            "reading": v_reading, "learning": v_learning, "library": v_library,
            "systems": v_systems, "insights": v_insights}


# ---------------------------------------------------------------------- snapshot

def _shape(g):
    """Hold a glimpse to the contract's sizes: 8 stats, 12 rows, 90 points a series; a
    second series only beside a first, and only when it has something to show."""
    if g.get("stats"):
        g["stats"] = g["stats"][:8]
    if "list" in g:
        g["list"] = g["list"][:12]
        if not g["list"]:
            del g["list"]
    if g.get("series"):
        g["series"]["points"] = g["series"]["points"][-90:]
    s2 = g.pop("series2", None)
    has = lambda s: bool(s) and any(p.get("y") for p in s.get("points") or [])   # noqa: E731
    if has(s2):
        s2["points"] = s2["points"][-90:]
        if has(g.get("series")):
            g["series2"] = s2
        else:
            # a first series with nothing in it is an empty field: the second takes its place
            g["series"] = s2
    return g


def _run_view(name):
    t0 = time.perf_counter()
    try:
        g = _shape(_COMPUTE[name]())
    except Exception as e:
        g = {"headline": "", "stats": [], "error": _clip(f"{type(e).__name__}: {e}", 200)}
    ms = (time.perf_counter() - t0) * 1000.0
    g["updated"] = _now_iso()
    log.debug("glimpse %s %.0f ms", name, ms)
    return g, ms


def _compute(budget=None):
    """All views. Sequential in the background (honest per-view timing); in parallel
    with a per-view budget for a first call that finds no snapshot yet."""
    views, ms = {}, {}
    if budget is None:
        for name in VIEWS:
            views[name], ms[name] = _run_view(name)
        return views, ms
    results = {}

    def work(n):
        results[n] = _run_view(n)

    threads = [threading.Thread(target=work, args=(n,), daemon=True, name="glimpse-" + n)
               for n in VIEWS]
    for t in threads:
        t.start()
    end = time.monotonic() + budget
    for t in threads:
        t.join(max(0.0, end - time.monotonic()))
    for n in VIEWS:
        r = results.get(n)
        if r is None:
            views[n] = {"headline": "", "stats": [], "error": "timeout", "updated": _now_iso()}
            ms[n] = budget * 1000.0
        else:
            views[n], ms[n] = r
    return views, ms


def _store(views, ms, only_if_empty=False):
    body = json.dumps({"generated": _now_iso(), "views": views}, ensure_ascii=False).encode("utf-8")
    hdr = ",".join(f"{n}={round(ms[n])}" for n in VIEWS)
    slow = frozenset(n for n in VIEWS if ms[n] > SLOW_MS)
    with _lock:
        if only_if_empty and _state["body"] is not None:
            return
        _state.update(body=body, ms=hdr)
        if slow != _state["slow"]:
            _state["slow"] = slow
            if slow:
                log.warning("glimpse: views over %d ms: %s", SLOW_MS,
                            ", ".join(f"{n}={round(ms[n])}" for n in sorted(slow)))


def _loop():
    while True:
        t0 = time.monotonic()
        try:
            _store(*_compute())
        except Exception as e:                       # never let the refresher die
            log.warning("glimpse refresh failed: %s", e)
        time.sleep(max(5.0, REFRESH_SECS - (time.monotonic() - t0)))


def start(ctx):
    """Register serve.py's globals and start the refresher (idempotent, non-blocking)."""
    global _S, _started
    _S = ctx
    if _started:
        return
    _started = True
    threading.Thread(target=_loop, daemon=True, name="glimpse-refresh").start()


def response():
    """-> (json bytes, per-view ms header). Returns the last snapshot at once; only a
    call that finds none computes, once, within the first-call budget."""
    with _lock:
        body, hdr = _state["body"], _state["ms"]
    if body is None:
        with _first_lock:
            with _lock:
                body = _state["body"]
            if body is None:
                _store(*_compute(FIRST_CALL_BUDGET_S), only_if_empty=True)
            with _lock:
                body, hdr = _state["body"], _state["ms"]
    return body, hdr
