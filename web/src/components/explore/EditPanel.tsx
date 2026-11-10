
import type { ExploreColumn, ExploreMeta, ExploreSpec } from "@/lib/api";
import { Btn, Field, Line, Num, Sel, Toggle, Txt } from "@/components/explore/ui";
import { AGGS, MARKS, OPS, SORTS, TYPES } from "@/components/explore/vlform";
import type { Form } from "@/components/explore/vlform";

const opt = (v: string, label?: string) => ({ v, label: label ?? (v || "—") });

export function EditPanel({
  spec, meta, form, setForm, raw, setRaw, rawOpen, setRawOpen, rawError, onValidate,
  dirty, busy, saveError, conflictVersion, previewError, onSave, onRevert, onRefetch,
}: {
  spec: ExploreSpec;
  meta: ExploreMeta | null;
  form: Form;
  setForm: (patch: Partial<Form>) => void;
  raw: string;
  setRaw: (v: string) => void;
  rawOpen: boolean;
  setRawOpen: (v: boolean) => void;
  rawError: string | null;
  onValidate: () => void;
  dirty: boolean;
  busy: string | null;
  saveError: string | null;
  conflictVersion: number | null;
  previewError: string | null;
  onSave: () => void;
  onRevert: () => void;
  onRefetch: () => void;
}) {
  const cols: ExploreColumn[] = meta?.columns || [];
  const fieldOpts = [opt("", "—"), ...cols.map((c) => opt(c.name))];
  const isImage = spec.kind !== "vl";

  if (isImage) {
    return (
      <div className="space-y-3 p-3">
        <div title="static figure, comment only"
          className="rounded-md border border-dashed border-border px-3 py-6 text-center text-[12px] text-muted-foreground">
          static figure, comment only
        </div>
        <Btn onClick={onRefetch} title="Re-run the producer for this figure and redraw it"
          disabled={busy !== null}>{busy === "refetch" ? "Refetching…" : "Refetch data"}</Btn>
      </div>
    );
  }

  return (
    <div className="space-y-3 p-3">
      <div className="grid grid-cols-2 gap-x-2 gap-y-2.5">
        <Field label="Mark" hint="The chart's geometry">
          <Sel value={form.mark} onChange={(v) => setForm({ mark: v })}
            options={MARKS.map((m) => opt(m))} title="Mark type" />
        </Field>
        <Field label="Sort x" hint="Order of the x categories">
          <Sel value={form.sortX} onChange={(v) => setForm({ sortX: v })}
            options={SORTS.map((s) => opt(s.v, s.label))} title="Sort the x axis" />
        </Field>

        <Field label="X field" hint="Column on the horizontal axis">
          <Sel value={form.xField} onChange={(v) => setForm({ xField: v })} options={fieldOpts} title="X field" />
        </Field>
        <Field label="X type" hint="How the renderer should scale x">
          <Sel value={form.xType} onChange={(v) => setForm({ xType: v as Form["xType"] })}
            options={TYPES.map((t) => opt(t))} title="X type" />
        </Field>

        <Field label="Y field" hint="Column on the vertical axis">
          <Sel value={form.yField} onChange={(v) => setForm({ yField: v })} options={fieldOpts}
            title="Y field" disabled={form.yAgg === "count"} />
        </Field>
        <Field label="Y type" hint="How the renderer should scale y">
          <Sel value={form.yType} onChange={(v) => setForm({ yType: v as Form["yType"] })}
            options={TYPES.map((t) => opt(t))} title="Y type" disabled={form.yAgg === "count"} />
        </Field>

        <Field label="Y aggregate" hint="Collapse y within each x">
          <Sel value={form.yAgg} onChange={(v) => setForm({ yAgg: v })}
            options={AGGS.map((a) => opt(a, a || "none"))} title="Y aggregate" />
        </Field>
        <Field label="Log y" hint="Log scale on the vertical axis">
          <Toggle on={form.logY} onChange={(v) => setForm({ logY: v })}
            label={form.logY ? "log" : "linear"} title="Log scale on y" />
        </Field>

        <Field label="Colour by" hint="Split the marks by a categorical column">
          <Sel value={form.colorField} onChange={(v) => setForm({ colorField: v })} options={fieldOpts} title="Colour field" />
        </Field>
        <Field label="Facet (column)" hint="One small chart per value, side by side">
          <Sel value={form.facetField} onChange={(v) => setForm({ facetField: v })} options={fieldOpts} title="Facet field" />
        </Field>
      </div>

      <fieldset className="grid grid-cols-[1fr_auto_1.2fr] gap-2 rounded-md border border-border p-2">
        <legend className="px-1 text-[10.5px] uppercase tracking-wide text-muted-foreground">Filter</legend>
        <Sel value={form.filterField} onChange={(v) => setForm({ filterField: v })} options={fieldOpts} title="Filter field" />
        <Sel value={form.filterOp} onChange={(v) => setForm({ filterOp: v })}
          options={OPS.map((o) => opt(o))} title="Comparison" />
        <Txt value={form.filterValue} onChange={(v) => setForm({ filterValue: v })}
          placeholder={form.filterOp === "in" ? "a, b, c" : "value"}
          title={form.filterOp === "in" ? "Comma-separated values" : "The value to compare against"} />
      </fieldset>

      <div className="grid grid-cols-2 gap-x-2 gap-y-2.5">
        <Field label="Title" wide hint="The chart's own title">
          <Txt value={form.title} onChange={(v) => setForm({ title: v })} placeholder={spec.title} title="Chart title" />
        </Field>
        <Field label="X axis title" hint="Overrides the field name">
          <Txt value={form.xTitle} onChange={(v) => setForm({ xTitle: v })} title="X axis title" />
        </Field>
        <Field label="Y axis title" hint="Overrides the field name">
          <Txt value={form.yTitle} onChange={(v) => setForm({ yTitle: v })} title="Y axis title" />
        </Field>
        <Field label="Width" hint="Drawing width in points">
          <Num value={form.width} onChange={(v) => setForm({ width: v })} min={120} max={1400} title="Width" />
        </Field>
        <Field label="Height" hint="Drawing height in points">
          <Num value={form.height} onChange={(v) => setForm({ height: v })} min={90} max={1200} title="Height" />
        </Field>
      </div>

      <details open={rawOpen} className="rounded-md border border-border">
        <summary onClick={(e) => { e.preventDefault(); setRawOpen(!rawOpen); }}
          title="The Vega-Lite spec this form writes"
          className="cursor-pointer list-none px-2.5 py-1.5 text-[11.5px] text-muted-foreground hover:text-foreground">
          Raw JSON
        </summary>
        <div className="space-y-2 border-t border-border p-2">
          <textarea value={raw} onChange={(e) => setRaw(e.target.value)} spellCheck={false} rows={10}
            title="Vega-Lite spec — Validate applies it"
            className="w-full rounded-md border border-input bg-card p-2 font-mono text-[11px] leading-snug text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/60" />
          <div className="flex items-center gap-2">
            <Btn onClick={onValidate} title="Parse the spec and apply it to the preview">Validate</Btn>
            {rawError && <Line tone="bad">{rawError}</Line>}
          </div>
        </div>
      </details>

      <div className="flex flex-wrap items-center gap-2">
        <Btn onClick={onSave} tone="primary" disabled={!dirty || busy !== null}
          title={dirty ? `Save as version ${spec.version + 1}` : "Nothing changed since the saved spec"}>
          {busy === "save" ? "Saving…" : "Save"}
        </Btn>
        <Btn onClick={onRevert} disabled={!dirty || busy !== null} title="Go back to the saved spec">Revert</Btn>
        <Btn onClick={onRefetch} disabled={busy !== null}
          title="Re-run the producer's query and redraw this figure">
          {busy === "refetch" ? "Refetching…" : "Refetch data"}
        </Btn>
        {conflictVersion !== null && (
          <Btn onClick={onRevert} tone="danger" title={`The store holds version ${conflictVersion}. Reload it and re-apply your change.`}>
            Reload v{conflictVersion}
          </Btn>
        )}
      </div>
      {saveError && <Line tone="bad">{saveError}</Line>}
      {previewError && <Line tone="bad">{previewError}</Line>}
    </div>
  );
}
