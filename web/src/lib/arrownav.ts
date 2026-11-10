

import { openObsidian } from "@/lib/opener";
import {
  easeIntoView, readerScroll, endRamp, reducedMotion, animating, pendingOf,
  FAST_MS, SLOW_MS, ELASTIC, MAX_FRAME, READER_STEP,
} from "@/lib/scroll";

export const KNAV_MARKER = "board-arrownav-v2";

type Dir = "up" | "down" | "left" | "right";
type Box = { top: number; bottom: number; left: number; right: number };
type Cand = { el: HTMLElement; box: Box };
type LevelKind = "rail" | "page" | "tile" | "inside" | "focused" | "full" | "overlay";
type Level = { kind: LevelKind; tile?: HTMLElement };

const ARROWS: Record<string, Dir> = {
  ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right",
};

const CANDIDATE = [
  "button:not([disabled])", "a[href]", "summary",
  "input:not([disabled]):not([type=hidden])", "select:not([disabled])", "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
  "[role=button]", "[role=tab]", "[role=option]", "[role=menuitem]", "[role=menuitemcheckbox]",
  "[role=menuitemradio]", "[role=checkbox]", "[role=switch]", "[role=radio]", "[role=link]",
  "[role=treeitem]", "[role=gridcell]",
  "[data-knav-item]", ".cursor-pointer", ".hover\\:cursor-pointer", ".cm-content",
].join(",");

const WIDGET = "[data-knav-widget]";
const TEXT_TYPES = new Set(["", "text", "search", "email", "url", "tel", "password"]);
const VALUE_TYPES = new Set(["number", "date", "time", "datetime-local", "month", "week", "range"]);

/* ------------------------------------------------------------------ geometry */

const boxOf = (r: DOMRect | Box): Box => ({ top: r.top, bottom: r.bottom, left: r.left, right: r.right });

type Clip = { x: Box | null; y: Box | null; fixed: boolean };

function visibleBox(el: HTMLElement, clip: Map<Element, Clip>): Box | null {
  const raw = el.getBoundingClientRect();
  if (raw.width < 2 || raw.height < 2) return null;
  const cv = (el as HTMLElement & { checkVisibility?: (o?: object) => boolean }).checkVisibility;
  if (cv && !cv.call(el, { checkVisibilityCSS: true })) return null;
  if (getComputedStyle(el).position === "fixed") return boxOf(raw);
  
  const live = animating();
  let dy = 0;
  let r = boxOf(raw);
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    let c = clip.get(p);
    if (!c) {
      const cs = getComputedStyle(p);
      const pr = (cs.overflowX !== "visible" || cs.overflowY !== "visible") ? boxOf(p.getBoundingClientRect()) : null;
      c = {
        x: pr && /hidden|clip/.test(cs.overflowX) ? pr : null,
        y: pr && /hidden|clip/.test(cs.overflowY) ? pr : null,
        fixed: cs.position === "fixed",
      };
      clip.set(p, c);
    }
    if (c.x && (r.right <= c.x.left + 1 || r.left >= c.x.right - 1)) return null;
    if (c.y && (r.bottom <= c.y.top + 1 || r.top >= c.y.bottom - 1)) return null;
    if (c.fixed) break;   // a fixed layer escapes its ancestors' clipping
    if (live) {
      const d = pendingOf(p);
      if (d) { dy += d; r = { ...r, top: r.top - d, bottom: r.bottom - d }; }
    }
  }
  return dy ? r : boxOf(raw);
}

const OVERLAY = "[role=dialog], [role=alertdialog], [data-knav-modal]";
const LAYER = `${OVERLAY}, .fixed.inset-0`;

function topModal(): HTMLElement | null {
  const ms = Array.from(document.querySelectorAll<HTMLElement>(LAYER));
  for (let i = ms.length - 1; i >= 0; i--) {
    const m = ms[i];
    if (m.getClientRects().length === 0 || m.closest("[aria-hidden='true'], [inert]")) continue;
    if (!m.matches(OVERLAY)) {
      const cs = getComputedStyle(m);
      if (cs.pointerEvents === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) continue;
      if (!m.querySelector(CANDIDATE)) {
        const p = m.parentElement;
        if (!p || p === document.body || p.closest("[data-knav-region]")) continue;
        return p;
      }
    }
    return m;
  }
  return null;
}

export function layerAbove(el: Element | null): boolean {
  if (!el) return false;
  const m = topModal();
  return !!m && !m.contains(el) && !el.contains(m);
}

/** the keys an element (or the marked surface around it) claims for itself */
function ownKeys(el: Element | null): string[] {
  const own = el?.closest?.("[data-knav-own]") as HTMLElement | null;
  return own ? (own.getAttribute("data-knav-own") || "arrows enter escape").split(/\s+/) : [];
}

/** a view in a mode that owns these keys itself (a slide deck, a study card) */
function ownedBy(key: "arrows" | "enter" | "escape"): boolean {
  for (const el of Array.from(document.querySelectorAll<HTMLElement>("[data-knav-own]"))) {
    if (el.getClientRects().length === 0) continue;
    if (editKind(el) && el !== document.activeElement) continue;
    const keys = (el.getAttribute("data-knav-own") || "arrows enter escape").split(/\s+/);
    if (keys.includes(key)) return true;
  }
  return false;
}

function reactProps(el: HTMLElement): Record<string, unknown> | null {
  const k = Object.keys(el).find((x) => x.startsWith("__reactProps$"));
  return k ? ((el as unknown as Record<string, Record<string, unknown>>)[k] || null) : null;
}

/** Enter on a control whose handler listens for the press rather than the click
 *  (comment cards, mention chips): give it the press a mouse would have. */
function pressFor(el: HTMLElement) {
  const p = reactProps(el);
  if (!p || p.onClick || !(p.onMouseDown || p.onPointerDown)) return;
  const r = el.getBoundingClientRect();
  const init = { bubbles: true, cancelable: true, button: 0, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
  if (p.onPointerDown) el.dispatchEvent(new PointerEvent("pointerdown", { ...init, pointerId: 1, isPrimary: true }));
  el.dispatchEvent(new MouseEvent("mousedown", init));
  el.dispatchEvent(new MouseEvent("mouseup", init));
}

function gather(scope: ParentNode): Cand[] {
  const clip = new Map<Element, Clip>();
  const vp = window.innerWidth * window.innerHeight;
  const out: Cand[] = [];
  for (const el of Array.from(scope.querySelectorAll<HTMLElement>(CANDIDATE))) {
    if (el.closest("[data-knav-skip], [inert], [aria-hidden='true']")) continue;
    if (el.getAttribute("aria-disabled") === "true") continue;
    if (el.tagName === "IFRAME" || el.matches(WIDGET)) continue;
    // a roving group's root (Radix tab strip, toolbar) only forwards focus to its items
    if (el.matches("[role=tablist], [role=toolbar], [role=radiogroup], [role=menubar]") && el.querySelector(CANDIDATE)) continue;
    // CodeMirror is one stop (its content), never its internal widgets
    if (!el.classList.contains("cm-content") && el.closest(".cm-editor")) continue;
    // a checkbox inside a clickable label: the label is the stop
    if (el.tagName === "INPUT" && /checkbox|radio/.test((el as HTMLInputElement).type)
      && el.closest("label.cursor-pointer")) continue;
    const box = visibleBox(el, clip);
    if (!box) continue;
    // a clickable backdrop or page-sized wrapper is not a place to stand
    const area = (box.right - box.left) * (box.bottom - box.top);
    if (area > vp * 0.5 && !el.matches("textarea, .cm-content, [data-knav-item]")
      && el.querySelector(CANDIDATE)) continue;
    out.push({ el, box });
  }
  return out;
}

function best(origin: Box, dir: Dir, pool: Cand[], anchorX: number | null): Cand | null {
  const tol = 2;
  let pick: Cand | null = null;
  let pickScore = Infinity;
  const vertical = dir === "up" || dir === "down";
  const scoreOf = (b: Box, strict: boolean): number | null => {
    let gap: number;
    if (dir === "down") gap = strict ? b.top - origin.bottom : (b.top + b.bottom) / 2 - (origin.top + origin.bottom) / 2;
    else if (dir === "up") gap = strict ? origin.top - b.bottom : (origin.top + origin.bottom) / 2 - (b.top + b.bottom) / 2;
    else if (dir === "right") gap = strict ? b.left - origin.right : (b.left + b.right) / 2 - (origin.left + origin.right) / 2;
    else gap = strict ? origin.left - b.right : (origin.left + origin.right) / 2 - (b.left + b.right) / 2;
    if (strict ? gap < -tol : gap <= tol) return null;
    gap = Math.max(0, gap);
    let cross: number;
    if (vertical) {
      cross = b.right < origin.left ? origin.left - b.right : b.left > origin.right ? b.left - origin.right : 0;
      if (cross === 0 && anchorX !== null) {
        // equals on overlap: the one under the column you were travelling in
        const inside = anchorX >= b.left && anchorX <= b.right;
        cross = inside ? 0 : Math.min(Math.abs(anchorX - b.left), Math.abs(anchorX - b.right)) * 0.05;
      }
    } else {
      const shared = Math.min(b.bottom, origin.bottom) - Math.max(b.top, origin.top);
      const half = Math.min(b.bottom - b.top, origin.bottom - origin.top) / 2;
      cross = Math.max(0, half - shared);
    }
    return gap + cross * 2;
  };
  for (const strict of [true, false]) {
    for (const c of pool) {
      const s = scoreOf(c.box, strict);
      if (s === null) continue;
      if (s < pickScore - 0.5 || (Math.abs(s - pickScore) <= 0.5 && pick && c.el.contains(pick.el))) {
        pick = c;
        pickScore = s;
      }
    }
    if (pick) return pick;
  }
  return null;
}

function firstIn(region: Element, pool: Cand[]): Cand | null {
  const rb = boxOf(region.getBoundingClientRect());
  const inReg = pool.filter((c) => region.contains(c.el));
  const shown = inReg.filter((c) => c.box.bottom > Math.max(rb.top, 0) && c.box.top < Math.min(rb.bottom, window.innerHeight));
  const seen = shown.length ? shown : inReg;
  const primary = seen.filter((c) => !c.el.hasAttribute("data-knav-last"));
  const list = primary.length ? primary : seen;
  list.sort((a, b) => (Math.round(a.box.top / 12) - Math.round(b.box.top / 12)) || (a.box.left - b.box.left));
  return list[0] || null;
}

function scroller(el: Element | null): HTMLElement | null {
  for (let p = el?.parentElement; p && p !== document.documentElement; p = p.parentElement) {
    const cs = getComputedStyle(p);
    if (/auto|scroll/.test(cs.overflowY) && p.scrollHeight > p.clientHeight + 2) return p;
  }
  return null;
}

/* -------------------------------------------------------------- the focus tree */

const mainEl = () => document.querySelector<HTMLElement>("[data-knav-region=main]");
const navEl = () => document.querySelector<HTMLElement>("[data-knav-region=nav]");
const regionOf = (el: Element | null) => el?.closest("[data-knav-region]") || null;
const currentNav = () => navEl()?.querySelector<HTMLElement>("[aria-current=page]") || null;
const viewKey = () => currentNav()?.getAttribute("data-knav-id") || window.location.pathname;
const widgetId = (w: Element) => w.getAttribute("data-knav-widget") || "";

/** the outermost widget holding `el` (widgets inside widgets are its content) */
function outerWidget(el: Element | null): HTMLElement | null {
  let w = el?.closest<HTMLElement>(WIDGET) || null;
  for (let up = w?.parentElement?.closest<HTMLElement>(WIDGET); up; up = up.parentElement?.closest<HTMLElement>(WIDGET)) w = up;
  return w;
}

/** the page's widgets, one stop each */
function tiles(scope: ParentNode | null = mainEl()): Cand[] {
  if (!scope) return [];
  const clip = new Map<Element, Clip>();
  const out: Cand[] = [];
  for (const el of Array.from(scope.querySelectorAll<HTMLElement>(WIDGET))) {
    if (el.parentElement?.closest(WIDGET) || el.closest("[data-knav-skip], [inert], [aria-hidden='true']")) continue;
    const box = visibleBox(el, clip);
    if (box) out.push({ el, box });
  }
  return out;
}

/** the page's top level: every widget, plus the controls that sit outside all widgets */
function pageStops(main: HTMLElement): Cand[] {
  const ts = tiles(main);
  const loose = gather(main).filter((c) => !c.el.closest(WIDGET));
  return ts.length ? [...ts, ...loose] : loose;
}

let focusedTile: HTMLElement | null = null;
let fullPage = false;      // the focused view has taken the whole window
let armNextFull = false;   // a widget's own full page is opening from ⏎: stand on its box

function levelOf(el: HTMLElement | null): Level {
  const modal = topModal();
  if (modal && (!el || modal.contains(el))) {
    // a widget that draws its own full page marks the overlay, so it reads as that level
    return modal.hasAttribute("data-knav-full-page")
      ? { kind: "full", tile: focusedTile || undefined } : { kind: "overlay" };
  }
  if (!el) return { kind: "page" };
  if (el.closest("[data-knav-region=nav]")) return { kind: "rail" };
  const w = outerWidget(el);
  const main = mainEl();
  if (w && (!main || main.contains(w))) {
    if (focusedTile === w) return { kind: fullPage ? "full" : "focused", tile: w };
    if (el === w) return { kind: "tile", tile: w };
    return { kind: "inside", tile: w };
  }
  return { kind: "page" };
}

function syncMainRect() {
  const m = mainEl();
  if (!m) return;
  // full page: the widget's box is the window, so it covers the rail and the key strip
  const r = fullPage
    ? { top: 0, left: 0, width: window.innerWidth, height: window.innerHeight }
    : m.getBoundingClientRect();
  const s = document.documentElement.style;
  s.setProperty("--knav-main-top", `${r.top}px`);
  s.setProperty("--knav-main-left", `${r.left}px`);
  s.setProperty("--knav-main-width", `${r.width}px`);
  s.setProperty("--knav-main-height", `${r.height}px`);
}

/** the key strip reads the level and the widget you stand on from <html> */
function stampLevel(el: HTMLElement | null) {
  const html = document.documentElement;
  const lvl = levelOf(el);
  html.setAttribute("data-knav-level", lvl.kind);
  const title = lvl.tile?.getAttribute("data-knav-title");
  if (title) html.setAttribute("data-knav-title", title);
  else html.removeAttribute("data-knav-title");
  // a field keeps o/e as letters to type, so don't offer them there
  if (el?.closest("[data-obsidian-file]") && !editKind(el)) html.setAttribute("data-knav-obsidian", "");
  else html.removeAttribute("data-knav-obsidian");
  // the ⏎ full-page hint belongs only where the next ⏎ would actually open one
  if (canFull(el)) html.setAttribute("data-knav-canfull", "");
  else html.removeAttribute("data-knav-canfull");
}

/** true when ⏎ on `el` would open the focused widget's full page: it is the widget's
 *  own item (or the widget itself), and that widget declared a full page. */
function canFull(el: HTMLElement | null): boolean {
  const tile = focusedTile;
  if (!tile || fullPage || !el || !tile.getAttribute("data-knav-full")) return false;
  if (el !== tile && !tile.contains(el)) return false;
  return el === tile || !!el.closest("[data-knav-primary]");
}

function openInObsidian(a: HTMLElement): boolean {
  const row = a.closest<HTMLElement>("[data-obsidian-file]");
  const file = row?.getAttribute("data-obsidian-file");
  if (!row || !file) return false;
  const q = new URLSearchParams({ file });
  const pair = row.getAttribute("data-obsidian-pair");
  if (pair) q.set("pair", pair);
  openObsidian(q).catch(() => { /* the key strip stays; the open just didn't happen */ });
  return true;
}

/** open (or, with null, close) a widget's full page: the focused view takes the window */
function setFullPage(on: boolean) {
  if (fullPage === on) return;
  fullPage = on;
  const html = document.documentElement;
  if (on) html.setAttribute("data-knav-full", "");
  else html.removeAttribute("data-knav-full");
  syncMainRect();
  stampLevel(active());
}

/** the bucket's own item to stand on inside `tile` */
function primaryIn(tile: HTMLElement): HTMLElement | null {
  const pool = gather(tile);
  const p = tile.querySelector<HTMLElement>("[data-knav-primary]");
  const hit = (p && pool.find((c) => c.el === p || p.contains(c.el))) || firstIn(tile, pool);
  return hit ? hit.el : null;
}

/** ⏎ again on a bucket's own item: its full page. A widget that draws its own gets the
 *  knav:full event instead (its overlay carries data-knav-full-page). */
function fullStep(el: HTMLElement | null): boolean {
  if (!canFull(el)) return false;
  const tile = focusedTile!;
  if (tile.getAttribute("data-knav-full") === "own") {
    // the widget's own page is an overlay: remember the box so closing it lands back here
    if (el !== tile) pressed = { el: el!, depth: depthOf(el!) };
    // it autofocuses its box for the mouse path; reached by ⏎ you STAND on it, so one
    // Escape steps back a level instead of spending the first press on "stop typing"
    armNextFull = true;
    window.setTimeout(() => { armNextFull = false; }, 1200);
    tile.dispatchEvent(new CustomEvent("knav:full", { detail: { full: true } }));
    return true;
  }
  setFullPage(true);
  // the full-page layout needs a frame to reflow before its controls have positions
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const hit = primaryIn(tile);
    if (hit) focusEl(hit);
  }));
  return true;
}

/** esc (or ←) out of a full page: back to the focused view, standing where you were */
function exitFull(): boolean {
  const tile = focusedTile;
  if (!fullPage || !tile) return false;
  setFullPage(false);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const hit = primaryIn(tile);
    if (hit) focusEl(hit);
    else focusEl(tile);
  }));
  return true;
}

/** the widget frame's close control, which does what Escape does where you stand */
export function exitWidgetFull(): boolean {
  return exitFull();
}

/** Put the keyboard cursor on `el` without starting to type in it: a widget whose own
 *  full page re-mounted its box uses this to hand the keys back to the focused view. */
export function standOn(el: HTMLElement | null): void {
  if (el && el.isConnected) focusEl(el);
}

/** open (or, with null, close) a widget's focused view: it fills the page */
function setWidgetFocus(tile: HTMLElement | null) {
  const html = document.documentElement;
  if (fullPage && focusedTile !== tile) setFullPage(false);
  if (focusedTile && focusedTile !== tile) {
    focusedTile.removeAttribute("data-knav-focused");
    focusedTile.dispatchEvent(new CustomEvent("knav:focus", { detail: { focused: false } }));
  }
  focusedTile = tile;
  if (tile) {
    syncMainRect();
    tile.setAttribute("data-knav-focused", "");
    html.setAttribute("data-knav-focusing", "");
    tile.dispatchEvent(new CustomEvent("knav:focus", { detail: { focused: true } }));
  } else {
    html.removeAttribute("data-knav-focusing");
  }
  stampLevel(active());
}

/** a view switch or unmount must never leave a widget stuck full-page */
export function clearWidgetFocus() {
  setWidgetFocus(null);
}

export function openWidgetFull(el: Element): boolean {
  const tile = outerWidget(el);
  if (!tile || !tile.getAttribute("data-knav-full")) return false;
  if (focusedTile !== tile) openWidgetFocus(el);
  // the focused layout needs a frame to reflow before its own box has a position
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (focusedTile === tile) fullStep(primaryIn(tile) ?? tile);
  }));
  return true;
}

export function openWidgetFocus(el: Element): boolean {
  const tile = outerWidget(el);
  if (!tile || focusedTile === tile) return false;
  // the list the control belongs to: its nearest ancestor that already holds stops
  const before = gather(tile).map((c) => c.el).filter((s) => s !== el && !el.contains(s));
  let list: Element | null = el.parentElement;
  while (list && list !== tile && !before.some((s) => list!.contains(s))) list = list.parentElement;
  const rows = list && list !== tile ? list : null;
  const shown = rows ? before.filter((s) => rows.contains(s)) : [];
  const last = shown[shown.length - 1];
  const keyOf = (s: Element) => s.getAttribute("data-knav-id") || s.getAttribute("aria-label")
    || `${s.tagName}:${(s.textContent || "").trim().slice(0, 80)}`;
  const after = (pool: Cand[], from: Element, skip: (c: Cand) => boolean) => pool.find((c) => c.el !== el
    && !from.contains(c.el) && !skip(c) && !!(from.compareDocumentPosition(c.el) & Node.DOCUMENT_POSITION_FOLLOWING)) || null;
  const pick = rows ? (pool: Cand[]) => {
    // the rows kept their nodes: the first stop after the last one shown
    if (last && last.isConnected && rows.contains(last)) return after(pool, last, (c) => !rows.contains(c.el));
    // the focused layout rebuilt them (a split list): find the last shown row again by its key
    const keys = shown.map(keyOf);
    const seen = new Set(keys);
    for (let i = shown.length - 1; i >= 0; i--) {
      if (keys.indexOf(keys[i]) !== i || keys.lastIndexOf(keys[i]) !== i) continue;
      const again = pool.filter((c) => keyOf(c.el) === keys[i]);
      if (again.length === 1) return after(pool, again[0].el, (c) => seen.has(keyOf(c.el)));
    }
    return null;
  } : undefined;
  enterTile(tile, true, pick);
  return true;
}

/* --------------------------------------------------------------------- state */

const lastIn = new Map<Element, HTMLElement>();   // region → last focused stop
const lastTile = new Map<string, string>();       // view → last widget focused on its page
const lastInner = new Map<string, HTMLElement>(); // widget → last control focused inside it
let lastEl: HTMLElement | null = null;
let lastBox: Box | null = null;
let lastRegion: Element | null = null;
let lastWidget: { view: string; id: string; tile: boolean } | null = null;
let lastOutside: HTMLElement | null = null;   // last stop outside any overlay: where to land when one closes
let lastDepth = 0;                               // how many overlay layers the last focus sat inside
let pressed: { el: HTMLElement; depth: number } | null = null;   // the control Enter last pressed (an opener)
let anchorX: number | null = null;
let opened: { region: Element | null; id: string | null; text: string; tag: string } | null = null;

let heldKey = false;

const depthOf = (el: Element) => {
  let n = 0;
  for (let p: Element | null = el.closest(LAYER); p; p = p.parentElement ? p.parentElement.closest(LAYER) : null) n++;
  return n;
};

function editKind(el: HTMLElement | null): "text" | "multi" | "value" | "select" | null {
  if (!el) return null;
  if (el.tagName === "INPUT") {
    const t = ((el as HTMLInputElement).getAttribute("type") || "").toLowerCase();
    if (TEXT_TYPES.has(t)) return "text";
    if (VALUE_TYPES.has(t)) return "value";
    return null;
  }
  if (el.tagName === "TEXTAREA") return "multi";
  if (el.tagName === "SELECT") return "select";
  if (el.isContentEditable || el.closest(".cm-editor")) return "multi";
  return null;
}

/** combobox-like inputs (the palette, pickers) own their up/down */
const ownsVertical = (el: HTMLElement) =>
  el.matches("[role=combobox], [aria-autocomplete], [list], [data-knav-keys]");

function active(): HTMLElement | null {
  const a = document.activeElement as HTMLElement | null;
  return a && a !== document.body && a !== document.documentElement ? a : null;
}

function focusEl(el: HTMLElement) {
  const native = el.matches("button, a[href], input, select, textarea, summary, [tabindex]") || el.isContentEditable;
  if (!native) el.setAttribute("tabindex", "-1");
  el.focus({ preventScroll: true });
  const kind = editKind(el);
  if (kind && kind !== "select" && !ownKeys(el).includes("enter") && !el.hasAttribute("data-knav-armed")) {
    el.setAttribute("data-knav-armed", "");
    // arriving on a field puts the caret after what is already there, ready to add to it
    if (kind === "text" || el.tagName === "TEXTAREA") {
      const f = el as HTMLInputElement | HTMLTextAreaElement;
      try { f.setSelectionRange(f.value.length, f.value.length); } catch { /* types without a caret */ }
    }
  }
  easeIntoView(el, { held: heldKey });
  document.documentElement.setAttribute("data-knav", "");
}

function toRail(): boolean {
  const cur = currentNav() || navEl()?.querySelector<HTMLElement>("[data-knav-enter]");
  if (!cur) return false;
  focusEl(cur);
  return true;
}

/** step into a widget: in place, or as its focused view; `pick` names where to land */
function enterTile(tile: HTMLElement, focus: boolean, pick?: (pool: Cand[]) => Cand | null) {
  if (focus) setWidgetFocus(tile);
  const land = () => {
    const pool = gather(tile);
    const mem = lastInner.get(widgetId(tile));
    // a note bucket puts you IN the note: its own box, not the day picker above it and
    // not wherever you last stood, so ⏎ ⏎ is always tile -> box -> full page
    const own = tile.getAttribute("data-knav-full")
      ? pool.find((c) => c.el.closest("[data-knav-primary]")) : null;
    const hit = pick?.(pool) || own || (mem && mem.isConnected && pool.find((c) => c.el === mem)) || firstIn(tile, pool);
    if (hit) focusEl(hit.el);
    else focusEl(tile);
  };
  // the focused layout needs a frame to reflow before its controls have positions
  if (focus) requestAnimationFrame(() => requestAnimationFrame(land));
  else land();
}

/** the stop to leave, re-reading geometry if React replaced the focused node */
function resume(pool: Cand[]): Cand | null {
  if (!lastBox || (lastEl && lastEl.isConnected)) return null;
  const cx = (lastBox.left + lastBox.right) / 2, cy = (lastBox.top + lastBox.bottom) / 2;
  const hits = pool.filter((c) => cx >= c.box.left && cx <= c.box.right && cy >= c.box.top && cy <= c.box.bottom);
  hits.sort((a, b) => (a.el.contains(b.el) ? 1 : b.el.contains(a.el) ? -1 : 0));
  return hits[hits.length - 1] || null;
}

function restoreFocus() {
  if (active() || !document.documentElement.hasAttribute("data-knav")) return;
  if (focusedTile && !focusedTile.isConnected) setWidgetFocus(null);
  const modal = topModal();
  // an overlay opened from a control closed: back to that control, at any depth
  // (the Drafting editor is itself a full-screen layer, so "outside every overlay" is too far)
  if (pressed && pressed.el.isConnected && pressed.el !== lastEl && lastDepth > pressed.depth) {
    const pool = gather(modal || document);
    if (pool.some((c) => c.el === pressed!.el)) { focusEl(pressed.el); return; }
  }
  if (!modal && lastOutside && lastOutside.isConnected && lastOutside !== lastEl) {
    const pool = gather(document);
    if (pool.some((c) => c.el === lastOutside)) { focusEl(lastOutside); return; }
  }
  // a widget re-rendered under the cursor: the same widget, by id
  if (!modal && lastWidget && lastWidget.view === viewKey()) {
    const w = mainEl()?.querySelector<HTMLElement>(`[data-knav-widget="${CSS.escape(lastWidget.id)}"]`);
    if (w) {
      if (lastWidget.tile) { focusEl(w); return; }
      const hit = resume(gather(w)) || firstIn(w, gather(w));
      if (hit) { focusEl(hit.el); return; }
    }
  }
  const pool = gather(modal || document);
  const hit = resume(pool) || (modal ? firstIn(modal, pool) : null);
  if (hit) focusEl(hit.el);
}

/* ---------------------------------------------------------------------- move */

/** The geometric step inside one pool: rows and their controls, paging long text.
 *  `regionScoped` keeps ↑/↓ inside the origin's region (rail or page). */
function navigate(dir: Dir, pool: Cand[], a: HTMLElement | null, regionScoped: boolean, modal: HTMLElement | null):
  { target: Cand | null; paged: boolean } {
  const set = new Set(pool.map((c) => c.el));
  const here = a && (set.has(a) ? a : (a.closest(CANDIDATE) as HTMLElement | null));
  const originEl = here && set.has(here) ? here : null;
  let origin: Box | null = originEl ? pool.find((c) => c.el === originEl)!.box : (a ? visibleBox(a, new Map()) || boxOf(a.getBoundingClientRect()) : lastBox);
  if (!origin) return { target: null, paged: false };
  const parent = originEl ? (() => {
    for (let p = originEl.parentElement; p; p = p.parentElement) if (set.has(p)) return p;
    return null;
  })() : null;

  // a stop scrolled out of sight is a bad origin: page from the visible edge
  const sc = scroller(originEl || a);
  const vertical = dir === "up" || dir === "down";
  
  const scBox = sc && vertical ? boxOf(sc.getBoundingClientRect()) : null;
  if (sc && scBox) {
    const sb = scBox;
    if (origin.bottom < sb.top || origin.top > sb.bottom) {
      const edge = dir === "down" ? sb.top : sb.bottom;
      origin = { ...origin, top: edge, bottom: edge };
    }
  }

  const home = originEl ? regionOf(originEl) : lastRegion;
  const space = regionScoped && vertical && home && !modal ? pool.filter((c) => home.contains(c.el)) : pool;

  const holder = (el: HTMLElement) => {
    for (let p = el.parentElement; p; p = p.parentElement) if (set.has(p)) return p;
    return null;
  };
  const reachable = (c: Cand) => { const h = holder(c.el); return !h || h.contains(originEl || a); };

  let target: Cand | null = null;
  if (originEl) {
    const inside = space.filter((c) => c.el !== originEl && holder(c.el) === originEl);
    if (dir === "right" && inside.length) {
      // step into a row: its controls, left to right
      target = best({ ...origin, right: origin.left }, "right", inside, null);
    }
    if (!target && parent) {
      const siblings = space.filter((c) => c.el !== originEl && holder(c.el) === parent);
      target = best(origin, dir, siblings, anchorX);
      if (!target && (dir === "left" || dir === "up")) target = pool.find((c) => c.el === parent) || null;
      if (!target) {
        const pb = pool.find((c) => c.el === parent)!.box;
        target = best(pb, dir, space.filter((c) => !parent.contains(c.el) && reachable(c)), anchorX);
      }
    }
    if (!target && !parent) {
      target = best(origin, dir, space.filter((c) => c.el !== originEl && !originEl.contains(c.el) && reachable(c)), anchorX);
    }
  } else {
    target = best(origin, dir, space, anchorX);
  }

  if (sc && scBox) {
    const sb = scBox;
    const h = sb.bottom - sb.top;
    const far = !target
      || (dir === "down" && target.box.top > sb.bottom + h * 0.6)
      || (dir === "up" && target.box.bottom < sb.top - h * 0.6);
    if (far && (!target || sc.contains(target.el))
      && readerScroll(sc, dir === "down" ? 1 : -1, false, heldKey)) {
      document.documentElement.setAttribute("data-knav", "");
      return { target: null, paged: true };
    }
  }
  return { target, paged: false };
}

function land(target: Cand, dir: Dir) {
  if (dir === "left" || dir === "right" || anchorX === null) anchorX = (target.box.left + target.box.right) / 2;
  focusEl(target.el);
}

/** inside a widget: move among its controls; at an edge, rise */
function moveInWidget(dir: Dir, kind: "inside" | "focused" | "full", tile: HTMLElement, a: HTMLElement): boolean {
  const pool = gather(tile);
  if (a === tile) {
    // standing on the focused widget itself: land inside it
    enterTile(tile, false);
    return true;
  }
  const r = navigate(dir, pool, a, false, null);
  if (r.paged) return true;
  if (r.target) { land(r.target, dir); return true; }
  if (kind === "full") {
    // ← always makes progress: out of the full page, back to the focused view
    if (dir !== "left") return false;
    return exitFull();
  }
  if (kind === "focused") {
    if (dir !== "left") return false;
    setWidgetFocus(null);
    focusEl(tile);
    return true;
  }
  const main = mainEl();
  const alone = main ? pageStops(main).length === 1 : false;
  if (alone) return dir === "left" ? toRail() : false;
  focusEl(tile);
  return true;
}

function move(dir: Dir): boolean {
  if (focusedTile && !focusedTile.isConnected) setWidgetFocus(null);
  const modal = topModal();
  const a = active();
  const lvl = levelOf(a);
  // a widget's own full page is an overlay, so it takes the overlay's pool below; only the
  // page the engine draws is widget-scoped. inside/focused keep their long-standing rule.
  if (a && lvl.tile && (lvl.kind === "inside" || lvl.kind === "focused" || (lvl.kind === "full" && !modal))) {
    return moveInWidget(dir, lvl.kind, lvl.tile, a);
  }

  const main = mainEl();
  const nav = navEl();
  // the pool at this level: the rail and the page's top level, or the overlay's controls
  const pool: Cand[] = modal ? gather(modal)
    : main || nav ? [...(nav ? gather(nav) : []), ...(main ? pageStops(main) : [])]
    : gather(document);
  if (pool.length === 0) return false;
  const set = new Set(pool.map((c) => c.el));
  const here = a && (set.has(a) ? a : (a.closest(CANDIDATE) as HTMLElement | null));

  if (!here || !set.has(here)) {
    const back = resume(pool);
    if (back) { focusEl(back.el); return true; }
    if (!lastBox || modal) {
      const scope = (modal ? null : main) || modal || document.body;
      const start = dir === "left" && nav && !modal ? currentNav() : null;
      const f = start && set.has(start) ? { el: start } : firstIn(scope, pool);
      if (f) { focusEl(f.el); return true; }
      return false;
    }
  }

  const r = navigate(dir, pool, here && set.has(here) ? here : a, true, modal);
  if (r.paged) return true;
  let target = r.target;
  if (!target) return false;

  // crossing between the rail and the page returns to where you were there
  const from = here && set.has(here) ? regionOf(here) : lastRegion, to = regionOf(target.el);
  if (to && from !== to && !modal) {
    const mem = lastIn.get(to);
    const memStop = mem && mem.isConnected ? (set.has(mem) ? mem : (outerWidget(mem) && set.has(outerWidget(mem)!) ? outerWidget(mem) : null)) : null;
    if (memStop) target = pool.find((c) => c.el === memStop)!;
    else if (to.getAttribute("data-knav-region") === "nav") {
      const cur = currentNav();
      if (cur && set.has(cur)) target = pool.find((c) => c.el === cur)!;
    } else {
      target = firstIn(to, pool) || target;
    }
  }
  land(target, dir);
  return true;
}

/** after a view switch, wait for the page to paint and land on its top level */
function enterMain() {
  const t0 = performance.now();
  let seen = -1;
  const tick = () => {
    const main = mainEl();
    if (!main) return;
    const pool = pageStops(main);
    const sig = pool.length;
    const dt = performance.now() - t0;
    if ((sig > 0 && sig === seen && dt > 160) || dt > 1500) {
      const a = active();
      if (a && main.contains(a)) {
        // a view that autofocuses its search: stand on it, don't type into it
        const k = editKind(a);
        if (k && k !== "select") a.setAttribute("data-knav-armed", "");
        return;
      }
      if (pool.length === 1 && pool[0].el.matches(WIDGET)) { enterTile(pool[0].el, false); return; }
      const id = lastTile.get(viewKey());
      const remembered = id ? pool.find((c) => c.el.matches(WIDGET) && widgetId(c.el) === id) : null;
      const f = remembered || firstIn(main, pool);
      if (f) focusEl(f.el);
      return;
    }
    seen = sig;
    window.setTimeout(tick, 60);
  };
  window.setTimeout(tick, 60);
}

function restoreOpened() {
  const o = opened;
  opened = null;
  if (!o) return;
  const t0 = performance.now();
  const tick = () => {
    const scope = o.region || document.body;
    const pool = gather(scope);
    const hit = pool.find((c) => o.id && c.el.getAttribute("data-knav-id") === o.id)
      || pool.find((c) => c.el.tagName === o.tag && (c.el.textContent || "").trim().slice(0, 80) === o.text);
    if (hit) { focusEl(hit.el); return; }
    if (performance.now() - t0 > 900) {
      if (!active()) { const f = firstIn(scope, pool); if (f) focusEl(f.el); }
      return;
    }
    window.setTimeout(tick, 60);
  };
  window.setTimeout(tick, 60);
}

/* -------------------------------------------------------------------- escape */

/** an unmarked overlay's own close control */
function closeIn(scope: Element): HTMLElement | null {
  const shown = (b: HTMLElement) => b.getClientRects().length > 0 && !(b as HTMLButtonElement).disabled;
  const byLabel = Array.from(scope.querySelectorAll<HTMLElement>(
    "button[aria-label*='close' i], button[title*='close' i], button[aria-label*='dismiss' i], button[title*='dismiss' i]")).find(shown);
  if (byLabel) return byLabel;
  return Array.from(scope.querySelectorAll<HTMLElement>("button")).find((b) => shown(b)
    && (/^(×|✕|close|done|cancel)$/i.test((b.textContent || "").trim()) || !!b.querySelector("svg.lucide-x"))) || null;
}

/** the visible [data-knav-back] with the highest priority (ties: the later one) */
function backIn(scope: Element): HTMLElement | null {
  const backs = Array.from(scope.querySelectorAll<HTMLElement>("[data-knav-back]"))
    .filter((b) => b.getClientRects().length > 0 && !b.closest("[aria-hidden='true'], [inert]")
      && !(b as HTMLButtonElement).disabled);
  if (!backs.length) return null;
  const pri = (b: HTMLElement) => Number(b.getAttribute("data-knav-back")) || 1;
  return backs.reduce((top, b) => (pri(b) >= pri(top) ? b : top));
}

function escape(): boolean {
  if (focusedTile && !focusedTile.isConnected) setWidgetFocus(null);
  const a = active();
  if (!a) {
    // nothing focused (after a mouse click, say): Escape still means back
    if (fullPage && !topModal()) return exitFull();
    if (focusedTile && !topModal()) {
      const t = focusedTile;
      setWidgetFocus(null);
      focusEl(t);
      return true;
    }
    const scope = topModal() || mainEl();
    const b = scope ? backIn(scope) : null;
    if (b) { b.click(); restoreOpened(); return true; }
    return false;
  }
  const kind = editKind(a);
  if (kind && kind !== "select" && !a.hasAttribute("data-knav-armed")) {
    // stop editing, stay on the field
    a.setAttribute("data-knav-armed", "");
    document.documentElement.setAttribute("data-knav", "");
    return true;
  }
  const modal = topModal();
  const lvl = levelOf(a);
  if (lvl.kind === "tile") return toRail();
  // out of the full page the engine drew; a widget's own full page is an overlay, so it
  // closes through its own data-knav-back below and the widget restores the focus
  if (lvl.kind === "full" && !modal) return exitFull();

  const tile = lvl.kind === "inside" || lvl.kind === "focused" ? lvl.tile! : null;
  const pool = gather(modal || tile || document);
  const set = new Set(pool.map((c) => c.el));
  const stopAt = modal ? null : tile;
  for (let p = a.parentElement; p && p !== stopAt; p = p.parentElement) {
    if (modal && !modal.contains(p)) break;
    if (set.has(p)) { focusEl(p); return true; }
  }
  if (tile) {
    const b = backIn(tile);
    if (b) { b.click(); restoreOpened(); return true; }
    if (lvl.kind === "focused") { setWidgetFocus(null); focusEl(tile); return true; }
    const main = mainEl();
    if (main && pageStops(main).length === 1) return toRail();
    focusEl(tile);
    return true;
  }
  const region = modal || regionOf(a);
  const back = backIn(region || document.body) || (modal ? closeIn(modal) : null);
  if (back) {
    back.click();
    restoreOpened();
    return true;
  }
  if (region && region.getAttribute("data-knav-region") === "main") return toRail();
  return false;
}

/* ----------------------------------------------------------------- listeners */

function onCapture(e: KeyboardEvent) {
  const a = active();
  if (!a || e.ctrlKey || e.metaKey || e.altKey) return;
  const dir = ARROWS[e.key];
  if (dir && ownedBy("arrows")) return;
  if (a.hasAttribute("data-knav-armed")) {
    if (dir && !e.shiftKey) {
      e.preventDefault(); e.stopPropagation();
      move(dir);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      // the bucket's own box: ⏎ takes it full page, where the writing carries on
      if (!ownedBy("enter") && fullStep(a)) { e.preventDefault(); e.stopPropagation(); return; }
      a.removeAttribute("data-knav-armed");
      e.preventDefault(); e.stopPropagation();
      return;
    }
    if (e.key === "Escape" || e.key === "Tab" || e.key === "Shift" || /^F\d+$/.test(e.key)) return;
    a.removeAttribute("data-knav-armed");   // typing starts editing with that key
    return;
  }
  // closed selects would otherwise spend arrows changing their value
  if (dir && !e.shiftKey && (a.tagName === "SELECT"
    || (a.matches("button[role=combobox]") && a.getAttribute("aria-expanded") !== "true" && (dir === "up" || dir === "down")))) {
    e.preventDefault(); e.stopPropagation();
    move(dir);
  }
}

function onKey(e: KeyboardEvent) {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (document.documentElement.hasAttribute("data-board-prefix")) return;   // g/w owns the next key
  if (focusedTile && !focusedTile.isConnected) setWidgetFocus(null);
  const a = active();

  // the menu key (or Shift+F10) opens a right-click menu where the focus is
  if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
    if (!a || e.defaultPrevented) return;
    let r: DOMRect | Box = a.getBoundingClientRect();
    const sel = window.getSelection();
    if (editKind(a) === "multi" && sel && sel.rangeCount) {
      const rr = sel.getRangeAt(0).getBoundingClientRect();
      if (rr.width || rr.height) r = rr;
    }
    a.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true, cancelable: true, button: 2, clientX: r.left + 4, clientY: r.bottom - 2,
    }));
    e.preventDefault();
    return;
  }

  if (e.key === "Escape") {
    if (e.defaultPrevented || ownedBy("escape")) return;
    if (escape()) { e.preventDefault(); return; }
    return;
  }

  if ((e.key === "o" || e.key === "e") && !e.shiftKey && !e.defaultPrevented && a && !editKind(a)
    && openInObsidian(a)) {
    e.preventDefault();
    return;
  }

  // ⏎ again on a focused bucket's own item: its full page (before the widget branch, so
  // ⏎ on the focused widget itself deepens rather than re-entering it)
  if (e.key === "Enter" && a && !e.shiftKey && !e.defaultPrevented && !ownedBy("enter") && fullStep(a)) {
    e.preventDefault();
    return;
  }

  // a widget: ⏎ opens its focused view, space steps into it where it stands
  if ((e.key === "Enter" || e.key === " ") && a && a.matches(WIDGET) && !e.shiftKey && !e.defaultPrevented && !ownedBy("enter")) {
    e.preventDefault();
    enterTile(a, e.key === "Enter");
    return;
  }

  if (e.key === "Enter") {
    if (e.shiftKey || ownedBy("enter")) return;
    if (e.defaultPrevented) {
      // Radix checkboxes swallow Enter by spec; on this board Enter toggles
      if (a && a.matches("[role=checkbox], [role=switch]")) a.click();
      return;
    }
    if (!a) {
      if (lastEl && lastEl.isConnected) { focusEl(lastEl); e.preventDefault(); }
      return;
    }
    const kind = editKind(a);
    if (kind === "select") {
      try { (a as HTMLSelectElement & { showPicker?: () => void }).showPicker?.(); } catch { /* needs a user gesture */ }
      e.preventDefault();
      return;
    }
    if (kind) return;   // an editing field keeps Enter (submit, newline)
    const native = a.matches("button, a[href], summary, input[type=submit], input[type=button], input[type=reset]");
    opened = { region: regionOf(a), id: a.getAttribute("data-knav-id"), text: (a.textContent || "").trim().slice(0, 80), tag: a.tagName };
    pressed = { el: a, depth: depthOf(a) };
    pressFor(a);
    if (!native) { e.preventDefault(); a.click(); }
    if (a.hasAttribute("data-knav-enter")) enterMain();
    return;
  }

  if (e.key === " " && a && !e.defaultPrevented && !ownedBy("enter") && !editKind(a)
    && !a.isContentEditable && !a.matches(WIDGET)
    && !a.matches("button, a[href], summary, input, select, [role=button], [role=checkbox], [role=switch], [role=tab], [role=menuitem], [role=menuitemcheckbox], [role=menuitemradio], [role=option], [role=radio]")) {
    const sc = scroller(a);
    if (sc && readerScroll(sc, e.shiftKey ? -1 : 1, true, false)) {
      document.documentElement.setAttribute("data-knav", "");
      e.preventDefault();
      return;
    }
  }

  const dir = ARROWS[e.key];
  if (!dir || e.defaultPrevented || e.shiftKey || ownedBy("arrows")) return;
  heldKey = e.repeat;   // a held arrow ramps one continuous scroll instead of jumping
  const kind = editKind(a);
  if (a && kind) {
    if (kind === "multi" || kind === "value") return;
    if (kind === "text") {
      const inp = a as HTMLInputElement;
      if (dir === "up" || dir === "down") { if (ownsVertical(inp)) return; }
      else {
        if (e.repeat) return;
        const at = inp.selectionStart, end = inp.selectionEnd, len = inp.value.length;
        if (at === null || at !== end) return;
        if (dir === "left" ? at !== 0 : at !== len) return;
      }
    }
  }
  if (a && a.hasAttribute("data-knav-enter") && dir === "right" && !topModal()) {
    const current = a.getAttribute("aria-current") === "page";
    if (!current) a.click();
    e.preventDefault();
    const main = mainEl();
    const mem = main ? lastIn.get(main) : null;
    if (current && mem && mem.isConnected) focusEl(mem);
    else enterMain();
    return;
  }
  if (move(dir)) e.preventDefault();
}

function onFocusIn(e: FocusEvent) {
  const el = e.target as HTMLElement;
  if (!el || el === document.body) return;
  // the full page just opened from ⏎ and autofocused its box: stand on it, don't type
  if (armNextFull && el.closest("[data-knav-full-page]")) {
    armNextFull = false;
    const k = editKind(el);
    if (k && k !== "select" && !el.hasAttribute("data-knav-armed")) {
      el.setAttribute("data-knav-armed", "");
      document.documentElement.setAttribute("data-knav", "");
    }
  }
  lastEl = el;
  lastBox = boxOf(el.getBoundingClientRect());
  lastDepth = depthOf(el);
  if (lastDepth === 0) lastOutside = el;
  const r = regionOf(el);
  lastRegion = r;
  if (r) lastIn.set(r, el);
  const w = outerWidget(el);
  if (w) {
    const id = widgetId(w);
    lastWidget = { view: viewKey(), id, tile: el === w };
    if (el === w) lastTile.set(viewKey(), id);
    else lastInner.set(id, el);
  }
  stampLevel(el);
}

function onFocusOut(e: FocusEvent) {
  (e.target as HTMLElement | null)?.removeAttribute?.("data-knav-armed");
}

function onKeyUp() {
  // the key came up: the ramp ends and whatever is in flight eases to its mark
  heldKey = false;
  endRamp();
  if (document.documentElement.hasAttribute("data-knav")) window.setTimeout(restoreFocus, 120);
}

function onPointer(e: PointerEvent) {
  if (!e.isTrusted) return;   // our own synthesized press
  document.documentElement.removeAttribute("data-knav");
  anchorX = null;
  const t = e.target as HTMLElement | null;
  t?.closest?.("[data-knav-armed]")?.removeAttribute("data-knav-armed");
}

function onResize() {
  if (focusedTile || fullPage) syncMainRect();
}

/** Install once per window; returns the uninstaller. */
export function installArrowNav(): () => void {
  (window as unknown as { __knav?: object }).__knav = {
    marker: KNAV_MARKER,
    stops: () => {
      const modal = topModal();
      if (modal) return gather(modal).map((c) => c.el);
      const main = mainEl();
      const inner = main ? tiles(main).flatMap((t) => gather(t.el).map((c) => c.el)) : [];
      return [...gather(document).map((c) => c.el), ...(main ? tiles(main).map((t) => t.el) : []), ...inner]
        .filter((el, i, all) => all.indexOf(el) === i);
    },
    level: () => levelOf(active()).kind,
    full: () => fullPage,
    canFull: () => canFull(active()),
    reduced: () => reducedMotion(),
    scroll: { fast: FAST_MS, slow: SLOW_MS, elastic: ELASTIC, maxFrame: MAX_FRAME, readerStep: READER_STEP },
  };
  const add = window.addEventListener;
  window.addEventListener = function (type: string, listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions) {
    add.call(window, type, listener as EventListenerOrEventListenerObject, options);
    const capture = typeof options === "boolean" ? options : !!options?.capture;
    if (type === "keydown" && listener !== (onKey as EventListener) && !capture) {
      window.removeEventListener("keydown", onKey);
      add.call(window, "keydown", onKey as EventListener);
    }
  } as typeof window.addEventListener;
  add.call(window, "keydown", onCapture as EventListener, true);
  add.call(window, "keydown", onKey as EventListener);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("resize", onResize);
  document.addEventListener("focusin", onFocusIn);
  document.addEventListener("focusout", onFocusOut);
  document.addEventListener("pointerdown", onPointer, true);
  const main = mainEl();
  const ro = main && "ResizeObserver" in window ? new ResizeObserver(onResize) : null;
  if (main && ro) ro.observe(main);
  return () => {
    window.addEventListener = add;
    ro?.disconnect();
    window.removeEventListener("keydown", onCapture, true);
    window.removeEventListener("keydown", onKey);
    window.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("resize", onResize);
    document.removeEventListener("focusin", onFocusIn);
    document.removeEventListener("focusout", onFocusOut);
    document.removeEventListener("pointerdown", onPointer, true);
  };
}
