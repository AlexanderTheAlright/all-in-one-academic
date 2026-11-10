
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Plus, Trash2, ChevronUp, ChevronDown, RotateCcw, Save } from "lucide-react";

/* ------------------------------------------------------------------ draft state */

export function usePlanDraft<T>(remote: T | null | undefined) {
  const [draft, setDraft] = useState<T | null>(remote ?? null);
  const [dirty, setDirty] = useState(false);
  const seed = useRef<string>("");

  useEffect(() => {
    const next = JSON.stringify(remote ?? null);
    if (next === seed.current) return;      // same payload -> leave the draft alone
    if (dirty) return;
    seed.current = next;
    setDraft(remote ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remote]);

  const edit = useCallback((fn: (d: T) => T) => {
    setDraft((d) => (d == null ? d : fn(structuredClone(d))));
    setDirty(true);
  }, []);

  const settle = useCallback((next: T) => {
    seed.current = JSON.stringify(next);
    setDraft(next);
    setDirty(false);
  }, []);

  const revert = useCallback(() => {
    setDraft(remote ?? null);
    seed.current = JSON.stringify(remote ?? null);
    setDirty(false);
  }, [remote]);

  return { draft, dirty, edit, settle, revert, setDirty };
}

/* --------------------------------------------------------------- list utilities */

export const move = <T,>(xs: T[], i: number, by: number): T[] => {
  const j = i + by;
  if (j < 0 || j >= xs.length) return xs;
  const out = xs.slice();
  [out[i], out[j]] = [out[j], out[i]];
  return out;
};
export const removeAt = <T,>(xs: T[], i: number): T[] => xs.filter((_, k) => k !== i);
export const patchAt = <T,>(xs: T[], i: number, p: Partial<T>): T[] =>
  xs.map((x, k) => (k === i ? { ...x, ...p } : x));

/* -------------------------------------------------------------------- controls */

/** Click-to-edit text that looks like text until you touch it.
 *  Enter commits (Shift+Enter newlines a multiline field), Escape reverts. */
export function EditText({
  value, onChange, placeholder = "—", multiline = false, className = "", ariaLabel,
}: {
  value: string; onChange: (v: string) => void; placeholder?: string;
  multiline?: boolean; className?: string; ariaLabel?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [buf, setBuf] = useState(value);
  const ref = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null);

  useEffect(() => { if (!editing) setBuf(value); }, [value, editing]);
  useEffect(() => {
    if (!editing || !ref.current) return;
    ref.current.focus();
    ref.current.select?.();
  }, [editing]);

  const commit = () => { setEditing(false); if (buf !== value) onChange(buf); };
  const cancel = () => { setBuf(value); setEditing(false); };

  if (!editing) {
    return (
      <button
        type="button"
        aria-label={ariaLabel}
        onClick={() => setEditing(true)}
        className={`text-left w-full rounded px-1 -mx-1 py-0.5 hover:bg-muted/60 focus-visible:bg-muted/60
                    focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/40
                    transition-colors ${className}`}
        title="Click to edit"
      >
        {value ? value : <span className="text-muted-foreground/50">{placeholder}</span>}
      </button>
    );
  }

  const shared = {
    value: buf,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setBuf(e.target.value),
    onBlur: commit,
    className: `w-full rounded border border-primary/50 bg-background px-1.5 py-0.5 ${className}
                focus:outline-none focus:ring-1 focus:ring-primary/50`,
    "aria-label": ariaLabel,
  };

  if (multiline) {
    return (
      <textarea
        {...shared}
        ref={ref as React.Ref<HTMLTextAreaElement>}
        rows={Math.min(8, Math.max(2, buf.split("\n").length))}
        onKeyDown={(e) => {
          if (e.key === "Escape") { e.preventDefault(); cancel(); }
          if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commit(); }
        }}
      />
    );
  }
  return (
    <input
      {...shared}
      ref={ref as React.Ref<HTMLInputElement>}
      onKeyDown={(e) => {
        if (e.key === "Escape") { e.preventDefault(); cancel(); }
        if (e.key === "Enter") { e.preventDefault(); commit(); }
      }}
    />
  );
}

/** A real date picker. Empty is allowed and means "no date". */
export function EditDate({ value, onChange, tone, ariaLabel }: {
  value?: string | null; onChange: (v: string) => void; tone?: string; ariaLabel?: string;
}) {
  return (
    <input
      type="date"
      aria-label={ariaLabel || "date"}
      value={value || ""}
      onChange={(e) => onChange(e.target.value)}
      style={tone ? { color: tone } : undefined}
      className="nums text-[12px] bg-transparent rounded px-1 py-0.5 border border-transparent
                 hover:border-border focus:border-primary/50 focus:outline-none
                 focus:ring-1 focus:ring-primary/30 transition-colors"
    />
  );
}

export function EditSelect({ value, onChange, options, ariaLabel, className = "", title }: {
  value?: string | null; onChange: (v: string) => void;
  options: { value: string; label: string }[]; ariaLabel?: string; className?: string;
  /** optional tooltip, for callers whose option labels are shortened */
  title?: string;
}) {
  return (
    <select
      aria-label={ariaLabel}
      title={title}
      value={value || ""}
      onChange={(e) => onChange(e.target.value)}
      className={`text-[11.5px] bg-transparent rounded px-1 py-0.5 border border-transparent
                  hover:border-border focus:border-primary/50 focus:outline-none
                  focus:ring-1 focus:ring-primary/30 transition-colors ${className}`}
    >
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

/** Reorder + delete, revealed on row hover so a dense list stays readable. */
export function RowTools({ onUp, onDown, onDelete, label = "row" }: {
  onUp?: () => void; onDown?: () => void; onDelete?: () => void; label?: string;
}) {
  return (
    <span className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100
                     focus-within:opacity-100 transition-opacity">
      {onUp && (
        <button type="button" onClick={onUp} aria-label={`move ${label} up`} title="Move up"
          className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground">
          <ChevronUp size={13} />
        </button>
      )}
      {onDown && (
        <button type="button" onClick={onDown} aria-label={`move ${label} down`} title="Move down"
          className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground">
          <ChevronDown size={13} />
        </button>
      )}
      {onDelete && (
        <button type="button" onClick={onDelete} aria-label={`remove ${label}`} title="Remove"
          className="p-0.5 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive">
          <Trash2 size={13} />
        </button>
      )}
    </span>
  );
}

export function AddRow({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mt-1.5 flex items-center gap-1.5 text-[12px] text-muted-foreground
                 hover:text-primary rounded px-1 -mx-1 py-1 transition-colors"
    >
      <Plus size={13} /> {children}
    </button>
  );
}

export function Section({ title, icon, right, children }: {
  title: string; icon?: ReactNode; right?: ReactNode; children: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border bg-card/60 p-4">
      <div className="flex items-center gap-1.5 mb-2">
        <div className="text-[11px] uppercase tracking-[0.09em] font-semibold text-muted-foreground
                        flex items-center gap-1.5">{icon}{title}</div>
        {right && <div className="ml-auto">{right}</div>}
      </div>
      {children}
    </div>
  );
}

export function DirtyBar({ dirty, saving, onSave, onRevert, note }: {
  dirty: boolean; saving?: boolean; onSave: () => void; onRevert: () => void; note?: string;
}) {
  if (!dirty) return null;
  return (
    <div className="mt-4 flex items-center gap-3 flex-wrap rounded-lg border border-amber-500/40
                    bg-amber-500/[0.07] px-3 py-2">
      <span className="text-[12.5px] font-medium">Unsaved changes</span>
      {note && <span className="text-[12px] text-muted-foreground">{note}</span>}
      <div className="ml-auto flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onRevert} disabled={saving} className="gap-1.5 h-7">
          <RotateCcw size={13} /> Revert
        </Button>
        <Button variant="outline" size="sm" onClick={onSave} disabled={saving} className="gap-1.5 h-7">
          <Save size={13} /> {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------- date tones */

export const daysUntil = (iso?: string | null): number | null => {
  if (!iso) return null;
  const d = new Date(iso + "T00:00:00");
  const t = new Date(); t.setHours(0, 0, 0, 0);
  return Math.round((d.getTime() - t.getTime()) / 86_400_000);
};
export const dateTone = (iso?: string | null): string => {
  const n = daysUntil(iso);
  if (n === null) return "hsl(var(--muted-foreground))";
  if (n < 0) return "hsl(var(--destructive))";
  if (n <= 3) return "hsl(28 78% 52%)";
  return "hsl(var(--muted-foreground))";
};
export const rel = (iso?: string | null): string => {
  const n = daysUntil(iso);
  if (n === null) return "";
  if (n < 0) return `${-n}d overdue`;
  if (n === 0) return "today";
  return `in ${n}d`;
};

export const PRIORITY_OPTS = [
  { value: "", label: "priority" },
  { value: "high", label: "high" },
  { value: "medium", label: "medium" },
  { value: "low", label: "low" },
];
