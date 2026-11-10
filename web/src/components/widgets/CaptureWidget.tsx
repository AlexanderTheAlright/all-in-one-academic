
import { TASKS_BOARD } from "@/lib/paths";
import { useEffect, useRef, useState } from "react";
import { Send } from "lucide-react";
import { api } from "@/lib/api";
import { usePersistent } from "@/lib/hooks";
import { BTN_PRIMARY, WidgetColumn } from "./frame";

type Kind = "note" | "task";
const TASKS = TASKS_BOARD;

export function CaptureWidget() {
  const [kindRaw, setKind] = usePersistent<Kind>("board-widget-capture-kind", "note");
  const kind: Kind = kindRaw === "task" ? "task" : "note";
  const [text, setText] = usePersistent<string>("board-widget-capture-draft", "");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const body = (typeof text === "string" ? text : "").trim();

  useEffect(() => {
    const on = () => {
      const a = document.activeElement;
      if (!a || a === document.body) box.current?.focus();
    };
    window.addEventListener("focus", on);
    return () => window.removeEventListener("focus", on);
  }, []);

  const file = async () => {
    if (!body || saving) return;
    setSaving(true);
    setStatus(null);
    try {
      if (kind === "note") {
        const r = await api.noteCapture(body);
        setStatus({ ok: true, text: typeof r?.inbox === "number" ? `Filed · ${r.inbox} in the notes inbox` : "Filed" });
      } else {
        await api.boardOp(TASKS, "add", { lane: "INBOX", text: body.replace(/\s*\n+\s*/g, " ") });
        setStatus({ ok: true, text: "Added to INBOX" });
      }
      setText("");
    } catch {
      setStatus({ ok: false, text: kind === "note" ? "Couldn't capture, the draft is kept" : "Couldn't add, the draft is kept" });
    } finally {
      setSaving(false);
      box.current?.focus();
    }
  };

  const pick = (k: Kind) => (
    <button role="radio" aria-checked={kind === k} data-capture-kind={k} onClick={() => setKind(k)}
      className={"rounded-full px-3 py-1 text-[12px] normal-case tracking-normal transition-colors "
        + (kind === k ? "bg-secondary text-foreground font-medium" : "text-muted-foreground hover:text-foreground")}>
      {k === "note" ? "Note" : "Task"}
    </button>
  );

  return (
    <WidgetColumn label="Capture"
      hint={kind === "task" ? "Enter adds to INBOX · Esc stops editing, then closes"
        : "Ctrl+Enter files to the notes inbox · Esc stops editing, then closes"}
      meta={<div role="radiogroup" aria-label="File as" className="flex items-center gap-1">{pick("note")}{pick("task")}</div>}>
      {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
      <textarea ref={box} autoFocus value={typeof text === "string" ? text : ""}
        aria-label={kind === "note" ? "Note" : "Task"}
        onChange={(e) => { setText(e.target.value); if (status) setStatus(null); }}
        onKeyDown={(e) => {
          if (e.key !== "Enter" || e.shiftKey || e.altKey) return;
          if (e.ctrlKey || e.metaKey || kind === "task") { e.preventDefault(); void file(); }
        }}
        placeholder={kind === "note" ? "Note" : "Task"}
        className={"min-h-[120px] w-full flex-1 resize-none rounded-lg border border-border bg-card px-3.5 py-3 "
          + "text-[14px] min-[900px]:text-[16px] leading-relaxed text-foreground outline-none "
          + "placeholder:text-muted-foreground/50 focus:border-primary/60"} />
      <div className="flex shrink-0 items-center justify-between gap-3">
        <span aria-live="polite" data-capture-status={status ? (status.ok ? "ok" : "error") : ""}
          className={"min-w-0 truncate text-[12px] " + (status && !status.ok ? "text-destructive" : "text-muted-foreground")}>
          {status?.text ?? ""}
        </span>
        <button onClick={() => void file()} disabled={!body || saving} data-capture-file className={BTN_PRIMARY + " shrink-0"}>
          <Send size={14} /> {saving ? "Filing" : kind === "note" ? "File note" : "Add task"}
        </button>
      </div>
    </WidgetColumn>
  );
}
