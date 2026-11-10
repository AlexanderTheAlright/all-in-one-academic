
import type { Ambient } from "@/lib/api";

export type Drift = { h: number; s: number; l: number };
export type DayPhase = "dawn" | "day" | "golden" | "dusk" | "night";

const ZERO: Drift = { h: 0, s: 0, l: 0 };

const WEATHER_LIGHT: Record<string, Drift> = {
  clear:    { h: 6,   s: 6,   l: 0.6 },
  partly:   { h: 3,   s: 3,   l: 0.3 },
  overcast: { h: -10, s: -14, l: -2.2 },
  fog:      { h: -6,  s: -16, l: 0.5 },
  drizzle:  { h: 120, s: -14, l: -1.4 },
  rain:     { h: 160, s: -13, l: -2.2 },
  snow:     { h: 175, s: -14, l: 1.5 },
  storm:    { h: 150, s: -12, l: -3 },
};

// dark theme starts cool (hue 220); drifts are smaller but still legible.
const WEATHER_DARK: Record<string, Drift> = {
  clear:    { h: -6,  s: 2,  l: 0.3 },
  partly:   { h: -2,  s: 0,  l: 0 },
  overcast: { h: 0,   s: -6, l: -0.5 },
  fog:      { h: 0,   s: -7, l: 0.8 },
  drizzle:  { h: -4,  s: -2, l: -0.6 },
  rain:     { h: -8,  s: 4,  l: -1.2 },
  snow:     { h: -14, s: -6, l: 2 },
  storm:    { h: -10, s: 5,  l: -2 },
};

// time-of-day drift (light theme): rosier dawn, neutral day, amber late
// afternoon, settling toward dusk.
const PHASE_LIGHT: Record<DayPhase, Drift> = {
  dawn:   { h: -14, s: 4, l: 0 },
  day:    ZERO,
  golden: { h: -8,  s: 5, l: -0.4 },
  dusk:   { h: -10, s: 2, l: -1.5 },
  night:  { h: -6,  s: -3, l: -1.5 },
};

const PHASE_DARK: Record<DayPhase, Drift> = {
  dawn:   { h: 0, s: 0,  l: 0.8 },
  day:    ZERO,
  golden: ZERO,
  dusk:   ZERO,
  night:  { h: 0, s: -3, l: -0.8 },
};

// sky wash: "<h> <s>% <l>%" + alpha for the top-of-canvas gradient.
const SKY_LIGHT: Record<string, [string, number]> = {
  clear:    ["45 75% 60%", 0.12],
  partly:   ["45 55% 62%", 0.09],
  overcast: ["30 6% 50%",  0.10],
  fog:      ["40 10% 72%", 0.16],
  drizzle:  ["205 30% 55%", 0.12],
  rain:     ["205 40% 48%", 0.15],
  snow:     ["210 35% 78%", 0.20],
  storm:    ["218 35% 38%", 0.18],
};

const SKY_DARK: Record<string, [string, number]> = {
  clear:    ["225 50% 40%", 0.22],
  partly:   ["225 35% 35%", 0.18],
  overcast: ["220 15% 30%", 0.20],
  fog:      ["220 12% 45%", 0.20],
  drizzle:  ["215 35% 35%", 0.20],
  rain:     ["212 45% 32%", 0.25],
  snow:     ["215 35% 60%", 0.22],
  storm:    ["215 50% 25%", 0.30],
};

function parseLocal(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

/* Sun times with a seasonal-ish fallback so the engine still breathes when the
 * weather feed is unreachable. */
export function sunTimes(amb: Ambient | null, now: Date): { sunrise: Date; sunset: Date } {
  const sr = parseLocal(amb?.sun?.sunrise);
  const ss = parseLocal(amb?.sun?.sunset);
  if (sr && ss) return { sunrise: sr, sunset: ss };
  const sunrise = new Date(now); sunrise.setHours(6, 30, 0, 0);
  const sunset = new Date(now); sunset.setHours(20, 0, 0, 0);
  return { sunrise, sunset };
}

export function dayPhase(now: Date, sunrise: Date, sunset: Date): DayPhase {
  const t = now.getTime(), sr = sunrise.getTime(), ss = sunset.getTime();
  const MIN = 60_000;
  if (t < sr - 45 * MIN) return "night";
  if (t < sr + 60 * MIN) return "dawn";
  if (t < ss - 90 * MIN) return "day";
  if (t < ss) return "golden";
  if (t < ss + 45 * MIN) return "dusk";
  return "night";
}

export function isNight(now: Date, sunrise: Date, sunset: Date): boolean {
  return now.getTime() < sunrise.getTime() || now.getTime() >= sunset.getTime();
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function computeDrift(amb: Ambient | null, now: Date, dark: boolean): Drift {
  const { sunrise, sunset } = sunTimes(amb, now);
  const phase = dayPhase(now, sunrise, sunset);
  const wTable = dark ? WEATHER_DARK : WEATHER_LIGHT;
  const pTable = dark ? PHASE_DARK : PHASE_LIGHT;
  const w = (amb?.weather && wTable[amb.weather.kind]) || ZERO;
  const p = pTable[phase];
  return {
    h: w.h + p.h,
    s: dark ? clamp(w.s + p.s, -8, 6) : clamp(w.s + p.s, -18, 9),
    l: dark ? clamp(w.l + p.l, -2.5, 2) : clamp(w.l + p.l, -3.5, 1.8),
  };
}

export function applyDrift(d: Drift) {
  const r = document.documentElement.style;
  r.setProperty("--amb-h", String(Math.round(d.h)));
  r.setProperty("--amb-s", d.s.toFixed(1) + "%");
  r.setProperty("--amb-l", d.l.toFixed(1) + "%");
}

export function skyWash(amb: Ambient | null, now: Date, dark: boolean): string {
  const kind = amb?.weather?.kind ?? "partly";
  const table = dark ? SKY_DARK : SKY_LIGHT;
  let [color, a] = table[kind] ?? table.partly;
  if (!dark && (kind === "clear" || kind === "partly")) {
    const { sunrise, sunset } = sunTimes(amb, now);
    const phase = dayPhase(now, sunrise, sunset);
    if (phase === "dawn")   { color = "18 65% 60%"; a = 0.14; }
    if (phase === "golden") { color = "32 80% 55%"; a = 0.15; }
  }
  return `linear-gradient(180deg, hsl(${color} / ${a}) 0%, hsl(${color} / ${(a * 0.35).toFixed(3)}) 220px, transparent 460px)`;
}
