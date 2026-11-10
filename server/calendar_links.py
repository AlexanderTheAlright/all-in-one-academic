#!/usr/bin/env python3
"""Join links on calendar events: validate, attach, find, extract."""
from __future__ import annotations
import settings

import argparse
import json
import os
import re
import sys
import tempfile
from pathlib import Path
from urllib.parse import urlsplit

EVENTS_REL = "Preparation/Calendar/events"
MAX_LINK = 2000
# frontmatter is written unquoted-safe: anything that could break out of a YAML
# scalar, start a comment, or smuggle a second key is refused rather than escaped
_FORBIDDEN = set('"\'`\\<>{}[]|^')


class LinkError(ValueError):
    """A link, path or event that this module refuses to write."""


def vault_root(vault: str | os.PathLike | None = None) -> Path:
    if vault:
        return Path(vault).expanduser().resolve()
    env = os.environ.get("AIOA_VAULT")
    if env:
        return Path(env).expanduser().resolve()
    return (settings.VAULT).resolve()


# ---------------------------------------------------------------- validation

def validate_link(url: str | None) -> str | None:
    """Return a clean http(s) URL, or None for an empty value. Raises LinkError."""
    if url is None:
        return None
    s = str(url).strip()
    if not s:
        return None
    if len(s) > MAX_LINK:
        raise LinkError(f"link longer than {MAX_LINK} characters")
    for ch in s:
        if ch.isspace() or ord(ch) < 0x20 or ord(ch) == 0x7F:
            raise LinkError("link contains whitespace or a control character")
        if ch in _FORBIDDEN:
            raise LinkError(f"link contains a forbidden character: {ch!r}")
    parts = urlsplit(s)
    if parts.scheme.lower() not in ("http", "https"):
        raise LinkError("link must be http or https")
    if not parts.netloc or "@" in parts.netloc:
        raise LinkError("link needs a plain host and no credentials")
    return s


def event_path(rel_or_abs: str, vault: str | os.PathLike | None = None) -> Path:
    """Resolve a path and confine it to the events tree. Raises LinkError."""
    root = vault_root(vault)
    events = (root / EVENTS_REL).resolve()
    p = Path(rel_or_abs).expanduser()
    if not p.is_absolute():
        p = root / p
    try:
        p = p.resolve()
    except OSError as exc:  # pragma: no cover - resolve rarely raises here
        raise LinkError(f"cannot resolve {rel_or_abs}") from exc
    if p != events and events not in p.parents:
        raise LinkError("path is outside the calendar events tree")
    if p.suffix.lower() != ".md":
        raise LinkError("event files are .md")
    if not p.is_file():
        raise LinkError(f"no event file at {p}")
    return p


# ---------------------------------------------------------------- note surgery

def split_frontmatter(text: str) -> tuple[list[str], str]:
    """Return (frontmatter lines without the fences, body). No fences -> ([], text)."""
    if not text.startswith("---"):
        return [], text
    lines = text.split("\n")
    if lines[0].strip() != "---":
        return [], text
    for i in range(1, len(lines)):
        if lines[i].strip() in ("---", "..."):
            return lines[1:i], "\n".join(lines[i + 1:])
    return [], text


def _fm_get(fm: list[str], key: str) -> str | None:
    pat = re.compile(rf"^{re.escape(key)}\s*:\s*(.*)$")
    for line in fm:
        m = pat.match(line)
        if m:
            return m.group(1).strip()
    return None


def _fm_set(fm: list[str], key: str, value: str | None) -> list[str]:
    """Set or drop one key, keeping every other line byte-identical."""
    pat = re.compile(rf"^{re.escape(key)}\s*:")
    out: list[str] = []
    placed = False
    for line in fm:
        if pat.match(line):
            if value is not None and not placed:
                out.append(f"{key}: {value}")
                placed = True
            continue  # a duplicate key, or a cleared one, is dropped
        out.append(line)
    if value is not None and not placed:
        out.append(f"{key}: {value}")
    return out


_JOIN_LINE = re.compile(r"^\s*Join:\s*\S*\s*$")


def apply_join_line(body: str, url: str | None) -> str:
    """Keep exactly one managed `Join: <url>` line; touch no other body text."""
    if url and not body.strip():
        return f"Join: {url}\n"
    lines = body.split("\n")
    kept: list[str] = []
    seen = False
    for line in lines:
        if _JOIN_LINE.match(line):
            if url is not None and not seen:
                kept.append(f"Join: {url}")
                seen = True
            continue
        kept.append(line)
    if url is not None and not seen:
        # first line of the body, with one blank line under it
        lead = 0
        while lead < len(kept) and not kept[lead].strip():
            lead += 1
        kept = kept[:lead] + [f"Join: {url}", ""] + kept[lead:]
    elif url is None:
        # a stripped line can leave a doubled blank at the top; collapse just that
        while len(kept) > 1 and not kept[0].strip() and not kept[1].strip():
            kept = kept[1:]
    return "\n".join(kept)


def _atomic_write(path: Path, text: str) -> None:
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".link-", suffix=".md")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(text)
        try:
            os.chmod(tmp, path.stat().st_mode & 0o7777)
        except OSError:
            pass
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def set_event_link(
    path: str,
    link: str | None,
    *,
    series: bool = False,
    vault: str | os.PathLike | None = None,
) -> dict:
    """Attach (or clear) an event's join link. Returns {path, link, mode, changed}."""
    target = event_path(path, vault)
    url = validate_link(link)
    raw = target.read_text(encoding="utf-8")
    fm, body = split_frontmatter(raw)
    if not fm:
        raise LinkError("event file has no frontmatter")
    if _fm_get(fm, "rrule") and not series:
        raise LinkError("recurring event: pass --series to link the whole series")

    fm2 = _fm_set(fm, "link", f'"{url}"' if url else None)
    if url:
        fm2 = _fm_set(fm2, "mode", "call")
    elif (_fm_get(fm2, "mode") or "").strip() == "call":
        fm2 = _fm_set(fm2, "mode", None)
    body2 = apply_join_line(body, url)

    out = "---\n" + "\n".join(fm2) + "\n---\n" + body2
    if out == raw:
        return {"path": str(target), "link": url, "mode": _fm_get(fm2, "mode"), "changed": False}
    _atomic_write(target, out)
    return {"path": str(target), "link": url, "mode": _fm_get(fm2, "mode"), "changed": True}


# ---------------------------------------------------------------- finding

def _read_event(path: Path) -> dict | None:
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError:
        return None
    fm, _body = split_frontmatter(raw)
    if not fm:
        return None
    get = lambda k: _fm_get(fm, k)  # noqa: E731
    return {
        "path": str(path),
        "title": (get("title") or path.stem).strip().strip('"'),
        "date": (get("date") or "").strip().strip('"'),
        "startTime": (get("startTime") or "").strip().strip('"'),
        "endTime": (get("endTime") or "").strip().strip('"'),
        "category": path.parent.name,
        "link": (get("link") or "").strip().strip('"') or None,
        "mode": (get("mode") or "").strip().strip('"') or None,
        "recurring": bool(get("rrule")),
    }


def _minutes(hhmm: str) -> int | None:
    m = re.match(r"^(\d{1,2}):(\d{2})", hhmm.strip())
    if not m:
        return None
    return int(m.group(1)) * 60 + int(m.group(2))


def find_events(
    date: str,
    time: str | None = None,
    q: str | None = None,
    window: int = 30,
    vault: str | os.PathLike | None = None,
) -> list[dict]:
    """Events on a date, optionally within `window` minutes of a time and matching a token."""
    root = vault_root(vault) / EVENTS_REL
    want = _minutes(time) if time else None
    needle = (q or "").strip().lower()
    hits: list[dict] = []
    for path in sorted(root.rglob("*.md")):
        ev = _read_event(path)
        if not ev or ev["date"] != date or ev["recurring"]:
            continue
        if want is not None:
            got = _minutes(ev["startTime"]) if ev["startTime"] else None
            if got is None or abs(got - want) > window:
                continue
        if needle:
            hay = f"{ev['title']} {Path(ev['path']).stem}".lower()
            if not all(tok in hay for tok in needle.split()):
                continue
        hits.append(ev)
    return hits


# ---------------------------------------------------------------- invite text

_URL_RE = re.compile(r"https?://[^\s<>\"')\]]+")
_JOIN_HOSTS = (
    (re.compile(r"zoom\.us/j/|zoom\.us/w/|zoom\.us/my/", re.I), "zoom"),
    (re.compile(r"teams\.microsoft\.com/l/meetup-join|teams\.live\.com/meet", re.I), "teams"),
    (re.compile(r"meet\.google\.com/", re.I), "meet"),
    (re.compile(r"webex\.com/(meet|join|\S*/j\.php)", re.I), "webex"),
    (re.compile(r"whereby\.com/|bluejeans\.com/|gotomeet(ing)?\.(me|com)/", re.I), "other"),
)
_ID_RE = re.compile(r"\b(?:meeting|conference|webinar)\s*(?:id|number)\s*[:#]?\s*([\d\s\-]{6,})", re.I)
_PASS_RE = re.compile(r"\b(?:passcode|password|pass code|pin)\s*[:#]?\s*([^\s,;]{3,64})", re.I)


def extract_invite(text: str) -> dict:
    """Pull join URLs plus meeting id / passcode out of pasted invite text."""
    found: list[dict] = []
    seen: set[str] = set()
    for raw in _URL_RE.findall(text or ""):
        url = raw.rstrip(".,;:>)”’")
        if url in seen:
            continue
        kind = None
        for pat, name in _JOIN_HOSTS:
            if pat.search(url):
                kind = name
                break
        try:
            clean = validate_link(url)
        except LinkError:
            continue
        if not clean:
            continue
        seen.add(url)
        found.append({"url": clean, "kind": kind or "link"})
    join = [f for f in found if f["kind"] != "link"]
    mid = _ID_RE.search(text or "")
    pwd = _PASS_RE.search(text or "")
    return {
        "links": found,
        "join": join,
        "primary": (join[0]["url"] if join else None),
        "meetingId": (" ".join(mid.group(1).split()) if mid else None),
        "passcode": (pwd.group(1) if pwd else None),
    }


# ---------------------------------------------------------------- cli

def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="calendar_links.py", description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)

    a = sub.add_parser("attach", help="put a join link on one existing event")
    a.add_argument("--path", required=True, help="vault-relative path to the event .md")
    a.add_argument("--link", default=None, help="the join URL (omit with --clear)")
    a.add_argument("--clear", action="store_true", help="strip the link instead")
    a.add_argument("--series", action="store_true", help="allow a recurring (rrule) event")
    a.add_argument("--vault", default=None)

    f = sub.add_parser("find", help="print matching event paths as JSON")
    f.add_argument("--date", required=True)
    f.add_argument("--time", default=None)
    f.add_argument("--q", default=None)
    f.add_argument("--window", type=int, default=30)
    f.add_argument("--vault", default=None)

    e = sub.add_parser("extract", help="read invite text on stdin, print JSON")
    e.add_argument("--file", default=None, help="read this file instead of stdin")

    ns = ap.parse_args(argv)
    try:
        if ns.cmd == "attach":
            link = None if ns.clear else ns.link
            if not ns.clear and not link:
                print("attach needs --link or --clear", file=sys.stderr)
                return 2
            res = set_event_link(ns.path, link, series=ns.series, vault=ns.vault)
            print(json.dumps(res, indent=2))
            return 0
        if ns.cmd == "find":
            hits = find_events(ns.date, ns.time, ns.q, ns.window, ns.vault)
            print(json.dumps(hits, indent=2))
            return 0
        text = Path(ns.file).read_text(encoding="utf-8") if ns.file else sys.stdin.read()
        print(json.dumps(extract_invite(text), indent=2))
        return 0
    except LinkError as exc:
        print(f"refused: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
