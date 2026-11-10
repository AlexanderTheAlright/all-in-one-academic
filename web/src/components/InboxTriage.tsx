
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Inbox, X, Check, Archive, ChevronLeft, ChevronRight, AlertTriangle, FileText, Link2, Loader2, SkipForward, BookOpen, BookMarked, Sparkles, ChevronDown } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { InboxDetail, InboxStemCheck, CiteFields, CiteCandidate, CiteSuggest, CitePreview } from "@/lib/api";

const emptyCite = (): CiteFields => ({
  type: "book", authors: [], year: "", title: "", container: "", publisher: "",
  address: "", volume: "", issue: "", pages: "", doi: "", isbn: "", editor: "", edition: "", url: "",
});
const CITE_TYPES: [string, string][] = [
  ["book", "Book"], ["article", "Journal article"], ["chapter", "Book chapter"],
  ["report", "Report"], ["thesis", "Thesis"], ["web", "Web / grey lit"], ["dataset", "Dataset"],
];

const BAD = /[\\/:*?"<>|#[\]]/g;
// corpus stems can't hold NTFS-illegal chars; a subtitle colon becomes " - "
const clean = (s: string) => s.replace(/:\s*/g, " - ").replace(BAD, " ").replace(/\s{2,}/g, " ");
const fmtSize = (b: number) => (b >= 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.round(b / 1024) + " KB");

type Outcome = { kind: "filed" | "archived" | "skipped"; stem?: string; needsNote?: boolean };

export function InboxTriage({ onClose }: { onClose: () => void }) {
  const [names, setNames] = useState<string[] | null>(null);
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  const [pos, setPos] = useState(0);
  const [details, setDetails] = useState<Record<string, InboxDetail>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [armArchive, setArmArchive] = useState(false);

  const [author, setAuthor] = useState("");
  const [year, setYear] = useState("");
  const [title, setTitle] = useState("");
  const [linkSel, setLinkSel] = useState<number | null>(null);
  const [check, setCheck] = useState<{ stem: string; res: InboxStemCheck } | null>(null);

  // citation & BibTeX capture (optional, collapsed by default to keep filing fast)
  const [citeOpen, setCiteOpen] = useState(false);
  const [cf, setCf] = useState<CiteFields>(emptyCite());
  const [sug, setSug] = useState<CiteSuggest | null>(null);
  const [sugLoading, setSugLoading] = useState(false);
  const [bibPrev, setBibPrev] = useState<CitePreview | null>(null);
  const citeTouched = useRef(false);

  useEffect(() => {
    api.readingInbox().then((d) => setNames(d.items.map((x) => x.name))).catch(() => setNames([]));
  }, []);

  const queue = useMemo(() => (names || []).filter((n) => !outcomes[n]), [names, outcomes]);
  const current = queue.length ? queue[Math.min(pos, queue.length - 1)] : null;
  const det = current ? details[current] : undefined;

  // fetch the current file's detail (and prefetch the next) once per name
  const fetching = useRef<Set<string>>(new Set());
  useEffect(() => {
    const want = [current, queue[Math.min(pos, queue.length - 1) + 1]].filter(Boolean) as string[];
    for (const n of want) {
      if (details[n] || fetching.current.has(n)) continue;
      fetching.current.add(n);
      api.readingInboxDetail(n)
        .then((d) => setDetails((m) => ({ ...m, [n]: d })))
        .catch(() => fetching.current.delete(n));
    }
  }, [current, pos, queue, details]);

  // seed the rename form from the suggestion whenever the item under triage changes
  useEffect(() => {
    setErr(null); setArmArchive(false); setLinkSel(null); setCheck(null);
    setCiteOpen(false); setSug(null); setBibPrev(null); setCf(emptyCite()); citeTouched.current = false;
    if (det?.suggestion) {
      setAuthor(det.suggestion.author || "");
      setYear(det.suggestion.year || "");
      setTitle(det.suggestion.title || "");
      if (det.queueMatches.length && det.queueMatches[0].score >= 0.7) setLinkSel(0);
    } else {
      setAuthor(""); setYear(""); setTitle("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, det?.name]);

  // when the citation section is first opened, query CrossRef/OpenLibrary/OpenAlex
  // and seed the form from the merged prefill (unless the user already edited it)
  useEffect(() => {
    if (!citeOpen || !current || sug) return;
    setSugLoading(true);
    api.readingInboxCiteSuggest(current)
      .then((s) => { setSug(s); if (!citeTouched.current && s.prefill) setCf({ ...emptyCite(), ...s.prefill }); })
      .catch(() => setSug({ candidates: [], detected: { doi: "", isbn: "" }, prefill: emptyCite(), name: current }))
      .finally(() => setSugLoading(false));
  }, [citeOpen, current, sug]);

  // debounced live BibTeX + ASA citation preview as the fields change
  useEffect(() => {
    if (!citeOpen || !(cf.title.trim() || cf.authors.length)) { setBibPrev(null); return; }
    const h = setTimeout(() => api.readingInboxCitePreview(cf).then(setBibPrev).catch(() => {}), 400);
    return () => clearTimeout(h);
  }, [cf, citeOpen]);

  const setField = (patch: Partial<CiteFields>) => { citeTouched.current = true; setCf((f) => ({ ...f, ...patch })); };
  const citeEngaged = citeOpen && !!(cf.title.trim() || cf.authors.length);

  const stem = useMemo(() => {
    const a = clean(author).trim(), y = year.trim(), t = clean(title).trim();
    return a && y && t ? `${a} (${y}) - ${t}` : "";
  }, [author, year, title]);

  // debounced server-side stem check: convention + illegal chars + Corpus collision
  useEffect(() => {
    if (!stem) { setCheck(null); return; }
    const h = setTimeout(() => {
      api.readingInboxCheckStem(stem).then((res) => setCheck({ stem, res })).catch(() => {});
    }, 350);
    return () => clearTimeout(h);
  }, [stem]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // while the arrow keys drive, a field being typed in keeps its first Escape
      // (the engine stops the edit and leaves focus on the field); the next one closes
      const a = document.activeElement as HTMLElement | null;
      if (a?.matches("input, textarea") && !a.hasAttribute("data-knav-armed")
        && document.documentElement.hasAttribute("data-knav")) return;
      e.preventDefault(); e.stopPropagation(); onClose();
    };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [onClose]);

  const stemValid = !!stem && check?.stem === stem && check.res.valid;
  const canFile = !!current && !!det && det.verdict !== "GARBAGE" && stemValid && !busy;

  const tally = useMemo(() => {
    const t = { filed: 0, archived: 0, skipped: 0 };
    for (const o of Object.values(outcomes)) t[o.kind] += 1;
    return t;
  }, [outcomes]);

  const doFile = async () => {
    if (!current || !canFile) return;
    setBusy(true); setErr(null);
    const m = linkSel != null && det ? det.queueMatches[linkSel] : null;
    const res = await api.readingInboxAct({
      action: "file", name: current, stem,
      link: m ? { list: m.list, group: m.group, item: m.item, title: m.title, where: m.where, file: m.file } : null,
      citation: citeEngaged ? cf : null,
    });
    setBusy(false);
    if (res.error) { setErr(res.error); return; }
    const extras = [
      res.repointed?.length ? `${res.repointed.length} reading link${res.repointed.length > 1 ? "s" : ""} repointed` : "",
      res.cite?.cited ? `BibTeX @${res.cite.citekey}` : "",
    ].filter(Boolean);
    toast.success("Filed to Corpus", { description: res.filed + (extras.length ? ` · ${extras.join(" · ")}` : "") });
    setOutcomes((o) => ({ ...o, [current]: { kind: "filed", stem, needsNote: res.needsNote } }));
  };

  const doArchive = async () => {
    if (!current || busy) return;
    if (!armArchive) { setArmArchive(true); return; }
    setBusy(true); setErr(null);
    const reason = det?.verdict === "GARBAGE" ? det.reason : det?.dupInCorpus ? "duplicate of a Corpus file" : "triage: not wanted";
    const res = await api.readingInboxAct({ action: "archive", name: current, reason });
    setBusy(false); setArmArchive(false);
    if (res.error) { setErr(res.error); return; }
    toast("Archived", { description: res.archived });
    setOutcomes((o) => ({ ...o, [current]: { kind: "archived" } }));
  };

  const doSkip = () => { if (current) setOutcomes((o) => ({ ...o, [current]: { kind: "skipped" } })); };

  const filedStems = (names || []).map((n) => outcomes[n]).filter((o): o is Outcome => !!o && o.kind === "filed" && !!o.stem);
  const total = names?.length ?? 0;
  const handled = total - queue.length;

  return createPortal(
    <div role="dialog" aria-modal="true" aria-label="File the Reading Inbox" data-knav-modal
      className="fixed inset-0 z-[130] animate-in fade-in duration-150">
      <div className="absolute inset-0 bg-black/50" onMouseDown={onClose} />
      <div className="absolute inset-3 md:inset-6 bg-background border border-border rounded-xl shadow-2xl flex flex-col overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}>
        <div className="shrink-0 flex items-center gap-2.5 px-4 py-2.5 border-b border-border">
          <Inbox size={15} className="text-primary shrink-0" />
          <span className="text-[13px] font-semibold">File the Reading Inbox</span>
          {total > 0 && (
            <span className="text-[11.5px] text-muted-foreground nums">
              {handled}/{total} handled
              {tally.filed > 0 && <span> · {tally.filed} filed</span>}
              {tally.archived > 0 && <span> · {tally.archived} archived</span>}
              {tally.skipped > 0 && <span> · {tally.skipped} skipped</span>}
            </span>
          )}
          {queue.length > 1 && (
            <span className="ml-auto flex items-center gap-0.5">
              <button type="button" onClick={() => setPos((p) => Math.max(0, Math.min(p, queue.length - 1) - 1))}
                className="text-muted-foreground hover:text-foreground p-1" title="Previous" aria-label="Previous PDF"><ChevronLeft size={15} /></button>
              <span className="text-[11px] text-muted-foreground nums">{Math.min(pos, queue.length - 1) + 1} of {queue.length} left</span>
              <button type="button" onClick={() => setPos((p) => Math.min(queue.length - 1, Math.min(p, queue.length - 1) + 1))}
                className="text-muted-foreground hover:text-foreground p-1" title="Next" aria-label="Next PDF"><ChevronRight size={15} /></button>
            </span>
          )}
          <button type="button" onClick={onClose} data-knav-back aria-label="Close" title="Close"
            className={`text-muted-foreground hover:text-foreground ${queue.length > 1 ? "" : "ml-auto"}`}><X size={16} /></button>
        </div>

        {names === null && (
          <div className="flex-1 grid place-items-center text-[13px] text-muted-foreground">
            <span className="inline-flex items-center gap-2"><Loader2 size={15} className="animate-spin" /> Reading the Inbox…</span>
          </div>
        )}

        {names !== null && total === 0 && (
          <div className="flex-1 grid place-items-center">
            <div className="text-center space-y-2">
              <Check size={22} className="mx-auto text-primary" />
              <p className="text-[14px] font-medium">Inbox clear</p>
              <p className="text-[12.5px] text-muted-foreground">Nothing to file — new downloads land here.</p>
            </div>
          </div>
        )}

        {names !== null && total > 0 && !current && (
          <div className="flex-1 overflow-y-auto p-6">
            <div className="max-w-lg mx-auto space-y-4">
              <div className="text-center space-y-1.5">
                <Check size={22} className="mx-auto text-primary" />
                <p className="text-[15px] font-medium">Inbox handled</p>
                <p className="text-[12.5px] text-muted-foreground nums">
                  {tally.filed} filed to Corpus · {tally.archived} archived · {tally.skipped} skipped
                </p>
              </div>
              {filedStems.length > 0 && (
                <div className="border border-border rounded-lg p-3.5 space-y-2">
                  <p className="text-[12px] font-medium">Filed this session</p>
                  <ul className="space-y-1">
                    {filedStems.map((o) => (
                      <li key={o.stem} className="text-[12px] text-muted-foreground flex items-start gap-1.5">
                        <FileText size={12} className="shrink-0 mt-0.5" />
                        <span className="min-w-0 break-words">{o.stem}{o.needsNote === false && <span className="text-primary"> · note exists</span>}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="text-center"><Button onClick={onClose}>Done</Button></div>
            </div>
          </div>
        )}

        {current && (
          <div className="flex-1 min-h-0 flex">
            <div className="flex-1 min-w-0 bg-neutral-800/40">
              {det ? (
                <iframe key={current} src={api.readingInboxPdfUrl(current) + "#zoom=page-width"}
                  title={current} className="w-full h-full border-0" />
              ) : (
                <div className="h-full grid place-items-center text-[12.5px] text-muted-foreground">
                  <span className="inline-flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Opening…</span>
                </div>
              )}
            </div>

            <div className="w-[min(400px,60%)] shrink-0 border-l border-border overflow-y-auto tinybar">
              <div className="p-4 space-y-3.5">
                <div>
                  <p className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground font-semibold mb-1">In the Inbox as</p>
                  <p className="text-[12px] font-mono break-all leading-snug">{current}</p>
                  {det && (
                    <p className="text-[11.5px] text-muted-foreground nums mt-1">
                      {fmtSize(det.size)}{det.pages ? ` · ${det.pages} pages` : ""}
                    </p>
                  )}
                </div>

                {det?.verdict === "GARBAGE" && (
                  <Banner tone="red" text={`Fails the corpus gate — ${det.reason}. Archive it; if the paper matters, re-queue the download.`} />
                )}
                {det?.verdict === "SUSPECT" && (
                  <Banner tone="amber" text={`${det.reason}. If the preview shows the right paper, filing is fine.`} />
                )}
                {det?.dupInCorpus && (
                  <Banner tone="amber" text="A Corpus PDF with this exact name already exists — this copy is a duplicate. Archive it." />
                )}
                {det && det.linkedItems.length > 0 && (
                  <p className="text-[11.5px] text-muted-foreground leading-snug flex items-start gap-1.5">
                    <Link2 size={12} className="shrink-0 mt-0.5" />
                    <span>Linked from {det.linkedItems.map((l) => `“${l.title}”`).join(", ")} — the link follows the rename into Corpus.</span>
                  </p>
                )}

                {det && det.verdict !== "GARBAGE" && (
                  <>
                    <div className="space-y-2">
                      <p className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground font-semibold">Name it · Author (Year) - Title</p>
                      <div className="flex gap-2">
                        <Input value={author} onChange={(e) => setAuthor(e.target.value)} placeholder="Author — 2: X and Y · 3+: X et al." className="h-8 text-[12.5px]" />
                        <Input value={year} onChange={(e) => setYear(e.target.value)} placeholder="Year" className="h-8 text-[12.5px] w-[74px] shrink-0" />
                      </div>
                      <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title (published title; subtitle colon becomes “ - ”)"
                        className="h-8 text-[12.5px]" onKeyDown={(e) => { if (e.key === "Enter" && canFile) doFile(); }} />
                      {(det.meta.title || det.meta.author) && (
                        <div className="flex flex-wrap gap-1.5">
                          {det.meta.title && (
                            <button onClick={() => setTitle(clean(det.meta.title).trim())}
                              className="text-[10.5px] px-1.5 py-0.5 rounded bg-secondary text-muted-foreground hover:text-foreground max-w-full truncate"
                              title={`PDF metadata title: ${det.meta.title}`}>meta title: {det.meta.title}</button>
                          )}
                          {det.meta.author && (
                            <button onClick={() => setAuthor(clean(det.meta.author).trim())}
                              className="text-[10.5px] px-1.5 py-0.5 rounded bg-secondary text-muted-foreground hover:text-foreground max-w-full truncate"
                              title={`PDF metadata author: ${det.meta.author}`}>meta author: {det.meta.author}</button>
                          )}
                        </div>
                      )}
                      <div className={`text-[11.5px] leading-snug rounded-md border px-2.5 py-1.5 break-words ${
                        !stem ? "border-border text-muted-foreground"
                        : stemValid ? "border-primary/40 text-foreground"
                        : "border-amber-500/50 text-amber-600 dark:text-amber-400"}`}>
                        {stem ? (
                          <>
                            <span className="font-mono">{stem}.pdf</span>
                            {check?.stem === stem && !check.res.valid && <span className="block mt-0.5">{check.res.problem}</span>}
                            {stemValid && check?.res.noteExists && <span className="block mt-0.5 text-primary">A citation note with this name already exists — it will link up.</span>}
                          </>
                        ) : "Fill author, year, and title to compose the corpus name."}
                      </div>
                    </div>

                    {det.queueMatches.length > 0 && (
                      <div className="space-y-1.5">
                        <p className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground font-semibold"
                          title="Selecting one attaches the filed PDF to that reading and clears its download flag">Is this a queued download?</p>
                        {det.queueMatches.map((m, i) => (
                          <button key={`${m.list}-${m.group}-${m.item}`} onClick={() => setLinkSel(linkSel === i ? null : i)}
                            className={`w-full text-left rounded-md border px-2.5 py-1.5 transition-colors ${linkSel === i ? "border-primary bg-primary/5" : "border-border hover:border-primary/50"}`}>
                            <span className="flex items-start gap-1.5">
                              <span className={`mt-1 h-2 w-2 rounded-full shrink-0 ${linkSel === i ? "bg-primary" : "border border-muted-foreground"}`} />
                              <span className="min-w-0">
                                <span className="block text-[12px] leading-snug">{m.title}</span>
                                <span className="block text-[10.5px] text-muted-foreground nums">{Math.round(m.score * 100)}% title match</span>
                              </span>
                            </span>
                          </button>
                        ))}
                      </div>
                    )}

                    <div className="rounded-md border border-border">
                      <button onClick={() => setCiteOpen((v) => !v)}
                        className="w-full flex items-center gap-1.5 px-2.5 py-1.5 text-left">
                        <BookMarked size={13} className="text-primary shrink-0" />
                        <span className="text-[12px] font-medium">Citation &amp; BibTeX</span>
                        {citeEngaged && !citeOpen && <span className="text-[10.5px] text-primary">ready</span>}
                        <span className="ml-auto text-[10.5px] text-muted-foreground">{citeOpen ? "" : "optional"}</span>
                        <ChevronDown size={14} className={`text-muted-foreground transition-transform ${citeOpen ? "rotate-180" : ""}`} />
                      </button>
                      {citeOpen && (
                        <CiteEditor cf={cf} setField={setField} onReplace={(c) => { citeTouched.current = true; setCf(c); }}
                          sug={sug} sugLoading={sugLoading} bibPrev={bibPrev} />
                      )}
                    </div>

                    {det.textHead && (
                      <details className="text-[11.5px]">
                        <summary className="cursor-pointer text-muted-foreground hover:text-foreground select-none inline-flex items-center gap-1">
                          <BookOpen size={12} /> Opening-page text
                        </summary>
                        <p className="mt-1.5 text-muted-foreground leading-relaxed whitespace-pre-wrap max-h-44 overflow-y-auto border border-border rounded-md p-2">{det.textHead}</p>
                      </details>
                    )}
                  </>
                )}

                {err && (
                  <p className="text-[12px] text-destructive leading-snug flex items-start gap-1.5">
                    <AlertTriangle size={13} className="shrink-0 mt-0.5" /> <span>{err}</span>
                  </p>
                )}

                <div className="flex items-center gap-2 pt-1">
                  <Button variant="outline" size="sm" onClick={doArchive} disabled={busy || !det}
                    className={armArchive ? "border-destructive text-destructive" : ""}>
                    <Archive size={13} className="mr-1.5" /> {armArchive ? "Confirm archive" : "Archive"}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={doSkip} disabled={busy}>
                    <SkipForward size={13} className="mr-1.5" /> Skip
                  </Button>
                  <Button size="sm" onClick={doFile} disabled={!canFile} className="ml-auto">
                    {busy ? <Loader2 size={13} className="mr-1.5 animate-spin" /> : <Check size={13} className="mr-1.5" />}
                    File to Corpus
                  </Button>
                </div>
                <p className="text-[10.5px] text-muted-foreground leading-snug">
                  Archive moves the file to Corpus/archive/ — nothing is ever deleted. Filing renames in the Inbox first, then moves to Corpus.
                </p>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}

function Banner({ tone, text }: { tone: "red" | "amber"; text: string }) {
  const cls = tone === "red"
    ? "border-destructive/50 text-destructive"
    : "border-amber-500/50 text-amber-600 dark:text-amber-400";
  return (
    <p className={`text-[12px] leading-snug rounded-md border px-2.5 py-1.5 flex items-start gap-1.5 ${cls}`}>
      <AlertTriangle size={13} className="shrink-0 mt-0.5" /> <span>{text}</span>
    </p>
  );
}

// which fields matter for each work type (authors/year/title always show)
const TYPE_FIELDS: Record<string, ("container" | "publisher" | "address" | "volume" | "issue" | "pages" | "editor" | "edition" | "isbn" | "url")[]> = {
  book: ["publisher", "address", "edition", "isbn"],
  article: ["container", "volume", "issue", "pages"],
  chapter: ["container", "editor", "pages", "publisher", "address"],
  report: ["publisher", "address", "url"],
  thesis: ["publisher", "address", "url"],
  web: ["publisher", "url"],
  dataset: ["publisher", "url"],
};
const FIELD_LABEL: Record<string, string> = {
  container: "Journal / book title", publisher: "Publisher / institution", address: "Place",
  volume: "Vol.", issue: "Issue", pages: "Pages", editor: "Editor(s)", edition: "Edition",
  isbn: "ISBN", url: "URL",
};

function CiteEditor({ cf, setField, onReplace, sug, sugLoading, bibPrev }: {
  cf: CiteFields; setField: (p: Partial<CiteFields>) => void; onReplace: (c: CiteFields) => void;
  sug: CiteSuggest | null; sugLoading: boolean; bibPrev: CitePreview | null;
}) {
  const fill = (cand: CiteCandidate) => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { _source, _score, ...fields } = cand;
    onReplace({ ...emptyCite(), ...fields });
  };
  const fields = TYPE_FIELDS[cf.type] || TYPE_FIELDS.book;
  return (
    <div className="px-2.5 pb-2.5 pt-1 space-y-2.5 border-t border-border">
      {sugLoading && (
        <p className="text-[11.5px] text-muted-foreground inline-flex items-center gap-1.5">
          <Loader2 size={12} className="animate-spin" /> Searching CrossRef, Open Library, OpenAlex…
        </p>
      )}
      {sug && (sug.detected.doi || sug.detected.isbn) && (
        <p className="text-[10.5px] text-muted-foreground">
          In the PDF: {sug.detected.doi && <span>DOI <code className="text-[10px]">{sug.detected.doi}</code></span>}
          {sug.detected.doi && sug.detected.isbn ? " · " : ""}
          {sug.detected.isbn && <span>ISBN <code className="text-[10px]">{sug.detected.isbn}</code></span>}
        </p>
      )}
      {sug && sug.candidates.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[10.5px] uppercase tracking-[0.08em] text-muted-foreground font-semibold inline-flex items-center gap-1">
            <Sparkles size={11} /> Suggestions — click to fill
          </p>
          {sug.candidates.map((c, i) => (
            <button key={i} onClick={() => fill(c)}
              className="w-full text-left rounded-md border border-border hover:border-primary/60 px-2 py-1.5 transition-colors">
              <span className="block text-[11.5px] leading-snug">{c.authors.slice(0, 2).join("; ")}{c.authors.length > 2 ? " et al." : ""} ({c.year}) {c.title}</span>
              <span className="block text-[10px] text-muted-foreground nums mt-0.5">
                {c._source} · {c.type}{c.container ? ` · ${c.container}` : c.publisher ? ` · ${c.publisher}` : ""}{c.doi ? ` · doi` : ""}
              </span>
            </button>
          ))}
        </div>
      )}
      {sug && !sugLoading && sug.candidates.length === 0 && (
        <p className="text-[10.5px] text-muted-foreground">No metadata matches found — fill the fields by hand.</p>
      )}

      <div className="grid grid-cols-[1fr_auto] gap-1.5 items-center">
        <select value={cf.type} onChange={(e) => setField({ type: e.target.value })}
          className="h-8 text-[12px] rounded-md border border-border bg-background px-2">
          {CITE_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <Input value={cf.year} onChange={(e) => setField({ year: e.target.value })} placeholder="Year" className="h-8 text-[12px] w-[74px]" />
      </div>
      <textarea value={cf.authors.join("\n")}
        onChange={(e) => setField({ authors: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean) })}
        placeholder={"Authors — one per line, “Surname, Given”"} rows={Math.min(4, Math.max(2, cf.authors.length + 1))}
        className="w-full text-[12px] rounded-md border border-border bg-background px-2 py-1.5 leading-snug resize-y" />
      <textarea value={cf.title} onChange={(e) => setField({ title: e.target.value })} placeholder="Full title"
        rows={2} className="w-full text-[12px] rounded-md border border-border bg-background px-2 py-1.5 leading-snug resize-y" />
      <div className="grid grid-cols-2 gap-1.5">
        {fields.map((k) => (
          <Input key={k} value={(cf as unknown as Record<string, string>)[k]} onChange={(e) => setField({ [k]: e.target.value } as Partial<CiteFields>)}
            placeholder={FIELD_LABEL[k]} className={`h-8 text-[12px] ${k === "container" || k === "publisher" || k === "editor" || k === "url" ? "col-span-2" : ""}`} />
        ))}
        <Input value={cf.doi} onChange={(e) => setField({ doi: e.target.value })} placeholder="DOI" className="h-8 text-[12px] col-span-2" />
      </div>

      {bibPrev && (
        <div className="space-y-1.5">
          {bibPrev.citation && (
            <p className="text-[11px] text-foreground/80 leading-snug"
              dangerouslySetInnerHTML={{ __html: bibPrev.citation.replace(/\*(.+?)\*/g, "<i>$1</i>") }} />
          )}
          <pre className="text-[10.5px] leading-snug bg-secondary/40 border border-border rounded-md p-2 overflow-x-auto whitespace-pre">{bibPrev.bibtex}</pre>
          <p className="text-[10px] text-muted-foreground">On filing, this writes the citation note frontmatter and adds <code className="text-[9.5px]">@{bibPrev.citekey}</code> to library.bib.</p>
        </div>
      )}
    </div>
  );
}
