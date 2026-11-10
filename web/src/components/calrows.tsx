
import { useRef, useState } from "react";
import type { ReactNode } from "react";
import { ArrowRight, CalendarDays, Layers, Loader2, Plus, Video, X } from "lucide-react";
import { api } from "@/lib/api";
import type { Event, TLItem } from "@/lib/api";
import { fmtEst, prioColor, relDue, titleCase, toneColor } from "@/lib/format";
import { linkAction } from "@/lib/taskdest";
import { isoAdd, isoToday, parseQuickAdd } from "@/lib/taskline";

/** An event's join link, or null. http(s) only — the same rule serve.py writes by,
 *  so a hand-edited note can never put a `javascript:` URL on a control. */
export function joinUrl(e: Event): string | null {
  const u = (e.link || "").trim();
  return /^https?:\/\/\S+$/i.test(u) ? u : null;
}

export function JoinButton({ e, label = true }: { e: Event; label?: boolean }) {
  const url = joinUrl(e);
  if (!url) return null;
  return (
    <button onClick={(ev) => { ev.stopPropagation(); api.openUrl(url); }}
      title={`Join the call — ${url}`} aria-label={`Join the call: ${e.title}`}
      data-knav-id={`join:${e.path}`}
      className="self-center shrink-0 inline-flex items-center gap-1 rounded-full border border-border bg-background px-2 py-1 text-[10.5px] text-muted-foreground hover:text-foreground hover:border-primary/50 focus-visible:text-foreground transition-colors">
      <Video size={12} />{label ? "Join" : null}
    </button>
  );
}

/** The quiet pill every inline action on the calendar uses. */
export const Chip = ({ children, onClick, title }: { children: ReactNode; onClick: () => void; title?: string }) => (
  <button onClick={onClick} title={title}
    className="inline-flex items-center gap-1 rounded-full border border-border bg-background px-2 py-1 text-[10.5px] text-muted-foreground hover:text-foreground hover:border-primary/50 transition-colors">
    {children}
  </button>
);

/** A dated task: tick it off, retime it, unpin it, or follow it to where the work is. */
export function TaskRow({ it, openBoard, go, onToggle, onReschedule, busy, carried }: {
  it: TLItem; openBoard: (path: string, title: string, isPaper: boolean) => void;
  go?: (v: string) => void;
  onToggle: () => void; onReschedule: (iso: string | null) => void; busy?: boolean; carried?: boolean;
}) {
  const [dateOpen, setDateOpen] = useState(false);
  const r = carried ? relDue(it.due) : null;
  const est = it.est ?? 0;
  const today = isoToday();
  // the task's smart destination (the reading / draft / note itself) — a quiet
  // primary-tinted chip after the board name
  const smart = it.link && go ? linkAction(it.link, go) : null;
  return (
    <div className={`group flex items-center gap-3 rounded-xl border border-border bg-card px-3.5 py-2.5 hover:border-primary/40 hover:shadow-card transition-all ${busy ? "opacity-50" : ""}`}>
      <button onClick={onToggle} disabled={busy || !it.raw} title="Mark done" aria-label={`Mark done: ${it.text}`}
        className="shrink-0 h-[18px] w-[18px] rounded-[5px] border-2 border-muted-foreground/40 hover:border-primary hover:bg-primary/10 transition-colors grid place-items-center">
        {busy && <Loader2 size={11} className="animate-spin text-muted-foreground" />}
      </button>
      <span className="w-1 self-stretch rounded-full shrink-0" style={{ background: prioColor(it.priority) }} />
      <span className="flex-1 min-w-0">
        <span className="block text-[14px] leading-snug line-clamp-2">{it.text}</span>
        <span className="text-[11.5px] text-muted-foreground nums mt-0.5 flex items-center gap-2 flex-wrap capitalize">
          <button onClick={() => openBoard(it.path, titleCase(it.board), !it.isPlanning)} className="hover:text-primary transition-colors">{it.board}</button>
          {smart && it.link && (
            <button onClick={smart} className="normal-case text-primary/85 hover:text-primary font-medium transition-colors inline-flex items-center gap-0.5">
              {it.link.label} <ArrowRight size={10} />
            </button>
          )}
          {est > 0 && <span>≈{fmtEst(est)}</span>}
          {r && <span style={{ color: toneColor(r.tone) }}>{r.label}</span>}
        </span>
      </span>
      {/* reschedule — visible on hover, always tappable on touch */}
      <span className="shrink-0 flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
        {carried
          ? <Chip onClick={() => onReschedule(today)}>Today</Chip>
          : <Chip onClick={() => onReschedule(isoAdd(it.due >= today ? it.due : today, 1))}>+1d</Chip>}
        <Chip onClick={() => setDateOpen((v) => !v)} title="Move to another day"><CalendarDays size={11} /></Chip>
        <Chip onClick={() => onReschedule(null)} title="Unpin — send to floating"><Layers size={11} /></Chip>
      </span>
      {dateOpen && (
        <input type="date" defaultValue={it.due >= today ? it.due : today} aria-label="Pick a date"
          className="shrink-0 h-7 bg-secondary/40 border border-border rounded-md px-1.5 text-[11.5px] focus:outline-none focus:border-primary"
          onChange={(e) => { if (e.target.value) { onReschedule(e.target.value); setDateOpen(false); } }}
          onBlur={() => setDateOpen(false)} />
      )}
    </div>
  );
}

export function QuickAdd({ defaultDue, onAdd, onClose, autoFocus, placeholder }: {
  defaultDue: string | null; onAdd: (card: string, due: string | null) => Promise<void>;
  onClose?: () => void; autoFocus?: boolean; placeholder?: string;
}) {
  const [v, setV] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  const submit = async () => {
    if (!v.trim() || busy) return;
    const parsed = parseQuickAdd(v, defaultDue);
    if (!parsed.text) return;
    setBusy(true);
    try { await onAdd(parsed.card, parsed.due); setV(""); ref.current?.focus(); }
    finally { setBusy(false); }
  };
  return (
    <div className="flex items-center gap-2">
      <div className="relative flex-1">
        <Plus size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/50" />
        {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
        <input ref={ref} value={v} onChange={(e) => setV(e.target.value)} autoFocus={autoFocus}
          aria-label="Add a task"
          onKeyDown={(e) => {
            if (e.defaultPrevented) return;
            // armed by the arrow layer: Enter starts typing, so leave it to that layer
            const armed = e.currentTarget.hasAttribute("data-knav-armed");
            if (e.key === "Enter" && !armed) { e.preventDefault(); submit(); }
            // an empty or armed field closes; mid-typing, the first Escape only stops editing
            if (e.key === "Escape" && onClose && (armed || !v)) { e.preventDefault(); onClose(); }
          }}
          placeholder={placeholder ?? "Add a task…   @tomorrow  !high  ~45m  #tag"}
          className="w-full h-9 bg-secondary/30 border border-dashed border-border rounded-full pl-8 pr-3 text-[13px] focus:outline-none focus:border-primary focus:border-solid placeholder:text-muted-foreground/40" />
      </div>
      {busy && <Loader2 size={13} className="animate-spin text-muted-foreground" />}
      {onClose && <button onClick={onClose} aria-label="Close the quick add" className="text-muted-foreground/60 hover:text-foreground"><X size={13} /></button>}
    </div>
  );
}

/** A labelled block inside the day panel. Renders nothing when it has no rows, so
 *  a quiet day reads as a quiet panel. */
export function PanelSection({ label, icon, count, children, right, hint }: {
  label: string; icon?: ReactNode; count?: number; children: ReactNode; right?: ReactNode;
  /** what the section is for — a tooltip on the label, never a paragraph */
  hint?: string;
}) {
  return (
    <section className="mb-5 last:mb-0">
      <div className="flex items-center gap-2 mb-2">
        <div className="text-[10.5px] uppercase tracking-[0.1em] font-semibold text-muted-foreground flex items-center gap-1.5" title={hint}>
          {icon}{label}{count !== undefined && count > 0 ? <span className="nums opacity-60">{count}</span> : null}
        </div>
        {right && <div className="ml-auto">{right}</div>}
      </div>
      {children}
    </section>
  );
}
