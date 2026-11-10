
const warmed = new Set<string>();
const inflight = new Map<string, Promise<boolean>>();

/* The last few decoded images are held, so the bitmap is still decoded when the <img> asks
 * for it and a flip paints on the next frame rather than after a decode. */
const HOLD = 12;
const held: HTMLImageElement[] = [];

/** Fetch and decode one image. Resolves true once it is in the caches, false on any failure. */
export function warmImage(url: string): Promise<boolean> {
  if (!url || typeof Image === "undefined") return Promise.resolve(false);
  if (warmed.has(url)) return Promise.resolve(true);
  const have = inflight.get(url);
  if (have) return have;
  const p = new Promise<boolean>((res) => {
    try {
      const im = new Image();
      im.decoding = "async";
      im.src = url;
      im.decode().then(() => {
        warmed.add(url);
        held.push(im);
        if (held.length > HOLD) held.shift();
        res(true);
      }, () => res(false));
    } catch { res(false); }
  }).finally(() => { inflight.delete(url); });
  inflight.set(url, p);
  return p;
}


const fetched = new Set<string>();
const fetching = new Map<string, Promise<boolean>>();

export function fetchImage(url: string): Promise<boolean> {
  if (!url || typeof fetch !== "function") return Promise.resolve(false);
  if (fetched.has(url)) return Promise.resolve(true);
  const have = fetching.get(url);
  if (have) return have;
  const p = fetch(url, { credentials: "same-origin" })
    .then(async (r) => {
      if (!r.ok) return false;
      await r.arrayBuffer();                     // the whole body, so the worker's copy is whole
      fetched.add(url);
      return true;
    })
    .catch(() => false)
    .finally(() => { fetching.delete(url); });
  fetching.set(url, p);
  return p;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Resolves once the tab is visible (at once if it already is). */
function whenVisible(): Promise<void> {
  if (typeof document === "undefined" || document.visibilityState === "visible") return Promise.resolve();
  return new Promise((res) => {
    const on = () => {
      if (document.visibilityState !== "visible") return;
      document.removeEventListener("visibilitychange", on);
      res();
    };
    document.addEventListener("visibilitychange", on);
  });
}

export async function warmSeq(urls: string[], opts: {
  alive?: () => boolean; gapMs?: number; visibleOnly?: boolean; fetchOnly?: boolean;
} = {}): Promise<boolean> {
  const alive = opts.alive ?? (() => true);
  for (const u of urls) {
    if (!alive()) return false;
    if (opts.fetchOnly ? fetched.has(u) : warmed.has(u)) continue;
    if (opts.visibleOnly) await whenVisible();
    if (!alive()) return false;
    try { await (opts.fetchOnly ? fetchImage(u) : warmImage(u)); } catch { /* never an error */ }
    if (opts.gapMs) await sleep(opts.gapMs);
  }
  return alive();
}

/** requestIdleCallback where there is one */
export function whenIdle(fn: () => void): void {
  const w = window as unknown as { requestIdleCallback?: (f: () => void, o?: { timeout: number }) => void };
  if (typeof w.requestIdleCallback === "function") w.requestIdleCallback(fn, { timeout: 3_000 });
  else setTimeout(fn, 200);
}
