
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ComponentType, CSSProperties, MouseEvent as RMouseEvent, PointerEvent as RPointerEvent } from "react";
import { toast } from "sonner";
import {
  AlignCenter, AlignLeft, AlignRight, ArrowDownToLine, ArrowRight, ArrowUpRight, ArrowUpToLine, Bold, BoxSelect, BringToFront, Check, Circle,
  ClipboardCopy, ClipboardPaste, Copy, Diamond, Group, Images, LayoutTemplate, Loader2, Lock, LockOpen, Maximize,
  Link2, Minus, MousePointer2, MoveHorizontal, PenTool, Pencil, Redo2, Save, SendToBack, Sparkles, SlidersHorizontal, Square, Trash2, Triangle,
  Type, Undo2, Ungroup, X, ZoomIn, ZoomOut,
} from "lucide-react";
import { api } from "@/lib/api";
import { copyPlain } from "@/lib/clipboard";
import {
  DASHES, EMPTY_DOC, FILLS, FONTS, FONT_IDS, HANDLE_CURSOR, HEAD_NAME, HEAD_STYLES, HISTORY, LH, ROUTES,
  ROUTE_ICON, ROUTE_IDS, SHAPES, SIZES, STROKES, WIDTHS, addElements, bindEndpoint, bindTarget, boxMap,
  centre, clamp, cleanupDoc, cloneElements, constrainAngle, contains, contentBounds, deleteElements, detach, docFont,
  elBounds, elementSvg, exportSvg, extractTemplate, fitText, geoD, groupElements, handlePt, hitTest, inflate,
  instantiate, isLink, labelLayout, outlineAnchor, sideAnchors, lerp, linkEnds, linkGeo, linkPoints, linkPorts, linkPrefs, migrate,
  moveElements, newBox, newLink, rectOf, refitText, reorderElements, resizeElement, resizeRect, setFont, setLocked,
  setStyle, setText, snapCands, snapDelta, snapPoint, snapV, tidy, ungroupElements, union, unitGroup, unitIds,
  updateElements, widthBucket,
} from "@/lib/aioadraw";
import type { Box, BoxKind, Doc, El, FontId, Guide, Handle, Link, LinkKind, Pt, Rect, RouteHandle, Shapes, StylePatch } from "@/lib/aioadraw";
import { fontCss, loadFonts } from "@/lib/aioadrawFonts";
import { TemplatesPopover } from "@/components/DrawerTemplates";

/* ── export: the pure SVG, rasterised at 2x on a canvas ── */
async function exportPng(doc: Doc): Promise<string> {
  const { svg, w, h } = exportSvg(doc, await fontCss(docFont(doc)));
  const img = new Image();
  await new Promise<void>((res, rej) => {
    img.onload = () => res();
    img.onerror = () => rej(new Error("svg render failed"));
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  });
  // an embedded data: font can land a beat after onload; give it that beat
  await new Promise((r) => setTimeout(r, 40));
  const s = Math.min(2, 16000 / Math.max(w, h));
  const c = document.createElement("canvas");
  c.width = Math.ceil(w * s); c.height = Math.ceil(h * s);
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("no canvas");
  ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL("image/png");
}

/* ─────────────────────────── tools (interaction layer) ─────────────────────────── */

type ToolId = "select" | BoxKind | LinkKind;
interface View { tx: number; ty: number; z: number }
/* hoverBind: the shape an arrow end would bind to (its side points show); hoverPort: the
 * point it would pin to — a side point, or with Ctrl the exact spot on the outline */
interface Overlay { band: Rect | null; guides: Guide[]; hoverBind: string | null; hoverPort: Pt | null }
const NO_OVERLAY: Overlay = { band: null, guides: [], hoverBind: null, hoverPort: null };
interface PtrEv { p: Pt; s: Pt; shift: boolean; alt: boolean; ctrl: boolean; double: boolean }
interface Gesture { move(e: PtrEv): void; up(e: PtrEv): void; cancel(): void }
interface Ctx {
  doc(): Doc;
  apply(d: Doc, record: boolean): void;
  dropLastUndo(): void;
  sel(): string[];
  setSel(ids: string[]): void;
  entered(): string | null;
  setEntered(g: string | null): void;
  z(): number;
  setTool(t: ToolId): void;
  startEdit(id: string, fresh: boolean): void;
  overlay(o: Partial<Overlay>): void;
}
interface ToolDef {
  id: ToolId; name: string; key: string; cursor: string;
  icon: ComponentType<{ size?: number; className?: string }>;
  down(c: Ctx, e: PtrEv): Gesture | null;
}
/* first change records one undo step; later ones ride on it; cancel restores exactly */
function tracker(c: Ctx) {
  const snap = c.doc();
  let changed = false;
  return {
    snap,
    set(d: Doc) { c.apply(d, !changed); changed = true; },
    revert() { if (changed) { c.apply(snap, false); c.dropLastUndo(); changed = false; } },
  };
}
const gridPt = (p: Pt, alt: boolean) => (alt ? p : { x: snapV(p.x), y: snapV(p.y) });
/* an arrow end over shape s: Ctrl pins it to the outline right there, near a side point
 * (12 px) pins it to that side, anywhere else it stays automatic (the facing side) */
function portOn(s: Box, e: PtrEv, z: number): { anchor: [number, number]; p: Pt } | null {
  if (e.ctrl) { const anchor = outlineAnchor(s, e.p); return { anchor, p: { x: s.x + anchor[0] * s.w, y: s.y + anchor[1] * s.h } }; }
  let best: { anchor: [number, number]; p: Pt } | null = null, bd = 12 / z;
  for (const k of sideAnchors(s)) { const d = Math.hypot(e.p.x - k.p.x, e.p.y - k.p.y); if (d <= bd) { bd = d; best = k; } }
  return best;
}

function createTextAt(c: Ctx, p: Pt) {
  const b = fitText(newBox("text", { x: p.x, y: p.y - (20 * LH) / 2, w: 0, h: 0 }), docFont(c.doc()));
  c.apply(addElements(c.doc(), [b]), true);
  c.setTool("select");
  c.startEdit(b.id, true);
}
function moveGesture(c: Ctx, e0: PtrEv, ids: string[], clicked: string[]): Gesture {
  const t = tracker(c), set = new Set(ids), map = boxMap(t.snap.elements);
  const sb = union(t.snap.elements.filter((x) => set.has(x.id)).map((x) => elBounds(x, map)));
  const cands = snapCands(t.snap.elements, set);
  let moved = false;
  return {
    move(e) {
      if (!moved && Math.hypot(e.s.x - e0.s.x, e.s.y - e0.s.y) < 3) return;
      moved = true;
      let dx = e.p.x - e0.p.x, dy = e.p.y - e0.p.y, guides: Guide[] = [];
      if (!e.alt && sb) ({ dx, dy, guides } = snapDelta(sb, dx, dy, cands, 6 / c.z()));
      t.set(moveElements(t.snap, ids, dx, dy));
      c.overlay({ guides });
    },
    up(e) { c.overlay({ guides: [] }); if (!moved && !e.shift && ids.length > clicked.length) c.setSel(clicked); },
    cancel() { t.revert(); c.overlay({ guides: [] }); },
  };
}
function bandGesture(c: Ctx, e0: PtrEv, base: string[]): Gesture {
  let last = e0.p;
  return {
    move(e) { last = e.p; c.overlay({ band: rectOf(e0.p, e.p) }); },
    up() {
      c.overlay({ band: null });
      const r = rectOf(e0.p, last);
      if (r.w * c.z() < 3 && r.h * c.z() < 3) return;
      const els = c.doc().elements, map = boxMap(els), entered = c.entered();
      const locked = new Set(els.filter((x) => x.locked).map((x) => x.id));
      const inside = new Set(els.filter((x) => !x.locked && contains(r, elBounds(x, map))).map((x) => x.id));
      const picked = new Set(base);
      // a group joins only when all of it (bar what is locked) is inside the band
      for (const x of els) if (inside.has(x.id)) { const u = unitIds(els, x, entered).filter((id) => !locked.has(id)); if (u.every((id) => inside.has(id))) u.forEach((id) => picked.add(id)); }
      c.setSel([...picked]);
    },
    cancel() { c.overlay({ band: null }); c.setSel(base); },
  };
}
function resizeGesture(c: Ctx, orig: Box, handle: Handle): Gesture {
  const t = tracker(c), cands = snapCands(t.snap.elements, new Set([orig.id]));
  return {
    move(e) {
      const sp = snapPoint(e.p, cands, 6 / c.z(), e.alt);
      t.set(resizeElement(t.snap, orig.id, resizeRect(orig, handle, sp.p, e.shift)));
      c.overlay({ guides: sp.guides });
    },
    up() { c.overlay({ guides: [] }); },
    cancel() { t.revert(); c.overlay({ guides: [] }); },
  };
}
/* dragging one end of a link: grid, Shift = 15°, dropping on/near a shape binds it */
function endpointGesture(c: Ctx, id: string, which: "start" | "end", t = tracker(c), onUp?: (e: PtrEv) => void): Gesture {
  return {
    move(e) {
      // the live doc, not the snapshot: a link being created is not in the snapshot yet
      const doc = c.doc(), l = doc.elements.find((x) => x.id === id);
      if (!l || !isLink(l)) return;
      const map = boxMap(doc.elements), other = which === "end" ? l.start : l.end;
      const os = other.bind ? map.get(other.bind) : undefined, op = os ? centre(os) : { x: other.x, y: other.y };
      const q = e.shift ? constrainAngle(op, e.p) : gridPt(e.p, e.alt);
      const tgt = bindTarget(doc.elements, e.p, new Set([id, ...(other.bind ? [other.bind] : [])]), 14 / c.z());
      const port = tgt ? portOn(tgt, e, c.z()) : null;
      t.set(bindEndpoint(doc, id, which, tgt ? { x: q.x, y: q.y, bind: tgt.id, ...(port ? { anchor: port.anchor } : {}) } : { x: q.x, y: q.y }));
      c.overlay({ hoverBind: tgt ? tgt.id : null, hoverPort: port ? port.p : null });
    },
    up(e) { c.overlay({ hoverBind: null, hoverPort: null }); onUp?.(e); },
    cancel() { t.revert(); c.overlay({ hoverBind: null, hoverPort: null }); },
  };
}
/* a route's knob (elbow middle segment, curve bend), if the link's route has one */
function routeHandle(l: Link, map: Shapes): RouteHandle | null {
  const r = ROUTES[l.route];
  if (!r.handle) return null;
  const [a, b] = linkPorts(l, map);
  return r.handle(l, a, b);
}
/* dragging the knob: the route maps the pointer (grid-snapped; Alt frees it) to its stored value */
function routeGesture(c: Ctx, id: string): Gesture {
  const t = tracker(c), map = boxMap(t.snap.elements), l = t.snap.elements.find((x) => x.id === id);
  return {
    move(e) {
      if (!l || !isLink(l)) return;
      const r = ROUTES[l.route];
      if (!r.drag) return;
      const [a, b] = linkPorts(l, map), patch = r.drag(l, a, b, gridPt(e.p, e.alt));
      t.set(updateElements(t.snap, [id], (x) => (isLink(x) ? { ...x, ...patch } : x)));
    },
    up() { /* the drag is the edit */ },
    cancel() { t.revert(); },
  };
}

const selectTool: ToolDef = {
  id: "select", name: "Select", key: "v", cursor: "default", icon: MousePointer2,
  down(c, e) {
    const doc = c.doc(), els = doc.elements, map = boxMap(els), z = c.z(), cur = c.sel();
    if (e.double) {
      // double-click: enter a group one level, edit a label, or drop new text on empty canvas
      const hit = hitTest(els, map, e.p, 6 / z), el = hit ? els.find((x) => x.id === hit) : undefined;
      if (!el) { createTextAt(c, gridPt(e.p, e.alt)); return null; }
      const g = unitGroup(el, c.entered());
      if (g) { c.setEntered(g); c.setSel(unitIds(els, el, g)); return null; }
      if (!isLink(el)) c.startEdit(el.id, false);
      return null;
    }
    if (cur.length === 1) {
      const one = els.find((x) => x.id === cur[0]);
      if (one && !one.locked && isLink(one)) {
        const [a, b] = linkEnds(one, map);
        const which = Math.hypot(e.p.x - b.x, e.p.y - b.y) <= 9 / z ? "end" : Math.hypot(e.p.x - a.x, e.p.y - a.y) <= 9 / z ? "start" : null;
        if (which) return endpointGesture(c, one.id, which);
        const k = routeHandle(one, map);
        if (k && Math.hypot(e.p.x - k.p.x, e.p.y - k.p.y) <= 8 / z) return routeGesture(c, one.id);
      } else if (one && !one.locked && !isLink(one)) {
        const h = SHAPES[one.kind].handles(one).find((k) => { const hp = handlePt(one, k); return Math.hypot(e.p.x - hp.x, e.p.y - hp.y) <= 8 / z; });
        if (h) return resizeGesture(c, one, h);
      }
    }
    const hit = hitTest(els, map, e.p, 6 / z);
    if (hit) {
      const el = els.find((x) => x.id === hit)!;
      let entered = c.entered();
      if (entered && !el.groupIds.includes(entered)) { entered = null; c.setEntered(null); }
      const unit = unitIds(els, el, entered);
      let ids: string[];
      if (e.shift) {
        if (unit.every((id) => cur.includes(id))) { c.setSel(cur.filter((id) => !unit.includes(id))); return null; }
        ids = [...new Set([...cur, ...unit])];
      } else ids = unit.every((id) => cur.includes(id)) ? cur : unit;
      c.setSel(ids);
      return moveGesture(c, e, ids, unit);
    }
    if (!e.shift) { c.setSel([]); c.setEntered(null); }
    return bandGesture(c, e, e.shift ? cur : []);
  },
};
function boxTool(kind: Exclude<BoxKind, "text">, key: string, icon: ToolDef["icon"]): ToolDef {
  return {
    id: kind, name: SHAPES[kind].name, key, cursor: "crosshair", icon,
    down(c, e0) {
      const t = tracker(c), cands = snapCands(t.snap.elements, new Set());
      const o = snapPoint(e0.p, cands, 6 / c.z(), e0.alt).p;
      const b = newBox(kind, { x: o.x, y: o.y, w: 0, h: 0 });
      t.set(addElements(t.snap, [b]));
      const shape = (q: Pt, square: boolean): Rect => {
        if (!square) return rectOf(o, q);
        const s = Math.max(Math.abs(q.x - o.x), Math.abs(q.y - o.y));
        return rectOf(o, { x: o.x + (q.x < o.x ? -s : s), y: o.y + (q.y < o.y ? -s : s) });
      };
      let dragged = false;
      return {
        move(e) {
          const sp = snapPoint(e.p, cands, 6 / c.z(), e.alt);
          dragged = dragged || Math.hypot(e.s.x - e0.s.x, e.s.y - e0.s.y) >= 4;
          t.set(addElements(t.snap, [{ ...b, ...shape(sp.p, e.shift) }]));
          c.overlay({ guides: sp.guides });
        },
        up() {
          c.overlay({ guides: [] });
          const cur = c.doc().elements.find((x) => x.id === b.id) as Box | undefined;
          if (!dragged || !cur || (cur.w < 6 && cur.h < 6)) {
            const d = SHAPES[kind].defaultSize;
            t.set(addElements(t.snap, [{ ...b, x: o.x - d.w / 2, y: o.y - d.h / 2, w: d.w, h: d.h }]));
          }
          c.setTool("select");
          c.setSel([b.id]);
          c.startEdit(b.id, true);
        },
        cancel() { t.revert(); c.overlay({ guides: [] }); },
      };
    },
  };
}
function linkTool(kind: LinkKind, key: string, icon: ToolDef["icon"]): ToolDef {
  return {
    id: kind, name: kind === "arrow" ? "Arrow" : "Line", key, cursor: "crosshair", icon,
    down(c, e0) {
      const t = tracker(c), q = gridPt(e0.p, e0.alt);
      const tgt = bindTarget(t.snap.elements, e0.p, new Set(), 14 / c.z()), port = tgt ? portOn(tgt, e0, c.z()) : null;
      const l = newLink(kind, tgt ? { x: q.x, y: q.y, bind: tgt.id, ...(port ? { anchor: port.anchor } : {}) } : { x: q.x, y: q.y }, { x: q.x, y: q.y });
      t.set(addElements(t.snap, [l]));
      return endpointGesture(c, l.id, "end", t, () => {
        const cur = c.doc().elements.find((x) => x.id === l.id);
        // a click without a drag leaves nothing behind
        if (!cur || !isLink(cur) || Math.hypot(cur.end.x - cur.start.x, cur.end.y - cur.start.y) < 5) { t.revert(); return; }
        c.setTool("select");
        c.setSel([l.id]);
      });
    },
  };
}
const LineIcon: ToolDef["icon"] = ({ size, className }) => <Minus size={size} className={"-rotate-45 " + (className || "")} />;

// EXTENSION POINT: tools. An elbow-connector or legend tool is one entry here.
const TOOLS: ToolDef[] = [
  selectTool,
  boxTool("rect", "r", Square),
  boxTool("ellipse", "o", Circle),
  boxTool("diamond", "d", Diamond),
  boxTool("triangle", "g", Triangle),
  {
    id: "text", name: "Text", key: "t", cursor: "text", icon: Type,
    down(c, e) { createTextAt(c, gridPt(e.p, e.alt)); return null; },
  },
  linkTool("arrow", "a", ArrowUpRight),
  linkTool("line", "l", LineIcon),
];
const TOOL_BY_ID = new Map(TOOLS.map((t) => [t.id, t] as const));

/* ── the right-click menu: on an element (the selection) or on the empty canvas ── */
/* a swatch row (stroke / fill colours) is one row: Left/Right walk its swatches, Enter picks */
interface Swatch { c: string | null; title: string; on: boolean; run(): void }
interface MenuItem { label: string; kbd?: string; icon: ToolDef["icon"]; run(): void; off?: boolean; on?: boolean; sep?: boolean; swatches?: Swatch[] }
/* x, y: client px; rows: built when it opens (nothing can change under an open menu); idx: the row the keys are on */
interface Menu { x: number; y: number; kind: "element" | "canvas"; rows: MenuItem[]; idx: number; sub: number }
/* the format panel: "auto" follows the selection (and a label being typed), "open" shows it
 * even with nothing selected (the drawing's font), "closed" hides it until the selection empties */
type PanelMode = "auto" | "open" | "closed";
/* short: a canvas under 420 px tall, where the panel would sit on the label being typed —
 * there auto stays out of the way while typing (Ctrl+. still opens it) */
const panelShown = (m: PanelMode, selN: number, editing: boolean, short = false) => m === "open" || (m === "auto" && (editing ? !short : selN > 0));
const swatchSub = (it: MenuItem | undefined) => Math.max(0, it?.swatches?.findIndex((w) => w.on) ?? 0);
const LOCK_ICON = <><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></>;

/* the last link style chosen (route, dash, heads) carries over to the next session */
const PREFS_KEY = "aioadraw.linkPrefs";
try {
  const o = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
  if (ROUTE_IDS.includes(o.route)) linkPrefs.route = o.route;
  if (DASHES.includes(o.dash)) linkPrefs.dash = o.dash;
  if (HEAD_STYLES.includes(o.headStyle)) linkPrefs.headStyle = o.headStyle;
  if (o.head === "end" || o.head === "both") linkPrefs.head = o.head;
} catch { /* defaults stand */ }

/* ─────────────────────────── the component ─────────────────────────── */

export function DiagramDrawer({ name, title, template, onSaved, onClose }: {
  name: string | null;
  title?: string;        // title for a new drawing
  template?: unknown;    // a template's document to start a new drawing from (a fresh copy, unsaved)
  onSaved: (name: string, png: string, first: boolean) => void;
  onClose: () => void;
}) {
  const initialTitle = name ? name.replace(/^.*[\\/]/, "").replace(/\.aioadraw$/i, "") : null;
  const [shownTitle, setShownTitle] = useState<string | null>(initialTitle);
  // the name field: a new drawing's name until the first save names the file; after that,
  // Enter or leaving the field renames the files (and the notes that embed them)
  const [newTitle, setNewTitle] = useState(initialTitle || title || "");
  const newTitleRef = useRef(newTitle); newTitleRef.current = newTitle;
  const titleBoxRef = useRef<HTMLInputElement>(null);
  const [loaded, setLoaded] = useState(!name);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [doc, setDoc] = useState<Doc>(EMPTY_DOC);
  const [savedDoc, setSavedDoc] = useState<Doc>(EMPTY_DOC);
  const [sel, setSelState] = useState<string[]>([]);
  const [entered, setEnteredState] = useState<string | null>(null);
  const [tool, setToolState] = useState<ToolId>("select");
  const [view, setViewState] = useState<View>({ tx: 40, ty: 40, z: 1 });
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [editing, setEditingState] = useState<{ id: string; fresh: boolean } | null>(null);
  const [overlay, setOverlayState] = useState<Overlay>(NO_OVERLAY);
  const [hoverCursor, setHoverCursor] = useState("default");
  const [space, setSpace] = useState(false);
  const [panning, setPanning] = useState(false);
  const [fontTick, setFontTick] = useState(0);
  const [hist, setHist] = useState({ undo: 0, redo: 0 });   // mirrors the stacks for the buttons
  const [menu, setMenuState] = useState<Menu | null>(null);
  const [tpl, setTplState] = useState<{ naming: boolean } | null>(null);   // the Templates popover
  const [panel, setPanelState] = useState<PanelMode>("auto");

  const svgRef = useRef<SVGSVGElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const docRef = useRef(doc);
  const savedRef = useRef(savedDoc);
  const selRef = useRef(sel);
  const enteredRef = useRef(entered);
  const toolRef = useRef(tool);
  const viewRef = useRef(view);
  const sizeRef = useRef(size);
  const editingRef = useRef(editing);
  const overlayRef = useRef(overlay);
  const menuRef = useRef(menu);
  const menuElRef = useRef<HTMLDivElement>(null);
  const tplRef = useRef(tpl);
  const panelRef = useRef(panel);
  const tplKeyRef = useRef<((e: KeyboardEvent) => void) | null>(null);
  const hoverRef = useRef(hoverCursor);
  const spaceRef = useRef(false);
  const undoRef = useRef<Doc[]>([]);
  const redoRef = useRef<Doc[]>([]);
  const gestureRef = useRef<{ pid: number; g: Gesture } | null>(null);
  const panRef = useRef<{ pid: number; sx: number; sy: number; view: View } | null>(null);
  const editSnapRef = useRef<Doc>(EMPTY_DOC);
  const clipRef = useRef<El[]>([]);
  const pasteNRef = useRef(0);
  const lastDownRef = useRef<{ t: number; x: number; y: number } | null>(null);
  const lastNudgeRef = useRef(0);
  const nameRef = useRef<string | null>(name);
  const titleRef = useRef<string | null>(initialTitle);
  const mtimeRef = useRef<number | undefined>(undefined);
  const savingRef = useRef(false);
  const loadedRef = useRef(!name);
  const firstDoneRef = useRef(false);
  const fittedRef = useRef(false);
  const onSavedRef = useRef(onSaved); onSavedRef.current = onSaved;
  const onCloseRef = useRef(onClose); onCloseRef.current = onClose;

  /* ── state + ref setters: event handlers read refs, renders read state ── */
  const apply = (d: Doc, record = true) => {
    if (record) {
      undoRef.current.push(docRef.current);
      if (undoRef.current.length > HISTORY) undoRef.current.shift();
      redoRef.current = [];
    }
    docRef.current = d; setDoc(d);
    syncHist();
  };
  function syncHist() { setHist({ undo: undoRef.current.length, redo: redoRef.current.length }); }
  const setPanel = (m: PanelMode) => { panelRef.current = m; setPanelState(m); };
  const setSel = (ids: string[]) => { selRef.current = ids; setSelState(ids); if (!ids.length && panelRef.current === "closed") setPanel("auto"); };
  const setEntered = (g: string | null) => { enteredRef.current = g; setEnteredState(g); };
  const setMenu = (m: Menu | null) => { menuRef.current = m; setMenuState(m); };
  const setTpl = (t: { naming: boolean } | null) => { tplRef.current = t; setTplState(t); };
  const setTool = (t: ToolId) => { toolRef.current = t; setToolState(t); setMenu(null); };
  const setView = (v: View) => { viewRef.current = v; setViewState(v); };
  const setEditing = (e: { id: string; fresh: boolean } | null) => { editingRef.current = e; setEditingState(e); };
  const setOverlay = (o: Partial<Overlay>) => { const n = { ...overlayRef.current, ...o }; overlayRef.current = n; setOverlayState(n); };
  const markSaved = (d: Doc) => { savedRef.current = d; setSavedDoc(d); };
  const pruneSel = (d: Doc) => { const ids = new Set(d.elements.map((e) => e.id)); setSel(selRef.current.filter((id) => ids.has(id))); };

  const startEdit = (id: string, fresh: boolean) => {
    if (docRef.current.elements.find((e) => e.id === id)?.locked) return;
    editSnapRef.current = docRef.current;
    setSel([id]);
    setEditing({ id, fresh });
  };
  /* Esc / click-out: an emptied free text disappears; a fresh one takes its creation
   * step with it, so a stray T-click leaves no trace in history */
  const commitEdit = () => {
    const ed = editingRef.current;
    if (!ed) return;
    setEditing(null);
    const el = docRef.current.elements.find((e) => e.id === ed.id);
    if (el && el.kind === "text" && !el.text.trim()) {
      if (ed.fresh && undoRef.current.length) apply(undoRef.current.pop()!, false);
      else { apply(deleteElements(docRef.current, [ed.id]), false); undoRef.current.push(editSnapRef.current); redoRef.current = []; syncHist(); }
      setSel([]);
      return;
    }
    if (!ed.fresh && docRef.current !== editSnapRef.current) { undoRef.current.push(editSnapRef.current); redoRef.current = []; syncHist(); }
  };

  const ctx: Ctx = {
    doc: () => docRef.current,
    apply,
    dropLastUndo: () => { undoRef.current.pop(); syncHist(); },
    sel: () => selRef.current,
    setSel,
    entered: () => enteredRef.current,
    setEntered,
    z: () => viewRef.current.z,
    setTool,
    startEdit,
    overlay: setOverlay,
  };

  /* ── view ── */
  const fit = (d: Doc = docRef.current, maxZ = 1.5) => {
    const { w, h } = sizeRef.current;
    if (!w || !h) return;
    const b = contentBounds(d.elements, boxMap(d.elements));
    if (!b) { setView({ tx: 40, ty: 40, z: 1 }); return; }
    const z = clamp(Math.min((w - 80) / Math.max(b.w, 1), (h - 80) / Math.max(b.h, 1)), 0.1, maxZ);
    setView({ z, tx: w / 2 - (b.x + b.w / 2) * z, ty: h / 2 - (b.y + b.h / 2) * z });
  };
  const zoomAt = (factor: number, s?: Pt) => {
    const v = viewRef.current, at = s ?? { x: sizeRef.current.w / 2, y: sizeRef.current.h / 2 };
    const z = clamp(v.z * factor, 0.1, 5);
    const wx = (at.x - v.tx) / v.z, wy = (at.y - v.ty) / v.z;
    setView({ z, tx: at.x - wx * z, ty: at.y - wy * z });
  };

  /* ── editing commands ── */
  const undo = () => { const prev = undoRef.current.pop(); if (!prev) return; redoRef.current.push(docRef.current); apply(prev, false); pruneSel(prev); };
  const redo = () => { const next = redoRef.current.pop(); if (!next) return; undoRef.current.push(docRef.current); apply(next, false); pruneSel(next); };
  /* the selection minus what is locked: every command that changes elements acts on this */
  const free = () => {
    const locked = new Set(docRef.current.elements.filter((e) => e.locked).map((e) => e.id));
    return selRef.current.filter((id) => !locked.has(id));
  };
  const deleteSel = () => {
    const ids = free();
    if (!ids.length) return;
    apply(deleteElements(docRef.current, ids)); setSel(selRef.current.filter((id) => !ids.includes(id)));
  };
  const duplicate = () => {
    if (!selRef.current.length) return;
    const fresh = cloneElements(detach(docRef.current, selRef.current), 20, 20);
    apply(addElements(docRef.current, fresh)); setSel(fresh.map((e) => e.id));
  };
  const copy = (ids = selRef.current) => { if (ids.length) { clipRef.current = detach(docRef.current, ids); pasteNRef.current = 0; } };
  const cut = () => { copy(free()); deleteSel(); };   // only what will go: a locked element is neither removed nor copied
  const paste = () => {
    if (!clipRef.current.length) return;
    pasteNRef.current += 1;
    const fresh = cloneElements(clipRef.current, 20 * pasteNRef.current, 20 * pasteNRef.current);
    apply(addElements(docRef.current, fresh)); setSel(fresh.map((e) => e.id));
  };
  const nudge = (dx: number, dy: number) => {
    if (!free().length) return;
    // a run of nudges is one undo step
    const now = performance.now(), record = now - lastNudgeRef.current > 700;
    lastNudgeRef.current = now;
    // the whole selection, as a drag passes it: moveElements leaves what is locked in place,
    // and an arrow bound to a locked shape in the selection keeps its bind
    apply(moveElements(docRef.current, selRef.current, dx, dy), record);
  };
  const restyle = (p: StylePatch) => {
    const ids = free();
    if (!ids.length) return;
    // a choice made on a link becomes the default for the next link drawn
    if (docRef.current.elements.some((e) => isLink(e) && ids.includes(e.id))) {
      if (p.route) linkPrefs.route = p.route;
      if (p.dash) linkPrefs.dash = p.dash;
      if (p.headStyle) linkPrefs.headStyle = p.headStyle;
      if (p.head === "end" || p.head === "both") linkPrefs.head = p.head;
      try { localStorage.setItem(PREFS_KEY, JSON.stringify(linkPrefs)); } catch { /* a nicety */ }
    }
    // while a label is being typed the change rides on the edit's own undo step
    apply(setStyle(docRef.current, ids, p), !editingRef.current);
  };
  const firstBox = () => { const ids = new Set(free()); return docRef.current.elements.find((e): e is Box => ids.has(e.id) && !isLink(e)); };
  const toggleBold = () => { const b = firstBox(); if (b) restyle({ bold: !b.bold }); };
  /* Ctrl+Shift+> / <: the next label size up or down */
  const stepSize = (d: 1 | -1) => {
    const b = firstBox();
    if (!b) return;
    const i = SIZES.reduce((best, s, j) => (Math.abs(s - b.fontSize) < Math.abs(SIZES[best] - b.fontSize) ? j : best), 0);
    restyle({ fontSize: SIZES[clamp(i + d, 0, SIZES.length - 1)] });
  };
  /* hide when shown; show again as "auto" when auto would show it (so it still follows the
   * selection afterwards), else force it "open" */
  const togglePanel = () => {
    const n = selRef.current.length, ed = !!editingRef.current, sh = sizeRef.current.h < 420;
    if (panelShown(panelRef.current, n, ed, sh)) setPanel("closed");
    else setPanel(panelShown("auto", n, ed, sh) ? "auto" : "open");
  };
  const group = () => { const ids = free(); if (ids.length > 1) apply(groupElements(docRef.current, ids, enteredRef.current)); };
  const ungroup = () => { const d = ungroupElements(docRef.current, free(), enteredRef.current); if (d !== docRef.current) apply(d); };
  const reorder = (dir: 1 | -1, far = false) => { const ids = free(); if (ids.length) apply(reorderElements(docRef.current, ids, dir, far)); };
  const selectAll = () => setSel(docRef.current.elements.filter((x) => !x.locked).map((x) => x.id));
  /* Ctrl+Shift+L: lock the selection, or unlock it when all of it is locked already */
  const toggleLock = () => {
    const ids = selRef.current;
    if (ids.length) apply(setLocked(docRef.current, ids, free().length > 0));
  };
  const unlockAll = () => {
    const ids = docRef.current.elements.filter((e) => e.locked).map((e) => e.id);
    if (ids.length) apply(setLocked(docRef.current, ids, false));
  };
  /* pinned arrow ends go back to leaving whichever side faces the other end */
  const unpin = () => {
    const ids = free();
    apply(updateElements(docRef.current, ids, (x) => (isLink(x) ? { ...x, start: { ...x.start, anchor: null }, end: { ...x.end, anchor: null } } : x)));
  };
  const changeFont = (f: FontId) => { if (docFont(docRef.current) !== f) apply(setFont(docRef.current, f), !editingRef.current); };

  /* ── templates ── */
  const openTemplates = (naming: boolean) => { commitEdit(); setMenu(null); setTpl({ naming }); };
  /* a template's elements in this drawing's own face, centred on `at` */
  const fromTemplate = (t: Doc, at: Pt, font: FontId) => instantiate(t.elements, at).map((e) => (isLink(e) || font === docFont(t) ? e : refitText(e, font)));
  const insertTemplate = (t: Doc) => {
    const v = viewRef.current, s = sizeRef.current;
    const fresh = fromTemplate(t, { x: (s.w / 2 - v.tx) / v.z, y: (s.h / 2 - v.ty) / v.z }, docFont(docRef.current));
    apply(addElements(docRef.current, fresh));
    setSel(fresh.map((e) => e.id)); setEntered(null); setTool("select"); setTpl(null);
  };

  /* ── the right-click menu ── */
  const menuRows = (kind: Menu["kind"]): MenuItem[] => {
    const d = docRef.current, clip = clipRef.current.length > 0;
    const panelRow = (sep: boolean): MenuItem => ({ label: "Format panel", kbd: "Ctrl+.", icon: SlidersHorizontal, run: () => setPanel("open"), sep });
    if (kind === "canvas") return [
      { label: "Paste", kbd: "Ctrl+V", icon: ClipboardPaste, run: paste, off: !clip },
      { label: "Insert template…", kbd: "M", icon: LayoutTemplate, run: () => openTemplates(false) },
      { label: "Select all", kbd: "Ctrl+A", icon: BoxSelect, run: selectAll, off: !d.elements.some((e) => !e.locked) },
      { label: "Unlock all", icon: LockOpen, run: unlockAll, off: !d.elements.some((e) => e.locked) },
      { label: "Fit to content", kbd: "0", icon: Maximize, run: () => fit(), off: !d.elements.length },
      { label: "Clean up layout", kbd: "Ctrl+Shift+K", icon: Sparkles, run: cleanUp, off: !d.elements.some((e) => !isLink(e) && !e.locked) },
      ...FONT_IDS.map((f, i) => ({ label: "Font: " + FONTS[f].name.replace(/ \d+$/, ""), icon: Type, run: () => changeFont(f), on: docFont(d) === f, sep: !i })),
      panelRow(true),
    ];
    const set = new Set(selRef.current), els = d.elements.filter((e) => set.has(e.id)), freeEls = els.filter((e) => !e.locked);
    const one = els.length === 1 ? els[0] : undefined, none = !freeEls.length;
    // a short window keeps the menu on screen: the step-by-step reorders and the panel row go
    // (their keys still work); front/back stay
    const short = window.innerHeight < 480;
    const boxes = freeEls.filter((e): e is Box => !isLink(e)), shapes = boxes.filter((b) => b.kind !== "text");
    const style: MenuItem[] = none ? [] : [
      { label: "Stroke", icon: PenTool, run: () => {}, swatches: STROKES.map((c) => ({ c, title: `Stroke ${c}`, on: freeEls[0].stroke === c, run: () => restyle({ stroke: c }) })) },
      ...(shapes.length ? [{ label: "Fill", icon: Square, run: () => {}, swatches: FILLS.map((c) => ({ c, title: c ? `Fill ${c}` : "No fill", on: shapes[0].fill === c, run: () => restyle({ fill: c }) })) }] : []),
      ...(boxes.length ? [{ label: "Bold", kbd: "Ctrl+B", icon: Bold, run: toggleBold, on: boxes[0].bold }] : []),
      ...(freeEls.some((e) => isLink(e) && (e.start.anchor || e.end.anchor)) ? [{ label: "Automatic connection sides", icon: ArrowUpRight, run: unpin }] : []),
    ];
    return [
      ...(one && !isLink(one) ? [{ label: "Edit text", kbd: "Enter", icon: Pencil, run: () => startEdit(one.id, false), off: none }] : []),
      ...style,
      ...(short ? [] : [panelRow(false)]),
      { label: "Duplicate", kbd: "Ctrl+D", icon: Copy, run: duplicate, sep: true },
      { label: "Copy", kbd: "Ctrl+C", icon: ClipboardCopy, run: () => copy() },
      { label: "Paste", kbd: "Ctrl+V", icon: ClipboardPaste, run: paste, off: !clip },
      { label: "Bring to front", kbd: "Ctrl+Shift+]", icon: ArrowUpToLine, run: () => reorder(1, true), off: none, sep: true },
      ...(short ? [] : [
        { label: "Bring forward", kbd: "Ctrl+]", icon: BringToFront, run: () => reorder(1), off: none },
        { label: "Send backward", kbd: "Ctrl+[", icon: SendToBack, run: () => reorder(-1), off: none },
      ]),
      { label: "Send to back", kbd: "Ctrl+Shift+[", icon: ArrowDownToLine, run: () => reorder(-1, true), off: none },
      { label: "Group", kbd: "Ctrl+G", icon: Group, run: group, off: freeEls.length < 2, sep: true },
      { label: "Ungroup", kbd: "Ctrl+Shift+G", icon: Ungroup, run: ungroup, off: !freeEls.some((e) => e.groupIds.length) },
      { label: none ? "Unlock" : "Lock", kbd: "Ctrl+Shift+L", icon: none ? LockOpen : Lock, run: toggleLock },
      { label: "Save as template…", icon: LayoutTemplate, run: () => openTemplates(true), sep: true },
      { label: "Delete", kbd: "Del", icon: Trash2, run: deleteSel, off: none },
    ];
  };
  
  const openMenu = (at?: Pt) => {
    if (!loadedRef.current || gestureRef.current || panRef.current) return;
    commitEdit(); setTpl(null);
    const els = docRef.current.elements, map = boxMap(els), v = viewRef.current, r = svgRef.current!.getBoundingClientRect();
    if (!at) {
      const set = new Set(selRef.current), b = union(els.filter((e) => set.has(e.id)).map((e) => elBounds(e, map)));
      const kind = b ? "element" : "canvas", rows = menuRows(kind);
      const x = b ? clamp((b.x + b.w) * v.z + v.tx, 8, r.width - 8) : r.width / 2, y = b ? clamp(b.y * v.z + v.ty, 8, r.height - 8) : r.height / 3;
      const idx = rows.findIndex((i) => !i.off);
      setMenu({ x: r.left + x, y: r.top + y, kind, rows, idx, sub: swatchSub(rows[idx]) });
      return;
    }
    const p = { x: (at.x - r.left - v.tx) / v.z, y: (at.y - r.top - v.ty) / v.z };
    const hit = hitTest(els, map, p, 6 / v.z, true), el = hit ? els.find((x) => x.id === hit) : undefined;
    if (!el) { setSel([]); setEntered(null); }
    else if (!selRef.current.includes(el.id)) {
      let entered = enteredRef.current;
      if (entered && !el.groupIds.includes(entered)) { entered = null; setEntered(null); }
      setSel(unitIds(els, el, entered));
    }
    const kind = el ? "element" : "canvas";
    setMenu({ ...at, kind, rows: menuRows(kind), idx: -1, sub: 0 });
  };
  const pickMenu = (it: MenuItem | undefined, sub = 0) => {
    if (!it || it.off) return;
    setMenu(null);
    if (it.swatches) it.swatches[sub]?.run(); else it.run();
  };
  // keep the whole menu inside the window, whatever corner it was opened in
  useLayoutEffect(() => {
    const el = menuElRef.current;
    if (!el || !menu) return;
    const r = el.getBoundingClientRect();
    const x = clamp(menu.x, 4, Math.max(4, window.innerWidth - r.width - 4)), y = clamp(menu.y, 4, Math.max(4, window.innerHeight - r.height - 4));
    if (x !== menu.x || y !== menu.y) setMenu({ ...menu, x, y });
    else if (menu.idx >= 0) el.querySelector(`[data-idx="${menu.idx}"]`)?.scrollIntoView({ block: "nearest" });
  }, [menu]);

  /* ── save: SVG -> 2x PNG -> /note/drawer-save, mtime-guarded like DiagramEditor ── */
  const save = async () => {
    if (savingRef.current || !loadedRef.current) return;
    commitEdit();
    // Ctrl+S while the name field is being typed in: the rename lands first
    if (titleBoxRef.current && document.activeElement === titleBoxRef.current) titleBoxRef.current.blur();
    if (renameRef.current) await renameRef.current;
    const snap = docRef.current;
    savingRef.current = true; setSaving(true);
    try {
      let png: string;
      try { png = await exportPng(snap); }
      catch { toast.error("Couldn't render the drawing to PNG"); return; }
      const body = { name: nameRef.current || undefined, title: nameRef.current ? undefined : (newTitleRef.current.trim() || title || "Drawing"), doc: tidy(snap), png, baseMtime: mtimeRef.current };
      const finish = (r: { name?: string; title?: string; png?: string; mtime?: number }) => {
        mtimeRef.current = r.mtime;
        if (r.name) nameRef.current = r.name;
        if (r.title) { titleRef.current = r.title; setShownTitle(r.title); newTitleRef.current = r.title; setNewTitle(r.title); }
        markSaved(snap);
        setSavedAt(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
        const first = !name && !firstDoneRef.current;
        firstDoneRef.current = true;
        const pngName = r.png || (titleRef.current || newTitleRef.current.trim() || title || "Drawing") + ".png";
        toast.success("Saved " + pngName.replace(/^.*[\\/]/, ""));
        if (nameRef.current) onSavedRef.current(nameRef.current, pngName, first);
      };
      const r = await api.noteDrawerSave(body);
      if (r.conflict) {
        // Overwrite REBASES onto the version on disk rather than forcing past the guard.
        if (window.confirm("This diagram changed on disk since you opened it — overwrite with your version?")) {
          const rf = await api.noteDrawerSave({ ...body, baseMtime: r.currentMtime });
          if (rf.ok) finish(rf); else toast.error(rf.error || "drawing save failed");
        } else toast("Not saved — the drawing changed on disk");
      } else if (r.ok) finish(r);
      else toast.error(r.error || "drawing save failed");
    } catch {
      toast.error("Drawing save failed — is the server up?");
    } finally {
      savingRef.current = false; setSaving(false);
    }
  };

  /* the name field let go: a saved drawing is renamed on disk; an unsaved one keeps the
   * name for its first save */
  // a save waits for a rename in flight, so it never writes under the old name
  const renameRef = useRef<Promise<void> | null>(null);
  const commitTitle = () => {
    const want = newTitleRef.current.trim(), cur = titleRef.current;
    if (!nameRef.current || !cur) return Promise.resolve();
    if (!want) { newTitleRef.current = cur; setNewTitle(cur); return Promise.resolve(); }
    if (want === cur) return Promise.resolve();
    if (renameRef.current) return renameRef.current;
    const run = doRename(nameRef.current, want, cur).finally(() => { renameRef.current = null; });
    renameRef.current = run;
    return run;
  };
  const doRename = async (name: string, want: string, cur: string) => {
    try {
      const r = await api.noteDrawerRename(name, want);
      if (r.ok && r.name && r.title) {
        nameRef.current = r.name; titleRef.current = r.title; setShownTitle(r.title);
        newTitleRef.current = r.title; setNewTitle(r.title);
        toast.success("Renamed to " + r.title, r.notes ? { description: `${r.notes} note link${r.notes === 1 ? "" : "s"} updated` } : undefined);
        onSavedRef.current(r.name, r.png || r.title + ".png", false);
      } else { toast.error(r.error || "Rename failed"); newTitleRef.current = cur; setNewTitle(cur); }
    } catch { toast.error("Rename failed — is the server up?"); newTitleRef.current = cur; setNewTitle(cur); }
  };
  
  const copyPath = async () => {
    if (!nameRef.current) { toast("Save the drawing first, then copy its path"); return; }
    const path = "~/vault/Preparation/Diagrams/" + nameRef.current;
    if (await copyPlain(path)) toast.success("Path copied", { description: path });
    else toast.error("Couldn't reach the clipboard");
  };
  /* "clean up": the same pass the CLI runs (cleanupDoc), one undo step */
  const cleanUp = () => {
    commitEdit();
    const r = cleanupDoc(docRef.current);
    if (r.report[0] === "already clean") { toast("Already clean", r.report.length > 1 ? { description: r.report.slice(1).join(" · ") } : undefined); return; }
    apply(r.doc); pruneSel(r.doc);
    toast.success("Cleaned up", { description: r.report.join(" · ") });
  };

  const requestClose = () => {
    if (docRef.current !== savedRef.current && !window.confirm("Close the drawer? Unsaved changes will be lost.")) return;
    onCloseRef.current();
  };
  const cancelGesture = () => {
    const g = gestureRef.current, p = panRef.current;
    gestureRef.current = null; panRef.current = null;
    const pid = g?.pid ?? p?.pid;
    if (pid !== undefined) { try { svgRef.current?.releasePointerCapture(pid); } catch { /* already released */ } }
    if (p) { setView(p.view); setPanning(false); }
    g?.g.cancel();
  };

  /* ── load ── */
  useEffect(() => {
    let live = true;
    void loadFonts().then(() => { if (live) setFontTick((n) => n + 1); });
    if (!name) return () => { live = false; };
    api.noteDrawer(name).then((r) => {
      if (!live) return;
      const d = r.error ? null : migrate(r.doc);
      if (!d) { toast.error("Couldn't read the drawing: " + (r.error || "not an aioadraw document")); onCloseRef.current(); return; }
      docRef.current = d; setDoc(d); markSaved(d);
      mtimeRef.current = r.mtime || undefined;
      if (r.name) nameRef.current = r.name;
      if (r.title) { titleRef.current = r.title; setShownTitle(r.title); newTitleRef.current = r.title; setNewTitle(r.title); }
      loadedRef.current = true; setLoaded(true);
    }).catch(() => { if (live) { toast.error("Couldn't reach the drawing endpoint"); onCloseRef.current(); } });
    return () => { live = false; };
  }, [name]);

  // track the canvas size; the first time both size and content exist, fit to content
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => { const s = { w: el.clientWidth, h: el.clientHeight }; sizeRef.current = s; setSize(s); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    if (!loaded || !size.w || fittedRef.current) return;
    fittedRef.current = true;
    if (docRef.current.elements.length) fit(docRef.current, 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, size.w]);

  // a new drawing from a template: in the template's own face (so nothing re-wraps),
  // placed once the faces have loaded, and left unsaved (savedDoc is still the empty document)
  useEffect(() => {
    const t = fontTick && !name ? migrate(template) : null;
    if (!t || !t.elements.length || docRef.current !== EMPTY_DOC) return;
    const d = addElements({ ...EMPTY_DOC, font: docFont(t) }, fromTemplate(t, { x: 0, y: 0 }, docFont(t)));
    docRef.current = d; setDoc(d);
    if (fittedRef.current) fit(d, 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fontTick]);

  // caret to the end of the label when editing starts
  useEffect(() => {
    const ta = taRef.current;
    if (!editing || !ta) return;
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }, [editing]);

  /* ── keyboard: capture phase on window, so the Board's global keys never see what
   *    the drawer handles. While the textarea has focus only Esc and Ctrl+S act. ── */
  const onKey = (e: KeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey, k = e.key, l = k.toLowerCase();
    const take = () => { e.preventDefault(); e.stopPropagation(); };
    // the format keys work the same whether or not a label is being typed
    if (mod && !e.altKey && loadedRef.current && !menuRef.current && !tplRef.current && e.target !== titleBoxRef.current) {
      if (e.code === "Period" && !e.shiftKey) { take(); togglePanel(); return; }
      if ((e.code === "Period" || e.code === "Comma") && e.shiftKey) { take(); stepSize(e.code === "Period" ? 1 : -1); return; }
      if (l === "b" && !e.shiftKey) { take(); toggleBold(); return; }
    }
    if (editingRef.current) {
      if (k === "Escape") { take(); commitEdit(); }
      else if (mod && l === "s") { take(); void save(); }
      else e.stopPropagation();
      return;
    }
    if (!loadedRef.current) { if (k === "Escape") { take(); onCloseRef.current(); } return; }
    // an open menu or the Templates popover owns every key; Esc closes only that
    const m = menuRef.current;
    if (m) {
      take();
      const n = m.rows.length;
      const step = (from: number, d: 1 | -1) => { let i = from; for (let c = 0; c < n; c++) { i = (i + d + n) % n; if (!m.rows[i].off) break; } setMenu({ ...m, idx: i, sub: swatchSub(m.rows[i]) }); };
      const sw = m.rows[m.idx]?.swatches;
      if (k === "Escape") setMenu(null);
      else if (k === "ArrowDown") step(m.idx, 1);
      else if (k === "ArrowUp") step(m.idx < 0 ? 0 : m.idx, -1);
      else if (k === "Home") step(-1, 1);
      else if (k === "End") step(0, -1);
      else if (sw && (k === "ArrowLeft" || k === "ArrowRight")) setMenu({ ...m, sub: (m.sub + (k === "ArrowRight" ? 1 : -1) + sw.length) % sw.length });
      else if (k === "Enter" || k === " ") pickMenu(m.rows[m.idx], m.sub);
      return;
    }
    if (tplRef.current) { if (tplKeyRef.current) tplKeyRef.current(e); else e.stopPropagation(); return; }
    // the name field of a new drawing types like any field; Enter or Esc hands the keys back
    const box = titleBoxRef.current;
    if (box && e.target === box) {
      if (k === "Escape" || k === "Enter") {
        take();
        if (k === "Escape" && titleRef.current) { newTitleRef.current = titleRef.current; setNewTitle(titleRef.current); }
        box.blur();
      }
      else if (mod && l === "s") { take(); void save(); }
      else e.stopPropagation();
      return;
    }
    if (box && k === "F2") { take(); box.focus(); box.select(); return; }
    if (k === "ContextMenu" || (k === "F10" && e.shiftKey)) { take(); openMenu(); return; }
    if (k === "Escape") {
      take();
      if (gestureRef.current || panRef.current) cancelGesture();
      else if (selRef.current.length || enteredRef.current) { setSel([]); setEntered(null); }
      else if (toolRef.current !== "select") setTool("select");
      else if (panelRef.current === "open") setPanel("auto");
      else requestClose();
      return;
    }
    if (gestureRef.current || panRef.current) { e.stopPropagation(); return; }
    if (mod) {
      if (l === "s") void save();
      else if (l === "z") (e.shiftKey ? redo : undo)();
      else if (l === "y") redo();
      else if (l === "a") selectAll();
      else if (l === "l" && e.shiftKey) toggleLock();
      else if (l === "k" && e.shiftKey) cleanUp();
      else if (l === "d") duplicate();
      else if (l === "c") copy();
      else if (l === "x") cut();
      else if (l === "v") paste();
      else if (l === "g") (e.shiftKey ? ungroup : group)();
      else if (k === "]" || k === "}") reorder(1, e.shiftKey);     // Shift: all the way
      else if (k === "[" || k === "{") reorder(-1, e.shiftKey);
      else if (k === "0") fit();
      else if (k === "=" || k === "+") zoomAt(1.2);
      else if (k === "-") zoomAt(1 / 1.2);
      else { e.stopPropagation(); return; }
      take();
      return;
    }
    if (e.altKey) { e.stopPropagation(); return; }
    // Shift+1/2/3 with a link selected: its route (e.code: Shift turns "1" into "!")
    const routeKey = e.shiftKey && /^Digit\d$/.test(e.code) ? ROUTE_IDS.find((r) => ROUTES[r].key === e.code.slice(5)) : undefined;
    if (routeKey) {
      const d = docRef.current;
      if (d.elements.some((x) => isLink(x) && selRef.current.includes(x.id))) { take(); restyle({ route: routeKey }); }
      else e.stopPropagation();
      return;
    }
    const step = e.shiftKey ? 10 : 1;
    if (k === " ") { take(); if (!spaceRef.current) { spaceRef.current = true; setSpace(true); } }
    else if (k === "Delete" || k === "Backspace") { take(); deleteSel(); }
    else if (k === "ArrowLeft") { take(); nudge(-step, 0); }
    else if (k === "ArrowRight") { take(); nudge(step, 0); }
    else if (k === "ArrowUp") { take(); nudge(0, -step); }
    else if (k === "ArrowDown") { take(); nudge(0, step); }
    else if (k === "Enter" && selRef.current.length === 1) {
      const el = docRef.current.elements.find((x) => x.id === selRef.current[0]);
      if (el && !isLink(el)) { take(); startEdit(el.id, false); } else e.stopPropagation();
    }
    else if (k === "0") { take(); fit(); }
    else if (k === "+" || k === "=") { take(); zoomAt(1.2); }
    else if (k === "-") { take(); zoomAt(1 / 1.2); }
    else if (l === "m" && !e.shiftKey) { take(); openTemplates(false); }
    else {
      const t = TOOLS.find((x) => x.key === l);
      if (t && !e.shiftKey) { take(); setTool(t.id); }
      else e.stopPropagation();
    }
  };
  const onKeyUp = (e: KeyboardEvent) => {
    if (e.key === " " && spaceRef.current) { spaceRef.current = false; setSpace(false); e.stopPropagation(); }
  };
  const keyRef = useRef(onKey); keyRef.current = onKey;
  const keyUpRef = useRef(onKeyUp); keyUpRef.current = onKeyUp;
  useEffect(() => {
    const d = (e: KeyboardEvent) => keyRef.current(e), u = (e: KeyboardEvent) => keyUpRef.current(e);
    window.addEventListener("keydown", d, true);
    window.addEventListener("keyup", u, true);
    return () => { window.removeEventListener("keydown", d, true); window.removeEventListener("keyup", u, true); };
  }, []);

  /* ── wheel: Ctrl zooms around the cursor, otherwise pans (non-passive to stop page zoom) ── */
  const onWheel = (e: WheelEvent) => {
    if (menuElRef.current?.contains(e.target as Node)) return;   // a menu taller than the window scrolls itself
    e.preventDefault();
    if (menuRef.current) setMenu(null);   // the canvas is about to move under it
    const r = svgRef.current?.getBoundingClientRect();
    if (!r) return;
    const s = { x: e.clientX - r.left, y: e.clientY - r.top }, k = e.deltaMode === 1 ? 16 : 1;
    if (e.ctrlKey || e.metaKey) { zoomAt(Math.exp(-e.deltaY * k * 0.0015), s); return; }
    const v = viewRef.current;
    const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX, dy = e.shiftKey && !e.deltaX ? 0 : e.deltaY;
    setView({ ...v, tx: v.tx - dx * k, ty: v.ty - dy * k });
  };
  const wheelRef = useRef(onWheel); wheelRef.current = onWheel;
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const h = (e: WheelEvent) => wheelRef.current(e);
    el.addEventListener("wheel", h, { passive: false });
    return () => el.removeEventListener("wheel", h);
  }, []);

  /* ── pointer → tools ── */
  const ptr = (e: { clientX: number; clientY: number; shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean }, double = false): PtrEv => {
    const r = svgRef.current!.getBoundingClientRect(), v = viewRef.current;
    const s = { x: e.clientX - r.left, y: e.clientY - r.top };
    return { s, p: { x: (s.x - v.tx) / v.z, y: (s.y - v.ty) / v.z }, shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey || e.metaKey, double };
  };
  const onPointerDown = (e: RPointerEvent<SVGSVGElement>) => {
    // preventDefault keeps focus where it is (a fresh label's textarea) and stops text selection
    e.preventDefault();
    if (editingRef.current) { commitEdit(); return; }
    if (gestureRef.current || panRef.current) return;
    const pe = ptr(e);
    if (e.button === 1 || (e.button === 0 && spaceRef.current)) {
      try { svgRef.current?.setPointerCapture(e.pointerId); } catch { /* capture is a nicety */ }
      panRef.current = { pid: e.pointerId, sx: pe.s.x, sy: pe.s.y, view: viewRef.current };
      setPanning(true);
      return;
    }
    if (e.button !== 0 || !loadedRef.current) return;
    // our own double-click: preventDefault on pointerdown makes the native one unreliable
    const now = performance.now(), last = lastDownRef.current;
    pe.double = !!last && now - last.t < 400 && Math.hypot(pe.s.x - last.x, pe.s.y - last.y) < 6;
    lastDownRef.current = pe.double ? null : { t: now, x: pe.s.x, y: pe.s.y };
    const g = (TOOL_BY_ID.get(toolRef.current) || selectTool).down(ctx, pe);
    if (g) {
      try { svgRef.current?.setPointerCapture(e.pointerId); } catch { /* capture is a nicety */ }
      gestureRef.current = { pid: e.pointerId, g };
    }
  };
  const updateHover = (pe: PtrEv) => {
    const t = toolRef.current, d = docRef.current, map = boxMap(d.elements), z = viewRef.current.z;
    if (t === "arrow" || t === "line") {
      const b = bindTarget(d.elements, pe.p, new Set(), 14 / z), id = b ? b.id : null, port = b ? portOn(b, pe, z) : null;
      const o = overlayRef.current;
      if (id !== o.hoverBind || port?.p.x !== o.hoverPort?.x || port?.p.y !== o.hoverPort?.y) setOverlay({ hoverBind: id, hoverPort: port ? port.p : null });
      return;
    }
    if (t !== "select") return;
    let c = "default";
    const cur = selRef.current;
    const one = cur.length === 1 ? d.elements.find((x) => x.id === cur[0]) : undefined;
    if (one && !one.locked && isLink(one)) {
      const k = routeHandle(one, map);
      if (linkEnds(one, map).some((q) => Math.hypot(pe.p.x - q.x, pe.p.y - q.y) <= 9 / z)) c = "crosshair";
      else if (k && Math.hypot(pe.p.x - k.p.x, pe.p.y - k.p.y) <= 8 / z) c = k.cursor;
    } else if (one && !one.locked && !isLink(one)) {
      const h = SHAPES[one.kind].handles(one).find((k) => { const hp = handlePt(one, k); return Math.hypot(pe.p.x - hp.x, pe.p.y - hp.y) <= 8 / z; });
      if (h) c = HANDLE_CURSOR[h];
    }
    if (c === "default" && hitTest(d.elements, map, pe.p, 6 / z)) c = "move";
    if (c !== hoverRef.current) { hoverRef.current = c; setHoverCursor(c); }
  };
  const onPointerMove = (e: RPointerEvent<SVGSVGElement>) => {
    const pe = ptr(e), p = panRef.current, g = gestureRef.current;
    if (p && p.pid === e.pointerId) { setView({ ...p.view, tx: p.view.tx + pe.s.x - p.sx, ty: p.view.ty + pe.s.y - p.sy }); return; }
    if (g && g.pid === e.pointerId) { g.g.move(pe); return; }
    if (!g && !p && !editingRef.current) updateHover(pe);
  };
  const onPointerUp = (e: RPointerEvent<SVGSVGElement>) => {
    const p = panRef.current, g = gestureRef.current;
    if (p && p.pid === e.pointerId) { panRef.current = null; setPanning(false); return; }
    if (g && g.pid === e.pointerId) { gestureRef.current = null; g.g.up(ptr(e)); }
  };

  /* ── derived render data ── */
  const map = useMemo(() => boxMap(doc.elements), [doc]);
  const editId = editing?.id ?? null;
  const font = docFont(doc);
  const markup = useMemo(
    () => doc.elements.map((e) => elementSvg(e, map, editId, font)).join(""),
    // fontTick: re-wrap labels once the faces have loaded
    [doc, map, editId, fontTick], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const selSet = new Set(sel);
  const selEls = doc.elements.filter((e) => selSet.has(e.id));
  // the style rows show, and act on, what is not locked
  const selFree = selEls.filter((e) => !e.locked);
  const selBoxes = selFree.filter((e): e is Box => !isLink(e));
  const selShapes = selBoxes.filter((b) => b.kind !== "text");
  const selLinks = selFree.filter(isLink);
  const selRects = selBoxes.filter((b) => b.kind === "rect");
  const firstStroke = selFree[0];
  const z = view.z;
  const dirty = doc !== savedDoc;
  const cursor = panning ? "grabbing" : space ? "grab" : tool === "select" ? hoverCursor : (TOOL_BY_ID.get(tool)?.cursor || "crosshair");
  // the paper is white in both themes: the accent is deepened so a pale night accent still reads on it
  const PRIMARY = "color-mix(in oklab, hsl(var(--primary)) 78%, black)";

  const editEl = editing ? doc.elements.find((e) => e.id === editing.id) : undefined;
  let taStyle: CSSProperties | null = null;
  if (editEl && !isLink(editEl)) {
    const L = labelLayout(editEl, font);
    const common: CSSProperties = {
      fontFamily: FONTS[font].family, fontSize: editEl.fontSize * z, fontWeight: editEl.bold ? 700 : 400, lineHeight: LH,
      color: editEl.stroke, caretColor: editEl.stroke, textAlign: editEl.textAlign,
    };
    taStyle = editEl.kind === "text"
      ? { ...common, left: editEl.x * z + view.tx, top: editEl.y * z + view.ty, width: (editEl.w + editEl.fontSize) * z, height: Math.max(editEl.h, editEl.fontSize * LH) * z, whiteSpace: "pre" }
      : { ...common, left: L.area.x * z + view.tx, top: L.top * z + view.ty, width: Math.max(L.area.w, editEl.fontSize) * z, height: Math.max(1, L.lines.length) * L.lh * z };
  }

  const gridOn = z >= 0.4;
  const world = { x: -view.tx / z, y: -view.ty / z, w: size.w / z, h: size.h / z };
  const btnBase = "h-7 rounded-md inline-flex items-center justify-center text-[12px] hover:bg-accent disabled:opacity-40 disabled:hover:bg-transparent";
  const btn = btnBase + " min-w-7 px-1.5";
  // the top bar in a narrow window: tighter buttons and gaps, an icon-only Save, no saved-at note
  const tight = size.w > 0 && size.w < 860, tiny = size.w > 0 && size.w < 640;
  const tbtn = tiny ? btnBase + " min-w-[21px] px-0" : tight ? btnBase + " min-w-6 px-1" : btn;
  const on = (active: boolean) => (active ? " bg-accent text-primary" : "");
  const noFocus = (e: RMouseEvent) => e.preventDefault();

  const single = selFree.length === 1 && selEls.length === 1 ? selFree[0] : undefined;   // the one element with handles
  const groupBounds = selEls.length > 1 ? union(selEls.map((e) => elBounds(e, map))) : null;
  const showPanel = loaded && panelShown(panel, selEls.length, !!editing, size.h < 420);
  // the panel steps down to the bottom corner when it would sit on the label being typed
  const panelLow = !!taStyle && Number(taStyle.left) + Number(taStyle.width) > size.w - 290 && Number(taStyle.top) < 330;
  // a panel action that is not a style (duplicate, delete, group...) ends the label being typed first
  const act = (f: () => void) => { commitEdit(); f(); };

  return (
    <div role="dialog" aria-modal="true" aria-label="Diagram drawer" data-knav-modal className="fixed inset-0 z-[170] bg-background flex flex-col animate-in fade-in duration-150">
      <div className={"shrink-0 flex items-center py-2 border-b border-border min-w-0 " + (tiny ? "gap-0 px-1" : tight ? "gap-0.5 px-2" : size.w < 1100 ? "gap-1 px-2" : "gap-2 px-3")}>
        {/* every diagram: steps out onto the library underneath (the Notes section, or the
            diagram window's own), through the same unsaved-changes check as Close */}
        <button type="button" onMouseDown={noFocus} onClick={requestClose} aria-label="All diagrams"
          title="All diagrams (Esc)" className={tbtn + " shrink-0 gap-1.5 text-primary" + (tight ? "" : " px-2")}>
          <Images size={15} />{size.w >= 1100 && <span className="text-foreground">Diagrams</span>}
        </button>
        {/* the name: click (or F2) to rename; Enter renames the files, Esc puts it back */}
        <span className={"relative h-7 shrink " + (tiny ? "min-w-[6ch] w-[12ch]" : tight ? "min-w-[6ch] w-[26ch]" : "min-w-[160px] w-[26ch]")}>
          <input ref={titleBoxRef} value={newTitle} onChange={(e) => setNewTitle(e.target.value)} onBlur={() => void commitTitle()} data-drawer-title
            aria-label="Diagram name" title={shownTitle ? "Rename (F2)" : "Name (F2)"} placeholder="Diagram name" spellCheck={false} maxLength={48}
            className="absolute inset-y-0 left-0 w-full rounded-md border border-transparent bg-transparent px-1.5 text-[13px] font-medium truncate hover:border-border focus:z-10 focus:w-[min(30ch,80vw)] focus:border-primary focus:bg-background focus:outline-none" />
        </span>
        <button type="button" onMouseDown={noFocus} onClick={() => void copyPath()} disabled={!shownTitle}
          title={shownTitle ? "Copy path" : "Save first to copy its path"} aria-label="Copy path" className={tbtn + " shrink-0 text-muted-foreground"}>
          <Link2 size={14} />
        </button>
        {dirty && <span className="w-1.5 h-1.5 mx-0.5 rounded-full bg-primary shrink-0" title="Unsaved changes" />}
        <span className="flex-1" />
        <div className="flex items-center gap-0.5" role="toolbar" aria-label="Tools">
          {TOOLS.map((t) => (
            <button key={t.id} type="button" onMouseDown={noFocus} onClick={() => setTool(t.id)}
              title={`${t.name} (${t.key.toUpperCase()})`} aria-label={t.name} aria-pressed={tool === t.id}
              className={tbtn + on(tool === t.id)}>
              <t.icon size={15} />
            </button>
          ))}
          <span className={"w-px h-5 bg-border " + (tiny ? "mx-px" : tight ? "mx-0.5" : "mx-1")} />
          <button type="button" onMouseDown={noFocus} onClick={() => openTemplates(false)} disabled={!loaded}
            title="Templates (M)" aria-label="Templates" aria-haspopup="dialog" aria-expanded={!!tpl} className={tbtn + on(!!tpl)}>
            <LayoutTemplate size={15} />
          </button>
          <button type="button" onMouseDown={noFocus} onClick={togglePanel} disabled={!loaded}
            title="Format panel (Ctrl+.)" aria-label="Format panel" aria-pressed={showPanel} className={tbtn + on(showPanel)}>
            <SlidersHorizontal size={15} />
          </button>
        </div>
        <span className={"w-px h-5 bg-border " + (tiny ? "mx-px" : tight ? "mx-0.5" : "mx-1")} />
        <button type="button" onMouseDown={noFocus} onClick={undo} disabled={!hist.undo} title="Undo (Ctrl+Z)" aria-label="Undo" className={tbtn}><Undo2 size={15} /></button>
        <button type="button" onMouseDown={noFocus} onClick={redo} disabled={!hist.redo} title="Redo (Ctrl+Shift+Z)" aria-label="Redo" className={tbtn}><Redo2 size={15} /></button>
        <span className={"w-px h-5 bg-border " + (tiny ? "mx-px" : tight ? "mx-0.5" : "mx-1")} />
        <button type="button" onMouseDown={noFocus} onClick={() => zoomAt(1 / 1.2)} title="Zoom out (-)" aria-label="Zoom out" className={tbtn}><ZoomOut size={15} /></button>
        <button type="button" onMouseDown={noFocus} onClick={() => zoomAt(1 / z)} title="Zoom to 100%" aria-label="Zoom to 100%" className={tbtn + " shrink-0 nums text-muted-foreground " + (tiny ? "w-9 text-[11px]" : tight ? "w-10" : "w-12")}>{Math.round(z * 100)}%</button>
        <button type="button" onMouseDown={noFocus} onClick={() => zoomAt(1.2)} title="Zoom in (+)" aria-label="Zoom in" className={tbtn}><ZoomIn size={15} /></button>
        <button type="button" onMouseDown={noFocus} onClick={() => fit()} title="Fit to content (0)" aria-label="Fit to content" className={tbtn}><Maximize size={15} /></button>
        <span className="flex-1" />
        {saving ? (
          <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground"><Loader2 size={12} className="animate-spin" />{!tight && " saving…"}</span>
        ) : savedAt && !tight ? (
          <span className="text-[11px] text-muted-foreground nums">saved {savedAt}</span>
        ) : null}
        <button type="button" onMouseDown={noFocus} onClick={() => void save()} disabled={saving || !loaded}
          title={"Save PNG + source (Ctrl+S)" + (tight && savedAt ? " — saved " + savedAt : "")} aria-label="Save"
          className={"h-7 rounded-md inline-flex items-center gap-1.5 text-[12px] disabled:opacity-50 shrink-0 " + (dirty ? "bg-primary text-primary-foreground hover:opacity-90 " : "text-muted-foreground hover:bg-accent hover:text-foreground ") + (tiny ? "px-1.5" : tight ? "px-2" : "px-2.5")}>
          <Save size={13} />{!tight && " Save"}
        </button>
        <button onClick={requestClose} type="button" data-knav-back="2" aria-label="Close"
          title="Close (Esc)" className="w-7 h-7 shrink-0 rounded-md hover:bg-accent inline-flex items-center justify-center">
          <X size={16} />
        </button>
      </div>

      {/* the paper stays white in both themes, so the canvas looks like its export */}
      <div ref={wrapRef} className="flex-1 min-h-0 relative overflow-hidden bg-white">
        <svg ref={svgRef} className="absolute inset-0 w-full h-full touch-none select-none" style={{ cursor }}
          onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
          onContextMenu={(e) => { e.preventDefault(); openMenu({ x: e.clientX, y: e.clientY }); }}>
          <defs>
            <pattern id="aioadraw-dots" width={20} height={20} patternUnits="userSpaceOnUse">
              <circle cx={0} cy={0} r={1.1 / z} fill="#d0d4da" />
            </pattern>
          </defs>
          <g transform={`translate(${view.tx} ${view.ty}) scale(${z})`}>
            {gridOn && <rect x={world.x} y={world.y} width={world.w} height={world.h} fill="url(#aioadraw-dots)" />}
            <g dangerouslySetInnerHTML={{ __html: markup }} />

            {overlay.hoverBind && map.get(overlay.hoverBind) && (() => {
              const r = inflate(elBounds(map.get(overlay.hoverBind)!, map), 5 / z);
              return <g pointerEvents="none">
                <rect x={r.x} y={r.y} width={r.w} height={r.h} rx={6 / z} fill="none" stroke={PRIMARY} strokeWidth={2} strokeOpacity={0.55} vectorEffect="non-scaling-stroke" />
                {sideAnchors(map.get(overlay.hoverBind)!).map((k, i) => (
                  <circle key={i} data-side-port={i} cx={k.p.x} cy={k.p.y} r={4 / z} fill="#ffffff" stroke={PRIMARY} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
                ))}
                {overlay.hoverPort && <circle data-port-on cx={overlay.hoverPort.x} cy={overlay.hoverPort.y} r={5.5 / z} fill={PRIMARY} stroke="#ffffff" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />}
              </g>;
            })()}
            {selEls.map((e) => {
              if (isLink(e)) {
                return <path key={e.id} d={geoD(linkGeo(e, map))} fill="none" stroke={PRIMARY} strokeOpacity={0.35} strokeWidth={e.strokeWidth + 6 / z} strokeLinecap="round" strokeLinejoin="round" />;
              }
              if (editId === e.id && e.kind === "text") return null;
              const r = inflate(elBounds(e, map), 4 / z);
              return <rect key={e.id} x={r.x} y={r.y} width={r.w} height={r.h} fill="none" stroke={PRIMARY} strokeWidth={1.25} vectorEffect="non-scaling-stroke" />;
            })}
            {groupBounds && (() => {
              const r = inflate(groupBounds, 9 / z);
              return <rect x={r.x} y={r.y} width={r.w} height={r.h} fill="none" stroke={PRIMARY} strokeWidth={1} strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />;
            })()}
            {single && isLink(single) && (() => {
              const k = routeHandle(single, map), s = 5 / z;
              return [
                ...linkEnds(single, map).map((p, i) => (
                  <circle key={i} cx={p.x} cy={p.y} r={5 / z} fill="#ffffff" stroke={PRIMARY} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
                )),
                k && <path key="knob" data-route-knob={single.route} d={`M${k.p.x} ${k.p.y - s} L${k.p.x + s} ${k.p.y} L${k.p.x} ${k.p.y + s} L${k.p.x - s} ${k.p.y} Z`}
                  fill={PRIMARY} stroke="#ffffff" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />,
              ];
            })()}
            {single && !isLink(single) && !editId && SHAPES[single.kind].handles(single).map((h) => {
              const p = handlePt(single, h), s = 8 / z;
              return <rect key={h} x={p.x - s / 2} y={p.y - s / 2} width={s} height={s} rx={1.5 / z} fill="#ffffff" stroke={PRIMARY} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />;
            })}
            {selEls.filter((e) => e.locked).map((e) => {
              // a lock badge: the corner of a shape, the middle of a link
              const ps = isLink(e) ? linkPoints(e, map) : [], r = elBounds(e, map);
              const p = !isLink(e) ? { x: r.x + r.w, y: r.y } : ps.length === 2 ? lerp(ps[0], ps[1], 0.5) : ps[ps.length >> 1];
              return (
                <g key={"lock-" + e.id} data-lock-badge={e.id} transform={`translate(${p.x} ${p.y}) scale(${1 / z})`} pointerEvents="none">
                  <circle r={9} fill="#ffffff" stroke={PRIMARY} strokeWidth={1.25} />
                  <g transform="translate(-6 -6.5) scale(0.5)" fill="none" stroke={PRIMARY} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">{LOCK_ICON}</g>
                </g>
              );
            })}
            {overlay.guides.map((g, i) => (
              <line key={i} x1={g.x1} y1={g.y1} x2={g.x2} y2={g.y2} stroke={PRIMARY} strokeWidth={1} vectorEffect="non-scaling-stroke" />
            ))}
            {overlay.band && (
              <rect x={overlay.band.x} y={overlay.band.y} width={overlay.band.w} height={overlay.band.h}
                fill={PRIMARY} fillOpacity={0.08} stroke={PRIMARY} strokeWidth={1} vectorEffect="non-scaling-stroke" />
            )}
          </g>
        </svg>

        {editEl && !isLink(editEl) && taStyle && (
          <textarea ref={taRef} value={editEl.text} spellCheck={false} aria-label="Label"
            onChange={(e) => apply(setText(docRef.current, editEl.id, e.target.value), false)}
            onBlur={commitEdit}
            onContextMenu={(e) => { e.preventDefault(); openMenu({ x: e.clientX, y: e.clientY }); }}
            className="absolute p-0 m-0 border-0 bg-transparent outline-none resize-none overflow-hidden"
            style={taStyle} />
        )}

        {showPanel && (
          <div data-drawer-panel className={"absolute right-3 max-h-[calc(100%-24px)] overflow-y-auto bg-card border border-border rounded-lg shadow-md p-1.5 flex flex-col gap-1.5 text-foreground" + (panelLow ? " bottom-3" : " top-3")} onPointerDown={(e) => e.stopPropagation()} onMouseDown={noFocus}>
            {selFree.length > 0 && <div className="flex gap-1">
              {STROKES.map((c) => (
                <button key={c} type="button" onMouseDown={noFocus} onClick={() => restyle({ stroke: c })} title={`Stroke ${c}`} aria-label={`Stroke ${c}`}
                  className={"w-6 h-6 rounded-md border border-border inline-flex items-center justify-center" + (firstStroke?.stroke === c ? " ring-2 ring-primary" : "")}>
                  <span className="w-3.5 h-3.5 rounded-sm" style={{ background: c, boxShadow: "0 0 0 1px hsl(var(--foreground) / 0.35)" }} />
                </button>
              ))}
            </div>}
            {selShapes.length > 0 && (
              <div className="flex gap-1">
                {FILLS.map((c) => (
                  <button key={c || "none"} type="button" onMouseDown={noFocus} onClick={() => restyle({ fill: c })} title={c ? `Fill ${c}` : "No fill"} aria-label={c ? `Fill ${c}` : "No fill"}
                    className={"w-6 h-6 rounded-md border border-border overflow-hidden" + (selShapes[0].fill === c ? " ring-2 ring-primary" : "")}
                    style={c ? { background: c } : undefined}>
                    {!c && <svg viewBox="0 0 24 24" className="w-full h-full text-muted-foreground"><line x1="5" y1="19" x2="19" y2="5" stroke="currentColor" strokeWidth="2" /></svg>}
                  </button>
                ))}
              </div>
            )}
            {(selShapes.length > 0 || selLinks.length > 0) && (() => {
              const sty: Box | Link = selShapes[0] || selLinks[0];
              return (
                <div className="flex gap-0.5">
                  {WIDTHS.map((w, i) => (
                    <button key={w} type="button" onMouseDown={noFocus} onClick={() => restyle({ strokeWidth: w })} title={["Thin", "Regular", "Bold"][i]} aria-label={`Stroke width ${w}`} className={btn + on(widthBucket(sty.strokeWidth) === w)}>
                      <svg width="16" height="16" viewBox="0 0 16 16"><line x1="2" y1="8" x2="14" y2="8" stroke="currentColor" strokeWidth={[1.2, 2, 3.4][i]} /></svg>
                    </button>
                  ))}
                  {selRects.length > 0 && (
                    <button type="button" onMouseDown={noFocus} onClick={() => restyle({ rounded: !selRects[0].rounded })} title={selRects[0].rounded ? "Sharp corners" : "Rounded corners"} aria-label="Rounded corners" aria-pressed={!!selRects[0].rounded} className={btn + on(!!selRects[0].rounded)}>
                      <svg width="16" height="16" viewBox="0 0 16 16"><path d="M2.5 14 V7 a4.5 4.5 0 0 1 4.5 -4.5 H14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
                    </button>
                  )}
                </div>
              );
            })()}
            {(selShapes.length > 0 || selLinks.length > 0) && (() => {
              const cur = (selLinks[0] || selShapes[0]).dash;
              return (
                <div className="flex gap-0.5">
                  {DASHES.map((d) => {
                    const name = d[0].toUpperCase() + d.slice(1);
                    return (
                      <button key={d} type="button" onMouseDown={noFocus} onClick={() => restyle({ dash: d })} title={name} aria-label={name} aria-pressed={cur === d} className={btn + on(cur === d)}>
                        <svg width="16" height="16" viewBox="0 0 16 16"><line x1="1.5" y1="8" x2="14.5" y2="8" stroke="currentColor" strokeWidth="2"
                          strokeDasharray={d === "dashed" ? "3.5 2.5" : d === "dotted" ? "0 3.6" : undefined} strokeLinecap={d === "dotted" ? "round" : "butt"} /></svg>
                      </button>
                    );
                  })}
                </div>
              );
            })()}
            {selBoxes.length > 0 && (
              <div className="flex gap-0.5">
                {SIZES.map((s, i) => (
                  <button key={s} type="button" onMouseDown={noFocus} onClick={() => restyle({ fontSize: s })} title={`Font size ${s}`} aria-label={`Font size ${s}`} className={btn + on(selBoxes[0].fontSize === s)}>
                    <span style={{ fontSize: 10 + i * 2.5 }} className="font-medium leading-none">A</span>
                  </button>
                ))}
                <button type="button" onMouseDown={noFocus} onClick={() => restyle({ bold: !selBoxes[0].bold })} title="Bold" aria-label="Bold" aria-pressed={selBoxes[0].bold} className={btn + on(selBoxes[0].bold)}><Bold size={14} /></button>
                <span className="w-px h-5 bg-border mx-0.5 self-center" />
                {([["left", AlignLeft], ["center", AlignCenter], ["right", AlignRight]] as const).map(([a, Icon]) => {
                  const tip = "Align " + a;
                  return <button key={a} type="button" onMouseDown={noFocus} onClick={() => restyle({ textAlign: a })} title={tip} aria-label={tip} aria-pressed={selBoxes[0].textAlign === a} className={btn + on(selBoxes[0].textAlign === a)}><Icon size={14} /></button>;
                })}
              </div>
            )}
            {selLinks.length > 0 && (
              <div className="flex gap-0.5">
                {ROUTE_IDS.map((r) => (
                  <button key={r} type="button" onMouseDown={noFocus} onClick={() => restyle({ route: r })} title={`${ROUTES[r].name} (Shift+${ROUTES[r].key})`} aria-label={`${ROUTES[r].name} line`} aria-pressed={selLinks[0].route === r} className={btn + on(selLinks[0].route === r)}>
                    <svg width="16" height="16" viewBox="0 0 16 16"><path d={ROUTE_ICON[r]} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="miter" /></svg>
                  </button>
                ))}
              </div>
            )}
            {selLinks.length > 0 && (
              <div className="flex gap-0.5">
                {([["none", Minus, "No arrowhead"], ["end", ArrowRight, "Arrowhead at end"], ["both", MoveHorizontal, "Arrowheads at both ends"]] as const).map(([h, Icon, tip]) => (
                  <button key={h} type="button" onMouseDown={noFocus} onClick={() => restyle({ head: h })} title={tip} aria-label={tip} aria-pressed={selLinks[0].head === h} className={btn + on(selLinks[0].head === h)}><Icon size={14} /></button>
                ))}
                <span className="w-px h-5 bg-border mx-0.5 self-center" />
                {HEAD_STYLES.map((h) => (
                  <button key={h} type="button" onMouseDown={noFocus} onClick={() => restyle({ headStyle: h })} title={HEAD_NAME[h]} aria-label={HEAD_NAME[h]} aria-pressed={selLinks[0].headStyle === h} className={btn + on(selLinks[0].headStyle === h)}>
                    <svg width="16" height="16" viewBox="0 0 16 16">{h === "chevron"
                      ? <path d="M6.5 3.5 L12.5 8 L6.5 12.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="miter" />
                      : <path d="M5.5 3.5 L13 8 L5.5 12.5 Z" fill={h === "triangle" ? "currentColor" : "none"} stroke="currentColor" strokeWidth={h === "triangle" ? 0 : 1.5} strokeLinejoin="miter" />}</svg>
                  </button>
                ))}
              </div>
            )}
            {selEls.length > 0 && <div className={"flex gap-0.5" + (selFree.length ? " border-t border-border pt-1.5" : "")}>
              <button type="button" onMouseDown={noFocus} onClick={() => act(duplicate)} title="Duplicate (Ctrl+D)" aria-label="Duplicate" className={btn}><Copy size={14} /></button>
              <button type="button" onMouseDown={noFocus} onClick={() => act(() => reorder(1))} disabled={!selFree.length} title="Bring forward (Ctrl+])" aria-label="Bring forward" className={btn}><BringToFront size={14} /></button>
              <button type="button" onMouseDown={noFocus} onClick={() => act(() => reorder(-1))} disabled={!selFree.length} title="Send backward (Ctrl+[)" aria-label="Send backward" className={btn}><SendToBack size={14} /></button>
              <button type="button" onMouseDown={noFocus} onClick={() => act(group)} disabled={selFree.length < 2} title="Group (Ctrl+G)" aria-label="Group" className={btn}><Group size={14} /></button>
              <button type="button" onMouseDown={noFocus} onClick={() => act(ungroup)} disabled={!selFree.some((e) => e.groupIds.length)} title="Ungroup (Ctrl+Shift+G)" aria-label="Ungroup" className={btn}><Ungroup size={14} /></button>
              <button type="button" onMouseDown={noFocus} onClick={() => act(toggleLock)} title={(selFree.length ? "Lock" : "Unlock") + " (Ctrl+Shift+L)"} aria-label={selFree.length ? "Lock" : "Unlock"} aria-pressed={!selFree.length} className={btn + on(!selFree.length)}>
                {selFree.length ? <Lock size={14} /> : <LockOpen size={14} />}
              </button>
              <button type="button" onMouseDown={noFocus} onClick={() => act(deleteSel)} disabled={!selFree.length} title="Delete (Del)" aria-label="Delete" className={btn}><Trash2 size={14} /></button>
            </div>}
            <div role="radiogroup" aria-label="Drawing font" className={"flex gap-0.5" + (selEls.length ? " border-t border-border pt-1.5" : "")}>
              {FONT_IDS.map((f) => (
                <button key={f} type="button" role="radio" aria-checked={font === f} onMouseDown={noFocus} onClick={() => changeFont(f)}
                  title={`Font: ${FONTS[f].name} (whole drawing)`} aria-label={`Font ${FONTS[f].name}`}
                  className={btn + " grow basis-0 min-w-max px-2.5 text-[12px] whitespace-nowrap" + on(font === f)} style={{ fontFamily: FONTS[f].family }}>
                  {FONTS[f].name.replace(/ \d+$/, "")}
                </button>
              ))}
            </div>
          </div>
        )}

        {menu && (
          <>
            <div className="fixed inset-0 z-30" onPointerDown={(e) => { e.preventDefault(); setMenu(null); }} onContextMenu={(e) => e.preventDefault()} />
            <div ref={menuElRef} role="menu" aria-label={menu.kind === "element" ? "Element menu" : "Canvas menu"}
              className="fixed z-40 w-[252px] max-w-[calc(100vw-8px)] max-h-[calc(100vh-8px)] overflow-y-auto flex flex-col rounded-lg border border-border bg-card text-foreground shadow-lg p-1"
              style={{ left: menu.x, top: menu.y }} onPointerDown={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()}>
              {menu.rows.map((it, i) => (
                <div key={it.label} className="contents">
                  {it.sep && <div className="my-0.5 h-px shrink-0 bg-border/70" />}
                  {it.swatches ? (
                    <div role="group" aria-label={it.label} data-idx={i} onPointerEnter={() => { if (menu.idx !== i) setMenu({ ...menu, idx: i, sub: swatchSub(it) }); }}
                      className={"shrink-0 h-[26px] flex w-full items-center gap-2 rounded px-2 text-[12px]" + (menu.idx === i ? " bg-accent" : "")}>
                      <it.icon size={13} className="text-muted-foreground shrink-0" />
                      <span className="w-[44px] shrink-0">{it.label}</span>
                      <span className="flex gap-1">
                        {it.swatches.map((w, j) => (
                          <button key={w.c || "none"} type="button" role="menuitemradio" aria-checked={w.on} aria-label={w.title} title={w.title}
                            onMouseDown={noFocus} onClick={() => pickMenu(it, j)}
                            className={"w-[18px] h-[18px] rounded border border-border overflow-hidden shrink-0" + (w.on ? " ring-2 ring-primary ring-offset-1 ring-offset-card" : "") + (menu.idx === i && menu.sub === j ? " outline outline-2 outline-offset-1 outline-foreground/60" : "")}
                            style={w.c ? { background: w.c } : undefined}>
                            {!w.c && <svg viewBox="0 0 18 18" className="w-full h-full text-muted-foreground"><line x1="3" y1="15" x2="15" y2="3" stroke="currentColor" strokeWidth="1.5" /></svg>}
                          </button>
                        ))}
                      </span>
                    </div>
                  ) : <button type="button" role={it.on === undefined ? "menuitem" : "menuitemradio"} aria-checked={it.on} disabled={it.off} data-idx={i}
                    onMouseDown={noFocus} onClick={() => pickMenu(it)} onPointerEnter={() => { if (!it.off && menu.idx !== i) setMenu({ ...menu, idx: i }); }}
                    className={"shrink-0 " + (size.h < 420 ? "h-[19px]" : "h-[22px]") + " flex w-full items-center gap-2 rounded px-2 text-left text-[12px] disabled:opacity-40" + (menu.idx === i ? " bg-accent" : "")}>
                    <it.icon size={13} className="text-muted-foreground shrink-0" />
                    <span className="flex-1 truncate">{it.label}</span>
                    {it.on && <Check size={12} className="text-primary shrink-0" />}
                    {it.kbd && size.h >= 420 && <span className="text-[10px] text-muted-foreground/70 shrink-0 nums">{it.kbd}</span>}
                  </button>}
                </div>
              ))}
            </div>
          </>
        )}

        {!loaded && (
          <div className="absolute inset-0 bg-background flex items-center justify-center">
            <Loader2 size={20} className="animate-spin text-muted-foreground" />
          </div>
        )}
      </div>

      {tpl && (
        <TemplatesPopover what={sel.length ? "selection" : doc.elements.length ? "diagram" : null} startNaming={tpl.naming} keyRef={tplKeyRef}
          getDoc={() => extractTemplate(docRef.current, selRef.current)} onInsert={insertTemplate} onClose={() => setTpl(null)} />
      )}
    </div>
  );
}
