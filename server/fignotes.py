"""fignotes.py — a figure's notes, read from the header of the script that makes it."""
import ast
import json
import re
from pathlib import Path

SCRIPT_EXTS = (".py", ".R", ".r")
# the field labels that mark a notes header
KNOWN_FIELDS = {"shows", "caption", "data", "inputs", "sample", "construction",
                "caveats", "cautions", "story", "panels", "checkable", "not shown"}
_FIELD_RE = re.compile(r"^([A-Z][A-Za-z]*(?: [A-Za-z]+){0,2}):(?:\s+(.*))?$")
# a Caption field is the printed caption only when it carries its label
# ("Figure 3. ..."); otherwise it is guidance on what the caption should say.
_CAPTION_RE = re.compile(r"^(?:Figure|Fig\.|Table)\s*S?\d+", re.I)
_PREFIX_RE = re.compile(r"^(fig|figS|tab)\.?\d+\.?", re.I)
_LEGACY_RE = re.compile(r"^\d+\.(fig|tab)\.(.+)$", re.I)
_CACHE = {}   # (path, mtime_ns) -> parsed header or None
LEGACY_NOTES = "0.figure_notes.md"


def _confined(proj, rel):
    """proj/rel when it is a file inside proj, else None."""
    if not rel or ".." in str(rel).replace("\\", "/").split("/"):
        return None
    try:
        p = (proj / rel).resolve()
        p.relative_to(proj.resolve())
    except (ValueError, OSError):
        return None
    return p if p.is_file() else None


def _manifest_script(proj, stem):
    try:
        data = json.loads((proj / "results" / "provenance.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    entry = data.get(stem) if isinstance(data, dict) else None
    script = entry.get("script") if isinstance(entry, dict) else None
    if not isinstance(script, str) or not script.endswith(SCRIPT_EXTS):
        return None
    return _confined(proj, script)


def _norm_slug(s):
    return re.sub(r"[._-]+", ".", s).strip(".").lower()


def candidates(proj, stem):
    """Scripts that may hold stem's notes, in lookup order, deduplicated."""
    proj = Path(proj)
    out = []
    p = _manifest_script(proj, stem)
    if p:
        out.append(p)
    rep = proj / "replication"
    for ext in SCRIPT_EXTS:
        q = rep / (stem + ext)
        if q.is_file():
            out.append(q)
    suffix = _norm_slug(_PREFIX_RE.sub("", stem, count=1))
    kind = "tab" if stem.lower().startswith("tab") else "fig"
    if suffix and rep.is_dir():
        try:
            names = sorted(f.name for f in rep.iterdir() if f.is_file())
        except OSError:
            names = []
        for name in names:
            base, dot, ext = name.rpartition(".")
            if not dot or ("." + ext) not in SCRIPT_EXTS:
                continue
            m = _LEGACY_RE.match(base)
            if m and m.group(1).lower() == kind and _norm_slug(m.group(2)) == suffix:
                out.append(rep / name)
    seen, uniq = set(), []
    for q in out:
        k = str(q.resolve()) if q.exists() else str(q)
        if k not in seen:
            seen.add(k)
            uniq.append(q)
    return uniq


def _header_text(path):
    """The module docstring (.py) or the leading comment block, or None."""
    try:
        src = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    if path.suffix == ".py":
        try:
            doc = ast.get_docstring(ast.parse(src))
        except (SyntaxError, ValueError):
            doc = None
        if doc and doc.strip():
            return doc.strip()
    lines, started = [], False
    for ln in src.splitlines():
        s = ln.strip()
        if not started and (not s or s.startswith("#!") or (s.startswith("#") and "-*-" in s)):
            continue
        if s.startswith("#"):
            started = True
            lines.append(re.sub(r"^#+'?\s?", "", s))
        elif started and not s:
            lines.append("")
        else:
            break
    text = "\n".join(lines).strip()
    return text or None


def parse_header(text):
    """{summary, fields:[[label, text]], text}: the first line, the labelled
    fields (continuation lines folded in), and the raw header."""
    lines = text.splitlines()
    summary = lines[0].strip() if lines else ""
    fields, cur = [], None
    for ln in lines[1:]:
        m = _FIELD_RE.match(ln) if ln[:1] not in (" ", "\t") else None
        if m:
            cur = [m.group(1), (m.group(2) or "").strip()]
            fields.append(cur)
        elif cur is not None and ln.strip():
            cur[1] = (cur[1] + " " + ln.strip()).strip()
        elif not ln.strip():
            cur = None   # a blank line closes the field
    return {"summary": summary, "fields": fields, "text": text}


def _qualifies(h, stem, path, strict):
    if strict and path.name.rsplit(".", 1)[0] != stem:
        return False
    first = h["summary"]
    if first == stem or re.match(re.escape(stem) + r"(\s|$|[:,.-]|—)", first):
        return True
    return sum(1 for k, _ in h["fields"] if k.lower() in KNOWN_FIELDS) >= 2


def _legacy_mentions(proj, stem):
    p = proj / "results" / LEGACY_NOTES
    try:
        return stem in p.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return False


def _parsed(path):
    try:
        key = (str(path), path.stat().st_mtime_ns)
    except OSError:
        return None
    if key not in _CACHE:
        text = _header_text(path)
        _CACHE[key] = parse_header(text) if text else None
        if len(_CACHE) > 2000:
            _CACHE.clear()
            _CACHE[key] = parse_header(text) if text else None
    return _CACHE[key]


def field(h, *labels):
    """First field whose label is one of labels (case-insensitive), else None."""
    want = {l.lower() for l in labels}
    for k, v in h["fields"]:
        if k.lower() in want and v:
            return v
    return None


def _caption(h):
    for k, v in h["fields"]:
        if k.lower() == "caption" and v and _CAPTION_RE.match(v):
            return re.sub(r"\s+", " ", v).strip()
    return None


def _takeaway(summary, stem):
    """the text after '<stem> --' on the first line, or None."""
    m = re.match(re.escape(stem) + r"\s*(?:--|—|–|:)\s*(.+)$", summary)
    return m.group(1).strip() if m else None


def notes(proj, stem):
    try:
        proj = Path(proj)
        strict = None
        for path in candidates(proj, stem):
            h = _parsed(path)
            if not h:
                continue
            if strict is None:
                strict = _legacy_mentions(proj, stem)
            if not _qualifies(h, stem, path, strict):
                continue
            try:
                rel = path.resolve().relative_to(proj.resolve()).as_posix()
            except ValueError:
                rel = path.name
            summary = _takeaway(h["summary"], stem)
            paras = ([summary] if summary else []) + ["%s: %s" % (k, v) for k, v in h["fields"] if v]
            return {"source": "header", "script": rel, "path": path,
                    "anchor": h["summary"] or None, "summary": summary,
                    "fields": [list(f) for f in h["fields"]], "caption": _caption(h),
                    "paragraphs": paras, "text": h["text"]}
    except Exception:
        return None
    return None
