
import { useEffect, useRef, useState } from "react";
import { panelApi, type PanelEvent } from "@/lib/api";
import { staleness } from "@/lib/boardcache";

export type PanelViewId = "start" | "datasets" | "variables" | "figures" | "tables" | "coding" | "reader";
export type PanelMode = "list" | "detail";

export const ALL_PANEL_VIEWS: { id: PanelViewId; label: string }[] = [
  { id: "start", label: "Start" },
  { id: "datasets", label: "Datasets" },
  { id: "variables", label: "Variables" },
  { id: "figures", label: "Figures" },
  { id: "tables", label: "Tables" },
  { id: "coding", label: "Coding" },
  { id: "reader", label: "Reader" },
];

/** the ones that ship */
const ENABLED: PanelViewId[] = ["start", "datasets", "variables", "figures", "tables", "coding", "reader"];

const forced = (() => {
  try {
    return !!navigator.webdriver && new URLSearchParams(window.location.search).get("panel") === "all";
  } catch { return false; }
})();

/** Tabs for the header's left slot. One entry renders no tabs at all (each view's
 *  header guards on length > 1), so the pane looks exactly as it did before. */
export const PANEL_VIEWS = ALL_PANEL_VIEWS.filter((v) => forced || ENABLED.includes(v.id));

export const panelHasView = (id: PanelViewId) => PANEL_VIEWS.some((v) => v.id === id);

export const NEWS_MAX_S = 90;
export const isNews = (ts: number | null | undefined): boolean =>
  typeof ts === "number" && Number.isFinite(ts) && ts > 0 && Date.now() / 1000 - ts <= NEWS_MAX_S;

const NS = "figure-widget:";

export function paneRecall<T>(key: string, ok: (v: unknown) => v is T): T | null {
  try {
    const raw = localStorage.getItem(NS + key);
    if (!raw) return null;
    const v = JSON.parse(raw) as unknown;
    return ok(v) ? v : null;
  } catch { return null; }
}

export function paneRemember(key: string, value: unknown): void {
  try { localStorage.setItem(NS + key, JSON.stringify(value)); } catch { /* private mode, quota */ }
}

let searchTouched = false;

/** A view's search box, remembered across relaunches. Restored text is NEVER focus: the
 *  pane opens on Start with the caret nowhere, exactly as it does today. */
export function useRememberedSearch(view: PanelViewId): [string, (q: string) => void] {
  const [q, setQ] = useState<string>(() => paneRecall<string>("search." + view, (v): v is string => typeof v === "string") || "");
  const set = useRef((next: string) => { searchTouched = true; setQ(next); paneRemember("search." + view, next); });
  return [q, set.current];
}

const TAB_KEY = NS + "tab";

const NAV_TYPE = (() => {
  try {
    const e = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    return e ? String(e.type || "") : "";
  } catch { return ""; }
})();

/** true when the page we are running came up through a reload, not a fresh navigation */
export const paneReloaded = NAV_TYPE === "reload";

export function recallTab(): PanelViewId | null {
  try {
    const v = sessionStorage.getItem(TAB_KEY) || "";
    return ALL_PANEL_VIEWS.some((x) => x.id === v) ? (v as PanelViewId) : null;
  } catch { return null; }
}

export function rememberTab(v: PanelViewId): void {
  try { sessionStorage.setItem(TAB_KEY, v); } catch { /* private mode */ }
}

export type PanelEventState = {
  /** the newest event of each kind at mount: seeds the views, never switches one */
  seed: PanelEvent[];
  /** the newest event since the mount, which is what auto-switch reacts to */
  latest: PanelEvent | null;
};

export function usePanelEvents(session: string, active = true, ms = 2000): PanelEventState {
  const [state, setState] = useState<PanelEventState>({ seed: [], latest: null });
  const since = useRef<number | null>(null);

  useEffect(() => {
    if (!active) return;
    let live = true;
    const pull = () => {
      panelApi.events(session, since.current).then((r) => {
        if (!live) return;
        const seq = r.seq || since.current || 0;
        if (since.current === null) {
          since.current = seq;
          if (r.events.length) setState((s) => ({ ...s, seed: r.events }));
          return;
        }
        since.current = Math.max(since.current, seq);
        const fresh = r.events.filter((e) => e.seq > 0);
        if (fresh.length) {
          const newest = fresh.reduce((a, b) => (b.seq >= a.seq ? b : a));
          setState((s) => (s.latest && s.latest.seq >= newest.seq ? s : { ...s, latest: newest }));
        }
      }).catch(() => {});
    };
    pull();
    const t = window.setInterval(pull, ms);
    window.addEventListener("focus", pull);
    return () => { live = false; window.clearInterval(t); window.removeEventListener("focus", pull); };
  }, [session, active, ms]);

  return state;
}

const SELF_IDLE_MS = 20_000;
const SELF_POLL_MS = 60_000;
const SHELL_WAIT_MS = 3_000;
const SELF_MAX_TRIES = 2;
const SELF_KEY = "figure-widget:selfupdate";
const FIELD_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

const selfTestMs = (() => {
  try {
    if (!navigator.webdriver) return 0;
    const v = Number(new URLSearchParams(window.location.search).get("selfupdate"));
    return Number.isFinite(v) && v >= 50 ? v : 0;
  } catch { return 0; }
})();

/** the bytes this navigation actually received; 0 when the entry is unavailable, and then
 *  the landed-check is simply not made rather than guessed at */
const navBytes = (() => {
  try {
    const e = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    const n = e ? e.decodedBodySize : 0;
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch { return 0; }
})();

type SelfTries = { md5: string; n: number };

function readTries(): SelfTries | null {
  try {
    const raw = sessionStorage.getItem(SELF_KEY);
    if (!raw) return null;
    const t = JSON.parse(raw) as SelfTries;
    return t && typeof t.md5 === "string" && t.md5 && typeof t.n === "number" ? t : null;
  } catch { return null; }
}

/** cleared by writing an empty record, never by deleting a key */
function writeTries(t: SelfTries | null): void {
  try { sessionStorage.setItem(SELF_KEY, JSON.stringify(t || { md5: "", n: 0 })); } catch { /* privacy mode */ }
}

async function refreshShell(waitMs = SHELL_WAIT_MS): Promise<void> {
  const sw = typeof navigator === "undefined" ? undefined : navigator.serviceWorker;
  if (!sw) return;
  const work = (async () => {
    try {
      const reg = await sw.getRegistration();
      if (reg) { try { await reg.update(); } catch { /* offline */ } }
    } catch { /* nothing registered */ }
    const ctrl = sw.controller;
    if (!ctrl) return;
    await new Promise<void>((resolve) => {
      let done = false;
      const fin = () => { if (!done) { done = true; resolve(); } };
      try {
        const ch = new MessageChannel();
        ch.port1.onmessage = fin;
        ctrl.postMessage({ type: "all_in_one_academic-shell-refresh" }, [ch.port2]);
      } catch { fin(); }
    });
  })();
  await Promise.race([work, new Promise<void>((r) => { window.setTimeout(r, waitMs); })]);
}

/** this window is the IDE pane and nothing else */
const isPane = (() => {
  try { return /^\/w\/figure(?:\/s\/[A-Za-z0-9._-]{1,96})?\/?$/.test(window.location.pathname); } catch { return false; }
})();

export function usePaneSelfUpdate(busy: boolean): boolean {
  const [giveUp, setGiveUp] = useState(false);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const mine = useRef<{ md5: string; bytes: number } | null>(null);
  const acted = useRef(false);
  const gaveUpFor = useRef("");
  const lastAct = useRef(Date.now());

  useEffect(() => {
    if (!isPane) return;
    const mark = () => { lastAct.current = Date.now(); };
    const evs: (keyof WindowEventMap)[] = ["pointerdown", "pointermove", "wheel", "keydown", "input"];
    for (const e of evs) window.addEventListener(e, mark, true);
    return () => { for (const e of evs) window.removeEventListener(e, mark, true); };
  }, []);

  useEffect(() => {
    if (!isPane) return;
    let live = true;
    const idleMs = selfTestMs || SELF_IDLE_MS;
    const pollMs = selfTestMs || SELF_POLL_MS;

    const idle = (): boolean => {
      if (busyRef.current) return false;
      if (Date.now() - lastAct.current < idleMs) return false;
      try {
        if (document.querySelector("[data-var-detail], [data-table-detail], [data-start-detail], [data-cat-detail], [data-panel-profile='building'], [data-coding-unit], [data-coding-agreement], [data-reader-doc]")) return false;
        const a = document.activeElement as HTMLElement | null;
        if (a && (FIELD_TAGS.has(a.tagName) || a.isContentEditable || a.hasAttribute("data-panel-search"))) return false;
        if (searchTouched) {
          const boxes = Array.from(document.querySelectorAll<HTMLInputElement>("[data-panel-search]"));
          if (boxes.some((b) => (b.value || "").trim().length > 0)) return false;
        }
      } catch { return false; }
      return true;
    };

    const expose = (extra: Record<string, unknown>) => {
      if (!navigator.webdriver) return;
      const w = window as unknown as Record<string, unknown>;
      w.__aioaPane = { md5: mine.current?.md5 || "", bytes: mine.current?.bytes || 0, navBytes,
        tries: readTries(), reloading: acted.current, ...extra };
    };

    const landed = (bytes: number) => navBytes === 0 || bytes === 0 || navBytes === bytes;

    const check = async () => {
      if (!live || acted.current) return;
      let s: { bundle_md5?: string; bundle_bytes?: number } | null = null;
      try {
        const r = await window.fetch("/surface", { cache: "no-store", credentials: "same-origin" });
        if (!r.ok) return;
        s = (await r.json()) as { bundle_md5?: string; bundle_bytes?: number };
      } catch { return; }
      if (!live) return;
      const md5 = typeof s?.bundle_md5 === "string" ? s.bundle_md5 : "";
      const bytes = Number(s?.bundle_bytes) || 0;
      if (!md5) return;
      if (!mine.current) {
        mine.current = { md5, bytes };
        const t0 = readTries();
        if (t0 && t0.md5 === md5 && landed(bytes)) writeTries(null);   // the reload landed
      }
      const t = readTries();
      const aiming = !!t && t.md5 === md5 && t.n > 0;
      const newer = md5 !== mine.current.md5 || staleness().bundle;
      const stale = newer || (aiming && !landed(bytes));
      expose({ stale, newer, landed: landed(bytes), idle: idle() });
      if (!stale) return;
      if (gaveUpFor.current === md5) return;
      if (gaveUpFor.current) { gaveUpFor.current = ""; setGiveUp(false); }
      if (!idle()) return;
      const n = (t && t.md5 === md5 ? t.n : 0) + 1;
      if (n > SELF_MAX_TRIES) { gaveUpFor.current = md5; setGiveUp(true); expose({ stale, gaveUp: true }); return; }
      acted.current = true;
      writeTries({ md5, n });
      expose({ stale, reloading: true });
      await refreshShell();
      if (live) window.location.reload();
    };

    void check();
    const t = window.setInterval(() => { void check(); }, pollMs);
    const onFocus = () => { void check(); };
    window.addEventListener("focus", onFocus);
    return () => { live = false; window.clearInterval(t); window.removeEventListener("focus", onFocus); };
  }, []);

  return giveUp;
}

/* -------------------------------------------------------------------- small shared bits */

export type PaneSize = "xs" | "sm" | "md" | "lg" | "xl";
export const paneSizeOf = (w: number): PaneSize =>
  w < 380 ? "xs" : w < 600 ? "sm" : w < 900 ? "md" : w < 1300 ? "lg" : "xl";

export function usePaneSize(): PaneSize {
  const [size, setSize] = useState<PaneSize>(() => paneSizeOf(window.innerWidth));
  useEffect(() => {
    const on = () => setSize(paneSizeOf(window.innerWidth));
    on();
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return size;
}

/** how long ago, in the shortest form that is still true */
export const ago = (secs: number | null): string => {
  if (!secs) return "";
  const d = Math.max(0, Math.round(Date.now() / 1000 - secs));
  if (d < 90) return "just now";
  if (d < 5400) return Math.round(d / 60) + " min ago";
  if (d < 172800) return Math.round(d / 3600) + " h ago";
  return Math.round(d / 86400) + " d ago";
};

/** 2114 -> "2,114"; null -> "—" */
export const nfmt = (n: number | null, dash = "—"): string =>
  n === null || !Number.isFinite(n) ? dash : Math.round(n).toLocaleString("en-US");

/** a number with enough precision to be worth reading, never a wall of decimals */
export const sig = (n: number | null): string => {
  if (n === null || !Number.isFinite(n)) return "—";
  const a = Math.abs(n);
  if (a === 0) return "0";
  if (a >= 1000) return Math.round(n).toLocaleString("en-US");
  if (a >= 10) return n.toFixed(1);
  if (a >= 1) return n.toFixed(2);
  return n.toPrecision(2);
};

/** search tokens: lowercase, whitespace-split, deduped. A row must match them ALL. */
export const toks = (q: string): string[] =>
  Array.from(new Set(q.toLowerCase().split(/\s+/).map((t) => t.trim()).filter(Boolean)));
