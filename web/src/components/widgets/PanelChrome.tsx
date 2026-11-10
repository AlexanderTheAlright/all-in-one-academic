
import { Component, useEffect, useMemo, type ReactNode } from "react";
import { PANEL_VIEWS, type PanelViewId } from "@/components/widgets/panel";

/** what every view needs to draw the shared header: which tab is on, how to switch,
 *  the counts beside each label and any tab with an event waiting behind the no-yank rule */
export type PanelChromeProps = {
  view: PanelViewId;
  onView: (v: PanelViewId) => void;
  counts?: Partial<Record<PanelViewId, number | null>>;
  pending?: PanelViewId[];
};

export function PanelHeader({ view, onView, counts, pending, title, titleHint, right }: PanelChromeProps & {
  title: string;
  titleHint?: string;
  /** the live dot, the follow pin — whatever the view puts at the right edge */
  right?: ReactNode;
}) {
  return (
    <div data-panel-header className="min-h-6 shrink-0 flex flex-wrap items-center gap-x-2 px-2 border-b border-border/60">
      {PANEL_VIEWS.length > 1 && (
        <div data-panel-tabs className="flex shrink-0 items-center gap-0.5 max-[600px]:gap-0">
          {PANEL_VIEWS.map((v) => {
            const on = v.id === view;
            const n = counts?.[v.id];
            const waiting = !on && !!pending?.includes(v.id);
            return (
              <button key={v.id} type="button" data-knav-item data-panel-tab={v.id}
                aria-current={on ? "page" : undefined}
                onClick={() => onView(v.id)}
                title={waiting ? v.label + " — something new is waiting" : v.label}
                className={"relative inline-flex h-5 items-center gap-1 rounded-sm px-1.5 max-[600px]:px-1 text-[10px] font-medium leading-none outline-none "
                  + (on ? "text-foreground" : "text-muted-foreground hover:text-foreground")}>
                <span>{v.label}</span>
                {typeof n === "number" && <span className="nums text-[9px] text-muted-foreground">{n.toLocaleString("en-US")}</span>}
                {on && <span className="pointer-events-none absolute inset-x-1 bottom-0 h-[1.5px] rounded-full bg-primary" />}
                {waiting && <span data-panel-tab-dot
                  className="pointer-events-none absolute right-0 top-0 h-[5px] w-[5px] rounded-full bg-primary ring-1 ring-background" />}
              </button>
            );
          })}
        </div>
      )}
      <span data-panel-title className="min-w-0 flex-1 whitespace-normal break-all text-[11px] font-medium leading-[1.25]"
        title={titleHint || title}>
        {title === PANEL_VIEWS.find((v) => v.id === view)?.label ? "" : title}</span>
      {right}
    </div>
  );
}

/** A view that throws draws one line instead of taking the window down with it
 *  (the nearest boundary would otherwise be the app's). */
export class PanelBoundary extends Component<{ what: string; children: ReactNode }, { err: boolean }> {
  state = { err: false };
  static getDerivedStateFromError() { return { err: true }; }
  render() {
    if (!this.state.err) return this.props.children;
    return (
      <div data-panel-error className="flex h-full items-center justify-center px-3 text-center text-[11.5px] text-muted-foreground">
        {this.props.what} didn't load
      </div>
    );
  }
}

/** the one-line empty state a malformed, absent or ok:false answer degrades to */
export function PanelEmpty({ children }: { children: ReactNode }) {
  return (
    <div data-panel-empty className="flex h-full items-center justify-center px-3 text-center text-[11.5px] text-muted-foreground">
      {children}
    </div>
  );
}

const FIELD = new Set(["INPUT", "TEXTAREA", "SELECT"]);

export function useLeftToTabs() {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.key !== "ArrowLeft" || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      const a = document.activeElement as HTMLElement | null;
      if (!a || FIELD.has(a.tagName) || a.isContentEditable) return;
      if (!a.closest("[data-panel-body]")) return;
      const tabs = document.querySelector<HTMLElement>("[data-panel-tabs]");
      if (!tabs) return;
      const box = a.getBoundingClientRect();
      const body = a.closest("[data-panel-body]") as HTMLElement;
      const left = Array.from(body.querySelectorAll<HTMLElement>("[data-knav-item]")).some((el) => {
        if (el === a || el.contains(a)) return false;
        const b = el.getBoundingClientRect();
        return b.width > 0 && b.right <= box.left + 1 && b.bottom > box.top + 1 && b.top < box.bottom - 1;
      });
      if (left) return;
      const tab = tabs.querySelector<HTMLElement>("[data-panel-tab][aria-current]") || tabs.querySelector<HTMLElement>("[data-panel-tab]");
      if (!tab) return;
      e.preventDefault();
      document.documentElement.setAttribute("data-knav", "");
      tab.focus({ preventScroll: true });
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);
}

/** `[` and `]`: the previous / next item of whatever a detail view is standing in.
 *  arrownav owns neither key, the same way it owns neither Home nor End. */
export function useBracketStep(step: ((d: -1 | 1) => void) | null) {
  useEffect(() => {
    if (!step) return;
    const h = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key !== "[" && e.key !== "]") return;
      const a = document.activeElement as HTMLElement | null;
      if (a && (FIELD.has(a.tagName) || a.isContentEditable)) return;
      e.preventDefault();
      step(e.key === "]" ? 1 : -1);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [step]);
}

/** Home / End over a list's own stops. */
export function useHomeEnd(selector: string) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.defaultPrevented || (e.key !== "Home" && e.key !== "End")) return;
      const a = document.activeElement as HTMLElement | null;
      if (a && (FIELD.has(a.tagName) || a.isContentEditable)) return;
      const els = document.querySelectorAll<HTMLElement>(selector);
      if (!els.length) return;
      e.preventDefault();
      const el = e.key === "Home" ? els[0] : els[els.length - 1];
      document.documentElement.setAttribute("data-knav", "");
      el.focus({ preventScroll: false });
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [selector]);
}

/** the query's tokens marked inside a piece of text, themed (index.css `mark`) */
export function Hi({ text, q }: { text: string; q: string[] }) {
  const parts = useMemo(() => {
    if (!text || !q.length) return null;
    const low = text.toLowerCase();
    const spans: [number, number][] = [];
    for (const t of q) {
      let i = low.indexOf(t);
      while (i >= 0) { spans.push([i, i + t.length]); i = low.indexOf(t, i + t.length); }
    }
    if (!spans.length) return null;
    spans.sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [];
    for (const s of spans) {
      const last = merged[merged.length - 1];
      if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
      else merged.push([s[0], s[1]]);
    }
    const out: { t: string; on: boolean }[] = [];
    let at = 0;
    for (const [a, b] of merged) {
      if (a > at) out.push({ t: text.slice(at, a), on: false });
      out.push({ t: text.slice(a, b), on: true });
      at = b;
    }
    if (at < text.length) out.push({ t: text.slice(at), on: false });
    return out;
  }, [text, q]);
  if (!parts) return <>{text}</>;
  return (
    <>{parts.map((p, i) => (p.on
      ? <mark key={i} className="rounded-[2px] bg-primary/25 px-[1px] text-foreground">{p.t}</mark>
      : <span key={i}>{p.t}</span>))}</>
  );
}
