
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Sunrise, Moon, Sparkles, X, Maximize2, Minimize2, History, CalendarDays, Dices, ChevronLeft, ChevronRight, ExternalLink, Pencil } from "lucide-react";
import { api } from "@/lib/api";
import type { DailySections, SectionAnchor, Quote, JournalDayMeta, DayNote, DayJournal, DayStat } from "@/lib/api";
import { fmtDateLong } from "@/lib/format";
import { useSaveKey } from "@/lib/savekey";
import { cn } from "@/lib/utils";
import { standOn, openWidgetFull } from "@/lib/arrownav";
import { useFullPage, useWidget } from "@/components/ui/widget";
import { useBoxWidth } from "@/lib/boxWidth";
import { useDatumCursor, ChartTip } from "@/components/charts/datum";
import { isoLocal } from "@/lib/workday";
import { toast } from "sonner";

type Status = "idle" | "saving" | "saved" | "error";
const countWords = (t: string) => (t.trim().match(/[\w'’-]+/g) || []).length;

function useJournalField(anchor: SectionAnchor, value: string, date?: string) {
  const [text, setText] = useState(value);
  const [status, setStatus] = useState<Status>("idle");
  const saved = useRef(value);       // last text we know is persisted on the server
  const textRef = useRef(value);     // always-current text, for unmount/unload flush
  const focused = useRef(false);     // true while the textarea has focus
  const guardUntil = useRef(0);      // ignore incoming server values until this ms ts

  useEffect(() => { textRef.current = text; }, [text]);

  useEffect(() => {
    if (value === saved.current) return;
    if (focused.current) return;
    if (text !== saved.current) return;
    if (Date.now() < guardUntil.current) return;
    saved.current = value;
    setText(value);
  }, [value, text]);

  const save = useCallback((t: string) => {
    if (t === saved.current) return;
    setStatus("saving");
    guardUntil.current = Date.now() + 6000;
    api.dailySection(anchor, t, date)
      .then(() => { saved.current = t; guardUntil.current = Date.now() + 5000; setStatus("saved"); })
      .catch(() => { setStatus("error"); toast.error("Couldn't save — your writing is safe on screen, it'll retry"); });
  }, [anchor, date]);

  // debounced autosave after typing stops
  useEffect(() => {
    if (text === saved.current) return;
    const id = setTimeout(() => save(text), 800);
    return () => clearTimeout(id);
  }, [text, save]);

  // flush unsaved work on date flip / navigation (unmount) and on tab close
  useEffect(() => {
    const beacon = () => {
      if (textRef.current === saved.current) return;
      try {
        const body = date ? { anchor, text: textRef.current, date } : { anchor, text: textRef.current };
        navigator.sendBeacon("/daily/section", new Blob([JSON.stringify(body)], { type: "application/json" }));
      } catch { /* best effort */ }
    };
    window.addEventListener("beforeunload", beacon);
    return () => {
      window.removeEventListener("beforeunload", beacon);
      if (textRef.current !== saved.current) {
        api.dailySection(anchor, textRef.current, date).catch(() => {});
        saved.current = textRef.current;
      }
    };
  }, [anchor, date]);

  const dirty = text !== saved.current;
  const onFocus = useCallback(() => { focused.current = true; }, []);
  const onBlur = useCallback(() => { focused.current = false; save(textRef.current); }, [save]);
  useSaveKey(() => save(textRef.current));
  return { text, setText, status, dirty, onFocus, onBlur };
}

function StatusTag({ status, dirty }: { status: Status; dirty: boolean }) {
  const label = status === "saving" ? "saving…" : dirty ? "unsaved" : status === "saved" ? "saved" : status === "error" ? "retry…" : "";
  if (!label) return null;
  return (
    <span style={{ color: status === "saved" && !dirty ? "hsl(var(--primary))" : status === "error" ? "hsl(var(--destructive))" : "hsl(var(--muted-foreground))" }}>
      {label}
    </span>
  );
}

/** A plain bordered journal textarea (used by the evening check-in fields). */
function JournalField({ anchor, value, placeholder, rows = 4, minHeight, date, fill, primary }:
{ anchor: SectionAnchor; value: string; placeholder: string; rows?: number; minHeight?: number; date?: string;
  /** grow to the height its (flex) parent gives it */
  fill?: boolean;
  /** this bucket's own box: ⏎ on it in the focused view opens the full page */
  primary?: boolean }) {
  const f = useJournalField(anchor, value, date);
  return (
    <div className={cn("relative", fill && "flex-1 flex flex-col min-h-0")}>
      <textarea value={f.text} onChange={(e) => f.setText(e.target.value)} onFocus={f.onFocus} onBlur={f.onBlur}
        data-knav-primary={primary ? "" : undefined}
        placeholder={placeholder} rows={rows} style={minHeight ? { minHeight } : undefined}
        className={cn("w-full bg-background border border-border rounded-lg px-3.5 py-3 text-[14px] leading-relaxed focus:outline-none focus:border-primary",
          fill ? "flex-1 resize-none tinybar" : "resize-y")} />
      <span className="absolute right-3 bottom-2.5 text-[10.5px] pointer-events-none select-none">
        <StatusTag status={f.status} dirty={f.dirty} />
      </span>
    </div>
  );
}

export function JournalDayPicker({ days, active, today, onPick, loading }:
{ days: JournalDayMeta[] | null; active: string; today: string; onPick: (date: string) => void; loading?: boolean }) {
  const [browse, setBrowse] = useState(false);
  if (!days || !days.length) return null;
  const viewingPast = active !== today;
  return (
    <div className="mb-3">
      <div className="flex items-center gap-1.5 flex-wrap">
        {days.map((d) => {
          const sel = d.date === active;
          const filled = d.morningFilled || d.eodFilled;
          return (
            <button key={d.date} onClick={() => onPick(d.date)}
              title={filled ? d.words + " words written" : "No entry yet — tap to backfill"}
              className={`px-2.5 py-1 rounded-full border text-[11.5px] flex items-center gap-1.5 transition-colors ${sel ? "bg-primary/12 border-primary/60 text-foreground" : "border-border text-muted-foreground hover:text-foreground hover:border-primary/40"}`}>
              <span className="w-1.5 h-1.5 rounded-full shrink-0"
                style={{ background: filled ? "hsl(var(--primary))" : "transparent", border: filled ? "none" : "1.5px solid hsl(var(--muted-foreground) / 0.45)" }} />
              {d.isToday ? "Today" : d.weekday + " " + d.date.slice(8)}
            </button>
          );
        })}
        <button onClick={() => setBrowse(true)}
          title="Browse every daily note — pick a day, or roll a random one"
          className="px-2.5 py-1 rounded-full border border-border text-[11.5px] flex items-center gap-1.5 text-muted-foreground hover:text-foreground hover:border-primary/40 transition-colors">
          <CalendarDays size={12} className="shrink-0" /> All days
        </button>
        {loading && <span className="text-[11px] text-muted-foreground ml-1">loading…</span>}
      </div>
      <DayBrowser open={browse} onClose={() => setBrowse(false)} today={today}
        onPick={(d) => { setBrowse(false); onPick(d); }} />
      {viewingPast && (
        <div className="mt-2 flex items-center gap-x-2 gap-y-1 flex-wrap text-[12px] text-muted-foreground">
          <History size={12} className="opacity-70" />
          <span>Backfilling an earlier day — your writing saves to that date.</span>
          <button onClick={() => onPick(today)} className="text-primary hover:underline">Back to today</button>
        </div>
      )}
    </div>
  );
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DOW = ["S", "M", "T", "W", "T", "F", "S"];   // week begins Sunday

/** Light read-only rendering of a daily note's markdown: headers bold, list
 * markers as middots, rules as dividers, everything else as plain prose lines. */
function NoteBody({ text }: { text: string }) {
  if (!text.trim()) return <p className="text-[13px] text-muted-foreground italic">The note for this day is empty.</p>;
  return (
    <div className="text-[13px] leading-relaxed">
      {text.split("\n").map((ln, i) => {
        const h = ln.match(/^#{1,6}\s+(.*)/);
        if (h) return <p key={i} className="font-semibold text-foreground mt-3 mb-1 first:mt-0">{h[1]}</p>;
        const t = ln.trim();
        if (!t) return <div key={i} className="h-2" />;
        if (/^-{3,}$/.test(t)) return <div key={i} className="border-t border-border/60 my-2" />;
        const em = t.match(/^_(.*)_$/);
        if (em) return <p key={i} className="italic text-muted-foreground">{em[1]}</p>;
        return <p key={i} className="text-foreground/85 whitespace-pre-wrap">{ln.replace(/^\s*[-*+]\s+/, "· ")}</p>;
      })}
    </div>
  );
}

function DayBrowser({ open, onClose, today, onPick }:
{ open: boolean; onClose: () => void; today: string; onPick: (date: string) => void }) {
  const [dates, setDates] = useState<string[] | null>(null);
  const [cursor, setCursor] = useState(today.slice(0, 7));   // YYYY-MM in view
  const [sel, setSel] = useState<string | null>(null);
  const [note, setNote] = useState<DayNote | null>(null);
  const [reading, setReading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setCursor((today || new Date().toISOString().slice(0, 10)).slice(0, 7));
    setSel(null); setNote(null);
    api.dailyDates().then((d) => setDates(d.dates)).catch(() => setDates([]));
  }, [open, today]);

  useEffect(() => {
    if (!sel) { setNote(null); return; }
    setReading(true);
    api.dailyRead(sel).then(setNote).catch(() => setNote(null)).finally(() => setReading(false));
  }, [sel]);

  const have = useMemo(() => new Set(dates || []), [dates]);
  const [y, m] = cursor.split("-").map(Number);
  const startPad = new Date(y, m - 1, 1).getDay();
  const dim = new Date(y, m, 0).getDate();
  const cells: (string | null)[] = [
    ...Array.from({ length: startPad }, () => null),
    ...Array.from({ length: dim }, (_, i) => cursor + "-" + String(i + 1).padStart(2, "0")),
  ];
  const firstMonth = dates && dates.length ? dates[0].slice(0, 7) : cursor;
  const lastMonth = today.slice(0, 7);
  const shift = (by: number) => {
    const d = new Date(y, m - 1 + by, 1);
    setCursor(d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0"));
  };
  const roll = () => {
    const pool = (dates || []).filter((d) => d !== today);
    if (!pool.length) return;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    setSel(pick);
    setCursor(pick.slice(0, 7));
  };
  // the journal backfill window the server accepts writes for (mirrors _valid_recent_date)
  const editable = (d: string) => {
    const diff = (new Date(today + "T12:00").getTime() - new Date(d + "T12:00").getTime()) / 86_400_000;
    return diff >= 0 && diff <= 31;
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-[600px] max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-[15px]">
            <CalendarDays size={15} className="opacity-70" /> Daily notes
          </DialogTitle>
        </DialogHeader>

        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1">
            <button onClick={() => shift(-1)} disabled={cursor <= firstMonth}
              className="p-1.5 rounded hover:bg-accent disabled:opacity-30 disabled:pointer-events-none" title="Earlier month">
              <ChevronLeft size={15} />
            </button>
            <span className="text-[13px] font-medium w-[132px] text-center nums">{MONTHS[m - 1]} {y}</span>
            <button onClick={() => shift(1)} disabled={cursor >= lastMonth}
              className="p-1.5 rounded hover:bg-accent disabled:opacity-30 disabled:pointer-events-none" title="Later month">
              <ChevronRight size={15} />
            </button>
          </div>
          <button onClick={roll} disabled={!dates || dates.length < 2}
            title="Open a random day's note"
            className="px-2.5 py-1 rounded-full border border-border text-[11.5px] flex items-center gap-1.5 text-muted-foreground hover:text-foreground hover:border-primary/40 transition-colors disabled:opacity-40">
            <Dices size={13} className="shrink-0" /> Random day
          </button>
        </div>

        <div className="grid grid-cols-7 gap-0.5 text-center">
          {DOW.map((d, i) => (
            <span key={i} className="text-[10.5px] text-muted-foreground/70 py-0.5">{d}</span>
          ))}
          {cells.map((d, i) => {
            if (!d) return <span key={"p" + i} />;
            const has = have.has(d);
            const isSel = d === sel;
            const isToday = d === today;
            return (
              <button key={d} onClick={() => has && setSel(d)} disabled={!has}
                title={has ? "Read this day's note" : "No note this day"}
                className={`h-8 rounded text-[12px] nums transition-colors ${isSel ? "bg-primary/15 text-foreground font-medium" : has ? "text-foreground hover:bg-accent" : "text-muted-foreground/35"} ${isToday ? "ring-1 ring-primary/50" : ""}`}>
                {parseInt(d.slice(8), 10)}
              </button>
            );
          })}
        </div>

        {!dates && <p className="text-[12px] text-muted-foreground">Loading your days…</p>}

        {sel && (
          <div className="border-t border-border pt-3 min-h-0 flex-1 overflow-y-auto">
            <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
              <span className="text-[12.5px] font-medium">{fmtDateLong(sel)}</span>
              <span className="flex items-center gap-3">
                {editable(sel) && sel !== today && (
                  <button onClick={() => onPick(sel)} className="text-[11.5px] text-primary hover:underline flex items-center gap-1">
                    <Pencil size={11} /> Edit in journal
                  </button>
                )}
                {note && (
                  <button onClick={() => api.open(note.path)} className="text-[11.5px] text-muted-foreground hover:text-foreground flex items-center gap-1">
                    <ExternalLink size={11} /> Open in Obsidian
                  </button>
                )}
              </span>
            </div>
            {reading ? <p className="text-[12px] text-muted-foreground">Opening…</p>
              : note ? <NoteBody text={note.text} />
              : <p className="text-[12px] text-muted-foreground">Couldn't read that day's note.</p>}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function DailyNotes({ sections, date, isToday, picker, onPickDay }:
{ sections: DailySections; date: string; isToday: boolean; picker?: ReactNode;
  /** flip the journal to another recent day (the focused view's earlier mornings) */
  onPickDay?: (date: string) => void }) {
  const f = useJournalField("daily-notes", sections.dailyNotes, date);
  const w = useWidget();
  const fill = !!w?.focused;
  const wide = w ? w.size === "lg" || w.size === "xl" || (fill && w.size === "md") : null;
  const [focus, setFocus] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);
  const words = countWords(f.text);
  const dateLabel = fmtDateLong(date);

  // Request true OS full-screen straight from the click gesture (hides Obsidian /
  // browser chrome too, where allowed); the portal overlay is the fallback.
  const enterFocus = () => {
    setFocus(true);
    try { document.documentElement.requestFullscreen?.().catch(() => {}); } catch { /* unsupported */ }
  };
  const exitFocus = () => setFocus(false);
  // ⏎ again on the clearing box (the focused view's own item) opens this page; the
  // title below is the mouse path to the same thing
  useFullPage(enterFocus);

  // lock body scroll, let Esc exit, and fall back out if full-screen is left.
  // The first Escape while writing only stops writing; the second leaves.
  useEffect(() => {
    if (!focus) return;
    const h = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT") && !t.hasAttribute("data-knav-armed")) return;
      e.preventDefault(); setFocus(false);
    };
    const onFs = () => {
      if (document.fullscreenElement) return;
      // in OS full screen the browser spends that first Escape leaving it and the
      // page never sees the key: count it as "stop writing" and keep the page up
      const a = document.activeElement as HTMLElement | null;
      if (a && a.tagName === "TEXTAREA" && !a.hasAttribute("data-knav-armed") && overlayRef.current?.contains(a)) {
        a.setAttribute("data-knav-armed", "");
        document.documentElement.setAttribute("data-knav", "");
        return;
      }
      setFocus(false);
    };
    window.addEventListener("keydown", h);
    document.addEventListener("fullscreenchange", onFs);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", h);
      document.removeEventListener("fullscreenchange", onFs);
      document.body.style.overflow = prev;
      if (document.fullscreenElement) { try { document.exitFullscreen?.().catch(() => {}); } catch { /* noop */ } }
    };
  }, [focus]);

  // leaving the full page with the keyboard: stand on the clearing box again (the card
  // re-mounts under the overlay, so the old node is gone — find it by its mark)
  const wasFocus = useRef(false);
  useEffect(() => {
    if (focus) { wasFocus.current = true; return; }
    if (!wasFocus.current) return;
    wasFocus.current = false;
    if (!document.documentElement.hasAttribute("data-knav")) return;
    const a = document.activeElement;
    if (a && a !== document.body) return;
    const id = window.setTimeout(() => {
      standOn(w?.frame?.querySelector<HTMLTextAreaElement>("[data-knav-primary]") ?? null);
    }, 0);
    return () => window.clearTimeout(id);
  }, [focus, w?.frame]);

  const bind = {
    value: f.text,
    onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => f.setText(e.target.value),
    onFocus: f.onFocus,
    onBlur: f.onBlur,
    placeholder: "",
  };

  if (focus) {
    // Portal to <body> so the overlay escapes the transformed page wrapper and
    // truly covers the whole viewport (sidebar included) — distraction-free.
    return createPortal(
      <div ref={overlayRef} role="dialog" aria-modal="true" aria-label="Notes" data-knav-modal data-knav-full-page
        className="fixed inset-0 z-[100] bg-background flex flex-col animate-in fade-in duration-150">
        <div className="shrink-0 flex items-center justify-between px-6 py-4 border-b border-border/60">
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.09em] font-semibold text-muted-foreground">
            <Sunrise size={13} /> Notes
            <span className="ml-1 normal-case tracking-normal text-muted-foreground/80">· {dateLabel}</span>
            <span className="ml-2 nums normal-case tracking-normal text-muted-foreground/60">{words} words</span>
          </div>
          <button type="button" onClick={exitFocus} data-knav-back
            className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-[12px] text-muted-foreground hover:text-foreground hover:border-primary/50 transition-colors">
            <Minimize2 size={13} /> Done <kbd className="text-[10px] opacity-60">esc</kbd>
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="mx-auto max-w-[720px] h-full px-6 py-10">
            {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
            <textarea {...bind} autoFocus
              className="w-full h-full min-h-[16rem] bg-transparent border-0 resize-none focus:outline-none text-[18px] leading-[1.9] text-foreground/90"
              style={{ fontFamily: "Georgia, 'Times New Roman', serif" }} />
          </div>
        </div>
        <div className="shrink-0 px-6 py-2 text-right text-[11px]">
          <StatusTag status={f.status} dirty={f.dirty} />
        </div>
      </div>,
      document.body
    );
  }

  const sideCol = !!fill && wide === true;
  return (
    <Card className={w ? cn("p-6", fill ? "h-full flex flex-col overflow-y-auto tinybar" : "h-full") : "p-6 mb-5"}>
      {picker}
      <div className={cn(
        sideCol && "grid grid-cols-[minmax(0,1fr)_minmax(15rem,20rem)] gap-8",
        fill && "flex-1 min-h-0",
        fill && !sideCol && "flex flex-col",
      )}>
        <div className={cn("min-w-0", fill && "flex-1 flex flex-col min-h-0")}>
          <div className={cn("flex items-center justify-between gap-x-3 gap-y-1 flex-wrap", fill ? "mb-3" : "mb-1")}>
            <div className="flex items-baseline gap-x-2 flex-wrap min-w-0">
              {/* the title stays a second mouse path to the full page; the marked button
                  below the note is the first one, and ⏎ on the box is the key */}
              <button type="button" onClick={enterFocus} title="Full page — distraction-free writing (⏎ on the box, Esc to leave)"
                className="text-left hover:text-foreground transition-colors">
                <Label icon={<Sunrise size={13} />}>Notes</Label>
              </button>
              <span className="text-[11px] text-muted-foreground">{dateLabel}</span>
              
            </div>
            <span className="text-[11px] text-muted-foreground nums">{words} words{isToday ? " today" : ""}</span>
          </div>
          
          <div className={cn("relative", fill && "flex-1 flex flex-col min-h-0")}>
            <textarea {...bind} rows={fill ? 3 : 12} style={{ minHeight: fill ? 140 : 260 }} data-knav-primary
              className={cn("w-full bg-background border border-border rounded-lg px-3.5 py-3 text-[14px] leading-relaxed focus:outline-none focus:border-primary",
                fill ? "flex-1 resize-none tinybar" : "resize-y")} />
            <span className="absolute right-3 bottom-2.5 text-[10.5px] pointer-events-none select-none">
              <StatusTag status={f.status} dirty={f.dirty} />
            </span>
          </div>
          <ClearingActions onFull={enterFocus} />
        </div>
        {sideCol && (
          <div className="min-w-0 border-l border-border/50 pl-8 pt-[3.25rem]">
            <MorningHistory date={date} onPick={onPickDay} />
          </div>
        )}
      </div>
    </Card>
  );
}

function ClearingActions({ onFull }: { onFull: () => void }) {
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [cur, setCur] = useState<Quote | null>(null);
  useEffect(() => { api.canon().then(setQuotes).catch(() => {}); }, []);
  const pick = () => {
    if (!quotes.length) return;
    let q = quotes[Math.floor(Math.random() * quotes.length)];
    for (let i = 0; quotes.length > 1 && cur && q.text === cur.text && i < 6; i++)
      q = quotes[Math.floor(Math.random() * quotes.length)];
    setCur(q);
  };
  const pill = "group inline-flex items-center gap-2 rounded-full border border-border bg-secondary/40 px-4 py-2 text-[12.5px] font-medium text-muted-foreground hover:text-foreground hover:border-primary/50 hover:bg-secondary transition-colors disabled:opacity-50";
  return (
    <div className="shrink-0 mt-3">
      <div className="flex items-center gap-2.5 flex-wrap">
        <button type="button" onClick={onFull} className={pill}
          title="Full page — the clean writing surface (⏎ again on the box, Esc to leave)">
          <Maximize2 size={14} className="text-primary" /> Full page
        </button>
        <button type="button" onClick={pick} disabled={!quotes.length} className={pill}
          title="A line from your own canon">
          <Sparkles size={14} className="text-primary transition-transform group-hover:rotate-12" />
          {cur ? "Another" : "Some inspiration"}
        </button>
        {cur && (
          <button type="button" onClick={() => setCur(null)} title="Put the quote away"
            className="inline-flex items-center gap-1 text-[11.5px] text-muted-foreground hover:text-foreground transition-colors">
            <X size={12} /> hide
          </button>
        )}
      </div>
      {cur && (
        <blockquote className="relative mt-3 rounded-xl border border-border bg-card/60 py-4 pl-6 pr-4">
          <span className="absolute left-2 top-0 select-none font-serif text-[42px] leading-none text-primary/15">&ldquo;</span>
          <p className="text-[15.5px] italic leading-relaxed text-foreground/90" style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}>{cur.text}</p>
          {cur.attribution && <footer className="mt-2.5 text-[12px] text-muted-foreground">— {cur.attribution}</footer>}
        </blockquote>
      )}
    </div>
  );
}

const shortDate = (iso: string) => new Date(iso + "T00:00").toLocaleDateString([], { month: "short", day: "numeric" });
const shiftIso = (iso: string, n: number) => { const x = new Date(iso + "T00:00"); x.setDate(x.getDate() + n); return isoLocal(x); };

/* the focused morning page's right column: 30 days of words, then the latest earlier
 * mornings (one tap flips the journal to that day) */
function MorningHistory({ date, onPick }: { date: string; onPick?: (date: string) => void }) {
  const [stats, setStats] = useState<DayStat[] | null>(null);
  const [entries, setEntries] = useState<DayJournal[] | null>(null);
  useEffect(() => {
    let live = true;
    api.daily().then(async (days) => {
      if (!live) return;
      setStats(days);
      // earlier days with writing, inside the window the journal can read back (31 days)
      const floor = shiftIso(isoLocal(new Date()), -30);
      const past = days.filter((d) => d.words > 0 && d.date < date && d.date >= floor)
        .map((d) => d.date).sort().reverse().slice(0, 6);
      const got = await Promise.all(past.map((d) => api.dailySections(d).catch(() => null)));
      if (live) setEntries(got.filter((j): j is DayJournal => !!j && !!j.dailyNotes.trim()));
    }).catch(() => { if (live) { setStats([]); setEntries([]); } });
    return () => { live = false; };
  }, [date]);

  return (
    <div className="mt-6 flex flex-col gap-6 min-w-0">
      {stats && <WordsBars stats={stats} end={date} />}
      <div className="min-w-0">
        <div className="text-[11px] uppercase tracking-[0.09em] font-semibold text-muted-foreground mb-1.5 flex items-center gap-1.5">
          <History size={12} /> Earlier mornings
        </div>
        {!entries ? <p className="text-[12px] text-muted-foreground">Loading…</p>
          : entries.length === 0 ? <p className="text-[12px] text-muted-foreground">No earlier mornings this month.</p>
          : (
            <div className="divide-y divide-border/40">
              {entries.map((j) => (
                <button key={j.date} onClick={() => (onPick ? onPick(j.date) : api.open(j.dailyPath))}
                  title={onPick ? "Show this morning in the journal" : "Open this day's note"}
                  className="block w-full text-left py-2.5 px-2 -mx-2 rounded hover:bg-accent/40 transition-colors min-w-0">
                  <span className="flex items-baseline justify-between gap-2 text-[11px] text-muted-foreground nums min-w-0">
                    <span className="truncate min-w-0">{fmtDateLong(j.date)}</span>
                    <span className="shrink-0">{countWords(j.dailyNotes)} words</span>
                  </span>
                  <span className="block mt-0.5 text-[12.5px] leading-relaxed text-foreground/85 line-clamp-3 break-words">{j.dailyNotes.trim()}</span>
                </button>
              ))}
            </div>
          )}
      </div>
    </div>
  );
}

function WordsBars({ stats, end }: { stats: DayStat[]; end: string }) {
  const [ref, width] = useBoxWidth<HTMLDivElement>();
  const byDate = new Map(stats.map((s) => [s.date, s.words]));
  const days = Array.from({ length: 30 }, (_, i) => { const iso = shiftIso(end, i - 29); return { iso, v: byDate.get(iso) || 0 }; });
  const max = Math.max(1, ...days.map((d) => d.v));
  const H = 72, gap = 3;
  const bw = width > 0 ? Math.max(2, Math.min(22, (width - gap * 29) / 30)) : 0;
  const x0 = width > 0 ? Math.max(0, (width - (bw * 30 + gap * 29)) / 2) : 0;
  const written = days.filter((d) => d.v > 0).length;
  const total = days.reduce((s, d) => s + d.v, 0);
  const dc = useDatumCursor(days.length, {
    onPress: (i) => api.open(`Preparation/Notes/Daily/${days[i].iso}.md`),
  });
  return (
    <div className="min-w-0">
      <div className="text-[11px] uppercase tracking-[0.09em] font-semibold text-muted-foreground mb-2">Words</div>
      <div ref={ref} className="min-w-0" style={{ height: H }}>
        {width > 0 && (
          <div {...dc.surface} className="rounded-sm focus-visible:!bg-transparent"
            aria-label={`Words written per day, ${shortDate(days[0].iso)} to ${shortDate(end)}: ${total.toLocaleString()} words over ${written} days, most ${max.toLocaleString()}`}>
            <svg width={width} height={H} className="block" aria-hidden>
              {days.map((d, i) => {
                const x = x0 + i * (bw + gap);
                const h = d.v ? Math.max(3, (d.v / max) * (H - 6)) : 0;
                const r = Math.min(3, bw / 2, h);
                const y = H - 2 - h;
                const on = dc.active === i;
                const today = d.iso === end;
                return (
                  <g key={d.iso}>
                    {/* today: its column outlined top to bottom, as on the habit grid */}
                    {today && <rect x={x - 2} y={0.5} width={bw + 4} height={H - 1} rx={3}
                      fill="hsl(var(--primary) / 0.07)" stroke="hsl(var(--primary) / 0.55)" strokeWidth={1} />}
                    {h > 0 ? (
                      <path d={`M${x},${H - 2} V${y + r} Q${x},${y} ${x + r},${y} H${x + bw - r} Q${x + bw},${y} ${x + bw},${y + r} V${H - 2} Z`}
                        fill={today ? "hsl(var(--primary))" : "hsl(var(--primary) / 0.42)"}
                        stroke={on ? "hsl(var(--foreground))" : "none"} strokeWidth={1.5} />
                    ) : (
                      <circle cx={x + bw / 2} cy={H - 4} r={on ? 2.6 : 1.6}
                        fill={today ? "hsl(var(--primary))" : on ? "hsl(var(--foreground))" : "hsl(var(--muted-foreground) / 0.45)"} />
                    )}
                    <rect {...dc.mark(i)} x={x - gap / 2} y={0} width={bw + gap} height={H} fill="transparent" />
                  </g>
                );
              })}
            </svg>
            <ChartTip cursor={dc}>{dc.active != null && (() => {
              const d = days[dc.active];
              return <>{new Date(d.iso + "T00:00").toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })} · {d.v ? `${d.v.toLocaleString()} words` : "no writing"}</>;
            })()}</ChartTip>
          </div>
        )}
      </div>
    </div>
  );
}

export function EveningCheckin({ sections, date, dailyPath }:
{ sections: DailySections; date: string; dailyPath: string }) {
  const w = useWidget();
  const focused = !!w?.focused;
  const size = w?.size;
  const cols = !!w && !focused && (size === "lg" || size === "xl");
  const three = focused && size === "xl";
  const two = focused && (size === "lg" || size === "md");
  const layout = three ? "flex-1 grid grid-cols-[minmax(0,3fr)_minmax(0,2fr)_minmax(16rem,2fr)] gap-x-6"
    : two ? "flex-1 grid grid-cols-[minmax(0,1fr)_minmax(14rem,20rem)] grid-rows-[minmax(8rem,3fr)_minmax(11rem,2fr)] gap-x-6"
    : focused ? "flex-1 flex flex-col"
    : cols ? "grid grid-cols-[minmax(0,3fr)_minmax(0,2fr)] gap-x-6" : "";
  useFullPage();
  const cardRef = useRef<HTMLDivElement>(null);
  return (
    <Card ref={cardRef} data-obsidian-file={dailyPath}
      className={w ? cn("p-6", focused ? "min-h-full flex flex-col" : "h-full") : "p-6 mt-2"}>
      <div className="flex items-center justify-between gap-2 flex-wrap mb-3">
        <Label icon={<Moon size={13} />}>Log</Label>
        {!!w && (
          <button type="button" onClick={() => cardRef.current && openWidgetFull(cardRef.current)}
            title="Full page — the evening fields over the whole window (⏎ again on the account, Esc to leave)"
            className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1 text-[11.5px] text-muted-foreground hover:text-foreground hover:border-primary/50 transition-colors">
            <Maximize2 size={12} /> Full page
          </button>
        )}
      </div>
      <div className={layout}>
        <div className={cn(focused && "flex-1 flex flex-col min-h-0", two && "col-start-1 row-start-1")}>
          <Field label="Entry" fill={focused}>
            <JournalField anchor="log-entry" value={sections.eodHappened} date={date} rows={4} minHeight={96} fill={focused}
              primary placeholder="An honest account of the day — what got done, what didn't, how it felt." />
          </Field>
        </div>
        <div className={cn(focused && "flex flex-col min-h-0", two && "col-start-1 row-start-2")}>
          {!!sections.work?.trim() && (
            <Field label="Work">
              <JournalField anchor="work" value={sections.work} date={date} rows={3} placeholder="" />
            </Field>
          )}
          <Field label="Next" fill={focused}>
            <JournalField anchor="log-next" value={sections.eodTomorrow} date={date} rows={2} minHeight={focused ? 56 : undefined}
              fill={focused} placeholder="The one or two things to carry forward." />
          </Field>
          <Field label="Summary">
            <JournalField anchor="log-summary" value={sections.eodSentence} date={date} rows={focused ? 2 : 1} placeholder="Today was…" />
          </Field>
        </div>
        {focused && (
          <div className={cn("min-w-0", two ? "col-start-2 row-start-1 row-span-2 border-l border-border/50 pl-6"
            : three ? "border-l border-border/50 pl-6" : "mt-2 pt-4 border-t border-border/50")}>
            <EveningHistory date={date} />
          </div>
        )}
      </div>
    </Card>
  );
}

/* the seven evenings before this one: the one-sentence summary (else the first line of
 * the account) and what was carried forward; each opens its daily note */
function EveningHistory({ date }: { date: string }) {
  const [rows, setRows] = useState<{ meta: JournalDayMeta; j: DayJournal | null }[] | null>(null);
  useEffect(() => {
    let live = true;
    api.dailyRecent(14).then(async (days) => {
      const past = days.filter((d) => d.date < date).slice(0, 7);
      const full = await Promise.all(past.map((meta) => (meta.eodFilled
        ? api.dailySections(meta.date).then((j) => ({ meta, j })).catch(() => ({ meta, j: null }))
        : Promise.resolve({ meta, j: null }))));
      if (live) setRows(full);
    }).catch(() => { if (live) setRows([]); });
    return () => { live = false; };
  }, [date]);

  return (
    <div className="min-w-0">
      <div className="text-[11px] font-semibold text-muted-foreground mb-1.5 flex items-center gap-1.5">
        <History size={12} /> Last 7 evenings
      </div>
      {!rows ? <p className="text-[12px] text-muted-foreground">Loading…</p>
        : rows.length === 0 ? <p className="text-[12px] text-muted-foreground">No earlier days yet.</p>
        : (
          <div className="divide-y divide-border/40">
            {rows.map(({ meta, j }) => {
              const line = j ? (j.eodSentence.trim() || j.eodHappened.split("\n").find((l) => l.trim())?.trim() || "") : "";
              const carry = j?.eodTomorrow.trim() || "";
              return (
                <button key={meta.date} disabled={!meta.exists}
                  onClick={() => api.open(j?.dailyPath || `Preparation/Notes/Daily/${meta.date}.md`)}
                  title={meta.exists ? "Open this day's note" : "No note this day"}
                  className="w-full text-left py-2 px-1.5 -mx-1.5 rounded enabled:hover:bg-accent/40 transition-colors min-w-0 flex items-start gap-2.5">
                  <span className="mt-[5px] w-1.5 h-1.5 rounded-full shrink-0"
                    style={{ background: line ? "hsl(var(--primary))" : "transparent", border: line ? "none" : "1.5px solid hsl(var(--muted-foreground) / 0.45)" }} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[11px] text-muted-foreground nums">{meta.weekday} {shortDate(meta.date)}</span>
                    <span className={cn("block text-[12.5px] leading-snug line-clamp-2 break-words", !line && "text-muted-foreground/70")}>
                      {line || "No evening entry"}
                    </span>
                    {carry && <span className="block text-[11px] text-muted-foreground leading-snug line-clamp-1 mt-0.5">Carried: {carry}</span>}
                  </span>
                </button>
              );
            })}
          </div>
        )}
    </div>
  );
}

function Field({ label, children, fill, className }: { label: string; children: ReactNode; fill?: boolean; className?: string }) {
  return (
    <div className={cn("mb-3.5 last:mb-0", fill && "flex-1 flex flex-col min-h-0", className)}>
      <label className="block text-[11px] font-semibold text-muted-foreground mb-1.5">{label}</label>
      {children}
    </div>
  );
}

function Label({ children, icon }: { children: ReactNode; icon?: ReactNode }) {
  return (
    <div className="text-[11px] uppercase tracking-[0.09em] font-semibold text-muted-foreground flex items-center gap-1.5">
      {icon}{children}
    </div>
  );
}
