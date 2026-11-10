

import type { FocusPara } from "./focusParagraphs";
import type { RewriteEntry } from "./api";

export type RPara = FocusPara & { text: string; pos: number };

export const SAME_SECTION_MIN = 0.5;
export const ANYWHERE_MIN = 0.65;
const PLACE_BONUS = 0.05;   // tie-break only: never enough to clear a minimum

/** each paragraph's position among the paragraphs under the same section + heading */
export function withPos(paras: FocusPara[], text: string): RPara[] {
  const seen = new Map<string, number>();
  return paras.map((p) => {
    const g = p.section + "\u0000" + p.heading;
    const pos = seen.get(g) ?? 0;
    seen.set(g, pos + 1);
    return { ...p, text: text.slice(p.from, p.to), pos };
  });
}

/** minimum-cost assignment (Hungarian, O(n^3)) of rows to columns; rows may exceed
 *  columns or the reverse. Returns col per row, -1 = unassigned. */
export function assignMin(cost: number[][]): number[] {
  const nR = cost.length, nC = nR ? cost[0].length : 0;
  if (!nR || !nC) return new Array(nR).fill(-1);
  const n = Math.max(nR, nC), BIG = 1e9;
  const c = (i: number, j: number) => (i < nR && j < nC ? cost[i][j] : BIG / 1e3);
  const u = new Float64Array(n + 1), v = new Float64Array(n + 1);
  const p = new Int32Array(n + 1), way = new Int32Array(n + 1);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Float64Array(n + 1).fill(Infinity);
    const used = new Uint8Array(n + 1);
    do {
      used[j0] = 1;
      const i0 = p[j0];
      let delta = Infinity, j1 = 0;
      for (let j = 1; j <= n; j++) {
        if (used[j]) continue;
        const cur = c(i0 - 1, j - 1) - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
  }
  const out = new Array(nR).fill(-1);
  for (let j = 1; j <= n; j++) if (p[j] - 1 < nR && j - 1 < nC) out[p[j] - 1] = j - 1;
  return out;
}

const placeCost = (e: RewriteEntry, p: RPara, idx: number, idxs: number) =>
  (p.section === e.section ? 0 : 1000) + (p.heading === e.heading ? 0 : 100) + Math.min(50, Math.abs((p.pos ?? 0) - (e.pos ?? 0))) + idx * 1e-3 + idxs * 1e-6;

export function relocate(paras: RPara[], entries: RewriteEntry[], overlap: (a: string, b: string) => number): Map<number, string> {
  const out = new Map<number, string>();
  const used = new Set<number>();
  const live = entries.filter((e) => !e.dropped && e.baseline);
  const samePlace = (e: RewriteEntry, p: RPara) => p.section === e.section && p.heading === e.heading && p.pos === e.pos;

  // 1. exact key; shared prefixes need full text evidence before place.
  const byKey = new Map<string, RewriteEntry[]>();
  for (const e of live) if (e.key) { const l = byKey.get(e.key); if (l) l.push(e); else byKey.set(e.key, [e]); }
  const left: RewriteEntry[] = live.filter((e) => !e.key);
  for (const [key, es] of byKey) {
    const ps = paras.filter((p) => p.key === key);
    if (!ps.length) { left.push(...es); continue; }
    es.sort((a, b) => (a.started ?? 0) - (b.started ?? 0) || (a.id < b.id ? -1 : 1));
    if (es.length > 1 || ps.length > 1) {
      const placed = new Set<string>(), reserved = new Set<number>();
      // Equal-sized full-text twin groups can use place. Unequal groups cannot tell
      // which identical paragraph was deleted, so their originals stay unplaced.
      for (const text of new Set(es.map((e) => e.last || e.baseline))) {
        const exactE = es.filter((e) => (e.last || e.baseline) === text);
        const exactP = ps.filter((p) => p.text === text);
        if (!exactP.length) continue;
        exactE.forEach((e) => placed.add(e.id));
        exactP.forEach((p) => reserved.add(p.i));
        if (exactE.length !== exactP.length) continue;
        const pick = assignMin(exactE.map((e, ei) => exactP.map((p) => placeCost(e, p, 0, ei))));
        exactE.forEach((e, k) => { const p = exactP[pick[k]]; out.set(p.i, e.id); used.add(p.i); });
      }
      // For edits beyond the common prefix, require a unique best content match in
      // both directions. Position must not decide between different originals.
      const restE = es.filter((e) => !placed.has(e.id));
      const restP = ps.filter((p) => !reserved.has(p.i));
      const scores = restE.map((e) => restP.map((p) => overlap(e.last || e.baseline, p.text)));
      restE.forEach((e, ei) => {
        const row = scores[ei], best = Math.max(...row);
        if (best < SAME_SECTION_MIN) return;
        const pi = row.indexOf(best);
        if (row.filter((s) => s === best).length !== 1) return;
        const col = scores.map((r) => r[pi]);
        if (best !== Math.max(...col) || col.filter((s) => s === best).length !== 1) return;
        out.set(restP[pi].i, e.id); used.add(restP[pi].i);
      });
      // No fallback by position or a greedy content match for ambiguous key groups.
      continue;
    }
    const pick = assignMin(es.map((e, ei) => ps.map((p) => placeCost(e, p, 0, ei))));
    es.forEach((e, k) => {
      const j = pick[k];
      if (j >= 0) { out.set(ps[j].i, e.id); used.add(ps[j].i); } else left.push(e);
    });
  }

  // 2. same section, real content evidence; place breaks ties
  const left2: RewriteEntry[] = [];
  for (const e of left) {
    let best: RPara | null = null, bs = 0, bo = 0;
    for (const p of paras) {
      if (used.has(p.i) || p.section !== e.section) continue;
      const o = overlap(e.last || e.baseline, p.text);
      if (o < SAME_SECTION_MIN) continue;
      const s = o + (samePlace(e, p) ? PLACE_BONUS : 0);
      if (s > bs) { bs = s; bo = o; best = p; }
    }
    if (best && bo >= SAME_SECTION_MIN) { out.set(best.i, e.id); used.add(best.i); } else left2.push(e);
  }

  // 3. anywhere, stronger evidence
  for (const e of left2) {
    let best: RPara | null = null, bs = 0;
    for (const p of paras) {
      if (used.has(p.i)) continue;
      const s = overlap(e.last || e.baseline, p.text);
      if (s > bs) { bs = s; best = p; }
    }
    if (best && bs >= ANYWHERE_MIN) { out.set(best.i, e.id); used.add(best.i); }
  }
  return out;
}

/** live entries that relocate() could not place, oldest first */
export function unplaced(entries: RewriteEntry[], assigned: Map<number, string>): RewriteEntry[] {
  const placed = new Set(assigned.values());
  return entries.filter((e) => !e.dropped && e.baseline && !placed.has(e.id))
    .sort((a, b) => (a.started ?? 0) - (b.started ?? 0));
}

export function newRewriteId(): string {
  const a = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  const r = new Uint32Array(12);
  try { crypto.getRandomValues(r); } catch { for (let i = 0; i < r.length; i++) r[i] = Math.floor(Math.random() * 2 ** 32); }
  for (const x of r) s += a[x % a.length];
  return s;
}

/** sections whose paragraphs are not prose to rewrite */
export const SKIP_SECTION = /^(references|bibliography|works cited|literature cited)$/i;
