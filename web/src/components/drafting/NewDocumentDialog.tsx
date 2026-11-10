
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { createPortal } from "react-dom";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PUBLISH_FORMATS, KIND_DEFAULT_PUBLISH } from "@/lib/draftStyle";
import { DOC_OUTLINE_KINDS } from "@/lib/api";
import { layerAbove } from "@/lib/arrownav";
import { typingEscape } from "@/components/draftingShared";

const OMIT_FORMATS = new Set(["thesis", "book-draft"]);
export const SUPPLEMENT_FORMATS = PUBLISH_FORMATS.filter((f) => !OMIT_FORMATS.has(f.id));

export const DEFAULT_FORMAT = "working";

// drafting.py's _SEG: the whole filename is one segment, opening on a letter or digit
// and 64 characters at most.
const SEG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
// _RESERVED_DOC_NAMES — a project doc lives outside writing/ and would be shadowed
const RESERVED = new Set(["readme.md", "plan.md", "review.md", "reviewers.md"]);

/** The filename a title implies, already inside what the server accepts. */
export function filenameFromTitle(title: string): string {
  const stem = (title || "")
    .toLowerCase()
    .trim()
    .replace(/\.md$/, "")
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9._-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 61)
    .replace(/[-.]+$/, "");
  return stem ? stem + ".md" : "";
}

/** "" when the name will land, else the one line to show under the field. */
export function nameProblem(name: string, existing: string[]): string {
  if (!name) return "";
  if (!name.endsWith(".md")) return "documents are markdown — the name ends in .md";
  if (!SEG_RE.test(name)) return "lowercase letters, digits, dots and dashes, 64 characters at most";
  if (RESERVED.has(name)) return name + " is reserved — pick another name";
  if (existing.some((e) => (e || "").trim().toLowerCase() === name)) return "already exists in this project";
  return "";
}

export function NewDocumentDialog({ open, onOpenChange, existing, onCreate }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** every filename this project's writing/ already declares or holds */
  existing: string[];
  /** true when the document was created and the dialog should close */
  onCreate: (v: { name: string; title: string; format: string; kind: string }) => Promise<boolean>;
}) {
  const [title, setTitle] = useState("");
  const [format, setFormat] = useState(DEFAULT_FORMAT);
  const [kind, setKind] = useState("");     // starter-outline key; "" = Blank
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const renamed = useRef(false);            // the filename stops following the title once it is typed in
  const rootRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const opener = useRef<HTMLElement | null>(null);

  // every open starts clean, lands the keyboard in the title, and hands focus back to
  // the row it came from — the arrow engine has nowhere else to put it
  useEffect(() => {
    if (!open) return;
    setTitle(""); setFormat(DEFAULT_FORMAT); setKind(""); setName(""); setBusy(false);
    renamed.current = false;
    opener.current = document.activeElement as HTMLElement | null;
    const id = requestAnimationFrame(() => titleRef.current?.focus({ preventScroll: true }));
    return () => {
      cancelAnimationFrame(id);
      const o = opener.current;
      opener.current = null;
      if (o && document.contains(o)) o.focus({ preventScroll: true });
    };
  }, [open]);

  // Escape, on the engine's terms: a field still holding text spends the first press
  // leaving the typing (the engine arms it), and the next press closes.
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || layerAbove(rootRef.current)) return;
      if (typingEscape(e) && (e.target as HTMLInputElement | null)?.value
          && document.documentElement.hasAttribute("data-knav")) return;
      e.preventDefault(); e.stopPropagation();
      onOpenChange(false);
    };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [open, onOpenChange]);

  const problem = useMemo(() => nameProblem(name, existing), [name, existing]);
  const ready = !!title.trim() && !!name && !problem && !busy;

  const submit = useCallback(async (e?: FormEvent) => {
    e?.preventDefault();
    if (!ready) return;
    setBusy(true);
    const ok = await onCreate({ name, title: title.trim(), format, kind });
    setBusy(false);
    if (ok) onOpenChange(false);
  }, [ready, name, title, format, kind, onCreate, onOpenChange]);
  const pickKind = useCallback((k: string) => {
    setKind(k);
    const f = KIND_DEFAULT_PUBLISH[k];
    if (f && SUPPLEMENT_FORMATS.some((x) => x.id === f)) setFormat(f);
  }, []);

  if (!open) return null;
  return createPortal(
    <div ref={rootRef} role="dialog" aria-modal="true" aria-label="New document" data-knav-modal data-newdoc="dialog"
      className="fixed inset-0 z-[170] bg-background/80 flex items-center justify-center animate-in fade-in duration-150"
      onMouseDown={() => { if (!busy) onOpenChange(false); }}>
      <form onSubmit={submit} onMouseDown={(e) => e.stopPropagation()}
        className="w-[420px] max-w-[92vw] grid gap-3.5 rounded-lg border border-border bg-card shadow-xl p-5">
        <h2 className="text-[15px] font-medium leading-none tracking-tight"
          title="A markdown document beside this one in the project's writing/ folder — it opens with the full editor, comments, versions and Publish.">
          New document
        </h2>
        <div className="grid gap-1.5">
          <Label htmlFor="newdoc-title" className="text-[12px] text-muted-foreground">Title</Label>
          <Input id="newdoc-title" ref={titleRef} data-newdoc="title" data-knav-own="arrows enter escape"
            value={title}
            onChange={(e) => { setTitle(e.target.value); if (!renamed.current) setName(filenameFromTitle(e.target.value)); }}
            placeholder="Extended abstract" className="h-9 text-[13.5px]"
            title="The document's heading — written as the H1 of the new file" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="grid gap-1.5 min-w-0">
            <Label htmlFor="newdoc-kind" className="text-[12px] text-muted-foreground">Type</Label>
            <select id="newdoc-kind" data-newdoc="kind" data-knav-own="arrows enter escape"
              value={kind} onChange={(e) => pickKind(e.target.value)}
              title="Starts the file with that kind of document's section headings"
              className="h-9 min-w-0 rounded-md border border-border bg-background px-2 text-[13.5px]">
              {DOC_OUTLINE_KINDS.map((k) => <option key={k.key || "none"} value={k.key}>{k.label}</option>)}
            </select>
          </div>
          <div className="grid gap-1.5 min-w-0">
            <Label htmlFor="newdoc-format" className="text-[12px] text-muted-foreground">Format</Label>
            <select id="newdoc-format" data-newdoc="format" data-knav-own="arrows enter escape"
              value={format} onChange={(e) => setFormat(e.target.value)}
              title="How the publish step will typeset it — carried as a publish: key in the new file's frontmatter, and changeable later from the toolbar"
              className="h-9 min-w-0 rounded-md border border-border bg-background px-2 text-[13.5px]">
              {SUPPLEMENT_FORMATS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
            </select>
          </div>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="newdoc-name" className="text-[12px] text-muted-foreground">File name</Label>
          <Input id="newdoc-name" data-newdoc="name" data-knav-own="arrows enter escape"
            value={name} aria-invalid={!!problem}
            onChange={(e) => { renamed.current = true; setName(e.target.value.toLowerCase()); }}
            placeholder="extended-abstract.md"
            className={`h-9 text-[13.5px] ${problem ? "border-destructive" : ""}`}
            title="The file created in writing/ — follows the title until you edit it" />
          {problem && <p data-newdoc="problem" className="text-[11.5px] text-destructive">{problem}</p>}
        </div>
        <div className="flex items-center justify-end gap-1 pt-0.5">
          <button type="button" onClick={() => onOpenChange(false)}
            className="text-[13px] text-muted-foreground hover:text-foreground px-3 py-1.5 transition-colors">Cancel</button>
          <button type="submit" disabled={!ready} data-newdoc="create"
            className="text-[13px] rounded-md px-3.5 py-1.5 bg-primary text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-40 disabled:pointer-events-none">
            Create
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
