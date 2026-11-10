
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { exploreApi, type GalleryFigure, type ProjectGallery } from "@/lib/api";
import { useFigureTheme } from "@/components/explore/figureStore";
import { typingEscape } from "@/components/draftingShared";
import { ago as agoOf, paneReloaded, type PaneSize } from "@/components/widgets/panel";
import { PanelHeader, useLeftToTabs, type PanelChromeProps } from "@/components/widgets/PanelChrome";

const SUPP = "supplementary";
const GROUPS: { key: string; label: string; folder?: boolean }[] = [
  { key: "results", label: "Results" },
  { key: SUPP, label: "Supplementary", folder: true },
  { key: "interactive", label: "Interactive" },
  { key: "exploration", label: "Exploration" },
  { key: "runs", label: "Runs" },
];

const FIG_NO = /^(fig(?:\.\d+|S\d+)\.)(.*)$/;

const SUPP_KEY = "figure-widget:supp";
let suppOpenNow: boolean = (() => {
  try { return paneReloaded && sessionStorage.getItem(SUPP_KEY) === "1"; } catch { return false; }
})();
const rememberSupp = (open: boolean) => {
  suppOpenNow = open;
  try { sessionStorage.setItem(SUPP_KEY, open ? "1" : "0"); } catch { /* private mode */ }
};

/* THE VIEW. One module copy shared by the grid and the viewer (FigureWidget's arrows), so
 * the two can never disagree; `null` = nothing chosen yet, the default rule decides. */
export type FigView = "results" | "exploration";
const VIEW_KEY = "figure-widget:view";
let viewChoice: FigView | null = (() => {
  try {
    const v = paneReloaded ? sessionStorage.getItem(VIEW_KEY) : null;
    return v === "results" || v === "exploration" ? v : null;
  } catch { return null; }
})();
const viewSubs = new Set<() => void>();

export const setFigView = (v: FigView, remember = true) => {
  if (remember) { try { sessionStorage.setItem(VIEW_KEY, v); } catch { /* private mode */ } }
  if (viewChoice === v) return;
  viewChoice = v;
  viewSubs.forEach((f) => f());
};
const subscribeView = (f: () => void) => { viewSubs.add(f); return () => { viewSubs.delete(f); }; };
const RESULTS_SIDE = new Set(["results", SUPP, "interactive"]);
/** which view a listed figure belongs to */
export const viewOfFigure = (f: GalleryFigure): FigView => (f.group === "exploration" ? "exploration" : "results");

export function effectiveView(figs: GalleryFigure[], choice: FigView | null = viewChoice): FigView {
  if (choice) return choice;
  const res = figs.some((f) => RESULTS_SIDE.has(f.group));
  return !res && figs.some((f) => f.group === "exploration") ? "exploration" : "results";
}
export function useFigView(figs: GalleryFigure[]): FigView {
  const choice = useSyncExternalStore(subscribeView, () => viewChoice);
  return effectiveView(figs, choice);
}
/** the figures of one view in the order the grid draws them (Exploration newest first) */
export function figuresInView(figs: GalleryFigure[], view: FigView): GalleryFigure[] {
  if (view === "exploration")
    return figs.filter((f) => f.group === "exploration").sort((a, b) => b.mtime - a.mtime);
  return GROUPS.filter((g) => g.key !== "exploration")
    .flatMap((g) => figs.filter((f) => f.group === g.key));
}

/** how long ago, in the shortest form that is still true (shared with the other views) */
const ago = (secs: number) => agoOf(secs);

const TRACK: Record<PaneSize, number> = { xs: 104, sm: 104, md: 168, lg: 232, xl: 300 };

export const displayUrl = (f: GalleryFigure): string => f.preview || f.url;
/** The ORIGINAL (the viewer's Full resolution). */
export const fullUrl = (f: GalleryFigure): string => f.url;

const PREFETCHED = new Set<string>();
let prefetchSettled = 0;
export function usePrefetchFigures(gal: ProjectGallery | null) {
  useEffect(() => {
    const urls: string[] = [];
    for (const f of gal?.figures ?? []) {
      if (f.id || f.group === "runs") continue;
      const u = f.kind === "interactive" ? (f.thumb || "") : displayUrl(f);
      if (u && !PREFETCHED.has(u) && !urls.includes(u)) urls.push(u);
    }
    if (!urls.length) return;
    let live = true, i = 0, inflight = 0;
    const next = () => {
      while (live && inflight < 2 && i < urls.length) {
        const u = urls[i++];
        PREFETCHED.add(u);
        inflight++;
        const im = new Image();
        im.decoding = "async";
        const done = () => {
          inflight--;
          prefetchSettled++;
          try { document.documentElement.setAttribute("data-fig-prefetch", String(prefetchSettled)); } catch { /* detached */ }
          next();
        };
        im.onload = done;
        im.onerror = () => { PREFETCHED.delete(u); done(); };
        im.src = u;
      }
    };
    next();
    return () => { live = false; };
  }, [gal]);
}

export function useProjectGallery(slug: string, active: boolean, ms = 2000): ProjectGallery | null {
  const [gal, setGal] = useState<ProjectGallery | null>(null);
  const stamp = useRef("");
  useEffect(() => {
    if (!slug || !active) return;
    let live = true;
    const pull = () => {
      if (document.hidden) return;
      exploreApi.projectGallery(slug).then((r) => {
        if (!live || !r || r.error || !r.stamp || r.stamp === stamp.current) return;
        stamp.current = r.stamp;
        setGal(r);
      }).catch(() => {});
    };
    pull();
    const t = window.setInterval(pull, ms);
    return () => { live = false; window.clearInterval(t); };
  }, [slug, active, ms]);
  return gal;
}

export function FigureGallery({ gal, project, follow, current, recent, onPick, chrome, size }: {
  gal: ProjectGallery | null;
  project: string;
  follow: boolean;
  current: string | null;
  /** name -> when it arrived; a card stays marked new for a minute */
  recent: Record<string, number>;
  onPick: (f: GalleryFigure) => void;
  chrome: PanelChromeProps;
  size: PaneSize;
}) {
  const theme = useFigureTheme();
  const body = useRef<HTMLDivElement>(null);
  const figures = useMemo(() => gal?.figures ?? [], [gal]);

  const inSupp = (name: string | null) => !!name && figures.some((f) => f.group === SUPP && f.name === name);
  const [suppOpen, setSuppOpen] = useState(() => suppOpenNow || inSupp(current));
  const toggleSupp = () => setSuppOpen((v) => { rememberSupp(!v); return !v; });

  const back = useRef(current);
  useEffect(() => {
    const want = back.current;
    if (!want || !figures.length) return;
    if (!suppOpen && inSupp(want)) { setSuppOpen(true); return; }
    back.current = null;
    const el = body.current?.querySelector<HTMLButtonElement>(
      `[data-gallery-name="${CSS.escape(want)}"]`);
    if (el) { document.documentElement.setAttribute("data-knav", ""); el.focus({ preventScroll: true }); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [figures, suppOpen]);

  const [, retick] = useState(0);
  useEffect(() => {
    if (!Object.keys(recent).length) return;
    const id = window.setInterval(() => retick((n) => n + 1), 5_000);
    return () => window.clearInterval(id);
  }, [recent]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.key !== "Home" && e.key !== "End") return;
      const cards = body.current?.querySelectorAll<HTMLButtonElement>("[data-gallery-card]");
      if (!cards?.length) return;
      e.preventDefault();
      const el = e.key === "Home" ? cards[0] : cards[cards.length - 1];
      document.documentElement.setAttribute("data-knav", "");
      el.focus({ preventScroll: false });
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  // the view strip: counts per view, a dot on the other view when a fresh figure waits there
  const view = useFigView(figures);
  const nRes = figures.filter((f) => f.group !== "exploration").length;
  const nExp = figures.length - nRes;
  const figuresRef = useRef(figures);
  figuresRef.current = figures;
  // `x` flips the view while the grid is up (never while typing, never with a modifier)
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key !== "x" && e.key !== "X") return;
      if (typingEscape(e) || !document.querySelector("[data-gallery-views]")) return;
      e.preventDefault();
      setFigView(effectiveView(figuresRef.current) === "exploration" ? "results" : "exploration");
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);
  const markSeen = useRef(Date.now());
  useEffect(() => {
    let name = "", at = markSeen.current;
    for (const [n, t] of Object.entries(recent)) if (t > at) { at = t; name = n; }
    if (!name) return;
    const f = figuresRef.current.find((g) => g.name === name);
    if (!f) return;   // a plot the listing has not caught up with: tried again when it does
    markSeen.current = at;
    if (viewOfFigure(f) !== effectiveView(figuresRef.current)) setFigView(viewOfFigure(f), false);
  }, [recent, figures]);
  // a card that left with the other view takes focus with it: the first card of this one
  const firstView = useRef(true);
  useEffect(() => {
    if (firstView.current) { firstView.current = false; return; }
    const a = document.activeElement;
    if (a && a !== document.body && a.isConnected) return;
    const el = body.current?.querySelector<HTMLButtonElement>("[data-gallery-card]");
    el?.focus({ preventScroll: true });
    body.current?.scrollTo({ top: 0 });
  }, [view]);

  useLeftToTabs();

  const now = Date.now();
  const meta = size !== "xs" && size !== "sm";
  const freshIn = (v: FigView) => figures.some((f) => viewOfFigure(f) === v && (recent[f.name] || 0) > now - 60_000);
  const shownGroups = view === "exploration"
    ? [{ key: "exploration", label: "Exploration", folder: false, rows: figuresInView(figures, "exploration"), bare: true }]
    : GROUPS.filter((g) => g.key !== "exploration")
      .map((g) => ({ ...g, folder: !!g.folder, rows: figures.filter((f) => f.group === g.key), bare: false }));
  return (
    <div data-panel="figures" data-size={size} className="h-screen flex flex-col bg-background text-foreground">
      <PanelHeader {...chrome} title={gal?.name || project} titleHint={gal?.root || project}
        right={
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            <span className="nums text-[10px] text-muted-foreground">{figures.length}</span>
            {follow && (
              <span className="inline-flex items-center" title="Following the latest figure">
                <span className="h-[6px] w-[6px] rounded-full bg-primary" />
              </span>
            )}
          </span>
        } />

      {figures.length > 0 && (
        <div data-gallery-views={view} className="flex shrink-0 items-center gap-0.5 border-b border-border/40 px-2 pt-1 pb-1">
          {([["results", "Results", nRes], ["exploration", "Exploration", nExp]] as const).map(([v, label, n]) => {
            const on = v === view;
            const dot = !on && freshIn(v);
            return (
              <button key={v} type="button" data-knav-item data-gallery-view={v} aria-current={on ? "page" : undefined}
                onClick={() => setFigView(v)}
                title={(v === "results" ? "Results, supplementary, interactive and runs" : "Exploration figures still being vetted, newest first") + " (x)"}
                className={"relative inline-flex h-[17px] items-center gap-1 rounded-sm px-1.5 text-[10px] leading-none outline-none "
                  + (on ? "text-foreground" : "text-muted-foreground hover:text-foreground")}>
                {dot && <span data-gallery-view-new className="h-[5px] w-[5px] shrink-0 rounded-full bg-primary" />}
                <span>{label}</span>{" "}
                <span data-gallery-view-count className="nums text-[9px] text-muted-foreground">{n}</span>
                {on && <span className="pointer-events-none absolute inset-x-1 bottom-0 h-[1.5px] rounded-full bg-primary" />}
              </button>
            );
          })}
        </div>
      )}

      <div ref={body} data-panel-body className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {!figures.length ? (
          <div className="flex h-full items-center justify-center text-center text-[12px] text-muted-foreground">
            {gal ? `${gal.name} — no figures yet` : "Reading the project"}
          </div>
        ) : !(view === "results" ? nRes : nExp) ? (
          <div data-gallery-view-empty className="flex h-full items-center justify-center text-center text-[12px] text-muted-foreground">
            {view === "results" ? "No results figures yet" : "No exploration figures yet"}
          </div>
        ) : shownGroups.map(({ key, label, folder, rows, bare }) => {
          if (!rows.length) return null;
          const shown = !folder || suppOpen;
          return (
            <section key={key} data-gallery-group={key}>
              {bare ? <div className="pt-1.5" /> : <div className="sticky top-0 z-10 bg-background pt-1.5 pb-1">
                {folder ? (
                  <button type="button" data-knav-item data-gallery-folder aria-expanded={suppOpen}
                    onClick={toggleSupp}
                    className="flex w-full items-center gap-1 rounded-sm text-left outline-none">
                    {suppOpen
                      ? <ChevronDown size={10} className="-ml-0.5 shrink-0 text-muted-foreground" />
                      : <ChevronRight size={10} className="-ml-0.5 shrink-0 text-muted-foreground" />}
                    <span className="text-[9px] font-medium uppercase tracking-[0.08em] text-muted-foreground">{label}</span>
                    <span className="flex-1" />
                    <span className="nums text-[9px] text-muted-foreground">{rows.length}</span>
                  </button>
                ) : (
                  <div className="flex items-center gap-1.5">
                    <span className="text-[9px] font-medium uppercase tracking-[0.08em] text-muted-foreground">{label}</span>
                    <span className="flex-1" />
                    <span className="nums text-[9px] text-muted-foreground">{rows.length}</span>
                  </div>
                )}
              </div>}
              {shown && <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${TRACK[size]}px, 1fr))` }}>
                {rows.map((f) => {
                  
                  const live = f.kind === "interactive";
                  const src = f.id ? exploreApi.renderUrl(f.id, theme, f.ver ?? 1)
                    : live ? (f.thumb || "") : displayUrl(f);
                  const fresh = (recent[f.name] || 0) > now - 60_000;
                  const here = current === f.name;
                  const m = FIG_NO.exec(f.name);
                  return (
                    <button key={f.group + "/" + f.rel} data-knav-item data-gallery-card data-gallery-name={f.name}
                      data-gallery-kind={live ? "interactive" : "figure"}
                      onClick={() => onPick(f)}
                      title={[f.name, live ? "interactive · 3D" : "", ago(f.mtime), f.script || ""].filter(Boolean).join(" · ")}
                      aria-label={live ? f.name + " (interactive figure)" : f.name}
                      className={"relative flex flex-col overflow-hidden rounded-md border text-left outline-none "
                        + "transition-transform focus-visible:-translate-y-px focus-visible:shadow-pop "
                        + "focus-visible:border-primary/70 focus-visible:ring-1 focus-visible:ring-primary/60 "
                        + (here ? "border-primary/70" : "border-transparent hover:border-primary/50")}>
                      <span className={"block w-full overflow-hidden " + (live && !src ? "bg-muted" : "bg-white")}
                        style={{ aspectRatio: "4 / 3" }}>
                        {src
                          ? <img src={src} alt="" loading="lazy" decoding="async"
                              className="h-full w-full object-contain" />
                          : <span data-gallery-placeholder
                              className="flex h-full w-full items-center justify-center px-1 text-center text-[9px] leading-[1.3] text-muted-foreground">
                              {f.name}
                            </span>}
                      </span>
                      {live && (
                        <span data-gallery-chip
                          className="pointer-events-none absolute left-1 top-1 rounded-[3px] bg-primary/85 px-1 py-[1px] text-[7.5px] font-medium uppercase leading-none tracking-[0.06em] text-primary-foreground">
                          interactive
                        </span>
                      )}
                      <span className="truncate px-1 pt-[2px] text-[9px] leading-[1.35] text-muted-foreground">
                        {m ? <><span className="font-semibold text-foreground/80">{m[1]}</span>{m[2]}</> : f.name}
                      </span>
                      {meta && (
                        <span className="truncate px-1 pb-[2px] text-[8.5px] leading-[1.3] text-muted-foreground/75">
                          {[f.script ? f.script.split("/").pop() : "", ago(f.mtime)].filter(Boolean).join(" · ")}
                        </span>
                      )}
                      {fresh && <span className="absolute right-1 top-1 h-[6px] w-[6px] rounded-full bg-primary ring-2 ring-background" />}
                    </button>
                  );
                })}
              </div>}
            </section>
          );
        })}
      </div>
    </div>
  );
}
