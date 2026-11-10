#!/usr/bin/env python3
"""Queryable audit index for the Drafting view.

Commands: path | rebuild | refresh <slug> | query "<SELECT ...>" | summary | issues | unsupported
"""
import settings
import re
import sqlite3
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import drafting

# ------------------------------------------------------------------ DB location
def db_path():
    return settings.STATE_DIR / "drafting-audit.sqlite"


def _default_vault():
    return settings.VAULT


_SCHEMA = """
CREATE TABLE IF NOT EXISTS projects (
  slug          TEXT PRIMARY KEY,
  kind          TEXT,      -- 'paper' | 'brief'
  docs          TEXT,      -- comma-joined manuscript filenames scanned
  n_embeds      INTEGER,
  n_broken      INTEGER,   -- embeds that don't resolve to a real asset
  n_ungrounded  INTEGER,   -- embeds with none/stale/unverified provenance
  refreshed     INTEGER    -- epoch ms of last refresh
);
CREATE TABLE IF NOT EXISTS embeds (
  slug        TEXT,
  doc         TEXT,
  line        INTEGER,
  name        TEXT,        -- basename as written: fig.01.example.png
  stem        TEXT,        -- fig.01.example
  kind        TEXT,        -- figure | table
  resolved    INTEGER,     -- 1/0: points at a real results/ asset
  exempt      INTEGER,     -- 1/0: <!-- provenance: pending --> escape hatch
  provenance  TEXT,        -- fresh | stale | stale-inputs | none | external | external-unverified
  suggestion  TEXT,        -- nearest real stem when unresolved
  file_num    TEXT,        -- '06'  (from the fig/tab file stem)
  script      TEXT,        -- replication/22.fig.centrality.py
  script_num  TEXT,        -- '22'  (from the producing script)
  display_num TEXT,        -- '3'   (from the *Figure 3.* caption in the text)
  caption     TEXT,        -- the human caption/notes line, asterisks stripped
  num_ok      INTEGER,     -- 1 if file_num == display_num (renders where the text says)
  refreshed   INTEGER,
  PRIMARY KEY (slug, doc, line, name)
);
CREATE TABLE IF NOT EXISTS assets (
  slug         TEXT,
  stem         TEXT,
  kind         TEXT,
  script       TEXT,
  verified     INTEGER,
  generated_by TEXT,
  status       TEXT,       -- grounding verdict
  fresh        INTEGER,    -- 1 if every recorded output hash still matches disk
  caption      TEXT,
  refreshed    INTEGER,
  PRIMARY KEY (slug, stem)
);
CREATE INDEX IF NOT EXISTS ix_embeds_slug ON embeds(slug);
CREATE INDEX IF NOT EXISTS ix_embeds_broken ON embeds(resolved);
CREATE INDEX IF NOT EXISTS ix_assets_slug ON assets(slug);
"""

_SIDECAR_SKIP = {"editor.md", "outline.md", "references.md", "review.md",
                 "README.md", "PLAN.md", "numbers.md",
                 "notes.md"}   # the paper's scratch page, never audited
_CAP_RE = re.compile(r"^\s*[*_]{1,2}\s*(figure|table)\s+(\d+)[.:]?\s*(.*?)\s*[*_]{1,2}\s*$", re.I)
_FILENUM_RE = re.compile(r"^(?:fig|figs|tab)\.?(\d+)", re.I)


def connect(path=None):
    path = Path(path) if path else db_path()
    con = sqlite3.connect(str(path), timeout=10)
    con.execute("PRAGMA busy_timeout=8000")
    con.execute("PRAGMA journal_mode=DELETE")
    con.executescript(_SCHEMA)
    return con


def _manuscripts(proj):
    wdir = proj / "writing"
    if not wdir.is_dir():
        return []
    out = []
    for p in sorted(wdir.glob("*.md")):
        if p.name in _SIDECAR_SKIP or p.name.startswith("."):
            continue
        if p.name.endswith(".draft.md"):
            continue
        if "sync-conflict-" in p.name:
            continue
        out.append(p.name)
    return out


_INTENDED_ASSET_RE = re.compile(r"^(fig|tab)S?[._-]?\d", re.I)
_ASSET_EXTS = (".png", ".svg", ".jpg", ".jpeg", ".csv")


def unsupported_assets(vault=None):
    vault = Path(vault) if vault else _default_vault()
    out = []
    for slug, _kind in _all_projects(vault):
        proj = drafting._project_dir(vault, slug)
        if not proj:
            continue
        for sub in ("results", "results/supplementary"):
            d = proj / sub
            if not d.is_dir():
                continue
            for f in sorted(d.iterdir()):
                if not f.is_file() or f.name.startswith(".") or "sync-conflict-" in f.name:
                    continue
                if f.suffix.lower() not in _ASSET_EXTS:
                    continue
                if not _INTENDED_ASSET_RE.match(f.stem):
                    continue
                if drafting._RESULT_STEM_RE.match(f.stem):
                    continue
                out.append((slug, sub, f.name, "asset name invisible to _RESULT_STEM_RE"))
        for doc in _manuscripts(proj):
            p = proj / "writing" / doc
            try:
                text = p.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            for m in re.finditer(r"!\[\[([^\]|#]+)", text):
                base = m.group(1).strip().split("/")[-1]
                stem = base.rsplit(".", 1)[0]
                if not _INTENDED_ASSET_RE.match(stem) or drafting._RESULT_STEM_RE.match(stem):
                    continue
                line = text.count("\n", 0, m.start()) + 1
                out.append((slug, "%s:%d" % (doc, line), base,
                            "EMBEDDED but invisible to the embed walk"))
    return out


def _script_num(script):
    if not script:
        return None
    base = script.split("/")[-1]
    m = re.match(r"(\d+)", base)
    if m:
        return m.group(1)
    m = re.match(r"(?:fig|tab)\.?(S?\d+)", base, re.I)
    return m.group(1) if m else None


def _caption_for(lines, line_1based):
    """The *Figure N.* / *Table N.* caption nearest an embed line -> (num, text).
    Figures caption below, tables title above, so scan a small window either side."""
    idx = line_1based - 1
    for off in (1, 2, 3, -1, -2):
        j = idx + off
        if 0 <= j < len(lines):
            m = _CAP_RE.match(lines[j])
            if m:
                return m.group(2), (m.group(1).title() + " " + m.group(2) + ". " + m.group(3)).strip()
    return None, None


def project_rows(vault, slug, kind, status=None):
    """(project_row, embed_rows, asset_rows) for one slug, or None if it has no
    manuscript. status may be a pre-computed drafting.provenance_status result."""
    proj = drafting._project_dir(vault, slug)
    if not proj:
        return None
    docs = _manuscripts(proj)
    if not docs:
        return None
    if status is None:
        status = drafting.provenance_status(vault, slug, docs=tuple(docs))
    if status.get("error"):
        return None
    now = int(time.time() * 1000)

    # cache manuscript text per doc for caption lookup
    doc_lines = {}
    for d in docs:
        p = proj / "writing" / d
        try:
            doc_lines[d] = p.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            doc_lines[d] = []

    entries = status.get("entries", {})
    embed_rows, n_broken, n_ungrounded = [], 0, 0
    for e in status.get("embeds", []):
        entry = entries.get(e["stem"], {})
        script = entry.get("script")
        fm = _FILENUM_RE.match(e["stem"])
        file_num = fm.group(1) if fm else None
        disp_num, caption = _caption_for(doc_lines.get(e["doc"], []), e["line"])
        if not caption:
            caption = entry.get("caption")
        broken = (not e["resolved"]) and (not e["exempt"])
        ungrounded = (e["provenance"] in ("none", "stale", "stale-inputs", "external-unverified")) and (not e["exempt"])
        if broken:
            n_broken += 1
        if ungrounded:
            n_ungrounded += 1
        num_ok = 1 if (file_num and disp_num and file_num.lstrip("0") == disp_num.lstrip("0")) else 0
        embed_rows.append((
            slug, e["doc"], e["line"], e["name"], e["stem"], e["kind"],
            1 if e["resolved"] else 0, 1 if e["exempt"] else 0, e["provenance"],
            e.get("suggestion"), file_num, script, _script_num(script),
            disp_num, caption, num_ok, now,
        ))

    asset_rows = []
    for stem, entry in entries.items():
        fr = entry.get("freshness") or {}
        fresh = 1 if (fr and all(v == "fresh" for v in fr.values())) else 0
        asset_rows.append((
            slug, stem, entry.get("kind"), entry.get("script"),
            1 if entry.get("verified") else 0, entry.get("generatedBy"),
            entry.get("status"), fresh, entry.get("caption"), now,
        ))

    proj_row = (slug, kind, ",".join(docs), len(status.get("embeds", [])),
                n_broken, n_ungrounded, now)
    return proj_row, embed_rows, asset_rows


def _all_projects(vault):
    """[(slug, kind)] for every paper + brief with a project dir."""
    out = []
    papers = vault / "Projects" / "papers"
    if papers.is_dir():
        for d in sorted(papers.iterdir()):
            if d.is_dir() and settings.live_slug(d.name):
                out.append((settings.live_slug(d.name), "paper"))
    briefs = vault / "Projects" / "briefs"
    if briefs.is_dir():
        for d in sorted(briefs.iterdir()):
            if d.is_dir():
                out.append((d.name, "brief"))
    return out


def _write_project(con, rows):
    proj_row, embed_rows, asset_rows = rows
    slug = proj_row[0]
    con.execute("DELETE FROM embeds WHERE slug=?", (slug,))
    con.execute("DELETE FROM assets WHERE slug=?", (slug,))
    con.execute("DELETE FROM projects WHERE slug=?", (slug,))
    con.execute("INSERT INTO projects "
                "(slug, kind, docs, n_embeds, n_broken, n_ungrounded, refreshed) "
                "VALUES (?,?,?,?,?,?,?)", proj_row)
    con.executemany("INSERT INTO embeds VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", embed_rows)
    con.executemany("INSERT INTO assets VALUES (?,?,?,?,?,?,?,?,?,?)", asset_rows)


_LAST_REFRESH = {}   # slug -> epoch ms, in-process throttle for the save hook


def refresh_project(vault, slug, status=None, kind=None, path=None, min_interval_ms=0):
    """Upsert one project's rows. Cheap; safe to call from serve.py on every
    provenance read / manuscript save. Never raises to the caller."""
    try:
        if min_interval_ms and status is None:
            last = _LAST_REFRESH.get(slug, 0)
            if (int(time.time() * 1000) - last) < min_interval_ms:
                return False
        _LAST_REFRESH[slug] = int(time.time() * 1000)
        if kind is None:
            proj = drafting._project_dir(vault, slug)
            kind = "brief" if proj and "briefs" in str(proj).replace("\\", "/").split("/") else "paper"
        rows = project_rows(vault, slug, kind, status=status)
        if not rows:
            return False
        con = connect(path)
        try:
            with con:
                _write_project(con, rows)
        finally:
            con.close()
        return True
    except Exception:
        return False


def rebuild(vault=None, path=None):
    """Full rebuild of every project, in-place transactional (readers see old or
    new, never partial). Returns (n_projects, n_broken, n_ungrounded)."""
    vault = Path(vault) if vault else _default_vault()
    con = connect(path)
    n_proj = n_broken = n_ungrounded = 0
    try:
        with con:
            con.execute("DELETE FROM embeds")
            con.execute("DELETE FROM assets")
            con.execute("DELETE FROM projects")
            for slug, kind in _all_projects(vault):
                rows = project_rows(vault, slug, kind)
                if not rows:
                    continue
                _write_project(con, rows)
                n_proj += 1
                n_broken += rows[0][4]
                n_ungrounded += rows[0][5]
    finally:
        con.close()
    return n_proj, n_broken, n_ungrounded


# ------------------------------------------------------------------- read-only query
def _is_readonly(sql):
    s = sql.strip().lstrip("(").lstrip().lower()
    return s.startswith("select") or s.startswith("with")


QUERY_DEADLINE_SEC = 3.0


def query(sql, path=None, as_dicts=False, deadline_sec=None):
    if not _is_readonly(sql):
        raise ValueError("read-only: only SELECT / WITH queries are allowed")
    path = Path(path) if path else db_path()
    if not path.exists():
        connect(path).close()          # first use: create the file and schema, as before
    limit = QUERY_DEADLINE_SEC if deadline_sec is None else deadline_sec
    con = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=limit)
    end = time.monotonic() + limit
    con.set_progress_handler(lambda: time.monotonic() > end, 10000)
    try:
        con.row_factory = sqlite3.Row
        try:
            cur = con.execute(sql)
            rows = cur.fetchall()
        except sqlite3.OperationalError as exc:
            if "interrupted" in str(exc):
                raise ValueError("query stopped: it ran longer than %g s" % limit)
            raise
        cols = [d[0] for d in cur.description] if cur.description else []
        if as_dicts:
            return [dict(r) for r in rows]
        return cols, [tuple(r) for r in rows]
    finally:
        con.close()


def _print_table(cols, rows):
    if not cols:
        print("(no columns)")
        return
    widths = [len(c) for c in cols]
    srows = []
    for r in rows:
        cells = ["" if v is None else str(v) for v in r]
        srows.append(cells)
        for i, c in enumerate(cells):
            widths[i] = max(widths[i], len(c))
    line = "  ".join(c.ljust(widths[i]) for i, c in enumerate(cols))
    print(line)
    print("  ".join("-" * widths[i] for i in range(len(cols))))
    for cells in srows:
        print("  ".join(c.ljust(widths[i]) for i, c in enumerate(cells)))
    print(f"\n({len(rows)} row{'' if len(rows) == 1 else 's'})")


# --------------------------------------------------------------------------- CLI
def _main(argv):
    if not argv:
        print(__doc__)
        return 0
    cmd = argv[0]
    if cmd == "path":
        print(db_path())
        return 0
    if cmd == "rebuild":
        t0 = time.time()
        n, b, u = rebuild()
        print(f"rebuilt {n} projects in {time.time()-t0:.1f}s  ->  {b} broken, {u} ungrounded embeds")
        print(f"db: {db_path()}")
        return 0
    if cmd == "refresh":
        if len(argv) < 2:
            print("usage: refresh <slug>"); return 2
        ok = refresh_project(_default_vault(), argv[1])
        print("refreshed" if ok else "no manuscript / skipped", argv[1])
        return 0
    if cmd == "query":
        if len(argv) < 2:
            print("usage: query \"<SELECT ...>\""); return 2
        cols, rows = query(argv[1])
        _print_table(cols, rows)
        return 0
    if cmd == "summary":
        cols, rows = query(
            "SELECT slug, kind, n_embeds, n_broken, n_ungrounded, "
            "datetime(refreshed/1000,'unixepoch','localtime') AS refreshed "
            "FROM projects ORDER BY (n_broken+n_ungrounded) DESC, slug")
        _print_table(cols, rows)
        return 0
    if cmd == "issues":
        cols, rows = query(
            "SELECT slug, doc, line, name, "
            "CASE WHEN resolved=0 THEN 'BROKEN' ELSE upper(provenance) END AS issue, "
            "suggestion FROM embeds "
            "WHERE (resolved=0 OR provenance IN "
            "('none','stale','stale-inputs','external-unverified')) AND exempt=0 "
            "ORDER BY slug, doc, line")
        _print_table(cols, rows)
        unsup = unsupported_assets()
        if unsup:
            print("\nUNSUPPORTED ASSET NAMES — invisible to the provenance machine "
                  "(no asset row, no embed row, no verdict is possible):")
            _print_table(("slug", "where", "name", "reason"), unsup)
        return 0
    if cmd == "unsupported":
        unsup = unsupported_assets()
        _print_table(("slug", "where", "name", "reason"), unsup)
        return 0 if not unsup else 3
    print(f"unknown command: {cmd}\n{__doc__}")
    return 2


if __name__ == "__main__":
    raise SystemExit(_main(sys.argv[1:]))
