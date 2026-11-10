

export type Anchor = { quote: string; prefix: string; suffix: string };
/** Only open comments shade manuscript text, including accepted cards reopened in the rail. */
export function commentIsOpen(c: { resolved: boolean; suggestion?: { status: string } }): boolean {
  return !c.resolved && (!c.suggestion || c.suggestion.status === "open");
}
export type AnchorComment = Anchor & {
  id: string;
  body: string;
  resolved: boolean;
  orphaned?: boolean;
  created: number;
  updated: number;
};

const CTX = 40;   // chars of context captured on each side of the quote

/** Capture an anchor for the span [from,to) of `text`. */
export function makeAnchor(text: string, from: number, to: number): Anchor {
  return {
    quote: text.slice(from, to),
    prefix: text.slice(Math.max(0, from - CTX), from),
    suffix: text.slice(to, Math.min(text.length, to + CTX)),
  };
}

function allIndexOf(hay: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) return out;
  let i = hay.indexOf(needle);
  while (i !== -1) { out.push(i); i = hay.indexOf(needle, i + 1); if (out.length > 5000) break; }
  return out;
}

function tailOverlap(a: string, b: string): number {
  let k = 0; const m = Math.min(a.length, b.length);
  while (k < m && a[a.length - 1 - k] === b[b.length - 1 - k]) k++;
  return k;
}
function headOverlap(a: string, b: string): number {
  let k = 0; const m = Math.min(a.length, b.length);
  while (k < m && a[k] === b[k]) k++;
  return k;
}

export function locate(text: string, a: Anchor): { from: number; to: number } | null {
  const q = a.quote;
  if (!q) return null;

  const hits = allIndexOf(text, q);
  if (hits.length === 1) return { from: hits[0], to: hits[0] + q.length };
  if (hits.length > 1) {
    let best = hits[0], bestScore = -1;
    for (const h of hits) {
      const pre = text.slice(Math.max(0, h - a.prefix.length), h);
      const suf = text.slice(h + q.length, h + q.length + a.suffix.length);
      const score = tailOverlap(pre, a.prefix) + headOverlap(suf, a.suffix);
      if (score > bestScore) { bestScore = score; best = h; }
    }
    return { from: best, to: best + q.length };
  }

  const ws = locateLoose(text, a);
  if (ws) return ws;

  // quote changed — if the surrounding context survives, the span sits between it
  if (a.prefix && a.suffix) {
    let from = text.indexOf(a.prefix);
    const span = q.length;
    while (from !== -1) {
      const start = from + a.prefix.length;
      const si = text.indexOf(a.suffix, start);
      if (si !== -1 && si - start <= span * 3 + 120) return { from: start, to: si };
      from = text.indexOf(a.prefix, from + 1);
    }
  }

  // a distinctive head of the quote still present somewhere
  const head = q.slice(0, Math.min(28, q.length)).trim();
  if (head.length >= 10) {
    const hi = text.indexOf(head);
    if (hi !== -1) return { from: hi, to: Math.min(text.length, hi + q.length) };
  }
  return null;
}

function collapse(s: string, keepMap: boolean): { t: string; map: number[] } {
  let t = ""; const map: number[] = [];
  const re = /\s+(?:>\s?)*\s*/y;
  for (let i = 0; i < s.length;) {
    re.lastIndex = i;
    const m = /\s/.test(s[i]) ? re.exec(s) : null;
    if (m && m[0].length) { if (keepMap) map.push(i); t += " "; i += m[0].length; }
    else { if (keepMap) map.push(i); t += s[i]; i++; }
  }
  if (keepMap) map.push(s.length);
  return { t, map };
}
function locateLoose(text: string, a: Anchor): { from: number; to: number } | null {
  const q = collapse(a.quote, false).t;
  if (q.trim().length < 4) return null;
  const hay = collapse(text, true);
  const hits = allIndexOf(hay.t, q);
  if (!hits.length) return null;
  let best = hits[0];
  if (hits.length > 1) {
    const pre = collapse(a.prefix, false).t, suf = collapse(a.suffix, false).t;
    let bestScore = -1;
    for (const h of hits) {
      const score = tailOverlap(hay.t.slice(Math.max(0, h - pre.length), h), pre) + headOverlap(hay.t.slice(h + q.length, h + q.length + suf.length), suf);
      if (score > bestScore) { bestScore = score; best = h; }
    }
  }
  return { from: hay.map[best], to: hay.map[best + q.length] };
}

export type Detached = { detached?: boolean; detachedAt?: number; detachedSection?: string; detachedOffset?: number };

function headingsOf(text: string): { key: string; at: number }[] {
  const out: { key: string; at: number }[] = [];
  let fence = false, pos = 0;
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    else if (!fence) {
      const m = /^(#{2,3})\s+(.+?)\s*#*\s*$/.exec(line);
      if (m) out.push({ key: m[1].length + ":" + m[2], at: pos });
    }
    pos += line.length + 1;
  }
  return out;
}

/** Mark `c` detached at offset `pos` of `text` (where its text last stood; null = unknown). */
export function detachAt<T extends Detached>(c: T, text: string, pos: number | null, now: number): T {
  if (c.detached) return c;
  if (pos == null) return { ...c, detached: true, detachedAt: now };
  const at = Math.max(0, Math.min(pos, text.length));
  let head: { key: string; at: number } | undefined;
  for (const h of headingsOf(text)) { if (h.at <= at) head = h; else break; }
  return { ...c, detached: true, detachedAt: now, detachedSection: head?.key ?? "", detachedOffset: at - (head?.at ?? 0) };
}

/** Where a detached comment's text stood in `text` now: inside its old section, clamped to
 *  it. null when it was never placed or its heading is gone (the rail's Detached group). */
export function detachedPos(text: string, c: Detached): number | null {
  if (!c.detached || typeof c.detachedOffset !== "number" || typeof c.detachedSection !== "string") return null;
  const hs = headingsOf(text);
  let start = 0, end = hs.length ? hs[0].at : text.length;
  if (c.detachedSection) {
    const i = hs.findIndex((h) => h.key === c.detachedSection);
    if (i < 0) return null;
    start = hs[i].at; end = i + 1 < hs.length ? hs[i + 1].at : text.length;
  }
  return Math.min(start + Math.max(0, c.detachedOffset), Math.max(start, end - 1));
}

/** The comment with its detached marks gone (its text is found again, or re-attached). */
export function attached<T extends Detached & { orphaned?: boolean }>(c: T): T {
  if (!c.detached && !c.orphaned) return c;
  const out = { ...c, orphaned: false };
  delete out.detached; delete out.detachedAt; delete out.detachedSection; delete out.detachedOffset;
  return out;
}

// ---------------------------------------------------------------- line diff
export type DiffRow = { t: "eq" | "add" | "del"; text: string };

/** Line-level LCS diff for the "changed on disk" banner. Caps the DP so a huge
 * manuscript can't hang the tab — beyond the cap it degrades to a whole-doc swap. */
export function lineDiff(oldT: string, newT: string): DiffRow[] {
  const a = oldT.split("\n"), b = newT.split("\n");
  const n = a.length, m = b.length;
  if (n * m > 4_000_000) return [...a.map((t) => ({ t: "del" as const, text: t })), ...b.map((t) => ({ t: "add" as const, text: t }))];
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: DiffRow[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ t: "eq", text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ t: "del", text: a[i] }); i++; }
    else { out.push({ t: "add", text: b[j] }); j++; }
  }
  while (i < n) out.push({ t: "del", text: a[i++] });
  while (j < m) out.push({ t: "add", text: b[j++] });
  return out;
}

export function diffCounts(rows: DiffRow[]): { added: number; removed: number } {
  let added = 0, removed = 0;
  for (const r of rows) { if (r.t === "add") added++; else if (r.t === "del") removed++; }
  return { added, removed };
}

/** Collapse long runs of unchanged lines for a compact banner preview, keeping a few
 * lines of context around each change. */
export function compactDiff(rows: DiffRow[], context = 2): DiffRow[] {
  const keep = new Array(rows.length).fill(false);
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].t !== "eq") for (let k = Math.max(0, i - context); k <= Math.min(rows.length - 1, i + context); k++) keep[k] = true;
  }
  const out: DiffRow[] = [];
  let gap = false;
  for (let i = 0; i < rows.length; i++) {
    if (keep[i]) { out.push(rows[i]); gap = false; }
    else if (!gap) { out.push({ t: "eq", text: "…" }); gap = true; }
  }
  return out;
}
