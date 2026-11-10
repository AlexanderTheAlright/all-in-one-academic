
import { useEffect, useMemo, useRef, useState } from "react";
import {
  paginate, parseBlocks, buildBlockEl, docTypography, PRINT_COL_PX, PRINT_FONT,
  type PaginationResult, type SpacingMode, type PageProfile, type EmbedSizes,
} from "@/lib/pagination";

const SHEET_W = 816;    // 8.5in
const SHEET_H = 1056;   // 11in
const MARGIN = 96;      // 1in

export default function PageView({ raw, spacing, profile, slug, zoom, onJump }: {
  raw: string;
  spacing: SpacingMode;
  profile: PageProfile;
  slug: string;
  zoom: number;
  onJump?: (offset: number) => void;
}) {
  const [embedSizes, setEmbedSizes] = useState<EmbedSizes>({});
  const [pg, setPg] = useState<PaginationResult | null>(null);

  // natural sizes of every figure/table embed — the engine needs the aspect
  // ratio to know each one's printed height at 6in width
  useEffect(() => {
    const { blocks } = parseBlocks(raw);
    const wanted = blocks.filter((b) => b.kind === "figure" || b.kind === "table");
    let cancelled = false;
    for (const b of wanted) {
      const name = b.embedName || "";
      if (!name || embedSizes[name]) continue;
      const img = new Image();
      img.onload = () => { if (!cancelled) setEmbedSizes((p) => ({ ...p, [name]: { w: img.naturalWidth, h: img.naturalHeight } })); };
      img.src = embedUrl(slug, b.kind === "table", name);
    }
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raw, slug]);

  useEffect(() => {
    const t = setTimeout(() => {
      try { setPg(paginate(raw, { profile, spacing, embeds: embedSizes, blind: true })); }
      catch { setPg(null); }
    }, 120);
    return () => clearTimeout(t);
  }, [raw, spacing, profile, embedSizes]);

  // per-page geometry: page top/bottom, and each page's blocks with their
  // global first-line y + line height (uniform within a block)
  const pages = useMemo(() => {
    if (!pg) return [];
    const blockFirstY = new Map<number, number>();
    const blockH = new Map<number, number>();
    for (const l of pg.lineStarts) {
      if (!blockFirstY.has(l.blockIdx)) { blockFirstY.set(l.blockIdx, l.y); blockH.set(l.blockIdx, l.h); }
    }
    const byPage = new Map<number, { top: number; bottom: number; blocks: Set<number> }>();
    for (const l of pg.lineStarts) {
      let e = byPage.get(l.page);
      if (!e) { e = { top: l.y, bottom: l.y + l.h, blocks: new Set() }; byPage.set(l.page, e); }
      e.top = Math.min(e.top, l.y); e.bottom = Math.max(e.bottom, l.y + l.h);
      e.blocks.add(l.blockIdx);
    }
    return Array.from(byPage.entries()).sort((a, b) => a[0] - b[0])
      .map(([page, e]) => ({ page, top: e.top, bottom: e.bottom, blocks: Array.from(e.blocks), blockFirstY, blockH }));
  }, [pg]);

  const hostRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const hostEl = hostRef.current;
    if (!hostEl || !pg) return;
    hostEl.querySelectorAll("[data-pgwin]").forEach((w) => {
      const meta = pages.find((m) => m.page === Number(w.getAttribute("data-pgwin")));
      if (!meta) return;
      w.innerHTML = "";
      const typo = docTypography(raw);
      const inner = document.createElement("div");
      inner.style.cssText = `position:relative;width:${PRINT_COL_PX}px;height:100%;` +
        `font-family:${typo.css};font-size:${typo.sizePx}px;color:#1a1a1a;text-align:left;`;
      for (const bi of meta.blocks) {
        const b = pg.blockList[bi];
        if (!b || b.kind === "refmark") continue;
        const top = (meta.blockFirstY.get(bi) ?? 0) - meta.top;
        const h = meta.blockH.get(bi) ?? 0;
        if (b.kind === "figure" || b.kind === "table") {
          const img = document.createElement("img");
          img.src = embedUrl(slug, b.kind === "table", b.embedName || "");
          img.style.cssText = `position:absolute;top:${top}px;left:24px;width:576px;height:${h}px;object-fit:contain;`;
          img.setAttribute("data-off", String(b.from));
          img.tabIndex = 0; img.setAttribute("role", "button");   // a keyboard stop: Enter jumps like a click
          inner.appendChild(img);
          continue;
        }
        const el = buildBlockEl(b, profile);
        el.style.position = "absolute";
        el.style.top = top + "px";
        el.style.left = "0";
        el.style.width = PRINT_COL_PX + "px";
        el.style.lineHeight = h + "px";
        // each block is a keyboard stop that jumps to its start (a click on a word inside
        // still lands on that word's own offset)
        if (!el.hasAttribute("data-off")) el.setAttribute("data-off", String(b.from));
        el.tabIndex = 0; el.setAttribute("role", "button");
        inner.appendChild(el);
      }
      w.appendChild(inner);
    });
  }, [pg, pages, profile, slug]);

  const total = pg?.pages ?? 0;
  return (
    <div data-page-view className="flex-1 min-h-0 overflow-y-auto" style={{ background: "hsl(var(--muted) / 0.4)" }}
      onClick={(e) => {
        if (!onJump) return;
        const t = (e.target as HTMLElement).closest("[data-off]");
        if (t) onJump(Number(t.getAttribute("data-off")));
      }}>
      <div className="mx-auto py-8 flex flex-col items-center gap-2" style={{ width: Math.round(SHEET_W * zoom) + 48 }}>
        <div className="flex items-center gap-2 pb-2 text-[11.5px] text-muted-foreground">
          <span className="nums">{total} page{total === 1 ? "" : "s"}</span>
          <span>·</span>
          <span>{profile === "docx" ? "Word layout" : "PDF layout"} · {spacing === "double" ? "double-spaced" : "single-spaced"}</span>
          {pg?.approx && <span className="rounded-full border border-border px-2 py-0.5 text-[10.5px]">estimate — LaTeX justifies &amp; hyphenates</span>}
          {pg?.refsUnknown && <span className="rounded-full border border-amber-500/50 text-amber-600 dark:text-amber-400 px-2 py-0.5 text-[10.5px]" title="A transcluded embed (references or a .md section) is resolved at compile time — its pages aren't counted here">+ transclusions</span>}
          {profile === "pdf" && <span className="rounded-full border border-border px-2 py-0.5 text-[10.5px]" title="The LaTeX class emits a title sheet and an abstract sheet before the body">includes 2 front sheets</span>}
        </div>
        <div ref={hostRef} className="flex flex-col items-center" style={{ gap: Math.round(28 * zoom) }}>
          {pages.map((m) => (
            <div key={m.page} style={{ width: Math.round(SHEET_W * zoom), height: Math.round(SHEET_H * zoom) }}>
              <div className="relative bg-white border border-border rounded-[3px]"
                style={{ width: SHEET_W, height: SHEET_H, transform: `scale(${zoom})`, transformOrigin: "top left",
                  boxShadow: "0 4px 30px hsl(0 0% 0% / 0.22)" }}>
                <span className="absolute nums" style={{ top: 40, right: MARGIN, fontSize: 13, color: "#8a8378", fontFamily: PRINT_FONT }}>
                  {profile === "pdf" ? m.page + 1 : m.page}
                </span>
                <div data-pgwin={m.page} className="absolute overflow-hidden"
                  style={{ left: MARGIN, top: MARGIN, width: PRINT_COL_PX, height: Math.min(Math.ceil(m.bottom - m.top), SHEET_H - 2 * MARGIN) }} />
              </div>
            </div>
          ))}
          {!pg && <div className="text-[13px] text-muted-foreground py-10">Measuring the manuscript at print geometry…</div>}
          {pg && pages.length === 0 && <div className="text-[13px] text-muted-foreground py-10">Nothing to paginate yet — start writing.</div>}
        </div>
        <div className="pb-8" />
      </div>
    </div>
  );
}

function embedUrl(slug: string, isTable: boolean, name: string): string {
  return isTable
    ? "/drafting/table-png?slug=" + encodeURIComponent(slug) + "&name=" + encodeURIComponent(name.replace(/\.(csv|md)$/i, ""))
    : "/drafting/asset?slug=" + encodeURIComponent(slug) + "&name=" + encodeURIComponent(name);
}
