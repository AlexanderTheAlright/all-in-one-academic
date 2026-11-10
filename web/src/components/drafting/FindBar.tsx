
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { CaseSensitive, ChevronDown, ChevronRight, ChevronUp, Regex, Search, WholeWord, X } from "lucide-react";
import { layerAbove } from "@/lib/arrownav";
import { typingEscape } from "@/components/draftingShared";
import { EMPTY_QUERY, NO_COUNT } from "@/lib/cmFind";
import type { FindCount, FindQuery, FindTarget } from "@/lib/cmFind";

const DEBOUNCE_MS = 80;
// whether the replace row is folded is remembered for the window, not persisted: it is
// a posture inside one sitting, like the @-picker's mode
let replaceMemo = false;

export type FindBarHandle = {
  /** Ctrl+F on an open bar: put the keys back in the field and select what is there */
  focusFind: (selectAll?: boolean) => void;
  step: (dir: 1 | -1) => void;
  openReplace: () => void;
  /** true while the keys are inside the bar */
  holdsFocus: () => boolean;
};

const FindBar = forwardRef<FindBarHandle, {
  target: FindTarget | null;
  
  docVersion?: unknown;
  replaceOpen: boolean;
  onReplaceOpen: (v: boolean) => void;
  onClose: () => void;
  className?: string;
}>(function FindBar({ target, docVersion, replaceOpen, onReplaceOpen, onClose, className }, ref) {
  const [q, setQ] = useState<FindQuery>(EMPTY_QUERY);
  const [n, setN] = useState<FindCount>(NO_COUNT);
  const rootRef = useRef<HTMLDivElement>(null);
  const findRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLInputElement>(null);
  const qRef = useRef(q);
  qRef.current = q;

  useImperativeHandle(ref, () => ({
    focusFind: (selectAll = true) => {
      const el = findRef.current;
      if (!el) return;
      el.focus({ preventScroll: true });
      if (selectAll) el.select();
    },
    step: (dir) => { if (target) setN(target.step(dir)); },
    openReplace: () => { replaceMemo = true; onReplaceOpen(true); },
    holdsFocus: () => !!rootRef.current?.contains(document.activeElement),
  }), [target, onReplaceOpen]);

  // pre-fill from a short single-line selection, the way every editor's find does
  useEffect(() => {
    if (!target) return;
    const sel = target.selectionText();
    if (sel) setQ((p) => ({ ...p, search: sel }));
    const id = requestAnimationFrame(() => { findRef.current?.focus({ preventScroll: true }); findRef.current?.select(); });
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per bar, per engine
  }, [target]);

  // typing searches live; the engine lands on the first match at or after the caret
  // and scrolls it in without ever taking the keys out of the field
  useEffect(() => {
    if (!target) { setN(NO_COUNT); return; }
    const t = setTimeout(() => setN(target.setQuery(qRef.current)), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [target, q.search, q.caseSensitive, q.wholeWord, q.regexp, q.replace]);

  useEffect(() => { if (target) setN(target.count()); }, [target, docVersion]);
  useEffect(() => target?.subscribe(() => { if (target) setN(target.count()); }), [target]);

  const step = useCallback((dir: 1 | -1) => { if (target) setN(target.step(dir)); }, [target]);
  const replaceOne = useCallback(() => { if (target?.canReplace) setN(target.replaceOne()); }, [target]);
  const replaceAll = useCallback(() => { if (target?.canReplace) setN(target.replaceAll()); }, [target]);
  const toggleReplace = useCallback(() => { replaceMemo = !replaceOpen; onReplaceOpen(!replaceOpen); }, [replaceOpen, onReplaceOpen]);

  const set = (patch: Partial<FindQuery>) => setQ((p) => ({ ...p, ...patch }));
  const toggle = (k: "caseSensitive" | "wholeWord" | "regexp") => setQ((p) => ({ ...p, [k]: !p[k] }));

  // Alt+C / Alt+W / Alt+R anywhere in the bar
  const optionKey = (e: React.KeyboardEvent): boolean => {
    if (!e.altKey || e.ctrlKey || e.metaKey) return false;
    const k = e.key.toLowerCase();
    if (k !== "c" && k !== "w" && k !== "r") return false;
    e.preventDefault();
    toggle(k === "c" ? "caseSensitive" : k === "w" ? "wholeWord" : "regexp");
    return true;
  };

  /* Escape on the engine's terms: a field still holding text spends the first press
     leaving the typing (arrownav arms it), and the next press closes the bar. */
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.defaultPrevented) return;
    if (optionKey(e)) return;
    if (e.key === "Escape") {
      if (typingEscape(e.nativeEvent) && (e.target as HTMLInputElement | null)?.value
          && document.documentElement.hasAttribute("data-knav")) return;
      e.preventDefault(); e.stopPropagation();
      onClose();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const inReplace = e.target === replaceRef.current;
      if (inReplace && (e.ctrlKey || e.metaKey)) replaceAll();
      else if (inReplace) replaceOne();
      else step(e.shiftKey ? -1 : 1);
    }
  };

  const empty = !q.search;
  const bad = !empty && (!n.valid || n.total === 0);
  const counter = empty ? "" : !n.valid ? "0" : n.total === 0 ? "0"
    : `${n.current || 1} / ${n.capped ? "9999+" : n.total}`;
  const counterTip = !n.valid && !empty ? "That regular expression can't be parsed"
    : target?.scope ? "Matches " + target.scope : "Matches in this document";

  const pill = (on: boolean) =>
    `inline-flex items-center justify-center w-7 h-[26px] transition-colors ${on
      ? "bg-primary/15 text-primary font-medium"
      : "text-muted-foreground hover:text-foreground hover:bg-accent"}`;
  const icon = "inline-flex items-center justify-center w-7 h-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:opacity-40 disabled:pointer-events-none";

  return (
    <div ref={rootRef} data-find-bar role="search" aria-label="Find and replace" onKeyDown={onKeyDown}
      className={`w-[420px] max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-card shadow-pop overflow-hidden animate-in fade-in slide-in-from-top-1 duration-100 ${className || ""}`}>
      <div className="flex items-center gap-1 px-2 py-1.5">
        <button type="button" data-find="chevron" onClick={toggleReplace} aria-expanded={replaceOpen}
          title={replaceOpen ? "Hide replace (⌘H)" : "Replace (⌘H)"} className={icon}>
          {replaceOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <div className={`relative flex-1 min-w-0 flex items-center rounded-md border bg-background transition-colors ${bad ? "border-destructive/70" : "border-border focus-within:border-primary/50"}`}>
          <Search size={13} className="absolute left-2 text-muted-foreground pointer-events-none" />
          <input ref={findRef} data-find="input" data-knav-own="arrows enter escape"
            value={q.search} onChange={(e) => set({ search: e.target.value })}
            placeholder="Find" aria-label="Find" spellCheck={false}
            className="w-full h-[30px] bg-transparent border-0 pl-7 pr-[4.5rem] text-[12.5px] focus:outline-none placeholder:text-muted-foreground/60" />
          {counter && <span data-find="count" title={counterTip}
            className={`absolute right-2 text-[11px] nums tabular-nums ${bad ? "text-destructive" : "text-muted-foreground"}`}>{counter}</span>}
        </div>
        <div className="inline-flex shrink-0 rounded-md border border-border overflow-hidden">
          <button type="button" data-find="case" data-on={q.caseSensitive ? "1" : "0"} onClick={() => toggle("caseSensitive")}
            title="Match case (Alt+C)" aria-pressed={q.caseSensitive} className={pill(q.caseSensitive)}><CaseSensitive size={14} /></button>
          <button type="button" data-find="word" data-on={q.wholeWord ? "1" : "0"} onClick={() => toggle("wholeWord")}
            title="Whole word (Alt+W)" aria-pressed={q.wholeWord} className={pill(q.wholeWord)}><WholeWord size={14} /></button>
          <button type="button" data-find="regex" data-on={q.regexp ? "1" : "0"} onClick={() => toggle("regexp")}
            title="Regular expression (Alt+R)" aria-pressed={q.regexp} className={pill(q.regexp)}><Regex size={13} /></button>
        </div>
        <div className="h-4 w-px bg-border shrink-0 mx-0.5" />
        <button type="button" data-find="prev" onClick={() => step(-1)} title="Previous match (Shift+Enter)" aria-label="Previous match" className={icon}><ChevronUp size={14} /></button>
        <button type="button" data-find="next" onClick={() => step(1)} title="Next match (Enter)" aria-label="Next match" className={icon}><ChevronDown size={14} /></button>
        <button type="button" data-find="close" onClick={onClose} title="Close find (Esc)" aria-label="Close find" className={icon}><X size={14} /></button>
      </div>
      {replaceOpen && (
        <div className="flex items-center gap-1 px-2 pb-1.5">
          <span className="w-7 shrink-0" />
          <input ref={replaceRef} data-find="replace-input" data-knav-own="arrows enter escape"
            value={q.replace} onChange={(e) => set({ replace: e.target.value })}
            placeholder="Replace" aria-label="Replace" spellCheck={false} disabled={!target?.canReplace}
            className="flex-1 min-w-0 h-[30px] rounded-md border border-border bg-background px-2 text-[12.5px] focus:outline-none focus:border-primary/50 placeholder:text-muted-foreground/60 disabled:opacity-50" />
          <button type="button" data-find="replace-one" onClick={replaceOne} disabled={!target?.canReplace || !q.search}
            title={target?.canReplace ? "Replace this match (Enter)" : "A rendered page can't be edited — switch back to the editor to replace"}
            className="shrink-0 rounded-md border border-border px-2.5 h-[30px] text-[11.5px] text-muted-foreground hover:text-foreground hover:border-primary/50 hover:bg-accent transition-colors disabled:opacity-40 disabled:pointer-events-none">Replace</button>
          <button type="button" data-find="replace-all" onClick={replaceAll} disabled={!target?.canReplace || !q.search}
            title={target?.canReplace ? "Replace every match (⌘Enter)" : "A rendered page can't be edited — switch back to the editor to replace"}
            className="shrink-0 rounded-md border border-border px-2.5 h-[30px] text-[11.5px] text-muted-foreground hover:text-foreground hover:border-primary/50 hover:bg-accent transition-colors disabled:opacity-40 disabled:pointer-events-none">Replace all</button>
        </div>
      )}
    </div>
  );
});

/** Own Ctrl/Cmd+F for one editor surface, and render its bar. */
export function useFind(cfg: {
  /** the surface is up and has something to search */
  enabled: boolean;
  /** rebuild the engine whenever this changes (edit / page view / visual) */
  targetKey: string;
  makeTarget: () => FindTarget | null;
  rootRef: RefObject<HTMLElement | null>;
  /** a split pane answers only for the presses that belong to it */
  owns?: (e: KeyboardEvent) => boolean;
  docVersion?: unknown;
  className?: string;
}): { open: boolean; toggle: () => void; close: () => void; node: ReactNode } {
  const { enabled, targetKey, makeTarget, rootRef, owns, docVersion, className } = cfg;
  const [open, setOpen] = useState(false);
  const [replaceOpen, setReplaceOpen] = useState(replaceMemo);
  const barRef = useRef<FindBarHandle>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const openRef = useRef(open);
  openRef.current = open;

  const target = useMemo(() => (open && enabled ? makeTarget() : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the key says when to rebuild
    [open, enabled, targetKey]);
  const targetRef = useRef<FindTarget | null>(null);
  targetRef.current = target;

  // every engine clears up after itself — on close, on a mode switch, on unmount
  useEffect(() => () => { target?.clear(); }, [target]);

  const close = useCallback(() => {
    const t = targetRef.current;
    setOpen(false);
    t?.clear();
    // the caret lands on the current match; a rendered surface has none, so the keys
    // go back where they came from
    if (t?.kind === "cm") t.restoreFocus();
    else openerRef.current?.focus?.({ preventScroll: true });
    openerRef.current = null;
  }, []);

  const openBar = useCallback((withReplace: boolean) => {
    if (!openRef.current) openerRef.current = document.activeElement as HTMLElement | null;
    setOpen(true);
    if (withReplace) { replaceMemo = true; setReplaceOpen(true); }
    requestAnimationFrame(() => barRef.current?.focusFind(true));
  }, []);

  const toggle = useCallback(() => { if (openRef.current) close(); else openBar(false); }, [close, openBar]);

  useEffect(() => {
    if (!enabled) return;
    const h = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      // a dialog, the command palette or any marked layer above us holds the keyboard
      if (layerAbove(rootRef.current)) return;
      // a source PDF on top hands Ctrl+F to the browser's find (pdfFindKey)
      if (document.querySelector("[data-native-find]")) return;
      if (owns && !owns(e)) return;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();

      if (mod && !e.altKey && key === "f") { e.preventDefault(); e.stopPropagation(); openBar(false); return; }
      if ((mod && key === "h") || (mod && e.altKey && key === "f")) { e.preventDefault(); e.stopPropagation(); openBar(true); barRef.current?.openReplace(); return; }
      if (!openRef.current) return;

      if (e.key === "F3" || (mod && key === "g")) { e.preventDefault(); e.stopPropagation(); barRef.current?.step(e.shiftKey ? -1 : 1); return; }
      
      if (e.key === "Escape" && !barRef.current?.holdsFocus()) { e.preventDefault(); close(); }
    };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [enabled, rootRef, owns, openBar, close]);

  // the surface went away (the pane closed, the document changed) — never leave a bar behind
  useEffect(() => { if (!enabled && openRef.current) { setOpen(false); openerRef.current = null; } }, [enabled]);

  return {
    open,
    toggle,
    close,
    node: open && enabled
      ? <FindBar ref={barRef} target={target} docVersion={docVersion} replaceOpen={replaceOpen}
          onReplaceOpen={setReplaceOpen} onClose={close} className={className} />
      : null,
  };
}
