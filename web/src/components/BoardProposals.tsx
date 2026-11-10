
import { TASKS_BOARD, boardProjectName } from "@/lib/paths";
import { useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Inbox, Check, X, CornerDownRight } from "lucide-react";
import { useApi } from "@/lib/hooks";
import { api } from "@/lib/api";
import type { BoardProposal } from "@/lib/api";
import { toast } from "sonner";
import { EditText, EditDate, EditSelect, dateTone, PRIORITY_OPTS } from "@/components/planedit";

const boardLabel = (p: string) =>
  p === TASKS_BOARD ? "my board" : boardProjectName(p);

export function BoardProposals({ onAccepted }: { onAccepted?: () => void }) {
  const q = useApi(() => api.boardProposals(), [], 60_000);
  const [edits, setEdits] = useState<Record<string, Partial<BoardProposal>>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const rows = useMemo(() => q.data?.proposals || [], [q.data]);
  if (rows.length === 0) return null;

  const val = <K extends keyof BoardProposal>(r: BoardProposal, k: K): BoardProposal[K] =>
    (k in (edits[r.id] || {}) ? (edits[r.id] as BoardProposal)[k] : r[k]);
  const patch = (id: string, p: Partial<BoardProposal>) =>
    setEdits((e) => ({ ...e, [id]: { ...(e[id] || {}), ...p } }));

  const accept = async (r: BoardProposal) => {
    setBusy(r.id);
    try {
      const res = await api.acceptProposal(r.id, edits[r.id]);
      toast.success(`Added to ${boardLabel(res.board)} · ${res.lane}`);
      setEdits((e) => { const n = { ...e }; delete n[r.id]; return n; });
      q.reload();
      onAccepted?.();
    } catch (e) {
      toast.error(`Couldn't accept: ${(e as Error).message}`);
    } finally { setBusy(null); }
  };

  const reject = async (r: BoardProposal) => {
    setBusy(r.id);
    try {
      await api.rejectProposal(r.id);
      toast.success("Rejected — it won't come back");
      q.reload();
    } catch (e) {
      toast.error(`Couldn't reject: ${(e as Error).message}`);
    } finally { setBusy(null); }
  };

  return (
    <Card className="p-6 mb-6 border-border">
      <div className="flex items-start justify-between gap-4 flex-wrap mb-3">
        <div>
          <div className="flex items-center gap-2 text-[12px] uppercase tracking-[0.1em] font-semibold text-muted-foreground mb-1"
            title="Agents propose cards here instead of writing to your board — edit, then accept or reject each one">
            <Inbox size={14} /> Proposed cards
          </div>
          <h3 className="text-[15px] font-semibold tracking-tight">
            {rows.length} card{rows.length === 1 ? "" : "s"} waiting on you
          </h3>
        </div>
      </div>

      <div className="divide-y divide-border/60">
        {rows.map((r) => (
          <div key={r.id} className="py-3">
            <div className="flex items-start gap-2">
              <span className="flex-1 min-w-0">
                <EditText value={(val(r, "text") as string) || ""} multiline
                  placeholder="What is the task?" ariaLabel="proposed card text"
                  className="text-[13px] leading-snug"
                  onChange={(v) => patch(r.id, { text: v })} />
              </span>
              <div className="flex items-center gap-1.5 shrink-0">
                <Button variant="ghost" size="sm" disabled={busy === r.id}
                  onClick={() => reject(r)} className="gap-1 h-7 text-muted-foreground hover:text-destructive">
                  <X size={13} /> Reject
                </Button>
                <Button size="sm" disabled={busy === r.id} onClick={() => accept(r)} className="gap-1 h-7">
                  <Check size={13} /> {busy === r.id ? "…" : "Accept"}
                </Button>
              </div>
            </div>

            <div className="flex items-center gap-2.5 flex-wrap mt-1.5 ml-0.5">
              <span className="text-[11px] text-muted-foreground/70 inline-flex items-center gap-1">
                <CornerDownRight size={11} /> {boardLabel((val(r, "board") as string) || TASKS_BOARD)}
              </span>
              <EditSelect value={(val(r, "lane") as string) || "BACKLOG"} ariaLabel="lane"
                options={["INBOX", "BACKLOG", "TODAY", "TODO", "DOING"].map((l) => ({ value: l, label: l }))}
                onChange={(v) => patch(r.id, { lane: v })} className="text-muted-foreground" />
              <EditSelect value={(val(r, "priority") as string) || ""} options={PRIORITY_OPTS} ariaLabel="priority"
                onChange={(v) => patch(r.id, { priority: v || null })}
                className={val(r, "priority") === "high" ? "text-primary font-semibold" : "text-muted-foreground"} />
              <EditDate value={val(r, "due") as string} tone={dateTone(val(r, "due") as string)}
                ariaLabel="due date" onChange={(v) => patch(r.id, { due: v })} />
              {r.source && <span className="text-[11px] text-muted-foreground/60">proposed by {r.source}</span>}
              {edits[r.id] && <span className="text-[11px] text-amber-600 dark:text-amber-500">edited</span>}
            </div>

            {r.note && <div className="text-[12px] text-muted-foreground mt-1.5 leading-snug">{r.note}</div>}
          </div>
        ))}
      </div>
    </Card>
  );
}
