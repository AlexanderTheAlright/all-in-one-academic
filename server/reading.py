"""Reading lists v2 — ordered groups, section notes, download tracking, archive/restart."""
import settings
from pathlib import Path
from contextlib import contextmanager
import os, re, datetime, threading, time, unicodedata

HERE = settings.STATE_DIR
VAULT = settings.VAULT
READING_DIR = VAULT / "Preparation" / "Reading"
LISTS_DIR = Path(os.environ.get("AIOA_READING_LISTS_DIR") or READING_DIR)
READING_LIST = LISTS_DIR / "To Read.md"
DOWNLOAD_QUEUE = LISTS_DIR / "To Download.md"
ARCHIVE_DIR = LISTS_DIR / "Archive"
CORPUS_DIR = READING_DIR / "Corpus"

_LATIN_EQUIV = str.maketrans({
    "ł": "l", "Ł": "L", "ø": "o", "Ø": "O", "đ": "d", "Đ": "D",
    "ð": "d", "Ð": "D", "ħ": "h", "Ħ": "H", "ŧ": "t", "Ŧ": "T", "ı": "i",
    "æ": "ae", "Æ": "AE", "œ": "oe", "Œ": "OE", "ß": "ss", "þ": "th", "Þ": "TH",
})


def _fold(s):
    """Case- and diacritic-blind key for matching titles and citation names."""
    s = unicodedata.normalize("NFKD", (s or "").strip()).translate(_LATIN_EQUIV)
    s = "".join(c for c in s if not unicodedata.combining(c))
    return " ".join(s.casefold().split())
CITATIONS_DIR = READING_DIR / "Citations"
BAK = HERE / "toread-last.bak.md"
QUEUE_BAK = HERE / "todownload-last.bak.md"
QUEUE_TITLE = "# To Download"
QUEUE_DEFAULT_SOURCE = "Added on the Board"

WIKILINK_RE = re.compile(r"\[\[([^\]|]+)")
STATUS_TEXT = {"read": "✅ read", "reading": "reading", "unread": "unread"}
ITEM_RE = re.compile(r"^- \[([ xX])\]\s*(.*)$")
SUB_RE = re.compile(r"^(\s+)-\s*(Citation|DOI|PDF|Why|Read|Status|Download|Type|Source|Due|Queue)\s*:\s*(.*)$")
HEAD_RE = re.compile(r"^(#{2,4})\s+(.*\S)\s*$")
DATE_SUFFIX = re.compile(r"\s*[—-]\s*(20\d{2}-\d{2}-\d{2})\s*$")


# ----------------------------------------------------------------- io helpers
def read_text(p):
    try:
        return Path(p).read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None


def _atomic_write(path, text, backup=False, bak=None):
    path = Path(path)
    if backup:
        cur = read_text(path)
        if cur is not None:
            try:
                Path(bak or BAK).write_text(cur, encoding="utf-8")
            except OSError:
                pass
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(str(tmp), str(path))


def _today():
    return datetime.date.today().isoformat()


LOCK_PATH = Path(os.environ.get("AIOA_READING_LOCK") or settings.STATE_DIR / "reading.lock")
_PROC_LOCK = threading.RLock()
_FLOCK = {"fh": None, "depth": 0}


class LockBusy(RuntimeError):
    pass


@contextmanager
def locked(timeout=None):
    import fcntl
    if not _PROC_LOCK.acquire(timeout=-1 if timeout is None else timeout):
        raise LockBusy("reading lists are busy")
    try:
        if _FLOCK["depth"] == 0:
            LOCK_PATH.parent.mkdir(parents=True, exist_ok=True)
            fh = open(LOCK_PATH, "w")
            if timeout is None:
                fcntl.flock(fh, fcntl.LOCK_EX)
            else:
                end = time.monotonic() + timeout
                while True:
                    try:
                        fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
                        break
                    except OSError:
                        if time.monotonic() >= end:
                            fh.close()
                            raise LockBusy("reading lists are busy")
                        time.sleep(0.05)
            _FLOCK["fh"] = fh
        _FLOCK["depth"] += 1
        try:
            yield
        finally:
            _FLOCK["depth"] -= 1
            if _FLOCK["depth"] == 0:
                fh, _FLOCK["fh"] = _FLOCK["fh"], None
                try:
                    fcntl.flock(fh, fcntl.LOCK_UN)
                finally:
                    fh.close()
    finally:
        _PROC_LOCK.release()


# ----------------------------------------------------------------- the three files
def _sources(archives=True):
    """(kind, path) for every file that can hold a reading, in addressing priority:
    active lists, then the standalone queue, then each archived list."""
    out = [("active", READING_LIST), ("queue", DOWNLOAD_QUEUE)]
    if archives and ARCHIVE_DIR.is_dir():
        out += [("archived", f) for f in sorted(ARCHIVE_DIR.iterdir())
                if f.is_file() and f.suffix == ".md"]
    return out


def _load_path(path, kind="active"):
    """Parse one list file; the doc remembers its file so _save writes it back there."""
    text = read_text(path)
    if text is None:
        return None
    doc = parse_doc(text)
    doc["_path"] = Path(path)
    doc["_kind"] = kind
    return doc


def _archive_file(name):
    n = Path(str(name or "")).name
    if not n.endswith(".md") or n.startswith("."):
        return None
    p = ARCHIVE_DIR / n
    try:
        if not p.resolve().is_relative_to(ARCHIVE_DIR.resolve()):
            return None
    except OSError:
        return None
    return p if p.is_file() else None


def _load_for(data):
    """The doc a Board op addresses: `where` = active (default) | queue | archived
    (+ `file`, the archive's file name)."""
    where = (data or {}).get("where") or "active"
    if where == "queue":
        return _load_path(DOWNLOAD_QUEUE, "queue")
    if where == "archived":
        p = _archive_file((data or {}).get("file"))
        return _load_path(p, "archived") if p else None
    return _load()


def _read_state(status):
    s = (status or "").lower()
    if "✅" in (status or "") or s.strip() == "read" or s.startswith("read "):
        return "read"
    if "reading" in s:
        return "reading"
    return "unread"


def _clean_title(raw):
    return re.sub(r"^\d+\.\s*", "", raw).replace("**", "").replace("*", "").strip()


_OTHER_TITLE_RE = re.compile(
    r"\b(report|white\s?paper|press\s+release|data\s?set|\bblog\b|news|magazine|"
    r"podcast|web\s?site|web\s?page|manual|policy\s+brief|fact\s?sheet|census|"
    r"newsletter|op-?ed|working\s+paper|preprint|bulletin|yearbook)\b", re.I)
_BOOK_TITLE_RE = re.compile(
    r"\b(book|monograph|handbook|textbook|edited\s+volume|\beds?\.|university\s+press|"
    r"\bpress\b|\bvol\.?\b|volume)\b", re.I)
_BOOK_PUBLISHER_RE = re.compile(
    r"\b(routledge|palgrave|springer|verso|aldine|erlbaum|"
    r"sage\s+publications|russell\s+sage|academic\s+press|basic\s+books|"
    r"beacon\s+press|guilford\s+press|transaction\s+publishers|"
    r"harper\s*(&|and)\s*row|chapman\s*(&|and)\s*hall|"
    r"prentice[\s-]hall|mcgraw[\s-]hill)\b", re.I)
_OTHER_PHRASE_RE = re.compile(
    r"(commercial|technical|annual|industry|research|policy|government|official)\s+report|"
    r"working\s+paper|press\s+release|"
    r"(survey|statistical|administrative|panel|micro)\s+data\s?set|web\s?site", re.I)
_BOOK_PHRASE_RE = re.compile(
    r"book\s+chapter|edited\s+volume|edited\s+by|\(eds?\.?\)|university\s+press|monograph", re.I)

_CHAPTER_TITLE_RE = re.compile(
    r"\breprinted\s+in\b|\boriginally\s+in\b|\bselections?\s+from\b|\bexcerpts?\b|"
    r"\bin\s+[A-Z][A-Za-z.'-]*(?:\s+[A-Z][A-Za-z.'-]*)*\s*(?:&|and)?[^,]{0,30}\(eds?\.?\)|"
    r"\bchapters?\s+\d|\bpp\.\s*\d+", re.I)
_PART_LEAD_RE = re.compile(
    r"^\s*['\"]?(introduction|conclusion|preface|foreword|afterword|prologue|epilogue)\b", re.I)

_JOURNAL_CITE_RE = re.compile(
    r"\b\d{1,3}\s*\(\s*\d{1,3}[A-Za-z]?(?:\s*[-–/]\s*\d{1,3})?\s*\)|"
    r"\bvol\.?\s*\d+\s*[,.]?\s*(?:no\.?|issue|iss\.?)\s*\d+", re.I)


def _looks_like_journal_cite(title):
    """True when the reading title carries a volume(issue) serial citation."""
    body = title.split(" - ", 1)[1] if " - " in title else title
    return bool(_JOURNAL_CITE_RE.search(body))


def _looks_like_chapters(title):
    """True when a reading title enumerates parts of a book rather than naming a work."""
    body = title.split(" - ", 1)[1] if " - " in title else title
    if _CHAPTER_TITLE_RE.search(body):
        return True
    if _PART_LEAD_RE.match(body):
        return True
    # An enumeration of two or more chapter names joined by ", and ".
    return body.count(", and ") >= 2

_HELD_MANUAL = {"manual", "proxy", "needs-owner", "ill", "owner"}


def _infer_type(it):
    title = it.get("title", "") or ""
    both = f"{title} {it.get('why') or ''}"
    # A serial citation in the title settles it before any book set can misfire.
    # `Source:` still wins, because it names a different work to actually fetch.
    if _looks_like_journal_cite(title) and not it.get("source"):
        return "article"
    if _OTHER_TITLE_RE.search(title) or _OTHER_PHRASE_RE.search(both):
        return "other"
    if (_BOOK_TITLE_RE.search(title) or _BOOK_PHRASE_RE.search(both)
            or _BOOK_PUBLISHER_RE.search(title)):
        return "book"
    if it.get("source") or _looks_like_chapters(title):
        return "book"
    return "article"


def _resolved_type(it):
    return it.get("type") or _infer_type(it)


def _type_resolved(it):
    return bool(it.get("type"))


# ----------------------------------------------------------------- parsing
def _valid_date(s):
    """`YYYY-MM-DD` when s is exactly a real calendar date in that form, else None."""
    s = (s or "").strip() if isinstance(s, str) else ""
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", s):
        return None
    try:
        datetime.date.fromisoformat(s)
    except ValueError:
        return None
    return s


def _parse_item(lines):
    """lines = the raw lines of one `- [ ]` item block (no trailing blanks)."""
    m = ITEM_RE.match(lines[0])
    it = {"raw": "", "title": "", "checked": False, "readState": "unread", "status": None,
          "citationName": None, "citationPath": None, "pdfPath": None, "pdfMissing": False,
          "why": None, "read": None, "download": None, "needsDownload": False, "type": None,
          "source": None,
          "doi": None, "heldManual": False, "due": None, "queue": None}
    if m:
        it["raw"] = m.group(2).strip()
        it["title"] = _clean_title(m.group(2))
        it["checked"] = m.group(1).lower() == "x"
    for ln in lines[1:]:
        sub = SUB_RE.match(ln)
        if not sub:
            continue
        kind, val = sub.group(2), sub.group(3).strip()
        if kind == "Citation" and it["citationPath"] is None:
            lk = WIKILINK_RE.search(val)
            if lk:
                it["citationPath"] = lk.group(1).strip()
                it["citationName"] = Path(lk.group(1).strip()).stem
        elif kind == "PDF" and it["pdfPath"] is None:
            lk = WIKILINK_RE.search(val)
            if lk:
                it["pdfPath"] = lk.group(1).strip()
        elif kind == "DOI":
            it["doi"] = val.strip() or None
        elif kind == "Why":
            it["why"] = val
        elif kind == "Read":
            it["read"] = val
        elif kind == "Status":
            it["status"] = val
            it["readState"] = _read_state(val)
        elif kind == "Download":
            it["download"] = val.lower()
        elif kind == "Type":
            t = val.strip().lower()
            it["type"] = t if t in ("article", "book", "other") else None
        elif kind == "Source":
            it["source"] = val.strip() or None
        elif kind == "Due" and it["due"] is None:
            it["due"] = _valid_date(val)
        elif kind == "Queue" and it["queue"] is None:
            it["queue"] = int(val) if re.fullmatch(r"[1-9]\d{0,5}", val) else None
    if it["pdfPath"] is not None:
        try:
            it["pdfMissing"] = not (VAULT / it["pdfPath"]).exists()
        except OSError:
            it["pdfMissing"] = False
    # needs-download: explicit Download marker wins, else inferred from the PDF
    # (no link at all, OR a link pointing at a file that isn't there).
    dl = it["download"]
    if dl in ("have", "n/a", "done", "owned", "retracted"):
        it["needsDownload"] = False
        it["retracted"] = dl == "retracted"
    elif dl in _HELD_MANUAL:
        it["needsDownload"] = True
        it["heldManual"] = True
    elif dl in ("needed", "need", "missing", "yes"):
        it["needsDownload"] = True
    else:
        it["needsDownload"] = it["pdfPath"] is None or it["pdfMissing"]
    return it


def parse_doc(text):
    """Parse a reading-list markdown file into a structure that round-trips losslessly
    for the blocks we don't touch. Returns {preamble, lists:[...]}."""
    lines = (text or "").split("\n")
    doc = {"preamble": [], "lists": []}
    cur_list = cur_group = None
    cur_item_lines = None

    def flush_item():
        nonlocal cur_item_lines
        if cur_item_lines is not None and cur_group is not None:
            while cur_item_lines and cur_item_lines[-1].strip() == "":
                cur_item_lines.pop()
            it = _parse_item(cur_item_lines)
            it["lines"] = cur_item_lines
            cur_group["items"].append(it)
        cur_item_lines = None

    for ln in lines:
        h = HEAD_RE.match(ln)
        if h:
            flush_item()
            level = len(h.group(1))
            title = h.group(2).strip()
            if level == 2:
                cur_list = {"heading": ln, "name": title, "date": None,
                            "preamble": [], "groups": []}
                m = DATE_SUFFIX.search(title)
                if m:
                    cur_list["date"] = m.group(1)
                doc["lists"].append(cur_list)
                cur_group = None
            else:
                if cur_list is None:
                    # heading before any list: keep as document preamble
                    doc["preamble"].append(ln)
                    continue
                cur_group = {"heading": ln, "level": level, "name": title,
                             "lead": [], "items": [], "trail": [], "prose": False}
                cur_list["groups"].append(cur_group)
            continue
        if cur_list is None:
            doc["preamble"].append(ln)
            continue
        if cur_group is None:
            # content between the list heading and its first group heading
            if ITEM_RE.match(ln):
                # rare: items before any group -> implicit untitled group
                cur_group = {"heading": None, "level": 3, "name": "",
                             "lead": [], "items": [], "trail": [], "prose": False}
                cur_list["groups"].append(cur_group)
                flush_item()
                cur_item_lines = [ln]
            else:
                cur_list["preamble"].append(ln)
            continue
        # inside a group
        if ITEM_RE.match(ln):
            flush_item()
            cur_item_lines = [ln]
        elif cur_item_lines is not None:
            # indented sub-bullet / blank continues the current item; a non-indented
            # non-blank line ends the item and becomes group trail
            if ln.strip() == "" or ln.startswith((" ", "\t")):
                cur_item_lines.append(ln)
            else:
                flush_item()
                cur_group["trail"].append(ln)
        else:
            (cur_group["lead"] if not cur_group["items"] else cur_group["trail"]).append(ln)
    flush_item()

    for lst in doc["lists"]:
        for g in lst["groups"]:
            g["note"] = _extract_note(g["lead"])
            leftover = [l for l in g["lead"] if l.strip() and not l.strip().startswith(">")]
            g["prose"] = len(g["items"]) == 0 and len(leftover) > 0
        lst["note"] = _extract_note(lst["preamble"])
    return doc


def _extract_note(lines):
    """The first `> ` blockquote run in a lead/preamble, joined as plain text."""
    note = []
    for ln in lines:
        s = ln.strip()
        if s.startswith(">"):
            note.append(s.lstrip("> ").rstrip())
        elif note:
            break
    return " ".join(x for x in note if x).strip() or None


# ----------------------------------------------------------------- serialize
def serialize(doc):
    out = list(doc["preamble"])
    for li, lst in enumerate(doc["lists"]):
        out.append(lst["heading"])
        out.extend(lst["preamble"])
        for g in lst["groups"]:
            if g["heading"] is not None:
                out.append(g["heading"])
            if g["prose"]:
                out.extend(g["lead"])
                out.extend(g["trail"])
                continue
            lead = list(g["lead"])
            while lead and lead[-1].strip() == "":
                lead.pop()
            out.extend(lead)
            out.append("")
            for it in g["items"]:
                out.extend(it["lines"])
                out.append("")
            trail = list(g["trail"])
            while trail and trail[0].strip() == "":
                trail.pop(0)
            out.extend(trail)
    text = "\n".join(out)
    if not text.endswith("\n"):
        text += "\n"
    text = re.sub(r"\n{4,}", "\n\n\n", text)
    return text


# ----------------------------------------------------------------- lookups
def _find_list(doc, name):
    for lst in doc["lists"]:
        if lst["name"] == name:
            return lst
    # fall back to a date-stripped match so the UI's clean name still resolves
    target = DATE_SUFFIX.sub("", name).strip()
    for lst in doc["lists"]:
        if DATE_SUFFIX.sub("", lst["name"]).strip() == target:
            return lst
    return None


def _group(lst, idx):
    gs = lst["groups"]
    return gs[idx] if lst and 0 <= idx < len(gs) else None


# ----------------------------------------------------------------- item line edits
def _detect_indent(lines):
    for ln in lines[1:]:
        m = re.match(r"^(\s+)-\s", ln)
        if m:
            return m.group(1)
    return "  "


_FIELD_ORDER = ["Citation", "DOI", "PDF", "Read", "Why", "Type", "Due", "Queue", "Status", "Download"]


def _set_subbullet(item, field, value):
    """Insert/replace/delete a sub-bullet on an item, preserving everything else."""
    lines = item["lines"]
    indent = _detect_indent(lines)
    # find existing
    for i in range(1, len(lines)):
        sub = SUB_RE.match(lines[i])
        if sub and sub.group(2) == field:
            if value is None:
                lines.pop(i)
            else:
                lines[i] = f"{indent}- {field}: {value}"
            return
    if value is None:
        return
    newline = f"{indent}- {field}: {value}"
    # insert respecting a sensible field order
    rank = _FIELD_ORDER.index(field) if field in _FIELD_ORDER else len(_FIELD_ORDER)
    insert_at = len(lines)
    for i in range(1, len(lines)):
        sub = SUB_RE.match(lines[i])
        if sub:
            other = _FIELD_ORDER.index(sub.group(2)) if sub.group(2) in _FIELD_ORDER else len(_FIELD_ORDER)
            if other > rank:
                insert_at = i
                break
    else:
        insert_at = len(lines)
    lines.insert(insert_at, newline)


def _new_item_lines(title, citation_path=None, pdf_path=None, why=None, read=None,
                    needs_download=False, doi=None):
    safe = (title or "").replace("|", " ").replace("]", ")").replace("[", "(").strip()
    lines = [f"- [ ] **{safe}**"]
    if citation_path:
        lines.append(f"  - Citation: [[{citation_path}|{safe}]]")
    if doi:
        lines.append(f"  - DOI: {doi.strip()}")
    if pdf_path:
        lines.append(f"  - PDF: [[{pdf_path}|Open PDF]]")
    if read:
        lines.append(f"  - Read: {read}")
    if why:
        lines.append(f"  - Why: {why}")
    if needs_download and not pdf_path:
        lines.append("  - Download: needed")
    else:
        lines.append("  - Download: have")
    lines.append("  - Status: unread")
    return lines


def _load():
    return _load_path(READING_LIST, "active")


def _save(doc):
    path = Path(doc.get("_path") or READING_LIST)
    if path == READING_LIST:
        _normalize_queue(doc)
        _atomic_write(path, serialize(doc), backup=True, bak=BAK)
    elif path == DOWNLOAD_QUEUE:
        _atomic_write(path, serialize(doc), backup=True, bak=QUEUE_BAK)
    else:
        _atomic_write(path, serialize(doc))


def toggle(data):
    """Flip an item's read state. Locate by (list, group, item) ref, or — for back
    compat — by citationPath. Returns {readState, citation:{path,state}} for sync."""
    state = data.get("state")
    if state not in STATUS_TEXT:
        return None
    doc = _load_for(data)
    if doc is None:
        return None
    item = _resolve_item(doc, data)
    if item is None:
        return None
    box = "[x]" if state == "read" else "[ ]"
    item["lines"][0] = re.sub(r"^- \[[ xX]\]", f"- {box}", item["lines"][0], count=1)
    _set_subbullet(item, "Status", STATUS_TEXT[state])
    item["readState"] = state
    item["checked"] = state == "read"
    if state == "read":
        # a read item leaves the read-next queue; _save renumbers the rest
        _set_subbullet(item, "Queue", None)
        item["queue"] = None
    _save(doc)
    cp = item.get("citationPath")
    return {"readState": state, "citation": {"path": cp, "state": state} if cp else None}


def _resolve_item(doc, data):
    if "group" in data and "item" in data and data.get("list"):
        lst = _find_list(doc, data["list"])
        g = _group(lst, int(data["group"]))
        if g and 0 <= int(data["item"]) < len(g["items"]):
            return g["items"][int(data["item"])]
        return None
    cp = data.get("citationPath")
    if cp:
        for lst in doc["lists"]:
            if data.get("list") and lst["name"] != data["list"]:
                continue
            for g in lst["groups"]:
                for it in g["items"]:
                    if it.get("citationPath") == cp:
                        return it
    return None


def item_edit(data):
    """Edit an item's Why / Read / title fields."""
    doc = _load_for(data)
    if doc is None:
        return None
    item = _resolve_item(doc, data)
    if item is None:
        return None
    f = data.get("fields", {})
    if "why" in f:
        _set_subbullet(item, "Why", (f["why"] or "").strip() or None)
    if "read" in f:
        _set_subbullet(item, "Read", (f["read"] or "").strip() or None)
    if "type" in f:
        t = (f["type"] or "").strip().lower()
        _set_subbullet(item, "Type", t if t in ("article", "book", "other") else None)
    if "title" in f and f["title"].strip():
        safe = f["title"].replace("|", " ").replace("]", ")").replace("[", "(").strip()
        item["lines"][0] = re.sub(r"^(- \[[ xX]\]\s*).*$", lambda m: m.group(1) + f"**{safe}**",
                                  item["lines"][0], count=1)
    _save(doc)
    return {"ok": True}


def item_download(data):
    """Set an item's download state. needsDownload True -> mark `Download: needed`;
    False -> `Download: have`. A pdf path links the PDF and flips to have."""
    doc = _load_for(data)
    if doc is None:
        return None
    item = _resolve_item(doc, data)
    if item is None:
        return None
    if _retracted(item):
        return _RETRACTED_ERR
    if data.get("pdf"):
        _set_subbullet(item, "PDF", f"[[{data['pdf']}|Open PDF]]")
        _set_subbullet(item, "Download", "have")
    elif data.get("needsDownload") is True:
        _set_subbullet(item, "Download", "needed")
    elif data.get("needsDownload") is False:
        _set_subbullet(item, "Download", "have")
    _save(doc)
    return {"ok": True}


def item_requeue(data):
    doc = _load_for(data)
    if doc is None:
        return None
    item = _resolve_item(doc, data)
    if item is None:
        return None
    _requeue_item(item)
    _save(doc)
    return {"ok": True}


def item_add(data):
    """Add a reading to a list+group. With no PDF it lands as needs-download — the
    primary path for queuing a paper to grab."""
    lst_name, gi = data.get("list"), data.get("group")
    title = (data.get("title") or "").strip()
    if not lst_name or not title:
        return None
    doc = _load_for(data)
    if doc is None:
        return None
    lst = _find_list(doc, lst_name)
    if lst is None:
        return None
    if not lst["groups"]:
        lst["groups"].append({"heading": "### Readings", "level": 3, "name": "Readings",
                              "lead": [], "items": [], "trail": [], "prose": False, "note": None})
    if gi is not None:
        try:
            g = _group(lst, int(gi))
        except (TypeError, ValueError):
            return None
        if g is None or g["prose"]:
            return None
    else:
        g = lst["groups"][0]
        if g["prose"]:
            g = next((x for x in lst["groups"] if not x["prose"]), g)
    lines = _new_item_lines(title, citation_path=data.get("citationPath") or None,
                            pdf_path=data.get("pdfPath") or None, why=data.get("why") or None,
                            read=data.get("read") or None,
                            needs_download=bool(data.get("needsDownload", not data.get("pdfPath"))),
                            doi=data.get("doi") or None)
    it = _parse_item(lines)
    it["lines"] = lines
    pos = data.get("atTop")
    if pos:
        g["items"].insert(0, it)
    else:
        g["items"].append(it)
    _save(doc)
    return {"ok": True}


def item_delete(data):
    doc = _load_for(data)
    if doc is None:
        return None
    lst = _find_list(doc, data.get("list", ""))
    g = _group(lst, int(data.get("group", -1)))
    ii = int(data.get("item", -1))
    if g is None or not (0 <= ii < len(g["items"])):
        return None
    g["items"].pop(ii)
    _save(doc)
    return {"ok": True}


def item_move(data):
    """Reorder within a group or move to another group. Verbatim block move."""
    doc = _load_for(data)
    if doc is None:
        return None
    lst = _find_list(doc, data.get("list", ""))
    fg = _group(lst, int(data.get("fromGroup", -1)))
    tg = _group(lst, int(data.get("toGroup", -1)))
    fi = int(data.get("fromItem", -1))
    if fg is None or tg is None or not (0 <= fi < len(fg["items"])):
        return None
    if tg["prose"]:
        return None
    it = fg["items"].pop(fi)
    ti = data.get("toIndex")
    ti = len(tg["items"]) if ti is None else max(0, min(int(ti), len(tg["items"])))
    tg["items"].insert(ti, it)
    _save(doc)
    return {"ok": True}


def group_reorder(data):
    """Reorder a list's groups. `order` is the new sequence of current group indices."""
    doc = _load_for(data)
    if doc is None:
        return None
    lst = _find_list(doc, data.get("list", ""))
    order = data.get("order")
    if lst is None or not isinstance(order, list):
        return None
    n = len(lst["groups"])
    if sorted(order) != list(range(n)):
        return None
    lst["groups"] = [lst["groups"][i] for i in order]
    _save(doc)
    return {"ok": True}


def _subgroup_slot(lst, parent):
    """Where a new `#### ` subgroup goes in the flat group list, or None."""
    gs = lst["groups"]
    if parent is None:
        return len(gs) if any(g["level"] <= 3 for g in gs) else None
    if not (0 <= parent < len(gs)) or gs[parent]["level"] > 3:
        return None
    j = parent + 1
    while j < len(gs) and gs[j]["level"] >= 4:
        j += 1
    return j


def group_add(data):
    """Add a group. `sub` (or a `parent` index) makes it a `#### ` subgroup — a
    "Deepen — <topic>" block nested under a `### ` session. Answers the new group's
    flat index, the number `item/add` and `add --group` address it by."""
    doc = _load_for(data)
    if doc is None:
        return None
    lst = _find_list(doc, data.get("list", ""))
    # one line: a newline in a heading would write a second, unintended block
    name = " ".join((data.get("name") or "").split())
    if lst is None or not name:
        return None
    parent = data.get("parent")
    sub = bool(data.get("sub")) or parent is not None
    level = 4 if sub else 3
    g = {"heading": f"{'#' * level} {name}", "level": level, "name": name,
         "lead": [], "items": [], "trail": [], "prose": False, "note": None}
    note = " ".join((data.get("note") or "").split())
    if note:
        g["lead"] = ["", f"> {note}", ""]
        g["note"] = note
    if sub:
        try:
            at = _subgroup_slot(lst, None if parent is None else int(parent))
        except (TypeError, ValueError):
            return None
        if at is None:
            return None
    else:
        at = data.get("atIndex")
        if at is None or not isinstance(at, int):
            at = len(lst["groups"])
        at = max(0, min(at, len(lst["groups"])))
    lst["groups"].insert(at, g)
    _save(doc)
    return {"ok": True, "group": at, "level": level}


def group_rename(data):
    doc = _load_for(data)
    if doc is None:
        return None
    lst = _find_list(doc, data.get("list", ""))
    g = _group(lst, int(data.get("group", -1)))
    name = (data.get("name") or "").strip()
    if g is None or not name:
        return None
    g["name"] = name
    g["heading"] = f"{'#' * g['level']} {name}"
    _save(doc)
    return {"ok": True}


def group_note(data):
    """Set/replace a group's `> ` note (its "what to read" syllabus annotation)."""
    doc = _load_for(data)
    if doc is None:
        return None
    lst = _find_list(doc, data.get("list", ""))
    g = _group(lst, int(data.get("group", -1)))
    if g is None:
        return None
    note = (data.get("note") or "").strip()
    _replace_note(g["lead"], note)
    g["note"] = note or None
    _save(doc)
    return {"ok": True}


def _replace_note(lead, note):
    """Strip the leading `> ` blockquote run from `lead` and prepend a fresh one."""
    # drop a leading blank-then-quote run
    i = 0
    while i < len(lead) and lead[i].strip() == "":
        i += 1
    j = i
    while j < len(lead) and lead[j].strip().startswith(">"):
        j += 1
    # also swallow a trailing blank right after the old quote
    k = j
    while k < len(lead) and lead[k].strip() == "":
        k += 1
    rest = lead[k:]
    new = []
    if note:
        new = ["", f"> {note}", ""]
    lead[:] = new + rest


def list_note(data):
    doc = _load_for(data)
    if doc is None:
        return None
    lst = _find_list(doc, data.get("list", ""))
    if lst is None:
        return None
    note = (data.get("note") or "").strip()
    _replace_note(lst["preamble"], note)
    lst["note"] = note or None
    _save(doc)
    return {"ok": True}


def group_delete(data):
    doc = _load_for(data)
    if doc is None:
        return None
    lst = _find_list(doc, data.get("list", ""))
    gi = int(data.get("group", -1))
    if lst is None or not (0 <= gi < len(lst["groups"])):
        return None
    lst["groups"].pop(gi)
    _save(doc)
    return {"ok": True}


def list_create(data):
    name = (data.get("name") or "").strip()
    if not name:
        return None
    doc = _load()
    if doc is None:
        doc = {"preamble": [], "lists": []}
    if DATE_SUFFIX.search(name) is None:
        name = f"{name} — {_today()}"
    note = (data.get("note") or "").strip()
    lst = {"heading": f"## {name}", "name": name, "date": _today(),
           "preamble": (["", f"> {note}", ""] if note else [""]),
           "note": note or None, "groups": []}
    doc["lists"].insert(0, lst)
    _save(doc)
    return {"ok": True, "name": name}


def list_rename(data):
    doc = _load_for(data)
    if doc is None:
        return None
    lst = _find_list(doc, data.get("list", ""))
    name = (data.get("name") or "").strip()
    if lst is None or not name:
        return None
    lst["name"] = name
    lst["heading"] = f"## {name}"
    _save(doc)
    return {"ok": True, "name": name}


def _slugify(name):
    s = DATE_SUFFIX.sub("", name).strip()
    s = re.sub(r"[^\w\s-]", "", s).strip().replace(" ", "-")
    return (s[:80] or "list")


def _extract_list_block(doc, name):
    """Pull a list out of a doc, returning (remaining_doc_modified, list_block)."""
    lst = _find_list(doc, name)
    if lst is None:
        return None
    doc["lists"].remove(lst)
    return lst


def _serialize_one_list(lst):
    return serialize({"preamble": [], "lists": [lst]})


def list_archive(data):
    name = data.get("list", "")
    doc = _load()
    if doc is None:
        return None
    lst = _extract_list_block(doc, name)
    if lst is None:
        return None
    ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)
    fname = _slugify(name)
    target = ARCHIVE_DIR / f"{fname}.md"
    n = 2
    while target.exists():
        target = ARCHIVE_DIR / f"{fname}-{n}.md"
        n += 1
    _atomic_write(target, _serialize_one_list(lst))
    _save(doc)
    return {"ok": True, "file": target.name}


def _reset_progress(lst):
    for g in lst["groups"]:
        for it in g["items"]:
            it["lines"][0] = re.sub(r"^- \[[ xX]\]", "- [ ]", it["lines"][0], count=1)
            _set_subbullet(it, "Status", "unread")
            it["readState"] = "unread"
            it["checked"] = False
            # a restarted list starts outside the read-next queue
            _set_subbullet(it, "Queue", None)
            it["queue"] = None


def list_restart(data):
    """Reactivate an archived list with all progress reset to unread — leaving the
    archived copy intact so the syllabus can be restarted again any time."""
    name = data.get("list", "")
    fname = data.get("file")
    src = None
    if fname:
        p = ARCHIVE_DIR / Path(fname).name
        src = parse_doc(read_text(p) or "")
    if src is None:
        return None
    lst = _find_list(src, name) or (src["lists"][0] if src["lists"] else None)
    if lst is None:
        return None
    _reset_progress(lst)
    # re-stamp the date so the reactivated run reads as fresh
    base = DATE_SUFFIX.sub("", lst["name"]).strip()
    lst["name"] = f"{base} — {_today()}"
    lst["heading"] = f"## {lst['name']}"
    lst["date"] = _today()
    doc = _load() or {"preamble": [], "lists": []}
    doc["lists"].insert(0, lst)
    _save(doc)
    return {"ok": True, "name": lst["name"]}


def list_delete(data):
    name = data.get("list", "")
    if data.get("archived") and data.get("file"):
        p = ARCHIVE_DIR / Path(data["file"]).name
        try:
            if p.exists() and p.resolve().is_relative_to(ARCHIVE_DIR.resolve()):
                p.unlink()
                return {"ok": True}
        except (OSError, ValueError):
            return None
        return None
    doc = _load()
    if doc is None:
        return None
    if _extract_list_block(doc, name) is None:
        return None
    _save(doc)
    return {"ok": True}


# ----------------------------------------------------------------- read views
def _list_json(lst, archived=False, file=None):
    groups = []
    read = total = need = 0
    for g in lst["groups"]:
        items = []
        for it in g["items"]:
            itj = {k: it[k] for k in
                   ("title", "checked", "readState", "status", "citationName",
                    "citationPath", "pdfPath", "pdfMissing", "why", "read", "needsDownload", "doi",
                    "due", "queue")}
            itj["type"] = _resolved_type(it)
            itj["typeResolved"] = _type_resolved(it)
            itj["heldManual"] = it.get("heldManual", False)
            itj["retracted"] = it.get("retracted", False)
            itj["source"] = it.get("source")
            if it["pdfMissing"]:
                itj["pdfPath"] = None
            items.append(itj)
            total += 1
            if it["readState"] == "read" or it["checked"]:
                read += 1
            if it["needsDownload"]:
                need += 1
        groups.append({"name": g["name"], "level": g["level"], "note": g.get("note"),
                       "prose": g["prose"], "items": items})
    return {"name": lst["name"], "date": lst.get("date"), "note": lst.get("note"),
            "archived": archived, "file": file, "groups": groups,
            "read": read, "total": total, "needsDownload": need}


def active_lists():
    text = read_text(READING_LIST)
    if not text:
        return []
    doc = parse_doc(text)
    return [_list_json(l) for l in doc["lists"]]


def downloads():
    out = []
    for kind, p in _sources():
        text = read_text(p)
        if not text:
            continue
        file = p.name if kind == "archived" else None
        for L in parse_doc(text)["lists"]:
            lst = _list_json(L, archived=kind == "archived", file=file)
            for gi, g in enumerate(lst["groups"]):
                for ii, it in enumerate(g["items"]):
                    if it["needsDownload"]:
                        out.append({"list": lst["name"], "group": gi, "groupName": g["name"],
                                    "item": ii, "title": it["title"], "why": it["why"],
                                    "read": it["read"], "citationName": it["citationName"],
                                    "pdfMissing": it["pdfMissing"], "type": _resolved_type(it),
                                    "typeResolved": it.get("typeResolved", False),
                                    "doi": it.get("doi"), "heldManual": it.get("heldManual", False),
                                    "source": it.get("source"), "where": kind, "file": file})
    return out


def archive_index(q=None):
    """Lightweight index of archived lists, optionally filtered by a search needle that
    matches list name, group names, or item titles."""
    if not ARCHIVE_DIR.is_dir():
        return []
    needle = (q or "").lower().strip()
    out = []
    for f in sorted(ARCHIVE_DIR.iterdir()):
        if not (f.is_file() and f.suffix == ".md"):
            continue
        doc = parse_doc(read_text(f) or "")
        for lst in doc["lists"]:
            j = _list_json(lst, archived=True, file=f.name)
            if needle:
                hay = " ".join([j["name"]] + [g["name"] for g in j["groups"]] +
                               [it["title"] for g in j["groups"] for it in g["items"]]).lower()
                if needle not in hay:
                    continue
            # drop full item payload from the index; keep group names + counts
            out.append({"name": j["name"], "date": j["date"], "note": j["note"],
                        "file": j["file"], "groupNames": [g["name"] for g in j["groups"] if g["name"]],
                        "read": j["read"], "total": j["total"], "needsDownload": j["needsDownload"]})
    return out


# ----------------------------------------------------------------- dispatch
def make_citation(data):
    import litcite
    doc, it = _locate(data.get("list"), data.get("title"), data.get("citation"))
    if doc is None:
        return {"ok": False, "error": "no reading lists"}
    if it is None:
        return {"ok": False, "error": "item not found"}
    if it.get("citationPath"):
        return {"ok": True, "created": False, "path": it["citationPath"],
                "name": it.get("citationName")}
    res = litcite.from_reading_item(it["title"], it.get("doi"), it.get("pdfPath"))
    if not res.get("cited"):
        return {"ok": False, "error": "could not build citation fields"}
    stem, path = res["stem"], res["notePath"]
    _set_subbullet(it, "Citation", f"[[{path}|{stem}]]")
    _save(doc)
    return {"ok": True, "created": bool(res.get("noteWritten")), "path": path,
            "name": stem, "citekey": res.get("citekey"),
            "metadataFrom": res.get("metadataFrom")}


_OPS = {
    "toggle": toggle,
    "item/edit": item_edit,
    "item/download": item_download,
    "item/requeue": item_requeue,
    "item/add": item_add,
    "item/delete": item_delete,
    "item/move": item_move,
    "group/reorder": group_reorder,
    "group/add": group_add,
    "group/rename": group_rename,
    "group/note": group_note,
    "group/delete": group_delete,
    "list/note": list_note,
    "list/create": list_create,
    "list/rename": list_rename,
    "list/archive": list_archive,
    "list/restart": list_restart,
    "list/delete": list_delete,
    "item/make-citation": make_citation,
    "item/next": lambda d: item_next(d),
    "next/reorder": lambda d: next_reorder(d),
    "item/due": lambda d: item_due(d),
    "group/due": lambda d: group_due(d),
    "queue/add": lambda d: queue_add(d),
    "list/to-queue": lambda d: list_to_queue(d),
    "queue/to-list": lambda d: queue_to_list(d),
    # legacy alias used by the old /reading/add route
    "add": lambda d: item_add({"list": d.get("list"), "group": None, "title": d.get("title"),
                               "citationPath": d.get("path"), "pdfPath": None,
                               "needsDownload": False}),
}


def handle(op, data):
    fn = _OPS.get(op)
    if fn is None:
        return None
    try:
        with locked(timeout=20):
            return fn(data or {})
    except LockBusy:
        return {"ok": False, "error": "reading lists are busy — try again"}


def _match_item(doc, list_name, title=None, citation=None):
    lst = _find_list(doc, list_name) if list_name else None
    lists = [lst] if lst else doc["lists"]
    t = _fold(title)
    c = _fold(citation)
    for L in lists:
        if L is None:
            continue
        for g in L["groups"]:
            for it in g["items"]:
                if c and _fold(it.get("citationName")) == c:
                    return it
                if t and _fold(it["title"]) == t:
                    return it
    # looser contains pass on title
    if t:
        for L in lists:
            if L is None:
                continue
            for g in L["groups"]:
                for it in g["items"]:
                    if t in _fold(it["title"]):
                        return it
    return None


def _match_exact(lists, t, c):
    for L in lists:
        for g in L["groups"]:
            for it in g["items"]:
                if c and _fold(it.get("citationName")) == c:
                    return it
                if t and _fold(it["title"]) == t:
                    return it
    return None


def _match_loose(lists, t):
    if not t:
        return None
    for L in lists:
        for g in L["groups"]:
            for it in g["items"]:
                if t in _fold(it["title"]):
                    return it
    return None


def _locate(list_name, title=None, citation=None):
    srcs = _sources()
    cache = {}

    def doc_at(i):
        if i not in cache:
            kind, p = srcs[i]
            cache[i] = _load_path(p, kind)
        return cache[i]

    t, c = _fold(title), _fold(citation)
    if list_name:
        target = DATE_SUFFIX.sub("", list_name).strip()
        for exact in (True, False):
            for i in range(len(srcs)):
                d = doc_at(i)
                if d is None:
                    continue
                for L in d["lists"]:
                    hit = (L["name"] == list_name) if exact else \
                          (DATE_SUFFIX.sub("", L["name"]).strip() == target)
                    if hit:
                        return d, (_match_exact([L], t, c) or _match_loose([L], t))
    docs = [d for d in (doc_at(i) for i in range(len(srcs))) if d is not None]
    if not docs:
        return None, None
    for d in docs:
        it = _match_exact(d["lists"], t, c)
        if it is not None:
            return d, it
    for d in docs:
        it = _match_loose(d["lists"], t)
        if it is not None:
            return d, it
    return docs[0], None


def _each_item(archives=True):
    """Yield (kind, path, doc, list, group_index, group, item_index, item) over every
    list file. Parses each file once."""
    for kind, p in _sources(archives):
        d = _load_path(p, kind)
        if d is None:
            continue
        for L in d["lists"]:
            for gi, g in enumerate(L["groups"]):
                for ii, it in enumerate(g["items"]):
                    yield kind, p, d, L, gi, g, ii, it


def linked_items(names):
    """Readings (in any list file) whose PDF link targets one of these file names —
    the set whose links follow a file from the Inbox into Corpus."""
    names = {n for n in names if n}
    out = []
    for kind, p, _d, L, _gi, _g, _ii, it in _each_item():
        pp = it.get("pdfPath") or ""
        if pp and os.path.basename(pp) in names:
            out.append({"list": L["name"], "where": kind,
                        "file": p.name if kind == "archived" else None, "title": it["title"]})
    return out


def repoint_pdf(names, corpus_rel, casefold=False):
    """Re-point every reading, in every list file, whose PDF link is one of `names`
    (a file moving Inbox -> Corpus) to `corpus_rel` and mark it `Download: have`.
    Takes the lock. Returns [{list, title}] for the items touched."""
    want = {(n.lower() if casefold else n) for n in names if n}
    hits = []
    with locked():
        for kind, p in _sources():
            d = _load_path(p, kind)
            if d is None:
                continue
            touched = False
            for L in d["lists"]:
                for g in L["groups"]:
                    for it in g["items"]:
                        base = os.path.basename(it.get("pdfPath") or "")
                        if base and (base.lower() if casefold else base) in want:
                            _set_subbullet(it, "PDF", f"[[{corpus_rel}|Open PDF]]")
                            _set_subbullet(it, "Download", "have")
                            hits.append({"list": L["name"], "title": it["title"]})
                            touched = True
            if touched:
                _save(d)
    return hits


# ----------------------------------------------------------------- the standalone queue
_DOI_RE = re.compile(r"^10\.\d{4,9}/\S+$")


def _norm_doi(s):
    """A bare lower-case DOI from a DOI, doi: form or doi.org URL; None when it is not one."""
    s = (s or "").strip()
    s = re.sub(r"^(?:https?://)?(?:dx\.)?doi\.org/", "", s, flags=re.I)
    s = re.sub(r"^doi:\s*", "", s, flags=re.I).strip().rstrip(".,;")
    return s.lower() if _DOI_RE.match(s) else None


def _one_line(s, cap):
    """Collapse whitespace (a newline in a title would start a new markdown line —
    a forged `## ` heading or sub-bullet) and cap the length."""
    return " ".join(str(s or "").split())[:cap]


def _clean_source(s):
    s = _one_line(s, 120).lstrip("#").strip()
    return s or QUEUE_DEFAULT_SOURCE


_CR_KIND = {"article": "article", "book": "book", "chapter": "book"}


def _doi_meta(doi):
    """(title, type) for a DOI from Crossref, titled the vault way — "Surname (Year) -
    Title". None on any failure; the caller falls back to the DOI itself."""
    try:
        import urllib.parse
        import litcite
        item = litcite._get_json("https://api.crossref.org/works/"
                                 + urllib.parse.quote(doi, safe="/"), timeout=10)
        rec = litcite._from_crossref(item.get("message") or {})
    except Exception:
        return None
    title = _one_line(re.sub(r"<[^>]+>", "", rec.get("title") or ""), 300)
    if not title:
        return None
    sur = [a.split(",")[0].strip() for a in rec.get("authors") or [] if a.strip()]
    lead = ("Unknown" if not sur else sur[0] if len(sur) == 1
            else f"{sur[0]} and {sur[1]}" if len(sur) == 2 else f"{sur[0]} et al.")
    return f"{lead} ({rec.get('year') or 'n.d.'}) - {title}", _CR_KIND.get(rec.get("type"), "other")


def find_duplicate(doi=None, title=None):
    """The reading already carrying this DOI (or, with no DOI, this exact title) in
    the queue, an active list or an archived list — else None."""
    d = _norm_doi(doi) if doi else None
    t = _fold(title) if title else ""
    for kind, p, _doc, L, _gi, _g, _ii, it in _each_item():
        hit = (d and _norm_doi(it.get("doi")) == d) or (not d and t and _fold(it["title"]) == t)
        if hit:
            return {"where": kind, "list": L["name"],
                    "file": p.name if kind == "archived" else None,
                    "title": it["title"], "needsDownload": it["needsDownload"]}
    return None


def _new_queue_doc():
    return {"preamble": [QUEUE_TITLE, ""], "lists": [], "_path": DOWNLOAD_QUEUE, "_kind": "queue"}


def _queue_source(doc, name):
    for L in doc["lists"]:
        if L["name"] == name:
            return L
    L = {"heading": f"## {name}", "name": name, "date": None, "preamble": [""],
         "note": None, "groups": []}
    doc["lists"].append(L)
    return L


def queue_add(data):
    data = data or {}
    title = _one_line(data.get("title"), 400)
    raw_doi = _one_line(data.get("doi"), 200)
    doi = _norm_doi(raw_doi) if raw_doi else None
    if raw_doi and not doi:
        return {"ok": False, "error": "not a DOI"}
    if not doi and title and _norm_doi(title):
        doi, title = _norm_doi(title), ""
    if not doi and not title:
        return {"ok": False, "error": "need a DOI or a title"}
    why = _one_line(data.get("why"), 400)
    source = _clean_source(data.get("source"))
    typ = (data.get("type") or "").strip().lower()
    typ = typ if typ in ("article", "book", "other") else None
    with locked():
        dup = find_duplicate(doi, title)
        if dup:
            return {"ok": True, "added": False, "duplicate": dup}
        if doi and not title:
            meta = _doi_meta(doi) if data.get("lookup", True) else None
            if meta:
                title, typ = meta[0], typ or meta[1]
            else:
                title = f"DOI {doi}"
        doc = _load_path(DOWNLOAD_QUEUE, "queue") or _new_queue_doc()
        L = _queue_source(doc, source)
        g = next((x for x in L["groups"] if not x["prose"]), None)
        if g is None:
            g = {"heading": "### Queued", "level": 3, "name": "Queued", "lead": [],
                 "items": [], "trail": [], "prose": False, "note": None}
            L["groups"].append(g)
        lines = _new_item_lines(title, why=why or None, needs_download=True, doi=doi)
        if typ:
            lines.insert(next(i for i, ln in enumerate(lines) if "- Download:" in ln),
                         f"  - Type: {typ}")
        it = _parse_item(lines)
        it["lines"] = lines
        g["items"].append(it)
        _save(doc)
    return {"ok": True, "added": True, "source": source, "title": title, "doi": doi}


def queue_sources():
    doc = _load_path(DOWNLOAD_QUEUE, "queue")
    if doc is None:
        return []
    out = []
    for L in doc["lists"]:
        j = _list_json(L)
        out.append({"name": j["name"], "note": j["note"], "total": j["total"],
                    "needsDownload": j["needsDownload"]})
    return out


def list_to_queue(data):
    name = (data or {}).get("list", "")
    with locked():
        doc = _load()
        if doc is None:
            return None
        lst = _find_list(doc, name)
        if lst is None:
            return None
        q = _load_path(DOWNLOAD_QUEUE, "queue") or _new_queue_doc()
        if any(L["name"] == lst["name"] for L in q["lists"]):
            return {"ok": False, "error": "the download queue already has a source with that name"}
        q["lists"].append(lst)
        _save(q)
        doc["lists"].remove(lst)
        _save(doc)
    j = _list_json(lst)
    return {"ok": True, "source": lst["name"], "total": j["total"], "needsDownload": j["needsDownload"]}


def queue_to_list(data):
    name = (data or {}).get("list", "") or (data or {}).get("source", "")
    with locked():
        q = _load_path(DOWNLOAD_QUEUE, "queue")
        if q is None:
            return None
        src = next((L for L in q["lists"] if L["name"] == name), None)
        if src is None:
            return None
        doc = _load() or {"preamble": [], "lists": [], "_path": READING_LIST}
        if any(L["name"] == src["name"] for L in doc["lists"]):
            return {"ok": False, "error": "a reading list with that name already exists"}
        doc["lists"].insert(0, src)
        _save(doc)
        q["lists"].remove(src)
        _save(q)
    return {"ok": True, "name": src["name"]}


def set_pdf(list_name, pdf_path, title=None, citation=None):
    """Attach a downloaded PDF to a queued reading and clear its needs-download flag.
    The reading view's not-downloaded sign clears automatically (it keys off the PDF)."""
    doc, it = _locate(list_name, title, citation)
    if doc is None:
        return {"ok": False, "error": "no reading lists"}
    if it is None:
        return {"ok": False, "error": "item not found"}
    if _retracted(it):
        return _RETRACTED_ERR
    same = [it]
    home = next((L for L in doc["lists"] for g in L["groups"] if any(x is it for x in g["items"])), None)
    if home is not None:
        key_t, key_c = _fold(it["title"]), _fold(it.get("citationName"))
        same += [x for g in home["groups"] for x in g["items"]
                 if x is not it and not _retracted(x) and (x["needsDownload"] or x["pdfMissing"])
                 and (_fold(x["title"]) == key_t or (key_c and _fold(x.get("citationName")) == key_c))]
    for x in same:
        _set_subbullet(x, "PDF", f"[[{pdf_path}|Open PDF]]")
        _set_subbullet(x, "Download", "have")
    _save(doc)
    return {"ok": True, "title": it["title"], "attached": len(same)}


def set_type(list_name, type_, title=None, citation=None):
    t = (type_ or "").strip().lower()
    if t not in ("article", "book", "other"):
        return {"ok": False, "error": "type must be article|book|other"}
    doc, it = _locate(list_name, title, citation)
    if doc is None:
        return {"ok": False, "error": "no reading lists"}
    if it is None:
        return {"ok": False, "error": "item not found"}
    if _retracted(it):
        return _RETRACTED_ERR
    _set_subbullet(it, "Type", t)
    _save(doc)
    return {"ok": True, "title": it["title"], "type": t}


def set_source(list_name, source, title=None, citation=None, unset=False):
    doc, it = _locate(list_name, title, citation)
    if doc is None:
        return {"ok": False, "error": "no reading lists"}
    if it is None:
        return {"ok": False, "error": "item not found"}
    if _retracted(it):
        return _RETRACTED_ERR
    _set_subbullet(it, "Source", "" if unset else (source or "").strip())
    _save(doc)
    return {"ok": True, "title": it["title"], "source": None if unset else source}


def set_doi(list_name, doi, title=None, citation=None):
    d = (doi or "").strip()
    if not d:
        return {"ok": False, "error": "empty doi"}
    doc, it = _locate(list_name, title, citation)
    if doc is None:
        return {"ok": False, "error": "no reading lists"}
    if it is None:
        return {"ok": False, "error": "item not found"}
    if _retracted(it):
        return _RETRACTED_ERR
    _set_subbullet(it, "DOI", d)
    _save(doc)
    return {"ok": True, "title": it["title"], "doi": d}


def flag_manual(list_name, title=None, citation=None, unflag=False):
    doc, it = _locate(list_name, title, citation)
    if doc is None:
        return {"ok": False, "error": "no reading lists"}
    if it is None:
        return {"ok": False, "error": "item not found"}
    if _retracted(it):
        return _RETRACTED_ERR
    _set_subbullet(it, "Download", "needed" if unflag else "manual")
    _save(doc)
    return {"ok": True, "title": it["title"], "heldManual": not unflag}


_RETRACTED_WHY = "RETRACTED — "
_RETRACTED_ERR = {"ok": False, "error": "item is retracted; use requeue first"}


def _retracted(it):
    for ln in it["lines"][1:]:
        sub = SUB_RE.match(ln)
        if sub and sub.group(2) == "Download":
            return sub.group(3).strip().lower() == "retracted"
    return False


def retract(list_name, title=None, citation=None, why=None):
    doc, it = _locate(list_name, title, citation)
    if doc is None:
        return {"ok": False, "error": "no reading lists"}
    if it is None:
        return {"ok": False, "error": "item not found"}
    _set_subbullet(it, "Download", "retracted")
    if why:
        note = f"RETRACTED — {why.strip()}"
        prev = it.get("why")
        _set_subbullet(it, "Why", f"{note} · {prev}" if prev else note)
    _save(doc)
    return {"ok": True, "title": it["title"], "retracted": True}


def retitle(list_name, title=None, citation=None, new_title=None):
    """Correct a reading's title in place, keeping its sub-bullets and read state.
    The Citation link's alias follows the new title; its path does not move."""
    new = (new_title or "").strip()
    if not new:
        return {"ok": False, "error": "empty new title"}
    doc, it = _locate(list_name, title, citation)
    if doc is None:
        return {"ok": False, "error": "no reading lists"}
    if it is None:
        return {"ok": False, "error": "item not found"}
    safe = new.replace("|", " ").replace("]", ")").replace("[", "(").strip()
    lines = it["lines"]
    m = ITEM_RE.match(lines[0])
    box = "x" if (m and m.group(1).lower() == "x") else " "
    lines[0] = f"- [{box}] **{safe}**"
    indent = _detect_indent(lines)
    for i in range(1, len(lines)):
        sub = SUB_RE.match(lines[i])
        if sub and sub.group(2) == "Citation":
            lk = WIKILINK_RE.search(sub.group(3))
            if lk:
                lines[i] = f"{indent}- Citation: [[{lk.group(1).strip()}|{safe}]]"
            break
    it["title"] = _clean_title(f"**{safe}**")
    _save(doc)
    return {"ok": True, "title": safe}


def clear_doi(list_name, title=None, citation=None):
    doc, it = _locate(list_name, title, citation)
    if doc is None:
        return {"ok": False, "error": "no reading lists"}
    if it is None:
        return {"ok": False, "error": "item not found"}
    _set_subbullet(it, "DOI", None)
    _save(doc)
    return {"ok": True, "title": it["title"]}


_OWNED_WHY = "OWNED — "


def own(list_name, title=None, citation=None, why=None):
    doc, it = _locate(list_name, title, citation)
    if doc is None:
        return {"ok": False, "error": "no reading lists"}
    if it is None:
        return {"ok": False, "error": "item not found"}
    doi = (it.get("doi") or "").strip().lower() or None
    src = _fold(it.get("source")) or None
    me = _fold(it["title"])
    note = _OWNED_WHY + ((why or "").strip() or "physical copy; not downloaded")
    marked = []
    for kind, p in _sources():
        d = _load_path(p, kind)
        if d is None:
            continue
        hit = False
        for L in d["lists"]:
            for g in L["groups"]:
                for x in g["items"]:
                    same = (_fold(x["title"]) == me
                            or (doi and (x.get("doi") or "").strip().lower() == doi)
                            or (src and _fold(x.get("source")) == src))
                    if not same or _retracted(x) or x.get("download") == "owned":
                        continue
                    _set_subbullet(x, "Download", "owned")
                    prev = x.get("why")
                    if not (prev or "").startswith(_OWNED_WHY):
                        _set_subbullet(x, "Why", f"{note} · {prev}" if prev else note)
                    marked.append(x["title"])
                    hit = True
        if hit:
            _save(d)
    return {"ok": True, "title": it["title"], "owned": marked}


def _requeue_item(it):
    _set_subbullet(it, "Download", "needed")
    w = it.get("why") or ""
    for prefix in (_RETRACTED_WHY, _OWNED_WHY):
        if not w.startswith(prefix):
            continue
        rest = w[len(prefix):].split(" · ", 1)
        _set_subbullet(it, "Why", rest[1] if len(rest) > 1 else None)


def requeue(list_name, title=None, citation=None):
    doc, it = _locate(list_name, title, citation)
    if doc is None:
        return {"ok": False, "error": "no reading lists"}
    if it is None:
        return {"ok": False, "error": "item not found"}
    _requeue_item(it)
    _save(doc)
    return {"ok": True, "title": it["title"]}


def _is_read(it):
    return it.get("readState") == "read" or bool(it.get("checked"))


def item_key(list_name, title, read=None):
    return f"{_slugify(list_name)}|{title or ''}|{(read or '').strip()}"


def _keyed_items(doc):
    """[(key, list, group_index, group, item_index, item)] for every item, file order."""
    seen, out = {}, []
    for L in doc["lists"]:
        for gi, g in enumerate(L["groups"]):
            for ii, it in enumerate(g["items"]):
                k = item_key(L["name"], it["title"], it.get("read"))
                seen[k] = seen.get(k, 0) + 1
                out.append((k if seen[k] == 1 else f"{k}#{seen[k]}", L, gi, g, ii, it))
    return out


def _queue_order(doc):
    """The queued, not-read items in queue order; ties and gaps settle by file order."""
    q = [(it["queue"], n, it) for n, (_k, _L, _gi, _g, _ii, it) in enumerate(_keyed_items(doc))
         if it.get("queue") is not None and not _is_read(it)]
    return [it for _q, _n, it in sorted(q, key=lambda x: (x[0], x[1]))]


def _write_queue(doc, order):
    """Make `order` the whole queue: number it 1..n and drop the field everywhere else.
    A line is rewritten only when its number changes. An unparseable `Queue:` value on
    an item outside `order` is left in the file as it is."""
    keep = {id(it) for it in order}
    for _k, _L, _gi, _g, _ii, it in _keyed_items(doc):
        if it.get("queue") is not None and id(it) not in keep:
            _set_subbullet(it, "Queue", None)
            it["queue"] = None
    for n, it in enumerate(order, 1):
        if it.get("queue") != n:
            _set_subbullet(it, "Queue", str(n))
            it["queue"] = n


def _normalize_queue(doc):
    _write_queue(doc, _queue_order(doc))


def _resolve_keyed(doc, data):
    """An item by `key`, else by the usual (list, group, item) or citationPath."""
    key = (data or {}).get("key")
    if key:
        return next((it for k, *_rest, it in _keyed_items(doc) if k == key), None)
    try:
        return _resolve_item(doc, data)
    except (TypeError, ValueError):
        return None


def _key_of(doc, item):
    return next((k for k, *_rest, it in _keyed_items(doc) if it is item), None)


def item_next(data):
    if ((data.get("where") or "active") != "active"):
        return {"ok": False, "error": "the read-next queue holds active-list readings only"}
    on, pos = data.get("on"), data.get("position")
    if not isinstance(on, bool):
        return {"ok": False, "error": "on must be true or false"}
    if pos is not None and (isinstance(pos, bool) or not isinstance(pos, int) or pos < 1):
        return {"ok": False, "error": "position must be an integer from 1"}
    doc = _load()
    if doc is None:
        return None
    item = _resolve_keyed(doc, data)
    if item is None:
        return None
    order = _queue_order(doc)
    if on:
        if _is_read(item):
            return {"ok": False, "error": "item is read; mark it unread first"}
        queued = any(x is item for x in order)
        if pos is not None or not queued:
            order = [x for x in order if x is not item]
            order.insert(len(order) if pos is None else min(pos - 1, len(order)), item)
    else:
        order = [x for x in order if x is not item]
    _write_queue(doc, order)
    _save(doc)
    return {"ok": True, "key": _key_of(doc, item), "queue": item.get("queue"), "length": len(order)}


def next_reorder(data):
    """Reorder the read-next queue. `order` is a list of item keys: they go first, in
    that order; queued items it leaves out follow in their current order. A key that
    is not a queued item fails the whole call."""
    order = data.get("order")
    if not isinstance(order, list) or not all(isinstance(k, str) for k in order):
        return {"ok": False, "error": "order must be a list of item keys"}
    if len(set(order)) != len(order):
        return {"ok": False, "error": "order repeats a key"}
    doc = _load()
    if doc is None:
        return None
    cur = _queue_order(doc)
    by_key = {k: it for k, *_rest, it in _keyed_items(doc) if any(x is it for x in cur)}
    unknown = [k for k in order if k not in by_key]
    if unknown:
        return {"ok": False, "error": "not in the read-next queue", "unknown": unknown}
    first = [by_key[k] for k in order]
    new = first + [x for x in cur if not any(x is f for f in first)]
    _write_queue(doc, new)
    _save(doc)
    return {"ok": True, "order": [_key_of(doc, x) for x in new]}


def _due_arg(data):
    """(ok, date-or-None) from a payload's `date`: null or "" clears."""
    d = data.get("date")
    if d is None or d == "":
        return True, None
    v = _valid_date(d)
    return (v is not None), v


def item_due(data):
    """Set or clear one reading's read-by date. `date`: "YYYY-MM-DD" or null."""
    ok, date = _due_arg(data)
    if not ok:
        return {"ok": False, "error": "date must be YYYY-MM-DD or null"}
    doc = _load_for(data)
    if doc is None:
        return None
    item = _resolve_keyed(doc, data)
    if item is None:
        return None
    _set_subbullet(item, "Due", date)
    item["due"] = date
    _save(doc)
    return {"ok": True, "due": date}


def group_due(data):
    """Stamp (or clear) the read-by date on every item of one group. {list, group, date}."""
    ok, date = _due_arg(data)
    if not ok:
        return {"ok": False, "error": "date must be YYYY-MM-DD or null"}
    doc = _load_for(data)
    if doc is None:
        return None
    lst = _find_list(doc, data.get("list", ""))
    try:
        g = _group(lst, int(data.get("group", -1)))
    except (TypeError, ValueError):
        return None
    if g is None or g["prose"]:
        return None
    for it in g["items"]:
        _set_subbullet(it, "Due", date)
        it["due"] = date
    _save(doc)
    return {"ok": True, "due": date, "stamped": len(g["items"])}


def _download_state(it):
    dl = it.get("download")
    if dl in ("owned", "retracted"):
        return dl
    if it.get("heldManual"):
        return "manual"
    return "needed" if it.get("needsDownload") else "have"


def next_up(today=None):
    if isinstance(today, str):
        today = datetime.date.fromisoformat(today)
    today = today or datetime.date.today()
    out = {"queue": [], "readBy": [], "behind": 0}
    doc = _load()
    if doc is None:
        return out
    keyed = _keyed_items(doc)
    rank = {id(it): n for n, it in enumerate(_queue_order(doc), 1)}

    def shape(k, L, g, it):
        pp = it.get("pdfPath")
        return {"key": k, "list": L["name"], "group": g["name"], "title": it["title"],
                "read": it.get("read"), "due": it.get("due"), "queue": rank.get(id(it)),
                "pdf": pp if pp and not it.get("pdfMissing") else None,
                "citation": it.get("citationPath"), "download": _download_state(it),
                "status": it.get("readState")}

    shaped = [(it, shape(k, L, g, it)) for k, L, _gi, g, _ii, it in keyed if not _is_read(it)]
    out["queue"] = sorted((s for it, s in shaped if s["queue"]), key=lambda s: s["queue"])
    by_date = {}
    for it, s in shaped:
        if s["due"]:
            by_date.setdefault(s["due"], []).append(s)
    for d in sorted(by_date):
        left = (datetime.date.fromisoformat(d) - today).days
        out["readBy"].append({"date": d, "daysLeft": left, "items": by_date[d]})
        if left < 0:
            out["behind"] += len(by_date[d])
    return out


_MONTH_NUM = {m: n for n, m in enumerate(
    ("jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"), 1)}
# A session date at the start of a group heading or of a dash-separated part of it:
# "Oct 21 (Wed) — ...", "Nov 6 — ...", "Week 5 — Oct 19 — ...".
_SESSION_DATE_RE = re.compile(
    r"(?:^|[—–-]\s+)(?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?\s+)?"
    r"(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|"
    r"sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?!\d)", re.I)


def _session_date(group_name, list_date):
    """The session date in a group heading as YYYY-MM-DD, or None. The year comes from
    the list's creation date by academic year: Sep-Dec take that year, Jan-Aug the next."""
    m = _SESSION_DATE_RE.search(group_name or "")
    if not m or not _valid_date(list_date):
        return None
    month = _MONTH_NUM[m.group(1)[:3].lower()]
    year = int(list_date[:4]) + (0 if month >= 9 else 1)
    return _valid_date(f"{year:04d}-{month:02d}-{int(m.group(2)):02d}")


def stamp_session_dates(apply=False):
    """One-time migration: give the items of every dated session group a `Due:`. An
    item that already has a valid read-by date keeps it. Dry unless `apply`."""
    doc = _load()
    if doc is None:
        return {"ok": False, "error": "no reading lists"}
    groups, total = [], 0
    for L in doc["lists"]:
        for gi, g in enumerate(L["groups"]):
            date = None if g["prose"] else _session_date(g["name"], L.get("date"))
            if not date or not g["items"]:
                continue
            todo = [it for it in g["items"] if not it.get("due")]
            groups.append({"list": L["name"], "group": gi, "name": g["name"], "date": date,
                           "items": len(g["items"]), "stamp": len(todo),
                           "kept": len(g["items"]) - len(todo)})
            total += len(todo)
            if apply:
                for it in todo:
                    _set_subbullet(it, "Due", date)
                    it["due"] = date
    if apply and total:
        _save(doc)
    return {"ok": True, "applied": bool(apply), "stamped": total, "groups": groups}


def _cli_target(a):
    """The op payload addressing one item from CLI flags: --key, or --list with
    --group and --item, or --list with --title (and --read when the title repeats)."""
    if a.key:
        return {"key": a.key}, None
    if a.list and a.group is not None and a.item is not None:
        return {"list": a.list, "group": a.group, "item": a.item}, None
    if not a.title:
        return None, "give --key, or --list with --group and --item, or --title"
    doc = _load()
    if doc is None:
        return None, "no reading lists"
    home = _find_list(doc, a.list) if a.list else None
    t, r = _fold(a.title), _fold(a.read)
    hits = [k for k, L, _gi, _g, _ii, it in _keyed_items(doc)
            if (home is None or L is home) and _fold(it["title"]) == t
            and (not a.read or _fold(it.get("read")) == r)]
    if len(hits) == 1:
        return {"key": hits[0]}, None
    return None, ("item not found" if not hits else "several items match; use one --key: " + " ; ".join(hits))


GROUP_INDEX_HELP = (
    "Group indices are flat and 0-based: every `### ` and `#### ` heading of the list "
    "counts once, in file order, so a `#### ` subgroup has its own index right after "
    "its parent `### ` (and that parent's earlier subgroups). `lists --indexed` prints "
    "them; `new-group` answers the new group's index. Omitting --group adds to the "
    "list's first group.")


def _cli():
    import sys, json, argparse
    p = argparse.ArgumentParser(prog="reading.py", description="reading-list ops")
    sub = p.add_subparsers(dest="cmd")
    sub.add_parser("downloads", help="print the needs-download queue (JSON)")
    ls_ = sub.add_parser("lists", help="print active lists + group names (JSON)")
    ls_.add_argument("--indexed", action="store_true",
                     help="print every group as {group, level, name, items} with its --group index")
    sp = sub.add_parser("set-pdf", help="attach a downloaded PDF to a queued reading")
    sp.add_argument("--list", default=""); sp.add_argument("--title", default="")
    sp.add_argument("--citation", default=""); sp.add_argument("--pdf", required=True)
    sa = sub.add_parser("add", help="add a reading (defaults to needs-download)")
    sa.add_argument("--list", required=True)
    sa.add_argument("--group", type=int, default=None, help=GROUP_INDEX_HELP)
    sa.add_argument("--title", required=True); sa.add_argument("--why", default="")
    sa.add_argument("--read", default=""); sa.add_argument("--pdf", default="")
    sa.add_argument("--doi", default="", help="DOI (so the Board download can resolve it)")
    sa.add_argument("--have", action="store_true", help="already downloaded (not a grab)")
    nl = sub.add_parser("new-list", help="create a reading list (returns its dated name)")
    nl.add_argument("--name", required=True); nl.add_argument("--note", default="")
    ng = sub.add_parser("new-group", help="add a group (sublist) to a list; prints its --group index",
                        description="Add a `### ` group, or with --sub/--parent a `#### ` subgroup "
                                    "(e.g. \"Deepen — <topic>\") nested under a `### ` group. "
                                    + GROUP_INDEX_HELP)
    ng.add_argument("--list", required=True); ng.add_argument("--name", required=True); ng.add_argument("--note", default="")
    ng.add_argument("--sub", action="store_true",
                    help="make a `#### ` subgroup at the end of the list (under its final `### ` group)")
    ng.add_argument("--parent", type=int, default=None,
                    help="flat index of the `### ` group to nest the `#### ` subgroup under "
                         "(implies --sub; it lands after that group's existing subgroups)")
    st = sub.add_parser("set-type", help="set a reading's type (article|book|other)")
    st.add_argument("--list", default=""); st.add_argument("--title", default="")
    st.add_argument("--citation", default=""); st.add_argument("--type", required=True)
    sd = sub.add_parser("set-doi", help="attach a VERIFIED DOI to a reading")
    sd.add_argument("--list", default=""); sd.add_argument("--title", default="")
    sd.add_argument("--citation", default=""); sd.add_argument("--doi", required=True)
    fm = sub.add_parser("flag-manual", help="flag a reading 'Library proxy-only, needs the user'")
    fm.add_argument("--list", default=""); fm.add_argument("--title", default="")
    fm.add_argument("--citation", default=""); fm.add_argument("--unflag", action="store_true")
    ss = sub.add_parser("set-source", help="name the WORK to download for a chapter-range reading")
    ss.add_argument("--list", default=""); ss.add_argument("--title", default="")
    ss.add_argument("--citation", default=""); ss.add_argument("--source", default="")
    ss.add_argument("--unset", action="store_true")
    rt = sub.add_parser("retract", help="take a reading out of the download queue (not a fetchable work)")
    rt.add_argument("--list", default=""); rt.add_argument("--title", default="")
    rt.add_argument("--citation", default=""); rt.add_argument("--why", default="")
    ow = sub.add_parser("own", help="the user owns the work in print: take it and every entry of the "
                                    "same work (DOI or Source) out of the download queue")
    ow.add_argument("--list", default=""); ow.add_argument("--title", default="")
    ow.add_argument("--citation", default=""); ow.add_argument("--why", default="")
    rn = sub.add_parser("retitle", help="correct a reading's title in place")
    rn.add_argument("--list", default=""); rn.add_argument("--title", default="")
    rn.add_argument("--citation", default=""); rn.add_argument("--new-title", required=True)
    cd = sub.add_parser("clear-doi", help="remove a reading's DOI (e.g. it resolves to a review of the book)")
    cd.add_argument("--list", default=""); cd.add_argument("--title", default="")
    cd.add_argument("--citation", default="")
    rq = sub.add_parser("requeue", help="put a reading back in the download queue (e.g. its PDF was quarantined)")
    rq.add_argument("--list", default=""); rq.add_argument("--title", default="")
    rq.add_argument("--citation", default="")
    qa = sub.add_parser("queue-add", help="queue a paper to download WITHOUT putting it on a reading list "
                                          "(To Download.md; de-duplicated by DOI against every list)")
    qa.add_argument("--doi", default=""); qa.add_argument("--title", default="")
    qa.add_argument("--why", default="")
    qa.add_argument("--source", default="", help="who queued it — the `## ` block in To Download.md "
                                                  "(e.g. \"Field scan — topic\")")
    qa.add_argument("--type", default="", help="article|book|other when known")
    qa.add_argument("--no-lookup", action="store_true", help="with a bare DOI, do not ask Crossref for its title")
    sub.add_parser("queue", help="print the To Download.md sources with counts (JSON)")
    mq = sub.add_parser("move-to-queue", help="move a whole reading list into To Download.md as one source block")
    mq.add_argument("--list", required=True)
    rl = sub.add_parser("restore-list", help="put a To Download.md source block back as a reading list")
    rl.add_argument("--source", required=True)
    nx = sub.add_parser("next", help="the read-next queue and the read-by dates")
    nx.add_argument("--json", action="store_true")
    nx.add_argument("--today", default="", help="YYYY-MM-DD, for tests")
    ni = sub.add_parser("next-item", help="put a reading in the read-next queue (or --off to take it out)")
    du = sub.add_parser("due", help="set or --clear a read-by date on a reading, or on a whole group "
                                    "(--list and --group with no --item)")
    for sp_ in (ni, du):
        sp_.add_argument("--key", default="", help="item key, as printed by `next --json`")
        sp_.add_argument("--list", default=""); sp_.add_argument("--group", type=int, default=None)
        sp_.add_argument("--item", type=int, default=None)
        sp_.add_argument("--title", default=""); sp_.add_argument("--read", default="")
    ni.add_argument("--off", action="store_true"); ni.add_argument("--position", type=int, default=None)
    du.add_argument("--date", default=""); du.add_argument("--clear", action="store_true")
    nr = sub.add_parser("next-reorder", help="reorder the read-next queue: keys in the new order")
    nr.add_argument("keys", nargs="+")
    sd_ = sub.add_parser("stamp-session-dates", help="one-time: stamp Due on the items of dated session "
                                                     "groups (dry run unless --apply)")
    sd_.add_argument("--apply", action="store_true")
    a = p.parse_args()

    if a.cmd not in (None, "downloads", "lists", "queue", "next") and not (
            a.cmd == "stamp-session-dates" and not a.apply):
        _held = locked()
        _held.__enter__()

    def emit(r):
        """Print a mutator's result and turn it into an exit status."""
        print(json.dumps(r, ensure_ascii=False))
        if r is None or (isinstance(r, dict) and not r.get("ok", True)):
            sys.exit(1)
        sys.exit(0)

    if a.cmd == "downloads":
        print(json.dumps(downloads(), ensure_ascii=False, indent=2))
    elif a.cmd == "lists":
        if a.indexed:
            out = [{"name": L["name"], "groups": [
                {"group": gi, "level": g["level"], "name": g["name"], "items": len(g["items"]),
                 "prose": g["prose"]} for gi, g in enumerate(L["groups"])]} for L in active_lists()]
        else:
            out = [{"name": L["name"], "groups": [g["name"] for g in L["groups"] if not g["prose"]]} for L in active_lists()]
        print(json.dumps(out, ensure_ascii=False, indent=2))
    elif a.cmd == "set-pdf":
        emit(set_pdf(a.list, a.pdf, a.title or None, a.citation or None))
    elif a.cmd == "add":
        emit(item_add({"list": a.list, "group": a.group, "title": a.title, "why": a.why,
                       "read": a.read, "pdfPath": a.pdf or None, "doi": a.doi or None,
                       "needsDownload": not (a.have or a.pdf)}))
    elif a.cmd == "new-list":
        emit(list_create({"name": a.name, "note": a.note}))
    elif a.cmd == "new-group":
        emit(group_add({"list": a.list, "name": a.name, "note": a.note,
                        "sub": a.sub, "parent": a.parent}))
    elif a.cmd == "set-type":
        emit(set_type(a.list or None, a.type, a.title or None, a.citation or None))
    elif a.cmd == "set-doi":
        emit(set_doi(a.list or None, a.doi, a.title or None, a.citation or None))
    elif a.cmd == "flag-manual":
        emit(flag_manual(a.list or None, a.title or None, a.citation or None, unflag=a.unflag))
    elif a.cmd == "retract":
        emit(retract(a.list or None, a.title or None, a.citation or None, a.why or None))
    elif a.cmd == "own":
        emit(own(a.list or None, a.title or None, a.citation or None, a.why or None))
    elif a.cmd == "retitle":
        emit(retitle(a.list or None, a.title or None, a.citation or None, a.new_title))
    elif a.cmd == "clear-doi":
        emit(clear_doi(a.list or None, a.title or None, a.citation or None))
    elif a.cmd == "requeue":
        emit(requeue(a.list or None, a.title or None, a.citation or None))
    elif a.cmd == "set-source":
        emit(set_source(a.list or None, a.source, a.title or None, a.citation or None,
                        unset=a.unset))
    elif a.cmd == "queue-add":
        emit(queue_add({"doi": a.doi, "title": a.title, "why": a.why, "source": a.source,
                        "type": a.type, "lookup": not a.no_lookup}))
    elif a.cmd == "queue":
        print(json.dumps(queue_sources(), ensure_ascii=False, indent=2))
    elif a.cmd == "move-to-queue":
        emit(list_to_queue({"list": a.list}))
    elif a.cmd == "restore-list":
        emit(queue_to_list({"list": a.source}))
    elif a.cmd == "next":
        nu = next_up(a.today or None)
        if a.json:
            print(json.dumps(nu, ensure_ascii=False, indent=2))
        else:
            for it in nu["queue"]:
                print(f"{it['queue']:>3}. {it['title']}" + (f" [{it['read']}]" if it["read"] else "")
                      + (f"  due {it['due']}" if it["due"] else ""))
            for d in nu["readBy"]:
                print(f"read by {d['date']} ({d['daysLeft']:+d} d): {len(d['items'])}")
            print(f"behind: {nu['behind']}")
    elif a.cmd in ("next-item", "due"):
        whole_group = a.cmd == "due" and not a.key and not a.title and a.item is None \
            and a.list and a.group is not None
        tgt, err = ({"list": a.list, "group": a.group}, None) if whole_group else _cli_target(a)
        if err:
            emit({"ok": False, "error": err})
        if a.cmd == "next-item":
            emit(item_next(dict(tgt, on=not a.off, position=a.position)))
        if not a.clear and not a.date:
            emit({"ok": False, "error": "give --date YYYY-MM-DD or --clear"})
        emit((group_due if whole_group else item_due)(dict(tgt, date=None if a.clear else a.date)))
    elif a.cmd == "next-reorder":
        emit(next_reorder({"order": a.keys}))
    elif a.cmd == "stamp-session-dates":
        r = stamp_session_dates(apply=a.apply)
        print(json.dumps(r, ensure_ascii=False, indent=2))
        sys.exit(0 if r.get("ok") else 1)
    else:
        p.print_help()


if __name__ == "__main__":
    _cli()
