"""groundcheck.py — shared verbatim-quote / page / source-line verification."""

import re

_YEAR = r"(?:19|20)\d{2}"
_QUOTE_BLOCK = re.compile(r"^>\s?(.*)$")
_PAGE_EXPL = re.compile(r"\(\s*pp?\.?\s*(\d+(?:\s*[-–]\s*\d+)?)\s*\)")
_PAGE_TAIL = re.compile(r"\(\s*(\d+(?:\s*[-–]\s*\d+)?)\s*\)\s*$")
_YEAR_ONLY = re.compile(r"^(19|20)\d{2}$")


def _page_marker(s):
    """(page_str, match) for the page a line/quote records, year-aware."""
    m = _PAGE_EXPL.search(s or "")
    if m:
        return m.group(1), m
    m = _PAGE_TAIL.search(s or "")
    if m and not _YEAR_ONLY.match(re.split(r"[-–]", m.group(1))[0].strip()):
        return m.group(1), m
    return None, None
_LINK = re.compile(r"\[\[([^\]]+)\]\]")
REFS_HEADING_RE = re.compile(r"^#{1,3}\s*References\s*$", re.MULTILINE | re.IGNORECASE)
_PROSE_QUOTE_RE = re.compile(
    r"“([^\"“”]{20,600}?)”"
    r"|(?:^|(?<=[\s(\[{—–-]))\"(?=\S)([^\"“”]{20,600}?)(?<=\S)\"(?=[\s)\]}.,;:!?—–-]|$)",
    re.MULTILINE)
# the page part of a cite: ASA "(Author 2020:44)" / "(2020:44-45)", and the
# APA-style variants "(2020, p. 44)" / "(2020: pp. 44-45)"
_CITE_PAGE_RE = re.compile(
    _YEAR + r"[a-z]?\s*(?::\s*(?:pp?\.\s*)?|,\s*pp?\.\s*)(\d+(?:\s*[-–—]\s*\d+)?)")
_SURNAME = r"(?:(?:[Dd]e|[Vv]an|[Vv]on|der|den|la|le|du|da|di)\s+)*[A-Z][A-Za-z'’\-]+"
_NARRATIVE_CITE_RE = re.compile(
    r"(" + _SURNAME + r"(?:\s+et\s+al\.?|\s+(?:and|&)\s+" + _SURNAME + r")?)"
    r"(?:['’]s?)?\s*\(\s*(" + _YEAR + r"[a-z]?)\s*(?:[:,][^()]{0,20})?\)")


def narrative_cites(text):
    """Parenthetical restatements of the narrative cites in `text`."""
    out = []
    for m in _NARRATIVE_CITE_RE.finditer(text or ""):
        name = re.sub(r"\s+", " ", m.group(1)).strip()
        if not name.endswith("."):
            name = re.sub(r"et al$", "et al.", name)
        out.append("(%s %s)" % (name, m.group(2)))
    return out


def norm(s):
    for a, b in (("“", '"'), ("”", '"'), ("‘", "'"), ("’", "'"),
                 ("–", "-"), ("—", "-"), ("…", "...")):
        s = (s or "").replace(a, b)
    return re.sub(r"\s+", " ", s).strip().lower()


def quote_in_note(note_text, quote):
    """True if `quote` appears verbatim in the note (whitespace/curly-quote/dash
    normalized), including a quote that spans the note's `> ` blockquote lines."""
    nq = norm(quote)
    if not nq:
        return False
    unq = "\n".join(re.sub(r"^\s*>\s?", "", ln) for ln in (note_text or "").split("\n"))
    haystacks = (norm(note_text), norm(unq))
    for cand in (nq, nq.rstrip(",;:. ")):
        if cand and any(cand in h for h in haystacks):
            return True
    if "..." in nq:
        frags = [f.strip(",;:. ") for f in nq.split("...")]
        frags = [f for f in frags if f]
        if len(frags) >= 2:
            for h in haystacks:
                pos, ok = 0, True
                for f in frags:
                    i = h.find(f, pos)
                    if i < 0:
                        ok = False
                        break
                    pos = i + len(f)
                if ok:
                    return True
    return False


def extract_quote_span(s):
    """The quoted material on a source line: text between the FIRST opening quote
    and the LAST closing quote. None if no quoted span."""
    opens = [i for i in (s.find('"'), s.find("“")) if i >= 0]
    if not opens:
        return None
    start = min(opens)
    end = max(s.rfind('"'), s.rfind("”"))
    if end <= start:
        return None
    inner = s[start + 1:end].strip()
    return inner or None


def extract_quotes_from_note(text, cap=400):
    """Clean verbatim blockquote lines from a note's body, with page refs."""
    quotes = []
    for raw in (text or "").split("\n"):
        m = _QUOTE_BLOCK.match(raw.strip())
        if not m:
            continue
        q = m.group(1).strip()
        if "[[" in q or q.startswith(("[!", "(", "[", "!", ">")):
            continue
        q = q.strip('"“”')
        page, pg = _page_marker(q)
        if page:
            q = (q[:pg.start()] + q[pg.end():]).strip()
        q = re.sub(r"\s+", " ", q).strip(' ".“”')
        if len(q) >= 16 and " " in q and re.search(r"[A-Za-z]", q):
            quotes.append({"text": q, "page": page})
        if len(quotes) >= cap:
            break
    return quotes


def cited_page(body):
    """The page a source LINE cites — read outside the quoted span, so a year
    or number inside the quote itself can never masquerade as the page."""
    s = body or ""
    span = extract_quote_span(s)
    if span:
        s = s.replace(span, " ")
    page, _m = _page_marker(s)
    return page


def page_set(pgstr):
    """The page integers a page string denotes ('8' -> {8}; '8-9' -> {8,9}; a
    longer range -> its endpoints). Empty set if none."""
    if not pgstr:
        return set()
    nums = [int(n) for n in re.findall(r"\d+", str(pgstr))]
    if not nums:
        return set()
    if len(nums) >= 2:
        lo, hi = nums[0], nums[1]
        if 0 <= hi - lo <= 40:
            return set(range(lo, hi + 1))
        return {lo, hi}
    return {nums[0]}


def quote_page_ok(note_text, quote, cited_pages):
    nq = norm(quote)
    matched_pages, saw_pageful_match = [], False
    for it in extract_quotes_from_note(note_text, cap=400):
        t = norm(it["text"])
        if t == nq or (len(nq) >= 24 and (nq in t or t in nq)):
            if it.get("page"):
                saw_pageful_match = True
                if page_set(it["page"]) & cited_pages:
                    return True, it["page"]
                matched_pages.append(it["page"])
    if not saw_pageful_match:
        return True, ""
    return False, ", ".join(matched_pages)


# ------------------------------------------------------------ source lines

def verify_source_line(vault, line):
    import drafting
    s = (line or "").strip()
    if not s:
        return True, ""
    m = _LINK.search(s)
    if not m:
        return False, "no [[source link]] — every citation must point to a real note"
    rel = m.group(1).split("|")[0].strip()
    rel = rel if rel.endswith(".md") else rel + ".md"
    body = _LINK.sub("", s).strip()
    is_quote_line = body.startswith(">")
    quote = extract_quote_span(body)
    rec = drafting.read_source(vault, rel, None)
    if rec.get("error"):
        return False, ("source note not found / not allowed: %s — use the full "
                       "vault path, e.g. [[Preparation/Reading/Citations/<stem>]]" % rel)
    if quote is not None:
        if not quote_in_note(rec.get("text", ""), quote):
            return False, "quote not found verbatim in %s — possible misquote/fabrication" % rel.split("/")[-1]
        cited = page_set(cited_page(body))
        if cited:
            ok_page, note_pages = quote_page_ok(rec.get("text", ""), quote, cited)
            if not ok_page:
                return (False, "page mismatch in %s: line cites p. %s but the note "
                        "records this quote on p. %s" % (rel.split("/")[-1], cited_page(body), note_pages))
        return True, ""
    if is_quote_line:
        return False, ("a '>' quote line with no parseable quote can't be verified — "
                       "wrap the exact words in double quotes, or use a '-' paraphrase line")
    return True, ""


def verify_editor_sources(vault, slug, doc="paper.md"):
    """Audit every attached source line in the editor sidecar. Returns
    {results, failing, checked}."""
    import drafting
    paths = drafting._writing_paths(vault, slug, doc)
    results, checked = [], 0
    if not paths:
        return {"results": [], "failing": 0, "checked": 0, "error": "bad slug/doc"}
    etext = drafting._read(paths[1]) or ""
    if not etext.strip():
        return {"results": [], "failing": 0, "checked": 0}
    by_fp, by_pos = drafting.parse_editor(etext)
    seen = set()
    for rec in list(by_fp.values()) + list(by_pos.values()):
        if id(rec) in seen:
            continue
        seen.add(id(rec))
        for ln in (rec.get("sources") or "").split("\n"):
            if not ln.strip():
                continue
            checked += 1
            ok, reason = verify_source_line(vault, ln)
            if not ok:
                results.append({"line": ln.strip(), "reason": reason})
    return {"results": results, "failing": len(results), "checked": checked}


# ------------------------------------------------------------- prose quotes

def _candidate_rels(window, vault, slug, here):
    """Note rels a cite in `window` could refer to: resolver hits + ambiguous
    candidates + this project's corpus files."""
    import references
    rels, tokens = [], []
    try:
        idx = references.load_resolver_index(here)
        res = references.resolve_cites(window + " " + " ".join(narrative_cites(window)), idx)
    except Exception:
        return [], []
    for r in res.get("resolved", []):
        tokens.append(r.get("token", ""))
        if r.get("rel"):
            rels.append(r["rel"])
    for amb in res.get("ambiguous", []):
        tokens.append(amb.get("token", ""))
        for c in amb.get("candidates", []):
            if c.get("rel"):
                rels.append(c["rel"])
    corpus = []
    try:
        corpus = references._corpus_filenames(vault, slug)
    except Exception:
        pass
    for u in res.get("unresolved", []):
        tokens.append(u)
    for tok in list(tokens):
        try:
            t = references.parse_cite_token(tok)
            crel = references._corpus_match(corpus, t)
            if crel:
                rels.append(crel)
        except Exception:
            pass
    out, dedup = [], set()
    for r in rels:
        if r not in dedup:
            dedup.add(r)
            out.append(r)
    return out, [t for t in tokens if t]


def verify_prose_quotes(vault, slug, doc="paper.md", here=None):
    """Scan the MANUSCRIPT prose for double-quoted spans and machine-verify each
    against the live note of its adjacent cite."""
    import drafting
    paths = drafting._writing_paths(vault, slug, doc)
    if not paths or not paths[0].exists():
        return {"results": [], "blocking": [], "counts": {}, "error": "doc not found"}
    text = paths[0].read_text(encoding="utf-8", errors="replace")
    refs = REFS_HEADING_RE.search(text)
    scan_end = refs.start() if refs else len(text)

    results, blocking, counts = [], [], {}

    def bump(status):
        counts[status] = counts.get(status, 0) + 1

    for m in _PROSE_QUOTE_RE.finditer(text):
        if m.start() >= scan_end:
            break
        quote = (m.group(1) or m.group(2) or "").strip()
        if "[[" in quote or "](" in quote:
            continue
        line_no = text[:m.start()].count("\n") + 1
        after = text[m.end():m.end() + 140]
        before = text[max(0, m.start() - 160):m.start()]
        window = before + " " + after

        # the page the prose claims, if any ("(Author 2020:44)" after the quote,
        # or narrative "Author (2020:44) writes" before it)
        pm = _CITE_PAGE_RE.search(after[:90]) or _CITE_PAGE_RE.search(before[-90:])
        pages = page_set(pm.group(1)) if pm else set()

        rels, tokens = _candidate_rels(window, vault, slug, here)
        rec_base = {"line": line_no, "quote": quote[:120], "cite": "; ".join(tokens[:4]),
                    "page": pm.group(1) if pm else None}

        if not tokens:
            bump("UNCITED")
            results.append(dict(rec_base, status="UNCITED",
                                detail="quoted span with no adjacent cite"))
            continue
        found_rel, page_ok, note_pages = None, None, ""
        readable = 0
        for rel in rels:
            nrec = drafting.read_source(vault, rel, None)
            if nrec.get("error"):
                continue
            readable += 1
            ntext = nrec.get("text", "")
            if quote_in_note(ntext, quote):
                found_rel = rel
                if pages:
                    ok, note_pages = quote_page_ok(ntext, quote, pages)
                    page_ok = ok
                    if ok:
                        break
                else:
                    break
        if found_rel and (not pages or page_ok):
            bump("VERIFIED")
            results.append(dict(rec_base, status="VERIFIED", rel=found_rel))
            continue
        if found_rel and pages and page_ok is False:
            msg = ("line %d: quote cites p. %s but %s records it on p. %s"
                   % (line_no, rec_base["page"], found_rel.split("/")[-1], note_pages or "?"))
            bump("PAGE-MISMATCH")
            blocking.append(msg)
            results.append(dict(rec_base, status="PAGE-MISMATCH", rel=found_rel, detail=msg))
            continue
        if readable == 0:
            bump("NO-NOTE")
            results.append(dict(rec_base, status="NO-NOTE",
                                detail="no readable note for this cite"))
            continue
        if pages:
            msg = ("line %d: page-cited quote not found verbatim in any note for (%s) — "
                   "possible misquote/fabrication" % (line_no, rec_base["cite"]))
            bump("QUOTE-NOT-IN-NOTE")
            blocking.append(msg)
            results.append(dict(rec_base, status="QUOTE-NOT-IN-NOTE", detail=msg))
        else:
            bump("QUOTE-UNVERIFIED")
            results.append(dict(rec_base, status="QUOTE-UNVERIFIED",
                                detail="unpaged quote near a cite; not found verbatim in its note"))
    return {"results": results, "blocking": blocking, "counts": counts}


# --------------------------------------------------------------- aggregate

def verify_all(vault, slug, doc="paper.md", here=None):
    """The board's one-click integrity report: cites + prose quotes + editor
    sources + numbers + provenance, one structured verdict. Every sub-check is
    fail-soft (an exception becomes an 'error' field, never a crash)."""
    import drafting
    import references
    import numberscheck
    report = {"slug": slug, "doc": doc}

    try:
        paths = drafting._writing_paths(vault, slug, doc)
        text = paths[0].read_text(encoding="utf-8", errors="replace") if paths and paths[0].exists() else ""
        cm = references.cite_map(text, references.load_resolver_index(here), vault, slug)
        unresolved = sorted(k for k, v in cm.get("map", {}).items() if v.get("status") == "unresolved" and not v.get("alias"))
        ambiguous = sorted(k for k, v in cm.get("map", {}).items() if v.get("status") == "ambiguous" and not v.get("alias"))
        report["cites"] = {"counts": cm.get("counts", {}), "unresolved": unresolved,
                           "ambiguous": ambiguous}
    except Exception as exc:
        report["cites"] = {"error": str(exc)}

    try:
        report["proseQuotes"] = verify_prose_quotes(vault, slug, doc, here)
    except Exception as exc:
        report["proseQuotes"] = {"error": str(exc)}

    try:
        report["editorSources"] = verify_editor_sources(vault, slug, doc)
    except Exception as exc:
        report["editorSources"] = {"error": str(exc)}

    try:
        proj = drafting._project_dir(vault, slug)
        report["numbers"] = numberscheck.check_project(proj, doc=doc, all_docs=True) if proj else {"error": "no project dir"}
    except Exception as exc:
        report["numbers"] = {"error": str(exc)}

    try:
        report["provenance"] = drafting.provenance_status(vault, slug)
    except Exception as exc:
        report["provenance"] = {"error": str(exc)}

    try:
        docs = tuple(dict.fromkeys([doc, "paper.md", "appendix.md"]))
        off = drafting.external_stats_offenders(vault, slug, docs=docs, run_verifiers=True)
        report["statsSources"] = {"offenders": [
            {"doc": d, "stem": s, "reason": r, "detail": det} for d, s, r, det in off]}
        import settings
        if not settings.RUN_VAULT_SCRIPTS:
            report["statsSources"]["verifiersSkipped"] = drafting.VERIFIERS_SKIPPED
    except Exception as exc:
        report["statsSources"] = {"error": str(exc)}

    blocking = []
    blocking += ["ungrounded cite: %s" % k for k in report.get("cites", {}).get("unresolved", [])]
    blocking += report.get("proseQuotes", {}).get("blocking", [])
    blocking += ["editor source: %s" % r["reason"] for r in report.get("editorSources", {}).get("results", [])]
    blocking += ["number: %s" % b for b in report.get("numbers", {}).get("blocking", [])]
    blocking += ["external stats: %s/%s (%s)" % (o["doc"], o["stem"], o["reason"])
                 for o in report.get("statsSources", {}).get("offenders", [])]
    report["blocking"] = blocking
    report["ok"] = not blocking
    return report
