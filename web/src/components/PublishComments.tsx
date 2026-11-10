import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type PdfComment, type PdfTextPage, type DraftCommentRect } from "@/lib/api";
import { reapplyById } from "@/components/explore/figureStore";
import { toast } from "sonner";
import { AnchoredCommentCard } from "./Drafting";
import { ChevronLeft, ChevronRight, Loader2, MessageSquarePlus } from "lucide-react";

type DragRect = { x0: number; y0: number; x1: number; y1: number };

function wordsInRect(page: PdfTextPage | undefined, rect: DragRect): string {
  if (!page) return "";
  const x0 = Math.min(rect.x0, rect.x1) * page.width, x1 = Math.max(rect.x0, rect.x1) * page.width;
  const y0 = Math.min(rect.y0, rect.y1) * page.height, y1 = Math.max(rect.y0, rect.y1) * page.height;
  return page.words.filter((w) => w.x1 >= x0 && w.x0 <= x1 && w.y1 >= y0 && w.y0 <= y1).map((w) => w.text).join(" ").trim();
}

export function PublishComments({ slug, docName, target, tick }: {
  slug: string; docName: string; target: "pdf" | "docx"; tick: number;
}) {
  const [pages, setPages] = useState<PdfTextPage[] | null>(null);
  const [pageErr, setPageErr] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [comments, setComments] = useState<PdfComment[]>([]);
  // the list and the token it was last CONFIRMED at — the base every save is pinned to,
  // and the ancestor a 409 merge re-applies this panel's own ids onto
  const store = useRef<{ list: PdfComment[]; mtime: number | null; version: string | null }>({ list: [], mtime: null, version: null });
  const [composer, setComposer] = useState<{ rect: DragRect; quote: string } | null>(null);
  const [body, setBody] = useState("");
  const imgRef = useRef<HTMLImageElement>(null);
  const dragRef = useRef<{ x0: number; y0: number } | null>(null);
  const [drag, setDrag] = useState<DragRect | null>(null);

  useEffect(() => {
    let live = true;
    setPages(null); setPageErr(null); setPage(1);
    api.draftingPdfTextLayer(slug, docName, target).then((r) => {
      if (!live) return;
      if (r.error || !r.pages) { setPageErr(r.error || "could not read that document"); return; }
      setPages(r.pages);
    }).catch(() => live && setPageErr("could not read that document"));
    return () => { live = false; };
  }, [slug, docName, target, tick]);

  const refresh = useCallback(() => {
    api.draftingPdfComments(slug, docName).then((r) => {
      const list = r.comments || [];
      store.current = { list, mtime: r.mtime ?? 0, version: r.version ?? "" };
      setComments(list);
    }).catch(() => {});
  }, [slug, docName]);
  useEffect(() => {
    let live = true;
    api.draftingPdfComments(slug, docName).then((r) => {
      if (!live) return;
      const list = r.comments || [];
      store.current = { list, mtime: r.mtime ?? 0, version: r.version ?? "" };
      setComments(list);
    }).catch(() => {});
    return () => { live = false; };
  }, [slug, docName, tick]);

  const save = useCallback(async (next: PdfComment[]) => {
    const base = store.current.list;
    setComments(next);
    try {
      let r = await api.draftingSavePdfComments({ slug, doc: docName, comments: next, baseMtime: store.current.mtime, baseVersion: store.current.version });
      let written = next;
      if (r.conflict) {
        written = reapplyById(r.currentComments || [], base, next);
        setComments(written);
        r = await api.draftingSavePdfComments({ slug, doc: docName, comments: written, baseMtime: r.currentMtime ?? null, baseVersion: r.currentVersion });
        if (r.conflict) { refresh(); toast.error("Comments changed elsewhere — reloaded"); return; }
      }
      if (r.ok) store.current = { list: written, mtime: r.mtime ?? store.current.mtime, version: r.version ?? store.current.version };
    } catch { toast.error("Couldn't save the comment"); }
  }, [slug, docName, refresh]);

  const total = pages?.length ?? 0;
  const curPage = pages?.find((p) => p.page === page);
  const pageComments = useMemo(() => comments.filter((c) => c.target === target), [comments, target]);

  const onMouseDown = (e: React.MouseEvent<HTMLImageElement>) => {
    const r = imgRef.current!.getBoundingClientRect();
    dragRef.current = { x0: (e.clientX - r.left) / r.width, y0: (e.clientY - r.top) / r.height };
    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      const x1 = (ev.clientX - r.left) / r.width, y1 = (ev.clientY - r.top) / r.height;
      setDrag({ x0: dragRef.current.x0, y0: dragRef.current.y0, x1, y1 });
    };
    const onUp = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp);
      if (!dragRef.current) return;
      const x1 = (ev.clientX - r.left) / r.width, y1 = (ev.clientY - r.top) / r.height;
      const rect = { x0: dragRef.current.x0, y0: dragRef.current.y0, x1, y1 };
      dragRef.current = null; setDrag(null);
      const quote = wordsInRect(curPage, rect) || `[page ${page} region]`;
      setComposer({ rect, quote });
    };
    window.addEventListener("mousemove", onMove); window.addEventListener("mouseup", onUp);
  };

  const submit = () => {
    if (!composer || !body.trim()) return;
    const rectPct: DraftCommentRect = {
      x: Math.min(composer.rect.x0, composer.rect.x1), y: Math.min(composer.rect.y0, composer.rect.y1),
      w: Math.abs(composer.rect.x1 - composer.rect.x0), h: Math.abs(composer.rect.y1 - composer.rect.y0),
    };
    const now = Date.now();
    const c: PdfComment = {
      id: (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : "pc" + now.toString(36),
      target, page, quote: composer.quote, rectPct, body: body.trim(), resolved: false, created: now, updated: now,
    };
    save([...comments, c]);
    setComposer(null); setBody("");
  };

  if (pageErr) return <div className="h-full flex items-center justify-center text-[13px] text-muted-foreground">{pageErr}</div>;
  if (!pages) return <div className="h-full flex items-center justify-center text-muted-foreground gap-2"><Loader2 size={16} className="animate-spin" /> reading the rendered pages…</div>;

  return (
    <div className="flex-1 min-h-0 flex">
      <div className="flex-1 min-h-0 flex flex-col">
        <div className="shrink-0 flex items-center justify-center gap-2 px-3 py-1.5 border-b border-border bg-background/60 text-[12px] text-muted-foreground">
          <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} className="disabled:opacity-30"><ChevronLeft size={14} /></button>
          <span className="nums">Page {page} of {total}</span>
          <button onClick={() => setPage((p) => Math.min(total, p + 1))} disabled={page >= total} className="disabled:opacity-30"><ChevronRight size={14} /></button>
        </div>
        <div className="flex-1 min-h-0 overflow-auto flex items-start justify-center p-4 bg-muted/40">
          <div className="relative inline-block">
            <img ref={imgRef} src={api.draftingPdfPagePngUrl(slug, docName, page, target, "paper", tick)}
              onMouseDown={onMouseDown} draggable={false} title="Drag on the page to flag a region"
              className="block max-w-full shadow-md border border-border bg-white select-none cursor-crosshair" />
            {drag && (
              <div className="absolute border-2 border-primary bg-primary/15 pointer-events-none"
                style={{ left: `${Math.min(drag.x0, drag.x1) * 100}%`, top: `${Math.min(drag.y0, drag.y1) * 100}%`, width: `${Math.abs(drag.x1 - drag.x0) * 100}%`, height: `${Math.abs(drag.y1 - drag.y0) * 100}%` }} />
            )}
            {pageComments.filter((c) => c.page === page && c.rectPct).map((c) => (
              <div key={c.id} title={c.body} className={`absolute border-2 pointer-events-none ${c.resolved ? "border-muted-foreground/40" : "border-amber-500"}`}
                style={{ left: `${(c.rectPct!.x) * 100}%`, top: `${(c.rectPct!.y) * 100}%`, width: `${c.rectPct!.w * 100}%`, height: `${c.rectPct!.h * 100}%` }} />
            ))}
            {composer && (
              <div className="absolute z-20 w-[260px] rounded-lg border border-border bg-card shadow-xl p-2.5"
                style={{ left: `${Math.min(composer.rect.x0, composer.rect.x1) * 100}%`, top: `${Math.max(composer.rect.y0, composer.rect.y1) * 100}%` }}>
                <div className="text-[10.5px] uppercase tracking-wide text-muted-foreground/70 mb-1 flex items-center gap-1"><MessageSquarePlus size={11} /> Comment on this region</div>
                <div className="mb-1.5 text-[11px] text-foreground/70 italic truncate">{composer.quote}</div>
                <textarea autoFocus value={body} onChange={(e) => setBody(e.target.value)} rows={3} placeholder="What needs to change here…"
                  className="w-full resize-none rounded-md border border-border bg-background px-2 py-1.5 text-[12px] focus:outline-none focus:border-primary/50" />
                <div className="mt-1.5 flex items-center justify-end gap-2">
                  <button onClick={() => { setComposer(null); setBody(""); }} className="text-[11.5px] text-muted-foreground hover:text-foreground">Cancel</button>
                  <button onClick={submit} disabled={!body.trim()} className="rounded-md bg-primary/10 border border-primary/40 text-primary px-2 py-1 text-[11.5px] disabled:opacity-50">Comment</button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="w-[260px] shrink-0 border-l border-border overflow-y-auto p-2.5 flex flex-col gap-2">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground/70 px-0.5">{pageComments.length} comment{pageComments.length === 1 ? "" : "s"} on this {target === "docx" ? "document" : "PDF"}</div>
        {pageComments.length === 0 && <p className="text-[11.5px] text-muted-foreground/70 px-0.5">Drag on the page to leave the first one.</p>}
        {pageComments.map((c) => (
          <div key={c.id}>
            <button type="button" onClick={() => setPage(c.page)} title={"Go to page " + c.page} className="text-[10.5px] text-muted-foreground/60 hover:text-foreground mb-0.5">p.{c.page}</button>
            <AnchoredCommentCard comment={c} active={c.page === page} orphaned={!!c.orphaned} staticLayout
              registerRef={() => {}} onActivate={() => setPage(c.page)}
              onBody={(v) => save(comments.map((x) => x.id === c.id ? { ...x, body: v, updated: Date.now() } : x))}
              onResolve={() => save(comments.map((x) => x.id === c.id ? { ...x, resolved: !x.resolved, updated: Date.now() } : x))}
              onDelete={() => save(comments.filter((x) => x.id !== c.id))}
              onLayoutChange={() => {}} />
          </div>
        ))}
      </div>
    </div>
  );
}
