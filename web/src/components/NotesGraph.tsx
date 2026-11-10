
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useWidget } from "@/components/ui/widget";
import { Card } from "@/components/ui/card";
import {
  Network, Maximize2, Minimize2, X, FileText, Pencil, Save,
  ExternalLink, Search, Link2, Tag, Ghost, Sparkles, Clock, SlidersHorizontal,
  Bookmark, BookmarkPlus, Trash2, Orbit, ArrowLeft, ZoomIn, CornerDownRight,
  FolderInput, Loader2, Star, Archive, Eye,
} from "lucide-react";
import { api } from "@/lib/api";
import type { GraphNode, GraphEdge, NoteGraph, NoteRead, RelatedNote, NoteBlocks as NoteBlocksDoc, NoteMoved, ProjectTarget } from "@/lib/api";
import { useApi, usePersistent } from "@/lib/hooks";
import { useSaveKey } from "@/lib/savekey";
import { Markdown } from "@/lib/markdown";
import { NoteBlocks } from "@/components/NoteBlocks";
import { parseQuery, matchClauses, clauseLabel, dropClause } from "@/lib/notesQuery";
import { toast } from "sonner";

type V2 = { x: number; y: number };
type Cam = { tx: number; ty: number; k: number };
type Colors = { fg: string; muted: string; primary: string; border: string; card: string; bg: string; ring: string };
// what the map keys stand on: a family bubble, or a note (in a family or the ego ring)
type KFocus = { kind: "cluster" | "note"; id: string };

// muted, low-saturation accents per note family — calm, not candy; concept rides the theme accent
const TYPE_HUE: Record<string, string> = {
  idea: "30 52% 52%",
  author: "265 28% 58%",
  reflection: "152 30% 44%",
  inbox: "200 30% 52%",
  meeting: "210 34% 54%",
  project: "18 46% 52%",
  citation: "95 24% 46%",
  concept: "",            // "" => use the theme --primary
};
const CLUSTER_ORDER = ["concept", "author", "idea", "reflection", "inbox", "meeting", "project", "citation"];
const CLUSTER_LABEL: Record<string, string> = {
  concept: "CONCEPTS", author: "AUTHORS", idea: "IDEAS", reflection: "REFLECTIONS", inbox: "INBOX",
  meeting: "MEETINGS", project: "PROJECTS", citation: "CORPUS",
};
const clusterLabel = (t: string) => CLUSTER_LABEL[t] || t.toUpperCase();
const GROUPED_TYPES = new Set(["citation", "project"]);

function typeColor(t: string, c: Colors): string {
  const hue = TYPE_HUE[t];
  return hue ? `hsl(${hue})` : c.primary;
}

const RECENT_DAYS = 14;
const isRecent = (n: GraphNode) => !!n.mtime && Date.now() / 1000 - n.mtime < RECENT_DAYS * 86400;

const clamp = (lo: number, hi: number, x: number) => Math.min(hi, Math.max(lo, x));
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
const GOLDEN = Math.PI * (3 - Math.sqrt(5));   // ~2.39996 — the golden angle, for even spirals

// a tiny deterministic hash → [0,1), so layouts never reshuffle between loads
function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return ((h >>> 0) % 100000) / 100000;
}

// full-detail screen radius of a note glyph (texture px when zoomed out)
const radiusFull = (n: GraphNode) => (n.ghost || n.external ? 3.2
  : clamp(3, 11, 3 + Math.sqrt(n.degree || 0) * 1.8));
const TEX_PX = 1.5, TEX_A = 0.2;

function readColors(host: HTMLElement): Colors {
  const probe = document.createElement("span");
  probe.style.position = "absolute"; probe.style.visibility = "hidden"; probe.style.pointerEvents = "none";
  host.appendChild(probe);
  const get = (expr: string) => { probe.style.color = expr; return getComputedStyle(probe).color || "#888"; };
  const c: Colors = {
    fg: get("hsl(var(--foreground))"), muted: get("hsl(var(--muted-foreground))"),
    primary: get("hsl(var(--primary))"), border: get("hsl(var(--border))"),
    card: get("hsl(var(--card))"), bg: get("hsl(var(--background))"),
    ring: get("hsl(var(--ring))"),
  };
  host.removeChild(probe);
  return c;
}

// ---- the frozen layout ------------------------------------------------------
type Cluster = {
  type: string; label: string; count: number;
  cx: number; cy: number; rb: number; contentR: number;
  memberIds: string[]; nodeIds: string[];   // members; members + attached ghosts/externals
  localPos: Map<string, V2>; rawRadius: number;
  grouped: boolean;   // true = a GROUPED_TYPES family whose content is a NESTED atlas
                       // (idea/project groups as its "clusters") rather than individual
                       // notes laid out here — see buildGroupAtlas + the swap in NotesGraph.
};
type Atlas = {
  clusters: Cluster[];
  clusterOf: Map<string, string>;      // node id -> cluster type
  pos: Map<string, V2>;                // world position for every rendered node
  interEdges: { a: string; b: string; w: number }[];
};

let warmGraph: NoteGraph | null = null;
let warmAtlas: { key: string; atlas: Atlas } | null = null;

const LAYOUT_FORCE_MAX = 600;
// an open family above this many notes gets no live (all-pairs, every frame) simulation
const LIVE_SIM_MAX = 400;
function layoutCluster(S: GraphNode[], intra: GraphEdge[]): Map<string, V2> {
  const n = S.length;
  if (n > LAYOUT_FORCE_MAX) {
    const pos = new Map<string, V2>();
    const ordered = [...S].sort((a, b) => (b.degree || 0) - (a.degree || 0));
    const SP = 26;
    let cx = 0, cy = 0;
    ordered.forEach((nd, i) => {
      const r = SP * Math.sqrt(i + 0.5);
      const a = i * GOLDEN + hash01(nd.id) * 0.5;
      const p = { x: Math.cos(a) * r, y: Math.sin(a) * r };
      pos.set(nd.id, p); cx += p.x; cy += p.y;
    });
    cx /= n; cy /= n;
    for (const p of pos.values()) { p.x -= cx; p.y -= cy; }
    return pos;
  }
  const pos = new Map<string, V2>(), vel = new Map<string, V2>();
  const ordered = [...S].sort((a, b) => (b.degree || 0) - (a.degree || 0));  // hubs toward the centre
  const SP = 26;
  ordered.forEach((nd, i) => {
    const r = SP * Math.sqrt(i + 0.5);
    const a = i * GOLDEN + hash01(nd.id) * 0.5;
    pos.set(nd.id, { x: Math.cos(a) * r, y: Math.sin(a) * r });
    vel.set(nd.id, { x: 0, y: 0 });
  });
  if (n === 1) { pos.set(S[0].id, { x: 0, y: 0 }); return pos; }
  if (n === 0) return pos;
  const ids = ordered.map((d) => d.id);
  const ticks = clamp(24, 150, Math.round(6000 / n));
  const REP = SP * SP * 7;
  for (let t = 0; t < ticks; t++) {
    const cool = 1 - t / ticks;
    for (let i = 0; i < n; i++) {
      const a = pos.get(ids[i])!, va = vel.get(ids[i])!;
      for (let j = i + 1; j < n; j++) {
        const b = pos.get(ids[j])!, vb = vel.get(ids[j])!;
        let dx = a.x - b.x, dy = a.y - b.y, d2 = dx * dx + dy * dy;
        if (d2 < 1) { dx = hash01(ids[i] + ids[j]) - 0.5; dy = hash01(ids[j] + ids[i]) - 0.5; d2 = 1; }
        const d = Math.sqrt(d2), f = REP / d2, fx = (dx / d) * f, fy = (dy / d) * f;
        va.x += fx; va.y += fy; vb.x -= fx; vb.y -= fy;
      }
    }
    for (const e of intra) {
      const a = pos.get(e.source), b = pos.get(e.target), va = vel.get(e.source), vb = vel.get(e.target);
      if (!a || !b || !va || !vb) continue;
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
      const f = (d - SP * 2.0) * 0.06, fx = (dx / d) * f, fy = (dy / d) * f;
      va.x += fx; va.y += fy; vb.x -= fx; vb.y -= fy;
    }
    for (const id of ids) {
      const p = pos.get(id)!, v = vel.get(id)!;
      v.x += -p.x * 0.008; v.y += -p.y * 0.008;   // low gravity → an even spread, not a central clump
      v.x *= 0.84; v.y *= 0.84;
      const step = 0.15 + 0.85 * cool;
      p.x += v.x * step; p.y += v.y * step;
    }
  }
  let cx = 0, cy = 0;
  for (const p of pos.values()) { cx += p.x; cy += p.y; }
  cx /= n; cy /= n;
  for (const p of pos.values()) { p.x -= cx; p.y -= cy; }
  return pos;
}

function buildAtlas(nodes: GraphNode[], edges: GraphEdge[]): Atlas {
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const linkAdj = new Map<string, string[]>();
  const push = (a: string, b: string) => { (linkAdj.get(a) || linkAdj.set(a, []).get(a)!).push(b); };
  for (const e of edges) { if (e.kind !== "link") continue; push(e.source, e.target); push(e.target, e.source); }

  const filed = nodes.filter((n) => !n.ghost && !n.external);
  const present: string[] = CLUSTER_ORDER.filter((t) => filed.some((n) => n.type === t));
  for (const n of filed) if (!present.includes(n.type)) present.push(n.type);

  // every node knows its family; ghosts/externals inherit their best-linked neighbour's
  const clusterOf = new Map<string, string>();
  filed.forEach((n) => clusterOf.set(n.id, n.type));
  for (const x of nodes) {
    if (!x.ghost && !x.external) continue;
    const nbrs = (linkAdj.get(x.id) || []).map((id) => byId.get(id)).filter((n): n is GraphNode => !!n && clusterOf.has(n.id));
    if (!nbrs.length) continue;
    nbrs.sort((a, b) => (b.degree || 0) - (a.degree || 0));
    clusterOf.set(x.id, clusterOf.get(nbrs[0].id)!);
  }

  const clusters: Cluster[] = present.map((type) => {
    const members = filed.filter((n) => n.type === type);
    const attached = nodes.filter((n) => (n.ghost || n.external) && clusterOf.get(n.id) === type);
    const S = members.concat(attached);
    const ids = new Set(S.map((n) => n.id));
    const grouped = GROUPED_TYPES.has(type);
    const localPos = grouped ? new Map<string, V2>() : layoutCluster(S, edges.filter((e) => e.kind === "link" && ids.has(e.source) && ids.has(e.target)));
    let rr = 1;
    for (const p of localPos.values()) rr = Math.max(rr, Math.hypot(p.x, p.y));
    return {
      type, label: clusterLabel(type), count: members.length,
      cx: 0, cy: 0, rb: clamp(42, 150, 26 * Math.sqrt(Math.max(1, members.length))), contentR: 0,
      memberIds: members.map((n) => n.id), nodeIds: S.map((n) => n.id), localPos, rawRadius: rr,
      grouped,
    };
  }).filter((c) => c.count > 0);

  // ring the families so neighbouring bubbles never touch
  const N = clusters.length, ang = N ? (2 * Math.PI) / N : 0;
  let R = 0;
  for (let i = 0; N > 1 && i < N; i++) {
    const j = (i + 1) % N, need = clusters[i].rb + clusters[j].rb + 76;
    R = Math.max(R, need / (2 * Math.sin(ang / 2)));
  }
  const pos = new Map<string, V2>();
  clusters.forEach((c, i) => {
    const a = N === 1 ? 0 : -Math.PI / 2 + i * ang;
    c.cx = N === 1 ? 0 : Math.cos(a) * R;
    c.cy = N === 1 ? 0 : Math.sin(a) * R;
    c.contentR = c.rb * 0.82;
    const scale = c.contentR / Math.max(1, c.rawRadius);
    for (const [id, lp] of c.localPos) pos.set(id, { x: c.cx + lp.x * scale, y: c.cy + lp.y * scale });
  });

  const interMap = new Map<string, number>();
  for (const e of edges) {
    if (e.kind !== "link") continue;
    const ca = clusterOf.get(e.source), cb = clusterOf.get(e.target);
    if (!ca || !cb || ca === cb) continue;
    const key = ca < cb ? ca + "|" + cb : cb + "|" + ca;
    interMap.set(key, (interMap.get(key) || 0) + 1);
  }
  const interEdges = [...interMap].map(([k, w]) => { const [a, b] = k.split("|"); return { a, b, w }; });

  return { clusters, clusterOf, pos, interEdges };
}

function buildGroupAtlas(type: string, allNodes: GraphNode[], allEdges: GraphEdge[]): Atlas {
  const memberIds = new Set(allNodes.filter((n) => n.type === type).map((n) => n.id));
  const groupSize = new Map<string, number>();
  for (const n of allNodes) {
    if (!memberIds.has(n.id)) continue;
    const g = n.group || "Other";
    groupSize.set(g, (groupSize.get(g) || 0) + 1);
  }
  const relabeled = allNodes
    .filter((n) => memberIds.has(n.id))
    .map((n) => ({ ...n, type: n.group || "Other" }))
    .sort((a, b) => (groupSize.get(b.type) || 0) - (groupSize.get(a.type) || 0));
  const relevantEdges = allEdges.filter((e) =>
    (e.kind === "link" || e.kind === "similar") && memberIds.has(e.source) && memberIds.has(e.target));
  return buildAtlas(relabeled, relevantEdges.map((e) => ({ ...e, kind: "link" as const })));
}
// nested atlases, once per data version: re-entering a family is instant. Entries of an
// older structKey are dropped whenever a new one arrives.
const groupAtlasCache = new Map<string, Atlas>();
function cachedGroupAtlas(structKey: string, type: string, allNodes: GraphNode[], allEdges: GraphEdge[]): Atlas {
  const key = structKey + "\u0000" + type;
  const hit = groupAtlasCache.get(key);
  if (hit) return hit;
  for (const k of [...groupAtlasCache.keys()]) if (!k.startsWith(structKey + "\u0000")) groupAtlasCache.delete(k);
  const a = buildGroupAtlas(type, allNodes, allEdges);
  groupAtlasCache.set(key, a);
  return a;
}

// camera framings (pure — read atlas + viewport size, no closures over state)
function fit(minX: number, minY: number, maxX: number, maxY: number, w: number, h: number, pad: number, kMin: number, kMax: number): Cam {
  const bw = Math.max(40, maxX - minX), bh = Math.max(40, maxY - minY);
  const k = clamp(kMin, kMax, Math.min((w - 2 * pad) / bw, (h - 2 * pad) / bh));
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  return { tx: w / 2 - cx * k, ty: h / 2 - cy * k, k };
}
function frameOverview(atlas: Atlas, w: number, h: number): Cam {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const cl of atlas.clusters) {
    a = Math.min(a, cl.cx - cl.rb); b = Math.min(b, cl.cy - cl.rb);
    c = Math.max(c, cl.cx + cl.rb); d = Math.max(d, cl.cy + cl.rb);
  }
  if (!isFinite(a)) return { tx: w / 2, ty: h / 2, k: 1 };
  return fit(a, b, c, d, w, h, 60, 0.05, 1.25);
}
function frameCluster(atlas: Atlas, w: number, h: number, type: string): Cam {
  const cl = atlas.clusters.find((x) => x.type === type);
  if (!cl) return frameOverview(atlas, w, h);
  // frame so the bloomed family FILLS the viewport (siblings off-screen) — the even spread
  // is what kills overlap; a small margin keeps edge labels from clipping
  const r = cl.contentR * 1.18 + 14;
  return fit(cl.cx - r, cl.cy - r, cl.cx + r, cl.cy + r, w, h, 46, 0.1, 2.8);
}
// the ego ring, fit to its content (on entry, and on the fit key)
function frameEgo(el: { R: number; pos: Map<string, V2> }, w: number, h: number): Cam {
  let minX = -el.R, minY = -el.R, maxX = el.R, maxY = el.R;
  for (const p of el.pos.values()) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  return fit(minX, minY, maxX, maxY, w, h, 60, 0.2, 2.5);
}
// the vault file `o` opens through lib/arrownav.ts (data-obsidian-file), when a node has one
const noteFile = (n: GraphNode): string | null => (!n.ghost && !n.external && !n.synthetic && n.path ? n.path : null);

const INTRO_MS = 760;
type SavedView = { name: string; q: string; typeOff: string[]; tagFilter: string; showTags: boolean; showExternal: boolean; orphansOnly: boolean; recentsOnly: boolean };

export function NotesGraph({ embedded, focusId, focusNonce }:
  { embedded?: boolean; focusId?: string; focusNonce?: number } = {}) {
  const g = useApi(() => api.notesGraph().then((d) => { warmGraph = d; return d; }), [], 0);
  const [full, setFull] = useState(false);
  const [q, setQ] = useState("");
  const [typeOff, setTypeOff] = useState<Set<string>>(new Set());
  const [tagFilter, setTagFilter] = useState<string>("");
  const [showTags, setShowTags] = useState(false);
  const [showExternal, setShowExternal] = useState(false);
  const [orphansOnly, setOrphansOnly] = useState(false);
  const [recentsOnly, setRecentsOnly] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [showViews, setShowViews] = useState(false);
  const [savedViews, setSavedViews] = usePersistent<SavedView[]>("ng-saved-views", []);
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const [active, setActive] = useState<string | null>(null);   // the family we've dived into (null = overview)
  const [corpusHits, setCorpusHits] = useState<GraphNode[]>([]);
  const [insideGroupFamily, setInsideGroupFamily] = useState<string | null>(null);
  const [egoId, setEgoId] = useState<string | null>(null);         // ego-network focus (null = not in ego mode)
  const [egoTrail, setEgoTrail] = useState<GraphNode[]>([]);       // the surf path — the THREAD you're following
  const [mapKeys, setMapKeys] = useState(false);                   // ⏎ on the map handed it the keys
  const [kFocus, setKFocus] = useState<KFocus | null>(null);       // the node the keys stand on
  const [bookmarks, setBookmarks] = usePersistent<string[]>("ng-bookmarks", []);
  const [showBookmarks, setShowBookmarks] = useState(false);
  // inside a widget: a narrow tile keeps search + filters and leaves the type chips to
  // its focused view, which is the whole atlas
  const tile = useWidget();
  const narrowTile = !!tile && !tile.focused && (tile.size === "xs" || tile.size === "sm");

  const data = g.data || warmGraph;
  const parsed = useMemo(() => parseQuery(q), [q]);

  const structKey = useMemo(() => {
    if (!data) return "";
    let h = 2166136261;
    const mix = (s: string) => { for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); };
    for (const n of data.nodes) { mix(n.id); mix(n.type); }
    for (const e of data.edges) { mix(e.source); mix(e.target); mix(e.kind); }
    return `${data.nodes.length}:${data.edges.length}:${h >>> 0}`;
  }, [data]);
  const dataForAtlas = useRef(data);
  dataForAtlas.current = data;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const atlas = useMemo(() => {
    if (!dataForAtlas.current) return null;
    if (warmAtlas && warmAtlas.key === structKey) return warmAtlas.atlas;   // instant remount
    const a = buildAtlas(dataForAtlas.current.nodes, dataForAtlas.current.edges);
    if (a) warmAtlas = { key: structKey, atlas: a };
    return a;
  }, [structKey]);
  // a grouped family's nested atlas — recomputed only when its structural shape
  // (or which family we're inside) changes, same memoization discipline as `atlas`
  const groupAtlas = useMemo(() => (
    insideGroupFamily && dataForAtlas.current
      ? cachedGroupAtlas(structKey, insideGroupFamily, dataForAtlas.current.nodes, dataForAtlas.current.edges)
      : null
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [insideGroupFamily, structKey]);
  const displayAtlas = insideGroupFamily ? groupAtlas : atlas;
  const nodeById = useMemo(() => {
    const m = new Map<string, GraphNode>();
    (data?.nodes || []).forEach((n) => m.set(n.id, n));
    return m;
  }, [data]);

  useEffect(() => {
    const term = parsed.text.trim();
    setCorpusHits([]);                       // never show the previous term's hits while typing
    if (!term) return;
    let live = true;
    const t = setTimeout(() => {
      api.notesSearch(term, 60).then((r) => { if (live) setCorpusHits(r.nodes || []); }).catch(() => {});
    }, 240);
    return () => { live = false; clearTimeout(t); };
  }, [parsed.text]);

  // structural filters (type chips, orphans, recents, tag, clauses) → which notes are visible.
  // These only change a note's alpha; they never relayout, so nothing moves.
  const visibleNotes = useMemo(() => {
    const clauses = parsed.clauses;
    const keep = (n: GraphNode) => {
      if (n.ghost || n.external) return true;       // overlays gated separately at draw time
      if (typeOff.has(n.type)) return false;
      if (orphansOnly && !n.orphan) return false;
      if (recentsOnly && !isRecent(n)) return false;
      if (tagFilter && !(n.tags || []).includes(tagFilter)) return false;
      if (clauses.length && !matchClauses(n, clauses)) return false;
      return true;
    };
    const s = new Set<string>();
    (data?.nodes || []).forEach((n) => { if (keep(n)) s.add(n.id); });
    return s;
  }, [data, typeOff, orphansOnly, recentsOnly, tagFilter, parsed.clauses]);

  // free-text spotlight — dims everything that doesn't match (local title/tag/type/folder)
  const spotlight = useMemo(() => {
    const toks = parsed.terms;
    if (!toks.length) return null;
    const s = new Set<string>();
    (data?.nodes || []).forEach((n) => {
      const hay = `${n.title} ${(n.tags || []).join(" ")} ${n.type} ${n.folder}`.toLowerCase();
      if (toks.every((t) => hay.includes(t))) s.add(n.id);
    });
    return s;
  }, [data, parsed.terms]);

  const MAX_EGO_NEIGHBORS = 60;
  const egoLayout = useMemo(() => {
    if (!egoId || !data) return null;
    const center = nodeById.get(egoId);
    if (!center) return null;
    const rows: { n: GraphNode; e: GraphEdge }[] = [];
    const seen = new Set<string>();
    for (const e of data.edges) {
      let otherId: string | null = null;
      if (e.source === egoId) otherId = e.target;
      else if (e.target === egoId) otherId = e.source;
      if (!otherId || seen.has(otherId)) continue;
      const other = nodeById.get(otherId);
      if (!other) continue;
      seen.add(otherId);
      rows.push({ n: other, e });
    }
    const kindRank: Record<string, number> = { link: 0, similar: 1, tag: 2 };
    rows.sort((a, b) => (kindRank[a.e.kind] - kindRank[b.e.kind]) || (b.n.degree || 0) - (a.n.degree || 0));
    const shown: { n: GraphNode; e: GraphEdge }[] = rows.slice(0, MAX_EGO_NEIGHBORS);
    let overflow = rows.length - shown.length;
    const pos = new Map<string, V2>();
    pos.set(egoId, { x: 0, y: 0 });
    const R = clamp(90, 300, 30 * Math.sqrt(Math.max(1, shown.length)));
    const ang = shown.length ? (2 * Math.PI) / shown.length : 0;
    shown.forEach((row, i) => {
      const a = -Math.PI / 2 + i * ang;
      pos.set(row.n.id, { x: Math.cos(a) * R, y: Math.sin(a) * R });
    });
    return { center, rows: shown, pos, R, overflow };
  }, [egoId, data, nodeById]);

  // ---- refs the render loop reads
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const atlasRef = useRef<Atlas | null>(null);
  const camRef = useRef<Cam>({ tx: 0, ty: 0, k: 1 });
  const egoCamRef = useRef<Cam>({ tx: 0, ty: 0, k: 1 });   // independent camera for ego mode — its own tiny coordinate space
  const egoIdRef = useRef<string | null>(null);
  const egoLayoutRef = useRef<typeof egoLayout>(null);
  const egoHoverRef = useRef<string | null>(null);
  const preEgoRef = useRef<{ active: string | null; detail: number; cam: Cam; insideGroupFamily: string | null } | null>(null);
  const detailRef = useRef(0);                  // 0 overview … 1 inside a family
  const activeRef = useRef<string | null>(null);
  const transRef = useRef<{ t0: number; dur: number; from: Cam; to: Cam; dFrom: number; dTo: number; clear: boolean } | null>(null);
  const introRef = useRef<{ t0: number } | null>(null);
  const sizeRef = useRef({ w: 0, h: 0, dpr: 1 });
  const colorsRef = useRef<Colors | null>(null);
  const visRef = useRef<Set<string>>(new Set());
  const spotRef = useRef<Set<string> | null>(null);
  const selRef = useRef<string | null>(null);
  const hoverRef = useRef<{ kind: "cluster" | "note"; id: string } | null>(null);
  const showExtRef = useRef(false);
  const showTagsRef = useRef(false);
  const pulseRef = useRef(0);
  // the dived-in family is a LIVE, gentle, interactive force field (overview stays frozen).
  // simAlpha is its heat: >0 while it's settling or being dragged, 0 = perfectly still.
  const simAlphaRef = useRef(0);
  const velRef = useRef<Map<string, V2>>(new Map());
  const dragNodeRef = useRef<string | null>(null);   // a note being dragged inside its family
  const dragRef = useRef<{ panning: boolean; moved: boolean; lx: number; ly: number; downId: string | null; downKind: "cluster" | "note" | null }>(
    { panning: false, moved: false, lx: 0, ly: 0, downId: null, downKind: null });
  const clickTimerRef = useRef(0);
  useEffect(() => () => window.clearTimeout(clickTimerRef.current), []);

  // mirrors so the render loop can read live data/filters without being torn down
  const dataRef = useRef(data);
  const nodeByIdRef = useRef(nodeById);
  const typeOffRef = useRef(typeOff);
  useEffect(() => { atlasRef.current = displayAtlas; }, [displayAtlas]);
  useEffect(() => { dataRef.current = data; }, [data]);
  useEffect(() => { nodeByIdRef.current = nodeById; }, [nodeById]);
  useEffect(() => { typeOffRef.current = typeOff; }, [typeOff]);
  useEffect(() => { selRef.current = selected?.id || null; }, [selected]);
  useEffect(() => { visRef.current = visibleNotes; }, [visibleNotes]);
  useEffect(() => { spotRef.current = spotlight; }, [spotlight]);
  useEffect(() => { showExtRef.current = showExternal; }, [showExternal]);
  useEffect(() => { showTagsRef.current = showTags; }, [showTags]);
  useEffect(() => {
    egoLayoutRef.current = egoLayout;
    if (!egoLayout) return;
    const { w, h } = sizeRef.current;
    if (!w) return;
    // fit-to-content, immediate — ego mode is a lightweight secondary surface, no eased tween needed
    egoCamRef.current = frameEgo(egoLayout, w, h);
  }, [egoLayout]);

  const mapKeysRef = useRef(false);
  const kFocusRef = useRef<KFocus | null>(null);
  const keyLabelRef = useRef<HTMLDivElement | null>(null);
  const mapStopRef = useRef<HTMLDivElement | null>(null);   // the map's arrow stop, a layer over the canvas
  const orderRef = useRef<{ key: string; mode: "near" | "family"; ids: KFocus[] } | null>(null);
  const camDirtyRef = useRef(false);
  const resumeKeysRef = useRef(false);   // a drawer opened from the keys hands them back when it closes
  const claimKeys = (on: boolean) => { mapKeysRef.current = on; setMapKeys(on); };
  const setKeyFocus = (f: KFocus | null) => { kFocusRef.current = f; setKFocus(f); };
  /** where a key-focused node is drawn right now (screen px + glyph radius), or null
   *  when it is not on the map at this level. Reads refs only: the render loop calls it. */
  const spotOf = (f: KFocus | null): { x: number; y: number; r: number } | null => {
    if (!f) return null;
    if (egoIdRef.current) {
      const el = egoLayoutRef.current, p = el?.pos.get(f.id), n = nodeByIdRef.current.get(f.id);
      if (f.kind !== "note" || !el || !p || !n) return null;
      const cam = egoCamRef.current;
      return { x: cam.tx + p.x * cam.k, y: cam.ty + p.y * cam.k, r: radiusFull(n) + (f.id === el.center.id ? 5 : 2) };
    }
    const at = atlasRef.current;
    if (!at) return null;
    const cam = camRef.current;
    const inside = !!activeRef.current && detailRef.current > 0.5;
    if (f.kind === "cluster") {
      const cl = inside ? null : at.clusters.find((x) => x.type === f.id);
      return cl ? { x: cam.tx + cl.cx * cam.k, y: cam.ty + cl.cy * cam.k, r: cl.rb * cam.k } : null;
    }
    const p = at.pos.get(f.id), n = nodeByIdRef.current.get(f.id);
    if (!inside || !p || !n || at.clusterOf.get(f.id) !== activeRef.current) return null;
    return { x: cam.tx + p.x * cam.k, y: cam.ty + p.y * cam.k, r: lerp(TEX_PX, radiusFull(n), detailRef.current) };
  };
  const initRef = useRef(false);        // has the opening fly-in played once
  const framedOnceRef = useRef(false);  // has the camera been framed for the current canvas size

  const now = () => performance.now();
  const startTransition = useCallback((to: Cam, dTo: number, dur: number, clear: boolean) => {
    transRef.current = { t0: now(), dur, from: { ...camRef.current }, to, dFrom: detailRef.current, dTo, clear };
  }, []);
  const cancelTransition = useCallback(() => {
    // freeze where we are — detailRef already holds the live interpolated value, so no pop.
    // only finish a back-out if it had essentially completed.
    const tr = transRef.current;
    transRef.current = null;
    if (tr && tr.clear && detailRef.current < 0.05) activeRef.current = null;
  }, []);

  const enterCluster = useCallback((type: string) => {
    const at = atlasRef.current; const { w, h } = sizeRef.current;
    if (!at || !w) return;
    const wasNull = activeRef.current === null;
    activeRef.current = type; setActive(type);
    // wake the family's gentle field so it blooms into an even spread on arrival, then stills
    velRef.current.clear(); dragNodeRef.current = null; simAlphaRef.current = 0.55;
    startTransition(frameCluster(at, w, h, type), 1, wasNull ? 640 : 560, false);
  }, [startTransition]);

  const backToOverview = useCallback(() => {
    const at = atlasRef.current; const { w, h } = sizeRef.current;
    setActive(null);
    simAlphaRef.current = 0; dragNodeRef.current = null;
    if (!at || !w) { activeRef.current = null; detailRef.current = 0; transRef.current = null; return; }
    startTransition(frameOverview(at, w, h), 0, 560, true);
  }, [startTransition]);

  const replayIntro = useCallback(() => {
    const at = atlasRef.current; const { w, h } = sizeRef.current;
    if (!at || !w) return;
    activeRef.current = null; setActive(null); detailRef.current = 0; transRef.current = null;
    const ov = frameOverview(at, w, h);
    camRef.current = { tx: ov.tx + (w / 2 - ov.tx) * 0.14, ty: ov.ty + (h / 2 - ov.ty) * 0.14, k: ov.k * 0.9 };
    introRef.current = { t0: now() };
    startTransition(ov, 0, INTRO_MS, false);
  }, [startTransition]);

  const enterGroupedFamily = useCallback((type: string) => { setInsideGroupFamily(type); }, []);

  const exitGroupedFamily = useCallback(() => {
    const parentType = insideGroupFamily;
    setInsideGroupFamily(null);
    const { w, h } = sizeRef.current;
    if (atlas && w && parentType) {
      activeRef.current = parentType; setActive(parentType);
      detailRef.current = 1; transRef.current = null;
      camRef.current = frameCluster(atlas, w, h, parentType);
    }
  }, [atlas, insideGroupFamily]);

  const prevInsideRef = useRef<string | null>(null);
  useEffect(() => {
    const { w, h } = sizeRef.current;
    if (insideGroupFamily && insideGroupFamily !== prevInsideRef.current && groupAtlas && w) {
      activeRef.current = null; setActive(null); detailRef.current = 0; transRef.current = null;
      const ov = frameOverview(groupAtlas, w, h);
      camRef.current = { tx: ov.tx + (w / 2 - ov.tx) * 0.14, ty: ov.ty + (h / 2 - ov.ty) * 0.14, k: ov.k * 0.9 };
      introRef.current = { t0: now() };
      startTransition(ov, 0, INTRO_MS, false);
    }
    prevInsideRef.current = insideGroupFamily;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [insideGroupFamily, groupAtlas]);

  const enterFamily = useCallback((type: string) => {
    if (!insideGroupFamily && GROUPED_TYPES.has(type)) enterGroupedFamily(type);
    else enterCluster(type);
  }, [insideGroupFamily, enterGroupedFamily, enterCluster]);

  const handleBack = useCallback(() => {
    if (insideGroupFamily && activeRef.current === null) exitGroupedFamily();
    else backToOverview();
  }, [insideGroupFamily, exitGroupedFamily, backToOverview]);

  // ---- the render loop: size, theme, camera tween, draw. No physics.
  useEffect(() => {
    const canvas = canvasRef.current, wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    colorsRef.current = readColors(wrap);
    framedOnceRef.current = false;

    const resize = () => {
      const r = wrap.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      sizeRef.current = { w: r.width, h: r.height, dpr };
      canvas.width = Math.round(r.width * dpr);
      canvas.height = Math.round(r.height * dpr);
      canvas.style.width = r.width + "px";
      canvas.style.height = r.height + "px";
      const at = atlasRef.current;
      // frame ONCE for this canvas (its first sized frame / a full-screen swap); after that,
      // never snap on a stray resize — the user's pan/zoom is theirs to keep.
      if (at && r.width && !framedOnceRef.current) {
        camRef.current = activeRef.current ? frameCluster(at, r.width, r.height, activeRef.current) : frameOverview(at, r.width, r.height);
        framedOnceRef.current = true;
      }
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    const mo = new MutationObserver(() => { colorsRef.current = readColors(wrap); });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });

    let famMemo: { at: Atlas; dat: NoteGraph; type: string; ids: Set<string>; edges: GraphEdge[]; links: GraphEdge[] } | null = null;
    const familyOf = (at: Atlas, dat: NoteGraph, cl: Cluster) => {
      if (famMemo && famMemo.at === at && famMemo.dat === dat && famMemo.type === cl.type) return famMemo;
      const ids = new Set(cl.nodeIds);
      const edges = dat.edges.filter((e) => ids.has(e.source) && ids.has(e.target));
      famMemo = { at, dat, type: cl.type, ids, edges, links: edges.filter((e) => e.kind === "link") };
      return famMemo;
    };

    const clusterTick = (cl: Cluster) => {
      const at = atlasRef.current; if (!at) return;
      const pos = at.pos, vel = velRef.current, ids = cl.nodeIds, n = ids.length;
      const drag = dragNodeRef.current;
      const REP = cl.contentR * cl.contentR * 0.065;
      for (let i = 0; i < n; i++) {
        const a = pos.get(ids[i]); if (!a) continue;
        let va = vel.get(ids[i]); if (!va) { va = { x: 0, y: 0 }; vel.set(ids[i], va); }
        for (let j = i + 1; j < n; j++) {
          const b = pos.get(ids[j]); if (!b) continue;
          let vb = vel.get(ids[j]); if (!vb) { vb = { x: 0, y: 0 }; vel.set(ids[j], vb); }
          let dx = a.x - b.x, dy = a.y - b.y, d2 = dx * dx + dy * dy;
          if (d2 < 1) { dx = hash01(ids[i] + ids[j]) - 0.5; dy = hash01(ids[j] + ids[i]) - 0.5; d2 = 1; }
          const d = Math.sqrt(d2), f = REP / d2, fx = (dx / d) * f, fy = (dy / d) * f;
          va.x += fx; va.y += fy; vb.x -= fx; vb.y -= fy;
        }
      }
      const dat = dataRef.current;
      if (dat) {
        const rest = cl.contentR * 0.55;
        for (const e of familyOf(at, dat, cl).links) {
          const a = pos.get(e.source), b = pos.get(e.target), va = vel.get(e.source), vb = vel.get(e.target);
          if (!a || !b || !va || !vb) continue;
          const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
          const f = (d - rest) * 0.02, fx = (dx / d) * f, fy = (dy / d) * f;
          va.x += fx; va.y += fy; vb.x -= fx; vb.y -= fy;
        }
      }
      const G = 0.0025, lim = cl.contentR * 1.15;
      for (const id of ids) {
        const p = pos.get(id), v = vel.get(id); if (!p || !v) continue;
        if (id === drag) { v.x = 0; v.y = 0; continue; }   // pinned to the pointer
        v.x += (cl.cx - p.x) * G; v.y += (cl.cy - p.y) * G;
        const ox = p.x - cl.cx, oy = p.y - cl.cy, or = Math.hypot(ox, oy) || 1;
        if (or > lim) { const pull = (or - lim) * 0.06; v.x -= (ox / or) * pull; v.y -= (oy / or) * pull; }
        v.x *= 0.80; v.y *= 0.80;
        p.x += v.x; p.y += v.y;
      }
      if (!drag) { let a = simAlphaRef.current * 0.94; if (a < 0.004) a = 0; simAlphaRef.current = a; }
    };

    let raf = 0;
    const step = () => {
      const t = now();
      const tr = transRef.current;
      if (tr) {
        const p = clamp01((t - tr.t0) / tr.dur), e = easeInOut(p);
        camRef.current = { tx: lerp(tr.from.tx, tr.to.tx, e), ty: lerp(tr.from.ty, tr.to.ty, e), k: lerp(tr.from.k, tr.to.k, e) };
        detailRef.current = lerp(tr.dFrom, tr.dTo, e);
        if (p >= 1) { camRef.current = tr.to; detailRef.current = tr.dTo; if (tr.clear) activeRef.current = null; transRef.current = null; }
      }
      const at2 = atlasRef.current, aType = activeRef.current;
      if (!egoIdRef.current && at2 && aType && detailRef.current > 0.9 && !transRef.current) {
        const cl = at2.clusters.find((x) => x.type === aType);
        // a family above LIVE_SIM_MAX stays frozen; a dragged note there just follows the pointer
        if (cl && cl.nodeIds.length <= LIVE_SIM_MAX && (simAlphaRef.current > 0.004 || dragNodeRef.current)) clusterTick(cl);
      }
      pulseRef.current += 0.045;
      draw(ctx);
      drawKeyFocus(ctx);
      raf = requestAnimationFrame(step);
    };

    const project = (p: V2): V2 => { const cam = camRef.current; return { x: cam.tx + p.x * cam.k, y: cam.ty + p.y * cam.k }; };
    const projectEgo = (p: V2): V2 => { const cam = egoCamRef.current; return { x: cam.tx + p.x * cam.k, y: cam.ty + p.y * cam.k }; };

    const drawEgo = (ctx: CanvasRenderingContext2D) => {
      const el = egoLayoutRef.current, c = colorsRef.current;
      const { w, h, dpr } = sizeRef.current;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      if (!el || !c) return;
      const hover = egoHoverRef.current;
      const centerP = projectEgo(el.pos.get(el.center.id) || { x: 0, y: 0 });

      // edges — centre to each neighbour, dashed for 'tag' (mirrors the atlas convention)
      for (const row of el.rows) {
        const p = el.pos.get(row.n.id); if (!p) continue;
        const sp = projectEgo(p);
        ctx.beginPath(); ctx.moveTo(centerP.x, centerP.y); ctx.lineTo(sp.x, sp.y);
        ctx.strokeStyle = c.border; ctx.lineWidth = row.e.kind === "similar" ? 1.4 : 1.1;
        ctx.globalAlpha = hover && hover !== row.n.id ? 0.14 : 0.4;
        if (row.e.kind === "tag") ctx.setLineDash([3, 3]); else ctx.setLineDash([]);
        ctx.stroke();
      }
      ctx.setLineDash([]); ctx.globalAlpha = 1;

      // neighbour glyphs + labels
      ctx.textAlign = "center";
      for (const row of el.rows) {
        const p = el.pos.get(row.n.id); if (!p) continue;
        const sp = projectEgo(p);
        const r = radiusFull(row.n) + 2;
        const isHover = hover === row.n.id;
        ctx.globalAlpha = hover && !isHover ? 0.35 : 1;
        ctx.beginPath(); ctx.arc(sp.x, sp.y, r, 0, Math.PI * 2);
        ctx.fillStyle = row.n.ghost || row.n.external ? c.muted : typeColor(row.n.type, c);
        ctx.fill();
        if (isHover) { ctx.lineWidth = 1.6; ctx.strokeStyle = c.primary; ctx.stroke(); }
        ctx.font = "11px ui-sans-serif, system-ui, sans-serif"; ctx.textBaseline = "top";
        const label = row.n.title.length > 26 ? row.n.title.slice(0, 25) + "…" : row.n.title;
        ctx.fillStyle = c.bg; ctx.lineWidth = 3; ctx.strokeStyle = c.bg; ctx.strokeText(label, sp.x, sp.y + r + 3);
        ctx.fillStyle = c.fg; ctx.fillText(label, sp.x, sp.y + r + 3);
      }
      ctx.globalAlpha = 1;

      // the centre node — bigger, primary-ringed, always fully lit
      const cr = radiusFull(el.center) + 5;
      ctx.beginPath(); ctx.arc(centerP.x, centerP.y, cr, 0, Math.PI * 2);
      ctx.fillStyle = typeColor(el.center.type, c); ctx.fill();
      ctx.lineWidth = 2.2; ctx.strokeStyle = c.primary; ctx.stroke();
      ctx.font = "600 12px ui-sans-serif, system-ui, sans-serif"; ctx.textBaseline = "bottom";
      const clabel = el.center.title.length > 34 ? el.center.title.slice(0, 33) + "…" : el.center.title;
      ctx.fillStyle = c.bg; ctx.lineWidth = 3.5; ctx.strokeStyle = c.bg; ctx.strokeText(clabel, centerP.x, centerP.y - cr - 4);
      ctx.fillStyle = c.fg; ctx.fillText(clabel, centerP.x, centerP.y - cr - 4);

      if (el.rows.length === 0) {
        ctx.font = "12.5px ui-sans-serif, system-ui, sans-serif"; ctx.fillStyle = c.muted; ctx.textBaseline = "top";
        ctx.fillText("No connections yet", centerP.x, centerP.y + cr + 16);
      } else if (el.overflow > 0) {
        ctx.font = "11px ui-sans-serif, system-ui, sans-serif"; ctx.fillStyle = c.muted; ctx.textBaseline = "top";
        ctx.fillText(`+${el.overflow} more connections`, w / 2, h - 22);
      }
    };

    const draw = (ctx: CanvasRenderingContext2D) => {
      if (egoIdRef.current) { drawEgo(ctx); return; }
      const at = atlasRef.current, c = colorsRef.current;
      const { w, h, dpr } = sizeRef.current;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      if (!at || !c) return;

      const detail = detailRef.current;
      const activeType = activeRef.current;
      const intro = introRef.current ? clamp01((now() - introRef.current.t0) / INTRO_MS) : 1;
      const introA = easeOut(intro);
      if (intro >= 1) introRef.current = null;
      const vis = visRef.current, spot = spotRef.current, hover = hoverRef.current, sel = selRef.current;
      const cam = camRef.current;
      const pos = at.pos;
      const litSpot = (id: string) => !spot || spot.has(id);

      // 1) inter-family strands (overview context — fade as you dive in)
      const interA = (1 - detail) * introA;
      if (interA > 0.01) {
        const byType = new Map(at.clusters.map((cl) => [cl.type, cl] as const));
        for (const ie of at.interEdges) {
          const A = byType.get(ie.a), B = byType.get(ie.b);
          if (!A || !B) continue;
          if (typeOffRef.current.has(ie.a) || typeOffRef.current.has(ie.b)) continue;
          const pa = project({ x: A.cx, y: A.cy }), pb = project({ x: B.cx, y: B.cy });
          ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y);
          ctx.strokeStyle = c.primary;
          ctx.globalAlpha = clamp(0.06, 0.4, 0.04 + ie.w * 0.012) * interA;
          ctx.lineWidth = clamp(0.8, 4, Math.sqrt(ie.w) * 0.9);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }

      // 2) intra-family links of the active family (fade in as you dive)
      const dat = dataRef.current;
      if (activeType && detail > 0.02 && dat) {
        const cl = at.clusters.find((x) => x.type === activeType);
        const famEdges = cl ? familyOf(at, dat, cl).edges : [];
        ctx.strokeStyle = c.border;
        for (const ed of famEdges) {
          if (ed.kind === "tag" && !showTagsRef.current) continue;
          const a = pos.get(ed.source), b = pos.get(ed.target);
          if (!a || !b) continue;
          const sa = nodeByIdRef.current.get(ed.source), sb = nodeByIdRef.current.get(ed.target);
          const okA = (sa && (sa.ghost || sa.external)) ? overlayOK(sa) : vis.has(ed.source);
          const okB = (sb && (sb.ghost || sb.external)) ? overlayOK(sb) : vis.has(ed.target);
          if (!okA || !okB) continue;
          const pa = project(a), pb = project(b);
          const lit = litSpot(ed.source) && litSpot(ed.target);
          ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y);
          ctx.globalAlpha = (ed.kind === "tag" ? 0.16 : (lit ? 0.5 : 0.14)) * detail;
          ctx.lineWidth = ed.kind === "tag" ? 0.8 : 1.1;
          if (ed.kind === "tag") ctx.setLineDash([3, 3]); else ctx.setLineDash([]);
          ctx.stroke();
        }
        ctx.setLineDash([]); ctx.globalAlpha = 1;
      }

      function overlayOK(n: GraphNode): boolean {
        if (n.external) return showExtRef.current;
        if (n.ghost) return true;
        return true;
      }

      // 3) note glyphs — texture speckle in overview, full constellation when dived in
      const nowS = Date.now() / 1000;
      for (const cl of at.clusters) {
        if (typeOffRef.current.has(cl.type)) continue;
        const isActive = cl.type === activeType;
        const fade = isActive ? detail : 0;           // how "opened" this family is
        const dim = isActive ? 1 : (1 - detail);      // others recede as you focus
        for (const id of cl.nodeIds) {
          const n = nodeByIdRef.current.get(id); if (!n) continue;
          const overlay = n.ghost || n.external;
          if (overlay) { if (fade < 0.4 || !overlayOK(n)) continue; }   // overlays only inside, when on
          else if (!vis.has(id)) continue;
          const p = pos.get(id); if (!p) continue;
          const s = project(p);
          if (s.x < -30 || s.x > w + 30 || s.y < -30 || s.y > h + 30) continue;
          const r = lerp(TEX_PX, radiusFull(n), fade);
          const litS = litSpot(id);
          let a = lerp(TEX_A, 1, fade) * dim * introA;
          if (!litS) a *= 0.3;
          if (a < 0.02) continue;
          const col = n.ghost ? c.muted : n.external ? c.muted : typeColor(n.type, c);
          // recently-filed gentle halo (only inside a family)
          if (!overlay && fade > 0.5 && nowS - n.mtime < 3 * 86400) {
            const pulse = 0.5 + 0.5 * Math.sin(pulseRef.current * 1.4);
            ctx.beginPath(); ctx.arc(s.x, s.y, r + 3 + pulse * 3, 0, Math.PI * 2);
            ctx.fillStyle = col; ctx.globalAlpha = 0.12 * (0.5 + pulse * 0.5) * fade; ctx.fill();
          }
          ctx.globalAlpha = a;
          ctx.beginPath(); ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
          if (overlay) {
            ctx.fillStyle = c.card; ctx.fill();
            ctx.lineWidth = 1.2; ctx.strokeStyle = col;
            if (n.ghost) ctx.setLineDash([2, 2]);
            ctx.stroke(); ctx.setLineDash([]);
          } else {
            ctx.fillStyle = col; ctx.fill();
            if (n.orphan && fade > 0.5) { ctx.lineWidth = 1.3; ctx.strokeStyle = `hsl(${TYPE_HUE.idea})`; ctx.stroke(); }
          }
          const isHover = hover?.kind === "note" && hover.id === id;
          if (id === sel || isHover) {
            ctx.beginPath(); ctx.arc(s.x, s.y, r + 3, 0, Math.PI * 2);
            ctx.lineWidth = 1.6; ctx.strokeStyle = c.primary; ctx.globalAlpha = a; ctx.stroke();
          }
        }
      }
      ctx.globalAlpha = 1;

      const MAX_RING_LABELS = 24;
      const labelEligible = at.clusters.length <= MAX_RING_LABELS ? null : new Set(
        [...at.clusters].sort((a, b) => b.count - a.count).slice(0, MAX_RING_LABELS).map((c) => c.type));
      ctx.textAlign = "center";
      for (const cl of at.clusters) {
        if (typeOffRef.current.has(cl.type)) continue;
        const isActive = cl.type === activeType;
        const bubbleA = (isActive ? (1 - detail) : lerp(1, 0.5, detail)) * introA;
        const s = project({ x: cl.cx, y: cl.cy });
        const R = cl.rb * cam.k;
        const isHoverEarly = hover?.kind === "cluster" && hover.id === cl.type;
        if (bubbleA > 0.01 && s.x > -R - 40 && s.x < w + R + 40 && s.y > -R - 40 && s.y < h + R + 40) {
          const col = typeColor(cl.type, c);
          const isHover = hover?.kind === "cluster" && hover.id === cl.type;
          // soft fill
          const grad = ctx.createRadialGradient(s.x, s.y, R * 0.1, s.x, s.y, R);
          grad.addColorStop(0, withAlpha(col, 0.16 * bubbleA * (isHover ? 1.5 : 1)));
          grad.addColorStop(1, withAlpha(col, 0));
          ctx.beginPath(); ctx.arc(s.x, s.y, R, 0, Math.PI * 2);
          ctx.fillStyle = grad; ctx.fill();
          // ring
          ctx.beginPath(); ctx.arc(s.x, s.y, R, 0, Math.PI * 2);
          ctx.lineWidth = isHover ? 2.4 : 1.6; ctx.strokeStyle = withAlpha(col, (isHover ? 0.8 : 0.5) * bubbleA);
          ctx.stroke();
        }
        if (labelEligible && !labelEligible.has(cl.type) && !isHoverEarly) continue;   // skip the label only — bubble already drawn
        // label + count (kept legible; fades only a touch when you dive in)
        const labelA = (isActive ? lerp(1, 0, clamp01(detail * 1.6)) : 1) * introA;
        if (labelA > 0.02 && s.x > -80 && s.x < w + 80 && s.y > -60 && s.y < h + 60) {
          const isHover = hover?.kind === "cluster" && hover.id === cl.type;
          ctx.globalAlpha = labelA;
          ctx.font = `600 ${clamp(11, 17, 10 + cl.rb * 0.05)}px ui-sans-serif, system-ui, sans-serif`;
          ctx.fillStyle = c.bg; ctx.lineWidth = 3.5; ctx.strokeStyle = c.bg; ctx.textBaseline = "alphabetic";
          ctx.strokeText(cl.label, s.x, s.y - 2); ctx.fillStyle = isHover ? c.primary : c.fg; ctx.fillText(cl.label, s.x, s.y - 2);
          ctx.font = "11px ui-sans-serif, system-ui, sans-serif"; ctx.textBaseline = "top";
          ctx.fillStyle = c.bg; ctx.lineWidth = 3; ctx.strokeText(`${cl.count}`, s.x, s.y + 4);
          ctx.fillStyle = c.muted; ctx.fillText(`${cl.count}`, s.x, s.y + 4);
          ctx.globalAlpha = 1;
        }
      }

      // 5) note labels (screen space) — hubs + hovered + selected, once dived in
      if (activeType && detail > 0.4) {
        const cl = at.clusters.find((x) => x.type === activeType);
        ctx.font = "11px ui-sans-serif, system-ui, sans-serif";
        ctx.textAlign = "center"; ctx.textBaseline = "top";
        for (const id of cl?.nodeIds || []) {
          const n = nodeByIdRef.current.get(id); if (!n) continue;
          const overlay = n.ghost || n.external;
          if (overlay) { if (!overlayOK(n)) continue; } else if (!vis.has(id)) continue;
          const p = pos.get(id); if (!p) continue;
          const isHover = hover?.kind === "note" && hover.id === id;
          const want = isHover || id === sel || n.degree >= 4 || (cl && cl.nodeIds.length <= 26);
          if (!want) continue;
          const s = project(p);
          if (s.x < -40 || s.x > w + 40 || s.y < -10 || s.y > h + 10) continue;
          const r = radiusFull(n);
          const label = n.title.length > 28 ? n.title.slice(0, 27) + "…" : n.title;
          const litS = litSpot(id);
          ctx.globalAlpha = (litS ? (overlay ? 0.66 : 0.95) : 0.25) * detail;
          ctx.fillStyle = c.bg; ctx.lineWidth = 3; ctx.strokeStyle = c.bg;
          ctx.strokeText(label, s.x, s.y + r + 3);
          ctx.fillStyle = overlay ? c.muted : c.fg; ctx.fillText(label, s.x, s.y + r + 3);
        }
        ctx.globalAlpha = 1;
      }

    };

    // the node the keys stand on: a ring in the theme's --ring and the tooltip label above
    // it, placed every frame so both ride pans, zooms and tweens
    const drawKeyFocus = (ctx: CanvasRenderingContext2D) => {
      const label = keyLabelRef.current, c = colorsRef.current;
      const s = mapKeysRef.current ? spotOf(kFocusRef.current) : null;
      const { w, h } = sizeRef.current;
      if (!s || !c || s.x < -s.r || s.x > w + s.r || s.y < -s.r || s.y > h + s.r) {
        if (label) label.style.visibility = "hidden";
        return;
      }
      ctx.globalAlpha = 1; ctx.setLineDash([]);
      ctx.beginPath(); ctx.arc(s.x, s.y, s.r + 4, 0, Math.PI * 2);
      ctx.lineWidth = 2.5; ctx.strokeStyle = c.ring; ctx.stroke();
      ctx.beginPath(); ctx.arc(s.x, s.y, s.r + 8.5, 0, Math.PI * 2);
      ctx.lineWidth = 4; ctx.strokeStyle = withAlpha(c.ring, 0.28); ctx.stroke();
      if (!label) return;
      const lw = label.offsetWidth, lh = label.offsetHeight;
      const x = clamp(6, Math.max(6, w - lw - 6), s.x - lw / 2);
      let y = s.y - s.r - 12 - lh;
      if (y < 6) y = s.y + s.r + 12;   // no room above: below
      y = clamp(6, Math.max(6, h - lh - 6), y);
      label.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
      label.style.visibility = "visible";
    };

    raf = requestAnimationFrame(step);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); mo.disconnect(); };
  }, [full]);

  // the widget opening into its focused view (or back to its tile) is the same canvas
  // at a new size: frame it again, as a full-screen swap does. Ego mode keeps its camera.
  const tileFocused = tile?.focused;
  const focusSeen = useRef(tileFocused);
  useEffect(() => {
    if (focusSeen.current === tileFocused) return;
    focusSeen.current = tileFocused;
    let id = requestAnimationFrame(() => {
      id = requestAnimationFrame(() => {
        const wrap = wrapRef.current, at = atlasRef.current;
        if (!wrap || !at || egoId || transRef.current) return;
        const r = wrap.getBoundingClientRect();
        if (!r.width || !r.height) return;
        camRef.current = activeRef.current ? frameCluster(at, r.width, r.height, activeRef.current) : frameOverview(at, r.width, r.height);
      });
    });
    return () => cancelAnimationFrame(id);
  }, [tileFocused, egoId]);

  // first real layout → drop the camera in and play the opening fly-in. A later data
  // reload (e.g. after saving a note) just re-snaps to the current level — no churn.
  useEffect(() => {
    if (!atlas) return;
    const id = requestAnimationFrame(() => {
      const { w, h } = sizeRef.current;
      if (!w) return;
      if (!initRef.current) {
        initRef.current = true; framedOnceRef.current = true;
        activeRef.current = null; setActive(null); detailRef.current = 0;
        const ov = frameOverview(atlas, w, h);
        camRef.current = { tx: ov.tx + (w / 2 - ov.tx) * 0.14, ty: ov.ty + (h / 2 - ov.ty) * 0.14, k: ov.k * 0.9 };
        introRef.current = { t0: now() };
        startTransition(ov, 0, INTRO_MS, false);
      } else {
        // a structural reload: drop a family that no longer exists, then re-snap if idle
        if (activeRef.current && !atlas.clusters.some((c) => c.type === activeRef.current)) {
          activeRef.current = null; setActive(null); detailRef.current = 0; transRef.current = null;
        }
        if (!transRef.current) camRef.current = activeRef.current ? frameCluster(atlas, w, h, activeRef.current) : frameOverview(atlas, w, h);
      }
    });
    return () => cancelAnimationFrame(id);
  }, [atlas, startTransition]);

  // ---- pointer interaction
  const evtXY = (e: { clientX: number; clientY: number }) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const activeCam = () => (egoIdRef.current ? egoCamRef : camRef);
  const toWorld = (sx: number, sy: number): V2 => { const cam = activeCam().current; return { x: (sx - cam.tx) / cam.k, y: (sy - cam.ty) / cam.k }; };

  // ego mode: hit-test only the centre + its ringed neighbours (its own tiny
  // coordinate space, projected through egoCamRef, not the atlas at all)
  const hitTestEgo = (sx: number, sy: number): { kind: "note"; id: string } | null => {
    const el = egoLayoutRef.current; if (!el) return null;
    const wpt = toWorld(sx, sy);
    let best: string | null = null, bestD = Infinity;
    for (const [id, p] of el.pos) {
      const n = nodeById.get(id); if (!n) continue;
      const r = (radiusFull(n) + 8) / egoCamRef.current.k;
      const d = Math.hypot(p.x - wpt.x, p.y - wpt.y);
      if (d < r && d < bestD) { best = id; bestD = d; }
    }
    return best ? { kind: "note", id: best } : null;
  };

  // what's under the cursor, respecting the current level of detail
  const hitTest = (sx: number, sy: number): { kind: "cluster" | "note"; id: string } | null => {
    if (egoIdRef.current) return hitTestEgo(sx, sy);
    const at = atlasRef.current; if (!at) return null;
    const wpt = toWorld(sx, sy);
    const detail = detailRef.current, activeType = activeRef.current;
    // inside a family → notes first, then sibling bubbles to hop across
    if (activeType && detail > 0.5) {
      const cl = at.clusters.find((x) => x.type === activeType);
      let best: string | null = null, bestD = Infinity;
      for (const id of cl?.nodeIds || []) {
        const n = nodeById.get(id); if (!n) continue;
        const overlay = n.ghost || n.external;
        if (overlay) { if (n.external && !showExtRef.current) continue; } else if (!visRef.current.has(id)) continue;
        const p = at.pos.get(id); if (!p) continue;
        const r = (radiusFull(n) + 6) / camRef.current.k;
        const d = Math.hypot(p.x - wpt.x, p.y - wpt.y);
        if (d < r && d < bestD) { best = id; bestD = d; }
      }
      if (best) return { kind: "note", id: best };
    }
    // otherwise hit a family bubble
    let bestC: string | null = null, bestD = Infinity;
    for (const cl of at.clusters) {
      if (typeOff.has(cl.type)) continue;
      if (cl.type === activeType && detail > 0.5) continue;   // don't re-grab the open family
      const d = Math.hypot(cl.cx - wpt.x, cl.cy - wpt.y);
      if (d < cl.rb && d < bestD) { bestC = cl.type; bestD = d; }
    }
    return bestC ? { kind: "cluster", id: bestC } : null;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    canvasRef.current?.setPointerCapture(e.pointerId);
    const { x, y } = evtXY(e);
    const h = hitTest(x, y);
    // grabbing a note INSIDE a family drags it (interactive); a bubble/empty grab
    // pans. Ego mode is a frozen radial layout — no node-dragging there, only pan/click.
    dragNodeRef.current = h?.kind === "note" && detailRef.current > 0.5 && !egoIdRef.current ? h.id : null;
    dragRef.current = { panning: !h, moved: false, lx: x, ly: y, downId: h?.id || null, downKind: h?.kind || null };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const { x, y } = evtXY(e);
    const d = dragRef.current;
    const cam = activeCam();
    if (dragNodeRef.current && (e.buttons & 1)) {
      // drag the note itself — it follows the pointer, neighbours give way under the field
      const at = atlasRef.current, p = at?.pos.get(dragNodeRef.current);
      if (p) { const w = toWorld(x, y); p.x = w.x; p.y = w.y; }
      simAlphaRef.current = Math.max(simAlphaRef.current, 0.5);
      d.moved = d.moved || Math.hypot(x - d.lx, y - d.ly) > 4;
      d.lx = x; d.ly = y;
    } else if (d.panning && (e.buttons & 1)) {
      if (!egoIdRef.current) cancelTransition();
      cam.current.tx += x - d.lx; cam.current.ty += y - d.ly;
      d.lx = x; d.ly = y; d.moved = true; camDirtyRef.current = true;
    } else if (d.downId && (e.buttons & 1)) {
      d.moved = d.moved || Math.hypot(x - d.lx, y - d.ly) > 4;
      if (d.moved) {   // a drag that began on a bubble pans the map
        if (!egoIdRef.current) cancelTransition();
        cam.current.tx += x - d.lx; cam.current.ty += y - d.ly;
        d.lx = x; d.ly = y; camDirtyRef.current = true;
      }
    } else {
      const h = hitTest(x, y);
      hoverRef.current = h;
      egoHoverRef.current = egoIdRef.current && h?.kind === "note" ? h.id : null;
      if (canvasRef.current) canvasRef.current.style.cursor = h ? (h.kind === "cluster" ? "zoom-in" : "grab") : "grab";
    }
  };
  const onPointerUp = () => {
    const d = dragRef.current;
    if (!d.moved && d.downKind && d.downId) {
      if (d.downKind === "cluster" && !egoIdRef.current) enterFamily(d.downId);
      else {
        // a clean click on a note (any mode) reads it in the side drawer — held
        // briefly so a double-click can claim the event for the ego-network instead
        const n = nodeById.get(d.downId);
        if (n) {
          window.clearTimeout(clickTimerRef.current);
          clickTimerRef.current = window.setTimeout(() => openNode(n), 280);
        }
      }
    }
    if (dragNodeRef.current) simAlphaRef.current = Math.max(simAlphaRef.current, 0.22);   // let go → gently re-settle
    dragNodeRef.current = null;
    dragRef.current = { panning: false, moved: false, lx: 0, ly: 0, downId: null, downKind: null };
  };
  const onDoubleClick = (e: React.MouseEvent) => {
    window.clearTimeout(clickTimerRef.current);   // the double-click claims the pending single-click
    const { x, y } = evtXY(e);
    const h = hitTest(x, y);
    if (egoIdRef.current) {
      // double-click a neighbour re-centres the ego-network onto it — surfing the thread
      if (h?.kind === "note") { const n = nodeById.get(h.id); if (n) openEgo(n); }
      else closeEgo();
      return;
    }
    if (!h && (activeRef.current || insideGroupFamily)) handleBack();
    else if (h?.kind === "cluster") enterFamily(h.id);
    else if (h?.kind === "note") { const n = nodeById.get(h.id); if (n) openEgo(n); }   // double-click shows its ego-network
  };
  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const { x, y } = evtXY(e);
    if (!egoIdRef.current) cancelTransition();
    const cam = activeCam().current;
    const f = Math.exp(-e.deltaY * 0.0012);
    const nk = clamp(0.08, 4, cam.k * f);
    cam.tx = x - (x - cam.tx) * (nk / cam.k);
    cam.ty = y - (y - cam.ty) * (nk / cam.k);
    cam.k = nk;
    camDirtyRef.current = true;
  };

  const openNode = (n: GraphNode) => {
    if (n.external) { if (n.path) api.open(n.path); else toast.message("corpus reference"); return; }
    if (n.ghost) { toast.message(`No note yet for "${n.title}"`, { description: "The thinking points here but the note isn't written." }); return; }
    setSelected(n);
  };
  const openEgo = (n: GraphNode) => {
    if (n.external) { if (n.path) api.open(n.path); return; }
    if (n.ghost) { toast.message(`No note yet for "${n.title}"`, { description: "The thinking points here but the note isn't written." }); return; }
    if (!egoIdRef.current) {
      preEgoRef.current = { active: activeRef.current, detail: detailRef.current, cam: { ...camRef.current }, insideGroupFamily };
    }
    // the surf TRAIL — every re-centre extends the thread you're following
    setEgoTrail((t) => {
      if (!egoIdRef.current) return [n];
      if (t.length && t[t.length - 1].id === n.id) return t;
      return [...t, n].slice(-12);
    });
    egoIdRef.current = n.id;
    setEgoId(n.id);
  };
  // jump back to an earlier stop on the trail (stays in ego mode; the saved
  // pre-ego return point is untouched)
  const trailJump = (i: number) => {
    const n = egoTrail[i];
    if (!n) return;
    setEgoTrail((t) => t.slice(0, i + 1));
    egoIdRef.current = n.id;
    setEgoId(n.id);
  };
  const closeEgo = useCallback(() => {
    egoIdRef.current = null;
    setEgoId(null);
    setEgoTrail([]);
    const back = preEgoRef.current;
    preEgoRef.current = null;
    if (back) {
      activeRef.current = back.active; setActive(back.active);
      detailRef.current = back.detail; camRef.current = back.cam; transRef.current = null;
    }
  }, []);
  const focusDoneRef = useRef(0);
  useEffect(() => {
    if (!focusId || !focusNonce || focusDoneRef.current === focusNonce) return;
    const n = nodeById.get(focusId);
    if (!n) return;                      // not in the graph (yet) — wait for data
    focusDoneRef.current = focusNonce;
    openEgo(n);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId, focusNonce, nodeById]);

  const jumpTo = (n: GraphNode) => {
    setSelected(n);
    const at = atlasRef.current;
    const fam = at?.clusterOf.get(n.id);
    if (fam && fam !== activeRef.current) enterFamily(fam);
  };

  // open a corpus search hit: a filed note dives into its family + opens; external opens in Obsidian
  const openHit = (n: GraphNode) => {
    if (n.external) { if (n.path) api.open(n.path); return; }
    const real = nodeById.get(n.id) || n;
    jumpTo(real);
  };

  // the three toolbar popovers close on Esc first, handing focus back to the
  // toggle that opened them when it would otherwise fall to the page
  const popOpenerRef = useRef<HTMLElement | null>(null);
  const closePopovers = useCallback(() => {
    if (!showFilters && !showViews && !showBookmarks) return false;
    setShowFilters(false); setShowViews(false); setShowBookmarks(false);
    const o = popOpenerRef.current, a = document.activeElement;
    if (o && o.isConnected && (!a || a === document.body || (o.parentElement?.contains(a) && a !== o))) o.focus();
    return true;
  }, [showFilters, showViews, showBookmarks]);
  const typingIn = (t: HTMLElement | null) =>
    !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable) && !t.hasAttribute("data-knav-armed");

  useEffect(() => {
    if (!full) return;
    const h = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || selected) return;
      if (typingIn(e.target as HTMLElement | null)) return;   // the first Esc only stops typing
      e.preventDefault();
      if (closePopovers()) return;
      if (egoIdRef.current) closeEgo();
      else if (activeRef.current || insideGroupFamily) handleBack();
      else setFull(false);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [full, selected, insideGroupFamily, handleBack, closeEgo, closePopovers]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || full || selected || mapKeysRef.current) return;   // the map's own keys unwind it
      if (typingIn(e.target as HTMLElement | null)) return;
      if (Array.from(document.querySelectorAll("[role=dialog], [role=alertdialog], [data-knav-modal]"))
        .some((m) => m.getClientRects().length > 0)) return;
      if (closePopovers()) { e.preventDefault(); e.stopPropagation(); }
      else if (egoIdRef.current) { e.preventDefault(); e.stopPropagation(); closeEgo(); }
      else if (activeRef.current || insideGroupFamily) { e.preventDefault(); e.stopPropagation(); handleBack(); }
    };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [full, selected, insideGroupFamily, handleBack, closeEgo, closePopovers]);

  const PAN = 60, ZOOM = 1.25;
  const mapCam = () => (egoIdRef.current ? egoCamRef : camRef);

  /** the nodes the keys can stand on at this level, in family (layout) order */
  const keyStops = (): { f: KFocus; x: number; y: number }[] => {
    const out: { f: KFocus; x: number; y: number }[] = [];
    const push = (f: KFocus) => { const s = spotOf(f); if (s) out.push({ f, x: s.x, y: s.y }); };
    const el = egoLayoutRef.current;
    if (egoIdRef.current) {
      if (el) { push({ kind: "note", id: el.center.id }); el.rows.forEach((r) => push({ kind: "note", id: r.n.id })); }
      return out;
    }
    const at = atlasRef.current;
    if (!at) return out;
    const aType = activeRef.current;
    if (aType && detailRef.current > 0.5) {
      for (const id of at.clusters.find((x) => x.type === aType)?.nodeIds || []) {
        const n = nodeByIdRef.current.get(id);
        if (!n) continue;
        if (n.ghost || n.external) { if (n.external && !showExtRef.current) continue; }
        else if (!visRef.current.has(id)) continue;
        push({ kind: "note", id });
      }
      return out;
    }
    for (const cl of at.clusters) if (!typeOffRef.current.has(cl.type)) push({ kind: "cluster", id: cl.type });
    return out;
  };

  /** a node stepped onto past the edge of the view: bring it in, without reordering the walk */
  const revealFocus = () => {
    const s = spotOf(kFocusRef.current), { w, h } = sizeRef.current;
    if (!s || !w) return;
    const m = Math.min(90, w / 4, h / 4);
    const dx = s.x < m ? m - s.x : s.x > w - m ? w - m - s.x : 0;
    const dy = s.y < m ? m - s.y : s.y > h - m ? h - m - s.y : 0;
    if (!dx && !dy) return;
    if (egoIdRef.current) { const c = egoCamRef.current; egoCamRef.current = { ...c, tx: c.tx + dx, ty: c.ty + dy }; return; }
    if (transRef.current) return;
    const c = camRef.current;
    startTransition({ tx: c.tx + dx, ty: c.ty + dy, k: c.k }, detailRef.current, 220, false);
  };

  /** Tab / Shift+Tab walk nearest the centre first; [ ] walk family order */
  const stepFocus = (mode: "near" | "family", delta: number) => {
    const key = [egoIdRef.current, insideGroupFamily, activeRef.current, detailRef.current > 0.5,
      visRef.current.size, typeOffRef.current.size, showExtRef.current].join("|");
    let o = orderRef.current;
    if (!o || o.key !== key || o.mode !== mode || (mode === "near" && camDirtyRef.current)) {
      const stops = keyStops();
      const { w, h } = sizeRef.current;
      if (mode === "near") stops.sort((a, b) => Math.hypot(a.x - w / 2, a.y - h / 2) - Math.hypot(b.x - w / 2, b.y - h / 2));
      o = orderRef.current = { key, mode, ids: stops.map((s) => s.f) };
      camDirtyRef.current = false;
    }
    if (!o.ids.length) return;
    const cur = kFocusRef.current;
    const i = cur ? o.ids.findIndex((f) => f.kind === cur.kind && f.id === cur.id) : -1;
    const next = i < 0 ? (delta > 0 ? 0 : o.ids.length - 1) : (i + delta + o.ids.length) % o.ids.length;
    setKeyFocus(o.ids[next]);
    revealFocus();
  };

  const panBy = (dx: number, dy: number) => {
    if (!egoIdRef.current) cancelTransition();
    const cam = mapCam().current;
    cam.tx += dx; cam.ty += dy;
    camDirtyRef.current = true;
  };
  const zoomBy = (f: number) => {
    if (!egoIdRef.current) cancelTransition();
    const cam = mapCam().current, { w, h } = sizeRef.current;
    const nk = clamp(0.08, 4, cam.k * f), cx = w / 2, cy = h / 2;
    cam.tx = cx - (cx - cam.tx) * (nk / cam.k);
    cam.ty = cy - (cy - cam.ty) * (nk / cam.k);
    cam.k = nk;
    camDirtyRef.current = true;
  };
  /** the whole map at this level: every family, the family you are in, or the thread */
  const fitView = () => {
    const { w, h } = sizeRef.current, el = egoLayoutRef.current, at = atlasRef.current;
    if (!w) return;
    camDirtyRef.current = true;
    if (egoIdRef.current) { if (el) egoCamRef.current = frameEgo(el, w, h); return; }
    if (!at) return;
    const aType = activeRef.current;
    startTransition(aType && detailRef.current > 0.5 ? frameCluster(at, w, h, aType) : frameOverview(at, w, h), detailRef.current, 320, false);
  };

  /** the click, from the keys: a family dives in, a note reads in the drawer */
  const pressFocus = (f: KFocus) => {
    if (f.kind === "cluster") { if (!egoIdRef.current) { setKeyFocus(null); enterFamily(f.id); } return; }
    const n = nodeByIdRef.current.get(f.id);
    if (!n) return;
    if (!n.ghost && !n.external) resumeKeysRef.current = true;
    openNode(n);
  };

  const onMapKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    const html = document.documentElement;
    if (html.hasAttribute("data-board-prefix")) return;   // g / w own the next key
    if (!mapKeysRef.current) {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); html.setAttribute("data-knav", ""); claimKeys(true); }
      return;
    }
    const f = kFocusRef.current;
    const live = f && spotOf(f) ? f : null;   // the focused node is on the map at this level
    const act = (fn: () => void) => { e.preventDefault(); html.setAttribute("data-knav", ""); fn(); };
    const pan = e.shiftKey ? PAN * 4 : PAN;
    switch (e.key) {
      case "ArrowLeft": return act(() => panBy(pan, 0));
      case "ArrowRight": return act(() => panBy(-pan, 0));
      case "ArrowUp": return act(() => panBy(0, pan));
      case "ArrowDown": return act(() => panBy(0, -pan));
      case "+": case "=": return act(() => zoomBy(ZOOM));
      case "-": case "_": return act(() => zoomBy(1 / ZOOM));
      case "0": case "f": return act(fitView);
      case "Tab": return act(() => stepFocus("near", e.shiftKey ? -1 : 1));
      case "]": return act(() => stepFocus("family", 1));
      case "[": return act(() => stepFocus("family", -1));
      case "Enter": return act(() => {
        if (!live) { stepFocus("near", 1); return; }
        const n = nodeByIdRef.current.get(live.id);
        if (live.kind === "cluster") pressFocus(live);
        else if (n) openEgo(n);
      });
      case " ": return act(() => { if (live) pressFocus(live); });
      case "o": {
        const n = live?.kind === "note" ? nodeByIdRef.current.get(live.id) : null;
        if (n && noteFile(n)) { html.setAttribute("data-knav", ""); return; }   // lib/arrownav.ts opens data-obsidian-file
        return act(() => { if (live) pressFocus(live); });
      }
      case "Backspace": return act(() => {
        if (egoIdRef.current) { closeEgo(); return; }
        const from = activeRef.current || insideGroupFamily;
        if (!from) return;
        handleBack();
        setKeyFocus({ kind: "cluster", id: from });
      });
      case "Escape": return act(() => { if (egoIdRef.current) closeEgo(); else claimKeys(false); });
    }
  };

  // the key strip (KeyHints) shows the map's keys while the map holds them
  useEffect(() => {
    const html = document.documentElement;
    if (mapKeys) html.setAttribute("data-knav-map", "");
    else html.removeAttribute("data-knav-map");
    return () => html.removeAttribute("data-knav-map");
  }, [mapKeys]);

  // a note read from the keys: the keys go into the drawer, and back to the map when it closes
  useEffect(() => {
    if (!resumeKeysRef.current) return;
    const id = requestAnimationFrame(() => {
      if (selected) {
        const layers = Array.from(document.querySelectorAll<HTMLElement>("[role=dialog][data-knav-modal]"));
        const close = layers[layers.length - 1]?.querySelector<HTMLElement>("[data-knav-back]");
        if (close) { document.documentElement.setAttribute("data-knav", ""); close.focus({ preventScroll: true }); }
        return;
      }
      resumeKeysRef.current = false;
      const c = mapStopRef.current;
      if (c && c.isConnected) { c.focus({ preventScroll: true }); claimKeys(true); }
    });
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  // probes read the camera and the key state off the map stop
  useEffect(() => {
    const c = mapStopRef.current as (HTMLDivElement & { __notesMap?: object }) | null;
    if (!c) return;
    c.__notesMap = {
      cam: () => ({ ...mapCam().current }), keys: () => mapKeysRef.current, focus: () => kFocusRef.current,
      spot: () => spotOf(kFocusRef.current), stops: () => keyStops(),
      ego: () => egoIdRef.current, active: () => activeRef.current, group: () => insideGroupFamily,
      busy: () => !!transRef.current, size: () => ({ ...sizeRef.current }),
    };
  });

  const kNode = kFocus?.kind === "note" ? nodeById.get(kFocus.id) || null : null;
  const kFile = kNode ? noteFile(kNode) : null;
  const kLabel = !kFocus ? null
    : kFocus.kind === "cluster"
      ? { title: clusterLabel(kFocus.id), sub: String(displayAtlas?.clusters.find((c) => c.type === kFocus.id)?.count ?? "") }
      : kNode ? { title: kNode.title, sub: kNode.ghost ? "unwritten" : kNode.external ? "corpus" : clusterLabel(kNode.type).toLowerCase() } : null;

  const toggleType = (t: string) =>
    setTypeOff((s) => { const n = new Set(s); n.has(t) ? n.delete(t) : n.add(t); return n; });

  const toggleBookmark = (id: string) =>
    setBookmarks((bs) => (bs.includes(id) ? bs.filter((b) => b !== id) : [id, ...bs].slice(0, 60)));
  const goToBookmark = (id: string) => {
    const n = nodeById.get(id);
    if (n) { openEgo(n); setShowBookmarks(false); }
    else toast.error("That note isn't in the graph anymore");
  };

  const counts = data?.counts || {};
  const types = (displayAtlas?.clusters || []).map((c) => c.type);
  const overlayCount = (showTags ? 1 : 0) + (showExternal ? 1 : 0) + (orphansOnly ? 1 : 0) + (recentsOnly ? 1 : 0) + (tagFilter ? 1 : 0);

  const applyView = (v: SavedView) => {
    setQ(v.q); setTypeOff(new Set(v.typeOff)); setTagFilter(v.tagFilter);
    setShowTags(v.showTags); setShowExternal(v.showExternal); setOrphansOnly(v.orphansOnly); setRecentsOnly(v.recentsOnly);
    setShowViews(false);
  };
  const saveCurrentView = () => {
    const name = (q.trim() || (tagFilter ? `tag:${tagFilter}` : "view")).slice(0, 28);
    const v: SavedView = { name, q, typeOff: [...typeOff], tagFilter, showTags, showExternal, orphansOnly, recentsOnly };
    setSavedViews([v, ...savedViews.filter((s) => s.name !== name)].slice(0, 12));
    toast.success(`Saved view “${name}”`);
  };

  const activeCluster = displayAtlas?.clusters.find((c) => c.type === active);

  // ---- the controls + canvas surface, shared by inline + full-screen
  // no height = fill the flex column below the toolbar (embedded / full screen)
  const surface = (h?: string) => (
    <>
      <div className="flex items-center flex-wrap gap-1.5 mb-2.5">
        <div className="relative min-w-0 max-w-full">
          <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/60" />
          <input value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="Search or filter — tag:method, type:idea, links:>3…"
            className="h-7 w-[248px] max-w-full rounded-full bg-background border border-border pl-7 pr-7 text-[12px] focus:outline-none focus:border-primary" />
          {q && (
            <button onClick={() => setQ("")} title="Clear"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground/60 hover:text-foreground"><X size={12} /></button>
          )}
          {parsed.text.trim() && corpusHits.length > 0 && (
            <div className="absolute left-0 top-9 z-[120] w-[300px] max-h-[260px] overflow-y-auto rounded-xl border border-border bg-popover shadow-xl p-1 animate-in fade-in zoom-in-95 duration-100">
              <div className="px-2 py-1 text-[10px] uppercase tracking-[0.09em] font-semibold text-muted-foreground/70">Found across everything</div>
              {corpusHits.slice(0, 24).map((n) => (
                <button key={n.id} onClick={() => openHit(n)}
                  className="w-full text-left flex items-center gap-2 rounded-md px-2 py-1.5 text-[12px] text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors">
                  {n.external ? <ExternalLink size={12} className="shrink-0 opacity-60" /> : <FileText size={12} className="shrink-0 opacity-70" />}
                  <span className="truncate flex-1">{n.title}</span>
                  <span className="text-[10px] text-muted-foreground/60 uppercase">{n.external ? "corpus" : n.type}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        {!narrowTile && parsed.clauses.filter((c) => c.t !== "near").map((c, i) => (
          <button key={i} onClick={() => setQ(dropClause(q, c))}
            className="inline-flex items-center gap-1 h-7 rounded-full border border-primary/50 bg-primary/10 px-2.5 text-[12px] text-foreground">
            {clauseLabel(c)} <X size={11} className="opacity-60" />
          </button>
        ))}
        {!narrowTile && types.map((t) => (
          <Chip key={t} active={!typeOff.has(t)} onClick={() => toggleType(t)} dot={typeDot(t)}>
            {clusterLabel(t).toLowerCase()}
          </Chip>
        ))}

        <div className="ml-auto flex items-center gap-1.5">
          <div className="relative shrink-0">
            <button onClick={(e) => { popOpenerRef.current = e.currentTarget; setShowFilters((v) => !v); setShowViews(false); setShowBookmarks(false); }} title="Filters & overlays"
              aria-expanded={showFilters}
              className={`inline-flex items-center gap-1.5 h-7 rounded-full border px-2.5 text-[12px] transition-colors ${
                overlayCount || showFilters ? "border-primary/60 bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:text-foreground hover:border-primary/50"}`}>
              <SlidersHorizontal size={12} /> Filters{overlayCount ? ` ${overlayCount}` : ""}
            </button>
            {showFilters && (
              <FilterPopover
                onClose={() => setShowFilters(false)}
                recentsOnly={recentsOnly} setRecentsOnly={setRecentsOnly}
                showTags={showTags} setShowTags={setShowTags}
                showExternal={showExternal} setShowExternal={setShowExternal}
                orphansOnly={orphansOnly} setOrphansOnly={setOrphansOnly}
                tagFilter={tagFilter} setTagFilter={setTagFilter}
                tags={data?.tags || []} counts={counts}
              />
            )}
          </div>
          <div className="relative shrink-0">
            <button onClick={(e) => { popOpenerRef.current = e.currentTarget; setShowViews((v) => !v); setShowFilters(false); setShowBookmarks(false); }} title="Saved views"
              aria-label="Saved views" aria-expanded={showViews}
              className={`inline-flex items-center justify-center h-7 w-7 rounded-full border transition-colors ${
                showViews ? "border-primary/60 bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:text-foreground hover:border-primary/50"}`}>
              <Bookmark size={13} />
            </button>
            {showViews && (
              <SavedViewsPopover views={savedViews} onApply={applyView} onSave={saveCurrentView}
                onDelete={(name) => setSavedViews(savedViews.filter((s) => s.name !== name))}
                onClose={() => setShowViews(false)} />
            )}
          </div>
          <div className="relative shrink-0">
            <button onClick={(e) => { popOpenerRef.current = e.currentTarget; setShowBookmarks((v) => !v); setShowFilters(false); setShowViews(false); }} title="Bookmarked notes"
              aria-label="Bookmarked notes" aria-expanded={showBookmarks}
              className={`inline-flex items-center gap-1.5 h-7 rounded-full border px-2.5 text-[12px] transition-colors ${
                showBookmarks || bookmarks.length ? "border-primary/60 bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:text-foreground hover:border-primary/50"}`}>
              <Star size={12} />{bookmarks.length ? ` ${bookmarks.length}` : ""}
            </button>
            {showBookmarks && (
              <BookmarksPopover ids={bookmarks} nodeById={nodeById} onGo={goToBookmark}
                onRemove={(id) => setBookmarks(bookmarks.filter((b) => b !== id))}
                onClose={() => setShowBookmarks(false)} />
            )}
          </div>
          {embedded ? null : !full ? (
            <button onClick={() => setFull(true)} title="Expand to full screen"
              className="inline-flex items-center gap-1.5 h-7 rounded-full border border-border px-2.5 text-[12px] text-muted-foreground hover:text-foreground hover:border-primary/50 transition-colors">
              <Maximize2 size={12} /> Expand
            </button>
          ) : (
            <button onClick={() => setFull(false)} title="Collapse" data-knav-back
              className="inline-flex items-center gap-1.5 h-7 rounded-full border border-border px-2.5 text-[12px] text-muted-foreground hover:text-foreground hover:border-primary/50 transition-colors">
              <Minimize2 size={12} /> Done <kbd className="text-[10px] opacity-60">esc</kbd>
            </button>
          )}
        </div>
      </div>
      <div ref={wrapRef} className={`relative rounded-lg border border-border bg-card/40 overflow-hidden ${h ? "" : "flex-1 min-h-0"} ${
        mapKeys ? "ring-2 ring-primary" : "has-[.map-stop:focus-visible]:ring-2 has-[.map-stop:focus-visible]:ring-ring"}`} style={h ? { height: h } : undefined}>
        <canvas ref={canvasRef}
          onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
          onPointerLeave={() => { hoverRef.current = null; }} onWheel={onWheel} onDoubleClick={onDoubleClick}
          className="block touch-none select-none" style={{ cursor: "grab" }} />
        <div ref={mapStopRef} tabIndex={0} role="application" aria-roledescription="map" aria-label="Notes map"
          data-knav-id="notes-map" data-knav-own={mapKeys ? "arrows enter escape" : undefined}
          data-obsidian-file={mapKeys && kFile ? kFile : undefined}
          onKeyDown={onMapKey} onBlur={() => { if (mapKeysRef.current) claimKeys(false); }}
          className="map-stop pointer-events-none absolute inset-x-0 top-11 bottom-0" style={{ outline: "none" }} />
        {mapKeys && kLabel && (
          <div ref={keyLabelRef} role="tooltip" style={{ visibility: "hidden" }}
            className="pointer-events-none absolute left-0 top-0 z-10 flex max-w-[280px] items-baseline gap-1.5 whitespace-nowrap rounded-md bg-primary px-2.5 py-1 text-xs text-primary-foreground shadow-md">
            <span className="min-w-0 truncate font-medium">{kLabel.title}</span>
            {kLabel.sub && <span className="shrink-0 opacity-70">{kLabel.sub}</span>}
          </div>
        )}

        {/* breadcrumb — where you are + how to climb back out */}
        <div className="absolute top-2.5 left-2.5 right-12 flex flex-wrap items-center gap-1.5 pointer-events-none [&>*]:pointer-events-auto">
          {egoId && egoLayout ? (
            <>
              <button onClick={closeEgo} data-knav-back="2"
                className="inline-flex items-center gap-1.5 h-7 rounded-full border border-border bg-background/80 backdrop-blur px-2.5 text-[12px] text-muted-foreground hover:text-foreground hover:border-primary/50 transition-colors">
                <ArrowLeft size={12} /> Back
              </button>
              {/* the thread — every stop you've surfed through, oldest first;
                  click an earlier stop to rewind the trail to it */}
              {egoTrail.length > 1 && (() => {
                const start = Math.max(0, egoTrail.length - 5);
                return egoTrail.slice(start, -1).map((n, k) => (
                  <button key={n.id + k} onClick={() => trailJump(start + k)} title={n.title}
                    className="inline-flex items-center gap-1 h-7 rounded-full border border-border bg-background/70 backdrop-blur px-2 text-[11px] text-muted-foreground hover:text-foreground hover:border-primary/50 transition-colors max-w-[130px]">
                    <span className="truncate">{n.title}</span>
                    <CornerDownRight size={9} className="shrink-0 opacity-50" />
                  </button>
                ));
              })()}
              <span className="inline-flex items-center gap-1.5 h-7 rounded-full border border-primary/50 bg-primary/10 px-2.5 text-[12px] font-medium text-foreground max-w-[220px]">
                <FileText size={12} className="shrink-0 opacity-70" />
                <span className="truncate">{egoLayout.center.title}</span>
              </span>
              <button onClick={() => toggleBookmark(egoLayout.center.id)}
                title={bookmarks.includes(egoLayout.center.id) ? "Remove bookmark" : "Bookmark this node"}
                className={`inline-flex items-center justify-center h-7 w-7 rounded-full border transition-colors ${
                  bookmarks.includes(egoLayout.center.id) ? "border-primary/60 bg-primary/10 text-primary" : "border-border text-muted-foreground hover:text-foreground hover:border-primary/50"}`}>
                <Bookmark size={13} />
              </button>
            </>
          ) : active ? (
            <>
              <button onClick={handleBack} data-knav-back="2"
                className="inline-flex items-center gap-1.5 h-7 rounded-full border border-border bg-background/80 backdrop-blur px-2.5 text-[12px] text-muted-foreground hover:text-foreground hover:border-primary/50 transition-colors">
                <ArrowLeft size={12} /> {insideGroupFamily ? clusterLabel(insideGroupFamily).toLowerCase() : "Overview"}
              </button>
              <span className="inline-flex items-center gap-1.5 h-7 rounded-full border border-primary/50 bg-primary/10 px-2.5 text-[12px] font-medium text-foreground">
                <span className="h-2 w-2 rounded-full" style={{ background: typeDot(active) === "var(--primary-dot)" ? "hsl(var(--primary))" : typeDot(active) }} />
                {clusterLabel(active)}
                {activeCluster ? <span className="text-muted-foreground nums">{activeCluster.count}</span> : null}
              </span>
            </>
          ) : insideGroupFamily ? (
            <>
              <button onClick={handleBack} data-knav-back="2"
                className="inline-flex items-center gap-1.5 h-7 rounded-full border border-border bg-background/80 backdrop-blur px-2.5 text-[12px] text-muted-foreground hover:text-foreground hover:border-primary/50 transition-colors">
                <ArrowLeft size={12} /> Overview
              </button>
              <span className="inline-flex items-center gap-1.5 h-7 rounded-full border border-primary/50 bg-primary/10 px-2.5 text-[12px] font-medium text-foreground">
                {clusterLabel(insideGroupFamily)} <ZoomIn size={12} className="opacity-60" /> click a group to dive in
              </span>
            </>
          ) : (
            <span className="inline-flex items-center gap-1.5 h-7 rounded-full border border-border bg-background/70 backdrop-blur px-2.5 text-[11.5px] text-muted-foreground">
              <ZoomIn size={12} /> Click a family to dive in
            </span>
          )}
        </div>
        {/* replay */}
        <button onClick={replayIntro} title="Replay the fly-in"
          className="absolute top-2.5 right-2.5 inline-flex items-center justify-center h-7 w-7 rounded-full border border-border bg-background/70 backdrop-blur text-muted-foreground hover:text-foreground hover:border-primary/50 transition-colors">
          <Orbit size={13} />
        </button>

        {displayAtlas && displayAtlas.clusters.length > 1 && !egoId && (
          <div className={`absolute bottom-9 left-1/2 -translate-x-1/2 w-max max-w-[calc(100%-1.5rem)] flex-wrap justify-center items-center gap-1.5 ${
            active ? "flex" : "hidden [html[data-knav]_&]:flex"}`}>
            {displayAtlas.clusters.filter((c) => c.type !== active && !typeOff.has(c.type)).map((c) => (
              <button key={c.type} onClick={() => enterFamily(c.type)}
                className="inline-flex items-center gap-1.5 h-6 rounded-full border border-border bg-background/80 backdrop-blur px-2 text-[11px] text-muted-foreground hover:text-foreground hover:border-primary/50 transition-colors">
                <CornerDownRight size={10} className="opacity-60" /> {clusterLabel(c.type).toLowerCase()}
              </button>
            ))}
          </div>
        )}

        {!data && <div className="absolute inset-0 grid place-items-center text-[12.5px] text-muted-foreground">waking AIOA…</div>}
        {data && displayAtlas && displayAtlas.clusters.length === 0 && (
          <div className="absolute inset-0 grid place-items-center text-[12.5px] text-muted-foreground italic">No filed notes yet.</div>
        )}
        <div className="absolute bottom-2 left-2.5 right-2.5 truncate pointer-events-none text-[10px] text-muted-foreground/70 nums">
          {counts.notes || 0} notes{counts.inbox ? ` · ${counts.inbox} inbox` : ""} · {counts.links || 0} links · {active ? "click to read · double-click for its thread · esc for overview" : "scroll to zoom · drag to pan"}
        </div>
      </div>
    </>
  );

  if (embedded) {
    return (
      <>
        <div className="flex-1 h-full min-h-0 flex flex-col">{surface()}</div>
        {selected && <NoteDrawer node={selected} nodeById={nodeById} edges={data?.edges || []}
          onClose={() => setSelected(null)} onJump={jumpTo}
          onSaved={() => g.reload()}
          onTrace={(n) => { setSelected(null); openEgo(n); }}
          bookmarked={bookmarks.includes(selected.id)} onToggleBookmark={() => toggleBookmark(selected.id)} />}
      </>
    );
  }

  return (
    <>
      <Card className="p-5">
        <div className="flex items-center justify-between mb-3">
          <div className="text-[11px] uppercase tracking-[0.09em] font-semibold text-muted-foreground flex items-center gap-1.5">
            <Network size={13} /> AIOA
          </div>
        </div>
        {full ? (
          <div className="rounded-lg border border-dashed border-border bg-card/30 grid place-items-center text-[12.5px] text-muted-foreground" style={{ height: 460 }}>
            AIOA is expanded — press Done to bring it back here.
          </div>
        ) : surface("520px")}
      </Card>

      {full && createPortal(
        <div role="dialog" aria-modal="true" aria-label="AIOA" data-knav-modal
          className="fixed inset-0 z-[90] bg-background flex flex-col animate-in fade-in duration-150">
          <div className="shrink-0 flex items-center justify-between px-6 py-3.5 border-b border-border/60">
            <div className="text-[11px] uppercase tracking-[0.09em] font-semibold text-muted-foreground flex items-center gap-1.5">
              <Network size={13} /> AIOA
            </div>
          </div>
          <div className="flex-1 min-h-0 px-6 py-4 flex flex-col">{surface()}</div>
        </div>,
        document.body
      )}

      {selected && <NoteDrawer node={selected} nodeById={nodeById} edges={data?.edges || []}
        onClose={() => setSelected(null)} onJump={jumpTo}
        onSaved={() => g.reload()}
        onTrace={(n) => { setSelected(null); openEgo(n); }}
        bookmarked={bookmarks.includes(selected.id)} onToggleBookmark={() => toggleBookmark(selected.id)} />}
    </>
  );
}

function withAlpha(col: string, a: number): string {
  const al = clamp01(a);
  let m = col.match(/^hsl\(([^)]+)\)$/i);
  if (m) return `hsl(${m[1].trim()} / ${al})`;
  m = col.match(/^rgb\(([^)]+)\)$/i);
  if (m) return `rgba(${m[1].trim()}, ${al})`;
  m = col.match(/^rgba?\(([^/]+?)[,/]\s*[\d.]+\)$/i);   // already had an alpha → swap it
  if (m) return col.includes("/") ? `hsl(${m[1].trim()} / ${al})` : `rgba(${m[1].trim()}, ${al})`;
  return col;
}

function typeDot(t: string): string {
  if (t === "concept") return "var(--primary-dot)";
  const hue = TYPE_HUE[t];
  return hue ? `hsl(${hue})` : "transparent";
}

function Chip({ children, active, onClick, dot, icon, muted }:
  { children: React.ReactNode; active: boolean; onClick: () => void; dot?: string; icon?: React.ReactNode; muted?: boolean }) {
  return (
    <button onClick={onClick}
      className={`inline-flex items-center gap-1.5 h-7 rounded-full border px-2.5 text-[12px] transition-colors ${
        active && !muted ? "border-primary/60 bg-primary/10 text-foreground"
        : "border-border text-muted-foreground hover:text-foreground hover:border-primary/40"}`}>
      {dot && dot !== "transparent" && (
        <span className="h-2 w-2 rounded-full shrink-0" style={{ background: dot === "var(--primary-dot)" ? "hsl(var(--primary))" : dot, opacity: active ? 1 : 0.4 }} />
      )}
      {dot === "transparent" && <span className="h-2 w-2 rounded-full shrink-0 border border-muted-foreground/60" />}
      {icon}
      <span className="capitalize">{children}</span>
    </button>
  );
}

// ---- filters & overlays popover
function FilterPopover({ onClose, recentsOnly, setRecentsOnly, showTags, setShowTags, showExternal, setShowExternal,
  orphansOnly, setOrphansOnly, tagFilter, setTagFilter, tags, counts }: {
    onClose: () => void;
    recentsOnly: boolean; setRecentsOnly: (f: (v: boolean) => boolean) => void;
    showTags: boolean; setShowTags: (f: (v: boolean) => boolean) => void;
    showExternal: boolean; setShowExternal: (f: (v: boolean) => boolean) => void;
    orphansOnly: boolean; setOrphansOnly: (f: (v: boolean) => boolean) => void;
    tagFilter: string; setTagFilter: (v: string) => void;
    tags: string[]; counts: Record<string, number>;
  }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    setTimeout(() => document.addEventListener("mousedown", h), 0);
    return () => document.removeEventListener("mousedown", h);
  }, [onClose]);
  const Row = ({ active, onClick, icon, label, count }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string; count?: number }) => (
    <button onClick={onClick}
      className={`w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-[12.5px] transition-colors ${active ? "bg-primary/10 text-foreground" : "text-muted-foreground hover:bg-secondary"}`}>
      <span className={`h-3.5 w-3.5 grid place-items-center rounded-[4px] border ${active ? "border-primary bg-primary text-primary-foreground" : "border-border"}`}>
        {active && <span className="text-[9px] leading-none">✓</span>}
      </span>
      {icon}<span className="flex-1 text-left">{label}</span>
      {count ? <span className="text-[10px] text-muted-foreground/70 nums">{count}</span> : null}
    </button>
  );
  return (
    <div ref={ref} className="absolute right-0 top-9 z-[120] w-[230px] rounded-xl border border-border bg-popover shadow-xl p-2 animate-in fade-in zoom-in-95 duration-100">
      <div className="px-2 py-1 text-[10px] uppercase tracking-[0.09em] font-semibold text-muted-foreground/70">Show only</div>
      <Row active={recentsOnly} onClick={() => setRecentsOnly((v) => !v)} icon={<Clock size={12} />} label="Recent (14d)" count={undefined} />
      <Row active={orphansOnly} onClick={() => setOrphansOnly((v) => !v)} icon={<Sparkles size={12} />} label="Orphans" count={counts.orphans} />
      <div className="my-1 h-px bg-border/70" />
      <div className="px-2 py-1 text-[10px] uppercase tracking-[0.09em] font-semibold text-muted-foreground/70">Overlays (inside a family)</div>
      <Row active={showTags} onClick={() => setShowTags((v) => !v)} icon={<Tag size={12} />} label="Shared-tag links" count={counts.tagEdges} />
      <Row active={showExternal} onClick={() => setShowExternal((v) => !v)} icon={<ExternalLink size={12} />} label="Other external refs" count={counts.external} />
      {tags.length > 0 && (
        <>
          <div className="my-1 h-px bg-border/70" />
          <div className="px-2 py-1 text-[10px] uppercase tracking-[0.09em] font-semibold text-muted-foreground/70">Filter to a tag</div>
          <select value={tagFilter} onChange={(e) => setTagFilter(e.target.value)}
            className="w-full h-7 rounded-md bg-background border border-border px-2 text-[12px] text-muted-foreground focus:outline-none focus:border-primary">
            <option value="">all tags</option>
            {tags.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </>
      )}
    </div>
  );
}

// ---- saved-views popover
function SavedViewsPopover({ views, onApply, onSave, onDelete, onClose }: {
  views: SavedView[]; onApply: (v: SavedView) => void; onSave: () => void; onDelete: (name: string) => void; onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    setTimeout(() => document.addEventListener("mousedown", h), 0);
    return () => document.removeEventListener("mousedown", h);
  }, [onClose]);
  return (
    <div ref={ref} className="absolute right-0 top-9 z-[120] w-[230px] rounded-xl border border-border bg-popover shadow-xl p-2 animate-in fade-in zoom-in-95 duration-100">
      <button onClick={onSave} className="w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-[12.5px] text-foreground hover:bg-secondary transition-colors">
        <BookmarkPlus size={13} /> Save current view
      </button>
      {views.length > 0 && <div className="my-1 h-px bg-border/70" />}
      <div className="max-h-[240px] overflow-y-auto">
        {views.map((v) => (
          <div key={v.name} className="group flex items-center rounded-md hover:bg-secondary">
            <button onClick={() => onApply(v)} className="flex-1 text-left px-2 py-1.5 text-[12.5px] text-muted-foreground hover:text-foreground truncate">{v.name}</button>
            <button onClick={() => onDelete(v.name)} title="Delete this view" aria-label={`Delete view ${v.name}`}
              className="px-1.5 text-muted-foreground/50 hover:text-destructive opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"><Trash2 size={12} /></button>
          </div>
        ))}
      </div>
      {views.length === 0 && <div className="px-2 py-1.5 text-[11.5px] text-muted-foreground/70 italic">No saved views yet.</div>}
    </div>
  );
}

// ---- bookmarked notes — a working set you can jump straight back into (its
// ego-network), for grouped focused reading/editing across a project or theme
function BookmarksPopover({ ids, nodeById, onGo, onRemove, onClose }: {
  ids: string[]; nodeById: Map<string, GraphNode>; onGo: (id: string) => void; onRemove: (id: string) => void; onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    setTimeout(() => document.addEventListener("mousedown", h), 0);
    return () => document.removeEventListener("mousedown", h);
  }, [onClose]);
  return (
    <div ref={ref} className="absolute right-0 top-9 z-[120] w-[260px] rounded-xl border border-border bg-popover shadow-xl p-2 animate-in fade-in zoom-in-95 duration-100">
      <div className="px-2 py-1 text-[10px] uppercase tracking-[0.09em] font-semibold text-muted-foreground/70"
        title="Click a note to open its ego-network">
        Bookmarks
      </div>
      <div className="max-h-[300px] overflow-y-auto">
        {ids.map((id) => {
          const n = nodeById.get(id);
          return (
            <div key={id} className="group flex items-center rounded-md hover:bg-secondary">
              <button onClick={() => onGo(id)} disabled={!n}
                className="flex-1 text-left flex items-center gap-2 px-2 py-1.5 text-[12.5px] text-muted-foreground enabled:hover:text-foreground truncate disabled:opacity-40">
                <FileText size={12} className="shrink-0 opacity-70" />
                <span className="truncate">{n?.title || "(no longer in the graph)"}</span>
              </button>
              <button onClick={() => onRemove(id)} title="Remove bookmark" aria-label={`Remove bookmark ${n?.title || ""}`}
                className="px-1.5 text-muted-foreground/50 hover:text-destructive opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"><Trash2 size={12} /></button>
            </div>
          );
        })}
      </div>
      {ids.length === 0 && <div className="px-2 py-1.5 text-[11.5px] text-muted-foreground/70 italic">No bookmarks yet — star a note from its ego-network.</div>}
    </div>
  );
}

export const isWritableNote = (path: string) =>
  /^Preparation\/Notes\/(?!Archive\/).+\.md$/i.test(path) || /^Projects\/(papers|grants|briefs|experiments)\/[^/]+\/logs\/\d{4}-\d{2}-\d{2}_[^/]+\.md$/.test(path)
  || /^Preparation\/Teaching\/COURSES\/[^/]+\/notes\/[^/]+\.md$/.test(path);
const folderOf = (path: string) => {
  const m = path.match(/^Preparation\/Notes\/([^/]+)\//);
  return m ? m[1].toLowerCase() : /^Projects\//.test(path) ? "project" : /^Preparation\/Teaching\//.test(path) ? "course" : "";
};
export type FileTarget = "ideas" | "concepts" | "reflections" | "meetings" | "authors" | "inbox" | "project" | "course" | "archive";
const TARGET_LABEL: Record<FileTarget, string> = {
  ideas: "Ideas", concepts: "Concepts", reflections: "Reflections", meetings: "Meetings",
  authors: "Authors", inbox: "Inbox", project: "Project…", course: "Course…", archive: "Archive",
};

// the Undo toast for a file or a move; Undo reverses exactly that write via its undo_id
function toastMoved(where: string, title: string, r: NoteMoved, onChanged: () => void) {
  toast.success(`Filed → ${where}`, {
    description: title,
    action: r.undo_id ? {
      label: "Undo",
      onClick: async () => {
        try {
          const u = await api.noteUndo(r.undo_id);
          if (u.ok) { toast.success("Undone", { description: u.kept_edited ? `${title} — kept your edits` : title }); onChanged(); }
          else toast.error(u.error || "Couldn't undo that");
        } catch (e) { toast.error((e as Error).message || "Couldn't undo that"); }
      },
    } : undefined,
  });
}

// file (from the inbox) or move (anything writable) into a folder or project:<key>
export async function fileNote(mode: "file" | "move", path: string, to: string, where: string, title: string, onChanged: () => void): Promise<boolean> {
  try {
    const r = mode === "file" ? await api.noteFileTo(path, to) : await api.noteMove(path, to);
    if (!r.ok) { toast.error(r.error || "Couldn't file that note"); return false; }
    onChanged();
    toastMoved(where, title, r, onChanged);
    return true;
  } catch (e) { toast.error((e as Error).message || "Couldn't file that note"); return false; }
}

// soft-delete into Notes/Archive; Undo restores through /note/unarchive
export async function archiveNote(path: string, title: string, onChanged: () => void): Promise<boolean> {
  try {
    const r = await api.noteArchive(path);
    if (!r.ok) { toast.error(r.error || "Couldn't archive that note"); return false; }
    onChanged();
    toast.success("Archived", {
      description: title,
      action: {
        label: "Undo",
        onClick: async () => {
          const u = await api.noteUnarchive(r.archived || "");
          if (u.ok) { toast.success("Restored", { description: title }); onChanged(); }
          else toast.error(u.error || "Couldn't restore that note");
        },
      },
    });
    return true;
  } catch { toast.error("Couldn't archive that note"); return false; }
}

export function ProjectPicker({ onPick, onClose, courses = false }: { onPick: (t: ProjectTarget) => void; onClose: () => void; courses?: boolean }) {
  const p = useApi(() => api.notesProjectTargets(), [], 0);
  const [q, setQ] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const all = (p.data?.projects || []).filter((t) => (t.root === "courses") === courses);
    return needle ? all.filter((t) => t.name.toLowerCase().includes(needle) || t.key.toLowerCase().includes(needle)) : all;
  }, [p.data, q]);
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); }
    else if (e.key === "Enter" && rows[0]) { e.preventDefault(); onPick(rows[0]); }
    else if (e.key === "ArrowDown") { e.preventDefault(); listRef.current?.querySelector<HTMLButtonElement>("button")?.focus(); }
  };
  return (
    <div className="mt-2 w-full max-w-[340px] rounded-lg border border-border bg-popover p-1.5 shadow-sm">
      <div className="flex items-center gap-1">
        {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} placeholder={courses ? "Course…" : "Project…"}
          title="Type to filter · ⏎ first match · ↓ the list · Esc close"
          className="flex-1 min-w-0 h-7 bg-secondary/40 border border-border rounded-md px-2 text-[12px] focus:outline-none focus:border-primary" />
        <button onClick={onClose} data-knav-back="2" aria-label="Close" title="Close"
          className="shrink-0 p-1 text-muted-foreground hover:text-foreground"><X size={13} /></button>
      </div>
      <div ref={listRef} className="mt-1 max-h-[220px] overflow-y-auto tinybar"
        onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); } }}>
        {p.error ? <div className="px-2 py-1.5 text-[11.5px] text-muted-foreground">{courses ? "Courses" : "Projects"} aren't available.</div>
          : !p.data ? <div className="px-2 py-1.5 text-[11.5px] text-muted-foreground">loading…</div>
          : rows.length === 0 ? <div className="px-2 py-1.5 text-[11.5px] text-muted-foreground">No match.</div>
          : rows.map((t) => (
            <button key={t.key} onClick={() => onPick(t)} title={t.root}
              className="w-full text-left flex items-center gap-2 rounded-md px-2 py-1.5 text-[12px] text-muted-foreground hover:text-foreground hover:bg-secondary focus-visible:bg-secondary focus-visible:text-foreground outline-none">
              <span className="truncate flex-1">{t.name}</span>
              {t.status && <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground/60">{t.status}</span>}
            </button>
          ))}
      </div>
    </div>
  );
}

// the chips. `mode` file = an inbox note (/note/file), move = a filed note (/note/move).
// Filing, the first target is the primary one; the note's own folder is left out.
export function FileStrip({ path, title, mode, targets, onChanged, onDone, label, size = "sm" }: {
  path: string; title: string; mode: "file" | "move"; targets: FileTarget[]; onChanged: () => void;
  onDone?: () => void; label?: string; size?: "sm" | "md";
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [picking, setPicking] = useState<false | "project" | "course">(false);
  const here = folderOf(path);
  const shown = targets.filter((t) => t !== here || t === "project" || t === "course");
  const run = async (key: string, fn: () => Promise<boolean>) => {
    if (busy) return;
    setBusy(key);
    try { if (await fn()) onDone?.(); } finally { setBusy(null); }
  };
  const go = (t: FileTarget) => {
    if (t === "project" || t === "course") { setPicking((v) => (v === t ? false : t)); return; }
    if (t === "archive") { void run(t, () => archiveNote(path, title, onChanged)); return; }
    void run(t, () => fileNote(mode, path, t, TARGET_LABEL[t], title, onChanged));
  };
  const chip = size === "md" ? "px-3 py-1.5 text-[12px]" : "px-2.5 py-1 text-[11.5px]";
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5 flex-wrap">
        {label && <span className="text-[10px] uppercase tracking-[0.1em] font-semibold text-muted-foreground/70">{label}</span>}
        {shown.map((t, i) => (
          <button key={t} onClick={() => go(t)} disabled={!!busy}
            aria-expanded={t === "project" || t === "course" ? picking === t : undefined}
            title={t === "archive" ? "Archive — Undo in the toast" : t === "project" ? "File under a project's notes"
              : t === "course" ? "File under a course's notes" : `${mode === "file" ? "File into" : "Move to"} ${TARGET_LABEL[t]}`}
            className={`inline-flex items-center gap-1 rounded-full border transition-colors disabled:opacity-50 ${chip} ${
              mode === "file" && i === 0 && t !== "archive"
                ? "border-primary/50 bg-primary/10 text-foreground hover:bg-primary/15"
                : t === "archive" ? "border-transparent text-muted-foreground hover:text-foreground hover:bg-secondary/70"
                : `border-border bg-background text-muted-foreground hover:text-foreground hover:border-primary/60 ${picking === t ? "border-primary/60 text-foreground" : ""}`}`}>
            {busy === t ? <Loader2 size={11} className="animate-spin" /> : t === "archive" ? <Archive size={11} /> : null}
            {TARGET_LABEL[t]}
          </button>
        ))}
      </div>
      {picking && (
        <ProjectPicker key={picking} courses={picking === "course"} onClose={() => setPicking(false)}
          onPick={(p) => {
            const kind = picking;
            setPicking(false);
            void run(kind, () => fileNote(mode, path, `project:${p.key}`, p.name, title, onChanged));
          }} />
      )}
    </div>
  );
}

export function NoteDrawer({ node, nodeById, edges, onClose, onJump, onSaved, bookmarked, onToggleBookmark, onTrace }:
  { node: GraphNode; nodeById: Map<string, GraphNode>; edges: GraphEdge[];
    onClose: () => void; onJump: (n: GraphNode) => void; onSaved: () => void;
    bookmarked: boolean; onToggleBookmark: () => void;
    onTrace?: (n: GraphNode) => void }) {
  const [doc, setDoc] = useState<NoteRead | null>(null);
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [related, setRelated] = useState<RelatedNote[]>([]);
  // Move to / Archive only where the backend will write; /note/read's own readonly wins
  const writable = !node.readonly && !node.synthetic && !node.ghost && !node.external && isWritableNote(node.path) && doc?.readonly !== true;
  // Daily notes are written in place, never moved
  const movable = writable && !/^Preparation\/Notes\/Daily\//i.test(node.path);
  const [blocks, setBlocks] = useState<NoteBlocksDoc | null>(null);
  const [blockMode, setBlockMode] = useState<boolean | null>(null);

  useEffect(() => {
    let live = true;
    setDoc(null); setEditing(false); setRelated([]); setBlocks(null); setBlockMode(null);
    if (node.synthetic) return;   // no real file — nothing to read/relate, see the synthetic panel below
    api.noteRead(node.path).then((r) => { if (live) { setDoc(r); setBody(r.body || ""); } }).catch(() => {});
    api.notesRelated(node.path, 6).then((r) => { if (live) setRelated(r.related || []); }).catch(() => {});
    api.noteBlocks(node.path)
      .then((r) => { if (!live) return; if (r && r.ok) { setBlocks(r); setBlockMode(true); } else setBlockMode(false); })
      .catch(() => { if (live) setBlockMode(false); });
    return () => { live = false; };
  }, [node.path, node.synthetic]);

  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || editing) return;
      const root = rootRef.current, t = e.target as HTMLElement | null;
      if (t && t !== document.body && root && !root.contains(t)
        && t.closest("[role=dialog], [role=alertdialog], [data-knav-modal]")) return;
      if (root?.querySelector("[data-knav-back='2']")) return;
      e.preventDefault(); e.stopPropagation(); onClose();
    };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [editing, onClose]);

  const links = useMemo(() => {
    const out: GraphNode[] = [], back: GraphNode[] = [];
    for (const e of edges) {
      if (e.kind !== "link") continue;
      if (e.source === node.id) { const n = nodeById.get(e.target); if (n) out.push(n); }
      if (e.target === node.id) { const n = nodeById.get(e.source); if (n) back.push(n); }
    }
    return { out, back };
  }, [edges, node.id, nodeById]);

  const save = async () => {
    setSaving(true);
    try {
      await api.noteSave(node.path, body);
      setEditing(false); onSaved();
      const r = await api.noteRead(node.path); setDoc(r); setBody(r.body || "");
      toast.success("Saved");
    } catch { toast.error("Couldn't save"); }
    finally { setSaving(false); }
  };
  // ctrl/cmd+s writes the note, the same thing the Save button does
  useSaveKey(() => { if (editing && !saving) void save(); });

  const LinkRow = ({ n }: { n: GraphNode }) => (
    <button onClick={() => n.external ? api.open(n.path) : n.ghost ? null : onJump(n)}
      className="w-full text-left flex items-center gap-2 py-1.5 text-[12.5px] text-muted-foreground hover:text-primary transition-colors">
      {n.ghost ? <Ghost size={12} className="shrink-0 opacity-60" /> : n.external ? <ExternalLink size={12} className="shrink-0 opacity-60" /> : <FileText size={12} className="shrink-0 opacity-70" />}
      <span className="truncate">{n.title}</span>
    </button>
  );

  return createPortal(
    <div ref={rootRef} role="dialog" aria-modal="true" aria-label={doc?.title || node.title} data-knav-modal
      className="fixed inset-0 z-[110] flex justify-end animate-in fade-in duration-150">
      <div className="absolute inset-0 bg-black/30" aria-hidden="true" onClick={() => !editing && onClose()} />
      <div style={{ width: "min(1600px, calc(100vw - 240px))" }}
        className="relative h-full bg-background border-l border-border shadow-xl flex flex-col animate-in slide-in-from-right duration-200">
        <div className="shrink-0 flex items-start justify-between gap-3 px-5 py-4 border-b border-border/60">
          <div className="min-w-0">
            <div className="text-[16px] font-semibold leading-snug tracking-tight">{doc?.title || node.title}</div>
            <div className="mt-1 flex items-center gap-1.5 flex-wrap">
              <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-secondary text-secondary-foreground">{node.type}</span>
              {node.folder && <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70">{node.folder}</span>}
              {node.group && <span className="text-[10px] uppercase tracking-wide text-muted-foreground/60">· {node.group}</span>}
              {!writable && !node.synthetic && (
                <span title="Read-only here — open it in Obsidian to edit" className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground/70">
                  <Eye size={10} /> read-only
                </span>
              )}
              {node.orphan && <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded" style={{ background: `hsl(${TYPE_HUE.idea} / 0.15)`, color: `hsl(${TYPE_HUE.idea})` }}>orphan</span>}
            </div>
          </div>
          <button onClick={() => !editing && onClose()} data-knav-back aria-label="Close" title="Close"
            className="shrink-0 text-muted-foreground hover:text-foreground p-1"><X size={16} /></button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
          {/* unfiled inbox note → you sort it yourself, no model in the loop */}
          {node.type === "inbox" && movable && !editing && (
            <div className="mb-4 rounded-lg border border-primary/30 bg-primary/[0.06] px-3.5 py-3">
              <div className="text-[10px] uppercase tracking-[0.1em] font-semibold text-muted-foreground mb-2 flex items-center gap-1.5"
                title="You choose where it goes — nothing automatic">
                <FolderInput size={11} /> File into
              </div>
              <FileStrip path={node.path} title={doc?.title || node.title} mode="file" size="md"
                targets={["ideas", "concepts", "meetings", "project", "course", "reflections", "authors", "archive"]}
                onChanged={onSaved} onDone={onClose} />
            </div>
          )}
          {/* a filed note moves anywhere, the inbox included, with Undo in the toast */}
          {node.type !== "inbox" && movable && !editing && (
            <div className="mb-4">
              <FileStrip path={node.path} title={doc?.title || node.title} mode="move" label="Move to"
                targets={["ideas", "concepts", "reflections", "meetings", "authors", "inbox", "project", "course", "archive"]}
                onChanged={onSaved} onDone={onClose} />
            </div>
          )}
          {(node.tags || []).length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-4">
              {node.tags.map((t) => <span key={t} className="text-[10px] text-muted-foreground bg-secondary px-1.5 py-0.5 rounded">{t}</span>)}
            </div>
          )}
          {node.synthetic ? (
            <div className="rounded-lg border border-dashed border-border bg-secondary/30 px-3.5 py-3 text-[13px] text-muted-foreground leading-relaxed">
              Auto-generated — you have {node.citationCount ?? "2+"} papers by this author in your
              library (see "Linked from" below), but no profile note yet. Write one at{" "}
              <code className="text-[12px] bg-secondary px-1 py-0.5 rounded">Preparation/Notes/Authors/{node.title}.md</code>{" "}
              (or via <code className="text-[12px] bg-secondary px-1 py-0.5 rounded">an author note</code>) — bio, background,
              and your own theoretical notes — and it'll replace this entry.
            </div>
          ) : (!doc || blockMode === null) ? <div className="text-[12.5px] text-muted-foreground">loading…</div>
            : editing ? (
              <textarea value={body} onChange={(e) => setBody(e.target.value)} autoFocus
                className="w-full max-w-[100ch] mx-auto block min-h-[50vh] bg-background border border-border rounded-lg px-3.5 py-3 text-[13.5px] leading-relaxed resize-y focus:outline-none focus:border-primary font-mono"
                style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }} />
            ) : blockMode && blocks ? (
              // sections, not one big textarea: read by default, click a section to
              // edit it, and a save writes ONLY that section's lines
              <div className="max-w-[80ch] mx-auto -mx-4">
                <NoteBlocks key={node.path} path={node.path} initial={blocks}
                  mtime={doc.mtime} readonly={node.readonly}
                  onUnavailable={() => setBlockMode(false)}
                  onChanged={() => {
                    onSaved();
                    api.noteRead(node.path).then((r) => { setDoc(r); setBody(r.body || ""); }).catch(() => {});
                  }} />
              </div>
            ) : (
              <div className="prose-notes text-[13.5px] leading-relaxed max-w-[80ch] mx-auto">
                {/* the v= stamp is load-bearing: redrawing a diagram rewrites the
                  * SAME .png filename, so without it the browser serves a stale image */}
                <Markdown text={doc.body || "*(empty note)*"} idPrefix="ng-"
                  embedSrc={(n) => api.noteAttachmentUrl(n) + "&v=" + (doc.mtime || 0)} />
              </div>
            )}

          {!editing && (links.back.length > 0 || links.out.length > 0) && (
            <div className="mt-6 pt-4 border-t border-border/60 grid gap-4">
              {links.out.length > 0 && (
                <div>
                  <div className="text-[10px] uppercase tracking-[0.1em] font-semibold text-muted-foreground mb-1 flex items-center gap-1.5"><Link2 size={11} /> Links to</div>
                  {links.out.map((n) => <LinkRow key={"o" + n.id} n={n} />)}
                </div>
              )}
              {links.back.length > 0 && (
                <div>
                  <div className="text-[10px] uppercase tracking-[0.1em] font-semibold text-muted-foreground mb-1 flex items-center gap-1.5"><Link2 size={11} className="rotate-180" /> Linked from</div>
                  {links.back.map((n) => <LinkRow key={"b" + n.id} n={n} />)}
                </div>
              )}
            </div>
          )}

          {!editing && related.length > 0 && (
            <div className="mt-6 pt-4 border-t border-border/60">
              <div className="text-[10px] uppercase tracking-[0.1em] font-semibold text-muted-foreground mb-1 flex items-center gap-1.5"><Sparkles size={11} /> Related notes</div>
              {related.map((r) => {
                const n = nodeById.get(r.id) || (r.path ? {
                  id: r.id, title: r.title, folder: "", type: r.type, tags: r.tags || [],
                  path: r.path, mtime: 0, ghost: false, external: false, degree: 0,
                  orphan: false, readonly: true,
                } as GraphNode : undefined);
                return (
                  <button key={r.id} onClick={() => n && onJump(n)} disabled={!n}
                    className="w-full text-left flex items-center gap-2 py-1.5 text-[12.5px] text-muted-foreground enabled:hover:text-primary transition-colors disabled:opacity-50">
                    <FileText size={12} className="shrink-0 opacity-70" />
                    <span className="truncate flex-1">{r.title}</span>
                    <span className="text-[10px] text-muted-foreground/60 nums">{Math.round(r.sim * 100)}%</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="shrink-0 flex items-center gap-2 px-5 py-3.5 border-t border-border/60">
          {editing ? (
            <>
              <button onClick={save} disabled={saving}
                className="inline-flex items-center gap-1.5 rounded-full bg-primary text-primary-foreground px-4 py-1.5 text-[12px] font-medium hover:opacity-90 disabled:opacity-40">
                <Save size={13} /> {saving ? "Saving…" : "Save"}
              </button>
              <button onClick={() => { setEditing(false); setBody(doc?.body || ""); }} data-knav-back="2"
                className="rounded-full border border-border px-3 py-1.5 text-[12px] text-muted-foreground hover:text-foreground">Cancel</button>
            </>
          ) : (
            <>
              {!node.readonly && !blockMode && (
                <button onClick={() => setEditing(true)}
                  className="inline-flex items-center gap-1.5 rounded-full border border-border px-3.5 py-1.5 text-[12px] text-muted-foreground hover:text-foreground hover:border-primary/50 transition-colors">
                  <Pencil size={13} /> Edit
                </button>
              )}
              {!node.synthetic && (
                <button onClick={() => api.open(node.path)}
                  className="inline-flex items-center gap-1.5 rounded-full border border-border px-3.5 py-1.5 text-[12px] text-muted-foreground hover:text-foreground hover:border-primary/50 transition-colors">
                  <ExternalLink size={13} /> Open in Obsidian
                </button>
              )}
              {onTrace && !node.synthetic && !node.ghost && !node.external && (
                <button onClick={() => onTrace(node)} data-qa="drawer-trace"
                  title="Follow this note's thread in the map — its ego-network"
                  className="inline-flex items-center gap-1.5 rounded-full border border-border px-3.5 py-1.5 text-[12px] text-muted-foreground hover:text-foreground hover:border-primary/50 transition-colors">
                  <Orbit size={13} /> Thread
                </button>
              )}
              <button onClick={onToggleBookmark} title={bookmarked ? "Remove bookmark" : "Bookmark this note"}
                className={`ml-auto inline-flex items-center justify-center h-8 w-8 rounded-full border transition-colors ${
                  bookmarked ? "border-primary/60 bg-primary/10 text-primary" : "border-border text-muted-foreground hover:text-foreground hover:border-primary/50"}`}>
                <Star size={14} />
              </button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
