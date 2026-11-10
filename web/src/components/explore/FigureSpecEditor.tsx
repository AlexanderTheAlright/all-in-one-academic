
import { useCallback, useEffect, useRef, useState } from "react";
import { exploreApi } from "@/lib/api";
import type { ExploreMeta, ExploreSpec, VlSpec } from "@/lib/api";
import { EditPanel } from "@/components/explore/EditPanel";
import { applyForm, pretty, validateSpec, vlToForm } from "@/components/explore/vlform";
import type { Form } from "@/components/explore/vlform";

export type FigureTarget =
  | { source: "open"; id: string }
  | { source: "project"; slug: string; stem: string };

export function FigureSpecEditor({ target, spec, meta, theme, onPreview, onSaved }: {
  target: FigureTarget;
  spec: ExploreSpec;
  meta: ExploreMeta | null;
  theme: "day" | "night";
  onPreview: (svg: string | null) => void;
  onSaved: () => void;
}) {
  const [form, setFormState] = useState<Form>(() => vlToForm(spec.vl, meta?.columns || []));
  const [vl, setVl] = useState<VlSpec | null>(spec.vl);
  const [raw, setRaw] = useState(() => pretty(spec.vl));
  const [rawOpen, setRawOpen] = useState(false);
  const [rawError, setRawError] = useState<string | null>(null);
  const [savedKey, setSavedKey] = useState(() => JSON.stringify(spec.vl));
  const [busy, setBusy] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflictVersion, setConflictVersion] = useState<number | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  // a different figure (or a new saved version) re-seeds every field from the spec
  const key = target.source === "open" ? target.id : target.slug + "/" + target.stem;
  const seeded = useRef("");
  useEffect(() => {
    const k = key + ":" + spec.version;
    if (seeded.current === k) return;
    seeded.current = k;
    setVl(spec.vl);
    setRaw(pretty(spec.vl));
    setFormState(vlToForm(spec.vl, meta?.columns || []));
    setSavedKey(JSON.stringify(spec.vl));
    setRawError(null); setSaveError(null); setConflictVersion(null); setPreviewError(null);
    onPreview(null);
  }, [key, spec, meta, onPreview]);

  const dirty = vl !== null && JSON.stringify(vl) !== savedKey;

  const body = useCallback((extra: Record<string, unknown>) => (
    target.source === "open"
      ? { source: "open", id: target.id, ...extra }
      : { source: "project", slug: target.slug, stem: target.stem, ...extra }
  ), [target]);

  // the preview IS the Preview button
  useEffect(() => {
    if (!dirty || !vl) { onPreview(null); setPreviewError(null); return; }
    const ctl = new AbortController();
    const t = window.setTimeout(() => {
      exploreApi.previewAt(body({ vl, theme }), ctl.signal)
        .then((svg) => { onPreview(svg); setPreviewError(null); })
        .catch((e: Error) => { if (e.name !== "AbortError") setPreviewError(e.message); });
    }, 300);
    return () => { window.clearTimeout(t); ctl.abort(); };
  }, [vl, dirty, theme, body, onPreview]);

  const setForm = useCallback((patch: Partial<Form>) => {
    setFormState((prev) => {
      const next = { ...prev, ...patch };
      setVl((cur) => { const applied = applyForm(cur, next); setRaw(pretty(applied)); return applied; });
      return next;
    });
    setRawError(null); setSaveError(null); setConflictVersion(null);
  }, []);

  const onValidate = () => {
    const r = validateSpec(raw);
    if (!r.ok) { setRawError(r.error); return; }
    setRawError(null); setSaveError(null); setConflictVersion(null);
    setVl(r.vl);
    setFormState(vlToForm(r.vl, meta?.columns || []));
  };

  const onSave = async () => {
    if (!vl) return;
    setBusy("save"); setSaveError(null); setConflictVersion(null);
    try {
      const r = await exploreApi.saveSpecAt(body({ vl, title: form.title || spec.title, baseVersion: spec.version }));
      if (r.status === 409 || r.data.conflict) {
        setConflictVersion(r.data.currentVersion ?? null);
        setSaveError(r.data.error || "this figure was saved elsewhere");
      } else if (!r.data.ok) {
        setSaveError(r.data.error || "save failed");
      } else {
        setSaveError(r.data.render || r.data.renderPng || null);
        seeded.current = "";
        onPreview(null);
        onSaved();
      }
    } catch (e) { setSaveError((e as Error).message); }
    finally { setBusy(null); }
  };

  const onRevert = () => { seeded.current = ""; setConflictVersion(null); setSaveError(null); onPreview(null); onSaved(); };

  const onRefetch = async () => {
    if (target.source !== "open") { setSaveError("refetch is a store figure's own producer"); return; }
    setBusy("refetch"); setSaveError(null);
    try {
      const r = await exploreApi.refetch(target.id);
      if (!r.data.ok) setSaveError(r.data.error || "refetch failed");
      else { seeded.current = ""; onPreview(null); onSaved(); }
    } catch (e) { setSaveError((e as Error).message); }
    finally { setBusy(null); }
  };

  return (
    <EditPanel spec={spec} meta={meta} form={form} setForm={setForm}
      raw={raw} setRaw={setRaw} rawOpen={rawOpen} setRawOpen={setRawOpen}
      rawError={rawError} onValidate={onValidate}
      dirty={dirty} busy={busy} saveError={saveError} conflictVersion={conflictVersion}
      previewError={previewError} onSave={onSave} onRevert={onRevert} onRefetch={onRefetch} />
  );
}
