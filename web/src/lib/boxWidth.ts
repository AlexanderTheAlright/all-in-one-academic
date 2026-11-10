import { useLayoutEffect, useRef, useState } from "react";

/** A ref and the element's current width in whole pixels, kept up to date as it resizes. */
export function useBoxWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => { const n = Math.floor(el.clientWidth); setW((p) => (Math.abs(p - n) < 1 ? p : n)); };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}
