
import { useEffect, useState } from "react";
import type { ReactNode } from "react";

export function WidgetColumn({ label, hint, meta, children }: {
  label: string; hint?: string; meta?: ReactNode; children: ReactNode;
}) {
  return (
    <div className="mx-auto flex h-full w-full max-w-[720px] flex-col gap-3 min-[900px]:gap-4 min-[900px]:pt-6">
      <div className="flex shrink-0 items-center justify-between gap-3 min-h-[24px]">
        <div title={hint}
          className="text-[11px] min-[900px]:text-[12px] uppercase tracking-[0.1em] font-semibold text-muted-foreground">
          {label}
        </div>
        {meta != null && <div className="text-[11px] min-[900px]:text-[12px] text-muted-foreground nums">{meta}</div>}
      </div>
      {children}
    </div>
  );
}

/** Date.now(), re-read every `stepMs` while `on` */
export function useClock(stepMs: number, on = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), stepMs);
    return () => window.clearInterval(id);
  }, [stepMs, on]);
  return now;
}

export function freeKey(e: KeyboardEvent): boolean {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return false;
  const t = e.target as HTMLElement | null;
  if (!t || t === document.body || t === document.documentElement) return true;
  return !t.closest("button, a[href], input, textarea, select, summary, [role=button], [role=radio], "
    + "[role=checkbox], [contenteditable=true], [data-knav-item]");
}

/** shared button looks, on the board's tokens */
export const BTN_PRIMARY = "inline-flex items-center justify-center gap-2 rounded-full bg-primary text-primary-foreground "
  + "px-5 py-2 text-[13px] font-medium hover:opacity-90 transition-opacity disabled:opacity-40";
export const BTN_QUIET = "inline-flex items-center justify-center gap-1.5 rounded-full border border-border bg-secondary/40 "
  + "px-3.5 py-2 text-[12.5px] font-medium text-muted-foreground hover:text-foreground hover:border-primary/50 "
  + "transition-colors disabled:opacity-40 focus-visible:text-foreground";
