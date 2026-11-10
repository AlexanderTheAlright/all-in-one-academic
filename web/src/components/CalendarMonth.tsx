
import { TASKS_BOARD } from "@/lib/paths";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { WidgetFrame, useWidget, rowCap } from "@/components/ui/widget";
import { cn } from "@/lib/utils";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ArrowRight, CalendarDays, CalendarRange, CheckCheck, ChevronDown, ChevronLeft, ChevronRight, Flag, Inbox as InboxIcon, Layers, LayoutGrid, Plus, Target, X } from "lucide-react";
import { toast } from "sonner";
import { useApi, usePersistent } from "@/lib/hooks";
import { api } from "@/lib/api";
import type { BoardProposal, Event, EvtCategory, KCard, ProjectPlan, TLItem } from "@/lib/api";
import { categoryColor, eventColor, chipStyle, fmtTime, prioColor, toneColor } from "@/lib/format";
import { isoAdd, isoToday, withDue } from "@/lib/taskline";
import { Chip, QuickAdd, TaskRow } from "@/components/calrows";
import { DayPanel } from "@/components/DayPanel";
import type { DayBundle } from "@/components/DayPanel";
import { BoardProposals } from "@/components/BoardProposals";
import { ApprovedProject, ProposedProject, StartPlan } from "@/components/ProposedProject";

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MASTER = TASKS_BOARD;

/* ------------------------------------------------------------------- facets */
export type Facet =
  | "events" | "tasks" | "proposals" | "overdue" | "floating";

const FACETS: { id: Facet; label: string; icon: ReactNode; hint: string }[] = [
  { id: "events",        label: "Events",        icon: <CalendarDays size={11} />, hint: "Calendar events" },
  { id: "tasks",         label: "Tasks",         icon: <CheckCheck size={11} />,   hint: "Dated cards from every board" },
  { id: "proposals",     label: "Proposals",     icon: <InboxIcon size={11} />,    hint: "Cards an agent wants on your board" },
  { id: "overdue",       label: "Overdue",       icon: <ArrowRight size={11} />,   hint: "The carryover strip above the grid" },
  { id: "floating",      label: "Floating",      icon: <Layers size={11} />,       hint: "Undated work you can pin to a day" },
];

const FACET_DEFAULTS: Record<Facet, boolean> = {
  events: true, tasks: true, proposals: true, overdue: true, floating: true,
};
const FACET_KEY = "cal-facets-v2";
function initialFacets(): Partial<Record<Facet, boolean>> {
  try {
    const raw = localStorage.getItem("cal-facets");
    const old = raw ? (JSON.parse(raw) as Partial<Record<Facet, boolean>>) : {};
    return { ...FACET_DEFAULTS, ...old };
  } catch { return FACET_DEFAULTS; }
}

const majorKeyEvent = (e: Event) => `e:${e.path}:${e.date}`;

/* ------------------------------------------------------- waiting on you strip */
// "project" is the new-plan form; "project:<slug>" is one proposed plan (several can wait)
type WaitId = "cards" | "project" | `project:${string}`;
type WaitRow = { id: WaitId; icon: ReactNode; label: string; detail: string };

function WaitingStrip({ rows, noPlan, strip, setStrip, card }: {
  rows: WaitRow[]; noPlan: boolean; strip: WaitId | null;
  setStrip: (s: WaitId | null) => void; card: (id: WaitId) => ReactNode;
}) {
  const w = useWidget();
  const focused = !!w?.focused;
  const side = focused && (w?.size === "lg" || w?.size === "xl");
  const shown: WaitId | null = strip ?? (focused ? (rows[0]?.id ?? null) : null);
  const title = rows.length > 0 ? "Waiting on you" : "Nothing waiting";
  const label = <span className="text-[10.5px] uppercase tracking-[0.1em] font-semibold text-muted-foreground/70 px-1">{title}</span>;
  const chips = rows.map((r) => {
    const on = shown === r.id;
    const back = strip === r.id;
    // an explicitly opened row is the way back out of its card (Escape collapses it)
    return (
      <button key={r.id} onClick={() => setStrip(back ? null : r.id)} aria-pressed={on}
        aria-expanded={on} data-knav-id={`strip-${r.id}`} {...(back ? { "data-knav-back": "" } : {})}
        className={`inline-flex items-center gap-1.5 border transition-colors ${side ? "w-full min-w-0 rounded-lg px-3 py-2.5 text-[12.5px]" : "rounded-full px-3 py-1 text-[12px]"} ${
          on ? "border-primary/60 bg-primary/5 text-foreground" : "border-border text-muted-foreground hover:text-foreground hover:border-primary/50"}`}>
        {r.icon}
        <span className={side ? "font-medium shrink-0" : "font-medium"}>{r.label}</span>
        {r.detail && <span className={side ? "text-muted-foreground nums truncate" : "text-muted-foreground nums"}>{r.detail}</span>}
        {on ? <ChevronDown size={11} className={side ? "ml-auto shrink-0" : undefined} /> : <ChevronRight size={11} className={side ? "ml-auto shrink-0" : undefined} />}
      </button>
    );
  });
  const plan = noPlan && (
    <button onClick={() => setStrip(strip === "project" ? null : "project")}
      title="Build a project plan here — no agent needed"
      aria-expanded={shown === "project"} data-knav-id="strip-new-project"
      {...(strip === "project" ? { "data-knav-back": "" } : {})}
      className={`inline-flex items-center gap-1 border px-2.5 text-[11.5px] transition-colors ${side ? "w-full rounded-lg py-2.5" : "ml-auto rounded-full py-1"} ${
        side && shown === "project" ? "border-primary/60 bg-primary/5 text-foreground" : "border-border text-muted-foreground hover:text-foreground hover:border-primary/50"}`}>
      <Plus size={11} /> Start a project plan
    </button>
  );
  const body = shown ? card(shown) : null;
  if (side) return (
    <Card className="p-4 border-dashed h-full min-h-0 grid grid-cols-[minmax(220px,1fr)_minmax(0,3fr)] gap-4">
      <div className="min-h-0 flex flex-col gap-1.5">{label}{chips}{plan}</div>
      <div className="min-h-0 overflow-y-auto tinybar pr-1 [&>*:last-child]:mb-0 [&_.mb-6]:mb-0">{body}</div>
    </Card>
  );
  return (
    <Card className="p-2.5 border-dashed min-h-full">
      <div className="flex items-center gap-1.5 flex-wrap">{label}{chips}{plan}</div>
      {body && <div className="mt-3 pt-3 border-t border-border/50 [&>*:last-child]:mb-0 [&_.mb-6]:mb-0">{body}</div>}
    </Card>
  );
}

/* -------------------------------------------------------------- date helpers */
const isoOf = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/* ============================================================================ */
export function CalendarMonth({ openBoard, go }: {
  openBoard: (path: string, title: string, isPaper: boolean) => void;
  go?: (v: string) => void;
}) {
  const [cursor, setCursor] = useState<Date>(() => {
    const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(1); return d;
  });
  const [storedFacets, setStoredFacets] = usePersistent<Partial<Record<Facet, boolean>>>(FACET_KEY, useMemo(initialFacets, []));
  const [projectFilter, setProjectFilter] = usePersistent<string>("cal-project-filter", "");
  const [mutedCats, setMutedCats] = usePersistent<string[]>("cal-muted-cats", []);
  const toggleCat = (c: string) =>
    setMutedCats(mutedCats.includes(c) ? mutedCats.filter((x) => x !== c) : [...mutedCats, c]);
  const facets = useMemo(() => ({ ...FACET_DEFAULTS, ...storedFacets }), [storedFacets]);
  const toggleFacet = (f: Facet) => setStoredFacets({ ...facets, [f]: !facets[f] });

  const [openDay, setOpenDay] = useState<{ iso: string; addEvent?: boolean } | null>(null);
  const [pinDay, setPinDay] = useState<string | null>(null);
  const [floatOpen, setFloatOpen] = useState(false);
  const [busyRaw, setBusyRaw] = useState<string | null>(null);
  // the approved plan whose card is open (a plan milestone chip or day-panel row opens it)
  const [openPlan, setOpenPlan] = useState<string | null>(null);

  // Pull a wide window so navigating months doesn't refetch on every arrow.
  const monthIso = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}`;
  const evts = useApi(() => api.events(
    isoOf(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1)),
    isoOf(new Date(cursor.getFullYear(), cursor.getMonth() + 2, 0)),
  ), [monthIso]);
  const tl = useApi(() => api.timeline(), [], 60_000);
  const master = useApi(() => api.board(MASTER), [], 60_000);
  const props = useApi(() => api.boardProposals(), [], 60_000);
  const projects = useApi(() => api.projects(), [], 300_000);
  const plans = useApi(() => api.projectPlans().catch(() => [] as ProjectPlan[]), [], 60_000);
  const proposedPlans = useMemo(() => (plans.data || [])
    .filter((p) => p.status === "proposed" && p.slug)
    .sort((a, b) => (a.generated || "").localeCompare(b.generated || "")), [plans.data]);
  const [strip, setStrip] = useState<WaitId | null>(null);
  // approved plans by slug: their milestones reach the grid as deadline files
  // (project: <slug>) or ledger rows (path commitment:plan:<slug>:<milestone>), and either opens the card
  const approvedPlans = useMemo(() => new Map((plans.data || [])
    .filter((p) => p.status === "finalized" && p.slug).map((p) => [p.slug!, p])), [plans.data]);
  const planFor = (e: Event): string | null => {
    if (e.project && approvedPlans.has(e.project)) return e.project;
    const m = /^commitment:plan:([^:]+):/.exec(e.path || "");
    return m && approvedPlans.has(m[1]) ? m[1] : null;
  };

  const today = isoToday();
  const cats: EvtCategory[] = (evts.data?.categories || []).map((c) => c.key);
  // a virtual category (commitments, fed from the planning ledger) is never a choice for a new event
  const addCats: EvtCategory[] = (evts.data?.categories || []).filter((c) => !c.virtual).map((c) => c.key);

  const reloadAll = () => {
    evts.reload(); tl.reload(); master.reload(); props.reload();
  };
  const reloadStrip = () => { props.reload(); plans.reload(); };
  const settled = () => { reloadAll(); reloadStrip(); setStrip(null); };

  /* -------------------------------------------------------------- mutations */
  const toggleTask = async (it: { path: string; raw?: string }) => {
    if (!it.raw) return;
    setBusyRaw(it.raw);
    try { await api.boardOp(it.path, "toggle", { raw: it.raw }); tl.reload(); master.reload(); }
    catch { toast.error("Couldn't tick that off — reload and try again"); }
    finally { setBusyRaw(null); }
  };
  const rescheduleTask = async (it: { path: string; raw?: string }, iso: string | null) => {
    if (!it.raw) return;
    setBusyRaw(it.raw);
    try {
      await api.boardOp(it.path, "edit", { raw: it.raw, body: withDue(it.raw, iso) });
      tl.reload(); master.reload();
      toast.success(iso === null ? "Unpinned — it's floating now" : iso === today ? "Moved to today" : `Moved to ${iso}`);
    } catch { toast.error("Couldn't reschedule"); }
    finally { setBusyRaw(null); }
  };
  // pinning a floating card IS the date edit — same write as a reschedule, from
  // the other end (an undated master-board card instead of a dated timeline item)
  const rescheduleTaskCard = (c: KCard, iso: string | null) =>
    rescheduleTask({ path: MASTER, raw: c.raw }, iso);
  const addCard = async (card: string, due: string | null) => {
    const lane = due && due <= today ? "TODAY" : "BACKLOG";
    const tagged = selectedProject && !card.includes(`#${selectedProject.slug}`) ? `${card} #${selectedProject.slug}` : card;
    try {
      await api.boardOp(MASTER, "add", { lane, text: tagged });
      tl.reload(); master.reload();
      toast.success(due ? `Added to ${due === today ? "today" : due}` : "Added to floating");
    } catch { toast.error("Couldn't add the task"); }
  };

  const projectChoices = useMemo(() => {
    const byKey = new Map<string, { key: string; slug: string; path: string; name: string }>();
    for (const p of projects.data || []) {
      const slug = p.slug || p.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      byKey.set(slug, { key: slug, slug, path: p.path, name: p.name });
    }
    // dismissed and archived plans are hidden from the Calendar (Insights keeps them)
    for (const p of plans.data || []) if (p.slug && p.status !== "dismissed" && p.status !== "archived") {
      const prev = byKey.get(p.slug);
      byKey.set(p.slug, { key: p.slug, slug: p.slug, path: p.boardPath || prev?.path || "", name: p.title || prev?.name || p.slug });
    }
    return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [projects.data, plans.data]);
  const selectedProject = projectChoices.find((p) => p.key === projectFilter) || null;
  const belongsTask = (t: TLItem) => !selectedProject || t.path === selectedProject.path || (t.tags || []).includes(selectedProject.slug);
  const belongsEvent = (e: Event) =>
    (!selectedProject || e.project === selectedProject.slug || (e.tags || []).includes(selectedProject.slug))
    && !mutedCats.includes(e.category);
  const projectHue = (slug: string) => { let n = 0; for (const ch of slug) n = (n * 31 + ch.charCodeAt(0)) % 360; return n; };

  /* ---------------------------------------------------------------- derived */
  const grid = useMemo(() => {
    const first = new Date(cursor);
    const start = new Date(first); start.setDate(1 - first.getDay());
    const days: { iso: string; date: Date; inMonth: boolean }[] = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(start); d.setDate(start.getDate() + i);
      days.push({ iso: isoOf(d), date: d, inMonth: d.getMonth() === cursor.getMonth() });
    }
    return days;
  }, [cursor]);

  const allEvents: Event[] = evts.data?.events || [];
  const evByDate = useMemo(() => {
    const m = new Map<string, Event[]>();
    allEvents.filter(belongsEvent).forEach((e) => {
      const list = m.get(e.date) || [];
      list.push(e); m.set(e.date, list);
      // a spanning event shows on every day it covers
      if (e.endDate && e.endDate > e.date) {
        const cur = new Date(e.date + "T00:00:00"); cur.setDate(cur.getDate() + 1);
        const end = new Date(e.endDate + "T00:00:00");
        while (cur <= end) {
          const k = isoOf(cur);
          const l = m.get(k) || []; l.push(e); m.set(k, l);
          cur.setDate(cur.getDate() + 1);
        }
      }
    });
    for (const list of m.values()) {
      list.sort((a, b) => (a.allDay ? "00:00" : a.startTime || "00:00").localeCompare(b.allDay ? "00:00" : b.startTime || "00:00"));
    }
    return m;
  }, [allEvents, selectedProject]);

  const items: TLItem[] = tl.data || [];
  const tlByDate = useMemo(() => {
    const m = new Map<string, TLItem[]>();
    const rank = (p: string | null) => (p === "high" ? 0 : p === "medium" ? 1 : p === "low" ? 3 : 2);
    items.filter(belongsTask).forEach((t) => { const l = m.get(t.due) || []; l.push(t); m.set(t.due, l); });
    for (const list of m.values()) list.sort((a, b) => rank(a.priority) - rank(b.priority));
    return m;
  }, [items, selectedProject]);

  const pending: BoardProposal[] = useMemo(
    () => (props.data?.proposals || []).filter((p) => p.status === "pending"), [props.data]);
  const propByDate = useMemo(() => {
    const m = new Map<string, BoardProposal[]>();
    pending.forEach((p) => { if (!p.due) return; const l = m.get(p.due) || []; l.push(p); m.set(p.due, l); });
    return m;
  }, [pending]);
  const undatedProposals = pending.filter((p) => !p.due).length;

  const overdue = useMemo(
    () => items.filter((i) => i.due < today).sort((a, b) => a.due.localeCompare(b.due)), [items, today]);
  const floating = useMemo(() => {
    const out: { lane: string; card: KCard }[] = [];
    for (const l of master.data?.lanes || []) {
      if (l.name === "DONE" || l.name === "Archive") continue;
      for (const c of l.cards) if (!c.done && !c.due) out.push({ lane: l.name, card: c });
    }
    return out;
  }, [master.data]);
  const doneByDate = useMemo(() => {
    const m = new Map<string, KCard[]>();
    for (const l of master.data?.lanes || [])
      for (const c of l.cards) if (c.done && c.due) { const k = m.get(c.due) || []; k.push(c); m.set(c.due, k); }
    return m;
  }, [master.data]);

  /* the bundle the day panel renders — assembled here so the panel never fetches */
  const bundle: DayBundle = useMemo(() => {
    const iso = openDay?.iso;
    if (!iso) return { events: [], tasks: [], proposals: [], done: [] };
    return {
      events: evByDate.get(iso) || [],
      tasks: tlByDate.get(iso) || [],
      proposals: propByDate.get(iso) || [],
      done: doneByDate.get(iso) || [],
    };
  }, [openDay, evByDate, tlByDate, propByDate, doneByDate]);

  const majorByWeek = useMemo(() => {
    type Cand = { key: string; date: string; rank: number; title: string };
    const best = new Map<string, Cand>();
    const offer = (c: Cand) => {
      const d = new Date(c.date + "T00:00:00"); d.setDate(d.getDate() - d.getDay());
      const wk = isoOf(d);
      const cur = best.get(wk);
      if (!cur || c.rank < cur.rank || (c.rank === cur.rank && c.date < cur.date)) best.set(wk, c);
    };
    for (const [iso, list] of evByDate) for (const e of list) {
      if (e.completed || e.date !== iso) continue;
      if (e.category === "commitments") offer({ key: majorKeyEvent(e), date: iso, rank: 0, title: e.title });
      else if (e.category === "deadlines") offer({ key: majorKeyEvent(e), date: iso, rank: 1, title: e.title });
    }
    const byDay = new Map<string, Cand>();
    for (const c of best.values()) byDay.set(c.date, c);
    return byDay;
  }, [evByDate]);

  /* what one day carries, layer by layer — the month cells, the two-week strip and
     the agenda all draw from this, so a facet switched off is off everywhere */
  const dotsFor = (iso: string) => (facets.tasks ? tlByDate.get(iso) || [] : []);
  const chipsFor = (iso: string, big = false, tight = false): ChipItem[] => {
    // a narrow strip column truncates (the chip's title carries the rest) rather than breaking words
    const clamp = tight ? "truncate" : "line-clamp-2 [overflow-wrap:anywhere]";
    const major = majorByWeek.get(iso) || null;
    const all = evByDate.get(iso) || [];
    const events = all.filter((e) => facets.events || (!!major && majorKeyEvent(e) === major.key));
    const tasks = dotsFor(iso);
    const proposals = facets.proposals ? propByDate.get(iso) || [] : [];
    const t = big ? "text-[11.5px] leading-snug px-2 py-0.5" : "text-[10px] leading-tight px-1.5 py-0.5";
    const out: ChipItem[] = [];
    // the week's major item: first in its day's stack (never under "+N more"), bold,
    // flagged, with a ring in its own ink so it reads at a glance in both palettes
    const majorCls = "font-semibold ring-1 ring-inset ring-current";
    const majorTip = (s: string) => `Major this week: ${s}`;
    events.forEach((e, i) => {
      const isMajor = !!major && majorKeyEvent(e) === major.key;
      const plan = planFor(e);
      const tip = `${e.title}${e.startTime ? " · " + fmtTime(e.startTime) : ""}${e.completed ? " · resolved" : ""}${plan ? ` · ${approvedPlans.get(plan)?.title || plan}` : ""}`;
      // a plan milestone opens its plan's card (mouse); from the keyboard, Enter opens the
      // day and the milestone's row there opens the same card
      const planProps = plan ? {
        role: "button", tabIndex: -1, "data-knav-skip": "",
        onClick: (ev: ReactMouseEvent) => { ev.stopPropagation(); setOpenPlan(plan); },
      } : {};
      const chip: ChipItem = { key: `e${i}:${e.title}`, node: (
      <span title={isMajor ? majorTip(tip) : tip} {...planProps}
        className={`flex items-center gap-1 min-w-0 ${t} rounded nums ${e.completed ? "opacity-45 line-through" : ""} ${isMajor ? majorCls : ""} ${plan ? "cursor-pointer hover:brightness-95" : ""}`}
        // an event's own e.color is not vetted by anything, so the chip derives a readable
        // shade of it rather than trusting it: same hue, lightness that carries the text
        style={chipStyle(eventColor(e))}>
        {isMajor ? <Flag size={8} className="shrink-0" aria-label="Major this week" />
          : plan ? <Target size={8} className="shrink-0" aria-label="Project plan milestone" /> : null}
        {/* clamp on an inner span: on the padded chip a third line peeks through */}
        <span className={clamp}>{!e.allDay && e.startTime ? fmtTime(e.startTime) + " " : ""}{e.title}</span>
      </span>) };
      if (isMajor) out.unshift(chip); else out.push(chip);
    });
    tasks.forEach((tk, i) => out.push({ key: `t${i}:${tk.text}`, node: (
      <span title={`${tk.text} · ${tk.board}`}
        className={`${t} rounded text-foreground/90 flex items-center gap-1 min-w-0`}
        style={selectedProject ? { background: `hsl(${projectHue(selectedProject.slug)} 45% 88%)` } : { background: "hsl(var(--secondary) / 0.7)" }}>
        <span className="w-1 h-2.5 rounded-full shrink-0" style={{ background: prioColor(tk.priority) }} />
        <span className={clamp}>{tk.text}</span>
      </span>) }));
    proposals.forEach((p, i) => out.push({ key: `p${i}:${p.text}`, node: (
      <span title={`Proposed: ${p.text}${p.source ? " (by " + p.source + ")" : ""}`}
        className={`flex min-w-0 ${t} rounded border border-dashed border-muted-foreground/50 text-muted-foreground italic`}>
        <span className={clamp}>{p.text}</span>
      </span>) }));
    return out;
  };

  const monthLabel = cursor.toLocaleString("en", { month: "long", year: "numeric" });
  const shift = (n: number) => { const c = new Date(cursor); c.setMonth(c.getMonth() + n); setCursor(c); };
  const goToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(1); setCursor(d); };

  return (
    <div>
      {/* ---- header: the month, and everything that acts on the whole surface -- */}
      <header className="flex items-end justify-between mb-4 gap-x-4 gap-y-2 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[12px] text-muted-foreground uppercase tracking-[0.1em] font-semibold mb-1">
            <CalendarRange size={14} className="opacity-60" /> Plan
          </div>
          <h1 className="text-[26px] font-semibold tracking-tight nums w-fit"
            title="One surface: every layer lives on this grid, and the day panel is where you edit it. Everything mirrors straight into Obsidian — these are the same vault files.">
            {monthLabel}
          </h1>
          <p className="text-muted-foreground text-[12.5px] mt-1 nums">
            {allEvents.length} events · {items.length} dated tasks
            {pending.length > 0 && ` · ${pending.length} proposed`}
            {" "}· click a day to open it
          </p>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap min-w-0">
          <label className="sr-only" htmlFor="calendar-project">Filter calendar by project</label>
          <select id="calendar-project" value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)}
            className="h-9 min-w-0 max-w-[280px] rounded-md border border-border bg-background px-3 text-[12.5px] text-foreground focus:outline-none focus:border-primary">
            <option value="">All projects</option>
            {projectChoices.map((p) => <option key={p.key} value={p.key}>{p.name}</option>)}
          </select>
          <Button variant="outline" size="sm" aria-label="Previous month" onClick={() => shift(-1)}><ChevronLeft size={14} /></Button>
          <Button variant="outline" size="sm" onClick={goToday}>Today</Button>
          <Button variant="outline" size="sm" aria-label="Next month" onClick={() => shift(1)}><ChevronRight size={14} /></Button>
        </div>
      </header>

      {/* ---- the grid: one widget that lays itself out by its own size --------- */}
      <WidgetFrame id="calendar.month" title={monthLabel}>
        <MonthWidget grid={grid} today={today} monthLabel={monthLabel}
          chipsFor={chipsFor} dotsFor={dotsFor}
          onOpen={(iso, addEvent) => { setPinDay(iso); setOpenDay({ iso, addEvent }); }}
          selected={pinDay}
          shift={shift} goToday={goToday} facets={facets} toggleFacet={toggleFacet} />
      </WidgetFrame>

      <div className="mt-6">
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        {facets.floating && <button onClick={() => setFloatOpen(true)} className="inline-flex items-center gap-1.5 rounded-full border border-border px-3.5 py-2 text-[12.5px] text-muted-foreground hover:text-foreground"><Layers size={13} /> Floating{floating.length > 0 && <span className="nums text-[10.5px] bg-secondary px-1.5 py-0.5 rounded-full">{floating.length}</span>}</button>}
        <button onClick={() => openBoard(MASTER, "Planning", false)} className="inline-flex items-center gap-1.5 rounded-full border border-border px-3.5 py-2 text-[12.5px] text-muted-foreground hover:text-foreground"><LayoutGrid size={13} /> Full board</button>
      </div>
      {/* ---- facets: what the grid is allowed to show, remembered ------------- */}
      <div className="flex items-center gap-1.5 mb-5 flex-wrap">
        <span className="text-[10.5px] uppercase tracking-[0.1em] font-semibold text-muted-foreground/70 mr-1">Layers</span>
        {FACETS.map((f) => {
          const on = facets[f.id];
          return (
            <button key={f.id} onClick={() => toggleFacet(f.id)} title={f.hint}
              aria-pressed={on}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-full border text-[11.5px] transition-colors ${
                on ? "text-foreground border-foreground/30 bg-secondary/40" : "text-muted-foreground border-border hover:text-foreground"}`}>
              {f.icon} {f.label}
            </button>
          );
        })}
      </div>

      {facets.events && cats.length > 0 && (
        <div className="flex items-center gap-1.5 mb-5 flex-wrap">
          <span className="text-[10.5px] uppercase tracking-[0.1em] font-semibold text-muted-foreground/70 mr-1">Kinds</span>
          {cats.map((c) => {
            const on = !mutedCats.includes(c);
            return (
              <button key={c} onClick={() => toggleCat(c)} aria-pressed={on}
                title={on ? `${c} — click to hide from the calendar` : `${c} — hidden; click to show`}
                className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-full border text-[11.5px] capitalize transition-colors ${
                  on ? "text-foreground border-foreground/30 bg-secondary/40" : "text-muted-foreground/60 border-border hover:text-foreground line-through decoration-muted-foreground/40"}`}>
                <span className="w-2 h-2 rounded-full shrink-0" style={{ background: on ? categoryColor(c as EvtCategory) : "transparent", border: on ? "none" : "1.5px solid hsl(var(--muted-foreground) / 0.5)" }} />
                {c}
              </button>
            );
          })}
          {mutedCats.length > 0 && (
            <button onClick={() => setMutedCats([])}
              className="text-[11.5px] text-muted-foreground hover:text-foreground underline ml-1">
              show all
            </button>
          )}
        </div>
      )}

      {(() => {
        const rows: WaitRow[] = [];
        if (pending.length > 0) rows.push({
          id: "cards", icon: <InboxIcon size={12} />,
          label: `${pending.length} proposed card${pending.length === 1 ? "" : "s"}`,
          detail: `${pending.length - undatedProposals} on the grid${undatedProposals > 0 ? ` · ${undatedProposals} undated` : ""}`,
        });
        // one row per proposed plan, each opening its own card by slug
        for (const pl of proposedPlans) rows.push({
          id: `project:${pl.slug}`, icon: <Target size={12} />, label: "Proposed project",
          detail: pl.title || pl.slug || "",
        });
        // "Start a project plan" is always on offer: a new plan never displaces another
        const noPlan = !!plans.data;
        if (rows.length === 0 && !noPlan) return null;
        // a row that has gone (approved, dismissed) no longer holds the strip open
        const live = strip && (strip === "project" || rows.some((r) => r.id === strip)) ? strip : null;
        return (
          <WidgetFrame id="calendar.waiting" title={rows.length > 0 ? "Waiting on you" : "Nothing waiting"} className="mb-4">
            <WaitingStrip rows={rows} noPlan={noPlan} strip={live} setStrip={setStrip}
              card={(id) => id === "cards" ? <BoardProposals onAccepted={() => { reloadAll(); props.reload(); }} />
                : id === "project" ? <StartPlan onCancel={() => setStrip(null)}
                    onCreated={(slug) => { plans.reload(); setStrip(slug ? `project:${slug}` : null); }} />
                : <ProposedProject key={id} slug={id.slice("project:".length)}
                    onApproved={settled} onChanged={() => plans.reload()} />} />
          </WidgetFrame>
        );
      })()}

      {/* ---- overdue: work never rots silently -------------------------------- */}
      {facets.overdue && overdue.length > 0 && (
        <WidgetFrame id="calendar.carried" title="Carried over" className="mb-5">
          <Carried overdue={overdue} busyRaw={busyRaw} openBoard={openBoard} go={go}
            onAllToday={async () => { for (const it of overdue) await rescheduleTask(it, today); }}
            onToggle={toggleTask} onReschedule={rescheduleTask} />
        </WidgetFrame>
      )}

      {facets.floating && (
        <WidgetFrame id="calendar.floating" title="Floating" className="mb-5">
          <FloatingStrip floating={floating} day={pinDay ?? today} today={today}
            busyRaw={busyRaw} onPin={rescheduleTaskCard} onPickDay={setPinDay}
            onAdd={addCard} openBoard={openBoard} onOpenAll={() => setFloatOpen(true)} />
        </WidgetFrame>
      )}

      </div>

      {/* ---- the day panel --------------------------------------------------- */}
      <DayPanel
        iso={openDay?.iso ?? null}
        autoAddEvent={!!openDay?.addEvent}
        onClose={() => setOpenDay(null)}
        bundle={bundle}
        floating={facets.floating ? floating : []}
        cats={addCats}
        busyRaw={busyRaw}
        onToggleTask={toggleTask}
        onRescheduleTask={rescheduleTask}
        onAddCard={addCard}
        onPinFloating={(c, day) => rescheduleTask({ path: MASTER, raw: c.raw }, day)}
        reload={reloadAll}
        openBoard={openBoard}
        go={go}
        planFor={(e) => { const s = planFor(e); return s ? { slug: s, title: approvedPlans.get(s)?.title || s } : null; }}
        onOpenPlan={(s) => { setOpenDay(null); setOpenPlan(s); }}
        project={selectedProject ? { slug: selectedProject.slug, name: selectedProject.name } : null} />

      {/* ---- an approved plan's card: opened from its milestones on the grid ---- */}
      <Sheet open={!!openPlan && approvedPlans.has(openPlan)} onOpenChange={(o) => { if (!o) setOpenPlan(null); }}>
        <SheetContent side="right" className="w-full sm:max-w-[620px] p-0 gap-0 flex flex-col">
          <SheetHeader className="sr-only">
            <SheetTitle>Project plan</SheetTitle>
          </SheetHeader>
          <div className="flex-1 min-h-0 overflow-y-auto px-6 py-6">
            {openPlan && approvedPlans.get(openPlan) && (
              <ApprovedProject plan={approvedPlans.get(openPlan)!} items={items} openBoard={openBoard}
                onArchived={() => { setOpenPlan(null); plans.reload(); reloadAll(); }} />
            )}
          </div>
        </SheetContent>
      </Sheet>

      {/* ---- the floating drawer -------------------------------------------- */}
      {floatOpen && (
        <FloatingDrawer floating={floating} onClose={() => setFloatOpen(false)}
          busyRaw={busyRaw} today={today}
          onPin={(c, iso) => rescheduleTask({ path: MASTER, raw: c.raw }, iso)}
          onAdd={addCard} openBoard={openBoard} />
      )}

    </div>
  );
}

/* ------------------------------------------------------------- floating strip */

const pinLabel = (iso: string, today: string) => {
  if (iso === today) return "today";
  if (iso === isoAdd(today, 1)) return "tomorrow";
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
};

function FloatingStrip({ floating, day, today, busyRaw, onPin, onPickDay, onAdd, openBoard, onOpenAll }: {
  floating: { lane: string; card: KCard }[];
  day: string; today: string; busyRaw: string | null;
  onPin: (c: KCard, iso: string | null) => void;
  onPickDay: (iso: string) => void;
  onAdd: (card: string, due: string | null) => Promise<void>;
  openBoard: (path: string, title: string, isPaper: boolean) => void;
  onOpenAll: () => void;
}) {
  const w = useWidget();
  const cap = rowCap(w, 8);
  const shown = floating.slice(0, cap);
  const label = pinLabel(day, today);
  return (
    <Card className="p-5">
      <div className="flex items-center gap-2 flex-wrap mb-3">
        <span className="text-[11px] uppercase tracking-[0.09em] font-semibold text-muted-foreground flex items-center gap-1.5"
          title="Undated work — no date yet, so it never reaches Today. Click a day on the grid, then pin the ones that can be done then.">
          <Layers size={13} /> Floating · {floating.length}
        </span>
        <span className="ml-auto flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
          <span>Pinning to</span>
          <input type="date" value={day} aria-label="The day the pin buttons target"
            title="The day each Pin button targets — clicking a cell on the grid sets this"
            onChange={(e) => { if (e.target.value) onPickDay(e.target.value); }}
            className="h-7 bg-secondary/40 border border-border rounded-md px-1.5 text-[11.5px] nums focus:outline-none focus:border-primary" />
        </span>
      </div>

      <div className="mb-4"><QuickAdd defaultDue={null} onAdd={onAdd} /></div>

      {floating.length === 0 ? (
        <p className="text-[13px] text-muted-foreground italic">Nothing floating — everything has its day.</p>
      ) : (
        <div className="grid gap-1.5">
          {shown.map(({ lane, card: c }) => (
            <div key={c.raw}
              className={`flex items-center gap-2.5 rounded-lg border border-border bg-card/50 px-3 py-2 ${busyRaw === c.raw ? "opacity-50" : ""}`}>
              <span className="w-1 self-stretch rounded-full shrink-0" style={{ background: prioColor(c.priority) }} />
              <span className="flex-1 min-w-0 text-[13px] leading-snug truncate" title={c.text}>{c.text}</span>
              <span className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground/60 shrink-0 hidden sm:inline">{lane}</span>
              <Chip onClick={() => onPin(c, day)} title={`Pin "${c.text}" to ${day}`}>Pin to {label}</Chip>
            </div>
          ))}
        </div>
      )}

      {(floating.length > shown.length || floating.length > 0) && (
        <div className="mt-3 flex items-center gap-3">
          {floating.length > shown.length && (
            <button onClick={onOpenAll} className="text-[12px] text-muted-foreground hover:text-foreground underline transition-colors">
              {floating.length - shown.length} more — open the full list
            </button>
          )}
          <button onClick={() => openBoard(MASTER, "Planning", false)}
            className="text-[12px] text-muted-foreground hover:text-foreground underline transition-colors">
            Open the full board
          </button>
        </div>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------ floating drawer */

function FloatingDrawer({ floating, onClose, onPin, onAdd, busyRaw, today, openBoard }: {
  floating: { lane: string; card: KCard }[]; onClose: () => void;
  onPin: (c: KCard, iso: string | null) => void;
  onAdd: (card: string, due: string | null) => Promise<void>;
  busyRaw: string | null; today: string;
  openBoard: (path: string, title: string, isPaper: boolean) => void;
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.key !== "Escape") return;
      // the first Escape from a field being typed in only stops editing (the arrow
      // layer re-arms it); from anywhere else in the drawer it closes
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA") && !t.hasAttribute("data-knav-armed")) return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
  const [dateFor, setDateFor] = useState<string | null>(null);
  const groups = [
    { name: "INBOX", label: "Inbox", icon: <InboxIcon size={11} /> },
    { name: "BACKLOG", label: "Backlog", icon: <Layers size={11} /> },
  ];
  const other = floating.filter((f) => !groups.some((g) => g.name === f.lane));
  return createPortal(
    <div role="dialog" aria-modal="true" aria-label="Floating work" data-knav-modal
      className="fixed top-0 right-0 bottom-0 z-50 w-[400px] max-w-[92vw] bg-background border-l border-border shadow-2xl flex flex-col animate-in slide-in-from-right duration-200">
      <div className="shrink-0 flex items-center justify-between px-5 py-4 border-b border-border/60">
        <div className="text-[11px] uppercase tracking-[0.09em] font-semibold text-muted-foreground flex items-center gap-1.5"
          title="Unpinned work — no date yet, so it never reaches Today. Pin each one when its moment comes.">
          <Layers size={13} /> Floating · {floating.length}
        </div>
        <button onClick={onClose} aria-label="Close" title="Close" data-knav-back
          className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-[12px] text-muted-foreground hover:text-foreground hover:border-primary/50 transition-colors">
          <X size={13} /> <kbd className="text-[10px] opacity-60">esc</kbd>
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
        <div className="mb-5"><QuickAdd defaultDue={null} onAdd={onAdd} /></div>
        {[...groups.map((g) => ({ ...g, rows: floating.filter((f) => f.lane === g.name) })),
          ...(other.length ? [{ name: "_other", label: "Elsewhere", icon: <Layers size={11} />, rows: other }] : [])]
          .filter((g) => g.rows.length > 0).map((g) => (
          <div key={g.name} className="mb-5">
            <div className="text-[10px] uppercase tracking-[0.1em] font-semibold text-muted-foreground/70 mb-1.5 flex items-center gap-1.5">
              {g.icon} {g.label} · {g.rows.length}
            </div>
            <div className="grid gap-1.5">
              {g.rows.map(({ card: c }) => (
                <div key={c.raw} className={`rounded-lg border border-border bg-card/50 px-3 py-2.5 ${busyRaw === c.raw ? "opacity-50" : ""}`}>
                  <div className="flex items-center gap-2">
                    <span className="w-1 self-stretch rounded-full shrink-0" style={{ background: prioColor(c.priority) }} />
                    <span className="flex-1 min-w-0 text-[13px] leading-snug">{c.text}</span>
                  </div>
                  <div className="mt-1.5 pl-3 flex items-center gap-1.5 flex-wrap">
                    <Chip onClick={() => onPin(c, today)}>Today</Chip>
                    <Chip onClick={() => onPin(c, isoAdd(today, 1))}>Tomorrow</Chip>
                    <Chip onClick={() => setDateFor(dateFor === c.raw ? null : c.raw)}><CalendarDays size={11} /> Pick</Chip>
                    {dateFor === c.raw && (
                      <input type="date" defaultValue={today} aria-label="Pin to date"
                        className="h-7 bg-secondary/40 border border-border rounded-md px-1.5 text-[11.5px] focus:outline-none focus:border-primary"
                        onChange={(e) => { if (e.target.value) { onPin(c, e.target.value); setDateFor(null); } }} />
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
        {floating.length === 0 && (
          <div className="text-[13px] text-muted-foreground italic">Nothing floating — everything has its day.</div>
        )}
        <button onClick={() => { onClose(); openBoard(MASTER, "Planning", false); }}
          className="mt-2 text-[12px] text-muted-foreground hover:text-foreground underline transition-colors">
          Open the full board
        </button>
      </div>
    </div>,
    document.body
  );
}

/* -------------------------------------------------------------- month widget */
type ChipItem = { key: string; node: ReactNode };
type Cell = { iso: string; date: Date; inMonth: boolean };

function MonthWidget({ grid, today, monthLabel, chipsFor, dotsFor, onOpen, selected, shift, goToday, facets, toggleFacet }: {
  grid: Cell[]; today: string; monthLabel: string;
  chipsFor: (iso: string, big?: boolean, tight?: boolean) => ChipItem[];
  dotsFor: (iso: string) => TLItem[];
  onOpen: (iso: string, addEvent?: boolean) => void;
  /** the day the floating strip is aimed at — drawn so the aim is never invisible */
  selected?: string | null;
  shift: (n: number) => void; goToday: () => void;
  facets: Record<Facet, boolean>; toggleFacet: (f: Facet) => void;
}) {
  const w = useWidget();
  const size = w?.size ?? "lg";
  const focused = !!w?.focused;
  const mode: "month" | "strip" | "agenda" =
    size === "xs" || (size === "sm" && focused && !!w?.tall) ? "agenda" : size === "sm" ? "strip" : "month";
  const colW = (w?.width || 1200) / 7;

  const at = grid.findIndex((d) => d.iso === today);
  const firstIn = Math.max(0, grid.findIndex((d) => d.inMonth));
  // the strip is this week and next when today is on the page, else the month's first two
  const stripStart = Math.min(28, at >= 0 ? at - (at % 7) : 0);
  const cells = mode === "strip" ? grid.slice(stripStart, stripStart + 14) : grid;
  const weeks = mode === "strip" ? 2 : 6;
  const tileRow = mode === "strip"
    ? Math.max(132, Math.min(200, Math.round(colW * 2)))
    : Math.max(112, Math.min(190, Math.round(colW * 0.62)));
  const gridRef = useRef<HTMLDivElement>(null);
  const [fillRow, setFillRow] = useState(0);
  useLayoutEffect(() => {
    const grid = gridRef.current;
    const main = grid?.closest<HTMLElement>("[data-knav-region=main]");
    if (focused || mode !== "month" || !grid || !main) { setFillRow(0); return; }
    const read = () => {
      const top = grid.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop;
      const dow = (grid.previousElementSibling as HTMLElement | null)?.offsetHeight ?? 0;
      const fill = Math.floor((main.clientHeight - top - 20) / 6);
      const cap = Math.floor((main.clientHeight - dow - 20) / 6);
      const next = Math.max(0, Math.min(fill, cap));
      setFillRow((p) => (Math.abs(p - next) < 1 ? p : next));
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(main);
    const frame = grid.closest("[data-knav-widget]");
    if (frame) ro.observe(frame);
    return () => ro.disconnect();
  }, [focused, mode]);
  const rowH = mode === "month" ? Math.max(tileRow, fillRow) : tileRow;
  const rowsStyle = {
    gridTemplateRows: focused ? `repeat(${weeks}, minmax(${mode === "strip" ? 132 : 96}px, 1fr))` : `repeat(${weeks}, ${rowH}px)`,
  };
  const agendaDays = mode !== "agenda" ? []
    : focused ? grid.filter((d) => d.inMonth)
    : grid.slice(at >= 0 && grid[at].inMonth ? at : firstIn).slice(0, rowCap(w, 7, 14));

  return (
    <Card className={cn("p-0 overflow-hidden", focused && "min-h-full flex flex-col")}>
      {focused && (
        <div className="shrink-0 flex items-center gap-1.5 flex-wrap px-2.5 py-2 border-b border-border">
          <span className="text-[14px] font-semibold tracking-tight nums mr-1">{monthLabel}</span>
          <Button variant="outline" size="sm" className="h-7 px-2" aria-label="Previous month" title="Previous month" onClick={() => shift(-1)}><ChevronLeft size={13} /></Button>
          <Button variant="outline" size="sm" className="h-7 px-2.5 text-[12px]" onClick={goToday}>Today</Button>
          <Button variant="outline" size="sm" className="h-7 px-2" aria-label="Next month" title="Next month" onClick={() => shift(1)}><ChevronRight size={13} /></Button>
          <div className="ml-auto flex items-center gap-1 flex-wrap">
            {FACETS.map((f) => {
              const on = facets[f.id];
              return (
                <button key={f.id} onClick={() => toggleFacet(f.id)} title={`${f.label}: ${f.hint}`} aria-label={f.label} aria-pressed={on}
                  className={`flex items-center gap-1 px-2 py-1 rounded-full border text-[11px] transition-colors ${
                    on ? "text-foreground border-foreground/30 bg-secondary/40" : "text-muted-foreground border-border hover:text-foreground"}`}>
                  {f.icon}<span className="hidden group-data-[size=lg]/widget:inline group-data-[size=xl]/widget:inline">{f.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
      {mode === "agenda" ? (
        <div className="divide-y divide-border/60">
          {agendaDays.map((d) => (
            <AgendaDay key={d.iso} cell={d} today={today} chips={chipsFor(d.iso, true)} cap={focused ? Infinity : 3} onOpen={onOpen} />
          ))}
        </div>
      ) : (
        <>
          <div className="shrink-0 grid grid-cols-7 border-b border-border">
            {DOW.map((d) => (
              <div key={d} className="min-w-0 truncate px-2 py-1.5 text-[10.5px] uppercase tracking-[0.08em] font-semibold text-muted-foreground">{d}</div>
            ))}
          </div>
          <div ref={gridRef} className={cn("grid grid-cols-7 gap-px bg-border/60", focused && "flex-1")} style={rowsStyle}>
            {cells.map((cell) => (
              <DayCell key={cell.iso} cell={cell} today={today} chips={chipsFor(cell.iso, false, mode === "strip")} dots={dotsFor(cell.iso)} onOpen={onOpen} selected={cell.iso === selected} />
            ))}
          </div>
        </>
      )}
    </Card>
  );
}

function DayCell({ cell, today, chips, dots, onOpen, selected }: {
  cell: Cell; today: string; chips: ChipItem[]; dots: TLItem[];
  onOpen: (iso: string, addEvent?: boolean) => void;
  selected?: boolean;
}) {
  const isToday = cell.iso === today;
  // tints are inset shadows over an opaque cell, so the hairline gaps stay hairlines
  return (
    <div role="button" tabIndex={0}
      onClick={() => onOpen(cell.iso)}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(cell.iso); } }}
      aria-label={`Open ${cell.iso}`}
      aria-current={selected ? "date" : undefined}
      title={selected ? `${cell.iso} — the floating strip below is aimed at this day` : `Open ${cell.iso}`}
      className={cn(`group relative min-w-0 min-h-0 text-left bg-card px-1.5 py-1 flex flex-col gap-1 cursor-pointer transition-shadow hover:shadow-[inset_0_0_0_999px_hsl(var(--accent)/0.3)] focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary
        ${cell.inMonth ? "" : "shadow-[inset_0_0_0_999px_hsl(var(--muted)/0.3)]"}`,
        selected && "ring-1 ring-inset ring-primary/70")}>
      <div className="shrink-0 flex items-center justify-between gap-1 min-w-0">
        <span className={`text-[12px] nums leading-none px-1.5 py-0.5 rounded ${isToday ? "bg-primary text-primary-foreground font-semibold" : cell.inMonth ? "text-foreground" : "text-muted-foreground"}`}>
          {cell.date.getDate()}
        </span>
        {dots.length > 0 && (
          <span className="flex items-center gap-0.5 pr-4 min-w-0 overflow-hidden">
            {dots.slice(0, 4).map((t, i) => (
              <span key={i} className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: prioColor(t.priority) }} />
            ))}
          </span>
        )}
      </div>
      {/* hover "+" — straight into the day panel's event editor. A mouse
          shortcut only: Enter on the cell opens the panel, which has Add event */}
      <span role="button" tabIndex={-1} aria-label={`Add an event on ${cell.iso}`} data-knav-skip
        onClick={(ev) => { ev.stopPropagation(); onOpen(cell.iso, true); }}
        title="Add an event"
        className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 transition-opacity rounded-sm p-0.5 text-muted-foreground hover:text-foreground hover:bg-accent">
        <Plus size={12} />
      </span>
      <ChipStack items={chips} />
    </div>
  );
}

function ChipStack({ items }: { items: ChipItem[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(items.length);
  const sig = items.map((i) => i.key).join("");
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const kids = Array.from(el.children).filter((k) => !k.hasAttribute("data-more")) as HTMLElement[];
      const count = (room: number) => {
        let n = 0;
        for (const k of kids) { if (k.offsetTop + k.offsetHeight <= room + 0.5) n++; else break; }
        return n;
      };
      const all = count(el.clientHeight);
      setFit(all >= kids.length ? kids.length : count(el.clientHeight - 13));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [sig]);
  const shown = Math.min(fit, items.length);
  return (
    <div ref={ref} className="relative flex-1 min-h-0 flex flex-col gap-0.5 overflow-hidden">
      {items.map((c, i) => (
        <div key={c.key} className={cn("shrink-0 min-w-0", i >= shown && "invisible")} aria-hidden={i >= shown || undefined}>{c.node}</div>
      ))}
      {items.length > shown && (
        <span data-more className="absolute left-0 bottom-0 text-[9.5px] leading-[12px] text-muted-foreground nums">+{items.length - shown} more</span>
      )}
    </div>
  );
}

function AgendaDay({ cell, today, chips, cap, onOpen }: {
  cell: Cell; today: string; chips: ChipItem[]; cap: number;
  onOpen: (iso: string, addEvent?: boolean) => void;
}) {
  const isToday = cell.iso === today;
  const shown = chips.slice(0, cap);
  return (
    <div role="button" tabIndex={0}
      onClick={() => onOpen(cell.iso)}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(cell.iso); } }}
      aria-label={`Open ${cell.iso}`} title={`Open ${cell.iso}`}
      className={`flex items-start gap-3 px-3 py-2 min-w-0 cursor-pointer transition-colors hover:bg-accent/30 focus:outline-none focus-visible:ring-1 focus-visible:ring-primary ${cell.inMonth ? "" : "bg-muted/30"}`}>
      <div className="w-10 shrink-0 text-center">
        <div className="text-[10px] uppercase tracking-[0.08em] font-semibold text-muted-foreground">{DOW[cell.date.getDay()]}</div>
        <div className={`mt-0.5 text-[14px] nums leading-none px-1 py-0.5 rounded ${isToday ? "bg-primary text-primary-foreground font-semibold" : ""}`}>{cell.date.getDate()}</div>
      </div>
      <div className="flex-1 min-w-0 flex flex-wrap items-center gap-1 pt-0.5">
        {shown.map((c) => <div key={c.key} className="min-w-0 max-w-full">{c.node}</div>)}
        {chips.length > shown.length && <span className="text-[10.5px] text-muted-foreground nums">+{chips.length - shown.length} more</span>}
        {chips.length === 0 && <span className="text-[11.5px] text-muted-foreground/50">·</span>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ carried over */
function Carried({ overdue, busyRaw, openBoard, go, onAllToday, onToggle, onReschedule }: {
  overdue: TLItem[]; busyRaw: string | null;
  openBoard: (path: string, title: string, isPaper: boolean) => void;
  go?: (v: string) => void;
  onAllToday: () => void;
  onToggle: (it: TLItem) => void;
  onReschedule: (it: TLItem, iso: string | null) => void;
}) {
  const cap = rowCap(useWidget(), 6, 12);
  return (
    <Card className="min-h-full p-4 border-[hsl(12_60%_50%/0.35)] bg-[hsl(12_60%_50%/0.04)]">
      <div className="flex items-center justify-between gap-3 flex-wrap mb-1.5">
        <div className="text-[11px] uppercase tracking-[0.09em] font-semibold" style={{ color: toneColor("over") }}>
          Carried over · {overdue.length}
        </div>
        <button onClick={onAllToday}
          className="inline-flex items-center gap-1 rounded-full border border-border px-3 py-1 text-[11.5px] text-muted-foreground hover:text-foreground hover:border-primary/50 transition-colors">
          <ArrowRight size={11} /> All to today
        </button>
      </div>
      <div className="grid gap-1 group-data-[size=lg]/widget:grid-cols-2 group-data-[size=xl]/widget:grid-cols-2">
        {overdue.slice(0, cap).map((it) => (
          <TaskRow key={it.raw || it.text} it={it} openBoard={openBoard} go={go} busy={busyRaw === it.raw}
            onToggle={() => onToggle(it)} onReschedule={(iso) => onReschedule(it, iso)} carried />
        ))}
      </div>
      {overdue.length > cap && (
        <button onClick={() => openBoard(MASTER, "Planning", false)}
          className="text-[12px] text-muted-foreground hover:text-foreground text-left pt-1 underline">
          +{overdue.length - cap} more — open the board
        </button>
      )}
    </Card>
  );
}
