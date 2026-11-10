
import type { Tree, TreeDomain } from "@/lib/systems";

/** the Board views a subsystem may open; each maps to a plain Route in App.tsx */
export const SYSTEM_APPS = ["learning", "reading", "calendar", "notes"] as const;
export type SystemApp = (typeof SYSTEM_APPS)[number];
export const appOf = (d: TreeDomain): SystemApp | null =>
  (SYSTEM_APPS as readonly string[]).includes(d.app ?? "") ? (d.app as SystemApp) : null;

export type Sel = { domain: string; instance: string; component: string };

const byId = (t: Tree, id: string | null | undefined) => (id ? t.domains.find((d) => d.id === id) : undefined);

/** a parent that is missing or itself a subsystem counts as none */
const parentOf = (t: Tree, d: TreeDomain) => {
  const p = byId(t, d.parent);
  return p && !p.parent && p.id !== d.id ? p : undefined;
};

export const topSystems = (t: Tree) => t.domains.filter((d) => !parentOf(t, d));

export const subsystemsOf = (t: Tree, id: string) => t.domains.filter((d) => d.id !== id && parentOf(t, d)?.id === id);

/** the top-level system a domain belongs to (itself when it is one) */
export const systemOf = (t: Tree, d: TreeDomain): TreeDomain => parentOf(t, d) ?? d;

export const isLauncher = (d: TreeDomain) => !!appOf(d);
export const hasContent = (d: TreeDomain) => d.instances.some((i) => i.components.length > 0);

/** a system selected with no places of its own but with subsystems shows the list of them */
export const isLanding = (t: Tree, d: TreeDomain | undefined) =>
  !!d && !d.parent && d.instances.length === 0 && subsystemsOf(t, d.id).length > 0;

/** the domain's own current place (or first), then its first component */
export function placeSel(d: TreeDomain): Sel {
  const inst = d.instances.find((i) => i.id === d.current) ?? d.instances[0];
  return { domain: d.id, instance: inst?.id ?? "", component: inst?.components[0]?.id ?? "" };
}

/** where picking a system lands: its own places; else its first selectable subsystem with
 * content; else (all launchers, or nothing drawn yet) its own list of subsystems */
export function landOn(t: Tree, d: TreeDomain): Sel {
  if (d.instances.length || !subsystemsOf(t, d.id).length) return placeSel(d);
  const sub = subsystemsOf(t, d.id).find((s) => !isLauncher(s) && hasContent(s));
  return sub ? placeSel(sub) : { domain: d.id, instance: "", component: "" };
}

/** the domain a stored selection stands for: itself; a launcher's system; an old client-built
 * id with a colon -> the system before the colon; else nothing */
export function storedDomain(t: Tree, id: string | undefined): TreeDomain | undefined {
  if (!id) return undefined;
  const d = byId(t, id);
  if (d) return isLauncher(d) ? systemOf(t, d) : d;
  const head = id.includes(":") ? byId(t, id.split(":")[0]) : undefined;
  return head ? systemOf(t, head) : undefined;
}

export const groupOf = (d: TreeDomain): string => {
  const app = appOf(d);
  return app && d.course ? app[0].toUpperCase() + app.slice(1) : "";
};
