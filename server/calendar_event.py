#!/usr/bin/env python3
import os
import re
import json
import argparse
from pathlib import Path

import settings

# the subdir IS the category — must match serve.py EVENT_DIRS keys exactly
CATEGORIES = ["meetings", "seminars", "deadlines", "birthdays", "holidays",
              "social", "teaching", "conferences", "travel"]


def _find_events_root(events_root=None) -> Path:
    if events_root:
        return Path(events_root)
    return settings.VAULT / "Preparation" / "Calendar" / "events"


def add_event(title, date, *, start=None, end=None, category="meetings",
              location=None, note=None, all_day=None, repeats_yearly=False,
              end_date=None, events_root=None) -> dict:
    title = " ".join(str(title or "").split())
    date_s = (date or "").strip()
    category = (category or "meetings").strip().lower()
    if not title:
        return {"error": "title required"}
    if not re.match(r"^\d{4}-\d{2}-\d{2}$", date_s):
        return {"error": "date must be YYYY-MM-DD"}
    if category not in CATEGORIES:
        return {"error": f"unknown category (use one of {CATEGORIES})"}

    root = _find_events_root(events_root)
    start_t = (start or "").strip()
    end_t = (end or "").strip()
    if any(t and not re.fullmatch(r"\d{1,2}:\d{2}", t) for t in (start_t, end_t)):
        return {"error": "times must be HH:MM"}
    # all_day defaults True unless a start time is given (matches scan_events)
    is_all_day = (bool(all_day) if all_day is not None else True) or not start_t
    if start_t:
        is_all_day = False

    slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")[:50] or "event"
    dest_dir = root / category
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / f"{date_s}_{slug}.md"
    i = 2
    while dest.exists():                       # never overwrite an existing event
        dest = dest_dir / f"{date_s}_{slug}-{i}.md"
        i += 1
    try:
        dest.resolve().relative_to(root.resolve())   # path confinement
    except Exception:
        return {"error": "path outside calendar tree"}

    q = title.replace('"', "'")
    lines = ["---", f'title: "{q}"']
    if repeats_yearly:
        # recurring: the plugin keys off type: rrule (never also emit type: single)
        lines += ["type: rrule", f"startDate: {date_s}", "rrule: FREQ=YEARLY", "allDay: true"]
    else:
        lines.append("type: single")
        if is_all_day:
            lines += [f"date: {date_s}", "allDay: true"]
        else:
            lines += [f"date: {date_s}", f'startTime: "{start_t}"']
            if end_t:
                lines.append(f'endTime: "{end_t}"')
            lines.append("allDay: false")
        if end_date and re.match(r"^\d{4}-\d{2}-\d{2}$", end_date.strip()):
            lines.append(f"endDate: {end_date.strip()}")
    loc = " ".join(str(location or "").split())
    if loc:
        lines.append(f'location: "{loc.replace(chr(34), chr(39))}"')
    lines += [f"calendarType: {category}", "tags:",
              "  - calendar", f"  - {category}", "---", ""]
    body = (note or "").strip()
    if body:
        lines.append(body + "\n")

    tmp = dest.with_suffix(".tmp")
    tmp.write_text("\n".join(lines), encoding="utf-8")
    os.replace(str(tmp), str(dest))
    # vault-relative path for display (root.parents[2] == the vault root)
    rel = dest
    try:
        rel = dest.relative_to(root.parents[2])   # events->Calendar->Preparation->vault
    except Exception:
        pass
    return {"ok": True, "path": str(rel).replace("\\", "/"),
            "category": category, "date": date_s, "allDay": is_all_day,
            "repeatsYearly": bool(repeats_yearly)}


def _main():
    ap = argparse.ArgumentParser(description="Add an event to the vault calendar.")
    sub = ap.add_subparsers(dest="cmd")
    a = sub.add_parser("add", help="add an event")
    a.add_argument("--title", required=True)
    a.add_argument("--date", required=True, help="YYYY-MM-DD")
    a.add_argument("--start", help='start time "HH:MM" (omit for all-day)')
    a.add_argument("--end", help='end time "HH:MM"')
    a.add_argument("--category", default="meetings", help=f"one of {CATEGORIES}")
    a.add_argument("--location")
    a.add_argument("--note", help="body text")
    a.add_argument("--end-date", help="YYYY-MM-DD for a multi-day event")
    a.add_argument("--repeats-yearly", action="store_true", help="e.g. birthdays")
    a.add_argument("--events-root", help="override the events/ dir (advanced)")
    sub.add_parser("categories", help="list valid categories")
    args = ap.parse_args()

    if args.cmd == "categories":
        print(json.dumps({"categories": CATEGORIES}))
        return 0
    if args.cmd == "add":
        res = add_event(args.title, args.date, start=args.start, end=args.end,
                        category=args.category, location=args.location, note=args.note,
                        end_date=args.end_date, repeats_yearly=args.repeats_yearly,
                        events_root=args.events_root)
        print(json.dumps(res, ensure_ascii=False))
        return 0 if res.get("ok") else 1
    ap.print_help()
    return 1


if __name__ == "__main__":
    raise SystemExit(_main())
