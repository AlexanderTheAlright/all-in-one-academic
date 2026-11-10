#!/usr/bin/env python3
"""Semantic index over the corpus, for the Drafting view's Corpus panel."""
import settings
import argparse
import json
import math
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from collections import OrderedDict
from hashlib import sha1
from pathlib import Path

try:
    import numpy as np
except ImportError:
    np = None

HERE = settings.STATE_DIR
VAULT = settings.VAULT

OLLAMA = os.environ.get("AIOA_OLLAMA_URL", "http://localhost:11434")
MODEL = os.environ.get("AIOA_SEMINDEX_MODEL", "nomic-embed-text")
DIMS = 768

# nomic's task prefixes. Not decoration: asymmetric retrieval collapses without them.
DOC_PREFIX = "search_document: "
QRY_PREFIX = "search_query: "

BATCH = 32
PACE = 0.05                              # floor for the sleep between batches
GPU_DUTY = 0.6                           # fraction of wall time the card may be working
RESERVE_MB = 1500                        # VRAM left free before a batch goes out
QUERY_TIMEOUT = 2.0                      # a slow embed must not hold the request path
BUILD_TIMEOUT = 120.0
KEEP_ALIVE = os.environ.get("AIOA_SEMINDEX_KEEPALIVE", "1h")   # model stays resident

MIN_CHARS = 25                           # below this a chunk is a heading stub, not an idea
MAX_SECTION = 1500                       # a `##` block longer than this is split at paragraphs
MAX_HEAD = 600
MAX_PASSAGE = 600                        # what search() hands back per passage
TOP_CHUNKS = 300                         # chunks considered before grouping into notes
RRF_K = 60

NOTE_FOLDERS = {"Ideas": "idea", "Concepts": "concept", "Authors": "author",
                "Reflections": "reflection", "Meetings": "meeting", "Inbox": "inbox"}
# walked recursively: the folder is a few subfolders of pieces, not a flat list
FREE_WRITING = ("Preparation", "Free Writing")
CITATION_KINDS = ("citation", "clipping", "historical")
PROJECT_ROOTS = (("Projects", "papers"), ("Projects", "grants"))
PROJECT_PREFIX = settings.PROJECT_PREFIX   # drafting.PREFIX; a project folder's bare slug

DRAFT_ROOTS = PROJECT_ROOTS + (("Projects", "briefs"),)
DRAFT_SKIP_DOC = re.compile(r"^(references|cover-letter|reviews-)", re.I)
DRAFT_SKIP_HEADING = re.compile(r"^(references|bibliography|works cited|reference list)\W*$",
                                re.I)
DRAFT_MIN_BODY = 200                     # a heading over less than this is a skeleton

EMBED = None


class LockHeld(RuntimeError):
    """Another build is already running. Normal contention, not a fault: the CLI
    exits 0."""


def state_dir():
    """Where the index lives. Env-overridable so a test never touches the real one."""
    d = os.environ.get("AIOA_SEMINDEX_DIR")
    p = Path(d).expanduser() if d else settings.STATE_DIR / "semindex"
    return p


def _paths():
    d = state_dir()
    return d / "chunks.jsonl", d / "emb.npy", d / "meta.json", d / ".lock"


# --------------------------------------------------------------------------- embedding
def _post_embed(payload, timeout):
    payload = dict(payload, keep_alive=KEEP_ALIVE)
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(OLLAMA + "/api/embed", data=body,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def _ollama_embed(texts, timeout):
    """One request per batch through /api/embed, which takes a list in `input`."""
    out = _post_embed({"model": MODEL, "input": list(texts)}, timeout)
    vecs = out.get("embeddings")
    if isinstance(vecs, list) and len(vecs) == len(texts):
        return vecs
    if len(texts) == 1 and isinstance(out.get("embedding"), list):
        return [out["embedding"]]
    one = []
    for t in texts:
        o = _post_embed({"model": MODEL, "input": t}, timeout)
        v = o.get("embeddings") or o.get("embedding")
        if v and isinstance(v[0], list):
            v = v[0]
        if not v:
            raise ValueError("ollama returned no vector for a %d-char text" % len(t))
        one.append(v)
    return one


def embed(texts, timeout=BUILD_TIMEOUT):
    """One batch of texts -> one list of vectors. Honours the EMBED test hook."""
    if EMBED is not None:
        return EMBED(list(texts))
    return _ollama_embed(list(texts), timeout)


def ollama_up(timeout=0.8):
    try:
        with urllib.request.urlopen(OLLAMA + "/api/tags", timeout=timeout) as r:
            return r.status == 200
    except (urllib.error.URLError, OSError, ValueError):
        return False


# --------------------------------------------------------------------------- pacing
_vram = {"at": 0.0, "free": None}


def _free_vram_mb():
    now = time.time()
    if now - _vram["at"] < 2.0:
        return _vram["free"]
    _vram["at"] = now
    try:
        out = subprocess.run(["nvidia-smi", "--query-gpu=memory.free",
                              "--format=csv,noheader,nounits"],
                             capture_output=True, text=True, timeout=5)
        _vram["free"] = int(out.stdout.strip().splitlines()[0]) if out.returncode == 0 else None
    except (OSError, subprocess.SubprocessError, ValueError, IndexError):
        _vram["free"] = None
    return _vram["free"]


class GpuBudget:

    def __init__(self, duty=GPU_DUTY, floor=PACE, reserve_mb=RESERVE_MB):
        self.duty = min(1.0, max(0.05, float(duty)))
        self.floor = max(0.0, float(floor))
        self.reserve_mb = reserve_mb
        self.slept = 0.0
        self.worked = 0.0
        self._t = 0.0

    def __enter__(self):
        _wait_for_headroom(self.reserve_mb)
        self._t = time.time()
        return self

    def __exit__(self, *exc):
        spent = time.time() - self._t
        self.worked += spent
        nap = max(self.floor, spent * (1.0 - self.duty) / self.duty)
        self.slept += nap
        if nap:
            time.sleep(nap)
        return False


def _wait_for_headroom(reserve_mb=RESERVE_MB, tries=40):
    """Hold the batch back while the card is close to full."""
    for _ in range(tries):
        free = _free_vram_mb()
        if free is None or free >= reserve_mb:
            return True
        time.sleep(1.0)
        _vram["at"] = 0.0
    return False


# --------------------------------------------------------------------------- lock
def _take_lock(path, stale=7200):
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        age = time.time() - path.stat().st_mtime
        pid = int(path.read_text(encoding="utf-8").strip() or 0)
        alive = True
        try:
            os.kill(pid, 0)
        except (ProcessLookupError, ValueError):
            alive = False
        except PermissionError:
            alive = True
        if alive and age < stale:
            return False
        path.unlink()                    # the holder is gone; the lock is litter
    except (OSError, ValueError):
        pass
    try:
        fd = os.open(str(path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except OSError:
        return False
    with os.fdopen(fd, "w") as f:
        f.write(str(os.getpid()))
    return True


def _drop_lock(path):
    try:
        path.unlink()
    except OSError:
        pass


# --------------------------------------------------------------------------- chunking
_FM = re.compile(r"\A---\r?\n(.*?)\r?\n---\r?\n?", re.S)
_TOKEN = re.compile(r"[a-z0-9][a-z0-9'\-]*")


def _split_frontmatter(text):
    """(frontmatter text, body). Deliberately local: notes_organizer's version binds
    to its own vault roots, and a chunker must work against any vault path."""
    m = _FM.match(text or "")
    if not m:
        return "", text or ""
    return m.group(1), (text or "")[m.end():]


def _fm_title(fm):
    for line in fm.split("\n"):
        if line.lower().startswith("title:"):
            return line.split(":", 1)[1].strip().strip('"').strip("'")
    return ""


def _sha(field, text):
    return sha1((MODEL + "\x00" + field + "\x00" + text).encode("utf-8")).hexdigest()


def _chunk(kind, rel, stem, title, author, year, citekey, field, text,
           page=None, heading=None, line=None, slug=None, idx=0):
    """One embeddable passage. `field` is the bare kind of passage -- head, key,
    quote or section -- because that is what the panel shows as a chip; `idx` keeps
    the several quotes of one note apart."""
    text = (text or "").strip()
    if len(text) < MIN_CHARS:
        return None
    c = {"id": "%s#%s:%d" % (rel, field, idx), "kind": kind, "rel": rel, "stem": stem,
         "title": title, "author": author, "year": year, "citekey": citekey,
         "field": field, "idx": idx, "page": page, "heading": heading, "line": line,
         "text": text, "sha": _sha(field, text)}
    if slug:
        c["slug"] = slug
    return c


def _split_long(text, limit=MAX_SECTION):
    """A long `##` block, cut at paragraph boundaries into <= limit pieces. A single
    paragraph over the limit is taken whole rather than sliced mid-sentence -- a
    truncated argument embeds worse than a long one."""
    text = text.strip()
    if len(text) <= limit:
        return [text]
    out, buf = [], ""
    for para in re.split(r"\n\s*\n", text):
        para = para.strip()
        if not para:
            continue
        if buf and len(buf) + len(para) + 2 > limit:
            out.append(buf)
            buf = para
        else:
            buf = (buf + "\n\n" + para) if buf else para
    if buf:
        out.append(buf)
    return out or [text[:limit]]


def _citation_chunks(records):
    for rec in records:
        kind = rec.get("kind") or "citation"
        if kind not in CITATION_KINDS:
            continue
        rel = rec.get("rel") or ""
        stem = rec.get("stem") or ""
        title = rec.get("title") or ""
        author = rec.get("author") or ""
        year = rec.get("year")
        citekey = rec.get("citekey") or ""
        head = "%s (%s). %s. %s" % (author, year or "n.d.", title,
                                    rec.get("citation") or "")
        c = _chunk(kind, rel, stem, title, author, year, citekey,
                   "head", head.strip()[:MAX_HEAD])
        if c:
            yield c
        for i, kp in enumerate(rec.get("keyPoints") or []):
            c = _chunk(kind, rel, stem, title, author, year, citekey,
                       "key", _strip_md(kp), idx=i)
            if c:
                yield c
        for i, q in enumerate(rec.get("quotes") or []):
            c = _chunk(kind, rel, stem, title, author, year, citekey,
                       "quote", q.get("text") or "", page=q.get("page"), idx=i)
            if c:
                yield c


_MD = re.compile(r"\*\*|__|\[\[|\]\]|`")


def _strip_md(s):
    return _MD.sub("", s or "").strip()


def _parse_blocks(body):
    """notes_blocks.parse_blocks when it imports, a faithful local copy when it does
    not (the test vault is not the real one and notes_organizer binds to a vault at
    import time)."""
    try:
        import notes_blocks
        return notes_blocks.parse_blocks(body)
    except Exception:                    # noqa: BLE001 - any import/binding failure
        return _parse_blocks_local(body)


_HEADING = re.compile(r"^(#{2,6})\s+(.*)$")
_FENCE = re.compile(r"^\s*(```|~~~)")


def _parse_blocks_local(body):
    lines = (body or "").split("\n")
    fenced, heads = False, []
    for i, ln in enumerate(lines):
        if _FENCE.match(ln):
            fenced = not fenced
            continue
        if fenced:
            continue
        m = _HEADING.match(ln)
        if m:
            heads.append((i, m.group(2).strip()))
    bounds = [h[0] for h in heads] + [len(lines)]
    out = [{"heading": None, "body": "\n".join(lines[:bounds[0]]).strip(), "start": 0}]
    for n, (ln_no, text) in enumerate(heads):
        out.append({"heading": text,
                    "body": "\n".join(lines[ln_no + 1:bounds[n + 1]]).strip(),
                    "start": ln_no})
    return out


def _note_chunks(path, rel, kind, slug=None):
    """One `##` block per chunk. `line` is the block's 0-based start WITHIN THE BODY,
    which is what /note/read hands the frontend (it returns meta and body apart), so
    a hit can scroll straight to the section."""
    try:
        raw = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return
    fm, body = _split_frontmatter(raw)
    title = _fm_title(fm) or path.stem
    for blk in _parse_blocks(body):
        heading = blk.get("heading")
        text = ((heading + "\n" + blk.get("body", "")) if heading else blk.get("body", "")).strip()
        if not text:
            continue
        for j, piece in enumerate(_split_long(text)):
            c = _chunk(kind, rel, path.stem, title, "", None, "",
                       "section", piece, heading=heading,
                       line=blk.get("start", 0), slug=slug,
                       idx=blk.get("start", 0) * 100 + j)
            if c:
                yield c


def _bare_slug(name):
    """A project folder's name the way the app addresses it."""
    return name[len(PROJECT_PREFIX):] if name.startswith(PROJECT_PREFIX) else name


def _projects(vault, roots):
    """(root tuple, project dir) for every project folder under the given roots."""
    for root in roots:
        base = Path(vault).joinpath(*root)
        if not base.is_dir():
            continue
        for proj in sorted(base.iterdir()):
            if proj.is_dir() and not proj.name.startswith("."):
                yield root, proj


_ANY_HEADING = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")


def _draft_blocks(body):
    """Heading blocks of a manuscript, `#` included: a draft's sections are `##`
    and `###` under one `#` title, and a brief uses `#` for its sections. Local on
    purpose -- notes_blocks only knows `##` and deeper."""
    lines = (body or "").split("\n")
    fenced, heads = False, []
    for i, ln in enumerate(lines):
        if _FENCE.match(ln):
            fenced = not fenced
            continue
        if fenced:
            continue
        m = _ANY_HEADING.match(ln)
        if m:
            heads.append((i, m.group(2).strip()))
    bounds = [h[0] for h in heads] + [len(lines)]
    out = [{"heading": None, "body": "\n".join(lines[:bounds[0]]).strip(), "start": 0}]
    for n, (ln_no, text) in enumerate(heads):
        out.append({"heading": text,
                    "body": "\n".join(lines[ln_no + 1:bounds[n + 1]]).strip(),
                    "start": ln_no})
    return out


def _draft_doc_chunks(path, rel, slug):
    try:
        raw = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return
    _fm, body = _split_frontmatter(raw)
    for blk in _draft_blocks(body):
        heading = blk.get("heading")
        text = blk.get("body") or ""
        if heading and DRAFT_SKIP_HEADING.match(_strip_md(heading)):
            continue
        if len(text) < DRAFT_MIN_BODY:
            continue
        full = (heading + "\n" + text) if heading else text
        for j, piece in enumerate(_split_long(full)):
            # title is the paper's name: with the heading it is the whole label a
            # result row needs, and the old search code already hands it back.
            c = _chunk("draft", rel, path.stem, slug, "", None, "",
                       "section", piece, heading=heading,
                       line=blk.get("start", 0), slug=slug,
                       idx=blk.get("start", 0) * 100 + j)
            if c:
                c["doc"] = path.name
                c["embed"] = "%s. %s\n%s" % (slug, heading or path.stem, piece)
                c["sha"] = _sha("section", c["embed"])
                yield c


def _draft_chunks(vault):
    for root, proj in _projects(vault, DRAFT_ROOTS):
        writing = proj / "writing"
        if not writing.is_dir():
            continue
        slug = _bare_slug(proj.name)
        for p in sorted(writing.glob("*.md")):      # glob, not rglob: top level only
            if p.name.startswith(("_", ".")) or DRAFT_SKIP_DOC.match(p.name) \
                    or not p.is_file():
                continue
            rel = "%s/%s/writing/%s" % ("/".join(root), proj.name, p.name)
            yield from _draft_doc_chunks(p, rel, slug)


_DATED_LOG = re.compile(r"^\d{4}-\d{2}-\d{2}_.+\.md$")


def _project_note_chunks(vault):
    for root, proj in _projects(vault, PROJECT_ROOTS):
        logs = proj / "logs"
        if not logs.is_dir():
            continue
        slug = _bare_slug(proj.name)
        for p in sorted(logs.glob("*.md")):
            if not _DATED_LOG.match(p.name):
                continue
            rel = "%s/%s/logs/%s" % ("/".join(root), proj.name, p.name)
            yield from _note_chunks(p, rel, "projectnote", slug=slug)


def _free_writing_chunks(vault):
    base = Path(vault).joinpath(*FREE_WRITING)
    if not base.is_dir():
        return
    for p in sorted(base.rglob("*.md")):
        parts = p.relative_to(base).parts
        if any(x.startswith(("_", ".")) or x.lower() == "archive" for x in parts):
            continue
        rel = "/".join(FREE_WRITING + parts)
        yield from _note_chunks(p, rel, "freewriting")


def _vault_note_chunks(vault):
    notes = Path(vault) / "Preparation" / "Notes"
    for folder, kind in NOTE_FOLDERS.items():
        d = notes / folder
        if not d.is_dir():
            continue
        for p in sorted(d.glob("*.md")):
            if p.name.startswith("_"):
                continue
            rel = "Preparation/Notes/%s/%s" % (folder, p.name)
            yield from _note_chunks(p, rel, kind)


def _project_corpus_chunks(vault):
    for root in PROJECT_ROOTS:
        base = Path(vault).joinpath(*root)
        if not base.is_dir():
            continue
        for proj in sorted(base.iterdir()):
            corpus = proj / "corpus"
            if not corpus.is_dir():
                continue
            slug = proj.name[len(PROJECT_PREFIX):] if proj.name.startswith(PROJECT_PREFIX) \
                else proj.name
            for p in sorted(corpus.glob("*.md")):
                if p.name.startswith("_"):
                    continue
                rel = "%s/%s/corpus/%s" % ("/".join(root), proj.name, p.name)
                yield from _note_chunks(p, rel, "corpus", slug=slug)


def collect_chunks(vault, here=HERE):
    """Every chunk the index should hold, in a stable order."""
    chunks = []
    try:
        import citationindex
        data = citationindex._load(here)
        records = (data or {}).get("records") or []
    except Exception:                    # noqa: BLE001 - the citation index is optional
        records = []
    chunks.extend(_citation_chunks(records))
    chunks.extend(_vault_note_chunks(vault))
    chunks.extend(_project_corpus_chunks(vault))
    chunks.extend(_free_writing_chunks(vault))
    chunks.extend(_project_note_chunks(vault))
    chunks.extend(_draft_chunks(vault))
    return chunks


# --------------------------------------------------------------------------- build
def _atomic_write_bytes(path, data):
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_bytes(data)
    os.replace(str(tmp), str(path))


def _load_cached(chunks_path, emb_path):
    """{sha: row vector} from the previous build, so only new text is re-embedded."""
    if np is None or not chunks_path.exists() or not emb_path.exists():
        return {}
    try:
        mat = np.load(str(emb_path))
        old = []
        with chunks_path.open(encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    old.append(json.loads(line))
    except (OSError, ValueError):
        return {}
    if len(old) != mat.shape[0]:
        return {}
    return {c["sha"]: mat[i] for i, c in enumerate(old)}


def build(vault=VAULT, here=HERE, full=False, pace=PACE, duty=GPU_DUTY, log=sys.stderr):
    t0 = time.time()
    chunks_path, emb_path, meta_path, lock_path = _paths()
    if np is None:
        raise RuntimeError("numpy is not installed in this interpreter")
    if not _take_lock(lock_path):
        raise LockHeld("another semindex build holds %s" % lock_path)
    try:
        chunks = collect_chunks(vault, here)
        cached = {} if full else _load_cached(chunks_path, emb_path)
        todo = []
        seen = set()
        for c in chunks:
            if c["sha"] in cached or c["sha"] in seen:
                continue
            seen.add(c["sha"])
            todo.append(c)
        print("semindex: %d chunks, %d to embed (%d reused)"
              % (len(chunks), len(todo), len(chunks) - len(todo)), file=log, flush=True)

        fresh = {}
        budget = GpuBudget(duty=duty, floor=pace)
        nbatch = math.ceil(len(todo) / BATCH) if todo else 0
        for bi in range(nbatch):
            batch = todo[bi * BATCH:(bi + 1) * BATCH]
            with budget:
                vecs = embed([DOC_PREFIX + c.get("embed", c["text"]) for c in batch])
            for c, v in zip(batch, vecs):
                fresh[c["sha"]] = v
            if bi and bi % 20 == 0:
                done = (bi + 1) * BATCH
                el = time.time() - t0
                print("semindex: %d/%d embedded, %.0fs elapsed (%.0f/s, card %.0f%%)"
                      % (min(done, len(todo)), len(todo), el, done / max(el, 0.001),
                         100.0 * budget.worked / max(budget.worked + budget.slept, 1e-6)),
                      file=log, flush=True)

        rows = np.zeros((len(chunks), DIMS), dtype=np.float32)
        keep = []
        for c in chunks:
            v = fresh.get(c["sha"])
            if v is None:
                v = cached.get(c["sha"])
            if v is None:
                continue
            vec = np.asarray(v, dtype=np.float32)
            if vec.shape[0] != DIMS:
                continue
            rows[len(keep)] = vec
            keep.append(c)
        rows = rows[:len(keep)]
        norms = np.linalg.norm(rows, axis=1, keepdims=True)
        norms[norms == 0] = 1.0
        rows /= norms

        by_kind = {}
        rels = set()
        for c in keep:
            by_kind[c["kind"]] = by_kind.get(c["kind"], 0) + 1
            rels.add(c["rel"])
        meta = {"model": MODEL, "dims": DIMS,
                "builtAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
                "chunks": len(keep), "notes": len(rels), "byKind": by_kind,
                "buildMs": int((time.time() - t0) * 1000)}

        body = "\n".join(json.dumps({kk: v for kk, v in c.items() if kk != "embed"},
                                    ensure_ascii=False) for c in keep) + "\n"
        _atomic_write_bytes(chunks_path, body.encode("utf-8"))
        # np.save appends ".npy" to a path that does not already end in it, so the
        # temp file is written through an open handle instead of by name.
        tmp = emb_path.parent / (emb_path.name + ".tmp")
        with tmp.open("wb") as fh:
            np.save(fh, rows)
        os.replace(str(tmp), str(emb_path))
        _atomic_write_bytes(meta_path, json.dumps(meta, ensure_ascii=False).encode("utf-8"))
        print("semindex: wrote %d chunks over %d notes in %.1fs"
              % (len(keep), len(rels), (time.time() - t0)), file=log, flush=True)
        return meta
    finally:
        _drop_lock(lock_path)


# --------------------------------------------------------------------------- load
_idx = {"mtime": 0.0, "chunks": None, "emb": None, "meta": None}


def _load_index():
    """The matrix and its chunks, behind an mtime memo -- a rebuild that replaces
    emb.npy is picked up on the next call without a restart."""
    chunks_path, emb_path, meta_path, _ = _paths()
    if np is None:
        return None, None, None, "numpy missing"
    try:
        mtime = os.stat(str(emb_path)).st_mtime
    except OSError:
        return None, None, None, "index not built"
    if _idx["emb"] is None or mtime != _idx["mtime"]:
        try:
            emb = np.load(str(emb_path))
            chunks = []
            with chunks_path.open(encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line:
                        chunks.append(json.loads(line))
            meta = json.loads(meta_path.read_text(encoding="utf-8")) if meta_path.exists() else {}
        except (OSError, ValueError) as e:
            return None, None, None, "index unreadable: %s" % e
        if emb.shape[0] != len(chunks):
            return None, None, None, "index out of step (%d rows, %d chunks)" % (
                emb.shape[0], len(chunks))
        _idx.update({"mtime": mtime, "emb": emb, "chunks": chunks, "meta": meta})
    return _idx["emb"], _idx["chunks"], _idx["meta"], None


_qcache = OrderedDict()


def _query_vector(q):
    v = _qcache.get(q)
    if v is not None:
        _qcache.move_to_end(q)
        return v
    vec = embed([QRY_PREFIX + q], timeout=QUERY_TIMEOUT)[0]
    arr = np.asarray(vec, dtype=np.float32)
    n = float(np.linalg.norm(arr))
    arr = arr / (n or 1.0)
    _qcache[q] = arr
    while len(_qcache) > 256:
        _qcache.popitem(last=False)
    return arr


# --------------------------------------------------------------------------- search
def _tokens(q):
    try:
        import citationindex
        stop = citationindex._STOPWORDS
    except Exception:                    # noqa: BLE001
        stop = set()
    return [t for t in _TOKEN.findall((q or "").lower()) if t not in stop and len(t) > 1]


_MOJIBAKE = {"ÔÇö": "-", "ÔÇô": "-",
             "ÔÇÖ": "'", "ÔÇ£": '"',
             "ÔÇØ": '"'}
_NOT_ALNUM = re.compile(r"[^a-z0-9]+")


def _norm_stem(s):
    for bad, good in _MOJIBAKE.items():
        s = s.replace(bad, good)
    return _NOT_ALNUM.sub("", s.lower())


_stems = {"mtime": 0.0, "exact": None, "norm": None}


def _cite_by_stem(here):
    try:
        import citationindex
        p = os.path.join(str(here), citationindex.INDEX_NAME)
        mtime = os.stat(p).st_mtime
    except Exception:                    # noqa: BLE001
        return {}, {}
    if _stems["exact"] is None or mtime != _stems["mtime"]:
        data = citationindex._load(here) or {}
        exact, norm = {}, {}
        for rec in data.get("records") or []:
            stem = rec.get("stem") or ""
            if not stem:
                continue
            exact.setdefault(stem, rec)
            norm.setdefault(_norm_stem(stem), rec)
        _stems.update({"mtime": mtime, "exact": exact, "norm": norm})
    return _stems["exact"], _stems["norm"]


def _cite_for_corpus(here, stem):
    if not stem:
        return None
    exact, norm = _cite_by_stem(here)
    return exact.get(stem) or norm.get(_norm_stem(stem))


def _cited_pairs(vault, slug, doc):
    """The (surname, year) pairs already cited in the open manuscript -- the same
    detection /drafting/corpus uses, so a hit's `cited` flag means the same thing
    in both panels."""
    if not slug:
        return set()
    try:
        import drafting
        paths = drafting._writing_paths(Path(vault), slug, doc or "paper.md")
        if not paths or not paths[0].exists():
            return set()
        return drafting.cited_pairs(drafting._read(paths[0]) or "")
    except Exception:                    # noqa: BLE001 - a missing manuscript is not an error
        return set()


def _is_cited(rec, cited):
    a = (rec.get("author") or "").strip()
    if not a or not cited:
        return False
    surname = re.split(r"[,\s]+", a)[0].lower()
    return (surname, str(rec.get("year") or "")) in cited


def _trim(text, field):
    if len(text) <= MAX_PASSAGE:
        return text
    return text[:MAX_PASSAGE - 1].rstrip() + "…"


def _lexical_hits(here, q, cited, limit=60):
    try:
        import citationindex
        return citationindex.search(here, q, cited=cited, limit=limit)
    except Exception:                    # noqa: BLE001
        return []


def _lexical_best(rec, toks):
    """The field a lexical hit should SHOW. A quote or key point carrying a query
    token says far more than the citation line, so look there first."""
    for i, qt in enumerate(rec.get("quotes") or []):
        t = (qt.get("text") or "").lower()
        if any(tok in t for tok in toks):
            return {"field": "quote", "idx": i, "text": _trim(qt.get("text") or "", "quote"),
                    "page": qt.get("page"), "heading": None, "line": None}
    for i, kp in enumerate(rec.get("keyPoints") or []):
        if any(tok in (kp or "").lower() for tok in toks):
            return {"field": "key", "idx": i, "text": _trim(_strip_md(kp), "key"),
                    "page": None, "heading": None, "line": None}
    head = "%s (%s). %s. %s" % (rec.get("author") or "", rec.get("year") or "n.d.",
                                rec.get("title") or "", rec.get("citation") or "")
    return {"field": "head", "idx": 0, "text": _trim(head.strip(), "head"),
            "page": None, "heading": None, "line": None}


def _lexical_only(here, q, k, cited, reason, t0, kinds=None):
    toks = _tokens(q)
    hits = []
    for rec in _lexical_hits(here, q, cited, limit=max(k, 40)):
        kind = rec.get("kind") or "citation"
        if kinds and kind not in kinds:
            continue
        best = _lexical_best(rec, toks)
        hits.append({"rel": rec.get("rel"), "stem": rec.get("stem"), "kind": kind,
                     "slug": None, "citeRel": None,
                     "author": rec.get("author"), "year": rec.get("year"),
                     "intext": rec.get("intext") or rec.get("author") or "",
                     "suffix": rec.get("suffix") or "",
                     "title": rec.get("title"), "citekey": rec.get("citekey"),
                     "tags": (rec.get("tags") or [])[:12],
                     "cited": bool(rec.get("alreadyCited")), "score": 0.0,
                     "best": best, "passages": [dict(best, score=0.0)]})
        if len(hits) >= k:
            break
    meta = _meta_or_empty()
    return {"ok": True, "mode": "lexical", "reason": reason,
            "ms": int((time.time() - t0) * 1000),
            "index": {"builtAt": meta.get("builtAt"), "chunks": meta.get("chunks", 0),
                      "notes": meta.get("notes", 0), "model": MODEL},
            "hits": hits}


def _meta_or_empty():
    _, _, meta_path, _ = _paths()
    try:
        return json.loads(meta_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


_kindrows = {"of": None, "rows": {}}


def _rows_of_kinds(chunks, kinds):
    """Matrix rows holding the given kinds, memoised per loaded index. A filtered
    search ranks WITHIN these rows: drafts are under 2% of the matrix, so cutting
    the overall top few hundred first and filtering after would leave almost none."""
    if _kindrows["of"] is not chunks:
        by = {}
        for i, c in enumerate(chunks):
            by.setdefault(c["kind"], []).append(i)
        _kindrows["rows"] = {kd: np.asarray(v, dtype=np.int64) for kd, v in by.items()}
        _kindrows["of"] = chunks
    parts = [_kindrows["rows"][kd] for kd in sorted(kinds) if kd in _kindrows["rows"]]
    if not parts:
        return np.zeros(0, dtype=np.int64)
    return parts[0] if len(parts) == 1 else np.concatenate(parts)


def _own_draft(slug, doc):
    slug = (slug or "").strip().lower()
    if not slug:
        return None
    return slug, (doc or "paper.md").strip().lower()


def _is_own(c, own):
    return bool(own) and c.get("kind") == "draft" \
        and (c.get("slug") or "").lower() == own[0] \
        and (c.get("doc") or "").lower() == own[1]


def search(vault=VAULT, q="", k=40, kinds=None, slug=None, doc=None, here=HERE):
    """Hybrid meaning + lexical search over the corpus. Never raises."""
    t0 = time.time()
    q = (q or "").strip()
    if isinstance(kinds, str):
        kinds = [x.strip() for x in kinds.split(",") if x.strip()]
    kinds = set(kinds) if kinds else None
    try:
        cited = _cited_pairs(vault, slug, doc)
    except Exception:                    # noqa: BLE001
        cited = set()
    if not q:
        return {"ok": True, "mode": "none", "ms": 0, "hits": [],
                "index": {"builtAt": _meta_or_empty().get("builtAt"),
                          "chunks": _meta_or_empty().get("chunks", 0),
                          "notes": _meta_or_empty().get("notes", 0), "model": MODEL}}

    emb, chunks, meta, reason = _load_index()
    if reason:
        return _lexical_only(here, q, k, cited, reason, t0, kinds)
    try:
        qv = _query_vector(q)
    except Exception as e:
        return _lexical_only(here, q, k, cited,
                             "embedding unavailable: %s" % (str(e)[:80] or type(e).__name__),
                             t0, kinds)

    try:
        sims = emb @ qv
        own = _own_draft(slug, doc)
        cand = _rows_of_kinds(chunks, kinds) if kinds else np.arange(sims.shape[0])
        n = cand.shape[0]
        take = min(TOP_CHUNKS * (3 if kinds else 1), n)
        if take and take < n:
            top = cand[np.argpartition(-sims[cand], take - 1)[:take]]
        else:
            top = cand
        top = top[np.argsort(-sims[top])]

        # group chunks into notes; a note that matches in several places is a better
        # answer than one lucky sentence, but only up to a point (3 extras).
        notes = OrderedDict()
        for i in top:
            c = chunks[int(i)]
            if (kinds and c["kind"] not in kinds) or _is_own(c, own):
                continue
            e = notes.get(c["rel"])
            if e is None:
                if len(notes) >= TOP_CHUNKS:
                    continue
                e = notes[c["rel"]] = {"chunk": c, "sim": float(sims[i]), "n": 0,
                                       "passages": []}
            e["n"] += 1
            if len(e["passages"]) < 3:
                e["passages"].append({
                    "field": c["field"], "idx": c.get("idx", 0),
                    "text": _trim(c["text"], c["field"]),
                    "page": c.get("page"), "heading": c.get("heading"),
                    "line": c.get("line"), "score": round(float(sims[i]), 4)})
        for e in notes.values():
            e["score"] = e["sim"] + 0.05 * min(3, e["n"] - 1)
        sem_order = [r for r, _ in sorted(notes.items(), key=lambda kv: -kv[1]["score"])]

        # the lexical leg keeps exact names, citekeys and titles winning
        lex = _lexical_hits(here, q, cited, limit=60)
        lex_rel = [r.get("rel") for r in lex if r.get("rel")]
        recs = {r.get("rel"): r for r in lex if r.get("rel")}
        toks = _tokens(q)
        named = set()                    # drafts whose own name is in the query
        if toks:
            qlow = " ".join(q.lower().split())
            phrase = qlow if len(toks) >= 3 else ""
            ov = {}
            for i in top:
                c = chunks[int(i)]
                if (kinds and c["kind"] not in kinds) or _is_own(c, own):
                    continue
                low = c["text"].lower()
                if c["kind"] == "draft":
                    name = (c.get("title") or "").lower()
                    low = "%s\n%s\n%s" % (name, (c.get("heading") or "").lower(), low)
                    if len(name) >= 6 and name in qlow:
                        named.add(c["rel"])
                hitn = sum(1 for t in toks if t in low)
                if phrase and phrase in " ".join(low.split()):
                    hitn += 100
                if hitn:
                    ov[c["rel"]] = max(ov.get(c["rel"], 0), hitn)
            seen_lex = set(lex_rel)
            for rel, _n in sorted(ov.items(), key=lambda kv: -kv[1])[:40]:
                if rel not in seen_lex:
                    lex_rel.append(rel)
                    seen_lex.add(rel)

        fused = {}
        for rank, rel in enumerate(sem_order):
            fused[rel] = fused.get(rel, 0.0) + 1.0 / (RRF_K + rank + 1)
        if kinds:
            def _lex_kind(rel):
                rec = recs.get(rel)
                return (rec or {}).get("kind") or (
                    notes.get(rel, {}).get("chunk", {}).get("kind") or "citation")
            lex_rel = [rel for rel in lex_rel if _lex_kind(rel) in kinds]
        for rank, rel in enumerate(lex_rel):
            fused[rel] = fused.get(rel, 0.0) + 1.0 / (RRF_K + rank + 1)
        for rel in named:
            if rel in notes:
                fused[rel] = fused.get(rel, 0.0) + 1.0 / (RRF_K + 1)

        out = []
        for rel in sorted(fused, key=lambda r: -fused[r])[:k]:
            e = notes.get(rel)
            rec = recs.get(rel) or {}
            c = (e or {}).get("chunk") or {}
            kind = c.get("kind") or rec.get("kind") or "citation"
            if e is None:
                best = _lexical_best(rec, toks) if rec else {
                    "field": "head", "idx": 0, "text": "", "page": None,
                    "heading": None, "line": None}
                passages = [dict(best, score=0.0)]
            else:
                passages = e["passages"]
                best = {kk: passages[0][kk] for kk in
                        ("field", "idx", "text", "page", "heading", "line")}
            stem = c.get("stem") or rec.get("stem") or ""
            # a project corpus note carries no bibliography of its own; borrow the
            # citation note's so the panel can cite straight from a corpus hit
            src = _cite_for_corpus(here, stem) if kind == "corpus" else None
            tags = (rec.get("tags") or (src or {}).get("tags") or [])[:12]
            out.append({
                "rel": rel, "stem": stem,
                "kind": kind, "slug": c.get("slug"), "doc": c.get("doc"),
                "citeRel": (src or {}).get("rel"),
                "author": c.get("author") or rec.get("author")
                          or (src or {}).get("author") or "",
                "year": c.get("year") if c.get("year") is not None
                        else (rec.get("year") if rec else (src or {}).get("year")),
                "title": c.get("title") or rec.get("title") or "",
                # the ASA in-text label + a/b letter, from the citation record
                "intext": rec.get("intext") or (src or {}).get("intext") or "",
                "suffix": rec.get("suffix") or (src or {}).get("suffix") or "",
                "citekey": c.get("citekey") or rec.get("citekey")
                           or (src or {}).get("citekey") or "",
                "tags": [sys.intern(str(t)) for t in tags],
                "cited": bool(rec.get("alreadyCited")) or _is_cited(c, cited)
                         or (bool(src) and _is_cited(src, cited)),
                "score": round(fused[rel], 6),
                "best": best, "passages": passages})
        return {"ok": True, "mode": "hybrid", "ms": int((time.time() - t0) * 1000),
                "index": {"builtAt": (meta or {}).get("builtAt"),
                          "chunks": (meta or {}).get("chunks", 0),
                          "notes": (meta or {}).get("notes", 0), "model": MODEL},
                "hits": out}
    except Exception as e:               # noqa: BLE001 - search must always answer
        return _lexical_only(here, q, k, cited,
                             "semantic leg failed: %s" % (str(e)[:80] or type(e).__name__),
                             t0, kinds)


def warm():
    try:
        _load_index()
        _query_vector("warm the corpus index")
        return True
    except Exception:                    # noqa: BLE001 - a warm-up never matters enough to raise
        return False


def status():
    meta = _meta_or_empty()
    chunks_path, emb_path, _, _ = _paths()
    reason = None
    ready = bool(meta) and emb_path.exists() and chunks_path.exists() and np is not None
    if np is None:
        reason = "numpy missing"
    elif not emb_path.exists() or not chunks_path.exists():
        reason = "index not built"
    return {"ready": ready, "builtAt": meta.get("builtAt"),
            "chunks": meta.get("chunks", 0), "notes": meta.get("notes", 0),
            "byKind": meta.get("byKind", {}), "model": meta.get("model", MODEL),
            "numpy": np is not None, "ollama": ollama_up(), "reason": reason}


# --------------------------------------------------------------------------- CLI
def _cli():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build")
    b.add_argument("--full", action="store_true", help="discard the cache and re-embed")
    b.add_argument("--pace", type=float, default=PACE, help="floor for the inter-batch sleep")
    b.add_argument("--duty", type=float, default=GPU_DUTY,
                   help="fraction of wall time the card may be working (default %.2f)"
                        % GPU_DUTY)
    b.add_argument("--vault", default=str(VAULT))
    s = sub.add_parser("search")
    s.add_argument("query")
    s.add_argument("--k", type=int, default=10)
    s.add_argument("--kinds", default=None)
    s.add_argument("--slug", default=None)
    s.add_argument("--doc", default="paper.md")
    sub.add_parser("status")
    a = ap.parse_args()

    if a.cmd == "build":
        try:
            meta = build(Path(a.vault), HERE, full=a.full, pace=a.pace, duty=a.duty)
        except LockHeld as e:
            print("semindex: skipped, %s" % e, file=sys.stderr)
            return 0
        print(json.dumps(meta, ensure_ascii=False))
        return 0
    if a.cmd == "status":
        print(json.dumps(status(), ensure_ascii=False, indent=2))
        return 0

    res = search(VAULT, a.query, k=a.k, kinds=a.kinds, slug=a.slug, doc=a.doc)
    print("mode=%s ms=%d chunks=%s%s" % (
        res["mode"], res["ms"], res.get("index", {}).get("chunks"),
        "  reason=" + res["reason"] if res.get("reason") else ""))
    for h in res["hits"]:
        who = ("%s %s" % (h["author"] or h["stem"][:24], h["year"] or "")).strip()
        pg = ("p." + str(h["best"]["page"])) if h["best"].get("page") else ""
        print("%.4f  %-9s %-28s %-12s %-6s %s" % (
            h["score"], h["kind"][:9], who[:28], h["best"]["field"][:12], pg,
            " ".join(h["best"]["text"].split())[:80]))
    return 0


if __name__ == "__main__":
    sys.exit(_cli())
