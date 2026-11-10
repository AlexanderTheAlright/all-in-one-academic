import settings
import os as _os
_os.environ["openin_any"] = "p"
import os, re, sys, time, json, subprocess, threading, tempfile, hashlib, functools, shutil
from pathlib import Path
from datetime import datetime
from urllib.parse import quote
import fignotes

VAULT_SCRIPTS_OFF = "running vault scripts is disabled (run_vault_scripts)"
_TOOLKIT_REL = str(settings.get("toolkit_dir", "Projects/toolkit"))   # vault-relative: scripts/, report-templates/, journals/

PREFIX = settings.PROJECT_PREFIX       # the live-project folder prefix (setting project_prefix)

DEFAULT_DOC = "paper.md"
DOC_KINDS = {
    "paper.md":        {"kind": "paper",        "label": "Paper",        "publish": "working"},
    "oped.md":         {"kind": "oped",         "label": "Op-ed",        "publish": "oped"},
    "dissertation.md": {"kind": "dissertation", "label": "Dissertation", "publish": "thesis"},
    "proposal.md":     {"kind": "proposal",     "label": "Proposal",     "publish": "proposal"},
    "report.md":       {"kind": "report",       "label": "Report",       "publish": "long-report",
                        "base": "briefs"},
    "letter.md":       {"kind": "letter",       "label": "Letter",       "publish": "rec-letter",
                        "base": "letters"},
}
# DOC_KINDS bases that are their own bare-slug tree under Projects/ (never prefixed)
_BARE_BASES = ("briefs", "letters")

SUPPLEMENTS = {
    "cover-letter.md":      {"kind": "cover-letter", "label": "Cover letter"},
    "reviewer_response.md": {"kind": "response",     "label": "Response letter"},
    "appendix.md":          {"kind": "appendix",     "label": "Appendix"},
}
SUPPLEMENT_ORDER = ["cover-letter.md", "reviewer_response.md", "appendix.md"]
# the reviewers' comments a response letter is written against (shown read-only beside
# it); the first existing name wins.
REVIEW_NAMES = ("review.md", "reviewers.md")

PROJECT_DOCS = {
    "readme.md": {"kind": "readme", "label": "README", "publish": "", "path": "README.md"},
    "plan.md":   {"kind": "plan",   "label": "PLAN",   "publish": "", "path": "replication/PLAN.md"},
}
PROJECT_DOC_ORDER = ["readme.md", "plan.md"]
# the question register, surfaced read-only in the side panel when it exists
QUESTIONS_PATH = "logs/QUESTIONS.md"


def _is_supplement(docname):
    return (docname or "").strip().lower() in SUPPLEMENTS


def _is_project_doc(docname):
    return (docname or "").strip().lower() in PROJECT_DOCS


_SEG = r"[a-z0-9][a-z0-9._-]{0,63}"
_SAFE_DOC_RE = re.compile(rf"^(?:{_SEG}/)?{_SEG}\.md$")
# the grant's manuscript is already the main document, never a supplement of itself
_GRANT_MAIN_DOCS = {"proposal.md", "paper.md"}


def _compliance_path(proj):
    return Path(proj) / "rules" / "compliance.json"


def _is_grant_project(proj):
    try:
        return _compliance_path(proj).is_file()
    except (OSError, TypeError):
        return False


def _label_from_filename(name):
    return name[:-3].replace("-", " ").replace("_", " ").strip().capitalize()


@functools.lru_cache(maxsize=64)
def _grant_supplements_cached(proj_str, mtime):
    """{filename: {kind, label}} for one grant, in compliance.json's own order.
    Keyed on compliance.json's mtime so an edit to the rules is picked up without a
    server restart."""
    out = {}
    try:
        spec = json.loads(_compliance_path(proj_str).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return out
    for group in ("components", "additional_docs"):
        for key, c in (spec.get(group) or {}).items():
            f = (c.get("file") or "").strip()
            if not f.startswith("writing/") or not f.endswith(".md"):
                continue
            name = f[len("writing/"):]
            if name in _GRANT_MAIN_DOCS or name in out:
                continue
            if not _SAFE_DOC_RE.match(name):
                continue
            label = _label_from_filename(name.rsplit("/", 1)[-1])
            out[name] = {"kind": "grant-" + key.replace("_", "-"), "label": label,
                         "maxChars": c.get("max_chars"), "maxPages": c.get("max_pages"),
                         "limitType": c.get("limit_type"),
                         "categories": list(c.get("categories") or []),
                         "optional": bool(c.get("optional"))}
    return out


def _grant_supplements(proj):
    p = _compliance_path(proj)
    try:
        mt = p.stat().st_mtime_ns
    except OSError:
        return {}
    return _grant_supplements_cached(str(proj), mt)


# the funder's own key set (grant_audit.py check_deadlines): only these two gate,
# and `application` is the one a card should count down to.
_GRANT_DEADLINE_KEY = "application"
_EMPTY_GRANT_META = {"deadline": None, "deadlineRaw": None,
                     "deadlineKind": _GRANT_DEADLINE_KEY, "deadlineDone": False,
                     "deadlineUnknown": False, "byFile": {}}


@functools.lru_cache(maxsize=64)
def _grant_meta_cached(proj_str, mtime):
    meta = dict(_EMPTY_GRANT_META, byFile={})
    try:
        spec = json.loads(_compliance_path(proj_str).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return meta
    raw = ((spec.get("deadlines") or {}).get(_GRANT_DEADLINE_KEY) or "")
    raw = raw.strip() if isinstance(raw, str) else ""
    if raw:
        meta["deadlineRaw"] = raw
        meta["deadlineDone"] = _GRANT_DEADLINE_KEY in (spec.get("deadlines_completed") or ())
        try:
            datetime.fromisoformat(raw)
            meta["deadline"] = raw
        except ValueError:
            meta["deadlineUnknown"] = True
    by = meta["byFile"]
    for group in ("components", "additional_docs"):
        for key, c in (spec.get(group) or {}).items():
            f = (c.get("file") or "").strip()
            if not f or f in by:
                continue
            by[f] = {"component": key, "limitType": c.get("limit_type"),
                     "maxPages": c.get("max_pages"), "maxPagesFr": c.get("max_pages_fr"),
                     "maxChars": c.get("max_chars")}
    return meta


def _grant_meta(proj):
    p = _compliance_path(proj)
    try:
        mt = p.stat().st_mtime_ns
    except OSError:
        return _EMPTY_GRANT_META
    return _grant_meta_cached(str(proj), mt)


_NON_DOC_DIRS = {"build", "pdf", "docx", "tex", "tables", "versions", "archive",
                 ".writing-backups"}
_VERSIONING_LIVE_SUFFIX = ".open-items.md"


def _discovered_supplements(wdir, known):
    """Documents that ACTUALLY exist under writing/ but that no rule declared."""
    out = {}
    if wdir is None:
        return out
    try:
        if not wdir.is_dir():
            return out
        for p in sorted(wdir.glob("*.md")):
            name = p.name
            if (name in known or name in _GRANT_MAIN_DOCS or name in ("report.md", "letter.md")
                    or _is_project_doc(name) or not _SAFE_DOC_RE.match(name)):
                continue
            out[name] = {"kind": "working", "label": _label_from_filename(name)}
        for sub in sorted(d for d in wdir.iterdir() if d.is_dir()):
            if sub.name in _NON_DOC_DIRS or sub.name.startswith("."):
                continue
            live_only = sub.name == "versioning"
            for p in sorted(sub.glob("*.md")):
                if live_only and not p.name.endswith(_VERSIONING_LIVE_SUFFIX):
                    continue
                rel = "%s/%s" % (sub.name, p.name)
                if rel in known or not _SAFE_DOC_RE.match(rel):
                    continue
                out[rel] = {"kind": "working", "label": _label_from_filename(p.name)}
    except OSError:
        return out
    return out


def _proj_of_doc(manu):
    """The project directory holding a manuscript path, however deep the doc sits."""
    p = Path(manu).parent
    for _ in range(4):
        if p.name == "writing":
            return p.parent
        if p.parent == p:
            break
        p = p.parent
    return Path(manu).parent.parent


def _plain_for_count(text):
    """Plain text as a funder's character counter would see it: no YAML frontmatter and
    no HTML comments. Mirrors grant_audit.py's strip_to_plain so the count the Drafting
    view shows and the count the audit fails on are the same number."""
    t = _strip_frontmatter(text or "")
    t = re.sub(r"<!--.*?-->", "", t, flags=re.DOTALL)
    return t.strip()


def _cap_status(text, meta):
    """How a grant component stands against its cap, counted the way the audit counts."""
    cap = meta.get("maxChars")
    if (meta.get("limitType") or "") != "characters_per_category":
        n = len(_plain_for_count(text))
        out = {"chars": n}
        if cap:
            out["overBy"] = max(0, n - int(cap))
        return out
    cats = [c.lower() for c in (meta.get("categories") or [])]
    secs, worst, over = [], 0, 0
    for m in re.finditer(r"^#{2,6}\s*(.+)$", text or "", flags=re.MULTILINE):
        start = m.end()
        nxt = re.search(r"^#{2,6}\s", text[start:], flags=re.MULTILINE)
        body = text[start: start + (nxt.start() if nxt else len(text))]
        head = m.group(1).strip()
        if cats and not any(head.lower().startswith(c) for c in cats):
            continue          # not a funder box; entered nowhere, so not counted
        n = len(_plain_for_count(body))
        worst = max(worst, n)
        if cap:
            over = max(over, n - int(cap))
        secs.append({"name": head, "chars": n, "overBy": max(0, n - int(cap)) if cap else 0})
    return {"chars": worst, "overBy": max(0, over), "sections": secs,
            "perCategory": True}


def _supplements_for(proj):
    """The supplement set a project actually has."""
    declared = dict(_grant_supplements(proj)) if (
        proj is not None and _is_grant_project(proj)) else dict(SUPPLEMENTS)
    if proj is None:
        return declared
    declared.update(_discovered_supplements(Path(proj) / "writing", set(declared)))
    return declared

_RENDER_PRESET = {"thesis": "thesis", "dissertation": "thesis", "oped": "oped", "op-ed": "oped"}


def render_preset(publish):
    return _RENDER_PRESET.get((publish or "").strip().lower(), "manuscript")


def _doc_meta(docname):
    """Registry record for a manuscript or project-doc filename, or None if it isn't
    a recognized type."""
    key = (docname or "").strip().lower()
    return DOC_KINDS.get(key) or PROJECT_DOCS.get(key)


def _editor_name(docname):
    docname = (docname or DEFAULT_DOC).strip().lower()
    if docname == DEFAULT_DOC:
        return "editor.md"
    return docname[:-3].replace("/", ".") + ".editor.md"


VERSIONING_DIR = "versioning"
_SIDECAR_GLOBS = ("*.editor.md", "*.outline.md", "*.plan.md", "*.draft.md")
_SIDECAR_EXACT = ("editor.md", "outline.md")
_MIGRATED = set()   # resolved wdir paths already swept this process (idempotent guard)


def _versioning_dir(wdir):
    """writing/versioning/ for a given writing/ dir. Created lazily by the first write
    (_atomic_write mkdirs the parent)."""
    return wdir / VERSIONING_DIR


def _migrate_sidecars(wdir):
    try:
        key = str(wdir.resolve())
    except OSError:
        return
    if key in _MIGRATED:
        return
    _MIGRATED.add(key)
    try:
        if not wdir.is_dir():
            return
    except OSError:
        return
    names = set()
    for g in _SIDECAR_GLOBS:
        try:
            names.update(p.name for p in wdir.glob(g) if p.is_file())
        except OSError:
            pass
    for n in _SIDECAR_EXACT:
        try:
            if (wdir / n).is_file():
                names.add(n)
        except OSError:
            pass
    if not names:
        return
    vdir = _versioning_dir(wdir)
    try:
        vdir.mkdir(exist_ok=True)
    except OSError:
        return
    for n in sorted(names):
        dst = vdir / n
        if dst.exists():
            continue
        try:
            os.replace(str(wdir / n), str(dst))
        except OSError:
            pass


_FM_PUBLISH = re.compile(r"^publish\s*:\s*(.+?)\s*$", re.M)


def _frontmatter(text):
    """The leading YAML frontmatter block (between the opening --- and the next ---),
    or '' if none. Matches md_to_latex.strip_frontmatter exactly."""
    t = text or ""
    if not t.startswith("---"):
        return ""
    end = t.find("\n---", 3)
    return t[3:end] if end != -1 else ""


def _strip_frontmatter(text):
    """Body text with a leading YAML frontmatter block removed, if present — for a
    read-only viewer where the frontmatter (title/kind/etc.) is surfaced as metadata,
    not literal text in the rendered body."""
    t = text or ""
    if not t.startswith("---"):
        return t
    end = t.find("\n---", 3)
    if end == -1:
        return t
    return t[end + 4:].lstrip("\n")


def doc_publish(text, default_publish):
    m = _FM_PUBLISH.search(_frontmatter(text))
    if m:
        v = m.group(1).strip().strip('"\'').lower()
        if v:
            return v
    return default_publish


_PUB_STATE_KEYS = ("format", "blind", "endnotes", "figures")
_FM_TRUE = {"true", "yes", "on", "1", "y"}
_FM_FALSE = {"false", "no", "off", "0", "n"}


def _journal_key(v):
    """A frontmatter `journal:` value -> a _JOURNAL_STYLES key, or None. Accepts the key
    ('jhsb'), the full label ('Journal of Health and Social Behavior') or the label's
    abbreviation ('ASR')."""
    v = re.sub(r"\s+", " ", (v or "").strip().lower())
    if not v:
        return None
    for key, label, _c, _d in _JOURNAL_STYLES:
        low = label.lower()
        abbr = re.search(r"\(([^)]+)\)", low)
        if v in (key, low, key.replace("-", " ")) or (abbr and v == abbr.group(1)):
            return key
        if v == re.sub(r"\s*\([^)]*\)", "", low):
            return key
    slug = re.sub(r"[^a-z0-9]+", "-", v).strip("-")
    return slug if slug in _JOURNAL_CLS else None


def pub_options_from_fm(text):
    """The Publish state the manuscript's frontmatter sets: {format, blind, endnotes,
    figures}, only the keys present and valid, or None when it sets none."""
    fm = _frontmatter(text)
    if not fm:
        return None
    out = {}
    for ln in fm.split("\n"):
        if ":" not in ln or ln.startswith((" ", "\t", "-")):
            continue
        k, _, v = ln.partition(":")
        k = k.strip().lower()
        v = re.sub(r"\s+#.*$", "", v).strip().strip('"\'').strip().lower()
        if k == "journal":
            j = _journal_key(v)
            if j:
                out["format"] = j
        elif k == "blind":
            if v in _FM_TRUE:
                out["blind"] = True
            elif v in _FM_FALSE:
                out["blind"] = False
        elif k == "figures":
            f = {"end": "atend", "at end": "atend", "figuresatend": "atend"}.get(v, v)
            if f in ("inline", "atend", "separate"):
                out["figures"] = f
        elif k == "notes":
            if v in ("foot", "footnotes", "footnote"):
                out["endnotes"] = False
            elif v in ("end", "endnotes", "endnote"):
                out["endnotes"] = True
    return out or None


def _resolve_pub_state(wrapper_state, md_text, options=None):
    st = dict(wrapper_state or {})
    st.update(pub_options_from_fm(md_text) or {})
    for k, v in (options or {}).items():
        if v is not None:
            st[k] = v
    # SPQ is blind by construction (the .cls forces it); say so to Word too
    if (st.get("format") or "").lower() == "spq":
        st["blind"] = True
    return st or None


# ----------------------------------------------------------------- small utils
def _read(p):
    try:
        return p.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None


def _mt(p):
    """Integer-millisecond mtime — JS-Number-safe (st_mtime_ns overflows 2^53)."""
    try:
        return int(round(p.stat().st_mtime * 1000))
    except OSError:
        return 0


def _rel(vault, p):
    try:
        return str(p.relative_to(vault)).replace("\\", "/")
    except ValueError:
        return ""


def _wordcount(text):
    return len(re.findall(r"[A-Za-z0-9'’\-]+", text or ""))


def _paper_title(text, slug):
    tm = re.search(r"^title\s*:\s*(.+?)\s*$", _frontmatter(text), re.M)
    t = tm.group(1).strip().strip('"\'') if tm else ""
    if not t:
        m = re.search(r"^#\s+(.*?)\s*$", text or "", re.M)
        t = m.group(1).strip() if m else ""
    if t and not (slug and t == slug) and not _is_placeholder_title(t):
        return t
    return _project_title(slug) if slug else ("" if _is_placeholder_title(t) else t)


_PLACEHOLDER_TITLES = {"title", "untitled", "paper title", "working title", "title here",
                       "tbd", "tba", "todo", "your title", "insert title", "new paper"}


def _is_placeholder_title(t):
    s = re.sub(r"[\[\]()<>{}*_`\"'.:!?\-–—]+", " ", (t or "").lower())
    return " ".join(s.split()) in _PLACEHOLDER_TITLES


def _project_title(slug):
    for tree in ("papers", "grants"):
        proj = _PROJECTS_ROOT / tree / (PREFIX + slug)
        try:
            s = (proj / "README.md").read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        m = re.search(r"^#\s+(.*?)\s*$", s, re.M)
        h = m.group(1).strip() if m else ""
        if h and h != slug and not _is_placeholder_title(h):
            return h
    small = {"a", "an", "and", "as", "at", "but", "by", "for", "in", "of", "on", "or", "the", "to", "vs"}
    words = slug.split()
    return " ".join(w if (i and w in small) else w[:1].upper() + w[1:] for i, w in enumerate(words))


_KEBAB_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


def _kebab_of(name):
    """The same slug as explore._kebab: lower, spaces to dashes, drop what is not
    alnum or dash, collapse runs, trim."""
    s = (name or "").lower().replace(" ", "-")
    s = re.sub(r"[^a-z0-9-]", "", s)
    return re.sub(r"-{2,}", "-", s).strip("-")


def _canon_slug(vault, slug):
    projects = Path(vault) / "Projects"
    if (not _KEBAB_RE.match(slug)
            or (projects / "papers" / (PREFIX + slug)).is_dir()
            or (projects / "grants" / (PREFIX + slug)).is_dir()
            or (projects / "briefs" / slug).is_dir()
            or (projects / "letters" / slug).is_dir()):
        return slug
    for parent, prefix in (("papers", PREFIX), ("grants", PREFIX), ("briefs", ""), ("letters", "")):
        try:
            names = sorted(e.name for e in os.scandir(projects / parent) if e.is_dir())
        except OSError:
            continue
        for n in names:
            if prefix and not n.startswith(prefix):
                continue
            bare = n[len(prefix):]
            if bare and _kebab_of(bare) == slug:
                return bare
    return slug


def _writing_paths(vault, slug, doc=DEFAULT_DOC):
    slug = (slug or "").strip() if isinstance(slug, str) else ""
    if not slug or "/" in slug or "\\" in slug or ".." in slug or "\x00" in slug:
        return None
    if doc is not None and (not isinstance(doc, str) or "\x00" in doc):
        return None
    slug = _canon_slug(vault, slug)
    if slug.startswith(".") or (not PREFIX and slug.lower() == "archive"):
        return None
    doc = (doc or DEFAULT_DOC).strip().lower() or DEFAULT_DOC
    known = doc in DOC_KINDS or doc in SUPPLEMENTS or doc in PROJECT_DOCS
    if not known and not _SAFE_DOC_RE.match(doc):
        return None
    if DOC_KINDS.get(doc, {}).get("base") in _BARE_BASES:
        root = (vault / "Projects" / DOC_KINDS[doc]["base"]).resolve()
        d = (root / slug).resolve()
    else:
        proot = (vault / "Projects" / "papers").resolve()
        groot = (vault / "Projects" / "grants").resolve()
        pd = (proot / (PREFIX + slug)).resolve()
        gd = (groot / (PREFIX + slug)).resolve()
        if not pd.is_dir() and gd.is_dir():
            root, d = groot, gd
        elif doc not in DOC_KINDS and not pd.is_dir() and not gd.is_dir():
            root, d = proot, pd
            for base in _BARE_BASES:
                broot = (vault / "Projects" / base).resolve()
                bd = (broot / slug).resolve()
                if bd.is_dir():
                    root, d = broot, bd
                    break
        else:
            root, d = proot, pd
    try:
        d.relative_to(root)
    except ValueError:
        return None
    if not d.is_dir():
        return None
    if not known and doc not in _supplements_for(d):
        return None
    wdir = d / "writing"
    if doc in PROJECT_DOCS:
        # a project doc maps to its in-place file at the project level; its sidecars
        # stay under writing/versioning/ like every other doc's
        return (d / PROJECT_DOCS[doc]["path"], _versioning_dir(wdir) / _editor_name(doc))
    return (wdir / doc, _versioning_dir(wdir) / _editor_name(doc))


def _project_dir(vault, slug):
    for doc in (DEFAULT_DOC, "report.md", "letter.md"):
        paths = _writing_paths(vault, slug, doc)
        if paths:
            return paths[0].parent.parent
    return None


_ASSET_CT = {".png": "image/png", ".svg": "image/svg+xml", ".jpg": "image/jpeg",
             ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
             ".pdf": "application/pdf"}


def _find_asset(vault, slug, name):
    """Resolve exact project paths or legacy basenames, plus shared diagram exports.
    Reads stay inside the project or the flat Preparation/Diagrams allowlist;
    traversal, absolute paths and symlink escapes are refused."""
    proj = _project_dir(vault, slug)
    name = (name or "").replace("\\", "/").strip() if isinstance(name, str) else ""
    if not proj or not name or ".." in name or "\x00" in name or name.startswith("/"):
        return None
    # Shared, reusable diagrams are the sole non-project asset allowlist. Only a
    # direct exported image in this fixed vault root may be addressed explicitly.
    library_prefix = "Preparation/Diagrams/"
    if name.startswith(library_prefix):
        filename = name[len(library_prefix):]
        if (not filename or "/" in filename or filename.startswith(".")
                or Path(filename).suffix.lower() not in _ASSET_CT
                or Path(filename).suffix.lower() == ".pdf"):
            return None
        try:
            library = (Path(vault) / "Preparation" / "Diagrams").resolve()
            library.relative_to(Path(vault).resolve())
            candidate = (library / filename).resolve()
            candidate.relative_to(library)
            return candidate if candidate.is_file() else None
        except (ValueError, OSError):
            return None
    base = name.split("/")[-1]
    # Catalogue inserts carry a real project-relative path. Never silently replace a
    # missing explicit path with a different same-basename figure elsewhere.
    if "/" in name:
        try:
            c = (proj / name).resolve()
            c.relative_to(proj.resolve())
            return c if c.is_file() else None
        except (ValueError, OSError):
            return None
    # fast paths first (Obsidian resolves figures from results/)
    for cand in (proj / name, proj / "results" / base, proj / "writing" / base, proj / base):
        try:
            c = cand.resolve()
            c.relative_to(proj.resolve())
            if c.is_file():
                return c
        except (ValueError, OSError):
            pass
    # fall back to a bounded basename walk over the project tree
    try:
        for root, dirs, files in os.walk(proj):
            dirs[:] = [d for d in dirs if d not in (".git", "node_modules", "__pycache__", ".obsidian")]
            if base in files:
                c = (Path(root) / base).resolve()
                try:
                    c.relative_to(proj.resolve())
                    return c
                except ValueError:
                    pass
    except OSError:
        pass
    return _find_asset(vault, slug, "Preparation/Diagrams/" + base)


def _project_assets(proj, entries):
    """Compact insert catalogue, from real files rather than provenance membership."""
    skip = {"archive", "node_modules", "__pycache__", "versioning", "build", "corpus", "data"}
    image_order = (".png", ".svg", ".webp", ".jpg", ".jpeg", ".gif", ".pdf")
    table_order = (".csv", ".md", ".pdf", ".txt", ".png", ".svg")
    groups = {}
    root = proj.resolve()
    for directory, dirs, files in os.walk(proj):
        dirs[:] = sorted(d for d in dirs if not d.startswith(".") and d.lower() not in skip)
        for filename in sorted(files):
            if (filename.startswith(".") or "sync-conflict-" in filename
                    or any(c in filename for c in "[]|\r\n")):
                continue
            path = Path(directory) / filename
            ext = path.suffix.lower()
            table = path.stem.lower().startswith("tab.")
            order = table_order if table else image_order
            if ext not in order:
                continue
            # Arbitrary PDFs may be papers, manuals or data documentation. Figure
            # PDFs are identified by their figure name or their results location.
            if (ext == ".pdf" and not table and not path.stem.lower().startswith("fig.")
                    and "results" not in path.relative_to(proj).parts[:-1]):
                continue
            try:
                path.resolve().relative_to(root)
                if not path.is_file():
                    continue
            except (ValueError, OSError):
                continue
            key = path.relative_to(proj).with_suffix("").as_posix()
            previous = groups.get(key)
            if previous is None or order.index(ext) < order.index(previous.suffix.lower()):
                groups[key] = path
    assets = []
    for _, path in sorted(groups.items()):
        entry = entries.get(path.stem, {})
        source = path.with_suffix(".drawio")
        try:
            source.resolve().relative_to(root)
            diagram = source.is_file()
        except (ValueError, OSError):
            diagram = False
        assets.append({"name": path.relative_to(proj).as_posix(), "stem": path.stem,
                       "kind": "table" if path.stem.lower().startswith("tab.") else "figure",
                       "caption": entry.get("caption"), "diagram": diagram})
    return assets


def _diagram_assets(vault, slug):
    """The flat reusable Diagrams library, compact and without reading sources."""
    library = Path(vault) / "Preparation" / "Diagrams"
    try:
        files = sorted(library.iterdir())
    except OSError:
        return []
    rows = []
    for path in files:
        if (path.name.startswith(".") or "sync-conflict-" in path.name
                or any(c in path.name for c in "[]|\r\n")
                or path.suffix.lower() not in _ASSET_CT or path.suffix.lower() == ".pdf"):
            continue
        name = "Preparation/Diagrams/" + path.name
        if _find_asset(vault, slug, name):
            rows.append({"name": name, "stem": path.stem, "kind": "figure",
                         "caption": None, "diagram": True})
    return rows


def read_asset(vault, slug, name):
    """(bytes, content_type) for an image/pdf embed, or None."""
    p = _find_asset(vault, slug, name)
    if not p or p.suffix.lower() not in _ASSET_CT:
        return None
    try:
        return p.read_bytes(), _ASSET_CT[p.suffix.lower()]
    except OSError:
        return None


def asset_etag(vault, slug, name):
    """A quoted ETag for an image/pdf embed (mtime+size), or None. Lets the asset endpoint
    answer a repeat request with a 304 rather than re-sending a multi-megabyte figure."""
    p = _find_asset(vault, slug, name)
    if not p or p.suffix.lower() not in _ASSET_CT:
        return None
    try:
        st = p.stat()
    except OSError:
        return None
    return '"' + format(int(st.st_mtime_ns), "x") + "-" + format(int(st.st_size), "x") + '"'


_EMBED_LINE_RE = re.compile(r"^!\[\[([^\]]+)\]\]\s*$")
_PENDING_MARKER = "<!-- provenance: pending -->"


def _embedded_result_stems(text):
    lines = text.splitlines()
    out = []
    for i, line in enumerate(lines):
        m = _EMBED_LINE_RE.match(line.strip())
        if not m:
            continue
        ref = m.group(1).strip()
        base = ref.rsplit("/", 1)[-1]
        is_figure = re.search(r"\.(png|jpg|jpeg|pdf|svg)$", base, re.I)
        is_table = base.lower().startswith("tab.")
        if not (is_figure or is_table):
            continue   # some other transclusion, not a results/ figure or table
        stem = re.sub(r"\.(png|jpg|jpeg|pdf|svg)$", "", base, flags=re.I)
        if is_table:
            stem = re.sub(r"\.md$", "", stem, flags=re.I)
        exempt = False
        for j in range(i + 1, min(i + 3, len(lines))):
            nxt = lines[j].strip()
            if not nxt:
                continue
            exempt = (nxt.lower() == _PENDING_MARKER)
            break
        out.append((stem, exempt))
    return out


def _result_file(results, stem, ext):
    """The file backing this stem/ext, PREFERRING the top-level results/ copy over
    results/supplementary/."""
    for d in (results, results / "supplementary"):
        f = d / f"{stem}.{ext}"
        if f.is_file():
            return f
    return None


def _load_provenance(results_dir):
    p = Path(results_dir) / "provenance.json"
    if not p.is_file():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _stem_key(stem):
    """manifest key for an embed-derived stem: _embedded_result_stems keeps a table
    embed's .csv (![[tab.01.x.csv]] -> 'tab.01.x.csv') while provenance.json and
    _all_result_stems key pure stems ('tab.01.x') — strip it at every join."""
    return re.sub(r"\.csv$", "", stem, flags=re.I)


def _sha256_cached(path):
    """sha256 of an output file, cached by (path, mtime_ns, size) in the same table
    as _sha256_input_capped: provenance runs on every paper open and re-hashing each
    figure was ~85% of its time."""
    st = path.stat()
    key = (str(path), st.st_mtime_ns, st.st_size)
    hit = _INPUT_HASH_CACHE.get(key)
    if hit is None:
        hit = _INPUT_HASH_CACHE[key] = hashlib.sha256(path.read_bytes()).hexdigest()
    return hit


def _entry_freshness(results, stem, entry):
    out = {}
    for ext, want_hash in (entry.get("outputSha256") or {}).items():
        if not want_hash:
            continue
        f = _result_file(results, stem, ext)
        if not f:
            out[ext] = "missing"
        elif _sha256_cached(f) == want_hash:
            out[ext] = "fresh"
        else:
            out[ext] = "stale"
    return out


def figure_provenance_offenders(vault, slug, docs=("paper.md", "appendix.md")):
    proj = _project_dir(vault, slug)
    if not proj:
        return []
    results = proj / "results"
    manifest = _load_provenance(results)
    offenders, seen = [], set()
    for doc in docs:
        path = proj / "writing" / doc
        if not path.is_file():
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for stem, exempt in _embedded_result_stems(text):
            key = (doc, stem)
            if key in seen:
                continue
            seen.add(key)
            if exempt:
                continue
            entry = manifest.get(_stem_key(stem))
            if not entry:
                offenders.append((doc, stem, "no-provenance"))
                continue
            if entry.get("kind") == "external":
                continue
            if entry.get("generatedBy") == "backfill" and not entry.get("verified"):
                offenders.append((doc, stem, "unverified-backfill"))
                continue
            if any(v == "stale" for v in _entry_freshness(results, _stem_key(stem), entry).values()):
                offenders.append((doc, stem, "stale"))
    return offenders


def _verifier_approved(spath):
    import hashlib
    try:
        ok = json.loads((settings.STATE_DIR / "approved-verifiers.json").read_text(encoding="utf-8"))
        return hashlib.sha256(spath.read_bytes()).hexdigest() in set(ok)
    except (OSError, ValueError, TypeError):
        return False


VERIFIERS_SKIPPED = "stats verifiers skipped: run_vault_scripts is off"


def _run_stats_verifier(proj, verifier_rel, timeout=90):
    import subprocess
    if not settings.RUN_VAULT_SCRIPTS:
        return False, VERIFIERS_SKIPPED
    if not verifier_rel or ".." in str(verifier_rel):
        return False, "no/invalid verifier path"
    try:
        spath = (proj / verifier_rel).resolve()
        spath.relative_to(proj.resolve())
    except (ValueError, OSError):
        return False, "verifier path escapes project"
    if not spath.is_file():
        return False, "verifier missing: %s" % verifier_rel
    if not _verifier_approved(spath):
        return False, "verifier not approved: add its sha256 to approved-verifiers.json in the state dir"
    try:
        r = subprocess.run([sys.executable, str(spath)], cwd=str(proj),
                           capture_output=True, text=True, timeout=timeout)
    except Exception as exc:   # noqa: BLE001 — a verifier that won't launch is a fail, never a crash
        return False, "verifier run error: %s" % exc
    lines = [ln.strip() for ln in ((r.stdout or "") + (r.stderr or "")).splitlines() if ln.strip()]
    if r.returncode != 0:
        # surface the line that explains the failure, not merely the last line printed
        # (a multi-figure verifier prints a later figure's PASS after an earlier FAIL)
        flagged = [ln for ln in lines
                   if re.search(r"fail|drift|not in (figure|source)|no source row|missing", ln, re.I)]
        detail = flagged[-1] if flagged else (lines[-1] if lines else "exit %d" % r.returncode)
    else:
        detail = lines[-1] if lines else "exit 0"
    return (r.returncode == 0), detail


_LATEX_EMBED_RE = re.compile(r"\\(?:includegraphics(?:\[[^\]]*\])?|input)\s*\{([^}]+)\}")


def _latex_embedded_result_stems(text):
    out = []
    for ref in _LATEX_EMBED_RE.findall(text):
        base = ref.strip().rsplit("/", 1)[-1]
        base = re.sub(r"\.(png|jpg|jpeg|pdf|svg|eps)$", "", base, flags=re.I)
        if base[:3].lower() in ("fig", "tab"):
            out.append(base)
    return out


def external_stats_offenders(vault, slug, docs=("paper.md", "appendix.md"), run_verifiers=True):
    proj = _project_dir(vault, slug)
    if not proj:
        return []
    results = proj / "results"
    manifest = _load_provenance(results)
    offenders, seen = [], set()
    for doc in docs:
        path = proj / "writing" / doc
        if not path.is_file():
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        embeds = list(_embedded_result_stems(text)) + [(s, False) for s in _latex_embedded_result_stems(text)]
        for stem, exempt in embeds:
            key = (doc, _stem_key(stem))
            if key in seen:
                continue
            seen.add(key)
            if exempt:
                continue
            entry = manifest.get(_stem_key(stem))
            if not entry or entry.get("kind") != "external":
                continue
            if _external_displays_stats(entry) and not entry.get("statsSource"):
                offenders.append((doc, stem, "external-unverified",
                                  "external displays statistics with no statsSource"))
                continue
            src = entry.get("statsSource")
            if run_verifiers and src and settings.RUN_VAULT_SCRIPTS:
                ok, detail = _run_stats_verifier(proj, src.get("verifier"))
                if not ok:
                    offenders.append((doc, stem, "stats-verifier-failed", detail))
    return offenders


def _embedded_result_assets(text):
    lines = text.splitlines()
    out = []
    for i, line in enumerate(lines):
        m = _EMBED_LINE_RE.match(line.strip())
        if not m:
            continue
        ref = m.group(1).strip()
        base = ref.rsplit("/", 1)[-1]
        is_figure = re.search(r"\.(png|jpg|jpeg|pdf|svg)$", base, re.I)
        is_table = base.lower().startswith("tab.")
        if not (is_figure or is_table):
            continue
        stem = re.sub(r"\.(png|jpg|jpeg|pdf|svg)$", "", base, flags=re.I)
        if is_table:
            stem = re.sub(r"\.(md|csv)$", "", stem, flags=re.I)
        exempt = False
        for j in range(i + 1, min(i + 3, len(lines))):
            nxt = lines[j].strip()
            if not nxt:
                continue
            exempt = (nxt.lower() == _PENDING_MARKER)
            break
        out.append({"line": i + 1, "name": base, "stem": stem,
                    "kind": "table" if is_table else "figure", "exempt": exempt})
    return out


_STEM_PREFIX_RE = re.compile(r"^(fig|figS|tab)\.?\d+\.?", re.I)


def _stem_suffix(stem):
    return _STEM_PREFIX_RE.sub("", stem, count=1)


def _confirmed_suggestion(results, stem, kind):
    """'<stem>.<ext>' with a preferred extension CONFIRMED on disk (png else svg for
    figures, csv for tables), or None — a suggestion is never a guess at a file that
    isn't there."""
    for ext in (("png", "svg") if kind == "figure" else ("csv",)):
        if _result_file(results, stem, ext):
            return f"{stem}.{ext}"
    return None


def _nearest_stem(proj, missing_name):
    import difflib
    if not proj:
        return None
    results = proj / "results"
    candidates = _all_result_stems(proj)   # {stem: kind}, archive excluded, supp deduped
    if not candidates:
        return None
    missing_stem = re.sub(r"\.(png|jpg|jpeg|pdf|svg)$", "", missing_name or "", flags=re.I)
    missing_stem = re.sub(r"\.(md|csv)$", "", missing_stem, flags=re.I)
    missing_kind = "table" if missing_stem.lower().startswith("tab") else "figure"
    suffix = _stem_suffix(missing_stem).lower()
    if suffix:
        hits = [s for s, k in candidates.items()
                if k == missing_kind and _stem_suffix(s).lower() == suffix]
        if len(hits) == 1:
            sugg = _confirmed_suggestion(results, hits[0], missing_kind)
            if sugg:
                return sugg
    close = difflib.get_close_matches(missing_stem, list(candidates), n=1, cutoff=0.85)
    if close:
        return _confirmed_suggestion(results, close[0], candidates[close[0]])
    return None


def _note_caption(proj, stem):
    fn = fignotes.notes(proj, stem)
    if fn:
        return True, fn["caption"]
    p = proj / "results" / "0.figure_notes.md"
    if not p.is_file():
        return False, None
    try:
        text = p.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return False, None
    if stem not in text:
        return False, None
    hm = re.search(r"\*\*[^*\n]*`" + re.escape(stem) + r"`[^*\n]*\*\*\s*(.+)", text)
    if not hm:
        return True, None
    tail = re.sub(r"\s+", " ", hm.group(1)).strip()
    sm = re.match(r"(.+?[.!?])(\s|$)", tail)
    cap = (sm.group(1) if sm else tail[:200]).strip()
    return True, (cap or None)


def _external_displays_stats(entry):
    return bool(entry.get("displaysStats", True)) if isinstance(entry, dict) else True


_INPUT_DATA_EXTS = (".dta", ".csv", ".json", ".parquet", ".xlsx", ".xls", ".rds",
                    ".feather", ".sav", ".txt", ".tsv", ".dat")
_INPUT_REHASH_CAP = 64 * 1024 * 1024
_INPUT_HASH_CACHE = {}                  # (path, mtime_ns, size) -> sha; persists across reads in the server process


def _projects_root_for(project_dir):
    """The `Projects` ancestor of a project dir."""
    project_dir = Path(project_dir)
    for anc in project_dir.parents:
        if anc.name == "Projects":
            return anc
    parents = list(project_dir.parents)
    return parents[1] if len(parents) >= 2 else project_dir


def _projects_roots(root):
    roots = [root]
    if settings.PROJECTS_DIR.is_dir() and settings.PROJECTS_DIR != Path(root):
        roots.append(settings.PROJECTS_DIR)
    return roots


def resolve_data_source(ds, project_dir):
    project_dir = Path(project_dir)
    root = _projects_root_for(project_dir)
    ds = (ds or "").strip()
    if not ds:
        return None

    def ok(p):
        p = Path(p)
        return p.is_file()

    roots = _projects_roots(root)
    hub = tuple(r / d / settings.DATA_FAMILY / "datasets"
                for r in roots for d in ("data", ".data"))

    if ds.startswith("/"):
        if ok(ds):
            return Path(ds)
        m = re.search(r"/Projects/(.+)$", ds)
        if not m:
            return None
        ds = m.group(1)   # re-root a foreign-tree absolute; fall through to relative shapes

    for pre in ("papers/", "briefs/", "grants/", "data/", ".data/"):
        if ds.startswith(pre):
            cands = []
            for r in roots:
                cands.append(r / ds)
                if pre == "data/":
                    cands.append(r / ("." + ds))
                elif pre == ".data/":
                    cands.append(r / ds[1:])
            for c in cands:
                if ok(c):
                    return c
            break

    if "/" in ds and " " not in ds.split("/", 1)[0]:
        for c in (project_dir / ds, *(r / ds for r in roots)):
            if ok(c):
                return c

    if "/" not in ds and " " not in ds and ds.lower().endswith(_INPUT_DATA_EXTS):
        for h in hub:
            if ok(h / ds):
                return h / ds

    for tok in re.findall(r"[\w./\-]+", ds):
        base = tok.split("/")[-1]
        if base.lower().endswith(_INPUT_DATA_EXTS):
            for c in (*(h / base for h in hub), project_dir / tok,
                      *(r / tok for r in roots)):
                if ok(c):
                    return c
    return None


def _sha256_input_capped(path):
    path = Path(path)
    try:
        st = path.stat()
    except OSError:
        return None, "ok"
    if st.st_size > _INPUT_REHASH_CAP:
        return None, "skipped-large"
    key = (str(path), st.st_mtime_ns, st.st_size)
    hit = _INPUT_HASH_CACHE.get(key)
    if hit is not None:
        return hit, "ok"
    h = hashlib.sha256()
    try:
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
    except OSError:
        return None, "ok"
    _INPUT_HASH_CACHE[key] = h.hexdigest()
    return _INPUT_HASH_CACHE[key], "ok"


def _input_freshness(results, entry):
    recorded = entry.get("inputSha256")
    if not isinstance(recorded, dict) or not recorded:
        return {}
    project_dir = Path(results).parent
    out = {}
    for ds, rec in recorded.items():
        if rec is None:
            out[ds] = "unrecorded"          # unresolvable at write time; nothing to compare
            continue
        p = resolve_data_source(ds, project_dir)
        if not p:
            out[ds] = "missing"             # recorded a hash, source no longer resolves here
            continue
        cur, how = _sha256_input_capped(p)
        if how == "skipped-large":
            out[ds] = "skipped-large"
        elif cur is None:
            out[ds] = "missing"
        elif cur == rec:
            out[ds] = "fresh"
        else:
            out[ds] = "stale"
    return out


def _entry_status(entry, freshness, input_freshness=None):
    if not entry:
        return "none"
    if entry.get("kind") == "external":
        if _external_displays_stats(entry) and not entry.get("statsSource"):
            return "external-unverified"
        return "external"
    if any(v in ("stale", "missing") for v in freshness.values()):
        return "stale"
    if entry.get("generatedBy") == "backfill" and not entry.get("verified"):
        return "none"
    if input_freshness and any(v == "stale" for v in input_freshness.values()):
        return "stale-inputs"
    return "fresh"


def provenance_status(vault, slug, docs=("paper.md", "appendix.md")):
    """The Drafting view's full provenance picture, ground-truthed against
    provenance.json + the files on disk (never a possibly-stale index):"""
    proj = _project_dir(vault, slug)
    if not proj:
        return {"error": "unknown paper"}
    results = proj / "results"
    manifest = _load_provenance(results)
    notes_path = results / "0.figure_notes.md"

    entries = {}
    all_stems = dict(_all_result_stems(proj))
    for mstem, rec in manifest.items():
        if mstem not in all_stems:
            all_stems[mstem] = (rec.get("kind") if isinstance(rec, dict) else None) or ("table" if mstem.lower().startswith("tab") else "figure")
    for stem, kind in sorted(all_stems.items()):
        entry = manifest.get(stem) or {}
        freshness = _entry_freshness(results, stem, entry) if entry else {}
        input_freshness = _input_freshness(results, entry) if entry else {}
        fn = fignotes.notes(proj, stem)
        if fn:
            # notes in the producing script's header: notesRel points at the
            # script, so a stale tab's Notes button still has a real file behind it
            caption, notes_rel = fn["caption"], _rel(vault, fn["path"])
            notes_source, notes_script = "header", fn["script"]
        else:
            mentioned, caption = _note_caption(proj, stem)
            notes_rel = _rel(vault, notes_path) if (mentioned and notes_path.is_file()) else None
            notes_source = "notes" if notes_rel else None
            notes_script = None
        dio = _result_file(results, stem, "drawio")   # editable draw.io source -> Edit-diagram affordance
        entries[stem] = {
            "diagram": _mt(dio) if dio else None,
            "kind": entry.get("kind") or kind,
            "script": entry.get("script"),
            "dataSources": entry.get("dataSources"),
            "commit": entry.get("commit"),
            "generated": entry.get("generated"),
            "generatedBy": entry.get("generatedBy"),
            "manualNote": entry.get("manualNote"),
            "verified": entry.get("verified"),
            "displaysStats": entry.get("displaysStats"),
            "statsSource": entry.get("statsSource"),
            "statsVerifiedAt": entry.get("statsVerifiedAt"),
            "environment": entry.get("environment"),
            "sessionId": entry.get("sessionId"),
            "notesAnchor": entry.get("notesAnchor") or (fn["anchor"] if fn else None),
            "notesRel": notes_rel,
            "notesSource": notes_source,
            "notesScript": notes_script,     # project-relative script holding the notes
            "caption": caption,
            "freshness": freshness,
            "inputFreshness": input_freshness,
            "divergence": None,
            "status": _entry_status(entry, freshness, input_freshness),
        }

    embeds = []
    for doc in docs:
        path = proj / "writing" / doc
        if not path.is_file():
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for a in _embedded_result_assets(text):
            resolved = _find_asset(vault, slug, a["name"]) is not None
            suggestion = None if resolved else _nearest_stem(proj, a["name"])
            embeds.append({
                "doc": doc, "line": a["line"], "name": a["name"], "stem": a["stem"],
                "kind": a["kind"], "resolved": resolved, "exempt": a["exempt"],
                "suggestion": suggestion,
                "provenance": entries.get(a["stem"], {}).get("status", "none"),
            })

    return {"ok": True, "slug": slug, "entries": entries, "embeds": embeds,
            "assets": _project_assets(proj, entries) + _diagram_assets(vault, slug),
            "divergenceCounts": {}}


_VIEWER_TEXT_EXTS = {".py": "python", ".do": "stata", ".r": "r", ".jl": "julia",
                     ".md": "markdown", ".txt": "text", ".yaml": "yaml", ".yml": "yaml",
                     ".json": "json", ".ipynb": "json", ".tex": "latex", ".log": "text",
                     ".bib": "text", ".sql": "sql", ".sh": "shell", ".ini": "properties",
                     ".err": "text", ".cfg": "properties",
                     ".rmd": "markdown", ".qmd": "markdown", ".ado": "stata"}
_VIEWER_MAX_BYTES = 1_000_000
_VIEWER_BINARY_EXTS = {".dta", ".rds", ".rdata", ".rda", ".parquet", ".feather", ".sav",
                       ".xlsx", ".xls", ".ods", ".pkl", ".npy", ".npz", ".safetensors",
                       ".zip", ".gz", ".tar", ".h5", ".hdf5", ".doc", ".docx",
                       ".shp", ".shx", ".dbf", ".prj", ".pyc"}


def _resolve_in_project(proj, rel):
    """proj/rel, confined to proj (resolve + ancestor check) — None if it escapes
    or doesn't exist. Shared by read_project_file's exact-path and fallback tries."""
    if not rel or ".." in rel:
        return None
    try:
        p = (proj / rel).resolve()
        p.relative_to(proj.resolve())
    except (ValueError, OSError):
        return None
    return p if p.is_file() else None


def _find_by_basename(proj, base):
    hits = []
    try:
        for root, dirs, files in os.walk(proj):
            dirs[:] = [d for d in dirs if d not in (".git", "node_modules", "__pycache__",
                                                      ".obsidian", ".viewer-backups")]
            if base in files:
                hits.append(Path(root) / base)
                if len(hits) > 1:
                    break
    except OSError:
        pass
    return hits[0] if len(hits) == 1 else None


def read_project_file(vault, slug, relpath):
    proj = _project_dir(vault, slug)
    rel = (relpath or "").replace("\\", "/").strip().lstrip("/")
    if not proj or not rel:
        return {"error": "not found"}
    p = _resolve_in_project(proj, rel)
    if p is None:
        marker = proj.name + "/"
        if marker in rel:
            rel = rel.split(marker, 1)[-1]
            p = _resolve_in_project(proj, rel)
    if p is None:
        fallback = _find_by_basename(proj, rel.split("/")[-1])
        if fallback is not None:
            p, rel = fallback, str(fallback.relative_to(proj)).replace("\\", "/")
    if p is None:
        return {"error": "not found"}
    ext = p.suffix.lower()
    try:
        size = p.stat().st_size
    except OSError:
        return {"error": "not found"}
    if ext in _VIEWER_BINARY_EXTS:
        # a real data/archive file, not an error case — size stands alone, no read
        return {"ok": True, "name": p.name, "rel": rel, "kind": "binary", "ext": ext, "size": size}
    if size > _VIEWER_MAX_BYTES:
        return {"error": "too large", "size": size}
    if ext == ".csv":
        import csv as _csv
        try:
            with open(p, newline="", encoding="utf-8", errors="replace") as fh:
                rows = list(_csv.reader(fh))
        except OSError:
            return {"error": "not found"}
        return {"ok": True, "name": p.name, "rel": rel, "kind": "csv", "rows": rows[:2000]}
    lang = _VIEWER_TEXT_EXTS.get(ext)
    if not lang:
        return {"error": "unsupported type"}
    try:
        text = p.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return {"error": "not found"}
    return {"ok": True, "name": p.name, "rel": rel, "kind": "text", "lang": lang, "text": text}


_EDITABLE_EXTS = {".py", ".r", ".do", ".md", ".txt", ".yaml", ".yml", ".json", ".tex"}


def write_project_file(vault, slug, relpath, text, base_mtime=None):
    proj = _project_dir(vault, slug)
    rel = (relpath or "").replace("\\", "/").strip().lstrip("/")
    if not proj or not rel or ".." in rel or text is None:
        return {"error": "not found"}
    try:
        p = (proj / rel).resolve()
        p.relative_to(proj.resolve())
    except (ValueError, OSError):
        return {"error": "not found"}
    if not p.is_file():
        return {"error": "not found"}
    if p.suffix.lower() not in _EDITABLE_EXTS:
        return {"error": "read-only type"}
    if p.name == "provenance.json":
        return {"error": "read-only file"}
    if len(text.encode("utf-8")) > _VIEWER_MAX_BYTES:
        return {"error": "too large"}
    cur = _mt(p)
    if base_mtime is not None and cur != int(base_mtime):
        return {"conflict": True, "currentMtime": cur}
    try:
        bdir = proj / ".viewer-backups"
        bdir.mkdir(exist_ok=True)
        stamp = time.strftime("%Y%m%d-%H%M%S")
        (bdir / f"{p.name}.{stamp}").write_text(
            p.read_text(encoding="utf-8", errors="replace"), encoding="utf-8")
        p.write_text(text, encoding="utf-8")
    except OSError as e:
        return {"error": str(e)}
    return {"ok": True, "rel": rel, "mtime": _mt(p)}


_TREE_NOISE_DIRS = {".git", "node_modules", "__pycache__", ".obsidian", ".viewer-backups",
                    ".writing-backups", ".ipynb_checkpoints", ".cache"}
_TREE_SCRIPT_EXTS = {".py": "python", ".r": "r", ".do": "stata", ".jl": "julia",
                     ".ipynb": "json", ".sql": "sql", ".sh": "shell",
                     ".rmd": "markdown", ".qmd": "markdown", ".ado": "stata"}
_DATA_REF_RE = re.compile(
    r'(?:read_dta|read_sav|read_rds|readRDS|read\.csv|read\.dta|read_csv|fread|'
    r'pd\.read_\w+|pyreadstat\.read_\w+)\s*\([^)\n]{0,160}\)?'
    r'|\b[A-Za-z_][A-Za-z0-9_]*(?:_DIR|_PATH|DIR|PATH)\s*(?:<-|=)\s*(?:file\.path\()?'
    r'["\'][^"\'\n]{3,160}["\']')


def list_replication_files(vault, slug):
    proj = _project_dir(vault, slug)
    if not proj:
        return {"error": "unknown paper"}
    repl = proj / "replication"
    if not repl.is_dir():
        return {"ok": True, "hasReplication": False, "scripts": [], "dataDirs": [], "dataRefs": []}

    scripts = []
    for root, dirs, files in os.walk(repl):
        dirs[:] = sorted(d for d in dirs if d not in _TREE_NOISE_DIRS and not d.startswith("."))
        rp = Path(root)
        for f in sorted(files):
            lang = _TREE_SCRIPT_EXTS.get(Path(f).suffix.lower())
            if not lang:
                continue
            fp = rp / f
            try:
                size = fp.stat().st_size
            except OSError:
                continue
            scripts.append({
                "rel": str(fp.relative_to(proj)).replace("\\", "/"), "name": f,
                "dir": str(fp.parent.relative_to(proj)).replace("\\", "/"),
                "lang": lang, "size": size,
            })
    scripts.sort(key=lambda s: (s["dir"], s["name"]))

    data_dirs = []
    try:
        children = sorted(p for p in repl.iterdir()
                           if p.is_dir() and p.name not in _TREE_NOISE_DIRS and not p.name.startswith("."))
    except OSError:
        children = []
    for child in children:
        try:
            files = [f for f in child.rglob("*") if f.is_file()]
        except OSError:
            files = []
        exts = sorted({f.suffix.lower() for f in files if f.suffix})
        data_dirs.append({
            "rel": str(child.relative_to(proj)).replace("\\", "/"), "name": child.name,
            "fileCount": len(files), "exts": exts[:8],
        })

    data_refs, seen = [], set()
    for s in scripts:
        if len(data_refs) >= 20:
            break
        try:
            lines = (proj / s["rel"]).read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            continue
        for i, line in enumerate(lines, 1):
            if len(data_refs) >= 20:
                break
            if not _DATA_REF_RE.search(line):
                continue
            snippet = line.strip()[:180]
            key = (s["rel"], snippet)
            if key in seen:
                continue
            seen.add(key)
            data_refs.append({"rel": s["rel"], "line": i, "text": snippet})

    return {"ok": True, "hasReplication": True, "scripts": scripts, "dataDirs": data_dirs, "dataRefs": data_refs}


_PROJECTS_ROOT = settings.PROJECTS_DIR
_TABLE_BUILD_LOCKS = {}
_TABLE_BUILD_LOCKS_GUARD = threading.Lock()


def _table_build_lock(proj):
    key = str(proj)
    with _TABLE_BUILD_LOCKS_GUARD:
        lk = _TABLE_BUILD_LOCKS.get(key)
        if lk is None:
            lk = threading.Lock()
            _TABLE_BUILD_LOCKS[key] = lk
        return lk


def _table_pdf_stale(proj, stem):
    """True when results/<stem>.pdf needs a (re)build: it is missing while a source CSV
    exists, or it is older than that CSV. A lone PDF with no CSV is treated as fresh (a
    legacy table whose data source is gone — never rebuildable, never clobbered)."""
    results = proj / "results"
    pdf = results / (stem + ".pdf")
    csv = results / (stem + ".csv")
    if not pdf.exists():
        return csv.exists()
    return csv.exists() and _mt(csv) > _mt(pdf)


def _ensure_table_pdf(vault, slug, stem):
    proj = _project_dir(vault, slug)
    if not proj:
        return False
    pdf = proj / "results" / (stem + ".pdf")
    if not _table_pdf_stale(proj, stem):
        return pdf.exists()
    with _table_build_lock(proj):
        if not _table_pdf_stale(proj, stem):
            return pdf.exists()
        try:
            (proj / "writing" / "build").mkdir(parents=True, exist_ok=True)
        except OSError:
            return pdf.exists()
        bscript = _toolkit(vault) / "scripts" / "build_standalone_table.py"
        if not settings.RUN_VAULT_SCRIPTS or not bscript.is_file():
            return pdf.exists()
        try:
            _native_run([sys.executable, str(bscript), str(proj)], proj, 240)
        except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
            return pdf.exists()
    return pdf.exists()


def _stitch_pages(tmpd, out):
    """Crop each rendered page to its ink and stack the pages into one PNG."""
    from PIL import Image, ImageChops
    crops = []
    for f in sorted(Path(tmpd).glob("pg*.png")):
        im = Image.open(f).convert("RGB")
        bb = ImageChops.difference(im, Image.new("RGB", im.size, (255, 255, 255))).getbbox()
        if bb:
            l, t, r, b = bb
            pad = 10
            im = im.crop((max(0, l - pad), max(0, t - pad), min(im.width, r + pad), min(im.height, b + pad)))
        crops.append(im)
    if not crops:
        return
    gap = 26
    W = max(c.width for c in crops)
    H = sum(c.height for c in crops) + gap * (len(crops) - 1)
    canvas = Image.new("RGB", (W, H), (255, 255, 255))
    y = 0
    for c in crops:
        canvas.paste(c, ((W - c.width) // 2, y))
        y += c.height + gap
    canvas.save(out)


def table_png(vault, slug, name, doc=DEFAULT_DOC, dpi=150):
    ref = (name or "").replace("\\", "/").strip() if isinstance(name, str) else ""
    if not ref or ".." in ref or "\x00" in ref or ref.startswith("/"):
        return None
    if ref.lower().endswith((".md", ".csv", ".txt")):
        ref = ref.rsplit(".", 1)[0] + ".pdf"
    if not ref.lower().endswith(".pdf"):
        return None
    base = ref.rsplit("/", 1)[-1]
    # Build (or rebuild) the typeset table PDF from its CSV if it is missing or stale, so
    # the rasterized image is always the CURRENT final LaTeX table, not a leftover render.
    if "/" not in ref or ref.rsplit("/", 1)[0] == "results":
        _ensure_table_pdf(vault, slug, base[:-4])
    pdf = _find_asset(vault, slug, ref)
    if not pdf or pdf.suffix.lower() != ".pdf" or not pdf.exists():
        return None
    cache = pdf.parent / ".cache"
    try:
        cache.mkdir(exist_ok=True)
    except OSError:
        return None
    out = cache / "{}.{}.png".format(pdf.stem, int(_mt(pdf) or 0))
    if not out.exists():
        exe = _native_tool("pdftocairo")
        if not exe:
            return None
        try:
            with tempfile.TemporaryDirectory(prefix="tblpng_") as tmpd:
                _native_run([exe, "-png", "-r", str(int(dpi)), str(pdf), os.path.join(tmpd, "pg")], pdf.parent, 60)
                _stitch_pages(tmpd, out)
        except (subprocess.TimeoutExpired, FileNotFoundError, OSError, ImportError):
            return None
        if not out.exists():
            return None
        # keep only the current-mtime render for this table
        try:
            for old in cache.glob(pdf.stem + ".*.png"):
                if old != out:
                    old.unlink()
        except OSError:
            pass
    try:
        return out.read_bytes(), "image/png"
    except OSError:
        return None


_CIT_DIR = ("Preparation", "Reading", "Citations")
_CLIP_DIR = ("Preparation", "Reading", "Clippings")   # web/news clippings are citable sources too


def _source_ok(vault, rel):
    rel = (rel or "").replace("\\", "/").strip().lstrip("/")
    if not rel or ".." in rel.split("/") or "\x00" in rel or not rel.endswith(".md"):
        return None
    try:
        p = (vault / rel).resolve()
    except OSError:
        return None
    cit = (vault / Path(*_CIT_DIR)).resolve()
    clip = (vault / Path(*_CLIP_DIR)).resolve()
    papers = (vault / "Projects" / "papers").resolve()
    ok = False
    for tree in (cit, clip):
        try:
            p.relative_to(tree)
            ok = True
            break
        except ValueError:
            continue
    if not ok:
        try:
            r = p.relative_to(papers)
            ok = len(r.parts) >= 3 and r.parts[1] == "corpus"
        except ValueError:
            ok = False
    if not ok or not p.is_file():
        return None
    return p


def _norm_match(s):
    """Normalize for forgiving quote matching: unify curly quotes/dashes, collapse
    whitespace, lowercase. Lets a copied quote match the note despite smart-quote or
    spacing drift — the no-hallucination check stays robust without being brittle."""
    s = (s or "")
    for a, b in (("“", '"'), ("”", '"'), ("‘", "'"), ("’", "'"),
                 ("–", "-"), ("—", "-"), ("…", "...")):
        s = s.replace(a, b)
    return re.sub(r"\s+", " ", s).strip().lower()


def read_source(vault, rel, quote=None):
    p = _source_ok(vault, rel)
    if p is None:
        return {"error": "not a readable source note"}
    text = _read(p) or ""
    found, match_line = False, -1
    q = (quote or "").strip().strip('"“”')
    if q:
        nq = _norm_match(q)
        if nq and nq in _norm_match(text):
            found = True
            # locate the line the quote starts on (best effort, normalized per-line window)
            lines = text.split("\n")
            for i in range(len(lines)):
                window = _norm_match(" ".join(lines[i:i + 6]))
                if nq[:80] in window:
                    match_line = i
                    break
    return {"rel": _rel(vault, p), "name": p.name, "text": text,
            "found": found, "matchLine": match_line, "quote": q}


# ----------------------------------------------------------------- cite -> PDF page jump
_CORPUS_DIR = ("Preparation", "Reading", "Corpus")   # where the source PDFs live
_PDFREF_RE = re.compile(
    r"\[\[([^\]\|#]+\.pdf)#page=(\d+)(?:&([^\|\]]*))?\|([^\]]*?)\]\]", re.I)
_PRINTED_RE = re.compile(r"p\.?\s*(\d+)(?:\s*[-–]\s*(\d+))?", re.I)


def _fm_value(text, key):
    # one frontmatter scalar (quotes stripped). Minimal — mirrors the citation index read.
    m = re.match(r"(?s)^---\s*\n(.*?)\n---", text)
    if not m:
        return ""
    for ln in m.group(1).split("\n"):
        if ":" in ln and not ln.startswith((" ", "\t", "-")):
            k, _, v = ln.partition(":")
            if k.strip().lower() == key:
                return v.strip().strip('"\'')
    return ""


def _pdfref_links(text):
    # every PDF++ highlight link -> {physical, printedStart, printedEnd, selection, pdf}.
    out = []
    for m in _PDFREF_RE.finditer(text):
        pdf, phys, params, label = m.group(1), int(m.group(2)), m.group(3) or "", m.group(4)
        pm = _PRINTED_RE.search(label)
        if not pm:
            continue
        ps = int(pm.group(1))
        pe = int(pm.group(2)) if pm.group(2) else ps
        sel = ""
        sm = re.search(r"selection=([\d,]+)", params)
        if sm:
            sel = sm.group(1)
        out.append({"physical": phys, "printedStart": ps, "printedEnd": pe,
                    "selection": sel, "pdf": pdf.strip(), "linkEnd": m.end()})
    return out


def _quote_after(text, link_end):
    # the blockquote prose right after a highlight link (so the page jump can show the
    # exact quoted words for context). Best effort: the next non-empty '>' lines.
    tail = text[link_end:].replace("\r\n", "\n").split("\n")
    buf = []
    for ln in tail[1:8]:
        s = ln.strip()
        if s.startswith(">"):
            s = s.lstrip(">").strip()
        if not s:
            if buf:
                break
            continue
        if s.startswith("#") or s.startswith("[["):
            break
        buf.append(s)
    q = " ".join(buf).strip()
    return q[:400]


def source_pdf_path(vault, rel):
    """Confined resolve of a source PDF: a .pdf under Preparation/Reading/Corpus/ or any
    project corpus/. Rejects '..'/absolute/other-tree. None if missing."""
    rel = (rel or "").replace("\\", "/").strip().lstrip("/")
    if not rel or ".." in rel.split("/") or "\x00" in rel or not rel.lower().endswith(".pdf"):
        return None
    try:
        p = (vault / rel).resolve()
    except OSError:
        return None
    corpus = (vault / Path(*_CORPUS_DIR)).resolve()
    try:
        p.relative_to(corpus)
        return p if p.is_file() else None
    except ValueError:
        pass
    try:
        r = p.relative_to((vault / "Projects" / "papers").resolve())
        if len(r.parts) >= 3 and r.parts[1] == "corpus" and p.is_file():
            return p
    except ValueError:
        pass
    return None


_FIND_SUB = str.maketrans({"‘": "'", "’": "'", "‚": "'", "‛": "'", "′": "'",
                           "“": '"', "”": '"', "„": '"', "″": '"', "«": '"', "»": '"',
                           "‐": "-", "‑": "-", "‒": "-", "–": "-", "—": "-", "−": "-",
                           "­": "", " ": " "})


def _find_key(s):
    """Searchable key of `s` plus, per key char, its index in `s`."""
    import unicodedata
    key, at = [], []
    for i, ch in enumerate(s):
        for c in unicodedata.normalize("NFKC", ch).translate(_FIND_SUB).lower():
            if c == "-":
                continue
            if c.isspace():
                if not key or key[-1] == " ":
                    continue
                c = " "
            key.append(c); at.append(i)
    return "".join(key), at


@functools.lru_cache(maxsize=8)
def _pdf_pages_text(path, mtime):
    pymupdf = settings.require_pymupdf()
    with pymupdf.open(path) as doc:
        return [re.sub(r"\s+", " ", re.sub(r"[-­‐]\n", "", pg.get_text())) for pg in doc]


def source_pdf_find(vault, rel, q):
    """Every place `q` occurs in a confined source PDF: [{page (1-based), snippet}]."""
    p = source_pdf_path(vault, rel)
    if not p:
        return {"error": "source PDF not found"}
    qk, _ = _find_key(q or "")
    qk = qk.strip()
    if len(qk) < 2:
        return {"hits": [], "pages": 0}
    try:
        pages = _pdf_pages_text(str(p), p.stat().st_mtime)
    except Exception as e:
        return {"error": f"could not read the PDF: {e}"}
    hits = []
    for n, text in enumerate(pages, 1):
        key, at = _find_key(text)
        i = key.find(qk)
        while i >= 0 and len(hits) < 300:
            a, b = at[i], at[i + len(qk) - 1] + 1
            s0, s1 = max(0, a - 70), min(len(text), b + 70)
            hits.append({"page": n, "before": ("…" if s0 else "") + text[s0:a],
                         "match": text[a:b], "after": text[b:s1] + ("…" if s1 < len(text) else "")})
            i = key.find(qk, i + 1)
    return {"hits": hits, "pages": len(pages)}


def cite_pdf_target(vault, rel, page):
    p = _source_ok(vault, rel)
    if p is None:
        return {"error": "not a readable source note"}
    text = (_read(p) or "").replace("\r\n", "\n")
    try:
        printed = int(re.sub(r"[^\d]", "", str(page)) or "0")
    except ValueError:
        printed = 0
    links = _pdfref_links(text)
    # canonical PDF: frontmatter pdf-path, else the most-referenced link target (resolved
    # under Corpus/ when the link carries only a bare filename).
    pdf_fm = _fm_value(text, "pdf-path")
    pdf_rel = pdf_fm
    if not pdf_rel and links:
        cand = links[0]["pdf"]
        pdf_rel = cand if "/" in cand else ("Preparation/Reading/Corpus/" + cand)
    physical, selection, quote, exact = printed, "", "", False
    if printed and links:
        hit = next((l for l in links if l["printedStart"] <= printed <= l["printedEnd"]), None)
        if hit:
            physical, selection, exact = hit["physical"], hit["selection"], True
            quote = _quote_after(text, hit["linkEnd"])
        else:
            offs = sorted(l["physical"] - l["printedStart"] for l in links)
            off = offs[len(offs) // 2]            # median offset (front-matter pages)
            physical = max(1, printed + off)
    pdfp = source_pdf_path(vault, pdf_rel) if pdf_rel else None
    return {"ok": True, "pdfRel": _rel(vault, pdfp) if pdfp else (pdf_rel or ""),
            "pdfExists": pdfp is not None, "physicalPage": physical,
            "printedPage": printed, "selection": selection, "quote": quote,
            "exact": exact, "noteRel": _rel(vault, p)}


def read_embed(vault, slug, name):
    ref = (name or "").replace("\\", "/").strip() if isinstance(name, str) else ""
    stem = re.sub(r"\.(md|csv|txt|pdf)$", "", ref, flags=re.I)
    if not stem or ".." in stem or "\x00" in stem or stem.startswith("/"):
        return {"error": "not found"}
    pdf = _find_asset(vault, slug, stem + ".pdf")
    csv = _find_asset(vault, slug, stem + ".csv")
    have_pdf = bool(pdf and pdf.suffix.lower() == ".pdf" and pdf.is_file())
    have_csv = bool(csv and csv.suffix.lower() == ".csv" and csv.is_file())
    typeset_pdf = stem + ".pdf" if (have_pdf or have_csv) else None
    p = None
    for ext in (".md", ".csv", ".txt"):
        cand = _find_asset(vault, slug, stem + ext)
        if cand and cand.suffix.lower() == ext and cand.is_file():
            p = cand
            break
    if p is None and typeset_pdf is None:
        return {"error": "not found"}
    return {"text": (_read(p) or "") if p else "", "name": (ref if p else stem + ".pdf"),
            "typesetPdf": typeset_pdf}


_DIAGRAM_XML_MAX = 4_000_000     # a hand diagram's mxfile runs a few KB
_DIAGRAM_PNG_MAX = 40_000_000


def _diagram_stem(name):
    stem = re.sub(r"\.(drawio|png|svg)$", "", os.path.basename((name or "").strip()), flags=re.I)
    if not stem or ".." in stem:
        return None
    return stem


def _next_fig_stem(proj, title):
    n = 0
    results = proj / "results"
    for d in (results, results / "supplementary"):
        if not d.is_dir():
            continue
        try:
            names = [f.name for f in d.iterdir()]
        except OSError:
            names = []
        for fname in names:
            m = re.match(r"^fig\.?(\d+)\.", fname, re.I)
            if m:
                try:
                    n = max(n, int(m.group(1)))
                except ValueError:
                    pass
    slug = re.sub(r"[^a-z0-9]+", "-", (title or "").lower()).strip("-")[:48] or "diagram"
    for k in range(n + 1, n + 100):
        stem = "fig.%02d.%s" % (k, slug)
        if not ((results / (stem + ".drawio")).exists() or (results / (stem + ".png")).exists()):
            return stem
    return "fig.%02d.%s" % (n + 1, slug)


def read_diagram(vault, slug, name):
    proj = _project_dir(vault, slug)
    if not proj:
        return {"error": "unknown paper"}
    stem = _diagram_stem(name)
    if not stem:
        return {"error": "bad name"}
    f = _result_file(proj / "results", stem, "drawio")
    if not f:
        return {"ok": True, "stem": stem, "xml": "", "mtime": 0}
    try:
        return {"ok": True, "stem": stem, "xml": f.read_text(encoding="utf-8"), "mtime": _mt(f)}
    except OSError:
        return {"error": "diagram unreadable"}


def _write_bytes_atomic(p, data):
    import tempfile
    p.parent.mkdir(parents=True, exist_ok=True)
    fd, tmppath = tempfile.mkstemp(dir=str(p.parent), prefix="." + p.stem + ".", suffix=p.suffix + ".tmp")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            try:
                os.fsync(f.fileno())
            except OSError:
                pass
        os.replace(tmppath, str(p))
    except OSError:
        try:
            os.unlink(tmppath)
        except OSError:
            pass
        raise


def save_diagram(vault, slug, name, title, xml, png_data_url, base_mtime=None, force=False):
    proj = _project_dir(vault, slug)
    if not proj:
        return {"error": "unknown paper"}
    xml = xml or ""
    if "<mxfile" not in xml and "<mxGraphModel" not in xml:
        return {"error": "not a draw.io diagram"}
    if len(xml) > _DIAGRAM_XML_MAX:
        return {"error": "diagram XML too large"}
    m = re.match(r"^data:image/png;base64,(.+)$", png_data_url or "", re.S)
    if not m:
        return {"error": "no png export"}
    import base64
    import binascii
    try:
        png = base64.b64decode(m.group(1), validate=True)
    except (binascii.Error, ValueError):
        return {"error": "bad png data"}
    if not png.startswith(b"\x89PNG\r\n\x1a\n") or len(png) > _DIAGRAM_PNG_MAX:
        return {"error": "bad png data"}
    results = proj / "results"
    if name:
        stem = _diagram_stem(name)
        if not stem or not stem.lower().startswith("fig"):
            return {"error": "bad name"}   # diagram saves stay in the figure namespace
    else:
        stem = _next_fig_stem(proj, title)
    dio = _result_file(results, stem, "drawio") or (results / (stem + ".drawio"))
    if dio.exists() and base_mtime is not None and not force and _mt(dio) != int(base_mtime):
        return {"conflict": True, "currentMtime": _mt(dio), "stem": stem}
    if dio.exists():
        try:
            bdir = results / ".diagram-backups"
            bdir.mkdir(exist_ok=True)
            ts = time.strftime("%Y%m%d-%H%M%S")
            (bdir / (stem + "." + ts + ".drawio")).write_bytes(dio.read_bytes())
            for f in sorted(bdir.glob(stem + ".*.drawio"))[:-20]:
                try:
                    f.unlink()
                except OSError:
                    pass
        except OSError:
            pass
    try:
        _write_bytes_atomic(dio, xml.encode("utf-8"))
        _write_bytes_atomic(dio.with_suffix(".png"), png)
    except OSError as e:
        return {"error": "write failed: %s" % e}
    try:
        manifest = _load_provenance(results)
        entry = manifest.get(stem) if isinstance(manifest.get(stem), dict) else {}
        entry = dict(entry or {})
        for k in ("script", "commit", "environment", "sessionId", "dataSources"):
            entry.pop(k, None)   # the asset is hand-drawn now; a past script no longer produced it
        sha = entry.get("outputSha256") if isinstance(entry.get("outputSha256"), dict) else {}
        sha = dict(sha or {})
        sha.pop("svg", None)
        sha["png"] = hashlib.sha256(png).hexdigest()
        sha["drawio"] = hashlib.sha256(xml.encode("utf-8")).hexdigest()
        entry.update({
            "kind": "external",
            "generated": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "generatedBy": "drawio-editor",
            "manualNote": "Concept diagram drawn by hand in the Drafting view's draw.io editor. "
                          "Editable source: results/" + stem + ".drawio "
                          "(reopen via the figure's Edit-diagram button).",
            "verified": True,
            "outputSha256": sha,
        })
        manifest[stem] = entry
        _write_bytes_atomic(results / "provenance.json",
                            json.dumps(manifest, indent=2, ensure_ascii=False).encode("utf-8"))
    except OSError:
        pass   # the drawing is saved; a failed provenance write must not lose it
    return {"ok": True, "stem": stem, "mtime": _mt(dio), "png": stem + ".png"}


# ----------------------------------------------------------------- atomic write
def _prune_backups(bdir, label, keep=40):
    try:
        files = sorted(bdir.glob(label + ".*.md"))
    except OSError:
        return
    for f in files[:-keep]:
        try:
            f.unlink()
        except OSError:
            pass


def _backups_dir(p):
    """<project>/writing/.writing-backups for any file in a project, wherever it sits
    (project root, results/, writing/ or below), so no backup folder lands beside it."""
    p = Path(p).resolve()
    for a in p.parents:
        if a.parent.name in ("papers", "grants", "briefs", "letters", "experiments") and a.parent.parent.name == "Projects":
            return a / "writing" / ".writing-backups"
    for a in p.parents:
        if a.name == "writing":
            return a / ".writing-backups"
    return p.parent / ".writing-backups"


def _atomic_write(p, old, text, label="draft"):
    """Backup the previous content (ms-stamped, never colliding), then write to a
    UNIQUE temp file (fsync'd) and os.replace — so a failed or concurrent write can
    never leave the file half-written or two writers clobber one .tmp path."""
    p.parent.mkdir(parents=True, exist_ok=True)
    if old is not None:
        bdir = _backups_dir(p)
        try:
            bdir.mkdir(parents=True, exist_ok=True)
            ts = time.strftime("%Y%m%d-%H%M%S-") + str(int(time.time() * 1000) % 1000).zfill(3)
            (bdir / (label + "." + ts + ".md")).write_text(old, encoding="utf-8")
            _prune_backups(bdir, label, keep=200)
        except OSError:
            pass
    import tempfile
    fd, tmppath = tempfile.mkstemp(dir=str(p.parent), prefix="." + label + ".", suffix=".md.tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
            f.flush()
            try:
                os.fsync(f.fileno())
            except OSError:
                pass
        os.replace(tmppath, str(p))
    except OSError:
        try:
            os.unlink(tmppath)
        except OSError:
            pass
        raise


# ----------------------------------------------------------------- paper parsing
_HEADING = re.compile(r"^(#{2,3})\s+(.*?)\s*$")


def parse_paper(text):
    events, buf = [], []

    def flush():
        if buf:
            para = " ".join(x.strip() for x in buf).strip()
            if para:
                events.append(("para", para))
            buf.clear()

    for raw in (text or "").split("\n"):
        ln = raw.rstrip()
        h = _HEADING.match(ln)
        if h:
            flush()
            events.append(("h" + str(len(h.group(1))), h.group(2).strip()))
            continue
        if not ln.strip():
            flush()
            continue
        buf.append(ln)
    flush()
    return events


_PLACEHOLDER = re.compile(r"^<!--\s*¶\s*(.*?)\s*-->$", re.S)


def placeholder_label(para):
    """The label of a `<!--¶ ... -->` placeholder paragraph, or None if it isn't one."""
    m = _PLACEHOLDER.match((para or "").strip())
    return (m.group(1).strip() if m else None) if m else None


def _is_slot_para(para):
    s = para.strip()
    if not s:
        return False
    if s.startswith("<!--"):
        return False
    if re.fullmatch(r"-{3,}", s):
        return False
    return True


_YEAR = r"(?:1[6-9]\d\d|20\d\d)"


def extract_cites(para):
    out, seen = [], set()

    def add(name, year):
        name = (name or "").strip().rstrip(",").strip()
        if not name:
            return
        token = name + " " + year
        key = token.lower()
        if key not in seen:
            seen.add(key)
            out.append(token)

    for grp in re.findall(r"\(([^()]+)\)", para):
        if not re.search(r"\b" + _YEAR + r"\b", grp):
            continue
        for part in grp.split(";"):
            m = re.search(r"^(.*?)\s+(" + _YEAR + r"[a-z]?)\b", part.strip())
            if m and re.search(r"[A-Za-z]", m.group(1)):   # need an author, not a bare year/page
                add(m.group(1), m.group(2))
    for m in re.finditer(
            r"([A-Z][\w'’.\-]+(?:(?:,| and| &| et al\.)[\w'’.\- ]*?)?)\s+\(("
            + _YEAR + r"[a-z]?(?:,\s*" + _YEAR + r"[a-z]?)*)\)", para):
        for yr in re.findall(_YEAR + r"[a-z]?", m.group(2)):
            add(m.group(1), yr)
    return out


def cited_pairs(text):
    pairs = set()
    for tok in extract_cites(text or ""):
        m = re.match(r"^(.*?)\s+(" + _YEAR + r")", tok)
        if m:
            surname = re.split(r"[,\s]+", m.group(1).strip())[0].lower()
            pairs.add((surname, m.group(2)))
    return pairs


def _fingerprint(para):
    words = re.findall(r"[A-Za-z0-9']+", para.lower())
    return " ".join(words[:6])[:48]


_PARA_MARK = re.compile(r"^\*\*¶(\d+)\*\*\s*(?:<!--\s*fp:\s*(.*?)\s*-->)?\s*$")


def parse_editor(text):
    by_fp, by_pos = {}, {}
    h2 = h3 = ""
    ordinal = 0
    cur = None

    def commit():
        nonlocal cur
        if cur is not None:
            rec = {"point": cur["point"].strip("\n"), "note": cur["note"].strip("\n"),
                   "sources": cur["sources"].strip("\n")}
            if cur["fp"]:
                by_fp[cur["fp"]] = rec
            by_pos[(cur["h2"], cur["h3"], cur["ord"])] = rec
            cur = None

    for raw in (text or "").split("\n"):
        h = _HEADING.match(raw)
        if h:
            commit()
            if len(h.group(1)) == 2:
                h2, h3 = h.group(2).strip(), ""
            else:
                h3 = h.group(2).strip()
            ordinal = 0
            continue
        pm = _PARA_MARK.match(raw)
        if pm:
            commit()
            ordinal += 1
            cur = {"fp": (pm.group(2) or "").strip(), "h2": h2, "h3": h3,
                   "ord": ordinal, "field": None, "point": "", "note": "", "sources": ""}
            continue
        if cur is None:
            continue
        if re.match(r"^cites:\s*", raw):
            cur["field"] = "cites"
            continue
        ptm = re.match(r"^point:\s?(.*)$", raw)
        if ptm:
            cur["field"] = "point"
            cur["point"] = ptm.group(1)
            continue
        nm = re.match(r"^note:\s?(.*)$", raw)
        if nm:
            cur["field"] = "note"
            cur["note"] = nm.group(1)
            continue
        sm = re.match(r"^sources:\s?(.*)$", raw)
        if sm:
            cur["field"] = "sources"
            cur["sources"] = sm.group(1)
            continue
        if cur["field"] == "note":
            cur["note"] += "\n" + raw
        elif cur["field"] == "sources":
            cur["sources"] += "\n" + raw
        elif cur["field"] == "point":
            cur["point"] += "\n" + raw
    commit()
    return by_fp, by_pos


def build_skeleton(paper_text, existing=None, title=None):
    by_fp, by_pos = parse_editor(existing) if existing else ({}, {})
    consumed = set()    # id() of rec dicts attached to a current paragraph
    out = []
    if title:
        out += ["# " + title + " — editor", ""]
    out += ["> Planning + citations, paragraph by paragraph. Headings and `cites:` "
            "regenerate from paper.md; your `note:` and `sources:` lines are kept "
            "across syncs. Edit here or in Obsidian.", ""]
    h2 = h3 = ""
    ordinal = 0
    for kind, val in parse_paper(paper_text):
        if kind == "h2":
            h2, h3, ordinal = val, "", 0
            out += ["## " + val, ""]
        elif kind == "h3":
            h3, ordinal = val, 0
            out += ["### " + val, ""]
        elif kind == "para":
            if not (h2 or h3):       # head matter (title/author) before the first section
                continue
            if not _is_slot_para(val):
                continue
            ordinal += 1
            fp = _fingerprint(val)
            rec = by_fp.get(fp)
            if rec is None:
                rec = by_pos.get((h2, h3, ordinal))
            if rec is not None:
                consumed.add(id(rec))
            else:
                rec = {"point": "", "note": "", "sources": ""}
            cites = "; ".join(extract_cites(val))
            out.append("**¶" + str(ordinal) + "**" + (" <!--fp:" + fp + "-->" if fp else ""))
            out.append("cites: " + cites)
            out.append("point: " + (rec.get("point") or ""))
            out.append("note: " + (rec.get("note") or ""))
            out.append("sources:")
            if rec.get("sources"):
                out.append(rec["sources"])
            out.append("")

    # Preserve planning whose paragraph was removed/reworded so a cut-and-paste never
    # silently destroys it. They land in a clearly-labelled section to re-home.
    orphans, seen = [], set()
    for rec in list(by_fp.values()) + list(by_pos.values()):
        if id(rec) in consumed or id(rec) in seen:
            continue
        seen.add(id(rec))
        if (rec.get("point") or "").strip() or (rec.get("note") or "").strip() or (rec.get("sources") or "").strip():
            orphans.append(rec)
    if orphans:
        out += ["## (Unattached planning)", "",
                "> Notes whose paragraph was removed or reworded. Restore the paragraph "
                "to re-attach, or move these notes where they belong.", ""]
        for i, rec in enumerate(orphans, 1):
            out.append("**¶" + str(i) + "**")
            out.append("cites: ")
            out.append("point: " + (rec.get("point") or ""))
            out.append("note: " + (rec.get("note") or ""))
            out.append("sources:")
            if rec.get("sources"):
                out.append(rec["sources"])
            out.append("")
    return "\n".join(out).rstrip() + "\n"


STATUS_FILE = settings.STATE_DIR / "drafting-status.json"
STATUSES = {"idea", "draft", "under_review", "published"}


def _load_statuses():
    try:
        return json.loads(STATUS_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _atomic_write_json(p, obj):
    tmp = Path(str(p) + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(str(tmp), str(p))


def get_status(key):
    return _load_statuses().get(key, "draft")


def set_status(key, status):
    if status not in STATUSES:
        return {"error": "bad status"}
    statuses = _load_statuses()
    if status == "draft":
        statuses.pop(key, None)   # draft is the implicit default -- nothing to store
    else:
        statuses[key] = status
    _atomic_write_json(STATUS_FILE, statuses)
    return {"ok": True, "key": key, "status": status}


# the required section headers, in contract order (parsed literally)
README_SECTIONS = [
    "Core Idea", "Research Question", "Rival Answers", "Hypotheses", "Data",
    "Measures & Variables", "Testing Plan", "Result Catalogue",
    "Expected Contribution", "Target", "Open Questions",
    "Documentation Checklist", "Status",
]
_STAGE_MARKER_RE = re.compile(r"<!--\s*(STAGE:[A-Z0-9_:]+)")

_README_TEMPLATE = """# {title}

## Core Idea
{idea}

## Research Question
_pending_

## Rival Answers
_pending_

## Hypotheses
_pending_

## Data
_pending_

## Measures & Variables
_pending_

## Testing Plan
_pending_

## Result Catalogue
_pending_

## Expected Contribution
_pending_

## Target
_pending_

## Open Questions
_pending_

## Documentation Checklist
- [ ] Core idea states a specific tension, not a topic
- [ ] Research question locked
- [ ] Two rival answers, each at full strength
- [ ] Hypotheses are specific and testable
- [ ] Data section names datasets, paths, waves, N, weights
- [ ] Measures Ledger complete in logs/measures.md for every analytic variable
- [ ] Testing plan: claims ranked; specs and script manifest in logs/testing_plan.md
- [ ] Result catalogue current, one line per finding, logs/ notes linked
- [ ] Expected contribution stated
- [ ] Target journal candidates named
- [ ] numbers.json binds every cited statistic (checker passes)
- [ ] logs/INDEX.md current

## Status
_No stage complete yet._
"""


_BRIEF_README_TEMPLATE = """# {title}

## Core Idea
{idea}

## The Data
_Which dataset(s), wave(s), N, weights — the evidence base this rests on._

## The Question
_What this {noun} answers, in one line._

## What to Show
_The few figures / tables this {noun} will carry (one line each)._

## Key Findings
_pending_

## Deliverable & Target
{target}

## Open Questions
_pending_

## Status
_No draft yet._
"""

_REPORT_MD_STUB = """---
title: {title}
format: {fmt}
preview:
---

"""

_GRANT_README_NOTE = (
    "<!-- Grant project: the funder ruleset lives in rules/compliance.json. -->\n\n"
)

_BRIEF_META = {
    "brief":  {"noun": "brief", "target": "_A charts-first brief._"},
    "report": {"noun": "report", "target": "_A prose-first long read._"},
}
NEW_PROJECT_KINDS = {
    "paper":  {"base": "papers", "prefix": True,  "open": "readme.md", "dirs": (),
               "report": None,
               "hint": "papers/" + PREFIX + "<title>/ with README.md + logs/"},
    "grant":  {"base": "grants", "prefix": True,  "open": "readme.md",
               "dirs": ("rules", "corpus"), "report": None,
               "hint": "grants/" + PREFIX + "<title>/ with README.md + rules/ + corpus/ + logs/"},
    "brief":  {"base": "briefs", "prefix": False, "open": "readme.md",
               "dirs": ("results", "replication/output"), "report": "prof-brief",
               "hint": "briefs/<title>/ with README.md + writing/report.md + logs/"},
    "report": {"base": "briefs", "prefix": False, "open": "readme.md",
               "dirs": ("results", "replication/output"), "report": "long-report",
               "hint": "briefs/<title>/ with README.md + writing/report.md + logs/"},
    "letter": {"base": "letters", "prefix": False, "open": "readme.md", "dirs": (),
               "report": None, "main": "letter.md",
               "hint": "letters/<title>/ with README.md + writing/letter.md + logs/"},
}

# A letter's README: the facts the letter is written against, nothing more.
_LETTER_README_TEMPLATE = """# {title}

## Who and What
{idea}

## Deadline
_pending_

## How to Submit
_pending_
"""

_LETTER_MD_STUB = """---
title: {title}
publish: rec-letter
---

"""


def _readme_split_sections(text):
    """{header: body} over '## ' headings; '#preamble' holds anything before the
    first section (the H1 title line included)."""
    out = {}
    cur = "#preamble"
    buf = []
    for line in (text or "").split("\n"):
        m = re.match(r"^##\s+(.+?)\s*$", line)
        if m:
            out[cur] = "\n".join(buf).strip()
            cur = m.group(1)
            buf = []
        else:
            buf.append(line)
    out[cur] = "\n".join(buf).strip()
    return out


def readme_status(vault, slug):
    """Section-by-section completeness of the project README against the contract,
    plus stage markers, the self-tracking checklist, and the legacy-PLAN flag —
    feeds the planning workspace's live checklist."""
    proj = _project_dir(vault, slug)
    if not proj:
        return {"error": "unknown paper"}
    p = proj / "README.md"
    if not p.is_file():
        return {"slug": slug, "exists": False, "sections": [], "markers": [],
                "checklist": [], "legacyPlan": (proj / "replication" / "PLAN.md").is_file()}
    txt = _read(p) or ""
    secs = _readme_split_sections(txt)
    rows = []
    for name in README_SECTIONS:
        body = secs.get(name)
        present = body is not None
        pending = bool(present and (not body or re.fullmatch(r"_?pending_?\.?", body.strip(), re.IGNORECASE)))
        words = _wordcount(body or "") if present and not pending else 0
        rows.append({"name": name, "present": present, "pending": pending or (present and words < 8),
                     "words": words})
    checklist = []
    for line in (secs.get("Documentation Checklist") or "").split("\n"):
        m = re.match(r"^\s*-\s*\[( |x|X)\]\s*(.+)$", line)
        if m:
            checklist.append({"done": m.group(1).lower() == "x", "text": m.group(2).strip()})
    markers = list(dict.fromkeys(_STAGE_MARKER_RE.findall(txt)))
    return {"slug": slug, "exists": True, "rel": _rel(vault, p), "mtime": _mt(p),
            "sections": rows, "markers": markers, "checklist": checklist,
            "legacyPlan": (proj / "replication" / "PLAN.md").is_file()}


def list_logs(vault, slug):
    proj = _project_dir(vault, slug)
    if not proj:
        return {"error": "unknown paper"}
    ldir = proj / "logs"
    entries = []
    if ldir.is_dir():
        try:
            for f in ldir.iterdir():
                if not f.is_file() or f.name.startswith("."):
                    continue
                ext = f.suffix.lower()
                if ext not in (".md", ".log", ".err", ".txt"):
                    continue
                entries.append({
                    "name": f.name, "path": "logs/" + f.name, "rel": _rel(vault, f),
                    "mtime": _mt(f), "size": f.stat().st_size,
                    "kind": ("index" if f.name == "INDEX.md"
                             else "questions" if f.name == "QUESTIONS.md"
                             else "criticism" if f.name == "criticism.md"
                             else "robustness" if f.name == "robustness.md"
                             else "memo" if ext == ".md" else "run"),
                })
        except OSError:
            pass
    entries.sort(key=lambda e: (-{"index": 2, "questions": 1}.get(e["kind"], 0), -e["mtime"]))
    return {"slug": slug, "exists": ldir.is_dir(), "logs": entries}


def _slug_from_title(title):
    s = re.sub(r"[^a-z0-9 \-]", "", (title or "").lower()).strip()
    s = re.sub(r"\s+", " ", s)
    return s


_OUTLINES_REL = (*Path(_TOOLKIT_REL).parts, "templates", "outlines.json")
_OUTLINES_FALLBACK = {
    "paper": [(2, "Introduction"), (2, "Background"), (2, "Data and Methods"),
              (2, "Results"), (2, "Discussion"), (2, "References")],
    "report": [(1, "Key findings"), (1, "Background"), (1, "Analysis"), (1, "Implications")],
    "proposal": [(2, "Summary"), (2, "Background"), (2, "Aims"), (2, "Approach"),
                 (2, "Timeline"), (2, "References")],
    "dissertation": [(2, "Introduction"), (2, "Background"), (2, "Chapters"),
                     (2, "Conclusion"), (2, "References")],
    "extended-abstract": [(2, "Abstract"), (2, "Background"), (2, "Data and Methods"),
                          (2, "Preliminary Findings"), (2, "References")],
    "oped": [],
    "reviewer-response": [(2, "Editor"), (2, "Reviewer 1"), (2, "Reviewer 2")],
    "appendix": [],
    "letter": [(2, "Context"), (2, "Evidence"), (2, "Comparison"), (2, "Recommendation")],
}
# which outline a new project's main document starts from
_PROJECT_OUTLINE = {"paper": "paper", "grant": "proposal", "brief": "report", "report": "report",
                    "letter": "letter"}
# a new document whose FILE NAME is exactly one of these takes that outline when the
# caller names no kind; any other name (an instant untitled page above all) stays blank
_OUTLINE_BY_DOCNAME = {"paper.md": "paper", "report.md": "report", "proposal.md": "proposal",
                       "letter.md": "letter",
                       "dissertation.md": "dissertation", "oped.md": "oped",
                       "extended-abstract.md": "extended-abstract"}
_OUTLINES_MEMO = {}          # path -> (mtime_ns, {key: [(level, heading), ...]})
_OUTLINES_MEMO_LOCK = threading.Lock()


def _outlines_path(vault=None):
    if vault is None:
        return _PROJECTS_ROOT.parent.joinpath(*_OUTLINES_REL)
    return Path(vault).joinpath(*_OUTLINES_REL)


def _outline_key(kind):
    return (kind or "").strip().lower().replace("_", "-") if isinstance(kind, str) else ""


def _parse_outlines(raw):
    """{key: [(level, heading), ...]} from the JSON text. A key whose list is not
    well-formed is dropped (the built-in copy then answers for it); raises ValueError
    only when the file as a whole is not a JSON object."""
    data = json.loads(raw)
    if not isinstance(data, dict):
        raise ValueError("outlines.json is not an object")
    out = {}
    for key, rows in data.items():
        k = _outline_key(key)
        if not k or k.startswith("-") or not isinstance(rows, list):
            continue
        clean = []
        for row in rows:
            if (not isinstance(row, (list, tuple)) or len(row) != 2
                    or isinstance(row[0], bool) or row[0] not in (1, 2, 3)
                    or not isinstance(row[1], str)):
                clean = None
                break
            head = " ".join(row[1].split()).lstrip("#").strip()
            if not head:
                clean = None
                break
            clean.append((int(row[0]), head))
        if clean is not None:
            out[k] = clean
    return out


def _load_outlines(vault=None):
    merged = dict(_OUTLINES_FALLBACK)
    try:
        p = _outlines_path(vault)
        key = str(p)
        mt = p.stat().st_mtime_ns
        with _OUTLINES_MEMO_LOCK:
            hit = _OUTLINES_MEMO.get(key)
        if hit and hit[0] == mt:
            loaded = hit[1]
        else:
            try:
                loaded = _parse_outlines(p.read_text(encoding="utf-8"))
            except (OSError, ValueError, TypeError, RecursionError):
                loaded = {}
            with _OUTLINES_MEMO_LOCK:
                _OUTLINES_MEMO[key] = (mt, loaded)
        merged.update(loaded)
    except Exception:
        pass
    return merged


def _outline_known(kind, vault=None):
    return _outline_key(kind) in _load_outlines(vault)


def _outline_rows(kind, vault=None):
    return list(_load_outlines(vault).get(_outline_key(kind)) or [])


def _outline_block(rows):
    """The headings as document text: one heading line, one blank line, repeated."""
    return "".join("%s %s\n\n" % ("#" * lvl, head) for lvl, head in rows)


def _starter_outline(kind, title, vault=None):
    t = " ".join((title or "").split()) or "Untitled"
    rows = _outline_rows(kind, vault)
    if any(lvl == 1 for lvl, _ in rows):
        return "---\ntitle: %s\n---\n\n%s" % (t, _outline_block(rows))
    return "# %s\n\n%s" % (t, _outline_block(rows))


def create_project(vault, title, idea="", kind="paper"):
    kind = (kind or "paper").strip().lower()
    spec = NEW_PROJECT_KINDS.get(kind)
    if not spec:
        return {"error": "unknown project type"}
    slug = _slug_from_title(title)
    if not slug or len(slug) < 3:
        return {"error": "give the project a real title"}
    root = (vault / "Projects" / spec["base"]).resolve()
    folder = (PREFIX + slug) if spec["prefix"] else slug
    d = (root / folder).resolve()
    try:
        d.relative_to(root)
    except ValueError:
        return {"error": "bad title"}
    if d.exists():
        return {"error": "a %s with that name already exists" % kind}
    title_s = (title or slug).strip()
    idea_s = (idea or "").strip() or "_pending_"
    try:
        (d / "logs").mkdir(parents=True)
        (d / "writing").mkdir()
        for sub in spec["dirs"]:
            (d / sub).mkdir(parents=True, exist_ok=True)
        if kind == "grant":
            readme = _GRANT_README_NOTE + _README_TEMPLATE.format(title=title_s, idea=idea_s)
        elif kind == "letter":
            readme = _LETTER_README_TEMPLATE.format(title=title_s, idea=idea_s)
        elif kind in _BRIEF_META:
            m = _BRIEF_META[kind]
            readme = _BRIEF_README_TEMPLATE.format(
                title=title_s, idea=idea_s, noun=m["noun"], target=m["target"])
        else:
            readme = _README_TEMPLATE.format(title=title_s, idea=idea_s)
        _atomic_write(d / "README.md", None, readme, label="readme")
        if spec["report"]:
            # the functional frontmatter (title / format / preview), then the report
            # outline: headings only, the title stays in the frontmatter
            stub = (_REPORT_MD_STUB.format(title=title_s, fmt=spec["report"])
                    + _outline_block(_outline_rows(_PROJECT_OUTLINE[kind], vault)))
            _atomic_write(d / "writing" / "report.md", None, stub, label="report")
        _atomic_write(d / "logs" / "INDEX.md", None,
                      "# Log Index\n\n(one line per exploration, newest first)\n", label="log")
        _atomic_write(d / "logs" / "QUESTIONS.md", None,
                      "# Question Register\n\n## Open\n\n## Answered\n\n## Not Pursued\n", label="log")
        if spec.get("main") == "letter.md":
            stub = (_LETTER_MD_STUB.format(title=title_s)
                    + _outline_block(_outline_rows(_PROJECT_OUTLINE[kind], vault)))
            _atomic_write(d / "writing" / "letter.md", None, stub, label="letter")
        elif not spec["report"]:
            starter = _starter_outline(_PROJECT_OUTLINE.get(kind, "paper"), title_s, vault)
            _atomic_write(d / "writing" / "paper.md", None, starter, label="paper")
    except OSError as e:
        return {"error": "could not create the project: %s" % e}
    return {"ok": True, "slug": slug, "kind": kind, "base": spec["base"], "doc": spec["open"]}


def scaffold_project(vault, slug):
    """Grow a README-first project into the full workflow layout (replication/,
    results/, corpus/) once it graduates from planning — pure mkdirs, never
    touches existing files."""
    proj = _project_dir(vault, slug)
    if not proj:
        return {"error": "unknown paper"}
    made = []
    for rel in ("replication/data", "replication/output", "replication/archive",
                "replication/utilities", "results/supplementary", "corpus/pdfs",
                "writing/versioning", "logs"):
        p = proj / rel
        if not p.is_dir():
            try:
                p.mkdir(parents=True)
                made.append(rel)
            except OSError:
                pass
    return {"ok": True, "slug": slug, "created": made}


_ARCHIVE_MODES = {"stalled": "stalled - ", "complete": "complete - "}


def list_archived(vault):
    root = vault / "Projects" / "papers" / "archive"
    out = []
    if root.is_dir():
        try:
            for d in sorted(root.iterdir()):
                if not d.is_dir() or d.name.startswith("."):
                    continue
                mode, label = "other", d.name
                for m, pfx in _ARCHIVE_MODES.items():
                    if d.name.lower().startswith(pfx):
                        mode, label = m, d.name[len(pfx):]
                        break
                if PREFIX and d.name.lower().startswith(PREFIX.lower()):
                    mode, label = "stalled", d.name[len(PREFIX):]
                out.append({"name": d.name, "label": label, "mode": mode, "mtime": _mt(d)})
        except OSError:
            pass
    return {"archived": out}


def archive_project(vault, slug, mode):
    if mode not in _ARCHIVE_MODES:
        return {"error": "mode must be stalled or complete"}
    proj = _project_dir(vault, slug)
    if not proj:
        return {"error": "unknown paper"}
    root = vault / "Projects" / "papers" / "archive"
    dst = root / (_ARCHIVE_MODES[mode] + slug)
    if dst.exists():
        return {"error": "an archived project with that name already exists"}
    try:
        root.mkdir(exist_ok=True)
        os.rename(str(proj), str(dst))
    except OSError as e:
        return {"error": "could not archive: %s" % e}
    return {"ok": True, "slug": slug, "mode": mode, "name": dst.name}


def restore_project(vault, name):
    """Bring an archived project back to papers/<prefix><slug>."""
    root = (vault / "Projects" / "papers" / "archive").resolve()
    name = (name or "").strip()
    if not name or "/" in name or "\\" in name or ".." in name:
        return {"error": "bad name"}
    src = root / name
    if not src.is_dir():
        return {"error": "not found in the archive"}
    label = name
    for pfx in list(_ARCHIVE_MODES.values()) + ([PREFIX.lower()] if PREFIX else []):
        if label.lower().startswith(pfx):
            label = label[len(pfx):]
            break
    dst = vault / "Projects" / "papers" / (PREFIX + label)
    if dst.exists():
        return {"error": "a live project with that name already exists"}
    try:
        os.rename(str(src), str(dst))
    except OSError as e:
        return {"error": "could not restore: %s" % e}
    return {"ok": True, "slug": label}


FLAGS_FILE = settings.STATE_DIR / "drafting-flags.json"


def _load_flags():
    try:
        return json.loads(FLAGS_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def set_pin(key, pinned):
    if not key:
        return {"error": "bad key"}
    flags = _load_flags()
    if pinned:
        flags[key] = True
    else:
        flags.pop(key, None)
    _atomic_write_json(FLAGS_FILE, flags)
    return {"ok": True, "key": key, "pinned": bool(pinned)}


IDS_FILE = settings.STATE_DIR / "drafting-ids.json"   # slug -> folder inode
_KEYS_LOCK = threading.Lock()


def _reconcile_keys(vault):
    live = {}
    for tree in ("papers", "grants"):
        root = vault / "Projects" / tree
        if root.is_dir():
            for d in root.iterdir():
                if d.is_dir() and settings.live_slug(d.name):
                    live[settings.live_slug(d.name)] = d
    ino = {}
    for slug, d in live.items():
        try:
            ino[slug] = os.stat(d).st_ino
        except OSError:
            pass
    slug_of_ino = {v: k for k, v in ino.items()}

    def primary(slug):
        w = live[slug] / "writing"
        for docname, meta in DOC_KINDS.items():
            if meta.get("base", "papers") == "papers" and (w / docname).exists():
                return docname
        return None

    with _KEYS_LOCK:
        try:
            known = json.loads(IDS_FILE.read_text(encoding="utf-8"))
        except Exception:
            known = {}
        moved = {old: slug_of_ino[i] for old, i in known.items()
                 if old not in live and i in slug_of_ino}
        for path, load in ((FLAGS_FILE, _load_flags), (STATUS_FILE, _load_statuses)):
            data = load()
            keep, remap = {}, {}
            for k, v in data.items():
                parts = k.split(":", 2)
                if len(parts) != 3 or parts[0] != "paper":
                    keep[k] = v
                    continue
                slug, doc = moved.get(parts[1], parts[1]), parts[2]
                if doc == "readme.md" and slug in live:
                    doc = primary(slug) or doc
                nk = "paper:%s:%s" % (slug, doc)
                (keep if nk == k else remap)[nk] = v
            if remap:
                for nk, v in remap.items():
                    keep.setdefault(nk, v)   # a key already set under the new name wins
                _atomic_write_json(path, keep)
        known_now = {k: v for k, v in known.items() if k not in live and k not in moved}
        known_now.update(ino)
        if known_now != known:
            _atomic_write_json(IDS_FILE, known_now)


def _home_form(p):
    home = Path.home()
    for cand, base in ((Path(p), home), (Path(p).resolve(), home.resolve())):
        try:
            rel = cand.relative_to(base)
        except (ValueError, OSError):
            continue
        return "~/" + rel.as_posix() if rel.parts else "~"
    return str(p).replace("\\", "/")


_DATASET_EXTS = {".dta", ".parquet", ".sav", ".csv", ".feather", ".rds", ".xlsx"}
_dataset_cache = {"ts": 0.0, "rows": []}


def _dataset_scan(vault):
    now = time.time()
    if now - _dataset_cache["ts"] < 300 and _dataset_cache["rows"]:
        return _dataset_cache["rows"]
    rows = []
    data_root = vault / "Projects" / "data"
    if data_root.is_dir():
        for root, dirs, files in os.walk(data_root):
            dirs[:] = [x for x in dirs if not x.startswith(".") and x not in ("archive", "__pycache__")]
            depth = Path(root).relative_to(data_root).parts
            if len(depth) > 4:
                dirs[:] = []
                continue
            for f in files:
                if Path(f).suffix.lower() in _DATASET_EXTS:
                    p = Path(root) / f
                    rel = _rel(vault, p)
                    rows.append({"name": f, "kind": "file", "rel": rel,
                                 "path": _home_form(p),
                                 "mtime": _mt(p)})
    ctx_root = _toolkit(vault) / "datasets"
    if ctx_root.is_dir():
        try:
            for d in sorted(ctx_root.iterdir()):
                if d.is_dir():
                    rows.append({"name": d.name, "kind": "context", "rel": _rel(vault, d),
                                 "path": _home_form(d), "mtime": _mt(d)})
        except OSError:
            pass
    _dataset_cache["ts"] = now
    _dataset_cache["rows"] = rows
    return rows


def dataset_search(vault, q):
    q = (q or "").strip().lower()
    rows = _dataset_scan(vault)
    if q:
        terms = q.split()
        rows = [r for r in rows if all(t in r["name"].lower() or t in r["rel"].lower() for t in terms)]
    seen, uniq = set(), []
    for r in sorted(rows, key=lambda r: (r["kind"] != "context", r["name"])):
        if r["rel"] in seen:
            continue
        seen.add(r["rel"])
        uniq.append(r)
    uniq = uniq[:40]
    return {"hits": uniq, "count": len(uniq)}


def _confine(root, rel):
    """Resolve rel under root, refusing '..' escapes -- the same discipline as
    _find_asset, generalized to any relative id (report/measure paths)."""
    rel = (rel or "").replace("\\", "/").strip().lstrip("/")
    if not rel or ".." in rel.split("/"):
        return None
    try:
        p = (root / rel).resolve()
        p.relative_to(root.resolve())
    except (OSError, ValueError):
        return None
    return p


# ----------------------------------------------------------------- public API
def _prev_words(wdir, docname, txt):
    if docname != "paper.md":
        return 0
    prev = wdir / "previous-draft.md"
    if not prev.is_file():
        return 0
    n = _wordcount(_read(prev) or "")
    return n if n > _wordcount(txt) else 0


def list_papers(vault):
    root = vault / "Projects" / "papers"
    out = []
    if not root.is_dir():
        return out
    _reconcile_keys(vault)
    flags = _load_flags()
    for d in sorted(root.iterdir()):
        if not d.is_dir() or not d.name.startswith(PREFIX):
            continue
        slug = d.name[len(PREFIX):]
        wdir = d / "writing"
        results_n = len(_all_result_stems(d))   # results/ assets exist -> the card says so, draft or not
        found_any = False
        if wdir.is_dir():
            _migrate_sidecars(wdir)
            for docname, meta in DOC_KINDS.items():
                if meta.get("base", "papers") != "papers":
                    continue
                paper = wdir / docname
                if not paper.exists():
                    continue
                found_any = True
                editor = _versioning_dir(wdir) / _editor_name(docname)
                pdfp = paper.with_suffix(".pdf")
                txt = _read(paper) or ""
                publish = doc_publish(txt, meta["publish"])
                key = "paper:%s:%s" % (slug, docname)
                out.append({
                    "slug": slug,
                    "doc": docname,
                    "kind": meta["kind"],
                    "label": meta["label"],
                    "publish": publish,
                    "style": render_preset(publish),
                    "title": _paper_title(txt, slug),
                    "paperRel": _rel(vault, paper),
                    "editorRel": _rel(vault, editor),
                    "words": _wordcount(txt),
                    "prevWords": _prev_words(wdir, docname, txt),
                    "paperMtime": _mt(paper),
                    "editorMtime": _mt(editor) if editor.exists() else 0,
                    "hasEditor": editor.exists(),
                    "pdf": pdfp.exists(),
                    "pdfMtime": _mt(pdfp) if pdfp.exists() else 0,
                    "status": get_status(key),
                    "pinned": bool(flags.get(key)),
                    "resultsCount": results_n,
                })
        readme = d / "README.md"
        if not found_any and readme.is_file():
            txt = _read(readme) or ""
            key = "paper:%s:readme.md" % slug
            out.append({
                "slug": slug, "doc": "readme.md", "kind": "project",
                "label": "Project", "publish": "", "style": "manuscript",
                "title": _paper_title(txt, slug),
                "paperRel": _rel(vault, readme), "editorRel": "",
                "words": _wordcount(txt), "paperMtime": _mt(readme),
                "editorMtime": 0, "hasEditor": False,
                "status": get_status(key), "pinned": bool(flags.get(key)),
                "resultsCount": results_n,
            })
    out.sort(key=lambda p: (not p.get("pinned"), -p["paperMtime"]))
    return out


def list_grants(vault):
    root = vault / "Projects" / "grants"
    out = []
    if not root.is_dir():
        return out
    _reconcile_keys(vault)
    flags = _load_flags()
    for d in sorted(root.iterdir()):
        if not d.is_dir() or not d.name.startswith(PREFIX):
            continue
        slug = d.name[len(PREFIX):]
        wdir = d / "writing"
        results_n = len(_all_result_stems(d))   # results/ assets exist -> the card says so, draft or not
        gmeta = _grant_meta(d)                  # deadline + per-file caps from rules/compliance.json
        cap_of = gmeta["byFile"]
        found_any = False
        if wdir.is_dir():
            _migrate_sidecars(wdir)
            for docname, meta in DOC_KINDS.items():
                if meta.get("base", "papers") != "papers":
                    continue   # briefs-based kinds never live in a grant
                paper = wdir / docname
                if not paper.exists():
                    continue
                found_any = True
                editor = _versioning_dir(wdir) / _editor_name(docname)
                pdfp = wdir / "pdf" / (docname[:-3] + ".pdf")
                txt = _read(paper) or ""
                publish = doc_publish(txt, meta["publish"])
                key = "paper:%s:%s" % (slug, docname)
                cap = cap_of.get("writing/" + docname) or {}
                out.append({
                    "slug": slug,
                    "doc": docname,
                    "kind": meta["kind"],
                    "label": meta["label"],
                    "publish": publish,
                    "style": render_preset(publish),
                    "title": _paper_title(txt, slug),
                    "paperRel": _rel(vault, paper),
                    "editorRel": _rel(vault, editor),
                    "words": _wordcount(txt),
                    "prevWords": _prev_words(wdir, docname, txt),
                    "paperMtime": _mt(paper),
                    "editorMtime": _mt(editor) if editor.exists() else 0,
                    "hasEditor": editor.exists(),
                    "pdf": pdfp.exists(),
                    "pdfMtime": _mt(pdfp) if pdfp.exists() else 0,
                    "status": get_status(key),
                    "pinned": bool(flags.get(key)),
                    "deadline": gmeta["deadline"],
                    "deadlineRaw": gmeta["deadlineRaw"],
                    "deadlineKind": gmeta["deadlineKind"],
                    "deadlineDone": gmeta["deadlineDone"],
                    "deadlineUnknown": gmeta["deadlineUnknown"],
                    "component": cap.get("component"),
                    "limitType": cap.get("limitType"),
                    "maxPages": cap.get("maxPages"),
                    "maxPagesFr": cap.get("maxPagesFr"),
                    "maxChars": cap.get("maxChars"),
                    "pages": _pdf_pages(pdfp) if pdfp.exists() else None,
                })
        readme = d / "README.md"
        if not found_any and readme.is_file():
            txt = _read(readme) or ""
            key = "paper:%s:readme.md" % slug
            out.append({
                "slug": slug, "doc": "readme.md", "kind": "project",
                "label": "Project", "publish": "", "style": "manuscript",
                "title": _paper_title(txt, slug),
                "paperRel": _rel(vault, readme), "editorRel": "",
                "words": _wordcount(txt), "paperMtime": _mt(readme),
                "editorMtime": 0, "hasEditor": False,
                "status": get_status(key), "pinned": bool(flags.get(key)),
                "resultsCount": results_n,
                # a grant with nothing drafted yet still has a deadline to show
                "deadline": gmeta["deadline"], "deadlineRaw": gmeta["deadlineRaw"],
                "deadlineKind": gmeta["deadlineKind"],
                "deadlineDone": gmeta["deadlineDone"],
                "deadlineUnknown": gmeta["deadlineUnknown"],
                "component": None, "limitType": None, "maxPages": None,
                "maxPagesFr": None, "maxChars": None, "pages": None,
            })
    out.sort(key=lambda p: (not p.get("pinned"), -p["paperMtime"]))
    return out


def read_doc(vault, slug, doc=DEFAULT_DOC, lite=False):
    doc = (doc or DEFAULT_DOC).strip().lower() or DEFAULT_DOC
    paths = _writing_paths(vault, slug, doc)
    if not paths:
        return {"error": "unknown paper"}
    paper_p, editor_p = paths
    if not paper_p.exists():
        return {"error": paper_p.name + " not found"}
    _migrate_sidecars(editor_p.parent.parent)
    paper_text = _read(paper_p) or ""
    title = _paper_title(paper_text, slug)
    meta = _doc_meta(doc) or DOC_KINDS[DEFAULT_DOC]
    publish = doc_publish(paper_text, meta["publish"])
    if editor_p.exists():
        editor_text = _read(editor_p) or ""
        generated = False
    elif _is_project_doc(doc):
        # project docs are simple documents — no paragraph-planning sidecar is
        # auto-created (mirrors the supplements doctrine)
        editor_text = ""
        generated = False
    else:
        editor_text = build_skeleton(paper_text, None, title)
        _atomic_write(editor_p, None, editor_text, label="editor")
        generated = True
    return {
        "slug": slug, "doc": doc if _is_project_doc(doc) else paper_p.name, "title": title,
        "kind": meta["kind"], "label": meta["label"],
        "projectDoc": _is_project_doc(doc),
        "publish": publish, "style": render_preset(publish),
        "preview": _fm_value(paper_text, "preview"),
        "paper": {"text": paper_text, "mtime": _mt(paper_p),
                  "rel": _rel(vault, paper_p), "words": _wordcount(paper_text)},
        "editor": {"text": editor_text, "mtime": _mt(editor_p),
                   "rel": _rel(vault, editor_p), "generated": generated},
        "comments": load_comments(vault, slug, paper_p.name,
                                  resolved=False if lite else None),
    }


def _conflict_siblings(p):
    stem = p.name[:-len(p.suffix)] if p.suffix else p.name
    return sorted(c for c in p.parent.glob(stem + ".sync-conflict-*" + p.suffix)
                  if c != p and c.is_file())


def _json_records(p, container):
    """The record LIST out of a {container: [...]} (or bare-list) sidecar. None means
    unreadable or unparsable — the caller parks such a copy without merging it."""
    raw = _read(p)
    if raw is None:
        return None
    if not raw.strip():
        return []
    try:
        data = json.loads(raw)
    except ValueError:
        return None
    items = data.get(container) if isinstance(data, dict) else data
    return items if isinstance(items, list) else []


def _record_stamp(rec, fields):
    """First non-zero of the stamp fields, in order — 0 when the record carries none."""
    for f in fields:
        try:
            v = int(rec.get(f) or 0)
        except (TypeError, ValueError):
            v = 0
        if v:
            return v
    return 0


def _park_conflict(p):
    """Move (never delete) one conflict copy into conflicts/ beside the live file."""
    cdir = p.parent / "conflicts"
    cdir.mkdir(parents=True, exist_ok=True)
    dest, n = cdir / p.name, 1
    while dest.exists():
        dest = cdir / (p.stem + ".%d" % n + p.suffix)
        n += 1
    shutil.move(str(p), str(dest))


def _absorb_sync_conflicts(path, key="id", stamp=("updated", "created"),
                           container="comments", label="comments"):
    out = {"changed": False, "added": [], "mtimeBefore": 0}
    if path is None:
        return out
    out["mtimeBefore"] = _mt(path)
    try:
        siblings = _conflict_siblings(path)
        if not siblings:
            return out
        merged = [r for r in (_json_records(path, container) or []) if isinstance(r, dict)]
        pos = {}
        for i, r in enumerate(merged):
            rid = str(r.get(key) or "")
            if rid and rid not in pos:
                pos[rid] = i
        for c in siblings:
            recs = _json_records(c, container)
            if recs is None:
                continue                       # unparsable — parked below, never merged
            for r in recs:
                if not isinstance(r, dict):
                    continue
                rid = str(r.get(key) or "")
                if not rid:
                    continue
                if rid in pos:
                    if _record_stamp(r, stamp) > _record_stamp(merged[pos[rid]], stamp):
                        merged[pos[rid]] = r
                        out["changed"] = True
                else:
                    pos[rid] = len(merged)
                    merged.append(r)
                    out["added"].append(rid)
                    out["changed"] = True
        if out["changed"]:
            old = _read(path) if path.exists() else None
            _atomic_write(path, old,
                          json.dumps({container: merged}, ensure_ascii=False, indent=1),
                          label=label)
        for c in siblings:
            try:
                _park_conflict(c)
            except (OSError, shutil.Error) as exc:
                sys.stderr.write("[drafting] could not park %s: %s\n" % (c.name, exc))
    except Exception as exc:                              # a read must never fail here
        sys.stderr.write("[drafting] sync-conflict absorb failed for %s: %s\n" % (path, exc))
        out["changed"] = False
    return out


def _comments_name(docname):
    docname = (docname or DEFAULT_DOC).strip().lower()
    return "comments.json" if docname == DEFAULT_DOC else docname[:-3] + ".comments.json"


def _comments_path(vault, slug, doc=DEFAULT_DOC):
    paths = _writing_paths(vault, slug, doc)
    if not paths:
        return None
    return paths[1].parent / _comments_name(doc)


def _sanitize_comments(items):
    out = []
    if not isinstance(items, list):
        return out
    for it in items:
        if not isinstance(it, dict):
            continue
        cid = str(it.get("id") or "").strip()
        quote = it.get("quote")
        if not cid or not isinstance(quote, str) or not quote:
            continue   # a comment with no anchor text can never be re-located — drop it
        kind = str(it.get("kind") or "text").strip().lower()
        if kind not in ("text", "figure", "flag"):
            kind = "text"
        author = str(it.get("author") or "owner").strip().lower()
        if author not in ("owner", "checker"):
            author = "owner"
        rect = it.get("rectPct")
        rect_out = None
        if isinstance(rect, dict):
            try:
                rect_out = {k: float(rect[k]) for k in ("x", "y", "w", "h")}
            except (KeyError, TypeError, ValueError):
                rect_out = None
        replies_out = []
        raw_replies = it.get("replies")
        if isinstance(raw_replies, list):
            for rp in raw_replies[:200]:
                if not isinstance(rp, dict):
                    continue
                rbody = str(rp.get("body") or "")
                if not rbody.strip():
                    continue   # an empty reply is a UI artifact, never a turn in the thread
                rauthor = str(rp.get("author") or "owner").strip().lower()
                if rauthor not in ("owner", "checker"):
                    rauthor = "owner"
                replies_out.append({
                    "id": str(rp.get("id") or "").strip() or ("r%d" % (len(replies_out) + 1)),
                    "author": rauthor,
                    "body": rbody,
                    "created": int(rp.get("created") or 0),
                })
        rec = {
            "id": cid,
            "quote": quote,
            "prefix": str(it.get("prefix") or ""),
            "suffix": str(it.get("suffix") or ""),
            "body": str(it.get("body") or ""),
            "resolved": bool(it.get("resolved")),
            "orphaned": bool(it.get("orphaned")),
            "created": int(it.get("created") or 0),
            "updated": int(it.get("updated") or 0),
            "kind": kind,
            "author": author,
            "rectPct": rect_out,
            "replies": replies_out,
        }
        reviewer = _clean_reviewer(it.get("reviewer"))
        if reviewer:
            rec["reviewer"] = reviewer
        if it.get("outline") is True:
            rec["outline"] = True
        if it.get("focusFlag") is True:
            rec["focusFlag"] = True
        if it.get("detached") is True:
            rec["detached"] = True
            for k in ("detachedAt", "detachedOffset"):
                v = it.get(k)
                if isinstance(v, (int, float)) and not isinstance(v, bool) and v >= 0:
                    rec[k] = int(v)
            sec = it.get("detachedSection")
            if isinstance(sec, str):
                rec["detachedSection"] = sec[:300]
        sug = _clean_suggestion(it.get("suggestion"))
        if sug:
            rec["suggestion"] = sug
        out.append(rec)
    return out


_SUGGEST_MAX = 200000


def _clean_suggestion(v):
    """{proposed, status, original?, decided?, by?, source?} or None. `proposed` may be empty (a pure
    deletion) but must be a string; status defaults to 'open'."""
    if not isinstance(v, dict) or not isinstance(v.get("proposed"), str):
        return None
    status = str(v.get("status") or "open").strip().lower()
    if status not in ("open", "accepted", "rejected"):
        status = "open"
    out = {"proposed": v["proposed"][:_SUGGEST_MAX], "status": status}
    if isinstance(v.get("original"), str) and v["original"]:
        out["original"] = v["original"][:_SUGGEST_MAX]
    if isinstance(v.get("decided"), str) and v["decided"].strip():
        out["decided"] = v["decided"].strip()[:40]
    if isinstance(v.get("by"), str) and v["by"].strip():
        out["by"] = v["by"].strip()[:80]
    if isinstance(v.get("source"), str) and v["source"].strip():
        out["source"] = v["source"].strip()[:500]
    return out


_REVIEWER_RE = re.compile(r"^(?:R([1-9])|(editor|ae))$", re.I)


def _clean_reviewer(v):
    """'R1'..'R9', 'Editor' or 'AE' (case-insensitive in, canonical out); else ''."""
    m = _REVIEWER_RE.match(str(v or "").strip())
    if not m:
        return ""
    if m.group(1):
        return "R" + m.group(1)
    return "Editor" if m.group(2).lower() == "editor" else "AE"


_FIG_QUOTE_RE = re.compile(r"^!\[\[([^\]]+)\]\]$")


def _figure_comment_provenance(vault, slug, comments):
    if not any(c.get("kind") == "figure" for c in comments):
        return comments
    proj = _project_dir(vault, slug)
    if not proj:
        return comments
    manifest = _load_provenance(proj / "results")
    for c in comments:
        if c.get("kind") != "figure":
            continue
        m = _FIG_QUOTE_RE.match((c.get("quote") or "").strip())
        if not m:
            continue
        base = m.group(1).rsplit("/", 1)[-1]
        stem = re.sub(r"\.(png|jpg|jpeg|pdf|svg)$", "", base, flags=re.I)
        entry = manifest.get(stem)
        if entry:
            c["provenance"] = {"scriptRel": entry.get("script"), "generated": entry.get("generated")}
    return comments


def _comments_version(p):
    """Content hash of the comments store — the version token a writer pins its save to."""
    if p is None or not p.exists():
        return ""
    try:
        return hashlib.sha256(p.read_bytes()).hexdigest()[:16]
    except OSError:
        return ""


_REWRITE_LOCK = threading.Lock()
_RW_ID = re.compile(r"^[a-z0-9]{6,32}$")
_RW_MAX = 5000            # entries per document, tombstones included (oldest pruned first)
_RW_TEXT = 20000          # chars per baseline / last-seen text: longer is refused, never cut
_RW_FIELDS = ("baseline", "heading", "section", "pos", "key", "last", "started", "updated", "passedAt", "best")


def _rewrite_path(vault, slug, doc=DEFAULT_DOC):
    paths = _writing_paths(vault, slug, doc)
    if not paths:
        return None
    docname = (doc or DEFAULT_DOC).strip().lower()
    name = "rewrite.json" if docname == DEFAULT_DOC else docname[:-3].replace("/", ".") + ".rewrite.json"
    return paths[1].parent / name


def _rw_num(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) and v == v and abs(v) < 1e15 else None


def _clean_rewrite_entry(eid, it):
    if not isinstance(eid, str) or not _RW_ID.match(eid) or not isinstance(it, dict):
        return None
    rev = _rw_num(it.get("rev"))
    rev = int(rev) if rev is not None and rev >= 0 else 0
    upd = _rw_num(it.get("updatedAt"))
    if it.get("dropped") is True:
        out = {"id": eid, "dropped": True, "rev": rev}
        if upd is not None:
            out["updatedAt"] = upd
        return out
    base = it.get("baseline")
    if not isinstance(base, str) or not base.strip():
        return None

    def s(k, cap):
        v = it.get(k)
        return v[:cap] if isinstance(v, str) else ""

    out = {"id": eid, "baseline": base[:_RW_TEXT], "heading": s("heading", 300), "section": s("section", 300),
           "key": s("key", 64), "last": s("last", _RW_TEXT), "rev": rev}
    pos = _rw_num(it.get("pos"))
    out["pos"] = int(pos) if pos is not None and 0 <= pos < 100000 else 0
    for k in ("started", "updated", "passedAt", "best"):
        v = _rw_num(it.get(k))
        if v is not None:
            out[k] = v
    if upd is not None:
        out["updatedAt"] = upd
    return out


def _load_rewrite_file(p):
    try:
        raw = p.read_text(encoding="utf-8") if p.exists() else ""
        data = json.loads(raw) if raw.strip() else {}
    except (OSError, ValueError):
        data = {}
    items = data.get("paras") if isinstance(data, dict) else None
    out = {}
    if isinstance(items, dict):
        for k, v in items.items():
            c = _clean_rewrite_entry(k, v)
            if c:
                out[k] = c
    return out


def load_rewrite(vault, slug, doc=DEFAULT_DOC):
    p = _rewrite_path(vault, slug, doc)
    if p is None:
        return {"error": "unknown paper"}
    return {"ok": True, "paras": _load_rewrite_file(p), "mtime": _mt(p) if p.exists() else 0, "rel": _rel(vault, p)}


def _rw_too_long(v):
    return isinstance(v, str) and len(v) > _RW_TEXT


def save_rewrite(vault, slug, doc, set_=None, drop=None):
    p = _rewrite_path(vault, slug, doc)
    if p is None:
        return {"error": "unknown paper"}
    if set_ is not None and not isinstance(set_, dict):
        return {"error": "bad set"}
    if drop is not None and not isinstance(drop, list):
        return {"error": "bad drop"}
    set_ = set_ or {}
    drop = drop or []
    long_ids = [k for k, v in set_.items() if isinstance(v, dict) and (_rw_too_long(v.get("baseline")) or _rw_too_long(v.get("last")))]
    if long_ids:
        return {"error": "paragraph too long for Rewrite (over %d characters)" % _RW_TEXT,
                "tooLong": [str(k)[:40] for k in long_ids[:20]]}
    if len(set_) > _RW_MAX:
        return {"error": "too many entries"}
    now = int(time.time() * 1000)
    with _REWRITE_LOCK:
        cur = _load_rewrite_file(p)
        stale, applied, invalid = [], 0, 0
        for k, v in set_.items():
            if not isinstance(k, str) or not _RW_ID.match(k) or not isinstance(v, dict):
                invalid += 1
                continue
            old = cur.get(k)
            old_rev = old.get("rev", 0) if old else 0
            rev = _rw_num(v.get("rev"))
            if rev is None:
                # an older tab: a whole entry, never over a revisioned one or a tombstone
                if old and (old_rev > 0 or old.get("dropped")):
                    stale.append(k)
                    continue
                c = _clean_rewrite_entry(k, {**v, "rev": 0, "dropped": False})
                if not c:
                    invalid += 1
                    continue
                c["updatedAt"] = now
                cur[k] = c
                applied += 1
                continue
            rev = int(rev)
            if rev < 1:
                invalid += 1
                continue
            if rev <= old_rev or (old and old.get("dropped")):
                stale.append(k)
                continue
            if v.get("dropped") is True:
                cur[k] = {"id": k, "dropped": True, "rev": rev, "updatedAt": now}
                applied += 1
                continue
            merged = {f: x for f, x in (old or {}).items() if f in _RW_FIELDS}
            for f in _RW_FIELDS:
                if f in v:
                    if v[f] is None:
                        merged.pop(f, None)
                    else:
                        merged[f] = v[f]
            c = _clean_rewrite_entry(k, merged)
            if not c:
                invalid += 1
                continue
            c["rev"], c["updatedAt"] = rev, now
            cur[k] = c
            applied += 1
        for k in drop:
            if isinstance(k, str) and _RW_ID.match(k):
                old = cur.get(k)
                if old and old.get("dropped"):
                    continue
                cur[k] = {"id": k, "dropped": True, "rev": (old.get("rev", 0) if old else 0) + 1, "updatedAt": now}
                applied += 1
            else:
                invalid += 1
        if invalid and not applied and not stale:
            return {"error": "no valid entries"}
        if len(cur) > _RW_MAX:
            graves = sorted((x for x in cur.values() if x.get("dropped")), key=lambda x: x.get("updatedAt") or 0)
            for g in graves[:len(cur) - _RW_MAX]:
                cur.pop(g["id"], None)
            if len(cur) > _RW_MAX:
                return {"error": "too many entries"}
        if applied:
            body = json.dumps({"version": 2, "paras": cur}, ensure_ascii=False, indent=1)
            p.parent.mkdir(parents=True, exist_ok=True)
            fd, tmp = tempfile.mkstemp(dir=str(p.parent), prefix=".rewrite.", suffix=".json.tmp")
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as f:
                    f.write(body)
                    f.flush()
                    try:
                        os.fsync(f.fileno())
                    except OSError:
                        pass
                os.replace(tmp, str(p))
            except OSError:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass
                return {"error": "write failed"}
    return {"ok": True, "paras": cur, "stale": stale, "mtime": _mt(p) if p.exists() else 0}


def load_comments(vault, slug, doc=DEFAULT_DOC, resolved=None):
    p = _comments_path(vault, slug, doc)
    if p is None:
        return {"error": "unknown paper"}
    # the ONE loader every comments endpoint goes through, so folding the other
    # machine's parked copies back in here happens before any list, read or write
    _absorb_sync_conflicts(p)
    if not p.exists():
        return _comments_half({"ok": True, "comments": [], "mtime": 0, "version": "",
                               "rel": _rel(vault, p)}, resolved)
    raw = _read(p) or ""
    try:
        data = json.loads(raw) if raw.strip() else {}
    except ValueError:
        data = {}
    items = data.get("comments") if isinstance(data, dict) else (data if isinstance(data, list) else [])
    comments = _figure_comment_provenance(vault, slug, _sanitize_comments(items))
    return _comments_half({"ok": True, "comments": comments, "mtime": _mt(p),
                           "version": _comments_version(p), "rel": _rel(vault, p)}, resolved)


def _comments_half(res, resolved):
    """Narrow a load_comments result to one half of the store. None -> untouched."""
    if resolved is None:
        return res
    allc = res["comments"]
    if resolved:
        res["comments"] = [c for c in allc if c.get("resolved")]
        res["resolvedOnly"] = True
    else:
        res["comments"] = [c for c in allc if not c.get("resolved")]
        res["resolvedOmitted"] = len(allc) - len(res["comments"])
    return res


_COMMENTS_SAVE_LOCK = threading.RLock()
_DELETED_IDS_MAX = 5000


def _reattach_absent(items, stored, deleted):
    have = {c["id"] for c in items}
    out = list(items)
    kept_resolved = kept_open = 0
    prev = None                       # id of the last stored record present in `out`
    front = 0                         # insertion point while nothing precedes
    for r in stored:
        rid = r["id"]
        if rid in have:
            prev = rid
            continue
        if rid in deleted:
            continue                  # a named deletion
        if prev is None:
            at = front
            front += 1
        else:
            at = next(i for i, c in enumerate(out) if c["id"] == prev) + 1
        out.insert(at, r)
        have.add(rid)
        prev = rid
        if r.get("resolved"):
            kept_resolved += 1
        else:
            kept_open += 1
    return out, kept_resolved, kept_open


def save_comments(vault, slug, doc, comments, base_mtime=None, force=False, base_version=None,
                  partial=False, deleted_ids=None):
    """Write the anchored-comment store, pinned to the version the writer last read."""
    if deleted_ids is None:
        deleted_ids = []
    if (not isinstance(deleted_ids, list) or len(deleted_ids) > _DELETED_IDS_MAX
            or not all(isinstance(i, str) and 0 < len(i) <= 200 for i in deleted_ids)):
        return {"error": "deletedIds must be a list of comment ids"}
    with _COMMENTS_SAVE_LOCK:
        return _save_comments_locked(vault, slug, doc, comments, base_mtime, force,
                                     base_version, partial, deleted_ids)


def _save_comments_locked(vault, slug, doc, comments, base_mtime, force, base_version,
                          partial, deleted_ids):
    p = _comments_path(vault, slug, doc)
    if p is None:
        return {"error": "unknown paper"}
    absorbed = _absorb_sync_conflicts(p)

    def _refuse():
        cur_load = load_comments(vault, slug, doc)
        return {"conflict": True, "currentMtime": _mt(p),
                "currentVersion": _comments_version(p),
                "currentComments": cur_load.get("comments") or [],
                "currentText": (_read(p) or "") if p.exists() else ""}

    if not force and base_version is None and base_mtime is None:
        return _refuse()          # an unversioned write can only be a blind clobber
    old = None
    if p.exists():
        stale = False
        if not force:
            if base_version is not None:
                stale = str(base_version) != _comments_version(p)
            else:
                stale = _mt(p) != int(base_mtime)
            # the only thing that moved the file was our own absorb, just above
            if stale and absorbed["changed"] and base_mtime is not None \
                    and int(base_mtime) == absorbed["mtimeBefore"]:
                stale = False
        if stale:
            return _refuse()
        old = _read(p)
    elif not force and base_version is not None and str(base_version) != "":
        return _refuse()          # the store was deleted under a writer that had read it
    items = _sanitize_comments(comments)
    kept = kept_open = 0
    if old is not None:
        try:
            data = json.loads(old) if old.strip() else {}
        except ValueError:
            data = {}
        stored = data.get("comments") if isinstance(data, dict) else data
        items, kept, kept_open = _reattach_absent(items, _sanitize_comments(stored), set(deleted_ids))
    if absorbed["added"]:
        have = {c["id"] for c in items}
        wanted = set(absorbed["added"]) - have
        if wanted:
            items.extend(r for r in _sanitize_comments(_json_records(p, "comments") or [])
                         if r["id"] in wanted)
    payload = json.dumps({"comments": items}, ensure_ascii=False, indent=1)
    _atomic_write(p, old, payload, label="comments")
    res = {"ok": True, "mtime": _mt(p), "version": _comments_version(p), "rel": _rel(vault, p)}
    if partial:
        res["resolvedKept"] = kept
    if kept_open or (kept and not partial):
        res["keptAbsent"] = kept_open + (0 if partial else kept)
    return res


def _figure_comments_path(vault, slug):
    proj = _project_dir(vault, slug)
    return (proj / "results" / ".figure-comments.json") if proj else None


def _sanitize_figure_comments(data):
    """{stem: [comment,...]} clamped to the durable shape; drops entries with no stem/id."""
    out = {}
    if not isinstance(data, dict):
        return out
    for stem, items in data.items():
        stem = str(stem or "").strip()
        if not stem or "/" in stem or "\\" in stem or not isinstance(items, list):
            continue
        lst = []
        for it in items:
            if not isinstance(it, dict):
                continue
            cid = str(it.get("id") or "").strip()
            if not cid:
                continue
            def _frac(k):
                try:
                    return max(0.0, min(1.0, float(it.get(k) or 0)))
                except (TypeError, ValueError):
                    return 0.0
            lst.append({
                "id": cid,
                "x": _frac("x"), "y": _frac("y"), "w": _frac("w"), "h": _frac("h"),
                "body": str(it.get("body") or ""),
                "resolved": bool(it.get("resolved")),
                "author": (str(it.get("author") or "owner").strip().lower() or "owner"),
                "created": int(it.get("created") or 0),
                "updated": int(it.get("updated") or 0),
                "reply": str(it.get("reply") or ""),
                "for_agent": bool(it.get("for_agent")),
            })
        if lst:
            out[stem] = lst
    return out


def load_figure_comments(vault, slug):
    """Every figure/table comment for the project, keyed by asset stem, with the producing
    script + data joined per stem so a reader can fix the figure at the flagged coords."""
    p = _figure_comments_path(vault, slug)
    if p is None:
        return {"error": "unknown paper"}
    data = {}
    if p.exists():
        raw = _read(p) or ""
        try:
            j = json.loads(raw) if raw.strip() else {}
            data = j.get("comments") if isinstance(j, dict) else {}
        except ValueError:
            data = {}
    comments = _sanitize_figure_comments(data)
    proj = _project_dir(vault, slug)
    manifest = _load_provenance(proj / "results") if proj else {}
    prov = {}
    for stem in comments:
        entry = manifest.get(stem)
        if entry:
            prov[stem] = {"script": entry.get("script"), "kind": entry.get("kind"),
                          "dataSources": entry.get("dataSources"), "generated": entry.get("generated")}
    return {"ok": True, "comments": comments, "provenance": prov,
            "mtime": _mt(p) if p.exists() else 0, "version": _comments_version(p),
            "rel": _rel(vault, p)}


def save_figure_comments(vault, slug, stem, items, base_mtime=None, force=False,
                         base_version=None):
    """Replace the comment list for ONE stem; every other stem is preserved."""
    p = _figure_comments_path(vault, slug)
    if p is None:
        return {"error": "unknown paper"}
    stem = str(stem or "").strip()
    if not stem or "/" in stem or "\\" in stem:
        return {"error": "bad stem"}
    old, data = None, {}
    if p.exists():
        cur, curver = _mt(p), _comments_version(p)
        if not force:
            if base_version is not None:
                if str(base_version) != curver:
                    stale = _sanitize_figure_comments(
                        (json.loads(_read(p) or "{}") or {}).get("comments") or {})
                    return {"conflict": True, "currentMtime": cur, "currentVersion": curver,
                            "currentComments": stale.get(stem, [])}
            elif base_mtime is not None and cur != int(base_mtime):
                return {"conflict": True, "currentMtime": cur, "currentVersion": curver}
        old = _read(p)
        try:
            j = json.loads(old) if (old or "").strip() else {}
            data = j.get("comments") if isinstance(j, dict) else {}
        except ValueError:
            data = {}
    elif not force and base_version is not None and str(base_version) != "":
        return {"conflict": True, "currentMtime": 0, "currentVersion": "",
                "currentComments": []}
    merged = _sanitize_figure_comments(data if isinstance(data, dict) else {})
    one = _sanitize_figure_comments({stem: items}).get(stem, [])
    if one:
        merged[stem] = one
    else:
        merged.pop(stem, None)
    payload = json.dumps({"comments": merged}, ensure_ascii=False, indent=1)
    _atomic_write(p, old, payload, label="figure-comments")
    return {"ok": True, "mtime": _mt(p), "version": _comments_version(p),
            "comments": merged.get(stem, []), "rel": _rel(vault, p)}


def _results_stamps(vault, slug):
    proj = _project_dir(vault, slug)
    out = {}
    if not proj:
        return out
    try:
        with os.scandir(proj / "results") as it:
            for e in it:
                if Path(e.name).suffix.lower() in _ASSET_CT and e.is_file():
                    st = e.stat()
                    out[e.name] = format(int(st.st_mtime_ns), "x") + "-" + format(int(st.st_size), "x")
    except OSError:
        pass
    return out


def doc_status(vault, slug, doc=DEFAULT_DOC):
    paths = _writing_paths(vault, slug, doc)
    if not paths:
        return {"error": "unknown paper"}
    paper_p, editor_p = paths
    cp = _comments_path(vault, slug, doc)
    assets = _results_stamps(vault, slug)
    return {
        "ok": True,
        "exists": paper_p.exists(),
        "paperMtime": _mt(paper_p) if paper_p.exists() else 0,
        "editorMtime": _mt(editor_p) if editor_p.exists() else 0,
        "commentsMtime": _mt(cp) if (cp and cp.exists()) else 0,
        "assets": assets,
        "resultsStamp": max((v.split("-")[0].rjust(16, "0") for v in assets.values()), default=""),
    }


def _publish_comments_name(docname):
    docname = (docname or DEFAULT_DOC).strip().lower()
    return "publish-comments.json" if docname == DEFAULT_DOC else docname[:-3] + ".publish-comments.json"


def _publish_comments_path(vault, slug, doc=DEFAULT_DOC):
    paths = _writing_paths(vault, slug, doc)
    if not paths:
        return None
    return paths[1].parent / _publish_comments_name(doc)


def _sanitize_publish_comments(items):
    out = []
    if not isinstance(items, list):
        return out
    for it in items:
        if not isinstance(it, dict):
            continue
        cid = str(it.get("id") or "").strip()
        quote = it.get("quote")
        if not cid or not isinstance(quote, str) or not quote:
            continue
        target = str(it.get("target") or "pdf").strip().lower()
        if target not in ("pdf", "docx"):
            target = "pdf"
        rect = it.get("rectPct")
        rect_out = None
        if isinstance(rect, dict):
            try:
                rect_out = {k: float(rect[k]) for k in ("x", "y", "w", "h")}
            except (KeyError, TypeError, ValueError):
                rect_out = None
        out.append({
            "id": cid, "target": target, "page": int(it.get("page") or 1),
            "quote": quote, "rectPct": rect_out,
            "body": str(it.get("body") or ""),
            "resolved": bool(it.get("resolved")), "orphaned": bool(it.get("orphaned")),
            "created": int(it.get("created") or 0), "updated": int(it.get("updated") or 0),
        })
    return out


def load_publish_comments(vault, slug, doc=DEFAULT_DOC):
    p = _publish_comments_path(vault, slug, doc)
    if p is None:
        return {"error": "unknown paper"}
    if not p.exists():
        return {"ok": True, "comments": [], "mtime": 0, "version": "", "rel": _rel(vault, p)}
    raw = _read(p) or ""
    try:
        data = json.loads(raw) if raw.strip() else {}
    except ValueError:
        data = {}
    items = data.get("comments") if isinstance(data, dict) else (data if isinstance(data, list) else [])
    return {"ok": True, "comments": _sanitize_publish_comments(items), "mtime": _mt(p),
            "version": _comments_version(p), "rel": _rel(vault, p)}


def save_publish_comments(vault, slug, doc, comments, base_mtime=None, force=False,
                          base_version=None):
    """Write the publish-comment store, pinned to the version the writer last read."""
    p = _publish_comments_path(vault, slug, doc)
    if p is None:
        return {"error": "unknown paper"}

    def _refuse():
        cur_load = load_publish_comments(vault, slug, doc)
        return {"conflict": True, "currentMtime": _mt(p),
                "currentVersion": _comments_version(p),
                "currentComments": cur_load.get("comments") or [],
                "currentText": (_read(p) or "") if p.exists() else ""}

    if not force and base_version is None and base_mtime is None:
        return _refuse()          # an unversioned write can only be a blind clobber
    old = None
    if p.exists():
        if not force:
            if base_version is not None:
                stale = str(base_version) != _comments_version(p)
            else:
                stale = _mt(p) != int(base_mtime)
            if stale:
                return _refuse()
        old = _read(p)
    elif not force and base_version is not None and str(base_version) != "":
        return _refuse()          # the store was deleted under a writer that had read it
    payload = json.dumps({"comments": _sanitize_publish_comments(comments)}, ensure_ascii=False, indent=1)
    _atomic_write(p, old, payload, label="publish-comments")
    return {"ok": True, "mtime": _mt(p), "version": _comments_version(p), "rel": _rel(vault, p)}


_SOFFICE_PROFILE = settings.STATE_DIR / "soffice-profile"
_soffice_lock = threading.Lock()


def _soffice_argv(exe, outdir, src):
    return [exe, "-env:UserInstallation=file://" + str(_SOFFICE_PROFILE),
            "--headless", "--norestore", "--convert-to", "pdf",
            "--outdir", str(outdir), str(src)]


def _docx_to_pdf(src):
    cache = src.parent / ".cache"
    try:
        cache.mkdir(exist_ok=True)
    except OSError:
        return None
    out = cache / "{}.{}.pdf".format(src.stem, int(_mt(src) or 0))
    if out.exists():
        return out
    exe = _native_tool("soffice")
    if not exe:
        return None
    with _soffice_lock:
        if out.exists():
            return out
        try:
            _SOFFICE_PROFILE.mkdir(parents=True, exist_ok=True)
        except OSError:
            pass
        try:
            _native_run(_soffice_argv(exe, cache, src), src.parent, 180)
        except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
            return None
        produced = cache / (src.stem + ".pdf")
        if not produced.exists():
            return None
        if produced != out:
            try:
                produced.replace(out)
            except OSError:
                return produced
        # one render per document: drop the renders of older mtimes, which otherwise
        # pile up on every Word rebuild (cache files, never the .docx itself)
        old = re.compile(re.escape(src.stem) + r"\.\d+\.pdf")
        for f in cache.iterdir():
            if f != out and old.fullmatch(f.name):
                try:
                    f.unlink()
                except OSError:
                    pass
        return out


def docx_preview_pdf(vault, slug, doc=DEFAULT_DOC, which="paper"):
    """The compiled manuscript .docx, rendered to a PDF for viewing/commenting."""
    src = (_docx_preview_source(vault, slug, doc) if which == "paper"
           else docx_path(vault, slug, doc, which=which))
    return _docx_to_pdf(src) if src else None


def _publish_source_pdf(vault, slug, doc, target, which):
    """The actual PDF backing a publish-comment target: the compiled LaTeX PDF for
    target='pdf', or a rendered preview of the compiled .docx for target='docx'."""
    return pdf_path(vault, slug, doc, which=which) if target == "pdf" else docx_preview_pdf(vault, slug, doc, which=which)


_BBOX_WORD_RE = re.compile(
    r'<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)"[^>]*>([^<]*)</word>')
_BBOX_PAGE_RE = re.compile(r'<page width="([\d.]+)" height="([\d.]+)"')


def pdf_text_layer(vault, slug, doc, target="pdf", which="paper"):
    """{"pages": [{"page": n, "width": w, "height": h, "words": [{"text","x0","y0","x1","y1"}]}]}
    via `pdftotext -bbox`, or {"error"}. Used both to render the click-to-comment overlay
    and to resolve the nearest word/line at a click into the comment's re-locatable quote."""
    src = _publish_source_pdf(vault, slug, doc, target, which)
    if not src:
        return {"error": "no compiled PDF to read — Publish first"}
    exe = _native_tool("pdftotext")
    if not exe:
        return {"error": "pdftotext (poppler) is not installed"}
    try:
        r = _native_run([exe, "-bbox", str(src), "-"], src.parent, 40)
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return {"error": "could not read the PDF text layer"}
    xml = r.stdout or ""
    pages = []
    page_blocks = re.split(r'<page ', xml)[1:]
    for i, block in enumerate(page_blocks, start=1):
        pm = _BBOX_PAGE_RE.match('<page ' + block)
        width, height = (float(pm.group(1)), float(pm.group(2))) if pm else (612.0, 792.0)
        words = [{"text": m.group(5), "x0": float(m.group(1)), "y0": float(m.group(2)),
                  "x1": float(m.group(3)), "y1": float(m.group(4))}
                 for m in _BBOX_WORD_RE.finditer(block)]
        pages.append({"page": i, "width": width, "height": height, "words": words})
    return {"ok": True, "pages": pages}


def pdf_page_png(vault, slug, doc, page, target="pdf", which="paper", dpi=150):
    """One rasterized page (bytes, 'image/png') of the publish-comment target PDF, or
    None. Generalizes table_png's single-page pdftocairo call to an arbitrary page."""
    src = _publish_source_pdf(vault, slug, doc, target, which)
    if not src:
        return None
    cache = src.parent / ".cache"
    try:
        cache.mkdir(exist_ok=True)
    except OSError:
        return None
    out = cache / "{}.{}.p{}.png".format(src.stem, int(_mt(src) or 0), int(page))
    if not out.exists():
        exe = _native_tool("pdftocairo")
        if not exe:
            return None
        try:
            _native_run([exe, "-png", "-r", str(int(dpi)), "-f", str(int(page)), "-l", str(int(page)), "-singlefile", str(src), str(out)[:-4]], src.parent, 40)
        except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
            return None
    if not out.exists():
        return None
    try:
        return out.read_bytes(), "image/png"
    except OSError:
        return None


def _review_info(vault, wdir):
    for rn in REVIEW_NAMES:
        rp = wdir / rn
        if rp.exists():
            return {"exists": True, "name": rn, "rel": _rel(vault, rp), "mtime": _mt(rp)}
    return {"exists": False, "name": REVIEW_NAMES[0], "rel": "", "mtime": 0}


def _supplement_starter(kind, paper_title):
    t = paper_title or "this manuscript"
    if kind == "cover-letter":
        return ("# Cover Letter\n\n---\n\n"
                "To: [Editor], [Journal]\n\n"
                f"Subject: Manuscript submission: \"{t}\"\n\n"
                "Dear [Editor],\n\n"
                f"Please find enclosed our manuscript, \"{t}\", which we are submitting for "
                "exclusive consideration of publication in [Journal]. "
                "[One sentence on what the paper asks and finds.]\n\n"
                "We confirm that this manuscript is original research, not published or under "
                "consideration elsewhere, and that there are no conflicts of interest to disclose.\n\n"
                "Thank you for your time and for managing the editorial process. We look forward to "
                "your feedback.\n\n"
                "Sincerely,\n\n" + settings.AUTHOR_NAME + "\n" + settings.AUTHOR_AFFILIATION + "\n")
    if kind == "response":
        return ("# Response to Reviewers\n\n"
                "| | |\n|---|---|\n"
                f"| **Manuscript** | \"{t}\" |\n"
                "| **Journal** | [Journal] |\n"
                "| **Revision round** | [R&R] |\n\n---\n\n"
                "We thank the editor and the reviewers for the close reading of the manuscript. We "
                "answer each comment in turn below; every comment appears in full, set in indented "
                "type, with our response and the corresponding manuscript change directly beneath it.\n\n"
                "> A reviewer comment appears in indented type, quoted in full.\n\n"
                "**Response.** Our reply follows in plain type.\n\n"
                "> *Revision (§_, p. _).* New or changed manuscript text appears in indented "
                "italic type, with its section and page.\n\n---\n\n"
                "## Reviewer 1\n\n**1.1**\n\n> [Reviewer 1, comment 1, verbatim.]\n\n"
                "**Response.** [Reply. State what we did, why it answers the point, and where the change is.]\n\n"
                "> *Revision (§_, p. _).* \"[New or changed manuscript text, quoted.]\"\n\n---\n\n"
                "## Reviewer 2\n\n**2.1**\n\n> [Reviewer 2, comment 1, verbatim.]\n\n"
                "**Response.** [Reply.]\n\n"
                "> *Revision (§_, p. _).* \"[New or changed manuscript text, quoted.]\"\n")
    if kind == "appendix":
        return ("# Online Appendix\n\n"
                f"## {t}\n\n"
                "[Supplementary analyses, tables, and robustness checks referenced in the main text. "
                "Every model is survey-weighted; references appear in the main manuscript.]\n")
    return f"# {t}\n"


def _supplement_row(vault, wdir, name, vault_slug=None):
    meta = _supplements_for(_proj_of_doc(wdir / name)).get(name) or SUPPLEMENTS.get(name) or {
        "kind": "supplement", "label": _label_from_filename(name)}
    p = wdir / name
    base = name[:-3].rsplit("/", 1)[-1]
    pdf = wdir / (base + ".pdf")
    if not pdf.exists() and (wdir / "pdf" / (base + ".pdf")).exists():
        pdf = wdir / "pdf" / (base + ".pdf")
    txt = _read(p) if p.exists() else None
    row = {
        "name": name, "label": meta["label"], "kind": meta["kind"],
        "exists": p.exists(), "rel": _rel(vault, p),
        "mtime": _mt(p) if p.exists() else 0,
        "words": _wordcount(txt or "") if txt is not None else 0,
        "hasPdf": pdf.exists(), "pdfName": (base + ".pdf") if pdf.exists() else None,
        "pdfMtime": _mt(pdf) if pdf.exists() else 0,
    }
    if meta["kind"] == "appendix" and vault_slug:
        row["pendingCount"] = len(_unassembled_results(*vault_slug))
    if meta.get("maxChars") or meta.get("maxPages"):
        row["maxChars"] = meta.get("maxChars")
        row["maxPages"] = meta.get("maxPages")
        row["limitType"] = meta.get("limitType")
        row["optional"] = meta.get("optional", False)
        if txt is not None:
            row.update(_cap_status(txt, meta))
    docx = wdir / "docx" / (base + ".docx")
    if not docx.exists():
        docx = wdir / (base + ".docx")
    if docx.exists():
        row["hasDocx"] = True
        row["docxName"] = base + ".docx"
        row["docxMtime"] = _mt(docx)
    return row


def list_supplements(vault, slug):
    """The supplements a project actually has, each with whether it exists + its word
    count + any compiled PDF, plus whether a reviewers' comments file is present."""
    proj = _project_dir(vault, slug)
    if proj is None:
        return {"error": "unknown paper"}
    wdir = proj / "writing"
    if _is_grant_project(proj):
        return {"slug": slug, "grant": True,
                "supplements": [_supplement_row(vault, wdir, n, vault_slug=(vault, slug))
                                for n in _supplements_for(proj)],
                "review": _review_info(vault, wdir)}
    # a paper lists its canonical three FIRST, in their fixed order, then whatever
    # else the project actually carries
    names = list(SUPPLEMENT_ORDER)
    names += [n for n in _supplements_for(proj) if n not in SUPPLEMENT_ORDER]
    return {
        "slug": slug,
        "supplements": [_supplement_row(vault, wdir, n, vault_slug=(vault, slug)) for n in names],
        "review": _review_info(vault, wdir),
    }


def read_supplement(vault, slug, name):
    name = (name or "").strip().lower()
    paths = _writing_paths(vault, slug, name)
    if not paths:
        return {"error": "unknown paper"}
    p = paths[0]
    proj = _proj_of_doc(p)
    wdir = proj / "writing"
    if name not in _supplements_for(proj):
        return {"error": "unknown supplement"}
    out = _supplement_row(vault, wdir, name)
    out["slug"] = slug
    out["text"] = (_read(p) or "") if p.exists() else ""
    if SUPPLEMENTS.get(name, {}).get("kind") == "response":
        rev = _review_info(vault, wdir)
        rev["text"] = (_read(wdir / rev["name"]) or "") if rev["exists"] else ""
        out["review"] = rev
    return out


def list_project_docs(vault, slug):
    proj = _project_dir(vault, slug)
    if not proj:
        return {"error": "unknown paper"}
    rows = []
    for name in PROJECT_DOC_ORDER:
        meta = PROJECT_DOCS[name]
        p = proj / meta["path"]
        exists = p.is_file()
        if name == "plan.md" and not exists:
            continue
        txt = _read(p) if exists else None
        rows.append({
            "name": name, "label": meta["label"], "kind": meta["kind"],
            "path": meta["path"], "exists": exists, "rel": _rel(vault, p),
            "mtime": _mt(p) if exists else 0,
            "words": _wordcount(txt or "") if txt is not None else 0,
        })
    manuscripts = []
    wdir = proj / "writing"
    if wdir.is_dir():
        tree_base = proj.parent.name if proj.parent.name in _BARE_BASES else "papers"
        for docname, meta in DOC_KINDS.items():
            if meta.get("base", "papers") != tree_base:
                continue
            mp = wdir / docname
            if mp.is_file():
                manuscripts.append({"name": docname, "label": meta["label"],
                                    "kind": meta["kind"], "mtime": _mt(mp)})
    q = proj / QUESTIONS_PATH
    q_exists = q.is_file()
    return {"slug": slug, "tree": proj.parent.name, "projectDocs": rows, "manuscripts": manuscripts,
            "questions": {"exists": q_exists, "path": QUESTIONS_PATH,
                          "rel": _rel(vault, q) if q_exists else "",
                          "mtime": _mt(q) if q_exists else 0}}


def _grant_required_headings(proj, name):
    """The funder's `required_headings` for the grant component stored at
    writing/<name>, in the rules' own order and wording; [] when the rules give none
    (or cannot be read). Never raises."""
    try:
        spec = json.loads(_compliance_path(proj).read_text(encoding="utf-8"))
        want = "writing/" + name
        for group in ("components", "additional_docs"):
            for c in (spec.get(group) or {}).values():
                if isinstance(c, dict) and (c.get("file") or "").strip() == want:
                    out = []
                    for h in c.get("required_headings") or []:
                        h = " ".join(h.split()).lstrip("#").strip() if isinstance(h, str) else ""
                        if h and h not in out:
                            out.append(h)
                    return out
    except Exception:
        pass
    return []


def create_supplement(vault, slug, name):
    """Create a starter supplement if missing (atomic, confined to writing/), then return
    it like read_supplement. A no-op read when it already exists."""
    name = (name or "").strip().lower()
    paths = _writing_paths(vault, slug, name)
    if not paths:
        return {"error": "unknown paper"}
    p = paths[0]
    sups = _supplements_for(_proj_of_doc(p))
    if name not in sups:
        return {"error": "unknown supplement"}
    if not p.exists():
        paper_p = (_writing_paths(vault, slug) or [None])[0]
        title = _paper_title(_read(paper_p) or "", slug) if (paper_p and paper_p.exists()) else slug
        meta = sups[name]
        if name in SUPPLEMENTS:
            starter = _supplement_starter(meta["kind"], title)
        else:
            # a grant component named by the funder's rules: open it with its own cap
            # stated, since the cap is the first thing that governs what can be written
            cap = ""
            if meta.get("maxChars"):
                cap = f"\n\n<!-- Cap: {meta['maxChars']} characters (rules/compliance.json). -->"
            elif meta.get("maxPages"):
                cap = f"\n\n<!-- Cap: {meta['maxPages']} pages (rules/compliance.json). -->"
            # ...and with the funder's required headings for this component already in
            # place (headings only), when the rules name any
            heads = _grant_required_headings(_proj_of_doc(p), name)
            starter = f"# {meta['label']}{cap}\n\n" + _outline_block([(2, h) for h in heads])
        _atomic_write(p, None, starter, label="supplement")
    res = read_supplement(vault, slug, name)
    res["ok"] = True
    return res


_RESERVED_DOC_NAMES = set(PROJECT_DOCS) | {"review.md", "reviewers.md"}


def create_document(vault, slug, name, title="", kind=""):
    """Create a NEW document in a project's writing/ folder and return it ready to open."""
    name = (name or "").strip().lower()
    if not name:
        return {"error": "name a document"}
    if "." not in name.rsplit("/", 1)[-1]:
        name += ".md"          # a bare name is a markdown document
    elif not name.endswith(".md"):
        return {"error": "documents are markdown — name it .md"}
    if not _SAFE_DOC_RE.match(name):
        return {"error": "use letters, digits, dashes and dots — e.g. extended-abstract.md"}
    if name in _RESERVED_DOC_NAMES:
        return {"error": "%s is reserved — pick another name" % name}
    d = _project_dir(vault, slug)
    if d is None or not Path(d).is_dir():
        return {"error": "unknown project"}
    wdir = Path(d) / "writing"
    p = wdir / name
    try:
        p.resolve().relative_to(wdir.resolve())
    except (ValueError, OSError):
        return {"error": "bad name"}
    if p.exists():
        return {"ok": True, "existed": True, "name": name,
                "label": _label_from_filename(name.rsplit("/", 1)[-1]),
                "rel": _rel(vault, p), "mtime": _mt(p)}
    heading = (title or "").strip() or _label_from_filename(name.rsplit("/", 1)[-1])
    okind = _outline_key(kind)
    if not (okind and _outline_known(okind, vault)):
        okind = _OUTLINE_BY_DOCNAME.get(name, "")
    text = _starter_outline(okind, heading, vault) if okind else "# %s\n\n" % heading
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        _atomic_write(p, None, text, label="document")
    except OSError as e:
        return {"error": "couldn't create it: %s" % e}
    return {"ok": True, "existed": False, "name": name,
            "label": _label_from_filename(name.rsplit("/", 1)[-1]),
            "rel": _rel(vault, p), "mtime": _mt(p), "text": text}


_RESULT_STEM_RE = re.compile(r"^(fig|figS|tab)\.?\d", re.I)


_INTENDED_ASSET_RE = re.compile(r"^(fig|tab)S?[._-]?\d", re.I)


def supported_result_stem(stem):
    """(ok: bool, reason: str) — can EVERY layer of the pipeline handle this stem?"""
    stem = (stem or "").strip()
    if not stem:
        return False, "empty stem"
    if not _RESULT_STEM_RE.match(stem):
        if _INTENDED_ASSET_RE.match(stem):
            return False, (
                "unsupported asset name %r — it looks like a figure/table but "
                "_RESULT_STEM_RE cannot match it, so it would be catalogued nowhere, "
                "embedded invisibly, and skipped by the cross-tree scan. Use "
                "fig.NN.<slug> / figSNN.<slug> / tab.NN.<slug>. Supplementary tables "
                "continue the tab.NN sequence in results/supplementary/ — there is no "
                "tabS form." % stem)
        return False, "%r is not a result asset name (expected fig/figS/tab + number)" % stem
    if stem.lower().startswith("tab") and not stem.lower().startswith("tab."):
        return False, (
            "table stem %r must begin 'tab.' — the embed walk and the publish step "
            "transclusion both test that literal prefix" % stem)
    return True, "ok"


_FIG_ASSET_EXT = (".svg", ".png", ".jpg", ".jpeg")
_TAB_ASSET_EXT = (".csv",)


def _all_result_stems(proj):
    stems = {}
    for d, is_supp in ((proj / "results", False), (proj / "results" / "supplementary", True)):
        if not d.is_dir():
            continue
        for f in d.iterdir():
            if not f.is_file() or f.name.startswith("."):
                continue
            if "sync-conflict-" in f.name:
                continue
            ext = f.suffix.lower()
            stem = f.stem
            if not _RESULT_STEM_RE.match(stem):
                continue
            is_fig_stem = not stem.lower().startswith("tab")
            if is_fig_stem and ext not in _FIG_ASSET_EXT:
                continue
            if not is_fig_stem and ext not in _TAB_ASSET_EXT:
                continue
            stems.setdefault(stem, "figure" if is_fig_stem else "table")
    return stems


def _figure_note_caption(proj, stem):
    fn = fignotes.notes(proj, stem)
    if fn:
        return fn["caption"]
    p = proj / "results" / "0.figure_notes.md"
    if not p.is_file():
        return None
    try:
        text = p.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    m = re.search(r"(?im)^###\s*" + re.escape(stem) + r"\b.*?$", text)
    if not m:
        return None
    block = text[m.end():]
    nxt = re.search(r"(?m)^###\s", block)
    if nxt:
        block = block[:nxt.start()]
    cm = re.search(r"(?im)^\*\*Suggested caption:\*\*\s*(.+)$", block)
    return cm.group(1).strip() if cm else None


def _unassembled_results(vault, slug):
    proj = _project_dir(vault, slug)
    if not proj:
        return []
    embedded = set()
    for doc in ("paper.md", "appendix.md"):
        p = proj / "writing" / doc
        if not p.is_file():
            continue
        try:
            text = p.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        embedded.update(stem for stem, _ in _embedded_result_stems(text))
    out = []
    for stem, kind in sorted(_all_result_stems(proj).items()):
        if stem in embedded:
            continue
        ext = "svg" if kind == "figure" and (proj / "results" / f"{stem}.svg").exists() else \
              "png" if kind == "figure" else "csv"
        out.append({"stem": stem, "kind": kind, "ext": ext, "caption": _figure_note_caption(proj, stem)})
    return out


def sync_appendix(vault, slug, dry_run=False):
    pending = _unassembled_results(vault, slug)
    if dry_run or not pending:
        return {"ok": True, "added": 0, "pending": pending}
    create_supplement(vault, slug, "appendix.md")   # no-op if it already exists
    paths = _writing_paths(vault, slug, "appendix.md")
    p = paths[0]
    old = _read(p) or ""
    blocks = []
    for item in pending:
        num_m = re.search(r"\d+", item["stem"])
        num = str(int(num_m.group(0))) if num_m else "?"
        label = "Table" if item["kind"] == "table" else "Figure"
        caption = item["caption"] or "[caption pending]"
        # tables embed with their .csv extension too — a bare stem never resolves in
        # _find_asset (basename match), which made every synced table read as missing
        embed_name = f"{item['stem']}.{item['ext']}"
        blocks.append(f"\n**{label} {num}.** {caption}\n\n![[{embed_name}]]\n\n*Note.* [note pending]\n")
    new_text = old.rstrip("\n") + "\n" + "\n".join(blocks) + "\n"
    _atomic_write(p, old, new_text, label="appendix-sync")
    return {"ok": True, "added": len(pending), "pending": []}


import threading as _bg_threading
import time as _bg_time

_BG_COMPILE_DELAY = 10.0
_bg_guard = _bg_threading.Lock()
_bg_last_save = {}     # (slug, doc) -> monotonic stamp of the latest save
_bg_active = set()     # keys with a parked waiter or a compile in flight


_compile_guard = threading.Lock()
_compile_locks = {}      # key -> threading.Lock
_compile_running = set()  # keys whose compile is actually executing right now


def _compile_key(slug, doc=DEFAULT_DOC, output="pdf"):
    return ((slug or "").strip().lower(),
            (doc or DEFAULT_DOC).strip().lower(),
            "docx" if (output or "pdf").strip().lower() == "docx" else "pdf")


def _compile_busy(slug, doc=DEFAULT_DOC, output=None):
    with _compile_guard:
        if output is not None:
            return _compile_key(slug, doc, output) in _compile_running
        k = _compile_key(slug, doc, "pdf")
        return any(r[:2] == k[:2] for r in _compile_running)


class _CompileSlot:
    """`with _CompileSlot(slug, doc, output):` — serializes compiles of one document
    and marks it busy for preview-status while the work runs."""

    def __init__(self, slug, doc=DEFAULT_DOC, output="pdf"):
        self.key = _compile_key(slug, doc, output)
        self.lk = None

    def __enter__(self):
        with _compile_guard:
            self.lk = _compile_locks.setdefault(self.key, threading.Lock())
        self.lk.acquire()
        with _compile_guard:
            _compile_running.add(self.key)
        return self

    def __exit__(self, *exc):
        with _compile_guard:
            _compile_running.discard(self.key)
        self.lk.release()
        return False


_compile_errors = {}     # key -> (mdMtime, message)


def _note_compile_result(slug, doc, output, md_mtime, error=""):
    key = _compile_key(slug, doc, output)
    with _compile_guard:
        if error:
            _compile_errors[key] = (int(md_mtime or 0), str(error))
        else:
            _compile_errors.pop(key, None)


def _last_compile_error(slug, doc, output, md_mtime):
    """The remembered failure for this document, but only if it happened against the
    manuscript as it stands right now. Otherwise "" — stale news is worse than none."""
    key = _compile_key(slug, doc, output)
    with _compile_guard:
        rec = _compile_errors.get(key)
        if not rec:
            return ""
        when, msg = rec
        if when != int(md_mtime or 0):
            _compile_errors.pop(key, None)
            return ""
        return msg


def _bg_compile_soon(vault, slug, doc=DEFAULT_DOC):
    """Schedule a quiet PDF recompile of this manuscript; safe to call on every save."""
    try:
        if _is_project_doc(doc):
            return
    except Exception:
        return
    key = ((slug or "").strip().lower(), (doc or DEFAULT_DOC).strip().lower())
    with _bg_guard:
        _bg_last_save[key] = _bg_time.monotonic()
        if key in _bg_active:
            return
        _bg_active.add(key)

    def _waiter():
        try:
            while True:
                while True:   # wait for a calm gap after the last save
                    with _bg_guard:
                        due = _bg_last_save.get(key, 0.0) + _BG_COMPILE_DELAY
                    pause = due - _bg_time.monotonic()
                    if pause <= 0:
                        break
                    _bg_time.sleep(min(pause, _BG_COMPILE_DELAY))
                started = _bg_time.monotonic()
                try:
                    with _CompileSlot(slug, doc, "pdf"):
                        res = compile_pdf(vault, slug, doc)
                        # record it the way the panel's own compile does, so a save that
                        # breaks the PDF is already explained the next time Publish opens
                        paths = _writing_paths(vault, slug, doc)
                        if paths:
                            _note_compile_result(slug, doc, "pdf", _mt(paths[0]),
                                                 (res or {}).get("error") or "")
                except Exception:
                    pass
                with _bg_guard:
                    if _bg_last_save.get(key, 0.0) <= started:
                        return   # nothing newer arrived while compiling
        finally:
            with _bg_guard:
                _bg_active.discard(key)

    _bg_threading.Thread(target=_waiter, daemon=True, name="bg-compile").start()


def save(vault, slug, which, text, base_mtime=None, force=False, doc=DEFAULT_DOC,
         base_text=None):
    if which not in ("paper", "editor", "outline"):
        return {"error": "bad target"}
    if text is None:
        return {"error": "no text"}
    paths = _writing_paths(vault, slug, doc)
    if not paths:
        return {"error": "unknown paper"}
    p = paths[0] if which == "paper" else (paths[1] if which == "editor" else _outline_path(vault, slug, doc))
    old = None
    merged = False
    if p.exists():
        cur = _mt(p)
        if base_mtime is not None and cur != int(base_mtime):
            disk = _read(p) or ""
            if base_text is None:
                return {"conflict": True, "currentMtime": cur, "currentText": disk}
            submitted = text
            try:
                import merge3
                text, conflicted = merge3.merge_text(base_text, text, disk)
            except Exception:
                conflicted = True
            if conflicted:
                return {"conflict": True, "currentMtime": cur, "currentText": disk}
            merged = text != submitted
        old = _read(p)
    _atomic_write(p, old, text, label=which)
    if which == "paper":
        _maybe_auto_checkpoint(vault, slug, doc)
        _bg_compile_soon(vault, slug, doc)
        try:
            import audit_index
            audit_index.refresh_project(vault, slug, min_interval_ms=6000)
        except Exception:
            pass
    res = {"ok": True, "mtime": _mt(p), "rel": _rel(vault, p)}
    if merged:
        # the caller's on-screen text is NOT what is now on disk — hand back the
        # merged document so the editor adopts it instead of drifting from the file
        res["merged"] = True
        res["text"] = text
    return res


def sync_editor(vault, slug, base_mtime=None, force=False, doc=DEFAULT_DOC):
    paths = _writing_paths(vault, slug, doc)
    if not paths:
        return {"error": "unknown paper"}
    paper_p, editor_p = paths
    if not paper_p.exists():
        return {"error": "paper.md not found"}
    paper_text = _read(paper_p) or ""
    existing = _read(editor_p) if editor_p.exists() else None
    if editor_p.exists() and base_mtime is not None and not force:
        cur = _mt(editor_p)
        if cur != int(base_mtime):
            return {"conflict": True, "currentMtime": cur, "currentText": existing or ""}
    merged = build_skeleton(paper_text, existing, _paper_title(paper_text, slug))
    _atomic_write(editor_p, existing, merged, label="editor")
    return {"ok": True, "editor": {"text": merged, "mtime": _mt(editor_p),
                                   "rel": _rel(vault, editor_p)}}


OUTLINE_DEFAULT = "outline.md"

_OUTLINE_INTRO = (
    "> Plan the paper here. The locked thesis and core themes keep every section "
    "coherent; each section note says what that section must accomplish. Section "
    "headings track paper.md — Sync to refresh them. Edit here or in Obsidian.")


def _outline_name(docname):
    docname = (docname or DEFAULT_DOC).strip().lower()
    return OUTLINE_DEFAULT if docname == DEFAULT_DOC else docname[:-3] + ".outline.md"


def _outline_path(vault, slug, doc=DEFAULT_DOC):
    paths = _writing_paths(vault, slug, doc)
    if not paths:
        return None
    return paths[1].parent / _outline_name(doc)


def _canon(s):
    return re.sub(r"\s+", " ", (s or "")).strip().lower()


_H1 = re.compile(r"^#\s+(.*?)\s*$")


def parse_outline(text):
    thesis, themes, journal, sections = [], [], [], []
    extras, intro = [], []
    mode = None          # None | 'thesis' | 'journal' | 'themes' | 'sections' | 'extra'
    cur = None
    extra = None
    h1n = 0

    def flush():
        nonlocal cur
        if cur is not None:
            cur["plan"] = "\n".join(cur.pop("_plan")).strip("\n").strip()
            sections.append(cur)
            cur = None

    def flush_extra():
        nonlocal extra
        if extra is not None:
            body = "\n".join(extra["_body"]).strip("\n").strip()
            if body:                          # the title h1 holds no body -> not an extra
                extras.append({"heading": extra["heading"], "body": body})
            extra = None

    for raw in (text or "").split("\n"):
        h1 = _H1.match(raw)
        if h1:
            flush()
            flush_extra()
            h1n += 1
            t = _canon(h1.group(1))
            if t == "thesis":
                mode = "thesis"
            elif t in ("target journal", "journal"):
                mode = "journal"
            elif t in ("concepts", "core themes", "themes", "themes / contributions", "contributions"):
                mode = "themes"
            elif t in ("sections", "outline", "section plan"):
                mode = "sections"
            else:
                mode = "extra"
                extra = {"heading": h1.group(1).strip(), "_body": []}
            continue
        h23 = _HEADING.match(raw)
        if h23 and mode == "sections":
            flush()
            cur = {"level": len(h23.group(1)), "heading": h23.group(2).strip(), "_plan": []}
            continue
        if mode == "thesis":
            thesis.append(raw)
        elif mode == "journal":
            journal.append(raw)
        elif mode == "themes":
            themes.append(raw)
        elif mode == "sections" and cur is not None:
            cur["_plan"].append(raw)
        elif mode == "extra" and extra is not None:
            # the intro blockquote sits under the FIRST h1 (the title), nowhere else
            if h1n == 1 and raw.strip().startswith(">"):
                intro.append(raw.strip())
            else:
                extra["_body"].append(raw)
    flush()
    flush_extra()
    return {
        "thesis": "\n".join(thesis).strip("\n").strip(),
        "targetJournal": "\n".join(journal).strip("\n").strip(),
        "themes": "\n".join(themes).strip("\n").strip(),
        "sections": [{"level": s["level"], "heading": s["heading"], "plan": s["plan"]} for s in sections],
        "extras": extras,
        "intro": "\n".join(intro).strip(),
    }


def serialize_outline(thesis, themes, sections, title=None, target_journal="",
                      extras=None, intro=None):
    o = ["---", "type: outline", "---", "", "# " + (title or "Untitled") + " — outline",
         "", (intro or "").strip() or _OUTLINE_INTRO, ""]

    def block(heading, body):
        o.append("# " + heading)
        o.append("")
        if (body or "").strip():
            o.append(body.strip())
            o.append("")

    for x in (extras or []):
        if (x.get("body") or "").strip():
            block(x.get("heading") or "Note", x["body"])
    block("Thesis", thesis)
    block("Target journal", target_journal)
    block("Concepts", themes)
    o.append("# Sections")
    o.append("")
    for s in sections:
        o.append(("###" if s.get("level") == 3 else "##") + " " + s["heading"])
        o.append("")
        if (s.get("plan") or "").strip():
            o.append(s["plan"].strip())
            o.append("")
    return "\n".join(o).rstrip() + "\n"


def build_outline(paper_text, existing=None, title=None):
    prev = parse_outline(existing) if existing else {"thesis": "", "targetJournal": "", "themes": "",
                                                     "sections": [], "extras": [], "intro": ""}
    plan_by = {}
    for s in prev["sections"]:
        plan_by.setdefault(_canon(s["heading"]), s)      # first occurrence wins
    out_sections, seen = [], set()
    for kind, val in parse_paper(paper_text):
        if kind not in ("h2", "h3"):
            continue
        key = _canon(val)
        if key in seen:                                  # duplicate heading in the draft
            continue
        seen.add(key)
        prevs = plan_by.get(key)
        out_sections.append({"level": 2 if kind == "h2" else 3, "heading": val,
                             "plan": prevs["plan"] if prevs else ""})
    for s in prev["sections"]:
        key = _canon(s["heading"])
        if key in seen:
            continue
        seen.add(key)
        if (s["plan"] or "").strip():                    # keep planned/removed only if it has planning
            out_sections.append({"level": s["level"], "heading": s["heading"], "plan": s["plan"]})
    return serialize_outline(prev["thesis"], prev["themes"], out_sections, title,
                             target_journal=prev.get("targetJournal", ""),
                             extras=prev.get("extras"), intro=prev.get("intro"))


def _outline_payload(vault, slug, paper_p, op, text, generated):
    parsed = parse_outline(text)
    return {
        "slug": slug, "doc": paper_p.name, "title": _paper_title(_read(paper_p) or "", slug),
        "outline": {"text": text, "mtime": _mt(op), "rel": _rel(vault, op), "generated": generated},
        "thesis": parsed["thesis"], "targetJournal": parsed.get("targetJournal", ""),
        "themes": parsed["themes"], "sections": parsed["sections"],
        "extras": parsed.get("extras", []), "intro": parsed.get("intro", ""),
    }


def read_outline(vault, slug, doc=DEFAULT_DOC):
    paths = _writing_paths(vault, slug, doc)
    if not paths:
        return {"error": "unknown paper"}
    paper_p, editor_p = paths
    if not paper_p.exists():
        return {"error": paper_p.name + " not found"}
    _migrate_sidecars(editor_p.parent.parent)   # sweep legacy writing/-root sidecars -> versioning/
    op = _outline_path(vault, slug, doc)
    paper_text = _read(paper_p) or ""
    title = _paper_title(paper_text, slug)
    if op.exists():
        text = _read(op) or ""
        generated = False
    else:
        text = build_outline(paper_text, None, title)
        _atomic_write(op, None, text, label="outline")
        generated = True
    return _outline_payload(vault, slug, paper_p, op, text, generated)


def sync_outline(vault, slug, base_mtime=None, force=False, doc=DEFAULT_DOC):
    paths = _writing_paths(vault, slug, doc)
    if not paths:
        return {"error": "unknown paper"}
    paper_p, _ = paths
    if not paper_p.exists():
        return {"error": "paper.md not found"}
    op = _outline_path(vault, slug, doc)
    paper_text = _read(paper_p) or ""
    existing = _read(op) if op.exists() else None
    if op.exists() and base_mtime is not None and not force:
        cur = _mt(op)
        if cur != int(base_mtime):
            return {"conflict": True, "currentMtime": cur, "currentText": existing or ""}
    merged = build_outline(paper_text, existing, _paper_title(paper_text, slug))
    _atomic_write(op, existing, merged, label="outline")
    return {"ok": True, "outline": {"text": merged, "mtime": _mt(op), "rel": _rel(vault, op)},
            "sections": parse_outline(merged)["sections"]}


_CONCEPTS_DIR = ("Preparation", "Notes", "Concepts")


def concept_slug(name):
    return re.sub(r"[^a-z0-9]+", "-", (name or "").strip().lower()).strip("-")


def _concept_path(vault, name_or_slug):
    slug = concept_slug(name_or_slug)
    if not slug:
        return None
    d = (vault / Path(*_CONCEPTS_DIR)).resolve()
    p = (d / (slug + ".md")).resolve()
    try:
        p.relative_to(d)
    except ValueError:
        return None
    return p


def _concept_name_from(text, slug):
    """The display name of a concept note: a frontmatter `title:`, else the first H1,
    else the de-slugged name."""
    m = re.search(r"^title\s*:\s*(.+?)\s*$", _frontmatter(text or ""), re.M)
    if m:
        return m.group(1).strip().strip('"\'')
    h = re.search(r"^#\s+(.*?)\s*$", text or "", re.M)
    if h:
        return h.group(1).strip()
    return (slug or "").replace("-", " ")


def concept_scaffold(name):
    name = (name or "Concept").strip()
    today = time.strftime("%Y-%m-%d")
    return ("---\ntitle: " + name + "\ntype: concept\ncreated: " + today +
            "\ntags:\n  - concept\n---\n\n# " + name +
            "\n\n## Definition\n\n\n## Applications\n\n\n## Related\n\n")


def list_concepts(vault):
    d = vault / Path(*_CONCEPTS_DIR)
    out = []
    if not d.is_dir():
        return out
    for p in sorted(d.glob("*.md")):
        txt = _read(p) or ""
        body = re.sub(r"^---.*?---", "", txt, count=1, flags=re.S)
        out.append({"slug": p.stem, "name": _concept_name_from(txt, p.stem),
                    "rel": _rel(vault, p), "mtime": _mt(p), "words": _wordcount(body)})
    out.sort(key=lambda c: c["name"].lower())
    return out


def read_concept(vault, name_or_slug, name=None):
    """A concept note's text + metadata. When the note doesn't exist yet, return a
    scaffold (seeded with `name` or the de-slugged slug) and exists=False — the UI shows
    it; the file is created on first save."""
    p = _concept_path(vault, name_or_slug)
    if p is None:
        return {"error": "bad concept"}
    slug = p.stem
    if p.exists():
        txt = _read(p) or ""
        return {"slug": slug, "name": _concept_name_from(txt, slug), "text": txt,
                "exists": True, "rel": _rel(vault, p), "mtime": _mt(p)}
    disp = (name or "").strip() or slug.replace("-", " ")
    return {"slug": slug, "name": disp, "text": concept_scaffold(disp),
            "exists": False, "rel": _rel(vault, p), "mtime": 0}


def save_concept(vault, name_or_slug, text, base_mtime=None, force=False):
    p = _concept_path(vault, name_or_slug)
    if p is None:
        return {"error": "bad concept"}
    if text is None:
        return {"error": "no text"}
    old = None
    if p.exists():
        cur = _mt(p)
        if base_mtime is not None and not force and cur != int(base_mtime):
            return {"conflict": True, "currentMtime": cur, "currentText": _read(p) or ""}
        old = _read(p)
    _atomic_write(p, old, text, label="concept")
    return {"ok": True, "slug": p.stem, "rel": _rel(vault, p), "mtime": _mt(p)}


def _toolkit(vault):
    return Path(vault) / _TOOLKIT_REL


def vault_scripts_enabled():
    return bool(settings.RUN_VAULT_SCRIPTS)


def _native_run(argv, cwd, timeout, env=None):
    """Run one command as an argument list; never through a shell."""
    e = dict(os.environ if env is None else env)
    e.setdefault("PYTHONUTF8", "1")
    e.setdefault("PYTHONIOENCODING", "utf-8")
    return subprocess.run([str(a) for a in argv], cwd=str(cwd), capture_output=True, text=True,
                          encoding="utf-8", errors="replace", timeout=timeout, env=e)


def _native_tool(name):
    return shutil.which(name)


def _run_steps(steps, timeout):
    """Run (argv, cwd[, env]) steps in order, stopping at the first failure. Returns the
    last return code with the output of every step joined."""
    out, err, code = [], [], 0
    for step in steps:
        r = _native_run(step[0], step[1], timeout, env=step[2] if len(step) > 2 else None)
        out.append(r.stdout or "")
        err.append(r.stderr or "")
        code = r.returncode
        if code != 0:
            break
    return subprocess.CompletedProcess([], code, stdout="".join(out), stderr="".join(err))


def _tex_env(toolkit, wdir):
    env = dict(os.environ)
    env["TEXINPUTS"] = "{}//:{}//:{}".format(toolkit / "report-templates" / "latex", wdir, env.get("TEXINPUTS", ""))
    return env


def _draft_phase_a_native(proj, kit, doc, timeout):
    pandoc = _native_tool("pandoc")
    if not pandoc:
        return {"error": "pandoc is not installed (needed for PDF drafts)"}
    build = proj / "writing" / "build"
    m2l = str(kit / "scripts" / "md_to_latex.py")
    r = _run_steps([
        ([sys.executable, m2l, "writing/" + doc, "--project-dir", str(proj),
          "--strip-metadata", "-o", "writing/build/preprocessed.md"], proj),
        ([pandoc, "preprocessed.md", "-f", "markdown", "-t", "latex", "--wrap=none",
          "--shift-heading-level-by=-1", "-o", "body.tex"], build),
        ([sys.executable, m2l, "dummy", "--postprocess-tex", "body.tex"], build),
    ], timeout)
    if r.returncode != 0:
        out = [l for l in ((r.stdout or "") + "\n" + (r.stderr or "")).splitlines()
               if "FAILURE" in l or "rror" in l]
        return {"ok": False, "reason": "preprocess-failed",
                "error": "draft preprocessing failed (md_to_latex/pandoc) — no body.tex was built",
                "log": (out or (r.stderr or r.stdout or "").splitlines())[-25:]}
    return r


def _draft_phase_b_native(proj, kit, build, job, figures_job, base, timeout):
    pdflatex = _native_tool("pdflatex")
    if not pdflatex:
        return {"error": "pdflatex is not installed"}
    env = _tex_env(kit, build.parent)

    def _twice(stem):
        for _ in range(2):
            _native_run([pdflatex, "-no-shell-escape", "-interaction=nonstopmode", stem + ".tex"], build, timeout, env=env)

    _twice(job.stem)
    lines = []
    try:
        for l in (build / (job.stem + ".log")).read_text(encoding="utf-8", errors="replace").splitlines():
            if l.startswith("! ") or "LaTeX Error" in l or "Undefined control" in l:
                lines.append(l)
                if len(lines) >= 20:
                    break
    except OSError:
        pass
    pdf = build / (job.stem + ".pdf")
    if pdf.exists():
        shutil.copyfile(pdf, proj / "writing" / (base + ".pdf"))
    if figures_job:
        _twice(figures_job.stem)
        fpdf = build / (figures_job.stem + ".pdf")
        if fpdf.exists():
            shutil.copyfile(fpdf, proj / "writing" / (base + ".figures.pdf"))
    return subprocess.CompletedProcess([], 0, stdout="\n".join(lines), stderr="")


def _find_wrapper(build_dir, base=None):
    if not build_dir.is_dir():
        return None
    if base and _is_wrapper_tex(build_dir / (base + ".tex")):
        return build_dir / (base + ".tex")
    for named in ("paper.tex", "proposal.tex", "report.tex"):
        if _is_wrapper_tex(build_dir / named):
            return build_dir / named
    for c in sorted(build_dir.glob("*.tex")):
        if (c.name in ("body.tex", "preprocessed.tex")
                or c.name.startswith(("tab", "fig"))
                or c.name.endswith((".body.tex", ".pre.tex", ".draftpub.tex",
                                    ".altspace.tex", ".figures.tex"))):
            continue
        if _is_wrapper_tex(c):
            return c
    return None


_WRAPPER_DOCCLASS_RE = re.compile(r"^[ \t]*\\documentclass\b", re.M)


def _is_wrapper_tex(path):
    """True when `path` is a standalone LaTeX document: an existing file with an
    uncommented \\documentclass line. Fragments (tables, figures, bodies) have none."""
    try:
        if not path.is_file():
            return False
        with open(path, "r", encoding="utf-8", errors="ignore") as fh:
            head = fh.read(65536)
    except OSError:
        return False
    return bool(_WRAPPER_DOCCLASS_RE.search(head))


def _pdf_sig(path):
    """(mtime_ns, size) of a file, or None when it is missing — the before/after
    fingerprint that tells a freshly written PDF from a stale one."""
    try:
        st = path.stat()
    except OSError:
        return None
    return (st.st_mtime_ns, st.st_size)


_DOCCLASS_RE = re.compile(r"\\documentclass\s*(?:\[(?P<opts>[^\]]*)\])?\s*\{(?P<cls>[^}]*)\}")
_EDITABLE_CLASSES = {"asa-manuscript"}


def parse_documentclass(text):
    """{'cls': name, 'options': [tokens]} from the first \\documentclass line, or None."""
    m = _DOCCLASS_RE.search(text or "")
    if not m:
        return None
    opts = [o.strip() for o in (m.group("opts") or "").split(",") if o.strip()]
    return {"cls": m.group("cls").strip(), "options": opts}


_JOURNAL_STYLES = [
    ("working",       "Working paper",                          "working", "asa-working"),
    ("asr",           "American Sociological Review (ASR)",     "asr",     "social-forces"),
    ("ajs",           "American Journal of Sociology (AJS)",    "ajs",     "social-forces"),
    ("social-forces", "Social Forces",                          "asr",     "social-forces"),
    ("smh",           "Society and Mental Health (SMH)",        "smh",     "social-forces"),
    ("jhsb",          "Journal of Health and Social Behavior (JHSB)", "jhsb", "social-forces"),
    ("spq",           "Social Psychology Quarterly (SPQ)",      "spq",     "social-forces"),
    ("socius",        "Socius",                                 "asr",     "social-forces"),
    ("soc-theory",    "Sociological Theory",                    "asr",     "social-forces"),
    ("esr",           "European Sociological Review",           "asr",     "social-forces"),
    ("ser",           "Socio-Economic Review",                  "asr",     "social-forces"),
    ("work-occ",      "Work and Occupations",                   "asr",     "social-forces"),
    ("wes",           "Work, Employment and Society",           "asr",     "social-forces"),
]
_JOURNAL_CLS = {v: cls for v, _l, cls, _d in _JOURNAL_STYLES}
_JOURNAL_DOCX = {v: docx for v, _l, _c, docx in _JOURNAL_STYLES}

_JOURNALS_DIR = (*Path(_TOOLKIT_REL).parts, "journals")
_JOURNAL_DOC_EXTS = (".md", ".txt")


def _journal_docs(jdir):
    return sorted((f.name for f in jdir.iterdir()
                   if f.is_file() and f.suffix.lower() in _JOURNAL_DOC_EXTS), key=str.lower)


def _default_journal_doc(files):
    """Pick which doc to show first for a journal: a distilled submission checklist beats
    raw guidelines, which beats anything else; ties break by name."""
    def score(f):
        low = f.lower()
        if "checklist" in low:
            return 0
        if "guideline" in low or "instruction" in low:
            return 1
        return 2
    return sorted(files, key=lambda f: (score(f), f.lower()))[0] if files else None


def list_journals(vault):
    """Every journal in the toolkit journals folder, each with its renderable docs and the doc
    to show first — the picker for the publication-checklist viewer. Journals with no
    renderable doc (PDF-only) are still listed so every target journal is selectable."""
    root = (vault / Path(*_JOURNALS_DIR)).resolve()
    out = []
    if not root.is_dir():
        return out
    for d in sorted(root.iterdir(), key=lambda p: p.name.lower()):
        if not d.is_dir():
            continue
        files = _journal_docs(d)
        out.append({"name": d.name,
                    "docs": [{"file": f, "label": Path(f).stem} for f in files],
                    "default": _default_journal_doc(files)})
    return out


def read_journal_doc(vault, name, file=None):
    """Return the markdown of one journal doc (checklist/guidelines), path-confined to the
    journals KB. file defaults to that journal's best checklist doc; a PDF-only journal
    returns a pointer to where its official guidelines live."""
    root = (vault / Path(*_JOURNALS_DIR)).resolve()
    name = (name or "").strip()
    if not name or "/" in name or "\\" in name or ".." in name:
        return {"error": "bad journal"}
    jdir = (root / name).resolve()
    try:
        jdir.relative_to(root)
    except ValueError:
        return {"error": "bad journal"}
    if not jdir.is_dir():
        return {"error": "not found"}
    files = _journal_docs(jdir)
    file = (file or "").strip() or _default_journal_doc(files)
    if not file:
        # no renderable doc — point to whatever guideline files DO exist (usually a PDF)
        others = sorted((f.name for f in jdir.iterdir()
                         if f.is_file() and f.suffix.lower() not in _JOURNAL_DOC_EXTS), key=str.lower)
        body = "## " + name + "\n\nNo distilled checklist has been written for this journal yet.\n\n"
        if others:
            body += ("The official guidelines live in `journals/" + name + "/`:\n\n"
                     + "\n".join("- " + o for o in others))
        else:
            body += ("Clip the official author guidelines and write a `Submission checklist.md` into "
                     "`journals/" + name + "/`.")
        return {"name": name, "file": None, "label": name, "markdown": body, "docs": []}
    if file not in files:
        return {"error": "bad doc"}
    p = (jdir / file).resolve()
    try:
        p.relative_to(root)
    except ValueError:
        return {"error": "bad doc"}
    return {"name": name, "file": file, "label": Path(file).stem,
            "markdown": _read(p),
            "docs": [{"file": f, "label": Path(f).stem} for f in files]}


CHECKLIST_TEMPLATE = "Checklist template.md"
_CHECKLIST_MAX = 200_000
_CHECKLIST_LOCK = threading.Lock()


def _checklist_path(vault, slug):
    paths = _writing_paths(vault, slug, DEFAULT_DOC)
    if not paths:
        return None
    return paths[0].parent / "versioning" / "checklist.md"


def read_checklist(vault, slug):
    p = _checklist_path(vault, slug)
    if p is None:
        return {"error": "unknown paper"}
    text = _read(p) if p.is_file() else None
    return {"ok": True, "text": text or "", "exists": text is not None, "mtime": _mt(p) if text is not None else 0}


def _checklist_text_ok(text):
    if not isinstance(text, str):
        return "text required"
    if "\x00" in text:
        return "bad text"
    if len(text) > _CHECKLIST_MAX:
        return "checklist too long"
    return None


def save_checklist(vault, slug, text, base_mtime=None):
    bad = _checklist_text_ok(text)
    if bad:
        return {"error": bad}
    p = _checklist_path(vault, slug)
    if p is None or not p.parent.parent.is_dir():
        return {"error": "unknown paper"}
    with _CHECKLIST_LOCK:
        old = _read(p) if p.is_file() else None
        cur = _mt(p) if old is not None else 0
        try:
            base = None if base_mtime is None else int(base_mtime or 0)
        except (TypeError, ValueError):
            return {"error": "bad baseMtime"}
        if base is not None and base != cur:
            return {"error": "stale", "text": old or "", "mtime": cur}
        _atomic_write(p, old, text, label="checklist")
        return {"ok": True, "mtime": _mt(p)}


def list_checklist_sources(vault, slug=""):
    """What a checklist can pull from: every journal in the KB (with its docs, the tailored
    template flagged) and every other paper or grant that has a checklist."""
    journals = [{"name": j["name"], "docs": j["docs"], "default": j["default"],
                 "template": any(d["file"] == CHECKLIST_TEMPLATE for d in j["docs"])}
                for j in list_journals(vault)]
    me = _canon_slug(vault, slug) if slug else ""
    papers = []
    for tree in ("papers", "grants"):
        root = vault / "Projects" / tree
        if not root.is_dir():
            continue
        for d in sorted(root.iterdir(), key=lambda x: x.name.lower()):
            if not settings.live_slug(d.name):
                continue
            p = d / "writing" / "versioning" / "checklist.md"
            s = settings.live_slug(d.name)
            if s == me or not p.is_file():
                continue
            n = len(re.findall(r"^\s*[-*+]\s+\[[ xX]\]", _read(p) or "", re.M))
            if not n:
                continue
            papers.append({"slug": s, "kind": tree[:-1], "items": n})
    return {"journals": journals, "papers": papers}


def save_checklist_template(vault, journal, text):
    bad = _checklist_text_ok(text)
    if bad:
        return {"error": bad}
    root = (vault / Path(*_JOURNALS_DIR)).resolve()
    name = (journal or "").strip() if isinstance(journal, str) else ""
    if not name or "/" in name or "\\" in name or ".." in name or "\x00" in name:
        return {"error": "bad journal"}
    jdir = (root / name).resolve()
    try:
        jdir.relative_to(root)
    except ValueError:
        return {"error": "bad journal"}
    if not jdir.is_dir():
        return {"error": "not found"}
    p = jdir / CHECKLIST_TEMPLATE
    with _CHECKLIST_LOCK:
        old = _read(p) if p.is_file() else None
        _atomic_write(p, old, text, label="checklist-template")
    return {"ok": True, "file": CHECKLIST_TEMPLATE}


SUGGESTED_STATUSES = ("open", "dismissed")
_SUGGESTED_MAX = 2_000_000
_SUGGESTED_LOCK = threading.Lock()
_SUGGESTED_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def _suggested_path(vault, slug):
    paths = _writing_paths(vault, slug, DEFAULT_DOC) or _writing_paths(vault, slug, "letter.md")
    if not paths:
        return None
    return paths[0].parent / "versioning" / "suggested-paragraphs.json"


def _load_suggested(p):
    """The parsed store, or None when it is missing, too big or not the expected shape."""
    try:
        if not p.is_file() or p.stat().st_size > _SUGGESTED_MAX:
            return None
        obj = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(obj, dict) or not isinstance(obj.get("suggestions"), list):
        return None
    return obj


def read_suggested(vault, slug):
    p = _suggested_path(vault, slug)
    if p is None:
        return {"error": "unknown paper"}
    obj = _load_suggested(p)
    out = []
    for s in (obj or {}).get("suggestions", []):
        if not isinstance(s, dict):
            continue
        sid, text = s.get("id"), s.get("text")
        if not isinstance(sid, str) or not _SUGGESTED_ID.match(sid) or not isinstance(text, str) or not text.strip():
            continue
        status = s.get("status") if s.get("status") in SUGGESTED_STATUSES else "open"
        src = s.get("sources") if isinstance(s.get("sources"), list) else []
        tweaks = []
        if s.get("adopted") is True and isinstance(s.get("tweaks"), list):
            for t in s["tweaks"][:40]:
                if isinstance(t, dict) and isinstance(t.get("text"), str) and t["text"].strip() and t["text"] in text:
                    tweaks.append({"text": t["text"],
                                   "was": t.get("was") if isinstance(t.get("was"), str) else "",
                                   "why": t.get("why") if isinstance(t.get("why"), str) else ""})
        out.append({"id": sid, "after": s.get("after") if isinstance(s.get("after"), str) else "",
                    "anchor": s.get("anchor") if isinstance(s.get("anchor"), str) else "",
                    "text": text, "sources": [x for x in src if isinstance(x, str)],
                    "created": s.get("created") if isinstance(s.get("created"), str) else "",
                    "status": status, "adopted": s.get("adopted") is True, "tweaks": tweaks})
    return {"ok": True, "suggestions": out, "mtime": _mt(p) if obj is not None else 0}


def set_suggested_status(vault, slug, sid, status):
    """Set one suggestion's `status` (open | dismissed); every other byte of meaning in the
    store is left as it was. Writes only writing/versioning/suggested-paragraphs.json."""
    if status not in SUGGESTED_STATUSES:
        return {"error": "bad status"}
    if not isinstance(sid, str) or not _SUGGESTED_ID.match(sid):
        return {"error": "bad id"}
    p = _suggested_path(vault, slug)
    if p is None:
        return {"error": "unknown paper"}
    with _SUGGESTED_LOCK:
        obj = _load_suggested(p)
        if obj is None:
            return {"error": "no suggestions"}
        hit = next((s for s in obj["suggestions"] if isinstance(s, dict) and s.get("id") == sid), None)
        if hit is None:
            return {"error": "not found"}
        hit["status"] = status
        tmp = Path(str(p) + ".tmp")
        tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.replace(str(tmp), str(p))
    return {"ok": True, "id": sid, "status": status}


def _asa_state_from_options(opts):
    o = {x.lower() for x in opts}
    fmt = next((t for t in ("smh", "jhsb", "spq", "asr", "ajs") if t in o), "working")
    blind = "blind" in o or fmt == "spq"      # spq forces blind in the class
    if "figuresatend" in o:
        figs = "atend"
    elif "inline" in o:
        figs = "inline"
    elif blind:
        figs = "atend"
    else:
        figs = "inline"
    return {"format": fmt, "blind": blind, "endnotes": "endnotes" in o,
            "figures": figs}


def _compose_asa_options(state):
    toks = []
    fmt = (state.get("format") or "").lower()
    # map the chosen journal to the .cls style token (journals beyond ASR/AJS use the
    # closest ASA style the class defines); unknown/empty falls through to no token.
    cls_tok = _JOURNAL_CLS.get(fmt)
    if cls_tok:
        toks.append(cls_tok)
    if state.get("blind"):
        toks.append("blind")
    if state.get("endnotes"):
        toks.append("endnotes")
    figs = (state.get("figures") or "").lower()
    toks.append("figuresatend" if figs in ("atend", "figuresatend", "end") else "inline")
    return toks


def _swap_documentclass_options(text, tokens):
    """Return `text` with the first \\documentclass option list replaced by `tokens`,
    preserving the class name and the rest of the wrapper byte-for-byte."""
    optstr = ("[" + ",".join(tokens) + "]") if tokens else ""
    return _DOCCLASS_RE.sub(
        lambda m: "\\documentclass" + optstr + "{" + m.group("cls").strip() + "}",
        text, count=1)


_TEMPLATES = [
    ("asa-manuscript", "ASA manuscript", "Sociology journals (ASR, AJS) and working papers."),
    ("sagej",          "SAGE journal",   "Work and Occupations and other SAGE titles."),
    ("proposal",       "Proposal",       "Dissertation / grant proposals."),
    ("thesis",         "Thesis / dissertation", "Long-form thesis layout."),
    ("long-report",    "Long report",    "Multi-section reports."),
    ("prof-brief",     "Professor brief", "Short briefing notes."),
    ("qualitative",    "Qualitative",    "Qualitative manuscripts."),
    ("book-draft",     "Book draft",     "Book-length drafts."),
]


def available_templates(detected=None):
    """The Template-picker list: every toolkit class, the detected one always present and
    first, each flagged for whether this panel can compile it live (asa-manuscript only)."""
    seen = {c for c, _, _ in _TEMPLATES}
    rows = []
    if detected and detected not in seen:
        rows.append({"cls": detected, "label": detected, "hint": "Set up for this paper.",
                     "live": detected in _EDITABLE_CLASSES})
    for cls, label, hint in _TEMPLATES:
        rows.append({"cls": cls, "label": label, "hint": hint, "live": cls in _EDITABLE_CLASSES})
    # float the detected class to the top so it reads as the default
    rows.sort(key=lambda r: (r["cls"] != detected, 0))
    return rows


_FLOAT_RE = re.compile(r"\\begin\{(figure|table)\*?\}.*?\\end\{\1\*?\}", re.S)
_TABLE_BLOCK_RE = re.compile(
    r"\\par\\addvspace\{[^}]*\}\\noindent\s*\\input\{[^}]+\}\s*\\par\\addvspace\{[^}]*\}")


_FLOAT_LABEL_RE = re.compile(r"\\textbf\{\s*(Figure|Table)\s+([A-Za-z]?\d+[\w.]*?)\.?\s*\}")
_TABLE_INPUT_RE = re.compile(r"\\input\{([^}]+)\}")


def _float_marker(block, label_of=None):
    m = _FLOAT_LABEL_RE.search(block)
    if m:
        kind, num = m.group(1), m.group(2)
    else:
        im = _TABLE_INPUT_RE.search(block) if _TABLE_BLOCK_RE.fullmatch(block.strip()) else None
        if not im:
            return ""
        kind, num = "Table", (label_of(im.group(1)) if label_of else None)
        if not num:
            dm = re.search(r"tab(\d+)", im.group(1))
            num = str(int(dm.group(1))) if dm else None
        if not num:
            return ""
    return "\\insert%shere{%s}" % (kind.lower(), num)


def split_floats(body_text, tables_only=False, label_of=None):
    text = body_text or ""
    floats = [(m.start(), m.end()) for m in _FLOAT_RE.finditer(text)]
    tabs = [(m.start(), m.end()) for m in _TABLE_BLOCK_RE.finditer(text)
            if not any(a <= m.start() < b for a, b in floats)]   # inside a float: stays with it
    spans = sorted(tabs if tables_only else floats + tabs)
    blocks = [text[a:b] for a, b in spans]
    # replace the blocks by their markers; tidy the doubled blank lines left behind
    for (a, b), blk in zip(reversed(spans), reversed(blocks)):
        mk = _float_marker(blk, label_of)
        text = text[:a] + ("\n\n" + mk + "\n\n" if mk else "") + text[b:]
    text_only = re.sub(r"\n{3,}", "\n\n", text)
    return text_only, blocks


def _inline_body(wrapper_text, build_dir):
    """A self-contained copy of a wrapper: its `\\input{<name>}` replaced by the actual
    file content from build/, so the archived .tex needs no sibling body file. Leaves the
    text untouched if the input file can't be read."""
    def repl(m):
        name = m.group(1)
        f = build_dir / (name if name.endswith(".tex") else name + ".tex")
        try:
            return "% --- inlined " + f.name + " ---\n" + f.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            return m.group(0)
    return re.sub(r"\\input\{([^}]+)\}", repl, wrapper_text or "")


def _floats_doc(wrapper_text, tokens, floats):
    head = _swap_documentclass_options(wrapper_text, tokens)
    marker = "\\begin{document}"
    i = head.find(marker)
    preamble = head[:i + len(marker)] if i != -1 else head + "\n" + marker
    body = "\n\n\\clearpage\n\n".join(b.strip() for b in floats)
    return preamble + "\n\n" + body + "\n\n\\end{document}\n"


def _tex_sig(options):
    """A short filesystem-safe signature for a variant's documentclass options, e.g.
    'asr-blind-figsep' — names the archived .tex so variants don't collide."""
    if not options:
        return ""
    parts = []
    fmt = (options.get("format") or "").lower()
    if fmt in _JOURNAL_CLS:
        parts.append(fmt)
    if options.get("blind"):
        parts.append("blind")
    if options.get("endnotes"):
        parts.append("endnotes")
    figs = (options.get("figures") or "").lower()
    parts.append({"atend": "figatend", "separate": "figsep"}.get(figs, "inline"))
    return "-".join(parts)


# ---- default build wrapper ---------------------------------------------------


_WRAPPER_AUTHOR = settings.AUTHOR_NAME
_WRAPPER_AFFIL = settings.AUTHOR_AFFILIATION

_WRAPPER_TEMPLATE = r"""% Build wrapper for writing/@DOC@ -- the file the Publish panel compiles.
%
% This is a WRAPPER, not the manuscript. The prose lives in writing/@DOC@ and is
% regenerated into body.tex on every build (markdown -> pandoc -> body.tex). Never
% paste prose in here and never hand-edit body.tex: the next Publish overwrites it.
%
% Created automatically when this manuscript was first published from the board, so
% The documentclass options below are rewritten for
% you by the Publish panel's Template / Blind / Figures toggles.
%
% asa-manuscript is loaded from the toolkit report-templates/latex folder via TEXINPUTS.
\documentclass[@OPTS@]{@CLS@}
\usepackage{longtable}
\usepackage{calc}
\usepackage{float}
\newcounter{none}
\graphicspath{{../../results/}}

% Title-page identity. \title is refreshed from the manuscript on every compile;
% nothing else reaches the PDF that is not in the .md.
\title{@TITLE@}
\author{@AUTHOR@}
\affil{@AFFIL@}
\runninghead{@RUNNING@}

\begin{document}
\maketitle
\input{body}
\end{document}
"""


def _running_head(title):
    """A short all-caps running head from the manuscript title (journals cap these)."""
    t = re.sub(r"\s+", " ", (title or "").strip())
    t = t.split(":", 1)[0]          # the main title; a subtitle is never cut mid-phrase
    t = re.sub(r"[^\w\s&-]", "", t)
    if len(t) > 60:
        t = t[:60].rsplit(" ", 1)[0]
    return t.upper() or "MANUSCRIPT"


def _ensure_wrapper(vault, slug, doc=DEFAULT_DOC, cls="asa-manuscript", opts="asr,inline"):
    """Write writing/build/<base>.tex when the manuscript has no wrapper yet, so Publish
    works on a brand-new paper with nothing to set up. Returns the wrapper Path, or None
    if one could not be written. Never overwrites an existing wrapper."""
    paths = _writing_paths(vault, slug, doc)
    if not paths:
        return None
    manu = paths[0]
    if not manu.exists():
        return None
    build = manu.parent / "build"
    existing = _find_wrapper(build, manu.name[:-3])
    if existing is not None:
        return existing
    try:
        build.mkdir(parents=True, exist_ok=True)
        md_text = manu.read_text(encoding="utf-8", errors="ignore")
        title = _paper_title(md_text, slug)
        fm = pub_options_from_fm(md_text)
        if fm and cls in _EDITABLE_CLASSES:
            # a new wrapper starts from what the manuscript's frontmatter asks for
            # ('separate' is a compile-time split, so the wrapper itself stays inline)
            st = _resolve_pub_state(_asa_state_from_options(opts.split(",")), md_text)
            if st.get("figures") == "separate":
                st["figures"] = "inline"
            opts = ",".join(_compose_asa_options(st))
        text = (_WRAPPER_TEMPLATE
                .replace("@DOC@", manu.name)
                .replace("@OPTS@", opts)
                .replace("@CLS@", cls)
                .replace("@TITLE@", _tex_escape_inline(title or slug))
                .replace("@AUTHOR@", _tex_escape_inline(_WRAPPER_AUTHOR))
                .replace("@AFFIL@", _tex_escape_inline(_WRAPPER_AFFIL))
                .replace("@RUNNING@", _tex_escape_inline(_running_head(title or slug))))
        # abstract / keywords / word count from the manuscript (each only when it has
        # one) — the same sync every compile runs, so the two never disagree
        text, _ = _sync_wrapper_meta(text, md_text, slug)
        target = build / (manu.name[:-3] + ".tex")
        _atomic_write(target, None, text, label="wrapper")
        return target
    except (OSError, ValueError):
        return None


_PREVIEW_ROOT = settings.STATE_DIR / "preview"


def _preview_docx_path(vault, slug, doc):
    """Where this document's preview-only Word build lives, outside the vault."""
    ap = _artifact_paths(vault, slug, doc)
    if not ap:
        return None
    key = hashlib.sha1(("%s\x00%s" % ((slug or "").strip().lower(),
                                      (doc or DEFAULT_DOC).strip().lower())
                        ).encode("utf-8")).hexdigest()[:16]
    return _PREVIEW_ROOT / key / ap[2].name


def _docx_preview_source(vault, slug, doc):
    ap = _artifact_paths(vault, slug, doc)
    if not ap:
        return None
    deliverable = ap[2]
    scratch = _preview_docx_path(vault, slug, doc)
    dm, sm = _mt(deliverable) or 0, (_mt(scratch) or 0) if scratch else 0
    if sm and sm > dm:
        return scratch
    if dm:
        return deliverable
    return scratch if sm else None


def _docx_preview_cached(docx):
    """The already-rendered LibreOffice preview PDF for this .docx, or None. The
    read-only half of _docx_to_pdf (same mtime-keyed name), for the polling endpoint:
    it never launches soffice."""
    if docx is None or not docx.exists():
        return None
    p = docx.parent / ".cache" / "{}.{}.pdf".format(docx.stem, int(_mt(docx) or 0))
    return p if p.exists() else None


def _log_tail(res, limit=60):
    """The last <=`limit` lines of a compiler result's output, as one string."""
    lines = []
    for key in ("log", "stderr"):
        v = (res or {}).get(key)
        if isinstance(v, list):
            lines += [str(x) for x in v]
        elif isinstance(v, str) and v.strip():
            lines += v.splitlines()
    return "\n".join(lines[-limit:])


def _stamp_freshness(vault, slug, doc, output, out):
    """Fill publish-setup's always-present freshness block from what is on disk now.
    Stats only — whatever needed building has been built by the caller."""
    ap = _artifact_paths(vault, slug, doc)
    manu, pdf, docx = ap if ap else (None, None, None)
    out["output"] = output
    out["mdMtime"] = _mt(manu) if manu is not None else 0
    # docxMtime always describes the DELIVERABLE writing/<base>.docx, never the
    # out-of-vault preview build — it is what a Download or an Open in Word gets.
    out["pdfMtime"] = (_mt(pdf) or None) if pdf is not None else None
    out["docxMtime"] = (_mt(docx) or None) if docx is not None else None
    if output == "docx":
        art = _docx_preview_cached(_docx_preview_source(vault, slug, doc))
    else:
        art = pdf if (pdf is not None and pdf.exists()) else None
    out["previewMtime"] = _mt(art) if art is not None else None
    out["previewPages"] = _pdf_pages_cached(art)
    out.setdefault("autoCompileError", "")
    out.setdefault("autoCompileLog", "")
    return out


def publish_setup(vault, slug, doc=DEFAULT_DOC, output="pdf"):
    """What the Publish panel needs to open: the detected template, whether its options
    are toggleable here, the option state currently set up for this paper (the default),
    and any already-compiled PDF. Returns {error} when the slug/doc is unknown."""
    doc = (doc or DEFAULT_DOC).strip().lower() or DEFAULT_DOC
    output = "docx" if (output or "pdf").strip().lower() == "docx" else "pdf"
    paths = _writing_paths(vault, slug, doc)
    # the freshness block is unconditional, including on the not-found exits, so the
    # panel can read output/mdMtime/previewPages off any reply without a shape check
    if not paths:
        return _stamp_freshness(vault, slug, doc, output,
                                {"slug": slug, "doc": doc, "error": "unknown paper"})
    manu = paths[0]
    if not manu.exists():
        return _stamp_freshness(vault, slug, doc, output,
                                {"slug": slug, "doc": doc, "error": manu.name + " not found"})
    proj = _proj_of_doc(manu)
    wdir = proj / "writing"
    base = manu.name[:-3]
    try:
        title = _paper_title(manu.read_text(encoding="utf-8", errors="ignore"), slug)
    except OSError:
        title = slug
    out = {"slug": slug, "doc": doc, "title": title, "vaultScripts": bool(settings.RUN_VAULT_SCRIPTS)}
    if _is_project_doc(doc):
        # README/PLAN are project documents, not manuscripts — nothing compiles;
        # the panel shows this reason and the frontend hides the Publish button
        out["ready"] = False
        out["projectDoc"] = True
        out["error"] = (PROJECT_DOCS[doc]["label"] + " is a project document, not a "
                        "manuscript — it is edited and commented here but never published.")
        return _stamp_freshness(vault, slug, doc, output, out)
    if _is_grant_project(proj):
        out.update(ready=True, lane="grant", editable=False, grant=True,
                   template="funder format (rules/compliance.json)")
        base_pdf = wdir / "pdf" / (base + ".pdf")
        base_docx = wdir / "docx" / (base + ".docx")
        stale = (output == "pdf"
                 and ((not base_pdf.exists() and not base_docx.exists())
                      or (_mt(manu) or 0) > max(_mt(base_pdf) or 0, _mt(base_docx) or 0)))
        if stale and settings.RUN_VAULT_SCRIPTS:
            with _CompileSlot(slug, doc, output):
                if ((not base_pdf.exists() and not base_docx.exists())
                        or (_mt(manu) or 0) > max(_mt(base_pdf) or 0, _mt(base_docx) or 0)):
                    res = _compile_grant(vault, proj, manu, 240)
                    err = res.get("error") if isinstance(res, dict) else "compile failed"
                    if err:
                        out["autoCompileError"] = err
                        out["autoCompileLog"] = _log_tail(res)
                    _note_compile_result(slug, doc, output, _mt(manu), err or "")
        if base_pdf.exists():
            out["pdfRel"] = _rel(vault, base_pdf)
            out["pdfMtime"] = _mt(base_pdf)
        if base_docx.exists():
            out["docxRel"] = _rel(vault, base_docx)
            out["docxMtime"] = _mt(base_docx)
        if not settings.RUN_VAULT_SCRIPTS:
            out["note"] = "Compiling is off: " + VAULT_SCRIPTS_OFF + "."
        elif not (wdir / "build" / "build.sh").exists():
            out["note"] = "This grant has no writing/build/build.sh, so it cannot be compiled here."
        elif not base_pdf.exists():
            out["note"] = "build.sh has not produced writing/pdf/" + base_pdf.name + " yet."
        _ensure_preview(vault, slug, doc, output, out)
        return _stamp_freshness(vault, slug, doc, output, out)
    brief_fmt = _lane_brief_format(manu)
    if brief_fmt:
        out.update(ready=True, lane="brief", editable=False, template=brief_fmt)
    else:
        wrapper = _find_wrapper(wdir / "build", base)
        if wrapper is None:
            wrapper = _ensure_wrapper(vault, slug, doc)
        if wrapper is None:
            out["ready"] = False
            out["error"] = ("This manuscript could not be set up for publishing automatically — "
                            "its writing/build/ folder could not be written.")
            return _stamp_freshness(vault, slug, doc, output, out)
        parsed = parse_documentclass(wrapper.read_text(encoding="utf-8", errors="ignore")) or {"cls": "", "options": []}
        cls = parsed["cls"]
        out.update(ready=True, wrapper=wrapper.name, cls=cls, template=cls,
                   editable=(cls in _EDITABLE_CLASSES), templates=available_templates(cls))
        if out["editable"]:
            md_text = _read(manu) or ""
            out["defaults"] = _resolve_pub_state(_asa_state_from_options(parsed["options"]), md_text)
            fm = pub_options_from_fm(md_text) or {}
            out["persisted"] = bool(fm)
            out["persistedKeys"] = sorted(fm)
    try:
        pdf_probe = wdir / (base + ".pdf")
        if not pdf_probe.exists() or (_mt(manu) or 0) > (_mt(pdf_probe) or 0):
            with _CompileSlot(slug, doc, "pdf"):
                if not pdf_probe.exists() or (_mt(manu) or 0) > (_mt(pdf_probe) or 0):
                    res = compile_pdf(vault, slug, doc)
                    err = res.get("error") if isinstance(res, dict) else "compile failed"
                    if err:
                        out["autoCompileError"] = err
                        out["autoCompileLog"] = _log_tail(res)
                    _note_compile_result(slug, doc, "pdf", _mt(manu), err or "")
    except Exception:
        pass   # never let the panel fail to open because a compile went wrong
    pdf = wdir / (base + ".pdf")
    if pdf.exists():
        out["pdfRel"] = _rel(vault, pdf)
        out["pdfMtime"] = _mt(pdf)
        try:
            pc = json.loads((wdir / "build" / "pagecounts.json").read_text(encoding="utf-8"))
            if pc.get("mdMtime") == _mt(manu):
                out["pagesBoth"] = pc.get("pagesBoth")
                out["spacing"] = pc.get("spacing")
        except Exception:
            pass
    _ensure_preview(vault, slug, doc, output, out)
    docx = wdir / (base + ".docx")
    if docx.exists():
        out["docxRel"] = _rel(vault, docx)
        out["docxMtime"] = _mt(docx)
    return _stamp_freshness(vault, slug, doc, output, out)


def _wrapper_state(manu):
    """The template state of a manuscript's LaTeX wrapper as compile_docx options
    ({format, blind, endnotes, figures}), or None (compile_docx defaults) when it has
    no parseable asa-manuscript wrapper."""
    try:
        w = _find_wrapper(manu.parent / "build", manu.name[:-3])
        parsed = parse_documentclass(w.read_text(encoding="utf-8", errors="ignore")) if w else None
    except OSError:
        return None
    if not parsed or parsed.get("cls") not in _EDITABLE_CLASSES:
        return None
    return _asa_state_from_options(parsed["options"])


def _pub_state(manu, options=None):
    """The Publish state a build of `manu` uses: wrapper tokens, overlaid by the
    frontmatter keys, overlaid by explicit `options`. None when none of them say
    anything (the builder's own defaults apply)."""
    return _resolve_pub_state(_wrapper_state(manu), _read(manu) or "", options)


def _ensure_preview(vault, slug, doc, output, out):
    """Make the Word preview current WITHOUT touching the deliverable."""
    if output != "docx":
        return out
    ap = _artifact_paths(vault, slug, doc)
    if not ap:
        return out
    manu, _pdf, docx = ap
    is_grant = False
    try:
        is_grant = _is_grant_project(_proj_of_doc(manu))
    except Exception:
        pass
    if not is_grant:
        try:
            scratch = _preview_docx_path(vault, slug, doc)
            md = _mt(manu) or 0
            if scratch is not None and md > max(_mt(docx) or 0, _mt(scratch) or 0):
                with _CompileSlot(slug, doc, "docx"):
                    if md > max(_mt(docx) or 0, _mt(scratch) or 0):
                        # same resolved state the PDF compiles (frontmatter over the
                        # wrapper), so the preview is what Publish writes
                        res = compile_docx(vault, slug, doc, options=_pub_state(manu),
                                           out_docx=scratch)
                        err = res.get("error") if isinstance(res, dict) else "compile failed"
                        if err:
                            out["autoCompileError"] = err
                            out["autoCompileLog"] = _log_tail(res)
                            _note_compile_result(slug, doc, "docx", md, err)
                            return out
        except Exception as e:  # noqa: BLE001
            out["autoCompileError"] = "the Word preview build crashed: %s" % e
            _note_compile_result(slug, doc, "docx", _mt(manu), out["autoCompileError"])
            return out
    src = _docx_preview_source(vault, slug, doc)
    if src is None or not src.exists():
        if is_grant:
            msg = ("no Word attachment yet: writing/build/build.sh has not produced "
                   "writing/docx/" + docx.name if (manu.parent / "build" / "build.sh").exists()
                   else "no Word attachment: this grant has no writing/build/build.sh, "
                        "so it cannot be built here")
        else:
            msg = "no Word file was produced for " + docx.name
        out.setdefault("autoCompileError", msg)
        _note_compile_result(slug, doc, "docx", _mt(manu), msg)
        return out
    err = ""
    try:
        with _CompileSlot(slug, doc, "docx"):
            if _docx_to_pdf(src) is None:
                err = "LibreOffice could not render " + src.name + " to a preview PDF"
    except Exception:
        err = "the Word preview render failed"
    if err:
        out["autoCompileError"] = err
    _note_compile_result(slug, doc, "docx", _mt(manu), err)
    return out


def preview_status(vault, slug, doc=DEFAULT_DOC, output="pdf"):
    """Cheap, non-blocking freshness probe for the Publish panel's preview poll.
    Stats and a memoized page count — it NEVER compiles, renders or creates anything,
    so it is safe to call every second while a compile runs somewhere else."""
    doc = (doc or DEFAULT_DOC).strip().lower() or DEFAULT_DOC
    output = "docx" if (output or "pdf").strip().lower() == "docx" else "pdf"
    base = {"ok": False, "output": output, "mdMtime": 0, "previewMtime": None,
            "previewPages": 0, "stale": True, "compiling": False, "error": ""}
    ap = _artifact_paths(vault, slug, doc)
    if not ap:
        base["error"] = "unknown paper"
        return base
    manu, pdf, docx = ap
    base["compiling"] = _compile_busy(slug, doc)
    if not manu.exists():
        base["error"] = manu.name + " not found"
        return base
    base["mdMtime"] = _mt(manu)
    if _is_project_doc(doc):
        base["error"] = "project documents are never compiled"
        return base
    if output == "docx":
        src = _docx_preview_source(vault, slug, doc)
        art = _docx_preview_cached(src)
        src_mt = _mt(src) if src is not None else 0
    else:
        src = pdf if pdf.exists() else None
        art = src
        src_mt = _mt(pdf)
    base["ok"] = True
    base["previewMtime"] = _mt(art) if art is not None else None
    base["previewPages"] = _pdf_pages_cached(art)
    base["stale"] = (art is None) or (base["mdMtime"] > (src_mt or 0))
    if output == "docx" and _is_grant_project(_proj_of_doc(manu)):
        base["stale"] = False
    base["error"] = _last_compile_error(slug, doc, output, base["mdMtime"])
    return base


def _pdf_pages(pdf):
    try:
        exe = _native_tool("pdfinfo")
        if not exe:
            return None
        info = _native_run([exe, str(pdf)], pdf.parent, 30)
        m = re.search(r"Pages:\s*(\d+)", info.stdout or "")
        if m:
            return int(m.group(1))
    except Exception:
        pass
    return None


_PAGECOUNT_CACHE = {}
_pagecount_guard = threading.Lock()


def _pdf_pages_cached(pdf):
    """_pdf_pages memoized on the file's own mtime. 0 when there is no readable PDF."""
    if pdf is None:
        return 0
    mt = _mt(pdf)
    if not mt:
        return 0
    key = (str(pdf), mt)
    with _pagecount_guard:
        hit = _PAGECOUNT_CACHE.get(key)
    if hit is not None:
        return hit
    n = _pdf_pages(pdf) or 0
    with _pagecount_guard:
        if len(_PAGECOUNT_CACHE) > 512:
            _PAGECOUNT_CACHE.clear()
        _PAGECOUNT_CACHE[key] = n
    return n


def _archive_tex(wdir, base, options, separate, main_wtext, build, figures_wtext=None):
    sig = _tex_sig(options)
    written = []
    try:
        tdir = wdir / "tex"
        tdir.mkdir(exist_ok=True)
        stem = base + ("." + sig if sig else "")
        if separate:
            (tdir / (stem + ".text.tex")).write_text(_inline_body(main_wtext, build), encoding="utf-8")
            written.append(stem + ".text.tex")
            if figures_wtext is not None:
                (tdir / (stem + ".figures.tex")).write_text(figures_wtext, encoding="utf-8")
                written.append(stem + ".figures.tex")
        else:
            (tdir / (stem + ".tex")).write_text(_inline_body(main_wtext, build), encoding="utf-8")
            written.append(stem + ".tex")
    except OSError:
        pass
    return written


_TEX_INPUT_RE = re.compile(r"\\input\{([A-Za-z0-9_.-]+)\}")


def latex_source(vault, slug, doc=DEFAULT_DOC, part="body"):
    paths = _writing_paths(vault, slug, doc)
    if not paths or not paths[0]:
        return {"ok": False, "error": "unknown document"}
    manu = Path(paths[0])
    wdir = manu.parent
    base = manu.name[:-3]
    tdir = wdir / "tex"
    cands = [p for p in tdir.glob(base + "*.tex")
             if (p.name == base + ".tex" or p.name.startswith(base + "."))
             and not p.name.endswith(".figures.tex")] if tdir.is_dir() else []
    if not cands:
        return {"ok": False, "error": "no LaTeX yet — compile the PDF first"}
    src = max(cands, key=lambda p: _mt(p) or 0)
    try:
        text = src.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return {"ok": False, "error": "could not read the LaTeX"}
    build = wdir / "build"

    def inline(m):
        f = build / (m.group(1) if m.group(1).endswith(".tex") else m.group(1) + ".tex")
        try:
            return f.read_text(encoding="utf-8", errors="ignore").rstrip("\n")
        except OSError:
            return m.group(0)
    text = _TEX_INPUT_RE.sub(inline, text)
    if part != "full":
        i = text.find("\\maketitle")
        j = text.find("\\begin{document}")
        start = i + len("\\maketitle") if i != -1 else (j + len("\\begin{document}") if j != -1 else 0)
        end = text.rfind("\\end{document}")
        text = text[start:end if end > start else len(text)]
        text = re.sub(r"^% --- inlined [^\n]*\n", "", text.lstrip("\n"), flags=re.M).strip() + "\n"
    texm = _mt(src) or 0
    return {"ok": True, "latex": text, "part": "full" if part == "full" else "body",
            "file": src.name, "stale": (_mt(manu) or 0) > texm}


_BRIEF_FORMATS = {"prof-brief", "long-report"}
_FM_FORMAT = re.compile(r"^(?:format|publish)\s*:\s*(.+?)\s*$", re.M)


def _brief_format(manu):
    """The HTML-lane format a report declares in its frontmatter, or None."""
    try:
        text = manu.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return None
    m = _FM_FORMAT.search(_frontmatter(text))
    if not m:
        return None
    v = m.group(1).strip().strip('"\'').lower()
    return v if v in _BRIEF_FORMATS else None


def _lane_brief_format(manu):
    fmt = _brief_format(manu)
    if fmt:
        return fmt
    proj = _proj_of_doc(manu)
    main = proj / "writing" / "report.md"
    if proj.parent.name == "briefs" and Path(manu) != main:
        return _brief_format(main)
    return None


def _report_template(vault):
    p = _toolkit(vault) / "report-templates" / "html" / "report-template.html"
    return p if p.is_file() else None


def _compile_report_html(vault, proj, manu, fmt, timeout):
    """Compile a brief through the HTML lane. Same return shape as compile_pdf, plus
    `lane` and the builder's own fidelity `checks`."""
    if not settings.RUN_VAULT_SCRIPTS:
        return {"error": VAULT_SCRIPTS_OFF}
    script = _toolkit(vault) / "scripts" / "build_report.py"
    if not script.exists():
        return {"error": "the toolkit script scripts/build_report.py was not found"}
    tmpl = _report_template(vault)
    if tmpl is None:
        return {"error": "the brief design template (report-templates/html/"
                         "report-template.html) is not in the toolkit"}
    out_pdf = manu.with_suffix(".pdf")
    try:
        r = _native_run([sys.executable, str(script), str(manu), "--project-dir", str(proj),
                         "--template", str(tmpl), "-o", str(out_pdf), "--json"], proj, timeout)
    except subprocess.TimeoutExpired:
        return {"error": f"compile timed out after {timeout}s"}
    except (FileNotFoundError, OSError):
        return {"error": "could not launch the report builder"}

    payload = {}
    for line in (r.stdout or "").splitlines():
        s = line.strip()
        if s.startswith("{"):
            try:
                payload = json.loads(s)
            except ValueError:
                pass
    if not out_pdf.exists():
        return {"error": "compile failed — no PDF was produced",
                "log": (r.stdout or "").splitlines()[-25:],
                "stderr": (r.stderr or "")[-800:]}
    checks = payload.get("checks") or {}
    warnings = list(payload.get("warnings") or [])
    if checks.get("pdfWords") == 0 and (checks.get("sourceWords") or 0) > 0:
        n = _pdf_word_count(out_pdf)
        if n > 0:
            src = checks.get("sourceWords") or 0
            checks = dict(checks, pdfWords=n, ratio=round(n / src, 4) if src else 0.0,
                          wordCountOk=(n >= 0.5 * src), wordCountBy="pdftotext")
            if checks["wordCountOk"]:
                warnings = [w for w in warnings if "carries 0 words" not in w]
    return {"ok": True, "pdfRel": _rel(vault, out_pdf),
            "pages": payload.get("pages") or _pdf_pages(out_pdf),
            "latexErrors": warnings,
            "mtime": _mt(out_pdf), "edited": False, "separate": False,
            "lane": "html", "format": fmt, "checks": checks}


def _pdf_word_count(pdf):
    """Words in a compiled PDF via poppler's pdftotext, or 0 when it can't be read."""
    exe = _native_tool("pdftotext")
    if not exe:
        return 0
    try:
        r = _native_run([exe, "-q", str(pdf), "-"], pdf.parent, 60)
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return 0
    return len(re.findall(r"[A-Za-z0-9][A-Za-z0-9'’\-]*", r.stdout or ""))


def _compile_grant(vault, proj, manu, timeout):
    """Compile ONE grant component through the project's own writing/build/build.sh."""
    if not settings.RUN_VAULT_SCRIPTS:
        return {"error": VAULT_SCRIPTS_OFF}
    build = proj / "writing" / "build" / "build.sh"
    if not build.is_file():
        return {"error": "this grant has no writing/build/build.sh"}
    base = manu.name[:-3]
    wdir = proj / "writing"          # nested components still emit to writing/{pdf,docx}
    out_pdf = wdir / "pdf" / (base + ".pdf")
    out_docx = wdir / "docx" / (base + ".docx")
    before = (_mt(out_pdf) or 0, _mt(out_docx) or 0)
    argv = ["bash", str(build)]
    try:
        if "--submission" in build.read_text(encoding="utf-8", errors="ignore"):
            argv.append("--submission")
    except OSError:
        pass
    argv.append(manu.name)
    try:
        r = _native_run(argv, proj, timeout)
    except subprocess.TimeoutExpired:
        return {"error": f"compile timed out after {timeout}s"}
    except (FileNotFoundError, OSError):
        return {"error": "could not launch bash"}
    after = (_mt(out_pdf) or 0, _mt(out_docx) or 0)
    if after == before and not (out_pdf.exists() or out_docx.exists()):
        return {"error": "compile produced nothing — is this file listed in "
                         "rules/compliance.json?",
                "log": (r.stdout or "").splitlines()[-25:],
                "stderr": (r.stderr or "")[-800:]}
    out = {"ok": True, "lane": "grant", "edited": False, "separate": False,
           "latexErrors": [ln for ln in (r.stdout or "").splitlines()
                           if ln.lstrip().startswith(("ATTENTION", "warn:", "FATAL"))][:25]}
    if out_pdf.exists():
        out.update(pdfRel=_rel(vault, out_pdf), pages=_pdf_pages(out_pdf),
                   mtime=_mt(out_pdf))
    if out_docx.exists():
        out.update(docxRel=_rel(vault, out_docx), docxMtime=_mt(out_docx))
        out.setdefault("mtime", _mt(out_docx))
    if not out_pdf.exists():
        # Word-only by design for a pasted text box; say so rather than looking broken.
        out["note"] = (base + " compiles to Word only: rules/compliance.json declares no "
                       "PDF attachment for it.")
    return out


_MATH_SPAN_RE = re.compile(
    r"(?<!\\)\$\$(.+?)(?<!\\)\$\$"
    r"|\\\[(.+?)\\\]"
    r"|\\\((.+?)\\\)"
    r"|(?<![\\$])\$(?=\S)((?:[^$\\\n]|\\.)+?)(?<=\S)(?<!\\)\$(?!\d)", re.S)


def _math_spans(s):
    """TeX math spans in prose as (start, end, tex, display): `$$...$$` and `\\[...\\]`
    display math, `\\(...\\)` and `$...$` inline math (pandoc's rule: no space inside the
    dollars, no digit right after the closing one)."""
    return [(m.start(), m.end(), m.group(1) or m.group(2) or m.group(3) or m.group(4),
             bool(m.group(1) or m.group(2)))
            for m in _MATH_SPAN_RE.finditer(s or "")]


def _tex_escape_inline(s):
    """Escape prose for a LaTeX macro argument + convert the little markdown that
    legitimately appears in titles/abstracts (emphasis, bold, typographic chars).
    `$...$` math passes through untouched."""
    s = s or ""
    out, last = [], 0
    for a, b, tex, display in _math_spans(s):
        out.append(_tex_escape_prose(s[last:a]))
        out.append(("$\\displaystyle " + tex.strip() + "$") if display else ("$" + tex + "$"))
        last = b
    out.append(_tex_escape_prose(s[last:]))
    return "".join(out).strip()


def _tex_escape_prose(s):
    s = s.replace("\\", r"\textbackslash{}")
    for ch, rep in (("&", r"\&"), ("%", r"\%"), ("#", r"\#"), ("_", r"\_"),
                    ("$", r"\$"), ("{", r"\{"), ("}", r"\}")):
        s = s.replace(ch, rep)
    # markdown emphasis AFTER escaping (asterisks are untouched above)
    s = re.sub(r"\*\*([^*]+)\*\*", r"\\textbf{\1}", s)
    s = re.sub(r"\*([^*]+)\*", r"\\emph{\1}", s)
    # typographic characters classic pdflatex chokes on
    for ch, rep in (("\u2014", "---"), ("\u2013", "--"), ("\u2018", "`"),
                    ("\u2019", "'"), ("\u201c", "``"), ("\u201d", "''"),
                    ("\u00a0", "~"), ("\u2026", r"\dots{}")):
        s = s.replace(ch, rep)
    return s


def _md_abstract(text):
    m = re.search(r"^#{1,6}\s*abstract\s*$", text or "", re.I | re.M)
    if not m:
        m = re.search(r"^[ \t]{0,3}(?:\*\*|\*|__|_)?[ \t]*abstract[ \t]*[:.]?[ \t]*(?:\*\*|\*|__|_)?[ \t]*$",
                      text or "", re.I | re.M)
    if not m:
        return None
    rest = text[m.end():]
    stop = re.search(r"^(#{1,6}\s|\*\*keywords\s*[:：]?\s*\*\*|\s{0,3}(?:-\s*){3,}$|\s{0,3}(?:\*\s*){3,}$)",
                     rest, re.I | re.M)
    body = rest[:stop.start()] if stop else rest
    body = re.sub(r"<!--.*?-->", "", body, flags=re.S)          # direction comments
    body = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r"\1", body)       # md links -> text
    paras = [re.sub(r"\s+", " ", p).strip() for p in body.split("\n\n")]
    out = " ".join(p for p in paras if p)
    return out or None


def _md_subtitle(text):
    body = re.sub(r"\A---\n.*?\n---\n", "", text or "", flags=re.S)
    m = re.search(r"^#\s+.*$", body, re.M)
    if not m:
        return None
    for ln in body[m.end():].split("\n"):
        s = ln.strip()
        if not s:
            continue
        sm = re.fullmatch(r"(?:\*([^*].*?[^*]|[^*])\*|_([^_].*?[^_]|[^_])_)", s)
        return (sm.group(1) or sm.group(2)).strip() if sm else None
    return None


def _md_keywords(text):
    # both `**Keywords**: a, b` and `**Keywords:** a, b`
    m = re.search(r"^\*\*keywords\s*[:：]?\s*\*\*\s*[:：]?\s*(.+?)\s*$", text or "", re.I | re.M)
    return m.group(1).strip() if m else None


def _md_bodycount(text):
    """Manuscript word count for the title page: the prose the reader counts — no
    frontmatter, direction comments, tables, embeds, code fences, and no References /
    Bibliography / Appendix sections."""
    t = re.sub(r"\A---\n.*?\n---\n", "", text or "", flags=re.S)  # frontmatter
    t = re.sub(r"<!--.*?-->", "", t, flags=re.S)
    t = re.sub(r"^```.*?^```\s*?$", "", t, flags=re.S | re.M)
    # drop refs/appendix: heading -> next heading of same-or-higher level (or EOF)
    def _drop(mt):
        lvl = len(mt.group(1))
        after = t[mt.end():]
        nxt = re.search(r"^#{1,%d}\s" % lvl, after, re.M)
        return mt.start(), (mt.end() + nxt.start()) if nxt else len(t)
    spans = []
    for mt in re.finditer(r"^(#{1,6})\s*(references|bibliography|works cited|appendix\w*|online supplement)\b.*$",
                          t, re.I | re.M):
        spans.append(_drop(mt))
    for a, b in reversed(spans):
        t = t[:a] + t[b:]
    t = re.sub(r"^\|.*$", "", t, flags=re.M)                     # table rows
    t = re.sub(r"!\[\[[^\]]+\]\]", "", t)                        # embeds
    t = re.sub(r"^#{1,6}\s.*$", "", t, flags=re.M)               # heading lines
    return _wordcount(t)


def _replace_macro(wtext, macro, new_arg):
    """Replace the brace-balanced argument of \\macro{...} in the wrapper. Returns
    (text, replaced?) — untouched when the macro is absent or braces do not balance."""
    at = wtext.find("\\" + macro + "{")
    if at < 0:
        return wtext, False
    start = at + len(macro) + 2
    depth, i = 1, start
    while i < len(wtext) and depth:
        if wtext[i] == "{" and wtext[i - 1] != "\\":
            depth += 1
        elif wtext[i] == "}" and wtext[i - 1] != "\\":
            depth -= 1
        i += 1
    if depth:
        return wtext, False
    old = wtext[start:i - 1]
    if old.strip() == (new_arg or "").strip():
        return wtext, False
    return wtext[:at] + "\\" + macro + "{" + new_arg + "}" + wtext[i:], True


def _drop_macro(wtext, macro):
    """Delete a whole \\macro{...} declaration from the wrapper, brace-balanced,
    taking the rest of its line with it so no blank stub is left behind.
    Returns (text, removed?)."""
    at = wtext.find("\\" + macro + "{")
    if at < 0:
        return wtext, False
    start = at + len(macro) + 2
    depth, i = 1, start
    while i < len(wtext) and depth:
        if wtext[i] == "{" and wtext[i - 1] != "\\":
            depth += 1
        elif wtext[i] == "}" and wtext[i - 1] != "\\":
            depth -= 1
        i += 1
    if depth:
        return wtext, False
    while i < len(wtext) and wtext[i] in " \t":
        i += 1
    if i < len(wtext) and wtext[i] == "\n":
        i += 1
    return wtext[:at] + wtext[i:], True


def _md_byline(md_text):
    body = re.sub(r"\A---\n.*?\n---\n", "", md_text, flags=re.S)
    m = re.search(r"^#\s+\S.*\n+((?:(?!#|---|\*\*\*)\S.*\n?)+)", body, re.M)
    if not m:
        return []
    line = " ".join(m.group(1).split())
    return [(n.strip(), (a or "").strip())
            for n, a in re.findall(r"\*\*([^*]+)\*\*\s*(?:\(([^)]*)\))?", line)]


def _sync_wrapper_meta(wtext, md_text, slug):
    """Refresh the wrapper's title-page macros from the live manuscript. Returns
    (wtext, [names of macros that changed])."""
    synced = []
    # only asa-manuscript is known to define all four; another class keeps replace-only
    can_insert = (parse_documentclass(wtext) or {}).get("cls") in _EDITABLE_CLASSES

    def _set(wtext, macro, arg):
        if ("\\" + macro + "{") in wtext:
            return _replace_macro(wtext, macro, arg)
        at = wtext.find("\\begin{document}") if can_insert else -1
        if at < 0:
            return wtext, False
        return wtext[:at] + "\\" + macro + "{" + arg + "}\n\n" + wtext[at:], True

    try:
        title = _paper_title(md_text, "")
        sub = _md_subtitle(md_text)
        title_tex = _tex_escape_inline(title) if title else ""
        if title and sub and ":" not in title:
            title_tex = _tex_escape_inline(title.rstrip(" .:") + ":") + r"\\ " + _tex_escape_inline(sub)
            title = title.rstrip(" .:") + ": " + sub
        if title:
            wtext, ch = _set(wtext, "title", title_tex)
            if ch:
                synced.append("title")
            rhm = re.search(r"^running[-_]?head\s*:\s*(.+?)\s*$", _frontmatter(md_text), re.M | re.I)
            rh = rhm.group(1).strip().strip("\"'") if rhm else _running_head(title)
            if rh and "\\runninghead{" in wtext:
                wtext, ch = _replace_macro(wtext, "runninghead", _tex_escape_inline(rh.upper()))
                if ch:
                    synced.append("running head")
        byline = _md_byline(md_text)
        if byline:
            fm_aff = re.search(r"^affiliation\s*:\s*(.+?)\s*$", _frontmatter(md_text), re.M | re.I)
            fm_aff = fm_aff.group(1).strip().strip("\"'") if fm_aff else ""
            rows = []
            for name, aff in byline:
                aff = aff or fm_aff
                row = _tex_escape_inline(name)
                if aff:
                    row += r"\\ \textit{" + _tex_escape_inline(aff) + "}"
                rows.append(row)
            sep = r"\\[10pt] " if any(r"\textit{" in r for r in rows) else r"\\ "
            wtext, ch = _set(wtext, "author", sep.join(rows))
            if ch:
                synced.append("author")
            if any(r"\textit{" in r for r in rows):
                wtext, ch = _replace_macro(wtext, "affil", "")
                if ch:
                    synced.append("affiliation")
        if True:   # the subtitle is folded into \title above; a \subtitle macro would repeat it
            wtext, ch = _drop_macro(wtext, "subtitle")
            if ch:
                synced.append("subtitle dropped (none in the manuscript)")
        abstract = _md_abstract(md_text)
        if abstract:
            wtext, ch = _set(wtext, "manuscriptabstract", _tex_escape_inline(abstract))
            if ch:
                synced.append("abstract")
        else:
            wtext, ch = _drop_macro(wtext, "manuscriptabstract")
            if ch:
                synced.append("abstract dropped (none in the manuscript)")
        kw = _md_keywords(md_text)
        if kw:
            wtext, ch = _set(wtext, "keywords", _tex_escape_inline(kw))
            if ch:
                synced.append("keywords")
        else:
            wtext, ch = _drop_macro(wtext, "keywords")
            if ch:
                synced.append("keywords dropped (none in the manuscript)")
        n = _md_bodycount(md_text)
        if n:
            wtext, ch = _set(wtext, "wordcount", f"{n:,}")
            if ch:
                synced.append("wordcount")
    except Exception:
        return wtext, synced          # never let a sync bug block a compile
    return wtext, synced


def _alt_spacing_count(proj, kit, build, base, wtext, timeout=90):
    parsed = parse_documentclass(wtext) or {}
    cls = parsed.get("cls") or ""
    opts = list(parsed.get("options") or [])
    low = {o.lower() for o in opts}
    if cls == "sagej":
        # sagej spaces via its own `doublespace` option token
        if "doublespace" in low:
            alt_opts = [o for o in opts if o.lower() != "doublespace"]
            mode = "single"
        else:
            alt_opts = opts + ["doublespace"]
            mode = "double"
    elif cls in _EDITABLE_CLASSES:
        style_toks = {"asr", "ajs", "smh", "jhsb", "spq"}
        if "working" in low:
            alt_opts = [("asr" if o.lower() == "working" else o) for o in opts]
            mode = "double"
        else:
            alt_opts = [o for o in opts if o.lower() not in style_toks] + ["working"]
            mode = "single"
    else:
        return None
    job = build / (base + ".altspace.tex")
    try:
        job.write_text(_swap_documentclass_options(wtext, alt_opts), encoding="utf-8")
    except OSError:
        return None
    pdflatex = _native_tool("pdflatex")
    if not pdflatex:
        return None
    env = _tex_env(kit, build.parent)
    try:
        for _ in range(2):
            _native_run([pdflatex, "-no-shell-escape", "-interaction=nonstopmode", job.name], build, timeout, env=env)
    except Exception:
        return None
    pages = _pdf_pages(build / (base + ".altspace.pdf"))
    return {"mode": mode, "pages": pages} if pages else None


def _titled_copy(wdir, out):
    import shutil
    if out.stem not in ("paper", "appendix") or wdir.name != "writing":
        return None
    try:
        md = (wdir / "paper.md").read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return None
    body = re.sub(r"\A---\n.*?\n---\n", "", md, flags=re.S)
    m = re.search(r"^#\s+(.+?)\s*$", body, re.M)
    short = (m.group(1) if m else "").split(":", 1)[0].strip().rstrip(",;.")
    name = re.sub(r"[^a-z0-9]+", "_", short.lower()).strip("_")[:60].rstrip("_")
    if not name or name in ("paper", "appendix"):
        return None
    dst = wdir / ((name if out.stem == "paper" else name + ".appendix") + out.suffix)
    try:
        shutil.copy2(out, dst)
    except OSError:
        return None
    return dst


def compile_pdf(vault, slug, doc=DEFAULT_DOC, options=None, timeout=240):
    """Recompile a manuscript to PDF. Returns {ok, pdfRel, pages, latexErrors, mtime, ...}
    or {error[, log]}. Confined to the project's writing/ tree."""
    if _is_project_doc(doc):
        return {"error": "project documents (README/PLAN) are never compiled"}
    paths = _writing_paths(vault, slug, doc)
    if not paths:
        return {"error": "unknown paper"}
    manu = paths[0]
    if not manu.exists():
        return {"error": manu.name + " not found"}
    proj = _proj_of_doc(manu)
    wdir = proj / "writing"

    fmt = _lane_brief_format(manu)
    if fmt:
        return _compile_report_html(vault, proj, manu, fmt, timeout)

    if _is_grant_project(proj):
        return _compile_grant(vault, proj, manu, timeout)

    build = wdir / "build"
    base = manu.name[:-3]
    wrapper = _find_wrapper(build, base)
    if wrapper is None:
        wrapper = _ensure_wrapper(vault, slug, doc)
    if wrapper is None:
        return {"ok": False, "reason": "no-wrapper",
                "error": "This manuscript has no build wrapper and writing/build/ "
                "could not be written."}
    if not settings.RUN_VAULT_SCRIPTS:
        return {"error": VAULT_SCRIPTS_OFF}
    kit = _toolkit(vault)
    if not (kit / "scripts" / "md_to_latex.py").exists():
        return {"error": "the toolkit script scripts/md_to_latex.py was not found"}
    wtext = wrapper.read_text(encoding="utf-8", errors="ignore")
    meta_synced = []
    md_text = _read(manu) or ""
    if md_text:
        wtext, meta_synced = _sync_wrapper_meta(wtext, md_text, slug)
    parsed = parse_documentclass(wtext) or {"cls": "", "options": []}
    cls = parsed["cls"]

    if options and options.get("template") and options["template"] != cls:
        tmpl = options["template"]
        return {"error": f"This paper is set up as “{cls}”. Switching to “{tmpl}” needs its "
                "own build wrapper in writing/build/.".replace("{tmpl}", tmpl)}

    tables_atend = False
    if cls in _EDITABLE_CLASSES:
        wstate = _asa_state_from_options(parsed["options"])
        eff = _resolve_pub_state(wstate, md_text, options) or {}
        f = (eff.get("figures") or "inline").lower()
        eff["figures"] = {"figuresatend": "atend", "end": "atend"}.get(f, f)
        eff["format"] = (eff.get("format") or "").lower()
        eff["blind"], eff["endnotes"] = bool(eff.get("blind")), bool(eff.get("endnotes"))
        same = all(eff.get(k) == wstate.get(k) for k in _PUB_STATE_KEYS)
        options = None if same else eff
        tables_atend = eff["figures"] == "atend"

    # default: compile the canonical wrapper as set up (the proven path). With options on an
    # editable class, build variant wrapper(s) that never touch the canonical paper.tex.
    edited = separate = False
    job = wrapper
    main_wtext = wtext
    figures_job = figures_wtext = None
    _BODY_INPUT = r"\\input\{body(?:\.tex)?\}"
    if options and cls in _EDITABLE_CLASSES:
        tokens = _compose_asa_options(options)
        separate = (options.get("figures") or "").lower() == "separate"
        main_wtext = _swap_documentclass_options(wtext, tokens)
        edited = True
    if separate:
        main_wtext = re.sub(_BODY_INPUT, r"\\input{body.textonly}", main_wtext)
    elif tables_atend:
        # figures at end: endfloat moves the figures, but md_to_latex's tables are raw
        # \input blocks, not floats — they compile from body.atend.tex, lifted after the body
        swapped = re.sub(_BODY_INPUT, r"\\input{body.atend}", main_wtext)
        tables_atend = swapped != main_wtext
        main_wtext = swapped
    if edited or tables_atend or meta_synced or base != wrapper.stem:
        try:
            variant = build / (base + ".draftpub.tex")
            variant.write_text(main_wtext, encoding="utf-8")
            job = variant
        except OSError:
            # canonical wrapper still compiles (as set up, stale meta)
            job, edited, separate, tables_atend, main_wtext = wrapper, False, False, False, wtext

    job_pdf_before = _pdf_sig(build / (job.stem + ".pdf"))
    # phase A — markdown -> build/body.tex (postprocessed, ready to \\input)
    try:
        rA = _draft_phase_a_native(proj, kit, doc, min(timeout, 180))
        if isinstance(rA, dict):
            return rA
    except subprocess.TimeoutExpired:
        return {"error": f"compile timed out after {timeout}s"}
    except (FileNotFoundError, OSError):
        return {"error": "could not launch the TeX toolchain"}

    def _table_label(stem):
        # the number table_to_latex printed in the table's own caption ("Table A1.")
        m = re.search(r"\\textbf\{\s*Table\s+([A-Za-z]?\d+[\w.]*?)\.?\s*\}",
                      _read(build / (stem if stem.endswith(".tex") else stem + ".tex")) or "")
        return m.group(1) if m else None

    if tables_atend:
        body_text = _read(build / "body.tex") or ""
        text_only, tabs = split_floats(body_text, tables_only=True, label_of=_table_label)
        if tabs:
            flush = ("\\ifdefined\\processdelayedfloats\\processdelayedfloats"
                     "\\let\\processdelayedfloats\\relax\\fi\n")
            tables = "\n\n\\clearpage\n".join(t.strip() for t in tabs) + "\n"
            # Society and Mental Health orders the back matter tables, then figures
            if (eff.get("format") or "") == "smh":
                text_only = (text_only.rstrip() + "\n\n\\clearpage\n" + tables
                             + "\\clearpage\n" + flush)
            else:
                text_only = (text_only.rstrip() + "\n\n\\clearpage\n" + flush
                             + "\\clearpage\n" + tables)
        try:
            (build / "body.atend.tex").write_text(text_only, encoding="utf-8")
        except OSError:
            return {"error": "could not write writing/build/body.atend.tex"}

    # separate-document mode: split the floats out now that body.tex exists
    if separate:
        body_text = _read(build / "body.tex") or ""
        text_only, floats = split_floats(body_text, label_of=_table_label)
        try:
            (build / "body.textonly.tex").write_text(text_only, encoding="utf-8")
        except OSError:
            separate = False
        if separate and floats:
            figures_wtext = _floats_doc(wtext, _compose_asa_options({**options, "figures": "inline"}), floats)
            figures_job = build / (base + ".figures.tex")
            try:
                figures_job.write_text(figures_wtext, encoding="utf-8")
            except OSError:
                figures_job = figures_wtext = None
        elif separate and not floats:
            figures_job = figures_wtext = None   # nothing to split out; main is just the full doc

    # phase B — pdflatex (twice) for the main job, and the figures job when separate
    try:
        r = _draft_phase_b_native(proj, kit, build, job, figures_job, base, timeout)
        if isinstance(r, dict):
            return r
    except subprocess.TimeoutExpired:
        return {"error": f"compile timed out after {timeout}s"}
    except (FileNotFoundError, OSError):
        return {"error": "could not launch the TeX toolchain"}

    out_pdf = wdir / (base + ".pdf")
    log_lines = [l for l in (r.stdout or "").splitlines() if l.strip()]
    if not out_pdf.exists():
        return {"ok": False, "reason": "no-pdf", "error": "compile failed — no PDF was produced",
                "log": log_lines[-25:], "stderr": (r.stderr or "")[-800:]}
    if _pdf_sig(build / (job.stem + ".pdf")) in (None, job_pdf_before):
        return {"ok": False, "reason": "stale-pdf",
                "error": "compile failed — pdflatex did not produce a new PDF; "
                "the one on disk is from an earlier build",
                "log": log_lines[-25:], "stderr": (r.stderr or "")[-800:]}

    res = {"ok": True, "pdfRel": _rel(vault, out_pdf), "pages": _pdf_pages(out_pdf),
           "latexErrors": log_lines[:20], "mtime": _mt(out_pdf), "edited": edited,
           "separate": separate, "metaSynced": meta_synced}
    titled = _titled_copy(wdir, out_pdf)
    if titled:
        res["shareCopy"] = _rel(vault, titled)
    if separate:
        fig_pdf = wdir / (base + ".figures.pdf")
        if figures_job and fig_pdf.exists():
            res["figuresPdfRel"] = _rel(vault, fig_pdf)
            res["figuresPages"] = _pdf_pages(fig_pdf)
            res["figuresMtime"] = _mt(fig_pdf)
        elif figures_job:
            res["figuresError"] = "the figures document didn't compile"
        else:
            res["figuresError"] = "no figures or tables were found to separate out"
    try:
        alt = _alt_spacing_count(proj, kit, build, base, main_wtext, timeout=90)
        if alt and res.get("pages"):
            here_mode = "single" if alt["mode"] == "double" else "double"
            res["spacing"] = here_mode
            res["pagesBoth"] = {here_mode: res["pages"], alt["mode"]: alt["pages"]}
            (build / "pagecounts.json").write_text(json.dumps(
                {"mdMtime": _mt(manu), "spacing": here_mode,
                 "pagesBoth": res["pagesBoth"]}), encoding="utf-8")
    except Exception:
        pass
    res["texSaved"] = _archive_tex(wdir, base, options, separate, main_wtext, build, figures_wtext)
    art = {_artifact_key(doc, "pdf"): out_pdf}
    if separate and res.get("figuresPdfRel"):
        art["figuresPdf"] = wdir / (base + ".figures.pdf")
    _attach_artifacts_if_checkpointed(vault, slug, doc, art)
    return res


def _report_pdf_stale(manu, pdf):
    if not pdf.exists():
        return True
    pdf_mt = _mt(pdf)
    if _mt(manu) > pdf_mt:
        return True
    tmpl = _report_template(settings.VAULT)
    try:
        if tmpl and _mt(tmpl) > pdf_mt:
            return True
    except OSError:
        pass
    results = manu.parent.parent / "results"
    if not results.is_dir():
        return False
    try:
        text = manu.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return False
    for stem in re.findall(r"!\[\[([^\]|#]+)\]\]", text):
        asset = results / Path(stem.strip()).name
        try:
            if asset.exists() and _mt(asset) > pdf_mt:
                return True
        except OSError:
            continue
    return False


def _ensure_report_pdf(vault, slug, doc, manu, pdf):
    if not _lane_brief_format(manu):
        return
    if not _report_pdf_stale(manu, pdf):
        return
    with _table_build_lock(manu.parent):
        if not _report_pdf_stale(manu, pdf):
            return
        try:
            with _CompileSlot(slug, doc, "pdf"):
                if not _report_pdf_stale(manu, pdf):
                    return          # another caller rebuilt it while we queued
                compile_pdf(vault, slug, doc)
        except Exception:
            pass


def _artifact_paths(vault, slug, doc=DEFAULT_DOC):
    paths = _writing_paths(vault, slug, doc)
    if not paths:
        return None
    manu = paths[0]
    wdir = manu.parent
    base = manu.name[:-3]
    if _is_grant_project(wdir.parent):
        return manu, wdir / "pdf" / (base + ".pdf"), wdir / "docx" / (base + ".docx")
    return manu, wdir / (base + ".pdf"), wdir / (base + ".docx")


def pdf_path(vault, slug, doc=DEFAULT_DOC, which="paper"):
    """Absolute path of a manuscript's compiled PDF if it exists. which='paper' →
    writing/<base>.pdf; which='figures' → writing/<base>.figures.pdf (separate-doc mode)."""
    paths = _writing_paths(vault, slug, doc)
    if not paths:
        return None
    base = paths[0].name[:-3]
    name = base + (".figures.pdf" if which == "figures" else ".pdf")
    p = paths[0].parent / name
    if _is_grant_project(paths[0].parent.parent):
        g = paths[0].parent / "pdf" / name
        return g if g.exists() else None
    if which == "paper":
        _ensure_report_pdf(vault, slug, doc, paths[0], p)
    return p if p.exists() else None


_DOCX_REFERENCE = dict(_JOURNAL_DOCX)


def docx_path(vault, slug, doc=DEFAULT_DOC, which="paper"):
    """Absolute path of a manuscript's compiled .docx if it exists. which='paper' →
    writing/<base>.docx; 'figures' → writing/<base>.figures.docx; 'titlepage' →
    writing/<base>.titlepage.docx."""
    paths = _writing_paths(vault, slug, doc)
    if not paths:
        return None
    base = paths[0].name[:-3]
    suffix = {"figures": ".figures.docx", "titlepage": ".titlepage.docx"}.get(which, ".docx")
    p = paths[0].parent / (base + suffix)
    if which == "titlepage" and not p.exists():
        p = paths[0].parent / "titlepage.docx"   # build_docx's actual (bare) name
    if _is_grant_project(paths[0].parent.parent):
        g = paths[0].parent / "docx" / (base + suffix)
        return g if g.exists() else None
    return p if p.exists() else None


def _overleaf_zips(vault, slug, doc=DEFAULT_DOC):
    paths = _writing_paths(vault, slug, doc)
    if not paths:
        return None
    wdir = paths[0].parent
    named, anon = [], []
    try:
        for p in wdir.glob("*.overleaf.zip"):
            if not p.is_file() or p.is_symlink():
                continue
            (anon if p.name.endswith(".anonymized.overleaf.zip") else named).append(p)
    except OSError:
        return None
    newest = lambda xs: max(xs, key=lambda p: p.stat().st_mtime) if xs else None
    return {"named": newest(named), "anon": newest(anon)}, paths[0]


def overleaf_info(vault, slug, doc=DEFAULT_DOC):
    """{named, anon: {name, mtime, size} | None, paperMtime} for the Publish panel."""
    got = _overleaf_zips(vault, slug, doc)
    if got is None:
        return {"error": "unknown paper"}
    zips, ms = got
    out = {"ok": True, "paperMtime": _mt(ms) if ms.exists() else 0}
    for k, p in zips.items():
        out[k] = {"name": p.name, "mtime": _mt(p), "size": p.stat().st_size} if p else None
    return out


def overleaf_zip_path(vault, slug, doc=DEFAULT_DOC, anon=False):
    got = _overleaf_zips(vault, slug, doc)
    return got[0]["anon" if anon else "named"] if got else None


def overleaf_single_tex(vault, slug, doc=DEFAULT_DOC, anon=False):
    import zipfile
    got = _overleaf_zips(vault, slug, doc)
    if got is None:
        return {"error": "unknown paper"}
    zips, manu = got
    zp = zips["anon" if anon else "named"]
    if not zp:
        return {"error": "no Overleaf zip yet"}
    try:
        with zipfile.ZipFile(zp) as z:
            names = set(z.namelist())
            read = lambda n: z.read(n).decode("utf-8")
            main, body = read("main.tex"), read("body.tex")

            def tab(m):
                n = m.group(1) + ".tex"
                return read(n).rstrip("\n") if n in names else m.group(0)
            body = re.sub(r"\\input\{(tables/[^}]+?)(?:\.tex)?\}", tab, body)
            if not re.search(r"\\input\{body\}", main):
                return {"error": "main.tex in the zip has no \\input{body}"}
            main = re.sub(r"\\input\{body\}", lambda m: body.rstrip("\n"), main, count=1)
            embeds = []
            for n in sorted(names):
                if "/" not in n and n.endswith((".cls", ".sty", ".bib")):
                    txt = read(n)
                    if "\\end{filecontents*}" in txt:
                        return {"error": n + " cannot be embedded (it contains \\end{filecontents*})"}
                    embeds.append("\\begin{filecontents*}[overwrite]{%s}\n%s\n\\end{filecontents*}\n" % (n, txt.rstrip("\n")))
    except (OSError, KeyError, UnicodeDecodeError, zipfile.BadZipFile) as e:
        return {"error": "could not read the Overleaf zip: " + type(e).__name__}
    m = re.search(r"(?m)^\\documentclass", main)
    if not m:
        return {"error": "main.tex in the zip has no \\documentclass"}
    tex = main[:m.start()] + "".join(embeds) + main[m.start():]
    return {"ok": True, "tex": tex, "name": zp.name, "mtime": _mt(zp), "stale": _mt(manu) > _mt(zp)}


_OVERLEAF_LOCK = threading.Lock()


def build_overleaf(vault, slug, doc=DEFAULT_DOC, timeout=300):
    got = _overleaf_zips(vault, slug, doc)
    if got is None:
        return {"error": "unknown paper"}
    zips, manu = got
    if not manu.exists():
        return {"error": manu.name + " not found"}
    if not settings.RUN_VAULT_SCRIPTS:
        return {"error": VAULT_SCRIPTS_OFF}
    exporter = _toolkit(vault) / "scripts" / "export_overleaf.py"
    if not exporter.is_file():
        return {"error": "the toolkit script scripts/export_overleaf.py was not found"}
    if not _OVERLEAF_LOCK.acquire(blocking=False):
        return {"error": "an Overleaf export is already running"}
    try:
        wdir = manu.parent
        build = wdir / "build"
        base = manu.name[:-3]
        cands = [w for w in (build / (base + ".draftpub.tex"), _find_wrapper(build, base)) if w and w.exists()]
        if not cands:
            return {"error": "no LaTeX wrapper in writing/build/ — compile once in Publish"}
        wrapper = max(cands, key=lambda w: _mt(w.with_suffix(".pdf")))
        built = _mt(wrapper.with_suffix(".pdf"))
        if built < _mt(manu) or built < _mt(build / "body.tex"):
            return {"error": "the last compile is older than the manuscript — compile first", "stale": True}
        stem = None
        for p in (zips["named"], zips["anon"]):
            if p:
                stem = p.name.split(".")[0]
                break
        stem = stem or base
        out = {"ok": True}
        for kind, name, blind in (("named", stem + ".overleaf.zip", False),
                                  ("anon", stem + ".anonymized.overleaf.zip", True)):
            final = wdir / name
            tmp = wdir / ("." + name + ".building")
            cmd = [sys.executable, str(exporter), "--build-dir", str(build), "--wrapper", str(wrapper),
                   "--project-dir", str(wdir.parent), "-o", str(tmp), "--verify"] + (["--blind"] if blind else [])
            try:
                r = _native_run(cmd, wdir.parent, timeout)
            except subprocess.TimeoutExpired:
                return {"error": f"the {kind} export timed out"}
            if r.returncode != 0 or not tmp.exists():
                tail = ((r.stdout or "") + (r.stderr or "")).strip().splitlines()[-6:]
                return {"error": f"the {kind} export did not compile cleanly", "log": tail}
            os.replace(tmp, final)
            out[kind] = {"name": final.name, "mtime": _mt(final), "size": final.stat().st_size}
        out["paperMtime"] = _mt(manu)
        return out
    finally:
        _OVERLEAF_LOCK.release()


def compile_docx(vault, slug, doc=DEFAULT_DOC, options=None, timeout=180, out_docx=None):
    """Compile a manuscript to Word (.docx) via build_docx.py. Returns
    {ok, docxRel, paragraphs, tables, images, mtime[, figuresDocxRel, titlePageRel,
    separate, warnings]} or {error[, log]}. Confined to the project's writing/ tree."""
    if _is_project_doc(doc):
        return {"error": "project documents (README/PLAN) are never compiled"}
    paths = _writing_paths(vault, slug, doc)
    if not paths:
        return {"error": "unknown paper"}
    manu = paths[0]
    if not manu.exists():
        return {"error": manu.name + " not found"}
    proj = _proj_of_doc(manu)
    wdir = proj / "writing"
    # A grant's Word output is build.sh's job too — same script, same component list,
    # same funder formatting. Routing it here keeps the panel's Word button honest.
    if _is_grant_project(proj):
        return _compile_grant(vault, proj, manu, timeout)
    if not settings.RUN_VAULT_SCRIPTS:
        return {"error": VAULT_SCRIPTS_OFF}
    kit = _toolkit(vault)
    script = kit / "scripts" / "build_docx.py"
    if not script.exists():
        return {"error": "the toolkit script scripts/build_docx.py was not found"}

    o = _pub_state(manu, options) or {}
    fmt = (o.get("format") or "asr").lower()
    blind = o.get("blind", True)
    figures = (o.get("figures") or "inline").lower()
    if figures not in ("inline", "atend", "separate"):
        figures = "inline"

    sup = SUPPLEMENTS.get(doc.strip().lower())
    if sup and sup["kind"] == "appendix":
        profile, ref_name, blind, figures = "appendix", _DOCX_REFERENCE.get(fmt, "social-forces"), False, "inline"
    elif sup:                                        # cover-letter / response
        profile, ref_name, blind, figures = "letter", "asa-working", False, "inline"
    else:
        profile, ref_name = "manuscript", _DOCX_REFERENCE.get(fmt, "social-forces")
        if _brief_format(manu) or (vault / "Projects" / "briefs") in proj.parents:
            blind = False   # a brief is never under review; no byline, no Title Page
    ref = kit / "report-templates" / "docx" / (ref_name + ".docx")
    base = manu.name[:-3]

    flags = ["--figures", figures, "--profile", profile]
    if blind:
        flags.append("--blind")
    # the deliverable slot unless a preview build redirected us out of the vault
    target = Path(out_docx) if out_docx else (wdir / (base + ".docx"))
    preview_build = out_docx is not None
    if preview_build:
        flags.append("--no-standalone-tables")   # else writing/tables/*.docx get rewritten
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
        except OSError:
            return {"error": "could not create the preview build directory"}
    try:
        r = _native_run([sys.executable, str(script), "writing/" + doc,
                         "--project-dir", str(proj), "--reference-doc", str(ref)]
                        + flags + ["-o", str(target) if preview_build else f"writing/{base}.docx"],
                        proj, timeout)
    except subprocess.TimeoutExpired:
        return {"error": f"Word compile timed out after {timeout}s"}
    except (FileNotFoundError, OSError):
        return {"error": "could not launch the Word toolchain"}

    out_docx = target
    # build_docx prints one JSON line on stdout; warnings go to stderr.
    payload = None
    for line in reversed((r.stdout or "").splitlines()):
        line = line.strip()
        if line.startswith("{") and line.endswith("}"):
            try:
                payload = json.loads(line)
                break
            except ValueError:
                continue
    if not out_docx.exists() or not payload or not payload.get("ok"):
        log = [l for l in ((r.stderr or "") + "\n" + (r.stdout or "")).splitlines() if l.strip()]
        joined = "\n".join(log)
        # The two dependencies the Word lane cannot conjure: name the exact fix in the
        # panel, because a bare "compile failed" is undiagnosable from the browser.
        if "No module named" in joined and "docx" in joined:
            return {"error": "the python-docx package is not installed for this Python", "log": log[-25:]}
        if "_run_pandoc" in joined and "FileNotFoundError" in joined:
            return {"error": "pandoc was not found on PATH", "log": log[-25:]}
        return {"error": "Word compile failed — no .docx was produced", "log": log[-25:]}

    res = {"ok": True, "docxRel": _rel(vault, out_docx), "mtime": _mt(out_docx),
           "paragraphs": payload.get("paragraphs"), "tables": payload.get("tables"),
           "images": payload.get("images"), "separate": figures == "separate",
           "warnings": payload.get("warnings") or []}
    if preview_build:
        res["docxRel"] = ""
        res["previewPath"] = str(out_docx)
        res["preview"] = True
        return res
    if base != "paper":
        # paper.docx gets its titled copy from build_docx itself; supplements get theirs here
        titled = _titled_copy(wdir, out_docx)
        if titled:
            res["shareCopy"] = _rel(vault, titled)
    fig = wdir / (base + ".figures.docx")
    if figures == "separate":
        if fig.exists() and payload.get("figuresOut"):
            res["figuresDocxRel"] = _rel(vault, fig)
            fs = payload.get("figuresStats") or {}
            res["figuresTables"] = fs.get("tables")
            res["figuresImages"] = fs.get("images")
            res["figuresMtime"] = _mt(fig)
        else:
            res["figuresError"] = payload.get("figuresError") or "the figures document didn't compile"
    # build_docx names the identity file bare titlepage.docx (Social Forces' naming);
    # take the path it reports rather than guessing <base>.titlepage.docx
    tp = Path(payload["titlePageOut"]) if payload.get("titlePageOut") else wdir / (base + ".titlepage.docx")
    if not tp.is_absolute():
        tp = proj / tp
    if payload.get("titlePageOut") and tp.exists():
        res["titlePageRel"] = _rel(vault, tp)
        res["titlePageMtime"] = _mt(tp)
    art = {_artifact_key(doc, "docx"): out_docx}
    if res.get("titlePageRel"):
        art["titlepageDocx"] = tp
    _attach_artifacts_if_checkpointed(vault, slug, doc, art)
    return res


VERSIONS_DIR = "versions"
_VID_RE = re.compile(r"^v\d{8}-\d{6}-\d{3}$")
_INPUT_BODY_RE = re.compile(r"\\(?:input|include)\{body(?:\.tex)?\}")


def _versions_dir(vault, slug):
    pd = _project_dir(vault, slug)
    return (pd / "writing" / VERSIONS_DIR) if pd else None


def _version_target(vault, slug, doc):
    """Resolve ANY versionable Drafting target to (live_path, versions_dir, doc_key)."""
    d = (doc or DEFAULT_DOC).strip()
    low = d.lower()
    slug_l = (slug or "").strip().lower()
    if low.startswith("deck:"):
        p = _deck_path(vault, slug, d[5:])
        if not p:
            return None, None, None
        return p, _versions_dir(vault, slug), "deck:" + p.name
    if slug_l == "syllabi":
        p = _syllabus_md_path(vault, d)
        if not p:
            return None, None, None
        return p, p.parent / ".versions", d
    if slug_l == "measures":
        p = measure_path(vault, d)
        if not p or p.suffix.lower() != ".md":
            return None, None, None
        return p, vault / "Preparation" / "Free Writing" / ".versions", d
    low = low or DEFAULT_DOC
    paths = _writing_paths(vault, slug, low)
    if not paths:
        return None, None, None
    return paths[0], _versions_dir(vault, slug), low


def _new_vid():
    return "v" + time.strftime("%Y%m%d-%H%M%S-") + str(int(time.time() * 1000) % 1000).zfill(3)


def _load_manifest(vdir):
    """The versions.json manifest ({"versions": [...]}) or an empty one — tolerant of a
    missing or corrupt file so a checkpoint can always be written."""
    if not vdir:
        return {"versions": []}
    try:
        m = json.loads((vdir / "versions.json").read_text(encoding="utf-8"))
        if isinstance(m, dict) and isinstance(m.get("versions"), list):
            return m
    except (OSError, ValueError):
        pass
    return {"versions": []}


def _write_manifest(vdir, manifest):
    vdir.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(vdir), prefix=".versions.", suffix=".json.tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(manifest, f, ensure_ascii=False, indent=1)
            f.flush()
            try:
                os.fsync(f.fileno())
            except OSError:
                pass
        os.replace(tmp, str(vdir / "versions.json"))
    except OSError:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _durable_write(p, text):
    """Write text to p, fsync'd via a temp file + os.replace (write-once snapshots)."""
    p.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(p.parent), prefix="." + p.stem + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
            f.flush()
            try:
                os.fsync(f.fileno())
            except OSError:
                pass
        os.replace(tmp, str(p))
    except OSError:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _versions_for(manifest, doc):
    items = [v for v in manifest.get("versions", []) if (v.get("doc") or DEFAULT_DOC) == doc]
    items.sort(key=lambda v: v.get("ts", 0), reverse=True)
    return items


_ARTIFACT_KEYS = ("pdf", "docx", "appendixPdf", "appendixDocx", "titlepageDocx", "figuresPdf")


def _durable_copy(src, dst):
    """Binary-safe atomic copy (tempfile + os.replace) — the non-text sibling of
    _durable_write, for snapshotting compiled PDF/docx artifacts."""
    dst.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(dst.parent), prefix="." + dst.stem + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(Path(src).read_bytes())
            f.flush()
            try:
                os.fsync(f.fileno())
            except OSError:
                pass
        os.replace(tmp, str(dst))
    except OSError:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _attach_artifacts_if_checkpointed(vault, slug, doc, artifacts):
    paths = _writing_paths(vault, slug, doc)
    if not paths or not paths[0].exists():
        return
    text = _read(paths[0]) or ""
    sha = hashlib.sha1(text.encode("utf-8")).hexdigest()
    vdir = _versions_dir(vault, slug)
    manifest = _load_manifest(vdir)
    checkpoints = [v for v in _versions_for(manifest, doc) if v.get("kind") != "proposal"]
    if not checkpoints or checkpoints[0].get("sha") != sha:
        return
    vid = checkpoints[0]["id"]
    adir = vdir / (vid + ".artifacts")
    stored = {}
    for key, src in (artifacts or {}).items():
        if key not in _ARTIFACT_KEYS or not src:
            continue
        src = Path(src)
        if not src.is_file():
            continue
        dst = adir / (key + src.suffix)
        try:
            _durable_copy(src, dst)
        except OSError:
            continue
        stored[key] = dst.name
    if not stored:
        return
    for v in manifest["versions"]:
        if v.get("id") == vid:
            v["artifacts"] = {**(v.get("artifacts") or {}), **stored}
            break
    _write_manifest(vdir, manifest)


def version_artifact_path(vault, slug, doc, vid, which):
    if which not in _ARTIFACT_KEYS:
        return None
    vdir = _versions_dir(vault, slug)
    if not vdir:
        return None
    manifest = _load_manifest(vdir)
    entry = next((v for v in manifest.get("versions", []) if v.get("id") == vid), None)
    if not entry:
        return None
    fname = (entry.get("artifacts") or {}).get(which)
    if not fname:
        return None
    p = vdir / (Path(str(vid)).name + ".artifacts") / Path(str(fname)).name
    return p if p.is_file() else None


def _artifact_key(doc, base_key):
    """'pdf'/'docx' -> 'appendixPdf'/'appendixDocx' when doc is the appendix supplement,
    so one checkpoint's artifacts map never confuses the main manuscript's PDF with the
    appendix's — both can be compiled against the SAME checkpoint id."""
    sup = SUPPLEMENTS.get((doc or "").strip().lower())
    if sup and sup["kind"] == "appendix":
        return {"pdf": "appendixPdf", "docx": "appendixDocx"}.get(base_key, base_key)
    return base_key


def list_versions(vault, slug, doc=DEFAULT_DOC):
    """Every checkpoint for a doc (newest first) plus the live doc's current word/char
    count, and whether the live doc differs from the newest checkpoint (so the UI can
    show an unsaved-changes marker)."""
    manu, vdir, doc = _version_target(vault, slug, doc)
    if not manu:
        return {"error": "unknown doc"}
    items = _versions_for(_load_manifest(vdir), doc)
    cur_text = _read(manu) if manu.exists() else ""
    cur_sha = hashlib.sha1((cur_text or "").encode("utf-8")).hexdigest()
    # "unsaved changes" tracks the live doc against the newest real CHECKPOINT — a staged
    # proposal is a pending suggestion, not the baseline, so it never marks the draft dirty
    checkpoints = [v for v in items if v.get("kind") != "proposal"]
    dirty = not checkpoints or checkpoints[0].get("sha") != cur_sha
    current = {"words": _wordcount(cur_text), "chars": len(cur_text or ""),
               "mtime": _mt(manu) if manu.exists() else 0, "sha": cur_sha}
    return {"ok": True, "slug": slug, "doc": doc, "versions": items,
            "current": current, "dirtyVsNewest": dirty}


def save_version(vault, slug, doc=DEFAULT_DOC, label="", note="", auto=False):
    manu, vdir, doc = _version_target(vault, slug, doc)
    if not manu:
        return {"error": "unknown doc"}
    if not manu.exists():
        return {"error": manu.name + " not found"}
    text = _read(manu) or ""
    if not text.strip():
        return {"error": "nothing to checkpoint — the document is empty"}
    manifest = _load_manifest(vdir)
    sha = hashlib.sha1(text.encode("utf-8")).hexdigest()
    existing = _versions_for(manifest, doc)
    if existing and existing[0].get("sha") == sha:
        return {"ok": True, "unchanged": True, "version": existing[0]}
    vid = _new_vid()
    ids = {v.get("id") for v in manifest["versions"]}
    bump = 0
    while vid in ids and bump < 1000:   # ms-collision guard for a rapid double-save
        bump += 1
        vid = "v" + time.strftime("%Y%m%d-%H%M%S-") + str((int(time.time() * 1000) + bump) % 1000).zfill(3)
    fname = vid + ".md"
    try:
        _durable_write(vdir / fname, text)
    except OSError as e:
        return {"error": "could not write the checkpoint: " + str(e)}
    entry = {"id": vid, "ts": int(time.time() * 1000), "label": (label or "").strip()[:120],
             "note": (note or "").strip()[:2000], "doc": doc, "file": fname,
             "words": _wordcount(text), "chars": len(text), "sha": sha, "kind": "checkpoint",
             "auto": bool(auto)}
    manifest["versions"].append(entry)
    try:
        _write_manifest(vdir, manifest)
    except OSError as e:
        return {"error": "could not update the version manifest: " + str(e)}
    return {"ok": True, "version": entry}


AUTO_CHECKPOINT_INTERVAL_MS = 30 * 60 * 1000


def _maybe_auto_checkpoint(vault, slug, doc):
    try:
        _live, vdir, doc = _version_target(vault, slug, doc)
        manifest = _load_manifest(vdir)
        checkpoints = [v for v in _versions_for(manifest, doc) if v.get("kind") != "proposal"]
        if checkpoints and int(time.time() * 1000) - checkpoints[0].get("ts", 0) < AUTO_CHECKPOINT_INTERVAL_MS:
            return
        save_version(vault, slug, doc=doc, label="", note="Automatic safety checkpoint", auto=True)
    except Exception:
        pass


def stage_proposal(vault, slug, doc=DEFAULT_DOC, content="", label="", note=""):
    manu, vdir, doc = _version_target(vault, slug, doc)
    if not manu:
        return {"error": "unknown doc"}
    text = content or ""
    if not text.strip():
        return {"error": "nothing to stage — the proposed content is empty"}
    base_text = _read(manu) if manu.exists() else ""
    base_sha = hashlib.sha1((base_text or "").encode("utf-8")).hexdigest()
    manifest = _load_manifest(vdir)
    sha = hashlib.sha1(text.encode("utf-8")).hexdigest()
    vid = _new_vid()
    ids = {v.get("id") for v in manifest["versions"]}
    bump = 0
    while vid in ids and bump < 1000:   # ms-collision guard
        bump += 1
        vid = "v" + time.strftime("%Y%m%d-%H%M%S-") + str((int(time.time() * 1000) + bump) % 1000).zfill(3)
    fname = vid + ".md"
    try:
        _durable_write(vdir / fname, text)
    except OSError as e:
        return {"error": "could not write the proposal snapshot: " + str(e)}
    entry = {"id": vid, "ts": int(time.time() * 1000), "label": (label or "").strip()[:120],
             "note": (note or "").strip()[:2000], "doc": doc, "file": fname,
             "words": _wordcount(text), "chars": len(text), "sha": sha,
             "kind": "proposal", "baseSha": base_sha,
             "baseMtime": _mt(manu) if manu.exists() else 0}
    manifest["versions"].append(entry)
    try:
        _write_manifest(vdir, manifest)
    except OSError as e:
        return {"error": "could not update the version manifest: " + str(e)}
    return {"ok": True, "version": entry}


def _version_entry(vault, slug, vid, doc=None):
    if not vid or not _VID_RE.match(vid):
        return None, None
    if doc:
        _live, vdir, doc = _version_target(vault, slug, doc)
    else:
        vdir = _versions_dir(vault, slug)
    if not vdir:
        return None, None
    manifest = _load_manifest(vdir)
    entry = next((v for v in manifest["versions"] if v.get("id") == vid
                  and (doc is None or (v.get("doc") or DEFAULT_DOC) == doc)), None)
    return entry, vdir


def read_version(vault, slug, vid, doc=None):
    """One checkpoint's full content + metadata."""
    entry, vdir = _version_entry(vault, slug, vid, doc)
    if not entry:
        return {"error": "unknown version"}
    text = _read(vdir / Path(str(entry["file"])).name)
    if text is None:
        return {"error": "this checkpoint's file is missing"}
    return {"ok": True, "text": text, **entry}


def update_version(vault, slug, vid, label=None, note=None, doc=None):
    """Rename / re-note a checkpoint (metadata only — the snapshot bytes never change)."""
    entry, vdir = _version_entry(vault, slug, vid, doc)
    if not entry:
        return {"error": "unknown version"}
    manifest = _load_manifest(vdir)
    for v in manifest["versions"]:
        if v.get("id") == vid:
            if label is not None:
                v["label"] = (label or "").strip()[:120]
            if note is not None:
                v["note"] = (note or "").strip()[:2000]
            entry = v
            break
    try:
        _write_manifest(vdir, manifest)
    except OSError as e:
        return {"error": str(e)}
    return {"ok": True, "version": entry}


def delete_version(vault, slug, vid, doc=None):
    """Remove a checkpoint (drops the manifest entry and unlinks its snapshot file). A
    deliberate user action, confirmed in the UI."""
    entry, vdir = _version_entry(vault, slug, vid, doc)
    if not entry:
        return {"error": "unknown version"}
    manifest = _load_manifest(vdir)
    manifest["versions"] = [v for v in manifest["versions"] if v.get("id") != vid]
    try:
        _write_manifest(vdir, manifest)
    except OSError as e:
        return {"error": str(e)}
    try:
        (vdir / Path(str(entry["file"])).name).unlink()
    except OSError:
        pass   # manifest is already updated; an orphaned file is harmless
    return {"ok": True, "id": vid}


def restore_version(vault, slug, vid, doc=DEFAULT_DOC, base_mtime=None, force=False):
    """Write a checkpoint's content back into the live doc. The current state is
    auto-checkpointed first (label "before restore") so the restore is reversible. Returns
    the restored text + new mtime so the editor reloads it."""
    manu, _vdir, doc = _version_target(vault, slug, doc)
    if not manu:
        return {"error": "unknown doc"}
    ver = read_version(vault, slug, vid, doc)
    if ver.get("error"):
        return ver
    if manu.exists() and base_mtime is not None and not force:
        cur = _mt(manu)
        if cur != int(base_mtime):
            return {"conflict": True, "currentMtime": cur, "currentText": _read(manu) or ""}
    if manu.exists() and (_read(manu) or "").strip():
        save_version(vault, slug, doc, label="before restore",
                     note="auto-saved before restoring “%s”" % (ver.get("label") or vid))
    # write back through the lane's own save discipline — decks and the syllabi /
    # measures lanes never pass through the manuscript save()
    slug_l = (slug or "").strip().lower()
    if doc.startswith("deck:"):
        _atomic_write(manu, _read(manu) if manu.exists() else None, ver["text"], label="deck")
        res = {"ok": True, "mtime": _mt(manu)}
    elif slug_l == "syllabi":
        res = save_syllabus(vault, doc, ver["text"], base_mtime=None, force=True)
    elif slug_l == "measures":
        res = save_measure(vault, doc, ver["text"], base_mtime=None, force=True)
    else:
        res = save(vault, slug, "paper", ver["text"], base_mtime=None, force=True, doc=doc)
    if res.get("ok"):
        res["restoredFrom"] = vid
        res["text"] = ver["text"]
    return res


_DIFF_TOK = re.compile(r"\s+|\w+|[^\w\s]", re.UNICODE)
_DIFF_IS_WORD = re.compile(r"\w", re.UNICODE).match

_DIFF_WORD_CAP = 3000   # tokens per side in one region; past this, see _diff_region


def _diff_wordish(text):
    return sum(1 for t in _DIFF_TOK.findall(text) if _DIFF_IS_WORD(t))


def _diff_region(old, new, emit, counts):
    """Word-level redline for ONE changed region. Both sides are already known to
    differ, so a one-sided region is a straight insert or delete."""
    import difflib
    if not old:
        emit("insert", new)
        counts["added"] += _diff_wordish(new)
        return
    if not new:
        emit("delete", old)
        counts["removed"] += _diff_wordish(old)
        return
    ta, tb = _DIFF_TOK.findall(old), _DIFF_TOK.findall(new)
    autojunk = len(ta) > _DIFF_WORD_CAP or len(tb) > _DIFF_WORD_CAP
    for op, i1, i2, j1, j2 in difflib.SequenceMatcher(a=ta, b=tb, autojunk=autojunk).get_opcodes():
        if op == "equal":
            emit("equal", "".join(ta[i1:i2]))
            continue
        if i1 < i2:
            emit("delete", "".join(ta[i1:i2]))
            counts["removed"] += sum(1 for t in ta[i1:i2] if _DIFF_IS_WORD(t))
        if j1 < j2:
            emit("insert", "".join(tb[j1:j2]))
            counts["added"] += sum(1 for t in tb[j1:j2] if _DIFF_IS_WORD(t))


def _diff_text_for(vault, slug, ref, doc):
    """Resolve a diff side: 'current' (or '' / None) → the live doc; else a checkpoint id."""
    manu, _vdir, doc = _version_target(vault, slug, doc)
    if not manu:
        return None, None
    if ref in (None, "", "current"):
        text = _read(manu) if manu.exists() else ""
        return text or "", {"id": "current", "label": "Current draft", "ts": _mt(manu),
                            "words": _wordcount(text), "current": True}
    ver = read_version(vault, slug, ref, doc)
    if ver.get("error"):
        return None, None
    return ver["text"], {"id": ver["id"], "label": ver.get("label") or ver["id"],
                         "ts": ver.get("ts", 0), "words": ver.get("words", 0)}


def diff_versions(vault, slug, a, b="current", doc=DEFAULT_DOC):
    """A word-level redline between side a (old) and side b (new). Each side is a checkpoint
    id or 'current'. Returns ordered segments (equal / insert / delete) + change counts."""
    old_text, old_meta = _diff_text_for(vault, slug, a, doc)
    new_text, new_meta = _diff_text_for(vault, slug, b, doc)
    if old_text is None or new_text is None:
        return {"error": "version not found"}
    import difflib
    segs, counts = [], {"added": 0, "removed": 0}

    def emit(op, text):
        """Append a segment, folding it into the previous one when the op repeats, so
        a region's output is as compact as a single-pass diff's."""
        if not text:
            return
        if segs and segs[-1]["op"] == op:
            segs[-1]["text"] += text
        else:
            segs.append({"op": op, "text": text})

    la = old_text.splitlines(keepends=True)
    lb = new_text.splitlines(keepends=True)
    # an identical head and tail is most of a real edit and costs nothing to recognise
    head = 0
    while head < len(la) and head < len(lb) and la[head] == lb[head]:
        head += 1
    tail = 0
    while (tail < len(la) - head and tail < len(lb) - head
           and la[len(la) - 1 - tail] == lb[len(lb) - 1 - tail]):
        tail += 1
    emit("equal", "".join(la[:head]))
    ma, mb = la[head:len(la) - tail], lb[head:len(lb) - tail]
    # line blocks first: an untouched paragraph never reaches the word matcher
    for op, i1, i2, j1, j2 in difflib.SequenceMatcher(a=ma, b=mb, autojunk=False).get_opcodes():
        if op == "equal":
            emit("equal", "".join(ma[i1:i2]))
        else:
            _diff_region("".join(ma[i1:i2]), "".join(mb[j1:j2]), emit, counts)
    emit("equal", "".join(la[len(la) - tail:]))
    return {"ok": True, "slug": slug, "doc": doc, "old": old_meta, "new": new_meta,
            "segments": segs, "stats": {"added": counts["added"], "removed": counts["removed"],
                                        "changed": len([s for s in segs if s["op"] != "equal"])}}


# ---- latexdiff redline PDF (the marked-up document for journal reviewers)
def diff_pdf(vault, slug, doc=DEFAULT_DOC, a=None, b="current", timeout=300):
    if ((doc or "").strip().lower().startswith("deck:")
            or (slug or "").strip().lower() in ("syllabi", "measures")):
        return {"error": "The redline PDF is for manuscripts — use the in-app "
                "comparison for decks, syllabi, and free writing."}
    if not settings.RUN_VAULT_SCRIPTS:
        return {"error": VAULT_SCRIPTS_OFF}
    paths = _writing_paths(vault, slug, doc)
    if not paths:
        return {"error": "unknown paper"}
    manu = paths[0]
    if not manu.exists():
        return {"error": manu.name + " not found"}
    proj = _proj_of_doc(manu)
    wdir = proj / "writing"
    build = wdir / "build"
    wrapper = _find_wrapper(build, manu.name[:-3])
    if wrapper is None:
        return {"error": "This manuscript has no build wrapper yet: compile it once in Publish "
                "to create writing/build/<wrapper>.tex, then a diff PDF can compile."}
    kit = _toolkit(vault)
    m2l = kit / "scripts" / "md_to_latex.py"
    if not m2l.exists():
        return {"error": "the toolkit script scripts/md_to_latex.py was not found"}
    latexdiff = kit / "scripts" / "latexdiff.pl"
    if not latexdiff.exists():
        return {"error": "the diff engine (toolkit scripts/latexdiff.pl) is missing"}
    pandoc, perl, pdflatex = _native_tool("pandoc"), _native_tool("perl"), _native_tool("pdflatex")
    if not (pandoc and perl and pdflatex):
        return {"error": "the redline PDF needs pandoc, perl and pdflatex on PATH"}
    base = manu.name[:-3]

    old_text, old_meta = _diff_text_for(vault, slug, a, doc)
    new_text, new_meta = _diff_text_for(vault, slug, b, doc)
    if old_text is None:
        return {"error": "old version not found"}
    if new_text is None:
        return {"error": "new version not found"}
    if old_text == new_text:
        return {"error": "these two versions are identical — nothing to diff"}

    try:
        build.mkdir(parents=True, exist_ok=True)
        (build / "vdiff_old.md").write_text(old_text, encoding="utf-8")
        (build / "vdiff_new.md").write_text(new_text, encoding="utf-8")
    except OSError as e:
        return {"error": "could not stage the diff sources: " + str(e)}

    steps = []
    for v in ("vdiff_old", "vdiff_new"):
        steps.append(([sys.executable, m2l, "writing/build/" + v + ".md", "--project-dir", proj,
                       "--strip-metadata", "-o", "writing/build/" + v + ".pre.md"], proj))
    for v in ("vdiff_old", "vdiff_new"):
        steps.append(([pandoc, v + ".pre.md", "-f", "markdown", "-t", "latex", "--wrap=none",
                       "--shift-heading-level-by=-1", "-o", v + ".body.tex"], build))
    for v in ("vdiff_old", "vdiff_new"):
        steps.append(([sys.executable, m2l, "dummy", "--postprocess-tex", v + ".body.tex"], build))
    try:
        _run_steps(steps, min(timeout, 180))
    except subprocess.TimeoutExpired:
        return {"error": f"diff compile timed out after {timeout}s"}
    except (FileNotFoundError, OSError):
        return {"error": "could not launch the TeX toolchain"}

    # inline each version's body into a copy of the canonical wrapper (no latexdiff
    # --flatten: tables/figures stay opaque so they pass through the diff unchanged)
    wtext = _read(wrapper) or ""
    if not _INPUT_BODY_RE.search(wtext):
        return {"error": "the build wrapper doesn't \\input{body} — can't assemble the diff"}
    body_old = _read(build / "vdiff_old.body.tex")
    body_new = _read(build / "vdiff_new.body.tex")
    if body_old is None or body_new is None:
        return {"error": "the version bodies didn't convert to LaTeX (check the manuscript sources)"}
    try:
        # re.sub repl is a function (not a string) so a body containing backslashes or
        # group refs like \1 is inserted literally, never interpreted as a replacement template
        (build / "vdiff_old.full.tex").write_text(
            _INPUT_BODY_RE.sub(lambda _m: body_old, wtext, count=1), encoding="utf-8")
        (build / "vdiff_new.full.tex").write_text(
            _INPUT_BODY_RE.sub(lambda _m: body_new, wtext, count=1), encoding="utf-8")
    except OSError as e:
        return {"error": "could not assemble the diff documents: " + str(e)}

    env = _tex_env(kit, wdir)
    log_out = []
    try:
        ld = _native_run([perl, latexdiff, "--encoding=utf8", "vdiff_old.full.tex", "vdiff_new.full.tex"],
                         build, timeout, env=env)
        if ld.returncode != 0:
            return {"error": "latexdiff couldn't build the redline",
                    "log": (ld.stderr or "").splitlines()[-15:]}
        (build / "vdiff.tex").write_text(ld.stdout or "", encoding="utf-8")
        for _ in range(2):
            _native_run([pdflatex, "-no-shell-escape", "-interaction=nonstopmode", "vdiff.tex"], build, timeout, env=env)
        for l in (_read(build / "vdiff.log") or "").splitlines():
            if l.startswith("! ") or "LaTeX Error" in l or "Undefined control" in l:
                log_out.append(l)
        if (build / "vdiff.pdf").exists():
            shutil.copyfile(build / "vdiff.pdf", wdir / (base + ".diff.pdf"))
    except subprocess.TimeoutExpired:
        return {"error": f"diff compile timed out after {timeout}s"}
    except (FileNotFoundError, OSError):
        return {"error": "could not launch the TeX toolchain"}
    r = subprocess.CompletedProcess([], 0, stdout="\n".join(log_out[:20]), stderr="")

    log_lines = [l for l in (r.stdout or "").splitlines() if l.strip()]
    out_pdf = wdir / (base + ".diff.pdf")
    if not out_pdf.exists():
        return {"error": "the diff PDF didn't compile", "log": log_lines[-25:],
                "stderr": (r.stderr or "")[-800:]}
    return {"ok": True, "pdfRel": _rel(vault, out_pdf), "pages": _pdf_pages(out_pdf),
            "mtime": _mt(out_pdf), "old": old_meta, "new": new_meta,
            "latexErrors": log_lines[:20]}


def diff_pdf_path(vault, slug, doc=DEFAULT_DOC):
    """Absolute path of the last-compiled diff PDF (writing/<base>.diff.pdf), or None."""
    paths = _writing_paths(vault, slug, doc)
    if not paths:
        return None
    p = paths[0].parent / (paths[0].name[:-3] + ".diff.pdf")
    return p if p.exists() else None



_FM_MARP = re.compile(r"^marp\s*:\s*true\s*$", re.M)
_SLIDE_HDR = re.compile(r"^##\s+Slide\s+(\d+)\b", re.I)
_IMG_SRC_RE = re.compile(r'(<img\b[^>]*?\bsrc=")([^"]+)(")', re.I)
_CSS_URL_RE = re.compile(r'url\((["\']?)([^)"\']+)\1\)')


def _is_marp(text):
    return bool(_FM_MARP.search(_frontmatter(text or "")))


def _marp_theme_dir(vault):
    return _toolkit(vault) / "report-templates" / "marp"


def _deck_title(text, stem):
    """Deck title: frontmatter title, else first H1, else a humanized stem."""
    return _paper_title(text, "") or stem.replace("-", " ").replace("_", " ").strip().title()


def _slide_estimate(text):
    """Cheap slide count from the source (render() is authoritative). Every standalone
    `---` rule is a Marp slide break; the frontmatter open/close pair contributes one
    extra dash-line over the slide count, so slides = dash-lines - 1."""
    dashes = len(re.findall(r"(?m)^---[ \t]*$", text or ""))
    return max(1, dashes - 1)


def _find_notes(deck_path):
    if not deck_path:
        return None
    d, stem = deck_path.parent, deck_path.stem
    cands = ["slide-notes"]
    if "slides" in stem:
        cands.append(stem.replace("slides", "notes"))
    cands += [stem + "-notes", stem + ".notes", "notes"]
    for c in cands:
        p = d / (c + ".md")
        if p.exists() and p != deck_path:
            return p
    return None


def _review_path(deck_path):
    return deck_path.parent / (deck_path.stem + ".review.md")


def _deck_path(vault, slug, deck):
    proj = _project_dir(vault, slug)
    if not proj:
        return None
    deck = (deck or "").replace("\\", "/").strip().lstrip("/")
    if not deck or ".." in deck:
        return None
    base = deck.split("/")[-1]
    for c in (proj / deck, proj / "writing" / "presentations" / base, proj / "writing" / base):
        try:
            r = c.resolve()
            r.relative_to(proj.resolve())
            if r.is_file() and r.suffix.lower() == ".md":
                return r
        except (ValueError, OSError):
            pass
    wdir = proj / "writing"
    if wdir.is_dir():
        for dp, dn, fns in os.walk(wdir):
            dn[:] = [x for x in dn if x not in (".cache", "build", ".writing-backups", "tex", "versioning", "archive", ".versions")]
            if base in fns:
                r = (Path(dp) / base).resolve()
                try:
                    r.relative_to(proj.resolve())
                    if r.suffix.lower() == ".md":
                        return r
                except ValueError:
                    pass
    return None


def list_presentations(vault):
    """Every Marp deck (frontmatter `marp: true`) under a project's writing/ folder — the
    presentation picker. One entry per deck."""
    root = vault / "Projects" / "papers"
    out = []
    roots = []
    if root.is_dir():
        roots = [(settings.live_slug(d.name), d / "writing", "") for d in sorted(root.iterdir())
                 if d.is_dir() and settings.live_slug(d.name) and (d / "writing").is_dir()]
    for slug, wdir, group in roots:
        for dp, dn, fns in os.walk(wdir):
            dn[:] = [x for x in dn if x not in (".cache", "build", ".writing-backups", "tex", "archive", ".obsidian", "versioning", "versions", ".versions")]
            for fn in sorted(fns):
                if not fn.endswith(".md"):
                    continue
                p = Path(dp) / fn
                txt = _read(p) or ""
                if not _is_marp(txt):
                    continue
                review = _review_path(p)
                has_review = review.exists() and bool((_read(review) or "").strip())
                out.append({
                    "slug": slug,
                    "group": group,
                    "deck": fn,
                    "deckRel": _rel(vault, p),
                    "title": _deck_title(txt, p.stem),
                    "slides": _slide_estimate(txt),
                    "deckMtime": _mt(p),
                    "hasNotes": _find_notes(p) is not None,
                    "hasReview": has_review,
                    "reviewMtime": _mt(review) if review.exists() else 0,
                    "status": get_status("deck:%s:%s" % (slug, fn)),
                })
    out.sort(key=lambda x: -x["deckMtime"])
    return out


_REPORT_SKIP = {"replication", "results", "figures", "output", "archive",
                "__pycache__", ".template", "formatting", "logs", ".git",
                "writing"}   # a brief's writing/ is the DOC, not a nested report dir


def _iter_report_dirs(root, depth=2):
    if depth <= 0 or not root.is_dir():
        return
    for d in sorted(root.iterdir()):
        if not d.is_dir() or d.name.startswith(".") or d.name in _REPORT_SKIP:
            continue
        yield d
        yield from _iter_report_dirs(d, depth - 1)


def _adopt_report_md(d):
    src = d / "report.md"
    dst = d / "writing" / "report.md"
    try:
        if src.is_file() and not dst.exists():
            dst.parent.mkdir(parents=True, exist_ok=True)
            os.replace(str(src), str(dst))
    except OSError:
        pass


def list_reports(vault):
    root = vault / "Projects" / "briefs"
    out = []
    if not root.is_dir():
        return _list_letters(vault)
    for d in _iter_report_dirs(root):
        rid = str(d.relative_to(root)).replace("\\", "/")
        key = "report:" + rid
        if d.parent == root:
            _adopt_report_md(d)
            wmd = d / "writing" / "report.md"
            if wmd.exists():
                txt = _read(wmd) or ""
                rpdf = wmd.with_suffix(".pdf")
                out.append({
                    "id": rid, "render": "edit", "slug": d.name, "doc": "report.md",
                    "title": _paper_title(txt, d.name) or d.name,
                    "words": _wordcount(txt), "mtime": _mt(wmd), "status": get_status(key),
                    "previewUrl": _fm_value(txt, "preview"),
                    "pdf": rpdf.exists(),
                })
                continue
        md = d / "report.md"
        if md.exists():
            txt = _read(md) or ""
            out.append({
                "id": rid, "render": "md", "title": _paper_title(txt, d.name) or d.name,
                "words": _wordcount(txt), "mtime": _mt(md), "status": get_status(key),
            })
            continue
        htmls = sorted(d.glob("*.html"))
        if htmls:
            out.append({
                "id": rid, "render": "html", "title": d.name,
                "words": 0, "mtime": _mt(htmls[0]), "status": get_status(key),
            })
    out.extend(_list_letters(vault))
    out.sort(key=lambda r: -r["mtime"])
    return out


def _list_letters(vault):
    root = vault / "Projects" / "letters"
    out = []
    if not root.is_dir():
        return out
    for d in sorted(root.iterdir()):
        if not d.is_dir() or d.name.startswith(".") or d.name == "archive":
            continue
        lmd = d / "writing" / "letter.md"
        if not lmd.is_file():
            continue
        rid = "letters/" + d.name
        txt = _read(lmd) or ""
        out.append({
            "id": rid, "render": "edit", "slug": d.name, "doc": "letter.md",
            "kind": "letter", "title": _paper_title(txt, d.name) or d.name,
            "words": _wordcount(txt), "mtime": _mt(lmd), "status": get_status("report:" + rid),
            "previewUrl": "", "pdf": lmd.with_suffix(".pdf").exists(),
        })
    return out


def _report_dir(vault, rid):
    d = _confine(vault / "Projects" / "briefs", rid)
    return d if d and d.is_dir() else None


def read_report(vault, rid):
    d = _report_dir(vault, rid)
    if not d:
        return {"error": "not found"}
    md = d / "report.md"
    if not md.exists():
        return {"error": "no report.md"}
    txt = _read(md) or ""
    return {"id": rid, "title": _paper_title(txt, d.name) or d.name, "text": _strip_frontmatter(txt), "mtime": _mt(md)}


def report_html_path(vault, rid):
    d = _report_dir(vault, rid)
    if not d:
        return None
    htmls = sorted(d.glob("*.html"))
    return htmls[0] if htmls else None


def report_visual(vault, slug):
    paths = _writing_paths(vault, slug, "report.md")
    if not paths:
        return {"error": "unknown slug"}
    ddir = paths[0].parent / "dashboard"
    if not ddir.is_dir():
        return {"ok": False}
    data = {}
    for p in sorted(ddir.glob("*.json")):
        try:
            data[p.stem] = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {"error": "unreadable dashboard JSON: " + p.name}
    if not data:
        return {"ok": False}
    s = data.get("summary")
    viewer = str(s.get("slug") or "") if isinstance(s, dict) else ""
    return {"ok": True, "viewer": viewer, "files": sorted(data.keys()), "data": data}


def doc_preview_url(vault, slug, doc="report.md"):
    """The `preview:` frontmatter URL of a manuscript — the live page a report ships
    to. Validated to http(s) so open-preview can never
    fire an arbitrary URI through the host protocol handler."""
    paths = _writing_paths(vault, slug, doc)
    if not paths or not paths[0].exists():
        return None
    url = _fm_value(_read(paths[0]) or "", "preview")
    return url if url.startswith(("http://", "https://")) else None


_MEASURE_EXTS = {".docx", ".md", ".pdf"}


def list_measures(vault):
    root = vault / "Preparation" / "Free Writing"
    out = []
    if not root.is_dir():
        return out
    for cat in sorted(root.iterdir()):
        if not cat.is_dir() or cat.name.startswith("."):
            continue
        md_stems = {f.stem for f in cat.iterdir() if f.is_file() and f.suffix.lower() == ".md"}
        for f in sorted(cat.iterdir()):
            if not f.is_file() or f.suffix.lower() not in _MEASURE_EXTS:
                continue
            if f.suffix.lower() == ".docx" and f.stem in md_stems:
                continue
            rid = cat.name + "/" + f.name
            title = f.stem
            if f.suffix.lower() == ".md":
                fm_title = _fm_value(_read(f) or "", "title")
                title = fm_title or title
            out.append({
                "id": rid, "category": cat.name, "title": title, "ext": f.suffix.lower().lstrip("."),
                "mtime": _mt(f), "status": get_status("measure:" + rid),
            })
    out.sort(key=lambda r: -r["mtime"])
    return out


def measure_path(vault, rid):
    return _confine(vault / "Preparation" / "Free Writing", rid)


def measure_preview_pdf(vault, rid):
    p = measure_path(vault, rid)
    if not p or not p.is_file():
        return None
    ext = p.suffix.lower()
    if ext == ".pdf":
        return p
    if ext == ".docx":
        return _docx_to_pdf(p)
    return None


def read_measure_text(vault, rid):
    p = measure_path(vault, rid)
    if not p or not p.is_file() or p.suffix.lower() != ".md":
        return {"error": "not a markdown file"}
    txt = _read(p) or ""
    return {
        "id": rid, "title": _fm_value(txt, "title") or p.stem,
        "kind": _fm_value(txt, "kind") or "prose",
        "text": _strip_frontmatter(txt), "mtime": _mt(p),
    }


def save_measure(vault, rid, text, base_mtime=None, force=False):
    p = measure_path(vault, rid)
    if not p or not p.is_file() or p.suffix.lower() != ".md":
        return {"error": "not a markdown file"}
    old = _read(p) or ""
    cur_mtime = _mt(p)
    if not force and base_mtime is not None and int(base_mtime) != cur_mtime:
        return {"conflict": True, "mtime": cur_mtime, "text": old}
    _atomic_write(p, old, text, label="measure")
    _maybe_auto_checkpoint(vault, "measures", rid)
    return {"ok": True, "mtime": _mt(p)}




def _sy_count_readings(body):
    """Rough reading count: bullet items plus ordered-list items in the body."""
    n = 0
    for ln in (body or "").splitlines():
        s = ln.strip()
        if s.startswith(("- ", "* ")) or re.match(r"^\d+[.)]\s", s):
            n += 1
    return n


def list_syllabi(vault):
    out = []
    syroot = vault / "Preparation" / "Reading" / "Syllabi"
    if syroot.is_dir():
        for d in sorted(syroot.iterdir()):
            if not d.is_dir() or d.name.startswith((".", "_")):
                continue
            f = d / "syllabus.md"
            if not f.is_file():
                continue
            txt = _read(f) or ""
            body = _strip_frontmatter(txt)
            pdf = d / "syllabus.pdf"
            out.append({
                "id": "syllabus/" + d.name, "kind": "syllabus", "slug": d.name,
                "title": _fm_value(txt, "title") or d.name,
                "subtitle": _fm_value(txt, "subtitle"),
                "course": _fm_value(txt, "course"), "term": _fm_value(txt, "term"),
                "readings": _sy_count_readings(body), "words": _wordcount(body),
                "mtime": _mt(f), "hasPdf": pdf.is_file(),
                "pdfMtime": _mt(pdf) if pdf.is_file() else 0,
                "status": get_status("syllabus:syllabus/" + d.name),
            })
    listroot = vault / "Preparation" / "Reading" / "Lists"
    if listroot.is_dir():
        for f in sorted(listroot.iterdir()):
            if (not f.is_file() or f.suffix.lower() != ".md"
                    or f.name.startswith((".", "_"))):
                continue
            txt = _read(f) or ""
            body = _strip_frontmatter(txt)
            pdf = f.with_suffix(".pdf")
            out.append({
                "id": "list/" + f.stem, "kind": "list", "slug": f.stem,
                "title": _fm_value(txt, "title") or f.stem,
                "subtitle": _fm_value(txt, "subtitle"),
                "program": _fm_value(txt, "program"), "term": _fm_value(txt, "term"),
                "readings": _sy_count_readings(body), "words": _wordcount(body),
                "mtime": _mt(f), "hasPdf": pdf.is_file(),
                "pdfMtime": _mt(pdf) if pdf.is_file() else 0,
                "status": get_status("syllabus:list/" + f.stem),
            })
    out.sort(key=lambda r: -r["mtime"])
    return out


def _syllabus_md_path(vault, sid):
    sid = (sid or "").strip()
    if sid.startswith("syllabus/"):
        slug = sid[len("syllabus/"):]
        if not slug or "/" in slug or "\\" in slug or ".." in slug:
            return None
        return _confine(vault / "Preparation" / "Reading" / "Syllabi",
                        slug + "/syllabus.md")
    if sid.startswith("list/"):
        slug = sid[len("list/"):]
        if not slug or "/" in slug or "\\" in slug or ".." in slug:
            return None
        return _confine(vault / "Preparation" / "Reading" / "Lists", slug + ".md")
    return None


def _syllabus_pdf_path(vault, sid):
    p = _syllabus_md_path(vault, sid)
    if not p:
        return None
    return (p.with_name("syllabus.pdf") if p.name == "syllabus.md"
            else p.with_suffix(".pdf"))


def read_syllabus_text(vault, sid):
    """The full markdown (frontmatter INCLUDED — the editor edits the whole file,
    frontmatter and all) plus mtime, for the manuscript editor."""
    p = _syllabus_md_path(vault, sid)
    if not p or not p.is_file():
        return {"error": "unknown syllabus"}
    txt = _read(p) or ""
    pdf = _syllabus_pdf_path(vault, sid)
    return {
        "id": sid, "title": _fm_value(txt, "title") or p.stem,
        "text": txt, "mtime": _mt(p),
        "kind": "list" if sid.startswith("list/") else "syllabus",
        "hasPdf": bool(pdf and pdf.is_file()),
    }


def save_syllabus(vault, sid, text, base_mtime=None, force=False):
    p = _syllabus_md_path(vault, sid)
    if not p:
        return {"error": "bad id"}
    if text is None:
        return {"error": "no text"}
    p.parent.mkdir(parents=True, exist_ok=True)
    old = _read(p) if p.exists() else None
    if p.exists():
        cur = _mt(p)
        if not force and base_mtime is not None and int(base_mtime) != cur:
            return {"conflict": True, "mtime": cur, "text": old or ""}
    _atomic_write(p, old, text, label="syllabus")
    _maybe_auto_checkpoint(vault, "syllabi", sid)
    return {"ok": True, "mtime": _mt(p)}


def render_syllabus(vault, sid, timeout=240):
    p = _syllabus_md_path(vault, sid)
    if not p or not p.is_file():
        return {"error": "unknown syllabus"}
    if not settings.RUN_VAULT_SCRIPTS:
        return {"error": VAULT_SCRIPTS_OFF}
    builder = _toolkit(vault) / "scripts" / "build_syllabus.py"
    if not builder.is_file():
        return {"error": "the toolkit script scripts/build_syllabus.py was not found"}
    try:
        r = _native_run([sys.executable, str(builder), str(p)], builder.parent, timeout)
    except Exception as e:  # noqa: BLE001
        return {"error": "could not launch the TeX toolchain (%s)" % e}
    pdf = _syllabus_pdf_path(vault, sid)
    if pdf and pdf.is_file():
        return {"ok": True, "pdf": _rel(vault, pdf), "mtime": _mt(pdf),
                "log": ((r.stdout or "") + (r.stderr or ""))[-600:]}
    return {"error": "render failed",
            "log": ((r.stdout or "") + (r.stderr or ""))[-1400:]}


_NOTE_HDR = re.compile(r"^##\s+Slide\s+(\d+)\s*:?[ \t]*(.*?)[ \t]*$", re.I)
_NOTE_BOUNDARY = re.compile(r"^(?:##\s|---[ \t]*$)")


def _parse_note_sections(raw):
    """Ordered list of {num, title, header_start, header_end, body_start, body_end}
    (char offsets into `raw`) for a notes file's `## Slide N` sections. body_start..body_end
    spans the note body (bullets + any trailing blank line) up to the next section boundary."""
    lines = (raw or "").splitlines(keepends=True)
    offs, o = [], 0
    for ln in lines:
        offs.append(o)
        o += len(ln)
    total = o
    hdrs = []
    for i, ln in enumerate(lines):
        m = _NOTE_HDR.match(ln)
        if m:
            hdrs.append((i, int(m.group(1)), (m.group(2) or "").strip()))
    out = []
    for (li, num, title) in hdrs:
        header_end = offs[li] + len(lines[li])
        body_end = total
        for j in range(li + 1, len(lines)):
            if _NOTE_BOUNDARY.match(lines[j]):
                body_end = offs[j]
                break
        out.append({"num": num, "title": title, "header_start": offs[li],
                    "header_end": header_end, "body_start": header_end, "body_end": body_end})
    return out


def _deck_note_map(notes_path):
    """{slide_num: {"note": body, "title": heading title}} from a companion notes file."""
    if not notes_path or not notes_path.exists():
        return {}
    raw = _read(notes_path) or ""
    return {s["num"]: {"note": raw[s["body_start"]:s["body_end"]].strip(), "title": s["title"]}
            for s in _parse_note_sections(raw)}


def _deck_notes(notes_path):
    """Parse a per-slide speaker-notes file (## Slide N: ...) into {slide_num: text}."""
    return {n: v["note"] for n, v in _deck_note_map(notes_path).items()}


def _notes_target(deck_path):
    p = _find_notes(deck_path)
    if p:
        return p
    return deck_path.parent / "slide-notes.md"


def _asset_url(slug, ref, vault=None):
    """Rewrite a deck-relative figure reference to the Drafting asset endpoint (basename-
    resolved, same as every other embed). Leaves absolute/data/already-rooted refs alone."""
    ref = (ref or "").strip()
    if not ref or ref.startswith(("http://", "https://", "data:", "//", "/drafting/", "#")):
        return None
    name = ref.split("/")[-1]
    url = "/drafting/asset?slug=" + quote(slug) + "&name=" + quote(name)
    if vault is not None:
        tag = _asset_version(vault, slug, name)
        if tag:
            url += "&v=" + quote(tag)
    return url


def _asset_version(vault, slug, name):
    """A short mtime-size stamp for an asset, or None if it cannot be resolved."""
    try:
        p = _find_asset(vault, slug, name)
        if not p:
            return None
        st = p.stat()
        return format(int(st.st_mtime_ns), "x") + "-" + format(int(st.st_size), "x")
    except OSError:
        return None


def _rewrite_assets(html, slug, vault=None):
    def _img(m):
        u = _asset_url(slug, m.group(2), vault)
        return m.group(1) + (u or m.group(2)) + m.group(3)

    def _url(m):
        u = _asset_url(slug, m.group(2), vault)
        return "url(" + m.group(1) + (u or m.group(2)) + m.group(1) + ")"
    return _CSS_URL_RE.sub(_url, _IMG_SRC_RE.sub(_img, html))


def render_deck(vault, slug, deck, timeout=120):
    p = _deck_path(vault, slug, deck)
    if not p:
        return {"error": "unknown deck"}
    txt = _read(p) or ""
    if not _is_marp(txt):
        return {"error": "not a Marp deck (needs `marp: true` frontmatter)"}
    _maybe_auto_checkpoint(vault, slug, "deck:" + p.name)
    theme_dir = _marp_theme_dir(vault)
    node = _native_tool("node")
    render = str(settings.get("marp_render", "")).strip()
    if not node or not render or not os.path.isfile(render):
        return {"error": "no deck renderer is configured (set marp_render to a render.mjs; needs Node)"}
    if Path(render).resolve().is_relative_to(Path(vault).resolve()) and not settings.RUN_VAULT_SCRIPTS:
        return {"error": VAULT_SCRIPTS_OFF}
    try:
        r = _native_run([node, render, str(p), str(theme_dir)], p.parent, timeout)
    except (FileNotFoundError, OSError):
        return {"error": "could not launch the deck renderer"}
    except subprocess.TimeoutExpired:
        return {"error": "rendering timed out"}
    out = (r.stdout or "").strip()
    if not out:
        return {"error": "the renderer produced no output", "stderr": (r.stderr or "")[:600]}
    try:
        data = json.loads(out)
    except ValueError:
        return {"error": "the renderer output was not JSON", "stderr": (r.stderr or out)[:600]}
    if not data.get("ok"):
        return {"error": data.get("error") or "render failed"}
    raw = data.get("slides") or []
    inline = data.get("comments") or []
    notes_p = _find_notes(p)
    notes = _deck_note_map(notes_p)
    slides = []
    for i, svg in enumerate(raw):
        rec = notes.get(i + 1) or {}
        note = rec.get("note") or ""
        if not note and i < len(inline) and inline[i]:
            note = "\n".join(inline[i]).strip()
        slides.append({"svg": _rewrite_assets(svg, slug, vault), "note": note, "noteTitle": rec.get("title") or ""})
    return {
        "slug": slug, "deck": p.name, "deckRel": _rel(vault, p),
        "title": _deck_title(txt, p.stem), "count": len(slides),
        "css": data.get("css") or "", "slides": slides,
        "notesRel": _rel(vault, notes_p) if notes_p else _rel(vault, _notes_target(p)),
        "notesMtime": _mt(notes_p) if notes_p else 0,
        "deckMtime": _mt(p),
        "review": read_review(vault, slug, deck),
    }


def read_review(vault, slug, deck):
    """The per-slide improvement-comments sidecar for a deck ({text, mtime, rel})."""
    p = _deck_path(vault, slug, deck)
    if not p:
        return {"text": "", "mtime": 0, "rel": ""}
    rp = _review_path(p)
    if rp.exists():
        return {"text": _read(rp) or "", "mtime": _mt(rp), "rel": _rel(vault, rp)}
    return {"text": "", "mtime": 0, "rel": _rel(vault, rp)}


def save_review(vault, slug, deck, text, base_mtime=None, force=False):
    """Mtime-guarded atomic write of the deck's review sidecar. Confined to the project."""
    if text is None:
        return {"error": "no text"}
    p = _deck_path(vault, slug, deck)
    if not p:
        return {"error": "unknown deck"}
    rp = _review_path(p)
    old = None
    if rp.exists():
        cur = _mt(rp)
        if base_mtime is not None and not force and cur != int(base_mtime):
            return {"conflict": True, "currentMtime": cur, "currentText": _read(rp) or ""}
        old = _read(rp)
    _atomic_write(rp, old, text, label="review")
    return {"ok": True, "mtime": _mt(rp), "rel": _rel(vault, rp)}


def _insert_note_section(raw, secs, slide, body):
    block = "## Slide {}:\n{}\n\n".format(slide, body) if body else "## Slide {}:\n\n".format(slide)
    if not (raw or "").strip():
        return "# Speaker Notes\n\n" + block.rstrip() + "\n"
    higher = [s for s in secs if s["num"] > slide]
    if higher:
        at = min(s["header_start"] for s in higher)
        head = raw[:at]
        if head and not head.endswith("\n\n"):
            head = head.rstrip("\n") + "\n\n"
        return head + block + raw[at:]
    at = max((s["body_end"] for s in secs), default=len(raw))
    head = raw[:at]
    if head and not head.endswith("\n"):
        head += "\n"
    tail = raw[at:]
    return head + ("" if head.endswith("\n\n") else "\n") + block.rstrip() + "\n" + ("\n" + tail.lstrip("\n") if tail.strip() else "")


def save_deck_note(vault, slug, deck, slide, text, base_mtime=None, force=False):
    if text is None:
        return {"error": "no text"}
    try:
        slide = int(slide)
    except (TypeError, ValueError):
        return {"error": "bad slide number"}
    if slide < 1:
        return {"error": "bad slide number"}
    p = _deck_path(vault, slug, deck)
    if not p:
        return {"error": "unknown deck"}
    notes_p = _notes_target(p)
    exists = notes_p.exists()
    raw = _read(notes_p) if exists else ""
    if exists and base_mtime is not None and not force:
        cur = _mt(notes_p)
        if cur != int(base_mtime):
            return {"conflict": True, "currentMtime": cur}
    body = (text or "").strip()
    secs = _parse_note_sections(raw)
    target = next((s for s in secs if s["num"] == slide), None)
    if target:
        eof = target["body_end"] >= len(raw)
        if not body:
            new_body = "\n"
        elif eof:
            new_body = body + "\n"
        else:
            new_body = body + "\n\n"
        new_raw = raw[:target["body_start"]] + new_body + raw[target["body_end"]:]
    else:
        new_raw = _insert_note_section(raw, secs, slide, body)
    _atomic_write(notes_p, raw if exists else None, new_raw, label="deck-note")
    return {"ok": True, "mtime": _mt(notes_p), "notesRel": _rel(vault, notes_p)}


_FINDINGS_MAX_BYTES = 4 * 1024 * 1024


def _findings_rowmeta(numberscheck, rows):
    """(label_columns, selectors, labels) for a CSV, exactly as numberscheck.catalogue
    derives them — so a finding's `row` label resolves to the same selector the picker
    would have bound."""
    cols = list(rows[0].keys()) if rows else []
    numeric, label = numberscheck._classify(rows, cols)
    label = label[:3]
    sels = numberscheck._row_selectors(rows, label)
    labels = []
    for i, r in enumerate(rows):
        lab = " · ".join(numberscheck.norm_text(r.get(c, "")) for c in label
                         if str(r.get(c, "")).strip()) or ("row %d" % i)
        labels.append(lab)
    return label, sels, labels


def _findings_selector(numberscheck, rows, want):
    """A resolve_row selector for a finding's `row`. A dict or an int passes straight
    through; a LABEL string is matched against the row labels the catalogue shows
    (exact, then normalised, then the first label column alone)."""
    if isinstance(want, dict):
        return want, None
    if isinstance(want, int):
        return want, None
    s = numberscheck.norm_text(str(want or ""))
    if not s:
        return None, "no row selector recorded"
    label_cols, sels, labels = _findings_rowmeta(numberscheck, rows)
    hits = [i for i, lab in enumerate(labels) if numberscheck.norm_text(lab) == s]
    if not hits:
        low = s.lower()
        hits = [i for i, lab in enumerate(labels) if numberscheck.norm_text(lab).lower() == low]
    if not hits and label_cols:
        c0 = label_cols[0]
        hits = [i for i, r in enumerate(rows)
                if numberscheck.norm_text(r.get(c0, "")).lower() == s.lower()]
    if not hits:
        return None, "no row labelled %r in this table" % (str(want),)
    if len(hits) > 1:
        return None, "%d rows labelled %r" % (len(hits), str(want))
    return sels[hits[0]], None


def _findings_live(proj, num, numberscheck, rows_cache):
    """{value, status: traced|drift|missing, msg} for one finding number, read live
    off its source CSV. Never raises."""
    rel = str(num.get("file") or "").replace("\\", "/").lstrip("/")
    if not rel:
        return {"value": None, "status": "missing", "msg": "no source file recorded"}
    if ".." in rel.split("/"):
        return {"value": None, "status": "missing", "msg": "bad source path"}
    src = Path(proj) / rel
    if not src.is_file():
        return {"value": None, "status": "missing", "msg": "source file missing on this tree"}
    if rel not in rows_cache:
        try:
            rows_cache[rel] = numberscheck.load_rows(src)
        except Exception as exc:                      # unreadable CSV
            rows_cache[rel] = exc
    rows = rows_cache[rel]
    if isinstance(rows, Exception):
        return {"value": None, "status": "missing", "msg": "cannot read the table: %s" % rows}
    if not rows:
        return {"value": None, "status": "missing", "msg": "the table is empty"}
    sel, err = _findings_selector(numberscheck, rows, num.get("row"))
    if err:
        return {"value": None, "status": "missing", "msg": err}
    row, err = numberscheck.resolve_row(rows, sel, num.get("id") or rel)
    if err:
        return {"value": None, "status": "missing", "msg": err}
    col = num.get("column")
    if col not in row:
        return {"value": None, "status": "missing",
                "msg": "column %r not in the table (has: %s)" % (col, ", ".join(list(row)[:6]))}
    raw = row[col]
    try:
        live = numberscheck.first_number(raw) * float(num.get("scale") or 1)
    except (ValueError, TypeError):
        return {"value": None, "status": "missing", "raw": str(raw),
                "msg": "the cell holds no number: %r" % (str(raw)[:40],)}
    try:
        target = float(num.get("value"))
    except (TypeError, ValueError):
        return {"value": live, "status": "drift", "raw": str(raw),
                "msg": "findings.json records no comparable value"}
    try:
        prec = int(num.get("precision"))
    except (TypeError, ValueError):
        prec = 3
    prec = max(0, min(8, prec))
    tol = 0.5 * 10 ** (-prec) + 1e-9
    if abs(live - target) <= tol:
        return {"value": live, "status": "traced", "raw": str(raw),
                "msg": "%g matches the recorded value at %d dp" % (live, prec)}
    return {"value": live, "status": "drift", "raw": str(raw),
            "msg": "recorded %g but the table now gives %g — re-run moved the number"
                   % (target, live)}


def list_findings(vault, slug):
    """results/findings.json for a project, every number re-resolved live."""
    proj = _project_dir(vault, slug)
    if not proj:
        return {"error": "unknown slug"}
    p = proj / "results" / "findings.json"
    if not p.is_file():
        return {"error": "no results/findings.json in this project", "slug": slug,
                "expected": _rel(vault, p)}
    try:
        if p.stat().st_size > _FINDINGS_MAX_BYTES:
            return {"error": "findings.json is too large to read"}
        data = json.loads(p.read_text(encoding="utf-8"))
    except Exception as exc:
        return {"error": "findings.json unreadable: %s" % exc}
    if not isinstance(data, dict):
        return {"error": "findings.json is not an object"}

    try:
        import numberscheck
    except Exception as exc:
        return {"error": "numberscheck unavailable: %s" % exc}
    try:
        manifest = numberscheck._load_provenance(proj)
    except Exception:
        manifest = {}

    rows_cache, meta_cache, script_cache = {}, {}, {}
    n_num = n_traced = n_drift = n_missing = n_find = 0
    sections = []
    themes = []
    for t in (data.get("themes") or []):
        if not isinstance(t, dict):
            continue
        findings = []
        for f in (t.get("findings") or []):
            if not isinstance(f, dict):
                continue
            n_find += 1
            for s in (f.get("sections") or []):
                if isinstance(s, str) and s.strip() and s not in sections:
                    sections.append(s)
            nums = []
            for num in (f.get("numbers") or []):
                if not isinstance(num, dict):
                    continue
                n_num += 1
                out = dict(num)
                live = _findings_live(proj, num, numberscheck, rows_cache)
                out["live"] = live
                if live["status"] == "traced":
                    n_traced += 1
                elif live["status"] == "drift":
                    n_drift += 1
                else:
                    n_missing += 1
                rel = str(num.get("file") or "").replace("\\", "/").lstrip("/")
                if rel and rel not in meta_cache:
                    try:
                        meta_cache[rel] = numberscheck._source_meta(proj, rel, manifest)
                    except Exception:
                        meta_cache[rel] = {"provenance": None}
                prov = (meta_cache.get(rel) or {}).get("provenance") or {}
                out["freshness"] = prov.get("freshness") or "unrecorded"
                out["provenanceRecord"] = prov or None
                script = str(num.get("script") or "").replace("\\", "/").lstrip("/")
                if script:
                    if script not in script_cache:
                        script_cache[script] = (".." not in script.split("/")
                                                and (Path(proj) / script).is_file())
                    out["scriptExists"] = script_cache[script]
                else:
                    out["scriptExists"] = False
                nums.append(out)
            g = dict(f)
            g["numbers"] = nums
            g["drift"] = sum(1 for n in nums if n["live"]["status"] == "drift")
            g["missing"] = sum(1 for n in nums if n["live"]["status"] == "missing")
            findings.append(g)
        th = dict(t)
        th["findings"] = findings
        themes.append(th)
    themes.sort(key=lambda t: (t.get("order") if isinstance(t.get("order"), int) else 999,
                               str(t.get("title") or "")))
    return {"ok": True, "slug": slug, "schema": data.get("schema"),
            "project": data.get("project"), "built": data.get("built"), "lock": data.get("lock"),
            "path": _rel(vault, p), "mtime": _mt(p), "sections": sections, "themes": themes,
            "counts": {"themes": len(themes), "findings": n_find, "numbers": n_num,
                       "traced": n_traced, "drift": n_drift, "missing": n_missing}}
