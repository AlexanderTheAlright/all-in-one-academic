#!/usr/bin/env python3
import fcntl
import hashlib
import json
import math
import os
import re
import secrets
import stat
import tempfile
import threading
import time
import unicodedata
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from itertools import combinations
from pathlib import Path
from urllib.parse import quote

import explore
import settings

SET_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
CODER_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$")
REVIEW_ID_RE = re.compile(r"^r-[0-9a-f]{12}$")
CTRL_RE = re.compile(r"[\x00-\x1f\x7f]")
CONFIDENCE = ("high", "medium", "low")
VERDICTS = ("agree", "disagree", "unsure")
KINDS = ("agent", "model", "human")
FILTERS = ("", "todo", "coded", "disagree", "reviewed", "noted", "revisit")
# newline and tab are text; every other C0 character and DEL are refused in stored text
C0_RE = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")
DRAFT_NAME = "codebook_draft.json"
LOG_NAME = "codebook_log.json"
CAP_DRAFT = 512 * 1024
LOG_MAX = 5000
LOG_SHOWN = 200
LOG_MERGE_S = 600
OPS_MAX = 50
LIMITS = {"label": 60, "display": 80, "short": 300, "definition": 4000, "list_items": 40,
          "list_item": 8000, "examples": 20, "example_text": 2000, "example_reasoning": 600,
          "codes": 60, "why": 600, "version": 40}
LINE_FIELDS = ("display", "short")
LIST_FIELDS = ("decision_rules", "inclusion_criteria", "exclusion_criteria", "confusable_with")
EXAMPLE_FIELDS = ("positive_examples", "negative_examples")
# test_coding.py names a promote step here to see the rollback; nothing else sets it
_FAULT = None
_FAULT_EXC = OSError
CONTEXT_ROLES = ("title", "opener", "parent", "parent_is_opener", "kind")
CONTEXT_MAX = 20000
HUMAN = "owner"
SETS_DIR = "replication/qualitative/sets"
CODING_DIR = "replication/qualitative/coding"

CAP_MANIFEST = 256 * 1024
CAP_CODEBOOK = 4 * 1024 * 1024
CAP_DATA = 64 * 1024 * 1024
NOTE_MAX = 2000
EVIDENCE_MAX = 4000
REVIEW_NOTE_MAX = 1000
PREVIEW = 140
PAGE_DEFAULT = 300
PAGE_MAX = 1000

MEDIA_TYPES = {
    "image": {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
              "webp": "image/webp", "gif": "image/gif"},
    "audio": {"mp3": "audio/mpeg", "wav": "audio/wav", "m4a": "audio/mp4", "ogg": "audio/ogg",
              "oga": "audio/ogg", "opus": "audio/ogg", "flac": "audio/flac"},
    "video": {"mp4": "video/mp4", "m4v": "video/mp4", "webm": "video/webm",
              "mov": "video/quicktime"},
}
MEDIA_CAPS = {"image": 64 * 1024 * 1024, "audio": 256 * 1024 * 1024, "video": 2 * 1024 ** 3}
MEDIA_PROXY_MIN = 8 * 1024 * 1024
PREVIEW_MAX_PIXELS = 40_000_000
ANCHOR_MAX_S = 6 * 3600

_HOME = str(Path.home())


class Refusal(Exception):
    def __init__(self, code, msg, media=""):
        super().__init__(msg)
        self.code = code
        self.msg = msg
        self.media = media


def _scrub(msg):
    return str(msg).replace(_HOME, "~")[:240]


def _plain(e):
    """An error in words, with no path beyond a file's own name."""
    if isinstance(e, Refusal):
        return e.msg
    if isinstance(e, OSError):
        what = e.strerror or (e.args[0] if e.args and isinstance(e.args[0], str) else "a file could not be written")
        return "%s%s" % (what, ": %s" % Path(str(e.filename)).name if e.filename else "")
    if isinstance(e, ValueError):
        return "a file is not valid JSON"
    return "a fault in the server (%s)" % type(e).__name__


def _clean(name):
    return CTRL_RE.sub("?", str(name))[:64]


# -- paths ----------------------------------------------------------------------
def project_root(vault, slug):
    slug = slug.strip() if isinstance(slug, str) else ""
    if not slug or len(slug) > 120 or CTRL_RE.search(slug):
        raise Refusal(400, "project is required")
    root = explore.project_root(vault, slug)
    if root is None:
        raise Refusal(404, "unknown project")
    real = Path(root).resolve()
    if Path(vault).resolve() not in real.parents:
        raise Refusal(404, "unknown project")
    return real


def project_slug(root):
    name = root.name
    return explore._kebab(settings.strip_prefix(name))


def confine(root, rel, cap, what):
    """(real path, stat) for a manifest path, or a Refusal that names only `rel`."""
    if not isinstance(rel, str) or not rel.strip():
        raise Refusal(400, "%s: no path in the manifest" % what)
    rel = rel.strip()
    if len(rel) > 400 or CTRL_RE.search(rel) or rel.startswith(("/", "~")) or "\\" in rel:
        raise Refusal(400, "%s: the path must be relative to the project" % what)
    parts = rel.split("/")
    if any(p in ("", ".", "..") or p.startswith(".") for p in parts):
        raise Refusal(400, "%s: no dot segments" % what)
    try:
        real = (root / rel).resolve(strict=True)
    except (OSError, RuntimeError):
        raise Refusal(404, "%s: %s is missing" % (what, rel))
    if root not in real.parents:
        raise Refusal(400, "%s: %s leaves the project" % (what, rel))
    if any(p.startswith(".") for p in real.relative_to(root).parts):
        raise Refusal(400, "%s: no dot segments" % what)
    st = real.stat()
    if not stat.S_ISREG(st.st_mode):
        raise Refusal(400, "%s: %s is not a file" % (what, rel))
    if st.st_size == 0 or st.st_size > cap:
        raise Refusal(400, "%s: %s is empty or too large" % (what, rel))
    return real, st


def _write_target(root, set_id, name, sub="", plain=True):
    """coding/<set>/<name>, created inside the project; never a symlink."""
    d = root / CODING_DIR / set_id
    if sub:
        d = d / sub
    have = d
    while not have.exists():
        have = have.parent
    have = have.resolve()
    if have != root and root not in have.parents:
        raise Refusal(400, "the coding folder leaves the project")
    d.mkdir(parents=True, exist_ok=True)
    real = d.resolve()
    if root not in real.parents or any(p.startswith(".") for p in real.relative_to(root).parts):
        raise Refusal(400, "the coding folder leaves the project")
    if real != d:
        raise Refusal(400, "the coding folder is a link")
    target = real / name
    try:
        st = os.lstat(target)
    except FileNotFoundError:
        return target
    if plain and not stat.S_ISREG(st.st_mode):
        raise Refusal(400, "%s is not a plain file" % name)
    return target


def _stamp(st):
    return "%x-%x" % (st.st_mtime_ns, st.st_size) if st else "0"


def _stat(p):
    try:
        return p.stat()
    except OSError:
        return None


# -- cached reads ---------------------------------------------------------------
_CACHE = {}
_CACHE_LOCK = threading.Lock()
_CACHE_MAX = 48


def _cached(key, build):
    with _CACHE_LOCK:
        hit = _CACHE.get(key)
    if hit is not None:
        return hit
    val = build()
    with _CACHE_LOCK:
        if len(_CACHE) >= _CACHE_MAX:
            _CACHE.pop(next(iter(_CACHE)))
        _CACHE[key] = val
    return val


def _json_file(real, st):
    def build():
        with open(real, "r", encoding="utf-8") as fh:
            return json.load(fh)
    try:
        return _cached(("json", str(real), st.st_mtime_ns, st.st_size), build)
    except ValueError:
        raise Refusal(400, "%s is not valid JSON" % real.name)


def _strs(v):
    if isinstance(v, str):
        return [v] if v.strip() else []
    return [str(x) for x in v if isinstance(x, (str, int, float)) and str(x).strip()] \
        if isinstance(v, list) else []


def _examples(v):
    out = []
    for x in v if isinstance(v, list) else []:
        if isinstance(x, dict):
            out.append({"text": str(x.get("text") or ""), "reasoning": str(x.get("reasoning") or "")})
        elif isinstance(x, str):
            out.append({"text": x, "reasoning": ""})
    return out


def load_manifest(root, set_id):
    if not isinstance(set_id, str) or not SET_RE.match(set_id):
        raise Refusal(400, "bad set id")
    real, st = confine(root, "%s/%s.json" % (SETS_DIR, set_id), CAP_MANIFEST, "set")
    m = _json_file(real, st)
    if not isinstance(m, dict) or m.get("id") != set_id:
        raise Refusal(400, "the manifest's id is not %s" % set_id)
    human = m.get("human", HUMAN)
    if human != HUMAN:
        raise Refusal(400, "the human coder is %s" % HUMAN)
    coders = {}
    if not isinstance(m.get("coders") or {}, dict):
        raise Refusal(400, "coders must be an object")
    for name, c in (m.get("coders") or {}).items():
        if not CODER_RE.match(str(name)) or name == HUMAN or not isinstance(c, dict):
            raise Refusal(400, "bad coder in the manifest: %s" % str(name)[:40])
        kind = c.get("kind", "agent")
        coders[name] = {"path": c.get("path"), "kind": kind if kind in KINDS else "agent",
                        "codebook_version": str(c.get("codebook_version") or "")}
    derived = m.get("derived") or {}
    if not isinstance(derived, dict):
        raise Refusal(400, "derived must be an object")
    hidden = set(_strs(m.get("hidden_fields")))
    id_field = str(m.get("id_field") or "id")
    text_field = str(m.get("text_field") or "text")
    if id_field in hidden or text_field in hidden:
        raise Refusal(400, "the id and text fields cannot be hidden")
    raw_ctx = m.get("context_fields") or {}
    if not isinstance(raw_ctx, dict):
        raise Refusal(400, "context_fields must be an object")
    context = {}
    for role in CONTEXT_ROLES:
        f = raw_ctx.get(role)
        if not isinstance(f, str) or not f.strip():
            continue
        f = f.strip()
        if f in hidden or f in (id_field, text_field):
            raise Refusal(400, "context field %s is hidden or the id/text" % f[:40])
        context[role] = f
    media = _media_manifest(m, set_id, hidden, {id_field, text_field} | set(context.values()))
    drop = (id_field, text_field, media["field"] if media else None)
    lock, hist = m.get("codebook_locked"), m.get("codebook_history")
    # fails closed: only false, null, 0 and a blank string leave the codebook open to promotion
    free = (lock is None or lock is False or (type(lock) in (int, float) and lock == 0)
            or (isinstance(lock, str) and not lock.strip()))
    return {
        "locked": not free,
        "lock_reason": "" if free else (_scrub(lock.strip()) if isinstance(lock, str) else "locked"),
        "history": [h for h in hist if isinstance(h, dict)] if isinstance(hist, list) else [],
        "id": set_id, "title": str(m.get("title") or set_id)[:200],
        "codebook": m.get("codebook"), "codebook_version": str(m.get("codebook_version") or ""),
        "codebook_note": str(m.get("codebook_note") or "")[:400],
        "units": m.get("units"), "id_field": id_field, "text_field": text_field,
        "meta_fields": [f for f in _strs(m.get("meta_fields")) if f not in hidden
                        and f not in drop and f not in context.values()],
        "context_fields": context, "media": media,
        "choice": "single" if m.get("choice") == "single" else "multi",
        # the per-code confidence chips are shown only when the manifest asks for them
        "confidence": m.get("confidence") is True,
        "hidden_fields": sorted(hidden),
        "derived": derived, "blind": m.get("blind", True) is not False,
        "coders": coders, "stamp": _stamp(st),
    }


def proxy_dir_rel(set_id):
    return "%s/%s/proxy" % (CODING_DIR, set_id)


def _media_manifest(m, set_id, hidden, taken):
    f = m.get("media_field")
    if f in (None, ""):
        return None
    kind = m.get("media_kind")
    if not isinstance(f, str) or not isinstance(kind, str) or kind not in MEDIA_TYPES:
        raise Refusal(400, "media_kind is image, audio or video")
    f = f.strip()
    if f in hidden:
        raise Refusal(400, "the media field cannot be hidden")
    if f in taken:
        raise Refusal(400, "the media field is already the id, the text or a context field")
    sf, ef = m.get("media_start_field") or "", m.get("media_end_field") or ""
    if not isinstance(sf, str) or not isinstance(ef, str) or bool(sf) != bool(ef):
        raise Refusal(400, "media_start_field and media_end_field go together")
    if sf and (sf == ef or {sf, ef} & (taken | {f})):
        raise Refusal(400, "the media start and end fields are two fields of their own")
    proxy = m.get("media_proxy_dir") or ""
    # the folder is fixed by the set id; the manifest only says it is in use
    if proxy and (kind != "video" or proxy != proxy_dir_rel(set_id)):
        raise Refusal(400, "media_proxy_dir is %s, on a video set" % proxy_dir_rel(set_id))
    return {"field": f, "kind": kind, "start_field": sf, "end_field": ef, "proxy": bool(proxy),
            "autoplay": kind != "image" and m.get("media_autoplay", True) is not False}


def load_codebook(root, man):
    real, st = confine(root, man["codebook"], CAP_CODEBOOK, "codebook")
    raw = _json_file(real, st)
    items = raw.get("codes") if isinstance(raw, dict) else raw
    if not isinstance(items, list) or not items:
        raise Refusal(400, "the codebook has no codes")
    codes, seen = [], set()
    for c in items:
        if not isinstance(c, dict):
            continue
        label = str(c.get("label") or c.get("code") or c.get("name") or "").strip()
        if not label or label in seen or len(label) > 60 or CTRL_RE.search(label):
            continue
        seen.add(label)
        codes.append({
            "label": label, "definition": str(c.get("definition") or ""),
            # the human label and the one-line definition the option rows show
            "display": str(c.get("display") or "").strip()[:80],
            "short": " ".join(str(c.get("short") or "").split())[:300],
            "decision_rules": _strs(c.get("decision_rules")),
            "inclusion_criteria": _strs(c.get("inclusion_criteria")),
            "exclusion_criteria": _strs(c.get("exclusion_criteria")),
            "positive_examples": _examples(c.get("positive_examples")),
            "negative_examples": _examples(c.get("negative_examples")),
            "confusable_with": _strs(c.get("confusable_with")),
            "derived": bool(c.get("derived")) or label in man["derived"],
        })
    if not codes:
        raise Refusal(400, "the codebook has no codes")
    base = [c["label"] for c in codes if not c["derived"]]
    for c in codes:
        c["none_of"] = []
        if c["derived"]:
            rule = man["derived"].get(c["label"]) or {}
            of = rule.get("none_of", "*") if isinstance(rule, dict) else "*"
            c["none_of"] = base if of == "*" else [x for x in _strs(of) if x in base]
    return codes, _stamp(st)


def load_units(root, man):
    real, st = confine(root, man["units"], CAP_DATA, "units")
    idf, txf, meta = man["id_field"], man["text_field"], tuple(man["meta_fields"])
    cfields = tuple(sorted(man.get("context_fields", {}).items()))
    med = man.get("media")
    mfields = (med["field"], med["start_field"], med["end_field"]) if med else None

    def build():
        with open(real, "r", encoding="utf-8") as fh:
            if real.suffix == ".json":
                rows = json.load(fh)
            else:
                rows = [json.loads(line) for line in fh if line.strip()]
        ids, by, text, lower, metas, ctxs, media = [], {}, [], [], [], [], []
        for r in rows if isinstance(rows, list) else []:
            if not isinstance(r, dict) or r.get(idf) in (None, ""):
                continue
            uid = str(r[idf])
            if uid in by:
                raise Refusal(400, "the units file repeats id %s" % uid[:60])
            t = str(r.get(txf) or "")
            by[uid] = len(ids)
            ids.append(uid)
            text.append(t)
            lower.append((uid + " " + t).lower())
            # hidden fields are never kept, only the named meta ones
            metas.append({f: r.get(f) for f in meta if f in r})
            ctxs.append(_context(r, cfields))
            if mfields:
                # the start and end fields are read even when hidden: hidden keeps them off the chips
                media.append({"path": r.get(mfields[0]),
                              "start": r.get(mfields[1]) if mfields[1] else None,
                              "end": r.get(mfields[2]) if mfields[2] else None})
        return {"ids": ids, "by": by, "text": text, "lower": lower, "meta": metas, "ctx": ctxs,
                "media": media}

    try:
        u = _cached(("units", str(real), st.st_mtime_ns, st.st_size, idf, txf, meta, cfields, mfields), build)
    except ValueError:
        raise Refusal(400, "the units file is not valid JSON lines")
    if not u["ids"]:
        raise Refusal(400, "the units file has no units")
    return u, _stamp(st)


def _context(r, cfields):
    """A unit's context, by role; a field the row lacks (or leaves empty) is simply absent."""
    out = {}
    for role, f in cfields:
        v = r.get(f)
        if v is None or v == "":
            continue
        if role == "parent_is_opener":
            out[role] = v is True or str(v).strip().lower() in ("true", "1", "yes")
        else:
            out[role] = str(v)[:CONTEXT_MAX]
    return out


def _index_pass(rows):
    by, codes = {}, set()
    for r in rows if isinstance(rows, list) else []:
        if not isinstance(r, dict) or not r.get("unit_id"):
            continue
        by[str(r["unit_id"])] = r
        codes.update(str(x) for x in r.get("codes_applied") or [])
        codes.update(str(d.get("code")) for d in r.get("code_details") or []
                     if isinstance(d, dict) and d.get("code"))
    return {"by": by, "codes": codes}


def load_coder(root, name, c):
    real, st = confine(root, c["path"], CAP_DATA, "coder " + name)
    try:
        return _cached(("coder", str(real), st.st_mtime_ns, st.st_size),
                       lambda: _index_pass(_json_file(real, st))), _stamp(st)
    except Refusal:
        raise
    except (ValueError, TypeError):
        raise Refusal(400, "coder %s is not a coding pass" % name)


def _read_list(p):
    """The live file, uncached: every write reads fresh under the lock."""
    try:
        with open(p, "r", encoding="utf-8") as fh:
            v = json.load(fh)
    except FileNotFoundError:
        return []
    except ValueError:
        raise Refusal(500, "%s is not valid JSON; not overwriting it" % p.name)
    if not isinstance(v, list):
        raise Refusal(500, "%s is not a list; not overwriting it" % p.name)
    return v


def _live(p):
    st = _stat(p)
    if st is None:
        return [], "0"
    return _cached(("live", str(p), st.st_mtime_ns, st.st_size), lambda: _read_list(p)), _stamp(st)


# -- media ----------------------------------------------------------------------
def _ext(name):
    return name.rsplit(".", 1)[-1].lower() if "." in name else ""


def media_source(root, kind, rel):
    """(real path, stat, mime) for the file a unit names, or a Refusal whose .media says why."""
    if not isinstance(rel, str) or not rel.strip():
        raise Refusal(404, "media: the unit names no file", "missing")
    try:
        real, st = confine(root, rel, 1 << 62, "media")
    except Refusal as e:
        raise Refusal(e.code, e.msg, "missing" if e.code == 404 else "refused")
    mime = MEDIA_TYPES[kind].get(_ext(rel.strip()))
    # a link named .mp3 that lands on anything else is not served as sound
    if mime is None or MEDIA_TYPES[kind].get(_ext(real.name)) != mime:
        raise Refusal(415, "media: not %s the pane plays (%s)" % (kind, ", ".join(MEDIA_TYPES[kind])), "type")
    if st.st_size > MEDIA_CAPS[kind]:
        raise Refusal(413, "media: the file is over %d MB" % (MEDIA_CAPS[kind] >> 20), "too-large")
    return real, st, mime


def proxy_name(uid):
    safe = re.sub(r"[^A-Za-z0-9_-]", "_", uid)[:80]
    return "%s-%s.mp4" % (safe, hashlib.sha1(uid.encode("utf-8")).hexdigest()[:8])


def media_file(ctx, uid):
    """What the pane is sent for a unit: the proxy when there is one newer than the source."""
    med = ctx["man"]["media"]
    row = ctx["units"]["media"][ctx["units"]["by"][uid]]
    real, st, mime = media_source(ctx["root"], med["kind"], row["path"])
    if med["proxy"]:
        try:
            p, pst = confine(ctx["root"], "%s/%s" % (proxy_dir_rel(ctx["man"]["id"]), proxy_name(uid)),
                             MEDIA_CAPS["video"], "proxy")
            if _ext(p.name) == "mp4" and pst.st_mtime_ns > st.st_mtime_ns:
                return p, pst, "video/mp4"
        except Refusal:
            pass
    return real, st, mime


def _seconds(v):
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    try:
        v = float(v)
    except OverflowError:
        return None
    return v if math.isfinite(v) else None


def media_window(row):
    s, e = _seconds(row["start"]), _seconds(row["end"])
    return (s, e) if s is not None and e is not None and 0 <= s < e else (None, None)


_PREVIEW_BUILD = threading.Lock()


def _pixels(real):
    try:
        from PIL import Image
        with Image.open(real) as im:
            return im.size[0] * im.size[1]
    except Exception:
        return float("inf")


def _preview_applies(real, st):
    w, h = explore._img_dims(real, st.st_mtime, st.st_size)
    if not explore._preview_wanted(real.name, st.st_size, w, h):
        return False
    # the builder decodes the whole image: a small file can still be a huge canvas
    return _cached(("pixels", str(real), st.st_mtime_ns, st.st_size),
                   lambda: _pixels(real)) <= PREVIEW_MAX_PIXELS


def _preview(real, stamp):
    # one build at a time: the builder's temp name is per process, not per thread
    with _PREVIEW_BUILD:
        out = explore._preview_file(real, stamp)
        return out if out.is_file() else explore._build_preview(real, stamp)


def media_view(ctx, uid):
    med = ctx["man"]["media"]
    try:
        real, st, mime = media_file(ctx, uid)
    except Refusal as e:
        return {"kind": med["kind"], "error": e.media or "refused"}
    stamp = _stamp(st)
    url = "/w/panel/coding/media?project=%s&set=%s&unit=%s&v=%s" % (
        quote(ctx["project"], safe=""), ctx["man"]["id"], quote(uid, safe=""), stamp)
    timed = med["kind"] != "image"
    start, end = media_window(ctx["units"]["media"][ctx["units"]["by"][uid]]) if timed else (None, None)
    out = {"kind": med["kind"], "url": url, "mime": mime, "size": st.st_size, "stamp": stamp,
           "start": start, "end": end, "autoplay": med["autoplay"]}
    if not timed and _preview_applies(real, st):
        out["preview"] = url + "&preview=1"
    return out


def media_check(root, man, units):
    """Every unit's media through the checks the route applies -> [(unit id, why)]."""
    med = man["media"]
    bad = []
    for uid, row in zip(units["ids"], units["media"]):
        try:
            media_source(root, med["kind"], row["path"])
        except Refusal as e:
            bad.append((uid, e.msg))
            continue
        if med["start_field"] and med["kind"] != "image" and media_window(row) == (None, None):
            bad.append((uid, "media: start and end are seconds, 0 <= start < end"))
    return bad


def media_request(vault, q):
    """GET or HEAD /w/panel/coding/media -> (200, {path, size, mime, etag, cache}) for
    serve.py to stream, or (code, error body)."""
    def one(k):
        return (q.get(k) or [""])[0].strip()
    try:
        ctx = open_set(vault, one("project"), one("set"))
        uid = (q.get("unit") or [""])[0]
        if not ctx["man"]["media"]:
            raise Refusal(404, "this set has no media")
        if uid not in ctx["units"]["by"]:
            raise Refusal(404, "no such unit in this set")
        real, st, mime = media_file(ctx, uid)
        stamp, tag = _stamp(st), "cm"
        if one("preview") == "1" and ctx["man"]["media"]["kind"] == "image" and _preview_applies(real, st):
            out = _preview(real, stamp)
            pst = _stat(out) if out else None
            if pst and pst.st_size:
                real, st, mime, tag = out, pst, "image/webp", "cmp"
        # no dash in the tag: serve.py's If-None-Match reads a tag only up to its first dash
        return 200, {"path": real, "size": st.st_size, "mime": mime,
                     "etag": '"%s%s"' % (tag, stamp.replace("-", ".")),
                     "cache": "private, max-age=31536000, immutable" if one("v") == stamp
                              else "private, no-cache"}
    except Refusal as e:
        return e.code, {"ok": False, "error": _scrub(e.msg)}
    except Exception as e:
        return 500, {"ok": False, "error": "coding: %s" % _scrub(type(e).__name__)}


def open_set(vault, project, set_id):
    root = project_root(vault, project)
    if not getattr(_HELD, "on", False):
        _recover(root, set_id)
    man = load_manifest(root, set_id)
    codes, cb_stamp = load_codebook(root, man)
    units, u_stamp = load_units(root, man)
    cb_real, cb_st = confine(root, man["codebook"], CAP_CODEBOOK, "codebook")
    return {"root": root, "vault": vault, "project": project_slug(root), "man": man, "codes": codes,
            "units": units, "stamps": [man["stamp"], cb_stamp, u_stamp],
            "cb_real": cb_real, "cb_sha": _codebook_raw(cb_real, cb_st)[0]}


def owner_path(ctx):
    return ctx["root"] / CODING_DIR / ctx["man"]["id"] / ("coding_pass_%s.json" % HUMAN)


def reviews_path(ctx):
    return ctx["root"] / CODING_DIR / ctx["man"]["id"] / "reviews.json"


def owner_records(ctx):
    rows, st = _live(owner_path(ctx))
    return {str(r.get("unit_id")): r for r in rows if isinstance(r, dict)}, st


def reviews(ctx):
    rows, st = _live(reviews_path(ctx))
    return [r for r in rows if isinstance(r, dict)], st


def coders(ctx):
    out = {}
    for name, c in ctx["man"]["coders"].items():
        try:
            idx, st = load_coder(ctx["root"], name, c)
            out[name] = dict(c, idx=idx, stamp=st, error="")
        except Refusal as e:
            out[name] = dict(c, idx={"by": {}, "codes": set()}, stamp="", error=e.msg)
    return out


# -- the lock and the atomic write ------------------------------------------------
_WRITE_LOCK = threading.Lock()
# set while this thread holds the lock: open_set then leaves a cut-short promotion to its owner
_HELD = threading.local()


def _lock_dir():
    base = os.environ.get("AIOA_CODING_STATE")
    if base:
        d = Path(base).expanduser()
    else:
        d = settings.STATE_DIR / "coding"
    d.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(d, 0o700)
    except OSError:
        pass
    return d


@contextmanager
def locked(*targets):
    d = _lock_dir()
    names = sorted({hashlib.sha1(str(t).encode()).hexdigest()[:16] + ".lock" for t in targets})
    with _WRITE_LOCK:
        fds = []
        try:
            for n in names:
                fds.append(os.open(d / n, os.O_CREAT | os.O_RDWR, 0o600))
                fcntl.flock(fds[-1], fcntl.LOCK_EX)
            _HELD.on = True
            yield
        finally:
            _HELD.on = False
            for fd in reversed(fds):
                fcntl.flock(fd, fcntl.LOCK_UN)
                os.close(fd)


def _write_bytes(target, data, mode=None):
    try:
        mode = mode if mode is not None else stat.S_IMODE(os.lstat(target).st_mode)
    except OSError:
        mode = 0o644
    fd, tmp = tempfile.mkstemp(dir=str(target.parent), prefix="." + target.name + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        os.chmod(tmp, mode)
        os.replace(tmp, target)
        _sync_dir(target.parent)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    return _stamp(_stat(target))


def _sync_dir(d):
    """The rename itself reaches the disk; a platform that cannot do this is left alone."""
    try:
        fd = os.open(d, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


def write_list(target, rows):
    return _write_bytes(target, (json.dumps(rows, indent=1, ensure_ascii=False) + "\n").encode("utf-8"))


def _now(after=""):
    t = datetime.now(timezone.utc)
    s = t.isoformat(timespec="milliseconds").replace("+00:00", "Z")
    if after and s <= after:
        # two saves in one millisecond still get distinct versions
        try:
            prev = datetime.fromisoformat(after.replace("Z", "+00:00"))
            s = (prev + timedelta(milliseconds=1)).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        except ValueError:
            pass
    return s


# -- agreement ------------------------------------------------------------------
def alpha_binary(rows):
    """Nominal Krippendorff's alpha for binary codes."""
    observed_disagree = observed_total = 0
    counts = {0: 0, 1: 0}
    for row in rows:
        valid = [v for v in row if v is not None]
        n = len(valid)
        if n < 2:
            continue
        pairs = n * (n - 1)
        same = sum(1 for a, b in combinations(valid, 2) if a == b) * 2
        observed_disagree += pairs - same
        observed_total += pairs
        for v in valid:
            counts[v] = counts.get(v, 0) + 1
    if observed_total == 0:
        return None
    total = sum(counts.values())
    if total < 2:
        return None
    expected = counts.get(0, 0) * counts.get(1, 0) * 2 / (total - 1)
    if expected == 0:
        return 1.0
    d_obs = observed_disagree / observed_total
    d_exp = expected / total
    if d_exp == 0:
        return 1.0
    return round(1.0 - d_obs / d_exp, 4)


def _pair(units, a_of, b_of):
    rows, dis = [], []
    for u in units:
        a, b = a_of(u), b_of(u)
        if a is None or b is None:
            continue
        rows.append([a, b])
        if a != b:
            dis.append(u)
    n = len(rows)
    return {"alpha": alpha_binary(rows) if n else None,
            "pct": round(sum(1 for a, b in rows if a == b) / n, 4) if n else None,
            "n": n, "disagree": dis}


def _owner_val(rec, code):
    if not rec or not rec.get("done"):
        return None
    if code in (rec.get("codes_applied") or []):
        return 1
    if not any(isinstance(d, dict) and d.get("code") == code for d in rec.get("code_details") or []):
        return None
    return 0


def _coder_val(cd, uid, code):
    rec = cd["idx"]["by"].get(uid)
    if rec is None or code not in cd["idx"]["codes"]:
        return None
    return 1 if code in (rec.get("codes_applied") or []) else 0


def agreement(ctx, owner=None, cds=None):
    if owner is None:
        owner, _ = owner_records(ctx)
    if cds is None:
        cds = coders(ctx)
    ids = ctx["units"]["ids"]
    done = [u for u in ids if (owner.get(u) or {}).get("done")]
    done_set = set(done)
    blind = ctx["man"]["blind"]
    per_code, any_dis = {}, set()
    for c in ctx["codes"]:
        code = c["label"]
        vs = {}
        for name, cd in cds.items():
            r = _pair(done, lambda u: _owner_val(owner.get(u), code), lambda u: _coder_val(cd, u, code))
            any_dis.update(r["disagree"])
            vs[name] = r
        pairs = {}
        for k1, k2 in combinations(sorted(cds), 2):
            r = _pair(ids, lambda u: _coder_val(cds[k1], u, code), lambda u: _coder_val(cds[k2], u, code))
            r["n_disagree"] = len(r["disagree"])
            if blind:
                r["disagree"] = [u for u in r["disagree"] if u in done_set]
            pairs[k1 + "|" + k2] = r
        per_code[code] = {"vs": vs, "pairs": pairs}
    listed = set(any_dis)
    for pc in per_code.values():
        for r in pc["pairs"].values():
            listed.update(r["disagree"])
    U = ctx["units"]
    return {"ok": True, "human": HUMAN, "n_done": len(done), "n_units": len(ids),
            "codes": [c["label"] for c in ctx["codes"]], "coders": sorted(cds),
            "per_code": per_code, "disagree_units": [u for u in ids if u in any_dis],
            "previews": {u: " ".join(U["text"][U["by"][u]].split())[:PREVIEW] for u in ids if u in listed}}


# -- views ----------------------------------------------------------------------
def _note(rec):
    return str((rec or {}).get("raw_response") or "").strip()


def _status(rec):
    if not rec:
        return "todo"
    return "done" if rec.get("done") else "draft"


def _public_codebook(codes):
    return [{k: c[k] for k in ("label", "display", "short", "definition", "decision_rules", "inclusion_criteria",
                               "exclusion_criteria", "positive_examples", "negative_examples",
                               "confusable_with", "derived", "none_of")} for c in codes]


def _public_coders(ctx, cds):
    return [{"name": n, "kind": cd["kind"], "codebook_version": cd["codebook_version"],
             "error": cd["error"]} for n, cd in sorted(cds.items())]


def _set_summary(ctx, owner):
    n = len(ctx["units"]["ids"])
    done = sum(1 for u in ctx["units"]["ids"] if (owner.get(u) or {}).get("done"))
    man = ctx["man"]
    return {"id": man["id"], "title": man["title"], "project": ctx["project"],
            "project_name": ctx["root"].name, "units": n, "done": done,
            "blind": man["blind"], "coders": sorted(man["coders"]),
            "codebook_version": man["codebook_version"],
            "choice": man["choice"], "confidence": man["confidence"]}


def list_sets(vault, project=None):
    if project:
        roots = [project_root(vault, project)]
    else:
        roots, base = [], Path(vault) / "Projects"
        for parent in explore.PROJECT_PARENTS:
            try:
                entries = sorted(os.scandir(base / parent), key=lambda e: e.name)
            except OSError:
                continue
            for e in entries:
                if e.is_dir() and not e.name.startswith(".") and (Path(e.path) / SETS_DIR).is_dir():
                    roots.append(Path(e.path).resolve())
    out = []
    for root in roots:
        try:
            names = sorted(e.name[:-5] for e in os.scandir(root / SETS_DIR)
                           if e.name.endswith(".json") and not e.name.startswith("."))
        except OSError:
            continue
        for sid in names:
            if not SET_RE.match(sid):
                continue
            try:
                ctx = open_set(vault, project_slug(root), sid)
                owner, _ = owner_records(ctx)
                out.append(dict(_set_summary(ctx, owner), error=""))
            except Refusal as e:
                out.append({"id": sid, "title": sid, "project": project_slug(root),
                            "project_name": root.name, "units": 0, "done": 0, "blind": True,
                            "coders": [], "codebook_version": "", "error": e.msg})
            except OSError:
                continue
    return {"ok": True, "sets": out}


def set_view(vault, project, set_id, filt="", q="", offset=0, limit=PAGE_DEFAULT):
    if filt not in FILTERS:
        raise Refusal(400, "unknown filter")
    ctx = open_set(vault, project, set_id)
    owner, owner_st = owner_records(ctx)
    revs, rev_st = reviews(ctx)
    cds = coders(ctx)
    agr = agreement(ctx, owner, cds)
    dis = set(agr["disagree_units"])
    open_rev, open_agent, any_rev = {}, {}, set()
    for r in revs:
        u = str(r.get("unit_id"))
        any_rev.add(u)
        if not r.get("resolved"):
            open_rev[u] = open_rev.get(u, 0) + 1
            if r.get("reviewer") != HUMAN:
                open_agent[u] = open_agent.get(u, 0) + 1
    U = ctx["units"]
    toks = [t for t in (q or "").lower().split() if t][:8]
    counts = {"total": len(U["ids"]), "todo": 0, "draft": 0, "done": 0,
              "disagree": len(dis), "reviewed": 0, "noted": 0}
    revisit_of = revisit_reader(ctx)
    again = {}
    ids = []
    for i, uid in enumerate(U["ids"]):
        rec = owner.get(uid)
        s = _status(rec)
        note = _note(rec)
        counts[s] += 1
        if uid in any_rev:
            counts["reviewed"] += 1
        if note:
            counts["noted"] += 1
        why = revisit_of(rec)
        if why:
            again[uid] = why
        keep = (not filt or (filt == "todo" and s != "done") or (filt == "coded" and s == "done")
                or (filt == "disagree" and uid in dis) or (filt == "reviewed" and uid in any_rev)
                or (filt == "noted" and bool(note)) or (filt == "revisit" and uid in again))
        hay = U["lower"][i] + (" " + note.lower() if note else "")
        if keep and all(t in hay for t in toks):
            ids.append(uid)
    offset = max(0, int(offset or 0))
    limit = min(PAGE_MAX, max(1, int(limit or PAGE_DEFAULT)))
    rows = []
    for uid in ids[offset:offset + limit]:
        i = U["by"][uid]
        rec = owner.get(uid)
        rows.append({"id": uid, "preview": " ".join(U["text"][i].split())[:PREVIEW],
                     "status": _status(rec), "codes": list(rec.get("codes_applied") or []) if rec else [],
                     "disagree": uid in dis, "reviews": open_rev.get(uid, 0),
                     "agent_reviews": open_agent.get(uid, 0), "reviewed": uid in any_rev,
                     "noted": bool(_note(rec)), "note": " ".join(_note(rec).split())[:PREVIEW]})
        if uid in again:
            rows[-1]["revisit"] = again[uid]
    man = ctx["man"]
    kind = {"media_kind": man["media"]["kind"]} if man["media"] else {}
    if man["history"]:
        counts["revisit"] = kind["revisit_count"] = len(again)
    # a draft or a log line written in another window moves the stamp; a set with neither keeps its old one
    edits = [_stamp(st) for st in (_stat(p) for p in (_coding_file(ctx, DRAFT_NAME), _coding_file(ctx, LOG_NAME)) if p)]
    stamp = hashlib.sha1("|".join(ctx["stamps"] + [owner_st, rev_st]
                                  + [cds[n]["stamp"] for n in sorted(cds)] + edits).encode()).hexdigest()[:16]
    return {"ok": True, "stamp": stamp,
            "set": dict(_set_summary(ctx, owner), meta_fields=man["meta_fields"],
                        codebook_note=man["codebook_note"], human=HUMAN, note_max=NOTE_MAX, **kind),
            "codebook": _public_codebook(ctx["codes"]), "coders": _public_coders(ctx, cds),
            "counts": counts, "filter": filt, "q": q or "", "ids": ids,
            "offset": offset, "limit": limit, "rows": rows}


def _cell(cd, uid, code):
    rec = cd["idx"]["by"].get(uid)
    if rec is None:
        return None
    if code not in cd["idx"]["codes"]:
        return {"present": None, "confidence": "", "evidence": "", "reasoning": ""}
    d = next((x for x in rec.get("code_details") or [] if isinstance(x, dict) and x.get("code") == code), {})
    return {"present": code in (rec.get("codes_applied") or []),
            "confidence": str(d.get("confidence") or ""), "evidence": str(d.get("evidence") or ""),
            "reasoning": str(d.get("reasoning") or "")}


def _public_record(rec):
    if not rec:
        return None
    return {"unit_id": rec.get("unit_id"), "codes_applied": list(rec.get("codes_applied") or []),
            "code_details": [d for d in rec.get("code_details") or [] if isinstance(d, dict)],
            "note": str(rec.get("raw_response") or ""), "coded_at": str(rec.get("coded_at") or ""),
            "done": bool(rec.get("done"))}


def unit_view(vault, project, set_id, uid, reveal=False):
    ctx = open_set(vault, project, set_id)
    U = ctx["units"]
    if uid not in U["by"]:
        raise Refusal(404, "no such unit in this set")
    i = U["by"][uid]
    owner, _ = owner_records(ctx)
    rec = owner.get(uid)
    revealed = bool(rec and rec.get("done")) or (bool(reveal) and not ctx["man"]["blind"])
    out = {"ok": True, "set": set_id, "project": ctx["project"],
           "unit": {"id": uid, "text": U["text"][i], "meta": U["meta"][i], "index": i,
                    "total": len(U["ids"]), "context": U["ctx"][i]},
           "record": _public_record(rec), "base": str((rec or {}).get("coded_at") or ""),
           "revealed": revealed, "coders": [], "reviews": []}
    if ctx["man"]["media"]:
        out["unit"]["media"] = media_view(ctx, uid)
    again = revisit_reader(ctx)(rec)
    if again:
        out["unit"]["revisit"] = again
    if revealed:
        cds = coders(ctx)
        out["coders"] = [{"name": n, "kind": cd["kind"], "codebook_version": cd["codebook_version"],
                          "coded": uid in cd["idx"]["by"],
                          "codes": {c["label"]: _cell(cd, uid, c["label"]) for c in ctx["codes"]}}
                         for n, cd in sorted(cds.items())]
        revs, _ = reviews(ctx)
        out["reviews"] = [r for r in revs if str(r.get("unit_id")) == uid]
    return out


# -- writes ---------------------------------------------------------------------
def _norm_ws(s):
    return " ".join(s.split())


def _anchor(a, kind):
    """A stretch of a sound or video in seconds, or a box on an image in fractions of it."""
    if kind is None:
        raise Refusal(400, "only a media set takes an anchor")
    keys = ("x", "y", "w", "h") if kind == "image" else ("t0", "t1")
    if not isinstance(a, dict) or set(a) != set(keys):
        raise Refusal(400, "an anchor on this set is {%s}" % ", ".join(keys))
    vals = [_seconds(a[k]) for k in keys]
    if None in vals:
        raise Refusal(400, "an anchor holds finite numbers")
    if kind == "image":
        x, y, w, h = vals
        ok = 0 <= x <= 1 and 0 <= y <= 1 and w > 0 and h > 0 and x + w <= 1.0001 and y + h <= 1.0001
    else:
        t0, t1 = vals
        ok = 0 <= t0 < t1 <= ANCHOR_MAX_S
    if not ok:
        raise Refusal(400, "the anchor is out of range")
    return dict(zip(keys, vals))


def build_record(ctx, uid, codes_in, note, done, coded_at):
    text = ctx["units"]["text"][ctx["units"]["by"][uid]]
    kind = ctx["man"]["media"]["kind"] if ctx["man"]["media"] else None
    known = {c["label"]: c for c in ctx["codes"]}
    if not isinstance(codes_in, dict):
        raise Refusal(400, "codes must be an object")
    for k in codes_in:
        if k not in known:
            raise Refusal(400, "unknown code: %s" % str(k)[:60])
    details, applied = [], []
    for c in ctx["codes"]:
        if c["derived"]:
            continue
        x = codes_in.get(c["label"]) or {}
        if not isinstance(x, dict):
            raise Refusal(400, "code %s must be an object" % c["label"])
        present = x.get("present", False)
        if not isinstance(present, bool):
            raise Refusal(400, "present must be true or false")
        conf = x.get("confidence") or "high"
        if conf not in CONFIDENCE:
            raise Refusal(400, "confidence is high, medium or low")
        ev = x.get("evidence") or ""
        if not isinstance(ev, str) or len(ev) > EVIDENCE_MAX:
            raise Refusal(400, "evidence must be a short string")
        ev = ev.strip() if present else ""
        if ev and ev not in text and _norm_ws(ev) not in _norm_ws(text):
            raise Refusal(400, "evidence must be a quote from the unit")
        details.append({"code": c["label"], "present": present, "confidence": conf,
                        "evidence": ev, "reasoning": ""})
        if x.get("anchor") is not None:
            anchor = _anchor(x["anchor"], kind)
            if present:
                details[-1]["anchor"] = anchor
        if present:
            applied.append(c["label"])
    if ctx["man"]["choice"] == "single" and len(applied) > 1:
        raise Refusal(400, "this set takes one choice per unit")
    for c in ctx["codes"]:
        if not c["derived"]:
            continue
        present = not any(x in applied for x in c["none_of"])
        details.append({"code": c["label"], "present": present, "confidence": "high",
                        "evidence": "", "reasoning": ""})
    order = [c["label"] for c in ctx["codes"]]
    details.sort(key=lambda d: order.index(d["code"]))
    applied = [d["code"] for d in details if d["present"]]
    return {"unit_id": uid, "pass_id": HUMAN, "frame_id": "human_" + HUMAN,
            "codes_applied": applied, "code_details": details,
            "raw_response": note, "coded_at": coded_at, "done": bool(done),
            "codebook_version": ctx["man"]["codebook_version"], "codebook_sha256": ctx["cb_sha"]}


def save(vault, data):
    ctx = open_set(vault, data.get("project"), data.get("set"))
    uid = data.get("unit")
    if not isinstance(uid, str) or uid not in ctx["units"]["by"]:
        raise Refusal(404, "no such unit in this set")
    base = data.get("base") or ""
    note = data.get("note") or ""
    done = data.get("done", False)
    if not isinstance(base, str) or not isinstance(note, str) or not isinstance(done, bool):
        raise Refusal(400, "base and note are strings, done is true or false")
    if len(note) > NOTE_MAX:
        raise Refusal(400, "the note is too long")
    note = CTRL_RE.sub(lambda m: m.group(0) if m.group(0) in "\n\t" else " ", note).strip()
    target = _write_target(ctx["root"], ctx["man"]["id"], "coding_pass_%s.json" % HUMAN)
    with locked(target):
        # a promotion may have landed while this save waited: code against the file in use now
        ctx = open_set(vault, data.get("project"), data.get("set"))
        order = ctx["units"]["by"]
        if uid not in order:
            raise Refusal(404, "no such unit in this set")
        rows = _read_list(target)
        at = next((i for i, r in enumerate(rows) if isinstance(r, dict) and r.get("unit_id") == uid), None)
        cur = rows[at] if at is not None else None
        cur_at = str((cur or {}).get("coded_at") or "")
        if base != cur_at:
            return 409, {"ok": False, "conflict": True, "error": "changed in another window",
                         "record": _public_record(cur), "base": cur_at}
        rec = build_record(ctx, uid, data.get("codes") or {}, note, done, _now(cur_at))
        # what another tool put on the record stays on it
        rec.update({k: v for k, v in (cur or {}).items() if k not in rec})
        if at is None:
            rows.append(rec)
        else:
            rows[at] = rec
        rows.sort(key=lambda r: order.get(str(r.get("unit_id")) if isinstance(r, dict) else "", len(order)))
        version = write_list(target, rows)
        n_done = sum(1 for r in rows if isinstance(r, dict) and r.get("done") and str(r.get("unit_id")) in order)
    return 200, {"ok": True, "record": _public_record(rec), "base": rec["coded_at"], "version": version,
                 "counts": {"done": n_done, "total": len(order)}}


def add_review(ctx, uid, code, target_coder, verdict, note, reviewer):
    """Upsert one open review per (unit, code, target, reviewer); resolved ones stay."""
    if uid not in ctx["units"]["by"]:
        raise Refusal(404, "no such unit in this set")
    if code not in {c["label"] for c in ctx["codes"]}:
        raise Refusal(400, "unknown code")
    if verdict not in VERDICTS:
        raise Refusal(400, "verdict is agree, disagree or unsure")
    if not isinstance(note, str) or len(note) > REVIEW_NOTE_MAX:
        raise Refusal(400, "the note is too long")
    if target_coder != HUMAN and target_coder not in ctx["man"]["coders"]:
        raise Refusal(400, "unknown coder")
    if target_coder == reviewer:
        raise Refusal(400, "a coder does not review itself")
    owner, _ = owner_records(ctx)
    if ctx["man"]["blind"] and not (owner.get(uid) or {}).get("done"):
        raise Refusal(403, "the unit is not done yet")
    note = CTRL_RE.sub(" ", note).strip()
    target = _write_target(ctx["root"], ctx["man"]["id"], "reviews.json")
    with locked(target):
        # a promotion may have renamed the code while this waited
        ctx = open_set(ctx["vault"], ctx["project"], ctx["man"]["id"])
        if uid not in ctx["units"]["by"] or code not in {c["label"] for c in ctx["codes"]}:
            raise Refusal(400, "unknown code")
        rows = _read_list(target)
        hit = next((r for r in rows if isinstance(r, dict) and not r.get("resolved")
                    and r.get("unit_id") == uid and r.get("code") == code
                    and r.get("target_coder") == target_coder and r.get("reviewer") == reviewer), None)
        if hit is None:
            hit = {"id": "r-" + secrets.token_hex(6), "unit_id": uid, "code": code,
                   "target_coder": target_coder, "reviewer": reviewer}
            rows.append(hit)
        hit.update(verdict=verdict, note=note, ts=_now(), resolved=False)
        version = write_list(target, rows)
    return {"ok": True, "review": hit, "version": version}


def resolve_review(ctx, rid, resolved=True):
    if not isinstance(rid, str) or not REVIEW_ID_RE.match(rid):
        raise Refusal(400, "bad review id")
    target = _write_target(ctx["root"], ctx["man"]["id"], "reviews.json")
    with locked(target):
        rows = _read_list(target)
        hit = next((r for r in rows if isinstance(r, dict) and r.get("id") == rid), None)
        if hit is None:
            raise Refusal(404, "no such review")
        hit["resolved"] = bool(resolved)
        version = write_list(target, rows)
    return {"ok": True, "review": hit, "version": version}


def review(vault, data):
    ctx = open_set(vault, data.get("project"), data.get("set"))
    if "id" in data:
        resolved = data.get("resolved", True)
        if not isinstance(resolved, bool):
            raise Refusal(400, "resolved is true or false")
        return 200, resolve_review(ctx, data.get("id"), resolved)
    return 200, add_review(ctx, data.get("unit"), data.get("code"), data.get("target_coder"),
                           data.get("verdict"), data.get("note") or "", HUMAN)


def event_check(vault, project, set_id, unit=None):
    """For POST /w/panel/event kind=coding: the set must open, the unit must be in it."""
    try:
        ctx = open_set(vault, project, set_id)
    except Refusal as e:
        return e.msg
    if unit is not None and unit not in ctx["units"]["by"]:
        return "no such unit in this set"
    return None


# -- the codebook: draft, log, promote ----------------------------------------------
_MISSING = object()
PASS_NAME = "coding_pass_%s.json" % HUMAN
INTENT_NAME = "codebook_promote.intent.json"
LOG_TEXT_MAX = 2000
CAP_LOG = 2 * 1024 * 1024
ASIDE_MAX = 50
# C1 controls and the bidi embedding, override and isolate characters
C1_RE = re.compile("[\x80-\x9f‪-‮⁦-⁩]")
# labels become object keys in the pane
RESERVED = ("__proto__", "constructor", "prototype", "hasOwnProperty", "toString", "valueOf", "*")
CAP_INTENT = 8 * 1024 * 1024
NEW_ID_RE = re.compile(r"^new-\d+$")
SHA_RE = re.compile(r"^[0-9a-f]{64}$")
TS_RE = re.compile(r"^\d{4}-\d\d-\d\dT[0-9:.]{8,15}Z$")


class BadDraft(Refusal):
    pass


class NoRebase(Refusal):
    pass


class ByHand(Refusal):
    """A promotion's note that is not acted on, or a state no later request can mend."""
    def __init__(self, msg):
        super().__init__(500, msg)


def _label_key(c):
    return next((k for k in ("label", "code", "name") if c.get(k)), "label")


def _label_of(c):
    return str(c.get("label") or c.get("code") or c.get("name") or "").strip()


def _fold(label):
    return unicodedata.normalize("NFC", label).casefold()


def _read_codebook(real):
    """The file in use, uncached -> (bytes, sha256, parsed, its list of codes)."""
    raw = real.read_bytes()
    try:
        obj = json.loads(raw.decode("utf-8"))
    except ValueError:
        raise Refusal(400, "%s is not valid JSON" % real.name)
    items = obj.get("codes") if isinstance(obj, dict) else obj
    if not isinstance(items, list) or not items:
        raise Refusal(400, "the codebook has no codes")
    return raw, hashlib.sha256(raw).hexdigest(), obj, items


def _codebook_raw(real, st):
    def build():
        _, sha, _, items = _read_codebook(real)
        return sha, items
    return _cached(("cbraw", str(real), st.st_mtime_ns, st.st_size), build)


def _coding_file(ctx, name):
    """coding/<set>/<name> for a read: None unless it is a plain file in a folder that is no link."""
    d = ctx["root"] / CODING_DIR / ctx["man"]["id"]
    try:
        if d.resolve(strict=True) != d:
            return None
        st = os.lstat(d / name)
    except (OSError, RuntimeError):
        return None
    return d / name if stat.S_ISREG(st.st_mode) else None


def _set_files(root, sid):
    """A set's manifest and the files a promotion may rewrite in its coding folder. Nothing is made."""
    d = root / CODING_DIR / sid
    if os.path.lexists(d) and (not d.is_dir() or d.resolve() != d):
        raise Refusal(400, "set %s: the coding folder is a link" % sid)
    out = {"man": _manifest_target(root, sid)}
    for key, name in (("pass", PASS_NAME), ("reviews", "reviews.json"), ("draft", DRAFT_NAME)):
        if os.path.lexists(d / name) and not stat.S_ISREG(os.lstat(d / name).st_mode):
            raise Refusal(400, "set %s: %s is not a plain file" % (sid, name))
        out[key] = d / name
    # the log is only ever read through _log_read, which never follows or waits on it
    out["log"] = d / LOG_NAME
    return out


def _raw_manifest(root, name):
    """A file of the sets folder as plain JSON -> (the object, or None and why not)."""
    try:
        real, st = confine(root, "%s/%s.json" % (SETS_DIR, name), CAP_MANIFEST, "set")
        m = _json_file(real, st)
    except (Refusal, OSError) as e:
        return None, _plain(e)
    return (m, "") if isinstance(m, dict) else (None, "it is not a JSON object")


def _set_names(root):
    try:
        return sorted(e.name[:-5] for e in os.scandir(root / SETS_DIR)
                      if e.name.endswith(".json") and not e.name.startswith("."))
    except OSError:
        return []


def _shares(root, raw, cb_real):
    """Whether a manifest's codebook is this file -> (yes, why confine refuses its path or "")."""
    rel = raw.get("codebook")
    try:
        return confine(root, rel, CAP_CODEBOOK, "codebook")[0] == cb_real, ""
    except Refusal as e:
        # a path confine refuses can still be this file: an absolute one, or one through ..
        try:
            same = isinstance(rel, str) and Path(os.path.realpath(root / rel.strip())) == cb_real
        except (OSError, ValueError):
            same = False
        return same, e.msg


def _family(root, cb_real):
    mans, broken = [], []

    def bad(sid, why, raw=None):
        broken.append({"id": _clean(sid), "why": why, "shares": raw is not None, "raw": raw})
    for sid in _set_names(root):
        named = bool(SET_RE.match(sid))
        raw, why = _raw_manifest(root, sid)
        if raw is None:
            if named:
                bad(sid, why)
            continue
        yes, refused = _shares(root, raw, cb_real)
        if not yes:
            continue
        if not named:
            if os.path.lexists(root / CODING_DIR / sid / PASS_NAME):
                bad(sid, "its file name is not a set id, and a coding pass lies under that name", raw)
        elif refused:
            bad(sid, refused, raw)
        elif not isinstance(raw.get("codebook_history", []), list):
            bad(sid, "codebook_history is not a list", raw)
        else:
            try:
                mans.append(load_manifest(root, sid))
            except Exception as e:
                bad(sid, _plain(e), raw)
    return mans, sorted(broken, key=lambda b: not b["shares"])


def family(root, cb_real):
    """Every set of the project whose manifest names this codebook file and reads."""
    return _family(root, cb_real)[0]


def _refuse_broken(broken):
    b = broken[0]
    how = ("set %s shares this codebook and its manifest cannot be read: %s" if b["shares"] else
           "set %s: its manifest cannot be read, so it may share this codebook: %s")
    return 409, {"ok": False, "conflict": True, "broken_set": b["id"],
                 "error": _scrub(how % (b["id"], b["why"]))}


def shared_with(ctx):
    return [m["id"] for m in family(ctx["root"], ctx["cb_real"]) if m["id"] != ctx["man"]["id"]]


def _held_by(man, mans):
    """The set whose lock holds the codebook file: this one first, then any that shares it."""
    return next((m for m in [man] + mans if m["locked"]), None)


def _today():
    return datetime.now().strftime("%Y-%m-%d")


def _text(v, cap, what, line=False, strict=False):
    if not isinstance(v, str):
        raise Refusal(400, "%s must be a string" % what)
    if line:
        v = v.rstrip()
        if any(ch in v for ch in "\n\t\u2028\u2029"):
            raise Refusal(400, "%s is one line, with no tab" % what)
    if len(v) > cap:
        raise Refusal(400, "%s is over %d characters" % (what, cap))
    if (CTRL_RE if strict else C0_RE).search(v) or C1_RE.search(v):
        raise Refusal(400, "%s holds a control character" % what)
    if strict and any(unicodedata.category(ch) == "Cf" for ch in v):
        raise Refusal(400, "%s holds an invisible character" % what)
    try:
        v.encode("utf-8")
    except UnicodeEncodeError:
        raise Refusal(400, "%s is not valid text" % what)
    return v


def _shown_examples(v):
    """_examples, keeping any other key an example carries."""
    out = []
    for x in v if isinstance(v, list) else []:
        if isinstance(x, dict):
            out.append(dict(x, text=str(x.get("text") or ""), reasoning=str(x.get("reasoning") or "")))
        elif isinstance(x, str):
            out.append({"text": x, "reasoning": ""})
    return out


def _shown(field, v):
    if v is _MISSING:
        v = None
    if field in LIST_FIELDS:
        return _strs(v)
    if field in EXAMPLE_FIELDS:
        return _shown_examples(v)
    return v if isinstance(v, str) else str(v or "")


def _same(field, a, b):
    if field in LIST_FIELDS or field in EXAMPLE_FIELDS or field in LINE_FIELDS or field in ("label", "definition"):
        return _shown(field, a) == _shown(field, b)
    if a is _MISSING or b is _MISSING:
        return a is b
    return json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)


def _item_key(x):
    return str(x) if isinstance(x, (str, int, float)) and str(x).strip() else None


def _example_key(x):
    if isinstance(x, dict):
        return str(x.get("text") or ""), str(x.get("reasoning") or "")
    return (x, "") if isinstance(x, str) else None


def _keep_stored(cur, new, key_of, new_key):
    """`new` with the stored item wherever one still reads the same (a number stays a number);
    stored items the pane never shows stay after the item they followed."""
    old = [(key_of(x), x) for x in cur] if isinstance(cur, list) else []
    used, out = [False] * len(old), []

    def trail(j):
        while j < len(old) and old[j][0] is None and not used[j]:
            used[j] = True
            out.append(old[j][1])
            j += 1
    trail(0)
    for x in new:
        i = next((i for i, (k, _) in enumerate(old) if not used[i] and k is not None and k == new_key(x)), None)
        if i is None:
            out.append(x)
            continue
        used[i] = True
        out.append(old[i][1])
        trail(i + 1)
    return out


def _field_value(field, v, cur):
    """A value from the wire, checked. Text the code already holds is kept as it is, so a
    codebook written before the caps can still be edited around its long items."""
    if field == "label":
        if not isinstance(v, str):
            raise Refusal(400, "label must be a string")
        v = unicodedata.normalize("NFC", v)
        if v == cur:
            return v
        v = _text(v, LIMITS["label"], "label", line=True, strict=True)
        if not v or v != v.strip() or v in RESERVED or "*" in v:
            raise Refusal(400, "a label is 1 to %d characters, does not start with a space, holds no *, and "
                               "is not a name the pane keeps for itself" % LIMITS["label"])
        return v
    if field in ("definition",) + LINE_FIELDS and isinstance(v, str) and v == cur:
        return v
    if field in LINE_FIELDS:
        return _text(v, LIMITS[field], field, line=True)
    if field == "definition":
        return _text(v, LIMITS[field], field)
    if field in LIST_FIELDS:
        if not isinstance(v, list):
            raise Refusal(400, "%s is a list of strings" % field)
        had = _strs(cur)
        out = [x if isinstance(x, str) and x in had else
               _text(x, LIMITS["list_item"], field, strict=field == "confusable_with")
               for x in v if not isinstance(x, str) or x.strip()]
        if len(out) > max(LIMITS["list_items"], len(had)):
            raise Refusal(400, "%s takes %d items" % (field, LIMITS["list_items"]))
        return _keep_stored(cur, out, _item_key, lambda x: x)
    if field in EXAMPLE_FIELDS:
        if not isinstance(v, list) or not all(isinstance(x, dict) for x in v):
            raise Refusal(400, "%s is a list of {text, reasoning}" % field)
        # an example's other keys (an id) stay with its text
        extra = {}
        for x in cur if isinstance(cur, list) else []:
            if isinstance(x, dict):
                extra.setdefault(str(x.get("text") or ""), x)
        had = _shown_examples(cur)
        out = []
        for x in v:
            text, why = x.get("text") or "", x.get("reasoning") or ""
            if not any(text == h["text"] for h in had):
                text = _text(text, LIMITS["example_text"], field + " text")
            if not any(why == h["reasoning"] for h in had):
                why = _text(why, LIMITS["example_reasoning"], field + " reasoning")
            if text.strip() or why.strip():
                out.append(dict(extra.get(text, {}), text=text, reasoning=why))
        if len(out) > max(LIMITS["examples"], len(had)):
            raise Refusal(400, "%s takes %d examples" % (field, LIMITS["examples"]))
        return _keep_stored(cur, out, _example_key, _example_key)
    raise Refusal(400, "not an editable field: %s" % CTRL_RE.sub(" ", str(field))[:40])


def _draftable(items):
    """Every entry must be a code load_codebook shows, or a round trip would lose it."""
    seen = set()
    for c in items:
        lab = _label_of(c) if isinstance(c, dict) else ""
        if (not lab or lab in seen or len(lab) > LIMITS["label"] or CTRL_RE.search(lab)
                or "_id" in c or "removed" in c):
            raise Refusal(400, "the codebook has an entry the pane cannot edit; fix the file first")
        seen.add(lab)


def _outgoing(d, items):
    """What a promotion would write, checked as an edit is: a draft changed by hand or merged
    by a sync is held to the same rules before any file is touched."""
    base = {_label_of(c): c for c in items}
    bad = Refusal(400, "the draft holds a code the codebook cannot take; fix it in the pane or discard the draft")
    try:
        _draftable(d["codes"])
    except Refusal:
        raise bad
    if not d["codes"] or len(d["codes"]) > max(LIMITS["codes"], len(items)):
        raise Refusal(400, "a codebook takes 1 to %d codes" % LIMITS["codes"])
    new, folded = set(d["added_labels"]) | set(d["renamed"].values()), {}
    for did, c in zip(d["ids"], d["codes"]):
        lab, b = _label_of(c), base.get(did) or {}
        if lab in new and (c.get(_label_key(c)) != lab or _field_value("label", lab, None) != lab):
            raise bad
        other = folded.setdefault(_fold(lab), lab)
        if other != lab and (lab in new or other in new):
            raise Refusal(400, "the labels %s and %s read the same" % (other, lab))
        for f in ("definition",) + LINE_FIELDS + LIST_FIELDS + EXAMPLE_FIELDS:
            if f not in c or _same(f, c[f], b.get(f, _MISSING)):
                continue
            if not isinstance(c[f], list if f in LIST_FIELDS + EXAMPLE_FIELDS else str):
                raise bad
            _field_value(f, _shown(f, c[f]), b.get(f))


def _new_draft(items, man, sha):
    _draftable(items)
    codes = [dict({"_id": _label_of(c)}, **json.loads(json.dumps(c))) for c in items]
    return {"schema": 1, "rev": 0, "updated": "", "created": _now(),
            "based_on": {"version": man["codebook_version"], "sha256": sha}, "codes": codes, "removed": []}


def _read_draft(p):
    try:
        st = os.lstat(p)
    except FileNotFoundError:
        return None
    if not stat.S_ISREG(st.st_mode) or st.st_size > CAP_DRAFT:
        raise BadDraft(500, "%s is not a plain file under %d KiB" % (DRAFT_NAME, CAP_DRAFT >> 10))
    try:
        d = json.loads(p.read_bytes().decode("utf-8"))
    except ValueError:
        raise BadDraft(500, "%s is not valid JSON" % DRAFT_NAME)
    if not (isinstance(d, dict) and d.get("schema") == 1 and type(d.get("rev")) is int and d["rev"] > 0
            and isinstance(d.get("based_on"), dict) and isinstance(d["based_on"].get("sha256"), str)
            and isinstance(d.get("codes"), list) and isinstance(d.get("removed"), list)
            and all(isinstance(c, dict) and isinstance(c.get("_id"), str) for c in d["codes"])
            and len({c["_id"] for c in d["codes"]}) == len(d["codes"])
            and all(isinstance(x, str) for x in d["removed"])):
        raise BadDraft(500, "%s is not a draft" % DRAFT_NAME)
    return d


def _unreadable(e):
    return {"unreadable": True, "error": _scrub(e.msg)}


def _refuse_unreadable(e):
    return 409, {"ok": False, "conflict": True, "unreadable": True, "draft": _unreadable(e),
                 "error": "the draft cannot be read; discard it to start again"}


def _write_draft(target, draft):
    try:
        data = (json.dumps(draft, indent=1, ensure_ascii=False) + "\n").encode("utf-8")
    except UnicodeEncodeError:
        raise Refusal(400, "the codebook holds text that is not valid; fix the file first")
    if len(data) > CAP_DRAFT:
        raise Refusal(400, "the draft is over %d KiB" % (CAP_DRAFT >> 10))
    _write_bytes(target, data)


def _fields_changed(d, b):
    skip = ("_id", _label_key(d), _label_key(b))
    keys = [k for k in d if k not in skip] + [k for k in b if k not in d and k not in skip]
    return [k for k in keys if not _same(k, d.get(k, _MISSING), b.get(k, _MISSING))]


def _diff(draft, items):
    """The draft against the file in use. A draft code's _id is its label in that file."""
    base = {_label_of(c): c for c in items if isinstance(c, dict)}
    gone = set(draft["removed"])
    kept = [d for d in draft["codes"] if d["_id"] not in gone]
    out = {"fields": {}, "added": [], "added_labels": [], "renamed": {}, "changed": []}
    for d in kept:
        b, lab = base.get(d["_id"]), _label_of(d)
        if b is None:
            out["added"].append(d["_id"])
            out["added_labels"].append(lab)
            continue
        if lab != d["_id"]:
            out["renamed"][d["_id"]] = lab
        fields = _fields_changed(d, b)
        if fields:
            out["fields"][d["_id"]] = fields
        if any(f not in LINE_FIELDS for f in fields):
            out["changed"].append(lab)
    ids = {d["_id"] for d in kept}
    out["removed"] = [lab for lab in base if lab not in ids]
    out["ids"] = [d["_id"] for d in kept]
    out["codes"] = [{k: v for k, v in d.items() if k != "_id"} for d in kept]
    out["reordered"] = [d["_id"] for d in kept if d["_id"] in base] != [lab for lab in base if lab in ids]
    return out


def _touched(history, start):
    """Labels changed, added or removed from history[start] on, under their names today."""
    out = []
    for i in range(start, len(history)):
        h = history[i]
        labs = _strs(h.get("changed")) + _strs(h.get("added")) + _strs(h.get("removed"))
        for later in history[i + 1:]:
            ren = later.get("renamed") if isinstance(later.get("renamed"), dict) else {}
            labs = [str(ren.get(x, x)) for x in labs]
        out.extend(x for x in labs if x not in out)
    return out


def revisit_reader(ctx, star=True):
    """-> f(record) -> the labels a done record must be read again for, [] when none.
    "*" leads the list when the file in use is not the one the last promotion wrote."""
    hist, sha = ctx["man"]["history"], ctx["cb_sha"]
    if not hist:
        return lambda rec: []
    order = {c["label"]: i for i, c in enumerate(ctx["codes"])}
    outside = ["*"] if star and hist[-1].get("sha256") != sha else []
    memo = {}

    def of(rec):
        if not rec or not rec.get("done"):
            return []
        was = str(rec.get("codebook_sha256") or "")
        if was == sha:
            return []
        if was not in memo:
            at = [i for i, h in enumerate(hist) if was and h.get("sha256") == was]
            frm = [i for i, h in enumerate(hist) if was and h.get("from_sha256") == was]
            start = at[-1] + 1 if at else (frm[0] if frm else 0)
            memo[was] = outside + sorted(_touched(hist, start), key=lambda x: (order.get(x, len(order)), x))
        return memo[was]
    return of


def suggest_version(cur, taken=()):
    mmdd = datetime.now().strftime("%m-%d")
    cur = cur.strip()
    dated = re.search(r"(?:^|\s+)\d{2}-\d{2}$", cur)
    num = re.search(r"\d+$", cur)
    if dated:
        out = (cur[:dated.start()] + " " + mmdd).strip()
    elif num:
        out = cur[:num.start()] + str(int(num.group()) + 1).zfill(len(num.group()))
    else:
        out = (cur + " " + mmdd).strip()
    base, i = out, 0
    while (out == cur or out in taken) and i < 24:
        out = "%s %s" % (base, chr(ord("b") + i))
        i += 1
    return out[:LIMITS["version"]]


def _fixed(man, mans):
    """Labels a manifest of any set on this file names as derived: they keep their name."""
    out = set(man["derived"])
    for m in mans:
        out.update(m["derived"])
    return out


def _draft_view(ctx, draft, items, sha, owner, fixed=()):
    man, d = ctx["man"], _diff(draft, items)
    gone = set(draft["removed"])
    codes = []
    for c in draft["codes"]:
        v = dict(c)
        for f in LIST_FIELDS + EXAMPLE_FIELDS + LINE_FIELDS + ("definition",):
            if f in v:
                v[f] = _shown(f, v[f])
        v["label"] = _label_of(c)
        v["derived"] = (bool(c.get("derived")) or v["label"] in man["derived"] or c["_id"] in man["derived"]
                        or c["_id"] in fixed)
        if c["_id"] in gone:
            v["removed"] = True
        codes.append(v)
    done = [r for r in (owner.get(u) for u in ctx["units"]["ids"]) if r and r.get("done")]
    of = revisit_reader(ctx, star=False)
    hit = bool(d["changed"] or d["added_labels"] or d["removed"])
    kept = draft.get("reverts") if isinstance(draft.get("reverts"), dict) else {}
    reverts = {k: [f for f in v if f in d["fields"].get(k, [])] for k, v in kept.items() if isinstance(v, list)}
    return {"rev": draft["rev"], "updated": str(draft.get("updated") or ""), "based_on": draft["based_on"],
            "reverts": {k: v for k, v in reverts.items() if v},
            "stale": draft["based_on"]["sha256"] != sha, "codes": codes, "changed": d["fields"],
            "added": d["added"], "removed": [c["_id"] for c in draft["codes"] if c["_id"] in gone],
            "renamed": {k: [k, v] for k, v in d["renamed"].items()}, "reordered": d["reordered"],
            "revisit_if_promoted": len(done) if hit else sum(1 for r in done if of(r))}


def codebook_view(vault, project, set_id):
    ctx = open_set(vault, project, set_id)
    man = ctx["man"]
    dp, lp = _coding_file(ctx, DRAFT_NAME), _log_path(ctx)
    mans, broken = _family(ctx["root"], ctx["cb_real"])
    mans = [m for m in mans if m["id"] != man["id"]]
    try:
        draft = _read_draft(dp) if dp else None
        if draft:
            owner, _ = owner_records(ctx)
            draft = _draft_view(ctx, draft, _read_codebook(ctx["cb_real"])[3], ctx["cb_sha"], owner, _fixed(man, mans))
    except BadDraft as e:
        draft = _unreadable(e)
    log, log_error = _log_read(lp) if lp else ([], "")
    hold = _held_by(man, mans)
    out = {"ok": True, "version": man["codebook_version"], "sha256": ctx["cb_sha"],
           "locked": bool(hold), "lock_reason": hold["lock_reason"] if hold else "",
           "locked_by": hold["id"] if hold else None, "shared_with": [m["id"] for m in mans],
           "broken_sets": [b["id"] for b in broken],
           "codes": _public_codebook(ctx["codes"]), "draft": draft,
           "log": [e for e in reversed(log) if isinstance(e, dict)][:LOG_SHOWN], "history": man["history"],
           "suggest_version": suggest_version(man["codebook_version"],
                                              {str(h.get("version")) for h in man["history"]}),
           "limits": dict(LIMITS)}
    if log_error:
        out["log_error"] = _scrub(log_error)
    return out


def _log_path(ctx):
    """coding/<set>/codebook_log.json, or None when that folder is absent or a link."""
    d = ctx["root"] / CODING_DIR / ctx["man"]["id"]
    try:
        return d / LOG_NAME if d.resolve(strict=True) == d else None
    except (OSError, RuntimeError):
        return None


def _log_read(p):
    """The change log -> (its lines, or [] and why it cannot be read). A link, a pipe or a
    huge file is never opened."""
    try:
        st = os.lstat(p)
    except FileNotFoundError:
        return [], ""
    except OSError as e:
        return [], _plain(e)
    if not stat.S_ISREG(st.st_mode) or st.st_size > 2 * CAP_LOG:
        return [], "%s is not a plain file under %d MiB" % (LOG_NAME, (2 * CAP_LOG) >> 20)
    try:
        return _read_list(p), ""
    except Refusal as e:
        return [], e.msg.split(";")[0]
    except OSError as e:
        return [], _plain(e)


def _log_open(log_t):
    """The log for a write -> (its lines, entries to add first). One that cannot be read is
    moved aside as codebook_log.<date>.bad.json and a fresh one begins with a line saying so."""
    log, err = _log_read(log_t)
    if not err:
        return log, []
    return [], [{"op": "log_aside", "after": _aside(log_t, ".bad").name, "unit_id": None, "why": _scrub(err)}]


def read_log(ctx):
    lp = _log_path(ctx)
    return [e for e in (_log_read(lp)[0] if lp else []) if isinstance(e, dict)]


def _apart(a, b):
    try:
        return abs((datetime.fromisoformat(str(b).replace("Z", "+00:00"))
                    - datetime.fromisoformat(str(a).replace("Z", "+00:00"))).total_seconds())
    except ValueError:
        return float("inf")


def _clip(v):
    """A logged value, cut to LOG_TEXT_MAX characters -> (value, whether it was cut)."""
    if isinstance(v, str):
        return v[:LOG_TEXT_MAX], len(v) > LOG_TEXT_MAX
    if v is None or len(json.dumps(v, ensure_ascii=False)) <= LOG_TEXT_MAX:
        return v, False
    return json.dumps(v, ensure_ascii=False)[:LOG_TEXT_MAX], True


def _log_add(log, entries, rev, unit_id, why):
    """Append, folding a run of typing in one field into one line -> the lines touched."""
    added = []
    for e in entries:
        e = dict({"id": secrets.token_hex(4), "ts": _now(), "rev": rev, "op": "", "code": None, "label": "",
                  "field": None, "before": None, "after": None, "unit_id": unit_id, "why": why}, **e)
        (e["before"], cut_b), (e["after"], cut_a) = _clip(e["before"]), _clip(e["after"])
        if cut_a or cut_b:
            e["truncated"] = True
        last = log[-1] if log and isinstance(log[-1], dict) else None
        if (e["op"] == "set" and last and last.get("op") == "set" and last.get("code") == e["code"]
                and last.get("field") == e["field"] and last.get("unit_id") == unit_id
                and _apart(last.get("ts"), e["ts"]) < LOG_MERGE_S):
            last.update(after=e["after"], ts=e["ts"], rev=rev, why=why or last.get("why") or "")
            if cut_a:
                last["truncated"] = True
            e = last
        else:
            log.append(e)
        if not any(x is e for x in added):
            added.append(e)
    _log_drop(log, len(log) - LOG_MAX)
    return added


def _log_drop(log, n):
    """The oldest n lines go; a promotion is never one of them."""
    if n <= 0:
        return
    keep = []
    for x in log:
        if n > 0 and not (isinstance(x, dict) and x.get("op") == "promote"):
            n -= 1
            continue
        keep.append(x)
    log[:] = keep


def _log_bytes(log):
    while True:
        data = (json.dumps(log, indent=1, ensure_ascii=False) + "\n").encode("utf-8")
        old = sum(1 for x in log if not (isinstance(x, dict) and x.get("op") == "promote"))
        if len(data) <= CAP_LOG or not old:
            return data
        _log_drop(log, max(1, old // 10))


def _code_at(draft, cid):
    hit = next((c for c in draft["codes"] if c["_id"] == cid), None) if isinstance(cid, str) else None
    if hit is None:
        raise Refusal(400, "no such code in the draft")
    return hit


def _label_free(draft, label, but=None):
    gone = set(draft["removed"])
    if any(_fold(_label_of(c)) == _fold(label) for c in draft["codes"] if c is not but and c["_id"] not in gone):
        raise Refusal(400, "the label %s is taken" % label)


def _room(draft):
    if len(draft["codes"]) - len(set(draft["removed"])) >= LIMITS["codes"]:
        raise Refusal(400, "a codebook takes %d codes" % LIMITS["codes"])


def _apply(op, draft, fixed, base_labels, entries):
    """One op on the working draft -> whether it changed anything."""
    kind = op.get("op")
    if kind == "add":
        label = _field_value("label", op.get("label"), None)
        _label_free(draft, label)
        _room(draft)
        if len(draft["codes"]) >= 2 * LIMITS["codes"]:
            raise Refusal(400, "the draft holds too many removed codes; promote or discard it")
        at = len(draft["codes"])
        if op.get("after") is not None:
            at = draft["codes"].index(_code_at(draft, op["after"])) + 1
        taken = {c["_id"] for c in draft["codes"]} | set(base_labels)
        n = 1
        while "new-%d" % n in taken:
            n += 1
        draft["codes"].insert(at, {"_id": "new-%d" % n, "label": label, "definition": ""})
        entries.append({"op": "add", "code": "new-%d" % n, "label": label, "after": label})
        return True
    code = _code_at(draft, op.get("code"))
    label = _label_of(code)
    held = bool(code.get("derived")) or label in fixed or code["_id"] in fixed
    if kind == "set":
        field = op.get("field")
        if field == "label":
            val = _field_value(field, op.get("value"), label)
            if val == label:
                return False
            if held:
                raise Refusal(400, "%s is derived; a manifest names it, so it keeps its label" % label)
            _label_free(draft, val, code)
            entries.append({"op": "set", "code": code["_id"], "label": label, "field": field,
                            "before": label, "after": val})
            code[_label_key(code)] = val
            return True
        val = _field_value(field, op.get("value"), code.get(field) if isinstance(field, str) else None)
        if _same(field, code.get(field, _MISSING), val):
            return False
        entries.append({"op": "set", "code": code["_id"], "label": label, "field": field,
                        "before": code.get(field), "after": _shown(field, val)})
        code[field] = val
        return True
    if kind == "remove":
        if held:
            raise Refusal(400, "%s is derived; a manifest names it, so it stays" % label)
        if code["_id"] in draft["removed"]:
            return False
        draft["removed"].append(code["_id"])
        entries.append({"op": "remove", "code": code["_id"], "label": label})
        return True
    if kind == "restore":
        if code["_id"] not in draft["removed"]:
            return False
        _label_free(draft, label)
        _room(draft)
        draft["removed"].remove(code["_id"])
        entries.append({"op": "restore", "code": code["_id"], "label": label})
        return True
    if kind == "move":
        to, was = op.get("to"), draft["codes"].index(code)
        if type(to) is not int or not 0 <= to < len(draft["codes"]):
            raise Refusal(400, "to is a place among the draft's codes")
        if to == was:
            return False
        draft["codes"].insert(to, draft["codes"].pop(was))
        entries.append({"op": "move", "code": code["_id"], "label": label, "before": was, "after": to})
        return True
    raise Refusal(400, "op is set, add, remove, restore, move or memo")


def _rev(v):
    if v is None:
        return 0
    if type(v) is not int or v < 0:
        raise Refusal(400, "base_rev is a number or null")
    return v


def _conflict(ctx, draft, items, sha, fixed=(), **more):
    owner, _ = owner_records(ctx)
    return 409, dict({"ok": False, "conflict": True, "error": "the draft changed in another window",
                      "draft": _draft_view(ctx, draft, items, sha, owner, fixed) if draft else None}, **more)


def _edit_targets(ctx):
    root, sid = ctx["root"], ctx["man"]["id"]
    return _write_target(root, sid, DRAFT_NAME), _write_target(root, sid, LOG_NAME, plain=False)


def codebook_edit(vault, data):
    ctx = open_set(vault, data.get("project"), data.get("set"))
    ops, uid = data.get("ops"), data.get("unit_id")
    if not isinstance(ops, list) or not ops or len(ops) > OPS_MAX or not all(isinstance(o, dict) for o in ops):
        raise Refusal(400, "ops is a list of 1 to %d edits" % OPS_MAX)
    if uid is not None and (not isinstance(uid, str) or uid not in ctx["units"]["by"]):
        raise Refusal(400, "unit_id is a unit of this set or null")
    why = _text(data.get("why") or "", LIMITS["why"], "why", line=True)
    base_rev = _rev(data.get("base_rev"))
    memos = [o for o in ops if o.get("op") == "memo"]
    if memos and not why:
        raise Refusal(400, "a memo needs its text in why")
    draft_t, log_t = _edit_targets(ctx)
    with locked(draft_t):
        ctx = open_set(vault, data.get("project"), data.get("set"))
        _, sha, _, items = _read_codebook(ctx["cb_real"])
        fixed = _fixed(ctx["man"], family(ctx["root"], ctx["cb_real"]))
        entries, changed, draft, bad = [{"op": "memo"} for _ in memos[:1]], False, None, None
        if len(memos) < len(ops):
            try:
                draft = _read_draft(draft_t)
            except BadDraft as e:
                return _refuse_unreadable(e)
            if base_rev != (draft["rev"] if draft else 0):
                return _conflict(ctx, draft, items, sha, fixed)
            changed = draft is None
            draft = draft or _new_draft(items, ctx["man"], sha)
            base_labels = [_label_of(c) for c in items if isinstance(c, dict)]
            for op in ops:
                if op.get("op") != "memo" and _apply(op, draft, fixed, base_labels, entries):
                    changed = True
            if changed:
                draft["rev"] += 1
                draft["updated"] = _now()
                _write_draft(draft_t, draft)
        else:
            try:
                draft = _read_draft(draft_t)
            except BadDraft as e:
                bad = _unreadable(e)
        added = []
        if entries:
            log, first = _log_open(log_t)
            added = _log_add(log, first + entries, draft["rev"] if draft else 0, uid, why)
            _write_bytes(log_t, _log_bytes(log))
        if draft:
            owner, _ = owner_records(ctx)
            return 200, {"ok": True, "draft": _draft_view(ctx, draft, items, sha, owner, fixed), "log_added": added}
        return 200, {"ok": True, "draft": bad, "log_added": added}


def _aside(path, tail):
    """Move a file beside itself as <stem>.<today><tail>.json. Never over another, until the
    day holds ASIDE_MAX of them: then the oldest of that day is the one replaced."""
    stem = "%s.%s%s" % (path.name[:-5], _today(), tail)
    names = [path.with_name("%s%s.json" % (stem, "" if n == 1 else ".%d" % n)) for n in range(1, ASIDE_MAX + 1)]
    for dest in names:
        try:
            os.link(path, dest, follow_symlinks=False)
        except FileExistsError:
            continue
        os.unlink(path)
        _sync_dir(path.parent)
        return dest
    dest = min(names, key=lambda p: os.lstat(p).st_mtime_ns)
    os.replace(path, dest)
    _sync_dir(path.parent)
    return dest


def _chain(history, base, sha):
    """The promotions that lead from the file a draft began on to the one in use, or None."""
    for i in range(len(history) - 1, -1, -1):
        tail = history[i:]
        if (tail[0].get("from_sha256") == base and tail[-1].get("sha256") == sha
                and all(a.get("sha256") == b.get("from_sha256") for a, b in zip(tail, tail[1:]))):
            return tail
    return None


def _archive_at(root, cb, rel):
    """archive/<stem>.<date>[.n].json beside the codebook, for a path a manifest or a note
    names: built here from its last part, and a plain file in a plain folder when it is there."""
    name = Path(rel).name if isinstance(rel, str) and rel else ""
    p = cb.parent / "archive" / name
    if (not re.fullmatch(r"%s\.\d{4}-\d\d-\d\d(\.\d{1,3})?\.json" % re.escape(cb.stem), name)
            or rel != p.relative_to(root).as_posix()):
        raise Refusal(400, "the archive is not archive/%s.<date>.json beside the codebook" % cb.stem)
    for q, kind in ((p.parent, stat.S_ISDIR), (p, stat.S_ISREG)):
        if os.path.lexists(q) and not kind(os.lstat(q).st_mode):
            raise Refusal(400, "the archive is not a plain file in a plain folder")
    return p


def _old_codes(root, cb, entry, base):
    """The codes of the file a draft began on, from the archive its promotion kept."""
    try:
        arch = _archive_at(root, cb, entry.get("archive"))
        raw = arch.read_bytes() if os.lstat(arch).st_size <= CAP_CODEBOOK else b""
        obj = json.loads(raw.decode("utf-8")) if hashlib.sha256(raw).hexdigest() == base else None
        items = obj.get("codes") if isinstance(obj, dict) else obj
        if isinstance(items, list):
            return [c for c in items if isinstance(c, dict)]
    except (Refusal, OSError, ValueError):
        pass
    raise NoRebase(409, "the archive of the codebook this draft began on is missing or changed, so what the "
                        "draft changed cannot be told; %s" % REDO)


REDO = "discard the draft and re-apply the edits (the Changes log still lists them)"
ARCHIVE_SCAN = 500
TMP_AGE_S = 600


def _archived(cb, base):
    """Why a draft's base is a file a promotion replaced, or "": archive/ beside the codebook
    holds a copy of it. Plain files only, the newest ARCHIVE_SCAN names."""
    d = cb.parent / "archive"
    try:
        if not stat.S_ISDIR(os.lstat(d).st_mode):
            return ""
        names = sorted((e.name for e in os.scandir(d)
                        if e.name.startswith(cb.stem + ".") and e.name.endswith(".json")), reverse=True)
    except OSError:
        return ""
    for name in names[:ARCHIVE_SCAN]:
        try:
            st = os.lstat(d / name)
            if (stat.S_ISREG(st.st_mode) and st.st_size <= CAP_CODEBOOK
                    and hashlib.sha256((d / name).read_bytes()).hexdigest() == base):
                return "a promotion replaced the codebook this draft began on and its history cannot be followed"
        except OSError:
            continue
    return ""


def _his_fields(draft, log, was):
    lines, err = log
    untold = "so what this draft changed cannot be told; discard the draft and re-apply the edits"
    if err:
        raise NoRebase(409, "the change log cannot be read (%s), %s" % (err, untold))
    kept, made = draft.get("mine"), draft.get("created")
    if not isinstance(kept, dict):
        # a draft rebased before `mine` was kept: every line counts
        kept, made = {}, None if "reverts" in draft else made
    his = {(cid, f) for src in (kept, was) for cid, fs in src.items() if isinstance(fs, list)
           for f in fs if isinstance(f, str)}
    for e in lines:
        if not isinstance(e, dict) or (_is_ts(made) and _is_ts(e.get("ts")) and e["ts"] < made):
            continue
        if e.get("op") == "log_aside":
            raise NoRebase(409, "the change log was set aside since this draft began, %s" % untold)
        if e.get("op") == "set" and isinstance(e.get("code"), str) and isinstance(e.get("field"), str):
            his.add((e["code"], e["field"]))
    return his


def _onto_hand_edit(draft, now, his, carried):
    codes, reverts, mine = [], {}, {}
    for c in draft["codes"]:
        cid, f, code = c["_id"], now.get(c["_id"]), json.loads(json.dumps(c))
        own = sorted(k for i, k in his if i == cid)
        if f is not None:
            for k in _fields_changed(c, f):
                if k in own:
                    reverts.setdefault(cid, []).append(k)
                elif k in f:
                    code[k] = json.loads(json.dumps(f[k]))
                else:
                    code.pop(k, None)
            if own:
                mine[cid] = own
        codes.append(code)
    have, prev = {c["_id"] for c in codes}, None
    for lab, f in now.items():
        if lab not in have:
            i = next((i + 1 for i, x in enumerate(codes) if x["_id"] == prev), 0)
            codes.insert(i, dict({"_id": lab}, **json.loads(json.dumps(f))))
        prev = lab
    removed, seen = list(draft["removed"]), {}
    for c in codes:
        if c["_id"] not in removed and seen.setdefault(_fold(_label_of(c)), c) is not c:
            raise NoRebase(409, "the codebook file gained the label %s, which a code of this draft has; rename "
                                "yours in the draft, then keep the draft again" % _label_of(c))
    live = {c["_id"] for c in codes} - set(removed)
    orphan = sorted(x for x in carried if x in now and x not in live)
    if orphan:
        raise NoRebase(409, "records carry %s, which this draft would leave out of the codebook; %s"
                       % (orphan[0], REDO))
    return codes, removed, reverts, mine


def _since(draft, version, hists):
    """With no chain to follow: why a promotion may have landed since the draft began, or "".
    Judged by where the draft's base stands in each history, else by the entries' times."""
    based, made = draft["based_on"], draft.get("created")
    if str(based.get("version") or "") != version:
        return "the codebook version changed since this draft began"
    for hist in hists:
        at = [i for i, h in enumerate(hist) if h.get("sha256") == based["sha256"]]
        late = any(h.get("from_sha256") == based["sha256"] for h in hist) or (at and at[-1] != len(hist) - 1)
        if not at and hist:
            late = late or not _is_ts(made) or any(str(h.get("promoted_at") or "~") > made for h in hist)
        if late:
            return "a promotion landed since this draft began and its history cannot be followed"
    return ""


def _rebase(root, cb, draft, items, sha, man, hists, carried, log=((), "")):
    _draftable(items)
    now, gone = {_label_of(c): c for c in items}, set(draft["removed"])
    base = draft["based_on"]["sha256"]
    was = draft.get("reverts") if isinstance(draft.get("reverts"), dict) else {}
    chain = _chain(man["history"], base, sha)
    if chain is None:
        # draft wins only for a file changed by hand, with no promotion since the draft began
        why = _since(draft, man["codebook_version"], hists) or _archived(cb, base)
        if why:
            raise NoRebase(409, "%s; %s" % (why, REDO))
        lost = [c["_id"] for c in draft["codes"] if c["_id"] not in now and not NEW_ID_RE.match(c["_id"])]
        if lost:
            raise NoRebase(409, "the codebook file changed outside the pane and no longer has %s; %s" % (lost[0], REDO))
        return _onto_hand_edit(draft, now, _his_fields(draft, log, was), carried)
    old = {_label_of(c): c for c in _old_codes(root, cb, chain[0], base)}
    at = {}
    for lab in old:
        at[lab] = lab
        for h in chain:
            ren = h.get("renamed") if isinstance(h.get("renamed"), dict) else {}
            if at[lab] in _strs(h.get("removed")):
                at[lab] = None
                break
            if isinstance(ren.get(at[lab]), str):
                at[lab] = ren[at[lab]]
    if any(cur is not None and cur not in now for cur in at.values()):
        raise NoRebase(409, "the history of this codebook and the file in use do not agree; %s" % REDO)
    taken = set(now) | set(old) | {c["_id"] for c in draft["codes"]}

    def fresh():
        n = 1
        while "new-%d" % n in taken:
            n += 1
        taken.add("new-%d" % n)
        return "new-%d" % n
    codes, removed, held, reverts, kept = [], [], set(), {}, {}
    for c in draft["codes"]:
        cid, lab, b, out = c["_id"], _label_of(c), old.get(c["_id"]), c["_id"] in gone
        mine = _fields_changed(c, b) if b is not None else []
        if b is None:
            nid, code = (fresh() if cid in now else cid), c
        elif at[cid] is None or at[cid] in held:
            nid, code, out = fresh(), c, out or not (mine or lab != cid)
        else:
            nid = at[cid]
            held.add(nid)
            f = now[nid]
            code = json.loads(json.dumps(f))
            for k in mine:
                if k in c:
                    code[k] = c[k]
                else:
                    code.pop(k, None)
            both = [k for k in mine if not _same(k, f.get(k, _MISSING), b.get(k, _MISSING))
                    and not _same(k, c.get(k, _MISSING), f.get(k, _MISSING))]
            prior = was.get(cid) if isinstance(was.get(cid), list) else []
            both += [k for k in prior if k in mine and k not in both]
            if both:
                reverts[nid] = both
            if mine:
                kept[nid] = mine
            code[_label_key(code)] = nid if lab == cid else lab
        codes.append(dict({"_id": nid}, **{k: v for k, v in code.items() if k != "_id"}))
        if out:
            removed.append(nid)
    prev = None
    for lab, c in now.items():
        if lab not in held:
            i = next((i + 1 for i, x in enumerate(codes) if x["_id"] == prev), 0)
            codes.insert(i, dict({"_id": lab}, **json.loads(json.dumps(c))))
        prev = lab
    seen = {}
    for c in codes:
        if c["_id"] not in removed and seen.setdefault(_fold(_label_of(c)), c) is not c:
            raise NoRebase(409, "since this draft began a promotion gave the label %s to another code; rename "
                                "yours in the draft, then keep the draft again" % _label_of(c))
    return codes, removed, reverts, kept


def _carried(root, sids):
    """Every label the passes and reviews of these sets hold."""
    out = set()
    for sid in sids:
        f = _set_files(root, sid)
        for key, is_pass in (("pass", True), ("reviews", False)):
            out |= {x for x in _renamed_bytes(f[key], {}, is_pass)[1] if isinstance(x, str)}
    return out


def _draft_step(vault, data, op):
    """discard and rebase: the draft, checked against base_rev, under the lock."""
    ctx = open_set(vault, data.get("project"), data.get("set"))
    base_rev = _rev(data.get("base_rev"))
    draft_t, log_t = _edit_targets(ctx)
    with locked(draft_t):
        ctx = open_set(vault, data.get("project"), data.get("set"))
        _, sha, _, items = _read_codebook(ctx["cb_real"])
        mans, broken = _family(ctx["root"], ctx["cb_real"])
        fixed = _fixed(ctx["man"], mans)
        try:
            draft = _read_draft(draft_t)
        except BadDraft as e:
            if op != "discard":
                return _refuse_unreadable(e)
            # a draft that cannot be read has no rev to check: it is set aside as it is
            draft = {"rev": base_rev}
        if draft is None:
            raise Refusal(400, "there is no draft")
        if base_rev != draft["rev"]:
            return _conflict(ctx, draft, items, sha, fixed)
        more, added = {}, []
        if op == "discard":
            more["moved_to"] = _aside(draft_t, "").name
            entry, draft = {"op": "discard", "after": more["moved_to"]}, None
        elif draft["based_on"]["sha256"] == sha:
            entry = None
        else:
            raws = [b["raw"].get("codebook_history") for b in broken if b["shares"]]
            hists = [m["history"] for m in mans] + [[h for h in r if isinstance(h, dict)] for r in raws
                                                    if isinstance(r, list)]
            try:
                codes, removed, reverts, mine = _rebase(
                    ctx["root"], ctx["cb_real"], draft, items, sha, ctx["man"], hists,
                    _carried(ctx["root"], [m["id"] for m in mans]), _log_read(log_t))
            except NoRebase as e:
                return _conflict(ctx, draft, items, sha, fixed, stale=True, cannot_rebase=True, error=_scrub(e.msg))
            entry = {"op": "rebase", "before": draft["based_on"]["sha256"], "after": sha,
                     "reverts": {_label_of(c): reverts[c["_id"]] for c in codes if c["_id"] in reverts}}
            draft.update(codes=codes, removed=removed, reverts=reverts, mine=mine, created=_now(),
                         based_on={"version": ctx["man"]["codebook_version"], "sha256": sha})
            draft["rev"] += 1
            draft["updated"] = _now()
            _write_draft(draft_t, draft)
        if entry:
            log, first = _log_open(log_t)
            added = _log_add(log, first + [entry], draft["rev"] if draft else base_rev, None, "")
            _write_bytes(log_t, _log_bytes(log))
        owner, _ = owner_records(ctx)
        return 200, dict({"ok": True, "draft": _draft_view(ctx, draft, items, sha, owner, fixed) if draft else None,
                          "log_added": added}, **more)


def codebook_discard(vault, data):
    return _draft_step(vault, data, "discard")


def codebook_rebase(vault, data):
    return _draft_step(vault, data, "rebase")


def _promote_target(root, man):
    """The codebook file a promotion may replace: a plain .json under replication/, no link in its path."""
    real, _ = confine(root, man["codebook"], CAP_CODEBOOK, "codebook")
    if real != root / man["codebook"].strip() or not stat.S_ISREG(os.lstat(real).st_mode):
        raise Refusal(400, "codebook: a linked path cannot be promoted")
    if real.suffix != ".json" or real.relative_to(root).parts[0] != "replication":
        raise Refusal(400, "codebook: promotion needs a .json file under replication/")
    return real


def _manifest_target(root, set_id):
    real, _ = confine(root, "%s/%s.json" % (SETS_DIR, set_id), CAP_MANIFEST, "set")
    if real != root / SETS_DIR / (set_id + ".json") or not stat.S_ISREG(os.lstat(real).st_mode):
        raise Refusal(400, "set: a linked manifest cannot be rewritten")
    return real


def _archive_dir(cb):
    d = cb.parent / "archive"
    try:
        os.mkdir(d)
    except FileExistsError:
        pass
    if not stat.S_ISDIR(os.lstat(d).st_mode) or d.resolve() != d:
        raise Refusal(400, "codebook: archive is not a plain folder beside it")
    return d


def _archive_name(cb):
    """A free name in archive/ beside the codebook, built here -> its path."""
    d = _archive_dir(cb)
    for n in range(1, 1000):
        dest = d / ("%s.%s%s.json" % (cb.stem, _today(), "" if n == 1 else ".%d" % n))
        if not os.path.lexists(dest):
            return dest
    raise Refusal(500, "codebook: too many archives today")


def _sweep_tmp(cb):
    """Temp files a kill inside _archive_copy left in archive/, once TMP_AGE_S old. The name
    is the one built there; plain files only."""
    d = cb.parent / "archive"
    name = re.compile(r"\.%s\.[A-Za-z0-9_]{6,12}\.tmp" % re.escape(cb.name))
    try:
        if not stat.S_ISDIR(os.lstat(d).st_mode):
            return
        for e in os.scandir(d):
            if (name.fullmatch(e.name) and e.is_file(follow_symlinks=False)
                    and time.time() - e.stat(follow_symlinks=False).st_mtime > TMP_AGE_S):
                _forget(Path(e.path))
    except OSError:
        return


def _archive_copy(cb, raw, dest):
    """The old codebook at `dest` in archive/, never over another file."""
    d = _archive_dir(cb)
    fd, tmp = tempfile.mkstemp(dir=str(d), prefix="." + cb.name + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(raw)
            fh.flush()
            os.fsync(fh.fileno())
        os.chmod(tmp, stat.S_IMODE(os.lstat(cb).st_mode))
        os.link(tmp, dest)
        _sync_dir(d)
    finally:
        os.unlink(tmp)


def _dump_like(text, obj):
    """obj as JSON in the layout `text` has: its indent, or one line, and its last newline."""
    m = re.search(r"\n([ \t]+)\S", text)
    if m:
        out = json.dumps(obj, indent=m.group(1), ensure_ascii=False)
    else:
        seps = (", ", ": ") if re.search(r'":\s', text) else (",", ":")
        out = json.dumps(obj, separators=seps, ensure_ascii=False)
    return (out + ("\n" if text.endswith("\n") else "")).encode("utf-8")


def _manifest_bytes(path, set_id, change):
    """The manifest re-read with `change` applied, in its own layout -> (old bytes, new bytes)."""
    raw = path.read_bytes()
    try:
        m = json.loads(raw.decode("utf-8"))
    except ValueError:
        m = None
    if not isinstance(m, dict) or m.get("id") != set_id:
        raise Refusal(500, "the manifest of %s is not that set's; not overwriting it" % set_id)
    change(m)
    data = _dump_like(raw.decode("utf-8"), m)
    if len(data) > CAP_MANIFEST:
        raise Refusal(400, "the manifest of %s would be too large" % set_id)
    return raw, data


def set_codebook_lock(vault, project, set_id, value):
    """Lock and unlock: one key of the set's manifest, nothing else."""
    root = project_root(vault, project)
    load_manifest(root, set_id)
    if value is not False:
        value = _text(value, 240, "reason", line=True) or True
    path = _manifest_target(root, set_id)
    with locked(path):
        _write_bytes(path, _manifest_bytes(path, set_id, lambda m: m.__setitem__("codebook_locked", value))[1])
    return load_manifest(root, set_id)


def _none_of(v, ren, gone):
    """A derived rule's none_of after a promotion: a renamed label follows its code, a removed one goes."""
    if isinstance(v, list):
        return [ren.get(x, x) if isinstance(x, str) else x for x in v if not (isinstance(x, str) and x in gone)]
    if isinstance(v, str) and v != "*":
        return ren.get(v, [] if v in gone else v)
    return v


def _rules(m):
    derived = m.get("derived") if isinstance(m.get("derived"), dict) else {}
    return [(k, r) for k, r in derived.items() if isinstance(r, dict) and "none_of" in r]


def _keeps_rules(m, set_id, ren, gone):
    for name, rule in _rules(m):
        if rule["none_of"] not in ([], "*") and _none_of(rule["none_of"], ren, gone) == []:
            raise Refusal(400, "the derived code %s of set %s would be left with nothing in none_of; change "
                               "that rule in the set first" % (_clean(name), set_id))


def _bump(m, version, entry, ren, gone):
    """What a promotion changes in a manifest: the version, the history, and none_of in its
    derived rules. No other key of a rule is read or written."""
    hist = m.get("codebook_history", [])
    if not isinstance(hist, list):
        raise Refusal(500, "the codebook_history of set %s is not a list; not overwriting it" % _clean(m.get("id")))
    m["codebook_version"] = version
    m["codebook_history"] = hist + [entry]
    for _, rule in _rules(m):
        rule["none_of"] = _none_of(rule["none_of"], ren, gone)


def _rename_rows(rows, ren, pass_file):
    hit = False
    for r in rows:
        if not isinstance(r, dict):
            continue
        if not pass_file:
            if isinstance(r.get("code"), str) and r["code"] in ren:
                r["code"], hit = ren[r["code"]], True
            continue
        applied = r.get("codes_applied")
        if isinstance(applied, list) and any(isinstance(x, str) and x in ren for x in applied):
            r["codes_applied"], hit = [ren.get(x, x) if isinstance(x, str) else x for x in applied], True
        for d in r.get("code_details") if isinstance(r.get("code_details"), list) else []:
            if isinstance(d, dict) and isinstance(d.get("code"), str) and d["code"] in ren:
                d["code"], hit = ren[d["code"]], True
    return hit


def _labels_in(rows, pass_file):
    out = set()
    for r in rows:
        if not isinstance(r, dict):
            continue
        if not pass_file:
            out.add(r.get("code"))
            continue
        out.update(x for x in r.get("codes_applied") or [] if isinstance(x, str))
        out.update(d.get("code") for d in r.get("code_details") or [] if isinstance(d, dict))
    return out


def _renamed_bytes(path, ren, pass_file):
    """A pass or reviews file with its labels renamed -> (old bytes, new bytes), or None when
    there is no file or nothing in it changes. Also the labels it carried."""
    if not os.path.lexists(path):
        return None, set()
    before, rows = path.read_bytes(), _read_list(path)
    carried = _labels_in(rows, pass_file)
    if not ren or not _rename_rows(rows, ren, pass_file):
        return None, carried
    return (before, (json.dumps(rows, indent=1, ensure_ascii=False) + "\n").encode("utf-8")), carried


def _fault(step):
    if _FAULT == step:
        raise _FAULT_EXC("fault at " + step)


def _sha_of(path):
    try:
        if not stat.S_ISREG(os.lstat(path).st_mode):
            return None
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError:
        return None


def _forget(path):
    try:
        path.unlink(missing_ok=True)
    except OSError:
        pass


def _saved_name(key):
    """The copy of a file as it was, kept beside the note while a promotion runs. `key` is
    "codebook" or "<set>/<man|pass|reviews|log>"."""
    return "codebook_promote.before.%s.json" % key.replace("/", ".")


def _where(key, cb):
    if key == "codebook":
        return "the codebook file %s" % cb.name
    sid, kind = key.split("/")
    return "set %s %s" % (sid, {"man": "manifest", "pass": PASS_NAME, "reviews": "reviews.json", "log": LOG_NAME}[kind])


def _undo(items, before_of, why=None):
    """Each (key, path, sha256 before) back as it was, the last written first -> the keys
    still wrong; `why` takes the error for each."""
    bad = []
    for key, path, want in reversed(items):
        if _sha_of(path) == want:
            continue
        try:
            if want is None:
                path.unlink(missing_ok=True)
            else:
                _write_bytes(path, before_of(key))
        except (OSError, Refusal) as e:
            if why is not None:
                why[key] = e
        if _sha_of(path) != want:
            bad.append(key)
    return bad


def _drop_saved(note, state):
    for key in state:
        _forget(note.with_name(_saved_name(key)))


def _saved(note, key, st, arch):
    """The bytes a file had before the promotion, from the copy beside the note; the
    codebook's also from the archive."""
    for p in [note.with_name(_saved_name(key))] + ([arch] if key == "codebook" else []):
        try:
            got = os.lstat(p)
            if stat.S_ISREG(got.st_mode) and got.st_size <= CAP_DATA:
                raw = p.read_bytes()
                if hashlib.sha256(raw).hexdigest() == st["before"]:
                    return raw
        except OSError:
            continue
    raise ByHand("%s is missing, changed or a link" % _saved_name(key))


def _read_intent(note):
    """The note's JSON, or None when it is gone. Hostile input: it is opened only as a plain
    file under CAP_INTENT, so a link, a pipe or a huge file costs one lstat."""
    try:
        st = os.lstat(note)
        if not stat.S_ISREG(st.st_mode) or st.st_size > CAP_INTENT:
            raise ByHand("it is not a plain file under %d MiB" % (CAP_INTENT >> 20))
        fd = os.open(note, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as fh:
            if not stat.S_ISREG(os.fstat(fd).st_mode):
                raise ByHand("it is not a plain file")
            raw = fh.read(CAP_INTENT + 1)
        return json.loads(raw.decode("utf-8"))
    except FileNotFoundError:
        return None
    except OSError as e:
        raise ByHand("it cannot be read, %s" % _plain(e))
    except ValueError:
        raise ByHand("it is not valid JSON, perhaps cut short")


def _was_label(x):
    return isinstance(x, str) and 0 < len(x) <= LIMITS["label"] and x == x.strip() and not CTRL_RE.search(x)


def _new_label(x):
    try:
        return isinstance(x, str) and _field_value("label", x, None) == x
    except Refusal:
        return False


def _is_text(v, cap, **kw):
    try:
        return isinstance(v, str) and _text(v, cap, "it", **kw) == v
    except Refusal:
        return False


def _is_sha(x):
    return isinstance(x, str) and bool(SHA_RE.fullmatch(x))


def _is_ts(x):
    return isinstance(x, str) and bool(TS_RE.fullmatch(x))


def _valid_intent(root, note, it):
    def need(ok, why):
        if not ok:
            raise ByHand(why)
    need(isinstance(it, dict) and it.get("schema") == 2, "it is not a note this server writes")
    sid, sets = it.get("set"), it.get("sets")
    need(isinstance(sid, str) and SET_RE.match(sid) and sid == note.parent.name, "its set is not the folder it lies in")
    try:
        cb = _promote_target(root, load_manifest(root, sid))
    except Refusal as e:
        raise ByHand("the manifest of %s: %s" % (sid, e.msg))
    try:
        named = confine(root, it.get("codebook"), CAP_CODEBOOK, "codebook")[0]
    except Refusal:
        named = None
    need(named == cb, "its codebook is not the one set %s names" % sid)
    need(isinstance(sets, list) and all(isinstance(x, str) and SET_RE.match(x) for x in sets)
         and sid in sets and len(set(sets)) == len(sets), "its sets are not set ids")
    mans, broken = _family(root, cb)
    if broken:
        raise Refusal(500, "the manifest of set %s cannot be read: %s" % (broken[0]["id"], broken[0]["why"]))
    fam = [m["id"] for m in mans]
    need(fam == sorted(x for x in sets if os.path.lexists(root / SETS_DIR / (x + ".json"))),
         "its sets are not the sets on this codebook now")
    old, new, version, rev = it.get("old_sha"), it.get("new_sha"), it.get("version"), it.get("rev")
    need(_is_sha(old) and _is_sha(new) and old != new, "its sha256 values are not two files")
    need(_is_text(version, LIMITS["version"], line=True, strict=True) and version.strip() == version != "",
         "its version is not a version label")
    need(type(rev) is int and rev > 0, "its rev is not a draft's")
    ren, removed = it.get("renamed"), it.get("removed")
    need(isinstance(ren, dict) and len(ren) <= 2000 and all(_was_label(k) and _new_label(x) for k, x in ren.items()),
         "renamed is not a map of labels")

    def labels(x):
        return isinstance(x, list) and len(x) <= 2000 and all(_was_label(y) for y in x)
    need(labels(removed), "removed is not a list of labels")
    to = [_fold(x) for x in ren.values()]
    need(len(set(to)) == len(to), "it renames two codes to labels that read the same")
    try:
        _, in_use, _, items = _read_codebook(cb)
    except Refusal as e:
        raise Refusal(500, "the codebook file: %s" % e.msg)
    have = [_label_of(c) for c in items if isinstance(c, dict)]
    if in_use == old:
        need(not any(_fold(x) in to and x not in ren for x in have), "it renames a code to a label another code has")
    elif in_use == new:
        need(len({_fold(x) for x in have}) == len(have) and set(ren.values()) <= set(have),
             "its renames are not the ones in the codebook file")
    try:
        arch = _archive_at(root, cb, it.get("archive"))
    except Refusal as e:
        raise ByHand(e.msg)
    e, line = it.get("entry"), it.get("log_entry")
    need(isinstance(e, dict) and labels(e.get("changed")) and labels(e.get("added")) and _is_ts(e.get("promoted_at"))
         and (e.get("version"), e.get("sha256"), e.get("from_sha256"), e.get("archive"), e.get("renamed"),
              e.get("removed")) == (version, new, old, it["archive"], ren, removed)
         and isinstance(e.get("from_version"), str) and len(e["from_version"]) <= CAP_MANIFEST
         and _is_text(e.get("note"), LIMITS["why"]), "its history entry is not one a promotion writes")
    entry = {"version": version, "sha256": new, "promoted_at": e["promoted_at"], "from_version": e["from_version"],
             "from_sha256": old, "archive": it["archive"], "changed": e["changed"], "added": e["added"],
             "removed": removed, "renamed": ren, "note": e["note"]}
    need(isinstance(line, dict) and isinstance(line.get("id"), str) and re.fullmatch("[0-9a-f]{8}", line["id"])
         and _is_ts(line.get("ts")) and line.get("op") == "promote" and line.get("after") == version
         and isinstance(line.get("before"), str) and len(line["before"]) <= LOG_TEXT_MAX
         and line.get("why") == e["note"], "its log line is not one a promotion writes")
    log_entry = {"id": line["id"], "ts": line["ts"], "rev": rev, "op": "promote", "code": None, "label": "",
                 "field": None, "before": line["before"], "after": version, "unit_id": None, "why": e["note"]}
    if line.get("truncated") is True:
        log_entry["truncated"] = True
    fm, roll = it.get("files"), it.get("rollback_incomplete")
    keys = {"codebook", sid + "/log"} | {"%s/%s" % (x, k) for x in sets for k in ("man", "pass", "reviews")}
    need(isinstance(fm, dict) and "codebook" in fm and set(fm) <= keys
         and all(isinstance(st, dict) and (st.get("before") is None or _is_sha(st["before"])) and _is_sha(st.get("after"))
                 and st.get("saved") == (None if st.get("before") is None else _saved_name(k)) for k, st in fm.items())
         and (fm["codebook"]["before"], fm["codebook"]["after"]) == (old, new), "its files are not this promotion's")
    need(it.get("state") in (None, "preparing", "working"), "its state is not one a promotion writes")
    need(roll is None or isinstance(roll, list) and all(
        isinstance(r, dict) and (r.get("set") is None or r.get("set") in sets) and isinstance(r.get("file"), str)
        and (r.get("want_sha256") is None or _is_sha(r["want_sha256"])) for r in roll),
         "its list of files to put back is not one")
    return {"set": sid, "sets": fam, "cb": cb, "old": old, "new": new, "version": version, "rev": rev, "ren": ren,
            "removed": removed, "entry": entry, "log_entry": log_entry, "arch": arch,
            "arch_ours": it.get("archive_created") is True, "files": fm, "undo": roll is not None,
            "preparing": it.get("state") == "preparing"}


def _concerns(root, note, it, only):
    """Whether a request for set `only` must settle this note first: the set of the note's
    folder, a set the note names, or a set on the same codebook file as the folder's. Two
    manifests are read for it, never the whole folder."""
    if only is None or only == note.parent.name:
        return True
    if isinstance(it, dict) and only in [it.get("set")] + (it["sets"] if isinstance(it.get("sets"), list) else []):
        return True

    def book(sid):
        raw = _raw_manifest(root, sid)[0] if isinstance(sid, str) and SET_RE.match(sid) else None
        try:
            return confine(root, (raw or {}).get("codebook"), CAP_CODEBOOK, "codebook")[0]
        except Refusal:
            return None
    mine = book(only)
    return mine is not None and mine == book(note.parent.name)


def _archive_named(root, rel):
    """Whether a history in any manifest of sets/ names this archive."""
    for name in _set_names(root):
        hist = (_raw_manifest(root, name)[0] or {}).get("codebook_history")
        if any(isinstance(h, dict) and h.get("archive") == rel for h in (hist if isinstance(hist, list) else [])):
            return True
    return False


def _recover(root, only=None):
    """Finish or undo a promotion a crash cut short: every coding folder is looked at for
    the note a promotion leaves before its first write. A note that cannot be acted on, or
    cannot be read at all, stops the sets it concerns and no other."""
    try:
        found = [Path(e.path) / INTENT_NAME for e in os.scandir(root / CODING_DIR)
                 if e.is_dir(follow_symlinks=False) and os.path.lexists(os.path.join(e.path, INTENT_NAME))]
    except OSError:
        return
    for note in found:
        rel, it = note.relative_to(root).as_posix(), None
        try:
            it = _read_intent(note)
            if it is None or not _concerns(root, note, it, only):
                continue
            _finish(root, note, _valid_intent(root, note, it))
        except Exception as e:
            if not _concerns(root, note, it, only):
                continue
            if isinstance(e, ByHand):
                raise Refusal(500, "%s is not acted on and must be removed by hand: %s" % (rel, _plain(e)))
            raise Refusal(500, "%s: the promotion it notes could not be finished: %s" % (rel, _plain(e)))


def _finish(root, note, v):
    files = {x: _set_files(root, x) for x in v["sets"]}
    cb, fm, own, ren = v["cb"], v["files"], files[v["set"]], v["ren"]
    with locked(cb, *[f[k] for f in files.values() for k in ("man", "pass", "reviews", "draft")]):
        if not os.path.lexists(note):
            return
        it = _read_intent(note)
        if it is None or _valid_intent(root, note, it) != v:
            raise Refusal(500, "the note changed while it was read")
        rank = {"codebook": 0, "pass": 1, "reviews": 1, "man": 2, "log": 3}
        keys = sorted((k for k in fm if k == "codebook" or k.split("/")[0] in files),
                      key=lambda k: rank[k.split("/")[-1]])
        now = _sha_of(cb)
        items = [(k, cb if k == "codebook" else files[k.split("/")[0]][k.split("/")[1]], fm[k]["before"])
                 for k in keys]
        if v["preparing"]:
            # cut short before its first write: only the copies and the note are there to remove
            odd = [k for k, p, want in items if _sha_of(p) != want]
            if odd:
                raise ByHand("%s is not as it was, though the note says nothing was written yet" % _where(odd[0], cb))
            _drop_saved(note, fm)
            _forget(note)
            return
        if v["undo"] or now == v["old"]:
            # back, never forward: an old codebook says nothing about the files written after it
            odd = [k for k, p, want in items if _sha_of(p) not in (want, fm[k]["after"])]
            if odd:
                raise ByHand("%s is neither as it was nor as the promotion left it" % _where(odd[0], cb))
            why = {}
            bad = _undo(items, lambda k: _saved(note, k, fm[k], v["arch"]), why)
            lost = [k for k in bad if isinstance(why.get(k), ByHand)]
            if lost:
                raise ByHand("%s; %s cannot be put back, and no later request can do it"
                             % (why[lost[0]].msg, _where(lost[0], cb)))
            if bad:
                raise Refusal(500, "%s could not be put back; the next request tries again"
                              % ", ".join(_where(k, cb) for k in bad[:3]))
            used = _archive_named(root, v["entry"]["archive"])
            if v["arch_ours"] and not used and _sha_of(v["arch"]) == v["old"]:
                _forget(v["arch"])
            _drop_saved(note, fm)
            _forget(note)
            return
        if now != v["new"]:
            raise ByHand("the codebook file is neither the old one nor the new one of that promotion")
        simple = not set(ren) & set(ren.values())
        for x in v["sets"]:
            for key, is_pass in (("pass", True), ("reviews", False)):
                path, state = files[x][key], fm.get("%s/%s" % (x, key))
                if not os.path.lexists(path) or not ren or (state and _sha_of(path) == state["after"]):
                    continue
                try:
                    rows = _read_list(path)
                except Refusal:
                    rows = None
                # a file another writer changed since takes the renames only when twice is safe:
                # no swap and no chain among them
                known = bool(state) and _sha_of(path) == state["before"]
                hit = rows is not None and bool(_labels_in(rows, is_pass) & set(ren))
                if rows is None or (not known and not simple and (state or hit)):
                    raise ByHand("%s is neither as it was nor as the promotion left it" % _where("%s/%s" % (x, key), cb))
                if _rename_rows(rows, ren, is_pass):
                    write_list(path, rows)
        for x in v["sets"]:
            try:
                m = json.loads(files[x]["man"].read_bytes().decode("utf-8"))
            except ValueError:
                m = {}
            hist = m.get("codebook_history") if isinstance(m, dict) else None
            if any(isinstance(h, dict) and h.get("sha256") == v["new"] for h in hist or []):
                continue
            _write_bytes(files[x]["man"], _manifest_bytes(files[x]["man"], x, lambda m: _bump(
                m, v["version"], v["entry"], ren, set(v["removed"])))[1])
        log, first = _log_open(own["log"])
        _log_add(log, first, v["rev"], None, "")
        have = any(isinstance(e, dict) and e.get("id") == v["log_entry"]["id"] for e in log)
        if not have:
            log.append(v["log_entry"])
        if first or not have:
            _write_bytes(own["log"], _log_bytes(log))
        try:
            draft = _read_draft(own["draft"])
        except BadDraft:
            draft = None
        if draft and draft["rev"] == v["rev"] and draft["based_on"]["sha256"] == v["old"]:
            _aside(own["draft"], ".promoted")
        _drop_saved(note, fm)
        _forget(note)


def codebook_promote(vault, data):
    ctx = open_set(vault, data.get("project"), data.get("set"))
    base_rev = _rev(data.get("base_rev"))
    root, sid = ctx["root"], ctx["man"]["id"]
    draft_t, log_t = _edit_targets(ctx)
    cb = _promote_target(root, ctx["man"])
    mans, broken = _family(root, cb)
    if broken:
        return _refuse_broken(broken)
    fam = [m["id"] for m in mans]
    files = {s: _set_files(root, s) for s in fam}
    with locked(cb, *[f[k] for f in files.values() for k in ("man", "pass", "reviews", "draft")]):
        ctx = open_set(vault, data.get("project"), data.get("set"))
        man = ctx["man"]
        mans, broken = _family(root, cb)
        if broken:
            return _refuse_broken(broken)
        if _promote_target(root, man) != cb or [m["id"] for m in mans] != fam:
            raise Refusal(409, "the sets on this codebook changed; read it again")
        others = [m for m in mans if m["id"] != sid]
        fixed = _fixed(man, others)
        raw, old_sha, obj, items = _read_codebook(cb)
        try:
            draft = _read_draft(draft_t)
        except BadDraft as e:
            return _refuse_unreadable(e)
        if draft is None:
            raise Refusal(400, "there is no draft to promote")
        hold = _held_by(man, others)
        if hold:
            return 423, {"ok": False, "locked": True, "lock_reason": hold["lock_reason"], "locked_by": hold["id"],
                         "error": "the codebook is locked"}
        if base_rev != draft["rev"]:
            return _conflict(ctx, draft, items, old_sha, fixed)
        if draft["based_on"]["sha256"] != old_sha:
            return _conflict(ctx, draft, items, old_sha, fixed, stale=True,
                             error="the codebook file changed under the draft; rebase first")
        _draftable(items)
        d = _diff(draft, items)
        if json.dumps(d["codes"]) == json.dumps(items):
            raise Refusal(400, "nothing differs from the file in use")
        version = _text(data.get("version"), LIMITS["version"], "version", line=True, strict=True)
        was = {str(h.get(k)) for m in mans for h in m["history"] for k in ("version", "from_version")
               if h.get(k) is not None} | {m["codebook_version"] for m in mans}
        if not version or version != version.strip() or version in was:
            raise Refusal(400, "version is a new label of 1 to %d characters" % LIMITS["version"])
        note = _text(data.get("note") or "", LIMITS["why"], "note")
        _outgoing(d, items)
        for c in d["codes"]:
            if not str(c.get("definition") or "").strip():
                raise Refusal(400, "every code needs a label and a definition")
        held = fixed & (set(d["removed"]) | set(d["renamed"]))
        if held:
            raise Refusal(400, "a manifest names %s as derived; it stays as it is" % sorted(held)[0])

        ren, gone = d["renamed"], set(d["removed"])
        plan, his = [], set()
        for s in fam:
            for key, is_pass in (("pass", True), ("reviews", False)):
                hit, carried = _renamed_bytes(files[s][key], ren, is_pass)
                his |= carried
                if hit:
                    plan.append(("%s/%s" % (s, key), files[s][key], hit[0], hit[1]))
        theirs = {}
        for m in mans:
            for name, c in m["coders"].items():
                try:
                    theirs.setdefault(name, set()).update(load_coder(root, name, c)[0]["codes"])
                except Refusal:
                    pass
        for lab in sorted(set(d["added_labels"]) | set(ren.values())):
            same = [k for k, v in ren.items() if v == lab]
            for name in sorted(theirs):
                if any(isinstance(x, str) and _fold(x) == _fold(lab) and x not in same for x in theirs[name]):
                    if lab in ren:
                        raise Refusal(400, "%s is carried by coder %s's pass; a swap cannot be applied there"
                                      % (lab, name))
                    raise Refusal(400, "the label %s is still on coder %s's pass for another code; pick a new one"
                                  % (lab, name))
            if any(isinstance(x, str) and _fold(x) == _fold(lab) for x in (his - set(ren)) | gone):
                raise Refusal(400, "the label %s is still on records coded for another code; pick a new one" % lab)

        if isinstance(obj, dict):
            key = "codebook_version" if "codebook_version" in obj or "version" not in obj else "version"
            new_obj = dict(obj, codes=d["codes"], **{key: version})
        else:
            new_obj = d["codes"]
        new = _dump_like(raw.decode("utf-8"), new_obj)
        if len(new) > CAP_CODEBOOK:
            raise Refusal(400, "the codebook would be too large")
        new_sha = hashlib.sha256(new).hexdigest()
        entry = {"version": version, "sha256": new_sha, "promoted_at": _now(),
                 "from_version": man["codebook_version"], "from_sha256": old_sha,
                 "archive": (cb.parent / "archive" / ("%s.%s.999.json" % (cb.stem, _today()))).relative_to(root).as_posix(),
                 "changed": d["changed"], "added": d["added_labels"], "removed": d["removed"], "renamed": ren,
                 "note": note}
        # every manifest is built once here, so one too large or a rule left empty refuses before any write
        for s in fam:
            _manifest_bytes(files[s]["man"], s, lambda m: (_keeps_rules(m, s, ren, gone),
                                                         _bump(m, version, entry, ren, gone)))
        log, log_error = _log_read(log_t)
        if log_error:
            raise Refusal(409, "the change log cannot be read (%s); add a memo, which sets it aside, then promote"
                          % log_error)
        log_before = log_t.read_bytes() if log_t.exists() else None
        log_entry, = _log_add(log, [{"op": "promote", "before": man["codebook_version"], "after": version}],
                              draft["rev"], None, note)
        log_after = _log_bytes(log)
        intent_t = _write_target(root, sid, INTENT_NAME)
        if os.path.lexists(intent_t):
            raise Refusal(409, "an earlier promotion of this set is not finished; open the set again")
        # copies with no note, left by a promotion from before the note came first
        for p in intent_t.parent.glob("codebook_promote.before.*"):
            _forget(p)
        _sweep_tmp(cb)
        keys = ["codebook"] + [p[0] for p in plan] + ["%s/man" % s for s in fam] + ["%s/log" % sid]
        saved = {k: _write_target(root, sid, _saved_name(k)) for k in keys}
        # the archive's name goes into the note; the copy is made after it, so a crash leaves no stray one
        arch, archived = _archive_name(cb), False
        entry["archive"] = arch.relative_to(root).as_posix()
        mplan = [("%s/man" % s, files[s]["man"]) + _manifest_bytes(
            files[s]["man"], s, lambda m: _bump(m, version, entry, ren, gone)) for s in fam]
        # every file this promotion writes, in the order it writes them: key, path, before, after
        writes = [("codebook", cb, raw, new)] + plan + mplan + [("%s/log" % sid, log_t, log_before, log_after)]
        state = {k: {"before": None if b is None else hashlib.sha256(b).hexdigest(),
                     "after": hashlib.sha256(a).hexdigest(), "saved": None if b is None else _saved_name(k)}
                 for k, _, b, a in writes}
        intent = {"schema": 2, "set": sid, "sets": fam, "codebook": man["codebook"].strip(), "old_sha": old_sha,
                  "new_sha": new_sha, "version": version, "renamed": ren, "removed": d["removed"], "entry": entry,
                  "archive": entry["archive"], "archive_created": True, "rev": draft["rev"],
                  "log_entry": log_entry, "files": state, "state": "preparing"}

        def note_bytes():
            return (json.dumps(intent, indent=1, ensure_ascii=False) + "\n").encode("utf-8")

        step = "2, the note of what is about to change"
        try:
            # the note first, so a crash never leaves copies without it
            _write_bytes(intent_t, note_bytes())
            # how each file was, beside the note: what a later request puts back if this one cannot
            for k, path, before, _ in writes:
                if before is not None:
                    _write_bytes(saved[k], before, stat.S_IMODE(os.lstat(path).st_mode))
            intent["state"] = "working"
            _write_bytes(intent_t, note_bytes())
            _archive_copy(cb, raw, arch)
            archived = True
            if _sha_of(arch) != old_sha:
                raise OSError("the archive copy does not match")
            _fault("intent")
            step = "3, the codebook file"
            _write_bytes(cb, new)
            if _sha_of(cb) != new_sha:
                raise OSError("the codebook did not land")
            _fault("codebook")
            step = "4, the labels in the passes and reviews"
            for _, path, _, after in plan:
                _write_bytes(path, after)
            _fault("pass")
            step = "5, the manifests"
            for k, path, _, after in mplan:
                _write_bytes(path, after)
                load_manifest(root, k.split("/")[0])
            _fault("manifest")
            step = "6, the log and the draft"
            _write_bytes(log_t, log_after)
            _fault("log")
            _aside(draft_t, ".promoted")
        except Exception as e:
            befores = {k: b for k, _, b, _ in writes}
            # the note says "rolling back" before anything is put back, so recovery never goes forward
            intent["rollback_incomplete"], noted = [], True
            try:
                _write_bytes(intent_t, note_bytes())
            except OSError:
                noted = False
            bad = _undo([(k, path, state[k]["before"]) for k, path, _, _ in writes], befores.get)
            if bad:
                # the note stays, with the archive and the copies: the next request on these sets tries again
                paths = {k: path for k, path, _, _ in writes}
                intent["rollback_incomplete"] = [
                    {"set": None if k == "codebook" else k.split("/")[0], "file": paths[k].name,
                     "want_sha256": state[k]["before"]} for k in bad]
                try:
                    _write_bytes(intent_t, note_bytes())
                    noted = True
                except OSError:
                    pass
                if not noted:
                    return 500, {"ok": False, "restored": False, "error": _scrub(
                        "promotion failed; the next request finishes or undoes it (step %s: %s)" % (step, _plain(e)))}
                return 500, {"ok": False, "restored": False, "error": _scrub(
                    "promotion failed; NOT put back: %s; the next request tries again (step %s: %s)"
                    % (", ".join(_where(k, cb) for k in bad[:3]), step, _plain(e)))}
            if archived:
                _forget(arch)
            _drop_saved(intent_t, state)
            _forget(intent_t)
            return 500, {"ok": False, "restored": True, "error": _scrub(
                "promotion failed at step %s (%s); every file was put back" % (step, _plain(e)))}
        _drop_saved(intent_t, state)
        _forget(intent_t)

    counts = {}
    for s in fam:
        try:
            c = open_set(vault, data.get("project"), s)
            owner, _ = owner_records(c)
            of = revisit_reader(c)
            counts[s] = sum(1 for u in c["units"]["ids"] if of(owner.get(u)))
        except Refusal:
            counts[s] = None
    return 200, {"ok": True, "version": version, "sha256": new_sha, "archive": entry["archive"],
                 "revisit_count": counts.get(sid), "revisit_counts": counts,
                 "shared_with": [m["id"] for m in others]}


CODEBOOK_POSTS = {"/w/panel/coding/codebook/edit": codebook_edit,
                  "/w/panel/coding/codebook/discard": codebook_discard,
                  "/w/panel/coding/codebook/rebase": codebook_rebase,
                  "/w/panel/coding/codebook/promote": codebook_promote}


# -- dispatch ---------------------------------------------------------------------
def handle_get(vault, path, q):
    def one(k):
        return (q.get(k) or [""])[0].strip()
    try:
        if path == "/w/panel/coding/sets":
            return 200, list_sets(vault, one("project") or None)
        if path == "/w/panel/coding/set":
            try:
                off, lim = int(one("offset") or 0), int(one("limit") or PAGE_DEFAULT)
            except ValueError:
                raise Refusal(400, "offset and limit are numbers")
            return 200, set_view(vault, one("project"), one("set"), one("filter"), one("q")[:200], off, lim)
        if path == "/w/panel/coding/unit":
            return 200, unit_view(vault, one("project"), one("set"), (q.get("unit") or [""])[0],
                                  one("reveal") == "1")
        if path == "/w/panel/coding/agreement":
            return 200, agreement(open_set(vault, one("project"), one("set")))
        if path == "/w/panel/coding/codebook":
            return 200, codebook_view(vault, one("project"), one("set"))
        if path in ("/w/panel/coding/save", "/w/panel/coding/review") or path in CODEBOOK_POSTS:
            return 405, {"ok": False, "error": "POST only"}
    except Refusal as e:
        return e.code, {"ok": False, "error": _scrub(e.msg)}
    except Exception as e:
        return 500, {"ok": False, "error": "coding: %s" % _scrub(type(e).__name__)}
    return 404, {"ok": False, "error": "unknown coding route"}


def handle_post(vault, path, data):
    if not isinstance(data, dict):
        return 400, {"ok": False, "error": "body must be an object"}
    try:
        if path == "/w/panel/coding/save":
            return save(vault, data)
        if path == "/w/panel/coding/review":
            return review(vault, data)
        if path in CODEBOOK_POSTS:
            return CODEBOOK_POSTS[path](vault, data)
    except Refusal as e:
        return e.code, {"ok": False, "error": _scrub(e.msg)}
    except Exception as e:
        return 500, {"ok": False, "error": "coding: %s" % _scrub(type(e).__name__)}
    return 404, {"ok": False, "error": "unknown coding route"}
