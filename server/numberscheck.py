"""numberscheck.py — validate manuscript numbers against their source CSVs."""

import csv
import json
import re
from pathlib import Path

try:   # sibling module; also importable when this file is loaded by path
    import fignotes
except ImportError:
    try:
        import sys as _sys
        _sys.path.insert(0, str(Path(__file__).resolve().parent))
        import fignotes
    except ImportError:
        fignotes = None

NUM_RE = re.compile(r"(?<![\w.])[-+]?\d{1,3}(?:,\d{3})+(?:\.\d+)?|(?<![\w.])[-+]?\d+\.\d+|(?<![\w.])[-+]?\d+(?![\w.])")
# label prefixes whose trailing number is not a statistic: "Table 3", "Models 1 and 2",
# "Wave 2", "H2", plus list continuations of a Model/Wave label ("Models 1 and 2").
EXCLUDE_CONTEXT = re.compile(
    r"(?:Table|Figure|Model|Wave|Hypothesis|Section|Appendix|Panel|Step|H)s?\s*$"
    r"|(?:Model|Wave|Hypothesis|Step)s?\s+\d+(?:\s*,\s*\d+)*\s*(?:,|and|&|–|-)\s*$",
    re.IGNORECASE,
)
YEAR_RE = re.compile(r"^(19|20)\d{2}$")
# a parenthetical scale range "(1-5)" / "(0–3)" — both endpoints are scale
# denotations, not statistics.
RANGE_PAREN_RE = re.compile(r"\(\s*\d+\s*[–—-]\s*\d+\s*\)")
# "5-point", "12-item", "7-category" — instrument descriptions.
UNIT_SUFFIX_RE = re.compile(r"^\s*[–—-]\s*(?:point|item|category|categor)", re.IGNORECASE)
PAGE_CITE_PREFIX_RE = re.compile(r"(?:19|20)\d{2}[a-z]?\s*:\s*(?:\d+\s*[–—-]\s*)?$")

BLOCKING_STATUSES = ("DRIFT", "ORPHANED", "NOT-FOUND", "AMBIGUOUS", "ENTRY-ERROR")
# an inserted number whose prose anchor moved is ORPHANED, not wrong — it is
# advisory. These four mean the number itself no longer stands up.
INSERTED_BLOCKING = ("DRIFT", "NOT-FOUND", "AMBIGUOUS", "ENTRY-ERROR")


def _is_inserted(entry):
    return (entry or {}).get("insertedBy") == "board"


def norm_text(s):
    return re.sub(r"\s+", " ", str(s)).strip()


def parse_written(written):
    # the Insert-number formats write the typographic minus (U+2212) and may carry a
    # thin/narrow space; normalise before float() so a correctly typeset "−0.42" binds.
    s = str(written)
    for ch in ("−", "‒", "–"):
        s = s.replace(ch, "-")
    s = s.replace(" ", "").replace(" ", "").replace(" ", "")
    return float(s.replace(",", "").replace("%", "").strip())


def decimals_of(written):
    s = str(written)
    return len(s.split(".", 1)[1]) if "." in s else 0


CELL_NUM_RE = re.compile(
    r"(?<![\w.])[-+]?(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d*\.\d+|\d+)(?:[eE][-+]?\d+)?")


def first_number(cell):
    m = CELL_NUM_RE.search(str(cell))
    if not m:
        raise ValueError("no numeric value in cell %r" % (cell,))
    return float(m.group(0).replace(",", ""))


def load_rows(path):
    with open(str(path), newline="", encoding="utf-8-sig") as fh:
        return list(csv.DictReader(fh))


def resolve_row(rows, selector, entry_id):
    if selector is None:
        if len(rows) != 1:
            return None, "%s: no row selector and CSV has %d rows" % (entry_id, len(rows))
        return rows[0], None
    if isinstance(selector, int):
        if selector >= len(rows):
            return None, "%s: row index %d out of range (%d rows)" % (entry_id, selector, len(rows))
        return rows[selector], None
    matches = [
        r for r in rows
        if all(norm_text(r.get(k, "")) == norm_text(v) for k, v in selector.items())
    ]
    if not matches:
        return None, "%s: NOT-FOUND — no row matches %s" % (entry_id, selector)
    if len(matches) > 1:
        return None, "%s: AMBIGUOUS — %d rows match %s" % (entry_id, len(matches), selector)
    return matches[0], None


SCRATCH_DOCS = frozenset({"notes.md"})


def _is_scratch(doc):
    return (doc or "").strip().lower().rsplit("/", 1)[-1] in SCRATCH_DOCS


def doc_path_for(project, doc):
    project = Path(project)
    doc = str(doc or "")
    parts = doc.replace("\\", "/").split("/")
    if doc[:1] in ("/", "\\") or ".." in parts or ":" in parts[0]:
        return project / "writing" / ".invalid-doc"
    if doc.lower() == "readme.md":
        return project / "README.md"
    if parts[0] == "logs" and len(parts) > 1:
        return project / doc
    return project / "writing" / doc


def _occurrences(text, needle, limit=3):
    out, i = [], text.find(needle)
    while i != -1 and len(out) < limit:
        out.append(i)
        i = text.find(needle, i + 1)
    return out


def _fmt_like(value, written):
    s = str(written).strip()
    pct = s.endswith("%")
    core = s[:-1].strip() if pct else s
    out = "%.*f" % (decimals_of(core), value)
    if "," in core:
        neg, body = out.startswith("-"), out.lstrip("-")
        ip, _, fp = body.partition(".")
        try:
            ip = "{:,}".format(int(ip))
        except ValueError:
            pass
        out = ("-" if neg else "") + ip + ("." + fp if fp else "")
    return out + "%" if pct else out


def check_entry(entry, doc_text, project):
    """(status, msg) — the long-standing signature the CLI and drafting.py read."""
    status, msg, _ = _check_entry(entry, doc_text, project)
    return status, msg


def _check_entry(entry, doc_text, project, reanchor=False):
    """(status, msg, extra) where extra carries `current` (the live cell as written),
    `reanchored` and `anchor` (the offset the row's line is taken from)."""
    eid = entry.get("id", "<no-id>")
    quote = entry.get("quote", "")
    written = entry.get("written", "")
    extra = {"current": None, "reanchored": False, "anchor": None}
    orphan = "%s: quote not found verbatim in manuscript — re-verify and re-anchor" % eid
    if not quote or not written:
        return "ENTRY-ERROR", "%s: entry needs both quote and written" % eid, extra
    idx = doc_text.find(quote)
    if idx < 0:
        if not reanchor:
            return "ORPHANED", orphan, extra
        ins = str(entry.get("display") or written)
        hits = _occurrences(doc_text, ins)
        if len(hits) != 1:
            return "ORPHANED", orphan, extra
        idx = hits[0]
        extra["reanchored"] = True
    elif str(written) not in quote:
        return "ENTRY-ERROR", "%s: written %r does not appear inside its quote" % (eid, written), extra
    extra["anchor"] = idx

    src = Path(project) / entry.get("file", "")
    if not src.exists():
        return "NOT-FOUND", "%s: source file missing on this tree: %s" % (eid, entry.get("file")), extra
    try:
        rows = load_rows(src)
    except Exception as exc:
        return "ENTRY-ERROR", "%s: cannot read %s: %s" % (eid, entry.get("file"), exc), extra

    row, err = resolve_row(rows, entry.get("row"), eid)
    if err:
        return "NOT-FOUND", err, extra
    col = entry.get("column")
    if col not in row:
        return "ENTRY-ERROR", "%s: column %r not in %s (has: %s...)" % (eid, col, entry.get("file"), list(row)[:8]), extra
    status, msg, current = _compare_cell_full(entry, row[col])
    extra["current"] = current
    return status, msg, extra


def _compare_cell(entry, cell):
    """(status, msg) — bind() refuses to create a binding that would not TRACE now."""
    status, msg, _ = _compare_cell_full(entry, cell)
    return status, msg


def _compare_cell_full(entry, cell):
    eid = entry.get("id", "<no-id>")
    written = entry.get("written", "")
    col = entry.get("column")
    if entry.get("mode") == "text":
        current = norm_text(cell)
        if current == norm_text(written):
            return "TRACED", "%s: %r == %s[%s]" % (eid, written, entry.get("file"), col), current
        return "DRIFT", "%s: written %r vs cell %r (%s[%s])" % (eid, written, current, entry.get("file"), col), current

    try:
        value = first_number(cell) * float(entry.get("scale", 1))
        target = parse_written(written)
    except ValueError as exc:
        return "ENTRY-ERROR", "%s: %s" % (eid, exc), None
    if entry.get("mode") == "threshold":
        # "p < .001": written is an upper bound the cell must fall under. The Insert-
        # number p-value format binds this way, so a re-run that lifts p to .004 DRIFTS.
        current = "%g" % value
        if value < target:
            return "TRACED", "%s: %g < %s (%s[%s])" % (eid, value, written, entry.get("file"), col), current
        return "DRIFT", (
            "%s: written as below %s but source gives %g (%s[%s], scale=%s) — "
            "the threshold no longer holds"
            % (eid, written, value, entry.get("file"), col, entry.get("scale", 1))
        ), current
    current = _fmt_like(value, written)
    tol = 0.5 * 10 ** (-decimals_of(written)) + 1e-9
    if abs(value - target) <= tol:
        return "TRACED", "%s: %s ~= %g (%s[%s])" % (eid, written, value, entry.get("file"), col), current
    return "DRIFT", (
        "%s: written %s but source gives %g (%s[%s], scale=%s) — "
        "re-run changed the number or the prose is stale"
        % (eid, written, value, entry.get("file"), col, entry.get("scale", 1))
    ), current


REFS_HEADING_RE = re.compile(r"^#{1,3}\s*References\s*$", re.MULTILINE | re.IGNORECASE)


def unbound_numbers(doc_text, bound_quotes, limit=40):
    # numbers in the reference list (page ranges, volumes, issues) are not
    # statistics — stop the sweep at the References heading.
    refs = REFS_HEADING_RE.search(doc_text)
    scan_end = refs.start() if refs else len(doc_text)
    covered = []
    for q in bound_quotes:
        if not q:
            continue
        start = doc_text.find(q)
        while start != -1:
            covered.append((start, start + len(q)))
            start = doc_text.find(q, start + 1)
    # pre-mark parenthetical scale ranges so both endpoints are skipped
    range_spans = [(m.start(), m.end()) for m in RANGE_PAREN_RE.finditer(doc_text)]
    out = []
    for m in NUM_RE.finditer(doc_text):
        if m.start() >= scan_end:
            break
        if any(a <= m.start() < b for a, b in covered):
            continue
        if any(a <= m.start() < b for a, b in range_spans):
            continue
        tok = m.group(0)
        if YEAR_RE.match(tok.replace(",", "")):
            continue
        prefix = doc_text[max(0, m.start() - 40):m.start()]
        if EXCLUDE_CONTEXT.search(prefix):
            continue
        if prefix.rstrip().endswith(("±", "+/-")):
            continue
        if PAGE_CITE_PREFIX_RE.search(prefix):
            continue
        if UNIT_SUFFIX_RE.match(doc_text[m.end():m.end() + 12]):
            continue
        if "![[" in prefix or "[[" in doc_text[max(0, m.start() - 60):m.start()]:
            continue
        line = doc_text[:m.start()].count("\n") + 1
        ctx = norm_text(doc_text[max(0, m.start() - 40):m.end() + 25])
        out.append({"line": line, "token": tok, "context": ctx})
        if len(out) >= limit:
            out.append({"line": 0, "token": "", "context": "... (truncated)"})
            break
    return out


def _cell_label(entry):
    sel = entry.get("row")
    if isinstance(sel, dict):
        where = ", ".join("%s=%s" % (k, v) for k, v in sel.items())
    elif sel is None:
        where = "single row"
    else:
        where = "row %s" % sel
    return "%s · %s" % (entry.get("column"), where)


def _drift_instruction(entry, docname, line, current):
    return ('%s:%s inserted number "%s" is now "%s" in %s [%s] — change it in the document'
            % (docname, line if line else "?", entry.get("written"), current,
               entry.get("file"), _cell_label(entry)))


def check_project(project, doc="paper.md", all_docs=False, inserted_only=False):
    """Run the numbers gate for a project. Returns a JSON-able dict:"""
    project = Path(project)
    store_path = project / "writing" / "versioning" / "numbers.json"
    all_entries = []
    store_err = None
    if store_path.exists():
        try:
            all_entries = json.loads(store_path.read_text(encoding="utf-8")).get("entries", [])
        except Exception as exc:
            store_err = "numbers.json unreadable: %s" % exc
    entries = [e for e in all_entries if _is_inserted(e)] if inserted_only else all_entries
    entries = [e for e in entries if not _is_scratch(e.get("doc", "paper.md"))]

    doc_names = [] if _is_scratch(doc) else [doc]
    for e in entries:
        d = e.get("doc", "paper.md")
        if d not in doc_names:
            doc_names.append(d)
    if all_docs:
        for extra in ("appendix.md", "proposal.md", "supplement.md", "README.md"):
            if extra not in doc_names and doc_path_for(project, extra).exists():
                doc_names.append(extra)

    texts, docs_out = {}, {}
    for name in doc_names:
        p = doc_path_for(project, name)
        if p.exists():
            texts[name] = p.read_text(encoding="utf-8", errors="replace")
        docs_out[name] = {"counts": {}, "results": [], "unbound": [], "missing": name not in texts}

    blocking, advisory, traced, inserted_n = [], [], 0, 0
    if store_err:
        blocking.append(store_err)
    by_doc = {}
    for e in entries:
        by_doc.setdefault(e.get("doc", "paper.md"), []).append(e)

    manifest = _load_provenance(project) if entries else {}
    src_meta_cache, script_cache = {}, {}

    def result_row(e, status, msg, text=None, extra=None):
        # per-binding row for the Drafting NUMBERS panel: verdict + the entry's
        # own fields + the anchor's 1-based line, for jump-to.
        extra = extra or {}
        ins = _is_inserted(e)
        line, q = None, e.get("quote") or ""
        if text is not None:
            idx = extra.get("anchor")
            if idx is None and q:
                idx = text.find(q)
                idx = idx if idx >= 0 else None
            if idx is not None:
                line = text.count("\n", 0, idx) + 1
        rel = e.get("file") or ""
        if rel not in src_meta_cache:
            src_meta_cache[rel] = _source_meta(project, rel, manifest)
        meta = src_meta_cache[rel]
        snap = e.get("source") or {}
        source_changed = bool(snap.get("sha256")) and bool(meta.get("sha256")) and snap.get("sha256") != meta.get("sha256")
        # staleness of the producing script is an inserted-only question, and one
        # hash per source file however many numbers came out of it
        script_state, script_rel = None, None
        if ins:
            if rel not in script_cache:
                script_cache[rel] = _script_state(project, rel, meta)
            script_state, script_rel = script_cache[rel]
        return {"status": status, "msg": msg, "id": e.get("id"),
                "quote": q, "written": e.get("written"),
                "file": rel, "column": e.get("column"),
                "row": e.get("row"), "scale": e.get("scale", 1),
                "mode": e.get("mode", "numeric"), "note": e.get("note"),
                "line": line,
                "key": bool(e.get("key")), "insertedAt": e.get("insertedAt"),
                "display": e.get("display"),
                "provenance": meta.get("provenance"),
                "sourceSha256": meta.get("sha256"), "sourceMtime": meta.get("mtime"),
                "sourceChanged": source_changed,
                "inserted": ins, "insertedBy": e.get("insertedBy"),
                "blocks": bool(ins and status in INSERTED_BLOCKING),
                "current": extra.get("current"),
                "reanchored": bool(extra.get("reanchored")),
                "scriptState": script_state, "script": script_rel}

    for name, es in by_doc.items():
        d = docs_out.setdefault(name, {"counts": {}, "results": [], "unbound": [], "missing": name not in texts})
        if name not in texts:
            for e in es:
                msg = "%s: doc %s not found for this entry" % (e.get("id", "<no-id>"), name)
                r = result_row(e, "ENTRY-ERROR", msg)
                d["results"].append(r)
                d["counts"]["ENTRY-ERROR"] = d["counts"].get("ENTRY-ERROR", 0) + 1
                inserted_n += 1 if r["inserted"] else 0
                (blocking if r["blocks"] else advisory).append(msg)
            continue
        for e in es:
            ins = _is_inserted(e)
            status, msg, extra = _check_entry(e, texts[name], project, reanchor=ins)
            r = result_row(e, status, msg, texts[name], extra)
            if ins and status == "DRIFT":
                msg = _drift_instruction(e, name, r["line"], extra.get("current"))
                r["msg"] = msg
            d["results"].append(r)
            d["counts"][status] = d["counts"].get(status, 0) + 1
            inserted_n += 1 if ins else 0
            if status == "TRACED":
                traced += 1
            elif r["blocks"]:
                blocking.append(msg)
            else:
                advisory.append(msg)

    # the two actionable lists: numbers to change in the document, and tables whose
    # producer moved on so the number cannot be trusted either way
    stale, script_stale = [], {}
    for name, d in docs_out.items():
        for r in d["results"]:
            if not r.get("inserted"):
                continue
            if r["status"] == "DRIFT":
                stale.append({"id": r["id"], "doc": name, "line": r["line"],
                              "written": r["written"], "current": r["current"],
                              "file": r["file"], "column": r["column"], "row": r["row"],
                              "script": r["script"], "scriptState": r["scriptState"]})
            if r.get("scriptState") == "edited":
                g = script_stale.setdefault(r["file"], {"file": r["file"], "script": r["script"], "ids": []})
                g["ids"].append(r["id"])

    unbound_total = 0
    if not inserted_only:
        for name, text in texts.items():
            quotes = [e.get("quote", "") for e in by_doc.get(name, [])]
            ub = unbound_numbers(text, quotes)
            docs_out[name]["unbound"] = ub
            unbound_total += len([u for u in ub if u.get("token")])

    return {
        "bound": bool(all_entries),
        "storePath": str(store_path) if store_path.exists() else None,
        "docs": docs_out,
        "blocking": blocking,
        "advisory": advisory,
        "stale": stale,
        "scriptStale": list(script_stale.values()),
        "traced": traced,
        "failing": len(blocking),
        "advisoryCount": len(advisory),
        "inserted": inserted_n,
        "unboundTotal": unbound_total,
    }


import hashlib
import os
import shutil
import time

TABLE_ROOTS = ("results", "results/supplementary", "replication/output",
               "replication/exploration/output")
MAX_TABLE_FILES = 240
MAX_TABLE_BYTES = 6 * 1024 * 1024
MAX_ROWS_PER_TABLE = 400
MAX_COLS_PER_TABLE = 48
# a cell that IS a statistic: a number, optionally parenthesised (an SE), with
# significance stars / daggers / a superscript letter — not a sentence with a number in it
PURE_NUM_RE = re.compile(
    r"^[\(\[]?\s*[-+−]?(?:\d{1,3}(?:,\d{3})+|\d*\.?\d+)(?:\.\d+)?(?:[eE][-+]?\d+)?\s*%?\s*[\)\]]?\s*(?:[*†‡]{0,4}|[a-z]{0,2})$")


def _sha256(path):
    h = hashlib.sha256()
    with open(str(path), "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def _load_provenance(project):
    """results/provenance.json as a dict, {} when missing/unparseable (mirrors
    drafting._load_provenance; inlined so this module stays import-free)."""
    p = Path(project) / "results" / "provenance.json"
    if not p.is_file():
        return {}
    try:
        d = json.loads(p.read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def _prov_for_file(rel, manifest):
    """The provenance.json record for a results/ CSV, keyed by stem. None for files
    the recorder never saw (replication/output/*.csv)."""
    name = rel.replace("\\", "/").rsplit("/", 1)[-1]
    stem = re.sub(r"\.csv$", "", name, flags=re.I)
    rec = manifest.get(stem)
    if not isinstance(rec, dict):
        return None
    return {"stem": stem, "script": rec.get("script"), "scriptSha256": rec.get("scriptSha256"),
            "generated": rec.get("generated"), "generatedBy": rec.get("generatedBy"),
            "commit": rec.get("commit"), "dataSources": rec.get("dataSources"),
            "verified": rec.get("verified"),
            "recordedSha256": (rec.get("outputSha256") or {}).get("csv")}


def _source_meta(project, rel, manifest):
    out = {"sha256": None, "mtime": None, "provenance": None}
    if not rel:
        return out
    p = Path(project) / rel
    if not p.is_file():
        out["provenance"] = {"freshness": "missing"}
        return out
    try:
        out["sha256"] = _sha256(p)
        out["mtime"] = int(p.stat().st_mtime * 1000)
    except OSError:
        return out
    prov = _prov_for_file(rel, manifest)
    if prov is None:
        out["provenance"] = {"freshness": "unrecorded"}
        return out
    want = prov.pop("recordedSha256", None)
    prov["freshness"] = "unrecorded" if not want else ("fresh" if want == out["sha256"] else "stale")
    out["provenance"] = prov
    return out


SCRIPT_EXTS = (".py", ".do", ".r", ".jl", ".sql")
SCRIPT_ROOTS = ("replication", "scripts", "code")


def _script_files(project):
    """script files under replication/, scripts/, code/ — top level plus one
    subfolder level, archived and hidden folders skipped."""
    out = []
    for root in SCRIPT_ROOTS:
        d = Path(project) / root
        if not d.is_dir():
            continue
        try:
            kids = sorted(d.iterdir())
        except OSError:
            continue
        for p in kids:
            if p.is_file() and p.suffix.lower() in SCRIPT_EXTS:
                out.append(p)
            elif p.is_dir() and not _is_dead_dir(p.name):
                try:
                    out.extend(q for q in sorted(p.iterdir())
                               if q.is_file() and q.suffix.lower() in SCRIPT_EXTS)
                except OSError:
                    pass
    return out


def _unique_producer(project, rel):
    """the one script naming this CSV's basename — None when zero or several do."""
    name = rel.replace("\\", "/").rsplit("/", 1)[-1]
    if not name:
        return None
    hit = None
    for p in _script_files(project):
        try:
            if name not in p.read_text(encoding="utf-8", errors="ignore"):
                continue
        except OSError:
            continue
        if hit is not None:
            return None
        hit = p
    return hit


def _script_state(project, rel, meta):
    project = Path(project)
    prov = (meta or {}).get("provenance") or {}
    recorded = prov.get("script")
    if recorded:
        srel = str(recorded).replace("\\", "/")
        script = project / srel
        if not script.is_file():
            return "missing", srel
    else:
        script = _unique_producer(project, rel)
        if script is None:
            return "unrecorded", None
        try:
            srel = script.relative_to(project).as_posix()
        except ValueError:
            srel = script.as_posix()
    try:
        disk = _sha256(script)
        mtime = int(script.stat().st_mtime * 1000)
    except OSError:
        return "unrecorded", srel
    want = prov.get("scriptSha256")
    if want:
        return ("current" if want == disk else "edited"), srel
    gen = prov.get("generated")
    if isinstance(gen, (int, float)) and gen:
        return ("edited" if mtime > gen else "current"), srel
    csv_mtime = (meta or {}).get("mtime")
    if csv_mtime:
        return ("edited" if mtime > csv_mtime else "current"), srel
    return "current", srel


def _store_path(project):
    return Path(project) / "writing" / "versioning" / "numbers.json"


def _load_store(project):
    p = _store_path(project)
    if not p.is_file():
        return {"entries": []}
    try:
        d = json.loads(p.read_text(encoding="utf-8"))
    except Exception as exc:
        raise ValueError("numbers.json unreadable: %s" % exc)
    if not isinstance(d, dict):
        d = {"entries": []}
    if not isinstance(d.get("entries"), list):
        d["entries"] = []
    return d


def _save_store(project, data):
    """One-deep .bak, then temp + os.replace."""
    p = _store_path(project)
    p.parent.mkdir(parents=True, exist_ok=True)
    if p.is_file():
        try:
            shutil.copyfile(str(p), str(p.with_name("numbers.json.bak")))
        except OSError:
            pass
    tmp = Path(str(p) + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(str(tmp), str(p))
    return int(p.stat().st_mtime * 1000)


def _is_dead_dir(name):
    n = str(name).lower()
    return n.startswith(".") or n == "archive" or n.startswith("archive_") or n.startswith("archive-")


def _table_files(project):
    """Every candidate result table, in walk order: TABLE_ROOTS, then one level of
    per-analysis subfolders under replication/output. UNCAPPED — catalogue() applies
    MAX_TABLE_FILES itself so it can report what the cap dropped."""
    project = Path(project)
    out = []
    for root in TABLE_ROOTS:
        d = project / root
        if not d.is_dir():
            continue
        for p in sorted(d.iterdir()):
            if p.is_file() and p.suffix.lower() == ".csv":
                out.append(p)
    d = project / "replication" / "output"
    if d.is_dir():   # one level of per-analysis subfolders
        for sub in sorted(x for x in d.iterdir() if x.is_dir() and not _is_dead_dir(x.name)):
            for p in sorted(sub.iterdir()):
                if p.is_file() and p.suffix.lower() == ".csv":
                    out.append(p)
    return out


def _is_stat_cell(v):
    s = str(v).strip()
    return bool(s) and s not in ("—", "–", "-", "NA", "na", "n/a", "NaN", ".") and bool(PURE_NUM_RE.match(s))


def _classify(rows, cols):
    """(numericColumns, labelColumns): a column is numeric when >=60% of its non-empty
    cells are statistics; everything else (terms, countries, outcomes) labels the row."""
    numeric, label = [], []
    for c in cols:
        vals = [r.get(c, "") for r in rows if str(r.get(c, "")).strip() != ""]
        if not vals:
            continue
        n_num = sum(1 for v in vals if _is_stat_cell(v))
        if n_num >= max(1, int(0.6 * len(vals))):
            numeric.append(c)
        else:
            label.append(c)
    return numeric, label


def _row_selectors(rows, label_cols):
    """Per row: an equality selector over the label columns that identifies EXACTLY
    one row (the shape resolve_row reads), else the 0-based index."""
    keys = []
    for r in rows:
        keys.append(tuple((c, norm_text(r.get(c, ""))) for c in label_cols if str(r.get(c, "")).strip() != ""))
    counts = {}
    for k in keys:
        counts[k] = counts.get(k, 0) + 1
    out = []
    for i, k in enumerate(keys):
        if k and counts[k] == 1:
            out.append(dict(k))
        else:
            out.append(i)
    return out


def _header_caption(project, stem):
    if fignotes is None:
        return None
    fn = fignotes.notes(project, stem)
    if not fn:
        return None
    body = fn["caption"] or fignotes.field(fn, "Shows") or fn["summary"] or ""
    cap = body if fn["caption"] else re.split(r"(?<=[.!?])\s", body, maxsplit=1)[0]
    return norm_text(re.sub(r"[*_`]", "", cap))[:180] or None


def _captions(project):
    p = Path(project) / "results" / "0.figure_notes.md"
    if not p.is_file():
        return {}
    try:
        lines = p.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return {}
    caps = {}
    for i, ln in enumerate(lines):
        m = re.match(r"^#{1,6}\s+.*?((?:fig|tab)S?\.?\d*\.[\w.-]+)", ln, re.I)
        if not m:
            continue
        stem = re.sub(r"\.(csv|png|svg|pdf)$", "", m.group(1), flags=re.I)
        body = " ".join(l.strip() for l in lines[i + 1:i + 8] if l.strip() and not l.startswith("#"))
        sc = re.search(r"\*\*Suggested caption:?\*\*\s*(.+?)(?:\.\s|$)", body)
        cap = sc.group(1) if sc else re.split(r"(?<=[.!?])\s", body, 1)[0]
        cap = norm_text(re.sub(r"[*_`]", "", cap))[:180]
        if cap and stem not in caps:
            caps[stem] = cap
    return caps


def catalogue(project, q="", limit_hits=80):
    """Every citable number in the project, table by table:"""
    project = Path(project)
    manifest = _load_provenance(project)
    caps = _captions(project)
    store = _load_store(project)
    bound = {}
    for e in store.get("entries", []):
        k = (str(e.get("file") or "").replace("\\", "/"), e.get("column"), json.dumps(e.get("row"), sort_keys=True))
        bound.setdefault(k, []).append(e.get("id"))
    tokens = [t for t in re.split(r"\s+", (q or "").strip().lower()) if t]
    tables, hits, skipped = [], [], []
    candidates = _table_files(project)
    walked = candidates[:MAX_TABLE_FILES]
    for p in walked:
        rel = p.relative_to(project).as_posix()
        try:
            if p.stat().st_size > MAX_TABLE_BYTES:
                skipped.append({"file": rel, "reason": "too large"})
                continue
            rows = load_rows(p)
        except Exception as exc:
            skipped.append({"file": rel, "reason": str(exc)})
            continue
        cols = list(rows[0].keys())[:MAX_COLS_PER_TABLE] if rows else []
        if not rows or not cols:
            continue
        truncated = len(rows) > MAX_ROWS_PER_TABLE
        rows = rows[:MAX_ROWS_PER_TABLE]
        numeric, label = _classify(rows, cols)
        if not numeric:
            continue
        label = label[:3]
        sels = _row_selectors(rows, label)
        meta = _source_meta(project, rel, manifest)
        stem = re.sub(r"\.csv$", "", p.name, flags=re.I)
        caption = _header_caption(project, stem) or caps.get(stem)
        t = {"file": rel, "stem": stem, "name": p.name, "root": rel.rsplit("/", 1)[0],
             "caption": caption, "sha256": meta["sha256"], "mtime": meta["mtime"],
             "provenance": meta["provenance"], "columns": cols, "numericColumns": numeric,
             "labelColumns": label, "rowCount": len(rows), "truncated": truncated, "rows": []}
        table_text = (stem + " " + (caption or "")).lower()
        for i, r in enumerate(rows):
            lab = " · ".join(norm_text(r.get(c, "")) for c in label if str(r.get(c, "")).strip()) or ("row %d" % i)
            cells = {c: str(r.get(c, "") if r.get(c) is not None else "") for c in cols}
            sel_key = json.dumps(sels[i], sort_keys=True)
            b = {c: bound[(rel, c, sel_key)] for c in numeric if (rel, c, sel_key) in bound}
            t["rows"].append({"i": i, "label": lab, "selector": sels[i], "cells": cells, "bound": b})
            if tokens:
                hay = (table_text + " " + lab + " " + " ".join(cols)).lower()
                for c in numeric:
                    raw = cells[c]
                    if not raw.strip():
                        continue
                    full = hay + " " + c.lower() + " " + raw.lower()
                    if all(tok in full for tok in tokens):
                        hits.append({"file": rel, "stem": stem, "caption": caption, "row": i, "label": lab,
                                     "selector": sels[i], "column": c, "raw": raw,
                                     "provenance": meta["provenance"], "sha256": meta["sha256"], "mtime": meta["mtime"]})
        tables.append(t)
    return {"ok": True, "tables": tables, "hits": hits[:limit_hits] if tokens else None, "q": q,
            "skipped": skipped, "entries": len(store.get("entries", [])),
            "candidateFiles": len(candidates), "walkedFiles": len(walked),
            "droppedFiles": len(candidates) - len(walked), "maxFiles": MAX_TABLE_FILES,
            "storePath": str(_store_path(project)) if _store_path(project).is_file() else None}


def _slug(s):
    return re.sub(r"[^a-z0-9]+", "-", str(s).lower()).strip("-")[:56] or "n"


def bind(project, entry):
    project = Path(project)
    e = dict(entry or {})
    for k in ("quote", "written", "file", "column"):
        if not str(e.get(k) if e.get(k) is not None else "").strip():
            return {"error": "binding needs %s" % k}
    rel = str(e["file"]).replace("\\", "/").lstrip("/")
    if ".." in rel.split("/") or rel.startswith("/") or ":" in rel:
        return {"error": "bad file path"}
    src = project / rel
    if not src.is_file():
        return {"error": "source file not found: %s" % rel}
    quote, written = str(e["quote"]), str(e["written"])
    if written not in quote:
        return {"error": "written %r must appear inside the quote" % written}
    try:
        rows = load_rows(src)
    except Exception as exc:
        return {"error": "cannot read %s: %s" % (rel, exc)}
    sel = e.get("row")
    if isinstance(sel, float) and sel.is_integer():
        sel = int(sel)
    if isinstance(sel, dict) and not sel:
        sel = None
    row, err = resolve_row(rows, sel, "new")
    if err:
        return {"error": err}
    col = str(e["column"])
    if col not in row:
        return {"error": "column %r not in %s" % (col, rel)}
    mode = e.get("mode") or "numeric"
    if mode not in ("numeric", "text", "threshold"):
        return {"error": "bad mode %r" % mode}
    try:
        scale = float(e.get("scale") or 1)
    except (TypeError, ValueError):
        return {"error": "bad scale"}
    probe = {"id": "new", "quote": quote, "written": written, "file": rel, "column": col,
             "row": sel, "scale": scale, "mode": mode}
    status, msg = _compare_cell(probe, row[col])
    if status != "TRACED":
        return {"error": "refused, the number would not trace: %s" % msg}

    data = _load_store(project)
    taken = {x.get("id") for x in data["entries"]}
    label = ""
    if isinstance(sel, dict):
        label = "-".join(str(v) for v in sel.values())
    base = _slug("%s-%s-%s" % (re.sub(r"\.csv$", "", rel.rsplit("/", 1)[-1], flags=re.I), col, label))
    eid, n = base, 1
    while eid in taken:
        n += 1
        eid = "%s-%d" % (base, n)
    meta = _source_meta(project, rel, _load_provenance(project))
    new = {"id": eid, "quote": quote, "written": written, "file": rel, "column": col}
    if sel is not None:
        new["row"] = sel
    new.update({"scale": scale if scale != int(scale) else int(scale), "mode": mode,
                "doc": str(e.get("doc") or "paper.md"), "note": str(e.get("note") or ""),
                "display": e.get("display") if isinstance(e.get("display"), str) else None,
                "key": bool(e.get("key")), "insertedAt": int(time.time() * 1000), "insertedBy": "board",
                "source": {"sha256": meta["sha256"], "mtime": meta["mtime"], "provenance": meta["provenance"]}})
    data["entries"].append(new)
    mt = _save_store(project, data)
    return {"ok": True, "id": eid, "entry": new, "storeMtime": mt}


def update_entry(project, eid, patch):
    project = Path(project)
    data = _load_store(project)
    idx = next((i for i, x in enumerate(data["entries"]) if x.get("id") == eid), None)
    if idx is None:
        return {"error": "no binding with id %r" % eid}
    e = data["entries"][idx]
    patch = patch or {}
    if patch.get("retire"):
        e["retired_on"] = time.strftime("%Y-%m-%d")
        e["retired_reason"] = str(patch.get("reason") or "retired from the board")
        data.setdefault("retired", []).append(e)
        del data["entries"][idx]
    else:
        if "key" in patch:
            e["key"] = bool(patch["key"])
        if "note" in patch:
            e["note"] = str(patch["note"] or "")
        if patch.get("resnapshot"):
            meta = _source_meta(project, e.get("file") or "", _load_provenance(project))
            e["source"] = {"sha256": meta["sha256"], "mtime": meta["mtime"], "provenance": meta["provenance"]}
    mt = _save_store(project, data)
    return {"ok": True, "id": eid, "storeMtime": mt, "retired": bool(patch.get("retire"))}


def cli(argv=None):
    """The CLI: prints per-entry lines + the advisory unbound list; exit 1 when an INSERTED number no longer
    stands up (--all restores the old strictness over legacy bindings too)."""
    import argparse
    ap = argparse.ArgumentParser(description="Validate manuscript numbers against their source CSVs.")
    ap.add_argument("project", help="project directory")
    ap.add_argument("--doc", default="paper.md", help="manuscript under writing/ (default paper.md; README.md and logs/<name> = project root)")
    ap.add_argument("--all-docs", action="store_true", help="also scan appendix.md and README.md when present")
    ap.add_argument("--all", action="store_true", help="legacy (non-inserted) failures also fail the check")
    ap.add_argument("--inserted", action="store_true", help="check only numbers inserted from the Results pane")
    ap.add_argument("--strict-unbound", action="store_true", help="unbound numbers also fail the check")
    ap.add_argument("--json", action="store_true", help="print the structured report instead of lines")
    ap.add_argument("--catalogue", nargs="?", const="", default=None, metavar="QUERY",
                    help="print the Insert-number catalogue (every citable cell + provenance) as JSON; optional search query")
    args = ap.parse_args(argv)

    if args.catalogue is not None:
        print(json.dumps(catalogue(args.project, args.catalogue), indent=2, ensure_ascii=False))
        return 0

    report = check_project(args.project, doc=args.doc, all_docs=args.all_docs,
                           inserted_only=args.inserted)
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        if not report["bound"]:
            print("NOTE: writing/versioning/numbers.json not found or empty — no bindings to check.")
            print("Every cited number should get a binding.")
        for name, d in report["docs"].items():
            for r in d["results"]:
                print("%-11s [%s] %s" % (r["status"], name, r["msg"]))
            live = [u for u in d["unbound"] if u.get("token")]
            if live:
                print("\nUNBOUND in %s (advisory — numbers with no binding entry): %d" % (name, len(live)))
                for u in d["unbound"]:
                    print("  line %s: %r in \"...%s...\"" % (u["line"], u["token"], u["context"]))
        counts = {}
        for d in report["docs"].values():
            for k, v in d["counts"].items():
                counts[k] = counts.get(k, 0) + v
        print("\nSummary: %s; unbound=%d" % (counts or "{no entries}", report["unboundTotal"]))
        print("Inserted: %d; blocking=%d advisory=%d (legacy + re-anchored)"
              % (report["inserted"], report["failing"], report["advisoryCount"]))
        for s in report["stale"]:
            print("  STALE %s:%s %r -> %r (%s)" % (s["doc"], s["line"], s["written"], s["current"], s["file"]))
        for s in report["scriptStale"]:
            print("  SCRIPT-EDITED %s produced %s — re-run it" % (s["script"], s["file"]))
    if report["blocking"] or (args.all and report["advisory"]) or (args.strict_unbound and report["unboundTotal"]):
        return 1
    return 0


if __name__ == "__main__":
    import sys
    sys.exit(cli())
