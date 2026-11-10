
import { useCallback, useEffect, useRef, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { GraduationCap, Flame, Sparkles, Check, GripVertical, ChevronRight, Layers, Shuffle, Images, Keyboard } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DndContext, DragOverlay, MouseSensor, TouchSensor, KeyboardSensor,
  useSensor, useSensors, pointerWithin,
} from "@dnd-kit/core";
import type { DragStartEvent, DragOverEvent, DragEndEvent } from "@dnd-kit/core";
import { SortableContext, useSortable, rectSortingStrategy, arrayMove, sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useApi } from "@/lib/hooks";
import { api } from "@/lib/api";
import { WidgetFrame, useWidget, rowCap } from "@/components/ui/widget";
import { openWidgetFocus } from "@/lib/arrownav";
import { StudySession } from "@/components/LearningStudy";
import type { FlashCard, LearnScan, Deck, DeckSection, Module, LearnForecast } from "@/lib/api";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useDatumCursor, ChartTip } from "@/components/charts/datum";
import { SOLID, EMPTY, ACTIVE_RING } from "@/components/InsightsArchive";

// in order = curriculum walk (foundations up); random = interleaved shuffle across
// every module (the stronger practice, and how a subject's figures mix with its text).
type StartOpts = { module?: string; ordered?: boolean; random?: boolean };

// title-case a hyphen/underscore label, uppercasing known acronyms and lowercasing
// connector words so "ai" -> "AI" and "nlp-and-applications" -> "NLP and Applications".
const ACRONYMS = new Set(["ai", "ml", "nlp", "llm", "llms", "rl", "dna", "rna", "atp", "gdp",
  "r", "ols", "gls", "anova", "ancova", "sem", "spss", "mle", "iv", "did", "rdd", "ci", "api",
  "us", "uk", "eu", "ui", "ux"]);
const SMALL_WORDS = new Set(["and", "or", "of", "the", "in", "to", "a", "an", "for", "with", "vs", "on", "at", "by"]);
function titleize(s: string): string {
  const words = s.replace(/[-_]/g, " ").trim().split(/\s+/).filter(Boolean);
  return words.map((w, i) => {
    const lw = w.toLowerCase();
    if (ACRONYMS.has(lw)) return lw.toUpperCase();
    if (i > 0 && SMALL_WORDS.has(lw)) return lw;
    return lw.charAt(0).toUpperCase() + lw.slice(1);
  }).join(" ");
}
const DECK_LABEL = (d: string) => titleize(d);
export function Learning() {
  const scan = useApi(() => api.learning(), [], 60_000);
  const [session, setSession] = useState<{ label: string; cards: FlashCard[]; i: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [picker, setPicker] = useState<Deck | null>(null);   // deck whose modules are being chosen
  const [typed, setTyped] = useState(false);                 // typed-answer study option
  const returnTo = useRef<string | null>(null);              // data-knav-id to stand on after a session

  const start = useCallback(async (label: string, deck: string, opts?: StartOpts) => {
    setLoading(true);
    try {
      const cards = await api.learningQueue(deck, 40, opts);
      if (!cards.length) { toast("Nothing to study there right now"); return; }
      setPicker(null);
      returnTo.current = deck === "all" ? "learn-review-all" : "deck:" + deck;
      setSession({ label, cards, i: 0 });
    } catch { toast.error("Couldn't load cards"); }
    finally { setLoading(false); }
  }, []);

  const openPicker = useCallback((deckName: string) => {
    const d = scan.data?.decks.find((x) => x.deck === deckName) ?? null;
    if (d) setPicker(d);
  }, [scan.data]);

  const rate = useCallback(async (response: string) => {
    if (!session) return;
    const card = session.cards[session.i];
    try { await api.learningReview(card.path, card.ord, response); }
    catch { toast.error("Couldn't save review"); }
    if (session.i + 1 >= session.cards.length) {
      toast.success(`Session complete — ${session.cards.length} cards`);
      setSession(null); scan.reload();
    } else {
      setSession({ ...session, i: session.i + 1 });
    }
  }, [session, scan]);

  // back from a session with the keyboard: land on the deck (or button) it came from
  const inSession = session !== null;
  useEffect(() => {
    if (inSession || !returnTo.current) return;
    const id = returnTo.current;
    returnTo.current = null;
    if (!document.documentElement.hasAttribute("data-knav")) return;
    const t = window.setTimeout(() => {
      // window.CSS: the bare name here is dnd-kit's CSS helper
      const el = document.querySelector<HTMLElement>(`[data-knav-id="${window.CSS.escape(id)}"]`);
      const a = document.activeElement;
      if (!el || (a && a !== document.body)) return;
      el.focus({ preventScroll: true });
      el.scrollIntoView({ block: "nearest" });
    }, 0);
    return () => window.clearTimeout(t);
  }, [inSession]);

  if (session) {
    return (
      <StudySession
        card={session.cards[session.i]} index={session.i} total={session.cards.length}
        label={session.label} options={{ typed }}
        upcoming={session.cards.slice(session.i + 1, session.i + 4)}
        onRate={rate} onEnd={() => { setSession(null); scan.reload(); }} />
    );
  }

  const s = scan.data;
  return (
    <div>
      <header className="mb-6">
        <div className="flex items-center gap-2 text-[12px] text-muted-foreground uppercase tracking-[0.1em] font-semibold mb-1">
          <GraduationCap size={14} className="opacity-60" /> Learning
        </div>
        <div className="flex items-end justify-between gap-4 flex-wrap">
          <h1 className="text-[26px] font-semibold tracking-tight">Flashcards</h1>
          <div className="flex items-center gap-2 flex-wrap">
            <button onClick={() => setTyped((t) => !t)} title="Type your answer, then self-grade"
              className={"inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-[12.5px] font-medium transition-colors " +
                (typed ? "border-primary/50 bg-primary/10 text-primary" : "border-border text-muted-foreground hover:text-foreground")}>
              <Keyboard size={14} /> Type answers {typed ? "on" : "off"}
            </button>
            {s && s.due > 0 && (
              <Button className="gap-2" onClick={() => start("all due", "all")} disabled={loading} data-knav-id="learn-review-all">
                <Flame size={15} /> Review all due ({s.due})
              </Button>
            )}
          </div>
        </div>
        {s && (
          <p className="text-muted-foreground text-sm mt-1 nums">
            {s.total.toLocaleString()} cards · <span className="text-foreground font-medium">{s.due.toLocaleString()} due</span> · {s.new.toLocaleString()} new · {s.decks.length} decks
          </p>
        )}
      </header>

      {!s ? (
        <div className="text-sm text-muted-foreground py-10">Loading decks…</div>
      ) : (
        <>
        <DeckBoard s={s} onStart={openPicker}
          onModule={(deck, m) => start(MODULE_LABEL(m.module), deck, { module: m.sub, ordered: true })} />
        <WidgetFrame id="learning.progress" title="Your progress" className="mt-8">
          <Progress s={s} />
        </WidgetFrame>
        </>
      )}
      <ModulePicker deck={picker} loading={loading} onClose={() => setPicker(null)} onStudy={start} />
    </div>
  );
}

const MODULE_LABEL = (m: string) => titleize(m.replace(/^\d+[-_]/, "")) || "General";

function ModulePicker({ deck, loading, onClose, onStudy }: {
  deck: Deck | null;
  loading: boolean;
  onClose: () => void;
  onStudy: (label: string, deck: string, opts?: StartOpts) => void;
}) {
  const modules: Module[] = deck?.modules ?? [];
  const ready = (deck?.due ?? 0) + (deck?.new ?? 0);
  // no DialogTrigger here, so Radix has nowhere to send focus on close: hand it
  // back to the deck tile that opened the picker (gone if a session started)
  const lastDeck = useRef<string | null>(null);
  if (deck) lastDeck.current = deck.deck;
  const backToTile = (e: Event) => {
    const id = lastDeck.current;
    const el = id ? document.querySelector<HTMLElement>(`[data-knav-id="${window.CSS.escape("deck:" + id)}"]`) : null;
    if (el) { e.preventDefault(); el.focus({ preventScroll: true }); }
  };
  return (
    <Dialog open={deck !== null} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-[440px]" onCloseAutoFocus={backToTile}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GraduationCap size={16} className="opacity-70" /> {deck ? DECK_LABEL(deck.deck) : ""}
          </DialogTitle>
        </DialogHeader>
        {deck && (
          <div className="space-y-2">
            <button
              onClick={() => onStudy(DECK_LABEL(deck.deck) + " · in order", deck.deck, { ordered: true })}
              disabled={ready === 0 || loading}
              title="The whole subject in curriculum order, basic to complex"
              className="w-full text-left rounded-lg border border-primary/40 bg-primary/[0.06] px-3.5 py-3 transition-colors hover:bg-primary/[0.12] disabled:cursor-not-allowed disabled:opacity-40">
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-2 text-[13.5px] font-semibold"><Layers size={14} className="text-primary" /> All modules — in order</span>
                <span className="nums text-[11px] text-muted-foreground">{ready} ready</span>
              </div>
            </button>
            <button
              onClick={() => onStudy(DECK_LABEL(deck.deck) + " · random", deck.deck, { random: true })}
              disabled={ready === 0 || loading}
              title="Every module interleaved — the stronger practice"
              className="w-full text-left rounded-lg border border-primary/40 bg-primary/[0.06] px-3.5 py-3 transition-colors hover:bg-primary/[0.12] disabled:cursor-not-allowed disabled:opacity-40">
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-2 text-[13.5px] font-semibold"><Shuffle size={14} className="text-primary" /> All modules — random</span>
                <span className="nums text-[11px] text-muted-foreground">{ready} ready</span>
              </div>
            </button>
            <div className="text-[10.5px] uppercase tracking-[0.09em] font-semibold text-muted-foreground/80 pt-1.5 pl-0.5">Modules</div>
            <div className="space-y-1.5 max-h-[44vh] overflow-y-auto">
              {modules.map((m, idx) => {
                const mReady = m.due + m.new;
                return (
                  <button key={m.sub}
                    onClick={() => onStudy(MODULE_LABEL(m.module), deck.deck, { module: m.sub, ordered: true })}
                    disabled={mReady === 0 || loading}
                    className="w-full text-left rounded-lg border border-border px-3.5 py-2.5 transition-colors hover:border-primary/50 hover:bg-accent/40 disabled:cursor-not-allowed disabled:opacity-45 flex items-center gap-3">
                    <span className="shrink-0 h-6 w-6 rounded-full bg-secondary text-muted-foreground text-[11px] font-semibold flex items-center justify-center nums">{idx + 1}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] font-medium truncate">{MODULE_LABEL(m.module)}</span>
                      <span className="block nums text-[11px] text-muted-foreground">
                        {m.due > 0 && <><span className="text-foreground/80 font-medium">{m.due} due</span><span className="opacity-40"> · </span></>}
                        {m.new > 0 && <>{m.new} new<span className="opacity-40"> · </span></>}
                        {m.total} cards
                        {(m.img ?? 0) > 0 && <><span className="opacity-40"> · </span><span className="inline-flex items-center gap-0.5" title="figures in this module"><Images size={10} /> {m.img}</span></>}
                      </span>
                    </span>
                    {mReady === 0
                      ? <span className="shrink-0 text-[10px] text-muted-foreground flex items-center gap-1"><Check size={11} /> clear</span>
                      : <ChevronRight size={15} className="shrink-0 text-muted-foreground/50" />}
                  </button>
                );
              })}
              {modules.length === 0 && (
                <div className="text-[12px] text-muted-foreground/70 py-4 text-center">No modules yet in this subject.</div>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

type Cols = { inProgress: Deck[]; queue: Deck[] };
const LANES: { key: DeckSection; label: string; hint: string }[] = [
  { key: "inProgress", label: "In Progress", hint: "actively studying" },
  { key: "queue", label: "Queue", hint: "want to learn — not started yet" },
];

function splitCols(decks: Deck[]): Cols {
  return {
    inProgress: decks.filter((d) => d.section === "inProgress"),
    queue: decks.filter((d) => d.section !== "inProgress"),
  };
}

function DeckBoard({ s, onStart, onModule }: { s: LearnScan; onStart: (deck: string) => void; onModule: (deck: string, m: Module) => void }) {
  const [cols, setCols] = useState<Cols>(() => splitCols(s.decks));
  const [active, setActive] = useState<string | null>(null);
  // re-derive from the server whenever a scan lands (counts refresh / order saved)
  useEffect(() => { setCols(splitCols(s.decks)); }, [s]);

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),   // 8px move = drag, else click → review
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
    // Space picks a deck up; Enter is left to open it
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space"] },
    }),
  );

  const laneOf = (deck: string, c: Cols): DeckSection | null =>
    c.inProgress.some((d) => d.deck === deck) ? "inProgress"
      : c.queue.some((d) => d.deck === deck) ? "queue" : null;
  const overLane = (overId: string, c: Cols): DeckSection | null =>
    overId.startsWith("lane:") ? (overId.slice(5) as DeckSection) : laneOf(overId, c);

  const persist = (c: Cols) =>
    api.learningBoard(c.inProgress.map((d) => d.deck), c.queue.map((d) => d.deck))
      .catch(() => toast.error("Couldn't save the order"));

  const onDragStart = (e: DragStartEvent) => setActive(String(e.active.id));

  // live cross-lane move while dragging (optimistic)
  const onDragOver = (e: DragOverEvent) => {
    const activeId = String(e.active.id);
    const overId = String(e.over?.id ?? "");
    if (!overId || overId === activeId) return;
    setCols((prev) => {
      const from = laneOf(activeId, prev);
      const to = overLane(overId, prev);
      if (!from || !to || from === to) return prev;
      const next: Cols = { inProgress: [...prev.inProgress], queue: [...prev.queue] };
      const i = next[from].findIndex((d) => d.deck === activeId);
      if (i < 0) return prev;
      const [moved] = next[from].splice(i, 1);
      const overIdx = next[to].findIndex((d) => d.deck === overId);
      next[to].splice(overIdx < 0 ? next[to].length : overIdx, 0, moved);
      return next;
    });
  };

  const onDragEnd = (e: DragEndEvent) => {
    setActive(null);
    const activeId = String(e.active.id);
    const overId = String(e.over?.id ?? "");
    const lane = laneOf(activeId, cols);
    if (!lane) { persist(cols); return; }
    const list = cols[lane];
    const oldIdx = list.findIndex((d) => d.deck === activeId);
    let newIdx = overId.startsWith("lane:") ? list.length - 1 : list.findIndex((d) => d.deck === overId);
    if (newIdx < 0) newIdx = list.length - 1;
    const next: Cols = { inProgress: [...cols.inProgress], queue: [...cols.queue] };
    if (oldIdx >= 0 && oldIdx !== newIdx) next[lane] = arrayMove(list, oldIdx, newIdx);
    setCols(next);
    persist(next);
  };

  const activeDeck = active ? [...cols.inProgress, ...cols.queue].find((d) => d.deck === active) || null : null;

  return (
    <DndContext sensors={sensors} collisionDetection={pointerWithin}
      onDragStart={onDragStart} onDragOver={onDragOver} onDragEnd={onDragEnd}>
      {/* each lane is its own widget; one DndContext spans both so decks still cross */}
      <div className="space-y-6">
        {LANES.map((lane) => (
          <WidgetFrame key={lane.key} id={lane.key === "inProgress" ? "learning.in-progress" : "learning.queue"} title={lane.label}>
            <Lane lane={lane} decks={cols[lane.key]} onStart={onStart} dragging={active !== null}
              onModule={lane.key === "inProgress" ? onModule : undefined} />
          </WidgetFrame>
        ))}
      </div>
      <DragOverlay dropAnimation={{ duration: 180, easing: "cubic-bezier(.22,1,.36,1)" }}>
        {activeDeck && <DeckCardInner d={activeDeck} dragging />}
      </DragOverlay>
    </DndContext>
  );
}

function Lane({ lane, decks, onStart, dragging, onModule }:
  { lane: { key: DeckSection; label: string; hint: string }; decks: Deck[]; onStart: (deck: string) => void; dragging?: boolean;
    onModule?: (deck: string, m: Module) => void }) {
  const { setNodeRef, isOver } = useSortable({ id: "lane:" + lane.key, data: { kind: "lane" } });
  const w = useWidget();
  const [all, setAll] = useState(false);
  const perRow = Math.max(1, Math.floor(((w?.width || 1200) - 26 + 16) / (21 * 16 + 16)));
  const tileCap = perRow * rowCap(w, 2, 3);
  const shown = dragging || all ? decks : decks.slice(0, tileCap);
  const table = !!w?.focused && !!onModule;
  const compact = !!w?.focused && w.height < 700;
  const detail = !!w?.focused && !table && !compact;
  const n = shown.length;
  const hug = !dragging && n > 0 ? { maxWidth: `calc(${n} * 26rem + ${n - 1} * 1rem + 1.5rem + 2px)` } : undefined;
  return (
    <section>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 mb-2.5">
        <span className="text-[11px] uppercase tracking-[0.09em] font-semibold text-muted-foreground">{lane.label}</span>
        <span className="text-[11px] text-muted-foreground nums">{decks.length}</span>
        <span className="text-[11px] text-muted-foreground/70">· {lane.hint}</span>
      </div>
      <div ref={setNodeRef} style={hug}
        className={`rounded-xl border border-dashed p-3 transition-colors ${isOver ? "border-primary bg-accent/40" : "border-border/70"}`}>
        <SortableContext items={shown.map((d) => d.deck)} strategy={rectSortingStrategy}>
          <div className={cn("grid", compact
            ? "grid-cols-[repeat(auto-fill,minmax(min(100%,15rem),1fr))] gap-2.5"
            : "grid-cols-[repeat(auto-fill,minmax(min(100%,21rem),1fr))] gap-4")}>
            {shown.map((d) => <SortableDeck key={d.deck} d={d} onStart={onStart} detail={detail} compact={compact} />)}
          </div>
        </SortableContext>
        {decks.length === 0 && (
          <div className="text-[12px] text-muted-foreground/70 py-6 text-center">Drag a deck here</div>
        )}
        {!dragging && decks.length > tileCap && (
          <button type="button" onClick={(e) => { if (all || !openWidgetFocus(e.currentTarget)) setAll((a) => !a); }}
            title={all ? "Show the first rows only" : "Show every deck in this lane"}
            className="mt-3 w-full rounded-lg py-1.5 text-[12px] text-muted-foreground nums transition-colors hover:bg-accent/40 hover:text-foreground">
            {all ? "Show fewer" : `Show all ${decks.length}`}
          </button>
        )}
      </div>
      {table && onModule && decks.length > 0 && <ModulesTable decks={decks} onModule={onModule} />}
    </section>
  );
}

function SortableDeck({ d, onStart, detail, compact }: { d: Deck; onStart: (deck: string) => void; detail?: boolean; compact?: boolean }) {
  const { setNodeRef, setActivatorNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({ id: d.deck });
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.3 : 1 };
  const setRefs = (n: HTMLElement | null) => { setNodeRef(n); setActivatorNodeRef(n); };
  return (
    <div ref={setRefs} style={style} {...attributes} {...listeners} data-knav-id={"deck:" + d.deck}
      aria-label={DECK_LABEL(d.deck)}
      onClick={() => onStart(d.deck)}
      className="touch-none cursor-grab active:cursor-grabbing">
      <DeckCardInner d={d} detail={detail} compact={compact} />
    </div>
  );
}

function DeckCardInner({ d, dragging, detail, compact }: { d: Deck; dragging?: boolean; detail?: boolean; compact?: boolean }) {
  const reviewed = d.total - d.new;
  const pct = d.total ? Math.round((reviewed / d.total) * 100) : 0;
  // focused view: the next modules still holding work, in curriculum order
  const mods = d.modules ?? [];
  const open = mods.filter((m) => m.due + m.new > 0);
  return (
    <Card className={`${compact ? "p-3 gap-2" : "p-5 gap-3"} flex flex-col transition-colors ${dragging ? "border-primary/60 shadow-pop rotate-[1deg] w-[280px]" : "hover:border-primary/40"}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <GripVertical size={14} className="shrink-0 text-muted-foreground/40" />
          <div className={`${compact ? "text-[14px]" : "text-[15px]"} font-semibold truncate`}>{DECK_LABEL(d.deck)}</div>
        </div>
        {d.due > 0
          ? <span className="shrink-0 px-2 py-0.5 rounded-full bg-primary/12 text-primary text-[11px] font-semibold nums">{d.due} due</span>
          : <span className="shrink-0 px-2 py-0.5 rounded-full bg-secondary text-muted-foreground text-[11px] nums flex items-center gap-1"><Check size={11} /> clear</span>}
      </div>
      <div className="h-1.5 rounded-full bg-secondary overflow-hidden">
        <div className="h-full bg-emerald-500/70" style={{ width: `${pct}%` }} />
      </div>
      {/* each fact stays whole; a narrow card wraps between them, never inside one */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-muted-foreground nums">
        <span className="whitespace-nowrap">{d.total} cards</span>
        {d.new > 0 && <><span className="opacity-40">·</span><span className="flex items-center gap-1 whitespace-nowrap"><Sparkles size={11} /> {d.new} new</span></>}
        {d.img ? <><span className="opacity-40">·</span><span className="flex items-center gap-1 whitespace-nowrap" title="image cards"><Images size={11} /> {d.img}</span></> : null}
        <span className="ml-auto whitespace-nowrap">{pct}% learned</span>
      </div>
      {detail && mods.length > 0 && (
        <div className="border-t border-border pt-2.5 space-y-1">
          <div className="flex flex-wrap items-baseline justify-between gap-x-2 text-[10.5px] uppercase tracking-[0.08em] font-semibold text-muted-foreground">
            <span>Up next</span>
            <span className="nums normal-case tracking-normal font-normal">{mods.length - open.length} of {mods.length} modules clear</span>
          </div>
          {open.slice(0, 4).map((m) => (
            <div key={m.sub} className="flex items-center gap-2 text-[12px]">
              <span className="min-w-0 flex-1 truncate" title={MODULE_LABEL(m.module)}>{MODULE_LABEL(m.module)}</span>
              {m.due > 0
                ? <span className="shrink-0 nums text-[11px] text-primary font-medium">{m.due} due</span>
                : <span className="shrink-0 nums text-[11px] text-muted-foreground">{m.new} new</span>}
            </div>
          ))}
          {open.length > 4 && <div className="text-[11px] text-muted-foreground nums">+{open.length - 4} more</div>}
        </div>
      )}
    </Card>
  );
}

// focused view of "In progress": every module of the decks being studied, in curriculum order.
// a row studies that module from the foundations up, like the module picker
function ModulesTable({ decks, onModule }: { decks: Deck[]; onModule: (deck: string, m: Module) => void }) {
  const w = useWidget();
  const wide = (w?.width ?? 1200) >= 700;
  // a tall focused view gives each module more room instead of leaving the page's lower half empty
  const tall = (w?.height ?? 0) >= 900;
  const cols = wide
    ? "grid-cols-[2rem_minmax(0,1.6fr)_minmax(0,1.4fr)_4.5rem_4.5rem_4.5rem]"
    : "grid-cols-[minmax(0,1fr)_minmax(0,1fr)_3.5rem]";
  return (
    <div className="mt-5 space-y-5">
      {decks.map((d) => {
        const mods = d.modules ?? [];
        const clear = mods.filter((m) => m.due + m.new === 0).length;
        return (
          <Card key={d.deck} className="p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 pb-2.5">
              <span className="text-[13.5px] font-semibold">{DECK_LABEL(d.deck)} <span className="font-normal text-muted-foreground">· modules</span></span>
              <span className="nums text-[11.5px] text-muted-foreground">{clear} of {mods.length} clear · {d.due.toLocaleString()} due · {d.new.toLocaleString()} new</span>
            </div>
            <div className={`grid ${cols} gap-x-3 px-2 pb-2 border-b border-border text-[10.5px] uppercase tracking-[0.08em] font-semibold text-muted-foreground`}>
              {wide && <span className="text-right">#</span>}
              <span>Module</span><span>Learned</span><span className="text-right">Due</span>
              {wide && <><span className="text-right">New</span><span className="text-right">Cards</span></>}
            </div>
            {mods.map((m, i) => {
              const seen = m.total - m.new;
              const pct = m.total ? Math.round((seen / m.total) * 100) : 0;
              const ready = m.due + m.new;
              return (
                <button key={m.sub} type="button" disabled={ready === 0} onClick={() => onModule(d.deck, m)}
                  title={ready ? `Study ${MODULE_LABEL(m.module)} in order` : `${MODULE_LABEL(m.module)} is clear`}
                  className={`grid ${cols} w-full gap-x-3 items-center px-2 ${tall ? "py-3.5 text-[13.5px]" : "py-2 text-[12.5px]"} border-b border-border/60 last:border-0 text-left transition-colors hover:bg-accent/40 disabled:cursor-default disabled:hover:bg-transparent`}>
                  {wide && <span className="text-right nums text-[11.5px] text-muted-foreground">{i + 1}</span>}
                  <span className="truncate font-medium">{MODULE_LABEL(m.module)}</span>
                  <span className="flex items-center gap-2 min-w-0" title={`${seen.toLocaleString()} of ${m.total.toLocaleString()} cards seen`}>
                    <svg className="block min-w-0 flex-1" height={tall ? 8 : 6} aria-hidden="true">
                      <rect width="100%" height={tall ? 8 : 6} rx={tall ? 4 : 3} fill="hsl(var(--secondary))" />
                      {pct > 0 && <rect width={`${Math.max(pct, 2)}%`} height={tall ? 8 : 6} rx={tall ? 4 : 3} fill="hsl(var(--primary))" />}
                    </svg>
                    <span className="w-9 shrink-0 text-right nums text-[11.5px] text-muted-foreground">{pct}%</span>
                  </span>
                  <span className={"text-right nums " + (m.due > 0 ? "text-primary font-medium" : "text-muted-foreground")}>{m.due.toLocaleString()}</span>
                  {wide && <>
                    <span className="text-right nums text-muted-foreground">{m.new.toLocaleString()}</span>
                    <span className="text-right nums text-muted-foreground">{m.total.toLocaleString()}</span>
                  </>}
                </button>
              );
            })}
            {mods.length === 0 && <div className="py-4 text-center text-[12px] text-muted-foreground">No modules yet in this subject.</div>}
          </Card>
        );
      })}
    </div>
  );
}

// focused view of "Your progress": every deck's standing, most due first
function DeckTable({ decks, wide }: { decks: Deck[]; wide: boolean }) {
  const rows = [...decks].sort((a, b) => b.due - a.due || a.deck.localeCompare(b.deck));
  const cols = wide
    ? "grid-cols-[minmax(0,1.5fr)_minmax(0,1.3fr)_4.5rem_4.5rem_4.5rem]"
    : "grid-cols-[minmax(0,1fr)_minmax(0,1fr)_3.5rem]";
  return (
    <Card className="mt-4 p-4">
      <div className={`grid ${cols} gap-x-3 pb-2 border-b border-border text-[10.5px] uppercase tracking-[0.08em] font-semibold text-muted-foreground`}>
        <span>Deck</span><span>Learned</span><span className="text-right">Due</span>
        {wide && <><span className="text-right">New</span><span className="text-right">Cards</span></>}
      </div>
      {rows.map((d) => {
        const pct = d.total ? Math.round(((d.total - d.new) / d.total) * 100) : 0;
        return (
          <div key={d.deck} className={`grid ${cols} gap-x-3 items-center py-1.5 border-b border-border/60 last:border-0 text-[12.5px]`}>
            <span className="truncate font-medium" title={DECK_LABEL(d.deck)}>{DECK_LABEL(d.deck)}</span>
            <span className="flex items-center gap-2 min-w-0">
              <span className="h-1.5 min-w-0 flex-1 rounded-full bg-secondary overflow-hidden">
                <span className="block h-full bg-emerald-500/70" style={{ width: `${pct}%` }} />
              </span>
              <span className="w-9 shrink-0 text-right nums text-[11.5px] text-muted-foreground">{pct}%</span>
            </span>
            <span className={"text-right nums " + (d.due > 0 ? "text-primary font-medium" : "text-muted-foreground")}>{d.due.toLocaleString()}</span>
            {wide && <>
              <span className="text-right nums text-muted-foreground">{d.new.toLocaleString()}</span>
              <span className="text-right nums text-muted-foreground">{d.total.toLocaleString()}</span>
            </>}
          </div>
        );
      })}
    </Card>
  );
}

function Progress({ s }: { s: LearnScan }) {
  const w = useWidget();
  const m = s.maturity;
  const total = s.total || 1;
  const pct = Math.round((s.reviewed / total) * 100);
  const overdue = s.forecast?.overdue ?? 0;
  const stats = [
    { n: pct + "%", label: "Learned", tip: `${s.reviewed.toLocaleString()} of ${s.total.toLocaleString()} cards learned (${pct}%)` },
    { n: m.mature.toLocaleString(), label: "Mastered", tip: `${m.mature.toLocaleString()} mastered · 30+ day recall` },
    { n: (m.learning + m.young).toLocaleString(), label: "In progress", tip: `${(m.learning + m.young).toLocaleString()} building recall · ${m.learning.toLocaleString()} learning, ${m.young.toLocaleString()} young` },
    { n: s.due.toLocaleString(), label: "Due now", tip: `${s.due.toLocaleString()} ready to review${overdue ? ` · ${overdue.toLocaleString()} overdue` : ""}`, alarm: overdue > 0 },
  ];
  const segs = [
    { key: "mature", label: "Mastered", n: m.mature, color: SOLID, note: "30+ day recall" },
    { key: "young", label: "Young", n: m.young, color: "hsl(var(--primary) / 0.6)", note: "recall building" },
    { key: "learning", label: "Learning", n: m.learning, color: "hsl(var(--primary) / 0.36)", note: "in first reviews" },
    { key: "new", label: "New", n: m.new, color: EMPTY, note: "not yet studied" },
  ].filter((x) => x.n > 0);
  const kc = useDatumCursor(stats.length, { start: 0 });
  const bc = useDatumCursor(segs.length, { start: 0 });
  const seg = bc.active != null ? segs[bc.active] : null;
  return (
    <div>
      <div className="text-[11px] uppercase tracking-[0.09em] font-semibold text-muted-foreground mb-3">Your progress</div>
      {/* four across once the widget has room; two on a narrow tile */}
      <div {...kc.surface} aria-label={stats.map((x) => x.tip).join("; ")}
        className="grid grid-cols-2 group-data-[size=md]/widget:grid-cols-4 group-data-[size=lg]/widget:grid-cols-4 group-data-[size=xl]/widget:grid-cols-4 gap-3 mb-4 rounded-lg">
        {stats.map((x, i) => <Stat key={x.label} n={x.n} label={x.label} accent={i === 0} alarm={x.alarm} mark={kc.mark(i)} active={kc.active === i} />)}
        <ChartTip cursor={kc}>{kc.active != null && stats[kc.active].tip}</ChartTip>
      </div>
      <Card className="p-4">
        <div {...bc.surface} className="rounded-full"
          aria-label={`Cards by maturity: ${segs.map((x) => `${x.label} ${x.n}`).join(", ")}`}>
          <div className="flex h-3.5 gap-[2px] group-data-[focused]/widget:h-5">
            {segs.map((x, i) => (
              <div key={x.key} {...bc.mark(i)} className="h-full first:rounded-l-full last:rounded-r-full"
                style={{ flex: `${x.n} 1 0`, minWidth: 4, background: x.color,
                  outline: bc.active === i ? ACTIVE_RING : undefined, outlineOffset: 1 }} />
            ))}
          </div>
          <ChartTip cursor={bc}>{seg && (
            <span><span className="font-medium">{seg.label}</span>
              <span className="ml-2 text-muted-foreground">{seg.n.toLocaleString()} card{seg.n === 1 ? "" : "s"} ({Math.round((100 * seg.n) / total)}%) · {seg.note}</span></span>
          )}</ChartTip>
        </div>
      </Card>
      {s.forecast && <Forecast f={s.forecast} />}
      {w?.focused && <DeckTable decks={s.decks} wide={w.width >= 640} />}
    </div>
  );
}

function Forecast({ f }: { f: LearnForecast }) {
  const w = useWidget();
  const ahead = f.days.reduce((n, d) => n + d.due, 0);
  const max = Math.max(1, f.peak, (f.days[0]?.due ?? 0) + f.overdue);
  const H = w?.focused ? 132 : 64;
  const dc = useDatumCursor(f.days.length, { start: 0 });
  const long = (iso: string) => new Date(iso + "T00:00").toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  const tip = (i: number) => {
    const d = f.days[i];
    return (
      <span className="grid gap-0.5">
        <span><span className="font-medium">{i === 0 ? "Today" : long(d.date)}</span>
          <span className="ml-2 text-muted-foreground">{d.due.toLocaleString()} due</span>
          {i === 0 && f.overdue > 0 && <span className="ml-2 text-destructive font-medium">{f.overdue.toLocaleString()} overdue</span>}</span>
        {i === 0 && <span className="text-muted-foreground">{ahead.toLocaleString()} due in the next {f.horizonDays} days</span>}
      </span>
    );
  };
  return (
    <Card className="p-4 mt-3">
      <div {...dc.surface} className="rounded-md"
        aria-label={`Reviews over the next ${f.horizonDays} days: ${f.overdue.toLocaleString()} overdue, ${ahead.toLocaleString()} due; ${f.days.map((d) => `${d.date} ${d.due}`).join(", ")}`}>
        <div className="flex items-end gap-1" style={{ height: H }}>
          {f.days.map((d, i) => {
            const od = i === 0 ? f.overdue : 0;
            const hDue = d.due ? Math.max(3, (H * d.due) / max) : 0;
            const hOd = od ? Math.max(3, (H * od) / max) : 0;
            const act = dc.active === i;
            return (
              <div key={d.date} {...dc.mark(i)} className="flex-1 min-w-0 h-full flex flex-col justify-end">
                {/* a zero day keeps a hairline so the fortnight reads as fourteen days, not as gaps */}
                <div className="w-full flex flex-col overflow-hidden" style={{
                  height: hDue + hOd || 2, borderRadius: hDue + hOd ? "4px 4px 0 0" : 1,
                  background: hDue + hOd ? undefined : EMPTY,
                  outline: act ? ACTIVE_RING : undefined, outlineOffset: 1,
                }}>
                  {hOd > 0 && <div style={{ height: hOd, background: "hsl(var(--destructive))" }} />}
                  {hDue > 0 && <div style={{ height: hDue, background: SOLID }} />}
                </div>
              </div>
            );
          })}
        </div>
        <div className="flex gap-1 mt-1" aria-hidden>
          {f.days.map((d, i) => (
            <div key={d.date} className="flex-1 min-w-0 flex justify-center">
              {i === 0 && <span className="block h-[3px] w-3 rounded-full bg-foreground/70" />}
            </div>
          ))}
        </div>
        <ChartTip cursor={dc}>{dc.active != null && tip(dc.active)}</ChartTip>
      </div>
    </Card>
  );
}

function Stat({ n, label, accent, alarm, mark, active }: {
  n: string; label: string; accent?: boolean; alarm?: boolean; mark?: { "data-datum": number }; active?: boolean;
}) {
  return (
    <Card {...mark} className={"p-4 " + (accent ? "border-primary/40" : "")}
      style={active ? { outline: ACTIVE_RING, outlineOffset: 1 } : undefined}>
      <div className={"nums text-[22px] font-semibold tracking-tight " + (alarm ? "text-destructive" : "")}>{n}</div>
      <div className="mt-0.5 text-[12px] text-muted-foreground">{label}</div>
    </Card>
  );
}
