
import type { CiteHit, CiteQuote } from "./api";

/** the shipped record: short keys, because 3,404 rows multiply every byte of a key */
type Row = {
  n: string;            // stem
  a: string;            // author
  y: number | null;     // year
  t: string;            // title
  k: string;            // citekey
  f?: number;           // index into dirs (absent when r is present)
  r?: string;           // whole rel, for a record outside the known dirs
  d?: string;           // kind; absent means "citation"
  g?: number[];         // interned tag ids
  s?: string;           // source url (clippings)
  q?: number;           // quote count
  p?: number;           // key-point count
  i?: string;
  x?: string;           // a/b letter for same-label same-year works
};
type Payload = { count: number; dirs: string[]; tagv: string[]; records: Row[]; ready?: boolean };

/** a record with its search surfaces precomputed once, at load */
type Entry = {
  rel: string; stem: string; kind: string; author: string; year: number | null;
  intext: string; suffix: string;
  title: string; citekey: string; source: string; tags: string[];
  nQuotes: number; nKeyPoints: number;
  // lowercase surfaces, built once. `hay` is everything, for the cheap reject.
  la: string; lt: string; lk: string; lg: string; ys: string; hay: string;
};

export type CiteIndexState = "idle" | "loading" | "ready" | "failed";

const INDEX_URL = "/drafting/cite-index";

let entries: Entry[] = [];
let state: CiteIndexState = "idle";
let loadStarted = 0;
let loadMs = 0;
let inflight: Promise<boolean> | null = null;
const listeners = new Set<(s: CiteIndexState) => void>();

const announce = (s: CiteIndexState) => {
  state = s;
  try { document.documentElement.dataset.citeIndex = s; } catch { /* no DOM in a test env */ }
  for (const fn of listeners) { try { fn(s); } catch { /* a listener must never break the load */ } }
};

/** subscribe to load-state changes; returns the unsubscribe */
export function onCiteIndex(fn: (s: CiteIndexState) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function citeIndexState(): CiteIndexState { return state; }
export function citeIndexStats() { return { state, count: entries.length, loadMs }; }

function shape(p: Payload): Entry[] {
  const dirs = p.dirs || [];
  const tagv = p.tagv || [];
  return (p.records || []).map((r) => {
    const rel = r.r ?? ((dirs[r.f ?? -1] ?? "") + "/" + r.n + ".md");
    const tags = (r.g || []).map((i) => tagv[i]).filter(Boolean);
    const author = r.a || "", title = r.t || "", citekey = r.k || "";
    const la = fold(author), lt = fold(title);
    const lk = fold(citekey), lg = fold(tags.join(" "));
    const ys = r.y == null ? "" : String(r.y);
    return {
      rel, stem: r.n, kind: r.d || "citation", author, year: r.y, title, citekey,
      intext: r.i || author, suffix: r.x || "",
      source: r.s || "", tags, nQuotes: r.q || 0, nKeyPoints: r.p || 0,
      la, lt, lk, lg, ys,
      // the whole searchable surface in one string: one indexOf rejects a record
      // before any of the per-field scoring runs
      hay: la + " " + ys + " " + lt + " " + lk + " " + lg,
    };
  });
}

export function loadCiteIndex(): Promise<boolean> {
  if (state === "ready") return Promise.resolve(true);
  if (inflight) return inflight;
  loadStarted = performance.now();
  announce("loading");
  inflight = fetch(INDEX_URL)
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error("cite-index " + r.status))))
    .then((p: Payload) => {
      entries = shape(p);
      loadMs = Math.round(performance.now() - loadStarted);
      announce(entries.length ? "ready" : "failed");
      return entries.length > 0;
    })
    .catch(() => { announce("failed"); return false; })
    .finally(() => { inflight = null; });
  return inflight;
}

// ---------------------------------------------------------------- search

const STOP = new Set(["the", "a", "an", "of", "and", "or", "in", "on", "to", "for",
  "with", "by", "as", "at", "from", "is", "are", "be", "that", "this", "et", "al",
  "its", "into", "about", "how", "why", "what", "when", "vs", "pp"]);

const fold = (s: string) => s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

function citedKeys(author: string): string[] {
  const toks = fold(author).split(/[,\s]+/).filter(Boolean);
  const strip = (s: string) => s.replace(/[^a-z]/g, "");
  if (!toks.length) return [];
  const one = strip(toks[0]);
  if (toks.length < 2) return one ? [one] : [];
  const two = strip(toks[0] + toks[1]);
  return [one, two].filter(Boolean);
}

/** does `tok` start a word inside `s`? (a prefix match, not a mid-word substring) */
function atWordStart(s: string, tok: string): boolean {
  let i = s.indexOf(tok);
  while (i >= 0) {
    if (i === 0 || !/[a-z0-9]/.test(s[i - 1])) return true;
    i = s.indexOf(tok, i + 1);
  }
  return false;
}

export type CiteSearchOpts = {
  /** "surname|year" keys already cited in the open manuscript; these float to the top */
  cited?: ReadonlySet<string> | null;
  limit?: number;
};

export function searchCiteIndex(query: string, opts: CiteSearchOpts = {}): CiteHit[] {
  const limit = opts.limit ?? 50;
  const cited = opts.cited ?? null;
  const raw = fold(query).split(/\s+/).filter(Boolean);
  const toks = raw.filter((t) => t.length > 1 && !STOP.has(t));
  const use = toks.length ? toks : raw;
  const scored: { s: number; e: Entry; already: boolean }[] = [];

  for (const e of entries) {
    if (use.length) {
      let all = true;
      for (const t of use) { if (!e.hay.includes(t)) { all = false; break; } }
      if (!all) continue;
    }
    const already = !!cited && !!e.ys && citedKeys(e.intext).some((k) => cited.has(k + "|" + e.ys));
    let score = already ? 1000 : 0;
    for (const t of use) {
      if (e.la.includes(t)) { score += 10; if (atWordStart(e.la, t)) score += 6; }
      if (e.ys === t) score += 8;                       // an exact year is a strong signal
      if (e.lt.includes(t)) { score += 3; if (atWordStart(e.lt, t)) score += 2; }
      if (e.lg.includes(t)) score += 2;
      if (e.lk.includes(t)) score += 2;
    }
    score += 4 * use.length;                            // coverage, as the server scores it
    if (use.length && use.every((t) => e.la.includes(t))) score += 30;
    score += (e.year || 0) / 100000;                    // gentle recency tiebreak
    scored.push({ s: score, e, already });
  }
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, limit).map((x) => toHit(x.e, x.already));
}

/** the picker's row shape. quotes/keyPoints are EMPTY here and filled by
 *  `citeDetail` when the writer opens one source; the counts carry the UI. */
function toHit(e: Entry, already: boolean): CiteHit {
  return {
    stem: e.stem, rel: e.rel, kind: e.kind as CiteHit["kind"], author: e.author,
    intext: e.intext, suffix: e.suffix,
    year: e.year, title: e.title, citekey: e.citekey, source: e.source, tags: e.tags,
    citation: "", keyPoints: [], quotes: [], alreadyCited: already,
    nQuotes: e.nQuotes, nKeyPoints: e.nKeyPoints, partial: true,
  };
}

// ---------------------------------------------------------------- server, for what stays

export type CiteDetail = {
  ok?: boolean; rel?: string; citation?: string;
  keyPoints?: string[]; quotes?: CiteQuote[]; error?: string;
};

/** One source in full, for the quote drill-down. A few KB, so it rides the lane. */
export async function citeDetail(rel: string): Promise<CiteDetail> {
  try {
    const r = await fetch("/drafting/cite-detail?rel=" + encodeURIComponent(rel));
    return (await r.json()) as CiteDetail;
  } catch { return { ok: false, error: "unreachable" }; }
}

/** in-window memo for the drill-down, so stepping back and forth costs one fetch */
const details = new Map<string, CiteDetail>();
export async function citeDetailCached(rel: string): Promise<CiteDetail> {
  const hit = details.get(rel);
  if (hit) return hit;
  const d = await citeDetail(rel);
  if (d.ok) details.set(rel, d);
  return d;
}

export async function searchRemote(slug: string, q: string, doc: string): Promise<CiteHit[]> {
  try {
    const r = await fetch("/drafting/cite-search?slug=" + encodeURIComponent(slug)
      + "&q=" + encodeURIComponent(q) + "&doc=" + encodeURIComponent(doc));
    const j = (await r.json()) as { hits?: CiteHit[] };
    return j.hits || [];
  } catch { return []; }
}
