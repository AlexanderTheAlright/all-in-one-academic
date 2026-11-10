import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";

const LETTER = 8.5 / 11;   // width/height, until the first page reports its own

export function PublishPages({ slug, docName, target, which = "paper", count, tick, dim }: {
  slug: string; docName: string; target: "pdf" | "docx"; which?: "paper" | "figures";
  count: number; tick: number; dim?: boolean;
}) {
  const [ratio, setRatio] = useState(LETTER);
  const [seen, setSeen] = useState<number[]>([1]);
  const seenRef = useRef<Set<number>>(new Set([1]));
  const boxes = useRef(new Map<number, HTMLElement>());
  const obs = useRef<IntersectionObserver | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const nums = useMemo(() => Array.from({ length: Math.max(0, count) }, (_, i) => i + 1), [count]);

  // a different document starts over at page one
  useEffect(() => {
    seenRef.current = new Set([1]);
    setSeen([1]);
  }, [slug, docName, target, which]);

  useEffect(() => {
    const io = new IntersectionObserver((ents) => {
      let added = false;
      for (const e of ents) {
        if (!e.isIntersecting) continue;
        const p = Number((e.target as HTMLElement).dataset.page || 0);
        if (p && !seenRef.current.has(p)) { seenRef.current.add(p); added = true; }
        io.unobserve(e.target);
      }
      if (added) setSeen([...seenRef.current]);
    }, { root: scrollRef.current, rootMargin: "900px 0px" });
    obs.current = io;
    boxes.current.forEach((el) => io.observe(el));
    return () => { io.disconnect(); obs.current = null; };
  }, [slug, docName, target, which]);

  const setBox = (p: number) => (el: HTMLDivElement | null) => {
    const prev = boxes.current.get(p);
    if (prev && obs.current) obs.current.unobserve(prev);
    if (el) { boxes.current.set(p, el); if (obs.current && !seenRef.current.has(p)) obs.current.observe(el); }
    else boxes.current.delete(p);
  };

  return (
    <div ref={scrollRef} className={`flex-1 min-h-0 overflow-y-auto tinybar bg-muted/40 transition-opacity duration-200 ${dim ? "opacity-40" : "opacity-100"}`}>
      {/* one keyboard stop for the whole stack: arrownav reads a long region by stepping
          the scroller (scroller() looks at ANCESTORS, so the stop lives inside it) */}
      <div tabIndex={0} role="group" aria-label="Compiled pages" className="flex flex-col items-center gap-5 px-4 py-4 outline-none">
        {nums.map((p) => (
          <div key={p} className="w-full max-w-[880px]">
            <div ref={setBox(p)} data-page={p} style={{ aspectRatio: String(ratio) }}
              className="relative w-full overflow-hidden border border-border bg-white shadow-md">
              {seen.includes(p) && (
                <img src={api.draftingPdfPagePngUrl(slug, docName, p, target, which, tick)}
                  alt="" draggable={false} decoding="async"
                  onLoad={(e) => {
                    const i = e.currentTarget;
                    if (!i.naturalWidth || !i.naturalHeight) return;
                    const r = i.naturalWidth / i.naturalHeight;
                    setRatio((cur) => (Math.abs(cur - r) > 0.004 ? r : cur));
                  }}
                  className="absolute inset-0 h-full w-full select-none object-contain" />
              )}
            </div>
            <div className="mt-1 text-center text-[10.5px] text-muted-foreground/60 nums">{p}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
