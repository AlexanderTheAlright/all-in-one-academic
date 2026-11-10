
import type { ExploreColumn, ExploreColType, VlSpec } from "@/lib/api";

export const MARKS = ["bar", "line", "point", "area", "rect", "boxplot", "tick"] as const;
export const AGGS = ["", "mean", "sum", "count", "median", "min", "max"] as const;
export const OPS = ["==", "!=", ">", "<", ">=", "<=", "in"] as const;
export const TYPES: ExploreColType[] = ["quantitative", "nominal", "ordinal", "temporal"];

export const SORTS = [
  { v: "", label: "none" },
  { v: "ascending", label: "ascending" },
  { v: "descending", label: "descending" },
  { v: "-y", label: "by y (desc)" },
] as const;

export type Form = {
  mark: string;
  xField: string; xType: ExploreColType;
  yField: string; yType: ExploreColType; yAgg: string;
  colorField: string; facetField: string;
  sortX: string;
  filterField: string; filterOp: string; filterValue: string;
  title: string; xTitle: string; yTitle: string;
  width: number; height: number; logY: boolean;
};

export const EMPTY_FORM: Form = {
  mark: "bar", xField: "", xType: "nominal", yField: "", yType: "quantitative", yAgg: "",
  colorField: "", facetField: "", sortX: "", filterField: "", filterOp: "==", filterValue: "",
  title: "", xTitle: "", yTitle: "", width: 460, height: 280, logY: false,
};

const isNum = (s: string) => /^-?\d+(\.\d+)?$/.test(s.trim());
const lit = (s: string) => (isNum(s) ? s.trim() : JSON.stringify(s));
const fieldRef = (f: string) => `datum[${JSON.stringify(f)}]`;

export function typeOf(cols: ExploreColumn[], name: string): ExploreColType {
  return cols.find((c) => c.name === name)?.type || "nominal";
}

/** the one filter row -> a Vega expression. `in` takes a comma-separated list. */
export function filterExpr(f: Form): string {
  if (!f.filterField || !f.filterValue.trim()) return "";
  if (f.filterOp === "in") {
    const vals = f.filterValue.split(",").map((v) => lit(v)).filter(Boolean);
    if (!vals.length) return "";
    return `indexof([${vals.join(", ")}], ${fieldRef(f.filterField)}) >= 0`;
  }
  return `${fieldRef(f.filterField)} ${f.filterOp} ${lit(f.filterValue)}`;
}

export function formToVl(f: Form): VlSpec {
  const enc: Record<string, unknown> = {};
  if (f.xField) {
    const x: Record<string, unknown> = { field: f.xField, type: f.xType };
    if (f.sortX) x.sort = f.sortX;
    if (f.xTitle) x.axis = { title: f.xTitle };
    enc.x = x;
  }
  if (f.yAgg === "count") {
    const y: Record<string, unknown> = { aggregate: "count", type: "quantitative" };
    if (f.logY) y.scale = { type: "log" };
    if (f.yTitle) y.axis = { title: f.yTitle };
    enc.y = y;
  } else if (f.yField) {
    const y: Record<string, unknown> = { field: f.yField, type: f.yType };
    if (f.yAgg) y.aggregate = f.yAgg;
    if (f.logY) y.scale = { type: "log" };
    if (f.yTitle) y.axis = { title: f.yTitle };
    enc.y = y;
  }
  if (f.colorField) enc.color = { field: f.colorField, type: "nominal" };
  if (f.facetField) enc.column = { field: f.facetField, type: "nominal" };

  const out: Record<string, unknown> = {
    $schema: "https://vega.github.io/schema/vega-lite/v5.json",
    data: { url: "data.json" },
    mark: f.mark,
    width: Math.max(120, Math.min(1400, Math.round(f.width) || 460)),
    height: Math.max(90, Math.min(1200, Math.round(f.height) || 280)),
    encoding: enc,
  };
  if (f.title.trim()) out.title = f.title.trim();
  const expr = filterExpr(f);
  if (expr) out.transform = [{ filter: expr }];
  return out;
}

const asRec = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const str = (v: unknown, d = "") => (typeof v === "string" ? v : d);
const num = (v: unknown, d: number) => (typeof v === "number" && isFinite(v) ? v : d);

/** the expression forms formToVl emits, read back. Anything else leaves the filter row
 *  empty and lives on in the Raw JSON box, where it is still previewed and saved. */
function parseFilter(expr: string): Pick<Form, "filterField" | "filterOp" | "filterValue"> | null {
  const inM = /^indexof\(\[(.*)\],\s*datum\[("(?:[^"\\]|\\.)*")\]\)\s*>=\s*0$/.exec(expr.trim());
  if (inM) {
    const vals = inM[1].split(",").map((v) => v.trim()).map((v) => {
      try { return typeof JSON.parse(v) === "string" ? (JSON.parse(v) as string) : v; } catch { return v; }
    });
    try { return { filterField: JSON.parse(inM[2]) as string, filterOp: "in", filterValue: vals.join(", ") }; }
    catch { return null; }
  }
  const m = /^datum\[("(?:[^"\\]|\\.)*")\]\s*(==|!=|>=|<=|>|<)\s*(.+)$/.exec(expr.trim());
  if (!m) return null;
  let v = m[3].trim();
  try { const p = JSON.parse(v); if (typeof p === "string") v = p; } catch { /* a bare number */ }
  try { return { filterField: JSON.parse(m[1]) as string, filterOp: m[2], filterValue: v }; }
  catch { return null; }
}

export function vlToForm(vl: VlSpec | null, cols: ExploreColumn[]): Form {
  const f: Form = { ...EMPTY_FORM };
  if (!vl) return f;
  const markRaw = vl.mark;
  f.mark = typeof markRaw === "string" ? markRaw : str(asRec(markRaw)?.type, "bar");
  f.width = num(vl.width, EMPTY_FORM.width);
  f.height = num(vl.height, EMPTY_FORM.height);
  const title = vl.title;
  f.title = typeof title === "string" ? title : str(asRec(title)?.text, "");

  const enc = asRec(vl.encoding) || {};
  const x = asRec(enc.x);
  if (x) {
    f.xField = str(x.field);
    f.xType = (TYPES.includes(str(x.type) as ExploreColType) ? str(x.type) : typeOf(cols, f.xField)) as ExploreColType;
    const sort = x.sort;
    f.sortX = typeof sort === "string" ? sort : "";
    f.xTitle = str(asRec(x.axis)?.title);
  }
  const y = asRec(enc.y);
  if (y) {
    f.yField = str(y.field);
    f.yAgg = str(y.aggregate);
    f.yType = (TYPES.includes(str(y.type) as ExploreColType) ? str(y.type) : typeOf(cols, f.yField)) as ExploreColType;
    f.logY = str(asRec(y.scale)?.type) === "log";
    f.yTitle = str(asRec(y.axis)?.title);
  }
  f.colorField = str(asRec(enc.color)?.field);
  f.facetField = str(asRec(enc.column)?.field) || str(asRec(asRec(vl.facet)?.column)?.field);

  const tf = Array.isArray(vl.transform) ? (vl.transform as unknown[]) : [];
  for (const t of tf) {
    const expr = asRec(t)?.filter;
    if (typeof expr !== "string") continue;
    const got = parseFilter(expr);
    if (got) { Object.assign(f, got); break; }
  }
  return f;
}

/** Validate what is in the Raw JSON box. A spec must be drawable: a mark with an
 *  encoding, or a composition (layer / facet / hconcat / vconcat / repeat). */
export function validateSpec(text: string): { ok: true; vl: VlSpec } | { ok: false; error: string } {
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch (e) { return { ok: false, error: (e as Error).message }; }
  const r = asRec(parsed);
  if (!r) return { ok: false, error: "the spec must be a JSON object" };
  const drawable = (("mark" in r) && ("encoding" in r))
    || "layer" in r || "facet" in r || "hconcat" in r || "vconcat" in r || "repeat" in r;
  if (!drawable) return { ok: false, error: "needs mark + encoding, or layer / facet" };
  return { ok: true, vl: r as VlSpec };
}

export function applyForm(prev: VlSpec | null, f: Form): VlSpec {
  const base = formToVl(f) as Record<string, unknown>;
  const out: Record<string, unknown> = { ...(prev || {}), ...base };
  const prevEnc = asRec((prev || {}).encoding) || {};
  const managed = new Set(["x", "y", "color", "column"]);
  const enc: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(prevEnc)) if (!managed.has(k)) enc[k] = v;
  Object.assign(enc, asRec(base.encoding) || {});
  out.encoding = enc;
  const prevT = Array.isArray((prev || {}).transform) ? ((prev as Record<string, unknown>).transform as unknown[]) : [];
  const kept = prevT.filter((t) => {
    const r = asRec(t);
    return !(r && typeof r.filter === "string" && parseFilter(r.filter));
  });
  const mine = Array.isArray(base.transform) ? (base.transform as unknown[]) : [];
  const tf = [...kept, ...mine];
  if (tf.length) out.transform = tf; else delete out.transform;
  if (!f.title.trim()) delete out.title;
  return out as VlSpec;
}

export const pretty = (vl: VlSpec | null) => JSON.stringify(vl ?? {}, null, 2);
