
import { useCallback, useEffect, useRef } from "react";
import type { PointerEvent as RPointerEvent } from "react";

/** how long the pointer has to settle on a row before hover means anything */
export const INTENT_MS = 450;
/** movement under this (px) still counts as resting */
const STILL_PX = 4;

export function useRestIntent(ms = INTENT_MS) {
  const timer = useRef(0);
  const at = useRef<{ key: string; x: number; y: number } | null>(null);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  // `wait` overrides `ms` for this row; one instance whose wait changes (shut, then open)
  // keeps one anchor, so a row left under one wait is never stale under the other
  return useCallback((key: string, fire: () => void, wait = ms) => ({
    onPointerMove: (e: RPointerEvent<HTMLElement>) => {
      if (e.pointerType === "touch") return;
      const a = at.current;
      if (a && a.key === key && Math.hypot(e.clientX - a.x, e.clientY - a.y) < STILL_PX) return;
      at.current = { key, x: e.clientX, y: e.clientY };
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(fire, wait);
    },
    onPointerLeave: () => {
      if (at.current?.key !== key) return;
      window.clearTimeout(timer.current);
      at.current = null;
    },
  }), [ms]);
}
