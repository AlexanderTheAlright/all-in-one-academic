
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useWidget, rowCap } from "@/components/ui/widget";
import { clearWidgetFocus } from "@/lib/arrownav";
import {
  DndContext, DragOverlay, MouseSensor, TouchSensor, KeyboardSensor,
  useSensor, useSensors, pointerWithin, closestCorners,
} from "@dnd-kit/core";
import type { CollisionDetection, DragEndEvent, DragOverEvent, DragStartEvent, KeyboardCoordinateGetter } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy, arrayMove, sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Pencil, Archive, GripVertical, Plus, Clock, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { Board, KCard } from "@/lib/api";
import { prioColor, relDue, toneColor, tokenize, parseEst, fmtEst } from "@/lib/format";
import { nextWorkday, useOffDays } from "@/lib/workday";
import type { Workday } from "@/lib/workday";

// DOM-side lookups for the board keys: focus lives on real elements, so the lane
// and card a key acts on are read from document.activeElement
const LAYER = "[role=dialog], [role=alertdialog], [role=menu], [role=listbox], [data-radix-popper-content-wrapper]";

const collide: CollisionDetection = (args) => (args.pointerCoordinates ? pointerWithin(args) : closestCorners(args));
const laneEls = (root: HTMLElement) => Array.from(root.querySelectorAll<HTMLElement>("[data-lane-col]"));
const cardEls = (lane: HTMLElement | undefined) => lane ? Array.from(lane.querySelectorAll<HTMLElement>("[data-kcard]")) : [];
const isTyping = (el: HTMLElement) => /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable;

function posOf(root: HTMLElement, el: EventTarget | null): { lane: number; idx: number; card: HTMLElement | null } | null {
  const node = el as HTMLElement | null;
  const lane = node?.closest?.("[data-lane-col]") as HTMLElement | null;
  if (!lane || !root.contains(lane)) return null;
  const card = node!.closest("[data-kcard]") as HTMLElement | null;
  return { lane: laneEls(root).indexOf(lane), idx: card ? cardEls(lane).indexOf(card) : -1, card };
}

function focusCard(el: HTMLElement | undefined): boolean {
  if (!el) return false;
  document.documentElement.setAttribute("data-knav", "");   // the keyboard is driving: show the ring
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: "nearest", inline: "nearest" });
  return true;
}

export function KanbanBoard({ path, board, setBoard, match }:
{ path: string; board: Board; setBoard: (b: Board) => void; match?: (c: KCard) => boolean }) {
  const [activeRaw, setActiveRaw] = useState<string | null>(null);
  const originalLane = useRef<string | null>(null);

  const vlanes = useMemo(
    () => board.lanes.map((l) => ({ name: l.name, cards: match ? l.cards.filter(match) : l.cards })),
    [board, match]
  );

  // controlled popovers (so keys can open them) + where keyboard focus last stood
  const [editingRaw, setEditingRaw] = useState<string | null>(null);
  const [addingLane, setAddingLane] = useState<string | null>(null);
  const lanesRef = useRef<HTMLDivElement>(null);
  const lastPos = useRef<{ lane: number; idx: number } | null>(null);
  // a quarter-sized tile summarises (lane counts, top cards); md and up, and the
  // focused view, are the full board with every key
  const w = useWidget();
  const compact = !!w && !w.focused && (w.size === "xs" || w.size === "sm");

  // server-authoritative optimistic helper
  const run = useCallback(async (mutate: (b: Board) => Board, op: string, body: unknown) => {
    const optimistic = mutate(structuredClone(board));
    setBoard(optimistic);
    try { setBoard(await api.boardOp(path, op, body)); }
    catch { api.board(path).then(setBoard).catch(() => {}); toast.error("Couldn't save that change"); }
  }, [board, path, setBoard]);

  const toggle = useCallback((raw: string) => run((b) => {
    for (const l of b.lanes) for (const c of l.cards) if (c.raw === raw) c.done = !c.done;
    return b;
  }, "toggle", { raw }), [run]);

  const add = (lane: string, text: string) => run((b) => {
    const L = b.lanes.find((l) => l.name === lane);
    if (L) L.cards.push({ raw: "- [ ] " + text, text: text.replace(/(#\S+|@\S+)/g, "").trim(), done: false, tags: [], priority: null, due: null });
    return b;
  }, "add", { lane, text });

  const archive = (raw: string) => run((b) => {
    for (const l of b.lanes) l.cards = l.cards.filter((c) => c.raw !== raw);
    return b;
  }, "archive", { raw });

  // bulk-archive every done card in a lane, in one server op (-> ## Archive)
  const archiveDone = (lane: string) => run((b) => {
    const L = b.lanes.find((l) => l.name === lane);
    if (L) L.cards = L.cards.filter((c) => !c.done);
    return b;
  }, "archive_done", { lane });

  // board-level: archive every crossed-off [x] card across ALL lanes in one op
  const archiveDoneAll = () => run((b) => {
    for (const l of b.lanes) l.cards = l.cards.filter((c) => !c.done);
    return b;
  }, "archive_done", {});   // no lane -> kanban.archive_done(text, None) = all lanes

  // board-level: sweep the whole DONE column into Archive regardless of [x]
  // (project boards mark done by column position, not checkbox). Confirm first.
  const clearDone = () => {
    const L = board.lanes.find((l) => l.name.toUpperCase() === "DONE");
    if (!L || L.cards.length === 0) return;
    if (!window.confirm(`Archive all ${L.cards.length} card(s) in the DONE column? They move to Archive (nothing is deleted).`)) return;
    run((b) => { const d = b.lanes.find((l) => l.name.toUpperCase() === "DONE"); if (d) d.cards = []; return b; }, "archive_lane", { lane: L.name });
  };

  // permanently delete a card (NOT moved to Archive; whole-file backup kept server-side)
  const del = (raw: string) => run((b) => {
    for (const l of b.lanes) l.cards = l.cards.filter((c) => c.raw !== raw);
    return b;
  }, "delete", { raw });

  const edit = (raw: string, body: string) => run((b) => {
    for (const l of b.lanes) for (const c of l.cards) if (c.raw === raw) c.text = body.replace(/(#\S+|@\S+)/g, "").trim();
    return b;
  }, "edit", { raw, body });

  const snooze = (raw: string, daysFromToday: number) => {
    const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + daysFromToday);
    const iso = d.toISOString().slice(0, 10);
    const m = raw.match(/^(\s*)-\s*\[[ xX]\]\s*(.*)$/);
    if (!m) return;
    let body = m[2].replace(/\s*@due[\(\{][^)\}]+[\)\}]/g, "").replace(/\b20\d{2}-\d{2}-\d{2}\b/g, "").trim();
    body = `${body} @due(${iso})`.replace(/\s+/g, " ").trim();
    run((b) => { for (const l of b.lanes) for (const c of l.cards) if (c.raw === raw) c.due = iso; return b; }, "edit", { raw, body });
  };

  const cyclePriority = useCallback((raw: string) => {
    const m = raw.match(/^(\s*)-\s*\[[ xX]\]\s*(.*)$/);
    if (!m) return;
    let body = m[2].replace(/\s*@(high|medium|low)\b/i, "").trim();
    const cur = (m[2].match(/@(high|medium|low)\b/i) || [, ""])[1].toLowerCase();
    const next: Record<string, string | null> = { high: "medium", medium: "low", low: "", "": "high" };
    const tag = next[cur] ?? "high";
    body = (tag ? `${body} @${tag}` : body).replace(/\s+/g, " ").trim();
    run((b) => { for (const l of b.lanes) for (const c of l.cards) if (c.raw === raw) c.priority = tag || null; return b; }, "edit", { raw, body });
  }, [run]);

  // keyboard move: append the card to the end of an adjacent lane
  const moveLane = useCallback((raw: string, fromName: string, toName: string) => {
    run((b) => {
      const src = b.lanes.find((l) => l.name === fromName);
      const dst = b.lanes.find((l) => l.name === toName);
      if (!src || !dst) return b;
      const i = src.cards.findIndex((c) => c.raw === raw);
      if (i < 0) return b;
      const [card] = src.cards.splice(i, 1);
      dst.cards.push(card);
      return b;
    }, "move", { raw, from: fromName, to: toName, index: 99999 });
  }, [run]);

  // a card that re-renders under a new key (ticked, re-prioritised, moved, saved)
  // drops DOM focus: put the keyboard back where it stood
  useEffect(() => {
    const root = lanesRef.current, p = lastPos.current;
    if (!root || !p || !document.documentElement.hasAttribute("data-knav")) return;
    const a = document.activeElement;
    if (a && a !== document.body) return;
    const list = cardEls(laneEls(root)[p.lane]);
    focusCard(list[Math.min(p.idx, list.length - 1)]);
  }, [vlanes]);

  // board keys. The arrows are the engine's; these act on the card holding focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const root = lanesRef.current;
      if (!root || editingRaw || addingLane) return;              // a popover/input owns the keyboard
      const a = document.activeElement as HTMLElement | null;
      const idle = !a || a === document.body;
      if (a && !idle && (isTyping(a) || a.closest(LAYER))) return; // typing, or inside a menu/popover
      const lanes = laneEls(root);
      const pos = idle ? null : posOf(root, a);
      const card = pos?.card ?? null;
      const raw = card?.dataset.kcard ?? null;
      const k = e.key;

      if (k === "j" || k === "k" || k === "h" || k === "l") {
        let target: HTMLElement | undefined;
        if (!pos || !card) {
          // not on a card yet: the first card of this lane, else of the board
          const order = lanes.map((_, i) => i);
          if (pos && pos.lane >= 0) order.unshift(pos.lane);
          for (const li of order) { target = cardEls(lanes[li])[0]; if (target) break; }
        } else if (k === "j" || k === "k") {
          target = cardEls(lanes[pos.lane])[pos.idx + (k === "j" ? 1 : -1)];
        } else {
          const d = k === "l" ? 1 : -1;
          for (let li = pos.lane + d; li >= 0 && li < lanes.length && !target; li += d) {
            const list = cardEls(lanes[li]);
            target = list[Math.min(pos.idx, list.length - 1)];   // empty lanes are skipped
          }
        }
        if (focusCard(target) || card) e.preventDefault();          // at an edge the key is still spent
        return;
      }
      if (k === "n") {
        if (!idle && !pos) return;
        const L = vlanes[pos && pos.lane >= 0 ? pos.lane : 0];
        if (L) { e.preventDefault(); setAddingLane(L.name); }
        return;
      }
      if (!pos || !card || !raw) return;
      if (k === "ArrowLeft" && a === card && !e.shiftKey) {
        let target: HTMLElement | undefined;
        for (let li = pos.lane - 1; li >= 0 && !target; li--) {
          const list = cardEls(lanes[li]);
          target = list[Math.min(pos.idx, list.length - 1)];
        }
        if (target) { focusCard(target); e.preventDefault(); return; }
        const frame = root.closest<HTMLElement>("[data-knav-widget]");
        if (!frame) return;
        e.preventDefault();
        if (frame.hasAttribute("data-knav-focused")) clearWidgetFocus();
        document.documentElement.setAttribute("data-knav", "");
        frame.focus({ preventScroll: true });
        return;
      }
      if (k === "Enter") {
        if (a !== card || e.shiftKey) return;                       // a control inside the card presses itself
        e.preventDefault(); setEditingRaw(raw);
        return;
      }
      switch (k) {
        case "x": e.preventDefault(); toggle(raw); break;
        case "e": e.preventDefault(); setEditingRaw(raw); break;
        case "c": e.preventDefault(); cyclePriority(raw); break;
        case "[": case "]": {
          const to = pos.lane + (k === "]" ? 1 : -1);
          if (to < 0 || to >= vlanes.length) return;
          e.preventDefault();
          lastPos.current = { lane: to, idx: cardEls(lanes[to]).length };   // it lands at the end
          moveLane(raw, vlanes[pos.lane].name, vlanes[to].name);
          break;
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [vlanes, editingRaw, addingLane, toggle, cyclePriority, moveLane]);

  const boardRef = useRef(board);
  useEffect(() => { boardRef.current = board; }, [board]);
  const carry = useCallback<KeyboardCoordinateGetter>((event, args) => {
    const right = event.code === "ArrowRight";
    if (right || event.code === "ArrowLeft") {
      const lanes = boardRef.current.lanes;
      const at = lanes.findIndex((l) => l.cards.some((c) => c.raw === String(args.active)));
      const to = at >= 0 ? lanes[at + (right ? 1 : -1)] : undefined;
      event.preventDefault();
      const rect = to ? args.context.droppableRects.get("lane:" + to.name) : undefined;
      return rect ? { x: rect.left, y: rect.top } : undefined;
    }
    return sortableKeyboardCoordinates(event, args);
  }, []);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: carry,
      keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space"] },
    }),
  );
  const laneOfRaw = useCallback((raw: string) =>
    board.lanes.find((l) => l.cards.some((c) => c.raw === raw))?.name, [board]);

  const onStart = (e: DragStartEvent) => {
    const id = String(e.active.id);
    setActiveRaw(id);
    originalLane.current = laneOfRaw(id) || null;
  };
  const onOver = (e: DragOverEvent) => {
    const overId = String(e.over?.id ?? "");
    const activeId = String(e.active.id);
    if (!overId) return;
    const sourceLane = laneOfRaw(activeId);
    if (!sourceLane) return;
    const overLane = overId.startsWith("lane:") ? overId.slice(5) : laneOfRaw(overId);
    if (!overLane || overLane === sourceLane) return;
    setBoard(structuredClone((() => {
      const b: Board = structuredClone(board);
      const src = b.lanes.find((l) => l.name === sourceLane)!;
      const dst = b.lanes.find((l) => l.name === overLane)!;
      const idx = src.cards.findIndex((c) => c.raw === activeId);
      if (idx < 0) return b;
      const [card] = src.cards.splice(idx, 1);
      dst.cards.push(card);
      return b;
    })()));
  };
  const onEnd = (e: DragEndEvent) => {
    const activeId = String(e.active.id);
    const overId = String(e.over?.id ?? "");
    setActiveRaw(null);
    const startedIn = originalLane.current;
    originalLane.current = null;
    if (!overId || !startedIn) return;
    const toLane = laneOfRaw(activeId) || (overId.startsWith("lane:") ? overId.slice(5) : null);
    if (!toLane) return;
    const dst = board.lanes.find((l) => l.name === toLane);
    if (!dst) return;
    let toIndex = dst.cards.findIndex((c) => c.raw === activeId);
    const overIdx = dst.cards.findIndex((c) => c.raw === overId);
    if (overIdx >= 0) toIndex = overIdx;
    if (toIndex < 0) toIndex = dst.cards.length;
    // a keyboard drop re-renders the card in its new lane: the keyboard follows it there
    lastPos.current = { lane: vlanes.findIndex((l) => l.name === toLane), idx: toIndex };
    if (startedIn === toLane) {
      const src = board.lanes.find((l) => l.name === startedIn);
      if (!src) return;
      const oldIdx = src.cards.findIndex((c) => c.raw === activeId);
      if (oldIdx === toIndex || oldIdx < 0) return;
      const next = structuredClone(board);
      const L = next.lanes.find((l) => l.name === startedIn)!;
      L.cards = arrayMove(L.cards, oldIdx, toIndex);
      setBoard(next);
    }
    run((b) => b, "move", { raw: activeId, from: startedIn, to: toLane, index: toIndex });
  };

  const activeCard = useMemo(
    () => activeRaw ? board.lanes.flatMap((l) => l.cards).find((c) => c.raw === activeRaw) || null : null,
    [activeRaw, board]
  );

  const doneTotal = board.lanes.flatMap((l) => l.cards).filter((c) => c.done).length;
  const doneLaneCount = board.lanes.find((l) => l.name.toUpperCase() === "DONE")?.cards.length ?? 0;

  return (
    <DndContext sensors={sensors} collisionDetection={collide}
      onDragStart={onStart} onDragOver={onOver} onDragEnd={onEnd}>
      {(doneTotal > 0 || doneLaneCount > 0) && (
        <div className="flex items-center gap-2 mb-3 no-print">
          {doneTotal > 0 && (
            <button onClick={archiveDoneAll} title="Move every crossed-off card into Archive"
              className="flex items-center gap-1.5 text-[11.5px] px-2.5 py-1 rounded-md border border-border text-muted-foreground hover:text-foreground hover:border-primary/40 transition-colors">
              <Archive size={12} /> Archive done ({doneTotal})
            </button>
          )}
          {doneLaneCount > 0 && (
            <button onClick={clearDone} title="Move every card in the DONE column into Archive"
              className="flex items-center gap-1.5 text-[11.5px] px-2.5 py-1 rounded-md border border-border text-muted-foreground hover:text-foreground hover:border-primary/40 transition-colors">
              <Archive size={12} /> Clear DONE ({doneLaneCount})
            </button>
          )}
        </div>
      )}
      {compact ? <LaneSummary lanes={vlanes} onToggle={toggle} /> : (<>
      {/* lanes side by side; a focused view on a narrow window (sm/xs: tiles there show the
          summary) stacks them two up or one up, so the lane a card is carried into is on screen */}
      <div ref={lanesRef} className="flex gap-4 overflow-x-auto tinybar pb-3 items-start group-data-[size=sm]/widget:grid group-data-[size=sm]/widget:grid-cols-2 group-data-[size=xs]/widget:grid group-data-[size=xs]/widget:grid-cols-1"
        onFocus={(e) => {
          const p = lanesRef.current ? posOf(lanesRef.current, e.target) : null;
          lastPos.current = p?.card ? { lane: p.lane, idx: p.idx } : null;
        }}>
        {vlanes.map((lane, li) => (
          <LaneCol key={lane.name} lane={lane} laneIndex={li}
            editingRaw={editingRaw} setEditingRaw={setEditingRaw}
            adding={addingLane === lane.name} setAdding={(o) => setAddingLane(o ? lane.name : null)}
            onToggle={toggle} onArchive={archive} onEdit={edit} onDelete={del}
            onAdd={(t) => add(lane.name, t)} onArchiveDone={() => archiveDone(lane.name)}
            onSnooze={snooze} onCyclePriority={cyclePriority} />
        ))}
      </div>
      {/* portaled: a focused widget is itself fixed and scrolls */}
      {createPortal(<DragOverlay dropAnimation={{ duration: 180, easing: "cubic-bezier(.22,1,.36,1)" }}>
        {activeCard && (
          <div style={{ borderLeftColor: prioColor(activeCard.priority), borderLeftWidth: 3 }}
            className="bg-card border border-primary/60 rounded-lg p-2.5 pl-3 shadow-pop rotate-[1.2deg] w-[280px]">
            <div className="text-[13px] leading-snug">{activeCard.text}</div>
          </div>
        )}
      </DragOverlay>, document.body)}
      <KbdHint />
      </>)}
    </DndContext>
  );
}

/* the tile at a quarter: each lane's count and its top open cards, tickable in place */
function LaneSummary({ lanes, onToggle }: { lanes: { name: string; cards: KCard[] }[]; onToggle: (raw: string) => void }) {
  const cap = rowCap(useWidget(), 3);
  return (
    <div className="grid grid-cols-1 group-data-[size=sm]/widget:grid-cols-2 gap-2">
      {lanes.map((l) => {
        const open = l.cards.filter((c) => !c.done);
        const top = open.slice(0, cap);
        return (
          <div key={l.name} data-lane={l.name} className="min-w-0 rounded-xl border border-border bg-card/40 p-2">
            <div className="flex items-center justify-between gap-2 px-0.5 mb-1">
              <span className="min-w-0 truncate text-[11px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">{l.name}</span>
              <span className="shrink-0 text-[11px] nums text-muted-foreground" title={`${open.length} open of ${l.cards.length}`}>{l.cards.length}</span>
            </div>
            {top.map((c) => {
              const rel = relDue(c.due);
              return (
                <div key={c.raw} className="flex items-center gap-1.5 py-0.5 min-w-0">
                  <Checkbox checked={c.done} onCheckedChange={() => onToggle(c.raw)} aria-label={`Mark done: ${c.text}`} className="h-3.5 w-3.5 shrink-0" />
                  <span className="w-0.5 h-3 rounded-full shrink-0" style={{ background: prioColor(c.priority) }} />
                  <span className="min-w-0 flex-1 truncate text-[12px]" title={c.text}>{c.text}</span>
                  {rel && <span className="shrink-0 text-[10px] nums" style={{ color: toneColor(rel.tone) }}>{rel.label}</span>}
                </div>
              );
            })}
            {open.length > top.length && <div className="px-0.5 text-[10.5px] text-muted-foreground nums">+{open.length - top.length} more</div>}
            {l.cards.length === 0 && <div className="px-0.5 text-[11px] text-muted-foreground/60">empty</div>}
            {l.cards.length > 0 && open.length === 0 && <div className="px-0.5 text-[11px] text-muted-foreground/60 nums">{l.cards.length} done</div>}
          </div>
        );
      })}
    </div>
  );
}

function KbdHint() {
  return (
    <div className="mt-3 text-[11px] text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 no-print">
      <span className="uppercase tracking-[0.08em] font-semibold opacity-70">keys</span>
      {[["j k", "move"], ["h l", "lane"], ["x", "done"], ["e", "edit"], ["c", "priority"], ["n", "new"], ["[ ]", "shift lane"]].map(([k, v]) => (
        <span key={k} className="flex items-center gap-1">
          <kbd className="bg-secondary px-1.5 py-0.5 rounded text-[10px] nums">{k}</kbd>
          <span>{v}</span>
        </span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- Lane
function LaneCol({ lane, editingRaw, setEditingRaw, adding, setAdding,
  onToggle, onArchive, onEdit, onAdd, onArchiveDone, onDelete, onSnooze, onCyclePriority }:
{ lane: { name: string; cards: KCard[] }; laneIndex: number;
  editingRaw: string | null; setEditingRaw: (r: string | null) => void;
  adding: boolean; setAdding: (o: boolean) => void;
  onToggle: (raw: string) => void; onArchive: (raw: string) => void;
  onEdit: (raw: string, body: string) => void; onAdd: (text: string) => void;
  onArchiveDone: () => void; onDelete: (raw: string) => void;
  onSnooze: (raw: string, days: number) => void; onCyclePriority: (raw: string) => void; }) {
  const ids = lane.cards.map((c) => c.raw);
  const openEff = lane.cards.reduce((s, c) => s + (c.done ? 0 : (c.est ?? parseEst(c.raw) ?? 0)), 0);
  const doneCount = lane.cards.reduce((n, c) => n + (c.done ? 1 : 0), 0);
  return (
    <div data-lane-col className="flex-1 min-w-[190px] max-w-[340px] group-data-[focused]/widget:max-w-[480px] group-data-[size=sm]/widget:min-w-0 group-data-[size=xs]/widget:min-w-0">
      <div className="flex items-center justify-between px-1 mb-2">
        <span className="text-[11.5px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">{lane.name}</span>
        <span className="text-[11px] text-muted-foreground nums flex items-center gap-2">
          {doneCount > 0 && (
            <button onClick={onArchiveDone}
              title={`Archive ${doneCount} done card${doneCount > 1 ? "s" : ""} to the board's Archive`}
              aria-label="Archive done cards"
              className="inline-flex items-center gap-1 hover:text-foreground transition-colors no-print">
              <Archive size={11} /> clear
            </button>
          )}
          {openEff > 0 && <span className="opacity-70">≈{fmtEst(openEff)}</span>}
          {lane.cards.length}
        </span>
      </div>
      <LaneDroppable name={lane.name}>
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          {lane.cards.map((card) => (
            <SortableCard key={card.raw} card={card}
              editing={editingRaw === card.raw}
              onEditChange={(o) => setEditingRaw(o ? card.raw : null)}
              onToggle={() => onToggle(card.raw)}
              onArchive={() => onArchive(card.raw)}
              onDelete={() => onDelete(card.raw)}
              onEdit={(body) => onEdit(card.raw, body)}
              onSnooze={(days) => onSnooze(card.raw, days)}
              onCyclePriority={() => onCyclePriority(card.raw)} />
          ))}
        </SortableContext>
        <AddCard open={adding} onOpenChange={setAdding} onAdd={onAdd} />
      </LaneDroppable>
    </div>
  );
}

function LaneDroppable({ name, children }: { name: string; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useSortable({ id: "lane:" + name, data: { kind: "lane", lane: name } });
  return (
    <div ref={setNodeRef} data-lane={name}
      className={`rounded-xl border p-2 flex flex-col gap-2 min-h-[60px] transition-colors ${isOver ? "border-primary bg-accent/40" : "border-border bg-card/40"}`}>
      {children}
    </div>
  );
}

/* Snooze menu. "Next workday" only appears when it differs from Tomorrow --
 * Mon-Thu the two are the same day and a duplicate row is just noise. */
function snoozeOptions(wd: Workday, mon: number) {
  return [
    { label: "Tomorrow", n: 1 },
    ...(wd.days > 1 ? [{ label: `Next workday - ${wd.label}`, n: wd.days }] : []),
    { label: "+3 days", n: 3 },
    { label: "Next week", n: 7 },
    { label: "Next Monday", n: mon },
    { label: "+2 weeks", n: 14 },
  ];
}

// ---------------------------------------------------------------- Card
function SortableCard({ card, editing, onEditChange, onToggle, onArchive, onDelete, onEdit, onSnooze, onCyclePriority }:
{ card: KCard;
  editing: boolean; onEditChange: (o: boolean) => void;
  onToggle: () => void; onArchive: () => void; onDelete: () => void; onEdit: (body: string) => void;
  onSnooze: (days: number) => void; onCyclePriority: () => void; }) {
  const { setNodeRef, setActivatorNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({ id: card.raw });
  const [body, setBody] = useState("");
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const rel = relDue(card.due);
  const est = card.est ?? parseEst(card.raw) ?? 0;

  // init the edit textarea whenever editing opens (controlled by parent); reset
  // the delete confirm so it never lingers across opens
  useEffect(() => { setConfirmDel(false); if (editing) setBody(card.raw.replace(/^(\s*)-\s*\[[ xX]\]\s*/, "")); }, [editing, card.raw]);

  // the card itself is the drag activator, so Space on a control inside it
  // presses that control instead of picking the card up
  const setRefs = (n: HTMLElement | null) => { setNodeRef(n); setActivatorNodeRef(n); };
  const snooze = (n: number) => { setSnoozeOpen(false); onSnooze(n); };
  const nextMon = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return (8 - d.getDay()) % 7 || 7; };
  const wd = nextWorkday(new Date(), useOffDays());

  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.3 : 1 };

  return (
    <div ref={setRefs} style={style} {...attributes} {...listeners} data-kcard={card.raw}
      className="group bg-card border border-border rounded-lg p-2.5 transition-colors flex gap-2.5 cursor-grab active:cursor-grabbing touch-none relative overflow-hidden hover:border-primary/50 focus-visible:border-primary/60">
      <button onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); onCyclePriority(); }}
        title={`Priority: ${card.priority || "none"} — click to cycle`} aria-label="Cycle priority"
        className="absolute left-0 top-0 bottom-0 w-1 hover:w-1.5 transition-all"
        style={{ background: prioColor(card.priority) }} />
      <Checkbox checked={card.done} onClick={(e) => e.stopPropagation()} onCheckedChange={onToggle} onPointerDown={(e) => e.stopPropagation()} className="mt-0.5 ml-1.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className={`text-[13px] leading-snug ${card.done ? "line-through text-muted-foreground" : ""}`}>
          {tokenize(card.text).map((t, i) =>
            t.kind === "link" ? (
              <button key={i} onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); api.open(t.value.replace(/\|.*$/, "") + ".md"); }}
                className="text-primary hover:underline">[[{t.value}]]</button>
            ) : t.kind === "bold" ? <strong key={i}>{t.value}</strong>
            : <span key={i}>{t.value}</span>
          )}
        </div>
        {(card.tags.length > 0 || rel || est > 0) && (
          <div className="flex flex-wrap items-center gap-1.5 mt-2">
            {card.tags.slice(0, 3).map((t) => <span key={t} className="text-[10px] text-muted-foreground bg-secondary px-1.5 py-0.5 rounded">#{t}</span>)}
            {est > 0 && <span className="text-[10px] text-muted-foreground nums">≈{fmtEst(est)}</span>}
            {rel && <span className="text-[10.5px] nums font-medium" style={{ color: toneColor(rel.tone) }}>{rel.label}</span>}
          </div>
        )}
      </div>
      <div className="flex flex-col items-center gap-2 shrink-0 mt-0.5">
      <Popover open={snoozeOpen} onOpenChange={setSnoozeOpen}>
        <PopoverTrigger asChild>
          <button onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); setSnoozeOpen((v) => !v); }}
            title="Snooze" aria-label="Snooze card"
            className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity text-muted-foreground hover:text-foreground shrink-0">
            <Clock size={13} />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-44 p-1.5" align="end" onClick={(e) => e.stopPropagation()}>
          <div className="text-[10.5px] uppercase tracking-[0.08em] font-semibold text-muted-foreground px-2 pt-1.5 pb-1">Snooze until</div>
          {snoozeOptions(wd, nextMon()).map(({ label, n }) => (
            <button key={label} onClick={() => snooze(n)}
              className="w-full text-left text-[12.5px] px-2 py-1.5 rounded hover:bg-accent transition-colors flex justify-between items-center">
              <span>{label}</span><span className="text-[10.5px] text-muted-foreground nums">+{n}d</span>
            </button>
          ))}
        </PopoverContent>
      </Popover>
      <Popover open={editing} onOpenChange={onEditChange}>
        <PopoverTrigger asChild>
          <button onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onEditChange(true); }}
            title="Edit" aria-label="Edit card"
            className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity text-muted-foreground hover:text-foreground shrink-0">
            <Pencil size={13} />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-72" align="end" onClick={(e) => e.stopPropagation()}>
          <Textarea autoFocus value={body} onChange={(e) => setBody(e.target.value)} rows={3} className="text-[13px]"
            placeholder="Card text — #tag @high @due(2026-06-01) @est(2h)" />
          <div className="flex items-center justify-between mt-2.5">
            <div className="flex items-center gap-0.5">
              <Button variant="ghost" size="sm" className="text-muted-foreground gap-1.5 h-8" onClick={() => { onEditChange(false); onArchive(); }}>
                <Archive size={13} /> Archive
              </Button>
              {confirmDel ? (
                <Button variant="ghost" size="sm" className="text-destructive gap-1.5 h-8"
                  onClick={() => { onEditChange(false); onDelete(); }}>
                  <Trash2 size={13} /> Delete?
                </Button>
              ) : (
                <Button variant="ghost" size="sm" className="text-destructive/75 gap-1.5 h-8"
                  onClick={() => setConfirmDel(true)} title="Permanently delete this card">
                  <Trash2 size={13} /> Delete
                </Button>
              )}
            </div>
            <Button size="sm" className="h-8" onClick={() => { if (body.trim()) onEdit(body.trim()); onEditChange(false); }}>Save</Button>
          </div>
        </PopoverContent>
      </Popover>
      <GripVertical size={14} aria-hidden
        className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground/40 shrink-0" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Add card
function AddCard({ open, onOpenChange, onAdd }: { open: boolean; onOpenChange: (o: boolean) => void; onAdd: (text: string) => void }) {
  const [val, setVal] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);   // Escape closed the field: stand on this lane's Add card again
  useEffect(() => {
    if (open) { setTimeout(() => ref.current?.focus(), 10); return; }
    setVal("");
    if (refocus.current) {
      refocus.current = false;
      document.documentElement.setAttribute("data-knav", "");
      btn.current?.focus();
    }
  }, [open]);
  if (!open) return (
    <button ref={btn} type="button" onClick={() => onOpenChange(true)}
      className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground hover:text-foreground px-1.5 py-1.5 rounded-md hover:bg-accent transition-colors">
      <Plus size={14} /> Add card
    </button>
  );
  return (
    <Input ref={ref} value={val} placeholder="Card text…  #tag @high @est(1h)"
      onChange={(e) => setVal(e.target.value)} onBlur={() => onOpenChange(false)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && val.trim()) { onAdd(val.trim()); setVal(""); }   // keep open for rapid add
        if (e.key === "Escape") { e.preventDefault(); refocus.current = true; onOpenChange(false); }
      }}
      className="h-8 text-[13px]" />
  );
}
