import json
import re
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

import citationindex
import tagindex
import notes_organizer as no

HERE = no.HERE
VAULT = no.VAULT
NOTES = no.NOTES
AUTHORS_DIR = NOTES / "Authors"
MEETINGS_NOTES_DIR = NOTES / "Meetings"           # hand-filed meeting notes (editable)
CAL_MEETINGS_DIR = no.MEETINGS_DIR                # calendar event files (read-only here)


# ------------------------------------------------------------------ author identity
_ET_AL = re.compile(r"\bet\s+al\b\.?", re.I)


def _split_authors(author):
    if not author:
        return []
    s = _ET_AL.sub(" ", str(author))
    out = []
    for p in re.split(r",|\band\b|&", s):
        p = p.strip().strip(".").strip()
        if p and re.search(r"[A-Za-z]", p):
            out.append(p)
    return out


def _akey(surname):
    return (surname or "").strip().lower()


def _profile_key_candidates(title, stem):
    keys = set()
    for t in (title, stem):
        t = (t or "").strip()
        if not t:
            continue
        keys.add(t.lower())
        toks = t.split()
        if toks:
            keys.add(toks[-1].lower())
    return {k for k in keys if k}


# ------------------------------------------------------------------ cached rollups
_CACHE_SECS = 120
_cache = {}


def _cached(key, builder):
    now = time.time()
    ent = _cache.get(key)
    if ent and now - ent[0] < _CACHE_SECS:
        return ent[1]
    data = builder()
    _cache[key] = (now, data)
    return data


def invalidate_notes():
    _cache.pop("profiles", None)


def _citation_recs():
    return [r for r in citationindex.records(HERE) if r.get("kind") == "citation"]


def _profiles():
    """Real author-profile notes (the bios). Returns {key: profile} with every
    key candidate pointing at the same profile dict."""
    def build():
        out = {}
        if not AUTHORS_DIR.is_dir():
            return out
        for p in sorted(AUTHORS_DIR.glob("*.md")):
            if not p.is_file():
                continue
            try:
                meta, body = no._split_frontmatter(p.read_text(encoding="utf-8"))
            except OSError:
                continue
            title = meta.get("title") or p.stem
            prof = {
                "path": p.relative_to(VAULT).as_posix(), "title": title,
                "mtime": int(p.stat().st_mtime), "tags": meta.get("tags") or [],
                "hasBody": bool(body.strip()),
            }
            for k in _profile_key_candidates(title, p.stem):
                out.setdefault(k, prof)
        return out
    return _cached("profiles", build)


def _rollup():
    """{author_key: {key, name, works:[rec], lead, read, tags:Counter, years:[int]}}
    over every citation, crediting every author position."""
    def build():
        agg = {}
        for r in _citation_recs():
            names = _split_authors(r.get("author", ""))
            for i, nm in enumerate(names):
                k = _akey(nm)
                if not k:
                    continue
                a = agg.get(k)
                if a is None:
                    a = agg[k] = {"key": k, "name": nm, "works": [], "lead": 0,
                                  "read": 0, "tags": Counter(), "years": []}
                if len(nm) > len(a["name"]):
                    a["name"] = nm
                a["works"].append(r)
                if i == 0:
                    a["lead"] += 1
                if (r.get("status") or "") == "read":
                    a["read"] += 1
                for t in r.get("tags") or []:
                    a["tags"][t] += 1
                yr = r.get("year")
                if yr:
                    try:
                        a["years"].append(int(yr))
                    except (TypeError, ValueError):
                        pass
        return agg
    return _cached("rollup", build)


# ------------------------------------------------------------------ authors
def authors(q="", sort="works"):
    rollup = _rollup()
    profiles = _profiles()
    ql = (q or "").strip().lower()
    rows = []
    for k, a in rollup.items():
        prof = profiles.get(k)
        if ql:
            if ql not in a["name"].lower():
                continue
        elif len(a["works"]) < 2 and not prof:
            continue
        rows.append({
            "key": k, "name": a["name"], "works": len(a["works"]), "lead": a["lead"],
            "read": a["read"],
            "yearMin": min(a["years"]) if a["years"] else None,
            "yearMax": max(a["years"]) if a["years"] else None,
            "topTags": [t for t, _ in a["tags"].most_common(4)],
            "hasProfile": bool(prof), "profilePath": prof["path"] if prof else "",
            "recent": max((r.get("mtime") or 0) for r in a["works"]),
        })
    seen = {r["key"] for r in rows}
    for k, prof in profiles.items():
        # profile-only authors (a bio written before any citation landed)
        if k in seen or prof["path"] in {r["profilePath"] for r in rows}:
            continue
        if ql and ql not in prof["title"].lower():
            continue
        seen.add(k)
        rows.append({"key": k, "name": prof["title"], "works": 0, "lead": 0, "read": 0,
                     "yearMin": None, "yearMax": None, "topTags": prof["tags"][:4],
                     "hasProfile": True, "profilePath": prof["path"], "recent": prof["mtime"]})
    if sort == "name":
        rows.sort(key=lambda r: r["name"].lower())
    elif sort == "recent":
        rows.sort(key=lambda r: -r["recent"])
    else:
        rows.sort(key=lambda r: (-r["works"], r["name"].lower()))
    return {"count": len(rows), "authors": rows}


def _work_row(r, key=""):
    names = [_akey(n) for n in _split_authors(r.get("author", ""))]
    return {
        "rel": r.get("rel", ""), "title": r.get("title") or r.get("stem", ""),
        "author": r.get("author", ""), "year": r.get("year"),
        "status": r.get("status", ""), "rating": r.get("rating", 0) or 0,
        "sourceType": r.get("sourceType", ""), "source": r.get("source", ""),
        "tags": (r.get("tags") or [])[:6],
        "quotes": len(r.get("quotes") or []), "keyPoints": len(r.get("keyPoints") or []),
        "mtime": r.get("mtime") or 0,
        "lead": bool(names) and names[0] == key,
    }


def author_detail(key):
    """One author's full thread: bio profile (if written), works by year, the
    projects that use them, the concepts their work touches, the meetings that
    mention them."""
    key = _akey(key)
    rollup = _rollup()
    profiles = _profiles()
    a = rollup.get(key)
    prof = profiles.get(key)
    if not a and not prof:
        return {"ok": False, "error": "unknown author"}

    works = [_work_row(r, key) for r in (a["works"] if a else [])]
    works.sort(key=lambda w: (-(w["year"] or 0), w["title"].lower()))
    name = prof["title"] if prof else (a["name"] if a else key)
    surname = (a["name"] if a else name.split()[-1] if name.split() else name)

    work_stems = {no._norm_key(Path(w["rel"]).stem) for w in works if w["rel"]}
    projects = defaultdict(list)
    for f in tagindex.files(HERE, "Projects/papers/"):
        m = no._PROJECT_NOTE_RE.match(f["path"])
        if not m or m.group(2) != "corpus":
            continue
        if no._norm_key(Path(f["path"]).stem) in work_stems:
            projects[no._project_display(m.group(1))].append(
                {"path": f["path"], "title": f["title"] or Path(f["path"]).stem})
    project_rows = [{"project": k, "notes": v} for k, v in
                    sorted(projects.items(), key=lambda kv: -len(kv[1]))]

    # concepts this author's work touches, by the same tag/alias match the atlas
    # uses for its citation->concept edges
    concept_by_key = {}
    for n in no.list_all():
        if (n.get("type") or "") != "concept":
            continue
        for alias in [n["title"]] + list(n.get("aliases") or []):
            ck = no._norm_key(alias)
            if ck:
                concept_by_key.setdefault(ck, {"title": n["title"], "path": n["path"], "n": 0})
    matched = {}
    for w in works:
        for t in w["tags"]:
            c = concept_by_key.get(no._norm_key(t))
            if c is not None:
                matched.setdefault(c["path"], c)
                c["n"] += 1
    concepts = sorted(matched.values(), key=lambda c: -c["n"])

    # meetings that mention the author — capitalized-surname word match, so
    # a surname like 'Fine' doesn't false-positive on ordinary prose
    pat = re.compile(r"\b" + re.escape(surname) + r"\b")
    meetings = []
    for m in _all_meetings():
        try:
            text = (VAULT / m["path"]).read_text(encoding="utf-8")
        except OSError:
            continue
        if pat.search(text):
            meetings.append({k: m[k] for k in ("path", "title", "date", "with", "readonly")})

    years = sorted({w["year"] for w in works if w["year"]})
    return {
        "ok": True, "key": key, "name": name,
        "profile": ({"path": prof["path"], "hasBody": prof["hasBody"]} if prof else None),
        "stats": {"works": len(works), "lead": (a["lead"] if a else 0),
                  "read": (a["read"] if a else 0),
                  "yearMin": years[0] if years else None,
                  "yearMax": years[-1] if years else None},
        "topTags": [t for t, _ in (a["tags"].most_common(8) if a else [])],
        "works": works, "projects": project_rows, "concepts": concepts,
        "meetings": meetings,
    }


def create_author_profile(name):
    name = re.sub(r"\s+", " ", (name or "").strip())
    if not name or not re.search(r"[A-Za-z]", name):
        return {"ok": False, "error": "a name is required"}
    dest = AUTHORS_DIR / f"{no._slug(name)}.md"
    if dest.resolve().parent != AUTHORS_DIR.resolve():
        return {"ok": False, "error": "a name is required"}
    rel = dest.relative_to(VAULT).as_posix()
    if dest.exists():
        return {"ok": True, "path": rel, "existed": True}
    fm = no._build_frontmatter({"title": name, "created": no._now_stamp(),
                                "type": "author", "source": "dashboard", "tags": ["author"]})
    body = "\n\n".join([
        f"# {name}", "## Background", "", "## Core Contribution", "",
        "## Key Concepts", "", "## Where They Break Down", "",
        "## Works Read", "", "## Key Passages", "",
    ])
    no._atomic_write(dest, fm + "\n\n" + body + "\n")
    _cache.pop("profiles", None)
    return {"ok": True, "path": rel, "existed": False}


# ------------------------------------------------------------------ citations
_FACET_TAGS = 30


def _facets():
    def build():
        recs = _citation_recs()
        tags, stypes, statuses = Counter(), Counter(), Counter()
        years = []
        for r in recs:
            for t in r.get("tags") or []:
                tags[t] += 1
            st = r.get("sourceType") or ""
            if st:
                stypes[st] += 1
            statuses[r.get("status") or "unknown"] += 1
            if r.get("year"):
                try:
                    years.append(int(r["year"]))
                except (TypeError, ValueError):
                    pass
        return {
            "total": len(recs),
            "topTags": [{"tag": t, "n": n} for t, n in tags.most_common(_FACET_TAGS)],
            "sourceTypes": [{"type": t, "n": n} for t, n in stypes.most_common()],
            "statuses": dict(statuses),
            "yearMin": min(years) if years else None,
            "yearMax": max(years) if years else None,
        }
    return _cached("facets", build)


def citations_list(q="", tag="", status="", stype="", author="", year_from=0,
                   year_to=0, sort="-year", offset=0, limit=100):
    """The corpus, by citation: filter + sort + page over the cached records."""
    recs = _citation_recs()
    ql = (q or "").strip().lower()
    tokens = [t for t in re.split(r"\s+", ql) if t] if ql else []
    akey = _akey(author)
    out = []
    for r in recs:
        if tokens and not all(t in (r.get("hay") or "") for t in tokens):
            continue
        if tag and tag not in (r.get("tags") or []):
            continue
        if status and (r.get("status") or "") != status:
            continue
        if stype and (r.get("sourceType") or "") != stype:
            continue
        if akey and akey not in [_akey(n) for n in _split_authors(r.get("author", ""))]:
            continue
        yr = r.get("year") or 0
        try:
            yr = int(yr)
        except (TypeError, ValueError):
            yr = 0
        if year_from and (not yr or yr < year_from):
            continue
        if year_to and (not yr or yr > year_to):
            continue
        out.append(r)

    keyers = {
        "-year": lambda r: (-(r.get("year") or 0), (r.get("author") or "").lower()),
        "year": lambda r: ((r.get("year") or 9999), (r.get("author") or "").lower()),
        "title": lambda r: (r.get("title") or "").lower(),
        "author": lambda r: ((r.get("author") or "").lower(), -(r.get("year") or 0)),
        "recent": lambda r: -(r.get("mtime") or 0),
        "rating": lambda r: (-(r.get("rating") or 0), -(r.get("year") or 0)),
    }
    out.sort(key=keyers.get(sort, keyers["-year"]))

    total = len(out)
    offset = max(0, int(offset or 0))
    limit = max(1, min(400, int(limit or 100)))
    page = [_work_row(r) for r in out[offset:offset + limit]]
    return {"total": total, "offset": offset, "limit": limit,
            "items": page, "facets": _facets()}


# ------------------------------------------------------------------ meetings
_DATE_RE = re.compile(r"(\d{4}-\d{2}-\d{2})")


def _all_meetings():
    """Both meeting sources, one list: calendar event files (read-only) and
    hand-filed Notes/Meetings notes (editable). Sorted by date desc, undated last."""
    out = []
    for d, readonly in ((CAL_MEETINGS_DIR, True), (MEETINGS_NOTES_DIR, False)):
        if not d.is_dir():
            continue
        for p in sorted(d.glob("*.md")):
            if not p.is_file():
                continue
            try:
                meta, body = no._split_frontmatter(p.read_text(encoding="utf-8"))
            except OSError:
                continue
            date = (meta.get("date") or "").strip()
            if not date:
                m = _DATE_RE.search(p.stem) or _DATE_RE.search(meta.get("created") or "")
                date = m.group(1) if m else ""
            attendees = meta.get("with") or []
            if isinstance(attendees, str):
                attendees = [a.strip() for a in attendees.strip().strip("[]").split(",") if a.strip()]
            tags = meta.get("tags") or []
            if isinstance(tags, str):
                tags = [t.strip() for t in tags.strip().strip("[]").split(",") if t.strip()]
            preview = ""
            for line in body.splitlines():
                s = re.sub(r"^#+\s*", "", line).strip()
                if s and not s.startswith("---"):
                    preview = s[:180]
                    break
            out.append({
                "path": p.relative_to(VAULT).as_posix(),
                "title": meta.get("title") or p.stem,
                "date": date, "startTime": meta.get("startTime") or meta.get("starttime") or "",
                "with": attendees, "tags": tags,
                "preview": preview, "mtime": int(p.stat().st_mtime), "readonly": readonly,
                "event": (meta.get("event") or "").strip(),
            })

    by_event = {m["event"]: m for m in out if m["event"] and not m["readonly"]}
    paired = []
    for m in out:
        if m["readonly"]:
            note = by_event.get(m["path"])
            if note is not None:
                m = dict(m, notePath=note["path"], noteTitle=note["title"],
                         preview=note["preview"] or m["preview"],
                         **({"with": note["with"]} if note["with"] and not m["with"] else {}))
            else:
                m = dict(m, notePath="", noteTitle="")
        elif m["event"] in {x["path"] for x in out if x["readonly"]}:
            continue                                  # folded into its event row above
        else:
            m = dict(m, notePath=m["path"], noteTitle=m["title"])
        paired.append(m)

    paired.sort(key=lambda m: (m["date"] or "0000-00-00", m["mtime"]), reverse=True)
    return paired


def meetings_list():
    items = _all_meetings()
    return {"count": len(items), "items": items}


# ------------------------------------------------------------------ projects
def _paper_notes_by_display():
    """{display name: [note rows]} for papers (their dated logs), globbed live so a
    note filed a moment ago counts at once (tagindex rebuilds on a 30-min timer)."""
    out = defaultdict(list)
    for kind, d in no._project_dirs():
        if kind != "papers":
            continue
        for p in no._project_note_files(d):
            row = no._note_row(p)
            if row:
                out[no._project_display(d.name)].append(row)
    return out


def projects_list():
    """Per-project note counts (notes, logs, corpus), newest activity first."""
    agg = {}
    for f in tagindex.files(HERE, "Projects/papers/"):
        m = no._PROJECT_NOTE_RE.match(f["path"])
        if not m or (m.group(3) == "logs" and no._DATED_LOG_RE.match(Path(f["path"]).name)):
            continue
        display = no._project_display(m.group(2))
        a = agg.setdefault(display, {"project": display, "notes": 0, "logs": 0, "corpus": 0, "mtime": 0})
        a[m.group(3)] += 1
        a["mtime"] = max(a["mtime"], int(f.get("mtime") or 0))
    for display, rows in _paper_notes_by_display().items():
        a = agg.setdefault(display, {"project": display, "notes": 0, "logs": 0, "corpus": 0, "mtime": 0})
        a["notes"] += len(rows)
        a["mtime"] = max([a["mtime"]] + [r["mtime"] for r in rows])
    rows = sorted(agg.values(), key=lambda a: -a["mtime"])
    return {"count": len(rows), "projects": rows}


def project_notes(name):
    """One project's notes (its dated logs, first, kind "note"), then its other logs/
    files + corpus/ notes."""
    logs, corpus = [], []
    for f in tagindex.files(HERE, "Projects/papers/"):
        m = no._PROJECT_NOTE_RE.match(f["path"])
        if not m or no._project_display(m.group(2)) != name:
            continue
        if m.group(3) == "logs" and no._DATED_LOG_RE.match(Path(f["path"]).name):
            continue
        row = {"path": f["path"], "title": f["title"] or Path(f["path"]).stem,
               "tags": (f.get("tags") or [])[:6], "mtime": int(f.get("mtime") or 0),
               "kind": "log" if m.group(3) == "logs" else "corpus"}
        (logs if m.group(3) == "logs" else corpus).append(row)
    notes = [{"path": r["path"], "title": r["title"], "tags": r["tags"][:6],
              "mtime": r["mtime"], "created": r["created"], "kind": "note"}
             for r in _paper_notes_by_display().get(name, [])]
    notes.sort(key=lambda r: -r["mtime"])
    logs.sort(key=lambda r: -r["mtime"])
    corpus.sort(key=lambda r: r["title"].lower())
    return {"project": name, "notes": notes, "logs": logs, "corpus": corpus}


def author_notes():
    """Every note under Preparation/Notes/Authors/, subfolders included, by title."""
    notes = []
    if AUTHORS_DIR.is_dir():
        for p in AUTHORS_DIR.rglob("*.md"):
            if not p.is_file() or any(x.startswith(".") for x in p.relative_to(AUTHORS_DIR).parts):
                continue
            row = no._note_row(p)
            if row:
                row.pop("tags", None)
                notes.append(row)
    notes.sort(key=lambda r: r["title"].lower())
    return {"notes": notes}


# ------------------------------------------------------------------ overview
def overview():
    recs = _citation_recs()
    filed = no.list_all()
    by_type = Counter((n.get("type") or "") for n in filed)
    meetings = _all_meetings()
    projects = projects_list()
    rollup = _rollup()
    profiles = _profiles()
    author_n = sum(1 for a in rollup.values() if len(a["works"]) >= 2)
    profile_paths = {p["path"] for p in profiles.values()}

    recent = []
    for n in filed[:12]:
        recent.append({"title": n["title"], "path": n["path"], "type": n["type"],
                       "mtime": n["mtime"]})
    for m in meetings[:4]:
        recent.append({"title": m["title"], "path": m["path"], "type": "meeting",
                       "mtime": m["mtime"]})
    for r in sorted(recs, key=lambda r: -(r.get("mtime") or 0))[:6]:
        recent.append({"title": r.get("title") or r.get("stem", ""), "path": r.get("rel", ""),
                       "type": "citation", "mtime": r.get("mtime") or 0})
    recent.sort(key=lambda r: -r["mtime"])

    return {
        "counts": {
            "citations": len(recs),
            "citationsRead": sum(1 for r in recs if (r.get("status") or "") == "read"),
            "authors": author_n, "profiles": len(profile_paths),
            "concepts": by_type.get("concept", 0), "ideas": by_type.get("idea", 0),
            "reflections": by_type.get("reflection", 0),
            "meetings": len(meetings),
            "inbox": len(no.list_inbox()),
            "projects": projects["count"],
            "projectNotes": sum(p["notes"] + p["logs"] + p["corpus"] for p in projects["projects"]),
        },
        "recent": recent[:12],
    }


# ------------------------------------------------------------------ CLI (testing)
def main(argv):
    if not argv:
        print("usage: all_in_one_academic.py {overview|authors [q]|author <key>|citations [q]|meetings|projects [name]}", file=sys.stderr)
        return 2
    cmd, rest = argv[0], argv[1:]
    if cmd == "overview":
        out = overview()
    elif cmd == "authors":
        out = authors(rest[0] if rest else "")
    elif cmd == "author":
        out = author_detail(rest[0] if rest else "")
    elif cmd == "citations":
        out = citations_list(q=rest[0] if rest else "", limit=5)
    elif cmd == "meetings":
        out = meetings_list()
    elif cmd == "projects":
        out = project_notes(rest[0]) if rest else projects_list()
    else:
        print(f"unknown command: {cmd}", file=sys.stderr)
        return 2
    print(json.dumps(out, ensure_ascii=False, indent=2)[:6000])
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
