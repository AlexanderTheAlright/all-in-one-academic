import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { api, type DraftPubOptions, type DraftPublishSetup, type DraftPublish, type DraftVersion, type OverleafInfo } from "@/lib/api";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { X, FileOutput, ExternalLink, Download, RotateCcw, FileText, AlertTriangle, Loader2, Images, FileType2, History, MessageSquareText, ChevronRight, ChevronDown, RefreshCw, Copy } from "lucide-react";
import { copyPlain } from "@/lib/clipboard";
import { PublishComments } from "./PublishComments";
import { PublishPages } from "./PublishPages";
import { SERIF, typingEscape } from "./draftingShared";
import { PUB_JOURNALS } from "@/lib/draftStyle";

const CLS_LABEL: Record<string, string> = {
  "asa-manuscript": "ASA manuscript", sagej: "SAGE journal", proposal: "Proposal",
  thesis: "Thesis / dissertation", "long-report": "Long report", "prof-brief": "Professor brief",
  qualitative: "Qualitative", "book-draft": "Book draft", cv: "CV",
  "cover-letter": "Cover letter", "rec-letter": "Recommendation letter",
};
const clsLabel = (c?: string) => (c && CLS_LABEL[c]) || c || "—";

// the asa-manuscript option fields (template compared separately)
const sameOpts = (a?: DraftPubOptions | null, b?: DraftPubOptions | null) =>
  !!a && !!b && a.format === b.format && a.blind === b.blind && a.endnotes === b.endnotes && a.figures === b.figures;
const sameState = (a?: DraftPubOptions | null, b?: DraftPubOptions | null) =>
  sameOpts(a, b) && (a?.template || "") === (b?.template || "");

type Opt = { value: string; label: string };

const POLL_MS = 3000;
const POLL_MAX_MS = 15000;

// supplements travel with a paper but are not manuscripts: their options are never persisted
const SUPPLEMENT_DOC = /^(cover-letter|reviewer_response|appendix)\.md$/i;

// what a refused POST /drafting/publish carries beside `error` — the offending items of
// whichever gate refused it (serve.py: citation, numbers, quote, provenance gates)
type GateRefusal = {
  unresolved?: string[]; numbers?: string[]; quotes?: string[];
  external?: { doc: string; stem: string; reason: string; detail?: string }[]; hint?: string;
};
const gateLines = (r: GateRefusal): string[] => [
  ...(r.unresolved || []).map((k) => "ungrounded cite: " + k.replace("|", " ")),
  ...(r.numbers || []).map((n) => "number: " + (typeof n === "string" ? n : JSON.stringify(n))),
  ...(r.quotes || []).map((q) => "quote: " + (typeof q === "string" ? q : JSON.stringify(q))),
  ...(r.external || []).map((o) => `external stats: ${o.stem} (${o.reason})${o.detail ? " — " + o.detail : ""}`),
];

// the Publish choices as manuscript frontmatter — the contract drafting.py resolves
// (explicit options > frontmatter > wrapper)
const optKeys = (o: DraftPubOptions): Record<string, string> => ({
  journal: o.format, blind: o.blind ? "true" : "false", figures: o.figures, notes: o.endnotes ? "end" : "foot",
});

// a labelled dropdown field; the tip is a tooltip on the whole field, never a paragraph
function Field({ label, tip, value, onChange, options, disabled }: {
  label: string; tip?: string; value: string; onChange: (v: string) => void; options: Opt[]; disabled?: boolean;
}) {
  return (
    <div className="py-2" title={tip}>
      <div className="text-[12.5px] text-foreground">{label}</div>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger className="h-8 text-[12.5px] w-full mt-0.5"><SelectValue /></SelectTrigger>
        <SelectContent className="z-[140]">
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value} className="text-[12.5px]">{o.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export function DraftPublish({ slug, docName, title, flush, setDocKeys, onClose }: {
  slug: string; docName: string; title: string; flush: () => Promise<{ ok?: boolean } | void>;
  setDocKeys?: (kv: Record<string, string>) => void; onClose: () => void;
}) {
  const [setup, setSetup] = useState<DraftPublishSetup | null>(null);
  const [opts, setOpts] = useState<DraftPubOptions | null>(null);
  const [compiling, setCompiling] = useState(false);
  const [result, setResult] = useState<DraftPublish | null>(null);
  const [pdfTick, setPdfTick] = useState<number>(0);          // cache-bust the preview iframe
  const [preview, setPreview] = useState<"paper" | "figures">("paper");
  const [output, setOutput] = useState<"pdf" | "docx">("pdf");  // PDF (LaTeX) or Word (.docx)
  const [docxTick, setDocxTick] = useState<number>(0);          // a compiled .docx exists
  // comments on the FINAL TYPESET output — a Word doc gets rendered to a preview PDF
  // server-side so both outputs share the same paged comment view (see PublishComments)
  const [commentsOn, setCommentsOn] = useState(false);

  const [pv, setPv] = useState<{ output: "pdf" | "docx"; pages: number; mtime: number } | null>(null);
  const [busy, setBusy] = useState(true);                       // a publish-setup is in flight
  const [autoErr, setAutoErr] = useState("");                   // a failed auto-compile, no longer swallowed
  const [autoLog, setAutoLog] = useState("");
  const [logOpen, setLogOpen] = useState(false);
  const [srvBusy, setSrvBusy] = useState(false);                // the server says it is compiling
  const pvRef = useRef(pv);
  pvRef.current = pv;
  const inflight = useRef<"pdf" | "docx" | null>(null);         // single-flight publish-setup
  const queued = useRef<"pdf" | "docx" | null>(null);           // an output switched mid-compile
  const failedAt = useRef<{ out: "pdf" | "docx"; md: number | null; src: "ensure" | "status" } | null>(null);
  const seeded = useRef(false);                                 // options are seeded once, never re-seeded
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  // the Overleaf export zips (named + anonymized) and when each was built
  const [overleaf, setOverleaf] = useState<OverleafInfo | null>(null);
  const [overleafBusy, setOverleafBusy] = useState<"" | "named" | "anon" | "named-tex" | "anon-tex">("");
  const overleafRef = useRef(overleaf); overleafRef.current = overleaf;
  // the zips from the CURRENT draft: compile (gates report, never refuse) + package both
  const freshOverleaf = useCallback(async (): Promise<OverleafInfo> => {
    const c = await api.draftingPublish(slug, docName, null, "pdf");
    if (!c.ok) throw new Error("the compile failed: " + String((c as { error?: string }).error || "see Publish"));
    const r = await api.draftingOverleafBuild(slug, docName);
    if (!r.ok) throw new Error(r.error || "the export failed");
    if (alive.current) setOverleaf(r);
    return r;
  }, [slug, docName]);
  const copyForOverleaf = useCallback((anon: boolean) => {
    setOverleafBusy(anon ? "anon-tex" : "named-tex");
    const job = (async () => {
      const cur = overleafRef.current;
      const z = anon ? cur?.anon : cur?.named;
      if (!z || (cur?.paperMtime && cur.paperMtime > z.mtime)) await freshOverleaf();
      const t = await api.draftingOverleafTex(slug, docName, anon);
      if (!t.ok || !t.tex) throw new Error(t.error || "no LaTeX");
      return t.tex;
    })();
    const label = anon ? "Anonymous main.tex copied" : "main.tex copied";
    const viaItem = (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write)
      ? navigator.clipboard.write([new ClipboardItem({ "text/plain": job.then((t) => new Blob([t], { type: "text/plain" })) })])
      : Promise.reject(new Error("no ClipboardItem"));
    viaItem.then(() => toast.success(label, { description: "Paste over main.tex in Overleaf" }))
      .catch(async () => {
        try {
          const tex = await job;
          if (await copyPlain(tex)) toast.success(label, { description: "Paste over main.tex in Overleaf" });
          else toast(anon ? "Anonymous main.tex is ready" : "main.tex is ready", { duration: 30000, action: { label: "Copy", onClick: () => { void copyPlain(tex).then((ok) => ok ? toast.success(label) : toast.error("Clipboard blocked")); } } });
        } catch (e) { toast.error("Copy for Overleaf: " + (e instanceof Error ? e.message : "failed")); }
      })
      .finally(() => { if (alive.current) setOverleafBusy(""); });
  }, [slug, docName, freshOverleaf]);
  // a stale zip is rebuilt from the CURRENT draft: compile through /drafting/publish (its
  // citation and numbers gates apply), package both zips, then download the one clicked
  const buildOverleaf = useCallback(async (anon: boolean) => {
    setOverleafBusy(anon ? "anon" : "named");
    try {
      const r = await freshOverleaf();
      const z = anon ? r.anon : r.named;
      if (alive.current && z) {
        const a = document.createElement("a");
        a.href = api.draftingOverleafUrl(slug, docName, anon, z.mtime); a.download = z.name;
        document.body.appendChild(a); a.click(); a.remove();
      }
    } catch (e) { toast.error("Overleaf: " + (e instanceof Error ? e.message : "the export failed")); }
    finally { setOverleafBusy(""); }
  }, [slug, docName, freshOverleaf]);
  useEffect(() => {
    let off = false;
    api.draftingOverleafInfo(slug, docName).then((r) => { if (!off) setOverleaf(r); }).catch(() => {});
    return () => { off = true; };
  }, [slug, docName]);

  const [versions, setVersions] = useState<DraftVersion[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [selectedVid, setSelectedVid] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.draftingVersions(slug, docName).then((r) => { if (live) setVersions(r.versions || []); }).catch(() => {});
    return () => { live = false; };
  }, [slug, docName]);
  const versionsWithArtifacts = versions.filter((v) => v.artifacts && Object.keys(v.artifacts).length > 0);
  const viewing = selectedVid ? versions.find((v) => v.id === selectedVid) ?? null : null;

  // the panel's default state = exactly what the server resolved for this paper (its
  // frontmatter, else the build wrapper), seeded with the detected template
  const seed: DraftPubOptions | null = setup?.defaults
    ? { ...setup.defaults, template: setup.template }
    : setup?.template
      ? { format: "working", blind: false, endnotes: false, figures: "inline", template: setup.template }
      : null;

  // one blocking call: it compiles the requested output if it is missing or stale, renders
  // its pages, and answers with both. Single-flight — two of these would compile twice.
  const loadSetup = useCallback(async (out: "pdf" | "docx") => {
    if (inflight.current) {
      // never two compiles at once; a switch made mid-compile is honoured when it lands
      if (inflight.current !== out) queued.current = out;
      return;
    }
    inflight.current = out;
    setBusy(true);
    try {
      const s = await api.draftingPublishSetup(slug, docName, out);
      if (!alive.current) return;
      setSetup(s);
      if (!seeded.current) {
        if (s.defaults) { setOpts({ ...s.defaults, template: s.template }); seeded.current = true; }
        else if (s.template) { setOpts({ format: "working", blind: false, endnotes: false, figures: "inline", template: s.template }); seeded.current = true; }
      }
      if (s.pdfMtime) setPdfTick(s.pdfMtime);                 // an already-compiled PDF is on disk
      if (s.docxMtime) setDocxTick(s.docxMtime);              // a compiled .docx is on disk
      setAutoErr(s.autoCompileError || "");
      setAutoLog(s.autoCompileLog || "");
      failedAt.current = s.autoCompileError ? { out, md: s.mdMtime ?? null, src: "ensure" } : null;
      if (s.previewPages && s.previewPages > 0) {
        setPv({ output: s.output || out, pages: s.previewPages, mtime: s.previewMtime || 0 });
      } else if ((s.output || out) === out) {
        setPv(null);                                          // this build has no rendered pages
      }
    } catch {
      if (alive.current) setSetup((cur) => cur ?? { slug, doc: docName, error: "Couldn't load the publish setup." });
    } finally {
      inflight.current = null;
      if (alive.current) setBusy(false);
    }
  }, [slug, docName]);

  useEffect(() => { setLogOpen(false); }, [autoErr]);

  // open, and again whenever the output switches — the Word build gets its own pages
  useEffect(() => { void loadSetup(output); }, [loadSetup, output]);
  // a switch made while a compile was running runs as soon as that one lands
  useEffect(() => {
    if (busy || !queued.current) return;
    const q = queued.current;
    queued.current = null;
    void loadSetup(q);
  }, [busy, loadSetup]);

  useEffect(() => {
    if (viewing) return;
    let stop = false;
    let timer = 0;
    let delay = POLL_MS;
    const again = () => { if (!stop) timer = window.setTimeout(probe, delay); };
    const probe = async () => {
      if (stop) return;
      if (document.hidden || inflight.current) return again();
      try {
        const st = await api.draftingPreviewStatus(slug, docName, output);
        if (stop || !alive.current) return;
        delay = POLL_MS;
        if (st.ok === false) return again();               // e.g. an unknown slug
        setSrvBusy(!!st.compiling);
        const cur = pvRef.current;
        if (st.previewPages && st.previewPages > 0
          && (!cur || cur.output !== output || cur.mtime !== (st.previewMtime || 0) || cur.pages !== st.previewPages)) {
          setPv({ output, pages: st.previewPages, mtime: st.previewMtime || 0 });
        }
        // the status carries the last compile error for the CURRENT manuscript, so the
        // failure can be shown without paying for another compile to rediscover it
        const md = st.mdMtime ?? null;
        const was = failedAt.current;
        const mine = !!was && was.out === output && was.md === md;
        if (st.error) {
          setAutoErr(st.error);
          failedAt.current = mine ? was : { out: output, md, src: "status" };
        } else if (typeof st.error === "string") {         // present and empty = no failure
          // a compile the ENSURE watched fail stays failed until the manuscript moves
          if (!(mine && was!.src === "ensure")) { setAutoErr(""); if (was) failedAt.current = null; }
        }
        // a rebuild only when the manuscript has MOVED since the one that failed;
        // otherwise stale stays true forever and this is an every-3-s pdflatex loop.
        const f = failedAt.current;
        const doomed = !!f && f.out === output && f.md === md;
        if (st.stale && !st.compiling && !doomed) void loadSetup(output);
      } catch {
        if (stop) return;
        delay = Math.min(delay * 2, POLL_MAX_MS);
      }
      again();
    };
    timer = window.setTimeout(probe, POLL_MS);
    return () => { stop = true; window.clearTimeout(timer); };
  }, [slug, docName, output, viewing, loadSetup]);

  useEffect(() => {
    // stop typing first, then shut the versions menu, then leave Publish
    const h = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || typingEscape(e)) return;
      e.preventDefault(); e.stopPropagation();
      if (historyOpen) setHistoryOpen(false); else onClose();
    };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [onClose, historyOpen]);

  const detected = setup?.template;
  const tmplChanged = !!opts && !!detected && opts.template !== detected;
  const dirty = !sameState(opts, seed);
  // compile the literal set-up wrapper (proven, byte-identical path) only when nothing —
  // including the now-default blind — differs from it; otherwise a variant
  const literal = !!setup?.editable && sameOpts(opts, setup?.defaults) && !tmplChanged;

  // a manuscript's journal/blind/figures/notes choice is written into its frontmatter
  // (compile flushes it first). Grants, briefs, README/PLAN and supplements never are.
  const canPersist = !!setDocKeys && !!setup?.editable && !setup.grant && !setup.projectDoc && !SUPPLEMENT_DOC.test(docName);
  const persist = (o: DraftPubOptions) => { if (canPersist) setDocKeys!(optKeys(o)); };
  const set = <K extends keyof DraftPubOptions>(k: K, v: DraftPubOptions[K]) => {
    if (!opts) return;
    const next = { ...opts, [k]: v };
    setOpts(next);
    if (k !== "template") persist(next);
  };

  const compile = useCallback(async () => {
    if (output === "pdf" && tmplChanged) return;
    setCompiling(true);
    const tid = toast.loading(output === "docx" ? "Compiling the Word document…" : "Compiling the PDF…");
    try {
      const f = await flush();
      if (f && (f as { ok?: boolean }).ok === false) {
        toast.error("The draft changed on disk — reconcile the banner, then Publish again", { id: tid });
        setCompiling(false);
        onClose();
        return;
      }
      const r = output === "docx"
        ? await api.draftingPublish(slug, docName, opts, "docx")
        : await api.draftingPublish(slug, docName, literal ? null : opts, "pdf");
      setResult(r);
      if (r.ok) {
        setAutoErr("");
        failedAt.current = null;
        void loadSetup(output);     // re-render the pages from the build just produced
        if (output === "docx") {
          setDocxTick(r.mtime || Date.now());
          const extra = r.separate
            ? (r.figuresDocxRel ? " · figures & tables in a separate document" : ` · ${r.figuresError || "no separate figures"}`)
            : "";
          const tp = r.titlePageRel ? " · + title page" : "";
          toast.success(`Compiled to Word${r.tables != null ? ` · ${r.tables} tables, ${r.images} figures` : ""}${extra}${tp}`, { id: tid });
        } else {
          setPdfTick(r.mtime || Date.now());
          setPreview("paper");
          const extra = r.separate
            ? (r.figuresPdfRel ? ` · figures in a separate document (${r.figuresPages ?? "?"} pp)` : ` · ${r.figuresError || "no separate figures"}`)
            : (r.edited ? " · with your options" : "");
          toast.success(`Compiled${r.pages ? ` · ${r.pages} pages` : ""}${extra}`, { id: tid });
        }
      } else {
        const gate = gateLines(r as GateRefusal);
        toast.error(r.error || "Compile failed", { id: tid, description: (gate.length ? gate : (r.latexErrors || r.log || [])).slice(0, 3).join(" · ") || undefined });
      }
    } catch { toast.error(output === "docx" ? "Couldn't compile the Word document" : "Couldn't compile the PDF", { id: tid }); } finally { setCompiling(false); }
  }, [slug, docName, opts, literal, tmplChanged, flush, output, loadSetup]);

  // the last compile's LaTeX onto the clipboard, for a coauthor's Overleaf
  const copyLatex = useCallback(async (part: "body" | "full") => {
    try {
      const r = await api.draftingLatex(slug, docName, part);
      if (!r.ok || !r.latex) { toast.error(r.error || "Couldn't get the LaTeX"); return; }
      if (!(await copyPlain(r.latex))) { toast.error("Couldn't copy"); return; }
      const what = part === "full" ? "Full .tex copied" : "LaTeX body copied";
      if (r.stale) toast.warning(what + " — from the last compile; the draft changed since", { description: "Compile, then copy again for the current text" });
      else toast.success(what);
    } catch { toast.error("Couldn't get the LaTeX"); }
  }, [slug, docName]);

  const hasFigPdf = !!result?.ok && !!result.figuresPdfRel;
  const previewTick = preview === "figures" ? (result?.figuresMtime || pdfTick) : pdfTick;
  const viewingPdfKey = preview === "figures" ? "figuresPdf" : "pdf";
  const pdfUrl = viewing
    ? (viewing.artifacts?.[viewingPdfKey] ? api.draftingVersionArtifactUrl(slug, viewing.id, viewingPdfKey, docName) : "")
    : (pdfTick ? api.draftingPdfUrl(slug, docName, previewTick, preview) : "");
  const gateErr = result && !result.ok ? gateLines(result as GateRefusal) : [];
  const errLines = result && !result.ok ? (gateErr.length ? gateErr : (result.latexErrors || result.log || [])) : [];

  const shownPv = pv && pv.output === output ? pv : null;
  const pageSet = (output === "pdf" && preview === "figures")
    ? (result?.ok && result.figuresPages
      ? { count: result.figuresPages, which: "figures" as const, tick: result.figuresMtime || pdfTick }
      : null)
    : (shownPv
      ? { count: shownPv.pages, which: "paper" as const, tick: shownPv.mtime || (output === "docx" ? docxTick : pdfTick) }
      : null);

  const templates: Opt[] = (setup?.templates || []).map((t) => ({ value: t.cls, label: t.label }));

  const WordFile = ({ label, sub, which, versionKey }: { label: string; sub: string; which: "paper" | "figures" | "titlepage"; versionKey?: "docx" | "appendixDocx" | "titlepageDocx" }) => (
    <div className="rounded-lg border border-border bg-card px-3 py-2 flex items-center gap-2.5 min-w-[236px] flex-1">
      <FileType2 size={16} className="text-primary shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-foreground">{label}</div>
        <div className="text-[11px] text-muted-foreground/80 truncate">{sub}</div>
      </div>
      {!viewing && <button onClick={() => api.draftingOpenDocx(slug, docName, which).catch(() => { })} className="inline-flex items-center gap-1 text-[11.5px] text-muted-foreground hover:text-foreground"><ExternalLink size={12} /> Open</button>}
      <a href={viewing && versionKey ? api.draftingVersionArtifactUrl(slug, viewing.id, versionKey, docName) : api.draftingDocxUrl(slug, docName, docxTick || Date.now(), which)}
        download className="inline-flex items-center gap-1 text-[11.5px] text-muted-foreground hover:text-foreground"><Download size={12} /> Download</a>
    </div>
  );

  return createPortal(
    <div role="dialog" aria-modal="true" aria-label="Publish" data-knav-modal className="fixed inset-0 z-[120] bg-background flex flex-col animate-in fade-in duration-150">
      {/* header */}
      <div className="shrink-0 flex items-center gap-2 px-4 py-2 border-b border-border">
        <FileOutput size={15} className="text-primary" />
        <span className="text-[13px] font-medium">Publish</span>
        <span className="text-muted-foreground/40">·</span>
        <span className="text-[13px] text-muted-foreground truncate max-w-[40%]" style={{ fontFamily: SERIF }}>{title}</span>
        <span className="flex-1" />
        {((output === "pdf" && pdfTick > 0) || (output === "docx" && docxTick > 0) || !!pageSet) && !viewing && (
          <button onClick={() => setCommentsOn((o) => !o)} title="Comment directly on the rendered output — drag a region to flag it"
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] ${commentsOn ? "border-primary/50 text-foreground bg-primary/10" : "border-border text-muted-foreground hover:text-foreground hover:border-primary/50"}`}>
            <MessageSquareText size={12} /> Comments
          </button>
        )}
        {versionsWithArtifacts.length > 0 && (
          <div className="relative shrink-0">
            <button onClick={() => setHistoryOpen((o) => !o)} title="Flip between compiled artifacts from past saved versions"
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] ${viewing ? "border-primary/50 text-foreground" : "border-border text-muted-foreground hover:text-foreground hover:border-primary/50"}`}>
              <History size={12} /> {viewing ? (viewing.label || viewing.id) : "Current"}
            </button>
            {historyOpen && (
              <div className="absolute right-0 top-9 z-30 w-[260px] rounded-lg border border-border bg-card shadow-xl py-1.5" onMouseLeave={() => setHistoryOpen(false)}>
                <p className="px-3 pb-1 pt-0.5 text-[10px] uppercase tracking-wide text-muted-foreground/70">Compiled versions</p>
                <button onClick={() => { setSelectedVid(null); setHistoryOpen(false); }}
                  className={`flex items-center gap-2 w-full text-left px-3 py-1.5 text-[12.5px] hover:bg-accent ${!selectedVid ? "text-foreground font-medium" : "text-muted-foreground"}`}>
                  Current (live compile)
                </button>
                {versionsWithArtifacts.map((v) => (
                  <button key={v.id} onClick={() => { setSelectedVid(v.id); setHistoryOpen(false); }}
                    className={`flex items-center gap-2 w-full text-left px-3 py-1.5 text-[12.5px] hover:bg-accent ${selectedVid === v.id ? "text-foreground font-medium" : "text-muted-foreground"}`}>
                    <span className="flex-1 truncate">{v.label || v.id}</span>
                    <span className="text-[10.5px] text-muted-foreground/60 nums">{Object.keys(v.artifacts || {}).join(", ")}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <button type="button" onClick={onClose} data-knav-back="2" className="inline-flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground"><X size={15} /> Done</button>
      </div>
      {viewing && (
        <div className="shrink-0 flex items-center gap-2 px-4 py-1.5 border-b border-border bg-primary/5 text-[11.5px] text-foreground/85">
          <History size={12} className="text-primary" />
          Viewing the artifacts compiled at <b>{viewing.label || viewing.id}</b> — read-only.
          <button onClick={() => setSelectedVid(null)} className="ml-auto text-primary hover:underline">Back to current</button>
        </div>
      )}

      <div className="flex-1 min-h-0 flex">
        {/* options column */}
        <div className="w-[384px] shrink-0 border-r border-border overflow-y-auto px-5 py-4 flex flex-col gap-3">
          {!setup && <div className="text-[12.5px] text-muted-foreground flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> loading…</div>}

          {setup && setup.error && (
            <div className="rounded-lg border border-border bg-card px-3 py-3 text-[12.5px] text-muted-foreground flex items-start gap-2">
              <AlertTriangle size={14} className="text-amber-500 shrink-0 mt-0.5" /><span>{setup.error}</span>
            </div>
          )}

          {setup && setup.ready && opts && (
            <>
              {/* Output — PDF (the LaTeX pipeline) or Word (.docx, the build_docx sibling) */}
              <div>
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground/70 mb-1 flex items-center gap-1.5"><FileOutput size={11} /> Output</div>
                <div className="grid grid-cols-2 gap-1 rounded-lg border border-border bg-card p-1">
                  {([["pdf", "PDF", FileText], ["docx", "Word", FileType2]] as const).map(([v, label, Icon]) => (
                    <button key={v} onClick={() => setOutput(v)}
                      title={v === "docx" ? "Renders paper.md to .docx — Times New Roman, double-spaced, editable tables, figures as PNG" : undefined}
                      className={`inline-flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[12.5px] ${output === v ? "bg-primary/10 text-foreground font-medium" : "text-muted-foreground hover:text-foreground"}`}>
                      <Icon size={13} /> {label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Template picker — defaults to the class set up for this paper */}
              <div>
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground/70 mb-1 flex items-center gap-1.5"><FileText size={11} /> Template</div>
                <Select value={opts.template || detected || ""} onValueChange={(v) => set("template", v)}>
                  <SelectTrigger className="h-8 text-[12.5px] w-full"><SelectValue /></SelectTrigger>
                  <SelectContent className="z-[140]">
                    {templates.map((t) => (
                      <SelectItem key={t.value} value={t.value} className="text-[12.5px]">
                        {t.label}{t.value === detected ? "  ·  set up for this paper" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {(output === "pdf" && tmplChanged) ? (
                <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2.5 text-[11.5px] text-foreground/90 leading-snug flex items-start gap-2">
                  <AlertTriangle size={13} className="text-amber-500 shrink-0 mt-0.5" />
                  <span>This paper is set up as <b>{clsLabel(detected)}</b>. Switching to <b>{clsLabel(opts.template)}</b> needs its own build wrapper — run <code className="text-[11px]">the publish step</code> to set up the {clsLabel(opts.template)} template, then Publish recompiles it here.</span>
                </div>
              ) : setup.editable ? (
                <div className="rounded-lg border border-border bg-card px-3.5 divide-y divide-border/60">
                  <Field label="Journal style" tip="Sets the class style token and the Word reference document: working paper is single-spaced, journals double-spaced; SMH, JHSB and SPQ use their own class variant (SPQ always blind)."
                    value={opts.format} onChange={(v) => set("format", v as DraftPubOptions["format"])}
                    options={PUB_JOURNALS} />
                  <Field label="Figures & tables" tip="In place reads as a draft; collected at end or a separate document is the submission layout."
                    value={opts.figures} onChange={(v) => set("figures", v as DraftPubOptions["figures"])}
                    options={[{ value: "inline", label: "In place" }, { value: "atend", label: "Collected at end" }, { value: "separate", label: "Separate document" }]} />
                  {output === "pdf" && (
                    <Field label="Notes" tip="Footnotes at the page foot, or endnotes in a Notes section."
                      value={opts.endnotes ? "end" : "foot"} onChange={(v) => set("endnotes", v === "end")}
                      options={[{ value: "foot", label: "Footnotes" }, { value: "end", label: "Endnotes" }]} />
                  )}
                  <Field label="Anonymization" tip="Blind removes the author from the title page and adds the blind-review note."
                    value={opts.blind ? "blind" : "identified"} onChange={(v) => set("blind", v === "blind")}
                    options={[{ value: "blind", label: "Anonymized for blind review" }, { value: "identified", label: "Identified (author shown)" }]} />
                </div>
              ) : (
                <div className="rounded-lg border border-dashed border-border px-3 py-3 text-[11.5px] text-muted-foreground/90 leading-snug">
                  This template's options live in its build wrapper. Publish recompiles it as set up. To change the layout, run <code className="text-[11px]">the publish step</code>.
                </div>
              )}

              {dirty && !tmplChanged && (
                <button onClick={() => { if (seed) { setOpts(seed); persist(seed); } }}className="self-start inline-flex items-center gap-1.5 text-[11.5px] text-muted-foreground hover:text-foreground">
                  <RotateCcw size={12} /> Reset to the default
                </button>
              )}

              {/* compile + actions */}
              <div className="mt-1 flex flex-col gap-2">
                <button onClick={compile} disabled={compiling || !!viewing || (output === "pdf" && tmplChanged)}
                  className="inline-flex items-center justify-center gap-2 rounded-lg bg-primary/10 border border-primary/40 text-primary px-3 py-2 text-[13px] font-medium hover:bg-primary/15 disabled:opacity-50">
                  {compiling ? <Loader2 size={14} className="animate-spin" /> : output === "docx" ? <FileType2 size={14} /> : <FileOutput size={14} />}
                  {compiling ? "Compiling…" : output === "docx" ? "Compile to Word" : tmplChanged ? "Set up this template with the publish step" : literal ? "Compile" : "Compile with these options"}
                </button>
                {output === "pdf" && pdfTick > 0 && (
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-muted-foreground">
                    <button onClick={() => api.draftingOpenPdf(slug, docName, preview).catch(() => {})} className="inline-flex items-center gap-1 hover:text-foreground"><ExternalLink size={12} /> Open in viewer</button>
                    <a href={pdfUrl} download className="inline-flex items-center gap-1 hover:text-foreground"><Download size={12} /> Download</a>
                    {!viewing && preview !== "figures" && (
                      <button onClick={(e) => void copyLatex(e.shiftKey ? "full" : "body")}
                        title={"Copy the LaTeX body (after \\maketitle, tables inlined) to paste into Overleaf\nShift-click: the full standalone .tex"}
                        className="inline-flex items-center gap-1 hover:text-foreground"><Copy size={12} /> Copy LaTeX</button>
                    )}
                    {(() => {
                      // page length in BOTH spacings when known (compile result, or the
                      // cached counts publish-setup returns on open) — no extra button
                      if (preview !== "figures") {
                        const both = (result?.ok && result.pagesBoth) || setup?.pagesBoth;
                        if (both?.double && both?.single)
                          return <span className="text-muted-foreground/60 nums">{both.double} pp double-spaced · {both.single} pp single</span>;
                      }
                      const n = result?.ok ? (preview === "figures" ? result.figuresPages : result.pages) : null;
                      return n ? <span className="text-muted-foreground/60 nums">{n} pp</span> : null;
                    })()}
                  </div>
                )}
                {output === "pdf" && !viewing && overleaf?.ok && (() => {
                  const stamp = (z: { mtime: number }) => new Date(z.mtime).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
                  const fresh = (z?: { mtime: number } | null) => !!z && !(overleaf.paperMtime && overleaf.paperMtime > z.mtime);
                  const Zip = ({ anon }: { anon: boolean }) => {
                    const z = anon ? overleaf.anon : overleaf.named;
                    return (
                      <a href={z ? api.draftingOverleafUrl(slug, docName, anon, z.mtime) : "#"} download={z?.name} data-overleaf-zip={anon ? "anon" : "named"}
                        onClick={(e) => { if (!fresh(z)) { e.preventDefault(); void buildOverleaf(anon); } }}
                        title={z ? z.name + " · built " + stamp(z) + (fresh(z) ? "" : " · the draft changed since: a click rebuilds it first") : "Build from the current draft"}
                        className={`inline-flex items-center gap-1 hover:text-foreground ${overleafBusy ? "pointer-events-none opacity-60" : ""}`}>
                        {overleafBusy === (anon ? "anon" : "named") ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />} {anon ? "Overleaf zip (anonymous)" : "Overleaf zip (named)"}
                        {z && <span className={`nums ${fresh(z) ? "text-muted-foreground/60" : "text-amber-600/90"}`}>{stamp(z)}</span>}</a>
                    );
                  };
                  return (
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-muted-foreground">
                      <Zip anon={false} />
                      <Zip anon />
                      {(["named", "anon"] as const).map((k) => (
                        <button key={k} type="button" data-overleaf-copy={k} disabled={!!overleafBusy} onClick={() => copyForOverleaf(k === "anon")}
                          className="inline-flex items-center gap-1 hover:text-foreground disabled:opacity-60">
                          {overleafBusy === k + "-tex" ? <Loader2 size={12} className="animate-spin" /> : <Copy size={12} />} {k === "anon" ? "Copy for Overleaf (anonymous)" : "Copy for Overleaf (named)"}</button>
                      ))}
                    </div>
                  );
                })()}
                {result?.ok && (() => {
                  const gw = ((result as { gateWarnings?: GateRefusal[] }).gateWarnings || []).flatMap(gateLines);
                  return gw.length > 0 && (
                    <div data-publish-warnings className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-[11.5px] text-amber-700 dark:text-amber-400">
                      <div className="font-medium flex items-center gap-1.5"><AlertTriangle size={12} /> {gw.length} {gw.length === 1 ? "issue" : "issues"} to settle before submission</div>
                      <ul className="mt-0.5 list-disc pl-5">{gw.slice(0, 20).map((l, i) => <li key={i} className="break-words">{l}</li>)}</ul>
                    </div>
                  );
                })()}
                {output === "pdf" && result?.ok && result.texSaved && result.texSaved.length > 0 && (
                  <div className="text-[11px] text-muted-foreground/70" title={result.texSaved.join("\n")}>Saved LaTeX source to <code className="text-[10.5px]">writing/tex/</code></div>
                )}
                {result?.ok && result.separate && result.figuresError && (
                  <div className="text-[11px] text-amber-600/90">Figures & tables: {result.figuresError}.</div>
                )}
              </div>

              {/* compile errors */}
              {result && !result.ok && (
                <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2.5 text-[11.5px] text-destructive">
                  <div className="font-medium flex items-center gap-1.5 mb-1" title={(result as GateRefusal).hint}><AlertTriangle size={13} /> {result.error || "Compile failed"}</div>
                  {errLines.length > 0 && <pre className="whitespace-pre-wrap text-[10.5px] text-destructive/80 max-h-40 overflow-y-auto">{errLines.slice(0, 12).join("\n")}</pre>}
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex-1 min-h-0 bg-muted/30 flex flex-col">
          {commentsOn && !viewing ? (
            <PublishComments slug={slug} docName={docName} target={output} tick={output === "docx" ? docxTick : pdfTick} />
          ) : (<>
            {output === "pdf" && hasFigPdf && (
              <div className="shrink-0 flex items-center gap-1 px-3 py-1.5 border-b border-border bg-background/60">
                <button onClick={() => setPreview("paper")}
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11.5px] ${preview === "paper" ? "bg-primary/10 text-foreground font-medium" : "text-muted-foreground hover:text-foreground"}`}>
                  <FileText size={12} /> Manuscript
                </button>
                <button onClick={() => setPreview("figures")}
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11.5px] ${preview === "figures" ? "bg-primary/10 text-foreground font-medium" : "text-muted-foreground hover:text-foreground"}`}>
                  <Images size={12} /> Figures &amp; tables
                </button>
              </div>
            )}

            {output === "docx" && (viewing || docxTick > 0 || result?.ok) && (
              <div className="shrink-0 flex items-stretch gap-2 px-3 py-2 border-b border-border bg-background/60 overflow-x-auto tinybar">
                {viewing ? (<>
                  {viewing.artifacts?.docx && <WordFile label="Manuscript" which="paper" versionKey="docx" sub={viewing.label || viewing.id} />}
                  {viewing.artifacts?.appendixDocx && <WordFile label="Appendix" which="paper" versionKey="appendixDocx" sub={viewing.label || viewing.id} />}
                  {viewing.artifacts?.titlepageDocx && <WordFile label="Title page" which="titlepage" versionKey="titlepageDocx" sub={viewing.label || viewing.id} />}
                  {!viewing.artifacts?.docx && !viewing.artifacts?.appendixDocx && (
                    <div className="text-[12px] text-muted-foreground/80 px-1 py-2">No Word document was compiled at this checkpoint.</div>
                  )}
                </>) : (<>
                  <WordFile label="Manuscript" which="paper"
                    sub={result?.ok ? `${result.tables ?? "?"} tables · ${result.images ?? "?"} figures` : "compiled .docx"} />
                  {result?.ok && result.figuresDocxRel && (
                    <WordFile label="Figures & tables" which="figures"
                      sub={`${result.figuresTables ?? "?"} tables · ${result.figuresImages ?? "?"} figures`} />
                  )}
                  {result?.ok && result.titlePageRel && (
                    <WordFile label="Title page" which="titlepage" sub="title · authors · abstract" />
                  )}
                </>)}
              </div>
            )}
            {output === "docx" && !viewing && result?.ok && (result.figuresError || (result.warnings && result.warnings.length > 0)) && (
              <div className="shrink-0 px-3.5 py-1 text-[11px] text-amber-600/90 border-b border-border/60"
                title={(result.warnings || []).join("\n")}>
                {result.figuresError ? `Figures & tables: ${result.figuresError}.` : `${result.warnings!.length} build warning${result.warnings!.length > 1 ? "s" : ""}`}
              </div>
            )}

            {!viewing && autoErr && pageSet && (
              <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-border bg-destructive/5">
                <button type="button" onClick={() => setLogOpen((o) => !o)} title={autoErr}
                  className="inline-flex items-center gap-1.5 rounded-full border border-destructive/40 px-2.5 py-1 text-[11.5px] text-destructive hover:bg-destructive/10">
                  <AlertTriangle size={12} /> Compile failed
                  {autoLog ? (logOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />) : null}
                </button>
                <span className="flex-1" />
                <button type="button" onClick={() => void loadSetup(output)} disabled={busy || srvBusy}
                  title="Compile this output again and re-render its pages"
                  className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-[11.5px] text-muted-foreground hover:text-foreground disabled:opacity-50">
                  {busy || srvBusy ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} Retry
                </button>
              </div>
            )}
            {!viewing && autoErr && pageSet && logOpen && (
              <pre className="shrink-0 max-h-56 overflow-y-auto tinybar whitespace-pre-wrap border-b border-border bg-card px-3 py-2 font-mono text-[10.5px] leading-snug text-muted-foreground">{autoLog || autoErr}</pre>
            )}

            {/* a snapshotted checkpoint has no live render — its PDF still opens inline */}
            {viewing ? (
              output === "pdf" && pdfUrl ? (
                <div className="flex-1 min-h-0">
                  <iframe key={pdfUrl} src={pdfUrl + "#toolbar=1&navpanes=0&view=FitH"} title="PDF preview" className="w-full h-full border-0" />
                </div>
              ) : output === "pdf" ? (
                <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-2 text-muted-foreground">
                  <FileOutput size={28} className="opacity-40" />
                  <div className="text-[13px]">No PDF at this checkpoint</div>
                </div>
              ) : <div className="flex-1 min-h-0" />
            ) : autoErr && !pageSet ? (
              <div className="flex-1 min-h-0 overflow-y-auto tinybar p-6 flex justify-center">
                <div className="w-full max-w-xl self-start rounded-lg border border-destructive/40 bg-destructive/5 px-3.5 py-3">
                  <div className="flex items-center gap-2">
                    <AlertTriangle size={14} className="text-destructive shrink-0" />
                    <span className="text-[13px] font-medium text-destructive">Compile failed</span>
                    <span className="flex-1" />
                    <button type="button" onClick={() => void loadSetup(output)} disabled={busy || srvBusy}
                      title="Compile this output again and re-render its pages"
                      className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-[11.5px] text-muted-foreground hover:text-foreground disabled:opacity-50">
                      {busy || srvBusy ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} Retry
                    </button>
                  </div>
                  <div className="mt-1.5 text-[11.5px] text-destructive/90">{autoErr}</div>
                  {autoLog && (<>
                    <button type="button" onClick={() => setLogOpen((o) => !o)} title="The compiler's own output"
                      className="mt-2 inline-flex items-center gap-1 text-[11.5px] text-muted-foreground hover:text-foreground">
                      {logOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />} Log
                    </button>
                    {logOpen && (
                      <pre className="mt-1.5 max-h-72 overflow-y-auto tinybar whitespace-pre-wrap rounded-md border border-border bg-card px-2.5 py-2 font-mono text-[10.5px] leading-snug text-muted-foreground">{autoLog}</pre>
                    )}
                  </>)}
                </div>
              </div>
            ) : pageSet ? (
              <PublishPages slug={slug} docName={docName} target={output} which={pageSet.which}
                count={pageSet.count} tick={pageSet.tick} dim={busy || srvBusy} />
            ) : busy || srvBusy ? (
              <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-2 text-muted-foreground">
                <Loader2 size={22} className="animate-spin opacity-70" />
                <div className="text-[12.5px]">Compiling</div>
              </div>
            ) : output === "pdf" && pdfUrl ? (
              <div className="flex-1 min-h-0">
                <iframe key={pdfUrl} src={pdfUrl + "#toolbar=1&navpanes=0&view=FitH"} title="PDF preview" className="w-full h-full border-0" />
              </div>
            ) : (
              <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-2 text-muted-foreground">
                {output === "docx" ? <FileType2 size={28} className="opacity-40" /> : <FileOutput size={28} className="opacity-40" />}
                <div className="text-[13px]">Not compiled yet</div>
              </div>
            )}
          </>)}
        </div>
      </div>
    </div>,
    document.body,
  );
}
