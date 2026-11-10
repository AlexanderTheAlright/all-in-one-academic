
import type { WidgetName } from "@/lib/pathroute";

/** A marker string kept in the built bundle. */
export const KEYS_MARKER = "board-keys-b3";

export const PREFIX_MS = 1500;

/** `g <letter>` → view. */
export const VIEW_KEYS: Record<string, string> = {
  t: "today",
  c: "calendar",
  d: "drafting",
  r: "reading",
  l: "library",
  n: "notes",
  i: "insights",
  f: "learning",
  s: "systems",
  p: "calendar",
  m: "calendar",
};

export const WIDGET_KEYS: Record<string, WidgetName> = {
  t: "tasks",
  j: "journal",
  c: "capture",
  n: "now",
  s: "timer",
  d: "diagram",
  v: "diagrams",
  w: "note",       // write
};

/** Which full view a widget belongs to — `g f` / Shift+Enter from the widget. */
export const WIDGET_FULL: Record<WidgetName, string> = {
  tasks: "today",
  journal: "today",
  now: "calendar",
  capture: "notes",
  timer: "today",
  figure: "drafting",
  diagram: "notes",
  diagrams: "notes",
  note: "notes",
};

/** Which widget a full view falls back to for `g g` when this window did not
 *  come from one. */
export const VIEW_WIDGET: Record<string, WidgetName> = {
  today: "tasks",
  calendar: "now",
  notes: "capture",
};

export const VIEW_LABEL: Record<string, string> = {
  today: "Today",
  calendar: "Calendar",
  drafting: "Drafting",
  reading: "Reading",
  library: "Library",
  notes: "Notes",
  insights: "Insights",
  learning: "Learning",
  systems: "Systems",
};

export const WIDGET_LABEL: Record<WidgetName, string> = {
  tasks: "Tasks",
  journal: "Journal",
  capture: "Quick capture",
  now: "Now",
  timer: "Timer",
  figure: "Figure",
  diagram: "New diagram",
  diagrams: "Diagrams",
  note: "Note",
};

export type EditorChoice = "obsidian" | "nvim";
export const EDITOR_PREF_KEY = "board-editor";
export const EDITOR_LABEL: Record<EditorChoice, string> = { obsidian: "Obsidian", nvim: "Neovim" };
export function editorChoice(): EditorChoice {
  try { return JSON.parse(localStorage.getItem(EDITOR_PREF_KEY) || "null") === "nvim" ? "nvim" : "obsidian"; }
  catch { return "obsidian"; }
}
export function setEditorChoice(v: EditorChoice): void {
  try { localStorage.setItem(EDITOR_PREF_KEY, JSON.stringify(v)); } catch { /* private mode */ }
}

export type KeyRow = { keys: string; what: string };
export type KeyGroup = { title: string; rows: KeyRow[] };

/* Views in the order the sidebar lists them, so the sheet reads like the nav. */
const VIEW_ORDER = ["t", "c", "d", "r", "l", "n", "i", "f", "s"];

export const KEY_GROUPS: KeyGroup[] = [
  {
    title: "Go to a view — g then",
    rows: VIEW_ORDER.map((k) => ({ keys: `g ${k}`, what: VIEW_LABEL[VIEW_KEYS[k]] })),
  },
  {
    title: "Widgets — w then",
    rows: Object.entries(WIDGET_KEYS).map(([k, w]) => ({
      keys: `w ${k}`, what: `${WIDGET_LABEL[w]} widget`,
    })).concat([{ keys: "Ctrl w …", what: "…in a new window" }]),
  },
  {
    title: "Widget ↔ full view",
    rows: [
      { keys: "g f", what: "This widget's full view, in this window" },
      { keys: "Shift ⏎", what: "Same, when nothing is focused" },
      { keys: "Ctrl Shift ⏎", what: "Full view in a new window, widget stays" },
      { keys: "g g", what: "Back to the widget this window came from" },
    ],
  },
  {
    title: "Move anywhere",
    rows: [
      { keys: "↑ ↓", what: "Move · on the menu, a glimpse of each view" },
      { keys: "→", what: "Open the view · step into a row's controls" },
      { keys: "⏎", what: "Open or press · a widget opens its focused view · start typing" },
      { keys: "⏎ ⏎", what: "A note bucket's full page — ⏎ again on the clearing, evening or capture box" },
      { keys: "Space", what: "Work inside a widget where it stands" },
      { keys: "←", what: "Move left, or up a level — ← ← always reaches the menu" },
      { keys: "Esc", what: "Stop typing · up a level · back to the menu" },
      { keys: "j k", what: "Next / previous item in a list" },
      { keys: "o", what: "Open the focused reading or note in Obsidian" },
      { keys: "e", what: "Open the focused manuscript or note in your editor · Ctrl k chooses Obsidian or Neovim" },
    ],
  },
  {
    title: "Global",
    rows: [
      { keys: "Ctrl s", what: "Save what you are writing, now" },
      { keys: "Ctrl k", what: "Command palette — search and go" },
      { keys: "/", what: "Command palette" },
      { keys: "Ctrl Shift f", what: "Tag explorer" },
      { keys: "?", what: "This sheet" },
      { keys: "Esc", what: "Back from a board · close a widget window" },
    ],
  },
  {
    title: "On a board (kanban)",
    rows: [
      { keys: "j k", what: "Move focus within a lane" },
      { keys: "h l", what: "Move focus across lanes" },
      { keys: "x", what: "Toggle done" },
      { keys: "e  ⏎", what: "Edit focused card" },
      { keys: "Space", what: "Pick up the card to move it · Space again drops, Esc cancels" },
      { keys: "c", what: "Cycle priority" },
      { keys: "n", what: "New card in lane" },
      { keys: "[ ]", what: "Shift card to prev / next lane" },
    ],
  },
  {
    title: "In the manuscript editor",
    rows: [
      { keys: "Alt ⏎", what: "Follow the citation at the caret to its source · on :page, the PDF at that page" },
    ],
  },
  {
    title: "In the figure viewer",
    rows: [
      { keys: "r", what: "Flag a region by keyboard" },
      { keys: "← ↑ ↓ →", what: "Move the region" },
      { keys: "Shift ← ↑ ↓ →", what: "Resize the region" },
      { keys: "⏎", what: "Pin a comment on the region" },
      { keys: "Ctrl ⏎", what: "Add the comment" },
      { keys: "Esc", what: "Cancel the region · close the viewer" },
      { keys: "← →", what: "Previous / next result" },
      { keys: "x", what: "On the IDE pane's figure grid: Results ⇄ Exploration" },
    ],
  },
  {
    title: "In the notes map",
    rows: [
      { keys: "⏎", what: "On the map: take the keys · on a note: its thread · on a family: dive in" },
      { keys: "← ↑ ↓ →", what: "Pan · Shift pans further" },
      { keys: "+ −", what: "Zoom around the centre" },
      { keys: "0  f", what: "Fit the map" },
      { keys: "Tab  Shift Tab", what: "Next / previous node, nearest the centre first" },
      { keys: "[ ]", what: "Previous / next node in family order" },
      { keys: "Space", what: "Read the note · dive into a family" },
      { keys: "o", what: "Open the note in Obsidian" },
      { keys: "⌫", what: "Back out of the thread, then the family" },
      { keys: "Esc", what: "Leave the thread · give the keys back" },
    ],
  },
];
