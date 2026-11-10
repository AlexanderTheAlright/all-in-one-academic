
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Card } from "@/components/ui/card";
import { WidgetFrame, useWidget, rowCap } from "@/components/ui/widget";
import { openWidgetFocus, standOn } from "@/lib/arrownav";
import { ArrowDown, ArrowUp, CalendarDays, Check, ChevronDown, ChevronRight, GripVertical, ListOrdered, ListPlus, X } from "lucide-react";
import {
  DndContext, MouseSensor, TouchSensor, KeyboardSensor, useSensor, useSensors, closestCenter,
} from "@dnd-kit/core";
import type { DragEndEvent } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy, arrayMove, sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type {
  ReadState, ReadingItem, ReadingList, ReadingNext as Next, ReadingNextItem, ReadingReadBy,
} from "@/lib/api";
import { relDue } from "@/lib/format";
import { openPrintBook } from "@/components/PrintBook";

// ------------------------------------------------------------- dates
const dayOf = (iso: string) => { const [y, m, d] = iso.split("-").map(Number); return new Date(y, (m || 1) - 1, d || 1); };
const shortDate = (iso: string) => dayOf(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const longDate = (iso: string) => dayOf(iso).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
const daysLabel = (n: number) =>
  n === 0 ? "today" : n === 1 ? "tomorrow" : n > 1 ? `${n} days` : n === -1 ? "1 day ago" : `${-n} days ago`;
// text tones that read on a card in both palettes: the derived inks, never the raw dots
const toneClass = (tone: "over" | "soon" | "ok") =>
  tone === "over" ? "text-[hsl(var(--danger))]" : tone === "soon" ? "text-[hsl(var(--due-soon-ink))]" : "text-muted-foreground";
const cleanList = (n: string) => n.replace(/\s*[—-]\s*20\d{2}-\d{2}-\d{2}\s*$/, "");

// ------------------------------------------------------------- shared chips + date field
const CHIP = "shrink-0 inline-flex items-center gap-1 rounded-full border border-border px-1.5 py-px text-[10.5px] leading-[1.35] nums whitespace-nowrap";

/** the read-by date, toned by how close it is */
export function DueChip({ date }: { date: string | null | undefined }) {
  const rel = relDue(date ?? null);
  if (!date || !rel) return null;
  return <span data-due-chip="" title={`Read by ${longDate(date)}`} className={`${CHIP} ${toneClass(rel.tone)}`}>{shortDate(date)}</span>;
}

/** the place in the read-next queue */
export function QueueChip({ n }: { n: number | null | undefined }) {
  if (!n) return null;
  return (
    <span data-queue-chip="" title={`In the queue at ${n}`} className={`${CHIP} text-muted-foreground`}>
      <ListOrdered size={10} className="shrink-0" />{n}
    </span>
  );
}

/** a read-by date: typed or picked, then Set; the x clears it */
export function DueField({ value, onSet, clearable }: {
  value: string | null | undefined; onSet: (date: string | null) => void; clearable?: boolean;
}) {
  const [draft, setDraft] = useState(value || "");
  useEffect(() => { setDraft(value || ""); }, [value]);
  const valid = /^20\d{2}-\d{2}-\d{2}$/.test(draft);
  const changed = draft !== (value || "");
  const commit = () => { if (valid && changed) onSet(draft); };
  return (
    <div className="flex items-center gap-1.5">
      <input type="date" value={draft} aria-label="Read-by date" title="Read-by date"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } }}
        className="h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-[12px] nums text-foreground [color-scheme:light] dark:[color-scheme:dark] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" />
      <button type="button" onClick={commit} disabled={!valid || !changed} title="Set the read-by date"
        className="shrink-0 text-[12px] bg-primary text-primary-foreground rounded-md px-2.5 py-1 hover:opacity-90 disabled:opacity-40">Set</button>
      <button type="button" onClick={() => onSet(null)} disabled={!(clearable ?? !!value)} title="Clear the read-by date"
        className="shrink-0 p-1 rounded text-muted-foreground hover:text-destructive disabled:opacity-30"><X size={13} /></button>
    </div>
  );
}

type Where = { list: string; gi: number; ii: number; it: ReadingItem };
const sigOf = (list: string, title: string, read: string | null | undefined) => `${list}\n${title}\n${read || ""}`;
function locate(lists: ReadingList[]): Map<string, Where> {
  const seen = new Map<string, number>(), out = new Map<string, Where>();
  for (const l of lists ?? []) (l.groups ?? []).forEach((g, gi) => (g.items ?? []).forEach((it, ii) => {
    const s = sigOf(l.name, it.title, it.read);
    const n = (seen.get(s) ?? 0) + 1;
    seen.set(s, n);
    out.set(`${s}#${n}`, { list: l.name, gi, ii, it });
  }));
  return out;
}
function whereOf(map: Map<string, Where>, n: ReadingNextItem): Where | undefined {
  const m = /#(\d+)$/.exec(n.key);
  const s = sigOf(n.list, n.title, n.read);
  return (m && map.get(`${s}#${m[1]}`)) || map.get(`${s}#1`);
}

// one order of keys becomes the whole view: positions in the queue and on the dated rows
function rebuild(n: Next, order: string[], gone?: string): Next {
  const all = new Map<string, ReadingNextItem>();
  n.readBy.forEach((d) => d.items.forEach((i) => all.set(i.key, i)));
  n.queue.forEach((i) => all.set(i.key, i));
  const keys = order.filter((k) => k !== gone && all.has(k));
  const pos = new Map(keys.map((k, i) => [k, i + 1]));
  const at = (i: ReadingNextItem): ReadingNextItem => ({ ...i, queue: pos.get(i.key) ?? null });
  const readBy = n.readBy.map((d) => ({ ...d, items: d.items.filter((i) => i.key !== gone).map(at) })).filter((d) => d.items.length > 0);
  return {
    queue: keys.map((k) => at(all.get(k)!)), readBy,
    behind: readBy.reduce((s, d) => s + (d.daysLeft < 0 ? d.items.length : 0), 0),
  };
}

type Scope = "queue" | "readby";
type Acts = {
  open: (n: ReadingNextItem) => void;
  read: (n: ReadingNextItem, scope: Scope) => void;
  move: (n: ReadingNextItem, dir: "up" | "down") => void;
  reorder: (from: string, to: string) => void;
  remove: (n: ReadingNextItem) => void;
  add: (n: ReadingNextItem) => void;
};
const EMPTY: Next = { queue: [], readBy: [], behind: 0 };
// a partial answer degrades to empty cards, never a crash
const whole = (n: Partial<Next> | null | undefined): Next =>
  ({ queue: n?.queue ?? [], readBy: n?.readBy ?? [], behind: n?.behind ?? 0 });

export function ReadingNext({ next, lists, reload, mark }: {
  next: Next | undefined; lists: ReadingList[]; reload: () => void;
  mark: (citationName: string, state: ReadState) => void;
}) {
  const given = next ?? EMPTY;
  const [local, setLocal] = useState<Next>(() => whole(given));
  const cur = useRef(local);
  const put = (n: Next) => { cur.current = n; setLocal(n); };
  // writes run one at a time; the server's answer replaces the local guess once the last lands
  const pending = useRef(0);
  const chain = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    let live = true;
    api.readingNext().then((n) => { if (live && pending.current === 0) put(whole(n)); }).catch(() => { /* keep what is shown */ });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [given]);
  // the lists catch up once the precomputed payload has rebuilt
  const settle = () => { reload(); window.setTimeout(reload, 2000); };
  const where = useMemo(() => locate(lists), [lists]);

  const root = useRef<HTMLDivElement>(null);
  // after a row moves or leaves, the keyboard stays on the row it was working with
  const want = useRef<{ scope: Scope; key: string; act: string } | null>(null);
  useLayoutEffect(() => {
    const w = want.current;
    if (!w || !root.current) return;
    want.current = null;
    const row = Array.from(root.current.querySelectorAll<HTMLElement>(`[data-next-in="${w.scope}"]`))
      .find((r) => r.dataset.nextRow === w.key);
    if (!row) return;
    const pick = (a: string) => row.querySelector<HTMLButtonElement>(`[data-act="${a}"]:not([disabled])`);
    standOn(pick(w.act) ?? (w.act === "up" ? pick("down") : w.act === "down" ? pick("up") : null) ?? pick("open"));
  }, [local]);

  const run = (guess: Next, call: () => Promise<unknown>) => {
    put(guess);
    pending.current++;
    chain.current = chain.current.then(call).then(() => undefined, () => { toast.error("Couldn't save"); })
      .then(async () => {
        pending.current--;
        if (pending.current > 0) return;
        try { put(whole(await api.readingNext())); } catch { /* the reload below still lands */ }
        settle();
      });
  };
  const keys = () => cur.current.queue.map((i) => i.key);
  // the row the keys go to when this one leaves its card
  const neighbour = (rows: ReadingNextItem[], key: string) => {
    const i = rows.findIndex((r) => r.key === key);
    return (rows[i + 1] ?? rows[i - 1])?.key;
  };

  const acts: Acts = {
    open: async (n) => {
      const w = whereOf(where, n);
      // a book owned in print opens the note-taker, as its list row does
      if (n.download === "owned" || w?.it.why?.startsWith("OWNED — ")) {
        const work = (w?.it.source || n.title).trim();
        const stem = w?.it.citationName;
        openPrintBook(stem ? { stem } : { prefill: { doi: w?.it.doi || "", title: work.replace(/^.*?\(\d{4}\)\s*-\s*/, "") } });
        return;
      }
      if (n.citation) { api.open(n.citation); return; }
      try {
        const r = await api.readingOp("item/make-citation", { list: n.list, title: n.title }) as { ok?: boolean; path?: string; error?: string };
        if (r?.ok && r.path) { api.open(r.path); reload(); }
        else if (n.pdf) api.open(n.pdf);
        else toast.error(r?.error || "Couldn't make the citation note");
      } catch { if (n.pdf) api.open(n.pdf); else toast.error("Couldn't make the citation note"); }
    },
    read: (n, scope) => {
      const w = whereOf(where, n);
      if (!w) { toast.error("Couldn't find it on its list"); return; }
      const was = cur.current;
      const at = n.queue;
      const rows = scope === "queue" ? was.queue : was.readBy.flatMap((d) => d.items);
      const nb = neighbour(rows, n.key);
      if (nb) want.current = { scope, key: nb, act: "open" };
      const ref = { list: w.list, group: w.gi, item: w.ii };
      run(rebuild(was, keys(), n.key), () => api.readingOp("toggle", { ...ref, state: "read" }).then(() => {
        if (w.it.citationName) mark(w.it.citationName, "read");
      }));
      toast("Marked read", {
        description: n.title.slice(0, 60),
        action: {
          label: "Undo",
          onClick: () => run(cur.current, async () => {
            await api.readingOp("toggle", { ...ref, state: n.status === "reading" ? "reading" : "unread" });
            if (w.it.citationName) mark(w.it.citationName, n.status === "reading" ? "reading" : "unread");
            if (at) await api.readingItemNext({ key: n.key }, true, at);
          }),
        },
      });
    },
    move: (n, dir) => {
      const k = keys(), i = k.indexOf(n.key), j = dir === "up" ? i - 1 : i + 1;
      if (i < 0 || j < 0 || j >= k.length) return;
      const order = arrayMove(k, i, j);
      want.current = { scope: "queue", key: n.key, act: dir };
      run(rebuild(cur.current, order), () => api.readingNextReorder(order));
    },
    reorder: (from, to) => {
      const k = keys(), i = k.indexOf(from), j = k.indexOf(to);
      if (i < 0 || j < 0 || i === j) return;
      const order = arrayMove(k, i, j);
      run(rebuild(cur.current, order), () => api.readingNextReorder(order));
    },
    remove: (n) => {
      const nb = neighbour(cur.current.queue, n.key);
      if (nb) want.current = { scope: "queue", key: nb, act: "open" };
      run(rebuild(cur.current, keys().filter((k) => k !== n.key)), () => api.readingItemNext({ key: n.key }, false));
    },
    add: (n) => {
      want.current = { scope: "readby", key: n.key, act: "open" };
      run(rebuild(cur.current, [...keys().filter((k) => k !== n.key), n.key]), () => api.readingItemNext({ key: n.key }, true));
    },
  };

  return (
    <div ref={root} className="grid grid-cols-1 xl:grid-cols-2 gap-5 items-start">
      <WidgetFrame id="reading.queue" title="Queue">
        <QueueCard queue={local.queue} acts={acts} />
      </WidgetFrame>
      <WidgetFrame id="reading.readby" title="Read by">
        <ReadByCard readBy={local.readBy} acts={acts} />
      </WidgetFrame>
    </div>
  );
}

// ------------------------------------------------------------- shared row pieces
const CARD = "h-full group-data-[focused]/widget:h-auto group-data-[focused]/widget:min-h-full p-6 group-data-[size=xs]/widget:p-4";
const LABEL = "text-[11px] uppercase tracking-[0.09em] font-semibold text-muted-foreground mb-2 flex items-center gap-1.5";
const isCompact = (w: ReturnType<typeof useWidget>) => !!w && (w.size === "xs" || w.size === "sm");

function Act({ act, title, onClick, disabled, children }: {
  act: string; title: string; onClick: () => void; disabled?: boolean; children: React.ReactNode;
}) {
  return (
    <button type="button" data-act={act} title={title} aria-label={title} onClick={onClick} disabled={disabled}
      className="h-6 w-6 shrink-0 inline-flex items-center justify-center rounded text-muted-foreground hover:text-primary hover:bg-accent/60 transition-colors disabled:opacity-25 disabled:hover:bg-transparent disabled:hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50">
      {children}
    </button>
  );
}

// the title opens the note as a list row's title does; under it the Read scope and the list
function Words({ n, acts, lead }: { n: ReadingNextItem; acts: Acts; lead?: React.ReactNode }) {
  return (
    <div className="min-w-0 flex-1">
      <button type="button" data-knav-item="" data-act="open" onClick={() => acts.open(n)} title={n.title}
        className="block w-full text-left text-[13.5px] leading-snug line-clamp-2 hover:text-primary transition-colors rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/40 focus-visible:text-primary">
        {n.title}
      </button>
      <div className="mt-0.5 flex min-w-0 items-center gap-2 text-[11.5px] leading-snug text-muted-foreground">
        {lead}
        {n.read && <span className="min-w-0 max-w-[70%] shrink-0 truncate" title={`Read: ${n.read}`}>Read: {n.read}</span>}
        <span className="min-w-0 truncate text-[11px] opacity-80" title={n.list}>{cleanList(n.list)}</span>
      </div>
    </div>
  );
}

function More({ more, onAll }: { more: number; onAll: () => void }) {
  if (more <= 0) return null;
  return (
    <button type="button" onClick={(e) => { if (!openWidgetFocus(e.currentTarget)) onAll(); }} title="Open the full view"
      className="mt-2 text-[11.5px] text-muted-foreground hover:text-primary transition-colors nums">+{more} more</button>
  );
}
const fileOf = (n: ReadingNextItem) => ({
  "data-obsidian-file": n.pdf || n.citation || undefined,
  "data-obsidian-pair": n.pdf && n.citation ? n.citation : undefined,
});

// ------------------------------------------------------------- the queue
function QueueCard({ queue, acts }: { queue: ReadingNextItem[]; acts: Acts }) {
  const w = useWidget();
  const compact = isCompact(w);
  const [all, setAll] = useState(false);
  const shown = all ? queue : queue.slice(0, rowCap(w, 6, 10));
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
    // Space picks up and drops; Enter stays "open" for the arrow-key board
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space"] },
    }),
  );
  const onDragEnd = (e: DragEndEvent) => { if (e.over) acts.reorder(String(e.active.id), String(e.over.id)); };
  return (
    <Card className={CARD}>
      <div className={LABEL}><ListOrdered size={13} />Queue</div>
      {queue.length === 0 ? (
        <div className="text-[13px] text-muted-foreground py-2">Nothing queued.</div>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={shown.map((n) => n.key)} strategy={verticalListSortingStrategy}>
            <ol className="divide-y divide-border/40">
              {shown.map((n, i) => (
                <QueueRow key={n.key} n={n} pos={i + 1} last={i === queue.length - 1} compact={compact} acts={acts} />
              ))}
            </ol>
          </SortableContext>
        </DndContext>
      )}
      <More more={queue.length - shown.length} onAll={() => setAll(true)} />
    </Card>
  );
}

function QueueRow({ n, pos, last, compact, acts }: {
  n: ReadingNextItem; pos: number; last: boolean; compact: boolean; acts: Acts;
}) {
  const { setNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({ id: n.key });
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 };
  const chip = <DueChip date={n.due} />;
  return (
    <li ref={setNodeRef} style={style} data-next-in="queue" data-next-row={n.key} {...fileOf(n)}
      className="group/row relative min-w-0 flex items-start gap-2 py-2">
      <button type="button" {...attributes} {...listeners} title="Drag to reorder" aria-label="Drag to reorder" tabIndex={-1}
        className="absolute -left-4 top-2.5 cursor-grab active:cursor-grabbing touch-none text-muted-foreground/40 hover:text-muted-foreground opacity-0 group-hover/row:opacity-100 transition-opacity">
        <GripVertical size={13} />
      </button>
      <span data-pos="" className="w-5 shrink-0 pt-px text-right text-[12.5px] leading-snug nums text-muted-foreground">{pos}</span>
      <Words n={n} acts={acts} lead={compact ? chip : undefined} />
      {!compact && <span className="shrink-0 inline-flex h-6 items-center gap-1.5">{chip}</span>}
      <div className="shrink-0 flex items-center">
        <Act act="read" title="Mark read" onClick={() => acts.read(n, "queue")}><Check size={14} /></Act>
        <Act act="up" title="Move up" disabled={pos === 1} onClick={() => acts.move(n, "up")}><ArrowUp size={14} /></Act>
        <Act act="down" title="Move down" disabled={last} onClick={() => acts.move(n, "down")}><ArrowDown size={14} /></Act>
        <Act act="remove" title="Remove from the queue" onClick={() => acts.remove(n)}><X size={14} /></Act>
      </div>
    </li>
  );
}

// ------------------------------------------------------------- read-by dates
function ReadByCard({ readBy, acts }: { readBy: ReadingReadBy[]; acts: Acts }) {
  const w = useWidget();
  const [all, setAll] = useState(false);
  const [behindOpen, setBehindOpen] = useState(false);
  const behind = readBy.filter((d) => d.daysLeft < 0);
  const ahead = readBy.filter((d) => d.daysLeft >= 0);
  const nBehind = behind.reduce((s, d) => s + d.items.length, 0);
  const nAhead = ahead.reduce((s, d) => s + d.items.length, 0);
  // the tile shows the soonest rows; whole dates until the cap is spent
  let room = all ? Infinity : rowCap(w, 6, 10);
  const shown: ReadingReadBy[] = [];
  for (const d of ahead) {
    if (room <= 0) break;
    shown.push(d.items.length <= room ? d : { ...d, items: d.items.slice(0, room) });
    room -= d.items.length;
  }
  const nShown = shown.reduce((s, d) => s + d.items.length, 0);
  return (
    <Card className={CARD}>
      <div className={LABEL}><CalendarDays size={13} />Read by</div>
      {readBy.length === 0 && <div className="text-[13px] text-muted-foreground py-2">No read-by dates.</div>}
      {nBehind > 0 && (
        <div className="mb-3">
          <button type="button" onClick={() => setBehindOpen((o) => !o)} aria-expanded={behindOpen} data-behind=""
            title={behindOpen ? "Fold" : "Unfold"}
            className="flex items-center gap-1 text-[12.5px] font-medium text-muted-foreground hover:text-foreground transition-colors rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/40">
            {behindOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            Behind <span className="nums">({nBehind})</span>
          </button>
          {behindOpen && (
            <div className="mt-2 ml-1.5 border-l border-border/60 pl-3 space-y-3">
              {behind.map((d) => <DateBlock key={d.date} d={d} acts={acts} />)}
            </div>
          )}
        </div>
      )}
      <div className="space-y-3.5">
        {shown.map((d) => <DateBlock key={d.date} d={d} acts={acts} />)}
      </div>
      <More more={nAhead - nShown} onAll={() => setAll(true)} />
    </Card>
  );
}

function DateBlock({ d, acts }: { d: ReadingReadBy; acts: Acts }) {
  const tone = d.daysLeft < 0 ? "over" : d.daysLeft <= 3 ? "soon" : "ok";
  return (
    <section data-readby-date={d.date}>
      <div className="flex items-baseline gap-2">
        <h3 className="text-[12.5px] font-semibold tracking-tight">{longDate(d.date)}</h3>
        <span className={`text-[11.5px] nums ${toneClass(tone)}`}>{daysLabel(d.daysLeft)}</span>
      </div>
      <ul className="divide-y divide-border/40">
        {d.items.map((n) => (
          <li key={n.key} data-next-in="readby" data-next-row={n.key} {...fileOf(n)}
            className="group/row min-w-0 flex items-start gap-2 py-1.5">
            <Words n={n} acts={acts} />
            <div className="shrink-0 flex items-center gap-1">
              {n.queue
                ? <span className="inline-flex h-6 items-center"><QueueChip n={n.queue} /></span>
                : <Act act="add" title="Add to the queue" onClick={() => acts.add(n)}><ListPlus size={14} /></Act>}
              <Act act="read" title="Mark read" onClick={() => acts.read(n, "readby")}><Check size={14} /></Act>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
