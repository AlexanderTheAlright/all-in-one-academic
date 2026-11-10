
import { TASKS_BOARD } from "@/lib/paths";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { TLItem } from "@/lib/api";
import { useApi, usePersistent } from "@/lib/hooks";
import { useAppTheme } from "@/lib/theme";
import { DailyNotes } from "@/components/DailyJournal";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { KeyLayer } from "@/components/KeyLayer";
import { Shortcuts } from "@/components/Shortcuts";
import { WidgetColumn } from "@/components/widgets/frame";
import { TimerWidget } from "@/components/widgets/TimerWidget";
import { CaptureWidget } from "@/components/widgets/CaptureWidget";
import { NowWidget } from "@/components/widgets/NowWidget";
import { FigureWidget } from "@/components/widgets/FigureWidget";
import { DiagramWidget } from "@/components/widgets/DiagramWidget";
import { NoteWidget } from "@/components/widgets/NoteWidget";
import type { WidgetName } from "@/lib/pathroute";

const MASTER = TASKS_BOARD;
const localISO = (d = new Date()) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
// a typing target owns its letter keys
const typing = () => {
  const el = document.activeElement;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || (el as HTMLElement).isContentEditable);
};

export function WidgetShell({ name }: { name: WidgetName }) {
  const [helpOpen, setHelpOpen] = useState(false);
  const [theme] = usePersistent<"auto" | "light" | "dark">("aioa-theme", "auto");
  const appTheme = useAppTheme(theme === "auto" ? null : theme);
  const dark = theme === "dark"
    || (theme === "auto" && (appTheme.mode ? appTheme.mode === "dark"
      : Boolean(window.matchMedia?.("(prefers-color-scheme: dark)").matches)));
  useEffect(() => { document.documentElement.classList.toggle("dark", dark); }, [dark]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || name === "note") return;
      if (helpOpen || document.fullscreenElement
        || document.querySelector("[role=dialog], [role=alertdialog], [data-knav-modal], body > .fixed.inset-0")) return;
      window.setTimeout(() => { if (!e.defaultPrevented) window.close(); }, 0);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [helpOpen, name]);

  // the key sheet opens from a key, not a button, so Radix has no trigger to hand
  // the focus back to: put it back on whatever held it when `?` was pressed
  const beforeHelp = useRef<HTMLElement | null>(null);
  const openHelp = useCallback(() => {
    const a = document.activeElement as HTMLElement | null;
    beforeHelp.current = a && a !== document.body ? a : null;
    setHelpOpen(true);
  }, []);
  useEffect(() => {
    if (helpOpen) return;
    const el = beforeHelp.current;
    beforeHelp.current = null;
    if (!el) return;
    const id = window.setTimeout(() => { if (el.isConnected) el.focus({ preventScroll: true }); }, 30);
    return () => window.clearTimeout(id);
  }, [helpOpen]);

  const bleed = name === "figure" || name === "note";
  return (
    <div data-widget={name}
      className={"h-screen w-full bg-background text-foreground overflow-hidden"
        + (bleed ? "" : " px-4 py-3 min-[900px]:px-8 min-[900px]:py-6")}>
      <Shortcuts open={helpOpen} setOpen={setHelpOpen} />
      <KeyLayer mode="widget" widget={name} onHelp={openHelp} blocked={helpOpen} />
      <ErrorBoundary>
        {name === "tasks" ? <TasksWidget />
          : name === "journal" ? <JournalWidget />
              : name === "timer" ? <TimerWidget />
                : name === "capture" ? <CaptureWidget />
                  : name === "figure" ? <FigureWidget />
                    : name === "note" ? <NoteWidget />
                    : name === "diagram" || name === "diagrams" ? <DiagramWidget library={name === "diagrams"} />
                      : <NowWidget />}
      </ErrorBoundary>
    </div>
  );
}

function TasksWidget() {
  const t = useApi(() => api.today(), [], 30_000);
  const items: TLItem[] = useMemo(
    () => [...(t.data?.overdue ?? []), ...(t.data?.dueToday ?? [])], [t.data]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const list = useRef<HTMLUListElement>(null);
  const addBox = useRef<HTMLInputElement>(null);
  const refocus = useRef<number | null>(null);
  const today = localISO();

  const toggle = useCallback(async (it: TLItem, i: number) => {
    if (!it.raw || busy) return;
    setBusy(true);
    refocus.current = i;
    try { await api.boardOp(it.path, "toggle", { raw: it.raw }); t.reload(); }
    catch { refocus.current = null; /* the list reloads on its own */ }
    setBusy(false);
  }, [busy, t]);

  // a ticked row leaves the list: when that took the focus with it, land on the row
  // that took its place (or the new-task field once the list is empty)
  useEffect(() => {
    const i = refocus.current;
    if (i === null) return;
    refocus.current = null;
    const a = document.activeElement;
    if (a && a !== document.body && a.isConnected) return;
    const rows = Array.from(list.current?.querySelectorAll<HTMLElement>("[data-knav-item]") ?? []);
    const next = rows[Math.min(i, rows.length - 1)];
    (next ?? addBox.current)?.focus({ preventScroll: true });
    next?.scrollIntoView({ block: "nearest" });
  }, [items]);

  const newCard = useCallback(async () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    try { await api.boardOp(MASTER, "add", { lane: "TODAY", text: `${text} @due(${localISO()})` }); t.reload(); }
    catch { setDraft(text); }
  }, [draft, t]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.defaultPrevented || typing() || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "n") { addBox.current?.focus(); e.preventDefault(); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  return (
    <WidgetColumn label="Today" meta={items.length ? items.length : undefined}
      hint="Arrows or j/k move · Enter done · n new · g f full view · ? keys · Esc close">
      <div className="min-h-0 flex-1 overflow-y-auto">
        {items.length === 0 ? (
          <div className="px-2.5 py-2 text-[13px] min-[900px]:text-[14px] text-muted-foreground">
            {t.data ? "Clean slate." : t.error ? "Tasks unavailable" : "Loading"}
          </div>
        ) : (
          <ul ref={list} className="space-y-0.5">
            {items.map((it, i) => (
              <li key={i}>
                <button data-knav-item data-task-row={i}
                  onClick={() => void toggle(it, i)}
                  title={it.board && it.board !== "Tasks" ? it.board : undefined}
                  className={"group w-full text-left flex items-start gap-2.5 rounded-md px-2.5 py-2 "
                    + "text-[13.5px] min-[900px]:text-[15px] leading-snug text-foreground "
                    + "hover:bg-muted/60 focus:bg-muted focus:outline-none"
                    + (busy ? " cursor-wait" : "")}>
                  <span className="mt-[3px] min-[900px]:mt-[4px] h-3.5 w-3.5 shrink-0 rounded-sm border border-muted-foreground/60 group-focus:border-primary" />
                  <span className="min-w-0 flex-1">{it.text}</span>
                  {it.due && it.due < today && (
                    <span className="shrink-0 pt-[2px] text-[11px] min-[900px]:text-[12px] text-muted-foreground nums">{it.due.slice(5)}</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <input ref={addBox} value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void newCard(); } }}
        placeholder="New task" aria-label="New task, due today" data-task-new
        className="w-full shrink-0 rounded-md border border-border bg-card px-2.5 py-2 text-[13.5px] min-[900px]:text-[15px] outline-none placeholder:text-muted-foreground/50 focus:border-primary/50" />
    </WidgetColumn>
  );
}

function JournalWidget() {
  const date = localISO();
  const j = useApi(() => api.dailySections(date), [date]);
  const wrap = useRef<HTMLDivElement>(null);
  const ready = !!j.data;

  useEffect(() => {
    const w = wrap.current;
    if (!ready || !w) return;
    let raf = 0;
    const fit = () => {
      raf = 0;
      const card = w.firstElementChild as HTMLElement | null;
      const field = w.querySelector("textarea");
      if (!card || !field) return;
      const cs = getComputedStyle(card);
      const inner = card.getBoundingClientRect().bottom - parseFloat(cs.paddingBottom) - parseFloat(cs.borderBottomWidth);
      let used = 0;
      for (const c of Array.from(card.children)) used = Math.max(used, c.getBoundingClientRect().bottom);
      const free = inner - used;
      if (Math.abs(free) < 1) return;
      field.style.height = `${Math.max(140, Math.floor(field.getBoundingClientRect().height + free))}px`;
    };
    const queue = () => { if (!raf) raf = requestAnimationFrame(fit); };
    const ro = new ResizeObserver(queue);
    ro.observe(w);
    const card = w.firstElementChild;
    if (card) for (const c of Array.from(card.children)) ro.observe(c);
    queue();
    return () => { ro.disconnect(); if (raf) cancelAnimationFrame(raf); };
  }, [ready]);

  if (!j.data) {
    return <div className="text-[12.5px] text-muted-foreground">{j.error ? "Today's note unavailable" : "Loading today's note"}</div>;
  }
  return (
    <div ref={wrap} data-journal-fill
      // reached by the keys, a field's caret sits at 0: writing continues the entry,
      // so move it to the end (a click places its own caret after this)
      onFocus={(e) => {
        const f = e.target;
        if (f instanceof HTMLTextAreaElement && f.value && f.selectionStart === 0 && f.selectionEnd === 0) {
          f.setSelectionRange(f.value.length, f.value.length);
          f.scrollTop = f.scrollHeight;
        }
      }}
      className="mx-auto h-full w-full max-w-[1200px] [&>div]:mb-0 [&>div]:h-full [&>div]:overflow-hidden [&_textarea]:resize-none">
      <DailyNotes sections={j.data} date={j.data.date} isToday />
    </div>
  );
}
