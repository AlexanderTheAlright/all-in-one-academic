
import { TASKS_BOARD } from "@/lib/paths";
import { api } from "@/lib/api";
import type { ProjectPlan, DraftDoc, DraftComment, DraftingPaper } from "@/lib/api";
import * as bc from "./boardcache";
import { apiKey, type ApiOpts } from "./hooks";
import { idleResident } from "./resident";
import { withPark } from "./netcache";
import { loadCiteIndex } from "./citeIndex";

// reproduced so `() => api.board(MASTER)` is the same text as in CalendarMonth.tsx
const MASTER = TASKS_BOARD;
// the month window the calendar asks for on a fresh mount
const isoOf = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

type Job = {
  view: string;
  /** the thunk, verbatim from the call site where one exists */
  run: () => Promise<unknown>;
  /** deps as the call site passes them, for the cache key */
  deps: unknown[];
  
  w: number;
};

const T = 800;
const j = (view: string, run: () => Promise<unknown>, w = T, deps: unknown[] = []): Job =>
  ({ view, run, deps, w });

const MANIFEST: Job[] = [
  // ---- today
  j("today", () => api.daily()),
  j("today", () => api.routines(), 6_800),
  j("today", () => api.dailyRecent(6)),
  j("today", () => api.canon()),

  // ---- learning
  j("learning", () => api.learning(), 13_000),

  // ---- calendar (CalendarMonth.tsx)
  j("calendar", () => api.timeline()),
  j("calendar", () => api.board(MASTER)),
  j("calendar", () => api.boardProposals()),
  j("calendar", () => api.projects(), 8_600),
  j("calendar", () => api.projectPlans().catch(() => [] as ProjectPlan[])),
  // CalendarMonth closes over `cursor`; the key cannot match, the park can
  j("calendar", () => {
    const now = new Date();
    return api.events(
      isoOf(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
      isoOf(new Date(now.getFullYear(), now.getMonth() + 2, 0)),
    );
  }, 3_900),

  // ---- drafting (all six gate the view together)
  j("drafting", () => api.draftingPapers(), 28_000),
  j("drafting", () => api.draftingPresentations()),
  j("drafting", () => api.draftingReports()),
  j("drafting", () => api.draftingGrants()),
  j("drafting", () => api.draftingMeasures()),
  j("drafting", () => api.draftingSyllabi()),
  j("drafting", () => loadCiteIndex(), 259_000),

  // ---- library
  j("library", () => api.vaultPath()),
  j("library", () => api.readingInbox()),

  j("notes", () => api.noteInbox(), 2_300, [0]),

  // ---- insights
  j("insights", () => api.insightsArchive()),

  j("reading", () => api.reading(), 2_070_000),
];

/** A job bigger than this waits for proof the link can carry it. */
const BIG = 250_000;
/** Below this observed throughput the big jobs are dropped rather than fought over. */
const MIN_BPS = 200_000;

const stats = { queued: 0, ran: 0, ok: 0, failed: 0, skippedBig: 0, skippedFresh: 0,
  chunksWarmed: 0, chunksWaitedMs: 0, keys: 0, started: false };
let active = 0;
let queue: Job[] = [];
let seenBytes = 0, seenMs = 0;

export function prefetchStats() { return { ...stats, pending: queue.length, active }; }

const idle = (fn: () => void) =>
  (typeof (window as unknown as { requestIdleCallback?: unknown }).requestIdleCallback === "function"
    ? (window as unknown as { requestIdleCallback: (f: () => void, o?: { timeout: number }) => void })
        .requestIdleCallback(fn, { timeout: 2_000 })
    : setTimeout(fn, 60));

type Conn = { saveData?: boolean; effectiveType?: string };
const conn = (): Conn => ((navigator as unknown as { connection?: Conn }).connection || {});

function linkIsFat(): boolean {
  const et = conn().effectiveType;
  if (et === "slow-2g" || et === "2g" || et === "3g") return false;
  if (!seenMs) return navFat();
  return (seenBytes / seenMs) * 1000 >= MIN_BPS;
}

function navFat(): boolean {
  try {
    const n = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    if (!n || !n.transferSize || !(n.responseEnd > n.responseStart)) return false;
    return (n.transferSize / (n.responseEnd - n.responseStart)) * 1000 >= MIN_BPS;
  } catch { return false; }
}

export function startPrefetch(currentView?: string): void {
  if (stats.started) return;
  stats.started = true;
  // Data Saver is an explicit "do not spend my bytes": honour it and do nothing.
  if (conn().saveData) return;
  if (idleResident()) return;
  queue = MANIFEST.filter((x) => x.view !== currentView).sort((a, b) => a.w - b.w);
  stats.queued = queue.length;
  pump();
  warmChunks(currentView);
}

function warmChunks(currentView?: string): void {
  if (typeof document === "undefined") return;
  // the import map the build emits names every chunk; that is the authority on their URLs,
  // not a guess at their filenames
  const map = document.querySelector('script[type="importmap"]');
  if (!map?.textContent) return;
  let urls: string[] = [];
  try {
    const parsed = JSON.parse(map.textContent) as { imports?: Record<string, string> };
    urls = Object.values(parsed.imports || {}).filter((u) => typeof u === "string" && u.endsWith(".js"));
  } catch { return; }
  if (!urls.length) return;
  
  const POLL_MS = 400;
  const MAX_WAIT_MS = 60_000;
  const started = Date.now();
  const whenIdle = () => {
    const busy = queue.length > 0 || active > 0;
    if (busy && Date.now() - started < MAX_WAIT_MS) { window.setTimeout(whenIdle, POLL_MS); return; }
    stats.chunksWaitedMs = Date.now() - started;
    idle(() => {
      // a plain GET: the service worker stores it under the same URL the dynamic import
      // will ask for, so the real open is a cache hit rather than a second download
      const all = urls.map((u) => fetch(u, { credentials: "same-origin" })
        .then((r) => r.arrayBuffer()).catch(() => { /* offline: the open still works */ }));
      stats.chunksWarmed = urls.length;
      void Promise.allSettled(all);
    });
  };
  window.setTimeout(whenIdle, POLL_MS);
  void currentView;
}

const FRESH_MS = 120_000;

function pump() {
  while (active < 2 && queue.length) {
    const job = queue.shift()!;
    if (job.w > BIG && !linkIsFat()) { stats.skippedBig++; continue; }
    const have = bc.at(bc.keyFor(job.run, job.deps));
    if (have !== null && Date.now() - have < FRESH_MS) { stats.skippedFresh++; continue; }
    active++;
    idle(() => runJob(job));
  }
}

function runJob(job: Job) {
  const key = bc.keyFor(job.run, job.deps);
  const t0 = Date.now();
  let p: Promise<unknown>;
  try { p = withPark(() => job.run()); }
  catch { active--; stats.failed++; pump(); return; }
  stats.ran++;
  p.then((v) => {
    stats.ok++;
    seenBytes += job.w; seenMs += Math.max(1, Date.now() - t0);
    if (key) { bc.prime(key, v); stats.keys++; }
  }).catch(() => {
    // a prefetch is never an error the user sees
    stats.failed++;
  }).then(() => { active--; pump(); });
}

/** THE fetcher for a manuscript. One function, so one source text, so one cache key. */

export const draftDocFetcher = (slug: string, doc: string) => () => api.draftingDocLite(slug, doc);
/** The boardcache key of a manuscript: exactly what useApi(draftDocFetcher(slug, doc), [slug, doc]) computes. */
export const draftDocKey = (slug: string, doc: string): bc.CacheKey | null => apiKey(draftDocFetcher(slug, doc), [slug, doc]);

export const DRAFT_TRUST_MS = 30 * 60_000;
/** useApi options for the loader's document call: no refetch on focus (the tick covers it),
 *  no refetch on a mount inside the trust window, and a read never overwrites a newer save. */
export const DRAFT_DOC_API: ApiOpts = { focus: false, trustMs: DRAFT_TRUST_MS, yieldToNewer: true };

const STAMPS_KEY = "all_in_one_academic-draft-stamps";
const STAMPS_MAX = 80;
type Stamp = { p?: number; e?: number };
const stampId = (slug: string, doc: string) => slug + "\u0001" + doc;

function readStamps(): Record<string, Stamp> {
  try {
    const v = JSON.parse(localStorage.getItem(STAMPS_KEY) || "{}") as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, Stamp>) : {};
  } catch { return {}; }
}
function writeStamps(all: Record<string, Stamp>): void {
  try {
    const ids = Object.keys(all);
    // insertion order is age: the oldest go first
    for (const id of ids.slice(0, Math.max(0, ids.length - STAMPS_MAX))) delete all[id];
    localStorage.setItem(STAMPS_KEY, JSON.stringify(all));
  } catch { /* quota / privacy: the in-session cache is still right */ }
}
function setStamp(slug: string, doc: string, which: "paper" | "editor", mtime: number): void {
  const all = readStamps(), id = stampId(slug, doc);
  const cur = all[id] || {};
  delete all[id];                                    // re-insert: most recent last
  all[id] = which === "paper" ? { ...cur, p: mtime } : { ...cur, e: mtime };
  writeStamps(all);
}

const goodPart = (text: unknown, mtime: unknown): boolean =>
  typeof text === "string" && typeof mtime === "number" && Number.isFinite(mtime);

/** A part of a document as ONE server response confirmed it: the text and the mtime of the
 *  same answer. Call it for nothing else. */
export function cacheDraftPart(slug: string, doc: string, which: string, text: string, mtime: number): void {
  if ((which !== "paper" && which !== "editor") || !goodPart(text, mtime)) return;
  setStamp(slug, doc, which, mtime);
  const key = draftDocKey(slug, doc);
  const cur = bc.peek(key) as DraftDoc | null;
  if (!cur || !cur[which]) return;                   // nothing cached: the next open asks
  const part = cur[which];
  if (part.text === text && part.mtime === mtime) return;
  bc.put(key, { ...cur, [which]: { ...part, text, mtime } });
}

export function cacheDraftComments(slug: string, doc: string, comments: DraftComment[], mtime: number, version: string, unheld: number | null = null): void {
  if (!Array.isArray(comments) || typeof mtime !== "number" || !Number.isFinite(mtime)) return;
  const key = draftDocKey(slug, doc);
  const cur = bc.peek(key) as DraftDoc | null;
  if (!cur) return;
  const base = { ...(cur.comments || { ok: true }) };
  delete base.resolvedOmitted;
  if (unheld === null) { bc.put(key, { ...cur, comments: { ...base, comments, mtime, version } }); return; }
  const open = comments.filter((c) => !c.resolved);
  bc.put(key, { ...cur, comments: { ...base, comments: open, mtime, version, resolvedOmitted: Math.max(0, unheld) + (comments.length - open.length) } });
}

const RESOLVED_MAX = 6;
const resolvedHalf = new Map<string, { version: string; comments: DraftComment[] }>();
export function rememberResolved(slug: string, doc: string, version: string, comments: DraftComment[]): void {
  const id = stampId(slug, doc);
  resolvedHalf.delete(id);
  if (!version) return;
  resolvedHalf.set(id, { version, comments });
  while (resolvedHalf.size > RESOLVED_MAX) resolvedHalf.delete(resolvedHalf.keys().next().value as string);
}
export function recallResolved(slug: string, doc: string, version: string): DraftComment[] | null {
  const e = resolvedHalf.get(stampId(slug, doc));
  return e && version && e.version === version ? e.comments : null;
}

/** Forget a document's cached copy; its next open asks the server. `now` persists that
 *  before returning (a page about to unload). */
export function dropDraft(slug: string, doc: string, now = false): void {
  bc.remove(draftDocKey(slug, doc), now);
}

/** Called by the loader BEFORE it reads the cache: drop a copy that is older than a save
 *  some window had confirmed. True when it dropped one. */
export function dropSupersededDraft(slug: string, doc: string): boolean {
  const key = draftDocKey(slug, doc);
  const cur = bc.peek(key) as DraftDoc | null;
  if (!cur || !cur.paper) return false;
  const all = readStamps(), id = stampId(slug, doc), st = all[id];
  if (!st) return false;
  const older = (typeof st.p === "number" && cur.paper.mtime < st.p)
    || (typeof st.e === "number" && !!cur.editor && cur.editor.mtime < st.e);
  if (!older) return false;
  bc.remove(key);
  // the next thing cached is a fresh read, which is the truth even if its stamp is older
  delete all[id];
  writeStamps(all);
  draftStats.superseded++;
  return true;
}

const HOLD_MAX_MS = 8_000;
const holds = new Map<string, Promise<void>>();

export function holdDraft(slug: string, doc: string, saving: Promise<unknown>): void {
  const id = stampId(slug, doc);
  const prev = holds.get(id);
  let timer = 0;
  const capped = new Promise<void>((resolve) => {
    timer = window.setTimeout(() => { dropDraft(slug, doc); draftStats.holdTimeouts++; resolve(); }, HOLD_MAX_MS);
    const done = () => { window.clearTimeout(timer); resolve(); };
    saving.then(done, done);
  });
  const all: Promise<void> = (prev ? Promise.all([prev, capped]).then(() => undefined) : capped)
    .then(() => { if (holds.get(id) === all) holds.delete(id); });
  holds.set(id, all);
  draftStats.holds++;
}
/** The save an open of this document must wait for, or null. */
export function draftHeld(slug: string, doc: string): Promise<void> | null {
  return holds.get(stampId(slug, doc)) ?? null;
}

/* ---- recents: the documents opened last, newest first. The library keeps pins and file
 * mtimes but no record of what was OPENED, which is what predicts the next switch. */
const MRU_KEY = "all_in_one_academic-draft-mru";
const MRU_MAX = 8;
export type DraftRef = { slug: string; doc: string; /** a project document or the notes page: its GET never writes a sidecar */ pd?: boolean };

export function recentDrafts(): DraftRef[] {
  try {
    const v = JSON.parse(localStorage.getItem(MRU_KEY) || "[]") as unknown;
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is DraftRef => !!x && typeof x === "object" && typeof (x as DraftRef).slug === "string" && typeof (x as DraftRef).doc === "string")
      .map((x) => ({ slug: x.slug, doc: x.doc, pd: x.pd === true }));
  } catch { return []; }
}
export function noteDraftOpened(slug: string, doc: string, pd: boolean): void {
  try {
    const rest = recentDrafts().filter((x) => !(x.slug === slug && x.doc === doc));
    localStorage.setItem(MRU_KEY, JSON.stringify([{ slug, doc, pd }, ...rest].slice(0, MRU_MAX)));
  } catch { /* quota / privacy */ }
}

const DRAFT_PF_OPT_IN = (() => {
  try {
    if (!navigator.webdriver) return true;
    const q = new URLSearchParams(window.location.search);
    return q.get("prefetch") === "1" || q.get("sw") === "1";
  } catch { return false; }
})();
/** a keystroke means a save is about to want the link: wait this long after the last one */
const DRAFT_QUIET_MS = 4_000;
const DRAFT_XHR_MS = 60_000;

type DraftJob = DraftRef & { owner: number };
const draftStats = { queued: 0, ran: 0, ok: 0, failed: 0, skippedFresh: 0, skippedNoEditor: 0,
  cancelled: 0, yielded: 0, superseded: 0, holds: 0, holdTimeouts: 0, bytes: 0 };
let draftQueue: DraftJob[] = [];
let draftCur: { job: DraftJob; xhr: XMLHttpRequest } | null = null;
let draftWaiting = false;
let draftOwnerSeq = 0;
let lastKeyAt = 0;
let keyWatch = false;

let editorRows: Set<string> | null = null;
let draftDeferred: DraftJob[] = [];

export function noteDraftRows(rows: Pick<DraftingPaper, "slug" | "doc" | "hasEditor">[]): void {
  const out = new Set<string>();
  for (const r of rows) if (r && r.hasEditor && r.slug && r.doc) out.add(stampId(r.slug, r.doc));
  editorRows = out;
  if (draftDeferred.length) { draftQueue = [...draftDeferred, ...draftQueue]; draftDeferred = []; draftKick(); }
}

export function primeDrafts(list: DraftRef[]): () => void {
  if (!DRAFT_PF_OPT_IN || typeof window === "undefined") return () => {};
  if (conn().saveData || idleResident()) return () => {};
  const owner = ++draftOwnerSeq;
  const seen = new Set([...draftQueue, ...draftDeferred].map((x) => stampId(x.slug, x.doc)));
  if (draftCur) seen.add(stampId(draftCur.job.slug, draftCur.job.doc));
  for (const x of list) {
    if (!x || !x.slug || !x.doc) continue;
    const id = stampId(x.slug, x.doc);
    if (seen.has(id)) continue;
    seen.add(id);
    draftQueue.push({ slug: x.slug, doc: x.doc, pd: x.pd === true, owner });
    draftStats.queued++;
  }
  if (!keyWatch) {
    keyWatch = true;
    window.addEventListener("keydown", () => { lastKeyAt = Date.now(); }, { capture: true, passive: true });
  }
  draftKick();
  return () => {
    const before = draftQueue.length + draftDeferred.length;
    draftQueue = draftQueue.filter((x) => x.owner !== owner);
    draftDeferred = draftDeferred.filter((x) => x.owner !== owner);
    draftStats.cancelled += before - draftQueue.length - draftDeferred.length;
    if (draftCur && draftCur.job.owner === owner) {
      draftStats.cancelled++;
      try { draftCur.xhr.abort(); } catch { /* already done */ }
    }
  };
}

function draftKick(): void {
  if (draftCur || draftWaiting || !draftQueue.length) return;
  draftWaiting = true;
  const quiet = Date.now() - lastKeyAt;
  if (quiet < DRAFT_QUIET_MS) {
    window.setTimeout(() => { draftWaiting = false; draftKick(); }, DRAFT_QUIET_MS - quiet + 50);
    return;
  }
  idle(() => { draftWaiting = false; draftRun(); });
}

function draftRun(): void {
  if (draftCur) return;
  let job: DraftJob | undefined;
  while ((job = draftQueue.shift())) {
    const key = draftDocKey(job.slug, job.doc);
    if (!key) continue;
    if (bc.freshInSession(key, DRAFT_TRUST_MS)) { draftStats.skippedFresh++; continue; }
    if (!job.pd) {
      if (!editorRows) { draftDeferred.push(job); continue; }
      if (!editorRows.has(stampId(job.slug, job.doc))) { draftStats.skippedNoEditor++; continue; }
    }
    break;
  }
  if (!job) return;
  if (Date.now() - lastKeyAt < DRAFT_QUIET_MS) { draftQueue.unshift(job); draftKick(); return; }
  const j = job;
  const key = draftDocKey(j.slug, j.doc);
  const rev0 = bc.rev(key);
  const xhr = new XMLHttpRequest();
  draftCur = { job: j, xhr };
  draftStats.ran++;
  xhr.open("GET", "/drafting/doc?slug=" + encodeURIComponent(j.slug) + "&doc=" + encodeURIComponent(j.doc) + "&lite=1");
  xhr.responseType = "text";
  xhr.timeout = DRAFT_XHR_MS;
  xhr.onload = () => {
    try {
      if (xhr.status !== 200) { draftStats.failed++; return; }
      const d = JSON.parse(xhr.responseText) as DraftDoc;
      if (!d || d.error || !d.paper || !goodPart(d.paper.text, d.paper.mtime)) { draftStats.failed++; return; }
      draftStats.bytes += xhr.responseText.length;
      if (bc.rev(key) !== rev0) { draftStats.yielded++; return; }
      bc.prime(key, d);
      draftStats.ok++;
    } catch { draftStats.failed++; }
  };
  xhr.onerror = () => { draftStats.failed++; };
  xhr.ontimeout = () => { draftStats.failed++; };
  xhr.onloadend = () => { if (draftCur && draftCur.xhr === xhr) draftCur = null; draftKick(); };
  try { xhr.send(); } catch { draftStats.failed++; draftCur = null; draftKick(); }
}

export function draftPrefetchStats() {
  return { ...draftStats, pending: draftQueue.length, deferred: draftDeferred.length, rowsKnown: !!editorRows, active: draftCur ? draftCur.job.slug + "/" + draftCur.job.doc : "", on: DRAFT_PF_OPT_IN };
}

try {
  (window as unknown as { __aioaPrefetch?: unknown }).__aioaPrefetch = { stats: prefetchStats, drafts: draftPrefetchStats };
} catch { /* no window */ }
