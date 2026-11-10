
import { useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Card } from "@/components/ui/card";
import { WidgetFrame, useWidget, rowCap } from "@/components/ui/widget";
import { openWidgetFocus } from "@/lib/arrownav";
import type { WidgetState } from "@/components/ui/widget";
import { useApi } from "@/lib/hooks";
import { api } from "@/lib/api";
import type { ArchiveData } from "@/lib/api";
import { useDatumCursor, ChartTip } from "@/components/charts/datum";
import { Milestone, FileText, CircleCheck, Flag } from "lucide-react";

const DONE_GREEN = "hsl(152 30% 44%)";

function fmtHours(minutes: number) {
  return minutes >= 60 ? `${Math.round(minutes / 6) / 10}h` : `${minutes}m`;
}
function monthLabel(iso: string) {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en", { month: "long", year: "numeric" });
}
function shortDate(iso: string) {
  return new Date(iso + "T00:00:00").toLocaleDateString("en", { month: "short", day: "numeric" });
}
function relTouched(mtime: number) {
  const days = Math.floor((Date.now() / 1000 - mtime) / 86400);
  return days <= 0 ? "today" : days === 1 ? "yesterday" : days < 30 ? `${days}d ago` : `${Math.floor(days / 30)}mo ago`;
}
// 600px and up: room for the secondary columns
const roomy = (w: WidgetState | null) => !w || w.size === "md" || w.size === "lg" || w.size === "xl";

const STATUS_META: Record<string, { label: string; cls: string }> = {
  under_review: { label: "Under review", cls: "bg-primary/10 text-primary" },
  draft: { label: "Draft", cls: "bg-secondary text-muted-foreground" },
  published: { label: "Published", cls: "bg-[hsl(152_30%_44%/0.12)] text-[hsl(152_30%_34%)] dark:text-[hsl(152_30%_60%)]" },
};
const KIND_ICON: Record<string, ReactNode> = {
  milestone: <Flag size={11} />,
  deadline: <CircleCheck size={11} />,
  project: <Milestone size={11} />,
};

export function InsightsArchive() {
  const arc = useApi<ArchiveData>(() => api.insightsArchive());
  const d = arc.data;
  if (!d) {
    return <div className="grid gap-4">{[0, 1, 2].map((i) => <div key={i} className="h-32 animate-pulse bg-muted/40 rounded-xl" />)}</div>;
  }

  const months: { month: string; items: typeof d.timeline }[] = [];
  for (const it of d.timeline) {
    const m = monthLabel(it.date);
    if (!months.length || months[months.length - 1].month !== m) months.push({ month: m, items: [] });
    months[months.length - 1].items.push(it);
  }
  const seeds = d.pipeline.filter((p) => p.status === "draft" && p.words < 1000).length;
  const drafts = d.pipeline.filter((p) => p.status === "draft" && p.words >= 1000).length;
  const chainsDone = d.chains.filter((c) => c.done).length;
  const est = d.kpis.estMinutes ? fmtHours(d.kpis.estMinutes) : "";

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
      <WidgetFrame id="insights.archive-totals" title="Archive totals" className="lg:col-span-2">
        <KpiGrid
          main={[
            { n: String(d.kpis.underReview), label: "Under review", tip: `${d.kpis.underReview} under review · ${d.kpis.published} published` },
            { n: String(d.kpis.milestonesDone), label: "Milestones reached", tip: `${d.kpis.milestonesDone} of ${d.kpis.goalsTotal} milestones reached` },
            { n: d.kpis.tasksDone.toLocaleString(), label: "Tasks completed", tip: `${d.kpis.tasksDone.toLocaleString()} tasks completed${est ? ` · ${est} estimated` : ""}` },
            { n: String(chainsDone), label: "Chains complete", tip: `${chainsDone} of ${d.chains.length} chains complete` },
          ]}
          extra={[
            { n: String(d.kpis.published), label: "Published", tip: `${d.kpis.published} published` },
            { n: String(drafts), label: "Drafts", tip: `${drafts} drafts in progress${seeds ? ` · ${seeds} idea-stage` : ""}` },
            { n: est || "—", label: "Estimated effort", tip: est ? `${est} estimated effort on completed tasks` : "no estimates yet" },
            { n: String(d.chains.length - chainsDone), label: "In flight", tip: `${d.chains.length - chainsDone} chains in flight` },
            { n: String(d.timeline.length), label: "Archived entries", tip: `${d.timeline.length} archived entries` },
          ]}
          meters={[
            { label: "Milestones reached", value: d.kpis.milestonesDone, total: d.kpis.goalsTotal },
            { label: "Chains complete", value: chainsDone, total: d.chains.length },
            { label: "Manuscripts out", value: d.kpis.underReview + d.kpis.published, total: d.pipeline.filter((p) => p.status !== "draft" || p.words >= 1000).length,
              tip: `Manuscripts under review or published · ${d.kpis.underReview + d.kpis.published} of ${d.pipeline.filter((p) => p.status !== "draft" || p.words >= 1000).length}` },
          ]} />
      </WidgetFrame>

      <InsightPanel title="Manuscript pipeline" wide measure="list">
        <Pipeline items={d.pipeline} seeds={seeds} />
      </InsightPanel>

      {/* completed project chains, milestone by milestone */}
      <InsightPanel title="Project chains" measure="wide">
        <Chains chains={d.chains} />
      </InsightPanel>

      {/* weekly output rhythm */}
      <InsightPanel title="Weekly output" chart>
        <Weekly weekly={d.weekly} />
      </InsightPanel>

      {/* where the completed effort went */}
      <InsightPanel title="By focus" chart>
        {d.tags.length > 0 && (
          <Bars rows={d.tags.map(([t, n]) => ({ label: t, value: n }))} unit="task"
            aria={`Completed tasks by focus: ${d.tags.map(([t, n]) => `${t} ${n}`).join(", ")}`} />
        )}
        {d.tags.length === 0 && <div className="text-[12.5px] text-muted-foreground">No tagged completions yet.</div>}
      </InsightPanel>

      {/* the achievement log, month by month */}
      <InsightPanel title="Achievement log" wide measure="wide">
        <AchievementLog months={months} />
      </InsightPanel>

      {/* the most recent completions, day-dated */}
      <InsightPanel title="Recently completed" wide measure="wide">
        <RecentTasks tasks={d.recentTasks} />
      </InsightPanel>
    </div>
  );
}

/* ------------------------------------------------------------ archive bodies */

// in a widget "+N more" opens its focused view on the first hidden row; elsewhere the rows show here
function MoreButton({ hidden, onClick }: { hidden: number; onClick: () => void }) {
  if (hidden <= 0) return null;
  return (
    <button onClick={(e) => { if (!openWidgetFocus(e.currentTarget)) onClick(); }} title="Open the full view" className="text-left text-[11.5px] text-muted-foreground/70 hover:text-foreground transition-colors">
      + {hidden} more
    </button>
  );
}

function Pipeline({ items, seeds }: { items: ArchiveData["pipeline"]; seeds: number }) {
  const w = useWidget();
  const [allDrafts, setAllDrafts] = useState(false);
  const [more, setMore] = useState(false);
  const list = allDrafts ? items : items.filter((p) => p.status !== "draft" || p.words >= 1000);
  const shown = list.slice(0, more ? Infinity : rowCap(w, 6, 10));
  const label = !w || w.size !== "xs";
  const nums = roomy(w);
  // a focused view spreads the manuscripts down the page, one to a row
  const focused = !!w?.focused;
  const body = shown.map((p) => {
        const s = STATUS_META[p.status] || STATUS_META.draft;
        return (
          <div key={`${p.slug}:${p.doc}`} className="flex items-center gap-3 py-1.5 border-b border-border/40 last:border-0 min-w-0">
            <FileText size={13} className="shrink-0 text-muted-foreground/60" />
            <span className="text-[13px] truncate flex-1 min-w-0 group-data-[focused]/widget:text-[14px]" title={p.title}>{p.title}</span>
            {label && <span className="text-[11px] text-muted-foreground shrink-0">{p.label}</span>}
            {nums && <span className="text-[11px] text-muted-foreground/70 nums shrink-0 w-20 text-right">{p.words.toLocaleString()} words</span>}
            {nums && <span className="text-[11px] text-muted-foreground/70 nums shrink-0 w-16 text-right">{relTouched(p.mtime)}</span>}
            <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-medium ${s.cls}`}>{s.label}</span>
          </div>
        );
      });
  return (
    <div className="grid gap-0.5">
      {focused
        ? <BarRows n={body.length} rowMin={32} rowMax={48} extra={34} align="start">{body}</BarRows>
        : <div className="grid gap-0.5">{body}</div>}
      {items.length === 0 && <div className="text-[12.5px] text-muted-foreground py-2">No manuscripts yet.</div>}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-1.5">
        <MoreButton hidden={list.length - shown.length} onClick={() => setMore(true)} />
        {seeds > 0 && (
          <button onClick={() => setAllDrafts((v) => !v)}
            className="text-left text-[11.5px] text-muted-foreground/70 hover:text-foreground transition-colors">
            {allDrafts ? "Hide idea-stage drafts" : `+ ${seeds} idea-stage drafts (under 1,000 words)`}
          </button>
        )}
      </div>
    </div>
  );
}

function Chains({ chains }: { chains: ArchiveData["chains"] }) {
  const w = useWidget();
  const focused = !!w?.focused;
  const [more, setMore] = useState(false);
  const shown = chains.slice(0, more ? Infinity : rowCap(w, 2, 4));
  const msCap = focused || more ? Infinity : 5;
  // a focused view lays the chains side by side
  const cols = !focused || !w ? "grid-cols-1 gap-4" : w.size === "xl" ? "grid-cols-3 gap-x-8 gap-y-6" : w.size === "lg" || w.size === "md" ? "grid-cols-2 gap-x-8 gap-y-6" : "grid-cols-1 gap-4";
  return (
    <div className="grid gap-3">
      <div className={`grid items-start ${cols}`}>
        {shown.map((c) => (
          <div key={`${c.slug}:${c.finalizedAt}`} className="min-w-0">
            <div className="flex items-center gap-2 mb-1.5 min-w-0">
              <Milestone size={13} className="text-muted-foreground shrink-0" />
              <span className="text-[13px] font-medium capitalize truncate min-w-0" title={c.title || c.slug}>{c.title || c.slug}</span>
              <span className="ml-auto shrink-0 text-[10.5px] rounded-full px-2 py-0.5 font-medium"
                style={c.done ? { background: "hsl(152 30% 44% / 0.12)", color: DONE_GREEN } : undefined}>
                {c.done ? `complete · ${c.completedOn ? shortDate(c.completedOn) : ""}` : "in flight"}
              </span>
            </div>
            <div className="grid gap-1 pl-1">
              {c.milestones.slice(0, msCap).map((m, i) => (
                <div key={i} className="flex items-center gap-2.5 text-[12.5px] min-w-0">
                  <span className={`shrink-0 h-2 w-2 rotate-45 ${m.done ? "bg-[hsl(152_30%_44%)]" : "border border-muted-foreground/60"}`} />
                  <span className={`truncate min-w-0 ${m.done ? "text-muted-foreground line-through decoration-muted-foreground/40" : ""}`} title={m.title}>{m.title}</span>
                  {m.date && <span className="ml-auto shrink-0 text-[11px] nums text-muted-foreground">{m.date}</span>}
                </div>
              ))}
              {c.milestones.length > msCap && (
                <span className="pl-[18px] text-[11px] text-muted-foreground/70 nums">+ {c.milestones.length - msCap} milestones</span>
              )}
            </div>
          </div>
        ))}
      </div>
      {chains.length === 0 && <div className="text-[12.5px] text-muted-foreground">No project chains yet.</div>}
      <MoreButton hidden={chains.length - shown.length} onClick={() => setMore(true)} />
    </div>
  );
}

function Weekly({ weekly }: { weekly: ArchiveData["weekly"] }) {
  const w = useWidget();
  const focused = !!w?.focused;
  const ref = useRef<HTMLDivElement>(null);
  const fill = useFillHeight(ref);
  const H = focused ? Math.max(160, Math.min(1600, (fill || 311) - 8)) : 110;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const last = weekly.length - 1;
  const cur = last >= 0 && (today.getTime() - new Date(weekly[last].week + "T00:00:00").getTime()) / 864e5 < 7 ? last : -1;
  const tip = (i: number) => {
    const x = weekly[i];
    return (
      <span>
        <span className="font-medium">Week of {shortDate(x.week)}{i === cur ? " (this week)" : ""}</span>
        <span className="ml-2 text-muted-foreground">{x.count} task{x.count === 1 ? "" : "s"}{x.minutes ? ` · ${fmtHours(x.minutes)}` : ""}</span>
      </span>
    );
  };
  return (
    <div ref={ref}>
      <Columns items={weekly.map((x) => ({ value: x.count }))} height={H} tip={tip} current={cur}
        aria={`Tasks completed per week, ${weekly.length} weeks: ${weekly.map((x) => `${shortDate(x.week)} ${x.count}`).join(", ")}`} />
    </div>
  );
}

function AchievementLog({ months }: { months: { month: string; items: ArchiveData["timeline"] }[] }) {
  const w = useWidget();
  const focused = !!w?.focused;
  const [more, setMore] = useState(false);
  const cap = more ? Infinity : rowCap(w, 8, 14);
  const shown: typeof months = [];
  let left = cap;
  for (const mo of months) {
    if (left <= 0) break;
    const items = mo.items.slice(0, left);
    left -= items.length;
    shown.push({ month: mo.month, items });
  }
  const total = months.reduce((n, m) => n + m.items.length, 0);
  const visible = shown.reduce((n, m) => n + m.items.length, 0);
  const size = w?.size ?? "md";
  const cols = size === "xl" ? (focused ? "grid-cols-3" : "grid-cols-2") : size === "lg" ? "grid-cols-2" : "grid-cols-1";
  const kindText = size !== "xs";
  return (
    <div className="grid gap-3">
      <div className={`grid items-start gap-x-8 gap-y-3 ${cols}`}>
        {shown.map((mo) => (
          <div key={mo.month} className="min-w-0">
            <div className="text-[11px] uppercase tracking-[0.09em] font-semibold text-muted-foreground/70 mb-1.5">{mo.month}</div>
            <div className="grid gap-1">
              {mo.items.map((it, i) => (
                <div key={i} className="flex items-center gap-2.5 text-[12.5px] min-w-0">
                  <span className="shrink-0 w-14 text-[11px] nums text-muted-foreground">{shortDate(it.date)}</span>
                  <span className="shrink-0 inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-[10.5px] text-muted-foreground capitalize" title={it.kind}>
                    {KIND_ICON[it.kind] || <CircleCheck size={11} />}{kindText && <> {it.kind}</>}
                  </span>
                  <span className="truncate min-w-0" title={it.title}>{it.title}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      {months.length === 0 && <div className="text-[12.5px] text-muted-foreground">Nothing archived yet — tick a goal or resolve a deadline and it lands here.</div>}
      <MoreButton hidden={total - visible} onClick={() => setMore(true)} />
    </div>
  );
}

// a focused table spreads its rows down the page; a tile flows them in one or two columns
function TaskRows({ detail, n, cols, children }: { detail: boolean; n: number; cols: string; children: ReactNode }) {
  return detail
    ? <BarRows n={n} rowMin={36} rowMax={60} align="start">{children}</BarRows>
    : <div className={`grid gap-y-1 ${cols}`}>{children}</div>;
}

function RecentTasks({ tasks }: { tasks: ArchiveData["recentTasks"] }) {
  const w = useWidget();
  const [more, setMore] = useState(false);
  const shown = tasks.slice(0, more ? Infinity : rowCap(w, 6, 10));
  const focused = !!w?.focused;
  // a focused view reads as one table (lane and tags in their own columns); a wide tile runs two columns
  const detail = focused && roomy(w);
  // the lane column earns its place only when the lanes differ
  const lanes = new Set(tasks.map((t) => t.lane || "")).size > 1;
  const cols = w?.size === "xl" && !focused ? "grid-cols-2 gap-x-8" : "grid-cols-1";
  return (
    <div className="grid gap-3">
      <TaskRows detail={detail} n={shown.length} cols={cols}>
        {shown.map((t, i) => (
          <div key={i} className={`flex items-center gap-2.5 min-w-0 ${detail ? "text-[14px] py-2 border-b border-border/40 last:border-0" : "text-[12.5px]"}`}>
            <span className={`shrink-0 nums text-muted-foreground ${detail ? "w-16 text-[12px]" : "w-14 text-[11px]"}`}>{t.due ? shortDate(t.due) : ""}</span>
            <CircleCheck size={detail ? 14 : 12} className="shrink-0" style={{ color: DONE_GREEN }} />
            <span className={`truncate flex-1 min-w-0 ${detail ? "text-foreground/85" : "text-muted-foreground"}`} title={t.text}>{t.text}</span>
            {detail && lanes && <span className="shrink-0 w-40 truncate text-[12px] text-muted-foreground" title={t.lane || undefined}>{t.lane || ""}</span>}
            {detail && w?.size === "xl" && (
              <span className="shrink-0 w-64 flex items-center gap-1.5 overflow-hidden">
                {t.tags.slice(0, 3).map((g) => <span key={g} className="shrink-0 rounded bg-secondary px-1.5 py-0.5 text-[11px] text-muted-foreground">{g}</span>)}
              </span>
            )}
            {(t.est != null || detail) && <span className={`shrink-0 nums text-muted-foreground/70 ${detail ? "w-12 text-right text-[12px]" : "text-[11px]"}`}>{t.est != null ? fmtHours(t.est) : ""}</span>}
          </div>
        ))}
      </TaskRows>
      {tasks.length === 0 && <div className="text-[12.5px] text-muted-foreground">No dated completions yet.</div>}
      <MoreButton hidden={tasks.length - shown.length} onClick={() => setMore(true)} />
    </div>
  );
}

/* ------------------------------------------------- shared with Insights.tsx */

/** a stat tile: the number and a word or two. `tip` is everything else about it (the old
 *  sub-line); `share` (0..1) draws a meter under the number instead of saying the percent twice */
export type KpiT = { n: string; label: string; tip?: string; share?: number };
/** a share of a whole, drawn as a meter in the focused view (skipped when total is 0) */
export type MeterT = { label: string; value: number; total: number; tip?: string };

export const SOLID = "hsl(var(--primary) / 0.88)";
export const FAINT = "hsl(var(--primary) / 0.22)";
export const EMPTY = "hsl(var(--muted))";
export const ACTIVE_RING = "2px solid hsl(var(--foreground) / 0.8)";
const pctOf = (v: number, t: number) => (t ? Math.round((100 * v) / t) : 0);
const kpiTip = (k: KpiT) => k.tip ?? `${k.n} · ${k.label}`;
const meterTip = (m: MeterT) => m.tip ?? `${m.label} · ${m.value.toLocaleString()} of ${m.total.toLocaleString()} (${pctOf(m.value, m.total)}%)`;

/** in a focused view, the height left from this element's top to the bottom of the page,
 *  less the frame's and the enclosing [data-fill-card]'s bottom padding; 0 in a tile */
export function useFillHeight(ref: React.RefObject<HTMLElement | null>, extra = 0) {
  const w = useWidget();
  const focused = !!w?.focused;
  const [h, setH] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    const f = el?.closest<HTMLElement>("[data-knav-widget]");
    if (!focused || !el || !f) { setH(0); return; }
    const padB = (x: HTMLElement | null) => {
      if (!x) return 0;
      const cs = getComputedStyle(x);
      return parseFloat(cs.paddingBottom) + parseFloat(cs.borderBottomWidth);
    };
    const top = el.getBoundingClientRect().top - f.getBoundingClientRect().top + f.scrollTop;
    const next = Math.max(0, Math.floor(f.clientHeight - top - padB(f) - padB(el.closest<HTMLElement>("[data-fill-card]")) - extra));
    setH((p) => (Math.abs(p - next) < 2 ? p : next));
  }, [focused, w?.width, w?.height, extra]);   // eslint-disable-line react-hooks/exhaustive-deps
  return h;
}

export function KpiGrid({ main, extra, meters }: { main: KpiT[]; extra?: KpiT[]; meters?: MeterT[] }) {
  const w = useWidget();
  const focused = !!w?.focused;
  const size = w?.size ?? "md";
  const narrow = size === "xs" || size === "sm";
  const extraCols = size === "xs" ? "grid-cols-2" : size === "sm" ? "grid-cols-3" : "grid-cols-5";
  const shares = focused ? (meters || []).filter((m) => m.total > 0) : [];
  const ex = focused ? extra || [] : [];
  // one cursor over every tile and meter, in reading order: main, meters, extras
  const tips = [...main.map(kpiTip), ...shares.map(meterTip), ...ex.map(kpiTip)];
  const dc = useDatumCursor(tips.length, { start: 0 });
  const tip = <ChartTip cursor={dc}>{dc.active != null && tips[dc.active]}</ChartTip>;
  const kpi = (k: KpiT, i: number, v?: "big" | "small") => (
    <InsightKpi key={k.label} {...k} big={v === "big"} small={v === "small"} mark={dc.mark(i)} active={dc.active === i} />
  );
  if (!focused) {
    return (
      <div {...dc.surface} aria-label={tips.join("; ")} className={`grid rounded-lg ${roomy(w) ? "grid-cols-4 gap-5" : "grid-cols-2 gap-3"}`}>
        {main.map((k, i) => kpi(k, i))}
        {tip}
      </div>
    );
  }
  return (
    <Card data-fill-card className="h-full min-h-fit flex flex-col gap-5 p-6 group-data-[size=xs]/widget:p-4 group-data-[size=xs]/widget:gap-3">
      <div className="text-[13px] uppercase tracking-[0.08em] font-semibold text-muted-foreground">{w?.title}</div>
      <div {...dc.surface} aria-label={tips.join("; ")} className="flex-1 flex flex-col gap-5 rounded-lg group-data-[size=xs]/widget:gap-3">
        <div className={`grid flex-[3] ${roomy(w) ? "grid-cols-4 gap-5 min-h-[150px]" : "grid-cols-2 gap-3"}`}>
          {main.map((k, i) => kpi(k, i, "big"))}
        </div>
        {shares.length > 0 && (
          <div className={`grid flex-[2] content-center gap-x-10 gap-y-5 ${narrow ? "grid-cols-1" : shares.length >= 3 ? "grid-cols-3" : shares.length === 2 ? "grid-cols-2" : "grid-cols-1"}`}>
            {shares.map((m, j) => <InsightMeter key={m.label} {...m} mark={dc.mark(main.length + j)} active={dc.active === main.length + j} />)}
          </div>
        )}
        {ex.length > 0 && (
          <div className={`grid flex-[2] gap-3 ${extraCols} ${narrow ? "" : "min-h-[104px]"}`}>
            {ex.map((k, j) => kpi(k, main.length + shares.length + j, "small"))}
          </div>
        )}
      </div>
      {tip}
    </Card>
  );
}

export function InsightKpi({ n, label, share, big, small, mark, active }: KpiT & {
  big?: boolean; small?: boolean; mark?: { "data-datum": number }; active?: boolean;
}) {
  const w = useWidget();
  // the hero number scales with the widget: four across a quarter tile is a narrow card
  const large = w?.size === "lg" || w?.size === "xl";
  return (
    <Card {...mark} style={active ? { outline: ACTIVE_RING, outlineOffset: 1 } : undefined}
      className={`min-w-0 flex flex-col ${big || small ? "justify-center" : ""} ${big ? (large ? "p-7" : "p-4") : small ? (large ? "p-5" : "p-3.5") : "p-4"}`}>
      <div className={`${small ? (large ? "text-[30px]" : "text-[22px]") : big ? (large ? "text-[60px]" : "text-[30px]") : "text-[30px]"} font-semibold leading-none break-words nums`}>{n}</div>
      <div className={`${big ? "text-[16px] mt-3" : small ? "text-[14px] mt-2" : "text-[12px] mt-1.5"} text-muted-foreground truncate`}>{label}</div>
      {share != null && (
        <div className={`${big ? "mt-4 h-2" : "mt-2.5 h-1.5"} rounded-full overflow-hidden`} style={{ background: FAINT }}>
          <div className="h-full rounded-full" style={{ width: `${Math.max(share > 0 ? 2 : 0, Math.min(100, share * 100))}%`, background: SOLID }} />
        </div>
      )}
    </Card>
  );
}

/** a share of the whole: its name over a meter; the unfilled track is the same hue, lighter.
 *  The percent and the counts are the tooltip. */
function InsightMeter({ label, value, total, mark, active }: MeterT & { mark: { "data-datum": number }; active: boolean }) {
  const pct = pctOf(value, total);
  return (
    <div {...mark} className="min-w-0 py-1">
      <div className={`mb-2 text-[14px] truncate ${active ? "text-foreground" : "text-muted-foreground"}`}>{label}</div>
      <div className="h-3 rounded" style={{ background: FAINT, outline: active ? ACTIVE_RING : undefined, outlineOffset: 1 }}>
        <span className="block h-full" style={{ width: `${value > 0 ? Math.max(1, pct) : 0}%`, background: SOLID, borderRadius: pct >= 100 ? 4 : "4px 0 0 4px" }} />
      </div>
    </div>
  );
}

// a focused chart fills the page; a list keeps a readable measure on a very wide screen
const MEASURE = {
  chart: "group-data-[focused]/widget:max-w-none",
  list: "group-data-[focused]/widget:max-w-none",
  wide: "group-data-[focused]/widget:max-w-none",
} as const;

export function InsightPanel({ title, id, children, wide, measure = "chart", chart, legend }: {
  title: string; id?: string; children: ReactNode; wide?: boolean;
  measure?: keyof typeof MEASURE;
  /** a chart's body stretches down the focused page (lists stay top-aligned) */
  chart?: boolean;
  /** series key, beside the title */
  legend?: ReactNode;
}) {
  return (
    <WidgetFrame id={id || `insights.${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`} title={title} className={wide ? "lg:col-span-2" : ""}>
      <Card data-fill-card className="h-full p-6 group-data-[size=xs]/widget:p-4 group-data-[focused]/widget:h-auto group-data-[focused]/widget:min-h-full group-data-[focused]/widget:flex group-data-[focused]/widget:flex-col">
        <div className={`w-full mx-auto ${MEASURE[measure]} ${chart ? "group-data-[focused]/widget:flex-1 group-data-[focused]/widget:flex group-data-[focused]/widget:flex-col" : ""}`}>
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 mb-3.5 group-data-[focused]/widget:mb-5">
            <div className="text-[11px] uppercase tracking-[0.08em] font-semibold text-muted-foreground group-data-[focused]/widget:text-[13px]">{title}</div>
            {legend}
          </div>
          {children}
        </div>
      </Card>
    </WidgetFrame>
  );
}

// one label column per panel, as wide as its longest label (12px text, capped)
export const barLabelW = (rows: [string, number][]) =>
  Math.min(200, Math.max(64, Math.ceil(Math.max(0, ...rows.map(([l]) => String(l).length)) * 6.9) + 6));

/** a panel's bar rows. A tile flows them; a focused view spreads them down the page, each
 *  row clamp(24px, available / rows, 44px), in as many columns as the rows need to fit */
export function BarRows({ n, children, columns = false, rowMin = 24, rowMax = 44, extra = 0, align = "space-evenly" }: {
  n: number; children: ReactNode; columns?: boolean;
  rowMin?: number; rowMax?: number;
  /** room to keep below the rows (a button line) */
  extra?: number;
  align?: "space-evenly" | "start";
}) {
  const w = useWidget();
  const ref = useRef<HTMLDivElement>(null);
  const avail = useFillHeight(ref, extra);
  if (!w?.focused) return <div ref={ref}>{children}</div>;
  const maxCols = columns ? Math.max(1, Math.floor((w.width - 120) / 340)) : 1;
  const cols = Math.min(maxCols, Math.max(1, Math.ceil(n / Math.max(1, Math.floor((avail || 600) / (rowMin + 6))))));
  const per = Math.max(1, Math.ceil(n / cols));
  return (
    <div ref={ref} className="grid gap-x-10" style={{
      gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridAutoFlow: "column",
      gridTemplateRows: `repeat(${per}, minmax(${rowMin}px, ${rowMax}px))`, alignContent: align,
      height: avail ? Math.max(avail, per * rowMin) : undefined,
    }}>
      {children}
    </div>
  );
}

export type BarDatum = { label: string; value: number; read?: number };

export function Bars({ rows, unit, aria, wrap }: {
  rows: BarDatum[]; unit: string; aria: string;
  wrap?: (bars: ReactNode, n: number) => ReactNode;
}) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  const lw = barLabelW(rows.map((r) => [r.label, r.value]));
  const dc = useDatumCursor(rows.length, { start: 0 });
  const bars = rows.map((r, i) => (
    <InsightBar key={r.label} label={r.label} value={r.value} max={max} w={lw} read={r.read} mark={dc.mark(i)} active={dc.active === i} />
  ));
  const t = dc.active != null ? rows[dc.active] : null;
  return (
    <div {...dc.surface} aria-label={aria} className="rounded-md">
      {wrap ? wrap(bars, rows.length) : <BarRows n={rows.length}>{bars}</BarRows>}
      <ChartTip cursor={dc}>{t && barTip(t, unit)}</ChartTip>
    </div>
  );
}

export function barTip(t: BarDatum, unit: string) {
  if (t.read == null) {
    return <span><span className="font-medium">{t.label}</span><span className="ml-2 text-muted-foreground">{t.value.toLocaleString()} {unit}{t.value === 1 ? "" : "s"}</span></span>;
  }
  const r = Math.min(t.read, t.value);
  return (
    <span>
      <span className="font-medium">{t.label}</span>
      <span className="ml-2 text-muted-foreground">{t.value.toLocaleString()} · {r.toLocaleString()} read ({pctOf(r, t.value)}%)</span>
    </span>
  );
}

/** one bar: the total as a faint bar, the read part solid inside it from the left */
export function InsightBar({ label, value, max, w: labelWidth = 120, read, mark, active }: {
  label: string; value: number; max: number; w?: number; read?: number;
  mark?: { "data-datum": number }; active?: boolean;
}) {
  const wdg = useWidget();
  const big = !!wdg?.focused;
  const large = big && (wdg?.size === "lg" || wdg?.size === "xl");
  const pct = Math.max(1.5, (100 * value) / max);
  // focused type is 13-15px, so the label column grows with it; a narrow tile keeps room for the bar
  let lw = big ? Math.min(260, Math.round(labelWidth * (large ? 1.3 : 1.12))) : labelWidth;
  if (wdg?.size === "xs") lw = Math.min(lw, 120);
  const stacked = read != null;
  const r = Math.min(read ?? 0, value);
  return (
    <div {...mark}
      className={`grid items-center ${big ? "gap-4 h-full min-h-[24px] px-1" : "gap-2.5 py-[3px]"}`}
      style={{ gridTemplateColumns: `${lw}px minmax(0,1fr)` }}>
      <span className={`${large ? "text-[15px]" : big ? "text-[13px]" : "text-[12px]"} ${active ? "text-foreground" : "text-muted-foreground"} text-right truncate`}>{label}</span>
      <span className={`${large ? "h-3.5" : big ? "h-3" : "h-2"} relative`}>
        <span className="absolute inset-y-0 left-0 overflow-hidden" style={{
          width: pct + "%", background: stacked ? FAINT : SOLID, borderRadius: "0 4px 4px 0",
          outline: active ? ACTIVE_RING : undefined, outlineOffset: 1,
        }}>
          {stacked && r > 0 && <span className="absolute inset-y-0 left-0" style={{ width: `${Math.max(2, (100 * r) / value)}%`, background: SOLID }} />}
        </span>
      </span>
    </div>
  );
}

export type ColumnDatum = { value: number; read?: number };

export function Columns({ items, height, tip, aria, current = -1, label, start }: {
  items: ColumnDatum[]; height: number; tip: (i: number) => ReactNode; aria: string;
  current?: number; label?: (i: number) => string | null; start?: number;
}) {
  const w = useWidget();
  const focused = !!w?.focused;
  const gap = focused ? 8 : items.length > 18 ? 3 : 5;
  const max = Math.max(1, ...items.map((x) => x.value));
  const dc = useDatumCursor(items.length, { start });
  return (
    <div {...dc.surface} aria-label={aria} className="rounded-md">
      <div className="flex items-end" style={{ height, gap }}>
        {items.map((x, i) => {
          const h = x.value ? Math.max(3, Math.round((height * x.value) / max)) : 2;
          const rd = x.read != null ? Math.min(x.read, x.value) : null;
          const cur = i === current;
          return (
            <div key={i} {...dc.mark(i)} className="flex-1 min-w-0 h-full flex items-end justify-center">
              <div className={`relative w-full overflow-hidden ${focused ? "max-w-[56px]" : ""}`} style={{
                height: h, borderRadius: x.value ? "4px 4px 0 0" : 1,
                background: !x.value ? EMPTY : rd != null ? FAINT : cur ? "hsl(var(--primary) / 0.3)" : SOLID,
                boxShadow: cur && x.value ? "inset 0 0 0 1.5px hsl(var(--primary))" : undefined,
                outline: dc.active === i ? ACTIVE_RING : undefined, outlineOffset: 1,
              }}>
                {rd != null && rd > 0 && <div className="absolute inset-x-0 bottom-0" style={{ height: `${Math.max(2, (100 * rd) / x.value)}%`, background: SOLID }} />}
              </div>
            </div>
          );
        })}
      </div>
      {/* the week under way also gets a short foreground tick under its column */}
      {current >= 0 && (
        <div className="flex mt-1" style={{ gap }} aria-hidden>
          {items.map((_, i) => (
            <div key={i} className="flex-1 min-w-0 flex justify-center">
              {i === current && <span className="block h-[3px] w-3 rounded-full bg-foreground/70" />}
            </div>
          ))}
        </div>
      )}
      {label && (
        <div className="flex mt-1.5 text-[11px] text-muted-foreground nums group-data-[focused]/widget:text-[12.5px]" style={{ gap }}>
          {items.map((_, i) => (
            <span key={i} className="flex-1 min-w-0 text-center whitespace-nowrap overflow-visible">{label(i) ?? ""}</span>
          ))}
        </div>
      )}
      <ChartTip cursor={dc}>{dc.active != null && tip(dc.active)}</ChartTip>
    </div>
  );
}
