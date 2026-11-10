
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as RKeyboardEvent, type ReactNode } from "react";
import { api, type ClaimHit, type ClaimDetail, type ClaimFilters, type ClaimQuote, type ClaimRelated, type ClaimShort, type CiteHit, type CiteQuote } from "@/lib/api";
import { BookOpen, ChevronLeft, Copy, FileText, Quote, Search, X } from "lucide-react";

/** What Claims mode needs from the editor, a superset-compatible slice of the Corpus
 *  panel's actions: insert at the caret, insert a quote THROUGH THE GATE, open a PDF. */
export type ClaimsActions = {
  insert: (text: string) => boolean;
  insertQuote: (h: CiteHit, q: CiteQuote) => void;
  openPdf: (rel: string, page: string) => void;
};

type Scope = "project" | "all";
type Filt = { concept: string; kind: string; strength: string; ev: boolean; from: string; to: string };
const NO_FILT: Filt = { concept: "", kind: "", strength: "", ev: false, from: "", to: "" };
const KINDS = ["empirical", "theoretical", "methodological", "normative"];
const STRENGTHS = ["strong", "some", "weak"];
const IDLE = { hits: [] as ClaimHit[], total: 0, building: false };
const STRENGTH_RANK: Record<string, number> = { strong: 0, some: 1, weak: 2 };

const lsGet = (k: string) => { try { return window.localStorage.getItem(k); } catch { return null; } };
const lsSet = (k: string, v: string) => { try { window.localStorage.setItem(k, v); } catch { /* private window */ } };

const s = (v: unknown) => (typeof v === "string" ? v : v === null || v === undefined ? "" : String(v));
const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

/** A hit defended against a malformed row: every field the cards read is coerced. */
function norm(h: Partial<ClaimHit> | null | undefined): ClaimHit {
  return {
    id: s(h?.id), note: s(h?.note), n: Number(h?.n) || 0, headline: s(h?.headline), pages: s(h?.pages),
    tags: arr<string>(h?.tags).filter((t) => typeof t === "string"), kind: s(h?.kind), strength: s(h?.strength),
    citekey: s(h?.citekey), author: s(h?.author), year: h?.year ?? null, title: s(h?.title), source: s(h?.source),
    rating: typeof h?.rating === "number" ? h.rating : null, structured: !!h?.structured, evidence: s(h?.evidence),
    scope: s(h?.scope), supports: arr<[string, string]>(h?.supports).filter((x) => Array.isArray(x) && typeof x[0] === "string"),
    n_quotes: Number(h?.n_quotes) || 0, projects: arr(h?.projects), snippet: s(h?.snippet), score: h?.score, shared: arr<string>(h?.shared),
  };
}

/** The citation record behind a claim, in the shape the cite machinery reads. */
function claimHit(c: ClaimHit): CiteHit {
  const stem = c.note.replace(/^.*\//, "").replace(/\.md$/, "");
  const y = typeof c.year === "number" ? c.year : /^\d{3,4}$/.test(s(c.year)) ? Number(c.year) : null;
  return { stem, rel: c.note, author: c.author, year: y, title: c.title, citekey: c.citekey, source: c.source,
    tags: c.tags, citation: "", keyPoints: [], quotes: [], alreadyCited: false };
}
/** "18", "18-20", "3, 5" → "18" / "3": the first page a claim sits on. */
const firstPage = (pages: string) => /\d+[a-z]?/i.exec(pages || "")?.[0] || "";
const quotePage = (q: ClaimQuote) => (q.page === null || q.page === undefined || q.page === "" ? null : String(q.page));

/** «marked» spans from the server snippet → themed <mark>, never the browser's yellow. */
function Guillemets({ text }: { text: string }) {
  const parts = (text || "").split(/«([^»]*)»/);
  return <>{parts.map((p, i) => (i % 2 === 1
    ? <mark key={i} className="rounded-[3px] bg-primary/15 text-foreground px-px">{p}</mark>
    : <Fragment key={i}>{p}</Fragment>))}</>;
}
/** The headline with the snippet's matched words marked; the rest of the snippet (the
 *  claim's detail around the match) comes back as the context line. */
function splitSnippet(c: ClaimHit): { head: string; tail: string } {
  const sn = c.snippet || "", hl = c.headline.trim();
  if (!sn) return { head: hl, tail: "" };
  if (!sn.replace(/[«»]/g, "").startsWith(hl)) return { head: hl, tail: sn };
  // walk the snippet until the headline's plain characters are used up; a mark still open
  // at the cut is closed on the head side and reopened on the tail side
  let i = 0, seen = 0, open = false;
  while (i < sn.length && seen < hl.length) { const ch = sn[i]; if (ch === "«") open = true; else if (ch === "»") open = false; else seen++; i++; }
  if (sn[i] === "»") { i++; open = false; }
  const head = sn.slice(0, i) + (open ? "»" : "");
  const tail = ((open ? "«" : "") + sn.slice(i)).replace(/^\s*—\s*/, "").trim();
  return { head, tail };
}

function KindBadge({ kind }: { kind: string }) {
  if (!kind) return null;
  return <span title={"Kind: " + kind} className="shrink-0 text-[9.5px] px-1 py-px rounded bg-secondary/70 text-muted-foreground">{kind}</span>;
}
function StrengthBadge({ strength }: { strength: string }) {
  if (!strength) return null;
  const cls = strength === "strong" ? "border-primary/50 text-primary" : strength === "some" ? "border-border text-foreground/75" : "border-border/60 text-muted-foreground";
  return <span title={"Evidence strength: " + strength} className={`shrink-0 text-[9.5px] px-1 py-px rounded border ${cls}`}>{strength}</span>;
}
const yearText = (y: unknown) => s(y) || "n.d.";

const PILL = "px-1.5 py-0.5 text-[10.5px] rounded-full border transition-colors";
const pillCls = (on: boolean) => `${PILL} ${on ? "border-primary/50 bg-primary/15 text-primary" : "border-border text-muted-foreground hover:text-foreground hover:border-primary/40"}`;
const ACT = "inline-flex items-center gap-1 text-[10.5px] text-muted-foreground hover:text-primary";

type Props = {
  slug: string; width: number; roomy: boolean; gridOk: boolean;
  actions: ClaimsActions;
  citeFor: (h: CiteHit, page?: string) => string;
  onViewSource: (rel: string) => void;
  onUnavailable: () => void;
  onTotal?: (n: number | null) => void;
  /** set by the panel: Escape asks this first; true = it stepped back a level */
  backRef: { current: (() => boolean) | null };
};

export function ClaimsPanel({ slug, roomy, gridOk, actions, citeFor, onViewSource, onUnavailable, onTotal, backRef }: Props) {
  const [q, setQ] = useState("");
  const [scope, setScopeState] = useState<Scope>(() => (lsGet("aioa-drafting-claims-scope") === "all" ? "all" : "project"));
  const setScope = (v: Scope) => { setScopeState(v); lsSet("aioa-drafting-claims-scope", v); };
  const [f, setF] = useState<Filt>(NO_FILT);
  const [res, setRes] = useState<{ hits: ClaimHit[]; total: number; building: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [stack, setStack] = useState<string[]>([]);   // drill-in history: Esc pops one
  const rootRef = useRef<HTMLDivElement>(null);
  const lastOpened = useRef<string | null>(null);

  const conceptTitle = (slug_: string) => slug_.replace(/-/g, " ");

  const [dq, setDq] = useState("");
  useEffect(() => { const t = setTimeout(() => setDq(q.trim()), 120); return () => clearTimeout(t); }, [q]);
  const browse = !dq;
  // nothing to ask: an empty query over the whole corpus with no filter (the index answers
  // that with nothing, so it is never sent)
  const idle = !dq && scope === "all" && !f.concept && !f.kind && !f.strength && !f.from && !f.to && !f.ev;
  useEffect(() => {
    const ctl = new AbortController();
    if (idle) return () => ctl.abort();
    const filters: ClaimFilters = {
      project: scope === "project" ? slug : undefined, concept: f.concept || undefined, kind: f.kind || undefined,
      strength: f.strength || undefined, year_from: f.from || undefined, year_to: f.to || undefined,
    };
    const query = [dq, f.ev ? "has:evidence" : ""].filter(Boolean).join(" ");
    const t = setTimeout(() => setBusy(true), 0);
    api.claimsSearch(query, filters, browse ? 200 : 80, ctl.signal)
      .then((r) => {
        if (ctl.signal.aborted) return;
        setFailed(false);
        setRes({ hits: arr<ClaimHit>(r?.hits).map(norm).filter((h) => h.id), total: Number(r?.total) || 0, building: !!r?.building });
      })
      .catch((e: unknown) => {
        if (ctl.signal.aborted || (e as { name?: string })?.name === "AbortError") return;
        const m = /\((\d{3})\)/.exec(String((e as Error)?.message || ""));
        if (m && (m[1] === "404" || m[1] === "503")) { onUnavailable(); return; }
        setFailed(true);
      })
      .finally(() => { if (!ctl.signal.aborted) setBusy(false); });
    return () => { clearTimeout(t); ctl.abort(); };
  }, [dq, scope, slug, f, browse, idle, onUnavailable]);
  const shown = idle ? IDLE : res;
  useEffect(() => { onTotal?.(shown ? shown.total : null); }, [shown, onTotal]);

  const hits = useMemo(() => shown?.hits ?? [], [shown]);
  // empty query: the project's claims grouped by concept, strongest first inside a group
  const groups = useMemo(() => {
    if (!browse) return null;
    const m = new Map<string, ClaimHit[]>();
    for (const h of hits) {
      const k = h.supports[0]?.[0] || "";
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(h);
    }
    const byStrength = (a: ClaimHit, b: ClaimHit) => (STRENGTH_RANK[a.strength] ?? 3) - (STRENGTH_RANK[b.strength] ?? 3);
    return [...m.entries()]
      .map(([k, xs]) => ({ key: k, label: k ? conceptTitle(k) : "Other claims", items: [...xs].sort(byStrength) }))
      .sort((a, b) => (a.key ? 0 : 1) - (b.key ? 0 : 1) || b.items.length - a.items.length || a.label.localeCompare(b.label));
  }, [browse, hits, conceptTitle]);

  // ---- actions --------------------------------------------------------------------
  const cite = useCallback((c: ClaimHit, copy = false) => {
    const t = citeFor(claimHit(c));
    if (copy) { void navigator.clipboard?.writeText(t).catch(() => {}); return; }
    actions.insert(t);
  }, [actions, citeFor]);
  const citePage = useCallback((c: ClaimHit, page: string) => { actions.insert(citeFor(claimHit(c), page)); }, [actions, citeFor]);
  const insertQuote = useCallback((c: ClaimHit, qt: ClaimQuote) => {
    // the gate lives behind actions.insertQuote: the live-note verify decides, never us
    actions.insertQuote(claimHit(c), { text: qt.text, page: quotePage(qt) });
  }, [actions]);
  const insertFirstQuote = useCallback(async (c: ClaimHit, known?: ClaimQuote[]) => {
    let qs = known;
    if (!qs) { try { qs = arr<ClaimQuote>((await api.claimsClaim(c.id))?.claim?.quotes); } catch { qs = []; } }
    const first = (qs || []).find((x) => x && typeof x.text === "string" && x.text.trim());
    if (first) insertQuote(c, first);
  }, [insertQuote]);

  // the card opened FROM THE LIST is the one that gets the keys back; a related claim
  // opened from inside the drill-in is not on the list
  const open = (id: string) => { if (!stack.length) lastOpened.current = id; setStack((st) => [...st, id]); };
  const drill = stack.length ? stack[stack.length - 1] : null;
  useEffect(() => {
    backRef.current = () => {
      if (!stack.length) return false;
      setStack((st) => st.slice(0, -1));
      return true;
    };
  }, [stack, backRef]);
  useEffect(() => () => { backRef.current = null; }, [backRef]);
  // back on the list: the card that was opened gets the keys again
  useEffect(() => {
    if (drill || !lastOpened.current) return;
    const id = lastOpened.current;
    const t = requestAnimationFrame(() => {
      const el = rootRef.current?.querySelector<HTMLElement>(`[data-claim-id="${CSS.escape(id)}"] [data-qa="claim-open"]`);
      try { el?.focus({ preventScroll: false }); } catch { /* gone */ }
    });
    return () => cancelAnimationFrame(t);
  }, [drill]);

  // ---- keys: ↑/↓ across cards, c / p / q on the focused card (or the open claim) ------
  const detailRef = useRef<{ claim: ClaimHit; quotes: ClaimQuote[] } | null>(null);
  const onKey = (e: RKeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target as HTMLElement;
    if (t.closest("input, textarea, select, [contenteditable=''], [contenteditable='true'], .cm-content")) return;
    const card = t.closest<HTMLElement>("[data-claim-id]");
    if (!drill && card && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      const all = Array.from(rootRef.current?.querySelectorAll<HTMLElement>('[data-qa="claim-open"]') || []);
      const i = all.findIndex((b) => card.contains(b));
      const next = all[i + (e.key === "ArrowDown" ? 1 : -1)];
      if (next) { e.preventDefault(); next.focus(); next.scrollIntoView({ block: "nearest" }); }
      return;
    }
    if (e.shiftKey || !/^[cpq]$/.test(e.key)) return;
    let c: ClaimHit | null = null, quotes: ClaimQuote[] | undefined;
    if (drill && detailRef.current && detailRef.current.claim.id === drill) { c = detailRef.current.claim; quotes = detailRef.current.quotes; }
    else if (!drill && card) c = hits.find((h) => h.id === card.dataset.claimId) || null;
    if (!c) return;
    e.preventDefault();
    if (e.key === "c") cite(c);
    else if (e.key === "p") citePage(c, firstPage(c.pages) || quotePage((quotes || []).find((x) => quotePage(x)) || { text: "", page: null }) || "");
    else void insertFirstQuote(c, quotes);
  };

  const setFilt = (patch: Partial<Filt>) => setF((cur) => ({ ...cur, ...patch }));
  const nFilters = (f.concept ? 1 : 0) + (f.kind ? 1 : 0) + (f.strength ? 1 : 0) + (f.ev ? 1 : 0) + (f.from || f.to ? 1 : 0);

  const card = (c: ClaimHit) => {
    const { head, tail } = splitSnippet(c);
    const pg = firstPage(c.pages);
    return (
      <div key={c.id} data-claim-id={c.id} data-qa="claim-card"
        className="rounded-lg border border-border/70 bg-background/40 hover:border-border px-2.5 py-1.5 transition-colors">
        <button type="button" data-qa="claim-open" onClick={() => open(c.id)} title="Expand this claim — quotes, context, related claims"
          className="w-full text-left">
          <div className={`text-[12px] font-medium text-foreground/90 leading-snug ${roomy ? "" : "line-clamp-3"}`}><Guillemets text={head} /></div>
          <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
            <span className="text-[10.5px] text-muted-foreground truncate max-w-[60%]" title={c.title}>{c.author || c.citekey} <span className="nums">{yearText(c.year)}</span>{c.pages ? <span className="nums"> · p. {c.pages}</span> : null}</span>
            <KindBadge kind={c.kind} /><StrengthBadge strength={c.strength} />
            {c.n_quotes > 0 && <span className="inline-flex items-center gap-0.5 text-[9.5px] text-muted-foreground nums" title={c.n_quotes + (c.n_quotes === 1 ? " quote" : " quotes")}><Quote size={9} />{c.n_quotes}</span>}
          </div>
          {tail && <div className="mt-0.5 text-[11px] text-muted-foreground leading-snug line-clamp-2"><Guillemets text={tail} /></div>}
          {c.evidence && <div className="mt-0.5 text-[10.5px] text-foreground/70 leading-snug line-clamp-2" title={c.evidence}><span className="text-muted-foreground">Evidence </span>{c.evidence}</div>}
          {c.scope && <div className="mt-0.5 text-[10.5px] text-foreground/70 leading-snug line-clamp-1" title={c.scope}><span className="text-muted-foreground">Scope </span>{c.scope}</div>}
        </button>
        {c.supports.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1">
            {c.supports.slice(0, roomy ? 5 : 3).map(([k, st]) => (
              <button key={k} type="button" onClick={() => setFilt({ concept: k })} title={`Supports ${conceptTitle(k)}${st ? " (" + st + ")" : ""} · filter to this concept`}
                className="text-[9.5px] px-1 py-px rounded bg-primary/10 text-primary/90 hover:bg-primary/20">{conceptTitle(k)}</button>
            ))}
          </div>
        )}
        <div className="flex items-center gap-2.5 mt-1">
          <button type="button" data-qa="claim-cite" onClick={(e) => cite(c, e.shiftKey)} title={`Cite ${citeFor(claimHit(c))} at the caret (c) · Shift-click copies`} className={ACT}><Copy size={11} /> Cite</button>
          {pg && <button type="button" data-qa="claim-cite-page" onClick={() => citePage(c, pg)} title={`Cite ${citeFor(claimHit(c), pg)} at the caret (p)`} className={ACT}>Cite p.</button>}
          <button type="button" data-qa="claim-expand" onClick={() => open(c.id)} title="Expand (Enter)" className={ACT}>Expand</button>
        </div>
      </div>
    );
  };

  const gridCls = gridOk ? "grid grid-cols-2 gap-1 content-start" : "space-y-1";
  return (
    <div ref={rootRef} data-qa="claims-panel" onKeyDown={onKey} className="flex-1 min-h-0 flex flex-col">
      {drill
        ? <ClaimView key={drill} id={drill} roomy={roomy} conceptTitle={conceptTitle}
            onBack={() => setStack((st) => st.slice(0, -1))} onOpen={open} onViewSource={onViewSource}
            onCite={cite} onCitePage={citePage} onInsertQuote={insertQuote} openPdf={actions.openPdf}
            citeFor={citeFor} detailRef={detailRef} />
        : (<>
          <div className="shrink-0 px-3 pt-2 pb-2 border-b border-border/70 space-y-1.5">
            <div className="relative">
              <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input value={q} onChange={(e) => setQ(e.target.value)} data-qa="claims-search"
                placeholder="Search claims — concept:, kind:, author:, year:>2015, &quot;phrase&quot;…"
                className="w-full pl-7 pr-7 py-1.5 text-[12px] rounded-md border border-border bg-background focus:outline-none focus:border-primary/50" />
              {q && <button type="button" onClick={() => setQ("")} title="Clear the search" className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"><X size={13} /></button>}
            </div>
            <div className="flex items-center gap-1 flex-wrap">
              <div className="inline-flex rounded-md border border-border overflow-hidden" data-qa="claims-scope">
                <button type="button" onClick={() => setScope("project")} data-qa="claims-scope-project" title={"Only claims from papers in " + slug + "'s corpus"}
                  className={`px-2 py-0.5 text-[11px] transition-colors max-w-[180px] truncate ${scope === "project" ? "bg-primary/15 text-primary font-medium" : "text-muted-foreground hover:text-foreground hover:bg-accent"}`}>{slug}</button>
                <button type="button" onClick={() => setScope("all")} data-qa="claims-scope-all" title="Claims from the whole corpus"
                  className={`px-2 py-0.5 text-[11px] transition-colors ${scope === "all" ? "bg-primary/15 text-primary font-medium" : "text-muted-foreground hover:text-foreground hover:bg-accent"}`}>All corpus</button>
              </div>
              <button type="button" onClick={() => setFilt({ ev: !f.ev })} data-qa="claims-has-evidence" title="Only claims with an evidence line" className={pillCls(f.ev)}>evidence</button>
              <input value={f.from} onChange={(e) => setFilt({ from: e.target.value.replace(/\D/g, "").slice(0, 4) })} data-qa="claims-year-from" inputMode="numeric" placeholder="from" title="Published in or after"
                className="w-[46px] text-[10.5px] rounded-full border border-border bg-background px-1.5 py-0.5 nums focus:outline-none focus:border-primary/50" />
              <span className="text-[10px] text-muted-foreground">–</span>
              <input value={f.to} onChange={(e) => setFilt({ to: e.target.value.replace(/\D/g, "").slice(0, 4) })} data-qa="claims-year-to" inputMode="numeric" placeholder="to" title="Published in or before"
                className="w-[46px] text-[10.5px] rounded-full border border-border bg-background px-1.5 py-0.5 nums focus:outline-none focus:border-primary/50" />
              <span className="flex-1" />
              <span data-qa="claims-count" className="text-[10.5px] text-muted-foreground nums">{shown ? `${hits.length}${shown.total > hits.length ? " of " + shown.total : ""}` : ""}</span>
            </div>
            <div className="flex items-center gap-1 flex-wrap">
              {KINDS.map((k) => <button key={k} type="button" data-qa={"claims-kind-" + k} onClick={() => setFilt({ kind: f.kind === k ? "" : k })} title={"Kind: " + k} className={pillCls(f.kind === k)}>{k}</button>)}
              <span className="w-1" />
              {STRENGTHS.map((k) => <button key={k} type="button" data-qa={"claims-strength-" + k} onClick={() => setFilt({ strength: f.strength === k ? "" : k })} title={"Evidence strength: " + k} className={pillCls(f.strength === k)}>{k}</button>)}
              {nFilters > 0 && <button type="button" onClick={() => setF(NO_FILT)} data-qa="claims-clear" title="Clear every filter" className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground hover:text-foreground"><X size={10} /> clear</button>}
            </div>
            <div className={`h-px -mb-px rounded ${busy ? "bg-primary/50 animate-pulse" : "bg-transparent"}`} />
          </div>
          <div data-qa="claims-list" className={`flex-1 min-h-0 overflow-y-auto px-2 py-2 ${gridCls}`}>
            {failed && <p className={"px-2 text-[12px] text-muted-foreground" + (gridOk ? " col-span-2" : "")}>Claims search didn’t answer.</p>}
            {!failed && shown && hits.length === 0 && !busy && (
              <p className={"px-2 text-[12px] text-muted-foreground" + (gridOk ? " col-span-2" : "")}>
                {!dq && scope === "all" && !nFilters ? "Search to see claims across the corpus." : shown.building ? "The claims index is building." : "No claims match."}
                {scope === "project" && <> <button type="button" onClick={() => setScope("all")} className="text-primary hover:underline">Search all corpus</button></>}
              </p>
            )}
            {groups
              ? groups.map((g) => (
                <Fragment key={g.key || "_"}>
                  <div data-qa="claims-group" className={"px-1 pt-1.5 pb-0.5 text-[10px] uppercase tracking-[0.1em] text-muted-foreground/80 flex items-baseline gap-1.5" + (gridOk ? " col-span-2" : "")}>
                    <span className="truncate">{g.label}</span><span className="nums opacity-70">{g.items.length}</span>
                  </div>
                  {g.items.map(card)}
                </Fragment>
              ))
              : hits.map(card)}
          </div>
        </>)}
    </div>
  );
}

// ---- one claim, open in the panel -----------------------------------------------------

type ViewProps = {
  id: string; roomy: boolean; conceptTitle: (slug: string) => string;
  onBack: () => void; onOpen: (id: string) => void; onViewSource: (rel: string) => void;
  onCite: (c: ClaimHit, copy?: boolean) => void; onCitePage: (c: ClaimHit, page: string) => void;
  onInsertQuote: (c: ClaimHit, q: ClaimQuote) => void; openPdf: (rel: string, page: string) => void;
  citeFor: (h: CiteHit, page?: string) => string;
  detailRef: { current: { claim: ClaimHit; quotes: ClaimQuote[] } | null };
};

function Section({ title, children, qa }: { title: string; children: ReactNode; qa?: string }) {
  return (
    <div className="mt-3" data-qa={qa}>
      <div className="text-[10px] uppercase tracking-[0.1em] text-muted-foreground/70">{title}</div>
      {children}
    </div>
  );
}

function ClaimView({ id, roomy, conceptTitle, onBack, onOpen, onViewSource, onCite, onCitePage, onInsertQuote, openPdf, citeFor, detailRef }: ViewProps) {
  const [d, setD] = useState<ClaimDetail | null>(null);
  const [err, setErr] = useState(false);
  const [rel, setRel] = useState<ClaimRelated | null>(null);
  const firstRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    let live = true;
    api.claimsClaim(id).then((r) => { if (!live) return; if (!r || r.error || !r.claim) setErr(true); else setD(r); }).catch(() => live && setErr(true));
    api.claimsRelated(id).then((r) => { if (live && r && !r.error) setRel(r); }).catch(() => {});
    return () => { live = false; };
  }, [id]);
  const c = useMemo(() => (d ? norm(d.claim) : null), [d]);
  const quotes = useMemo(() => arr<ClaimQuote>(d?.claim?.quotes).filter((x) => x && typeof x.text === "string" && x.text.trim()), [d]);
  useEffect(() => { detailRef.current = c ? { claim: c, quotes } : null; }, [c, quotes, detailRef]);
  useEffect(() => () => { detailRef.current = null; }, [detailRef]);
  // the keys land on the open claim, not on the page body
  useEffect(() => { if (c) { const t = requestAnimationFrame(() => { try { firstRef.current?.focus({ preventScroll: true }); } catch { /* gone */ } }); return () => cancelAnimationFrame(t); } }, [c]);

  const paper = d?.paper;
  const limitations = paper ? (Array.isArray(paper.limitations) ? paper.limitations : s(paper.limitations) ? [s(paper.limitations)] : []).filter((x) => typeof x === "string" && x.trim()) : [];
  const others = arr<ClaimShort>(d?.claims).filter((x) => x && x.id && x.id !== id);
  const pg = c ? firstPage(c.pages) || quotePage(quotes.find((x) => quotePage(x)) || { text: "", page: null }) || "" : "";

  const shortRow = (x: ClaimShort, label?: string) => {
    if (!x.id) return <div key={x.unresolved} className="mt-1 text-[10.5px] text-muted-foreground/70 italic">{x.unresolved || "unresolved"}</div>;
    const concept = (x.shared || []).find((t) => t.startsWith("concept:"));
    return (
      <button key={x.id + (label || "")} type="button" data-qa="claim-related" onClick={() => onOpen(x.id as string)}
        title={x.title ? `${x.title}${x.shared?.length ? " · shares " + x.shared.join(", ") : ""}` : "Open this claim"}
        className="mt-1 w-full text-left rounded-md px-1.5 py-1 hover:bg-accent/60">
        <div className="text-[11px] text-foreground/85 leading-snug line-clamp-2">{x.headline}</div>
        <div className="flex items-center gap-1.5 mt-0.5">
          <span className="text-[10px] text-muted-foreground">{x.author || x.citekey} <span className="nums">{yearText(x.year)}</span></span>
          {label && <span className="text-[9.5px] px-1 py-px rounded border border-primary/40 text-primary">{label}</span>}
          {concept && <span className="text-[9.5px] px-1 py-px rounded bg-primary/10 text-primary/90">{conceptTitle(concept.slice(8))}</span>}
          <KindBadge kind={s(x.kind)} /><StrengthBadge strength={s(x.strength)} />
        </div>
      </button>
    );
  };
  const linked = rel ? [
    ...arr<ClaimShort>(rel.contests).map((x) => shortRow(x, "contests")),
    ...arr<ClaimShort>(rel.contested_by).map((x) => shortRow(x, "contested by")),
    ...arr<ClaimShort>(rel.extends).map((x) => shortRow(x, "extends")),
    ...arr<ClaimShort>(rel.extended_by).map((x) => shortRow(x, "extended by")),
  ] : [];
  const related = arr<ClaimShort>(rel?.related);

  return (
    <div data-qa="claim-drill" className="flex-1 min-h-0 flex flex-col">
      <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-border/70">
        <button type="button" onClick={onBack} data-knav-back="3" data-qa="claim-back" title="Back (Esc)"
          className="inline-flex items-center gap-1 text-[11.5px] text-muted-foreground hover:text-foreground"><ChevronLeft size={13} /> Back</button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-2.5">
        {err && <p className="text-[12px] text-muted-foreground">This claim is no longer in the index.</p>}
        {!err && !c && <div className="mt-1 h-px rounded bg-primary/50 animate-pulse" />}
        {c && (<>
          <div data-qa="claim-headline" className="text-[13px] font-medium text-foreground/90 leading-snug">{c.headline}</div>
          <div className="flex items-center gap-1.5 mt-1 flex-wrap">
            <span className="text-[11px] text-muted-foreground">{c.author || c.citekey} <span className="nums">{yearText(c.year)}</span>{c.pages ? <span className="nums"> · p. {c.pages}</span> : null}</span>
            <KindBadge kind={c.kind} /><StrengthBadge strength={c.strength} />
            {c.supports.map(([k, st]) => <span key={k} title={st ? "Support: " + st : undefined} className="text-[9.5px] px-1 py-px rounded bg-primary/10 text-primary/90">{conceptTitle(k)}</span>)}
          </div>
          <div className="text-[11px] text-muted-foreground leading-snug mt-0.5 italic">{c.title}</div>

          <div className="flex items-center gap-2.5 mt-2 pb-2 border-b border-border/60 flex-wrap">
            <button ref={firstRef} type="button" data-qa="claim-detail-cite" onClick={(e) => onCite(c, e.shiftKey)} title={`Cite ${citeFor(claimHit(c))} at the caret (c) · Shift-click copies`} className={ACT + " text-[11px]"}><Copy size={11} /> Cite</button>
            {pg && <button type="button" data-qa="claim-detail-cite-page" onClick={() => onCitePage(c, pg)} title={`Cite ${citeFor(claimHit(c), pg)} at the caret (p)`} className={ACT + " text-[11px]"}>Cite p.</button>}
            <button type="button" data-qa="claim-open-note" onClick={() => onViewSource(c.note)} title="Open the citation note in the source viewer" className={ACT + " text-[11px]"}><BookOpen size={11} /> Open note</button>
            {pg && <button type="button" data-qa="claim-pdf" onClick={() => openPdf(c.note, pg)} title={"Open the PDF at page " + pg} className={ACT + " text-[11px]"}><FileText size={11} /> PDF</button>}
          </div>

          {s(d?.claim?.detail) && <p data-qa="claim-detail" className="mt-2 text-[11.5px] text-foreground/85 leading-snug">{s(d?.claim?.detail)}</p>}
          {c.evidence && <p className="mt-1.5 text-[11px] text-foreground/75 leading-snug"><span className="text-muted-foreground">Evidence </span>{c.evidence}</p>}
          {c.scope && <p className="mt-1 text-[11px] text-foreground/75 leading-snug"><span className="text-muted-foreground">Scope </span>{c.scope}</p>}

          {quotes.length > 0 && (
            <Section title={`Quotes · ${quotes.length}`} qa="claim-quotes">
              {quotes.map((qt, i) => {
                const p = quotePage(qt);
                const inferred = qt.linked === "inferred";
                return (
                  <div key={i} data-qa="claim-quote" className={`mt-1.5 pl-2 border-l-2 ${inferred ? "border-dashed border-border" : "border-primary/40"}`}>
                    <div className="flex items-start gap-1.5">
                      {p && <span className="shrink-0 text-[9.5px] px-1 py-px rounded bg-secondary/70 text-muted-foreground nums">p. {p}</span>}
                      <span className={`text-[11px] font-serif italic text-foreground/85 leading-snug ${roomy ? "" : "line-clamp-5"}`}>{qt.text}</span>
                    </div>
                    <div className="flex items-center gap-2.5 mt-0.5">
                      {p && <button type="button" data-qa="claim-quote-cite-page" onClick={() => onCitePage(c, p)} title={`Cite ${citeFor(claimHit(c), p)} at the caret`} className="text-[10px] text-muted-foreground hover:text-primary">Cite p.</button>}
                      <button type="button" data-qa="claim-insert-quote" onClick={() => onInsertQuote(c, qt)} title="Insert the quotation, verified word for word against the live note (q inserts the first)" className="text-[10px] text-muted-foreground hover:text-primary">Insert quote</button>
                      {inferred && <span data-qa="claim-quote-inferred" title={qt.why ? "Linked by inference: " + qt.why : "Linked to this claim by inference"} className="text-[9.5px] text-muted-foreground/70">inferred</span>}
                    </div>
                  </div>
                );
              })}
            </Section>
          )}

          {paper && s(paper.summary) && (
            <Section title="The paper" qa="claim-paper-summary">
              <p className={`mt-1 text-[11px] text-muted-foreground leading-snug ${roomy ? "line-clamp-6" : "line-clamp-4"}`} title={s(paper.summary)}>{s(paper.summary)}</p>
            </Section>
          )}
          {limitations.length > 0 && (
            <details data-qa="claim-limitations" className="mt-2 group">
              <summary className="cursor-pointer text-[10px] uppercase tracking-[0.1em] text-muted-foreground/70 hover:text-foreground list-none">Limitations · {limitations.length}</summary>
              {limitations.map((l, i) => <p key={i} className="mt-1 text-[11px] text-muted-foreground leading-snug">{l}</p>)}
            </details>
          )}
          {others.length > 0 && (
            <Section title={`This paper's other claims · ${others.length}`} qa="claim-others">
              {others.map((x) => (
                <button key={x.id} type="button" data-qa="claim-other" onClick={() => onOpen(x.id as string)} title="Open this claim"
                  className="mt-0.5 w-full text-left flex items-baseline gap-1.5 rounded-md px-1.5 py-0.5 hover:bg-accent/60">
                  <span className="text-[10px] text-muted-foreground nums shrink-0">{x.id.includes("#Q") ? "Claim" : `${x.n}.`}</span>
                  <span className="text-[11px] text-foreground/85 leading-snug line-clamp-1 flex-1">{x.headline}</span>
                  <KindBadge kind={s(x.kind)} />
                </button>
              ))}
            </Section>
          )}
          {linked.length > 0 && <Section title="Contests and extends" qa="claim-linked">{linked}</Section>}
          {related.length > 0 && <Section title={`Related across the corpus · ${related.length}`} qa="claim-related-list">{related.map((x) => shortRow(x))}</Section>}
        </>)}
      </div>
    </div>
  );
}
