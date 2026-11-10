
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { DraftDeck } from "@/lib/api";
import { MarpSurface, PRESENT_CHANNEL, PRESENT_BUS_KEY, preloadDeckImages } from "@/components/draftingShared";

export function AudienceView({ slug, deck }: { slug: string; deck: string }) {
  const [data, setData] = useState<DraftDeck | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [idx, setIdx] = useState(0);
  const [ended, setEnded] = useState(false);
  useEffect(() => {
    api.draftingDeck(slug, deck)
      .then((d) => {
        if (d.error) { setErr(d.error); return; }
        setData(d);
        preloadDeckImages(d.slides);
      })
      .catch(() => setErr("could not render the deck"));
  }, [slug, deck]);
  const pendingRef = useRef<{ idx: number; at: number } | null>(null);
  useEffect(() => {
    let live = true;
    const tick = async () => {
      try {
        const s = await api.presentState();
        if (!live || !s || s.deck !== deck) return;
        const p = pendingRef.current;
        if (p) {
          if (s.idx === p.idx) pendingRef.current = null;          // the server caught up
          else if (Date.now() - p.at < 2500) return;               // stale read — ignore it
          else pendingRef.current = null;                          // gave up; trust the server
        }
        setIdx(s.idx || 0); setEnded(!s.active);
      } catch { /* server briefly away — hold the last slide */ }
    };
    tick();
    const id = setInterval(tick, 400);
    return () => { live = false; clearInterval(id); };
  }, [deck]);
  useEffect(() => {
    const onMsg = (m: { type?: string; idx?: number } | null) => {
      if (m && m.type === "goto" && typeof m.idx === "number") {
        pendingRef.current = { idx: m.idx, at: Date.now() };
        setIdx(m.idx); setEnded(false);
      }
    };
    let bc: BroadcastChannel | null = null;
    try { bc = new BroadcastChannel(PRESENT_CHANNEL); bc.onmessage = (e) => onMsg(e.data); } catch { bc = null; }
    const onStorage = (e: StorageEvent) => {
      if (e.key === PRESENT_BUS_KEY && e.newValue) { try { onMsg(JSON.parse(e.newValue)); } catch { /* ignore */ } }
    };
    window.addEventListener("storage", onStorage);
    return () => { window.removeEventListener("storage", onStorage); if (bc) bc.close(); };
  }, []);
  const toggleFull = () => {
    const d = document.documentElement;
    if (!document.fullscreenElement) d.requestFullscreen?.().catch(() => undefined);
    else document.exitFullscreen?.().catch(() => undefined);
  };
  const post = (i: number) => {
    try { const bc = new BroadcastChannel(PRESENT_CHANNEL); bc.postMessage({ type: "goto", idx: i, src: "audience", t: Date.now() }); bc.close(); }
    catch { try { localStorage.setItem(PRESENT_BUS_KEY, JSON.stringify({ type: "goto", idx: i, src: "audience", t: Date.now() })); } catch { /* quota */ } }
    api.presentPublish({ slug, deck, idx: i, active: true, src: "audience" });
  };
  const go = (d: number) => {
    const n2 = data?.slides.length || 0;
    if (!n2) return;
    const next = Math.max(0, Math.min(n2 - 1, idx + d));
    if (next === idx) return;
    pendingRef.current = { idx: next, at: Date.now() };   // hold the poll off our own move
    setIdx(next);
    setEnded(false);
    post(next);
  };
  const onSurfaceClick = () => {
    if (!document.fullscreenElement) { toggleFull(); return; }
    go(1);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.key;
      if (k === "f" || k === "F") { toggleFull(); return; }
      if (k === "ArrowRight" || k === "PageDown" || k === " " || k === "Enter") { e.preventDefault(); go(1); }
      else if (k === "ArrowLeft" || k === "PageUp" || k === "Backspace") { e.preventDefault(); go(-1); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  const n = data?.slides.length || 0;
  const cur = n ? data!.slides[Math.max(0, Math.min(n - 1, idx))] : null;
  return (
    <div className="fixed inset-0 bg-black grid place-items-center select-none cursor-pointer"
      onClick={onSurfaceClick} onContextMenu={(e) => { e.preventDefault(); go(-1); }}
      title="Click to fill the screen; once full screen, click to advance and right-click to go back. Arrows work either way, F toggles full screen.">
      {err ? <p className="text-white/70 text-[14px] px-8 text-center">{err}</p>
        : !data ? <p className="text-white/50 text-[13px]">Loading the deck…</p>
        : (
          <div style={{ width: "min(100vw, calc(100vh * 16 / 9))" }}>
            <div style={{ aspectRatio: "16 / 9", overflow: "hidden", background: "#fff", width: "100%" }}>
              <MarpSurface css={data.css} html={cur?.svg || ""} style={{ width: "100%", height: "100%" }} />
            </div>
          </div>
        )}
      {ended && data && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-white/10 px-3 py-1 text-[12px] text-white/70">presentation ended — holding the last slide</div>
      )}
    </div>
  );
}
