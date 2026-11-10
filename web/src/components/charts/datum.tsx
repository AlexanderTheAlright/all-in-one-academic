
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { HTMLAttributes, KeyboardEvent as RKeyboardEvent, PointerEvent as RPointerEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

export const REST_MS = 260;   // the pointer must settle this long before a tip opens
const LEAVE_MS = 120;         // grace for a pointer that slips off a mark and back

export type DatumCursor = {
  /** the mark under the pointer or the keys, or null */
  active: number | null;
  /** true while the keys are stepped into the chart */
  engaged: boolean;
  /** spread on the chart's outer element */
  surface: HTMLAttributes<HTMLDivElement> & { ref: (el: HTMLDivElement | null) => void; "data-knav-item": string; "data-datum-surface": string; "data-knav-own"?: string };
  /** spread on each mark (rect, circle, div) */
  mark: (i: number) => { "data-datum": number };
  el: HTMLDivElement | null;
  set: (i: number | null) => void;
};

export function useDatumCursor(n: number, opts: {
  /** marks per row, for ↑↓ in a grid (a heatmap's week column is 7 tall: pass rows via `cols`) */
  cols?: number;
  /** map a pointer to a mark when marks are thin (a line chart snaps to the nearest x) */
  pick?: (e: RPointerEvent<HTMLDivElement>, el: HTMLDivElement) => number | null;
  /** where ⏎ lands first; defaults to the last mark (the most recent) */
  start?: number;
  /** skip marks with no data when walking by keys */
  skip?: (i: number) => boolean;
  /** ⏎ on an engaged mark (open the day, say) */
  onPress?: (i: number) => void;
} = {}) {
  const [active, setActive] = useState<number | null>(null);
  const [engaged, setEngaged] = useState(false);
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const rest = useRef<number | undefined>(undefined);
  const leave = useRef<number | undefined>(undefined);
  const open = useRef(false);
  open.current = active != null;
  const o = useRef(opts);
  o.current = opts;

  useEffect(() => () => { window.clearTimeout(rest.current); window.clearTimeout(leave.current); }, []);
  // data changed under the cursor: keep it in range
  useEffect(() => { setActive((a) => (a == null ? a : n ? Math.min(a, n - 1) : null)); }, [n]);

  const at = (e: RPointerEvent<HTMLDivElement>, root: HTMLDivElement): number | null => {
    if (o.current.pick) return o.current.pick(e, root);
    const hit = (e.target as Element | null)?.closest?.("[data-datum]");
    if (!hit || !root.contains(hit)) return null;
    const i = Number(hit.getAttribute("data-datum"));
    return Number.isFinite(i) ? i : null;
  };

  const onPointerMove = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "touch") return;
    const root = e.currentTarget;
    window.clearTimeout(leave.current);
    const i = at(e, root);
    if (open.current) { if (i != null) setActive(i); return; }
    // not open yet: every move restarts the wait, so only a resting pointer opens it
    window.clearTimeout(rest.current);
    if (i == null) return;
    const x = e.clientX, y = e.clientY;
    rest.current = window.setTimeout(() => {
      const under = document.elementFromPoint(x, y);
      if (!under || !root.contains(under)) return;
      setActive(o.current.pick ? i : (() => {
        const h = under.closest("[data-datum]");
        return h ? Number(h.getAttribute("data-datum")) : null;
      })());
    }, REST_MS);
  };
  const onPointerLeave = () => {
    window.clearTimeout(rest.current);
    if (engaged) return;
    leave.current = window.setTimeout(() => setActive(null), LEAVE_MS);
  };

  // in a grid, ←→ stay on their row (no wrap onto the next one); ↑↓ stay in the column
  const step = (from: number, d: number, inRow = false): number => {
    const cols = o.current.cols ?? 0;
    const row = cols ? Math.floor(from / cols) : 0;
    let i = from;
    for (let k = 0; k < n; k++) {
      i += d;
      if (i < 0 || i >= n) return from;
      if (inRow && cols && Math.floor(i / cols) !== row) return from;
      if (!o.current.skip?.(i)) return i;
    }
    return from;
  };

  const onKeyDown = (e: RKeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || !n) return;
    const k = e.key;
    if (!engaged) {
      if (k === "Enter" || k === " ") {
        e.preventDefault(); e.stopPropagation();
        let s = o.current.start ?? n - 1;
        if (o.current.skip?.(s)) s = step(s, -1) !== s ? step(s, -1) : step(s, 1);
        setEngaged(true); setActive(s);
      }
      return;
    }
    const cols = o.current.cols ?? 0;
    const cur = active ?? n - 1;
    let next: number | null = null;
    if (k === "ArrowRight") next = step(cur, 1, true);
    else if (k === "ArrowLeft") next = step(cur, -1, true);
    else if (k === "ArrowDown") next = cols ? step(cur, cols) : step(cur, 1);
    else if (k === "ArrowUp") next = cols ? step(cur, -cols) : step(cur, -1);
    else if (k === "Home") next = step(-1, 1);
    else if (k === "End") next = step(n, -1);
    else if (k === "Enter" || k === " ") {
      e.preventDefault(); e.stopPropagation();
      if (active != null) o.current.onPress?.(active);
      return;
    } else if (k === "Escape") {
      e.preventDefault(); e.stopPropagation();
      setEngaged(false); setActive(null);
      return;
    } else return;
    e.preventDefault(); e.stopPropagation();
    setActive(next);
  };

  const ref = useCallback((node: HTMLDivElement | null) => setEl(node), []);
  const surface: DatumCursor["surface"] = {
    ref,
    tabIndex: 0,
    role: "group",
    "data-knav-item": "",
    "data-datum-surface": "",
    ...(engaged ? { "data-knav-own": "arrows enter escape" } : {}),
    onPointerMove, onPointerLeave, onKeyDown,
    onBlur: () => { setEngaged(false); setActive(null); },
    onPointerDown: () => { window.clearTimeout(rest.current); },
  };
  const mark = useCallback((i: number) => ({ "data-datum": i }), []);
  return { active, engaged, surface, mark, el, set: setActive } as DatumCursor;
}

/** The one tooltip. Sits above the active mark (below when there is no room), never
 * under the pointer, never catches the pointer, and says only what the mark is. */
export function ChartTip({ cursor, children, className }: {
  cursor: DatumCursor; children: ReactNode; className?: string;
}) {
  const tip = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const { active, el } = cursor;
  useLayoutEffect(() => {
    if (active == null || !el) { setPos(null); return; }
    const m = el.querySelector(`[data-datum="${active}"]`) as Element | null;
    const r = (m ?? el).getBoundingClientRect();
    const t = tip.current?.getBoundingClientRect();
    const tw = t?.width ?? 120, th = t?.height ?? 28;
    let x = r.left + r.width / 2 - tw / 2;
    x = Math.max(8, Math.min(window.innerWidth - tw - 8, x));
    let y = r.top - th - 8;
    if (y < 8) y = r.bottom + 8;
    setPos({ x, y });
  }, [active, el, children]);
  if (active == null || children == null || children === false) return null;
  return createPortal(
    <div ref={tip} role="tooltip"
      className={cn(
        "pointer-events-none fixed z-[70] whitespace-nowrap rounded-md border bg-popover px-2 py-1",
        "text-[11px] leading-tight text-popover-foreground shadow-sm tabular-nums",
        className,
      )}
      style={{ left: pos?.x ?? -9999, top: pos?.y ?? -9999 }}>
      {children}
    </div>,
    document.body,
  );
}

/** a line chart's pick: nearest mark by x across the whole surface */
export const pickByX = (count: number, padL = 0, padR = 0) =>
  (e: RPointerEvent<HTMLDivElement>, el: HTMLDivElement): number | null => {
    if (!count) return null;
    const r = el.getBoundingClientRect();
    const w = r.width - padL - padR;
    if (w <= 0) return null;
    const f = (e.clientX - r.left - padL) / w;
    return Math.max(0, Math.min(count - 1, Math.round(f * (count - 1))));
  };
