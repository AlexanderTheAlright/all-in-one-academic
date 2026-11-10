

export type CacheKey = string;
type Entry = { v: unknown; at: number };

const SCHEMA = "all_in_one_academic-boardcache/1";
const LS_KEY = "all_in_one_academic-boardcache";
/** per-entry ceiling for the localStorage tier; bigger values stay in memory for the session */
const MAX_ENTRY = 128 * 1024;

const BIG_KEYS = ["draftingDoc"];
const BIG_ENTRY = 320 * 1024;
const capFor = (key: string) => (BIG_KEYS.some((k) => key.includes(k)) ? BIG_ENTRY : MAX_ENTRY);
/** total localStorage budget, least-recently-used first out */
const MAX_TOTAL = 3 * 1024 * 1024;
/** trailing flush, so a poll storm writes once rather than once per response */
const FLUSH_MS = 400;

const mem = new Map<CacheKey, Entry>();

const stats = {
  hit: 0, miss: 0, put: 0, primed: 0, hydrated: 0, flushes: 0,
  /** keys a prefetch primed that a useApi later read back — the proof the manifest keys match */
  prefetchHit: 0,
};
const primedKeys = new Set<CacheKey>();

const revs = new Map<CacheKey, number>();

const sizes = new Map<CacheKey, number>();
const touch = (key: CacheKey) => { revs.set(key, (revs.get(key) ?? 0) + 1); sizes.delete(key); };

// ---------------------------------------------------------------- hydration

(function hydrate() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const blob = JSON.parse(raw) as { schema?: string; entries?: [string, Entry][] };
    // a schema bump discards the old blob instead of crashing on a changed shape
    if (!blob || blob.schema !== SCHEMA || !Array.isArray(blob.entries)) {
      try { localStorage.setItem(LS_KEY, ""); } catch { /* ignore */ }
      return;
    }
    for (const pair of blob.entries) {
      if (!Array.isArray(pair) || pair.length !== 2) continue;
      const [k, e] = pair;
      if (typeof k !== "string" || !e || typeof e.at !== "number") continue;
      mem.set(k, { v: e.v, at: e.at });
    }
    stats.hydrated = mem.size;
  } catch {
    /* private window, cleared site data, quota error on read — the Map just starts empty */
  }
})();

// ---------------------------------------------------------------- keys

/** Deps must be primitives to make a stable key. Anything else (an object, a function)
 *  would collapse to the same text for different values, so we refuse to cache it. */
function depsKey(deps: unknown[]): string | null {
  if (!Array.isArray(deps)) return null;
  const out: string[] = [];
  for (const d of deps) {
    if (d === null) { out.push("null"); continue; }
    const t = typeof d;
    if (t === "undefined") out.push("u");
    else if (t === "string") out.push(JSON.stringify(d));
    else if (t === "number" || t === "boolean") out.push(String(d));
    else return null;
  }
  return "[" + out.join(",") + "]";
}

export function keyFor(fetcher: unknown, deps: unknown[]): CacheKey | null {
  if (typeof fetcher !== "function") return null;
  const d = depsKey(deps);
  if (d === null) return null;
  let src: string;
  try { src = Function.prototype.toString.call(fetcher); } catch { return null; }
  if (!src || src.length > 4000) return null;   // a huge inline fetcher is not worth a key
  return moduleNeutral(src) + "|" + d;
}

const API_REF = /(^|[^\w$.])[A-Za-z_$][\w$]*\.(api)\./g;
const CALLED_IMPORT = /\(0,\s*[A-Za-z_$][\w$]*\.([A-Za-z_$][\w$]*)\)/g;
function moduleNeutral(src: string): string {
  return src.replace(API_REF, "$1$2.").replace(CALLED_IMPORT, "(0,$1)");
}

// ---------------------------------------------------------------- read / write

export function get(key: CacheKey | null): unknown {
  if (!key) return null;
  const e = mem.get(key);
  if (!e) { stats.miss++; return null; }
  stats.hit++;
  if (primedKeys.delete(key)) stats.prefetchHit++;
  // touch: re-insert so Map order is least-recently-used first
  mem.delete(key); mem.set(key, e);
  return e.v;
}

/** The value, without counting a hit, consuming a prefetch mark or touching the LRU order:
 *  for code that patches or inspects an entry rather than rendering from it. */
export function peek(key: CacheKey | null): unknown {
  const e = key ? mem.get(key) : undefined;
  return e ? e.v : null;
}

export function has(key: CacheKey | null): boolean { return !!key && mem.has(key); }
/** how many times this key was written or removed in this session (0 = hydrated or absent) */
export function rev(key: CacheKey | null): number { return key ? revs.get(key) ?? 0 : 0; }
/** written in THIS session, less than `ms` ago. Never true for a hydrated copy. */
export function freshInSession(key: CacheKey | null, ms: number): boolean {
  if (!key || !revs.get(key)) return false;
  const e = mem.get(key);
  return !!e && Date.now() - e.at < ms;
}
export function at(key: CacheKey | null): number | null {
  const e = key ? mem.get(key) : undefined;
  return e ? e.at : null;
}

export function put(key: CacheKey | null, value: unknown): void {
  if (!key) return;
  stats.put++;
  mem.delete(key);
  mem.set(key, { v: value, at: Date.now() });
  touch(key);
  schedule();
}

export function remove(key: CacheKey | null, now = false): void {
  if (!key) return;
  const had = mem.delete(key);
  primedKeys.delete(key);
  touch(key);
  if (!had) return;
  if (now) flushNow(); else schedule();
}

/** A prefetched value. Same store; recorded separately so QA can prove the keys match. */
export function prime(key: CacheKey | null, value: unknown): void {
  if (!key) return;
  stats.primed++;
  primedKeys.add(key);
  put(key, value);
}

// ---------------------------------------------------------------- persistence

let timer = 0;
function schedule() {
  if (timer) return;
  timer = (setTimeout(() => { timer = 0; flush(); }, FLUSH_MS) as unknown) as number;
}

/** Write the localStorage tier at once, dropping the debounce. */
export function flushNow(): void {
  if (timer) { clearTimeout(timer); timer = 0; }
  flush();
}

function flush() {
  try {
    const entries: [string, Entry][] = [];
    let total = 0;
    // Map order is LRU-first, so walk it backwards: most recent kept, oldest evicted.
    const all = Array.from(mem.entries());
    for (let i = all.length - 1; i >= 0; i--) {
      const [k, e] = all[i];
      let size = sizes.get(k);
      if (size === undefined) {
        let s: string | undefined;
        try { s = JSON.stringify(e.v); } catch { s = undefined; }
        size = typeof s === "string" ? s.length + k.length + 32 : Infinity;
        sizes.set(k, size);
      }
      if (size > capFor(k)) continue;            // memory-only for the session
      if (total + size > MAX_TOTAL) break;       // budget reached: the rest is evicted
      total += size;
      entries.push([k, e]);
    }
    localStorage.setItem(LS_KEY, JSON.stringify({ schema: SCHEMA, at: Date.now(), entries }));
    stats.flushes++;
  } catch {
    /* quota exceeded / privacy mode: the memory tier still works for this session */
  }
}

try {
  window.addEventListener("pagehide", () => { if (timer) flushNow(); });
} catch { /* no window */ }

// ---------------------------------------------------------------- staleness

export type Staleness = {
  /** something on screen is a cached value whose revalidation has not landed (or failed) */
  stale: boolean;
  /** the last revalidation of something on screen FAILED */
  failed: boolean;
  /** a newer bundle is on the server (the service worker saw a 200, we never auto-reload) */
  bundle: boolean;
  /** age of the OLDEST displayed cached entry, ms */
  ageMs: number;
};

type LiveState = { at: number; settled: boolean; failed: boolean };
const live = new Map<string, LiveState>();
const subs = new Set<() => void>();
let bundleStale = false;
let snap: Staleness = { stale: false, failed: false, bundle: false, ageMs: 0 };
let tick = 0;

export function staleness(): Staleness { return snap; }

export function subscribe(fn: () => void): () => void {
  subs.add(fn);
  if (!tick) tick = (setInterval(recompute, 15_000) as unknown) as number;
  return () => {
    subs.delete(fn);
    if (!subs.size && tick) { clearInterval(tick); tick = 0; }
  };
}

function recompute() {
  let stale = false, failed = false, oldest = 0;
  for (const s of live.values()) {
    if (s.settled && !s.failed) continue;
    stale = true;
    if (s.failed) failed = true;
    if (!oldest || s.at < oldest) oldest = s.at;
  }
  const ageMs = oldest ? Date.now() - oldest : 0;
  const next: Staleness = { stale, failed, bundle: bundleStale, ageMs };
  const changed = next.stale !== snap.stale || next.failed !== snap.failed
    || next.bundle !== snap.bundle || Math.abs(next.ageMs - snap.ageMs) >= 1000;
  if (!changed) return;
  snap = next;
  for (const f of Array.from(subs)) { try { f(); } catch { /* a bad subscriber never blocks */ } }
}

/** A hook is showing a cached value and has a revalidation in flight. */
export function pending(id: string, since: number): void {
  live.set(id, { at: since, settled: false, failed: false });
  recompute();
}
/** That revalidation landed (ok) or failed. */
export function settle(id: string, ok: boolean): void {
  const s = live.get(id);
  if (!s) return;
  s.settled = true; s.failed = !ok;
  if (ok) live.delete(id);
  recompute();
}
export function drop(id: string): void {
  if (live.delete(id)) recompute();
}
/** The service worker saw a newer bundle. We never auto-reload — the dot says so instead. */
export function noteBundleUpdate(): void {
  if (bundleStale) return;
  bundleStale = true;
  recompute();
}

// ---------------------------------------------------------------- QA surface

export function cacheStats() {
  return { ...stats, entries: mem.size, live: live.size, snap };
}

try {
  (window as unknown as { __aioaCache?: unknown }).__aioaCache = {
    stats: cacheStats, get, has, keyFor, staleness, peek, rev, at,
    keys: () => Array.from(mem.keys()),
  };
} catch { /* no window (SSR-ish build step) */ }
