
import { TASKS_BOARD } from "@/lib/paths";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useRestIntent, INTENT_MS } from "@/lib/restIntent";
import { Sun, Moon, SunMoon, Sun as SunIcon, Hash, Search } from "lucide-react";
import { BookOpen, BarChart3, FileText, Calendar, Pin, SquarePen, BookMarked, NotebookPen, GraduationCap, Boxes } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AioaMark } from "@/components/AioaMark";
import { StaleDot, UpdateDot, brandTitle, reloadForUpdate, useStaleness } from "@/components/StaleDot";
import type { Glimpse, Recent } from "@/lib/api";
import type { Surface } from "@/lib/surface";
import { titleCase, relativeAgo } from "@/lib/format";
import { useGlimpse, refreshGlimpse } from "@/components/glimpse/store";
import { GlimpseCard, fitGlimpseCard, glimpseOk, type CardLayout } from "@/components/glimpse/GlimpseCard";
import { GMicro } from "@/components/glimpse/charts";

export type NavId = "today" | "learning" | "systems" | "calendar" | "drafting" | "reading" | "library" | "notes" | "insights";
export type Pinned = { name: string; path: string };

export type Theme = "auto" | "light" | "dark";

// the rows column once the panel is open (the resting 60px rail is the w-[60px] class)
const COL = 212;
// the pointer (the keyboard never waits): once open, how long it settles on another row
// before that row's card takes over, and the grace after it leaves the column and the card
const SWAP_MS = 120, GRACE_MS = 200;
// the pointer's flyout: the card beside the hovered row is fitted to this box at most, so it
// keeps its content height and never covers the page the way the keyboard's panel does
const FLY_W = 460, FLY_H = 520, FLY_GAP = 8;
// ... and shows at most this many rows, so the chart keeps its height instead of the list
// taking the card (the keyboard's panel shows every row the window fits)
const FLY_ROWS = 5;

/** the glimpse region beside the rows column: the rest of the window, less its margin */
function glimpseBox(w: number, h: number) {
  const padX = w < 700 ? 12 : 20, padY = h < 620 ? 12 : 20;
  return { padX, padY, w: w - COL - padX * 2, h: h - padY * 2 };
}

function useRoom() {
  const read = () => ({ w: window.innerWidth, h: window.innerHeight });
  const [room, setRoom] = useState(read);
  useEffect(() => {
    let raf = 0;
    const on = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => setRoom(read())); };
    window.addEventListener("resize", on);
    return () => { window.removeEventListener("resize", on); cancelAnimationFrame(raf); };
  }, []);
  return room;
}

export function Sidebar({ nav, go, theme, setTheme, isDark, surface, onCmd, onHelp, onTags, todayBadge, calendarBadge, learningBadge, recent, pinned, unpin, openBoard }:
{ nav: NavId; go: (v: NavId) => void; theme: Theme; setTheme: (t: Theme) => void; isDark: boolean;
  surface?: Surface; onCmd: () => void; onHelp: () => void; onTags: () => void;
  todayBadge?: number; calendarBadge?: number; learningBadge?: number;
  recent: Recent[]; pinned: Pinned[]; unpin: (path: string) => void;
  openBoard: (path: string, title: string, isPaper: boolean) => void; }) {
  const items: [NavId, string, ReactNode, number?][] = [
    ["today",    "Today",    <SunIcon size={17} key="t" />, todayBadge],
    ["calendar", "Calendar", <Calendar size={17} key="cal" />, calendarBadge],
    ["drafting", "Drafting", <SquarePen size={17} key="dr" />],
    ["notes",    "Notes",    <NotebookPen size={17} key="nt" />],
    ["reading",  "Reading",  <BookMarked size={17} key="rd" />],
    ["learning", "Learning", <GraduationCap size={17} key="lr" />, learningBadge],
    ["library",  "Library",  <BookOpen size={17} key="b" />],
    ["systems",  "Systems",  <Boxes size={17} key="sys" />],
    ["insights", "Insights", <BarChart3 size={17} key="c" />],
  ];
  const visibleItems = items;

  // ---- opening the rail
  const [hoverOn, setHoverOn] = useState(false);
  const [focusOn, setFocusOn] = useState(false);
  const [muted, setMuted] = useState(false);
  const open = (hoverOn || focusOn) && !muted;
  // the keyboard's panel is the whole window; the pointer's is the column and a flyout card
  const full = focusOn;
  const asideRef = useRef<HTMLElement | null>(null);
  const grace = useRef(0);
  // a press inside the rail focuses what it presses: that focus is the mouse's, not the
  // keyboard's, so it must not open the whole-window panel
  const pressAt = useRef(0);
  const pressFocus = useRef(false);
  useEffect(() => () => window.clearTimeout(grace.current), []);
  const collapse = () => {
    window.clearTimeout(grace.current);
    setHoverOn(false);
    setHover(null);
  };
  const leave = () => {
    window.clearTimeout(grace.current);
    grace.current = window.setTimeout(() => {
      collapse();
      setMuted(false);
      // a button the mouse pressed keeps the focus, and focus-within would hold the column wide
      const a = document.activeElement as HTMLElement | null;
      if (pressFocus.current && a && asideRef.current?.contains(a)) a.blur();
      pressFocus.current = false;
    }, GRACE_MS);
  };
  // the pointer settles on a row: shut, that opens the flyout; open, that row takes over
  const rest = useRestIntent(INTENT_MS);
  const [flyTop, setFlyTop] = useState(0);
  const settle = (id: NavId) => {
    if (muted) return;
    const row = asideRef.current?.querySelector(`[data-knav-id="nav-${id}"]`);
    if (row) setFlyTop(row.getBoundingClientRect().top);
    setHover(id);
    setBy("hover");
    setHoverOn(true);
  };
  // open by the pointer: a click anywhere else, or Escape, closes it at once
  useEffect(() => {
    if (!hoverOn) return;
    const down = (e: PointerEvent) => { if (!asideRef.current?.contains(e.target as Node)) collapse(); };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || asideRef.current?.contains(document.activeElement)) return;
      e.preventDefault();
      e.stopPropagation();
      collapse();
      setMuted(true);
    };
    document.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key, true);
    };
  }, [hoverOn]);   // eslint-disable-line react-hooks/exhaustive-deps

  // ---- the glimpse
  const room = useRoom();
  const box = glimpseBox(room.w, room.h);
  const snap = useGlimpse();
  const [hover, setHover] = useState<NavId | null>(null);
  const [focused, setFocused] = useState<NavId | null>(null);
  const [by, setBy] = useState<"hover" | "focus">("focus");
  const hi: NavId = (by === "hover" ? hover ?? focused : focused ?? hover) ?? nav;
  const glimpseOf = (id: NavId): Glimpse | null => {
    const g = snap?.views?.[id];
    return glimpseOk(g) ? g : null;
  };
  const hiG = glimpseOf(hi);
  // the card keeps showing the last good glimpse while it fades out over a row without one
  const [shown, setShown] = useState<{ id: NavId; g: Glimpse } | null>(null);
  if (hiG && (shown?.id !== hi || shown.g !== hiG)) setShown({ id: hi, g: hiG });
  const flyG = shown && !full && shown.g.list && shown.g.list.length > FLY_ROWS
    ? { ...shown.g, list: shown.g.list.slice(0, FLY_ROWS) } : shown?.g;
  const layout: CardLayout | null = !shown || !flyG ? null
    : full ? fitGlimpseCard(box.w, box.h, shown.g)
    : fitGlimpseCard(Math.min(box.w, FLY_W), Math.min(box.h, FLY_H), flyG);
  // the flyout sits level with its row, kept inside the window
  const flyY = layout ? Math.max(12, Math.min(flyTop - 10, room.h - layout.height - 12)) : 0;

  const reveal = `whitespace-nowrap transition-opacity duration-150 ${open ? "opacity-100" : "opacity-0 group-focus-within/nav:opacity-100"}`;
  const stale = useStaleness();
  const onlyOpen = open ? "block" : "hidden group-focus-within/nav:block";

  return (
    <aside ref={asideRef} data-knav-region="nav" className={`relative w-[60px] shrink-0 ${muted ? "" : "group/nav"}`}
      onPointerEnter={() => { window.clearTimeout(grace.current); refreshGlimpse(); }}
      onPointerLeave={leave}
      onPointerDownCapture={() => { pressAt.current = Date.now(); }}
      onFocusCapture={() => {
        if (Date.now() - pressAt.current < 500) { pressFocus.current = true; return; }
        pressFocus.current = false;
        setFocusOn(true); setMuted(false); refreshGlimpse();
      }}
      onBlurCapture={(e) => {
        const to = e.relatedTarget as Node | null;
        if (!to || !asideRef.current?.contains(to)) { setFocusOn(false); pressFocus.current = false; }
      }}
      onKeyDown={(e) => {
        // Escape at the rail collapses the panel and gives the view back; the engine does
        // nothing with it here, so consuming it adds a step rather than taking one away
        if (e.defaultPrevented || e.key !== "Escape" || !open) return;
        e.preventDefault();
        setMuted(true);
      }}>
      <div data-rail-open={open ? "1" : "0"} data-rail-mode={open ? (full ? "full" : "fly") : undefined}
        className="pointer-events-none absolute inset-y-0 left-0 z-30 flex w-[60px] group-focus-within/nav:w-screen transition-[width] duration-150 ease-out"
        style={{ width: open ? (full ? room.w : COL) : undefined }}>
        <div data-rail-column
          className={`pointer-events-auto flex shrink-0 flex-col overflow-x-hidden overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden
            border-r border-border bg-card/95 backdrop-blur-sm
            px-2 py-4 [@media(max-height:640px)]:py-2
            w-[60px] group-focus-within/nav:w-[212px]
            transition-[width,box-shadow] duration-150 ease-out ${open ? "shadow-pop" : ""}`}
          style={{ width: open ? COL : undefined }}>
          {stale.bundle ? (
            <button type="button" onClick={reloadForUpdate} title={brandTitle(stale)} aria-label="New version — reload"
              data-bundle-reload
              className="relative flex shrink-0 items-center gap-2.5 px-1.5 pb-4 [@media(max-height:640px)]:pb-1.5 text-left rounded-md">
              <AioaMark className="h-[26px] w-auto shrink-0" title={brandTitle(stale)} />
              <StaleDot />
              <UpdateDot />
              <span className={`font-wordmark text-[17px] tracking-[0.05em] leading-none text-foreground ${reveal}`}>All-in-One Academic</span>
            </button>
          ) : (
            <div title={brandTitle(stale)}
              className="relative flex shrink-0 items-center gap-2.5 px-1.5 pb-4 [@media(max-height:640px)]:pb-1.5">
              <AioaMark className="h-[26px] w-auto shrink-0" title={brandTitle(stale)} />
              <StaleDot />
              <span className={`font-wordmark text-[17px] tracking-[0.05em] leading-none text-foreground ${reveal}`}>All-in-One Academic</span>
            </div>
          )}
          <button onClick={onCmd} title="Jump to…"
            className="mb-3 flex shrink-0 items-center gap-2.5 rounded-lg border border-border px-2.5 py-1.5 text-[12px] text-muted-foreground hover:border-primary/60 hover:text-foreground transition-colors overflow-hidden">
            <Search size={15} className="shrink-0" />
            <span className={`flex-1 text-left ${reveal}`}>Jump to…</span>
            <kbd className={`text-[10px] bg-secondary px-1.5 py-0.5 rounded ${reveal}`}>⌘K</kbd>
          </button>
          <nav className="flex shrink-0 flex-col gap-1">
            {visibleItems.map(([id, label, icon, badge]) => {
              const g = glimpseOf(id);
              const active = nav === id;
              return (
              <button key={id} title={label}
                onClick={() => { go(id); setMuted(true); collapse(); }}
                {...rest(id, () => settle(id), open ? SWAP_MS : INTENT_MS)}
                onFocus={() => { setFocused(id); setBy("focus"); }}
                onBlur={() => setFocused((f) => (f === id ? null : f))}
                data-knav-enter data-knav-id={`nav-${id}`} aria-current={active ? "page" : undefined}
                className={`relative flex shrink-0 items-center gap-2.5 rounded-lg px-2.5 py-2 [@media(max-height:640px)]:py-1 text-[13.5px] transition-colors text-left overflow-hidden
                  ${active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground"}`}>
                <span className="shrink-0">{icon}</span>
                <span className={`min-w-0 flex-1 truncate ${reveal}`}>{label}</span>
                {badge && badge > 0 ? (
                  <>
                    <span className={`nums text-[10.5px] font-medium px-1.5 py-0.5 rounded-full ${reveal} ${active ? "bg-primary-foreground/20 text-primary-foreground" : id === "today" ? "bg-destructive/15 text-destructive" : "bg-secondary text-secondary-foreground"}`}>
                      {badge}
                    </span>
                    {/* collapsed-rail dot: shown only on the resting icon rail */}
                    {!open && <span className={`absolute top-1.5 right-1.5 h-1.5 w-1.5 rounded-full ${active ? "bg-primary-foreground" : id === "today" ? "bg-destructive" : "bg-primary"}`} />}
                  </>
                ) : open && g ? (
                  <span aria-hidden="true" data-knav-skip data-glimpse-micro={id}
                    className={`shrink-0 ${reveal} ${active ? "text-primary-foreground" : "text-muted-foreground/80"}`}>
                    <GMicro g={g} />
                  </span>
                ) : null}
              </button>
              );
            })}
          </nav>

          {pinned.length > 0 && (
            <div className={`mt-5 shrink-0 px-1 ${onlyOpen}`}>
              <div className="text-[10px] uppercase tracking-[0.1em] font-semibold text-muted-foreground px-2 mb-1.5 flex items-center gap-1">
                <Pin size={9} /> Pinned
              </div>
              <div className="flex flex-col">
                {pinned.map((p) => (
                  <div key={p.path} className="group flex shrink-0 items-center hover:bg-accent rounded-md transition-colors">
                    <button onClick={() => openBoard(p.path, titleCase(p.name), p.path !== TASKS_BOARD)}
                      className="flex-1 text-left text-[12px] text-muted-foreground group-hover:text-foreground px-2 py-1.5 flex items-center gap-2">
                      <Pin size={10} className="shrink-0 opacity-60 group-hover:opacity-100" />
                      <span className="truncate capitalize">{p.name}</span>
                    </button>
                    <button onClick={() => unpin(p.path)} className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 text-muted-foreground hover:text-destructive px-2 transition-opacity" title="Unpin">
                      ×
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
          {recent.length > 0 && (
            <div className={`mt-5 shrink-0 px-1 ${onlyOpen}`}>
              <div className="text-[10px] uppercase tracking-[0.1em] font-semibold text-muted-foreground px-2 mb-1.5">Recent</div>
              <div className="flex flex-col">
                {recent.slice(0, 5).filter((r) => !pinned.some((p) => p.path === r.path)).map((r) => (
                  <button key={r.path} onClick={() => openBoard(r.path, titleCase(r.name), !r.isPlanning)}
                    className="shrink-0 text-left text-[12px] text-muted-foreground hover:text-foreground hover:bg-accent rounded-md px-2 py-1.5 flex items-center gap-2 group">
                    <FileText size={11} className="shrink-0 opacity-60 group-hover:opacity-100" />
                    <span className="truncate capitalize">{r.name}</span>
                    <span className="ml-auto text-[10px] nums opacity-60 shrink-0">{relativeAgo(r.ago)}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="mt-auto shrink-0 px-1 pt-3 flex flex-col gap-2">
            <Button variant="outline" size="sm" title="Tag explorer" className="w-full shrink-0 justify-start gap-2 px-2.5 text-muted-foreground overflow-hidden" onClick={onTags}>
              <Hash size={15} className="shrink-0" /> <span className={reveal}>Tag explorer</span>
            </Button>
            <Button variant="outline" size="sm" className="w-full shrink-0 justify-start gap-2 px-2.5 text-muted-foreground overflow-hidden"
              onClick={() => setTheme(theme === "auto" ? "light" : theme === "light" ? "dark" : "auto")}
              title={theme === "auto" ? `Auto: follows the local sun (now ${isDark ? "dark" : "light"})` : `${theme === "light" ? "Light" : "Dark"} · click: ${theme === "light" ? "dark" : "auto"}`}>
              {theme === "auto" ? <SunMoon size={15} className="shrink-0" /> : theme === "light" ? <Sun size={15} className="shrink-0" /> : <Moon size={15} className="shrink-0" />}
              <span className={reveal}>{theme === "auto" ? "Auto theme" : theme === "light" ? "Light mode" : "Dark mode"}</span>
            </Button>
            <button onClick={onHelp} className={`shrink-0 px-2 pt-0.5 text-[10.5px] text-left text-muted-foreground hover:text-foreground transition-colors ${reveal}`}>
              Press <kbd className="text-[10px] bg-secondary px-1 py-0.5 rounded">?</kbd> for shortcuts
            </button>
            {surface && !surface.canEdit && (
              <div className={`shrink-0 px-2 pt-1 text-[9.5px] uppercase tracking-[0.08em] text-muted-foreground/70 ${reveal}`}
                title="Operate-only: this instance can view and run, but not edit or build.">
                Operate-only
              </div>
            )}
          </div>
        </div>

        {open && !full && shown && layout && (
          // the pointer's flyout: beside its row, content-sized, the page left in view
          <div aria-hidden="true" data-knav-skip data-glimpse-card data-glimpse-view={shown.id}
            data-glimpse-on={hiG ? "1" : "0"} data-glimpse-tier={layout.size} data-glimpse-fly
            data-glimpse-charts={layout.charts} data-glimpse-side={layout.chartsSide ? "1" : "0"}
            data-glimpse-beside={layout.listBeside ? "1" : "0"} data-glimpse-list-cols={layout.listCols}
            data-glimpse-stat-cols={layout.statCols}
            onClick={() => { go(shown.id); setMuted(true); collapse(); }}
            className={`absolute cursor-pointer overflow-hidden rounded-xl border border-border bg-card shadow-pop animate-in fade-in-0 duration-150 transition-[top,height,opacity] ease-out ${hiG ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"}`}
            style={{ left: COL + FLY_GAP, top: flyY, width: layout.width, height: layout.height }}>
            <div key={shown.id} className="h-full animate-in fade-in-0 duration-150">
              <GlimpseCard g={flyG ?? shown.g} layout={layout} />
            </div>
          </div>
        )}
        {open && full && (
          <div data-glimpse-region className="flex min-w-0 flex-1 items-start justify-center bg-background animate-in fade-in-0 duration-150"
            style={{ padding: `${box.padY}px ${box.padX}px` }}>
            {shown && layout && (
              <div aria-hidden="true" data-knav-skip data-glimpse-card data-glimpse-view={shown.id}
                data-glimpse-on={hiG ? "1" : "0"} data-glimpse-tier={layout.size}
                data-glimpse-charts={layout.charts} data-glimpse-side={layout.chartsSide ? "1" : "0"}
                data-glimpse-beside={layout.listBeside ? "1" : "0"} data-glimpse-list-cols={layout.listCols}
                data-glimpse-stat-cols={layout.statCols}
                className={`overflow-hidden rounded-xl border border-border bg-card shadow-pop transition-[width,height,opacity] duration-150 ease-out ${hiG ? "opacity-100" : "opacity-0"}`}
                style={{ width: layout.width, height: layout.height }}>
                <div key={shown.id} className="h-full animate-in fade-in-0 duration-150">
                  <GlimpseCard g={shown.g} layout={layout} />
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
