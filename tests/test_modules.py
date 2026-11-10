"""Module checks: file names are data, request names stay inside their folders, and vault
scripts run only when asked. They run on a temp copy of the sample vault and use no network.

Run from the repository root:  python -m unittest discover tests
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parents[1]
TMP = Path(tempfile.mkdtemp(prefix="aioa-modules-"))
VAULT = TMP / "vault"
STATE = TMP / "state"
GRANT = VAULT / "Projects" / "grants" / "module grant"     # has rules/compliance.json
PLAIN = VAULT / "Projects" / "grants" / "module plain"     # compiles like a paper
BRIEF = VAULT / "Projects" / "briefs" / "module brief"
KIT = VAULT / "Projects" / "toolkit"
ENV = {
    "HOME": str(TMP / "home"), "AIOA_VAULT": str(VAULT), "AIOA_STATE_DIR": str(STATE),
    "AIOA_CONFIG": str(TMP / "none.toml"), "AIOA_RUN_VAULT_SCRIPTS": "",
    "HTTP_PROXY": "http://127.0.0.1:9", "HTTPS_PROXY": "http://127.0.0.1:9",
    "http_proxy": "http://127.0.0.1:9", "https_proxy": "http://127.0.0.1:9",
    "PYTHONDONTWRITEBYTECODE": "1",
}
ODD_NAMES = [
    "a;touch INJECTED;.pdf",
    "$(touch INJECTED).pdf",
    "`touch INJECTED`.pdf",
    "a\" ; touch INJECTED ; \".pdf",
    "it's & two  spaces | touch INJECTED.pdf",
    "line\nbreak; touch INJECTED.pdf",
    "-o INJECTED.pdf",
]
MARKER_SCRIPT = ("from pathlib import Path\n"
                 "Path(__file__).with_suffix('.ran').write_text('ran', encoding='utf-8')\n"
                 "print('{\"ok\": false}')\n")
KIT_SCRIPTS = ("md_to_latex.py", "build_standalone_table.py", "build_docx.py", "build_syllabus.py",
               "export_overleaf.py", "build_report.py")
settings = None
_saved_env = {}


def _drop_server_modules():
    """Forget the app's modules so the next import reads this file's environment."""
    roots = (str(REPO / "server"),)
    for name, mod in list(sys.modules.items()):
        if str(getattr(mod, "__file__", None) or "").startswith(roots):
            del sys.modules[name]


def setUpModule():
    global settings
    _saved_env.update(os.environ)
    shutil.copytree(REPO / "examples" / "sample-vault", VAULT)
    (TMP / "home").mkdir()
    for proj in (GRANT, PLAIN):
        (proj / "writing" / "build").mkdir(parents=True)
        (proj / "writing" / "paper.md").write_text("# A Sample Title\n\nplaceholder\n", encoding="utf-8")
        (proj / "results").mkdir()
    (GRANT / "rules").mkdir()
    (GRANT / "rules" / "compliance.json").write_text("{}", encoding="utf-8")
    (GRANT / "writing" / "build" / "build.sh").write_text(
        '#!/bin/bash\nprintf \'%s\\n\' "$#" "$@" > "$(dirname "$0")/ran.txt"\n', encoding="utf-8")
    (PLAIN / "results" / "tab1.csv").write_text("a,b\n1,2\n", encoding="utf-8")
    (BRIEF / "writing").mkdir(parents=True)
    (BRIEF / "writing" / "report.md").write_text("---\ntitle: Sample\nformat: brief\n---\n\ntext\n", encoding="utf-8")
    (KIT / "scripts").mkdir(parents=True)
    for name in KIT_SCRIPTS:
        (KIT / "scripts" / name).write_text(MARKER_SCRIPT, encoding="utf-8")
    syl = VAULT / "Preparation" / "Reading" / "Syllabi" / "module course"
    syl.mkdir(parents=True)
    (syl / "syllabus.md").write_text("---\ntitle: Sample Course\n---\n\n## Week 1\n", encoding="utf-8")
    os.environ.update(ENV)
    sys.dont_write_bytecode = True
    _drop_server_modules()
    sys.path.insert(0, str(REPO / "server"))
    import settings as loaded
    settings = loaded


def tearDownModule():
    _drop_server_modules()
    os.environ.clear()
    os.environ.update(_saved_env)
    if not _saved_env.get("AIOA_TEST_KEEP"):
        shutil.rmtree(TMP, ignore_errors=True)


def _injected():
    """Every file a successful injection would have left behind."""
    return [p for root in (TMP, Path.cwd()) for p in root.rglob("INJECTED*")]


def _ran():
    return sorted(p.name for p in (KIT / "scripts").glob("*.ran"))


class _Recorder:
    """Stands in for subprocess.run: keeps the calls and reports success."""

    def __init__(self, stdout=""):
        self.calls = []
        self.stdout = stdout

    def __call__(self, argv, **kw):
        self.calls.append((argv, kw))
        return subprocess.CompletedProcess(argv, 0, stdout=self.stdout, stderr="")

    def check(self, case, value):
        """Each call is an argument list, has no shell, and carries `value` as one argument."""
        case.assertTrue(self.calls)
        for argv, kw in self.calls:
            case.assertIsInstance(argv, list)
            case.assertFalse(kw.get("shell"))
            case.assertNotIn(argv[0], ("bash", "sh", "/bin/sh", "/bin/bash"))
            case.assertIn(str(value), argv)


class FileNamesAreData(unittest.TestCase):
    def setUp(self):
        import drafting
        import litinbox
        self.drafting, self.litinbox = drafting, litinbox
        litinbox.INBOX.mkdir(parents=True, exist_ok=True)
        self.files = []
        for name in ODD_NAMES:
            p = litinbox.INBOX / name
            try:
                p.write_bytes(b"%PDF-1.4\n" + b"0" * 4096)
            except OSError:          # a name this filesystem cannot hold
                continue
            self.files.append(p)
        self.assertGreater(len(self.files), 3)

    def _patched(self, rec):
        return (mock.patch.object(self.drafting.subprocess, "run", rec),
                mock.patch.object(self.drafting.shutil, "which", lambda name: "/usr/bin/" + name))

    def test_inbox_commands_are_argument_lists(self):
        for p in self.files:
            rec = _Recorder(stdout="Pages: 3\nTitle: T\n")
            run, which = self._patched(rec)
            with run, which:
                self.assertEqual(self.litinbox._pdfinfo(p)["pages"], 3)
                self.litinbox._first_pages_text(p)
            self.assertEqual(len(rec.calls), 2)
            rec.check(self, p.resolve())
        self.assertEqual(_injected(), [])

    def test_inbox_with_the_real_tools(self):
        if not (shutil.which("pdfinfo") and shutil.which("pdftotext")):
            self.skipTest("poppler is not installed")
        for p in self.files:
            self.litinbox._pdfinfo(p)
            self.litinbox._first_pages_text(p)
            self.litinbox._gate(p)
            self.litinbox.detail(p.name)
        self.litinbox.list_inbox()
        self.assertEqual(_injected(), [])

    def test_pdf_readers_are_argument_lists(self):
        d = self.drafting
        for p in self.files:
            rec = _Recorder(stdout="Pages: 2\n")
            run, which = self._patched(rec)
            with run, which, mock.patch.object(d, "_publish_source_pdf", lambda *a, **k: p):
                self.assertTrue(d.pdf_text_layer(VAULT, "x", "paper.md").get("ok"))
                d.pdf_page_png(VAULT, "x", "paper.md", 1)
                d._pdf_pages(p)
                d._pdf_word_count(p)
            self.assertEqual(len(rec.calls), 4)
            rec.check(self, p)
        self.assertEqual(_injected(), [])

    def test_word_preview_is_an_argument_list(self):
        d = self.drafting
        for p in self.files:
            src = p.with_suffix(".docx")
            src.write_bytes(b"x")
            rec = _Recorder()
            run, which = self._patched(rec)
            with run, which:
                d._docx_to_pdf(src)
            rec.check(self, src)
        self.assertEqual(_injected(), [])

    def test_word_build_is_an_argument_list(self):
        d = self.drafting
        rec = _Recorder(stdout='{"ok": false}\n')
        run, which = self._patched(rec)
        with run, which, mock.patch.object(settings, "RUN_VAULT_SCRIPTS", True):
            d.compile_docx(VAULT, "module plain")
        rec.check(self, KIT / "scripts" / "build_docx.py")
        argv = rec.calls[0][0]
        self.assertEqual(argv[0], sys.executable)
        self.assertIn("writing/paper.md", argv)

    def test_build_sh_gets_the_file_name_as_one_argument(self):
        if not shutil.which("bash"):
            self.skipTest("bash is not installed")
        d = self.drafting
        ran = GRANT / "writing" / "build" / "ran.txt"
        for name in ("a;touch INJECTED;.md", "$(touch INJECTED).md", "`touch INJECTED`.md",
                     "a\" ; touch INJECTED ; \".md", "two  spaces 'q'.md"):
            manu = GRANT / "writing" / name
            manu.write_text("text\n", encoding="utf-8")
            with mock.patch.object(settings, "RUN_VAULT_SCRIPTS", True):
                d._compile_grant(VAULT, GRANT, manu, 30)
            self.assertEqual(ran.read_text(encoding="utf-8"), "1\n" + name + "\n")
            ran.unlink()
        self.assertEqual(_injected(), [])


class VaultScripts(unittest.TestCase):
    def setUp(self):
        import drafting
        self.d = drafting
        for p in (KIT / "scripts").glob("*.ran"):
            p.unlink()

    def test_off_by_default(self):
        self.assertFalse(settings.RUN_VAULT_SCRIPTS)
        self.assertFalse(self.d.vault_scripts_enabled())

    def test_build_sh_is_not_run_when_off(self):
        ran = GRANT / "writing" / "build" / "ran.txt"
        manu = GRANT / "writing" / "paper.md"
        r = self.d._compile_grant(VAULT, GRANT, manu, 30)
        self.assertEqual(r.get("error"), self.d.VAULT_SCRIPTS_OFF)
        self.assertEqual(self.d.compile_pdf(VAULT, "module grant").get("error"), self.d.VAULT_SCRIPTS_OFF)
        self.assertEqual(self.d.compile_docx(VAULT, "module grant").get("error"), self.d.VAULT_SCRIPTS_OFF)
        status = self.d.publish_setup(VAULT, "module grant")
        self.assertIs(status.get("vaultScripts"), False)
        self.assertFalse(status.get("autoCompileError"))
        self.assertFalse(ran.exists())

    def test_build_sh_runs_when_on(self):
        if not shutil.which("bash"):
            self.skipTest("bash is not installed")
        ran = GRANT / "writing" / "build" / "ran.txt"
        with mock.patch.object(settings, "RUN_VAULT_SCRIPTS", True):
            self.d._compile_grant(VAULT, GRANT, GRANT / "writing" / "paper.md", 30)
        self.assertEqual(ran.read_text(encoding="utf-8"), "1\npaper.md\n")
        ran.unlink()

    def test_toolkit_scripts_are_not_run_when_off(self):
        d = self.d
        off = d.VAULT_SCRIPTS_OFF
        self.assertEqual(d.compile_pdf(VAULT, "module plain").get("error"), off)
        self.assertEqual(d.compile_docx(VAULT, "module plain").get("error"), off)
        self.assertEqual(d.compile_pdf(VAULT, "module brief", "report.md").get("error"), off)
        self.assertEqual(d.diff_pdf(VAULT, "module plain", a="current", b="current").get("error"), off)
        self.assertEqual(d.build_overleaf(VAULT, "module plain").get("error"), off)
        self.assertEqual(d.render_syllabus(VAULT, "syllabus/module course").get("error"), off)
        self.assertFalse(d._ensure_table_pdf(VAULT, "module plain", "tab1"))
        d.table_png(VAULT, "module plain", "tab1.pdf")
        self.assertEqual(_ran(), [])

    def test_toolkit_script_runs_when_on(self):
        with mock.patch.object(settings, "RUN_VAULT_SCRIPTS", True):
            self.d._ensure_table_pdf(VAULT, "module plain", "tab1")
        self.assertEqual(_ran(), ["build_standalone_table.ran"])

    def test_vault_script_is_never_imported(self):
        with mock.patch.object(settings, "RUN_VAULT_SCRIPTS", True):
            self.assertEqual(self.d._tex_escape_inline("50% of $x_1$"), "50\\% of $x_1$")
        self.assertEqual(_ran(), [])
        self.assertEqual(self.d._math_spans("cost $5 and $6"), [])
        self.assertEqual(self.d._math_spans("$$a$$ and $b$"), [(0, 5, "a", True), (10, 13, "b", False)])

    def test_deck_renderer_inside_the_vault_is_refused_when_off(self):
        render = KIT / "scripts" / "render.mjs"
        render.write_text("// placeholder\n", encoding="utf-8")
        deck = PLAIN / "writing" / "talk.md"
        deck.write_text("---\nmarp: true\n---\n\n# Slide\n", encoding="utf-8")
        rec = _Recorder()
        with mock.patch.object(self.d.subprocess, "run", rec), \
                mock.patch.object(self.d.shutil, "which", lambda name: "/usr/bin/" + name), \
                mock.patch.dict(os.environ, {"AIOA_MARP_RENDER": str(render)}), \
                mock.patch.object(self.d, "_deck_path", lambda *a, **k: deck):
            r = self.d.render_deck(VAULT, "module plain", "talk.md")
        self.assertEqual(r.get("error"), self.d.VAULT_SCRIPTS_OFF)
        self.assertEqual(rec.calls, [])


class StateFiles(unittest.TestCase):
    def test_status_files_land_in_the_state_dir(self):
        import drafting
        for f in (drafting.STATUS_FILE, drafting.FLAGS_FILE, drafting.IDS_FILE):
            self.assertEqual(f.parent, STATE)
        self.assertTrue(drafting.set_status("paper:a sample title:paper.md", "idea").get("ok"))
        self.assertTrue(drafting.set_pin("paper:a sample title:paper.md", True).get("ok"))
        self.assertIn("a sample title", (STATE / "drafting-status.json").read_text(encoding="utf-8"))
        self.assertIn("a sample title", (STATE / "drafting-flags.json").read_text(encoding="utf-8"))
        for name in ("drafting-status.json", "drafting-flags.json", "drafting-ids.json"):
            self.assertFalse((REPO / "server" / name).exists(), name)
        for f in (drafting._SOFFICE_PROFILE, drafting._PREVIEW_ROOT):
            self.assertTrue(f.is_relative_to(STATE), f)


class SyllabusSlugTest(unittest.TestCase):
    def setUp(self):
        import syllabi
        self.syllabi = syllabi
        text = ("---\ntitle: Sample Course\n---\n\n## Week 1\n\n"
                "- Doe, Jane. 2031. \"An Invented Article.\" *Sample Journal* 1(1):1-10.\n"
                "- Roe, Sam. 2030. *An Invented Book*. Sample Press.\n")
        good = syllabi.SYLLABI_DIR / "sample course"
        good.mkdir(parents=True, exist_ok=True)
        (good / "syllabus.md").write_text(text, encoding="utf-8")
        outside = syllabi.SYLLABI_DIR.parent / "x"          # what "../x" would reach
        outside.mkdir(parents=True, exist_ok=True)
        (outside / "syllabus.md").write_text(text, encoding="utf-8")

    def test_parent_slug_refused(self):
        res = self.syllabi.distill("../x", force=True)
        self.assertIn("error", res)
        self.assertFalse((self.syllabi.LISTS_DIR.parent / "x-readings.md").exists())
        self.assertIn("error", self.syllabi.push("../x"))

    def test_absolute_slug_refused(self):
        target = self.syllabi.SYLLABI_DIR.parent / "x"
        res = self.syllabi.distill(str(target), force=True)
        self.assertIn("error", res)
        self.assertFalse(Path(str(target) + "-readings.md").exists())
        self.assertIn("error", self.syllabi.push(str(target / "syllabus")))

    def test_odd_slugs_refused(self):
        for slug in ("", ".hidden", "a/b", "a\\b", "a*", "a?", "a[b]", "a\x00b", "..", None, 7):
            self.assertIn("error", self.syllabi.distill(slug, force=True), slug)
            self.assertIn("error", self.syllabi.push(slug), slug)

    def test_valid_slug(self):
        res = self.syllabi.distill("sample course", force=True)
        self.assertTrue(res.get("ok"), res)
        out = Path(res["path"])
        self.assertEqual(out.resolve().parent, self.syllabi.LISTS_DIR.resolve())
        self.assertEqual(res["readings"], 2)


class MilestoneIdTest(unittest.TestCase):
    def setUp(self):
        import projectplan
        self.pp = projectplan
        self.dl = projectplan.DEADLINES_DIR
        self.dl.mkdir(parents=True, exist_ok=True)

    def test_deadline_path_refuses_bad_ids(self):
        for mid in ("a/b", "..", "../x", "a*", "a?", "a[1]", ".a", "a\\b", "a\x00", ""):
            with self.assertRaises(ValueError, msg=mid):
                self.pp._deadline_path("plan", mid)
            with self.assertRaises(ValueError, msg=mid):
                self.pp._deadline_path(mid, "m1")
        self.assertEqual(self.pp._deadline_path("plan", "m1").parent, self.dl)

    def test_write_deadlines_refuses_raw_bad_ids(self):
        decoy = VAULT / "decoy-outside.md"
        decoy.write_text("keep\n", encoding="utf-8")
        before = sorted(p.name for p in self.dl.iterdir())
        for mid in ("../../decoy-outside", "a/b", "*"):
            ms = [{"id": mid, "title": "T", "date": "2031-02-01", "calendar": True}]
            with self.assertRaises(ValueError):
                self.pp.write_deadlines(ms, "rawplan")
        self.assertEqual(decoy.read_text(encoding="utf-8"), "keep\n")
        self.assertEqual(sorted(p.name for p in self.dl.iterdir()), before)

    def test_ids_are_normalised_everywhere(self):
        ms = self.pp._clean_milestones([
            {"id": "../../evil", "title": "First", "date": "2031-02-01"},
            {"id": "a*b?[c]", "title": "Second", "date": "2031-02-02", "dependsOn": ["../../evil"]},
            {"id": "Keep_Me-1", "title": "Third", "date": "2031-02-03"}])
        for m in ms:
            self.assertRegex(m["id"], r"\A[A-Za-z0-9][A-Za-z0-9_-]*\Z")
        self.assertEqual(ms[2]["id"], "Keep_Me-1")
        self.assertEqual(ms[1]["dependsOn"], [ms[0]["id"]])
        t = self.pp._clean_tasks([{"text": "do it", "milestone": "../../evil"}])[0]
        self.assertEqual(t["milestone"], ms[0]["id"])

    def test_finalize_keeps_decoys(self):
        outside = VAULT / "evil.md"
        outside.write_text("outside\n", encoding="utf-8")
        alongside = self.dl / "globplan-unrelated.md"          # same prefix, not written by a plan
        alongside.write_text("---\ntitle: mine\n---\nhand written\n", encoding="utf-8")
        other_plan = self.dl / "globplan-two-m1.md"            # belongs to the plan "globplan-two"
        other_plan.write_text("**Source:** project plan (globplan-two). x\n", encoding="utf-8")
        stale = self.dl / "globplan-gone.md"                   # this plan's, milestone removed
        stale.write_text("**Source:** project plan (globplan). x\n", encoding="utf-8")
        before = {p.name for p in self.dl.iterdir()}

        self.pp.create({"title": "Globplan", "slug": "globplan",
                        "hardDeadline": {"date": "2031-03-01"},
                        "milestones": [{"id": "../../evil", "title": "Draft", "date": "2031-02-01"},
                                       {"id": "*", "title": "Revise", "date": "2031-02-10"},
                                       {"id": "a/b", "title": "Send", "date": "2031-02-20"}]})
        res = self.pp.finalize(slug="globplan")
        self.assertEqual(len(res["calendar"]), 3)
        for rel in res["calendar"]:
            self.assertEqual((VAULT / rel).resolve().parent, self.dl.resolve())
        self.assertEqual(res["board"], settings.TASKS_BOARD_REL)
        self.assertEqual(outside.read_text(encoding="utf-8"), "outside\n")
        self.assertTrue(alongside.is_file())
        self.assertTrue(other_plan.is_file())
        self.assertFalse(stale.exists())
        after = {p.name for p in self.dl.iterdir()}
        self.assertEqual(len(after - before), 3)
        self.assertTrue((VAULT / settings.GOALS_REL).is_file())


class NotesFilenameTest(unittest.TestCase):
    def setUp(self):
        import notes_organizer
        self.no = notes_organizer
        self.no.INBOX.mkdir(parents=True, exist_ok=True)

    def test_absolute_path_outside_notes_refused(self):
        for decoy in (STATE / "decoy-abs.md", VAULT / "decoy-abs.md"):
            decoy.parent.mkdir(parents=True, exist_ok=True)
            decoy.write_text("leave me\n", encoding="utf-8")
            res = self.no.file_note(str(decoy), "ideas")
            self.assertFalse(res.get("ok"), res)
            self.assertEqual(decoy.read_text(encoding="utf-8"), "leave me\n")

    def test_parent_relative_refused(self):
        decoy = self.no.NOTES / "decoy-rel.md"
        decoy.write_text("leave me\n", encoding="utf-8")
        deep = VAULT / "decoy-deep.md"
        deep.write_text("leave me\n", encoding="utf-8")
        for name in ("../decoy-rel.md", "../../../decoy-deep.md", "sub/../../decoy-rel.md",
                     "..", ".hidden.md", "a*.md", "x\x00.md", ""):
            res = self.no.file_note(name, "ideas")
            self.assertFalse(res.get("ok"), name)
        self.assertEqual(decoy.read_text(encoding="utf-8"), "leave me\n")
        self.assertEqual(deep.read_text(encoding="utf-8"), "leave me\n")

    def test_inbox_name_files(self):
        made = self.no.capture("a sample thought", title="Sample thought b")
        self.assertTrue(made.get("ok"), made)
        name = Path(made["rel"]).name
        res = self.no.file_note(name, "ideas")
        self.assertTrue(res.get("ok"), res)
        self.assertTrue((VAULT / res["dest"]).is_file())
        self.assertFalse((self.no.INBOX / name).exists())


class BoardProposalTest(unittest.TestCase):
    def test_default_board_is_the_configured_one(self):
        import boardproposals
        self.assertEqual(boardproposals.TASKS_BOARD, settings.TASKS_BOARD_REL)
        board = VAULT / settings.TASKS_BOARD_REL
        self.assertTrue(board.is_file())
        rec = boardproposals.add({"text": "Sample proposal b: file the invented form",
                                  "due": "2031-01-18", "priority": "high", "est": "30m", "tag": "sample"})
        self.assertEqual(rec["board"], settings.TASKS_BOARD_REL)
        res = boardproposals.accept(rec["id"])
        self.assertEqual(res["board"], settings.TASKS_BOARD_REL)
        self.assertEqual(res["body"], "Sample proposal b: file the invented form "
                                      "@due(2031-01-18) @high @est(30m) #sample")
        self.assertIn("- [ ] " + res["body"], board.read_text(encoding="utf-8"))

    def test_other_boards_refused(self):
        import boardproposals
        for board in ("../outside.md", "/etc/hosts", "Planning/Other.md",
                      "Projects/papers/x/../../../PATH.md", "Projects/papers/../PATH.md",
                      "Projects/papers/archive/PATH.md", "Projects/papers/.hidden/PATH.md"):
            with self.assertRaises(ValueError, msg=board):
                boardproposals.add({"text": "Sample proposal b refused", "board": board})


class ProjectPrefix(unittest.TestCase):
    def test_default_is_empty_and_skips_hidden_and_archive(self):
        self.assertEqual(settings.PROJECT_PREFIX, "")
        self.assertEqual(settings.live_slug("sample paper"), "sample paper")
        for name in ("archive", ".hidden", ""):
            self.assertIsNone(settings.live_slug(name), name)
        self.assertEqual(settings.strip_prefix("sample paper"), "sample paper")

    def test_a_configured_prefix_is_honoured(self):
        with mock.patch.object(settings, "PROJECT_PREFIX", "active - "):
            self.assertEqual(settings.live_slug("active - sample paper"), "sample paper")
            self.assertIsNone(settings.live_slug("sample paper"))
            self.assertEqual(settings.strip_prefix("active - sample paper"), "sample paper")


FIG_ID = "20310101-120000-sample-figure"
DATA_MARKER_SCRIPT = (
    "import pathlib, sys\n"
    "pathlib.Path(__file__).with_name('RAN.marker').write_text('ran')\n"
    "sys.stdout.write('<svg/>')\n")


def _c_vault():
    """A throwaway vault with a data folder, one stored figure and marker scripts."""
    root = Path(tempfile.mkdtemp(prefix="c-", dir=TMP))
    data = root / "Projects" / "data"
    fig = root / "Projects" / "scratch" / "figures" / FIG_ID
    fig.mkdir(parents=True)
    data.mkdir(parents=True)
    (fig / "spec.json").write_text(json.dumps(
        {"id": FIG_ID, "kind": "vl", "version": 1, "vl": {"mark": "bar"}}), encoding="utf-8")
    (data / "vlrender.py").write_text(DATA_MARKER_SCRIPT, encoding="utf-8")
    (data / "figtool.py").write_text(DATA_MARKER_SCRIPT, encoding="utf-8")
    (data / "panel_profile.py").write_text(DATA_MARKER_SCRIPT, encoding="utf-8")
    return root


def _c_proc(code=0, out=b"<svg/>"):
    return types.SimpleNamespace(returncode=code, stdout=out, stderr=b"")


class ExploreVaultScripts(unittest.TestCase):
    def setUp(self):
        import explore
        import settings
        self.explore, self.settings = explore, settings
        self.vault = _c_vault()
        self.addCleanup(shutil.rmtree, self.vault, True)
        self.marker = self.vault / "Projects" / "data" / "RAN.marker"

    def test_off_renderer_is_not_run(self):
        ex = self.explore
        self.assertFalse(self.settings.RUN_VAULT_SCRIPTS)
        raw, err = ex.render_preview(self.vault, FIG_ID, {"mark": "bar"})
        self.assertIsNone(raw)
        self.assertEqual(err, {"error": ex.SCRIPTS_OFF})
        self.assertIn("run_vault_scripts", err["error"])
        raw, ctype, err = ex.render_saved(self.vault, FIG_ID, "night")
        self.assertIsNone(raw)
        self.assertEqual(err, {"error": ex.SCRIPTS_OFF})
        self.assertFalse(self.marker.exists())

    def test_off_producer_module_is_not_run(self):
        ex = self.explore
        with mock.patch.object(ex.subprocess, "run") as run:
            res = ex.refetch(self.vault, FIG_ID)
            ok, detail = ex._figtool(self.vault, ["index"])
        run.assert_not_called()
        self.assertEqual(res, {"error": ex.SCRIPTS_OFF})
        self.assertEqual((ok, detail), (False, ex.SCRIPTS_OFF))
        self.assertFalse(self.marker.exists())

    def test_off_is_reported_to_the_view(self):
        ex = self.explore
        self.assertIs(ex.load_index(self.vault)["canRender"], False)
        self.assertIs(ex.load_figure(self.vault, FIG_ID)["canRender"], False)
        with mock.patch.object(self.settings, "RUN_VAULT_SCRIPTS", True):
            self.assertIs(ex.load_index(self.vault)["canRender"], True)

    def test_on_renderer_argv_is_a_list(self):
        ex = self.explore
        with mock.patch.object(self.settings, "RUN_VAULT_SCRIPTS", True), \
                mock.patch.object(ex.subprocess, "run", return_value=_c_proc()) as run:
            raw, err = ex.render_preview(self.vault, FIG_ID, {"mark": "bar"},
                                         theme="night; touch /tmp/x")
        self.assertIsNone(err)
        self.assertEqual(raw, b"<svg/>")
        argv = run.call_args.args[0]
        self.assertIsInstance(argv, list)
        self.assertTrue(all(isinstance(a, str) for a in argv))
        self.assertNotIn("shell", run.call_args.kwargs)
        fig = (self.vault / "Projects" / "scratch" / "figures" / FIG_ID).resolve()
        self.assertIn(str(fig), argv)
        # an unknown theme falls back to "day"; the caller's text never reaches argv
        self.assertEqual(argv[argv.index("--theme") + 1], "day")
        self.assertFalse(any("touch" in a for a in argv))

    def test_on_producer_argv_is_a_list(self):
        ex = self.explore
        with mock.patch.object(self.settings, "RUN_VAULT_SCRIPTS", True), \
                mock.patch.object(ex.subprocess, "run", return_value=_c_proc(0, b"ok")) as run:
            ok, _ = ex._figtool(self.vault, ["refetch", FIG_ID])
        self.assertTrue(ok)
        argv = run.call_args.args[0]
        self.assertIsInstance(argv, list)
        self.assertEqual(argv[1:], ["-m", "figtool", "refetch", FIG_ID])
        self.assertNotIn("shell", run.call_args.kwargs)

    def test_bad_figure_ids_are_refused(self):
        ex = self.explore
        for fid in ("../" + FIG_ID, "..", "/etc", FIG_ID + "/..", ""):
            self.assertIsNone(ex.fig_dir(self.vault, fid), fid)
            self.assertEqual(ex.load_figure(self.vault, fid), {"error": "unknown figure"})

    def test_queue_is_in_the_state_dir(self):
        ex = self.explore
        base = ex.load_comments(self.vault, FIG_ID)
        saved = ex.save_comments(self.vault, FIG_ID,
                                 [{"id": "c1", "body": "look at this", "x": 0, "y": 0}],
                                 base["version"])
        self.assertTrue(saved.get("ok"), saved)
        res = ex.to_agent(self.vault, FIG_ID, "c1")
        self.assertTrue(res.get("ok"), res)
        queue = Path(res["queue"])
        self.assertTrue(queue.is_file())
        self.assertTrue(queue.resolve().is_relative_to(Path(STATE).resolve()))
        self.assertEqual([p.name for p in self.vault.iterdir()], ["Projects"])


class PanelVaultScripts(unittest.TestCase):
    def setUp(self):
        import panel
        import settings
        self.panel, self.settings = panel, settings
        self.vault = _c_vault()
        self.addCleanup(shutil.rmtree, self.vault, True)
        self.data = self.vault / "Projects" / "data"
        self.marker = self.data / "RAN.marker"
        self.csv = self.data / "fam" / "my data; x.csv"
        self.csv.parent.mkdir()
        self.csv.write_text("a,b\n1,2\n", encoding="utf-8")

    def _job(self, cid):
        return {"cacheid": cid, "path": self.csv, "family": None, "key": None,
                "script": self.panel.profiler_path(self.vault)}

    def test_off_profiler_is_not_run(self):
        p = self.panel
        self.assertFalse(p.profiler_enabled())
        with mock.patch.object(p.subprocess, "run") as run:
            res = p.dataset(self.vault, path=str(self.csv))
            p._run_profile(self._job("c" * 24))
        run.assert_not_called()
        self.assertTrue(res.get("ok"), res)
        self.assertEqual(res["profile"], "none")
        self.assertFalse(self.marker.exists())
        self.assertFalse(p.profile_path("c" * 24).exists())

    def test_on_profiler_argv_is_a_list(self):
        p = self.panel
        with mock.patch.object(self.settings, "RUN_VAULT_SCRIPTS", True), \
                mock.patch.object(p.subprocess, "run", return_value=_c_proc(1, b"")) as run:
            p._run_profile(self._job("d" * 24))
        argv = run.call_args.args[0]
        self.assertIsInstance(argv, list)
        self.assertNotIn("shell", run.call_args.kwargs)
        self.assertEqual(argv[1], str(p.profiler_path(self.vault)))
        self.assertEqual(argv[argv.index("--path") + 1], str(self.csv))   # one element
        out = argv[argv.index("--out") + 1]
        self.assertTrue(Path(out).resolve().is_relative_to(Path(STATE).resolve()))

    def test_state_and_dictionary_are_in_the_state_dir(self):
        p = self.panel
        if os.environ.get("AIOA_PANEL_DIR") or os.environ.get("AIOA_PANEL_CHEAT"):
            self.skipTest("panel paths are overridden in this environment")
        state = Path(STATE).resolve()
        self.assertTrue(p.state_dir().resolve().is_relative_to(state))
        self.assertTrue(p.cheat_path().resolve().is_relative_to(state))

    def test_ids_never_leave_the_state_dir(self):
        p = self.panel
        for bad in ("../x", "..", "a/b", "", None):
            self.assertIsNone(p._pushed_file(bad))
            self.assertIsNone(p._frame_file(bad))
        self.assertFalse(p.table(self.vault, tid="../../etc/passwd")["ok"])
        self.assertFalse(p.dataset(self.vault, frame="../x")["ok"])

    def test_data_paths_outside_the_vault_are_refused(self):
        p = self.panel
        for bad in ("/etc/passwd", str(self.data / ".." / ".." / ".." / "etc" / "passwd"),
                    "relative.csv"):
            path, why = p.resolve_data_path(self.vault, bad)
            self.assertIsNone(path, bad)
            self.assertTrue(why)

    def test_codebooks_scan_only_inside_the_family_folder(self):
        p = self.panel
        outside = self.vault / "Projects" / "outside"
        outside.mkdir()
        (outside / "k_codebook.pdf").write_bytes(b"%PDF-1.4\n")
        (self.data / "fam" / "k_codebook.pdf").write_bytes(b"%PDF-1.4\n")
        (self.data / "catalog.json").write_text(json.dumps({"families": {
            "fam": {"datasets": {"k": {"path": "fam/my data; x.csv", "format": "csv"}}},
            "../outside": {"datasets": {"k": {"path": "fam/my data; x.csv"}}},
        }}), encoding="utf-8")
        good = p.codebooks(self.vault, "fam", "k")
        self.assertTrue(good["ok"], good)
        self.assertEqual([d["hub_rel"] for g in good["groups"] for d in g["docs"]],
                         ["fam/k_codebook.pdf"])
        bad = p.codebooks(self.vault, "../outside", "k")
        self.assertFalse(bad["ok"])
        self.assertEqual(bad["groups"], [])

    def test_primary_family_comes_from_settings(self):
        p = self.panel
        cat = {"families": {self.settings.DATA_FAMILY: {"datasets": {"wave1": {}}}}}
        self.assertEqual(p._stata_globals(cat),
                         {(self.settings.DATA_FAMILY, "wave1"): self.settings.DATA_FAMILY + "_wave1"})
        self.assertEqual(p._STEM_DIR, self.settings.DATA_FAMILY + "/datasets/")


class StateDirPaths(unittest.TestCase):
    def _inside(self, p):
        self.assertTrue(Path(p).resolve().is_relative_to(Path(STATE).resolve()), str(p))

    def test_caches_ledger_and_lock(self):
        import chunkarchive, claims_index, coding, explore, openalex, quoteindex
        import reading, semindex, vault_search
        self._inside(explore.PREVIEW_DIR)
        self._inside(explore.queue_path())
        self._inside(chunkarchive.DEFAULT_ARCHIVE_ROOT)
        for env, value in (("OPENALEX_LEDGER", openalex.LEDGER),
                           ("AIOA_READING_LOCK", reading.LOCK_PATH),
                           ("VAULT_SEARCH_DB", vault_search.DB_PATH),
                           ("CLAIMS_INDEX_DB", claims_index.DB_PATH),
                           ("QUOTE_INDEX_DB", quoteindex.db_path()),
                           ("AIOA_SEMINDEX_DIR", semindex.state_dir()),
                           ("AIOA_CODING_STATE", coding._lock_dir())):
            if not os.environ.get(env):
                self._inside(value)

    def test_api_key_is_read_only_from_the_secrets_file(self):
        import openalex
        import settings
        clean = {k: v for k, v in os.environ.items()
                 if k not in ("OPENALEX_API_KEY", "OPENALEX_KEY")}
        secrets = Path(tempfile.mkdtemp(prefix="c-", dir=TMP)) / "secrets.env"
        self.addCleanup(shutil.rmtree, secrets.parent, True)
        with mock.patch.dict(os.environ, clean, clear=True), \
                mock.patch.object(settings, "SECRETS_FILE", secrets):
            self.assertIsNone(openalex._api_key())
            secrets.write_text('OPENALEX_API_KEY="from-settings"\n', encoding="utf-8")
            self.assertEqual(openalex._api_key(), "from-settings")


class NameGuards(unittest.TestCase):
    def test_citation_note_name_cannot_leave_the_folder(self):
        import litcite
        fields = {"title": "A Title", "authors": ["Given Fakename"], "year": "2031"}
        for stem in ("../evil", "a/b", ".hidden", "..", "", "a\\b"):
            res = litcite.write_on_file(stem, dict(fields))
            self.assertFalse(res.get("cited"), stem)
        self.assertFalse((litcite.CITATIONS.parent / "evil.md").exists())

    def test_archive_file_must_resolve_inside_the_archive(self):
        import reading
        made = not reading.ARCHIVE_DIR.exists()
        reading.ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)
        if made:
            self.addCleanup(shutil.rmtree, reading.ARCHIVE_DIR, True)
        outside = Path(tempfile.mkdtemp(prefix="c-", dir=TMP)) / "secret.md"
        outside.write_text("# not a list\n", encoding="utf-8")
        self.addCleanup(shutil.rmtree, outside.parent, True)
        link = reading.ARCHIVE_DIR / "c-link.md"
        link.symlink_to(outside)
        self.addCleanup(lambda: link.is_symlink() and os.remove(link))
        real = reading.ARCHIVE_DIR / "c-real.md"
        real.write_text("## List\n", encoding="utf-8")
        self.addCleanup(lambda: real.exists() and os.remove(real))
        self.assertIsNone(reading._archive_file("c-link.md"))
        self.assertIsNone(reading._archive_file("../c-real.md".replace("c-real", "missing")))
        self.assertIsNone(reading._archive_file(".hidden.md"))
        self.assertEqual(reading._archive_file("sub/../c-real.md"), real)

    def test_quote_index_edit_distance(self):
        import quoteindex
        self.assertEqual(quoteindex._levenshtein("kitten", "sitting", 5), 3)
        self.assertEqual(quoteindex._levenshtein("abc", "abc", 2), 0)
        self.assertEqual(quoteindex._levenshtein("aaaa", "bbbb", 2), 3)      # cap + 1
        self.assertEqual(quoteindex._strip_running_heads("HEAD\nbody one\nbody two\n12"),
                         "body one\nbody two")


if __name__ == "__main__":
    unittest.main()
