"""The compact reference index the Drafting citation picker searches IN THE BROWSER."""
import os
from collections import Counter

import citationindex

# directories a record's rel can live in, in citationindex.SOURCE_DIRS order. A rel
# outside them ships whole (field "r") rather than as a (dir, stem) pair.
DIRS = tuple("/".join(sub) for sub, _kind in citationindex.SOURCE_DIRS)
_DIR_IX = {d: i for i, d in enumerate(DIRS)}

# a tag on fewer than this many records is dropped from the shipped vocabulary
MIN_TAG_USES = 2


def _rel_parts(rel):
    """(dir index, stem) for a rel inside a known source dir, else (None, None)."""
    rel = (rel or "").replace("\\", "/")
    head, _, tail = rel.rpartition("/")
    if not tail.lower().endswith(".md"):
        return None, None
    ix = _DIR_IX.get(head)
    return (ix, tail[:-3]) if ix is not None else (None, None)


def _vocabulary(records):
    """Tags used on at least MIN_TAG_USES records, most-used first (so the common
    ones get the shortest ids and the JSON stays small)."""
    uses = Counter(t for r in records for t in (r.get("tags") or []))
    return [t for t, n in uses.most_common() if n >= MIN_TAG_USES]


def compact(here):
    """The served payload: every citable record as the picker's candidate row."""
    records = citationindex.records(here) or []
    vocab = _vocabulary(records)
    tix = {t: i for i, t in enumerate(vocab)}
    out = []
    for r in records:
        if r.get("dupOf"):               # a second copy of one work: offer the keeper only
            continue
        kind = r.get("kind") or "citation"
        ix, stem = _rel_parts(r.get("rel"))
        row = {"n": stem if stem is not None else (r.get("stem") or ""),
               "a": r.get("author") or "",
               "y": r.get("year"),
               "t": r.get("title") or "",
               "k": r.get("citekey") or ""}
        if r.get("intext") and r["intext"] != row["a"]:
            row["i"] = r["intext"]
        if r.get("suffix"):
            row["x"] = r["suffix"]
        if ix is not None:
            row["f"] = ix
        else:
            row["r"] = r.get("rel") or ""
        if kind != "citation":
            row["d"] = kind
        g = [tix[t] for t in (r.get("tags") or []) if t in tix]
        if g:
            row["g"] = g
        # a clipping's publisher shows in the picker's preview line; a citation's
        # source is a DOI/URL nothing in the picker renders, so it does not travel
        if kind != "citation" and r.get("source"):
            row["s"] = r["source"]
        nq = len(r.get("quotes") or [])
        nk = len(r.get("keyPoints") or [])
        if nq:
            row["q"] = nq
        if nk:
            row["p"] = nk
        out.append(row)
    return {"count": len(out), "dirs": list(DIRS), "tagv": vocab, "records": out,
            "ready": bool(records)}


def detail(here, rel):
    """One record in full -- the quote drill-down and the candidate preview."""
    rel = (rel or "").replace("\\", "/").strip()
    if not rel:
        return {"ok": False, "error": "rel required"}
    for r in citationindex.records(here) or []:
        if (r.get("rel") or "").replace("\\", "/") == rel:
            return {"ok": True, "rel": rel, "stem": r.get("stem") or "",
                    "kind": r.get("kind") or "citation",
                    "author": r.get("author") or "", "year": r.get("year"),
                    "intext": r.get("intext") or r.get("author") or "",
                    "suffix": r.get("suffix") or "",
                    "title": r.get("title") or "", "citekey": r.get("citekey") or "",
                    "source": r.get("source") or "", "tags": r.get("tags") or [],
                    "status": r.get("status"), "rating": r.get("rating"),
                    "citation": r.get("citation") or "",
                    "keyPoints": r.get("keyPoints") or [],
                    "quotes": r.get("quotes") or []}
    return {"ok": False, "error": "not found"}


def status(here):
    d = citationindex._load(here)
    if not d:
        return {"ready": False, "count": 0, "mtime": 0}
    p = os.path.join(str(here), citationindex.INDEX_NAME)
    try:
        mtime = os.stat(p).st_mtime
    except OSError:
        mtime = 0
    return {"ready": True, "count": d.get("count", 0), "mtime": mtime}


if __name__ == "__main__":                      # sizing check, run from this dir
    import json, sys
    from compression import zstd
    here = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.abspath(__file__))
    payload = compact(here)
    raw = json.dumps(payload).encode("utf-8")
    print("records %d  raw %d  zstd3 %d" % (payload["count"], len(raw),
                                            len(zstd.compress(raw, 3))))
