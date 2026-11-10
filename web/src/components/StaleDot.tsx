
import { useSyncExternalStore } from "react";
import { subscribe, staleness, type Staleness } from "@/lib/boardcache";
import { requestSave } from "@/lib/savekey";

function age(ms: number): string {
  if (ms < 60_000) return "moments ago";
  const m = Math.round(ms / 60_000);
  if (m < 60) return m + (m === 1 ? " minute ago" : " minutes ago");
  const h = Math.round(m / 60);
  if (h < 24) return h + (h === 1 ? " hour ago" : " hours ago");
  const d = Math.round(h / 24);
  return d + (d === 1 ? " day ago" : " days ago");
}

export function useStaleness(): Staleness {
  return useSyncExternalStore(subscribe, staleness, staleness);
}

/* the mark's tooltip: the brand, plus the newer-bundle notice when there is one */
export function brandTitle(s: Staleness): string {
  return s.bundle ? "All-in-One Academic — a newer All-in-One Academic is on the server; click to reload" : "All-in-One Academic";
}

export function UpdateDot() {
  return (
    <span aria-hidden="true" data-knav-skip data-update-dot
      className="pointer-events-none absolute left-[26px] top-[20px] h-2 w-2 rounded-full bg-success ring-2 ring-card" />
  );
}

export function reloadForUpdate(): void {
  requestSave();
  window.setTimeout(() => window.location.reload(), 700);
}

export function BundleDot({ title = "new version: reload" }: { title?: string }) {
  return (
    <span
      aria-hidden="true" data-knav-skip data-stale-dot="bundle" title={title}
      className="pointer-events-auto fixed right-1.5 top-1.5 z-50 h-1.5 w-1.5 rounded-full bg-destructive"
    />
  );
}

export function StaleDot() {
  const s = useStaleness();
  if (!s.failed) return null;
  return (
    <span
      aria-hidden="true" data-knav-skip data-stale-dot="failed"
      title={`Showing saved data from ${age(s.ageMs)} — the last refresh failed.`}
      className="pointer-events-auto absolute left-[19px] top-[-1px] h-1.5 w-1.5 rounded-full bg-destructive"
    />
  );
}
