
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pin, PinOff, SquarePen, Images, Maximize2, Minimize2 } from "lucide-react";
import { api, exploreApi, type DraftProvenance, type DraftProvEntry, type FigureComment,
  type ExploreSpec, type ExploreMeta } from "@/lib/api";
import { FigureLightbox, FileViewerPanel, typingEscape } from "@/components/draftingShared";
import { FigureSpecEditor } from "@/components/explore/FigureSpecEditor";
import { SourcePanel } from "@/components/explore/SourcePanel";
import { StoreFigureViewer, useStoreIndex, useFigureSelection } from "@/components/explore/StoreFigureViewer";
import { reapplyById, useFigureTheme } from "@/components/explore/figureStore";
import { FigureGallery, useProjectGallery, usePrefetchFigures, displayUrl, fullUrl,
  useFigView, figuresInView, setFigView, viewOfFigure, type FigView } from "@/components/widgets/FigureGallery";
import { InteractiveFigure } from "@/components/widgets/InteractiveFigure";
import type { GalleryFigure, ProjectGallery as ProjectGalleryPayload, PanelEvent } from "@/lib/api";
import { PANEL_VIEWS, panelHasView, usePaneSelfUpdate, usePaneSize, usePanelEvents,
  isNews, paneRecall, paneRemember, paneReloaded, recallTab, rememberTab,
  type PanelViewId, type PaneSize } from "@/components/widgets/panel";
import { PanelBoundary, PanelEmpty, PanelHeader, useBracketStep, type PanelChromeProps } from "@/components/widgets/PanelChrome";
import { BundleDot } from "@/components/StaleDot";
import { DataPanel, selKey, type DatasetSel } from "@/components/widgets/DataPanel";
import { TablesPanel } from "@/components/widgets/TablesPanel";
import { StartPanel } from "@/components/widgets/StartPanel";
import { DatasetsPanel, usePanelScope } from "@/components/widgets/DatasetsPanel";
import { CodingPanel, type CodingOpen } from "@/components/widgets/CodingPanel";
import { ReaderPanel, type ReaderOpen } from "@/components/widgets/ReaderPanel";
import { PANEL_LANGS, type PanelLang } from "@/lib/api";
import { pathSession } from "@/lib/pathroute";
import { stripProjectPrefix } from "@/lib/paths";

type Kind = "figure" | "table";
type Current = { slug: string; stem: string; kind: Kind; path: string | null; from: string | null; root: string | null;
  /** a picture named by its project-relative path, and that file's stamp (a figure event) */
  rel?: string | null; v?: string | null };

const params = new URLSearchParams(window.location.search);

// a home-relative file under a project root, as a project-relative path
const underRoot = (file: string | null, root: string | null) =>
  file && root && file.startsWith(root + "/") ? file.slice(root.length + 1) : null;

/* Which store this window is on, decided once from the URL so the branch below is taken
 * before any hook runs and the two state machines never share one. */
const SOURCE: "open" | "project" =
  (params.get("source") === "open" || (!params.get("slug") && !!params.get("id"))) ? "open" : "project";

const PROJECT = (params.get("project") || "").trim();

const FAMILY = (params.get("family") || "").trim();

/** the URL NAMES a figure: ?slug=&stem= or ?id=. Such a pane opens on that figure
 *  whatever else the panel offers. */
const NAMED = !!(params.get("slug") && params.get("stem")) || !!params.get("id");

/** `rel` is a picture inside the project by its project-relative path, with `v` its
 *  stamp: a figure event names one that way (a Neo-tree pick, a run's results/ file) */
export type FigureSelection = { ts: number; source: string; id: string; slug: string; stem: string; rel?: string; v?: string;
  
  ev?: boolean } | null;

export type FigureView = "gallery" | "figure";
export type GalleryProps = {
  view: FigureView; setView: (v: FigureView, ts?: number | null) => void;
  gal: ProjectGalleryPayload | null;
  recent: Record<string, number>; markNew: (name: string) => void;
  /** the panel header this view draws: which tab is on, the counts, the waiting dots */
  chrome: PanelChromeProps;
  size: PaneSize;
  /** the rail, owned here so both sources share it and a launch always starts collapsed */
  railOpen: boolean; setRailOpen: (open: boolean) => void;
  /** show the figure view WITHOUT touching the tab: the launch's own first figure */
  showQuiet: () => void;
  /** a project picture picked while the window is on the store: back to the project source */
  pickProject: (stem: string) => void;
  
  closeToGallery: () => void;
  
  release: () => void;
  
  holding: () => boolean;
};

const SESSION = (params.get("session") || "").trim() || pathSession();

const WAIT_OLD = params.get("start") === "0";

const RAIL_KEY = "figure-widget:rail.tab";
const RAIL_AT_LAUNCH: boolean = (() => {
  try { return paneReloaded && sessionStorage.getItem(RAIL_KEY) === "1"; } catch { return false; }
})();

const EVENTS_MS = 250;

const START_LANG: PanelLang = (() => {
  const kept = paneRecall<string>("lang", (v): v is string => typeof v === "string" && (PANEL_LANGS as string[]).includes(v));
  if (kept && paneReloaded) return kept as PanelLang;
  const v = (params.get("lane") || "").toLowerCase().trim();
  if ((PANEL_LANGS as string[]).includes(v)) return v as PanelLang;
  return kept ? (kept as PanelLang) : "python";
})();

const KEPT_KEY = SESSION ? "dataset@" + SESSION : "dataset";
const KEPT_SEL = paneRecall<DatasetSel>(KEPT_KEY, (v): v is DatasetSel => {
  const d = v as Record<string, unknown> | null;
  return !!d && typeof d === "object"
    && ["family", "key", "frame", "path"].every((k) => typeof d[k] === "string")
    && !!(d.family || d.frame || d.path);
});

const NO_YANK_MS = 8000;

const STANDING_SEL = "[data-var-detail], [data-table-detail], [data-start-detail],"
  + " [data-cat-detail], [data-coding-unit], [data-coding-agreement],"
  + " [data-coding-set], [data-coding-row], [data-reader-doc]";

const FIELD_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

export function FigureWidget() {
  const [source, setSource] = useState<"open" | "project">(SOURCE);
  const [session] = useState(SESSION);
  
  const sel = useFigureSelection(true, 2000,
    { sessions: Array.from(new Set([SESSION, session].filter(Boolean))), project: PROJECT });
  const seen = useRef(0);
  // the gallery is the waiting state: with ?project= and nothing named in the URL, the
  // window opens on the grid and a figure takes it over the moment one arrives
  const [view, setView] = useState<FigureView>(
    PROJECT && !(params.get("slug") && params.get("stem")) && !params.get("id") ? "gallery" : "figure");
  const gal = useProjectGallery(PROJECT, true);
  usePrefetchFigures(gal);
  const [recent, setRecent] = useState<Record<string, number>>({});
  const markNew = useCallback((name: string) => {
    if (!name) return;
    setRecent((r) => ({ ...r, [name]: Date.now() }));
  }, []);
  const [storeId, setStoreId] = useState(params.get("id") || "");

  const size = usePaneSize();
  
  const [pview, setPView] = useState<PanelViewId>(() => {
    const launch: PanelViewId = NAMED ? "figures"
      : WAIT_OLD ? (PROJECT || !panelHasView("variables") ? "figures" : "variables")
      : panelHasView("start") ? "start"
      : panelHasView("figures") ? "figures" : "variables";
    const back = paneReloaded ? recallTab() : null;
    return back && panelHasView(back) ? back : launch;
  });
  const [lang, setLang] = useState<PanelLang>(START_LANG);
  const [dataSel, setDataSel] = useState<DatasetSel | null>(KEPT_SEL);
  const [tableOpen, setTableOpen] = useState<string | null>(null);
  
  const [codingReq, setCodingReq] = useState<CodingOpen>(null);
  const codingWait = useRef<CodingOpen>(null);
  /** a pdf event's document (the Reader tab), handed over when the pane shows Reader */
  const [readerReq, setReaderReq] = useState<ReaderOpen>(null);
  const readerWait = useRef<ReaderOpen>(null);
  
  const [readerLive, setReaderLive] = useState(false);
  const [pending, setPending] = useState<PanelViewId[]>([]);
  const [counts, setCounts] = useState<Partial<Record<PanelViewId, number | null>>>({});
  const ev = usePanelEvents(session, true, EVENTS_MS);
  const [railOpen, setRailOpenState] = useState<boolean>(RAIL_AT_LAUNCH);
  const setRailOpen = useCallback((open: boolean) => {
    setRailOpenState(open);
    try { sessionStorage.setItem(RAIL_KEY, open ? "1" : "0"); } catch { /* private mode */ }
  }, []);
  /** the figure a figure EVENT named — this session's, never another's. It reaches the two
   *  windows through the same `sel` prop the mailbox uses, whichever is newer */
  const [evSel, setEvSel] = useState<FigureSelection>(null);
  
  const figWait = useRef<FigureSelection>(null);
  const tookEv = useRef(0);
  const handAt = useRef(0);
  
  const fellBack = useRef(false);

  // what the pane keeps between lives: the tab for a reload in place, the language and
  // the dataset ident for the next launch. Writes only; the reads are above, at mount.
  useEffect(() => { rememberTab(pview); if (pview === "reader") setReaderLive(true); }, [pview]);
  useEffect(() => { paneRemember("lang", lang); }, [lang]);
  useEffect(() => {
    if (!dataSel) return;
    const { family, key, frame, path } = dataSel;
    paneRemember(KEPT_KEY, { family: family || "", key: key || "", frame: frame || "", path: path || "" });
  }, [dataSel]);

  const pviewRef = useRef(pview);
  pviewRef.current = pview;
  const viewRef = useRef(view);
  viewRef.current = view;
  /** `holding` (below) read from the follow paths above it */
  const holdingRef = useRef<() => boolean>(() => false);

  const takeTab = useCallback((target: PanelViewId, ts?: number | null): boolean => {
    if (!panelHasView(target)) return false;
    const stamp = typeof ts === "number" && ts > 0 ? ts : Date.now() / 1000;
    const park = () => {
      setPending((p) => (p.includes(target) ? p : [...p, target]));
      return false;
    };
    if (!isNews(stamp)) return false;
    if (pickedAt.current && stamp * 1000 < pickedAt.current) return park();
    const a = document.activeElement as HTMLElement | null;
    const typing = !!a?.hasAttribute?.("data-panel-search");
    const standing = !!document.querySelector(STANDING_SEL)
      || (pviewRef.current === "figures" && viewRef.current === "figure");
    const listening = !!document.querySelector("[data-coding-playing]");
    if (typing || listening || (standing && Date.now() - handAt.current < NO_YANK_MS)) return park();
    setPView(target);
    setPending((p) => p.filter((x) => x !== target));
    return true;
  }, []);

  const setFigView = useCallback((v: FigureView, ts?: number | null) => {
    setView(v);
    if (v === "figure") takeTab("figures", ts);
  }, [takeTab]);

  const pickedAt = useRef(0);

  const goView = useCallback((v: PanelViewId) => {
    pickedAt.current = handAt.current = Date.now();
    setPView(v);
    setPending((p) => p.filter((x) => x !== v));
    if (v === "coding" && codingWait.current) { setCodingReq(codingWait.current); codingWait.current = null; }
    if (v === "reader" && readerWait.current) { setReaderReq(readerWait.current); readerWait.current = null; }
    if (v === "figures" && figWait.current) { deliverRef.current(figWait.current); figWait.current = null; }
  }, []);

  const lastHanded = useRef(0);
  const deliver = useCallback((s0: FigureSelection) => {
    if (!s0) return;
    const ts = Math.max(s0.ts, lastHanded.current + 0.001);
    lastHanded.current = ts;
    const s = { ...s0, ts };
    setEvSel(s);
    if (s.source === "open") { setStoreId(s.id); setSource("open"); markNew(s.id); }
    else { setSource("project"); markNew(s.stem); }
    setView("figure");
  }, [markNew]);
  const deliverRef = useRef(deliver);
  deliverRef.current = deliver;

  const offerFigure = useCallback((s: FigureSelection) => {
    if (!s || !isNews(s.ts)) return;
    if (holdingRef.current()) { markNew(s.source === "open" ? s.id : s.stem); return; }
    const a = document.activeElement as HTMLElement | null;
    const busy = (!!a && (FIELD_TAGS.has(a.tagName) || a.isContentEditable || !!a.hasAttribute?.("data-panel-search")
        || !!a.hasAttribute?.("data-reader-frame")))
      || !!document.querySelector("[data-coding-unit], [data-coding-agreement]");
    const onFig = pviewRef.current === "figures";
    const wait = () => {
      figWait.current = s;
      setPending((p) => (p.includes("figures") ? p : [...p, "figures"]));
      window.setTimeout(() => {
        if (figWait.current === s) { figWait.current = null; offerRef.current(s); }
      }, NO_YANK_MS + 50);
    };
    if (busy) {
      if (onFig) wait();
      else { setPending((p) => (p.includes("figures") ? p : [...p, "figures"])); deliver(s); }
      return;
    }
    const took = takeTab("figures", s.ts);
    if (took || !onFig) deliver(s);
    else wait();
  }, [deliver, takeTab, markNew]);
  const offerRef = useRef(offerFigure);
  offerRef.current = offerFigure;

  const takeFigure = useCallback((e: PanelEvent) => {
    if (session && e.session !== session) return;
    offerFigure(e.id
      ? { ts: e.ts, source: "open", id: e.id, slug: "", stem: "", ev: true }
      : { ts: e.ts, source: "project", id: "", slug: e.project, stem: e.name, rel: e.rel, v: e.v, ev: true });
  }, [offerFigure, session]);

  useEffect(() => {
    const mark = (e: Event) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest?.("[data-panel-body], [data-gallery-card]")) handAt.current = Date.now();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Enter" || (e.target as HTMLElement | null)?.closest?.("[data-panel='coding']")) mark(e);
    };
    window.addEventListener("click", mark, true);
    window.addEventListener("keydown", key, true);
    return () => { window.removeEventListener("click", mark, true); window.removeEventListener("keydown", key, true); };
  }, []);

  const memoSel = useRef(!!KEPT_SEL);

  const scope = usePanelScope(PROJECT, FAMILY);
  const scopeSeeded = useRef(false);
  useEffect(() => {
    if (!scope || scopeSeeded.current || !scope.datasets.length) return;
    scopeSeeded.current = true;
    const inScope = new Set(scope.datasets);
    const [family, ...rest] = scope.datasets[0].split("/");
    const first = { family, key: rest.join("/"), frame: "", path: "" };
    setDataSel((cur) => {
      if (cur && !memoSel.current) return cur;
      if (cur && inScope.has(cur.family + "/" + cur.key)) return cur;
      memoSel.current = true;
      return first;
    });
  }, [scope]);

  // the newest event of each kind at mount: it seeds the views, it never switches one
  
  const ownDataset = useCallback((e: PanelEvent) =>
    (!SESSION && !session) || (!!e.session && (e.session === session || e.session === SESSION)), [session]);

  const takePdf = useCallback((e: PanelEvent) => {
    if (!ownDataset(e) || !isNews(e.ts)) return;
    if (!e.hubRel && !(e.project && e.rel)) return;
    const req: ReaderOpen = { seq: e.seq, page: e.page,
      doc: { hubRel: e.hubRel, project: e.hubRel ? "" : e.project, rel: e.hubRel ? "" : e.rel,
        name: e.name || (e.hubRel || e.rel).split("/").pop()?.replace(/\.pdf$/i, "") || "", v: e.v, bytes: null } };
    if (pviewRef.current === "reader") { setReaderReq(req); return; }
    readerWait.current = req;
    if (takeTab("reader", e.ts)) { setReaderReq(req); readerWait.current = null; }
  }, [ownDataset, takeTab]);

  useEffect(() => {
    for (const e of ev.seed) {
      if (e.kind === "dataset") {
        if (!ownDataset(e)) continue;
        const d = { family: e.family, key: e.key, frame: e.frame, path: e.path };
        setDataSel((cur) => (cur && !memoSel.current ? cur : d));
        memoSel.current = false;
      } else if (e.kind === "table") setTableOpen((t) => t ?? (e.name || e.id));
      // a coding event only positions the view, and only when it is news: an old one must
      // not override the set and unit the view remembers
      else if (e.kind === "coding" && isNews(e.ts)) codingWait.current = { seq: e.seq, project: e.project, set: e.set, unit: e.unit };
      // a figure this session made a moment before the pane came up (figure-pane opens
      // the pane FOR it): shown, since the pane opens on Figures anyway
      else if (e.kind === "figure" && isNews(e.ts) && !NAMED) takeFigure(e);
      else if (e.kind === "pdf" && !NAMED) takePdf(e);
    }
  }, [ev.seed, takeFigure, ownDataset, takePdf]);

  useEffect(() => {
    const e = ev.latest;
    if (!e || e.seq <= tookEv.current) return;
    tookEv.current = e.seq;
    if (e.kind === "figure") { takeFigure(e); return; }
    if (e.kind === "pdf") { takePdf(e); return; }
    if (e.kind === "dataset" && !ownDataset(e)) return;
    const target: PanelViewId = e.kind === "dataset" ? "variables" : e.kind === "coding" ? "coding" : "tables";
    if (!panelHasView(target)) return;
    if (e.kind === "dataset") {
      const d = { family: e.family, key: e.key, frame: e.frame, path: e.path };
      setDataSel((cur) => (selKey(cur) === selKey(d) ? cur : d));
    } else if (e.kind === "coding") {
      codingWait.current = { seq: e.seq, project: e.project, set: e.set, unit: e.unit };
    } else {
      setTableOpen(e.name || e.id);
    }
    
    if (session && e.session !== session) return;
    if (PROJECT && e.project && projectKey(e.project) !== projectKey(PROJECT)) return;
    if (pviewRef.current === "figures" || pviewRef.current === "reader") {
      if (isNews(e.ts)) setPending((p) => (p.includes(target) ? p : [...p, target]));
      return;
    }
    
    if (takeTab(target, e.ts) && target === "coding" && codingWait.current) {
      setCodingReq(codingWait.current);
      codingWait.current = null;
    }
  }, [ev.latest, takeTab, takeFigure, takePdf, session, ownDataset]);

  useEffect(() => {
    if (!sel || sel.ts <= seen.current) return;
    const first = seen.current === 0;
    seen.current = sel.ts;
    if (first && !isNews(sel.ts)) return;
    galleryHold.current = false;
    setSource(sel.source === "project" ? "project" : "open");
    setFigView("figure", sel.ts);
    markNew(sel.source === "project" ? sel.stem : sel.id);
  }, [sel, markNew, setFigView]);

  const stalePane = usePaneSelfUpdate(pview === "figures" && view === "figure" && railOpen);

  const chrome: PanelChromeProps = {
    view: pview, onView: goView,
    counts: { ...counts, figures: gal?.figures?.length ?? null },
    pending,
  };
  const showQuiet = useCallback(() => setView("figure"), []);
  
  const galleryHold = useRef(false);
  const closeToGallery = useCallback(() => {
    galleryHold.current = true;
    handAt.current = Date.now();
    setView("gallery");
  }, []);
  const release = useCallback(() => { galleryHold.current = false; }, []);
  const holding = useCallback(() => galleryHold.current && pviewRef.current === "figures"
    && viewRef.current === "gallery", []);
  holdingRef.current = holding;
  const pickProject = useCallback((stem: string) => {
    galleryHold.current = false;
    deliver({ ts: Date.now() / 1000, source: "project", id: "", slug: PROJECT, stem });
  }, [deliver]);
  const ui: GalleryProps = { view, setView: setFigView, gal, recent, markNew, chrome, size,
    railOpen, setRailOpen, showQuiet, pickProject, closeToGallery, release, holding };
  const onCount = useCallback((id: PanelViewId, n: number | null) =>
    setCounts((c) => (c[id] === n ? c : { ...c, [id]: n })), []);
  // the mailbox's select and this session's figure event reach the windows as ONE
  // selection: whichever is newer
  const figSel: FigureSelection = evSel && (!sel || evSel.ts >= sel.ts) ? evSel : sel;

  return (
    <>
      {source === "open"
        ? <StoreFigureWindow sel={figSel} ui={ui} initialId={storeId} active={pview === "figures"} />
        : <ProjectFigureWindow sel={figSel} ui={ui} active={pview === "figures"}
            onStore={(id) => { setStoreId(id); setSource("open"); setFigView("figure"); }} />}
      {pview === "start" && (
        <PanelBoundary what="Start">
          <StartPanel chrome={chrome} lang={lang} onLang={setLang}
            size={size} dataset={dataSel}
            onUnavailable={() => {
              if (fellBack.current || handAt.current) return;
              fellBack.current = true;
              setPView((v) => (v !== "start" ? v
                : panelHasView("datasets") ? "datasets"
                : PROJECT || !panelHasView("variables") ? "figures" : "variables"));
            }} />
        </PanelBoundary>
      )}
      {pview === "datasets" && (
        <PanelBoundary what="Datasets">
          <DatasetsPanel chrome={chrome} lang={lang} size={size}
            project={PROJECT} family={PROJECT ? "" : FAMILY}
            onCount={(n) => onCount("datasets", n)}
            onVariables={(d) => {
              memoSel.current = false;
              setDataSel({ family: d.family, key: d.key, frame: "", path: "" });
              goView("variables");
            }} />
        </PanelBoundary>
      )}
      {pview === "variables" && (
        <PanelBoundary what="Variables">
          <DataPanel chrome={chrome} session={session} sel={dataSel} onSel={setDataSel} size={size}
            onCount={(n) => onCount("variables", n)} />
        </PanelBoundary>
      )}
      {pview === "tables" && (
        <PanelBoundary what="Tables">
          <TablesPanel chrome={chrome} slug={PROJECT} project={gal?.name || PROJECT} session={session} size={size}
            openName={tableOpen} onOpened={() => setTableOpen(null)}
            onCount={(n) => onCount("tables", n)} />
        </PanelBoundary>
      )}
      {pview === "coding" && (
        <PanelBoundary what="Coding">
          <CodingPanel chrome={chrome} project={PROJECT} size={size} open={codingReq} />
        </PanelBoundary>
      )}
      {(readerLive || pview === "reader") && (
        <PanelBoundary what="Reader">
          <ReaderPanel chrome={chrome} size={size} session={SESSION || session} dataset={dataSel}
            open={readerReq} active={pview === "reader"} />
        </PanelBoundary>
      )}
      {stalePane && <BundleDot />}
    </>
  );
}

/** the tab strip over a figure: the pane opens ON one, and Start stays one tab away */
function paneHeader(ui: GalleryProps) {
  return PANEL_VIEWS.length > 1 ? <PanelHeader {...ui.chrome} title="" /> : undefined;
}

function EmptyFigures({ ui, line }: { ui: GalleryProps; line: string }) {
  if (PANEL_VIEWS.length < 2) {
    return <div className="h-screen flex items-center justify-center text-[13px] text-muted-foreground">{line}</div>;
  }
  return (
    <div data-panel="figures" data-size={ui.size} className="h-screen flex flex-col bg-background text-foreground">
      <PanelHeader {...ui.chrome} title="Figures" />
      <div data-panel-body className="min-h-0 flex-1"><PanelEmpty>{line}</PanelEmpty></div>
    </div>
  );
}

/** a project name in one comparable form, as serve.py's _fig_project_key: the folder name,
 *  its prefixed form and its kebab compare equal */
export const projectKey = (name: string | null | undefined) =>
  stripProjectPrefix((name || "").trim()).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

function ProjectFigureWindow({ sel, ui, active, onStore }: { sel: FigureSelection; ui: GalleryProps; active: boolean; onStore: (id: string) => void }) {
  const theme = useFigureTheme();
  const [follow, setFollow] = useState(params.get("follow") === "1");
  
  const { railOpen, setRailOpen } = ui;
  const [fullRes, setFullRes] = useState(false);
  const [cur, setCur] = useState<Current | null>(() => {
    const slug = params.get("slug"), stem = params.get("stem");
    return slug && stem
      ? { slug, stem, kind: params.get("kind") === "table" ? "table" : "figure", path: params.get("path"), from: null, root: null }
      : null;
  });
  const [, setVersion] = useState(0);
  const [prov, setProv] = useState<DraftProvenance | null>(null);
  const [cmts, setCmts] = useState<{ comments: Record<string, FigureComment[]>; mtime: number; version: string }>({ comments: {}, mtime: 0, version: "" });
  const cmtsRef = useRef(cmts);
  cmtsRef.current = cmts;
  const [fileView, setFileView] = useState<{ candidates: string[]; title: string } | null>(null);
  const [note, setNote] = useState("");


  const [assets, setAssets] = useState<Record<string, string>>({});
  useEffect(() => {
    const slug0 = cur?.slug, stem0 = cur?.stem;
    if (cur?.path || !slug0 || !stem0) { setAssets({}); return; }
    let live = true, seen = "";
    const pull = () => {
      api.draftingDocStatus(slug0).then((r) => {
        const map = (r as { assets?: Record<string, string> })?.assets;
        if (!live || !map || typeof map !== "object") return;
        setAssets(map);
        const s = map[stem0 + ".png"] || map[stem0 + ".svg"] || "";
        if (seen && s && s !== seen) setVersion((v) => v + 1);
        seen = s;
      }).catch(() => {});
    };
    pull();
    const id = window.setInterval(pull, 2000);
    window.addEventListener("focus", pull);
    return () => { live = false; window.clearInterval(id); window.removeEventListener("focus", pull); };
  }, [cur?.slug, cur?.stem, cur?.path]);

  const slug = cur?.slug ?? "";
  const refreshCmts = useCallback(() => {
    if (!slug) return;
    api.draftingFigureComments(slug).then((r) => { if (r.ok) setCmts({ comments: r.comments || {}, mtime: r.mtime || 0, version: r.version || "" }); }).catch(() => {});
  }, [slug]);
  useEffect(() => {
    if (!slug) return;
    setProv(null);
    api.draftingProvenance(slug).then((r) => { if (!r.error) setProv(r); }).catch(() => {});
    refreshCmts();
  }, [slug, refreshCmts]);
  // the Drafting editor may have written comments while this window sat behind it
  useEffect(() => {
    const f = () => refreshCmts();
    window.addEventListener("focus", f);
    return () => window.removeEventListener("focus", f);
  }, [refreshCmts]);
  useEffect(() => { document.title = cur ? `${cur.stem} · Figure` : "Figure"; }, [cur]);

  const save = useCallback(async (stem: string, items: FigureComment[]) => {
    const base = cmtsRef.current.comments[stem] || [];
    setCmts((p) => ({ ...p, comments: { ...p.comments, [stem]: items } }));
    try {
      let r = await api.draftingSaveFigureComments({ slug, stem, items, baseMtime: cmtsRef.current.mtime, baseVersion: cmtsRef.current.version });
      if (r.conflict) {
        const merged = reapplyById(r.currentComments || [], base, items);
        r = await api.draftingSaveFigureComments({ slug, stem, items: merged, baseMtime: r.currentMtime ?? null, baseVersion: r.currentVersion });
        if (r.conflict) { refreshCmts(); setNote("Comments kept moving, reloaded"); return; }
      }
      setCmts((p) => ({ ...p, comments: { ...p.comments, [stem]: r.comments || items }, mtime: r.mtime ?? p.mtime, version: r.version ?? p.version }));
      setNote("");
    } catch { setNote("Couldn't save the comment"); }
  }, [slug, refreshCmts]);

  const toAgent = useCallback(async (stem: string, id: string) => {
    try {
      const r = await exploreApi.toAgentAt({ source: "project", slug, stem, commentId: id });
      if (!r.data.ok) { setNote(r.data.error || "Couldn't queue it"); return; }
      setNote("Queued for an agent");
      refreshCmts();
    } catch { setNote("Couldn't queue it"); }
  }, [slug, refreshCmts]);

  // a sibling <stem>.spec.json makes this project figure editable; most have none
  const [pSpec, setPSpec] = useState<{ spec: ExploreSpec; meta: ExploreMeta | null } | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!preview) { setPreviewUrl(null); return; }
    const u = URL.createObjectURL(new Blob([preview], { type: "image/svg+xml" }));
    setPreviewUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [preview]);

  const galFigures = ui.gal?.figures;
  
  const figView = useFigView(galFigures ?? []);
  const inView = useMemo(() => figuresInView(galFigures ?? [], figView), [galFigures, figView]);
  const gallery = useMemo(() => {
    const seen = new Set<string>();
    const out: { stem: string; kind: Kind }[] = [];
    const add = (stem: string, kind: Kind) => { if (!seen.has(stem)) { seen.add(stem); out.push({ stem, kind }); } };
    for (const f of inView) if (f.group !== "runs") add(f.name, "figure");
    if (cur) add(cur.stem, cur.kind);
    return out;
  }, [cur, galFigures, inView]);

  const viewSynced = useRef("");
  useEffect(() => {
    if (!cur?.stem) return;
    const key = cur.slug + "/" + cur.stem + "/" + (cur.rel || "");
    if (viewSynced.current === key) return;
    const f = (galFigures ?? []).find((g) => g.name === cur.stem && (!cur.rel || g.rel === cur.rel))
      ?? (galFigures ?? []).find((g) => g.name === cur.stem);
    const want: FigView | null = f ? viewOfFigure(f)
      : cur.rel ? (/(^|\/)exploration\//.test(cur.rel) ? "exploration" : null) : null;
    if (!want) return;
    viewSynced.current = key;
    if (want !== figView) setFigView(want, false);
  }, [cur, galFigures, figView]);

  const interFig = useMemo(() => {
    const stem = cur?.stem;
    if (!stem) return null;
    return (galFigures ?? []).find((f) => f.name === stem && f.kind === "interactive") ?? null;
  }, [cur, galFigures]);

  const pick = useCallback((f: GalleryFigure) => {
    ui.release();
    setFollow(false);
    if (f.group === "runs" && f.id) { onStore(f.id); return; }
    setCur({ slug: PROJECT || slug, stem: f.name, kind: "figure", path: null, from: null, root: null });
    setVersion((v) => v + 1);
    ui.setView("figure");
  }, [onStore, slug, ui]);

  const tookSel = useRef(0);
  useEffect(() => {
    if (!sel || sel.source !== "project" || !sel.slug || !sel.stem || sel.ts <= tookSel.current) return;
    const firstSel = tookSel.current === 0;
    tookSel.current = sel.ts;
    // the mailbox outlives the window: an old select must not pin a following pane
    if (firstSel && !isNews(sel.ts)) return;
    setFollow(false);
    setCur({ slug: sel.slug, stem: sel.stem, kind: "figure", path: null, from: null, root: null,
      rel: sel.rel || null, v: sel.v || null });
    setVersion((v) => v + 1);
  }, [sel]);

  const launched = useRef(!!cur || NAMED || WAIT_OLD);
  useEffect(() => {
    if (launched.current || !PROJECT || !galFigures) return;
    launched.current = true;
    if (cur || ui.view !== "gallery") return;
    const pool = figuresInView(galFigures, figView).filter((f) => f.kind !== "interactive" && f.group !== "runs" && !f.id);
    if (!pool.length) return;
    const newest = pool.reduce((a, b) => (b.mtime > a.mtime ? b : a));
    setCur({ slug: PROJECT, stem: newest.name, kind: "figure", path: null, from: null, root: null });
    ui.showQuiet();
  }, [galFigures, cur, ui, figView]);

  const shownStem = cur?.stem || "";
  const [specTick, setSpecTick] = useState(0);
  useEffect(() => {
    if (!slug || !shownStem) { setPSpec(null); return; }
    let live = true;
    setPSpec(null);
    exploreApi.projectFigure(slug, shownStem)
      .then((r) => { if (live && r.hasSpec && r.spec) setPSpec({ spec: r.spec, meta: r.meta }); })
      .catch(() => {});
    return () => { live = false; };
  }, [slug, shownStem, specTick]);

  const navigate = useCallback((stem: string, kind: Kind) => {
    setFollow(false);   // looking back pauses following; the pin turns it on again
    setCur({ slug, stem, kind, path: null, from: null, root: null });
    setVersion((v) => v + 1);
  }, [slug]);

  const stepOrder = useMemo(
    () => inView.filter((f) => f.group !== "runs").map((f) => f.name),
    [inView]);
  const stepDetail = useCallback((d: -1 | 1) => {
    if (stepOrder.length < 2) return;
    const i = stepOrder.indexOf(cur?.stem || "");
    if (i < 0) return;
    navigate(stepOrder[(i + d + stepOrder.length) % stepOrder.length], "figure");
  }, [stepOrder, cur, navigate]);
  
  // only while this window is the one on screen: it stays mounted behind the other tabs,
  // and with the launch opening a figure it would otherwise take `]` from all of them
  useBracketStep(active && !interFig && ui.view === "figure" && cur ? stepDetail : null);

  // a new figure opens at display size again; O flips to the original and back, only
  // while the Full resolution button is actually on screen
  useEffect(() => { setFullRes(false); }, [cur?.stem]);
  useEffect(() => {
    if (!active || ui.view !== "figure") return;
    const h = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key !== "o" && e.key !== "O") return;
      if (typingEscape(e) || !document.querySelector("[data-figure-fullres]")) return;
      e.preventDefault();
      setFullRes((v) => !v);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [active, ui.view]);

  if (!active) return null;

  // THE WAITING STATE. With ?project= that is the project's own gallery, and Esc out of
  // a figure comes back here; without it, the line this window has always shown.
  if (PROJECT && (ui.view === "gallery" || !cur)) {
    return <FigureGallery gal={ui.gal} project={PROJECT} follow={follow}
      current={cur?.stem ?? null} recent={ui.recent} onPick={pick}
      chrome={ui.chrome} size={ui.size} />;
  }
  if (!cur) {
    return <EmptyFigures ui={ui} line="No figure yet" />;
  }

  const recorded = prov?.entries?.[cur.stem];
  const fromRel = underRoot(cur.from, cur.root);
  const entry: DraftProvEntry | undefined = recorded
    ? (recorded.script || !fromRel ? recorded : { ...recorded, script: fromRel })
    : (fromRel ? ({
    kind: "figure", script: fromRel, dataSources: [], commit: null, generated: null,
    generatedBy: "editor", manualNote: null, verified: false, environment: null, sessionId: null,
    notesAnchor: null, notesRel: null, caption: "plotted from the editor", freshness: {}, status: "none", diagram: null,
  } as unknown as DraftProvEntry) : undefined);
  
  const assetName = cur.stem + ".png";
  const assetStamp = assets[assetName] || "";
  
  const galFig0 = !cur.path ? (galFigures ?? []).find((f) =>
    f.name === cur.stem && f.kind !== "interactive" && f.group !== "runs" && !f.id) : undefined;
  
  const galFig = galFig0 && (!cur.rel || (galFig0.rel === cur.rel
    && (!cur.v || galFig0.url.includes("v=" + cur.v)))) ? galFig0 : undefined;
  const relSrc = cur.rel ? "/w/figure/project/img?slug=" + encodeURIComponent(cur.slug)
    + "&rel=" + encodeURIComponent(cur.rel) + (cur.v ? "&v=" + encodeURIComponent(cur.v) : "") : "";
  const imageSrc = cur.kind === "figure"
    ? (galFig ? (fullRes ? fullUrl(galFig) : displayUrl(galFig))

      : relSrc ? relSrc
      : api.draftingAssetUrl(cur.slug, assetName) + (assetStamp ? "&v=" + encodeURIComponent(assetStamp) : ""))
    : undefined;
  const draftingDoc = cur.root?.includes("/Projects/briefs/") ? "report.md" : cur.root?.includes("/Projects/grants/") ? "" : "paper.md";

  if (interFig) {
    
    return <InteractiveFigure fig={interFig} size={ui.size}
      step={gallery.length > 1 ? stepDetail : undefined}
      onBack={ui.closeToGallery} />;
  }

  const toolbar = (
    <div className="flex flex-wrap items-center gap-1">
      <button onClick={() => window.open("/v/drafting#/drafting/" + encodeURIComponent(cur.slug) + (draftingDoc ? "/" + draftingDoc : ""), "_blank")}
        title="Open this project in Drafting" className="h-7 w-7 rounded-md inline-flex items-center justify-center text-white/80 hover:bg-white/10">
        <SquarePen size={13} />
      </button>
      {galFig?.preview && !pSpec && !previewUrl && (
        <button type="button" onClick={() => setFullRes((v) => !v)} data-figure-fullres={fullRes ? "on" : "off"}
          aria-pressed={fullRes} title={fullRes ? "Display size (O)" : "Full resolution (O)"}
          className={`h-7 w-7 shrink-0 rounded-md inline-flex items-center justify-center text-white/80 hover:bg-white/10 ${fullRes ? "bg-white/15" : ""}`}>
          {fullRes ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
        </button>
      )}
      {note && <span className="text-[11px] text-amber-300 truncate max-w-[260px]" title={note}>{note}</span>}
    </div>
  );

  return (
    <>
      <FigureLightbox slug={cur.slug} stem={cur.stem} kind={cur.kind} gallery={gallery} onNavigate={navigate} wrap
        initial={cmts.comments[cur.stem] || []} prov={entry} onSave={(items) => void save(cur.stem, items)}
        onClose={ui.closeToGallery}
        header={paneHeader(ui)}
        onViewFile={(candidates, title) => setFileView({ candidates, title })}
        blockKeys={!!fileView} imageSrc={previewUrl || (pSpec ? `/explore/render?source=project&slug=${encodeURIComponent(cur.slug)}&stem=${encodeURIComponent(cur.stem)}&theme=${theme}&v=${pSpec.spec.version}` : imageSrc)}
        imageSurface={pSpec ? "card" : "white"} toolbar={toolbar}
        railOpen={railOpen} onRailOpen={setRailOpen} fit
        onToAgent={(id) => void toAgent(cur.stem, id)}
        editPanel={pSpec && pSpec.spec.kind === "vl" ? (
          <FigureSpecEditor target={{ source: "project", slug: cur.slug, stem: cur.stem }}
            spec={pSpec.spec} meta={pSpec.meta} theme={theme}
            onPreview={setPreview} onSaved={() => { setSpecTick((t) => t + 1); setVersion((v) => v + 1); }} />
        ) : undefined}
        sourcePanel={pSpec ? <SourcePanel spec={pSpec.spec} nRows={pSpec.meta?.n_rows || 0} truncated={!!pSpec.meta?.truncated} /> : undefined} />
      {fileView && <FileViewerPanel slug={cur.slug} candidates={fileView.candidates} title={fileView.title} onClose={() => setFileView(null)} />}
    </>
  );
}

function StoreFigureWindow({ sel, ui, active, initialId }: { sel: FigureSelection; ui: GalleryProps; active: boolean; initialId: string }) {
  const [follow, setFollow] = useState(params.get("follow") === "1");
  const list = useStoreIndex(true);
  const [selId, setSelId] = useState(initialId);
  /** the figure an event or a select put here, which the index may not list yet: the
   *  event is posted before the index is rebuilt, so "not in the list" is not "gone" */
  const named = useRef(new Set<string>(initialId ? [initialId] : []));
  const [note, setNote] = useState("");

  // a `runs` card picked in the project gallery hands this window its figure
  useEffect(() => { if (initialId) { named.current.add(initialId); setSelId(initialId); } }, [initialId]);

  const took = useRef(0);
  useEffect(() => {
    if (!sel || sel.source !== "open" || !sel.id || sel.ts <= took.current) return;
    const firstSel = took.current === 0;
    took.current = sel.ts;
    if (firstSel && !isNews(sel.ts)) return;   // the mailbox outlives the window
    if (!sel.ev) setFollow(false);
    named.current.add(sel.id);
    setSelId(sel.id);
  }, [sel]);

  const newest = list[0]?.id || "";
  const first = useRef(true);
  
  const followStore = follow && !SESSION;
  const markedNewest = useRef("");
  useEffect(() => {
    if (!list.length) return;
    if (followStore && newest && newest !== selId && ui.holding()) {
      if (markedNewest.current !== newest) { markedNewest.current = newest; ui.markNew(newest); }
      first.current = false;
      return;
    }
    if (followStore && newest && newest !== selId) {
      setSelId(newest);
      if (!first.current) { ui.setView("figure"); ui.markNew(newest); }
      first.current = false;
      return;
    }
    first.current = false;
    // a SET, not the last one: this effect can run in the same commit as the one that names
    // the next figure, while `selId` still holds the previous (also unlisted) one
    if (!selId || (!named.current.has(selId) && !list.some((f) => f.id === selId))) setSelId(newest);
  }, [newest, followStore, list, selId, ui]);

  useEffect(() => {
    const t = list.find((f) => f.id === selId);
    document.title = t ? `${t.title} · Figure` : "Figure";
  }, [list, selId]);

  /* The store as a grid, for a pane with no project: the level the X and Esc
   * go back to. Its cards are the store's own figures, newest first, drawn by id. */
  const storeGal = useMemo<ProjectGalleryPayload>(() => ({
    ok: true, slug: "", name: "Figures", root: "", stamp: "", count: list.length,
    figures: list.map((c) => ({
      name: c.id, group: "runs" as const, rel: c.id, url: "", w: 0, h: 0, script: null,
      id: c.id, ver: 1, kind: "figure" as const,
      mtime: (Date.parse(c.updated || c.created || "") || 0) / 1000,
    })),
  }), [list]);

  if (!active) return null;

  // with no project, the grid Esc and the X return to is the shared store itself
  if ((PROJECT && (ui.view === "gallery" || !selId)) || (!PROJECT && ui.view === "gallery")) {
    return <FigureGallery gal={PROJECT ? ui.gal : storeGal} project={PROJECT || "Figures"} follow={follow}
      current={selId || null} recent={ui.recent} chrome={ui.chrome} size={ui.size}
      onPick={(f) => {
        ui.release();
        setFollow(false);
        if (f.id) { setSelId(f.id); ui.setView("figure"); return; }
        ui.pickProject(f.name);
      }} />;
  }
  if (!selId) {
    return <EmptyFigures ui={ui} line={list.length ? "Opening the figure" : "No figure yet"} />;
  }

  const toolbar = (
    <div className="flex flex-wrap items-center gap-1">
      <button onClick={() => setFollow((f) => !f)} data-figure-follow={follow ? "on" : "off"}
        title={follow ? "Following the newest figure in the store (click to hold this one)" : "Holding this figure (click to follow the store)"}
        className={`h-7 px-2 rounded-md inline-flex items-center gap-1 text-[11px] ${follow ? "bg-white/15 text-white" : "text-white/60 hover:bg-white/10"}`}>
        {follow ? <Pin size={13} /> : <PinOff size={13} />}{follow ? "Following" : "Held"}
      </button>
      <span className="inline-flex items-center gap-1 text-[11px] text-white/60" title="Figures in the shared store">
        <Images size={13} />{list.length}
      </span>
      {note && <span className="text-[11px] text-amber-300 truncate max-w-[260px]" title={note}>{note}</span>}
    </div>
  );

  return (
    <StoreFigureViewer id={selId} list={list} toolbar={toolbar} onNote={setNote}
      railOpen={ui.railOpen} onRailOpen={ui.setRailOpen} fit
      onNavigate={(id) => { setFollow(false); setSelId(id); }}
      header={paneHeader(ui)}
      onClose={ui.closeToGallery} />
  );
}
