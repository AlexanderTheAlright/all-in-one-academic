
import { api } from "@/lib/api";
import type { TLItem, TaskLink } from "@/lib/api";
import { titleCase } from "@/lib/format";
import { holdDraftingLists } from "@/lib/draftgate";

export type OpenBoardFn = (path: string, title: string, isPaper: boolean) => void;
export type GoFn = (v: string) => void;

/* A draft the Drafting view should auto-open on its next mount — set by a task's
 * smart link (or a #/drafting/<slug>/<doc> hash), consumed once by Drafting(). */
export const pendingDraftOpen: { current: { slug: string; doc: string } | null } = { current: null };

function readDraftHash(): { slug: string; doc: string } | null {
  try {
    const raw = window.location.hash.replace(/^#\/?/, "");
    if (!raw.toLowerCase().startsWith("drafting/")) return null;
    const parts = raw.split("/");                       // slugs are case-sensitive folder names
    const slug = decodeURIComponent(parts[1] || "");
    const doc = decodeURIComponent(parts[2] || "");
    return slug && doc ? { slug, doc } : null;
  } catch { return null; }
}
if (typeof window !== "undefined") {
  pendingDraftOpen.current = readDraftHash();
  if (pendingDraftOpen.current) holdDraftingLists();
}

const draftOpenListeners = new Set<() => void>();

export function setPendingDraftOpen(v: { slug: string; doc: string } | null): void {
  pendingDraftOpen.current = v;
  if (v) for (const f of [...draftOpenListeners]) { try { f(); } catch { /* one bad listener never blocks the rest */ } }
}

/** Subscribe to a later set; returns the unsubscribe, for an effect cleanup. */
export function onPendingDraftOpen(f: () => void): () => void {
  draftOpenListeners.add(f);
  return () => { draftOpenListeners.delete(f); };
}

export const pendingNoteOpen: { current: { path: string; title: string; readonly: boolean; section?: string } | null } = { current: null };

type NotesDest = { mapFocus?: string; section?: string };
export const pendingNotesDest: { current: NotesDest | null } = { current: null };

const notesDestListeners = new Set<() => void>();
export function setPendingNotesDest(v: NotesDest | null): void {
  pendingNotesDest.current = v;
  if (v) for (const f of [...notesDestListeners]) { try { f(); } catch { /* one bad listener never blocks the rest */ } }
}
export function onPendingNotesDest(f: () => void): () => void {
  notesDestListeners.add(f);
  return () => { notesDestListeners.delete(f); };
}

export type DiagramStart = { kind: "new" } | { kind: "template" | "open"; name: string };
export const pendingDiagramStart: { current: DiagramStart | null } = { current: null };
const diagramStartListeners = new Set<() => void>();
export function setPendingDiagramStart(v: DiagramStart | null): void {
  pendingDiagramStart.current = v;
  if (v) for (const f of [...diagramStartListeners]) { try { f(); } catch { /* as above */ } }
}
export function onPendingDiagramStart(f: () => void): () => void {
  diagramStartListeners.add(f);
  return () => { diagramStartListeners.delete(f); };
}

export const NOTES_SECTIONS = ["capture", "overview", "authors", "corpus", "concepts", "ideas",
  "meetings", "projects", "diagrams", "map"] as const;

export function applyNotesHash(raw: string): void {
  const part = raw.split("?")[0].split("/").map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
  const section = (part[1] || "").toLowerCase();
  if (!(NOTES_SECTIONS as readonly string[]).includes(section)) return;
  const verb = section === "diagrams" ? (part[2] || "").toLowerCase() : "";
  const name = (part[3] || "").trim();
  // the drawer's target first: Notes may mount the section inside the wake below
  if (verb === "new") setPendingDiagramStart(name ? { kind: "template", name } : { kind: "new" });
  else if (verb === "open" && name) setPendingDiagramStart({ kind: "open", name });
  setPendingNotesDest({ section });
}

export function goNotes(dest: NotesDest & { note?: { path: string; title: string; readonly: boolean } }): void {
  if (dest.note) pendingNoteOpen.current = { ...dest.note, section: dest.section };
  else pendingNotesDest.current = { mapFocus: dest.mapFocus, section: dest.section };
  window.location.hash = "#/notes";
}

export function linkAction(l: TaskLink, go: GoFn): (() => void) | null {
  if (l.action === "open" && l.file) { const f = l.file; return () => { api.open(f); }; }
  if (l.action === "open-pdf" && l.slug && l.doc) { const s = l.slug, d = l.doc; return () => { api.draftingOpenPdf(s, d).catch(() => {}); }; }
  if (l.action === "drafting" && l.slug && l.doc) { const s = l.slug, d = l.doc; return () => { setPendingDraftOpen({ slug: s, doc: d }); go("drafting"); }; }
  if (l.action === "reading") return () => go("reading");
  return null;
}

export function taskDest(it: TLItem, openBoard: OpenBoardFn, go: GoFn):
{ label: string; smart: boolean; onClick: () => void; extras: { label: string; onClick: () => void }[] } {
  const board = () => openBoard(it.path, titleCase(it.board), !it.isPlanning);
  const l = it.link;
  const run = l ? linkAction(l, go) : null;
  if (l && run) {
    const extras = (l.extras || [])
      .map((x) => { const r = linkAction(x, go); return r ? { label: x.label, onClick: r } : null; })
      .filter(Boolean) as { label: string; onClick: () => void }[];
    return { label: l.label, smart: true, onClick: run, extras: extras.slice(0, 3) };
  }
  return { label: "Open board", smart: false, onClick: board, extras: [] };
}
