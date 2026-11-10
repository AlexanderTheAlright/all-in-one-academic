
import { useEffect, useState } from "react";

export type Surface = {
  machine: string;
  hostname: string;
  canEdit: boolean;
};

const UNKNOWN: Surface = { machine: "unknown", hostname: "", canEdit: false };

let cache: Surface | null = null;
let inflight: Promise<Surface> | null = null;

function load(): Promise<Surface> {
  if (cache) return Promise.resolve(cache);
  if (!inflight) {
    inflight = fetch("/surface")
      .then((r) => (r.ok ? r.json() : UNKNOWN))
      .then((s) => { cache = s; return s; })
      .catch(() => { cache = UNKNOWN; return UNKNOWN; })
      .finally(() => { inflight = null; });
  }
  return inflight;
}

/** The one surface a session is on. Falls back to UNKNOWN (operate-only) on any
 * error so the layout always renders. */
export function useSurface(): Surface {
  const [s, setS] = useState<Surface>(cache ?? UNKNOWN);
  useEffect(() => {
    let live = true;
    load().then((v) => { if (live) setS(v); });
    return () => { live = false; };
  }, []);
  return s;
}
