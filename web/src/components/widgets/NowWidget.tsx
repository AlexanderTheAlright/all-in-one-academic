
import { useMemo } from "react";
import { Video } from "lucide-react";
import { api } from "@/lib/api";
import type { Event } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { fmtTime } from "@/lib/format";
import { WidgetColumn, useClock } from "./frame";

type Block = { e: Event; start: number; end: number | null };

const minsOf = (hhmm: string | null | undefined): number | null => {
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm || "");
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const span = (e: Event) => (e.startTime ? fmtTime(e.startTime) + (e.endTime ? "–" + fmtTime(e.endTime) : "") : "");
const dur = (n: number) => {
  const m = Math.max(1, Math.round(n));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
};

function Join({ e }: { e: Event }) {
  const url = (e.link || "").trim();
  if (!/^https?:\/\/\S+$/i.test(url)) return null;
  return (
    <button onClick={() => api.openUrl(url)} title={`Join the call — ${url}`}
      aria-label={`Join the call: ${e.title}`}
      className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border px-3 py-1 text-[12px] text-muted-foreground hover:text-foreground hover:border-primary/50 focus-visible:text-foreground">
      <Video size={13} /> Join
    </button>
  );
}

const Dot = ({ e }: { e: Event }) => (
  <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full bg-primary" style={e.color ? { background: e.color } : undefined} />
);

export function NowWidget() {
  const t = useApi(() => api.today(), [], 60_000);
  const now = useClock(15_000);
  const d = new Date(now);
  const nowMin = d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
  const pad = (n: number) => String(n).padStart(2, "0");

  const { allDay, blocks } = useMemo(() => {
    const evs = t.data?.eventsToday ?? [];
    const allDay: Event[] = [];
    const blocks: Block[] = [];
    for (const e of evs) {
      const s = minsOf(e.startTime);
      if (e.allDay || s === null) { allDay.push(e); continue; }
      let end = minsOf(e.endTime);
      if (end !== null && end <= s) end = 24 * 60;   // runs past midnight
      blocks.push({ e, start: s, end });
    }
    blocks.sort((a, b) => a.start - b.start);
    return { allDay, blocks };
  }, [t.data]);

  const clock = fmtTime(`${pad(d.getHours())}:${pad(d.getMinutes())}`);
  if (!t.data) {
    return (
      <WidgetColumn label="Now" meta={clock}>
        <div className="text-[12.5px] text-muted-foreground">{t.error ? "Calendar unavailable" : "Loading"}</div>
      </WidgetColumn>
    );
  }

  const current = blocks.filter((b) => b.end !== null && b.start <= nowMin && nowMin < b.end);
  const upcoming = blocks.filter((b) => b.start > nowMin);
  const next = upcoming[0];
  const later = upcoming.slice(1);
  const big = "text-[clamp(22px,4.4vmin,36px)] font-semibold leading-tight text-foreground";
  const sub = "mt-1 text-[13px] min-[900px]:text-[14px] text-muted-foreground nums";

  return (
    <WidgetColumn label="Now" meta={clock} hint="g f calendar · Esc close">
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
        {allDay.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {allDay.map((e, i) => (
              <span key={i} data-now-allday
                className={"inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-0.5 text-[11.5px] text-muted-foreground"
                  + (e.completed ? " line-through opacity-60" : "")}>
                <Dot e={e} /> {e.title}
              </span>
            ))}
          </div>
        )}

        {current.length > 0 ? current.map((b, i) => {
          const end = b.end as number;
          const frac = Math.min(1, Math.max(0, (nowMin - b.start) / Math.max(1, end - b.start)));
          return (
            <section key={i} data-now-block="current" className="rounded-xl border border-border bg-card px-5 py-5">
              <div className="flex items-start gap-3">
                <span className="mt-3"><Dot e={b.e} /></span>
                <div className="min-w-0 flex-1">
                  <div className={big + (b.e.completed ? " line-through opacity-60" : "")}>{b.e.title}</div>
                  <div className={sub}>{span(b.e)} · {dur(end - nowMin)} left</div>
                </div>
                <Join e={b.e} />
              </div>
              <div className="mt-4 h-1 overflow-hidden rounded-full bg-muted">
                <div className="h-full bg-primary" style={{ width: `${frac * 100}%` }} />
              </div>
            </section>
          );
        }) : (
          <section data-now-block="free" className="rounded-xl border border-border bg-card px-5 py-5">
            <div className={big}>Free</div>
            <div className={sub}>{next ? `until ${fmtTime(next.e.startTime)}` : "for the rest of today"}</div>
          </section>
        )}

        {next && (
          <div data-now-block="next" className="flex items-center gap-3 rounded-lg px-1 text-[13.5px] min-[900px]:text-[15px]">
            <span className="w-11 shrink-0 text-[10.5px] uppercase tracking-[0.1em] font-semibold text-muted-foreground">Next</span>
            <Dot e={next.e} />
            <span className="min-w-0 flex-1 truncate text-foreground">{next.e.title}</span>
            <span className="shrink-0 text-muted-foreground nums">{span(next.e)} · in {dur(next.start - nowMin)}</span>
            <Join e={next.e} />
          </div>
        )}

        {later.length > 0 && (
          <ul className="space-y-1 border-t border-border/60 pt-3">
            {later.map((b, i) => (
              <li key={i} data-now-block="later"
                className="flex items-center gap-3 px-1 text-[12.5px] min-[900px]:text-[14px] text-muted-foreground">
                <span className="w-11 shrink-0 nums">{fmtTime(b.e.startTime)}</span>
                <span className="min-w-0 flex-1 truncate">{b.e.title}</span>
                <Join e={b.e} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </WidgetColumn>
  );
}
