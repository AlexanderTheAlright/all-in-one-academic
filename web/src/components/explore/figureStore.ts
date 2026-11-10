
import { useEffect, useState } from "react";

/** the html `dark` class is the board's theme switch (App.tsx); the render endpoints
 *  take the same word, so a figure follows the palette the rest of the window has */
export function useFigureTheme(): "day" | "night" {
  const read = () => (typeof document !== "undefined" && document.documentElement.classList.contains("dark") ? "night" : "day");
  const [theme, setTheme] = useState<"day" | "night">(read);
  useEffect(() => {
    const el = document.documentElement;
    const obs = new MutationObserver(() => setTheme(el.classList.contains("dark") ? "night" : "day"));
    obs.observe(el, { attributes: true, attributeFilter: ["class"] });
    setTheme(read());
    return () => obs.disconnect();
  }, []);
  return theme;
}

/** Re-apply exactly the ids this window changed onto whatever the server now holds.
 *  Everything else is the server's, so another window's comment is never lost. */
export function reapplyById<T extends { id: string }>(server: T[], base: T[], mine: T[]): T[] {
  const baseById = new Map(base.map((c) => [c.id, c]));
  const mineById = new Map(mine.map((c) => [c.id, c]));
  const out = server.slice();
  const at = new Map(out.map((c, i) => [c.id, i]));
  for (const [id, c] of mineById) {
    const was = baseById.get(id);
    if (was && JSON.stringify(was) === JSON.stringify(c)) continue;   // untouched by me
    const i = at.get(id);
    if (i === undefined) out.push(c); else out[i] = c;
  }
  for (const [id] of baseById) {
    if (mineById.has(id)) continue;
    const i = out.findIndex((c) => c.id === id);
    if (i >= 0) out.splice(i, 1);                                     // I deleted it
  }
  return out;
}

/** Browser storage this window may use. Namespaced so a figure window can never write
 *  a key the Drafting tab reads (its current slug/doc/view live under `aioa-*`). */
export const figureKey = (k: string) => "figure-widget:" + k;
