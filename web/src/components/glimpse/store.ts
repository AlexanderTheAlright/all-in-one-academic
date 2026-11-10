
import { useSyncExternalStore } from "react";
import { api, type GlimpseSnapshot } from "@/lib/api";

const EVERY_MS = 120_000;
const RETRY_GAP_MS = 10_000;   // after a failure, menu opens do not hammer the server

let snap: GlimpseSnapshot | null = null;
let fetchedAt = 0;
let triedAt = 0;
let inflight: Promise<void> | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
const subs = new Set<() => void>();

function load(): Promise<void> {
  if (inflight) return inflight;
  triedAt = Date.now();
  inflight = api.glimpse()
    .then((d) => {
      if (d && typeof d === "object" && d.views && typeof d.views === "object") {
        snap = d;
        fetchedAt = Date.now();
        subs.forEach((f) => f());
      }
    })
    .catch(() => { /* keep the last snapshot */ })
    .finally(() => { inflight = null; });
  return inflight;
}

/** refresh if the snapshot is older than `maxAgeMs` (the menu calls this as it opens) */
export function refreshGlimpse(maxAgeMs = 60_000) {
  const now = Date.now();
  if (now - fetchedAt > maxAgeMs && now - triedAt > (fetchedAt ? 0 : RETRY_GAP_MS)) void load();
}

function subscribe(fn: () => void) {
  subs.add(fn);
  if (!timer) {
    if (!snap) void load();
    timer = setInterval(() => void load(), EVERY_MS);
  }
  return () => {
    subs.delete(fn);
    if (!subs.size && timer) { clearInterval(timer); timer = null; }
  };
}

export function useGlimpse(): GlimpseSnapshot | null {
  return useSyncExternalStore(subscribe, () => snap, () => null);
}
