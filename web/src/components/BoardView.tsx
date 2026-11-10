/* Single-board view (drill-down). Uses KanbanBoard. */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ChevronLeft, ExternalLink, FileText, Map as MapIcon, ListTodo, Pin, PinOff, Plus } from "lucide-react";
import { api } from "@/lib/api";
import type { Board, KCard } from "@/lib/api";
import { paperDir, parseDate, parseEst, fmtEst } from "@/lib/format";
import { useApi } from "@/lib/hooks";
import { toast } from "sonner";
import { BookMarked } from "lucide-react";
import { KanbanBoard } from "@/components/KanbanBoard";
import { SkelBoard } from "@/components/Skeletons";
import { WidgetFrame } from "@/components/ui/widget";

export type BoardRoute = { path: string; title: string; subtitle?: string; isPaper: boolean };

type FStatus = "all" | "high" | "overdue" | "soon";

const norm = (s: string) => s.toLowerCase().replace(/\s*[—-]\s*20\d{2}-\d{2}-\d{2}\s*$/, "").replace(/[^a-z0-9]/g, "");

function dueOf(c: KCard): string | null {
  const m = c.text.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  return c.due || (m ? m[1] : null);
}

export function BoardView({ route, back, isPinned, togglePin, onOpenReading }:
  { route: BoardRoute; back: () => void; isPinned: boolean; togglePin: () => void; onOpenReading: (listName: string) => void }) {
  const [board, setBoard] = useState<Board | null>(null);
  const [fStatus, setFStatus] = useState<FStatus>("all");
  const [fTag, setFTag] = useState<string | null>(null);
  const [quick, setQuick] = useState("");
  const load = useCallback(() => {
    api.board(route.path).then(setBoard).catch(() => setBoard({ lanes: [], error: "load failed" }));
  }, [route.path]);
  useEffect(() => { setBoard(null); setFStatus("all"); setFTag(null); load(); }, [load]);
  useEffect(() => {
    const h = () => load();
    window.addEventListener("focus", h);
    return () => window.removeEventListener("focus", h);
  }, [load]);
  // Escape navigates back, once menus, fields and the card you stand
  // inside have had their say (the arrow engine steps out of a card first)
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)
        && !t.hasAttribute("data-knav-armed")) return;   // the first Escape only stops typing
      if (t?.closest?.("[data-kcard]") && !t.hasAttribute("data-kcard")) return;
      if (t?.closest?.("[role=dialog], [role=alertdialog], [role=menu], [role=listbox]")) return;
      // inside the board widget (or its focused view) esc rises through the widget first
      if (t?.closest?.("[data-knav-widget]") || document.querySelector("[data-knav-focused]")) return;
      e.preventDefault(); back();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [back]);

  // small stat strip (no extra fetches; uses the same `board` object)
  const stats = useMemo(() => {
    if (!board) return null;
    let open = 0, done = 0, overdue = 0, soon = 0, effort = 0;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    for (const l of board.lanes) for (const c of l.cards) {
      if (c.done) { done++; continue; }
      open++;
      effort += c.est ?? parseEst(c.raw) ?? 0;
      const m = c.text.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
      const due = c.due || (m ? m[1] : null);
      const d = due ? parseDate(due) : null;
      if (d && +d < +today) overdue++;
      else if (d && (+d - +today) / 86400000 <= 7) soon++;
    }
    return { open, done, overdue, soon, effort, total: open + done };
  }, [board]);

  // tags present on this board, for the tag filter
  const tags = useMemo(() => {
    if (!board) return [];
    const s = new Set<string>();
    for (const l of board.lanes) for (const c of l.cards) c.tags.forEach((t) => s.add(t));
    return [...s].sort();
  }, [board]);

  // reading list whose name matches this paper (only for paper boards)
  const reading = useApi(() => api.reading(), [route.isPaper]);
  const readingLink = useMemo(() => {
    if (!route.isPaper || !reading.data) return null;
    const bn = norm(route.title);
    const l = reading.data.lists.find((x) => { const ln = norm(x.name); return ln.includes(bn) || bn.includes(ln); });
    if (!l) return null;
    return { name: l.name, read: l.read, total: l.total };
  }, [reading.data, route.isPaper, route.title]);

  // filter predicate passed to KanbanBoard (render/keyboard only; ops use full board)
  const filterActive = fStatus !== "all" || fTag !== null;
  const match = useCallback((c: KCard) => {
    if (fTag && !c.tags.includes(fTag)) return false;
    if (fStatus === "all") return true;
    if (fStatus === "high") return c.priority === "high";
    const due = dueOf(c);
    if (!due) return false;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const d = parseDate(due); if (!d) return false;
    const days = (+d - +today) / 86400000;
    if (fStatus === "overdue") return days < 0;
    if (fStatus === "soon") return days >= 0 && days <= 7;
    return true;
  }, [fStatus, fTag]);

  const visibleCount = useMemo(() => {
    if (!board || !filterActive) return null;
    let n = 0; for (const l of board.lanes) for (const c of l.cards) if (match(c)) n++;
    return n;
  }, [board, match, filterActive]);

  const open = (file: string, label: string) => { api.open(file); toast("Opened in Obsidian", { description: label }); };

  const quickAdd = async () => {
    const text = quick.trim();
    if (!text || !board) return;
    const lane = board.lanes[0]?.name || "INBOX";
    setQuick("");
    try { setBoard(await api.boardOp(route.path, "add", { lane, text })); toast("Added to " + lane, { description: text.slice(0, 60) }); }
    catch { toast.error("Couldn't add"); load(); }
  };

  const hub: [string, string, ReactNode][] = !route.isPaper ? [] : (() => {
    const dir = paperDir(route.path);
    return [
      ["README", dir + "/README.md", <FileText size={13} key="r" />],
      ["Plan",   dir + "/PLAN.md",   <ListTodo size={13} key="p" />],
      ["Map",    dir + "/MAP.canvas", <MapIcon size={13} key="m" />],
    ];
  })();

  return (
    <div>
      <div className="flex items-center gap-2 text-[13px] text-muted-foreground mb-3">
        <button type="button" onClick={back} data-knav-back className="flex items-center gap-1 hover:text-foreground transition-colors">
          <ChevronLeft size={15} /> Back
        </button>
        <span>/</span><span className="text-foreground capitalize">{route.title}</span>
      </div>
      <div className="flex items-end justify-between mb-4 gap-4 flex-wrap">
        <div>
          <h1 className="text-[23px] font-semibold tracking-tight capitalize">{route.title}</h1>
          <div className="flex items-center flex-wrap gap-x-3 gap-y-1 text-[12px] text-muted-foreground mt-1 nums">
            {route.subtitle && <span>{route.subtitle}</span>}
            {stats && (
              <>
                <span className="opacity-50">·</span>
                <span><span className="text-foreground font-medium">{stats.open}</span> open</span>
                <span><span className="text-foreground font-medium">{stats.done}</span> done</span>
                {stats.effort > 0 && <span>≈{fmtEst(stats.effort)} open effort</span>}
                {stats.overdue > 0 && <span className="text-destructive">{stats.overdue} overdue</span>}
                {stats.soon > 0    && <span style={{ color: "hsl(var(--due-soon))" }}>{stats.soon} due in 7d</span>}
                {readingLink && (
                  <button onClick={() => onOpenReading(readingLink.name)}
                    className="inline-flex items-center gap-1.5 text-primary hover:underline">
                    <BookMarked size={12} /> Reading {readingLink.read}/{readingLink.total}
                  </button>
                )}
              </>
            )}
          </div>
        </div>
        <div className="flex items-center flex-wrap gap-2">
          <Button variant="outline" size="sm" className="gap-1.5" onClick={togglePin}
            title={isPinned ? "Unpin from sidebar" : "Pin to sidebar"}>
            {isPinned ? <PinOff size={14} /> : <Pin size={14} />}{isPinned ? "Unpin" : "Pin"}
          </Button>
          {hub.map(([label, file, icon]) => (
            <Button key={label} variant="outline" size="sm" className="gap-1.5" onClick={() => open(file, label)}>
              {icon}{label}
            </Button>
          ))}
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => open(route.path, route.title)}>
            <ExternalLink size={14} /> Board
          </Button>
        </div>
      </div>
      {/* quick capture straight onto the board */}
      {board && !board.error && (
        <div className="flex gap-2 mb-4 max-w-[660px]">
          <Input value={quick} onChange={(e) => setQuick(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") quickAdd(); }}
            placeholder={`Add a task to ${board.lanes[0]?.name || "INBOX"}…   #tag @high @due(2026-06-20) @est(1h)`}
            className="text-[13px] h-9" />
          <Button size="sm" className="gap-1.5 shrink-0 h-9" onClick={quickAdd} disabled={!quick.trim()}>
            <Plus size={14} /> Add
          </Button>
        </div>
      )}

      {/* the board is one widget; its filters travel with it into the focused view */}
      <WidgetFrame id="board.kanban" title={route.title}>
      {board && !board.error && board.lanes.some((l) => l.cards.length > 0) && (
        <div className="flex flex-wrap items-center gap-1.5 mb-3 text-[11.5px]">
          {([["all", "All"], ["high", "High"], ["overdue", "Overdue"], ["soon", "Due ≤7d"]] as [FStatus, string][]).map(([v, label]) => (
            <button key={v} onClick={() => setFStatus(v)}
              className={`px-2.5 py-1 rounded-full border transition-colors ${fStatus === v ? "bg-primary border-primary text-primary-foreground" : "border-border text-muted-foreground hover:text-foreground hover:border-primary/60"}`}>
              {label}
            </button>
          ))}
          {tags.length > 0 && (
            <>
              <span className="w-px h-4 bg-border mx-1" />
              <select value={fTag ?? ""} onChange={(e) => setFTag(e.target.value || null)}
                className="text-[11.5px] bg-card border border-border rounded-full px-2.5 py-1 text-muted-foreground hover:text-foreground hover:border-primary/60 transition-colors outline-none cursor-pointer">
                <option value="">All tags</option>
                {tags.map((t) => <option key={t} value={t}>#{t}</option>)}
              </select>
            </>
          )}
          {filterActive && (
            <>
              <span className="text-muted-foreground nums ml-1">{visibleCount} shown</span>
              <button onClick={() => { setFStatus("all"); setFTag(null); }}
                className="text-muted-foreground hover:text-foreground underline underline-offset-2">clear</button>
            </>
          )}
        </div>
      )}
      {!board ? <SkelBoard />
        : board.error ? <div className="text-muted-foreground py-20 text-center">Board unavailable — is the server running?</div>
          : <KanbanBoard path={route.path} board={board} setBoard={setBoard} match={filterActive ? match : undefined} />}
      </WidgetFrame>
    </div>
  );
}
