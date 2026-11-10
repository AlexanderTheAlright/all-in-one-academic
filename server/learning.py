"""Flashcard engine over Preparation/Learning/ — reads the same cards the
obsidian-spaced-repetition plugin uses and writes scheduling in its exact format."""
import os
import re
import json
import time
import random
import threading
from pathlib import Path
from datetime import date, timedelta

# SM-2 params (mirror the plugin's data.json)
BASE_EASE = 250
EASY_BONUS = 1.5      # longer jumps for "Easy" cards — lighten the review pace
LAPSE_CHANGE = 0.5
MAX_INTERVAL = 36525
NEW_PER_SESSION = 10  # gentle daily intro cap so a fresh deck never dumps hundreds
FORECAST_DAYS = 14    # how far the due forecast looks ahead, today inclusive

FLASHTAG = re.compile(r"#flashcards(/[A-Za-z0-9/_-]+)?")
SR = re.compile(r"<!--SR:(.*?)-->")
SCHED = re.compile(r"!(\d{4}-\d{2}-\d{2}),(\d+),(\d+)")
CLOZE = re.compile(r"==[^=]+==|\{\{[^}]+\}\}")
# image embeds: ![[name.png]] / ![[name.png|alias]] (wikilink) or ![alt](name.png) (markdown)
EMBED = re.compile(r"!\[\[([^\]|]+?)(?:\|[^\]]*)?\]\]|!\[[^\]]*\]\(([^)]+)\)")
# hotspot metadata for click-the-part cards: one or a list of {x,y,r?,w?,h?,label}
# (fractions 0..1 of the image box); stripped from card text, exposed structured.
HOTSPOT = re.compile(r"<!--HOTSPOT:(.*?)-->", re.S)
_ASSET_CT = {".png": "image/png", ".svg": "image/svg+xml", ".jpg": "image/jpeg",
             ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp"}
TODAY = lambda: date.today().isoformat()


def _first_embed(text):
    """Basename of the first image embed in `text`, or None."""
    if not text:
        return None
    m = EMBED.search(text)
    if not m:
        return None
    raw = (m.group(1) or m.group(2) or "").split("|")[0].strip()
    return os.path.basename(raw) or None


def _deck(text):
    m = FLASHTAG.search(text)
    if not m:
        return None, None
    sub = (m.group(1) or "").strip("/")
    full = sub or "general"
    return full, full.split("/")[0]


def _modules(top, subs):
    out = []
    for full, c in subs.items():
        mod = full[len(top) + 1:] if full.startswith(top + "/") else ""
        out.append({"sub": full, "module": mod or "(general)",
                    "total": c["total"], "due": c["due"], "new": c["new"],
                    "img": c.get("img", 0)})   # figures living IN this module (integrated, no atlas)
    out.sort(key=lambda m: m["sub"])
    return out


def _blocks(body):
    """Split a note body into card blocks (separated by blank lines), keeping a
    trailing SR comment attached to its block. Returns [(start_line, lines)]."""
    out, cur, start = [], [], None
    lines = body.split("\n")
    for i, ln in enumerate(lines):
        if ln.strip() == "":
            if cur:
                out.append((start, cur)); cur = []; start = None
        else:
            if start is None:
                start = i
            cur.append(ln)
    if cur:
        out.append((start, cur))
    return out, lines


def _card_from_block(lines):
    """Classify a block. Returns dict or None (prose/heading/not a card)."""
    sr_line = None
    work = lines[:]
    if work and SR.search(work[-1]):
        sr_line = work[-1]
        work = work[:-1]
    hotspots, kept = [], []
    for ln in work:
        hm = HOTSPOT.search(ln)
        if hm:
            try:
                data = json.loads(hm.group(1))
                hotspots.extend(data if isinstance(data, list) else [data])
            except Exception:
                pass
            residual = HOTSPOT.sub("", ln).strip()
            if residual:
                kept.append(residual)
        else:
            kept.append(ln)
    work = kept
    text = "\n".join(work).strip()
    if not text or text.startswith("#") or text.startswith(">"):
        return None
    front = back = None
    siblings = 1
    if ":::" in text and "\n" not in text:
        front, back = text.split(":::", 1); siblings = 2
    elif "::" in text and "\n" not in text:
        front, back = text.split("::", 1)
    elif "\n" in work_join(work):
        body = "\n".join(work)
        m = re.search(r"(?m)^\?\??\s*$", body)
        if m:
            sep = body[m.start():m.end()]
            siblings = 2 if "??" in sep else 1
            front = body[:m.start()].strip()
            back = body[m.end():].strip()
    if front is None:
        # cloze? a single paragraph with ==...== highlights
        clozes = CLOZE.findall(text)
        if clozes:
            siblings = len(clozes)
            front = CLOZE.sub("[…]", text)
            back = re.sub(r"==([^=]+)==", r"\1", text)
        else:
            return None
    scheds = []
    if sr_line:
        scheds = [{"due": d, "interval": int(i), "ease": int(e)}
                  for d, i, e in SCHED.findall(sr_line)]
    front, back = front.strip(), back.strip()
    image = _first_embed(front) or _first_embed(back)
    return {"front": front, "back": back, "siblings": siblings,
            "scheds": scheds, "hasSR": sr_line is not None,
            "hasImage": image is not None, "image": image,
            "hotspots": hotspots}


def work_join(work):
    return "\n".join(work)


def _forecast(horizon, overdue):
    days = sorted(horizon.items())
    return {
        "horizonDays": FORECAST_DAYS,
        "from": days[0][0] if days else TODAY(),
        "to": days[-1][0] if days else TODAY(),
        "overdue": overdue,
        "total": overdue + sum(n for _, n in days),
        "peak": max((n for _, n in days), default=0),
        "days": [{"date": d, "due": n} for d, n in days],
    }


def scan(learning_root, shelved=None):
    shelved = set(shelved or ())
    root = Path(learning_root)
    decks, mat = {}, {"new": 0, "learning": 0, "young": 0, "mature": 0}
    today = TODAY()
    horizon = {(date.today() + timedelta(days=i)).isoformat(): 0 for i in range(FORECAST_DAYS)}
    overdue = 0
    if not root.is_dir():
        return {"decks": [], "total": 0, "due": 0, "new": 0, "reviewed": 0, "maturity": mat,
                "forecast": _forecast(horizon, 0)}
    for f in sorted(root.rglob("*.md")):
        text = _read(f)
        if text is None or "#flashcards" not in text:
            continue
        full, top = _deck(text)
        if not top:
            continue
        for _, blines in _blocks(text)[0]:
            c = _card_from_block(blines)
            if not c:
                continue
            due = min((s["due"] for s in c["scheds"]), default=None)
            is_new = not c["hasSR"]
            d = decks.setdefault(top, {"deck": top, "total": 0, "due": 0, "new": 0, "img": 0, "subs": {}})
            d["total"] += 1
            if c["hasImage"]:
                d["img"] += 1
            # per-module (sub-deck) tallies so the deck can be studied unit-by-unit,
            # ordered basic -> complex (the NN- prefix sorts the modules for free).
            sub = d["subs"].setdefault(full, {"total": 0, "due": 0, "new": 0, "img": 0})
            sub["total"] += 1
            if c["hasImage"]:
                sub["img"] += 1   # per-module figure count -> images surface by subject, not a separate atlas
            if is_new:
                d["new"] += 1
                mat["new"] += 1
                sub["new"] += 1
            else:
                iv = min((s["interval"] for s in c["scheds"]), default=1)
                mat["learning" if iv < 7 else "young" if iv < 30 else "mature"] += 1
            # due = only already-studied cards whose delay has elapsed (NOT new ones)
            if not is_new and due is not None and due <= today:
                d["due"] += 1
                sub["due"] += 1
            # forecast: same population as `due` (studied cards only, shelved decks
            # excluded), bucketed by scheduled day instead of collapsed to "elapsed".
            if not is_new and due is not None and top not in shelved:
                if due < today:
                    overdue += 1
                elif due in horizon:
                    horizon[due] += 1
    rows = sorted(
        [{"deck": v["deck"], "total": v["total"], "due": v["due"], "new": v["new"],
          "img": v["img"], "subs": len(v["subs"]), "modules": _modules(v["deck"], v["subs"]),
          "shelved": v["deck"] in shelved} for v in decks.values()],
        key=lambda r: (r["shelved"], -r["due"]))   # shelved decks sink to the bottom
    total = sum(r["total"] for r in rows)
    return {"decks": rows, "total": total,
            "due": sum(r["due"] for r in rows if not r["shelved"]),   # shelved not due
            "new": mat["new"], "reviewed": total - mat["new"], "maturity": mat,
            "forecast": _forecast(horizon, overdue)}


def queue(learning_root, deck, limit=40, new_cap=NEW_PER_SESSION, shelved=None,
          module=None, ordered=False, image_only=False, shuffle=False):
    """Study queue for a deck. Three modes:"""
    shelved = set(shelved or ())
    root = Path(learning_root)
    today = TODAY()
    due_cards, new_cards = [], []
    for f in sorted(root.rglob("*.md")):
        text = _read(f)
        if text is None or "#flashcards" not in text:
            continue
        full, top = _deck(text)
        if not top or (deck and deck != "all" and top != deck):
            continue
        if deck == "all" and top in shelved:
            continue
        if module and full != module:   # restrict to one curriculum unit
            continue
        rel = str(f.relative_to(root.parents[1])).replace("\\", "/")  # vault-relative
        blocks, _ = _blocks(text)
        for ordn, (_, blines) in enumerate(blocks):
            c = _card_from_block(blines)
            if not c:
                continue
            if image_only and not c["hasImage"]:   # image-first study mode
                continue
            due = min((s["due"] for s in c["scheds"]), default=None)
            is_new = not c["hasSR"]
            card = {"path": rel, "ord": ordn, "deck": top, "sub": full,
                    "front": c["front"], "back": c["back"], "new": is_new,
                    "siblings": c["siblings"], "hasImage": c["hasImage"],
                    "image": c["image"], "hotspots": c["hotspots"], "_due": due or ""}
            if is_new:
                new_cards.append(card)
            elif due is not None and due <= today:
                due_cards.append(card)
    if shuffle:
        # interleaved practice: the whole due+new pool, random order across modules.
        pool = due_cards + new_cards
        random.shuffle(pool)
        out = pool[:limit]
    elif ordered:
        # basic -> complex: sub-deck (NN- prefix), then file path, then card ordinal.
        # due and new are interleaved by curriculum position, not segregated.
        out = sorted(due_cards + new_cards, key=lambda c: (c["sub"], c["path"], c["ord"]))[:limit]
    else:
        due_cards.sort(key=lambda c: (c["_due"], c["sub"]))   # most overdue first
        new_cards.sort(key=lambda c: c["sub"])
        out = due_cards[:limit]
        room = max(0, min(limit - len(out), new_cap))
        out += new_cards[:room]
    for c in out:
        c.pop("_due", None)
    return out


def atlas(learning_root, deck="all", shelved=None):
    shelved = set(shelved or ())
    root = Path(learning_root)
    out = []
    if not root.is_dir():
        return out
    for f in sorted(root.rglob("*.md")):
        text = _read(f)
        if text is None or "#flashcards" not in text:
            continue
        full, top = _deck(text)
        if not top or (deck and deck != "all" and top != deck):
            continue
        if deck == "all" and top in shelved:
            continue
        rel = str(f.relative_to(root.parents[1])).replace("\\", "/")
        for ordn, (_, blines) in enumerate(_blocks(text)[0]):
            c = _card_from_block(blines)
            if not c or not c["hasImage"]:
                continue
            out.append({"path": rel, "ord": ordn, "deck": top, "sub": full,
                        "front": c["front"], "back": c["back"], "image": c["image"],
                        "hotspots": c["hotspots"], "new": not c["hasSR"],
                        "siblings": c["siblings"]})
    out.sort(key=lambda c: (c["sub"], c["path"], c["ord"]))
    return out


def _within(p, root):
    try:
        Path(p).resolve().relative_to(Path(root).resolve())
        return True
    except (ValueError, OSError):
        return False


def asset_bytes(learning_root, card_rel, name):
    """(bytes, content-type) for the embed asset_path() resolves, or None."""
    hit = asset_path(learning_root, card_rel, name)
    if not hit:
        return None
    try:
        return hit[0].read_bytes(), hit[1]
    except OSError:
        return None


def asset_path(learning_root, card_rel, name):
    root = Path(learning_root).resolve()
    name = os.path.basename(str(name or "").split("|")[0].strip())
    if not name or Path(name).suffix.lower() not in _ASSET_CT:
        return None
    vault = root.parents[1]
    cands = []
    try:
        card_dir = (vault / card_rel).resolve().parent
        if _within(card_dir, root):
            cands += [card_dir / name, card_dir / "_media" / name]
            # subject folder = first path segment under the learning root
            rel = card_dir.relative_to(root)
            if rel.parts:
                subject = root / rel.parts[0]
                cands.append(subject / "_media" / name)
    except (ValueError, OSError):
        pass
    cands.append(root / "_media" / name)
    for p in cands:
        try:
            if p.is_file() and _within(p, root):
                return p, _ASSET_CT[p.suffix.lower()]
        except OSError:
            continue
    for p in root.rglob(name):          # fallback: basename match anywhere under Learning
        try:
            if p.is_file() and _within(p, root):
                return p, _ASSET_CT[p.suffix.lower()]
        except OSError:
            continue
    return None


def _sm2(response, interval, ease):
    """One SM-2 step (mirrors obsidian-spaced-repetition). response in
    {'again','hard','good','easy'}. Returns (interval_days, ease)."""
    if response == "easy":
        ease += 20
        interval = (interval * ease) / 100 * EASY_BONUS
    elif response == "good":
        interval = (interval * ease) / 100
    elif response == "hard":
        ease = max(130, ease - 20)
        interval = max(1, LAPSE_CHANGE * interval)
    else:  # again
        ease = max(130, ease - 20)
        interval = 1
    interval = min(round(interval), MAX_INTERVAL)
    return max(1, interval), ease


def _durable_write(p, text, attempts=6):
    tmp = p.with_name(f"{p.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    last = None
    for i in range(attempts):                       # preferred: write temp + atomic rename
        try:
            tmp.write_text(text, encoding="utf-8")
            os.replace(str(tmp), str(p))
            return None
        except OSError as e:
            last = e
            try:
                tmp.unlink()
            except OSError:
                pass
            time.sleep(0.1 * (i + 1))
    for i in range(attempts):                       # fallback: overwrite in place
        try:
            p.write_text(text, encoding="utf-8")
            return None
        except OSError as e:
            last = e
            time.sleep(0.1 * (i + 1))
    return f"write failed after {attempts}x2 retries: {last}"


_file_locks = {}
_file_locks_guard = threading.Lock()


def _lock_for(p):
    key = str(p)
    with _file_locks_guard:
        lk = _file_locks.get(key)
        if lk is None:
            lk = _file_locks[key] = threading.Lock()
        return lk


def review(learning_root, vault, rel_path, ordn, response):
    """Reschedule one card and write its SR comment. Surgical: only the card's
    comment line is touched (added or replaced); a .sr.bak is kept per file."""
    if not isinstance(rel_path, str) or not rel_path or "\x00" in rel_path:
        return None
    if isinstance(ordn, bool) or not isinstance(ordn, int) or ordn < 0:
        return None
    p = (Path(vault) / rel_path).resolve()
    if p.suffix.lower() != ".md" or not _within(p, learning_root):
        return None
    if not p.is_file():
        return None
    with _lock_for(p):
        text = _read(p)
        if text is None:
            return None
        blocks, lines = _blocks(text)
        if ordn >= len(blocks):
            return None
        start, blines = blocks[ordn]
        c = _card_from_block(blines)
        if not c:
            return None
        # compute new schedule for each sibling (advance them together)
        n = max(1, c["siblings"])
        new_scheds = []
        today = date.today()
        for i in range(n):
            prev = c["scheds"][i] if i < len(c["scheds"]) else {"interval": 1, "ease": BASE_EASE}
            iv, ease = _sm2(response, prev.get("interval", 1), prev.get("ease", BASE_EASE))
            due = (today + timedelta(days=iv)).isoformat()
            new_scheds.append((due, iv, ease))
        comment = "<!--SR:" + "".join(f"!{d},{i},{e}" for d, i, e in new_scheds) + "-->"
        # locate the block's last content line and whether a comment already follows
        block_end = start + len(blines) - 1
        if SR.search(lines[block_end]):
            lines[block_end] = comment
        else:
            lines.insert(block_end + 1, comment)
        # backup once per file (best-effort), then durable write
        bak = p.with_suffix(".md.sr.bak")
        try:
            bak.write_text(text, encoding="utf-8")
        except OSError:
            pass
        nl = "\r\n" if "\r\n" in text else "\n"
        err = _durable_write(p, nl.join(lines))
    if err:
        # Don't lose the review silently: surface a structured error so the
        # endpoint returns a clean 4xx/5xx instead of crashing the connection.
        return {"ok": False, "error": err}
    return {"ok": True, "next": new_scheds[0][0], "interval": new_scheds[0][1]}


def _read(p):
    try:
        return p.read_text(encoding="utf-8")
    except OSError:
        return None
