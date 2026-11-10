
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Calendar, ChevronRight, AlertTriangle, Sun, Plus,
  Printer, Clock, CalendarClock, CalendarDays, ArrowRight, Check, Gauge, ListChecks,
  Cloud, CloudSun, CloudFog, CloudDrizzle, CloudRain,
  CloudSnow, CloudLightning, Inbox, Layers,
} from "lucide-react";
import { useApi } from "@/lib/hooks";
import { api } from "@/lib/api";
import type { Event, TLItem, AmbientSun, KCard } from "@/lib/api";
import { TASKS_BOARD } from "@/lib/paths";
import {
  fmtTime, fmtDateLong, prioColor, relDue, toneColor, titleCase,
  categoryColor, parseEst, fmtEst,
} from "@/lib/format";
import { SkelToday } from "@/components/Skeletons";
import { JoinButton } from "@/components/calrows";
import { taskDest } from "@/lib/taskdest";
import { nextWorkday, useOffDays, isoLocal } from "@/lib/workday";
import { TodayPlanStrip } from "@/components/DraftingPipeline";
import { useDatumCursor, ChartTip } from "@/components/charts/datum";
import { DailyNotes, EveningCheckin, JournalDayPicker } from "@/components/DailyJournal";
import { WidgetFrame, useWidget, rowCap } from "@/components/ui/widget";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

const PRIO_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };
const estOf = (it: TLItem) => it.est ?? parseEst(it.raw) ?? 0;

// a tile's card fills its grid cell; a focused view's card grows with its content
const FILL = "h-full group-data-[focused]/widget:h-auto group-data-[focused]/widget:min-h-full";

type OpenBoardFn = (path: string, title: string, isPaper: boolean) => void;
type RowCtx = {
  openBoard: OpenBoardFn; go: (v: string) => void; reload: () => void;
  onResolve: (e: Event, done: boolean) => Promise<void>;
};

export function Today({ openBoard, go }: { openBoard: (path: string, title: string, isPaper: boolean) => void; go: (v: string) => void }) {
  const t = useApi(() => api.today(), [], 30_000);
  const routines = useApi(() => api.routines(), [], 60_000);
  const amb = useApi(() => api.ambient(), [], 900_000);
  const [quick, setQuick] = useState("");
  const [adding, setAdding] = useState(false);

  // Journal day navigation: flip the morning/evening writing back to a recent day
  // to backfill a missed entry (e.g. a weekend away). "" means today.
  const todayIso = routines.data?.date ?? "";
  const [jDate, setJDate] = useState("");
  const viewingPast = !!jDate && jDate !== todayIso;
  const journalDays = useApi(() => api.dailyRecent(6), []);
  const pastDay = useApi(() => (jDate && jDate !== todayIso ? api.dailySections(jDate) : Promise.resolve(null)), [jDate, todayIso]);
  const activeDate = jDate || todayIso;
  const activeSections = viewingPast ? pastDay.data : (routines.data?.sections ?? null);
  const activePath = viewingPast ? (pastDay.data?.dailyPath ?? "") : (routines.data?.dailyPath ?? "");
  const pickDay = (d: string) => { setJDate(d === todayIso ? "" : d); journalDays.reload(); };

  const queue = useMemo(() => {
    if (!t.data) return [];
    const tag = (arr: TLItem[], bucket: number) => arr.map((it) => ({ it, bucket }));
    const pool = [
      ...tag(t.data.overdue, 0),
      ...tag(t.data.dueToday, 1),
      ...tag(t.data.flagged || [], 2),   // high-priority, no deadline — surface it
      ...tag(t.data.dueSoon, 3),
    ];
    pool.sort((a, b) =>
      a.bucket - b.bucket ||
      (a.bucket === 1 ? 0 :
        (PRIO_RANK[a.it.priority || "low"] ?? 2) - (PRIO_RANK[b.it.priority || "low"] ?? 2)));
    return pool.map((x) => x.it);
  }, [t.data]);

  // Day load: sum of estimates over overdue + due-today.
  const dayLoad = useMemo(() => {
    if (!t.data) return 0;
    return [...t.data.overdue, ...t.data.dueToday].reduce((s, it) => s + estOf(it), 0);
  }, [t.data]);

  if (!t.data) return <SkelToday />;
  const d = t.data;
  const dateLabel = fmtDateLong(d.today);

  const resolveEvent = async (e: Event, done: boolean) => {
    const res = await api.resolveEvent(e.path, done).catch(() => ({ error: "network" as const }));
    if (res.error) { toast.error("Couldn't mark that — try again"); return; }
    t.reload();
    toast.success(done ? "Resolved — off your plate" : "Reopened");
  };
  const ctx: RowCtx = { openBoard, go, reload: t.reload, onResolve: resolveEvent };
  const agenda: Agenda = {
    today: d.today, overdue: d.overdue, dueToday: d.dueToday, dueSoon: d.dueSoon,
    eventsToday: d.eventsToday, eventsWeek: d.eventsWeek,
  };

  async function addToInbox() {
    if (!quick.trim() || adding) return;
    setAdding(true);
    try {
      await api.boardOp(TASKS_BOARD, "add", { lane: "INBOX", text: quick.trim() });
      toast("Added to INBOX", { description: quick.trim().slice(0, 60) });
      setQuick("");
      t.reload();
    } catch { toast.error("Couldn't add"); }
    finally { setAdding(false); }
  }

  const picker = (
    <JournalDayPicker days={journalDays.data} active={activeDate} today={todayIso}
      onPick={pickDay} loading={viewingPast && !pastDay.data} />
  );

  return (
    <div>
      {/* the header stays loose: a title and a few chips, each its own stop */}
      <header className="mb-6">
        <div className="flex items-center gap-2 text-[12px] text-muted-foreground uppercase tracking-[0.1em] font-semibold mb-1">
          <Sun size={14} className="opacity-60" /> Today
        </div>
        <div className="flex items-end justify-between gap-x-4 gap-y-2 flex-wrap">
          <h1 className="text-[26px] font-semibold tracking-tight cursor-pointer hover:text-primary transition-colors"
              onClick={() => api.open("Preparation/Notes/Daily/" + d.today + ".md")}
              title="Open today's daily note">
            {dateLabel}
          </h1>
          <div className="flex items-center gap-2 flex-wrap">
            {amb.data?.weather && <WeatherChip w={amb.data.weather} />}
            {amb.data?.sun && <DaylightArc sun={amb.data.sun} />}
            {dayLoad > 0 && (
              <div className="flex items-center gap-1.5 text-[12px] nums px-2.5 py-1.5 rounded-full border border-border bg-card/50"
                   title="Estimated effort for overdue + due-today tasks (@est)">
                <Gauge size={13} className="text-primary" />
                <span className="text-foreground font-medium">≈{fmtEst(dayLoad)}</span>
                <span className="text-muted-foreground">planned</span>
              </div>
            )}
          </div>
        </div>
        <p className="text-muted-foreground text-sm mt-1 nums">
          {d.eventsToday.length} event{d.eventsToday.length === 1 ? "" : "s"} ·{" "}
          {d.overdue.length} overdue · {d.dueToday.length + d.dueSoon.length} due in the next 7 days
        </p>

        {/* commitments due within 14 days + this week's focus projects;
            nothing at all when there are neither */}
        <TodayPlanStrip go={go} />
      </header>

      {/* Notes — the day starts here, a big journaling space.
          The day-picker flips the journal back to backfill a missed day. */}
      {routines.data && (
        <WidgetFrame id="today.morning" title="Notes" className="mb-5">
          {activeSections
            ? <DailyNotes key={activeDate} sections={activeSections} date={activeDate} isToday={!viewingPast} picker={picker} onPickDay={pickDay} />
            : <Card className={cn("p-6", FILL)}>{picker}<EmptyLine>Opening that day…</EmptyLine></Card>}
        </WidgetFrame>
      )}

      {/* Today's tasks: capture + the one thing next; focused, the whole ranked queue */}
      <WidgetFrame id="today.tasks" title="Today's tasks" className="mb-5">
        <TasksCard queue={queue} ctx={ctx}
          quick={quick} setQuick={setQuick} adding={adding} addToInbox={addToInbox} />
      </WidgetFrame>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <WidgetFrame id="today.calendar" title="Today's calendar">
          <CalendarCard events={d.eventsToday} agenda={agenda} ctx={ctx} />
        </WidgetFrame>
        <WidgetFrame id="today.overdue" title="Overdue">
          <OverdueCard items={d.overdue} agenda={agenda} ctx={ctx} />
        </WidgetFrame>
        <WidgetFrame id="today.due" title="Due today">
          <DueTodayCard items={d.dueToday} agenda={agenda} ctx={ctx} />
        </WidgetFrame>
        <WidgetFrame id="today.week" title="Coming this week">
          <WeekAheadCard events={d.eventsWeek} items={d.dueSoon} agenda={agenda} ctx={ctx} />
        </WidgetFrame>
      </div>

      {/* Log — the close of the day, at the bottom of the page */}
      {routines.data && (
        <WidgetFrame id="today.evening" title="Log" className="mt-5">
          {activeSections
            ? <EveningCheckin key={activeDate} sections={activeSections} date={activeDate} dailyPath={activePath} />
            : <Card className={cn("p-6", FILL)}><EmptyLine>Opening that day…</EmptyLine></Card>}
        </WidgetFrame>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- task actions
function tomorrowIso() { const d = new Date(); d.setDate(d.getDate() + 1); return isoLocal(d); }

function useTaskOps(it: TLItem, reload: () => void) {
  const [busy, setBusy] = useState(false);
  const off = useOffDays();
  const wd = nextWorkday(new Date(), off);

  const complete = async () => {
    if (!it.raw || busy) return;
    setBusy(true);
    try { await api.boardOp(it.path, "toggle", { raw: it.raw }); toast("Marked done", { description: it.text.slice(0, 60) }); reload(); }
    catch { toast.error("Couldn't update"); } finally { setBusy(false); }
  };
  // one re-dater for both push buttons: strip any existing @due / bare ISO, stamp the new one
  const pushTo = async (iso: string, said: string) => {
    if (!it.raw || busy) return;
    setBusy(true);
    const m = it.raw.match(/^(\s*)-\s*\[[ xX]\]\s*(.*)$/);
    if (m) {
      let body = m[2].replace(/\s*@due[\(\{][^)\}]+[\)\}]/g, "").replace(/\b20\d{2}-\d{2}-\d{2}\b/g, "").trim();
      body = `${body} @due(${iso})`.replace(/\s+/g, " ").trim();
      try { await api.boardOp(it.path, "edit", { raw: it.raw, body }); toast(said); reload(); }
      catch { toast.error("Couldn't reschedule"); }
    }
    setBusy(false);
  };
  return {
    busy, wd, complete,
    tomorrow: () => pushTo(tomorrowIso(), "Pushed to tomorrow"),
    nextWorkday: () => pushTo(wd.iso, `Pushed to ${wd.long}`),
  };
}

/* a row's actions in a focused view: icons with tooltips, words once the widget is wide */
function TaskActions({ it, reload }: { it: TLItem; reload: () => void }) {
  const ops = useTaskOps(it, reload);
  const w = useWidget();
  const words = w?.size === "lg" || w?.size === "xl";
  const cls = "h-7 px-2 gap-1 text-[11.5px] text-muted-foreground hover:text-foreground";
  const off = ops.busy || !it.raw;
  return (
    <span className="flex items-center gap-0.5 shrink-0">
      <Button variant="ghost" size="sm" className={cls} onClick={ops.complete} disabled={off}
        title="Mark done" aria-label={`Done: ${it.text}`}>
        <Check size={13} />{words && "Done"}
      </Button>
      <Button variant="ghost" size="sm" className={cls} onClick={ops.tomorrow} disabled={off}
        title="Push to tomorrow" aria-label={`Push to tomorrow: ${it.text}`}>
        <Clock size={13} />{words && "Tomorrow"}
      </Button>
      <Button variant="ghost" size="sm" className={cls} onClick={ops.nextWorkday} disabled={off}
        title={`Push to the next working day — ${ops.wd.long}`} aria-label={`Push to the next workday: ${it.text}`}>
        <CalendarClock size={13} />{words && "Next workday"}
      </Button>
    </span>
  );
}

// ---------------------------------------------------------------- tasks widget
function TasksCard({ queue, ctx, quick, setQuick, adding, addToInbox }: {
  queue: TLItem[]; ctx: RowCtx;
  quick: string; setQuick: (s: string) => void; adding: boolean; addToInbox: () => void;
}) {
  const w = useWidget();
  const xs = w?.size === "xs";
  const focused = !!w?.focused;
  // tile: the one thing next (plus a few on a wide tile); focused: the queue grouped by
  // board beside the planning board's INBOX lane
  const then = queue.slice(1, 1 + rowCap(w, 0, 3));
  const hidden = Math.max(0, queue.length - 1 - then.length);
  const inbox = useApi(() => (focused ? api.board(TASKS_PATH) : Promise.resolve(null)), [focused]);
  // a capture just landed in INBOX: show it
  useEffect(() => { if (focused && !adding) inbox.reload(); }, [adding]);   // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Card className={cn("p-5", focused ? "min-h-full flex flex-col" : FILL)}>
      <div className="flex items-center justify-between gap-x-3 flex-wrap">
        <SectionLabel icon={<ListChecks size={13} />}>Today's tasks</SectionLabel>
        <div className="flex gap-1.5 mb-3">
          <Button variant="outline" size="sm" className="gap-1.5 h-8" title="Open the planning board" aria-label="Board"
            onClick={() => ctx.openBoard(TASKS_BOARD, "Planning", false)}>
            <ChevronRight size={13} />{!xs && "Board"}
          </Button>
          <Button variant="outline" size="sm" className="gap-1.5 h-8 no-print" onClick={() => window.print()}
            title="Print today's agenda" aria-label="Print">
            <Printer size={13} />{!xs && "Print"}
          </Button>
        </div>
      </div>
      <div className="flex gap-2 mb-4 max-w-[820px]">
        <Input value={quick} onChange={(e) => setQuick(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") addToInbox(); }}
          placeholder={w && (w.size === "xs" || w.size === "sm") ? "Add a task → INBOX" : "Add a task → INBOX   ·   #tag @high @due(2026-06-20) @est(2h)"}
          title="#tag @high @due(2026-06-20) @est(2h)"
          className="text-[13px] flex-1 min-w-0 h-9" />
        <Button onClick={addToInbox} size="sm" disabled={!quick.trim() || adding} className="gap-1.5 shrink-0 h-9">
          <Plus size={14} /> Add
        </Button>
      </div>

      {focused ? (
        <TasksFocusBody queue={queue} ctx={ctx}
          inbox={inbox.data ? (inbox.data.lanes.find((l) => l.name.toUpperCase() === "INBOX")?.cards ?? []) : null}
          reloadInbox={inbox.reload} wide={w!.size === "lg" || w!.size === "xl"} />
      ) : (
        <>
          {queue.length > 0
            ? <UpNext queue={queue} ctx={ctx} />
            : <EmptyLine>Nothing queued.</EmptyLine>}

          {then.length > 0 && (
            <div className="mt-4">
              <div className="text-[11px] uppercase tracking-[0.09em] font-semibold text-muted-foreground mb-1">Then</div>
              <RowList>
                {then.map((it, i) => <TaskRow key={i} it={it} ctx={ctx} showDate />)}
              </RowList>
            </div>
          )}
          {then.length > 0 && <MoreLine n={hidden} />}
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- Up Next
function UpNext({ queue, ctx }: { queue: TLItem[]; ctx: RowCtx }) {
  const it = queue[0];
  const r = relDue(it.due);
  const est = estOf(it);
  const dest = taskDest(it, ctx.openBoard, ctx.go);
  const ops = useTaskOps(it, ctx.reload);
  const w = useWidget();
  const xs = w?.size === "xs";

  return (
    <div className="rounded-lg overflow-hidden border border-primary/30 bg-background/40">
      <div className="flex items-stretch">
        <div className="w-1.5 shrink-0" style={{ background: prioColor(it.priority) }} />
        <div className={cn("flex-1 min-w-0", xs ? "p-3.5" : "p-5")}>
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.1em] font-semibold text-primary mb-2">
            <ArrowRight size={13} /> Up next
          </div>
          <button onClick={dest.onClick}
            className="text-left block w-full group">
            <div className="text-[17px] font-medium leading-snug group-hover:text-primary transition-colors break-words">{it.text}</div>
          </button>
          <div className="flex items-center gap-x-2.5 gap-y-0.5 mt-2 text-[12px] text-muted-foreground nums flex-wrap">
            <span className="capitalize">{it.board}</span>
            <span className="opacity-40">·</span>
            <span className="capitalize">{it.lane}</span>
            {r && <><span className="opacity-40">·</span><span style={{ color: toneColor(r.tone) }} className="font-medium">{r.label}</span></>}
            {est > 0 && <><span className="opacity-40">·</span><span>≈{fmtEst(est)}</span></>}
            {queue.length > 1 && <><span className="opacity-40">·</span><span>then {queue.length - 1} more queued</span></>}
          </div>
          <div className="flex items-center gap-2 mt-4 flex-wrap">
            <Button size="sm" className="gap-1.5" onClick={dest.onClick}>
              {dest.label} <ArrowRight size={13} />
            </Button>
            {dest.extras.map((x) => (
              <Button key={x.label} variant="outline" size="sm" className="gap-1.5" onClick={x.onClick}>
                {x.label} <ArrowRight size={13} />
              </Button>
            ))}
            {dest.smart && (
              <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground"
                onClick={() => ctx.openBoard(it.path, titleCase(it.board), !it.isPlanning)} title="Open the task's board">
                Board <ArrowRight size={13} />
              </Button>
            )}
            <Button variant="outline" size="sm" className="gap-1.5" onClick={ops.complete} disabled={ops.busy}>
              <Check size={13} /> Done
            </Button>
            <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground"
              onClick={ops.tomorrow} disabled={ops.busy}>
              <Clock size={13} /> Tomorrow
            </Button>
            <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground"
              onClick={ops.nextWorkday} disabled={ops.busy}
              title={`Push to the next working day — ${ops.wd.long}`}>
              <CalendarClock size={13} /> Next workday
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- agenda cards
// rows stack in one column; a focused view on a very wide widget runs two
function RowList({ children }: { children: ReactNode }) {
  const w = useWidget();
  const two = !!w?.focused && w.size === "xl";
  return (
    <div className={two ? "grid grid-cols-2 gap-x-10 [&>*]:border-b [&>*]:border-border/40" : "divide-y divide-border/40"}>
      {children}
    </div>
  );
}

function MoreLine({ n }: { n: number }) {
  if (n <= 0) return null;
  return <div className="text-[11px] text-muted-foreground pt-2" title="Open the widget for the full list">+{n} more</div>;
}

function CalendarCard({ events, agenda, ctx }: { events: Event[]; agenda: Agenda; ctx: RowCtx }) {
  const w = useWidget();
  if (w?.focused) return <CalendarFocus a={agenda} ctx={ctx} />;
  const cap = rowCap(w, 6, 10);
  return (
    <Card className={cn("p-6", FILL)}>
      <SectionLabel icon={<Calendar size={13} />}>Today's calendar</SectionLabel>
      {events.length === 0 ? (
        <EmptyLine>Nothing on the calendar.</EmptyLine>
      ) : (
        <>
          <RowList>{events.slice(0, cap).map((e) => <EventRow key={e.path} e={e} onResolve={ctx.onResolve} />)}</RowList>
          <MoreLine n={events.length - cap} />
        </>
      )}
    </Card>
  );
}

function OverdueCard({ items, agenda, ctx }: { items: TLItem[]; agenda: Agenda; ctx: RowCtx }) {
  const w = useWidget();
  const cap = rowCap(w, 8);
  if (w?.focused) {
    return (
      <AgendaFocus a={agenda} mode="overdue" ctx={ctx} title="Overdue" listTitle={`All overdue · ${items.length}`}
        icon={<AlertTriangle size={13} className="text-destructive/90" />}
        action={items.length > 0 && (
          <button onClick={() => snoozeAllOverdue(items, ctx.reload)} title="Snooze every overdue task by 1 day"
            className="text-[10.5px] text-muted-foreground hover:text-foreground flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-accent transition-colors">
            <Clock size={11} /> Snooze all +1d
          </button>
        )}
        list={items.length === 0
          ? <EmptyLine>Clean slate — no overdue tasks.</EmptyLine>
          : <RowList>{items.map((it, i) => <TaskRow key={i} it={it} ctx={ctx} actions />)}</RowList>} />
    );
  }
  return (
    <Card className={cn("p-6", FILL)}>
      <div className="flex items-center justify-between gap-2 flex-wrap mb-3">
        <SectionLabel icon={<AlertTriangle size={13} className="text-destructive/90" />}>Overdue</SectionLabel>
        {items.length > 0 && (
          <button onClick={() => snoozeAllOverdue(items, ctx.reload)}
            title="Snooze every overdue task by 1 day"
            className="text-[10.5px] text-muted-foreground hover:text-foreground flex items-center gap-1 -mt-2 px-1.5 py-0.5 rounded hover:bg-accent transition-colors">
            <Clock size={11} /> Snooze all +1d
          </button>
        )}
      </div>
      {items.length === 0 ? (
        <EmptyLine>Clean slate — no overdue tasks.</EmptyLine>
      ) : (
        <>
          <RowList>{items.slice(0, cap).map((it, i) => <TaskRow key={i} it={it} ctx={ctx} actions={!!w?.focused} />)}</RowList>
          <MoreLine n={items.length - cap} />
        </>
      )}
    </Card>
  );
}

function DueTodayCard({ items, agenda, ctx }: { items: TLItem[]; agenda: Agenda; ctx: RowCtx }) {
  const w = useWidget();
  const cap = rowCap(w, 8);
  if (w?.focused) {
    return (
      <AgendaFocus a={agenda} mode="due" ctx={ctx} title="Due today" listTitle={`Due today · ${items.length}`}
        icon={<CalendarClock size={13} />}
        list={items.length === 0
          ? <EmptyLine>Nothing due today.</EmptyLine>
          : <RowList>{items.map((it, i) => <TaskRow key={i} it={it} ctx={ctx} actions />)}</RowList>} />
    );
  }
  return (
    <Card className={cn("p-6", FILL)}>
      <SectionLabel icon={<CalendarClock size={13} />}>Due today</SectionLabel>
      {items.length === 0 ? (
        <EmptyLine>Nothing due today.</EmptyLine>
      ) : (
        <>
          <RowList>{items.slice(0, cap).map((it, i) => <TaskRow key={i} it={it} ctx={ctx} actions={!!w?.focused} />)}</RowList>
          <MoreLine n={items.length - cap} />
        </>
      )}
    </Card>
  );
}

function WeekAheadCard({ events, items, agenda, ctx }: { events: Event[]; items: TLItem[]; agenda: Agenda; ctx: RowCtx }) {
  const w = useWidget();
  const evCap = rowCap(w, 4, 6);
  const taskCap = rowCap(w, 6, 10);
  const hidden = Math.max(0, events.length - evCap) + Math.max(0, items.length - taskCap);
  if (w?.focused) {
    return (
      <AgendaFocus a={agenda} mode="week" ctx={ctx} title="Coming this week" listTitle={`This week · ${events.length + items.length}`}
        icon={<CalendarDays size={13} />}
        list={items.length === 0 && events.length === 0
          ? <EmptyLine>Quiet stretch ahead.</EmptyLine>
          : (
            <RowList>
              {events.map((e) => <EventRow key={e.path + e.date} e={e} showDate onResolve={ctx.onResolve} />)}
              {items.map((it, i) => <TaskRow key={"d" + i} it={it} ctx={ctx} showDate actions />)}
            </RowList>
          )} />
    );
  }
  return (
    <Card className={cn("p-6", FILL)}>
      <SectionLabel icon={<CalendarDays size={13} />}>Coming this week</SectionLabel>
      {items.length === 0 && events.length === 0 ? (
        <EmptyLine>Quiet stretch ahead.</EmptyLine>
      ) : (
        <>
          <RowList>
            {events.slice(0, evCap).map((e) => <EventRow key={e.path} e={e} showDate onResolve={ctx.onResolve} />)}
            {items.slice(0, taskCap).map((it, i) => <TaskRow key={"d" + i} it={it} ctx={ctx} showDate actions={!!w?.focused} />)}
          </RowList>
          <MoreLine n={hidden} />
        </>
      )}
    </Card>
  );
}

type Agenda = {
  today: string; overdue: TLItem[]; dueToday: TLItem[]; dueSoon: TLItem[];
  eventsToday: Event[]; eventsWeek: Event[];
};
const TASKS_PATH = TASKS_BOARD;
const DAY_START = 7, DAY_END = 23;
const addDays = (iso: string, n: number) => { const x = new Date(iso + "T00:00"); x.setDate(x.getDate() + n); return isoLocal(x); };
const weekdayOf = (iso: string) => new Date(iso + "T00:00").toLocaleDateString([], { weekday: "short" });
const monthDay = (iso: string) => new Date(iso + "T00:00").toLocaleDateString([], { month: "short", day: "numeric" });
const onDay = (e: Event, iso: string) => e.date === iso || (!!e.endDate && e.date <= iso && e.endDate >= iso);
const toMinutes = (t: string | null) => {
  if (!t) return null;
  const [h, m] = t.split(":").map((x) => parseInt(x, 10));
  return Number.isFinite(h) ? h * 60 + (Number.isFinite(m) ? m : 0) : null;
};
const timeSpan = (e: Event) => (e.startTime ? fmtTime(e.startTime) + (e.endTime ? "–" + fmtTime(e.endTime) : "") : "all day");
const isNarrow = (w: ReturnType<typeof useWidget>) => !w || w.size === "xs" || w.size === "sm";
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/* today.calendar focused: the day as an hour timeline (07–23) beside today's list and
 * the next three days */
function CalendarFocus({ a, ctx }: { a: Agenda; ctx: RowCtx }) {
  const w = useWidget();
  const stack = isNarrow(w);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const id = setInterval(() => setNow(new Date()), 60_000); return () => clearInterval(id); }, []);

  const lo = DAY_START * 60, hi = DAY_END * 60;
  const pct = (m: number) => ((m - lo) / (hi - lo)) * 100;
  const loose = a.eventsToday.filter((e) => e.allDay || toMinutes(e.startTime) == null);
  // a block keeps at least an hour of height; lanes are assigned on that drawn span
  const blocks = a.eventsToday
    .filter((e) => !e.allDay && toMinutes(e.startTime) != null)
    .map((e) => {
      const s = Math.max(lo, Math.min(hi - 60, toMinutes(e.startTime)!));
      const end = Math.min(hi, Math.max(s + 60, toMinutes(e.endTime) ?? s + 60));
      return { e, s, end, lane: 0 };
    })
    .sort((x, y) => x.s - y.s);
  const laneEnds: number[] = [];
  for (const b of blocks) {
    let l = laneEnds.findIndex((x) => x <= b.s);
    if (l < 0) { l = laneEnds.length; laneEnds.push(0); }
    laneEnds[l] = b.end; b.lane = l;
  }
  const lanes = Math.max(1, laneEnds.length);
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const showNow = isoLocal(now) === a.today && nowMin >= lo && nowMin <= hi;
  const hours = Array.from({ length: DAY_END - DAY_START }, (_, i) => DAY_START + i);
  const hourLabel = (h: number) => `${((h + 11) % 12) + 1} ${h < 12 ? "am" : "pm"}`;
  const next = [1, 2, 3].map((i) => {
    const iso = addDays(a.today, i);
    return { iso, events: a.eventsWeek.filter((e) => onDay(e, iso)), tasks: a.dueSoon.filter((it) => it.due === iso) };
  });
  const ahead = next.reduce((s, d) => s + d.events.length + d.tasks.length, 0);

  return (
    <Card className="p-6 min-h-full flex flex-col">
      <div className="flex items-center justify-between gap-x-3 flex-wrap">
        <SectionLabel icon={<Calendar size={13} />}>Today's calendar</SectionLabel>
        <span className="text-[11px] text-muted-foreground nums mb-3">{a.eventsToday.length} today · {ahead} in the next 3 days</span>
      </div>
      <div className={cn("flex-1 gap-6", stack ? "flex flex-col" : "grid grid-cols-[minmax(0,1fr)_minmax(15rem,22rem)]")}>
        <div className="flex flex-col min-w-0 min-h-[400px]">
          {loose.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-3 pl-14">
              {loose.map((e) => (
                <button key={e.path + e.date} onClick={() => api.open(e.path)} title={`${e.title} · all day`}
                  className="max-w-full truncate rounded-md border border-border bg-accent/40 px-2 py-0.5 text-[11.5px] hover:border-primary/50 transition-colors">
                  {e.title}
                </button>
              ))}
            </div>
          )}
          <div className="relative flex-1 grid border-b border-border/50" style={{ gridTemplateRows: `repeat(${hours.length}, minmax(24px, 1fr))` }}>
            {hours.map((h) => (
              <div key={h} className="border-t border-border/50 min-h-0">
                <span className="block w-12 pr-2 pt-0.5 text-right text-[10.5px] leading-none text-muted-foreground nums">{hourLabel(h)}</span>
              </div>
            ))}
            <div className="absolute inset-y-0 left-14 right-0">
              {blocks.length === 0 && (
                <div className="absolute left-2 top-1.5 text-[12.5px] text-muted-foreground">Nothing timed today.</div>
              )}
              {blocks.map(({ e, s, end, lane }) => (
                <button key={e.path + e.date} onClick={() => api.open(e.path)} title={`${e.title} · ${timeSpan(e)}`}
                  className={cn("absolute rounded-md border-l-[3px] bg-primary/10 hover:bg-primary/15 px-2 text-left overflow-hidden transition-colors",
                    end - s <= 60 ? "py-0.5 flex items-center gap-2" : "py-1", e.completed && "opacity-60")}
                  style={{
                    top: `${pct(s)}%`, height: `calc(${pct(end) - pct(s)}% - 2px)`,
                    left: `calc(${(lane / lanes) * 100}% + 2px)`, width: `calc(${100 / lanes}% - 4px)`,
                    borderLeftColor: categoryColor(e.category),
                  }}>
                  <span className={cn("block min-w-0 text-[12px] font-medium leading-tight truncate", e.completed && "line-through")}>{e.title}</span>
                  <span className="block shrink-0 text-[10.5px] leading-tight text-muted-foreground nums truncate">{timeSpan(e)}</span>
                </button>
              ))}
              {showNow && (
                <div className="absolute inset-x-0 pointer-events-none" style={{ top: `${pct(nowMin)}%` }} aria-hidden="true">
                  <div className="h-px bg-primary" />
                  <div className="absolute -left-1 -top-[3px] w-[7px] h-[7px] rounded-full bg-primary" />
                </div>
              )}
            </div>
          </div>
        </div>
        <div className={cn("min-w-0 flex flex-col gap-5", !stack && "border-l border-border/50 pl-6")}>
          <DayList title="Today" count={a.eventsToday.length} empty="Nothing on the calendar.">
            {a.eventsToday.map((e) => <EventRow key={e.path + e.date} e={e} onResolve={ctx.onResolve} />)}
          </DayList>
          {next.map((d) => (
            <DayList key={d.iso} title={`${weekdayOf(d.iso)} ${monthDay(d.iso)}`} count={d.events.length + d.tasks.length} empty="Nothing planned.">
              {d.events.map((e) => <EventRow key={e.path + e.date} e={e} onResolve={ctx.onResolve} />)}
              {d.tasks.map((it, i) => <TaskRow key={"t" + i} it={it} ctx={ctx} />)}
            </DayList>
          ))}
        </div>
      </div>
    </Card>
  );
}

function DayList({ title, count, empty, children }: { title: string; count: number; empty: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2 mb-1">
        <span className="text-[11px] uppercase tracking-[0.09em] font-semibold text-muted-foreground">{title}</span>
        <span className="text-[11px] text-muted-foreground nums">{count}</span>
      </div>
      {count === 0 ? <EmptyLine>{empty}</EmptyLine> : <div className="divide-y divide-border/40">{children}</div>}
    </div>
  );
}

/* today.overdue / today.due / today.week focused: seven day columns with their counts
 * (overdue leads when there is any), then the widget's own list with its row actions */
function AgendaFocus({ a, mode, ctx, title, icon, action, listTitle, list }: {
  a: Agenda; mode: "overdue" | "due" | "week"; ctx: RowCtx; title: string; icon?: ReactNode;
  action?: ReactNode; listTitle: string; list: ReactNode;
}) {
  const w = useWidget();
  const narrow = isNarrow(w);
  type Col = { key: string; head: string; sub: string; tasks: TLItem[]; events: Event[]; hot: boolean; late?: boolean };
  const cols: Col[] = [];
  if (mode === "overdue" || a.overdue.length) {
    cols.push({ key: "overdue", head: "Overdue", sub: "earlier", tasks: a.overdue, events: [], hot: mode === "overdue", late: true });
  }
  for (let i = 0; i < 7; i++) {
    const iso = addDays(a.today, i);
    cols.push({
      key: iso, head: i === 0 ? "Today" : weekdayOf(iso), sub: monthDay(iso),
      tasks: i === 0 ? a.dueToday : a.dueSoon.filter((it) => it.due === iso),
      events: i === 0 ? a.eventsToday : a.eventsWeek.filter((e) => onDay(e, iso)),
      hot: mode === "week" ? i > 0 : mode === "due" && i === 0,
    });
  }
  const count = (c: Col) => c.tasks.length + c.events.length;
  const max = Math.max(1, ...cols.map(count));
  const week = cols.filter((c) => !c.late).reduce((s, c) => s + count(c), 0);

  return (
    <Card className="p-6 min-h-full flex flex-col">
      <div className="flex items-center justify-between gap-x-3 flex-wrap">
        <SectionLabel icon={icon}>{title}</SectionLabel>
        <span className="flex items-center gap-3 mb-3">
          <span className="text-[11px] text-muted-foreground nums">
            {plural(week, "item")} over 7 days{a.overdue.length ? ` · ${a.overdue.length} overdue` : ""}
          </span>
          {action}
        </span>
      </div>
      <div className={cn("grid gap-2.5", narrow ? "grid-cols-1" : "flex-1 min-h-[220px]")}
        style={narrow ? undefined : { gridTemplateColumns: "repeat(auto-fit, minmax(132px, 1fr))" }}>
        {cols.map((c) => {
          const n = count(c);
          return (
            <div key={c.key} className={cn("rounded-lg border p-2.5 flex flex-col min-w-0",
              c.hot ? "border-primary/50 bg-primary/5" : "border-border/60 bg-background/30")}>
              {/* the date drops under the day name when the column is too narrow for both */}
              <div className="flex flex-wrap items-baseline justify-between gap-x-1.5 min-w-0">
                <span className={cn("text-[11px] uppercase tracking-[0.08em] font-semibold whitespace-nowrap",
                  c.late ? "text-destructive" : c.key === a.today ? "text-primary" : "text-muted-foreground")}>{c.head}</span>
                <span className="text-[10.5px] text-muted-foreground nums whitespace-nowrap">{c.sub}</span>
              </div>
              <div className="text-[22px] font-semibold leading-none mt-2">{n}</div>
              <div className="text-[10.5px] text-muted-foreground mt-1 truncate"
                title={`${plural(c.tasks.length, "task")} · ${plural(c.events.length, "event")}`}>
                {plural(c.tasks.length, "task")}{c.events.length ? ` · ${plural(c.events.length, "event")}` : ""}
              </div>
              <div className="h-1 rounded-full bg-muted mt-2 overflow-hidden" aria-hidden="true">
                <div className="h-full rounded-full" style={{ width: `${(n / max) * 100}%`, background: c.late ? "hsl(var(--destructive))" : "hsl(var(--primary))" }} />
              </div>
              {n > 0 && (
                <div className="mt-2.5 flex flex-col gap-0.5 min-w-0">
                  {c.events.map((e) => (
                    <button key={"e" + e.path + e.date} onClick={() => api.open(e.path)} title={`${e.title} · ${timeSpan(e)}`}
                      className="text-left rounded px-1.5 py-1 hover:bg-accent/50 transition-colors flex items-start gap-1.5 min-w-0">
                      <span className="mt-[5px] w-1.5 h-1.5 rounded-full shrink-0" style={{ background: categoryColor(e.category) }} />
                      <span className={cn("min-w-0 text-[12px] leading-snug line-clamp-2 break-words", e.completed && "line-through text-muted-foreground")}>{e.title}</span>
                    </button>
                  ))}
                  {c.tasks.map((it, i) => <AgendaTask key={"t" + i} it={it} ctx={ctx} />)}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="mt-5 pt-4 border-t border-border/50">
        <div className="text-[11px] uppercase tracking-[0.09em] font-semibold text-muted-foreground mb-1">{listTitle}</div>
        {list}
      </div>
    </Card>
  );
}

function AgendaTask({ it, ctx }: { it: TLItem; ctx: RowCtx }) {
  const dest = taskDest(it, ctx.openBoard, ctx.go);
  return (
    <button onClick={dest.onClick} title={`${it.text} · ${titleCase(it.board)}`}
      className="text-left rounded px-1.5 py-1 hover:bg-accent/50 transition-colors flex items-start gap-1.5 min-w-0">
      <span className="mt-[3px] w-1 h-3 rounded-sm shrink-0" style={{ background: prioColor(it.priority) }} />
      <span className="min-w-0 text-[12px] leading-snug line-clamp-2 break-words">{it.text}</span>
    </button>
  );
}

/* today.tasks focused: capture + up next + the INBOX lane on one side, everything else
 * queued grouped by board on the other */
function TasksFocusBody({ queue, ctx, inbox, reloadInbox, wide }: {
  queue: TLItem[]; ctx: RowCtx; inbox: KCard[] | null; reloadInbox: () => void; wide: boolean;
}) {
  const open = (inbox || []).filter((c) => !c.done);
  const rest = queue.slice(1);
  const groups: [string, TLItem[]][] = [];
  for (const it of rest) {
    const g = groups.find(([b]) => b === it.board);
    if (g) g[1].push(it); else groups.push([it.board, [it]]);
  }
  return (
    <div className={cn("flex-1 gap-5", wide ? "grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] min-h-0" : "flex flex-col")}>
      <div className={cn("flex flex-col gap-5 min-w-0", wide && "min-h-0")}>
        {queue.length > 0 ? <UpNext queue={queue} ctx={ctx} /> : <EmptyLine>Nothing queued.</EmptyLine>}
        <Panel icon={<Inbox size={13} />} title="Inbox" count={open.length} scroll={wide}>
          {!inbox ? <EmptyLine>Loading the inbox…</EmptyLine>
            : open.length === 0 ? <EmptyLine>Inbox is empty.</EmptyLine>
            : <div className="divide-y divide-border/40">{open.map((c, i) => <InboxRow key={i + c.raw} c={c} ctx={ctx} reload={reloadInbox} />)}</div>}
        </Panel>
      </div>
      <Panel icon={<Layers size={13} />} title="Upcoming by board" count={rest.length} scroll={wide}>
        {groups.length === 0 ? <EmptyLine>Nothing else queued.</EmptyLine> : groups.map(([board, items]) => (
          <div key={board} className="mb-4 last:mb-0 min-w-0">
            <div className="flex items-baseline justify-between gap-2 border-b border-border/50 pb-1 mb-0.5">
              <span className="text-[12px] font-semibold capitalize truncate">{board}</span>
              <span className="text-[11px] text-muted-foreground nums shrink-0">{items.length}</span>
            </div>
            <div className="divide-y divide-border/40">
              {items.map((it, i) => <TaskRow key={i} it={it} ctx={ctx} showDate actions />)}
            </div>
          </div>
        ))}
      </Panel>
    </div>
  );
}

function Panel({ icon, title, count, children, scroll }:
{ icon: ReactNode; title: string; count?: number; children: ReactNode; scroll?: boolean }) {
  return (
    <div className={cn("flex-1 rounded-lg border border-border/60 bg-background/30 p-4 min-w-0 flex flex-col", scroll && "min-h-0")}>
      <div className="flex items-center justify-between gap-2 mb-2 shrink-0">
        <span className="text-[11px] uppercase tracking-[0.09em] font-semibold text-muted-foreground flex items-center gap-1.5">{icon}{title}</span>
        {count != null && <span className="text-[11px] text-muted-foreground nums">{count}</span>}
      </div>
      <div className={cn("min-w-0", scroll && "flex-1 min-h-0 overflow-y-auto tinybar")}>{children}</div>
    </div>
  );
}

function InboxRow({ c, ctx, reload }: { c: KCard; ctx: RowCtx; reload: () => void }) {
  const [busy, setBusy] = useState(false);
  const r = relDue(c.due);
  const done = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await api.boardOp(TASKS_PATH, "toggle", { raw: c.raw });
      toast("Marked done", { description: c.text.slice(0, 60) });
      reload(); ctx.reload();
    } catch { toast.error("Couldn't update"); } finally { setBusy(false); }
  };
  return (
    <div className="flex items-start gap-2 py-2 -mx-2 px-2 rounded hover:bg-accent/40 transition-colors min-w-0">
      <button onClick={() => ctx.openBoard(TASKS_PATH, "Planning", false)} title="Open the planning board"
        className="min-w-0 flex-1 text-left flex items-start gap-3 group py-0.5">
        <span className="mt-1 w-1.5 h-3 rounded-sm shrink-0" style={{ background: prioColor(c.priority) }} />
        <span className="min-w-0 flex-1 text-[13.5px] leading-snug group-hover:text-primary transition-colors line-clamp-2 break-words">{c.text}</span>
        {r && <span className="text-[11px] nums shrink-0 mt-1" style={{ color: toneColor(r.tone) }}>{r.label}</span>}
      </button>
      <Button variant="ghost" size="sm" className="h-7 px-2 gap-1 text-[11.5px] text-muted-foreground hover:text-foreground shrink-0"
        onClick={done} disabled={busy} title="Mark done" aria-label={`Done: ${c.text}`}>
        <Check size={13} />
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------- ambient header
const WEATHER_ICON = {
  clear: Sun, partly: CloudSun, overcast: Cloud, fog: CloudFog,
  drizzle: CloudDrizzle, rain: CloudRain, snow: CloudSnow, storm: CloudLightning,
} as const;

// each condition gets its own muted icon tint so the chip carries the weather
const WEATHER_TINT: Record<string, string> = {
  clear: "hsl(42 75% 45%)", partly: "hsl(42 50% 50%)", overcast: "hsl(30 6% 55%)",
  fog: "hsl(40 10% 60%)", drizzle: "hsl(205 40% 50%)", rain: "hsl(205 50% 45%)",
  snow: "hsl(208 45% 55%)", storm: "hsl(215 45% 45%)",
};

function WeatherChip({ w }: { w: NonNullable<import("@/lib/api").Ambient["weather"]> }) {
  const I = WEATHER_ICON[w.kind] ?? Cloud;
  return (
    <div className="flex items-center gap-1.5 text-[12px] nums px-2.5 py-1.5 rounded-full border border-border bg-card/50"
         title={`Feels ${w.feelsC}° · high ${w.hiC ?? "–"}° / low ${w.loC ?? "–"}°`}>
      <I size={13} style={{ color: WEATHER_TINT[w.kind] ?? "hsl(30 6% 55%)" }} />
      <span className="text-foreground font-medium">{w.tempC}°</span>
      <span className="text-muted-foreground">{w.label}</span>
    </div>
  );
}

function DaylightArc({ sun }: { sun: AmbientSun }) {
  const dc = useDatumCursor(1, { start: 0 });
  if (!sun.sunrise || !sun.sunset) return null;
  const sr = new Date(sun.sunrise), ss = new Date(sun.sunset);
  if (isNaN(sr.getTime()) || isNaN(ss.getTime())) return null;
  const now = new Date();
  const t = Math.max(0, Math.min(1, (now.getTime() - sr.getTime()) / (ss.getTime() - sr.getTime())));
  const up = now >= sr && now <= ss;
  const bx = (u: number) => (1 - u) * (1 - u) * 3 + 2 * (1 - u) * u * 42 + u * u * 81;
  const by = (u: number) => (1 - u) * (1 - u) * 20 + 2 * (1 - u) * u * -8 + u * u * 20;
  const hm = (d: Date) => d.toTimeString().slice(0, 5);
  const len = ss.getTime() - sr.getTime();
  const dayLen = `${Math.floor(len / 3600000)}h ${Math.round((len % 3600000) / 60000)}m`;
  const left = up ? ss.getTime() - now.getTime() : 0;
  const leftTxt = `${Math.floor(left / 3600000)}h ${Math.round((left % 3600000) / 60000)}m`;
  return (
    <div {...dc.surface} aria-label={`Sunrise ${hm(sr)}, sunset ${hm(ss)}, ${dayLen} of daylight`}
         className={cn("flex items-center px-2 py-1 rounded-full border bg-card/50 transition-colors focus-visible:!bg-card/50",
           dc.active != null ? "border-foreground/40" : "border-border")}>
      <svg {...dc.mark(0)} width="76" height="22" viewBox="0 0 84 24" className="overflow-visible">
        <line x1="0" y1="20" x2="84" y2="20" stroke="hsl(var(--border) / 0.7)" strokeWidth="1" />
        <path d="M3,20 Q42,-8 81,20" fill="none" stroke="hsl(var(--muted-foreground) / 0.35)" strokeWidth="1.5" />
        <path d="M3,20 Q42,-8 81,20" fill="none" stroke="hsl(var(--primary) / 0.7)" strokeWidth="1.5"
              pathLength={1} strokeDasharray={`${t} 1`} />
        <circle cx={bx(t)} cy={by(t)} r="2.6"
                fill={up ? "hsl(var(--primary))" : "hsl(var(--muted-foreground) / 0.6)"} />
      </svg>
      <ChartTip cursor={dc}>{dc.active != null && (
        <>Sunrise {hm(sr)} · Sunset {hm(ss)} · {dayLen} of daylight{up ? ` · ${leftTxt} left` : ""}</>
      )}</ChartTip>
    </div>
  );
}

// ---------------------------------------------------------------- helpers
async function snoozeAllOverdue(overdue: TLItem[], reload: () => void) {
  const tomorrow = new Date(); tomorrow.setHours(0, 0, 0, 0); tomorrow.setDate(tomorrow.getDate() + 1);
  const iso = tomorrow.toISOString().slice(0, 10);
  let okCount = 0;
  for (const it of overdue) {
    if (!it.raw) continue;
    const m = it.raw.match(/^(\s*)-\s*\[[ xX]\]\s*(.*)$/);
    if (!m) continue;
    let body = m[2].replace(/\s*@due[\(\{][^)\}]+[\)\}]/g, "").replace(/\b20\d{2}-\d{2}-\d{2}\b/g, "").trim();
    body = `${body} @due(${iso})`.replace(/\s+/g, " ").trim();
    try { await api.boardOp(it.path, "edit", { raw: it.raw, body }); okCount++; } catch { /* keep going */ }
  }
  toast(`Snoozed ${okCount}/${overdue.length} task${okCount === 1 ? "" : "s"} to tomorrow`);
  reload();
}

function SectionLabel({ children, icon }: { children: React.ReactNode; icon?: React.ReactNode }) {
  return (
    <div className="text-[11px] uppercase tracking-[0.09em] font-semibold text-muted-foreground mb-3 flex items-center gap-1.5">
      {icon}{children}
    </div>
  );
}

function EmptyLine({ children }: { children: React.ReactNode }) {
  return <div className="text-[13px] text-muted-foreground py-2">{children}</div>;
}

function EventRow({ e, showDate, onResolve }: { e: Event; showDate?: boolean; onResolve?: (e: Event, done: boolean) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const done = e.completed;
  const tick = async () => {
    if (busy || !onResolve) return;
    setBusy(true);
    try { await onResolve(e, !done); } finally { setBusy(false); }
  };
  return (
    <div className={`flex items-start gap-3 py-2.5 group hover:bg-accent/40 -mx-2 px-2 rounded transition-colors ${busy || done ? "opacity-60" : ""}`}>
      {/* round tick = resolve; recurring events keep the plain dot (one file
          backs the whole series) */}
      {onResolve && !e.recurring ? (
        <button onClick={tick} disabled={busy} title={done ? "Reopen" : "Resolve — mark it handled"}
          aria-label={`${done ? "Reopen" : "Resolve"}: ${e.title}`}
          className={`mt-0.5 shrink-0 h-[15px] w-[15px] rounded-full border-2 grid place-items-center transition-colors ${done
            ? "border-[hsl(152_30%_44%)] bg-[hsl(152_30%_44%)] text-white"
            : "border-muted-foreground/40 hover:border-primary hover:bg-primary/10"}`}>
          {done && <Check size={9} strokeWidth={3.5} />}
        </button>
      ) : (
        <span className="mt-1 w-1.5 h-1.5 rounded-full shrink-0" style={{ background: categoryColor(e.category) }} />
      )}
      <button onClick={() => api.open(e.path)} className="min-w-0 flex-1 text-left">
        <span className={`block text-[13.5px] leading-snug break-words transition-colors ${done ? "text-muted-foreground line-through decoration-muted-foreground/40" : "group-hover:text-primary"}`}>{e.title}</span>
        <span className="text-[11px] text-muted-foreground nums mt-0.5 block">
          {showDate && <span className="capitalize">{e.category} · {e.date.slice(5)}</span>}
          {!showDate && <span className="capitalize">{e.category}</span>}
          {!e.allDay && e.startTime && <span> · {fmtTime(e.startTime)}{e.endTime ? "–" + fmtTime(e.endTime) : ""}</span>}
          {done && <span> · resolved</span>}
        </span>
      </button>
      <JoinButton e={e} />
    </div>
  );
}

/* a task row opens its smart destination; in a focused view it carries its own
 * done / reschedule actions beside the row */
function TaskRow({ it, ctx, showDate, actions }: { it: TLItem; ctx: RowCtx; showDate?: boolean; actions?: boolean }) {
  const r = relDue(it.due);
  const est = estOf(it);
  const dest = taskDest(it, ctx.openBoard, ctx.go);
  const body = (
    <>
      <span className="mt-1 w-1.5 h-3 rounded-sm shrink-0" style={{ background: prioColor(it.priority) }} />
      <span className="min-w-0 flex-1">
        <span className="block text-[13.5px] leading-snug group-hover:text-primary transition-colors line-clamp-2 break-words">{it.text}</span>
        <span className="text-[11px] text-muted-foreground nums mt-0.5 block capitalize">
          {it.board}{showDate ? " · " + it.due.slice(5) : ""}{est > 0 ? ` · ≈${fmtEst(est)}` : ""}
          {/* where the row actually goes — the smart destination, not the board */}
          {dest.smart && <span className="normal-case text-primary/85"> · {dest.label}</span>}
        </span>
      </span>
      {r && <span className="text-[11px] nums shrink-0 mt-1" style={{ color: toneColor(r.tone) }}>{r.label}</span>}
    </>
  );
  if (!actions) {
    return (
      <button onClick={dest.onClick}
        className="w-full text-left flex items-start gap-3 py-2.5 group hover:bg-accent/40 -mx-2 px-2 rounded transition-colors">
        {body}
      </button>
    );
  }
  return (
    <div className="flex items-start gap-2 py-2 -mx-2 px-2 rounded hover:bg-accent/40 transition-colors min-w-0">
      <button onClick={dest.onClick} className="min-w-0 flex-1 text-left flex items-start gap-3 group py-0.5">
        {body}
      </button>
      <TaskActions it={it} reload={ctx.reload} />
    </div>
  );
}
