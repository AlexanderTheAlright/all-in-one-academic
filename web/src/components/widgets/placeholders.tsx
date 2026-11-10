
import { useEffect, useMemo, useRef, useState } from "react";
import { panelApi, fillPlaceholders, type PanelCatalog, type PanelPlaceholder } from "@/lib/api";
import { paneRecall, paneRemember, type PaneSize } from "@/components/widgets/panel";

export type PhDataset = { family: string; key: string; frame: string; path: string } | null;
export type PhValues = Record<string, string>;

const memKey = (lane: string, name: string) => "ph:" + (lane || "any") + ":" + name;

export function initialValues(phs: PanelPlaceholder[], lane: string, ds: PhDataset): PhValues {
  const v: PhValues = {};
  for (const p of phs) {
    const kept = paneRecall<string>(memKey(lane, p.name), (x): x is string => typeof x === "string");
    if (kept) { v[p.name] = kept; continue; }
    if (p.default) { v[p.name] = p.default; continue; }
    if (p.kind === "family" && ds?.family) v[p.name] = ds.family;
    else if (p.kind === "key" && ds?.key) v[p.name] = ds.key;
  }
  return v;
}

export const unfilled = (phs: PanelPlaceholder[], v: PhValues): string[] =>
  phs.filter((p) => !(v[p.name] || "").trim()).map((p) => p.name);

const NEEDS_VARS = new Set(["variable", "variables"]);
const NEEDS_CAT = new Set(["family", "key"]);

export function usePhVariables(ds: PhDataset, want: boolean): { name: string; label: string }[] {
  const [rows, setRows] = useState<{ name: string; label: string }[]>([]);
  const ident = ds ? [ds.family, ds.key, ds.frame, ds.path].join("|") : "";
  useEffect(() => {
    if (!want || !ds || !ident.replace(/\|/g, "")) { setRows([]); return; }
    let live = true;
    panelApi.dataset(ds)
      .then((d) => { if (live) setRows(d.variables.map((x) => ({ name: x.name, label: x.label }))); })
      .catch(() => { if (live) setRows([]); });
    return () => { live = false; };
  }, [ident, want]);   // eslint-disable-line react-hooks/exhaustive-deps
  return rows;
}

export function usePhCatalog(want: boolean): PanelCatalog | null {
  const [cat, setCat] = useState<PanelCatalog | null>(null);
  useEffect(() => {
    if (!want) return;
    let live = true;
    panelApi.catalog().then((c) => { if (live) setCat(c); }).catch(() => {});
    return () => { live = false; };
  }, [want]);
  return cat;
}

export function FilledCode({ cmd, phs, values, lane }: {
  cmd: string; phs: PanelPlaceholder[]; values: PhValues; lane: string;
}) {
  const parts = useMemo(() => {
    if (!phs.length) return [{ t: cmd, ph: "" }];
    const out: { t: string; ph: string }[] = [];
    const re = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
    let last = 0;
    for (let m = re.exec(cmd); m; m = re.exec(cmd)) {
      if (m.index > last) out.push({ t: cmd.slice(last, m.index), ph: "" });
      const val = (values[m[1]] || "").trim();
      out.push({ t: val || m[0], ph: val ? "" : m[1] });
      last = m.index + m[0].length;
    }
    if (last < cmd.length) out.push({ t: cmd.slice(last), ph: "" });
    return out;
  }, [cmd, phs.length, values]);

  return (
    <pre data-dict-cmd data-dict-cmd-lane={lane}
      className="whitespace-pre-wrap break-words rounded-md border border-border/70 bg-muted/40 px-2 py-1.5 font-mono text-[10.5px] leading-[1.45] text-foreground">
      {parts.map((p, i) => (p.ph
        ? <mark key={i} data-ph-open={p.ph}
            className="rounded-[2px] bg-primary/25 px-[1px] text-foreground">{p.t}</mark>
        : <span key={i}>{p.t}</span>))}
    </pre>
  );
}

export function PlaceholderFields({ phs, values, onChange, ds, size }: {
  phs: PanelPlaceholder[]; values: PhValues; onChange: (name: string, v: string) => void;
  ds: PhDataset; size: PaneSize;
}) {
  const wantVars = phs.some((p) => NEEDS_VARS.has(p.kind));
  const wantCat = phs.some((p) => NEEDS_CAT.has(p.kind));
  const vars = usePhVariables(ds, wantVars);
  const cat = usePhCatalog(wantCat);
  const box = useRef<HTMLDivElement>(null);
  if (!phs.length) return null;

  const next = (name: string) => {
    const i = phs.findIndex((p) => p.name === name);
    const n = phs[i + 1];
    if (!n) return;
    box.current?.querySelector<HTMLInputElement>(`[data-ph-field="${CSS.escape(n.name)}"]`)?.focus();
  };

  const listFor = (p: PanelPlaceholder) => {
    if (NEEDS_VARS.has(p.kind)) return vars.map((v) => ({ value: v.name, label: v.label }));
    if (p.kind === "family") return (cat?.families || []).map((f) => ({ value: f.family, label: f.n + " datasets" }));
    if (p.kind === "key") {
      const fam = (cat?.families || []).find((f) => f.family === (ds?.family || ""));
      const fams = fam ? [fam] : (cat?.families || []);
      return fams.flatMap((f) => f.datasets.map((d) => ({ value: d.key, label: d.label })));
    }
    return null;
  };

  const hintFor = (p: PanelPlaceholder) =>
    p.kind === "variables" ? "one or more, space-separated"
      : p.kind === "variable" ? (ds ? "a variable in the picked dataset" : "pick a dataset on Datasets first")
      : p.kind === "int" ? "a whole number"
      : p.kind === "number" ? "a number"
      : p.kind === "family" ? "a hub family"
      : p.kind === "key" ? "a dataset key"
      : p.kind === "path" ? "a path" : "";

  return (
    <div ref={box} data-ph-fields className="mt-1.5 flex flex-col gap-1 border-t border-border/40 pt-1.5">
      {phs.map((p) => {
        const list = listFor(p);
        const id = "ph-" + p.name;
        const numeric = p.kind === "int" || p.kind === "number";
        return (
          <label key={p.name} data-ph-row={p.name}
            className={"flex min-w-0 items-center gap-1.5 " + (size === "xs" ? "flex-col items-stretch gap-0.5" : "")}>
            <span className="shrink-0 font-mono text-[10px] text-muted-foreground"
              style={size === "xs" ? undefined : { minWidth: 86 }} title={hintFor(p)}>{p.name}</span>
            <input data-ph-field={p.name} data-ph-kind={p.kind} data-knav-item data-knav-own="arrows enter"
              list={list ? id + "-list" : undefined}
              type={numeric ? "number" : "text"} step={p.kind === "int" ? 1 : undefined}
              inputMode={numeric ? "numeric" : undefined}
              value={values[p.name] || ""} placeholder={hintFor(p)}
              onChange={(e) => onChange(p.name, e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); next(p.name); }
              }}
              className="min-w-0 flex-1 rounded border border-border bg-background px-1.5 py-[2px] font-mono text-[10.5px] outline-none focus:border-primary/70 placeholder:font-sans placeholder:text-muted-foreground/60" />
            {list && (
              <datalist id={id + "-list"}>
                {list.slice(0, 400).map((o) => <option key={o.value} value={o.value} label={o.label || undefined} />)}
              </datalist>
            )}
          </label>
        );
      })}
    </div>
  );
}

/** the text that leaves the pane: never the template */
export const outgoing = (cmd: string, values: PhValues) => fillPlaceholders(cmd, values);

export const rememberPh = (lane: string, name: string, v: string) => {
  if (v.trim()) paneRemember(memKey(lane, name), v);
};
