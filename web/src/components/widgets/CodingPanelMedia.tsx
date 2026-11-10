
import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { Maximize2, Minimize2, Pause, Play, Repeat, Scan, ZoomIn, ZoomOut } from "lucide-react";
import type { CodingAnchor, CodingMedia } from "@/lib/api";

export type MediaHandle = {
  /** a key the unit did not own; true when the media took it */
  key: (e: KeyboardEvent, onText: boolean) => boolean;
  /** the pending mark, spent */
  take: () => CodingAnchor | null;
  /** play that range, or flash that region */
  show: (a: CodingAnchor) => void;
};
type Span = { t0: number; t1: number };
type Region = { x: number; y: number; w: number; h: number };
type Props = { media: CodingMedia; live: boolean; compact: boolean; shown: CodingAnchor | null };

export const isSpan = (a: CodingAnchor): a is Span => "t0" in a;
const RATES = [0.75, 1, 1.25, 1.5, 2];
const RATE_KEY = "figure-widget:coding.media-rate";
const ERRORS: Record<string, string> = { missing: "file missing", refused: "file refused", "too-large": "file too large", type: "file type not supported" };
const BTN = "inline-flex h-6 shrink-0 items-center justify-center rounded text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-primary/60";
const keep = (e: React.MouseEvent) => e.preventDefault();
const clamp = (v: number, a: number, b: number) => Math.min(Math.max(v, a), b);
const round = (v: number, n: number) => Math.round(v * n) / n;

function readRate(): number {
  try { const v = Number(sessionStorage.getItem(RATE_KEY)); return RATES.includes(v) ? v : 1; } catch { return 1; }
}

/** 64.25 -> 1:04.3 */
export function clock(s: number): string {
  const v = Math.round(Math.abs(s) * 10) / 10;
  const m = Math.floor(v / 60);
  const r = v - m * 60;
  return (s < -0.04 ? "-" : "") + m + ":" + (r < 9.95 ? "0" : "") + r.toFixed(1);
}

/** a time anchor as the transport's clock reads it; a region has no words */
export const anchorLabel = (a: CodingAnchor, media: CodingMedia | null): string =>
  (isSpan(a) ? clock(a.t0 - (media?.start ?? 0)) + "–" + clock(a.t1 - (media?.start ?? 0)) : "");

/** Fill the HTTP cache with the next unit's file. Returns the abort. */
export function warmMedia(m: CodingMedia): () => void {
  if (m.error || !m.url) return () => undefined;
  if (m.kind === "image") {
    const img = new Image();
    img.src = m.preview || m.url;
    return () => { img.src = ""; };
  }
  const el = document.createElement(m.kind);
  el.muted = true;
  el.preload = m.kind === "audio" ? "auto" : "metadata";
  el.src = m.url;
  return () => { el.removeAttribute("src"); el.load(); };
}

export const CodingMediaBlock = forwardRef<MediaHandle, Props>(function CodingMediaBlock(p, ref) {
  if (p.media.error || !p.media.url) {
    return (
      <div data-coding-media={p.media.kind} data-coding-media-error={p.media.error || "missing"}
        className="shrink-0 rounded-lg border border-border/70 px-3 py-2 text-[12px] text-muted-foreground">
        {ERRORS[p.media.error] || "file not available"}
      </div>
    );
  }
  return p.media.kind === "image" ? <Picture ref={ref} {...p} /> : <Player ref={ref} {...p} />;
});

/* ------------------------------------------------------------------ audio and video */

const Player = forwardRef<MediaHandle, Props>(function Player({ media, live, compact, shown }, ref) {
  const root = useRef<HTMLDivElement>(null);
  const el = useRef<HTMLMediaElement | null>(null);
  const bar = useRef<HTMLDivElement>(null);
  const [dur, setDur] = useState(0);
  const [t, setT] = useState(media.start ?? 0);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(readRate);
  const [loop, setLoop] = useState(false);
  const [mark, setMark] = useState<{ a: number | null; b: number | null }>({ a: null, b: null });
  const [bad, setBad] = useState(false);
  const w0 = media.start ?? 0;
  const w1 = media.end !== null ? (dur ? Math.min(media.end, dur) : media.end) : dur;
  const now = useRef({ w0, w1, loop, mark, live, dur, once: null as Span | null });
  now.current = { ...now.current, w0, w1, loop, mark, live, dur };
  const stopAt = useRef<number | null>(null);
  const drag = useRef<{ x: number; t: number; moved: boolean } | null>(null);

  const span = useCallback((): [number, number] => {
    const n = now.current;
    if (n.once) return [n.once.t0, n.once.t1];
    if (n.loop && n.mark.a !== null && n.mark.b !== null) return [n.mark.a, n.mark.b];
    return [n.w0, n.w1];
  }, []);
  const arm = useCallback((from: number) => {
    const b = span()[1];
    stopAt.current = b > 0 && from < b - 0.05 ? b : null;
  }, [span]);
  const play = useCallback((from?: number) => {
    const m = el.current;
    if (!m) return;
    if (from !== undefined) m.currentTime = from;
    arm(m.currentTime);
    // a refused autoplay leaves it paused, which is what the transport shows
    void m.play().catch(() => undefined);
  }, [arm]);
  const toggle = useCallback(() => {
    const m = el.current;
    if (!m) return;
    if (!m.paused) { m.pause(); return; }
    now.current.once = null;
    const [a, b] = span();
    play(m.ended || (b > 0 && Math.abs(m.currentTime - b) < 0.06) ? a : undefined);
  }, [play, span]);
  const seek = useCallback((to: number) => {
    const m = el.current;
    if (!m) return;
    now.current.once = null;
    const d = Number.isFinite(m.duration) ? m.duration : now.current.dur;
    m.currentTime = d ? clamp(to, 0, d) : Math.max(to, 0);
    arm(m.currentTime);
    setT(m.currentTime);
  }, [arm]);
  const tick = useCallback(() => {
    const m = el.current;
    if (!m) return;
    const s = stopAt.current;
    if (s !== null && m.currentTime >= s) {
      if (now.current.loop && !now.current.once) m.currentTime = span()[0];
      else { m.pause(); m.currentTime = s; stopAt.current = null; now.current.once = null; }
    }
    setT(m.currentTime);
  }, [span]);
  const speed = useCallback((d: -1 | 1 | 0) => {
    setRate((r) => {
      const i = RATES.indexOf(r);
      const n = d === 0 ? RATES[(i + 1) % RATES.length] : RATES[clamp(i + d, 0, RATES.length - 1)];
      try { sessionStorage.setItem(RATE_KEY, String(n)); } catch { /* private mode */ }
      return n;
    });
  }, []);

  useEffect(() => {
    const m = el.current;
    if (!m) return;
    m.preservesPitch = true;
    m.src = media.url;
    const go = () => {
      setDur(Number.isFinite(m.duration) ? m.duration : 0);
      if (w0 > 0) m.currentTime = w0;
      if (media.autoplay && now.current.live && (navigator.userActivation?.hasBeenActive ?? true)) play();
    };
    if (m.readyState >= 1) go(); else m.addEventListener("loadedmetadata", go, { once: true });
    // a detached element keeps sounding: stop it, and let go of the download
    return () => { m.removeEventListener("loadedmetadata", go); m.pause(); m.removeAttribute("src"); m.load(); };
  }, [media.url]);  // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (el.current) el.current.playbackRate = rate; }, [rate]);
  useEffect(() => { if (!live) el.current?.pause(); }, [live]);
  useEffect(() => { const m = el.current; if (m && !m.paused) arm(m.currentTime); }, [loop, mark, arm]);

  useEffect(() => {
    if (!playing) return;
    let id = requestAnimationFrame(function f() { tick(); id = requestAnimationFrame(f); });
    return () => cancelAnimationFrame(id);
  }, [playing, tick]);

  useImperativeHandle(ref, () => ({
    key: (e, onText) => {
      const m = el.current;
      if (!m || !now.current.live) return false;
      if (e.key === " ") { if (e.shiftKey || !onText) return false; toggle(); return true; }
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        if (!onText) return false;
        seek(m.currentTime + (e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 0.5 : 2));
        return true;
      }
      if (e.key === "," || e.key === ".") { speed(e.key === "," ? -1 : 1); return true; }
      if (e.shiftKey) return false;
      if (e.key === "r") { now.current.once = null; play(now.current.w0); return true; }
      if (e.key === "l") { setLoop((v) => !v); return true; }
      if (e.key === "i") { const c = m.currentTime; setMark((k) => ({ a: c, b: k.b !== null && k.b > c ? k.b : null })); return true; }
      if (e.key === "o") {
        const c = m.currentTime;
        setMark((k) => {
          const a = k.a ?? now.current.w0;
          return c > a ? { a, b: c } : c < a ? { a: c, b: a } : k;
        });
        return true;
      }
      if (e.key === "x") { setMark({ a: null, b: null }); return true; }
      return false;
    },
    take: () => {
      const k = now.current.mark;
      if (k.a === null || k.b === null) return null;
      const t0 = round(Math.max(k.a, 0), 1000), t1 = round(k.b, 1000);
      if (t1 <= t0) return null;
      setMark({ a: null, b: null });
      return { t0, t1 };
    },
    show: (a) => {
      if (!isSpan(a) || !now.current.live) return;
      now.current.once = { t0: a.t0, t1: a.t1 };
      play(a.t0);
    },
  }), [toggle, seek, speed, play]);

  // the bar spans the file, or the window with some air when the window is a sliver of it
  const windowed = media.start !== null || media.end !== null;
  let d0 = 0, d1 = dur;
  if (windowed && dur && w1 - w0 < dur * 0.15) {
    const pad = Math.max(2, (w1 - w0) * 0.25);
    d0 = Math.min(Math.max(0, w0 - pad), t);
    d1 = Math.max(Math.min(dur, w1 + pad), t);
  }
  const pc = (v: number) => (d1 > d0 ? clamp(((v - d0) / (d1 - d0)) * 100, 0, 100) : 0);
  const band = (a: number, b: number) => ({ left: pc(a) + "%", width: Math.max(0, pc(b) - pc(a)) + "%" });
  const at = (x: number) => {
    const r = bar.current?.getBoundingClientRect();
    return r && r.width ? d0 + clamp((x - r.left) / r.width, 0, 1) * (d1 - d0) : 0;
  };
  const len = w1 - w0;
  const marked = mark.a !== null && mark.b !== null;
  const seen = shown && isSpan(shown) ? shown : null;

  const transport = (
    <div data-coding-media-transport className="flex h-8 shrink-0 items-center gap-1.5">
      <button type="button" data-knav-item data-coding-media-play aria-pressed={playing} onMouseDown={keep} onClick={toggle}
        title={playing ? "Pause (Space)" : "Play (Space) · replay (r)"} className={BTN + " w-6 text-foreground"}>
        {playing ? <Pause size={13} /> : <Play size={13} />}
      </button>
      <div ref={bar} data-coding-media-bar role="slider" aria-label="Position" aria-valuemin={0} aria-valuemax={round(dur, 10)} aria-valuenow={round(t, 10)}
        title="Seek (click, ← →) · mark a range (drag, i o) · clear it (x)"
        className="relative h-6 min-w-[48px] flex-1 cursor-pointer touch-none"
        onPointerDown={(e) => {
          if (e.button !== 0 || !dur) return;
          e.preventDefault();
          drag.current = { x: e.clientX, t: at(e.clientX), moved: false };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const g = drag.current;
          if (!g || (!g.moved && Math.abs(e.clientX - g.x) < 4)) return;
          g.moved = true;
          const c = at(e.clientX);
          setMark({ a: Math.min(g.t, c), b: Math.max(g.t, c) });
        }}
        onPointerUp={(e) => {
          const g = drag.current;
          drag.current = null;
          if (g && !g.moved) seek(at(e.clientX));
        }}
        onPointerCancel={() => { drag.current = null; }}>
        <span className="absolute inset-x-0 top-1/2 h-[4px] -translate-y-1/2 rounded-full bg-muted" />
        {dur > 0 && windowed && (
          <span data-coding-media-window className="absolute top-1/2 h-[4px] -translate-y-1/2 rounded-full bg-primary/35" style={band(w0, w1)} />
        )}
        {dur > 0 && seen && (
          <span data-coding-media-shown className="absolute top-1/2 h-[12px] -translate-y-1/2 rounded-[2px] ring-1 ring-primary" style={band(seen.t0, seen.t1)} />
        )}
        {dur > 0 && marked && (
          <span data-coding-media-mark className="absolute top-1/2 h-[8px] -translate-y-1/2 rounded-[2px] bg-primary/75" style={band(mark.a as number, mark.b as number)} />
        )}
        {dur > 0 && !marked && mark.a !== null && (
          <span data-coding-media-mark-in className="absolute top-1/2 h-[12px] w-[2px] -translate-y-1/2 bg-primary" style={{ left: pc(mark.a) + "%" }} />
        )}
        <span className="absolute top-1/2 h-[14px] w-[2px] -translate-x-1/2 -translate-y-1/2 rounded bg-foreground" style={{ left: pc(t) + "%" }} />
      </div>
      <span data-coding-media-time className="nums shrink-0 text-[11px] text-muted-foreground"
        title={"In the file: " + clock(t) + (dur ? " of " + clock(dur) : "")}>
        {clock(t - w0)}{len > 0 ? " / " + clock(len) : ""}
      </span>
      <button type="button" data-knav-item data-coding-media-rate={rate} onMouseDown={keep} onClick={() => speed(0)} title="Speed (, .)"
        className={BTN + " nums px-1 text-[11px]"}>{rate}×</button>
      <button type="button" data-knav-item data-coding-media-loop aria-pressed={loop} onMouseDown={keep} onClick={() => setLoop((v) => !v)}
        title={"Loop the " + (marked ? "marked range" : "window") + " (l)"}
        className={BTN + " w-6 " + (loop ? "bg-primary/15 text-foreground" : "")}>
        <Repeat size={12} />
      </button>
    </div>
  );
  const events = {
    onPlay: () => setPlaying(true), onPause: () => setPlaying(false), onTimeUpdate: tick,
    onDurationChange: (e: React.SyntheticEvent<HTMLMediaElement>) => { const d = e.currentTarget.duration; setDur(Number.isFinite(d) ? d : 0); },
    onEnded: () => { if (now.current.loop && !now.current.once) play(span()[0]); },
    onError: () => { if (el.current?.getAttribute("src")) setBad(true); },
  };
  const attrs = { "data-coding-media": media.kind, "data-coding-playing": playing ? "1" : undefined, "data-coding-media-marked": marked ? "1" : undefined };

  if (media.kind === "audio") {
    return (
      <div ref={root} {...attrs} className="shrink-0 rounded-lg border border-border/70 px-2">
        <audio ref={(n) => { el.current = n; }} preload="auto" tabIndex={-1} className="hidden" {...events} />
        {bad ? <div data-coding-media-error="play" className="py-2 text-[12px] text-muted-foreground">file did not play</div> : transport}
      </div>
    );
  }
  return (
    <div ref={root} {...attrs} className="flex min-h-0 flex-1 flex-col">
      <div className={"relative flex-1 overflow-hidden rounded-lg bg-muted/40 " + (compact ? "min-h-[96px]" : "min-h-[34vh]")}
        onMouseDown={keep} onClick={toggle}>
        <video ref={(n) => { el.current = n; }} playsInline preload="metadata" tabIndex={-1}
          className="absolute inset-0 h-full w-full object-contain" {...events} />
        {bad && <div data-coding-media-error="play" className="absolute inset-0 flex items-center justify-center text-[12px] text-muted-foreground">file did not play</div>}
      </div>
      {transport}
    </div>
  );
});

/* ------------------------------------------------------------------------- image */

const fits = (r: Region): Region => {
  const x = clamp(r.x, 0, 1), y = clamp(r.y, 0, 1);
  return { x: round(x, 1e4), y: round(y, 1e4), w: round(clamp(r.w, 0, 1 - x), 1e4), h: round(clamp(r.h, 0, 1 - y), 1e4) };
};
const boxOf = (r: Region) => ({ left: r.x * 100 + "%", top: r.y * 100 + "%", width: r.w * 100 + "%", height: r.h * 100 + "%" });

const Picture = forwardRef<MediaHandle, Props>(function Picture({ media, live, compact, shown }, ref) {
  const stage = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [orig, setOrig] = useState(false);
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [view, setView] = useState({ z: 1, x: 0, y: 0 });
  const [pend, setPend] = useState<Region | null>(null);
  const [flash, setFlash] = useState<Region | null>(null);
  const [bad, setBad] = useState(false);
  const drag = useRef<{ x: number; y: number; pan: { x: number; y: number } | null; moved: boolean } | null>(null);
  const flashT = useRef<number | null>(null);
  const now = useRef({ pend, live });
  now.current = { pend, live };
  const viewRef = useRef(view);
  viewRef.current = view;

  useLayoutEffect(() => {
    const s = stage.current;
    if (!s) return;
    const f = () => setBox((b) => (b.w === s.clientWidth && b.h === s.clientHeight ? b : { w: s.clientWidth, h: s.clientHeight }));
    f();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(f) : null;
    ro?.observe(s);
    return () => ro?.disconnect();
  }, []);
  useEffect(() => () => { if (flashT.current !== null) window.clearTimeout(flashT.current); }, []);

  // letterboxed: the whole picture, never cropped
  const k = nat && box.w && box.h ? Math.min(box.w / nat.w, box.h / nat.h) : 0;
  const fw = nat ? nat.w * k : 0, fh = nat ? nat.h * k : 0;
  const lim = useRef({ fw, fh, bw: box.w, bh: box.h });
  lim.current = { fw, fh, bw: box.w, bh: box.h };
  const held = useCallback((z: number, x: number, y: number) => {
    const l = lim.current;
    const mx = Math.max(0, (l.fw * z - l.bw) / 2), my = Math.max(0, (l.fh * z - l.bh) / 2);
    return { z, x: clamp(x, -mx, mx), y: clamp(y, -my, my) };
  }, []);
  const zoom = useCallback((f: number) => setView((v) => {
    const z = clamp(round(v.z * f, 100), 1, 8);
    return z === 1 ? { z: 1, x: 0, y: 0 } : held(z, v.x * (z / v.z), v.y * (z / v.z));
  }), [held]);
  const fit = useCallback(() => setView({ z: 1, x: 0, y: 0 }), []);
  const norm = (cx: number, cy: number) => {
    const r = wrap.current?.getBoundingClientRect();
    return r && r.width && r.height ? { x: clamp((cx - r.left) / r.width, 0, 1), y: clamp((cy - r.top) / r.height, 0, 1) } : { x: 0, y: 0 };
  };

  useImperativeHandle(ref, () => ({
    key: (e, onText) => {
      if (!now.current.live) return false;
      if (e.key === "+" || e.key === "=") { zoom(1.25); return true; }
      if (e.key === "-") { zoom(0.8); return true; }
      if (e.key === "0") { fit(); return true; }
      const step = e.shiftKey ? 12 : 48;
      const dx = e.key === "ArrowLeft" ? step : e.key === "ArrowRight" ? -step : 0;
      const dy = e.key === "ArrowUp" ? step : e.key === "ArrowDown" ? -step : 0;
      if (dx || dy) {
        if (!onText || viewRef.current.z <= 1) return false;
        setView((v) => held(v.z, v.x + dx, v.y + dy));
        return true;
      }
      if (e.shiftKey) return false;
      if (e.key === "o" && media.preview) { setOrig((v) => !v); return true; }
      if (e.key === "x") { setPend(null); return true; }
      return false;
    },
    take: () => {
      const r = now.current.pend;
      const f = r ? fits(r) : null;
      if (!f || f.w <= 0 || f.h <= 0) return null;
      setPend(null);
      return f;
    },
    show: (a) => {
      if (isSpan(a)) return;
      fit();
      setFlash(a);
      if (flashT.current !== null) window.clearTimeout(flashT.current);
      flashT.current = window.setTimeout(() => { flashT.current = null; setFlash(null); }, 1400);
    },
  }), [zoom, fit, held, media.preview]);

  const seen = flash || (shown && !isSpan(shown) ? shown : null);
  return (
    <div data-coding-media="image" data-coding-media-zoom={view.z} data-coding-media-src={orig || !media.preview ? "original" : "preview"}
      data-coding-media-marked={pend ? "1" : undefined} className="flex min-h-0 flex-1 flex-col">
      <div ref={stage} data-coding-media-stage title="Drag to mark a region (x clears it) · Shift+drag to pan when zoomed"
        className={"relative flex-1 cursor-crosshair touch-none select-none overflow-hidden rounded-lg bg-muted/40 " + (compact ? "min-h-[96px]" : "min-h-[34vh]")}
        onPointerDown={(e) => {
          if (e.button !== 0 || !nat) return;
          e.preventDefault();
          const panning = e.shiftKey && view.z > 1;
          const n = norm(e.clientX, e.clientY);
          drag.current = panning ? { x: e.clientX, y: e.clientY, pan: { x: view.x, y: view.y }, moved: false } : { x: n.x, y: n.y, pan: null, moved: false };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const g = drag.current;
          if (!g) return;
          if (g.pan) { const p0 = g.pan; setView((v) => held(v.z, p0.x + e.clientX - g.x, p0.y + e.clientY - g.y)); return; }
          const n = norm(e.clientX, e.clientY);
          const r = { x: Math.min(g.x, n.x), y: Math.min(g.y, n.y), w: Math.abs(n.x - g.x), h: Math.abs(n.y - g.y) };
          if (!g.moved && r.w < 0.01 && r.h < 0.01) return;
          g.moved = true;
          setPend(r);
        }}
        onPointerUp={() => {
          const g = drag.current;
          drag.current = null;
          // a drag too thin to be a region marks nothing
          if (g && !g.pan && g.moved) setPend((r) => (r && r.w >= 0.01 && r.h >= 0.01 ? r : null));
        }}
        onPointerCancel={() => { drag.current = null; }}>
        <div ref={wrap} className="absolute"
          style={{ width: fw || undefined, height: fh || undefined, left: (box.w - fw) / 2 + view.x, top: (box.h - fh) / 2 + view.y,
            transform: "scale(" + view.z + ")", visibility: nat ? undefined : "hidden" }}>
          <img src={orig || !media.preview ? media.url : media.preview} alt="" draggable={false} data-coding-media-img
            className="block h-full w-full"
            onLoad={(e) => { const i = e.currentTarget; if (i.naturalWidth && i.naturalHeight) setNat({ w: i.naturalWidth, h: i.naturalHeight }); setBad(false); }}
            onError={() => setBad(true)} />
          {seen && <span data-coding-media-shown className="pointer-events-none absolute rounded-[2px] bg-primary/20 ring-2 ring-primary" style={boxOf(seen)} />}
          {pend && <span data-coding-media-region className="pointer-events-none absolute rounded-[2px] border-2 border-dashed border-primary bg-primary/10" style={boxOf(pend)} />}
        </div>
        {bad && <div data-coding-media-error="play" className="absolute inset-0 flex items-center justify-center text-[12px] text-muted-foreground">file did not load</div>}
      </div>
      <div data-coding-media-transport className="flex h-7 shrink-0 items-center gap-1">
        <button type="button" data-knav-item data-coding-media-zoomout onMouseDown={keep} onClick={() => zoom(0.8)} title="Zoom out (-)" className={BTN + " w-6"}>
          <ZoomOut size={12} />
        </button>
        <span data-coding-media-zoomlabel className="nums w-9 shrink-0 text-center text-[11px] text-muted-foreground" title="Zoom">{Math.round(view.z * 100)}%</span>
        <button type="button" data-knav-item data-coding-media-zoomin onMouseDown={keep} onClick={() => zoom(1.25)} title="Zoom in (+)" className={BTN + " w-6"}>
          <ZoomIn size={12} />
        </button>
        <button type="button" data-knav-item data-coding-media-fit onMouseDown={keep} onClick={fit} title="Fit (0)" className={BTN + " w-6"}>
          <Scan size={12} />
        </button>
        <span className="min-w-0 flex-1" />
        {media.preview && (
          <button type="button" data-knav-item data-coding-media-original={orig ? "on" : "off"} aria-pressed={orig} onMouseDown={keep}
            onClick={() => setOrig((v) => !v)} title={orig ? "Display size (o)" : "Full resolution (o)"}
            className={BTN + " w-6 " + (orig ? "bg-primary/15 text-foreground" : "")}>
            {orig ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
          </button>
        )}
      </div>
    </div>
  );
});
