
import { TASKS_BOARD } from "@/lib/paths";
import { useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Target, Check, X, CircleAlert, CalendarDays, Hash, ChevronRight, ChevronDown,
  SlidersHorizontal, ArrowUpRight, Archive,
} from "lucide-react";
import { useApi } from "@/lib/hooks";
import { api } from "@/lib/api";
import type { ProjectProposal, ProjectMilestone, ProjectTask, ProjectPlan, TLItem } from "@/lib/api";
import { prioColor, titleCase } from "@/lib/format";
import { toast } from "sonner";
import { usePlanDraft, EditText, EditDate, EditSelect, RowTools, AddRow, DirtyBar, move, removeAt, patchAt, dateTone, rel, PRIORITY_OPTS } from "@/components/planedit";

const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "milestone";

export const shortDate = (iso?: string | null): string => {
  if (!iso) return "";
  const d = new Date(iso + "T00:00:00");
  if (isNaN(d.getTime())) return iso;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString("en-US", sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
};

/* the dependency options are ordinals, so the tooltip carries the name */
const dependsTitle = (m: ProjectMilestone, ms: ProjectMilestone[]) => {
  const i = ms.findIndex((x) => x.id === (m.dependsOn || [])[0]);
  return i < 0 ? "What this milestone waits on" : `Starts after ${i + 1}. ${ms[i].title || ms[i].id}`;
};

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

export function ProposedProject({ slug, onApproved, onChanged }: {
  slug: string;
  onApproved?: () => void;
  /** saved or dismissed: the strip re-reads the plan list */
  onChanged?: () => void;
}) {
  const p = useApi(() => api.projectProposal(slug), [slug], 60_000);
  const { draft, dirty, edit, settle, revert } = usePlanDraft<ProjectProposal>(p.data);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const [open, setOpen] = useState<string[]>([]);       // expanded milestone ids ("" = loose)
  const [details, setDetails] = useState(false);

  const milestones = useMemo(() => draft?.milestones || [], [draft]);
  const tasks = useMemo(() => draft?.tasks || [], [draft]);

  if (!draft) return <div className="text-[12px] text-muted-foreground py-1">Loading the plan…</div>;
  if (draft.status !== "proposed") return null;

  const isOpen = (id: string) => open.includes(id);
  const flip = (id: string) => setOpen((o) => (o.includes(id) ? o.filter((x) => x !== id) : [...o, id]));
  const expand = (id: string) => setOpen((o) => (o.includes(id) ? o : [...o, id]));

  /* ---------------------------------------------------------------- persistence */
  const payload = (): Partial<ProjectProposal> => ({
    slug, title: draft.title, tag: draft.tag, boardPath: draft.boardPath,
    hardDeadline: draft.hardDeadline, milestones, tasks,
  });

  const save = async () => {
    setSaving(true);
    try {
      settle(await api.saveProject(payload()));
      toast.success("Plan saved — still yours to approve");
      onChanged?.();
    } catch (e) {
      toast.error(`Couldn't save: ${(e as Error).message}`);
    } finally { setSaving(false); }
  };

  const approve = async () => {
    setBusy(true);
    try {
      // an unsaved edit must never be dropped by clicking the primary button
      if (dirty) settle(await api.saveProject(payload()));
      const r = await api.finalizeProject(slug);
      const c = r.committed;
      toast.success(`Plan approved — ${plural(c.cards, "task")} on the board, ${plural(c.goals, "milestone")} tracked`);
      p.reload();
      onApproved?.();
    } catch (e) {
      const msg = (e as Error).message || "";
      if (/no pending|already finaliz/i.test(msg)) {
        toast.info("This project plan is already approved.");
        p.reload();
        onApproved?.();
      } else {
        toast.error(`Couldn't approve: ${msg}`);
      }
    } finally { setBusy(false); }
  };

  const dismiss = async () => {
    setDismissing(true);
    try { await api.dismissProject(slug); toast.success("Plan dismissed — nothing committed"); p.reload(); onChanged?.(); }
    catch (e) { toast.error(`Couldn't dismiss: ${(e as Error).message}`); }
    finally { setDismissing(false); }
  };

  /* ------------------------------------------------------------------- mutation */
  const setMs = (i: number, patch: Partial<ProjectMilestone>) =>
    edit((d) => ({ ...d, milestones: patchAt(d.milestones || [], i, patch) }));
  const addMs = () => {
    let id = `m${milestones.length + 1}`;
    while (milestones.some((m) => m.id === id)) id += "x";
    edit((d) => ({ ...d, milestones: [...(d.milestones || []), { id, title: "New milestone", date: "", hard: false, dependsOn: [], goal: true, calendar: true }] }));
    expand(id);
  };
  const delMs = (i: number) => edit((d) => {
    const gone = (d.milestones || [])[i]?.id;
    return {
      ...d,
      milestones: removeAt(d.milestones || [], i),
      // its sub-tasks survive as loose tasks rather than disappearing with it
      tasks: (d.tasks || []).map((t) => (t.milestone === gone ? { ...t, milestone: undefined } : t)),
    };
  });

  const setTask = (i: number, patch: Partial<ProjectTask>) =>
    edit((d) => ({ ...d, tasks: patchAt(d.tasks || [], i, patch) }));
  const delTask = (i: number) => edit((d) => ({ ...d, tasks: removeAt(d.tasks || [], i) }));
  const addTask = (msId?: string) => {
    edit((d) => ({ ...d, tasks: [...(d.tasks || []), { text: "", milestone: msId, priority: "medium" }] }));
    expand(msId || "");
  };
  const moveTask = (i: number, by: number) =>
    edit((d) => ({ ...d, tasks: move(d.tasks || [], i, by) }));

  /* --------------------------------------------------------------------- layout */
  const byMs = new Map<string, number[]>();
  const loose: number[] = [];
  tasks.forEach((t, i) => {
    const k = t.milestone || "";
    if (k && milestones.some((m) => m.id === k)) {
      if (!byMs.has(k)) byMs.set(k, []);
      byMs.get(k)!.push(i);
    } else loose.push(i);
  });
  const msOptions = [{ value: "", label: "no milestone" },
    ...milestones.map((m) => ({ value: m.id, label: m.title || m.id }))];

  const hd = draft.hardDeadline || {};
  const manual = draft.source === "manual";
  const alerts = draft.alerts || [];
  const taskRows = (ids: number[]) => ids.map((i) => (
    <TaskRow key={i} t={tasks[i]} msOptions={msOptions}
      onPatch={(patch) => setTask(i, patch)} onDelete={() => delTask(i)}
      onUp={() => moveTask(i, -1)} onDown={() => moveTask(i, 1)} />
  ));

  return (
    <Card className="p-4 mb-6 border-primary/40 bg-primary/[0.035]" data-plan-slug={slug}>
      {/* ---- title + final deadline, actions on the right ---------------------- */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            <Target size={15} className="shrink-0 text-primary"
              aria-label={manual ? "Project plan, built here" : "Project plan, suggested by the app"} />
            <h3 className="text-[16px] font-semibold tracking-tight min-w-0 flex-1"
              title={`${manual ? "Built here" : "Suggested by the app"}${draft.editedAt ? " · edited" : ""}`}>
              <EditText value={draft.title || ""} placeholder="Name this project"
                ariaLabel="project title"
                onChange={(v) => edit((d) => ({ ...d, title: v }))} />
            </h3>
          </div>
          <div className="flex items-center gap-x-2.5 gap-y-1 flex-wrap mt-1 pl-[23px] text-[12px] text-muted-foreground">
            <span className="inline-flex items-center gap-1" title={hd.title || "Final deadline"}>
              <EditDate value={hd.date} tone={dateTone(hd.date)} ariaLabel="final deadline"
                onChange={(v) => edit((d) => ({ ...d, hardDeadline: { ...(d.hardDeadline || {}), date: v } }))} />
              {hd.date && <span style={{ color: dateTone(hd.date) }} className="text-[11.5px] nums">{rel(hd.date)}</span>}
            </span>
            <span className="opacity-40" aria-hidden="true">·</span>
            <span className="nums" title="Tasks reach the board only when you approve">
              {plural(milestones.length, "milestone")}, {plural(tasks.length, "task")}
            </span>
            {alerts.length > 0 && (
              <button type="button" title={alerts.join("\n")} aria-label={`${plural(alerts.length, "alert")}: ${alerts.join(" ")}`}
                className="inline-flex items-center gap-1 rounded px-1 -mx-1 text-foreground hover:bg-amber-500/10 transition-colors">
                <CircleAlert size={12} className="text-amber-500" /> {alerts.length} to check
              </button>
            )}
            <button type="button" onClick={() => setDetails((v) => !v)} aria-expanded={details}
              title="Deadline name, tag and tasks with no milestone"
              {...(details ? { "data-knav-back": "2" } : {})}
              className={`inline-flex items-center gap-1 rounded px-1 -mx-1 transition-colors hover:text-foreground hover:bg-muted/60 ${details ? "text-foreground" : ""}`}>
              <SlidersHorizontal size={12} /> Details
            </button>
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0 flex-wrap justify-end">
          <Button variant="ghost" size="sm" onClick={dismiss} disabled={busy || dismissing} className="gap-1.5 text-muted-foreground"
            title="Withdraw this proposal; nothing is committed">
            <X size={14} /> {dismissing ? "Dismissing…" : "Dismiss"}
          </Button>
          <Button size="sm" onClick={approve} disabled={busy || dismissing} className="gap-1.5"
            title="Nothing reaches your board or calendar until you approve">
            <Check size={14} className={busy ? "animate-pulse" : ""} />
            {busy ? "Approving…" : dirty ? "Save and approve" : "Approve"}
          </Button>
        </div>
      </div>

      {/* ---- details: the rarely-touched fields -------------------------------- */}
      {details && (
        <div className="mt-2.5 ml-[23px] rounded-lg border border-border/70 bg-card/60 px-3 py-2 grid gap-1.5 text-[12px]">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="inline-flex items-center gap-1 min-w-[12rem] flex-1">
              <CalendarDays size={12} className="shrink-0 text-muted-foreground" />
              <EditText value={hd.title || ""} placeholder="Deadline name"
                ariaLabel="deadline title" className="text-[12px]"
                onChange={(v) => edit((d) => ({ ...d, hardDeadline: { ...(d.hardDeadline || {}), title: v } }))} />
            </span>
            <span className="inline-flex items-center gap-1 min-w-[8rem]">
              <Hash size={12} className="shrink-0 text-muted-foreground" />
              <EditText value={draft.tag || ""} placeholder="tag" ariaLabel="board tag"
                className="text-[12px]" onChange={(v) => edit((d) => ({ ...d, tag: v.replace(/^#/, "") }))} />
            </span>
          </div>
          <AddRow onClick={() => addTask(undefined)}>Add a task with no milestone</AddRow>
        </div>
      )}

      {/* ---- one line per milestone; each expands into its editor ---------------- */}
      <div className="mt-3 grid grid-cols-1">
        {milestones.map((m, mi) => {
          const ids = byMs.get(m.id) || [];
          const on = isOpen(m.id);
          return (
            <div key={m.id} className="border-t border-border/50 first:border-t-0">
              <button type="button" onClick={() => flip(m.id)} aria-expanded={on}
                data-knav-id={`plan-ms-${slug}-${m.id}`}
                {...(on ? { "data-knav-back": "2" } : {})}
                title={`${m.hard ? "Fixed date" : "Soft date"}${m.date ? ` · ${rel(m.date)}` : ""}${(m.dependsOn || []).length ? ` · ${dependsTitle(m, milestones)}` : ""}`}
                className="w-full min-w-0 flex items-center gap-2 py-1.5 text-left rounded hover:bg-muted/40 transition-colors">
                {on ? <ChevronDown size={13} className="shrink-0 text-muted-foreground" /> : <ChevronRight size={13} className="shrink-0 text-muted-foreground" />}
                <span className="shrink-0 w-[4.25rem] text-[12.5px] nums" style={{ color: m.date ? dateTone(m.date) : undefined }}>
                  {m.date ? shortDate(m.date) : <span className="text-muted-foreground/60">no date</span>}
                </span>
                <span aria-hidden="true"
                  className={`shrink-0 h-2 w-2 rotate-45 ${m.hard ? "bg-[hsl(12_60%_50%)]" : "border border-muted-foreground/60"}`} />
                <span className="flex-1 min-w-0 truncate text-[13.5px] font-medium">{m.title || m.id}</span>
                <span className="shrink-0 text-[11.5px] text-muted-foreground nums">{plural(ids.length, "task")}</span>
              </button>
              {on && (
                <div className="ml-[21px] pl-3 mb-2 border-l border-border/60">
                  <div className="group flex items-baseline gap-2 flex-wrap py-0.5">
                    <span className="flex-1 min-w-[10rem] max-w-[18rem]">
                      <EditText value={m.title || ""} placeholder="Milestone" ariaLabel="milestone title"
                        className="text-[13px] font-semibold leading-snug"
                        onChange={(v) => setMs(mi, { title: v, id: m.id || slugify(v) })} />
                    </span>
                    <EditDate value={m.date} tone={dateTone(m.date)} ariaLabel={`${m.title} date`}
                      onChange={(v) => setMs(mi, { date: v })} />
                    <button type="button" onClick={() => setMs(mi, { hard: !m.hard })}
                      title={m.hard ? "A fixed date — the scheduler never moves it" : "A soft date you can move"}
                      className={`text-[10px] uppercase tracking-wide font-semibold rounded px-1.5 py-0.5 border transition-colors
                        ${m.hard ? "text-primary border-primary/40 bg-primary/10" : "text-muted-foreground border-transparent hover:border-border"}`}>
                      {m.hard ? "hard" : "soft"}
                    </button>
                    <EditSelect value={(m.dependsOn || [])[0] || ""} ariaLabel="depends on"
                      title={dependsTitle(m, milestones)}
                      options={[{ value: "", label: "no dependency" },
                        ...milestones.map((x, xi) => ({ x, xi })).filter(({ x }) => x.id !== m.id)
                          .map(({ x, xi }) => ({ value: x.id, label: `after ${xi + 1}` }))]}
                      onChange={(v) => setMs(mi, { dependsOn: v ? [v] : [] })}
                      className="text-muted-foreground" />
                    <span className="ml-auto shrink-0">
                      <RowTools label="milestone"
                        onUp={mi > 0 ? () => edit((d) => ({ ...d, milestones: move(d.milestones || [], mi, -1) })) : undefined}
                        onDown={mi < milestones.length - 1 ? () => edit((d) => ({ ...d, milestones: move(d.milestones || [], mi, 1) })) : undefined}
                        onDelete={() => delMs(mi)} />
                    </span>
                  </div>
                  {taskRows(ids)}
                  <AddRow onClick={() => addTask(m.id)}>Add a task</AddRow>
                </div>
              )}
            </div>
          );
        })}
        {loose.length > 0 && (
          <div className="border-t border-border/50">
            <button type="button" onClick={() => flip("")} aria-expanded={isOpen("")}
              data-knav-id={`plan-ms-${slug}-loose`}
              {...(isOpen("") ? { "data-knav-back": "2" } : {})}
              title="Tasks not attached to a milestone"
              className="w-full min-w-0 flex items-center gap-2 py-1.5 text-left rounded hover:bg-muted/40 transition-colors">
              {isOpen("") ? <ChevronDown size={13} className="shrink-0 text-muted-foreground" /> : <ChevronRight size={13} className="shrink-0 text-muted-foreground" />}
              <span className="shrink-0 w-[4.25rem]" />
              <span className="shrink-0 h-2 w-2" />
              <span className="flex-1 min-w-0 truncate text-[13px] text-muted-foreground">No milestone</span>
              <span className="shrink-0 text-[11.5px] text-muted-foreground nums">{plural(loose.length, "task")}</span>
            </button>
            {isOpen("") && (
              <div className="ml-[21px] pl-3 mb-2 border-l border-border/60">
                {taskRows(loose)}
                <AddRow onClick={() => addTask(undefined)}>Add a task</AddRow>
              </div>
            )}
          </div>
        )}
      </div>
      <AddRow onClick={addMs}>Add a milestone</AddRow>

      <DirtyBar dirty={dirty} saving={saving} onSave={save} onRevert={revert} />
    </Card>
  );
}

/* ---------------------------------------------------------- an approved plan */

const MASTER_BOARD = TASKS_BOARD;

export function ApprovedProject({ plan, items, openBoard, onArchived }: {
  plan: ProjectPlan;
  items: TLItem[];
  openBoard: (path: string, title: string, isPaper: boolean) => void;
  onArchived: () => void;
}) {
  const [details, setDetails] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const slug = plan.slug || "";
  const ms = plan.milestones || [];
  const past = (m: ProjectMilestone) => (!!m.date && m.date < todayIso) || m.status === "done";
  const done = ms.filter(past).length;
  const next = ms.find((m) => !past(m) && m.date);
  const pct = ms.length ? Math.round((100 * done) / ms.length) : 0;
  const hd = plan.hardDeadline || {};
  const board = plan.boardPath || MASTER_BOARD;
  const tag = (plan.tag || "").toLowerCase().replace(/^#/, "");
  const actions = tag ? items.filter((i) => i.due >= todayIso && i.text.toLowerCase().includes("#" + tag)).slice(0, 3) : [];

  const archive = async () => {
    if (!window.confirm(`Archive "${plan.title}"? Its milestones leave the calendar; the chain moves to Insights → Archive.`)) return;
    setArchiving(true);
    try {
      const r = await api.archiveProject(slug);
      if (r.ok) { toast.success("Project archived — its record lives in Insights → Archive"); onArchived(); }
      else toast.error(r.error || "Couldn't archive the project plan");
    } catch { toast.error("Couldn't archive the project plan"); }
    finally { setArchiving(false); }
  };

  return (
    <Card className="p-4 border-primary/40 bg-primary/[0.035]" data-plan-slug={slug} data-plan-status="finalized">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            <Target size={15} className="shrink-0 text-primary" aria-label="Approved project plan" />
            <h3 className="text-[16px] font-semibold tracking-tight min-w-0 flex-1 truncate" title={plan.title}>{plan.title}</h3>
          </div>
          <div className="flex items-center gap-x-2.5 gap-y-1 flex-wrap mt-1 pl-[23px] text-[12px] text-muted-foreground">
            {hd.date && (
              <span className="nums" title={hd.title || "Final deadline"} style={{ color: dateTone(hd.date) }}>
                {shortDate(hd.date)} · {rel(hd.date)}
              </span>
            )}
            <span className="opacity-40" aria-hidden="true">·</span>
            <span className="inline-flex items-center gap-1.5 nums" title={`${done} of ${ms.length} milestones done`}>
              <span className="w-16 h-1.5 rounded-full bg-secondary overflow-hidden">
                <span className="block h-full rounded-full bg-primary/70" style={{ width: `${pct}%` }} />
              </span>
              {done}/{ms.length}
            </span>
            {next && (
              <>
                <span className="opacity-40" aria-hidden="true">·</span>
                <span className="truncate" title={`Next: ${next.title} · ${next.date}`}>next: {next.title} · {rel(next.date)}</span>
              </>
            )}
            <button type="button" onClick={() => setDetails((v) => !v)} aria-expanded={details}
              title="Tag and archive"
              {...(details ? { "data-knav-back": "2" } : {})}
              className={`inline-flex items-center gap-1 rounded px-1 -mx-1 transition-colors hover:text-foreground hover:bg-muted/60 ${details ? "text-foreground" : ""}`}>
              <SlidersHorizontal size={12} /> Details
            </button>
          </div>
        </div>
        <Button variant="outline" size="sm" className="gap-1.5 shrink-0"
          onClick={() => openBoard(board, titleCase(plan.title || slug), board !== MASTER_BOARD)} title="Open the board">
          <ArrowUpRight size={13} /> Board
        </Button>
      </div>

      {details && (
        <div className="mt-2.5 ml-[23px] rounded-lg border border-border/70 bg-card/60 px-3 py-2 flex items-center gap-3 flex-wrap text-[12px]">
          {tag && <span className="inline-flex items-center gap-1 text-muted-foreground" title="Board tag"><Hash size={12} /> {tag}</span>}
          <Button variant="ghost" size="sm" onClick={archive} disabled={archiving}
            className="gap-1.5 ml-auto text-muted-foreground" title="Take this plan off the calendar; the chain moves to Insights → Archive">
            <Archive size={13} /> {archiving ? "Archiving…" : "Archive"}
          </Button>
        </div>
      )}

      <div className="mt-3 grid grid-cols-1 gap-0.5">
        {ms.map((m) => {
          const gone = past(m);
          return (
            <div key={m.id} className="flex items-center gap-2 py-1 text-[13px] min-w-0 border-t border-border/50 first:border-t-0"
              title={`${m.hard ? "Fixed date" : "Soft date"}${m.date ? ` · ${rel(m.date)}` : ""}`}>
              <span className="shrink-0 w-[4.25rem] text-[12.5px] nums" style={{ color: m.date && !gone ? dateTone(m.date) : undefined }}>
                {m.date ? shortDate(m.date) : ""}
              </span>
              <span aria-hidden="true"
                className={`shrink-0 h-2 w-2 rotate-45 ${gone ? "bg-[hsl(152_30%_44%)]" : m.hard ? "bg-[hsl(12_60%_50%)]" : "border border-muted-foreground/60"}`} />
              <span className={`flex-1 min-w-0 truncate ${gone ? "text-muted-foreground line-through decoration-muted-foreground/40" : "font-medium"}`}>{m.title || m.id}</span>
            </div>
          );
        })}
      </div>

      {actions.length > 0 && (
        <div className="mt-2 pt-2 border-t border-border/50 grid gap-0.5" title={`Next dated cards tagged #${tag}`}>
          {actions.map((i) => (
            <div key={i.raw || i.text} className="flex items-center gap-2 text-[12.5px] text-muted-foreground min-w-0">
              <span className="h-1.5 w-1.5 rounded-full shrink-0" style={{ background: prioColor(i.priority) }} />
              <span className="truncate flex-1">{i.text}</span>
              <span className="text-[11px] nums shrink-0">{shortDate(i.due)}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------- a task row */

function TaskRow({ t, msOptions, onPatch, onDelete, onUp, onDown }: {
  t: ProjectTask; msOptions: { value: string; label: string }[];
  onPatch: (p: Partial<ProjectTask>) => void;
  onDelete: () => void; onUp: () => void; onDown: () => void;
}) {
  return (
    <div className="group flex items-start gap-1.5 py-0.5 border-b border-border/40 last:border-0 flex-wrap">
      <span className="flex-1 min-w-[10rem]">
        <EditText value={t.text || ""} placeholder="What is the task?" ariaLabel="task text"
          className="text-[12.5px] leading-snug" multiline
          onChange={(v) => onPatch({ text: v })} />
      </span>
      <EditSelect value={t.priority || ""} options={PRIORITY_OPTS} ariaLabel="priority"
        onChange={(v) => onPatch({ priority: (v || undefined) as ProjectTask["priority"] })}
        className={t.priority === "high" ? "text-primary font-semibold" : "text-muted-foreground"} />
      <span className="w-[3.5rem] shrink-0">
        <EditText value={t.est || ""} placeholder="est" ariaLabel="estimate"
          className="text-[11.5px] text-muted-foreground" onChange={(v) => onPatch({ est: v })} />
      </span>
      <EditSelect value={t.milestone || ""} options={msOptions} ariaLabel="milestone"
        onChange={(v) => onPatch({ milestone: v || undefined })} className="text-muted-foreground max-w-[8rem]" />
      <EditDate value={t.due} tone={dateTone(t.due)} ariaLabel="due date"
        onChange={(v) => onPatch({ due: v })} />
      <RowTools label="task" onUp={onUp} onDown={onDown} onDelete={onDelete} />
    </div>
  );
}

/* ----------------------------------------------------- start a plan, no agent */

export function StartPlan({ onCreated, onCancel }: {
  onCreated: (slug?: string) => void;
  onCancel?: () => void;
}) {
  const [title, setTitle] = useState("");
  const [date, setDate] = useState("");
  const [busy, setBusy] = useState(false);

  const create = async () => {
    if (!title.trim()) { toast.error("Give the project a name first"); return; }
    setBusy(true);
    try {
      const r = await api.newProject({
        title: title.trim(),
        hardDeadline: { date: date || null, title: `${title.trim()} due` },
        milestones: [], tasks: [],
      });
      toast.success("Plan started — add milestones and tasks, then approve when it's right");
      setTitle(""); setDate("");
      onCreated(r.slug);
    } catch (e) {
      toast.error(`Couldn't start the plan: ${(e as Error).message}`);
    } finally { setBusy(false); }
  };

  return (
    <Card className="p-4 mb-6 border-primary/40 bg-primary/[0.035]">
      <div className="flex items-center gap-2 text-[12px] text-primary uppercase tracking-[0.1em] font-semibold mb-3 w-fit"
        title="You'll get an empty chain to fill in — milestones, dependencies and dated sub-tasks — and nothing commits until you approve it.">
        <Target size={14} /> Start a project plan
      </div>
      <div className="flex items-end gap-3 flex-wrap">
        <label className="flex-1 min-w-[16rem]">
          <div className="text-[11px] uppercase tracking-[0.09em] text-muted-foreground mb-1">What are you planning?</div>
          <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.defaultPrevented) return;
              const armed = e.currentTarget.hasAttribute("data-knav-armed");
              if (e.key === "Enter" && !armed) { e.preventDefault(); create(); }
              // a blank or armed title closes; mid-typing, the first Escape only stops editing
              if (e.key === "Escape" && (armed || !title)) { e.preventDefault(); onCancel?.(); }
            }}
            placeholder="Dissertation proposal"
            className="w-full rounded border border-border bg-background px-2 py-1.5 text-[13px]
                       focus:outline-none focus:ring-1 focus:ring-primary/50 focus:border-primary/50" />
        </label>
        <label>
          <div className="text-[11px] uppercase tracking-[0.09em] text-muted-foreground mb-1">Due</div>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
            className="rounded border border-border bg-background px-2 py-1.5 text-[13px] nums
                       focus:outline-none focus:ring-1 focus:ring-primary/50 focus:border-primary/50" />
        </label>
        <Button onClick={create} disabled={busy} className="gap-1.5">
          <Check size={14} /> {busy ? "Starting…" : "Start"}
        </Button>
        {onCancel && (
          <Button variant="ghost" onClick={onCancel} disabled={busy} className="text-muted-foreground" data-knav-back="2">
            Cancel
          </Button>
        )}
      </div>
    </Card>
  );
}
