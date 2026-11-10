import re

CARD_RE = re.compile(r"^(\s*)- \[([ xX])\] (.*)$")
HEAD_RE = re.compile(r"^##\s+(.+?)\s*$")
DUE_RE = re.compile(r"@due[\(\{]([^)\}]+)[\)\}]")
PRIO_RE = re.compile(r"@(high|medium|low)\b", re.I)
TAG_RE = re.compile(r"#([A-Za-z0-9\-_/]+)")
EST_RE = re.compile(r"@est\(\s*([\d.]+)\s*(m|min|h|hr)?\s*\)", re.I)
META_RE = re.compile(r"(#[A-Za-z0-9\-_/]+|@\w+(?:[\(\{][^)\}]*[\)\}])?)")
WIKILINK_LABEL_RE = re.compile(r"\[\[[^\]|]*\|([^\]]+)\]\]")
WIKILINK_BARE_RE = re.compile(r"\[\[([^\]|]+)\]\]")


def _parse_est(body):
    """Parse @est(90m) / @est(2h) / @est(1.5h) into minutes, or None."""
    m = EST_RE.search(body)
    if not m:
        return None
    try:
        n = float(m.group(1))
    except ValueError:
        return None
    unit = (m.group(2) or "h").lower()
    return round(n) if unit.startswith("m") else round(n * 60)


def _nl(text):
    return "\r\n" if "\r\n" in text else "\n"


def _split(text):
    """Return (editable_lines, tail_lines). Tail = separator/Archive/settings."""
    lines = text.split("\n")
    lines = [ln.rstrip("\r") for ln in lines]
    cut = len(lines)
    for i, ln in enumerate(lines):
        if ln.strip() == "***" or ln.strip().startswith("%% kanban:settings"):
            cut = i
            break
    return lines[:cut], lines[cut:], lines


def _lanes(editable):
    """List of {name, start, end} over the editable region (end exclusive)."""
    lanes, cur = [], None
    for i, ln in enumerate(editable):
        h = HEAD_RE.match(ln)
        if h:
            if cur:
                cur["end"] = i
                lanes.append(cur)
            cur = {"name": h.group(1), "start": i, "end": len(editable)}
    if cur:
        lanes.append(cur)
    return lanes


def _card_indices(editable, lane):
    return [i for i in range(lane["start"] + 1, lane["end"]) if CARD_RE.match(editable[i])]


def _display(body):
    txt = WIKILINK_LABEL_RE.sub(r"\1", body)
    txt = WIKILINK_BARE_RE.sub(lambda m: m.group(1).rsplit("/", 1)[-1], txt)
    txt = META_RE.sub("", txt).strip()
    if txt.startswith("**") and txt.endswith("**") and len(txt) > 4:
        txt = txt[2:-2].strip()
    return txt


def get_board(text):
    editable, _, _ = _split(text)
    out = []
    for lane in _lanes(editable):
        cards = []
        for i in _card_indices(editable, lane):
            m = CARD_RE.match(editable[i])
            body = m.group(3)
            cards.append({
                "raw": editable[i],
                "text": _display(body),
                "done": m.group(2).lower() == "x",
                "tags": TAG_RE.findall(body),
                "priority": (PRIO_RE.search(body).group(1).lower() if PRIO_RE.search(body) else None),
                "due": (DUE_RE.search(body).group(1).strip() if DUE_RE.search(body) else None),
                "est": _parse_est(body),
            })
        out.append({"name": lane["name"], "cards": cards})
    return {"lanes": out}


def _rejoin(editable, tail, original):
    nl = _nl(original)
    return nl.join(editable + tail)


def _find(editable, raw, lane_name):
    """Absolute index of the line matching raw within the named lane, or None."""
    for lane in _lanes(editable):
        if lane["name"] != lane_name:
            continue
        for i in range(lane["start"] + 1, lane["end"]):
            if editable[i] == raw:
                return i
    return None


def move_card(text, raw, from_lane, to_lane, to_index):
    editable, tail, lines = _split(text)
    idx = _find(editable, raw, from_lane)
    if idx is None:
        return None
    line = editable.pop(idx)
    # recompute lanes after removal, then find the insertion point
    lane = next((l for l in _lanes(editable) if l["name"] == to_lane), None)
    if lane is None:
        return None
    cards = _card_indices(editable, lane)
    if not cards:
        ins = lane["start"] + 1
        # skip a single blank line right after the header, if present
        if ins < len(editable) and editable[ins].strip() == "":
            ins += 1
    elif to_index <= 0:
        ins = cards[0]
    elif to_index >= len(cards):
        ins = cards[-1] + 1
    else:
        ins = cards[to_index]
    editable.insert(ins, line)
    return _rejoin(editable, tail, text)


def _lane_name_at(editable, idx):
    """Name of the lane containing absolute editable index `idx`, or None."""
    for lane in _lanes(editable):
        if lane["start"] < idx < lane["end"]:
            return lane["name"]
    return None


def _lane_named(editable, name):
    """Exact lane name matching `name` case-insensitively, or None."""
    for lane in _lanes(editable):
        if lane["name"].strip().lower() == name.lower():
            return lane["name"]
    return None


def toggle_card(text, raw):
    """Flip a card's checkbox. Crossing a card off also moves it into the board's
    DONE lane (when one exists); unticking a card that sits in DONE brings it back
    to the TODAY lane. Boards without those lanes just get the flip."""
    editable, tail, lines = _split(text)
    for i, ln in enumerate(editable):
        if ln == raw:
            m = CARD_RE.match(ln)
            if not m:
                return None
            new_status = " " if m.group(2).lower() == "x" else "x"
            new_line = f"{m.group(1)}- [{new_status}] {m.group(3)}"
            editable[i] = new_line
            new_text = _rejoin(editable, tail, text)
            lane = _lane_name_at(editable, i)
            if lane:
                if new_status == "x" and lane.strip().lower() != "done":
                    done = _lane_named(editable, "done")
                    if done:
                        moved = move_card(new_text, new_line, lane, done, 10_000)
                        if moved is not None:
                            return moved
                elif new_status == " " and lane.strip().lower() == "done":
                    today = _lane_named(editable, "today")
                    if today:
                        moved = move_card(new_text, new_line, lane, today, 10_000)
                        if moved is not None:
                            return moved
            return new_text
    return None


def edit_card(text, raw, new_body):
    """Replace a card's body text (keeps the checkbox state and indent)."""
    editable, tail, _ = _split(text)
    for i, ln in enumerate(editable):
        if ln == raw:
            m = CARD_RE.match(ln)
            if not m:
                return None
            editable[i] = f"{m.group(1)}- [{m.group(2)}] {new_body.strip()}"
            return _rejoin(editable, tail, text)
    return None


def archive_card(text, raw):
    """Move a card out of its lane into the board's Archive section. Non-destructive:
    nothing is deleted, the card just leaves the active lanes. Returns None if the
    card isn't found or the board has no Archive section."""
    nl = _nl(text)
    lines = [ln.rstrip("\r") for ln in text.split("\n")]
    cut = len(lines)
    for i, ln in enumerate(lines):
        if ln.strip() == "***" or ln.strip().startswith("%% kanban:settings"):
            cut = i
            break
    idx = next((i for i in range(cut) if lines[i] == raw), None)
    if idx is None:
        return None
    line = lines.pop(idx)
    arch = next((i for i, ln in enumerate(lines)
                 if HEAD_RE.match(ln) and HEAD_RE.match(ln).group(1).strip().lower() == "archive"), None)
    if arch is None:
        return None
    ins = arch + 1
    if ins < len(lines) and lines[ins].strip() == "":
        ins += 1
    lines.insert(ins, line)
    return nl.join(lines)


def archive_done(text, lane_name=None):
    nl = _nl(text)
    lines = [ln.rstrip("\r") for ln in text.split("\n")]
    cut = len(lines)
    for i, ln in enumerate(lines):
        if ln.strip() == "***" or ln.strip().startswith("%% kanban:settings"):
            cut = i
            break
    # walk the editable region, tracking the current lane, collecting done cards
    cur_lane, done_idx = None, []
    for i in range(cut):
        h = HEAD_RE.match(lines[i])
        if h:
            cur_lane = h.group(1).strip()
            continue
        m = CARD_RE.match(lines[i])
        if m and m.group(2).lower() == "x" and (lane_name is None or cur_lane == lane_name):
            done_idx.append(i)
    if not done_idx:
        return None
    has_arch = any(HEAD_RE.match(ln) and HEAD_RE.match(ln).group(1).strip().lower() == "archive"
                   for ln in lines)
    if not has_arch:
        return None
    moved = [lines[i] for i in done_idx]
    for i in sorted(done_idx, reverse=True):
        lines.pop(i)
    # archive header shifts down after the removals — re-find it
    arch = next(i for i, ln in enumerate(lines)
                if HEAD_RE.match(ln) and HEAD_RE.match(ln).group(1).strip().lower() == "archive")
    ins = arch + 1
    if ins < len(lines) and lines[ins].strip() == "":
        ins += 1
    lines[ins:ins] = moved
    return nl.join(lines)


def archive_lane(text, lane_name):
    if not lane_name:
        return None
    nl = _nl(text)
    lines = [ln.rstrip("\r") for ln in text.split("\n")]
    cut = len(lines)
    for i, ln in enumerate(lines):
        if ln.strip() == "***" or ln.strip().startswith("%% kanban:settings"):
            cut = i
            break
    cur_lane, move_idx = None, []
    for i in range(cut):
        h = HEAD_RE.match(lines[i])
        if h:
            cur_lane = h.group(1).strip()
            continue
        if cur_lane == lane_name and CARD_RE.match(lines[i]):
            move_idx.append(i)
    if not move_idx:
        return None
    has_arch = any(HEAD_RE.match(ln) and HEAD_RE.match(ln).group(1).strip().lower() == "archive"
                   for ln in lines)
    if not has_arch:
        return None
    moved = [lines[i] for i in move_idx]
    for i in sorted(move_idx, reverse=True):
        lines.pop(i)
    arch = next(i for i, ln in enumerate(lines)
                if HEAD_RE.match(ln) and HEAD_RE.match(ln).group(1).strip().lower() == "archive")
    ins = arch + 1
    if ins < len(lines) and lines[ins].strip() == "":
        ins += 1
    lines[ins:ins] = moved
    return nl.join(lines)


def delete_card(text, raw):
    """Permanently remove a card line from the active lanes (NOT moved to Archive).
    write_board keeps a last-good backup of the whole file, so it's recoverable.
    Returns the new text, or None if the card isn't found."""
    editable, tail, _ = _split(text)
    for i, ln in enumerate(editable):
        if ln == raw and CARD_RE.match(ln):
            editable.pop(i)
            return _rejoin(editable, tail, text)
    return None


def add_card(text, lane_name, card_text):
    editable, tail, lines = _split(text)
    lane = next((l for l in _lanes(editable) if l["name"] == lane_name), None)
    if lane is None:
        return None
    cards = _card_indices(editable, lane)
    line = f"- [ ] {card_text.strip()}"
    if cards:
        editable.insert(cards[-1] + 1, line)
    else:
        ins = lane["start"] + 1
        if ins < len(editable) and editable[ins].strip() == "":
            ins += 1
        editable.insert(ins, line)
    return _rejoin(editable, tail, text)
