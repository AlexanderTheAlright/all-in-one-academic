#!/usr/bin/env python3
import copy
import json
import os
import re
import threading
import time
from pathlib import Path

ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
PHOTO_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,120}\.(jpg|jpeg|png|webp)$")
HYGIENE = ("valuables", "clean", "wet/used", "gear")
STATUS = ("idea", "chosen", "bought", "in use", "dropped")
PROPOSAL_KINDS = ("product", "carry")
ZONE_KINDS = ("space", "hook")
# App views a subsystem may open instead of holding places (domain.json "app")
APPS = ("learning", "reading", "calendar", "notes")
MAX_STR = 200
MAX_NOTE = 1000
MAX_LIST = 200
MAX_CM = 1000.0
PHOTO_TYPES = {"jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png", "webp": "image/webp"}
PHOTO_MAX = 15 * 1024 * 1024

_LOCK = threading.Lock()


# ---------------------------------------------------------------- small helpers

def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", str(s or "").lower()).strip("-")[:64] or "x"


def _uniq(base, taken):
    base = slug(base)
    if base not in taken:
        return base
    n = 2
    while f"{base}-{n}"[:64] in taken:
        n += 1
    return f"{base}-{n}"[:64]


def _id(v, what):
    if not isinstance(v, str) or not ID_RE.match(v):
        raise ValueError(f"bad {what} id")
    return v


def _str(v, what, limit=MAX_STR, required=False):
    if v is None:
        v = ""
    if not isinstance(v, str):
        raise ValueError(f"{what} must be text")
    v = v.strip()
    if len(v) > limit:
        raise ValueError(f"{what} too long")
    if any(ord(c) < 32 and c not in "\n\t" for c in v):
        raise ValueError(f"{what} has control characters")
    if required and not v:
        raise ValueError(f"{what} required")
    return v


def _cm(v, what, allow_zero=False):
    """-> {"cm": float, "estimated": bool[, "source": str]}. Accepts a number or that
    dict. `source` (a URL or a line of text) says where the number came from."""
    est = True
    source = ""
    if isinstance(v, dict):
        est = v.get("estimated", True)
        if not isinstance(est, bool):
            raise ValueError(f"{what}.estimated must be true or false")
        source = _str(v.get("source"), f"{what}.source", 500)
        v = v.get("cm")
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise ValueError(f"{what} must be a number of cm")
    v = float(v)
    if v != v or v < 0 or v > MAX_CM or (v == 0 and not allow_zero):
        raise ValueError(f"{what} out of range")
    out = {"cm": round(v, 1), "estimated": est}
    if source:
        out["source"] = source
    return out


def _size(v, what):
    """optional {w, d, h} -> dict of _cm, or None"""
    if v in (None, "", {}):
        return None
    if not isinstance(v, dict):
        raise ValueError(f"{what} must be {{w, d, h}}")
    out = {}
    for k in ("w", "d", "h"):
        if v.get(k) in (None, ""):
            raise ValueError(f"{what}.{k} required")
        out[k] = _cm(v[k], f"{what}.{k}")
    return out


def _list(v, what):
    if v is None:
        return []
    if not isinstance(v, list) or len(v) > MAX_LIST:
        raise ValueError(f"{what} must be a list of at most {MAX_LIST}")
    return v


def _confined(root, *parts):
    root = Path(root).resolve()
    p = root.joinpath(*parts).resolve()
    if p != root and root not in p.parents:
        raise ValueError("path outside the systems folder")
    return p


def _read(path):
    try:
        v = json.loads(Path(path).read_text(encoding="utf-8"))
        return v if isinstance(v, dict) else None
    except Exception:
        return None


def _write(path, obj):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(obj, indent=1, ensure_ascii=False) + "\n"
    if path.exists():
        try:
            (path.parent / ("." + path.name + ".prev")).write_bytes(path.read_bytes())
        except Exception:
            pass
    tmp = path.parent / ("." + path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(str(tmp), str(path))


# ---------------------------------------------------------------- files

def domain_path(root, domain):
    return _confined(root, _id(domain, "domain"), "domain.json")


def instance_path(root, domain, instance):
    _id(instance, "instance")
    if instance == "domain":
        raise ValueError("bad instance id")
    return _confined(root, _id(domain, "domain"), instance + ".json")


def _domains(root):
    out = []
    try:
        dirs = sorted(p for p in Path(root).iterdir() if p.is_dir())
    except Exception:
        return out
    for d in dirs:
        if not ID_RE.match(d.name):
            continue
        meta = _read(d / "domain.json")
        if meta is None:
            continue
        meta["id"] = d.name
        out.append(meta)
    out.sort(key=lambda m: (m.get("order", 99) if isinstance(m.get("order"), (int, float)) else 99,
                            str(m.get("name", ""))))
    return out


def _instances(root, domain):
    out = []
    try:
        files = sorted(Path(root, domain).glob("*.json"))
    except Exception:
        return out
    for f in files:
        if f.name == "domain.json" or not ID_RE.match(f.stem):
            continue
        inst = _read(f)
        if inst is None:
            continue
        inst["id"] = f.stem
        out.append(inst)
    return out


def tree(root):
    doms = []
    for meta in _domains(root):
        insts = []
        for inst in _instances(root, meta["id"]):
            comps = [{"id": c.get("id"), "name": c.get("name", c.get("id"))}
                     for c in inst.get("components") or [] if isinstance(c, dict)]
            insts.append({"id": inst["id"], "name": inst.get("name", inst["id"]),
                          "status": inst.get("status", "current"),
                          "created": inst.get("created"), "archived": inst.get("archived"),
                          "components": comps})
        cur = meta.get("current")
        insts.sort(key=lambda i: (i["id"] != cur, i["status"] != "current",
                                  -(time.mktime(time.strptime(i["archived"], "%Y-%m-%d"))
                                    if isinstance(i.get("archived"), str)
                                    and re.fullmatch(r"\d{4}-\d{2}-\d{2}", i["archived"]) else 0)))
        doms.append({"id": meta["id"], "name": meta.get("name", meta["id"]),
                     "current": cur, "instances": insts,
                     "parent": meta.get("parent"), "app": meta.get("app"),
                     "course": meta.get("course")})
    # a subsystem names its system in `parent`; one level only, and a parent that is
    # missing, itself a subsystem, or the domain itself reads as no parent (top level)
    tops = {d["id"] for d in doms
            if not (isinstance(d["parent"], str) and d["parent"] != d["id"]
                    and any(o["id"] == d["parent"] for o in doms))}
    for d in doms:
        if not (isinstance(d["parent"], str) and d["parent"] in tops and d["id"] not in tops):
            d["parent"] = None
        if d["app"] not in APPS:
            d["app"] = None
        if not (isinstance(d["course"], str) and 0 < len(d["course"]) <= MAX_STR):
            d["course"] = None
    return {"domains": doms}


def _load(root, domain, instance):
    p = instance_path(root, domain, instance)
    inst = _read(p)
    if inst is None:
        raise LookupError("no such instance")
    inst.setdefault("components", [])
    return p, inst


def _comp(inst, component):
    _id(component, "component")
    for c in inst["components"]:
        if isinstance(c, dict) and c.get("id") == component:
            for k in ("zones", "items", "routines", "proposals"):
                c.setdefault(k, [])
            return c
    raise LookupError("no such component")


# ---------------------------------------------------------------- fit check

def _zone_box(comp, zone_id):
    """(w, d, h) in cm of a target zone; a hook resolves to the space it sits in;
    "" means the whole interior. None when unknown."""
    dims = comp.get("dims") or {}
    def cm(o, k):
        v = (o or {}).get(k)
        return v.get("cm") if isinstance(v, dict) else None
    if not zone_id:
        w, d, h = cm(dims, "w"), cm(dims, "d"), cm(dims, "h")
        return (w, d, h) if None not in (w, d, h) else None
    zones = {z.get("id"): z for z in comp.get("zones") or [] if isinstance(z, dict)}
    z = zones.get(zone_id)
    if not z:
        return None
    if z.get("kind") == "hook":
        hx, hy = cm(z, "x"), cm(z, "y")
        for s in zones.values():
            if s.get("kind", "space") != "space":
                continue
            x, y, w, h = cm(s, "x"), cm(s, "y"), cm(s, "w"), cm(s, "h")
            if None in (hx, hy, x, y, w, h):
                continue
            if x - 0.5 <= hx <= x + w + 0.5 and y <= hy <= y + h:
                z = s
                break
        else:
            return None
    w, h = cm(z, "w"), cm(z, "h")
    d = cm(z, "d") or cm(dims, "d")
    return (w, d, h) if None not in (w, d, h) else None


def fit(comp, proposal):
    size = proposal.get("size") or {}
    try:
        pw, pd, ph = (float(size[k]["cm"]) for k in ("w", "d", "h"))
    except Exception:
        return {"state": "unknown", "rotated": False, "against": None}
    box = _zone_box(comp, proposal.get("zone") or "")
    if not box:
        return {"state": "unknown", "rotated": False, "against": None}
    zw, zd, zh = box
    against = {"w": zw, "d": zd, "h": zh}
    if ph > zh:
        return {"state": "too tall", "rotated": False, "against": against}
    if pw <= zw and pd <= zd:
        return {"state": "fits", "rotated": False, "against": against}
    if pd <= zw and pw <= zd:
        return {"state": "fits", "rotated": True, "against": against}
    # fails both ways: name the overshoot of the upright orientation, worst first
    over_w, over_d = pw - zw, pd - zd
    return {"state": "too wide" if over_w >= over_d else "too deep",
            "rotated": False, "against": against}


def component(root, domain, instance, comp_id):
    _, inst = _load(root, domain, instance)
    c = copy.deepcopy(_comp(inst, comp_id))
    for p in c["proposals"]:
        if isinstance(p, dict):
            p["fit"] = fit(c, p)
    return {"domain": domain, "instance": {"id": instance, "name": inst.get("name", instance),
                                           "status": inst.get("status", "current")},
            "component": c}


# ---------------------------------------------------------------- validators

def _clean_zone(z, zone_ids_taken):
    if not isinstance(z, dict):
        raise ValueError("zone must be an object")
    kind = z.get("kind", "space")
    if kind not in ZONE_KINDS:
        raise ValueError("bad zone kind")
    out = {"id": z.get("id") or _uniq(z.get("name", "zone"), zone_ids_taken),
           "name": _str(z.get("name"), "zone name", required=True), "kind": kind,
           "x": _cm(z.get("x", 0), "zone x", allow_zero=True),
           "y": _cm(z.get("y", 0), "zone y", allow_zero=True)}
    _id(out["id"], "zone")
    if kind == "space":
        out["w"] = _cm(z.get("w"), "zone w")
        out["h"] = _cm(z.get("h"), "zone h")
        if z.get("d") not in (None, ""):
            out["d"] = _cm(z.get("d"), "zone d")
    if z.get("note"):
        out["note"] = _str(z.get("note"), "zone note", MAX_NOTE)
    return out


def _clean_item(it, taken, zones):
    if not isinstance(it, dict):
        raise ValueError("item must be an object")
    hyg = it.get("hygiene")
    if hyg not in HYGIENE:
        raise ValueError("hygiene must be one of " + ", ".join(HYGIENE))
    zone = it.get("zone") or ""
    if zone and zone not in zones:
        raise ValueError("no such zone")
    out = {"id": it.get("id") or _uniq(it.get("name", "item"), taken),
           "name": _str(it.get("name"), "item name", required=True),
           "zone": zone, "hygiene": hyg}
    _id(out["id"], "item")
    size = _size(it.get("size"), "item size")
    if size:
        out["size"] = size
    if it.get("note"):
        out["note"] = _str(it.get("note"), "item note", MAX_NOTE)
    return out


def _clean_routine(r, taken, items):
    if not isinstance(r, dict):
        raise ValueError("routine must be an object")
    steps = []
    step_ids = set()
    for s in _list(r.get("steps"), "steps"):
        if not isinstance(s, dict):
            raise ValueError("step must be an object")
        touch = []
        for i in _list(s.get("items"), "step items"):
            if i not in items:
                raise ValueError("step names an unknown item")
            if i not in touch:
                touch.append(i)
        sid = s.get("id") or _uniq(s.get("name", "step"), step_ids)
        _id(sid, "step")
        step_ids.add(sid)
        step = {"id": sid, "name": _str(s.get("name"), "step name", required=True), "items": touch}
        if s.get("note"):
            step["note"] = _str(s.get("note"), "step note", MAX_NOTE)
        steps.append(step)
    out = {"id": r.get("id") or _uniq(r.get("name", "routine"), taken),
           "name": _str(r.get("name"), "routine name", required=True), "steps": steps}
    _id(out["id"], "routine")
    return out


def _clean_proposal(p, taken, zones, items):
    if not isinstance(p, dict):
        raise ValueError("proposal must be an object")
    kind = p.get("kind", "product")
    if kind not in PROPOSAL_KINDS:
        raise ValueError("bad proposal kind")
    status = p.get("status", "idea")
    if status not in STATUS:
        raise ValueError("status must be one of " + ", ".join(STATUS))
    zone = p.get("zone") or ""
    if zone and zone not in zones:
        raise ValueError("no such zone")
    out = {"id": p.get("id") or _uniq(p.get("name", "proposal"), taken),
           "name": _str(p.get("name"), "proposal name", required=True),
           "kind": kind, "status": status, "zone": zone}
    _id(out["id"], "proposal")
    link = _str(p.get("link"), "link", 500)
    if link:
        if not re.match(r"^https?://", link):
            raise ValueError("link must be http(s)")
        out["link"] = link
    if p.get("price") not in (None, ""):
        pr = p.get("price")
        if isinstance(pr, bool) or not isinstance(pr, (int, float)) or not 0 <= pr <= 100000:
            raise ValueError("price out of range")
        out["price"] = round(float(pr), 2)
    size = _size(p.get("size"), "proposal size")
    if size:
        out["size"] = size
    carries = []
    for c in _list(p.get("carries"), "carries"):
        carries.append(_str(c, "carried thing", required=True))
    if carries:
        out["carries"] = carries
    holds = [i for i in _list(p.get("holds"), "holds") if isinstance(i, str)]
    for i in holds:
        if i not in items:
            raise ValueError("proposal holds an unknown item")
    if holds:
        out["holds"] = holds
    if p.get("note"):
        out["note"] = _str(p.get("note"), "proposal note", MAX_NOTE)
    return out


# ---------------------------------------------------------------- writes

_COLLECTIONS = {"item": "items", "routine": "routines", "proposal": "proposals", "zone": "zones"}


def write_part(root, kind, data):
    """POST /systems/{item,routine,proposal,zone}: {domain, instance, component,
    op: upsert|delete, <kind>: {...}} -> the component as GET returns it."""
    coll = _COLLECTIONS[kind]
    op = data.get("op", "upsert")
    if op not in ("upsert", "delete"):
        raise ValueError("op must be upsert or delete")
    domain, instance = data.get("domain"), data.get("instance")
    comp_id = data.get("component")
    body = data.get(kind)
    with _LOCK:
        path, inst = _load(root, domain, instance)
        if inst.get("status") == "archived":
            raise ValueError("archived instances are read-only")
        c = _comp(inst, comp_id)
        rows = c[coll]
        if op == "delete":
            rid = body.get("id") if isinstance(body, dict) else body
            _id(rid, kind)
            if not any(r.get("id") == rid for r in rows):
                raise LookupError("no such " + kind)
            c[coll] = [r for r in rows if r.get("id") != rid]
            if kind == "item":
                for r in c["routines"]:
                    for s in r.get("steps", []):
                        s["items"] = [i for i in s.get("items", []) if i != rid]
                for p in c["proposals"]:
                    left = [i for i in p.get("holds", []) if i != rid]
                    if left:
                        p["holds"] = left
                    else:
                        p.pop("holds", None)
            if kind == "zone":
                for it in c["items"]:
                    if it.get("zone") == rid:
                        it["zone"] = ""
                for p in c["proposals"]:
                    if p.get("zone") == rid:
                        p["zone"] = ""
        else:
            if not isinstance(body, dict):
                raise ValueError(kind + " required")
            if len(rows) >= MAX_LIST and not any(r.get("id") == body.get("id") for r in rows):
                raise ValueError("too many " + coll)
            taken = {r.get("id") for r in rows}
            zones = {z.get("id") for z in c["zones"]}
            items = {i.get("id") for i in c["items"]}
            if kind == "item":
                row = _clean_item(body, taken, zones)
            elif kind == "routine":
                row = _clean_routine(body, taken, items)
            elif kind == "proposal":
                row = _clean_proposal(body, taken, zones, items)
            else:
                row = _clean_zone(body, taken)
            for i, r in enumerate(rows):
                if r.get("id") == row["id"]:
                    rows[i] = row
                    break
            else:
                rows.append(row)
        _write(path, inst)
    return component(root, domain, instance, comp_id)


def write_component(root, data):
    """POST /systems/component: {domain, instance, op: upsert|delete, component:
    {id?, name, dims: {w,d,h}, photo?, note?}}. Upsert keeps the zones/items/... it has."""
    op = data.get("op", "upsert")
    if op not in ("upsert", "delete"):
        raise ValueError("op must be upsert or delete")
    domain, instance, body = data.get("domain"), data.get("instance"), data.get("component")
    if not isinstance(body, dict):
        raise ValueError("component required")
    with _LOCK:
        path, inst = _load(root, domain, instance)
        if inst.get("status") == "archived":
            raise ValueError("archived instances are read-only")
        comps = inst["components"]
        if op == "delete":
            cid = _id(body.get("id"), "component")
            if not any(c.get("id") == cid for c in comps):
                raise LookupError("no such component")
            inst["components"] = [c for c in comps if c.get("id") != cid]
            _write(path, inst)
            return {"ok": True, "deleted": cid}
        cid = body.get("id") or _uniq(body.get("name", "component"), {c.get("id") for c in comps})
        _id(cid, "component")
        existing = next((c for c in comps if c.get("id") == cid), None)
        if existing is None and len(comps) >= MAX_LIST:
            raise ValueError("too many components")
        name = _str(body.get("name") if body.get("name") is not None
                    else (existing or {}).get("name"), "component name", required=True)
        dims = _size(body.get("dims") if body.get("dims") is not None
                     else (existing or {}).get("dims"), "dims")
        if not dims:
            raise ValueError("dims required")
        row = existing if existing is not None else {"id": cid, "zones": [], "items": [],
                                                     "routines": [], "proposals": []}
        row["name"], row["dims"] = name, dims
        if "photo" in body:
            ph = body.get("photo") or ""
            if ph and not PHOTO_RE.match(ph):
                raise ValueError("bad photo name")
            if ph:
                row["photo"] = ph
            else:
                row.pop("photo", None)
        if "note" in body:
            row["note"] = _str(body.get("note"), "component note", MAX_NOTE)
        if existing is None:
            comps.append(row)
        _write(path, inst)
    return component(root, domain, instance, cid)


def write_domain(root, data):
    """POST /systems/domain: {name, id?, order?, parent?, app?, course?} -> creates (never
    renames over) a domain; with `parent` it is that system's subsystem."""
    name = _str(data.get("name"), "domain name", required=True)
    did = data.get("id") or slug(name)
    _id(did, "domain")
    order = data.get("order", 99)
    if isinstance(order, bool) or not isinstance(order, (int, float)):
        raise ValueError("order must be a number")
    meta = {"id": did, "name": name, "order": order, "current": None}
    parent = data.get("parent")
    if parent not in (None, ""):
        _id(parent, "parent")
        if parent == did:
            raise ValueError("a system cannot be its own subsystem")
        meta["parent"] = parent
    app = data.get("app")
    if app not in (None, ""):
        if app not in APPS:
            raise ValueError("app must be one of " + ", ".join(APPS))
        meta["app"] = app
    course = _str(data.get("course"), "course")
    if course:
        meta["course"] = course
    with _LOCK:
        p = domain_path(root, did)
        if p.exists():
            raise ValueError("domain exists")
        if "parent" in meta:
            pm = _read(domain_path(root, meta["parent"]))
            if pm is None:
                raise LookupError("no such parent system")
            if pm.get("parent"):
                raise ValueError("subsystems nest one level only")
        _write(p, meta)
    return tree(root)


def swap(root, data, today=None):
    domain = data.get("domain")
    name = _str(data.get("name"), "instance name", required=True)
    carry = data.get("carry", False)
    if not isinstance(carry, bool):
        raise ValueError("carry must be true or false")
    today = today or time.strftime("%Y-%m-%d")
    with _LOCK:
        dp = domain_path(root, domain)
        meta = _read(dp)
        if meta is None:
            raise LookupError("no such domain")
        taken = {i["id"] for i in _instances(root, domain)} | {"domain"}
        new_id = _uniq(data.get("id") or name, taken)
        _id(new_id, "instance")
        old_id = meta.get("current")
        comps = []
        if old_id:
            op, old = _load(root, domain, old_id)
            if carry:
                for c in old.get("components") or []:
                    c2 = copy.deepcopy(c)
                    c2["proposals"] = []
                    c2.pop("photo", None)
                    for k in ("w", "d", "h"):
                        if isinstance(c2.get("dims", {}).get(k), dict):
                            c2["dims"][k]["estimated"] = True
                            c2["dims"][k].pop("source", None)
                    for z in c2.get("zones", []):
                        for k in ("x", "y", "w", "h", "d"):
                            if isinstance(z.get(k), dict):
                                z[k]["estimated"] = True
                                z[k].pop("source", None)
                    comps.append(c2)
            old["status"] = "archived"
            old["archived"] = today
            _write(op, old)
        _write(instance_path(root, domain, new_id),
               {"id": new_id, "name": name, "status": "current", "created": today,
                "archived": None, "components": comps})
        meta["current"] = new_id
        _write(dp, meta)
    return tree(root)


def photo(root, domain, instance, comp_id):
    """-> (bytes, content type) of the component's reference photo, or None."""
    try:
        _, inst = _load(root, domain, instance)
        c = _comp(inst, comp_id)
    except (LookupError, ValueError):
        return None
    name = c.get("photo") or ""
    if not PHOTO_RE.match(name):
        return None
    p = _confined(root, domain, "photos", name)
    try:
        if not p.is_file() or p.stat().st_size > PHOTO_MAX:
            return None
        return p.read_bytes(), PHOTO_TYPES[name.rsplit(".", 1)[1]]
    except OSError:
        return None


# ---------------------------------------------------------------- HTTP adapters
# serve.py stays a two-line dispatcher: these map a path to a result and never raise.

def _q(query, k):
    v = (query.get(k) or [""])[0]
    return v if isinstance(v, str) else ""


def http_get(root, path, query):
    """-> (code, ctype, payload): payload is a dict (JSON) or bytes."""
    try:
        if path == "/systems/tree":
            return 200, "json", tree(root)
        if path == "/systems/component":
            return 200, "json", component(root, _q(query, "domain"), _q(query, "instance"),
                                          _q(query, "component"))
        if path == "/systems/photo":
            res = photo(root, _q(query, "domain"), _q(query, "instance"), _q(query, "component"))
            if not res:
                return 404, "json", {"ok": False, "error": "no photo"}
            return 200, res[1], res[0]
        return 404, "json", {"ok": False, "error": "not found"}
    except LookupError as e:
        return 404, "json", {"ok": False, "error": str(e)}
    except ValueError as e:
        return 400, "json", {"ok": False, "error": str(e)}
    except Exception:
        return 500, "json", {"ok": False, "error": "systems read failed"}


POST_PATHS = frozenset(("/systems/item", "/systems/routine", "/systems/proposal",
                        "/systems/zone", "/systems/component", "/systems/swap",
                        "/systems/domain"))


def http_post(root, path, data):
    """-> (code, dict)"""
    try:
        if not isinstance(data, dict):
            raise ValueError("bad json")
        kind = path.rsplit("/", 1)[-1]
        if kind in _COLLECTIONS:
            return 200, write_part(root, kind, data)
        if kind == "component":
            return 200, write_component(root, data)
        if kind == "swap":
            return 200, swap(root, data)
        if kind == "domain":
            return 200, write_domain(root, data)
        return 404, {"ok": False, "error": "not found"}
    except LookupError as e:
        return 404, {"ok": False, "error": str(e)}
    except ValueError as e:
        return 400, {"ok": False, "error": str(e)}
    except Exception:
        return 500, {"ok": False, "error": "systems write failed"}
