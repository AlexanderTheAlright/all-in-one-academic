#!/usr/bin/env python3
"""Walk the vault once and emit dashboard-data.json for the dashboard."""
import settings
import json, os, re, sys, time
from pathlib import Path
from datetime import datetime, timezone
from collections import Counter

HERE = settings.STATE_DIR
VAULT = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else settings.VAULT
OUT = HERE / "dashboard-data.json"
CACHE_INDEX = HERE / ".citation-cache.json"   # per-file mtime memo for incremental builds


def _obsidian_config():
    cfg = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config") / "obsidian" / "obsidian.json"
    try:
        vaults = json.loads(cfg.read_text(encoding="utf-8")).get("vaults", {})
    except Exception:
        return {}
    return vaults if isinstance(vaults, dict) else {}


def _vault_id():
    """The Obsidian id for VAULT, resolved at build time and written into
    dashboard-data.json, so an open-note link hits the right vault."""
    want = str(VAULT.resolve())
    for vid, meta in _obsidian_config().items():
        try:
            if str(Path(meta.get("path", "")).expanduser().resolve()) == want:
                return vid
        except Exception:
            continue
    return VAULT.name


VAULT_ID = _vault_id()

CITATIONS = VAULT / "Preparation" / "Reading" / "Citations"
HIST_CITATIONS = VAULT / settings.PRIMARY_SOURCES_REL / "Citations"
HIST_CORPUS = VAULT / settings.PRIMARY_SOURCES_REL / "Corpus"
CORPUS = VAULT / "Preparation" / "Reading" / "Corpus"
PAPERS = VAULT / "Projects" / "papers"
PLANNING = VAULT / "Planning.md"

STRUCTURAL_TAGS = {"citation", "web-source", "corpus", "project-note", "finder", "dashboard"}
SOURCE_TYPE_MAP = {  # keys are already space->hyphen normalized
    "journal-article": "article", "journal": "article",
    "book-chapter": "incollection", "chapter": "incollection", "book-section": "incollection", "booksection": "incollection",
    "edited-collection": "edited-volume",
    "conference-paper": "report", "government-report": "report",
    "review-article": "review", "review-essay": "review", "book-review": "review",
    "dissertation": "thesis",
    "": "unspecified", "[]": "unspecified",
}
TYPE_TOP_N = 8  # doughnut shows the top N source types; the rest fold into "other"
TAG_TOP_N = 40  # tagStats carries the top N tags with read/unread split (topTags stays 14)


def normalize_tags(raw):
    """Coerce a tags field into a clean list. Handles YAML block lists (already a
    list), inline lists 'tags: [a, b]', and comma-strings 'tags: a, b' — the last
    two arrive here as a single string and must not be iterated char-by-char."""
    if isinstance(raw, list):
        vals = raw
    elif isinstance(raw, str):
        vals = raw.strip().lstrip("[").rstrip("]").split(",")
    else:
        return []
    out = []
    for v in vals:
        v = str(v).strip().strip("\"'").strip()
        if v and v not in STRUCTURAL_TAGS:
            out.append(v)
    return out


TASK_RE = re.compile(r"^\s*-\s*\[( |x|X)\]\s*(.*?)\s*$")
HEADING_RE = re.compile(r"^#{1,6}\s+(.*?)\s*$")
DUE_RE = re.compile(r"@due[\(\{]([^)\}]+)[\)\}]")
PRIO_RE = re.compile(r"@(high|medium|low)\b", re.I)
TAG_RE = re.compile(r"#([A-Za-z0-9\-_/]+)")
META_RE = re.compile(r"(#[A-Za-z0-9\-_/]+|@\w+(?:[\(\{][^)\}]*[\)\}])?)")  # strip from display text


def read_frontmatter(path):
    """Return the YAML frontmatter as a dict. Reads only the top block, stops at
    the closing '---' so we never load the (possibly huge) annotated body."""
    fm, in_block, started, list_key = {}, False, False, None
    try:
        with path.open("r", encoding="utf-8") as f:
            for i, line in enumerate(f):
                if i == 0 and line.strip() != "---":
                    return fm  # no frontmatter
                if line.strip() == "---":
                    if not started:
                        started = in_block = True
                        continue
                    break  # closing fence — done
                if not in_block:
                    continue
                m = re.match(r"^(\s+)-\s+(.*)$", line)
                if m and list_key is not None:
                    fm[list_key].append(_unquote(m.group(2).strip()))
                    continue
                if ":" in line:
                    key, _, val = line.partition(":")
                    key, val = key.strip(), val.strip()
                    if val == "":
                        list_key = key
                        fm[key] = []
                    else:
                        list_key = None
                        fm[key] = _unquote(val)
    except (OSError, UnicodeDecodeError):
        pass
    return fm


def _unquote(s):
    s = s.strip()
    if len(s) >= 2 and s[0] in "\"'" and s[-1] == s[0]:
        return s[1:-1]
    return s


def _derive(fm):
    """Reduce raw frontmatter to the fields the dashboard aggregates. None if the
    file has no frontmatter (counted as an error upstream)."""
    if not fm:
        return None
    status = str(fm.get("status", "")).strip().lower()
    status = "read" if status == "read" else ("reading" if status == "reading" else "unread")
    if status == "reading" and fm.get("claimed_by"):
        status = "unread"
    stype = str(fm.get("source-type", "")).strip().lower().replace(" ", "-")
    stype = SOURCE_TYPE_MAP.get(stype, stype) or "unspecified"
    try:
        year = int(str(fm.get("year", "")).strip()[:4])
    except (ValueError, TypeError):
        year = None
    try:
        rating = float(fm.get("rating") or 0)
    except (ValueError, TypeError):
        rating = 0.0
    return {"status": status, "stype": stype, "year": year, "rating": rating,
            "author": fm.get("author", ""), "tags": normalize_tags(fm.get("tags"))}


def parse_citations():
    """Incremental: re-reads only citation files whose mtime changed since the last
    build. PDF-existence is still
    computed live against the Corpus, since that changes independently of citations."""
    items, errors, reused = [], 0, 0
    by_type, by_decade, tags = Counter(), Counter(), Counter()
    tags_read = Counter()
    read = rated = with_pdf = 0
    rating_sum = 0.0
    if not CITATIONS.is_dir():
        return None
    corpus_stems = {p.stem for p in CORPUS.glob("*.pdf")} if CORPUS.is_dir() else set()
    try:
        index = json.loads(CACHE_INDEX.read_text(encoding="utf-8"))
    except Exception:
        index = {}
    new_index = {}
    with os.scandir(CITATIONS) as it:
        for entry in it:
            if not entry.name.endswith(".md") or not entry.is_file():
                continue
            try:
                mtime = entry.stat().st_mtime
            except OSError:
                mtime = 0
            cached = index.get(entry.name)
            if cached and cached.get("mtime") == mtime:
                rec = cached.get("rec")
                reused += 1
            else:
                rec = _derive(read_frontmatter(Path(entry.path)))
            new_index[entry.name] = {"mtime": mtime, "rec": rec}
            if not rec:
                errors += 1
                continue
            stem = entry.name[:-3]
            if rec["status"] == "read":
                read += 1
            by_type[rec["stype"]] += 1
            if rec["year"]:
                by_decade[(rec["year"] // 10) * 10] += 1
            if rec["rating"] and rec["rating"] > 0:
                rated += 1
                rating_sum += rec["rating"]
            if stem in corpus_stems:
                with_pdf += 1
            for t in rec["tags"]:
                tags[t] += 1
                if rec["status"] == "read":
                    tags_read[t] += 1
            items.append({
                "name": stem, "author": rec["author"], "year": rec["year"],
                "type": rec["stype"], "status": rec["status"],
                "rating": int(rec["rating"]) if rec["rating"] and rec["rating"] > 0 else None,
                "tags": rec["tags"][:6], "collection": "literature",
            })

    if HIST_CITATIONS.is_dir():
        hist_stems = set()
        if HIST_CORPUS.is_dir():
            for q in HIST_CORPUS.iterdir():
                if q.is_file() and q.suffix.lower() in (".pdf", ".txt"):
                    hist_stems.add(q.stem)
        with os.scandir(HIST_CITATIONS) as it:
            for entry in it:
                if not entry.name.endswith(".md") or not entry.is_file():
                    continue
                if entry.name.startswith("_"):
                    continue
                try:
                    mtime = entry.stat().st_mtime
                except OSError:
                    mtime = 0
                key = "hist|" + entry.name          # namespaced: stems may collide with literature
                cached = index.get(key)
                if cached and cached.get("mtime") == mtime:
                    rec = cached.get("rec")
                    reused += 1
                else:
                    rec = _derive(read_frontmatter(Path(entry.path)))
                new_index[key] = {"mtime": mtime, "rec": rec}
                if not rec:
                    errors += 1
                    continue
                stem = entry.name[:-3]
                if rec["status"] == "read":
                    read += 1
                by_type[rec["stype"]] += 1
                if rec["year"]:
                    by_decade[(rec["year"] // 10) * 10] += 1
                if rec["rating"] and rec["rating"] > 0:
                    rated += 1
                    rating_sum += rec["rating"]
                if stem in hist_stems:
                    with_pdf += 1
                for tg in rec["tags"]:
                    tags[tg] += 1
                    if rec["status"] == "read":
                        tags_read[tg] += 1
                items.append({
                    "name": stem, "author": rec["author"], "year": rec["year"],
                    "type": rec["stype"], "status": rec["status"],
                    "rating": int(rec["rating"]) if rec["rating"] and rec["rating"] > 0 else None,
                    "tags": rec["tags"][:6], "collection": "historical",
                })
    try:
        CACHE_INDEX.write_text(json.dumps(new_index, ensure_ascii=False), encoding="utf-8")
    except OSError:
        pass
    total = len(items)
    # bucket the long pre-1900 tail (classics) into one point so the timeline reads
    pre = sum(n for d, n in by_decade.items() if d < 1900)
    decades = ([["<1900", pre]] if pre else []) + \
        [[f"{d}s", n] for d, n in sorted(by_decade.items()) if d >= 1900]
    # top N source types, rest folded into "other" so the doughnut stays readable
    type_items = sorted(by_type.items(), key=lambda kv: -kv[1])
    if len(type_items) > TYPE_TOP_N:
        tail = sum(n for _, n in type_items[TYPE_TOP_N:])
        type_items = type_items[:TYPE_TOP_N] + [("other", tail)]
    return {
        "items": items,
        "errors": errors,
        "kpi_partial": {
            "total": total, "read": read, "withPdf": with_pdf, "rated": rated,
            "avgRating": round(rating_sum / rated, 1) if rated else 0,
        },
        "types": type_items,
        "decades": decades,
        "topTags": [[t, n] for t, n in tags.most_common(14)],
        # top-40 tags with the read/unread split, biggest first. `topTags` above is
        # kept at 14 unchanged so existing consumers do not shift under them.
        "tagStats": [{"tag": t, "total": n, "read": tags_read.get(t, 0),
                      "unread": n - tags_read.get(t, 0)}
                     for t, n in tags.most_common(TAG_TOP_N)],
        "tagTotal": len(tags),
        "reused": reused,
    }


def parse_board(path):
    done = open_ = 0
    section = ""
    try:
        with path.open("r", encoding="utf-8") as f:
            for line in f:
                h = HEADING_RE.match(line)
                if h:
                    section = h.group(1).strip().lower()
                    continue
                if section == "archive":
                    continue
                t = TASK_RE.match(line)
                if t:
                    if t.group(1).lower() == "x":
                        done += 1
                    else:
                        open_ += 1
    except (OSError, UnicodeDecodeError):
        pass
    return done, open_


def parse_projects():
    projects = []
    if not PAPERS.is_dir():
        return projects
    for d in sorted(PAPERS.iterdir()):
        if not d.is_dir() or not settings.live_slug(d.name):
            continue
        board = d / "PATH.md"
        if not board.exists():
            continue
        done, open_ = parse_board(board)
        if done == 0 and open_ == 0:
            continue
        projects.append({"name": settings.live_slug(d.name), "done": done, "open": open_})
    return projects


def parse_planning():
    out = []
    if not PLANNING.exists():
        return out
    section = ""
    try:
        with PLANNING.open("r", encoding="utf-8") as f:
            for line in f:
                h = HEADING_RE.match(line)
                if h:
                    section = h.group(1).strip().lower()
                    continue
                if section in ("archive", "done", "complete", "completed"):
                    continue
                t = TASK_RE.match(line)
                if not t or t.group(1).lower() == "x":
                    continue
                raw = t.group(2)
                prio = (PRIO_RE.search(raw).group(1).lower() if PRIO_RE.search(raw) else None)
                due = (DUE_RE.search(raw).group(1).strip() if DUE_RE.search(raw) else None)
                if not prio and not due:
                    continue
                tagm = TAG_RE.search(raw)
                tag = tagm.group(1) if tagm else None
                text = META_RE.sub("", raw).strip().rstrip("-").strip()
                out.append({"text": text, "tag": tag, "priority": prio or "medium", "due": due})
    except (OSError, UnicodeDecodeError):
        pass
    order = {"high": 0, "medium": 1, "low": 2}
    out.sort(key=lambda x: (order.get(x["priority"], 3), x["due"] or "9999"))
    return out[:8]


def main():
    t0 = time.time()
    print(f"vault: {VAULT}")
    cit = parse_citations()
    if cit is None:
        print(f"ERROR: citations folder not found at {CITATIONS}", file=sys.stderr)
        sys.exit(1)
    projects = parse_projects()
    planning = parse_planning()

    kpi = dict(cit["kpi_partial"])
    kpi["projects"] = len(projects)
    kpi["tasks"] = sum(p["done"] + p["open"] for p in projects)

    data = {
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "vaultId": VAULT_ID,
        "planning": planning,
        "kpi": kpi,
        "types": cit["types"],
        "decades": cit["decades"],
        "topTags": cit["topTags"],
        "tagStats": cit["tagStats"],
        "tagTotal": cit["tagTotal"],
        "items": cit["items"],
        "projects": projects,
    }
    OUT.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    dt = time.time() - t0
    print(f"wrote {OUT.name}: {kpi['total']} citations ({kpi['read']} read), "
          f"{len(projects)} projects, {len(planning)} planning items, "
          f"{cit['errors']} unparsed, {cit['reused']} cached  [{dt:.1f}s]")

    try:
        import tagindex
        t1 = time.time()
        n = tagindex.build(VAULT, HERE)
        st = tagindex.status(HERE)
        print(f"wrote {tagindex.INDEX_NAME}: {st['tagCount']} tags over {st['files']} "
              f"files ({n} reindexed)  [{time.time() - t1:.1f}s]")
    except Exception as e:  # noqa: BLE001 — never fail the cache build over the tag index
        print(f"WARN: tag index build failed: {e}", file=sys.stderr)

    try:
        import citationindex
        t2 = time.time()
        n = citationindex.build(VAULT, HERE)
        st = citationindex.status(HERE)
        print(f"wrote {citationindex.INDEX_NAME}: {st['count']} citations "
              f"({n} reindexed)  [{time.time() - t2:.1f}s]")
    except Exception as e:  # noqa: BLE001 — never fail the cache build over the citation index
        print(f"WARN: citation index build failed: {e}", file=sys.stderr)


if __name__ == "__main__":
    main()
