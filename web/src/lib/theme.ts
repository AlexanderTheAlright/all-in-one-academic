
import { useEffect, useState } from "react";

export type ThemeMode = "light" | "dark" | null;
export type AppTheme = { ok: boolean; theme: string | null; mode: ThemeMode };

const LINK_ID = "app-theme-css";
const EMPTY: AppTheme = { ok: false, theme: null, mode: null };

export function ensureThemeLink(): HTMLLinkElement | null {
  if (typeof document === "undefined") return null;
  let link = document.getElementById(LINK_ID) as HTMLLinkElement | null;
  if (!link) {
    link = document.createElement("link");
    link.id = LINK_ID;
    link.rel = "stylesheet";
    link.href = "/theme.css";
    document.head.appendChild(link);
  }
  return link;
}

const modeQuery = (prefer: ThemeMode) => (prefer ? "mode=" + prefer : "");

function repaint(prefer: ThemeMode) {
  const link = ensureThemeLink();
  // a theme switch rewrites the same URL, so bust the cache to re-fetch it
  if (link) link.href = "/theme.css?" + [modeQuery(prefer), "v=" + Date.now()].filter(Boolean).join("&");
}

export function useAppTheme(prefer: ThemeMode = null, pollMs = 60_000): AppTheme {
  const [state, setState] = useState<AppTheme>(EMPTY);
  useEffect(() => {
    const link = ensureThemeLink();
    if (link) {
      const had = new URL(link.href, location.href).searchParams.get("mode") || null;
      if (had !== prefer) { link.disabled = false; link.href = "/theme.css" + (prefer ? "?" + modeQuery(prefer) : ""); }
    }
    let alive = true;
    let first = true;
    let last = "";
    type Payload = { ok?: boolean; theme?: string | null; mode?: string | null };
    const tick = async () => {
      let d: Payload;
      try {
        const res = await fetch("/theme.json" + (prefer ? "?" + modeQuery(prefer) : ""), { cache: "no-store" });
        if (!res.ok) return;
        d = (await res.json()) as Payload;
      } catch {
        return;   // server down or endpoint absent: keep the app's own look
      }
      if (!alive) return;
      const next: AppTheme = {
        ok: !!d.ok,
        theme: d.theme ?? null,
        mode: d.mode === "dark" || d.mode === "light" ? d.mode : null,
      };
      // an explicit choice the server could not honour: the app's own literals draw it
      if (link) link.disabled = !!prefer && next.ok && next.mode !== prefer;
      const key = next.ok + "|" + next.theme + "|" + next.mode;
      if (key === last) return;
      last = key;
      if (!first) repaint(prefer);
      first = false;
      setState(next);
    };
    void tick();
    const id = setInterval(() => void tick(), pollMs);
    return () => { alive = false; clearInterval(id); };
  }, [pollMs, prefer]);
  return state;
}
