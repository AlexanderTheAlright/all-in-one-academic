"""Route checks for server/serve.py. They run on a temp copy of the sample vault,
use no network, and never open anything on the desktop: the opener on PATH is a
stub that only records what it was asked to open.

Run from the repository root:  python -m unittest discover tests
"""
import json
import os
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
TMP = Path(tempfile.mkdtemp(prefix="aioa-routes-"))
VAULT = TMP / "vault"
STATE = TMP / "state"
DIST = TMP / "dist"
BIN = TMP / "bin"
OPENED = TMP / "opened.txt"
SLUG = "sample grant"
PROJ = VAULT / "Projects" / "grants" / SLUG
BOARD = "Planning/Tasks.md"
CITATION = "Preparation/Reading/Citations/Fakename (2001) - An Invented Study of Nothing.md"
OUTSIDE = "Preparation/Notes/Ideas/Sample idea.md"
JSON = {"Content-Type": "application/json"}
PAGE = {"Content-Type": "application/json", "Sec-Fetch-Site": "same-origin"}


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


PORT = _free_port()
ENV = {
    "HOME": str(TMP / "home"), "AIOA_VAULT": str(VAULT), "AIOA_STATE_DIR": str(STATE),
    "AIOA_PORT": str(PORT), "AIOA_WEB_DIST": str(DIST), "AIOA_CONFIG": str(TMP / "none.toml"),
    "HTTP_PROXY": "http://127.0.0.1:9", "HTTPS_PROXY": "http://127.0.0.1:9",
    "http_proxy": "http://127.0.0.1:9", "https_proxy": "http://127.0.0.1:9",
    "PYTHONDONTWRITEBYTECODE": "1",
}
SERVER = None


def setUpModule():
    global SERVER
    shutil.copytree(REPO / "examples" / "sample-vault", VAULT)
    (TMP / "home").mkdir()
    (PROJ / "writing").mkdir(parents=True)
    (PROJ / "writing" / "paper.md").write_text("placeholder\n", encoding="utf-8")
    DIST.mkdir()
    (DIST / "index.html").write_text("<!doctype html><title>test bundle</title>\n", encoding="utf-8")
    BIN.mkdir()
    for name in ("xdg-open", "open"):
        stub = BIN / name
        stub.write_text('#!/bin/sh\nprintf "%%s\\n" "$1" >> "%s"\n' % OPENED, encoding="utf-8")
        stub.chmod(stub.stat().st_mode | stat.S_IXUSR)
    SERVER = subprocess.Popen([sys.executable, str(REPO / "server" / "serve.py")], cwd=str(REPO / "server"),
                              env={**ENV, "PATH": str(BIN) + os.pathsep + os.environ.get("PATH", "")},
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(100):
        try:
            _get("/health")
            return
        except (urllib.error.URLError, ConnectionError):
            time.sleep(0.2)
    raise RuntimeError("the server did not start")


def tearDownModule():
    if SERVER:
        SERVER.terminate()
        try:
            SERVER.wait(timeout=10)
        except subprocess.TimeoutExpired:
            SERVER.kill()
    if not os.environ.get("AIOA_TEST_KEEP"):
        shutil.rmtree(TMP, ignore_errors=True)


_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))     # loopback, never the proxy


def _get(path, headers=None, method="GET", data=None):
    req = urllib.request.Request("http://127.0.0.1:%d%s" % (PORT, path), headers=headers or {}, method=method, data=data)
    try:
        with _OPENER.open(req, timeout=20) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        with e:
            return e.code, dict(e.headers), e.read()


def _post(path, body=None, headers=JSON):
    data = b"" if body is None else json.dumps(body).encode("utf-8")
    return _get(path, headers, "POST", data)


def _raw(request):
    """Send bytes as they are and return the status line's code."""
    with socket.create_connection(("127.0.0.1", PORT), timeout=10) as s:
        s.sendall(request)
        head = s.recv(400)
    return int(head.split(b" ", 2)[1])


def _opened():
    try:
        return OPENED.read_text(encoding="utf-8").splitlines()
    except OSError:
        return []


class RemovedRoutes(unittest.TestCase):
    def test_removed_gets_answer_404(self):
        for path in ("/reading/download", "/reading/download-status?run=x",
                     "/no-such-view", "/v/no-such-view", "/w/no-such-widget"):
            self.assertEqual(_get(path)[0], 404, path)

    def test_removed_posts_answer_404(self):
        for path in ("/reading/download", "/no-such-route"):
            self.assertEqual(_post(path, {"list": "x", "title": "x"})[0], 404, path)

    def test_surface_and_glimpse_carry_no_removed_feature(self):
        status, _, body = _get("/surface")
        self.assertEqual(status, 200)
        self.assertIsInstance(json.loads(body), dict)
        status, _, body = _get("/glimpse")
        self.assertEqual(status, 200)
        views = set(json.loads(body)["views"])
        self.assertIn("today", views)


class KeptRoutes(unittest.TestCase):
    PATHS = (
        "/", "/index.html", "/health", "/surface", "/today", "/events", "/daily", "/daily/dates",
        "/daily-today", "/daily/recent", "/goals", "/tags", "/glimpse", "/theme.css", "/theme.json",
        "/ambient", "/activity", "/canon", "/timeline", "/routines", "/projects",
        "/reading", "/reading/next", "/reading/archive", "/reading/inbox/list",
        "/learning", "/learning/queue", "/learning/flags", "/learning/atlas",
        "/notes/all", "/note/inbox", "/notes/graph", "/notes/archived", "/note/history",
        "/app/overview", "/app/authors", "/app/citations", "/app/projects",
        "/drafting/papers", "/drafting/grants", "/drafting/reports", "/drafting/presentations",
        "/drafting/audit", "/explore/index", "/explore/selection", "/systems/tree",
        "/search?q=sample", "/cache-info", "/vault-path",
        "/board?path=" + BOARD.replace("/", "%2F"), "/v/today", "/v/reading", "/w/tasks",
    )

    def test_kept_gets_answer_200(self):
        for path in self.PATHS:
            status, _, body = _get(path)
            self.assertEqual(status, 200, "%s -> %s %s" % (path, status, body[:200]))

    def test_favicon_is_204(self):
        self.assertEqual(_get("/favicon.ico")[0], 204)

    def test_theme_routes_are_empty(self):
        self.assertEqual(_get("/theme.css")[2], b"")
        self.assertEqual(json.loads(_get("/theme.json")[2]), {})

    def test_rebuild_cache_then_read_it(self):
        self.assertEqual(_post("/rebuild-cache", {})[0], 200)
        status, _, body = _get("/dashboard-data.json")
        self.assertEqual(status, 200)
        self.assertIsInstance(json.loads(body), dict)

    def test_routines_is_habits_and_the_configured_sections(self):
        data = json.loads(_get("/routines")[2])
        self.assertIn("habits", data)
        known = {"exists", "words", "dailyNotes", "work", "workFilled", "morningFilled", "todayFilled",
                 "eodFilled", "eodHappened", "eodSentence", "eodTomorrow"}
        self.assertLessEqual(set(data["sections"]), known)

    def test_head_has_no_body(self):
        status, headers, body = _get("/", method="HEAD")
        self.assertEqual(status, 200)
        self.assertEqual(body, b"")


class Bodies(unittest.TestCase):
    def _head(self, extra):
        return (b"POST /board/add?path=Planning/Tasks.md HTTP/1.1\r\nHost: 127.0.0.1:%d\r\n"
                b"Content-Type: application/json\r\n" % PORT) + extra + b"\r\n"

    def test_chunked_post_is_refused(self):
        code = _raw(self._head(b"Transfer-Encoding: chunked\r\n") + b"5\r\nhello\r\n0\r\n\r\n")
        self.assertIn(code, (411, 413))

    def test_chunked_with_a_length_is_refused(self):
        code = _raw(self._head(b"Transfer-Encoding: chunked\r\nContent-Length: 2\r\n") + b"{}")
        self.assertIn(code, (411, 413))

    def test_negative_length_is_400_and_does_not_wait(self):
        t0 = time.time()
        self.assertEqual(_raw(self._head(b"Content-Length: -1\r\n")), 400)
        self.assertLess(time.time() - t0, 5)

    def test_non_numeric_length_is_400(self):
        for value in (b"abc", b"1e3", b"+5", b"0x10", b"5, 5"):
            self.assertEqual(_raw(self._head(b"Content-Length: " + value + b"\r\n")), 400, value)

    def test_two_lengths_are_400(self):
        self.assertEqual(_raw(self._head(b"Content-Length: 2\r\nContent-Length: 2\r\n") + b"{}"), 400)

    def test_oversized_length_is_413(self):
        self.assertEqual(_raw(self._head(b"Content-Length: %d\r\n" % (64 * 1024 * 1024 + 1))), 413)

    def test_zero_length_post_to_unknown_route(self):
        t0 = time.time()
        self.assertEqual(_post("/no/such/route")[0], 404)
        self.assertEqual(_get("/no/such/route", JSON, "POST", None)[0], 404)
        self.assertLess(time.time() - t0, 5)
        self.assertEqual(_get("/health")[0], 200)

    def test_zero_length_post_to_every_kind_of_route_answers(self):
        for path in ("/board/add?path=Planning/Tasks.md", "/events/create", "/daily/habit",
                     "/note/capture", "/reading/status", "/drafting/save", "/explore/render",
                     "/planning/next", "/learning/flag", "/project/finalize", "/w/panel/event",
                     "/systems/domain", "/board/proposals"):
            status = _post(path)[0]
            self.assertLess(status, 500, "%s -> %s" % (path, status))
        self.assertEqual(_get("/health")[0], 200)

    def test_a_body_that_is_not_an_object_is_400(self):
        for path in ("/events/create", "/daily/habit", "/goals/toggle", "/no/such/route"):
            for body in (b"[1, 2]", b'"text"', b"7", b"null", b"not json"):
                self.assertEqual(_get(path, JSON, "POST", body)[0], 400, (path, body))
        self.assertEqual(_get("/health")[0], 200)


class Actions(unittest.TestCase):
    GETS = ("/open?file=Preparation/Reading/x.md", "/open-url?url=http://example.invalid/",
            "/obsidian/open?file=" + CITATION.replace(" ", "%20"),
            "/w/figure/select?source=project&slug=a&stem=b", "/explore/select?source=project&slug=a&stem=b",
            "/drafting/open-dir?which=project&slug=sample%20grant",
            "/drafting/open-pdf?slug=sample%20grant", "/drafting/open-report?id=x")

    def test_a_get_never_acts(self):
        before = _opened()
        for path in self.GETS:
            self.assertEqual(_get(path)[0], 405, path)
            self.assertEqual(_get(path, {"Sec-Fetch-Site": "same-origin"})[0], 405, path)
        _get("/drafting/outline-pdf?slug=sample%20grant&open=1")
        _get("/explore/selection?consume=1")
        time.sleep(0.3)
        self.assertEqual(_opened(), before)

    def test_outline_pdf_get_never_compiles(self):
        built = PROJ / "writing" / "build" / "outline"
        for q in ("", "&inline=1", "&open=1"):
            status, _, body = _get("/drafting/outline-pdf?slug=sample%20grant" + q)
            self.assertEqual(status, 404, body)
        self.assertFalse(built.exists())

    def test_outline_pdf_post_builds_then_get_serves_it(self):
        if not shutil.which("pdflatex"):
            self.skipTest("pdflatex is not installed")
        before = _opened()
        status, _, body = _post("/drafting/outline-pdf", {"slug": SLUG}, PAGE)
        if status == 400:
            self.skipTest("the outline did not typeset here: %s" % body[:200])
        self.assertEqual(status, 200, body)
        time.sleep(0.3)
        self.assertEqual(_opened(), before)
        status, headers, body = _get("/drafting/outline-pdf?slug=sample%20grant")
        self.assertEqual(status, 200)
        self.assertEqual(headers.get("Content-Type"), "application/pdf")
        self.assertTrue(body.startswith(b"%PDF"))

    def test_a_dry_get_only_resolves(self):
        before = _opened()
        status, _, body = _get("/drafting/open-dir?which=project&slug=sample%20grant&dry=1")
        self.assertEqual(status, 200, body)
        data = json.loads(body)
        self.assertTrue(data["dry"])
        self.assertIn("path", data)
        status, _, body = _get("/obsidian/open?dry=1&file=" + CITATION.replace(" ", "%20"))
        self.assertEqual(status, 200, body)
        self.assertTrue(json.loads(body)["dry"])
        time.sleep(0.3)
        self.assertEqual(_opened(), before)

    def test_post_without_sec_fetch_site_is_refused(self):
        before = _opened()
        body = {"url": "http://example.invalid/", "file": CITATION, "slug": SLUG,
                "source": "project", "stem": "b", "deck": "d"}
        for path in ("/open", "/open-url", "/obsidian/open", "/present/open", "/w/figure/select",
                     "/explore/select", "/explore/selection", "/drafting/outline-pdf",
                     "/drafting/open-dir", "/drafting/open-pdf", "/drafting/open-anything"):
            self.assertEqual(_post(path, body)[0], 403, path)
            for site in ("none", "same-site", "cross-site"):
                headers = dict(JSON, **{"Sec-Fetch-Site": site})
                self.assertEqual(_post(path, body, headers)[0], 403, "%s %s" % (path, site))
        time.sleep(0.3)
        self.assertEqual(_opened(), before)

    def test_post_from_a_foreign_origin_is_refused(self):
        headers = dict(PAGE, Origin="http://evil.example")
        self.assertEqual(_post("/open-url", {"url": "http://example.invalid/"}, headers)[0], 403)

    def test_same_origin_post_opens(self):
        url = "http://example.invalid/opened-by-the-test"
        self.assertEqual(_post("/open-url", {"url": url}, PAGE)[0], 204)
        for _ in range(50):
            if url in _opened():
                break
            time.sleep(0.1)
        self.assertIn(url, _opened())

    def test_open_url_takes_web_links_only(self):
        before = _opened()
        for url in ("file:///etc/hostname", "javascript:alert(1)", "obsidian://open?vault=x", "-h"):
            self.assertEqual(_post("/open-url", {"url": url}, PAGE)[0], 204)
        time.sleep(0.3)
        self.assertEqual(_opened(), before)

    def test_selection_is_put_read_and_taken(self):
        sel = {"source": "project", "slug": "a paper", "stem": "fig.01", "project": "a paper"}
        self.assertEqual(_post("/explore/select", sel, PAGE)[0], 200)
        peek = json.loads(_get("/explore/selection?project=a%20paper&consume=1")[2])
        self.assertEqual(peek.get("stem"), "fig.01")
        again = json.loads(_get("/explore/selection?project=a%20paper")[2])
        self.assertEqual(again.get("stem"), "fig.01", "a GET must not consume")
        taken = json.loads(_post("/explore/selection", {"project": "a paper"}, PAGE)[2])
        self.assertEqual(taken.get("stem"), "fig.01")
        self.assertEqual(json.loads(_get("/explore/selection?project=a%20paper")[2]), {})


class Traversal(unittest.TestCase):
    def test_citation_status_refuses_paths_outside_the_folder(self):
        target = VAULT / OUTSIDE
        target.write_text("---\nstatus: untouched\n---\nbody\n", encoding="utf-8")
        loose = TMP / "loose.md"
        loose.write_text("---\nstatus: untouched\n---\nbody\n", encoding="utf-8")
        nested = VAULT / "Preparation" / "Notes" / "Reading" / "Citations"
        nested.mkdir(parents=True)
        (nested / "decoy.md").write_text("---\nstatus: untouched\n---\n", encoding="utf-8")
        bad = (
            "../loose.md", "../../loose.md", str(loose), str(target), OUTSIDE,
            "Preparation/Reading/Citations/../../Notes/Ideas/Sample idea.md",
            "Preparation/Reading/Citations/../Citations/../../Notes/Ideas/Sample idea.md",
            "Preparation/Notes/Reading/Citations/decoy.md",
            "/Preparation/Reading/Citations/x.md",
            "Preparation/Reading/Citations/",
            "Preparation/Reading/Citations/sub/x.md",
            "Preparation\\Reading\\Citations\\..\\..\\Notes\\Ideas\\Sample idea.md",
        )
        for cp in bad:
            status = _post("/reading/status", {"citationPath": cp, "state": "read"})[0]
            self.assertEqual(status, 400, cp)
        for f in (target, loose, nested / "decoy.md"):
            self.assertIn("status: untouched", f.read_text(encoding="utf-8"), f)

    def test_a_link_out_of_the_folder_is_refused(self):
        outside = TMP / "linked.md"
        outside.write_text("---\nstatus: untouched\n---\n", encoding="utf-8")
        link = VAULT / "Preparation" / "Reading" / "Citations" / "Linked (2003) - Elsewhere.md"
        try:
            link.symlink_to(outside)
        except OSError:
            self.skipTest("no symlinks here")
        cp = "Preparation/Reading/Citations/" + link.name
        self.assertEqual(_post("/reading/status", {"citationPath": cp, "state": "read"})[0], 400)
        self.assertIn("status: untouched", outside.read_text(encoding="utf-8"))

    def test_a_real_citation_note_is_updated(self):
        note = VAULT / CITATION
        if not note.read_text(encoding="utf-8").startswith("---"):
            self.skipTest("the sample note has no frontmatter")
        status, _, body = _post("/reading/status", {"citationPath": CITATION, "state": "reading"})
        self.assertEqual(status, 200, body)
        self.assertRegex(note.read_text(encoding="utf-8"), r"(?m)^status: reading$")
        self.assertEqual(_post("/reading/status", {"citationPath": CITATION, "state": "x\ny: 1"})[0], 400)

    def test_board_paths_are_an_allow_list(self):
        for path in ("Preparation/Other/Tasks.md", "../Planning/Tasks.md", "Projects/papers/../PATH.md",
                     "Projects/papers/archive/PATH.md", "/etc/hostname",
                     "Planning/Tasks.md/../../x", "Planning/TasksXmd", "Planning/Goals.md", ""):
            self.assertEqual(_get("/board?path=" + urllib.request.quote(path, safe=""))[0], 400, path)

    def test_no_source_files_or_listings(self):
        for path in ("/serve.py", "/settings.py", "/..%2f..%2fserver/serve.py", "/assets/"):
            status, _, body = _get(path)
            self.assertNotEqual(status, 200, path)
            self.assertNotIn(b"Directory listing", body)


class Writes(unittest.TestCase):
    def test_board_add_toggle_and_archive(self):
        q = "?path=" + urllib.request.quote(BOARD, safe="")
        text = "Route test card %d" % int(time.time())
        status, _, body = _post("/board/add" + q, {"lane": "INBOX", "text": text})
        self.assertEqual(status, 200, body)
        board = json.loads(body)
        card = next(c for lane in board["lanes"] for c in lane["cards"] if c["text"] == text)
        self.assertFalse(card["done"])
        self.assertIn(text, (VAULT / BOARD).read_text(encoding="utf-8"))
        status, _, body = _post("/board/toggle" + q, {"raw": card["raw"]})
        self.assertEqual(status, 200, body)
        card = next(c for lane in json.loads(body)["lanes"] for c in lane["cards"] if c["text"] == text)
        self.assertTrue(card["done"])
        self.assertEqual(_post("/board/toggle" + q, {"raw": "- [ ] no such card"})[0], 409)
        self.assertEqual(_post("/board/nonsense" + q, {})[0], 404)

    def test_event_create_read_and_delete(self):
        status, _, body = _post("/events/create", {"title": "Route test event", "date": "2031-02-03",
                                                   "category": "meetings", "project": "Sample Tag"})
        self.assertEqual(status, 200, body)
        rel = json.loads(body)["path"]
        self.assertTrue((VAULT / rel).is_file())
        self.assertEqual(_get("/events/read?path=" + urllib.request.quote(rel, safe=""))[0], 200)
        self.assertEqual(_post("/events/delete", {"path": rel})[0], 200)
        self.assertFalse((VAULT / rel).exists())
        self.assertEqual(_post("/events/create", {"title": "x", "date": "2031-02-03",
                                                  "category": "../../x"})[0], 400)

    def test_removed_journal_sections_are_not_writable(self):
        for anchor in ("unknown-section", "nonsense"):
            self.assertEqual(_post("/daily/section", {"anchor": anchor, "text": "x"})[0], 400, anchor)
        self.assertEqual(_post("/daily/habit", {"key": "not-a-habit"})[0], 400)

    def test_cross_origin_post_is_refused(self):
        headers = dict(JSON, Origin="http://evil.example")
        q = "?path=" + urllib.request.quote(BOARD, safe="")
        self.assertEqual(_post("/board/add" + q, {"lane": "INBOX", "text": "x"}, headers)[0], 403)
        self.assertEqual(_get("/today", {"Sec-Fetch-Site": "cross-site"})[0], 403)
        self.assertEqual(_get("/today", {"Host": "evil.example"})[0], 403)


if __name__ == "__main__":
    unittest.main()
