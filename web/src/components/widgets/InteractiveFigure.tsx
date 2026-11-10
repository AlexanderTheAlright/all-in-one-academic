
import { useEffect, useRef } from "react";
import { ArrowLeft, Boxes } from "lucide-react";
import type { GalleryFigure } from "@/lib/api";
import { ago as agoOf, type PaneSize } from "@/components/widgets/panel";
import { useBracketStep } from "@/components/widgets/PanelChrome";

export function InteractiveFigure({ fig, onBack, step, size }: {
  fig: GalleryFigure;
  onBack: () => void;
  /** `[` / `]` across the gallery, figure kinds included */
  step?: (d: -1 | 1) => void;
  size: PaneSize;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const back = useRef<HTMLButtonElement>(null);

  // the back button, not the frame: Esc has to work the instant the figure opens
  useEffect(() => {
    document.documentElement.setAttribute("data-knav", "");
    back.current?.focus({ preventScroll: true });
  }, [fig.url]);

  useEffect(() => {
    const h = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      const d = e.data as { type?: unknown } | null;
      if (d && typeof d === "object" && d.type === "all_in_one_academic-figure-escape") onBack();
    };
    window.addEventListener("message", h);
    return () => window.removeEventListener("message", h);
  }, [onBack]);

  useBracketStep(step ?? null);

  const meta = size !== "xs" && size !== "sm";
  return (
    <div data-interactive-detail={fig.name}
      className="h-screen flex flex-col bg-background text-foreground">
      <div data-panel-header className="h-6 shrink-0 flex items-center gap-1.5 px-2 border-b border-border/60">
        <button ref={back} type="button" data-knav-back data-qa="interactive-back" onClick={onBack}
          title="Back to the figures (Esc)" aria-label="Back to the figures"
          className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground outline-none hover:bg-accent hover:text-foreground">
          <ArrowLeft size={12} />
        </button>
        <span data-interactive-name className="min-w-0 flex-1 truncate text-[11px] font-medium"
          title={[fig.name, fig.rel, agoOf(fig.mtime)].filter(Boolean).join(" · ")}>{fig.name}</span>
        <span data-interactive-chip
          title="A self-contained plotly page — 3D and WebGL, in a sandboxed frame"
          className="inline-flex shrink-0 items-center gap-1 rounded-[3px] bg-primary/85 px-1 py-[1px] text-[8px] font-medium uppercase leading-none tracking-[0.06em] text-primary-foreground">
          <Boxes size={9} />3D/interactive
        </span>
        {meta && <span className="nums shrink-0 text-[9px] text-muted-foreground">{agoOf(fig.mtime)}</span>}
      </div>

      <div data-panel-body className="min-h-0 flex-1 overflow-hidden bg-white">
        <iframe ref={frame} data-interactive-frame={fig.name} key={fig.url} src={fig.url}
          title={fig.name}
          sandbox="allow-scripts" referrerPolicy="no-referrer" loading="eager"
          className="block h-full w-full border-0" />
      </div>
    </div>
  );
}
