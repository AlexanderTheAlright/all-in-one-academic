
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Network, Users, Library, Lightbulb, Shapes, CalendarDays, FolderKanban, LayoutGrid, Search, ArrowLeft, FileText, BookUser, Pencil, ChevronRight, Quote, NotebookPen, Loader2, Send, Maximize2, Minimize2, Inbox, Archive, Images, Copy, ExternalLink, X, Undo2, ArchiveRestore, Plus, Trash2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { WidgetFrame, useFullPage, useWidget, rowCap } from "@/components/ui/widget";
import { openWidgetFocus } from "@/lib/arrownav";
import { api } from "@/lib/api";
import type {
  GraphNode, AioaWork, AioaCitationsPage, AioaMeeting, NoteInboxItem, NoteRead, NoteItem,
  DiagramItem, DrawerTemplate, VaultHit, VaultSearch,
} from "@/lib/api";
import { copyPlain } from "@/lib/clipboard";
import { useApi, usePersistent } from "@/lib/hooks";
import { useSaveKey } from "@/lib/savekey";
import { Markdown } from "@/lib/markdown";
import { NotesGraph, NoteDrawer, FileStrip, isWritableNote } from "@/components/NotesGraph";
import { NotePreview } from "@/components/NotePreview";
import { DiagramDrawer } from "@/components/DiagramDrawer";
import { TemplateThumb } from "@/components/DrawerTemplates";
import { useRestIntent } from "@/lib/restIntent";
import { pendingNoteOpen, pendingNotesDest, onPendingNotesDest, pendingDiagramStart, onPendingDiagramStart } from "@/lib/taskdest";
import { diagramSlug } from "@/lib/pathroute";
import { toast } from "sonner";

type Section = "capture" | "overview" | "authors" | "corpus" | "concepts" | "ideas" | "meetings" | "projects" | "diagrams" | "map";

const SECTIONS: { id: Section; label: string; icon: React.ReactNode }[] = [
  { id: "capture", label: "Capture", icon: <NotebookPen size={13} /> },
  { id: "map", label: "Map", icon: <Network size={13} /> },
  { id: "overview", label: "Overview", icon: <LayoutGrid size={13} /> },
  { id: "authors", label: "Authors", icon: <Users size={13} /> },
  { id: "corpus", label: "Corpus", icon: <Library size={13} /> },
  { id: "concepts", label: "Concepts", icon: <Shapes size={13} /> },
  { id: "ideas", label: "Ideas", icon: <Lightbulb size={13} /> },
  { id: "meetings", label: "Meetings", icon: <CalendarDays size={13} /> },
  { id: "projects", label: "Projects", icon: <FolderKanban size={13} /> },
  { id: "diagrams", label: "Diagrams", icon: <Images size={13} /> },
];

// section memory: survives in-app navigation away and back (module scope), but a
// fresh app load always lands on Capture — the frictionless default comes first.
let rememberedSection: Section = "capture";

const EMPTY_MAP = new Map<string, GraphNode>();

// a drawer-openable node for anything a structured list surfaces
const nodeFor = (path: string, title: string, type: string, readonly = true, tags: string[] = []): GraphNode => ({
  id: path, title, folder: "", type, tags, path, mtime: 0,
  ghost: false, external: false, degree: 0, orphan: false, readonly,
});

const fmtDay = (mtime: number) =>
  mtime ? new Date(mtime * 1000).toLocaleDateString("en", { month: "short", day: "numeric", year: "numeric" }) : "";

function useDebounced(value: string, ms = 250): string {
  const [v, setV] = useState(value);
  useEffect(() => { const t = window.setTimeout(() => setV(value), ms); return () => window.clearTimeout(t); }, [value, ms]);
  return v;
}

const StatusDot = ({ status }: { status: string }) => (
  <span title={status || "unknown"}
    className={`inline-block h-1.5 w-1.5 rounded-full shrink-0 ${status === "read" ? "bg-[hsl(152_30%_44%)]" : "border border-muted-foreground/50"}`} />
);

const Stars = ({ n }: { n: number }) =>
  n > 0 ? <span className="text-[10.5px] text-[hsl(30_52%_52%)] nums shrink-0">{"★".repeat(Math.min(5, n))}</span> : null;

const TagChips = ({ tags, max = 3 }: { tags: string[]; max?: number }) => (
  <span className="flex items-center gap-1 min-w-0">
    {tags.slice(0, max).map((t) => (
      <span key={t} className="text-[10px] text-muted-foreground bg-secondary px-1.5 py-0.5 rounded truncate max-w-[110px]">{t}</span>
    ))}
  </span>
);

// the section's name; what it holds rides the tooltip, so a quarter tile keeps its rows
const SectionHead = ({ title, sub }: { title: string; sub?: string }) => (
  <div className="mb-3">
    <h2 className="text-[17px] font-semibold tracking-tight" title={sub}>{title}</h2>
  </div>
);

// the widget's own width tier: xs/sm stack and fold, lg/xl spread out
function useTier() {
  const w = useWidget();
  const size = w?.size ?? "lg";
  return { w, size, xs: size === "xs", compact: size === "xs" || size === "sm", wide: size === "lg" || size === "xl", focused: !!w?.focused };
}

// a tile shows its first rows; the focused view (or "+N more") shows them all
function useCapped<T>(rows: T[], tile: number, roomy?: number) {
  const w = useWidget();
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, rowCap(w, tile, roomy));
  return { shown, more: rows.length - shown.length, showAll: () => setAll(true) };
}

// in a widget "+N more" opens its focused view on the first hidden row; elsewhere the rows show here
const MoreRows = ({ more, onClick }: { more: number; onClick: () => void }) =>
  more > 0 ? (
    <button onClick={(e) => { if (!openWidgetFocus(e.currentTarget)) onClick(); }} title="Open the full view"
      className="mt-2 text-[11.5px] text-muted-foreground hover:text-primary transition-colors nums">+{more} more</button>
  ) : null;

// ============================================================================
export function Aioa() {
  const [section, setSectionRaw] = useState<Section>(rememberedSection);
  const setSection = (s: Section) => { rememberedSection = s; setSectionRaw(s); };
  const [mapFocus, setMapFocus] = useState<{ id: string; n: number } | null>(null);
  const [authorKey, setAuthorKey] = useState<string | null>(null);
  const [project, setProject] = useState<string | null>(null);
  const [reading, setReading] = useState<GraphNode | null>(null);
  const [bookmarks, setBookmarks] = usePersistent<string[]>("ng-bookmarks", []);
  const [tick, setTick] = useState(0);
  // inbox count rides the Capture chip so unfiled thoughts are always visible
  const inbox = useApi(() => api.noteInbox(), [tick], 0);

  // a note handed over from another view (the calendar's "Meeting notes" button)
  // opens straight into the reader — consumed ONCE, like pendingDraftOpen
  useEffect(() => {
    // a destination set while Notes is already up (a deep link on a loaded page) wakes it
    const wake = () => { const s = pendingNotesDest.current?.section; if (s) { pendingNotesDest.current = null; setSection(s as Section); } };
    const off = onPendingNotesDest(wake);
    const d = pendingNotesDest.current;
    if (d) {
      pendingNotesDest.current = null;
      if (d.mapFocus) { setSection("map"); setMapFocus((f) => ({ id: d.mapFocus!, n: (f?.n || 0) + 1 })); }
      else if (d.section) setSection(d.section as Section);
    }
    const p = pendingNoteOpen.current;
    if (!p) return off;
    pendingNoteOpen.current = null;
    setSection((p.section as Section) || "meetings");
    setReading(nodeFor(p.path, p.title, p.section === "projects" ? "project" : "meeting", p.readonly));
    return off;
  }, []);

  const open = (n: GraphNode) => setReading(n);
  const go = (s: Section) => { setSection(s); setAuthorKey(null); setProject(null); };

  return (
    <div>
      {/* sections, then search right of Diagrams stretching to the row's right edge
          (the cards' edge); only when too narrow does it wrap under the tabs */}
      <div className="flex items-center gap-3 mb-5 flex-wrap">
        {/* below lg the inactive tabs fold to their icons so the strip stays one row;
            it still wraps rather than clip a tab past main's edge */}
        <div className="flex flex-wrap items-center gap-1 bg-secondary/60 rounded-lg p-1 max-w-full">
          {SECTIONS.map((s) => (
            <button key={s.id} onClick={() => go(s.id)} title={s.label} aria-label={s.label}
              aria-current={section === s.id ? "true" : undefined}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[12px] font-medium transition-colors ${
                section === s.id ? "bg-card shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"}`}>
              {s.icon} <span className={section === s.id ? "" : "hidden lg:inline"}>{s.label}</span>
              {s.id === "capture" && (inbox.data?.count || 0) > 0 && (
                <span className="ml-0.5 inline-flex items-center justify-center min-w-[16px] h-4 rounded-full bg-primary/15 text-foreground text-[10px] nums px-1">{inbox.data?.count}</span>
              )}
            </button>
          ))}
        </div>
        <div className="flex-1 min-w-[220px]">
          <SearchEverything reading={!!reading} onOpen={open} />
        </div>
      </div>

      {/* body — every section's panels are widgets. The map tile takes a height by its
          own width tier (its focused view fills the page); lists ride the shell scroll */}
      {section === "map" ? (
        <div>
          <WidgetFrame id="notes.map" title="Map"
            className="flex flex-col h-[460px] data-[size=xs]:h-[300px] data-[size=sm]:h-[340px] data-[size=lg]:h-[560px] data-[size=xl]:h-[640px]">
            <NotesGraph embedded focusId={mapFocus?.id} focusNonce={mapFocus?.n} />
          </WidgetFrame>
        </div>
      ) : (
        <div>
          {section === "capture" && <CaptureView inboxItems={inbox.data?.items || []} tick={tick} onBump={() => setTick((t) => t + 1)} onOpen={open} />}
          {section === "overview" && <OverviewView tick={tick} onGo={go} onOpen={open} />}
          {section === "authors" && (
            <WidgetFrame id="notes.authors" title="Authors">
              {authorKey
                ? <AuthorProfile authorKey={authorKey} tick={tick} onBack={() => setAuthorKey(null)} onOpen={open} onChanged={() => setTick((t) => t + 1)} />
                : <AuthorsView onPick={setAuthorKey} tick={tick} onOpen={open} />}
            </WidgetFrame>
          )}
          {section === "corpus" && (
            <WidgetFrame id="notes.corpus" title="Corpus">
              <CorpusView onOpen={open} onAuthor={(k) => { setSection("authors"); setAuthorKey(k); }} />
            </WidgetFrame>
          )}
          {section === "concepts" && (
            <WidgetFrame id="notes.concepts" title="Concepts">
              <NotesListView kind="concept" tick={tick} onOpen={open} onChanged={() => setTick((t) => t + 1)} />
            </WidgetFrame>
          )}
          {section === "ideas" && (
            <WidgetFrame id="notes.ideas" title="Ideas">
              <NotesListView kind="idea" tick={tick} onOpen={open} onChanged={() => setTick((t) => t + 1)} />
            </WidgetFrame>
          )}
          {section === "meetings" && (
            <WidgetFrame id="notes.meetings" title="Meetings">
              <MeetingsView onOpen={open} />
            </WidgetFrame>
          )}
          {section === "projects" && (
            <WidgetFrame id="notes.projects" title="Projects">
              <ProjectsView project={project} setProject={setProject} onOpen={open} />
            </WidgetFrame>
          )}
          {section === "diagrams" && (
            <WidgetFrame id="notes.diagrams" title="Diagrams">
              <DiagramsView />
            </WidgetFrame>
          )}
        </div>
      )}

      {reading && (
        <NoteDrawer node={reading} nodeById={EMPTY_MAP} edges={[]}
          onClose={() => setReading(null)} onJump={(n) => setReading(n)}
          onSaved={() => setTick((t) => t + 1)}
          onTrace={(n) => { setReading(null); setSection("map"); setMapFocus((f) => ({ id: n.id, n: (f?.n || 0) + 1 })); }}
          bookmarked={bookmarks.includes(reading.id)}
          onToggleBookmark={() => setBookmarks(bookmarks.includes(reading.id)
            ? bookmarks.filter((b) => b !== reading.id) : [...bookmarks, reading.id])} />
      )}
    </div>
  );
}

const AREA_CHIPS: [string, string][] = [
  ["", "All"], ["notes", "Notes"], ["ideas", "Ideas"], ["concepts", "Concepts"],
  ["citations", "Citations"], ["projects", "Projects"], ["daily", "Daily"], ["archive", "Archive"],
];
const IN_TOKEN = /(^|\s)in:\S+/gi;
const areaOfQuery = (q: string) => (q.match(/(?:^|\s)in:(\S+)/i)?.[1] || "").toLowerCase();
const withArea = (q: string, area: string) => {
  const base = q.replace(IN_TOKEN, " ").replace(/\s+/g, " ").trim();
  return area ? `${base}${base ? " " : ""}in:${area} ` : base;
};
// «…» marks the matched words
const Snippet = ({ text }: { text: string }) => (
  <>{text.split(/(«[^»]*»)/).map((p, i) => p.startsWith("«") && p.endsWith("»")
    ? <mark key={i} className="rounded-[2px] bg-primary/25 px-[1px] text-foreground">{p.slice(1, -1)}</mark>
    : <span key={i}>{p}</span>)}</>
);
type SearchItem = { key: string; path: string; title: string; area: string; snippet: string; node: GraphNode };
const fromHit = (h: VaultHit): SearchItem => ({
  key: h.path, path: h.path, title: h.title || h.path, area: h.area || h.type || "other", snippet: h.snippet || "",
  node: nodeFor(h.path, h.title || h.path, h.area === "inbox" ? "inbox" : (h.type || h.area || "note"), !isWritableNote(h.path), h.tags),
});
const fromNode = (n: GraphNode): SearchItem => ({ key: n.id, path: n.path, title: n.title, area: n.type || "note", snippet: "", node: n });

function SearchEverything({ reading, onOpen }: { reading: boolean; onOpen: (n: GraphNode) => void }) {
  const [q, setQ] = useState("");
  const dq = useDebounced(q, 120);
  const [res, setRes] = useState<VaultSearch | null>(null);
  const [legacy, setLegacy] = useState<GraphNode[] | null>(null);
  const [again, setAgain] = useState(0);
  const [active, setActive] = useState(-1);
  const noVault = useRef(false);   // /search/vault answered 404 once: stay on the old search
  const searchRef = useRef<HTMLInputElement>(null);
  const hitsRef = useRef<HTMLDivElement>(null);
  const chipsRef = useRef<HTMLDivElement>(null);

  // each keystroke aborts the request before it, so a slow answer never lands late
  useEffect(() => {
    if (!dq.trim()) { setRes(null); setLegacy(null); return; }
    const ctl = new AbortController();
    const old = () => api.notesSearch(dq.replace(IN_TOKEN, " ").trim() || dq, 24)
      .then((r) => { if (!ctl.signal.aborted) { setRes(null); setLegacy(r.nodes); } }).catch(() => {});
    if (noVault.current) { void old(); return () => ctl.abort(); }
    let retry: number | undefined;
    api.searchVault(dq, 40, ctl.signal)
      .then((r) => {
        if (ctl.signal.aborted) return;
        setRes(r); setLegacy(null);
        // the index is still building: ask again shortly so the list fills in
        if (r.building && again < 8) retry = window.setTimeout(() => setAgain((n) => n + 1), 1500);
      })
      .catch((e: Error & { status?: number }) => {
        if (ctl.signal.aborted || e.name === "AbortError") return;
        if (e.status === 404) noVault.current = true;
        void old();
      });
    return () => { ctl.abort(); if (retry) window.clearTimeout(retry); };
  }, [dq, again]);
  useEffect(() => { setAgain(0); }, [dq]);

  const items = useMemo<SearchItem[]>(() => res ? res.hits.map(fromHit) : (legacy || []).map(fromNode), [res, legacy]);
  // grouped by area, areas in the order their best hit ranks
  const groups = useMemo(() => {
    const m = new Map<string, SearchItem[]>();
    for (const it of items) { const g = m.get(it.area); if (g) g.push(it); else m.set(it.area, [it]); }
    return [...m.entries()];
  }, [items]);
  const flat = useMemo(() => groups.flatMap(([, xs]) => xs), [groups]);
  useEffect(() => { setActive(-1); }, [flat]);
  useEffect(() => {
    if (active < 0) return;
    hitsRef.current?.querySelector(`[data-hit="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const open = (it: SearchItem) => { setQ(""); onOpen(it.node); };
  const obsidian = (it: SearchItem) => { void api.open(it.path); };
  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!q.trim()) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(i + 1, flat.length - 1)); }
    else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (active > 0) setActive(active - 1);
      else if (active === 0) setActive(-1);
      else chipsRef.current?.querySelector<HTMLButtonElement>("[aria-pressed=true]")?.focus();
    } else if (e.key === "Enter") {
      const it = flat[active >= 0 ? active : 0];
      if (!it) return;
      e.preventDefault();
      if (e.shiftKey) obsidian(it); else open(it);
    }
  };

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.key !== "Escape" || reading || !q) return;
      const t = e.target as HTMLElement | null;
      const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      if (typing && t !== searchRef.current && !t.hasAttribute("data-knav-armed")) return;
      e.preventDefault();
      const fromHits = !!(t && hitsRef.current?.contains(t));
      setQ("");
      // a hit row is about to vanish: stand back on the search box
      if (fromHits && searchRef.current) { searchRef.current.focus(); searchRef.current.setAttribute("data-knav-armed", ""); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [reading, q]);

  // "/" jumps to the box from anywhere in Notes that is not a field. Elsewhere "/" opens
  // the palette (App.tsx); here it is taken in the capture phase, and Ctrl+K still opens it.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || reading) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (document.querySelector("[data-knav-modal]")) return;
      e.preventDefault(); e.stopPropagation();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [reading]);

  const area = areaOfQuery(q);
  const building = !!res?.building;
  let n = -1;
  return (
    <div className="relative w-full">
      <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/60" />
      <input ref={searchRef} value={q}
        onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} placeholder="Search everything…"
        title={'Words, "phrases", -exclude, OR, in:ideas, tag:, project:, title: · ↑↓ ⏎ open · Shift ⏎ Obsidian · / from anywhere'}
        className="w-full h-8 bg-secondary/40 border border-border rounded-full pl-8 pr-7 text-[12.5px] focus:outline-none focus:border-primary" />
      {building && (
        <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/70"
          title={`indexing… ${res?.indexed ?? 0} notes so far — results fill in as it builds`}>
          <Loader2 size={12} className="animate-spin" />
        </span>
      )}
      {q.trim() && (
        <div ref={hitsRef}
          className="absolute top-9 left-0 right-0 z-20 max-h-[60vh] flex flex-col rounded-lg border border-border bg-background shadow-xl">
          {res && (
            <div ref={chipsRef} className="shrink-0 flex items-center gap-1 flex-wrap px-2 pt-2 pb-1.5 border-b border-border/60">
              {AREA_CHIPS.map(([k, label]) => (
                <button key={k || "all"} aria-pressed={area === k}
                  onClick={() => { setQ((cur) => withArea(cur, area === k ? "" : k)); searchRef.current?.focus(); }}
                  title={k ? `Only ${label.toLowerCase()} (in:${k})` : "Every area"}
                  className={`rounded-full border px-2 py-0.5 text-[11px] transition-colors ${
                    area === k ? "border-primary/60 bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:text-foreground hover:border-primary/40"}`}>
                  {label}
                </button>
              ))}
              <span className="ml-auto text-[10.5px] text-muted-foreground/70 nums" title={`${res.took_ms} ms · ${res.indexed} indexed`}>{res.total}</span>
            </div>
          )}
          <div className="min-h-0 overflow-y-auto tinybar py-1">
            {flat.length === 0 && (res || legacy) && <div className="px-3 py-2 text-[12px] text-muted-foreground">No matches.</div>}
            {groups.map(([g, xs]) => (
              <div key={g}>
                {res && <div className="px-3 pt-2 pb-0.5 text-[10px] uppercase tracking-[0.09em] font-semibold text-muted-foreground/70">{g}</div>}
                {xs.map((it) => {
                  n += 1;
                  const i = n;
                  return (
                    <button key={it.key} data-hit={i} onClick={(e) => e.shiftKey ? obsidian(it) : open(it)}
                      onMouseMove={() => { if (active !== i) setActive(i); }}
                      data-obsidian-file={it.path} title={it.path}
                      className={`w-full min-w-0 text-left px-3 py-1.5 flex flex-col gap-0.5 text-[12.5px] ${
                        active === i ? "bg-secondary/60 text-foreground" : "text-muted-foreground hover:text-foreground hover:bg-secondary/40"}`}>
                      <span className="flex items-center gap-2 min-w-0">
                        <FileText size={12} className="shrink-0 opacity-60" />
                        <span className="truncate flex-1 text-foreground/90">{it.title}</span>
                        <span className="shrink-0 text-[9.5px] uppercase tracking-wide text-muted-foreground/70 bg-secondary px-1.5 py-0.5 rounded">{it.area}</span>
                      </span>
                      {it.snippet && <span className="pl-5 text-[11.5px] text-muted-foreground line-clamp-2"><Snippet text={it.snippet} /></span>}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const DRAFT_KEY = "aioa-note-draft";
const TITLE_KEY = "aioa-note-draft-title";
const countWords = (t: string) => (t.trim().match(/[\w'’-]+/g) || []).length;

function CaptureView({ inboxItems, tick, onBump, onOpen }:
  { inboxItems: NoteInboxItem[]; tick: number; onBump: () => void; onOpen: (n: GraphNode) => void }) {
  const [title, setTitle] = useState(() => { try { return localStorage.getItem(TITLE_KEY) || ""; } catch { return ""; } });
  const [text, setText] = useState(() => { try { return localStorage.getItem(DRAFT_KEY) || ""; } catch { return ""; } });
  const [focus, setFocus] = useState(false);
  const [saving, setSaving] = useState(false);
  const words = countWords(text);

  useEffect(() => { try { localStorage.setItem(DRAFT_KEY, text); } catch { /* noop */ } }, [text]);
  useEffect(() => { try { localStorage.setItem(TITLE_KEY, title); } catch { /* noop */ } }, [title]);

  const capture = async () => {
    const body = text.trim();
    if (!body && !title.trim()) return;
    setSaving(true);
    try {
      const r = await api.noteCapture(body, title.trim() || undefined);
      setText(""); setTitle("");
      try { localStorage.removeItem(DRAFT_KEY); localStorage.removeItem(TITLE_KEY); } catch { /* noop */ }
      setFocus(false);
      onBump();
      toast.success("Captured", { description: `${r.inbox} in your inbox — file it below` });
    } catch {
      toast.error("Couldn't capture — your note is safe on screen, try again");
    } finally { setSaving(false); }
  };
  const onKey = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); capture(); }
  };
  // ctrl/cmd+s files the draft, the same thing the Capture button does. capture()
  // returns early on an empty composer, so the chord on a blank one writes nothing.
  useSaveKey(() => { void capture(); });

  const pageRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focus) return;
    const h = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t && t !== document.body && !pageRef.current?.contains(t) && t.closest("[role=dialog], [role=alertdialog], [data-knav-modal]")) return;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable) && !t.hasAttribute("data-knav-armed")) return;
      e.preventDefault(); e.stopPropagation(); setFocus(false);
    };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [focus]);

  const titleInput = (big?: boolean) => (
    <input value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={onKey}
      placeholder="Title — optional"
      className={`w-full bg-transparent border-0 border-b border-border/60 focus:outline-none focus:border-primary py-2 ${big ? "text-[20px]" : "text-[15px]"} placeholder:text-muted-foreground/50`}
      style={{ fontFamily: "Georgia, 'Times New Roman', serif" }} />
  );

  return (
    <div className="grid gap-5 items-start xl:grid-cols-2 min-[1700px]:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <div className="contents xl:flex xl:flex-col xl:gap-5 xl:min-w-0">
        <WidgetFrame id="notes.capture" title="Capture" className="order-1">
          <CaptureCard words={words} titleInput={titleInput()} text={text} setText={setText} onKey={onKey}
            capture={capture} saving={saving} canSave={!!(text.trim() || title.trim())} onFull={() => setFocus(true)}
            inboxItems={inboxItems} onOpen={onOpen} />
        </WidgetFrame>

        <WidgetFrame id="notes.filed" title="Filed" className="order-3">
          <FiledCard tick={tick} onBump={onBump} onOpen={onOpen} />
        </WidgetFrame>
      </div>

      <div className="contents xl:flex xl:flex-col xl:min-w-0">
        <WidgetFrame id="notes.inbox" title="Inbox" className="order-2">
          <InboxCard inboxItems={inboxItems} onBump={onBump} onOpen={onOpen} />
        </WidgetFrame>
      </div>

      {focus && createPortal(
        <div ref={pageRef} role="dialog" aria-modal="true" aria-label="Capture a note" data-knav-modal data-knav-full-page
          className="fixed inset-0 z-[100] bg-background flex flex-col animate-in fade-in duration-150">
          <div className="shrink-0 flex items-center justify-between px-6 py-4 border-b border-border/60">
            <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.09em] font-semibold text-muted-foreground">
              <NotebookPen size={13} /> Capture a note
              <span className="ml-2 nums normal-case tracking-normal text-muted-foreground/60">{words} words</span>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={capture} disabled={saving || (!text.trim() && !title.trim())}
                className="inline-flex items-center gap-1.5 rounded-full bg-primary text-primary-foreground px-4 py-1.5 text-[12px] font-medium hover:opacity-90 transition-opacity disabled:opacity-40">
                <Send size={13} /> Capture <kbd className="text-[10px] opacity-70">⌘↵</kbd>
              </button>
              <button onClick={() => setFocus(false)} data-knav-back
                className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-[12px] text-muted-foreground hover:text-foreground hover:border-primary/50 transition-colors">
                <Minimize2 size={13} /> Done <kbd className="text-[10px] opacity-60">esc</kbd>
              </button>
            </div>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto">
            <div className="mx-auto max-w-[720px] h-full px-6 py-10 flex flex-col">
              {titleInput(true)}
              {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
              <textarea value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} autoFocus
                placeholder="What's on your mind…"
                className="w-full flex-1 min-h-[55vh] mt-4 bg-transparent border-0 resize-none focus:outline-none text-[18px] leading-[1.9] text-foreground/90 placeholder:text-muted-foreground/40"
                style={{ fontFamily: "Georgia, 'Times New Roman', serif" }} />
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

// the composer tile: a short box on a quarter; its focused view is a page-high composer
// with the inbox and the latest filed notes beside it (below it on a narrow page)
function CaptureCard({ words, titleInput, text, setText, onKey, capture, saving, canSave, onFull, inboxItems, onOpen }: {
  words: number; titleInput: React.ReactNode; text: string; setText: (v: string) => void;
  onKey: (e: React.KeyboardEvent) => void; capture: () => void; saving: boolean; canSave: boolean; onFull: () => void;
  inboxItems: NoteInboxItem[]; onOpen: (n: GraphNode) => void;
}) {
  const t = useTier();
  // ⏎ again on the composer (the focused view's own box) opens the full page; the
  // "Capture" title is the mouse path to the same thing
  useFullPage(onFull);
  if (t.focused) return (
    <div className={`h-full min-h-0 grid gap-5 ${t.compact ? "grid-rows-[minmax(0,1fr)_auto]" : "grid-cols-[minmax(0,3fr)_minmax(0,2fr)]"}`}>
      <ComposerCard words={words} titleInput={titleInput} text={text} setText={setText} onKey={onKey} capture={capture}
        saving={saving} canSave={canSave} onFull={onFull} />
      <CaptureSide inboxItems={inboxItems} onOpen={onOpen} compact={t.compact} />
    </div>
  );
  return <ComposerCard words={words} titleInput={titleInput} text={text} setText={setText} onKey={onKey}
    capture={capture} saving={saving} canSave={canSave} onFull={onFull} />;
}

// beside the focused composer: what is waiting to be filed, then what was filed last
function CaptureSide({ inboxItems, onOpen, compact }: { inboxItems: NoteInboxItem[]; onOpen: (n: GraphNode) => void; compact: boolean }) {
  const all = useApi(() => api.notesAll(), [inboxItems.length], 0);
  const filed = useMemo(() => [...(all.data?.items || [])].sort((a, b) => b.mtime - a.mtime), [all.data]);
  const row = (path: string, title: string, type: string, mtime: number) => (
    <button key={path} onClick={() => onOpen(nodeFor(path, title, type, false))} data-obsidian-file={path} title={title}
      className="w-full min-w-0 flex items-center gap-2 py-1.5 text-left text-[12.5px] text-muted-foreground hover:text-primary transition-colors border-b border-border/40 last:border-0">
      <FileText size={12} className="shrink-0 opacity-60" />
      <span className="truncate flex-1 text-foreground/90">{title}</span>
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground/60 shrink-0">{type}</span>
      {mtime > 0 && <span className="text-[10.5px] text-muted-foreground/60 nums shrink-0">{fmtDay(mtime)}</span>}
    </button>
  );
  const head = "text-[11px] uppercase tracking-[0.09em] font-semibold text-muted-foreground flex items-center gap-1.5 mb-1.5 shrink-0";
  return (
    <Card className="min-h-0 flex flex-col p-5 overflow-y-auto tinybar">
      <div className={head}><Inbox size={13} /> Inbox {inboxItems.length > 0 && <span className="nums normal-case tracking-normal">· {inboxItems.length}</span>}</div>
      <div className="shrink-0 mb-4">
        {inboxItems.length === 0
          ? <p className="text-[12.5px] text-muted-foreground" title="New captures wait here until you file them">Clear.</p>
          : inboxItems.slice(0, compact ? 3 : undefined).map((it) => row(`Preparation/Notes/Inbox/${it.filename}`, it.title, "inbox", it.mtime))}
      </div>
      <div className={head}><NotebookPen size={13} /> Recently filed</div>
      <div className="shrink-0">
        {!all.data ? <p className="text-[12.5px] text-muted-foreground">loading…</p>
          : filed.slice(0, compact ? 3 : 40).map((n) => row(n.path, n.title, n.type || n.folder, n.mtime))}
      </div>
    </Card>
  );
}

function ComposerCard({ words, titleInput, text, setText, onKey, capture, saving, canSave, onFull }: {
  words: number; titleInput: React.ReactNode; text: string; setText: (v: string) => void;
  onKey: (e: React.KeyboardEvent) => void; capture: () => void; saving: boolean; canSave: boolean; onFull: () => void;
}) {
  const t = useTier();
  return (
    <Card className="h-full min-h-0 flex flex-col p-6 group-data-[size=xs]/widget:p-4">
      <div className="flex items-center justify-between mb-2">
        {/* the title is the mouse path to the full page; ⏎ on the box below is the key */}
        <button type="button" onClick={onFull} title="Full page — distraction-free writing (⏎ on the box, Esc to leave)"
          className="text-[11px] uppercase tracking-[0.09em] font-semibold text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1.5">
          <NotebookPen size={13} /> Capture
        </button>
        <span className="text-[11px] text-muted-foreground nums">{words} words</span>
      </div>
      {titleInput}
      <textarea value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} data-knav-primary
        rows={t.compact ? 6 : 11} style={{ minHeight: t.focused ? 120 : t.compact ? 140 : 260 }} placeholder="What's on your mind…"
        className="w-full mt-3 bg-background border border-border rounded-lg px-3.5 py-3 text-[14px] leading-relaxed resize-y focus:outline-none focus:border-primary group-data-[focused]/widget:flex-1 group-data-[focused]/widget:resize-none" />
      <div className="mt-4 flex items-center gap-2.5 flex-wrap">
        <button onClick={capture} disabled={saving || !canSave}
          className="inline-flex items-center gap-2 rounded-full bg-primary text-primary-foreground px-5 py-2 text-[12.5px] font-medium hover:opacity-90 transition-opacity disabled:opacity-40">
          <Send size={14} /> {saving ? "Capturing…" : "Capture"}
          <kbd className="text-[10px] bg-primary-foreground/20 px-1 py-0.5 rounded">⌘↵</kbd>
        </button>
        <button type="button" onClick={onFull}
          title="Full page — the clean writing surface (⏎ again on the box, Esc to leave)"
          className="group inline-flex items-center gap-2 rounded-full border border-border bg-secondary/40 px-4 py-2 text-[12.5px] font-medium text-muted-foreground hover:text-foreground hover:border-primary/50 hover:bg-secondary transition-colors">
          <Maximize2 size={14} className="text-primary" /> Full page
        </button>
      </div>
    </Card>
  );
}

function InboxCard({ inboxItems, onBump, onOpen }: {
  inboxItems: NoteInboxItem[]; onBump: () => void; onOpen: (n: GraphNode) => void;
}) {
  const { shown, more, showAll } = useCapped(inboxItems, 4, 8);
  const t = useTier();
  // focused on a wide page: the captures in one column beside a preview of the one picked
  const split = t.focused && t.wide && inboxItems.length > 0;
  const [sel, setSel] = useState<string | null>(null);
  const cur = inboxItems.find((it) => it.filename === sel) || inboxItems[0];
  const head = (
    <div className="text-[11px] uppercase tracking-[0.09em] font-semibold text-muted-foreground flex items-center gap-1.5 mb-3 shrink-0">
      <Inbox size={13} /> Inbox {inboxItems.length > 0 && <span className="nums normal-case tracking-normal">· {inboxItems.length}</span>}
    </div>
  );
  if (split) return (
    <Card className="h-full min-h-0 flex flex-col p-6">
      {head}
      <div className="flex-1 min-h-0 grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-5">
        <div className="min-h-0 overflow-y-auto tinybar p-1 grid content-start gap-3">
          <InboxRows shown={shown} split selected={cur?.filename} onPick={setSel} onBump={onBump} onOpen={onOpen} />
          <MoreRows more={more} onClick={showAll} />
        </div>
        <NotePreview path={`Preparation/Notes/Inbox/${cur.filename}`} title={cur.title}
          meta={[cur.source, (cur.created || "").replace("T", " ")].filter(Boolean).join(" · ")} />
      </div>
    </Card>
  );
  return (
      <Card className="h-full group-data-[focused]/widget:h-auto group-data-[focused]/widget:min-h-full p-6 group-data-[size=xs]/widget:p-4">
        {head}
        {inboxItems.length === 0 ? (
          <p className="text-[12.5px] text-muted-foreground" title="New captures wait here until you file them">Clear.</p>
        ) : (
          <div className="grid gap-3 group-data-[size=xl]/widget:grid-cols-2">
            <InboxRows shown={shown} onBump={onBump} onOpen={onOpen} />
          </div>
        )}
        <MoreRows more={more} onClick={showAll} />
      </Card>
  );
}

const INBOX_TARGETS = ["ideas", "concepts", "meetings", "project", "course", "archive"] as const;

function InboxRows({ shown, split, selected, onPick, onBump, onOpen }: {
  shown: NoteInboxItem[]; split?: boolean; selected?: string; onPick?: (filename: string) => void;
  onBump: () => void; onOpen: (n: GraphNode) => void;
}) {
  const rest = useRestIntent();   // a resting pointer previews, a passing one does not
  return (
          <>
            {shown.map((it) => (
              <div key={it.id} data-obsidian-file={`Preparation/Notes/Inbox/${it.filename}`}
                {...(split && onPick ? { onFocusCapture: () => onPick(it.filename), onClick: () => onPick(it.filename), ...rest(it.filename, () => onPick(it.filename)) } : {})}
                className={`min-w-0 rounded-lg border bg-card/40 px-4 py-3 ${split && selected === it.filename ? "border-primary/50" : "border-border/70"}`}>
                <button onClick={() => onOpen(nodeFor(`Preparation/Notes/Inbox/${it.filename}`, it.title, "inbox", false))}
                  className="w-full text-left group">
                  <div className="flex items-center gap-2">
                    <FileText size={13} className="shrink-0 text-muted-foreground/60" />
                    <span className="flex-1 min-w-0 text-[13.5px] font-medium truncate group-hover:text-primary transition-colors">{it.title}</span>
                    <span className="ml-auto shrink-0 text-[10.5px] text-muted-foreground/60 nums">{it.created}</span>
                  </div>
                  {it.preview && it.preview !== it.title && <div className="mt-1 pl-[21px] text-[12px] text-muted-foreground truncate">{it.preview}</div>}
                </button>
                <div className="mt-2 pl-[21px]">
                  <FileStrip path={`Preparation/Notes/Inbox/${it.filename}`} title={it.title} mode="file"
                    label="File into" targets={[...INBOX_TARGETS]} onChanged={onBump} />
                </div>
              </div>
            ))}
          </>
  );
}

// what was filed lately (each with its own Undo) and what sits in the archive (Restore).
// Either list hides itself when its route is missing.
const fmtWhen = (ts: string) => {
  const d = new Date(ts);
  return isNaN(d.getTime()) ? ts : d.toLocaleString("en", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
};
const leaf = (p: string) => (p.split("/").slice(-2, -1)[0] || p);

function FiledCard({ tick, onBump, onOpen }: { tick: number; onBump: () => void; onOpen: (n: GraphNode) => void }) {
  const hist = useApi(() => api.noteHistory(20), [tick], 0);
  const arch = useApi(() => api.notesArchived(), [tick], 0);
  const [busy, setBusy] = useState<string | null>(null);
  const filed = hist.data?.items || [];
  const archived = arch.data?.items || [];
  const f = useCapped(filed, 5, 12);
  const a = useCapped(archived, 5, 12);
  const act = async (key: string, fn: () => Promise<{ ok: boolean; error?: string }>, done: string, title: string) => {
    if (busy) return;
    setBusy(key);
    try {
      const r = await fn();
      if (r.ok) { toast.success(done, { description: title }); onBump(); }
      else toast.error(r.error || "Couldn't do that");
    } catch (e) { toast.error((e as Error).message || "Couldn't do that"); }
    finally { setBusy(null); }
  };
  const head = "text-[11px] uppercase tracking-[0.09em] font-semibold text-muted-foreground flex items-center gap-1.5 mb-1.5";
  const rowCls = "min-w-0 flex items-center gap-2 py-1.5 border-b border-border/40 last:border-0";
  const btn = "shrink-0 inline-flex items-center gap-1 rounded-full border border-border bg-background px-2.5 py-1 text-[11.5px] text-muted-foreground hover:text-foreground hover:border-primary/60 transition-colors disabled:opacity-40";
  if (hist.error && arch.error) return null;
  return (
    <Card className="h-full group-data-[focused]/widget:h-auto group-data-[focused]/widget:min-h-full p-6 group-data-[size=xs]/widget:p-4 grid gap-6 group-data-[size=lg]/widget:grid-cols-2 group-data-[size=xl]/widget:grid-cols-2 content-start">
      {!hist.error && (
        <div className="min-w-0">
          <div className={head} title="The latest files and moves; Undo puts a note back"><Undo2 size={13} /> Recent filings</div>
          {!hist.data ? <p className="text-[12.5px] text-muted-foreground">loading…</p>
            : filed.length === 0 ? <p className="text-[12.5px] text-muted-foreground">Nothing filed yet.</p>
            : f.shown.map((h) => (
              <div key={h.undo_id} className={rowCls}>
                <div className={`min-w-0 flex-1 ${h.undone ? "opacity-50" : ""}`} title={`${h.from} → ${h.to}`}>
                  <div className="text-[12.5px] text-foreground/90 truncate">{h.title}</div>
                  <div className="text-[10.5px] text-muted-foreground/70 truncate nums">{h.action} → {leaf(h.to)} · {fmtWhen(h.ts)}</div>
                </div>
                <button disabled={h.undone || !!busy} className={btn}
                  title={h.undone ? "Already undone" : `Put it back in ${leaf(h.from)}`}
                  onClick={() => act(h.undo_id, () => api.noteUndo(h.undo_id), "Undone", h.title)}>
                  {busy === h.undo_id ? <Loader2 size={11} className="animate-spin" /> : <Undo2 size={11} />} {h.undone ? "Undone" : "Undo"}
                </button>
              </div>
            ))}
          <MoreRows more={f.more} onClick={f.showAll} />
        </div>
      )}
      {!arch.error && (
        <div className="min-w-0">
          <div className={head} title="Archived notes; Restore returns one to where it came from"><Archive size={13} /> Archived</div>
          {!arch.data ? <p className="text-[12.5px] text-muted-foreground">loading…</p>
            : archived.length === 0 ? <p className="text-[12.5px] text-muted-foreground">Empty.</p>
            : a.shown.map((x) => (
              <div key={x.path} className={rowCls} data-obsidian-file={x.path}>
                <button onClick={() => onOpen(nodeFor(x.path, x.title, "archive", true))} title={x.origin || x.path}
                  className="min-w-0 flex-1 text-left group">
                  <div className="text-[12.5px] text-foreground/90 truncate group-hover:text-primary transition-colors">{x.title}</div>
                  <div className="text-[10.5px] text-muted-foreground/70 truncate nums">{x.from_folder} · {fmtWhen(x.archived_at)}</div>
                </button>
                <button disabled={!!busy} className={btn} title={`Restore to ${x.origin ? leaf(x.origin) : x.from_folder}`}
                  onClick={() => act(x.path, () => api.noteUnarchive(x.path), "Restored", x.title)}>
                  {busy === x.path ? <Loader2 size={11} className="animate-spin" /> : <ArchiveRestore size={11} />} Restore
                </button>
              </div>
            ))}
          <MoreRows more={a.more} onClick={a.showAll} />
        </div>
      )}
    </Card>
  );
}

// ============================================================================ overview
function OverviewView({ tick, onGo, onOpen }: { tick: number; onGo: (s: Section) => void; onOpen: (n: GraphNode) => void }) {
  const o = useApi(() => api.aioaOverview(), [tick], 0);
  const c = o.data?.counts || {};
  const cards: { go: Section; icon: React.ReactNode; label: string; count: number; sub: string }[] = [
    { go: "corpus", icon: <Library size={16} />, label: "Corpus", count: c.citations || 0, sub: `${c.citationsRead || 0} read` },
    { go: "authors", icon: <Users size={16} />, label: "Authors", count: c.authors || 0, sub: `${c.profiles || 0} ${c.profiles === 1 ? "profile" : "profiles"} written` },
    { go: "concepts", icon: <Shapes size={16} />, label: "Concepts", count: c.concepts || 0, sub: "your working vocabulary" },
    { go: "ideas", icon: <Lightbulb size={16} />, label: "Ideas", count: (c.ideas || 0) + (c.reflections || 0), sub: c.inbox ? `${c.inbox} in the inbox` : "inbox is clear" },
    { go: "meetings", icon: <CalendarDays size={16} />, label: "Meetings", count: c.meetings || 0, sub: "prep + reflections" },
    { go: "projects", icon: <FolderKanban size={16} />, label: "Projects", count: c.projects || 0, sub: `${c.projectNotes || 0} logs + corpus notes` },
  ];
  const recent = o.data?.recent || [];
  return (
    <div>
      <SectionHead title="Overview" sub="The full scope of what you've written and read — pick a thread." />
      <WidgetFrame id="notes.counts" title="Overview">
        <CountsGrid cards={cards} onGo={onGo} />
      </WidgetFrame>
      {recent.length > 0 && (
        <WidgetFrame id="notes.recent" title="Recently touched" className="mt-8">
          <RecentTouched recent={recent} onOpen={onOpen} />
        </WidgetFrame>
      )}
    </div>
  );
}

type CountCard = { go: Section; icon: React.ReactNode; label: string; count: number; sub: string };
// six counts: 2 across on a quarter, 3 on a half, all 6 in one row when wide; the
// focused view grows them into a 3x2 wall (2x3 when narrow) that fills the page
function CountsGrid({ cards, onGo }: { cards: CountCard[]; onGo: (s: Section) => void }) {
  const t = useTier();
  const cols = t.compact ? 2 : 3;
  const style = t.focused
    ? { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${Math.ceil(cards.length / cols)}, minmax(0, 1fr)) auto` }
    : undefined;
  return (
    <div style={style} className={`grid grid-cols-2 gap-3 group-data-[size=md]/widget:grid-cols-3 group-data-[size=lg]/widget:grid-cols-3 group-data-[size=xl]/widget:grid-cols-6 ${t.focused ? "h-full min-h-0" : ""}`}>
      {cards.map((k) => (
        <button key={k.label} onClick={() => onGo(k.go)}
          className={`min-w-0 text-left rounded-xl border border-border bg-card/50 px-4 py-3.5 group-data-[size=xs]/widget:px-3 hover:border-primary/50 transition-colors group ${t.focused ? "min-h-0 overflow-hidden flex flex-col justify-between" : ""}`}>
          <div className="flex items-center gap-2 text-muted-foreground group-hover:text-primary transition-colors">{k.icon}
            <span className="text-[11px] uppercase tracking-[0.09em] font-semibold truncate">{k.label}</span></div>
          <div className={`mt-2 font-semibold tracking-tight nums leading-none ${t.focused ? (t.compact ? "text-[34px]" : "text-[52px]") : "text-[26px]"}`}>{k.count}</div>
          <div className={`mt-1 text-muted-foreground truncate ${t.focused && !t.compact ? "text-[13px]" : "text-[11.5px]"}`} title={k.sub}>{k.sub}</div>
        </button>
      ))}
      <button onClick={() => onGo("map")} title="The atlas view of all of it: families, idea clusters, ego-networks"
        className="text-left rounded-xl border border-dashed border-border bg-card/30 px-4 py-3.5 hover:border-primary/50 transition-colors group col-span-full">
        <div className="flex items-center gap-2 min-w-0 text-muted-foreground group-hover:text-primary transition-colors">
          <Network size={16} className="shrink-0" /><span className="text-[11px] uppercase tracking-[0.09em] font-semibold">Map</span>
          <span className="hidden truncate text-[11.5px] normal-case tracking-normal font-normal group-data-[size=md]/widget:inline group-data-[size=lg]/widget:inline group-data-[size=xl]/widget:inline">— the atlas view of all of it: families, idea clusters, ego-networks</span>
          <ChevronRight size={14} className="ml-auto shrink-0" />
        </div>
      </button>
    </div>
  );
}

function RecentTouched({ recent, onOpen }: { recent: { path: string; title: string; type: string; mtime: number }[]; onOpen: (n: GraphNode) => void }) {
  const t = useTier();
  const { shown, more, showAll } = useCapped(recent, 8, 16);
  // focused with room: one column of rows beside a preview of the one picked
  const split = t.focused && !t.compact && recent.length > 0;
  const [sel, setSel] = useState<string | null>(null);
  const cur = recent.find((r) => r.path === sel) || recent[0];
  const rest = useRestIntent();
  // the overview can list one note twice (same path and mtime): the index keeps keys unique
  const rows = shown.map((r, i) => (
    <button key={`${r.path}:${r.mtime}:${i}`} onClick={() => onOpen(nodeFor(r.path, r.title, r.type, ["citation", "project", "meeting"].includes(r.type)))}
      data-obsidian-file={r.path}
      {...(split ? { onFocus: () => setSel(r.path), ...rest(r.path, () => setSel(r.path)) } : {})}
      className={`min-w-0 flex items-center gap-2 text-left text-[12.5px] hover:text-primary transition-colors border-b border-border/40 ${
        split ? `py-2 px-2 rounded-md ${cur?.path === r.path ? "bg-secondary/50 text-foreground" : "text-muted-foreground"}` : "py-1.5 text-muted-foreground"}`}>
      <FileText size={12} className="shrink-0 opacity-60" />
      <span className="truncate flex-1">{r.title}</span>
      {!t.xs && <span className="text-[10px] uppercase tracking-wide text-muted-foreground/60 shrink-0">{r.type}</span>}
      <span className="text-[10.5px] text-muted-foreground/60 nums shrink-0">{fmtDay(r.mtime)}</span>
    </button>
  ));
  if (split) return (
    <div className="h-full min-h-0 flex flex-col">
      <div className="shrink-0 text-[11px] uppercase tracking-[0.09em] font-semibold text-muted-foreground mb-2">Recently touched</div>
      <div className={`flex-1 min-h-0 grid gap-5 ${t.wide ? "grid-cols-[minmax(0,2fr)_minmax(0,3fr)]" : "grid-cols-2"}`}>
        <div className="min-h-0 overflow-y-auto tinybar p-1 grid content-start">
          {rows}
          <MoreRows more={more} onClick={showAll} />
        </div>
        <NotePreview path={cur.path} title={cur.title} meta={`${cur.type} · ${fmtDay(cur.mtime)}`} />
      </div>
    </div>
  );
  return (
    <div>
      <div className="text-[11px] uppercase tracking-[0.09em] font-semibold text-muted-foreground mb-2">Recently touched</div>
      <div className="grid gap-x-8 gap-y-1 group-data-[size=md]/widget:grid-cols-2 group-data-[size=lg]/widget:grid-cols-2 group-data-[size=xl]/widget:grid-cols-3">
        {rows}
      </div>
      <MoreRows more={more} onClick={showAll} />
    </div>
  );
}

// ============================================================================ authors
function AuthorsView({ onPick, tick, onOpen }: { onPick: (key: string) => void; tick: number; onOpen: (n: GraphNode) => void }) {
  const [input, setInput] = useState("");
  const [sort, setSort] = useState("works");
  const dq = useDebounced(input);
  const a = useApi(() => api.aioaAuthors(dq, sort), [dq, sort], 0);
  const rows = a.data?.authors || [];
  const t = useTier();
  const { shown, more, showAll } = useCapped(rows, 12, 24);
  return (
    <div>
      <SectionHead title="Authors"
        sub="Everyone with 2+ works in your library. A profile is your own bio for an author you use often — works, projects, and concepts compile themselves." />
      <MyAuthorNotes tick={tick} onOpen={onOpen} />
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <div className={`relative ${t.xs ? "w-full" : ""}`}>
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/60" />
          <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Find an author…"
            className={`h-8 ${t.xs ? "w-full" : "w-[220px]"} bg-secondary/40 border border-border rounded-full pl-8 pr-3 text-[12.5px] focus:outline-none focus:border-primary`} />
        </div>
        <div className="flex items-center gap-1 bg-secondary/60 rounded-lg p-1">
          {[["works", "Most read"], ["name", "A–Z"], ["recent", "Recent"]].map(([k, label]) => (
            <button key={k} onClick={() => setSort(k)}
              className={`px-2.5 py-1 rounded-md text-[11.5px] font-medium transition-colors ${sort === k ? "bg-card shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"}`}>
              {label}
            </button>
          ))}
        </div>
        <span className="text-[11.5px] text-muted-foreground nums ml-auto">{a.data?.count ?? "…"} authors</span>
      </div>
      <div className="grid gap-x-6 group-data-[size=md]/widget:grid-cols-2 group-data-[size=lg]/widget:grid-cols-2 group-data-[size=xl]/widget:grid-cols-3">
        {shown.map((r) => (
          <button key={r.key} onClick={() => onPick(r.key)} data-knav-id={`author-${r.key}`}
            className="min-w-0 flex items-center gap-3 py-2.5 text-left border-b border-border/40 group">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="text-[13.5px] font-medium truncate group-hover:text-primary transition-colors">{r.name}</span>
                {r.hasProfile && <BookUser size={12} className="shrink-0 text-primary/80" aria-label="has a profile" />}
              </div>
              <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground nums">
                <span>{r.works} {r.works === 1 ? "work" : "works"}</span>
                {r.read > 0 && <span>· {r.read} read</span>}
                {r.yearMin && <span>· {r.yearMin}{r.yearMax && r.yearMax !== r.yearMin ? `–${r.yearMax}` : ""}</span>}
              </div>
            </div>
            {!t.xs && <TagChips tags={r.topTags} max={2} />}
            <ChevronRight size={14} className="shrink-0 text-muted-foreground/40 group-hover:text-primary transition-colors" />
          </button>
        ))}
        {!a.data && <div className="text-[12.5px] text-muted-foreground py-6">loading…</div>}
        {a.data && rows.length === 0 && <div className="text-[12.5px] text-muted-foreground py-6">No matching authors.</div>}
      </div>
      <MoreRows more={more} onClick={showAll} />
    </div>
  );
}

// every note filed into Notes/Authors, first, so nothing filed there is ever hidden
// behind the citation-author list (hides itself when the route is missing)
function MyAuthorNotes({ tick, onOpen }: { tick: number; onOpen: (n: GraphNode) => void }) {
  const r = useApi(() => api.aioaAuthorNotes(), [tick], 0);
  const notes = r.data?.notes || [];
  const { shown, more, showAll } = useCapped(notes, 6, 12);
  if (r.error || !r.data || notes.length === 0) return null;
  return (
    <div className="mb-5">
      <div className="text-[11px] uppercase tracking-[0.09em] font-semibold text-muted-foreground mb-1 flex items-center gap-1.5"
        title="Everything in Preparation/Notes/Authors">
        <BookUser size={12} /> My author notes <span className="nums normal-case tracking-normal">· {notes.length}</span>
      </div>
      <div className="grid gap-x-6 group-data-[size=md]/widget:grid-cols-2 group-data-[size=lg]/widget:grid-cols-2 group-data-[size=xl]/widget:grid-cols-3">
        {shown.map((n) => (
          <button key={n.path} onClick={() => onOpen(nodeFor(n.path, n.title, "author", false))} data-obsidian-file={n.path} title={n.path}
            className="min-w-0 flex items-center gap-2 py-1.5 text-left border-b border-border/40 text-[12.5px] text-muted-foreground hover:text-primary transition-colors">
            <FileText size={12} className="shrink-0 opacity-60" />
            <span className="truncate flex-1 text-foreground/90">{n.title}</span>
            {n.mtime > 0 && <span className="text-[10.5px] nums text-muted-foreground/60 shrink-0">{fmtDay(n.mtime)}</span>}
          </button>
        ))}
      </div>
      <MoreRows more={more} onClick={showAll} />
    </div>
  );
}

function AuthorProfile({ authorKey, tick, onBack, onOpen, onChanged }:
  { authorKey: string; tick: number; onBack: () => void; onOpen: (n: GraphNode) => void; onChanged: () => void }) {
  const d = useApi(() => api.aioaAuthor(authorKey), [authorKey, tick], 0);
  const [bio, setBio] = useState<NoteRead | null>(null);
  const [creating, setCreating] = useState(false);
  const det = d.data;

  useEffect(() => {
    let live = true;
    setBio(null);
    const p = det?.profile?.path;
    if (p) api.noteRead(p).then((r) => { if (live) setBio(r); }).catch(() => {});
    return () => { live = false; };
  }, [det?.profile?.path]);

  const createProfile = async () => {
    if (!det) return;
    setCreating(true);
    try {
      const r = await api.aioaAuthorProfile(det.name);
      if (r.ok && r.path) {
        toast.success(r.existed ? "Profile already exists" : "Profile created");
        onChanged();
        onOpen(nodeFor(r.path, det.name, "author", false));
      } else toast.error(r.error || "Couldn't create the profile");
    } catch { toast.error("Couldn't create the profile"); }
    finally { setCreating(false); }
  };

  if (!det) return <div className="text-[12.5px] text-muted-foreground py-6">loading…</div>;
  if (!det.ok) return <div className="text-[12.5px] text-muted-foreground py-6">Unknown author.</div>;

  const byYear: { year: number | null; works: AioaWork[] }[] = [];
  for (const w of det.works) {
    const last = byYear[byYear.length - 1];
    if (last && last.year === (w.year ?? null)) last.works.push(w);
    else byYear.push({ year: w.year ?? null, works: [w] });
  }
  const s = det.stats;

  return (
    <div>
      <button onClick={onBack} data-knav-back
        className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-[12px] text-muted-foreground hover:text-foreground hover:border-primary/50 transition-colors mb-4">
        <ArrowLeft size={12} /> Authors
      </button>
      <div className="flex items-end justify-between gap-4 flex-wrap mb-1">
        <h2 className="text-[26px] font-semibold tracking-tight" style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}>{det.name}</h2>
        <div className="flex items-center gap-2">
          {det.profile ? (
            <button onClick={() => onOpen(nodeFor(det.profile!.path, det.name, "author", false))}
              className="inline-flex items-center gap-1.5 rounded-full border border-border px-3.5 py-1.5 text-[12px] text-muted-foreground hover:text-foreground hover:border-primary/50 transition-colors">
              <Pencil size={12} /> Edit profile
            </button>
          ) : (
            <button onClick={createProfile} disabled={creating}
              className="inline-flex items-center gap-1.5 rounded-full bg-primary text-primary-foreground px-4 py-1.5 text-[12px] font-medium hover:opacity-90 disabled:opacity-50 transition-opacity">
              {creating ? <Loader2 size={12} className="animate-spin" /> : <BookUser size={12} />} Write a profile
            </button>
          )}
        </div>
      </div>
      <div className="flex items-center gap-3 text-[12px] text-muted-foreground nums flex-wrap mb-4">
        <span>{s.works} {s.works === 1 ? "work" : "works"}</span>
        {s.lead > 0 && s.lead !== s.works && <span>· {s.lead} as lead</span>}
        {s.read > 0 && <span>· {s.read} read</span>}
        {s.yearMin && <span>· {s.yearMin}{s.yearMax && s.yearMax !== s.yearMin ? `–${s.yearMax}` : ""}</span>}
      </div>
      {det.topTags.length > 0 && <div className="mb-5"><TagChips tags={det.topTags} max={8} /></div>}

      <div className="grid gap-8 items-start group-data-[size=lg]/widget:grid-cols-[minmax(0,1fr)_300px] group-data-[size=xl]/widget:grid-cols-[minmax(0,1fr)_340px]">
        <div>
          {/* the bio — hand-written, yours */}
          {det.profile && bio?.ok && bio.body.trim() ? (
            <div className="rounded-xl border border-border bg-card/40 px-5 py-4 mb-6">
              <div className="text-[10px] uppercase tracking-[0.1em] font-semibold text-muted-foreground mb-2 flex items-center gap-1.5">
                <BookUser size={11} /> Profile
              </div>
              <div className="prose-notes text-[13.5px] leading-relaxed"><Markdown text={bio.body} idPrefix="ar-" /></div>
            </div>
          ) : !det.profile ? (
            <div className="rounded-xl border border-dashed border-border bg-secondary/20 px-5 py-4 mb-6 text-[12.5px] text-muted-foreground leading-relaxed">
              No profile yet. A profile is your own in-depth summary of {det.name} — background, core
              contribution, where their thinking breaks down — kept at{" "}
              <code className="text-[11.5px] bg-secondary px-1 py-0.5 rounded">Preparation/Notes/Authors/</code>.
              The reading list below compiles itself either way.
            </div>
          ) : null}

          {/* works, by year — the thread */}
          <div className="text-[10px] uppercase tracking-[0.1em] font-semibold text-muted-foreground mb-1">Works in your library</div>
          {byYear.map((g) => (
            <div key={String(g.year)} className="flex gap-4 border-b border-border/40 py-2">
              <div className="w-11 shrink-0 text-[12.5px] font-semibold nums text-muted-foreground pt-1">{g.year ?? "—"}</div>
              <div className="min-w-0 flex-1">
                {g.works.map((w) => (
                  <button key={w.rel} onClick={() => onOpen(nodeFor(w.rel, w.title, "citation", true, w.tags))}
                    data-obsidian-file={w.rel} className="w-full min-w-0 text-left py-1 group">
                    <div className="flex items-center gap-2">
                      <StatusDot status={w.status} />
                      <span className="text-[13px] truncate group-hover:text-primary transition-colors">{w.title}</span>
                      <Stars n={w.rating} />
                      {!w.lead && <span className="text-[9.5px] uppercase tracking-wide text-muted-foreground/50 shrink-0">co-author</span>}
                    </div>
                    <div className="flex items-center gap-2 pl-3.5 mt-0.5 text-[10.5px] text-muted-foreground/70">
                      {w.sourceType && <span className="uppercase tracking-wide">{w.sourceType}</span>}
                      {w.source && <span className="truncate">{w.source}</span>}
                      {w.quotes > 0 && <span className="inline-flex items-center gap-0.5 nums shrink-0"><Quote size={9} /> {w.quotes}</span>}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          ))}
          {det.works.length === 0 && <div className="text-[12.5px] text-muted-foreground py-4">No works in the library yet.</div>}
        </div>

        {/* the thread's other strands */}
        <div className="grid gap-5">
          {det.projects.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-[0.1em] font-semibold text-muted-foreground mb-1.5 flex items-center gap-1.5"><FolderKanban size={11} /> In your projects</div>
              {det.projects.map((p) => (
                <div key={p.project} className="mb-2">
                  <div className="text-[12px] font-medium">{p.project}</div>
                  {p.notes.map((n) => (
                    <button key={n.path} onClick={() => onOpen(nodeFor(n.path, n.title, "project"))}
                      className="w-full text-left flex items-center gap-1.5 py-0.5 text-[11.5px] text-muted-foreground hover:text-primary transition-colors">
                      <FileText size={10} className="shrink-0 opacity-60" /><span className="truncate">{n.title}</span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}
          {det.concepts.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-[0.1em] font-semibold text-muted-foreground mb-1.5 flex items-center gap-1.5"><Shapes size={11} /> Concepts they touch</div>
              {det.concepts.map((c) => (
                <button key={c.path} onClick={() => onOpen(nodeFor(c.path, c.title, "concept", false))}
                  className="w-full text-left flex items-center gap-1.5 py-1 text-[12px] text-muted-foreground hover:text-primary transition-colors">
                  <span className="truncate flex-1">{c.title}</span>
                  <span className="text-[10px] nums text-muted-foreground/60">{c.n}</span>
                </button>
              ))}
            </div>
          )}
          {det.meetings.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-[0.1em] font-semibold text-muted-foreground mb-1.5 flex items-center gap-1.5"><CalendarDays size={11} /> In your meetings</div>
              {det.meetings.map((m) => (
                <button key={m.path} onClick={() => onOpen(nodeFor(m.path, m.title, "meeting", m.readonly))}
                  className="w-full text-left flex items-center gap-1.5 py-1 text-[12px] text-muted-foreground hover:text-primary transition-colors">
                  <span className="truncate flex-1">{m.title}</span>
                  <span className="text-[10px] nums text-muted-foreground/60 shrink-0">{m.date}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================================ corpus
function CorpusView({ onOpen, onAuthor }: { onOpen: (n: GraphNode) => void; onAuthor: (key: string) => void }) {
  const [input, setInput] = useState("");
  const dq = useDebounced(input);
  const [tag, setTag] = useState("");
  const [status, setStatus] = useState("");
  const [stype, setSType] = useState("");
  const [sort, setSort] = useState("-year");
  const [page, setPage] = useState<AioaCitationsPage | null>(null);
  const [items, setItems] = useState<AioaWork[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    let live = true;
    api.aioaCitations({ q: dq, tag, status, type: stype, sort, limit: 100 })
      .then((r) => { if (live) { setPage(r); setItems(r.items); } }).catch(() => {});
    return () => { live = false; };
  }, [dq, tag, status, stype, sort]);

  const loadMore = async () => {
    if (!page) return;
    setLoadingMore(true);
    try {
      const r = await api.aioaCitations({ q: dq, tag, status, type: stype, sort, offset: items.length, limit: 200 });
      setItems((prev) => [...prev, ...r.items]);
      setPage(r);
    } finally { setLoadingMore(false); }
  };

  const f = page?.facets;
  const t = useTier();
  const { shown, more, showAll } = useCapped(items, 12, 25);
  const tagCap = t.focused ? 18 : t.compact ? 6 : 12;
  const authorKey = (w: AioaWork) => (w.author.replace(/\bet al\b\.?/i, "").split(/,|\band\b|&/)[0] || "").trim().toLowerCase();
  const sel = "h-8 bg-secondary/40 border border-border rounded-full px-3 text-[12px] focus:outline-none focus:border-primary text-foreground";
  return (
    <div>
      <SectionHead title="Corpus" sub="Your reading library, by citation — filter it down to the thread you're chasing." />
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <div className={`relative ${t.xs ? "w-full" : ""}`}>
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/60" />
          <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Search the corpus…"
            className={`h-8 ${t.xs ? "w-full" : "w-[240px]"} bg-secondary/40 border border-border rounded-full pl-8 pr-3 text-[12.5px] focus:outline-none focus:border-primary`} />
        </div>
        <select value={status} onChange={(e) => setStatus(e.target.value)} className={sel} aria-label="Status">
          <option value="">All statuses</option>
          <option value="read">Read</option>
          <option value="unread">Unread</option>
        </select>
        <select value={stype} onChange={(e) => setSType(e.target.value)} className={sel} aria-label="Source type">
          <option value="">All types</option>
          {(f?.sourceTypes || []).slice(0, 10).map((t) => <option key={t.type} value={t.type}>{t.type} ({t.n})</option>)}
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value)} className={sel} aria-label="Sort">
          <option value="-year">Newest first</option>
          <option value="year">Oldest first</option>
          <option value="recent">Recently touched</option>
          <option value="rating">Highest rated</option>
          <option value="author">By author</option>
          <option value="title">By title</option>
        </select>
        <span className="text-[11.5px] text-muted-foreground nums ml-auto">
          {page ? `${page.total} of ${f?.total ?? page.total}` : "…"}
        </span>
      </div>
      {/* idea facets — the corpus's recurring themes */}
      {/* idea facets — the corpus's recurring themes; they wrap, never scroll sideways */}
      <div className="flex items-center gap-1.5 mb-4 flex-wrap">
        {(f?.topTags || []).slice(0, tagCap).map((tg) => (
          <button key={tg.tag} onClick={() => setTag(tag === tg.tag ? "" : tg.tag)}
            className={`max-w-full truncate rounded-full border px-2.5 py-1 text-[11px] transition-colors ${
              tag === tg.tag ? "border-primary/60 bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:text-foreground hover:border-primary/40"}`}>
            {tg.tag} <span className="nums opacity-60">{tg.n}</span>
          </button>
        ))}
      </div>
      <div>
        {shown.map((w) => {
          const quotes = w.quotes > 0 && <span className="shrink-0 inline-flex items-center gap-0.5 text-[10.5px] text-muted-foreground/70 nums"><Quote size={9} /> {w.quotes}</span>;
          const stype = w.sourceType && w.sourceType !== "article" && (
            <span className="shrink-0 text-[9.5px] uppercase tracking-wide text-muted-foreground/60 bg-secondary px-1.5 py-0.5 rounded">{w.sourceType}</span>
          );
          const author = (cls: string) => (
            <button onClick={() => onAuthor(authorKey(w))} title={`All works by ${w.author}`}
              className={`min-w-0 truncate font-medium hover:text-primary transition-colors nums ${cls}`}>
              {w.author} {w.year ? `(${w.year})` : ""}
            </button>
          );
          const title = (
            <button onClick={() => onOpen(nodeFor(w.rel, w.title, "citation", true, w.tags))} title={w.title}
              className="min-w-0 flex-1 text-left text-[13px] text-muted-foreground group-hover:text-foreground truncate hover:!text-primary transition-colors">
              {w.title}
            </button>
          );
          // a narrow tile stacks title over author; wider ones keep the one-line row
          return t.compact ? (
            <div key={w.rel} data-obsidian-file={w.rel} className="min-w-0 py-2 border-b border-border/40 group">
              <div className="flex items-center gap-2.5 min-w-0">
                <StatusDot status={w.status} />{title}<Stars n={w.rating} />
              </div>
              <div className="flex items-center gap-2 pl-4 mt-0.5 min-w-0">
                {author("text-[11.5px] text-muted-foreground")}{quotes}{stype}
              </div>
            </div>
          ) : (
            <div key={w.rel} data-obsidian-file={w.rel} className="min-w-0 flex items-center gap-2.5 py-2 border-b border-border/40 group">
              <StatusDot status={w.status} />
              {author("shrink-0 max-w-[38%] text-[12.5px]")}
              {title}
              <Stars n={w.rating} />
              {quotes}{stype}
              {t.wide && <TagChips tags={w.tags} max={2} />}
            </div>
          );
        })}
        {!page && <div className="text-[12.5px] text-muted-foreground py-6">loading…</div>}
        {page && items.length === 0 && <div className="text-[12.5px] text-muted-foreground py-6">Nothing matches those filters.</div>}
        <MoreRows more={more} onClick={showAll} />
        {page && more === 0 && items.length < page.total && (
          <button onClick={loadMore} disabled={loadingMore}
            className="mt-4 inline-flex items-center gap-1.5 rounded-full border border-border px-4 py-1.5 text-[12px] text-muted-foreground hover:text-foreground hover:border-primary/50 transition-colors disabled:opacity-50">
            {loadingMore ? <Loader2 size={12} className="animate-spin" /> : null}
            Show more <span className="nums opacity-60">({items.length} of {page.total})</span>
          </button>
        )}
      </div>
    </div>
  );
}

function NoteCard({ n, onOpen, onArchive }:
  { n: NoteItem; onOpen: (node: GraphNode) => void; onArchive: (n: NoteItem) => void }) {
  const [busy, setBusy] = useState(false);
  const open = () => onOpen(nodeFor(n.path, n.title, n.type, false, n.tags));
  return (
    // the archive button sits in its own column beside the card body (not over it), so
    // → from the card reaches it and ← comes back
    <div data-obsidian-file={n.path} className="group relative min-w-0 flex items-start text-left rounded-xl border border-border bg-card/40 hover:border-primary/50 transition-colors">
      <div role="button" tabIndex={0} onClick={open}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } }}
        className="flex-1 min-w-0 cursor-pointer pl-4 pr-1 py-3 outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded-xl">
        <div className="text-[13.5px] font-medium">{n.title}</div>
        {(n.summary || (n.preview !== n.title && n.preview)) && (
          <div className="mt-1 text-[12px] text-muted-foreground leading-relaxed line-clamp-2">{n.summary || n.preview}</div>
        )}
        <div className="mt-2 flex items-center gap-2">
          <TagChips tags={n.tags} max={3} />
          {n.mtime > 0 && <span className="ml-auto text-[10.5px] text-muted-foreground/60 nums">{fmtDay(n.mtime)}</span>}
        </div>
      </div>
      <button
        onClick={(e) => { e.stopPropagation(); if (busy) return; setBusy(true); Promise.resolve(onArchive(n)).finally(() => setBusy(false)); }}
        title="Archive this note"
        aria-label={`Archive ${n.title}`}
        className="shrink-0 mt-2 mr-2 inline-flex items-center justify-center w-6 h-6 rounded-md text-muted-foreground/35 group-hover:text-muted-foreground/70 hover:!text-foreground hover:bg-secondary/70 transition-colors disabled:opacity-50"
        disabled={busy}>
        {busy ? <Loader2 size={13} className="animate-spin" /> : <Archive size={13} />}
      </button>
    </div>
  );
}

function NotesListView({ kind, tick, onOpen, onChanged }:
  { kind: "concept" | "idea"; tick: number; onOpen: (n: GraphNode) => void; onChanged: () => void }) {
  const all = useApi(() => api.notesAll(), [tick], 0);
  const items = useMemo(() => (all.data?.items || []).filter((n) => n.type === kind), [all.data, kind]);
  const extras = useMemo(() => kind === "idea"
    ? (all.data?.items || []).filter((n) => n.type === "reflection") : [], [all.data, kind]);
  const head = kind === "concept"
    ? { title: "Concepts", sub: "Your working vocabulary — each note defines a term and anchors it to its canonical source." }
    : { title: "Ideas", sub: "Raw thoughts with legs — captured, then developed or graduated into projects." };
  const main = useCapped(items, 6, 12);
  const refl = useCapped(extras, 4, 8);
  const cardGrid = "grid gap-3 group-data-[size=md]/widget:grid-cols-2 group-data-[size=lg]/widget:grid-cols-2 group-data-[size=xl]/widget:grid-cols-3";

  const archive = async (n: NoteItem) => {
    const r = await api.noteArchive(n.path);
    if (!r.ok) { toast.error(r.error || "Couldn't archive that note"); return; }
    onChanged();
    toast.success("Archived", {
      description: n.title,
      action: {
        label: "Undo",
        onClick: async () => {
          const u = await api.noteUnarchive(r.archived || "");
          if (u.ok) { toast.success("Restored", { description: n.title }); onChanged(); }
          else toast.error(u.error || "Couldn't restore that note");
        },
      },
    });
  };

  const t = useTier();
  const [sel, setSel] = useState<string | null>(null);
  const rest = useRestIntent();
  const flat = [...items, ...extras];
  const split = t.focused && t.wide && flat.length > 0;
  const cur = flat.find((n) => n.path === sel) || flat[0];
  const pick = (n: NoteItem) => (
    <div key={n.id} onFocusCapture={() => setSel(n.path)} onClick={() => setSel(n.path)} {...rest(n.path, () => setSel(n.path))}
      className={`rounded-xl ${cur?.path === n.path ? "ring-1 ring-primary/40" : ""}`}>
      <NoteCard n={n} onOpen={onOpen} onArchive={archive} />
    </div>
  );
  if (split) return (
    <div className="h-full min-h-0 flex flex-col">
      <SectionHead title={head.title} sub={head.sub} />
      <div className="flex-1 min-h-0 grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-5">
        <div className="min-h-0 overflow-y-auto tinybar p-1 pr-2 grid content-start gap-3">
          {items.map(pick)}
          {extras.length > 0 && <div className="mt-3 text-[11px] uppercase tracking-[0.09em] font-semibold text-muted-foreground">Reflections</div>}
          {extras.map(pick)}
        </div>
        <NotePreview path={cur.path} title={cur.title} meta={[cur.folder, cur.mtime > 0 ? fmtDay(cur.mtime) : ""].filter(Boolean).join(" · ")} />
      </div>
    </div>
  );

  return (
    <div>
      <SectionHead title={head.title} sub={head.sub} />
      {!all.data ? <div className="text-[12.5px] text-muted-foreground py-6">loading…</div> : (
        <>
          <div className={cardGrid}>
            {main.shown.map((n) => <NoteCard key={n.id} n={n} onOpen={onOpen} onArchive={archive} />)}
          </div>
          <MoreRows more={main.more} onClick={main.showAll} />
          {items.length === 0 && <div className="text-[12.5px] text-muted-foreground py-6">Nothing here yet — capture a thought and file it.</div>}
          {extras.length > 0 && (
            <div className="mt-8">
              <div className="text-[11px] uppercase tracking-[0.09em] font-semibold text-muted-foreground mb-2">Reflections</div>
              <div className={cardGrid}>
                {refl.shown.map((n) => <NoteCard key={n.id} n={n} onOpen={onOpen} onArchive={archive} />)}
              </div>
              <MoreRows more={refl.more} onClick={refl.showAll} />
            </div>
          )}
        </>
      )}
    </div>
  );
}

const datedTitle = (base: string) => {
  const d = new Date(), p = (n: number) => String(n).padStart(2, "0");
  return `${base} ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

export function DiagramsView() {
  const lib = useApi(() => api.notesDiagrams(), [], 0);
  const tpls = useApi(() => api.noteDrawerTemplates(), [], 0);
  const [q, setQ] = useState("");
  const [zoom, setZoom] = useState<DiagramItem | null>(null);
  const [editing, setEditing] = useState<{ name: string | null; title?: string; template?: unknown } | null>(null);
  const [naming, setNaming] = useState<string | null>(null);
  const [from, setFrom] = useState<DrawerTemplate | null>(null);   // the template the name being typed will start from
  const stopNaming = () => { setNaming(null); setFrom(null); };
  const templates = (tpls.data?.items || []).filter((t) => t.doc);

  // a drawer target handed over by a deep link or the diagram window (lib/taskdest.ts):
  // taken once the list it names has loaded, and never over a drawing already open
  const editingRef = useRef(editing); editingRef.current = editing;
  const [startTick, setStartTick] = useState(0);
  useEffect(() => onPendingDiagramStart(() => setStartTick((n) => n + 1)), []);
  useEffect(() => {
    const s = pendingDiagramStart.current;
    if (!s) return;
    if (editingRef.current) { pendingDiagramStart.current = null; return; }
    if (s.kind === "new") { pendingDiagramStart.current = null; setEditing({ name: null, title: datedTitle("Diagram") }); return; }
    const want = diagramSlug(s.name);
    if (s.kind === "template") {
      if (!tpls.data && !tpls.error) return;
      pendingDiagramStart.current = null;
      const t = (tpls.data?.items || []).find((x) => x.doc && diagramSlug(x.name) === want);
      if (t) setEditing({ name: null, title: datedTitle(t.name), template: t.doc });
      else toast.error("No template named " + s.name);
      return;
    }
    if (!lib.data && !lib.error) return;
    pendingDiagramStart.current = null;
    const d = (lib.data?.items || []).find((x) => x.editor === "drawer" && diagramSlug(x.title) === want);
    if (d) setEditing({ name: d.name });
    else toast.error("No drawing named " + s.name);
  }, [startTick, tpls.data, tpls.error, lib.data, lib.error]);

  // the lightbox closes on Esc like every other overlay
  useEffect(() => {
    if (!zoom) return;
    const h = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.key !== "Escape") return;
      e.preventDefault(); setZoom(null);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [zoom]);

  const items = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const all = lib.data?.items || [];
    return needle ? all.filter((d) => d.title.toLowerCase().includes(needle)) : all;
  }, [lib.data, q]);
  // two rows of thumbnails in a tile (three when wide), every one in the focused view;
  // a focused view holding only a few draws them large enough to read
  const wdg = useWidget();
  const size = wdg?.size ?? "lg";
  const cols = { xs: 1, sm: 2, md: 3, lg: 4, xl: 5 }[size];
  const { shown, more, showAll } = useCapped(items, cols * 2, cols * 3);
  const big = !!wdg?.focused && shown.length > 0;
  const bigCols = Math.max(1, Math.min(cols, shown.length));
  const thumbH = big && wdg
    ? Math.round(Math.min(640, Math.max(144, (wdg.height - 190) / Math.ceil(shown.length / bigCols) - 110)))
    : 144;

  // Delete MOVES the diagram's files into Preparation/Diagrams/archive/ (never erased);
  // the toast's Undo moves them back
  const archive = async (d: DiagramItem) => {
    if (!window.confirm(`Delete "${d.title}"? It moves to Preparation/Diagrams/archive; notes embedding ${d.png} will show a missing image.`)) return;
    const r = await api.noteDiagramArchive(d.name).catch(() => null);
    if (!r?.ok || !r.moved) { toast.error(r?.error || "Couldn't delete the diagram"); return; }
    const moved = r.moved;
    lib.reload();
    toast.success("Deleted " + d.title, {
      description: "Moved to Preparation/Diagrams/archive",
      action: { label: "Undo", onClick: () => { void api.noteDiagramRestore(moved).then((u) => {
        if (!u.ok) toast.error(u.error || "Couldn't restore"); lib.reload();
      }); } },
    });
  };

  // a new diagram's embed goes straight to the clipboard, ready to paste into a note
  const copyNewEmbed = (png: string) =>
    void copyPlain("![[" + png + "]]").then((ok) => ok && toast.success("Embed copied", { description: "![[" + png + "]]" }));

  const copyEmbed = async (d: DiagramItem) => {
    const ok = await copyPlain(d.embed);
    if (ok) toast.success("Embed copied", { description: d.embed });
    else toast.error("Couldn't reach the clipboard");
  };

  return (
    <div>
      <SectionHead title="Diagrams"
        sub="Preparation/Diagrams — each one embeds into any note as ![[Name.png]]." />
      <div className="flex items-center gap-3 mb-3">
        <div className="relative flex-1 max-w-[280px]">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/60" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter diagrams…"
            className="w-full h-8 bg-secondary/40 border border-border rounded-full pl-8 pr-3 text-[12.5px] focus:outline-none focus:border-primary" />
        </div>
        <span className="text-[11.5px] text-muted-foreground nums">{items.length} diagram{items.length === 1 ? "" : "s"}</span>
        <span className="flex-1" />
        {naming === null ? (
          <button onClick={() => setNaming("")} title="Draw a new diagram" data-testid="diagram-new"
            className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 h-8 text-[12px] text-muted-foreground hover:text-foreground hover:border-primary/50 transition-colors">
            <Plus size={13} /> New diagram
          </button>
        ) : (
          <input autoFocus key={from?.name || ""} value={naming} onChange={(e) => setNaming(e.target.value)}
            placeholder="Diagram name…"
            title={(from ? `Enter to start drawing from ${from.name}` : "Enter to start drawing") + ", Esc to cancel"} data-testid="diagram-new-name"
            onKeyDown={(e) => {
              if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); stopNaming(); }
              else if (e.key === "Enter" && naming.trim()) { e.preventDefault(); setEditing({ name: null, title: naming.trim(), template: from?.doc }); stopNaming(); }
            }}
            onBlur={() => { if (!naming.trim()) stopNaming(); }}
            className="w-[220px] h-8 bg-secondary/40 border border-primary rounded-full px-3 text-[12.5px] focus:outline-none" />
        )}
      </div>

      {templates.length > 0 && (
        <div className="flex items-stretch gap-2 mb-3 overflow-x-auto pb-1" data-testid="diagram-templates">
          <span className="self-center shrink-0 text-[11px] uppercase tracking-[0.09em] font-semibold text-muted-foreground">Templates</span>
          {templates.map((t) => (
            <button key={t.name} type="button" onClick={() => { setFrom(t); setNaming(""); }} title={"New diagram from " + t.name} data-template={t.name}
              className={"shrink-0 w-[128px] overflow-hidden rounded-lg border text-left transition-colors hover:border-primary/50 " + (from?.name === t.name ? "border-primary" : "border-border/70")}>
              <TemplateThumb doc={t.doc} className="h-14 w-full border-b border-border/60 p-1" />
              <div className="px-2 py-1 text-[11.5px] text-muted-foreground truncate">{t.name}</div>
            </button>
          ))}
        </div>
      )}

      {!lib.data ? <div className="text-[12.5px] text-muted-foreground py-6">loading…</div> : (
        <>
          <div className="grid gap-3 group-data-[size=sm]/widget:grid-cols-2 group-data-[size=md]/widget:grid-cols-3 group-data-[size=lg]/widget:grid-cols-4 group-data-[size=xl]/widget:grid-cols-5" data-testid="diagram-grid"
            style={big ? { gridTemplateColumns: `repeat(${bigCols}, minmax(0, 1fr))` } : undefined}>
            {shown.map((d) => (
              <Card key={d.path} data-obsidian-file={d.path} className="group min-w-0 overflow-hidden border-border/70">
                <button onClick={() => setZoom(d)} title="View this diagram" style={big ? { height: thumbH } : undefined}
                  className="block w-full h-36 bg-secondary/30 border-b border-border/60">
                  <img src={d.url} alt={d.title} className="h-full w-full object-contain p-2" />
                </button>
                <div className="px-3 py-2.5">
                  <div className="text-[13px] font-medium leading-snug truncate" title={d.title}>{d.title}</div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground/80">
                    {d.editor === "drawer" ? `drawing · ${d.elements} element${d.elements === 1 ? "" : "s"}` : "model"}
                    {d.mtime ? ` · ${fmtDay(d.mtime)}` : ""}
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    {d.editor === "drawer" && (
                      <button onClick={() => setEditing({ name: d.name })} title="Edit"
                        className="inline-flex shrink-0 items-center whitespace-nowrap gap-1.5 rounded-full border border-border px-2.5 py-1 text-[11.5px] text-muted-foreground hover:text-foreground hover:border-primary/50 transition-colors">
                        <Pencil size={11} /> Edit
                      </button>
                    )}
                    <button onClick={() => copyEmbed(d)}
                      className="inline-flex shrink-0 items-center whitespace-nowrap gap-1.5 rounded-full border border-border px-2.5 py-1 text-[11.5px] text-muted-foreground hover:text-foreground hover:border-primary/50 transition-colors">
                      <Copy size={11} /> Copy embed
                    </button>
                    <button onClick={() => api.open(d.path)}
                      className="inline-flex shrink-0 items-center whitespace-nowrap gap-1.5 rounded-full border border-border px-2.5 py-1 text-[11.5px] text-muted-foreground hover:text-foreground hover:border-primary/50 transition-colors">
                      <ExternalLink size={11} /> Obsidian
                    </button>
                    <button onClick={() => void archive(d)} title="Delete (moves to Preparation/Diagrams/archive)" aria-label={"Delete " + d.title}
                      className="ml-auto inline-flex items-center rounded-full border border-border p-1.5 text-muted-foreground hover:text-destructive hover:border-destructive/50 transition-colors">
                      <Trash2 size={11} />
                    </button>
                  </div>
                </div>
              </Card>
            ))}
          </div>
          <MoreRows more={more} onClick={showAll} />
          {items.length === 0 && (
            <div className="text-[12.5px] text-muted-foreground py-6">
              {q.trim() ? "No diagram matches that." : "No diagrams yet."}
            </div>
          )}
        </>
      )}

      {zoom && createPortal(
        <div role="dialog" aria-modal="true" aria-label={zoom.title} data-knav-modal
          className="fixed inset-0 z-[120] flex items-center justify-center p-8 animate-in fade-in duration-150"
          onClick={() => setZoom(null)}>
          <div className="absolute inset-0 bg-black/60" aria-hidden="true" />
          <div className="relative max-h-full max-w-[92vw] rounded-lg bg-background border border-border shadow-xl p-3 flex flex-col"
            onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between gap-3 pb-2">
              <div className="text-[13.5px] font-medium truncate">{zoom.title}</div>
              <button onClick={() => setZoom(null)} data-knav-back aria-label="Close" title="Close"
                className="text-muted-foreground hover:text-foreground p-1"><X size={15} /></button>
            </div>
            <img src={zoom.url} alt={zoom.title} className="max-h-[76vh] max-w-full object-contain" />
          </div>
        </div>,
        document.body)}

      {editing && createPortal(
        <DiagramDrawer name={editing.name} title={editing.title} template={editing.template}
          onSaved={(_name, png, first) => { lib.reload(); if (first) copyNewEmbed(png); }}
          onClose={() => { setEditing(null); lib.reload(); tpls.reload(); }} />,
        document.body)}
    </div>
  );
}

// ============================================================================ meetings
function MeetingsView({ onOpen }: { onOpen: (n: GraphNode) => void }) {
  const [tick, setTick] = useState(0);
  const m = useApi(() => api.aioaMeetings(), [tick], 0);
  const items = m.data?.items || [];
  const today = new Date().toISOString().slice(0, 10);
  const upcoming = items.filter((x) => x.date >= today).reverse();
  const past = items.filter((x) => x.date < today);
  const up = useCapped(upcoming, 4, 8);
  const gone = useCapped(past, 8, 16);

  const archive = async (x: AioaMeeting) => {
    const r = await api.noteArchive(x.path);
    if (!r.ok) { toast.error(r.error || "Couldn't archive that meeting"); return; }
    setTick((t) => t + 1);
    toast.success("Archived", {
      description: x.title,
      action: {
        label: "Undo",
        onClick: async () => {
          const u = await api.noteUnarchive(r.archived || "");
          if (u.ok) { toast.success("Restored", { description: x.title }); setTick((t) => t + 1); }
          else toast.error(u.error || "Couldn't restore that meeting");
        },
      },
    });
  };

  // each row is a module-level component: defined in here it remounted on every render,
  // which threw away keyboard focus (and the arrow walk's place) mid-list
  const bump = () => setTick((t) => t + 1);
  return (
    <div>
      <SectionHead title="Meetings" sub="Prep and reflections, in one thread — calendar meetings plus filed meeting notes." />
      {!m.data ? <div className="text-[12.5px] text-muted-foreground py-6">loading…</div> : (
        <>
          {upcoming.length > 0 && (
            <div className="mb-6">
              <div className="text-[11px] uppercase tracking-[0.09em] font-semibold text-muted-foreground mb-1">Upcoming</div>
              {up.shown.map((x) => <MeetingRow key={x.path} x={x} onOpen={onOpen} onArchive={archive} onNoted={bump} />)}
              <MoreRows more={up.more} onClick={up.showAll} />
            </div>
          )}
          <div className="text-[11px] uppercase tracking-[0.09em] font-semibold text-muted-foreground mb-1">Past</div>
          {gone.shown.map((x) => <MeetingRow key={x.path} x={x} onOpen={onOpen} onArchive={archive} onNoted={bump} />)}
          <MoreRows more={gone.more} onClick={gone.showAll} />
          {items.length === 0 && <div className="text-[12.5px] text-muted-foreground py-6">No meeting notes yet — meeting prep writes prep into the calendar; filed notes land in Notes/Meetings.</div>}
        </>
      )}
    </div>
  );
}

function MeetingRow({ x, onOpen, onArchive, onNoted }: {
  x: AioaMeeting; onOpen: (n: GraphNode) => void; onArchive: (x: AioaMeeting) => Promise<void> | void; onNoted: () => void;
}) {
    // `with:` can arrive as a scalar from inline frontmatter — never assume a list
    const withList = Array.isArray(x.with) ? x.with : x.with ? [String(x.with)] : [];
    const [busy, setBusy] = useState(false);
    const [noting, setNoting] = useState(false);
    const archive = onArchive;
    // clicking the row reads whatever is richest: the filed note when one exists,
    // otherwise the calendar event itself
    const target = x.notePath || x.path;
    const open = () => onOpen(nodeFor(target, x.title, "meeting", target === x.path && x.readonly, x.tags));

    // the notes for THIS meeting — created on first click, reopened after that.
    // The write is idempotent server-side, so a double click can't fork a note.
    const openNotes = async () => {
      if (x.notePath) { open(); return; }
      setNoting(true);
      try {
        const r = await api.meetingNote(x.path);
        if (!r.ok || !r.path) { toast.error(r.error || "Couldn't start those notes"); return; }
        if (r.created) toast.success("Notes started", { description: x.title });
        onOpen(nodeFor(r.path, r.title || x.title, "meeting", false, x.tags));
        onNoted();
      } catch { toast.error("Couldn't start those notes"); }
      finally { setNoting(false); }
    };
    // a narrow tile folds the date and attendees under the title and the notes
    // button to its icon; wide ones keep the date column
    const t = useTier();
    const withText = withList.join(", ");
    return (
      <div data-obsidian-file={x.notePath || (x.readonly ? undefined : x.path)}
        className="group relative w-full min-w-0 flex items-start gap-3 py-2.5 border-b border-border/40">
        <div role="button" tabIndex={0} onClick={open}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } }}
          className="min-w-0 flex-1 flex items-start gap-3 cursor-pointer text-left outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded-md">
          {!t.compact && <div className="w-[86px] shrink-0 text-[11.5px] nums text-muted-foreground pt-0.5">{x.date || "undated"}</div>}
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium truncate group-hover:text-primary transition-colors">{x.title}</div>
            {t.compact && (
              <div className="text-[11px] nums text-muted-foreground truncate mt-0.5" title={withText || undefined}>
                {x.date || "undated"}{withText ? ` · ${withText}` : ""}
              </div>
            )}
            {x.preview && <div className="text-[11.5px] text-muted-foreground truncate mt-0.5">{x.preview}</div>}
          </div>
        </div>
        {!t.compact && withList.length > 0 && (
          <span title={withText} className="shrink min-w-0 max-w-[30%] truncate text-[10.5px] text-muted-foreground bg-secondary px-1.5 py-0.5 rounded mt-0.5">{withText}</span>
        )}
        {/* a scheduled meeting is one click from its own notes — no Obsidian trip */}
        <button
          onClick={(e) => { e.stopPropagation(); openNotes(); }}
          disabled={noting}
          title={x.notePath ? "Open the notes filed for this meeting" : "Start notes for this meeting"}
          aria-label={x.notePath ? "Open notes" : "Write notes"}
          className="shrink-0 inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-2.5 py-1 text-[11.5px] text-muted-foreground hover:text-foreground hover:border-primary/60 transition-colors disabled:opacity-50 mt-0.5">
          {noting ? <Loader2 size={11} className="animate-spin" /> : <NotebookPen size={11} />}
          {!t.xs && (x.notePath ? "Open notes" : "Write notes")}
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); if (busy) return; setBusy(true); Promise.resolve(archive(x)).finally(() => setBusy(false)); }}
          title="Archive this meeting"
          aria-label={`Archive ${x.title}`}
          className="shrink-0 inline-flex items-center justify-center w-6 h-6 rounded-md text-muted-foreground/35 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 group-data-[focused]/widget:opacity-100 hover:!text-foreground hover:bg-secondary/70 transition-all disabled:opacity-50"
          disabled={busy}>
          {busy ? <Loader2 size={13} className="animate-spin" /> : <Archive size={13} />}
        </button>
      </div>
    );
}

function ProjectNotes({ project, fallback, onOpen }: {
  project: string; fallback: { path: string; title: string; mtime: number }[]; onOpen: (n: GraphNode) => void;
}) {
  const targets = useApi(() => api.notesProjectTargets(), [], 0);
  const low = project.toLowerCase();
  const target = (targets.data?.projects || []).find((t) =>
    t.key.toLowerCase() === low || t.name.toLowerCase() === low || t.key.split("/").pop()?.toLowerCase() === low);
  const [tick, setTick] = useState(0);
  const notes = useApi(() => target ? api.notesProject(target.key) : Promise.resolve(null), [target?.key, tick], 0);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [saving, setSaving] = useState(false);
  const rows = target && !notes.error ? notes.data?.notes || [] : fallback;
  const { shown, more, showAll } = useCapped(rows, 8, 16);
  if ((!target || notes.error) && fallback.length === 0) return null;
  const create = async () => {
    const t = title.trim();
    if (!t || saving || !target) return;
    setSaving(true);
    try {
      const r = await api.noteCreate(`project:${target.key}`, t);
      if (!r.ok || !r.path) { toast.error(r.error || "Couldn't create that note"); return; }
      setTitle(""); setAdding(false); setTick((n) => n + 1);
      onOpen(nodeFor(r.path, r.title || t, "project", false));
    } catch { toast.error("Couldn't create that note"); }
    finally { setSaving(false); }
  };
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-2 mb-1">
        <div className="text-[11px] uppercase tracking-[0.09em] font-semibold text-muted-foreground" title={target ? `Projects/${target.key}/logs` : undefined}>Notes</div>
        {target && <button onClick={() => setAdding((v) => !v)} aria-expanded={adding} title="Write a new note in this project"
          className="ml-auto inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-0.5 text-[11.5px] text-muted-foreground hover:text-foreground hover:border-primary/50 transition-colors">
          <Plus size={11} /> New note
        </button>}
      </div>
      {adding && (
        <div className="flex items-center gap-1.5 py-1.5">
          {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
          <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title"
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); void create(); }
              else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setAdding(false); setTitle(""); }
            }}
            title="⏎ create and open · Esc cancel"
            className="flex-1 min-w-0 h-7 bg-secondary/40 border border-border rounded-md px-2 text-[12.5px] focus:outline-none focus:border-primary" />
          <button onClick={create} disabled={!title.trim() || saving}
            className="shrink-0 inline-flex items-center gap-1 rounded-full bg-primary text-primary-foreground px-3 py-1 text-[11.5px] font-medium hover:opacity-90 disabled:opacity-40">
            {saving ? <Loader2 size={11} className="animate-spin" /> : null} Create
          </button>
        </div>
      )}
      {target && !notes.data && !notes.error ? <div className="text-[12px] text-muted-foreground py-3">loading…</div>
        : shown.map((n) => (
          <button key={n.path} onClick={() => onOpen(nodeFor(n.path, n.title, "project", !isWritableNote(n.path)))}
            data-obsidian-file={n.path} title={n.path}
            className="w-full min-w-0 text-left flex items-center gap-2 py-1.5 border-b border-border/40 text-[12.5px] text-muted-foreground hover:text-primary transition-colors">
            <NotebookPen size={12} className="shrink-0 opacity-60" />
            <span className="truncate flex-1 text-foreground/90">{n.title}</span>
            <span className="text-[10.5px] nums text-muted-foreground/60 shrink-0">{fmtDay(n.mtime)}</span>
          </button>
        ))}
      {rows.length === 0 && (!target || notes.data) && !adding && <div className="text-[12px] text-muted-foreground py-3">No notes yet.</div>}
      <MoreRows more={more} onClick={showAll} />
    </div>
  );
}

function ProjectsView({ project, setProject, onOpen }:
  { project: string | null; setProject: (p: string | null) => void; onOpen: (n: GraphNode) => void }) {
  const p = useApi(() => api.aioaProjects(), [], 0);
  const detail = useApi(() => project ? api.aioaProjectNotes(project) : Promise.resolve(null), [project], 0);
  const rows = p.data?.projects || [];
  const { shown, more, showAll } = useCapped(rows, 10, 20);

  if (project) {
    const d = detail.data;
    return (
      <div>
        <button onClick={() => setProject(null)} data-knav-back
          className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-[12px] text-muted-foreground hover:text-foreground hover:border-primary/50 transition-colors mb-4">
          <ArrowLeft size={12} /> Projects
        </button>
        <SectionHead title={project} sub="The project's thinking trail (logs) and its curated corpus." />
        {!d ? <div className="text-[12.5px] text-muted-foreground py-6">loading…</div> : (
          <div className="grid gap-8 items-start group-data-[size=md]/widget:grid-cols-2 group-data-[size=lg]/widget:grid-cols-2 group-data-[size=xl]/widget:grid-cols-3">
            <ProjectNotes project={project} fallback={d.notes || []} onOpen={onOpen} />
            <div>
              <div className="text-[11px] uppercase tracking-[0.09em] font-semibold text-muted-foreground mb-1" title="The project's thinking trail">Logs</div>
              {d.logs.map((n) => (
                <button key={n.path} onClick={() => onOpen(nodeFor(n.path, n.title, "project", true, n.tags))}
                  data-obsidian-file={n.path} className="w-full min-w-0 text-left flex items-center gap-2 py-1.5 border-b border-border/40 text-[12.5px] text-muted-foreground hover:text-primary transition-colors">
                  <FileText size={12} className="shrink-0 opacity-60" />
                  <span className="truncate flex-1">{n.title}</span>
                  <span className="text-[10.5px] nums text-muted-foreground/60 shrink-0">{fmtDay(n.mtime)}</span>
                </button>
              ))}
              {d.logs.length === 0 && <div className="text-[12px] text-muted-foreground py-3">No logs.</div>}
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-[0.09em] font-semibold text-muted-foreground mb-1" title="Why each paper matters here">Corpus</div>
              {d.corpus.map((n) => (
                <button key={n.path} onClick={() => onOpen(nodeFor(n.path, n.title, "project", true, n.tags))}
                  data-obsidian-file={n.path} className="w-full min-w-0 text-left flex items-center gap-2 py-1.5 border-b border-border/40 text-[12.5px] text-muted-foreground hover:text-primary transition-colors">
                  <FileText size={12} className="shrink-0 opacity-60" />
                  <span className="truncate flex-1">{n.title}</span>
                </button>
              ))}
              {d.corpus.length === 0 && <div className="text-[12px] text-muted-foreground py-3">No corpus notes.</div>}
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      <SectionHead title="Projects" sub="Every paper's logs and curated corpus, newest activity first." />
      <div className="grid gap-x-6 group-data-[size=md]/widget:grid-cols-2 group-data-[size=lg]/widget:grid-cols-2 group-data-[size=xl]/widget:grid-cols-3">
        {shown.map((r) => (
          <button key={r.project} onClick={() => setProject(r.project)} data-knav-id={`project-${r.project}`}
            className="min-w-0 flex items-center gap-3 py-2.5 text-left border-b border-border/40 group">
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium truncate group-hover:text-primary transition-colors">{r.project}</div>
              <div className="mt-0.5 text-[11px] text-muted-foreground nums">
                {r.notes ? `${r.notes} ${r.notes === 1 ? "note" : "notes"} · ` : ""}{r.logs} {r.logs === 1 ? "log" : "logs"} · {r.corpus} corpus · {fmtDay(r.mtime)}
              </div>
            </div>
            <ChevronRight size={14} className="shrink-0 text-muted-foreground/40 group-hover:text-primary transition-colors" />
          </button>
        ))}
        {!p.data && <div className="text-[12.5px] text-muted-foreground py-6">loading…</div>}
      </div>
      <MoreRows more={more} onClick={showAll} />
    </div>
  );
}
