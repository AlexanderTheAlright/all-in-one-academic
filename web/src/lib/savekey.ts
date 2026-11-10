
import { useEffect, useRef } from "react";

export const SAVE_EVENT = "all_in_one_academic:save";

/** Ask every open editor to write what it is holding, now. */
export function requestSave(): void {
  try {
    window.dispatchEvent(new CustomEvent(SAVE_EVENT));
  } catch {
    /* no CustomEvent (very old engine): the debounce still lands */
  }
}

/** True for the one chord: Ctrl+S or Cmd+S, with no Alt. */
export function isSaveChord(e: KeyboardEvent): boolean {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return false;
  return e.key === "s" || e.key === "S";
}

export function useSaveKey(fn: () => void | Promise<unknown>, enabled = true): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!enabled) return;
    const on = () => { try { void ref.current?.(); } catch { /* surface reports */ } };
    window.addEventListener(SAVE_EVENT, on);
    return () => window.removeEventListener(SAVE_EVENT, on);
  }, [enabled]);
}
