
import { useCallback, useEffect } from "react";
import { Pause, Play, RotateCcw } from "lucide-react";
import { usePersistent } from "@/lib/hooks";
import { BTN_PRIMARY, BTN_QUIET, WidgetColumn, freeKey, useClock } from "./frame";

type Run = { durMs: number; startedAt: number | null; accMs: number };
const MIN = 60_000;
const PRESETS = [15, 25, 50, 90];
const FRESH: Run = { durMs: 25 * MIN, startedAt: null, accMs: 0 };

const sane = (r: Run | null | undefined): Run =>
  r && typeof r.durMs === "number" && r.durMs > 0 && typeof r.accMs === "number"
    && (r.startedAt === null || typeof r.startedAt === "number") ? r : FRESH;

const clockText = (ms: number) => {
  const s = Math.ceil(Math.max(0, ms) / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const p = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${p(m)}:${p(sec)}` : `${p(m)}:${p(sec)}`;
};

export function TimerWidget() {
  const [stored, setRun] = usePersistent<Run>("board-widget-timer", FRESH);
  const run = sane(stored);
  const running = run.startedAt !== null;
  const liveNow = useClock(250, running);
  const spent = run.accMs + (running ? Math.max(0, liveNow - (run.startedAt as number)) : 0);
  const left = run.durMs - spent;
  const done = left <= 0;

  const toggle = useCallback(() => {
    const t = Date.now();
    setRun((p0) => {
      const p = sane(p0);
      const used = p.accMs + (p.startedAt !== null ? t - p.startedAt : 0);
      if (used >= p.durMs) return { durMs: p.durMs, startedAt: t, accMs: 0 };   // finished: again
      return p.startedAt !== null
        ? { ...p, startedAt: null, accMs: used }                                // pause
        : { ...p, startedAt: t };                                               // start / resume
    });
  }, [setRun]);
  const reset = useCallback(() => setRun((p) => ({ durMs: sane(p).durMs, startedAt: null, accMs: 0 })), [setRun]);
  const length = useCallback((m: number) => setRun({ durMs: m * MIN, startedAt: null, accMs: 0 }), [setRun]);
  const adjust = useCallback((m: number) =>
    setRun((p0) => { const p = sane(p0); return { ...p, durMs: Math.max(MIN, p.durMs + m * MIN) }; }), [setRun]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== " " || !freeKey(e)) return;
      e.preventDefault();
      toggle();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [toggle]);

  const label = done ? "Done" : running ? "Running" : spent > 0 ? "Paused" : "Timer";
  const action = done ? "Again" : running ? "Pause" : spent > 0 ? "Resume" : "Start";
  return (
    <WidgetColumn label={label} hint="Enter start or pause · Space start or pause · Esc close"
      meta={`${Math.round(run.durMs / MIN)} min`}>
      <div data-timer-state={done ? "done" : running ? "running" : spent > 0 ? "paused" : "idle"}
        className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6 min-[900px]:gap-8">
        <div role="timer" data-timer-left={Math.ceil(Math.max(0, left) / 1000)}
          className={"nums font-light leading-none tracking-tight text-[clamp(64px,19vmin,210px)] "
            + (done ? "text-primary" : running ? "text-foreground" : "text-foreground/80")}>
          {clockText(left)}
        </div>
        <div className="h-1 w-full max-w-[440px] overflow-hidden rounded-full bg-muted">
          <div className="h-full bg-primary transition-[width] duration-300"
            style={{ width: `${Math.min(100, (spent / run.durMs) * 100)}%` }} />
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <button onClick={() => adjust(-5)} title="5 minutes less" className={BTN_QUIET}>&minus;5</button>
          {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
          <button autoFocus onClick={toggle} data-timer-toggle className={BTN_PRIMARY + " min-w-[118px]"}>
            {running && !done ? <Pause size={15} /> : <Play size={15} />} {action}
          </button>
          <button onClick={reset} title="Reset" data-timer-reset className={BTN_QUIET}>
            <RotateCcw size={13} /> Reset
          </button>
          <button onClick={() => adjust(5)} title="5 minutes more" className={BTN_QUIET}>+5</button>
        </div>
        <div role="radiogroup" aria-label="Length" className="flex flex-wrap items-center justify-center gap-1.5">
          {PRESETS.map((m) => {
            const on = run.durMs === m * MIN;
            return (
              <button key={m} role="radio" aria-checked={on} onClick={() => length(m)}
                className={"rounded-full px-3 py-1 text-[12px] nums transition-colors "
                  + (on ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground")}>
                {m} min
              </button>
            );
          })}
        </div>
      </div>
    </WidgetColumn>
  );
}
