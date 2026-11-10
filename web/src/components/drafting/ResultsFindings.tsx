
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type DraftFindings, type FindingNumber, type FindingRow, type FindingTheme } from "@/lib/api";
import { fmtNumber, MINUS, SYMBOLS, type NumberDisplayHint } from "@/components/NumberPicker";
import { usePersistent } from "@/lib/hooks";
import { useVaultRoot } from "@/lib/paths";
import { copyPlain } from "@/lib/clipboard";
import {
  Search, X, ChevronDown, ChevronRight, FileCode, Database, Sigma, Loader2,
  Copy, Check, AlertTriangle, Link2, PanelRightOpen, FlaskConical, Layers,
} from "lucide-react";

export type FindingCell = { file: string; row: FindingNumber["row"]; column: string; display?: NumberDisplayHint };

const VERDICT_CHIP = (v: string): string => {
  const s = (v || "").toLowerCase();
  if (s.startsWith("supports")) return "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400";
  if (s.startsWith("refutes")) return "bg-rose-500/15 text-rose-600 dark:text-rose-400";
  if (s.startsWith("null")) return "bg-muted text-muted-foreground";
  if (s.startsWith("robust")) return "bg-primary/10 text-primary";
  return "bg-secondary text-muted-foreground";        // descriptive, anything else
};
const LIVE_DOT: Record<string, string> = {
  traced: "bg-emerald-500", drift: "bg-rose-500", missing: "bg-amber-500",
  // the finding-level roll-up: a moved number is information about a live catalogue,
  // never a fault, so the collapsed card wears the neutral token, not the alarm
  live: "bg-muted-foreground/40",
};
const LIVE_TIP: Record<string, string> = {
  traced: "traced — the source cell still gives this number at the recorded precision",
  drift: "moved — the table has been re-run since this was recorded; the figure shown IS the current cell, and Insert types that one",
  missing: "missing — the cell cannot be resolved (file, row or column moved)",
  live: "this finding holds a number the table has re-run since — the row shows the current value",
};
const FRESH_TIP: Record<string, string> = {
  fresh: "provenance hash matches the table on disk",
  stale: "the table changed after its provenance was recorded",
  unrecorded: "no provenance record for this file",
  missing: "source file missing",
};

function Dot({ status, className = "" }: { status: string; className?: string }) {
  return <span title={LIVE_TIP[status] || status} className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${LIVE_DOT[status] || "bg-muted-foreground"} ${className}`} />;
}

const stemOf = (p: string): string => (p || "").split("/").pop()!.replace(/\.csv$/i, "");
const rowLabel = (r: FindingNumber["row"]): string => {
  if (r == null) return "";
  if (typeof r === "string") return r;
  if (typeof r === "number") return "row " + r;
  return Object.values(r).join(" · ");
};
const tokens = (q: string): string[] => q.trim().toLowerCase().split(/\s+/).filter(Boolean);

const liveShown = (v: number): string => v.toPrecision(4).replace(/0+$/, "").replace(/\.$/, "");

type Reading = { pre: string; post: string; token: string; decimals: number; leadingZero: boolean; thousands: boolean; plus: boolean; symbol: string; scale: number };
const DISPLAY_NUM = /([-+−]?)(?=[.\d])((?:\d{1,3}(?:,\d{3})+|\d*)(?:\.\d+)?)/;

function readDisplay(n: FindingNumber): Reading | null {
  const d = String(n.display ?? "");
  const m = DISPLAY_NUM.exec(d);
  if (!m) return null;
  const sign = m[1] || "", token = m[2] || "";
  const shown = Number((sign === MINUS ? "-" : sign) + token.replace(/,/g, ""));
  if (!Number.isFinite(shown)) return null;
  const pre = d.slice(0, m.index), post = d.slice(m.index + m[0].length);
  // a display carrying a SECOND number (a CI, an appended p) is not one number's reading
  if (DISPLAY_NUM.test(post)) return null;
  const dot = token.indexOf(".");
  const decimals = dot < 0 ? 0 : token.length - dot - 1;
  const v = typeof n.value === "number" ? n.value : null;
  if (v === null) return null;
  const tol = 0.51 * Math.pow(10, -decimals);
  const scale = Math.abs(shown - v) <= tol ? 1 : Math.abs(shown - v * 100) <= tol ? 100 : 0;
  if (!scale) return null;
  return {
    pre, post, token, decimals, scale,
    leadingZero: !token.startsWith("."),
    thousands: token.includes(","),
    plus: sign === "+",
    symbol: pre.replace(/[=<>~≈:]\s*$/, "").trim(),
  };
}

/** the LIVE cell printed by the recorded reading's own rules — null when the display
 *  cannot be templated, or when a threshold reading ("p < .001") still stands */
function liveRead(n: FindingNumber): string | null {
  const r = readDisplay(n);
  const raw = n.live?.value;
  if (!r || raw === null || raw === undefined) return null;
  const v = Number(raw) * r.scale;
  if (!Number.isFinite(v)) return null;
  let body = fmtNumber(v, r.decimals, { leadingZero: r.leadingZero, thousands: r.thousands });
  const zero = /^[0.,]+$/.test(body);
  let pre = r.pre;
  if (/[<>]\s*$/.test(pre)) {
    if (zero) return null;                      // still below the floor: the recorded line holds
    pre = pre.replace(/[<>]\s*$/, "=") + (pre.endsWith(" ") ? " " : "");
  }
  if (r.plus && v > 0 && !zero) body = "+" + body;
  return pre + body + r.post;
}

/** the composer's starting format for the cell Insert was pressed on: the reading the
 *  catalogue recorded, so the string typed at the caret is the string on the row */
function insertHint(n: FindingNumber): NumberDisplayHint | undefined {
  const r = readDisplay(n);
  if (!r) return undefined;
  const sym = r.symbol;
  const pct = /%|per ?cent|percentage points/i.test(r.post);
  const kind: NumberDisplayHint["kind"] =
    sym.toLowerCase() === "p" ? "p"
      : pct ? "percent"
        : sym === "n" || sym === "N" ? "n"
          : sym && SYMBOLS.includes(sym) ? "stat" : "plain";
  // appendP is cleared: the recorded display is this number's WHOLE reading
  const hint: NumberDisplayHint = { kind, decimals: r.decimals, leadingZero: r.leadingZero, thousands: r.thousands, appendP: "" };
  if (kind === "stat" || kind === "n") hint.symbol = sym;
  if (kind === "percent") {
    hint.percentWord = /percentage points/i.test(r.post) ? "percentage points"
      : /per cent/i.test(r.post) ? "per cent" : /percent/i.test(r.post) ? "percent" : "%";
    // ×100 only when the recorded display itself scaled the cell, and the binding then
    // records scale=100 exactly as a hand-picked percentage does
    hint.scale100 = r.scale === 100;
  }
  return hint;
}

function liveText(n: FindingNumber): string {
  const v = n.live?.value;
  if (v === null || v === undefined) return "";
  const num = Number(v);
  if (!Number.isFinite(num)) return String(v);
  return [liveRead(n) || "", liveShown(num), num.toPrecision(4), String(num)].join(" ");
}

function numberHay(n: FindingNumber): string {
  return [n.label || "", n.display || "", n.file || "", n.column || "", rowLabel(n.row),
    n.script || "", n.anchor || "", n.output || "", n.outputColumn || "", liveText(n)].join(" ").toLowerCase();
}
/** the finding's own prose — the context a number sits in, without any number's fields */
function findingHay(theme: FindingTheme, f: FindingRow): string {
  return [theme.title || "", theme.summary || "", f.title || "", f.claim || "", f.verdict || "", f.outcome || "",
    ...(f.caveats || []), ...(f.sections || []), ...(f.sources || [])].join(" ").toLowerCase();
}

/** everything one finding can be searched by, lowercased once */
function haystack(theme: FindingTheme, f: FindingRow): string {
  const parts: string[] = [findingHay(theme, f)];
  for (const n of f.numbers || []) parts.push(numberHay(n));
  return parts.join(" ");
}

export function ResultsTabs({ tab, onTab, assets, findings, drift, wide, onWide, rootRef }: {
  tab: "assets" | "findings"; onTab: (t: "assets" | "findings") => void;
  assets: number; findings: number | null; drift: number;
  wide: boolean; onWide: (v: boolean) => void;
  // read-only so a RefObject<HTMLDivElement | null> assigns without variance noise
  rootRef: { readonly current: HTMLElement | null };
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== "w" || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      const root = rootRef.current;
      const a = document.activeElement as HTMLElement | null;
      if (!root || !a || !root.contains(a)) return;
      if (a.closest("input, textarea, select, [contenteditable='true']")) return;
      e.preventDefault(); e.stopPropagation();
      onWide(!wide);
    };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [wide, onWide, rootRef]);

  const pill = (on: boolean) =>
    `inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] ${on
      ? "border-primary/50 text-foreground bg-primary/10"
      : "border-border text-muted-foreground hover:text-foreground"}`;
  return (
    <div className="shrink-0 flex items-center gap-1 px-2 py-1.5 border-b border-border/70">
      <button data-qa="results-tab-assets" onClick={() => onTab("assets")} className={pill(tab === "assets")}
        title="Assets — every figure and table in results/ with its provenance record, script and data">
        <FlaskConical size={10} /> Assets{assets > 0 && <span className="nums text-muted-foreground">· {assets}</span>}
      </button>
      <button data-qa="results-tab-findings" onClick={() => onTab("findings")} className={pill(tab === "findings")}
        title="Findings — this project's recorded results by theme: the claim, the numbers behind it, its caveats, the script that produced each one, and whether the table still gives that number">
        <Layers size={10} /> Findings{findings !== null && <span className="nums text-muted-foreground">· {findings}</span>}
        {/* a re-run moving numbers is the normal state of a live catalogue, not a fault:
            the count informs, in the neutral tokens, and the row itself carries the detail */}
        {drift > 0 && <span data-qa="findings-live-badge" className="nums text-[9px] px-1 rounded-full bg-muted text-muted-foreground" title={drift + " number" + (drift === 1 ? "" : "s") + " re-read live from the table since the catalogue was built — each row shows the current value, with the recorded one beside it"}>{drift}</span>}
      </button>
      <span className="flex-1" />
      <button data-qa="results-wide" onClick={() => onWide(!wide)} className={pill(wide)} title="Wide dock (w) — take the comment rail's width when nothing is pinned there">
        <PanelRightOpen size={10} /> Wide
      </button>
    </div>
  );
}

function NumberLine({ n, hit, onViewFile, onInsert }: {
  n: FindingNumber; hit?: boolean;
  onViewFile: (candidates: string[], title: string) => void;
  onInsert: (cell: FindingCell) => void;
}) {
  const live = n.live || { value: null, status: "missing" as const };
  // the figure on the row is the CURRENT cell whenever the table has moved under it
  const shownLive = live.status === "drift" ? liveRead(n) : null;
  // only an unresolvable cell is unusable — a moved number is a good number
  const unusable = live.status === "missing";
  const scriptTip = !n.script ? "no producing script recorded for this number"
    : n.scriptExists === false ? "the recorded script is not on this tree: " + n.script
      : "View " + n.script + (n.lines ? " (lines " + n.lines + ")" : "");
  return (
    <div data-qa="finding-number" data-hit={hit ? "1" : undefined}
      title={hit ? "matches the search" : undefined}
      className={`py-1 pr-2 text-[10.5px] leading-snug ${hit ? "border-l-2 border-amber-500/40 bg-amber-500/5 pl-1.5" : "pl-2"}`}>
      <div className="flex items-center gap-1.5">
        <Dot status={live.status} />
        <span data-qa="finding-figure" className="nums text-foreground/90 shrink-0" style={{ fontFamily: "'Noto Serif', Georgia, 'Liberation Serif', serif", fontSize: 12 }}>{shownLive ?? n.display}</span>
        {shownLive && (
          <span data-qa="finding-was" title={live.msg || "the reading recorded when the catalogue was built"}
            className="nums shrink-0 text-[9.5px] text-muted-foreground/70">was {n.display}</span>
        )}
        <span className="text-muted-foreground truncate" title={n.label}>{n.label}</span>
        <span className="ml-auto shrink-0 inline-flex items-center gap-1.5 nums text-muted-foreground/80">
          {live.value !== null && !shownLive && <span title={live.msg || ""}>live {liveShown(Number(live.value))}</span>}
          {n.sample?.n ? <span title={"analytic sample" + (n.sample.lock ? " (" + n.sample.lock + " lock)" : "")}>n = {n.sample.n.toLocaleString()}</span> : null}
          {n.freshness && n.freshness !== "fresh" && (
            <span title={FRESH_TIP[n.freshness] || n.freshness} className={`text-[9px] px-1 rounded-full ${n.freshness === "stale" ? "bg-amber-500/15 text-amber-600 dark:text-amber-400" : n.freshness === "missing" ? "bg-rose-500/15 text-rose-600 dark:text-rose-400" : "bg-muted text-muted-foreground"}`}>{n.freshness}</span>
          )}
        </span>
      </div>
      <div className="flex items-center gap-2 mt-0.5 text-muted-foreground">
        <button data-qa="finding-cell" onClick={() => onViewFile([n.file, "replication/" + n.file, "replication/output/" + n.file.split("/").pop()!], n.file.split("/").pop()!)}
          title={"View the source cell — " + n.file + " · " + rowLabel(n.row) + " · " + n.column}
          className="flex items-center gap-1 min-w-0 hover:text-primary">
          <Database size={10} className="shrink-0" />
          <span className="font-mono truncate">{stemOf(n.file)} · {rowLabel(n.row)} · {n.column}</span>
        </button>
        <span className="flex-1" />
        <button data-qa="finding-script" onClick={() => { if (n.script) onViewFile([n.script], n.script.split("/").pop()!); }} disabled={!n.script || n.scriptExists === false} title={scriptTip}
          className="flex items-center gap-1 min-w-0 shrink-0 hover:text-primary disabled:opacity-40 disabled:hover:text-muted-foreground">
          <FileCode size={10} className="shrink-0" />
          <span className="font-mono truncate">{n.script ? n.script.split("/").pop() + (n.lines ? ":" + n.lines : "") : "no script"}</span>
        </button>
        <button data-qa="finding-insert" disabled={unusable}
          onClick={() => onInsert({ file: n.file, row: n.row, column: n.column, display: insertHint(n) })}
          title={unusable
            ? "Unavailable — " + (live.msg || "this cell cannot be resolved (the file, row or column moved)")
            : (shownLive ? "Insert " + shownLive + " — the composer opens on this exact cell, reading it the way this row does, and binds it at the caret"
              : "Insert number — open the composer on this exact cell, choose how it reads, and bind it at the caret")}
          className="inline-flex items-center gap-1 shrink-0 hover:text-primary disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-muted-foreground"><Sigma size={10} /> Insert</button>
      </div>
      {live.status !== "traced" && live.msg && <p className={`mt-0.5 ${live.status === "missing" ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground/80"}`}>{live.msg}</p>}
      {n.output && (
        <p className="mt-0.5 text-muted-foreground/60 font-mono truncate" title={"upstream output — " + n.output + (n.outputRow ? " · " + n.outputRow : "") + (n.outputColumn ? " · " + n.outputColumn : "")}>
          ← {stemOf(n.output)}{n.outputColumn ? " · " + n.outputColumn : ""}</p>
      )}
    </div>
  );
}

function FindingCard({ f, open, onToggle, projectRoot, hits, onViewFile, onInsert, onJumpRelated }: {
  f: FindingRow; open: boolean; onToggle: () => void; projectRoot: string;
  hits?: Set<number>;
  onViewFile: (candidates: string[], title: string) => void;
  onInsert: (cell: FindingCell) => void;
  onJumpRelated: (id: string) => void;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  // an unresolvable cell is the only fault a collapsed card reports; a moved number gets
  // the neutral roll-up and its own count, so a post-re-run catalogue never reads broken
  const moved = (f.numbers || []).filter((n) => n.live?.status === "drift").length;
  const worst = f.numbers?.some((n) => n.live?.status === "missing") ? "missing"
    : moved > 0 ? "live" : "traced";
  const copySource = async (s: string) => {
    const ok = await copyPlain(projectRoot ? projectRoot + "/" + s : s);
    setCopied(ok ? s : null);
    window.setTimeout(() => setCopied(null), 1400);
  };
  return (
    <div data-qa="finding" data-finding-id={f.id} className="border-b border-border/40 last:border-b-0">
      <button data-qa="finding-head" onClick={onToggle} className="flex items-start gap-1.5 w-full px-2 py-1.5 text-left hover:bg-accent/50">
        {open ? <ChevronDown size={11} className="shrink-0 mt-0.5 text-muted-foreground" /> : <ChevronRight size={11} className="shrink-0 mt-0.5 text-muted-foreground" />}
        <span className="min-w-0 flex-1">
          <span className="block text-[11px] text-foreground/90 leading-snug line-clamp-2">{f.claim || f.title}</span>
          <span className="mt-0.5 flex flex-wrap items-center gap-1">
            {f.verdict && <span className={`text-[9px] px-1.5 py-px rounded-full font-semibold ${VERDICT_CHIP(f.verdict)}`}>{f.verdict}</span>}
            {f.outcome && f.outcome !== "none" && <span className="text-[9px] px-1.5 py-px rounded-full bg-secondary text-muted-foreground">{f.outcome}</span>}
            <span className="text-[9.5px] text-muted-foreground/70 nums">{(f.numbers || []).length} number{(f.numbers || []).length === 1 ? "" : "s"}</span>
            {moved > 0 && (
              <span data-qa="finding-live-count" className="text-[9px] px-1 rounded-full bg-muted text-muted-foreground nums"
                title={moved + " number" + (moved === 1 ? "" : "s") + " here read live from the table — the recorded reading sits beside each one"}>{moved} live</span>
            )}
            {hits && hits.size > 0 && (
              <span data-qa="finding-hit-count" title="numbers in this finding that match the search"
                className="text-[9px] px-1 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400 nums">{hits.size} matching</span>
            )}
            {(f.caveats || []).length > 0 && <span className="text-[9.5px] text-muted-foreground/70 nums" title={(f.caveats || []).join("\n")}>{(f.caveats || []).length} caveat{(f.caveats || []).length === 1 ? "" : "s"}</span>}
          </span>
        </span>
        <Dot status={worst} className="mt-1.5" />
      </button>
      {open && (
        <div className="pb-1.5">
          <div className="mx-2 rounded-md border border-border/60 bg-background/50 divide-y divide-border/40">
            {(f.numbers || []).length === 0 && <p className="px-2 py-1 text-[10.5px] text-muted-foreground">no numbers recorded for this finding</p>}
            {(f.numbers || []).map((n, i) => (
              <NumberLine key={(n.label || "") + i} n={n} hit={hits?.has(i)} onViewFile={onViewFile} onInsert={onInsert} />
            ))}
          </div>
          {(f.caveats || []).length > 0 && (
            <div className="mx-2 mt-1.5">
              <p className="text-[9.5px] uppercase tracking-wide text-muted-foreground/60">Caveats</p>
              {(f.caveats || []).map((c, i) => (
                <p key={i} data-qa="finding-caveat" className="flex items-start gap-1 text-[10.5px] leading-snug text-muted-foreground">
                  <AlertTriangle size={10} className="shrink-0 mt-0.5 text-amber-500/80" />{c}</p>
              ))}
            </div>
          )}
          {(f.sections || []).length > 0 && (
            <div className="mx-2 mt-1.5 flex flex-wrap gap-1">
              {(f.sections || []).map((s) => (
                <span key={s} data-qa="finding-section" title="Where this finding is written up" className="text-[9px] px-1.5 py-px rounded-full border border-border text-muted-foreground">{s}</span>
              ))}
            </div>
          )}
          {(f.sources || []).length > 0 && (
            <div className="mx-2 mt-1.5">
              <p className="text-[9.5px] uppercase tracking-wide text-muted-foreground/60">Recorded in</p>
              {(f.sources || []).map((s) => (
                <button key={s} data-qa="finding-source" onClick={() => void copySource(s)} title={"Copy the path — " + (projectRoot ? projectRoot + "/" + s : s)}
                  className="flex items-center gap-1 max-w-full text-[10px] text-muted-foreground hover:text-primary">
                  {copied === s ? <Check size={10} className="shrink-0 text-emerald-500" /> : <Copy size={10} className="shrink-0" />}
                  <span className="font-mono truncate">{s}</span>
                </button>
              ))}
            </div>
          )}
          {(f.related || []).length > 0 && (
            <div className="mx-2 mt-1.5 flex flex-wrap items-center gap-1">
              <Link2 size={10} className="text-muted-foreground/70" />
              {(f.related || []).map((r) => (
                <button key={r} data-qa="finding-related" onClick={() => onJumpRelated(r)} title={"Go to " + r}
                  className="text-[9px] px-1.5 py-px rounded-full border border-border text-muted-foreground hover:text-foreground hover:border-primary/50 font-mono">{r}</button>
              ))}
            </div>
          )}
          {f.audit?.status && (
            <p className="mx-2 mt-1.5 text-[9.5px] text-muted-foreground/60 nums" title={"audit method: " + (f.audit.method || "unrecorded")}>
              audited {f.audit.status}{f.audit.checked ? " · " + new Date(f.audit.checked).toLocaleDateString() : ""}</p>
          )}
        </div>
      )}
    </div>
  );
}

export function ResultsFindings({ slug, onViewFile, onInsertCell, onCounts }: {
  slug: string;
  onViewFile: (candidates: string[], title: string) => void;
  onInsertCell: (cell: FindingCell) => void;
  onCounts?: (c: { findings: number; drift: number } | null) => void;
}) {
  const [data, setData] = useState<DraftFindings | null>(null);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState("");
  const [picked, setPicked] = usePersistent<string[]>("aioa-drafting-findings-sections", []);
  const [collapsed, setCollapsed] = usePersistent<Record<string, boolean>>("aioa-drafting-findings-themes", {});
  const [openIds, setOpenIds] = useState<Record<string, boolean>>({});
  const scrollRef = useRef<HTMLDivElement>(null);
  const vault = useVaultRoot();

  const load = useCallback(async () => {
    setLoading(true);
    try { setData(await api.draftingFindings(slug)); }
    catch { setData({ error: "findings unreachable" }); }
    finally { setLoading(false); }
  }, [slug]);
  useEffect(() => { void load(); }, [load]);
  // the pill row shows the count and the drift badge without fetching twice
  useEffect(() => {
    if (!onCounts) return;
    const c = data?.counts;
    onCounts(c ? { findings: c.findings, drift: c.drift } : null);
  }, [data, onCounts]);

  const projectRoot = useMemo(() => {
    const p = data?.path || "";
    const cut = p.indexOf("/results/");
    return p && vault && cut > 0 ? vault + "/" + p.slice(0, cut) : "";
  }, [data, vault]);

  const themes = data?.themes ?? [];
  const sections = data?.sections ?? [];
  const toks = useMemo(() => tokens(q), [q]);
  const hay = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of themes) for (const f of t.findings || []) m.set(t.id + "/" + f.id, haystack(t, f));
    return m;
  }, [themes]);

  const shown = useMemo(() => {
    const out: { theme: FindingTheme; findings: FindingRow[] }[] = [];
    for (const t of themes) {
      const fs = (t.findings || []).filter((f) => {
        if (picked.length && !(f.sections || []).some((s) => picked.includes(s))) return false;
        if (!toks.length) return true;
        const h = hay.get(t.id + "/" + f.id) || "";
        return toks.every((tk) => h.includes(tk));
      });
      if (fs.length) out.push({ theme: t, findings: fs });
    }
    return out;
  }, [themes, picked, toks, hay]);
  const nShown = useMemo(() => shown.reduce((n, s) => n + s.findings.length, 0), [shown]);

  const numHits = useMemo(() => {
    const m = new Map<string, Set<number>>();
    if (!toks.length) return m;
    for (const t of themes) for (const f of t.findings || []) {
      const ctx = findingHay(t, f);
      const s = new Set<number>();
      (f.numbers || []).forEach((n, i) => {
        const h = numberHay(n);
        let own = false;
        const ok = toks.every((tk) => { const inN = h.includes(tk); own = own || inN; return inN || ctx.includes(tk); });
        if (ok && own) s.add(i);
      });
      if (s.size) m.set(t.id + "/" + f.id, s);
    }
    return m;
  }, [themes, toks]);
  const nHits = useMemo(
    () => shown.reduce((n, s) => n + s.findings.reduce((k, f) => k + (numHits.get(s.theme.id + "/" + f.id)?.size || 0), 0), 0),
    [shown, numHits]);
  const themeOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of themes) for (const f of t.findings || []) m.set(f.id, t.id);
    return m;
  }, [themes]);

  const jumpRelated = useCallback((id: string) => {
    const th = themeOf.get(id);
    if (th) setCollapsed((c) => ({ ...c, [th]: false }));
    setOpenIds((o) => ({ ...o, [id]: true }));
    window.setTimeout(() => {
      scrollRef.current?.querySelector<HTMLElement>(`[data-finding-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest" });
    }, 40);
  }, [themeOf, setCollapsed]);

  const toggleSection = (s: string) => setPicked(picked.includes(s) ? picked.filter((x) => x !== s) : [...picked, s]);
  const c = data?.counts;

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="shrink-0 px-2 pt-1.5">
        <div className="flex items-center gap-1.5 rounded-md border border-border bg-background px-2">
          <Search size={12} className="text-muted-foreground shrink-0" />
          <input data-qa="findings-search" value={q} onChange={(e) => setQ(e.target.value)}
            data-knav-own="arrows enter escape" title="Search findings, numbers, caveats, scripts"
            placeholder="Search findings, numbers, caveats, scripts"
            className="flex-1 bg-transparent py-1.5 text-[11.5px] outline-none placeholder:text-muted-foreground/60" />
          {q && <button onClick={() => setQ("")} title="Clear the search" className="text-muted-foreground hover:text-foreground"><X size={12} /></button>}
        </div>
        {sections.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1.5">
            {sections.map((s) => (
              <button key={s} data-qa="findings-section-chip" onClick={() => toggleSection(s)}
                title={"Only findings written up in " + s}
                className={`rounded-full border px-1.5 py-px text-[9.5px] ${picked.includes(s) ? "border-primary/50 text-foreground bg-primary/10" : "border-border text-muted-foreground hover:text-foreground"}`}>{s}</button>
            ))}
            {picked.length > 0 && <button onClick={() => setPicked([])} title="Clear the section filter" className="text-[9.5px] text-muted-foreground hover:text-foreground px-1">clear</button>}
          </div>
        )}
        {c && (
          <p data-qa="findings-counts" className="px-0.5 pt-1 text-[9.5px] text-muted-foreground/70 nums">
            {nShown} of {c.findings} finding{c.findings === 1 ? "" : "s"}
            {toks.length > 0 && (
              <span data-qa="findings-number-count" title="numbers matching the search, across every finding shown">
                {" · "}{nHits} matching number{nHits === 1 ? "" : "s"}</span>
            )} · {c.numbers} number{c.numbers === 1 ? "" : "s"} · {c.traced} traced
            <span title="the table has been re-run since the catalogue was built: these rows show the current cell and Insert types it">
              {c.drift > 0 ? " · " + c.drift + " reading live" : ""}</span>
            {c.missing > 0 ? " · " + c.missing + " missing" : ""}
          </p>
        )}
      </div>

      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-2 py-1.5">
        {loading && !data && <p className="px-1 text-[11px] text-muted-foreground">Reading findings…</p>}
        {data?.error && (
          <p data-qa="findings-empty" className="px-1 text-[11px] text-muted-foreground"
            title="results/findings.json is the thematic result catalogue — the paper workflow and the analysis write it from the Result Catalogue once the analyses are locked">
            No findings catalogue for this project yet.</p>
        )}
        {data && !data.error && themes.length === 0 && (
          <p data-qa="findings-empty" className="px-1 text-[11px] text-muted-foreground" title="findings.json exists but records no themes">findings.json records no themes.</p>
        )}
        {data && !data.error && themes.length > 0 && shown.length === 0 && (
          <p className="px-1 text-[11px] text-muted-foreground">Nothing matches that search.</p>
        )}
        {shown.map(({ theme: t, findings }) => {
          const open = toks.length > 0 || !collapsed[t.id];
          const drift = findings.reduce((n, f) => n + (f.drift || 0), 0);
          return (
            <div key={t.id} data-qa="findings-theme" className="mb-1.5 rounded-lg border border-border/70 bg-background/40">
              <button data-qa="findings-theme-head" onClick={() => setCollapsed((cs) => ({ ...cs, [t.id]: !cs[t.id] }))}
                title={t.summary || t.title} className="flex items-center gap-1.5 w-full px-2 py-1.5 text-left hover:bg-accent/40 rounded-t-lg">
                {open ? <ChevronDown size={12} className="shrink-0 text-muted-foreground" /> : <ChevronRight size={12} className="shrink-0 text-muted-foreground" />}
                <span className="min-w-0 flex-1 text-[11.5px] font-medium text-foreground/90 truncate">{t.title}</span>
                <span className="shrink-0 text-[9.5px] nums text-muted-foreground">{findings.length}</span>
                {drift > 0 && <span data-qa="findings-theme-live" className="shrink-0 text-[9px] px-1 rounded-full bg-muted text-muted-foreground nums" title={drift + " number" + (drift === 1 ? "" : "s") + " in this theme now read live from the table"}>{drift}</span>}
              </button>
              {open && (
                <div className="border-t border-border/40">
                  {findings.map((f) => {
                    const hits = numHits.get(t.id + "/" + f.id);
                    // a finding that matches only through one of its numbers opens itself, so
                    // the number is on screen; an explicit toggle still wins over that
                    const isOpen = f.id in openIds ? openIds[f.id] : !!hits?.size;
                    return (
                      <FindingCard key={f.id} f={f} open={isOpen} onToggle={() => setOpenIds((o) => ({ ...o, [f.id]: !isOpen }))}
                        projectRoot={projectRoot} hits={hits} onViewFile={onViewFile} onInsert={onInsertCell} onJumpRelated={jumpRelated} />
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
        {loading && data && <p className="px-1 py-1 text-[10px] text-muted-foreground inline-flex items-center gap-1"><Loader2 size={10} className="animate-spin" /> re-reading…</p>}
      </div>
    </div>
  );
}
