
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { ChevronDown, Plus, Trash2, ArrowUp, ArrowDown, Repeat, X, Archive, Pencil, Check, ArrowUpRight, List } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverTrigger, PopoverContent, PopoverAnchor } from "@/components/ui/popover";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { WidgetFrame, useWidget } from "@/components/ui/widget";
import { useApi, usePersistent } from "@/lib/hooks";
import { useSaveKey } from "@/lib/savekey";
import { clearWidgetFocus } from "@/lib/arrownav";
import { cn } from "@/lib/utils";
import {
  systemsApi, cmLabel, dimTip, HYGIENE, PSTATUS,
  type ComponentResp, type Component, type Dim, type Ref, type SysItem, type Routine, type Proposal,
  type Zone, type Size, type Tree, type TreeDomain, type Hygiene,
} from "@/lib/systems";
import { Schematic, HYG_TONE, fitTone, viewBoxSize } from "./Schematic";
import {
  topSystems, subsystemsOf, systemOf, isLanding, landOn, placeSel, storedDomain, appOf, isLauncher, hasContent, groupOf,
  type Sel, type SystemApp,
} from "@/lib/systemsNav";

type Tab = "overview" | "items" | "routines" | "proposals" | "dims" | "photo" | "notes";
type EditTab = Exclude<Tab, "overview">;
type Write = (p: Promise<ComponentResp>) => Promise<void>;
type Pop = { kind: "item" | "proposal"; id: string; el: Element; from: Element } | null;

const TABS: [Tab, string][] = [
  ["overview", "Overview"], ["items", "Items"], ["routines", "Routines"], ["proposals", "Plan"],
  ["dims", "Size"], ["photo", "Photo"], ["notes", "Notes"],
];
const isTab = (t: unknown): t is Tab => TABS.some(([k]) => k === t);
const GAP = 32;            // between the visual and the write-up (gap-8)
const WU_MIN = 360;        // the write-up column: never narrower than this beside the visual
const WU_MAX = 520;        // ... and never wider: one readable column, not a spread
const STACK_BELOW = 680;   // narrower than this, the write-up goes under the visual
// each function tab is held to a readable width instead of stretching across the window;
// the Size table alone takes the full width (it is a table of numbers)
const TAB_MAX: Record<Exclude<Tab, "overview">, string> = {
  items: "max-w-[1180px]", routines: "max-w-[900px]", proposals: "max-w-[900px]",
  dims: "", photo: "max-w-[900px]", notes: "max-w-[900px]",
};

/** the visual's size beside (or above) the write-up when it is not the focused view */
function bigVisual(c: Component, room: { w: number; h: number }, stacked: boolean) {
  const vb = viewBoxSize(c);
  const ratio = vb.w / vb.h;
  // at least 640 px tall (the page scrolls on a short window), never wider than leaves the
  // write-up its column beside it
  const wu = Math.min(WU_MAX, Math.max(WU_MIN, room.w * 0.32));
  const availW = !room.w ? 900 : stacked ? room.w : Math.max(160, room.w - wu - GAP);
  let h = stacked ? Math.min(560, Math.max(480, room.h || 560)) : Math.max(640, room.h || 640);
  let wd = h * ratio;
  if (wd > availW) { wd = availW; h = wd / ratio; }
  return { w: Math.floor(wd), h: Math.floor(h) };
}
const selectCls = "h-8 min-w-0 rounded-md border border-input bg-transparent px-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60";
const fieldCls = "h-8 text-sm";
const iconBtn = "rounded p-1 text-muted-foreground hover:text-foreground disabled:opacity-30";
const groupHead = "text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground";

/** commit-on-blur/Enter text field; Escape restores (house rule: the first Escape only stops typing) */
function Field({ value, onCommit, className, placeholder, label, ...rest }: {
  value: string; onCommit: (v: string) => void; className?: string; placeholder?: string; label: string;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const commit = () => { const t = v.trim(); if (t !== value.trim()) onCommit(t); };
  return (
    <Input {...rest} value={v} aria-label={label} title={label} placeholder={placeholder}
      className={cn(fieldCls, className)}
      onChange={(e) => setV(e.target.value)} onBlur={commit}
      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } }} />
  );
}

/** a cm number with its own estimated toggle ("~") */
function DimInput({ value, onCommit, label, allowZero }: {
  value?: Dim; onCommit: (d: Dim) => void; label: string; allowZero?: boolean;
}) {
  const [v, setV] = useState(value ? String(value.cm) : "");
  useEffect(() => setV(value ? String(value.cm) : ""), [value?.cm]);   // eslint-disable-line react-hooks/exhaustive-deps
  const est = value?.estimated ?? true;
  const commit = () => {
    const n = parseFloat(v);
    if (!isFinite(n) || n < 0 || (n === 0 && !allowZero)) { setV(value ? String(value.cm) : ""); return; }
    if (!value || n !== value.cm) onCommit({ cm: n, estimated: est });
  };
  return (
    <span className="inline-flex items-center gap-0.5">
      <Input type="number" step="0.5" min={0} value={v} aria-label={label} title={dimTip(label, value)}
        className="h-8 w-[4.5rem] px-1.5 text-sm tabular-nums"
        onChange={(e) => setV(e.target.value)} onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } }} />
      <button type="button" aria-pressed={est} data-systems-est=""
        title={est ? `${label}: estimated (mark measured)` : `${label}: measured (mark estimated)`}
        onClick={() => value && onCommit({ ...value, estimated: !est })}
        className={cn("h-6 w-5 rounded text-sm font-semibold", est ? "text-[hsl(var(--warning))]" : "text-muted-foreground/50")}>~</button>
    </span>
  );
}

const Swatch = ({ h }: { h: Hygiene }) => (
  <span aria-hidden className="inline-block h-3 w-3 shrink-0 rounded-sm border"
    style={{ background: `hsl(${HYG_TONE[h]} / 0.25)`, borderColor: `hsl(${HYG_TONE[h]})`,
      backgroundImage: h === "wet/used" ? `repeating-linear-gradient(45deg, hsl(var(--warning) / 0.55) 0 1.5px, transparent 1.5px 4px)` : undefined }} />
);
/** the write-up's hygiene mark: a small dot, the class in its tooltip */
const Dot = ({ h }: { h: Hygiene }) => (
  <span title={h} data-systems-dot={h} className="inline-block h-2 w-2 shrink-0 rounded-full"
    style={{ background: `hsl(${HYG_TONE[h]})` }} />
);

const zoneTip = (z: Zone) =>
  [z.kind === "hook" ? `${z.name}, ${cmLabel(z.y)} cm down` : `${z.name}, ${cmLabel(z.w)} × ${cmLabel(z.h)} cm`, z.note].filter(Boolean).join("\n");

/** how much room the content has below the header, inside <main> */
function useRoom() {
  const ref = useRef<HTMLDivElement | null>(null);
  const [room, setRoom] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const main = el.closest<HTMLElement>("[data-knav-region=main]");
    const pad = main?.firstElementChild as HTMLElement | null;
    const read = () => {
      const r = el.getBoundingClientRect();
      let h = window.innerHeight - r.top - 24;
      if (main) {
        const m = main.getBoundingClientRect();
        const top = r.top - m.top + main.scrollTop;
        const pb = pad ? parseFloat(getComputedStyle(pad).paddingBottom) || 0 : 0;
        h = main.clientHeight - top - pb;
      }
      setRoom((o) => (Math.abs(o.w - r.width) < 1 && Math.abs(o.h - h) < 1 ? o : { w: r.width, h }));
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    if (main) ro.observe(main);
    window.addEventListener("resize", read);
    return () => { ro.disconnect(); window.removeEventListener("resize", read); };
  }, []);
  return [ref, room] as const;
}

/* ───────────────────────── the view ───────────────────────── */
export function Systems({ openView }: { openView?: (app: SystemApp, course?: string) => void } = {}) {
  const treeRes = useApi(() => systemsApi.tree(), [], 0);
  // System > subsystem > place > component (lib/systemsNav.ts)
  const tree: Tree = useMemo(() => treeRes.data ?? { domains: [] }, [treeRes.data]);
  const [stored, setStored] = usePersistent<Sel | null>("systems-sel", null);
  const [rawTab, setTab] = usePersistent<Tab>("systems-view-tab", "overview");
  const [rawLast, setLast] = usePersistent<EditTab>("systems-tab", "items");
  const tab: Tab = isTab(rawTab) ? rawTab : "overview";
  const last: EditTab = isTab(rawLast) && (rawLast as Tab) !== "overview" ? rawLast : "items";
  const [pop, setPop] = useState<Pop>(null);
  const [bodyRef, room] = useRoom();

  const go = useCallback((t: Tab) => { setTab(t); if (t !== "overview") setLast(t); }, [setTab, setLast]);

  // the selection that is actually valid against the tree
  const sel: Sel | null = useMemo(() => {
    const doms = tree.domains;
    if (!doms.length) return null;
    const d = storedDomain(tree, stored?.domain);
    if (!d) {
      const first = doms.find((x) => !isLauncher(x) && hasContent(x));
      return first ? placeSel(first) : landOn(tree, topSystems(tree)[0] ?? doms[0]);
    }
    // an old or launcher id resolved to its system: that system's list, or its own place
    if (d.id !== stored?.domain) return isLanding(tree, d) ? { domain: d.id, instance: "", component: "" } : placeSel(d);
    const inst = d.instances.find((i) => i.id === stored?.instance && stored?.domain === d.id)
      ?? d.instances.find((i) => i.id === d.current) ?? d.instances[0];
    if (!inst) return { domain: d.id, instance: "", component: "" };
    const c = inst.components.find((x) => x.id === stored?.component && stored?.instance === inst.id) ?? inst.components[0];
    return { domain: d.id, instance: inst.id, component: c?.id ?? "" };
  }, [tree, stored]);

  const [comp, setComp] = useState<ComponentResp | null>(null);
  const [compErr, setCompErr] = useState(false);
  const [zone, setZone] = useState<string | null>(null);
  const ref: Ref | null = sel && sel.component ? { domain: sel.domain, instance: sel.instance, component: sel.component } : null;
  const refKey = ref ? `${ref.domain}/${ref.instance}/${ref.component}` : "";
  useEffect(() => {
    let live = true;
    setZone(null);
    setPop(null);
    if (!ref) { setComp(null); setCompErr(false); return; }
    systemsApi.component(ref).then((c) => { if (live) { setComp(c); setCompErr(false); } })
      .catch(() => { if (live) { setComp(null); setCompErr(true); } });
    return () => { live = false; };
  }, [refKey]);   // eslint-disable-line react-hooks/exhaustive-deps

  const write: Write = useCallback((p: Promise<ComponentResp>) =>
    p.then((c) => setComp(c)).catch((e: Error) => { toast.error(e.message || "Not saved"); }), []);

  const dom = tree.domains.find((d) => d.id === sel?.domain);
  const inst = dom?.instances.find((i) => i.id === sel?.instance);
  const landing = isLanding(tree, dom);
  const archived = inst?.status === "archived";
  const c = comp && ref && comp.component.id === ref.component ? comp.component : null;

  const pick = (s: Sel) => setStored(s);
  const afterTree = (t: Tree, s?: Sel) => { treeRes.set(t); if (s) setStored(s); };
  const swap = (d: TreeDomain, name: string, carry: boolean) => systemsApi.swap(d.id, name, carry)
    .then((t) => { afterTree(t, { domain: d.id, instance: "", component: "" }); return true; })
    .catch((e: Error) => { toast.error(e.message); return false; });

  const toggle = useRef(() => {});
  toggle.current = () => go(tab === "overview" ? last : "overview");
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key !== "e" || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.defaultPrevented) return;
      if (document.documentElement.hasAttribute("data-board-prefix")) return;
      const view = document.querySelector("[data-systems-view]");
      if (!view || !view.querySelector("[data-systems-tabs]")) return;
      const a = document.activeElement as HTMLElement | null;
      if (a && (a.isContentEditable || a.matches("input, textarea, select"))) return;
      if (a && a.closest("[role=dialog], [role=alertdialog], [data-knav-modal], [data-knav-region=nav]")) return;
      if (a && a !== document.body && !view.contains(a) && !a.matches("[data-knav-region=main]")) return;
      e.preventDefault();
      if (!e.repeat) { if (document.querySelector("[data-knav-focused]")) clearWidgetFocus(); toggle.current(); }
    };
    window.addEventListener("keydown", on, true);
    return () => window.removeEventListener("keydown", on, true);
  }, []);

  // the editor anchors on the thing in the visual; a row with nothing drawn anchors on itself
  const openPop = (kind: "item" | "proposal", id: string, from: Element) => {
    const el = document.querySelector(kind === "item" ? `[data-systems-chip="${CSS.escape(id)}"]` : `[data-systems-overlay="${CSS.escape(id)}"]`) ?? from;
    setPop({ kind, id, el, from });
  };

  const editing = tab !== "overview";

  return (
    <div data-systems-view="" data-systems-mode={editing ? "edit" : "read"} data-systems-tab-open={tab} className="min-w-0 space-y-5">
      <header className="min-w-0">
        <h1 className="text-[22px] font-semibold tracking-tight">Systems</h1>
        <div className="mt-1 flex min-w-0 items-center gap-x-3">
          <Crumbs tree={tree} dom={dom} inst={inst} sel={sel} onPick={pick} onSwap={swap} go={openView} c={c} />
          {archived && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs text-muted-foreground"
              title={`Archived ${inst?.archived ?? ""}`}><Archive size={12} /> archived</span>
          )}
          {c && (
            <Button variant={editing ? "secondary" : "ghost"} size="sm" className="ml-auto h-7 shrink-0 gap-1.5"
              aria-pressed={editing} data-systems-edit="" title={editing ? "Back to the overview (e)" : "Edit (e)"}
              onClick={() => go(editing ? "overview" : last)}>
              {editing ? <Check size={14} /> : <Pencil size={14} />} {editing ? "Done" : "Edit"}
            </Button>
          )}
        </div>
      </header>

      {c && (
        <div role="tablist" aria-label="Systems sections" data-systems-tabs=""
          className="inline-flex h-auto max-w-full flex-wrap items-center justify-start rounded-lg bg-muted p-1 text-muted-foreground">
          {TABS.map(([k, label]) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} data-systems-tab={k}
              data-state={tab === k ? "active" : "inactive"} onClick={() => go(k)}
              className="inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow">
              {label}
            </button>
          ))}
        </div>
      )}

      <div ref={bodyRef} className="min-w-0">
        {landing && dom ? (
          <Landing tree={tree} sys={dom} onPick={pick} go={openView} />
        ) : c ? (
          tab === "overview" ? (
            <Overview c={c} r={ref!} archived={archived} zone={zone} setZone={setZone} room={room}
              pop={pop} setPop={setPop} openPop={openPop} write={write} />
          ) : (
            <TabPane tab={tab} archived={archived}>
              {tab === "items" && <ItemsTab c={c} r={ref!} write={write} zone={zone} setZone={setZone} />}
              {tab === "routines" && <RoutinesTab c={c} r={ref!} write={write} />}
              {tab === "proposals" && <ProposalsTab c={c} r={ref!} write={write} />}
              {tab === "dims" && <DimsEditor c={c} r={ref!} write={write} zone={zone} />}
              {tab === "photo" && <PhotoTab c={c} r={ref!} write={write} />}
              {tab === "notes" && <NotesTab c={c} r={ref!} write={write} />}
            </TabPane>
          )
        ) : (
          <WidgetFrame id="systems.visual" title="Visual" className="w-full">
            <EmptyPane sel={sel} hasInstance={!!inst} archived={archived} err={compErr}
              loading={treeRes.loading && !treeRes.data} treeErr={!!treeRes.error && !treeRes.data}
              onAddComponent={(name, dims) => sel && inst && systemsApi.saveComponent(sel.domain, inst.id, { name, dims })
                .then(async (r) => { afterTree(await systemsApi.tree(), { ...sel, instance: inst.id, component: r.component.id }); })
                .catch((e: Error) => toast.error(e.message))}
              onStart={(name) => dom && swap(dom, name, false)} />
          </WidgetFrame>
        )}
      </div>
    </div>
  );
}

function TabPane({ tab, archived, children }: { tab: EditTab; archived: boolean; children: ReactNode }) {
  const title = TABS.find(([k]) => k === tab)?.[1] ?? "Edit";
  return (
    <WidgetFrame id={`systems.${tab}`} title={title} className="w-full">
      <fieldset disabled={archived} className={cn("min-w-0", TAB_MAX[tab])} data-systems-writeup="edit">
        {children}
      </fieldset>
    </WidgetFrame>
  );
}

/* ───────────────────────── overview: the visual + the write-up ───────────────────────── */
function Overview({ c, r, archived, zone, setZone, room, pop, setPop, openPop, write }: {
  c: Component; r: Ref; archived: boolean; zone: string | null; setZone: (z: string | null) => void;
  room: { w: number; h: number }; pop: Pop; setPop: (p: Pop) => void;
  openPop: (k: "item" | "proposal", id: string, from: Element) => void; write: Write;
}) {
  const stacked = room.w > 0 && room.w < STACK_BELOW;
  // beside the visual the column scrolls within the visual's height
  const colH = !stacked && c.dims ? bigVisual(c, room, stacked).h : undefined;
  return (
    <div className={cn("flex min-w-0", stacked ? "flex-col gap-6" : "flex-row items-start gap-8")}>
      <WidgetFrame id="systems.visual" title="Visual" className={cn("min-w-0", stacked ? "w-full" : "shrink-0")}>
        <Visual c={c} archived={archived} zone={zone} setZone={setZone} room={room} stacked={stacked}
          pop={pop} setPop={setPop} openPop={openPop} r={r} write={write} />
      </WidgetFrame>
      <WidgetFrame id="systems.writeup" title="Write-up"
        className={cn("min-w-0", stacked ? "w-full" : "flex-1")}
        style={stacked ? undefined : { minWidth: WU_MIN, maxWidth: WU_MAX }}>
        <ReadUp c={c} r={r} zone={zone} setZone={setZone} openPop={openPop} maxH={colH} />
      </WidgetFrame>
    </div>
  );
}

/* ───────────────────────── breadcrumb: the switcher ───────────────────────── */
function CrumbMenu({ id, label, title, keep, last, children }: {
  id: "domain" | "subsystem" | "instance" | "component"; label: string; title: string; keep?: boolean; last?: boolean;
  children: (close: () => void) => ReactNode;
}) {
  // the tooltip names the crumb in full (it truncates on a narrow window) and what it switches
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" data-systems-crumbmenu={id} data-knav-id={`sys-crumb-${id}`} title={label ? `${label}\n${title}` : title}
          aria-label={label ? undefined : title}
          className={cn("inline-flex min-w-[2.5rem] max-w-[18rem] items-center gap-0.5 rounded px-1 py-0.5 hover:bg-accent hover:text-foreground", keep ? "shrink-0" : last ? "shrink" : "shrink-[3]")}>
          {label && <span className="truncate">{label}</span>}
          <ChevronDown size={12} className="shrink-0 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-1" data-systems-menu={id}>
        {children(() => setOpen(false))}
      </PopoverContent>
    </Popover>
  );
}

const menuRow = "flex w-full min-w-0 items-center gap-1.5 rounded px-2 py-1.5 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none";

function MenuRow({ node, current, onClick, title, muted, children }: {
  node: string; current?: boolean; onClick: () => void; title?: string; muted?: boolean; children: ReactNode;
}) {
  return (
    <button type="button" data-systems-node={node} data-knav-id={`sys-${node}`} aria-current={current ? "true" : undefined}
      title={title} onClick={onClick}
      className={cn(menuRow, current && "bg-secondary font-medium", muted && "text-muted-foreground")}>
      {children}
    </button>
  );
}

function SwapEntry({ d, onSwap }: { d: TreeDomain; onSwap: (d: TreeDomain, name: string, carry: boolean) => Promise<boolean> }) {
  const [open, setOpen] = useState(false);
  if (open) return <SwapForm first={!d.current} onCancel={() => setOpen(false)} onSwap={(n, carry) => onSwap(d, n, carry)} />;
  return (
    <button type="button" className={cn(menuRow, "text-muted-foreground")} data-systems-swap={d.id}
      title={d.current ? "Swap to a new place; the current one is archived" : "Start this system"}
      onClick={() => setOpen(true)}>
      {d.current ? <Repeat size={13} /> : <Plus size={13} />}
      <span>{d.current ? "Swap" : "Start"}</span>
    </button>
  );
}

function Crumbs({ tree, dom, inst, c, sel, onPick, onSwap, go }: {
  tree: Tree; dom?: TreeDomain; inst?: TreeDomain["instances"][number]; c: { name: string } | null; sel: Sel | null;
  onPick: (s: Sel) => void; onSwap: (d: TreeDomain, name: string, carry: boolean) => Promise<boolean>;
  go?: (app: SystemApp, course?: string) => void;   // a launcher subsystem opens its own view
}) {
  if (!tree.domains.length || !dom) return null;
  const slash = <span aria-hidden className="shrink-0 whitespace-pre text-muted-foreground/60">{" / "}</span>;
  // the System crumb is the top-level system; the Subsystem crumb shows only when it has some
  const sys = systemOf(tree, dom);
  const subs = subsystemsOf(tree, sys.id);
  const current = dom.instances.filter((i) => i.status !== "archived");
  const arch = dom.instances.filter((i) => i.status === "archived");
  const swapRow = (close: () => void) => (
    <div className="mt-1 border-t pt-1">
      <SwapEntry d={dom} onSwap={(d, n, carry) => onSwap(d, n, carry).then((ok) => { if (ok) close(); return ok; })} />
    </div>
  );
  const instRow = (i: TreeDomain["instances"][number], close: () => void) => (
    <MenuRow key={i.id} node={`instance:${dom.id}/${i.id}`} current={i.id === inst?.id} muted={i.status === "archived"}
      title={i.status === "archived" ? `Archived ${i.archived ?? ""}` : "Current"}
      onClick={() => { onPick({ domain: dom.id, instance: i.id, component: i.components[0]?.id ?? "" }); close(); }}>
      <span className="truncate">{i.name}</span>
      {i.status === "archived" && <Archive size={12} className="ml-auto shrink-0" />}
    </MenuRow>
  );
  return (
    <nav aria-label="Systems" data-systems-crumb="" className="flex min-w-0 flex-1 items-center overflow-hidden whitespace-nowrap text-sm text-muted-foreground">
      <CrumbMenu id="domain" label={sys.name} title="Systems" last={!subs.length && !inst}>
        {(close) => (
          <>
            {topSystems(tree).map((d) => (
              <MenuRow key={d.id} node={`domain:${d.id}`} current={d.id === sys.id}
                onClick={() => { onPick(landOn(tree, d)); close(); }}>
                <span className="truncate">{d.name}</span>
              </MenuRow>
            ))}
            {dom === sys && !isLanding(tree, dom) && swapRow(close)}
          </>
        )}
      </CrumbMenu>
      {subs.length > 0 && !(dom === sys && isLanding(tree, dom)) && <>{slash}
        <CrumbMenu id="subsystem" label={dom === sys ? "" : dom.name} title="Subsystems" last={!inst}>
          {(close) => (
            <>
              <MenuRow node={`system:${sys.id}`} current={dom === sys} title={`All of ${sys.name}`}
                onClick={() => { onPick({ domain: sys.id, instance: "", component: "" }); close(); }}>
                <List size={13} className="shrink-0 opacity-60" />
                <span className="truncate">{sys.name}</span>
              </MenuRow>
              <div className="mt-1 border-t pt-1">
                {subs.map((s, n) => {
                  const app = appOf(s);
                  const group = groupOf(s);
                  return app ? (
                    <Fragment key={s.id}>
                      {group && group !== (n ? groupOf(subs[n - 1]) : "") && <div className={cn(groupHead, "px-2 pb-1 pt-1.5")}>{group}</div>}
                      <MenuRow node={`launch:${s.id}`} title={s.course ?? `Open ${app}`}
                        onClick={() => { close(); go?.(app, s.course ?? undefined); }}>
                        <span className={cn("truncate", group && "pl-2")}>{s.name}</span>
                        <ArrowUpRight size={13} className="ml-auto shrink-0 opacity-60" />
                      </MenuRow>
                    </Fragment>
                  ) : (
                    <MenuRow key={s.id} node={`subsystem:${s.id}`} current={s.id === dom.id}
                      onClick={() => { onPick(placeSel(s)); close(); }}>
                      <span className="truncate">{s.name}</span>
                    </MenuRow>
                  );
                })}
              </div>
            </>
          )}
        </CrumbMenu>
      </>}
      {inst && <>{slash}
        <CrumbMenu id="instance" label={inst.name} title="Places" last={!c}>
          {(close) => (
            <>
              {current.map((i) => instRow(i, close))}
              {arch.length > 0 && <div className="mt-1 border-t pt-1">{arch.map((i) => instRow(i, close))}</div>}
              {swapRow(close)}
            </>
          )}
        </CrumbMenu>
      </>}
      {inst && c && sel && <>{slash}
        <CrumbMenu id="component" label={c.name} title="Components" last>
          {(close) => inst.components.map((x) => (
            <MenuRow key={x.id} node={`component:${dom.id}/${inst.id}/${x.id}`} current={x.id === sel.component} title={x.name}
              onClick={() => { onPick({ domain: dom.id, instance: inst.id, component: x.id }); close(); }}>
              <span className="truncate">{x.name}</span>
            </MenuRow>
          ))}
        </CrumbMenu>
      </>}
    </nav>
  );
}

/** a system with no places of its own: its subsystems, each opening its view or selecting it */
function Landing({ tree, sys, onPick, go }: {
  tree: Tree; sys: TreeDomain; onPick: (s: Sel) => void; go?: (app: SystemApp, course?: string) => void;
}) {
  return (
    <WidgetFrame id="systems.subsystems" title={sys.name} className="w-full max-w-[720px]">
      <ul className="divide-y" data-systems-landing={sys.id}>
        {subsystemsOf(tree, sys.id).map((s, n, all) => {
          const app = appOf(s);
          const group = groupOf(s);
          const head = group && group !== (n ? groupOf(all[n - 1]) : "");
          // beside the name: a course's title (its folder name without the code), else the current place
          const place = s.course ? s.course.replace(/^[A-Z]{2,4}\d{2,4}\w*\s*-\s*/, "")
            : app ? "" : (s.instances.find((i) => i.id === s.current) ?? s.instances[0])?.name ?? "";
          return (
            <li key={s.id}>
              {head && <div className={cn(groupHead, "px-2 pb-1 pt-3")} data-systems-group={group}>{group}</div>}
              <button type="button" data-systems-sub={s.id} data-knav-id={`sys-sub-${s.id}`}
                title={app ? s.course ?? `Open ${app}` : s.name}
                onClick={() => (app ? go?.(app, s.course ?? undefined) : onPick(placeSel(s)))}
                className="flex w-full min-w-0 items-center gap-3 rounded px-2 py-2.5 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none">
                <span className={cn("shrink-0 font-medium", group && "pl-2")}>{s.name}</span>
                {place && <span className="min-w-0 truncate text-muted-foreground">{place}</span>}
                {app && <ArrowUpRight size={14} className="ml-auto shrink-0 text-muted-foreground" />}
              </button>
            </li>
          );
        })}
      </ul>
    </WidgetFrame>
  );
}

function SwapForm({ first, onSwap, onCancel }: { first: boolean; onSwap: (name: string, carry: boolean) => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [carry, setCarry] = useState(true);
  const go = () => { if (name.trim()) onSwap(name.trim(), !first && carry); };
  return (
    <div className="space-y-1.5 p-1.5" data-systems-swapform="">
      <Input autoFocus value={name} placeholder="New place" aria-label="New place" title="New place"
        className={fieldCls} onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); go(); } }} />
      {!first && (
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground" title="Copy components, items and routines; dimensions become estimates">
          <input type="checkbox" checked={carry} onChange={(e) => setCarry(e.target.checked)} /> Carry items
        </label>
      )}
      <div className="flex gap-1">
        <Button size="sm" className="h-7" onClick={go} disabled={!name.trim()}>{first ? "Start" : "Swap"}</Button>
        <Button size="sm" variant="ghost" className="h-7" onClick={onCancel} data-knav-back="">Cancel</Button>
      </div>
    </div>
  );
}

function EmptyPane({ sel, hasInstance, archived, err, loading, treeErr, onAddComponent, onStart }: {
  sel: Sel | null; hasInstance: boolean; archived: boolean; err: boolean; loading: boolean; treeErr: boolean;
  onAddComponent: (name: string, dims: Size) => void; onStart: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const [w, setW] = useState(""), [d, setD] = useState(""), [h, setH] = useState("");
  if (loading) return <p className="py-10 text-center text-sm text-muted-foreground">Loading</p>;
  if (treeErr || !sel) return <p className="py-10 text-center text-sm text-muted-foreground" data-systems-empty="none">No systems</p>;
  if (err) return <p className="py-10 text-center text-sm text-muted-foreground" data-systems-empty="component">Component not found</p>;
  if (!hasInstance) {
    return (
      <div className="mx-auto max-w-xs py-8" data-systems-empty="domain">
        <p className="mb-2 text-sm text-muted-foreground">No place yet</p>
        <div className="flex gap-1.5">
          <Input value={name} placeholder="Place" aria-label="Place" title="Place" className={fieldCls}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) { e.preventDefault(); onStart(name.trim()); } }} />
          <Button size="sm" className="h-8" disabled={!name.trim()} onClick={() => onStart(name.trim())}>Start</Button>
        </div>
      </div>
    );
  }
  const n = (s: string) => parseFloat(s);
  const ok = name.trim() && [w, d, h].every((x) => n(x) > 0);
  const est = (v: string): Dim => ({ cm: n(v), estimated: true });
  return (
    <div className="mx-auto max-w-sm py-8" data-systems-empty="instance">
      <p className="mb-2 text-sm text-muted-foreground">No components</p>
      {!archived && (
        <div className="flex flex-wrap items-center gap-1.5">
          <Input value={name} placeholder="Component" aria-label="Component" title="Component" className={cn(fieldCls, "w-36")}
            onChange={(e) => setName(e.target.value)} />
          {([["w", w, setW], ["d", d, setD], ["h", h, setH]] as const).map(([k, v, set]) => (
            <Input key={k} type="number" min={0} value={v} placeholder={k} aria-label={`${k} cm`} title={`${k} cm`}
              className="h-8 w-16 px-1.5 text-sm" onChange={(e) => set(e.target.value)} />
          ))}
          <Button size="sm" className="h-8" disabled={!ok} onClick={() => onAddComponent(name.trim(), { w: est(w), d: est(d), h: est(h) })}>
            <Plus size={14} /> Add
          </Button>
        </div>
      )}
    </div>
  );
}

/* ───────────────────────── the visual ───────────────────────── */
function Visual({ c, r, archived, zone, setZone, room, stacked, pop, setPop, openPop, write }: {
  c: Component; r: Ref; archived: boolean; zone: string | null; setZone: (z: string | null) => void;
  room: { w: number; h: number }; stacked: boolean;
  pop: Pop; setPop: (p: Pop) => void; openPop: (k: "item" | "proposal", id: string, from: Element) => void; write: Write;
}) {
  const w = useWidget();
  const anchor = useMemo(() => ({ current: pop?.el ?? null }), [pop?.el]);
  // where the keys go back to when the editor closes (pop is already null by then)
  const from = useRef<Element | null>(null);
  if (pop) from.current = pop.from;
  if (!c.dims) return <p className="py-10 text-center text-sm text-muted-foreground" data-systems-empty="dims">No dimensions</p>;
  const vb = viewBoxSize(c);
  const ratio = vb.w / vb.h;
  let h: number, wd: number;
  if (w?.focused) {
    h = Math.max(300, (w.height || 700) - 56);
    wd = Math.min(Math.max(200, (w.width || 600) - 16), h * ratio);
    h = Math.min(h, wd / ratio);
  } else {
    ({ w: wd, h } = bigVisual(c, room, stacked));
  }
  const it = pop?.kind === "item" ? c.items.find((x) => x.id === pop.id) : undefined;
  const pr = pop?.kind === "proposal" ? c.proposals.find((x) => x.id === pop.id) : undefined;
  return (
    <div className={cn("relative", stacked && "flex justify-center")} data-systems-visual="">
      <Schematic c={c} selectedZone={zone} onZone={setZone} width={Math.floor(wd)} height={Math.floor(h)} readOnly={archived}
        picked={pop?.id ?? null}
        onChip={(id, el) => openPop("item", id, el)}
        onOverlay={(id, el) => openPop("proposal", id, el)} />
      <Popover open={!!pop && !!(it || pr)} onOpenChange={(o) => { if (!o) setPop(null); }}>
        <PopoverAnchor virtualRef={anchor as React.RefObject<Element>} />
        <PopoverContent side="right" align="start" className="w-72 p-3" data-systems-pop={pop?.kind ?? ""}
          onCloseAutoFocus={(e) => { e.preventDefault(); const f = from.current as HTMLElement | SVGElement | null; if (f?.isConnected) f.focus({ preventScroll: true }); }}>
          <fieldset disabled={archived} className="min-w-0">
            {it && <ItemPop c={c} r={r} it={it} write={write} done={() => setPop(null)} />}
            {pr && <ProposalPop c={c} r={r} p={pr} write={write} done={() => setPop(null)} />}
          </fieldset>
        </PopoverContent>
      </Popover>
    </div>
  );
}

function ItemPop({ c, r, it, write, done }: { c: Component; r: Ref; it: SysItem; write: Write; done: () => void }) {
  const up = (patch: Partial<SysItem>) => write(systemsApi.item(r, "upsert", { ...it, ...patch }));
  return (
    <div className="space-y-2" data-systems-itempop={it.id}>
      <div className="flex items-center gap-1.5">
        <Swatch h={it.hygiene} />
        <Field value={it.name} label="Item name" onCommit={(v) => v && up({ name: v })} />
        <button type="button" title={`Delete ${it.name}`} aria-label={`Delete ${it.name}`} className={iconBtn}
          onClick={() => { void write(systemsApi.item(r, "delete", { id: it.id })); done(); }}><Trash2 size={14} /></button>
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        <ZoneSelect c={c} value={it.zone} label={`${it.name} zone`} onChange={(v) => up({ zone: v })} />
        <HygSelect value={it.hygiene} label={`${it.name} hygiene`} onChange={(h) => up({ hygiene: h })} />
      </div>
      {it.note && <p className="text-xs text-muted-foreground">{it.note}</p>}
    </div>
  );
}

function ProposalPop({ c, r, p, write, done }: { c: Component; r: Ref; p: Proposal; write: Write; done: () => void }) {
  const up = (patch: Partial<Proposal>) => write(systemsApi.proposal(r, "upsert", { ...p, ...patch }));
  const n = c.proposals.indexOf(p) + 1;
  return (
    <div className="space-y-2" data-systems-proposalpop={p.id}>
      <div className="flex items-center gap-1.5">
        <Num n={n} p={p} />
        <Field value={p.name} label="Proposal name" onCommit={(v) => v && up({ name: v })} />
        <button type="button" title={`Delete ${p.name}`} aria-label={`Delete ${p.name}`} className={iconBtn}
          onClick={() => { void write(systemsApi.proposal(r, "delete", { id: p.id })); done(); }}><Trash2 size={14} /></button>
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        <select className={selectCls} value={p.status} aria-label={`${p.name} status`} title="Status"
          onChange={(e) => up({ status: e.target.value as Proposal["status"] })}>
          {PSTATUS.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <ZoneSelect c={c} whole value={p.zone} label={`${p.name} zone`} onChange={(v) => up({ zone: v })} />
      </div>
      <FitText p={p} />
    </div>
  );
}

const Num = ({ n, p }: { n: number; p: Proposal }) => (
  <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-background"
    style={{ background: `hsl(${fitTone(p.fit?.state)})` }}>{n}</span>
);
const FitText = ({ p, attr = "data-systems-fitstate" }: { p: Proposal; attr?: string }) => {
  const s = p.fit?.state ?? "unknown";
  return (
    <span {...{ [attr]: s }} className={cn("text-xs", s === "fits" || s === "unknown" ? "text-muted-foreground" : "font-medium")}
      style={s !== "fits" && s !== "unknown" ? { color: `hsl(${fitTone(s)})` } : undefined}
      title={p.fit?.against ? `against ${p.fit.against.w} × ${p.fit.against.d} × ${p.fit.against.h} cm` : undefined}>
      {s}{p.fit?.rotated ? ", turned" : ""}
    </span>
  );
};

/* ───────────────────────── the write-up (read) ───────────────────────── */
function ReadUp({ c, r, zone, setZone, openPop, maxH }: {
  c: Component; r: Ref; zone: string | null; setZone: (z: string | null) => void;
  openPop: (k: "item" | "proposal", id: string, from: Element) => void; maxH?: number;
}) {
  const w = useWidget();
  const ids = new Set(c.zones.map((z) => z.id));
  const loose = c.items.filter((i) => !ids.has(i.zone));
  const row = "flex w-full min-w-0 items-center gap-2 rounded px-1 py-1 text-left hover:bg-accent";
  const items = (list: SysItem[]) => (
    <ul className="pl-2">
      {list.map((it) => (
        <li key={it.id} data-systems-wu-item={it.id}>
          <button type="button" className={row} title={it.note || `${it.name}, ${it.hygiene}`}
            onClick={(e) => openPop("item", it.id, e.currentTarget)}>
            <Dot h={it.hygiene} /><span className="truncate">{it.name}</span>
          </button>
        </li>
      ))}
    </ul>
  );
  // one zone: its header (name, kind, count), then its items; an empty zone is the header
  // alone, muted, on one line
  const zoneHead = (z: Zone, n: number) => (
    <button type="button" aria-pressed={zone === z.id} onClick={() => setZone(zone === z.id ? null : z.id)}
      title={zoneTip(z)} data-systems-zonehead={z.id}
      className={cn("flex w-full min-w-0 items-baseline gap-2 rounded px-1 py-0.5 text-left hover:bg-accent",
        n ? "border-b pb-1 font-medium" : "text-muted-foreground/80",
        zone === z.id && "bg-primary/10 text-foreground")}>
      <span className="min-w-0 truncate text-[13px]">{z.name}</span>
      <span className="shrink-0 text-xs font-normal text-muted-foreground">{z.kind}</span>
      <span className="ml-auto shrink-0 nums text-xs font-normal text-muted-foreground">{n ? n : "empty"}</span>
    </button>
  );
  return (
    <div className={cn("space-y-5 text-sm", maxH && !w?.focused && "overflow-y-auto pr-1")}
      style={maxH && !w?.focused ? { maxHeight: maxH } : undefined} data-systems-writeup="read">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold leading-tight">{c.name}</h2>
          {c.dims && (
            <p className="text-sm tabular-nums text-muted-foreground" data-systems-dimsummary=""
              title={["Interior w × d × h, cm; ~ is an estimate", ...new Set((["w", "d", "h"] as const).map((k) => c.dims?.[k].source).filter(Boolean))].join("\n")}>
              {cmLabel(c.dims.w)} × {cmLabel(c.dims.d)} × {cmLabel(c.dims.h)} cm
            </p>
          )}
        </div>
        <PhotoThumb c={c} r={r} />
      </div>

      <section>
        <h3 className={cn(groupHead, "mb-2 px-1")}>Zones</h3>
        <ul className="space-y-2" data-systems-zones="">
          {c.zones.map((z) => {
            const list = c.items.filter((i) => i.zone === z.id);
            return (
              <li key={z.id} data-systems-zoneblock={z.id} data-systems-zoneempty={list.length ? undefined : ""} className="min-w-0">
                {zoneHead(z, list.length)}
                {list.length > 0 && items(list)}
              </li>
            );
          })}
          {loose.length > 0 && (
            <li data-systems-zoneblock="" className="min-w-0">
              <div className="flex items-baseline gap-2 border-b px-1 pb-1 font-medium">
                <span className="text-[13px]">Unplaced</span>
                <span className="ml-auto nums text-xs font-normal text-muted-foreground">{loose.length}</span>
              </div>
              {items(loose)}
            </li>
          )}
        </ul>
      </section>

      {c.proposals.length > 0 && (
        <section data-systems-plan="">
          <h3 className={cn(groupHead, "mb-2 px-1")}>Plan</h3>
          <ol className="space-y-1">
            {c.proposals.map((p, i) => (
              <li key={p.id} data-systems-planrow={p.id} className={cn("min-w-0", p.status === "dropped" && "opacity-50")}>
                <button type="button" className={cn(row, "items-start")} title={p.note || p.name}
                  onClick={(e) => openPop("proposal", p.id, e.currentTarget)}>
                  <Num n={i + 1} p={p} />
                  <span className="min-w-0 flex-1">
                    <span className="block leading-5">{p.name}</span>
                    <span className="block text-xs text-muted-foreground">
                      {p.status} · <FitText p={p} attr="data-systems-fit" />
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </section>
      )}

      {c.note && (
        <section>
          <h3 className={cn(groupHead, "mb-2 px-1")}>Note</h3>
          <p className="max-w-prose whitespace-pre-wrap px-1 text-sm leading-relaxed" data-systems-note="">{c.note}</p>
        </section>
      )}
    </div>
  );
}

function PhotoThumb({ c, r }: { c: Component; r: Ref }) {
  const [bad, setBad] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => setBad(false), [c.id, c.photo]);
  if (!c.photo || bad) return null;
  const src = systemsApi.photoUrl(r);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} title={c.photo} aria-label={`${c.name} photo`} data-systems-photothumb=""
        className="h-14 w-14 shrink-0 overflow-hidden rounded-md border">
        <img src={src} alt="" className="h-full w-full object-cover" onError={() => setBad(true)} loading="lazy" />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-[min(92vw,1100px)] p-3">
          <DialogTitle className="sr-only">{c.name} photo</DialogTitle>
          <img src={src} alt={`${c.name} reference photo`} title={c.photo} data-systems-photo=""
            className="max-h-[85vh] w-full rounded-md object-contain" />
        </DialogContent>
      </Dialog>
    </>
  );
}

/* ───────────────────────── size: interior and zones ───────────────────────── */
const DIM_KEYS = ["x", "y", "w", "h", "d"] as const;
type DimKey = typeof DIM_KEYS[number];

function SourceCell({ dims }: { dims: (Dim | undefined)[] }) {
  const list = dims.filter((d): d is Dim => !!d);
  const srcs = [...new Set(list.map((d) => d.source).filter(Boolean))] as string[];
  const est = list.filter((d) => d.estimated).length;
  const status = !list.length ? "" : est === 0 ? "measured" : est === list.length ? "estimated" : `${est} of ${list.length} estimated`;
  return (
    <span className="block min-w-0 truncate text-xs text-muted-foreground" title={[status, ...srcs].filter(Boolean).join("\n")}>
      {srcs.length ? srcs.join("; ") : status}
    </span>
  );
}

function DimsEditor({ c, r, write, zone }: { c: Component; r: Ref; write: Write; zone: string | null }) {
  const [nz, setNz] = useState("");
  const w = useWidget();
  const table = !w || w.size === "lg" || w.size === "xl";
  const setDim = (k: keyof Size, d: Dim) => c.dims &&
    write(systemsApi.saveComponent(r.domain, r.instance, { id: c.id, dims: { ...c.dims, [k]: d } }));
  const setZoneDim = (z: Zone, k: DimKey, d: Dim) => write(systemsApi.zone(r, "upsert", { ...z, [k]: d }));
  const zones = c.zones;   // as the data orders them, like the overview
  const keysOf = (z: Zone) => (z.kind === "hook" ? (["x", "y"] as const) : DIM_KEYS);
  const delZone = (z: Zone) => (
    <button type="button" title={`Delete ${z.name}`} aria-label={`Delete ${z.name}`} className={iconBtn}
      onClick={() => write(systemsApi.zone(r, "delete", { id: z.id }))}><Trash2 size={14} /></button>
  );
  const addZone = (
    <div className="flex flex-wrap items-center gap-1.5 border-t pt-3">
      <Input value={nz} placeholder="New zone" aria-label="New zone" title="New zone" className={cn(fieldCls, "w-48")}
        onChange={(e) => setNz(e.target.value)} />
      {(["space", "hook"] as const).map((k) => (
        <Button key={k} size="sm" variant="outline" className="h-8" disabled={!nz.trim() || !c.dims}
          onClick={() => {
            const e = (v: number): Dim => ({ cm: v, estimated: true });
            const z: Partial<Zone> = k === "hook" ? { name: nz.trim(), kind: "hook", x: e(0), y: e(10) }
              : { name: nz.trim(), kind: "space", x: e(0), y: e(0), w: e(c.dims!.w.cm), h: e(Math.min(20, c.dims!.h.cm)) };
            write(systemsApi.zone(r, "upsert", z)); setNz("");
          }}><Plus size={13} /> {k}</Button>
      ))}
    </div>
  );
  return (
    <div className="space-y-4" data-systems-dims="">
      <label className="flex max-w-md items-center gap-3 text-sm">
        <span className="w-24 shrink-0 text-muted-foreground">Component</span>
        <Field value={c.name} label="Component name" onCommit={(v) => v && write(systemsApi.saveComponent(r.domain, r.instance, { id: c.id, name: v }))} />
      </label>
      {table ? (
        <table className="w-full table-fixed border-collapse text-sm" data-systems-dimtable="">
          <colgroup>
            <col className="w-[13rem]" /><col className="w-16" />
            {DIM_KEYS.map((k) => <col key={k} className="w-[6.5rem]" />)}
            <col /><col className="w-10" />
          </colgroup>
          <thead>
            <tr className="border-b text-left">
              <th className={cn(groupHead, "py-2 pr-2 font-semibold")}>Zone</th>
              <th className={cn(groupHead, "py-2 pr-2 font-semibold")}>Kind</th>
              {DIM_KEYS.map((k) => <th key={k} className={cn(groupHead, "py-2 pr-2 font-semibold")} title={`${k}, cm`}>{k} <span className="normal-case">cm</span></th>)}
              <th className={cn(groupHead, "py-2 pr-2 font-semibold")}>Source</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <tr className="border-b" data-systems-zone-row="">
              <td className="py-2 pr-2 font-medium">Interior</td>
              <td className="py-2 pr-2 text-muted-foreground">box</td>
              <td /><td />
              {(["w", "h", "d"] as const).map((k) => (
                <td key={k} className="py-2 pr-2"><DimInput value={c.dims?.[k]} label={`Interior ${k}`} onCommit={(d) => setDim(k, d)} /></td>
              ))}
              <td className="py-2 pr-2"><SourceCell dims={c.dims ? [c.dims.w, c.dims.d, c.dims.h] : []} /></td>
              <td />
            </tr>
            {zones.map((z) => (
              <tr key={z.id} className={cn("border-b", zone === z.id && "bg-primary/5")} data-systems-zone-row={z.id}>
                <td className="truncate py-2 pr-2" title={zoneTip(z)}>{z.name}</td>
                <td className="py-2 pr-2 text-muted-foreground">{z.kind}</td>
                {DIM_KEYS.map((k) => (
                  <td key={k} className="py-2 pr-2">
                    {(keysOf(z) as readonly DimKey[]).includes(k)
                      ? <DimInput value={z[k]} allowZero={k === "x" || k === "y"} label={`${z.name} ${k}`} onCommit={(d) => setZoneDim(z, k, d)} />
                      : null}
                  </td>
                ))}
                <td className="py-2 pr-2"><SourceCell dims={keysOf(z).map((k) => z[k])} /></td>
                <td className="py-2 text-right">{delZone(z)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="space-y-3">
          <div className="space-y-1.5 rounded-md border p-2.5" data-systems-zone-row="">
            <div className="flex items-center gap-2 text-sm font-medium">Interior
              <span className="min-w-0 flex-1"><SourceCell dims={c.dims ? [c.dims.w, c.dims.d, c.dims.h] : []} /></span></div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              {(["w", "d", "h"] as const).map((k) => (
                <label key={k} className="inline-flex items-center gap-1 text-xs text-muted-foreground">{k}
                  <DimInput value={c.dims?.[k]} label={`Interior ${k}`} onCommit={(d) => setDim(k, d)} /></label>
              ))}
            </div>
          </div>
          {zones.map((z) => (
            <div key={z.id} className={cn("space-y-1.5 rounded-md border p-2.5", zone === z.id && "bg-primary/5")} data-systems-zone-row={z.id}>
              <div className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 truncate text-sm font-medium" title={zoneTip(z)}>{z.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{z.kind}</span>
                <span className="ml-auto shrink-0">{delZone(z)}</span>
              </div>
              <SourceCell dims={keysOf(z).map((k) => z[k])} />
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                {keysOf(z).map((k) => (
                  <label key={k} className="inline-flex items-center gap-1 text-xs text-muted-foreground">{k}
                    <DimInput value={z[k]} allowZero={k === "x" || k === "y"} label={`${z.name} ${k}`}
                      onCommit={(d) => setZoneDim(z, k, d)} /></label>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      {addZone}
    </div>
  );
}

/* ───────────────────────── items ───────────────────────── */
function ZoneSelect({ c, value, onChange, label, whole, className }: {
  c: Component; value: string; onChange: (v: string) => void; label: string; whole?: boolean; className?: string;
}) {
  return (
    <select className={cn(selectCls, "w-full", className)} value={value} aria-label={label} title={label} onChange={(e) => onChange(e.target.value)}>
      <option value="">{whole ? "Whole interior" : "Unplaced"}</option>
      {c.zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
    </select>
  );
}
function HygSelect({ value, onChange, label }: { value: Hygiene; onChange: (h: Hygiene) => void; label: string }) {
  return (
    <select className={cn(selectCls, "w-full")} value={value} aria-label={label} title="Hygiene class"
      onChange={(e) => onChange(e.target.value as Hygiene)}>
      {HYGIENE.map((h) => <option key={h} value={h}>{h}</option>)}
    </select>
  );
}

function ItemsTab({ c, r, write, zone, setZone }: {
  c: Component; r: Ref; write: Write; zone: string | null; setZone: (z: string | null) => void;
}) {
  const w = useWidget();
  const wide = !w || w.size !== "xs" && w.size !== "sm";
  const two = !!w && w.size === "xl";
  const [name, setName] = useState("");
  const [hyg, setHyg] = useState<Hygiene>("clean");
  const [nzone, setNzone] = useState(zone ?? "");
  useEffect(() => setNzone(zone ?? ""), [zone]);
  const up = (it: SysItem, patch: Partial<SysItem>) => write(systemsApi.item(r, "upsert", { ...it, ...patch }));
  const add = () => { if (!name.trim()) return; write(systemsApi.item(r, "upsert", { name: name.trim(), zone: nzone, hygiene: hyg })); setName(""); };
  const ids = new Set(c.zones.map((z) => z.id));
  // a zone filter (from the visual) keeps that space and the hooks inside it
  const groups: { z: Zone | null; items: SysItem[] }[] = [
    ...c.zones.filter((z) => !zone || z.id === zone || (z.kind === "hook" && zoneHolds(c, zone, z)))
      .map((z) => ({ z, items: c.items.filter((i) => i.zone === z.id) })),
    ...(!zone ? [{ z: null, items: c.items.filter((i) => !ids.has(i.zone)) }] : []),
  ].filter((g) => g.z || g.items.length);
  const zname = c.zones.find((z) => z.id === zone)?.name;
  const rowCls = wide
    ? "grid grid-cols-[auto_minmax(8rem,1fr)_minmax(9rem,13rem)_minmax(7rem,9rem)_auto] items-center gap-2"
    : "grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-1.5";
  return (
    <div className="space-y-5" data-systems-items="">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm">
        {HYGIENE.map((h) => (
          <span key={h} className="inline-flex items-center gap-1.5 text-muted-foreground" title={`${h}: ${c.items.filter((i) => i.hygiene === h).length} items`}>
            <Swatch h={h} />{h}<span className="nums text-foreground">{c.items.filter((i) => i.hygiene === h).length}</span>
          </span>
        ))}
        {zone && (
          <button type="button" onClick={() => setZone(null)} title="Show every zone"
            className="ml-auto inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs" data-systems-zonefilter={zone}>
            {zname} <X size={12} />
          </button>
        )}
      </div>
      <div className={cn("grid gap-x-8 gap-y-5", two ? "grid-cols-2" : "grid-cols-1")}>
        {groups.map(({ z, items }) => (
          <section key={z?.id ?? "unplaced"} className="min-w-0" data-systems-itemgroup={z?.id ?? ""}>
            <div className="mb-1.5 flex items-baseline gap-2 border-b pb-1">
              {z ? (
                <button type="button" aria-pressed={zone === z.id} title={zoneTip(z)} onClick={() => setZone(zone === z.id ? null : z.id)}
                  className="min-w-0 truncate rounded text-sm font-medium hover:text-primary">{z.name}</button>
              ) : <span className="text-sm font-medium">Unplaced</span>}
              {z && <span className="shrink-0 text-xs text-muted-foreground">{z.kind}</span>}
              <span className="ml-auto shrink-0 nums text-xs text-muted-foreground">{items.length}</span>
            </div>
            {items.length ? (
              <ul className="space-y-1.5">
                {items.map((it) => (
                  <li key={it.id} data-systems-item={it.id} className={rowCls}>
                    <Swatch h={it.hygiene} />
                    <Field value={it.name} label="Item name" title={it.note || it.name} onCommit={(v) => v && up(it, { name: v })} />
                    {wide ? (
                      <>
                        <ZoneSelect c={c} value={it.zone} label={`${it.name} zone`} onChange={(v) => up(it, { zone: v })} />
                        <HygSelect value={it.hygiene} label={`${it.name} hygiene`} onChange={(h) => up(it, { hygiene: h })} />
                      </>
                    ) : null}
                    <button type="button" title={`Delete ${it.name}`} aria-label={`Delete ${it.name}`} className={iconBtn}
                      onClick={() => write(systemsApi.item(r, "delete", { id: it.id }))}><Trash2 size={14} /></button>
                    {!wide && (
                      <div className="col-span-full grid grid-cols-2 gap-1.5 pl-5">
                        <ZoneSelect c={c} value={it.zone} label={`${it.name} zone`} onChange={(v) => up(it, { zone: v })} />
                        <HygSelect value={it.hygiene} label={`${it.name} hygiene`} onChange={(h) => up(it, { hygiene: h })} />
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            ) : <p className="py-1 text-xs text-muted-foreground/70">empty</p>}
          </section>
        ))}
        {!groups.length && <p className="text-sm text-muted-foreground">No items</p>}
      </div>
      <div className={cn("border-t pt-3", wide ? "grid grid-cols-[minmax(8rem,1fr)_minmax(9rem,13rem)_minmax(7rem,9rem)_auto] items-center gap-2" : "grid grid-cols-2 gap-1.5")}
        data-systems-additem="">
        <Input value={name} placeholder="New item" aria-label="New item" title="New item" className={cn(fieldCls, !wide && "col-span-2")}
          onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }} />
        <ZoneSelect c={c} value={nzone} label="New item zone" onChange={setNzone} />
        <HygSelect value={hyg} label="New item hygiene" onChange={setHyg} />
        <Button size="sm" className={cn("h-8", !wide && "col-span-2")} disabled={!name.trim()} onClick={add}><Plus size={14} /> Add item</Button>
      </div>
    </div>
  );
}
function zoneHolds(c: Component, spaceId: string, hook: Zone) {
  const s = c.zones.find((z) => z.id === spaceId);
  return !!s && s.kind === "space" && !!s.w && !!s.h && hook.x.cm >= s.x.cm - 0.5 && hook.x.cm <= s.x.cm + s.w.cm + 0.5
    && hook.y.cm >= s.y.cm && hook.y.cm <= s.y.cm + s.h.cm;
}

/* ───────────────────────── routines ───────────────────────── */
function RoutinesTab({ c, r, write }: { c: Component; r: Ref; write: Write }) {
  const w = useWidget();
  const wide = !w || w.size === "lg" || w.size === "xl";
  const [nr, setNr] = useState("");
  const save = (rt: Routine) => write(systemsApi.routine(r, "upsert", rt));
  const setStep = (rt: Routine, i: number, patch: Partial<Routine["steps"][number]>) =>
    save({ ...rt, steps: rt.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  const move = (rt: Routine, i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= rt.steps.length) return;
    const steps = rt.steps.slice();
    [steps[i], steps[j]] = [steps[j], steps[i]];
    save({ ...rt, steps });
  };
  return (
    <div className="space-y-6" data-systems-routines="">
      {!c.routines.length && <p className="text-sm text-muted-foreground">No routines</p>}
      {c.routines.map((rt) => (
        <section key={rt.id} data-systems-routine={rt.id} className="space-y-2">
          <div className="flex max-w-xl items-center gap-1.5">
            <Field value={rt.name} label="Routine name" className="text-base font-medium" onCommit={(v) => v && save({ ...rt, name: v })} />
            <span className="shrink-0 nums text-xs text-muted-foreground">{rt.steps.length} steps</span>
            <button type="button" title={`Delete ${rt.name}`} aria-label={`Delete ${rt.name}`} className={iconBtn}
              onClick={() => write(systemsApi.routine(r, "delete", { id: rt.id }))}><Trash2 size={14} /></button>
          </div>
          <ol className="divide-y rounded-md border">
            {rt.steps.map((s, i) => {
              const chips = (
                <div className="flex min-w-0 flex-wrap gap-1">
                  {c.items.map((it) => {
                    const on = s.items.includes(it.id);
                    return (
                      <button key={it.id} type="button" aria-pressed={on} title={on ? `Touches ${it.name}` : `Add ${it.name}`}
                        data-systems-touch={`${s.id}:${it.id}`}
                        onClick={() => setStep(rt, i, { items: on ? s.items.filter((x) => x !== it.id) : [...s.items, it.id] })}
                        className={cn("inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-xs",
                          on ? "border-foreground/30 bg-secondary text-foreground" : "border-dashed text-muted-foreground")}>
                        <Swatch h={it.hygiene} /><span className="truncate">{it.name}</span>
                      </button>
                    );
                  })}
                </div>
              );
              const tools = (
                <div className="flex shrink-0 items-center">
                  <button type="button" title="Move up" aria-label="Move up" disabled={i === 0} className={iconBtn} onClick={() => move(rt, i, -1)}><ArrowUp size={14} /></button>
                  <button type="button" title="Move down" aria-label="Move down" disabled={i === rt.steps.length - 1} className={iconBtn} onClick={() => move(rt, i, 1)}><ArrowDown size={14} /></button>
                  <button type="button" title="Delete step" aria-label="Delete step" className={iconBtn}
                    onClick={() => save({ ...rt, steps: rt.steps.filter((_, j) => j !== i) })}><Trash2 size={14} /></button>
                </div>
              );
              return (
                <li key={s.id} className="p-2.5" data-systems-step={s.id}>
                  {wide ? (
                    <div className="grid grid-cols-[1.5rem_minmax(10rem,16rem)_minmax(0,1fr)_auto] items-start gap-3">
                      <span className="pt-1.5 text-center nums text-sm text-muted-foreground">{i + 1}</span>
                      <div className="min-w-0">
                        <Field value={s.name} label="Step name" onCommit={(v) => v && setStep(rt, i, { name: v })} />
                        {s.note && <p className="mt-1 text-xs text-muted-foreground">{s.note}</p>}
                      </div>
                      <div className="pt-1">{chips}</div>
                      {tools}
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center gap-1">
                        <span className="w-5 shrink-0 text-center nums text-xs text-muted-foreground">{i + 1}</span>
                        <Field value={s.name} label="Step name" onCommit={(v) => v && setStep(rt, i, { name: v })} />
                        {tools}
                      </div>
                      {s.note && <p className="mt-1 pl-6 text-xs text-muted-foreground">{s.note}</p>}
                      <div className="mt-1.5 pl-6">{chips}</div>
                    </>
                  )}
                </li>
              );
            })}
            {!rt.steps.length && <li className="p-2.5 text-xs text-muted-foreground/70">no steps</li>}
          </ol>
          <Button size="sm" variant="outline" className="h-7" onClick={() => save({ ...rt, steps: [...rt.steps, { id: "", name: "New step", items: [] }] })}>
            <Plus size={13} /> Step
          </Button>
        </section>
      ))}
      <div className="flex max-w-xl gap-1.5 border-t pt-3">
        <Input value={nr} placeholder="New routine" aria-label="New routine" title="New routine" className={fieldCls} onChange={(e) => setNr(e.target.value)} />
        <Button size="sm" className="h-8" disabled={!nr.trim()} onClick={() => { save({ id: "", name: nr.trim(), steps: [] } as Routine); setNr(""); }}>
          <Plus size={14} /> Add
        </Button>
      </div>
    </div>
  );
}

/* ───────────────────────── proposals (the plan) ───────────────────────── */
function ProposalsTab({ c, r, write }: { c: Component; r: Ref; write: Write }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"product" | "carry">("product");
  const [zone, setZone] = useState("");
  const [sz, setSz] = useState({ w: "", d: "", h: "" });
  const up = (p: Proposal, patch: Partial<Proposal>) => write(systemsApi.proposal(r, "upsert", { ...p, ...patch }));
  const n = (s: string) => parseFloat(s);
  const ok = name.trim() && ["w", "d", "h"].every((k) => n(sz[k as "w"]) > 0);
  const add = () => {
    if (!ok) return;
    const e = (v: string): Dim => ({ cm: n(v), estimated: true });
    write(systemsApi.proposal(r, "upsert", { name: name.trim(), kind, zone, status: "idea", size: { w: e(sz.w), d: e(sz.d), h: e(sz.h) } }));
    setName(""); setSz({ w: "", d: "", h: "" });
  };
  const lbl = "text-[11px] text-muted-foreground";
  return (
    <div className="grid gap-4" data-systems-proposals=""
      style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(340px, 100%), 1fr))" }}>
      {c.proposals.map((p, i) => {
        const s = p.fit?.state ?? "unknown";
        return (
          <section key={p.id} className={cn("min-w-0 space-y-2.5 rounded-lg border bg-card/50 p-3.5", p.status === "dropped" && "opacity-60")}
            style={s !== "unknown" ? { borderLeft: `3px solid hsl(${fitTone(s)})` } : undefined} data-systems-proposal={p.id}>
            <div className="flex items-center gap-1.5">
              <Num n={i + 1} p={p} />
              <Field value={p.name} label="Proposal name" className="font-medium" onCommit={(v) => v && up(p, { name: v })} />
              <button type="button" title={`Delete ${p.name}`} aria-label={`Delete ${p.name}`} className={iconBtn}
                onClick={() => write(systemsApi.proposal(r, "delete", { id: p.id }))}><Trash2 size={14} /></button>
            </div>
            <div className="flex items-center gap-2 text-sm">
              <span className={lbl}>Fit</span><FitText p={p} />
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              <label className="space-y-0.5"><span className={lbl}>Status</span>
                <select className={cn(selectCls, "w-full")} value={p.status} aria-label={`${p.name} status`} title="Status" data-systems-status={p.id}
                  onChange={(e) => up(p, { status: e.target.value as Proposal["status"] })}>
                  {PSTATUS.map((x) => <option key={x} value={x}>{x}</option>)}
                </select></label>
              <label className="space-y-0.5"><span className={lbl}>Kind</span>
                <select className={cn(selectCls, "w-full")} value={p.kind} aria-label={`${p.name} kind`} title="Kind"
                  onChange={(e) => up(p, { kind: e.target.value as Proposal["kind"] })}>
                  <option value="product">product</option><option value="carry">carry</option>
                </select></label>
              <label className="col-span-full space-y-0.5"><span className={lbl}>Zone</span>
                <ZoneSelect c={c} whole value={p.zone} label={`${p.name} zone`} onChange={(v) => up(p, { zone: v })} /></label>
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
              {(["w", "d", "h"] as const).map((k) => (
                <label key={k} className="inline-flex items-center gap-1">{k}
                  <DimInput value={p.size?.[k]} label={`${p.name} ${k}`}
                    onCommit={(d) => up(p, { size: { ...(p.size ?? { w: d, d, h: d }), [k]: d } as Size })} /></label>
              ))}
            </div>
            {p.kind === "carry" && (
              <Field value={(p.carries ?? []).join(", ")} label="Carries" placeholder="Carries"
                onCommit={(v) => up(p, { carries: v.split(",").map((x) => x.trim()).filter(Boolean) })} />
            )}
            <div className="grid grid-cols-[minmax(0,1fr)_5.5rem] gap-1.5">
              <Field value={p.link ?? ""} label="Link" placeholder="Link" onCommit={(v) => up(p, { link: v || undefined })} />
              <Field value={p.price != null ? String(p.price) : ""} label="Price" placeholder="Price" inputMode="decimal"
                onCommit={(v) => { const x = parseFloat(v); up(p, { price: v === "" ? undefined : isFinite(x) ? x : p.price }); }} />
            </div>
            {p.note && <p className="text-xs text-muted-foreground">{p.note}</p>}
          </section>
        );
      })}
      <section className="min-w-0 space-y-2 rounded-lg border border-dashed p-3.5" data-systems-addproposal="">
        <Input value={name} placeholder="New proposal" aria-label="New proposal" title="New proposal" className={fieldCls}
          onChange={(e) => setName(e.target.value)} />
        <div className="grid grid-cols-2 gap-1.5">
          <select className={selectCls} value={kind} aria-label="New proposal kind" title="Kind" onChange={(e) => setKind(e.target.value as "product")}>
            <option value="product">product</option><option value="carry">carry</option>
          </select>
          <ZoneSelect c={c} whole value={zone} label="New proposal zone" onChange={setZone} />
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {(["w", "d", "h"] as const).map((k) => (
            <Input key={k} type="number" min={0} step="0.5" value={sz[k]} placeholder={k} aria-label={`New proposal ${k} cm`} title={`${k} cm`}
              className="h-8 w-16 px-1.5 text-sm" onChange={(e) => setSz((s) => ({ ...s, [k]: e.target.value }))} />
          ))}
          <Button size="sm" className="h-8" disabled={!ok} onClick={add}><Plus size={14} /> Add</Button>
        </div>
      </section>
    </div>
  );
}

/* ───────────────────────── photo, notes ───────────────────────── */
function PhotoTab({ c, r, write }: { c: Component; r: Ref; write: Write }) {
  const [bad, setBad] = useState(false);
  useEffect(() => setBad(false), [c.id, c.photo]);
  return (
    <div className="space-y-3">
      <label className="flex max-w-xl items-center gap-3 text-sm">
        <span className="w-20 shrink-0 text-muted-foreground">File</span>
        <Field value={c.photo ?? ""} label="Photo file" placeholder="Photo file"
          onCommit={(v) => write(systemsApi.saveComponent(r.domain, r.instance, { id: c.id, photo: v }))} />
      </label>
      {!c.photo || bad
        ? <p className="text-sm text-muted-foreground" data-systems-empty="photo">No photo</p>
        : <img src={systemsApi.photoUrl(r)} alt={`${c.name} reference photo`} title={c.photo} data-systems-photo=""
            className="max-h-[75vh] w-full rounded-md border object-contain" onError={() => setBad(true)} loading="lazy" />}
    </div>
  );
}

function NotesTab({ c, r, write }: { c: Component; r: Ref; write: Write }) {
  const [v, setV] = useState(c.note ?? "");
  useEffect(() => setV(c.note ?? ""), [c.id, c.note]);
  const flush = () => { if (v.trim() !== (c.note ?? "").trim()) return write(systemsApi.saveComponent(r.domain, r.instance, { id: c.id, note: v.trim() })); };
  useSaveKey(flush);
  return (
    <textarea value={v} onChange={(e) => setV(e.target.value)} onBlur={() => { void flush(); }}
      aria-label="Notes" title="Notes" maxLength={1000} data-systems-notes=""
      className="min-h-[18rem] w-full resize-y rounded-md border border-input bg-transparent p-3 text-sm leading-relaxed focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" />
  );
}

export default Systems;
