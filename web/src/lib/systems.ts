

export type Hygiene = "valuables" | "clean" | "wet/used" | "gear";
export const HYGIENE: Hygiene[] = ["valuables", "clean", "wet/used", "gear"];
export type PStatus = "idea" | "chosen" | "bought" | "in use" | "dropped";
export const PSTATUS: PStatus[] = ["idea", "chosen", "bought", "in use", "dropped"];
export type FitState = "fits" | "too wide" | "too tall" | "too deep" | "unknown";

export type Dim = { cm: number; estimated: boolean; source?: string };
export type Size = { w: Dim; d: Dim; h: Dim };
export type Zone = { id: string; name: string; kind: "space" | "hook"; x: Dim; y: Dim; w?: Dim; h?: Dim; d?: Dim; note?: string };
export type SysItem = { id: string; name: string; zone: string; hygiene: Hygiene; size?: Size; note?: string };
export type Step = { id: string; name: string; items: string[]; note?: string };
export type Routine = { id: string; name: string; steps: Step[] };
export type Fit = { state: FitState; rotated: boolean; against: { w: number; d: number; h: number } | null };
export type Proposal = {
  id: string; name: string; kind: "product" | "carry"; status: PStatus; zone: string;
  link?: string; price?: number; size?: Size; carries?: string[]; holds?: string[]; note?: string; fit?: Fit;
};
export type Component = {
  id: string; name: string; dims: Size | null; photo?: string; note?: string;
  zones: Zone[]; items: SysItem[]; routines: Routine[]; proposals: Proposal[];
};
export type ComponentResp = { domain: string; instance: { id: string; name: string; status: string }; component: Component };
export type TreeInstance = { id: string; name: string; status: string; created?: string | null; archived?: string | null; components: { id: string; name: string }[] };
export type TreeDomain = {
  id: string; name: string; current: string | null; instances: TreeInstance[];
  parent?: string | null; app?: string | null; course?: string | null;
};
export type Tree = { domains: TreeDomain[] };
export type Ref = { domain: string; instance: string; component: string };

const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);
const dim = (v: unknown): Dim | undefined => {
  if (v && typeof v === "object" && typeof (v as Dim).cm === "number" && isFinite((v as Dim).cm))
    return { cm: (v as Dim).cm, estimated: (v as Dim).estimated !== false,
      ...(typeof (v as Dim).source === "string" && (v as Dim).source ? { source: (v as Dim).source } : {}) };
  return undefined;
};
const size = (v: unknown): Size | undefined => {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const w = dim(o.w), d = dim(o.d), h = dim(o.h);
  return w && d && h ? { w, d, h } : undefined;
};

export function normTree(v: unknown): Tree {
  const doms = arr<Record<string, unknown>>((v as Tree | null)?.domains);
  return {
    domains: doms.filter((d) => d && typeof d.id === "string").map((d) => ({
      id: d.id as string, name: str(d.name, d.id as string), current: typeof d.current === "string" ? d.current : null,
      parent: str(d.parent) || null, app: str(d.app) || null, course: str(d.course) || null,
      instances: arr<Record<string, unknown>>(d.instances).filter((i) => i && typeof i.id === "string").map((i) => ({
        id: i.id as string, name: str(i.name, i.id as string), status: str(i.status, "current"),
        created: typeof i.created === "string" ? i.created : null,
        archived: typeof i.archived === "string" ? i.archived : null,
        components: arr<Record<string, unknown>>(i.components).filter((c) => c && typeof c.id === "string")
          .map((c) => ({ id: c.id as string, name: str(c.name, c.id as string) })),
      })),
    })),
  };
}

export function normComponent(v: unknown): ComponentResp | null {
  const r = v as Record<string, unknown> | null;
  const c = r?.component as Record<string, unknown> | undefined;
  if (!r || !c || typeof c.id !== "string") return null;
  const inst = (r.instance || {}) as Record<string, unknown>;
  const zones: Zone[] = arr<Record<string, unknown>>(c.zones).filter((z) => z && typeof z.id === "string" && dim(z.x) && dim(z.y))
    .map((z) => ({
      id: z.id as string, name: str(z.name, z.id as string), kind: z.kind === "hook" ? "hook" : "space",
      x: dim(z.x)!, y: dim(z.y)!, w: dim(z.w), h: dim(z.h), d: dim(z.d), note: str(z.note) || undefined,
    }));
  return {
    domain: str(r.domain),
    instance: { id: str(inst.id), name: str(inst.name), status: str(inst.status, "current") },
    component: {
      id: c.id, name: str(c.name, c.id), dims: size(c.dims) ?? null,
      photo: str(c.photo) || undefined, note: str(c.note) || undefined, zones,
      items: arr<Record<string, unknown>>(c.items).filter((i) => i && typeof i.id === "string").map((i) => ({
        id: i.id as string, name: str(i.name, i.id as string), zone: str(i.zone),
        hygiene: (HYGIENE as string[]).includes(i.hygiene as string) ? (i.hygiene as Hygiene) : "gear",
        size: size(i.size), note: str(i.note) || undefined,
      })),
      routines: arr<Record<string, unknown>>(c.routines).filter((x) => x && typeof x.id === "string").map((x) => ({
        id: x.id as string, name: str(x.name, x.id as string),
        steps: arr<Record<string, unknown>>(x.steps).filter((s) => s && typeof s.id === "string").map((s) => ({
          id: s.id as string, name: str(s.name), items: arr<unknown>(s.items).filter((i): i is string => typeof i === "string"),
          note: str(s.note) || undefined,
        })),
      })),
      proposals: arr<Record<string, unknown>>(c.proposals).filter((p) => p && typeof p.id === "string").map((p) => {
        const f = p.fit as Record<string, unknown> | undefined;
        return {
          id: p.id as string, name: str(p.name, p.id as string), kind: p.kind === "carry" ? "carry" : "product",
          status: (PSTATUS as string[]).includes(p.status as string) ? (p.status as PStatus) : "idea",
          zone: str(p.zone), link: str(p.link) || undefined,
          price: typeof p.price === "number" ? p.price : undefined, size: size(p.size),
          carries: arr<unknown>(p.carries).filter((x): x is string => typeof x === "string"),
          holds: arr<unknown>(p.holds).filter((x): x is string => typeof x === "string"),
          note: str(p.note) || undefined,
          fit: f ? { state: (str(f.state, "unknown") as FitState), rotated: f.rotated === true,
            against: (f.against as Fit["against"]) ?? null } : undefined,
        } as Proposal;
      }),
    },
  };
}

const GET = async (p: string): Promise<unknown> => {
  const r = await fetch(p);
  if (!r.ok) throw new Error(`GET ${p.split("?")[0]} failed (${r.status})`);
  return r.json();
};
const POST = async (path: string, body: unknown): Promise<unknown> => {
  const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((d as { error?: string }).error || "request failed");
  return d;
};
const q = (r: Ref) =>
  `domain=${encodeURIComponent(r.domain)}&instance=${encodeURIComponent(r.instance)}&component=${encodeURIComponent(r.component)}`;
const comp = async (p: Promise<unknown>) => {
  const c = normComponent(await p);
  if (!c) throw new Error("unexpected reply");
  return c;
};

export type Op = "upsert" | "delete";
export const systemsApi = {
  tree: async () => normTree(await GET("/systems/tree")),
  component: (r: Ref) => comp(GET("/systems/component?" + q(r))),
  photoUrl: (r: Ref) => "/systems/photo?" + q(r),
  item: (r: Ref, op: Op, item: Partial<SysItem>) => comp(POST("/systems/item", { ...r, op, item })),
  routine: (r: Ref, op: Op, routine: Partial<Routine>) => comp(POST("/systems/routine", { ...r, op, routine })),
  proposal: (r: Ref, op: Op, proposal: Partial<Proposal>) => {
    const { fit: _fit, ...rest } = proposal;
    void _fit;
    return comp(POST("/systems/proposal", { ...r, op, proposal: rest }));
  },
  zone: (r: Ref, op: Op, zone: Partial<Zone>) => comp(POST("/systems/zone", { ...r, op, zone })),
  saveComponent: (domain: string, instance: string, component: { id?: string; name?: string; dims?: Size; note?: string; photo?: string }) =>
    comp(POST("/systems/component", { domain, instance, op: "upsert", component })),
  swap: async (domain: string, name: string, carry: boolean) => normTree(await POST("/systems/swap", { domain, name, carry })),
};

/** tooltip text for a dimension: estimated or not, and where the number came from */
export const dimTip = (label: string, d?: Dim) =>
  d ? `${label} ${+d.cm.toFixed(1)} cm, ${d.estimated ? "estimated" : "sourced"}${d.source ? `\n${d.source}` : ""}` : label;

export const cmLabel = (d?: Dim) => (d ? `${d.estimated ? "~" : ""}${+d.cm.toFixed(1)}` : "?");
