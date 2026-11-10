
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, lazy, Suspense } from "react";
import { createPortal } from "react-dom";
import { api } from "@/lib/api";
import type { 
  DeckSlide, DraftProvStatus, DraftProvEntry, DraftFileView,
  FigureComment } from "@/lib/api";
import { lineDiff, diffCounts } from "@/lib/anchors";
import { Markdown } from "@/lib/markdown";

const CodeView = lazy(() => import("@/lib/codeView").then((m) => ({ default: m.CodeView })));
import { Plus, X, AlertTriangle, ChevronLeft, Check,
  ListOrdered, Minus,
  ChevronRight, Trash2, MessageSquarePlus, Undo2, Eye, Image as ImageIcon,
  FlaskConical, FileCode, Database, Binary, Table2, SquareDashed, SlidersHorizontal, Bot,
  PanelRightOpen, PanelRightClose,
} from "lucide-react";

export const SERIF = "'Noto Serif', Georgia, 'Liberation Serif', serif";

export function projectRelOf(vaultRel?: string | null): string | null {
  const m = /^Projects\/(papers|grants|briefs|experiments)\/([^/]+)(?:\/([^/]+))?/.exec(
    (vaultRel || "").replace(/\\/g, "/"));
  if (!m) return null;
  // papers/archive and grants/archive are shelves; the project is the directory inside
  if ((m[1] === "papers" || m[1] === "grants") && m[2] === "archive") {
    return m[3] ? `${m[1]}/archive/${m[3]}` : null;
  }
  return `${m[1]}/${m[2]}`;
}

// Escape from a field someone is typing in only stops the typing: the arrow engine
// re-arms the field, and the overlay's own Escape acts on the next press
export function typingEscape(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (!t || typeof t.closest !== "function" || t.closest("[data-knav-armed]")) return false;
  if (t.closest(".cm-content, textarea, [contenteditable=''], [contenteditable='true']")) return true;
  return t.tagName === "INPUT" && !/^(checkbox|radio|button|submit|reset|range|color|file)$/i.test((t as HTMLInputElement).type);
}

export function pdfFindKey(e: KeyboardEvent, pdf: HTMLIFrameElement | null | undefined): boolean {
  if (!pdf || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== "f") return false;
  const box = pdf.closest("[data-pdf-find]");
  if (!box) return false;
  e.preventDefault(); e.stopPropagation();
  box.dispatchEvent(new CustomEvent("pdf-find-open"));
  return true;
}

type PdfHit = { page: number; before: string; match: string; after: string };

/** A source PDF in the browser viewer, opened at `page`, with the Board's own find bar. */
export function PdfFindFrame({ rel, page, title, iframeProps }: {
  rel: string; page: number; title: string; iframeProps?: Record<string, unknown>;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<PdfHit[] | null>(null);
  const [idx, setIdx] = useState(0);
  const [jump, setJump] = useState<number | null>(null);
  const [asked, setAsked] = useState(0);
  useEffect(() => { setJump(null); }, [rel, page]);
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const h = () => { setOpen(true); setAsked((n) => n + 1); };
    box.addEventListener("pdf-find-open", h);
    return () => box.removeEventListener("pdf-find-open", h);
  }, []);
  useEffect(() => { if (asked) { inputRef.current?.focus(); inputRef.current?.select(); } }, [asked]);
  useEffect(() => {
    const h = () => window.setTimeout(() => {
      const box = boxRef.current;
      if (box && document.activeElement && document.activeElement.tagName === "IFRAME" && box.contains(document.activeElement))
        box.focus({ preventScroll: true });
    }, 0);
    window.addEventListener("blur", h);
    return () => window.removeEventListener("blur", h);
  }, []);
  useEffect(() => {
    if (!open || q.trim().length < 2) { setHits(null); return; }
    let live = true;
    const t = window.setTimeout(() => {
      api.draftingSourcePdfFind(rel, q).then((r) => {
        if (!live) return;
        const hs = r.hits || [];
        setHits(hs); setIdx(0);
        if (hs.length) setJump(hs[0].page);
      }).catch(() => live && setHits([]));
    }, 220);
    return () => { live = false; window.clearTimeout(t); };
  }, [open, q, rel]);
  const step = (d: number) => {
    if (!hits?.length) return;
    const i = (idx + d + hits.length) % hits.length;
    setIdx(i); setJump(hits[i].page);
  };
  const close = () => { setOpen(false); boxRef.current?.focus({ preventScroll: true }); };
  const shown = jump ?? page;
  const src = api.draftingSourcePdfUrl(rel) + "#page=" + shown + "&zoom=page-width";
  const hit = hits?.[idx];
  return (
    <div ref={boxRef} tabIndex={-1} data-pdf-find data-native-find className="relative w-full h-full outline-none">
      <iframe key={src} src={src} title={title} className="w-full h-full border-0" {...iframeProps} />
      {open && (
        <div data-pdf-find-bar className="absolute top-2 right-3 z-10 w-[min(440px,calc(100%-24px))] rounded-md border border-border bg-popover text-popover-foreground shadow-lg text-[12px]">
          <div className="flex items-center gap-1.5 px-2 py-1.5">
            <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find in PDF" aria-label="Find in PDF"
              className="min-w-0 flex-1 bg-transparent outline-none px-1 text-[12.5px]"
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
                else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
                else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") { e.preventDefault(); e.currentTarget.select(); }
              }} />
            <span className="shrink-0 nums text-muted-foreground">
              {hits === null ? "" : hits.length ? `${idx + 1} / ${hits.length} · p.${hit?.page}` : "No match"}</span>
            <button type="button" onClick={() => step(-1)} disabled={!hits?.length} aria-label="Previous match" title="Previous match (Shift+Enter)" className="text-muted-foreground hover:text-foreground disabled:opacity-40"><ChevronLeft size={14} /></button>
            <button type="button" onClick={() => step(1)} disabled={!hits?.length} aria-label="Next match" title="Next match (Enter)" className="text-muted-foreground hover:text-foreground disabled:opacity-40"><ChevronRight size={14} /></button>
            <button type="button" onClick={close} aria-label="Close find" title="Close (Esc)" className="text-muted-foreground hover:text-foreground"><X size={14} /></button>
          </div>
          {hit && (
            <div className="px-3 pb-2 pt-0.5 border-t border-border/60 leading-snug text-foreground/80">
              {hit.before}<mark className="bg-primary/25 text-foreground rounded-sm">{hit.match}</mark>{hit.after}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function DivergenceBanner({ state, onViewDiff, onUndo, onTakeTheirs, onKeepMine, onDismiss }: {
  state: { kind: "applied" | "conflict"; oldText: string; newText: string; diskMtime: number };
  onViewDiff: () => void; onUndo: () => void; onTakeTheirs: () => void; onKeepMine: () => void; onDismiss: () => void;
}) {
  const counts = useMemo(() => diffCounts(lineDiff(state.oldText, state.newText)), [state.oldText, state.newText]);
  const applied = state.kind === "applied";
  return (
    <div data-diverge-banner className={`absolute top-0 inset-x-0 z-[60] flex items-center gap-3 px-4 py-2 border-b text-[12.5px] bg-background ${applied ? "border-primary/30" : "border-amber-500/40"}`}
      style={{ backgroundImage: applied ? "linear-gradient(hsl(var(--primary) / 0.1), hsl(var(--primary) / 0.1))" : "linear-gradient(rgb(245 158 11 / 0.1), rgb(245 158 11 / 0.1))" }}>
      <AlertTriangle size={14} className={applied ? "text-primary" : "text-amber-500"} />
      <span className="text-foreground/90">
        {applied ? "Updated from disk." : "This draft changed on disk while you have unsaved edits."}
        <span className="text-muted-foreground"> +{counts.added}/−{counts.removed} lines.</span>
      </span>
      <span className="flex-1" />
      <button onClick={onViewDiff} className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1 hover:text-foreground"><Eye size={12} /> View changes</button>
      {applied ? (
        <button onClick={onUndo} className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1 hover:text-foreground"><Undo2 size={12} /> Undo (keep mine)</button>
      ) : (
        <>
          <button onClick={onKeepMine} className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1 hover:text-foreground">Keep mine</button>
          <button onClick={onTakeTheirs} className="inline-flex items-center gap-1 rounded-md border border-primary/40 text-primary px-2 py-1 hover:bg-primary/10">Take theirs</button>
        </>
      )}
      <button onClick={onDismiss} className="text-muted-foreground hover:text-foreground" title="Dismiss"><X size={14} /></button>
    </div>
  );
}

// a full-screen redline of an external change (old → new), line-level

export const PROV_CHIP: Record<DraftProvStatus, { label: string; cls: string }> = {
  fresh: { label: "fresh", cls: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" },
  stale: { label: "stale", cls: "bg-amber-500/15 text-amber-600 dark:text-amber-400" },
  none: { label: "no provenance", cls: "bg-rose-500/15 text-rose-600 dark:text-rose-400" },
  external: { label: "external", cls: "bg-secondary text-muted-foreground" },
};

export function ProvChip({ status }: { status: DraftProvStatus }) {
  const c = PROV_CHIP[status] ?? PROV_CHIP.none;
  return <span className={`inline-flex items-center rounded-full px-1.5 py-px text-[9.5px] font-medium ${c.cls}`}>{c.label}</span>;
}

/** One results-asset thumbnail: figures via /drafting/asset (png else svg), tables via the
 * typeset table-png route. Falls back to a kind glyph when nothing renders. */

export function fmtBytes(n: number): string {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / (1024 * 1024)).toFixed(1) + " MB";
}

export function FigureLightbox({ slug, stem, kind, gallery, onNavigate, initial, prov, stamp, onSave, onClose, onViewFile, blockKeys, imageSrc, toolbar, editPanel, sourcePanel, onToAgent, imageSurface = "white", railOpen, onRailOpen, fit = false, header, wrap = false }: {
  slug: string; stem: string; kind: "figure" | "table";
  gallery: { stem: string; kind: "figure" | "table" }[];
  onNavigate: (stem: string, kind: "figure" | "table") => void;
  wrap?: boolean;        // ← → go round from the last to the first (the IDE pane); Drafting stops at the ends
  initial: FigureComment[]; prov?: DraftProvEntry;
  /* this figure's results/ stamp from /drafting/doc-status, keyed by the file name the
   * caller looks up (<stem>.png). Optional: with none, the url is exactly what it was. */
  stamp?: string | null;
  onSave: (items: FigureComment[]) => void; onClose: () => void;
  onViewFile: (candidates: string[], title: string) => void;
  blockKeys?: boolean;   // a file viewer is docked over the lightbox — let it own Esc/arrows
  imageSrc?: string;     // the figure window passes its own picture URL
  toolbar?: ReactNode;   // extra header controls (the figure window's follow / script / Drafting)
  
  editPanel?: ReactNode;
  sourcePanel?: ReactNode;
  onToAgent?: (id: string) => void;     // queue one comment for an agent
  
  imageSurface?: "white" | "card";
  
  railOpen?: boolean;
  onRailOpen?: (open: boolean) => void;
  fit?: boolean;
  
  header?: ReactNode;
}) {
  const [items, setItems] = useState<FigureComment[]>(initial);
  const railCtl = railOpen !== undefined;
  const showRail = railCtl ? !!railOpen : true;
  const railRef = useRef({ railCtl, showRail, onRailOpen });
  railRef.current = { railCtl, showRail, onRailOpen };
  const toggleRail = () => { const r = railRef.current; if (r.railCtl) r.onRailOpen?.(!r.showRail); };
  // the viewer's own box and the picture's natural size, for `fit`
  const scrollRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!fit || !el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit]);
  const [rail, setRail] = useState<"comments" | "provenance" | "edit" | "source">("comments");
  const [zoom, setZoom] = useState(1);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [body, setBody] = useState("");
  const [showResolved, setShowResolved] = useState(false);
  const [dragBox, setDragBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  // the keyboard twin of the drag: `r` puts a box on the image, arrows move it, Shift+arrows
  // resize it, ⏎ pins it through the same draft the drag makes, Esc cancels
  const [kbdBox, setKbdBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const regionFrom = useRef<HTMLElement | null>(null);
  const regionBtnRef = useRef<HTMLButtonElement>(null);
  // the one way a region or point becomes a draft pin: the drag's mouseup and the keyboard's ⏎
  const pinDraft = (r: { x: number; y: number; w: number; h: number }) => {
    setActiveId(null); setBody(""); setDraft(r);
    const rr = railRef.current;
    if (rr.railCtl && !rr.showRail) rr.onRailOpen?.(true);   // the comment box lives in the rail
  };
  const startKbdRegion = () => {
    const a = document.activeElement as HTMLElement | null;
    regionFrom.current = a && a !== document.body && a.isConnected ? a : regionBtnRef.current;
    setRail("comments"); setActiveId(null); setDraft(null); setBody("");
    setKbdBox({ x: 0.35, y: 0.35, w: 0.3, h: 0.3 });
  };
  const backToOpener = () => {
    const el = regionFrom.current; regionFrom.current = null;
    if (el && el.isConnected) window.setTimeout(() => el.focus({ preventScroll: true }), 0);
  };

  // gallery position — flip to the prev/next results asset in place
  const idx = gallery.findIndex((g) => g.stem === stem);
  const round = wrap && idx >= 0 && gallery.length > 1;
  const hasPrev = round || idx > 0;
  const hasNext = round || (idx >= 0 && idx < gallery.length - 1);
  const go = useCallback((delta: number) => {
    if (idx < 0) return;
    const n = gallery[round ? (idx + delta + gallery.length) % gallery.length : idx + delta];
    if (n) onNavigate(n.stem, n.kind);
  }, [gallery, idx, onNavigate, round]);

  useEffect(() => { setItems(initial); }, [initial]);
  
  useEffect(() => {
    if (!fit) return;
    const a = document.activeElement;
    if (a && a !== document.body && a.isConnected) return;
    scrollRef.current?.focus({ preventScroll: true });
  }, [fit, stem]);
  // arriving at another asset: drop any half-drawn pin and reset zoom to fit
  useEffect(() => { setActiveId(null); setDraft(null); setBody(""); setDragBox(null); setKbdBox(null); setZoom(1); }, [stem]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (blockKeys) return;   // a file viewer is on top — it handles Esc itself
      if (kbdBox) {   // region mode owns arrows, ⏎ and Esc until it pins or cancels
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setKbdBox(null); backToOpener(); return; }
        if (e.key === "Enter" && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault(); e.stopPropagation(); setKbdBox(null);
          pinDraft(kbdBox.w < 0.01 && kbdBox.h < 0.01 ? { x: kbdBox.x, y: kbdBox.y, w: 0, h: 0 } : kbdBox);
          return;
        }
        const d = ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as Record<string, [number, number]>)[e.key];
        if (d) {
          e.preventDefault(); e.stopPropagation();
          const step = e.altKey ? 0.005 : 0.02;
          const resize = e.shiftKey;
          setKbdBox((b) => !b ? b : resize
            ? { ...b, w: Math.max(0, Math.min(1 - b.x, b.w + d[0] * step)), h: Math.max(0, Math.min(1 - b.y, b.h + d[1] * step)) }
            : { ...b, x: Math.max(0, Math.min(1 - b.w, b.x + d[0] * step)), y: Math.max(0, Math.min(1 - b.h, b.y + d[1] * step)) });
        }
        return;
      }
      if (e.key === "Escape") { if (typingEscape(e)) return; e.preventDefault(); e.stopPropagation(); if (draft) { setDraft(null); setBody(""); backToOpener(); } else onClose(); return; }
      if ((e.key === "c" || e.key === "C") && railRef.current.railCtl && !e.ctrlKey && !e.metaKey && !e.altKey && !draft && !e.defaultPrevented && !typingEscape(e)) {
        e.preventDefault(); e.stopPropagation();
        toggleRail();
        return;
      }
      if (e.key === "r" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && !draft && !e.defaultPrevented && !typingEscape(e)) {
        e.preventDefault(); e.stopPropagation();
        startKbdRegion();
        return;
      }
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        const el = document.activeElement;   // don't hijack arrows while typing a comment
        if (draft || (el && /^(INPUT|TEXTAREA)$/.test(el.tagName))) return;
        if (el && (el as HTMLElement).closest?.("[data-figure-panel-header]")) return;
        if (fit && el && (el as HTMLElement).closest?.("[data-figure-bar]")) return;
        e.preventDefault(); e.stopPropagation();
        go(e.key === "ArrowLeft" ? -1 : 1);
      }
    };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [onClose, draft, go, blockKeys, kbdBox]);   // eslint-disable-line react-hooks/exhaustive-deps

  // the results stamp wins when the caller has one (it changes exactly when the file
  // changes); a hand-drawn diagram's save mtime stays the fallback
  const src = imageSrc ?? ((kind === "table" ? api.draftingTablePngUrl(slug, stem + ".csv") : api.draftingAssetUrl(slug, stem + ".png"))
    + (stamp ? "&v=" + encodeURIComponent(stamp) : prov?.diagram ? "&v=" + prov.diagram : ""));
  const isPoint = (c: { w: number; h: number }) => c.w < 0.005 && c.h < 0.005;
  const visible = items.filter((c) => showResolved || !c.resolved);
  const persist = (next: FigureComment[]) => { setItems(next); onSave(next); };
  const relCoords = (cx: number, cy: number) => {
    const r = imgRef.current?.getBoundingClientRect();
    if (!r || r.width === 0 || r.height === 0) return null;
    return { x: Math.max(0, Math.min(1, (cx - r.left) / r.width)), y: Math.max(0, Math.min(1, (cy - r.top) / r.height)) };
  };
  const onImgDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const start = relCoords(e.clientX, e.clientY); if (!start) return;
    dragRef.current = { x: start.x, y: start.y };
    const onMove = (ev: MouseEvent) => {
      const p = relCoords(ev.clientX, ev.clientY); if (!p || !dragRef.current) return;
      setDragBox({ x: Math.min(dragRef.current.x, p.x), y: Math.min(dragRef.current.y, p.y), w: Math.abs(p.x - dragRef.current.x), h: Math.abs(p.y - dragRef.current.y) });
    };
    const onUp = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp);
      const p = relCoords(ev.clientX, ev.clientY); const s = dragRef.current; dragRef.current = null; setDragBox(null);
      if (!p || !s) return;
      const w = Math.abs(p.x - s.x), h = Math.abs(p.y - s.y);
      pinDraft((w < 0.01 && h < 0.01) ? { x: s.x, y: s.y, w: 0, h: 0 } : { x: Math.min(s.x, p.x), y: Math.min(s.y, p.y), w, h });
    };
    window.addEventListener("mousemove", onMove); window.addEventListener("mouseup", onUp);
  };
  const commitDraft = () => {
    if (!draft || !body.trim()) return;
    const now = Date.now();
    const id = (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : "f" + now.toString(36) + Math.round(Math.random() * 1e6).toString(36);
    persist([...items, { id, x: draft.x, y: draft.y, w: draft.w, h: draft.h, body: body.trim(), resolved: false, author: "owner", created: now, updated: now }]);
    setDraft(null); setBody(""); setActiveId(id);
    backToOpener();   // a keyboard pin hands focus back to where `r` was pressed
  };
  const patch = (id: string, p: Partial<FigureComment>) => persist(items.map((c) => c.id === id ? { ...c, ...p, updated: Date.now() } : c));
  const remove = (id: string) => { persist(items.filter((c) => c.id !== id)); if (activeId === id) setActiveId(null); };

  return createPortal(
    <div role="dialog" aria-modal="true" aria-label={stem} data-knav-modal className="fixed inset-0 z-[140] flex bg-black/80 backdrop-blur-sm" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="relative flex-1 min-w-0 flex flex-col">
        {header && <div data-figure-panel-header className="shrink-0 bg-background text-foreground">{header}</div>}
        {gallery.length > 1 && hasPrev && (
          <button onClick={() => go(-1)} title="Previous result (←)"
            className="absolute left-2 top-1/2 -translate-y-1/2 z-[145] w-11 h-11 rounded-full bg-black/40 hover:bg-black/70 text-white/80 hover:text-white inline-flex items-center justify-center transition-colors"><ChevronLeft size={24} /></button>
        )}
        {gallery.length > 1 && hasNext && (
          <button onClick={() => go(1)} title="Next result (→)"
            className="absolute right-2 top-1/2 -translate-y-1/2 z-[145] w-11 h-11 rounded-full bg-black/40 hover:bg-black/70 text-white/80 hover:text-white inline-flex items-center justify-center transition-colors"><ChevronRight size={24} /></button>
        )}
        <div data-figure-bar className={fit ? "shrink-0 flex flex-wrap items-center gap-x-1 gap-y-0.5 px-2 py-1 text-white/90"
          : "shrink-0 flex items-center gap-2 px-4 py-2 text-white/90"}>
          {kind === "table" ? <ListOrdered size={15} className="opacity-70 shrink-0" /> : <ImageIcon size={15} className="opacity-70 shrink-0" />}
          <span className={`font-mono truncate ${fit ? "text-[12px] min-w-[4rem] max-w-[40%]" : "text-[13px] min-w-[7rem]"}`} title={stem}>{stem}</span>
          {!fit && <span className="text-white/40 text-[11px] shrink-0">{kind}</span>}
          {gallery.length > 1 && (
            <div className="flex items-center gap-1 ml-1">
              <button onClick={() => go(-1)} disabled={!hasPrev} title="Previous result (←)" className="w-7 h-7 rounded-md hover:bg-white/10 disabled:opacity-30 disabled:hover:bg-transparent inline-flex items-center justify-center"><ChevronLeft size={16} /></button>
              <span className="text-[11px] nums text-white/60 w-12 text-center">{idx < 0 ? "—" : `${idx + 1} / ${gallery.length}`}</span>
              <button onClick={() => go(1)} disabled={!hasNext} title="Next result (→)" className="w-7 h-7 rounded-md hover:bg-white/10 disabled:opacity-30 disabled:hover:bg-transparent inline-flex items-center justify-center"><ChevronRight size={16} /></button>
            </div>
          )}
          {toolbar}
          <span className="flex-1" />
          {railCtl && (
            <button type="button" onClick={toggleRail} data-figure-rail-toggle={showRail ? "open" : "closed"}
              aria-pressed={showRail} aria-expanded={showRail} aria-label="Comments and provenance"
              title={showRail ? "Hide comments and provenance (C)" : "Comments and provenance (C)"}
              className={`relative w-7 h-7 shrink-0 rounded-md hover:bg-white/10 inline-flex items-center justify-center ${showRail ? "bg-white/15" : ""}`}>
              {showRail ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}
              {!showRail && items.some((c) => !c.resolved) && (
                <span data-figure-rail-count className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] px-[3px] rounded-full bg-primary text-primary-foreground text-[9px] leading-[14px] nums text-center">
                  {items.filter((c) => !c.resolved).length}
                </span>
              )}
            </button>
          )}
          <button ref={regionBtnRef} type="button" onClick={startKbdRegion} aria-pressed={!!kbdBox}
            title="Flag a region (R) · arrows move, Shift+arrows resize, Enter pins, Esc cancels"
            className={`w-7 h-7 rounded-md hover:bg-white/10 inline-flex items-center justify-center ${kbdBox ? "bg-white/15" : ""}`}><SquareDashed size={15} /></button>
          <button onClick={() => setZoom((z) => Math.max(1, +(z - 0.25).toFixed(2)))} title="Zoom out" className="w-7 h-7 rounded-md hover:bg-white/10 inline-flex items-center justify-center"><Minus size={15} /></button>
          <span className="text-[11px] nums w-11 text-center">{Math.round(zoom * 100)}%</span>
          <button onClick={() => setZoom((z) => Math.min(5, +(z + 0.25).toFixed(2)))} title="Zoom in" className="w-7 h-7 rounded-md hover:bg-white/10 inline-flex items-center justify-center"><Plus size={15} /></button>
          <button type="button" onClick={onClose} data-knav-back="2" title="Close (Esc)" className="ml-2 w-8 h-8 rounded-md hover:bg-white/10 inline-flex items-center justify-center"><X size={18} /></button>
        </div>
        <div ref={scrollRef} data-figure-stage tabIndex={fit ? -1 : undefined} className={`flex-1 min-h-0 overflow-auto tinybar outline-none ${fit ? "p-1.5" : "p-6"}`}>
          <div className="relative mx-auto" style={{ width: fit && box && nat && nat.w > 0 && nat.h > 0
            ? `${Math.max(40, Math.min(box.w - 12, (box.h - 12) * nat.w / nat.h)) * zoom}px`
            : `${zoom * 100}%` }}>
            <img ref={imgRef} src={src} alt={stem} onMouseDown={onImgDown} draggable={false}
              onLoad={(e) => { const i = e.currentTarget; if (i.naturalWidth && i.naturalHeight) setNat({ w: i.naturalWidth, h: i.naturalHeight }); }}
              title={fit ? "Click a point or drag a region to pin a comment" : undefined}
              className={`block w-full h-auto rounded select-none ${imageSurface === "card" ? "bg-card" : "bg-white"}`} style={{ cursor: "crosshair" }} />
            {visible.map((c, i) => isPoint(c) ? (
              <button key={c.id} onClick={() => setActiveId(c.id)} title={c.body}
                className={`absolute -translate-x-1/2 -translate-y-1/2 rounded-full border-2 flex items-center justify-center text-[11px] font-semibold ${activeId === c.id ? "bg-amber-400 border-amber-600 text-black" : "bg-amber-500/90 border-white text-white"}`}
                style={{ left: `${c.x * 100}%`, top: `${c.y * 100}%`, width: 22, height: 22 }}>{i + 1}</button>
            ) : (
              <button key={c.id} onClick={() => setActiveId(c.id)} title={c.body}
                className={`absolute ${activeId === c.id ? "border-2 border-amber-500 bg-amber-400/25" : "border-2 border-amber-500/80 bg-amber-500/10"}`}
                style={{ left: `${c.x * 100}%`, top: `${c.y * 100}%`, width: `${c.w * 100}%`, height: `${c.h * 100}%` }}>
                <span className="absolute -top-3 -left-3 min-w-[20px] h-5 px-1 rounded-full bg-amber-500 border border-white text-white text-[11px] font-semibold flex items-center justify-center">{i + 1}</span>
              </button>
            ))}
            {dragBox && <div className="absolute border-2 border-primary bg-primary/20 pointer-events-none" style={{ left: `${dragBox.x * 100}%`, top: `${dragBox.y * 100}%`, width: `${dragBox.w * 100}%`, height: `${dragBox.h * 100}%` }} />}
            {kbdBox && <div data-region-kbd="" className="absolute border-2 border-dashed border-primary bg-primary/20 ring-1 ring-background pointer-events-none" style={{ left: `${kbdBox.x * 100}%`, top: `${kbdBox.y * 100}%`, width: `${kbdBox.w * 100}%`, height: `${kbdBox.h * 100}%`, minWidth: 8, minHeight: 8 }} />}
            {draft && (isPoint(draft)
              ? <div className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-primary bg-primary/70 pointer-events-none" style={{ left: `${draft.x * 100}%`, top: `${draft.y * 100}%`, width: 22, height: 22 }} />
              : <div className="absolute border-2 border-primary bg-primary/20 pointer-events-none" style={{ left: `${draft.x * 100}%`, top: `${draft.y * 100}%`, width: `${draft.w * 100}%`, height: `${draft.h * 100}%` }} />)}
          </div>
        </div>
        {!fit && <div className="shrink-0 px-4 py-1.5 text-center text-[11px] text-white/50">Click a point or drag a region to pin a comment{gallery.length > 1 ? " · ← → to move through results" : ""}</div>}
      </div>
      {showRail && (
      <div data-figure-rail className={`shrink-0 ${fit ? "w-[min(320px,45vw)]" : "w-[320px]"} h-full border-l border-white/10 bg-card flex flex-col`}>
        <div className="shrink-0 flex items-center gap-1 p-1.5 border-b border-border">
          <button onClick={() => setRail("comments")} className={`flex-1 inline-flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[12px] transition-colors ${rail === "comments" ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"}`}>
            <MessageSquarePlus size={13} /> Comments{items.filter((c) => !c.resolved).length > 0 && <span className="nums">({items.filter((c) => !c.resolved).length})</span>}
          </button>
          {editPanel && (
            <button onClick={() => setRail("edit")} title="Change this figure's chart spec and preview it"
              className={`shrink-0 inline-flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[12px] transition-colors ${rail === "edit" ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"}`}>
              <SlidersHorizontal size={13} /> Edit
            </button>
          )}
          {sourcePanel && (
            <button onClick={() => setRail("source")} title="Where the rows came from, and the code that made it"
              className={`shrink-0 inline-flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[12px] transition-colors ${rail === "source" ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"}`}>
              <Database size={13} /> Source
            </button>
          )}
          <button onClick={() => setRail("provenance")} title="The recorded provenance for this asset"
            className={`flex-1 inline-flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[12px] transition-colors ${rail === "provenance" ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"}`}>
            <FlaskConical size={13} /> {editPanel || sourcePanel ? "Prov" : "Provenance"}
          </button>
        </div>
        {rail === "edit" && editPanel ? <div className="flex-1 min-h-0 overflow-y-auto tinybar">{editPanel}</div>
         : rail === "source" && sourcePanel ? <div className="flex-1 min-h-0 overflow-y-auto tinybar">{sourcePanel}</div> :
        rail === "comments" ? (
          <>
            {draft && (
              <div className="shrink-0 p-3 border-b border-border bg-primary/5">
                <p className="text-[11px] text-muted-foreground mb-1">{isPoint(draft) ? "Point" : "Region"} at {Math.round(draft.x * 100)}%, {Math.round(draft.y * 100)}%</p>
                <textarea autoFocus value={body} onChange={(e) => setBody(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commitDraft(); } }}
                  placeholder="What needs fixing here?" rows={3}
                  className="w-full text-[12px] rounded-md border border-border bg-background px-2 py-1.5 resize-none focus:outline-none focus:ring-1 focus:ring-primary" />
                <div className="flex items-center gap-2 mt-1.5">
                  <button onClick={commitDraft} disabled={!body.trim()} className="text-[11.5px] px-2 py-1 rounded-md bg-primary text-primary-foreground disabled:opacity-40">Add comment</button>
                  <button type="button" data-knav-back="3" onClick={() => { setDraft(null); setBody(""); backToOpener(); }} className="text-[11.5px] px-2 py-1 rounded-md text-muted-foreground hover:text-foreground">Cancel</button>
                  <span className="text-[10px] text-muted-foreground/60 ml-auto">⌘↵ to add</span>
                </div>
              </div>
            )}
            <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-1.5">
              {visible.length === 0 && !draft && <p className="px-2 py-6 text-[12px] text-muted-foreground text-center leading-relaxed">No comments yet.<br />Click the image to pin one.</p>}
              {visible.map((c, i) => (
                <div key={c.id} onClick={() => setActiveId(c.id)} role="button" tabIndex={0}
                  className={`rounded-lg border px-2.5 py-2 cursor-pointer ${activeId === c.id ? "border-primary bg-primary/5" : "border-border/70 hover:border-border"}`}>
                  <div className="flex items-start gap-1.5">
                    <span className="mt-px inline-flex items-center justify-center w-[18px] h-[18px] shrink-0 rounded-full bg-amber-500 text-white text-[10.5px] font-semibold">{i + 1}</span>
                    <p className={`flex-1 text-[12px] leading-snug whitespace-pre-wrap ${c.resolved ? "line-through text-muted-foreground" : ""}`}>{c.body}</p>
                  </div>
                  <div className="flex items-center gap-2 mt-1 pl-[24px] text-muted-foreground">
                    <span className="text-[9.5px] nums">{Math.round(c.x * 100)}%, {Math.round(c.y * 100)}%{!isPoint(c) ? ` · ${Math.round(c.w * 100)}×${Math.round(c.h * 100)}` : ""}</span>
                    <span className="flex-1" />
                    <button onClick={(e) => { e.stopPropagation(); patch(c.id, { resolved: !c.resolved }); }} title={c.resolved ? "Reopen" : "Resolve"} className={`hover:text-emerald-500 ${c.resolved ? "text-emerald-500" : ""}`}><Check size={12} /></button>
                    {onToAgent && <button onClick={(e) => { e.stopPropagation(); onToAgent(c.id); }} title="Queue this comment for an agent" className={`hover:text-primary ${c.for_agent ? "text-primary" : ""}`}><Bot size={12} /></button>}
                    <button onClick={(e) => { e.stopPropagation(); remove(c.id); }} title="Delete" className="hover:text-rose-500"><Trash2 size={12} /></button>
                  </div>
                  {c.reply && <p className="mt-1 ml-[24px] border-l-2 border-border pl-2 text-[11.5px] leading-snug text-muted-foreground whitespace-pre-wrap">{c.reply}</p>}
                </div>
              ))}
            </div>
            {items.some((c) => c.resolved) && (
              <button onClick={() => setShowResolved((s) => !s)} className="shrink-0 px-3 py-1.5 border-t border-border text-[11px] text-muted-foreground hover:text-foreground text-left">{showResolved ? "Hide" : "Show"} resolved ({items.filter((c) => c.resolved).length})</button>
            )}
          </>
        ) : (
          <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-1.5 text-[11.5px]">
            {!prov ? (
              <p className="text-muted-foreground leading-snug">No provenance record — this asset can't be traced to a script. Regenerate it via the figure script (which records real provenance), or reconstruct a CANDIDATE via<span className="block font-mono text-[10px] mt-1">python3 provenance.py backfill "&lt;project&gt;" --apply</span>then verify it by hand (open the candidate script, confirm it writes this exact output) before it counts as provenance — a backfilled guess reports "no provenance" until you do.</p>
            ) : (
              <>
                <div className="flex items-center gap-1.5 mb-1">
                  <ProvChip status={prov.status} />
                  {prov.caption && <span className="text-muted-foreground truncate">{prov.caption}</span>}
                </div>
                {prov.generatedBy === "backfill" && !prov.verified && (
                  <p className="text-rose-600 dark:text-rose-400 leading-snug">Unverified reconstruction, not recorded provenance — this script/commit below is a heuristic guess. Open the script, confirm it writes this exact stem, then set verified:true in provenance.json (or clear the entry if it's wrong).</p>
                )}
                {prov.script
                  ? <div className="flex items-center gap-1 max-w-full">
                      <button onClick={() => onViewFile([prov.script!], prov.script!.split("/").pop()!)} className="flex items-center gap-1.5 min-w-0 text-muted-foreground hover:text-primary"><FileCode size={11} className="shrink-0" /><span className="font-mono truncate">{prov.script}</span></button>
                    </div>
                  : <p className="text-muted-foreground/70">producing script unknown{prov.manualNote ? " — " + prov.manualNote : ""}</p>}
                {(prov.dataSources || []).map((d, i) => (
                  <button key={i} onClick={() => onViewFile([d, "replication/" + d, "replication/output/" + d.split("/").pop()!], d.split("/").pop()!)} className="flex items-center gap-1.5 text-muted-foreground hover:text-primary max-w-full"><Database size={11} className="shrink-0" /><span className="font-mono truncate">{d}</span></button>
                ))}
                <p className="text-muted-foreground/70 nums">{prov.commit ? "commit " + prov.commit : "no commit"}{prov.generated ? " · " + new Date(prov.generated).toLocaleString() : ""}</p>
                {prov.environment?.python && <p className="text-muted-foreground/60 nums">python {prov.environment.python}{Object.entries(prov.environment.packages || {}).map(([p, v]) => ` · ${p} ${v}`).join("")}</p>}
                {Object.keys(prov.freshness).length > 0 && (
                  <p className="nums">{Object.entries(prov.freshness).map(([ext, v]) => (
                    <span key={ext} className={`inline-flex items-center gap-1 mr-2 ${v === "fresh" ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"}`}>.{ext} {v}</span>
                  ))}</p>
                )}
                {prov.status === "stale" && <p className="text-amber-600 dark:text-amber-400 leading-snug">Output hash differs from the record — the file changed outside the guarded save path. Regenerate it with its producing script.</p>}
                {prov.notesAnchor && <p className="text-muted-foreground/70 leading-snug truncate" title={prov.notesAnchor}>notes: {prov.notesAnchor}</p>}
              </>
            )}
          </div>
        )}
      </div>
      )}
    </div>,
    document.body
  );
}

export function FileViewerPanel({ slug, candidates, title, onClose }: { slug: string; candidates: string[]; title: string; onClose: () => void }) {
  const [view, setView] = useState<DraftFileView | null>(null);
  const [err, setErr] = useState(false);
  const [tableView, setTableView] = useState<"typeset" | "raw">("typeset");
  const [typesetFailed, setTypesetFailed] = useState(false);
  useEffect(() => {
    let live = true; setView(null); setErr(false); setTypesetFailed(false); setTableView("typeset");
    (async () => {
      for (const p of candidates) {
        try {
          const r = await api.draftingFile(slug, p);
          if (!live) return;
          if (r.ok) { setView(r); return; }
        } catch { /* try the next candidate */ }
      }
      if (live) setErr(true);
    })();
    return () => { live = false; };
  }, [slug, candidates]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") { if (typingEscape(e)) return; e.preventDefault(); e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [onClose]);
  const isResultsCsv = view?.kind === "csv" && !!view.rel && /(^|\/)results\//.test(view.rel);
  const showTypeset = isResultsCsv && tableView === "typeset" && !typesetFailed;
  return createPortal(
    // z above the figure lightbox (z-140) so a provenance script/data file opened
    // from the full view docks on the right OVER the visual, not hidden behind it.
    <div role="dialog" aria-modal="true" aria-label={title} data-knav-modal className="fixed inset-0 z-[152] flex justify-end animate-in fade-in duration-150" onMouseDown={onClose}>
      <div className="absolute inset-0 bg-black/30" />
      <div className="relative h-full w-[min(720px,94vw)] bg-background border-l border-border shadow-2xl flex flex-col animate-in slide-in-from-right duration-200" onMouseDown={(e) => e.stopPropagation()}>
        <div className="shrink-0 flex items-center gap-2 px-4 py-2.5 border-b border-border">
          {view?.kind === "csv" ? <Table2 size={15} className="text-primary shrink-0" /> : <FileCode size={15} className="text-primary shrink-0" />}
          <span className="text-[12.5px] font-medium truncate flex-1" title={view?.rel}>{view?.name ?? title}</span>
          {view?.kind === "text" && view.lang && view.lang !== "text" && view.lang !== "markdown" && (
            <span className="text-[9.5px] uppercase tracking-wide px-1.5 py-px rounded-full bg-secondary text-muted-foreground shrink-0">{view.lang}</span>
          )}
          {isResultsCsv && (
            <div className="flex items-center rounded-md border border-border overflow-hidden shrink-0 text-[10.5px]">
              <button onClick={() => setTableView("typeset")} title="Show the typeset table exactly as the publish step renders it"
                className={`px-2 py-0.5 ${tableView === "typeset" && !typesetFailed ? "bg-primary/15 text-foreground" : "text-muted-foreground hover:text-foreground"}`}>Typeset</button>
              <button onClick={() => setTableView("raw")} title="Show the raw CSV rows"
                className={`px-2 py-0.5 border-l border-border ${tableView === "raw" || typesetFailed ? "bg-primary/15 text-foreground" : "text-muted-foreground hover:text-foreground"}`}>Raw data</button>
            </div>
          )}
          {view?.rel && <span className="text-[10.5px] text-muted-foreground font-mono truncate max-w-[30%]" title={view.rel}>{view.rel}</span>}
          <button type="button" onClick={onClose} data-knav-back="2" aria-label="Close" className="text-muted-foreground hover:text-foreground ml-1"><X size={16} /></button>
        </div>
        <div className="flex-1 min-h-0 flex flex-col">
          {err && <p className="px-5 py-4 text-[13px] text-destructive overflow-y-auto">Couldn't open this file{candidates.length ? " (" + candidates[0] + ")" : ""} — it may be outside the project or an unsupported type.</p>}
          {!err && !view && <p className="px-5 py-4 text-[13px] text-muted-foreground">Opening…</p>}
          {view?.kind === "csv" && (
            <div className="flex-1 min-h-0 overflow-auto">
              {showTypeset && (
                <div className="p-4">
                  <img src={api.draftingTablePngUrl(slug, view.name || "")} alt={view.name}
                    onError={() => setTypesetFailed(true)} className="max-w-full mx-auto block rounded border border-border/50 bg-white shadow-sm" />
                </div>
              )}
              {(!showTypeset) && view.rows && (
                <>
                  {isResultsCsv && typesetFailed && <p className="px-4 pt-3 text-[11px] text-muted-foreground">No typeset table found for this file — showing raw data.</p>}
                  <table className="text-[11px] font-mono border-collapse m-4">
                    <tbody>
                      {view.rows.map((r, i) => (
                        <tr key={i} className={i === 0 ? "bg-secondary/60 font-semibold" : i % 2 ? "bg-secondary/20" : ""}>
                          {r.map((c, j) => <td key={j} className="border border-border/50 px-2 py-0.5 whitespace-nowrap max-w-[280px] truncate" title={c}>{c}</td>)}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </div>
          )}
          {view?.kind === "text" && view.lang === "markdown" && (
            <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 text-[13px]"><Markdown text={view.text || ""} idPrefix="fv-" /></div>
          )}
          {view?.kind === "text" && view.lang !== "markdown" && (
            <Suspense fallback={null}><CodeView text={view.text || ""} lang={view.lang} className="flex-1 min-h-0" /></Suspense>
          )}
          {view?.kind === "binary" && (
            <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-2 px-6 text-center">
              <Binary size={26} className="text-muted-foreground/50" />
              <p className="text-[12.5px] font-medium">{view.name}</p>
              <p className="text-[11px] text-muted-foreground">{fmtBytes(view.size || 0)} · {(view.ext || "").replace(".", "")} — binary data, can't preview inline</p>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

/** A glyph for each supplement kind. */

// inject Marp css + slide html into a shadow root (CSS isolation, one injection)
export function MarpSurface({ css, html, className, style }: { css: string; html: string; className?: string; style?: React.CSSProperties }) {
  const ref = useRef<HTMLDivElement>(null);
  const holderRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const host = ref.current; if (!host) return;
    const root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    root.innerHTML =
      "<style>:host{display:block;line-height:initial} .marpit{margin:0;padding:0}" +
      " svg[data-marpit-svg]{display:block;width:100%;height:100%}</style>" +
      "<style>" + css + "</style><div class=\"marpit\"></div>";
    holderRef.current = root.querySelector(".marpit");
    if (holderRef.current) holderRef.current.innerHTML = html;
  }, [css]);
  useEffect(() => {
    const holder = holderRef.current; if (!holder) return;
    if (holder.innerHTML !== html) holder.innerHTML = html;
  }, [html]);
  return <div ref={ref} className={className} style={style} />;
}

// one shadow root holding every slide as a small clickable thumbnail (css injected once)

export const PRESENT_CHANNEL = "aioa-present";

export const PRESENT_BUS_KEY = "aioa-present-bus";

export const _IMG_SRC_RE_FE = /<img\b[^>]*\bsrc="([^"]+)"/g;

export const _warmed = new Map<string, HTMLImageElement>();

export function preloadDeckImages(slides: DeckSlide[]) {
  for (const s of slides) {
    let m: RegExpExecArray | null;
    _IMG_SRC_RE_FE.lastIndex = 0;
    while ((m = _IMG_SRC_RE_FE.exec(s.svg))) {
      const src = m[1];
      if (!src || _warmed.has(src)) continue;
      const img = new Image();
      _warmed.set(src, img);
      img.src = src;
      img.decode?.().catch(() => undefined);
    }
  }
}

