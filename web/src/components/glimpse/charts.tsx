
import type { ReactNode } from "react";
import type { Glimpse } from "@/lib/api";

type Series = NonNullable<Glimpse["series"]>;
type Pt = { x: string; y: number };

const ACCENT = "hsl(var(--primary))";
const GRID = "hsl(var(--border))";
const INK = "hsl(var(--foreground))";
const MUTED = "hsl(var(--muted-foreground))";
const SURFACE = "hsl(var(--card))";
const DAY = 86_400_000;
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** thousands-separated; `compact` shortens 10,000+ to 12.9K for tight chart ticks */
export function fmtNum(v: number, unit?: string, compact = true): string {
  const a = Math.abs(v);
  let s: string;
  if (a >= 1e6) s = (v / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace(/\.0$/, "") + "M";
  else if (compact && a >= 1e4) s = (v / 1e3).toFixed(a >= 1e5 ? 0 : 1).replace(/\.0$/, "") + "K";
  else s = v.toLocaleString("en-US", { maximumFractionDigits: Number.isInteger(v) || a >= 100 ? 0 : 1 });
  if (!unit) return s;
  return /^[%°]/.test(unit) ? s + unit : `${s} ${unit}`;
}

const dayMs = (x: string): number | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(x);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null;
};
const isDateX = (x: string) => dayMs(x) !== null || /^\d{4}-\d{2}$/.test(x);
const isCategorical = (pts: Pt[]) => pts.some((p) => !isDateX(p.x));

export function shortX(x: string): string {
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(x);
  if (m) return `${MON[+m[2] - 1] ?? m[2]} ${+m[3]}`;
  m = /^(\d{4})-(\d{2})$/.exec(x);
  if (m) return MON[+m[2] - 1] ?? x;
  return x;
}

const fit = (s: string, room: number, px = 9.5) => {
  const max = Math.floor(room / (px * 0.56));
  return s.length <= max ? s : s.slice(0, Math.max(1, max - 1)) + "…";
};

function niceStep(span: number, ticks: number) {
  const raw = span / ticks || 1;
  const p = 10 ** Math.floor(Math.log10(raw));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}
const niceMax = (v: number) => (v <= 0 ? 1 : Math.ceil(v / niceStep(v, 4)) * niceStep(v, 4));
function niceRange(lo: number, hi: number): [number, number] {
  if (hi === lo) { const d = Math.abs(hi) * 0.1 || 1; lo -= d; hi += d; }
  const st = niceStep(hi - lo, 3);
  return [Math.floor(lo / st) * st, Math.ceil(hi / st) * st];
}

/** consecutive k-sums counted back from the latest point (so the last chunk is the current week) */
function chunkPoints(pts: Pt[], k: number): Pt[] {
  const out: Pt[] = [];
  for (let end = pts.length; end > 0; end -= k) {
    const part = pts.slice(Math.max(0, end - k), end);
    out.unshift({ x: part[0].x, y: part.reduce((a, p) => a + p.y, 0) });
  }
  return out;
}

/** a series that starts today or later looks ahead: the nearest point is the one that matters */
function looksAhead(pts: Pt[]) {
  const d = dayMs(pts[0]?.x ?? "");
  if (d === null) return false;
  const now = new Date();
  return d >= Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
}

const chartScale = (width: number, height: number) =>
  Math.max(1, Math.min(height / 150, width / 560, 1.9));

export function GChart({ s, width, height }: { s: Series; width: number; height: number }) {
  const pts = (s.points || []).slice(-90).filter((p) => p && typeof p.x === "string" && Number.isFinite(p.y));
  if (!pts.length || width < 40 || height < 30) return null;
  if (s.kind === "heat") return <GHeat s={s} pts={pts} width={width} height={height} />;
  return <GXY s={s} pts={pts} width={width} height={height} />;
}

function GXY({ s, pts, width, height }: { s: Series; pts: Pt[]; width: number; height: number }) {
  const k = chartScale(width, height);
  const ax = 9.5 * k;
  const n = pts.length;
  const ys = pts.map((p) => p.y);
  const bars = s.kind === "bars";
  const cat = isCategorical(pts);
  // a few categories keep their names under the bars: without them the bars cannot be read
  const names = bars && cat && n <= 8;
  const ahead = !cat && looksAhead(pts);
  const key = bars && cat ? ys.indexOf(Math.max(...ys)) : ahead ? 0 : n - 1;   // the emphasised point
  const [lo, hi] = s.kind === "line" ? niceRange(Math.min(...ys), Math.max(...ys)) : [0, niceMax(Math.max(...ys))];
  // no ticks, no end labels: the plot runs edge to edge, with room only for the end dot
  const dotR = 6 * k;
  const top = s.kind === "line" || !bars ? dotR : 2 * k, axis = names ? 15 * k : bars ? 1 : dotR;
  const x0 = bars ? 0 : dotR, x1 = width - (bars ? 0 : dotR);
  const y1 = height - axis;
  const pw = Math.max(10, x1 - x0), ph = Math.max(10, y1 - top);
  const Y = (v: number) => y1 - ((v - lo) / (hi - lo || 1)) * ph;
  const slot = pw / n;
  const cx = (i: number) => (s.kind === "line" ? x0 + (n === 1 ? pw / 2 : (i / (n - 1)) * pw) : x0 + i * slot + slot / 2);

  let marks: ReactNode = null;
  let xAxis: ReactNode = null;
  if (bars) {
    // a tall chart carries wider bars, so a big card does not draw the series as thin sticks
    const cap = Math.max(24, Math.round(height * 0.14));
    const bw = slot >= 3 ? Math.min(cap, slot - 2) : Math.max(1, slot - 1);
    marks = pts.map((p, i) => {
      const x = x0 + i * slot + (slot - bw) / 2;
      const yt = Y(p.y);
      const h = y1 - yt;
      if (h <= 0.25) return null;
      const r = Math.min(4 * k, bw / 2, h);
      const d = `M${x},${y1}V${yt + r}Q${x},${yt} ${x + r},${yt}H${x + bw - r}Q${x + bw},${yt} ${x + bw},${yt + r}V${y1}Z`;
      return <path key={i} d={d} fill={i === key ? ACCENT : "hsl(var(--primary) / 0.28)"} />;
    });
    if (names) xAxis = pts.map((p, i) => (
      <text key={`x${i}`} x={cx(i)} y={height - 2 * k} textAnchor="middle" fontSize={ax} fill={MUTED}>{fit(p.x, slot - 2, ax)}</text>
    ));
  } else if (s.kind === "line") {
    const line = pts.map((p, i) => `${i ? "L" : "M"}${cx(i).toFixed(1)},${Y(p.y).toFixed(1)}`).join("");
    const area = `${line}L${cx(n - 1).toFixed(1)},${y1}L${cx(0).toFixed(1)},${y1}Z`;
    const ex = cx(key), ey = Y(ys[key]);
    marks = (
      <>
        <path d={area} fill={ACCENT} opacity={0.1} />
        <path d={line} fill="none" stroke={ACCENT} strokeWidth={2 * k} strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={ex} cy={ey} r={dotR} fill={SURFACE} />
        <circle cx={ex} cy={ey} r={4 * k} fill={ACCENT} />
      </>
    );
  } else {
    const r = Math.max(2, Math.min(4 * k, slot / 2 - 1));
    marks = pts.map((p, i) => {
      const x = cx(i);
      if (p.y <= 0) return <circle key={i} cx={x} cy={y1 - 0.5} r={i === key ? 2.5 * k : 1.25 * k} fill={i === key ? ACCENT : GRID} />;
      if (i === key) return (
        <g key={i}><circle cx={x} cy={Y(p.y)} r={Math.max(r, 3.5 * k) + 2 * k} fill={SURFACE} /><circle cx={x} cy={Y(p.y)} r={Math.max(r, 3.5 * k)} fill={ACCENT} /></g>
      );
      return <circle key={i} cx={x} cy={Y(p.y)} r={r} fill="hsl(var(--primary) / 0.45)" />;
    });
  }

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="block overflow-visible">
      <line x1={x0} x2={x1} y1={Math.round(y1) + 0.5} y2={Math.round(y1) + 0.5} stroke={GRID} strokeWidth={Math.max(1, Math.round(k))} />
      {marks}
      {xAxis}
    </svg>
  );
}

const HEAT_STEPS = [0.3, 0.52, 0.76, 1];
const heatFill = (v: number, max: number) => {
  if (v <= 0 || max <= 0) return "hsl(var(--muted-foreground) / 0.13)";
  const t = v / max;
  return `hsl(var(--primary) / ${t <= 0.25 ? HEAT_STEPS[0] : t <= 0.5 ? HEAT_STEPS[1] : t <= 0.75 ? HEAT_STEPS[2] : HEAT_STEPS[3]})`;
};

/** a weeks-by-weekday grid (Mon on top), one accent hue light to dark; undated points fill 7 per
 *  column. No dates, no legend: the latest day wears a ring, and depth of colour is the count */
function GHeat({ s, pts, width, height }: { s: Series; pts: Pt[]; width: number; height: number }) {
  const k = chartScale(width, height);
  const pad = 3 * k, gap = 2 * k;
  const days = pts.map((p) => dayMs(p.x));
  let cells: { c: number; r: number; v: number }[];
  if (days.every((d) => d !== null)) {
    const d0 = days[0] as number;
    const mon0 = d0 - ((new Date(d0).getUTCDay() + 6) % 7) * DAY;
    cells = pts.map((p, i) => {
      const d = days[i] as number;
      return { c: Math.floor((d - mon0) / (7 * DAY)), r: (new Date(d).getUTCDay() + 6) % 7, v: p.y };
    });
  } else {
    cells = pts.map((p, i) => ({ c: Math.floor(i / 7), r: i % 7, v: p.y }));
  }
  const cols = Math.max(...cells.map((c) => c.c)) + 1;
  const col = (width - 2 * pad + gap) / cols - gap;       // the width one week has
  // a day cell takes what the shorter side allows and stops at 40px: a grid of huge
  // squares reads as a quilt, not as a calendar
  const ch = Math.floor(Math.min((height - 2 * pad + gap) / 7 - gap, col, 40));
  // too short for a readable grid: the same data as weekly totals
  if (ch < 6) return <GXY s={{ ...s, kind: "bars" }} pts={chunkPoints(pts, 7)} width={width} height={height} />;
  const cw = Math.max(ch, Math.floor(Math.min(ch * 3, col)));
  const gh = 7 * (ch + gap) - gap;
  const max = Math.max(0, ...cells.map((c) => c.v));
  const last = cells.length - 1;
  return (
    <svg width={width} height={gh + 2 * pad} viewBox={`${-pad} ${-pad} ${width} ${gh + 2 * pad}`} className="block overflow-visible">
      {cells.map((c, i) => (
        <rect key={i} x={c.c * (cw + gap)} y={c.r * (ch + gap)} width={cw} height={ch} rx={2 * k} fill={heatFill(c.v, max)}
          {...(i === last ? { stroke: INK, strokeWidth: 1.5 * k } : {})} />
      ))}
    </svg>
  );
}

/** the nav row's at-a-glance mark: a 34x12 micro-trend over time, else the first stat's value */
export function GMicro({ g }: { g: Glimpse }) {
  const s = g.series;
  let pts: Pt[] = s ? (s.points || []).filter((p) => p && typeof p.x === "string" && Number.isFinite(p.y)) : [];
  if (s?.kind === "heat") pts = chunkPoints(pts, 7);
  pts = pts.slice(-20);
  // an all-zero or categorical series has no trend to show: the first stat instead
  if (s && pts.length >= 4 && !isCategorical(pts) && pts.filter((p) => p.y !== 0).length >= 3) {
    const W = 34, H = 12, n = pts.length, ys = pts.map((p) => p.y);
    const lo = s.kind === "line" ? Math.min(...ys) : 0, hi = Math.max(...ys), span = hi - lo || 1;
    const Yp = (v: number) => H - 1.5 - ((v - lo) / span) * (H - 3);
    if (s.kind === "line") {
      const X = (i: number) => 1.5 + (i / (n - 1)) * (W - 5);
      const d = ys.map((v, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Yp(v).toFixed(1)}`).join("");
      return (
        <svg width={W} height={H} className="block overflow-visible">
          <path d={d} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" opacity={0.75} />
          <circle cx={X(n - 1)} cy={Yp(ys[n - 1])} r={1.75} fill="currentColor" />
        </svg>
      );
    }
    const slot = W / n, bw = Math.max(1, slot - 1);
    return (
      <svg width={W} height={H} className="block">
        {ys.map((v, i) => {
          if (v <= 0) return null;
          const y = Math.min(H - 0.75, Yp(v));
          return <rect key={i} x={i * slot} y={y} width={bw} height={H - y} rx={0.5} fill="currentColor" opacity={i === n - 1 ? 0.95 : 0.45} />;
        })}
      </svg>
    );
  }
  const st = g.stats?.[0];
  return st ? <span className="nums text-[10.5px]">{typeof st.value === "number" ? fmtNum(st.value) : st.value}</span> : null;
}
