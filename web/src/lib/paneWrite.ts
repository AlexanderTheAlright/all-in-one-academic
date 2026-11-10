

import { EditorView } from "@codemirror/view";

export function minimal(a: string, b: string): { from: number; to: number; insert: string } | null {
  if (a === b) return null;
  let s = 0;
  const n = Math.min(a.length, b.length);
  while (s < n && a.charCodeAt(s) === b.charCodeAt(s)) s++;
  let ea = a.length, eb = b.length;
  while (ea > s && eb > s && a.charCodeAt(ea - 1) === b.charCodeAt(eb - 1)) { ea--; eb--; }
  return { from: s, to: ea, insert: b.slice(s, eb) };
}

export type PaneRange = { from: number; to: number; empty: boolean;
  framing?: { before: string; after: string; inserted: string } };

export function writePane(v: EditorView, r: PaneRange, prev: string, next: string): PaneRange | null {
  const doc = v.state.doc, len = doc.length;
  if (r.empty) {
    if (!next) return r;
    if (r.framing) {
      const { before, after, inserted } = r.framing;
      const from = r.from - inserted.length;
      if (from < 0 || doc.sliceString(from, r.from) !== inserted) return null;
      v.dispatch({ changes: { from, to: r.from, insert: before + next + after } });
      return { from: from + before.length, to: from + before.length + next.length, empty: false };
    }
    const at = Math.min(r.from, len);
    if (at >= len) {
      const tail = doc.sliceString(Math.max(0, len - 2), len);
      const pre = len === 0 ? "" : tail.endsWith("\n\n") ? "" : tail.endsWith("\n") ? "\n" : "\n\n";
      v.dispatch({ changes: { from: len, insert: pre + next + "\n" } });
      return { from: len + pre.length, to: len + pre.length + next.length, empty: false };
    }
    v.dispatch({ changes: { from: at, insert: next + "\n\n" } });
    return { from: at, to: at + next.length, empty: false };
  }
  if (v.state.sliceDoc(r.from, r.to) !== prev) return null;
  if (!next) {
    // Only complete blank lines frame the block. Spaces on either neighbouring
    // content line belong to that block (hard breaks, code indentation).
    const before = /\n(?:[ \t]*\n)*$/.exec(doc.sliceString(0, r.from))?.[0] ?? "";
    const after = /^\n(?:[ \t]*\n)*/.exec(doc.sliceString(r.to, len))?.[0] ?? "";
    const a = r.from - before.length, b = r.to + after.length;
    const insert = a === 0 ? "" : b >= len ? "\n" : "\n\n";
    v.dispatch({ changes: { from: a, to: b, insert } });
    const hole = a === 0 ? 0 : b >= len ? a + 1 : a + 2;
    return { from: hole, to: hole, empty: true, framing: { before, after, inserted: insert } };
  }
  const ch = minimal(prev, next);
  if (!ch) return r;
  v.dispatch({ changes: { from: r.from + ch.from, to: r.from + ch.to, insert: ch.insert } });
  return { from: r.from, to: r.to + next.length - prev.length, empty: false };
}

export function focusBackInside(root: HTMLElement | null, e: FocusEvent): HTMLElement | null {
  const prev = e.relatedTarget as HTMLElement | null;
  if (!root || !prev || !prev.isConnected || !root.contains(prev)) return null;
  return prev.matches("textarea, input, [contenteditable=true]") || prev.closest(".cm-content") ? prev : null;
}

export function selectInMain(main: EditorView | null | undefined, pane: EditorView | null | undefined, r: { from: number; to: number } | null): boolean {
  if (!main || !pane || !r) return false;
  const text = pane.state.doc.toString();
  if (r.to > r.from && main.state.sliceDoc(r.from, r.to) !== text) return false;
  const len = main.state.doc.length, s = pane.state.selection.main;
  const at = (n: number) => Math.min(len, r.from + Math.min(n, r.to - r.from));
  main.dispatch({ selection: { anchor: at(s.anchor), head: at(s.head) } });
  return true;
}

export function selectFromMain(main: EditorView | null | undefined, paneContent: HTMLElement, from: number): void {
  const pane = EditorView.findFromDOM(paneContent);
  if (pane && main) {
    const s = main.state.selection.main, len = pane.state.doc.length;
    const at = (n: number) => Math.max(0, Math.min(len, n - from));
    pane.dispatch({ selection: { anchor: at(s.anchor), head: at(s.head) } });
  }
  paneContent.focus({ preventScroll: true });
}
