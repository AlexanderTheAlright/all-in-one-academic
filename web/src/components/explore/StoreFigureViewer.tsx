
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { exploreApi } from "@/lib/api";
import type { ExploreCard, ExploreComment, ExploreMeta, ExploreSpec, FigureComment } from "@/lib/api";
import { FigureLightbox } from "@/components/draftingShared";
import { FigureSpecEditor } from "@/components/explore/FigureSpecEditor";
import { SourcePanel } from "@/components/explore/SourcePanel";
import { reapplyById, useFigureTheme } from "@/components/explore/figureStore";

export function StoreFigureViewer({ id, list, onNavigate, onClose, toolbar, onNote, railOpen, onRailOpen, fit, header }: {
  id: string;
  list: ExploreCard[];
  onNavigate: (id: string) => void;
  onClose: () => void;
  toolbar?: ReactNode;
  onNote?: (s: string) => void;
  /** the /w/figure pane owns its rail (collapsed at launch) and fits the picture to its
   *  box; Drafting's dock passes neither and keeps the viewer it always had */
  railOpen?: boolean;
  onRailOpen?: (open: boolean) => void;
  fit?: boolean;
  /** the pane's tab strip, drawn over the figure */
  header?: ReactNode;
}) {
  const theme = useFigureTheme();
  const [fig, setFig] = useState<{ spec: ExploreSpec; meta: ExploreMeta | null } | null>(null);
  const [comments, setComments] = useState<ExploreComment[]>([]);
  const [version, setVersion] = useState("");
  const baseRef = useRef<ExploreComment[]>([]);
  const [tick, setTick] = useState(0);
  const [preview, setPreview] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const note = onNote || (() => {});

  useEffect(() => {
    if (!preview) { setPreviewUrl(null); return; }
    const u = URL.createObjectURL(new Blob([preview], { type: "image/svg+xml" }));
    setPreviewUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [preview]);

  useEffect(() => {
    if (!id) { setFig(null); return; }
    let live = true;
    exploreApi.figure(id).then((r) => {
      if (!live || !r.ok) return;
      setFig({ spec: r.spec, meta: r.meta });
      setComments(r.comments || []);
      baseRef.current = r.comments || [];
      setVersion(r.version || "");
    }).catch(() => {});
    return () => { live = false; };
  }, [id, tick]);

  const persist = useCallback(async (next: ExploreComment[]) => {
    if (!id) return;
    const base = baseRef.current;
    setComments(next);
    try {
      let r = await exploreApi.saveComments({ id, comments: next, baseVersion: version });
      if (r.status === 409 || r.data.conflict) {
        const merged = reapplyById(r.data.currentComments || [], base, next);
        r = await exploreApi.saveComments({ id, comments: merged, baseVersion: r.data.currentVersion || "" });
        if (r.status === 409 || r.data.conflict) { note("Comments kept moving, reloaded"); setTick((t) => t + 1); return; }
      }
      if (!r.data.ok) { note(r.data.error || "Couldn't save the comment"); return; }
      const saved = r.data.comments || [];
      setComments(saved); baseRef.current = saved; setVersion(r.data.version || "");
      note("");
    } catch { note("Couldn't save the comment"); }
  }, [id, version, note]);

  const toAgent = useCallback(async (cid: string) => {
    if (!id) return;
    try {
      const r = await exploreApi.toAgentAt({ source: "open", id, commentId: cid });
      if (!r.data.ok) { note(r.data.error || "Couldn't queue it"); return; }
      const next = comments.map((c) => (c.id === cid ? { ...c, for_agent: true } : c));
      setComments(next); baseRef.current = next; setVersion(r.data.version || version);
      note("Queued for an agent");
    } catch { note("Couldn't queue it"); }
  }, [id, comments, version, note]);

  const gallery = useMemo(() => list.map((f) => ({ stem: f.id, kind: "figure" as const })), [list]);

  if (!fig || !id) return null;

  const asFigure = (c: ExploreComment): FigureComment => ({
    id: c.id, x: c.x, y: c.y, w: c.w, h: c.h, body: c.body, resolved: c.resolved,
    author: c.author, created: Date.parse(c.created) || 0, updated: Date.parse(c.updated) || 0,
    reply: c.reply, for_agent: c.for_agent,
  });
  const fromFigure = (c: FigureComment): ExploreComment => {
    const was = baseRef.current.find((b) => b.id === c.id);
    const iso = new Date().toISOString().slice(0, 19);
    return {
      id: c.id, x: c.x, y: c.y, w: c.w, h: c.h, body: c.body, resolved: c.resolved,
      author: c.author || "owner", created: was?.created || iso, updated: iso,
      reply: c.reply ?? was?.reply ?? "", for_agent: c.for_agent ?? was?.for_agent ?? false,
    };
  };

  return (
    <FigureLightbox slug="" stem={id} kind="figure" gallery={gallery} onNavigate={onNavigate}
      initial={comments.map(asFigure)} onSave={(items) => void persist(items.map(fromFigure))}
      onClose={onClose} onViewFile={() => {}} imageSurface="card"
      imageSrc={previewUrl || exploreApi.renderUrl(id, theme, fig.spec.version)}
      toolbar={toolbar} onToAgent={(cid) => void toAgent(cid)}
      railOpen={railOpen} onRailOpen={onRailOpen} fit={fit} header={header}
      editPanel={fig.spec.kind === "vl" ? (
        <FigureSpecEditor target={{ source: "open", id }} spec={fig.spec} meta={fig.meta}
          theme={theme} onPreview={setPreview} onSaved={() => setTick((t) => t + 1)} />
      ) : undefined}
      sourcePanel={<SourcePanel spec={fig.spec} nRows={fig.meta?.n_rows || 0} truncated={!!fig.meta?.truncated} />} />
  );
}

/** The pending figure selection, consumed once, on the same cadence as the index poll.
 *  Returns the last one this window took, so a caller can react to it exactly once. */
export function useFigureSelection(active: boolean, ms = 2000,
  scope?: { sessions?: string[]; project?: string }) {
  const [sel, setSel] = useState<{ ts: number; source: string; id: string; slug: string; stem: string } | null>(null);
  // the scope as one string, so a fresh array each render does not restart the poll
  const scopeKey = JSON.stringify([scope?.sessions ?? [], scope?.project ?? ""]);
  useEffect(() => {
    if (!active) return;
    let live = true;
    const [sessions, project] = JSON.parse(scopeKey) as [string[], string];
    const pull = () => {
      if (document.hidden) return;
      exploreApi.selection({ sessions, project }).then((r) => {
        if (!live || !r || !r.ts) return;
        setSel({ ts: r.ts, source: r.source || "open", id: r.id || "", slug: r.slug || "", stem: r.stem || "" });
      }).catch(() => {});
    };
    pull();
    const t = window.setInterval(pull, ms);
    return () => { live = false; window.clearInterval(t); };
  }, [active, ms, scopeKey]);
  return sel;
}

/** The store index, polled while a surface that shows it is mounted and on screen. */
export function useStoreIndex(active: boolean, ms = 2000): ExploreCard[] {
  const [list, setList] = useState<ExploreCard[]>([]);
  useEffect(() => {
    if (!active) return;
    let live = true;
    const pull = () => {
      if (document.hidden) return;
      exploreApi.index().then((r) => { if (live) setList(r.figures || []); }).catch(() => {});
    };
    pull();
    const t = window.setInterval(pull, ms);
    return () => { live = false; window.clearInterval(t); };
  }, [active, ms]);
  return list;
}
