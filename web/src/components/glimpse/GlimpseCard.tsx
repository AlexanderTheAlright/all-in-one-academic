
import type { Glimpse, GlimpseSeries, GlimpseTone } from "@/lib/api";
import { GChart, fmtNum } from "./charts";

export type CardSize = "xl" | "lg" | "md" | "sm";

export type CardLayout = {
  size: CardSize;
  width: number; height: number; pad: number;
  chartH: number;          // the chart band's height (the label sits above it)
  charts: 1 | 2;           // how many series are drawn
  chartsSide: boolean;     // ... and whether they stand side by side
  listBeside: boolean;     // the rows share the chart's band, to its right
  listCols: 1 | 2;
  listMax: number; statMax: number;
  statCols: number;        // the stat grid's columns (what the region actually fits)
};

const M: Record<CardSize, { padY: number; head: number; gap: number; stat: number; label: number; row: number; padX: number; perStat: number; listCap: number }> = {
  xl: { padY: 24, head: 60, gap: 18, stat: 58, label: 20, row: 34, padX: 28, perStat: 160, listCap: 12 },
  lg: { padY: 18, head: 40, gap: 14, stat: 40, label: 16, row: 26, padX: 20, perStat: 160, listCap: 12 },
  md: { padY: 14, head: 36, gap: 12, stat: 36, label: 16, row: 26, padX: 16, perStat: 160, listCap: 12 },
  sm: { padY: 10, head: 32, gap: 9, stat: 32, label: 15, row: 22, padX: 12, perStat: 120, listCap: 12 },
};

/** the type scale per size; the small sizes trade size for the room a narrow region has */
const TXT: Record<CardSize, { head: string; statLabel: string; statValue: string; label: string; row: string; meta: string }> = {
  xl: { head: "min-h-[60px] text-[26px] leading-[30px]", statLabel: "text-[13px] leading-[20px]", statValue: "text-[30px] leading-[38px]", label: "text-[13px] leading-[20px]", row: "h-[34px] text-[15px]", meta: "text-[13.5px]" },
  lg: { head: "min-h-[40px] text-[15px] leading-[20px]", statLabel: "text-[10.5px] leading-[15px]", statValue: "text-[20px] leading-[25px]", label: "text-[10.5px] leading-[16px]", row: "h-[26px] text-[12px]", meta: "text-[11px]" },
  md: { head: "min-h-[36px] text-[13.5px] leading-[18px]", statLabel: "text-[10.5px] leading-[15px]", statValue: "text-[16px] leading-[21px]", label: "text-[10.5px] leading-[16px]", row: "h-[26px] text-[12px]", meta: "text-[11px]" },
  sm: { head: "min-h-[32px] text-[12.5px] leading-[16px]", statLabel: "text-[10px] leading-[14px]", statValue: "text-[14px] leading-[18px]", label: "text-[10px] leading-[15px]", row: "h-[22px] text-[11.5px]", meta: "text-[10.5px]" },
};

const MIN_CHART = 40;          // below this GChart draws nothing
const BOTH_W = 1100;           // room enough to stand the two series side by side
const BESIDE_W = 620, BESIDE_H = 560;   // wide and short: the rows belong beside the chart
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const has = (s: GlimpseSeries | undefined): s is GlimpseSeries => !!s && !!s.points?.length;

export function glimpseOk(g: Glimpse | null | undefined): g is Glimpse {
  return !!g && !g.error && typeof g.headline === "string" && g.headline.length > 0;
}

/** the share of the width the rows take when they sit beside the chart */
const asideW = (inner: number) => clamp(Math.round(inner * 0.38), 170, 340);

/** the card that fills a `boxW` x `boxH` glimpse region for this glimpse, or null when the
 *  region is too small to hold one at all */
export function fitGlimpseCard(boxW: number, boxH: number, g: Glimpse): CardLayout | null {
  const size: CardSize = boxW >= BOTH_W ? "xl" : boxW >= 620 ? "lg" : boxW >= 380 ? "md" : "sm";
  const m = M[size];
  const hasStats = (g.stats || []).length > 0;
  const series = has(g.series);
  const items = (g.list || []).length;
  const inner = boxW - m.padX * 2;
  const base = m.padY * 2 + m.head + (hasStats ? m.gap + m.stat : 0) + (series ? m.gap + m.label : 0);
  const free = boxH - base - 4;
  if (boxW < 150 || free < (series ? MIN_CHART : m.row)) return null;

  const charts: 1 | 2 = series && has(g.series2) && boxW >= BOTH_W ? 2 : 1;
  const listBeside = charts === 1 && series && items > 0 && boxW >= BESIDE_W && boxH <= BESIDE_H;
  const listCols: 1 | 2 = boxW >= BOTH_W ? 2 : 1;
  const chartW = charts === 2 ? Math.floor((inner - m.gap) / 2) : listBeside ? inner - asideW(inner) - m.gap : inner;
  const pts = Math.max(6, (g.series?.points || []).filter((p) => Number.isFinite(p.y) && p.y !== 0).length);
  const capAt = (mult: number) => g.series?.kind === "heat" ? 330
    : Math.max(MIN_CHART, Math.min(Math.round(chartW * mult), pts * 48));
  const cap = capAt(0.8);

  let chartH: number, rows: number, height: number;
  if (listBeside) {
    chartH = clamp(free, MIN_CHART, Math.max(MIN_CHART, cap));
    rows = clamp(Math.min(items, Math.floor((m.label + chartH) / m.row)), 0, m.listCap);
    height = base + chartH + 4;
  } else {
    const fits = Math.floor((free - (series ? MIN_CHART + m.gap + 7 : 0)) / m.row) * listCols;
    rows = clamp(Math.min(items, fits), 0, m.listCap);
    const listH = rows > 0 ? m.gap + 7 + m.row * Math.ceil(rows / listCols) : 0;
    chartH = series ? clamp(free - listH, MIN_CHART, Math.max(MIN_CHART, cap)) : 0;
    height = Math.min(boxH, base + chartH + listH + 4);
    // the rows have taken all they can and the region is still mostly empty: let the chart
    // stretch a little past its own width rather than leave a dead field under the card
    if (series && pts >= 8 && rows >= items && boxH - height > m.row * 3) {
      chartH = clamp(free - listH, MIN_CHART, Math.max(cap, capAt(1.15)));
      height = Math.min(boxH, base + chartH + listH + 4);
    }
  }
  const statMax = clamp(Math.floor(inner / m.perStat), 1, 8);
  return {
    size, width: boxW, height, pad: m.padX, chartH,
    charts, chartsSide: charts === 2, listBeside, listCols,
    listMax: rows, statMax,
    statCols: Math.max(1, Math.min(statMax, (g.stats || []).length)),
  };
}

/** a status tone: the theme's success / warning / danger tokens (index.css), which wear the
 *  palette's own green, amber and rose where it has them */
export function toneColor(t: GlimpseTone | undefined): string | null {
  if (t === "bad") return "hsl(var(--danger))";
  if (t === "warn") return "hsl(var(--warning))";
  if (t === "good") return "hsl(var(--success))";
  return null;
}

export function GlimpseCard({ g, layout }: { g: Glimpse; layout: CardLayout }) {
  const m = M[layout.size];
  const t = TXT[layout.size];
  const stats = (g.stats || []).slice(0, Math.max(1, layout.statMax));
  const inner = layout.width - layout.pad * 2;
  const series = has(g.series) ? g.series : null;
  const second = layout.charts === 2 && has(g.series2) ? g.series2 : null;
  const list = (g.list || []).slice(0, layout.listMax);
  const aside = asideW(inner);
  const chartW = second ? Math.floor((inner - m.gap) / 2) : layout.listBeside ? inner - aside - m.gap : inner;

  const chart = (s: GlimpseSeries, w: number) => (
    <div className="min-w-0" style={{ width: w }}>
      <div className={`truncate text-muted-foreground ${t.label}`}>{s.label}</div>
      <GChart s={s} width={w} height={layout.chartH} />
    </div>
  );
  const rows = (
    <ul className={layout.listBeside ? "min-w-0 overflow-hidden border-l border-border pl-3" : "overflow-hidden border-t border-border pt-1.5"}
      style={layout.listCols === 2 && !layout.listBeside
        ? { display: "grid", gridAutoFlow: "column", gridTemplateRows: `repeat(${Math.ceil(list.length / 2)}, ${m.row}px)`, columnGap: m.gap * 2 }
        : undefined}>
      {list.map((it, i) => {
        const c = toneColor(it.tone);
        return (
          <li key={i} className={`flex items-center gap-2 ${t.row}`}>
            <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: c ?? "hsl(var(--muted-foreground) / 0.3)" }} />
            <span className="min-w-0 flex-1 truncate text-foreground/90">{it.title}</span>
            {it.meta && <span className={`shrink-0 text-muted-foreground nums ${t.meta}`}>{it.meta}</span>}
          </li>
        );
      })}
    </ul>
  );

  return (
    <div className="flex h-full flex-col overflow-hidden"
      style={{ padding: `${m.padY}px ${layout.pad}px`, gap: m.gap }}>
      <div className={`line-clamp-2 font-semibold text-foreground nums ${t.head}`}>
        {g.headline}
      </div>
      {stats.length > 0 && (
        <div className="grid gap-x-4" style={{ gridTemplateColumns: `repeat(${stats.length}, minmax(0, 1fr))` }}>
          {stats.map((s, i) => {
            const c = toneColor(s.tone);
            return (
              <div key={i} className="min-w-0">
                <div className={`flex items-center gap-1.5 text-muted-foreground ${t.statLabel}`}>
                  {c && <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: c }} />}
                  <span className="truncate">{s.label}</span>
                </div>
                <div className={`truncate font-semibold text-foreground nums ${t.statValue}`}>
                  {typeof s.value === "number" ? fmtNum(s.value, undefined, false) : s.value}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {series && layout.chartH > 0 && (
        second || layout.listBeside ? (
          <div className="flex min-w-0" style={{ gap: m.gap }}>
            {chart(series, chartW)}
            {second ? chart(second, chartW) : <div className="min-w-0" style={{ width: aside }}>{list.length > 0 ? rows : null}</div>}
          </div>
        ) : chart(series, chartW)
      )}
      {!layout.listBeside && list.length > 0 && rows}
    </div>
  );
}
