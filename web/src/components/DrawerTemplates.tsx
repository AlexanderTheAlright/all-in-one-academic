
import { useEffect, useMemo, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import { toast } from "sonner";
import { LayoutTemplate, Loader2, Plus, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import type { DrawerTemplate } from "@/lib/api";
import { exportSvg, migrate } from "@/lib/aioadraw";
import type { Doc } from "@/lib/aioadraw";
import { loadFonts } from "@/lib/aioadrawFonts";

/* the paper stays white in both themes, like the canvas */
export function TemplateThumb({ doc, className }: { doc: unknown; className?: string }) {
  const [fonts, setFonts] = useState(0);
  useEffect(() => { let live = true; void loadFonts().then(() => { if (live) setFonts(1); }); return () => { live = false; }; }, []);
  const svg = useMemo(() => {
    const d = migrate(doc);
    return d && d.elements.length ? exportSvg(d, "").svg : "";
    // fonts: re-measure once the faces have loaded
  }, [doc, fonts]); // eslint-disable-line react-hooks/exhaustive-deps
  return <div aria-hidden="true" className={"bg-white [&>svg]:block [&>svg]:h-full [&>svg]:w-full " + (className || "")} dangerouslySetInnerHTML={{ __html: svg }} />;
}

const COLS = 3;

export function TemplatesPopover({ what, getDoc, startNaming, keyRef, onInsert, onClose }: {
  what: "selection" | "diagram" | null;   // what Save would take; null = nothing drawn yet
  getDoc: () => Doc;                      // the template document for that, read at save time
  startNaming: boolean;                   // opened by "Save as template…": straight to the name
  keyRef: MutableRefObject<((e: KeyboardEvent) => void) | null>;
  onInsert: (doc: Doc) => void;
  onClose: () => void;
}) {
  const [items, setItems] = useState<DrawerTemplate[] | null>(null);
  const [idx, setIdx] = useState(-1);                    // -1 = the Save button
  const [naming, setNaming] = useState<string | null>(startNaming && what ? "" : null);
  const [replace, setReplace] = useState<string | null>(null);   // the taken name Enter would replace
  const [busy, setBusy] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);

  // focus: the template the keys land on afterwards; null = the first one (on opening)
  const reload = (focus?: string | null) => api.noteDrawerTemplates().then((r) => {
    setItems(r.items);
    setIdx((i) => Math.min(focus === null ? 0 : focus ? r.items.findIndex((t) => t.name === focus) : i, r.items.length - 1));
  }).catch(() => { setItems([]); toast.error("Couldn't load the templates"); });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void reload(startNaming ? undefined : null); }, []);
  useEffect(() => { gridRef.current?.querySelector(`[data-idx="${idx}"]`)?.scrollIntoView({ block: "nearest" }); }, [idx]);

  const insert = (t: DrawerTemplate | undefined) => {
    const d = t ? migrate(t.doc) : null;
    if (d && d.elements.length) onInsert(d);
  };
  const save = async () => {
    const name = (naming || "").trim();
    if (!name || busy || !what) return;
    // a name already in the list asks before any request; the server's 409 covers the rest
    if (replace !== name && items?.some((t) => t.name === name)) { setReplace(name); return; }
    setBusy(true);
    try {
      const r = await api.noteDrawerTemplateSave({ name, doc: getDoc(), overwrite: replace === name });
      if (r.ok) {
        toast.success((replace === name ? "Replaced template " : "Saved template ") + (r.name || name));
        setNaming(null); setReplace(null);
        await reload(r.name || name);
      } else if (r.exists) setReplace(name);
      else toast.error(r.error || "Couldn't save the template");
    } catch { toast.error("Couldn't save the template — is the server up?"); }
    finally { setBusy(false); }
  };
  // Delete MOVES the file to Preparation/Diagrams/archive/; Undo saves the copy held here back
  const archive = async (t: DrawerTemplate | undefined) => {
    if (!t || busy) return;
    const r = await api.noteDrawerTemplateDelete(t.name).catch(() => null);
    if (!r?.ok) { toast.error(r?.error || "Couldn't delete the template"); return; }
    void reload();
    toast.success("Deleted template " + t.name, {
      description: "Moved to Preparation/Diagrams/archive",
      action: t.doc ? { label: "Undo", onClick: () => { void api.noteDrawerTemplateSave({ name: t.name, doc: t.doc }).then((u) => {
        if (!u.ok) toast.error(u.error || "Couldn't restore"); void reload(t.name);
      }); } } : undefined,
    });
  };

  const n = items?.length ?? 0;
  const onKey = (e: KeyboardEvent) => {
    const k = e.key;
    e.stopPropagation();
    if (naming !== null) {   // typing goes to the input; only Enter and Esc are ours
      if (k === "Escape") { e.preventDefault(); if (replace) setReplace(null); else setNaming(null); }
      else if (k === "Enter") { e.preventDefault(); void save(); }
      return;
    }
    e.preventDefault();
    if (k === "Escape") onClose();
    else if (k === "ArrowRight") setIdx((i) => Math.min(i + 1, n - 1));
    else if (k === "ArrowLeft") setIdx((i) => Math.max(i - 1, n ? 0 : -1));
    else if (k === "ArrowDown") setIdx((i) => (i < 0 ? (n ? 0 : -1) : Math.min(i + COLS, n - 1)));
    else if (k === "ArrowUp") setIdx((i) => (i < COLS ? -1 : i - COLS));
    else if (k === "Enter") { if (idx < 0) { if (what) setNaming(""); } else insert(items?.[idx]); }
    else if (k === "Delete" || k === "Backspace") void archive(items?.[idx]);
  };
  useEffect(() => { keyRef.current = onKey; });
  useEffect(() => () => { keyRef.current = null; }, [keyRef]);

  const saveLabel = what === "selection" ? "Save selection as template" : "Save diagram as template";
  return (
    <>
      <div className="absolute inset-0 z-10" onPointerDown={(e) => { e.preventDefault(); onClose(); }} onContextMenu={(e) => e.preventDefault()} />
      <div role="dialog" aria-label="Templates" data-testid="drawer-templates"
        className="absolute z-20 top-[49px] left-1/2 -translate-x-1/2 w-[372px] max-w-[calc(100%-16px)] max-h-[calc(100%-57px)] flex flex-col rounded-lg border border-border bg-card text-foreground shadow-lg"
        onPointerDown={(e) => e.stopPropagation()}>
        <div className="shrink-0 flex items-center gap-1.5 p-1.5 border-b border-border">
          <LayoutTemplate size={14} className="text-muted-foreground shrink-0 ml-1" />
          {naming === null ? (
            <button type="button" onClick={() => setNaming("")} disabled={!what} title={saveLabel + " (Enter)"} data-testid="template-save"
              className={"flex-1 min-w-0 h-7 px-2 rounded-md inline-flex items-center gap-1.5 text-[12px] text-left hover:bg-accent disabled:opacity-40 disabled:hover:bg-transparent" + (idx < 0 && what ? " bg-accent" : "")}>
              <Plus size={13} className="shrink-0" /><span className="truncate">{saveLabel}</span>
            </button>
          ) : (
            <>
              <input autoFocus value={naming} onChange={(e) => { setNaming(e.target.value); setReplace(null); }} maxLength={80}
                placeholder="Template name…" aria-label="Template name" data-testid="template-name"
                title={replace ? `"${replace}" exists — Enter replaces it, Esc goes back` : "Enter to save, Esc to cancel"}
                className={"flex-1 min-w-0 h-7 bg-secondary/40 border rounded-md px-2 text-[12px] focus:outline-none " + (replace ? "border-destructive" : "border-primary")} />
              <button type="button" onClick={() => void save()} disabled={busy || !naming.trim()} data-testid="template-confirm"
                title={replace ? `Replace the existing "${replace}" (Enter)` : "Save (Enter)"}
                className={"shrink-0 h-7 px-2.5 rounded-md inline-flex items-center gap-1.5 text-[12px] hover:opacity-90 disabled:opacity-50 " + (replace ? "bg-destructive text-destructive-foreground" : "bg-primary text-primary-foreground")}>
                {busy && <Loader2 size={12} className="animate-spin" />}{replace ? "Replace" : "Save"}
              </button>
            </>
          )}
        </div>
        {items === null ? (
          <div className="p-4 flex justify-center"><Loader2 size={16} className="animate-spin text-muted-foreground" /></div>
        ) : n === 0 ? (
          <div className="px-3 py-3 text-[12px] text-muted-foreground">No templates yet.</div>
        ) : (
          <div ref={gridRef} role="listbox" aria-label="Templates" className="min-h-0 overflow-y-auto p-1.5 grid gap-1.5" style={{ gridTemplateColumns: `repeat(${COLS}, minmax(0, 1fr))` }}>
            {items.map((t, i) => (
              <div key={t.name} role="option" aria-selected={idx === i} data-idx={i} data-template={t.name}
                title={t.doc ? `Insert ${t.name} (Enter)` : `${t.name} is too large to open here`}
                onClick={() => { setIdx(i); insert(t); }} onPointerEnter={() => setIdx(i)}
                className={"group relative min-w-0 rounded-md border p-1 cursor-pointer " + (idx === i ? "border-primary bg-accent" : "border-border hover:bg-accent") + (t.doc ? "" : " opacity-50")}>
                <TemplateThumb doc={t.doc} className="h-14 w-full rounded-sm border border-border/60 overflow-hidden p-0.5" />
                <div className="mt-1 text-[11px] leading-tight truncate">{t.name}</div>
                <button type="button" onClick={(e) => { e.stopPropagation(); void archive(t); }} aria-label={"Delete template " + t.name}
                  title="Delete (moves to Preparation/Diagrams/archive)"
                  className={"absolute top-1.5 right-1.5 w-5 h-5 rounded bg-card border border-border inline-flex items-center justify-center text-muted-foreground hover:text-destructive hover:border-destructive/50 group-hover:opacity-100 " + (idx === i ? "opacity-100" : "opacity-0")}>
                  <Trash2 size={11} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
