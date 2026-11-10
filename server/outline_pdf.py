"""The outline as a plain, shareable PDF."""
import settings

import datetime
import os
import re
import shutil
import subprocess
import threading

import drafting

# one build at a time per project — a burst of clicks collapses into one compile
_LOCKS = {}
_LOCKS_GUARD = threading.Lock()


def _lock(key):
    with _LOCKS_GUARD:
        lk = _LOCKS.get(key)
        if lk is None:
            lk = _LOCKS[key] = threading.Lock()
    return lk


# ----------------------------------------------------------------- text -> LaTeX

_TEX_ESC = {
    "\\": r"\textbackslash{}", "{": r"\{", "}": r"\}", "$": r"\$", "&": r"\&",
    "#": r"\#", "^": r"\textasciicircum{}", "_": r"\_", "%": r"\%",
    "~": r"\textasciitilde{}",
}


def _tex(s):
    """Escape arbitrary prose for LaTeX. Backslash goes first (its replacement
    contains braces), so the table is applied in one pass over the characters."""
    return "".join(_TEX_ESC.get(ch, ch) for ch in (s or ""))


def _plain(s):
    """Markdown off. Outline points are typed in markdown (`**Figure 1**`, `[[a note]]`),
    and a shareable sheet shows the words, not the syntax. Runs BEFORE _tex."""
    s = re.sub(r"!?\[\[([^\]|]+?)(?:\|([^\]]*))?\]\]", lambda m: m.group(2) or m.group(1), s or "")
    s = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", s)
    s = s.replace("**", "").replace("`", "")
    s = re.sub(r"(?<![\w*])\*(?![\s*])(.+?)(?<![\s*])\*(?![\w*])", r"\1", s)
    return re.sub(r"[ \t]+", " ", s).strip()


def _para(s):
    """A multi-line plan as one LaTeX paragraph run (blank line -> paragraph break)."""
    return _tex((s or "").strip()).replace("\n\n", r"\par ").replace("\n", " ")


_ITEM = re.compile(r"^(\s*)(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s*)?(.*)$")
_NOTES = re.compile(r"^notes\s*:\s*(.*)$", re.I)
_EV = re.compile(r"^ev(?:idence)?\s*:\s*", re.I)
_FIG = re.compile(r"^fig(?:ure)?\s*:\s*", re.I)


def parse_points(text):
    """(points, prose) for one section body. A point is {text, ev, fig}. `prose` holds
    every line that is not a point — the legacy free-text plan, and any working notes.
    Parsing never bails: unrecognised content survives in `prose` verbatim."""
    points, prose = [], []
    in_notes = False
    for raw in (text or "").split("\n"):
        raw = raw.rstrip("\r")
        if in_notes:
            prose.append(raw)
            continue
        n = _NOTES.match(raw.strip())
        if n:
            in_notes = True
            if n.group(1).strip():
                prose.append(n.group(1))
            continue
        m = _ITEM.match(raw)
        if m and len(m.group(1)) < 2:
            p = {"text": "", "ev": "", "fig": ""}
            parts = m.group(2).split("|")
            p["text"] = (parts.pop(0) if parts else "").strip()
            for seg in parts:
                s = seg.strip()
                if _EV.match(s):
                    p["ev"] = _EV.sub("", s).strip()
                elif _FIG.match(s):
                    p["fig"] = _FIG.sub("", s).strip()
                elif s:
                    p["text"] += " | " + s          # an unlabelled pipe stays in the text
            points.append(p)
            continue
        if raw.strip():
            prose.append(raw)
    return points, "\n".join(prose).strip()


_NAMES_EXHIBIT = re.compile(r"^\s*(figures?|fig\.?|tables?|visuals?|exhibits?|needed|none)\b", re.I)


def fig_label(fig):
    s = _plain(fig).strip()
    if not s:
        return ""
    if _NAMES_EXHIBIT.match(s):
        return s[0].upper() + s[1:]
    m = re.match(r"^(\d+)\s*[,.·:-]?\s*(.*)$", s)
    if not m:
        return "Visual: " + s
    rest = m.group(2).strip()
    return "Figure " + str(int(m.group(1))) + (" - " + rest if rest else "")


def ev_items(ev):
    out = []
    for chunk in (ev or "").split(";"):
        c = chunk.strip().strip(",").strip()
        if c:
            out.append(c)
    return out


_VISUAL = re.compile(r"^(?:visuals?|figures?|fig|tables?)\s*:\s*(.*)$", re.I)
_EXHIBIT = re.compile(
    r"^((?:appendix|supplementary|supplemental|online)\s+)?"
    r"(figures?|fig\.?|tables?|visuals?|exhibits?|panels?)\b([^:]*):\s*(.*)$", re.I)
_HYP = re.compile(r"^\*\*\s*(h(?:ypothesis)?\s*\d+[^*]*?)\s*\*\*\s*(.*)$", re.I)
_LISTY = re.compile(r"\|\s*(?:ev(?:idence)?|fig(?:ure)?)\s*:", re.I)
_BOXED = re.compile(r"^(\s*)(?:[-*+]|\d+[.)])\s+\[[ xX]\]")


def _tag_case(tag):
    """"FIGURE ONE" / "APPENDIX FIGURE 4" as it reads on the page: "Figure One"."""
    return " ".join(w.capitalize() for w in (tag or "").lower().split())


_NUMWORD = {w: i for i, w in enumerate(
    ("zero one two three four five six seven eight nine ten eleven twelve thirteen "
     "fourteen fifteen sixteen seventeen eighteen nineteen twenty").split())}
_APPENDIX = re.compile(r"^\s*(appendix|supplementary|supplemental|online)\b", re.I)


def _first_num(s):
    """The first number in a string, whether spelled ("One") or a digit ("4")."""
    for tok in re.findall(r"[A-Za-z]+|\d+", s or ""):
        if tok.isdigit():
            return int(tok)
        w = tok.lower()
        if w in _NUMWORD:
            return _NUMWORD[w]
    return None


def parse_exhibit(s):
    """A figure/table reference -> {'kind','num','appendix'} or None. 'FIGURE ONE' ->
    figure 1, 'TABLE TWO' -> table 2, 'APPENDIX FIGURE 4' -> figure 4 (appendix), a bare
    '1, caption' (the listy grammar) -> figure 1. None when no number is named."""
    s = _plain(s or "").strip()
    if not s:
        return None
    appendix = bool(_APPENDIX.match(s))
    m = re.search(r"\b(fig(?:ure)?s?|tab(?:le)?s?)\b", s, re.I)
    if m:
        kind = "table" if m.group(1).lower().startswith("tab") else "figure"
        num = _first_num(s[m.end():])
        if num is None:
            num = _first_num(s)
    else:
        kind = "figure"
        num = _first_num(s)
    if num is None:
        return None
    return {"kind": kind, "num": num, "appendix": appendix}


_MS_CAPTION = re.compile(r"^\*\*\s*(figure|table)\s+(\d+)\s*\.?\s*\*\*", re.I)
_MS_EMBED = re.compile(r"^!\[\[([^\]|]+?)\]\]")


def _asset_stem(base):
    base = base.split("/")[-1].strip()
    return re.sub(r"\.(png|svg|jpe?g|gif|webp|pdf|csv|md)$", "", base, flags=re.I)


def manuscript_exhibits(paper_text):
    figs, tabs = {}, {}
    fig_seq = tab_seq = 0
    pending = None
    for raw in (paper_text or "").split("\n"):
        ln = raw.strip()
        cm = _MS_CAPTION.match(ln)
        if cm:
            pending = (cm.group(1).lower(), int(cm.group(2)))
            continue
        em = _MS_EMBED.match(ln)
        if not em:
            continue
        base = em.group(1).split("/")[-1].strip()
        low = base.lower()
        if low.startswith("fig"):
            fig_seq += 1
            num = pending[1] if (pending and pending[0] == "figure") else fig_seq
            figs.setdefault(num, _asset_stem(base))
            pending = None
        elif low.startswith("tab") or low.startswith("table"):
            tab_seq += 1
            num = pending[1] if (pending and pending[0] == "table") else tab_seq
            tabs.setdefault(num, _asset_stem(base))
            pending = None
    return figs, tabs


def section_points(body):
    """One section body -> ([{text, subs:[(kind, text)]}], [{label, text}]).
    `kind` is 'ev' (a citation) or 'fig' (an exhibit); the second list holds the
    section's hypotheses. Parsing never bails; unrecognised prose becomes a point."""
    lines = (body or "").split("\n")
    listy = any(_BOXED.match(ln) or _LISTY.search(ln) for ln in lines)
    if listy:
        rows, _prose = parse_points(body)
        out = []
        for p in rows:
            subs = [{"kind": "ev", "text": e, "ex": None} for e in ev_items(p["ev"])]
            if (p["fig"] or "").strip():
                subs.append({"kind": "fig", "text": fig_label(p["fig"]),
                             "ex": parse_exhibit(p["fig"])})
            out.append({"text": _plain(p["text"]), "subs": subs})
        return out, []

    points, hyps = [], []
    par = []

    def flush_par():
        if not par:
            return
        joined = re.sub(r"\s+", " ", " ".join(par)).strip()
        del par[:]
        if not joined:
            return
        h = _HYP.match(joined)
        if h:
            hyps.append({"label": h.group(1).strip(), "text": _plain(h.group(2))})
            return
        points.append({"text": _plain(joined), "subs": []})

    def attach(kind, txt, ex=None):
        if not points:
            points.append({"text": "", "subs": []})
        points[-1]["subs"].append({"kind": kind, "text": txt, "ex": ex})

    in_notes = False
    for raw in lines:
        raw = raw.rstrip("\r")
        ln = raw.strip()
        if in_notes:
            continue
        if _NOTES.match(ln):
            flush_par()
            in_notes = True
            continue
        if not ln:
            flush_par()
            continue
        m = _ITEM.match(raw)
        if m and len(m.group(1)) < 2:
            flush_par()
            b = m.group(2).strip()
            exm = _EXHIBIT.match(b)
            if exm:
                tag = b[: b.index(":")].strip()
                attach("fig", (_tag_case(tag) + " — " + _plain(exm.group(4))).strip(" —"),
                       parse_exhibit(tag))
            else:
                attach("ev", _plain(b))
            continue
        v = _VISUAL.match(ln)
        if v:
            flush_par()
            attach("fig", fig_label(v.group(1)), parse_exhibit(v.group(1)))
            continue
        par.append(ln)
    flush_par()
    return points, hyps


# ----------------------------------------------------------------- the model

def _byline(paper_text):
    """The subtitle + author line as the manuscript states them (the material above the
    first ## heading): the first italic-only line, and the first bold line."""
    head = re.split(r"^##\s", paper_text or "", maxsplit=1, flags=re.M)[0]
    head = re.sub(r"^---\n.*?\n---\n", "", head, flags=re.S)
    subtitle = authors = ""
    for raw in head.split("\n"):
        ln = raw.strip()
        if not ln or ln.startswith("#") or re.fullmatch(r"-{3,}", ln):
            continue
        if not subtitle:
            m = re.fullmatch(r"\*([^*].*?)\*", ln)
            if m:
                subtitle = m.group(1).strip()
                continue
        if not authors:
            m = re.match(r"^\*\*(.+?)\*\*\s*(.*)$", ln)
            if m:
                authors = (m.group(1) + " " + m.group(2)).strip()
    return subtitle, authors


def build_model(vault, slug, doc=drafting.DEFAULT_DOC):
    paths = drafting._writing_paths(vault, slug, doc)
    if not paths:
        return None, "no such project"
    paper_p, _ = paths
    if not paper_p.exists():
        return None, "no manuscript yet"
    paper_text = paper_p.read_text(encoding="utf-8", errors="replace")
    title = drafting._paper_title(paper_text, slug)

    out = drafting.read_outline(vault, slug, doc)
    if out.get("error"):
        return None, out["error"]
    parsed = drafting.parse_outline(out["outline"]["text"])

    live = set()
    for kind, val in drafting.parse_paper(paper_text):
        if kind in ("h2", "h3"):
            live.add(drafting._canon(val))

    sections = []
    n = 0
    for s in parsed["sections"]:
        points, hyps = section_points(s.get("plan", ""))
        sections.append({
            "level": 3 if s.get("level") == 3 else 2,
            "heading": _plain(s["heading"]),
            "points": points,
            "hyps": hyps,
            "planned": drafting._canon(s["heading"]) not in live,
            "start": n + 1,
        })
        n += len(points)

    figs_map, tabs_map = manuscript_exhibits(paper_text)
    for s in sections:
        for p in s["points"]:
            for sub in p["subs"]:
                ex = sub.get("ex")
                if sub.get("kind") != "fig" or not ex or ex.get("appendix"):
                    continue
                stem = (tabs_map if ex["kind"] == "table" else figs_map).get(ex["num"])
                if not stem:
                    continue
                sub["stem"] = stem
                sub["exkind"] = ex["kind"]
                if ex["kind"] == "figure":
                    src = drafting._find_asset(vault, slug, stem + ".png")
                    if src:
                        sub["src"] = str(src)

    head = [{"heading": _plain(x["heading"]), "body": x["body"]}
            for x in parsed.get("extras", []) if (x.get("body") or "").strip()]
    if (parsed["thesis"] or "").strip():
        head.append({"heading": "Thesis", "body": parsed["thesis"]})

    subtitle, authors = _byline(paper_text)
    return {
        "slug": slug, "doc": doc, "title": title,
        "subtitle": subtitle, "authors": authors,
        "head": head, "thesis": parsed["thesis"], "journal": parsed.get("targetJournal", ""),
        "sections": sections, "points": n,
        "outlineRel": out["outline"]["rel"],
    }, None


# ----------------------------------------------------------------- LaTeX
# One typeface, black text, page numbers. A document anyone can open, read, and print.

_PREAMBLE = r"""\documentclass[11pt]{article}
\usepackage[T1]{fontenc}
\usepackage[utf8]{inputenc}
\usepackage[letterpaper,left=1in,right=1in,top=1in,bottom=1in]{geometry}
\usepackage{XCharter}
\usepackage{microtype}
\usepackage{enumitem}
\usepackage{needspace}
\usepackage{ragged2e}
\usepackage{graphicx}

\setlength{\parindent}{0pt}
\setlength{\parskip}{0pt}
\linespread{1.06}
\pagestyle{plain}

% the points: numbered straight through the paper, so "figure 1 makes point 3" means the
% same thing wherever it is read
\newlist{points}{enumerate}{1}
\setlist[points]{label=\arabic*., leftmargin=2em, labelsep=0.55em,
                 topsep=3pt, itemsep=3.5pt, parsep=0pt}
% the evidence and the figure sit under the point they belong to
\newlist{subs}{itemize}{1}
\setlist[subs]{label=\textendash, leftmargin=1.25em, labelsep=0.45em,
               topsep=2pt, itemsep=1pt, parsep=0pt}
% a hypothesis is a statement, not a point: unnumbered, bold-labelled, aligned with the
% points it follows
\newlist{hyps}{itemize}{1}
\setlist[hyps]{label={}, leftmargin=2em, labelsep=0em,
               topsep=5pt, itemsep=5pt, parsep=0pt}
"""


def to_latex(m):
    L = [_PREAMBLE, r"\begin{document}\RaggedRight"]

    # ---- the head: what this is, and the one sentence it argues
    L.append(r"{\bfseries\fontsize{17}{21}\selectfont " + _tex(m["title"]) + r"}\par")
    if (m.get("subtitle") or "").strip():
        L.append(r"\vspace{2pt}{\itshape\fontsize{11.5}{15}\selectfont " + _tex(m["subtitle"]) + r"}\par")
    if (m.get("authors") or "").strip():
        L.append(r"\vspace{3pt}{\fontsize{10.5}{14}\selectfont " + _tex(m["authors"]) + r"}\par")
    meta = ["Outline"]
    if (m["journal"] or "").strip():
        meta.append(_tex(_plain(m["journal"]).strip()))
    meta.append(datetime.date.today().strftime("%d %B %Y"))
    L.append(r"\vspace{3pt}{\fontsize{9.5}{12}\selectfont " + r" \textperiodcentered\ ".join(meta) + r"}\par")

    # the spine: one labelled sentence each, so a co-author knows what the paper claims
    # before reading a single point
    for h in m.get("head", []):
        L.append(r"\vspace{8pt}{\fontsize{10.5}{14.5}\selectfont{\bfseries " + _tex(h["heading"]) +
                 r".}\ " + _para(_plain(h["body"])) + r"}\par")
    L.append(r"\vspace{6pt}")

    if not m["sections"]:
        L.append(r"\vspace{8pt}{\itshape No sections in the outline yet.}\par")
        L.append(r"\end{document}")
        return "\n".join(L) + "\n"

    # ---- the sections: a heading, then its points
    for s in m["sections"]:
        size = r"\fontsize{12.5}{16}" if s["level"] == 2 else r"\fontsize{11}{14}"
        indent = r"\hspace*{1.1em}" if s["level"] == 3 else ""
        head = indent + r"{\bfseries" + size + r"\selectfont " + _tex(s["heading"]) + r"}"
        if s["planned"]:
            head += r"{\fontsize{9}{12}\selectfont\itshape\ \ (planned, not in the draft yet)}"
        # a heading never ends a page alone — it goes over with its first point or two
        L.append(r"\needspace{4\baselineskip}\vspace{11pt}" + head + r"\par\vspace{1pt}")

        if not s["points"] and not s.get("hyps"):
            continue

        has_img = any(x.get("file") for p in s["points"] for x in p.get("subs", []))
        use_mp = not has_img
        if use_mp:
            L.append(indent + r"\begin{minipage}{\dimexpr\linewidth-"
                     + ("1.1em" if s["level"] == 3 else "0pt") + r"\relax}")
        if s["points"]:
            L.append(r"\begin{points}")
            L.append(r"\setcounter{pointsi}{" + str(s["start"] - 1) + r"}")
            for p in s["points"]:
                L.append(r"\item " + (_tex(p["text"]) or r"\mbox{}"))
                subs = p.get("subs", [])
                imgs = [x for x in subs if x.get("kind") == "fig" and x.get("file")]
                textsubs = [x for x in subs if not (x.get("kind") == "fig" and x.get("file"))]
                if textsubs:
                    L.append(r"\begin{subs}\fontsize{10}{13.5}\selectfont")
                    for x in textsubs:
                        txt = x.get("text", "")
                        L.append(r"\item " + (_tex(txt) if x.get("kind") == "ev"
                                              else r"{\itshape " + _tex(txt) + r"}"))
                    L.append(r"\end{subs}")
                for x in imgs:
                    cap = (x.get("text") or "").strip()
                    L.append(r"\par\vspace{4pt}\needspace{4\baselineskip}%")
                    if cap:
                        L.append(r"{\itshape\fontsize{9.5}{12.5}\selectfont " + _tex(cap) + r"\par}\vspace{2pt}")
                    L.append(r"{\centering\includegraphics[width=0.9\linewidth,"
                             r"height=3.3in,keepaspectratio]{" + x["file"] + r"}\par}\vspace{3pt}")
            L.append(r"\end{points}")
        # the section's hypotheses: each a bold-labelled statement in its own block, so
        # H1..Hn read at a glance under the sentence that introduced them
        if s.get("hyps"):
            L.append(r"\begin{hyps}\fontsize{10.5}{14}\selectfont")
            for h in s["hyps"]:
                L.append(r"\item {\bfseries " + _tex(h["label"]) + r"}\ " + _tex(h["text"]))
            L.append(r"\end{hyps}")
        L.append(r"\end{minipage}\par" if use_mp else r"\par")

    L.append(r"\end{document}")
    return "\n".join(L) + "\n"


# ----------------------------------------------------------------- compile

def _outline_pdf_path(vault, slug, doc):
    paths = drafting._writing_paths(vault, slug, doc)
    if not paths:
        return None
    base = paths[0].name[:-3]
    return paths[0].parent / (base + ".outline.pdf")


def pdf_path(vault, slug, doc=drafting.DEFAULT_DOC):
    """The already-built PDF, if there is one — so a second look (the browser opening the
    copy that was just downloaded) serves the file instead of recompiling it."""
    p = _outline_pdf_path(vault, slug, doc)
    return p if p and p.exists() else None


def _stage_exhibits(vault, slug, model, wdir):
    staged = {}          # cache key -> safe filename, so a repeated exhibit copies once
    counter = [0]

    def place(key, writer):
        if key in staged:
            return staged[key]
        name = "exhibit_%02d.png" % (counter[0] + 1)
        try:
            writer(wdir / name)
        except Exception:
            return None
        counter[0] += 1
        staged[key] = name
        return name

    for s in model["sections"]:
        for p in s.get("points", []):
            for sub in p.get("subs", []):
                if sub.get("kind") != "fig":
                    continue
                if sub.get("exkind") == "figure" and sub.get("src"):
                    src = sub["src"]
                    fn = place("F:" + src, lambda dst, src=src: shutil.copyfile(src, dst))
                    if fn:
                        sub["file"] = fn
                elif sub.get("exkind") == "table" and sub.get("stem"):
                    stem = sub["stem"]

                    def _wr(dst, stem=stem):
                        r = drafting.table_png(vault, slug, stem + ".pdf")
                        if not r:
                            raise RuntimeError("table did not rasterize")
                        dst.write_bytes(r[0])

                    fn = place("T:" + stem, _wr)
                    if fn:
                        sub["file"] = fn
    return counter[0]


def build(vault, slug, doc=drafting.DEFAULT_DOC, timeout=180):
    """Typeset the outline. Returns (path, None) or (None, error). The .tex and the
    pdflatex log stay in writing/build/outline/ so a failure is diagnosable."""
    m, err = build_model(vault, slug, doc)
    if err:
        return None, err
    out_pdf = _outline_pdf_path(vault, slug, doc)
    if not out_pdf:
        return None, "no such project"
    wdir = out_pdf.parent / "build" / "outline"
    with _lock(str(out_pdf)):
        try:
            wdir.mkdir(parents=True, exist_ok=True)
        except OSError as e:
            return None, "could not create the build directory ({})".format(e)
        # stage the referenced figures/tables into the build dir, then typeset — the .tex
        # references them by their safe local names
        _stage_exhibits(vault, slug, m, wdir)
        tex = wdir / "outline.tex"
        try:
            tex.write_text(to_latex(m), encoding="utf-8")
        except OSError as e:
            return None, "could not write the outline .tex ({})".format(e)

        try:
            pdflatex = drafting._native_tool("pdflatex")
            if not pdflatex:
                return None, "pdflatex is not installed"
            for _i in range(2):
                drafting._native_run([pdflatex, "-no-shell-escape", "-interaction=nonstopmode", "-halt-on-error", "outline.tex"], wdir, timeout)
            r = subprocess.CompletedProcess([], 0 if (wdir / "outline.pdf").exists() else 1, stdout="", stderr="")
        except subprocess.TimeoutExpired:
            return None, "the outline compile timed out"
        except (FileNotFoundError, OSError) as e:
            return None, "could not run pdflatex ({})".format(e)
        built = wdir / "outline.pdf"
        if r.returncode != 0 or not built.exists():
            log = wdir / "outline.log"
            hint = ""
            if log.exists():
                errs = [ln for ln in log.read_text(encoding="utf-8", errors="replace").splitlines()
                        if ln.startswith("!")]
                if errs:
                    hint = " - " + errs[0][:160]
            return None, "the outline did not compile" + hint
        try:
            shutil.copyfile(built, out_pdf)
        except OSError as e:
            return None, "could not save the outline PDF ({})".format(e)
    return out_pdf, None


def download_name(vault, slug, doc=drafting.DEFAULT_DOC):
    """A filename a co-author can read in their downloads folder."""
    paths = drafting._writing_paths(vault, slug, doc)
    title = slug
    if paths and paths[0].exists():
        title = drafting._paper_title(paths[0].read_text(encoding="utf-8", errors="replace"), slug)
    safe = re.sub(r"[^A-Za-z0-9]+", "-", title).strip("-")[:60] or slug
    return safe + "-outline.pdf"


if __name__ == "__main__":
    import sys
    from pathlib import Path
    # same walk serve.py does: server -> .apps -> Projects -> vault
    VAULT = settings.VAULT
    if len(sys.argv) < 2:
        print("usage: outline_pdf.py <slug> [doc.md]")
        raise SystemExit(2)
    p, e = build(VAULT, sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else drafting.DEFAULT_DOC)
    print(e or p)
    raise SystemExit(0 if p else 1)
