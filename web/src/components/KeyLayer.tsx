
import { useCallback, useEffect, useRef, useState } from "react";
import {
  PREFIX_MS, VIEW_KEYS, VIEW_WIDGET, WIDGET_FULL, WIDGET_KEYS, KEYS_MARKER,
} from "@/lib/keymap";
import { VIEWS } from "@/lib/pathroute";
import { installArrowNav } from "@/lib/arrownav";
import { isSaveChord, requestSave } from "@/lib/savekey";
import type { WidgetName } from "@/lib/pathroute";

/** sessionStorage is per-window, which is exactly the scope of "this window
 *  came from the tasks widget" — it survives the navigation, not the machine. */
const ORIGIN_KEY = "board-widget-origin";

export function isTypingTarget(el: EventTarget | Element | null): boolean {
  const t = el as HTMLElement | null;
  if (!t || typeof t.tagName !== "string") return false;
  if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT") return true;
  if (t.isContentEditable) return true;
  return typeof t.closest === "function" && !!t.closest(".cm-editor, [role='textbox']");
}

const viewUrl = (v: string) => `/v/${v}`;
const widgetUrl = (w: string) => `/w/${w}`;

/** Widget floats are small; a full view opened from one gets a real window. */
function openWindow(url: string, name: string, small: boolean) {
  const features = small ? "width=560,height=680" : "width=1400,height=900";
  const w = window.open(url, name, features);
  if (!w) window.location.assign(url);   // popup blocked: same window beats nothing
}

/* ------------------------------------------------------------------ list nav */

function knavItems(): HTMLElement[] {
  // rows inside the topmost overlay when one is open, so j/k never walk the page behind it
  const layers = Array.from(document.querySelectorAll<HTMLElement>("[role=dialog], [role=alertdialog], [data-knav-modal]"))
    .filter((m) => m.getClientRects().length > 0);
  const scope: ParentNode = layers[layers.length - 1] || document;
  return Array.from(scope.querySelectorAll<HTMLElement>("[data-knav-item]"))
    .filter((el) => el.offsetParent !== null || el.getClientRects().length > 0);
}

function moveKnav(delta: number): boolean {
  const items = knavItems();
  if (items.length === 0) return false;
  const active = document.activeElement as HTMLElement | null;
  const here = active ? items.findIndex((el) => el === active || el.contains(active)) : -1;
  const next = here < 0
    ? (delta > 0 ? 0 : items.length - 1)
    : Math.min(items.length - 1, Math.max(0, here + delta));
  const el = items[next];
  if (!el) return false;
  if (!el.hasAttribute("tabindex") && el.tagName !== "BUTTON" && el.tagName !== "A") el.tabIndex = -1;
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: "nearest" });
  return true;
}

/* ------------------------------------------------------------------- the hook */

export type KeyLayerOpts = {
  /** the shell routes in place; a widget window navigates its URL instead */
  mode: "shell" | "widget";
  widget?: WidgetName;
  /** current view, so `g g` knows which widget to fall back to */
  view?: string;
  /** shell only: switch view without a reload */
  onView?: (view: string) => void;
  onHelp: () => void;
  /** true while the palette / cheat sheet / another modal owns the keyboard */
  blocked?: boolean;
};

export function useBoardKeys(opts: KeyLayerOpts): string | null {
  const [prefix, setPrefix] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  const o = useRef(opts);
  o.current = opts;

  // arrows / Enter / Escape: the geometric engine, once per window
  useEffect(() => installArrowNav(), []);

  const arm = useCallback((k: string | null) => {
    setPrefix(k);
    // the arrow engine stands aside while a prefix owns the next key
    if (k) document.documentElement.setAttribute("data-board-prefix", k);
    else document.documentElement.removeAttribute("data-board-prefix");
    if (timer.current) window.clearTimeout(timer.current);
    // a timed-out prefix must hand the keys back to the arrow engine too
    if (k) timer.current = window.setTimeout(() => {
      setPrefix(null);
      document.documentElement.removeAttribute("data-board-prefix");
      timer.current = null;
    }, PREFIX_MS);
  }, []);

  const goView = useCallback((view: string, newWindow = false) => {
    const { mode, onView } = o.current;
    if (newWindow) return openWindow(viewUrl(view), `board-v-${view}`, false);
    if (mode === "shell" && onView) {
      onView(view);
      // keep the URL honest so a reload stays on this view
      if ((VIEWS as readonly string[]).includes(view)) {
        try { window.history.replaceState(null, "", viewUrl(view) + window.location.search); } catch { /* file:// */ }
      }
      return;
    }
    window.location.assign(viewUrl(view));
  }, []);

  /** `g g` is the return trip, so it navigates THIS window; `w <letter>` from a
   *  full window summons a float, so that one opens a new one. */
  const goWidget = useCallback((w: WidgetName, newWindow: boolean) => {
    if (newWindow) return openWindow(widgetUrl(w), `board-w-${w}`, true);
    window.location.assign(widgetUrl(w));
  }, []);

  /** the full view this window belongs to, and the widget to come back to */
  const fullOf = useCallback(() => {
    const { mode, widget, view } = o.current;
    if (mode === "widget" && widget) return WIDGET_FULL[widget] || "today";
    return view || "today";
  }, []);
  const widgetOf = useCallback((): WidgetName => {
    let stored: string | null = null;
    try { stored = window.sessionStorage.getItem(ORIGIN_KEY); } catch { /* private mode */ }
    if (stored && stored in WIDGET_FULL) return stored as WidgetName;
    return VIEW_WIDGET[o.current.view || "today"] || "tasks";
  }, []);

  const toFull = useCallback((newWindow: boolean) => {
    const { mode, widget } = o.current;
    if (mode === "widget" && widget && !newWindow) {
      try { window.sessionStorage.setItem(ORIGIN_KEY, widget); } catch { /* private mode */ }
    }
    goView(fullOf(), newWindow);
  }, [goView, fullOf]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isSaveChord(e)) {
        if (prefix) arm(null);
        // a surface that handled it already (CodeMirror's Mod-s, the project
        // plan modal) has preventDefaulted; standing down keeps saves single
        if (!e.defaultPrevented) {
          e.preventDefault();   // no browser Save-page dialog in an --app window
          requestSave();
        }
        return;
      }
      const typing = isTypingTarget(e.target);
      if (e.key === "Escape") {
        if (prefix) { arm(null); e.preventDefault(); }
        return;   // every other Escape belongs to the focused control, then lib/arrownav.ts
      }
      if (typing || o.current.blocked) return;

      // a prefix is armed: the next key resolves it, whatever it is
      if (prefix) {
        const k = e.key.toLowerCase();
        const ctrl = e.ctrlKey || e.metaKey;
        arm(null);
        if (prefix === "g") {
          if (k === "g") { e.preventDefault(); goWidget(widgetOf(), ctrl); return; }
          if (k === "f") { e.preventDefault(); toFull(ctrl); return; }
          const v = VIEW_KEYS[k];
          if (v) { e.preventDefault(); goView(v, ctrl); }
          return;
        }
        if (prefix === "w") {
          const w = WIDGET_KEYS[k];
          if (w) { e.preventDefault(); goWidget(w, ctrl || o.current.mode === "shell"); }
          return;
        }
        return;
      }

      // Shift+Enter (nothing focused) is the widget's one-key way out
      if (e.key === "Enter" && e.shiftKey) {
        const a = document.activeElement;
        const idle = !a || a === document.body;
        if (o.current.mode === "widget" && idle) { e.preventDefault(); toFull(e.ctrlKey || e.metaKey); return; }
      }

      if (e.ctrlKey || e.metaKey || e.altKey) return;

      if (e.key === "?" || (e.key === "/" && e.shiftKey)) { e.preventDefault(); o.current.onHelp(); return; }
      if (e.key === "g" || e.key === "w") { e.preventDefault(); arm(e.key); return; }

      if ((e.key === "j" || e.key === "k") && !e.defaultPrevented) {
        if (moveKnav(e.key === "j" ? 1 : -1)) e.preventDefault();
      }
      // Enter on a focused row belongs to lib/arrownav.ts, which clicks it
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [prefix, arm, goView, goWidget, toFull, widgetOf]);

  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);
  return prefix;
}

/* -------------------------------------------------------------- the indicator */

/** Mount once. Owns the key layer and shows which prefix is armed. */
export function KeyLayer(props: KeyLayerOpts) {
  const prefix = useBoardKeys(props);
  const hint = prefix === "g" ? "view · f full · g widget" : prefix === "w" ? "widget" : "";
  return (
    <div data-board-keys={KEYS_MARKER} aria-hidden={!prefix}
      className={"pointer-events-none fixed bottom-3 left-3 z-[60] flex items-center gap-2 rounded-md border border-border "
        + "bg-card/95 px-2 py-1 shadow-sm transition-opacity duration-100 "
        + (prefix ? "opacity-100" : "opacity-0")}>
      <kbd className="rounded border border-border bg-secondary px-1.5 py-0.5 text-[11px] font-medium text-secondary-foreground">
        {prefix || ""}
      </kbd>
      <span className="text-[10.5px] text-muted-foreground">{hint}</span>
    </div>
  );
}
