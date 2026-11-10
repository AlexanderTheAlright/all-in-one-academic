

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, Flag, PanelRightClose, PanelRightOpen } from "lucide-react";
import { MarkdownEditor } from "@/lib/markdownEditor";
import type { MdEditorHandle, CRange, MentionInfo, MentionKey } from "@/lib/markdownEditor";
import type { DraftComment } from "@/lib/api";
import type { DraftStyle } from "@/lib/draftStyle";
import { locate, commentIsOpen } from "@/lib/anchors";
import { parseFocusParagraphs, paraAt, paraKey, resolvePara, flagAnchor, type FocusPara } from "@/lib/focusParagraphs";
import { writePane, focusBackInside, selectInMain, type PaneRange } from "@/lib/paneWrite";

type Sel = { from: number; to: number; text: string; x: number; y: number };

function lsGet(k: string): { key?: string; idx?: number; collapsed?: boolean } {
  try { const v = JSON.parse(localStorage.getItem(k) || "null"); return v && typeof v === "object" ? v : {}; } catch { return {}; }
}
function lsSet(k: string, v: object) {
  try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private window: per-session only */ }
}

const typing = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.matches?.("input, textarea, select") || !!el.closest?.("[contenteditable=true], .cm-content"));
};

export function FocusMode({ slug, docName, text, main, comments, tick, style, zoom, citeMap, onCitationClick, onCitePage,
  activeComment, onActivate, renderCard, onFlag, onUnflag, onAccept, suggestionIds, onRequestComment, onContextMenu, onSave, onExit, startPos, issuesOnly = true, onIssuesOnly,
  onMention, onMentionKey, mentionActive = false, citeTarget }: {
  slug: string; docName: string;
  text: string;                                  // the live manuscript (paper.text)
  main: React.RefObject<MdEditorHandle | null>;  // the main editor: the only writer
  comments: DraftComment[];
  tick: number;                                  // bumps when the main editor's geometry/ranges move
  style?: DraftStyle; zoom?: number;
  citeMap?: Record<string, { status: string; rel: string }>;
  onCitationClick?: (rel: string) => void; onCitePage?: (rel: string, page: string) => void;
  activeComment: string | null; onActivate: (id: string | null) => void;
  // escapeTo: where Esc from the card or any of its fields lands (the layer, keys live)
  renderCard: (c: DraftComment, o: { onEscapeToText: () => void; onLocate: () => void; escapeTo: () => void }) => ReactNode;
  onFlag: (from: number, to: number) => string | null;   // files the flag comment, returns its id
  onUnflag: (ids: string[]) => void;
  onAccept: (ids: string[]) => void;
  suggestionIds: string[];
  onRequestComment: (sel: Sel) => void;          // absolute offsets
  // right-click in the paragraph: the host's drafting menu, which acts on the main editor
  onContextMenu?: (info: { x: number; y: number; hasSelection: boolean }) => void;
  onSave: () => void;
  onExit: (pos: number) => void;
  startPos?: number;                             // where the caret / view was, when nothing is remembered
  issuesOnly?: boolean;                          // ← → walk explicitly flagged paragraphs
  onIssuesOnly?: (on: boolean) => void;          // Shift+F (the Review menu holds the toggle)
  onMention?: (m: MentionInfo | null) => void; onMentionKey?: (k: MentionKey) => boolean; mentionActive?: boolean;
  citeTarget?: React.MutableRefObject<React.RefObject<MdEditorHandle | null> | null>;
}) {
  const store = `all_in_one_academic:focus:${slug}:${docName}`;
  const noteStore = `all_in_one_academic:focus-notes:${slug}`;
  const [noteState, setNoteState] = useState(() => ({ store: noteStore, collapsed: lsGet(noteStore).collapsed === true }));
  const notesCollapsed = noteState.store === noteStore ? noteState.collapsed : lsGet(noteStore).collapsed === true;
  const setNotesCollapsed = (collapsed: boolean) => {
    setNoteState({ store: noteStore, collapsed });
    lsSet(noteStore, { collapsed });
  };
  const paras = useMemo(() => parseFocusParagraphs(text), [text]);
  const rootRef = useRef<HTMLDivElement>(null);
  const fed = useRef<MdEditorHandle>(null);
  const onMentionRef = useRef(onMention); onMentionRef.current = onMention;
  useEffect(() => {
    if (!citeTarget) return;
    citeTarget.current = fed;
    return () => { citeTarget.current = null; onMentionRef.current?.(null); };
  }, [citeTarget]);
  const cardsRef = useRef<HTMLDivElement>(null);
  const textRef = useRef(text); textRef.current = text;
  const parasRef = useRef(paras); parasRef.current = paras;

  // the range of the main document the small editor is showing, and what it shows
  const rangeRef = useRef<Omit<PaneRange, "empty"> | null>(null);
  const shownRef = useRef("");
  const keyRef = useRef("");
  const expectedRef = useRef(text);
  const [ver, setVer] = useState(0);              // remounts the small editor on a switch
  const refocus = useRef<"editor" | "keep" | null>(null);
  const [, setSync] = useState(0);                // re-render after an outside re-sync
  const emptyRef = useRef(false);
  const lastParaRef = useRef<FocusPara | null>(null);
  const kin = useRef(new Set<string>());         // keys of paragraphs born from a split here

  const show = useCallback((p: FocusPara | undefined) => {
    const r0 = rangeRef.current;
    if (r0 && !emptyRef.current) {
      const born = parasRef.current.filter((q) => q.from >= r0.from && q.to <= r0.to);
      if (born.length > 1) for (const q of born) kin.current.add(q.key);
    }
    emptyRef.current = false;
    if (!p) { rangeRef.current = null; shownRef.current = ""; keyRef.current = ""; setVer((v) => v + 1); return; }
    rangeRef.current = { from: p.from, to: p.to };
    shownRef.current = textRef.current.slice(p.from, p.to);
    keyRef.current = p.key;
    expectedRef.current = textRef.current;
    lsSet(store, { key: p.key, idx: p.i });
    // writing carries over: switching from inside the paragraph lands in the next one
    refocus.current = document.activeElement?.closest?.("[data-focus-text]") ? "editor" : "keep";
    setVer((v) => v + 1);
  }, [store]);

  // first paragraph: the remembered one, else the one at the caret / top of the view
  const started = useRef(false);
  if (!started.current) {
    started.current = true;
    const mem = lsGet(store);
    const i = mem.key || typeof mem.idx === "number" ? resolvePara(paras, mem.key, mem.idx) : paraAt(paras, startPos ?? 0);
    const p = paras[i];
    if (p) { rangeRef.current = { from: p.from, to: p.to }; shownRef.current = text.slice(p.from, p.to); keyRef.current = p.key; }
  }

  const empty = emptyRef.current;
  const curIdx = rangeRef.current && !empty ? paraAt(paras, rangeRef.current.from) : -1;
  const cur = curIdx >= 0 ? paras[curIdx] : undefined;
  if (cur) lastParaRef.current = cur;
  const at = cur ?? (empty ? lastParaRef.current ?? undefined : undefined);

  // ---- writes: the small editor's change goes into the main editor, nowhere else ----
  const resync = useCallback(() => {
    const ps = parasRef.current, t = textRef.current, r = rangeRef.current;
    expectedRef.current = t;
    if (!r) return;
    if (emptyRef.current) { delete r.framing; r.from = r.to = Math.min(r.from, t.length); setSync((n) => n + 1); return; }
    const i = resolvePara(ps, keyRef.current, paraAt(ps, Math.min(r.from, t.length)));
    const p = ps[i];
    if (!p) return;
    rangeRef.current = { from: p.from, to: p.to };
    keyRef.current = p.key;
    const now = t.slice(p.from, p.to);
    if (now !== shownRef.current) { shownRef.current = now; fed.current?.setContent(now); }
    setSync((n) => n + 1);
  }, []);

  const onChange = useCallback((next: string) => {
    const r = rangeRef.current, v = main.current?.getView();
    if (!r || !v) return;
    const prev = shownRef.current;
    if (next === prev) return;
    const was = emptyRef.current;
    const res = writePane(v, { ...r, empty: was }, prev, next);
    if (!res) { resync(); return; }   // moved under us: never write blind
    rangeRef.current = res;
    emptyRef.current = res.empty;
    shownRef.current = next;
    keyRef.current = paraKey(next);
    expectedRef.current = v.state.doc.toString();
    if (was !== res.empty) setSync((n) => n + 1);
  }, [main, resync]);

  // a change that did not come from here: find the paragraph again and show its text
  useEffect(() => { if (text !== expectedRef.current) resync(); }, [text, resync]);

  // ---- comments: everything anchored in this paragraph -------------------------------
  const liveRanges = (): CRange[] => main.current?.commentRanges() ?? [];
  const rangeOf = (c: DraftComment, live: Map<string, CRange>): { from: number; to: number } | null => {
    // the main editor's live range when it has one; a comment it has not mapped yet (one
    // filed from the CLI a moment ago) is found by its anchor text instead
    return live.get(c.id) ?? locate(text, c);
  };
  const live = new Map(liveRanges().map((r) => [r.id, r] as const));
  void tick;
  const r = rangeRef.current;
  const gapEnd = r ? (paras.find((p) => p.from >= r.to)?.from ?? text.length) : 0;
  const inGap = (at: { from: number; to: number }) => !!r && at.from >= r.to && at.from < gapEnd
    && !paras.some((p) => at.from < p.to && at.to > p.from);
  const here = r && !empty ? comments
    .map((c) => ({ c, at: rangeOf(c, live) }))
    .filter((x) => commentIsOpen(x.c) && x.at && ((x.at.from < Math.max(r.to, r.from + 1) && x.at.to > r.from) || inGap(x.at)))
    .sort((a, b) => (a.c.focusFlag === true ? 0 : 1) - (b.c.focusFlag === true ? 0 : 1)
      || (a.c.author && a.c.author !== "owner" ? 0 : 1) - (b.c.author && b.c.author !== "owner" ? 0 : 1)
      || a.at!.from - b.at!.from || a.c.created - b.c.created) : [];
  const paragraphSuggestionIds = here.filter(({ c }) => suggestionIds.includes(c.id)).map(({ c }) => c.id);
  // Only explicit, open focus flags make a paragraph an issue.
  const issueSet = new Set<number>();
  for (const c of comments) {
    if (!commentIsOpen(c) || c.focusFlag !== true) continue;
    const a = rangeOf(c, live);
    if (!a) continue;
    const i = paraAt(paras, a.from);
    if (i < 0 || a.from < paras[i].from || a.from > paras[i].to) continue;
    issueSet.add(i);
  }
  const curFlags = here.filter((x) => x.c.focusFlag === true && !x.c.resolved).map((x) => x.c.id);
  // issue by issue; the paragraph on screen stays in the walk after its last issue resolves
  const byIssue = issuesOnly;
  const inPane = (p: FocusPara) => !!r && !empty && p.from >= r.from && p.to <= r.to;
  const nav = byIssue ? paras.filter((p) => issueSet.has(p.i) || p.i === cur?.i || inPane(p) || kin.current.has(p.key)) : paras;
  const pos = cur ? nav.findIndex((p) => p.i === cur.i) : -1;

  // push this paragraph's highlights into the small editor (relative offsets)
  const sig = comments.map((c) => c.id + (commentIsOpen(c) ? "" : "r") + (c.kind ?? "")).join("|");
  useEffect(() => {
    const t = setTimeout(() => {
      const rr = rangeRef.current, ed = fed.current;
      if (!rr || !ed) return;
      const lv = main.current?.commentRanges() ?? [];
      const open = new Set(comments.filter(commentIsOpen).map((c) => c.id));
      ed.setCommentRanges(lv.filter((x) => open.has(x.id) && !x.resolved && x.from >= rr.from && x.to <= rr.to)
        .map((x) => ({ ...x, from: x.from - rr.from, to: x.to - rr.from })));
      ed.setActiveComment(activeComment);
    }, 0);
    return () => clearTimeout(t);
  }, [ver, sig, main]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { fed.current?.setActiveComment(activeComment); }, [activeComment]);

  // ---- moving -------------------------------------------------------------------------
  const hole = empty ? rangeRef.current?.from ?? 0 : -1;
  const go = useCallback((dir: 1 | -1) => {
    const list = nav;
    if (!list.length) return;
    let next: FocusPara | undefined;
    if (emptyRef.current) {   // from the hole: the paragraph after it, or the one before
      const h = rangeRef.current?.from ?? 0;
      next = dir > 0 ? list.find((p) => p.from >= h) : [...list].reverse().find((p) => p.from < h);
    } else {
      const i0 = cur?.i ?? -1;
      next = dir > 0 ? list.find((p) => p.i > i0) : [...list].reverse().find((p) => p.i < i0);
    }
    if (next) { onActivate(null); show(next); }
  }, [nav, cur, show, onActivate]);
  const hasPrev = empty ? nav.some((p) => p.from < hole) : nav.some((p) => p.i < (cur?.i ?? -1));
  const hasNext = empty ? nav.some((p) => p.from >= hole) : nav.some((p) => p.i > (cur?.i ?? -1));

  const pendingFocus = useRef<string | null>(null);
  const toggleFlag = () => {
    if (!cur) return;
    if (curFlags.length) { onUnflag(curFlags); return; }
    setNotesCollapsed(false);
    const a = flagAnchor(text, cur);
    const id = onFlag(a.from, a.to);
    if (id) pendingFocus.current = id;   // its card opens on its note box
  };
  useLayoutEffect(() => {
    const id = pendingFocus.current; if (!id) return;
    const el = cardsRef.current?.querySelector<HTMLElement>(`[data-focus-card="${CSS.escape(id)}"] textarea`);
    if (el) { pendingFocus.current = null; el.focus(); }
  });

  // the active comment's card comes into view in the right pane
  useEffect(() => {
    if (!activeComment) return;
    // a press inside the notes pane activates its card: scrolling then would move the
    // button out from under the mouse and the click (Reply, Resolve) would be lost
    if (cardsRef.current?.contains(document.activeElement)) return;
    const el = cardsRef.current?.querySelector<HTMLElement>(`[data-focus-card="${CSS.escape(activeComment)}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeComment]);

  useEffect(() => {
    const h = (e: FocusEvent) => {
      const cm = main.current?.getView()?.contentDOM;
      if (cm && e.target instanceof Node && cm.contains(e.target)) (focusBackInside(rootRef.current, e) ?? rootRef.current)?.focus({ preventScroll: true });
    };
    document.addEventListener("focusin", h, true);
    return () => document.removeEventListener("focusin", h, true);
  }, [main]);
  // it opens with the caret in the paragraph, ready to type
  useEffect(() => { if (fed.current) fed.current.focus(); else rootRef.current?.focus({ preventScroll: true }); }, []);
  // after a switch the old editor is gone: the keys go to the new one, or stay in Focus.
  // A passive effect, so the new editor's own mount effect (which makes its view) has run.
  useEffect(() => {
    const how = refocus.current; refocus.current = null;
    if (how === "editor") { fed.current?.focus(); return; }
    const a = document.activeElement;
    if (how && (!a || a === document.body || !rootRef.current?.contains(a))) rootRef.current?.focus({ preventScroll: true });
  }, [ver]);

  // the drafting menu comments and inserts through the MAIN editor's selection, so the
  // paragraph's selection (or the caret the right-click just placed) is put there first
  const onMenu = (info: { x: number; y: number; hasSelection: boolean }) => {
    if (!onContextMenu || !selectInMain(main.current?.getView(), fed.current?.getView(), rangeRef.current)) return;
    onContextMenu(info);
  };

  const exit = () => onExit(rangeRef.current?.from ?? 0);
  const edit = () => fed.current?.focus();
  const toRoot = () => rootRef.current?.focus({ preventScroll: true });
  const caretAt = (id: string) => {
    const rr = rangeRef.current; const l = main.current?.commentRanges().find((x) => x.id === id);
    if (rr && l) fed.current?.caretTo(Math.max(0, l.from - rr.from)); else fed.current?.focus();
  };

  const MOVE: Record<string, 1 | -1> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 1, ArrowUp: -1 };
  const onKeyDownCapture = (e: React.KeyboardEvent) => {
    if (e.altKey && !e.ctrlKey && !e.metaKey && MOVE[e.key]) {
      e.preventDefault(); e.stopPropagation(); go(MOVE[e.key]);
      return;
    }
    if (e.key === "Escape" && mentionActive) return;   // the @ picker's own Esc (CodeMirror keymap)
    if (e.key === "Escape" && !e.defaultPrevented && (e.target as HTMLElement).closest?.("[data-focus-text] .cm-content")) {
      e.preventDefault(); e.stopPropagation();
      const v = fed.current?.getView();
      if (v && !v.state.selection.main.empty) v.dispatch({ selection: { anchor: v.state.selection.main.head } });
      toRoot();
    }
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.defaultPrevented) return;
    const t = e.target as HTMLElement;
    if (e.key === "Escape") {
      // a text field: back to the layer, keys live. The layer itself: back to the draft.
      e.preventDefault();
      if (typing(t)) { toRoot(); return; }
      exit(); return;
    }
    if (typing(t) || e.ctrlKey || e.metaKey || e.altKey) return;
    const onRoot = t === rootRef.current;
    if (e.key === "j" || (onRoot && (e.key === "ArrowDown" || e.key === "ArrowRight"))) { e.preventDefault(); go(1); return; }
    if (e.key === "k" || (onRoot && (e.key === "ArrowUp" || e.key === "ArrowLeft"))) { e.preventDefault(); go(-1); return; }
    if (e.key === "c" && !e.shiftKey) { e.preventDefault(); toRoot(); setNotesCollapsed(!notesCollapsed); return; }
    if (e.key === "f" && !e.shiftKey) { e.preventDefault(); toggleFlag(); return; }
    if (e.key === "F" || (e.key === "f" && e.shiftKey)) { e.preventDefault(); onIssuesOnly?.(!issuesOnly); return; }
    if ((e.key === "e" || (onRoot && e.key === "Enter")) && (cur || empty)) { e.preventDefault(); edit(); return; }
  };

  const crumb = at ? (at.heading && at.heading !== at.section ? `${at.section} › ${at.heading}` : at.section) : "";
  const arrow = "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50 disabled:opacity-30 disabled:pointer-events-none";

  return (
    <div ref={rootRef} role="dialog" aria-label="Focus" data-knav-modal data-focus-mode data-focus-empty={empty ? "1" : undefined}
      data-review-pos={rangeRef.current?.from ?? 0}
      data-focus-issues={byIssue ? "1" : "0"} data-focus-collapsed={notesCollapsed ? "1" : "0"} tabIndex={-1}
      onKeyDownCapture={onKeyDownCapture} onKeyDown={onKeyDown}
      className="absolute inset-0 z-[45] flex flex-col bg-background text-foreground focus:outline-none">
      <div data-focus-head className="flex h-8 shrink-0 items-center gap-1 border-b border-border/60 px-3">
        <button type="button" data-focus-prev className={arrow} onClick={() => go(-1)} disabled={!hasPrev}
          title={byIssue ? "Previous issue (←)" : "Previous paragraph (←)"}><ChevronLeft size={14} /></button>
        <span data-focus-count className="min-w-[3.5rem] shrink-0 text-center text-[11px] tabular-nums text-muted-foreground"
          title={byIssue ? `Issue ${pos + 1} of ${nav.length}: explicitly flagged paragraphs` : `Paragraph ${pos + 1} of ${nav.length}`}>
          {pos >= 0 ? pos + 1 : "–"} / {nav.length}</span>
        <button type="button" data-focus-next className={arrow} onClick={() => go(1)} disabled={!hasNext}
          title={byIssue ? "Next issue (→)" : "Next paragraph (→)"}><ChevronRight size={14} /></button>
        <span data-focus-section className="ml-2 min-w-0 truncate text-[11px] text-muted-foreground/70" title={crumb}>{crumb}</span>
        <span className="flex-1" />
        <button type="button" data-focus-collapse aria-expanded={!notesCollapsed} className={arrow}
          title={notesCollapsed ? "Show note (c)" : "Hide note (c)"} onClick={() => setNotesCollapsed(!notesCollapsed)}>
          {notesCollapsed ? <PanelRightOpen size={14} /> : <PanelRightClose size={14} />}
        </button>
        {curFlags.length > 0 && <span data-focus-flagged title="Flagged (f)" className="text-primary"><Flag size={12} className="fill-current" /></span>}
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto tinybar">
          <div data-focus-text className="mx-auto w-full px-3 py-5 sm:px-6 sm:py-8 [&_.cm-content]:!max-w-none"
            style={notesCollapsed ? undefined : { maxWidth: "calc(var(--draft-measure, 760px) + 64px)" }}>
            {cur || empty ? (
              <MarkdownEditor key={ver} ref={fed} value={shownRef.current} onChange={onChange}
                slug={slug} style={style} zoom={zoom} citeMap={citeMap}
                onCitationClick={onCitationClick} onCitePage={onCitePage} onSave={onSave}
                onMention={onMention} onMentionKey={onMentionKey} mentionActive={mentionActive}
                onCursorComment={(id, o) => { if (id && o.pointer) onActivate(id); }}
                onRequestComment={(sel) => { const rr = rangeRef.current; if (rr) onRequestComment({ ...sel, from: sel.from + rr.from, to: sel.to + rr.from }); }}
                paragraphEnter
                onContextMenu={onContextMenu ? onMenu : undefined}
                placeholder="" />
            ) : (
              <div className="py-10 text-center text-[12px] text-muted-foreground">No paragraphs</div>
            )}
          </div>
        </div>
        {here.length > 0 && (
          <div ref={cardsRef} data-focus-cards
            style={notesCollapsed ? { display: "none" } : undefined}
            className="min-h-0 min-w-0 w-[48%] shrink-0 space-y-3 overflow-y-auto tinybar border-l border-border/60 bg-background p-2 sm:p-4">
            {paragraphSuggestionIds.length > 0 && <div className="flex justify-end">
              <button type="button" data-focus-accept title={`Accept ${paragraphSuggestionIds.length} open suggestions in this paragraph; Undo restores the batch`}
                onClick={() => { toRoot(); onAccept(paragraphSuggestionIds); }}
                className="rounded px-2 py-0.5 text-[11px] text-primary hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50">Accept</button>
            </div>}
            {here.map(({ c }) => (
              <div key={c.id} data-focus-card={c.id}>
                {renderCard(c, { onEscapeToText: () => caretAt(c.id), onLocate: () => caretAt(c.id), escapeTo: toRoot })}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
