
import { TASKS_BOARD, boardProjectName } from "@/lib/paths";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { CalendarDays, CalendarPlus, Check, CheckCheck, CircleCheck, Clock, ExternalLink, Inbox, Layers, Loader2, NotebookPen, Pin, RotateCcw, StickyNote, Trash2, X, Target } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { BoardProposal, Event, EvtCategory, KCard, TLItem } from "@/lib/api";
import { eventColor, fmtTime, prioColor } from "@/lib/format";
import { Markdown } from "@/lib/markdown";
import { Chip, JoinButton, PanelSection, QuickAdd, TaskRow } from "@/components/calrows";
import { EditDate, EditSelect, EditText, PRIORITY_OPTS, dateTone } from "@/components/planedit";
import { pendingNoteOpen } from "@/lib/taskdest";
import { DayNote } from "@/components/DayNote";
import type { NavId } from "@/components/Sidebar";

const DAILY_DIR = "Preparation/Notes/Daily/";

/** Everything the surface has already grouped for this one day. */
export type DayBundle = {
  events: Event[];
  tasks: TLItem[];
  proposals: BoardProposal[];
  done: KCard[];
};

const EMPTY: DayBundle = { events: [], tasks: [], proposals: [], done: [] };

const dayLabel = (iso: string) =>
  new Date(iso + "T00:00:00").toLocaleString("en", { weekday: "long", month: "long", day: "numeric" });

function relLabel(iso: string) {
  const d = new Date(iso + "T00:00:00");
  const t = new Date(); t.setHours(0, 0, 0, 0);
  const diff = Math.round((+d - +t) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  return diff < 0 ? `${-diff} days ago` : `in ${diff} days`;
}

export function DayPanel({
  iso, autoAddEvent, onClose, bundle, floating, cats, busyRaw,
  onToggleTask, onRescheduleTask, onAddCard, onPinFloating, reload, openBoard, go, project,
  planFor, onOpenPlan,
}: {
  iso: string | null;
  /** opened by the grid's hover "+" — start straight in the new-event form */
  autoAddEvent?: boolean;
  onClose: () => void;
  bundle: DayBundle;
  floating: { lane: string; card: KCard }[];
  cats: EvtCategory[];
  busyRaw: string | null;
  onToggleTask: (it: TLItem) => void;
  onRescheduleTask: (it: TLItem, day: string | null) => void;
  onAddCard: (card: string, due: string | null) => Promise<void>;
  onPinFloating: (c: KCard, day: string) => void;
  reload: () => void;
  openBoard: (path: string, title: string, isPaper: boolean) => void;
  go?: (v: string) => void;
  project?: { slug: string; name: string } | null;
  /** the approved plan an event is a milestone of, if any */
  planFor?: (e: Event) => { slug: string; title: string } | null;
  onOpenPlan?: (slug: string) => void;
}) {
  // keep the day (and its content) through the closing animation so the panel
  // never flashes empty on the way out
  const [shown, setShown] = useState<string | null>(iso);
  useEffect(() => { if (iso) setShown(iso); }, [iso]);
  // the inline event editor: null = closed, {ev: null} = adding
  const [editor, setEditor] = useState<{ ev: Event | null } | null>(null);
  const [floatOpen, setFloatOpen] = useState(false);
  const addEventBtn = useRef<HTMLButtonElement>(null);
  const noteRef = useRef<HTMLDivElement>(null);
  const [hasNote, setHasNote] = useState(false);
  useEffect(() => {
    setEditor(iso && autoAddEvent ? { ev: null } : null);
    setFloatOpen(false);
  }, [iso, autoAddEvent]);

  const day = shown;
  const b = iso ? bundle : EMPTY;   // once closed, stop rendering live data into it

  return (
    <Sheet open={iso !== null} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent side="right"
        // with the event editor open, Escape closes the editor, not the whole day
        onEscapeKeyDown={(e) => {
          if (!editor) return;
          e.preventDefault();
          setEditor(null);
          requestAnimationFrame(() => addEventBtn.current?.focus());
        }}
        className="w-full sm:max-w-[620px] p-0 gap-0 flex flex-col border-l border-border">
        {day && (
          <>
            <SheetHeader className="shrink-0 space-y-0 text-left px-6 pt-6 pb-4 border-b border-border/60">
              <div className="text-[11px] uppercase tracking-[0.1em] font-semibold text-muted-foreground flex items-center gap-1.5">
                <CalendarDays size={13} className="opacity-70" /> {relLabel(day)}
              </div>
              <SheetTitle className="text-[21px] font-semibold tracking-tight mt-1">{dayLabel(day)}</SheetTitle>
              <p className="text-[12.5px] text-muted-foreground nums mt-1">
                {b.events.length} event{b.events.length === 1 ? "" : "s"} · {b.tasks.length} task{b.tasks.length === 1 ? "" : "s"}
                {b.proposals.length > 0 && ` · ${b.proposals.length} proposed`}
              </p>
              <div className="flex items-center gap-1.5 flex-wrap pt-3">
                <Button size="sm" variant="outline" className="gap-1.5" ref={addEventBtn}
                  onClick={() => setEditor({ ev: null })}>
                  <CalendarPlus size={13} /> Add event
                </Button>
                <Button size="sm" variant="ghost" className="gap-1.5 text-muted-foreground"
                  title={hasNote ? "Jump to the daily note" : "Open in Obsidian"}
                  onClick={() => hasNote
                    ? noteRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
                    : api.open(DAILY_DIR + day + ".md")}>
                  <StickyNote size={13} /> Daily note
                </Button>
              </div>
            </SheetHeader>

            <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5">
              <div className="mb-6">
                <QuickAdd defaultDue={day} onAdd={onAddCard}
                  placeholder="Add a task to this day…   !high  ~45m  #tag" />
              </div>

              {editor && (
                <div className="mb-6">
                  <EventEditor key={editor.ev?.path || "new"} ev={editor.ev} date={day} cats={cats} project={project?.slug || null}
                    go={go}
                    onClose={() => setEditor(null)}
                    onSaved={() => { setEditor(null); reload(); }} />
                </div>
              )}

              <DayNote key={day} day={day} onLoaded={setHasNote} sectionRef={noteRef} />

              {b.events.length > 0 && (
                <PanelSection label="Events" icon={<CalendarDays size={12} />} count={b.events.length}>
                  <div className="grid gap-1.5">
                    {b.events.map((e) => (
                      <EventRow key={e.path} e={e}
                        plan={planFor?.(e) || null} onOpenPlan={onOpenPlan}
                        onEdit={() => setEditor({ ev: e })}
                        onResolved={reload}
                        // if the editor is open on the event that just went, close
                        // it — it would otherwise sit there editing a dead file
                        onDeleted={() => { if (editor?.ev?.path === e.path) setEditor(null); reload(); }} />
                    ))}
                  </div>
                </PanelSection>
              )}

              {b.tasks.length > 0 && (
                <PanelSection label="Tasks" icon={<CheckCheck size={12} />} count={b.tasks.length}>
                  <div className="grid gap-1.5">
                    {b.tasks.map((it) => (
                      <TaskRow key={it.raw || it.text} it={it} openBoard={openBoard} go={go}
                        busy={busyRaw === it.raw}
                        onToggle={() => onToggleTask(it)}
                        onReschedule={(d) => onRescheduleTask(it, d)} />
                    ))}
                  </div>
                </PanelSection>
              )}

              {b.proposals.length > 0 && (
                <PanelSection label="Proposed for this day" icon={<Inbox size={12} />} count={b.proposals.length}
                  hint="Agents can't put cards on your board. Fix anything that's nearly right, then accept or reject.">
                  <div className="grid gap-1.5">
                    {b.proposals.map((p) => <ProposalRow key={p.id} p={p} onResolved={reload} />)}
                  </div>
                </PanelSection>
              )}

              {b.done.length > 0 && (
                <PanelSection label="Done" icon={<CircleCheck size={12} />} count={b.done.length}>
                  <div className="grid gap-1">
                    {b.done.map((c) => (
                      <div key={c.raw} className="flex items-center gap-2 text-[13px] text-muted-foreground line-through decoration-muted-foreground/40">
                        <CircleCheck size={13} className="shrink-0 text-[hsl(152_30%_44%)]" />
                        <span className="truncate">{c.text}</span>
                      </div>
                    ))}
                  </div>
                </PanelSection>
              )}

              {b.events.length + b.tasks.length + b.proposals.length === 0 && !editor && !hasNote && (
                <p className="text-[13px] text-muted-foreground/70 italic mb-6">Nothing on this day yet.</p>
              )}

              <PanelSection label="Floating" icon={<Layers size={12} />} count={floating.length}
                right={floating.length > 0 ? (
                  <button onClick={() => setFloatOpen((v) => !v)}
                    className="text-[11.5px] text-muted-foreground hover:text-foreground transition-colors">
                    {floatOpen ? "Hide" : `Pin one to ${relLabel(day).toLowerCase() === "today" ? "today" : dayLabel(day).split(",")[0]}`}
                  </button>
                ) : undefined}>
                {floating.length === 0 ? (
                  <p className="text-[12.5px] text-muted-foreground/70">Nothing floating — everything has its day.</p>
                ) : !floatOpen ? (
                  <p className="text-[12.5px] text-muted-foreground/80">
                    {floating.length} undated card{floating.length === 1 ? "" : "s"} waiting for a day.
                  </p>
                ) : (
                  <div className="grid gap-1">
                    {floating.slice(0, 40).map(({ lane, card }) => (
                      <div key={card.raw}
                        className={`group flex items-center gap-2.5 rounded-lg border border-border bg-card/50 px-3 py-2 ${busyRaw === card.raw ? "opacity-50" : ""}`}>
                        <span className="h-1.5 w-1.5 rounded-full shrink-0" style={{ background: prioColor(card.priority) }} />
                        <span className="flex-1 min-w-0 truncate text-[12.5px]">{card.text}</span>
                        <span className="shrink-0 text-[10.5px] uppercase tracking-[0.06em] text-muted-foreground/60">{lane}</span>
                        <Chip onClick={() => onPinFloating(card, day)} title={`Pin to ${day}`}>
                          <Pin size={10} /> Pin here
                        </Chip>
                      </div>
                    ))}
                    {floating.length > 40 && (
                      <p className="text-[11.5px] text-muted-foreground/70 pt-1">
                        +{floating.length - 40} more — open the board for bulk triage.
                      </p>
                    )}
                  </div>
                )}
              </PanelSection>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

/* ------------------------------------------------------------------ event rows */

function EventRow({ e, plan, onOpenPlan, onEdit, onResolved, onDeleted }: {
  e: Event; plan?: { slug: string; title: string } | null; onOpenPlan?: (slug: string) => void;
  onEdit: () => void; onResolved: () => void; onDeleted: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const color = eventColor(e);
  // a ledger commitment is read-only here: no resolve, no delete; it opens Drafting → Pipeline
  const ro = !!e.readOnly;
  const span = e.endDate && e.endDate > e.date;
  const done = e.completed;
  const tick = async () => {
    if (busy) return;
    setBusy(true);
    const res = await api.resolveEvent(e.path, !done).catch(() => ({ error: "network" as const }));
    setBusy(false);
    if (res.error) { toast.error("Couldn't mark that — reload and try again"); return; }
    toast.success(done ? "Reopened" : "Resolved — off your plate");
    onResolved();
  };
  const del = async () => {
    if (busy) return;
    const warn = e.recurring
      ? `Delete "${e.title}"? It repeats yearly, so this removes the whole repeating series. This can be undone from the vault if needed.`
      : `Delete "${e.title}"? This can be undone from the vault if needed.`;
    if (!window.confirm(warn)) return;
    setBusy(true);
    const res = await api.deleteEvent(e.path).catch(() => ({ error: "network" as const }));
    setBusy(false);
    if (res.error) { toast.error("Couldn't delete that — reload and try again"); return; }
    toast.success("Deleted");
    onDeleted();
  };
  return (
    <div className={`group flex items-stretch gap-3 rounded-xl border border-border bg-card px-3.5 py-2.5 hover:border-primary/40 transition-all ${busy ? "opacity-50" : done ? "opacity-65" : ""}`}>
      {/* round tick = event (tasks use the square); a recurring file writes back
          every occurrence at once, so it doesn't get one */}
      {!e.recurring && !ro && (
        <button onClick={tick} disabled={busy} title={done ? "Reopen" : "Resolve — mark it handled"}
          aria-label={`${done ? "Reopen" : "Resolve"}: ${e.title}`}
          className={`self-center shrink-0 h-[18px] w-[18px] rounded-full border-2 grid place-items-center transition-colors ${done
            ? "border-[hsl(152_30%_44%)] bg-[hsl(152_30%_44%)] text-white"
            : "border-muted-foreground/40 hover:border-primary hover:bg-primary/10"}`}>
          {busy ? <Loader2 size={11} className="animate-spin" /> : done ? <Check size={11} strokeWidth={3} /> : null}
        </button>
      )}
      <span className="w-1.5 rounded-full shrink-0" style={{ background: color, opacity: done ? 0.5 : 1 }} />
      {/* a read-only plan milestone opens its plan; a ledger commitment opens the Pipeline */}
      <button onClick={ro && plan && onOpenPlan ? () => onOpenPlan(plan.slug) : ro ? () => { window.location.hash = "#/drafting/pipeline"; } : onEdit}
        title={ro && plan ? `Open the project plan: ${plan.title}` : ro ? "Commitment — open in Drafting, Pipeline" : "Edit this event"} className="flex-1 min-w-0 text-left py-0.5">
        <span className={`block text-[14px] font-medium leading-snug truncate transition-colors ${done ? "text-muted-foreground line-through decoration-muted-foreground/40" : "group-hover:text-primary"}`}>
          {e.title}
        </span>
        <span className="text-[11.5px] text-muted-foreground nums mt-0.5 flex items-center gap-2 flex-wrap">
          <span className="capitalize">{e.category}</span>
          {!e.allDay && e.startTime && (
            <span className="inline-flex items-center gap-1"><Clock size={11} /> {fmtTime(e.startTime)}{e.endTime ? "–" + fmtTime(e.endTime) : ""}</span>
          )}
          {e.allDay && !span && <span>all day</span>}
          {span && <span>→ {e.endDate!.slice(5)}</span>}
          {e.recurring && <span>yearly</span>}
          {done && <span className="text-[hsl(152_30%_44%)]">resolved</span>}
        </span>
      </button>
      <JoinButton e={e} />
      {plan && onOpenPlan && !ro && (
        <button onClick={() => onOpenPlan(plan.slug)} title={`Open the project plan: ${plan.title}`}
          aria-label={`Open the project plan: ${plan.title}`}
          className="self-center shrink-0 inline-flex items-center justify-center h-6 w-6 rounded-md text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors">
          <Target size={13} />
        </button>
      )}
      {!ro && <>
      <button onClick={del} disabled={busy}
        title={e.recurring ? "Delete this event — removes the whole yearly series" : "Delete this event"}
        aria-label={`Delete: ${e.title}`}
        className="self-center shrink-0 inline-flex items-center justify-center h-6 w-6 rounded-md text-muted-foreground/45 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 hover:text-destructive hover:bg-destructive/10 transition-all">
        <Trash2 size={13} />
      </button>
      </>}
    </div>
  );
}

const stripJoinLine = (body: string) => body.replace(/^Join:\s*\S*[ \t]*\r?\n?/, "").replace(/^\r?\n/, "");

/** Add or edit an event in place. One form, two modes — Delete and Resolve only
 *  exist when there is a file to act on. */
function EventEditor({ ev, date, cats, project, go, onClose, onSaved }: {
  ev: Event | null; date: string; cats: EvtCategory[]; project?: string | null;
  go?: (v: NavId) => void; onClose: () => void; onSaved: () => void;
}) {
  const [form, setForm] = useState({
    title: ev?.title || "",
    date: ev?.date || date,
    category: (ev?.category || "meetings") as EvtCategory,
    allDay: ev ? ev.allDay : true,
    startTime: ev?.startTime || "09:00",
    endTime: ev?.endTime || "",
    repeatsYearly: ev ? ev.recurring : false,
    link: ev?.link || "",
    note: "",
  });
  const [noteLoading, setNoteLoading] = useState(!!ev);
  const [busy, setBusy] = useState<"save" | "delete" | "resolve" | "notes" | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const meetingNotes = async () => {
    if (!ev) return;
    setBusy("notes"); setErr(null);
    try {
      const r = await api.meetingNote(ev.path);
      if (!r.ok || !r.path) { setErr(r.error || "Couldn't open the notes for this meeting"); return; }
      pendingNoteOpen.current = { path: r.path, title: r.title || ev.title, readonly: false };
      onClose();
      go?.("notes");
    } catch { setErr("Couldn't open the notes for this meeting"); }
    finally { setBusy(null); }
  };

  // the event list never carries the note body — fetch it lazily so opening the
  // editor never waits on it
  useEffect(() => {
    if (!ev) return;
    let live = true;
    api.eventBody(ev.path)
      .then((r) => { if (live) setForm((f) => ({ ...f, note: stripJoinLine(r.body || "") })); })
      .finally(() => { if (live) setNoteLoading(false); });
    return () => { live = false; };
  }, [ev]);

  const save = async () => {
    if (!form.title.trim() || !form.date) return;
    setBusy("save"); setErr(null);
    const payload = {
      title: form.title.trim(), date: form.date, category: form.category,
      allDay: form.allDay,
      startTime: form.allDay ? undefined : form.startTime,
      endTime: form.allDay || !form.endTime ? undefined : form.endTime,
      repeatsYearly: form.repeatsYearly,
      note: form.note,
      link: form.link.trim(),
      project: project ?? ev?.project ?? null,
    };
    const res = ev ? await api.updateEvent({ ...payload, path: ev.path }) : await api.createEvent(payload);
    setBusy(null);
    if (res.error) { setErr(res.error); return; }
    toast.success(ev ? "Event saved" : "Event added");
    onSaved();
  };
  const remove = async () => {
    if (!ev) return;
    if (!window.confirm(`Delete "${form.title}"? This can be undone from the vault if needed.`)) return;
    setBusy("delete"); setErr(null);
    const res = await api.deleteEvent(ev.path);
    setBusy(null);
    if (res.error) { setErr(res.error); return; }
    toast.success("Deleted");
    onSaved();
  };
  const resolve = async () => {
    if (!ev) return;
    setBusy("resolve"); setErr(null);
    const res = await api.resolveEvent(ev.path, !ev.completed);
    setBusy(null);
    if (res.error) { setErr(res.error); return; }
    onSaved();
  };

  return (
    <div className="rounded-xl border border-primary/40 bg-primary/[0.035] p-4">
      <div className="flex items-center gap-2 mb-3">
        <div className="text-[11px] uppercase tracking-[0.1em] font-semibold text-primary flex items-center gap-1.5">
          <CalendarPlus size={13} /> {ev ? "Edit event" : "New event"}
        </div>
        <button onClick={onClose} aria-label="Close the event editor"
          className="ml-auto text-muted-foreground/60 hover:text-foreground"><X size={14} /></button>
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="evt-title">Title</Label>
          {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
          <Input id="evt-title" autoFocus value={form.title}
            placeholder="Event title"
            onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); save(); } }} />
        </div>
        <div className="flex items-center gap-2">
          <div className="flex flex-col gap-1.5 flex-1">
            <Label htmlFor="evt-date">Date</Label>
            <Input id="evt-date" type="date" value={form.date}
              onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))} />
          </div>
          <div className="flex flex-col gap-1.5 flex-1">
            <Label htmlFor="evt-cat">Category</Label>
            <select id="evt-cat" value={form.category}
              onChange={(e) => setForm((f) => ({ ...f, category: e.target.value as EvtCategory }))}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm capitalize">
              {(cats.length ? cats : [form.category]).map((c) => <option key={c} value={c} className="capitalize">{c}</option>)}
            </select>
          </div>
        </div>
        <div className="flex items-center justify-between">
          <Label htmlFor="evt-allday" className="cursor-pointer">All day</Label>
          <Switch id="evt-allday" checked={form.allDay}
            onCheckedChange={(v) => setForm((f) => ({ ...f, allDay: v }))} />
        </div>
        {!form.allDay && (
          <div className="flex items-center gap-2">
            <div className="flex flex-col gap-1.5 flex-1">
              <Label htmlFor="evt-start">Start</Label>
              <Input id="evt-start" type="time" value={form.startTime}
                onChange={(e) => setForm((f) => ({ ...f, startTime: e.target.value }))} />
            </div>
            <div className="flex flex-col gap-1.5 flex-1">
              <Label htmlFor="evt-end">End (optional)</Label>
              <Input id="evt-end" type="time" value={form.endTime}
                onChange={(e) => setForm((f) => ({ ...f, endTime: e.target.value }))} />
            </div>
          </div>
        )}
        <div className="flex items-center justify-between">
          <Label htmlFor="evt-yearly" className="cursor-pointer">
            Repeats yearly <span className="text-muted-foreground text-xs">(birthdays, holidays)</span>
          </Label>
          <Switch id="evt-yearly" checked={form.repeatsYearly}
            onCheckedChange={(v) => setForm((f) => ({ ...f, repeatsYearly: v }))} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="evt-link">Link</Label>
          <Input id="evt-link" type="url" inputMode="url" value={form.link}
            placeholder="https://… (Zoom, Teams, Meet)"
            title="Join link — it becomes a Join button on the event and a clickable line in the note"
            onChange={(e) => setForm((f) => ({ ...f, link: e.target.value }))}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); save(); } }} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="evt-note">Notes</Label>
          <Textarea id="evt-note" rows={3} value={form.note}
            placeholder={noteLoading ? "Loading…" : "Agenda, directions, details… markdown is fine."}
            disabled={noteLoading}
            onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} />
          {form.note.trim() && (
            <div className="rounded-md border border-border/60 bg-secondary/30 px-3 py-2 max-h-40 overflow-y-auto">
              <Markdown text={form.note} className="text-[13px] leading-relaxed text-foreground/90" />
            </div>
          )}
        </div>
        {err && <p className="text-sm text-destructive">{err}</p>}
        <div className="flex items-center gap-2 flex-wrap">
          <Button size="sm" onClick={save}
            disabled={busy !== null || !form.title.trim() || !form.date}>
            {busy === "save" ? "Saving…" : ev ? "Save" : "Add event"}
          </Button>
          <Button size="sm" variant="ghost" onClick={onClose} disabled={busy !== null} className="text-muted-foreground">
            Cancel
          </Button>
          {ev && (
            <>
              {!ev.recurring && (
                <Button size="sm" variant="outline" className="gap-1.5 text-[hsl(152_30%_38%)] hover:text-[hsl(152_30%_32%)]"
                  onClick={resolve} disabled={busy !== null}
                  title={ev.completed ? "Put it back on your plate" : "Handled — keep it, struck through"}>
                  {ev.completed ? <RotateCcw size={13} /> : <CircleCheck size={13} />}
                  {busy === "resolve" ? "Working…" : ev.completed ? "Reopen" : "Mark done"}
                </Button>
              )}
              {ev.category === "meetings" && !ev.recurring && (
                <Button size="sm" variant="outline" className="gap-1.5"
                  onClick={meetingNotes} disabled={busy !== null}
                  title="Open the notes filed for this meeting — created on first use">
                  <NotebookPen size={13} /> {busy === "notes" ? "Opening…" : "Meeting notes"}
                </Button>
              )}
              <Button size="sm" variant="outline" className="gap-1.5 text-destructive hover:text-destructive"
                onClick={remove} disabled={busy !== null}>
                <Trash2 size={13} /> {busy === "delete" ? "Deleting…" : "Delete"}
              </Button>
              <button onClick={() => api.open(ev.path)}
                title="Only needed for advanced formatting the quick editor doesn't cover"
                className="ml-auto inline-flex items-center gap-1.5 text-[11.5px] text-muted-foreground/70 hover:text-foreground">
                <ExternalLink size={11} /> Obsidian
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- proposal rows */

const boardLabel = (p: string) =>
  p === TASKS_BOARD ? "my board" : boardProjectName(p);

function ProposalRow({ p, onResolved }: { p: BoardProposal; onResolved: () => void }) {
  const [edits, setEdits] = useState<Partial<BoardProposal>>({});
  const [busy, setBusy] = useState(false);
  const val = <K extends keyof BoardProposal>(k: K): BoardProposal[K] =>
    (k in edits ? (edits as BoardProposal)[k] : p[k]);
  const dirty = Object.keys(edits).length > 0;

  const accept = async () => {
    setBusy(true);
    try {
      const res = await api.acceptProposal(p.id, dirty ? edits : undefined);
      toast.success(`Added to ${boardLabel(res.board)} · ${res.lane}`);
      onResolved();
    } catch (e) { toast.error(`Couldn't accept: ${(e as Error).message}`); }
    finally { setBusy(false); }
  };
  const reject = async () => {
    setBusy(true);
    try {
      await api.rejectProposal(p.id);
      toast.success("Rejected — it won't come back");
      onResolved();
    } catch (e) { toast.error(`Couldn't reject: ${(e as Error).message}`); }
    finally { setBusy(false); }
  };

  return (
    <div className={`rounded-xl border border-dashed border-border bg-card/40 px-3.5 py-2.5 ${busy ? "opacity-50" : ""}`}>
      <div className="flex items-start gap-2">
        <span className="flex-1 min-w-0">
          <EditText value={(val("text") as string) || ""} multiline
            placeholder="What is the task?" ariaLabel="proposed card text"
            className="text-[13px] leading-snug"
            onChange={(v) => setEdits((e) => ({ ...e, text: v }))} />
        </span>
        <div className="flex items-center gap-1 shrink-0">
          <Button variant="ghost" size="sm" disabled={busy} onClick={reject}
            className="gap-1 h-7 text-muted-foreground hover:text-destructive">
            <X size={13} /> Reject
          </Button>
          <Button size="sm" disabled={busy} onClick={accept} className="gap-1 h-7">
            <Check size={13} /> {busy ? "…" : "Accept"}
          </Button>
        </div>
      </div>
      <div className="flex items-center gap-2.5 flex-wrap mt-1.5">
        <span className="text-[11px] text-muted-foreground/70">{boardLabel((val("board") as string) || TASKS_BOARD)}</span>
        <EditSelect value={(val("lane") as string) || "BACKLOG"} ariaLabel="lane"
          options={["INBOX", "BACKLOG", "TODAY"].map((l) => ({ value: l, label: l }))}
          onChange={(v) => setEdits((e) => ({ ...e, lane: v }))} className="text-muted-foreground" />
        <EditSelect value={(val("priority") as string) || ""} options={PRIORITY_OPTS} ariaLabel="priority"
          onChange={(v) => setEdits((e) => ({ ...e, priority: v || null }))}
          className={val("priority") === "high" ? "text-primary font-semibold" : "text-muted-foreground"} />
        <EditDate value={val("due") as string} tone={dateTone(val("due") as string)}
          ariaLabel="due date" onChange={(v) => setEdits((e) => ({ ...e, due: v }))} />
        {p.source && <span className="text-[11px] text-muted-foreground/60">proposed by {p.source}</span>}
        {dirty && <span className="text-[11px] text-amber-600 dark:text-amber-500">edited</span>}
      </div>
      {p.note && <div className="text-[12px] text-muted-foreground mt-1.5 leading-snug">{p.note}</div>}
    </div>
  );
}
