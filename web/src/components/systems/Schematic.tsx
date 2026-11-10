
import type { KeyboardEvent, MouseEvent } from "react";
import type { Component, Hygiene, Proposal, Zone, FitState } from "@/lib/systems";
import { cmLabel, dimTip } from "@/lib/systems";

export const HYG_TONE: Record<Hygiene, string> = {
  valuables: "var(--primary)",
  clean: "var(--success)",
  "wet/used": "var(--warning)",
  gear: "var(--muted-foreground)",
};
export const HYG_PATTERN: Record<Hygiene, string | null> = {
  valuables: null, clean: null, "wet/used": "sys-hatch", gear: "sys-dots",
};
export const fitTone = (s?: FitState) =>
  s === "fits" ? "var(--success)" : s && s !== "unknown" ? "var(--danger)" : "var(--muted-foreground)";

const trunc = (s: string, n: number) => (s.length <= n ? s : n <= 1 ? "…" : s.slice(0, Math.max(1, n - 1)) + "…");

/** the space a hook sits in, else null */
export function spaceOf(zones: Zone[], z: Zone | undefined): Zone | null {
  if (!z) return null;
  if (z.kind !== "hook") return z;
  return zones.find((s) => s.kind === "space" && s.w && s.h
    && z.x.cm >= s.x.cm - 0.5 && z.x.cm <= s.x.cm + s.w.cm + 0.5
    && z.y.cm >= s.y.cm && z.y.cm <= s.y.cm + s.h.cm) ?? null;
}

/** where a proposal's overlay sits, at true size, or null when it cannot be drawn */
export function overlayBox(c: Component, p: Proposal) {
  if (!p.size || !c.dims) return null;
  const W = c.dims.w.cm, H = c.dims.h.cm;
  const rot = !!p.fit?.rotated;
  const w = rot ? p.size.d.cm : p.size.w.cm;
  const h = Math.max(p.size.h.cm, 0.6);
  const z = c.zones.find((x) => x.id === p.zone);
  if (!p.zone || !z) return { x: 0, y: H - h, w, h };
  if (z.kind === "hook") {
    const right = z.x.cm > W / 2;
    return { x: right ? z.x.cm - w : z.x.cm, y: z.y.cm + 1, w, h };
  }
  const zh = z.h?.cm ?? 0;
  return { x: z.x.cm, y: z.y.cm + zh - h, w, h };
}

/** the drawing's own box in cm (interior plus the dimension margins): width, height */
export function viewBoxSize(c: Component): { w: number; h: number } {
  if (!c.dims) return { w: 1, h: 1 };
  const W = c.dims.w.cm, H = c.dims.h.cm, fs = Math.max(W, H) * 0.024;
  return { w: W + fs * 4.6, h: H + fs * 5.8 };
}

type Pick = (id: string, el: Element) => void;

export function Schematic({ c, selectedZone, onZone, width, height, readOnly, onChip, onOverlay, picked }: {
  c: Component; selectedZone: string | null; onZone: (id: string | null) => void; width?: number; height: number;
  readOnly?: boolean; onChip?: Pick; onOverlay?: Pick; picked?: string | null;
}) {
  if (!c.dims) return null;
  const W = c.dims.w.cm, H = c.dims.h.cm;
  const S = Math.max(W, H);
  const fs = S * 0.024;
  const mL = fs * 3.2, mB = fs * 3.2, mT = fs * 2.6, mR = fs * 1.4;
  const vb = `${-mL} ${-mT} ${W + mL + mR} ${H + mT + mB}`;
  const pickKey = (fn: Pick | undefined, id: string) => (e: KeyboardEvent<SVGGElement>) => {
    if (e.defaultPrevented || !fn) return;
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fn(id, e.currentTarget); }
  };
  const pickClick = (fn: Pick | undefined, id: string) => (e: MouseEvent<SVGGElement>) => { if (fn) fn(id, e.currentTarget); };
  const chipFs = fs * 0.9, ch = fs * 1.45, gap = fs * 0.22;
  const charW = chipFs * 0.56;
  const live = c.proposals.filter((p) => p.status !== "dropped");

  // items grouped by the space that holds them
  const stacks = new Map<string, { item: typeof c.items[number]; hook: Zone | null }[]>();
  const loose: typeof c.items = [];
  for (const it of c.items) {
    const z = c.zones.find((x) => x.id === it.zone);
    const s = spaceOf(c.zones, z);
    if (!s) { loose.push(it); continue; }
    const list = stacks.get(s.id) ?? [];
    list.push({ item: it, hook: z && z.kind === "hook" ? z : null });
    stacks.set(s.id, list);
  }

  const zoneKey = (id: string) => (e: KeyboardEvent<SVGGElement>) => {
    if (e.defaultPrevented) return;
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onZone(selectedZone === id ? null : id); }
  };

  return (
    <svg viewBox={vb} preserveAspectRatio="xMidYMid meet" role="img" aria-label={`${c.name} schematic`}
      data-systems-schematic="" style={{ width: width ?? "100%", maxWidth: "100%", height, display: "block" }} className="select-none">
      <defs>
        <pattern id="sys-hatch" patternUnits="userSpaceOnUse" width={fs * 0.5} height={fs * 0.5} patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2={fs * 0.5} stroke="hsl(var(--warning))" strokeWidth={fs * 0.12} strokeOpacity="0.45" />
        </pattern>
        <pattern id="sys-dots" patternUnits="userSpaceOnUse" width={fs * 0.45} height={fs * 0.45}>
          <circle cx={fs * 0.22} cy={fs * 0.22} r={fs * 0.06} fill="hsl(var(--muted-foreground))" fillOpacity="0.55" />
        </pattern>
      </defs>

      {/* interior */}
      <rect x={0} y={0} width={W} height={H} fill="hsl(var(--card))" stroke="hsl(var(--foreground))"
        strokeOpacity="0.7" strokeWidth={fs * 0.12} />

      {/* zones */}
      {c.zones.filter((z) => z.kind === "space" && z.w && z.h).map((z) => {
        const sel = selectedZone === z.id;
        const maxChars = Math.floor((z.w!.cm - fs * 0.4) / (fs * 0.72 * 0.56));
        return (
          <g key={z.id} role="button" tabIndex={0} data-systems-zone={z.id} aria-pressed={sel}
            aria-label={`${z.name}, ${cmLabel(z.w)} by ${cmLabel(z.h)} cm`}
            onClick={() => onZone(sel ? null : z.id)} onKeyDown={zoneKey(z.id)}
            className="cursor-pointer outline-none [&:focus-visible>rect]:stroke-[hsl(var(--ring))]">
            <title>{`${z.name}  ${cmLabel(z.w)} w × ${cmLabel(z.d ?? c.dims!.d)} d × ${cmLabel(z.h)} h cm${z.w?.source ? `\n${z.w.source}` : ""}`}</title>
            <rect x={z.x.cm} y={z.y.cm} width={z.w!.cm} height={z.h!.cm}
              fill={sel ? "hsl(var(--primary) / 0.10)" : "hsl(var(--muted) / 0.35)"}
              stroke={sel ? "hsl(var(--primary))" : "hsl(var(--border))"} strokeWidth={fs * (sel ? 0.16 : 0.1)} />
            <text x={z.x.cm + fs * 0.25} y={z.y.cm + fs * 0.8} fontSize={fs * 0.72}
              fill="hsl(var(--muted-foreground))">{trunc(z.name, maxChars)}</text>
          </g>
        );
      })}

      {/* hooks */}
      {c.zones.filter((z) => z.kind === "hook").map((z) => {
        const right = z.x.cm > W / 2;
        const dx = right ? -1 : 1;
        return (
          <g key={z.id} data-systems-hook={z.id}>
            <title>{`${z.name}  at ${cmLabel(z.y)} cm down`}</title>
            <path d={`M ${z.x.cm} ${z.y.cm - fs * 0.3} h ${dx * fs * 0.7} v ${fs * 0.6} h ${-dx * fs * 0.25}`}
              fill="none" stroke="hsl(var(--foreground))" strokeWidth={fs * 0.16} strokeLinecap="round" />
          </g>
        );
      })}

      {/* item chips */}
      {[...stacks.entries()].map(([sid, list]) => {
        const s = c.zones.find((z) => z.id === sid)!;
        const room = Math.max(1, Math.floor((s.h!.cm - fs * 1.3) / (ch + gap)));
        const shown = list.length > room ? list.slice(0, room - 1) : list;
        const more = list.length - shown.length;
        const cw = s.w!.cm - fs * 0.5;
        const maxChars = Math.floor((cw - fs * 0.5) / charW);
        return (
          <g key={"st-" + sid}>
            {shown.map(({ item, hook }, i) => {
              const y = s.y.cm + fs * 1.3 + i * (ch + gap);
              const x = s.x.cm + fs * 0.25;
              const tone = HYG_TONE[item.hygiene];
              const pat = HYG_PATTERN[item.hygiene];
              return (
                <g key={item.id} data-systems-chip={item.id} data-hygiene={item.hygiene}
                  role="button" tabIndex={0} aria-label={`${item.name}, ${item.hygiene}`}
                  aria-haspopup="dialog" aria-expanded={picked === item.id}
                  onClick={pickClick(onChip, item.id)} onKeyDown={pickKey(onChip, item.id)}
                  className="cursor-pointer outline-none [&:focus-visible>rect]:stroke-[hsl(var(--ring))]">
                  <title>{`${item.name}  ${item.hygiene}${hook ? `  on ${hook.name}` : ""}`}</title>
                  {hook && (
                    <line x1={hook.x.cm} y1={hook.y.cm} x2={hook.x.cm > W / 2 ? x + cw : x} y2={y + ch / 2}
                      stroke="hsl(var(--muted-foreground))" strokeWidth={fs * 0.06} strokeDasharray={`${fs * 0.2} ${fs * 0.2}`} />
                  )}
                  <rect x={x} y={y} width={cw} height={ch} rx={fs * 0.3}
                    fill={`hsl(${tone} / 0.16)`} stroke={`hsl(${tone})`} strokeWidth={fs * (picked === item.id ? 0.2 : 0.08)} />
                  {pat && <rect x={x} y={y} width={cw} height={ch} rx={fs * 0.3} fill={`url(#${pat})`} />}
                  <text x={x + fs * 0.3} y={y + ch * 0.7} fontSize={chipFs} fill="hsl(var(--foreground))">
                    {trunc(item.name, maxChars)}
                  </text>
                </g>
              );
            })}
            {more > 0 && (
              <text x={s.x.cm + fs * 0.3} y={s.y.cm + fs * 1.3 + shown.length * (ch + gap) + ch * 0.7}
                fontSize={chipFs} fill="hsl(var(--muted-foreground))">
                <title>{list.slice(shown.length).map((x) => x.item.name).join(", ")}</title>
                +{more}
              </text>
            )}
          </g>
        );
      })}

      {/* proposal overlays */}
      {live.map((p) => {
        const b = overlayBox(c, p);
        if (!b) return null;
        const n = c.proposals.indexOf(p) + 1;
        const tone = fitTone(p.fit?.state);
        return (
          <g key={p.id} data-systems-overlay={p.id} data-fit={p.fit?.state ?? "unknown"}
            role="button" tabIndex={0} aria-label={`${n}. ${p.name}, ${p.fit?.state ?? "unknown"}`}
            aria-haspopup="dialog" aria-expanded={picked === p.id}
            onClick={pickClick(onOverlay, p.id)} onKeyDown={pickKey(onOverlay, p.id)}
            className="cursor-pointer outline-none [&:focus-visible>rect]:stroke-[hsl(var(--ring))]">
            <title>{`${n}. ${p.name}  ${p.fit?.state ?? "unknown"}${p.fit?.rotated ? " (turned)" : ""}  ${p.status}`}</title>
            {/* the box takes clicks on its outline and number only, so the chips under it stay reachable */}
            <rect x={b.x} y={b.y} width={b.w} height={b.h} fill={`hsl(${tone} / 0.06)`} pointerEvents="visibleStroke"
              stroke={`hsl(${tone})`} strokeWidth={fs * (picked === p.id ? 0.22 : 0.12)} strokeDasharray={`${fs * 0.45} ${fs * 0.3}`} />
            <circle cx={b.x + fs * 0.55} cy={b.y - fs * 0.05} r={fs * 0.5} fill={`hsl(${tone})`} />
            <text x={b.x + fs * 0.55} y={b.y + fs * 0.2} fontSize={fs * 0.65} textAnchor="middle"
              fill="hsl(var(--background))" fontWeight={600}>{n}</text>
          </g>
        );
      })}

      {/* dimensions */}
      <g data-systems-dims="" fontSize={fs * 0.8} fill="hsl(var(--foreground))">
        <g>
          <title>{dimTip("width", c.dims.w)}</title>
          <line x1={0} y1={H + fs * 1.1} x2={W} y2={H + fs * 1.1} stroke="hsl(var(--muted-foreground))"
            strokeWidth={fs * 0.07} strokeDasharray={c.dims.w.estimated ? `${fs * 0.3} ${fs * 0.2}` : undefined} />
          <line x1={0} y1={H + fs * 0.6} x2={0} y2={H + fs * 1.6} stroke="hsl(var(--muted-foreground))" strokeWidth={fs * 0.07} />
          <line x1={W} y1={H + fs * 0.6} x2={W} y2={H + fs * 1.6} stroke="hsl(var(--muted-foreground))" strokeWidth={fs * 0.07} />
          <text x={W / 2} y={H + fs * 2.5} textAnchor="middle" data-dim="w" data-estimated={c.dims.w.estimated}
            fontStyle={c.dims.w.estimated ? "italic" : undefined}>{cmLabel(c.dims.w)} cm</text>
        </g>
        <g>
          <title>{dimTip("height", c.dims.h)}</title>
          <line x1={-fs * 1.1} y1={0} x2={-fs * 1.1} y2={H} stroke="hsl(var(--muted-foreground))"
            strokeWidth={fs * 0.07} strokeDasharray={c.dims.h.estimated ? `${fs * 0.3} ${fs * 0.2}` : undefined} />
          <line x1={-fs * 1.6} y1={0} x2={-fs * 0.6} y2={0} stroke="hsl(var(--muted-foreground))" strokeWidth={fs * 0.07} />
          <line x1={-fs * 1.6} y1={H} x2={-fs * 0.6} y2={H} stroke="hsl(var(--muted-foreground))" strokeWidth={fs * 0.07} />
          <text x={-fs * 1.9} y={H / 2} textAnchor="middle" transform={`rotate(-90 ${-fs * 1.9} ${H / 2})`}
            data-dim="h" data-estimated={c.dims.h.estimated}
            fontStyle={c.dims.h.estimated ? "italic" : undefined}>{cmLabel(c.dims.h)} cm</text>
        </g>
        <g>
          <title>{dimTip("depth", c.dims.d)}</title>
          <text x={W} y={-fs * 0.8} textAnchor="end" data-dim="d" data-estimated={c.dims.d.estimated}
            fontStyle={c.dims.d.estimated ? "italic" : undefined} fill="hsl(var(--muted-foreground))">
            d {cmLabel(c.dims.d)} cm
          </text>
        </g>
      </g>
      {readOnly && <desc>archived</desc>}
      {loose.length > 0 && <desc>{`unplaced: ${loose.map((i) => i.name).join(", ")}`}</desc>}
    </svg>
  );
}
