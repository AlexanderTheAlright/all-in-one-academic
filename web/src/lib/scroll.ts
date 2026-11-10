

export const FAST_MS = 180;        // a nudge (a stop just off the edge)
export const SLOW_MS = 260;        // a long throw (a viewport or more)
export const ELASTIC = 4;          // px of overshoot on the settle
export const MAX_FRAME = 90;       // no single frame may move more than this
export const READER_STEP = 1 / 3;  // Down/Up inside a long text region
export const PAGE_STEP = 0.9;      // Space / Shift+Space inside a long text region
const RAMP_MS = 400;               // how long a held key takes to reach full speed
const SETTLE_AT = 0.72;            // where in the ease the elastic settle starts

type Anim = {
  raf: number;
  from: number;
  to: number;
  v0: number;      // px per ms at the moment this leg started
  t0: number;
  dur: number;
  elastic: boolean;
  pos: number;     // the last position we wrote (fractional)
  wrote: number;   // the integer we actually assigned, to notice an outside scroll
};

const running = new WeakMap<Element, Anim>();
let live = 0;   // how many containers are animating right now

/** True while anything is mid-scroll. The engine's geometry only needs adjusting then,
 *  so the common case (nothing animating) costs one comparison. */
export function animating(): boolean { return live > 0; }

function anim(el: Element): Anim | null {
  const a = running.get(el);
  if (!a) return null;
  if (Math.abs(el.scrollTop - a.wrote) > 1) { cancelAnimationFrame(a.raf); running.delete(el); live--; return null; }
  return a;
}

/** How far `el`'s content still has to travel: positive means it will move UP. */
export function pendingOf(el: Element): number {
  const a = anim(el);
  return a ? a.to - el.scrollTop : 0;
}

export function reducedMotion(): boolean {
  try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; }
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const maxTop = (el: Element) => Math.max(0, el.scrollHeight - el.clientHeight);
const maxLeft = (el: Element) => Math.max(0, el.scrollWidth - el.clientWidth);

/** Where `el` is HEADED — its own position when nothing is animating on it. */
export function targetTop(el: Element): number {
  const a = anim(el);
  return a ? a.to : el.scrollTop;
}

/** Stop the animation on `el` where it stands. */
export function cancelScroll(el: Element | null | undefined): void {
  if (!el) return;
  const a = running.get(el);
  if (a) { cancelAnimationFrame(a.raf); running.delete(el); live--; }
}

/** Short moves stay snappy; a throw of a viewport or more gets the full duration. */
function durationFor(dist: number, viewport: number): number {
  return Math.round(FAST_MS + (SLOW_MS - FAST_MS) * clamp(dist / Math.max(1, viewport), 0, 1));
}

const H = (p: number, from: number, to: number, v0: number, dur: number) => {
  const p2 = p * p, p3 = p2 * p;
  return (2 * p3 - 3 * p2 + 1) * from + (p3 - 2 * p2 + p) * (v0 * dur) + (-2 * p3 + 3 * p2) * to;
};
/** px per ms of the leg `a` at progress `p`. */
const Hv = (a: Anim, p: number) =>
  ((6 * p * p - 6 * p) * (a.from - a.to) + (3 * p * p - 4 * p + 1) * (a.v0 * a.dur)) / a.dur;

/** Ease `el` to `top`. The one primitive; everything else here calls it. */
export function easeScrollTo(el: HTMLElement, top: number, opts: { held?: boolean; elastic?: boolean } = {}): void {
  const to = clamp(Math.round(top), 0, maxTop(el));
  if (reducedMotion()) { cancelScroll(el); el.scrollTop = to; return; }
  const prev = anim(el);
  const from = el.scrollTop;
  if (!prev && Math.abs(to - from) < 1) return;
  let v0 = 0;
  if (prev) {
    v0 = clamp(Hv(prev, clamp((performance.now() - prev.t0) / prev.dur, 0, 1)), -MAX_FRAME / 8, MAX_FRAME / 8);
    cancelAnimationFrame(prev.raf);
    running.delete(el);
    live--;
  }
  if (Math.abs(to - from) < 1 && Math.abs(v0) < 0.01) { el.scrollTop = to; return; }
  const held = !!opts.held;
  const a: Anim = {
    raf: 0, from, to, v0, t0: performance.now(),
    dur: durationFor(Math.abs(to - from), el.clientHeight || window.innerHeight),
    elastic: !held && opts.elastic !== false && Math.abs(to - from) > 24,
    pos: from, wrote: Math.round(from),
  };
  const frame = (now: number) => {
    
    if (Math.abs(el.scrollTop - a.wrote) > 1) { running.delete(el); live--; return; }
    const p = clamp((now - a.t0) / a.dur, 0, 1);
    let want = p >= 1 ? a.to : H(p, a.from, a.to, a.v0, a.dur);
    if (a.elastic && p > SETTLE_AT && p < 1) {
      // a few px past the mark and back: a settle, not a bounce
      want += Math.sin(((p - SETTLE_AT) / (1 - SETTLE_AT)) * Math.PI) * ELASTIC * Math.sign(a.to - a.from);
    }
    a.pos += clamp(want - a.pos, -MAX_FRAME, MAX_FRAME);   // no frame ever teleports
    a.wrote = clamp(Math.round(a.pos), 0, maxTop(el));
    el.scrollTop = a.wrote;
    if (p >= 1 && Math.abs(a.pos - a.to) < 1) { a.wrote = clamp(a.to, 0, maxTop(el)); el.scrollTop = a.wrote; running.delete(el); live--; return; }
    
    if (p >= 1 && now - a.t0 > a.dur + 2000) { running.delete(el); live--; return; }
    a.raf = requestAnimationFrame(frame);
  };
  a.raf = requestAnimationFrame(frame);
  running.set(el, a);
  live++;
}

/** Ease by a delta from where the container is HEADED, so repeats accumulate. */
export function easeScrollBy(el: HTMLElement, dy: number, opts: { held?: boolean } = {}): void {
  easeScrollTo(el, targetTop(el) + dy, opts);
}

/* ------------------------------------------------------------ held keys */

let ramp: { el: HTMLElement; dir: 1 | -1; t0: number } | null = null;

export function rampActive(el?: Element | null): boolean {
  return !!ramp && (!el || ramp.el === el);
}

/** One repeat of a held key: `base` px scaled by how long the key has been down. */
export function rampStep(el: HTMLElement, dir: 1 | -1, base: number): void {
  const now = performance.now();
  if (!ramp || ramp.el !== el || ramp.dir !== dir) ramp = { el, dir, t0: now };
  const gain = 0.6 + 0.65 * clamp((now - ramp.t0) / RAMP_MS, 0, 1);
  easeScrollBy(el, dir * Math.round(base * gain), { held: true });
}

/** Key up: stop ramping. Whatever is in flight finishes on its own. */
export function endRamp(): void { ramp = null; }

/* ------------------------------------------------------------ reading */

export function readerScroll(el: HTMLElement, dir: 1 | -1, page = false, held = false): boolean {
  const at = targetTop(el);
  if ((dir > 0 && at >= maxTop(el) - 1) || (dir < 0 && at <= 1)) return false;
  const base = Math.round((el.clientHeight || window.innerHeight) * (page ? PAGE_STEP : READER_STEP));
  if (held && !page) rampStep(el, dir, base);
  else easeScrollBy(el, dir * base, { held });
  return true;
}

/* ------------------------------------------------------------ into view */

/** The scrollable ancestors of `el`, innermost first (the document is not one). */
function scrollParents(el: Element): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
    const cs = getComputedStyle(p);
    if ((/auto|scroll|overlay/.test(cs.overflowY) && p.scrollHeight > p.clientHeight + 2)
      || (/auto|scroll|overlay/.test(cs.overflowX) && p.scrollWidth > p.clientWidth + 2)) out.push(p);
  }
  return out;
}

/** scroll-margin as `scrollIntoView` reads it (index.css sets it while knav drives). */
function margins(el: Element) {
  const cs = getComputedStyle(el);
  const n = (v: string) => parseFloat(v) || 0;
  return { top: n(cs.scrollMarginTop), bottom: n(cs.scrollMarginBottom), left: n(cs.scrollMarginLeft), right: n(cs.scrollMarginRight) };
}

export function easeIntoView(el: HTMLElement, opts: { held?: boolean } = {}): void {
  const instant = reducedMotion();
  for (const sc of scrollParents(el)) {
    if (instant) cancelScroll(sc);
    const r = el.getBoundingClientRect();
    const b = sc.getBoundingClientRect();
    const m = margins(el);
    const pending = targetTop(sc) - sc.scrollTop;   // motion already in flight
    const topGap = r.top - m.top - b.top - sc.clientTop - pending;
    const botGap = r.bottom + m.bottom - b.top - sc.clientTop - sc.clientHeight - pending;
    let dy = 0;
    if (topGap < 0) dy = topGap;
    else if (botGap > 0) dy = Math.min(botGap, topGap);   // `nearest`: never past the top
    if (dy) {
      if (instant) sc.scrollTop = clamp(sc.scrollTop + dy, 0, maxTop(sc));
      else easeScrollBy(sc, dy, opts);
    }
    const leftGap = r.left - m.left - b.left - sc.clientLeft;
    const rightGap = r.right + m.right - b.left - sc.clientLeft - sc.clientWidth;
    let dx = 0;
    if (leftGap < 0) dx = leftGap;
    else if (rightGap > 0) dx = Math.min(rightGap, leftGap);
    if (dx) sc.scrollLeft = clamp(sc.scrollLeft + dx, 0, maxLeft(sc));
  }
}
