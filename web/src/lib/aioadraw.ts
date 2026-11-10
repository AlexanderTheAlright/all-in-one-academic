

/* ─────────────────────────── document model ─────────────────────────── */
export type BoxKind = "rect" | "ellipse" | "diamond" | "triangle" | "text";
export type LinkKind = "arrow" | "line";
export type Route = "straight" | "elbow" | "curved" | "rounded";
export type Heads = "none" | "end" | "both";
export type HeadStyle = "triangle" | "open-triangle" | "chevron";
export type Dash = "solid" | "dashed" | "dotted";
export interface Pt { x: number; y: number }
export interface Rect { x: number; y: number; w: number; h: number }
export interface Base { id: string; groupIds: string[]; locked?: boolean }   // groupIds: innermost first, outermost last
export interface Box extends Base {
  kind: BoxKind; x: number; y: number; w: number; h: number; rounded?: boolean;
  text: string; textAlign: "left" | "center" | "right"; verticalAlign: "top" | "middle" | "bottom";
  fontSize: number; bold: boolean; fill: string | null; stroke: string; strokeWidth: number; dash: Dash;
}
/* anchor = fractional point on the bound shape; absent/null = auto boundary intersection */
export interface End { x: number; y: number; bind?: string; anchor?: [number, number] | null }
/* midOffset: an elbow's middle segment, shifted from the midpoint along its axis;
 * bend: a curve's control points, pushed sideways off the chord */
export interface Link extends Base {
  kind: LinkKind; start: End; end: End; route: Route; midOffset?: number; bend?: number;
  head: Heads; headStyle: HeadStyle; stroke: string; strokeWidth: number; dash: Dash; text?: string;
}
export type El = Box | Link;
export type FontId = "source" | "inter" | "nunito";
/* font: absent on drawings saved before 2026-10 — migrate() reads that as LEGACY_FONT */
export interface Doc { type: "aioadraw"; version: 1; font?: FontId; elements: El[] }   // array order = z-order

export const INK = "#1e1e1e";
export const STROKES = ["#1e1e1e", "#e03131", "#2f9e44", "#1971c2", "#f08c00"];
export const FILLS: (string | null)[] = [null, "#ffffff", "#ffc9c9", "#b2f2bb", "#a5d8ff", "#ffec99", "#e9ecef"];
export const WIDTHS = [1.5, 2, 3.5];
export const DEFAULT_SW = 2;
/* the width button a stored width lights up: old drawings saved 2/3/5, and 3 was "regular" */
export const widthBucket = (sw: number) => (sw < 1.75 ? 1.5 : sw <= 3 ? 2 : 3.5);
export const DASHES: Dash[] = ["solid", "dashed", "dotted"];
export const HEAD_STYLES: HeadStyle[] = ["triangle", "open-triangle", "chevron"];
export const HEAD_NAME: Record<HeadStyle, string> = { triangle: "Filled arrowhead", "open-triangle": "Open triangle arrowhead", chevron: "Chevron arrowhead" };
export const ROUTE_ICON: Record<Route, string> = { straight: "M2.5 13.5 L13.5 2.5", elbow: "M2 13 H8 V3 H14", rounded: "M2 13 H4.5 A3.5 3.5 0 0 0 8 9.5 V6.5 A3.5 3.5 0 0 1 11.5 3 H14", curved: "M2 13 C8.5 13 7.5 3 14 3" };
export const SIZES = [20, 28, 36];
export interface FontDef { id: FontId; name: string; family: string; url: string; weight?: string }
export const FONTS: Record<FontId, FontDef> = {
  source: { id: "source", name: "Source Sans 3", family: `"Source Sans 3", "Segoe UI", system-ui, sans-serif`, url: "/drawer/fonts/source-sans-3-latin.woff2", weight: "200 900" },
  inter: { id: "inter", name: "Inter", family: `Inter, "Segoe UI", system-ui, sans-serif`, url: "/drawer/fonts/inter-latin.woff2", weight: "100 900" },
  nunito: { id: "nunito", name: "Nunito", family: `Nunito, "Segoe UI", system-ui, sans-serif`, url: "/drawer/fonts/nunito-latin.woff2" },
};
export const FONT_IDS = Object.keys(FONTS) as FontId[];
export const DEFAULT_FONT: FontId = "source", LEGACY_FONT: FontId = "nunito";
export const docFont = (d: Doc): FontId => d.font ?? LEGACY_FONT;
export const LH = 1.25, GRID = 10, PAD = 24, HISTORY = 200, BIND_GAP = 6;
export const BOX_KINDS: BoxKind[] = ["rect", "ellipse", "diamond", "triangle", "text"];
export const EMPTY_DOC: Doc = { type: "aioadraw", version: 1, font: DEFAULT_FONT, elements: [] };

/* ─────────────────────────── pure geometry ─────────────────────────── */

export const newId = () => Math.random().toString(36).slice(2, 10);
export const isLink = (e: El): e is Link => e.kind === "arrow" || e.kind === "line";
export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const snapV = (v: number) => Math.round(v / GRID) * GRID;
export const centre = (r: Rect): Pt => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
export const rectOf = (a: Pt, b: Pt): Rect => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) });
export const inflate = (r: Rect, d: number): Rect => ({ x: r.x - d, y: r.y - d, w: r.w + 2 * d, h: r.h + 2 * d });
export const inRect = (p: Pt, r: Rect) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
export const contains = (outer: Rect, r: Rect) => r.x >= outer.x && r.y >= outer.y && r.x + r.w <= outer.x + outer.w && r.y + r.h <= outer.y + outer.h;
export const fmt = (n: number) => String(Math.round(n * 100) / 100);
export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function union(rs: Rect[]): Rect | null {
  if (!rs.length) return null;
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const r of rs) { x1 = Math.min(x1, r.x); y1 = Math.min(y1, r.y); x2 = Math.max(x2, r.x + r.w); y2 = Math.max(y2, r.y + r.h); }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}
export function distSeg(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
  const t = l2 ? clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / l2, 0, 1) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
/* smallest t > 0 where the ray c + t·d crosses the polygon's edges */
export function rayPolygon(c: Pt, d: Pt, pts: Pt[]): number {
  let best = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    const ex = q.x - p.x, ey = q.y - p.y, den = d.x * ey - d.y * ex;
    if (Math.abs(den) < 1e-9) continue;
    const t = ((p.x - c.x) * ey - (p.y - c.y) * ex) / den;
    const s = ((p.x - c.x) * d.y - (p.y - c.y) * d.x) / den;
    if (t > 0 && s >= -1e-9 && s <= 1 + 1e-9) best = Math.min(best, t);
  }
  return best;
}
export function inPolygon(p: Pt, pts: Pt[], tol: number): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside || pts.some((a, i) => distSeg(p, a, pts[(i + 1) % pts.length]) <= tol);
}
/* Shift on a line/arrow: 15° increments around the fixed end */
export function constrainAngle(from: Pt, to: Pt): Pt {
  const len = Math.hypot(to.x - from.x, to.y - from.y), step = Math.PI / 12;
  const a = Math.round(Math.atan2(to.y - from.y, to.x - from.x) / step) * step;
  return { x: from.x + Math.cos(a) * len, y: from.y + Math.sin(a) * len };
}

export type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
export const ALL_HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
export const HANDLE_CURSOR: Record<Handle, string> = { nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize", n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize" };
export function handlePt(r: Rect, h: Handle): Pt {
  return {
    x: h.includes("w") ? r.x : h.includes("e") ? r.x + r.w : r.x + r.w / 2,
    y: h.includes("n") ? r.y : h.includes("s") ? r.y + r.h : r.y + r.h / 2,
  };
}
export function resizeRect(o: Rect, h: Handle, q: Pt, keepAspect: boolean): Rect {
  let x1 = o.x, y1 = o.y, x2 = o.x + o.w, y2 = o.y + o.h;
  if (h.includes("w")) x1 = Math.min(q.x, x2 - 8);
  if (h.includes("e")) x2 = Math.max(q.x, x1 + 8);
  if (h.includes("n")) y1 = Math.min(q.y, y2 - 8);
  if (h.includes("s")) y2 = Math.max(q.y, y1 + 8);
  if (keepAspect && h.length === 2 && o.w > 0 && o.h > 0) {
    const k = Math.max((x2 - x1) / o.w, (y2 - y1) / o.h), w = o.w * k, hh = o.h * k;
    return { x: h.includes("w") ? x2 - w : x1, y: h.includes("n") ? y2 - hh : y1, w, h: hh };
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

export type TextMeasurer = (text: string, font: string) => number;
let measurer: TextMeasurer | null = null;
let mctx: CanvasRenderingContext2D | null = null;
const widthCache = new Map<string, number>();
export function setTextMeasurer(fn: TextMeasurer | null): void { measurer = fn; widthCache.clear(); }
export function clearTextCache(): void { widthCache.clear(); }
export const fontSpec = (size: number, bold: boolean, font: FontId) => `${bold ? 700 : 400} ${size}px ${FONTS[font].family}`;
export function textWidth(s: string, size: number, bold: boolean, font: FontId): number {
  const key = font + (bold ? "b" : "r") + size + "|" + s;
  const hit = widthCache.get(key);
  if (hit !== undefined) return hit;
  let w: number;
  if (measurer) w = measurer(s, fontSpec(size, bold, font));
  else {
    if (!mctx && typeof document !== "undefined") mctx = document.createElement("canvas").getContext("2d");
    if (!mctx) return s.length * size * 0.55;
    mctx.font = fontSpec(size, bold, font);
    w = mctx.measureText(s).width;
  }
  widthCache.set(key, w);
  return w;
}
export function wrapText(text: string, maxW: number, size: number, bold: boolean, font: FontId): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/ +/)) {
      const cand = line ? line + " " + word : word;
      if (!line || textWidth(cand, size, bold, font) <= maxW) line = cand;
      else { out.push(line); line = word; }
    }
    out.push(line);
  }
  return out;
}
/* free text auto-sizes to its lines */
export function fitText(b: Box, font: FontId): Box {
  if (b.kind !== "text") return b;
  const lines = b.text.split("\n");
  const w = Math.max(b.fontSize * 0.5, ...lines.map((l) => textWidth(l, b.fontSize, b.bold, font))) + 2;
  return { ...b, w, h: lines.length * b.fontSize * LH };
}

/* the export's @font-face: an SVG drawn as an <img> cannot load external fonts, so the
 * drawer passes a data: URL of the woff2 here */
export const fontFaceCss = (font: FontId, url: string) =>
  `@font-face{font-family:"${FONTS[font].name}";${FONTS[font].weight ? `font-weight:${FONTS[font].weight};` : ""}src:url(${url}) format("woff2");}`;

/* ─────────────────────────── shape registry ─────────────────────────── */

/* technical strokes: mitred corners, butt ends; only dots get round caps (a zero-length
 * dash with a round cap IS the dot). Dash lengths scale with the stroke. */
export const dashAttr = (sw: number, dash: Dash) =>
  dash === "dashed" ? ` stroke-dasharray="${fmt(sw * 4)} ${fmt(sw * 3)}"` : dash === "dotted" ? ` stroke-dasharray="0 ${fmt(sw * 2.5)}"` : "";
export const strokeAttrs = (sw: number, dash: Dash) =>
  `stroke-width="${fmt(sw)}" stroke-linejoin="miter" stroke-miterlimit="4" stroke-linecap="${dash === "dotted" ? "round" : "butt"}"`;
export const paint = (b: Box) =>
  `fill="${esc(b.fill ?? "none")}" stroke="${esc(b.stroke)}" ${strokeAttrs(b.strokeWidth, b.dash)}${dashAttr(b.strokeWidth, b.dash)}`;
export const rectRadius = (b: Box) => (b.rounded ? Math.min(6, 0.2 * Math.min(b.w, b.h)) : 0);
export const diamondPts = (b: Box): Pt[] => [{ x: b.x + b.w / 2, y: b.y }, { x: b.x + b.w, y: b.y + b.h / 2 }, { x: b.x + b.w / 2, y: b.y + b.h }, { x: b.x, y: b.y + b.h / 2 }];
export const trianglePts = (b: Box): Pt[] => [{ x: b.x + b.w / 2, y: b.y }, { x: b.x + b.w, y: b.y + b.h }, { x: b.x, y: b.y + b.h }];
export const ptsAttr = (ps: Pt[]) => ps.map((p) => fmt(p.x) + "," + fmt(p.y)).join(" ");

export interface ShapeDef {
  name: string;
  defaultSize: { w: number; h: number };
  body(b: Box): string;                          // SVG of the shape itself — live canvas AND export
  hit(b: Box, p: Pt, tol: number): boolean;
  bounds(b: Box): Rect;
  boundary(b: Box, toward: Pt, gap: number): Pt; // where a bound arrow meets it
  labelArea(b: Box): Rect;                       // where its text wraps
  handles(b: Box): Handle[];
}
/* ray from the centre toward `toward`, stopped at the outline (t = 1 is the outline) */
export function alongRay(b: Box, toward: Pt, gap: number, tAt: (d: Pt, hw: number, hh: number) => number): Pt {
  const c = centre(b), d = { x: toward.x - c.x, y: toward.y - c.y }, len = Math.hypot(d.x, d.y);
  if (len < 1e-6) return c;
  let t = tAt(d, Math.max(b.w / 2, 0.5), Math.max(b.h / 2, 0.5));
  if (!isFinite(t)) t = 0;
  t += gap / len;
  return { x: c.x + d.x * t, y: c.y + d.y * t };
}
export const rectT = (d: Pt, hw: number, hh: number) => Math.min(d.x ? hw / Math.abs(d.x) : Infinity, d.y ? hh / Math.abs(d.y) : Infinity);
export const plainBounds = (b: Box): Rect => ({ x: b.x, y: b.y, w: b.w, h: b.h });
export const eightHandles = () => ALL_HANDLES;

// EXTENSION POINT: new element kinds (legend, frame, ...) are one entry here plus a
// BoxKind member; render, export, hit testing, binding and resizing all read from it.
export const SHAPES: Record<BoxKind, ShapeDef> = {
  rect: {
    name: "Rectangle", defaultSize: { w: 160, h: 80 },
    body: (b) => { const r = rectRadius(b); return `<rect x="${fmt(b.x)}" y="${fmt(b.y)}" width="${fmt(b.w)}" height="${fmt(b.h)}" rx="${fmt(r)}" ry="${fmt(r)}" ${paint(b)}/>`; },
    hit: (b, p, tol) => inRect(p, inflate(plainBounds(b), tol)),
    bounds: plainBounds,
    boundary: (b, t, g) => alongRay(b, t, g, rectT),
    labelArea: (b) => ({ x: b.x + 10, y: b.y + 6, w: Math.max(b.w - 20, 1), h: Math.max(b.h - 12, 1) }),
    handles: eightHandles,
  },
  ellipse: {
    name: "Ellipse", defaultSize: { w: 160, h: 80 },
    body: (b) => `<ellipse cx="${fmt(b.x + b.w / 2)}" cy="${fmt(b.y + b.h / 2)}" rx="${fmt(b.w / 2)}" ry="${fmt(b.h / 2)}" ${paint(b)}/>`,
    hit: (b, p, tol) => { const c = centre(b); return ((p.x - c.x) / (b.w / 2 + tol)) ** 2 + ((p.y - c.y) / (b.h / 2 + tol)) ** 2 <= 1; },
    bounds: plainBounds,
    boundary: (b, t, g) => alongRay(b, t, g, (d, hw, hh) => 1 / Math.hypot(d.x / hw, d.y / hh)),
    labelArea: (b) => ({ x: b.x + b.w * 0.15, y: b.y + b.h * 0.15, w: b.w * 0.7, h: b.h * 0.7 }),
    handles: eightHandles,
  },
  diamond: {
    name: "Diamond", defaultSize: { w: 160, h: 100 },
    body: (b) => `<polygon points="${ptsAttr(diamondPts(b))}" ${paint(b)}/>`,
    hit: (b, p, tol) => inPolygon(p, diamondPts(b), tol),
    bounds: plainBounds,
    boundary: (b, t, g) => alongRay(b, t, g, (d, hw, hh) => 1 / (Math.abs(d.x) / hw + Math.abs(d.y) / hh)),
    labelArea: (b) => ({ x: b.x + b.w / 4, y: b.y + b.h / 4, w: b.w / 2, h: b.h / 2 }),
    handles: eightHandles,
  },
  triangle: {
    name: "Triangle", defaultSize: { w: 160, h: 120 },
    body: (b) => `<polygon points="${ptsAttr(trianglePts(b))}" ${paint(b)}/>`,
    hit: (b, p, tol) => inPolygon(p, trianglePts(b), tol),
    bounds: plainBounds,
    boundary: (b, t, g) => alongRay(b, t, g, (d) => rayPolygon(centre(b), d, trianglePts(b))),
    labelArea: (b) => ({ x: b.x + b.w * 0.25, y: b.y + b.h * 0.42, w: b.w * 0.5, h: b.h * 0.52 }),
    handles: eightHandles,
  },
  text: {
    name: "Text", defaultSize: { w: 10, h: 25 },
    body: () => "",
    hit: (b, p, tol) => inRect(p, inflate(plainBounds(b), tol + 2)),
    bounds: plainBounds,
    boundary: (b, t, g) => alongRay(b, t, g, rectT),
    labelArea: plainBounds,
    handles: () => [],
  },
};

/* ─────────────────────────── links ─────────────────────────── */

/* A resolved end: its point, and — when a sided route binds it to a shape — the outward
 * normal of the side it leaves from (null: floating, or a route that aims at centres). */
export interface Port { p: Pt; n: Pt | null; box?: Rect }   // box: the shape it leaves (sided routes)
/* a link's drawn path: a polyline (r: its corners drawn as circular arcs of that radius),
 * or one cubic Bézier [p0, c1, c2, p3] */
export type Geo = { kind: "poly"; pts: Pt[]; r?: number } | { kind: "cubic"; pts: [Pt, Pt, Pt, Pt] };
export interface RouteHandle { p: Pt; cursor: string }
export interface RouteDef {
  name: string;
  key: string;                                             // Shift+<key> with a link selected
  sided: boolean;                                          // bound ends leave a side's midpoint, perpendicular to it
  geometry(l: Link, a: Port, b: Port): Geo;
  handle?(l: Link, a: Port, b: Port): RouteHandle | null;  // the one drag handle, if the route has a knob
  drag?(l: Link, a: Port, b: Port, q: Pt): Partial<Link>;  // pointer -> the stored knob value
}

export const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y });
export const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
export const lerp = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
export const unit = (v: Pt): Pt => { const l = Math.hypot(v.x, v.y); return l < 1e-9 ? { x: 1, y: 0 } : { x: v.x / l, y: v.y / l }; };
export function cubicAt(c: Pt[], t: number): Pt {
  const u = 1 - t, a = u * u * u, b = 3 * u * u * t, d = 3 * u * t * t, e = t * t * t;
  return { x: a * c[0].x + b * c[1].x + d * c[2].x + e * c[3].x, y: a * c[0].y + b * c[1].y + d * c[2].y + e * c[3].y };
}
/* de Casteljau: the [0, t] half of a cubic */
export function cubicHead(c: Pt[], t: number): [Pt, Pt, Pt, Pt] {
  const p01 = lerp(c[0], c[1], t), p12 = lerp(c[1], c[2], t), p23 = lerp(c[2], c[3], t);
  const p012 = lerp(p01, p12, t), p123 = lerp(p12, p23, t);
  return [c[0], p01, p012, lerp(p012, p123, t)];
}
export const rev4 = (c: Pt[]): [Pt, Pt, Pt, Pt] => [c[3], c[2], c[1], c[0]];
export function dedupe(ps: Pt[]): Pt[] {
  const out = ps.filter((p, i) => !i || dist(p, ps[i - 1]) > 0.01);
  return out.length > 1 ? out : [ps[0], ps[ps.length - 1]];
}

/* where a sided route leaves shape s along axis normal n: the outline point on that axis */
export function sidePort(s: Box, n: Pt): Port {
  const c = centre(s), far = s.w + s.h + 100;
  return { p: SHAPES[s.kind].boundary(s, { x: c.x + n.x * far, y: c.y + n.y * far }, BIND_GAP), n, box: s };
}
/* an explicit anchor leaves perpendicular to the box side it sits nearest, BIND_GAP out
 * from the outline like an automatic end */
export function anchorPort(s: Box, a: [number, number]): Port {
  const d = [a[0], 1 - a[0], a[1], 1 - a[1]], k = d.indexOf(Math.min(...d));
  const n = [{ x: -1, y: 0 }, { x: 1, y: 0 }, { x: 0, y: -1 }, { x: 0, y: 1 }][k];
  return { p: { x: s.x + a[0] * s.w + n.x * BIND_GAP, y: s.y + a[1] * s.h + n.y * BIND_GAP }, n, box: s };
}
/* the four side connection points of a shape (top, right, bottom, left), on its outline,
 * as the fractional anchors an End stores */
export function sideAnchors(s: Box): { p: Pt; anchor: [number, number] }[] {
  const c = centre(s), far = s.w + s.h + 100;
  return [{ x: 0, y: -1 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }].map((n) => {
    const p = SHAPES[s.kind].boundary(s, { x: c.x + n.x * far, y: c.y + n.y * far }, 0);
    return { p, anchor: [s.w ? (p.x - s.x) / s.w : 0.5, s.h ? (p.y - s.y) / s.h : 0.5] };
  });
}
/* the outline point of s on the ray from its centre toward q, as an anchor */
export function outlineAnchor(s: Box, q: Pt): [number, number] {
  // a box's side nearest the point, right under it; a curved outline along the ray from its centre
  if (s.kind === "rect" || s.kind === "text") {
    const fx = clamp((q.x - s.x) / (s.w || 1), 0, 1), fy = clamp((q.y - s.y) / (s.h || 1), 0, 1);
    const d = [fx, 1 - fx, fy, 1 - fy], k = d.indexOf(Math.min(...d));
    return k === 0 ? [0, fy] : k === 1 ? [1, fy] : k === 2 ? [fx, 0] : [fx, 1];
  }
  const p = SHAPES[s.kind].boundary(s, q, 0);
  return [s.w ? (p.x - s.x) / s.w : 0.5, s.h ? (p.y - s.y) / s.h : 0.5];
}
export function resolveEnd(end: End, toward: Pt, map: Shapes): Pt {
  const s = end.bind ? map.get(end.bind) : undefined;
  if (!s) return { x: end.x, y: end.y };
  if (end.anchor) return anchorPort(s, end.anchor).p;
  return SHAPES[s.kind].boundary(s, toward, BIND_GAP);
}

export function linkPorts(l: Link, map: Shapes): [Port, Port] {
  const sa = l.start.bind ? map.get(l.start.bind) : undefined, sb = l.end.bind ? map.get(l.end.bind) : undefined;
  if (!ROUTES[l.route].sided) {
    return [
      { p: resolveEnd(l.start, sb ? centre(sb) : l.end, map), n: null },
      { p: resolveEnd(l.end, sa ? centre(sa) : l.start, map), n: null },
    ];
  }
  const ca = sa ? centre(sa) : { x: l.start.x, y: l.start.y }, cb = sb ? centre(sb) : { x: l.end.x, y: l.end.y };
  const hw = (s?: Box) => (s ? s.w / 2 : 0), hh = (s?: Box) => (s ? s.h / 2 : 0);
  const gx = Math.abs(cb.x - ca.x) - hw(sa) - hw(sb), gy = Math.abs(cb.y - ca.y) - hh(sa) - hh(sb);
  const horiz = gx >= gy;
  const port = (s: Box | undefined, e: End, from: Pt, to: Pt): Port => {
    if (!s) return { p: { x: e.x, y: e.y }, n: null };
    if (e.anchor) return anchorPort(s, e.anchor);
    return sidePort(s, horiz ? { x: to.x >= from.x ? 1 : -1, y: 0 } : { x: 0, y: to.y >= from.y ? 1 : -1 });
  };
  return [port(sa, l.start, ca, cb), port(sb, l.end, cb, ca)];
}

/* elbow: the axis each end runs along (a floating end takes its partner's), and the middle
 * segment's position — the midpoint, shifted by midOffset */
export function elbowPlan(l: Link, a: Port, b: Port) {
  const ax = (n: Pt | null) => (n ? (n.x ? "h" : "v") : null);
  const d = sub(b.p, a.p), axA = ax(a.n) ?? ax(b.n) ?? (Math.abs(d.x) >= Math.abs(d.y) ? "h" : "v");
  const axB = ax(b.n) ?? axA;
  const mid = axA === "h" ? (a.p.x + b.p.x) / 2 : (a.p.y + b.p.y) / 2;
  return { axA, axB, mid, at: mid + (l.midOffset ?? 0) };
}

export function curvePlan(l: Link, a: Port, b: Port) {
  const d = dist(a.p, b.p), k = 0.4 * d, ch = unit(sub(b.p, a.p)), perp = { x: -ch.y, y: ch.x };
  const da = a.n ?? ch, db = b.n ?? { x: -ch.x, y: -ch.y };
  const bend = l.bend ?? (!a.n && !b.n ? 0.25 * d : 0);
  const c1 = { x: a.p.x + da.x * k, y: a.p.y + da.y * k }, c2 = { x: b.p.x + db.x * k, y: b.p.y + db.y * k };
  // the unbent curve's midpoint; bending moves it 0.75 × bend along perp
  const base = { x: (a.p.x + 3 * c1.x + 3 * c2.x + b.p.x) / 8, y: (a.p.y + 3 * c1.y + 3 * c2.y + b.p.y) / 8 };
  const push = (p: Pt): Pt => ({ x: p.x + perp.x * bend, y: p.y + perp.y * bend });
  return { c1: push(c1), c2: push(c2), perp, base, bend };
}

/* an elbow's corner radius when the route is Rounded: true arcs, never a wavy curve */
export const ROUND_R = 14;
const STUB = 20;
/* does an axis-aligned polyline pass through a rect's interior? */
function crosses(pts: Pt[], r: Rect): boolean {
  const x0 = r.x + 1, x1 = r.x + r.w - 1, y0 = r.y + 1, y1 = r.y + r.h - 1;
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i - 1], q = pts[i];
    const lx = Math.min(p.x, q.x), hx = Math.max(p.x, q.x), ly = Math.min(p.y, q.y), hy = Math.max(p.y, q.y);
    if (hx > x0 && lx < x1 && hy > y0 && ly < y1) return true;
  }
  return false;
}
/* the elbow as planned (midpoint + midOffset): the route a facing pair takes, with its knob */
function plainElbow(l: Link, a: Port, b: Port): Pt[] {
  const P = elbowPlan(l, a, b), A = a.p, B = b.p;
  return dedupe(P.axA !== P.axB ? [A, P.axA === "h" ? { x: B.x, y: A.y } : { x: A.x, y: B.y }, B]
    : P.axA === "h" ? [A, { x: P.at, y: A.y }, { x: P.at, y: B.y }, B]
    : [A, { x: A.x, y: P.at }, { x: B.x, y: P.at }, B]);
}
/* every square route from a's stub to b's stub (L, Z through the middle or either stub, U
 * around both shapes), as full polylines */
function elbowCandidates(a: Port, b: Port): Pt[][] {
  const st = (q: Port) => (q.n ? { x: q.p.x + q.n.x * STUB, y: q.p.y + q.n.y * STUB } : q.p);
  const a1 = st(a), b1 = st(b), rs = [a.box, b.box].filter((r): r is Rect => !!r);
  const xs = new Set([(a1.x + b1.x) / 2, a1.x, b1.x]), ys = new Set([(a1.y + b1.y) / 2, a1.y, b1.y]);
  if (rs.length) {
    xs.add(Math.min(...rs.map((r) => r.x)) - STUB); xs.add(Math.max(...rs.map((r) => r.x + r.w)) + STUB);
    ys.add(Math.min(...rs.map((r) => r.y)) - STUB); ys.add(Math.max(...rs.map((r) => r.y + r.h)) + STUB);
  }
  const mids: Pt[][] = [[{ x: a1.x, y: b1.y }], [{ x: b1.x, y: a1.y }]];
  for (const m of xs) mids.push([{ x: m, y: a1.y }, { x: m, y: b1.y }]);
  for (const m of ys) mids.push([{ x: a1.x, y: m }, { x: b1.x, y: m }]);
  return mids.map((mid) => dedupe([a.p, a1, ...mid, b1, b.p]));
}
/* a usable route: no 180° fold back along itself, and it leaves and enters along the
 * pinned sides (first leg out along a's normal, last leg in against b's) */
function sound(pts: Pt[], a: Port, b: Port): boolean {
  for (let i = 2; i < pts.length; i++) {
    const u = unit(sub(pts[i - 1], pts[i - 2])), v = unit(sub(pts[i], pts[i - 1]));
    if (u.x * v.x + u.y * v.y < -0.5) return false;
  }
  const out = unit(sub(pts[1], pts[0])), inn = unit(sub(pts[pts.length - 1], pts[pts.length - 2]));
  if (a.n && out.x * a.n.x + out.y * a.n.y < 0.5) return false;
  if (b.n && -(inn.x * b.n.x + inn.y * b.n.y) < 0.5) return false;
  return true;
}
const routeCost = (pts: Pt[]) => pts.slice(1).reduce((t, q, i) => t + dist(q, pts[i]), 0) + 12 * (pts.length - 2);
/* the elbow a link takes: the planned elbow when it is sound and clear of both shapes,
 * else the cheapest sound candidate clear of both, else the sound one crossing least */
function elbowRoute(l: Link, a: Port, b: Port): { pts: Pt[]; planned: boolean } {
  const rs = [a.box, b.box].filter((r): r is Rect => !!r);
  const plain = plainElbow(l, a, b);
  if (sound(plain, a, b) && !rs.some((r) => crosses(plain, r))) return { pts: plain, planned: true };
  let best: Pt[] | null = null, bc = Infinity, fallback: Pt[] | null = null, fx = Infinity;
  for (const c of elbowCandidates(a, b)) {
    if (!sound(c, a, b)) continue;
    const x = rs.filter((r) => crosses(c, r)).length, cost = routeCost(c);
    if (!x && cost < bc) { best = c; bc = cost; }
    if (x && x * 1e6 + cost < fx) { fallback = c; fx = x * 1e6 + cost; }
  }
  return { pts: best ?? fallback ?? plain, planned: !best && !fallback };
}
const ELBOW: RouteDef = {
  name: "Elbow", key: "2", sided: true,
  geometry: (l, a, b) => ({ kind: "poly", pts: elbowRoute(l, a, b).pts }),
  handle(l, a, b) {
    if (!elbowRoute(l, a, b).planned) return null;   // a searched route has no free middle segment
    const P = elbowPlan(l, a, b);
    if (P.axA !== P.axB) return null;   // one bend: no middle segment to move
    return P.axA === "h" ? { p: { x: P.at, y: (a.p.y + b.p.y) / 2 }, cursor: "ew-resize" } : { p: { x: (a.p.x + b.p.x) / 2, y: P.at }, cursor: "ns-resize" };
  },
  drag(l, a, b, q) {
    const P = elbowPlan(l, a, b), off = (P.axA === "h" ? q.x : q.y) - P.mid;
    return { midOffset: Math.abs(off) < 0.5 ? undefined : off };
  },
};

export const ROUTES: Record<Route, RouteDef> = {
  straight: {
    name: "Straight", key: "1", sided: false,
    geometry: (_l, a, b) => ({ kind: "poly", pts: [a.p, b.p] }),
  },
  elbow: ELBOW,
  curved: {
    name: "Curved", key: "3", sided: true,
    geometry(l, a, b) { const C = curvePlan(l, a, b); return { kind: "cubic", pts: [a.p, C.c1, C.c2, b.p] }; },
    handle(l, a, b) { const C = curvePlan(l, a, b); return { p: { x: C.base.x + C.perp.x * 0.75 * C.bend, y: C.base.y + C.perp.y * 0.75 * C.bend }, cursor: "move" }; },
    drag(l, a, b, q) {
      const C = curvePlan(l, a, b), off = ((q.x - C.base.x) * C.perp.x + (q.y - C.base.y) * C.perp.y) / 0.75;
      return { bend: off };
    },
  },
  rounded: {
    ...ELBOW, name: "Rounded", key: "4",
    geometry: (l, a, b) => ({ ...ELBOW.geometry(l, a, b), r: ROUND_R }),
  },
};
export const ROUTE_IDS = Object.keys(ROUTES) as Route[];

export type Shapes = Map<string, Box>;
export function boxMap(els: El[]): Shapes {
  const m: Shapes = new Map();
  for (const e of els) if (!isLink(e)) m.set(e.id, e);
  return m;
}
export function linkGeo(l: Link, map: Shapes): Geo {
  const [a, b] = linkPorts(l, map);
  return ROUTES[l.route].geometry(l, a, b);
}
/* the path as a polyline: hit testing, bounds, selection (a cubic is sampled) */
export function geoPts(g: Geo): Pt[] {
  if (g.kind === "poly") return g.pts;
  const out: Pt[] = [];
  for (let i = 0; i <= 32; i++) out.push(cubicAt(g.pts, i / 32));
  return out;
}
export const linkPoints = (l: Link, map: Shapes): Pt[] => geoPts(linkGeo(l, map));
export const linkEnds = (l: Link, map: Shapes): [Pt, Pt] => { const [a, b] = linkPorts(l, map); return [a.p, b.p]; };
export function geoD(g: Geo): string {
  const P = (p: Pt) => fmt(p.x) + " " + fmt(p.y);
  if (g.kind === "cubic") return `M${P(g.pts[0])} C${P(g.pts[1])} ${P(g.pts[2])} ${P(g.pts[3])}`;
  if (!g.r || g.pts.length < 3) return g.pts.map((p, i) => (i ? "L" : "M") + P(p)).join(" ");
  // each corner: stop short of it, then a quarter-circle arc (radius capped by the half
  // segments on both sides, so short legs still meet cleanly)
  const ps = g.pts, out = ["M" + P(ps[0])];
  for (let i = 1; i < ps.length - 1; i++) {
    const a = ps[i - 1], c = ps[i], b = ps[i + 1];
    const r = Math.min(g.r, dist(a, c) / 2, dist(c, b) / 2);
    const ua = unit(sub(a, c)), ub = unit(sub(b, c)), cross = (c.x - a.x) * (b.y - c.y) - (c.y - a.y) * (b.x - c.x);
    if (r < 0.5 || Math.abs(cross) < 1e-9) { out.push("L" + P(c)); continue; }
    out.push("L" + P({ x: c.x + ua.x * r, y: c.y + ua.y * r }), `A${fmt(r)} ${fmt(r)} 0 0 ${cross > 0 ? 1 : 0} ` + P({ x: c.x + ub.x * r, y: c.y + ub.y * r }));
  }
  out.push("L" + P(ps[ps.length - 1]));
  return out.join(" ");
}
/* an end's tip, the unit direction the path arrives in (last segment / curve tangent),
 * and how much path there is to fit a head on */
export function geoEnd(g: Geo, which: "start" | "end"): { tip: Pt; dir: Pt; avail: number } {
  const ps = which === "end" ? g.pts : [...g.pts].reverse(), tip = ps[ps.length - 1];
  if (g.kind === "cubic") {
    const from = [ps[2], ps[1], ps[0]].find((p) => dist(p, tip) > 1e-6) ?? ps[0];
    return { tip, dir: unit(sub(tip, from)), avail: dist(ps[0], tip) };
  }
  let k = ps.length - 2;
  while (k > 0 && dist(ps[k], tip) < 1e-6) k--;
  const from = ps[Math.max(k, 0)];
  return { tip, dir: unit(sub(tip, from)), avail: dist(from, tip) };
}
/* shorten the path by d at one end, so a shaft stops under its head */
export function trimGeo(g: Geo, which: "start" | "end", d: number): Geo {
  if (d <= 0 || g.pts.length < 2) return g;
  if (g.kind === "poly") {
    const pts = [...g.pts], i = which === "end" ? pts.length - 1 : 0, j = which === "end" ? i - 1 : 1;
    const seg = dist(pts[i], pts[j]);
    if (seg < 0.02) return g;
    pts[i] = lerp(pts[i], pts[j], Math.min(d, seg - 0.01) / seg);
    return { ...g, pts };
  }
  const c = which === "end" ? g.pts : rev4(g.pts), tip = c[3];
  let lo = 0, hi = 1;
  for (let n = 0; n < 30; n++) { const m = (lo + hi) / 2; if (dist(cubicAt(c, m), tip) > d) lo = m; else hi = m; }
  const keep = cubicHead(c, lo);
  return { kind: "cubic", pts: which === "end" ? keep : rev4(keep) };
}

/* Compact technical heads: length 3·sw + 7, half-width 0.45 × length, tip exactly on the
 * endpoint. Each returns how far back the shaft has to stop so it never shows through. */
export const HEAD_K = 0.45;
export function headSvg(style: HeadStyle, tip: Pt, dir: Pt, len: number, sw: number, col: string): { svg: string; trim: number } {
  const at = (back: number, side: number): Pt => ({ x: tip.x - dir.x * back - dir.y * side, y: tip.y - dir.y * back + dir.x * side });
  if (style === "triangle") {
    return { svg: `<polygon points="${ptsAttr([tip, at(len, HEAD_K * len), at(len, -HEAD_K * len)])}" fill="${col}" stroke="none"/>`, trim: len * 0.7 };
  }
  // stroked heads: set the vertex back so the outer edge of its mitred point lands on the tip
  const inset = Math.min(sw / 2 / Math.sin(Math.atan(HEAD_K)), len * 0.5), hw = HEAD_K * (len - inset);
  const v = at(inset, 0), w1 = at(len, hw), w2 = at(len, -hw);
  const line = `fill="none" stroke-linejoin="miter" stroke-miterlimit="4" stroke-linecap="butt"`;
  if (style === "open-triangle") return { svg: `<polygon points="${ptsAttr([v, w1, w2])}" ${line}/>`, trim: len };
  return { svg: `<path d="M${fmt(w1.x)} ${fmt(w1.y)} L${fmt(v.x)} ${fmt(v.y)} L${fmt(w2.x)} ${fmt(w2.y)}" ${line}/>`, trim: inset };
}
export function linkSvg(l: Link, map: Shapes): string {
  let g = linkGeo(l, map);
  const col = esc(l.stroke), sw = l.strokeWidth, both = l.head === "both", single = g.kind === "cubic" || g.pts.length === 2;
  const ends: ("start" | "end")[] = l.head === "end" ? ["end"] : both ? ["end", "start"] : [];
  const heads: string[] = [], trims: [("start" | "end"), number][] = [];
  // sized from the untrimmed path, so both heads of a short line come out equal
  for (const which of ends) {
    const e = geoEnd(g, which), len = Math.min(3 * sw + 7, e.avail * (both && single ? 0.45 : 0.9));
    if (len < 1) continue;
    const h = headSvg(l.headStyle, e.tip, e.dir, len, sw, col);
    heads.push(h.svg); trims.push([which, h.trim]);
  }
  for (const [which, d] of trims) g = trimGeo(g, which, d);
  return `<g stroke="${col}" ${strokeAttrs(sw, l.dash)} fill="none">`
    + `<path d="${geoD(g)}"${dashAttr(sw, l.dash)}/>${heads.join("")}</g>`;
}

/* ─────────────────────────── labels + export ─────────────────────────── */

export function labelLayout(b: Box, font: FontId) {
  const area = SHAPES[b.kind].labelArea(b), lh = b.fontSize * LH;
  const lines = b.kind === "text" ? b.text.split("\n") : wrapText(b.text, Math.max(area.w, b.fontSize), b.fontSize, b.bold, font);
  const bh = lines.length * lh;
  const top = b.verticalAlign === "top" ? area.y : b.verticalAlign === "bottom" ? area.y + area.h - bh : area.y + (area.h - bh) / 2;
  const x = b.textAlign === "left" ? area.x : b.textAlign === "right" ? area.x + area.w : area.x + area.w / 2;
  const anchor = b.textAlign === "left" ? "start" : b.textAlign === "right" ? "end" : "middle";
  return { area, lines, lh, top, x, anchor };
}
export function labelSvg(b: Box, font: FontId): string {
  if (!b.text) return "";
  const L = labelLayout(b, font);
  const spans = L.lines.map((ln, i) => `<tspan x="${fmt(L.x)}" y="${fmt(L.top + i * L.lh + L.lh / 2)}">${esc(ln)}</tspan>`).join("");
  return `<text font-family='${FONTS[font].family}' font-size="${b.fontSize}" font-weight="${b.bold ? 700 : 400}" fill="${esc(b.stroke)}" `
    + `text-anchor="${L.anchor}" dominant-baseline="central" xml:space="preserve">${spans}</text>`;
}
export function elementSvg(e: El, map: Shapes, hideLabel: string | null, font: FontId): string {
  if (isLink(e)) return linkSvg(e, map);
  return SHAPES[e.kind].body(e) + (hideLabel === e.id ? "" : labelSvg(e, font));
}
export function elBounds(e: El, map: Shapes): Rect {
  if (!isLink(e)) return SHAPES[e.kind].bounds(e);
  const ps = linkPoints(e, map);
  const xs = ps.map((p) => p.x), ys = ps.map((p) => p.y);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}
export function contentBounds(els: El[], map: Shapes): Rect | null {
  return union(els.map((e) => inflate(elBounds(e, map), e.kind === "text" ? 0 : e.strokeWidth / 2 + (isLink(e) ? e.strokeWidth * 2 + 4 : 0))));
}
export function exportSvg(doc: Doc, css: string): { svg: string; w: number; h: number } {
  const map = boxMap(doc.elements), b = contentBounds(doc.elements, map), font = docFont(doc);
  const r = b ? inflate(b, PAD) : { x: 0, y: 0, w: 200, h: 120 };
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(r.w)}" height="${fmt(r.h)}" viewBox="${fmt(r.x)} ${fmt(r.y)} ${fmt(r.w)} ${fmt(r.h)}">`
    + (css ? `<defs><style>${css}</style></defs>` : "")
    + `<rect x="${fmt(r.x)}" y="${fmt(r.y)}" width="${fmt(r.w)}" height="${fmt(r.h)}" fill="#ffffff"/>`
    + doc.elements.map((e) => elementSvg(e, map, null, font)).join("") + `</svg>`;
  return { svg, w: r.w, h: r.h };
}

/* ─────────────────────────── hit testing + snapping ─────────────────────────── */

/* locked elements are skipped unless `locked` asks for them (the right-click menu does) */
export function hitTest(els: El[], map: Shapes, p: Pt, tol: number, locked = false): string | null {
  const skip = (e: El) => !!e.locked && !locked;
  for (let i = els.length - 1; i >= 0; i--) {
    const e = els[i];
    if (!isLink(e) || skip(e)) continue;
    const ps = linkPoints(e, map);
    for (let k = 1; k < ps.length; k++) if (distSeg(p, ps[k - 1], ps[k]) <= tol + e.strokeWidth / 2) return e.id;
  }
  // smallest shape under the point wins, so a frame never swallows what sits inside it
  let best: Box | null = null;
  for (const e of els) if (!isLink(e) && !skip(e) && SHAPES[e.kind].hit(e, p, tol) && (!best || e.w * e.h <= best.w * best.h)) best = e;
  return best ? best.id : null;
}
export function bindTarget(els: El[], p: Pt, exclude: Set<string>, tol: number): Box | null {
  let best: Box | null = null;
  for (const e of els) {
    if (isLink(e) || exclude.has(e.id) || !SHAPES[e.kind].hit(e, p, tol)) continue;
    if (!best || e.w * e.h <= best.w * best.h) best = e;
  }
  return best;
}
export interface Cand { v: number; r: Rect }
export interface Cands { xs: Cand[]; ys: Cand[] }
export interface Guide { x1: number; y1: number; x2: number; y2: number }
export function snapCands(els: El[], exclude: Set<string>): Cands {
  const xs: Cand[] = [], ys: Cand[] = [];
  for (const e of els) {
    if (isLink(e) || exclude.has(e.id)) continue;
    const r = SHAPES[e.kind].bounds(e);
    xs.push({ v: r.x, r }, { v: r.x + r.w / 2, r }, { v: r.x + r.w, r });
    ys.push({ v: r.y, r }, { v: r.y + r.h / 2, r }, { v: r.y + r.h, r });
  }
  return { xs, ys };
}
/* nearest edge/centre alignment per axis, within tol */
export function alignSnap(r: Rect, c: Cands, tol: number) {
  const pick = (vals: number[], cs: Cand[]) => {
    let best: { off: number; cand: Cand } | null = null;
    for (const v of vals) for (const cand of cs) {
      const off = cand.v - v;
      if (Math.abs(off) <= tol && (!best || Math.abs(off) < Math.abs(best.off))) best = { off, cand };
    }
    return best;
  };
  return { x: pick([r.x, r.x + r.w / 2, r.x + r.w], c.xs), y: pick([r.y, r.y + r.h / 2, r.y + r.h], c.ys) };
}
export function guideLines(r: Rect, a: ReturnType<typeof alignSnap>): Guide[] {
  const g: Guide[] = [];
  if (a.x) g.push({ x1: a.x.cand.v, y1: Math.min(r.y, a.x.cand.r.y) - 8, x2: a.x.cand.v, y2: Math.max(r.y + r.h, a.x.cand.r.y + a.x.cand.r.h) + 8 });
  if (a.y) g.push({ y1: a.y.cand.v, x1: Math.min(r.x, a.y.cand.r.x) - 8, y2: a.y.cand.v, x2: Math.max(r.x + r.w, a.y.cand.r.x + a.y.cand.r.w) + 8 });
  return g;
}
/* alignment to other elements first, the 10px grid otherwise; Alt turns both off */
export function snapDelta(r: Rect, dx: number, dy: number, c: Cands, tol: number) {
  const m = { ...r, x: r.x + dx, y: r.y + dy }, a = alignSnap(m, c, tol);
  dx += a.x ? a.x.off : snapV(m.x) - m.x;
  dy += a.y ? a.y.off : snapV(m.y) - m.y;
  return { dx, dy, guides: guideLines({ ...r, x: r.x + dx, y: r.y + dy }, a) };
}
export function snapPoint(p: Pt, c: Cands, tol: number, off: boolean): { p: Pt; guides: Guide[] } {
  if (off) return { p, guides: [] };
  const a = alignSnap({ x: p.x, y: p.y, w: 0, h: 0 }, c, tol);
  const q = { x: a.x ? p.x + a.x.off : snapV(p.x), y: a.y ? p.y + a.y.off : snapV(p.y) };
  return { p: q, guides: guideLines({ x: q.x, y: q.y, w: 0, h: 0 }, a) };
}

/* ─────────────────────────── pure document operations ─────────────────────────── */

export function newBox(kind: BoxKind, r: Rect): Box {
  const text = kind === "text";
  return {
    id: newId(), kind, groupIds: [], x: r.x, y: r.y, w: r.w, h: r.h, ...(kind === "rect" ? { rounded: false } : {}),
    text: "", textAlign: text ? "left" : "center", verticalAlign: text ? "top" : "middle",
    fontSize: 20, bold: false, fill: null, stroke: INK, strokeWidth: DEFAULT_SW, dash: "solid",
  };
}
/* the next link drawn takes the route, pattern and heads last chosen in this session */
export const linkPrefs: { route: Route; dash: Dash; headStyle: HeadStyle; head: "end" | "both" } = { route: "straight", dash: "solid", headStyle: "triangle", head: "end" };
export function newLink(kind: LinkKind, start: End, end: End): Link {
  return {
    id: newId(), kind, groupIds: [], start, end, route: linkPrefs.route, head: kind === "arrow" ? linkPrefs.head : "none",
    headStyle: linkPrefs.headStyle, stroke: INK, strokeWidth: DEFAULT_SW, dash: linkPrefs.dash,
  };
}
export const withEls = (doc: Doc, elements: El[]): Doc => ({ ...doc, elements });
export function addElements(doc: Doc, els: El[]): Doc { return withEls(doc, [...doc.elements, ...els]); }
export function updateElements(doc: Doc, ids: Iterable<string>, fn: (e: El) => El): Doc {
  const set = new Set(ids);
  return withEls(doc, doc.elements.map((e) => (set.has(e.id) ? fn(e) : e)));
}
/* Moving an arrow whose bound shape stays put frees that end at its current point;
 * an end bound to a shape that moves along simply follows it. */
export function moveElements(doc: Doc, ids: string[], dx: number, dy: number): Doc {
  const set = new Set(ids), map = boxMap(doc.elements);
  return withEls(doc, doc.elements.map((e) => {
    if (!set.has(e.id) || e.locked) return e;
    if (!isLink(e)) return { ...e, x: e.x + dx, y: e.y + dy };
    const [a, b] = linkEnds(e, map);
    const mv = (end: End, p: Pt): End => (end.bind && set.has(end.bind) && map.has(end.bind) ? end : { x: p.x + dx, y: p.y + dy });
    return { ...e, start: mv(e.start, a), end: mv(e.end, b) };
  }));
}
export function resizeElement(doc: Doc, id: string, r: Rect): Doc {
  return updateElements(doc, [id], (e) => (isLink(e) ? e : { ...e, ...r }));
}
export function bindEndpoint(doc: Doc, id: string, which: "start" | "end", end: End): Doc {
  return updateElements(doc, [id], (e) => (!isLink(e) ? e : which === "start" ? { ...e, start: end } : { ...e, end }));
}
export function setText(doc: Doc, id: string, text: string): Doc {
  return updateElements(doc, [id], (e) => (isLink(e) ? { ...e, text } : fitText({ ...e, text }, docFont(doc))));
}

export function refitText(b: Box, font: FontId): Box {
  const n = fitText(b, font), d = b.w - n.w;
  return b.textAlign === "left" || !d ? n : { ...n, x: b.x + (b.textAlign === "center" ? d / 2 : d) };
}
/* switching the drawing's typeface re-fits every free text to its new widths */
export function setFont(doc: Doc, font: FontId): Doc {
  return { ...doc, font, elements: doc.elements.map((e) => (isLink(e) ? e : refitText(e, font))) };
}
export function setLocked(doc: Doc, ids: string[], locked: boolean): Doc {
  return updateElements(doc, ids, (e) => { const n = { ...e }; if (locked) n.locked = true; else delete n.locked; return n; });
}
/* deleting a shape frees (does not delete) the arrows bound to it */
export function deleteElements(doc: Doc, ids: string[]): Doc {
  const dead = new Set(ids), map = boxMap(doc.elements);
  return withEls(doc, doc.elements.filter((e) => !dead.has(e.id)).map((e) => {
    if (!isLink(e)) return e;
    const s = !!e.start.bind && dead.has(e.start.bind), t = !!e.end.bind && dead.has(e.end.bind);
    if (!s && !t) return e;
    const [a, b] = linkEnds(e, map);
    return { ...e, start: s ? { x: a.x, y: a.y } : e.start, end: t ? { x: b.x, y: b.y } : e.end };
  }));
}
export interface StylePatch { fill?: string | null; stroke?: string; strokeWidth?: number; dash?: Dash; rounded?: boolean; fontSize?: number; bold?: boolean; textAlign?: Box["textAlign"]; head?: Heads; headStyle?: HeadStyle; route?: Route }
export function setStyle(doc: Doc, ids: string[], p: StylePatch): Doc {
  return updateElements(doc, ids, (e) => {
    if (isLink(e)) {
      const n: Link = { ...e };
      if (p.stroke !== undefined) n.stroke = p.stroke;
      if (p.strokeWidth !== undefined) n.strokeWidth = p.strokeWidth;
      if (p.dash !== undefined) n.dash = p.dash;
      if (p.head !== undefined) n.head = p.head;
      if (p.headStyle !== undefined) n.headStyle = p.headStyle;
      if (p.route !== undefined) n.route = p.route;
      return n;
    }
    const n: Box = { ...e }, shape = e.kind !== "text";
    if (p.stroke !== undefined) n.stroke = p.stroke;
    if (p.fill !== undefined && shape) n.fill = p.fill;
    if (p.strokeWidth !== undefined && shape) n.strokeWidth = p.strokeWidth;
    if (p.dash !== undefined && shape) n.dash = p.dash;
    if (p.rounded !== undefined && e.kind === "rect") n.rounded = p.rounded;
    if (p.fontSize !== undefined) n.fontSize = p.fontSize;
    if (p.bold !== undefined) n.bold = p.bold;
    if (p.textAlign !== undefined) n.textAlign = p.textAlign;
    return fitText(n, docFont(doc));
  });
}
/* Ctrl+] / Ctrl+[: each selected element steps one place past its unselected neighbour;
 * `far` (with Shift) sends the selection all the way to the front or the back */
export function reorderElements(doc: Doc, ids: string[], dir: 1 | -1, far = false): Doc {
  const set = new Set(ids), a = [...doc.elements];
  if (far) {
    const out = a.filter((e) => !set.has(e.id)), mine = a.filter((e) => set.has(e.id));
    return withEls(doc, dir > 0 ? [...out, ...mine] : [...mine, ...out]);
  }
  const swap = (i: number, j: number) => { const t = a[i]; a[i] = a[j]; a[j] = t; };
  if (dir > 0) { for (let i = a.length - 2; i >= 0; i--) if (set.has(a[i].id) && !set.has(a[i + 1].id)) swap(i, i + 1); }
  else { for (let i = 1; i < a.length; i++) if (set.has(a[i].id) && !set.has(a[i - 1].id)) swap(i, i - 1); }
  return withEls(doc, a);
}

export function unitGroup(e: El, entered: string | null): string | null {
  const g = e.groupIds;
  if (!g.length) return null;
  const k = entered ? g.indexOf(entered) : -1;
  if (k < 0) return g[g.length - 1];
  return k > 0 ? g[k - 1] : null;
}
export function unitIds(els: El[], e: El, entered: string | null): string[] {
  const g = unitGroup(e, entered);
  return g ? els.filter((x) => x.groupIds.includes(g)).map((x) => x.id) : [e.id];
}
export function groupElements(doc: Doc, ids: string[], entered: string | null): Doc {
  const gid = newId();
  return updateElements(doc, ids, (e) => {
    const g = [...e.groupIds], k = entered ? g.indexOf(entered) : -1;
    if (k >= 0) g.splice(k, 0, gid); else g.push(gid);
    return { ...e, groupIds: g };
  });
}
export function ungroupElements(doc: Doc, ids: string[], entered: string | null): Doc {
  const set = new Set(ids), gone = new Set<string>();
  for (const e of doc.elements) if (set.has(e.id)) { const g = unitGroup(e, entered); if (g) gone.add(g); }
  if (!gone.size) return doc;
  return withEls(doc, doc.elements.map((e) => (e.groupIds.some((g) => gone.has(g)) ? { ...e, groupIds: e.groupIds.filter((g) => !gone.has(g)) } : e)));
}
/* copy-ready clones: arrow ends bound outside the set go free, groups not wholly
 * inside the set are dropped (a copy never joins the original's outer group) */
export function detach(doc: Doc, ids: string[]): El[] {
  const set = new Set(ids), map = boxMap(doc.elements);
  const owned = (g: string) => doc.elements.every((e) => !e.groupIds.includes(g) || set.has(e.id));
  return doc.elements.filter((e) => set.has(e.id)).map((e) => {
    const groupIds = e.groupIds.filter(owned);
    if (!isLink(e)) return { ...e, groupIds };
    const [a, b] = linkEnds(e, map);
    const keep = (end: End, p: Pt): End => (end.bind && set.has(end.bind) ? { ...end } : { x: p.x, y: p.y });
    return { ...e, groupIds, start: keep(e.start, a), end: keep(e.end, b) };
  });
}

export function cloneElements(list: El[], dx: number, dy: number): El[] {
  const ids = new Map(list.map((e) => [e.id, newId()] as const)), gids = new Map<string, string>();
  const gid = (g: string) => { let n = gids.get(g); if (!n) { n = newId(); gids.set(g, n); } return n; };
  const end = (e: End): End => ({ x: e.x + dx, y: e.y + dy, ...(e.bind && ids.has(e.bind) ? { bind: ids.get(e.bind)! } : {}), ...(e.anchor ? { anchor: e.anchor } : {}) });
  return list.map((e) => {
    const base = { id: ids.get(e.id)!, groupIds: e.groupIds.map(gid) };
    const n: El = isLink(e) ? { ...e, ...base, start: end(e.start), end: end(e.end) } : { ...e, ...base, x: e.x + dx, y: e.y + dy };
    delete n.locked;
    return n;
  });
}
const rawBounds = (els: El[]): Rect | null => { const map = boxMap(els); return union(els.map((e) => elBounds(e, map))); };
/* a template's elements dropped into a drawing: copies whose bounds centre lands on `at`
 * (to the nearest grid step, so what was drawn on the grid stays on it) */
export function instantiate(elements: El[], at: Pt): El[] {
  const b = rawBounds(elements), c = b ? centre(b) : at;
  return cloneElements(elements, snapV(at.x - c.x), snapV(at.y - c.y));
}

export function extractTemplate(doc: Doc, ids: string[]): Doc {
  const els = detach(doc, ids.length ? ids : doc.elements.map((e) => e.id)), b = rawBounds(els);
  const back = (v: number) => -Math.floor(v / GRID) * GRID;
  return tidy({ type: "aioadraw", version: 1, font: docFont(doc), elements: cloneElements(els, b ? back(b.x) : 0, b ? back(b.y) : 0) });
}
/* whole numbers-ish in the saved file: it is meant to be read */
export function tidy(doc: Doc): Doc {
  const r = (n: number) => Math.round(n * 10) / 10;
  const end = (e: End): End => ({ ...e, x: r(e.x), y: r(e.y) });
  const knob = (v: number | undefined) => (v === undefined ? undefined : r(v));
  return withEls(doc, doc.elements.map((e) => (isLink(e)
    ? { ...e, start: end(e.start), end: end(e.end), midOffset: knob(e.midOffset), bend: knob(e.bend) }
    : { ...e, x: r(e.x), y: r(e.y), w: r(e.w), h: r(e.h) })));
}
export function normalize(raw: unknown[]): El[] {
  const out: El[] = [];
  const num = (v: unknown, d: number) => (typeof v === "number" && isFinite(v) ? v : d);
  const str = (v: unknown, d: string) => (typeof v === "string" && v ? v : d);
  const dash = (v: unknown): Dash => (DASHES.includes(v as Dash) ? (v as Dash) : "solid");
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const base = {
      id: str(o.id, newId()),
      groupIds: Array.isArray(o.groupIds) ? o.groupIds.filter((g): g is string => typeof g === "string") : [],
      ...(o.locked === true ? { locked: true } : {}),
    };
    if (o.kind === "arrow" || o.kind === "line") {
      const end = (v: unknown): End => {
        const e = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
        const anchor = Array.isArray(e.anchor) && e.anchor.length === 2 ? [num(e.anchor[0], 0.5), num(e.anchor[1], 0.5)] as [number, number] : null;
        return { x: num(e.x, 0), y: num(e.y, 0), ...(typeof e.bind === "string" && e.bind ? { bind: e.bind } : {}), ...(anchor ? { anchor } : {}) };
      };
      out.push({
        ...base, kind: o.kind, start: end(o.start), end: end(o.end),
        route: ROUTE_IDS.includes(o.route as Route) ? (o.route as Route) : "straight",
        ...(typeof o.midOffset === "number" && isFinite(o.midOffset) ? { midOffset: o.midOffset } : {}),
        ...(typeof o.bend === "number" && isFinite(o.bend) ? { bend: o.bend } : {}),
        head: o.head === "none" || o.head === "both" || o.head === "end" ? o.head : o.kind === "arrow" ? "end" : "none",
        headStyle: HEAD_STYLES.includes(o.headStyle as HeadStyle) ? (o.headStyle as HeadStyle) : "chevron",
        stroke: str(o.stroke, INK), strokeWidth: num(o.strokeWidth, 3), dash: dash(o.dash),
        ...(typeof o.text === "string" && o.text ? { text: o.text } : {}),
      });
    } else if (BOX_KINDS.includes(o.kind as BoxKind)) {
      const kind = o.kind as BoxKind, text = kind === "text";
      const b: Box = {
        ...base, kind, x: num(o.x, 0), y: num(o.y, 0), w: num(o.w, 160), h: num(o.h, 80),
        ...(kind === "rect" ? { rounded: o.rounded === true } : {}),
        text: typeof o.text === "string" ? o.text : "",
        textAlign: o.textAlign === "left" || o.textAlign === "right" || o.textAlign === "center" ? o.textAlign : text ? "left" : "center",
        verticalAlign: o.verticalAlign === "top" || o.verticalAlign === "bottom" || o.verticalAlign === "middle" ? o.verticalAlign : text ? "top" : "middle",
        fontSize: num(o.fontSize, 20), bold: o.bold === true,
        fill: typeof o.fill === "string" && o.fill ? o.fill : null,
        stroke: str(o.stroke, INK), strokeWidth: num(o.strokeWidth, 3), dash: dash(o.dash),
      };
      out.push(b);
    }
  }
  return out;
}
export function migrate(raw: unknown): Doc | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.type !== "aioadraw" || !Array.isArray(o.elements)) return null;
  // EXTENSION POINT: schema upgrades. Version 1 is the only one; a v2 converts here.
  // In-place upgrades within v1: the boolean `dashed` became the `dash` pattern.
  const elements = o.elements.map((e) => {
    if (!e || typeof e !== "object") return e;
    const { dashed, ...rest } = e as Record<string, unknown>;
    return "dash" in rest ? rest : { ...rest, dash: dashed === true ? "dashed" : "solid" };
  });
  const font = FONT_IDS.includes(o.font as FontId) ? (o.font as FontId) : LEGACY_FONT;
  return { type: "aioadraw", version: 1, font, elements: normalize(elements) };
}

/* ─────────────────────────── clean up ─────────────────────────── */

export function cleanupDoc(doc: Doc): { doc: Doc; report: string[] } {
  const report: string[] = [];
  const els = doc.elements, map = boxMap(els);
  const live = els.filter((e): e is Box => !isLink(e) && !e.locked);
  const shapes = live.filter((b) => b.kind !== "text");
  if (!shapes.length) return { doc, report: ["nothing to clean: no unlocked shapes"] };
  const inside = (o: Rect, i: Rect) => i.x >= o.x - 0.5 && i.y >= o.y - 0.5 && i.x + i.w <= o.x + o.w + 0.5 && i.y + i.h <= o.y + o.h + 0.5;
  const boxes = new Map<string, Box>(shapes.map((b) => [b.id, { ...b }]));
  const containers = new Map<string, { kids: string[]; pad: [number, number, number, number] }>();
  for (const c of shapes) {
    const kids = els.filter((e) => e.id !== c.id && !isLink(e) && inside(c, elBounds(e, map))).map((e) => e.id);
    if (!kids.length) continue;
    const u = union(kids.map((k) => elBounds(map.get(k)!, map)))!;
    containers.set(c.id, { kids, pad: [u.y - c.y, c.x + c.w - (u.x + u.w), c.y + c.h - (u.y + u.h), u.x - c.x].map((v) => Math.max(20, snapV(v))) as [number, number, number, number] });
  }
  const nodes = [...boxes.values()].filter((b) => !containers.has(b.id));
  // locked shapes: never moved, but the others line up on them
  const marks = els.filter((e): e is Box => !isLink(e) && !!e.locked && e.kind !== "text"), markIds = new Set(marks.map((b) => b.id));
  const cx = (b: Box) => b.x + b.w / 2, cy = (b: Box) => b.y + b.h / 2;
  const up20 = (v: number) => Math.ceil(v / 20 - 1e-6) * 20;
  const setC = (b: Box, x: number, y: number) => { b.x = x - b.w / 2; b.y = y - b.h / 2; };

  // 2. look-alike sizes (union-find over kind + size similarity)
  const parent = new Map(nodes.map((b) => [b.id, b.id]));
  const root = (id: string): string => { while (parent.get(id) !== id) id = parent.get(id)!; return id; };
  for (const a of nodes) for (const b of nodes) {
    if (a.id >= b.id || a.kind !== b.kind) continue;
    if (Math.abs(a.w - b.w) <= 0.25 * Math.max(a.w, b.w) && Math.abs(a.h - b.h) <= 0.25 * Math.max(a.h, b.h)) parent.set(root(a.id), root(b.id));
  }
  const clusters = new Map<string, Box[]>();
  for (const b of nodes) { const r = root(b.id); clusters.set(r, [...(clusters.get(r) || []), b]); }
  let sized = 0, fonts = 0;
  for (const c of clusters.values()) {
    const w = up20(Math.max(...c.map((b) => b.w))), h = up20(Math.max(...c.map((b) => b.h)));
    for (const b of c) { if (b.w !== w || b.h !== h) { const x = cx(b), y = cy(b); b.w = w; b.h = h; setC(b, x, y); sized++; } }
    // 5. label sizes that differ among look-alikes: named, left alone
    const sizes = new Set(c.filter((b) => b.text.trim()).map((b) => b.fontSize));
    if (sizes.size > 1) fonts++;
  }
  if (sized) report.push(`sizes: ${sized} shape(s) matched to their look-alikes`);
  if (fonts) report.push(`note: ${fonts} group(s) of look-alike shapes mix label sizes (left as they are)`);

  // 3. rows and columns: chain shapes whose centres sit within tolerance, then share the mean
  // each node's scope: the smallest frame around it (or the page); lines never cross scopes
  const scope = new Map<string, string>();
  for (const b of [...nodes, ...marks]) {
    let best = "", area = Infinity;
    for (const [cid, k] of containers) if (k.kids.includes(b.id)) { const c = boxes.get(cid)!; if (c.w * c.h < area) { area = c.w * c.h; best = cid; } }
    scope.set(b.id, best);
  }
  const lines = (axis: "x" | "y") => {
    const c = axis === "y" ? cy : cx, ext = (b: Box) => (axis === "y" ? b.h : b.w), out: Box[][] = [];
    for (const sc of new Set(scope.values())) {
      const sorted = [...nodes, ...marks].filter((b) => scope.get(b.id) === sc).sort((a, b) => c(a) - c(b)), here: Box[][] = [];
      for (const b of sorted) {
        const g = here[here.length - 1];
        if (g) { const m = g.reduce((s, q) => s + c(q), 0) / g.length; if (Math.abs(c(b) - m) <= Math.max(12, 0.35 * Math.min(ext(b), ...g.map(ext)))) { g.push(b); continue; } }
        here.push([b]);
      }
      out.push(...here.filter((g) => g.length > 1));
    }
    return out;
  };
  const fixed = (b: Box) => markIds.has(b.id);
  let aligned = 0;
  const onMark = { x: new Set<string>(), y: new Set<string>() };   // lined up on a locked shape: no grid snap on that axis
  for (const axis of ["y", "x"] as const) {
    for (const g of lines(axis)) {
      // a locked member is the mark; else the mean, on the grid
      const mk = g.find(fixed), m = mk ? (axis === "y" ? cy(mk) : cx(mk)) : snapV(g.reduce((s, b) => s + (axis === "y" ? cy(b) : cx(b)), 0) / g.length);
      for (const b of g) { if (fixed(b)) continue; if (mk) onMark[axis].add(b.id); const now = axis === "y" ? cy(b) : cx(b); if (Math.abs(now - m) > 0.01) { if (axis === "y") setC(b, cx(b), m); else setC(b, m, cy(b)); aligned++; } }
    }
  }
  if (aligned) report.push(`alignment: ${aligned} shape(s) moved onto a shared row or column`);

  // 4. even gaps along each row (x) and column (y)
  let evened = 0;
  for (const [axis, along] of [["y", "x"], ["x", "y"]] as const) {
    for (const g of lines(axis)) {
      if (g.length < 3 || g.some(fixed)) continue;
      const lo = (b: Box) => (along === "x" ? b.x : b.y), len = (b: Box) => (along === "x" ? b.w : b.h);
      g.sort((a, b) => lo(a) - lo(b));
      const gaps = g.slice(1).map((b, i) => lo(b) - (lo(g[i]) + len(g[i])));
      if (Math.min(...gaps) <= 0 || Math.max(...gaps) > 2 * Math.min(...gaps)) continue;
      const first = g[0], last = g[g.length - 1], total = lo(last) + len(last) - lo(first);
      const gap = snapV((total - g.reduce((s, b) => s + len(b), 0)) / (g.length - 1));
      let at = lo(first);
      for (const b of g) {
        if (Math.abs(lo(b) - at) > 0.01) { if (along === "x") b.x = at; else b.y = at; evened++; }
        at += len(b) + gap;
      }
    }
  }
  if (evened) report.push(`spacing: ${evened} shape(s) moved to even gaps`);

  // final grid: every node's centre on the grid (sizes are multiples of 20, so edges are too)
  let gridded = 0;
  for (const b of nodes) { const x = onMark.x.has(b.id) ? cx(b) : snapV(cx(b)), y = onMark.y.has(b.id) ? cy(b) : snapV(cy(b)); if (Math.abs(x - cx(b)) > 0.01 || Math.abs(y - cy(b)) > 0.01) { setC(b, x, y); gridded++; } }
  if (gridded) report.push(`grid: ${gridded} shape(s) centred on the 10 px grid`);

  // 7. containers wrap what they held, with their old padding
  let wrapped = 0;
  const cur = (id: string): Rect => boxes.get(id) ?? elBounds(map.get(id)!, map);
  const order = [...containers.keys()].sort((a, b) => boxes.get(a)!.w * boxes.get(a)!.h - boxes.get(b)!.w * boxes.get(b)!.h);
  for (const id of order) {
    const c = boxes.get(id)!, { kids, pad } = containers.get(id)!, u = union(kids.map(cur))!;
    const r = { x: snapV(u.x - pad[3]), y: snapV(u.y - pad[0]), w: 0, h: 0 };
    r.w = snapV(u.x + u.w + pad[1]) - r.x; r.h = snapV(u.y + u.h + pad[2]) - r.y;
    if (r.x !== c.x || r.y !== c.y || r.w !== c.w || r.h !== c.h) { Object.assign(c, r); wrapped++; }
  }
  if (wrapped) report.push(`containers: ${wrapped} re-wrapped around their contents`);

  // 6. the title, then the other free text onto the grid
  const font = docFont(doc);
  const texts = new Map(live.filter((b) => b.kind === "text").map((b) => [b.id, fitText({ ...b }, font)]));
  const content = union([...boxes.values()]);
  const above = content ? [...texts.values()].filter((t) => t.y + t.h <= content.y + 1) : [];
  const title = above.sort((a, b) => b.fontSize - a.fontSize || a.y - b.y)[0];
  if (title && content) {
    const t = fitText({ ...title, bold: true, fontSize: clamp(title.fontSize, 28, 36), textAlign: "center" }, font);
    t.x = content.x + content.w / 2 - t.w / 2; t.y = snapV(content.y - 40 - t.h);
    if (t.x !== title.x || t.y !== title.y || t.fontSize !== title.fontSize || !title.bold) report.push("title: bold, centred over the diagram, 40 px above it");
    texts.set(t.id, t);
  } else report.push("title: none found (a free text above the diagram becomes the title)");
  let snapped = 0;
  for (const t of texts.values()) if (t.id !== title?.id) { const x = snapV(t.x), y = snapV(t.y); if (x !== t.x || y !== t.y) { t.x = x; t.y = y; snapped++; } }
  if (snapped) report.push(`free text: ${snapped} snapped to the grid`);

  let bound = 0;
  // the nearest shape or text within 32 px (a frame only when nothing inside it is nearer:
  // its edge counts, not its inside), locked ones included — they stay put anyway
  const gap = (o: Box, q: Pt) => Math.hypot(Math.max(o.x - q.x, 0, q.x - o.x - o.w), Math.max(o.y - q.y, 0, q.y - o.y - o.h));
  const edge = (o: Box, q: Pt) => Math.min(Math.abs(q.x - o.x), Math.abs(q.x - o.x - o.w), Math.abs(q.y - o.y), Math.abs(q.y - o.y - o.h));
  const cand = els.filter((e): e is Box => !isLink(e));
  const near = (q: Pt) => {
    let best: Box | undefined, bd = 32;
    for (const o of cand) {
      const d = containers.has(o.id) ? (gap(o, q) > 0 ? gap(o, q) : edge(o, q)) + 8 : gap(o, q);   // a frame loses ties
      if (d <= bd) { bd = d; best = o; }
    }
    return best;
  };
  const links = new Map<string, El>();
  for (const l of els) {
    if (!isLink(l) || l.locked) continue;
    const attach = (e: End): End => {
      const o = e.bind ? undefined : near(e);
      if (!o) return e;
      let anchor: [number, number];
      if (o.kind === "rect" || o.kind === "text") {
        const fx = clamp((e.x - o.x) / (o.w || 1), 0, 1), fy = clamp((e.y - o.y) / (o.h || 1), 0, 1);
        const d = [fx, 1 - fx, fy, 1 - fy], k = d.indexOf(Math.min(...d));
        anchor = k === 0 ? [0, fy] : k === 1 ? [1, fy] : k === 2 ? [fx, 0] : [fx, 1];
      } else anchor = outlineAnchor(o, e);
      bound++;
      return { x: e.x, y: e.y, bind: o.id, anchor };
    };
    const st = attach(l.start), en = attach(l.end);
    if (st !== l.start || en !== l.end) links.set(l.id, { ...l, start: st, end: en });
  }
  if (bound) report.push(`arrow ends: ${bound} attached to the shape they were touching`);
  const changed = new Map<string, El>([...boxes, ...texts, ...links]);
  const next = updateElements(doc, changed.keys(), (e) => changed.get(e.id) ?? e);
  if (!report.some((l) => !l.startsWith("title: none"))) report.unshift("already clean");
  return { doc: next, report };
}
