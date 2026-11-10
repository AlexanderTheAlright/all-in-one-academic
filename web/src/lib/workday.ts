
import { useEffect, useState } from "react";
import { api } from "@/lib/api";

const DAY_MS = 86_400_000;
const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
               "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function isoLocal(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function parseIsoLocal(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

export type Workday = {
  iso: string;    // the @due(...) value
  days: number;   // offset from `from`, for the days-based snooze APIs
  label: string;  // "Mon"
  long: string;   // "Mon 17 Aug"
};

/** The first weekday strictly after `from` that is not in `off`. */
export function nextWorkday(from: Date = new Date(), off?: Set<string>): Workday {
  const base = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const scan = (skipOff: boolean): Workday | null => {
    const d = new Date(base);
    for (let i = 1; i <= 30; i++) {
      d.setDate(d.getDate() + 1);
      const wd = d.getDay();
      if (wd === 0 || wd === 6) continue;
      if (skipOff && off && off.has(isoLocal(d))) continue;
      return {
        iso: isoLocal(d),
        // round, not floor — a DST boundary makes the span 23h or 25h
        days: Math.round((d.getTime() - base.getTime()) / DAY_MS),
        label: WEEKDAY[wd],
        long: `${WEEKDAY[wd]} ${d.getDate()} ${MONTH[d.getMonth()]}`,
      };
    }
    return null;
  };
  // A pathological off-set must never be able to return nothing into a render.
  return scan(true) ?? (scan(false) as Workday);
}

let offPromise: Promise<Set<string>> | null = null;
let offCache: Set<string> | null = null;

function loadOffDays(): Promise<Set<string>> {
  if (offPromise) return offPromise;
  const from = isoLocal(new Date());
  const to = isoLocal(new Date(Date.now() + 60 * DAY_MS));
  offPromise = api.events(from, to)
    .then((r) => {
      const s = new Set<string>();
      for (const ev of r.events ?? []) {
        if (ev.category !== "holidays" || !ev.allDay) continue;
        // endDate is INCLUSIVE here — the house convention (CalendarMonth's
        // evByDate walks `while (cur <= end)`, serve.py tests date <= iso <= endDate)
        const d = parseIsoLocal(ev.date);
        const stop = parseIsoLocal(ev.endDate || ev.date);
        for (let i = 0; i < 14 && d <= stop; i++) {
          s.add(isoLocal(d));
          d.setDate(d.getDate() + 1);
        }
      }
      return s;
    })
    .catch(() => new Set<string>());   // no calendar -> plain Mon–Fri, never a hole
  return offPromise;
}

export function useOffDays(): Set<string> | undefined {
  const [off, setOff] = useState<Set<string> | undefined>(offCache ?? undefined);
  useEffect(() => {
    let live = true;
    loadOffDays().then((s) => { offCache = s; if (live) setOff(s); });
    return () => { live = false; };
  }, []);
  return off;
}
