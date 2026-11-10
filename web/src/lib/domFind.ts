
import { COUNT_CAP, NO_COUNT, EMPTY_QUERY } from "./cmFind";
import type { FindCount, FindQuery, FindTarget } from "./cmFind";

const HL = "board-find";
const HL_CUR = "board-find-current";

type Highlights = { set: (k: string, v: unknown) => void; delete: (k: string) => void };
type HighlightCtor = new () => { add: (r: Range) => void };

function highlightApi(): { store: Highlights; make: HighlightCtor } | null {
  const w = window as unknown as { CSS?: { highlights?: Highlights }; Highlight?: HighlightCtor };
  return w.CSS?.highlights && w.Highlight ? { store: w.CSS.highlights, make: w.Highlight } : null;
}

export type DomFindOpts = {
  /** Page view: keep only the copy of a straddling block that is on its own sheet */
  clipToPageWindows?: boolean;
  /** a viewer whose tabs unmount: how to read and switch them */
  tabs?: { list: () => string[]; current: () => string; set: (id: string) => void };
  /** what the counter counts, for its tooltip */
  scope?: string;
};

/** ASCII word boundaries — prose, not identifiers; the same call CM's whole-word makes */
function toRegExp(q: FindQuery): RegExp | null {
  if (!q.search) return null;
  let src = q.regexp ? q.search : q.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (q.wholeWord) src = "\\b(?:" + src + ")\\b";
  try { return new RegExp(src, q.caseSensitive ? "g" : "gi"); } catch { return null; }
}

export function domFindTarget(getRoot: () => HTMLElement | null, opts: DomFindOpts = {}): FindTarget {
  let q: FindQuery = EMPTY_QUERY;
  let hits: Range[] = [];
  let idx = -1;
  let capped = false;
  let valid = false;
  const subs = new Set<() => void>();

  let mo: MutationObserver | null = null;
  let moTimer = 0;
  // a tab hop is a React render away, so the landing is deferred to the re-scan the
  // observer brings; the budget stops a query that matches nothing from walking for ever
  let land: 1 | -1 | 0 = 0;
  let hopBudget = 0;

  const notify = () => { for (const cb of subs) cb(); };

  /** a match inside a page window counts only where it is not clipped away */
  const onItsOwnSheet = (r: Range): boolean => {
    const win = r.startContainer.parentElement?.closest("[data-pgwin]") as HTMLElement | null;
    if (!win) return true;
    const rr = r.getBoundingClientRect();
    if (!rr.height) return false;
    const wr = win.getBoundingClientRect();
    const mid = rr.top + rr.height / 2;
    return mid >= wr.top - 1 && mid <= wr.bottom + 1;
  };

  const scan = () => {
    hits = []; capped = false;
    const root = getRoot();
    const re = toRegExp(q);
    valid = !!re;
    if (!root || !re) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => {
        if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        const p = n.parentElement;
        if (!p || p.closest("script, style, [data-find-skip]")) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n.nodeValue || "";
      re.lastIndex = 0;
      for (let m = re.exec(text); m; m = re.exec(text)) {
        if (!m[0].length) { re.lastIndex++; continue; }
        const r = document.createRange();
        r.setStart(n, m.index);
        r.setEnd(n, m.index + m[0].length);
        if (opts.clipToPageWindows && !onItsOwnSheet(r)) continue;
        hits.push(r);
        if (hits.length >= COUNT_CAP) { capped = true; break; }
      }
      if (capped) break;
    }
  };

  const paint = () => {
    const api = highlightApi();
    if (!api) {
      const r = hits[idx];
      const sel = window.getSelection();
      if (r && sel) { sel.removeAllRanges(); sel.addRange(r.cloneRange()); }
      return;
    }
    const all = new api.make();
    const cur = new api.make();
    hits.forEach((r, i) => (i === idx ? cur : all).add(r));
    api.store.set(HL, all);
    api.store.set(HL_CUR, cur);
  };

  const reveal = () => {
    const r = hits[idx];
    const el = r?.startContainer.parentElement;
    // no smooth behaviour: an in-flight scroll animation is what lib/scroll.ts owns,
    // and a probe reading rects right after a step must see where it landed
    el?.scrollIntoView({ block: "center", inline: "nearest" });
  };

  const count = (): FindCount =>
    valid ? { current: idx >= 0 && hits[idx] ? idx + 1 : 0, total: hits.length, capped, valid: true } : NO_COUNT;

  /** ask the viewer for the next tab; the landing happens on the re-scan it triggers */
  const hopTab = (dir: 1 | -1): boolean => {
    const t = opts.tabs;
    if (!t) return false;
    const list = t.list();
    if (list.length < 2) return false;
    if (hopBudget <= 0) hopBudget = list.length;
    const at = list.indexOf(t.current());
    const to = list[((at < 0 ? 0 : at) + dir + list.length) % list.length];
    land = dir;
    hopBudget--;
    t.set(to);
    return true;
  };

  const rescan = () => {
    const before = idx;
    scan();
    if (land) {
      if (hits.length) { idx = land > 0 ? 0 : hits.length - 1; land = 0; hopBudget = 0; paint(); reveal(); notify(); return; }
      if (hopBudget > 0 && hopTab(land)) return;
      land = 0; hopBudget = 0;
    }
    idx = hits.length ? Math.min(Math.max(0, before), hits.length - 1) : -1;
    paint();
    notify();
  };

  const observe = () => {
    const root = getRoot();
    if (!root || mo) return;
    mo = new MutationObserver(() => {
      window.clearTimeout(moTimer);
      moTimer = window.setTimeout(rescan, 150);
    });
    mo.observe(root, { childList: true, subtree: true, characterData: true });
  };

  return {
    kind: "dom",
    canReplace: false,
    scope: opts.scope || "",
    setQuery(next) {
      q = next;
      land = 0; hopBudget = 0;
      scan();
      idx = hits.length ? 0 : -1;
      paint();
      if (idx >= 0) reveal();
      observe();
      return count();
    },
    step(dir) {
      if (!hits.length) { hopTab(dir); return count(); }
      let n = idx + dir;
      if (n >= hits.length) { if (hopTab(1)) return count(); n = 0; }
      else if (n < 0) { if (hopTab(-1)) return count(); n = hits.length - 1; }
      idx = n;
      paint();
      reveal();
      return count();
    },
    count,
    replaceOne: count,
    replaceAll: count,
    clear() {
      window.clearTimeout(moTimer);
      mo?.disconnect(); mo = null;
      hits = []; idx = -1; land = 0; hopBudget = 0;
      const api = highlightApi();
      if (api) { api.store.delete(HL); api.store.delete(HL_CUR); }
      else window.getSelection()?.removeAllRanges();
    },
    restoreFocus() { /* the rendered surface has no caret — the opener takes the keys back */ },
    selectionText() {
      const s = window.getSelection();
      const t = s && !s.isCollapsed ? s.toString() : "";
      return t.length > 100 || t.includes("\n") ? "" : t;
    },
    subscribe(cb) { subs.add(cb); return () => { subs.delete(cb); }; },
  };
}
