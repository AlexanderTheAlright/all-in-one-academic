
import { Component, type ErrorInfo, type ReactNode } from "react";
import { useApi } from "@/lib/hooks";
import { api } from "@/lib/api";
import { Markdown } from "@/lib/markdown";
import { cn } from "@/lib/utils";

class PreviewBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(err: Error, info: ErrorInfo) {
    if (typeof console !== "undefined") console.error("[NotePreview]", err, info.componentStack);
  }
  render() {
    if (this.state.failed) return <div className="text-[12.5px] text-muted-foreground">This note could not be previewed.</div>;
    return this.props.children;
  }
}

type PreviewProps = { path: string | null; title?: string; meta?: ReactNode; className?: string };

export function NotePreview(props: PreviewProps) {
  return <PreviewBoundary><PreviewInner {...props} /></PreviewBoundary>;
}

function PreviewInner({ path, title, meta, className }: PreviewProps) {
  const r = useApi(() => (path ? api.noteRead(path) : Promise.resolve(null)), [path], 0);
  const d = r.data && r.data.ok !== false && r.data.path === path ? r.data : null;
  // a row whose file is gone (or unreadable) settles on a quiet line, never an endless "loading"
  const failed = !d && (!!r.error || (!!r.data && r.data.ok === false));
  // the title rides the header, so the note's own first H1 does not repeat under it
  const body = (d?.body || "").replace(/^---\n[\s\S]*?\n---\n?/, "").replace(/^\s*# [^\n]*\n/, "").trim();
  // `tags` is guaranteed an array by api.noteRead, which normalises at the transport
  // boundary — see the note there for why this mattered far away from this file.
  const tags = (d?.tags || []).filter((t) => t && t !== "accessed-status").slice(0, 8);
  return (
    <aside aria-label="Preview" className={cn("min-h-0 min-w-0 flex flex-col rounded-xl border border-border bg-card/40 overflow-hidden", className)}>
      <div className="shrink-0 px-5 pt-4 pb-3 border-b border-border/50">
        <div className="text-[10.5px] uppercase tracking-[0.1em] font-semibold text-muted-foreground/70">Preview</div>
        <div className="mt-1 text-[15px] font-medium leading-snug line-clamp-2 break-words" title={d?.title || title}>{d?.title || title || ""}</div>
        {meta && <div className="mt-1 text-[11.5px] text-muted-foreground nums truncate">{meta}</div>}
        {tags.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1 max-h-[46px] overflow-hidden">
            {tags.map((t) => (
              <span key={t} className="text-[10.5px] px-1.5 py-0.5 rounded bg-secondary/70 text-muted-foreground">{t}</span>
            ))}
          </div>
        )}
      </div>
      {/* read-only prose: never a stop (Enter on the list row opens the note itself) */}
      <div data-knav-skip className="flex-1 min-h-0 overflow-y-auto tinybar px-5 py-4 break-words">
        {!path ? null
          : failed ? <div className="text-[12.5px] text-muted-foreground" title={path}>No note to preview.</div>
          : !d ? <div className="text-[12.5px] text-muted-foreground">loading…</div>
          : <Markdown text={body} className="text-[13.5px] leading-[1.7] text-foreground/85" />}
      </div>
    </aside>
  );
}
