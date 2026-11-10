
import { Compartment, EditorSelection, EditorState, Transaction } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { Decoration, EditorView, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentLess, indentMore, redo } from "@codemirror/commands";

export type NoteEditor = {
  text: () => string;
  selection: () => [number, number];
  focus: () => void;
  /** a DIFFERENT note: new document, new history */
  open: (text: string, selection?: [number, number]) => void;
  /** replace the whole text as one undoable edit (taking the other version of a conflict) */
  replaceAll: (text: string) => void;
  /** the same note, as it now is on disk: the text changes under a caret that stays where
   *  it was (clamped), nothing scrolls, and it is not an undo step */
  refresh: (text: string) => void;
  /** no typing while a switch or a move is in hand; the caret and the focus stay */
  setReadOnly: (on: boolean) => void;
  /** put a block on its own line at the caret, caret after it */
  insertBlock: (text: string) => void;
  destroy: () => void;
};

export type NoteEditorOptions = {
  text: string;
  selection?: [number, number];
  onChange: () => void;          // the text changed
  onSelection: () => void;       // only the caret moved
  /** a pasted image: resolve to the embed to insert, or null */
  onImage: (file: File) => Promise<string | null>;
};

// "- ", "* ", "+ ", "1. ", "1) " and the task forms of the bullets
const ITEM = /^(\s*)(?:([-*+])( \[[ xX]\])? |(\d+)([.)]) )/;
const URL_ONLY = /^https?:\/\/\S+$/;

/** Enter in a list item continues the list; on an empty item it ends it. */
function continueList(view: EditorView): boolean {
  const { state } = view;
  const sel = state.selection.main;
  if (!sel.empty || state.selection.ranges.length > 1) return false;
  const line = state.doc.lineAt(sel.head);
  const m = ITEM.exec(line.text);
  if (!m || sel.head < line.from + m[0].length) return false;
  if (line.text.length === m[0].length) {
    // an empty item: the marker goes, the list is over
    view.dispatch({ changes: { from: line.from, to: line.to }, selection: { anchor: line.from }, userEvent: "delete" });
    return true;
  }
  const marker = m[2] ? m[2] + (m[3] ? " [ ] " : " ") : `${Number(m[4]) + 1}${m[5]} `;
  const insert = "\n" + m[1] + marker;
  view.dispatch({ changes: { from: sel.head, insert }, selection: { anchor: sel.head + insert.length }, scrollIntoView: true, userEvent: "input" });
  return true;
}

/** Tab indents a list item (or every selected line); anywhere else it is a tab character.
 *  Either way it is consumed: Tab never leaves the page. */
function tab(view: EditorView): boolean {
  const { state } = view;
  const sel = state.selection.main;
  if (!sel.empty || ITEM.test(state.doc.lineAt(sel.head).text)) return indentMore(view);
  view.dispatch(state.replaceSelection("\t"), { scrollIntoView: true, userEvent: "input" });
  return true;
}
const shiftTab = (view: EditorView): boolean => { indentLess(view); return true; };

/** Ctrl+B / Ctrl+I: wrap the selection, or unwrap it when it is already wrapped. */
const wrap = (mark: string) => (view: EditorView): boolean => {
  const { state } = view;
  const n = mark.length;
  view.dispatch(state.changeByRange((r) => {
    const inside = state.sliceDoc(r.from, r.to);
    const before = state.sliceDoc(Math.max(0, r.from - n), r.from), after = state.sliceDoc(r.to, r.to + n);
    if (before === mark && after === mark) {
      return { changes: [{ from: r.from - n, to: r.from }, { from: r.to, to: r.to + n }], range: EditorSelection.range(r.from - n, r.to - n) };
    }
    if (inside.length >= 2 * n && inside.startsWith(mark) && inside.endsWith(mark)) {
      return { changes: { from: r.from, to: r.to, insert: inside.slice(n, -n) }, range: EditorSelection.range(r.from, r.to - 2 * n) };
    }
    return { changes: [{ from: r.from, insert: mark }, { from: r.to, insert: mark }], range: EditorSelection.range(r.from + n, r.to + n) };
  }), { userEvent: "input" });
  return true;
};

const TITLE = Decoration.set([Decoration.line({ class: "cm-note-title" }).range(0)]);

/* Theme tokens only, so day and night follow the Board. The face, size and leading are the
 * Drafting editor's (markdownEditor.tsx): Georgia, 1.72. The measure is 68 characters. */
const theme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "transparent", color: "hsl(var(--foreground))" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "Georgia, 'Times New Roman', serif", lineHeight: "1.72", overflowX: "hidden", overflowY: "auto",
    scrollbarColor: "transparent transparent",
  },
  "&[data-scrolling] .cm-scroller": { scrollbarColor: "var(--sb-thumb, hsl(var(--border))) transparent" },
  ".cm-content": {
    boxSizing: "content-box", width: "100%", maxWidth: "68ch", margin: "0 auto", fontSize: "var(--note-size, 18px)",
    padding: "clamp(20px, 11vh, 120px) 0 42vh", caretColor: "hsl(var(--foreground))",
  },
  ".cm-line": { padding: "0 clamp(18px, 5vw, 40px)" },
  ".cm-note-title": { fontSize: "1.6em", fontWeight: "600", lineHeight: "1.28", letterSpacing: "-0.01em", paddingBottom: "0.5em" },
  "& .cm-selectionBackground, .cm-content ::selection": { backgroundColor: "hsl(var(--primary) / 0.22)" },
  ".cm-cursor": { borderLeftColor: "hsl(var(--foreground))", borderLeftWidth: "1.5px" },
});

export function createNoteEditor(parent: HTMLElement, o: NoteEditorOptions): NoteEditor {
  const clampSel = (text: string, s?: [number, number]) => {
    const n = text.length, c = (v: number) => Math.max(0, Math.min(n, Math.floor(v) || 0));
    return s ? EditorSelection.single(c(s[0]), c(s[1])) : EditorSelection.single(n);
  };
  const lock = new Compartment();
  const extensions: Extension[] = [
    lock.of(EditorState.readOnly.of(false)),
    EditorState.lineSeparator.of("\n"),
    EditorState.tabSize.of(4),
    history(),
    keymap.of([
      { key: "Enter", run: continueList },
      { key: "Tab", run: tab, shift: shiftTab },
      { key: "Mod-b", run: wrap("**") },
      { key: "Mod-i", run: wrap("*") },
      { key: "Mod-Shift-z", run: redo },     // beside Ctrl+Y, on every platform
      ...historyKeymap,
      // Mod-Enter (a blank line below) stays; Mod-/ needs a language and Mod-i is italic here
      ...defaultKeymap.filter((b) => b.key !== "Mod-/" && b.key !== "Mod-i"),
    ]),
    EditorView.lineWrapping,
    EditorView.decorations.of(TITLE),
    EditorView.contentAttributes.of({ spellcheck: "true", autocorrect: "on", autocapitalize: "sentences", "aria-label": "Note" }),
    // typewriter room: the caret's line never sits in the bottom third of the window
    EditorView.scrollMargins.of((view) => ({ top: 48, bottom: Math.round(view.scrollDOM.clientHeight * 0.34) })),
    EditorView.updateListener.of((u) => { if (u.docChanged) o.onChange(); else if (u.selectionSet) o.onSelection(); }),
    EditorView.domEventHandlers({
      // Esc is not a way out of the page: it must not blur the text (the Board's arrow
      // engine would take it as "stop editing") and it never closes the window
      keydown(e) { if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); return true; } return false; },
      paste(e, view) {
        const cd = e.clipboardData;
        if (!cd) return false;
        const image = Array.from(cd.files).find((f) => f.type.startsWith("image/"));
        if (image) {
          e.preventDefault();
          void o.onImage(image).then((embed) => { if (embed) insertBlock(view, embed); });
          return true;
        }
        // a URL pasted over a selection becomes a link on those words
        const pasted = cd.getData("text/plain").trim(), sel = view.state.selection.main;
        if (!sel.empty && URL_ONLY.test(pasted) && !/\n/.test(view.state.sliceDoc(sel.from, sel.to))) {
          e.preventDefault();
          const label = view.state.sliceDoc(sel.from, sel.to), insert = `[${label}](${pasted})`;
          view.dispatch({ changes: { from: sel.from, to: sel.to, insert }, selection: { anchor: sel.from + insert.length }, userEvent: "input.paste" });
          return true;
        }
        return false;
      },
    }),
    theme,
  ];
  const fresh = (text: string, selection?: [number, number]) =>
    EditorState.create({ doc: text, selection: clampSel(text, selection), extensions });
  const view = new EditorView({ state: fresh(o.text, o.selection), parent });

  // the scrollbar shows only while the page is moving
  let quiet = 0;
  const onScroll = () => {
    view.dom.setAttribute("data-scrolling", "");
    window.clearTimeout(quiet);
    quiet = window.setTimeout(() => view.dom.removeAttribute("data-scrolling"), 900);
  };
  view.scrollDOM.addEventListener("scroll", onScroll, { passive: true });

  return {
    text: () => view.state.doc.toString(),
    selection: () => [view.state.selection.main.anchor, view.state.selection.main.head],
    focus: () => view.focus(),
    open: (text, selection) => { view.setState(fresh(text, selection)); view.scrollDOM.scrollTop = 0; view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head, { y: "center" }) }); },
    replaceAll: (text) => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: text.length }, scrollIntoView: true, userEvent: "input" }),
    refresh: (text) => {
      const s = view.state.selection.main, n = text.length, top = view.scrollDOM.scrollTop;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: Math.min(s.anchor, n), head: Math.min(s.head, n) },
        annotations: Transaction.addToHistory.of(false) });
      view.scrollDOM.scrollTop = top;
    },
    setReadOnly: (on) => view.dispatch({ effects: lock.reconfigure(EditorState.readOnly.of(on)) }),
    insertBlock: (text) => insertBlock(view, text),
    destroy: () => { window.clearTimeout(quiet); view.scrollDOM.removeEventListener("scroll", onScroll); view.destroy(); },
  };
}

/* On a line with words the block goes below it; a blank line becomes it. The caret ends
 * on the line after, which is created when the block lands at the end of the note. */
function insertBlock(view: EditorView, text: string): void {
  const { state } = view;
  const line = state.doc.lineAt(state.selection.main.head);
  const blank = !line.text.trim(), last = line.to === state.doc.length;
  const from = blank ? line.from : line.to;
  const insert = (blank ? "" : "\n") + text + (last ? "\n" : "");
  view.dispatch({ changes: { from, to: line.to, insert }, selection: { anchor: from + insert.length + (last ? 0 : 1) }, scrollIntoView: true, userEvent: "input" });
  view.focus();
}
