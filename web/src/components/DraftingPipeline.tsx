
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent as RKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { ChevronLeft, ChevronRight, Plus, Star } from "lucide-react";
import { api } from "@/lib/api";
import type { DraftStatus, PipelineItem, PlanCommitment } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { layerAbove } from "@/lib/arrownav";
import { setPendingDraftOpen } from "@/lib/taskdest";

export const STAGES: { id: DraftStatus; label: string }[] = [
  { id: "idea", label: "Idea" },
  { id: "draft", label: "Drafting" },
  { id: "under_review", label: "Review" },
  { id: "published", label: "Published" },
];
const FOCUS_MAX = 3;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// The list or Progress Overview in the Drafting view; the choice survives a reload and can be
// set from outside (the #/drafting/pipeline hash, the Today strip) through this event.
export const DRAFTING_TAB_KEY = "drafting-tab";
export const DRAFTING_TAB_EVENT = "all_in_one_academic:drafting-tab";
export function requestDraftingTab(tab: "library" | "pipeline") {
  try { localStorage.setItem(DRAFTING_TAB_KEY, JSON.stringify(tab)); } catch { /* private mode */ }
  window.dispatchEvent(new CustomEvent(DRAFTING_TAB_EVENT, { detail: tab }));
}

const daysLabel = (d: number) => (d === 0 ? "today" : `${d}d`);
const shortTitle = (t: string) => (t.length > 22 ? t.slice(0, 21).trimEnd() + "…" : t);
const sortByDate = (a: PlanCommitment, b: PlanCommitment) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title);

function commitTip(c: PlanCommitment): string {
  const src = c.editable ? "" : ` · from ${c.source}`;
  const when = c.days < 0 ? `${-c.days}d overdue` : c.days === 0 ? "due today" : `${c.days}d left`;
  return `${c.title} — ${c.date}, ${when}${src}`;
}

export function CountdownChip({ c, onClick, className = "" }: { c: PlanCommitment; onClick?: () => void; className?: string }) {
  const hot = c.days <= 7;
  const cls = `inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] nums whitespace-nowrap ${
    hot ? "border-danger/45 bg-danger/10 text-danger" : "border-border text-muted-foreground"} ${className}`;
  const body = <>{shortTitle(c.title)}<span className="opacity-60">·</span><span className="font-medium">{daysLabel(c.days)}</span></>;
  if (!onClick) return <span className={cls} title={commitTip(c)}>{body}</span>;
  return (
    <button type="button" data-plan-commit={c.id} onClick={(e) => { e.stopPropagation(); onClick(); }} title={commitTip(c)}
      className={cls + " hover:border-primary/50 hover:text-foreground transition-colors"}>{body}</button>
  );
}

/* ------------------------------------------------------------ commitment form */

function CommitmentDialog({ initial, projects, onClose, onSaved }: {
  initial: PlanCommitment | null;           // null = a new one
  projects: { key: string; title: string }[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [date, setDate] = useState(initial?.date ?? "");
  const [project, setProject] = useState(initial?.project ?? "");
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  // land in the title; hand the focus back to whatever opened the form
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const id = requestAnimationFrame(() => titleRef.current?.focus({ preventScroll: true }));
    return () => { cancelAnimationFrame(id); if (opener && document.contains(opener)) opener.focus({ preventScroll: true }); };
  }, []);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || layerAbove(rootRef.current)) return;
      e.preventDefault(); e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [onClose]);

  const ready = !!title.trim() && DATE_RE.test(date.trim()) && !busy;
  const run = async (f: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try { await f(); toast.success(ok); onSaved(); onClose(); }
    catch (err) { toast.error((err as Error)?.message || "Couldn't save"); }
    finally { setBusy(false); }
  };
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!ready) return;
    void run(() => api.planningSaveCommitment({ id: initial?.id, title: title.trim(), date: date.trim(), project: project || null }), "Saved");
  };

  return createPortal(
    <div ref={rootRef} role="dialog" aria-modal="true" aria-label={initial ? "Edit commitment" : "New commitment"} data-knav-modal data-plan="commit-dialog"
      className="fixed inset-0 z-[170] bg-background/80 flex items-center justify-center animate-in fade-in duration-150"
      onMouseDown={() => { if (!busy) onClose(); }}>
      <form onSubmit={submit} onMouseDown={(e) => e.stopPropagation()}
        className="w-[380px] max-w-[92vw] grid gap-3 rounded-lg border border-border bg-card shadow-xl p-5">
        <h2 className="text-[15px] font-medium leading-none tracking-tight">{initial ? "Commitment" : "New commitment"}</h2>
        <input ref={titleRef} data-plan="commit-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title"
          title="What is due"
          className="h-9 w-full rounded-md border border-border bg-background px-3 text-[13.5px] focus:outline-none focus:border-primary/60" />
        <input data-plan="commit-date" value={date} onChange={(e) => setDate(e.target.value)} placeholder="YYYY-MM-DD" inputMode="numeric"
          title="Due date, YYYY-MM-DD" aria-invalid={!!date && !DATE_RE.test(date.trim())}
          className={`h-9 w-full rounded-md border bg-background px-3 text-[13.5px] nums focus:outline-none focus:border-primary/60 ${date && !DATE_RE.test(date.trim()) ? "border-destructive" : "border-border"}`} />
        <select data-plan="commit-project" value={project} onChange={(e) => setProject(e.target.value)} title="The project this commitment belongs to"
          className="h-9 w-full rounded-md border border-border bg-background px-2 text-[13.5px]">
          <option value="">No project</option>
          {projects.map((p) => <option key={p.key} value={p.key}>{p.title}</option>)}
        </select>
        <div className="flex items-center gap-1 pt-0.5">
          {initial && <>
            <button type="button" disabled={busy} title="Remove this commitment"
              onClick={() => void run(() => api.planningDeleteCommitment(initial.id), "Removed")}
              className="text-[13px] text-muted-foreground hover:text-destructive px-2 py-1.5 transition-colors">Remove</button>
            <button type="button" disabled={busy} title="Mark it done — it leaves the strip"
              onClick={() => void run(() => api.planningSaveCommitment({ id: initial.id, title: initial.title, date: initial.date, project: initial.project ?? null, done: true }), "Done")}
              className="text-[13px] text-muted-foreground hover:text-foreground px-2 py-1.5 transition-colors">Done</button>
          </>}
          <span className="flex-1" />
          <button type="button" onClick={onClose} className="text-[13px] text-muted-foreground hover:text-foreground px-3 py-1.5 transition-colors">Cancel</button>
          <button type="submit" disabled={!ready} data-plan="commit-save"
            className="text-[13px] rounded-md px-3.5 py-1.5 bg-primary text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-40 disabled:pointer-events-none">Save</button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

/* --------------------------------------------------------------------- a card */

function NextStep({ item, editing, setEditing, onSave }: {
  item: PipelineItem; editing: boolean; setEditing: (v: boolean) => void; onSave: (text: string) => void;
}) {
  const [text, setText] = useState(item.next);
  const btnRef = useRef<HTMLButtonElement>(null);
  const closed = useRef(false);   // Enter/Escape closes once; the blur that follows must not save again
  useEffect(() => { if (!editing) setText(item.next); else closed.current = false; }, [item.next, editing]);
  const close = (save: boolean) => {
    if (closed.current) return;
    closed.current = true;
    if (save && text.trim() !== item.next) onSave(text.trim());
    setEditing(false);
    requestAnimationFrame(() => btnRef.current?.focus({ preventScroll: true }));
  };
  if (editing) {
    return (
      <input autoFocus value={text} onChange={(e) => setText(e.target.value)} data-plan="next-input"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") { e.preventDefault(); close(true); }
          else if (e.key === "Escape") { e.preventDefault(); close(false); }
        }}
        onBlur={() => close(true)}
        placeholder="Next step…"
        className="w-full rounded border border-primary/50 bg-background px-1.5 py-0.5 text-[12px] focus:outline-none" />
    );
  }
  return (
    <button ref={btnRef} type="button" data-plan="next" onClick={(e) => { e.stopPropagation(); setEditing(true); }}
      title={item.next ? "Next step — ⏎ or n to edit" : "Add the next step — ⏎ or n"}
      className={`block w-full text-left rounded px-1.5 py-0.5 -mx-1.5 text-[12px] leading-snug hover:bg-accent transition-colors ${item.next ? "text-foreground/85" : "text-muted-foreground/60"}`}>
      {item.next || "Next step…"}
    </button>
  );
}

function PipeCard({ item, stageIdx, onOpen, onMove, onFocus, onNext, onCommit }: {
  item: PipelineItem; stageIdx: number;
  onOpen: () => void; onMove: (delta: number) => void; onFocus: () => void; onNext: (text: string) => void;
  onCommit: (c: PlanCommitment) => void;
}) {
  const [editing, setEditing] = useState(false);
  const onKey = (e: RKeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target as HTMLElement;
    if (t.matches("input, textarea, select")) return;
    if ((e.shiftKey && e.key === "ArrowLeft") || e.key === "[") { e.preventDefault(); onMove(-1); return; }
    if ((e.shiftKey && e.key === "ArrowRight") || e.key === "]") { e.preventDefault(); onMove(1); return; }
    if (e.key === "f" && !e.shiftKey) { e.preventDefault(); onFocus(); return; }
    if (e.key === "n" && !e.shiftKey) { e.preventDefault(); setEditing(true); return; }
    // ⏎ on the card itself opens it; ⏎ on a control inside does that control's thing
    if ((e.key === "Enter" || e.key === " ") && t === e.currentTarget) { e.preventDefault(); onOpen(); }
  };
  return (
    <div role="button" tabIndex={0} data-plan-card={item.key} data-knav-id={"plan:" + item.key}
      onClick={onOpen} onKeyDown={onKey}
      title={`${item.title} — ⏎ open · [ ] or Shift+←/→ stage · f focus · n next step`}
      className={`group/card relative rounded-lg border bg-card px-3 py-2.5 grid gap-1.5 cursor-pointer transition-colors hover:border-primary/50 focus:outline-none focus-visible:border-primary/70 ${item.focus ? "border-primary/40" : "border-border"}`}>
      <div className="flex items-start gap-1.5 min-w-0">
        <span className="min-w-0 flex-1 text-[13px] font-medium leading-snug line-clamp-2">{item.title}</span>
        {item.stale && <span data-knav-skip title="No change in 3+ weeks" className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-warning" />}
        <button type="button" data-plan="focus" aria-pressed={item.focus}
          onClick={(e) => { e.stopPropagation(); onFocus(); }}
          title={item.focus ? "Focus this week — f to drop" : "Make this a focus project this week (f), three at most"}
          className={`shrink-0 -mr-1 rounded p-0.5 transition-colors ${item.focus ? "text-primary" : "text-muted-foreground/50 hover:text-primary"}`}>
          <Star size={13} fill={item.focus ? "currentColor" : "none"} />
        </button>
      </div>
      <div className="flex items-center gap-1.5 min-w-0 flex-wrap">
        <span className="rounded-full border border-border px-1.5 py-px text-[10px] text-muted-foreground lowercase">{item.kind}</span>
        {item.commitment && <CountdownChip c={item.commitment} onClick={item.commitment.editable ? () => onCommit(item.commitment!) : undefined} />}
      </div>
      <NextStep item={item} editing={editing} setEditing={setEditing} onSave={onNext} />
      <div className="flex items-center justify-end gap-0.5 -mb-1 -mr-1.5">
        <button type="button" data-plan="stage-back" disabled={stageIdx <= 0}
          onClick={(e) => { e.stopPropagation(); onMove(-1); }}
          title={stageIdx > 0 ? `Back to ${STAGES[stageIdx - 1].label} — [ or Shift+←` : ""}
          className="rounded p-0.5 text-muted-foreground/60 hover:text-foreground hover:bg-accent disabled:opacity-0 transition-colors">
          <ChevronLeft size={14} />
        </button>
        <button type="button" data-plan="stage-fwd" disabled={stageIdx >= STAGES.length - 1}
          onClick={(e) => { e.stopPropagation(); onMove(1); }}
          title={stageIdx < STAGES.length - 1 ? `On to ${STAGES[stageIdx + 1].label} — ] or Shift+→` : ""}
          className="rounded p-0.5 text-muted-foreground/60 hover:text-foreground hover:bg-accent disabled:opacity-0 transition-colors">
          <ChevronRight size={14} />
        </button>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- the pipeline */

const focusCard = (key: string) => requestAnimationFrame(() => {
  const el = document.querySelector<HTMLElement>(`[data-plan-card="${CSS.escape(key)}"]`);
  if (el) { el.focus({ preventScroll: true }); el.scrollIntoView({ block: "nearest" }); }
});

export function DraftingPipeline({ onOpenKey, onStatus }: {
  onOpenKey: (key: string) => void;
  /** the library's own status setter: patches its lists and POSTs /drafting/status */
  onStatus: (key: string, status: DraftStatus) => Promise<void> | void;
}) {
  const pipe = useApi(() => api.planningPipeline(), [], 60_000);
  const commits = useApi(() => api.planningCommitments(), [], 60_000);
  const [dialog, setDialog] = useState<{ c: PlanCommitment | null } | null>(null);
  const items = useMemo(() => pipe.data?.items ?? [], [pipe.data]);
  const setItems = useCallback((f: (xs: PipelineItem[]) => PipelineItem[]) => {
    if (pipe.data) pipe.set({ ...pipe.data, items: f(pipe.data.items) });
  }, [pipe]);
  const projects = useMemo(() => items.map((x) => ({ key: x.key, title: x.title })), [items]);
  const strip = useMemo(() => (commits.data ?? []).filter((c) => !c.done).slice().sort(sortByDate), [commits.data]);

  const move = async (it: PipelineItem, delta: number) => {
    const i = STAGES.findIndex((s) => s.id === it.stage);
    const to = STAGES[i + delta];
    if (i < 0 || !to) return;
    setItems((xs) => xs.map((x) => (x.key === it.key ? { ...x, stage: to.id } : x)));
    focusCard(it.key);
    await onStatus(it.key, to.id);
  };
  const toggleFocus = async (it: PipelineItem) => {
    const cur = items.filter((x) => x.focus).map((x) => x.key);
    if (!it.focus && cur.length >= FOCUS_MAX) { toast.error("Three focus projects already this week"); return; }
    const keys = it.focus ? cur.filter((k) => k !== it.key) : [...cur, it.key];
    setItems((xs) => xs.map((x) => ({ ...x, focus: keys.includes(x.key) })));
    try { await api.planningSetFocus(keys); }
    catch (err) { toast.error((err as Error)?.message || "Couldn't set focus"); pipe.reload(); }
  };
  const setNext = async (it: PipelineItem, text: string) => {
    setItems((xs) => xs.map((x) => (x.key === it.key ? { ...x, next: text } : x)));
    try { await api.planningSetNext(it.key, text); }
    catch (err) { toast.error((err as Error)?.message || "Couldn't save the next step"); pipe.reload(); }
  };
  const onSaved = () => { commits.reload(); pipe.reload(); };

  if (pipe.error != null && !pipe.data) {
    return <div className="py-10 text-center"><button type="button" onClick={pipe.reload} className="text-[13px] text-muted-foreground hover:text-foreground">Pipeline unavailable — retry</button></div>;
  }
  if (!pipe.data) return <div className="h-40" aria-busy="true" />;

  return (
    <div data-plan="pipeline" className="grid gap-4">
      <div data-plan="commitments" className="flex flex-wrap items-center gap-1.5">
        {strip.map((c) => (
          <CountdownChip key={c.id} c={c} className="py-1"
            onClick={() => {
              if (c.editable) setDialog({ c });
              else if (c.project && items.some((x) => x.key === c.project)) focusCard(c.project);
            }} />
        ))}
        <button type="button" data-plan="commit-add" onClick={() => setDialog({ c: null })} title="Add a commitment"
          className="inline-flex items-center justify-center rounded-full border border-dashed border-border h-6 w-6 text-muted-foreground hover:text-primary hover:border-primary/50 transition-colors">
          <Plus size={13} />
        </button>
      </div>
      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))" }}>
        {STAGES.map((s, si) => {
          const col = items.filter((x) => x.stage === s.id)
            .sort((a, b) => Number(b.focus) - Number(a.focus) || (a.commitment?.days ?? 1e6) - (b.commitment?.days ?? 1e6) || b.mtime - a.mtime);
          return (
            <section key={s.id} data-plan-stage={s.id} aria-label={s.label} className="min-w-0 grid content-start gap-2 rounded-xl bg-muted/30 p-2">
              <h2 className="flex items-center gap-2 px-1 pt-0.5 text-[12px] font-medium uppercase tracking-wide text-muted-foreground">
                {s.label}<span className="nums text-[11px] text-muted-foreground/60">{col.length}</span>
              </h2>
              {col.map((it) => (
                <PipeCard key={it.key} item={it} stageIdx={si}
                  onOpen={() => onOpenKey(it.key)}
                  onMove={(d) => void move(it, d)}
                  onFocus={() => void toggleFocus(it)}
                  onNext={(t) => void setNext(it, t)}
                  onCommit={(c) => setDialog({ c })} />
              ))}
            </section>
          );
        })}
      </div>
      {dialog && <CommitmentDialog initial={dialog.c} projects={projects} onClose={() => setDialog(null)} onSaved={onSaved} />}
    </div>
  );
}

/* --------------------------------------------------------------- Today's strip */

/** Commitments due within 14 days and this week's focus projects with their next
 *  step. Renders nothing when there is neither. */
export function TodayPlanStrip({ go }: { go: (v: string) => void }) {
  const pipe = useApi(() => api.planningPipeline(), [], 300_000);
  const commits = useApi(() => api.planningCommitments(), [], 300_000);
  const soon = useMemo(() => (commits.data ?? []).filter((c) => !c.done && c.days <= 14).sort(sortByDate), [commits.data]);
  const focus = useMemo(() => (pipe.data?.items ?? []).filter((x) => x.focus).slice(0, FOCUS_MAX), [pipe.data]);
  if (!soon.length && !focus.length) return null;
  const toPipeline = () => { requestDraftingTab("pipeline"); go("drafting"); };
  const openItem = (it: PipelineItem) => {
    const [kind, slug, ...rest] = it.key.split(":");
    const doc = rest.join(":");
    if (kind === "paper" && slug && doc) { setPendingDraftOpen({ slug, doc }); go("drafting"); return; }
    toPipeline();
  };
  return (
    <div data-plan="today-strip" className="mt-3 flex flex-wrap items-center gap-1.5">
      {soon.map((c) => <CountdownChip key={c.id} c={c} className="py-1" onClick={toPipeline} />)}
      {soon.length > 0 && focus.length > 0 && <span className="w-px self-stretch bg-border mx-1" />}
      {focus.map((it) => (
        <button key={it.key} type="button" data-plan="today-focus" onClick={() => openItem(it)}
          title={`${it.title}${it.next ? " — next: " + it.next : ""}`}
          className="inline-flex min-w-0 max-w-[340px] items-center gap-1.5 rounded-full border border-primary/35 px-2.5 py-1 text-[11.5px] hover:border-primary/60 transition-colors">
          <Star size={11} className="shrink-0 text-primary" fill="currentColor" />
          <span className="shrink-0 font-medium text-foreground">{shortTitle(it.title)}</span>
          {it.next && <span className="min-w-0 truncate text-muted-foreground">{it.next}</span>}
        </button>
      ))}
    </div>
  );
}
