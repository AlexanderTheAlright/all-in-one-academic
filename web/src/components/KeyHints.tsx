
import { useEffect, useState } from "react";
import { EDITOR_LABEL, editorChoice } from "@/lib/keymap";

const HINTS: Record<string, [string, string][]> = {
  rail:    [["↑↓", "views"], ["→", "open"], ["?", "all keys"]],
  page:    [["↑↓←→", "move"], ["⏎", "open"], ["esc", "menu"]],
  tile:    [["↑↓←→", "widgets"], ["⏎", "focus"], ["space", "work here"], ["esc", "menu"]],
  inside:  [["↑↓←→", "move"], ["⏎", "select"], ["esc", "widget"]],
  focused: [["↑↓←→", "move"], ["⏎", "select"], ["esc", "back"]],
  // a note bucket's full page; the strip is covered there, but the level is real
  full:    [["↑↓←→", "move"], ["⏎", "select"], ["esc", "back"]],
  overlay: [["↑↓←→", "move"], ["⏎", "select"], ["esc", "close"]],
  // the notes map while it holds the keys (NotesGraph stamps html[data-knav-map])
  map:     [["↑↓←→", "pan"], ["+ −", "zoom"], ["0", "fit"], ["tab [ ]", "node"], ["⏎", "focus"], ["space", "read"], ["o", "open"], ["⌫", "back"], ["esc", "leave"]],
};

export function KeyHints() {
  const [st, setSt] = useState({ on: false, level: "page", title: "", obsidian: false, canFull: false, map: false, editor: editorChoice() });
  useEffect(() => {
    const html = document.documentElement;
    const read = () => setSt({
      on: html.hasAttribute("data-knav"),
      level: html.getAttribute("data-knav-level") || "page",
      title: html.getAttribute("data-knav-title") || "",
      obsidian: html.hasAttribute("data-knav-obsidian"),
      // ⏎ here would open this bucket's full page (arrownav stamps it on the item only)
      canFull: html.hasAttribute("data-knav-canfull"),
      map: html.hasAttribute("data-knav-map"),
      // `e` opens the row in the editor picked in the palette (board-editor)
      editor: editorChoice(),
    });
    read();
    const mo = new MutationObserver(read);
    mo.observe(html, { attributes: true, attributeFilter: ["data-knav", "data-knav-level", "data-knav-title", "data-knav-obsidian", "data-knav-canfull", "data-knav-map"] });
    window.addEventListener("storage", read);   // changed from another Board window
    return () => { mo.disconnect(); window.removeEventListener("storage", read); };
  }, []);
  if (!st.on) return null;
  // a widget that holds the keys itself (the notes map) shows its own
  const level = st.map ? "map" : st.level;
  const inWidget = level === "tile" || level === "inside" || level === "focused" || level === "full" || level === "map";
  return (
    <div aria-hidden data-knav-skip
      // on the menu the 212px panel floats over the strip's start: begin past it
      className={"flex h-7 shrink-0 items-center gap-4 overflow-hidden whitespace-nowrap border-t border-border bg-card/80 pr-3 text-[11px] text-muted-foreground print:hidden "
        + (level === "rail" ? "pl-[164px]" : "pl-3")}>
      {inWidget && st.title && <span className="max-w-[40%] truncate font-medium text-foreground">{st.title}</span>}
      {[...(HINTS[level] || HINTS.page).map(([k, what]) => (st.canFull && k === "⏎" ? ["⏎", "full page"] as [string, string] : [k, what] as [string, string])),
        ...(st.obsidian && !st.map ? [["o", "obsidian"], ["e", EDITOR_LABEL[st.editor].toLowerCase()]] as [string, string][] : [])].map(([k, what]) => (
        <span key={k} className="flex shrink-0 items-center gap-1.5">
          <kbd className="rounded border border-border bg-secondary px-1.5 py-px text-[10px] font-medium text-secondary-foreground">{k}</kbd>
          {what}
        </span>
      ))}
    </div>
  );
}
