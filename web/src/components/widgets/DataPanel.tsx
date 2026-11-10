
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Check, Copy, Search, SortAsc, X } from "lucide-react";
import { panelApi, type PanelDataset, type PanelDatasetCard, type PanelVariable } from "@/lib/api";
import { ago, nfmt, sig, toks, useRememberedSearch, type PaneSize } from "@/components/widgets/panel";
import { PanelEmpty, PanelHeader, Hi, useBracketStep, useHomeEnd, useLeftToTabs,
  type PanelChromeProps } from "@/components/widgets/PanelChrome";
import { copyPlain } from "@/lib/clipboard";

export type DatasetSel = { family: string; key: string; frame: string; path: string };
export const selKey = (s: DatasetSel | null) =>
  (s ? (s.frame ? "frame:" + s.frame : s.path ? "path:" + s.path : s.family + "/" + s.key) : "");
const baseOf = (p: string) => p.split("/").filter(Boolean).pop() || p;
const selTitle = (s: DatasetSel | null) =>
  (s ? [s.family, s.key].filter(Boolean).join("/") || s.frame || (s.path ? baseOf(s.path) : "") : "");

const FIRST_ROWS = 120;
const MORE_ROWS = 200;
const AHEAD_PX = 1200;

const LAZY_PARALLEL = 4;

const WRAP = "mx-auto w-full max-w-[1180px]";
type Sort = "file" | "name" | "miss";
const SORTS: Sort[] = ["file", "name", "miss"];
const SORT_LABEL: Record<Sort, string> = { file: "file order", name: "name", miss: "missing" };

const KINDS: Record<string, string> = {
  numeric: "num", integer: "int", string: "str", category: "cat", date: "date", bool: "bool",
};
const chipOf = (v: PanelVariable): string => KINDS[(v.dtype || "").toLowerCase()] || "";

const haystack = (v: PanelVariable) =>
  (v.name + " " + v.label + " " + Object.values(v.valueLabels).join(" ") + " "
    + v.top.map((t) => t.label).join(" ")).toLowerCase();

function summaryOf(v: PanelVariable): string {
  if (v.n === 0 || (v.missPct !== null && v.missPct >= 100)) return "";
  if (v.mean !== null) return sig(v.mean) + " ± " + sig(v.sd);
  // `top` of a value-labelled variable is in CODE order, so the first is not the modal one
  let t = v.top[0];
  for (const l of v.top) if (l.n > t.n) t = l;
  if (t) return (t.label || t.value) + " " + Math.round(t.pct) + "%";
  return "";
}

function barsOf(v: PanelVariable, trimmed: boolean): number[] {
  if (v.hist && v.hist.counts.length) return v.hist.counts.slice(0, 12);
  if (!trimmed && v.top.length) return v.top.slice(0, 12).map((t) => t.n);
  return [];
}

const SPARK_W = 46, SPARK_H = 13;
function Spark({ bars, w = SPARK_W, h = SPARK_H }: { bars: number[]; w?: number; h?: number }) {
  if (!bars.some((c) => c > 0)) return null;
  const max = Math.max(...bars, 1);
  const step = w / bars.length;
  return (
    <svg data-var-spark width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden className="block shrink-0 overflow-visible">
      {bars.map((c, i) => {
        const bh = Math.max(c > 0 ? 1 : 0, Math.round((c / max) * h));
        return <rect key={i} x={i * step + 0.4} y={h - bh} width={Math.max(1, step - 0.8)} height={bh}
          className="fill-primary/55" rx={0.5} />;
      })}
    </svg>
  );
}

function MissBar({ pct }: { pct: number | null }) {
  // the instant layer has no counts yet: the track is held, empty, so nothing shifts
  if (pct === null) return <span data-var-cell="miss" aria-hidden className="block h-[4px] w-[48px] shrink-0" />;
  const p = Math.max(0, Math.min(100, pct));
  return (
    <span data-var-miss data-var-cell="miss" className="inline-flex shrink-0 items-center gap-1" title={p.toFixed(1) + "% missing"}>
      <span className="relative block h-[4px] w-[22px] overflow-hidden rounded-full bg-muted">
        <span className="absolute inset-y-0 left-0 rounded-full bg-primary/70" style={{ width: p + "%" }} />
      </span>
      <span className="nums w-[22px] text-[9px] text-muted-foreground">{p >= 0.05 ? p.toFixed(0) + "%" : ""}</span>
    </span>
  );
}

/* --------------------------------------------------------------------- the view */

export function DataPanel({ chrome, session, sel, onSel, size, right, onCount }: {
  chrome: PanelChromeProps;
  session: string;
  sel: DatasetSel | null;
  onSel: (d: DatasetSel | null) => void;
  size: PaneSize;
  right?: React.ReactNode;
  /** how many variables the PICKED dataset has, for the tab's count; null with none */
  onCount?: (n: number | null) => void;
}) {
  const [ds, setDs] = useState<PanelDataset | null>(null);
  const [failed, setFailed] = useState("");
  const [q, setQ] = useRememberedSearch("variables");
  const [sort, setSort] = useState<Sort>("file");
  const [open, setOpen] = useState<string | null>(null);
  const restore = useRef<string | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const key = selKey(sel);

  // names first, stats when the profile lands: re-ask while it is building, re-render
  // only when the stamp moves
  useEffect(() => {
    if (!sel) { setDs(null); setFailed(""); return; }
    let live = true, timer = 0, stamp = "";
    setDs(null); setFailed(""); setOpen(null);
    const pull = () => {
      panelApi.dataset(sel).then((d) => {
        if (!live) return;
        if (!d.stamp || d.stamp !== stamp) { stamp = d.stamp; setDs(d); }
        if (d.profile === "building") timer = window.setTimeout(pull, 2000);
      }).catch(() => { if (live) setFailed("couldn't read that dataset"); });
    };
    pull();
    return () => { live = false; window.clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const vars = useMemo(() => ds?.variables ?? [], [ds]);
  // with nothing picked the tab carries no count at all, rather than a confident zero
  useEffect(() => { onCount?.(sel ? vars.length : null); }, [sel, vars.length, onCount]);
  const hay = useMemo(() => new Map(vars.map((v) => [v.name, haystack(v)])), [vars]);
  const tk = useMemo(() => toks(q), [q]);
  const shown = useMemo(() => {
    const hit = tk.length ? vars.filter((v) => tk.every((t) => (hay.get(v.name) || "").includes(t))) : vars.slice();
    if (sort === "name") hit.sort((a, b) => a.name.localeCompare(b.name));
    else if (sort === "miss") hit.sort((a, b) => (b.missPct ?? -1) - (a.missPct ?? -1));
    else hit.sort((a, b) => a.ordinal - b.ordinal);
    return hit;
  }, [vars, tk, hay, sort]);
  // how many of `shown` are drawn: FIRST_ROWS again whenever the list itself changes
  const [limit, setLimit] = useState(FIRST_ROWS);
  useEffect(() => { setLimit(FIRST_ROWS); }, [key, q, sort]);
  const rows = useMemo(() => shown.slice(0, limit), [shown, limit]);
  const more = shown.length - rows.length;
  const grow = useCallback((to?: number) =>
    setLimit((l) => Math.min(shown.length, Math.max(l + MORE_ROWS, to ?? 0))), [shown.length]);

  // the sentinel: a fresh element per batch (keyed by `limit`), so the observer's first
  // callback fires again even when the new batch still leaves it inside the margin
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current, root = body.current;
    if (!el || !root || open || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) grow(); },
      { root, rootMargin: `0px 0px ${AHEAD_PX}px 0px` });
    io.observe(el);
    return () => io.disconnect();
  }, [limit, more > 0, open, grow]); // eslint-disable-line react-hooks/exhaustive-deps

  const endPending = useRef(false);
  useEffect(() => {
    if (open || more <= 0) return;
    const h = (e: KeyboardEvent) => {
      const a = document.activeElement as HTMLElement | null;
      if (!a || !a.hasAttribute("data-var-row")) return;
      if (e.key === "End") { endPending.current = true; setLimit(shown.length); return; }
      if (e.key !== "ArrowDown" && e.key !== "PageDown") return;
      const drawn = body.current?.querySelectorAll("[data-var-row]");
      if (!drawn) return;
      const i = Array.prototype.indexOf.call(drawn, a);
      if (i >= drawn.length - 40) grow();
    };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [open, more, shown.length, grow]);
  useEffect(() => {
    if (!endPending.current || more > 0) return;
    endPending.current = false;
    const all = body.current?.querySelectorAll<HTMLElement>("[data-var-row]");
    const el = all && all[all.length - 1];
    if (el) { document.documentElement.setAttribute("data-knav", ""); el.focus({ preventScroll: false }); }
  }, [more, rows]);

  /* ------------------------------------------ lazy distributions, trimmed payloads only */
  const trimmed = !!ds?.trimmed;
  const lazy = trimmed && ds?.profile === "ready";         // every size draws the distribution
  const [full, setFull] = useState<Map<string, PanelVariable>>(() => new Map());
  const asked = useRef(new Set<string>());
  const queue = useRef<string[]>([]);
  const busy = useRef(0);
  const landed = useRef(new Map<string, PanelVariable>());
  const flushT = useRef(0);
  const selRef = useRef(sel);
  selRef.current = sel;
  useEffect(() => {
    setFull(new Map()); asked.current = new Set(); queue.current = [];
    landed.current = new Map(); window.clearTimeout(flushT.current);
  }, [key]);
  const pump = useCallback(() => {
    const s = selRef.current;
    if (!s) return;
    const k = selKey(s);
    while (busy.current < LAZY_PARALLEL && queue.current.length) {
      const name = queue.current.pop()!;
      busy.current++;
      panelApi.variable({ family: s.family, key: s.key, frame: s.frame, path: s.path, name })
        .then((r) => {
          if (selKey(selRef.current) !== k || !r.ok || !r.variable) return;
          landed.current.set(name, r.variable);
          if (!flushT.current) {
            flushT.current = window.setTimeout(() => {
              flushT.current = 0;
              const add = landed.current; landed.current = new Map();
              setFull((m) => { const n = new Map(m); add.forEach((v, nm) => n.set(nm, v)); return n; });
            }, 120);
          }
        })
        .catch(() => { /* the row simply keeps no spark */ })
        .finally(() => { busy.current--; pump(); });
    }
  }, []);
  const needs = useCallback((v: PanelVariable) => !barsOf(v, true).length, []);
  const byName = useMemo(() => new Map(vars.map((v) => [v.name, v])), [vars]);
  useEffect(() => {
    const root = body.current;
    if (!lazy || open || !root || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((es) => {
      for (const e of es) {
        const name = (e.target as HTMLElement).getAttribute("data-var-row") || "";
        if (!e.isIntersecting) {                 // scrolled past before its turn: drop it
          const i = queue.current.indexOf(name);
          if (i >= 0) { queue.current.splice(i, 1); asked.current.delete(name); }
          continue;
        }
        const v = byName.get(name);
        if (!v || asked.current.has(name) || !needs(v)) continue;
        asked.current.add(name);
        queue.current.push(name);
      }
      pump();
    }, { root, rootMargin: "600px 0px" });
    root.querySelectorAll("[data-var-row]").forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [lazy, open, rows, byName, needs, pump]);

  const openVar = useCallback((name: string) => { restore.current = name; setOpen(name); }, []);
  const back = useCallback(() => setOpen(null), []);

  // Esc out of a variable puts the focus back on its row, with the query untouched —
  // drawing down to it first when [ / ] stepped past the rows drawn so far
  useEffect(() => {
    if (open || !restore.current) return;
    const el = body.current?.querySelector<HTMLElement>(`[data-var-row="${CSS.escape(restore.current)}"]`);
    if (el) { document.documentElement.setAttribute("data-knav", ""); el.focus({ preventScroll: false }); }
    else {
      const i = shown.findIndex((v) => v.name === restore.current);
      if (i >= limit) { grow(i + 1); return; }
    }
    restore.current = null;
  }, [open, limit]); // eslint-disable-line react-hooks/exhaustive-deps

  const at = open ? shown.findIndex((v) => v.name === open) : -1;
  const step = useCallback((d: -1 | 1) => {
    if (at < 0) return;
    const n = shown[at + d];
    if (n) { restore.current = n.name; setOpen(n.name); }
  }, [at, shown]);
  useBracketStep(open ? step : null);
  useHomeEnd("[data-var-row], [data-ds-row]");
  useLeftToTabs();

  const cur = open ? shown.find((v) => v.name === open) || null : null;
  const src = ds?.source;
  const title = src && (src.family || src.key) ? [src.family, src.key].filter(Boolean).join("/") : selTitle(sel);
  // a path dataset knows neither count until its profile lands: draw nothing, never "— rows"
  const shape = src && src.nRows !== null
    ? nfmt(src.nRows) + " rows × " + nfmt(vars.length || src.nCols) + " vars"
    : vars.length ? nfmt(vars.length) + " vars" : "";

  return (
    <div data-panel="variables" data-size={size} className="h-screen flex flex-col bg-background text-foreground">
      <PanelHeader {...chrome} title={title || "Variables"} titleHint={src?.path || title} right={right} />

      {!sel ? (
        <RecentDatasets session={session} onSel={onSel} size={size} />
      ) : (
        <>
          <div className="shrink-0 px-2 pt-1 pb-1 border-b border-border/40">
            <div className={"flex items-center gap-1.5 " + WRAP}>
              <span data-panel-shape className="nums shrink-0 text-[9.5px] text-muted-foreground" title={src?.path || ""}>{shape}</span>
              {ds?.profile === "building" && (
                <span data-panel-profile="building" title="Reading the dataset — the descriptives land in a moment"
                  className="h-[6px] w-[6px] shrink-0 animate-pulse rounded-full bg-primary" />
              )}
              {ds?.profile === "failed" && (
                <span data-panel-profile="failed" title={ds.error || "The profile failed"}
                  className="h-[6px] w-[6px] shrink-0 rounded-full bg-danger" />
              )}
              {ds?.sampled && (
                <span data-panel-sample title={"Descriptives from a sample of " + nfmt(ds.sampleN) + " rows"}
                  className="shrink-0 rounded-full bg-muted px-1 text-[9px] leading-[13px] text-muted-foreground">sample</span>
              )}
              <span className="ml-auto" />
              <button type="button" data-knav-item data-panel-sort={sort}
                onClick={() => setSort((s) => SORTS[(SORTS.indexOf(s) + 1) % SORTS.length])}
                title={"Sorted by " + SORT_LABEL[sort]}
                className="inline-flex h-4 shrink-0 items-center gap-0.5 rounded px-1 text-[9px] text-muted-foreground outline-none hover:text-foreground">
                <SortAsc size={10} />{SORT_LABEL[sort]}
              </button>
            </div>
            <div className={"mt-1 flex items-center gap-1.5 rounded-md border border-border bg-background px-1.5 " + WRAP}>
              <Search size={11} className="shrink-0 text-muted-foreground" />
              <input value={q} onChange={(e) => setQ(e.target.value)} data-panel-search data-qa="data-search"
                data-knav-own="arrows enter" placeholder="search variables" title="Search names, labels and value labels"
                onKeyDown={(e) => {
                  if (e.defaultPrevented) return;
                  if (e.key === "ArrowDown" || e.key === "Enter") {
                    e.preventDefault();
                    const el = body.current?.querySelector<HTMLElement>("[data-var-row]");
                    if (el) { document.documentElement.setAttribute("data-knav", ""); el.focus({ preventScroll: false }); }
                  } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    const t = document.querySelector<HTMLElement>("[data-panel-tab][aria-current]");
                    if (t) { document.documentElement.setAttribute("data-knav", ""); t.focus({ preventScroll: true }); }
                  }
                }}
                className="min-w-0 flex-1 bg-transparent py-[3px] text-[11px] outline-none placeholder:text-muted-foreground/60" />
              {q && (
                <button type="button" onClick={() => setQ("")} title="Clear the search"
                  className="shrink-0 text-muted-foreground outline-none hover:text-foreground"><X size={11} /></button>
              )}
              <span data-panel-count className="nums shrink-0 text-[9px] text-muted-foreground">
                {tk.length ? nfmt(shown.length) + " of " + nfmt(vars.length) : nfmt(vars.length)}
              </span>
            </div>
          </div>

          <div ref={body} data-panel-body className="min-h-0 flex-1 overflow-y-auto">
            {cur ? (
              <VariableDetail sel={sel} row={cur} onBack={back} size={size} />
            ) : failed || (ds && !ds.ok) ? (
              <PanelEmpty>{failed || ds?.error || "That dataset didn't answer"}</PanelEmpty>
            ) : !ds ? (
              <PanelEmpty>Reading the dataset</PanelEmpty>
            ) : !vars.length ? (
              <PanelEmpty>{title} — no variables</PanelEmpty>
            ) : !rows.length ? (
              <PanelEmpty>Nothing matches that search</PanelEmpty>
            ) : (
              <div className={"px-1 pb-2 pt-0.5 " + WRAP}>
                {rows.map((v) => (
                  <VarRow key={v.name} v={v} full={full.get(v.name)} q={tk} size={size} trimmed={trimmed} onOpen={openVar} />
                ))}
                {more > 0 && (
                  <div key={limit} ref={sentinel} data-var-more={more} aria-hidden
                    className="px-1.5 pt-1 text-[9px] text-muted-foreground nums">{nfmt(more)} more</div>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

const TRACKS = {
  wide: "190px minmax(0,1fr) 34px 48px 86px 46px 46px 96px",
  mid: "150px minmax(0,1fr) 34px 48px 86px 46px",
  small: "104px minmax(0,1fr) 34px 48px 46px",
  xs: "88px minmax(0,1fr) 34px 48px 46px",
};

/* memo: a batch of lazily fetched distributions re-renders only the rows it touched */
const VarRow = memo(function VarRow({ v, full, q, size, trimmed, onOpen }: {
  v: PanelVariable; full?: PanelVariable; q: string[]; size: PaneSize; trimmed: boolean; onOpen: (name: string) => void;
}) {
  const wide = size === "lg" || size === "xl";
  const mid = wide || size === "md";
  const chip = chipOf(v);
  const range = v.min !== null && v.max !== null ? sig(v.min) + "–" + sig(v.max) : "";
  const bars = full ? barsOf(full, false) : barsOf(v, trimmed);
  return (
    <button type="button" data-knav-item data-var-row={v.name} onClick={() => onOpen(v.name)}
      title={[v.name, v.label, chip, v.missPct !== null ? v.missPct.toFixed(1) + "% missing" : ""].filter(Boolean).join(" · ")}
      style={{ gridTemplateColumns: wide ? TRACKS.wide : mid ? TRACKS.mid : size === "xs" ? TRACKS.xs : TRACKS.small }}
      className="grid w-full items-center gap-x-1.5 rounded px-1.5 py-[3px] text-left outline-none
                 hover:bg-accent/40 focus-visible:bg-accent/50 focus-visible:ring-1 focus-visible:ring-primary/60">
      <span className="min-w-0 whitespace-normal break-all font-mono text-[10.5px] leading-[1.25] text-foreground">
        <Hi text={v.name} q={q} />
      </span>
      <span className="min-w-0 truncate text-[10px] text-muted-foreground"><Hi text={v.label} q={q} /></span>
      {/* the chip's track is held while the profile is still building and draws no chip */}
      <span data-var-cell="chip" className="flex min-w-0 justify-center">
        {chip && <span data-var-chip={chip} className="shrink-0 rounded-sm bg-muted px-1 text-center text-[8.5px] uppercase leading-[13px] tracking-[0.04em] text-muted-foreground">{chip}</span>}
      </span>
      <MissBar pct={v.missPct} />
      {mid && <span data-var-cell="summary" className="nums min-w-0 truncate text-right text-[9.5px] text-muted-foreground">{summaryOf(v)}</span>}
      {/* always its 46 x 13, bars or not; only a drawn svg carries data-var-spark */}
      <span data-var-cell="dist" className="block" style={{ width: SPARK_W, height: SPARK_H }}><Spark bars={bars} /></span>
      {wide && <span className="nums min-w-0 text-right text-[9px] text-muted-foreground" title="distinct values">{nfmt(v.uniq, "")}</span>}
      {wide && <span className="nums min-w-0 truncate text-right text-[9px] text-muted-foreground" title="min – max">{range}</span>}
    </button>
  );
});

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[8.5px] uppercase tracking-[0.06em] text-muted-foreground">{label}</div>
      <div className="nums truncate text-[11px] text-foreground" title={value}>{value}</div>
    </div>
  );
}

function VariableDetail({ sel, row, onBack, size }: { sel: DatasetSel | null; row: PanelVariable; onBack: () => void; size: PaneSize }) {
  const [full, setFull] = useState<PanelVariable | null>(null);
  useEffect(() => {
    if (!sel) return;
    let live = true;
    setFull(null);
    panelApi.variable({ family: sel.family, key: sel.key, frame: sel.frame, path: sel.path, name: row.name })
      .then((r) => { if (live && r.ok && r.variable) setFull(r.variable); })
      .catch(() => {});
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selKey(sel), row.name]);
  const v = full ?? row;
  const [copied, setCopied] = useState(false);
  
  const backRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    document.documentElement.setAttribute("data-knav", "");
    backRef.current?.focus({ preventScroll: true });
  }, [row.name]);
  const wide = size !== "xs" && size !== "sm";
  const bars = v.hist?.counts ?? [];
  const max = Math.max(1, ...bars);
  const levels = v.top;
  const lmax = Math.max(1, ...levels.map((l) => l.n));
  const copy = async () => {
    const ok = await copyPlain(v.name);
    if (ok) { setCopied(true); window.setTimeout(() => setCopied(false), 1200); }
  };
  return (
    <div data-var-detail={v.name} className={"flex h-full min-h-0 flex-col " + WRAP}>
      <div className="flex shrink-0 items-center gap-1.5 px-1.5 py-1">
        <button ref={backRef} type="button" data-knav-back="2" data-qa="var-back" onClick={onBack} title="Back to the variables (Esc)"
          className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground outline-none hover:bg-accent hover:text-foreground">
          <ArrowLeft size={12} />
        </button>
        <span className="shrink-0 truncate font-mono text-[11.5px] font-medium">{v.name}</span>
        <span className="shrink-0 rounded-sm bg-muted px-1 text-[8.5px] uppercase leading-[13px] text-muted-foreground"
          title={v.storage || v.dtype}>{chipOf(v)}</span>
        <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground" title={v.label}>{v.label}</span>
        <button type="button" data-knav-item data-qa="var-copy" onClick={() => void copy()} title="Copy the variable name"
          className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground outline-none hover:bg-accent hover:text-foreground">
          {copied ? <Check size={12} /> : <Copy size={12} />}
        </button>
      </div>

      <div className="grid shrink-0 gap-x-2 gap-y-1 px-2 pb-1"
        style={{ gridTemplateColumns: `repeat(${wide ? 5 : 3}, minmax(0, 1fr))` }}>
        <Stat label="n" value={nfmt(v.n)} />
        <Stat label="missing" value={v.miss !== null ? nfmt(v.miss) + (v.missPct !== null ? " · " + v.missPct.toFixed(1) + "%" : "") : "—"} />
        <Stat label="unique" value={nfmt(v.uniq)} />
        <Stat label="min · median · max" value={[v.min, v.median, v.max].every((x) => x === null) ? "—" : sig(v.min) + " · " + sig(v.median) + " · " + sig(v.max)} />
        <Stat label="mean · sd" value={v.mean === null ? "—" : sig(v.mean) + " · " + sig(v.sd)} />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {bars.length ? (
          <div data-var-hist>
            <div className="flex h-[92px] items-end gap-[2px]">
              {bars.map((c, i) => {
                const edges = v.hist?.edges ?? [];
                const lo = edges[i], hi = edges[i + 1];
                return (
                  <span key={i} className="flex-1 rounded-t-[1px] bg-primary/60"
                    style={{ height: Math.max(c > 0 ? 2 : 0, Math.round((c / max) * 92)) + "px" }}
                    title={(lo !== undefined && hi !== undefined ? sig(lo) + " – " + sig(hi) + " · " : "") + nfmt(c)} />
                );
              })}
            </div>
            <div className="mt-0.5 flex justify-between text-[8.5px] text-muted-foreground nums">
              <span>{sig(v.hist?.edges[0] ?? null)}</span>
              <span>{sig(v.hist?.edges[v.hist.edges.length - 1] ?? null)}</span>
            </div>
          </div>
        ) : levels.length ? (
          <div data-var-levels className="flex flex-col gap-[3px]">
            {levels.map((l) => (
              <div key={l.value} className="flex items-center gap-1.5">
                <span className="w-[38%] shrink-0 truncate text-[10px] text-foreground" title={l.value + " · " + l.label}>{l.label || l.value}</span>
                <span className="relative h-[8px] min-w-0 flex-1 overflow-hidden rounded-sm bg-muted">
                  <span className="absolute inset-y-0 left-0 rounded-sm bg-primary/60" style={{ width: Math.round((l.n / lmax) * 100) + "%" }} />
                </span>
                <span className="nums w-[52px] shrink-0 text-right text-[9px] text-muted-foreground">{nfmt(l.n)}</span>
                <span className="nums w-[34px] shrink-0 text-right text-[9px] text-muted-foreground">{l.pct.toFixed(1)}%</span>
              </div>
            ))}
          </div>
        ) : (
          <PanelEmpty>No descriptives for this variable</PanelEmpty>
        )}
      </div>
    </div>
  );
}

function RecentDatasets({ session, onSel, size }: { session: string; onSel: (d: DatasetSel) => void; size: PaneSize }) {
  const [rows, setRows] = useState<PanelDatasetCard[] | null>(null);
  useEffect(() => {
    let live = true;
    const pull = () => panelApi.datasets(session).then((r) => { if (live) setRows(r); }).catch(() => { if (live) setRows([]); });
    pull();
    const t = window.setInterval(pull, 4000);
    window.addEventListener("focus", pull);
    return () => { live = false; window.clearInterval(t); window.removeEventListener("focus", pull); };
  }, [session]);
  const wide = size !== "xs" && size !== "sm";
  return (
    <div data-panel-body className="min-h-0 flex-1 overflow-y-auto px-1 pb-2 pt-1">
      {!!rows?.length && (
        <div data-var-pick className="flex items-center gap-1.5 px-0.5 pb-1">
          <span className="shrink-0 text-[9px] font-medium uppercase tracking-[0.08em] text-muted-foreground">pick a dataset</span>
          <span className="h-px flex-1 bg-border/70" />
          <span className="nums shrink-0 text-[9px] text-muted-foreground">{rows.length}</span>
        </div>
      )}
      {rows === null ? <PanelEmpty>Looking for datasets</PanelEmpty>
        : !rows.length ? <PanelEmpty>No dataset loaded yet</PanelEmpty>
        : rows.map((d) => (
          <button key={selKey(d)} type="button" data-knav-item data-ds-row={selKey(d)}
            onClick={() => onSel({ family: d.family, key: d.key, frame: d.frame, path: d.path })}
            title={[d.title, d.path, d.nRows !== null ? nfmt(d.nRows) + " rows" : "",
              d.nCols !== null ? nfmt(d.nCols) + " vars" : "", ago(d.ts)].filter(Boolean).join(" · ")}
            className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left outline-none
                       hover:bg-accent/40 focus-visible:bg-accent/50 focus-visible:ring-1 focus-visible:ring-primary/60">
            <span className="min-w-0 flex-1 truncate text-[10.5px] text-foreground">{d.title}</span>
            <span className="nums shrink-0 text-[9px] text-muted-foreground">{nfmt(d.nRows)} × {nfmt(d.nCols)}</span>
            {wide && <span className="shrink-0 text-[9px] text-muted-foreground">{ago(d.ts)}</span>}
            {d.profile === "building" && <span className="h-[5px] w-[5px] shrink-0 animate-pulse rounded-full bg-primary" />}
          </button>
        ))}
    </div>
  );
}
