
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Pencil, Plus, Trash2, ChevronUp, ChevronDown, Save, Loader2, ExternalLink, Shapes,
} from "lucide-react";
import { api } from "@/lib/api";
import { useSaveKey } from "@/lib/savekey";
import type { NoteBlock, NoteBlocks as NoteBlocksDoc } from "@/lib/api";
import { Markdown } from "@/lib/markdown";
import { toast } from "sonner";

const KIND_LABEL: Record<string, string> = { image: "image", diagram: "diagram" };

/** the per-block edit form — a heading input (never for the preamble) + the body */
function BlockEditor({ block, onCancel, onSave, saving }: {
  block: NoteBlock;
  onCancel: () => void;
  onSave: (patch: { heading?: string; body: string }) => void;
  saving: boolean;
}) {
  const [heading, setHeading] = useState(block.heading ?? "");
  const [body, setBody] = useState(block.body ?? "");
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);

  const commit = () => onSave(block.heading === null ? { body } : { heading, body });
  // ctrl/cmd+s writes this section, the same thing the Save button does
  useSaveKey(() => { if (!saving) commit(); });

  return (
    <div className="grid gap-2"
      onKeyDown={(e) => {
        if (e.key === "Escape" && !e.defaultPrevented) {
          // the first Esc while typing only stops typing (the arrow engine arms the
          // field); the next one cancels the section edit
          const t = e.target as HTMLElement;
          if ((t.tagName === "INPUT" || t.tagName === "TEXTAREA") && !t.hasAttribute("data-knav-armed")) return;
          e.preventDefault(); e.stopPropagation(); onCancel();
        }
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commit(); }
      }}>
      {block.heading !== null && (
        <input value={heading} onChange={(e) => setHeading(e.target.value)}
          placeholder="Section heading"
          className="w-full bg-background border border-border rounded-md px-3 py-1.5 text-[14px] font-semibold focus:outline-none focus:border-primary" />
      )}
      <textarea ref={ref} value={body} onChange={(e) => setBody(e.target.value)}
        className="w-full min-h-[160px] bg-background border border-border rounded-md px-3 py-2 text-[13px] leading-relaxed resize-y focus:outline-none focus:border-primary"
        style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }} />
      <div className="flex items-center gap-2">
        <button onClick={commit} disabled={saving}
          className="inline-flex items-center gap-1.5 rounded-full bg-primary text-primary-foreground px-3.5 py-1.5 text-[12px] font-medium hover:opacity-90 disabled:opacity-40">
          {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />} Save section
        </button>
        <button onClick={onCancel} disabled={saving} data-knav-back="2"
          className="rounded-full border border-border px-3 py-1.5 text-[12px] text-muted-foreground hover:text-foreground disabled:opacity-40">Cancel</button>
        <span className="text-[11px] text-muted-foreground/60">only this section is written</span>
      </div>
    </div>
  );
}

export function NoteBlocks({ path, mtime, initial, onChanged, onUnavailable, readonly }: {
  path: string;
  mtime?: number;
  /** the caller already probed /notes/blocks — reuse it instead of asking twice.
   * Mount-time only: give the component a key={path} so a new note remounts. */
  initial?: NoteBlocksDoc | null;
  /** a write landed — the drawer re-reads the note and the graph ticks */
  onChanged?: () => void;
  
  onUnavailable?: () => void;
  readonly?: boolean;
}) {
  const [doc, setDoc] = useState<NoteBlocksDoc | null>(initial && initial.ok ? initial : null);
  const [editing, setEditing] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const onUnavailableRef = useRef(onUnavailable); onUnavailableRef.current = onUnavailable;

  const load = useCallback(async (): Promise<NoteBlocksDoc | null> => {
    try {
      const r = await api.noteBlocks(path);
      if (!r || !r.ok) { onUnavailableRef.current?.(); return null; }
      setDoc(r);
      return r;
    } catch { onUnavailableRef.current?.(); return null; }
  }, [path]);

  // mount-time only — the caller remounts (key={path}) when the note changes, and
  // every write below refetches explicitly
  const seeded = useRef(!!(initial && initial.ok));
  useEffect(() => { if (!seeded.current) load(); }, [load]);

  // every write refetches: block indices and line ranges move under an add/delete/move
  const after = async (r: { ok: boolean; error?: string }, ok: string) => {
    if (!r.ok) { toast.error(r.error || "Couldn't write that section"); return false; }
    await load();
    onChanged?.();
    toast.success(ok);
    return true;
  };

  const save = async (i: number, patch: { heading?: string; body: string }) => {
    setBusy(true);
    try {
      const r = await api.noteBlockSave(path, i, patch);
      if (await after(r, "Section saved")) setEditing(null);
    } catch { toast.error("Couldn't reach the note"); }
    finally { setBusy(false); }
  };

  // a new section is always a plain text stub — the backend re-infers its kind
  // from whatever ends up inside it, so nothing here stores a kind
  const add = async (afterIndex?: number) => {
    setBusy(true);
    try {
      const r = await api.noteBlockAdd(path, "New section", "", afterIndex);
      if (await after(r, "Section added") && typeof r.index === "number") setEditing(r.index);
    } catch { toast.error("Couldn't reach the note"); }
    finally { setBusy(false); }
  };

  const remove = async (i: number, heading: string | null) => {
    if (!window.confirm(`Delete the section "${heading || ""}" and its contents?`)) return;
    setBusy(true);
    try {
      const r = await api.noteBlockDelete(path, i);
      if (await after(r, "Section deleted")) setEditing(null);
    } catch { toast.error("Couldn't reach the note"); }
    finally { setBusy(false); }
  };

  const move = async (i: number, to: number) => {
    setBusy(true);
    try {
      const r = await api.noteBlockMove(path, i, to);
      if (await after(r, "Section moved")) setEditing(null);
    } catch { toast.error("Couldn't reach the note"); }
    finally { setBusy(false); }
  };

  if (!doc) return null;

  const blocks = doc.blocks || [];
  const last = blocks.length - 1;
  // the v= stamp is load-bearing: redrawing a diagram rewrites the SAME .png name
  const stamp = doc.mtime || mtime || 0;
  const embedSrc = (n: string) => api.noteAttachmentUrl(n) + "&v=" + stamp;

  return (
    <div className="grid gap-2" data-testid="note-blocks">
      {blocks.map((b) => {
        const isEditing = editing === b.i;
        const empty = !(b.body || "").trim() && !b.heading;
        if (empty && !isEditing && b.i === 0 && blocks.length > 1) return null;   // no empty preamble card
        return (
          <div key={b.i} data-block={b.i}
            className={`group relative rounded-lg border px-4 py-3 transition-colors ${
              isEditing ? "border-primary/60 bg-card" : "border-transparent hover:border-border hover:bg-secondary/25"}`}>
            {!isEditing && (
              <div className="absolute right-2 top-2 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-within:opacity-100 transition-opacity">
                {!readonly && (
                  <button onClick={() => setEditing(b.i)} title="Edit this section" disabled={busy}
                    className="h-6 w-6 inline-flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-secondary disabled:opacity-40">
                    <Pencil size={12} />
                  </button>
                )}
                {!readonly && b.i > 1 && (
                  <button onClick={() => move(b.i, b.i - 1)} title="Move section up" disabled={busy}
                    className="h-6 w-6 inline-flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-secondary disabled:opacity-40">
                    <ChevronUp size={12} />
                  </button>
                )}
                {!readonly && b.i >= 1 && b.i < last && (
                  <button onClick={() => move(b.i, b.i + 1)} title="Move section down" disabled={busy}
                    className="h-6 w-6 inline-flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-secondary disabled:opacity-40">
                    <ChevronDown size={12} />
                  </button>
                )}
                {!readonly && (
                  <button onClick={() => add(b.i)} title="Add a section below" disabled={busy}
                    className="h-6 w-6 inline-flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-secondary disabled:opacity-40">
                    <Plus size={12} />
                  </button>
                )}
                {!readonly && b.i >= 1 && (
                  <button onClick={() => remove(b.i, b.heading)} title="Delete this section" disabled={busy}
                    className="h-6 w-6 inline-flex items-center justify-center rounded text-muted-foreground hover:text-destructive hover:bg-secondary disabled:opacity-40">
                    <Trash2 size={12} />
                  </button>
                )}
              </div>
            )}

            {isEditing ? (
              <BlockEditor block={b} saving={busy} onCancel={() => setEditing(null)}
                onSave={(patch) => save(b.i, patch)} />
            ) : (
              <div onClick={() => { if (!readonly && !busy) setEditing(b.i); }}
                {...(readonly ? {} : {
                  role: "button", tabIndex: 0,
                  "aria-label": `Edit section${b.heading ? ` ${b.heading}` : ""}`,
                  onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => {
                    if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
                    e.preventDefault();
                    if (!busy) setEditing(b.i);
                  },
                })}
                className={readonly ? "" : "cursor-text rounded-md outline-none"}>
                {b.heading !== null && (
                  <div className="flex items-baseline gap-2 mb-1.5">
                    <h3 className="text-[15px] font-semibold tracking-tight text-foreground">{b.heading}</h3>
                    {KIND_LABEL[b.kind] && (
                      <span className="text-[9.5px] uppercase tracking-wide text-muted-foreground/60">{KIND_LABEL[b.kind]}</span>
                    )}
                  </div>
                )}
                <div className="prose-notes text-[13.5px] leading-relaxed">
                  <Markdown text={(b.body || "").trim() || "*(empty section)*"}
                    idPrefix={`nb-${b.i}-`} embedSrc={embedSrc} />
                </div>
                {b.kind === "diagram" && b.asset?.source_path && (
                  <button onClick={(e) => { e.stopPropagation(); api.open(b.asset!.source_path!); }}
                    className="mt-1.5 inline-flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-primary">
                    <Shapes size={11} /> Open the drawing in Obsidian <ExternalLink size={10} />
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}

      {!readonly && (
        <div className="pt-1">
          <button onClick={() => add()} disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-border px-3.5 py-1.5 text-[12px] text-muted-foreground hover:text-foreground hover:border-primary/50 transition-colors disabled:opacity-40">
            <Plus size={12} /> Add a section
          </button>
        </div>
      )}
    </div>
  );
}
