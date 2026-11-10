
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Card } from "@/components/ui/card";
import { WidgetFrame, useWidget, rowCap } from "@/components/ui/widget";
import { openWidgetFocus } from "@/lib/arrownav";
import { Progress } from "@/components/ui/progress";
import { Input } from "@/components/ui/input";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { BookOpen, FileText, Rss, History, ChevronRight, ChevronDown, BookMarked, Plus, Check, ListChecks, Inbox, GripVertical, Download, Pencil, Trash2, FolderPlus, MoreVertical, Copy, Archive, RotateCcw, Search, X, ListPlus, Sparkles, Loader2, FilePlus2, Library, CalendarDays, ListX } from "lucide-react";
import {
  DndContext, MouseSensor, TouchSensor, KeyboardSensor, useSensor, useSensors, pointerWithin,
} from "@dnd-kit/core";
import type { DragEndEvent } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy, arrayMove, sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { toast } from "sonner";
import { copyPlain } from "@/lib/clipboard";
import { useApi, usePersistent } from "@/lib/hooks";
import { api } from "@/lib/api";
import type { Item, ReadState, ReadingList, ReadingGroup, ReadingItem, ReadingToday, ArchivedList, DownloadItem, ReadingType, OAImport, OAItem, CorpusHit, QueueAddResult } from "@/lib/api";
import { relativeAgo, relDue, toneColor } from "@/lib/format";
import { CopyNoteLink } from "@/components/CopyNoteLink";
import { InboxTriage } from "@/components/InboxTriage";
import { PrintBookHost, openPrintBook } from "@/components/PrintBook";
import { NotePreview } from "@/components/NotePreview";
import { useRestIntent } from "@/lib/restIntent";
import { ReadingNext, DueChip, QueueChip, DueField } from "@/components/ReadingNext";

// one click waits out the double-click window so a double click never also fires it;
// a keyboard press (detail 0) acts at once
function useDotClick(onCycle: (double?: boolean) => void) {
  const t = useRef<number | null>(null);
  useEffect(() => () => { if (t.current) window.clearTimeout(t.current); }, []);
  return {
    onClick: (e: React.MouseEvent) => {
      if (e.detail === 0) { onCycle(false); return; }
      if (e.detail > 1) return;
      t.current = window.setTimeout(() => { t.current = null; onCycle(false); }, 250);
    },
    onDoubleClick: () => { if (t.current) { window.clearTimeout(t.current); t.current = null; } onCycle(true); },
  };
}
const DOT_TIP: Record<ReadState, string> = {
  unread: "Unread — click to add to Now reading, double-click to mark read",
  reading: "Now reading — click to take off, double-click to mark read",
  read: "Read — click to read again, double-click to mark unread",
};
const STATE_COLOR: Record<ReadState, string> = {
  read: "hsl(var(--primary))", reading: "hsl(var(--due-soon))", unread: "transparent",
};
const CITE = (name: string) => `Preparation/Reading/Citations/${name}.md`;

type PromptOpts = { title: string; description?: string; defaultValue?: string; placeholder?: string; confirmLabel?: string };
type ConfirmOpts = { title: string; description?: string; confirmLabel?: string; danger?: boolean };
type DialogRequest =
  | ({ kind: "prompt" } & PromptOpts & { resolve: (v: string | null) => void })
  | ({ kind: "confirm" } & ConfirmOpts & { resolve: (v: boolean) => void });

const DialogsContext = createContext<{ prompt: (o: PromptOpts) => Promise<string | null>; confirm: (o: ConfirmOpts) => Promise<boolean> } | null>(null);
function useDialogs() {
  const ctx = useContext(DialogsContext);
  if (!ctx) throw new Error("useDialogs must be used inside <DialogsProvider>");
  return ctx;
}

function DialogsProvider({ children }: { children: React.ReactNode }) {
  const [req, setReq] = useState<DialogRequest | null>(null);
  const [value, setValue] = useState("");

  const prompt = useCallback((o: PromptOpts) => new Promise<string | null>((resolve) => {
    setValue(o.defaultValue || "");
    setReq({ kind: "prompt", resolve, ...o });
  }), []);
  const confirm = useCallback((o: ConfirmOpts) => new Promise<boolean>((resolve) => {
    setReq({ kind: "confirm", resolve, ...o });
  }), []);

  const finish = (result: string | null | boolean) => {
    if (!req) return;
    if (req.kind === "prompt") req.resolve(result as string | null); else req.resolve(result as boolean);
    setReq(null);
  };
  const submitPrompt = () => finish(value.trim() || null);

  return (
    <DialogsContext.Provider value={{ prompt, confirm }}>
      {children}
      <Dialog open={!!req} onOpenChange={(o) => { if (!o) finish(req?.kind === "confirm" ? false : null); }}>
        <DialogContent className="sm:max-w-md">
          {req && (
            <>
              <DialogHeader>
                <DialogTitle>{req.title}</DialogTitle>
                {req.description && <DialogDescription>{req.description}</DialogDescription>}
              </DialogHeader>
              {req.kind === "prompt" && (
                <Input autoFocus value={value} onChange={(e) => setValue(e.target.value)}
                  placeholder={req.placeholder} className="h-9 text-[13.5px]"
                  onKeyDown={(e) => { if (e.key === "Enter") submitPrompt(); }} />
              )}
              <DialogFooter>
                <button onClick={() => finish(req.kind === "confirm" ? false : null)}
                  className="text-[13px] text-muted-foreground hover:text-foreground px-3 py-1.5 transition-colors">Cancel</button>
                <button onClick={() => (req.kind === "prompt" ? submitPrompt() : finish(true))}
                  className={`text-[13px] rounded-md px-3.5 py-1.5 hover:opacity-90 transition-opacity ${
                    req.kind === "confirm" && req.danger ? "bg-destructive text-destructive-foreground" : "bg-primary text-primary-foreground"}`}>
                  {req.confirmLabel || (req.kind === "confirm" ? "Confirm" : "Save")}
                </button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </DialogsContext.Provider>
  );
}

export function Reading({ items, expand }: { items: Item[]; expand?: string }) {
  return (
    <DialogsProvider>
      <ReadingInner items={items} expand={expand} />
    </DialogsProvider>
  );
}

function ReadingInner({ items, expand }: { items: Item[]; expand?: string }) {
  const dialogs = useDialogs();
  const data = useApi(() => api.reading());
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [overrides, setOverrides] = useState<Record<string, ReadState>>({});

  const [tab, setTab] = usePersistent<string>("reading-tab", "next");
  // a stored tab that no longer exists falls back to Next, never a blank page
  const active = TABS.includes(tab) ? tab : "next";
  // a tab mounts on its first visit and then stays
  const [seen, setSeen] = useState<Record<string, boolean>>({});
  useEffect(() => { setSeen((s) => (s[active] ? s : { ...s, [active]: true })); }, [active]);

  // a deep link to one list opens it on the Lists tab
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (expand) { setOpen((o) => ({ ...o, [expand]: true })); setTab("lists"); } }, [expand]);

  const [marks, setMarks] = useState<Record<string, ReadState>>({});
  const mark = useCallback((name: string, state: ReadState) => setMarks((m) => ({ ...m, [name]: state })), []);
  const statusByName = useMemo(() => {
    const m = new Map(items.map((i) => [i.name, i.status as string]));
    for (const [name, s] of Object.entries(marks)) m.set(name, s);
    return m;
  }, [items, marks]);
  const nowReading = useMemo(() => {
    const out = items.filter((i) => (marks[i.name] ?? i.status) === "reading");
    for (const [name, s] of Object.entries(marks))
      if (s === "reading" && !items.some((i) => i.name === name)) out.push({ name, status: "reading" } as Item);
    return out;
  }, [items, marks]);

  if (!data.data) return <ReadingSkeleton />;
  const { lists = [], archived = [], downloads = [], recent = [], inbox = [], vaultPath } = data.data;
  const reload = data.reload;
  const inboxItems = inbox.filter((x) => x.kind === "rss");
  const todayReadings: ReadingToday[] = data.data.today || [];

  // list checkbox is authoritative for progress (so a restarted syllabus reads fresh);
  // the citation note's status only lights a faint "read before" hint
  const everRead = (it: ReadingItem) =>
    !!(it.citationName && statusByName.get(it.citationName) === "read");

  const pane = (id: string, body: () => React.ReactNode) => (active === id || seen[id]) && (
    <div key={id} role="tabpanel" data-reading-pane={id} hidden={active !== id} inert={active !== id}>
      <div className="grid gap-5">{body()}</div>
    </div>
  );

  const addToList = async (listName: string, x: { path: string; name: string }) => {
    try { await api.readingAdd(listName, x.path, x.name); toast("Added to list", { description: x.name.slice(0, 50) }); reload(); }
    catch { toast.error("Couldn't add to list"); }
  };
  const newList = async () => {
    const name = await dialogs.prompt({
      title: "New reading list",
      description: "Name the syllabus — an ordered set of grouped readings you'll work through.",
      placeholder: "e.g. Reading group",
    });
    if (!name?.trim()) return;
    try { const r = await api.readingOp("list/create", { name: name.trim() }); if (r.name) setOpen((o) => ({ ...o, [r.name!]: true })); reload(); }
    catch { toast.error("Couldn't create the list"); }
  };

  return (
    <div>
      <header className="mb-6">
        <div className="flex items-center gap-2 text-[12px] text-muted-foreground uppercase tracking-[0.1em] font-semibold mb-1">
          <BookOpen size={14} className="opacity-60" /> Reading
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <h1 className="text-[28px] font-semibold tracking-tight">Reading pipeline</h1>
          <button type="button" onClick={() => openPrintBook()} title="Take notes from a book you own in print"
            className="inline-flex items-center gap-1.5 text-[12px] px-3 py-1 rounded-md border border-border text-muted-foreground hover:text-foreground hover:border-primary/60 transition-colors">
            <BookMarked size={13} /> Print book
          </button>
        </div>
        <PrintBookHost onClosed={reload} />
      </header>

      {/* plain tab buttons, not Radix's roving list (that list claims left/right and traps
          the arrow engine); arrowing onto a tab focuses it, Enter opens it; it wraps */}
      <div role="tablist" aria-label="Reading sections"
        className="mb-5 inline-flex h-auto flex-wrap items-center justify-start rounded-lg bg-muted p-1 text-muted-foreground">
        {TAB_LABELS.map(([value, label]) => (
          <button key={value} type="button" role="tab" aria-selected={active === value}
            data-state={active === value ? "active" : "inactive"} onClick={() => setTab(value)}
            className="inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow">
            {label}
          </button>
        ))}
      </div>

      {pane("next", () => (
        <ReadingNext next={data.data?.next} lists={lists} reload={reload} mark={mark} />
      ))}

      {pane("lists", () => (<>
        <TodayNow todayReadings={todayReadings} nowReading={nowReading} vaultPath={vaultPath} />

        <div className="grid grid-cols-1 min-[1600px]:grid-cols-3 gap-5">
          <div className="relative min-[1600px]:col-start-3 min-[1600px]:row-start-1 min-[1600px]:min-h-[320px]">
            <WidgetFrame id="reading.recent" title="Recently opened" className="min-[1600px]:absolute min-[1600px]:inset-0">
              <RecentlyOpened recent={recent} lists={lists} vaultPath={vaultPath} onAdd={addToList} />
            </WidgetFrame>
          </div>
          <div className="min-[1600px]:col-span-2 min-[1600px]:col-start-1 min-[1600px]:row-start-1 space-y-5">
            <div className="flex items-center justify-between">
              <SectionLabel icon={<ListChecks size={13} />}>Reading lists</SectionLabel>
              <button onClick={newList}
                className="flex items-center gap-1.5 text-[12px] text-muted-foreground hover:text-primary transition-colors -mt-2">
                <ListPlus size={14} /> New list
              </button>
            </div>
            {lists.length === 0 && (
              <Card className="p-6"><Empty>No reading lists yet. Make one with “New list”, then group readings into an ordered syllabus.</Empty></Card>
            )}
            {lists.map((l) => (
              <WidgetFrame key={l.name} id={`reading.list.${slugOf(l.name)}`} title={cleanName(l.name)}>
                <ListCard list={l} isOpen={open[l.name] ?? false}
                  onToggleOpen={() => setOpen((o) => ({ ...o, [l.name]: !(o[l.name] ?? false) }))}
                  everRead={everRead} overrides={overrides} setOverrides={setOverrides} mark={mark} reload={reload} vaultPath={vaultPath} />
              </WidgetFrame>
            ))}
          </div>
        </div>

        <WidgetFrame id="reading.archive" title="Archive">
          <ArchivePanel initial={archived} reload={reload} />
        </WidgetFrame>
      </>))}

      {pane("downloads", () => (
        <WidgetFrame id="reading.downloads" title="To download">
          <DownloadQueue downloads={downloads} lists={lists} reload={reload} />
        </WidgetFrame>
      ))}

      {pane("inbox", () => (
        <WidgetFrame id="reading.inbox" title="Inbox">
          <InboxPanel items={inboxItems} lists={lists} onAdd={addToList} />
        </WidgetFrame>
      ))}
    </div>
  );
}

const TAB_LABELS: [string, string][] = [
  ["next", "Next"], ["lists", "Lists"], ["downloads", "Downloads"], ["inbox", "Inbox"],
];
const TABS = TAB_LABELS.map(([v]) => v);

// ------------------------------------------------------------- widget helpers
const slugOf = (name: string) => cleanName(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "list";
// lays out by the widget's own width, never the window's
const COLS_2 = "grid-cols-1 group-data-[size=md]/widget:grid-cols-2 group-data-[size=lg]/widget:grid-cols-2 group-data-[size=xl]/widget:grid-cols-3";
const isCompact = (w: ReturnType<typeof useWidget>) => !!w && (w.size === "xs" || w.size === "sm");

// a tile shows its first rows; the focused view (or "+N more") shows them all
function useCapped<T>(rows: T[], tile: number, roomy?: number) {
  const w = useWidget();
  const [all, setAll] = useState(false);
  // a caller holding state from a partial payload can arrive with nothing at all;
  // one missing list must not take the whole Reading view into the ErrorBoundary
  const list = rows ?? [];
  const shown = all ? list : list.slice(0, rowCap(w, tile, roomy));
  return { shown, more: list.length - shown.length, showAll: () => setAll(true) };
}
// in a widget "+N more" opens its focused view on the first hidden row; elsewhere the rows show here
function MoreRows({ more, onClick, noun = "more" }: { more: number; onClick: () => void; noun?: string }) {
  if (more <= 0) return null;
  return (
    <button onClick={(e) => { if (!openWidgetFocus(e.currentTarget)) onClick(); }} title="Open the full view"
      className="mt-2 text-[11.5px] text-muted-foreground hover:text-primary transition-colors nums">+{more} {noun}</button>
  );
}

// ------------------------------------------------------------- Inbox (saved clippings)
function InboxPanel({ items, lists, onAdd }: {
  items: { path: string; name: string; mtime: number }[]; lists: ReadingList[];
  onAdd: (listName: string, x: { path: string; name: string }) => void;
}) {
  const { shown, more, showAll } = useCapped(items, 6, 10);
  const w = useWidget();
  // focused with room: the saved links beside a preview of the one picked
  const split = !!w && w.focused && !isCompact(w) && items.length > 0;
  const [sel, setSel] = useState<string | null>(null);
  const cur = items.find((x) => x.path === sel) || items[0];
  const rest = useRestIntent();
  const label = (
    <SectionLabel icon={<Inbox size={13} />}
      title="Saved articles and links to follow up on — click one to open it, the + to file it into a reading list">Inbox</SectionLabel>
  );
  const rows = shown.map((x) => (
    <div key={x.path} data-obsidian-file={x.path}
      {...(split ? { onFocusCapture: () => setSel(x.path), onClick: () => setSel(x.path), ...rest(x.path, () => setSel(x.path)) } : {})}
      className={`min-w-0 flex items-start gap-2.5 py-2 group ${split ? `px-2 rounded-lg ${cur?.path === x.path ? "bg-secondary/50" : ""}` : ""}`}>
      <Rss size={13} className="mt-0.5 shrink-0 text-muted-foreground" />
      <button onClick={() => api.open(x.path)} title={x.name} className="min-w-0 flex-1 text-left">
        <span className="block text-[13px] leading-snug truncate group-hover:text-primary transition-colors">{x.name}</span>
        <span className="text-[10.5px] text-muted-foreground nums">{relativeAgo(Math.round(Date.now() / 1000 - x.mtime))}</span>
      </button>
      <AddToListMenu lists={lists} onPick={(ln) => onAdd(ln, x)} />
    </div>
  ));
  if (split) return (
    <Card className="h-full min-h-0 flex flex-col p-6">
      {label}
      <div className={`flex-1 min-h-0 grid gap-5 ${w.size === "md" ? "grid-cols-2" : "grid-cols-[minmax(0,2fr)_minmax(0,3fr)]"}`}>
        <div className="min-h-0 overflow-y-auto tinybar p-1 grid content-start gap-y-0.5">
          {rows}
          <MoreRows more={more} onClick={showAll} />
        </div>
        <NotePreview path={cur.path} title={cur.name} meta={`saved ${relativeAgo(Math.round(Date.now() / 1000 - cur.mtime))}`} />
      </div>
    </Card>
  );
  return (
    <Card className="h-full group-data-[focused]/widget:h-auto group-data-[focused]/widget:min-h-full p-6 group-data-[size=xs]/widget:p-4">
      {label}
      {items.length === 0 ? (
        <Empty>Nothing saved yet. Use the + on a journal article below to save it here to follow up on.</Empty>
      ) : (
        <div className={`grid gap-x-10 gap-y-0.5 ${COLS_2}`}>
          {rows}
        </div>
      )}
      <MoreRows more={more} onClick={showAll} />
    </Card>
  );
}

function RecentlyOpened({ recent, lists, vaultPath, onAdd }: {
  recent: { path: string; name: string; mtime: number }[]; lists: ReadingList[]; vaultPath?: string;
  onAdd: (listName: string, x: { path: string; name: string }) => void;
}) {
  const w = useWidget();
  // focused on a wide page: one column of rows beside a preview of the one picked
  const split = !!w && w.focused && (w.size === "lg" || w.size === "xl") && recent.length > 0;
  const cols = split ? 1 : ({ xs: 1, sm: 1, md: 2, lg: 3, xl: 4 } as const)[w?.size ?? "md"];
  const fill = !!w && (w.focused || w.tall);
  const [all, setAll] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  const cur = recent.find((x) => x.path === sel) || recent[0];
  const rest = useRestIntent();   // a resting pointer previews, a passing one does not
  const shown = fill || all ? recent : recent.slice(0, cols * (cols === 1 ? 5 : 3));
  const rows = shown.map((x) => (
    <div key={x.path} data-obsidian-file={x.path}
      {...(split ? { onFocusCapture: () => setSel(x.path), onClick: () => setSel(x.path), ...rest(x.path, () => setSel(x.path)) } : {})}
      className={`flex items-start gap-2.5 group min-w-0 py-2 ${split ? `px-2 rounded-lg ${cur?.path === x.path ? "bg-secondary/50" : ""}` : ""}`}>
      <FileText size={13} className="mt-0.5 shrink-0 text-muted-foreground" />
      <button onClick={() => api.open(x.path)} title={x.name} className="min-w-0 flex-1 text-left">
        <span className="block text-[13px] leading-snug truncate group-hover:text-primary transition-colors">{x.name}</span>
        <span className="text-[10.5px] text-muted-foreground nums">{relativeAgo(Math.round(Date.now() / 1000 - x.mtime))}</span>
      </button>
      <CopyNoteLink citationName={x.name} vaultPath={vaultPath} className="mt-0.5 opacity-0 group-hover:opacity-100 group-data-[focused]/widget:opacity-100 transition-opacity" />
      <AddToListMenu lists={lists} onPick={(ln) => onAdd(ln, x)} />
    </div>
  ));
  return (
    <Card className="h-full px-6 pt-5 pb-3 group-data-[size=xs]/widget:px-4 flex flex-col overflow-hidden">
      <SectionLabel icon={<History size={13} />}>Recently opened</SectionLabel>
      {recent.length === 0 ? <Empty>No citations opened yet. Notes you open from your reading lists show up here.</Empty> : split ? (
        <div className="flex-1 min-h-0 grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-5 pb-2">
          <div className="grid content-start min-h-0 overflow-y-auto tinybar p-1">{rows}</div>
          <NotePreview path={cur.path} title={cur.name} meta={`opened ${relativeAgo(Math.round(Date.now() / 1000 - cur.mtime))}`} />
        </div>
      ) : (
        <>
          <div className="grid content-start gap-x-6 flex-1 min-h-0 overflow-y-auto tinybar -mr-3 pr-3 -mt-1"
            style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
            {rows}
          </div>
          {!fill && <MoreRows more={recent.length - shown.length} onClick={() => setAll(true)} />}
        </>
      )}
    </Card>
  );
}

// ------------------------------------------------------------- Today / Now reading
function TodayNow({ todayReadings, nowReading, vaultPath }: { todayReadings: ReadingToday[]; nowReading: Item[]; vaultPath?: string }) {
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [added, setAdded] = useState<Item[]>([]);
  // sets the citation note's status directly, on a list or not
  const setStatus = (name: string, state: ReadState) =>
    api.readingOp("status", { citationPath: CITE(name), state });
  const dismiss = (name: string) => {
    setDismissed((s) => new Set(s).add(name));   // hide immediately
    setStatus(name, "unread")
      .catch(() => { setDismissed((s) => { const n = new Set(s); n.delete(name); return n; }); toast.error("Couldn't update"); });
  };
  const add = (h: CorpusHit) => {
    setDismissed((s) => { const n = new Set(s); n.delete(h.stem); return n; });
    setAdded((a) => a.some((x) => x.name === h.stem) ? a : [...a, { name: h.stem, year: h.year ?? undefined, status: "reading" } as Item]);
    setStatus(h.stem, "reading").then(() => toast("Now reading", { description: h.stem.slice(0, 60) }))
      .catch(() => { setAdded((a) => a.filter((x) => x.name !== h.stem)); toast.error("Couldn't update"); });
  };
  const showNow = [...nowReading, ...added.filter((a) => !nowReading.some((i) => i.name === a.name))]
    .filter((it) => !dismissed.has(it.name));
  return (
    <WidgetFrame id="reading.today" title={todayReadings.length > 0 ? "Reading today" : "Now reading"}>
      <TodayCard todayReadings={todayReadings} showNow={showNow} vaultPath={vaultPath} dismiss={dismiss} add={add} />
    </WidgetFrame>
  );
}

// corpus-only picker for Now reading: arrows move, Enter picks, Esc closes
function NowReadingAdd({ onPick, onDone }: { onPick: (h: CorpusHit) => void; onDone: () => void }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<CorpusHit[]>([]);
  const [hi, setHi] = useState(0);
  const reqId = useRef(0);
  useEffect(() => {
    const s = q.trim();
    if (s.length < 2) { setHits([]); return; }
    const id = ++reqId.current;
    const t = setTimeout(() => {
      api.readingCorpusSearch(s).catch(() => [] as CorpusHit[]).then((r) => {
        if (reqId.current === id) { setHits(r.filter((h) => h.kind === "citation")); setHi(0); }
      });
    }, 250);
    return () => clearTimeout(t);
  }, [q]);
  const pick = (h: CorpusHit) => { onPick(h); setQ(""); setHits([]); };
  return (
    <div className="relative mb-3 max-w-xl">
      <Search size={11} className="absolute left-2 top-[9px] text-muted-foreground/50 pointer-events-none" />
      <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the corpus"
        className="h-8 text-[13px] pl-6"
        onBlur={() => setTimeout(() => { if (!q.trim()) onDone(); }, 150)}
        onKeyDown={(e) => {
          if (e.key === "Escape") { e.stopPropagation(); onDone(); return; }
          if (hits.length === 0) return;
          if (e.key === "ArrowDown") { e.preventDefault(); setHi((h) => Math.min(h + 1, hits.length - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
          else if (e.key === "Enter") { e.preventDefault(); pick(hits[hi]); }
        }} />
      {hits.length > 0 && (
        <div className="absolute z-20 left-0 right-0 rounded-md border border-border bg-popover shadow-lg mt-0.5 max-h-64 overflow-y-auto tinybar">
          {hits.map((h, i) => (
            <ResultRow key={h.rel} active={hi === i} onPick={() => pick(h)} title={h.title || h.stem}
              sub={[h.author, h.year].filter(Boolean).join(" · ")}
              badge={h.status === "read" ? "read" : h.status === "reading" ? "reading" : undefined} />
          ))}
        </div>
      )}
    </div>
  );
}

function TodayCard({ todayReadings, showNow, vaultPath, dismiss, add }: {
  todayReadings: ReadingToday[]; showNow: Item[]; vaultPath?: string; dismiss: (name: string) => void;
  add: (h: CorpusHit) => void;
}) {
  const [adding, setAdding] = useState(false);
  const today = useCapped(todayReadings, 6, 10);
  const now = useCapped(showNow, 8);
  return (
    <Card className="h-full group-data-[focused]/widget:h-auto group-data-[focused]/widget:min-h-full p-6 group-data-[size=xs]/widget:p-4">
      {todayReadings.length > 0 && (
        <div className="mb-5">
          <SectionLabel icon={<ListChecks size={13} />}>Reading today</SectionLabel>
          <div className={`grid gap-x-6 gap-y-1 ${COLS_2}`}>
            {today.shown.map((r) => {
              const rel = relDue(r.due);
              const dot = toneColor(r.overdue ? "over" : "soon");
              return r.path ? (
                <button key={r.path} onClick={() => api.open(r.path!)} title={r.taskText} data-obsidian-file={r.path}
                  className="min-w-0 text-left flex items-center gap-2.5 py-2 group hover:bg-accent/40 -mx-2 px-2 rounded transition-colors">
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ background: dot }} />
                  <span className="text-[13.5px] truncate group-hover:text-primary transition-colors">{r.label}</span>
                  {r.overdue && rel && <span className="ml-auto text-[11px] nums shrink-0" style={{ color: dot }}>{rel.label}</span>}
                </button>
              ) : (
                <div key={r.label} title={r.taskText} className="flex items-center gap-2.5 py-2 -mx-2 px-2 text-muted-foreground">
                  <span className="w-2 h-2 rounded-full shrink-0 border-[1.5px]" style={{ borderColor: dot }} />
                  <span className="text-[13.5px] truncate">{r.label}</span>
                  {r.overdue && rel && <span className="ml-auto text-[11px] nums shrink-0" style={{ color: dot }}>{rel.label}</span>}
                </div>
              );
            })}
          </div>
          <MoreRows more={today.more} onClick={today.showAll} />
        </div>
      )}
      <div>
          <div className="flex items-center justify-between">
            <SectionLabel icon={<BookMarked size={13} />}>Now reading</SectionLabel>
            <button onClick={() => setAdding((a) => !a)} title="Add a reading from the corpus"
              className="flex items-center gap-1.5 text-[12px] text-muted-foreground hover:text-primary transition-colors -mt-2">
              <Plus size={14} /> Add
            </button>
          </div>
          {adding && <NowReadingAdd onPick={add} onDone={() => setAdding(false)} />}
          {showNow.length === 0 && !adding && <Empty>Nothing in progress.</Empty>}
          <div className={`grid gap-x-6 gap-y-1 ${COLS_2}`}>
            {now.shown.map((it) => (
              <div key={it.name} data-obsidian-file={CITE(it.name)}
                className="min-w-0 flex items-center gap-2.5 py-2 group hover:bg-accent/40 -mx-2 px-2 rounded transition-colors">
                <span className="w-2 h-2 rounded-full shrink-0" style={{ background: "hsl(var(--due-soon))" }} />
                <button onClick={() => api.open(CITE(it.name))}
                  className="text-left text-[13.5px] truncate flex-1 hover:text-primary transition-colors">{it.name}</button>
                <span className="text-[11px] text-muted-foreground nums shrink-0">{it.year || ""}</span>
                <CopyNoteLink citationName={it.name} vaultPath={vaultPath} className="opacity-0 group-hover:opacity-100 group-data-[focused]/widget:opacity-100 transition-opacity" />
                <button onClick={() => dismiss(it.name)} title="Not reading this now — remove from Now reading"
                  className="opacity-0 group-hover:opacity-100 group-data-[focused]/widget:opacity-100 transition-opacity text-muted-foreground hover:text-destructive shrink-0">
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
          <MoreRows more={now.more} onClick={now.showAll} />
      </div>
    </Card>
  );
}

// ------------------------------------------------------------- To download
const TYPE_LABEL: Record<ReadingType, string> = { article: "Article", book: "Book", other: "Other" };
type DownloadFilter = "all" | ReadingType;
const FILTER_TABS: { key: DownloadFilter; label: string }[] = [
  { key: "all", label: "All" }, { key: "article", label: "Articles" },
  { key: "book", label: "Books" }, { key: "other", label: "Other" },
];

const whereOf = (d: DownloadItem) => d.where || "active";
const sourceKey = (d: DownloadItem) => `${whereOf(d)}|${d.file || ""}|${d.list}`;
type SourceRun = { key: string; d: DownloadItem; rows: DownloadItem[] };
function sourceRuns(rows: DownloadItem[]): SourceRun[] {
  const out: SourceRun[] = [];
  for (const d of rows) {
    const k = sourceKey(d);
    const last = out[out.length - 1];
    if (last && last.key === k) last.rows.push(d); else out.push({ key: k, d, rows: [d] });
  }
  return out;
}
const WHERE_TIP: Record<string, string> = {
  active: "Reading list", queue: "Download queue (To Download.md) — not a reading list",
  archived: "Archived reading list — its downloads stay queued",
};

function DownloadQueue({ downloads, lists, reload }:
{ downloads: DownloadItem[]; lists: ReadingList[]; reload: () => void }) {
  const [adding, setAdding] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [expanded, setExpanded] = usePersistent<boolean>("reading-download-open", false);
  const [filter, setFilter] = usePersistent<DownloadFilter>("reading-download-type", "all");
  const [inboxPdfs, setInboxPdfs] = useState<{ count: number; names: string[] }>({ count: 0, names: [] });
  const refreshInbox = useCallback(() => { api.readingInboxPdfs().then(setInboxPdfs).catch(() => {}); }, []);
  useEffect(() => { refreshInbox(); }, [refreshInbox]);
  const [triage, setTriage] = useState(false);
  // rows marked "have" hide at once (as Now reading's dismiss does), so the row
  // under focus is gone before the key comes up and focus steps onto the next one
  const [had, setHad] = useState<Set<string>>(new Set());
  useEffect(() => { setHad(new Set()); }, [downloads]);
  const rowKey = (d: DownloadItem) => `${sourceKey(d)}|${d.group}|${d.item}|${d.title}`;
  // where + file address the item in whichever file holds it (list, queue or archive)
  const at = (d: DownloadItem) => ({ list: d.list, group: d.group, item: d.item, where: whereOf(d), file: d.file ?? null });
  const markHave = async (d: DownloadItem) => {
    const k = rowKey(d);
    setHad((s) => new Set(s).add(k));
    try { await api.readingOp("item/download", { ...at(d), needsDownload: false }); reload(); }
    catch {
      setHad((s) => { const n = new Set(s); n.delete(k); return n; });
      toast.error("Couldn't update");
    }
  };
  const setType = async (d: DownloadItem, t: ReadingType) => {
    try { await api.readingOp("item/edit", { ...at(d), fields: { type: t } }); reload(); }
    catch { toast.error("Couldn't reclassify"); }
  };
  const restoreList = async (name: string) => {
    try { await api.readingOp("queue/to-list", { list: name }); toast("Restored as a reading list", { description: cleanName(name) }); reload(); }
    catch { toast.error("Couldn't restore the list"); }
  };

  const live = had.size ? downloads.filter((d) => !had.has(rowKey(d))) : downloads;
  const counts: Record<DownloadFilter, number> = {
    all: live.length,
    article: live.filter((d) => d.type === "article").length,
    book: live.filter((d) => d.type === "book").length,
    other: live.filter((d) => d.type === "other").length,
  };
  const shown = filter === "all" ? live : live.filter((d) => d.type === filter);
  // a narrow tile folds its header actions to icons; the focused view is always open
  const w = useWidget();
  const compact = isCompact(w);
  const open = expanded || !!w?.focused;
  const rowsC = useCapped(shown, 6, 12);
  // per-source totals for the group headers (the tile shows a capped slice of each)
  const perSource = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of shown) m.set(sourceKey(d), (m.get(sourceKey(d)) || 0) + 1);
    return m;
  }, [shown]);

  return (
    <Card className="h-full group-data-[focused]/widget:h-auto group-data-[focused]/widget:min-h-full p-6 group-data-[size=xs]/widget:p-4">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex items-center gap-2 min-w-0">
          <button onClick={() => setExpanded((v) => !v)}
            className="flex items-center gap-1.5 text-[11px] uppercase tracking-[0.09em] font-semibold text-muted-foreground hover:text-foreground transition-colors">
            {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            <Download size={13} /> To download
            {downloads.length > 0 && <span className="nums text-foreground normal-case tracking-normal">· {downloads.length}</span>}
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button onClick={() => setShowImport((v) => !v)} title="Import from OpenAlex" aria-label="Import from OpenAlex"
            className="flex items-center gap-1.5 text-[12px] text-muted-foreground hover:text-primary transition-colors">
            <Sparkles size={14} />{!compact && " Import from OpenAlex"}
          </button>
          <button onClick={() => setAdding((v) => !v)} title="Add a reading to grab" aria-label="Add a reading to grab"
            className="flex items-center gap-1.5 text-[12px] text-muted-foreground hover:text-primary transition-colors">
            <Plus size={14} />{!compact && " Add a reading to grab"}
          </button>
          {/* the filing backlog lives here as a header action — downloaded PDFs sitting
              in the Inbox; opens the hands-on one-by-one triage filer (same as Library) */}
          {inboxPdfs.count > 0 && (
            <button onClick={() => setTriage(true)}
              title={`${inboxPdfs.count} downloaded PDF${inboxPdfs.count === 1 ? "" : "s"} in the Inbox — step through them one at a time: rename to convention and file into the Corpus`}
              className="inline-flex items-center gap-1.5 text-[12px] px-3 py-1.5 rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-accent transition-colors">
              <Inbox size={13} />
              File inbox <span className="nums text-warning font-medium">{inboxPdfs.count}</span>
            </button>
          )}
        </div>
      </div>

      {/* type filter — article / book / other, so a long queue can be worked one kind at a time */}
      {open && downloads.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap mb-4">
          {FILTER_TABS.map((t) => (
            <button key={t.key} onClick={() => setFilter(t.key)}
              className={`text-[12px] px-2.5 py-0.5 rounded-full transition-colors ${filter === t.key
                ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground"}`}>
              {t.label} <span className="nums">{counts[t.key]}</span>
            </button>
          ))}
        </div>
      )}

      {open && <QueueAddInput reload={reload} />}
      {adding && <AddGrabForm lists={lists} reload={reload} onDone={() => setAdding(false)} />}
      {showImport && <OpenAlexImport reload={reload} onDone={() => setShowImport(false)} />}
      {triage && <InboxTriage onClose={() => { setTriage(false); refreshInbox(); reload(); }} />}
      {open && (downloads.length === 0 ? (
        <Empty>Nothing to download. Add a reading to grab, or flag any list item as “not downloaded.”</Empty>
      ) : shown.length === 0 ? (
        <Empty>No {filter === "all" ? "" : TYPE_LABEL[filter as ReadingType].toLowerCase()} readings to download.</Empty>
      ) : (
        <div>
          {sourceRuns(rowsC.shown).map((run) => {
            const where = whereOf(run.d);
            return (
              <div key={run.key} data-queue-source={where}>
                <div className="flex items-center gap-1.5 min-w-0 pt-2.5 pb-1 text-[11.5px] text-muted-foreground"
                  title={`${WHERE_TIP[where]}: ${run.d.list}`}>
                  {where === "archived" ? <Archive size={12} className="shrink-0" />
                    : where === "queue" ? <Inbox size={12} className="shrink-0" />
                    : <ListChecks size={12} className="shrink-0" />}
                  <span className="truncate min-w-0 font-medium text-foreground/80">{cleanName(run.d.list)}</span>
                  {where !== "active" && (
                    <span className="shrink-0 rounded-full border border-border px-1.5 py-px text-[9.5px] uppercase tracking-wide">
                      {where === "archived" ? "archived" : "queue"}
                    </span>
                  )}
                  <span className="nums shrink-0">· {perSource.get(run.key) ?? run.rows.length}</span>
                  {where === "queue" && (
                    <button onClick={() => restoreList(run.d.list)} title="Restore as a reading list" aria-label="Restore as a reading list"
                      className="ml-auto shrink-0 text-muted-foreground/70 hover:text-primary transition-colors">
                      <RotateCcw size={12} />
                    </button>
                  )}
                </div>
                <div className="divide-y divide-border/40">
                  {run.rows.map((d) => (
                    <div key={rowKey(d)} className="min-w-0 flex items-center gap-2.5 py-1.5 group">
                      <span title="Not downloaded"
                        className="shrink-0 text-[hsl(var(--due-soon))]"><Download size={14} /></span>
                      <span className="text-[13px] leading-snug truncate min-w-0 flex-1"
                        title={`${d.title}\n${cleanName(d.list)} · ${d.groupName}${d.read ? ` · read: ${d.read}` : ""}`}>
                        {d.title}
                      </span>
                      {!compact && d.groupName && (
                        <span className="shrink-0 max-w-[34%] truncate text-[11px] text-muted-foreground/70">
                          {d.groupName}
                        </span>
                      )}
                      <TypeChip type={d.type} onPick={(t) => setType(d, t)} />
                      <button onClick={() => markHave(d)} title="Mark as downloaded / have"
                        className="opacity-0 group-hover:opacity-100 group-data-[focused]/widget:opacity-100 focus-visible:opacity-100 transition-opacity text-muted-foreground hover:text-primary shrink-0">
                        <Check size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      ))}
      {open && <MoreRows more={rowsC.more} onClick={rowsC.showAll} />}
    </Card>
  );
}

function QueueAddInput({ reload }: { reload: () => void }) {
  const [v, setV] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const q = v.trim();
    if (!q || busy) return;
    setBusy(true);
    try {
      const looksDoi = /^(https?:\/\/(dx\.)?doi\.org\/|doi:\s*)?10\.\d{4,9}\//i.test(q);
      const r: QueueAddResult = await api.readingQueueAdd(looksDoi ? { doi: q } : { title: q });
      if (r.ok && r.added) { toast("Queued to download", { description: (r.title || q).slice(0, 70) }); setV(""); reload(); }
      else if (r.ok && r.duplicate) {
        const dup = r.duplicate;
        toast(dup.needsDownload ? "Already queued" : "Already have it", {
          description: `${cleanName(dup.list)}${dup.where === "archived" ? " (archived)" : ""} · ${dup.title.slice(0, 60)}` });
        setV("");
      } else toast.error(r.error || "Couldn't queue it");
    } catch { toast.error("Couldn't queue it"); }
    finally { setBusy(false); }
  };
  return (
    <div className="flex items-center gap-2 mt-3 mb-3">
      <div className="relative min-w-0 flex-1">
        <Plus size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground/60 pointer-events-none" />
        <Input value={v} onChange={(e) => setV(e.target.value)} data-queue-add
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } }}
          placeholder="Queue a paper — DOI or title" aria-label="Queue a paper to download by DOI or title"
          title="Adds it to the download queue, not to a reading list. A DOI already queued or on any list is skipped."
          className="h-8 text-[12.5px] pl-6 pr-7" />
        {busy && <Loader2 size={12} className="absolute right-2 top-1/2 -translate-y-1/2 animate-spin text-muted-foreground/50" />}
      </div>
      <button onClick={submit} disabled={busy || !v.trim()} title="Queue it" aria-label="Queue it"
        className="shrink-0 inline-flex items-center gap-1 text-[12px] px-2.5 py-1.5 rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-accent disabled:opacity-50 transition-colors">
        <Download size={13} />
      </button>
    </div>
  );
}

function OpenAlexImport({ reload, onDone }: { reload: () => void; onDone: () => void }) {
  const [mode, setMode] = useState<"author" | "lines" | "topic">("author");
  const [query, setQuery] = useState("");
  const [preview, setPreview] = useState<OAImport | null>(null);
  const [listName, setListName] = useState("");
  const [busy, setBusy] = useState(false);

  const doPreview = async () => {
    if (!query.trim()) return;
    setBusy(true); setPreview(null);
    try {
      const r = await api.readingImportPreview(mode, query.trim());
      if (r.error) { toast.error(r.error); return; }
      setPreview(r);
      setListName(mode === "author" && r.author ? r.author.name : query.trim().slice(0, 40));
    } catch { toast.error("OpenAlex lookup failed"); }
    finally { setBusy(false); }
  };
  const doBuild = async () => {
    if (!preview?.items?.length || !listName.trim()) return;
    setBusy(true);
    try {
      const r = await api.readingImportBuild(preview.items, listName.trim(), query.trim());
      if (r.error) { toast.error(r.error); return; }
      toast.success(`Created “${cleanName(r.built?.list || listName)}” — ${r.built?.added ?? 0} queued`);
      onDone(); reload();
    } catch { toast.error("Couldn't create the list"); }
    finally { setBusy(false); }
  };

  return (
    <div className="rounded-lg border border-border/60 p-4 mb-4 bg-accent/20">
      <div className="flex items-center gap-1.5 mb-2.5">
        {([["author", "Author"], ["lines", "DOIs / titles"], ["topic", "Topic"]] as const).map(([m, label]) => (
          <button key={m} onClick={() => { setMode(m); setPreview(null); }}
            className={`text-[12px] px-2.5 py-1 rounded-full transition-colors ${mode === m
              ? "bg-primary text-primary-foreground" : "bg-muted/60 text-muted-foreground hover:bg-muted"}`}>
            {label}
          </button>
        ))}
      </div>
      {mode === "lines" ? (
        <textarea value={query} onChange={(e) => setQuery(e.target.value)} rows={4}
          placeholder={"One per line — a DOI or a title:\n10.0000/example\nAn Invented Title (2001)"}
          className="w-full text-[12.5px] rounded-md border border-border bg-background p-2 font-mono resize-y" />
      ) : (
        <Input value={query} onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") doPreview(); }}
          placeholder={mode === "author" ? "Author name, e.g. Ada Fakename" : "Topic / keywords, e.g. sample topic"}
          className="h-9 text-[13px]" />
      )}
      <div className="flex items-center gap-2 mt-2.5 flex-wrap">
        <button onClick={doPreview} disabled={busy || !query.trim()}
          className="text-[12.5px] inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary text-primary-foreground disabled:opacity-50">
          {busy ? <Loader2 size={13} className="animate-spin" /> : <Search size={13} />} Preview
        </button>
        {preview?.author && (
          <span className="text-[11.5px] text-muted-foreground">
            matched <b className="text-foreground">{preview.author.name}</b>
            {preview.author.institution ? ` · ${preview.author.institution}` : ""} · {preview.author.works} works
          </span>
        )}
      </div>

      {preview?.items && (
        <div className="mt-3">
          <div className="text-[11px] uppercase tracking-[0.08em] font-semibold text-muted-foreground mb-1.5">
            {preview.items.length} works · {preview.items.filter((i) => i.doi).length} with DOI
          </div>
          <div className="max-h-44 overflow-y-auto tinybar divide-y divide-border/40 mb-3 pr-1">
            {preview.items.map((it, i) => (
              <div key={i} className="flex items-center gap-2 py-1.5">
                <ConfChip c={it.confidence} />
                <span className="text-[12.5px] truncate flex-1">{it.title}</span>
                {!it.doi && <span className="text-[10.5px] text-destructive shrink-0">no DOI</span>}
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Input value={listName} onChange={(e) => setListName(e.target.value)}
              placeholder="List name" className="h-8 text-[12.5px] max-w-xs" />
            <button onClick={doBuild} disabled={busy || !listName.trim()}
              className="text-[12.5px] inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-foreground text-background disabled:opacity-50">
              <Plus size={13} /> Create download list
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// confidence chip on an OpenAlex preview row
function ConfChip({ c }: { c?: string }) {
  const m: Record<string, { label: string; color: string; bg: string }> = {
    HIGH:   { label: "DOI",    color: "hsl(var(--primary))",          bg: "hsl(var(--primary)/0.15)" },
    MEDIUM: { label: "~match", color: "hsl(var(--due-soon))",         bg: "hsl(var(--due-soon)/0.15)" },
    LOW:    { label: "weak",   color: "hsl(var(--destructive))",      bg: "hsl(var(--destructive)/0.15)" },
    TOPIC:  { label: "topic",  color: "hsl(var(--muted-foreground))", bg: "hsl(var(--muted)/0.8)" },
  };
  const v = m[c || ""];
  if (!v) return null;
  return <span className="text-[9.5px] uppercase tracking-wide px-1.5 py-0.5 rounded shrink-0" style={{ color: v.color, background: v.bg }}>{v.label}</span>;
}

// the type badge on each download row — click to reclassify (writes a Type: line)
function TypeChip({ type, onPick }: { type: ReadingType; onPick: (t: ReadingType) => void }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button title="Reading type — click to change"
          className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[10.5px] uppercase tracking-[0.05em] text-muted-foreground hover:border-primary/40 hover:text-foreground transition-colors">
          {TYPE_LABEL[type]}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-36 p-1.5">
        <div className="text-[10.5px] uppercase tracking-[0.08em] font-semibold text-muted-foreground px-2 pt-1 pb-1">Set type</div>
        {(["article", "book", "other"] as ReadingType[]).map((t) => (
          <button key={t} onClick={() => onPick(t)}
            className={`w-full text-left text-[12.5px] px-2 py-1.5 rounded hover:bg-accent transition-colors flex items-center gap-2 ${t === type ? "text-primary" : ""}`}>
            {t === type && <Check size={12} />}<span className={t === type ? "" : "pl-[18px]"}>{TYPE_LABEL[t]}</span>
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

function useReadingSearch(query: string, active: boolean) {
  const [corpusHits, setCorpusHits] = useState<CorpusHit[]>([]);
  const [oaHits, setOaHits] = useState<OAItem[]>([]);
  const [loading, setLoading] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reqId = useRef(0);
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    const q = query.trim();
    if (!active || q.length < 2) { setCorpusHits([]); setOaHits([]); setLoading(false); return; }
    setLoading(true);
    const id = ++reqId.current;
    timer.current = setTimeout(() => {
      Promise.all([
        api.readingCorpusSearch(q).catch(() => [] as CorpusHit[]),
        api.readingImportPreview("topic", q, 6).catch(() => ({ items: [] as OAItem[] })),
      ]).then(([corpus, oa]) => {
        if (reqId.current !== id) return;   // a newer keystroke already fired — drop this stale response
        setCorpusHits(corpus);
        setOaHits(oa.items || []);
        setLoading(false);
      });
    }, 320);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [query, active]);
  return { corpusHits, oaHits, loading };
}

function ResultGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-[0.08em] font-semibold text-muted-foreground/80">{label}</div>
      {children}
    </div>
  );
}

function ResultRow({ title, sub, badge, active, onPick }: { title: string; sub?: string; badge?: string; active: boolean; onPick: () => void }) {
  return (
    // mousedown (not click) fires before the input's onBlur closes the dropdown
    <button onMouseDown={(e) => { e.preventDefault(); onPick(); }}
      className={`w-full text-left px-3 py-1.5 text-[12.5px] flex items-center gap-2 transition-colors ${active ? "bg-accent" : "hover:bg-accent/60"}`}>
      <span className="min-w-0 flex-1 truncate">{title}</span>
      {sub && <span className="text-[11px] text-muted-foreground/70 shrink-0 max-w-[40%] truncate">{sub}</span>}
      {badge && <span className="text-[9.5px] uppercase tracking-wide px-1.5 py-0.5 rounded shrink-0 bg-primary/10 text-primary">{badge}</span>}
    </button>
  );
}

function ReadingSearchBox({ value, onChangeText, onPickCorpus, onPickOpenAlex, onManualEnter, placeholder, className, autoFocus }: {
  value: string; onChangeText: (v: string) => void;
  onPickCorpus: (h: CorpusHit) => void; onPickOpenAlex: (h: OAItem) => void;
  onManualEnter?: () => void; placeholder: string; className?: string; autoFocus?: boolean;
}) {
  const [focused, setFocused] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const { corpusHits, oaHits, loading } = useReadingSearch(value, focused);
  const showDropdown = focused && value.trim().length >= 2;
  const total = corpusHits.length + oaHits.length;

  useEffect(() => { setHighlight(0); }, [value]);

  const choose = (i: number) => {
    if (i < corpusHits.length) onPickCorpus(corpusHits[i]);
    else if (i < total) onPickOpenAlex(oaHits[i - corpusHits.length]);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { setFocused(false); return; }
    if (showDropdown && total > 0) {
      if (e.key === "ArrowDown") { e.preventDefault(); setHighlight((h) => Math.min(h + 1, total - 1)); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setHighlight((h) => Math.max(h - 1, 0)); return; }
      if (e.key === "Enter") { e.preventDefault(); choose(highlight); return; }
    }
    if (e.key === "Enter" && onManualEnter) onManualEnter();
  };

  return (
    <div className={`relative ${className || ""}`}>
      <div className="relative">
        <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground/50 pointer-events-none" />
        <Input autoFocus={autoFocus} value={value} onChange={(e) => onChangeText(e.target.value)} onKeyDown={onKeyDown}
          onFocus={() => setFocused(true)} onBlur={() => setTimeout(() => setFocused(false), 150)}
          placeholder={placeholder} className="h-8 text-[13px] pl-6 pr-6" />
        {loading && <Loader2 size={11} className="absolute right-2 top-1/2 -translate-y-1/2 animate-spin text-muted-foreground/40" />}
      </div>
      {showDropdown && (
        <div className="absolute z-20 left-0 right-0 rounded-md border border-border bg-popover shadow-lg mt-0.5 max-h-64 overflow-y-auto tinybar">
          {corpusHits.length === 0 && oaHits.length === 0 ? (
            <div className="px-3 py-2.5 text-[12px] text-muted-foreground">{loading ? "Searching…" : "No matches — type your own title."}</div>
          ) : (
            <>
              {corpusHits.length > 0 && (
                <ResultGroup label="In your library">
                  {corpusHits.map((h, i) => (
                    <ResultRow key={h.rel} active={highlight === i} onPick={() => onPickCorpus(h)}
                      title={h.title || h.stem} sub={[h.author, h.year].filter(Boolean).join(" · ")}
                      badge={h.status === "read" ? "read" : h.status === "reading" ? "reading" : undefined} />
                  ))}
                </ResultGroup>
              )}
              {oaHits.length > 0 && (
                <ResultGroup label="OpenAlex">
                  {oaHits.map((h, i) => (
                    <ResultRow key={h.openalexId || h.title} active={highlight === corpusHits.length + i} onPick={() => onPickOpenAlex(h)}
                      title={h.displayTitle || h.title} sub={[(h.authors || []).slice(0, 2).join(", "), h.year].filter(Boolean).join(" · ")}
                      badge={h.isOA ? "OA" : undefined} />
                  ))}
                </ResultGroup>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// a client-side mirror of openalex.py's `_why()` — so picking a live OpenAlex hit
// leaves the same auto-generated context note a server-side import would.
function oaAutoWhy(h: OAItem): string {
  const bits: string[] = [];
  if (h.venue) bits.push(h.venue);
  if (h.isOA) bits.push(`OA:${h.oaStatus || "yes"}`);
  if (h.confidence && h.confidence !== "HIGH") bits.push(`match:${h.confidence}`);
  if (!h.doi) bits.push("no DOI");
  return bits.join("; ");
}

function AddGrabForm({ lists, reload, onDone }: { lists: ReadingList[]; reload: () => void; onDone: () => void }) {
  const [listName, setListName] = useState("");
  const groups = (lists.find((l) => l.name === listName)?.groups || []).filter((g) => !g.prose);
  const [groupIdxAbs, setGroupIdxAbs] = useState<number>(-1);
  const [title, setTitle] = useState("");
  const [meta, setMeta] = useState<{ citationPath?: string; doi?: string }>({});
  const [why, setWhy] = useState("");
  const [read, setRead] = useState("");

  // resolve the chosen group to its ABSOLUTE index in the full groups array (server ref)
  const absIndexOf = (l: ReadingList | undefined, g: ReadingGroup) => l ? l.groups.indexOf(g) : -1;
  const list = lists.find((l) => l.name === listName);
  const submit = async () => {
    if (!title.trim()) { toast.error("Enter a title or DOI"); return; }
    if (!listName) {
      try {
        const r = await api.readingQueueAdd({ title: title.trim(), doi: meta.doi, why: why.trim() });
        if (r.ok && r.added) toast("Queued to download", { description: (r.title || title).slice(0, 50) });
        else if (r.ok && r.duplicate) toast("Already queued", { description: `${cleanName(r.duplicate.list)} · ${r.duplicate.title.slice(0, 50)}` });
        else { toast.error(r.error || "Couldn't add"); return; }
        setTitle(""); setMeta({}); setWhy(""); setRead(""); reload(); onDone();
      } catch { toast.error("Couldn't add"); }
      return;
    }
    const gi = groupIdxAbs >= 0 ? groupIdxAbs : (groups[0] ? absIndexOf(list, groups[0]) : null);
    try {
      await api.readingOp("item/add", { list: listName, group: gi, title: title.trim(), why: why.trim(), read: read.trim(), needsDownload: true, ...meta });
      toast("Added to download queue", { description: title.slice(0, 50) });
      setTitle(""); setMeta({}); setWhy(""); setRead(""); reload(); onDone();
    } catch { toast.error("Couldn't add"); }
  };
  return (
    <div className="rounded-lg border border-border bg-accent/20 p-3.5 mb-4 space-y-2.5">
      <ReadingSearchBox autoFocus value={title}
        onChangeText={(v) => { setTitle(v); setMeta({}); }}
        placeholder="Search your library or OpenAlex, paste a DOI, or type Author (year) — Title"
        onManualEnter={submit}
        onPickCorpus={(h) => setTitle(h.stem)}
        onPickOpenAlex={(h) => { setTitle(h.title); setMeta({ doi: h.doi || undefined }); if (!why.trim()) setWhy(oaAutoWhy(h)); }} />
      <div className="grid grid-cols-1 gap-2.5 group-data-[size=md]/widget:grid-cols-2 group-data-[size=lg]/widget:grid-cols-2 group-data-[size=xl]/widget:grid-cols-2">
        {listName && <Input value={read} onChange={(e) => setRead(e.target.value)} placeholder="What to read (e.g. intro + ch. 3)" className="h-8 text-[12.5px]" />}
        <Input value={why} onChange={(e) => setWhy(e.target.value)} placeholder="Why (optional)" className="h-8 text-[12.5px]" />
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <select value={listName} onChange={(e) => { setListName(e.target.value); setGroupIdxAbs(-1); }}
          title="Where it goes: the download queue, or a reading list"
          className="h-8 text-[12.5px] rounded-md border border-input bg-background px-2 max-w-[200px]">
          <option value="">Download queue</option>
          {lists.map((l) => <option key={l.name} value={l.name}>{cleanName(l.name)}</option>)}
        </select>
        {listName && (
          <select value={groupIdxAbs} onChange={(e) => setGroupIdxAbs(Number(e.target.value))}
            className="h-8 text-[12.5px] rounded-md border border-input bg-background px-2 max-w-[180px]">
            <option value={-1}>{groups[0] ? groups[0].name : "first group"}</option>
            {groups.map((g) => <option key={g.name + absIndexOf(list, g)} value={absIndexOf(list, g)}>{(g.level ?? 3) >= 4 ? `   ${g.name}` : g.name}</option>)}
          </select>
        )}
        <div className="ml-auto flex items-center gap-2">
          <button type="button" onClick={onDone} data-knav-back className="text-[12px] text-muted-foreground hover:text-foreground px-2 py-1">Cancel</button>
          <button onClick={submit} className="text-[12px] bg-primary text-primary-foreground rounded-md px-3 py-1.5 hover:opacity-90">Add</button>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------- one reading list (syllabus)
type LocalItem = ReadingItem & { iid: string };
type LocalGroup = ReadingGroup & { gid: string; localItems: LocalItem[] };

function deriveGroups(list: ReadingList): LocalGroup[] {
  return list.groups.map((g, gi) => ({
    ...g, gid: `grp:${gi}`,
    localItems: g.items.map((it, ii) => ({ ...it, iid: `itm:${gi}:${ii}` })),
  }));
}

type Section = { head: number; subs: number[] };
const isSub = (g: { level?: number }) => (g.level ?? 3) >= 4;
function sectionsOf(groups: LocalGroup[]): Section[] {
  const out: Section[] = [];
  groups.forEach((g, gi) => {
    if (isSub(g) && out.length) out[out.length - 1].subs.push(gi);
    else out.push({ head: gi, subs: [] });
  });
  return out;
}

function ListCard({ list, isOpen, onToggleOpen, everRead, overrides, setOverrides, mark, reload, vaultPath }: {
  list: ReadingList; isOpen: boolean; onToggleOpen: () => void;
  everRead: (it: ReadingItem) => boolean;
  overrides: Record<string, ReadState>; setOverrides: React.Dispatch<React.SetStateAction<Record<string, ReadState>>>;
  mark: (citationName: string, state: ReadState) => void;
  reload: () => void; vaultPath?: string;
}) {
  const [groups, setGroups] = useState<LocalGroup[]>(() => deriveGroups(list));
  const [q, setQ] = useState("");
  useEffect(() => { setGroups(deriveGroups(list)); }, [list]);
  const sections = useMemo(() => sectionsOf(groups), [groups]);
  const repeated = useMemo(() => {
    const n = new Map<string, number>();
    groups.forEach((g) => g.localItems.forEach((it) => n.set(it.title, (n.get(it.title) ?? 0) + 1)));
    return new Set([...n].filter(([, c]) => c > 1).map(([t]) => t));
  }, [groups]);

  const dialogs = useDialogs();
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
    // Space picks up and drops; Enter stays "open" for the arrow-key board
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space"] },
    }),
  );

  const op = (name: string, body: Record<string, unknown>): Promise<void> =>
    api.readingOp(name, { list: list.name, ...body }).then(() => {
      reload();
      if (name === "item/next" || name === "item/due" || name === "group/due") {
        window.setTimeout(reload, 2000);
        window.setTimeout(reload, 6000);
      }
    }).catch(() => { toast.error("Couldn't save"); });

  const onDragEnd = (e: DragEndEvent) => {
    const a = String(e.active.id), o = String(e.over?.id ?? "");
    if (!o || a === o) return;
    if (a.startsWith("grp:") && o.startsWith("grp:")) {
      // a head drags its whole section; a subgroup reorders only among its siblings
      const pos = (id: string) => groups.findIndex((g) => g.gid === id);
      const ai = pos(a), oi = pos(o);
      const secOf = (gi: number) => sections.findIndex((s) => s.head === gi || s.subs.includes(gi));
      const sa = secOf(ai), so = secOf(oi);
      if (sa < 0 || so < 0) return;
      let secs: Section[];
      if (sections[sa].head === ai && sections[so].head === oi) {
        secs = arrayMove(sections, sa, so);
      } else if (sa === so && sections[sa].head !== ai && sections[so].head !== oi) {
        const subs = sections[sa].subs;
        secs = sections.map((s, i) => i === sa ? { ...s, subs: arrayMove(subs, subs.indexOf(ai), subs.indexOf(oi)) } : s);
      } else return;
      const next = secs.flatMap((s) => [s.head, ...s.subs]).map((i) => groups[i]);
      setGroups(next);
      op("group/reorder", { order: next.map((g) => +g.gid.slice(4)) });
    } else if (a.startsWith("itm:") && o.startsWith("itm:")) {
      const [, agi, aii] = a.split(":"); const [, ogi, oii] = o.split(":");
      if (agi !== ogi) return;  // cross-group moves go through the move-to menu
      const gi = +agi;
      setGroups((prev) => prev.map((g, i) => i === gi
        ? { ...g, localItems: arrayMove(g.localItems, +aii, +oii) } : g));
      op("item/move", { fromGroup: gi, fromItem: +aii, toGroup: gi, toIndex: +oii });
    }
  };

  const cycle = (gi: number, ii: number, it: LocalItem, double?: boolean) => {
    const key = `${list.name}|${gi}|${ii}`;
    const cur = overrides[key] ?? it.readState;
    const next: ReadState = double ? (cur === "read" ? "unread" : "read") : (cur === "reading" ? "unread" : "reading");
    setOverrides((o) => ({ ...o, [key]: next }));
    api.readingOp("toggle", { list: list.name, group: gi, item: ii, state: next })
      .then(() => { if (it.citationName) mark(it.citationName, next); reload(); })
      .catch(() => { setOverrides((o) => { const n = { ...o }; delete n[key]; return n; }); toast.error("Couldn't update"); });
  };

  const needle = q.toLowerCase();
  const otherGroups = groups.map((g, gi) => ({ name: g.name, gi, prose: g.prose }));

  // the collapsed tile previews what's next (the first unread readings); an opened list
  // or the focused view shows every group with all its row actions
  const w = useWidget();
  const full = isOpen || !!w?.focused;
  const upNext = useMemo(() => {
    const out: { it: LocalItem; gi: number; ii: number }[] = [];
    const extra: typeof out = [];   // subgroup (deepen) readings come after every assigned one
    groups.forEach((g, gi) => g.localItems.forEach((it, ii) => {
      if ((overrides[`${list.name}|${gi}|${ii}`] ?? it.readState) !== "read") (isSub(g) ? extra : out).push({ it, gi, ii });
    }));
    return out.concat(extra);
  }, [groups, overrides, list.name]);
  const preview = upNext.slice(0, rowCap(w, 3, 5));

  return (
    <Card className="h-full group-data-[focused]/widget:h-auto group-data-[focused]/widget:min-h-full p-0 overflow-hidden">
      <div className="w-full px-6 py-5 group-data-[size=xs]/widget:px-4 group-data-[size=xs]/widget:py-4 flex items-center gap-4 group-data-[size=xs]/widget:gap-3">
        <button onClick={onToggleOpen} className="shrink-0 text-muted-foreground hover:text-foreground transition-colors">
          {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </button>
        <button onClick={onToggleOpen} className="min-w-0 flex-1 text-left">
          <div className="text-[15px] font-medium leading-snug">{cleanName(list.name)}</div>
          <div className="flex items-center gap-3 mt-2">
            <Progress value={list.total ? Math.round((100 * list.read) / list.total) : 0} className="h-1.5 flex-1" />
            <span className="text-[12px] text-muted-foreground nums shrink-0">
              {list.read}/{list.total}{list.needsDownload > 0 ? ` · ${list.needsDownload} to grab` : ""}
            </span>
          </div>
        </button>
        <ArchiveNow list={list} reload={reload} />
        <ListMenu list={list} groups={groups} reload={reload} />
      </div>

      {full ? (
        <div className="border-t border-border px-6 py-4 group-data-[size=xs]/widget:px-4">
          <EditableNote value={list.note} placeholder="Add a list description…"
            onSave={(v) => op("list/note", { note: v })} className="mb-3" />
          <div className="flex items-center gap-2 mb-3">
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter this list…" className="h-8 text-[12.5px] max-w-xs" />
            <button onClick={async () => {
              const name = await dialogs.prompt({ title: "New group", description: "Name this unit of the syllabus.", placeholder: "e.g. Week 3 — Topic" });
              if (name?.trim()) op("group/add", { name: name.trim() });
            }} className="flex items-center gap-1.5 text-[12px] text-muted-foreground hover:text-primary transition-colors ml-auto">
              <FolderPlus size={14} /> Add group
            </button>
          </div>

          <DndContext sensors={sensors} collisionDetection={pointerWithin} onDragEnd={onDragEnd}>
            <SortableContext items={sections.map((s) => groups[s.head].gid)} strategy={verticalListSortingStrategy}>
              <div className="space-y-4 max-h-[620px] overflow-y-auto tinybar pr-1 group-data-[focused]/widget:max-h-none group-data-[focused]/widget:overflow-visible">
                {sections.map(({ head, subs }) => (
                  <GroupBlock key={groups[head].gid} g={groups[head]} gi={head} listName={list.name} needle={needle}
                    everRead={everRead} overrides={overrides} otherGroups={otherGroups}
                    onCycle={cycle} op={op} vaultPath={vaultPath} reload={reload}>
                    {subs.length > 0 && (
                      <SortableContext items={subs.map((si) => groups[si].gid)} strategy={verticalListSortingStrategy}>
                        <div className="mt-2 space-y-2">
                          {subs.map((si) => (
                            <GroupBlock key={groups[si].gid} g={groups[si]} gi={si} listName={list.name} needle={needle}
                              everRead={everRead} overrides={overrides} otherGroups={otherGroups}
                              onCycle={cycle} op={op} vaultPath={vaultPath} reload={reload} />
                          ))}
                        </div>
                      </SortableContext>
                    )}
                  </GroupBlock>
                ))}
                {groups.length === 0 && <div className="text-[13px] text-muted-foreground py-2">No groups yet — add one to start the syllabus.</div>}
              </div>
            </SortableContext>
          </DndContext>
        </div>
      ) : preview.length > 0 ? (
        <div className="border-t border-border px-6 py-1.5 group-data-[size=xs]/widget:px-4">
          <DndContext sensors={sensors} collisionDetection={pointerWithin} onDragEnd={onDragEnd}>
            <SortableContext items={preview.map((p) => p.it.iid)} strategy={verticalListSortingStrategy}>
              <div className="divide-y divide-border/40">
                {preview.map(({ it, gi, ii }) => (
                  <ItemRow key={it.iid} compact showScope={repeated.has(it.title)} it={it} gi={gi} ii={ii}
                    state={overrides[`${list.name}|${gi}|${ii}`] ?? it.readState}
                    everRead={everRead(it)} otherGroups={otherGroups}
                    onCycle={(d) => cycle(gi, ii, it, d)} op={op} vaultPath={vaultPath}
                    listName={list.name} reload={reload} />
                ))}
              </div>
            </SortableContext>
          </DndContext>
          {upNext.length > preview.length && (
            <button onClick={(e) => { if (!openWidgetFocus(e.currentTarget)) onToggleOpen(); }} title="Open the whole list"
              className="mb-2 mt-0.5 text-[11.5px] text-muted-foreground hover:text-primary transition-colors nums">
              +{upNext.length - preview.length} more unread
            </button>
          )}
        </div>
      ) : null}
    </Card>
  );
}

function GroupBlock({ g, gi, listName, needle, everRead, overrides, otherGroups, onCycle, op, vaultPath, reload, children }: {
  g: LocalGroup; gi: number; listName: string; needle: string; reload: () => void;
  everRead: (it: ReadingItem) => boolean; overrides: Record<string, ReadState>;
  otherGroups: { name: string; gi: number; prose: boolean }[];
  onCycle: (gi: number, ii: number, it: LocalItem, double?: boolean) => void;
  op: (name: string, body: Record<string, unknown>) => Promise<void>;
  vaultPath?: string;
  children?: React.ReactNode;
}) {
  const { setNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({ id: g.gid });
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 };
  const [adding, setAdding] = useState(false);
  const dialogs = useDialogs();
  const sub = isSub(g);
  // subgroups (extra preparation) start folded; the choice sticks per list + subgroup
  const [subOpen, setSubOpen] = usePersistent<boolean>(`reading.subgroup.${listName}|${g.name}`, false);
  const shown = g.localItems
    .map((it, ii) => ({ it, ii }))
    .filter(({ it }) => !needle || it.title.toLowerCase().includes(needle) || (it.why || "").toLowerCase().includes(needle) || (it.read || "").toLowerCase().includes(needle));
  const open = !sub || subOpen || adding || (!!needle && shown.length > 0);

  if (sub) {
    const unread = g.localItems.filter((it, ii) => (overrides[`${listName}|${gi}|${ii}`] ?? it.readState) !== "read").length;
    return (
      <div ref={setNodeRef} style={style} className="touch-none ml-[22px] border-l border-border/60 pl-3">
        <div className="flex items-center gap-1.5 mb-1 group/head">
          <button {...attributes} {...listeners} title="Drag to reorder within this session"
            className="cursor-grab active:cursor-grabbing text-muted-foreground/30 hover:text-muted-foreground shrink-0">
            <GripVertical size={12} />
          </button>
          <button onClick={() => setSubOpen(!subOpen)} aria-expanded={open}
            title={open ? "Fold" : "Unfold"}
            className="shrink-0 text-muted-foreground/60 hover:text-foreground transition-colors">
            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
          <EditableText value={g.name} placeholder="(untitled subgroup)"
            onSave={(v) => op("group/rename", { group: gi, name: v })}
            className="text-[12px] font-medium text-muted-foreground/75 min-w-0 truncate" />
          <span className="text-[11px] text-muted-foreground/50 nums shrink-0"
            title={`${unread} unread of ${g.localItems.length}`}>{g.localItems.length}</span>
          <div className="ml-auto flex items-center gap-1 opacity-0 group-hover/head:opacity-100 group-focus-within/head:opacity-100 group-data-[focused]/widget:opacity-100 transition-opacity">
            {!g.prose && (
              <button onClick={() => setAdding((v) => !v)} title="Add a reading to this subgroup"
                className="text-muted-foreground hover:text-primary"><Plus size={12} /></button>
            )}
            {!g.prose && <GroupDue g={g} gi={gi} op={op} size={11} />}
            <button onClick={async () => {
              if (await dialogs.confirm({ title: "Delete subgroup?", description: `“${g.name}” and its ${g.localItems.length} items will be removed.`, confirmLabel: "Delete", danger: true })) op("group/delete", { group: gi });
            }} title="Delete subgroup" className="text-muted-foreground hover:text-destructive"><Trash2 size={11} /></button>
          </div>
        </div>
        {open && (
          <div className="opacity-90">
            <EditableNote value={g.note} placeholder="Add a note…"
              onSave={(v) => op("group/note", { group: gi, note: v })} className="mb-1.5" />
            {adding && (
              <AddItemSearch onAdd={(payload) => { op("item/add", { group: gi, ...payload }); setAdding(false); }}
                onCancel={() => setAdding(false)} />
            )}
            {g.prose ? (
              <div className="text-[12px] text-muted-foreground/70 italic py-1">Reference section — no tracked items.</div>
            ) : (
              <SortableContext items={g.localItems.map((it) => it.iid)} strategy={verticalListSortingStrategy}>
                <div className="divide-y divide-border/40">
                  {shown.map(({ it, ii }) => (
                    <ItemRow key={it.iid} it={it} gi={gi} ii={ii}
                      state={overrides[`${listName}|${gi}|${ii}`] ?? it.readState}
                      everRead={everRead(it)} otherGroups={otherGroups}
                      onCycle={(d) => onCycle(gi, ii, it, d)} op={op} vaultPath={vaultPath}
                      listName={listName} reload={reload} />
                  ))}
                  {shown.length === 0 && g.localItems.length > 0 && <div className="text-[12px] text-muted-foreground py-1.5">No matches in this subgroup.</div>}
                  {g.localItems.length === 0 && <div className="text-[12px] text-muted-foreground/60 py-1.5">Empty — add a reading.</div>}
                </div>
              </SortableContext>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div ref={setNodeRef} style={style} className="touch-none">
      <div className="flex items-center gap-1.5 mb-1.5 group/head">
        <button {...attributes} {...listeners} title="Drag to reorder this group"
          className="cursor-grab active:cursor-grabbing text-muted-foreground/40 hover:text-muted-foreground shrink-0">
          <GripVertical size={14} />
        </button>
        <EditableText value={g.name} placeholder="(untitled group)"
          onSave={(v) => op("group/rename", { group: gi, name: v })}
          className="text-[11.5px] uppercase tracking-[0.1em] font-semibold text-muted-foreground/80" />
        <span className="text-[11px] text-muted-foreground/50 nums">{g.localItems.length}</span>
        <div className="ml-auto flex items-center gap-1 opacity-0 group-hover/head:opacity-100 group-focus-within/head:opacity-100 group-data-[focused]/widget:opacity-100 transition-opacity">
          {!g.prose && (
            <button onClick={() => setAdding((v) => !v)} title="Add a reading to this group"
              className="text-muted-foreground hover:text-primary"><Plus size={13} /></button>
          )}
          {!g.prose && <GroupDue g={g} gi={gi} op={op} size={12} />}

          <button onClick={async () => {
            if (await dialogs.confirm({ title: "Delete group?", description: `“${g.name}” and its ${g.localItems.length} items will be removed.`, confirmLabel: "Delete", danger: true })) op("group/delete", { group: gi });
          }} title="Delete group" className="text-muted-foreground hover:text-destructive"><Trash2 size={12} /></button>
        </div>
      </div>

      <div className="pl-[22px]">
        <EditableNote value={g.note} placeholder="Add a note — what to read for this unit…"
          onSave={(v) => op("group/note", { group: gi, note: v })} className="mb-2" />

        {adding && (
          <AddItemSearch onAdd={(payload) => { op("item/add", { group: gi, ...payload }); setAdding(false); }}
            onCancel={() => setAdding(false)} />
        )}

        {g.prose ? (
          <div className="text-[12px] text-muted-foreground/70 italic py-1">Reference section — no tracked items.</div>
        ) : (
          <SortableContext items={g.localItems.map((it) => it.iid)} strategy={verticalListSortingStrategy}>
            <div className="divide-y divide-border/40">
              {shown.map(({ it, ii }) => (
                <ItemRow key={it.iid} it={it} gi={gi} ii={ii}
                  state={overrides[`${listName}|${gi}|${ii}`] ?? it.readState}
                  everRead={everRead(it)} otherGroups={otherGroups}
                  onCycle={(d) => onCycle(gi, ii, it, d)} op={op} vaultPath={vaultPath}
                  listName={listName} reload={reload} />
              ))}
              {shown.length === 0 && g.localItems.length > 0 && <div className="text-[12px] text-muted-foreground py-1.5">No matches in this group.</div>}
              {g.localItems.length === 0 && !children && <div className="text-[12px] text-muted-foreground/60 py-1.5">Empty — add a reading.</div>}
            </div>
          </SortableContext>
        )}
      </div>
      {children}
    </div>
  );
}

// one read-by date for every reading of a group, from the group's own actions
function GroupDue({ g, gi, op, size }: {
  g: LocalGroup; gi: number; size: number;
  op: (name: string, body: Record<string, unknown>) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const dues = new Set(g.localItems.map((it) => it.due || ""));
  const shared = dues.size === 1 ? [...dues][0] || null : null;   // shown when they all agree
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button title="Set a read-by date for the group" className="text-muted-foreground hover:text-primary"><CalendarDays size={size} /></button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-60 p-2.5">
        <div className="text-[10.5px] uppercase tracking-[0.08em] font-semibold text-muted-foreground pb-1.5">Read by</div>
        <DueField value={shared} clearable={g.localItems.some((it) => !!it.due)}
          onSet={(d) => { setOpen(false); op("group/due", { group: gi, date: d }); }} />
      </PopoverContent>
    </Popover>
  );
}

const RETRACTED_WHY = "RETRACTED — ";
function splitRetraction(why: string | null | undefined): { reason: string | null; rest: string | null } {
  if (!why || !why.startsWith(RETRACTED_WHY)) return { reason: null, rest: why ?? null };
  const parts = why.slice(RETRACTED_WHY.length).split(" · ");
  return { reason: parts[0].trim() || null, rest: parts.slice(1).join(" · ").trim() || null };
}

function ItemRow({ it, gi, ii, state, everRead, otherGroups, onCycle, op, vaultPath, listName, reload, compact, showScope }: {
  it: LocalItem; gi: number; ii: number; state: ReadState; everRead: boolean; compact?: boolean; showScope?: boolean;
  otherGroups: { name: string; gi: number; prose: boolean }[];
  onCycle: (double?: boolean) => void;
  op: (name: string, body: Record<string, unknown>) => Promise<void>;
  vaultPath?: string;
  listName: string;
  reload: () => void;
}) {
  const { setNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({ id: it.iid });
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 };
  const [making, setMaking] = useState(false);
  const dot = useDotClick(onCycle);

  const openOrMakeNote = async () => {
    if (it.why?.startsWith("OWNED — ")) {
      const work = (it.source || it.title).trim();
      openPrintBook(it.citationName ? { stem: it.citationName }
        : { prefill: { doi: it.doi || "", title: work.replace(/^.*?\(\d{4}\)\s*-\s*/, "") } });
      return;
    }
    if (it.citationName) { api.open(CITE(it.citationName)); return; }
    if (making) return;
    setMaking(true);
    try {
      const r = await api.readingOp("item/make-citation", { list: listName, title: it.title }) as
        { ok?: boolean; path?: string; created?: boolean; metadataFrom?: string; error?: string };
      if (!r?.ok || !r.path) { toast.error(r?.error || "Couldn't make the citation note"); return; }
      api.open(r.path);
      if (r.created) {
        toast.success("Citation note created", {
          description: r.metadataFrom === "crossref"
            ? "Fields verified against CrossRef — add quotes and a rating as you read."
            : "Fields read off the reading line (unverified) — fill it in as you read.",
        });
      }
      reload();
    } catch { toast.error("Couldn't make the citation note"); }
    finally { setMaking(false); }
  };
  const obsidianFile = it.pdfPath || it.citationPath || undefined;
  const obsidianPair = it.pdfPath && it.citationPath ? it.citationPath : undefined;
  const { reason: retractedReason, rest: whyRest } = splitRetraction(it.why);
  const retractedTip = `Retracted — ${retractedReason || "no reason recorded"}`;
  const retractedCtlTip = `${retractedTip}. Requeue from the ⋮ menu to put it back in the queue.`;
  if (compact) {
    // a tile's slim line: read state, the title (opens or makes the note), the download flag
    return (
      <div ref={setNodeRef} style={style} data-obsidian-file={obsidianFile} data-obsidian-pair={obsidianPair}
        className="min-w-0 flex items-center gap-2 py-1.5 group/item">
        <button {...dot} title={DOT_TIP[state]} aria-label={DOT_TIP[state]}
          className="w-3.5 h-3.5 rounded-full shrink-0 hover:ring-2 hover:ring-primary/40 transition-shadow"
          style={{ background: STATE_COLOR[state], border: state === "unread" ? "1.5px solid hsl(var(--muted-foreground)/0.5)" : "none" }} />
        <button onClick={openOrMakeNote} disabled={making} data-knav-item="" title={it.read ? `${it.title}\nRead: ${it.read}` : it.title}
          className="min-w-0 flex-1 truncate text-left text-[13px] leading-snug group-hover/item:text-primary transition-colors disabled:opacity-60 rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/40 focus-visible:text-primary">
          {it.title}
        </button>
        {showScope && it.read && (
          <span className="min-w-0 max-w-[45%] shrink truncate text-[11.5px] text-muted-foreground" title={`Read: ${it.read}`}>{it.read}</span>
        )}
        {state !== "read" && <><QueueChip n={it.queue} /><DueChip date={it.due} /></>}
        {it.retracted ? (
          <span title={retractedTip} className="shrink-0 rounded-full border border-border px-1.5 py-px text-[9px] uppercase tracking-wide text-muted-foreground">Retracted</span>
        ) : !it.pdfPath && it.needsDownload && (
          <span title="Not downloaded" className="shrink-0 text-[hsl(var(--due-soon))]"><Download size={12} /></span>
        )}
      </div>
    );
  }
  return (
    // the `o` key opens the PDF (its note beside it) or, without a PDF, the note
    <div ref={setNodeRef} style={style} data-obsidian-file={obsidianFile} data-obsidian-pair={obsidianPair}
      className="min-w-0 flex items-start gap-2 py-2 group/item touch-none">
      <button {...attributes} {...listeners} title="Drag to reorder"
        className="cursor-grab active:cursor-grabbing text-muted-foreground/30 hover:text-muted-foreground shrink-0 mt-1 opacity-0 group-hover/item:opacity-100 group-data-[focused]/widget:opacity-100 transition-opacity">
        <GripVertical size={13} />
      </button>
      <button {...dot} title={DOT_TIP[state]} aria-label={DOT_TIP[state]}
        className="mt-0.5 w-4 h-4 rounded-full shrink-0 flex items-center justify-center hover:ring-2 hover:ring-primary/40 transition-shadow relative"
        style={{ background: STATE_COLOR[state], border: state === "unread" ? "1.5px solid hsl(var(--muted-foreground)/0.5)" : "none" }}>
        {state === "unread" && everRead && <span className="w-1.5 h-1.5 rounded-full bg-[hsl(var(--primary)/0.4)]" title="read before" />}
      </button>
      <div className="min-w-0 flex-1">
        {/* data-knav-item: the app-root key layer (components/KeyLayer.tsx)
            walks these with j/k and Enter opens the focused one */}
        <button onClick={openOrMakeNote} disabled={making} data-knav-item=""
          title={it.citationName ? "Open the citation note" : "No citation note yet — click to create one"}
          className="text-left block w-full text-[13.5px] leading-snug group-hover/item:text-primary transition-colors disabled:opacity-60 rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/40 focus-visible:text-primary">
          {it.title}
          {making && <Loader2 size={11} className="inline ml-1.5 animate-spin align-baseline" />}
        </button>
        {it.retracted && (
          <div className="mt-1">
            <span title={retractedTip}
              className="inline-block rounded-full border border-border px-1.5 py-0.5 text-[9.5px] uppercase tracking-wide text-muted-foreground">
              Retracted
            </span>
          </div>
        )}
        {it.source && (
          <div className="text-[11px] text-muted-foreground/80 mt-0.5 flex items-center gap-1">
            <Library size={10} className="shrink-0" />
            <span className="truncate" title={`Downloads as: ${it.source}`}>in {it.source}</span>
          </div>
        )}
        <EditableText value={it.read} placeholder="+ what to read (sections)" prefix="Read: "
          onSave={(v) => op("item/edit", { group: gi, item: ii, fields: { read: v } })}
          className="text-[11.5px] text-foreground/70 mt-0.5" />
        {whyRest && <div className="text-[11.5px] text-muted-foreground leading-snug mt-0.5 line-clamp-2">{whyRest}</div>}
      </div>
      <div className="flex items-center gap-1.5 shrink-0 mt-0.5">
        {state !== "read" && <><QueueChip n={it.queue} /><DueChip date={it.due} /></>}
        {it.citationName
          ? <CopyNoteLink citationName={it.citationName} vaultPath={vaultPath} />
          : <button onClick={openOrMakeNote} disabled={making} title="Make the citation note"
              className="opacity-0 group-hover/item:opacity-100 group-data-[focused]/widget:opacity-100 transition-opacity text-muted-foreground/50 hover:text-primary">
              <FilePlus2 size={13} />
            </button>}
        {it.pdfPath && (
          <button onClick={() => api.open(it.pdfPath!)} title="Open PDF"
            className="opacity-0 group-hover/item:opacity-100 group-data-[focused]/widget:opacity-100 transition-opacity text-muted-foreground hover:text-primary"><FileText size={13} /></button>
        )}
        {it.retracted ? (
          <button disabled title={retractedCtlTip} aria-label={retractedCtlTip}
            className="text-muted-foreground/40 cursor-not-allowed"><Download size={13} /></button>
        ) : it.pdfPath ? null : it.needsDownload ? (
          <button onClick={() => op("item/download", { group: gi, item: ii, needsDownload: false })}
            title="Not downloaded. Click if you already have it."
            className="text-[hsl(var(--due-soon))] hover:opacity-70"><Download size={13} /></button>
        ) : (
          <button onClick={() => op("item/download", { group: gi, item: ii, needsDownload: true })}
            title="Mark as needs download"
            className="opacity-0 group-hover/item:opacity-100 group-data-[focused]/widget:opacity-100 transition-opacity text-muted-foreground/50 hover:text-[hsl(var(--due-soon))]"><Download size={13} /></button>
        )}
        <MoveDeleteMenu gi={gi} ii={ii} otherGroups={otherGroups} op={op} retracted={!!it.retracted}
          queue={it.queue ?? null} due={it.due ?? null} isRead={state === "read"} />
      </div>
    </div>
  );
}

function MoveDeleteMenu({ gi, ii, otherGroups, op, retracted, queue, due, isRead }: {
  gi: number; ii: number; otherGroups: { name: string; gi: number; prose: boolean }[];
  op: (name: string, body: Record<string, unknown>) => Promise<void>;
  retracted?: boolean; queue: number | null; due: string | null; isRead: boolean;
}) {
  const targets = otherGroups.filter((g) => !g.prose && g.gi !== gi);
  return (
    <Popover>
      <PopoverTrigger asChild>
        {/* retract is one-way for the lanes, so on a retracted row this menu holds the
            only way back — it stays visible there instead of waiting for a hover */}
        <button title={retracted ? "Requeue / move / delete" : "Move / delete"}
          className={`transition-opacity text-muted-foreground hover:text-foreground ${retracted ? "" : "opacity-0 group-hover/item:opacity-100 group-data-[focused]/widget:opacity-100"}`}>
          <MoreVertical size={13} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-60 p-1.5">
        {/* the read-next queue and the read-by date: two separate facts about one reading */}
        <button onClick={() => op("item/next", { group: gi, item: ii, on: !queue })} disabled={isRead && !queue}
          title={queue ? `In the queue at ${queue}` : "Put it in the read-next queue"}
          className="w-full text-left text-[12.5px] px-2 py-1.5 rounded hover:bg-accent transition-colors flex items-center gap-2 disabled:opacity-40">
          {queue ? <ListX size={12} /> : <ListPlus size={12} />} {queue ? "Remove from queue" : "Add to queue"}
          {queue ? <span className="ml-auto nums text-muted-foreground">{queue}</span> : null}
        </button>
        <div className="px-2 pt-1 pb-1.5">
          <div className="text-[10.5px] uppercase tracking-[0.08em] font-semibold text-muted-foreground pb-1">Read by</div>
          <DueField value={due} onSet={(d) => op("item/due", { group: gi, item: ii, date: d })} />
        </div>
        <div className="h-px bg-border my-1" />
        {retracted && (
          <>
            <button onClick={() => op("item/requeue", { group: gi, item: ii })}
              title="Put it back in the download queue and drop the retraction note"
              className="w-full text-left text-[12.5px] px-2 py-1.5 rounded hover:bg-accent transition-colors flex items-center gap-2">
              <RotateCcw size={12} /> Requeue for download
            </button>
            <div className="h-px bg-border my-1" />
          </>
        )}
        {targets.length > 0 && <div className="text-[10.5px] uppercase tracking-[0.08em] font-semibold text-muted-foreground px-2 pt-1 pb-1">Move to group</div>}
        {targets.map((t) => (
          <button key={t.gi} onClick={() => op("item/move", { fromGroup: gi, fromItem: ii, toGroup: t.gi })}
            className="w-full text-left text-[12.5px] px-2 py-1.5 rounded hover:bg-accent transition-colors truncate">{t.name || "(untitled)"}</button>
        ))}
        {targets.length > 0 && <div className="h-px bg-border my-1" />}
        <button onClick={() => op("item/delete", { group: gi, item: ii })}
          className="w-full text-left text-[12.5px] px-2 py-1.5 rounded hover:bg-destructive/10 text-destructive transition-colors flex items-center gap-2">
          <Trash2 size={12} /> Remove from list
        </button>
      </PopoverContent>
    </Popover>
  );
}

function ArchiveNow({ list, reload }: { list: ReadingList; reload: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      title={`Archive “${cleanName(list.name)}” — keeps every item, restart it any time from the Archive below`}
      disabled={busy}
      onClick={async (e) => {
        e.stopPropagation();
        setBusy(true);
        try {
          await api.readingOp("list/archive", { list: list.name });
          toast("Archived", {
            description: `${cleanName(list.name)} — restart it any time from the Archive.`,
          });
          reload();
        } catch { toast.error("Couldn't archive"); }
        finally { setBusy(false); }
      }}
      className="shrink-0 text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50">
      {busy ? <Loader2 size={15} className="animate-spin" /> : <Archive size={15} />}
    </button>
  );
}

function ListMenu({ list, groups, reload }: { list: ReadingList; groups: LocalGroup[]; reload: () => void }) {
  const dialogs = useDialogs();
  // the `### ` groups a `#### ` subgroup can nest under (indices are the server's flat ones)
  const heads = groups.map((g, gi) => ({ g, gi })).filter(({ g }) => !isSub(g) && !g.prose && !!g.name);
  const [picking, setPicking] = useState(false);
  const op = (name: string, body: Record<string, unknown>) =>
    api.readingOp(name, { list: list.name, ...body });
  const copySyllabus = async () => {
    const lines: string[] = [cleanName(list.name)];
    if (list.note) lines.push(list.note);
    for (const g of groups) {
      lines.push("", isSub(g) ? `  ${g.name}` : g.name || "");
      if (g.note) lines.push(`  ${g.note}`);
      g.localItems.forEach((it, i) => {
        let s = `  ${i + 1}. ${it.title}`;
        if (it.read) s += `  [read: ${it.read}]`;
        if (it.needsDownload) s += `  (to download)`;
        lines.push(s);
      });
    }
    (await copyPlain(lines.join("\n"))) ? toast("Copied syllabus to clipboard") : toast.error("Couldn't copy");
  };
  return (
    <Popover onOpenChange={(o) => { if (!o) setPicking(false); }}>
      <PopoverTrigger asChild>
        <button title="List actions" className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"><MoreVertical size={16} /></button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-52 p-1.5">
        {picking ? (
          // the subgroup's parent: one `### ` group, picked in place so the menu stays short
          <>
            <button onClick={() => setPicking(false)} data-knav-back
              className="w-full text-left text-[10.5px] uppercase tracking-[0.08em] font-semibold text-muted-foreground px-2 pt-1 pb-1 flex items-center gap-1 hover:text-foreground">
              <ChevronRight size={11} className="rotate-180 shrink-0" /> Subgroup under
            </button>
            <div className="max-h-56 overflow-y-auto tinybar">
              {heads.map(({ g, gi }) => (
                <MenuBtn key={g.gid} icon={<FolderPlus size={13} className="shrink-0" />} onClick={async () => {
                  setPicking(false);
                  const name = await dialogs.prompt({ title: "New subgroup", description: g.name, placeholder: "e.g. Deepen — Subtopic" });
                  if (name?.trim()) {
                    try { await op("group/add", { name: name.trim(), parent: gi }); reload(); }
                    catch { toast.error("Couldn't add the subgroup"); }
                  }
                }}><span className="truncate min-w-0">{g.name}</span></MenuBtn>
              ))}
            </div>
          </>
        ) : (<>
        <MenuBtn icon={<Copy size={13} />} onClick={copySyllabus}>Copy as syllabus</MenuBtn>
        <MenuBtn icon={<Pencil size={13} />} onClick={async () => {
          const name = await dialogs.prompt({ title: "Rename list", defaultValue: cleanName(list.name) });
          if (name?.trim()) { await op("list/rename", { name: name.trim() }); reload(); }
        }}>Rename list</MenuBtn>
        {heads.length > 0 && (
          <MenuBtn icon={<FolderPlus size={13} />} onClick={() => setPicking(true)}>Add subgroup…</MenuBtn>
        )}
        <div className="h-px bg-border my-1" />
        <MenuBtn icon={<Archive size={13} />} onClick={async () => {
          if (await dialogs.confirm({ title: "Archive this list?", description: `“${cleanName(list.name)}” moves to the archive — you can restart it any time.`, confirmLabel: "Archive" })) { await op("list/archive", {}); reload(); }
        }}>Archive (save to restart)</MenuBtn>
        <MenuBtn icon={<Download size={13} />} onClick={async () => {
          if (await dialogs.confirm({ title: "Move to downloads?", description: `“${cleanName(list.name)}” leaves your reading lists and joins the download queue under its own name, every item kept. Restore it from the queue any time.`, confirmLabel: "Move" })) {
            try { await op("list/to-queue", {}); toast("Moved to downloads", { description: cleanName(list.name) }); reload(); }
            catch { toast.error("Couldn't move the list"); }
          }
        }}>Move to downloads</MenuBtn>
        <MenuBtn icon={<RotateCcw size={13} />} onClick={async () => {
          if (await dialogs.confirm({ title: "Reset progress?", description: `All ${list.total} items in “${cleanName(list.name)}” will be marked unread.`, confirmLabel: "Reset" })) { await op("list/restart", { file: null }); reload(); }
        }}>Reset progress</MenuBtn>
        <div className="h-px bg-border my-1" />
        <MenuBtn icon={<Trash2 size={13} />} danger onClick={async () => {
          if (await dialogs.confirm({ title: "Delete this list?", description: `“${cleanName(list.name)}” will be permanently deleted. This cannot be undone.`, confirmLabel: "Delete", danger: true })) { await op("list/delete", {}); reload(); }
        }}>Delete list</MenuBtn>
        </>)}
      </PopoverContent>
    </Popover>
  );
}

// ------------------------------------------------------------- archive (search + restart)
function ArchivePanel({ initial, reload }: { initial: ArchivedList[]; reload: () => void }) {
  const dialogs = useDialogs();
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<ArchivedList[]>(initial);
  const [searching, setSearching] = useState(false);
  useEffect(() => { setRows(initial); }, [initial]);
  // debounced live search across archived lists
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      setSearching(true);
      try { setRows(await api.readingArchive(q)); } catch { /* keep current */ } finally { setSearching(false); }
    }, 220);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [q]);

  const arc = useCapped(rows, 5, 10);

  const restart = async (a: ArchivedList) => {
    try { await api.readingOp("list/restart", { list: a.name, file: a.file }); toast("Restarted — reset to unread and reactivated", { description: cleanName(a.name) }); reload(); }
    catch { toast.error("Couldn't restart"); }
  };
  const remove = async (a: ArchivedList) => {
    if (!(await dialogs.confirm({ title: "Delete archived list?", description: `“${cleanName(a.name)}” will be permanently deleted.`, confirmLabel: "Delete", danger: true }))) return;
    try { await api.readingOp("list/delete", { archived: true, file: a.file, list: a.name }); setRows((r) => r.filter((x) => x !== a)); }
    catch { toast.error("Couldn't delete"); }
  };

  return (
    <Card className="h-full group-data-[focused]/widget:h-auto group-data-[focused]/widget:min-h-full p-6 group-data-[size=xs]/widget:p-4">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 mb-2">
        <SectionLabel icon={<Archive size={13} />}
          title="Saved reading lists. Search to find one, then restart it — that reactivates the syllabus with all progress reset to unread, leaving the saved copy intact so you can run it again any time.">Archive</SectionLabel>
        <div className="relative -mt-2 max-w-full">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/60" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search archived lists…"
            className="h-8 text-[12.5px] pl-8 w-56 max-w-full" />
          {q && <button onClick={() => setQ("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground/60 hover:text-foreground"><X size={12} /></button>}
        </div>
      </div>
      {rows.length === 0 ? (
        <Empty>{searching ? "Searching…" : q ? "No archived lists match." : "No archived lists yet. Archive a list from its menu to save it here."}</Empty>
      ) : (
        <div className="divide-y divide-border/40">
          {arc.shown.map((a) => (
            <div key={a.file + a.name} className="min-w-0 flex items-start gap-3 py-2.5 group/arc">
              <Archive size={13} className="mt-1 shrink-0 text-muted-foreground/60" />
              <div className="min-w-0 flex-1">
                <div className="text-[13.5px] leading-snug">{cleanName(a.name)}</div>
                <div className="text-[11px] text-muted-foreground nums">
                  {a.date || ""}{a.date ? " · " : ""}{a.read}/{a.total} read{a.needsDownload > 0 ? ` · ${a.needsDownload} to download` : ""} · {a.groupNames.length} groups
                  {a.groupNames.length > 0 && <span className="text-muted-foreground/70"> · {a.groupNames.slice(0, 4).join(", ")}{a.groupNames.length > 4 ? "…" : ""}</span>}
                </div>
              </div>
              <button onClick={() => restart(a)} title="Restart — reactivate with progress reset"
                className="flex items-center gap-1.5 text-[12px] text-muted-foreground hover:text-primary transition-colors shrink-0 mt-0.5">
                <RotateCcw size={13} /> Restart
              </button>
              <button onClick={() => remove(a)} title="Delete archived list"
                className="opacity-0 group-hover/arc:opacity-100 group-focus-within/arc:opacity-100 focus-visible:opacity-100 group-data-[focused]/widget:opacity-100 transition-opacity text-muted-foreground hover:text-destructive shrink-0 mt-1"><Trash2 size={12} /></button>
            </div>
          ))}
        </div>
      )}
      <MoreRows more={arc.more} onClick={arc.showAll} />
    </Card>
  );
}

// ------------------------------------------------------------- small shared bits
function AddToListMenu({ lists, onPick }: { lists: ReadingList[]; onPick: (listName: string) => void }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button title="Add to a reading list" className="opacity-0 group-hover:opacity-100 group-data-[focused]/widget:opacity-100 focus-visible:opacity-100 transition-opacity text-muted-foreground hover:text-primary shrink-0 mt-0.5"><Plus size={14} /></button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-1.5">
        <div className="text-[10.5px] uppercase tracking-[0.08em] font-semibold text-muted-foreground px-2 pt-1.5 pb-1">Add to list</div>
        {lists.length === 0 && <div className="text-[12px] text-muted-foreground px-2 py-1.5">No lists yet.</div>}
        {lists.map((l) => (
          <button key={l.name} onClick={() => onPick(l.name)}
            className="w-full text-left text-[12.5px] px-2 py-1.5 rounded hover:bg-accent transition-colors truncate">{cleanName(l.name)}</button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

// dynamic "add a reading to this group" — search-as-you-type against your corpus +
// OpenAlex, with a manual-title fallback. Replaces the old bare-text AddItemRow.
type AddItemPayload = { title: string; read: string; citationPath?: string; doi?: string; needsDownload: boolean };
function AddItemSearch({ onAdd, onCancel }: { onAdd: (payload: AddItemPayload) => void; onCancel: () => void }) {
  const [title, setTitle] = useState("");
  const [read, setRead] = useState("");
  const submitManual = () => { if (title.trim()) onAdd({ title: title.trim(), read: read.trim(), needsDownload: false }); };
  return (
    <div className="flex flex-wrap items-center gap-2 mb-2 py-1">
      <ReadingSearchBox autoFocus className="flex-1 min-w-[160px]" value={title}
        onChangeText={setTitle}
        placeholder="Search your library or OpenAlex, or type a title…"
        onManualEnter={submitManual}
        onPickCorpus={(h) => onAdd({ title: h.stem, read: read.trim(), citationPath: h.rel, needsDownload: false })}
        onPickOpenAlex={(h) => onAdd({ title: h.title, read: read.trim(), doi: h.doi || undefined, needsDownload: true })} />
      <Input value={read} onChange={(e) => setRead(e.target.value)} placeholder="what to read"
        className="h-8 text-[12px] w-36 shrink-0" onKeyDown={(e) => { if (e.key === "Enter") submitManual(); if (e.key === "Escape") onCancel(); }} />
      <button onClick={submitManual} className="text-[12px] bg-primary text-primary-foreground rounded-md px-2.5 py-1.5 hover:opacity-90 shrink-0">Add</button>
      <button type="button" onClick={onCancel} data-knav-back aria-label="Cancel adding a reading" className="text-muted-foreground hover:text-foreground shrink-0"><X size={14} /></button>
    </div>
  );
}

// inline single-line editor — click the text (or the + placeholder) to edit, Enter saves
function EditableText({ value, placeholder, prefix, onSave, className = "" }:
{ value: string | null; placeholder?: string; prefix?: string; onSave: (v: string) => void; className?: string }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value || "");
  useEffect(() => { setDraft(value || ""); }, [value]);
  if (editing) {
    return (
      <Input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)}
        onBlur={() => { setEditing(false); if (draft !== (value || "")) onSave(draft); }}
        onKeyDown={(e) => { if (e.key === "Enter") { setEditing(false); if (draft !== (value || "")) onSave(draft); } if (e.key === "Escape") { setDraft(value || ""); setEditing(false); } }}
        className="h-6 text-[12px] py-0 my-0.5" />
    );
  }
  if (!value) {
    return <button onClick={() => setEditing(true)} className={`text-left text-muted-foreground/40 hover:text-muted-foreground transition-colors ${className}`}>{placeholder}</button>;
  }
  return (
    <button onClick={() => setEditing(true)} className={`text-left hover:opacity-70 transition-opacity ${className}`} title="Click to edit">
      {prefix && <span className="text-muted-foreground/60">{prefix}</span>}{value}
    </button>
  );
}

// inline multiline note editor (group / list "what to read" notes)
function EditableNote({ value, placeholder, onSave, className = "" }:
{ value: string | null; placeholder?: string; onSave: (v: string) => void; className?: string }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value || "");
  useEffect(() => { setDraft(value || ""); }, [value]);
  if (editing) {
    return (
      <textarea autoFocus value={draft} onChange={(e) => setDraft(e.target.value)}
        onBlur={() => { setEditing(false); if (draft !== (value || "")) onSave(draft); }}
        onKeyDown={(e) => { if (e.key === "Escape") { setDraft(value || ""); setEditing(false); } }}
        rows={2}
        className={`w-full text-[12px] leading-snug rounded-md border border-input bg-background px-2.5 py-1.5 resize-y ${className}`}
        placeholder={placeholder} />
    );
  }
  if (!value) {
    return <button onClick={() => setEditing(true)} className={`block text-left text-[12px] text-muted-foreground/40 hover:text-muted-foreground transition-colors ${className}`}>{placeholder}</button>;
  }
  return (
    <button onClick={() => setEditing(true)} title="Click to edit"
      className={`block text-left text-[12px] text-muted-foreground leading-snug hover:opacity-70 transition-opacity border-l-2 border-border/60 pl-2.5 ${className}`}>
      {value}
    </button>
  );
}

function MenuBtn({ children, icon, onClick, danger }: { children: React.ReactNode; icon: React.ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button onClick={onClick}
      className={`w-full text-left text-[12.5px] px-2 py-1.5 rounded transition-colors flex items-center gap-2 ${danger ? "text-destructive hover:bg-destructive/10" : "hover:bg-accent"}`}>
      {icon}{children}
    </button>
  );
}

function cleanName(n: string) {
  return n.replace(/\s*[—-]\s*20\d{2}-\d{2}-\d{2}\s*$/, "");
}
function SectionLabel({ children, icon, title }: { children: React.ReactNode; icon?: React.ReactNode; title?: string }) {
  return <div title={title} className="text-[11px] uppercase tracking-[0.09em] font-semibold text-muted-foreground mb-3 flex items-center gap-1.5">{icon}{children}</div>;
}
function Empty({ children }: { children: React.ReactNode }) {
  return <div className="text-[13px] text-muted-foreground py-2 leading-relaxed">{children}</div>;
}
function ReadingSkeleton() {
  return (
    <div>
      <div className="h-7 w-56 bg-muted/60 rounded animate-pulse mb-2" />
      <div className="h-4 w-80 bg-muted/60 rounded animate-pulse mb-7" />
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <div className="lg:col-span-2 space-y-5">
          {Array.from({ length: 4 }, (_, i) => <div key={i} className="h-[88px] bg-muted/40 rounded-xl animate-pulse" />)}
        </div>
        <div className="space-y-5">
          <div className="h-48 bg-muted/40 rounded-xl animate-pulse" />
          <div className="h-32 bg-muted/40 rounded-xl animate-pulse" />
        </div>
      </div>
    </div>
  );
}
