
import { TASKS_BOARD } from "@/lib/paths";
import { useEffect, useState, useCallback, lazy, Suspense } from "react";
import { Toaster } from "@/components/ui/sonner";
import { api } from "@/lib/api";
import type { Recent, Cache } from "@/lib/api";
import { useApi, usePersistent, useHotkey } from "@/lib/hooks";
import { useAppTheme } from "@/lib/theme";
import { titleCase } from "@/lib/format";
import { computeDrift, applyDrift, sunTimes, isNight, skyWash } from "@/lib/ambient";
import { useSurface } from "@/lib/surface";
import { Sidebar } from "@/components/Sidebar";
import type { NavId, Pinned } from "@/components/Sidebar";
import { CommandPalette } from "@/components/CommandPalette";
import { Today } from "@/components/Today";
import { Learning } from "@/components/Learning";
const Systems = lazy(() => import("@/components/systems/Systems").then((m) => ({ default: m.Systems })));
import { BoardView } from "@/components/BoardView";
import type { BoardRoute } from "@/components/BoardView";
import { CalendarMonth } from "@/components/CalendarMonth";

const Drafting = lazy(() => import("@/components/Drafting").then((m) => ({ default: m.Drafting })));
import { Reading } from "@/components/Reading";
import { Library } from "@/components/Library";
import { Notes } from "@/components/Notes";
import { Insights } from "@/components/Insights";
import { Shortcuts } from "@/components/Shortcuts";
import { TagExplorer } from "@/components/TagExplorer";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { SkelOverview } from "@/components/Skeletons";
import { AudienceView } from "@/components/AudienceView";
import { setPendingDraftOpen, applyNotesHash } from "@/lib/taskdest";
import { requestDraftingTab } from "@/components/DraftingPipeline";
import { WidgetShell } from "@/components/WidgetShell";
import { KeyLayer } from "@/components/KeyLayer";
import { KeyHints } from "@/components/KeyHints";
import { clearWidgetFocus } from "@/lib/arrownav";
import { pathRoute, VIEWS } from "@/lib/pathroute";

type Route =
  | { view: "today" }
  | { view: "learning" }
  | { view: "systems" }
  | { view: "board"; route: BoardRoute }
  | { view: "calendar" }
  | { view: "drafting" }
  | { view: "reading"; expand?: string }
  | { view: "library" }
  | { view: "notes" }
  | { view: "insights" };

export default function App() {
  if (pathRoute?.kind === "widget") return <WidgetShell name={pathRoute.name} />;
  return <AppShell />;
}

function AppShell() {
  const surface = useSurface();
  const projects = useApi(() => api.projects(), [], 60_000);
  const today    = useApi(() => api.today(), [], 30_000);
  const activity = useApi(() => api.activity(), [], 60_000);
  const floatingOpen = useApi(
    async () => (await api.board(TASKS_BOARD)).lanes
      ?.filter((l) => l.name !== "DONE" && l.name !== "Archive")
      .reduce((s, l) => s + l.cards.filter((c) => !c.done && !c.due).length, 0) ?? 0,
    [], 60_000);

  // persisted UI state
  const [theme, setTheme] = usePersistent<"auto" | "light" | "dark">("aioa-theme", "auto");
  const [route, setRoute] = usePersistent<Route>("aioa-route", { view: "today" });
  const [pathApplied, setPathApplied] = useState(false);
  if (!pathApplied) {
    setPathApplied(true);
    if (pathRoute?.kind === "view" && (route as { view: string }).view !== pathRoute.name) {
      setRoute({ view: pathRoute.name } as Route);
    }
  }
  const wantsCache = route.view === "library" || route.view === "insights" || route.view === "reading";
  const cacheRes = useApi(
    () => (wantsCache ? api.cache() : Promise.resolve(null as unknown as Cache)),
    [wantsCache], 300_000);
  const cache = cacheRes.data;
  const refreshCache = useCallback(async () => { await api.rebuildCache(); cacheRes.reload(); }, [cacheRes]);
  useEffect(() => {
    const v = (route as { view: string }).view;
    if (v === "plan" || v === "timeline") setRoute({ view: "calendar" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route]);
  // a widget's focused view belongs to the page it was opened on
  useEffect(() => { clearWidgetFocus(); }, [route]);
  const [pinned, setPinned] = usePersistent<Pinned[]>("aioa-pinned", []);
  const [cmdOpen, setCmdOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [tagsOpen, setTagsOpen] = useState(false);

  const ambient = useApi(() => api.ambient(), [], 900_000);
  const [clock, setClock] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setClock((c) => c + 1), 60_000);
    return () => clearInterval(id);
  }, []);
  const { sunrise, sunset } = sunTimes(ambient.data ?? null, new Date());
  const appTheme = useAppTheme(theme === "auto" ? null : theme);
  const dark = theme === "dark"
    || (theme === "auto" && (appTheme.mode ? appTheme.mode === "dark" : isNight(new Date(), sunrise, sunset)));
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    applyDrift(computeDrift(ambient.data ?? null, new Date(), dark));
  }, [dark, ambient.data, clock]);
  const sky = skyWash(ambient.data ?? null, new Date(), dark);

  useHotkey("mod+k", () => setCmdOpen((o) => !o));
  useHotkey("/", () => setCmdOpen(true));
  useHotkey("mod+shift+f", () => setTagsOpen(true));
  // every other in-app key (the g/w prefixes, widget <-> full, list j/k, `?`)
  // lives in ONE module: components/KeyLayer.tsx over the table in lib/keymap.ts.
  const goView = useCallback((v: string) => setRoute({ view: v } as Route), [setRoute]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const v = route.view;
    if (!(VIEWS as readonly string[]).includes(v)) return;   // board/drafting sub-routes keep theirs
    const want = `/v/${v}` + window.location.search + window.location.hash;
    if (window.location.pathname + window.location.search + window.location.hash === want) return;
    try { window.history.replaceState(null, "", want); } catch { /* file:// */ }
  }, [route.view]);

  const [audience, setAudience] = useState<{ slug: string; deck: string } | null>(null);

  useEffect(() => {
    if (pathRoute?.kind === "view") setRoute({ view: pathRoute.name } as Route);
    // setRoute is a stable useState setter (usePersistent)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const views: NavId[] = ["today", "learning", "systems",
      "calendar", "drafting", "reading", "library", "notes", "insights"];
    const applyHash = () => {
      const raw = window.location.hash.replace(/^#\/?/, "");
      // audience keeps its hash (a refresh must stay on the audience view) and
      // parses params from the RAW hash — slugs and deck names are case-sensitive
      if (raw.toLowerCase().startsWith("audience") && raw.includes("?")) {
        const qs = new URLSearchParams(raw.slice(raw.indexOf("?") + 1));
        const slug = qs.get("slug") || "", deck = qs.get("deck") || "";
        if (slug && deck) setAudience({ slug, deck });
        return;
      }
      const h = raw.toLowerCase();
      if (!h) return;
      const [head0, sub0] = h.split("/");
      const head = head0 === "plan" || head0 === "timeline" ? "calendar" : head0;
      const sub = sub0;
      if ((views as string[]).includes(head)) {
        // #/drafting/<slug>/<doc> auto-opens that manuscript in the editor
        // (parts from the RAW hash — slugs are case-sensitive folder names)
        if (head === "drafting" && sub) {
          const parts = raw.split("/");
          const slug = decodeURIComponent(parts[1] || "");
          const doc = decodeURIComponent(parts[2] || "");
          // the SETTER, not a bare assignment: on a hashchange Drafting is already
          // mounted, so its one mount read is long gone and only a notification lands
          if (slug && doc) setPendingDraftOpen({ slug, doc });
          // #/drafting/pipeline lands on the Pipeline tab
          else if (sub === "pipeline" || sub === "library") requestDraftingTab(sub);
        }
        // #/notes/<section>, #/notes/diagrams/new[/<Template>], #/notes/diagrams/open/<Name>
        if (head === "notes" && sub) applyNotesHash(raw);
        setRoute({ view: head } as Route);
      }
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    };
    applyHash();
    window.addEventListener("hashchange", applyHash);
    return () => window.removeEventListener("hashchange", applyHash);
    // setRoute is a stable useState setter (usePersistent)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openBoard = useCallback((path: string, title: string, isPaper: boolean) =>
    setRoute({ view: "board", route: { path, title, subtitle: isPaper ? "paper board" : "personal & admin", isPaper } }),
    [setRoute]);

  const togglePin = useCallback((p: Pinned) => {
    setPinned((prev) => prev.some((x) => x.path === p.path)
      ? prev.filter((x) => x.path !== p.path)
      : [...prev, p]);
  }, [setPinned]);
  const unpin = useCallback((path: string) => {
    setPinned((prev) => prev.filter((x) => x.path !== path));
  }, [setPinned]);

  const papers = projects.data || cache?.projects || [];
  const recent: Recent[] = activity.data || [];
  const nav: NavId = route.view === "board" ? "calendar" : (route.view as NavId);
  const currentBoardPath = route.view === "board" ? route.route.path : null;
  const currentBoardName = route.view === "board" ? route.route.title : null;
  const isCurrentPinned = currentBoardPath ? pinned.some((p) => p.path === currentBoardPath) : false;

  if (audience) return <AudienceView slug={audience.slug} deck={audience.deck} />;

  return (
    <div className="flex h-full min-h-screen bg-background text-foreground" style={{ backgroundImage: sky }}>
      <Toaster position="bottom-right" />
      <Shortcuts open={helpOpen} setOpen={setHelpOpen} />
      <KeyLayer mode="shell" view={route.view} onView={goView}
        onHelp={() => setHelpOpen(true)} blocked={cmdOpen || helpOpen || tagsOpen} />
      <TagExplorer open={tagsOpen} setOpen={setTagsOpen} openBoard={openBoard} />
      <CommandPalette
        open={cmdOpen} setOpen={setCmdOpen}
        papers={papers} today={today.data || null} recent={recent} items={cache?.items || []}
        onGo={(v) => { goView(v); setCmdOpen(false); }}
        onPick={(p) => openBoard(p.path, titleCase(p.name), p.path !== TASKS_BOARD)} />
      <Sidebar
        nav={nav} go={(v) => setRoute({ view: v } as Route)}
        theme={theme} setTheme={setTheme} isDark={dark}
        surface={surface}
        onCmd={() => setCmdOpen(true)}
        onHelp={() => setHelpOpen(true)}
        onTags={() => setTagsOpen(true)}
        todayBadge={(today.data?.overdue?.length ?? 0) + (today.data?.dueToday?.length ?? 0)}
        calendarBadge={floatingOpen.data ?? 0}
        recent={recent} pinned={pinned} unpin={unpin} openBoard={openBoard} />
      <div className="flex min-w-0 flex-1 flex-col">
      <main data-knav-region="main" className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden print-area">
        <div className="mx-auto w-full max-w-[1720px] px-3 sm:px-5 md:px-6 xl:px-10 py-5 sm:py-7 xl:py-9">
          <ErrorBoundary>
            {route.view === "today"    ? <Today openBoard={openBoard} go={(v) => setRoute({ view: v } as Route)} />
             : route.view === "learning" ? <Learning />
             : route.view === "systems" ? <Suspense fallback={null}><Systems openView={(v) => setRoute({ view: v } as Route)} /></Suspense>
             : route.view === "board"  ? <BoardView route={route.route} back={() => setRoute({ view: "calendar" })}
                  isPinned={isCurrentPinned}
                  togglePin={() => currentBoardPath && currentBoardName && togglePin({ name: currentBoardName, path: currentBoardPath })}
                  onOpenReading={(listName) => setRoute({ view: "reading", expand: listName })} />
             : route.view === "calendar" ? <CalendarMonth openBoard={openBoard} go={(v) => setRoute({ view: v } as Route)} />
             : route.view === "drafting" ? <Suspense fallback={null}><Drafting /></Suspense>
             : route.view === "reading"  ? <Reading items={cache?.items || []} expand={route.expand} />
             : route.view === "library"  ? (cache ? <Library cache={cache} onRefresh={refreshCache} /> : <SkelOverview />)
             : route.view === "notes"    ? <Notes />
             : cache ? <Insights cache={cache} onRefresh={refreshCache} /> : <SkelOverview />}
          </ErrorBoundary>
        </div>
      </main>
      <KeyHints />
      </div>
    </div>
  );
}
