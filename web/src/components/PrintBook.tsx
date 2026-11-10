
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BookMarked, X, Loader2, Search, Trash2, FileText, Quote, StickyNote } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import type { CiteFields, CitePreview, PrintBook as PrintBookData, PrintEntry, PrintBookResult } from "@/lib/api";

const blank = (): CiteFields => ({
  type: "book", authors: [], year: "", title: "", container: "", publisher: "",
  address: "", volume: "", issue: "", pages: "", doi: "", isbn: "", editor: "", edition: "", url: "",
});

// one host per view; any row opens it through openPrintBook (rows sit deep in lists)
type OpenDetail = { stem?: string | null; prefill?: Partial<CiteFields> };
const EVT = "all_in_one_academic:printbook";
export const openPrintBook = (d: OpenDetail = {}) => window.dispatchEvent(new CustomEvent<OpenDetail>(EVT, { detail: d }));

export function PrintBookHost({ onClosed }: { onClosed?: () => void }) {
  const [open, setOpen] = useState<OpenDetail | null>(null);
  useEffect(() => {
    const h = (e: Event) => setOpen((e as CustomEvent<OpenDetail>).detail || {});
    window.addEventListener(EVT, h);
    return () => window.removeEventListener(EVT, h);
  }, []);
  if (!open) return null;
  return <PrintBook stem={open.stem} prefill={open.prefill} onClose={() => { setOpen(null); onClosed?.(); }} />;
}

export function PrintBook({ stem: initial, prefill, onClose }: {
  stem?: string | null; prefill?: Partial<CiteFields>; onClose: () => void;
}) {
  const [stem, setStem] = useState<string | null>(initial || null);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // a field being typed in keeps its first Escape under keyboard mode; the next closes
      const a = document.activeElement as HTMLElement | null;
      if (a?.matches("input, textarea") && !a.hasAttribute("data-knav-armed")
        && document.documentElement.hasAttribute("data-knav")) return;
      e.preventDefault(); e.stopPropagation(); onClose();
    };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [onClose]);

  return createPortal(
    <div role="dialog" aria-modal="true" aria-label="Print book notes" data-knav-modal
      className="fixed inset-0 z-[130] animate-in fade-in duration-150">
      <div className="absolute inset-0 bg-black/50" onMouseDown={onClose} />
      <div className="absolute inset-3 md:inset-x-[max(1.5rem,calc(50%-34rem))] md:inset-y-6 bg-background border border-border rounded-xl shadow-2xl flex flex-col overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}>
        <div className="shrink-0 flex items-center gap-2.5 px-4 py-2.5 border-b border-border">
          <BookMarked size={15} className="text-primary shrink-0" />
          <span className="text-[13px] font-semibold truncate">{stem || "Add a print book"}</span>
          <span className="ml-auto" />
          {stem && (
            <button type="button" onClick={() => setStem(null)} title="Another print book"
              className="text-[12px] text-muted-foreground hover:text-foreground px-2">Switch book</button>
          )}
          <button type="button" onClick={onClose} data-knav-back aria-label="Close" title="Close"
            className="text-muted-foreground hover:text-foreground"><X size={16} /></button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto">
          {stem ? <NoteTaker stem={stem} /> : <AddBook prefill={prefill} onPick={setStem} />}
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ------------------------------------------------------------------ step 1
function AddBook({ prefill, onPick }: { prefill?: Partial<CiteFields>; onPick: (stem: string) => void }) {
  const [books, setBooks] = useState<string[] | null>(null);
  const [f, setF] = useState<CiteFields>(() => ({ ...blank(), ...prefill }));
  const [authors, setAuthors] = useState((prefill?.authors || []).join("; "));
  const [id, setId] = useState(prefill?.isbn || prefill?.doi || "");
  const [looking, setLooking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [prev, setPrev] = useState<CitePreview | null>(null);

  useEffect(() => { api.printbookList().then(setBooks).catch(() => setBooks([])); }, []);
  // opened from a reading with a DOI/ISBN: fill the fields straight away
  useEffect(() => { if (id && !f.authors.length) void lookup(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const fields = useCallback((): CiteFields => ({
    ...f, authors: authors.split(";").map((a) => a.trim()).filter(Boolean),
  }), [f, authors]);

  useEffect(() => {
    const cur = fields();
    if (!cur.title && !cur.authors.length) { setPrev(null); return; }
    const h = setTimeout(() => { api.readingInboxCitePreview(cur).then(setPrev).catch(() => {}); }, 300);
    return () => clearTimeout(h);
  }, [fields]);

  const lookup = async () => {
    const v = id.trim();
    if (!v || looking) return;
    setLooking(true); setErr(null);
    const isDoi = /^10\.\d{4,9}\//.test(v);
    const r = await api.printbookOp("lookup", isDoi ? { doi: v } : { isbn: v });
    setLooking(false);
    if (!r.ok || !r.fields) { setErr(r.error || "no record found"); return; }
    setF({ ...blank(), ...r.fields, type: "book" });
    setAuthors(r.fields.authors.join("; "));
    toast.success("Reference found", { description: r.from === "crossref" ? "CrossRef" : "Open Library" });
  };

  const create = async () => {
    if (busy) return;
    setBusy(true); setErr(null);
    const r = await api.printbookOp("create", { fields: fields() });
    setBusy(false);
    if (!r.ok || !r.stem) { setErr(r.error || "couldn't create the note"); return; }
    if (r.created) toast.success("Citation note created", {
      description: r.linked?.length ? `${r.linked.length} reading${r.linked.length > 1 ? "s" : ""} linked` : r.stem,
    });
    onPick(r.stem);
  };

  const set = (k: keyof CiteFields) => (e: React.ChangeEvent<HTMLInputElement>) => setF((x) => ({ ...x, [k]: e.target.value }));
  const ready = !!(f.title.trim() && f.year.trim() && authors.trim());

  return (
    <div className="max-w-3xl mx-auto p-5 grid gap-6">
      {books && books.length > 0 && (
        <section className="grid gap-1.5">
          <h2 className="text-[12px] uppercase tracking-[0.1em] font-semibold text-muted-foreground">Your print books</h2>
          {books.map((b) => (
            <button key={b} type="button" onClick={() => onPick(b)} data-knav-item=""
              className="text-left text-[14px] py-1.5 px-2 -mx-2 rounded-md hover:bg-secondary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/40">
              {b}
            </button>
          ))}
        </section>
      )}
      <section className="grid gap-3">
        <h2 className="text-[12px] uppercase tracking-[0.1em] font-semibold text-muted-foreground">New print book</h2>
        <div className="flex gap-2">
          <Input value={id} onChange={(e) => setId(e.target.value)} placeholder="ISBN or DOI"
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void lookup(); } }} />
          <Button variant="outline" onClick={lookup} disabled={!id.trim() || looking} title="Look up on CrossRef, then Open Library">
            {looking ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
            <span className="ml-1.5">Look up</span>
          </Button>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_7rem] gap-2">
          <Input value={authors} onChange={(e) => setAuthors(e.target.value)} placeholder="Authors: Surname, Given; Surname, Given" title="Authors, separated by ;" />
          <Input value={f.year} onChange={set("year")} placeholder="Year" />
        </div>
        <Input value={f.title} onChange={set("title")} placeholder="Title: Subtitle" />
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <Input value={f.publisher} onChange={set("publisher")} placeholder="Publisher" />
          <Input value={f.address} onChange={set("address")} placeholder="City" />
          <Input value={f.edition} onChange={set("edition")} placeholder="Edition" />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <Input value={f.isbn} onChange={set("isbn")} placeholder="ISBN" />
          <Input value={f.doi} onChange={set("doi")} placeholder="DOI" />
        </div>
        {prev?.citation && (
          <p className="text-[13px] text-muted-foreground border-l-2 border-border pl-3" title={prev.bibtex}>
            {prev.citation.replace(/\*/g, "")}
          </p>
        )}
        {err && <p className="text-[12.5px] text-destructive">{err}</p>}
        <div>
          <Button onClick={create} disabled={!ready || busy} title="Write the citation note and the library.bib entry">
            {busy ? <Loader2 size={14} className="animate-spin mr-1.5" /> : <BookMarked size={14} className="mr-1.5" />}
            Create note
          </Button>
        </div>
      </section>
    </div>
  );
}

// ------------------------------------------------------------------ step 2
function NoteTaker({ stem }: { stem: string }) {
  const [book, setBook] = useState<PrintBookData | null>(null);
  const [kind, setKind] = useState<"quote" | "note">("quote");
  const [page, setPage] = useState("");
  const [tags, setTags] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const pageRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => api.printbookGet(stem).then(setBook).catch(() => setBook(null)), [stem]);
  useEffect(() => { void load(); }, [load]);
  // page and tags stay between entries (a book is taken page by page); start on the page box
  useEffect(() => { pageRef.current?.focus(); }, [stem]);

  const save = async () => {
    if (busy || !text.trim() || !page.trim()) return;
    setBusy(true); setErr(null);
    const r: PrintBookResult = await api.printbookOp("add", { stem, kind, page, tags, text });
    setBusy(false);
    if (!r.ok) { setErr(r.error || "couldn't save"); return; }
    setText("");
    void load();
    textRef.current?.focus();
  };

  const remove = async (e: PrintEntry) => {
    const r = await api.printbookOp("delete", { stem, id: e.id });
    if (!r.ok) { toast.error(r.error || "couldn't delete"); return; }
    void load();
  };

  if (book && !book.ok) return <p className="p-5 text-[13px] text-destructive">{book.error}</p>;
  const entries = book?.entries || [];

  return (
    <div className="max-w-3xl mx-auto p-5 grid gap-5">
      {book?.citation && (
        <div className="flex items-start gap-3">
          <p className="flex-1 text-[13px] text-muted-foreground border-l-2 border-border pl-3">{book.citation.replace(/\*/g, "")}</p>
          <Button variant="outline" size="sm" onClick={() => api.open(book.path)} title="Open the citation note">
            <FileText size={14} className="mr-1.5" /> Note
          </Button>
        </div>
      )}

      <div className="grid gap-2 rounded-lg border border-border p-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-md border border-border p-0.5" role="radiogroup" aria-label="Entry kind">
            {([["quote", "Quote", Quote, "Verbatim from the page (Alt+Q)"], ["note", "My note", StickyNote, "Your own note on the page (Alt+N)"]] as const).map(([k, label, Icon, tip]) => (
              <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => setKind(k)} title={tip}
                className={`inline-flex items-center gap-1.5 text-[12px] px-2.5 py-1 rounded ${kind === k ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>
                <Icon size={13} /> {label}
              </button>
            ))}
          </div>
          <Input ref={pageRef} value={page} onChange={(e) => setPage(e.target.value)} placeholder="Page"
            title="Printed page: 47, 47-48 or xii" className="w-24 nums"
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); textRef.current?.focus(); } }} />
          <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="#tags" className="flex-1 min-w-[10rem]"
            title="Tags, space or comma separated" />
        </div>
        <textarea ref={textRef} value={text} onChange={(e) => setText(e.target.value)} rows={4}
          placeholder={kind === "quote" ? "Exact words from the page" : "Your note"}
          title="Ctrl+Enter saves"
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void save(); }
            if (e.altKey && (e.key === "q" || e.key === "n")) { e.preventDefault(); setKind(e.key === "q" ? "quote" : "note"); }
          }}
          className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-[14px] leading-relaxed focus:outline-none focus:ring-1 focus:ring-primary/40" />
        <div className="flex items-center gap-3">
          {err && <span className="text-[12.5px] text-destructive">{err}</span>}
          <Button className="ml-auto" size="sm" onClick={save} disabled={busy || !text.trim() || !page.trim()} title="Ctrl+Enter">
            {busy && <Loader2 size={14} className="animate-spin mr-1.5" />} Save
          </Button>
        </div>
      </div>

      <div className="grid">
        {!book && <span className="inline-flex items-center gap-2 text-[13px] text-muted-foreground"><Loader2 size={14} className="animate-spin" /></span>}
        {entries.map((e) => (
          <div key={e.id} className="group flex items-start gap-3 py-2.5 border-b border-border">
            <span className="w-12 shrink-0 text-[12px] text-muted-foreground nums pt-0.5">p. {e.page}</span>
            <span className="min-w-0 flex-1">
              <span className={`block text-[14px] leading-snug break-words ${e.kind === "quote" ? "" : "italic text-muted-foreground"}`}>
                {e.kind === "quote" ? `“${e.text}”` : e.text}
              </span>
              {e.tags.length > 0 && (
                <span className="flex flex-wrap gap-1.5 mt-1">
                  {e.tags.map((t) => <span key={t} className="text-[10px] text-muted-foreground bg-secondary px-1.5 py-0.5 rounded">#{t}</span>)}
                </span>
              )}
            </span>
            <button type="button" onClick={() => remove(e)} title="Delete" aria-label="Delete entry" data-knav-item=""
              className="shrink-0 text-muted-foreground/50 hover:text-destructive opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity">
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
