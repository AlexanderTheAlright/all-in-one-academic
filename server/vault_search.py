import settings

import hashlib
import itertools
import math
import os
import re
import sqlite3
import threading
import time
from pathlib import Path

DB_PATH = Path(os.environ.get("VAULT_SEARCH_DB")
               or settings.STATE_DIR / "vault-search.sqlite")


def _use_vault(vault):
    """One DB per vault: a QA copy of the vault must never rescan the real index away."""
    global DB_PATH
    if os.environ.get("VAULT_SEARCH_DB"):
        return
    vault = Path(vault).expanduser().resolve()
    name = "vault-search.sqlite"
    if vault != (settings.VAULT).resolve():
        name = f"vault-search-{hashlib.sha1(str(vault).encode()).hexdigest()[:10]}.sqlite"
    DB_PATH = settings.STATE_DIR / name
SCHEMA_VERSION = 2
RESCAN_SECS = 300
MAX_BODY_CHARS = 256 * 1024          # indexed text cap per file
MAX_FILE_BYTES = 5 * 1024 * 1024     # larger files: title and path only
BATCH = 200                          # files per commit on a build
BATCH_PAUSE = 0.05

PRUNE_DIRS = {"node_modules", "__pycache__", "versioning"}

# Ranking: bm25 column weights, in FTS column order (title, aliases, tags, body, path).
WEIGHTS = (10.0, 6.0, 4.0, 1.0, 2.0)
NOTE_AREAS = ("inbox", "ideas", "concepts", "authors", "reflections", "meetings")
AREA_BONUS = {**{a: 1.5 for a in NOTE_AREAS}, "daily": 0.0, "archive": 0.0}
AREA_ALIASES = {"notes": NOTE_AREAS, "cites": ("citations",), "citation": ("citations",),
                "idea": ("ideas",), "concept": ("concepts",), "author": ("authors",),
                "project": ("projects",), "meeting": ("meetings",)}
AREAS = {"inbox", "ideas", "concepts", "authors", "reflections", "meetings", "daily",
         "archive", "citations", "clippings", "reading", "learning", "calendar",
         "projects", "other"}
PROJECT_CONTAINERS = {"papers", "grants", "experiments", "briefs"}

_state = {"building": False, "last_build": None, "last_scan_secs": None,
          "indexed": 0, "errors": [], "started": False}
_state_lock = threading.Lock()
_local = threading.local()


# ---------------------------------------------------------------- schema

def _connect(readonly=False):
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH), timeout=10, check_same_thread=False)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    if readonly:
        conn.execute("PRAGMA query_only=1")
    return conn


def _ensure_schema(conn):
    ver = conn.execute("PRAGMA user_version").fetchone()[0]
    if ver != SCHEMA_VERSION:
        conn.executescript("DROP TABLE IF EXISTS docs; DROP TABLE IF EXISTS fts;")
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS docs (
            id INTEGER PRIMARY KEY,
            path TEXT UNIQUE NOT NULL,
            mtime REAL, size INTEGER,
            title TEXT, area TEXT, project TEXT, type TEXT, tags TEXT);
        CREATE INDEX IF NOT EXISTS docs_area ON docs(area, mtime);
        CREATE INDEX IF NOT EXISTS docs_mtime ON docs(mtime);
        CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
            title, aliases, tags, body, path,
            tokenize="unicode61 remove_diacritics 2", prefix='2 3');
    """)
    conn.execute(f"PRAGMA user_version={SCHEMA_VERSION}")
    conn.commit()


def _reader():
    conn = getattr(_local, "conn", None)
    if conn is None:
        conn = _connect(readonly=True)
        _local.conn = conn
    return conn


def _error(msg):
    with _state_lock:
        _state["errors"] = (_state["errors"] + [f"{time.strftime('%H:%M:%S')} {msg}"])[-20:]


# ---------------------------------------------------------------- parsing notes

_PRIMARY = settings.PRIMARY_SOURCES_REL.lower().split("/")


def area_of(rel):
    parts = rel.split("/")
    low = [p.lower() for p in parts]
    if low[:1] == ["projects"]:
        return "projects"
    if low[:2] == ["preparation", "notes"] and len(low) > 2:
        sub = low[2]
        if sub in ("inbox", "ideas", "concepts", "authors", "reflections", "meetings", "daily"):
            return sub
        if sub == "archive":
            return "archive"
        return "other"
    if (low[:len(_PRIMARY)] == _PRIMARY and len(low) > len(_PRIMARY)
            and low[len(_PRIMARY)] == "citations"):
        return "citations"
    if low[:2] == ["preparation", "reading"] and len(low) > 2:
        sub = low[2]
        if sub == "citations":
            return "citations"
        if sub == "clippings":
            return "clippings"
        return "reading"
    if low[:1] == ["preparation"] and len(low) > 1:
        sub = low[1]
        if sub in ("learning", "calendar", "archive"):
            return sub
    return "other"


def project_of(rel):
    parts = rel.split("/")
    if len(parts) < 3 or parts[0].lower() != "projects":
        return ""
    if parts[1].lower() in PROJECT_CONTAINERS and len(parts) > 3:
        return parts[2]
    return parts[1]


_FM_KEY = re.compile(r"^([A-Za-z_][\w-]*)\s*:\s*(.*)$")
_INLINE_TAG = re.compile(r"(?<![\w/&#`\]\)])#([A-Za-z][\w/-]*)")
_HEADING = re.compile(r"^#\s+(.+?)\s*#*\s*$", re.M)


def _clean_scalar(v):
    v = v.strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
        v = v[1:-1]
    return v.strip()


def _split_frontmatter(text):
    if not text.startswith("---"):
        return {}, text
    m = re.match(r"^---[ \t]*\r?\n(.*?)\r?\n---[ \t]*(?:\r?\n|$)", text, re.S)
    if not m:
        return {}, text
    fm, key = {}, None
    for line in m.group(1).splitlines():
        km = _FM_KEY.match(line)
        if km and not line.startswith((" ", "\t")):
            key, val = km.group(1).lower(), km.group(2).strip()
            if val.startswith("[") and val.endswith("]"):
                fm[key] = [_clean_scalar(x) for x in val[1:-1].split(",") if x.strip()]
            elif val:
                fm[key] = _clean_scalar(val)
            else:
                fm[key] = []
        elif key and line.lstrip().startswith("- "):
            item = _clean_scalar(line.lstrip()[2:])
            if not isinstance(fm.get(key), list):
                fm[key] = [fm[key]] if fm.get(key) else []
            if item:
                fm[key].append(item)
    return fm, text[m.end():]


def _as_list(v):
    if v is None:
        return []
    if isinstance(v, str):
        return [x.strip() for x in re.split(r"[,\s]+", v) if x.strip()]
    return [str(x) for x in v if str(x).strip()]


def parse_note(rel, text):
    fm, body = _split_frontmatter(text)
    stem = rel.rsplit("/", 1)[-1][:-3]
    title = fm.get("title") if isinstance(fm.get("title"), str) else ""
    if not title:
        hm = _HEADING.search(body[:20000])
        title = hm.group(1).strip() if hm else stem
    aliases = fm.get("aliases") or fm.get("alias") or []
    aliases = [aliases] if isinstance(aliases, str) else aliases
    tags = [t.lstrip("#") for t in _as_list(fm.get("tags") or fm.get("tag"))]
    seen = {t.lower() for t in tags}
    for t in _INLINE_TAG.findall(body):
        t = t.rstrip("/-")
        if t.lower() not in seen:
            seen.add(t.lower())
            tags.append(t)
    ntype = fm.get("type") if isinstance(fm.get("type"), str) else ""
    return {"title": title[:300], "aliases": " ".join(aliases), "tags": tags,
            "type": ntype.strip().lower(), "body": body}


# ---------------------------------------------------------------- indexing

def _walk(vault):
    stack = [vault]
    while stack:
        d = stack.pop()
        try:
            it = os.scandir(d)
        except OSError:
            continue
        with it:
            for e in it:
                name = e.name
                low = name.lower()
                if "secret" in low or low.startswith(".env"):
                    continue
                try:
                    if e.is_dir(follow_symlinks=False):
                        if name not in PRUNE_DIRS and not name.startswith("."):
                            stack.append(e.path)
                    elif low.endswith(".md") and e.is_file(follow_symlinks=False):
                        st = e.stat(follow_symlinks=False)
                        rel = os.path.relpath(e.path, vault).replace(os.sep, "/")
                        yield rel, st.st_mtime, st.st_size
                except OSError:
                    continue


def _index_file(conn, vault, rel, mtime, size, old_id):
    body = ""
    if size <= MAX_FILE_BYTES:
        try:
            with open(os.path.join(vault, rel), "r", encoding="utf-8", errors="replace") as f:
                body = f.read(MAX_BODY_CHARS)
        except OSError as exc:
            _error(f"read {rel}: {exc}")
    note = parse_note(rel, body)
    tags = note["tags"]
    row = (rel, mtime, size, note["title"], area_of(rel), project_of(rel),
           note["type"], " ".join(tags))
    if old_id is not None:
        conn.execute("DELETE FROM fts WHERE rowid=?", (old_id,))
        conn.execute("UPDATE docs SET path=?, mtime=?, size=?, title=?, area=?, project=?, "
                     "type=?, tags=? WHERE id=?", row + (old_id,))
        rid = old_id
    else:
        rid = conn.execute("INSERT INTO docs(path, mtime, size, title, area, project, type, tags)"
                           " VALUES (?,?,?,?,?,?,?,?)", row).lastrowid
    conn.execute("INSERT INTO fts(rowid, title, aliases, tags, body, path) VALUES (?,?,?,?,?,?)",
                 (rid, note["title"], note["aliases"], " ".join(tags), note["body"],
                  rel[:-3].replace("/", " ")))


def rescan(vault, conn=None, pace=True):
    """One incremental pass: index new and changed files, drop vanished ones."""
    own = conn is None
    if own:
        _use_vault(vault)
    vault = str(vault)
    conn = conn or _connect()
    t0 = time.time()
    try:
        _ensure_schema(conn)
        known = {p: (i, m, s) for i, p, m, s in
                 conn.execute("SELECT id, path, mtime, size FROM docs")}
        seen, pending = set(), 0
        for rel, mtime, size in _walk(vault):
            seen.add(rel)
            old = known.get(rel)
            if old and old[1] == mtime and old[2] == size:
                continue
            try:
                _index_file(conn, vault, rel, mtime, size, old[0] if old else None)
            except Exception as exc:        # one bad file never stops the pass
                _error(f"index {rel}: {exc}")
                continue
            pending += 1
            if pending >= BATCH:
                conn.commit()
                pending = 0
                with _state_lock:
                    _state["indexed"] = conn.execute("SELECT count(*) FROM docs").fetchone()[0]
                if pace:
                    time.sleep(BATCH_PAUSE)
        gone = [(known[p][0],) for p in known.keys() - seen]
        if gone:
            conn.executemany("DELETE FROM fts WHERE rowid=?", gone)
            conn.executemany("DELETE FROM docs WHERE id=?", gone)
        conn.commit()
        n = conn.execute("SELECT count(*) FROM docs").fetchone()[0]
        with _state_lock:
            _state["indexed"] = n
            _state["last_build"] = time.time()
            _state["last_scan_secs"] = round(time.time() - t0, 2)
        return {"indexed": n, "removed": len(gone), "secs": round(time.time() - t0, 2)}
    finally:
        if own:
            conn.close()


def _loop(vault):
    try:
        os.setpriority(os.PRIO_PROCESS, threading.get_native_id(), 10)   # this thread only
    except (AttributeError, OSError):
        pass
    conn = _connect()
    while True:
        with _state_lock:
            _state["building"] = True
        try:
            rescan(vault, conn)
        except Exception as exc:
            _error(f"rescan: {exc}")
        finally:
            with _state_lock:
                _state["building"] = False
        time.sleep(RESCAN_SECS)


def start_background(vault):
    with _state_lock:
        if _state["started"]:
            return
        _state["started"] = True
    _use_vault(vault)
    try:
        c = _connect()
        _ensure_schema(c)
        with _state_lock:
            _state["indexed"] = c.execute("SELECT count(*) FROM docs").fetchone()[0]
        c.close()
    except Exception as exc:
        _error(f"open: {exc}")
    threading.Thread(target=_loop, args=(Path(vault),), name="vault-search",
                     daemon=True).start()


def status():
    with _state_lock:
        return {"indexed": _state["indexed"], "building": _state["building"],
                "last_build": _state["last_build"], "last_scan_secs": _state["last_scan_secs"],
                "db_path": str(DB_PATH), "errors": list(_state["errors"])}


# ---------------------------------------------------------------- query parsing

_WORD = re.compile(r"\w+", re.U)
_LEX = re.compile(r'(-?)(?:"([^"]*)"?|(\S+))')


def _phrase(words, prefix=False):
    """A safe FTS5 phrase: only \\w tokens, always double-quoted."""
    words = [w.lower() for w in words]
    if not words:
        return None
    return '"' + " ".join(words) + '"' + ("*" if prefix else "")


def _word_term(raw):
    words = _WORD.findall(raw)
    if not words:
        return None
    if len(words) > 1:
        words = [w for w in words if len(w) >= 2] or words
        return _phrase(words, prefix=len(words[-1]) >= 2)
    return _phrase(words, prefix=len(words[0]) >= 2)


def parse_query(q, scope=None):
    """Split a query into FTS clauses and SQL filters. Never trusts raw text."""
    out = {"pos": [], "neg": [], "areas": set(), "not_areas": set(), "types": [],
           "projects": [], "words": [], "plain": [], "hl": []}
    q = (q or "")[:500]
    pending_or = False
    for m in _LEX.finditer(q):
        neg, quoted, bare = m.group(1) == "-", m.group(2), m.group(3)
        term, is_word = None, False
        if quoted is not None:
            term = _phrase(_WORD.findall(quoted))
            if term and not neg:
                out["plain"].append(quoted.strip())
                out["hl"].append((_WORD.findall(quoted), False))
        elif bare == "OR" and not neg:
            pending_or = bool(out["pos"])
            continue
        elif bare in ("AND", "NOT") and not neg:
            continue
        elif ":" in bare and bare.split(":", 1)[0].lower() in (
                "in", "type", "tag", "project", "title", "area"):
            key, val = bare.split(":", 1)
            key, val = key.lower(), val.strip()
            if not val:
                continue
            if key in ("in", "area"):
                names = set(AREA_ALIASES.get(val.lower(), (val.lower(),))) & AREAS
                (out["not_areas"] if neg else out["areas"]).update(names)
                continue
            if key == "type":
                if not neg:
                    out["types"].append(val.lower())
                continue
            if key == "project":
                if not neg:
                    out["projects"].append(val.lower())
                continue
            ph = _phrase(_WORD.findall(val), prefix=(key == "title"))
            term = f"{'tags' if key == 'tag' else 'title'} : {ph}" if ph else None
            if ph and not neg:
                out["hl"].append((_WORD.findall(val), key == "title"))
        elif bare.startswith("#") and len(bare) > 1:
            ph = _phrase(_WORD.findall(bare[1:]))
            term = f"tags : {ph}" if ph else None
            if ph and not neg:
                out["hl"].append((_WORD.findall(bare[1:]), False))
        else:
            term, is_word = _word_term(bare), True
            if term and not neg:
                out["plain"].append(bare)
                out["words"].extend(w.lower() for w in _WORD.findall(bare))
                out["hl"].append((_WORD.findall(bare), True))
        if not term:
            continue
        if neg:
            out["neg"].append(term)
        elif pending_or and out["pos"]:
            prev = out["pos"].pop()
            out["pos"].append(f"({prev} OR {term})")
        else:
            out["pos"].append(term)
        pending_or = False
    if scope:
        for s in str(scope).split(","):
            s = s.strip().lower()
            out["areas"].update(set(AREA_ALIASES.get(s, (s,))) & AREAS)
    return out


def _match_expr(pos, neg):
    if not pos:
        return None
    expr = " AND ".join(pos)
    if neg:
        expr = f"({expr}) NOT ({' OR '.join(neg)})"
    return expr


def _fuzzy_exprs(words):
    words = [w for w in words if len(w) >= 3]
    out = []
    for cut in (lambda w: max(3, len(w) - 2), lambda w: max(3, (len(w) + 1) // 2)):
        expr = " OR ".join(_phrase([w[:cut(w)]], prefix=True) for w in words)
        if expr and expr not in out:
            out.append(expr)
    return out


def _fuzzy_hl(fexpr):
    return [([w], True) for w in re.findall(r'"(\w+)"', fexpr)]


# ---------------------------------------------------------------- search

def _make_snippet(body, title, hl, width=200):
    """About 20 words around the densest cluster of matches, matches in «…»."""
    alts = [r"\b" + r"\W+".join(re.escape(w) for w in ws) + (r"\w*" if pre else r"\b")
            for ws, pre in hl if ws]
    rx = re.compile("|".join(alts), re.I) if alts else None
    body = body or ""
    ms = list(itertools.islice(rx.finditer(body), 300)) if rx else []
    if not ms:
        if rx and rx.search(title or ""):
            return rx.sub(lambda m: f"«{m.group(0)}»", title)
        text = re.sub(r"\s+", " ", body[:600]).strip()
        return text[:160] + ("…" if len(text) > 160 else "")
    best, best_n = ms[0], 0
    for i, m in enumerate(ms):
        n = len({x.group(0).lower() for x in ms[i:i + 12] if x.start() < m.start() + width})
        if n > best_n:
            best, best_n = m, n
    start = max(0, best.start() - 60)
    if start:
        sp = body.find(" ", start)
        start = sp + 1 if 0 <= sp < best.start() else start
    end = min(len(body), start + width + 60)
    if end < len(body):
        sp = body.rfind(" ", best.end(), end)
        end = sp if sp > 0 else end
    frag = rx.sub(lambda m: f"«{m.group(0)}»", body[start:end])
    frag = re.sub(r"\s+", " ", frag).strip()
    return ("…" if start else "") + frag + ("…" if end < len(body) else "")


def _filters_sql(p):
    where, args = [], []
    if p["areas"]:
        where.append(f"d.area IN ({','.join('?' * len(p['areas']))})")
        args += sorted(p["areas"])
    if p["not_areas"]:
        where.append(f"d.area NOT IN ({','.join('?' * len(p['not_areas']))})")
        args += sorted(p["not_areas"])
    for t in p["types"]:
        where.append("d.type = ?")
        args.append(t)
    for pr in p["projects"]:
        where.append("lower(d.project) LIKE ? ESCAPE '\\'")
        args.append("%" + pr.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%")
    return where, args


def _hit(row, score, snippet, fuzzy=False):
    rid, path, mtime, title, area, project, ntype, tags = row
    h = {"path": path, "title": title or "", "area": area or "other", "type": ntype or "",
         "tags": tags.split() if tags else [], "snippet": re.sub(r"\s+", " ", snippet or "").strip(),
         "mtime": mtime or 0.0, "score": round(score, 3)}
    if project:
        h["project"] = project
    if fuzzy:
        h["fuzzy"] = True
    return h


def _rank(conn, expr, where, args, p, limit, now, hl=None):
    # FTS drives the query; a join would let the query planner scan docs and probe fts per row.
    cols = "d.id, d.path, d.mtime, d.title, d.area, d.project, d.type, d.tags"
    w = ",".join(str(x) for x in WEIGHTS)
    # Filters are applied in Python: "rowid IN (subquery)" makes FTS probe row by row.
    allowed = None
    if where:
        allowed = {r[0] for r in conn.execute(
            f"SELECT d.id FROM docs d WHERE {' AND '.join(where)}", args)}
    bm, total = {}, 0
    for rid, b in conn.execute(f"SELECT rowid, bm25(fts, {w}) FROM fts WHERE fts MATCH ? "
                               f"ORDER BY bm25(fts, {w})", [expr]):
        if allowed is not None and rid not in allowed:
            continue
        total += 1
        if len(bm) < 300:
            bm[rid] = b
    rows = []
    if bm:
        rows = [r + (bm[r[0]],) for r in conn.execute(
            f"SELECT {cols} FROM docs d WHERE d.id IN ({','.join('?' * len(bm))})", list(bm))]
    qtext = " ".join(p["plain"]).strip().lower()
    words = set(p["words"])
    scored = []
    for r in rows:
        s = -r[8]
        title = (r[3] or "").lower()
        if qtext and title == qtext:
            s += 100.0
        elif words and words <= set(_WORD.findall(title)):
            s += 3.0
        s += AREA_BONUS.get(r[4], 0.5)
        age_days = max(0.0, (now - (r[2] or 0)) / 86400)
        s += 1.5 * math.exp(-age_days / 180)
        scored.append((s, r[:8]))
    scored.sort(key=lambda x: -x[0])
    top = scored[:limit]
    snips = {}
    if top:
        ids = [r[0] for _, r in top]
        titles = {r[0]: r[3] for _, r in top}
        for rid, body in conn.execute(
                f"SELECT rowid, body FROM fts WHERE rowid IN ({','.join('?' * len(ids))})", ids):
            snips[rid] = _make_snippet(body, titles[rid], hl if hl is not None else p["hl"])
    return [(s, r, snips.get(r[0], "")) for s, r in top], total


def _recent(conn, where, args, limit, neg):
    cols = "d.id, d.path, d.mtime, d.title, d.area, d.project, d.type, d.tags"
    if neg:
        where = where + [f"d.id NOT IN (SELECT rowid FROM fts WHERE fts MATCH ?)"]
        args = args + [" OR ".join(neg)]
    cond = (" WHERE " + " AND ".join(where)) if where else ""
    rows = conn.execute(f"SELECT {cols} FROM docs d{cond} ORDER BY d.mtime DESC LIMIT ?",
                        args + [limit]).fetchall()
    total = conn.execute(f"SELECT count(*) FROM docs d{cond}", args).fetchone()[0]
    out = []
    for r in rows:
        b = conn.execute("SELECT substr(body, 1, 400) FROM fts WHERE rowid=?", (r[0],)).fetchone()
        text = re.sub(r"\s+", " ", (b[0] if b else "")).strip()
        out.append((0.0, r, text[:160] + ("…" if len(text) > 160 else "")))
    return out, total


def search(q, limit=30, scope=None):
    t0 = time.perf_counter()
    st = status()
    base = {"hits": [], "total": 0, "building": st["building"], "indexed": st["indexed"]}
    try:
        limit = max(1, min(int(limit or 30), 200))
        p = parse_query(q, scope)
        where, args = _filters_sql(p)
        conn = _reader()
        now = time.time()
        expr = _match_expr(p["pos"], p["neg"])
        fuzzy = False
        if expr:
            ranked, total = _rank(conn, expr, where, args, p, limit, now)
            if not ranked and p["words"]:
                keep = [t for t in p["pos"] if t.startswith(("tags :", "title :"))]
                for fexpr in _fuzzy_exprs(p["words"]):
                    ranked, total = _rank(conn, _match_expr([f"({fexpr})"] + keep, p["neg"]),
                                          where, args, p, limit, now, _fuzzy_hl(fexpr))
                    fuzzy = True
                    if ranked:
                        break
        elif where or p["neg"] or p["areas"]:
            ranked, total = _recent(conn, where, args, limit, p["neg"])
        else:
            ranked, total = [], 0
        base["hits"] = [_hit(r, s, sn, fuzzy) for s, r, sn in ranked]
        base["total"] = total
    except Exception as exc:
        base["error"] = f"{type(exc).__name__}: {exc}"
    base["took_ms"] = round((time.perf_counter() - t0) * 1000, 1)
    return base
