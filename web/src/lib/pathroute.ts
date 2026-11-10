
export const WIDGETS = ["tasks", "journal", "timer", "capture", "now", "figure", "diagram", "diagrams", "note"] as const;
export type WidgetName = (typeof WIDGETS)[number];

export const VIEWS = ["today", "learning", "systems",
  "calendar", "drafting", "reading", "library", "notes", "insights"] as const;

export type PathRoute = { kind: "view"; name: string } | { kind: "widget"; name: WidgetName };

export const FIGURE_SESSION_PATH = /^\/w\/figure\/s\/([A-Za-z0-9._-]{1,96})\/?$/;

/** the session named in the pane's path, or "" */
export function pathSession(): string {
  try { return FIGURE_SESSION_PATH.exec(window.location.pathname)?.[1] ?? ""; } catch { return ""; }
}

export const DIAGRAM_PATH = /^\/w\/diagram\/([to])\/([A-Za-z0-9][A-Za-z0-9_-]{0,79})\/?$/;

/** a template or diagram name as it appears in a path, and as two names are compared */
export function diagramSlug(name: string): string {
  return name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

/** what this window's path asks the drawer for, or null */
export function pathDiagram(): { kind: "template" | "open"; name: string } | null {
  try {
    const m = DIAGRAM_PATH.exec(window.location.pathname);
    return m ? { kind: m[1] === "t" ? "template" : "open", name: m[2] } : null;
  } catch { return null; }
}

function read(): PathRoute | null {
  if (FIGURE_SESSION_PATH.test(window.location.pathname)) return { kind: "widget", name: "figure" };
  if (DIAGRAM_PATH.test(window.location.pathname)) return { kind: "widget", name: "diagram" };
  const m = /^\/([vw])\/([a-z]+)\/?$/.exec(window.location.pathname);
  if (!m) return null;
  const name = m[2];
  if (m[1] === "v") return (VIEWS as readonly string[]).includes(name) ? { kind: "view", name } : null;
  return (WIDGETS as readonly string[]).includes(name) ? { kind: "widget", name: name as WidgetName } : null;
}

export const pathRoute: PathRoute | null = read();
