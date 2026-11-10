
export type NumberFlagKind = "drift" | "script";

export type NumberFlagRow = {
  id?: string | null;
  quote?: string | null;
  written?: string | null;
  display?: string | null;
  current?: string | null;
  reanchored?: boolean | null;
  file?: string | null;
  column?: string | null;
  script?: string | null;
};

export type NumberFlagInput = NumberFlagRow & {
  status?: string; inserted?: boolean; scriptState?: string | null;
  blocks?: boolean; key?: boolean; line?: number | null;
};

export type NumberChipSpec = { label: string; cls: string; hint: string };

const CHIP_OK = "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400";
const CHIP_BAD = "bg-rose-500/15 text-rose-600 dark:text-rose-400";
const CHIP_WARN = "bg-amber-500/15 text-amber-600 dark:text-amber-400";
const CHIP_QUIET = "bg-muted text-muted-foreground";

/** the verdict chip both lists draw. Only an inserted row reads as a failure; a legacy
 * agent-authored binding is quiet, because nothing refuses Publish over it. */
export function numberStatusChip(row: NumberFlagInput): NumberChipSpec {
  const status = String(row.status || "ENTRY-ERROR");
  const label = status.toLowerCase();
  if (status === "TRACED") return { label, cls: CHIP_OK, hint: "this number still resolves to its source cell" };
  if (!row.inserted) return { label, cls: CHIP_QUIET, hint: "agent-authored binding — advisory, never blocks" };
  if (status === "ORPHANED") {
    return { label, cls: CHIP_WARN, hint: "the text around this number was edited — re-insert it from the Results pane to keep it checked" };
  }
  if (status === "DRIFT") {
    return { label, cls: CHIP_BAD, hint: "the document says " + String(row.written ?? "") + "; the table now says " + String(row.current ?? "?") };
  }
  return { label, cls: CHIP_BAD, hint: "a number you inserted no longer resolves to its cell — Publish refuses this" };
}

export function numberScriptChip(row: NumberFlagInput): NumberChipSpec | null {
  if (row.scriptState !== "edited") return null;
  return { label: "script edited", cls: CHIP_WARN, hint: "the producing script changed after this table was generated — re-run it" };
}

/** blocks first, then inserted, then the rest; key numbers lead inside each group. */
export function compareNumberRows(a: NumberFlagInput, b: NumberFlagInput): number {
  const rank = (r: NumberFlagInput) => (r.blocks ? 0 : r.inserted ? 1 : 2);
  return rank(a) - rank(b)
    || Number(!!b.key) - Number(!!a.key)
    || (a.line ?? 1e9) - (b.line ?? 1e9);
}

export type NumberSpan = { from: number; to: number };

export type NumberFlag = { from: number; to: number; kind: NumberFlagKind; title: string; id: string };

function occurrences(text: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) return out;
  let i = text.indexOf(needle);
  while (i >= 0) { out.push(i); i = text.indexOf(needle, i + 1); }
  return out;
}

/** the span of `written` inside `hay` starting at `base`, last occurrence (the inserted
 * text is the tail of quote = prefix + insert), or the whole anchor when it is absent. */
function span(base: number, hay: string, written: string): NumberSpan {
  const j = hay.lastIndexOf(written);
  return j < 0 ? { from: base, to: base + hay.length } : { from: base + j, to: base + j + written.length };
}

/** null when the row cannot be placed unambiguously — an ambiguous number is never
 * decorated, so a flag always points at the number it is about. */
export function locateNumberSpan(text: string, row: NumberFlagRow): NumberSpan | null {
  const written = String(row.written ?? "");
  if (!text || !written) return null;
  const quote = String(row.quote ?? "");
  if (!row.reanchored && quote) {
    const hits = occurrences(text, quote);
    if (hits.length === 1) return span(hits[0], quote, written);
    if (hits.length > 1) return null;
  }
  const ins = String(row.display || written);
  const hits = occurrences(text, ins);
  if (hits.length !== 1) return null;
  return span(hits[0], ins, written);
}

function where(row: NumberFlagRow): string {
  const f = (row.file || "").split("/").pop() || "";
  if (!f) return "";
  return " · " + f + (row.column ? " [" + row.column + "]" : "");
}

export function driftTitle(row: NumberFlagRow): string {
  return String(row.written ?? "") + " → " + String(row.current ?? "?") + where(row);
}

export function scriptTitle(row: NumberFlagRow): string {
  return "script edited after this table was generated — re-run " + (row.script || "its producing script");
}

export function numberFlags(text: string, rows: NumberFlagInput[]): NumberFlag[] {
  const out: NumberFlag[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (!r.inserted) continue;
    const kind: NumberFlagKind | null =
      r.status === "DRIFT" ? "drift" : r.scriptState === "edited" ? "script" : null;
    if (!kind) continue;
    const at = locateNumberSpan(text, r);
    if (!at || at.to <= at.from) continue;
    const key = at.from + ":" + at.to;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...at, kind, id: String(r.id || key), title: kind === "drift" ? driftTitle(r) : scriptTitle(r) });
  }
  return out.sort((a, b) => a.from - b.from || a.to - b.to);
}
