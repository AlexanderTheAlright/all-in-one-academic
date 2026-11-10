

export const READ_ONLY_GETS: ReadonlySet<string> = new Set([
  // shell
  "/surface", "/dashboard-data.json", "/projects", "/today", "/activity", "/board",
  "/ambient", "/tags", "/glimpse", "/theme.json",
  "/daily", "/routines", "/daily/recent", "/canon",
  // learning
  "/learning",
  // calendar
  "/events", "/timeline", "/board/proposals", "/project/plans",
  "/project/proposal",
  // drafting
  "/drafting/papers", "/drafting/presentations", "/drafting/reports", "/drafting/grants",
  "/drafting/measures", "/drafting/syllabi", "/drafting/cite-index",
  "/drafting/corpus-search",
  "/drafting/doc",
  // reading / library / notes / insights
  "/reading", "/vault-path", "/reading/inbox/list", "/note/inbox", "/notes/all",
  "/insights/archive",
  "/w/figure/project",
  "/w/panel/dataset", "/w/panel/datasets", "/w/panel/variable", "/w/panel/tables", "/w/panel/table",
  "/w/panel/catalog", "/w/panel/dictionary",
  "/w/panel/scope",
  "/w/panel/coding/sets", "/w/panel/coding/agreement",
]);

/** How long a prefetched response may stand in for a live one. */
const HANDOFF_TTL = 10 * 60_000;

type Shared = { p: Promise<Response>; ac: AbortController; n: number };

const inflight = new Map<string, Shared>();
const handoff = new Map<string, { r: Response; at: number }>();

const stats = { deduped: 0, handed: 0, primed: 0, passthrough: 0, aborted: 0 };

let ambient: AbortSignal | null = null;
let parking = false;

/** Run `run` with an ambient abort signal attached to the fetch(es) it starts
 *  synchronously. useApi uses this; nothing else needs to. */
export function withSignal<T>(signal: AbortSignal, run: () => T): T {
  const prev = ambient;
  ambient = signal;
  try { return run(); } finally { ambient = prev; }
}

export function withPark<T>(run: () => T): T {
  const prev = parking;
  parking = true;
  try { return run(); } finally { parking = prev; }
}

/** pathname + search with the `?_=<timestamp>` cache-buster removed. 42 of lib/api.ts's
 *  GETs carry one; without stripping it every single request would be a miss. */
export function cacheKeyOf(href: string): { path: string; key: string } | null {
  try {
    const u = new URL(href, location.href);
    if (u.origin !== location.origin) return null;
    u.searchParams.delete("_");
    u.hash = "";
    const qs = u.searchParams.toString();
    return { path: u.pathname, key: u.pathname + (qs ? "?" + qs : "") };
  } catch { return null; }
}

/** Park a prefetched response so the component's own fetch resolves off it, once. */
export function primeResponse(href: string, r: Response): void {
  const k = cacheKeyOf(href);
  if (!k || !READ_ONLY_GETS.has(k.path)) return;
  if (r.status !== 200) return;
  handoff.set(k.key, { r, at: Date.now() });
  stats.primed++;
}

export function netStats() {
  return { ...stats, inflight: inflight.size, parked: handoff.size };
}

let installed = false;

export function installNetCache(): void {
  if (installed || typeof window === "undefined" || typeof window.fetch !== "function") return;
  installed = true;
  const orig = window.fetch.bind(window) as typeof fetch;

  window.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const sig = ambient;
    const park = parking;
    let href: string, method: string;
    try {
      if (typeof input === "string") { href = input; method = init?.method || "GET"; }
      else if (input instanceof URL) { href = input.href; method = init?.method || "GET"; }
      else { href = input.url; method = init?.method || input.method || "GET"; }
    } catch { return orig(input as RequestInfo, init); }
    method = method.toUpperCase();

    // never touch a write
    if (method !== "GET") return orig(input as RequestInfo, init);

    const k = cacheKeyOf(href);
    if (!k || !READ_ONLY_GETS.has(k.path)) { stats.passthrough++; return orig(input as RequestInfo, init); }

    // 1. a prefetched response standing ready, consumed once. A prefetch never eats
    //    another prefetch's park — the component it was warmed for must get it.
    if (!park) {
      const parked = handoff.get(k.key);
      if (parked) {
        handoff.delete(k.key);
        if (Date.now() - parked.at < HANDOFF_TTL) {
          stats.handed++;
          try { return Promise.resolve(parked.r.clone()); } catch { /* already consumed */ }
        }
      }
    }

    // 2. join a request already on the wire for this exact URL
    const cur = inflight.get(k.key);
    if (cur) {
      stats.deduped++;
      cur.n++;
      attachRelease(cur, k.key, sig);
      return cur.p.then((r) => { if (park) parkClone(k.key, r); return r.clone(); });
    }

    // 3. a fresh request, abortable once every waiter has let go
    const ac = new AbortController();
    const rec: Shared = { p: null as unknown as Promise<Response>, ac, n: 1 };
    rec.p = orig(input as RequestInfo, { ...(init || {}), signal: ac.signal })
      .then((r) => { if (inflight.get(k.key) === rec) inflight.delete(k.key); return r; })
      .catch((e) => { if (inflight.get(k.key) === rec) inflight.delete(k.key); throw e; });
    inflight.set(k.key, rec);
    attachRelease(rec, k.key, sig);
    return rec.p.then((r) => { if (park) parkClone(k.key, r); return r.clone(); });
  }) as typeof fetch;
}

function parkClone(key: string, r: Response) {
  if (!r || r.status !== 200) return;
  try { handoff.set(key, { r: r.clone(), at: Date.now() }); stats.primed++; } catch { /* consumed */ }
}

function attachRelease(rec: Shared, key: string, sig: AbortSignal | null) {
  if (!sig) return;                       // a caller with no signal never releases
  let done = false;
  const release = () => {
    if (done) return;
    done = true;
    if (--rec.n <= 0 && inflight.get(key) === rec) {
      inflight.delete(key);
      stats.aborted++;
      try { rec.ac.abort(); } catch { /* already settled */ }
    }
  };
  if (sig.aborted) { release(); return; }
  sig.addEventListener("abort", release, { once: true });
  // a settled request has nothing left to abort
  rec.p.then(() => { done = true; }, () => { done = true; });
}

try {
  (window as unknown as { __aioaNet?: unknown }).__aioaNet = { stats: netStats };
} catch { /* no window */ }
