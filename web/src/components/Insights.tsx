
import { useMemo, useRef } from "react";
import type { ReactNode } from "react";
import { WidgetFrame, useWidget } from "@/components/ui/widget";
import { Card } from "@/components/ui/card";
import type { Cache } from "@/lib/api";
import { useApi, usePersistent } from "@/lib/hooks";
import { api } from "@/lib/api";
import { Heatmap } from "@/components/Heatmap";
import { RefreshChip } from "@/components/RefreshChip";
import { InsightsArchive, InsightPanel, KpiGrid, BarRows, Bars, Columns, barTip, useFillHeight } from "@/components/InsightsArchive";

type Pane = "library" | "archive";

export function Insights({ cache, onRefresh }: { cache: Cache; onRefresh: () => Promise<void> }) {
  const [pane, setPane] = usePersistent<Pane>("insights-pane", "library");

  return (
    <div>
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[26px] font-semibold tracking-tight">Insights</h1>
        </div>
        {pane === "library" && <RefreshChip generated={cache.generated} onRefresh={onRefresh} />}
      </header>

      <div className="flex items-center gap-1 bg-secondary/60 rounded-lg p-1 w-fit mb-6">
        {(["library", "archive"] as Pane[]).map((p) => (
          <button key={p} onClick={() => setPane(p)}
            className={`px-3 py-1.5 rounded-md text-[12.5px] font-medium transition-colors capitalize ${pane === p ? "bg-card shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"}`}>
            {p}
          </button>
        ))}
      </div>

      {pane === "archive" ? <InsightsArchive /> : <InsightsLibrary cache={cache} />}
    </div>
  );
}

function InsightsLibrary({ cache }: { cache: Cache }) {
  const k = cache.kpi;
  const tagRows: [string, number][] = cache.tagStats?.length
    ? cache.tagStats.map((t) => [t.tag, t.total] as [string, number])
    : cache.topTags;
  const tagRead = cache.tagStats?.length
    ? new Map(cache.tagStats.map((t) => [t.tag, t.read] as const))
    : null;
  const days      = useApi(() => api.daily());
  const pct = (n: number) => (k.total ? Math.round((100 * n) / k.total) : 0);
  // read counts per source type and decade, bucketed the way build_cache.py buckets them
  // (types past the top N fold into "other"; years before 1900 share one decade)
  const read = useMemo(() => {
    const known = new Set(cache.types.map((t) => t[0]));
    const byType = new Map<string, number>();
    const byDecade = new Map<string, number>();
    for (const it of cache.items) {
      if (it.status !== "read") continue;
      const t = known.has(it.type) ? it.type : "other";
      byType.set(t, (byType.get(t) || 0) + 1);
      if (it.year) {
        const d = it.year < 1900 ? "<1900" : `${Math.floor(it.year / 10) * 10}s`;
        byDecade.set(d, (byDecade.get(d) || 0) + 1);
      }
    }
    return { byType, byDecade };
  }, [cache.items, cache.types]);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 items-start">
      <WidgetFrame id="insights.kpis" title="Library totals" className="lg:col-span-2">
        <KpiGrid
          main={[
            { n: k.total.toLocaleString(), label: "Sources", tip: `${k.total.toLocaleString()} sources · ${(k.total - k.read).toLocaleString()} unread` },
            { n: pct(k.read) + "%", label: "Read", share: k.total ? k.read / k.total : 0, tip: `${k.read.toLocaleString()} of ${k.total.toLocaleString()} read (${pct(k.read)}%)` },
            { n: (k.total - k.withPdf).toLocaleString(), label: "Missing PDFs", tip: `${(k.total - k.withPdf).toLocaleString()} of ${k.total.toLocaleString()} without a PDF` },
            { n: k.avgRating.toFixed(1) + "★", label: "Avg rating", tip: `${k.avgRating.toFixed(1)}★ average · ${k.rated.toLocaleString()} rated` },
          ]}
          extra={[
            { n: (k.total - k.read).toLocaleString(), label: "Unread", tip: `${(k.total - k.read).toLocaleString()} unread` },
            { n: pct(k.withPdf) + "%", label: "With a PDF", tip: `${k.withPdf.toLocaleString()} files (${pct(k.withPdf)}%)` },
            { n: pct(k.rated) + "%", label: "Rated", tip: `${k.rated.toLocaleString()} sources rated (${pct(k.rated)}%)` },
            { n: String(cache.types.length), label: "Source types", tip: `${cache.types.length} source types` },
            { n: String(cache.decades.length), label: "Decades", tip: `${cache.decades.length} decades covered` },
          ]}
          meters={[
            { label: "Read", value: k.read, total: k.total },
            { label: "With a PDF", value: k.withPdf, total: k.total },
            { label: "Rated", value: k.rated, total: k.total },
          ]} />
      </WidgetFrame>

      <WidgetFrame id="insights.heatmap" title="Writing heatmap" className="lg:col-span-2">
        <Card data-fill-card className="h-full p-5 group-data-[size=xs]/widget:p-4 group-data-[focused]/widget:h-auto group-data-[focused]/widget:min-h-full">
          <div className="text-[11px] uppercase tracking-[0.08em] font-semibold text-muted-foreground mb-3.5 group-data-[focused]/widget:text-[13px] group-data-[focused]/widget:mb-5">Writing heatmap</div>
          {days.data ? <Heatmap days={days.data} /> : <div className="h-[120px] animate-pulse bg-muted/40 rounded" />}
        </Card>
      </WidgetFrame>

      <InsightPanel title="By source type" chart>
        <Bars unit="source" rows={cache.types.map(([t, n]) => ({ label: t, value: n, read: read.byType.get(t) || 0 }))}
          aria={`Sources by type: ${cache.types.map(([t, n]) => `${t} ${n}, ${read.byType.get(t) || 0} read`).join("; ")}`} />
      </InsightPanel>
      <InsightPanel title="By decade" chart>
        <Decades rows={cache.decades.map(([d, n]) => ({ label: d, value: n, read: read.byDecade.get(d) || 0 }))} />
      </InsightPanel>
      <InsightPanel title="Most-used tags" wide measure="wide" chart>
        <Bars unit="note" rows={tagRows.map(([t, n]) => ({ label: t, value: n, read: tagRead ? tagRead.get(t) ?? 0 : undefined }))}
          aria={`The ${tagRows.length} most-used${cache.tagTotal ? ` of ${cache.tagTotal.toLocaleString()} distinct` : ""} tags: ${tagRows.map(([t, n]) => `${t} ${n}`).join(", ")}`}
          wrap={(bars, n) => <TwoColumns n={n}>{bars}</TwoColumns>} />
      </InsightPanel>
    </div>
  );
}

// one column in a narrow tile, two from 600px; a focused view spreads the tags down the page
// in as many columns as they need
function TwoColumns({ n, children }: { n: number; children: ReactNode }) {
  const w = useWidget();
  if (w?.focused) return <BarRows n={n} columns>{children}</BarRows>;
  const two = !w || w.size === "md" || w.size === "lg" || w.size === "xl";
  return <div className={`grid gap-x-6 ${two ? "grid-cols-2" : "grid-cols-1"}`}>{children}</div>;
}

function Decades({ rows }: { rows: { label: string; value: number; read: number }[] }) {
  const w = useWidget();
  const ref = useRef<HTMLDivElement>(null);
  const fill = useFillHeight(ref);
  const H = w?.focused ? Math.max(180, (fill || 320) - 30) : 150;
  const band = w && rows.length ? (w.width - 48) / rows.length : 0;
  const all = band >= 44;
  return (
    <div ref={ref}>
      <Columns items={rows} height={H} start={rows.length - 1}
        label={(i) => (all || i === 0 || i === rows.length - 1 ? rows[i].label : null)}
        tip={(i) => barTip(rows[i], "source")}
        aria={`Sources by decade: ${rows.map((r) => `${r.label} ${r.value}, ${r.read} read`).join("; ")}`} />
    </div>
  );
}
