
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { clearWidgetFocus, exitWidgetFull } from "@/lib/arrownav";

export type WidgetSize = "xs" | "sm" | "md" | "lg" | "xl";
export type WidgetState = {
  id: string; title: string; size: WidgetSize;
  width: number; height: number; tall: boolean;
  /** true while its focused view fills the page */
  focused: boolean;
  /** the frame element, so a widget can declare its full page from inside (useFullPage) */
  frame: HTMLElement | null;
};

const sizeOf = (w: number): WidgetSize => (w < 380 ? "xs" : w < 600 ? "sm" : w < 900 ? "md" : w < 1300 ? "lg" : "xl");

const Ctx = createContext<WidgetState | null>(null);

/** where this component is being drawn; null outside any widget (render as before) */
export const useWidget = () => useContext(Ctx);

export function useFullPage(open?: () => void) {
  const w = useWidget();
  const frame = w?.frame ?? null;
  const fn = useRef(open);
  fn.current = open;
  useEffect(() => {
    if (!frame) return;
    frame.setAttribute("data-knav-full", open ? "own" : "page");
    const on = () => fn.current?.();
    frame.addEventListener("knav:full", on);
    return () => { frame.removeAttribute("data-knav-full"); frame.removeEventListener("knav:full", on); };
  }, [frame, !open]);   // eslint-disable-line react-hooks/exhaustive-deps
}

/** how many rows a list should show at this size (focused views show them all) */
export function rowCap(w: WidgetState | null, tile: number, roomy = tile * 2): number {
  if (!w) return tile;
  if (w.focused) return Infinity;
  return w.size === "lg" || w.size === "xl" ? roomy : tile;
}

export function WidgetFrame({ id, title, className, style, children, as = "section" }: {
  id: string; title: string; className?: string; style?: CSSProperties; children: ReactNode;
  as?: "section" | "div";
}) {
  const ref = useRef<HTMLElement | null>(null);
  const [frame, setFrame] = useState<HTMLElement | null>(null);
  // one stable ref callback: an inline one would re-run on every render
  const hold = useCallback((el: HTMLElement | null) => { ref.current = el; setFrame(el); }, []);
  const [dims, setDims] = useState({ w: 0, h: 0 });
  const [focused, setFocused] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => {
      const r = el.getBoundingClientRect();
      setDims((d) => (Math.abs(d.w - r.width) < 1 && Math.abs(d.h - r.height) < 1 ? d : { w: r.width, h: r.height }));
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const on = (e: Event) => setFocused(!!(e as CustomEvent<{ focused: boolean }>).detail?.focused);
    el.addEventListener("knav:focus", on);
    return () => el.removeEventListener("knav:focus", on);
  }, []);

  // the close control does what Escape does where you stand: out of the full page back
  // to the focused view, else out of the focused view onto the tile
  const back = () => {
    if (document.documentElement.hasAttribute("data-knav-full") && exitWidgetFull()) {
      document.documentElement.setAttribute("data-knav", "");
      return;
    }
    const el = ref.current;
    clearWidgetFocus();
    if (!el) return;
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
    document.documentElement.setAttribute("data-knav", "");
  };

  const size = sizeOf(dims.w || 900);
  const state: WidgetState = { id, title, size, width: dims.w, height: dims.h, tall: dims.h > dims.w * 1.2, focused, frame };
  const Tag = as;
  return (
    <Ctx.Provider value={state}>
      <Tag
        ref={hold as never}
        data-knav-widget={id}
        data-knav-title={title}
        data-size={size}
        data-focused={focused ? "" : undefined}
        tabIndex={-1}
        aria-label={title}
        className={cn("group/widget relative min-w-0", className)}
        // focused: the top gutter is at least a header strip tall, so the close control never covers the widget
        style={focused ? { ...style, paddingTop: "max(clamp(10px, 2vw, 32px), 32px)" } : style}
      >
        {children}
        {focused && (
          <button type="button" onClick={back} data-widget-close="" data-knav-last=""
            title="Back (Esc)" aria-label="Back"
            className="fixed z-10 inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            style={{
              top: "calc(var(--knav-main-top) + 4px)",
              left: "calc(var(--knav-main-left) + var(--knav-main-width) - clamp(10px, 2vw, 32px) - 24px)",
            }}>
            <X size={15} />
          </button>
        )}
      </Tag>
    </Ctx.Provider>
  );
}
