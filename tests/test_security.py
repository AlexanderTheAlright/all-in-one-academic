"""Security checks. They run on a temp copy of the sample vault and use no network.

Run from the repository root:  python -m unittest discover tests
"""
import hashlib
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
TMP = Path(tempfile.mkdtemp(prefix="aioa-tests-"))
VAULT = TMP / "vault"
STATE = TMP / "state"
SLUG = "sample grant"
PROJ = VAULT / "Projects" / "grants" / SLUG


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


PORT = _free_port()
ENV = {
    "HOME": str(TMP / "home"), "AIOA_VAULT": str(VAULT), "AIOA_STATE_DIR": str(STATE),
    "AIOA_PORT": str(PORT), "AIOA_CONFIG": str(TMP / "none.toml"),
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
    (PROJ / "results").mkdir()
    (PROJ / "results" / "verify.py").write_text('print("PASS")\n', encoding="utf-8")
    (PROJ / "results" / "mark.py").write_text(
        "from pathlib import Path\nPath(__file__).with_suffix('.ran').write_text('ran')\nprint('PASS')\n",
        encoding="utf-8")
    (PROJ / "results" / "provenance.json").write_text(json.dumps(
        {"fig.external": {"kind": "external", "statsSource": {"verifier": "results/mark.py"}}}), encoding="utf-8")
    (PROJ / "writing" / "stats.md").write_text("# Stats\n\n![[fig.external.png]]\n", encoding="utf-8")
    (PROJ / "secret.txt").write_text("outside the versions folder\n", encoding="utf-8")
    media = VAULT / "Preparation" / "Learning" / "_media"
    media.mkdir(parents=True)
    (media / "shape.svg").write_text('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>', encoding="utf-8")
    hidden = VAULT / "Projects" / ".secrets"
    hidden.mkdir(parents=True)
    (hidden / "findme-inside-secrets.txt").write_text("x", encoding="utf-8")
    (VAULT / "Projects" / ".env-findme").write_text("x", encoding="utf-8")
    (VAULT / "Projects" / "findme-plain.txt").write_text("x", encoding="utf-8")
    os.environ.update(ENV)
    sys.path[:0] = [str(REPO / "server")]
    SERVER = subprocess.Popen([sys.executable, str(REPO / "server" / "serve.py")], cwd=str(REPO / "server"),
                              env={**ENV, "PATH": os.environ.get("PATH", "")},
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
        with _OPENER.open(req, timeout=10) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


def _approve(*rels):
    path = STATE / "approved-verifiers.json"
    try:
        known = set(json.loads(path.read_text(encoding="utf-8")))
    except (OSError, ValueError):
        known = set()
    known |= {hashlib.sha256((PROJ / rel).read_bytes()).hexdigest() for rel in rels}
    path.write_text(json.dumps(sorted(known)), encoding="utf-8")


class Verifier(unittest.TestCase):
    def test_unapproved_is_refused_then_approved_runs(self):
        import drafting
        import settings
        from unittest import mock
        with mock.patch.object(settings, "RUN_VAULT_SCRIPTS", True):
            ok, detail = drafting._run_stats_verifier(PROJ, "results/verify.py")
            self.assertFalse(ok)
            self.assertIn("not approved", detail)
            _approve("results/verify.py")
            ok, detail = drafting._run_stats_verifier(PROJ, "results/verify.py")
            self.assertTrue(ok, detail)
            self.assertEqual(detail, "PASS")

    def test_an_approved_verifier_does_not_run_when_vault_scripts_are_off(self):
        import drafting
        import settings
        self.assertFalse(settings.RUN_VAULT_SCRIPTS)
        _approve("results/mark.py")
        ok, detail = drafting._run_stats_verifier(PROJ, "results/mark.py")
        self.assertFalse(ok)
        self.assertEqual(detail, drafting.VERIFIERS_SKIPPED)
        self.assertEqual(drafting.external_stats_offenders(VAULT, SLUG, docs=("stats.md",)), [])
        self.assertFalse((PROJ / "results" / "mark.ran").exists())

    def test_publish_and_verify_say_verifiers_were_skipped(self):
        import drafting
        _approve("results/mark.py")
        headers = {"Content-Type": "application/json"}
        body = json.dumps({"slug": SLUG, "doc": "stats.md"}).encode("utf-8")
        status, _, raw = _get("/drafting/verify", headers, "POST", body)
        self.assertEqual(status, 200, raw)
        self.assertEqual(json.loads(raw)["statsSources"].get("verifiersSkipped"), drafting.VERIFIERS_SKIPPED)
        status, _, raw = _get("/drafting/publish", headers, "POST", body)
        self.assertEqual(json.loads(raw).get("verifiersSkipped"), drafting.VERIFIERS_SKIPPED, raw)
        self.assertFalse((PROJ / "results" / "mark.ran").exists())

    def test_file_save_refuses_provenance(self):
        import drafting
        self.assertIsNotNone(drafting._project_dir(VAULT, SLUG))
        before = (PROJ / "results" / "provenance.json").read_text(encoding="utf-8")
        r = drafting.write_project_file(VAULT, SLUG, "results/provenance.json", '{"x": 1}')
        self.assertEqual(r.get("error"), "read-only file")
        self.assertEqual((PROJ / "results" / "provenance.json").read_text(encoding="utf-8"), before)


class Manifest(unittest.TestCase):
    def test_parent_path_in_manifest_is_not_followed(self):
        import drafting
        vdir = PROJ / "writing" / drafting.VERSIONS_DIR
        vid = "v20310115-000000-000"
        (vdir / (vid + ".artifacts")).mkdir(parents=True)
        (vdir / "versions.json").write_text(json.dumps({"versions": [
            {"id": vid, "doc": "paper.md", "file": "../../secret.txt", "artifacts": {"pdf": "../../../secret.txt"}}]}),
            encoding="utf-8")
        r = drafting.read_version(VAULT, SLUG, vid)
        self.assertNotIn("text", r)
        self.assertIn("error", r)
        self.assertIsNone(drafting.version_artifact_path(VAULT, SLUG, "paper.md", vid, "pdf"))


class Latex(unittest.TestCase):
    def test_every_pdflatex_command_disables_shell_escape(self):
        import drafting
        self.assertEqual(os.environ.get("openin_any"), "p")
        seen = 0
        for name in ("drafting.py", "outline_pdf.py"):
            src = (REPO / "server" / name).read_text(encoding="utf-8")
            for m in re.finditer(r'pdflatex(?:, "| )-[a-z-]+', src):
                seen += 1
                self.assertIn("-no-shell-escape", m.group(0), "%s: %s" % (name, m.group(0)))
        self.assertGreaterEqual(seen, 3)


class Http(unittest.TestCase):
    def test_svg_is_sandboxed_and_nosniff(self):
        status, headers, _ = _get("/learning/asset?path=Preparation/Learning/Sample%20deck.md&name=shape.svg")
        self.assertEqual(status, 200)
        self.assertIn("sandbox", headers.get("Content-Security-Policy", ""))
        self.assertEqual(headers.get("X-Content-Type-Options"), "nosniff")

    def test_cross_site_get_and_foreign_host_are_refused(self):
        self.assertEqual(_get("/today", {"Sec-Fetch-Site": "cross-site"})[0], 403)
        self.assertEqual(_get("/today", {"Host": "evil.example"})[0], 403)

    def test_no_source_files_or_listings(self):
        for path in ("/serve.py", "/settings.py", "/assets/", "/"):
            status, _, body = _get(path)
            self.assertNotIn(b"Directory listing", body)
            if path != "/":
                self.assertEqual(status, 404, path)

    def test_removed_routes_answer_404(self):
        post = {"Content-Type": "application/json"}
        self.assertEqual(_get("/retired/save", post, "POST", b'{"x": {}}')[0], 404)
        self.assertEqual(_get("/no-such-route")[0], 404)

    def test_sql_parameter_is_ignored(self):
        status, _, body = _get("/drafting/audit?sql=select+1")
        self.assertEqual(status, 200)
        self.assertNotIn(b'"rows"', body)

    def test_oversized_body_is_refused(self):
        s = socket.create_connection(("127.0.0.1", PORT), timeout=5)
        s.sendall(b"POST /x HTTP/1.1\r\nHost: 127.0.0.1:%d\r\nContent-Type: application/json\r\n"
                  b"Content-Length: %d\r\n\r\n" % (PORT, 10 ** 11))
        self.assertIn(b" 413 ", s.recv(200))
        s.close()


if __name__ == "__main__":
    unittest.main()
