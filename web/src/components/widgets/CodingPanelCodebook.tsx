
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Pencil, Trash2, Undo2, X } from "lucide-react";
import type { CodingCode, CodingExample } from "@/lib/api";
import { readerScroll } from "@/lib/scroll";
import type { PaneSize } from "@/components/widgets/panel";
import { codeName } from "@/components/widgets/CodingPanelUnit";
import { Before, ChangesList, CodeEditor, DraftDot, DraftMark, OverCtx, OverrideDot, PromoteForm, WhyLine, flat, type DraftBook, type EditorHandle }
  from "@/components/widgets/CodingPanelCodebookEdit";

type View = "use" | "draft" | "changes";
type Form = null | "add" | "discard" | "promote";
type Row = CodingCode & { id: string; removed?: boolean };
const VIEWS: { id: View; label: string; hint: string }[] = [
  { id: "use", label: "In use", hint: "The codebook every coded unit is saved under" },
  { id: "draft", label: "Draft", hint: "The next version, as edited so far" },
  { id: "changes", label: "Changes", hint: "The change log" },
];
const SMALL = "inline-flex h-5 shrink-0 items-center rounded px-1.5 text-[10.5px] outline-none focus-visible:ring-1 focus-visible:ring-primary/60 ";
const ICON = "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-primary/60";

export function CodebookDrawer({ codes, at, onAt, onClose, size, note, version, docked = false, unitKeys = false,
  draft, editReq = null, onEditTaken, onMemo, onRevisit }: {
  codes: CodingCode[]; at: string; onAt: (label: string) => void; onClose: () => void;
  size: PaneSize; note: string; version: string;
  /** beside the text instead of over it */
  docked?: boolean;
  /** docked over a unit: its 1-9 toggle codes, so the drawer leaves the digits alone */
  unitKeys?: boolean;
  /** the draft and its save queue; without it the drawer only reads */
  draft?: DraftBook;
  /** `e` from the unit: open on this code, already editing its definition */
  editReq?: { seq: number; code: string } | null;
  onEditTaken?: () => void;
  onMemo?: () => void;
  /** the queue under its Revisit filter */
  onRevisit?: () => void;
}) {
  const [view, setView] = useState<View>(editReq ? "draft" : "use");
  const [editing, setEditing] = useState<string | null>(editReq ? "definition" : null);
  const [form, setForm] = useState<Form>(null);
  const [addLabel, setAddLabel] = useState("");
  const [befores, setBefores] = useState<Set<string>>(new Set());
  const [solo, setSolo] = useState(false);
  const B = draft?.book || null;
  const list: Row[] = view === "draft" && draft && B ? draft.codes : codes.map((c) => ({ ...c, id: c.label }));
  const cur = list.find((c) => c.id === at) || list.find((c) => c.label === at) || list[0];
  // a code named inside the codebook's own text reads by its display name, never its CAPS label
  const shown = list.filter((c) => c.display);
  const say = (t: string) => shown.reduce((acc, c) =>
    acc.replace(new RegExp("\\b" + c.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "g"), c.display), t);
  const root = useRef<HTMLDivElement>(null);
  const read = useRef<HTMLDivElement>(null);
  const tabs = useRef<HTMLDivElement>(null);
  const ed = useRef<EditorHandle>(null);
  const opener = useRef<HTMLElement | null>(document.activeElement as HTMLElement | null);
  const editFrom = useRef<HTMLElement | null>(editReq ? opener.current : null);
  const onTab = (id: string) => {
    document.documentElement.setAttribute("data-knav", "");
    tabs.current?.querySelector<HTMLElement>(`[data-coding-cb-code="${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
  };
  const [goTo, setGoTo] = useState<{ sel: string; n: number } | null>(null);
  const focusOn = (sel: string) => setGoTo((g) => ({ sel, n: (g?.n || 0) + 1 }));
  const tabSel = (id: string) => `[data-coding-cb-code="${CSS.escape(id)}"]`;
  useLayoutEffect(() => {
    if (!goTo) return;
    document.documentElement.setAttribute("data-knav", "");
    root.current?.querySelector<HTMLElement>(goTo.sel)?.focus({ preventScroll: true });
  }, [goTo]);

  useEffect(() => {
    const back = opener.current;
    if (!docked && !editing) {
      document.documentElement.setAttribute("data-knav", "");
      tabs.current?.querySelector<HTMLElement>(`[data-coding-cb-code="${CSS.escape(cur.id)}"]`)?.focus({ preventScroll: true });
    }
    return () => {
      const a = document.activeElement;
      const lost = !a || a === document.body || !a.isConnected;
      if (back && back.isConnected && (!docked || lost)) back.focus({ preventScroll: true });
    };
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (read.current) read.current.scrollTop = 0; }, [cur.id, view]);
  // each opening reads the codebook again: a lock set or lifted from the CLI shows without waiting for the stamp
  useEffect(() => { void draft?.load(); }, []);  // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!editReq) return;
    const a = document.activeElement as HTMLElement | null;
    if (!editing) editFrom.current = a && !root.current?.contains(a) ? a : null;
    setView("draft"); setForm(null); setEditing("definition");
    onEditTaken?.();
  }, [editReq?.seq]);  // eslint-disable-line react-hooks/exhaustive-deps

  // a short drawer draws one field at a time
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const f = () => setSolo(el.clientHeight < 400);
    f();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(f) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, []);

  const locked = !!B?.locked;
  const unreadable = B?.unreadable || "";
  const hasDraft = !!B?.draft || !!unreadable;
  const lockTip = (B?.lockReason || "Locked: a model run reads this codebook")
    + (B?.lockedBy && B.lockedBy !== draft?.setId ? " · locked by the set " + B.lockedBy : "");
  const startEdit = (stop = "definition") => {
    if (!draft || editing || unreadable) return;
    const a = document.activeElement as HTMLElement | null;
    editFrom.current = a && !root.current?.contains(a) ? a : null;
    setView("draft"); setForm(null); setEditing(stop);
  };
  const leave = () => {
    setEditing(null);
    void draft?.leave();
    const back = editFrom.current;
    editFrom.current = null;
    document.documentElement.setAttribute("data-knav", "");
    if (back && back.isConnected) back.focus({ preventScroll: true }); else focusOn(tabSel(cur.id));
  };
  const closeForm = () => { setForm(null); draft?.setErr(["add", "discard", "promote"], ""); focusOn(tabSel(cur.id)); };
  const openPromote = () => {
    if (!draft || !B?.draft || locked) return;
    if (editing) { setEditing(null); void draft.leave(); }
    setView("draft"); setForm("promote");
  };
  const openAdd = () => { if (!draft || !B || unreadable) return; setView("draft"); setAddLabel(""); setForm("add"); };
  const add = async () => {
    const label = addLabel.trim();
    if (!draft || !label) return;
    const after = list.some((c) => c.id === cur.id) && view === "draft" ? cur.id : cur.label;
    const r = await draft.act(() => ({ op: "add", after, label }), "add");
    if (!r || !r.ok) return;
    const made = r.draft?.codes.find((c) => c.label === label && r.draft?.added.includes(c.id)) || r.draft?.codes.find((c) => c.label === label);
    setForm(null);
    if (made) { onAt(made.id); editFrom.current = null; setEditing("definition"); }
  };
  const toggleRemoved = () => {
    if (!draft || view !== "draft") return;
    if (cur.derived && !cur.removed) { draft.setErr("head", codeName(cur) + " is derived and cannot be removed"); return; }
    const id = cur.id;
    void draft.act((b) => {
      const c = b?.draft?.codes.find((x) => x.id === id);
      return { op: c?.removed ? "restore" : "remove", code: id };
    }, "head");
  };
  const move = (d: 1 | -1) => {
    if (!draft || view !== "draft") return;
    const id = cur.id;
    void draft.act((b) => {
      const all = b?.draft ? b.draft.codes : (b?.codes || []).map((c) => ({ id: c.label }));
      const i = all.findIndex((x) => x.id === id);
      const to = i + d;
      return i < 0 || to < 0 || to >= all.length ? null : { op: "move", code: id, to };
    }, "head").then(() => onTab(id));
  };
  const doPromote = async (v: string, n: string) => {
    if (!draft) return;
    const label = cur.label;
    const r = await draft.promote(v, n);
    if (r && r.ok) { setForm(null); setEditing(null); setView("use"); onAt(label); focusOn(tabSel(label)); }
  };
  const doRebase = async () => {
    if (!draft) return;
    const label = cur.label;
    const r = await draft.rebase();
    if (!r || !r.ok) return;
    // the draft's ids are new: nothing keyed by an old one survives, the code is found again by its label
    setBefores(new Set()); setEditing(null);
    const codes = draft.peek()?.draft?.codes || [];
    const hit = codes.find((c) => c.label === label) || codes[0];
    if (hit) onAt(hit.id);
  };
  const doDiscard = async () => {
    if (!draft) return;
    const r = await draft.discard();
    if (r && r.ok) { setForm(null); setEditing(null); setView("use"); focusOn(tabSel(cur.label)); }
  };
  const flipAll = () => {
    const f = draft ? draft.fields(cur.id) : [];
    setBefores((s) => (f.every((w) => s.has(w)) ? new Set() : new Set(f)));
  };
  const cycle = () => {
    const ids = VIEWS.filter((v) => v.id !== "draft" || hasDraft || view === "draft").map((v) => v.id);
    const next = ids[(ids.indexOf(view) + 1) % ids.length];
    if (editing) leave();
    setForm(null); setView(next);
    focusOn(`[data-cb-view="${next}"]`);
  };
  /** Tab inside the drawer: the form's controls, or the editor's fields and then the why line */
  const tab = (d: 1 | -1) => {
    const a = document.activeElement as HTMLElement | null;
    if (form) {
      const els = Array.from(root.current?.querySelectorAll<HTMLElement>("[data-cb-form] input, [data-cb-form] button:not(:disabled)") || []);
      const i = a ? els.indexOf(a) : -1;
      els[(i + d + els.length) % els.length]?.focus({ preventScroll: true });
      return;
    }
    const why = root.current?.querySelector<HTMLElement>("[data-cb-why]");
    if (a && a === why) { ed.current?.edge(d); return; }
    if (!ed.current?.tab(d)) why?.focus({ preventScroll: true });
  };

  const now = useRef({ view, editing, form, startEdit, leave, closeForm, openPromote, openAdd, toggleRemoved, move, flipAll, cycle, tab, list });
  now.current = { view, editing, form, startEdit, leave, closeForm, openPromote, openAdd, toggleRemoved, move, flipAll, cycle, tab, list };

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const s = now.current;
      const a = document.activeElement as HTMLElement | null;
      const inside = !!a && !!root.current?.contains(a);
      const take = () => { e.preventDefault(); e.stopPropagation(); };
      const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
      if (a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.isContentEditable)) {
        if (!inside) return;
        if (e.key === "Escape") { take(); if (s.form) s.closeForm(); else if (s.editing) s.leave(); return; }
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && s.editing && !s.form) { take(); s.leave(); return; }
        // the short line is one line, though it wraps
        if (e.key === "Enter" && a.getAttribute("data-cbe-stop") === "short") { take(); return; }
        if (e.key === "Tab" && plain) { take(); s.tab(e.shiftKey ? -1 : 1); return; }
        if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === "KeyB") { take(); ed.current?.before(); return; }
        if (e.altKey && e.key === "Backspace" && ed.current?.dropExample()) take();
        return;
      }
      const mine = !docked || inside;
      if (e.key === "Tab" && plain && inside && (s.editing || s.form)) { take(); s.tab(e.shiftKey ? -1 : 1); return; }
      if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        if (mine && s.view === "draft" && !s.editing && !s.form) { take(); s.move(e.key === "ArrowDown" ? 1 : -1); }
        return;
      }
      if (!plain || document.documentElement.hasAttribute("data-board-prefix")) return;
      const m = /^(?:Digit|Numpad)([1-9])$/.exec(e.code);
      if (m && !e.shiftKey && !(docked && unitKeys && !inside)) {
        const c = s.list[Number(m[1]) - 1];
        if (!c) return;
        e.preventDefault();
        onAt(c.id);
        tabs.current?.querySelector<HTMLElement>(`[data-coding-cb-code="${CSS.escape(c.id)}"]`)?.focus({ preventScroll: true });
        return;
      }
      // Escape is closed here rather than by the engine, whose restore would reach for
      // whatever ⏎ last opened instead of the text the drawer was opened over
      if (e.key === "Escape") {
        take();
        if (s.form) s.closeForm();
        else if (s.editing) s.leave();
        else if (docked && unitKeys && inside && opener.current?.isConnected && !root.current?.contains(opener.current)) {
          document.documentElement.setAttribute("data-knav", "");
          opener.current.focus({ preventScroll: true });
        } else onClose();
        return;
      }
      if (e.key === "?") { take(); onClose(); return; }
      if (s.form) return;
      if (draft) {
        if (e.key === "P" && e.shiftKey) { take(); s.openPromote(); return; }
        if (!e.shiftKey && e.key === "e" && !s.editing) { take(); s.startEdit(); return; }
        if (!e.shiftKey && e.key === "m" && onMemo) { take(); onMemo(); return; }
        if (!e.shiftKey && e.key === "v") { take(); s.cycle(); return; }
        if (mine && !s.editing) {
          if (e.key === "+") { take(); s.openAdd(); return; }
          if ((e.key === "Delete" || e.key === "Backspace") && s.view === "draft") { take(); s.toggleRemoved(); return; }
          if (e.key === "b" && s.view === "draft") { take(); s.flipAll(); return; }
        }
      }
      if (docked && !inside) return;
      const box = read.current;
      if (!box) return;
      if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !e.shiftKey) {
        if (readerScroll(box, e.key === "ArrowDown" ? 1 : -1, false, e.repeat)) e.preventDefault();
      } else if (e.key === " " || e.key === "PageDown" || e.key === "PageUp") {
        if (readerScroll(box, e.key === "PageUp" || (e.key === " " && e.shiftKey) ? -1 : 1, true, false)) e.preventDefault();
      }
    };
    // capture: KeyLayer binds `?` to the key sheet in the bubble phase (see CodingPanelUnit)
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [onAt, onClose, docked, unitKeys, draft, onMemo]);

  useEffect(() => { if (form === "add") root.current?.querySelector<HTMLElement>("[data-cb-add]")?.focus({ preventScroll: true }); }, [form]);
  useEffect(() => { if (form === "discard") root.current?.querySelector<HTMLElement>("[data-cb-discard-go]")?.focus({ preventScroll: true }); }, [form]);

  const narrow = size === "xs" || size === "sm";
  const inDraft = view === "draft";
  const dcur = inDraft && draft && B ? draft.codes.find((c) => c.id === cur.id) || null : null;
  const inUse = B?.codes.find((c) => c.label === cur.id) || null;
  const changed = inDraft && draft ? draft.fields(cur.id) : [];
  const headErr = draft?.errs.head || draft?.errs.discard || (!B && draft?.loadErr) || "";
  const did = draft?.promoted || null;
  return (
    <OverCtx.Provider value={inDraft && draft ? draft.overrides(cur.id) : NONE}>
    <div ref={root} {...(docked ? { "aria-label": "Codebook", "data-coding-docked": "" } : { role: "dialog", "aria-label": "Codebook", "data-knav-modal": "" })}
      data-coding-codebook={cur.label} data-cb-view-now={view} data-cb-editing={editing ? cur.id : undefined}
      className={docked
        ? "relative flex w-[min(440px,42%)] shrink-0 flex-col border-l border-border bg-background"
        : "absolute inset-y-0 right-0 z-40 flex flex-col border-l border-border bg-background shadow-pop "
          + (narrow ? "w-full" : "w-[min(460px,70%)]")}>
      <div ref={tabs} className="flex h-8 shrink-0 items-center gap-0.5 border-b border-border/60 px-2">
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto tinybar">
          {list.map((c, i) => {
            const on = c.id === cur.id;
            const mark = inDraft && !!draft?.marks.has(c.id);
            const state = c.removed ? " (removed)" : inDraft && draft?.added.has(c.id) ? " (added)" : mark ? " (changed)" : "";
            return (
              <button key={c.id} type="button" data-knav-item data-coding-cb-code={c.id} aria-current={on ? "true" : undefined}
                data-cb-state={c.removed ? "removed" : inDraft && draft?.added.has(c.id) ? "added" : mark ? "changed" : undefined}
                onClick={() => onAt(c.id)} title={codeName(c) + (c.derived ? " (derived)" : "") + state + " · " + (i + 1)}
                className={"relative inline-flex h-6 shrink-0 items-center gap-1 rounded-sm px-2 text-[11.5px] font-medium outline-none "
                  + "focus-visible:ring-1 focus-visible:ring-primary/60 "
                  + (on ? "text-foreground" : "text-muted-foreground hover:text-foreground")}>
                <span className={c.removed ? "line-through decoration-danger/80" : ""}>{codeName(c)}</span>
                {mark && !c.removed && <DraftDot title={state.replace(/[() ]/g, "") + " in the draft"} />}
                {inDraft && !!draft?.overrides(c.id).length && <OverrideDot />}
                {on && <span className="pointer-events-none absolute inset-x-1 bottom-0 h-[1.5px] rounded-full bg-primary" />}
              </button>
            );
          })}
        </div>
        {(B?.version || version) && <span data-cb-version-now className="shrink-0 text-[10px] text-muted-foreground" title={note || B?.version || version}>{B?.version || version}</span>}
        <button type="button" data-knav-back="3" data-qa="coding-codebook-close" onClick={onClose} title="Close (Esc)"
          className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground outline-none hover:bg-accent hover:text-foreground">
          <X size={12} />
        </button>
      </div>

      {draft && (
        <div data-cb-bar className="flex h-7 shrink-0 items-center gap-1 border-b border-border/60 px-2">
          {form === "add" ? (
            <div data-cb-form="add" className="flex min-w-0 flex-1 items-center gap-1.5">
              <input data-knav-own="arrows enter" data-cb-add value={addLabel} maxLength={B?.limits.label} placeholder="NEW_CODE" spellCheck={false}
                title={"The new code's label, added after " + codeName(cur) + " · Enter adds it, Esc backs out"}
                onChange={(e) => { setAddLabel(flat(e.target.value)); if (draft.errs.add) draft.setErr("add", ""); }}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); void add(); } }}
                className="h-5 w-36 shrink-0 rounded border border-primary/60 bg-background px-1.5 font-mono text-[11px] outline-none" />
              {draft.errs.add && <span data-cb-error="add" className="min-w-0 truncate text-[11px] text-danger" title={draft.errs.add}>{draft.errs.add}</span>}
            </div>
          ) : form === "discard" ? (
            <div data-cb-form="discard" className="flex min-w-0 flex-1 items-center gap-1.5">
              <span className="min-w-0 truncate text-[11px] text-foreground">Discard the draft</span>
              <button type="button" data-cb-discard-go onClick={() => void doDiscard()} title="Set the draft aside; the codebook in use is untouched (Enter)"
                className={SMALL + "border border-danger/60 text-danger hover:bg-danger/10"}>Discard</button>
              <button type="button" data-cb-discard-no onClick={closeForm} title="Keep the draft (Esc)"
                className={SMALL + "border border-border/70 text-muted-foreground hover:text-foreground"}>Keep</button>
              {draft.errs.discard && <span data-cb-error="discard" className="min-w-0 truncate text-[11px] text-danger" title={draft.errs.discard}>{draft.errs.discard}</span>}
            </div>
          ) : (
            <>
              <div role="group" aria-label="Codebook view" className="flex shrink-0 items-center rounded border border-border/60">
                {VIEWS.filter((v) => v.id !== "draft" || hasDraft || inDraft).map((v) => (
                  <button key={v.id} type="button" data-knav-item data-cb-view={v.id} aria-pressed={view === v.id} title={v.hint + " (v)"}
                    onClick={() => { if (editing) leave(); setForm(null); setView(v.id); }}
                    className={SMALL + (view === v.id ? "bg-primary/15 text-foreground" : "text-muted-foreground hover:text-foreground")}>
                    {v.label}
                  </button>
                ))}
              </div>
              <span className="min-w-0 flex-1 truncate text-right text-[11px] text-danger" data-cb-error={headErr ? "head" : undefined} title={headErr || undefined}>{headErr}</span>
              <SaveDot s={draft.state} />
              {view === "use" && did && did.revisit > 0 && onRevisit && (
                <button type="button" data-knav-item data-cb-revisit onClick={onRevisit}
                  title="Done units this version's changes touch: open them in the queue"
                  className={SMALL + "nums border border-border/70 text-foreground hover:bg-accent"}>{did.revisit} to revisit</button>
              )}
              {inDraft && hasDraft && (
                <>
                  {!unreadable && <button type="button" data-knav-item data-cb-promote aria-disabled={locked || undefined} onClick={openPromote}
                    title={locked ? lockTip : "Promote the draft to a new version (Shift+P)"}
                    className={SMALL + "border " + (locked ? "cursor-not-allowed border-border/60 text-muted-foreground opacity-60" : "border-primary/60 bg-primary/15 text-foreground hover:bg-primary/25")}>
                    Promote
                  </button>}
                  <button type="button" data-knav-item data-cb-discard onClick={() => { if (editing) leave(); setForm("discard"); }} title="Discard the draft" className={ICON}>
                    <Trash2 size={12} />
                  </button>
                </>
              )}
            </>
          )}
        </div>
      )}

      {form === "promote" && draft && B ? (
        <div data-coding-cb-body className="tinybar min-h-0 flex-1 overflow-y-auto">
          <PromoteForm book={B} err={draft.errs.promote || ""} onPromote={doPromote} onRebase={doRebase} onCancel={closeForm} />
        </div>
      ) : view === "changes" && draft ? (
        <div ref={read} data-coding-cb-body className="tinybar min-h-0 flex-1 overflow-y-auto">
          {B ? <ChangesList log={B.log} error={B.logError} names={(l) => codeName({ label: l, display: (B.draft?.codes || B.codes).find((c) => c.label === l)?.display })} />
            : <div className="px-5 py-4 text-[12px] text-muted-foreground">{draft.loadErr || "Reading the codebook"}</div>}
        </div>
      ) : inDraft && unreadable ? (
        <div data-coding-cb-body data-cb-unreadable className="min-h-0 flex-1 break-words px-5 py-4 text-[12px] leading-[1.5] text-danger">{unreadable}</div>
      ) : inDraft && draft && !B ? (
        <div data-coding-cb-body className="min-h-0 flex-1 px-5 py-4 text-[12px] text-muted-foreground">{draft.loadErr || "Reading the codebook"}</div>
      ) : editing && draft && B && dcur ? (
        <>
          <div ref={read} data-coding-cb-body className={"tinybar min-h-0 flex-1 " + (solo ? "overflow-hidden" : "overflow-y-auto")}>
            <CodeEditor key={dcur.id} ref={ed} code={dcur} inUse={inUse} changed={changed} errs={draft.errs} limits={B.limits} solo={solo}
              startAt={editing} onSet={(field, value) => draft.setField(dcur.id, field, value)} />
          </div>
          <WhyLine value={draft.why} onChange={draft.setWhy} max={B.limits.why} err={draft.errs.why} />
        </>
      ) : (
        <div ref={read} data-coding-cb-body className="tinybar min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <div className={"mx-auto max-w-[62ch] text-[13px] leading-[1.6] text-foreground " + (cur.removed ? "opacity-60" : "")}>
            <div className="flex items-start gap-1.5">
              <h3 className={"min-w-0 flex-1 text-[15px] font-semibold " + (cur.removed ? "line-through decoration-danger/80" : "")}>{codeName(cur)}</h3>
              {inDraft && (changed.includes("label") || changed.includes("display")) && (
                <DraftMark wire="label" on={befores.has("label")} onToggle={() => setBefores((s) => flipped(s, "label"))} />
              )}
              {inDraft && cur.removed && (
                <button type="button" data-knav-item data-cb-restore onClick={toggleRemoved} title="Restore this code (Del)" className={ICON}><Undo2 size={12} /></button>
              )}
              {draft && !cur.removed && (
                <button type="button" data-knav-item data-cb-edit onClick={() => startEdit()} title="Edit this code (e)" className={ICON}><Pencil size={12} /></button>
              )}
            </div>
            {inDraft && befores.has("label") && <Before code={inUse ? { ...inUse, label: codeName(inUse) + " · " + inUse.label } : null} wire="label" />}
            {inDraft && <p data-cb-label className="font-mono text-[10.5px] text-muted-foreground">{cur.label}</p>}
            {(cur.short || changed.includes("short")) && (
              <Field wire="short" changed={changed} befores={befores} onFlip={setBefores} inUse={inUse}>
                <p data-coding-cb-short className="mt-0.5 text-[12.5px] text-muted-foreground">{cur.short || "–"}</p>
              </Field>
            )}
            {cur.derived && (
              <p data-coding-cb-derived className="mt-0.5 text-[12px] text-muted-foreground">
                derived: present when none of {cur.noneOf.map((x) => codeName({ label: x, display: list.find((y) => y.label === x)?.display })).join(", ")} is present
              </p>
            )}
            {(cur.definition || changed.includes("definition")) && (
              <Field wire="definition" changed={changed} befores={befores} onFlip={setBefores} inUse={inUse}>
                <p data-cb-definition className="mt-1 whitespace-pre-wrap">{say(cur.definition) || "–"}</p>
              </Field>
            )}
            <Part wire="decision_rules" title="Decision rules" ordered items={cur.decisionRules.map(say)} changed={changed} befores={befores} onFlip={setBefores} inUse={inUse} />
            <Part wire="inclusion_criteria" title="Include" items={cur.inclusion.map(say)} changed={changed} befores={befores} onFlip={setBefores} inUse={inUse} />
            <Part wire="exclusion_criteria" title="Exclude" items={cur.exclusion.map(say)} changed={changed} befores={befores} onFlip={setBefores} inUse={inUse} />
            <Examples wire="positive_examples" title="Examples" items={cur.positive} changed={changed} befores={befores} onFlip={setBefores} inUse={inUse} />
            <Examples wire="negative_examples" title="Near misses" items={cur.negative} changed={changed} befores={befores} onFlip={setBefores} inUse={inUse} />
            <Part wire="confusable_with" title="Confusable with" items={cur.confusable.map(say)} changed={changed} befores={befores} onFlip={setBefores} inUse={inUse} />
          </div>
        </div>
      )}
    </div>
    </OverCtx.Provider>
  );
}

const NONE: string[] = [];
const flipped = (s: Set<string>, wire: string) => { const n = new Set(s); if (n.has(wire)) n.delete(wire); else n.add(wire); return n; };
type Diff = { wire: string; changed: string[]; befores: Set<string>; onFlip: (f: (s: Set<string>) => Set<string>) => void; inUse: CodingCode | null };

function SaveDot({ s }: { s: DraftBook["state"] }) {
  if (s === "idle") return null;
  const title = s === "saved" ? "Draft saved" : s === "saving" ? "Saving the draft" : "The draft is not saved";
  const cls = s === "saved" ? "border border-primary/60" : s === "saving" ? "bg-primary/60 animate-pulse" : "bg-danger";
  return <span data-cb-save={s} title={title} aria-label={title} className={"mx-0.5 h-[7px] w-[7px] shrink-0 rounded-full " + cls} />;
}

/** a field with no heading of its own: the mark sits beside it when the draft changed it */
function Field({ wire, changed, befores, onFlip, inUse, children }: Diff & { children: React.ReactNode }) {
  if (!changed.includes(wire)) return <>{children}</>;
  return (
    <div data-cb-changed={wire}>
      {befores.has(wire) && <Before code={inUse} wire={wire} />}
      <div className="flex items-start gap-1.5">
        <div className="min-w-0 flex-1">{children}</div>
        <span className="mt-1"><DraftMark wire={wire} on={befores.has(wire)} onToggle={() => onFlip((s) => flipped(s, wire))} /></span>
      </div>
    </div>
  );
}

function Head({ title, wire, changed, befores, onFlip, inUse }: Diff & { title: string }) {
  const on = changed.includes(wire);
  return (
    <>
      <div className="flex items-center gap-1.5">
        <h4 className="text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">{title}</h4>
        {on && <DraftMark wire={wire} on={befores.has(wire)} onToggle={() => onFlip((s) => flipped(s, wire))} />}
      </div>
      {on && befores.has(wire) && <Before code={inUse} wire={wire} />}
    </>
  );
}

function Part({ title, items, ordered, ...d }: Diff & { title: string; items: string[]; ordered?: boolean }) {
  const on = d.changed.includes(d.wire);
  if (!items.length && !on) return null;
  const L = ordered ? "ol" : "ul";
  return (
    <section className="mt-2" data-cb-changed={on ? d.wire : undefined}>
      <Head title={title} {...d} />
      {items.length ? (
        <L className={"mt-0.5 space-y-0.5 pl-4 " + (ordered ? "list-decimal" : "list-disc")}>
          {items.map((t, i) => <li key={i}>{t}</li>)}
        </L>
      ) : <p className="text-muted-foreground">–</p>}
    </section>
  );
}

function Examples({ title, items, ...d }: Diff & { title: string; items: CodingExample[] }) {
  const on = d.changed.includes(d.wire);
  if (!items.length && !on) return null;
  return (
    <section className="mt-2" data-cb-changed={on ? d.wire : undefined}>
      <Head title={title} {...d} />
      {items.length ? items.map((x, i) => (
        <figure key={i} className="mt-1 border-l-2 border-border pl-2">
          <blockquote className="italic">{x.text}</blockquote>
          {x.reasoning && <figcaption className="mt-0.5 text-[12px] text-muted-foreground">{x.reasoning}</figcaption>}
        </figure>
      )) : <p className="text-muted-foreground">–</p>}
    </section>
  );
}
