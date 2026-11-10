
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { DayStat } from "@/lib/api";
import { api } from "@/lib/api";
import { fmtDateLong } from "@/lib/format";
import { useWidget } from "@/components/ui/widget";
import { useDatumCursor, ChartTip } from "@/components/charts/datum";

const WEEKS = 53;
const ROWS = 7;
const PAD = 4;           // room for the active ring and the streak capsule
const MIN_STEP = 11;     // cell + gap, px
const MAX_STEP = 30;
const MAX_STEP_FOCUSED = 44;
const MAX_STEP_V = 24;
const CELL = 0.8;        // a cell's share of its step; the rest is the gap between days
const MONTH_GAP = 0.55;  // the extra gap between two months, as a share of a step
const STRIP = 96;        // the focused view's month strip, at most this deep
const STRIP_GAP = 14;    // grid to strip
// the surface keeps its focus ring clear of the cells and of the scroller's clip: 3px of
// scroller padding outside it, 4px of its own inside it
const RING_OUT = 3, RING_IN = 4, OFF = RING_OUT + RING_IN;

type Cell = { date: string; words: number; row: number; month: string; lc: number; mi: number };

const isoLocal = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function bucket(words: number, p95: number) {
  if (!words) return 0;
  const r = words / Math.max(p95, 200);
  if (r > 0.85) return 4;
  if (r > 0.55) return 3;
  if (r > 0.28) return 2;
  return 1;
}
const RAMP = [0, 0.3, 0.5, 0.72, 1];
const fill = (b: number) => (b === 0 ? "hsl(var(--muted))" : `hsl(var(--primary) / ${RAMP[b]})`);

const plural = (n: number, w: string) => `${n.toLocaleString()} ${w}${n === 1 ? "" : "s"}`;

type MonthSpan = { key: string; label: string; words: number; days: number; from: number; to: number };

function MonthStrip({ months, vertical, length, depth, thick, rx }: {
  months: MonthSpan[]; vertical: boolean; length: number; depth: number; thick: number; rx: number;
}) {
  const max = Math.max(1, ...months.map((m) => m.words));
  const dc = useDatumCursor(months.length, { start: months.length - 1 });
  const m = dc.active != null ? months[dc.active] : null;
  const W = vertical ? depth : length, H = vertical ? length : depth;
  const last = months.length - 1;
  return (
    <div style={{ padding: RING_OUT }}>
      <div {...dc.surface} className="rounded-lg" style={{ width: W + RING_IN * 2, padding: RING_IN }}
        aria-label={`Words per month: ${months.map((x) => `${x.label} ${x.words}`).join(", ")}`}>
        <svg width={W} height={H} style={{ display: "block", overflow: "visible" }}>
          {months.map((mo, i) => {
            const cur = i === last;
            const len = mo.words ? Math.max(4, ((depth - 2) * mo.words) / max) : 2;
            const mid = (mo.from + mo.to) / 2;
            const t = Math.min(thick, mo.to - mo.from);
            const r = Math.min(rx, len / 2, t / 2);
            const a = mid - t / 2, b = mid + t / 2;
            // square at the baseline, rounded at its far end
            const d = vertical
              ? `M0,${a}H${len - r}Q${len},${a} ${len},${a + r}V${b - r}Q${len},${b} ${len - r},${b}H0Z`
              : `M${a},${H}V${H - len + r}Q${a},${H - len} ${a + r},${H - len}H${b - r}Q${b},${H - len} ${b},${H - len + r}V${H}Z`;
            const tint = mo.words ? 0.3 + 0.7 * (mo.words / max) : 0;
            const act = dc.active === i;
            return (
              <g key={mo.key}>
                {/* the month's whole block is the target, not just the column */}
                <rect {...dc.mark(i)} x={vertical ? 0 : mo.from} y={vertical ? mo.from : 0}
                  width={vertical ? W : mo.to - mo.from} height={vertical ? mo.to - mo.from : H} fill="transparent" />
                <path d={d} pointerEvents="none"
                  fill={!mo.words ? "hsl(var(--muted))" : cur ? "hsl(var(--primary) / 0.2)" : `hsl(var(--primary) / ${tint.toFixed(2)})`}
                  stroke={act ? "hsl(var(--foreground) / 0.8)" : cur && mo.words ? "hsl(var(--primary))" : "none"}
                  strokeWidth={act ? 2 : 1.5} />
              </g>
            );
          })}
        </svg>
        <ChartTip cursor={dc}>{m && (
          <span><span className="font-medium">{m.label}{dc.active === last ? " (so far)" : ""}</span>
            <span className="ml-2 text-muted-foreground">{plural(m.words, "word")} · {plural(m.days, "writing day")}</span></span>
        )}</ChartTip>
      </div>
    </div>
  );
}

export function Heatmap({ days }: { days: DayStat[] }) {
  const [avail, setAvail] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const wdg = useWidget();
  const focused = !!wdg?.focused;

  // p95 keeps one massive day from washing out the rest
  const p95 = useMemo(() => {
    const ws = days.map((d) => d.words).filter((w) => w > 0).sort((a, b) => a - b);
    if (!ws.length) return 1;
    return ws[Math.floor(ws.length * 0.95)] || ws[ws.length - 1];
  }, [days]);

  const byDate = useMemo(() => new Map(days.map((d) => [d.date, d])), [days]);
  const todayIso = isoLocal(new Date());

  // the days from the Sunday 52 weeks back through today, each with its layout column (lc: a
  // new one every Sunday AND at every 1st of a month) and its month index (mi: months so far)
  const cells = useMemo(() => {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const start = new Date(today);
    start.setDate(today.getDate() - today.getDay() - (WEEKS - 1) * 7);
    const out: Cell[] = [];
    const cur = new Date(start);
    let lc = 0, mi = 0;
    while (cur <= today) {
      const iso = isoLocal(cur);
      if (out.length) {
        const first = cur.getDate() === 1;
        if (cur.getDay() === 0 || first) lc++;
        if (first) mi++;
      }
      out.push({ date: iso, words: byDate.get(iso)?.words || 0, row: cur.getDay(), month: iso.slice(0, 7), lc, mi });
      cur.setDate(cur.getDate() + 1);
    }
    return out;
  }, [byDate]);
  const L = cells.length ? cells[cells.length - 1].lc + 1 : 1;

  // runs of consecutive writing days; the current streak is the run that reaches today
  // (0 when today is blank, as before)
  const runs = useMemo(() => {
    const len = new Array<number>(cells.length).fill(0);
    const pos = new Array<number>(cells.length).fill(0);
    let s = -1;
    for (let i = 0; i <= cells.length; i++) {
      const on = i < cells.length && cells[i].words > 0;
      if (on && s < 0) s = i;
      if (!on && s >= 0) {
        for (let j = s; j < i; j++) { len[j] = i - s; pos[j] = j - s + 1; }
        s = -1;
      }
    }
    const t = cells.length - 1;
    const current = t >= 0 && cells[t].words > 0 ? len[t] : 0;
    const curFrom = current ? t - current + 1 : -1;
    const best = Math.max(0, ...len);
    const totalWords = cells.reduce((n, c) => n + c.words, 0);
    const totalDays = cells.filter((c) => c.words > 0).length;
    return { len, pos, current, curFrom, today: t, best, totalWords, totalDays };
  }, [cells]);

  // the width the card gives us
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const read = () => setAvail(el.clientWidth);
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // the first column of each month index, so a column's month breaks can be counted
  const colMi = useMemo(() => {
    const out = new Array<number>(L).fill(0);
    for (const c of cells) out[c.lc] = c.mi;
    return out;
  }, [cells, L]);

  // the step (cell + gap) at which columns a..L-1 exactly fill `w`
  const room = Math.max(0, avail - OFF * 2);
  const fit = (w: number, a: number) =>
    (w - PAD * 2) / (L - a - (1 - CELL) + MONTH_GAP * (colMi[L - 1] - colMi[a]));
  const flat = room > 0 ? fit(room, 0) : 15;
  const vertical = focused && room > 0 && flat < MIN_STEP;
  let first = 0;
  if (!vertical && room > 0) while (first < L - 4 && fit(room, first) < MIN_STEP) first++;
  const raw = vertical
    ? Math.max(MIN_STEP, Math.min(MAX_STEP_V, (room * 0.45 - PAD * 2) / (ROWS - (1 - CELL))))
    : room ? Math.max(MIN_STEP, Math.min(focused ? MAX_STEP_FOCUSED : MAX_STEP, fit(room, first))) : 15;
  const step = Math.floor(100 * raw) / 100;   // round down: the grid never overruns the card
  const sq = step * CELL;
  const gap = step - sq;
  const mg = step * MONTH_GAP;
  // where a layout column starts along the time axis, from the first one shown
  const along = (lc: number) => (lc - first) * step + (colMi[lc] - colMi[first]) * mg;
  const span = along(L - 1) + sq;
  const width = vertical ? PAD * 2 + ROWS * step - gap : PAD * 2 + span;
  const height = vertical ? PAD * 2 + span : PAD * 2 + ROWS * step - gap;
  // on its side the newest week is on top
  const at = (c: Cell) => vertical
    ? { x: PAD + c.row * step, y: PAD + span - sq - along(c.lc) }
    : { x: PAD + along(c.lc), y: PAD + c.row * step };
  const drawn = (c: Cell) => c.lc >= first;

  // the cursor walks the days as they sit on screen: across is a week, down is a day (on its
  // side, across is a day and down is the week before). Split weeks leave holes it steps over.
  const nCols = L - first;
  const markOf = (c: Cell) => (vertical ? (L - 1 - c.lc) * ROWS + c.row : c.row * nCols + (c.lc - first));
  const slot = new Map<number, number>();
  cells.forEach((c, i) => { if (drawn(c)) slot.set(markOf(c), i); });
  const nMarks = vertical ? L * ROWS : ROWS * nCols;
  const cellOf = (k: number): Cell | undefined => { const i = slot.get(k); return i == null ? undefined : cells[i]; };
  const openDay = (c: Cell) => { if (c.words > 0) api.open("Preparation/Notes/Daily/" + c.date + ".md"); };
  const todayCell = cells[cells.length - 1];
  const dc = useDatumCursor(nMarks, {
    cols: vertical ? ROWS : nCols,
    start: todayCell ? markOf(todayCell) : undefined,
    skip: (k) => !slot.has(k),
    onPress: (k) => { const c = cellOf(k); if (c) openDay(c); },
  });

  // still too narrow for the floor: keep the newest week (today) in view
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && el.scrollWidth > el.clientWidth + 1) el.scrollLeft = el.scrollWidth;
  }, [step, cells.length, first]);

  // words and writing days per month, oldest first, each spanning its own block of columns
  const months: MonthSpan[] = [];
  for (const c of cells) {
    if (!drawn(c)) continue;
    let m = months[months.length - 1];
    if (!m || m.key !== c.month) {
      m = { key: c.month, label: new Date(c.date + "T00:00:00").toLocaleString("en", { month: "long", year: "numeric" }), words: 0, days: 0, from: Infinity, to: -Infinity };
      months.push(m);
    }
    m.words += c.words;
    if (c.words > 0) m.days++;
    const p = at(c);
    const a = vertical ? p.y : p.x;
    m.from = Math.min(m.from, a);
    m.to = Math.max(m.to, a + sq);
  }

  // the current streak: one capsule per column it touches (a streak that crosses a Sunday or
  // a 1st continues in the next column)
  const capsules: { x: number; y: number; w: number; h: number }[] = [];
  if (runs.current >= 2) {
    const byCol = new Map<number, Cell[]>();
    for (let i = runs.curFrom; i <= runs.today; i++) {
      const c = cells[i];
      if (!drawn(c)) continue;
      byCol.set(c.lc, [...(byCol.get(c.lc) || []), c]);
    }
    const p = Math.max(2, gap * 0.6);
    for (const cs of byCol.values()) {
      const a = at(cs[0]), b = at(cs[cs.length - 1]);
      capsules.push({ x: Math.min(a.x, b.x) - p, y: Math.min(a.y, b.y) - p,
        w: Math.abs(b.x - a.x) + sq + 2 * p, h: Math.abs(b.y - a.y) + sq + 2 * p });
    }
  }

  const tipFor = (c: Cell, i: number): ReactNode => {
    const thisYear = c.date.slice(0, 4) === todayIso.slice(0, 4);
    const when = fmtDateLong(c.date) + (thisYear ? "" : `, ${c.date.slice(0, 4)}`);
    let more = "";
    if (i === runs.today) more = `today · streak ${runs.current}d · best ${runs.best}d · ${plural(runs.totalDays, "writing day")}, ${plural(runs.totalWords, "word")} this year`;
    else if (runs.curFrom >= 0 && i >= runs.curFrom) more = `current streak, day ${runs.pos[i]} of ${runs.current}`;
    else if (runs.len[i] > 1) more = `${runs.len[i]}-day run${runs.len[i] === runs.best ? " · the best" : ""}`;
    return (
      <span className="grid gap-0.5">
        <span><span className="font-medium">{when}</span>
          <span className="ml-2 text-muted-foreground">{c.words ? plural(c.words, "word") : "no writing"}</span></span>
        {more && <span className="text-muted-foreground">{more}</span>}
      </span>
    );
  };
  const activeIdx = dc.active != null ? slot.get(dc.active) ?? -1 : -1;
  const activeCell = activeIdx >= 0 ? cells[activeIdx] : undefined;

  const rx = Math.max(2, sq * 0.2);
  const tb = todayCell ? bucket(todayCell.words, p95) : 0;
  const grid = (
    <div ref={scroller} className="overflow-x-auto tinybar min-w-0" style={{ padding: RING_OUT, ...(vertical ? { flex: "0 0 auto" } : {}) }}>
      <div {...dc.surface} className="rounded-lg w-fit" style={{ padding: RING_IN }}
        aria-label={`Writing, last ${WEEKS} weeks: ${plural(runs.totalDays, "writing day")}, ${plural(runs.totalWords, "word")}; streak ${runs.current} days, best ${runs.best}`}>
        <svg width={width} height={height} style={{ display: "block" }}>
          {/* 1. the current streak, one quiet capsule behind its days */}
          {capsules.map((k, i) => (
            <rect key={i} x={k.x} y={k.y} width={k.w} height={k.h} rx={Math.min(k.w, k.h) / 2}
              fill="hsl(var(--primary) / 0.12)" stroke="hsl(var(--primary) / 0.45)" strokeWidth={1} pointerEvents="none" />
          ))}
          {/* 2. the days */}
          {cells.map((c) => {
            if (!drawn(c)) return null;
            const { x, y } = at(c);
            return (
              <rect key={c.date} {...dc.mark(markOf(c))} x={x} y={y} width={sq} height={sq} rx={rx}
                fill={fill(bucket(c.words, p95))}
                style={{ cursor: c.words ? "pointer" : "default" }}
                onClick={() => openDay(c)} />
            );
          })}
          {/* 3. today's dot, dark on a deep cell and light on a pale one */}
          {todayCell && drawn(todayCell) && (() => {
            const { x, y } = at(todayCell);
            return <circle cx={x + sq / 2} cy={y + sq / 2} r={Math.max(1.75, sq * 0.14)} pointerEvents="none"
              fill={tb >= 3 ? "hsl(var(--background))" : "hsl(var(--foreground) / 0.8)"} />;
          })()}
          {/* 4. the active day */}
          {activeCell && drawn(activeCell) && (() => {
            const { x, y } = at(activeCell);
            return <rect x={x - 1.5} y={y - 1.5} width={sq + 3} height={sq + 3} rx={rx + 1} fill="none"
              stroke="hsl(var(--foreground) / 0.8)" strokeWidth={2} pointerEvents="none" />;
          })()}
        </svg>
        <ChartTip cursor={dc}>{activeCell && tipFor(activeCell, activeIdx)}</ChartTip>
      </div>
    </div>
  );

  if (!focused) return <div ref={wrap}>{grid}</div>;
  // focused: one band, left to right, and the months' words as a compact strip under it
  const thick = Math.min(sq * 2 + gap, 40);
  return vertical ? (
    <div ref={wrap} className="flex items-start">
      {grid}
      <MonthStrip months={months} vertical length={height} depth={Math.max(40, Math.min(STRIP, avail - width - OFF * 4))} thick={thick} rx={rx} />
    </div>
  ) : (
    <div ref={wrap}>
      {grid}
      <div style={{ marginTop: STRIP_GAP - OFF * 2 }}>
        <MonthStrip months={months} vertical={false} length={width} depth={STRIP} thick={thick} rx={rx} />
      </div>
    </div>
  );
}
