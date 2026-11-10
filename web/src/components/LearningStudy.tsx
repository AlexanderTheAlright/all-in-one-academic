
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { GraduationCap, X, Eye, MousePointerClick, Target, CornerDownLeft, Flag } from "lucide-react";
import { toast } from "sonner";
import { api, learningAssetUrl, snapWidth, type FlashCard, type Hotspot } from "@/lib/api";
import { warmSeq } from "@/lib/imgwarm";

const RATINGS: { key: string; label: string; hint: string; cls: string }[] = [
  { key: "again", label: "Again", hint: "1", cls: "bg-destructive/10 border-destructive/50 text-destructive hover:bg-destructive/20" },
  { key: "hard", label: "Hard", hint: "2", cls: "border-border hover:border-amber-500/60 hover:text-amber-600" },
  { key: "good", label: "Good", hint: "3", cls: "border-border hover:border-primary/60 hover:text-primary" },
  { key: "easy", label: "Easy", hint: "4", cls: "border-border hover:border-emerald-500/60 hover:text-emerald-600" },
];

// deck/module breadcrumb, kept in sync with Learning.tsx's labelling
const ACRONYMS = new Set(["ai", "ml", "nlp", "dna", "rna", "atp", "adp", "gdp", "us", "uk", "eu", "ph", "uv", "hgt"]);
const SMALL = new Set(["and", "or", "of", "the", "in", "to", "a", "an", "for", "with", "vs", "on", "at", "by"]);
function titleize(s: string): string {
  return s.replace(/[-_]/g, " ").trim().split(/\s+/).filter(Boolean).map((w, i) => {
    const lw = w.toLowerCase();
    if (ACRONYMS.has(lw)) return lw.toUpperCase();
    if (i > 0 && SMALL.has(lw)) return lw;
    return lw.charAt(0).toUpperCase() + lw.slice(1);
  }).join(" ");
}
const SUB_LABEL = (sub: string) =>
  sub.split("/").map((seg, i) => (i === 0 ? titleize(seg) : titleize(seg.replace(/^\d+[-_]/, "")) || "General")).join(" › ");

// ---- image embeds -> names + the remaining prose ----------------------------
const EMBED_RE = /!\[\[([^\]|]+?)(?:\|[^\]]*)?\]\]|!\[[^\]]*\]\(([^)]+)\)/g;
function extractImages(text: string): { images: string[]; text: string } {
  const images: string[] = [];
  const cleaned = (text || "").replace(EMBED_RE, (_m, wl, md) => {
    const name = String(wl || md || "").split("|")[0].trim();
    if (name) images.push(name.split("/").pop() || name);
    return "";
  }).replace(/\n{3,}/g, "\n\n").trim();
  return { images, text: cleaned };
}

// ---- markdown-lite inline renderer (**bold**, *italic*, cloze [ … ]) --------
function Rich({ text, className }: { text: string; className?: string }) {
  const nodes: React.ReactNode[] = [];
  const re = /\*\*([^*]+)\*\*|\*([^*]+)\*|(\[…\]|\[\.\.\.\])/g;
  let last = 0, m: RegExpExecArray | null, k = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    if (m[1]) nodes.push(<strong key={k++} className="font-semibold text-foreground">{m[1]}</strong>);
    else if (m[2]) nodes.push(<em key={k++}>{m[2]}</em>);
    else nodes.push(<span key={k++} className="inline-block min-w-[2.6em] mx-0.5 px-1 rounded bg-primary/15 text-primary font-semibold text-center">…</span>);
    last = m.index + m[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return <span className={"whitespace-pre-wrap " + (className || "")}>{nodes}</span>;
}

function inHotspot(h: Hotspot, fx: number, fy: number): boolean {
  if (typeof h.w === "number" && typeof h.h === "number")
    return fx >= h.x && fx <= h.x + h.w && fy >= h.y && fy <= h.y + h.h;
  const r = h.r ?? 0.09;
  return Math.hypot(fx - h.x, fy - h.y) <= r;
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const AIM_KEYS: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

function CardFigure({ card, name, w, hotspots, armed, revealed, onReveal, onHit, onMiss }: {
  card: FlashCard; name: string;
  w: number;
  hotspots?: Hotspot[];
  armed?: boolean;            // front figure, challenge not yet answered
  revealed?: boolean;         // reveal correct regions
  onReveal?: () => void;      // plain image cards: click anywhere on the figure to reveal
  onHit?: (h: Hotspot) => void; onMiss?: (x: number, y: number) => void;
}) {
  const [miss, setMiss] = useState<{ x: number; y: number } | null>(null);
  const [aim, setAim] = useState<{ x: number; y: number } | null>(null);   // keyboard crosshair
  const hasSpots = Boolean(hotspots && hotspots.length);
  const live = Boolean(armed) && !revealed;   // the figure is interactive until revealed
  useEffect(() => { if (!live) setAim(null); }, [live]);
  const answer = (fx: number, fy: number) => {
    const hit = (hotspots || []).find((h) => inHotspot(h, fx, fy));
    if (hit) { setMiss(null); onHit?.(hit); }
    else { setMiss({ x: fx, y: fy }); onMiss?.(fx, fy); }
  };
  const click = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!live) return;
    if (!hasSpots) { onReveal?.(); return; }   // "click to find out" on a plain image card
    const r = e.currentTarget.getBoundingClientRect();
    answer((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
  };
  const key = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!live || e.target !== e.currentTarget || e.metaKey || e.ctrlKey || e.altKey) return;
    const press = e.key === "Enter" || e.key === " ";
    if (!hasSpots || !aim) {
      if (!press) return;
      e.preventDefault();
      if (hasSpots) setAim({ x: 0.5, y: 0.5 }); else onReveal?.();
      return;
    }
    const d = AIM_KEYS[e.key], s = e.shiftKey ? 0.01 : 0.04;
    if (d) { e.preventDefault(); setAim({ x: clamp01(aim.x + d[0] * s), y: clamp01(aim.y + d[1] * s) }); }
    else if (press) { e.preventDefault(); answer(aim.x, aim.y); }
    else if (e.key === "Escape") { e.preventDefault(); setAim(null); }
  };
  return (
    <div className="flex justify-center">
      <div onClick={click} onKeyDown={key} onBlur={() => setAim(null)}
        role={live ? "button" : undefined} tabIndex={live ? 0 : undefined}
        aria-label={live ? (hasSpots ? "Find it on the figure" : "Reveal the answer") : undefined}
        title={live && hasSpots ? "Enter to aim" : undefined}
        className={"relative inline-block rounded-lg overflow-hidden bg-white ring-1 ring-border " + (live ? (hasSpots ? "cursor-crosshair" : "cursor-pointer") : "")}>
        {/* no src until the width is known (it is, before the first paint): asking at a
            guessed width and then the real one would be two downloads of one picture */}
        <img src={w > 0 ? learningAssetUrl(card.path, name, w) : undefined} alt="" draggable={false}
          className="block max-h-[46vh] max-w-full select-none" />
        {/* correct regions, shown on reveal */}
        {revealed && (hotspots || []).map((h, i) => {
          const box = typeof h.w === "number" && typeof h.h === "number";
          const style: React.CSSProperties = box
            ? { left: `${h.x * 100}%`, top: `${h.y * 100}%`, width: `${(h.w || 0) * 100}%`, height: `${(h.h || 0) * 100}%` }
            : { left: `${(h.x - (h.r ?? 0.09)) * 100}%`, top: `${(h.y - (h.r ?? 0.09)) * 100}%`, width: `${(h.r ?? 0.09) * 200}%`, height: `${(h.r ?? 0.09) * 200}%` };
          return (
            <span key={i} style={style}
              className={"absolute pointer-events-none ring-2 ring-emerald-500 bg-emerald-400/20 " + (box ? "rounded-md" : "rounded-full")}>
              {h.label && <span className="absolute -top-5 left-0 whitespace-nowrap text-[10px] font-semibold text-emerald-700 bg-emerald-100 px-1 rounded">{h.label}</span>}
            </span>
          );
        })}
        {/* miss ping */}
        {miss && !revealed && (
          <span style={{ left: `${miss.x * 100}%`, top: `${miss.y * 100}%` }}
            className="absolute -translate-x-1/2 -translate-y-1/2 h-6 w-6 rounded-full border-2 border-destructive animate-ping pointer-events-none" />
        )}
        {/* keyboard crosshair */}
        {aim && live && (
          <span style={{ left: `${aim.x * 100}%`, top: `${aim.y * 100}%` }}
            className="absolute -translate-x-1/2 -translate-y-1/2 h-8 w-8 rounded-full border-2 border-primary bg-primary/10 ring-2 ring-white/80 pointer-events-none flex items-center justify-center">
            <span className="h-1.5 w-1.5 rounded-full bg-primary" />
          </span>
        )}
      </div>
    </div>
  );
}

function useOwnWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [w, setW] = useState(-1);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setW(Math.round(el.getBoundingClientRect().width));
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

// ---- normalize for the typed-answer soft hint -------------------------------
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, "").replace(/\s+/g, " ").trim();

export type StudyOptions = { typed?: boolean };

export function StudySession({ card, index, total, label, options, upcoming, onRate, onEnd }: {
  card: FlashCard; index: number; total: number; label: string;
  options?: StudyOptions;
  upcoming?: FlashCard[];     // the next cards in the queue, whose pictures are fetched ahead
  onRate: (response: string) => void; onEnd: () => void;
}) {
  const [revealed, setRevealed] = useState(false);
  const [typedVal, setTypedVal] = useState("");
  const [missed, setMissed] = useState(0);
  const [flagged, setFlagged] = useState(false);
  const [flagOpen, setFlagOpen] = useState(false);
  const [reason, setReason] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const showRef = useRef<HTMLButtonElement>(null);
  const goodRef = useRef<HTMLButtonElement>(null);
  const flagRef = useRef<HTMLButtonElement>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);

  const front = useMemo(() => extractImages(card.front), [card.front]);
  const back = useMemo(() => extractImages(card.back), [card.back]);
  const isImage = Boolean(card.hasImage) && front.images.length > 0;
  const hasSpots = Boolean(card.hotspots && card.hotspots.length);
  const typed = Boolean(options?.typed) && !hasSpots;   // typing a region makes no sense

  // reset per card
  const cid = card.path + "#" + card.ord;
  useEffect(() => { setRevealed(false); setTypedVal(""); setMissed(0); setFlagged(false); setFlagOpen(false); setReason(""); }, [cid]);
  useEffect(() => { if (typed && !revealed) inputRef.current?.focus(); }, [cid, typed, revealed]);

  const reveal = useCallback(() => setRevealed(true), []);
  const rate = useCallback((r: string) => { onRate(r); }, [onRate]);

  const send = useCallback(async (opts: { reason?: string; clear?: boolean }) => {
    return api.learningFlag(
      { path: card.path, ord: card.ord, deck: card.deck, front: card.front },
      opts,
    );
  }, [card.path, card.ord, card.deck, card.front]);

  // one press flags it; the composer then opens for the optional reason
  const flag = useCallback(async () => {
    if (flagged) { setFlagOpen((o) => !o); return; }
    setFlagged(true); setFlagOpen(true);
    try { await send({}); toast.success("Flagged for correction"); }
    catch { setFlagged(false); setFlagOpen(false); toast.error("Couldn't flag this card"); }
  }, [flagged, send]);

  const saveReason = useCallback(async () => {
    setFlagOpen(false);
    try { await send({ reason }); toast.success(reason.trim() ? "Correction noted" : "Flagged for correction"); }
    catch { toast.error("Couldn't save the note"); }
    flagRef.current?.focus({ preventScroll: true });
  }, [reason, send]);

  const unflag = useCallback(async () => {
    setFlagged(false); setFlagOpen(false); setReason("");
    try { await send({ clear: true }); toast.success("Flag removed"); }
    catch { setFlagged(true); toast.error("Couldn't remove the flag"); }
    flagRef.current?.focus({ preventScroll: true });
  }, [send]);

  useEffect(() => { if (flagOpen) reasonRef.current?.focus({ preventScroll: true }); }, [flagOpen]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      const field = !!t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable);
      if (e.key === "Escape") {
        if (field && !t.hasAttribute("data-knav-armed")) return;
        e.preventDefault(); onEnd(); return;
      }
      if (field) return;
      // f flags the card for correction — no control responds to it, so it works
      // wherever focus sits (Show answer, a grade button, the figure)
      if (e.key === "f" || e.key === "F") { e.preventDefault(); void flag(); return; }
      const control = !!t?.closest?.("button, a[href], summary, [role=button], [role=checkbox], [role=link]");
      if (!revealed && !control && (e.key === " " || e.key === "Enter")) { e.preventDefault(); reveal(); return; }
      if (revealed && ["1", "2", "3", "4"].includes(e.key)) { e.preventDefault(); rate(RATINGS[+e.key - 1].key); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [revealed, reveal, rate, onEnd, flag]);

  // while the keyboard drives, keep focus on what comes next (Show answer, then
  // Good) so Enter, Enter walks a session and the arrows pick another grade
  useEffect(() => {
    if (!document.documentElement.hasAttribute("data-knav")) return;
    const a = document.activeElement as HTMLElement | null;
    if (a && a !== document.body && !rootRef.current?.contains(a)) return;
    if (a && (a.tagName === "INPUT" || (!revealed && a.getAttribute("role") === "button"))) return;
    (revealed ? goodRef : showRef).current?.focus({ preventScroll: true });
  }, [cid, revealed]);

  const match = typed && revealed && norm(typedVal) && norm(back.text).includes(norm(typedVal));

  // the prompt shown on the front (image cards get a default "What is this?")
  const frontPrompt = front.text || (isImage ? "What is this an image of?" : "");

  // tiers by the session's own width (0 before the first measure reads as roomy)
  const width = useOwnWidth(rootRef);
  const compact = width > 0 && width < 560;
  const tiny = width > 0 && width < 360;

  const pad = compact ? 16 : width > 0 && width < 700 ? 24 : 32;
  const ratio = typeof devicePixelRatio === "number" && devicePixelRatio > 0 ? devicePixelRatio : 1;
  const imgW = width < 0 ? 0 : width === 0 ? 960 : Math.min(1280, snapWidth(width - 2 * pad - 2, ratio));

  const ahead = useRef(upcoming);
  useLayoutEffect(() => { ahead.current = upcoming; });
  const upKey = (upcoming ?? []).map((c) => c.path + "#" + c.ord).join("|");
  useEffect(() => {
    if (imgW <= 0) return;
    const next = ahead.current ?? [];
    const urls = (path: string, names: string[]) => names.map((n) => learningAssetUrl(path, n, imgW));
    const list = [
      ...urls(card.path, front.images),
      ...urls(card.path, back.images),
      ...next.flatMap((c) => urls(c.path, extractImages(c.front).images)),
      ...next.flatMap((c) => urls(c.path, extractImages(c.back).images)),
    ];
    if (!list.length) return;
    let alive = true;
    void warmSeq(list, { alive: () => alive });
    return () => { alive = false; };
  }, [cid, imgW, upKey, card.path, front.images, back.images]);

  return (
    <div ref={rootRef} className="max-w-[820px] mx-auto min-w-0">
      <div className={"flex items-center justify-between gap-3 " + (compact ? "mb-3" : "mb-4")}>
        <div className="min-w-0 text-[12px] text-muted-foreground uppercase tracking-[0.1em] font-semibold flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <GraduationCap size={14} className="shrink-0" /> <span className="min-w-0 truncate" title={label}>{label}</span>
          {isImage && <span className="normal-case tracking-normal inline-flex items-center gap-1 text-primary/80"><MousePointerClick size={12} /> image</span>}
          {hasSpots && <span className="normal-case tracking-normal inline-flex items-center gap-1 text-amber-600"><Target size={12} /> find it</span>}
        </div>
        <button type="button" onClick={onEnd} data-knav-back title="End session" aria-label="End session"
          className="shrink-0 whitespace-nowrap text-[12px] text-muted-foreground hover:text-foreground flex items-center gap-1"><X size={13} />{!tiny && " End session"}</button>
      </div>
      <div className={"h-1 rounded-full bg-secondary overflow-hidden " + (compact ? "mb-3" : "mb-5")}>
        <div className="h-full bg-primary transition-all" style={{ width: `${(index / total) * 100}%` }} />
      </div>

      <Card className={"min-h-[min(300px,45vh)] flex flex-col " + (compact ? "p-4 gap-3" : width > 0 && width < 700 ? "p-6 gap-4" : "p-8 gap-4")}>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground nums">
          <span>{index + 1} / {total}</span>
          <span className="opacity-40">·</span>
          <span>{SUB_LABEL(card.sub)}</span>
          {card.new && <span className="px-1.5 py-0.5 rounded-full bg-primary/10 text-primary text-[10px] font-semibold">new</span>}
          {flagged && (
            <span title="Flagged — the next card batch corrects it"
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-600 text-[10px] font-semibold">
              <Flag size={9} /> flagged
            </span>
          )}
        </div>

        {/* FRONT */}
        {front.images.map((name, i) => (
          <CardFigure key={name + i} card={card} name={name} w={imgW}
            hotspots={i === 0 ? card.hotspots : undefined}
            armed={!revealed} revealed={revealed}
            onReveal={reveal}
            onHit={() => reveal()}
            onMiss={() => setMissed((m) => m + 1)} />
        ))}
        {frontPrompt && <div className={(compact ? "text-[17px]" : "text-[19px]") + " leading-relaxed text-center break-words"}><Rich text={frontPrompt} /></div>}

        {hasSpots && !revealed && missed > 0 && (
          <div className="text-center text-[12px] text-muted-foreground">
            Not there — try again{missed >= 2 && <> · or <button onClick={reveal} className="underline hover:text-foreground">show me</button></>}
          </div>
        )}

        {/* BACK */}
        {revealed && (
          <div className="mt-1 pt-4 border-t border-border space-y-3">
            {back.images.map((name, i) => <CardFigure key={"b" + name + i} card={card} name={name} w={imgW} />)}
            {back.text && <div className={(compact ? "text-[15px]" : "text-[16px]") + " leading-relaxed text-foreground/90 break-words"}><Rich text={back.text} /></div>}
            {match && <div className="text-[12px] text-emerald-600 flex items-center gap-1">✓ your answer matches</div>}
          </div>
        )}
      </Card>

      {/* CONTROLS — the flag sits beside them, never in the header */}
      <div className={compact ? "mt-3" : "mt-5"}>
       <div className="flex items-stretch gap-2">
        <div className="min-w-0 flex-1">
          {!revealed ? (
            typed ? (
              <form onSubmit={(e) => { e.preventDefault(); reveal(); }} className="flex gap-2">
                <input ref={inputRef} value={typedVal} onChange={(e) => setTypedVal(e.target.value)}
                  placeholder="Type your answer…"
                  className={"min-w-0 flex-1 rounded-lg border border-border bg-background outline-none focus:border-primary/60 " + (compact ? "px-3 py-2.5 text-[14px]" : "px-3.5 py-3 text-[15px]")} />
                <Button type="submit" size={compact ? "default" : "lg"} className="gap-2 shrink-0" title="Check"><CornerDownLeft size={15} />{!tiny && " Check"}</Button>
              </form>
            ) : (
              <Button ref={showRef} className="w-full gap-2" size={compact ? "default" : "lg"} onClick={reveal}
                title={isImage && !hasSpots ? "Reveal — or click the image" : undefined}>
                {hasSpots ? <><Target size={15} /> Reveal answer</>
                  : isImage ? <><Eye size={15} /> {compact ? "Reveal" : "Reveal — or click the image"}</>
                  : <><Eye size={15} /> Show answer</>}
                {!tiny && <kbd className="ml-1 text-[10px] bg-primary-foreground/20 px-1.5 py-0.5 rounded">space</kbd>}
              </Button>
            )
          ) : (
            <div className={"grid gap-2 " + (tiny ? "grid-cols-2" : "grid-cols-4")}>
              {RATINGS.map((r) => (
                <button key={r.key} type="button" ref={r.key === "good" ? goodRef : undefined} onClick={() => rate(r.key)}
                  className={`py-3 rounded-lg border text-[13px] font-medium transition-colors flex flex-col items-center gap-0.5 ${r.cls}`}>
                  {r.label}<kbd className="text-[9px] opacity-60">{r.hint}</kbd>
                </button>
              ))}
            </div>
          )}
        </div>
        <button type="button" ref={flagRef} onClick={() => void flag()} aria-pressed={flagged}
          aria-label={flagged ? "Flagged for correction" : "Flag this card for correction"}
          title={flagged ? "Flagged for correction — add a note, or remove it (f)"
                         : "Flag this card for correction — the next card batch fixes it (f)"}
          className={"shrink-0 px-3 rounded-lg border flex items-center justify-center transition-colors " +
            (flagged ? "border-amber-500/60 bg-amber-500/10 text-amber-600"
                     : "border-border text-muted-foreground hover:text-amber-600 hover:border-amber-500/50")}>
          <Flag size={16} />
        </button>
       </div>

        {/* the optional reason: inline, never a dialog and never a prompt() */}
        {flagOpen && (
          <div className="mt-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-2.5">
            <textarea ref={reasonRef} rows={2} value={reason} onChange={(e) => setReason(e.target.value)}
              data-knav-own="arrows enter escape"
              placeholder="What needs fixing? Optional — Ctrl+Enter saves"
              onKeyDown={(e) => {
                if (e.key === "Escape") { e.preventDefault(); setFlagOpen(false); flagRef.current?.focus({ preventScroll: true }); }
                else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void saveReason(); }
              }}
              className="w-full resize-none rounded-md border border-border bg-background px-2.5 py-2 text-[13px] outline-none focus:border-amber-500/60" />
            <div className="mt-2 flex items-center justify-end gap-2">
              <button type="button" onClick={() => void unflag()} title="Remove the flag from this card"
                className="text-[12px] text-muted-foreground hover:text-destructive">Remove flag</button>
              <button type="button" onClick={() => { setFlagOpen(false); flagRef.current?.focus({ preventScroll: true }); }}
                title="Keep the flag, close this note (Esc)"
                className="text-[12px] text-muted-foreground hover:text-foreground">Close</button>
              <Button size="sm" onClick={() => void saveReason()} title="Save this note (Ctrl+Enter)">Save</Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export { extractImages, Rich };
