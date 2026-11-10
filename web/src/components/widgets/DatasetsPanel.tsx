
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Check, Columns3, Copy, Search, X } from "lucide-react";
import { panelApi, type PanelCatalog, type PanelCatalogDataset, type PanelLang, type PanelScope } from "@/lib/api";
import { ago, nfmt, paneReloaded, toks, useRememberedSearch, type PaneSize } from "@/components/widgets/panel";
import { PanelEmpty, PanelHeader, Hi, useBracketStep, useHomeEnd, useLeftToTabs,
  type PanelChromeProps } from "@/components/widgets/PanelChrome";
import { copyPlain } from "@/lib/clipboard";

/** one readable column however wide the pane gets, the same rule the other views keep */
const WRAP = "mx-auto w-full max-w-[1180px]";

const rowKey = (family: string, key: string) => family + "/" + key;

type Row = { family: string; ds: PanelCatalogDataset };

/* "show everything" for THIS pane: per tab, and only a reload in place reads it back */
const ALL_KEY = "figure-widget:datasets.all.tab";
const allAtLaunch = (who: string): boolean => {
  try { return paneReloaded && !!who && sessionStorage.getItem(ALL_KEY) === who; } catch { return false; }
};
const FIELD_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

export function usePanelScope(project: string, family: string): PanelScope | null {
  const [sc, setSc] = useState<PanelScope | null>(null);
  useEffect(() => {
    if (!project && !family) { setSc(null); return; }
    let live = true;
    let stamp = "";
    const pull = () => {
      panelApi.scope({ project, family }).then((s) => {
        if (!live || !s.ok) return;
        if (s.stamp && s.stamp === stamp) return;
        stamp = s.stamp;
        setSc(s.kind === "none" ? null : s);
      }).catch(() => { /* no scope route on this Board: the whole catalogue, as before */ });
    };
    pull();
    const t = window.setInterval(pull, 60_000);
    window.addEventListener("focus", pull);
    return () => { live = false; window.clearInterval(t); window.removeEventListener("focus", pull); };
  }, [project, family]);
  return sc;
}

export function DatasetsPanel({ chrome, lang, size, right, project = "", family = "", onVariables, onCount, onUnavailable }: {
  chrome: PanelChromeProps;
  /** the language picked on Start: what the snippets are written in */
  lang: PanelLang;
  size: PaneSize;
  right?: React.ReactNode;
  /** the project this pane belongs to: the view scopes to its data */
  project?: string;
  /** the data group this pane was opened on: the view scopes to that family */
  family?: string;
  /** open the Variables view on this dataset (no event is posted: this pane's own move) */
  onVariables: (d: { family: string; key: string }) => void;
  /** how many datasets the hub has, for the tab's count */
  onCount?: (n: number | null) => void;
  /** the catalogue route is not on this Board at all */
  onUnavailable?: () => void;
}) {
  const [cat, setCat] = useState<PanelCatalog | null>(null);
  const [failed, setFailed] = useState("");
  const [q, setQ] = useRememberedSearch("datasets");
  const [open, setOpen] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const restore = useRef<string | null>(null);
  const body = useRef<HTMLDivElement>(null);
  // read through a ref so the one-shot catalogue effect never restarts on a new closure
  const gone = useRef(onUnavailable);
  gone.current = onUnavailable;

  // the catalogue: one read, refreshed on focus and every minute. `stamp` keeps the
  // object identity, so an unchanged hub never re-renders the list.
  useEffect(() => {
    let live = true;
    let stamp = "";
    let everAnswered = false;
    const lost = () => { if (!everAnswered) gone.current?.(); };
    const pull = () => {
      panelApi.catalog().then((c) => {
        if (!live) return;
        setFailed(c.ok ? "" : c.error || "the catalogue didn't answer");
        if (!c.ok || !c.families.length) { lost(); return; }
        everAnswered = true;
        if (c.stamp && c.stamp === stamp) return;
        stamp = c.stamp;
        setCat(c);
      }).catch(() => { if (live) { setFailed("the catalogue didn't answer"); lost(); } });
    };
    pull();
    const t = window.setInterval(pull, 60_000);
    window.addEventListener("focus", pull);
    return () => { live = false; window.clearInterval(t); window.removeEventListener("focus", pull); };
  }, []);

  const scope = usePanelScope(project, family);
  const who = project || family;
  const [all, setAllState] = useState<boolean>(() => allAtLaunch(who));
  const setAll = useCallback((v: boolean) => {
    setAllState(v);
    try { if (v) sessionStorage.setItem(ALL_KEY, who); else sessionStorage.removeItem(ALL_KEY); } catch { /* private mode */ }
    window.requestAnimationFrame(() => {
      const a = document.activeElement as HTMLElement | null;
      if (a && a !== document.body && a.isConnected) return;
      const chip = document.querySelector<HTMLElement>("[data-qa='datasets-scope']");
      if (chip) { document.documentElement.setAttribute("data-knav", ""); chip.focus({ preventScroll: true }); }
    });
  }, [who]);
  const allFamilies = useMemo(() => cat?.families ?? [], [cat]);
  // a scope none of whose keys the catalogue holds (a stale catalog.json) is no scope
  const inScope = useMemo(() => {
    if (!scope) return null;
    const s = new Set(scope.datasets);
    return allFamilies.some((f) => f.datasets.some((d) => s.has(rowKey(f.family, d.key)))) ? s : null;
  }, [scope, allFamilies]);
  const scoped = !!inScope && !all;
  const families = useMemo(() => !scoped || !inScope ? allFamilies
    : allFamilies.map((f) => ({ ...f, datasets: f.datasets.filter((d) => inScope.has(rowKey(f.family, d.key))) }))
      .filter((f) => f.datasets.length), [allFamilies, scoped, inScope]);
  const allTotal = useMemo(() => allFamilies.reduce((n, f) => n + f.datasets.length, 0), [allFamilies]);
  const scopeN = useMemo(() => !inScope ? 0 : allFamilies.reduce((n, f) =>
    n + f.datasets.filter((d) => inScope.has(rowKey(f.family, d.key))).length, 0), [allFamilies, inScope]);

  // `a` flips between the scope and everything, anywhere in the list (never while typing)
  useEffect(() => {
    if (!inScope) return;
    const h = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.key !== "a") return;
      const a = document.activeElement as HTMLElement | null;
      if (a && (FIELD_TAGS.has(a.tagName) || a.isContentEditable)) return;
      if (open) return;
      e.preventDefault();
      setAll(!all);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [inScope, all, open, setAll]);
  const tk = useMemo(() => toks(q), [q]);
  const hit = useCallback((family: string, d: PanelCatalogDataset) => {
    if (!tk.length) return true;
    const hay = (family + " " + d.key + " " + d.label).toLowerCase();
    return tk.every((t) => hay.includes(t));
  }, [tk]);

  const groups = useMemo(() => families
    .map((f) => ({ f, rows: f.datasets.filter((d) => hit(f.family, d)) }))
    .filter((g) => g.rows.length), [families, hit]);
  const flat = useMemo<Row[]>(() =>
    groups.flatMap((g) => g.rows.map((ds) => ({ family: g.f.family, ds }))), [groups]);
  const total = useMemo(() => families.reduce((n, f) => n + f.datasets.length, 0), [families]);
  useEffect(() => { onCount?.(total || null); }, [total, onCount]);

  const openRow = useCallback((k: string) => { restore.current = k; setOpen(k); }, []);

  // Esc out of a dataset puts the focus back on its row, with the query untouched
  useEffect(() => {
    if (open || !restore.current) return;
    const el = body.current?.querySelector<HTMLElement>(`[data-cat-row="${CSS.escape(restore.current)}"]`);
    if (el) { document.documentElement.setAttribute("data-knav", ""); el.focus({ preventScroll: false }); }
    restore.current = null;
  }, [open]);

  const at = open ? flat.findIndex((r) => rowKey(r.family, r.ds.key) === open) : -1;
  const step = useCallback((d: -1 | 1) => {
    if (at < 0) return;
    const n = flat[at + d];
    if (n) { const k = rowKey(n.family, n.ds.key); restore.current = k; setOpen(k); }
  }, [at, flat]);
  useBracketStep(open ? step : null);
  useHomeEnd("[data-cat-row]");
  useLeftToTabs();

  const cur = at >= 0 ? flat[at] : null;

  return (
    <div data-panel="datasets" data-size={size} className="h-screen flex flex-col bg-background text-foreground">
      <PanelHeader {...chrome} title={cur ? rowKey(cur.family, cur.ds.key) : "Datasets"}
        titleHint={cat?.hub || "the data hub"} right={right} />

      {!cur && (
        <div className="shrink-0 px-2 pt-1 pb-1 border-b border-border/40">
          <div className={"flex items-center gap-1.5 rounded-md border border-border bg-background px-1.5 " + WRAP}>
            <Search size={11} className="shrink-0 text-muted-foreground" />
            <input value={q} onChange={(e) => setQ(e.target.value)} data-panel-search data-qa="datasets-search"
              data-knav-own="arrows enter" placeholder="search datasets" title="Search families, keys and labels"
              onKeyDown={(e) => {
                if (e.defaultPrevented) return;
                if (e.key === "ArrowDown" || e.key === "Enter") {
                  e.preventDefault();
                  const el = body.current?.querySelector<HTMLElement>("[data-cat-row]");
                  if (el) { document.documentElement.setAttribute("data-knav", ""); el.focus({ preventScroll: false }); }
                } else if (e.key === "ArrowRight" && e.currentTarget.selectionStart === e.currentTarget.value.length
                  && e.currentTarget.selectionEnd === e.currentTarget.value.length) {
                  // past the end of the text: on to the scope chip beside the box
                  const chip = document.querySelector<HTMLElement>("[data-qa='datasets-scope']");
                  if (chip) {
                    e.preventDefault();
                    document.documentElement.setAttribute("data-knav", "");
                    chip.focus({ preventScroll: true });
                  }
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
            {inScope && scope && (
              <button type="button" data-knav-item data-qa="datasets-scope" data-scope-on={scoped ? "1" : "0"}
                onClick={() => setAll(!all)}
                title={scoped
                  ? (scope.kind === "family" ? "The " + scope.label + " datasets" : "The datasets " + scope.label + " uses")
                    + " — a or click shows all " + nfmt(allTotal)
                  : "Every dataset — a or click shows only " + scope.label + "'s " + nfmt(scopeN)}
                className={"inline-flex h-[15px] min-w-0 max-w-[45%] shrink items-center gap-1 rounded-sm px-1 text-[9px] leading-none outline-none "
                  + "focus-visible:ring-1 focus-visible:ring-primary/60 "
                  + (scoped ? "bg-primary/15 text-foreground hover:bg-primary/25" : "bg-muted text-muted-foreground hover:text-foreground")}>
                <span data-scope-label className="min-w-0 truncate">{scoped ? scope.label : "all"}</span>
                <span data-scope-count className="nums shrink-0 text-muted-foreground">{"· " + nfmt(scoped ? scopeN : allTotal)}</span>
              </button>
            )}
            <span data-panel-count className="nums shrink-0 text-[9px] text-muted-foreground">
              {tk.length ? nfmt(flat.length) + " of " + nfmt(total) : nfmt(total)}
            </span>
          </div>
          {note && <span data-cat-note className="mt-0.5 block truncate text-[9px] text-danger" title={note}>{note}</span>}
        </div>
      )}

      <div ref={body} data-panel-body className="min-h-0 flex-1 overflow-y-auto">
        {cur ? (
          <DatasetDetail family={cur.family} ds={cur.ds} lang={lang} size={size}
            onBack={() => setOpen(null)} onNote={setNote} onVariables={onVariables} />
        ) : failed ? (
          <PanelEmpty>{failed}</PanelEmpty>
        ) : !cat ? (
          <PanelEmpty>Reading the data hub</PanelEmpty>
        ) : !total ? (
          <PanelEmpty>No datasets in the hub</PanelEmpty>
        ) : !groups.length ? (
          <PanelEmpty>Nothing matches that search</PanelEmpty>
        ) : (
          <div className={"px-1 pb-2 " + WRAP}>
            {groups.map(({ f, rows }) => (
              <section key={f.family}>
                <div data-cat-family={f.family}
                  className="sticky top-0 z-10 flex items-center gap-1.5 bg-background px-0.5 pt-1.5 pb-1">
                  <span className="shrink-0 text-[9px] font-medium uppercase tracking-[0.08em] text-muted-foreground">{f.family}</span>
                  {f.readme && (
                    <span data-cat-readme className="shrink-0 rounded-sm bg-muted px-1 text-[8px] leading-[12px] text-muted-foreground"
                      title={f.path + " — has a readme"}>readme</span>
                  )}
                  <span className="h-px flex-1 bg-border/70" />
                  <span className="nums shrink-0 text-[9px] text-muted-foreground">{nfmt(rows.length)}</span>
                </div>
                {rows.map((d) => (
                  <DatasetRow key={d.key} family={f.family} d={d} q={tk} size={size}
                    onOpen={() => openRow(rowKey(f.family, d.key))} />
                ))}
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function splitTail(key: string): [string, string] {
  const m = key.match(/_((?:[a-z]{3,4}_)?(?:19|20)\d\d(?:_[a-z0-9]+)*)$/i);
  let tail = m ? m[1] : "";
  if (!tail || tail.length > 22) {
    tail = key.slice(-12);
    tail = tail.slice(tail.indexOf("_") + 1);
  }
  return tail && tail.length < key.length - 4 ? [key.slice(0, key.length - tail.length), tail] : [key, ""];
}

function DatasetRow({ family, d, q, size, onOpen }: {
  family: string; d: PanelCatalogDataset; q: string[]; size: PaneSize; onOpen: () => void;
}) {
  const mid = size === "md" || size === "lg" || size === "xl";
  const shape = nfmt(d.rows, "") && nfmt(d.cols, "")
    ? nfmt(d.rows) + " × " + nfmt(d.cols) : "";
  const [head, tail] = splitTail(d.key);
  return (
    <button type="button" data-knav-item data-cat-row={rowKey(family, d.key)} onClick={onOpen}
      title={[rowKey(family, d.key), d.label, shape, d.format, ago(d.mtime)].filter(Boolean).join(" · ")}
      className="flex w-full items-center gap-1.5 rounded px-1.5 py-[3px] text-left outline-none
                 hover:bg-accent/40 focus-visible:bg-accent/50 focus-visible:ring-1 focus-visible:ring-primary/60">
      <span data-cat-name className="flex min-w-0 shrink overflow-hidden whitespace-nowrap font-mono text-[10.5px] leading-[1.25] text-foreground">
        <span className="min-w-0 truncate"><Hi text={head} q={q} /></span>
        {tail && <span className="shrink-0"><Hi text={tail} q={q} /></span>}
      </span>
      <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground"><Hi text={d.label} q={q} /></span>
      <span className="nums shrink-0 text-[9.5px] text-muted-foreground">{shape}</span>
      {d.format && (
        <span data-cat-format={d.format}
          className="shrink-0 rounded-sm bg-muted px-1 text-[8.5px] uppercase leading-[13px] tracking-[0.04em] text-muted-foreground">{d.format}</span>
      )}
      {mid && <span className="shrink-0 text-[9px] text-muted-foreground">{ago(d.mtime)}</span>}
    </button>
  );
}

function DatasetDetail({ family, ds, lang, size, onBack, onNote, onVariables }: {
  family: string; ds: PanelCatalogDataset; lang: PanelLang; size: PaneSize;
  onBack: () => void; onNote: (s: string) => void;
  onVariables: (d: { family: string; key: string }) => void;
}) {
  const [copied, setCopied] = useState(false);
  const backRef = useRef<HTMLButtonElement>(null);
  const snippet = ds.usage[lang] || "";
  const short = ds.usageShort?.[lang] || "";

  useEffect(() => {
    document.documentElement.setAttribute("data-knav", "");
    backRef.current?.focus({ preventScroll: true });
  }, [family, ds.key]);

  const copy = async () => {
    if (!snippet) return;
    const ok = await copyPlain(snippet);
    if (ok) { setCopied(true); window.setTimeout(() => setCopied(false), 1500); }
    else onNote("couldn't reach the clipboard");
  };

  const line = [nfmt(ds.rows, "") && nfmt(ds.cols, "") ? nfmt(ds.rows) + " × " + nfmt(ds.cols) : "",
    ds.format, ago(ds.mtime)].filter(Boolean).join(" · ");

  return (
    <div data-cat-detail={rowKey(family, ds.key)} className={"flex h-full min-h-0 flex-col " + WRAP}>
      <div className="flex shrink-0 items-center gap-1.5 px-1.5 py-1">
        <button ref={backRef} type="button" data-knav-back="2" data-qa="datasets-back" onClick={onBack}
          title="Back to the datasets (Esc)"
          className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground outline-none hover:bg-accent hover:text-foreground">
          <ArrowLeft size={12} />
        </button>
        <span data-cat-title className="min-w-0 whitespace-normal break-all font-mono text-[11.5px] font-medium leading-[1.25]">{rowKey(family, ds.key)}</span>
        <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground" title={ds.label}>{ds.label}</span>
      </div>

      {/* the meta line carries the LANGUAGE, because the picker is on Start and the
          snippet below would otherwise be the only thing saying which lane this is */}
      <div className="flex shrink-0 items-center gap-1.5 px-2 pb-1">
        <span data-cat-shape className="nums min-w-0 truncate text-[9.5px] text-muted-foreground">{line}</span>
        <span data-cat-lang={lang} title={"Snippets are in " + lang + " — the picker is on Start"}
          className="shrink-0 rounded-sm bg-muted px-1 text-[8.5px] leading-[13px] text-muted-foreground">{lang}</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <pre data-cat-snippet data-cat-snippet-lang={lang}
          className="whitespace-pre-wrap break-words rounded-md border border-border/70 bg-muted/40 px-2 py-1.5 font-mono text-[10.5px] leading-[1.45] text-foreground">{snippet || "no usage for " + lang}</pre>
        {short && (
          <pre data-cat-snippet-short
            className="mt-1 whitespace-pre-wrap break-words rounded-md border border-border/50 px-2 py-1 font-mono text-[9.5px] leading-[1.4] text-muted-foreground">{short}</pre>
        )}

        <div data-cat-actions className="mt-1.5 flex items-center gap-1 border-t border-border/40 pt-1.5">
          <button type="button" data-knav-item data-qa="datasets-copy" onClick={() => void copy()}
            disabled={!snippet} title="Copy the snippet"
            className="inline-flex h-[19px] shrink-0 items-center gap-1 rounded px-1.5 text-[10px] text-muted-foreground outline-none hover:bg-accent hover:text-foreground disabled:opacity-40">
            {copied ? <Check size={11} /> : <Copy size={11} />}{size === "xs" ? "" : "Copy"}
          </button>
          <button type="button" data-knav-item data-qa="datasets-variables"
            onClick={() => onVariables({ family, key: ds.key })} title="Its variables, in the Variables tab"
            className="inline-flex h-[19px] shrink-0 items-center gap-1 rounded px-1.5 text-[10px] text-muted-foreground outline-none hover:bg-accent hover:text-foreground">
            <Columns3 size={11} />{size === "xs" ? "" : "Variables"}
          </button>
        </div>
      </div>
    </div>
  );
}
