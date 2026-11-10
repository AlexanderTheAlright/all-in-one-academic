"""Ambient state for the dashboard."""
import settings
import json, re, time, hashlib
import urllib.parse
import urllib.request
from pathlib import Path
from datetime import date, datetime, timedelta

HERE = settings.STATE_DIR
VAULT = settings.VAULT
NOTES = VAULT / "Preparation" / "Notes"
DAILY = NOTES / "Daily"

CACHE_FILE = HERE / "ambient-cache.json"
WEATHER_TTL = 900            # refetch open-meteo every 15 min
PAYLOAD_TTL = 300            # whole-payload in-memory cache

LAT, LON = settings.LATITUDE, settings.LONGITUDE
OM_URL = (
    "https://api.open-meteo.com/v1/forecast"
    f"?latitude={LAT}&longitude={LON}"
    "&current=temperature_2m,apparent_temperature,weather_code,precipitation,cloud_cover,is_day"
    "&daily=sunrise,sunset,temperature_2m_max,temperature_2m_min"
    f"&timezone={urllib.parse.quote(settings.TIMEZONE, safe='')}&forecast_days=1"
)

# WMO weather code -> (kind, label). kind is the small vocabulary the front-end
# tints from; label is the human line in the header.
WMO = {
    0: ("clear", "clear sky"), 1: ("clear", "mainly clear"),
    2: ("partly", "partly cloudy"), 3: ("overcast", "overcast"),
    45: ("fog", "fog"), 48: ("fog", "icy fog"),
    51: ("drizzle", "light drizzle"), 53: ("drizzle", "drizzle"), 55: ("drizzle", "heavy drizzle"),
    56: ("drizzle", "freezing drizzle"), 57: ("drizzle", "freezing drizzle"),
    61: ("rain", "light rain"), 63: ("rain", "rain"), 65: ("rain", "heavy rain"),
    66: ("rain", "freezing rain"), 67: ("rain", "freezing rain"),
    71: ("snow", "light snow"), 73: ("snow", "snow"), 75: ("snow", "heavy snow"),
    77: ("snow", "snow grains"),
    80: ("rain", "rain showers"), 81: ("rain", "rain showers"), 82: ("rain", "violent showers"),
    85: ("snow", "snow showers"), 86: ("snow", "snow showers"),
    95: ("storm", "thunderstorm"), 96: ("storm", "thunderstorm with hail"),
    99: ("storm", "thunderstorm with hail"),
}

HABIT_KEYS = list(settings.HABITS)

WET_KINDS = {"drizzle", "rain", "snow", "storm"}
STORM_CODES = {95, 96, 99}


def _sky_from_cloud(cloud):
    if cloud is None:
        return "partly", "partly cloudy"
    try:
        cloud = float(cloud)
    except (TypeError, ValueError):
        return "partly", "partly cloudy"
    if cloud < 20:
        return "clear", "clear sky"
    if cloud < 60:
        return "partly", "partly cloudy"
    if cloud < 85:
        return "overcast", "mostly cloudy"
    return "overcast", "overcast"


def _reconcile(code, kind, label, cur):
    """Soften a wet code that isn't backed by actual precipitation."""
    if kind not in WET_KINDS:
        return kind, label
    try:
        precip = float(cur.get("precipitation") or 0)
    except (TypeError, ValueError):
        precip = 0.0
    if precip >= 0.1:                       # rain is genuinely falling — trust the code
        return kind, label
    sky_kind, sky_label = _sky_from_cloud(cur.get("cloud_cover"))
    if code in STORM_CODES:                 # convection modeled nearby but dry overhead
        return sky_kind, "storms nearby"
    return sky_kind, sky_label


# ------------------------------------------------------------- weather
def _fetch_open_meteo():
    with urllib.request.urlopen(OM_URL, timeout=8) as r:
        raw = json.loads(r.read().decode("utf-8"))
    cur, day = raw.get("current", {}), raw.get("daily", {})
    code = int(cur.get("weather_code", 3))
    kind, label = WMO.get(code, ("overcast", "cloudy"))
    kind, label = _reconcile(code, kind, label, cur)
    return {
        "fetchedAt": time.time(),
        "weather": {
            "tempC": round(float(cur.get("temperature_2m", 0))),
            "feelsC": round(float(cur.get("apparent_temperature", 0))),
            "code": code, "kind": kind, "label": label,
            "isDay": bool(cur.get("is_day", 1)),
            "hiC": round(float(day["temperature_2m_max"][0])) if day.get("temperature_2m_max") else None,
            "loC": round(float(day["temperature_2m_min"][0])) if day.get("temperature_2m_min") else None,
        },
        "sun": {
            "sunrise": (day.get("sunrise") or [None])[0],
            "sunset": (day.get("sunset") or [None])[0],
        },
    }


def weather():
    """Last-known-good weather: fresh fetch when stale, disk cache when offline."""
    if not (settings.LATITUDE or settings.LONGITUDE):
        return None, None, False
    cached = None
    try:
        cached = json.loads(CACHE_FILE.read_text("utf-8"))
    except Exception:
        pass
    if cached and time.time() - cached.get("fetchedAt", 0) < WEATHER_TTL:
        return cached["weather"], cached["sun"], False
    try:
        fresh = _fetch_open_meteo()
        tmp = CACHE_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(fresh), "utf-8")
        tmp.replace(CACHE_FILE)
        return fresh["weather"], fresh["sun"], False
    except Exception:
        if cached:
            return cached["weather"], cached["sun"], True
        return None, None, True


# ------------------------------------------------------------- note parsing
_FM = re.compile(r"^---\n.*?\n---\n", re.S)
_WIKI = re.compile(r"\[\[([^\]|]*\|)?([^\]]+)\]\]")
_MD_LINK = re.compile(r"\[([^\]]+)\]\([^)]*\)")
_EMPH = re.compile(r"(\*\*|__|\*|_|`|==)")

def _read(p: Path):
    try:
        return p.read_text("utf-8", errors="ignore")
    except Exception:
        return ""

def _clean(line: str) -> str:
    line = _WIKI.sub(lambda m: m.group(2), line)
    line = _MD_LINK.sub(lambda m: m.group(1), line)
    line = _EMPH.sub("", line)
    return re.sub(r"\s+", " ", line).strip()

def _habits(text: str):
    done = 0
    for k in HABIT_KEYS:
        if re.search(rf"^{re.escape(k)}:\s*true\s*$", text, re.M):
            done += 1
    return done

def _sections(text: str):
    """heading -> body text, split on H2s (frontmatter stripped)."""
    body = _FM.sub("", text, count=1)
    out, cur, buf = {}, None, []
    for line in body.splitlines():
        m = re.match(r"^##\s+(.+?)\s*$", line)
        if m:
            if cur:
                out[cur] = "\n".join(buf)
            cur, buf = m.group(1), []
        elif cur:
            buf.append(line)
    if cur:
        out[cur] = "\n".join(buf)
    return out

_SKIP = ("_", ">", "|", "-", "#", "!", "%%", "*", "```", "[", "---")

def _prose_lines(section: str, min_len=25):
    out = []
    for line in section.splitlines():
        s = line.strip()
        if not s or any(s.startswith(p) for p in _SKIP):
            continue
        c = _clean(s)
        if len(c) >= min_len:
            out.append(c)
    return out

def _excerpt(text: str):
    secs = _sections(text)
    for name in (settings.DAILY_LOG_HEADING, settings.DAILY_SECTIONS["daily-notes"]):
        lines = _prose_lines(secs.get(name, ""))
        if lines:
            joined = " ".join(lines[:2])
            return joined[:257] + "…" if len(joined) > 260 else joined
    return ""


# ------------------------------------------------------------- on this day
_AGO = [(7, "A week ago"), (30, "A month ago"), (90, "Three months ago"),
        (180, "Six months ago"), (365, "A year ago")]

def on_this_day(today: date):
    out = []
    for days, label in _AGO:
        d = today - timedelta(days=days)
        p = DAILY / f"{d.isoformat()}.md"
        if not p.exists():
            continue
        text = _read(p)
        ex = _excerpt(text)
        done = _habits(text)
        if not ex and done == 0:
            continue
        out.append({
            "date": d.isoformat(), "ago": label, "excerpt": ex,
            "habitsDone": done, "habitsTotal": len(HABIT_KEYS),
            "path": f"Preparation/Notes/Daily/{d.isoformat()}.md",
        })
        if len(out) == 3:
            break
    return out


# ------------------------------------------------------------- epigraph
def _epigraph_pool():
    pool = []
    sources = []
    for sub in ("Authors", "Concepts", "Ideas", "Reflections"):
        d = NOTES / sub
        if d.is_dir():
            sources += sorted(d.glob("*.md"))
    canon = NOTES / "Canon.md"
    if canon.exists():
        sources.append(canon)
    for p in sources:
        body = _FM.sub("", _read(p), count=1)
        only_quotes = p == canon          # Canon's prose is how-to-add instructions, not lines
        for line in body.splitlines():
            s = line.strip()
            quoted = s.startswith(">")                 # blockquotes are the best epigraphs
            if quoted:
                s = s.lstrip("> ").strip()
            if only_quotes and not quoted:
                continue
            # leading "*" = an italic author attribution, not a line of its own
            if not s or any(s.startswith(x) for x in ("#", "|", "-", "!", "%%", "```", "---", "*")):
                continue
            c = _clean(s)
            if 40 <= len(c) <= 240:
                pool.append({"text": c, "source": p.stem})
    return pool

def epigraph(today: date):
    pool = _epigraph_pool()
    if not pool:
        return None
    pool.sort(key=lambda e: (e["source"], e["text"]))   # stable across restarts
    i = int(hashlib.md5(today.isoformat().encode()).hexdigest(), 16) % len(pool)
    return pool[i]


# ------------------------------------------------------------- payload
_cache = {"t": 0.0, "date": "", "data": None}

def payload():
    now = time.time()
    today = date.today()
    if _cache["data"] is not None and now - _cache["t"] < PAYLOAD_TTL and _cache["date"] == today.isoformat():
        return _cache["data"]
    w, sun, stale = weather()
    out = {
        "date": today.isoformat(),
        "now": datetime.now().isoformat(timespec="minutes"),
        "weather": w, "sun": sun, "stale": stale,
        "epigraph": epigraph(today),
        "onThisDay": on_this_day(today),
    }
    _cache.update(t=now, date=today.isoformat(), data=out)
    return out


if __name__ == "__main__":
    print(json.dumps(payload(), indent=2))
