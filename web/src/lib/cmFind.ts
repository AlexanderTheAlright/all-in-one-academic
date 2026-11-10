
import { EditorView } from "@codemirror/view";
import {
  SearchQuery, setSearchQuery, findNext, findPrevious,
  replaceNext as cmReplaceNext, replaceAll as cmReplaceAll,
  openSearchPanel, closeSearchPanel, searchPanelOpen,
} from "@codemirror/search";

export type FindQuery = { search: string; caseSensitive: boolean; wholeWord: boolean; regexp: boolean; replace: string };

/** `current` is 1-based and 0 means "no match is the current one"; `valid` is false
 *  for an unparseable regexp, which is a visual state on the bar and never a throw. */
export type FindCount = { current: number; total: number; capped: boolean; valid: boolean };

export type FindTarget = {
  kind: "cm" | "dom";
  /** false on the DOM engines: a rendered sheet or dashboard is not editable text */
  canReplace: boolean;
  /** what the counter counts, when that is narrower than the document (tooltip only) */
  scope: string;
  setQuery: (q: FindQuery) => FindCount;
  step: (dir: 1 | -1) => FindCount;
  count: () => FindCount;
  replaceOne: () => FindCount;
  replaceAll: () => FindCount;
  /** drop every highlight this target drew; safe to call twice */
  clear: () => void;
  /** hand the keys back to the surface, landing on the current match where that means something */
  restoreFocus: () => void;
  /** a short single-line selection, to pre-fill the find field when the bar opens */
  selectionText: () => string;
  /** the content moved under us (DOM engines) — recount */
  subscribe: (cb: () => void) => () => void;
};

export const COUNT_CAP = 9999;
export const EMPTY_QUERY: FindQuery = { search: "", caseSensitive: false, wholeWord: false, regexp: false, replace: "" };
export const NO_COUNT: FindCount = { current: 0, total: 0, capped: false, valid: false };

/** at most this much of a selection pre-fills the field — a paragraph is not a query */
const PREFILL_MAX = 100;

function build(q: FindQuery): SearchQuery {
  return new SearchQuery({ search: q.search, caseSensitive: q.caseSensitive, regexp: q.regexp, wholeWord: q.wholeWord, replace: q.replace });
}

export function cmFindTarget(view: EditorView): FindTarget {
  let q: FindQuery = EMPTY_QUERY;

  /* walk every match so the counter describes the whole document, not the rendered
     viewport — the reason Chromium's own find could never answer this question. */
  const tally = (): FindCount => {
    const query = build(q);
    if (!query.valid) return NO_COUNT;
    const sel = view.state.selection.main;
    const cursor = query.getCursor(view.state);
    let total = 0, current = 0, capped = false;
    for (;;) {
      const r = cursor.next();
      if (r.done) break;
      total++;
      if (!current && r.value.from === sel.from && r.value.to === sel.to) current = total;
      if (total >= COUNT_CAP) { capped = true; break; }
    }
    return { current, total, capped, valid: true };
  };

  /** the first match at or after `from`, wrapping once — where a fresh query lands */
  const firstFrom = (query: SearchQuery, from: number): { from: number; to: number } | null => {
    for (const start of [from, 0]) {
      const cursor = query.getCursor(view.state, start);
      const r = cursor.next();
      if (!r.done) return { from: r.value.from, to: r.value.to };
    }
    return null;
  };

  return {
    kind: "cm",
    canReplace: true,
    scope: "",
    setQuery(next) {
      q = next;
      const query = build(next);
      // panel first (it would otherwise overwrite the query from the selection), then ours
      if (!searchPanelOpen(view.state)) openSearchPanel(view);
      view.dispatch({ effects: setSearchQuery.of(query) });
      if (query.valid) {
        const sel = view.state.selection.main;
        const m = firstFrom(query, sel.from);
        // move the caret onto the landing match WITHOUT taking the focus: the keys
        // belong to whoever is typing in the bar
        if (m && (m.from !== sel.from || m.to !== sel.to)) {
          view.dispatch({ selection: { anchor: m.from, head: m.to }, effects: EditorView.scrollIntoView(m.from, { y: "center" }) });
        }
      }
      return tally();
    },
    step(dir) {
      if (build(q).valid) (dir > 0 ? findNext : findPrevious)(view);
      return tally();
    },
    count: tally,
    replaceOne() { if (build(q).valid) cmReplaceNext(view); return tally(); },
    replaceAll() { if (build(q).valid) cmReplaceAll(view); return tally(); },
    clear() { if (searchPanelOpen(view.state)) closeSearchPanel(view); },
    restoreFocus() { view.focus(); },
    selectionText() {
      const s = view.state.selection.main;
      if (s.empty || s.to - s.from > PREFILL_MAX) return "";
      const t = view.state.sliceDoc(s.from, s.to);
      return t.includes("\n") ? "" : t;
    },
    subscribe() { return () => {}; },   // the host re-counts on its own doc state
  };
}
