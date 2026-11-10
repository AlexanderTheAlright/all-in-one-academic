/* Shared hooks: SWR-like data fetch, persistent state, keyboard shortcuts. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as bc from "./boardcache";
import { withSignal } from "./netcache";
import { idleResident } from "./resident";

/** One in-flight request per cache key, shared by every hook asking for it. Refcounted so
 *  the underlying fetch is aborted only when the LAST waiter unmounts. */
type Shared = { p: Promise<unknown>; ac: AbortController; n: number };
const shared = new Map<string, Shared>();
let hookSeq = 0;

const isAbort = (e: unknown) =>
  !!e && typeof e === "object" && (e as { name?: string }).name === "AbortError";

/** Once per summon: a chord firing `focus` should revalidate, a flurry of focus events
 *  should not. */
const FOCUS_MIN_MS = 3_000;

const BLURRED_FLOOR_MS = 5 * 60_000;
let lastBlurredPoll = 0;
let isBlurred = false;
if (typeof window !== "undefined") {
  window.addEventListener("blur", () => { isBlurred = true; });
  window.addEventListener("focus", () => { isBlurred = false; });
}
const blurred = () => isBlurred;

export const apiKey = (fetcher: unknown, deps: unknown[] = []): bc.CacheKey | null => bc.keyFor(fetcher, deps);

/** Opt-outs for a call site whose data has its own, cheaper change detector. Every default
 *  is the behaviour useApi has always had. */
export type ApiOpts = {
  /** false: a window focus does not refetch */
  focus?: boolean;
  
  trustMs?: number;
  /** an answer never replaces an entry that was written after its request left: the
   *  writer (a confirmed save) is newer than the read */
  yieldToNewer?: boolean;
};

export function useApi<T>(fetcher: () => Promise<T>, deps: unknown[] = [], pollMs = 0, opts?: ApiOpts): {
  data: T | null; error: unknown; loading: boolean; reload: () => void; set: (t: T) => void;
} {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const key = useMemo(() => apiKey(fetcher, deps), deps);
  const optsRef = useRef(opts); optsRef.current = opts;
  const seenN = useRef(0);
  const idRef = useRef("");
  if (!idRef.current) idRef.current = "a" + ++hookSeq;

  const [data, set] = useState<T | null>(() => (bc.get(key) as T | null));
  const [error, setErr] = useState<unknown>(null);
  const [n, bump] = useState(0);
  const live = useRef(true);

  // A dep change asks for a DIFFERENT resource, so swap to that key's last-good (or to
  // null, a genuine cold start for it). This is the render-phase derived-state pattern.
  const [seenKey, setSeenKey] = useState(key);
  if (seenKey !== key) {
    setSeenKey(key);
    set(bc.get(key) as T | null);
    setErr(null);
  }

  const reload = useCallback(() => bump((x) => x + 1), []);

  useEffect(() => {
    live.current = true;
    setErr(null);
    const k = key;
    // reload(), a focus refetch and a poll all bump `n`; a mount or a dep change does not
    const asked = n !== seenN.current; seenN.current = n;
    const o = optsRef.current;
    if (!asked && o?.trustMs && bc.freshInSession(k, o.trustMs)) {
      return () => { live.current = false; };
    }
    const rev0 = bc.rev(k);
    const hadCache = bc.has(k);
    if (hadCache) bc.pending(idRef.current, bc.at(k) ?? Date.now());

    let rec: Shared | null = null;
    let p: Promise<unknown>;
    if (k) {
      const ex = shared.get(k);
      if (ex) { ex.n++; rec = ex; p = ex.p; }
      else {
        const ac = new AbortController();
        const fresh: Shared = { p: null as unknown as Promise<unknown>, ac, n: 1 };
        try {
          fresh.p = withSignal(ac.signal, () => fetcher() as Promise<unknown>)
            .then((d) => { if (shared.get(k) === fresh) shared.delete(k); return d; })
            .catch((e) => { if (shared.get(k) === fresh) shared.delete(k); throw e; });
        } catch (e) {
          fresh.p = Promise.reject(e);
        }
        shared.set(k, fresh);
        rec = fresh; p = fresh.p;
      }
    } else {
      p = fetcher() as Promise<unknown>;
    }

    p.then((d) => {
      if (o?.yieldToNewer && bc.rev(k) !== rev0) {
        if (hadCache) bc.settle(idRef.current, true);
        const cur = bc.peek(k);
        if (live.current) { set((cur ?? d) as T); setErr(null); }
        return;
      }
      bc.put(k, d);
      if (hadCache) bc.settle(idRef.current, true);
      if (live.current) { set(d as T); setErr(null); }
    }).catch((e) => {
      if (isAbort(e)) return;
      if (hadCache) bc.settle(idRef.current, false);
      if (!live.current) return;
      // a failure on top of a cached value keeps the value: the dot carries the bad news
      if (bc.has(k)) return;
      setErr(e);
    });

    return () => {
      live.current = false;
      bc.drop(idRef.current);
      if (rec && k) {
        const cur = shared.get(k);
        if (cur === rec && --rec.n <= 0) {
          shared.delete(k);
          try { rec.ac.abort(); } catch { /* already settled */ }
        } else if (cur !== rec) { rec.n--; }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  useEffect(() => {
    let last = 0;
    const h = () => {
      if (optsRef.current?.focus === false) return;
      const now = Date.now();
      if (now - last < FOCUS_MIN_MS) return;
      last = now;
      bump((x) => x + 1);
    };
    window.addEventListener("focus", h);
    return () => window.removeEventListener("focus", h);
  }, []);
  useEffect(() => {
    if (!pollMs) return;
    if (idleResident()) return;
    const id = setInterval(() => {
      if (document.hidden) return;                       // a genuinely hidden tab elsewhere
      if (!blurred()) return void bump((x) => x + 1);     // on screen: the view's own cadence
      const now = Date.now();
      if (now - lastBlurredPoll < BLURRED_FLOOR_MS) return;
      lastBlurredPoll = now;
      bump((x) => x + 1);
    }, pollMs);
    return () => clearInterval(id);
  }, [pollMs]);
  return { data, error, loading: data === null && error === null, reload, set };
}

/** localStorage-backed state. JSON-encoded. */
export function usePersistent<T>(key: string, init: T): [T, (v: T | ((p: T) => T)) => void] {
  const [v, set] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? init : (JSON.parse(raw) as T);
    } catch { return init; }
  });
  useEffect(() => {
    try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* quota / privacy */ }
  }, [key, v]);
  return [v, set];
}

/** Listen for a key combo and fire a handler. Disabled when typing in an input/textarea
 * unless `whenTyping` is true. */
export function useHotkey(
  combo: string,
  handler: (e: KeyboardEvent) => void,
  opts: { whenTyping?: boolean; deps?: unknown[] } = {}
) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (
        t.tagName === "INPUT" || t.tagName === "TEXTAREA" || (t as HTMLElement).isContentEditable
      );
      if (typing && !opts.whenTyping) return;
      if (matchCombo(combo, e)) { e.preventDefault(); handler(e); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [combo, ...(opts.deps || [])]);
}

function matchCombo(combo: string, e: KeyboardEvent) {
  // "mod+k" => ctrl/cmd + k. "g t" => g then t (we handle below). Plain "k" => k.
  const parts = combo.toLowerCase().split("+");
  const want = parts.pop()!;
  const mods = new Set(parts);
  if (mods.has("mod") !== (e.metaKey || e.ctrlKey)) return false;
  if (mods.has("shift") !== e.shiftKey) return false;
  if (mods.has("alt") !== e.altKey) return false;
  return e.key.toLowerCase() === want;
}

export function useLeader(leader: string, map: Record<string, () => void>) {
  const armed = useRef(false);
  useEffect(() => {
    let timer: number | null = null;
    const arm = () => {
      armed.current = true;
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => { armed.current = false; }, 1200);
    };
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === leader.toLowerCase() && !armed.current) { arm(); e.preventDefault(); return; }
      if (armed.current && map[k]) {
        e.preventDefault();
        map[k]();
        armed.current = false;
        if (timer) window.clearTimeout(timer);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (timer) window.clearTimeout(timer);
    };
  }, [leader, map]);
}
