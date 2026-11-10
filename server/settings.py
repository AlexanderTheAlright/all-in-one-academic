"""Configuration: environment (AIOA_<KEY>) over config file over defaults."""
import os
import re
import tomllib
from pathlib import Path

CODE_DIR = Path(__file__).resolve().parent
REPO = CODE_DIR.parent

_path = Path(os.environ.get("AIOA_CONFIG") or Path.home() / ".config" / "all-in-one-academic" / "config.toml")
try:
    _file = tomllib.loads(_path.read_text(encoding="utf-8")) if _path.is_file() else {}
except (OSError, tomllib.TOMLDecodeError):
    _file = {}


def get(key, default):
    env = os.environ.get("AIOA_" + key.upper())
    if env not in (None, ""):
        return env
    return _file.get(key, default)


def _dir(key, default):
    return Path(str(get(key, default))).expanduser().resolve()


_state_default = Path(os.environ.get("XDG_STATE_HOME") or Path.home() / ".local" / "state") / "all-in-one-academic"

VAULT = _dir("vault", Path.home() / "all-in-one-academic-vault")
PROJECTS_DIR = VAULT / str(get("projects_dir", "Projects"))
STATE_DIR = _dir("state_dir", _state_default)
WEB_DIST = _dir("web_dist", REPO / "web" / "dist")
SECRETS_FILE = _dir("secrets_file", Path.home() / ".config" / "all-in-one-academic" / "secrets.env")
HOST = "127.0.0.1"                      # loopback only; not configurable
PORT = int(get("port", 8787))
SURFACE = str(get("surface", "host")).strip().lower()
AUTHOR_NAME = str(get("author_name", ""))
AUTHOR_AFFILIATION = str(get("author_affiliation", ""))
INSTITUTION = str(get("institution", ""))
CONTACT_EMAIL = str(get("contact_email", ""))
TIMEZONE = str(get("timezone", "UTC"))
LATITUDE = float(get("latitude", 0.0))
LONGITUDE = float(get("longitude", 0.0))

WEB_FONTS = str(get("web_fonts", "")).strip().lower() in ("1", "true", "yes")
HABITS = list(get("habits", ["habit-one", "habit-two", "habit-three"])) if not isinstance(get("habits", []), str) \
    else [h.strip() for h in str(get("habits", "")).split(",") if h.strip()]
# Daily-note headings the app reads and writes: anchor -> heading text.
DAILY_LOG_HEADING = str(get("daily_log_heading", "Log"))
DAILY_SECTIONS = {"daily-notes": "Notes", "work": "Work",
                  "log-entry": "Entry", "log-next": "Next", "log-summary": "Summary"}
if isinstance(_file.get("daily_sections"), dict):
    DAILY_SECTIONS.update({k: str(v) for k, v in _file["daily_sections"].items() if k in DAILY_SECTIONS})

# Executing scripts found in the vault (build.sh, project scripts) is off unless asked for.
RUN_VAULT_SCRIPTS = str(get("run_vault_scripts", "")).strip().lower() in ("1", "true", "yes")
TASKS_BOARD_REL = str(get("tasks_board", "Planning/Tasks.md"))      # vault-relative
GOALS_REL = str(get("goals_file", "Planning/Goals.md"))             # vault-relative
DATA_FAMILY = str(get("data_family", "main"))                       # folder name of the primary dataset family
# Folder-name prefix that marks a live paper or grant under Projects/papers and Projects/grants
# (for example "active - "). Empty: every folder there is a project, except hidden ones and archive/.
PROJECT_PREFIX = str(get("project_prefix", ""))
PRIMARY_SOURCES_REL = str(get("primary_sources_dir", "Preparation/Reading/Primary")).strip("/")   # vault-relative
_skip = get("index_skip", [])
INDEX_SKIP = [x.strip() for x in (_skip.split(",") if isinstance(_skip, str) else _skip) if str(x).strip()]
# one live project folder name inside a regex (never hidden, never the archive shelf)
LIVE_PROJECT_RE = re.escape(PROJECT_PREFIX) + r"(?!archive/)(?!\.)[^/]+"


def live_slug(name):
    """The slug of a live paper or grant folder, or None for anything else."""
    if name.startswith(".") or name.lower() == "archive" or not name.startswith(PROJECT_PREFIX):
        return None
    return name[len(PROJECT_PREFIX):] or None


def strip_prefix(name):
    """A project folder name without the live-project prefix."""
    return name[len(PROJECT_PREFIX):] if PROJECT_PREFIX and name.startswith(PROJECT_PREFIX) else name

STATE_DIR.mkdir(parents=True, exist_ok=True)


def require_pymupdf():
    """PyMuPDF is optional (AGPL-3.0) and never installed by default."""
    try:
        import pymupdf
    except ImportError as e:
        raise RuntimeError("install pymupdf to enable PDF features") from e
    return pymupdf
