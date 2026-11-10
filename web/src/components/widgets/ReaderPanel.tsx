
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, FileText, Search } from "lucide-react";
import { panelApi, type ReaderDoc, type ReaderGroup } from "@/lib/api";
import { useRememberedSearch, type PaneSize } from "@/components/widgets/panel";
import { PanelEmpty, PanelHeader, useHomeEnd, useLeftToTabs, type PanelChromeProps } from "@/components/widgets/PanelChrome";
import { selKey, type DatasetSel } from "@/components/widgets/DataPanel";

/** a pdf event's document, handed over by FigureWidget when the pane switches to Reader */
export type ReaderOpen = { seq: number; doc: ReaderDoc; page: number } | null;

type Memo = { doc: ReaderDoc; page: number; ds: string; auto: boolean };

const docId = (d: ReaderDoc | null) => (d ? (d.hubRel ? "hub:" + d.hubRel : "p:" + d.project + "/" + d.rel) : "");

const isDoc = (v: unknown): v is ReaderDoc => {
  const d = v as Record<string, unknown> | null;
  return !!d && typeof d === "object" && ["hubRel", "project", "rel", "name", "v"].every((k) => typeof d[k] === "string")
    && !!(d.hubRel || (d.project && d.rel));
};

function recall(key: string): Memo | null {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const m = JSON.parse(raw) as Record<string, unknown>;
    if (!m || !isDoc(m.doc) || typeof m.ds !== "string") return null;
    const page = typeof m.page === "number" && m.page > 0 ? Math.floor(m.page) : 0;
    return { doc: { ...m.doc, bytes: null }, page, ds: m.ds, auto: m.auto === true };
  } catch { return null; }
}

function remember(key: string, m: Memo): void {
  try { sessionStorage.setItem(key, JSON.stringify(m)); } catch { /* private mode */ }
}

const mb = (n: number | null) =>
  n === null ? "" : n >= 1048576 ? (n / 1048576).toFixed(n >= 10485760 ? 0 : 1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB";

/** the list's own keys, only while the tab is on: ← to the tabs, Home/End over the rows */
function ReaderKeys({ list }: { list: boolean }) {
  useLeftToTabs();
  useHomeEnd(list ? "[data-reader-row]" : "[data-reader-none]");
  return null;
}

function focusSel(root: ParentNode | null | undefined, sel: string): boolean {
  const el = root?.querySelector<HTMLElement>(sel);
  if (!el) return false;
  document.documentElement.setAttribute("data-knav", "");
  el.focus({ preventScroll: false });
  return true;
}

export function ReaderPanel({ chrome, size, session, dataset, open, active, right }: {
  chrome: PanelChromeProps;
  
  active: boolean;
  size: PaneSize;
  /** the session this pane belongs to: what it remembers is kept under it */
  session: string;
  /** the dataset the pane shows: its session's load, else the project's first */
  dataset: DatasetSel | null;
  /** a pdf event asks for this document */
  open: ReaderOpen;
  right?: React.ReactNode;
}) {
  const memoKey = "figure-widget:reader" + (session ? "@" + session : "");
  const ds = selKey(dataset);
  const first = useMemo(() => {
    const m = recall(memoKey);
    return m && (!m.auto || m.ds === ds) ? m : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [doc, setDoc] = useState<ReaderDoc | null>(first?.doc ?? null);
  const [page, setPage] = useState<number>(first?.page ?? 0);
  const [auto, setAuto] = useState<boolean>(first?.auto ?? true);
  const [mode, setMode] = useState<"doc" | "list">(first ? "doc" : "list");
  const [groups, setGroups] = useState<ReaderGroup[] | null>(null);
  const [err, setErr] = useState("");
  const [q, setQ] = useRememberedSearch("reader");
  const [pageText, setPageText] = useState<string>(first?.page ? String(first.page) : "");
  const body = useRef<HTMLDivElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const took = useRef(0);
  const touched = useRef(!!first);

  // the dataset's documents: read whenever the dataset changes
  useEffect(() => {
    let live = true;
    setErr("");
    if (!dataset || !(dataset.family || dataset.path)) { setGroups([]); return; }
    panelApi.codebooks({ family: dataset.family, key: dataset.key, path: dataset.family ? "" : dataset.path })
      .then((r) => {
        if (!live) return;
        setErr(r.ok ? "" : r.error || "no documents");
        setGroups(r.groups);
      })
      .catch(() => { if (live) { setErr("the documents didn't answer"); setGroups([]); } });
    return () => { live = false; };
  }, [dataset]);

  const autoRef = useRef(auto);
  autoRef.current = auto;
  const docRef = useRef(doc);
  docRef.current = doc;
  useEffect(() => {
    if (!groups || (touched.current && !autoRef.current)) return;
    const own = groups.find((g) => g.id === "dataset")?.docs[0];
    if (!own || docId(own) === docId(docRef.current)) return;
    const wasOpen = touched.current;
    touched.current = true;
    setDoc(own); setPage(0); setPageText(""); setAuto(true);
    if (!wasOpen) setMode("doc");
  }, [groups]);

  // a pdf event: its document, on its page
  useEffect(() => {
    if (!open || open.seq <= took.current) return;
    took.current = open.seq;
    touched.current = true;
    setDoc(open.doc); setPage(open.page); setPageText(open.page ? String(open.page) : "");
    setAuto(false); setMode("doc");
  }, [open]);

  useEffect(() => {
    if (doc) remember(memoKey, { doc: { ...doc, bytes: null }, page, ds, auto });
  }, [doc, page, ds, auto, memoKey]);

  const pick = useCallback((d: ReaderDoc) => {
    touched.current = true;
    setDoc(d); setPage(0); setPageText(""); setAuto(false); setMode("doc");
  }, []);

  const back = useCallback(() => {
    setMode("list");
    const id = docId(doc);
    window.requestAnimationFrame(() => {
      const rows = Array.from(body.current?.querySelectorAll<HTMLElement>("[data-reader-row]") ?? []);
      const row = rows.find((r) => r.getAttribute("data-reader-row") === id) || rows[0];
      if (row) { document.documentElement.setAttribute("data-knav", ""); row.focus({ preventScroll: false }); }
      else focusSel(document, "[data-qa='reader-search']");
    });
  }, [doc]);

  // entering a document puts the keys on the back button, so Esc works at once
  useEffect(() => {
    if (!active || mode !== "doc" || !doc) return;
    const t = window.requestAnimationFrame(() => {
      const a = document.activeElement as HTMLElement | null;
      if (a && a.tagName === "INPUT") return;
      document.documentElement.setAttribute("data-knav", "");
      backRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(t);
  }, [active, mode, doc]);

  // Esc in the document: back to the picker, on its row. Capture, so the engine's own
  // Escape (which would climb to the tab strip) never sees it.
  useEffect(() => {
    if (!active || mode !== "doc") return;
    const h = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      e.stopPropagation();
      back();
    };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [active, mode, back]);

  const toks = useMemo(() => q.toLowerCase().split(/\s+/).filter(Boolean), [q]);
  const shown = useMemo(() => (groups ?? []).map((g) => ({
    ...g, docs: g.docs.filter((d) => toks.every((t) => (d.name + " " + (d.hubRel || d.rel)).toLowerCase().includes(t))),
  })).filter((g) => g.docs.length > 0), [groups, toks]);
  const total = useMemo(() => (groups ?? []).reduce((n, g) => n + g.docs.length, 0), [groups]);

  const src = doc ? panelApi.pdfUrl(doc, page) : "";
  const title = mode === "doc" && doc ? doc.name : dataset ? (dataset.key || dataset.path.split("/").pop() || "") : "";
  const hint = mode === "doc" && doc ? (doc.hubRel ? "~/vault/Projects/data/" + doc.hubRel : doc.project + " / " + doc.rel) : "Documents for this dataset";

  const goPage = () => {
    const n = parseInt(pageText, 10);
    setPage(Number.isFinite(n) && n > 0 ? n : 0);
  };

  const reading = active && mode === "doc" && !!doc;
  
  return (
    <div data-panel={active ? "reader" : undefined} data-reader-kept={active ? undefined : ""} data-size={size}
      aria-hidden={active ? undefined : true} inert={!active}
      className={active ? "relative h-screen flex flex-col bg-background text-foreground"
        : "pointer-events-none invisible fixed inset-0 -z-10 flex flex-col"}>
      {active && <ReaderKeys list={mode === "list"} />}
      {active && <PanelHeader {...chrome} title={title} titleHint={hint} right={right} />}
      {reading && doc && (
        <div className="shrink-0 flex items-center gap-1 border-b border-border/40 px-2 py-[2px]">
          <button ref={backRef} type="button" data-knav-item data-knav-back="1" data-qa="reader-back" onClick={back}
            title="Documents (Esc)"
            className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-primary/60">
            <ArrowLeft size={12} />
          </button>
          <FileText size={11} className="shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-[10.5px] text-muted-foreground" title={hint}>{doc.name}</span>
          <label className="inline-flex shrink-0 items-center gap-1 text-[9.5px] text-muted-foreground" title="Go to page (Enter)">
            p.
            <input value={pageText} inputMode="numeric" data-reader-page data-qa="reader-page"
              onChange={(e) => setPageText(e.target.value.replace(/[^0-9]/g, "").slice(0, 6))}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); goPage(); } }}
              onBlur={goPage}
              className="nums h-4 w-10 rounded-sm border border-border bg-background px-1 text-[10px] text-foreground outline-none focus:ring-1 focus:ring-primary/60" />
          </label>
        </div>
      )}
      {active && mode === "list" && (
        <div className="shrink-0 border-b border-border/40 px-2 pt-1 pb-1">
          <div className="mx-auto flex w-full max-w-[1180px] items-center gap-1.5 rounded-md border border-border bg-background px-1.5">
            <Search size={11} className="shrink-0 text-muted-foreground" />
            <input value={q} onChange={(e) => setQ(e.target.value)} data-panel-search data-qa="reader-search"
              data-knav-own="arrows enter" placeholder="search documents" title="Search the documents"
              onKeyDown={(e) => {
                if (e.defaultPrevented) return;
                if (e.key === "ArrowDown" || e.key === "Enter") {
                  e.preventDefault();
                  focusSel(body.current, "[data-reader-row]");
                }
              }}
              className="min-w-0 flex-1 bg-transparent py-[3px] text-[11px] outline-none placeholder:text-muted-foreground/60" />
            <span data-panel-count className="nums shrink-0 text-[9px] text-muted-foreground" title="Documents listed">
              {groups ? (toks.length ? shown.reduce((n, g) => n + g.docs.length, 0) + "/" : "") + total : ""}
            </span>
            {doc && (
              <button type="button" data-knav-item data-qa="reader-resume" onClick={() => setMode("doc")}
                title={"Back to " + doc.name}
                className="inline-flex h-5 shrink-0 items-center gap-1 rounded px-1 text-[9.5px] text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-primary/60">
                <FileText size={10} />
              </button>
            )}
          </div>
        </div>
      )}
      {active && mode === "list" && (
        <div ref={body} data-panel-body className="tinybar relative min-h-0 flex-1 overflow-y-auto">
          {err ? <PanelEmpty>{err}</PanelEmpty>
            : !groups ? <PanelEmpty>Finding the codebooks</PanelEmpty>
            : !dataset ? <PanelEmpty>No dataset in this pane</PanelEmpty>
            : !total ? <PanelEmpty>No codebook for this dataset</PanelEmpty>
            : !shown.length ? <PanelEmpty>Nothing matches that search</PanelEmpty>
            : (
              <div className="mx-auto w-full max-w-[1180px] px-1 pb-2">
                {shown.map((g) => (
                  <section key={g.id} data-reader-group={g.id}>
                    <div className="sticky top-0 z-10 flex items-center gap-1.5 bg-background px-0.5 pt-1.5 pb-1">
                      <span className="min-w-0 truncate text-[9px] font-medium uppercase tracking-[0.08em] text-muted-foreground">{g.label}</span>
                      <span className="h-px flex-1 bg-border/70" />
                      <span className="nums shrink-0 text-[9px] text-muted-foreground">{g.docs.length}</span>
                    </div>
                    {g.docs.map((d) => {
                      const id = docId(d);
                      const on = id === docId(doc);
                      return (
                        <button key={id} type="button" data-knav-item data-reader-row={id} onClick={() => pick(d)}
                          aria-current={on ? "true" : undefined}
                          title={(d.hubRel ? "~/vault/Projects/data/" + d.hubRel : d.project + " / " + d.rel) + (d.bytes !== null ? " · " + mb(d.bytes) : "")}
                          className="flex w-full items-center gap-1.5 rounded px-1.5 py-[3px] text-left outline-none
                                     hover:bg-accent/40 focus-visible:bg-accent/50 focus-visible:ring-1 focus-visible:ring-primary/60">
                          <FileText size={11} className={"shrink-0 " + (on ? "text-primary" : "text-muted-foreground")} aria-hidden />
                          <span className={"min-w-0 flex-1 truncate text-[11px] text-foreground" + (on ? " font-medium" : "")}>{d.name}</span>
                          <span className="nums shrink-0 text-[9.5px] text-muted-foreground">{mb(d.bytes)}</span>
                        </button>
                      );
                    })}
                  </section>
                ))}
              </div>
            )}
        </div>
      )}
      <div data-reader-doc={reading ? docId(doc) : undefined}
        className={reading ? "flex min-h-0 flex-1 flex-col" : "pointer-events-none invisible absolute inset-0 -z-10 flex flex-col"}>
        {doc && (
          <iframe key={src} src={src} title={doc.name} data-reader-frame
            className="min-h-0 w-full flex-1 border-0 bg-muted/30" />
        )}
      </div>
    </div>
  );
}
