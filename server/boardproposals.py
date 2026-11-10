#!/usr/bin/env python3
"""Proposed CARDS -- the one lane an agent may put a task in, and it isn't the board."""
import settings
import json
import os
import re
import time
from datetime import datetime
from pathlib import Path

import kanban

HERE = settings.STATE_DIR
VAULT = settings.VAULT
FILE = HERE / "board-proposals.json"

TASKS_BOARD = settings.TASKS_BOARD_REL
BOARD_OK = re.compile(
    r"^(" + re.escape(TASKS_BOARD) + r"|Projects/papers/" + settings.LIVE_PROJECT_RE + r"/PATH\.md)$"
)
_ISO = re.compile(r"^\d{4}-\d{2}-\d{2}$")
KEEP_RESOLVED = 60          # how many accepted/rejected to remember
MAX_PENDING = 40            # a runaway agent can't bury the surface


def _load():
    try:
        d = json.loads(FILE.read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else {"proposals": []}
    except Exception:
        return {"proposals": []}


def _atomic_write(path, text):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def _card_line(card):
    """The task-board line body: text @due(YYYY-MM-DD) @priority @est(..) #tag."""
    parts = [re.sub(r"\s+", " ", card.get("text") or "").strip()]
    if card.get("due"):
        parts.append(f"@due({card['due']})")
    pr = str(card.get("priority") or "").strip().lower()
    if pr in ("high", "medium", "low"):
        parts.append("@" + pr)
    est = re.sub(r"[^\w.]", "", str(card.get("est") or ""))
    if est:
        parts.append(f"@est({est})")
    tag = re.sub(r"[^A-Za-z0-9\-_/]", "", str(card.get("tag") or ""))
    if tag:
        parts.append("#" + tag)
    return " ".join(x for x in parts if x)


def _board_path(board):
    """The vault file for an allowed board name, or raise."""
    if not BOARD_OK.match(board):
        raise ValueError(f"not a board this may target: {board}")
    path = (VAULT / board).resolve()
    if not path.is_relative_to(VAULT.resolve()):
        raise ValueError(f"not a board this may target: {board}")
    return path


def _write(d):
    _atomic_write(FILE, json.dumps(d, ensure_ascii=False, indent=1))


def _prune(rows):
    pending = [r for r in rows if r.get("status") == "pending"]
    resolved = [r for r in rows if r.get("status") != "pending"]
    return pending[-MAX_PENDING:] + resolved[-KEEP_RESOLVED:]


def _norm(s):
    return re.sub(r"\s+", " ", (s or "").strip().lower())


def add(item):
    """An agent proposes ONE card. Returns the stored proposal."""
    item = dict(item or {})
    text = (item.get("text") or "").strip()
    if not text:
        raise ValueError("a proposed card needs text")

    board = (item.get("board") or TASKS_BOARD).strip()
    _board_path(board)

    d = _load()
    rows = d.get("proposals") or []
    key = _norm(text)
    for r in rows:                       # never re-propose the same card
        if _norm(r.get("text")) == key and r.get("status") in ("pending", "rejected"):
            return dict(r, duplicate=True)

    due = (item.get("due") or "").strip()
    pr = (item.get("priority") or "").strip().lower()
    rec = {
        "id": f"bp-{int(time.time() * 1000)}-{len(rows)}",
        "text": text,
        "board": board,
        "lane": (item.get("lane") or "").strip() or "BACKLOG",
        "due": due if _ISO.match(due) else None,
        "priority": pr if pr in ("high", "medium", "low") else None,
        "est": (item.get("est") or "").strip() or None,
        "tag": (item.get("tag") or "").strip().lstrip("#") or None,
        "note": (item.get("note") or "").strip() or None,
        "source": (item.get("source") or "agent").strip(),
        "ts": datetime.now().isoformat(timespec="minutes"),
        "status": "pending",
    }
    rows.append(rec)
    d["proposals"] = _prune(rows)
    _write(d)
    return rec


def listing(include_resolved=False):
    rows = _load().get("proposals") or []
    if not include_resolved:
        rows = [r for r in rows if r.get("status") == "pending"]
    rows = sorted(rows, key=lambda r: r.get("ts") or "", reverse=True)
    return {"proposals": rows,
            "pending": sum(1 for r in (_load().get("proposals") or [])
                           if r.get("status") == "pending")}


def _resolve(pid, status):
    d = _load()
    for r in d.get("proposals") or []:
        if r.get("id") == pid:
            r["status"] = status
            r["resolvedAt"] = datetime.now().isoformat(timespec="minutes")
            _write(d)
            return r
    return None


def reject(pid):
    r = _resolve(pid, "rejected")
    if not r:
        raise ValueError("no such proposal")
    return listing()


def accept(pid, override=None):
    d = _load()
    row = next((r for r in d.get("proposals") or [] if r.get("id") == pid), None)
    if not row:
        raise ValueError("no such proposal")
    if row.get("status") != "pending":
        raise ValueError(f"already {row.get('status')}")

    o = dict(override or {})
    board = (o.get("board") or row.get("board") or TASKS_BOARD).strip()
    path = _board_path(board)
    text = path.read_text(encoding="utf-8") if path.is_file() else None
    if text is None:
        raise ValueError(f"board not found: {board}")

    due = (o.get("due") if "due" in o else row.get("due")) or ""
    due = due.strip() if isinstance(due, str) else ""
    body = _card_line({
        "text": (o.get("text") or row.get("text") or "").strip(),
        "due": due if _ISO.match(due) else None,
        "priority": o.get("priority") if "priority" in o else row.get("priority"),
        "est": o.get("est") if "est" in o else row.get("est"),
        "tag": o.get("tag") if "tag" in o else row.get("tag"),
    })
    lane = (o.get("lane") or row.get("lane") or "BACKLOG").strip()
    lanes = [l.get("name") for l in kanban.get_board(text).get("lanes", [])]
    if lane not in lanes:
        lane = "BACKLOG" if "BACKLOG" in lanes else (lanes[0] if lanes else lane)

    new = kanban.add_card(text, lane, body)
    if new is None:
        raise ValueError(f"could not add the card to {lane}")
    _atomic_write(path, new)

    row["status"] = "accepted"
    row["resolvedAt"] = datetime.now().isoformat(timespec="minutes")
    row["committedTo"] = {"board": board, "lane": lane, "body": body}
    _write(d)
    return {"ok": True, "board": board, "lane": lane, "body": body,
            "proposals": listing()["proposals"]}
