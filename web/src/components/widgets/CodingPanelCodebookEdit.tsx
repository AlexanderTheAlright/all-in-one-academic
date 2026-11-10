
import { createContext, forwardRef, useCallback, useContext, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Plus, StickyNote, X } from "lucide-react";
import { CODING_LIMITS, codingApi, type CodingCode, type CodingCodebook, type CodingDraft, type CodingDraftCode, type CodingDraftOp,
  type CodingDraftResult, type CodingExample, type CodingLimits, type CodingLogEntry } from "@/lib/api";
import { useSaveKey } from "@/lib/savekey";

const DRAFT_DEBOUNCE = 250;
const SILENT = "not saved: the Board didn't answer";

type FieldKind = "line" | "text" | "list" | "examples";
export type FieldDef = { wire: string; key: keyof CodingCode; title: string; kind: FieldKind };
export const FIELDS: FieldDef[] = [
  { wire: "label", key: "label", title: "Label", kind: "line" },
  { wire: "display", key: "display", title: "Name", kind: "line" },
  { wire: "short", key: "short", title: "Short", kind: "text" },
  { wire: "definition", key: "definition", title: "Definition", kind: "text" },
  { wire: "decision_rules", key: "decisionRules", title: "Decision rules", kind: "list" },
  { wire: "inclusion_criteria", key: "inclusion", title: "Include", kind: "list" },
  { wire: "exclusion_criteria", key: "exclusion", title: "Exclude", kind: "list" },
  { wire: "positive_examples", key: "positive", title: "Examples", kind: "examples" },
  { wire: "negative_examples", key: "negative", title: "Near misses", kind: "examples" },
  { wire: "confusable_with", key: "confusable", title: "Confusable with", kind: "list" },
];
const fieldOf = (wire: string) => FIELDS.find((f) => f.wire === wire);
export const fieldTitle = (wire: string) => fieldOf(wire)?.title || wire;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** a lookup by code label or id that can never reach the prototype chain */
export const own = <T,>(o: Record<string, T> | null | undefined, k: string): T | undefined =>
  (o && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);
/** the server refuses a carriage return: pasted text is made \n-only before it is sent */
const nl = (s: string) => s.replace(/\r\n?/g, "\n");
/** a single-line field takes no line break and no tab, typed or pasted */
export const flat = (s: string) => s.replace(/[\r\n\t\u2028\u2029]+/g, " ");
const ONE_LINE = new Set(["label", "display", "short"]);
const lines = (s: string) => nl(s).split("\n").map((x) => x.trim()).filter(Boolean);
const pairs = (v: CodingExample[]) => v.map((x) => ({ text: nl(x.text).trim(), reasoning: nl(x.reasoning).trim() })).filter((x) => x.text || x.reasoning);

type Pending = { op: Extract<CodingDraftOp, { op: "set" }>; unit: string | null };
export type BookState = "idle" | "saving" | "saved" | "error";
export type Promoted = { version: string; revisit: number; shared: string[] };

export function useCodebookDraft({ project, set, unitId, stamp, beforePromote, onPromoted }: {
  project: string; set: string; unitId: string | null; stamp: string;
  beforePromote?: () => Promise<void> | void; onPromoted?: (r: CodingDraftResult) => void;
}) {
  const [book, setBookS] = useState<CodingCodebook | null>(null);
  const [loadErr, setLoadErr] = useState("");
  const [state, setState] = useState<BookState>("idle");
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [why, setWhyS] = useState("");
  const [promoted, setPromoted] = useState<Promoted | null>(null);
  const [tick, setTick] = useState(0);
  const bookRef = useRef<CodingCodebook | null>(null);
  const rev = useRef<number | null>(null);
  const pending = useRef(new Map<string, Pending>());
  const single = useRef<[string, Pending][]>([]);
  const dirty = useRef(new Map<string, unknown>());
  const running = useRef<Promise<void> | null>(null);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const timer = useRef<number | null>(null);
  const whyRef = useRef("");
  const unitRef = useRef(unitId);
  unitRef.current = unitId;
  const wanted = useRef(false);
  const gen = useRef(0);
  const seq = useRef(0);
  const hooks = useRef({ beforePromote, onPromoted });
  hooks.current = { beforePromote, onPromoted };

  const setBook = useCallback((b: CodingCodebook | null) => { bookRef.current = b; setBookS(b); }, []);
  const setWhy = useCallback((s: string) => { whyRef.current = s; setWhyS(s); }, []);
  const setErr = useCallback((at: string | string[], msg: string) => setErrs((cur) => {
    const next = { ...cur };
    for (const k of Array.isArray(at) ? at : [at]) { if (msg) next[k] = msg; else delete next[k]; }
    return next;
  }), []);
  /** the server cannot read the draft file: nothing is reapplied, and Discard is the way out */
  const broken = useCallback((msg: string) => {
    rev.current = null;
    const b = bookRef.current;
    if (b) setBook({ ...b, draft: null, unreadable: msg || "the draft cannot be read" });
  }, [setBook]);
  const take = useCallback((draft: CodingDraft | null, log: CodingLogEntry[] = []) => {
    rev.current = draft ? draft.rev : null;
    const b = bookRef.current;
    if (b) setBook({ ...b, draft, log: log.length ? [...log.slice().reverse(), ...b.log].slice(0, 200) : b.log });
  }, [setBook]);

  const send = useCallback((ops: CodingDraftOp[], unit: string | null, text: string) =>
    codingApi.codebookEdit({ project, set, baseRev: rev.current, unitId: unit, why: nl(text), ops }).catch(() => null), [project, set]);
  /** the draft as the server holds it now, after a 409 that did not carry one */
  const refetch = useCallback(async () => {
    const d = await codingApi.codebook(project, set).catch(() => null);
    if (d && d.ok) take(d.draft);
  }, [project, set, take]);

  const pump = useCallback((): Promise<void> => {
    if (running.current) return running.current;
    const g = gen.current;
    const run = (async () => {
      let conflicts = 0;
      while (single.current.length || pending.current.size) {
        const one = single.current.shift();
        const batch = one ? [one] : Array.from(pending.current.entries());
        if (!one) pending.current.clear();
        const sentWhy = whyRef.current;
        setState("saving");
        const r = await send(batch.map(([, p]) => p.op), batch[batch.length - 1][1].unit, sentWhy);
        if (g !== gen.current) return;
        const keys = batch.map(([k]) => k);
        const again = () => { for (const [k, p] of batch) if (!pending.current.has(k)) pending.current.set(k, p); };
        if (r && r.ok) {
          conflicts = 0;
          take(r.draft, r.logAdded);
          for (const [k, p] of batch) if (!pending.current.has(k) && same(dirty.current.get(k), p.op.value)) dirty.current.delete(k);
          setErr(keys, "");
          if (sentWhy && whyRef.current === sentWhy) setWhy("");
          setTick((t) => t + 1);
          if (!pending.current.size && !single.current.length) setState("saved");
        } else if (r && r.unreadable) {
          broken(r.error);
          setErr(keys, r.error);
          setState("error");
          break;
        } else if (r && r.status === 409) {
          if (r.hasDraft) take(r.draft); else await refetch();
          again();
          if (++conflicts > 3) { setErr(keys, r.error || "changed in another window"); setState("error"); break; }
        } else if (r && batch.length > 1) {
          // one bad field must not hold the others back: each goes alone
          for (const x of batch) if (!pending.current.has(x[0])) single.current.push(x);
        } else {
          setState("error");
          setErr(keys, r ? r.error : SILENT);
          if (!r) { again(); break; }
        }
      }
    })();
    running.current = run.finally(() => { running.current = null; });
    return running.current;
  }, [send, take, refetch, setErr, setWhy, broken]);

  const flush = useCallback(async () => {
    if (timer.current !== null) { window.clearTimeout(timer.current); timer.current = null; }
    await pump();
    if (pending.current.size) await pump();
  }, [pump]);

  const setField = useCallback((code: string, field: string, value: unknown) => {
    const k = code + "|" + field;
    const had = dirty.current.has(k);
    pending.current.set(k, { op: { op: "set", code, field, value }, unit: unitRef.current });
    dirty.current.set(k, value);
    setErrs((cur) => { if (!(k in cur)) return cur; const next = { ...cur }; delete next[k]; return next; });
    if (!had) setTick((t) => t + 1);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { timer.current = null; void pump(); }, DRAFT_DEBOUNCE);
  }, [pump]);

  /** add, remove, restore, move, memo: one at a time, each made from the draft as it then stands */
  const act = useCallback((make: (b: CodingCodebook | null) => CodingDraftOp | null, at: string, text?: string): Promise<CodingDraftResult | null> => {
    const g = gen.current;
    const job = chain.current.then(async () => {
      await flush();
      const op = make(bookRef.current);
      if (!op || g !== gen.current) return null;
      setState("saving");
      const w = text ?? whyRef.current;
      let r = await send([op], unitRef.current, w);
      if (r && r.status === 409 && !r.unreadable) {
        if (r.hasDraft) take(r.draft); else await refetch();
        r = await send([op], unitRef.current, w);
      }
      if (g !== gen.current) return r;
      if (r && r.unreadable) broken(r.error);
      if (r && r.ok) {
        take(r.draft, r.logAdded);
        setErr(at, "");
        if (text === undefined && w && whyRef.current === w) setWhy("");
        setState("saved");
        // a memo sets an unreadable log aside: the Changes view reads the new one
        if (bookRef.current?.logError) void load();
      } else {
        setErr(at, r ? r.error : SILENT);
        setState("error");
      }
      return r;
    });
    chain.current = job.catch(() => null);
    return job;
  }, [flush, send, take, refetch, setErr, setWhy, broken]);

  const load = useCallback(async () => {
    if (!project || !set) return;
    wanted.current = true;
    const my = ++seq.current;
    const g = gen.current;
    await flush();
    const d = await codingApi.codebook(project, set).catch(() => null);
    if (my !== seq.current || g !== gen.current) return;
    if (!d || !d.ok) { setLoadErr(d?.error || "the codebook didn't answer"); return; }
    setLoadErr("");
    // a draft read while a save is queued or flying is already old
    const busy = pending.current.size > 0 || !!running.current;
    if (!busy) rev.current = d.draft ? d.draft.rev : null;
    setBook(busy && bookRef.current ? { ...d, draft: bookRef.current.draft } : d);
  }, [project, set, flush, setBook]);
  const want = useCallback(() => { if (!wanted.current) void load(); }, [load]);

  // another set: what was queued goes to the set it was typed in, then a clean slate
  useEffect(() => () => {
    void flush();
    gen.current += 1;
    wanted.current = false;
    rev.current = null;
    pending.current = new Map();
    single.current = [];
    dirty.current = new Map();
    chain.current = Promise.resolve();
    setBook(null); setErrs({}); setState("idle"); setWhy(""); setPromoted(null); setLoadErr("");
  }, [project, set]);  // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (wanted.current) void load(); }, [stamp]);  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { void flush(); }, [unitId, flush]);
  useSaveKey(() => flush());

  useEffect(() => {
    const now = () => { if (timer.current !== null) { window.clearTimeout(timer.current); timer.current = null; } };
    const hidden = () => { if (document.visibilityState === "hidden") { now(); void pump(); } };
    const dying = () => {
      now();
      if (!running.current) { void pump(); return; }
      // a save is already flying: what was typed since goes behind it on the same rev
      const batch = Array.from(pending.current.values());
      pending.current.clear();
      if (batch.length) void send(batch.map((p) => p.op), batch[batch.length - 1].unit, whyRef.current);
    };
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", dying);
    return () => { document.removeEventListener("visibilitychange", hidden); window.removeEventListener("pagehide", dying); };
  }, [pump, send]);

  /** leaving the editor: everything queued, and a why typed after the last save as a memo */
  const leave = useCallback(async () => {
    await flush();
    const w = whyRef.current.trim();
    if (w && !pending.current.size) { const r = await act(() => ({ op: "memo" }), "why", w); if (r && r.ok) setWhy(""); }
  }, [flush, act, setWhy]);

  const after = useCallback(async (r: CodingDraftResult | null, at: string) => {
    if (r && r.ok) { setErr(at, ""); setState("saved"); } else { setErr(at, r ? (r.status === 423 ? r.lockReason || r.error : r.error) : SILENT); setState("error"); }
    if (r) await load();
    return r;
  }, [setErr, load]);
  const discard = useCallback(async () => {
    await flush();
    const r = await codingApi.codebookDiscard({ project, set, baseRev: rev.current }).catch(() => null);
    if (r && r.ok) { dirty.current = new Map(); pending.current = new Map(); single.current = []; rev.current = null; setErrs({}); setTick((t) => t + 1); }
    return after(r, "discard");
  }, [project, set, flush, after]);
  /* a rebase re-keys the draft's ids: what is queued goes first, and anything still keyed
   * by an old id when the answer lands is dropped rather than sent */
  const rebase = useCallback(async () => {
    await flush();
    const r = await codingApi.codebookRebase({ project, set, baseRev: rev.current }).catch(() => null);
    if (r && r.ok) { dirty.current = new Map(); pending.current = new Map(); single.current = []; setErrs({}); setTick((t) => t + 1); }
    return after(r, "promote");
  }, [project, set, flush, after]);
  const promote = useCallback(async (version: string, note: string) => {
    await flush();
    if (dirty.current.size) { setErr("promote", "a field is not saved yet"); return null; }
    await hooks.current.beforePromote?.();
    const r = await codingApi.codebookPromote({ project, set, baseRev: rev.current, version: nl(version), note: nl(note) }).catch(() => null);
    if (r && r.ok) {
      rev.current = null;
      setPromoted({ version: r.version || version, revisit: r.revisitCount, shared: r.sharedWith });
    }
    await after(r, "promote");
    // a promotion that failed part-way can have moved the set too: it is read again with the codebook
    if (r && (r.ok || r.status >= 500)) hooks.current.onPromoted?.(r);
    return r;
  }, [project, set, flush, after, setErr]);

  const view = useMemo(() => {
    void tick;
    const base: CodingDraftCode[] = book ? (book.draft ? book.draft.codes : book.codes.map((c) => ({ ...c, id: c.label, removed: false }))) : [];
    const typed = new Map<string, Record<string, unknown>>();
    for (const [k, v] of dirty.current) {
      const i = k.lastIndexOf("|");
      const id = k.slice(0, i);
      typed.set(id, { ...(typed.get(id) || {}), [k.slice(i + 1)]: v });
    }
    const codes = base.map((c) => {
      const t = typed.get(c.id);
      if (!t) return c;
      const next = { ...c } as Record<string, unknown>;
      for (const [wire, v] of Object.entries(t)) { const f = fieldOf(wire); if (f) next[f.key] = v; }
      return next as unknown as CodingDraftCode;
    });
    const d = book?.draft || null;
    const fields = (id: string): string[] => {
      const out = new Set<string>(own(d?.changed, id) || []);
      if (own(d?.renamed, id)) out.add("label");
      for (const wire of own(d?.reverts, id) || []) out.add(wire);
      for (const wire of Object.keys(typed.get(id) || {})) out.add(wire);
      return Array.from(out);
    };
    const marks = new Set<string>();
    for (const c of codes) if (c.removed || d?.added.includes(c.id) || fields(c.id).length) marks.add(c.id);
    const overrides = (id: string): string[] => own(d?.reverts, id) || [];
    return { codes, fields, marks, overrides, added: new Set(d?.added || []) };
  }, [book, tick]);

  return { setId: set, peek: () => bookRef.current, book, loadErr, state, errs, setErr, why, setWhy, promoted, clearPromoted: () => setPromoted(null),
    codes: view.codes, fields: view.fields, marks: view.marks, overrides: view.overrides, added: view.added,
    want, load, flush, leave, setField, act, discard, rebase, promote,
    memo: (text: string) => act(() => ({ op: "memo" }), "memo", text) };
}
export type DraftBook = ReturnType<typeof useCodebookDraft>;

/* ------------------------------------------------------------------------ the marks */

/** a code or a field that differs in the draft */
export function DraftDot({ title = "Differs in the draft" }: { title?: string }) {
  return <span data-coding-draft-mark title={title} className="inline-block h-[6px] w-[6px] shrink-0 rounded-full bg-warning" />;
}

export const OverCtx = createContext<string[]>([]);
export const OVERRIDE_TIP = "another promotion also changed this; yours is kept";
export function OverrideDot() {
  return <span data-cb-override title={OVERRIDE_TIP} className="inline-block h-[6px] w-[6px] shrink-0 rounded-full bg-danger" />;
}

/** the same mark as a toggle: the wording in use, shown above the draft's */
export function DraftMark({ on, onToggle, wire }: { on: boolean; onToggle: () => void; wire: string }) {
  const over = useContext(OverCtx).includes(wire);
  return (
    <>
    <button type="button" data-knav-item data-cb-mark={wire} aria-pressed={on} onClick={onToggle} onMouseDown={(e) => e.preventDefault()}
      title={(on ? "Hide" : "Show") + " the wording in use (Alt+B in the field, b outside it)"}
      className={"inline-flex h-4 w-4 shrink-0 items-center justify-center rounded outline-none hover:bg-accent focus-visible:ring-1 focus-visible:ring-primary/60 "
        + (on ? "bg-accent" : "")}>
      <span className="h-[6px] w-[6px] rounded-full bg-warning" />
    </button>
    {over && <OverrideDot />}
    </>
  );
}

const HEAD = "text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground";

/** a field's value as the codebook in use has it */
export function Before({ code, wire }: { code: CodingCode | null; wire: string }) {
  const f = fieldOf(wire);
  const v = code && f ? code[f.key] : null;
  const empty = v === null || v === "" || (Array.isArray(v) && !v.length);
  return (
    <div data-cb-before={wire} title="In use"
      className="tinybar mb-1 max-h-24 overflow-y-auto rounded-md border-l-2 border-warning/60 bg-muted/50 px-2 py-1 text-[11.5px] leading-[1.45] text-muted-foreground">
      {empty ? <span>–</span>
        : typeof v === "string" ? <p className="whitespace-pre-wrap break-words">{v}</p>
        : f?.kind === "examples" ? (v as CodingExample[]).map((x, i) => (
          <p key={i} className="break-words"><span className="italic">{x.text}</span>{x.reasoning ? " · " + x.reasoning : ""}</p>))
        : <ul className="list-disc pl-4">{(v as string[]).map((x, i) => <li key={i} className="break-words">{x}</li>)}</ul>}
    </div>
  );
}

/* ----------------------------------------------------------------------- the editor */

type Vals = { text: Record<string, string>; ex: Record<string, CodingExample[]> };
const valsOf = (c: CodingCode): Vals => {
  const text: Record<string, string> = {};
  const ex: Record<string, CodingExample[]> = {};
  for (const f of FIELDS) {
    const v = c[f.key];
    if (f.kind === "examples") ex[f.wire] = (v as CodingExample[]).map((x) => ({ ...x }));
    else text[f.wire] = f.kind === "list" ? (v as string[]).join("\n") : String(v ?? "");
  }
  return { text, ex };
};
const capOf = (L: CodingLimits, wire: string): number | undefined =>
  wire === "label" ? L.label : wire === "display" ? L.display : wire === "short" ? L.short : wire === "definition" ? L.definition : undefined;

/** tab: false at either end, where the drawer takes the focus on to the why line */
export type EditorHandle = { tab: (d: 1 | -1) => boolean; edge: (d: 1 | -1) => void; before: () => void; dropExample: () => boolean };

const BOX = "block w-full rounded-md border border-border/70 bg-background px-2 py-1.5 text-[12.5px] leading-[1.5] text-foreground outline-none "
  + "placeholder:text-muted-foreground/60 focus:border-primary/60 ";
const AREA = BOX + "tinybar resize-none overflow-y-auto ";
const GROW: Record<string, string> = {
  short: "[field-sizing:content] min-h-[calc(1*1.5em+14px)] max-h-[calc(4*1.5em+14px)]",
  definition: "[field-sizing:content] min-h-[calc(4*1.5em+14px)] max-h-[calc(12*1.5em+14px)]",
  list: "[field-sizing:content] min-h-[calc(2*1.5em+14px)] max-h-[calc(10*1.5em+14px)]",
  ex: "[field-sizing:content] min-h-[calc(2*1.5em+14px)] max-h-[calc(6*1.5em+14px)]",
  why: "[field-sizing:content] min-h-[calc(1*1.5em+14px)] max-h-[calc(3*1.5em+14px)]",
};

/** One code of the draft as fields. `solo` (a short drawer) draws the field the caret is in
 *  and nothing else; Tab walks either way. */
export const CodeEditor = forwardRef<EditorHandle, {
  code: CodingDraftCode; inUse: CodingCode | null; changed: string[]; errs: Record<string, string>; limits: CodingLimits;
  solo: boolean; startAt: string; onSet: (field: string, value: unknown) => void;
}>(function CodeEditor({ code, inUse, changed, errs, limits, solo, startAt, onSet }, ref) {
  const [vals, setVals] = useState<Vals>(() => valsOf(code));
  const [stop, setStop] = useState(startAt);
  const [focusTick, setFocusTick] = useState(0);
  const [before, setBefore] = useState<Set<string>>(new Set());
  const touched = useRef(new Set<string>());
  const sent = useRef(new Map<string, unknown>());
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setVals((cur) => {
      const fresh = valsOf(code);
      for (const w of touched.current) { if (w in cur.text) fresh.text[w] = cur.text[w]; if (w in cur.ex) fresh.ex[w] = cur.ex[w]; }
      return fresh;
    });
  }, [code]);

  const stops = useMemo(() => {
    const out: string[] = [];
    for (const f of FIELDS) {
      if (f.wire === "label" && code.derived) continue;
      if (f.kind !== "examples") { out.push(f.wire); continue; }
      vals.ex[f.wire].forEach((_, i) => out.push(f.wire + "." + i + ".text", f.wire + "." + i + ".reasoning"));
      out.push(f.wire + ".add");
    }
    return out;
  }, [vals.ex, code.derived]);
  const at = stops.includes(stop) ? stop : stops.find((s) => s.startsWith(stop.split(".")[0])) || "definition";
  const group = at.split(".")[0];

  useLayoutEffect(() => {
    const el = root.current?.querySelector<HTMLElement>(`[data-cbe-stop="${CSS.escape(at)}"]`);
    if (!el || el === document.activeElement) return;
    el.focus({ preventScroll: false });
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
      try { el.setSelectionRange(el.value.length, el.value.length); } catch { /* no caret */ }
    }
  }, [at, focusTick, solo]);

  const emit = (wire: string, value: unknown) => {
    touched.current.add(wire);
    if (sent.current.has(wire) ? same(sent.current.get(wire), value) : false) return;
    sent.current.set(wire, value);
    onSet(wire, value);
  };
  const setText = (f: FieldDef, s: string) => {
    const t = ONE_LINE.has(f.wire) ? flat(s) : s;
    setVals((v) => ({ ...v, text: { ...v.text, [f.wire]: t } }));
    emit(f.wire, f.kind === "list" ? lines(t) : f.wire === "label" ? t.trim() : nl(t));
  };
  const setEx = (wire: string, next: CodingExample[]) => {
    setVals((v) => ({ ...v, ex: { ...v.ex, [wire]: next } }));
    emit(wire, pairs(next));
  };
  const flip = (wire: string) => setBefore((cur) => { const n = new Set(cur); if (n.has(wire)) n.delete(wire); else n.add(wire); return n; });

  useImperativeHandle(ref, () => ({
    tab: (d) => {
      const i = stops.indexOf(at) + d;
      if (i < 0 || i >= stops.length) return false;
      setStop(stops[i]);
      setFocusTick((t) => t + 1);
      return true;
    },
    edge: (d) => { setStop(d > 0 ? stops[0] : stops[stops.length - 1]); setFocusTick((t) => t + 1); },
    before: () => { if (changed.includes(group)) flip(group); },
    dropExample: () => {
      const m = /^(\w+)\.(\d+)\.(text|reasoning)$/.exec(at);
      if (!m) return false;
      const list = vals.ex[m[1]].filter((_, i) => i !== Number(m[2]));
      setEx(m[1], list);
      setStop(list.length ? m[1] + "." + Math.min(Number(m[2]), list.length - 1) + ".text" : m[1] + ".add");
      setFocusTick((t) => t + 1);
      return true;
    },
  }));

  const head = (f: FieldDef, count?: React.ReactNode) => (
    <div className="flex h-5 items-center gap-1.5">
      <span data-cbe-name className={HEAD}>{f.title}</span>
      {changed.includes(f.wire) && <DraftMark wire={f.wire} on={before.has(f.wire)} onToggle={() => flip(f.wire)} />}
      <span className="min-w-0 flex-1" />
      {count}
      {solo && <span className="nums text-[10px] text-muted-foreground" title="Field, of the fields of this code (Tab)">
        {FIELDS.findIndex((x) => x.wire === f.wire) + 1}/{FIELDS.length}</span>}
    </div>
  );
  const fail = (key: string) => errs[code.id + "|" + key]
    ? <div data-cb-error={key} className="mt-0.5 break-words text-[11px] leading-[1.4] text-danger">{errs[code.id + "|" + key]}</div> : null;
  const own = { "data-knav-own": "arrows enter" };

  const one = (f: FieldDef) => {
    const cap = capOf(limits, f.wire);
    const v = vals.text[f.wire] ?? "";
    if (f.kind === "examples") {
      const list = vals.ex[f.wire];
      const m = /^\w+\.(\d+)\./.exec(at);
      const only = solo && group === f.wire && m ? Number(m[1]) : -1;
      return (
        <div key={f.wire} data-cbe-field={f.wire} className={solo ? "flex min-h-0 flex-1 flex-col" : ""}>
          {head(f, <span className={"nums text-[10px] " + (list.length > limits.examples ? "text-danger" : "text-muted-foreground")}
            title={"Examples, of the " + limits.examples + " a code can hold"}>{only >= 0 ? (only + 1) + " of " + list.length : list.length}</span>)}
          {before.has(f.wire) && <Before code={inUse} wire={f.wire} />}
          {list.map((x, i) => (only >= 0 && i !== only ? null : (
            <div key={i} data-cbe-example={i} className="relative mb-1.5 border-l-2 border-border pl-2 pr-5">
              <textarea {...own} data-cbe-stop={f.wire + "." + i + ".text"} value={x.text} rows={2} maxLength={limits.exampleText} placeholder="text"
                title="The example's text · Tab on · Alt+Backspace removes the example"
                onFocus={() => setStop(f.wire + "." + i + ".text")}
                onChange={(e) => setEx(f.wire, list.map((y, j) => (j === i ? { ...y, text: e.target.value } : y)))}
                className={AREA + "italic " + GROW.ex} />
              <textarea {...own} data-cbe-stop={f.wire + "." + i + ".reasoning"} value={x.reasoning} rows={1} maxLength={limits.exampleReasoning} placeholder="why"
                title="Why it is, or is not, the code"
                onFocus={() => setStop(f.wire + "." + i + ".reasoning")}
                onChange={(e) => setEx(f.wire, list.map((y, j) => (j === i ? { ...y, reasoning: e.target.value } : y)))}
                className={AREA + "mt-1 text-muted-foreground " + GROW.short} />
              <button type="button" tabIndex={-1} data-cbe-drop={i} title="Remove this example (Alt+Backspace)" onMouseDown={(e) => e.preventDefault()}
                onClick={() => setEx(f.wire, list.filter((_, j) => j !== i))}
                className="absolute right-0 top-0 inline-flex h-4 w-4 items-center justify-center rounded text-muted-foreground outline-none hover:bg-accent hover:text-foreground">
                <X size={11} />
              </button>
            </div>
          )))}
          {(only < 0 || at.endsWith(".add")) && list.length < limits.examples && (
            <button type="button" data-cbe-stop={f.wire + ".add"} title="Add an example (Enter)" onFocus={() => setStop(f.wire + ".add")}
              onClick={() => { setEx(f.wire, [...list, { text: "", reasoning: "" }]); setStop(f.wire + "." + list.length + ".text"); setFocusTick((t) => t + 1); }}
              className="inline-flex h-5 w-6 items-center justify-center rounded border border-border/70 text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-primary/60">
              <Plus size={11} />
            </button>
          )}
          {fail(f.wire)}
        </div>
      );
    }
    if (f.kind === "line") {
      return (
        <div key={f.wire} data-cbe-field={f.wire} className="min-w-0">
          {head(f)}
          {before.has(f.wire) && <Before code={inUse} wire={f.wire} />}
          <input {...own} data-cbe-stop={f.wire} value={v} maxLength={cap} readOnly={f.wire === "label" && code.derived}
            spellCheck={f.wire !== "label"} onFocus={() => setStop(f.wire)} onChange={(e) => setText(f, e.target.value)}
            title={f.wire === "label" ? (code.derived ? "A derived code keeps its label" : "The label saved with every coded unit") : "The name shown on the code's row"}
            className={BOX + "h-7 py-0 " + (f.wire === "label" ? "font-mono text-[11.5px]" : "")} />
          {fail(f.wire)}
        </div>
      );
    }
    const n = f.kind === "list" ? lines(v).length : v.length;
    const count = f.kind === "list"
      ? <span data-cbe-count={f.wire} className={"nums text-[10px] " + (n > limits.listItems ? "text-danger" : "text-muted-foreground")}
          title={"Items, one per line, of the " + limits.listItems + " a list can hold"}>{n}</span>
      : cap && n >= Math.floor(cap * 0.8)
        ? <span data-cbe-count={f.wire} className={"nums text-[10px] " + (n >= cap ? "text-danger" : "text-muted-foreground")}
            title="Characters, of what the field can hold">{n}/{cap}</span> : undefined;
    return (
      <div key={f.wire} data-cbe-field={f.wire} className={solo ? "flex min-h-0 flex-1 flex-col" : ""}>
        {head(f, count)}
        {before.has(f.wire) && <Before code={inUse} wire={f.wire} />}
        <textarea {...own} data-cbe-stop={f.wire} value={v} maxLength={cap} rows={f.wire === "short" ? 1 : 3}
          title={f.kind === "list" ? "One item per line · Tab on · Esc or Ctrl+Enter done" : "Tab on · Esc or Ctrl+Enter done"}
          onFocus={() => setStop(f.wire)} onChange={(e) => setText(f, e.target.value)}
          className={AREA + (solo ? "min-h-[3em] flex-1" : GROW[f.wire] || GROW.list)} />
        {fail(f.wire)}
      </div>
    );
  };

  if (solo) {
    const f = fieldOf(group) || FIELDS[3];
    return <div ref={root} data-cb-editor={code.id} data-cb-solo className="flex h-full min-h-0 flex-col px-3 py-2">{one(f)}</div>;
  }
  return (
    <div ref={root} data-cb-editor={code.id} className="mx-auto flex max-w-[62ch] flex-col gap-2 px-4 py-3">
      <div className="grid grid-cols-2 gap-2">{FIELDS.slice(0, 2).map(one)}</div>
      {FIELDS.slice(2).map(one)}
    </div>
  );
});

/** the one row under the editor: why this change, sent with the next save */
export function WhyLine({ value, onChange, max, err }: { value: string; onChange: (s: string) => void; max: number; err?: string }) {
  return (
    <div className="shrink-0 border-t border-border/60 px-3 py-1">
      <input data-knav-own="arrows enter" data-cb-why value={value} maxLength={max} placeholder="why"
        title="Why this change: goes in the change log with the next save" onChange={(e) => onChange(flat(e.target.value))}
        className="block h-6 w-full bg-transparent text-[11.5px] text-foreground outline-none placeholder:text-muted-foreground/60" />
      {err && <div data-cb-error="why" className="truncate text-[11px] text-danger" title={err}>{err}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ the promote form */

const BTN = "inline-flex h-6 shrink-0 items-center rounded border px-2 text-[11px] outline-none focus-visible:ring-1 focus-visible:ring-primary/60 ";
const QUIET = BTN + "border-border/70 text-muted-foreground hover:bg-accent hover:text-foreground";
const STRONG = BTN + "border-primary/60 bg-primary/15 text-foreground hover:bg-primary/25 disabled:opacity-50";

export function draftCounts(book: CodingCodebook): { n: number; what: string; title: string }[] {
  const d = book.draft;
  if (!d) return [];
  const name = (id: string) => d.codes.find((c) => c.id === id)?.label || id;
  const changed = Object.keys(d.changed).filter((id) => (own(d.changed, id) || []).length && !d.added.includes(id) && !d.removed.includes(id));
  const renamed = Object.keys(d.renamed);
  return [
    { n: changed.length, what: "changed", title: changed.map(name).join(", ") },
    { n: d.added.length, what: "added", title: d.added.map(name).join(", ") },
    { n: d.removed.length, what: "removed", title: d.removed.map(name).join(", ") },
    { n: renamed.length, what: "renamed", title: renamed.map((id) => (own(d.renamed, id) || []).join(" to ")).join(", ") },
    ...(d.reordered ? [{ n: 1, what: "new order", title: "The codes are in a different order" }] : []),
    ...(Object.values(d.reverts).flat().length ? [{ n: Object.values(d.reverts).flat().length, what: "overriding",
      title: "Fields " + OVERRIDE_TIP.replace("this", "these").replace("yours is", "yours are") }] : []),
    { n: d.revisitIfPromoted, what: "to revisit", title: "Done units these changes touch" },
    { n: book.sharedWith.length, what: book.sharedWith.length === 1 ? "other set" : "other sets", title: "Sets reading the same codebook file: " + book.sharedWith.join(", ") },
  ];
}

export function PromoteForm({ book, err, onPromote, onRebase, onCancel }: {
  book: CodingCodebook; err: string; onPromote: (version: string, note: string) => Promise<unknown>;
  onRebase: () => Promise<unknown>; onCancel: () => void;
}) {
  const [version, setVersion] = useState(book.suggestVersion);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const stale = !!book.draft?.stale;
  const broken = book.brokenSets;
  useEffect(() => {
    const el = root.current?.querySelector<HTMLElement>(stale ? "[data-cb-rebase]" : "[data-cb-version]");
    el?.focus({ preventScroll: true });
    if (el instanceof HTMLInputElement) el.select();
  }, [stale]);
  const go = async () => {
    if (busy || stale || broken.length || !version.trim()) return;
    setBusy(true);
    try { await onPromote(version.trim(), note.trim()); } finally { setBusy(false); }
  };
  const key = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); void go(); }
  };
  const row = "flex items-center gap-2";
  const lab = HEAD + " w-12 shrink-0";
  const box = BOX + "h-7 min-w-0 flex-1 py-0";
  return (
    <div ref={root} data-cb-form="promote" className="mx-auto flex w-full max-w-[62ch] flex-col gap-1.5 px-4 py-2.5">
      <label className={row}>
        <span className={lab}>Version</span>
        <input data-knav-own="arrows enter" data-cb-version value={version} maxLength={book.limits.version} onChange={(e) => setVersion(flat(e.target.value))} onKeyDown={key}
          title={"The new version's label · in use: " + (book.version || "none") + " · Enter promotes, Esc backs out"} className={box + " nums"} />
      </label>
      <label className={row}>
        <span className={lab}>Note</span>
        <input data-knav-own="arrows enter" data-cb-promote-note value={note} maxLength={book.limits.why} onChange={(e) => setNote(flat(e.target.value))} onKeyDown={key}
          title="A note kept with this version" className={box} />
      </label>
      <div data-cb-counts className="nums flex flex-wrap gap-x-3 gap-y-0.5 text-[11.5px] leading-[1.5] text-muted-foreground">
        {draftCounts(book).map((c) => (
          <span key={c.what} data-cb-count={c.what.replace(/s$/, "").replace(/ /g, "-")} title={c.title || undefined} className={c.n ? "text-foreground" : ""}>
            {c.what === "new order" ? c.what : c.n + " " + c.what}</span>
        ))}
      </div>
      {broken.map((id) => (
        <div key={id} data-cb-broken={id} className="break-words text-[11.5px] leading-[1.4] text-danger">cannot promote: set {id} has an unreadable manifest</div>
      ))}
      {err && <div data-cb-error="promote" className="break-words text-[11.5px] leading-[1.4] text-danger">{err}</div>}
      <div className="flex flex-wrap items-center gap-1.5">
        {stale && (
          <button type="button" data-cb-rebase onClick={() => { setBusy(true); void onRebase().finally(() => setBusy(false)); }} disabled={busy}
            title="The codebook in use changed since this draft began: keep the draft and compare it with the file as it is now" className={STRONG}>
            Keep my draft
          </button>
        )}
        <button type="button" data-cb-promote-go onClick={() => void go()} disabled={busy || stale || broken.length > 0 || !version.trim()}
          title={stale ? "Keep the draft first" : broken.length ? "A set's manifest has to be readable first" : "Make the draft the codebook in use (Enter)"} className={STRONG}>Promote</button>
        <button type="button" data-cb-cancel onClick={onCancel} title="Back to the draft (Esc)" className={QUIET}>Cancel</button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------- the change log */

const clock = (ts: string) => { const m = /T(\d\d:\d\d)/.exec(ts); return m ? m[1] : ts; };
/** a logged value as plain text; one the server cut is never parsed, only marked */
const brief = (v: unknown, cut = false): string => {
  const s = v === null || v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 160 ? s.slice(0, 160) + "…" : cut ? s + "…" : s;
};

export function ChangesList({ log, names, error = "" }: { log: CodingLogEntry[]; names: (label: string) => string; error?: string }) {
  if (error) return <div data-cb-log data-cb-log-error className="break-words px-5 py-4 text-[12px] leading-[1.5] text-danger">{error}</div>;
  if (!log.length) return <div data-cb-log className="px-5 py-4 text-[12px] text-muted-foreground">No changes yet</div>;
  return (
    <div data-cb-log className="px-3 py-2">
      {log.map((r) => (
        <div key={r.id + r.ts} data-cb-log-row={r.op} data-cb-log-cut={r.truncated ? "" : undefined}
          title={[r.ts, r.before !== null ? "before: " + brief(r.before, r.truncated) : "", r.after !== null ? "after: " + brief(r.after, r.truncated) : ""].filter(Boolean).join("\n")}
          className="border-b border-border/40 py-1 text-[11.5px] leading-[1.45]">
          <div className="flex items-baseline gap-2">
            <span className="nums shrink-0 text-[10px] text-muted-foreground">{clock(r.ts)}</span>
            <span className="shrink-0 font-medium text-foreground">{r.op === "log_aside" ? "log set aside" : r.op}</span>
            <span className="min-w-0 flex-1 truncate text-foreground">
              {r.op === "log_aside" ? brief(r.after)
                : r.op === "rebase" ? Object.entries(r.reverts).map(([l, f]) => names(l) + ": " + f.map(fieldTitle).join(", ")).join(" · ")
                : [r.label ? names(r.label) : "", r.field ? fieldTitle(r.field) : ""].filter(Boolean).join(" · ")}
            </span>
            {r.unitId && <span className="shrink-0 font-mono text-[10px] text-muted-foreground" title="The unit he was on">{r.unitId}</span>}
          </div>
          {r.why && <div data-cb-log-why className="break-words pl-[42px] italic text-muted-foreground">{r.why}</div>}
        </div>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------- the memo line */

export function MemoLine({ unitId, max = CODING_LIMITS.why, onSend, onClose }: {
  unitId: string | null; max?: number; onSend: (text: string) => Promise<string>; onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLInputElement>(null);
  const opener = useRef<HTMLElement | null>(document.activeElement as HTMLElement | null);
  useEffect(() => {
    const back = opener.current;
    box.current?.focus({ preventScroll: true });
    return () => { if (back && back.isConnected) back.focus({ preventScroll: true }); };
  }, []);
  const send = async () => {
    if (busy) return;
    if (!text.trim()) { onClose(); return; }
    setBusy(true);
    const bad = await onSend(text.trim());
    setBusy(false);
    if (bad) setErr(bad); else onClose();
  };
  return (
    <div data-coding-memo className="absolute inset-x-0 bottom-0 z-50 border-t border-border bg-background px-2.5 py-1 shadow-pop">
      <div className="flex h-6 items-center gap-2">
        <StickyNote size={12} className="shrink-0 text-muted-foreground" aria-hidden />
        <input ref={box} data-knav-own="arrows enter" data-coding-memo-input value={text} maxLength={max} placeholder="codebook memo"
          title={"A memo in the codebook's change log" + (unitId ? ", for unit " + unitId : "") + " · Enter saves it, Esc closes"}
          onChange={(e) => { setText(flat(e.target.value)); if (err) setErr(""); }}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); void send(); }
            else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); }
          }}
          className="h-6 min-w-0 flex-1 bg-transparent text-[12px] text-foreground outline-none placeholder:text-muted-foreground/60" />
        {unitId && <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{unitId}</span>}
      </div>
      {err && <div data-cb-error="memo" className="truncate pl-5 text-[11px] text-danger" title={err}>{err}</div>}
    </div>
  );
}
