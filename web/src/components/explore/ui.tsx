
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

const CTL = "h-7 rounded-md border border-input bg-card px-2 text-[12px] text-foreground " +
  "outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-50";

export function Field({ label, hint, children, wide }:
  { label: string; hint?: string; children: ReactNode; wide?: boolean }) {
  return (
    <label className={cn("flex min-w-0 flex-col gap-1", wide && "col-span-2")} title={hint}>
      <span className="text-[10.5px] uppercase tracking-wide text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

export function Sel({ value, onChange, options, title, disabled }:
  { value: string; onChange: (v: string) => void; options: { v: string; label: string }[];
    title?: string; disabled?: boolean }) {
  return (
    <select className={cn(CTL, "w-full")} value={value} title={title} disabled={disabled}
      onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
    </select>
  );
}

export function Txt({ value, onChange, placeholder, title, disabled }:
  { value: string; onChange: (v: string) => void; placeholder?: string; title?: string; disabled?: boolean }) {
  return (
    <input className={cn(CTL, "w-full")} value={value} placeholder={placeholder} title={title}
      disabled={disabled} onChange={(e) => onChange(e.target.value)} />
  );
}

export function Num({ value, onChange, title, min, max, disabled }:
  { value: number; onChange: (v: number) => void; title?: string; min?: number; max?: number; disabled?: boolean }) {
  return (
    <input type="number" className={cn(CTL, "w-full")} value={value} title={title} min={min} max={max}
      disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} />
  );
}

export function Toggle({ on, onChange, label, title }:
  { on: boolean; onChange: (v: boolean) => void; label: string; title?: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} title={title}
      onClick={() => onChange(!on)}
      className={cn("h-7 rounded-md border px-2 text-[12px] transition-colors",
        on ? "border-primary/60 bg-primary/12 text-primary" : "border-input bg-card text-muted-foreground hover:text-foreground")}>
      {label}
    </button>
  );
}

export function Btn({ onClick, children, title, tone = "quiet", disabled }:
  { onClick: () => void; children: ReactNode; title: string; tone?: "primary" | "quiet" | "danger"; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} title={title} disabled={disabled}
      className={cn("h-7 shrink-0 rounded-md px-2.5 text-[12px] font-medium transition-colors disabled:opacity-45",
        tone === "primary" && "bg-primary text-primary-foreground hover:bg-primary/90",
        tone === "quiet" && "border border-input bg-card text-foreground hover:bg-secondary",
        tone === "danger" && "border border-destructive/50 bg-card text-destructive hover:bg-destructive/10")}>
      {children}
    </button>
  );
}

/** an icon-only action. Always titled — that is the whole tooltip contract. */
export function IconBtn({ onClick, title, children, on, disabled }:
  { onClick: () => void; title: string; children: ReactNode; on?: boolean; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} title={title} aria-label={title} disabled={disabled}
      className={cn("grid h-7 w-7 shrink-0 place-items-center rounded-md transition-colors disabled:opacity-45",
        on ? "bg-primary/15 text-primary" : "text-muted-foreground hover:bg-secondary hover:text-foreground")}>
      {children}
    </button>
  );
}

export function Chip({ children, tone = "muted", title }:
  { children: ReactNode; tone?: "muted" | "accent" | "warn"; title?: string }) {
  return (
    <span title={title}
      className={cn("inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-[1px] text-[10.5px] leading-tight",
        tone === "muted" && "bg-secondary text-muted-foreground",
        tone === "accent" && "bg-primary/14 text-primary",
        tone === "warn" && "bg-destructive/12 text-destructive")}>
      {children}
    </span>
  );
}

/** one line, never a paragraph: the view's only place for an error or a status */
export function Line({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "bad" }) {
  return (
    <p className={cn("truncate text-[11.5px]", tone === "bad" ? "text-destructive" : "text-muted-foreground")}>
      {children}
    </p>
  );
}
