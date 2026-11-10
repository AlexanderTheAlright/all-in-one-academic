
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, type NumbersCatalogue, type NumbersTable, type NumbersRow, type NumbersProv, type DraftNumbers, type NumbersEntryRow, type NumberBindEntry } from "@/lib/api";
import { numberStatusChip, numberScriptChip, compareNumberRows } from "@/lib/numberFlags";
import { Search, X, Sigma, Loader2, Star, Database, Check, AlertTriangle, RefreshCw, Table2, FileCode, ChevronRight, ChevronDown, Archive } from "lucide-react";

export type NumberInsert = { text: string; entries: NumberBindEntry[] };

export const MINUS = "−";
export type FormatKind = "plain" | "stat" | "percent" | "p" | "n" | "ci" | "text";
export const SYMBOLS = ["b", "β", "B", "OR", "HR", "RR", "IRR", "r", "ρ", "τ", "M", "Mdn", "SD", "SE", "d", "Δ", "R²", "η²", "α", "F", "t", "z", "χ²", "n", "N", "ICC", "AIC", "BIC", "RMSEA", "CFI", "TLI"];
// statistics that cannot exceed 1 in absolute value: APA drops their leading zero
export const BOUNDED = new Set(["β", "r", "ρ", "τ", "R²", "η²", "α", "ICC", "RMSEA", "CFI", "TLI"]);
export type Compose = {
  kind: FormatKind; symbol: string; decimals: number; leadingZero: boolean; thousands: boolean;
  parens: boolean; percentWord: "%" | "per cent" | "percent" | "percentage points"; scale100: boolean;
  pStyle: "exact" | "bands"; ciStyle: "brackets" | "to"; ciLow: string; ciHigh: string; appendP: string;
};

/** the numeric value of a CSV cell as the tables write them: "0.42***", "(0.12)",
 *  "**1,234**", "3.1e-05", "−0.4" — null when the cell is not a statistic */
export function cellValue(raw: string): number | null {
  const s = String(raw ?? "").replace(/\*/g, "").replace(/[†‡]/g, "").trim();
  const m = s.match(/[-+−]?(?:\d{1,3}(?:,\d{3})+|\d*\.?\d+)(?:\.\d+)?(?:[eE][-+]?\d+)?/);
  if (!m) return null;
  const v = parseFloat(m[0].replace(/,/g, "").replace(MINUS, "-"));
  return Number.isFinite(v) ? v : null;
}
export function cleanRaw(raw: string): string { return String(raw ?? "").replace(/\*\*/g, "").trim(); }

export function fmtNumber(v: number, decimals: number, opts: { leadingZero?: boolean; thousands?: boolean } = {}): string {
  const neg = v < 0;
  const a = Math.abs(v);
  let s = a.toFixed(Math.max(0, Math.min(6, decimals)));
  if (opts.thousands) { const [i, f] = s.split("."); s = i.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (f ? "." + f : ""); }
  if (opts.leadingZero === false && a < 1 && s.startsWith("0.")) s = s.slice(1);
  if (/^[0.]+$/.test(s.replace(/,/g, ""))) return s;   // never "−0.00"
  return (neg ? MINUS : "") + s;
}

export function guessFormat(column: string): Pick<Compose, "kind" | "symbol" | "decimals" | "leadingZero"> {
  const c = column.toLowerCase().trim();
  const has = (re: RegExp) => re.test(c);
  if (has(/^p$|^p[-_. ]?val|pvalue|p-value|\bp\b.*value|pr\(>|^sig$|significance/)) return { kind: "p", symbol: "p", decimals: 3, leadingZero: false };
  if (has(/^n$|^n[-_ ]|\bnobs\b|\bn\b|count|observations|^obs$/)) return { kind: "n", symbol: "n", decimals: 0, leadingZero: true };
  if (has(/\bor\b|odds/)) return { kind: "stat", symbol: "OR", decimals: 2, leadingZero: true };
  if (has(/\bhr\b|hazard/)) return { kind: "stat", symbol: "HR", decimals: 2, leadingZero: true };
  if (has(/\birr\b|incidence/)) return { kind: "stat", symbol: "IRR", decimals: 2, leadingZero: true };
  if (has(/\brr\b|relative risk|risk ratio/)) return { kind: "stat", symbol: "RR", decimals: 2, leadingZero: true };
  if (has(/beta|std\.? ?(coef|b\b)|standardi[sz]ed|β/)) return { kind: "stat", symbol: "β", decimals: 2, leadingZero: false };
  if (has(/\bse\b|std\.? ?err|s\.e\./)) return { kind: "stat", symbol: "SE", decimals: 2, leadingZero: true };
  if (has(/\bsd\b|std\.? ?dev/)) return { kind: "stat", symbol: "SD", decimals: 2, leadingZero: true };
  if (has(/\(r\)|\bcorr|^r$|\br\b/)) return { kind: "stat", symbol: "r", decimals: 2, leadingZero: false };
  if (has(/percent|pct|%|share|\bprop|proportion|rate/)) return { kind: "percent", symbol: "", decimals: 1, leadingZero: true };
  if (has(/\bmean\b|^m$|\bavg|average/)) return { kind: "stat", symbol: "M", decimals: 2, leadingZero: true };
  if (has(/chi|χ/)) return { kind: "stat", symbol: "χ²", decimals: 2, leadingZero: true };
  if (has(/^t$|t-stat|tstat|\bt value/)) return { kind: "stat", symbol: "t", decimals: 2, leadingZero: true };
  if (has(/^z$|z-stat|zstat|\bz value/)) return { kind: "stat", symbol: "z", decimals: 2, leadingZero: true };
  if (has(/^f$|f-stat|fstat/)) return { kind: "stat", symbol: "F", decimals: 2, leadingZero: true };
  if (has(/r2|r-squared|r²|rsq/)) return { kind: "stat", symbol: "R²", decimals: 2, leadingZero: false };
  if (has(/\(b\)|\best\b|estimate|coef|^b$|\bb\b/)) return { kind: "stat", symbol: "b", decimals: 2, leadingZero: true };
  return { kind: "plain", symbol: "", decimals: 2, leadingZero: true };
}

export function defaultCompose(column: string, v: number | null, row: NumbersRow | null, table: NumbersTable | null): Compose {
  const g = guessFormat(column);
  const cols = table?.numericColumns ?? [];
  const ciLow = cols.find((c) => /ci[_. ]?(low|lo|l)\b|lower|2\.5|lcl|\bll\b|conf\.?low/i.test(c)) || "";
  const ciHigh = cols.find((c) => /ci[_. ]?(high|hi|h|u)\b|upper|97\.5|ucl|\bul\b|conf\.?high/i.test(c)) || "";
  const pCol = cols.find((c) => guessFormat(c).kind === "p" && c !== column) || "";
  return {
    kind: g.kind, symbol: g.symbol, decimals: g.decimals, leadingZero: g.leadingZero, thousands: g.kind === "n",
    parens: false, percentWord: "per cent", scale100: g.kind === "percent" && v !== null && Math.abs(v) <= 1,
    pStyle: "exact", ciStyle: "brackets", ciLow, ciHigh, appendP: row && pCol && g.kind === "stat" ? pCol : "",
  };
}

type Part = { written: string; column: string; mode: "numeric" | "threshold" | "text"; scale: number };

function pPart(v: number, c: Compose, column: string): { text: string; part: Part } {
  if (v < 0.001) return { text: "p < .001", part: { written: ".001", column, mode: "threshold", scale: 1 } };
  if (c.pStyle === "bands") {
    if (v < 0.01) return { text: "p < .01", part: { written: ".01", column, mode: "threshold", scale: 1 } };
    if (v < 0.05) return { text: "p < .05", part: { written: ".05", column, mode: "threshold", scale: 1 } };
  }
  const s = fmtNumber(v, c.decimals, { leadingZero: false });
  if (/^\.?0*$/.test(s)) return { text: "p < .001", part: { written: ".001", column, mode: "threshold", scale: 1 } };
  return { text: "p = " + s, part: { written: s, column, mode: "numeric", scale: 1 } };
}

/** the inserted string + one binding part per number inside it; null when the cell
 *  cannot be formatted this way (e.g. a CI without both bound columns) */
export function compose(raw: string, column: string, c: Compose, row: NumbersRow | null): { text: string; parts: Part[] } | null {
  if (c.kind === "text") {
    const t = cleanRaw(raw);
    return t ? { text: t, parts: [{ written: t, column, mode: "text", scale: 1 }] } : null;
  }
  const v = cellValue(raw);
  if (v === null) return null;
  let text = ""; const parts: Part[] = [];
  if (c.kind === "p") {
    const r = pPart(v, c, column); text = r.text; parts.push(r.part);
  } else if (c.kind === "n") {
    const s = fmtNumber(v, 0, { thousands: true });
    text = (c.symbol || "n") + " = " + s; parts.push({ written: s, column, mode: "numeric", scale: 1 });
  } else if (c.kind === "percent") {
    const scale = c.scale100 ? 100 : 1;
    const s = fmtNumber(v * scale, c.decimals, { thousands: c.thousands });
    text = c.percentWord === "%" ? s + "%" : s + " " + c.percentWord;
    parts.push({ written: s, column, mode: "numeric", scale });
  } else if (c.kind === "ci") {
    if (!row || !c.ciLow || !c.ciHigh) return null;
    const lo = cellValue(row.cells[c.ciLow] ?? ""), hi = cellValue(row.cells[c.ciHigh] ?? "");
    if (lo === null || hi === null) return null;
    const a = fmtNumber(lo, c.decimals, { leadingZero: c.leadingZero }), b = fmtNumber(hi, c.decimals, { leadingZero: c.leadingZero });
    text = c.ciStyle === "brackets" ? `95% CI [${a}, ${b}]` : `95% CI ${a} to ${b}`;
    parts.push({ written: a, column: c.ciLow, mode: "numeric", scale: 1 }, { written: b, column: c.ciHigh, mode: "numeric", scale: 1 });
  } else {
    const s = fmtNumber(v, c.decimals, { leadingZero: c.leadingZero, thousands: c.thousands });
    text = c.kind === "stat" && c.symbol ? c.symbol + " = " + s : s;
    parts.push({ written: s, column, mode: "numeric", scale: 1 });
  }
  if (c.kind !== "p" && c.kind !== "ci" && c.appendP && row) {
    const pv = cellValue(row.cells[c.appendP] ?? "");
    if (pv !== null) { const r = pPart(pv, c, c.appendP); text += ", " + r.text; parts.push(r.part); }
  }
  if (c.parens) text = "(" + text + ")";
  return { text, parts };
}

/* ---------------------------------------------------------------------------- */

const FRESH_CHIP: Record<string, string> = {
  fresh: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  stale: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  unrecorded: "bg-muted text-muted-foreground",
  missing: "bg-rose-500/15 text-rose-600 dark:text-rose-400",
};
const FRESH_HINT: Record<string, string> = {
  fresh: "provenance.json's recorded hash matches this table on disk — the number comes from the recorded script run",
  stale: "this table changed after its provenance was recorded — the script was re-run (or the file edited) and the record was not refreshed",
  unrecorded: "no provenance.json record for this file (replication/output tables are script outputs without a recorder entry) — the binding still snapshots its hash",
  missing: "the source file is gone",
};
function FreshChip({ prov }: { prov: NumbersProv | null | undefined }) {
  const f = prov?.freshness || "unrecorded";
  return <span title={FRESH_HINT[f] || f} className={`text-[9px] px-1.5 py-px rounded-full font-semibold shrink-0 ${FRESH_CHIP[f] || FRESH_CHIP.unrecorded}`}>{f}</span>;
}
function fmtDate(ms: number | null | undefined): string {
  if (!ms) return "";
  try { return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }); } catch { return ""; }
}

type Sel = { table: NumbersTable; row: NumbersRow; column: string };

function tokens(q: string): string[] { return q.toLowerCase().split(/\s+/).map((t) => t.trim()).filter(Boolean); }
function rowMatches(t: NumbersTable, r: NumbersRow, toks: string[]): { col: string | null } | null {
  if (!toks.length) return { col: null };
  const head = (t.stem + " " + (t.caption || "") + " " + r.label).toLowerCase();
  let matchedCol: string | null = null;
  const ok = toks.every((tok) => {
    if (head.includes(tok)) return true;
    for (const c of t.numericColumns) {
      const raw = (r.cells[c] || "").toLowerCase();
      if (c.toLowerCase().includes(tok) || (raw && raw.includes(tok))) { matchedCol = matchedCol || c; return true; }
    }
    return false;
  });
  return ok ? { col: matchedCol } : null;
}

export type NumberPreselect = { file: string; row?: Record<string, string> | number | string | null; column?: string; display?: NumberDisplayHint };

export type NumberDisplayHint = Partial<Pick<Compose,
  "kind" | "symbol" | "decimals" | "leadingZero" | "thousands" | "parens" | "percentWord" | "scale100" | "pStyle" | "appendP">>;

const normLabel = (s: unknown): string => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
/** a cell or selector value compared without the CSV's own indentation, bold markers or case */
const normCell = (s: unknown): string => normLabel(cleanRaw(String(s ?? "")));
/** a row label compared across the two renderings of a compound row ("a · b" vs "a b") */
const flatLabel = (s: unknown): string => normCell(s).replace(/\s*·\s*/g, " ").replace(/\s+/g, " ").trim();
/** a selector normalised for COMPARISON only — nothing stored is mutated, so a rebuilt
 *  findings.json or catalogue keeps binding either way */
function normSelector(sel: unknown): Map<string, string> {
  const m = new Map<string, string>();
  if (!sel || typeof sel !== "object") return m;
  for (const [k, v] of Object.entries(sel as Record<string, unknown>)) m.set(normLabel(k), normCell(v));
  return m;
}
/** every key `want` names agrees with this row — a findings selector may name a SUBSET of a
 *  compound catalogue selector's keys */
function selectorAgrees(rowSel: Map<string, string>, want: Map<string, string>): boolean {
  if (!want.size) return false;
  for (const [k, v] of want) if (rowSel.get(k) !== v) return false;
  return true;
}

function normCells(row: NumbersRow): Map<string, string> {
  const m = new Map<string, string>();
  for (const [k, v] of Object.entries(row.cells || {})) m.set(normLabel(k), normCell(v));
  return m;
}

export function NumberPicker({ slug, docName, preselect, onInsert, onJumpToLine, onViewFile, onClose }: {
  slug: string; docName: string; preselect?: NumberPreselect | null;
  onInsert: (ins: NumberInsert) => void | Promise<void>;
  onJumpToLine: (doc: string, line: number) => void;
  onViewFile: (candidates: string[], title: string) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"catalogue" | "paper">("catalogue");
  const [cat, setCat] = useState<NumbersCatalogue | null>(null);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState("");
  const [openTables, setOpenTables] = useState<Record<string, boolean>>({});
  const [sel, setSel] = useState<Sel | null>(null);
  const [comp, setComp] = useState<Compose | null>(null);
  const [note, setNote] = useState("");
  const [key, setKey] = useState(false);
  const [inserting, setInserting] = useState(false);
  const [rep, setRep] = useState<DraftNumbers | null>(null);
  const [repLoading, setRepLoading] = useState(false);
  const [retiring, setRetiring] = useState<string | null>(null);
  // why a preselected cell could not be bound — never a wrong cell instead
  const [preMiss, setPreMiss] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try { setCat(await api.draftingNumbersCatalogue(slug)); }
    catch { setCat({ error: "catalogue unreachable" }); }
    finally { setLoading(false); }
  }, [slug]);
  const loadRep = useCallback(async () => {
    setRepLoading(true);
    try { setRep(await api.draftingNumbers(slug, docName)); }
    catch { setRep({ error: "numbers report unreachable" }); }
    finally { setRepLoading(false); }
  }, [slug, docName]);
  useEffect(() => { void load(); void loadRep(); }, [load, loadRep]);
  useEffect(() => { setTimeout(() => searchRef.current?.focus(), 30); }, []);
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [onClose]);

  const toks = useMemo(() => tokens(q), [q]);
  const tables = cat?.tables ?? [];
  // search: every table whose stem/caption/row label/column/value carries every token,
  // matched rows only; without a query the tables list collapsed
  const shown = useMemo(() => {
    const out: { table: NumbersTable; rows: { row: NumbersRow; col: string | null }[] }[] = [];
    for (const t of tables) {
      const rows: { row: NumbersRow; col: string | null }[] = [];
      for (const r of t.rows) { const m = rowMatches(t, r, toks); if (m) rows.push({ row: r, col: m.col }); }
      if (rows.length) out.push({ table: t, rows });
    }
    return out;
  }, [tables, toks]);
  const totalHits = useMemo(() => shown.reduce((n, s) => n + s.rows.length, 0), [shown]);
  const isOpen = (t: NumbersTable) => (toks.length ? true : !!openTables[t.file]);

  const pick = (table: NumbersTable, row: NumbersRow, column: string, hint?: NumberDisplayHint | null) => {
    setSel({ table, row, column });
    // the cell's value is ALWAYS the catalogue's live read of the CSV; a hint only says
    // how to read it, never what it is
    const base = defaultCompose(column, cellValue(row.cells[column] ?? ""), row, table);
    if (hint) for (const [k, v] of Object.entries(hint)) if (v !== undefined) (base as Record<string, unknown>)[k] = v;
    setComp(base);
    setNote(`${table.stem} · ${row.label} · ${column}`);
    setKey(false);
    setPreMiss(null);
  };
  // a cell another surface already chose (Findings › Insert): open its table and land
  // the composer on it as soon as the catalogue is in. Once per preselect.
  const preDone = useRef("");
  useEffect(() => {
    if (!preselect || !cat?.tables) return;
    const k = preselect.file + "|" + JSON.stringify(preselect.row ?? null) + "|" + (preselect.column ?? "");
    if (preDone.current === k) return;
    const base = (p: string) => p.split("/").pop() || p;
    const t = cat.tables.find((x) => x.file === preselect.file) || cat.tables.find((x) => base(x.file) === base(preselect.file));
    preDone.current = k;
    if (!t) { setPreMiss(base(preselect.file) + " is not in the catalogue — it sits outside the scanned result folders"); return; }
    const want = preselect.row;
    let r: NumbersRow | null = null;
    if (want == null) r = t.rows[0] ?? null;                       // no row named: open the table
    else if (typeof want === "number") r = t.rows.find((x) => x.i === want) ?? null;
    else if (typeof want === "string") r = t.rows.find((x) => flatLabel(x.label) === flatLabel(want)) ?? null;
    else {
      const w = normSelector(want);
      const all = t.rows.filter((x) => selectorAgrees(normSelector(x.selector), w));
      const exact = all.filter((x) => normSelector(x.selector).size === w.size);
      let hits = exact.length ? exact : all;
      if (!hits.length) hits = t.rows.filter((x) => selectorAgrees(normCells(x), w));
      if (hits.length === 1) r = hits[0];
      else if (hits.length > 1) {
        setPreMiss(hits.length + " rows in " + t.stem + " match " + Object.values(want).map((v) => String(v).trim()).join(" · ")
          + " — pick the row yourself so the binding names one cell");
        setOpenTables((o) => ({ ...o, [t.file]: true }));
        return;
      } else r = t.rows.find((x) => flatLabel(x.label) === flatLabel(Object.values(want).join(" "))) ?? null;
    }
    if (!r) {
      setPreMiss("no row in " + t.stem + " matches " + (want == null ? "this number" : flatLabel(typeof want === "object" ? Object.values(want).join(" ") : String(want)))
        + " — pick the row yourself");
      setOpenTables((o) => ({ ...o, [t.file]: true }));
      return;
    }
    const wantCol = preselect.column || "";
    const col = wantCol && r.cells[wantCol] !== undefined ? wantCol
      : t.numericColumns.find((x) => normLabel(x) === normLabel(wantCol))
      ?? Object.keys(r.cells).find((x) => normLabel(x) === normLabel(wantCol))
      ?? t.numericColumns[0];
    setOpenTables((o) => ({ ...o, [t.file]: true }));
    if (col) pick(t, r, col, preselect.display);
  }, [preselect, cat]);   // eslint-disable-line react-hooks/exhaustive-deps

  const preview = useMemo(() => (sel && comp) ? compose(sel.row.cells[sel.column] ?? "", sel.column, comp, sel.row) : null, [sel, comp]);
  const doInsert = async () => {
    if (!sel || !comp || !preview) return;
    setInserting(true);
    try {
      await onInsert({
        text: preview.text,
        entries: preview.parts.map((p) => ({
          written: p.written, file: sel.table.file, column: p.column, row: sel.row.selector,
          scale: p.scale, mode: p.mode, display: comp.kind, note, key,
        })),
      });
      onClose();
    } finally { setInserting(false); }
  };
  const viewTable = (t: NumbersTable) => onViewFile([t.file], t.name);
  const viewScript = (rel: string) => onViewFile([rel, "replication/" + rel.split("/").pop()!], rel.split("/").pop()!);
  const update = async (id: string, patch: { key?: boolean; note?: string; resnapshot?: boolean; retire?: boolean; reason?: string }) => {
    const r = await api.draftingNumbersUpdate(slug, id, patch);
    if (r.ok) { void loadRep(); void load(); }
    return r;
  };
  const set = <K extends keyof Compose>(k: K, v: Compose[K]) => setComp((c) => (c ? { ...c, [k]: v } : c));
  const chip = (on: boolean, label: string, onClick: () => void, title?: string) => (
    <button key={label} onClick={onClick} title={title}
      className={`rounded-full border px-2 py-0.5 text-[10.5px] nums ${on ? "border-primary/50 text-foreground bg-primary/10" : "border-border text-muted-foreground hover:text-foreground"}`}>{label}</button>
  );

  const docs = rep?.docs ?? {};
  const bound: { doc: string; r: NumbersEntryRow }[] = [];
  for (const d of Object.keys(docs)) for (const r of docs[d].results || []) bound.push({ doc: d, r });
  bound.sort((a, b) => compareNumberRows(a.r, b.r));
  const jumpDoc = (name: string) => (name.toLowerCase() === "readme.md" ? "readme.md" : name);

  return createPortal(
    <>
      <div className="fixed inset-0 z-[150] bg-black/30" onMouseDown={(e) => { e.preventDefault(); onClose(); }} />
      <div data-qa="number-picker" role="dialog" aria-modal="true" aria-label="Insert number" data-knav-modal className="fixed z-[151] left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 flex flex-col rounded-xl border border-border bg-card shadow-2xl overflow-hidden"
        style={{ width: "min(960px, calc(100vw - 48px))", height: "min(680px, calc(100vh - 48px))" }} onMouseDown={(e) => e.stopPropagation()}>
        <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-border">
          <Sigma size={15} className="text-primary shrink-0" />
          <span className="text-[13px] font-medium">Insert number</span>
          <div className="ml-2 inline-flex rounded-md border border-border p-0.5">
            <button onClick={() => setTab("catalogue")} className={`px-2 py-0.5 rounded text-[11px] ${tab === "catalogue" ? "bg-primary/10 text-foreground" : "text-muted-foreground hover:text-foreground"}`}>Catalogue{cat?.tables ? <span className="nums text-muted-foreground"> · {cat.tables.length}</span> : null}</button>
            <button data-qa="tab-paper" onClick={() => { setTab("paper"); if (!rep) void loadRep(); }} className={`px-2 py-0.5 rounded text-[11px] ${tab === "paper" ? "bg-primary/10 text-foreground" : "text-muted-foreground hover:text-foreground"}`}>In this paper{rep && !rep.error ? <span className="nums text-muted-foreground"> · {bound.length}</span> : null}</button>
          </div>
          <span className="flex-1" />
          <button onClick={() => { void load(); void loadRep(); }} title="Re-read the tables, provenance and bindings from disk" className="inline-flex items-center justify-center w-6 h-6 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent">{loading || repLoading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}</button>
          <button type="button" onClick={onClose} data-knav-back="2" title="Close (Esc)" className="inline-flex items-center justify-center w-6 h-6 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent"><X size={15} /></button>
        </div>

        {tab === "catalogue" && (
          <div className="flex-1 min-h-0 flex">
            {/* LEFT — search + tables */}
            <div className="w-[440px] shrink-0 border-r border-border flex flex-col min-h-0">
              <div className="shrink-0 px-2 py-1.5 border-b border-border/70">
                <div className="flex items-center gap-1.5 rounded-md border border-border bg-background px-2">
                  <Search size={12} className="text-muted-foreground shrink-0" />
                  <input ref={searchRef} data-qa="number-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a table, a row, a column, or the value itself (e.g. mediation US, OR, 0.42)"
                    className="flex-1 bg-transparent py-1.5 text-[12px] outline-none placeholder:text-muted-foreground/60" />
                  {q && <button onClick={() => setQ("")} className="text-muted-foreground hover:text-foreground"><X size={12} /></button>}
                </div>
                <p className="px-1 pt-1 text-[10px] text-muted-foreground/70 nums">
                  {loading && !cat ? "reading the result tables…" : cat?.error ? cat.error : toks.length ? `${totalHits} matching row${totalHits === 1 ? "" : "s"} across ${shown.length} table${shown.length === 1 ? "" : "s"}` : `${tables.length} table${tables.length === 1 ? "" : "s"} · click one to browse its rows`}
                </p>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto">
                {!loading && cat && !cat.error && tables.length === 0 && (
                  <p className="m-3 px-2 py-2 rounded-md bg-amber-500/10 text-[11px] text-amber-600 dark:text-amber-400">No result tables with numeric columns in results/ or replication/output/ yet. Numbers must exist in an output CSV before they can be cited (they are never computed at prose time).</p>
                )}
                {shown.map(({ table: t, rows }) => (
                  <div key={t.file} data-qa="number-table" className="border-b border-border/50">
                    <button onClick={() => setOpenTables((o) => ({ ...o, [t.file]: !o[t.file] }))} className="flex items-center gap-1.5 w-full px-2 py-1.5 text-left hover:bg-accent/60">
                      {isOpen(t) ? <ChevronDown size={12} className="text-muted-foreground shrink-0" /> : <ChevronRight size={12} className="text-muted-foreground shrink-0" />}
                      <Table2 size={12} className="text-muted-foreground shrink-0" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-mono text-[11px] text-foreground/90">{t.stem}<span className="text-muted-foreground/60"> · {t.root}</span></span>
                        {t.caption && <span className="block truncate text-[10px] text-muted-foreground/70">{t.caption}</span>}
                      </span>
                      <span className="text-[10px] text-muted-foreground nums shrink-0">{toks.length ? rows.length + "/" : ""}{t.rowCount}{t.truncated ? "+" : ""}</span>
                      <FreshChip prov={t.provenance} />
                    </button>
                    {isOpen(t) && (
                      <div className="pb-1">
                        {rows.map(({ row: r, col: hitCol }) => (
                          <div key={r.i} data-qa="number-row" className="px-2 py-1 text-[11px] leading-snug">
                            <div className="truncate text-foreground/80" title={r.label}>{cleanRaw(r.label)}</div>
                            <div className="flex flex-wrap gap-1 mt-0.5">
                              {t.numericColumns.map((c) => {
                                const raw = r.cells[c] ?? "";
                                if (!raw.trim()) return null;
                                const on = sel?.table.file === t.file && sel.row.i === r.i && sel.column === c;
                                const isBound = !!(r.bound && r.bound[c]);
                                return (
                                  <button key={c} data-qa="number-cell" onClick={() => pick(t, r, c)}
                                    title={`${c} = ${cleanRaw(raw)}${isBound ? " · already cited in the paper (" + r.bound[c].join(", ") + ")" : ""}`}
                                    className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 max-w-[210px] ${on ? "border-primary/60 bg-primary/10 text-foreground" : hitCol === c ? "border-amber-500/40 bg-amber-500/5 text-foreground" : "border-border/70 text-muted-foreground hover:text-foreground hover:bg-accent"}`}>
                                    {isBound && <Check size={10} className="text-emerald-500 shrink-0" />}
                                    <span className="truncate text-[10px] text-muted-foreground/80">{c}</span>
                                    <span className="font-mono nums text-[11px] shrink-0">{cleanRaw(raw).slice(0, 18)}</span>
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* RIGHT — the composer */}
            <div className="flex-1 min-w-0 flex flex-col min-h-0">
              {!sel || !comp ? (
                <div className="flex-1 flex flex-col items-center justify-center gap-2.5 p-6">
                  {preMiss && (
                    <div data-qa="number-preselect-miss" className="max-w-[380px] rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-center">
                      <p className="text-[11.5px] text-amber-600 dark:text-amber-400 leading-snug">{preMiss}</p>
                      <button data-qa="number-insert" disabled title={preMiss}
                        className="mt-1.5 inline-flex items-center gap-1.5 rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-[12px] font-medium disabled:opacity-50">
                        <Sigma size={13} /> Insert at cursor and bind
                      </button>
                    </div>
                  )}
                  <p className="text-[12px] text-muted-foreground max-w-[380px] leading-relaxed text-center"
                    title="You choose how it reads; it is inserted at your cursor and bound to that cell, so the Numbers gate flags any change underneath it">Pick a cell on the left.</p>
                </div>
              ) : (
                <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
                  <div>
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground/70">Source cell</p>
                    <p className="text-[12px] text-foreground/90 mt-0.5"><span className="font-mono">{sel.table.stem}</span> · {cleanRaw(sel.row.label)} · <span className="font-mono">{sel.column}</span></p>
                    <p className="font-mono nums text-[12px] text-muted-foreground mt-0.5">raw: {cleanRaw(sel.row.cells[sel.column] ?? "")}</p>
                  </div>
                  <div className="rounded-md border border-border/70 bg-background/50 px-2.5 py-2 text-[11px] space-y-1">
                    <div className="flex items-center gap-2">
                      <p className="text-[10px] uppercase tracking-wide text-muted-foreground/70 flex-1">Provenance</p>
                      <FreshChip prov={sel.table.provenance} />
                    </div>
                    {sel.table.provenance?.script ? (
                      <button onClick={() => viewScript(sel.table.provenance!.script!)} className="flex items-center gap-1 text-muted-foreground hover:text-primary max-w-full"><FileCode size={11} className="shrink-0" /><span className="font-mono truncate">{sel.table.provenance.script}</span></button>
                    ) : <p className="text-muted-foreground/70">no producing script recorded for this file</p>}
                    <button onClick={() => viewTable(sel.table)} className="flex items-center gap-1 text-muted-foreground hover:text-primary max-w-full"><Database size={11} className="shrink-0" /><span className="font-mono truncate">{sel.table.file}</span></button>
                    <p className="text-muted-foreground/80 nums">
                      {sel.table.provenance?.generated ? "generated " + fmtDate(sel.table.provenance.generated) + " · " : ""}
                      {sel.table.provenance?.commit ? "commit " + sel.table.provenance.commit + " · " : ""}
                      file {fmtDate(sel.table.mtime)}{sel.table.sha256 ? " · sha " + sel.table.sha256.slice(0, 10) : ""}
                    </p>
                    {sel.table.provenance?.freshness === "stale" && <p className="text-amber-600 dark:text-amber-400 flex items-start gap-1"><AlertTriangle size={11} className="shrink-0 mt-0.5" /> This table changed after its provenance was recorded. Check the script re-ran cleanly before citing it.</p>}
                  </div>

                  <div>
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground/70 mb-1">Display as</p>
                    <div className="flex flex-wrap gap-1">
                      {chip(comp.kind === "stat", "statistic", () => set("kind", "stat"), "symbol = value (b, β, OR, r, M, SD, χ² …)")}
                      {chip(comp.kind === "p", "p-value", () => set("kind", "p"), "p < .001 below the floor, p = .012 otherwise; leading zero dropped")}
                      {chip(comp.kind === "percent", "percent", () => set("kind", "percent"), "12.3 per cent / 12.3% / percentage points; ×100 for a proportion")}
                      {chip(comp.kind === "ci", "95% CI", () => set("kind", "ci"), "95% CI [lower, upper] from two columns of this row")}
                      {chip(comp.kind === "n", "count", () => set("kind", "n"), "n = 1,234 with thousands separators")}
                      {chip(comp.kind === "plain", "plain", () => set("kind", "plain"), "the number alone")}
                      {chip(comp.kind === "text", "as written", () => set("kind", "text"), "the cell verbatim (mode: text)")}
                    </div>
                  </div>

                  {comp.kind === "stat" && (
                    <div>
                      <p className="text-[10px] uppercase tracking-wide text-muted-foreground/70 mb-1">Symbol</p>
                      {/* a bounded statistic (β, r, R², η², fit indices) drops its leading zero (APA); picking the symbol sets that, the toggle below still overrides */}
                      <div className="flex flex-wrap gap-1">{SYMBOLS.map((s) => chip(comp.symbol === s, s, () => setComp((c) => (c ? { ...c, symbol: s, leadingZero: !BOUNDED.has(s) } : c))))}</div>
                    </div>
                  )}
                  {comp.kind === "n" && (
                    <div className="flex items-center gap-1"><span className="text-[10px] uppercase tracking-wide text-muted-foreground/70 mr-1">Symbol</span>{chip(comp.symbol !== "N", "n", () => set("symbol", "n"))}{chip(comp.symbol === "N", "N", () => set("symbol", "N"))}</div>
                  )}
                  {comp.kind === "percent" && (
                    <div className="flex flex-wrap items-center gap-1">
                      <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70 mr-1">Unit</span>
                      {(["per cent", "%", "percent", "percentage points"] as const).map((w) => chip(comp.percentWord === w, w, () => set("percentWord", w)))}
                      <span className="mx-1 h-3 w-px bg-border" />
                      {chip(comp.scale100, "×100", () => set("scale100", !comp.scale100), "the cell is a proportion (0–1); multiply by 100 and record scale=100 in the binding")}
                    </div>
                  )}
                  {comp.kind === "p" && (
                    <div className="flex items-center gap-1"><span className="text-[10px] uppercase tracking-wide text-muted-foreground/70 mr-1">Style</span>{chip(comp.pStyle === "exact", "exact (p = .012)", () => set("pStyle", "exact"))}{chip(comp.pStyle === "bands", "bands (p < .05 / .01 / .001)", () => set("pStyle", "bands"))}</div>
                  )}
                  {comp.kind === "ci" && (
                    <div className="flex flex-wrap items-center gap-2 text-[11px]">
                      <label className="flex items-center gap-1 text-muted-foreground">lower
                        <select value={comp.ciLow} onChange={(e) => set("ciLow", e.target.value)} className="rounded-md border border-border bg-background px-1 py-0.5 text-[11px]"><option value="">—</option>{sel.table.numericColumns.map((c) => <option key={c} value={c}>{c}</option>)}</select></label>
                      <label className="flex items-center gap-1 text-muted-foreground">upper
                        <select value={comp.ciHigh} onChange={(e) => set("ciHigh", e.target.value)} className="rounded-md border border-border bg-background px-1 py-0.5 text-[11px]"><option value="">—</option>{sel.table.numericColumns.map((c) => <option key={c} value={c}>{c}</option>)}</select></label>
                      {chip(comp.ciStyle === "brackets", "[a, b]", () => set("ciStyle", "brackets"))}{chip(comp.ciStyle === "to", "a to b", () => set("ciStyle", "to"))}
                    </div>
                  )}
                  {comp.kind !== "text" && comp.kind !== "n" && (
                    <div className="flex flex-wrap items-center gap-1">
                      <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70 mr-1">Decimals</span>
                      {[0, 1, 2, 3, 4].map((d) => chip(comp.decimals === d, String(d), () => set("decimals", d)))}
                      <span className="mx-1 h-3 w-px bg-border" />
                      {chip(!comp.leadingZero, "drop leading 0", () => set("leadingZero", !comp.leadingZero), "APA: no leading zero for statistics that cannot exceed 1 (p, r, β)")}
                      {chip(comp.thousands, "1,000", () => set("thousands", !comp.thousands), "thousands separators")}
                      {chip(comp.parens, "( … )", () => set("parens", !comp.parens), "wrap in parentheses")}
                    </div>
                  )}
                  {comp.kind !== "p" && comp.kind !== "ci" && comp.kind !== "text" && sel.table.numericColumns.some((c) => guessFormat(c).kind === "p") && (
                    <div className="flex flex-wrap items-center gap-1">
                      <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70 mr-1">Append p from</span>
                      {chip(!comp.appendP, "none", () => set("appendP", ""))}
                      {sel.table.numericColumns.filter((c) => guessFormat(c).kind === "p").map((c) => chip(comp.appendP === c, c, () => set("appendP", c)))}
                    </div>
                  )}

                  <div className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2">
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground/70">Inserts</p>
                    <p data-qa="number-preview" className="text-[15px] mt-0.5 nums" style={{ fontFamily: "'Times New Roman', Times, serif" }}>{preview ? preview.text : <span className="text-rose-600 dark:text-rose-400 text-[12px]">this cell cannot be shown that way{comp.kind === "ci" ? " — pick both CI columns" : ""}</span>}</p>
                    {preview && preview.parts.length > 1 && <p className="text-[10px] text-muted-foreground mt-0.5 nums">binds {preview.parts.length} numbers: {preview.parts.map((p) => p.column + " = " + p.written).join(" · ")}</p>}
                  </div>

                  <div className="flex items-center gap-2">
                    <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="note for the binding (what this number is)" className="flex-1 rounded-md border border-border bg-background px-2 py-1 text-[11px] outline-none focus:border-primary/50" />
                    <button onClick={() => setKey(!key)} title="Pin as a key number — listed first in the reader" className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[10.5px] ${key ? "border-amber-500/50 text-amber-600 dark:text-amber-400 bg-amber-500/10" : "border-border text-muted-foreground hover:text-foreground"}`}><Star size={11} className={key ? "fill-current" : ""} /> key</button>
                  </div>
                  <button data-qa="number-insert" onClick={() => void doInsert()} disabled={!preview || inserting}
                    title={preview ? "Insert " + preview.text + " at the caret and bind it to this cell"
                      : "this cell cannot be shown that way — choose another display format, or another cell"}
                    className="inline-flex items-center gap-1.5 rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-[12px] font-medium hover:bg-primary/90 disabled:opacity-50">
                    {inserting ? <Loader2 size={13} className="animate-spin" /> : <Sigma size={13} />} Insert at cursor and bind
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {tab === "paper" && (
          <div className="flex-1 min-h-0 overflow-y-auto p-3">
            {repLoading && !rep && <p className="text-[11px] text-muted-foreground">checking every binding against its source…</p>}
            {rep?.error && <p className="text-[11px] text-rose-600 dark:text-rose-400">{rep.error}</p>}
            {rep && !rep.error && (
              <>
                <p className="text-[11px] text-muted-foreground nums mb-2">{rep.traced ?? 0} traced · {rep.failing ?? 0} to update · {rep.advisoryCount ?? 0} advisory · {rep.unboundTotal ?? 0} unbound numbers in the prose (advisory)</p>
                {bound.length === 0 && <p className="px-2 py-2 rounded-md bg-amber-500/10 text-[11px] text-amber-600 dark:text-amber-400">No bound numbers yet. Insert one from the Catalogue tab.</p>}
                <div className="rounded-md border border-border/60 divide-y divide-border/40">
                  {bound.map(({ doc, r }) => {
                    const chip = numberStatusChip(r);
                    const sChip = numberScriptChip(r);
                    const scriptRel = r.provenance?.script || r.script || null;
                    return (
                    <div key={(r.id || "") + doc} data-qa="bound-row" className="px-2.5 py-1.5 text-[11px] leading-snug">
                      <div className="flex items-center gap-1.5">
                        {r.key && <Star size={11} className="text-amber-500 fill-current shrink-0" />}
                        <span title={chip.hint} className={`text-[9px] px-1.5 py-px rounded-full font-semibold shrink-0 ${chip.cls}`}>{chip.label}</span>
                        <span className="font-mono nums text-foreground/90 truncate" style={{ fontFamily: "'Times New Roman', Times, serif", fontSize: 13 }} title={r.quote}>{r.quote}</span>
                        {r.inserted && r.status === "DRIFT" && (
                          <span data-qa="bound-drift" title={chip.hint} className="font-mono nums shrink-0">
                            <span className="text-muted-foreground line-through">{r.written}</span>
                            <span className="text-muted-foreground/70"> → </span>
                            <span className="text-rose-600 dark:text-rose-400 font-semibold">{r.current ?? "?"}</span>
                          </span>
                        )}
                        <span className="text-muted-foreground truncate" title={r.note || r.id || ""}>{r.note || r.id}</span>
                        <span className="ml-auto shrink-0 inline-flex items-center gap-1">
                          {sChip && <span title={sChip.hint} className={`text-[9px] px-1.5 py-px rounded-full font-semibold ${sChip.cls}`}>{sChip.label}</span>}
                          {r.sourceChanged && <span title="the source table's contents changed since this number was inserted — re-check it, then re-snapshot" className="text-[9px] px-1.5 py-px rounded-full font-semibold bg-amber-500/15 text-amber-600 dark:text-amber-400">table changed</span>}
                          <FreshChip prov={r.provenance} />
                        </span>
                      </div>
                      <div className="flex items-center gap-2 mt-0.5 text-muted-foreground">
                        {r.file && <button onClick={() => onViewFile([r.file!, "replication/" + r.file!, "replication/output/" + r.file!.split("/").pop()!], r.file!.split("/").pop()!)} className="flex items-center gap-1 hover:text-primary min-w-0"><Database size={10} className="shrink-0" /><span className="font-mono truncate">{r.file.split("/").pop()}{r.column ? " · " + r.column : ""}</span></button>}
                        {scriptRel && <button onClick={() => viewScript(scriptRel)} title={sChip ? sChip.hint : "View the producing script"} className="flex items-center gap-1 hover:text-primary min-w-0"><FileCode size={10} className="shrink-0" /><span className="font-mono truncate">{scriptRel.split("/").pop()}</span></button>}
                        <span className="flex-1" />
                        {typeof r.line === "number" && <button onClick={() => { onJumpToLine(jumpDoc(doc), r.line!); onClose(); }} className="text-primary hover:underline shrink-0">Jump</button>}
                        {r.id && <button onClick={() => void update(r.id!, { key: !r.key })} title={r.key ? "Unpin" : "Pin as a key number"} className="hover:text-foreground shrink-0">{r.key ? "unpin" : "pin"}</button>}
                        {r.id && r.sourceChanged && <button onClick={() => void update(r.id!, { resnapshot: true })} title="Accept the current table as the source (re-record its hash)" className="hover:text-foreground shrink-0">re-snapshot</button>}
                        {r.id && (retiring === r.id
                          ? <button onClick={() => { void update(r.id!, { retire: true, reason: "retired from the board" }); setRetiring(null); }} className="text-rose-600 dark:text-rose-400 shrink-0 inline-flex items-center gap-1"><Archive size={10} /> retire?</button>
                          : <button onClick={() => setRetiring(r.id!)} title="Retire this binding (kept under 'retired' with a reason, never deleted). The prose is untouched." className="hover:text-foreground shrink-0">retire</button>)}
                      </div>
                      {r.status !== "TRACED" && <p className={`mt-0.5 ${r.inserted ? "text-rose-600 dark:text-rose-400" : "text-muted-foreground"}`}>{r.msg}</p>}
                    </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </>, document.body);
}
