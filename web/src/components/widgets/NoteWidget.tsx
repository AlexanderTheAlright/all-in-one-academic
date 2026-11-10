
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";
import { api } from "@/lib/api";
import type { NoteRead } from "@/lib/api";
import { DiagramDrawer } from "@/components/DiagramDrawer";
import type { NoteEditor } from "./noteEditor";

type Status = "idle" | "saved" | "dirty" | "saving" | "offline" | "conflict" | "gone";

type Cur = { path: string | null; hash?: string; saved: string; clientId?: string };
type Rec = Cur & { text: string; sel?: [number, number] };
type Read = NoteRead & { hash?: string };
type Item = { id: string; label: string; hint?: string; meta?: string; run: () => void };
type Overlay = { title: string; items: Item[]; empty: string } | null;

const MIRROR = "board-note-current";
const INBOX = "Preparation/Notes/Inbox/";
const same = (a: string, b: string) => a.trim() === b.trim();
const wordCount = (t: string) => (t.trim().match(/\S+/g) || []).length;
const today = () => { const d = new Date(), p = (n: number) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
const newId = () => { const b = new Uint8Array(16); crypto.getRandomValues(b); return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(""); };

const readMirror = (): Rec | null => {
  try {
    const r = JSON.parse(localStorage.getItem(MIRROR) || "null");
    if (!r || typeof r.text !== "string") return null;
    return { path: typeof r.path === "string" ? r.path : null, hash: typeof r.hash === "string" ? r.hash : undefined,
      saved: typeof r.saved === "string" ? r.saved : "", clientId: typeof r.clientId === "string" ? r.clientId : undefined, text: r.text, sel: r.sel };
  } catch { return null; }
};

// a note write that reports its HTTP status and throws only when the Board cannot be reached
async function send<T>(path: string, body: unknown, keepalive = false): Promise<{ status: number; data: T }> {
  const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), keepalive });
  if (r.status >= 500) throw new Error("board " + r.status);
  return { status: r.status, data: await r.json().catch(() => ({})) as T };
}
const readNote = async (path: string): Promise<Read | null> => {
  const r = await fetch("/note/read?path=" + encodeURIComponent(path));
  if (r.status >= 500) throw new Error("board " + r.status);
  return r.ok ? r.json() : null;
};

/* The filing target a path sits in ("inbox", "ideas", "project:papers/<dir>"), or null. */
const targetOf = (path: string): string | null => {
  const note = /^Preparation\/Notes\/([^/]+)\/[^/]+\.md$/.exec(path);
  if (note) return ["inbox", "ideas", "concepts", "meetings", "reflections", "authors"].find((k) => k === note[1].toLowerCase()) || null;
  const proj = /^Projects\/(papers|grants|briefs|experiments)\/([^/]+)\/logs\/\d{4}-\d{2}-\d{2}_[^/]+\.md$/.exec(path);
  if (proj) return `project:${proj[1]}/${proj[2]}`;
  const course = /^Preparation\/Teaching\/COURSES\/([^/]+)\/notes\/[^/]+\.md$/.exec(path);
  return course ? `project:courses/${course[1]}` : null;
};
const whereNow = async (path: string): Promise<string | null> => {
  const r = await fetch("/note/history?limit=200");
  if (r.status >= 500) throw new Error("board " + r.status);
  const items = ((await r.json()).items || []) as { from?: string; to?: string; undone?: boolean; restored?: string | null }[];
  let p = path;
  for (let hop = 0; hop < 5; hop++) {
    const e = items.find((x) => (x.undone ? x.to === p && !!x.restored : x.from === p));
    if (!e) break;
    p = (e.undone ? e.restored : e.to) || p;
  }
  return p === path ? null : p;
};

export function NoteWidget() {
  const host = useRef<HTMLDivElement>(null);
  const ed = useRef<NoteEditor | null>(null);
  const cur = useRef<Cur>({ path: null, saved: "" });
  const other = useRef<{ body: string; hash?: string } | null>(null);
  const busy = useRef<Promise<boolean> | null>(null);
  const again = useRef(false);
  const held = useRef(false);            // a switch or a move is in hand: no autosave under it
  const checking = useRef(false);
  const noteGen = useRef(0);             // counts the notes shown, so late work knows its note is gone
  const timer = useRef(0);
  const backoff = useRef(0);
  const statusRef = useRef<Status>("idle");
  const [status, setStatusState] = useState<Status>("idle");
  const [words, setWords] = useState(0);
  const [overlay, setOverlayState] = useState<Overlay>(null);
  // a list that loads after its overlay was closed (or replaced) must not come back
  const gen = useRef(0);
  const setOverlay = (o: Overlay) => { gen.current += 1; setOverlayState(o); };
  const listOf = async (title: string, load: () => Promise<{ items: Item[]; empty: string }>) => {
    setOverlay({ title, items: [], empty: "Loading" });
    const mine = gen.current, loaded = await load();
    if (gen.current === mine) setOverlayState({ title, ...loaded });
  };
  const [drawer, setDrawer] = useState<{ title: string; template?: unknown } | null>(null);
  const openRef = useRef(false);         // an overlay or the drawer has the keys
  openRef.current = !!overlay || !!drawer;

  const setStatus = (s: Status) => { statusRef.current = s; setStatusState(s); };
  const mirror = useCallback(() => {
    const e = ed.current;
    if (!e) return;
    const c = cur.current, text = e.text();
    try {
      if (c.path === null && !text) localStorage.removeItem(MIRROR);
      else localStorage.setItem(MIRROR, JSON.stringify({ ...c, text, sel: e.selection() } satisfies Rec));
    } catch { /* private mode, or full: the server copy is still written */ }
  }, []);
  const stopped = () => statusRef.current === "conflict" || statusRef.current === "gone";
  /** nothing here that the server does not have */
  const clean = () => { const e = ed.current, c = cur.current; return !e || (c.path === null ? !e.text().trim() : same(e.text(), c.saved)); };
  /** the status the text itself implies; while offline only a write that got through clears it */
  const settle = (written = false) => {
    const e = ed.current;
    if (!e || stopped() || (statusRef.current === "offline" && !written)) return;
    setStatus(clean() ? (cur.current.path === null ? "idle" : "saved") : "dirty");
  };
  /** hold the page still for a switch or a move: no autosave, and no typing that it would lose */
  const hold = (on: boolean) => { held.current = on; ed.current?.setReadOnly(on); };

  /* ── save ── one writer at a time; a change that lands while it runs asks for one more */
  const schedule = useCallback((ms: number) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { void flush(); }, ms);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rebase = async (text: string): Promise<"done" | "go" | "conflict" | "gone"> => {
    const c = cur.current;
    let now = await readNote(c.path!);
    if (!now?.ok) {
      const to = await whereNow(c.path!);
      now = to ? await readNote(to) : null;
      if (!now?.ok) return "gone";
      c.path = now.path;                 // filed or moved elsewhere: follow the file
    }
    if (same(now.body, text)) { c.hash = now.hash; c.saved = text; return "done"; }
    if (same(now.body, c.saved)) { c.hash = now.hash; return "go"; }
    other.current = { body: now.body, hash: now.hash };
    return "conflict";
  };

  const write = async (keepBackup: boolean): Promise<boolean> => {
    const e = ed.current;
    if (!e) return false;
    try {
      for (let round = 0; round < 4 && !clean(); round++) {
        const c = cur.current, text = e.text();
        setStatus("saving");
        if (c.path === null) {
          if (!c.clientId) c.clientId = newId();
          mirror();
          const r = await send<{ ok?: boolean; filename?: string; rel?: string; hash?: string; repeat?: boolean; error?: string }>(
            "/note/capture", { body: text, source: "note", clientId: c.clientId });
          if (!r.data.ok || !r.data.filename) { toast.error(r.data.error || "The Board refused the note"); setStatus("dirty"); return false; }
          const path = r.data.rel || INBOX + r.data.filename;
          if (r.data.repeat || !r.data.hash) {
            // made by an earlier ask whose answer never arrived: what it holds is what that ask carried
            const made = await readNote(path);
            if (!made?.ok) throw new Error("unread");
            cur.current = { path: made.path, hash: made.hash, saved: made.body };
          } else cur.current = { path, hash: r.data.hash, saved: text };
          mirror();
          continue;
        }
        // never a save without a base: a note whose hash is not known is read first
        let verdict = c.hash ? null : await rebase(text);
        if (!verdict) {
          const r = await send<{ ok?: boolean; hash?: string; conflict?: boolean }>(
            "/note/save", { path: c.path, body: text, baseHash: c.hash, ...(keepBackup ? { keepBackup: true } : {}) });
          if (r.data.ok && r.data.hash) { c.saved = text; c.hash = r.data.hash; keepBackup = false; mirror(); continue; }
          verdict = await rebase(text);  // changed elsewhere, or no longer at this path
        }
        mirror();
        if (verdict === "conflict" || verdict === "gone") { setStatus(verdict); return false; }
      }
      backoff.current = 0;
      mirror();
      setWords(wordCount(e.text()));
      settle(true);
      if (statusRef.current === "dirty") schedule(1000);
      return clean();
    } catch {
      // the Board is down or restarting: the text is here and in the mirror; try again
      setStatus("offline");
      backoff.current = Math.min(15000, backoff.current ? backoff.current * 2 : 1000);
      schedule(backoff.current);
      return false;
    }
  };

  const flush = useCallback((keepBackup = false): Promise<boolean> => {
    if (held.current || stopped() || !ed.current) return Promise.resolve(false);
    if (busy.current) { again.current = true; return busy.current; }
    window.clearTimeout(timer.current);
    const p = write(keepBackup).finally(() => {
      busy.current = null;
      if (again.current) { again.current = false; schedule(0); }
    });
    busy.current = p;
    return p;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** before leaving this note: true once every word of it is written (or there is none) */
  const leave = async (): Promise<boolean> => {
    if (!ed.current) return false;
    if (stopped()) { toast("This note changed elsewhere. Settle that first (Ctrl+K)"); return false; }
    for (let i = 0; i < 4; i++) {
      if (busy.current) await busy.current;
      if (clean()) return true;
      if (!(await flush()) && (statusRef.current === "offline" || stopped())) break;
    }
    if (clean()) return true;
    toast(statusRef.current === "offline" ? "Not saved yet. The Board is not answering, so this note stays up"
      : stopped() ? "This note changed elsewhere. Settle that first (Ctrl+K)" : "Not saved yet, so this note stays up");
    return false;
  };

  const show = (text: string, c: Cur, sel?: [number, number]) => {
    noteGen.current += 1;
    cur.current = c; other.current = null;
    ed.current?.open(text, sel);
    mirror(); setWords(wordCount(text));
    statusRef.current = "idle"; settle(true);
    ed.current?.focus();
  };

  const recheck = async () => {
    if (checking.current) return;
    checking.current = true;
    try {
      if (busy.current) await busy.current;        // the save the window made on its way out
      const e = ed.current, c = cur.current;
      if (!e || c.path === null || held.current || stopped()) return;
      let now = await readNote(c.path);
      if (!now?.ok) {
        const to = await whereNow(c.path);
        now = to ? await readNote(to) : null;
      }
      if (cur.current !== c || held.current || busy.current) return;
      if (!now?.ok) { if (clean()) show("", { path: null, saved: "" }); else setStatus("gone"); return; }
      c.path = now.path;
      if (now.hash && now.hash === c.hash) { mirror(); return; }
      if (same(now.body, e.text()) || same(now.body, c.saved)) { c.hash = now.hash; if (clean()) c.saved = now.body; mirror(); settle(true); return; }
      if (clean()) {
        c.hash = now.hash; c.saved = now.body;
        e.refresh(now.body);
        mirror(); setWords(wordCount(now.body)); settle(true);
        return;
      }
      other.current = { body: now.body, hash: now.hash };
      setStatus("conflict");
    } catch { /* the Board is not answering: the next save says so */ }
    finally { checking.current = false; }
  };

  /* ── load: the mirror first (instant), then the server's word on it ── */
  useEffect(() => {
    let live = true;
    const rec = readMirror();
    if (rec) cur.current = { path: rec.path, hash: rec.hash, saved: rec.saved, clientId: rec.clientId };
    let selTimer = 0;
    void import("./noteEditor").then(({ createNoteEditor }) => {
      if (!live || !host.current) return;
      const e = createNoteEditor(host.current, {
        text: rec?.text ?? "", selection: rec?.sel,
        onChange: () => { mirror(); settle(); if (!stopped()) schedule(1000); },
        onSelection: () => { window.clearTimeout(selTimer); selTimer = window.setTimeout(mirror, 400); },
        onImage: async (file) => {
          const pastedIn = noteGen.current;
          const data = await new Promise<string>((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result)); fr.onerror = rej; fr.readAsDataURL(file); });
          const r = await api.noteAttachmentSave(data, "pasted").catch(() => null);
          if (!r?.ok || !r.embed) { toast.error(r?.error || "Couldn't store the image"); return null; }
          // the upload outlived its note: the embed belongs there, not in whatever is open now
          if (noteGen.current !== pastedIn) { toast(`Stored as ${r.name || "an attachment"}, but its note is no longer open`); return null; }
          return r.embed;
        },
      });
      ed.current = e;
      setWords(wordCount(e.text()));
      settle();
      e.focus();
      (window as unknown as { __noteReady?: number }).__noteReady = performance.now();
      void recheck().then(() => { if (live) void flush(); });
    });
    return () => { live = false; window.clearTimeout(selTimer); window.clearTimeout(timer.current); ed.current?.destroy(); ed.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ── the window: save on the way out, caret on the way in ── */
  useEffect(() => {
    const out = () => { if (!openRef.current) void flush(); };
    const back = () => { if (!openRef.current) ed.current?.focus(); if (statusRef.current === "offline") schedule(0); else void recheck(); };
    const hidden = () => { if (document.visibilityState === "hidden") void flush(); else void recheck(); };
    // the page is going away: one last write that outlives it. Its answer is never read;
    // a create keeps its clientId in the mirror, so the next load is handed the same note.
    const gone = () => {
      const e = ed.current, c = cur.current;
      if (!e || stopped() || busy.current) return;
      const text = e.text();
      if (clean()) return;
      if (c.path === null) { if (!c.clientId) c.clientId = newId(); mirror(); void send("/note/capture", { body: text, source: "note", clientId: c.clientId }, true).catch(() => {}); }
      else if (c.hash) void send("/note/save", { path: c.path, body: text, baseHash: c.hash }, true).catch(() => {});
    };
    window.addEventListener("blur", out);
    window.addEventListener("focus", back);
    window.addEventListener("online", back);
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", gone);
    return () => {
      window.removeEventListener("blur", out); window.removeEventListener("focus", back); window.removeEventListener("online", back);
      document.removeEventListener("visibilitychange", hidden); window.removeEventListener("pagehide", gone);
    };
  }, [flush, mirror, schedule]);

  useEffect(() => {
    const first = (ed.current?.text() || "").split("\n", 1)[0].trim();
    document.title = first ? first.slice(0, 60) + " · Note" : "Note";
  }, [status, words]);

  /* ── commands ── */
  // back to the text once the overlay is gone, unless another one opened in the meantime
  const refocus = useCallback(() => { window.setTimeout(() => { if (!openRef.current) ed.current?.focus(); }, 0); }, []);
  const close = useCallback(() => { gen.current += 1; setOverlayState(null); refocus(); }, [refocus]);

  const newNote = async () => {
    close();
    if (cur.current.path === null && !ed.current?.text().trim()) return;
    if (await leave()) show("", { path: null, saved: "" });
  };

  const openNote = async (path: string) => {
    close();
    if (path === cur.current.path || !(await leave())) return;
    hold(true);                          // read-only from here: nothing can be typed into a page about to be replaced
    try {
      const r = await readNote(path);
      if (!r?.ok) { toast.error("Couldn't open that note"); return; }
      if (!clean()) { hold(false); if (!(await leave())) return; hold(true); }   // checked, not assumed
      show(r.body, { path: r.path, hash: r.hash, saved: r.body });
    } catch { toast.error("The Board is not answering"); }
    finally { hold(false); ed.current?.focus(); }
  };

  const recent = () => listOf("Open a note", async () => {
    const [inbox, all] = await Promise.all([api.noteInbox().catch(() => null), api.notesAll().catch(() => null)]);
    const day = (m: number) => new Date(m * 1000).toLocaleDateString("en", { month: "short", day: "numeric" });
    const rows = [
      ...(inbox?.items || []).map((x) => ({ path: INBOX + x.filename, title: x.title, where: "Inbox", mtime: x.mtime })),
      ...(all?.items || []).map((x) => ({ path: x.path, title: x.title, where: x.folder, mtime: x.mtime })),
    ].sort((a, b) => b.mtime - a.mtime).slice(0, 300);
    return {
      empty: inbox || all ? "No note matches" : "The Board is not answering",
      items: rows.map((x) => ({ id: x.path, label: x.title, meta: `${x.where} · ${day(x.mtime)}`, hint: x.path === cur.current.path ? "open" : undefined, run: () => void openNote(x.path) })),
    };
  });

  /** Move this note to a filing target through /note/move: the body is not touched and
   *  the move is undoable from the toast. */
  const fileTo = async (to: string, label: string) => {
    close();
    if (cur.current.path === null && ed.current?.text().trim()) await flush();
    if (cur.current.path === null) return;
    if (!(await leave())) return;
    // the note is where `path` says; its hash is read again (the move rewrote its frontmatter,
    // not its body). A read that fails leaves the hash unknown and the next save reads first.
    const landed = async (path: string) => {
      const now = await readNote(path).catch(() => null);
      cur.current = { path, hash: now?.ok ? now.hash : undefined, saved: cur.current.saved };
      mirror();
    };
    const release = () => { hold(false); ed.current?.focus(); settle(); if (statusRef.current === "dirty") schedule(1000); };
    hold(true);
    try {
      const r = await api.noteMove(cur.current.path, to).catch(() => null);
      if (!r?.ok || !r.path) { toast.error(r?.error || "Couldn't file the note"); return; }
      await landed(r.path);
      if (!r.undo_id) return;
      const undoId = r.undo_id, moved = r.path, home = r.from ? targetOf(r.from) : null, hashAtMove = cur.current.hash;
      toast.success("Filed to " + label, { action: { label: "Undo", onClick: () => {
        void (async () => {
          if (busy.current) await busy.current;      // a save in flight finishes first
          if (cur.current.path !== moved) return;    // this page is on another note by now
          hold(true);
          try {
            const edited = !hashAtMove || cur.current.hash !== hashAtMove;
            const u = edited && home ? await api.noteMove(moved, home) : await api.noteUndo(undoId);
            if (!u.ok || !u.path) { toast.error(u.error || "Couldn't undo"); return; }
            if ("kept_edited" in u && u.kept_edited) { toast("The edited note stays filed; the earlier version is back where it was"); return; }
            await landed(u.path);
          } catch { toast.error("Couldn't undo"); }
          finally { release(); }
        })();
      } } });
    } finally { release(); }
  };

  const fileMenu = () => {
    const folder = (key: string, label: string): Item => ({ id: key, label, run: () => void fileTo(key, label) });
    const projects = (course: boolean) => listOf(course ? "File to a course" : "File to a project", async () => {
      const t = await api.notesProjectTargets().catch(() => null);
      return {
        empty: t ? "Nothing matches" : "The Board is not answering",
        items: (t?.projects || []).filter((p) => (p.root === "courses") === course)
          .map((p) => ({ id: p.key, label: p.name, meta: course ? undefined : `${p.root}${p.status ? " · " + p.status : ""}`, run: () => void fileTo("project:" + p.key, p.name) })),
      };
    });
    setOverlay({ title: "File this note to", empty: "Nothing matches", items: [
      folder("ideas", "Ideas"), folder("concepts", "Concepts"), folder("meetings", "Meetings"),
      folder("reflections", "Reflections"), folder("authors", "Authors"),
      { id: "project", label: "Project…", run: () => void projects(false) },
      { id: "course", label: "Course…", run: () => void projects(true) },
      folder("inbox", "Inbox"),
    ] });
  };

  const newDiagram = (template?: { name: string; doc: unknown }) => {
    setOverlay(null);
    setDrawer({ title: `${template?.name || "Diagram"} ${today()}`, template: template?.doc });
  };
  const pickDiagram = () => listOf("Insert a diagram", async () => {
    const d = await api.notesDiagrams().catch(() => null);
    return { empty: d ? "No diagram matches" : "The Board is not answering",
      items: (d?.items || []).map((x) => ({ id: x.path, label: x.title, run: () => { close(); ed.current?.insertBlock(x.embed); } })) };
  });
  const pickTemplate = () => listOf("New diagram from a template", async () => {
    const t = await api.noteDrawerTemplates().catch(() => null);
    return { empty: t ? "No template matches" : "The Board is not answering",
      items: (t?.items || []).filter((x) => x.doc).map((x) => ({ id: x.name, label: x.name, run: () => newDiagram({ name: x.name, doc: x.doc }) })) };
  });

  // "Keep my text" replaces the other version, so that version is kept: the save asks the
  // server for a dated copy in server/note-backups/, which no later save touches
  const keepMine = () => { close(); if (other.current) cur.current.hash = other.current.hash; other.current = null; statusRef.current = "dirty"; void flush(true); };
  const takeTheirs = () => {
    close();
    const o = other.current;
    if (!o) return;
    cur.current.hash = o.hash; cur.current.saved = o.body; other.current = null;
    statusRef.current = "saved";
    ed.current?.replaceAll(o.body);
    mirror(); settle(true);
  };
  const keepBoth = () => {
    close();
    const o = other.current, e = ed.current;
    if (!o || !e) return;
    cur.current.hash = o.hash; other.current = null;
    statusRef.current = "dirty";
    e.replaceAll(e.text().replace(/\s*$/, "") + "\n\n---\n\n" + o.body.trim() + "\n");
    void flush();
  };
  const saveAsNew = () => { close(); cur.current = { path: null, saved: "" }; statusRef.current = "dirty"; void flush(); };

  const openElsewhere = (obsidian: boolean) => {
    close();
    const p = cur.current.path;
    if (!p) { toast("Nothing is saved yet"); return; }
    if (obsidian) { void api.open(p); return; }
    const folder = p.startsWith(INBOX) ? "capture" : (p.split("/")[2] || "").toLowerCase();
    window.open("/v/notes#/notes/" + (["ideas", "concepts", "meetings"].includes(folder) ? folder : folder === "capture" ? "capture" : "overview"), "_blank", "noopener");
  };

  const palette = () => {
    const s = statusRef.current, has = cur.current.path !== null;
    const items: Item[] = [
      ...(s === "conflict" ? [
        { id: "mine", label: "Keep my text", meta: "the other version is kept as a backup", run: keepMine },
        { id: "theirs", label: "Use the other version", meta: "one undo brings mine back", run: takeTheirs },
        { id: "both", label: "Keep both, the other below mine", run: keepBoth },
      ] : []),
      ...(s === "gone" ? [{ id: "asnew", label: "Save this text as a new note", run: saveAsNew }] : []),
      { id: "new", label: "New note", hint: "Alt N", run: () => void newNote() },
      { id: "open", label: "Open a note…", hint: "Ctrl O", run: () => void recent() },
      { id: "file", label: "File to…", hint: "Alt M", run: fileMenu },
      { id: "draw", label: "Insert a new diagram", hint: "Alt D", run: () => newDiagram() },
      { id: "tpl", label: "Insert a new diagram from a template…", run: () => void pickTemplate() },
      { id: "dia", label: "Insert a diagram…", run: () => void pickDiagram() },
      ...(has ? [
        { id: "notes", label: "Open in the Notes view", run: () => openElsewhere(false) },
        { id: "obs", label: "Open in Obsidian", hint: "Alt O", run: () => openElsewhere(true) },
      ] : []),
      { id: "save", label: "Save now", hint: "Ctrl S", run: () => { close(); void flush(); } },
    ];
    setWords(wordCount(ed.current?.text() || ""));
    setOverlay({ title: "", items, empty: "No command matches" });
  };

  // every command key, taken before the editor or the Board's key layers see it
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  keys.current = (e) => {
    const mod = e.ctrlKey || e.metaKey, take = () => { e.preventDefault(); e.stopPropagation(); };
    // Ctrl+O is Chromium's open-file dialog: never in this window, whatever has the keys
    const openKey = mod && !e.altKey && !e.shiftKey && e.code === "KeyO";
    if (openKey) e.preventDefault();
    if (drawer) return;                                   // the drawer owns the keyboard
    if (mod && !e.altKey && !e.shiftKey && e.code === "KeyK") { take(); if (overlay && !overlay.title) close(); else palette(); return; }
    if (overlay) {                                        // the list has its own keys
      const box = document.querySelector<HTMLInputElement>("[data-note-picker] input");
      if (box && e.target !== box) { take(); box.focus(); }   // never type into the note behind it
      return;
    }
    if (openKey) { take(); void recent(); }
    else if (mod && !e.altKey && !e.shiftKey && e.code === "KeyS") { take(); void flush(); }
    else if (e.altKey && !mod && !e.shiftKey) {
      if (e.code === "KeyN") { take(); void newNote(); }
      else if (e.code === "KeyM") { take(); fileMenu(); }
      else if (e.code === "KeyD") { take(); newDiagram(); }
      else if (e.code === "KeyO") { take(); openElsewhere(true); }
    }
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, []);

  const label = status === "saving" ? "saving" : status === "offline" ? "offline, kept here"
    : status === "conflict" ? "changed elsewhere · Ctrl K" : status === "gone" ? "moved elsewhere · Ctrl K" : "";
  const dot = status === "saved" ? "bg-muted-foreground/35" : status === "dirty" || status === "saving" ? "border border-muted-foreground/50"
    : status === "offline" ? "bg-foreground/70" : "bg-destructive";

  return (
    <div data-note-page className="relative h-screen w-full bg-background text-foreground"
      // a click beside the column is still a click on the page
      onMouseDown={(e) => { if (!openRef.current && !(e.target as HTMLElement).closest(".cm-content")) { e.preventDefault(); ed.current?.focus(); } }}>
      <Toaster position="bottom-center" />
      <div ref={host} className="h-full" />
      {status !== "idle" && (
        <div data-note-status={status} aria-hidden="true"
          title={`${words} word${words === 1 ? "" : "s"}${cur.current.path ? " · " + cur.current.path.replace(/^Preparation\/Notes\//, "") : ""}`}
          className="fixed bottom-2 right-3 z-10 flex select-none items-center gap-1.5 text-[11px] leading-none text-muted-foreground/70">
          {label && <span>{label}</span>}
          <span className={"h-1.5 w-1.5 rounded-full " + dot} />
        </div>
      )}
      {overlay && <Picker key={overlay.title} overlay={overlay} words={overlay.title ? null : words} onClose={close} />}
      {drawer && (
        <DiagramDrawer name={null} title={drawer.title} template={drawer.template}
          onSaved={(_name, png, first) => { if (first) ed.current?.insertBlock(`![[${png}]]`); }}
          onClose={() => { setDrawer(null); refocus(); }} />
      )}
    </div>
  );
}

/* The one on-demand surface: a filter box over a short list. Typing filters, arrows move,
 * Enter picks, Esc closes; it is the command palette and every list a command opens. */
function Picker({ overlay, words, onClose }: { overlay: NonNullable<Overlay>; words: number | null; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const shown = useMemo(() => {
    const n = q.trim().toLowerCase();
    return n ? overlay.items.filter((x) => (x.label + " " + (x.meta || "")).toLowerCase().includes(n)) : overlay.items;
  }, [q, overlay.items]);
  const at = Math.min(idx, Math.max(0, shown.length - 1));
  useEffect(() => { list.current?.querySelector(`[data-row="${at}"]`)?.scrollIntoView({ block: "nearest" }); }, [at, shown]);

  return (
    <div role="dialog" aria-modal="true" aria-label={overlay.title || "Commands"} data-knav-modal data-note-picker
      className="fixed inset-0 z-[150] flex items-start justify-center px-3 pt-[min(14vh,96px)]"
      onMouseDown={(e) => { if (e.target === e.currentTarget) { e.preventDefault(); onClose(); } }}>
      <div className="flex max-h-[min(70vh,440px)] w-full max-w-[460px] flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-xl">
        {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
        <input autoFocus value={q} onChange={(e) => { setQ(e.target.value); setIdx(0); }}
          placeholder={overlay.title || "Command"} aria-label={overlay.title || "Command"} spellCheck={false}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") { e.preventDefault(); onClose(); }
            else if (e.key === "ArrowDown") { e.preventDefault(); setIdx(Math.min(shown.length - 1, at + 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setIdx(Math.max(0, at - 1)); }
            else if (e.key === "Enter") { e.preventDefault(); shown[at]?.run(); }
            else if (e.key === "Tab") e.preventDefault();
          }}
          className="h-11 shrink-0 border-b border-border bg-transparent px-4 text-[14px] outline-none placeholder:text-muted-foreground/60" />
        <div ref={list} role="listbox" className="min-h-0 flex-1 overflow-y-auto py-1">
          {shown.length === 0 && <div className="px-4 py-3 text-[13px] text-muted-foreground">{overlay.empty}</div>}
          {shown.map((x, i) => (
            <div key={x.id} role="option" aria-selected={i === at} data-row={i}
              onMouseMove={() => setIdx(i)} onMouseDown={(e) => { e.preventDefault(); x.run(); }}
              className={"flex cursor-default items-baseline gap-3 px-4 py-[7px] text-[13.5px] " + (i === at ? "bg-accent text-accent-foreground" : "")}>
              <span className="min-w-0 flex-1 truncate">{x.label}</span>
              {x.meta && <span className="shrink-0 truncate text-[11.5px] text-muted-foreground">{x.meta}</span>}
              {x.hint && <kbd className="shrink-0 font-sans text-[11px] text-muted-foreground">{x.hint}</kbd>}
            </div>
          ))}
        </div>
        {words !== null && <div className="shrink-0 border-t border-border px-4 py-1.5 text-[11px] text-muted-foreground nums">{words} word{words === 1 ? "" : "s"}</div>}
      </div>
    </div>
  );
}
