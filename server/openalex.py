"""openalex.py — build a Reading-view download list from OpenAlex."""
import settings
import datetime, json, os, re, sys, time, urllib.error, urllib.parse, urllib.request
from pathlib import Path

EMAIL = settings.CONTACT_EMAIL
OA = "https://api.openalex.org"
UA = f"all-in-one-academic/1.0 (mailto:{EMAIL})"
ILLEGAL = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_STOP = set("the a an of and or in on for to with from by at as is are about into over "
            "under between within without their your our its his her".split())

DAILY_BUDGET = int(os.environ.get("OPENALEX_DAILY_BUDGET", "100000"))
LEDGER = os.path.expanduser(os.environ.get(
    "OPENALEX_LEDGER", str(settings.STATE_DIR / "openalex-budget.json")))
STATUS_RATE_LIMITED = "RATE_LIMITED"
_BUDGET_LOGGED = False


class RateLimited(RuntimeError):
    """OpenAlex answered HTTP 429 — the daily budget is spent, not the DOI missing."""
    status = STATUS_RATE_LIMITED
    retryable = True

    def __init__(self, message="", reset=None, retry_after=None, body=""):
        self.message = message or "OpenAlex daily budget exhausted (HTTP 429)"
        self.reset = reset                 # human-readable reset, from the body
        self.retry_after = retry_after     # seconds, from the Retry-After header
        self.body = (body or "")[:400]
        super().__init__(self.as_note())

    def as_note(self):
        bits = [self.message]
        if self.reset:
            bits.append(f"resets {self.reset}")
        if self.retry_after:
            bits.append(f"retry-after {self.retry_after}s")
        return " — ".join(bits)[:300]

    def to_dict(self):
        return {"status": self.status, "retryable": True, "message": self.message,
                "reset": self.reset, "retryAfter": self.retry_after,
                "note": self.as_note()}


def _utc_day():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d")


def _ledger_read():
    try:
        with open(LEDGER, encoding="utf-8") as fh:
            d = json.load(fh)
    except Exception:
        d = {}
    if d.get("day") != _utc_day():            # a new UTC day resets the budget
        d = {"day": _utc_day(), "spent": 0, "limit": DAILY_BUDGET,
             "remainingReported": None, "lastRateLimit": None}
    d.setdefault("spent", 0)
    d.setdefault("limit", DAILY_BUDGET)
    d.setdefault("remainingReported", None)
    d.setdefault("lastRateLimit", None)
    return d


def _ledger_write(d):
    try:
        os.makedirs(os.path.dirname(LEDGER), exist_ok=True)
        tmp = LEDGER + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(d, fh, ensure_ascii=False, indent=2)
        os.replace(tmp, LEDGER)
    except Exception:
        pass                                   # metering must never break a run


def _ledger_spend(n=1):
    d = _ledger_read(); d["spent"] = int(d.get("spent") or 0) + n
    if d.get("remainingReported") is not None:
        d["remainingReported"] = max(0, int(d["remainingReported"]) - n)
    _ledger_write(d); return d


def _ledger_headers(headers):
    """Record x-ratelimit-* when OpenAlex sends them (it does not always)."""
    try:
        rem = headers.get("x-ratelimit-remaining") or headers.get("X-RateLimit-Remaining")
        lim = headers.get("x-ratelimit-limit") or headers.get("X-RateLimit-Limit")
    except Exception:
        return
    if rem is None and lim is None:
        return
    d = _ledger_read()
    if rem is not None:
        try:
            d["remainingReported"] = int(str(rem).strip())
            d["remainingSource"] = "openalex-header"
        except Exception:
            pass
    if lim is not None:
        try:
            d["limit"] = int(str(lim).strip())
        except Exception:
            pass
    _ledger_write(d)


def _ledger_rate_limited(err):
    d = _ledger_read()
    d["lastRateLimit"] = dict(err.to_dict(), at=int(time.time()))
    d["remainingReported"] = 0
    d["remainingSource"] = "openalex-429"
    _ledger_write(d)


def budget():
    """The daily-budget snapshot, read from the local ledger — NO network call, so
    the probe never spends one of the lookups it is reporting on."""
    d = _ledger_read()
    reported = d.get("remainingReported")
    remaining = reported if reported is not None else max(0, int(d["limit"]) - int(d["spent"]))
    return {"day": d["day"], "limit": int(d["limit"]), "spent": int(d["spent"]),
            "remaining": int(remaining),
            "remainingSource": (d.get("remainingSource") or "openalex-header")
                               if reported is not None else "local-ledger",
            "lastRateLimit": d.get("lastRateLimit"), "ledger": LEDGER,
            "spendsLookup": False}


def budget_line():
    b = budget()
    line = (f"OpenAlex budget {b['remaining']:,}/{b['limit']:,} left "
            f"({b['spent']:,} spent today, UTC {b['day']}, {b['remainingSource']})")
    if b.get("lastRateLimit"):
        line += " — RATE_LIMITED: " + str((b["lastRateLimit"] or {}).get("note") or "")[:120]
    return line


def log_budget_once(emit=None):
    """Log the daily budget figure once per process."""
    global _BUDGET_LOGGED
    if _BUDGET_LOGGED:
        return None
    _BUDGET_LOGGED = True
    line = budget_line()
    (emit or (lambda s: print(s, file=sys.stderr, flush=True)))(line)
    return line


def _rate_limited_from(e):
    """Build a RateLimited from an HTTPError whose code is 429."""
    body = ""
    try:
        body = e.read().decode("utf-8", "replace")
    except Exception:
        pass
    msg = ""
    try:
        msg = (json.loads(body) or {}).get("message") or ""
    except Exception:
        msg = body.strip()[:200]
    reset = None
    m = re.search(r"[Rr]esets? (?:at )?([^.\"}]+)", msg or body or "")
    if m:
        reset = m.group(1).strip()
    retry_after = None
    try:
        ra = (e.headers or {}).get("Retry-After")
        retry_after = int(str(ra).strip()) if ra else None
    except Exception:
        retry_after = None
    return RateLimited(message=(msg or "").strip()[:200] or None,
                       reset=reset, retry_after=retry_after, body=body)


def _api_key():
    names = ("OPENALEX_API_KEY", "OPENALEX_KEY")
    for n in names:
        v = os.environ.get(n, "").strip().strip('"').strip("'")
        if v:
            return v
    try:
        text = Path(settings.SECRETS_FILE).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    for ln in text.splitlines():
        m = re.match(r"^\s*(?:export\s+)?(?:OPENALEX_API_KEY|OPENALEX_KEY)\s*[=:]\s*(.+?)\s*$", ln)
        if m and m.group(1).strip().strip('"').strip("'"):
            return m.group(1).strip().strip('"').strip("'")
    return None


def _get(path, params, tries=3):
    params = dict(params or {}); params["mailto"] = EMAIL
    _k = _api_key()
    if _k:
        params["api_key"] = _k
    url = f"{OA}/{path}?" + urllib.parse.urlencode(params)
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            _ledger_spend(1)
            with urllib.request.urlopen(req, timeout=30) as r:
                _ledger_headers(getattr(r, "headers", {}) or {})
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:     # noqa
            if getattr(e, "code", None) == 429:
                # A spent daily budget will NOT clear with a half-second sleep, and
                # retrying burns the caller's time for nothing. Refuse loudly.
                err = _rate_limited_from(e)
                _ledger_rate_limited(err)
                raise err
            last = e
            time.sleep(0.5 * (i + 1))
        except Exception as e:  # noqa
            last = e
            time.sleep(0.5 * (i + 1))
    raise last if last else RuntimeError("openalex request failed")


def _clean(t):
    t = re.sub(r"</?[a-z]+>", "", t or "")           # strip stray html tags
    return t.replace("&amp;", "&").strip()


def _words(s):
    return [w for w in re.findall(r"[a-z0-9]+", (s or "").lower()) if len(w) > 3 and w not in _STOP]


def _fname(authors, year, title):
    lasts = [a.split()[-1] if a.split() else a for a in (authors or [])]
    if not lasts:
        astr = "Unknown"
    elif len(lasts) == 1:
        astr = lasts[0]
    elif len(lasts) == 2:
        astr = f"{lasts[0]} and {lasts[1]}"
    else:
        astr = f"{lasts[0]} et al."
    t = ILLEGAL.sub("", _clean(title))
    return f"{astr} ({year}) - {t}".strip()[:180]


def _doi(w):
    return (w.get("doi") or "").replace("https://doi.org/", "").strip() or None


def _authors(w):
    return [a["author"]["display_name"] for a in (w.get("authorships") or []) if a.get("author")]


def work_to_item(w, confidence="HIGH"):
    authors = _authors(w)
    year = w.get("publication_year")
    title = _clean(w.get("title") or "")
    oa = w.get("open_access") or {}
    pl = w.get("primary_location") or {}
    src = (pl.get("source") or {}) or {}
    return {
        "doi": _doi(w),
        "title": _fname(authors, year, title),        # filename-form (reading item title)
        "displayTitle": title,
        "year": year,
        "authors": authors,
        "type": w.get("type"),
        "venue": src.get("display_name"),
        "isOA": bool(oa.get("is_oa")),
        "oaStatus": oa.get("oa_status"),
        "openalexId": (w.get("id") or "").split("/")[-1] or None,
        "confidence": confidence,
    }


_WORK_SELECT = ("id,doi,title,publication_year,type,open_access,primary_location,authorships")


def by_author(name, limit=400):
    """Resolve an author name and return every work, plus which author matched."""
    try:
        a = _get("authors", {"search": name, "per_page": 8})
    except RateLimited as e:
        return {"author": None, "alternatives": [], "items": [],
                "status": STATUS_RATE_LIMITED, "rateLimited": e.to_dict(),
                "budget": budget()}
    cands = a.get("results") or []
    if not cands:
        return {"author": None, "alternatives": [], "items": [], "status": "OK"}
    # pick the most prolific among the top relevance hits (the real, established author)
    top = sorted(cands[:8], key=lambda x: -(x.get("works_count") or 0))
    chosen = top[0]
    aid = chosen["id"].split("/")[-1]
    items, seen, cursor, refused = [], set(), "*", None
    while cursor and len(items) < limit:
        try:
            d = _get("works", {"filter": f"author.id:{aid}", "per_page": 200,
                                "cursor": cursor, "select": _WORK_SELECT})
        except RateLimited as e:
            refused = e
            break
        for w in d.get("results", []):
            wid = (w.get("id") or "").split("/")[-1]
            if wid in seen:
                continue
            seen.add(wid)
            items.append(work_to_item(w))
        cursor = (d.get("meta") or {}).get("next_cursor")
        time.sleep(0.2)
    items.sort(key=lambda x: -(x["year"] or 0))
    def _inst(c):
        insts = c.get("last_known_institutions") or []
        return insts[0]["display_name"] if insts else None
    out = {
        "author": {"id": aid, "name": chosen.get("display_name"),
                   "works": chosen.get("works_count"), "cited": chosen.get("cited_by_count"),
                   "institution": _inst(chosen)},
        "alternatives": [{"id": c["id"].split("/")[-1], "name": c.get("display_name"),
                          "works": c.get("works_count"), "institution": _inst(c)}
                         for c in cands[:8] if c["id"].split("/")[-1] != aid],
        "items": items,
        "status": STATUS_RATE_LIMITED if refused else "OK",
    }
    if refused:
        out["rateLimited"] = refused.to_dict()
        out["budget"] = budget()
    return out


def _score(line_title, line_year, w):
    """Confidence that a fuzzy title hit matches the query line."""
    ct = _clean(w.get("title") or ""); cy = w.get("publication_year")
    tw, cw = set(_words(line_title)), set(_words(ct))
    ov = len(tw & cw) / max(1, len(tw)) if tw else 0.0
    yr_ok = (not line_year) or (cy and abs(int(line_year) - int(cy)) <= 1)
    if ov >= 0.6 and yr_ok:
        return "HIGH"
    if ov >= 0.34 and yr_ok:
        return "MEDIUM"
    return "LOW"


_DOI_RE = re.compile(r"\b(10\.\d{4,9}/[^\s\"'<>]+)\b", re.I)
_YEAR_RE = re.compile(r"\((\d{4})\)")


def _unresolved(line, year=None, rate_limited=None):
    """A line we could not resolve. When `rate_limited` is set this is a REFUSAL,
    not a no-DOI verdict: the caller must leave the item's DOI alone and retry."""
    it = {"doi": None, "title": line, "displayTitle": line, "year": year,
          "authors": [], "confidence": "LOW", "isOA": False, "venue": None,
          "openalexId": None, "type": None, "oaStatus": None}
    if rate_limited is not None:
        it.update(rate_limited.to_dict())
        it["confidence"] = None
    return it


def resolve_lines(text):
    """Each non-blank line is a DOI (resolved exactly) or a title (best OpenAlex match)."""
    items = []
    lines = [raw.strip() for raw in (text or "").splitlines() if raw.strip()]
    for idx, line in enumerate(lines):
        m = _DOI_RE.search(line)
        try:
            if m:
                doi = m.group(1).rstrip(".,;)")
                w = _get(f"works/doi:{doi}", {"select": _WORK_SELECT})
                items.append(work_to_item(w, confidence="HIGH"))
            else:
                ym = _YEAR_RE.search(line)
                yr = ym.group(1) if ym else None
                d = _get("works", {"search": line, "per_page": 5, "select": _WORK_SELECT})
                res = d.get("results") or []
                if not res:
                    items.append(_unresolved(line, yr))
                    continue
                best = max(res, key=lambda w: len(set(_words(line)) & set(_words(_clean(w.get("title") or "")))))
                it = work_to_item(best, confidence=_score(line, yr, best))
                items.append(it)
        except RateLimited as e:
            # Metered refusal: this line and every line after it are UNASKED, not
            # answered 'no DOI'. Stop the pass and hand the caller the refusal.
            for rest in lines[idx:]:
                items.append(_unresolved(rest, rate_limited=e))
            return {"items": items, "status": STATUS_RATE_LIMITED,
                    "rateLimited": e.to_dict(),
                    "resolved": idx, "unresolved": len(lines) - idx,
                    "budget": budget()}
        except Exception as e:  # noqa
            it = _unresolved(line)
            it["error"] = str(e)[:80]
            items.append(it)
        time.sleep(0.2)
    return {"items": items, "status": "OK"}


def by_topic(query, limit=40):
    """OpenAlex relevance search on a topic/keyword. The returned list is the review
    surface — the user prunes it in the Board before downloading."""
    try:
        d = _get("works", {"search": query, "per_page": min(limit, 200),
                           "sort": "relevance_score:desc", "select": _WORK_SELECT})
    except RateLimited as e:
        return {"items": [], "status": STATUS_RATE_LIMITED,
                "rateLimited": e.to_dict(), "budget": budget()}
    items = [work_to_item(w, confidence="TOPIC") for w in (d.get("results") or [])]
    return {"items": items, "status": "OK"}


def build_list(items, list_name, note="", group="Readings"):
    """Create a reading list and add each item as needs-download with its DOI.
    Items already in a vault PDF are NOT deduped here — that is the download step's job.
    Returns {list, added, skipped}. Run where reading.py is importable."""
    import reading
    created = reading.list_create({"name": list_name, "note": note})
    name = created.get("name", list_name) if isinstance(created, dict) else list_name
    reading.group_add({"list": name, "name": group, "note": ""})
    added = skipped = 0
    for it in items:
        title = it.get("title")
        if not title:
            skipped += 1
            continue
        why = it.get("why") or _why(it)
        reading.item_add({"list": name, "title": title, "doi": it.get("doi") or None,
                          "why": why, "needsDownload": True})
        added += 1
    return {"list": name, "added": added, "skipped": skipped}


def _why(it):
    bits = []
    if it.get("venue"):
        bits.append(it["venue"])
    if it.get("isOA"):
        bits.append(f"OA:{it.get('oaStatus') or 'yes'}")
    c = it.get("confidence")
    if c and c not in ("HIGH",):
        bits.append(f"match:{c}")
    if not it.get("doi"):
        bits.append("no DOI")
    return "; ".join(bits)


def _cli():
    import argparse
    p = argparse.ArgumentParser(prog="openalex.py", description="seed a download list from OpenAlex")
    sub = p.add_subparsers(dest="cmd")
    a = sub.add_parser("author"); a.add_argument("name"); a.add_argument("--build", default="")
    r = sub.add_parser("lines"); r.add_argument("--file", default=""); r.add_argument("--build", default="")
    t = sub.add_parser("topic"); t.add_argument("query"); t.add_argument("--limit", type=int, default=40); t.add_argument("--build", default="")
    sub.add_parser("budget", help="report remaining OpenAlex daily budget (no network call)")
    args = p.parse_args()
    if args.cmd == "budget":
        # The probe: reads the local ledger only, so asking never spends a lookup.
        print(json.dumps(budget(), ensure_ascii=False, indent=2))
        return
    log_budget_once()                       # one budget line per run, on stderr
    if args.cmd == "author":
        res = by_author(args.name)
    elif args.cmd == "lines":
        text = open(args.file, encoding="utf-8").read() if args.file else sys.stdin.read()
        res = resolve_lines(text)
    elif args.cmd == "topic":
        res = by_topic(args.query, args.limit)
    else:
        p.print_help(); return
    build = getattr(args, "build", "")
    if build:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        res["built"] = build_list(res["items"], build,
                                  note=f"OpenAlex {args.cmd} import")
    print(json.dumps(res, ensure_ascii=False, indent=2))
    if res.get("status") == STATUS_RATE_LIMITED:
        print(">>> OpenAlex REFUSED (rate-limited, retryable): "
              + str((res.get("rateLimited") or {}).get("note") or ""), file=sys.stderr)
        sys.exit(3)                         # distinct from 1 — nothing was answered


if __name__ == "__main__":
    _cli()
