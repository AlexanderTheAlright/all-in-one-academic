
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChangeSet, StateEffect, StateField } from "@codemirror/state";
import { pendingDraftOpen, onPendingDraftOpen } from "@/lib/taskdest";
import { releaseDraftingLists } from "@/lib/draftgate";
import { api, type DraftConcept, type DraftConceptNote, type DraftCommentReply, type DraftCommentSuggestion } from "@/lib/api";
import type { DraftDoc, DraftWhich, DraftSave, DraftingPaper, CiteHit, CiteQuote, CiteMapEntry, RefStyle, RefBuild, RefEntry, DraftPresentation, DraftDeck, DeckSlide, DeckReview, DraftSupplement, DraftSupplementDoc, DraftProjectDocs, DraftVersion, DraftVersionDiff, DiffSegment, CorpusRow, CorpusSort, CorpusBrowse, DraftCorpusHit, DraftCorpusPassage, DraftCorpusSearch, CitePageTarget, DraftComment, DraftCommentRect, DraftCommentProvenance, DraftAsset, DraftProvenance, DraftProvEmbed, DraftVerify, DraftNumbers, NumbersEntryRow, DraftReplicationFiles, DraftReplScript, FigureComment, FigureCommentProv, JournalInfo, JournalChecklist, DraftStatus, DraftReport, DraftMeasure, DraftSyllabus, SyllabusList, ReadmeStatus, DraftLog, DatasetHit, ArchivedProject } from "@/lib/api";
import { useApi, usePersistent } from "@/lib/hooks";
import { draftDocFetcher, DRAFT_DOC_API, cacheDraftPart, cacheDraftComments, dropDraft, dropSupersededDraft,
  holdDraft, draftHeld, noteDraftOpened, noteDraftRows, recentDrafts, primeDrafts, rememberResolved, recallResolved, type DraftRef } from "@/lib/prefetch";
import { loadCiteIndex, searchCiteIndex, searchRemote, citeIndexState, onCiteIndex,
  citeDetailCached, type CiteIndexState, type CiteDetail } from "@/lib/citeIndex";
import { openFile, openUrl, openDir } from "@/lib/opener";
import { NotePreview } from "@/components/NotePreview";
// A bulk-review Undo follows later typing without restoring a stale whole document.
const reviewUndoState = StateEffect.define<{ inverse: ChangeSet | null; collecting: boolean }>();
const reviewUndoField = StateField.define<{ inverse: ChangeSet | null; collecting: boolean }>({
  create: () => ({ inverse: null, collecting: false }),
  update(value, tr) {
    let next = value;
    if (value.inverse && tr.docChanged) next = { ...value, inverse: value.collecting
      ? tr.changes.invert(tr.startState.doc).compose(value.inverse)
      : value.inverse.map(tr.changes) };
    for (const effect of tr.effects) if (effect.is(reviewUndoState)) next = effect.value;
    return next;
  },
});
import { ClaimsPanel } from "@/components/ClaimsPanel";
import { useSaveKey } from "@/lib/savekey";
import { copyPlain } from "@/lib/clipboard";
import { useVaultRoot, PROJECT_PREFIX } from "@/lib/paths";
import { easeScrollTo, easeScrollBy, targetTop, pendingOf } from "@/lib/scroll";
import { MarkdownEditor, figureToPngBlob } from "@/lib/markdownEditor";
import type { MdEditorHandle, MentionInfo, MentionKey, CRange, FigRect, EmbedProv, NumRange } from "@/lib/markdownEditor";
import { numberFlags, numberStatusChip, numberScriptChip, compareNumberRows } from "@/lib/numberFlags";
import { locate, makeAnchor, lineDiff, compactDiff, diffCounts, commentIsOpen, detachAt, detachedPos, attached } from "@/lib/anchors";
import { suggestionSpan } from "@/lib/suggestSpan";
import { parseManuscript, parseEditor, serializeEditor, joinComments, extractMdEmbeds } from "@/lib/editorModel";
import type { EItem, EPara, Comment } from "@/lib/editorModel";
import { parseOutline, serializeOutline, canonHeading } from "@/lib/outlineModel";
import type { OutlineSection, OutlineExtra } from "@/lib/outlineModel";
import { parsePlan, serializePlan, isStructured, needsFigureLabel, newPoint, exhibitTag, hypBadge } from "@/lib/outlinePlan";
import type { SectionPlan, Point, Bullet, Hyp } from "@/lib/outlinePlan";
import { SkelOverview } from "@/components/Skeletons";
import { reapplyById } from "@/components/explore/figureStore";
import { DraftPublish } from "@/components/DraftPublish";
import { NewDocumentDialog, DEFAULT_FORMAT } from "@/components/drafting/NewDocumentDialog";
import { FolderOpen, PanelLeft, PanelRight } from "lucide-react";
import { useFind } from "@/components/drafting/FindBar";
import { FocusMode } from "@/components/drafting/FocusMode";
import { RewriteMode, type RewriteApi, type RewriteMenu } from "@/components/drafting/RewriteMode";
import { selectFromMain } from "@/lib/paneWrite";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { Focus as FocusIcon, Link2, BookCheck, ListChecks } from "lucide-react";
import { LiteratureMode } from "@/components/drafting/LiteratureMode";
import { ChecklistPanel } from "@/components/drafting/ChecklistPanel";
import { cmFindTarget } from "@/lib/cmFind";
import { domFindTarget } from "@/lib/domFind";
import { Markdown, PoemView } from "@/lib/markdown";
import { renderPreset, readPublish, withPublish, readSpacingKey, withSpacing, withFmKey, readFmKey, formatLabel, PUBLISH_FORMATS, KIND_DEFAULT_PUBLISH, DRAFT_MEASURE, PUB_JOURNALS } from "@/lib/draftStyle";
import { paginate, formatDefaultSpacing, readDocFont, readDocSize, DOC_FONTS, type SpacingMode, type PageProfile } from "@/lib/pagination";
import PageView from "@/components/PageView";
import type { DraftStyle } from "@/lib/draftStyle";
import { SquarePen, RotateCw, Undo2, FileText, Search, Star, Plus, X, AlertTriangle, MessageSquareText, MessageSquare, ChevronLeft, List, ExternalLink, Globe, BookOpen, Quote, Newspaper, GraduationCap, ScrollText, Check, ListOrdered, Save, Minus, Lock, Unlock, Compass, ListTree, ChevronRight, ChevronDown, ChevronsDownUp, ChevronsUpDown, ArrowUp, ArrowDown, ArrowRight, Trash2, Maximize2, Minimize2, FileOutput, FileType2, AtSign, BookMarked, Loader2, Copy, Library, Tag, Presentation, StickyNote, Projector, Clock, RotateCcw, Paperclip, FilePlus2, Mail, Monitor, Type, History, GitCompare, Printer, MessageSquarePlus, Eye, CheckCheck, ClipboardCheck, Sun, Image as ImageIcon, FlaskConical, FileCode, Database, RefreshCw, Table2, FolderDown, FolderUp, FileBarChart2, Feather, Send, CircleCheck, CircleHelp, FileStack, ShieldCheck, PenLine, IndentIncrease, FileDown, Bot, CornerDownRight, Sigma, CalendarClock, Columns2, Columns3, Lightbulb, LocateFixed, ArrowUpDown, Pin, PinOff, Replace, SearchCheck, Repeat2 } from "lucide-react";
import { DraftingPipeline, DRAFTING_TAB_KEY, DRAFTING_TAB_EVENT } from "@/components/DraftingPipeline";
import { DiagramEditor } from "@/components/DiagramEditor";
import { NumberPicker, type NumberInsert, type NumberPreselect } from "@/components/NumberPicker";
import { ResultsTabs, ResultsFindings, type FindingCell } from "@/components/drafting/ResultsFindings";
import { StoreFigureViewer, useStoreIndex } from "@/components/explore/StoreFigureViewer";
import { DialogsProvider, useDialogs } from "@/components/ui/app-dialogs";
import { WidgetFrame, useWidget, rowCap } from "@/components/ui/widget";
import { layerAbove, openWidgetFocus } from "@/lib/arrownav";
import { relativeAgo } from "@/lib/format";
import type { DraftOutline } from "@/lib/api";
import { toast } from "sonner";
import { reloadForUpdate } from "@/components/StaleDot";
import { useRestIntent } from "@/lib/restIntent";
import { FigureLightbox, FileViewerPanel, MarpSurface, DivergenceBanner, ProvChip,
  preloadDeckImages, typingEscape, pdfFindKey, PdfFindFrame, fmtBytes, SERIF, PRESENT_CHANNEL, PRESENT_BUS_KEY,
  projectRelOf } from "@/components/draftingShared";

type Status = "idle" | "saving" | "saved" | "error";
type Conflict = { currentMtime: number; currentText: string } | null;
const countWords = (t: string) => (t.trim().match(/[\w'’-]+/g) || []).length;
const cite = (h: CiteHit) => `${h.intext || h.author || h.citekey || h.stem} ${h.year ?? ""}${h.year != null ? h.suffix || "" : ""}`.trim();
const relAgo = (raw: number) => {
  if (!raw) return "";
  const ms = raw < 1e12 ? raw * 1000 : raw;            // tolerate seconds or ms
  return relativeAgo(Math.max(0, Math.round((Date.now() - ms) / 1000)));
};

type Heading = { level: number; text: string; pos: number };
function parseHeadings(text: string): Heading[] {
  const out: Heading[] = []; let off = 0;
  for (const ln of text.split("\n")) { const m = /^(#{1,6})\s+(.*?)\s*$/.exec(ln); if (m) out.push({ level: m[1].length, text: m[2], pos: off }); off += ln.length + 1; }
  return out;
}

/** The leading YAML frontmatter block — mirrors drafting.py _frontmatter exactly. */
function frontmatter(text: string): string {
  const t = text || "";
  if (!t.startsWith("---")) return "";
  const end = t.indexOf("\n---", 3);
  return end !== -1 ? t.slice(3, end) : "";
}

function deriveTitle(text: string, slug: string): string {
  const tm = /^title\s*:\s*(.+?)\s*$/m.exec(frontmatter(text));
  if (tm) return tm[1].trim().replace(/^["']+|["']+$/g, "");
  const m = /^#\s+(.*?)\s*$/m.exec(text || "");
  return m ? m[1].trim() : slug;
}

/** Hooks a host editor lends the save plumbing (all optional, read live through a ref). */
type DocHooks = {
  adopt?: (sentText: string, mergedText: string) => string | null;
  // fallback when adopt is absent or refuses: replace the editor text wholesale
  onMerged?: (text: string) => void;
  // called right before a save is POSTed, with the text being sent
  markSaveStart?: (sentText: string) => void;
  // called after every save the server accepted, with the text now on disk
  onSaved?: (text: string) => void;
};

function useDoc(slug: string, which: DraftWhich, value: string, mtime0: number, docName: string, hooks?: DocHooks, cacheDoc?: string) {
  const ck = cacheDoc ?? docName;
  const [text, setText] = useState(value);
  const [status, setStatus] = useState<Status>("idle");
  const [conflict, setConflict] = useState<Conflict>(null);
  const saved = useRef(value), textRef = useRef(value), mtimeRef = useRef(mtime0);
  const diskRef = useRef(value);
  const running = useRef<Promise<void> | null>(null);
  // a save requested while one was in flight: the latest text, and whether it was forced
  const pending = useRef<{ text: string; force: boolean } | null>(null);
  const recent = useRef<string[]>([value]);
  const remember = useCallback((t: string) => { const r = recent.current; if (r[r.length - 1] !== t) { r.push(t); if (r.length > 8) r.shift(); } }, []);
  useEffect(() => { textRef.current = text; }, [text]);

  const hooksRef = useRef(hooks); useEffect(() => { hooksRef.current = hooks; });
  // one POST (plus its single merge retry). Only ever called from the chain in save().
  const send = useCallback((t: string): Promise<void> => {
    setStatus("saving");
    const base = saved.current;
    const accept = (t2: string, mtime: number) => {
      // the server's stamp for the write it just made is the truth, even if older
      saved.current = t2; mtimeRef.current = mtime;
      cacheDraftPart(slug, ck, which, t2, mtime);
      setConflict(null); setStatus("saved"); remember(t2);
      try { hooksRef.current?.onSaved?.(t2); } catch { /* host callback is best effort */ }
    };
    const settle = (r: DraftSave, retried: boolean): Promise<void> | void => {
      if (r.conflict) {
        if (!retried) {
          // hand the server the ancestor and let it try to merge the two edits
          return api.draftingSave({ slug, which, text: t, baseMtime: mtimeRef.current, doc: docName, baseText: base })
            .then((r2) => settle(r2, true)) as Promise<void>;
        }
        setConflict({ currentMtime: r.currentMtime!, currentText: r.currentText ?? "" }); setStatus("error");
        return;
      }
      if (r.ok && r.merged && typeof r.text === "string") {
        // the server merged and got back exactly what we sent: a plain accept. Nothing
        // on screen changes, no toast.
        if (r.text === t) { accept(t, r.mtime!); return; }
        accept(r.text, r.mtime!);
        remember(t);
        const h = hooksRef.current;
        const live = h?.adopt ? h.adopt(t, r.text) : null;
        if (live != null) setText(live);
        else { setText(r.text); h?.onMerged?.(r.text); }
        toast.success("Merged with an edit made elsewhere — both changes kept", { id: "draft-merged" });
        return;
      }
      if (r.ok) accept(t, r.mtime!);
    };
    try { hooksRef.current?.markSaveStart?.(t); } catch { /* tracking is best effort */ }
    return api.draftingSave({ slug, which, text: t, baseMtime: mtimeRef.current, doc: docName })
      .then((r) => settle(r, false))
      .catch(() => { setStatus("error"); toast.error("Couldn't save — your writing is safe on screen, it'll retry", { id: "draft-save-error" }); });
  }, [slug, which, docName, remember, ck]);

  const save = useCallback((t: string, force = false): Promise<void> => {
    if (running.current) {
      // coalesce into the chain in flight: it sends the latest text once it settles
      pending.current = { text: t, force: force || !!pending.current?.force };
      return running.current;
    }
    if (!force && t === saved.current) return Promise.resolve();
    const chain = (async () => {
      let next: { text: string; force: boolean } | null = { text: t, force };
      while (next) {
        await send(next.text);
        const p: { text: string; force: boolean } | null = pending.current; pending.current = null;
        next = p && (p.force || p.text !== saved.current) ? p : null;
      }
    })().finally(() => { running.current = null; });
    running.current = chain;
    return chain;
  }, [send]);

  useEffect(() => { if (text === saved.current) return; const id = setTimeout(() => save(text), 1500); return () => clearTimeout(id); }, [text, save]);
  useEffect(() => {
    // the unload and unmount writes carry baseText too, so closing a window on a
    // file an agent touched still merges instead of being dropped on the floor
    const beacon = () => {
      if (running.current || textRef.current !== saved.current) dropDraft(slug, ck, true);
      if (textRef.current === saved.current) return; try { navigator.sendBeacon("/drafting/save", new Blob([JSON.stringify({ slug, which, text: textRef.current, baseMtime: mtimeRef.current, doc: docName, baseText: saved.current })], { type: "application/json" })); } catch { /* best effort */ } };
    window.addEventListener("beforeunload", beacon);
    return () => {
      window.removeEventListener("beforeunload", beacon);
      const fire = (): Promise<void> | void => {
        if (textRef.current === saved.current) return;
        const t = textRef.current;
        return api.draftingSave({ slug, which, text: t, baseMtime: mtimeRef.current, doc: docName, baseText: saved.current })
          .then((r) => {
            if (!r.ok || typeof r.mtime !== "number") return;
            const onDisk = r.merged && typeof r.text === "string" ? r.text : t;
            saved.current = onDisk; mtimeRef.current = r.mtime;
            cacheDraftPart(slug, ck, which, onDisk, r.mtime);
          })
          .catch(() => {});
      };
      const leaving = running.current ? running.current.then(fire, fire) : fire();
      if (leaving) holdDraft(slug, ck, leaving);
    };
  }, [slug, which, docName, ck]);

  const reloadFromDisk = useCallback((): string | null => { if (!conflict) return null; saved.current = conflict.currentText; diskRef.current = conflict.currentText; mtimeRef.current = conflict.currentMtime; cacheDraftPart(slug, ck, which, conflict.currentText, conflict.currentMtime); setText(conflict.currentText); setConflict(null); setStatus("idle"); return conflict.currentText; }, [conflict, slug, ck, which]);
  const overwrite = useCallback(() => { if (!conflict) return; mtimeRef.current = conflict.currentMtime; save(textRef.current, true); }, [conflict, save]);
  const applyExternal = useCallback((t: string, mt: number) => { saved.current = t; diskRef.current = t; mtimeRef.current = mt; cacheDraftPart(slug, ck, which, t, mt); setConflict(null); setStatus("saved"); setText(t); remember(t); }, [remember, slug, ck, which]);
  const takeMine = useCallback((diskMtime: number): Promise<void> => { mtimeRef.current = diskMtime; return save(textRef.current, true); }, [save]);
  const adoptMtime = useCallback((mt: number) => { if (!(mt < mtimeRef.current)) { mtimeRef.current = mt; cacheDraftPart(slug, ck, which, saved.current, mt); } }, [slug, ck, which]);
  const flush = useCallback((): Promise<boolean> => save(textRef.current).then(() => textRef.current === saved.current), [save]);
  useSaveKey(() => flush());
  return { text, setText, status, dirty: text !== saved.current, conflict, reloadFromDisk, overwrite, applyExternal, takeMine, adoptMtime, flush, mtime: () => mtimeRef.current, savedText: () => saved.current, diskText: () => diskRef.current, inFlight: () => running.current !== null, wroteRecently: (t: string) => recent.current.includes(t) };
}

type CommentMutations = { added: string[]; changed: string[]; deleted: string[] };
const noMutations = (m: CommentMutations) => !m.added.length && !m.changed.length && !m.deleted.length;

function diffComments(base: DraftComment[], next: DraftComment[]): CommentMutations {
  const b = new Map(base.map((c) => [c.id, c])), n = new Set(next.map((c) => c.id));
  const added: string[] = [], changed: string[] = [], deleted: string[] = [];
  for (const c of next) {
    const prev = b.get(c.id);
    if (!prev) added.push(c.id);
    else if (JSON.stringify(prev) !== JSON.stringify(c)) changed.push(c.id);
  }
  for (const c of base) if (!n.has(c.id)) deleted.push(c.id);
  return { added, changed, deleted };
}

function mergeComments(server: DraftComment[], local: DraftComment[], m: CommentMutations): DraftComment[] {
  const mine = new Map(local.map((c) => [c.id, c]));
  const del = new Set(m.deleted), touched = new Set([...m.added, ...m.changed]);
  const out: DraftComment[] = [], seen = new Set<string>();
  for (const c of server) {
    if (del.has(c.id) || seen.has(c.id)) continue;
    out.push(touched.has(c.id) ? mine.get(c.id)! : c);
    seen.add(c.id);
  }
  for (const id of [...m.added, ...m.changed]) {
    if (seen.has(id)) continue;
    const c = mine.get(id);
    if (c) { out.push(c); seen.add(id); }
  }
  return out;
}

function useComments(slug: string, docName: string, initial: DraftComment[], mtime0: number, version0 = "", cacheDoc?: string, omitted0?: number) {
  const ck = cacheDoc ?? docName;   // the loader's cache name, as in useDoc
  const [comments, setComments] = useState<DraftComment[]>(initial);
  const savedRef = useRef<DraftComment[]>(initial), mtimeRef = useRef(mtime0), listRef = useRef(initial);
  const verRef = useRef<string>(version0);
  const inflight = useRef(0);   // a comments POST in flight — the poller skips its own write
  
  const lite = useRef(typeof omitted0 === "number").current;
  const unheld = useRef(lite ? Math.max(0, omitted0 as number) : 0);
  const [loaded, setLoaded] = useState(unheld.current === 0);
  const explicitDel = useRef(new Set<string>());
  const applyExternalRef = useRef<((list: DraftComment[], mt: number, ver?: string) => void) | null>(null);
  const nowLoaded = useCallback((list: DraftComment[], ver: string) => {
    unheld.current = 0; setLoaded(true);
    if (lite) rememberResolved(slug, ck, ver, list.filter((c) => c.resolved));
  }, [lite, slug, ck]);
  useEffect(() => { listRef.current = comments; }, [comments]);
  const save = useCallback((list: DraftComment[]): Promise<void> => {
    // the queue of local mutations, derived from the last list the server confirmed
    const muts = diffComments(savedRef.current, list);
    if (noMutations(muts)) { savedRef.current = list; return Promise.resolve(); }   // nothing to write
    const deletedIds = muts.deleted.filter((id) => explicitDel.current.has(id));
    const post = (payload: DraftComment[], mt: number | null, ver: string | null) =>
      api.draftingSaveComments({ slug, doc: docName, comments: payload, baseMtime: mt, baseVersion: ver, deletedIds, ...(lite ? { partial: true } : null) });
    // the server kept comments this post left out unnamed: this tab does not hold them, so
    // read the store back and show them (only when nothing local is waiting)
    const reread = (kept?: number) => {
      if (!kept) return;
      void api.draftingComments(slug, docName).then((cl) => {
        if (cl.ok && cl.comments && listRef.current === savedRef.current && inflight.current === 0) applyExternalRef.current?.(cl.comments, cl.mtime ?? 0, cl.version ?? "");
      }).catch(() => { /* the poller's full read settles it */ });
    };
    const accept = (list2: DraftComment[], mt?: number, ver?: string, kept?: number) => {
      savedRef.current = list2; mtimeRef.current = mt ?? mtimeRef.current; verRef.current = ver ?? "";
      for (const id of deletedIds) explicitDel.current.delete(id);
      // what the server says it kept is, by definition, what this tab does not hold
      if (lite && typeof kept === "number") unheld.current = kept;
      // the list this answer confirmed, with this answer's stamp and pin; an answer
      // without a stamp leaves the cached pair as it was (the poller re-reads it)
      if (typeof mt === "number") cacheDraftComments(slug, ck, list2, mt, ver ?? "", lite ? unheld.current : null);
      if (lite && unheld.current === 0) rememberResolved(slug, ck, ver ?? "", list2.filter((c) => c.resolved));
    };
    inflight.current++;
    return post(list, mtimeRef.current, verRef.current)
      .then((r) => {
        if (!r.conflict) { if (r.ok) { accept(list, r.mtime, r.version, r.resolvedKept); reread(r.keptAbsent); } return; }
        const merged = mergeComments(r.currentComments ?? [], list, muts);
        return post(merged, r.currentMtime ?? null, r.currentVersion ?? null).then((r2) => {
          if (!r2.ok) { toast.error("Comments changed elsewhere — reload the tab to see them", { id: "draft-comments-conflict" }); return; }
          accept(merged, r2.mtime, r2.version, r2.resolvedKept);
          reread(r2.keptAbsent);
          if (lite && unheld.current === 0) setLoaded(true);
          // show the other side's comments; anything typed while this was in flight rides along
          setComments((curr) => curr === list ? merged : mergeComments(merged, curr, diffComments(list, curr)));
        });
      })
      .catch(() => { /* the on-screen comments are safe; the next edit retries */ })
      .finally(() => { inflight.current--; });
  }, [slug, docName, ck, lite]);
  useEffect(() => { if (comments === savedRef.current) return; const id = setTimeout(() => save(comments), 700); return () => clearTimeout(id); }, [comments, save]);
  // `list` is the WHOLE store as one read returned it
  const applyExternal = useCallback((list: DraftComment[], mt: number, ver = "") => { savedRef.current = list; mtimeRef.current = mt; verRef.current = ver; nowLoaded(list, ver); cacheDraftComments(slug, ck, list, mt, ver, lite ? 0 : null); setComments(list); }, [slug, ck, lite, nowLoaded]);
  applyExternalRef.current = applyExternal;
  const remove = useCallback((id: string) => { explicitDel.current.add(id); setComments((cur) => cur.filter((c) => c.id !== id)); }, []);
  const adopt = useCallback((list: DraftComment[]) => {
    savedRef.current = list; setComments(list);
  }, []);
  
  const mergeResolved = useCallback((half: DraftComment[], ver: string): string[] | "busy" | "stale" => {
    if (inflight.current > 0 || listRef.current !== savedRef.current) return "busy";
    if (!ver || ver !== verRef.current) return "stale";
    const have = new Set(savedRef.current.map((c) => c.id));
    const extra = half.filter((c) => c && c.id && !have.has(c.id));
    const next = extra.length ? [...savedRef.current, ...extra] : savedRef.current;
    savedRef.current = next; listRef.current = next;
    nowLoaded(next, ver);
    if (extra.length) setComments(next);
    return extra.map((c) => c.id);
  }, [nowLoaded]);
  const flush = useCallback((): Promise<void> => (listRef.current === savedRef.current ? Promise.resolve() : save(listRef.current)), [save]);
  // ctrl/cmd+s writes the annotation layer now too
  useSaveKey(() => flush());
  return { comments, setComments, applyExternal, adopt, remove, flush, dirty: comments !== savedRef.current, isDirty: () => listRef.current !== savedRef.current, mtime: () => mtimeRef.current, version: () => verRef.current, inFlight: () => inflight.current > 0,
    mergeResolved,
    /** resolved comments exist in the store that are not in `comments` yet */
    resolvedPending: !loaded,
    /** how many (0 once merged): for counts shown before the half lands */
    resolvedUnheld: loaded ? 0 : unheld.current };
}

function CommentComposer({ sel, onSubmit, onCancel }: {
  sel: { from: number; to: number; text: string; x: number; y: number; kind?: "text" | "figure"; rectPct?: DraftCommentRect | null; suggest?: boolean };
  onSubmit: (body: string, proposed?: string) => void; onCancel: () => void;
}) {
  const [body, setBody] = useState("");
  const isFigure = sel.kind === "figure";
  const [suggest, setSuggestRaw] = useState(!!sel.suggest && !isFigure);
  const [proposed, setProposed] = useState(sel.text);
  const setSuggest = (on: boolean) => { setSuggestRaw(on); requestAnimationFrame(() => ref.current?.focus()); };
  const ref = useRef<HTMLTextAreaElement>(null);
  // a "figure" comment on a table embed (![[tab….csv]] etc.) — same kind, table wording
  const noun = isFigure && /\.(csv|md|txt)(\|[^\]]*)?\]\]/i.test(sel.text) ? "table" : "figure";
  useEffect(() => { ref.current?.focus(); }, []);
  useEffect(() => { const h = (e: KeyboardEvent) => { if (e.key === "Escape") { if (typingEscape(e)) return; e.preventDefault(); e.stopPropagation(); onCancel(); } }; window.addEventListener("keydown", h, true); return () => window.removeEventListener("keydown", h, true); }, [onCancel]);
  const W = suggest ? 380 : 300, H = suggest ? 320 : 200;
  const left = Math.max(8, Math.min(sel.x, (typeof window !== "undefined" ? window.innerWidth : 1200) - W - 12));
  const top = Math.max(8, Math.min(sel.y + 8, (typeof window !== "undefined" ? window.innerHeight : 800) - H - 12));
  const submit = () => { if (suggest) { if (proposed !== sel.text) onSubmit(body, proposed); } else if (body.trim()) onSubmit(body); };
  const canSubmit = suggest ? proposed !== sel.text : !!body.trim();
  return createPortal(
    <>
      <div className="fixed inset-0 z-[150]" onMouseDown={onCancel} />
      <div role="dialog" aria-modal="true" aria-label="Comment" data-knav-modal className="fixed z-[151] rounded-xl border border-border bg-card shadow-xl p-3" style={{ left, top, width: W }} onMouseDown={(e) => e.stopPropagation()}>
        <div className="text-[10.5px] uppercase tracking-wide text-muted-foreground/70 mb-1.5 flex items-center gap-1.5">{suggest ? <Replace size={12} /> : <MessageSquarePlus size={12} />} {isFigure ? (sel.rectPct ? "Comment on this region" : "Comment on this " + noun) : suggest ? "Suggest change" : "Comment on selection"}
          {!isFigure && (
            <button type="button" data-cmt-suggest-toggle aria-pressed={suggest} onClick={() => setSuggest(!suggest)}
              title={suggest ? "Back to a plain comment" : "Suggest change: edit the selected text itself"}
              className={`ml-auto inline-flex h-5 w-5 items-center justify-center rounded normal-case focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50 ${suggest ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground hover:bg-muted/60"}`}>
              <Replace size={12} /></button>
          )}</div>
        {isFigure ? (
          <div className="mb-2 text-[11.5px] text-foreground/70 italic truncate">{sel.text}{sel.rectPct && <span className="not-italic text-muted-foreground"> · region flagged</span>}</div>
        ) : (
        <div className="mb-2 max-h-12 overflow-hidden rounded border-l-2 px-2 py-1 text-[11.5px] text-foreground/80 italic" style={{ backgroundColor: "hsl(45 90% 55% / 0.18)", borderColor: "hsl(45 90% 45% / 0.6)", fontFamily: SERIF }}>{sel.text.slice(0, 160)}{sel.text.length > 160 ? "…" : ""}</div>
        )}
        {suggest ? (<>
          <textarea ref={ref} value={proposed} data-cmt-suggest-input onChange={(e) => setProposed(e.target.value)} onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); submit(); } }} rows={7} spellCheck
            className="w-full resize-y rounded-md border border-primary/40 bg-background px-2 py-1.5 text-[12.5px] leading-snug focus:outline-none focus:border-primary/60" style={{ maxHeight: "40vh", fontFamily: SERIF }} />
          <input value={body} onChange={(e) => setBody(e.target.value)} data-cmt-suggest-note placeholder="Why (optional)" onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); submit(); } }}
            className="mt-1.5 w-full rounded-md border border-border bg-background px-2 py-1 text-[12px] focus:outline-none focus:border-primary/50" />
        </>) : (
        <textarea ref={ref} value={body} onChange={(e) => setBody(e.target.value)} onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); submit(); } }} rows={3} placeholder="Your comment…" className="w-full resize-none rounded-md border border-border bg-background px-2 py-1.5 text-[12.5px] focus:outline-none focus:border-primary/50" />
        )}
        <div className="mt-2 flex items-center justify-between">
          <span className="text-[10px] text-muted-foreground/60">⌘↵ to add</span>
          <div className="flex items-center gap-2">
            <button type="button" onClick={onCancel} data-knav-back="2" className="text-[12px] text-muted-foreground hover:text-foreground">Cancel</button>
            <button type="button" onClick={submit} disabled={!canSubmit} data-cmt-composer-submit className="inline-flex items-center gap-1 rounded-md bg-primary/10 border border-primary/40 text-primary px-2.5 py-1 text-[12px] disabled:opacity-50">{suggest ? "Suggest" : "Comment"}</button>
          </div>
        </div>
      </div>
    </>, document.body);
}

function EditorContextMenu({ at, hasSelection, embeds, onComment, onSuggest, onInsertEmbed, onInsertCitation, onInsertNumber, onNewDiagram, onInsertPageBreak, onIndentParagraph, onOpenResults, onClose, onRefocus }: {
  at: { x: number; y: number }; hasSelection: boolean;
  embeds: DraftAsset[];
  onComment: () => void; onSuggest?: () => void; onInsertEmbed: (stem: string, kind: string, name?: string) => void; onInsertCitation: () => void;
  onInsertNumber?: () => void;
  onNewDiagram: () => void; onInsertPageBreak: () => void; onIndentParagraph: () => void; onOpenResults: () => void; onClose: () => void;
  // hand the caret back to the manuscript (Escape, click-away, an insert that stays in the text)
  onRefocus?: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const tokens = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  const matches = embeds.filter((e) => {
    const text = `${e.name} ${e.caption || ""} ${e.diagram ? "diagram" : e.kind}`.toLocaleLowerCase();
    return tokens.every((token) => text.includes(token));
  });
  const dismiss = () => { onClose(); onRefocus?.(); };
  useEffect(() => { const h = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); dismiss(); } }; window.addEventListener("keydown", h, true); return () => window.removeEventListener("keydown", h, true); });
  // opened from the keyboard (Menu key / Shift+F10) the caret is still in the editor,
  // where arrows would move it — focus search so typing filters immediately
  useEffect(() => { panelRef.current?.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true }); }, []);
  const W = Math.min(340, window.innerWidth - 24);
  const left = Math.max(8, Math.min(at.x, (typeof window !== "undefined" ? window.innerWidth : 1200) - W - 12));
  const height = Math.min(480, window.innerHeight - 16);
  const top = Math.max(8, Math.min(at.y, window.innerHeight - height - 8));
  const run = (fn: () => void, back = false) => (e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); fn(); onClose(); if (back) onRefocus?.(); };
  // a plain render function, not an inline component: a component defined here gets a
  // new type every render, so React would remount the items and drop keyboard focus
  const item = (icon: ReactNode, label: string, onPick: () => void, back = false, kbd = "") => (
    <button type="button" role="menuitem" onMouseDown={(e) => e.preventDefault()} onClick={run(onPick, back)} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] text-foreground/90 hover:bg-accent">
      <span className="text-muted-foreground shrink-0">{icon}</span>
      <span className="flex-1 truncate">{label}</span>
      {kbd && <span className="text-[10px] text-muted-foreground/60 shrink-0">{kbd}</span>}
    </button>
  );
  return createPortal(
    <>
      <div className="fixed inset-0 z-[150]" onMouseDown={(e) => { e.preventDefault(); dismiss(); }} onContextMenu={(e) => { e.preventDefault(); dismiss(); }} />
      <div ref={panelRef} role="menu" aria-modal="true" aria-label="Drafting menu" data-knav-modal className="fixed z-[151] overflow-y-auto rounded-xl border border-border bg-card shadow-xl p-1.5" style={{ left, top, width: W, maxHeight: height }} onMouseDown={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()}>
        {hasSelection && (<>
          {item(<MessageSquarePlus size={14} />, "Comment on selection", onComment)}
          {onSuggest && item(<Replace size={14} />, "Suggest change", onSuggest)}
          <div className="my-1 h-px bg-border/70" />
        </>)}
        {item(<AtSign size={14} />, "Insert citation", onInsertCitation, false, "@")}
        {onInsertNumber && item(<Sigma size={14} />, "Insert number…", onInsertNumber)}
        {item(<PenLine size={14} />, "New diagram…", onNewDiagram)}
        {item(<FileStack size={14} />, "Insert page break", onInsertPageBreak, true)}
        {item(<IndentIncrease size={14} />, "Indent paragraph (quotation)", onIndentParagraph, true)}
        <div className="my-1 h-px bg-border/70" />
        <div className="flex items-center gap-1.5 px-2 pt-0.5 pb-1 text-[10px] uppercase tracking-wide text-muted-foreground/60"><ImageIcon size={11} /> Insert figure, diagram or table</div>
        <label className="mx-1 mb-1 flex items-center gap-1.5 rounded-md border border-border px-2 text-muted-foreground">
          <Search size={13} className="shrink-0" />
          <input aria-label="Search project figures and diagrams" placeholder="Search project figures and diagrams…" value={query} onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); const first = matches[0]; if (first) { onInsertEmbed(first.stem, first.kind, first.name); onClose(); onRefocus?.(); } } }}
            className="min-w-0 w-full bg-transparent py-1.5 text-[12px] text-foreground outline-none placeholder:text-muted-foreground/70" />
        </label>
        {matches.length === 0 ? (
          <div role="status" className="px-2 py-1 text-[11.5px] leading-snug text-muted-foreground/70">{query ? "No matching figures or diagrams." : "No project figures or diagrams yet."}</div>
        ) : (
          <div className="max-h-[200px] overflow-y-auto">
            {matches.map((e) => (
              <button type="button" role="menuitem" key={e.name} data-draft-asset={e.name} onMouseDown={(ev) => ev.preventDefault()} onClick={run(() => onInsertEmbed(e.stem, e.kind, e.name), true)} title={[e.name, e.caption].filter(Boolean).join("\n")}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-accent">
                <span className="shrink-0 text-muted-foreground">{e.kind === "table" ? <Table2 size={13} /> : e.diagram ? <PenLine size={13} /> : <ImageIcon size={13} />}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-[11px] text-foreground/90">{e.name}</span>
                  {e.caption && <span className="block truncate text-[10px] text-muted-foreground/70">{e.caption}</span>}
                </span>
              </button>
            ))}
          </div>
        )}
        <div className="my-1 h-px bg-border/70" />
        {item(<FlaskConical size={14} />, "Open Results workbench…", onOpenResults)}
      </div>
    </>, document.body);
}

export type CommentCardData = {
  quote: string; body: string; resolved: boolean;
  kind?: "text" | "figure" | "flag"; focusFlag?: boolean; rectPct?: DraftCommentRect | null;
  provenance?: DraftCommentProvenance; updated: number; created: number;
  author?: string;
  replies?: DraftCommentReply[];
  // keys the card's remembered thread state; both comment systems carry one
  id?: string;
  // a reviewer-response card names who raised the point (R1..R9, Editor, AE)
  reviewer?: string;
  // a section-materials card: one per sentence-outline stub, usually with many replies
  outline?: boolean;
  // a suggested change: `proposed` replaces the quote on Accept
  suggestion?: DraftCommentSuggestion;
  detached?: boolean;
};

// Word-level diff for a suggested change: whitespace-separated tokens, LCS. Paragraph-sized
// inputs only; past the cap it shows the whole old text struck and the whole new inserted.
type WDiff = { t: "eq" | "del" | "ins"; s: string }[];
function wordDiff(a: string, b: string): WDiff {
  const A = a.split(/(\s+)/).filter(Boolean), B = b.split(/(\s+)/).filter(Boolean);
  if (A.length * B.length > 400_000) return ([{ t: "del", s: a }, { t: "ins", s: b }] as WDiff).filter((x) => x.s);
  const n = A.length, m = B.length;
  const L: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out: WDiff = [];
  const push = (t: "eq" | "del" | "ins", tok: string) => { const last = out[out.length - 1]; if (last && last.t === t) last.s += tok; else out.push({ t, s: tok }); };
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { push("eq", A[i]); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) push("del", A[i++]);
    else push("ins", B[j++]);
  }
  while (i < n) push("del", A[i++]);
  while (j < m) push("ins", B[j++]);
  return out;
}

const REWRITE_RE = /^\s*rewrite:\s*/i;
const isRewrite = (body: string) => REWRITE_RE.test(body) && !/^\s*rewrite:\s*see\b/i.test(body);

export type Suggestion = DraftCommentSuggestion & { derived?: boolean };

const OWN_DRAFTING_CHUNKS: string[] = (() => {
  try {
    const m = document.querySelector('script[type="importmap"]');
    const j = m ? JSON.parse(m.textContent || "{}") : {};
    return Object.values((j && j.imports) || {}).map((v) => String(v).replace(/^\//, ""))
      .filter((n) => /^Drafting\.[0-9a-f]{6,10}\.js$/.test(n));
  } catch { return []; }
})();
export async function draftingCodeStale(): Promise<boolean> {
  if (!OWN_DRAFTING_CHUNKS.length) return false;
  const ac = new AbortController();
  const t = window.setTimeout(() => ac.abort(), 1500);
  try {
    const r = await window.fetch("/surface", { cache: "no-store", credentials: "same-origin", signal: ac.signal });
    if (!r.ok) return false;
    const s = await r.json() as { chunks?: { name?: string }[] };
    const live = Array.isArray(s?.chunks) ? s.chunks.map((c) => String(c?.name || "")) : [];
    if (!live.some((n) => n.startsWith("Drafting."))) return false;
    return OWN_DRAFTING_CHUNKS.some((n) => !live.includes(n));
  } catch { return false; } finally { window.clearTimeout(t); }
}
async function refuseAcceptIfStale(): Promise<boolean> {
  if (!(await draftingCodeStale())) return false;
  toast.error("All-in-One Academic was updated since this tab opened: reload, then accept", {
    id: "cmt-accept-stale", duration: 20000, action: { label: "Reload", onClick: () => reloadForUpdate() } });
  return true;
}
export function effectiveSuggestion(c: { suggestion?: DraftCommentSuggestion; replies?: DraftCommentReply[]; resolved?: boolean }): Suggestion | null {
  if (c.suggestion) return c.suggestion;
  const r0 = c.replies?.[0];
  if (!c.resolved && r0 && isRewrite(r0.body)) return { proposed: r0.body.replace(REWRITE_RE, "").trim(), status: "open", derived: true };
  return null;
}

const SUG_ADD_RE = /(?<!\[)\[(?!\[|XX\]|NEEDS CITE)[^[\]\n]+\](?![[(:\]])/g;
/** An accepted or rejected suggestion: its card is a record and never re-anchors or drops. */
export function isDecidedSuggestion(c: { suggestion?: { status: string } }): boolean {
  return !!c.suggestion && c.suggestion.status !== "open";
}

function ProposedText({ proposed, diff }: { proposed: string; diff: { t: string; s: string }[] }) {
  if (!proposed) return <span data-sug-cut title="Accept removes the struck text" className="italic text-muted-foreground">cut</span>;
  const addCls = "rounded-[3px] bg-primary/20 px-[1px] font-medium text-foreground no-underline shadow-[inset_0_-1.5px_0_hsl(var(--primary)/0.75)] [box-decoration-break:clone]";
  const runs: ReactNode[] = [];
  let last = 0, k = 0;
  for (const m of proposed.matchAll(SUG_ADD_RE)) {
    const at = m.index ?? 0;
    if (at > last) runs.push(<span key={k++}>{proposed.slice(last, at)}</span>);
    runs.push(<ins key={k++} data-diff="ins" data-sug-add className={addCls}>{m[0]}</ins>);
    last = at + m[0].length;
  }
  if (runs.length) {
    if (last < proposed.length) runs.push(<span key={k++}>{proposed.slice(last)}</span>);
    return <>{runs}</>;
  }
  return <>{diff.map((d, i) => d.t === "eq" ? <span key={i}>{d.s}</span>
    : d.t === "ins" ? <ins key={i} data-diff="ins" className={addCls}>{d.s}</ins> : null)}</>;
}

const THREAD_KEY = "all_in_one_academic:cmt-thread:";
function readThreadOpen(id?: string): boolean {
  if (!id) return false;
  try { return localStorage.getItem(THREAD_KEY + id) === "1"; } catch { return false; }
}
function writeThreadOpen(id: string | undefined, open: boolean) {
  if (!id) return;
  try { if (open) localStorage.setItem(THREAD_KEY + id, "1"); else localStorage.removeItem(THREAD_KEY + id); } catch { /* storage blocked */ }
}

// The rail's sort orders. "pos" (document order, beside the text) is the default; the rest
// lay the rail out as a list. Ties always fall back to document order.
const CMT_SORT_KEY = "all_in_one_academic:cmt-sort";
const CMT_SORTS = ["pos", "new", "author", "open", "outline", "outline-only", "outline-hide"] as const;
type CmtSort = typeof CMT_SORTS[number];
const CMT_SORT_LABEL: Record<CmtSort, string> = { pos: "In order", new: "Newest", author: "Author / kind", open: "Open first",
  outline: "Outline first", "outline-only": "Outline only", "outline-hide": "No outline" };
const isOutlineFilter = (v: CmtSort) => v === "outline-only" || v === "outline-hide";
function sortComments<T extends { created: number; author?: string; kind?: string; resolved?: boolean; outline?: boolean }>(list: T[], by: CmtSort): T[] {
  if (by === "pos" || isOutlineFilter(by)) return list;
  const idx = new Map(list.map((c, i) => [c, i] as const));   // list arrives in document order
  const kindRank = (k?: string) => (k === "flag" ? 0 : k === "figure" ? 2 : 1);
  const who = (a?: string) => (!a || a === "owner" ? "" : a);
  return [...list].sort((a, b) => {
    const d = by === "new" ? (b.created || 0) - (a.created || 0)
      : by === "open" ? Number(!!a.resolved) - Number(!!b.resolved)
      : by === "outline" ? Number(!a.outline) - Number(!b.outline)
      : who(a.author).localeCompare(who(b.author)) || kindRank(a.kind) - kindRank(b.kind);
    return d || idx.get(a)! - idx.get(b)!;
  });
}

/** **bold** and `code` inside one reply line; everything else is plain text. */
function inlineMd(s: string): ReactNode {
  return s.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((p, i) =>
    p.length > 4 && p.startsWith("**") && p.endsWith("**") ? <strong key={i} className="font-semibold text-foreground">{p.slice(2, -2)}</strong>
      : p.length > 2 && p.startsWith("`") && p.endsWith("`") ? <code key={i} className="rounded bg-muted px-0.5 text-[11px]">{p.slice(1, -1)}</code>
        : p);
}

/** A reply, markdown-ish: blank lines split paragraphs, "> " lines are a quoted passage
 * (verbatim reviewer text), "- " / "1. " lines hang as a list. */
function ReplyBody({ text }: { text: string }) {
  const blocks = text.replace(/\r\n/g, "\n").trim().split(/\n\s*\n/);
  return (
    <div className="space-y-1.5 break-words">
      {blocks.map((b, i) => (
        <div key={i}>
          {b.split("\n").map((ln, j) => {
            const q = /^\s*>\s?(.*)$/.exec(ln);
            if (q) return <div key={j} className="border-l-2 border-primary/35 pl-1.5 italic text-foreground/75">{inlineMd(q[1])}</div>;
            const li = /^\s*([-*•]|\d+[.)])\s+(.*)$/.exec(ln);
            if (li) return (
              <div key={j} className="flex gap-1 pl-1">
                <span className="shrink-0 text-muted-foreground nums">{/\d/.test(li[1]) ? li[1] : "•"}</span>
                <span className="min-w-0">{inlineMd(li[2])}</span>
              </div>);
            return <div key={j}>{inlineMd(ln)}</div>;
          })}
        </div>
      ))}
    </div>
  );
}

const sameAnchor = (a: CRange, b: CRange) => a.from < b.to && b.from < a.to;

function commentAsText(c: CommentCardData): string {
  const quote = (c.quote || "").trim();
  const body = (c.body || "").trim();
  const thread = (c.replies || [])
    .map((r) => (r.author === "owner" ? "the user: " : "Agent: ") + r.body.trim())
    .join("\n");
  const parts = [body, thread].filter(Boolean).join("\n\n");
  if (!quote) return parts;
  return quote.split("\n").map((l) => "> " + l).join("\n") + "\n\n" + parts;
}

// Half-typed replies in Review > Focus survive a paragraph switch (which unmounts the
// card): kept per comment id in memory and, when the browser allows, localStorage.
const replyDraftMem = new Map<string, string>();
const replyDraftKey = (id: string) => "all_in_one_academic:reply-draft:" + id;
function readReplyDraft(id: string): string {
  if (!id) return "";
  const m = replyDraftMem.get(id);
  if (m !== undefined) return m;
  try { return localStorage.getItem(replyDraftKey(id)) || ""; } catch { return ""; }
}
function writeReplyDraft(id: string, v: string) {
  if (!id) return;
  if (v) replyDraftMem.set(id, v); else replyDraftMem.delete(id);
  try { if (v) localStorage.setItem(replyDraftKey(id), v); else localStorage.removeItem(replyDraftKey(id)); } catch { /* private window: memory only */ }
}

export function AnchoredCommentCard({ comment, active, orphaned, registerRef, onActivate, onBody, onResolve, onDelete, onReply, onLayoutChange, staticLayout, num, hidden, replyTick, onEscapeToText, escapeTo, onWalk, stack, threadsAll, onLocate, solo, pinned, onPin, onOpenChange, onAccept, onReject, onProposed, onUseRewrite, onReattach, sugBase, acceptError, fullyExpanded = false }: {
  // a detached (or orphaned) card: anchor it to the text selected in the manuscript
  onReattach?: () => void;
  escapeTo?: () => void;
  fullyExpanded?: boolean; // Focus shows the whole note and thread, without a card fold
  onAccept?: () => void; onReject?: () => void; onProposed?: (v: string) => void;
  // the text Accept will replace (phrase, sentence or paragraph; suggestSpan), for the diff
  sugBase?: string;
  // why the last Accept did not apply; the card stays open and says so
  acceptError?: string;
  // a "Rewrite:" reply becomes this comment's suggested change
  onUseRewrite?: (replyBody: string) => void;
  pinned?: boolean; onPin?: () => void;
  // the card is open (whole comment shown, or a box open in it): the pinned dock grows for it
  onOpenChange?: (open: boolean) => void;
  // the rail header's expand-all / collapse-all: any change of `n` sets every card to
  // `open` (and remembers it per card)
  threadsAll?: { open: boolean; n: number };
  onLocate?: () => void;
  // this card is the soloed one (a click on its highlight): shown whole while it is
  solo?: boolean;
  comment: CommentCardData; active: boolean; orphaned: boolean; registerRef: (el: HTMLDivElement | null) => void;
  onActivate: (e: React.MouseEvent) => void; onBody: (v: string) => void; onResolve: () => void; onDelete: () => void;
  // reply into the thread. Omitted in read-only contexts (the Publish PDF rail), where
  // the card renders any existing thread but offers no composer.
  onReply?: (body: string) => void;
  onLayoutChange: () => void;
  // bumped by the host to open this card's composer from outside (⌘⏎ in the manuscript
  // with the caret inside this comment's anchor). Any change of the number opens it.
  replyTick?: number;
  // Escape on the card itself hands the caret back to the sentence the comment is about.
  // Omitted in read-only contexts, where Escape belongs to whatever is around the card.
  onEscapeToText?: () => void;
  onWalk?: (dir: -1 | 1, held: boolean) => void;
  // where this comment sits among the ones on the SAME passage (1-based), when there is
  // more than one. Shown as a counter chip so the stack is visible, never explained.
  stack?: { i: number; n: number };
  staticLayout?: boolean;
  // the figure-rect overlay number this comment pairs with (open figure comments only)
  num?: number;
  // solo mode (a click on a highlight) shows ONE card; the rest stay MOUNTED but out of
  // sight so an in-progress body or reply draft in another card is not thrown away.
  hidden?: boolean;
}) {
  const sug = useMemo(() => effectiveSuggestion(comment), [comment]);
  const sugOpen = sug?.status === "open";
  // Only a comment made just now opens on its note box; an empty one loaded from disk must
  // not take the keyboard from the manuscript.
  const [editing, setEditing] = useState(!comment.body && !sug && Date.now() - (comment.created || 0) < 5000);
  // a reply draft kept from before a paragraph switch reopens its box (without taking focus)
  const restoredDraft = useRef(!!escapeTo && !!onReply && !!readReplyDraft(comment.id ?? ""));
  const [replying, setReplying] = useState(restoredDraft.current);
  const [editingSug, setEditingSug] = useState(false);
  const [showOrig, setShowOrig] = useState(() => sugOpen && (!sug!.proposed || ((sugBase ?? sug!.original ?? comment.quote ?? "").length <= 400)));
  const sugRef = useRef<HTMLTextAreaElement>(null);
  const sugDiff = useMemo(() => sug ? wordDiff((sugOpen && sugBase) || sug.original || comment.quote || "", sug.proposed) : [], [sug, sugOpen, sugBase, comment.quote]);
  const [threadOpen, setThreadOpenRaw] = useState(() => readThreadOpen(comment.id));
  const setThreadOpen = (open: boolean) => { setThreadOpenRaw(open); writeThreadOpen(comment.id, open); };
  // a card soloed from its highlight is shown whole; leaving solo restores what was stored
  const soloSeen = useRef(!!solo);
  useEffect(() => {
    if (soloSeen.current === !!solo) return;
    soloSeen.current = !!solo;
    setThreadOpenRaw(solo ? true : readThreadOpen(comment.id));
  }, [solo, comment.id]);
  const seenAll = useRef(threadsAll?.n ?? 0);
  useEffect(() => {
    const n = threadsAll?.n ?? 0;
    if (n === seenAll.current) return;
    seenAll.current = n;
    setThreadOpen(!!threadsAll?.open);
  }, [threadsAll?.n]);   // eslint-disable-line react-hooks/exhaustive-deps
  const taRef = useRef<HTMLTextAreaElement>(null);
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useCallback((el: HTMLDivElement | null) => { rootRef.current = el; registerRef(el); }, [registerRef]);
  // leaving a textarea by keyboard lands on the card, not on the page body (in Focus: on
  // the layer, the next rung of its Esc ladder)
  const backToCard = () => { if (escapeTo) { escapeTo(); return; } requestAnimationFrame(() => rootRef.current?.focus({ preventScroll: true })); };
  const replies = comment.replies || [];
  const bodyText = (comment.body || "").trim();
  const headline = bodyText.split("\n")[0];
  // anything the collapsed card does not show: more lines, a long first line (clamped to
  // two), or a thread. A proposal is never part of it: it always shows whole.
  const hasMore = replies.length > 0 || bodyText.includes("\n") || headline.length > 90;
  const expanded = fullyExpanded || (threadOpen && hasMore);
  const clickTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(clickTimer.current), []);
  const selectionInCard = () => {
    const s = window.getSelection();
    return !!s && !s.isCollapsed && !!rootRef.current && !!s.anchorNode && rootRef.current.contains(s.anchorNode);
  };
  const deferClick = (e: React.MouseEvent, fn: () => void) => {
    window.clearTimeout(clickTimer.current);
    if (e.detail > 1 || selectionInCard()) return;
    clickTimer.current = window.setTimeout(() => { if (!selectionInCard()) fn(); }, 200);
  };
  // the composer is closing on purpose (sent, or cancelled): the blur that follows must
  // not send a second time, and an Escape must not send at all.
  const closingReply = useRef(false);
  const sendReply = () => {
    const v = (replyRef.current?.value || "").trim();
    closingReply.current = true;
    setReplying(false);
    if (v && onReply) { onReply(v); setThreadOpen(true); }
    if (escapeTo) writeReplyDraft(comment.id ?? "", "");
    backToCard();
  };
  // Focus keeps a draft when focus moves to the layer or another paragraph. The rail's
  // click-away path still files a reply; Focus sends only through Ctrl/⌘+Enter.
  const blurReply = () => {
    if (closingReply.current) return;
    if (escapeTo) { writeReplyDraft(comment.id ?? "", replyRef.current?.value ?? readReplyDraft(comment.id ?? "")); return; }
    sendReply();
  };
  const cancelReply = () => {
    closingReply.current = true;
    if (escapeTo) writeReplyDraft(comment.id ?? "", replyRef.current?.value ?? readReplyDraft(comment.id ?? ""));
    if (!escapeTo && replyRef.current) replyRef.current.value = "";
    setReplying(false);
    backToCard();
  };
  const isFigure = comment.kind === "figure";
  const isFlag = comment.kind === "flag";
  const isAgent = !!comment.author && comment.author !== "owner";
  const grow = () => { const t = taRef.current; if (!t) return; t.style.height = "auto"; t.style.height = Math.max(24, t.scrollHeight) + "px"; };
  const REPLY_MIN = 80;
  const growReply = () => {
    const t = replyRef.current; if (!t) return;
    const cap = Math.max(REPLY_MIN, Math.round(window.innerHeight * 0.4));
    t.style.height = "auto";
    const chrome = t.offsetHeight - t.clientHeight;          // the borders, so nothing is clipped
    const want = Math.max(REPLY_MIN, t.scrollHeight + chrome);
    t.style.height = Math.min(cap, want) + "px";
    t.style.overflowY = want > cap ? "auto" : "hidden";
    onLayoutChange();
  };
  // preventScroll: opening a box inside the card must never move the rail or the manuscript
  useEffect(() => { if (editing) { grow(); taRef.current?.focus({ preventScroll: true }); } }, [editing]);
  useLayoutEffect(() => {
    if (!replying) return;
    closingReply.current = false;
    const t = replyRef.current;
    if (t && escapeTo && !t.value) t.value = readReplyDraft(comment.id ?? "");
    growReply();
    if (restoredDraft.current) { restoredDraft.current = false; return; }
    t?.focus({ preventScroll: true });
  }, [replying]);   // eslint-disable-line react-hooks/exhaustive-deps
  const openReply = () => { if (replying) replyRef.current?.focus({ preventScroll: true }); else setReplying(true); };
  // the host asking for the composer: ⌘⏎ in the manuscript with the caret in this
  // comment's anchor. Any bump of the number opens the box and puts the caret in it.
  useEffect(() => { if (replyTick) openReply(); }, [replyTick]);   // eslint-disable-line react-hooks/exhaustive-deps
  // the card grows when a thread opens or a reply lands, so the rail must re-run its
  // de-overlap pass or the next card down sits under this one
  const isOpen = expanded || replying || editing || editingSug;
  useEffect(() => { onOpenChange?.(isOpen); }, [isOpen]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { onLayoutChange(); }, [editing, editingSug, showOrig, replying, threadOpen, comment.body, comment.resolved, orphaned, replies.length, sug?.proposed, sug?.status, acceptError, onLayoutChange]);
  const growSug = () => { const t = sugRef.current; if (!t) return; t.style.height = "auto"; t.style.height = Math.min(Math.max(48, t.scrollHeight + 2), Math.round(window.innerHeight * 0.4)) + "px"; onLayoutChange(); };
  useEffect(() => { if (editingSug) { growSug(); sugRef.current?.focus({ preventScroll: true }); } }, [editingSug]);   // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div ref={cardRef} role="button" tabIndex={hidden ? -1 : 0} aria-label="Comment" hidden={hidden}
      data-cmt-card data-cmt-expanded={expanded || replying ? "1" : "0"}
      onMouseDown={(e) => {
        const t = e.target as HTMLElement | null;
        const f = t?.closest?.("button, textarea, input, select, a[href], [tabindex]") as HTMLElement | null;
        if (f && rootRef.current?.contains(f) && document.activeElement !== f) f.focus({ preventScroll: true });
        onActivate(e);
      }}
      // an open reply draft files itself when the focus leaves the CARD (the mouse path),
      // not when it moves within it
      onBlur={(e) => { if (replying && !rootRef.current?.contains(e.relatedTarget as Node | null)) blurReply(); }}
      onKeyDown={(e) => {
        if (e.defaultPrevented) return;
        // Esc on one of the card's own buttons comes back to the card, never up the
        // editor's Esc chain (which would close the editor from inside a comment)
        if (e.target !== e.currentTarget) {
          const t = e.target as HTMLElement;
          if (e.key === "Escape" && !t.matches("textarea, input, select") && (escapeTo || onEscapeToText)) { e.preventDefault(); if (escapeTo) escapeTo(); else rootRef.current?.focus({ preventScroll: true }); }
          return;
        }
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        if (e.key === "ArrowRight" && !e.shiftKey) {
          const r = rootRef.current;
          const into = r?.querySelector<HTMLElement>("[data-cmt-locate]") ?? r?.querySelector<HTMLElement>("[data-cmt-thread-toggle]") ?? r?.querySelector<HTMLElement>('button[title="Resolve"], button[title="Reopen"]');
          if (into) { e.preventDefault(); into.focus({ preventScroll: true }); return; }
        }
        if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !e.shiftKey && onWalk) {
          e.preventDefault(); onWalk(e.key === "ArrowDown" ? 1 : -1, e.repeat); return;
        }
        if (e.key === "r" && !e.shiftKey && onReply) { e.preventDefault(); openReply(); return; }
        if (e.key === "p" && !e.shiftKey && onPin) { e.preventDefault(); onPin(); return; }
        if (e.key === "a" && !e.shiftKey && sugOpen && onAccept) { e.preventDefault(); onAccept(); return; }
        if (e.key === "x" && !e.shiftKey && sugOpen && onReject) { e.preventDefault(); onReject(); return; }
        if (e.key === "o" && !e.shiftKey && sug) { e.preventDefault(); setShowOrig(!showOrig); return; }
        // ⏎ on the card opens / closes its thread (the toggle button is the mouse path)
        if (e.key === "Enter" && !e.shiftKey && hasMore && !replying && !fullyExpanded) { e.preventDefault(); setThreadOpen(!expanded); return; }
        if (e.key === "Escape" && escapeTo) { e.preventDefault(); escapeTo(); return; }
        if (e.key === "Escape" && onEscapeToText) { e.preventDefault(); onEscapeToText(); }
      }}
      // an expanded card FOLDS OVER its neighbours instead of pushing the rail down: the
      // rail lays it out at its collapsed footprint and it paints above the cards below
      className={`group ${staticLayout ? "relative w-full" : "absolute right-0"} rounded-lg border bg-card px-2.5 py-2 shadow-sm transition-[top,box-shadow] duration-150 ${sug ? "border-l-[3px] border-l-primary/70" : ""} ${active ? "border-primary/60 shadow-md ring-1 ring-primary/25" : isFlag ? "border-amber-500/50" : isAgent ? "border-primary/45" : "border-border"} ${!staticLayout && (expanded || replying) ? (active ? "z-30 shadow-lg" : "z-20 shadow-lg") : active ? "z-[15]" : ""} ${comment.resolved && !(expanded || replying) ? "opacity-55" : ""}`}
      style={{ ...(staticLayout ? null : { width: "var(--card-w)" }), ...(hidden ? { display: "none" } : null),
        ...(sug ? { backgroundImage: "linear-gradient(hsl(var(--primary) / 0.06), hsl(var(--primary) / 0.06))" } : null) }}
      data-cmt-rewrite={sug ? sug.status : undefined}>
      {!pinned && <button onClick={(e) => { e.stopPropagation(); onDelete(); }} title="Remove comment"
        className="absolute -top-2 -right-2 z-10 inline-flex items-center justify-center w-5 h-5 rounded-full border border-border bg-card text-muted-foreground shadow-sm opacity-0 group-hover:opacity-100 transition-opacity hover:text-destructive hover:border-destructive/50"><X size={12} /></button>}
      {stack && stack.n > 1 && (
        <div className="mb-1.5 flex items-center">
          <span title="Several comments on this passage — ↓ and ↑ move between them"
            className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/40 px-1.5 py-0.5 text-[9.5px] text-muted-foreground nums">
            <MessageSquare size={9} />{stack.i} / {stack.n} here</span>
        </div>
      )}
      {(isFlag || !!comment.reviewer || !!comment.outline || !!sug) && (
        <div className="mb-1.5 flex flex-wrap items-center gap-1">
          {sug && <span title={sugOpen ? "Proposed rewrite: Accept (a) or Reject (x)" : sug.status === "accepted" ? "Rewrite accepted" : "Rewrite rejected"} data-cmt-suggest-status={sug.status}
            className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9.5px] font-medium ${sugOpen ? "border-primary/40 bg-background text-primary" : "border-border bg-muted/50 text-muted-foreground"}`}>
            <Replace size={9} />Rewrite{sugOpen ? "" : " · " + sug.status}</span>}
          {sug && (
            <button type="button" data-cmt-orig-toggle aria-expanded={showOrig}
              onClick={(e) => { e.stopPropagation(); setShowOrig(!showOrig); }}
              onKeyDown={(e) => { if (e.key === "Escape" && showOrig) { e.preventDefault(); e.stopPropagation(); setShowOrig(false); } }}
              title={showOrig ? "Hide the text it replaces (o)" : "Show the text it replaces (o)"}
              className={`inline-flex items-center gap-0.5 rounded-full border px-1.5 py-0.5 text-[9.5px] font-medium focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50 ${showOrig ? "border-primary/40 bg-primary/10 text-foreground" : "border-border bg-background text-muted-foreground hover:text-foreground"}`}>
              {showOrig ? <ChevronDown size={9} /> : <ChevronRight size={9} />}Original</button>
          )}
          {comment.outline && <span title="Outline" data-cmt-outline
            className="inline-flex items-center rounded-full border border-primary/40 bg-background px-1.5 py-0.5 text-primary"><ListOrdered size={9} /></span>}
          {comment.reviewer && <span title={`Raised by ${comment.reviewer === "Editor" || comment.reviewer === "AE" ? "the " + comment.reviewer : "reviewer " + comment.reviewer.slice(1)}`}
            data-cmt-reviewer={comment.reviewer}
            className="inline-flex items-center rounded-full border border-border bg-muted/50 px-1.5 py-0.5 text-[9.5px] font-semibold tracking-wide text-foreground/80 nums">{comment.reviewer}</span>}
          {isFlag && <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 border border-amber-500/40 px-1.5 py-0.5 text-[9.5px] uppercase tracking-wide text-amber-700 dark:text-amber-400"><AlertTriangle size={9} /> {comment.focusFlag === true ? "flagged" : "auto-flagged"}</span>}
        </div>
      )}
      {isFigure && (
        <div className="mb-1.5 flex items-center gap-1 text-[10px] text-muted-foreground/80">
          {num != null && <span className="shrink-0 inline-flex items-center justify-center min-w-[16px] h-[16px] px-1 rounded-full bg-amber-500 text-white text-[9.5px] font-semibold nums" title="Pairs with overlay #on the figure">{num}</span>}
          {/\.(csv|md|txt)(\|[^\]]*)?\]\]/i.test(comment.quote || "") ? <ListOrdered size={10} /> : <ImageIcon size={10} />}
          <span className="truncate">{comment.quote}</span>
          {comment.rectPct && <span className="shrink-0 text-primary/70">· region</span>}
        </div>
      )}
      {isFigure && comment.provenance?.scriptRel && (
        <div className="mb-1.5 text-[10px] text-muted-foreground/60 truncate" title={comment.provenance.scriptRel}>from {comment.provenance.scriptRel}</div>
      )}
      {orphaned && (
        <div className="mb-1.5 flex items-center gap-2 text-[10px] text-amber-600/90 leading-snug" data-cmt-detached>
          <span className="min-w-0 flex-1" title="Its text is no longer in the draft. The comment stays until you delete it.">{comment.detached ? "Detached: its text was deleted" : "Its text no longer matches"}</span>
          {onReattach && (
            <button type="button" data-cmt-reattach onClick={(e) => { e.stopPropagation(); onReattach(); }}
              title="Select text in the draft, then attach this comment to it"
              className="shrink-0 inline-flex items-center gap-1 rounded border border-amber-600/40 px-1.5 py-0.5 text-[10px] text-amber-700 dark:text-amber-400 hover:bg-amber-500/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50">
              <Link2 size={10} /> Attach to selection</button>
          )}
        </div>
      )}
      {editing ? (
        <textarea ref={taRef} defaultValue={comment.body} onInput={grow} data-knav-own="arrows enter escape"
          onBlur={(e) => { onBody(e.target.value); setEditing(false); }}
          onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); (e.target as HTMLTextAreaElement).blur(); backToCard(); } }}
          placeholder="Your comment…" spellCheck
          className={`w-full resize-none rounded-md border border-border bg-background px-2 py-1 ${fullyExpanded ? "text-[15px] leading-relaxed" : "text-[12.5px]"} focus:outline-none focus:border-primary/50`} />
      ) : (
        <div className="flex items-start gap-1.5">
          <span className="mt-[5px] shrink-0 inline-block w-2 h-2 rounded-full" style={{ backgroundColor: orphaned ? "hsl(var(--muted-foreground))" : isAgent ? "hsl(var(--primary))" : "hsl(45 90% 50%)" }} title={orphaned ? "the anchored text changed — re-attach or resolve" : isAgent ? "anchored comment from an agent" : "anchored comment"} />
          <div role="button" tabIndex={0} aria-label={expanded || !hasMore ? "Edit comment" : "Show the whole comment"} data-cmt-topline
            className={`min-w-0 flex-1 ${fullyExpanded ? "text-[15px] leading-relaxed" : "text-[13px] leading-snug"} font-medium text-foreground break-words cursor-text ${expanded ? "whitespace-pre-wrap" : "line-clamp-2"}`}
            onClick={(e) => deferClick(e, () => { if (expanded || !hasMore) setEditing(true); else setThreadOpen(true); })}>
            {bodyText ? (expanded ? comment.body : headline) : <span className="font-normal text-muted-foreground/60 italic">{sug ? "suggested change" : "add a comment…"}</span>}</div>
          <div className="-mr-1 flex shrink-0 items-center gap-0.5">
            {sugOpen && onAccept && (
              <button type="button" data-cmt-accept onClick={(e) => { e.stopPropagation(); onAccept(); }}
                title="Accept change (a)"
                className="inline-flex h-5 w-5 items-center justify-center rounded text-primary hover:bg-primary/15 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50">
                <Check size={12} /></button>
            )}
            {sugOpen && onReject && (
              <button type="button" data-cmt-reject onClick={(e) => { e.stopPropagation(); onReject(); }}
                title="Reject change (x)"
                className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50">
                <X size={12} /></button>
            )}
            {onPin && (
              <button type="button" data-cmt-pin aria-pressed={!!pinned} onClick={(e) => { e.stopPropagation(); onPin(); }}
                title={pinned ? "Unpin (p)" : "Pin beside you while you scroll (p)"}
                className={`inline-flex h-5 w-5 items-center justify-center rounded hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50 ${pinned ? "text-primary" : "text-muted-foreground hover:text-foreground"}`}>
                {pinned ? <PinOff size={11} /> : <Pin size={11} />}</button>
            )}
            {onLocate && (
              <button type="button" data-cmt-locate onClick={(e) => { e.stopPropagation(); onLocate(); }}
                title="Show beside its text"
                className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50">
                <LocateFixed size={11} /></button>
            )}
            {hasMore && !fullyExpanded && (
              <button type="button" data-cmt-thread-toggle aria-expanded={expanded}
                onClick={(e) => { e.stopPropagation(); setThreadOpen(!expanded); }}
                // Esc on an open toggle folds the card and keeps the keys here; closed, it
                // falls through to the card's own Esc path untouched
                onKeyDown={(e) => { if (e.key === "Escape" && expanded) { e.preventDefault(); e.stopPropagation(); setThreadOpen(false); } }}
                title={expanded ? "Collapse to the main point (Esc)" : replies.length ? `Show the whole comment and ${replies.length} ${replies.length === 1 ? "reply" : "replies"} (Enter)` : "Show the whole comment (Enter)"}
                className="inline-flex h-5 items-center gap-0.5 rounded px-1 text-[10.5px] text-muted-foreground hover:text-foreground hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50 nums">
                {replies.length > 0 && <><MessageSquare size={10} /><span data-cmt-reply-count>{replies.length}</span></>}
                {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              </button>
            )}
          </div>
        </div>
      )}
      {sug && (editingSug ? (
        <textarea ref={sugRef} defaultValue={sug.proposed} data-cmt-suggest-edit data-knav-own="arrows enter escape" spellCheck
          onInput={growSug}
          onBlur={(e) => { const v = e.target.value; setEditingSug(false); if (v !== sug.proposed) onProposed?.(v); }}
          onKeyDown={(e) => {
            if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) { e.preventDefault(); (e.target as HTMLTextAreaElement).blur(); backToCard(); }
          }}
          className="mt-1.5 w-full resize-none rounded-md border border-primary/40 bg-background px-2.5 py-2 text-[14px] leading-[1.55] focus:outline-none focus:border-primary/60"
          style={{ fontFamily: SERIF }} />
      ) : (<>
        {/* the text it replaces, above the proposal so the eye reads old then new; the words
            the proposal drops are marked */}
        {showOrig && (
          <div data-cmt-original className="mt-1.5 rounded-md border border-dashed border-border bg-muted/30 px-2.5 py-2 text-[13px] leading-[1.5] text-muted-foreground break-words whitespace-pre-wrap"
            style={{ fontFamily: SERIF }}>
            {sugDiff.map((d, i) => d.t === "eq" ? <span key={i}>{d.s}</span>
              : d.t === "del" ? <del key={i} data-diff="del" className="text-foreground/80 bg-destructive/10 decoration-destructive/60">{d.s}</del> : null)}
          </div>
        )}
        {/* the proposal, whole: never clamped, never scrolled inside the card */}
        <div role="button" tabIndex={0} data-cmt-suggestion aria-label={sugOpen && onProposed ? "Edit the proposed text" : "Suggested change"}
          title={sugOpen && onProposed ? "Edit the proposed text (Enter)" : undefined}
          onClick={(e) => { e.stopPropagation(); if (sugOpen && onProposed) deferClick(e, () => setEditingSug(true)); }}
          onKeyDown={(e) => { if (e.key === "Enter" && sugOpen && onProposed) { e.preventDefault(); e.stopPropagation(); setEditingSug(true); } }}
          className={`mt-1.5 rounded-md border border-border/70 bg-background px-2.5 py-2 text-[14px] leading-[1.55] text-foreground break-words whitespace-pre-wrap focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50 ${sugOpen && onProposed ? "cursor-text" : ""}`}
          style={{ fontFamily: SERIF }}>
          <ProposedText proposed={sug.proposed} diff={sugDiff} />
        </div>
      </>))}
      {sugOpen && acceptError && (
        <div role="alert" data-cmt-accept-error className="mt-1.5 flex items-start gap-1 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1 text-[12px] leading-snug text-destructive">
          <AlertTriangle size={11} className="mt-[2px] shrink-0" /><span>{acceptError}</span></div>
      )}
      {((replies.length > 0 && expanded) || replying) && (
        <div data-cmt-thread className="mt-1.5 space-y-2 border-l-2 border-border/70 pl-2">
          {expanded && replies.map((r, ri) => (
            <div key={r.id} className={`${fullyExpanded ? "text-[14px] leading-relaxed" : "text-[12px] leading-snug"} text-foreground/85`}>
              <div className={`mb-0.5 flex items-center gap-1 text-[9.5px] uppercase tracking-wide ${r.author === "owner" ? "text-amber-600 dark:text-amber-400" : "text-primary"}`}
                title={r.author === "owner" ? undefined : "An agent"}>
                {r.author === "owner" ? "the user" : <Bot size={9} />}
                {onUseRewrite && isRewrite(r.body) && sug?.status !== "accepted" && !(ri === 0 && sug?.derived) && (
                  <button type="button" data-cmt-use-rewrite onClick={(e) => { e.stopPropagation(); onUseRewrite(r.body); }}
                    title="Use as change"
                    className="ml-auto inline-flex h-4 w-4 items-center justify-center rounded normal-case text-muted-foreground hover:text-primary hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50">
                    <Replace size={10} /></button>
                )}
              </div>
              <ReplyBody text={r.body} />
            </div>
          ))}
          {replying && (
            <textarea ref={replyRef} rows={3} placeholder="Reply… Ctrl+Enter sends"
              // data-knav-own: the arrow engine never arms this box, so ←↑↓→ move the
              // caret, ⏎ makes a new line, and neither is spent navigating out of it.
              data-knav-own="arrows enter escape"
              // the click-away send fires only when the focus LEAVES the card: selecting a
              // reply above to copy it, or pressing the card's own buttons, keeps the draft
              onBlur={(e) => { if (rootRef.current?.contains(e.relatedTarget as Node | null)) return; blurReply(); }}
              onInput={(e) => { growReply(); if (escapeTo) writeReplyDraft(comment.id ?? "", (e.target as HTMLTextAreaElement).value); }}
              onPaste={() => requestAnimationFrame(growReply)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendReply(); return; }
                if (e.key === "Escape") { e.preventDefault(); cancelReply(); }
              }}
              spellCheck
              style={{ minHeight: REPLY_MIN }}
              className="w-full resize-none rounded-md border border-border bg-background px-2.5 py-1.5 text-[13px] leading-snug focus:outline-none focus:border-primary/50" />
          )}
        </div>
      )}
      <div className="mt-1.5 flex items-center gap-3 text-[10.5px] text-muted-foreground/70">
        <button onClick={(e) => { e.stopPropagation(); onResolve(); }} className="inline-flex items-center gap-1 hover:text-foreground" title={comment.resolved ? "Reopen" : "Resolve"}>
          {comment.resolved ? <RotateCcw size={11} /> : <CheckCheck size={11} />}{comment.resolved ? "Reopen" : "Resolve"}
        </button>
        {onReply && (
          <button onClick={(e) => { e.stopPropagation(); openReply(); }} className="inline-flex items-center gap-1 hover:text-foreground"
            title="Reply — tell the agent whether you disagree and why, so it adjusts instead of re-filing the same note. Press r on the card, or ⌘⏎ in the highlighted text.">
            <CornerDownRight size={11} /> Reply{replies.length ? ` (${replies.length})` : ""}</button>
        )}
        <button onClick={(e) => { e.stopPropagation(); copyToClipboard(commentAsText(comment), "Comment copied"); }}
          className="inline-flex items-center gap-1 hover:text-foreground" title="Copy the highlighted text and this comment — paste it to a co-author"><Copy size={11} /> Copy</button>
        <button onClick={(e) => { e.stopPropagation(); if (!pinned) onDelete(); }} disabled={pinned} aria-disabled={pinned}
          className={`inline-flex items-center gap-1 ${pinned ? "cursor-not-allowed opacity-40" : "hover:text-destructive"}`} title={pinned ? "Unpin to delete" : "Delete comment"}><Trash2 size={11} /> Delete</button>
        <span className="ml-auto inline-flex items-center gap-1.5">
          {isAgent && <span title="Left by an agent" data-cmt-agent
            className="inline-flex items-center rounded-full bg-primary/15 border border-primary/40 px-1 py-px text-primary"><Bot size={9} /></span>}
          <span className="nums">{relAgo(comment.updated || comment.created)}</span></span>
      </div>
    </div>
  );
}

function DiffModal({ oldText, newText, onClose }: { oldText: string; newText: string; onClose: () => void }) {
  const rows = useMemo(() => compactDiff(lineDiff(oldText, newText), 2), [oldText, newText]);
  const counts = useMemo(() => diffCounts(lineDiff(oldText, newText)), [oldText, newText]);
  useEffect(() => { const h = (e: KeyboardEvent) => { if (e.key === "Escape") { if (typingEscape(e)) return; e.preventDefault(); e.stopPropagation(); onClose(); } }; window.addEventListener("keydown", h, true); return () => window.removeEventListener("keydown", h, true); }, [onClose]);
  return createPortal(
    <div role="dialog" aria-modal="true" aria-label="What changed on disk" data-knav-modal className="fixed inset-0 z-[160] bg-background/95 flex flex-col animate-in fade-in duration-150">
      <div className="shrink-0 flex items-center gap-2 px-4 py-2 border-b border-border">
        <GitCompare size={15} className="text-primary" />
        <span className="text-[13px] font-medium">What changed on disk</span>
        <span className="text-muted-foreground text-[12px]">+{counts.added}/−{counts.removed} lines</span>
        <span className="flex-1" />
        <button type="button" data-knav-back="2" onClick={onClose} className="inline-flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground"><X size={15} /> Close</button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 font-mono text-[12px] leading-relaxed">
        {rows.map((r, i) => (
          <div key={i} className={r.t === "add" ? "bg-green-500/10 text-green-700 dark:text-green-400" : r.t === "del" ? "bg-red-500/10 text-red-700 dark:text-red-400" : "text-muted-foreground/70"}>
            <span className="select-none opacity-50 mr-2">{r.t === "add" ? "+" : r.t === "del" ? "−" : " "}</span>{r.text || " "}
          </div>
        ))}
      </div>
    </div>, document.body);
}

function StatusTag({ status, dirty }: { status: Status; dirty: boolean }) {
  const label = status === "saving" ? "saving…" : dirty ? "unsaved" : status === "saved" ? "saved" : status === "error" ? "retry…" : "";
  if (!label) return null;
  return <span className="text-[11px] nums" style={{ color: status === "saved" && !dirty ? "hsl(var(--primary))" : status === "error" ? "hsl(var(--destructive))" : "hsl(var(--muted-foreground))" }}>{label}</span>;
}

function IconBtn({ onClick, title, on, children, disabled }: { onClick: () => void; title: string; on?: boolean; children: React.ReactNode; disabled?: boolean }) {
  return <button onClick={onClick} title={title} disabled={disabled} className={`inline-flex items-center justify-center rounded-md w-7 h-7 transition-colors disabled:opacity-40 ${on ? "bg-primary/12 text-primary" : "text-muted-foreground hover:text-foreground hover:bg-accent"}`}>{children}</button>;
}

/** A glyph for each manuscript type (paper / op-ed / dissertation / proposal). */
function KindIcon({ kind, size = 12 }: { kind: string; size?: number }) {
  if (kind === "oped") return <Newspaper size={size} />;
  if (kind === "dissertation") return <GraduationCap size={size} />;
  if (kind === "proposal") return <ScrollText size={size} />;
  if (kind === "readme") return <BookOpen size={size} />;
  if (kind === "plan") return <FlaskConical size={size} />;
  if (kind === "project") return <Compass size={size} />;
  return <FileText size={size} />;
}

type CiteMode = "paren" | "narrative" | "quote";
const CITE_MODES: CiteMode[] = ["paren", "narrative", "quote"];
const authorOf = (h: CiteHit) => (h.intext || h.author || h.citekey || h.stem || "").trim();
const yearOf = (h: CiteHit) => (h.year == null ? "" : String(h.year) + (h.suffix || ""));
const nQuotesOf = (h: CiteHit) => h.nQuotes ?? h.quotes.length;
const nKeyPointsOf = (h: CiteHit) => h.nKeyPoints ?? h.keyPoints.length;
// what an inserted citation looks like, for the live preview + the actual insert.
// "quote" falls back to a parenthetical cite (the quote drill-down builds the real text).
function citeText(h: CiteHit, mode: CiteMode): string {
  const a = authorOf(h), y = yearOf(h);
  return mode === "narrative" ? `${a} (${y})` : `(${a}${y ? " " + y : ""})`;
}
// an ASA page-cited quote: "the exact words" (Author Year:page) — page from the note,
// dropped only when the source genuinely has none (web clippings). Editable as plain text.
function asaQuote(h: CiteHit, q: CiteQuote): string {
  const a = authorOf(h), y = yearOf(h);
  const inner = [a, y].filter(Boolean).join(" ") + (q.page ? `:${q.page}` : "");
  const text = q.text.replace(/^["“”'‘’]+|["“”'‘’]+$/g, "").trim();
  return `"${text}" (${inner})`;
}
// publisher / domain label for a web clipping source URL
function sourceLabel(url: string): string {
  const m = /https?:\/\/([^/\s]+)/.exec(url || "");
  return m ? m[1].replace(/^www\./, "") : "";
}

function citeSortKey(token: string): string {
  const m = /^(.*?)[\s,]+((?:1[6-9]\d\d|20\d\d)[a-z]?)\s*$/.exec(token.trim());
  const author = (m ? m[1] : token).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  return author + "|" + (m ? m[2] : "");
}
const sortCiteTokens = (tokens: string[]): string[] =>
  [...tokens].sort((a, b) => citeSortKey(a).localeCompare(citeSortKey(b)));

const MODE_PILLS: [CiteMode, string, string][] = [
  ["paren", "( )", "Parenthetical — (Author Year)"],
  ["narrative", "Author ( )", "Narrative — Author (Year)"],
  ["quote", "“ ”", "Quote — browse the source’s quotes and insert one in ASA style"],
];

function MentionSearch({ info, hits, sel, mode, loading, level, drillHit, quoteSel, pending, onMode, onPickHit, onHover, onAddAnother, onDropPending, onCommitGroup, onPickQuote, onHoverQuote, onBack }:
{ info: MentionInfo; hits: CiteHit[]; sel: number; mode: CiteMode; loading: boolean; level: 0 | 1; drillHit: CiteHit | null; quoteSel: number; pending: CiteHit[];
  onMode: (m: CiteMode) => void; onPickHit: (h: CiteHit) => void; onHover: (i: number) => void; onAddAnother: (h: CiteHit) => void; onDropPending: (i: number) => void; onCommitGroup: () => void; onPickQuote: (i: number) => void; onHoverQuote: (i: number) => void; onBack: () => void }) {
  const selRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { selRef.current?.scrollIntoView({ block: "nearest" }); }, [sel, quoteSel, level]);   // keep the keyboard pick visible
  const W = 416, M = 12, PREFER = 320;
  const left = Math.max(M, Math.min(info.left - 16, window.innerWidth - W - M));
  const spaceBelow = window.innerHeight - info.bottom - M;
  const spaceAbove = info.top - M;
  const placeBelow = spaceBelow >= PREFER || spaceBelow >= spaceAbove;
  const maxH = Math.min(480, Math.max(180, placeBelow ? spaceBelow : spaceAbove));
  const pos: React.CSSProperties = placeBelow
    ? { top: info.bottom + 6, left, width: W, maxHeight: maxH }
    : { bottom: Math.max(M, window.innerHeight - info.top + 6), left, width: W, maxHeight: maxH };
  const q = info.query.trim();
  const active = level === 0 ? (hits[sel] ?? null) : null;
  const drilling = level === 1 && drillHit;
  const selQ: CiteQuote | null = drilling ? (drillHit!.quotes[quoteSel] ?? null) : null;

  return createPortal(
    <div data-cite-picker data-cite-level={level} className="fixed z-[140] flex flex-col rounded-xl border border-border bg-card shadow-2xl overflow-hidden animate-in fade-in duration-100" style={pos} onMouseDown={(e) => e.preventDefault()}>
      <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-border">
        <AtSign size={13} className="text-primary shrink-0" />
        <span className="text-[12px] text-muted-foreground flex-1 truncate">{q ? <>Cite <span className="text-foreground/80">“{q}”</span></> : "Search citations & clippings…"}</span>
        <div className="inline-flex rounded-md border border-border overflow-hidden shrink-0">
          {MODE_PILLS.map(([m, label, tip]) => (
            <button key={m} data-cite-mode={m} data-on={mode === m ? "1" : "0"} onMouseDown={(e) => { e.preventDefault(); onMode(m); }} title={tip}
              className={`px-1.5 py-0.5 text-[10.5px] transition-colors ${mode === m ? "bg-primary/15 text-primary font-medium" : "text-muted-foreground hover:text-foreground hover:bg-accent"}`}>{label}</button>
          ))}
        </div>
      </div>

      {!drilling && pending.length > 0 && (
        <div className="shrink-0 flex flex-wrap items-center gap-1 px-3 py-1.5 border-b border-border/50 bg-primary/5">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70 mr-0.5">group</span>
          {pending.map((h, i) => (
            <span key={i} className="inline-flex items-center gap-1 rounded-full bg-primary/12 text-primary px-1.5 py-0.5 text-[10.5px]">
              {authorOf(h)}{yearOf(h) ? " " + yearOf(h) : ""}
              <span role="button" tabIndex={0} title="Remove from the group" onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); onDropPending(i); }} className="cursor-pointer hover:text-primary/60"><X size={9} /></span>
            </span>
          ))}
          <span className="flex-1" />
          <button onMouseDown={(e) => { e.preventDefault(); onCommitGroup(); }} title="Insert the group (Esc)" className="shrink-0 rounded-md border border-primary/30 text-primary px-1.5 py-0.5 text-[10px] hover:bg-primary/10">insert ({pending.length})</button>
        </div>
      )}

      {!drilling && (<>
        <div className="flex-1 min-h-0 overflow-y-auto py-1">
          {loading && !hits.length && <p className="px-3 py-1.5 text-[12px] text-muted-foreground">searching…</p>}
          {!loading && !hits.length && q.length > 0 && <p className="px-3 py-1.5 text-[12px] text-muted-foreground">No matching citations or clippings.</p>}
          {!loading && !hits.length && !q && <p className="px-3 py-1.5 text-[12px] text-muted-foreground/80">Type an author or keyword.</p>}
          {hits.map((h, i) => (
            <button key={h.rel} data-cite-row ref={i === sel ? selRef : undefined} onMouseEnter={() => onHover(i)} onMouseDown={(e) => { e.preventDefault(); onPickHit(h); }}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left ${i === sel ? "bg-primary/10" : "hover:bg-accent/60"}`}>
              {h.alreadyCited ? <Star size={11} className="text-primary shrink-0" /> : h.kind === "clipping" ? <Newspaper size={11} className="text-muted-foreground/70 shrink-0" /> : <span className="w-[11px] shrink-0" />}
              <span className="min-w-0 flex-1">
                <span className="text-[12.5px] font-medium text-foreground/90">{citeText(h, mode)}</span>
                {h.title && <span className="text-[11.5px] text-muted-foreground"> · {h.title}</span>}
              </span>
              {mode === "quote" && nQuotesOf(h) > 0 && <span className="shrink-0 inline-flex items-center gap-0.5 text-[10px] text-muted-foreground/80"><Quote size={9} />{nQuotesOf(h)}</span>}
              {mode === "paren" && <span role="button" tabIndex={0} title="Add to the group, keep searching (↵ or Tab)" onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); onAddAnother(h); }} className={`shrink-0 cursor-pointer rounded-full p-0.5 ${i === sel ? "text-primary hover:bg-primary/15" : "text-muted-foreground/60 hover:text-primary"}`}><Plus size={12} /></span>}
            </button>
          ))}
        </div>
        {active && (
          <div className="shrink-0 px-3 py-1.5 border-t border-border/50 bg-muted/30">
            <div className="text-[11px] text-foreground/80 truncate">{active.title || active.stem}</div>
            <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
              {active.kind === "clipping" && <Newspaper size={9} className="shrink-0" />}
              <span className="truncate">{authorOf(active)}{yearOf(active) ? " · " + yearOf(active) : ""}{active.kind === "clipping" && active.source ? " · " + sourceLabel(active.source) : ""}</span>
              <span className="flex-1" />
              {mode === "quote"
                ? <span className="shrink-0">{nQuotesOf(active) ? `${nQuotesOf(active)} quote${nQuotesOf(active) === 1 ? "" : "s"} →` : "no marked quotes"}</span>
                : nKeyPointsOf(active) ? <span className="shrink-0">{nKeyPointsOf(active)} key points</span> : null}
            </div>
          </div>
        )}
        <div className="shrink-0 px-3 py-1 border-t border-border/60 text-[10px] text-muted-foreground/70 flex items-center gap-2">
          <span><b className="text-foreground/70">↑↓</b> move</span>
          {!pending.length && <span><b className="text-foreground/70">←→</b> style</span>}
          <span><b className="text-foreground/70">↵</b> {mode === "quote" ? "quotes" : mode === "paren" ? "add author" : "insert"}</span>
          <span><b className="text-foreground/70">esc</b> {mode === "paren" || pending.length ? (pending.length ? `insert (${pending.length})` : "cancel") : "cancel"}</span>
        </div>
      </>)}

      {drilling && (<>
        <button onMouseDown={(e) => { e.preventDefault(); onBack(); }} className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 text-left text-[11.5px] text-muted-foreground hover:text-foreground border-b border-border/50">
          <ChevronLeft size={13} /> <span className="font-medium text-foreground/85">{authorOf(drillHit!)}{yearOf(drillHit!) ? ` (${yearOf(drillHit!)})` : ""}</span> <span className="text-muted-foreground/70">· pick a quote</span>
        </button>
        <div className="flex-1 min-h-0 overflow-y-auto py-1">
          {!drillHit!.quotes.length && (nQuotesOf(drillHit!) > 0
            ? <p className="px-3 py-2 text-[12px] text-muted-foreground/80">reading the quotes…</p>
            : <p className="px-3 py-2 text-[12px] text-muted-foreground/80">No marked quotes in this source — <b className="text-foreground/70">↵</b> inserts the citation.</p>)}
          {drillHit!.quotes.map((qt, i) => (
            <button key={i} data-cite-quote ref={i === quoteSel ? selRef : undefined} onMouseEnter={() => onHoverQuote(i)} onMouseDown={(e) => { e.preventDefault(); onPickQuote(i); }}
              className={`flex w-full items-start gap-2 px-3 py-1.5 text-left ${i === quoteSel ? "bg-primary/10" : "hover:bg-accent/60"}`}>
              <span className={`shrink-0 mt-0.5 rounded px-1 text-[9.5px] tabular-nums ${qt.page ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground/60"}`}>{qt.page ? "p." + qt.page : "—"}</span>
              <span className="min-w-0 flex-1">
                {qt.tag && <span className="block text-[10px] text-muted-foreground/80 truncate">{qt.tag}</span>}
                <span className="block text-[12px] text-foreground/85 line-clamp-2">{qt.text}</span>
              </span>
            </button>
          ))}
        </div>
        {selQ && (
          <div className="shrink-0 px-3 py-1.5 border-t border-border/50 bg-muted/30">
            <div className="max-h-[64px] overflow-y-auto text-[11.5px] italic leading-snug text-foreground/85">“{selQ.text}”</div>
            <div className="mt-1 text-[10px] text-muted-foreground truncate">inserts <span className="text-foreground/70">{asaQuote(drillHit!, selQ)}</span></div>
          </div>
        )}
        <div className="shrink-0 px-3 py-1 border-t border-border/60 text-[10px] text-muted-foreground/70 flex items-center gap-2">
          <span><b className="text-foreground/70">↑↓</b> quote</span>
          <span><b className="text-foreground/70">↵</b> insert</span>
          <span><b className="text-foreground/70">←</b> back</span>
          <span><b className="text-foreground/70">esc</b> cancel</span>
        </div>
      </>)}
    </div>,
    document.body
  );
}

const normChars = (s: string) => s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/[–—]/g, "-");
function quoteRegex(quote: string): RegExp | null {
  const q = quote.trim().replace(/^["“]|["”]$/g, "").slice(0, 180);
  if (q.length < 6) return null;
  const words = normChars(q).split(/\s+/).filter(Boolean).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!words.length) return null;
  return new RegExp(words.join("\\s+"), "i");
}

function highlightQuote(container: HTMLElement, quote: string): boolean {
  const re = quoteRegex(quote);
  if (!re) return false;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const m = re.exec(normChars(node.nodeValue || ""));
    if (m && m.index >= 0) {
      try {
        const range = document.createRange();
        range.setStart(node, m.index); range.setEnd(node, m.index + m[0].length);
        const mark = document.createElement("mark");
        mark.className = "rounded px-0.5"; mark.style.backgroundColor = "hsl(var(--primary) / 0.22)"; mark.style.color = "inherit";
        range.surroundContents(mark);
        mark.scrollIntoView({ block: "center", behavior: "smooth" });
        return true;
      } catch { /* spans nodes — fall through to block highlight */ }
    }
  }
  // fallback: a top-level block whose full text contains the quote
  for (const el of Array.from(container.children) as HTMLElement[]) {
    if (re.test(normChars(el.textContent || ""))) {
      el.style.backgroundColor = "hsl(var(--primary) / 0.12)"; el.style.borderRadius = "6px";
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      return true;
    }
  }
  return false;
}

type CiteNote = { fm: Record<string, string | string[]>; title: string; journal: string; body: string };
function splitCiteNote(text: string): CiteNote {
  const fm: Record<string, string | string[]> = {};
  let body = text;
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (m) {
    body = text.slice(m[0].length);
    let key = "";
    for (const line of m[1].split("\n")) {
      const item = /^\s+-\s*(.*)$/.exec(line);
      if (item && key) { const v = fm[key]; fm[key] = [...(Array.isArray(v) ? v : []), item[1].trim().replace(/^["']|["']$/g, "")]; continue; }
      const kv = /^([\w-]+):\s*(.*)$/.exec(line);
      if (kv) { key = kv[1]; fm[key] = kv[2].trim().replace(/^["']|["']$/g, ""); }
    }
  }
  let title = "", journal = "";
  const h1 = /^\s*# (.+)\n?/.exec(body);
  if (h1) { title = h1[1].trim(); body = body.slice(h1[0].length); }
  const cut = body.search(/^## /m);
  const pre = cut < 0 ? body : body.slice(0, cut);
  for (const l of pre.split("\n")) {
    const f = /^\*\*(Source|Published in):\*\*\s*(.*)$/.exec(l.trim());
    if (f) journal = f[2].replace(/\*/g, "").trim();
  }
  // a note with no ## sections keeps its text, minus the link/status lines
  const rest = cut >= 0 ? body.slice(cut)
    : pre.split("\n").filter((l) => !/^\*\*[^*]+:\*\*/.test(l.trim())).join("\n").replace(/^\s*---\s*$/gm, "").trim();
  return { fm, title, journal, body: rest };
}
const fmStr = (v: string | string[] | undefined) => (Array.isArray(v) ? v.join(", ") : v || "").trim();
/** the target of a frontmatter wikilink value ("[[path|label]]"), tolerant of a lost closing bracket */
const fmLink = (v: string | string[] | undefined) => { const t = /\[\[([^|\]]+)/.exec(fmStr(v)); return t ? t[1].trim() : ""; };
const CIT_DIR = "Preparation/Reading/Citations/";
const baseName = (r: string) => r.split("/").pop() || r;

type SrcNote = { rel: string; text: string; found: boolean; parsed: CiteNote };

function SourceViewer({ rel, quote, project, onClose }: { rel: string; quote: string; project?: string | null; onClose: () => void }) {
  const [root, setRoot] = useState(rel);          // the paper on screen (a note rel)
  const [trail, setTrail] = useState<string[]>([]);   // papers visited through links, for Back
  const [notes, setNotes] = useState<{ cit: SrcNote | null; proj: SrcNote | null } | null>(null);
  const [view, setView] = useState<"cit" | "proj">(rel.includes("/corpus/") ? "proj" : "cit");
  const [err, setErr] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => { setRoot(rel); setTrail([]); setView(rel.includes("/corpus/") ? "proj" : "cit"); }, [rel]);

  // the pair: a project note's twin in Citations shares its file name, and so does a
  // citation note's twin in this project's corpus/
  useEffect(() => {
    let live = true; setNotes(null); setErr(false);
    const name = baseName(root);
    const citRel = root.includes("/corpus/") ? CIT_DIR + name : root;
    const projRel = root.includes("/corpus/") ? root : project ? `${project}/corpus/${name}` : "";
    const load = (r: string) => (r ? api.draftingSource(r, quote).then((x) => (x.error ? null : { rel: r, text: x.text, found: x.found, parsed: splitCiteNote(x.text) })).catch(() => null) : Promise.resolve(null));
    Promise.all([load(citRel), load(projRel)]).then(([cit, proj]) => {
      if (!live) return;
      if (!cit && !proj) { setErr(true); return; }
      setNotes({ cit, proj });
      setView((v) => (v === "proj" && !proj ? "cit" : v === "cit" && !cit ? "proj" : v));
    });
    return () => { live = false; };
  }, [root, project, quote]);

  const cur = notes ? (view === "proj" ? notes.proj : notes.cit) || notes.cit || notes.proj : null;
  // the paper's identity comes from its citation record; a project note alone falls back to itself
  const idn = notes?.cit?.parsed || cur?.parsed || null;
  const fm = idn?.fm || {};
  const pfm = notes?.proj?.parsed.fm || {};
  const title = (idn?.title || "").replace(/^[^-]*\(\d{4}[a-z]?\)\s*-\s*/, "") || fmStr(fm.title) || (cur ? baseName(cur.rel).replace(/\.md$/, "") : "Source");
  const byline = [fmStr(fm.author), fmStr(fm.year), idn?.journal].filter(Boolean).join(" · ");
  const status = fmStr(fm.status);
  const doi = fmStr(fm.doi);
  const pdfRel = fmStr(fm["pdf-path"]) || fmLink(fm["pdf-file"]) || fmLink(pfm.pdf);
  const localPdf = fmLink(pfm["local-pdf"]);
  const tags = (Array.isArray(fm.tags) ? fm.tags : []).filter((t) => t && t !== "citation");

  // a [[link]] in the body: its own twin switches the tab, another note opens here, a PDF
  // (or anything this viewer cannot show) goes to Obsidian on this machine
  const onWikiLink = (target: string): boolean => {
    const path = target.split("#")[0].trim();
    if (!path || /\.(pdf|png|jpe?g|svg|docx?|xlsx?|csv)$/i.test(path)) return false;
    const want = baseName(path).replace(/\.md$/, "") + ".md";
    if (notes?.cit && baseName(notes.cit.rel) === want && path.includes("Citations")) { setView("cit"); return true; }
    if (notes?.proj && baseName(notes.proj.rel) === want && path.includes("/corpus/")) { setView("proj"); return true; }
    const candidate = path.includes("/") ? path.replace(/\.md$/, "") + ".md" : CIT_DIR + want;
    api.draftingSource(candidate, "").then((x) => {
      if (x.error) { void openFile(target); return; }
      setTrail((t) => [...t, root]); setRoot(candidate); setView(candidate.includes("/corpus/") ? "proj" : "cit");
    }).catch(() => { void openFile(target); });
    return true;
  };

  useEffect(() => {
    if (!cur || !bodyRef.current) return;
    const id = requestAnimationFrame(() => { if (bodyRef.current && quote) highlightQuote(bodyRef.current, quote); });
    return () => cancelAnimationFrame(id);
  }, [cur, quote]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (typingEscape(e)) return;
      e.preventDefault(); e.stopPropagation();
      if (trail.length) { setRoot(trail[trail.length - 1]); setTrail((t) => t.slice(0, -1)); return; }
      onClose();
    };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [onClose, trail]);

  const tabCls = (on: boolean) => `px-2 py-0.5 text-[11px] transition-colors ${on ? "bg-primary/15 text-primary font-medium" : "text-muted-foreground hover:text-foreground hover:bg-accent"}`;
  const linkCls = "inline-flex items-center gap-1 text-muted-foreground hover:text-primary";
  return createPortal(
    <div role="dialog" aria-modal="true" aria-label="Source note" data-knav-modal className="fixed inset-0 z-[120] flex justify-end animate-in fade-in duration-150" onMouseDown={onClose}>
      <div className="absolute inset-0 bg-black/30" />
      <div className="relative h-full w-[min(620px,92vw)] bg-background border-l border-border shadow-2xl flex flex-col animate-in slide-in-from-right duration-200" onMouseDown={(e) => e.stopPropagation()}>
        <div className="shrink-0 flex items-center gap-2 px-4 py-2 border-b border-border">
          {trail.length > 0
            ? <button type="button" onClick={() => { setRoot(trail[trail.length - 1]); setTrail((t) => t.slice(0, -1)); }} title="Back to the previous paper (Esc)" className="inline-flex items-center gap-0.5 text-[11.5px] text-muted-foreground hover:text-foreground"><ChevronLeft size={14} /> Back</button>
            : <BookOpen size={15} className="text-primary shrink-0" />}
          <span className="flex-1" />
          {notes && notes.cit && notes.proj && (
            <div className="shrink-0 inline-flex rounded-md border border-border overflow-hidden">
              <button type="button" onClick={() => setView("cit")} aria-pressed={view === "cit"} title="The paper's citation note" className={tabCls(view === "cit")}>Citation</button>
              <button type="button" onClick={() => setView("proj")} aria-pressed={view === "proj"} title="This project's corpus note on the paper" className={tabCls(view === "proj")}>Project</button>
            </div>
          )}
          {cur && <button onClick={() => { void openFile(cur.rel); }} title="Open this note in Obsidian, on this machine" className="inline-flex items-center gap-1 text-[11.5px] text-muted-foreground hover:text-foreground ml-1"><ExternalLink size={12} /> Obsidian</button>}
          <button type="button" onClick={onClose} data-knav-back="2" aria-label="Close" className="text-muted-foreground hover:text-foreground ml-1"><X size={16} /></button>
        </div>
        {quote && (
          <div className="shrink-0 px-4 py-2 border-b border-border/60 bg-secondary/30">
            <div className="flex items-start gap-1.5 text-[11.5px]">
              <Quote size={12} className="text-primary/70 shrink-0 mt-0.5" />
              <span className="text-foreground/80 italic leading-snug">“{quote.length > 200 ? quote.slice(0, 200) + "…" : quote}”</span>
            </div>
          </div>
        )}
        <div ref={bodyRef} className="flex-1 min-h-0 overflow-y-auto tinybar px-6 py-5">
          {err && <p className="text-[13px] text-destructive">Couldn’t open this source note.</p>}
          {!err && !notes && <p className="text-[13px] text-muted-foreground">Opening source…</p>}
          {cur && (
            <header className="mb-5 pb-4 border-b border-border/60">
              <h2 className="text-[19px] leading-snug font-semibold text-foreground" style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}>{title}</h2>
              {byline && <div className="mt-1.5 text-[13px] text-muted-foreground">{byline}</div>}
              <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11.5px]">
                {status && <span className={"px-1.5 py-0.5 rounded font-medium " + (status === "unread" ? "bg-secondary text-muted-foreground" : "bg-primary/15 text-primary")}>{status}</span>}
                {pdfRel && <button onClick={() => { void openFile(pdfRel); }} title="Open the PDF in Obsidian, on this machine" className={linkCls}><FileText size={11} /> PDF</button>}
                {localPdf && <button onClick={() => { void openFile(localPdf); }} title="Open the project's copy of the PDF in Obsidian, on this machine" className={linkCls}><FileText size={11} /> Local PDF</button>}
                {doi && <button onClick={() => { void openUrl("https://doi.org/" + doi); }} title="Open the DOI in the browser" className={linkCls + " nums"}><Globe size={11} /> {doi}</button>}
              </div>
              {tags.length > 0 && (
                <div className="mt-2.5 flex flex-wrap gap-1">
                  {tags.map((t) => <span key={t} className="text-[10.5px] px-1.5 py-0.5 rounded bg-secondary/70 text-muted-foreground">{t}</span>)}
                </div>
              )}
            </header>
          )}
          {cur && <Markdown key={cur.rel} text={cur.parsed.body} idPrefix="src-" onWikiLink={onWikiLink} className="text-[14.5px] leading-[1.75] text-foreground/90" />}
        </div>
      </div>
    </div>,
    document.body
  );
}

function SourcePdfViewer({ rel, page, onClose, onOpenNote }:
{ rel: string; page: string; onClose: () => void; onOpenNote: (rel: string) => void }) {
  const [t, setT] = useState<CitePageTarget | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    let live = true; setT(null); setErr(false);
    api.draftingCitePage(rel, page).then((r) => { if (!live) return; if (r.error) setErr(true); else setT(r); }).catch(() => live && setErr(true));
    return () => { live = false; };
  }, [rel, page]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (pdfFindKey(e, document.querySelector<HTMLIFrameElement>("[data-source-pdf] iframe"))) return;
      if (e.key === "Escape") { if (typingEscape(e)) return; e.preventDefault(); e.stopPropagation(); onClose(); }
    };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [onClose]);
  const pdfName = t?.pdfRel ? (t.pdfRel.split("/").pop() || t.pdfRel) : "";
  const src = t && t.pdfExists ? api.draftingSourcePdfUrl(t.pdfRel) + "#page=" + t.physicalPage + "&zoom=page-width" : "";
  return createPortal(
    <div role="dialog" aria-modal="true" aria-label="Source PDF" data-knav-modal data-source-pdf data-native-find className="fixed inset-0 z-[122] flex justify-end animate-in fade-in duration-150" onMouseDown={onClose}>
      <div className="absolute inset-0 bg-black/40" />
      <div className="relative h-full w-[min(920px,96vw)] bg-background border-l border-border shadow-2xl flex flex-col animate-in slide-in-from-right duration-200" onMouseDown={(e) => e.stopPropagation()}>
        <div className="shrink-0 flex items-center gap-2 px-4 py-2.5 border-b border-border">
          <FileText size={15} className="text-primary shrink-0" />
          <span className="text-[12.5px] font-medium truncate flex-1" title={pdfName}>{pdfName || "Source PDF"}</span>
          {t && <span className="shrink-0 text-[11px] text-muted-foreground nums" title={t.exact ? "Exact page — from a stored highlight on this page" : "Estimated page — printed page + this note’s front-matter offset"}>p.{t.printedPage} → PDF p.{t.physicalPage}{t.exact ? "" : " ≈"}</span>}
          <button onClick={() => onOpenNote(t?.noteRel || rel)} title="Open the citation note instead" className="inline-flex items-center gap-1 text-[11.5px] text-muted-foreground hover:text-foreground ml-1"><BookOpen size={12} /> Note</button>
          {t?.pdfExists && <button onClick={() => api.open(t.pdfRel)} title="Open the PDF in Obsidian" className="inline-flex items-center gap-1 text-[11.5px] text-muted-foreground hover:text-foreground"><ExternalLink size={12} /> Obsidian</button>}
          <button type="button" onClick={onClose} data-knav-back="2" aria-label="Close" className="text-muted-foreground hover:text-foreground ml-1"><X size={16} /></button>
        </div>
        {t?.quote && (
          <div className="shrink-0 px-4 py-2 border-b border-border/60 bg-secondary/30">
            <div className="flex items-start gap-1.5 text-[11.5px]">
              <Quote size={12} className="text-primary/70 shrink-0 mt-0.5" />
              <span className="text-foreground/80 italic leading-snug">“{t.quote.length > 240 ? t.quote.slice(0, 240) + "…" : t.quote}”</span>
            </div>
          </div>
        )}
        <div className="flex-1 min-h-0 bg-neutral-800/40">
          {err && <p className="p-4 text-[13px] text-destructive">Couldn’t resolve this citation’s PDF.</p>}
          {!err && !t && <p className="p-4 text-[13px] text-muted-foreground">Locating the page…</p>}
          {t && !t.pdfExists && (
            <div className="p-5 text-[13px] text-muted-foreground space-y-2">
              <p className="flex items-center gap-1.5 text-amber-500/90"><AlertTriangle size={14} /> No PDF on disk for this source.</p>
              {t.pdfRel && <p className="text-[12px]">Expected at <code className="text-[11px]">{t.pdfRel}</code> — grab it with the downloader, then this jump will open it at page {t.physicalPage}.</p>}
              <button onClick={() => onOpenNote(t.noteRel || rel)} className="inline-flex items-center gap-1 text-primary hover:underline"><BookOpen size={13} /> Open the citation note</button>
            </div>
          )}
          {t && t.pdfExists && src && <PdfFindFrame rel={t.pdfRel} page={t.physicalPage} title={pdfName} />}
        </div>
      </div>
    </div>,
    document.body
  );
}

/** Render a reference line's inline *italics* (titles/journals) without a full markdown
 * pass — the rest is literal text. */
function RefText({ text }: { text: string }) {
  const parts = text.split(/(\*[^*]+\*)/g);
  return <>{parts.map((p, i) => (p.length > 2 && p.startsWith("*") && p.endsWith("*")) ? <i key={i}>{p.slice(1, -1)}</i> : <span key={i}>{p}</span>)}</>;
}

const REF_STYLES: { id: RefStyle; label: string }[] = [
  { id: "asa", label: "ASA" }, { id: "apa", label: "APA" }, { id: "chicago", label: "Chicago" }, { id: "mla", label: "MLA" },
];

/** Strip *italic* markers so a reference copies as clean plain text (titles/journals
 * keep their words, just lose the asterisks). */
const stripEmph = (s: string) => s.replace(/\*([^*]+)\*/g, "$1");

/** Webview-safe clipboard copy — copyPlain owns the execCommand fallback. */
function copyToClipboard(text: string, okMsg = "Copied") {
  void copyPlain(text).then((ok) => ok ? toast.success(okMsg) : toast.error("Couldn't copy"));
}

function refIssues(flags: string[]): string[] {
  const out: string[] = [];
  for (const f of flags) {
    if (f.startsWith("incomplete:")) {
      const fields = f.slice("incomplete:".length).split(",").map((x) => x.trim()).filter(Boolean);
      out.push(fields.length ? "missing " + fields.join(", ") : "incomplete entry");
    } else if (f === "no-citation-line") out.push("no citation line in the note");
    else if (f === "malformed-note") out.push("citation note is malformed");
    else if (f === "apa-normalized") out.push("auto-converted from APA — verify the fields");
    else if (f === "title-approx") out.push("title is approximated");
    else if (f === "prior-only-no-note") out.push("no vault note backs this entry — confirm via ref audit, or fetch + read the source");
  }
  return out;
}

// The citation style is owned by the Drafting shell (one usePersistent, passed in) so the
// toolbar's flagged-reference badge and this panel always build against the same style.
function ReferencesPanel({ slug, docName, style, setStyle, onClose, onViewSource }:
{ slug: string; docName: string; style: RefStyle; setStyle: (v: RefStyle) => void; onClose: () => void; onViewSource: (rel: string) => void }) {
  const [build, setBuild] = useState<RefBuild | null>(null);
  const [loading, setLoading] = useState(true);
  const [writing, setWriting] = useState(false);
  const [wrote, setWrote] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [editIdx, setEditIdx] = useState<number | null>(null);   // entry being edited inline
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [onlyIssues, setOnlyIssues] = useState(false);           // filter the list to flagged entries
  useEffect(() => {
    let live = true; setLoading(true); setWrote(false);
    api.draftingReferences(slug, docName, style)
      .then((r) => { if (live) setBuild(r.error ? null : r); })
      .catch(() => live && setBuild(null)).finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [slug, docName, style, refreshKey]);
  const saveEdit = (e: { rel: string; citekey: string }) => {
    if (!draft.trim()) return;
    setSaving(true);
    api.draftingEditReference({ slug, doc: docName, rel: e.rel, citekey: e.citekey, text: draft, force: true })
      .then((r) => {
        if (r.ok) {
          const synced = [r.note && "citation note", r.bib && (r.bibInserted ? "library.bib (new)" : "library.bib"), r.refsMd && "references.md"].filter(Boolean).join(" · ");
          toast.success(synced ? "Synced to " + synced : "Saved");
          setEditIdx(null); setDraft(""); setRefreshKey((k) => k + 1);
        } else toast.error(r.error || "Couldn't sync the reference");
      })
      .catch(() => toast.error("Couldn't sync the reference")).finally(() => setSaving(false));
  };
  useEffect(() => {
    // stop typing, then drop an inline reference edit, then close the panel
    const h = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || typingEscape(e)) return;
      e.preventDefault(); e.stopPropagation();
      if (editIdx !== null) { setEditIdx(null); setDraft(""); } else onClose();
    };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [onClose, editIdx]);
  const write = async () => {
    setWriting(true);
    try {
      let r = await api.draftingWriteReferences({ slug, doc: docName, style, baseMtime: build?.existsMtime ?? null });
      if (r.conflict) r = await api.draftingWriteReferences({ slug, doc: docName, style, baseMtime: r.currentMtime ?? null });
      if (r.ok) { setWrote(true); toast.success("references.md written (" + style.toUpperCase() + ")"); }
      else toast.error(r.error || "Couldn't write references.md");
    } catch { toast.error("Couldn't write references.md"); }
    finally { setWriting(false); }
  };
  const a = build?.audit;
  const entries: RefEntry[] = build?.entries ?? [];
  const flaggedEntries = entries.filter((e) => refIssues(e.flags).length > 0);
  const nFlagged = flaggedEntries.length;
  const nUnmatched = build ? build.unresolved.length + build.ambiguous.length : 0;
  const copyWarnings = () => {
    const lines = [
      ...build!.unresolved.map((u) => "- " + u + " — no citation note in the vault"),
      ...build!.ambiguous.map((am) => "- " + am.token + " — " + am.candidates.length + " possible works (name/year collision)"),
    ];
    copyToClipboard("In-text citations with no matching reference:\n" + lines.join("\n"),
      "Copied " + nUnmatched + " warning" + (nUnmatched === 1 ? "" : "s"));
  };
  const copyFixList = () => copyToClipboard(
    "References needing fixes:\n" + flaggedEntries.map((e) => "- " + stripEmph(e.text) + "  [" + refIssues(e.flags).join("; ") + "]").join("\n"),
    "Copied " + nFlagged + " flagged reference" + (nFlagged === 1 ? "" : "s"));
  return createPortal(
    <div role="dialog" aria-modal="true" aria-label="References" data-knav-modal className="fixed inset-0 z-[120] flex justify-end animate-in fade-in duration-150" onMouseDown={onClose}>
      <div className="absolute inset-0 bg-black/30" />
      <div className="relative h-full w-[min(660px,94vw)] bg-background border-l border-border shadow-2xl flex flex-col animate-in slide-in-from-right duration-200" onMouseDown={(e) => e.stopPropagation()}>
        <div className="shrink-0 flex items-center gap-2 px-4 py-2.5 border-b border-border">
          <ListOrdered size={15} className="text-primary shrink-0" />
          <span className="text-[13px] font-medium flex-1" title="Built from your citation notes and library.bib; Write saves writing/references.md">References</span>
          <div className="inline-flex rounded-md border border-border overflow-hidden">
            {REF_STYLES.map((s) => (
              <button key={s.id} onClick={() => setStyle(s.id)} title={s.label + " reference style"}
                className={`px-2 py-0.5 text-[11px] transition-colors ${style === s.id ? "bg-primary/15 text-primary font-medium" : "text-muted-foreground hover:text-foreground hover:bg-accent"}`}>{s.label}</button>
            ))}
          </div>
          <button type="button" onClick={onClose} data-knav-back="2" aria-label="Close" className="text-muted-foreground hover:text-foreground ml-1"><X size={16} /></button>
        </div>
        {a && (
          <div className="shrink-0 px-4 py-2 border-b border-border/60 flex items-center flex-wrap gap-x-3 gap-y-1.5 text-[11.5px]">
            <span className="text-foreground/80"><b className="nums">{a.total}</b> reference{a.total === 1 ? "" : "s"}</span>
            {nUnmatched > 0 && <span className="text-rose-500/90 nums">{nUnmatched} unmatched cite{nUnmatched === 1 ? "" : "s"}</span>}
            {nFlagged > 0 && (
              <button onClick={() => setOnlyIssues((v) => !v)} title="Show only references that have errors to fix"
                className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 nums transition-colors ${onlyIssues ? "border-amber-500/60 bg-amber-500/10 text-amber-600" : "border-border text-muted-foreground hover:text-foreground hover:border-amber-500/50"}`}>
                <AlertTriangle size={11} /> {nFlagged} need{nFlagged === 1 ? "s" : ""} fixing
              </button>
            )}
            <span className="flex-1" />
            <button onClick={write} disabled={writing || !a.total} title="Write writing/references.md (transcluded by the publish step)"
              className="inline-flex items-center gap-1 rounded-md border border-primary/50 text-primary px-2 py-0.5 text-[11.5px] hover:bg-primary/10 disabled:opacity-50">
              <Save size={12} /> {wrote ? "written ✓" : build?.existing ? "Update references.md" : "Write references.md"}
            </button>
          </div>
        )}
        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-2.5">
          {loading && <p className="text-[13px] text-muted-foreground">Resolving citations against your library…</p>}
          {!loading && !build && <p className="text-[13px] text-destructive">Couldn’t build the reference list.</p>}
          {build && nUnmatched > 0 && (
            <div className="rounded-lg border border-rose-500/30 bg-rose-500/[0.05] px-3 py-2.5 text-[12px] space-y-1.5">
              <div className="flex items-center gap-1.5">
                <AlertTriangle size={12} className="text-rose-500 shrink-0" />
                <p className="font-medium text-foreground/85 flex-1">In-text citations with no match in the references ({nUnmatched})</p>
                <button onClick={copyWarnings} title="Copy all of these warnings"
                  className="inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-[10.5px] text-muted-foreground hover:text-foreground hover:border-primary/50"><Copy size={10} /> Copy all</button>
              </div>
              {build.unresolved.map((u, i) => (
                <div key={"u" + i} className="group/w flex items-start gap-1.5 leading-snug">
                  <span className="flex-1 text-muted-foreground"><span className="font-medium text-foreground/80">{u}</span> — no citation note in the vault</span>
                  <button onClick={() => copyToClipboard(u, "Copied " + u)} title="Copy this cite"
                    className="shrink-0 opacity-0 group-hover/w:opacity-100 transition-opacity text-muted-foreground hover:text-primary"><Copy size={11} /></button>
                </div>
              ))}
              {build.ambiguous.map((am, i) => (
                <div key={"am" + i} className="group/w flex items-start gap-1.5 leading-snug">
                  <span className="flex-1 text-muted-foreground"><span className="font-medium text-foreground/80">{am.token}</span> — {am.candidates.length} possible works (name/year collision); add the disambiguating author or write the entry directly</span>
                  <button onClick={() => copyToClipboard(am.token, "Copied " + am.token)} title="Copy this cite"
                    className="shrink-0 opacity-0 group-hover/w:opacity-100 transition-opacity text-muted-foreground hover:text-primary"><Copy size={11} /></button>
                </div>
              ))}
            </div>
          )}
          {build && onlyIssues && nFlagged > 0 && (
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <span>Showing {nFlagged} reference{nFlagged === 1 ? "" : "s"} that need fixing</span>
              <span className="flex-1" />
              <button onClick={copyFixList} title="Copy the flagged references and their issues"
                className="inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 hover:text-foreground hover:border-primary/50"><Copy size={10} /> Copy list</button>
              <button onClick={() => setOnlyIssues(false)} className="hover:text-foreground">Show all</button>
            </div>
          )}
          {build && entries.map((e, i) => {
            const issues = refIssues(e.flags);
            if (onlyIssues && issues.length === 0) return null;
            const canEdit = style === "asa" && !!(e.citekey || e.rel);
            if (editIdx === i) return (
              <div key={i} className="rounded-lg border border-primary/40 bg-primary/[0.04] px-3 py-2.5 space-y-2">
                <textarea autoFocus value={draft} onChange={(ev) => setDraft(ev.target.value)} rows={4}
                  onKeyDown={(ev) => { if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); saveEdit(e); } }}
                  className="w-full text-[12.5px] leading-snug rounded-md border border-border bg-background px-2 py-1.5 font-mono focus:outline-none focus:border-primary/60" />
                <div className="flex items-center gap-2 text-[11px]">
                  <span className="text-muted-foreground">Use <code className="text-[10px]">*italics*</code> for titles/journals. Syncs to the citation note, frontmatter & library.bib.</span>
                  <span className="flex-1" />
                  <button type="button" data-knav-back="3" onClick={() => { setEditIdx(null); setDraft(""); }} className="text-muted-foreground hover:text-foreground px-2 py-0.5">Cancel</button>
                  <button onClick={() => saveEdit(e)} disabled={saving || !draft.trim()}
                    className="inline-flex items-center gap-1 rounded-md border border-primary/50 text-primary px-2.5 py-0.5 hover:bg-primary/10 disabled:opacity-50">
                    {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />} Save & sync
                  </button>
                </div>
              </div>
            );
            return (
              <div key={i} className={`group/ref flex items-start gap-1.5 text-[12.5px] leading-snug ${issues.length ? "rounded-md border border-amber-500/25 bg-amber-500/[0.04] px-2 py-1.5" : ""} text-foreground/90`}>
                <div className="flex-1 pl-4 -indent-4">
                  <button onClick={() => e.rel && onViewSource(e.rel)} disabled={!e.rel}
                    title={e.rel ? "Open the citation note" : "No vault note — from your existing references.md"}
                    className={`text-left ${e.rel ? "hover:text-primary cursor-pointer" : "cursor-default"}`}>
                    <RefText text={e.text} />
                  </button>
                  {issues.length > 0 && (
                    <div className="indent-0 mt-1 flex items-center gap-1 text-[10.5px] text-amber-600/90">
                      <AlertTriangle size={10} className="shrink-0" /> {issues.join(" · ")}
                    </div>
                  )}
                </div>
                <button onClick={() => copyToClipboard(stripEmph(e.text), "Reference copied")} title="Copy this reference"
                  className="shrink-0 mt-px opacity-0 group-hover/ref:opacity-100 transition-opacity text-muted-foreground hover:text-primary"><Copy size={13} /></button>
                {canEdit && (
                  <button onClick={() => { setEditIdx(i); setDraft(e.text); }} title="Edit this reference and sync it to the citation note + library.bib"
                    className="shrink-0 mt-px opacity-0 group-hover/ref:opacity-100 transition-opacity text-muted-foreground hover:text-primary"><SquarePen size={13} /></button>
                )}
              </div>
            );
          })}
          {build && onlyIssues && nFlagged === 0 && entries.length > 0 && <p className="text-[13px] text-muted-foreground">No references need fixing — every resolved entry has complete fields.</p>}
          {build && !entries.length && !loading && <p className="text-[13px] text-muted-foreground">No resolved citations in this manuscript yet — write some <span className="italic">(Author Year)</span> cites and they’ll appear here.</p>}        </div>
      </div>
    </div>,
    document.body
  );
}

const CORPUS_W = 340, CORPUS_MAX = 760, CORPUS_GAP = 48;
// above these the panel has room to stop abbreviating: full passages + wrapped tags, then
// a two-column browse grid.
const CORPUS_ROOMY = 520, CORPUS_GRID = 640;

// vault notes vs citation notes. A vault kind has no author/year/citekey and is read
// through /note/read; a citation kind carries the rel the cite machinery already knows.
const CORPUS_VAULT_KINDS = new Set(["idea", "concept", "author", "reflection", "meeting", "corpus", "inbox", "freewriting", "projectnote", "draft"]);
const CORPUS_KIND_LABEL: Record<string, string> = {
  idea: "idea", concept: "concept", author: "author note", reflection: "reflection",
  meeting: "meeting", corpus: "project corpus", clipping: "clipping", historical: "historical",
  inbox: "inbox", freewriting: "free writing", projectnote: "project note", draft: "draft",
};
const isVaultNote = (kind: string) => CORPUS_VAULT_KINDS.has(kind);
// a note or draft with no citation record behind it: it has no page in the source viewer
// (/drafting/source only knows citation notes), so it is read in the panel and nowhere else.
const isPlainNote = (kind: string) => isVaultNote(kind) && kind !== "corpus";

// what a search covers. `kinds` goes to /drafting/corpus-search as it stands; "" is everything.
const CORPUS_SCOPES = [
  { id: "all", label: "All", kinds: "", tip: "Sources, notes and drafts" },
  { id: "sources", label: "Sources", kinds: "citation,clipping,historical,corpus", tip: "Citation notes, clippings and project corpus notes" },
  { id: "notes", label: "Notes", kinds: "idea,concept,author,reflection,meeting,inbox,freewriting,projectnote", tip: "Your own notes" },
  { id: "drafts", label: "Drafts", kinds: "draft", tip: "Sections of your other drafts" },
] as const;
type CorpusScope = typeof CORPUS_SCOPES[number]["id"];

/** One row in the panel, whichever leg produced it: a lexical browse row or a search hit. */
type CorpusItem = {
  rel: string; stem: string; kind: string; author: string; year: string; title: string;
  slug: string; doc: string;
  intext: string; suffix: string;
  citekey: string; tags: string[]; cited: boolean; citeRel: string | null;
  best: DraftCorpusPassage | null; passages: DraftCorpusPassage[];
};

const citeRelOf = (it: CorpusItem) => (!isVaultNote(it.kind) ? it.rel : it.kind === "corpus" ? it.citeRel : null);
const citeLike = (it: CorpusItem) => !!citeRelOf(it);

type CorpusActions = {
  insert: (text: string) => boolean;
  insertQuote: (h: CiteHit, q: CiteQuote) => void;
  openPdf: (rel: string, page: string) => void;
};

const corpusHit = (it: CorpusItem): CiteHit => ({
  stem: it.stem, rel: citeRelOf(it) || it.rel, author: it.author, year: /^\d{3,4}$/.test(it.year) ? Number(it.year) : null,
  intext: it.intext || it.author, suffix: it.suffix,
  title: it.title, citekey: it.citekey, source: "", tags: it.tags,
  citation: "", keyPoints: [], quotes: [], alreadyCited: it.cited,
});

// a draft hit names its paper (the project's bare name, first letter raised) and, when it
// is not the manuscript itself, which document of that project: "appendix", "previous draft".
const draftName = (it: CorpusItem) => { const n = it.title || it.slug || it.stem; return n.charAt(0).toUpperCase() + n.slice(1); };
const draftDoc = (it: CorpusItem) => (it.doc && it.doc.toLowerCase() !== "paper.md" ? it.doc.replace(/\.md$/i, "").replace(/-/g, " ") : "");

const str = (v: unknown) => (typeof v === "string" ? v : v === null || v === undefined ? "" : String(v));
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** A search hit, defended against a malformed response: every field is coerced, a missing
 *  `passages` is an empty list, and a missing `best` is simply no passage. */
function hitToItem(h: DraftCorpusHit): CorpusItem {
  const passages = (Array.isArray(h?.passages) ? h.passages : []).filter((p) => p && typeof p.text === "string");
  const best = h?.best && typeof h.best.text === "string" ? h.best : passages[0] ?? null;
  return {
    rel: str(h?.rel), stem: str(h?.stem), kind: str(h?.kind) || "citation", author: str(h?.author),
    // an index built before `doc` was served still names the file at the end of rel
    slug: str(h?.slug), doc: str(h?.doc) || (str(h?.kind) === "draft" ? str(h?.rel).split("/").pop() || "" : ""),
    intext: str(h?.intext), suffix: str(h?.suffix),
    year: str(h?.year), title: str(h?.title), citekey: str(h?.citekey), tags: strs(h?.tags),
    cited: !!h?.cited, citeRel: typeof h?.citeRel === "string" && h.citeRel ? h.citeRel : null, best, passages,
  };
}
function rowToItem(r: CorpusRow): CorpusItem {
  const head = (r.keyPoints || [])[0] || r.citation || "";
  return {
    rel: r.rel, stem: r.stem, kind: r.kind || "citation", author: r.author || "", year: r.year == null ? "" : String(r.year),
    slug: "", doc: "",
    intext: r.intext || "", suffix: r.suffix || "",
    title: r.title || "", citekey: r.citekey || "", tags: r.tags || [], cited: !!r.alreadyCited, citeRel: null,
    best: head ? { field: "head", text: head, page: null, heading: null, line: null } : null, passages: [],
  };
}

/** Query tokens for the <mark> highlight — words of 3+ characters, deduped, regex-escaped. */
function markTokens(q: string): string[] {
  const seen = new Set<string>();
  for (const w of (q || "").toLowerCase().split(/[^\p{L}\p{N}'-]+/u)) {
    if (w.length >= 3 && !seen.has(w)) seen.add(w);
    if (seen.size >= 8) break;
  }
  return [...seen];
}
/** The matched words in a passage, marked with theme tokens (never the browser's yellow). */
function Marked({ text, tokens }: { text: string; tokens: string[] }) {
  if (!tokens.length || !text) return <>{text}</>;
  let re: RegExp;
  try { re = new RegExp("(" + tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")", "gi"); }
  catch { return <>{text}</>; }
  const parts = text.split(re);
  return <>{parts.map((p, i) => (i % 2 === 1
    ? <mark key={i} className="rounded-[3px] bg-primary/15 text-foreground px-px">{p}</mark>
    : <Fragment key={i}>{p}</Fragment>))}</>;
}

/** The chip that says what KIND of text matched: a page for a quote, "key point" for a key
 *  point, the heading for a section, nothing at all for the note's head. */
function PassageChip({ p }: { p: DraftCorpusPassage }) {
  if (p.field === "quote") return p.page ? <span className="shrink-0 text-[9.5px] px-1 py-px rounded bg-secondary/70 text-muted-foreground nums">p. {p.page}</span> : null;
  if (p.field === "key") return <span className="shrink-0 text-[9.5px] px-1 py-px rounded bg-secondary/70 text-muted-foreground">key point</span>;
  if (p.field === "section" && p.heading) return <span className="shrink-0 text-[9.5px] px-1 py-px rounded bg-secondary/70 text-muted-foreground truncate max-w-[160px]" title={p.heading}>{p.heading}</span>;
  return null;
}
function Passage({ p, tokens, full }: { p: DraftCorpusPassage; tokens: string[]; full: boolean }) {
  return (
    <div className="mt-1 flex items-start gap-1.5">
      <PassageChip p={p} />
      <span className={`text-[11px] leading-snug ${p.field === "quote" ? "font-serif italic text-foreground/85" : "text-muted-foreground"} ${full ? "" : "line-clamp-2"}`}>
        <Marked text={p.text} tokens={tokens} />
      </span>
    </div>
  );
}

function CorpusPanel({ slug, docName, width, actions, onViewSource, onClose, side = "left", onSide }:
{ slug: string; docName: string; width: number; actions: CorpusActions; onViewSource: (rel: string) => void; onClose: () => void;
  side?: "left" | "right"; onSide?: (s: "left" | "right") => void }) {
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [searchQ, setSearchQ] = useState("");
  const [sort, setSort] = usePersistent<CorpusSort>("aioa-drafting-corpus-sort", "author");
  const [data, setData] = useState<CorpusBrowse | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState<DraftCorpusSearch | null>(null);
  const [searching, setSearching] = useState(false);
  const [scopeRaw, setScope] = usePersistent<CorpusScope>("aioa-drafting-corpus-scope", "all");
  const scope = CORPUS_SCOPES.find((s) => s.id === scopeRaw) ?? CORPUS_SCOPES[0];
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [drill, setDrill] = useState<CorpusItem | null>(null);
  // Sources | Claims. Claims mode is its own component (ClaimsPanel.tsx); it hides itself
  // whenever the claims index does not answer, so the panel never shows a dead mode.
  const [claimsOk, setClaimsOk] = useState(false);
  const [panelMode, setPanelModeState] = useState<"sources" | "claims">(() => {
    try { return window.localStorage.getItem("aioa-drafting-corpus-mode") === "claims" ? "claims" : "sources"; } catch { return "sources"; }
  });
  const setPanelMode = (m: "sources" | "claims") => {
    setPanelModeState(m);
    try { window.localStorage.setItem("aioa-drafting-corpus-mode", m); } catch { /* private window */ }
  };
  const claimsMode = claimsOk && panelMode === "claims";
  const [claimsTotal, setClaimsTotal] = useState<number | null>(null);
  const claimsBack = useRef<(() => boolean) | null>(null);
  useEffect(() => {
    let live = true;
    api.claimsStats().then((st) => { if (live) setClaimsOk(!!st && (Number(st.indexed_claims ?? st.claims) > 0 || !!st.building)); }).catch(() => live && setClaimsOk(false));
    return () => { live = false; };
  }, []);
  const claimsGone = useCallback(() => setClaimsOk(false), []);
  const citeForClaim = useCallback((h: CiteHit, page?: string) => {
    if (!page) return citeText(h, "paren");
    return `(${[authorOf(h), yearOf(h)].filter(Boolean).join(" ")}:${page})`;
  }, []);

  useEffect(() => { const t = setTimeout(() => setDebouncedQ(q.trim()), 220); return () => clearTimeout(t); }, [q]);
  useEffect(() => { const t = setTimeout(() => setSearchQ(q.trim()), 250); return () => clearTimeout(t); }, [q]);
  useEffect(() => {
    let live = true; setLoading(true);
    api.draftingCorpus(slug, docName, debouncedQ, sort, 600)
      .then((r) => { if (live) setData(r); })
      .catch(() => live && setData(null))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [slug, docName, debouncedQ, sort]);
  // the meaning leg. The previous hits stay on screen until the new ones land — a search
  // that blanks its own list is unreadable while typing.
  useEffect(() => {
    if (!searchQ) { setSearch(null); setSearching(false); return; }
    let live = true; setSearching(true);
    api.draftingCorpusSearch(slug, docName, searchQ, 60, scope.kinds)
      .then((r) => { if (live) setSearch(r && Array.isArray(r.hits) ? r : { mode: "none", hits: [] }); })
      .catch(() => { if (live) setSearch({ mode: "none", hits: [] }); })
      .finally(() => { if (live) setSearching(false); });
    return () => { live = false; };
  }, [slug, docName, searchQ, scope.kinds]);

  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (typingEscape(e) || layerAbove(rootRef.current)) return;
      e.preventDefault(); e.stopPropagation();
      if (claimsMode) { if (!claimsBack.current?.()) onClose(); return; }
      if (drill) { setDrill(null); return; }
      onClose();
    };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [onClose, drill, claimsMode]);

  const rows = data?.rows ?? [];
  const tagFacets = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) for (const t of r.tags) m.set(t, (m.get(t) || 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14);
  }, [rows]);
  const browse = useMemo(() => (activeTag ? rows.filter((r) => r.tags.includes(activeTag)) : rows).map(rowToItem), [rows, activeTag]);
  const hits = useMemo(() => {
    const own = slug.trim().toLowerCase(), ownDoc = (docName || "paper.md").toLowerCase();
    return (search?.hits ?? []).map(hitToItem).filter((it) => !(it.kind === "draft" && it.slug.toLowerCase() === own && it.doc.toLowerCase() === ownDoc));
  }, [search, slug, docName]);
  const searchMode = !!searchQ;
  // in flight, the lexical rows are what is already on screen: show those rather than nothing
  const items = searchMode ? (search ? hits : browse) : browse;
  const tokens = useMemo(() => markTokens(searchQ), [searchQ]);
  const roomy = width >= CORPUS_ROOMY;
  const grid = !searchMode && width >= CORPUS_GRID && items.length > 1;
  const span = grid ? " col-span-2" : "";
  const mode = searchMode && search ? search.mode : null;

  const citeOf = (it: CorpusItem) => citeText(corpusHit(it), "paren");
  const citeAt = (it: CorpusItem, copy: boolean) => {
    const t = citeOf(it);
    if (copy) { copyToClipboard(t, "Copied " + t); return; }
    actions.insert(t);
  };
  const citePageAt = (it: CorpusItem, page: string) => {
    const h = corpusHit(it);
    const inner = [authorOf(h), yearOf(h)].filter(Boolean).join(" ") + (page ? `:${page}` : "");
    actions.insert(`(${inner})`);
  };

  const SORTS: { id: CorpusSort; label: string }[] = [
    { id: "author", label: "A–Z" }, { id: "year", label: "Newest" }, { id: "cited", label: "Cited" },
  ];
  return (
    <div ref={rootRef} data-qa="corpus-panel" style={{ width }} className={`flex flex-col h-full shrink-0 ${side === "right" ? "border-l" : "border-r"} border-border bg-secondary/20`}>
      <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-border">
        <Library size={15} className="text-primary shrink-0" />
        <span className="text-[13px] font-medium flex-1 truncate">Corpus
          {claimsMode ? (claimsTotal !== null ? <span className="text-muted-foreground font-normal nums"> · {claimsTotal}</span> : null)
            : data ? <span className="text-muted-foreground font-normal nums"> · {data.total}</span> : null}</span>
        {claimsOk && (
          <div data-qa="corpus-mode-toggle" className="shrink-0 inline-flex rounded-md border border-border overflow-hidden">
            {(["sources", "claims"] as const).map((m) => (
              <button key={m} type="button" data-qa={"corpus-mode-" + m} onClick={() => setPanelMode(m)} aria-pressed={panelMode === m}
                title={m === "sources" ? "Search papers and notes" : "Search what the papers claim"}
                className={`px-2 py-0.5 text-[11px] transition-colors ${panelMode === m ? "bg-primary/15 text-primary font-medium" : "text-muted-foreground hover:text-foreground hover:bg-accent"}`}>{m === "sources" ? "Sources" : "Claims"}</button>
            ))}
          </div>
        )}
        {!claimsMode && mode === "hybrid" && <span data-qa="corpus-mode" title="Searching by meaning across your citation notes and vault notes" className="shrink-0 text-[9.5px] px-1.5 py-0.5 rounded-full bg-primary/15 text-primary">by meaning</span>}
        {!claimsMode && mode === "lexical" && <span data-qa="corpus-mode" title={search?.reason || "The meaning index isn't available — matching words instead"} className="shrink-0 text-[9.5px] px-1.5 py-0.5 rounded-full border border-border text-muted-foreground">by words</span>}
        {onSide && <button type="button" data-qa="corpus-side" onClick={() => onSide(side === "left" ? "right" : "left")} title={side === "left" ? "Move to the right" : "Move to the left"} aria-label={side === "left" ? "Move corpus to the right" : "Move corpus to the left"} className="inline-flex items-center justify-center w-6 h-6 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent">{side === "left" ? <PanelRight size={15} /> : <PanelLeft size={15} />}</button>}
        <button type="button" onClick={onClose} data-knav-back="2" title="Close the corpus browser" className="inline-flex items-center justify-center w-6 h-6 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent"><X size={15} /></button>
      </div>
      {claimsMode
        ? <ClaimsPanel slug={slug} width={width} roomy={width >= CORPUS_ROOMY} gridOk={width >= CORPUS_GRID}
            actions={actions} citeFor={citeForClaim} onViewSource={onViewSource}
            onUnavailable={claimsGone} onTotal={setClaimsTotal} backRef={claimsBack} />
        : drill
        ? <CorpusDetail item={drill} tokens={tokens} width={width} actions={actions}
            onBack={() => setDrill(null)} onViewSource={onViewSource}
            onCite={(copy) => citeAt(drill, copy)} onCitePage={(p) => citePageAt(drill, p)} />
        : (<>
      <div className="shrink-0 px-3 pt-2 pb-2 border-b border-border/70 space-y-2">
        <div className="relative">
          <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input value={q} onChange={(e) => setQ(e.target.value)} data-qa="corpus-search"
            placeholder="Search your corpus and notes — a phrase, a finding, an author…"
            className="w-full pl-7 pr-7 py-1.5 text-[12px] rounded-md border border-border bg-background focus:outline-none focus:border-primary/50" />
          {q && <button onClick={() => setQ("")} title="Clear the search" className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"><X size={13} /></button>}
        </div>
        <div className="flex items-center gap-1.5">
          {!searchMode && (<>
            <span className="text-[10.5px] text-muted-foreground">Sort</span>
            <div className="inline-flex rounded-md border border-border overflow-hidden">
              {SORTS.map((s) => (
                <button key={s.id} onClick={() => setSort(s.id)} title={"Sort by " + s.label}
                  className={`px-2 py-0.5 text-[11px] transition-colors ${sort === s.id ? "bg-primary/15 text-primary font-medium" : "text-muted-foreground hover:text-foreground hover:bg-accent"}`}>{s.label}</button>
              ))}
            </div>
          </>)}
          {searchMode && (
            <div data-qa="corpus-scope" className="inline-flex rounded-md border border-border overflow-hidden">
              {CORPUS_SCOPES.map((s) => (
                <button key={s.id} onClick={() => setScope(s.id)} title={s.tip} aria-pressed={scope.id === s.id} data-qa={"corpus-scope-" + s.id}
                  className={`px-2 py-0.5 text-[11px] transition-colors ${scope.id === s.id ? "bg-primary/15 text-primary font-medium" : "text-muted-foreground hover:text-foreground hover:bg-accent"}`}>{s.label}</button>
              ))}
            </div>
          )}
          <span className="flex-1" />
          <span data-qa="corpus-count" className="shrink-0 whitespace-nowrap text-[10.5px] text-muted-foreground nums">{searchMode ? `${items.length} related` : `${items.length} shown`}</span>
        </div>
        {/* the meaning leg on the wire: a thin line, never a spinner */}
        <div className={`h-px -mb-px rounded ${searching ? "bg-primary/50 animate-pulse" : "bg-transparent"}`} />
        {!searchMode && tagFacets.length > 0 && (
          <div className={`flex flex-wrap gap-1 ${roomy ? "" : "max-h-[54px] overflow-hidden"}`}>
            {activeTag && <button onClick={() => setActiveTag(null)} title="Clear the tag filter" className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded-full bg-primary/15 text-primary"><X size={9} /> {activeTag}</button>}
            {!activeTag && tagFacets.map(([t, n]) => (
              <button key={t} onClick={() => setActiveTag(t)} title={n + " papers tagged " + t}
                className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded-full border border-border text-muted-foreground hover:text-foreground hover:border-primary/50"><Tag size={9} /> {t} <span className="nums opacity-60">{n}</span></button>
            ))}
          </div>
        )}
      </div>
      <div className={`flex-1 min-h-0 overflow-y-auto px-2 py-2 ${grid ? "grid grid-cols-2 gap-1 content-start" : "space-y-1"}`}>
        {loading && !searchMode && <p className={"px-2 text-[12px] text-muted-foreground" + span}>Loading your corpus…</p>}
        {!loading && !searchMode && data && data.index && !data.index.ready && <p className={"px-2 text-[12px] text-amber-500/90" + span}>Citation index isn’t built yet.</p>}
        {!loading && !searchMode && items.length === 0 && <p className={"px-2 text-[12px] text-muted-foreground" + span}>No papers match.</p>}
        {searchMode && search && items.length === 0 && <p className="px-2 text-[12px] text-muted-foreground">Nothing related.</p>}
        {items.map((it) => (
          <div key={it.rel} data-qa="corpus-card" className={`rounded-lg border px-2.5 py-2 transition-colors ${it.cited ? "border-primary/40 bg-primary/[0.05]" : "border-border/70 bg-background/40 hover:border-border"}`}>
            <button onClick={() => setDrill(it)} data-qa="corpus-open"
              title={isVaultNote(it.kind) ? "Open this note here — read it and copy what you need" : "Open this source here — its key points and quotes, ready to cite"}
              className="w-full text-left">
              <div className="flex items-baseline gap-1.5">
                {/* a note says what kind it is; a record says who wrote it and when. A
                    project-corpus note that mirrors a citation says BOTH. */}
                {isVaultNote(it.kind) && <span className="shrink-0 text-[9.5px] px-1 py-px rounded bg-secondary/70 text-muted-foreground">{CORPUS_KIND_LABEL[it.kind] || it.kind}</span>}
                {citeLike(it) && (<>
                  <span className="text-[12px] font-medium text-foreground/90 leading-snug"><Marked text={it.author || it.citekey || it.stem} tokens={tokens} /></span>
                  <span className="text-[11px] text-muted-foreground nums">{it.year || "n.d."}</span>
                </>)}
                {it.cited && <span className="ml-auto shrink-0 inline-flex items-center gap-0.5 text-[9.5px] text-primary" title="Already cited in this manuscript"><Check size={10} /> cited</span>}
              </div>
              <div className={`text-[11.5px] text-muted-foreground leading-snug mt-0.5 ${roomy ? "" : "line-clamp-2"}`}>{it.kind === "draft"
                ? <span data-qa="corpus-draft-name"><span className="text-foreground/90 font-medium"><Marked text={draftName(it)} tokens={tokens} /></span>{draftDoc(it) && <span> · {draftDoc(it)}</span>}</span>
                : it.title ? <Marked text={it.title} tokens={tokens} /> : <span className="italic">untitled</span>}</div>
              {it.best && <Passage p={it.best} tokens={tokens} full={roomy} />}
            </button>
            {it.tags.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1">
                {it.tags.slice(0, roomy ? 6 : 4).map((t) => (
                  <button key={t} onClick={() => setActiveTag(t)} title={"Filter the browse list to " + t} className="text-[9.5px] px-1 py-px rounded bg-secondary/60 text-muted-foreground hover:text-foreground">{t}</button>
                ))}
              </div>
            )}
            <div className="flex items-center gap-2 mt-1.5">
              <button onClick={() => (isPlainNote(it.kind) ? setDrill(it) : onViewSource(it.rel))} data-qa="corpus-card-note"
                title={it.kind === "draft" ? "Read this section here" : isPlainNote(it.kind) ? "Read this note here" : "Open the note in the source viewer"}
                className="inline-flex items-center gap-1 text-[10.5px] text-muted-foreground hover:text-primary"><BookOpen size={11} /> {it.kind === "draft" ? "Read" : "Note"}</button>
              {citeLike(it) && (
                <button onClick={(e) => citeAt(it, e.shiftKey)} data-qa="corpus-card-cite"
                  title={"Cite " + citeOf(it) + " at the caret · Shift-click copies"}
                  className="inline-flex items-center gap-1 text-[10.5px] text-muted-foreground hover:text-primary"><Copy size={11} /> Cite</button>
              )}
            </div>
          </div>
        ))}
        {!searchMode && data && items.length > 0 && data.count >= 600 && <p className={"px-2 pt-1 text-[10px] text-muted-foreground/70" + span}>Showing the first {data.count}. Search to narrow.</p>}
      </div>
      </>)}
    </div>
  );
}

function CorpusDetail({ item, tokens, width, actions, onBack, onViewSource, onCite, onCitePage }:
{ item: CorpusItem; tokens: string[]; width: number; actions: CorpusActions; onBack: () => void;
  onViewSource: (rel: string) => void; onCite: (copy: boolean) => void; onCitePage: (page: string) => void }) {
  // the two halves of this view, which a project-corpus note has BOTH of: a note body to
  // read, and a citation record to cite from.
  const noteBody = isVaultNote(item.kind);
  const recordRel = citeRelOf(item);
  const [detail, setDetail] = useState<CiteDetail | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const matchRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!recordRel) { setDetail(null); return; }
    let live = true; setDetail(null);
    citeDetailCached(recordRel).then((d) => { if (live) setDetail(d || { ok: false }); }).catch(() => live && setDetail({ ok: false }));
    return () => { live = false; };
  }, [recordRel]);
  useEffect(() => {
    const el = matchRef.current;
    if (!el) return;
    const id = requestAnimationFrame(() => { try { el.scrollIntoView({ block: "center" }); } catch { /* no layout */ } });
    return () => cancelAnimationFrame(id);
  }, [detail]);
  // best-effort: a vault note whose matching SECTION is known scrolls to that heading
  // (lib/markdown draws a heading as <div id=slug>, not an <h*>, hence div[id])
  useEffect(() => {
    if (!noteBody || item.best?.field !== "section" || !item.best.heading) return;
    const want = item.best.heading.trim().toLowerCase();
    let tries = 0;
    const tick = () => {
      tries++;
      try {
        const hs = bodyRef.current?.querySelectorAll("h1, h2, h3, h4, h5, h6, div[id]") || [];
        for (const h of Array.from(hs)) {
          if ((h.textContent || "").trim().toLowerCase() === want) { h.scrollIntoView({ block: "start" }); return; }
        }
      } catch { /* the preview has not rendered yet */ }
      if (tries < 12) window.setTimeout(tick, 120);
    };
    const t = window.setTimeout(tick, 120);
    return () => window.clearTimeout(t);
  }, [noteBody, item.best, item.rel]);
  // a draft usually matches in more than one section: each is a jump inside the reader
  const sections = item.kind !== "draft" ? [] : [...new Set(item.passages.map((p) => (p.heading || "").trim()).filter(Boolean))];
  const jumpTo = (heading: string) => {
    const want = heading.toLowerCase();
    try {
      for (const h of Array.from(bodyRef.current?.querySelectorAll("h1, h2, h3, h4, h5, h6, div[id]") || [])) {
        if ((h.textContent || "").trim().toLowerCase() === want) { h.scrollIntoView({ block: "start" }); return; }
      }
    } catch { /* no layout */ }
  };

  const quotes = (detail?.quotes || []).filter((x) => x && typeof x.text === "string");
  const keyPoints = (detail?.keyPoints || []).filter((x) => typeof x === "string");
  const bestQuote = item.best?.field === "quote" ? item.best.text.slice(0, 60) : "";
  const bestKey = item.best?.field === "key" ? item.best.text.slice(0, 60) : "";
  const pdfPage = item.best?.page || quotes.find((x) => x.page)?.page || "";
  const roomy = width >= CORPUS_ROOMY;

  return (
    <div data-qa="corpus-drill" className="flex-1 min-h-0 flex flex-col">
      <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-border/70">
        <button type="button" onClick={onBack} data-knav-back="3" data-qa="corpus-back" title="Back to the list (Esc)"
          className="shrink-0 inline-flex items-center gap-1 text-[11.5px] text-muted-foreground hover:text-foreground"><ChevronLeft size={13} /> Back</button>
        {/* a draft's name and section ride this bar, outside the scroller: the body jumps
            straight to the matched section and the header must not scroll away with it */}
        {item.kind === "draft" && (
          <div data-qa="corpus-draft-head" className="min-w-0 flex-1 flex items-baseline gap-1.5 text-[12px] leading-snug"
            title={[draftName(item), draftDoc(item), item.best?.heading].filter(Boolean).join(" · ")}>
            <span className="shrink-0 text-[9.5px] px-1 py-px rounded bg-secondary/70 text-muted-foreground">{CORPUS_KIND_LABEL.draft}</span>
            <span className="min-w-0 truncate"><span className="font-medium text-foreground/90">{draftName(item)}</span>{draftDoc(item) && <span className="text-muted-foreground"> · {draftDoc(item)}</span>}
              {item.best?.heading && <span className="text-muted-foreground"> · {item.best.heading}</span>}</span>
          </div>
        )}
      </div>
      <div ref={bodyRef} className="flex-1 min-h-0 overflow-y-auto px-3 py-2.5">
        <div className="flex items-baseline gap-1.5 flex-wrap">
          {noteBody && item.kind !== "draft" && <span className="shrink-0 text-[9.5px] px-1 py-px rounded bg-secondary/70 text-muted-foreground">{CORPUS_KIND_LABEL[item.kind] || item.kind}</span>}
          {recordRel && (<>
            <span className="text-[12.5px] font-medium text-foreground/90">{item.author || item.citekey || item.stem}</span>
            <span className="text-[11.5px] text-muted-foreground nums">{item.year || "n.d."}</span>
          </>)}
        </div>
        {item.kind !== "draft" && <div className="text-[12.5px] text-foreground/90 leading-snug mt-0.5">{item.title || <span className="italic text-muted-foreground">untitled</span>}</div>}
        {detail?.citation && <p className="mt-1 text-[11px] text-foreground/70 leading-snug pl-3 -indent-3"><RefText text={detail.citation} /></p>}

        <div className="flex items-center gap-2.5 mt-2 pb-2 border-b border-border/60">
          {recordRel && <button onClick={(e) => onCite(e.shiftKey)} data-qa="corpus-detail-cite" title="Cite at the caret · Shift-click copies"
            className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-primary"><Copy size={11} /> Cite</button>}
          {item.kind === "draft" ? null : noteBody && !recordRel
            ? <button onClick={() => { void openFile(item.rel); }} title="Open this note in Obsidian" className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-primary"><ExternalLink size={11} /> Open in Obsidian</button>
            : <button onClick={() => onViewSource(item.rel)} title="Open the full note in the source viewer" className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-primary"><BookOpen size={11} /> Open note</button>}
          {/* a corpus note mirrors a citation note: this is the paper it was written from */}
          {noteBody && recordRel && <button onClick={() => onViewSource(recordRel)} data-qa="corpus-source" title="Open the citation note this corpus note was written from"
            className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-primary"><Quote size={11} /> Source</button>}
          {noteBody && !recordRel && item.best && <button onClick={() => copyToClipboard(item.best?.text || "", "Copied the passage")} title="Copy the matching passage" className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-primary"><Copy size={11} /> Copy passage</button>}
          {recordRel && pdfPage && <button onClick={() => actions.openPdf(recordRel, pdfPage)} title={"Open the PDF at page " + pdfPage} className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-primary"><FileText size={11} /> PDF</button>}
        </div>

        {sections.length > 1 && (
          <div data-qa="corpus-draft-sections" className="mt-2 flex flex-wrap gap-1">
            {sections.map((h) => (
              <button key={h} onClick={() => jumpTo(h)} title={"Go to " + h}
                className="max-w-full truncate text-[10px] px-1.5 py-0.5 rounded-full border border-border text-muted-foreground hover:text-foreground hover:border-primary/50">{h}</button>
            ))}
          </div>
        )}
        {noteBody && (
          <div data-qa="corpus-preview" className="mt-2">
            <NotePreview path={item.rel} title={item.kind === "draft" ? draftName(item) : item.title || item.stem} className="min-h-[220px]" />
          </div>
        )}

        {recordRel && !detail && <div className="mt-3 h-px rounded bg-primary/50 animate-pulse" />}
        {recordRel && detail && keyPoints.length > 0 && (
          <div className="mt-2.5">
            <div className="text-[10px] uppercase tracking-[0.1em] text-muted-foreground/70">Key points</div>
            {keyPoints.map((k, i) => {
              const isMatch = !!bestKey && k.startsWith(bestKey);
              return (
                <div key={i} ref={isMatch ? matchRef : undefined}
                  className={`mt-1 flex items-start gap-1.5 ${isMatch ? "border-l-2 border-primary/60 pl-2" : "pl-0"}`}>
                  <span className={`flex-1 text-[11px] text-muted-foreground leading-snug ${roomy ? "" : "line-clamp-4"}`}><Marked text={k} tokens={tokens} /></span>
                  <button onClick={(e) => onCite(e.shiftKey)} title="Cite this source at the caret · Shift-click copies"
                    className="shrink-0 text-[10px] text-muted-foreground hover:text-primary">Cite</button>
                </div>
              );
            })}
          </div>
        )}
        {recordRel && detail && quotes.length > 0 && (
          <div className="mt-3">
            <div className="text-[10px] uppercase tracking-[0.1em] text-muted-foreground/70">Quotes</div>
            {quotes.map((qt, i) => {
              const isMatch = !!bestQuote && qt.text.startsWith(bestQuote);
              return (
                <div key={i} ref={isMatch ? matchRef : undefined} data-qa="corpus-quote"
                  className={`mt-1.5 ${isMatch ? "border-l-2 border-primary/60 pl-2" : "pl-0"}`}>
                  <div className="flex items-start gap-1.5">
                    {qt.page && <span className="shrink-0 text-[9.5px] px-1 py-px rounded bg-secondary/70 text-muted-foreground nums">p. {qt.page}</span>}
                    <span className={`text-[11px] font-serif italic text-foreground/85 leading-snug ${roomy ? "" : "line-clamp-4"}`}><Marked text={qt.text} tokens={tokens} /></span>
                  </div>
                  <div className="flex items-center gap-2.5 mt-0.5 pl-0.5">
                    {qt.page && <button onClick={() => onCitePage(qt.page as string)} data-qa="corpus-cite-page" title={"Cite this source at page " + qt.page + ", at the caret"}
                      className="text-[10px] text-muted-foreground hover:text-primary">Cite p.</button>}
                    <button onClick={() => actions.insertQuote(corpusHit(item), qt)} data-qa="corpus-insert-quote"
                      title="Insert the quotation, verified word for word against the live note"
                      className="text-[10px] text-muted-foreground hover:text-primary">Insert quote</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {recordRel && detail && keyPoints.length === 0 && quotes.length === 0 && <p className="mt-3 text-[11.5px] text-muted-foreground">No key points or quotes marked in this note.</p>}
      </div>
    </div>
  );
}

function StemThumb({ slug, stem, kind, onOpen, v, stamp }: { slug: string; stem: string; kind: string; onOpen?: () => void; v?: number | null; stamp?: string | null }) {
  const [idx, setIdx] = useState(0);
  // the results stamp wins (it changes exactly when the file does, so a re-rendered
  // figure swaps in); a hand-drawn diagram's save mtime stays the fallback
  const bust = stamp ? "&v=" + encodeURIComponent(stamp) : v ? "&v=" + v : "";
  const urls = kind === "table"
    ? [api.draftingTablePngUrl(slug, stem + ".csv") + bust]
    : [api.draftingAssetUrl(slug, stem + ".png") + bust, api.draftingAssetUrl(slug, stem + ".svg") + bust];
  const inner = idx >= urls.length
    ? <div className="w-16 h-12 flex items-center justify-center text-muted-foreground/60">{kind === "table" ? <ListOrdered size={16} /> : <ImageIcon size={16} />}</div>
    : <img src={urls[idx]} onError={() => setIdx((i) => i + 1)} alt={stem} className="w-16 h-12 object-contain" loading="lazy" />;
  return (
    <button onClick={onOpen} disabled={!onOpen} title={onOpen ? "Open full view — inspect large & comment coordinate by coordinate" : undefined}
      className="group relative shrink-0 rounded border border-border/60 bg-white overflow-hidden disabled:cursor-default">
      {inner}
      {onOpen && <span className="absolute inset-0 hidden group-hover:flex items-center justify-center bg-black/40 text-white"><Maximize2 size={14} /></span>}
    </button>
  );
}

function CopyAssetButton({ slug, stem, kind }: { slug: string; stem: string; kind: string }) {
  const [st, setSt] = useState<"idle" | "busy" | "ok" | "err">("idle");
  const candidates = kind === "table"
    ? [api.draftingTablePngUrl(slug, stem + ".csv")]
    : [api.draftingAssetUrl(slug, stem + ".png"), api.draftingAssetUrl(slug, stem + ".svg")];
  const onClick = () => {
    if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") { toast.error("Copying images isn't supported here"); return; }
    setSt("busy");
    // construct the ClipboardItem synchronously with the blob PROMISE so the write stays
    // inside the click's user-activation window (no await before the write call)
    navigator.clipboard.write([new ClipboardItem({ "image/png": figureToPngBlob(candidates) })])
      .then(() => { setSt("ok"); toast.success(kind === "table" ? "Table copied — paste it to a co-author" : "Figure copied — paste it to a co-author"); })
      .catch(() => { setSt("err"); toast.error("Couldn't copy the image"); })
      .finally(() => setTimeout(() => setSt("idle"), 1400));
  };
  return (
    <button onClick={onClick} disabled={st === "busy"} title="Copy image to clipboard — paste it straight to a co-author"
      className={`inline-flex items-center gap-1 text-[10.5px] ${st === "ok" ? "text-emerald-600 dark:text-emerald-400" : st === "err" ? "text-rose-600 dark:text-rose-400" : "text-muted-foreground hover:text-primary"}`}>
      {st === "busy" ? <Loader2 size={11} className="animate-spin" /> : st === "ok" ? <Check size={11} /> : st === "err" ? <X size={11} /> : <Copy size={11} />} Copy
    </button>
  );
}

function ReplicationBrowser({ slug, prov, onViewFile, onOpenLightbox }: {
  slug: string; prov?: DraftProvenance | null;
  onViewFile: (candidates: string[], title: string) => void;
  onOpenLightbox?: (stem: string, kind: "figure" | "table") => void;
}) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<DraftReplicationFiles | null>(null);
  useEffect(() => {
    if (!open || data) return;
    let live = true;
    api.draftingReplicationFiles(slug).then((r) => { if (live) setData(r); });
    return () => { live = false; };
  }, [open, slug, data]);
  const scriptsByDir = useMemo(() => {
    const m = new Map<string, DraftReplScript[]>();
    for (const s of data?.scripts ?? []) {
      if (!m.has(s.dir)) m.set(s.dir, []);
      m.get(s.dir)!.push(s);
    }
    return [...m.entries()];
  }, [data]);
  // what each script produced, from provenance.json (entry.script -> stems)
  const outputsByScript = useMemo(() => {
    const m = new Map<string, { stem: string; kind: "figure" | "table" }[]>();
    for (const [stem, e] of Object.entries(prov?.entries ?? {})) {
      if (!e.script) continue;
      const k = e.script.replace(/^\.\//, "");
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push({ stem, kind: e.kind === "table" ? "table" : "figure" });
    }
    return m;
  }, [prov]);
  return (
    <div className="shrink-0 border-b border-border/70">
      <div className="flex items-center pr-1.5">
        <button onClick={() => setOpen((o) => !o)}
          className="flex-1 min-w-0 flex items-center gap-1.5 px-2 py-1.5 text-[10px] uppercase tracking-wide text-muted-foreground/70 hover:text-muted-foreground">
          {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          Scripts &amp; data
          {data?.scripts && <span className="normal-case tracking-normal nums">· {data.scripts.length} script{data.scripts.length === 1 ? "" : "s"}</span>}
        </button>
      </div>
      {open && (
        <div className="px-2 pb-2 space-y-2 max-h-[45vh] overflow-y-auto">
          {!data && <p className="px-2 text-[11px] text-muted-foreground">Reading replication/…</p>}
          {data && !data.hasReplication && <p className="px-2 text-[11px] text-muted-foreground">No replication/ folder in this project.</p>}
          {data?.hasReplication && (
            <>
              <div className="rounded-md border border-border/60 bg-background/40 divide-y divide-border/40">
                {scriptsByDir.length === 0 && <p className="px-2 py-1.5 text-[10.5px] text-muted-foreground">No scripts found under replication/.</p>}
                {scriptsByDir.map(([dir, list]) => (
                  <div key={dir} className="px-2 py-1">
                    <p className="text-[9.5px] font-mono text-muted-foreground/70 truncate mb-0.5" title={dir}>{dir}/</p>
                    {list.map((s) => {
                      const outs = outputsByScript.get(s.rel) ?? [];
                      return (
                        <div key={s.rel} data-script-row={s.rel} className="flex items-center gap-1 w-full text-[10.5px] text-muted-foreground py-px">
                          <button onClick={() => onViewFile([s.rel], s.name)} title={"View " + s.rel}
                            className="flex items-center gap-1 min-w-0 flex-1 text-left hover:text-primary">
                            <FileCode size={10} className="shrink-0" />
                            <span className="font-mono truncate">{s.name}</span>
                          </button>
                          {outs.slice(0, 2).map((o) => (
                            <button key={o.stem} onClick={() => onOpenLightbox?.(o.stem, o.kind)} title={"Open " + o.stem}
                              className="shrink-0 text-[9px] font-mono px-1 rounded bg-secondary/70 hover:bg-primary/15 hover:text-primary">
                              {o.stem.split(".").slice(0, 2).join(".")}
                            </button>
                          ))}
                          {outs.length > 2 && <span className="shrink-0 text-[9px] text-muted-foreground/60 nums" title={outs.slice(2).map((o) => o.stem).join("\n")}>+{outs.length - 2}</span>}
                          <span className="text-muted-foreground/50 shrink-0 nums">{fmtBytes(s.size)}</span>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
              {(data.dataDirs ?? []).length > 0 && (
                <div>
                  <p className="px-1 pb-1 text-[9.5px] uppercase tracking-wide text-muted-foreground/60">Where the data lives</p>
                  <div className="space-y-0.5">
                    {(data.dataDirs ?? []).map((d) => (
                      <div key={d.rel} className="flex items-center gap-1.5 px-1 text-[10.5px]">
                        <Database size={10} className="shrink-0 text-muted-foreground" />
                        <span className="font-mono text-foreground/85 truncate" title={d.rel}>{d.rel}/</span>
                        <span className="text-muted-foreground/60 nums shrink-0 ml-auto">{d.fileCount} file{d.fileCount === 1 ? "" : "s"}{d.exts.length ? " · " + d.exts.join(" ") : ""}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {(data.dataRefs ?? []).length > 0 && (
                <div>
                  <p className="px-1 pb-1 text-[9.5px] uppercase tracking-wide text-muted-foreground/60" title="Grep'd verbatim from the scripts — read_dta/read_csv/fread calls and *_DIR/*_PATH assignments">Data references in code</p>
                  <div className="rounded-md border border-border/60 bg-background/40 divide-y divide-border/40">
                    {(data.dataRefs ?? []).map((r, i) => (
                      <button key={i} onClick={() => onViewFile([r.rel], r.rel.split("/").pop()!)} title={"Open " + r.rel + ":" + r.line}
                        className="w-full text-left px-2 py-1 text-[10px] hover:bg-accent">
                        <div className="text-muted-foreground/70 font-mono nums">{r.rel}:{r.line}</div>
                        <div className="font-mono text-foreground/80 truncate">{r.text}</div>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

const FRESH_CHIP: Record<string, string> = {
  fresh: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  stale: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  unrecorded: "bg-muted text-muted-foreground",
  missing: "bg-rose-500/15 text-rose-600 dark:text-rose-400",
};
function NumbersSection({ slug, docName, onJumpToLine, onViewFile, tick, openTick, onInsertNumber }: {
  slug: string; docName: string;
  onJumpToLine: (doc: string, line: number) => void;
  onViewFile: (candidates: string[], title: string) => void;
  tick?: number; openTick?: number; onInsertNumber?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [rep, setRep] = useState<DraftNumbers | null>(null);
  const [loading, setLoading] = useState(false);
  const [showUnbound, setShowUnbound] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    try { setRep(await api.draftingNumbers(slug, docName)); }
    catch { setRep({ error: "numbers report unreachable" }); }
    finally { setLoading(false); }
  }, [slug, docName]);
  useEffect(() => { setRep(null); setOpen(false); setShowUnbound(false); }, [slug]);
  // an Insert-number bind just happened -> re-check (only when the section is showing)
  useEffect(() => { if (tick && open) void load(); }, [tick]); // eslint-disable-line react-hooks/exhaustive-deps
  // the Integrity header's "inserted numbers to update" row expands this section
  useEffect(() => { if (!openTick) return; setOpen(true); if (!loading) void load(); }, [openTick]); // eslint-disable-line react-hooks/exhaustive-deps
  const jumpDoc = (name: string) => (name.toLowerCase() === "readme.md" ? "readme.md" : name);
  const docs = rep?.docs ?? {};
  const names = Object.keys(docs).filter((n) => ((docs[n].results?.length ?? 0) + (docs[n].unbound?.length ?? 0)) > 0);
  const entryRow = (name: string, r: NumbersEntryRow, i: number) => {
    const chip = numberStatusChip(r);
    const sChip = numberScriptChip(r);
    const drift = !!r.inserted && r.status === "DRIFT";
    return (
    <div key={i} data-qa="numbers-row" className="px-2 py-1 text-[10.5px] leading-snug">
      <div className="flex items-center gap-1.5">
        {r.key && <Star size={10} className="text-amber-500 fill-current shrink-0" />}
        <span title={chip.hint} className={`text-[9px] px-1.5 py-px rounded-full font-semibold shrink-0 ${chip.cls}`}>{chip.label}</span>
        {drift ? (
          <span data-qa="numbers-drift" title={chip.hint} className="font-mono nums shrink-0">
            <span className="text-muted-foreground line-through">{r.written}</span>
            <span className="text-muted-foreground/70"> → </span>
            <span className="text-rose-600 dark:text-rose-400 font-semibold">{r.current ?? "?"}</span>
          </span>
        ) : (
          <span className="font-mono text-foreground/90 nums shrink-0">{r.written}</span>
        )}
        {sChip && <span title={sChip.hint} className={`text-[9px] px-1.5 py-px rounded-full font-semibold shrink-0 ${sChip.cls}`}>{sChip.label}</span>}
        <span className="text-muted-foreground truncate" title={r.note || r.id || ""}>{r.note || r.id}</span>
        {r.sourceChanged && <span title="the source table changed since this number was inserted — open Insert number › In this paper to re-check and re-snapshot" className="text-[9px] px-1.5 py-px rounded-full font-semibold shrink-0 bg-amber-500/15 text-amber-600 dark:text-amber-400">table changed</span>}
        {r.provenance?.freshness && r.provenance.freshness !== "unrecorded" && (
          <span title={r.provenance.freshness === "fresh" ? "provenance hash matches the table on disk" : r.provenance.freshness === "stale" ? "the table changed after its provenance was recorded" : "source file missing"}
            className={`text-[9px] px-1.5 py-px rounded-full font-semibold shrink-0 ${FRESH_CHIP[r.provenance.freshness] || FRESH_CHIP.unrecorded}`}>{r.provenance.freshness}</span>
        )}
        {typeof r.line === "number" && (
          <button onClick={() => onJumpToLine(jumpDoc(name), r.line!)} title="Jump to the quoted span" className="ml-auto shrink-0 text-primary hover:underline">Jump</button>
        )}
      </div>
      {r.file && (
        <button onClick={() => onViewFile([r.file!, "replication/" + r.file!, "replication/output/" + r.file!.split("/").pop()!], r.file!.split("/").pop()!)}
          title={"View source — " + r.file + (r.column ? " [" + r.column + "]" : "")}
          className="flex items-center gap-1 mt-0.5 text-muted-foreground hover:text-primary max-w-full">
          <Database size={10} className="shrink-0" /><span className="font-mono truncate">{r.file.split("/").pop()}{r.column ? " · " + r.column : ""}</span></button>
      )}
      {r.status !== "TRACED" && <p className={`mt-0.5 ${r.inserted ? "text-rose-600 dark:text-rose-400" : "text-muted-foreground"}`}>{r.msg}</p>}
    </div>
    );
  };
  return (
    <div className="shrink-0 border-b border-border/70 px-2 py-1.5">
      <button onClick={() => { const next = !open; setOpen(next); if (next && !rep && !loading) void load(); }}
        title="Every bound in-text statistic against the source CSVs. The verdicts that matter are the numbers you inserted from the Results pane — only those refuse Publish; agent-authored bindings are advisory"
        className="flex items-center gap-2 w-full px-2 text-left">
        <p className="text-[10px] uppercase tracking-wide text-muted-foreground/70 flex-1">Numbers</p>
        {rep && !rep.error && (
          <span className={`text-[10px] nums px-1.5 rounded-full ${(rep.failing ?? 0) > 0 ? "bg-rose-500/15 text-rose-600 dark:text-rose-400" : rep.bound ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" : "bg-amber-500/15 text-amber-600 dark:text-amber-400"}`}>
            {(rep.failing ?? 0) > 0 ? `${rep.failing} to update` : rep.bound ? `${rep.traced ?? 0} traced` : "unbound"}</span>
        )}
        {loading ? <Loader2 size={11} className="animate-spin text-muted-foreground" /> : (open ? <ChevronDown size={12} className="text-muted-foreground" /> : <ChevronRight size={12} className="text-muted-foreground" />)}
      </button>
      {open && rep && !rep.error && (
        <div className="mt-1 max-h-72 overflow-y-auto space-y-1">
          <div className="flex items-center px-2">
            <p className="text-[10px] text-muted-foreground/70 flex-1 nums">{rep.traced ?? 0} traced · {rep.failing ?? 0} to update · {rep.advisoryCount ?? 0} advisory · {rep.unboundTotal ?? 0} unbound</p>
            {onInsertNumber && <button onClick={onInsertNumber} title="Insert number — pick a cell from the result tables, choose its display format, bind it" className="inline-flex items-center justify-center w-5 h-5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent"><Sigma size={11} /></button>}
            <button onClick={() => void load()} title="Re-check every binding against the source CSVs" className="inline-flex items-center justify-center w-5 h-5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent"><RefreshCw size={11} /></button>
          </div>
          {rep.bound === false && (
            <p className="mx-2 px-2 py-1 rounded-md bg-amber-500/10 text-[10.5px] text-amber-600 dark:text-amber-400">
              No numbers.json bindings yet — this manuscript's statistics are not covered by the numbers gate.</p>
          )}
          {names.map((name) => (
            <div key={name}>
              {names.length > 1 && <p className="px-2 pt-1 text-[9.5px] uppercase tracking-wide text-muted-foreground/60">{name}</p>}
              {(docs[name].results?.length ?? 0) > 0 && (
                <div className="mx-2 rounded-md border border-border/60 bg-background/50 divide-y divide-border/40">
                  {[...docs[name].results].sort(compareNumberRows).map((r, i) => entryRow(name, r, i))}
                </div>
              )}
            </div>
          ))}
          {(rep.unboundTotal ?? 0) > 0 && (
            <div className="mx-2 pb-0.5">
              <button onClick={() => setShowUnbound(!showUnbound)} className="text-[10.5px] text-muted-foreground hover:text-foreground">
                {showUnbound ? "hide" : "show"} unbound numbers (advisory) · {rep.unboundTotal}</button>
              {showUnbound && names.map((name) => (docs[name].unbound || []).filter((u) => u.token).map((u, i) => (
                <div key={name + i} className="flex items-start gap-1.5 px-1 py-0.5 text-[10px] leading-snug">
                  <span className="font-mono text-amber-600 dark:text-amber-400 nums shrink-0">{u.token}</span>
                  <span className="text-muted-foreground truncate">{u.context}</span>
                  <button onClick={() => onJumpToLine(jumpDoc(name), u.line)} className="ml-auto shrink-0 text-primary hover:underline">Jump</button>
                </div>
              )))}
            </div>
          )}
        </div>
      )}
      {open && rep?.error && <p className="mx-2 mt-1 text-[10.5px] text-muted-foreground">numbers report failed: {rep.error}</p>}
    </div>
  );
}

function ResultsPanel({ slug, docName, prov, assetStamps, citesUnresolved, flagsOpen, figComments, onClose, onRefresh, onJumpToLine, onViewFile, onOpenReferences, onShowFlags, onInsertEmbed, onOpenLightbox, onNewDiagram, onEditDiagram, numbersTick, onInsertNumber, onInsertCell, wide, onWide }: {
  slug: string; docName: string; prov: DraftProvenance | null; citesUnresolved: number; flagsOpen: number;
  // results/ freshness stamps by FILE NAME (/drafting/doc-status); empty until the
  // server carries them, and then every thumb re-fetches only when its file changed
  assetStamps?: Record<string, string>;
  // Insert-number: bumps after every bind so the Numbers section re-checks; opens the picker
  numbersTick?: number; onInsertNumber?: () => void;
  figComments: Record<string, FigureComment[]>; onClose: () => void; onRefresh: () => void;
  onJumpToLine: (doc: string, line: number) => void;
  onViewFile: (candidates: string[], title: string) => void;
  onOpenReferences: () => void; onShowFlags: () => void;
  onInsertEmbed: (stem: string, kind: string) => void; onOpenLightbox: (stem: string, kind: "figure" | "table") => void;
  // hand-drawn concept diagrams (draw.io): start a new one / reopen a stem's .drawio source
  onNewDiagram: () => void; onEditDiagram: (stem: string) => void;
  // Findings tab: open the Insert-number composer already standing on one cell, and
  // the wide-dock state (the dock takes the comment rail's width when it is empty)
  onInsertCell?: (cell: FindingCell) => void; wide: boolean; onWide: (v: boolean) => void;
}) {
  // the dock's scroll area is a two-way swap: the results/ asset cards, or the
  // thematic Findings catalogue. The Integrity header above it never moves.
  const [tab, setTab] = usePersistent<"assets" | "findings">("aioa-drafting-results-tab", "assets");
  
  const [assetSrc, setAssetSrc] = usePersistent<"project" | "open">("aioa-drafting-assets-source", "project");
  const openList = useStoreIndex(tab === "assets" && assetSrc === "open");
  const [openId, setOpenId] = useState<string | null>(null);
  const [findCounts, setFindCounts] = useState<{ findings: number; drift: number } | null>(null);
  // the one-click deterministic gate suite (POST /drafting/verify) — the same
  // checks the Publish gates refuse on, runnable on demand, no LLM in the loop.
  const [verify, setVerify] = useState<DraftVerify | null>(null);
  const [verifying, setVerifying] = useState(false);
  const runVerify = useCallback(async () => {
    setVerifying(true);
    try { setVerify(await api.draftingVerify(slug, docName)); }
    catch { setVerify({ error: "verify unreachable" }); }
    finally { setVerifying(false); }
  }, [slug, docName]);
  // the workbench is a dock: a layer over it (the figure viewer, a file viewer) takes Escape
  // first, since window capture listeners fire in the order they were added
  const rootRef = useRef<HTMLDivElement>(null);
  // the control that opened the workbench: after a nested layer closed, the engine's own
  // opener memory points inside the workbench, so Escape hands focus back from here
  const openerRef = useRef<HTMLElement | null>(null);
  useEffect(() => { const a = document.activeElement as HTMLElement | null; openerRef.current = a && a !== document.body ? a : null; }, []);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || typingEscape(e) || layerAbove(rootRef.current)) return;
      e.preventDefault(); e.stopPropagation();
      const back = openerRef.current;
      onClose();
      if (back) window.setTimeout(() => { if (back.isConnected) back.focus({ preventScroll: true }); }, 0);
    };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [onClose]);
  const entries = prov?.entries ?? {};
  const embeds = prov?.embeds ?? [];
  const stems = Object.keys(entries).sort();
  const problems = embeds.filter((e) => !e.exempt && (!e.resolved || e.provenance === "stale" || e.provenance === "none"));
  const embedsOf = (stem: string) => embeds.filter((e) => e.stem === stem);
  const openFigComments = (stem: string) => (figComments[stem] || []).filter((c) => !c.resolved).length;
  // "inserted numbers to update" -> open the Numbers section and land on the first one
  const [numbersOpenTick, setNumbersOpenTick] = useState(0);
  const goToStaleNumber = () => {
    setNumbersOpenTick((t) => t + 1);
    const s = (verify?.numbers?.stale || [])[0];
    if (!s || typeof s.line !== "number") return;
    const d = s.doc || docName;
    onJumpToLine(d.toLowerCase() === "readme.md" ? "readme.md" : d, s.line);
  };
  const row = (label: string, n: number, tone: "rose" | "amber", hint: string, onGo: (() => void) | null) => (
    <button onClick={onGo ?? undefined} disabled={!onGo} title={hint}
      className={`flex items-center gap-2 w-full px-2 py-1 rounded-md text-[11.5px] ${onGo ? "hover:bg-accent" : "cursor-default"}`}>
      <span className={`inline-flex items-center justify-center min-w-[20px] h-[18px] px-1 rounded-full text-[10.5px] font-semibold nums ${n === 0 ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" : tone === "rose" ? "bg-rose-500/15 text-rose-600 dark:text-rose-400" : "bg-amber-500/15 text-amber-600 dark:text-amber-400"}`}>{n}</span>
      <span className={n === 0 ? "text-muted-foreground" : "text-foreground"}>{label}</span>
      {n === 0 && <Check size={11} className="text-emerald-500/80 ml-auto" />}
    </button>
  );
  return (
    <div ref={rootRef} style={{ width: wide ? 380 + RESERVE : 380 }} className="flex flex-col h-full shrink-0 border-l border-border bg-secondary/20">
      <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-border">
        <FlaskConical size={15} className="text-primary shrink-0" />
        <span className="text-[13px] font-medium flex-1 truncate">Results
          {prov ? <span className="text-muted-foreground font-normal nums"> · {stems.length}</span> : null}</span>
        {onInsertNumber && <button onClick={onInsertNumber} data-qa="results-insert-number"
          title="Insert number — search this paper's result tables, pick a cell, choose how it reads (b = 0.12, p < .001, 12.3 per cent, 95% CI); it lands at the caret and is bound to its source cell so a re-run shows as drift"
          className="inline-flex items-center justify-center w-6 h-6 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent"><Sigma size={13} /></button>}
        <button onClick={onNewDiagram} title="New concept diagram — draw a DAG / path model in the pop-out draw.io editor; Save adds it to results/ and embeds it at the cursor" className="inline-flex items-center justify-center w-6 h-6 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent"><PenLine size={13} /></button>
        <button onClick={onRefresh} title="Re-read provenance from disk" className="inline-flex items-center justify-center w-6 h-6 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent"><RefreshCw size={13} /></button>
        <button type="button" onClick={onClose} data-knav-back="2" title="Close the results workbench" className="inline-flex items-center justify-center w-6 h-6 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent"><X size={15} /></button>
      </div>
      <div className="shrink-0 px-2 py-1.5 border-b border-border/70">
        <div className="flex items-center px-2 pb-1">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground/70 flex-1">Integrity</p>
          <button onClick={runVerify} disabled={verifying}
            title="Run the full deterministic gate suite (cites + page-cited quotes + editor sources + numbers + provenance) — exactly what Publish refuses on"
            className="inline-flex items-center gap-1 text-[10.5px] rounded-full border border-border px-2 py-0.5 text-muted-foreground hover:text-foreground hover:bg-accent disabled:opacity-50">
            {verifying ? <Loader2 size={11} className="animate-spin" /> : <ShieldCheck size={11} />} Verify
          </button>
        </div>
        {row("citations unresolved", citesUnresolved, "rose", "In-text cites with no vault note — open the References panel", citesUnresolved > 0 ? onOpenReferences : null)}
        {row("statistics flagged", flagsOpen, "amber", "Open numeric-grounding flags from the checker — show them in the margin", flagsOpen > 0 ? onShowFlags : null)}
        {row("figure/table issues", problems.length, "rose", "Embeds that don't resolve, or whose provenance is stale/missing", null)}
        {verify && !verify.error && (<>
          {row("page-cited quotes failing", verify.proseQuotes?.blocking?.length ?? 0, "rose",
            "A page-cited quotation that contradicts its source note (quote absent, or page disjoint) — Publish refuses these", null)}
          {row("inserted numbers to update", verify.numbers?.failing ?? 0, "rose",
            "numbers you inserted from the Results pane that no longer match their source cell — Publish refuses these",
            (verify.numbers?.failing ?? 0) > 0 ? goToStaleNumber : null)}
          {row("editor sources failing", verify.editorSources?.failing ?? 0, "rose",
            "Attached source lines whose quote/page/link no longer verifies against the live note", null)}
          {row("numbers unbound (advisory)", verify.numbers?.unboundTotal ?? 0, "amber",
            "Numeric tokens in prose with no numbers.json binding — advisory, never blocks; bind them at Stage 8", null)}
          {verify.numbers && !verify.numbers.bound && (
            <p className="mx-2 mb-1 px-2 py-1 rounded-md bg-amber-500/10 text-[10.5px] text-amber-600 dark:text-amber-400">
              No numbers.json binding exists for this project — its statistics are not yet covered by the numbers gate.</p>
          )}
          {(verify.blocking?.length ?? 0) > 0 && (
            <div className="mx-2 mb-1 rounded-md border border-rose-500/30 bg-rose-500/5 px-2 py-1 max-h-40 overflow-y-auto">
              {(verify.blocking || []).slice(0, 20).map((b, i) => (
                <p key={i} className="text-[10.5px] leading-snug text-rose-600 dark:text-rose-400 py-0.5">{b}</p>
              ))}
            </div>
          )}
          {verify.ok && (
            <p className="mx-2 mb-1 px-2 py-1 rounded-md bg-emerald-500/10 text-[10.5px] text-emerald-600 dark:text-emerald-400 inline-flex items-center gap-1">
              <Check size={11} /> all gates pass — Publish will not be blocked</p>
          )}
        </>)}
        {verify?.error && <p className="mx-2 mb-1 text-[10.5px] text-muted-foreground">verify failed: {verify.error}</p>}
        {problems.length > 0 && (
          <div className="mx-2 mb-1 rounded-md border border-border/60 bg-background/50 divide-y divide-border/40">
            {problems.map((e, i) => (
              <div key={i} className="px-2 py-1 text-[10.5px] leading-snug">
                <div className="flex items-center gap-1">
                  <span className="font-mono text-foreground/85 truncate">{e.name}</span>
                  <span className="text-muted-foreground/70 nums shrink-0">{e.doc}:{e.line}</span>
                  <button onClick={() => onJumpToLine(e.doc, e.line)} className="ml-auto shrink-0 text-primary hover:underline">Jump</button>
                </div>
                <div className="text-muted-foreground">
                  {!e.resolved ? "asset not found" : e.provenance === "stale" ? "output changed since recorded — regenerate via the figure script" : "no provenance record"}
                  {e.suggestion && <span> · did you mean <span className="font-mono text-foreground/80">{e.suggestion}</span>?</span>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <NumbersSection slug={slug} docName={docName} onJumpToLine={onJumpToLine} onViewFile={onViewFile} tick={numbersTick} openTick={numbersOpenTick} onInsertNumber={onInsertNumber} />
      <ReplicationBrowser slug={slug} prov={prov} onViewFile={onViewFile} onOpenLightbox={onOpenLightbox} />
      <ResultsTabs tab={tab} onTab={setTab} assets={stems.length} findings={findCounts?.findings ?? null}
        drift={findCounts?.drift ?? 0} wide={wide} onWide={onWide} rootRef={rootRef} />
      {tab === "findings" ? (
        <ResultsFindings slug={slug} onViewFile={onViewFile} onCounts={setFindCounts}
          onInsertCell={(cell) => onInsertCell?.(cell)} />
      ) : (
      <div className="flex-1 min-h-0 overflow-y-auto px-2 py-2 space-y-1.5">
        <div className="flex items-center gap-1 px-0.5 pb-0.5">
          {(["project", "open"] as const).map((sname) => (
            <button key={sname} onClick={() => setAssetSrc(sname)} data-qa={"assets-source-" + sname}
              title={sname === "project" ? "This paper's own results/ assets" : "The shared exploratory figure store the data hub writes"}
              className={`rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors ${assetSrc === sname ? "bg-primary/12 text-primary" : "text-muted-foreground hover:text-foreground"}`}>
              {sname === "project" ? "Project" : "Open"}
              {sname === "open" && openList.length > 0 && <span className="ml-1 nums">{openList.length}</span>}
            </button>
          ))}
        </div>
        {assetSrc === "open" ? (
          <>
            {openList.length === 0 && <p className="px-2 text-[12px] text-muted-foreground">No figures in the shared store yet.</p>}
            {openList.map((f) => (
              <button key={f.id} onClick={() => setOpenId(f.id)} data-qa="assets-open-row"
                title={f.title || f.id}
                className="w-full rounded-lg border border-border/70 bg-background/40 px-2.5 py-2 text-left hover:border-border">
                <span className="block truncate text-[11.5px] font-medium text-foreground/90">{f.title || f.id}</span>
                <span className="mt-1 flex flex-wrap items-center gap-1">
                  <span className="rounded-full bg-secondary px-1.5 py-px text-[9.5px] text-muted-foreground">{f.lane || "—"}</span>
                  <span className="rounded-full border border-border px-1.5 py-px text-[9.5px] text-muted-foreground nums">{f.kind}</span>
                  {f.n_rows > 0 && <span className="text-[9.5px] text-muted-foreground nums">{f.n_rows.toLocaleString()} rows</span>}
                  {f.openComments > 0 && <span className="rounded-full bg-amber-500/15 px-1.5 py-px text-[9.5px] text-amber-600 dark:text-amber-400 nums">{f.openComments} open comment{f.openComments === 1 ? "" : "s"}</span>}
                  {f.forAgent > 0 && <span className="rounded-full bg-primary/15 px-1.5 py-px text-[9.5px] text-primary">for an agent</span>}
                </span>
              </button>
            ))}
          </>
        ) : (<>
        {!prov && <p className="px-2 text-[12px] text-muted-foreground">Reading provenance…</p>}
        {prov && stems.length === 0 && <p className="px-2 text-[12px] text-muted-foreground">No results/ assets in this project.</p>}
        {stems.map((stem) => {
          const e = entries[stem];
          const where = embedsOf(stem);
          const nCmts = openFigComments(stem);
          return (
            <div key={stem} className="rounded-lg border border-border/70 bg-background/40 hover:border-border px-2.5 py-2">
              <div className="flex items-start gap-2">
                <StemThumb slug={slug} stem={stem} kind={e.kind} v={e.diagram} stamp={e.kind === "table" ? null : assetStamps?.[stem + ".png"]} onOpen={() => onOpenLightbox(stem, e.kind === "table" ? "table" : "figure")} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[11.5px] font-mono font-medium text-foreground/90 truncate">{stem}</span>
                    <ProvChip status={e.status} />
                  </div>
                  {e.caption && <p className="text-[10.5px] text-muted-foreground leading-snug mt-0.5 line-clamp-2">{e.caption}</p>}
                  <div className="flex flex-wrap items-center gap-1 mt-1">
                    {where.length === 0 && <span className="text-[9.5px] px-1.5 py-px rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400" title="In results/ but not embedded in the manuscript or the appendix">unembedded</span>}
                    {where.map((w, i) => (
                      <button key={i} onClick={() => onJumpToLine(w.doc, w.line)} title={"Jump to the embed in " + w.doc}
                        className="text-[9.5px] px-1.5 py-px rounded-full border border-border text-muted-foreground hover:text-foreground hover:border-primary/50 nums">{w.doc}:{w.line}</button>
                    ))}
                    {nCmts > 0 && <span className="text-[9.5px] px-1.5 py-px rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400 nums">{nCmts} open comment{nCmts === 1 ? "" : "s"}</span>}
                  </div>
                </div>
              </div>
              <div className="mt-1.5 space-y-0.5 text-[10.5px] leading-snug">
                {e.script
                  ? <button onClick={() => onViewFile([e.script!], e.script!.split("/").pop()!)} title={"View the producing script — " + e.script} className="flex items-center gap-1 text-muted-foreground hover:text-primary max-w-full"><FileCode size={11} className="shrink-0" /><span className="font-mono truncate">{e.script.split("/").pop()}</span>{e.generatedBy === "backfill" && !e.verified && <span className="text-muted-foreground/60 shrink-0">(attributed by backfill — unverified)</span>}</button>
                  : <p className="flex items-center gap-1 text-muted-foreground/70"><FileCode size={11} className="shrink-0" /> producing script unknown{e.manualNote ? " — " + e.manualNote : ""}</p>}
                {(e.dataSources || []).map((d, i) => (
                  <button key={i} onClick={() => onViewFile([d, "replication/" + d, "replication/output/" + d.split("/").pop()!], d.split("/").pop()!)} title={"View data — " + d} className="flex items-center gap-1 text-muted-foreground hover:text-primary max-w-full"><Database size={11} className="shrink-0" /><span className="font-mono truncate">{d}</span></button>
                ))}
                {(e.commit || e.generated) && (
                  <p className="text-muted-foreground/70 nums">{e.commit ? "commit " + e.commit : ""}{e.commit && e.generated ? " · " : ""}{e.generated ? new Date(e.generated).toLocaleDateString() : ""}{Object.entries(e.freshness).filter(([, v]) => v !== "fresh").map(([x, v]) => ` · ${x} ${v}`).join("")}</p>
                )}
              </div>
              <div className="flex items-center gap-2 mt-1.5 pt-1.5 border-t border-border/50">
                <button onClick={() => onInsertEmbed(stem, e.kind)} title="Insert this embed at the cursor in the manuscript" className="inline-flex items-center gap-1 text-[10.5px] text-muted-foreground hover:text-primary"><FilePlus2 size={11} /> Insert</button>
                {e.diagram && <button onClick={() => onEditDiagram(stem)} title="Edit diagram — reopen this figure's draw.io source" className="inline-flex items-center gap-1 text-[10.5px] text-muted-foreground hover:text-primary"><PenLine size={11} /> Edit</button>}
                <CopyAssetButton slug={slug} stem={stem} kind={e.kind} />
                {e.notesRel && (e.notesSource === "header" && e.notesScript
                  ? <button onClick={() => onViewFile([e.notesScript!], e.notesScript!.split("/").pop()!)} title={"Read this asset's notes in the header of " + e.notesScript} className="inline-flex items-center gap-1 text-[10.5px] text-muted-foreground hover:text-primary"><BookOpen size={11} /> Notes</button>
                  : <button onClick={() => onViewFile(["results/0.figure_notes.md"], "0.figure_notes.md")} title="Read this asset's rationale in the figure notes" className="inline-flex items-center gap-1 text-[10.5px] text-muted-foreground hover:text-primary"><BookOpen size={11} /> Notes</button>)}
              </div>
            </div>
          );
        })}
        </>)}
      </div>
      )}
      {openId && (
        <StoreFigureViewer id={openId} list={openList} onNavigate={setOpenId} onClose={() => setOpenId(null)} />
      )}
    </div>
  );
}

function ProvenancePopover({ at, prov, onViewFile, onClose }: {
  at: { name: string; x: number; y: number }; prov: DraftProvenance | null;
  onViewFile: (candidates: string[], title: string) => void; onClose: () => void;
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") { if (typingEscape(e)) return; e.preventDefault(); e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [onClose]);
  const embed = prov?.embeds.find((e) => e.name === at.name);
  const entry = embed ? prov?.entries[embed.stem] : undefined;
  const x = Math.min(at.x, (typeof window !== "undefined" ? window.innerWidth : 1200) - 340);
  return createPortal(
    <div role="dialog" aria-modal="true" aria-label="Provenance" data-knav-modal className="fixed inset-0 z-[125]" onMouseDown={onClose}>
      <div className="fixed w-[320px] rounded-lg border border-border bg-card shadow-xl p-3 text-[11.5px] animate-in fade-in duration-100"
        style={{ left: x, top: Math.min(at.y + 6, (typeof window !== "undefined" ? window.innerHeight : 800) - 260) }} onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-1.5 mb-1.5">
          <FlaskConical size={13} className="text-primary shrink-0" />
          <span className="font-mono font-medium truncate flex-1">{embed?.stem ?? at.name}</span>
          {entry && <ProvChip status={entry.status} />}
        </div>
        {!entry ? (
          <p className="text-muted-foreground leading-snug">No provenance record — this asset can't be traced to a script. Regenerate it via the figure script (which records real provenance), or reconstruct a CANDIDATE via<span className="block font-mono text-[10px] mt-1">python3 provenance.py backfill "&lt;project&gt;" --apply</span>then verify it by hand (open the candidate script, confirm it writes this exact output) before it counts as provenance — a backfilled guess reports "no provenance" until you do.</p>
        ) : (
          <div className="space-y-1">
            {entry.generatedBy === "backfill" && !entry.verified && (
              <p className="text-rose-600 dark:text-rose-400 leading-snug">Unverified reconstruction, not recorded provenance — this script/commit below is a heuristic guess. Open the script, confirm it writes this exact stem, then set verified:true in provenance.json (or clear the entry if it's wrong).</p>
            )}
            {entry.script
              ? <button onClick={() => onViewFile([entry.script!], entry.script!.split("/").pop()!)} className="flex items-center gap-1.5 text-muted-foreground hover:text-primary max-w-full"><FileCode size={11} className="shrink-0" /><span className="font-mono truncate">{entry.script}</span></button>
              : <p className="text-muted-foreground/70">producing script unknown{entry.manualNote ? " — " + entry.manualNote : ""}</p>}
            {(entry.dataSources || []).map((d, i) => (
              <button key={i} onClick={() => onViewFile([d, "replication/" + d, "replication/output/" + d.split("/").pop()!], d.split("/").pop()!)} className="flex items-center gap-1.5 text-muted-foreground hover:text-primary max-w-full"><Database size={11} className="shrink-0" /><span className="font-mono truncate">{d}</span></button>
            ))}
            <p className="text-muted-foreground/70 nums">{entry.commit ? "commit " + entry.commit : "no commit"}{entry.generated ? " · " + new Date(entry.generated).toLocaleString() : ""}</p>
            {entry.environment?.python && <p className="text-muted-foreground/60 nums">python {entry.environment.python}{Object.entries(entry.environment.packages || {}).map(([p, v]) => ` · ${p} ${v}`).join("")}</p>}
            {Object.keys(entry.freshness).length > 0 && (
              <p className="nums">{Object.entries(entry.freshness).map(([ext, v]) => (
                <span key={ext} className={`inline-flex items-center gap-1 mr-2 ${v === "fresh" ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"}`}>.{ext} {v}</span>
              ))}</p>
            )}
            {entry.status === "stale" && <p className="text-amber-600 dark:text-amber-400 leading-snug">Output hash differs from the record — the file changed outside the guarded save path. Regenerate it with its producing script.</p>}
            {entry.notesAnchor && <p className="text-muted-foreground/70 leading-snug truncate" title={entry.notesAnchor}>notes: {entry.notesAnchor}</p>}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}

function EmbedIntegrityBanner({ problems, docName, onJump, onRepoint }: {
  problems: DraftProvEmbed[]; docName: string;
  onJump: (doc: string, line: number) => void; onRepoint: (e: DraftProvEmbed) => void;
}) {
  const unresolved = problems.filter((e) => !e.resolved);
  if (unresolved.length === 0) return null;
  return (
    <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-20 w-[min(680px,92%)] rounded-lg border border-amber-500/50 bg-amber-500/10 backdrop-blur px-3 py-2 shadow-lg">
      <p className="text-[11px] font-medium text-amber-700 dark:text-amber-400 mb-1">
        {unresolved.length} embed{unresolved.length === 1 ? "" : "s"} point{unresolved.length === 1 ? "s" : ""} at files that don't exist
      </p>
      <div className="space-y-0.5">
        {unresolved.map((e, i) => (
          <div key={i} className="flex items-center gap-2 text-[11px]">
            <span className="font-mono text-foreground/85 truncate">{e.name}</span>
            <span className="text-muted-foreground/70 nums shrink-0">{e.doc}:{e.line}</span>
            <span className="flex-1" />
            <button onClick={() => onJump(e.doc, e.line)} className="shrink-0 text-primary hover:underline">Jump</button>
            {e.suggestion && e.doc === docName && (
              <button onClick={() => onRepoint(e)} title={"Swap the embed text to " + e.suggestion + " (mechanical, matched by exact text)"}
                className="shrink-0 inline-flex items-center gap-1 rounded-full border border-amber-500/50 px-2 py-px text-amber-700 dark:text-amber-400 hover:bg-amber-500/15">Re-point → <span className="font-mono">{e.suggestion}</span></button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function SupplementIcon({ kind, size = 13 }: { kind: string; size?: number }) {
  if (kind === "cover-letter") return <Mail size={size} />;
  if (kind === "response") return <MessageSquareText size={size} />;
  if (kind === "appendix") return <BookMarked size={size} />;
  return <FileText size={size} />;
}

function SupplementBody({ slug, name, loaded, supps, paperTitle, onSwitch, onReload, onClose }:
{ slug: string; name: string; loaded: DraftSupplementDoc; supps: DraftSupplement[]; paperTitle: string;
  onSwitch: (name: string) => void; onReload: () => void; onClose: () => void }) {
  const ed = useRef<MdEditorHandle>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const doc = useDoc(slug, "paper", loaded.text, loaded.mtime, name, {
    adopt: (sent, merged) => (ed.current?.adoptServerText(sent, merged) ? ed.current.getText() : null),
    onMerged: (text) => ed.current?.setContent(text),
    markSaveStart: (sent) => ed.current?.markSaveStart(sent),
  });
  const hasReview = loaded.kind === "response" && !!loaded.review?.exists;
  const [showReview, setShowReview] = useState(hasReview);
  const [showPdf, setShowPdf] = useState(false);
  const [switchOpen, setSwitchOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [compilingWord, setCompilingWord] = useState(false);
  const words = countWords(doc.text);
  const [selWords, setSelWords] = useState(0);   // words in the highlighted passage

  const compileWord = useCallback(async () => {
    setCompilingWord(true);
    const tid = toast.loading("Compiling the Word document…");
    try {
      doc.flush();
      const r = await api.draftingPublish(slug, name,
        { format: "social-forces", blind: false, endnotes: false, figures: "inline" }, "docx");
      if (r.ok) {
        toast.success("Word document compiled — opening", { id: tid });
        await api.draftingOpenDocx(slug, name);
      } else {
        toast.error(r.error || "Couldn't compile the Word document", { id: tid });
      }
    } catch {
      toast.error("Couldn't compile the Word document", { id: tid });
    } finally {
      setCompilingWord(false);
    }
  }, [slug, name, doc]);

  const create = useCallback(() => {
    setCreating(true);
    api.draftingCreateSupplement(slug, name)
      .then((r) => { if (r.error) toast.error(r.error); else { toast.success(loaded.label + " created"); onReload(); } })
      .catch(() => toast.error("Couldn't create the " + loaded.label.toLowerCase()))
      .finally(() => setCreating(false));
  }, [slug, name, loaded.label, onReload]);

  const pdfSrc = loaded.hasPdf && loaded.pdfName ? api.draftingAssetUrl(slug, loaded.pdfName) + "&t=" + loaded.pdfMtime : "";

  // the same bar the full editor gets, over this pane's own CodeMirror
  const find = useFind({
    enabled: loaded.exists,
    targetKey: "cm",
    makeTarget: () => { const v = ed.current?.getView(); return v ? cmFindTarget(v) : null; },
    rootRef,
    docVersion: doc.text,
    className: "absolute right-4 top-3 z-50",
  });

  return (
    <div ref={rootRef} className="relative flex-1 min-h-0 flex flex-col">
      {find.node}
      <div className="shrink-0 flex items-center gap-2 px-4 py-2 border-b border-border">
        <button type="button" onClick={onClose} data-knav-back="2" className="inline-flex items-center gap-1 text-[12.5px] text-muted-foreground hover:text-foreground" title="Back to the manuscript"><ChevronLeft size={15} /> {paperTitle.length > 28 ? paperTitle.slice(0, 28) + "…" : paperTitle}</button>
        <div className="h-4 w-px bg-border mx-1" />
        <div className="relative shrink-0">
          <button onClick={() => setSwitchOpen((o) => !o)} title="Switch supplement"
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] transition-colors ${switchOpen ? "border-primary/50 text-foreground" : "border-border text-foreground/80 hover:border-primary/50"}`}>
            <SupplementIcon kind={loaded.kind} size={13} /> <span className="font-medium">{loaded.label}</span> <ChevronDown size={12} className="text-muted-foreground" />
          </button>
          {switchOpen && (
            <div className="absolute left-0 top-9 z-30 w-[244px] rounded-lg border border-border bg-card shadow-xl py-1.5" onMouseLeave={() => setSwitchOpen(false)}>
              {supps.map((s) => (
                <button key={s.name} onClick={() => { setSwitchOpen(false); if (s.name !== name) onSwitch(s.name); }}
                  className={`flex items-center gap-2 w-full text-left px-3 py-1.5 text-[12.5px] hover:bg-accent ${s.name === name ? "text-foreground" : "text-muted-foreground hover:text-foreground"}`}>
                  <span className="w-4 shrink-0 text-muted-foreground/70"><SupplementIcon kind={s.kind} size={13} /></span>
                  <span className="flex-1">{s.label}</span>
                  {s.exists ? <span className="text-[10.5px] text-muted-foreground/60 nums">{s.words.toLocaleString()}w</span>
                    : <span className="text-[10px] text-muted-foreground/45">new</span>}
                  {s.name === name && <Check size={12} className="text-primary" />}
                </button>
              ))}
            </div>
          )}
        </div>
        {loaded.exists && <span className="text-[11.5px] text-muted-foreground nums">{selWords > 0 && <span className="text-primary" title="Words in the selected passage">{selWords.toLocaleString()} of </span>}{words.toLocaleString()} words</span>}
        <span className="flex-1" />
        {doc.conflict && <button onClick={() => { const t = doc.reloadFromDisk(); if (t != null) ed.current?.setContent(t); }} className="inline-flex items-center gap-1 text-[11.5px] text-destructive mr-1"><AlertTriangle size={12} /> changed on disk — reload</button>}
        {loaded.exists && <StatusTag status={doc.status} dirty={doc.dirty} />}
        <div className="h-4 w-px bg-border mx-1" />
        {loaded.exists && <IconBtn on={find.open} onClick={find.toggle} title="Find / replace (⌘F) — click again to close"><Search size={15} /></IconBtn>}
        {loaded.exists && <IconBtn onClick={() => api.open(loaded.rel)} title={"Open " + loaded.name + " in Obsidian"}><FileText size={15} /></IconBtn>}
        {hasReview && <button onClick={() => setShowReview((s) => !s)} title="Show the reviewers' comments beside your response" className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] ${showReview ? "border-primary/50 text-foreground" : "border-border text-muted-foreground hover:text-foreground hover:border-primary/50"}`}><Quote size={12} /> Review</button>}
        {loaded.hasPdf && <button onClick={() => setShowPdf((s) => !s)} title="Preview the compiled PDF (recompile with the publish step)" className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] ${showPdf ? "border-primary/50 text-foreground" : "border-border text-muted-foreground hover:text-foreground hover:border-primary/50"}`}><FileOutput size={12} /> PDF</button>}
        {loaded.exists && <button onClick={compileWord} disabled={compilingWord} title="Compile this document to a properly formatted Word (.docx) and open it" className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] border-border text-muted-foreground hover:text-foreground hover:border-primary/50 disabled:opacity-50">{compilingWord ? <Loader2 size={12} className="animate-spin" /> : <FileType2 size={12} />} Word</button>}
      </div>

      {!loaded.exists ? (
        <div className="flex-1 grid place-items-center px-6">
          <div className="max-w-[420px] text-center">
            <div className="mx-auto mb-3 grid place-items-center w-12 h-12 rounded-full bg-primary/10 text-primary"><SupplementIcon kind={loaded.kind} size={22} /></div>
            <h3 className="text-[15px] font-medium" style={{ fontFamily: SERIF }}>No {loaded.label.toLowerCase()} yet</h3>
            <p className="mt-1.5 text-[12.5px] text-muted-foreground leading-snug">Create <code className="text-[11px]">{loaded.name}</code> beside <code className="text-[11px]">paper.md</code> from a starter template{loaded.kind === "response" ? ", then run the response step to fill it from the reviewers' comments" : ""}.</p>
            <button onClick={create} disabled={creating} className="mt-4 inline-flex items-center gap-1.5 rounded-full border border-primary/50 text-primary px-3.5 py-1.5 text-[12.5px] hover:bg-primary/10 disabled:opacity-50">
              {creating ? <Loader2 size={13} className="animate-spin" /> : <FilePlus2 size={13} />} Create {loaded.label.toLowerCase()}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex-1 min-h-0 flex">
          {showReview && hasReview && loaded.review && (
            <div className="w-[40%] min-w-[320px] max-w-[560px] border-r border-border flex flex-col min-h-0 bg-secondary/20">
              <div className="shrink-0 px-4 py-2 border-b border-border/60 flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
                <Quote size={12} className="text-primary/70" /> Reviewers’ comments · <span className="text-foreground/70">{loaded.review.name}</span> <span className="text-muted-foreground/50">read-only</span>
                <span className="flex-1" />
                <button onClick={() => api.open(loaded.review!.rel)} title="Open in Obsidian" className="hover:text-foreground"><ExternalLink size={12} /></button>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 text-[13px]"><Markdown text={loaded.review.text || ""} idPrefix="rev-" /></div>
            </div>
          )}
          <div className="flex-1 min-h-0 overflow-y-auto">
            <div className="mx-auto px-6 py-6" style={{ maxWidth: 840 }}>
              <MarkdownEditor ref={ed} value={loaded.text} onChange={doc.setText} onBlur={doc.flush}
                slug={slug} style="manuscript" zoom={1}
                onSave={() => { doc.flush(); toast.success("Saved"); }}
                onCursor={() => setSelWords(countWords(ed.current?.selectedText() ?? ""))}
                placeholder={`Write the ${loaded.label.toLowerCase()}…`} />
            </div>
          </div>
          {showPdf && loaded.hasPdf && (
            <div className="w-[46%] min-w-[360px] border-l border-border flex flex-col min-h-0 bg-muted/20">
              <div className="shrink-0 px-4 py-2 border-b border-border/60 flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
                <FileOutput size={12} className="text-primary/70" /> Compiled PDF · <span className="text-foreground/70">{loaded.pdfName}</span>
                <span className="flex-1" />
                <button onClick={() => setShowPdf(false)} className="hover:text-foreground"><X size={13} /></button>
              </div>
              <iframe title="supplement pdf" src={pdfSrc} className="flex-1 w-full bg-white" />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SupplementPanel({ slug, name0, paperTitle, onOpenFull, onClose }:
{ slug: string; name0: string; paperTitle: string; onOpenFull: (name: string) => boolean; onClose: () => void }) {
  const [name, setName] = useState(name0);
  const [supps, setSupps] = useState<DraftSupplement[]>([]);
  const [loaded, setLoaded] = useState<DraftSupplementDoc | null>(null);
  const [err, setErr] = useState(false);
  const reloadList = useCallback(() => { api.draftingSupplements(slug).then((r) => setSupps(r.supplements || [])).catch(() => {}); }, [slug]);
  const load = useCallback((nm: string) => {
    setLoaded(null); setErr(false);
    api.draftingSupplement(slug, nm).then((r) => {
      if (r.error) { setErr(true); return; }
      if (r.exists && onOpenFull(nm)) return;   // handed to the full editor
      setLoaded(r);
    }).catch(() => setErr(true));
  }, [slug, onOpenFull]);
  useEffect(() => { reloadList(); }, [reloadList]);
  useEffect(() => { load(name); }, [name, load]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") { if (typingEscape(e)) return; e.preventDefault(); e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [onClose]);
  // the file exists now, so the document belongs in the full editor
  const afterCreate = useCallback(() => { reloadList(); load(name); }, [reloadList, load, name]);
  return createPortal(
    <div role="dialog" aria-modal="true" aria-label="Supplement" data-knav-modal className="fixed inset-0 z-[110] bg-background flex flex-col animate-in fade-in duration-150">
      {!loaded ? (
        <div className="flex-1 min-h-0 flex flex-col">
          <div className="shrink-0 flex items-center gap-2 px-4 py-2 border-b border-border">
            <button type="button" onClick={onClose} data-knav-back="2" className="inline-flex items-center gap-1 text-[12.5px] text-muted-foreground hover:text-foreground"><ChevronLeft size={15} /> Back</button>
          </div>
          <div className="flex-1 grid place-items-center text-[13px] text-muted-foreground">
            {err ? "Couldn’t open this supplement." : <Loader2 size={18} className="animate-spin" />}
          </div>
        </div>
      ) : (
        <SupplementBody key={name + (loaded.exists ? ":y" : ":n")} slug={slug} name={name} loaded={loaded}
          supps={supps} paperTitle={paperTitle} onSwitch={setName} onReload={afterCreate} onClose={onClose} />
      )}
    </div>,
    document.body
  );
}

const PUBLISH_TO_JOURNAL: Record<string, string> = {
  asr: "American Sociological Review",
  ajs: "American Journal of Sociology",
  smh: "society-and-mental-health",
  sage: "Work and Occupations",
  wes: "Work, Employment, and Society",
};

function JournalChecklistPanel({ publish, journalName, onClose }: { publish: string; journalName?: string; onClose: () => void }) {
  const [journals, setJournals] = useState<JournalInfo[] | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [file, setFile] = useState<string>("");          // "" = the journal's default doc
  const [loaded, setLoaded] = useState<JournalChecklist | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    api.draftingJournals().then((r) => {
      const js = r.journals || [];
      setJournals(js);
      const norm = (s: string) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      const byName = journalName && journalName.trim() ? js.find((j) => norm(j.name) === norm(journalName)) : undefined;
      const want = PUBLISH_TO_JOURNAL[publish];
      const pick = byName || (want && js.find((j) => j.name === want)) || js[0];
      setName(pick ? pick.name : null);
    }).catch(() => { setJournals([]); setErr(true); });
  }, [publish, journalName]);
  // (re)load the chosen journal doc; switching journals resets to its default doc
  useEffect(() => {
    if (!name) return;
    setLoaded(null); setErr(false);
    api.draftingJournal(name, file).then((r) => (r.error ? setErr(true) : setLoaded(r))).catch(() => setErr(true));
  }, [name, file]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") { if (typingEscape(e)) return; e.preventDefault(); e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [onClose]);
  const docs = loaded?.docs ?? journals?.find((j) => j.name === name)?.docs ?? [];
  return createPortal(
    <div role="dialog" aria-modal="true" aria-label="Publication checklists" data-knav-modal className="fixed inset-0 z-[110] bg-background flex flex-col animate-in fade-in duration-150">
      <div className="shrink-0 flex items-center gap-2 px-4 py-2 border-b border-border">
        <button type="button" onClick={onClose} data-knav-back="2" className="inline-flex items-center gap-1 text-[12.5px] text-muted-foreground hover:text-foreground"><ChevronLeft size={15} /> Back</button>
        <div className="h-4 w-px bg-border mx-1" />
        <ClipboardCheck size={14} className="text-muted-foreground" />
        <span className="text-[12.5px] font-medium">Publication checklists</span>
        <div className="ml-auto flex items-center gap-2">
          {/* journal picker — every journal in the toolkit */}
          <select value={name ?? ""} onChange={(e) => { setFile(""); setName(e.target.value); }}
            disabled={!journals || journals.length === 0}
            className="rounded-md border border-border bg-card px-2 py-1 text-[12.5px] text-foreground focus:outline-none focus:border-primary/50 max-w-[260px]">
            {(journals ?? []).map((j) => <option key={j.name} value={j.name}>{j.name}</option>)}
          </select>
          {/* which doc within the journal (checklist vs guidelines) — only when >1 */}
          {docs.length > 1 && (
            <select value={file || loaded?.file || ""} onChange={(e) => setFile(e.target.value)}
              className="rounded-md border border-border bg-card px-2 py-1 text-[12.5px] text-foreground focus:outline-none focus:border-primary/50 max-w-[260px]">
              {docs.map((d) => <option key={d.file} value={d.file}>{d.label}</option>)}
            </select>
          )}
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {!journals ? (
          <div className="h-full grid place-items-center text-[13px] text-muted-foreground"><Loader2 size={18} className="animate-spin" /></div>
        ) : journals.length === 0 ? (
          <div className="h-full grid place-items-center text-[13px] text-muted-foreground">No journals in the toolkit knowledge base yet.</div>
        ) : !loaded ? (
          <div className="h-full grid place-items-center text-[13px] text-muted-foreground">{err ? "Couldn’t open this checklist." : <Loader2 size={18} className="animate-spin" />}</div>
        ) : (
          <div className="mx-auto max-w-[780px] px-8 py-8">
            <Markdown text={loaded.markdown || ""} idPrefix="jrnl-" />
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}

const noop = () => {};
const CARD_W = 340, GUTTER = 48, SHEET_OVERHANG = 44, RESERVE = CARD_W + GUTTER + SHEET_OVERHANG + 12;

function useWideViewport() {
  const [wide, setWide] = useState(() => typeof window === "undefined" ? true : window.matchMedia("(min-width: 1280px)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1280px)");
    const on = () => setWide(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return wide;
}

// the editor header's own live width, via ResizeObserver on the row itself (not the
// viewport) so a docked panel or a resized window reads through the same number.
function useElementWidth() {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [w, setW] = useState(() => (typeof window === "undefined" ? 1440 : window.innerWidth));
  useLayoutEffect(() => {
    if (!el) return;
    const read = () => setW(el.getBoundingClientRect().width);
    const ro = new ResizeObserver(read);
    ro.observe(el);
    read();
    return () => ro.disconnect();
  }, [el]);
  return [setEl, w] as const;
}

const ESC_CHAIN_MS = 1500;
const HDR_COMPACT_W = 1680; // full still shows every label here, title >= 175px
const HDR_TIGHT_W = 940;    // compact still fits here, title >= 118px

function Dock({ wide, side, children }: { wide: boolean; side: "left" | "right"; children: ReactNode }) {
  if (wide) return <>{children}</>;
  return <div data-qa="dock-float" className={`absolute inset-y-0 z-40 flex bg-background shadow-pop ${side === "left" ? "left-0" : "right-0"}`}>{children}</div>;
}

/** A controlled textarea that grows to fit its content (no inner scrollbar). */
function GrowTextarea({ value, onChange, placeholder, className, readOnly, onKeyDown, focusOn }:
{ value: string; onChange: (v: string) => void; placeholder?: string; className?: string; readOnly?: boolean;
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void; focusOn?: number }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const grow = () => { const t = ref.current; if (!t) return; t.style.height = "auto"; t.style.height = Math.max(t.scrollHeight, 22) + "px"; };
  useLayoutEffect(grow, [value]);
  useEffect(() => { if (focusOn) { const t = ref.current; if (t) { t.focus(); t.setSelectionRange(t.value.length, t.value.length); } } }, [focusOn]);
  return <textarea ref={ref} value={value} readOnly={readOnly} onInput={grow} onKeyDown={onKeyDown}
    onChange={(e) => onChange(e.target.value)} placeholder={placeholder} spellCheck={!readOnly}
    className={className} />;
}

type OutSec = { heading: string; level: 2 | 3; plan: string };

type TreeSec = { heading: string; level: 2 | 3; pos: number; key: string; paras: Comment[] };
function buildTree(headings: Heading[], comments: Comment[]): TreeSec[] {
  const hs: TreeSec[] = headings.filter((h) => h.level === 2 || h.level === 3)
    .map((h) => ({ heading: h.text, level: (h.level === 3 ? 3 : 2) as 2 | 3, pos: h.pos, key: canonHeading(h.text), paras: [] as Comment[] }))
    .sort((a, b) => a.pos - b.pos);
  for (const c of comments) {
    let s: TreeSec | null = null;
    for (const sec of hs) { if (sec.pos <= c.para.pos) s = sec; else break; }
    if (s) s.paras.push(c);
  }
  return hs;
}

function conceptSlug(name: string): string {
  return (name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
function splitConcepts(text: string): string[] {
  return (text || "").split(/[;\n]+/)
    .map((s) => s.replace(/^\s*[-*+]\s+/, "").trim().replace(/[.,;]+$/, "").trim())
    .filter(Boolean);
}

function ConceptChips({ value, onChange, locked, onOpen }:
{ value: string; onChange: (v: string) => void; locked: boolean; onOpen: (slug: string, name: string) => void }) {
  const concepts = splitConcepts(value);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [all, setAll] = useState<DraftConcept[]>([]);
  useEffect(() => { if (!locked) api.draftingConcepts().then((r) => setAll(r.items || [])).catch(() => {}); }, [locked]);
  const add = (name: string) => {
    const n = name.trim(); if (!n) { setAdding(false); setDraft(""); return; }
    if (!concepts.some((c) => conceptSlug(c) === conceptSlug(n))) onChange([...concepts, n].join("; "));
    setDraft(""); setAdding(false);
  };
  const remove = (i: number) => onChange(concepts.filter((_, j) => j !== i).join("; "));
  const suggestions = draft.trim()
    ? all.filter((c) => c.name.toLowerCase().includes(draft.trim().toLowerCase()) && !concepts.some((x) => conceptSlug(x) === c.slug)).slice(0, 6)
    : [];
  return (
    <div className="flex flex-wrap items-center gap-1 mt-1">
      {concepts.length === 0 && locked && <span className="text-[11.5px] text-muted-foreground/55 italic">No concepts yet — unlock to add the ideas this paper turns on.</span>}
      {concepts.map((c, i) => (
        <span key={c + i} className="group/c inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/[0.06] pl-2 pr-1.5 py-0.5 text-[11.5px] text-foreground/90">
          <button onClick={() => onOpen(conceptSlug(c), c)} title={"Open the concept note for “" + c + "”"} className="hover:text-primary leading-none">{c}</button>
          {!locked && <button onClick={() => remove(i)} title="Remove from this paper" className="text-muted-foreground/40 hover:text-destructive opacity-0 group-hover/c:opacity-100 group-focus-within/c:opacity-100 focus-visible:opacity-100"><X size={11} /></button>}
        </span>
      ))}
      {!locked && (adding ? (
        <span className="relative inline-flex">
          <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(draft); } else if (e.key === "Escape") { e.stopPropagation(); setAdding(false); setDraft(""); } }}
            onBlur={() => { if (!draft.trim()) setAdding(false); }}
            placeholder="concept…" className="w-32 rounded-full border border-border bg-background px-2 py-0.5 text-[11.5px] focus:outline-none focus:border-primary/50" />
          {suggestions.length > 0 && (
            <div className="absolute z-10 top-full left-0 mt-1 w-52 rounded-md border border-border bg-popover shadow-md py-1 max-h-48 overflow-y-auto">
              {suggestions.map((s) => (
                <button key={s.slug} onMouseDown={(e) => { e.preventDefault(); add(s.name); }} className="block w-full text-left px-2 py-1 text-[11.5px] hover:bg-primary/10">
                  {s.name} <span className="text-muted-foreground/45">· {s.words || 0}w</span>
                </button>
              ))}
            </div>
          )}
        </span>
      ) : (
        <button onClick={() => setAdding(true)} title="Add a concept" className="inline-flex items-center gap-0.5 rounded-full border border-dashed border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground hover:border-primary/40"><Plus size={11} /> concept</button>
      ))}
    </div>
  );
}

function ConceptDrawer({ slug, name, onClose }: { slug: string; name: string; onClose: () => void }) {
  const [note, setNote] = useState<DraftConceptNote | null>(null);
  const [text, setText] = useState("");
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const savedRef = useRef(""); const mtimeRef = useRef(0); const existsRef = useRef(false); const relRef = useRef("");
  const textRef = useRef(""); useEffect(() => { textRef.current = text; }, [text]);

  useEffect(() => {
    let live = true;
    api.draftingConcept(slug, name).then((r) => {
      if (!live || r.error) return;
      setNote(r); setText(r.text);
      savedRef.current = r.text;   // create on first EDIT, not on open (no empty-note spam)
      mtimeRef.current = r.mtime; existsRef.current = r.exists; relRef.current = r.rel;
    }).catch(() => { if (live) setStatus("error"); });
    return () => { live = false; };
  }, [slug, name]);

  const save = useCallback((t: string): Promise<void> => {
    if (t === savedRef.current) return Promise.resolve();
    setStatus("saving");
    return api.draftingSaveConcept(slug, t, mtimeRef.current || undefined).then((r) => {
      if (r.conflict) {
        setStatus("error");
        toast("Concept note changed on disk", { description: "Reload to get the latest, then re-apply your edit.", action: { label: "Reload", onClick: () => api.draftingConcept(slug, name).then((n) => { if (!n.error) { setText(n.text); savedRef.current = n.text; mtimeRef.current = n.mtime; } }) } });
      } else if (r.ok) { savedRef.current = t; mtimeRef.current = r.mtime!; existsRef.current = true; relRef.current = r.rel || relRef.current; setStatus("saved"); }
    }).catch(() => setStatus("error"));
  }, [slug, name]);

  useEffect(() => { if (!note) return; if (text === savedRef.current) return; const id = setTimeout(() => save(text), 800); return () => clearTimeout(id); }, [text, note, save]);
  useEffect(() => () => { if (textRef.current && textRef.current !== savedRef.current) save(textRef.current); }, [save]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") { if (typingEscape(e)) return; e.preventDefault(); e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [onClose]);

  const exists = existsRef.current || note?.exists;
  const rel = relRef.current || ("Preparation/Notes/Concepts/" + slug + ".md");
  return createPortal(
    <div role="dialog" aria-modal="true" aria-label={name} data-knav-modal className="fixed inset-0 z-[150] flex justify-end bg-black/20 animate-in fade-in duration-150" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-[560px] max-w-[92vw] h-full bg-background border-l border-border shadow-xl flex flex-col">
        <div className="shrink-0 flex items-center gap-2 px-4 py-2.5 border-b border-border">
          <BookMarked size={15} className="text-primary shrink-0" />
          <div className="min-w-0">
            <div className="text-[13px] font-medium truncate" style={{ fontFamily: SERIF }} title={"Link it from any draft with [[" + slug + "]]"}>{note?.name || name}{!exists && <span className="ml-1.5 text-[10px] font-normal text-amber-600/90 align-middle">new</span>}</div>
            <div className="text-[10.5px] text-muted-foreground/70 truncate">{rel}</div>
          </div>
          <span className="flex-1" />
          <span className="text-[11px] text-muted-foreground/55 w-12 text-right">{status === "saving" ? "saving…" : status === "saved" ? "saved" : status === "error" ? "error" : ""}</span>
          <button onClick={() => exists && api.open(rel).catch(() => {})} disabled={!exists} title={exists ? "Open in Obsidian" : "Save first to open in Obsidian"} className="inline-flex items-center gap-1 text-[11.5px] text-muted-foreground hover:text-foreground disabled:opacity-40"><ExternalLink size={13} /> Obsidian</button>
          <button type="button" onClick={onClose} data-knav-back="2" title="Close" className="text-muted-foreground hover:text-foreground"><X size={16} /></button>
        </div>
        {note ? (
          <textarea value={text} onChange={(e) => setText(e.target.value)} spellCheck autoFocus
            className="flex-1 min-h-0 w-full resize-none bg-transparent px-4 py-3 text-[13px] leading-relaxed focus:outline-none"
            style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }} />
        ) : (
          <div className="flex-1 flex items-center justify-center text-muted-foreground text-[12.5px] gap-2"><Loader2 size={14} className="animate-spin" /> loading…</div>
        )}
      </div>
    </div>,
    document.body,
  );
}

function PointRow({ p, n, full, style, onChange, onRemove, onMove, onEnter, focusOn, first, last }:
{ p: Point; n: number; full: boolean; style: "list" | "lead"; onChange: (v: Point) => void; onRemove: () => void; onMove: (dir: number) => void;
  onEnter: () => void; focusOn?: number; first: boolean; last: boolean }) {
  const set = (patch: Partial<Point>) => onChange({ ...p, ...patch });
  const oneLine = (v: string) => v.replace(/\n/g, " ");
  const lead = style === "lead";
  const setBullet = (j: number, patch: Partial<Bullet>) =>
    set({ bullets: p.bullets.map((b, k) => (k === j ? { ...b, ...patch } : b)) });
  const dropBullet = (j: number) => set({ bullets: p.bullets.filter((_, k) => k !== j) });
  const addBullet = (kind: Bullet["kind"]) =>
    set({ bullets: [...p.bullets, { kind, tag: kind === "exhibit" ? "FIGURE" : "", text: "" }] });
  // it types like the bullet list it is: Enter starts the next point, Backspace on an
  // empty one takes it away. A point is one sentence, so Enter never means a newline.
  const keys = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) { e.preventDefault(); onEnter(); }
    else if (e.key === "Backspace" && !p.text && !p.ev && !p.fig && !p.bullets.length) { e.preventDefault(); onRemove(); }
  };
  // an outline states the PLAN, not the progress — there is no done state to render
  const pointField = (
    <GrowTextarea value={p.text} onChange={(v) => set({ text: oneLine(v) })} placeholder="the point…" onKeyDown={keys} focusOn={focusOn}
      className={`w-full bg-transparent border-0 resize-none focus:outline-none leading-[1.45] text-foreground/85 placeholder:text-muted-foreground/40 ${full ? "text-[14px]" : "text-[12.5px]"}`} />
  );
  const evField = (
    <GrowTextarea value={p.ev} onChange={(v) => set({ ev: oneLine(v) })} placeholder="evidence…"
      className={`w-full bg-transparent border-0 resize-none focus:outline-none leading-[1.4] text-muted-foreground/65 placeholder:text-muted-foreground/25 ${full ? "text-[12px]" : "text-[10.5px]"}`} />
  );
  return (
    <div className="group/pt">
      <div className="flex items-start gap-2 rounded-md px-1 -mx-1 py-[1px] hover:bg-accent/40">
        <span data-outline-point={n} className={`shrink-0 nums text-right tabular-nums text-muted-foreground/45 ${full ? "w-6 text-[13px]" : "w-4 text-[11px]"}`}>{n}</span>
        {full && !lead
          ? <div className="flex-1 min-w-0 grid grid-cols-[minmax(0,1fr)_minmax(0,24rem)] gap-x-8 items-start">{pointField}{evField}</div>
          : <div className="flex-1 min-w-0">{pointField}{!lead && (p.ev || null) && evField}</div>}
        <div className="shrink-0 flex items-center gap-0.5 pt-[2px] opacity-0 group-hover/pt:opacity-100 focus-within:opacity-100 transition-opacity">
          {lead
            ? <>
                <button onClick={() => addBullet("exhibit")} title="Add a figure or table under this point" className="text-muted-foreground/45 hover:text-foreground"><ImageIcon size={10} /></button>
                <button onClick={() => addBullet("cite")} title="Add a citation under this point" className="text-muted-foreground/45 hover:text-foreground"><BookOpen size={10} /></button>
              </>
            : !p.fig && <button onClick={() => set({ fig: "" + n })} title="Attach a figure to this point" className="text-muted-foreground/45 hover:text-foreground"><ImageIcon size={10} /></button>}
          <button onClick={() => onMove(-1)} disabled={first} title="Move up" className="text-muted-foreground/45 hover:text-foreground disabled:opacity-20"><ArrowUp size={10} /></button>
          <button onClick={() => onMove(1)} disabled={last} title="Move down" className="text-muted-foreground/45 hover:text-foreground disabled:opacity-20"><ArrowDown size={10} /></button>
          <button onClick={onRemove} title="Remove this point" className="text-muted-foreground/45 hover:text-destructive"><X size={11} /></button>
        </div>
      </div>
      {p.bullets.map((b, j) => (
        <div key={j} className="group/bl flex items-baseline gap-1.5 rounded-md px-1 -mx-1 py-[1px] hover:bg-accent/30">
          <span className={`shrink-0 ${full ? "w-[50px]" : "w-[38px]"}`} />
          {b.kind === "exhibit"
            ? <ImageIcon size={10} className="shrink-0 text-primary/50 self-start mt-[3px]" />
            : <BookOpen size={10} className="shrink-0 text-muted-foreground/40 self-start mt-[3px]" />}
          <div className={`min-w-0 flex-1 flex items-baseline gap-1.5 ${full ? "max-w-[56rem]" : ""}`}>
            {b.kind === "exhibit" && b.tag.trim() &&
              <span className={`shrink-0 font-medium text-primary/75 ${full ? "text-[11.5px]" : "text-[10.5px]"}`}>{exhibitTag(b.tag)}</span>}
            <GrowTextarea value={b.text} onChange={(v) => setBullet(j, { text: oneLine(v) })}
              placeholder={b.kind === "exhibit" ? "what the exhibit shows…" : "the citation…"}
              className={`min-w-0 flex-1 bg-transparent border-0 resize-none focus:outline-none leading-[1.35] placeholder:text-muted-foreground/30 ${b.kind === "exhibit" ? "text-primary/70" : "text-muted-foreground/70"} ${full ? "text-[12px]" : "text-[10.5px]"}`} />
          </div>
          <button onClick={() => dropBullet(j)} title="Remove this line" className="shrink-0 text-muted-foreground/40 hover:text-destructive opacity-0 group-hover/bl:opacity-100 group-focus-within/bl:opacity-100 focus-visible:opacity-100"><X size={10} /></button>
        </div>
      ))}
      {p.fig !== "" && (
        <div className="group/fig flex items-baseline gap-1.5 rounded-md px-1 -mx-1 py-[1px] hover:bg-accent/30">
          <span className={`shrink-0 ${full ? "w-[50px]" : "w-[38px]"}`} />
          <ImageIcon size={10} className="shrink-0 text-primary/45 self-start mt-[3px]" />
          {/* clustered to the left inside the point column's width, so "making point N"
              lands right after the caption instead of drifting to the far margin */}
          <div className={`min-w-0 flex-1 flex items-baseline gap-1.5 ${full ? "max-w-[56rem]" : ""}`}>
            {needsFigureLabel(p.fig) && <span className={`shrink-0 text-primary/70 ${full ? "text-[12px]" : "text-[10.5px]"}`}>Figure</span>}
            <GrowTextarea value={p.fig} onChange={(v) => set({ fig: oneLine(v) })} placeholder="1, what the figure shows"
              className={`min-w-0 flex-1 bg-transparent border-0 resize-none focus:outline-none leading-[1.35] text-primary/70 placeholder:text-primary/30 ${full ? "text-[12px]" : "text-[10.5px]"}`} />
            <span className={`shrink-0 text-muted-foreground/35 ${full ? "text-[11px]" : "text-[10px]"}`}>making point {n}</span>
          </div>
          <button onClick={() => set({ fig: "" })} title="Remove the figure from this point" className="shrink-0 text-muted-foreground/40 hover:text-destructive opacity-0 group-hover/fig:opacity-100 group-focus-within/fig:opacity-100 focus-visible:opacity-100"><X size={10} /></button>
        </div>
      )}
    </div>
  );
}

function HypRow({ h, full, onChange, onRemove }:
{ h: Hyp; full: boolean; onChange: (v: Hyp) => void; onRemove: () => void }) {
  const badge = hypBadge(h.label);
  return (
    <div className="group/hyp flex items-start gap-2 rounded-r-md border-l-2 border-primary/40 bg-primary/[0.04] pl-3 pr-2 py-1.5 mt-1.5 ml-1">
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5">
          <FlaskConical size={11} className="shrink-0 text-primary/60 self-center" />
          {badge
            ? <span className={`shrink-0 font-semibold text-primary/85 ${full ? "text-[12px]" : "text-[11px]"}`}>{badge.n}{badge.name ? <span className="font-normal text-primary/65"> · {badge.name}</span> : null}</span>
            : <span className={`shrink-0 font-semibold text-primary/85 ${full ? "text-[12px]" : "text-[11px]"}`}>{h.label.replace(/\*\*/g, "")}</span>}
        </div>
        <GrowTextarea value={h.text} onChange={(v) => onChange({ ...h, text: v.replace(/\n/g, " ") })} placeholder="the hypothesis…"
          className={`w-full bg-transparent border-0 resize-none focus:outline-none leading-[1.45] text-foreground/85 placeholder:text-muted-foreground/40 ${full ? "text-[13px] max-w-[56rem]" : "text-[12px]"}`} />
      </div>
      <button onClick={onRemove} title="Remove this hypothesis" className="shrink-0 mt-0.5 text-muted-foreground/40 hover:text-destructive opacity-0 group-hover/hyp:opacity-100 group-focus-within/hyp:opacity-100 focus-visible:opacity-100"><X size={11} /></button>
    </div>
  );
}

/** The points of ONE section, numbered continuously from `startNum`. */
function PointList({ value, onChange, startNum, full, heading }:
{ value: string; onChange: (v: string) => void; startNum: number; full: boolean; heading?: string }) {
  const [plan, setPlanState] = useState<SectionPlan>(() => parsePlan(value));
  const lastWrite = useRef<string | null>(null);
  useEffect(() => { if (value !== lastWrite.current) setPlanState(parsePlan(value)); }, [value]);
  const [raw, setRaw] = useState(() => !isStructured(parsePlan(value)) && !!value.trim());
  const [focusReq, setFocusReq] = useState<{ i: number; n: number } | null>(null);
  const write = (p: SectionPlan) => { setPlanState(p); const s = serializePlan(p); lastWrite.current = s; onChange(s); };
  const askFocus = (i: number) => setFocusReq((f) => ({ i, n: (f?.n ?? 0) + 1 }));
  const swap = (i: number, dir: number) => {
    const j = i + dir; if (j < 0 || j >= plan.points.length) return;
    const ps = plan.points.slice(); [ps[i], ps[j]] = [ps[j], ps[i]]; write({ ...plan, points: ps });
  };
  const insertAfter = (i: number) => {
    const ps = plan.points.slice();
    ps.splice(i + 1, 0, newPoint());
    write({ ...plan, points: ps });
    askFocus(i + 1);
  };
  const removeAt = (i: number) => {
    write({ ...plan, points: plan.points.filter((_, j) => j !== i) });
    if (i > 0) askFocus(i - 1);
  };
  const append = () => {
    write({ ...plan, points: [...plan.points, newPoint()] });
    askFocus(plan.points.length);
  };
  const appendHyp = () => {
    write({ ...plan, hyps: [...plan.hyps, { label: "Hypothesis " + (plan.hyps.length + 1) + ".", text: "" }] });
  };
  // the "+ hypothesis" affordance shows where hypotheses live: a section that already
  // states some, or one named for them
  const hypHome = plan.hyps.length > 0 || /hypothes/i.test(heading || "");

  if (raw) {
    return (
      <div className="pl-1">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-[9px] font-semibold uppercase tracking-[0.07em] text-muted-foreground/45 flex-1">Not points yet</span>
          <button onClick={() => setRaw(false)} className="text-[10px] text-muted-foreground hover:text-primary">as points</button>
        </div>
        <GrowTextarea value={value} onChange={onChange} placeholder="- [ ] the point | ev: the evidence | fig: 01, what it shows"
          className={`w-full bg-transparent border-0 resize-none focus:outline-none leading-snug text-foreground/70 placeholder:text-muted-foreground/40 font-mono ${full ? "text-[11.5px]" : "text-[10.5px]"}`} />
      </div>
    );
  }

  return (
    <div>
      {plan.points.map((p, i) => (
        <PointRow key={i} p={p} n={startNum + i} full={full} style={plan.style}
          first={i === 0} last={i === plan.points.length - 1}
          focusOn={focusReq && focusReq.i === i ? focusReq.n : 0}
          onChange={(v) => write({ ...plan, points: plan.points.map((x, j) => (j === i ? v : x)) })}
          onRemove={() => removeAt(i)}
          onEnter={() => insertAfter(i)}
          onMove={(d) => swap(i, d)} />
      ))}
      {plan.hyps.map((h, i) => (
        <HypRow key={"h" + i} h={h} full={full}
          onChange={(v) => write({ ...plan, hyps: plan.hyps.map((x, j) => (j === i ? v : x)) })}
          onRemove={() => write({ ...plan, hyps: plan.hyps.filter((_, j) => j !== i) })} />
      ))}
      {/* an empty section keeps its "+ point" in view — nothing to hover over yet */}
      <div className={`flex items-center gap-3 pl-1 pt-0.5 transition-opacity ${plan.points.length || plan.hyps.length ? "opacity-0 group-hover/sec:opacity-100 focus-within:opacity-100" : "opacity-100"}`}>
        <button onClick={append}
          className="inline-flex items-center gap-1 text-[10.5px] text-muted-foreground/60 hover:text-primary"><Plus size={10} /> point</button>
        {hypHome && <button onClick={appendHyp}
          className="inline-flex items-center gap-1 text-[10.5px] text-muted-foreground/60 hover:text-primary"><Plus size={10} /> hypothesis</button>}
        <button onClick={() => setRaw(true)} className="text-[10px] text-muted-foreground/45 hover:text-primary">raw</button>
        {plan.notes.trim() && <span className="text-[10px] text-muted-foreground/35">{plan.notes.trim().split("\n").filter((l) => l.trim()).length} lines of notes, in raw</span>}
      </div>
    </div>
  );
}

const PUB_SETTINGS: { key: string; label: string; tip: string; options: { value: string; label: string }[] }[] = [
  { key: "journal", label: "Journal style", tip: "Class style and Word reference document for Publish", options: PUB_JOURNALS },
  { key: "blind", label: "Anonymization", tip: "Blind removes the author from the title page", options: [{ value: "true", label: "Blind review" }, { value: "false", label: "Identified" }] },
  { key: "figures", label: "Figures & tables", tip: "Where figures and tables sit in the compiled paper", options: [{ value: "inline", label: "In place" }, { value: "atend", label: "At end" }, { value: "separate", label: "Separate document" }] },
  { key: "notes", label: "Notes", tip: "Footnotes or endnotes", options: [{ value: "foot", label: "Footnotes" }, { value: "end", label: "Endnotes" }] },
];
function PubSettings({ paperText, onDocKey }: { paperText: string; onDocKey: (key: string, value: string | null) => void }) {
  return (
    <div className="mt-1.5">
      <div className="text-[9.5px] font-semibold uppercase tracking-[0.06em] text-muted-foreground/70" title="Hidden in the manuscript; Publish builds with these">Publish settings</div>
      <div className="grid grid-cols-2 gap-x-2 gap-y-1 mt-0.5">
        {PUB_SETTINGS.map((s) => {
          const v = readFmKey(paperText, s.key) ?? "";
          const known = !v || s.options.some((o) => o.value === v);
          return (
            <label key={s.key} title={s.tip} className="min-w-0 flex flex-col">
              <span className="text-[10px] text-muted-foreground/80">{s.label}</span>
              <select value={v} onChange={(e) => onDocKey(s.key, e.target.value || null)}
                className="w-full min-w-0 truncate rounded-md border border-border/60 bg-background/60 px-1.5 py-0.5 text-[11.5px] text-foreground/90 focus:outline-none focus:border-primary/50">
                <option value="">Default</option>
                {!known && <option value={v}>{v}</option>}
                {s.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
          );
        })}
      </div>
    </div>
  );
}

function OutlinePanelInner({ doc, slug, docName, title, headings, comments, paperText, onDocKey, onJump, onOpenPlan, onClose }:
{ doc: DraftOutline; slug: string; docName: string; title: string; headings: Heading[]; comments: Comment[]; paperText: string; onDocKey?: (key: string, value: string | null) => void; onJump: (pos: number) => void; onPoint: (itemIndex: number, v: string) => void; onPaperEdit: (text: string, caretPos?: number) => void; onOpenPlan?: () => void; onClose: () => void }) {
  const initial = useMemo(() => parseOutline(doc.outline.text), [doc.outline.text]);
  const [thesis, setThesis] = useState(initial.thesis);
  const [targetJournal, setTargetJournal] = useState(initial.targetJournal);
  const [showChecklist, setShowChecklist] = useState(false);
  const [themes, setThemes] = useState(initial.themes);
  const [extras, setExtras] = useState(initial.extras);
  const introRef = useRef(initial.intro);
  const [plans, setPlans] = useState<Record<string, OutSec>>(() => {
    const m: Record<string, OutSec> = {};
    for (const s of initial.sections) m[canonHeading(s.heading)] = { heading: s.heading, level: s.level, plan: s.plan };
    return m;
  });
  const [locked, setLocked] = useState(() => !!(initial.thesis.trim() || initial.themes.trim()));
  const [syncing, setSyncing] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  const [conflict, setConflict] = useState<Conflict>(null);
  const saved = useRef(doc.outline.text), mtimeRef = useRef(doc.outline.mtime);

  // live, manuscript-tracked sections (h2/h3 in document order), then planned-ahead /
  // removed sections (planning kept in the outline but no current heading)
  const live = useMemo(() => headings.filter((h) => h.level === 2 || h.level === 3)
    .map((h) => ({ level: (h.level === 3 ? 3 : 2) as 2 | 3, heading: h.text, pos: h.pos, key: canonHeading(h.text) })), [headings]);

  const buildText = useCallback((th: string, tj: string, tm: string, pl: Record<string, OutSec>, ex: OutlineExtra[]) => {
    const sections: OutlineSection[] = []; const seen = new Set<string>();
    for (const s of live) { if (seen.has(s.key)) continue; seen.add(s.key); sections.push({ level: s.level, heading: s.heading, plan: pl[s.key]?.plan ?? "" }); }
    for (const p of Object.values(pl)) { const k = canonHeading(p.heading); if (seen.has(k)) continue; seen.add(k); if (p.plan.trim()) sections.push({ level: p.level, heading: p.heading, plan: p.plan }); }
    return serializeOutline({ thesis: th, targetJournal: tj, themes: tm, sections, extras: ex, intro: introRef.current }, title);
  }, [live, title]);

  const text = useMemo(() => buildText(thesis, targetJournal, themes, plans, extras), [buildText, thesis, targetJournal, themes, plans, extras]);
  const textRef = useRef(text);
  useEffect(() => { textRef.current = text; }, [text]);

  const save = useCallback((t: string, force = false): Promise<void> => {
    if (!force && t === saved.current) return Promise.resolve();
    setStatus("saving");
    return api.draftingSave({ slug, which: "outline", text: t, baseMtime: mtimeRef.current, doc: docName })
      .then((r) => {
        if (r.conflict) { setConflict({ currentMtime: r.currentMtime!, currentText: r.currentText ?? "" }); setStatus("error"); }
        else if (r.ok) { saved.current = t; mtimeRef.current = r.mtime!; setConflict(null); setStatus("saved"); }
      }).catch(() => setStatus("error"));
  }, [slug, docName]);
  useEffect(() => { if (text === saved.current) return; const id = setTimeout(() => save(text), 800); return () => clearTimeout(id); }, [text, save]);
  useEffect(() => () => { const t = textRef.current; if (t !== saved.current) api.draftingSave({ slug, which: "outline", text: t, baseMtime: mtimeRef.current, doc: docName }).catch(() => {}); }, [slug, docName]);   // flush latest on unmount

  const setPlan = (key: string, heading: string, level: 2 | 3, v: string) =>
    setPlans((p) => ({ ...p, [key]: { heading, level, plan: v } }));

  const sync = useCallback(async (rebaseTo?: number) => {
    setSyncing(true);
    try {
      if (text !== saved.current) { const r0 = await api.draftingSave({ slug, which: "outline", text, baseMtime: mtimeRef.current, doc: docName }); if (r0.ok) { saved.current = text; mtimeRef.current = r0.mtime!; } }
      const r = await api.draftingSyncOutline(slug, rebaseTo ?? mtimeRef.current, docName);
      if (r.conflict) { const at = r.currentMtime; toast("The outline changed on disk", { description: "Sync again to refresh from the manuscript.", action: { label: "Sync", onClick: () => sync(at) } }); }
      else if (r.ok && r.outline) {
        const m = parseOutline(r.outline.text);
        setThesis(m.thesis); setTargetJournal(m.targetJournal); setThemes(m.themes);
        setExtras(m.extras); introRef.current = m.intro;
        const np: Record<string, OutSec> = {}; for (const s of m.sections) np[canonHeading(s.heading)] = { heading: s.heading, level: s.level, plan: s.plan };
        setPlans(np); saved.current = r.outline.text; mtimeRef.current = r.outline.mtime; setConflict(null); setStatus("saved");
        toast.success("Outline synced from the manuscript");
      }
    } catch { toast.error("Couldn't sync the outline"); } finally { setSyncing(false); }
  }, [slug, docName, text]);

  // the SHAREABLE copy — the outline typeset for a co-author. Built server-side from
  // the FILES, so flush the thesis/plans first or the PDF ships a stale version.
  const downloadPdf = useCallback(async () => {
    setPdfBusy(true);
    try {
      if (textRef.current !== saved.current) {
        const r0 = await api.draftingSave({ slug, which: "outline", text: textRef.current, baseMtime: mtimeRef.current, doc: docName });
        if (r0.ok) { saved.current = textRef.current; mtimeRef.current = r0.mtime!; setStatus("saved"); }
      }
      const r = await api.draftingOutlinePdf(slug, docName, true);
      if (!r.ok) { toast.error("Couldn't build the outline PDF", { description: r.error }); return; }
      const url = URL.createObjectURL(r.blob);
      const a = document.createElement("a");
      a.href = url; a.download = r.name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      toast.success("Outline PDF saved, opening in your browser", { description: r.name });
    } catch { toast.error("Couldn't build the outline PDF"); } finally { setPdfBusy(false); }
  }, [slug, docName]);

  // structural tree + collapse / popout / structural-edit state
  const tree = useMemo(() => buildTree(headings, comments), [headings, comments]);
  const [popout, setPopout] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [concept, setConcept] = useState<{ slug: string; name: string } | null>(null);   // open concept-note drawer
  // the guide can yield the screen to the points; the choice sticks, because whether the
  // thesis stays in view while reading the outline is a working preference, not a mode
  const [guideShut, setGuideShut] = usePersistent("outline-guide-shut", false);

  const outlineRef = useRef<HTMLDivElement>(null);
  useEffect(() => {   // Escape docks a popout, else closes the panel (capture, before editor-exit); a layer over the dock goes first
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") { if (concept || typingEscape(e) || layerAbove(outlineRef.current)) return; e.preventDefault(); e.stopPropagation(); if (popout) setPopout(false); else onClose(); } };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [onClose, popout, concept]);

  const guideFilled = !!(thesis.trim() || themes.trim());

  // `wide` = the popout: the card spans the full column like the section cards below it,
  // but the thesis keeps a reading measure inside it (a 1400px line is unreadable)
  const guideCard = (wide: boolean) => (
    <div className="rounded-lg border border-primary/30 bg-primary/[0.05] px-3 py-2">
      <div className="flex items-center gap-1.5 mb-1">
        <Compass size={12} className="text-primary" />
        <span className="text-[10px] font-semibold uppercase tracking-[0.07em] text-primary/80 flex-1">Guide</span>
        {/* the guide costs a third of the screen; shutting it hands that back to the points */}
        <button onClick={() => setGuideShut((g) => !g)} title={guideShut ? "Show the thesis, journal and concepts" : "Shut the guide — give the screen to the points"} className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground hover:text-foreground">{guideShut ? <ChevronRight size={11} /> : <ChevronDown size={11} />}</button>
        <button onClick={() => setLocked((l) => !l)} title={locked ? "Unlock to edit the thesis & themes" : "Lock the thesis & themes"} className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground hover:text-foreground">{locked ? <Lock size={11} /> : <Unlock size={11} />}{locked ? "locked" : "editing"}</button>
      </div>
      {guideShut && <p className={`text-[11.5px] leading-snug text-muted-foreground/80 line-clamp-1 ${wide ? "max-w-[92ch]" : ""}`}>{thesis.trim() || "No thesis yet."}</p>}
      {!guideShut && <>
      {title && <div className="text-[13px] font-semibold text-foreground/90 mb-1 leading-snug" style={{ fontFamily: SERIF }}>{title}</div>}
      {/* the paper's own blocks — research question, key point, contribution — above the
          thesis, in the order the outline file writes them */}
      {extras.map((x, i) => (
        <div key={x.heading + ":" + i} className="mb-1.5">
          <div className="text-[9.5px] font-semibold uppercase tracking-[0.06em] text-muted-foreground/70">{x.heading}</div>
          {locked
            ? <p className={`text-[12.5px] leading-snug text-foreground/90 whitespace-pre-wrap ${wide ? "max-w-[92ch]" : ""}`}>{x.body}</p>
            : <GrowTextarea value={x.body} onChange={(v) => setExtras((xs) => xs.map((y, j) => (j === i ? { ...y, body: v } : y)))}
                className={`w-full bg-transparent border-0 resize-none focus:outline-none text-[12.5px] leading-snug text-foreground/90 placeholder:text-muted-foreground/55 ${wide ? "max-w-[92ch]" : ""}`} />}
        </div>
      ))}
      <div className="text-[9.5px] font-semibold uppercase tracking-[0.06em] text-muted-foreground/70">Thesis</div>
      {locked && guideFilled
        ? <p className={`text-[12.5px] leading-snug text-foreground/90 whitespace-pre-wrap ${wide ? "max-w-[92ch]" : ""}`}>{thesis.trim() || <span className="text-muted-foreground/60 italic">No thesis yet — unlock to add the one argument the paper defends.</span>}</p>
        : <GrowTextarea value={thesis} onChange={setThesis} readOnly={locked} placeholder="The one argument this paper defends, in a sentence…" className={`w-full bg-transparent border-0 resize-none focus:outline-none text-[12.5px] leading-snug text-foreground/90 placeholder:text-muted-foreground/55 ${wide ? "max-w-[92ch]" : ""}`} />}
      <div className="mt-1.5 flex items-center gap-1.5">
        <span className="text-[9.5px] font-semibold uppercase tracking-[0.06em] text-muted-foreground/70 flex-1">Target journal</span>
        {targetJournal.trim() && <button onClick={() => setShowChecklist(true)} title="Open this journal's submission checklist" className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground hover:text-primary"><ClipboardCheck size={11} />checklist</button>}
      </div>
      {locked
        ? <p className="text-[12px] leading-snug text-foreground/85">{targetJournal.trim() || <span className="text-muted-foreground/55 italic">No target journal yet — unlock to set the journal this paper is written for.</span>}</p>
        : <input value={targetJournal} onChange={(e) => setTargetJournal(e.target.value)} placeholder="e.g. Journal of Examples" className="w-full bg-transparent border-0 border-b border-border/40 focus:outline-none focus:border-primary/50 text-[12px] leading-snug text-foreground/90 placeholder:text-muted-foreground/55" />}
      {onDocKey && <PubSettings paperText={paperText} onDocKey={onDocKey} />}
      <div className="mt-1.5 text-[9.5px] font-semibold uppercase tracking-[0.06em] text-muted-foreground/70">Concepts</div>
      <ConceptChips value={themes} onChange={setThemes} locked={locked} onOpen={(slug, name) => setConcept({ slug, name })} />
      {showChecklist && <JournalChecklistPanel publish="" journalName={targetJournal} onClose={() => setShowChecklist(false)} />}
      {onOpenPlan && (
        <button onClick={onOpenPlan} title="Plan — the full planning workspace over the project README: sections, datasets, readings, logs"
          className={`mt-2 flex items-center justify-center gap-1.5 rounded-md border border-primary/40 text-primary px-2 py-1.5 text-[12px] hover:bg-primary/10 ${wide ? "w-[220px]" : "w-full"}`}>
          <Compass size={13} /> Plan
        </button>
      )}
      </>}
    </div>
  );

  const displayTree = useMemo(() => {
    const liveKeys = new Set(tree.map((s) => s.key));
    const planned = Object.values(plans)
      .filter((p) => !liveKeys.has(canonHeading(p.heading)) && p.plan.trim())
      .map((p) => ({ heading: p.heading, level: p.level, pos: -1, key: canonHeading(p.heading), paras: [] as Comment[] }));
    return [...tree, ...planned];
  }, [tree, plans]);

  // the points are numbered CONTINUOUSLY through the paper, so "figure 1 makes point 3"
  // means the same thing wherever you read it. Each section starts where the last ended.
  const startNums = useMemo(() => {
    const out: number[] = []; let n = 1;
    for (const s of displayTree) { out.push(n); n += parsePlan(plans[s.key]?.plan ?? "").points.length; }
    return out;
  }, [displayTree, plans]);
  const sectionCard = (s: TreeSec, i: number, full: boolean, startNum: number) => {
    const plan = plans[s.key]?.plan ?? "";

    if (s.level === 3) {
      if (!plan.trim()) return null;
      return (
        <div key={s.key + ":" + s.pos} className="group/sec">
          <PointList value={plan} onChange={(v) => setPlan(s.key, s.heading, s.level, v)} startNum={startNum} full={full} heading={s.heading} />
        </div>
      );
    }

    return (
      <div key={s.key + ":" + s.pos} className="group/sec">
        <div className={`flex items-baseline gap-2 px-1 ${i === 0 ? "" : "mt-4"} mb-1`}>
          <button onClick={() => s.pos >= 0 && onJump(s.pos)} disabled={s.pos < 0}
            title={s.pos >= 0 ? "Jump to this section in the manuscript" : "Planned in the outline — not in the manuscript yet"}
            className={`shrink-0 text-left font-semibold uppercase tracking-[0.06em] text-muted-foreground/75 ${s.pos >= 0 ? "hover:text-primary" : "cursor-default"} ${full ? "text-[11px]" : "text-[10px]"}`}>{s.heading}</button>
          {s.pos < 0 && <span className="shrink-0 text-[9px] uppercase tracking-[0.05em] text-muted-foreground/45 border border-border/60 rounded px-1 py-px translate-y-[-1px]">planned</span>}
          <span className="flex-1 border-b border-border/50 translate-y-[-3px]" />
        </div>
        <PointList value={plan} onChange={(v) => setPlan(s.key, s.heading, s.level, v)} startNum={startNum} full={full} heading={s.heading} />
      </div>
    );
  };

  const treeBody = (full: boolean) => (
    <div className="px-3 pt-3 pb-2">
      {/* no banner over the points — the sections ARE the structure; the screen goes
          straight from the guide to the first section divider */}
      <div>
        {displayTree.map((s, i) => sectionCard(s, i, full, startNums[i]))}
        {!displayTree.length && <p className="text-[12px] text-muted-foreground/80 leading-snug px-0.5 py-2">No sections yet. Write <code className="text-[11px]">## headings</code> in the manuscript, then Sync.</p>}
      </div>
    </div>
  );

  const conflictBar = conflict ? (
    <div className="shrink-0 px-3 py-1.5 border-b border-border bg-destructive/10 text-[11px] text-destructive flex items-center gap-2">
      <AlertTriangle size={12} /> outline changed on disk
      <button onClick={() => { const m = parseOutline(conflict.currentText); setThesis(m.thesis); setTargetJournal(m.targetJournal); setThemes(m.themes); setExtras(m.extras); introRef.current = m.intro; const np: Record<string, OutSec> = {}; for (const s of m.sections) np[canonHeading(s.heading)] = { heading: s.heading, level: s.level, plan: s.plan }; setPlans(np); saved.current = conflict.currentText; mtimeRef.current = conflict.currentMtime; setConflict(null); setStatus("idle"); }} className="underline">reload</button>
      <button onClick={() => { mtimeRef.current = conflict.currentMtime; setConflict(null); save(text, true); }} className="underline">keep mine</button>
    </div>
  ) : null;

  const header = (full: boolean) => (
    <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-border">
      <ListTree size={15} className="text-primary shrink-0" />
      <span className="text-[13px] font-medium flex-1 truncate">Outline{full && title ? <span className="text-muted-foreground font-normal"> · {title}</span> : null}</span>
      <StatusTag status={status} dirty={text !== saved.current} />
      <button onClick={downloadPdf} disabled={pdfBusy} title="Download the outline as a PDF and open it in your browser — the copy to send others" className="inline-flex items-center justify-center w-6 h-6 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent disabled:opacity-40">{pdfBusy ? <Loader2 size={13} className="animate-spin" /> : <FileDown size={13} />}</button>
      <button onClick={() => sync()} disabled={syncing} title="Sync the section list from the manuscript headings, keeping your planning" className="inline-flex items-center justify-center w-6 h-6 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent disabled:opacity-40"><RotateCw size={13} className={syncing ? "animate-spin" : ""} /></button>
      <button type="button" onClick={() => setPopout((p) => !p)} data-knav-back={full ? "3" : undefined} title={full ? "Dock the outline back to the side" : "Pop out — focus the outline full-screen"} className="inline-flex items-center justify-center w-6 h-6 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent">{full ? <Minimize2 size={13} /> : <Maximize2 size={13} />}</button>
      <button onClick={() => api.open(doc.outline.rel)} title="Open outline.md in Obsidian" className="inline-flex items-center justify-center w-6 h-6 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent"><ExternalLink size={12} /></button>
      <button type="button" onClick={() => { setPopout(false); onClose(); }} data-knav-back="2" title="Close the outline" className="inline-flex items-center justify-center w-6 h-6 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent"><X size={15} /></button>
    </div>
  );

  const shell = (full: boolean) => (
    <div ref={outlineRef} className={full ? "flex flex-col h-full w-full bg-secondary/20" : "flex flex-col h-full w-[340px] shrink-0 border-r border-border bg-secondary/20"}>
      {header(full)}
      {conflictBar}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {/* full-screen is the thinking view — it gets the width (the old 860px column
            left most of a 1880px screen empty beside a cramped outline) */}
        <div className={full ? "max-w-[1400px] mx-auto w-full" : ""}>
          <div className="sticky top-0 z-10 px-3 pt-2.5 pb-2 bg-secondary/20 backdrop-blur-sm border-b border-border/70">{guideCard(full)}</div>
          {treeBody(full)}
        </div>
      </div>
    </div>
  );

  return (
    <>
      {popout
        ? createPortal(<div role="dialog" aria-modal="true" aria-label="Outline" data-knav-modal className="fixed inset-0 z-[130] bg-background flex flex-col animate-in fade-in duration-150">{shell(true)}</div>, document.body)
        : shell(false)}
      {concept && <ConceptDrawer slug={concept.slug} name={concept.name} onClose={() => setConcept(null)} />}
    </>
  );
}

type OutlinePanelProps = { slug: string; docName: string; title: string; headings: Heading[]; comments: Comment[]; paperText: string; onDocKey?: (key: string, value: string | null) => void; onJump: (pos: number) => void; onPoint: (itemIndex: number, v: string) => void; onPaperEdit: (text: string, caretPos?: number) => void; onOpenPlan?: () => void; onClose: () => void };

function OutlineShell({ children, onClose }: { children: React.ReactNode; onClose?: () => void }) {
  return (
    <div className="flex flex-col h-full w-[340px] shrink-0 border-r border-border bg-secondary/20">
      <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-border"><ListTree size={15} className="text-primary" /><span className="text-[13px] font-medium flex-1">Outline</span>{onClose && <button type="button" onClick={onClose} data-knav-back="2" title="Close the outline"><X size={15} className="text-muted-foreground hover:text-foreground" /></button>}</div>
      {children}
    </div>
  );
}

function OutlinePanel(props: OutlinePanelProps) {
  const [loaded, setLoaded] = useState<DraftOutline | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    let live = true; setLoaded(null); setErr(false);
    api.draftingOutline(props.slug, props.docName).then((r) => { if (!live) return; if (r.error) setErr(true); else setLoaded(r); }).catch(() => live && setErr(true));
    return () => { live = false; };
  }, [props.slug, props.docName]);
  if (err) return <OutlineShell onClose={props.onClose}><p className="p-3 text-[12px] text-destructive">Couldn't load the outline.</p></OutlineShell>;
  if (!loaded) return <OutlineShell><p className="p-3 text-[12px] text-muted-foreground">Loading outline…</p></OutlineShell>;
  return <OutlinePanelInner key={props.slug + ":" + props.docName} doc={loaded} {...props} />;
}

// ---- version control panel -------------------------------------------------
const VDIFF_PRINT_CSS = `@media print {
  body > *:not(.vdiff-print-root) { display: none !important; }
  .vdiff-print-root { position: static !important; inset: auto !important; background: #fff !important; z-index: auto !important; }
  .vdiff-print-root .vdiff-noprint { display: none !important; }
  .vdiff-print-root .vdiff-doc { box-shadow: none !important; border: 0 !important; max-width: none !important; }
}`;

function DiffBody({ segments, showFull }: { segments: DiffSegment[]; showFull: boolean }) {
  const out: React.ReactNode[] = [];
  segments.forEach((s, i) => {
    if (s.op === "insert") { out.push(<span key={i} className="vdiff-ins rounded-[2px] bg-emerald-500/12 text-emerald-700 dark:text-emerald-400 underline decoration-emerald-500/60 decoration-1 underline-offset-2">{s.text}</span>); return; }
    if (s.op === "delete") { out.push(<span key={i} className="vdiff-del rounded-[2px] bg-red-500/10 text-red-600 dark:text-red-400 line-through decoration-red-500/60">{s.text}</span>); return; }
    if (showFull || s.text.length <= 260) { out.push(<span key={i}>{s.text}</span>); return; }
    out.push(<span key={i}>{s.text.slice(0, 120)}<span className="mx-1 rounded bg-muted px-1.5 text-[10.5px] text-muted-foreground align-middle select-none">···</span>{s.text.slice(-120)}</span>);
  });
  return <div className="vdiff-doc whitespace-pre-wrap leading-relaxed text-[13.5px]" style={{ fontFamily: SERIF }}>{out}</div>;
}

function VersionsPanel({ slug, docName, title, getMtime, flush, onRestored, onClose }:
{ slug: string; docName: string; title: string; getMtime: () => number; flush: () => Promise<void>;
  onRestored: (text: string, mtime: number) => void; onClose: () => void }) {
  const dialogs = useDialogs();   // window.prompt is dead in Electron; use the in-app modal
  const [list, setList] = useState<DraftVersion[] | null>(null);
  const [dirty, setDirty] = useState(false);
  const [oldId, setOldId] = useState("");
  const [newId, setNewId] = useState("current");
  const [diff, setDiff] = useState<DraftVersionDiff | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [tab, setTab] = useState<"changes" | "redline">("changes");
  const [showFull, setShowFull] = useState(true);
  const [busy, setBusy] = useState(false);
  const [labelInput, setLabelInput] = useState("");
  const [adding, setAdding] = useState(false);
  const [pdfMtime, setPdfMtime] = useState<number | null>(null);
  const [pdfErr, setPdfErr] = useState<string | null>(null);
  const [compiling, setCompiling] = useState(false);
  const seeded = useRef(false);
  const redlineable = !docName.startsWith("deck:") && slug !== "syllabi" && slug !== "measures";

  const reload = useCallback(() => api.draftingVersions(slug, docName).then((r) => {
    setList(r.versions || []);
    setDirty(!!r.dirtyVsNewest);
    if (!seeded.current && (r.versions || []).length) { setOldId(r.versions[0].id); seeded.current = true; }
  }).catch(() => setList([])), [slug, docName]);
  useEffect(() => { reload(); }, [reload]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") { if (typingEscape(e)) return; e.preventDefault(); e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [onClose]);

  // (re)load the word diff whenever the selected pair changes
  useEffect(() => {
    if (!oldId || oldId === newId) { setDiff(null); return; }
    setDiffLoading(true);
    let live = true;
    api.draftingVersionDiff(slug, oldId, newId, docName).then((r) => { if (live) setDiff(r.error ? null : r); }).catch(() => { if (live) setDiff(null); }).finally(() => { if (live) setDiffLoading(false); });
    return () => { live = false; };
  }, [slug, docName, oldId, newId]);

  const options = useMemo(() => [{ id: "current", label: "Current draft" }, ...(list || []).map((v) => ({ id: v.id, label: v.label || new Date(v.ts).toLocaleString() }))], [list]);

  const saveCheckpoint = useCallback(async () => {
    setBusy(true);
    try {
      await flush();
      const r = await api.draftingSaveVersion(slug, docName, labelInput.trim());
      if (r.error) toast.error(r.error);
      else if (r.unchanged) toast("No changes since the last checkpoint");
      else { toast.success("Checkpoint saved"); seeded.current = false; }
      setLabelInput(""); setAdding(false);
      await reload();
    } finally { setBusy(false); }
  }, [slug, docName, labelInput, flush, reload]);

  const restore = useCallback(async (id: string, label: string) => {
    if (!window.confirm(`Restore “${label}” into the draft? Your current text is checkpointed first, so this can be undone.`)) return;
    setBusy(true);
    try {
      await flush();
      let r = await api.draftingRestoreVersion(slug, id, docName, getMtime());
      if (r.conflict) {
        if (!window.confirm("The draft changed on disk since you opened it. Restore anyway (the on-disk version is checkpointed first)?")) { setBusy(false); return; }
        r = await api.draftingRestoreVersion(slug, id, docName, r.currentMtime ?? null);
      }
      if (r.ok && r.text != null && r.mtime != null) { onRestored(r.text, r.mtime); toast.success("Restored — and the prior text is saved as a checkpoint"); seeded.current = false; await reload(); }
      else toast.error(r.error || "Couldn't restore");
    } finally { setBusy(false); }
  }, [slug, docName, getMtime, flush, onRestored, reload]);

  const remove = useCallback(async (id: string, label: string) => {
    if (!window.confirm(`Delete the checkpoint “${label}”? This removes the saved snapshot.`)) return;
    setBusy(true);
    try { const r = await api.draftingDeleteVersion(slug, id, docName); if (r.error) toast.error(r.error); else { toast.success("Checkpoint deleted"); if (oldId === id) { setOldId(""); seeded.current = false; } await reload(); } }
    finally { setBusy(false); }
  }, [slug, docName, oldId, reload]);

  const rename = useCallback(async (id: string, label: string) => {
    const next = await dialogs.prompt({ title: "Checkpoint name", defaultValue: label, confirmLabel: "Rename" });
    if (next == null || next.trim() === label) return;
    const r = await api.draftingUpdateVersion(slug, id, next.trim(), undefined, docName);
    if (r.error) toast.error(r.error); else reload();
  }, [slug, docName, reload, dialogs]);

  const compileRedline = useCallback(async () => {
    if (!oldId || oldId === newId) { toast.error("Pick two different versions to diff"); return; }
    setCompiling(true); setPdfErr(null);
    try {
      await flush();
      const r = await api.draftingDiffPdf(slug, oldId, newId, docName);
      if (r.ok && r.mtime) { setPdfMtime(r.mtime); }
      else { setPdfErr(r.error || "compile failed"); toast.error(r.error || "The redline didn't compile"); }
    } finally { setCompiling(false); }
  }, [slug, docName, oldId, newId, flush]);

  const oldLabel = options.find((o) => o.id === oldId)?.label || "—";
  const newLabel = options.find((o) => o.id === newId)?.label || "—";

  return createPortal(
    <div role="dialog" aria-modal="true" aria-label="Version history" data-knav-modal className="vdiff-print-root fixed inset-0 z-[110] bg-background flex flex-col animate-in fade-in duration-150">
      <style>{VDIFF_PRINT_CSS}</style>
      <div className="vdiff-noprint shrink-0 flex items-center gap-2 px-4 py-2 border-b border-border">
        <button type="button" onClick={onClose} data-knav-back="2" className="inline-flex items-center gap-1 text-[12.5px] text-muted-foreground hover:text-foreground"><ChevronLeft size={15} /> Back</button>
        <div className="h-4 w-px bg-border mx-1" />
        <History size={15} className="text-muted-foreground" />
        <span className="text-[13.5px] font-medium truncate max-w-[40%]" style={{ fontFamily: SERIF }}>Version history — {title}</span>
        <span className="flex-1" />
        {!adding
          ? <button onClick={() => setAdding(true)} className="inline-flex items-center gap-1.5 rounded-full border border-primary/40 text-primary px-3 py-1 text-[12px] hover:bg-primary/10"><Save size={13} /> Save checkpoint</button>
          : <div className="inline-flex items-center gap-1.5">
              <input autoFocus value={labelInput} onChange={(e) => setLabelInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") saveCheckpoint(); if (e.key === "Escape") { setAdding(false); setLabelInput(""); } }}
                placeholder="name this checkpoint (e.g. first submission)" className="w-[260px] rounded-md border border-border bg-background px-2 py-1 text-[12px]" />
              <button onClick={saveCheckpoint} disabled={busy} className="inline-flex items-center gap-1 rounded-full border border-primary/40 text-primary px-2.5 py-1 text-[12px] hover:bg-primary/10 disabled:opacity-50">{busy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} Save</button>
              <button onClick={() => { setAdding(false); setLabelInput(""); }} className="text-muted-foreground hover:text-foreground"><X size={14} /></button>
            </div>}
      </div>

      <div className="flex-1 min-h-0 flex">
        {/* left rail: checkpoint list */}
        <div className="vdiff-noprint shrink-0 w-[300px] border-r border-border overflow-y-auto">
          <div className="px-3 py-2 text-[10px] uppercase tracking-wide text-muted-foreground/70 flex items-center justify-between">
            <span>Checkpoints</span>{dirty && <span className="normal-case tracking-normal text-[10.5px] text-amber-600 dark:text-amber-500">unsaved changes</span>}
          </div>
          {list === null && <p className="px-3 py-2 text-[12px] text-muted-foreground">loading…</p>}
          {list?.length === 0 && <p className="px-3 py-2 text-[12px] text-muted-foreground leading-snug">No checkpoints yet. Click <span className="text-foreground">Save checkpoint</span> to snapshot the draft — then you can diff and restore.</p>}
          {list?.map((v) => {
            const isOld = v.id === oldId, isNew = v.id === newId;
            return (
              <div key={v.id} className={`mx-2 mb-1.5 rounded-lg border p-2.5 ${isOld ? "border-primary/50 bg-primary/5" : isNew ? "border-emerald-500/40 bg-emerald-500/5" : "border-border"}`}>
                <div className="flex items-start gap-2">
                  <div className="flex-1 min-w-0">
                    <button onClick={() => rename(v.id, v.label)} title="Rename" className="block text-left text-[12.5px] font-medium truncate hover:text-primary">{v.label || <span className="text-muted-foreground italic">{v.auto ? "auto-checkpoint" : "unnamed"}</span>}</button>
                    <div className="text-[10.5px] text-muted-foreground nums flex items-center gap-1.5">
                      <Clock size={10} /> {relativeAgo(Math.max(0, Math.round((Date.now() - v.ts) / 1000)))} · {v.words.toLocaleString()}w
                      {v.auto && <span title="Saved automatically — no action needed" className="rounded-full border border-border px-1.5 py-px text-[9.5px] normal-case tracking-normal">auto</span>}
                    </div>
                  </div>
                  <button onClick={() => remove(v.id, v.label || v.id)} title="Delete checkpoint" className="text-muted-foreground/50 hover:text-destructive shrink-0"><Trash2 size={13} /></button>
                </div>
                <div className="mt-1.5 flex items-center gap-1">
                  <button onClick={() => setOldId(v.id)} className={`rounded px-1.5 py-0.5 text-[10.5px] border ${isOld ? "border-primary/50 text-primary" : "border-border text-muted-foreground hover:text-foreground"}`}>old</button>
                  <button onClick={() => setNewId(v.id)} className={`rounded px-1.5 py-0.5 text-[10.5px] border ${isNew ? "border-emerald-500/50 text-emerald-600 dark:text-emerald-400" : "border-border text-muted-foreground hover:text-foreground"}`}>new</button>
                  <span className="flex-1" />
                  <button onClick={() => restore(v.id, v.label || v.id)} disabled={busy} title="Restore this version into the draft" className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] border border-border text-muted-foreground hover:text-foreground disabled:opacity-50"><RotateCcw size={11} /> restore</button>
                </div>
              </div>
            );
          })}
        </div>

        {/* main: diff comparison */}
        <div className="flex-1 min-h-0 flex flex-col">
          <div className="vdiff-noprint shrink-0 flex flex-wrap items-center gap-2 px-4 py-2 border-b border-border">
            <div className="inline-flex rounded-full border border-border p-0.5">
              <button onClick={() => setTab("changes")} className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] ${tab === "changes" ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"}`}><GitCompare size={12} /> Changes</button>
              {redlineable && <button onClick={() => setTab("redline")} className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] ${tab === "redline" ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"}`}><FileOutput size={12} /> Redline PDF</button>}
            </div>
            <div className="h-4 w-px bg-border" />
            <label className="text-[11px] text-muted-foreground">old</label>
            <select value={oldId} onChange={(e) => setOldId(e.target.value)} className="rounded-md border border-border bg-background px-2 py-1 text-[12px] max-w-[200px]">
              <option value="">— pick —</option>
              {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
            <ArrowRight size={13} className="text-muted-foreground" />
            <label className="text-[11px] text-muted-foreground">new</label>
            <select value={newId} onChange={(e) => setNewId(e.target.value)} className="rounded-md border border-border bg-background px-2 py-1 text-[12px] max-w-[200px]">
              {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
            <span className="flex-1" />
            {tab === "changes" && diff?.stats && (
              <span className="text-[11.5px] nums"><span className="text-emerald-600 dark:text-emerald-400">+{diff.stats.added.toLocaleString()}</span> <span className="text-red-600 dark:text-red-400">−{diff.stats.removed.toLocaleString()}</span> <span className="text-muted-foreground">words</span></span>
            )}
            {tab === "changes" && (
              <>
                <button onClick={() => setShowFull((s) => !s)} className="rounded-full border border-border px-2.5 py-1 text-[11.5px] text-muted-foreground hover:text-foreground">{showFull ? "Changes only" : "Show all text"}</button>
                <button onClick={() => window.print()} title="Print this redline" className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-[12px] text-muted-foreground hover:text-foreground"><Printer size={12} /> Print</button>
              </>
            )}
          </div>

          {tab === "changes" ? (
            <div className="flex-1 min-h-0 overflow-y-auto">
              {!oldId ? <div className="grid place-items-center h-full px-8 text-center"><p className="text-[13px] text-muted-foreground">Pick an <span className="font-medium text-foreground">old</span> version on the left to see what changed.</p></div>
                : oldId === newId ? <div className="grid place-items-center h-full px-8 text-center"><p className="text-[13px] text-muted-foreground">Old and new are the same version — pick two different ones.</p></div>
                : diffLoading ? <div className="grid place-items-center h-full"><Loader2 size={18} className="animate-spin text-muted-foreground" /></div>
                : !diff ? <div className="grid place-items-center h-full px-8 text-center"><p className="text-[13px] text-muted-foreground">Couldn’t build the diff.</p></div>
                : diff.stats.changed === 0 ? <div className="grid place-items-center h-full px-8 text-center"><p className="text-[13px] text-muted-foreground">No textual differences between these two versions.</p></div>
                : <div className="mx-auto max-w-[820px] px-8 py-8">
                    <div className="vdiff-noprint mb-4 text-[11.5px] text-muted-foreground">Redline from <span className="text-foreground">{oldLabel}</span> to <span className="text-foreground">{newLabel}</span>. <span className="text-emerald-600 dark:text-emerald-400">underline</span> = added, <span className="text-red-600 dark:text-red-400 line-through">strike</span> = removed.</div>
                    <DiffBody segments={diff.segments} showFull={showFull} />
                  </div>}
            </div>
          ) : (
            <div className="flex-1 min-h-0 flex flex-col">
              <div className="vdiff-noprint shrink-0 px-4 py-2 border-b border-border flex items-center gap-2 text-[12px] text-muted-foreground">
                <span>A typeset latexdiff redline ({oldLabel} → {newLabel}) — the marked-up document a reviewer expects on resubmission.</span>
                <span className="flex-1" />
                <button onClick={compileRedline} disabled={compiling || !oldId || oldId === newId} className="inline-flex items-center gap-1.5 rounded-full border border-primary/40 text-primary px-2.5 py-1 hover:bg-primary/10 disabled:opacity-50">{compiling ? <Loader2 size={12} className="animate-spin" /> : <FileOutput size={12} />} {pdfMtime ? "Recompile" : "Compile redline"}</button>
                {pdfMtime && <button onClick={() => api.draftingOpenDiffPdf(slug, docName)} className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 hover:text-foreground"><ExternalLink size={12} /> Open / print</button>}
              </div>
              <div className="flex-1 min-h-0 bg-muted/30">
                {compiling ? <div className="grid place-items-center h-full px-8 text-center"><div className="flex flex-col items-center gap-2 text-[13px] text-muted-foreground"><Loader2 size={20} className="animate-spin" /> compiling the redline…</div></div>
                  : pdfErr ? <div className="grid place-items-center h-full px-8 text-center"><p className="text-[13px] text-destructive">{pdfErr}<br /><span className="text-muted-foreground text-[12px]">Tip: the Changes tab works without LaTeX — print that instead.</span></p></div>
                  : pdfMtime ? <iframe title="redline pdf" src={api.draftingDiffPdfUrl(slug, docName, pdfMtime)} className="w-full h-full bg-white" />
                  : <div className="grid place-items-center h-full px-8 text-center"><p className="text-[13px] text-muted-foreground">Click <span className="font-medium text-foreground">Compile redline</span> to typeset the marked-up PDF.</p></div>}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

function DocRow({ name, label, icon, current, meta, onOpen, onBeside, disabled }:
{ name: string; label: string; icon: ReactNode; current: boolean; meta?: ReactNode; onOpen: () => void; onBeside?: (name: string) => void; disabled?: boolean }) {
  return (
    <div className="group/docrow flex items-center hover:bg-accent">
      <button type="button" disabled={disabled} onClick={onOpen}
        className="flex items-center gap-2 flex-1 min-w-0 text-left px-3 py-1.5 text-[12.5px] text-muted-foreground group-hover/docrow:text-foreground disabled:opacity-40 disabled:group-hover/docrow:text-muted-foreground">
        <span className="w-4 shrink-0">{current ? <Check size={13} className="text-primary" /> : icon}</span>
        <span className="flex-1 truncate">{label}</span>
        {meta}
      </button>
      {onBeside && !current && (
        <button type="button" onClick={() => onBeside(name)}
          title={`Open ${label} beside this one — two documents, side by side, both editable`}
          aria-label={`Open ${label} beside this one`}
          className="shrink-0 mr-1.5 inline-flex items-center justify-center w-6 h-6 rounded-md text-muted-foreground/40 hover:text-primary hover:bg-primary/10 group-hover/docrow:text-muted-foreground/80">
          <Columns2 size={13} />
        </button>
      )}
    </div>
  );
}

function SupplementsPanel({ docName, projectDoc, onSwitchDoc, onOpenBeside, onNewDoc, projDocs, supList, onOpenQuestions, onOpenSupplement, onOpenChecklist, onClose }:
{ docName: string; projectDoc: boolean; onSwitchDoc?: (doc: string) => void; onOpenBeside?: (doc: string) => void; onNewDoc?: (e?: { shiftKey?: boolean }) => void; projDocs: DraftProjectDocs | null; supList: DraftSupplement[] | null; onOpenQuestions: (path: string) => void; onOpenSupplement: (name: string) => void; onOpenChecklist: () => void; onClose: () => void }) {
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") { if (typingEscape(e) || layerAbove(rootRef.current)) return; e.preventDefault(); e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [onClose]);

  const hasSwitcher = !!(onSwitchDoc && projDocs && (projDocs.projectDocs.some((d) => d.exists) || projDocs.manuscripts.length > 0));
  const hasQuestions = !!projDocs?.questions.exists;
  const hasSupplements = !projectDoc;

  return (
    <div ref={rootRef} className="flex flex-col h-full w-[300px] shrink-0 border-l border-border bg-secondary/20">
      <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-border">
        <Paperclip size={15} className="text-primary shrink-0" />
        <span className="text-[13px] font-medium flex-1 truncate">Supplements</span>
        <button type="button" onClick={onClose} data-knav-back="2" title="Close" className="inline-flex items-center justify-center w-6 h-6 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent"><X size={15} /></button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto py-1.5">
        {hasSwitcher && (
          <>
            <p className="px-3 pb-1 pt-0.5 text-[10px] uppercase tracking-wide text-muted-foreground/70" title="README and the analysis plan are never published">Project documents</p>
            {projDocs!.manuscripts.map((m) => (
              <DocRow key={m.name} name={m.name} label={m.label} icon={<KindIcon kind={m.kind} size={13} />}
                current={m.name === docName} onBeside={onOpenBeside}
                onOpen={() => { if (m.name !== docName) onSwitchDoc!(m.name); }} />
            ))}
            {projDocs!.manuscripts.length > 0 && <div className="my-1 border-t border-border/60" />}
            {projDocs!.projectDocs.map((d) => (
              <DocRow key={d.name} name={d.name} label={d.label} icon={<KindIcon kind={d.kind} size={13} />}
                current={d.name === docName} disabled={!d.exists && d.name !== docName}
                onBeside={d.exists ? onOpenBeside : undefined}
                onOpen={() => { if (d.name !== docName && d.exists) onSwitchDoc!(d.name); }}
                meta={d.exists
                  ? <span className="text-[10.5px] text-muted-foreground/55 nums">{d.words.toLocaleString()}w</span>
                  : <span className="text-[10px] text-muted-foreground/45">not present</span>} />
            ))}
          </>
        )}
        {hasQuestions && (
          <>
            {hasSwitcher && <div className="my-1 border-t border-border/60" />}
            <button onClick={() => onOpenQuestions(projDocs!.questions.path)}
              className="flex items-center gap-2 w-full text-left px-3 py-1.5 text-[12.5px] text-muted-foreground hover:text-foreground hover:bg-accent">
              <span className="w-4 shrink-0 text-muted-foreground/70"><CircleHelp size={13} /></span>
              <span className="flex-1">Questions</span>
            </button>
          </>
        )}
        {hasSupplements && (
          <>
            {(hasSwitcher || hasQuestions) && <div className="my-1 border-t border-border/60" />}
            <p className="px-3 pb-1 pt-0.5 text-[10px] uppercase tracking-wide text-muted-foreground/70">Supplementary documents</p>
            {supList === null && <p className="px-3 py-1.5 text-[12px] text-muted-foreground">loading…</p>}
            {supList?.map((s) => (
              <DocRow key={s.name} name={s.name} label={s.label}
                icon={<span className="text-muted-foreground/70"><SupplementIcon kind={s.kind} size={13} /></span>}
                current={s.name === docName}
                onBeside={s.exists ? onOpenBeside : undefined}
                onOpen={() => {
                  if (s.name === docName) return;
                  if (s.exists && onSwitchDoc) onSwitchDoc(s.name);
                  else onOpenSupplement(s.name);
                }}
                meta={s.exists
                  ? <span className="text-[10.5px] text-muted-foreground/55 nums">{s.words.toLocaleString()}w</span>
                  : <span className="text-[10px] text-muted-foreground/45 inline-flex items-center gap-0.5"><Plus size={10} /> create</span>} />
            ))}
            {onNewDoc && (
              <button type="button" data-qa="new-document-row"
                onClick={(e) => onNewDoc({ shiftKey: e.shiftKey })}
                // Shift+Enter names it first. The arrow engine leaves a shifted Enter
                // alone, and the click a browser makes from it need not carry the shift.
                onKeyDown={(e) => { if (e.key === "Enter" && e.shiftKey) { e.preventDefault(); e.stopPropagation(); onNewDoc({ shiftKey: true }); } }}
                title="New page to the right. Shift-click to name it first."
                className="flex items-center gap-2 w-full text-left px-3 py-1.5 text-[12.5px] text-primary hover:bg-primary/10">
                <span className="w-4 shrink-0"><FilePlus2 size={13} /></span>
                <span className="flex-1">New document</span>
              </button>
            )}
            <div className="mt-1 border-t border-border/60 pt-1">
              <button onClick={onOpenChecklist}
                title="Caps, abstract rules, blinding and AI-use policy for any target journal"
                className="flex items-center gap-2 w-full text-left px-3 py-1.5 text-[12.5px] text-muted-foreground hover:text-foreground hover:bg-accent">
                <span className="w-4 shrink-0 text-muted-foreground/70"><ClipboardCheck size={13} /></span>
                <span className="flex-1">Publication checklists</span>
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const PLAN_SECTIONS = [
  "Core Idea", "Research Question", "Rival Answers", "Hypotheses", "Data",
  "Measures & Variables", "Testing Plan", "Result Catalogue",
  "Expected Contribution", "Target", "Open Questions",
  "Documentation Checklist", "Status",
];
const PLAN_HINTS: Record<string, string> = {
  "Core Idea": "the puzzle: both horns of the tension, the claim with mechanism, who disagrees",
  "Research Question": "sharp enough to be answerable with the named data",
  "Rival Answers": "two accounts, each its strongest self, diverging on an observable",
  "Hypotheses": "H1..Hn — standalone, directional, citation-free, rejectable",
  "Data": "each dataset: name, on-disk path, waves, N, weights — link from the rail",
  "Measures & Variables": "one row per variable; full ledger in logs/measures.md",
  "Testing Plan": "lock block + current claims → scripts; specs in logs/testing_plan.md",
  "Result Catalogue": "one line per finding: verdict, headline stat, N, logs/ link",
  "Expected Contribution": "what the paper adds if the results hold",
  "Target": "journal candidates (outline.md owns the final pick)",
  "Open Questions": "live directional questions — the project's current direction",
  "Documentation Checklist": "tick only when the section holds real content",
  "Status": "stage markers + at most three lines; history in logs/INDEX.md",
};

function planParse(text: string): { pre: string; secs: { name: string; body: string }[] } {
  const secs: { name: string; body: string }[] = [];
  let cur: string | null = null;
  let buf: string[] = [];
  const pre: string[] = [];
  for (const line of (text || "").split("\n")) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      if (cur !== null) secs.push({ name: cur, body: buf.join("\n").trim() });
      cur = m[1];
      buf = [];
    } else if (cur === null) pre.push(line);
    else buf.push(line);
  }
  if (cur !== null) secs.push({ name: cur, body: buf.join("\n").trim() });
  // append any missing contract sections (this workspace IS the upgrade path
  // for a pre-contract README) — existing sections and their order are kept
  const have = new Set(secs.map((s) => s.name));
  for (const name of PLAN_SECTIONS) if (!have.has(name)) secs.push({ name, body: "_pending_" });
  return { pre: pre.join("\n").trimEnd(), secs };
}

function planSerialize(pre: string, secs: { name: string; body: string }[]): string {
  const parts = [pre.trimEnd()];
  for (const s of secs) parts.push("## " + s.name + "\n\n" + (s.body.trim() || "_pending_"));
  return parts.filter(Boolean).join("\n\n") + "\n";
}

const planFilled = (body: string) => {
  const b = (body || "").trim();
  return !!b && !/^_?pending_?\.?$/i.test(b) && b.split(/\s+/).length >= 8;
};

function PlanSectionBlock({ name, body, active, onBody, onFocus, registerRef }:
{ name: string; body: string; active: boolean; onBody: (v: string) => void; onFocus: () => void; registerRef: (el: HTMLDivElement | null) => void }) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const grow = () => { const t = taRef.current; if (!t) return; t.style.height = "auto"; t.style.height = Math.max(64, t.scrollHeight) + "px"; };
  useLayoutEffect(grow, [body]);
  const filled = planFilled(body);
  return (
    <div ref={registerRef} className={`rounded-xl border px-5 py-4 transition-colors ${active ? "border-primary/50 bg-primary/[0.03]" : "border-border bg-card"}`}>
      <div className="flex items-baseline justify-between gap-3 mb-1.5">
        <span className="flex items-center gap-2">
          <span className={`inline-block w-2 h-2 rounded-full ${filled ? "bg-emerald-500" : "bg-amber-400/70"}`} />
          <span className="text-[15px] font-semibold tracking-tight" style={{ fontFamily: SERIF }}>{name}</span>
        </span>
        <span className="text-[10.5px] text-muted-foreground/55 truncate italic">{PLAN_HINTS[name] || ""}</span>
      </div>
      <textarea ref={taRef} value={body} onChange={(e) => { onBody(e.target.value); }} onFocus={onFocus} onInput={grow}
        spellCheck={false}
        className="w-full resize-none bg-transparent border-0 focus:outline-none text-[14px] leading-[1.7] text-foreground/90 placeholder:text-muted-foreground/45 placeholder:italic"
        style={{ fontFamily: SERIF }}
        placeholder="pending — write it here, it saves into README.md" />
    </div>
  );
}

function PlanWorkspace({ slug, title, flushReadme, onReadmeSaved, onOpenReadmeEditor, onViewFile, onClose }:
{ slug: string; title: string; flushReadme?: () => void; onReadmeSaved: (text: string, mtime: number) => void;
  onOpenReadmeEditor?: () => void; onViewFile: (candidates: string[], title: string) => void; onClose: () => void }) {
  const [pre, setPre] = useState("");
  const [secs, setSecs] = useState<{ name: string; body: string }[] | null>(null);
  const [mtime, setMtime] = useState(0);
  const [status, setStatus] = useState<ReadmeStatus | null>(null);
  const [logs, setLogs] = useState<DraftLog[]>([]);
  const [active, setActive] = useState("Core Idea");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [scaffolding, setScaffolding] = useState(false);
  const [dsQ, setDsQ] = useState("");
  const [dsHits, setDsHits] = useState<DatasetHit[] | null>(null);
  const [rdQ, setRdQ] = useState("");
  const [rdHits, setRdHits] = useState<CiteHit[] | null>(null);
  const blockEls = useRef(new Map<string, HTMLDivElement | null>());
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    flushReadme?.();
    api.draftingDoc(slug, "readme.md").then((d) => {
      if (!live) return;
      if (d.error) { toast.error(d.error); onClose(); return; }
      const p = planParse(d.paper.text);
      setPre(p.pre || ("# " + title));
      setSecs(p.secs);
      setMtime(d.paper.mtime);
    }).catch(() => { toast.error("Couldn't load the README"); onClose(); });
    api.draftingReadmeStatus(slug).then((r) => { if (live && !r.error) setStatus(r); }).catch(() => {});
    api.draftingLogs(slug).then((r) => { if (live && !r.error) setLogs(r.logs || []); }).catch(() => {});
    return () => { live = false; };
  }, [slug]);   // eslint-disable-line react-hooks/exhaustive-deps

  // dataset + reading searches (debounced)
  useEffect(() => {
    if (!dsQ.trim()) { setDsHits(null); return; }
    const t = setTimeout(() => api.draftingDatasets(dsQ.trim()).then((r) => setDsHits(r.hits || [])).catch(() => setDsHits([])), 250);
    return () => clearTimeout(t);
  }, [dsQ]);
  // the README's "link a reading" box searches the same local library as the @-picker,
  // so it costs no request either; it falls back to the server only on an empty result
  useEffect(() => {
    const q = rdQ.trim();
    if (!q) { setRdHits(null); return; }
    if (citeIndexState() === "ready") {
      const hits = searchCiteIndex(q, { limit: 30 });
      setRdHits(hits);
      if (hits.length) return;
    }
    let live = true;
    const t = setTimeout(() => { searchRemote(slug, q, "readme.md").then((h) => { if (live) setRdHits(h); }); }, 300);
    return () => { live = false; clearTimeout(t); };
  }, [rdQ, slug]);

  const setBody = (name: string, v: string) => {
    setSecs((s) => s ? s.map((x) => (x.name === name ? { ...x, body: v } : x)) : s);
    setDirty(true);
  };
  const appendTo = (name: string, line: string) => {
    setSecs((s) => {
      if (!s) return s;
      return s.map((x) => {
        if (x.name !== name) return x;
        const b = /^_?pending_?\.?$/i.test(x.body.trim()) ? "" : x.body.trimEnd();
        return { ...x, body: (b ? b + "\n" : "") + line };
      });
    });
    setDirty(true);
    setActive(name);
    setTimeout(() => blockEls.current.get(name)?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
  };

  const save = useCallback(async () => {
    if (!secs) return;
    setSaving(true);
    try {
      const text = planSerialize(pre, secs);
      const r = await api.draftingSave({ slug, which: "paper", text, baseMtime: mtime, doc: "readme.md" });
      if (r.conflict) {
        if (window.confirm("The README changed on disk while you were planning. Overwrite with your version?")) {
          const r2 = await api.draftingSave({ slug, which: "paper", text, baseMtime: r.currentMtime ?? null, doc: "readme.md" });
          if (r2.ok) { setMtime(r2.mtime!); setDirty(false); onReadmeSaved(text, r2.mtime!); toast.success("Saved"); }
          else toast.error(r2.error || "Couldn't save");
        }
      } else if (r.ok) {
        setMtime(r.mtime!); setDirty(false); onReadmeSaved(text, r.mtime!);
        api.draftingReadmeStatus(slug).then((s) => { if (!s.error) setStatus(s); }).catch(() => {});
        toast.success("Saved to README.md");
      } else toast.error(r.error || "Couldn't save");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't save");
    } finally { setSaving(false); }
  }, [secs, pre, slug, mtime, onReadmeSaved]);

  const scaffold = async () => {
    setScaffolding(true);
    try {
      const r = await api.draftingScaffoldProject(slug);
      if (r.ok) toast.success(r.created?.length ? "Workflow folders created: " + r.created.join(", ") : "Workflow folders already in place");
      else toast.error(r.error || "Couldn't scaffold");
    } finally { setScaffolding(false); }
  };

  useEffect(() => {
    if (!dirty || !secs || saving) return;
    const t = setTimeout(() => { save(); }, 1500);
    return () => clearTimeout(t);
  }, [dirty, secs, pre, saving, save]);

  const closeSafely = useCallback(async () => {
    if (dirty && secs) await save();
    onClose();
  }, [dirty, secs, save, onClose]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented && !typingEscape(e)) { e.preventDefault(); e.stopPropagation(); closeSafely(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); save(); }
    };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [closeSafely, save]);

  const filledCount = (secs || []).filter((s) => PLAN_SECTIONS.includes(s.name) && planFilled(s.body)).length;
  const logKindIcon = (k: DraftLog["kind"]) =>
    k === "index" ? <ListOrdered size={12} /> : k === "questions" ? <CircleHelp size={12} />
    : k === "criticism" ? <CheckCheck size={12} /> : k === "robustness" ? <FlaskConical size={12} />
    : k === "memo" ? <StickyNote size={12} /> : <FileCode size={12} />;

  return createPortal(
    <div role="dialog" aria-modal="true" aria-label="Project plan" data-knav-modal className="fixed inset-0 z-[100] bg-background flex flex-col">
      <div className="shrink-0 flex items-center gap-3 border-b border-border px-5 py-2.5">
        <Compass size={17} className="text-primary shrink-0" />
        <span className="text-[14px] font-medium truncate" style={{ fontFamily: SERIF }}>Project plan — {title}</span>
        <span className="text-[11.5px] text-muted-foreground nums shrink-0">{filledCount}/{PLAN_SECTIONS.length} sections filled</span>
        <StatusTag status={saving ? "saving" : dirty ? "idle" : "saved"} dirty={dirty} />
        {status?.legacyPlan && <span className="shrink-0 rounded-full border border-amber-500/40 text-amber-600 dark:text-amber-400 px-2 py-0.5 text-[10.5px]">legacy PLAN.md present — analysis runs on it until this README carries the Testing Plan</span>}
        <span className="flex-1" />
        {onOpenReadmeEditor && <button onClick={onOpenReadmeEditor} className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-[12px] text-muted-foreground hover:text-foreground hover:border-primary/50"><FileText size={13} /> Open README in editor</button>}
        <button onClick={scaffold} disabled={scaffolding} title="Create the full replication/results/corpus workflow folders for this project" className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-[12px] text-muted-foreground hover:text-foreground hover:border-primary/50 disabled:opacity-50">{scaffolding ? <Loader2 size={13} className="animate-spin" /> : <FileStack size={13} />} Scaffold workflow</button>
        <button onClick={() => save()} disabled={saving || !dirty} className="inline-flex items-center gap-1.5 rounded-full border border-primary/40 text-primary px-3 py-1 text-[12px] hover:bg-primary/10 disabled:opacity-50">{saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />} Save</button>
        <button type="button" onClick={closeSafely} data-knav-back="2" title="Close (saves first)" className="inline-flex items-center justify-center w-7 h-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent"><X size={16} /></button>
      </div>
      {!secs ? (
        <div className="flex-1 grid place-items-center text-[13px] text-muted-foreground"><span className="inline-flex items-center gap-2"><Loader2 size={15} className="animate-spin" /> loading the plan…</span></div>
      ) : (
      <div className="flex-1 min-h-0 flex">
        <div className="w-[218px] shrink-0 border-r border-border overflow-y-auto py-3 px-2">
          <p className="px-2 pb-1.5 text-[10px] uppercase tracking-wide text-muted-foreground/70">The audit document</p>
          {PLAN_SECTIONS.map((name) => {
            const s = secs.find((x) => x.name === name);
            const filled = s ? planFilled(s.body) : false;
            return (
              <button key={name} onClick={() => { setActive(name); blockEls.current.get(name)?.scrollIntoView({ behavior: "smooth", block: "start" }); }}
                className={`flex items-center gap-2 w-full text-left rounded-md px-2 py-1.5 text-[12px] transition-colors ${active === name ? "bg-primary/10 text-foreground" : "text-muted-foreground hover:text-foreground hover:bg-accent"}`}>
                <span className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${filled ? "bg-emerald-500" : "bg-amber-400/70"}`} />
                <span className="flex-1 truncate">{name}</span>
              </button>
            );
          })}
          {(status?.markers?.length ?? 0) > 0 && (
            <div className="mt-4 px-2">
              <p className="pb-1 text-[10px] uppercase tracking-wide text-muted-foreground/70">Stage markers</p>
              {status!.markers.map((m) => <p key={m} className="text-[10.5px] text-emerald-600 dark:text-emerald-400 nums">{m}</p>)}
            </div>
          )}
        </div>
        <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-6 py-5">
          <div className="max-w-[760px] mx-auto grid gap-3">
            {secs.map((s) => (
              <PlanSectionBlock key={s.name} name={s.name} body={s.body} active={active === s.name}
                onBody={(v) => setBody(s.name, v)} onFocus={() => setActive(s.name)}
                registerRef={(el) => blockEls.current.set(s.name, el)} />
            ))}
          </div>
        </div>
        <div className="w-[320px] shrink-0 border-l border-border overflow-y-auto p-3 space-y-4">
          <div>
            <p className="pb-1.5 text-[10px] uppercase tracking-wide text-muted-foreground/70 inline-flex items-center gap-1.5"><Database size={11} /> Link a dataset → Data</p>
            <input value={dsQ} onChange={(e) => setDsQ(e.target.value)} placeholder="Search your datasets…"
              className="w-full px-2.5 py-1.5 text-[12px] rounded-md border border-border bg-background focus:outline-none focus:border-primary/50" />
            {dsHits && (
              <div className="mt-1.5 max-h-[180px] overflow-y-auto rounded-md border border-border/70 divide-y divide-border/50">
                {dsHits.length === 0 && <p className="px-2.5 py-2 text-[11.5px] text-muted-foreground">nothing matches</p>}
                {dsHits.map((h) => (
                  <button key={h.rel} onClick={() => appendTo("Data", h.kind === "context"
                      ? `- **${h.name}** — dataset context: \`${h.rel}\` (measures, weighting, traps)`
                      : `- **${h.name}** — \`${h.path || h.rel}\``)}
                    className="flex items-center gap-2 w-full text-left px-2.5 py-1.5 text-[11.5px] text-muted-foreground hover:text-foreground hover:bg-accent">
                    {h.kind === "context" ? <BookMarked size={11} className="shrink-0 text-primary/70" /> : <Database size={11} className="shrink-0" />}
                    <span className="flex-1 truncate" title={h.rel}>{h.name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div>
            <p className="pb-1.5 text-[10px] uppercase tracking-wide text-muted-foreground/70 inline-flex items-center gap-1.5"><Library size={11} /> Link a reading → {active}</p>
            <input value={rdQ} onChange={(e) => setRdQ(e.target.value)} placeholder="Search your corpus — author, topic…"
              className="w-full px-2.5 py-1.5 text-[12px] rounded-md border border-border bg-background focus:outline-none focus:border-primary/50" />
            {rdHits && (
              <div className="mt-1.5 max-h-[200px] overflow-y-auto rounded-md border border-border/70 divide-y divide-border/50">
                {rdHits.length === 0 && <p className="px-2.5 py-2 text-[11.5px] text-muted-foreground">nothing matches</p>}
                {rdHits.map((h) => (
                  <button key={h.rel} onClick={() => appendTo(active, `- ${h.author}${h.year ? " (" + h.year + ")" : ""} — [[${h.rel.replace(/\.md$/i, "")}|${h.title}]]`)}
                    className="w-full text-left px-2.5 py-1.5 text-[11.5px] text-muted-foreground hover:text-foreground hover:bg-accent">
                    <span className="block text-foreground/85 truncate">{h.author}{h.year ? ` (${h.year})` : ""}</span>
                    <span className="block truncate text-[10.5px]">{h.title}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div>
            <p className="pb-1.5 text-[10px] uppercase tracking-wide text-muted-foreground/70 inline-flex items-center gap-1.5" title="Dated memos plus the criticism and robustness records"><History size={11} /> Research log — logs/ ({logs.length})</p>
            <div className="max-h-[260px] overflow-y-auto rounded-md border border-border/70 divide-y divide-border/50">
              {logs.length === 0 && <p className="px-2.5 py-2 text-[11.5px] text-muted-foreground">no log entries yet</p>}
              {logs.map((l) => (
                <button key={l.path} onClick={() => onViewFile([l.path], l.name)}
                  className="flex items-center gap-2 w-full text-left px-2.5 py-1.5 text-[11.5px] text-muted-foreground hover:text-foreground hover:bg-accent">
                  <span className="shrink-0 text-muted-foreground/70">{logKindIcon(l.kind)}</span>
                  <span className="flex-1 truncate">{l.name}</span>
                  <span className="shrink-0 text-[10px] text-muted-foreground/55 nums">{relAgo(l.mtime)}</span>
                </button>
              ))}
            </div>
          </div>
          {status && status.checklist.length > 0 && (
            <div>
              <p className="pb-1.5 text-[10px] uppercase tracking-wide text-muted-foreground/70 inline-flex items-center gap-1.5"><ClipboardCheck size={11} /> Checklist — {status.checklist.filter((c) => c.done).length}/{status.checklist.length} (edit in the section)</p>
              <div className="rounded-md border border-border/70 px-2.5 py-1.5 space-y-0.5">
                {status.checklist.map((c, i) => (
                  <p key={i} className={`text-[11px] leading-snug ${c.done ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"}`}>{c.done ? "✓" : "○"} {c.text}</p>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
      )}
    </div>,
    document.body
  );
}

type PaneGeom = { leftPct: number; rightPct: number; side: "left" | "right"; onFocusPane?: () => void; focused?: boolean } | null;

function Editor({ doc, cacheDoc, onExit, onSwitchDoc, onOpenBeside, pane, onClosePane }: { doc: DraftDoc; cacheDoc?: string; onExit: () => void; onSwitchDoc?: (doc: string) => void; onOpenBeside?: (doc: string) => void; pane?: PaneGeom; onClosePane?: () => void }) {
  const slug = doc.slug;
  const docName = doc.doc;
  // the name the loader fetched (and cached) this document under; see useDoc
  const ck = cacheDoc ?? docName;
  const dialogs = useDialogs();   // in-app prompt/confirm (window.prompt is dead in Electron)
  // README/PLAN are project documents, not manuscripts — no outline/results/references/
  // publish machinery, but the same editor, anchored comments, and version history.
  const projectDoc = !!doc.projectDoc;
  const manuscript = useRef<MdEditorHandle>(null);
  const citeTarget = useRef<React.RefObject<MdEditorHandle | null> | null>(null);
  const citeEd = () => (citeTarget.current ?? manuscript).current;
  const rootRef = useRef<HTMLDivElement>(null);
  
  const layerOpenRef = useRef(false);
  useEffect(() => {
    const t = window.setTimeout(() => {
      const a = document.activeElement as HTMLElement | null;
      if (layerOpenRef.current || (a && a !== document.body && a !== rootRef.current && rootRef.current?.contains(a))) return;
      if (manuscript.current) manuscript.current.focus();
      else rootRef.current?.focus({ preventScroll: true });
    }, 80);
    return () => window.clearTimeout(t);
  }, []);
  const onPaperSaved = useRef<() => void>(() => {});
  const paperHooks = useMemo<DocHooks>(() => ({
    adopt: (sent, merged) => (manuscript.current?.adoptServerText(sent, merged) ? manuscript.current.getText() : null),
    onMerged: (text) => { manuscript.current?.setContent(text); },
    markSaveStart: (sent) => { manuscript.current?.markSaveStart(sent); },
    onSaved: () => { onPaperSaved.current(); },
  }), []);
  // live mirror of the split geometry, so window-level handlers can tell whether this
  // pane currently owns the keys without re-subscribing on every focus change
  const paneRef = useRef(pane); useEffect(() => { paneRef.current = pane; });
  const paper = useDoc(slug, "paper", doc.paper.text, doc.paper.mtime, docName, paperHooks, ck);
  const ann = useDoc(slug, "editor", doc.editor.text, doc.editor.mtime, docName, undefined, ck);
  const review = useComments(slug, docName, doc.comments?.comments ?? [], doc.comments?.mtime ?? 0, doc.comments?.version ?? "", ck, doc.comments?.resolvedOmitted);
  const [activeComment, setActiveComment] = useState<string | null>(null);
  const [soloComment, setSoloComment] = useState<string | null>(null);
  // ⌘⏎ with the caret inside a comment's anchor opens THAT card's reply box. The bump
  // is what the card watches, so asking twice for the same card reopens/refocuses it.
  const [replyReq, setReplyReq] = useState<{ id: string; n: number }>({ id: "", n: 0 });
  const [orphans, setOrphans] = useState<string[]>([]);
  const [focusOpen, setFocusOpen] = useState(false);
  const focusStartRef = useRef(0);
  const [rewriteOpen, setRewriteOpen] = useState(false);
  const [litOpen, setLitOpen] = useState(false);
  layerOpenRef.current = focusOpen || rewriteOpen || litOpen;
  const layerEscChain = useRef(0);
  const [reviewMenuOpen, setReviewMenuOpen] = useState(false);
  const [reviewConfirm, setReviewConfirm] = useState<{ action: "accept" | "resolve"; ids: string[] } | null>(null);
  useEffect(() => { if (!reviewMenuOpen) setReviewConfirm(null); }, [reviewMenuOpen]);
  const reviewKey = `all_in_one_academic:review:${slug}:${docName}`;
  const readReview = (k: string): { issuesOnly?: boolean; unpassedOnly?: boolean } => {
    try { const v = JSON.parse(localStorage.getItem(k) || "null"); return v && typeof v === "object" ? v : {}; } catch { return {}; }
  };
  const [issuesOnly, setIssuesOnlyRaw] = useState<boolean>(() => readReview(reviewKey).issuesOnly !== false);
  const [unpassedOnly, setUnpassedOnlyRaw] = useState<boolean>(() => !!readReview(reviewKey).unpassedOnly);
  useEffect(() => { const v = readReview(reviewKey); setIssuesOnlyRaw(v.issuesOnly !== false); setUnpassedOnlyRaw(!!v.unpassedOnly); }, [reviewKey]);   // eslint-disable-line react-hooks/exhaustive-deps
  const writeReview = useCallback((v: { issuesOnly?: boolean; unpassedOnly?: boolean }) => {
    try { localStorage.setItem(reviewKey, JSON.stringify({ ...readReview(reviewKey), ...v })); } catch { /* private window: per-session only */ }
  }, [reviewKey]);   // eslint-disable-line react-hooks/exhaustive-deps
  const setIssuesOnly = useCallback((on: boolean) => { setIssuesOnlyRaw(on); writeReview({ issuesOnly: on }); }, [writeReview]);
  const setUnpassedOnly = useCallback((on: boolean) => { setUnpassedOnlyRaw(on); writeReview({ unpassedOnly: on }); }, [writeReview]);
  const reviewMenuRef = useRef<HTMLDivElement>(null);
  const reviewBtnRef = useRef<HTMLButtonElement>(null);
  // Rewrite's own actions, reached from the menu
  const rwApi = useRef<RewriteApi | null>(null);
  const [rwMenu, setRwMenu] = useState<RewriteMenu | null>(null);
  const [composer, setComposer] = useState<{ from: number; to: number; text: string; x: number; y: number; kind?: "text" | "figure"; rectPct?: DraftCommentRect | null; suggest?: boolean } | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; hasSelection: boolean } | null>(null);   // right-click drafting menu
  // external (AI / sync) edit reconciliation: a banner + an optional diff modal
  const [diverged, setDiverged] = useState<{ kind: "applied" | "conflict"; oldText: string; newText: string; diskMtime: number } | null>(null);
  const [diffOpen, setDiffOpen] = useState<{ oldText: string; newText: string } | null>(null);
  const [marginOpen, setMarginOpen] = usePersistent<boolean>("aioa-drafting-comments", true);
  const viewportWide = useWideViewport();
  const isWide = pane ? (typeof window !== "undefined" && window.innerWidth * (100 - pane.leftPct - pane.rightPct) / 100 >= 1280) : viewportWide;
  const [syncing, setSyncing] = useState(false);
  const [styleOpen, setStyleOpen] = useState(false);
  const kindDefault = KIND_DEFAULT_PUBLISH[doc.kind] ?? "working";
  const publish = useMemo(() => readPublish(paper.text) ?? doc.publish, [paper.text, doc.publish]);
  const style = useMemo<DraftStyle>(() => renderPreset(publish), [publish]);
  const setPublish = useCallback((fmt: string) => {
    setStyleOpen(false);
    const next = withPublish(paper.text, fmt, kindDefault);
    if (next === paper.text) return;
    manuscript.current?.setContent(next);
    paper.setText(next);
  }, [paper, kindDefault]);
  const spacingDefault = useMemo(() => formatDefaultSpacing(publish), [publish]);
  const spacing = useMemo<SpacingMode>(() => readSpacingKey(paper.text) ?? spacingDefault, [paper.text, spacingDefault]);
  const setSpacing = useCallback((s: SpacingMode) => {
    const next = withSpacing(paper.text, s);
    if (next === paper.text) return;
    manuscript.current?.setContent(next);
    paper.setText(next);
  }, [paper]);
  const [source, setSource] = useState<{ rel: string; quote: string } | null>(null);   // open source-viewer
  const [pdfView, setPdfView] = useState<{ rel: string; page: string } | null>(null);   // open source-PDF at a cited page
  const [refOpen, setRefOpen] = useState(false);                                        // References panel
  const [refStyle, setRefStyle] = usePersistent<RefStyle>("aioa-drafting-ref-style", "asa");   // shared with the badge
  const [refFlags, setRefFlags] = useState({ flagged: 0, unmatched: 0 });               // References button badge
  const [citeMap, setCiteMap] = useState<Record<string, CiteMapEntry>>({});             // in-text cite resolution
  const citeMapRef = useRef(citeMap); citeMapRef.current = citeMap;
  // the local reference index's load state; the search effect re-runs when it lands so a
  // query typed during a cold window upgrades from the server answer to the local one
  const [citeIdxState, setCiteIdxState] = useState<CiteIndexState>(citeIndexState());
  // @-citation searchbar state (the handlers + search live lower, near refreshCiteMap)
  const [mention, setMention] = useState<MentionInfo | null>(null);
  const [mentionHits, setMentionHits] = useState<CiteHit[]>([]);
  const [mentionSel, setMentionSel] = useState(0);
  const [mentionLoading, setMentionLoading] = useState(false);
  const [citeMode, setCiteMode] = usePersistent<CiteMode>("aioa-drafting-cite-mode", "paren");
  // quote-mode drill-down: level 0 = the candidate list, level 1 = the chosen source's quotes
  const [mentionLevel, setMentionLevel] = useState<0 | 1>(0);
  const [drillHit, setDrillHit] = useState<CiteHit | null>(null);
  const [quoteSel, setQuoteSel] = useState(0);
  const [pendingCites, setPendingCites] = useState<CiteHit[]>([]);
  const [activePos, setActivePos] = useState(0);
  const [selWords, setSelWords] = useState(0);   // words in the highlighted passage; 0 = no selection
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [corpusOpen, setCorpusOpen] = useState(false);          // Corpus browser (left, shares the slot with Outline)
  const [corpusSideRaw, setCorpusSide] = usePersistent<"left" | "right">("aioa-drafting-corpus-side", "left"); // or docked right, beside the paper
  const corpusSide = corpusSideRaw === "right" ? "right" : "left";
  const [resultsOpen, setResultsOpen] = useState(false);        // Results workbench (right dock)
  const [wideOverride, setWideOverride] = usePersistent<boolean | null>("aioa-drafting-results-wide", null);
  const [prov, setProv] = useState<DraftProvenance | null>(null);   // /drafting/provenance payload
  
  const [assetStamps, setAssetStamps] = useState<Record<string, string>>({});
  const resultsStampRef = useRef<string>("");
  const [lightbox, setLightbox] = useState<{ stem: string; kind: "figure" | "table" } | null>(null);   // full-view figure lightbox
  // pop-out draw.io concept-diagram editor: name = existing figure basename, null = new
  const [diagramEd, setDiagramEd] = useState<{ name: string | null; title?: string } | null>(null);
  const [figCmts, setFigCmts] = useState<{ comments: Record<string, FigureComment[]>; provenance: Record<string, FigureCommentProv>; mtime: number; version: string }>({ comments: {}, provenance: {}, mtime: 0, version: "" });
  const figCmtsRef = useRef(figCmts); figCmtsRef.current = figCmts;
  const [fileView, setFileView] = useState<{ candidates: string[]; title: string } | null>(null);
  const [findingsOnly, setFindingsOnly] = usePersistent<boolean>("aioa-drafting-findings-only", false);
  const [provPop, setProvPop] = useState<{ name: string; x: number; y: number } | null>(null);   // embed-chip popover
  const [supList, setSupList] = useState<DraftSupplement[] | null>(null);
  const [supName, setSupName] = useState<string | null>(null);   // open supplement workspace
  const [journalsOpen, setJournalsOpen] = useState(false);       // publication-checklist viewer
  const [versionsOpen, setVersionsOpen] = useState(false);       // version-history workspace
  const [docSwitchOpen, setDocSwitchOpen] = useState(false);     // Supplements right-dock panel
  const checklistKey = `all_in_one_academic:checklist-open:${slug}`;
  const [checklistOpen, setChecklistOpenState] = useState(() => { try { return localStorage.getItem(checklistKey) === "1"; } catch { return false; } });
  useEffect(() => { try { setChecklistOpenState(localStorage.getItem(checklistKey) === "1"); } catch { /* private window */ } }, [checklistKey]);
  const setChecklistOpen = (on: boolean) => { setChecklistOpenState(on); try { localStorage.setItem(checklistKey, on ? "1" : "0"); } catch { /* private window */ } };
  const [planOpen, setPlanOpen] = useState(false);               // Project-plan workspace (README-backed)
  const [projDocs, setProjDocs] = useState<DraftProjectDocs | null>(null);   // project-level docs + question register
  useEffect(() => {                                              // fetched on mount so the switcher + Questions card know what exists
    let live = true;
    api.draftingProjectDocs(slug).then((r) => { if (live && !r.error) setProjDocs(r); }).catch(() => {});
    return () => { live = false; };
  }, [slug]);
  useEffect(() => { noteDraftOpened(slug, ck, projectDoc); }, [slug, ck, projectDoc]);
  useEffect(() => {
    if (!projDocs) return;
    const here = (x: DraftRef) => x.slug === slug && (x.doc === ck || x.doc === docName);
    const next: DraftRef[] = [
      ...projDocs.manuscripts.map((m) => ({ slug, doc: m.name })),
      ...projDocs.projectDocs.filter((d) => d.exists).map((d) => ({ slug, doc: d.name, pd: true })),
      ...recentDrafts().slice(0, 6),
    ].filter((x) => !here(x));
    return primeDrafts(next.slice(0, projDocs.manuscripts.length + projDocs.projectDocs.length + 5));
  }, [projDocs, slug, ck, docName]);
  useEffect(() => {                                              // lazy-load the list when the Docs panel opens
    if (docSwitchOpen && supList === null && !projectDoc) api.draftingSupplements(slug).then((r) => setSupList(r.supplements || [])).catch(() => setSupList([]));
  }, [docSwitchOpen, supList, slug, projectDoc]);
  // whether the Docs button has anything to show — same three checks DocsPanel uses internally
  const showDocsBtn = !!(onSwitchDoc && projDocs && (projDocs.projectDocs.some((d) => d.exists) || projDocs.manuscripts.length > 0)) || !!projDocs?.questions.exists || !projectDoc;
  
  const [newDocOpen, setNewDocOpen] = useState(false);
  // every name this project's writing/ already declares or holds — the collision set
  const existingDocs = useMemo(() => [
    ...(supList || []).map((s) => s.name),
    ...(projDocs?.manuscripts || []).map((m) => m.name),
    ...(projDocs?.projectDocs || []).map((d) => d.name),
  ], [supList, projDocs]);
  // what both create paths end on: re-read the document set, open the page on the right.
  // The pane is a fresh Editor, and an Editor puts the caret in its page as it mounts.
  const openCreated = useCallback((name: string) => {
    setSupList(null);                       // the document set changed — re-read it
    api.draftingProjectDocs(slug).then((d) => { if (!d.error) setProjDocs(d); }).catch(() => {});
    setDocSwitchOpen(false);
    if (onOpenBeside) onOpenBeside(name);
    else onSwitchDoc?.(name);
  }, [slug, onOpenBeside, onSwitchDoc]);
  const creatingDoc = useRef(false);        // a double click is ONE document
  const newDocument = useCallback(async (e?: { shiftKey?: boolean }) => {
    if (e?.shiftKey) { setNewDocOpen(true); return; }
    if (creatingDoc.current) return;
    creatingDoc.current = true;
    try {
      const taken = new Set(existingDocs.map((n) => (n || "").trim().toLowerCase()));
      let r: Awaited<ReturnType<typeof api.draftingCreateDoc>> = {};
      for (let i = 1; i <= 50; i++) {
        const name = i === 1 ? "untitled.md" : `untitled-${i}.md`;
        if (taken.has(name)) continue;
        r = await api.draftingCreateDoc(slug, name);
        if (!(r.ok && r.existed)) break;
      }
      if (!r.ok || !r.name || r.existed) { toast.error(r.error || "Couldn't create the document"); return; }
      try { await api.draftingSave({ slug, which: "paper", doc: r.name, text: "", baseMtime: r.mtime ?? null }); }
      catch { /* the heading stays; the page still opens */ }
      openCreated(r.name);
    } catch (err) {
      toast.error("Couldn't create the document — " + ((err as Error)?.message || "no reply from the server"));
    } finally { creatingDoc.current = false; }
  }, [slug, existingDocs, openCreated]);
  const createDocument = useCallback(async ({ name, title, format, kind }: { name: string; title: string; format: string; kind?: string }) => {
    let r: Awaited<ReturnType<typeof api.draftingCreateDoc>>;
    try { r = await api.draftingCreateDoc(slug, name, title, kind); }
    catch (err) { toast.error("Couldn't create the document — " + ((err as Error)?.message || "no reply from the server")); return false; }
    if (!r.ok || !r.name) { toast.error(r.error || "Couldn't create the document"); return false; }
    if (!r.existed && format && format !== DEFAULT_FORMAT) {
      const starter = typeof r.text === "string" ? r.text : "# " + (title.trim() || r.label || "") + "\n\n";
      try {
        const s = await api.draftingSave({ slug, which: "paper", doc: r.name, text: withPublish(starter, format, DEFAULT_FORMAT), baseMtime: r.mtime ?? null });
        if (s.conflict || s.error) toast.error(`Created ${r.name}, but the format didn't stick — set it from the toolbar`);
      } catch { toast.error(`Created ${r.name}, but the format didn't stick — set it from the toolbar`); }
    }
    toast.success(r.existed ? `${r.label} already existed — opening it` : `Created ${r.name}`);
    openCreated(r.name);
    return true;
  }, [slug, openCreated]);
  
  const openSupplementFull = useCallback((name: string) => {
    if (!onSwitchDoc) return false;
    setSupName(null);
    setSupList(null);                       // the document set may have just changed
    onSwitchDoc(name);
    return true;
  }, [onSwitchDoc]);
  const provAtRef = useRef(0);
  const refreshProv = useCallback(() => {
    provAtRef.current = Date.now();
    api.draftingProvenance(slug, docName === "paper.md" ? undefined : docName)
      .then((r) => { if (!r.error) setProv(r); }).catch(() => {});
  }, [slug, docName]);
  useEffect(() => { setProv(null); refreshProv(); }, [refreshProv, docName]);
  useEffect(() => { if (ctxMenu) refreshProv(); }, [ctxMenu, refreshProv]);
  // coordinate-pinned figure comments (results/.figure-comments.json) — the lightbox surface
  const refreshFigCmts = useCallback(() => {
    api.draftingFigureComments(slug).then((r) => { if (r.ok) setFigCmts({ comments: r.comments || {}, provenance: r.provenance || {}, mtime: r.mtime || 0, version: r.version || "" }); }).catch(() => {});
  }, [slug]);
  useEffect(() => { refreshFigCmts(); }, [refreshFigCmts]);
  
  const saveFigCmts = useCallback(async (stem: string, items: FigureComment[]) => {
    const base = figCmtsRef.current.comments[stem] || [];
    setFigCmts((prev) => ({ ...prev, comments: { ...prev.comments, [stem]: items } }));   // optimistic
    try {
      let r = await api.draftingSaveFigureComments({ slug, stem, items, baseMtime: figCmtsRef.current.mtime, baseVersion: figCmtsRef.current.version });
      if (r.conflict) {
        const merged = reapplyById(r.currentComments || [], base, items);
        setFigCmts((prev) => ({ ...prev, comments: { ...prev.comments, [stem]: merged } }));
        r = await api.draftingSaveFigureComments({ slug, stem, items: merged, baseMtime: r.currentMtime ?? null, baseVersion: r.currentVersion });
        if (r.conflict) { refreshFigCmts(); toast.error("Figure comments changed elsewhere — reloaded"); return; }
      }
      if (r.ok) setFigCmts((prev) => ({ ...prev, comments: { ...prev.comments, [stem]: r.comments || prev.comments[stem] || [] }, mtime: r.mtime ?? prev.mtime, version: r.version ?? prev.version }));
    } catch { toast.error("Couldn't save figure comment"); }
  }, [slug, refreshFigCmts]);
  const openLightbox = useCallback((name: string) => {
    const base = name.replace(/^.*[\\/]/, "");
    const stem = base.replace(/\.[^.]+$/, "");
    const kind: "figure" | "table" = /\.(png|svg|jpe?g|gif|webp)$/i.test(base) ? "figure" : "table";
    setLightbox({ stem, kind });
  }, []);
  const lightboxGallery = useMemo(
    () => Object.keys(prov?.entries ?? {}).sort().map((stem) => ({
      stem, kind: (prov!.entries[stem].kind === "table" ? "table" : "figure") as "figure" | "table",
    })), [prov]);
  // insert a figure/table embed at the cursor from the Results pane (figures -> .png,
  // tables -> .csv so the editor routes to the typeset table renderer)
  const insertEmbed = useCallback((stem: string, kind: string, assetName?: string) => {
    const name = assetName || (kind === "table" ? stem + ".csv" : stem + ".png");
    manuscript.current?.insertAtCursor(`![[${name}]]`);
    toast.success("Inserted " + name);
    setTimeout(refreshProv, 400);
  }, [refreshProv]);
  // start a new hand-drawn concept diagram (shared by the Results header and the
  // right-click menu): name it, pop the draw.io editor; it embeds on first Save.
  const newDiagram = useCallback(async () => {
    const t = await dialogs.prompt({
      title: "New concept diagram",
      description: "Short name — becomes fig.<next>.<slug>.png in results/.",
      placeholder: "e.g. theoretical model",
      confirmLabel: "Create",
    });
    if (t && t.trim()) setDiagramEd({ name: null, title: t.trim() });
  }, [dialogs]);
  const [numPicker, setNumPicker] = useState(false);
  // a cell the Findings tab already chose — the composer opens standing on it
  const [numPreselect, setNumPreselect] = useState<NumberPreselect | null>(null);
  const [numbersTick, setNumbersTick] = useState(0);
  const insertNumber = useCallback(async (ins: NumberInsert) => {
    const ed = manuscript.current; if (!ed) return;
    const pos = ed.cursorPos();
    const text = ed.getText();
    const lineStart = text.lastIndexOf("\n", pos - 1) + 1;
    let prefix = text.slice(Math.max(lineStart, pos - 24), pos);
    if (prefix.length === 24 && /\S/.test(prefix[0]) && prefix.includes(" ")) prefix = prefix.slice(prefix.indexOf(" ") + 1);
    ed.insertAtCursor(ins.text);
    ed.focus();
    const quote = prefix + ins.text;
    let ok = 0, fail: string | null = null;
    for (const e of ins.entries) {
      const r = await api.draftingNumbersBind(slug, { ...e, quote, doc: docName });
      if (r.ok) ok++; else fail = r.error || "bind failed";
    }
    if (fail) toast.error("Inserted, but the binding was refused: " + fail);
    else toast.success(`Inserted ${ins.text} · bound ${ok} number${ok === 1 ? "" : "s"} to its source`);
    setNumbersTick((t) => t + 1);
  }, [slug, docName]);
  const [numFlagRows, setNumFlagRows] = useState<NumbersEntryRow[]>([]);
  const numFlagBusy = useRef(false);
  const refreshNumFlags = useCallback(async () => {
    if (projectDoc || numFlagBusy.current) return;
    numFlagBusy.current = true;
    try {
      const rep = await api.draftingNumbers(slug, docName, { inserted: true });
      const rows = rep?.docs?.[docName]?.results ?? [];
      setNumFlagRows(rows.filter((r) => r.inserted && (r.status === "DRIFT" || r.scriptState === "edited")));
    } catch { setNumFlagRows([]); }
    finally { numFlagBusy.current = false; }
  }, [slug, docName, projectDoc]);
  const flagsPushed = useRef(0);
  useEffect(() => {
    if (!numFlagRows.length && flagsPushed.current === 0) return;   // nothing to draw, nothing to clear
    const t = setTimeout(() => {
      const ed = manuscript.current; if (!ed) return;
      const flags: NumRange[] = numberFlags(ed.getText(), numFlagRows);
      flagsPushed.current = flags.length;
      ed.setNumberFlags(flags);
    }, 0);
    return () => clearTimeout(t);
  }, [numFlagRows]);
  useEffect(() => {
    if (projectDoc) return;
    const w = window as unknown as { requestIdleCallback?: (f: () => void, o?: { timeout: number }) => void };
    const go = () => { void refreshNumFlags(); };
    if (typeof w.requestIdleCallback === "function") w.requestIdleCallback(go, { timeout: 3000 });
    else window.setTimeout(go, 1500);
    // a hidden board window never fires visibilitychange, so it is a timer plus focus
    const beat = window.setInterval(go, 60000);
    window.addEventListener("focus", go);
    return () => { window.clearInterval(beat); window.removeEventListener("focus", go); };
  }, [refreshNumFlags, projectDoc]);
  useEffect(() => { if (numbersTick) void refreshNumFlags(); }, [numbersTick, refreshNumFlags]);
  useEffect(() => { if (paper.status === "saved") void refreshNumFlags(); }, [paper.status, refreshNumFlags]);
  // drop a bare "@" at the caret to open the citation search — the same flow as
  // typing @, but inline (never on its own line, so it reads as an in-text cite).
  const insertCitation = useCallback(() => {
    const ed = citeEd(); if (!ed) return;
    const pos = ed.cursorPos();
    ed.replaceRange(pos, pos, "@");
    ed.focus();
  }, []);
  // real project filenames, including local assets without provenance records
  const insertableEmbeds = useMemo(
    () => prov?.assets ?? Object.keys(prov?.entries ?? {}).sort().map((stem) => ({ name: stem + (prov!.entries[stem].kind === "table" ? ".csv" : ".png"), stem, kind: prov!.entries[stem].kind, caption: prov!.entries[stem].caption })),
    [prov]);
  const embedKey = useMemo(() => (paper.text.match(/^!\[\[[^\]]+\]\]\s*$/gm) || []).join("|"), [paper.text]);
  const firstEmbedKey = useRef(true);
  useEffect(() => {
    if (firstEmbedKey.current) { firstEmbedKey.current = false; return; }
    const t = setTimeout(refreshProv, 1500);
    return () => clearTimeout(t);
  }, [embedKey, refreshProv]);
  // the Integrity header's three counts — every class of untraceable claim in one place
  const integrity = useMemo(() => {
    const cites = Object.values(citeMap).filter((e) => !e.alias && (e.status === "unresolved" || e.status === "ambiguous")).length;
    const flags = review.comments.filter((c) => c.kind === "flag" && !c.resolved).length;
    const figs = prov ? prov.embeds.filter((e) => !e.exempt && (!e.resolved || e.provenance === "stale" || e.provenance === "none")).length : 0;
    return { cites, flags, figs, total: cites + flags + figs };
  }, [citeMap, review.comments, prov]);
  // jump the editor to a 1-based line of the OPEN doc (embeds in other docs can't scroll)
  const jumpToLine = useCallback((docOf: string, line: number) => {
    if (docOf !== docName) { toast.info("That embed lives in " + docOf + " — open it to jump"); return; }
    const text = manuscript.current?.getText() ?? paper.text;
    const lines = text.split("\n");
    let pos = 0;
    for (let i = 0; i < Math.min(line - 1, lines.length); i++) pos += lines[i].length + 1;
    manuscript.current?.scrollToPos(pos);
  }, [docName, paper.text]);
  const figRectData = useMemo(() => {
    const by: Record<string, FigRect[]> = {};
    const nums: Record<string, number> = {};
    const embedRe = /!\[\[([^\]]+)\]\]/;
    for (const c of review.comments) {
      if (c.kind !== "figure" || !commentIsOpen(c) || !c.rectPct) continue;
      const m = embedRe.exec(c.quote || "");
      if (!m) continue;
      const base = (m[1].split("|")[0].split("/").pop() || m[1]).trim();
      const n = (by[base]?.length || 0) + 1;
      (by[base] ||= []).push({ id: c.id, n, rect: c.rectPct });
      nums[c.id] = n;
    }
    return { by, nums };
  }, [review.comments]);
  // per-embed provenance chips for the editor caption rows
  const embedProvMap = useMemo(() => {
    const out: Record<string, EmbedProv> = {};
    for (const e of prov?.embeds ?? []) {
      const entry = prov!.entries[e.stem];
      const label = e.provenance === "fresh" ? (entry?.script?.split("/").pop() || "fresh")
        : e.provenance === "stale" ? "stale"
        : e.provenance === "none" ? "no provenance"
        : e.provenance === "external" ? (entry?.diagram ? "hand-drawn" : "manual") : e.provenance;
      out[e.name] = { status: e.provenance, label, suggestion: e.suggestion, diagram: entry?.diagram ?? null };
    }
    
    for (const name in assetStamps) {
      if (out[name]) out[name] = { ...out[name], stamp: assetStamps[name] };
      else out[name] = { status: "", label: "", stamp: assetStamps[name] };
    }
    return out;
  }, [prov, assetStamps]);
  // mechanical single-embed re-point (the same edit class as a hand fix: exact text swap)
  const repointEmbed = useCallback((e: DraftProvEmbed) => {
    if (!e.suggestion || e.doc !== docName) return;
    const ed = manuscript.current; if (!ed) return;
    const text = ed.getText();
    const target = `![[${e.name}]]`;
    const idx = text.indexOf(target);
    if (idx < 0) { toast.error("Embed text not found — edit it manually"); return; }
    ed.replaceRange(idx, idx + target.length, `![[${e.suggestion}]]`);
    toast.success("Re-pointed to " + e.suggestion);
    setTimeout(refreshProv, 800);
  }, [docName, refreshProv]);
  const [zoom, setZoom] = usePersistent<number>("aioa-drafting-zoom", 1);
  // "page" mode: render the manuscript on a clean white sheet (print/light tokens),
  // so it reads like the compiled PDF. paperShade tunes the paper from warm to white.
  const [pageOn, setPageOn] = usePersistent<boolean>("aioa-drafting-page", true);
  const [paperShade, setPaperShade] = usePersistent<number>("aioa-drafting-paper-shade", 100);
  const [pageOpen, setPageOpen] = useState(false);
  // consolidated toolbar menus: the doc icon (Document — open + formatting) and the
  // eye icon (View — read view, page view, white page, comments)
  const [docOpen, setDocOpen] = useState(false);
  const [viewOpen, setViewOpen] = useState(false);
  // page view: the manuscript as discrete printed pages, breaks from lib/pagination
  const [pageView, setPageView] = useState(false);
  const [pageProfile, setPageProfile] = usePersistent<PageProfile>("aioa-drafting-page-profile", "docx");
  // document typography — `font:`/`fontsize:` frontmatter, exactly like spacing:
  // the compiled Word/PDF, the page count, Page view and the editor all follow it
  const docFont = useMemo(() => readDocFont(paper.text), [paper.text]);
  const docSize = useMemo(() => readDocSize(paper.text), [paper.text]);
  const hasFontKey = useMemo(() => /^font\s*:/m.test(paper.text.slice(0, 400)), [paper.text]);
  const setDocKey = useCallback((key: string, value: string | null) => {
    const next = withFmKey(paper.text, key, value);
    if (next === paper.text) return;
    manuscript.current?.setContent(next);
    paper.setText(next);
  }, [paper]);
  // the Publish panel's choices (journal/blind/figures/notes) ride the same channel,
  // so they survive a reopen and reach every compile — one edit for all the keys
  const setDocKeys = useCallback((kv: Record<string, string>) => {
    let next = paper.text;
    for (const [k, v] of Object.entries(kv)) next = withFmKey(next, k, v);
    if (next === paper.text) return;
    manuscript.current?.setContent(next);
    paper.setText(next);
  }, [paper]);
  // live page count for the toolbar + in-editor break markers — one debounced
  // measurement at print geometry feeds both (Word layout: the docx artifact)
  const [pageEst, setPageEst] = useState<{ pages: number; approx: boolean } | null>(null);
  const [pageBreaks, setPageBreaks] = useState<{ offset: number; page: number }[]>([]);
  const [showBreaks, setShowBreaks] = usePersistent<boolean>("aioa-drafting-editor-breaks", true);
  useEffect(() => {
    if (projectDoc) { setPageEst(null); setPageBreaks([]); return; }
    const t = setTimeout(() => {
      try {
        // count + markers follow the Page view's profile choice (Word by default),
        // so the editor, the toolbar and the sheets always describe the same artifact
        const r = paginate(paper.text, { profile: pageProfile, spacing, blind: true });
        const rough = r.approx || r.refsUnknown || r.blockList.some((b) => b.kind === "figure" || b.kind === "table");
        setPageEst({ pages: r.pages, approx: rough });
        setPageBreaks(r.slices.filter((s) => s.page > 1).map((s) => ({ offset: s.topOffset, page: s.page })));
      } catch { setPageEst(null); setPageBreaks([]); }
    }, 700);
    return () => clearTimeout(t);
  }, [paper.text, spacing, projectDoc, pageProfile]);
  const [readMode, setReadMode] = useState(false);
  // visual mode yields to read mode (the clean-page proofread) — both are exits
  // from the raw-markdown surface, but read mode is the more deliberate one
  const pageActive = pageOn || readMode;        // read mode always renders the white sheet
  const pageStyle = useMemo<React.CSSProperties | undefined>(() => {
    const disp: Record<string, string> = {};
    if (hasFontKey) disp["--draft-font"] = DOC_FONTS[docFont].css;
    if (docSize !== 12) {
      const base = style === "oped" ? 18 : 16.5;
      disp["--draft-fontsize"] = (Math.round(base * (docSize / 12) * 10) / 10) + "px";
    }
    if (spacing === "double" && !projectDoc) disp["--draft-leading"] = "2.05";
    return Object.keys(disp).length ? (disp as React.CSSProperties) : undefined;
  }, [hasFontKey, docFont, docSize, spacing, style, projectDoc]);
  const paperBg = pageActive ? `hsl(40 30% ${readMode ? 100 : paperShade}%)` : undefined;   // read mode = pure white
  const [geoTick, setGeoTick] = useState(0);
  const prevMargin = useRef(false);
  const enterRead = useCallback(() => {
    prevMargin.current = marginOpen;
    setReadMode(true); setMarginOpen(false);
    setOutlineOpen(false); setCorpusOpen(false); setDocSwitchOpen(false); setResultsOpen(false); setStyleOpen(false); setPageOpen(false);
    setDocOpen(false); setViewOpen(false); setPageView(false);
    try { document.documentElement.requestFullscreen?.(); } catch { /* webview may block it */ }
  }, [marginOpen]);
  const exitRead = useCallback(() => {
    setReadMode(false); setMarginOpen(prevMargin.current);
    try { if (document.fullscreenElement) document.exitFullscreen?.(); } catch { /* noop */ }
  }, []);

  const scrollRef = useRef<HTMLDivElement>(null);
  const manuHostRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const cardEls = useRef<Map<string, HTMLDivElement | null>>(new Map());
  const soloPillRef = useRef<HTMLButtonElement | null>(null);

  const zoomAnchor = useRef<{ pos: number; offset: number } | null>(null);
  const pinRaf = useRef(0);
  const captureZoomAnchor = useCallback(() => {
    const sc = scrollRef.current, m = manuscript.current;
    if (!sc || !m) { zoomAnchor.current = null; return; }
    const rect = sc.getBoundingClientRect();
    const probeY = rect.top + Math.min(rect.height * 0.5, 120);   // a fully-visible line near the top
    const pos = m.posAtViewportY(probeY);
    if (pos == null) { zoomAnchor.current = null; return; }
    const top = m.screenTopOf(pos);
    zoomAnchor.current = top == null ? null : { pos, offset: top - rect.top };
  }, []);
  const applyZoomPin = useCallback(() => {
    const a = zoomAnchor.current; if (!a) return true;
    const sc = scrollRef.current, m = manuscript.current;
    if (!sc || !m) return true;
    m.requestMeasure();
    const top = m.screenTopOf(a.pos);
    if (top == null) return true;
    const residual = (top - sc.getBoundingClientRect().top) - a.offset;
    if (Math.abs(residual) < 1) return true;
    sc.scrollTop += residual;
    return false;
  }, []);
  useLayoutEffect(() => {
    if (!zoomAnchor.current) return;
    if (pinRaf.current) cancelAnimationFrame(pinRaf.current);
    applyZoomPin();                       // immediate correction, pre-paint (no flash)
    let frames = 0;
    const tick = () => {
      const settled = applyZoomPin();
      if (settled || ++frames > 16) { pinRaf.current = 0; zoomAnchor.current = null; return; }
      pinRaf.current = requestAnimationFrame(tick);
    };
    pinRaf.current = requestAnimationFrame(tick);   // chase CM's async re-measures to a stop
  }, [zoom, applyZoomPin]);
  useEffect(() => () => { if (pinRaf.current) cancelAnimationFrame(pinRaf.current); }, []);
  // every zoom mutation captures the anchor first, then nudges zoom within [0.7, 1.8]
  const zoomBy = useCallback((delta: number) => {
    captureZoomAnchor();
    setZoom((z) => Math.min(1.8, Math.max(0.7, Math.round((z + delta) * 10) / 10)));
  }, [captureZoomAnchor, setZoom]);
  const zoomReset = useCallback(() => { captureZoomAnchor(); setZoom(1); }, [captureZoomAnchor, setZoom]);
  const zoomByRef = useRef(zoomBy);
  useEffect(() => { zoomByRef.current = zoomBy; }, [zoomBy]);

  const [embeds, setEmbeds] = useState<Record<string, string>>({});
  const [tablePngs, setTablePngs] = useState<Record<string, boolean>>({});
  const fetched = useRef<Set<string>>(new Set());
  const embedNames = useMemo(() => extractMdEmbeds(paper.text), [paper.text]);
  useEffect(() => {
    const missing = embedNames.filter((n) => !fetched.current.has(n));
    if (!missing.length) return;
    missing.forEach((n) => fetched.current.add(n));
    let cancelled = false;
    Promise.all(missing.map((n) => api.draftingEmbed(slug, n).then((r) => [n, r.text ?? "", !!r.typesetPdf] as const).catch(() => [n, "", false] as const)))
      .then((triples) => {
        if (cancelled) return;
        setEmbeds((prev) => { const next = { ...prev }; for (const [n, t] of triples) next[n] = t; return next; });
        setTablePngs((prev) => { const next = { ...prev }; for (const [n, , pdf] of triples) if (pdf) next[n] = true; return next; });
      });
    return () => { cancelled = true; };
  }, [embedNames, slug]);

  const refreshCiteMap = useCallback(() => { api.draftingCiteMap(slug, docName).then((r) => setCiteMap(r.map || {})).catch(() => {}); }, [slug, docName]);
  useEffect(() => { refreshCiteMap(); }, [refreshCiteMap]);
  useEffect(() => {
    const off = onCiteIndex(setCiteIdxState);
    const w = window as unknown as { requestIdleCallback?: (f: () => void, o?: { timeout: number }) => void };
    const go = () => { loadCiteIndex(); };
    if (typeof w.requestIdleCallback === "function") w.requestIdleCallback(go, { timeout: 2000 });
    else window.setTimeout(go, 60);
    return off;
  }, []);
  useEffect(() => { onPaperSaved.current = refreshCiteMap; }, [refreshCiteMap]);

  const refBtnOn = !projectDoc || docName === "readme.md";
  const citeSig = useMemo(() => Object.keys(citeMap).sort().join("|"), [citeMap]);
  useEffect(() => {
    if (!refBtnOn) { setRefFlags({ flagged: 0, unmatched: 0 }); return; }
    if (refOpen) return;
    let live = true;
    const id = setTimeout(() => {
      api.draftingReferences(slug, docName, refStyle)
        .then((r) => {
          if (!live || r.error) return;
          setRefFlags({
            flagged: (r.entries || []).filter((e) => refIssues(e.flags).length > 0).length,
            unmatched: (r.unresolved?.length ?? 0) + (r.ambiguous?.length ?? 0),
          });
        })
        .catch(() => {});
    }, 1200);
    return () => { live = false; clearTimeout(id); };
  }, [slug, docName, refStyle, refBtnOn, refOpen, citeSig]);

  const manuParas = useMemo(() => parseManuscript(paper.text), [paper.text]);
  const edModel = useMemo(() => parseEditor(ann.text), [ann.text]);
  const comments = useMemo(() => joinComments(manuParas, edModel), [manuParas, edModel]);
  const matched = useMemo(() => comments.filter((c) => c.itemIndex >= 0), [comments]);
  const headings = useMemo(() => parseHeadings(paper.text), [paper.text]);
  // title derived LIVE from the manuscript (first H1 / frontmatter title) so editing
  // the draft's first header updates the toolbar + outline title without a reload
  const liveTitle = useMemo(() => deriveTitle(paper.text, slug), [paper.text, slug]);
  const activeFp = useMemo(() => { let fp = ""; for (const c of matched) if (c.para.pos <= activePos) fp = c.para.fp; return fp; }, [matched, activePos]);
  // CM's initial cursor (first prose paragraph) doesn't fire onCursor, so seed
  // activePos on mount → the first paragraph's card shows its Suggested section right away
  useEffect(() => { const id = setTimeout(() => setActivePos(manuscript.current?.cursorPos() ?? 0), 60); return () => clearTimeout(id); }, []);
  // the active card grows/shrinks (its Suggested section toggles) → re-align the margin
  useEffect(() => { setGeoTick((t) => t + 1); }, [activeFp]);

  const jumpRaf = useRef(0);
  const scrollToParaPos = useCallback((pos: number, o?: { eased?: boolean; nearest?: boolean; held?: boolean }) => {
    const sc = scrollRef.current, host = manuHostRef.current, m = manuscript.current;
    if (!sc || !host || !m) return;
    const GAP = 24;
    const est = m.posTop(pos) ?? 0;
    const hostTop = host.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
    const at = hostTop + est;
    // where the container is HEADED, not the frame it happens to be on: a held arrow walking
    // the rail must accumulate onto its own animation instead of fighting it.
    const head = o?.eased ? targetTop(sc) : sc.scrollTop;
    // already comfortably on screen: walking two comments on ONE passage must not re-yank
    // the manuscript at every keypress
    if (o?.nearest && at >= head + GAP && at <= head + sc.clientHeight - GAP * 3) return;
    const target = Math.max(0, at - GAP);
    if (o?.eased) easeScrollTo(sc, target, { held: o.held });
    else sc.scrollTop = target;                          // pass 1: estimate, brings it into view
    if (jumpRaf.current) cancelAnimationFrame(jumpRaf.current);
    let frames = 0, fixes = 0;
    const tick = () => {
      m.requestMeasure();
      const screenTop = m.screenTopOf(pos);              // real DOM top once the line is rendered
      if (screenTop != null) {
        const residual = (screenTop - sc.getBoundingClientRect().top) - GAP - (o?.eased ? pendingOf(sc) : 0);
        if (Math.abs(residual) < (o?.eased ? 2 : 1)) { jumpRaf.current = 0; return; }
        if (o?.eased) {
          easeScrollBy(sc, residual, { held: o.held });
          // an eased reveal corrects a bounded number of times and then hands the scroller
          // back: a loop that kept writing would fight a wheel gesture for a fifth of a second
          if (++fixes >= 3) { jumpRaf.current = 0; return; }
        } else sc.scrollTop += residual;
      }
      jumpRaf.current = ++frames < (o?.eased ? 30 : 12) ? requestAnimationFrame(tick) : 0;
    };
    jumpRaf.current = requestAnimationFrame(tick);
  }, []);
  useEffect(() => () => { if (jumpRaf.current) cancelAnimationFrame(jumpRaf.current); }, []);

  // apply a structural edit to the manuscript (a section move/remove/add from the
  // outline) — push it into CM + state (autosaves, mtime-guarded) and reveal the change
  const applyPaperEdit = useCallback((next: string, caretPos?: number) => {
    manuscript.current?.setContent(next);
    paper.setText(next);
    if (caretPos != null) setTimeout(() => scrollToParaPos(caretPos), 60);
  }, [paper, scrollToParaPos]);

  // the full-screen Publish panel (compile to PDF + options + inline preview)
  const [publishOpen, setPublishOpen] = useState(false);

  const paperRef = useRef(paper); useEffect(() => { paperRef.current = paper; });
  const reviewRef = useRef(review); useEffect(() => { reviewRef.current = review; });
  const divergedRef = useRef(diverged); useEffect(() => { divergedRef.current = diverged; }, [diverged]);
  const activeCommentRef = useRef(activeComment); useEffect(() => { activeCommentRef.current = activeComment; }, [activeComment]);
  const soloCommentRef = useRef(soloComment); useEffect(() => { soloCommentRef.current = soloComment; }, [soloComment]);
  // one funnel for every way a comment stops being active — caret leaving the span, the
  // comment being deleted, an external edit dropping it. Solo can never outlive its card.
  useEffect(() => { if (!activeComment) setSoloComment(null); }, [activeComment]);
  // keep the highlight gate current within render so every pushRanges caller sees it: the
  // inline highlights are hidden whenever the Comments rail is closed (focus the writing)
  const marginOpenRef = useRef(marginOpen); marginOpenRef.current = marginOpen;
  const mentionLiveRef = useRef(mention); mentionLiveRef.current = mention;

  const pushRanges = useCallback((list: DraftComment[], fresh = false): string[] => {
    const ed = manuscript.current; if (!ed) return [];
    const text = ed.getText();
    const live = new Map((fresh ? [] : ed.commentRanges()).map((r) => [r.id, r] as const));
    const ranges: CRange[] = []; const orphan: string[] = [];
    for (const c of list) {
      const cur = live.get(c.id);
      const r = cur ? { from: cur.from, to: cur.to } : locate(text, c);
      if (r && r.to > r.from) ranges.push({ id: c.id, from: r.from, to: r.to, resolved: !commentIsOpen(c),
        ...(commentIsOpen(c) && effectiveSuggestion(c)?.status === "open" ? { reveal: true } : null) });
      else if (!isDecidedSuggestion(c)) orphan.push(c.id);
    }
    // rail closed → no inline highlights (orphan tracking still computed for when it reopens)
    ed.setCommentRanges(marginOpenRef.current ? ranges : []);
    return orphan;
  }, []);

  const pinsRef = useRef<string[]>([]);
  const lateRef = useRef(new Set<string>());
  // ids this tab detached: undoing back to disk's own text must still post their re-attach
  const detachedHereRef = useRef(new Set<string>());
  const reconcileOrphans = useCallback((goneAll: string[]): { left: string[]; wrote: boolean } => {
    const ed = manuscript.current;
    if (!ed || !goneAll.length || ed.getText().trim() === "") return { left: goneAll, wrote: false };
    const text = ed.getText();
    const cur = reviewRef.current.comments;
    const byId = new Map(cur.map((c) => [c.id, c] as const));
    const back: CRange[] = [];
    for (const id of goneAll) {
      const c = byId.get(id); if (!c) continue;
      const r = locate(text, c);
      if (r && r.to > r.from) back.push({ id, from: r.from, to: r.to, resolved: !commentIsOpen(c),
        ...(commentIsOpen(c) && effectiveSuggestion(c)?.status === "open" ? { reveal: true } : null) });
    }
    if (back.length && marginOpenRef.current) {
      const ids = new Set(back.map((r) => r.id));
      ed.setCommentRanges([...ed.commentRanges().filter((r) => !ids.has(r.id)), ...back]);
    }
    const found = new Set(back.map((r) => r.id));
    const left = goneAll.filter((id) => !found.has(id));
    const detach = new Set(left.filter((id) => { const c = byId.get(id); return c && !c.detached && !lateRef.current.has(id) && !isDecidedSuggestion(c); }));
    if (!detach.size || text === paperRef.current.diskText()) { if (back.length) setGeoTick((t) => t + 1); return { left, wrote: false }; }
    const now = Date.now();
    for (const id of detach) detachedHereRef.current.add(id);
    reviewRef.current.setComments(cur.map((c) => detach.has(c.id) ? { ...detachAt(c, text, ed.commentGoneAt(c.id), now), orphaned: true } : c));
    setGeoTick((t) => t + 1);
    return { left, wrote: true };
  }, []);

  const settleOrphans = useCallback((orphan: string[]) => {
    if (lateRef.current.size) { const live = new Set((manuscript.current?.commentRanges() ?? []).map((r) => r.id)); for (const id of [...lateRef.current]) if (live.has(id)) lateRef.current.delete(id); }
    setOrphans(reconcileOrphans(orphan).left); setGeoTick((g) => g + 1); }, [reconcileOrphans]);
  const resolvedPending = review.resolvedPending;
  useEffect(() => {
    if (!resolvedPending) return;
    let off = false, timer = 0, tries = 0;
    const later = (ms: number) => { if (!off) timer = window.setTimeout(run, ms); };
    const run = async () => {
      if (off) return;
      const rv = reviewRef.current;
      if (!rv.resolvedPending) return;
      if (rv.isDirty() || rv.inFlight()) { later(1500); return; }
      let half = recallResolved(slug, ck, rv.version());
      let ver = rv.version();
      if (!half) {
        try {
          const r = await api.draftingResolvedComments(slug, docName);
          if (r.ok && Array.isArray(r.comments)) { half = r.comments; ver = r.version ?? ""; }
        } catch { /* stay partial */ }
        if (off) return;
      }
      const res = half ? reviewRef.current.mergeResolved(half, ver) : "stale";
      if (res === "busy") { later(1500); return; }
      if (res === "stale") { if (++tries < 4) later(6000 * tries); return; }
      for (const id of res) lateRef.current.add(id);
    };
    const w = window as unknown as { requestIdleCallback?: (f: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (n: number) => void };
    let idleId = 0;
    timer = window.setTimeout(() => {
      if (typeof w.requestIdleCallback === "function") idleId = w.requestIdleCallback(() => { void run(); }, { timeout: 4000 });
      else void run();
    }, 900);
    return () => { off = true; window.clearTimeout(timer); if (idleId && w.cancelIdleCallback) w.cancelIdleCallback(idleId); };
  }, [resolvedPending, slug, ck, docName]);
  const structSig = review.comments.map((c) => c.id + (commentIsOpen(c) ? "" : "·r")).join("|");
  useEffect(() => { const t = setTimeout(() => settleOrphans(pushRanges(reviewRef.current.comments)), 0); return () => clearTimeout(t); }, [structSig, pushRanges, settleOrphans]);
  // seed highlights once the editor has mounted (the structSig effect can fire before CM is ready)
  useEffect(() => { const t = setTimeout(() => settleOrphans(pushRanges(reviewRef.current.comments, true)), 140); return () => clearTimeout(t); }, [pushRanges, settleOrphans]);
  // toggling the Comments rail re-pushes (re-locate by quote when reopening, clear when closing)
  useEffect(() => { settleOrphans(pushRanges(reviewRef.current.comments, true)); }, [marginOpen, pushRanges, settleOrphans]);
  // mirror the active comment into the editor's highlight emphasis
  useEffect(() => { manuscript.current?.setActiveComment(activeComment); }, [activeComment]);

  useEffect(() => {
    const id = setTimeout(() => {
      const ed = manuscript.current; if (!ed) return;
      // when the rail is closed there are no live highlight spans to refresh from — skip,
      // so we never spuriously orphan every comment. Reopening re-locates by quote.
      if (!marginOpenRef.current) return;
      const live = new Map(ed.commentRanges().map((r) => [r.id, r] as const));
      const cur = reviewRef.current.comments;
      for (const id of [...lateRef.current]) if (live.has(id)) lateRef.current.delete(id);
      // a span CM no longer tracks: re-found by its quote, else detached (never dropped)
      const gone = cur.filter((c) => !live.has(c.id)).map((c) => c.id);
      if (gone.length) {
        const rc = reconcileOrphans(gone);
        if (rc.wrote) { setOrphans(rc.left); return; }   // detached; the next pass refreshes anchors
        for (const r of ed.commentRanges()) live.set(r.id, r);
      }
      // keep each surviving comment's quote/prefix/suffix fresh from its live span so a
      // later reload re-anchors against current text (no re-push → no flicker).
      const text = ed.getText(); let changed = false, mine = false;
      const next = cur.map((c) => {
        const r = live.get(c.id);
        if (!r && lateRef.current.has(c.id)) return c;   // late and never located: left exactly as stored
        if (!r && isDecidedSuggestion(c)) return c;      // an accepted cut has no span left: kept as is
        if (!r) return c.orphaned ? c : ((changed = true), { ...c, orphaned: true });   // disk's own text: orphaned, not posted
        const a = makeAnchor(text, r.from, r.to);
        if (a.quote !== c.quote || a.prefix !== c.prefix || a.suffix !== c.suffix || c.orphaned || c.detached) {
          changed = true;
          if (c.detached && detachedHereRef.current.delete(c.id)) mine = true;
          return { ...attached(c), ...a };
        }
        return c;
      });
      if (changed) {
        if (text !== paperRef.current.diskText() || mine) reviewRef.current.setComments(next);
        else reviewRef.current.adopt(next);
        setOrphans(next.filter((c) => c.orphaned).map((c) => c.id));
      }
    }, 1300);
    return () => clearTimeout(id);
  }, [paper.text, reconcileOrphans]);

  // ⌘Z putting a span back (commentUndo) re-attaches a detached comment: the anchor
  // refresh above sees its live span and clears the marks. Nothing is ever dropped to restore.

  const addComment = useCallback((sel: { from: number; to: number; text: string; kind?: "text" | "figure"; rectPct?: DraftCommentRect | null }, body: string, proposed?: string) => {
    const ed = manuscript.current; if (!ed) return;
    const a = makeAnchor(ed.getText(), sel.from, sel.to);
    const id = (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : "c" + Date.now().toString(36) + Math.round(Math.random() * 1e6).toString(36);
    const now = Date.now();
    const c: DraftComment = { id, ...a, body: body.trim(), resolved: false, created: now, updated: now, kind: sel.kind ?? "text", rectPct: sel.rectPct ?? null,
      // a suggested change remembers the exact text it replaces: Accept refuses if that moved
      ...(proposed != null ? { suggestion: { proposed, status: "open" as const, original: a.quote } } : null) };
    reviewRef.current.setComments([...reviewRef.current.comments, c]);
    setMarginOpen(true);   // a new comment always reveals the rail so its highlight + card show
    ed.setCommentRanges([...ed.commentRanges(), { id, from: sel.from, to: sel.to, resolved: false }]);
    setActiveComment(id); setGeoTick((t) => t + 1);
  }, [setMarginOpen]);
  const updateComment = useCallback((id: string, patch: Partial<DraftComment>) => {
    const next = reviewRef.current.comments.map((c) => c.id === id ? { ...c, ...patch, updated: Date.now() } : c);
    reviewRef.current.setComments(next);
    pushRanges(next);
  }, [pushRanges]);
  const reattachComment = useCallback((id: string) => {
    rwApi.current?.selectionToMain();
    const ed = manuscript.current, sel = ed?.getView()?.state.selection.main;
    const c0 = reviewRef.current.comments.find((c) => c.id === id);
    if (!ed || !c0) return;
    if (!sel || sel.empty) { toast("Select the text to attach it to first", { id: "cmt-reattach" }); return; }
    const a = makeAnchor(ed.getText(), sel.from, sel.to);
    reviewRef.current.setComments(reviewRef.current.comments.map((c) => c.id === id ? { ...attached(c), ...a, updated: Date.now() } : c));
    if (marginOpenRef.current) ed.setCommentRanges([...ed.commentRanges().filter((r) => r.id !== id), { id, from: sel.from, to: sel.to, resolved: !commentIsOpen(c0) }]);
    setOrphans((o) => o.filter((x) => x !== id));
    setActiveComment(id); setGeoTick((t) => t + 1);
  }, []);
  const deleteComment = useCallback((id: string) => {
    if (pinsRef.current.includes(id)) { toast("Unpin the comment to delete it"); return; }
    reviewRef.current.remove(id);
    const ed = manuscript.current;
    ed?.setCommentRanges(ed.commentRanges().filter((r) => r.id !== id));
    if (activeCommentRef.current === id) setActiveComment(null);
    setGeoTick((t) => t + 1);
  }, []);
  const addFlag = useCallback((from: number, to: number): string | null => {
    const ed = manuscript.current; if (!ed || to <= from) return null;
    const a = makeAnchor(ed.getText(), from, to);
    const id = (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : "c" + Date.now().toString(36) + Math.round(Math.random() * 1e6).toString(36);
    const now = Date.now();
    const c: DraftComment = { id, ...a, body: "", resolved: false, created: now, updated: now, kind: "flag", focusFlag: true, rectPct: null };
    reviewRef.current.setComments([...reviewRef.current.comments, c]);
    if (marginOpenRef.current) ed.setCommentRanges([...ed.commentRanges(), { id, from, to, resolved: false }]);
    setActiveComment(id); setGeoTick((t) => t + 1);
    return id;
  }, []);
  // Empty flag notes stay empty when Focus closes.
  const closeFocus = useCallback(() => { setFocusOpen(false); }, []);
  const unflag = useCallback((ids: string[]) => {
    const drop = new Set(ids), now = Date.now();
    reviewRef.current.setComments(reviewRef.current.comments.map((c) => drop.has(c.id) ? { ...c, resolved: true, updated: now } : c));
    setGeoTick((t) => t + 1);
  }, []);

  const baseQuotes = useRef(new Map<string, string>());
  for (const c of review.comments) if (!baseQuotes.current.has(c.id)) baseQuotes.current.set(c.id, c.quote);
  const sugOf = (c: DraftComment): DraftCommentSuggestion | null => {
    const s = effectiveSuggestion(c);
    if (!s) return null;
    return { proposed: s.proposed, status: s.status, original: s.original ?? baseQuotes.current.get(c.id) ?? c.quote, ...(s.decided ? { decided: s.decided } : null) };
  };
  // the text Accept would replace right now, so the card's diff shows the real change
  const suggestionBase = (c: DraftComment): string | undefined => {
    const s = effectiveSuggestion(c);
    if (!s || s.status !== "open") return undefined;
    const text = paper.text ?? "";
    const r = locate(text, c);
    if (!r) return undefined;
    const span = suggestionSpan(text, r, s.proposed);
    return text.slice(span.from, span.to);
  };
  const [acceptErrs, setAcceptErrs] = useState<Record<string, string>>({});
  const acceptFail = useRef<string>("");
  const acceptInto = (id: string, list: DraftComment[]): DraftComment[] | null => {
    acceptFail.current = "";
    const ed = manuscript.current; if (!ed) { acceptFail.current = "The editor is not ready; try again in a moment."; return null; }
    const c = list.find((x) => x.id === id);
    const s = c ? sugOf(c) : null;
    if (!c || !s || s.status !== "open") return null;
    const text = ed.getText();
    const original = s.original ?? c.quote;
    const live = ed.commentRanges().find((x) => x.id === id);
    let r: { from: number; to: number } | null = live ? { from: live.from, to: live.to } : locate(text, c);
    if (!r || text.slice(r.from, r.to) !== original) {
      const hit = original ? locate(text, { quote: original, prefix: c.prefix, suffix: c.suffix }) : null;
      r = hit && text.slice(hit.from, hit.to) === original ? hit : null;
    }
    if (!r) {
      acceptFail.current = "Not applied: the original text is no longer in the paper. Edit by hand, or reject.";
      return null;
    }
    // the rewrite replaces the phrase, sentence or paragraph it was written for (suggestSpan)
    const span = suggestionSpan(text, r, s.proposed);
    const replaced = text.slice(span.from, span.to);
    const insert = s.proposed;
    ed.replaceRange(span.from, span.to, insert);
    const to = span.from + insert.length;
    const a = makeAnchor(ed.getText(), span.from, to);
    // Retain its mapped anchor for reconcile and undo, but stop shading it immediately.
    if (marginOpenRef.current) {
      ed.setCommentRanges([...ed.commentRanges().filter((x) => x.id !== id), { id, from: span.from, to, resolved: true }]);
    }
    const now = Date.now();
    return list.map((x) => x.id === id
      ? { ...x, ...(a.quote ? a : null), orphaned: false, resolved: true, updated: now,
          suggestion: { ...s, original: replaced, status: "accepted" as const, decided: new Date(now).toISOString() } }
      : x);
  };
  // after an Accept the paper and the comment store are written NOW, not after the idle
  // debounce, so the other machine's tab (and this one's rail) see the change at once
  const saveAfterAccept = () => {
    window.setTimeout(() => { void paperRef.current.flush(); void reviewRef.current.flush(); }, 60);
  };
  const noteAcceptErrs = (failed: Record<string, string>, ok: string[]) => setAcceptErrs((m) => {
    const n = { ...m };
    for (const id of ok) delete n[id];
    Object.assign(n, failed);
    return n;
  });
  const acceptSuggestion = useCallback(async (id: string) => {
    if (await refuseAcceptIfStale()) return;
    const next = acceptInto(id, reviewRef.current.comments);
    if (!next) {
      const c = reviewRef.current.comments.find((x) => x.id === id);
      if (c && sugOf(c)?.status === "open") {
        const why = acceptFail.current || "Not applied: the text changed since the suggestion.";
        noteAcceptErrs({ [id]: why }, []);
        toast.error(why, { id: "cmt-suggest-stale" });
      }
      return;
    }
    noteAcceptErrs({}, [id]);
    reviewRef.current.setComments(next);
    setOrphans((o) => o.filter((x) => x !== id));
    setGeoTick((t) => t + 1);
    saveAfterAccept();
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps
  // One toast Undo for the batch, with an inverse mapped through subsequent edits.
  const reviewBatchToken = useRef(0);
  const [reviewUndoAction, setReviewUndoAction] = useState<{ label: string; onClick: () => void } | null>(null);
  const startReviewBatch = () => {
    const view = manuscript.current?.getView();
    if (!view) return null;
    if (!view.state.field(reviewUndoField, false)) view.dispatch({ effects: StateEffect.appendConfig.of(reviewUndoField) });
    view.dispatch({ effects: reviewUndoState.of({ inverse: ChangeSet.empty(view.state.doc.length), collecting: true }) });
    return { view, token: ++reviewBatchToken.current, before: reviewRef.current.comments };
  };
  const finishReviewBatch = (batch: NonNullable<ReturnType<typeof startReviewBatch>>, ids: string[]) => {
    const { view, token, before } = batch;
    view.dispatch({ effects: reviewUndoState.of({ ...view.state.field(reviewUndoField), collecting: false }) });
    const action = { label: "Undo", onClick: () => {
      if (reviewBatchToken.current !== token || manuscript.current?.getView() !== view) return;
      const inverse = view.state.field(reviewUndoField).inverse;
      if (!inverse) return;
      ++reviewBatchToken.current;
      setReviewUndoAction(null);
      toast.dismiss("cmt-review-batch");
      view.dispatch({ changes: inverse, effects: reviewUndoState.of({ inverse: null, collecting: false }) });
      // Restore only this batch's decisions. Preserve newly filed notes and edited replies.
      const restoredText = view.state.doc.toString();
      const restoredAnchors = new Map(before.filter((c) => {
        const at = locate(restoredText, c);
        return at && restoredText.slice(at.from, at.to) === c.quote;
      }).map((c) => [c.id, c]));
      const restore = new Map(before.filter((c) => ids.includes(c.id)).map((c) => [c.id, c]));
      const current = reviewRef.current.comments;
      const next = current.map((c) => {
        const decision = restore.get(c.id), anchor = restoredAnchors.get(c.id) ?? decision;
        restore.delete(c.id);
        if (!decision && !anchor) return c;
        return { ...c, ...(anchor ? { quote: anchor.quote, prefix: anchor.prefix, suffix: anchor.suffix, orphaned: anchor.orphaned } : {}),
          ...(decision ? { resolved: decision.resolved, suggestion: decision.suggestion } : {}), updated: Date.now() };
      });
      for (const c of restore.values()) next.push({ ...c, updated: Date.now() });
      reviewRef.current.setComments(next);
      setOrphans(pushRanges(next, true));
      setGeoTick((t) => t + 1);
    } };
    setReviewUndoAction(ids.length ? action : null);
    return action;
  };
  // Every open suggestion, bottom first, through the same stale-text refusal and writer.
  const openSuggestionIds = review.comments.filter((c) => commentIsOpen(c) && effectiveSuggestion(c)?.status === "open").map((c) => c.id);
  const openAgentCommentIds = review.comments.filter((c) => commentIsOpen(c) && c.author !== "owner").map((c) => c.id);
  const acceptSuggestions = useCallback(async (only?: string[]) => {
    if (await refuseAcceptIfStale()) return;
    const ed = manuscript.current; if (!ed) return;
    let list = reviewRef.current.comments;
    const text = ed.getText();
    const posOf = (c: DraftComment) => ed.commentRanges().find((x) => x.id === c.id)?.from ?? locate(text, c)?.from ?? -1;
    const ids = list.filter((c) => commentIsOpen(c) && sugOf(c)?.status === "open" && (!only || only.includes(c.id)))
      .sort((a, b) => posOf(b) - posOf(a)).map((c) => c.id);
    if (!ids.length) return;
    const batch = startReviewBatch(); if (!batch) return;
    const accepted: string[] = [];
    const failed: Record<string, string> = {};
    for (const id of ids) {
      const next = acceptInto(id, list);
      if (next) { list = next; accepted.push(id); }
      else failed[id] = acceptFail.current || "Not applied: the text changed since the suggestion.";
    }
    noteAcceptErrs(failed, accepted);
    if (accepted.length) {
      reviewRef.current.setComments(list);
      pushRanges(list);
      setOrphans((o) => o.filter((x) => !accepted.includes(x)));
      setGeoTick((t) => t + 1);
      saveAfterAccept();
    }
    const action = finishReviewBatch(batch, accepted);
    const left = ids.length - accepted.length;
    const options = { id: "cmt-review-batch", duration: 20000, ...(accepted.length ? { action } : {}) };
    if (left) toast.error(`Accepted ${accepted.length} of ${ids.length}; ${left} changed since suggested — left open`, options);
    else toast.success(`Accepted ${accepted.length} suggestion${accepted.length === 1 ? "" : "s"}`, options);
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps
  const resolveAllComments = (only: string[]) => {
    const list = reviewRef.current.comments;
    const ids = list.filter((c) => only.includes(c.id) && commentIsOpen(c) && c.author !== "owner").map((c) => c.id);
    if (!ids.length) return;
    const batch = startReviewBatch(); if (!batch) return;
    const next = list.map((c) => ids.includes(c.id) ? { ...c, resolved: true, updated: Date.now() } : c);
    reviewRef.current.setComments(next);
    pushRanges(next);
    if (ids.includes(activeCommentRef.current ?? "")) setActiveComment(null);
    setGeoTick((t) => t + 1);
    toast.success(`Resolved ${ids.length} comment${ids.length === 1 ? "" : "s"}`, {
      id: "cmt-review-batch", duration: 20000, action: finishReviewBatch(batch, ids),
    });
  };
  const runReviewBatch = (action: "accept" | "resolve", ids: string[]) => {
    closeReviewMenu();
    if (action === "accept") void acceptSuggestions(ids); else resolveAllComments(ids);
  };
  const requestReviewBatch = (action: "accept" | "resolve", ids: string[]) => {
    if (ids.length > 20) { setReviewMenuOpen(true); setReviewConfirm({ action, ids }); } else runReviewBatch(action, ids);
  };
  const acceptAllSuggestions = () => requestReviewBatch("accept", openSuggestionIds);
  const rejectSuggestion = useCallback((id: string) => {
    const c = reviewRef.current.comments.find((x) => x.id === id);
    const s = c ? sugOf(c) : null;
    if (!s || s.status !== "open") return;
    updateComment(id, { resolved: true, suggestion: { ...s, status: "rejected", decided: new Date().toISOString() } });
  }, [updateComment]);   // eslint-disable-line react-hooks/exhaustive-deps
  const setProposed = useCallback((id: string, proposed: string) => {
    const c = reviewRef.current.comments.find((x) => x.id === id);
    const s = c ? sugOf(c) : null;
    if (!s || s.status !== "open") return;
    setAcceptErrs((m) => { if (!(id in m)) return m; const n = { ...m }; delete n[id]; return n; });
    updateComment(id, { suggestion: { ...s, proposed } });
  }, [updateComment]);   // eslint-disable-line react-hooks/exhaustive-deps
  const rewriteToSuggestion = useCallback((id: string, replyBody: string) => {
    const c = reviewRef.current.comments.find((x) => x.id === id); if (!c) return;
    const ed = manuscript.current;
    const live = ed?.commentRanges().find((x) => x.id === id);
    const original = live && ed ? ed.getText().slice(live.from, live.to) : c.quote;
    const proposed = replyBody.replace(/^\s*rewrite:\s*/i, "").trim();
    updateComment(id, { resolved: false, suggestion: { proposed, status: "open", original } });
  }, [updateComment]);
  // Reopening a REJECTED suggestion puts it back on the table; an accepted one stays accepted
  const toggleResolved = useCallback((id: string) => {
    const c = reviewRef.current.comments.find((x) => x.id === id); if (!c) return;
    const reopenRejected = c.resolved && c.suggestion?.status === "rejected";
    updateComment(id, { resolved: !c.resolved, ...(reopenRejected ? { suggestion: { ...c.suggestion!, status: "open" as const, decided: undefined } } : null) });
  }, [updateComment]);

  const onExternalPaper = useCallback((fresh: DraftDoc) => {
    const ed = manuscript.current;
    const diskText = fresh.paper.text, diskMtime = fresh.paper.mtime;
    const liveText = ed?.getText() ?? paperRef.current.text;
    // a save went out while this read was in the air: the read may predate it, and the
    // save's own answer is the truth — the next poll looks again
    if (paperRef.current.inFlight()) return;
    // an older stamp than the save the server last accepted is a stale read of text we
    // wrote ourselves: never roll the base back to it (the next save would 409)
    const stale = diskMtime < paperRef.current.mtime();
    if (liveText === diskText) { if (!stale) paperRef.current.applyExternal(diskText, diskMtime); return; }
    if (paperRef.current.wroteRecently(diskText)) {
      if (stale) return;
      // disk holds exactly what we last saved, re-stamped: take the stamp, write nothing
      // (the autosave carries any newer typing on its own)
      if (diskText === paperRef.current.savedText()) { paperRef.current.adoptMtime(diskMtime); return; }
      // disk went BACK to an older text of ours: ours is newer, re-stamp it over disk
      paperRef.current.takeMine(diskMtime); return;
    }
    if (!paperRef.current.dirty) {
      ed?.setContent(diskText);
      paperRef.current.applyExternal(diskText, diskMtime);
      const newList = fresh.comments?.comments ?? reviewRef.current.comments;
      reviewRef.current.applyExternal(newList, fresh.comments?.mtime ?? reviewRef.current.mtime(), fresh.comments?.version ?? "");
      setTimeout(() => setOrphans(pushRanges(newList, true)), 0);
      setDiverged({ kind: "applied", oldText: liveText, newText: diskText, diskMtime });
      setGeoTick((t) => t + 1);
    } else {
      setDiverged({ kind: "conflict", oldText: liveText, newText: diskText, diskMtime });
    }
  }, [pushRanges]);

  const [diskReady, setDiskReady] = useState(false);
  useEffect(() => {
    const tick = async () => {
      if (typeof document !== "undefined" && document.hidden) return;
      try {
        const st = await api.draftingDocStatus(slug, docName);
        if (!st.ok) return;
        if (!st.paperMtime || st.paperMtime === paperRef.current.mtime()) setDiskReady(true);
        if (st.resultsStamp !== undefined && st.resultsStamp !== resultsStampRef.current) {
          const first = resultsStampRef.current === "";
          resultsStampRef.current = st.resultsStamp;
          setAssetStamps(st.assets ?? {});
          if (!first || Date.now() - provAtRef.current > 10_000) refreshProv();
        }
        if (st.paperMtime && st.paperMtime !== paperRef.current.mtime() && !divergedRef.current && !paperRef.current.inFlight()) {
          const m0 = paperRef.current.mtime();
          const fresh = await api.draftingDoc(slug, docName);
          if (paperRef.current.inFlight() || paperRef.current.mtime() !== m0 || divergedRef.current) return;
          if (fresh && fresh.paper) {
            onExternalPaper(fresh);
            if (paperRef.current.mtime() === fresh.paper.mtime || (paperRef.current.text === fresh.paper.text)) setDiskReady(true);
          }
        } else if (st.commentsMtime && st.commentsMtime !== reviewRef.current.mtime() && !reviewRef.current.isDirty() && !reviewRef.current.inFlight()) {
          const cl = await api.draftingComments(slug, docName);
          if (cl.ok && cl.comments) { reviewRef.current.applyExternal(cl.comments, cl.mtime ?? 0, cl.version ?? ""); setTimeout(() => setOrphans(pushRanges(cl.comments!, true)), 0); }
        }
      } catch { /* transient poll error — try again next tick */ }
    };
    const iv = setInterval(tick, 4000);
    tick();   // at once: the cached-copy window is exactly the first seconds after an open
    window.addEventListener("focus", tick);
    return () => { clearInterval(iv); window.removeEventListener("focus", tick); };
  }, [slug, docName, onExternalPaper, pushRanges, refreshProv]);

  // reconcile-banner actions
  const takeTheirs = useCallback(() => {
    const d = divergedRef.current; if (!d) return;
    manuscript.current?.setContent(d.newText);
    paperRef.current.applyExternal(d.newText, d.diskMtime);
    api.draftingComments(slug, docName).then((cl) => { if (cl.ok && cl.comments) { reviewRef.current.applyExternal(cl.comments, cl.mtime ?? 0, cl.version ?? ""); setTimeout(() => setOrphans(pushRanges(cl.comments!, true)), 0); } }).catch(() => {});
    setDiverged(null); setGeoTick((t) => t + 1);
  }, [slug, docName, pushRanges]);
  const keepMine = useCallback(() => { const d = divergedRef.current; if (!d) return; paperRef.current.takeMine(d.diskMtime); setDiverged(null); }, []);
  const undoApplied = useCallback(() => {
    const d = divergedRef.current; if (!d || d.kind !== "applied") return;
    manuscript.current?.setContent(d.oldText);
    paperRef.current.setText(d.oldText);   // now dirty → autosave writes it back over the AI version
    setDiverged(null); setGeoTick((t) => t + 1);
  }, []);

  const flushForPublish = useCallback(async (): Promise<{ ok: boolean }> => {
    const okPaper = await paper.flush();
    await Promise.all([ann.flush(), review.flush()]);
    try {
      const st = await api.draftingDocStatus(slug, docName);
      if (st.ok && st.paperMtime && st.paperMtime !== paper.mtime()) {
        const fresh = await api.draftingDoc(slug, docName);
        if (fresh && fresh.paper) onExternalPaper(fresh);
        return { ok: false };
      }
    } catch { /* status probe failed — fall through and let the compile proceed */ }
    return { ok: okPaper };
  }, [paper, ann, review, slug, docName, onExternalPaper]);

  const commentAt = useMemo(() => {
    const text = paper.text || "";
    const at = new Map<string, number>();
    for (const c of review.comments) {
      const r = locate(text, c);
      at.set(c.id, r && r.to > r.from ? r.from : detachedPos(text, c) ?? -1);
    }
    return at;
  }, [review.comments, paper.text]);
  const commentAtRef = useRef(commentAt); commentAtRef.current = commentAt;
  const orderedComments = useMemo(
    () => [...review.comments].sort((a, b) => (commentAt.get(a.id)! - commentAt.get(b.id)!) || (a.created - b.created)),
    [review.comments, commentAt]);

  const railHeadings = useMemo(() => {
    const text = paper.text || "";
    const out: { key: string; title: string; at: number; end?: number }[] = [];
    let fence = false, pos = 0;
    for (const line of text.split("\n")) {
      if (/^\s*(```|~~~)/.test(line)) fence = !fence;
      else if (!fence) {
        const m = /^(#{2,3})\s+(.+?)\s*#*\s*$/.exec(line);
        if (m) out.push({ key: m[1].length + ":" + m[2], title: m[2].replace(/[*_`]/g, ""), at: pos, end: pos + line.length + 1 });
      }
      pos += line.length + 1;
    }
    return out;
  }, [paper.text]);
  const sectionOf = useCallback((id: string): { key: string; title: string; at: number; end?: number } => {
    const at = commentAt.get(id) ?? -1;
    if (at < 0) return { key: "~detached", title: "Detached", at };
    let lo = 0, hi = railHeadings.length - 1, hit = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (railHeadings[mid].at <= at) { hit = mid; lo = mid + 1; } else hi = mid - 1; }
    return hit < 0 ? { key: "~top", title: "Opening", at: 0 } : railHeadings[hit];
  }, [commentAt, railHeadings]);
  const secStoreKey = "all_in_one_academic:cmt-sections:" + slug + ":" + docName;
  const [foldedSecs, setFoldedSecs] = useState<Set<string>>(() => {
    try { const v = JSON.parse(localStorage.getItem(secStoreKey) || "[]"); return new Set(Array.isArray(v) ? v.map(String) : []); } catch { return new Set(); }
  });
  const setFolded = useCallback((next: Set<string>) => {
    setFoldedSecs(next);
    try { if (next.size) localStorage.setItem(secStoreKey, JSON.stringify([...next])); else localStorage.removeItem(secStoreKey); } catch { /* storage blocked */ }
  }, [secStoreKey]);
  const pinStoreKey = "all_in_one_academic:cmt-pins:" + slug + ":" + docName;
  const [pins, setPinsRaw] = useState<string[]>(() => {
    try { const v = JSON.parse(localStorage.getItem(pinStoreKey) || "[]"); return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
  });
  pinsRef.current = pins;
  const savePins = useCallback((next: string[]) => {
    pinsRef.current = next;
    setPinsRaw(next);
    try { if (next.length) localStorage.setItem(pinStoreKey, JSON.stringify(next)); else localStorage.removeItem(pinStoreKey); } catch { /* storage blocked */ }
  }, [pinStoreKey]);
  const togglePin = useCallback((id: string) => {
    const cur = pinsRef.current;
    if (cur.includes(id)) savePins(cur.filter((x) => x !== id));
    else savePins([...cur, id]);
  }, [savePins]);
  const pinnedCmts = useMemo(() => pins.map((id) => review.comments.find((c) => c.id === id)).filter((c): c is NonNullable<typeof c> => !!c), [pins, review.comments]);
  const [pinDockMin, setPinDockMin] = useState(false);
  const [pinOpen, setPinOpen] = useState<string[]>([]);
  const pinEls = useRef(new Map<string, HTMLDivElement | null>());
  const pinListRef = useRef<HTMLDivElement>(null);
  const pinDockOpen = pinOpen.some((id) => pins.includes(id));
  const [scrollH, setScrollH] = useState(0);
  useEffect(() => {
    const el = scrollRef.current; if (!el || !pinnedCmts.length) return;
    const ro = new ResizeObserver(() => setScrollH(el.clientHeight));
    ro.observe(el); setScrollH(el.clientHeight);
    return () => ro.disconnect();
  }, [pinnedCmts.length > 0]);   // eslint-disable-line react-hooks/exhaustive-deps
  const onPinOpen = useCallback((id: string, open: boolean) => {
    setPinOpen((cur) => open ? (cur.includes(id) ? cur : [...cur, id]) : cur.filter((x) => x !== id));
    // the card that just opened goes to the top of the dock, so its first line is where
    // the eye is; scrolls the dock's own list only, never the manuscript
    if (open) requestAnimationFrame(() => {
      const list = pinListRef.current, el = pinEls.current.get(id);
      if (list && el) list.scrollTop = el.offsetTop;   // the list is the card's offsetParent
    });
  }, []);
  // the rail header's expand-all / collapse-all for reply threads: every press bumps n
  const [threadsAll, setThreadsAll] = useState<{ open: boolean; n: number }>({ open: false, n: 0 });
  const [cmtSort, setCmtSortRaw] = useState<CmtSort>(() => {
    try { const v = localStorage.getItem(CMT_SORT_KEY); return (CMT_SORTS as readonly string[]).includes(v || "") ? v as CmtSort : "pos"; } catch { return "pos"; }
  });
  const setCmtSort = useCallback((v: CmtSort) => {
    setCmtSortRaw(v);
    if (isOutlineFilter(v)) return;   // a filter is never remembered: another doc must not open "empty"
    try { if (v === "pos") localStorage.removeItem(CMT_SORT_KEY); else localStorage.setItem(CMT_SORT_KEY, v); } catch { /* storage blocked */ }
  }, []);
  // the effective view: an outline view on a doc with no outline cards is plain document
  // order; the two outline FILTERS lay out like document order
  const hasOutline = review.comments.some((c) => (c as { outline?: boolean }).outline);
  const railSort: CmtSort = !hasOutline && cmtSort.startsWith("outline") ? "pos" : cmtSort;
  const listSorted = railSort !== "pos" && !isOutlineFilter(railSort);
  const cmtSortRef = useRef(listSorted); cmtSortRef.current = listSorted;
  // the rail's rendered order, for reposition's list layout (written on render)
  const railOrderRef = useRef<string[]>([]);
  // OUTLINE cards (section materials, one per sentence-outline stub) can be many: the rail
  // can show them only, hide them, or show everything. One predicate for every count.
  const railKeep = useCallback((c: { author?: string; resolved?: boolean; outline?: boolean }) =>
    (!findingsOnly || (c.author === "checker" && !c.resolved))
    && (railSort === "outline-only" ? !!c.outline : railSort === "outline-hide" ? !c.outline : true), [findingsOnly, railSort]);
  // what reposition needs to place the section headers: the heading offset and the cards
  // in each group. Written on render, read inside the imperative layout pass.
  const railSecsRef = useRef<{ key: string; at: number; end?: number; ids: string[] }[]>([]);

  const anchorStacks = useMemo(() => {
    const live = new Map((manuscript.current?.commentRanges() ?? []).map((r) => [r.id, r] as const));
    const out = new Map<string, { i: number; n: number }>();
    let run: string[] = [];
    const flush = () => { if (run.length > 1) run.forEach((id, k) => out.set(id, { i: k + 1, n: run.length })); run = []; };
    // counted over the list the rail RENDERS: under "Findings only" a counter that included
    // the hidden siblings would promise stops that ↓ cannot reach.
    for (const c of orderedComments.filter(railKeep)) {
      const r = live.get(c.id);
      const prev = run.length ? live.get(run[run.length - 1]) : undefined;
      if (r && prev && sameAnchor(prev, r)) run.push(c.id);
      else { flush(); if (r) run = [c.id]; }
    }
    flush();
    return out;
  }, [orderedComments, geoTick, railKeep]);

  const railCount = useMemo(
    () => orderedComments.filter(railKeep).length,
    [orderedComments, railKeep]);
  // a filter that emptied the rail still owns it: its control is the only way back
  const railEmpty = !marginOpen || (railCount === 0 && !findingsOnly && !isOutlineFilter(railSort));
  const wideDock = isWide && resultsOpen && (wideOverride === null ? railEmpty : wideOverride);
  const railFolded = wideDock && railEmpty;
  const reserveW = (marginOpen && !railFolded) || pinnedCmts.length > 0 ? RESERVE : 0;

  const [setRowEl, rowW] = useElementWidth();
  const paperW = Math.round((DRAFT_MEASURE[style] ?? 780) * zoom) + reserveW + 56;
  const rightDocksW = (isWide && resultsOpen ? (wideDock ? 380 + RESERVE : 380) : 0) + (isWide && docSwitchOpen ? 300 : 0) + (isWide && checklistOpen ? 320 : 0);
  const corpusW = !isWide ? CORPUS_W
    : Math.min(CORPUS_MAX, Math.max(CORPUS_W, rowW - rightDocksW - paperW - CORPUS_GAP));

  const findMode = (pageView && !readMode && !projectDoc) ? "page" : "cm";
  const find = useFind({
    enabled: true,
    targetKey: findMode,
    makeTarget: () => {
      if (findMode === "cm") { const v = manuscript.current?.getView(); return v ? cmFindTarget(v) : null; }
      return domFindTarget(() => rootRef.current?.querySelector("[data-page-view]") as HTMLElement | null, { clipToPageWindows: true });
    },
    rootRef,
    // in a side-by-side split both panes carry this listener: only the pane the press
    // came from, else the focused one, answers — the same rule the Escape chain uses
    owns: (e) => {
      if (!paneRef.current) return true;
      const from = (e.target as HTMLElement | null)?.closest?.("[data-drafting-pane]");
      return from ? from === rootRef.current : !!paneRef.current.focused;
    },
    docVersion: paper.text,
  });

  // append a reply to one comment's thread
  const replyToComment = useCallback((id: string, body: string) => {
    const cur = reviewRef.current.comments;
    reviewRef.current.setComments(cur.map((c) => c.id === id
      ? { ...c, replies: [...(c.replies || []), { id: "r" + Date.now().toString(36), author: "owner" as const, body, created: Date.now() }], updated: Date.now() }
      : c));
  }, []);

  const reposition = useCallback(() => {
    if (!marginOpen) return;
    const ed = manuscript.current;
    const items: { key: string; top: number; at: number; head?: boolean }[] = [];
    const live = new Map((ed?.commentRanges() ?? []).map((r) => [r.id, r] as const));
    let orphanAt = -1e6;
    // a sorted rail (anything but document order) is a LIST from the rail's top, in the
    // rendered order; a solo card still sits beside its own text
    const listOrder = cmtSortRef.current && !soloComment
      ? new Map(railOrderRef.current.map((id, i) => [id, i] as const)) : null;
    for (const c of reviewRef.current.comments) {
      const r = live.get(c.id);
      if (listOrder) items.push({ key: "cmt:" + c.id, top: 0, at: listOrder.get(c.id) ?? Number.MAX_SAFE_INTEGER });
      else if (r) items.push({ key: "cmt:" + c.id, top: ed?.posTop(r.from) ?? 0, at: r.from });
      else {
        const p = commentAtRef.current.get(c.id) ?? -1;
        if (p >= 0) items.push({ key: "cmt:" + c.id, top: ed?.posTop(p) ?? 0, at: p });
        else items.push({ key: "cmt:" + c.id, top: 0, at: orphanAt++ });   // ++ keeps them stably ordered among themselves
      }
    }
    const byKey = new Map(items.map((it) => [it.key, it] as const));
    for (const s of railSecsRef.current) {
      const cards = s.ids.map((id) => byKey.get("cmt:" + id)).filter(Boolean) as typeof items;
      const minTop = Math.min(...cards.map((c) => c.top), Number.MAX_SAFE_INTEGER);
      const minAt = Math.min(...cards.map((c) => c.at), Number.MAX_SAFE_INTEGER);
      const headH = cardEls.current.get("sec:" + s.key)?.offsetHeight ?? 18;
      const headTop = s.key.startsWith("~") ? minTop
        : Math.max(ed?.posTop(s.at) ?? 0, (ed?.posTop(s.end ?? s.at) ?? 0) - headH - 4);   // posTop clamps to the doc
      items.push({ key: "sec:" + s.key, top: Math.min(headTop, minTop), at: Math.min(s.at, minAt) - 0.5, head: true });
    }
    items.sort((a, b) => (a.top - b.top) || (a.at - b.at) || (Number(!!b.head) - Number(!!a.head)));
    let prevBottom = -1e9, maxBottom = 0, firstTop: number | null = null;
    for (const it of items) {
      const el = cardEls.current.get(it.key);
      if (!el || el.hidden) continue;
      const top = Math.max(it.top, prevBottom + 8);
      el.style.top = top + "px";
      if (firstTop === null) firstTop = top;
      const full = el.offsetHeight;
      let foot = full;
      if (el.dataset.cmtExpanded === "1") {
        const f = Number(el.dataset.cmtFoot);
        foot = f > 0 ? Math.min(f, full) : Math.min(full, 96);
      } else if (el.hasAttribute("data-cmt-card")) el.dataset.cmtFoot = String(full);
      prevBottom = top + foot; maxBottom = Math.max(maxBottom, top + full);
    }
    const pill = soloPillRef.current;
    if (pill) {
      const above = Math.max(0, (firstTop ?? 0) - pill.offsetHeight - 6);
      const soloEl = soloComment ? cardEls.current.get("cmt:" + soloComment) : null;
      const sc = scrollRef.current, wrap = pill.offsetParent as HTMLElement | null;
      let top = above;
      if (soloEl && sc && wrap && firstTop !== null) {
        const aboveY = wrap.getBoundingClientRect().top + above;
        if (aboveY < sc.getBoundingClientRect().top) top = firstTop + soloEl.offsetHeight + 6;
      }
      pill.style.top = top + "px";
    }
    if (wrapRef.current) wrapRef.current.style.minHeight = (Math.max(ed?.contentHeight() ?? 0, maxBottom) + 60) + "px";
  }, [marginOpen, soloComment, foldedSecs, listSorted]);
  useLayoutEffect(reposition, [reposition, geoTick]);
  const focusCardId = useRef<string | null>(null);
  const focusCard = useCallback((id: string) => { focusCardId.current = id; }, []);
  useLayoutEffect(() => {
    const id = focusCardId.current; if (!id) return;
    focusCardId.current = null;
    const el = cardEls.current.get("cmt:" + id);
    if (el && !el.hidden) el.focus({ preventScroll: true });
  });
  const repositionRef = useRef(reposition);
  useEffect(() => { repositionRef.current = reposition; }, [reposition]);
  useEffect(() => {
    const sc = scrollRef.current; if (!sc) return;
    let raf = 0;
    const onScroll = () => { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; manuscript.current?.requestMeasure(); repositionRef.current(); }); };
    sc.addEventListener("scroll", onScroll, { passive: true });
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      zoomByRef.current(-Math.sign(e.deltaY) * 0.1);   // anchors the viewport before rezooming
    };
    sc.addEventListener("wheel", onWheel, { passive: false });
    const onResize = () => setGeoTick((t) => t + 1); window.addEventListener("resize", onResize);
    return () => { sc.removeEventListener("scroll", onScroll); sc.removeEventListener("wheel", onWheel); window.removeEventListener("resize", onResize); if (raf) cancelAnimationFrame(raf); };
  }, []);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const inLayerChain = Date.now() - layerEscChain.current < ESC_CHAIN_MS;
      if (inLayerChain) layerEscChain.current = Date.now();
      if (e.defaultPrevented) return;
      if (paneRef.current) {
        const from = (e.target as HTMLElement | null)?.closest?.("[data-drafting-pane]");
        if (from ? from !== rootRef.current : !paneRef.current.focused) return;
      }
      if (reviewMenuOpen && !typingEscape(e)) { e.preventDefault(); closeReviewMenu(); return; }
      if (focusOpen || rewriteOpen || litOpen) { if (typingEscape(e)) return; e.preventDefault(); exitReview(); return; }
      const inManuscript = !!(e.target as HTMLElement | null)?.closest?.(".cm-content");
      if (soloCommentRef.current && (inManuscript || !typingEscape(e))) { e.preventDefault(); setSoloComment(null); return; }
      if (typingEscape(e)) return;
      if (readMode) { e.preventDefault(); exitRead(); return; }   // Esc leaves read mode before the editor
      if (docOpen || viewOpen || pageOpen) { e.preventDefault(); setDocOpen(false); setViewOpen(false); setPageOpen(false); return; }
      if (pageView) { e.preventDefault(); setPageView(false); return; }   // Esc leaves page view before the editor
      if (source === null && !refOpen && !outlineOpen && !docSwitchOpen && !styleOpen && !publishOpen && mentionLiveRef.current === null) {
        e.preventDefault();
        if (inLayerChain) return;   // still the run of Escs that closed Focus/Rewrite
        onExit();
      }
    };
    window.addEventListener("keydown", h);
    const prev = document.body.style.overflow; document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", h); document.body.style.overflow = prev; };
  }, [onExit, source, refOpen, outlineOpen, docSwitchOpen, styleOpen, publishOpen, readMode, exitRead, docOpen, viewOpen, pageOpen, pageView, focusOpen, rewriteOpen, litOpen, reviewMenuOpen]);

  const setItem = useCallback((idx: number, mut: (p: EPara) => EPara) => {
    if (idx < 0) return;
    const items: EItem[] = edModel.items.map((it, i) => (i === idx && it.kind === "para" ? mut(it) : it));
    ann.setText(serializeEditor(edModel.preamble, items));
  }, [edModel, ann]);
  const onPoint = (idx: number, v: string) => setItem(idx, (p) => ({ ...p, point: v }));   // the outline paragraph point — independent of the margin comment
  
  const syncOutline = useCallback(async (rebaseTo?: number) => {
    setSyncing(true);
    try {
      await ann.flush();                                  // never clobber an in-flight card edit
      const r = await api.draftingSyncEditor(slug, rebaseTo ?? ann.mtime(), docName);
      if (r.conflict) {
        const at = r.currentMtime;
        toast("The planning changed on disk", { description: "Sync again to overwrite from the manuscript.", action: { label: "Overwrite", onClick: () => syncOutline(at) } });
      } else if (r.ok && r.editor) { ann.applyExternal(r.editor.text, r.editor.mtime); toast.success("Planning synced from the manuscript"); }
    } catch { toast.error("Couldn't sync the planning"); }
    finally { setSyncing(false); }
  }, [slug, ann]);

  useEffect(() => {
    if (!mention) { setMentionHits([]); setMentionLoading(false); return; }
    const q = mention.query.trim();
    if (!q) { setMentionHits([]); setMentionLoading(false); return; }
    let live = true;
    const cited = new Set(Object.keys(citeMapRef.current).map((k) => k.split("|").slice(0, 2).join("|")));   // "surname|year", already resolved
    if (citeIndexState() === "ready") {
      const hits = searchCiteIndex(q, { cited, limit: 30 });
      setMentionHits(hits); setMentionSel(0); setMentionLoading(false);
      if (hits.length) return;
      // nothing locally: the query may only match a body. One request, debounced,
      // so a writer typing through a dead patch does not fire a burst of them.
      setMentionLoading(true);
      const id = setTimeout(() => {
        searchRemote(slug, q, docName)
          .then((h) => { if (live) { setMentionHits(h.slice(0, 30)); setMentionSel(0); } })
          .finally(() => { if (live) setMentionLoading(false); });
      }, 220);
      return () => { live = false; clearTimeout(id); };
    }
    // the index has not arrived yet (a cold window, or it failed): fall back to the
    // old path so the picker still works rather than showing an empty list
    setMentionLoading(true);
    const id = setTimeout(() => {
      searchRemote(slug, q, docName)
        .then((h) => { if (live) { setMentionHits(h.slice(0, 30)); setMentionSel(0); } })
        .finally(() => { if (live) setMentionLoading(false); });
    }, 160);
    return () => { live = false; clearTimeout(id); };
  }, [mention?.query, slug, docName, citeIdxState]);   // eslint-disable-line react-hooks/exhaustive-deps

  const replaceMention = useCallback((from: number, insert: string) => {
    if (!mention) return;
    citeEd()?.replaceRange(from, mention.to, insert);
    setMention(null);
    setTimeout(() => { paper.flush().then(refreshCiteMap).catch(() => {}); }, 120);
  }, [mention, paper, refreshCiteMap]);

  // one "Author Year" token for a hit; the paren group is alphabetised by author (ASA order)
  const citeToken = (h: CiteHit) => `${authorOf(h)}${yearOf(h) ? " " + yearOf(h) : ""}`.trim();

  const insertParenGroup = useCallback((hits: CiteHit[]) => {
    if (!mention || !hits.length) return;
    let from = mention.from, tokens = hits.map(citeToken);
    const before = (citeEd()?.getText() ?? "").slice(0, mention.from);
    const m = /\(([^()]*\b(?:1[6-9]\d\d|20\d\d)[a-z]?)\)\s*$/.exec(before);
    if (m) { from = m.index; tokens = [...m[1].split(";").map((s) => s.trim()).filter(Boolean), ...tokens]; }
    setPendingCites([]);
    replaceMention(from, `(${sortCiteTokens(tokens).join("; ")})`);
  }, [mention, replaceMention]);

  const insertCite = useCallback((h: CiteHit) => {
    if (!mention) return;
    if (citeMode === "paren") { insertParenGroup([...pendingCites, h]); return; }
    replaceMention(mention.from, citeText(h, citeMode));
  }, [mention, citeMode, pendingCites, insertParenGroup, replaceMention]);

  // Tab in paren mode: add the highlighted hit to the pending group and wipe the typed
  // query (keeping the "@") so the popup stays open and the next author can be searched.
  const addToGroup = useCallback((h: CiteHit) => {
    if (!mention) return;
    setPendingCites((p) => [...p, h]);
    citeEd()?.replaceRange(mention.from + 1, mention.to, "");
  }, [mention]);

  // commit a pending group with no trailing pick (Enter/Esc after the last Tab)
  const commitGroup = useCallback(() => {
    if (!mention || !pendingCites.length) return false;
    insertParenGroup(pendingCites);
    return true;
  }, [mention, pendingCites, insertParenGroup]);

  const quoteGateOk = useCallback(async (h: CiteHit, q: CiteQuote): Promise<boolean> => {
    const line = `> "${q.text}"${q.page ? ` (p. ${q.page})` : ""} — ${cite(h)}  [[${h.rel}]]`;
    try {
      const v = await api.draftingVerifyLine(line);
      if (!v.ok) { toast.error("Not inserted — " + (v.reason || "quote failed live-note verification")); return false; }
    } catch { /* gate unreachable — fail open, same as the server contract */ }
    return true;
  }, []);
  const insertQuote = useCallback(async (h: CiteHit, qIdx: number) => {
    const q = h.quotes[qIdx];
    if (!q) { insertCite(h); return; }
    const from = mention?.from ?? 0;
    if (!(await quoteGateOk(h, q))) return;
    replaceMention(from, asaQuote(h, q));
  }, [mention, insertCite, replaceMention, quoteGateOk]);

  const insertAtCaret = useCallback((text: string): boolean => {
    const ed = manuscript.current;
    const back = document.activeElement as HTMLElement | null;
    if (!ed || readMode) { copyToClipboard(text, "Copied " + text); return false; }
    const guard = (ev: Event) => {
      const t = ev.target as HTMLElement | null;
      if (!back || !back.isConnected) return;
      if (t && typeof t.closest === "function" && t.closest(".cm-content")) { try { back.focus(); } catch { /* gone */ } }
    };
    document.addEventListener("focusin", guard, true);
    window.setTimeout(() => document.removeEventListener("focusin", guard, true), 500);
    const pos = ed.cursorPos();
    ed.replaceRange(pos, pos, text);
    try { if (back && back.isConnected) back.focus(); } catch { /* gone from the DOM */ }
    setTimeout(() => { paper.flush().then(refreshCiteMap).catch(() => {}); }, 120);
    return true;
  }, [readMode, paper, refreshCiteMap]);
  const corpusActions = useMemo(() => ({
    insert: insertAtCaret,
    insertQuote: (h: CiteHit, q: CiteQuote) => { void quoteGateOk(h, q).then((ok) => { if (ok) insertAtCaret(asaQuote(h, q)); }); },
    openPdf: (rel: string, page: string) => setPdfView({ rel, page }),
  }), [insertAtCaret, quoteGateOk]);
  const corpusPanel = <CorpusPanel slug={slug} docName={docName} width={corpusW} actions={corpusActions} side={corpusSide} onSide={setCorpusSide}
    onViewSource={(rel) => setSource({ rel, quote: "" })} onClose={() => setCorpusOpen(false)} />;

  const pickHit = useCallback((h: CiteHit) => {
    if (citeMode === "quote" && nQuotesOf(h) > 0) {
      if (h.quotes.length) { setDrillHit(h); setMentionLevel(1); setQuoteSel(0); return; }
      setMentionLevel(1); setQuoteSel(0); setDrillHit({ ...h, quotes: [] });
      citeDetailCached(h.rel).then((d) => {
        setDrillHit((cur) => (cur && cur.rel === h.rel
          ? { ...cur, quotes: d.quotes || [], keyPoints: d.keyPoints || [], citation: d.citation || "" }
          : cur));
      });
      return;
    }
    if (citeMode === "paren") addToGroup(h);
    else insertCite(h);
  }, [citeMode, insertCite, addToGroup]);

  // ←/→ flick between the three styles; drop any open quote drill-down
  const cycleMode = useCallback((dir: 1 | -1) => {
    setCiteMode((m) => CITE_MODES[(CITE_MODES.indexOf(m) + dir + CITE_MODES.length) % CITE_MODES.length]);
  }, [setCiteMode]);

  // reset the drill-down whenever the query or the mode changes (or the popup closes)
  useEffect(() => { setMentionLevel(0); setDrillHit(null); setQuoteSel(0); }, [mention?.query, citeMode, mention]);
  // the pending group belongs to ONE @-session — clear it when the popup closes
  useEffect(() => { if (!mention) setPendingCites((p) => (p.length ? [] : p)); }, [mention]);
  // a group only makes sense as a parenthetical; dropping out of paren mode commits it
  useEffect(() => { if (citeMode !== "paren" && pendingCites.length) commitGroup(); }, [citeMode]);   // eslint-disable-line react-hooks/exhaustive-deps

  const onMentionKey = useCallback((k: MentionKey): boolean => {
    if (!mention) return false;
    if (k === "escape") { if (commitGroup()) return true; setMention(null); return true; }
    // quote drill-down: ↑/↓ browse quotes, ↵/Tab insert, ← step back, → consumed
    if (mentionLevel === 1 && drillHit) {
      if (k === "left") { setMentionLevel(0); setDrillHit(null); return true; }
      if (k === "right") return true;
      const qs = drillHit.quotes;
      if (!qs.length) { if (k === "enter" || k === "tab") insertQuote(drillHit, 0); return true; }
      if (k === "down") { setQuoteSel((s) => Math.min(s + 1, qs.length - 1)); return true; }
      if (k === "up") { setQuoteSel((s) => Math.max(0, s - 1)); return true; }
      if (k === "enter" || k === "tab") { insertQuote(drillHit, quoteSel); return true; }
      return true;
    }
    // candidate list — while a group is building, lock to paren (←/→ don't flick away)
    if (k === "left") { if (!pendingCites.length) cycleMode(-1); return true; }
    if (k === "right") { if (!pendingCites.length) cycleMode(1); return true; }
    if (k === "down") { if (!mentionHits.length) return false; setMentionSel((s) => Math.min(s + 1, mentionHits.length - 1)); return true; }
    if (k === "up") { if (!mentionHits.length) return false; setMentionSel((s) => Math.max(0, s - 1)); return true; }
    // Tab: in paren mode, add the highlighted hit to the group and keep searching; in the
    // other modes it just inserts (no group), and an empty Tab is swallowed while open.
    if (k === "tab") {
      if (!mentionHits.length) return true;
      if (citeMode === "paren") { addToGroup(mentionHits[mentionSel]); return true; }
      pickHit(mentionHits[mentionSel]); return true;
    }
    if (k === "enter") {
      if (mentionHits.length) { pickHit(mentionHits[mentionSel]); return true; }
      if (commitGroup()) return true;          // empty query, but a pending group is waiting
      return false;                            // truly nothing -> let Enter make a newline
    }
    return false;
  }, [mention, mentionLevel, drillHit, quoteSel, mentionHits, mentionSel, citeMode, pendingCites, insertQuote, pickHit, cycleMode, addToGroup, commitGroup]);
  const onMention = useCallback((m: MentionInfo | null) => {
    setMention((prev) => (prev && m && prev.from === m.from && prev.to === m.to && prev.query === m.query && prev.left === m.left && prev.top === m.top ? prev : m));
  }, []);
  const renderReviewCard = (c: DraftComment, o: { onEscapeToText: () => void; onLocate: () => void; escapeTo: () => void }) => (
    <AnchoredCommentCard comment={c} active={c.id === activeComment} orphaned={orphans.includes(c.id)} staticLayout fullyExpanded
      registerRef={() => {}}
      threadsAll={threadsAll}
      pinned={pins.includes(c.id)} onPin={() => togglePin(c.id)}
      stack={anchorStacks.get(c.id)}
      onActivate={() => setActiveComment(c.id)}
      onLocate={o.onLocate}
      onBody={(v) => updateComment(c.id, { body: v })}
      onResolve={() => toggleResolved(c.id)}
      onDelete={() => deleteComment(c.id)} onReattach={focusOpen ? undefined : () => reattachComment(c.id)}
      onReply={(v) => replyToComment(c.id, v)}
      onAccept={() => acceptSuggestion(c.id)} onReject={() => rejectSuggestion(c.id)} sugBase={suggestionBase(c)} acceptError={acceptErrs[c.id]}
      onProposed={(v) => setProposed(c.id, v)} onUseRewrite={(b) => rewriteToSuggestion(c.id, b)}
      replyTick={replyReq.id === c.id ? replyReq.n : 0}
      onEscapeToText={o.onEscapeToText} escapeTo={o.escapeTo}
      onLayoutChange={() => {}} />
  );
  const onMainMention = useCallback((m: MentionInfo | null) => { if (!citeTarget.current) onMention(m); }, [onMention]);

  useEffect(() => {
    if (paper.conflict && !paper.dirty) {
      const t = paper.reloadFromDisk();
      if (t != null) manuscript.current?.setContent(t);
    }
  }, [paper, paper.conflict, paper.dirty]);
  useEffect(() => {
    if (ann.conflict && !ann.dirty) ann.reloadFromDisk();
  }, [ann, ann.conflict, ann.dirty]);

  const vaultRoot = useVaultRoot();
  const copyPaperPath = useCallback(async () => {
    if (!vaultRoot) { toast.error("Couldn't resolve the vault path"); return; }
    const sys = vaultRoot + "/" + doc.paper.rel;
    (await copyPlain(sys)) ? toast.success("Paper path copied") : toast.error("Couldn't copy the path");
  }, [vaultRoot, doc.paper.rel]);

  const [bannerH, setBannerH] = useState(0);
  useLayoutEffect(() => {
    if (!diverged || !(focusOpen || rewriteOpen || litOpen)) { setBannerH(0); return; }
    const el = rootRef.current?.querySelector<HTMLElement>("[data-diverge-banner]");
    if (!el) return;
    const ro = new ResizeObserver(() => setBannerH(el.offsetHeight));
    ro.observe(el); setBannerH(el.offsetHeight);
    return () => ro.disconnect();
  }, [diverged, focusOpen, rewriteOpen, litOpen]);
  const [hdrRef, hdrW] = useElementWidth();
  const tier: "full" | "compact" | "tight" = hdrW >= HDR_COMPACT_W ? "full" : hdrW >= HDR_TIGHT_W ? "compact" : "tight";
  const slim = tier !== "full";
  const pill = (extra: string) =>
    `inline-flex shrink-0 items-center ${slim ? "gap-1 px-2" : "gap-1.5 px-2.5"} py-1 rounded-full border text-[12px] transition-colors ${extra}`;
  // Focus and Rewrite open on the paragraph at the top of the view
  const viewTopPos = () => { const sc = scrollRef.current; return (sc && manuscript.current?.posAtViewportY(sc.getBoundingClientRect().top + 60)) ?? manuscript.current?.cursorPos() ?? 0; };
  const openFocus = () => { focusStartRef.current = viewTopPos(); setRewriteOpen(false); setLitOpen(false); setFocusOpen(true); };
  const openRewrite = () => { focusStartRef.current = viewTopPos(); if (focusOpen) closeFocus(); setLitOpen(false); setRewriteOpen(true); };
  const openLiterature = () => { if (focusOpen) closeFocus(); setRewriteOpen(false); setLitOpen(true); };
  const exitReview = (pos = Number(rootRef.current?.querySelector<HTMLElement>("[data-review-pos]")?.dataset.reviewPos ?? manuscript.current?.cursorPos() ?? 0)) => {
    layerEscChain.current = Date.now();
    closeFocus(); setRewriteOpen(false); setLitOpen(false); setReviewMenuOpen(false);
    requestAnimationFrame(() => { manuscript.current?.caretTo(pos); scrollToParaPos(pos); });
  };
  // Closing an existing menu returns to the layer or door. Opening a mode bypasses
  // this restore so its paragraph editor takes the keys after the menu unmounts.
  const closeReviewMenu = () => {
    const a = document.activeElement;
    if (!a || a === document.body || a === rootRef.current || reviewMenuRef.current?.contains(a)) {
      const layer = rootRef.current?.querySelector<HTMLElement>("[data-focus-mode],[data-rewrite-mode],[data-literature-mode]");
      (layer ?? reviewBtnRef.current)?.focus({ preventScroll: true });
    }
    setReviewMenuOpen(false);
  };
  const toggleReview = () => { if (reviewMenuOpen) closeReviewMenu(); else { setReviewMenuOpen(true); setDocOpen(false); setViewOpen(false); } };
  // opened from the keys, the menu takes them (its first item)
  useEffect(() => {
    if (!reviewMenuOpen) return;
    const frame = requestAnimationFrame(() => reviewMenuRef.current?.querySelector<HTMLElement>("button:not([disabled])")?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [reviewMenuOpen]);

  const pinRaised = (pageView && !readMode) || focusOpen || rewriteOpen || litOpen;
  const pinDock = (
    <div data-cmt-pin-dock aria-label="Pinned comments"
      className="absolute bottom-3 right-6 flex flex-col rounded-lg border border-primary/40 bg-background/95 shadow-lg backdrop-blur-sm"
      style={{ width: CARD_W + 14, ...(pinDockOpen && !pinDockMin && scrollH ? { height: scrollH - 24 } : { maxHeight: "55vh" }) }}>
      <div className="flex shrink-0 items-center gap-1 px-2 py-1 text-[10.5px] text-muted-foreground">
        <button type="button" data-cmt-pin-dock-toggle aria-expanded={!pinDockMin} onClick={() => setPinDockMin((m) => !m)}
          title={pinDockMin ? "Show pinned comments" : "Fold pinned comments"}
          className="inline-flex min-w-0 flex-1 items-center gap-1 rounded px-0.5 text-left hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50">
          {pinDockMin ? <ChevronRight size={11} className="shrink-0" /> : <ChevronDown size={11} className="shrink-0" />}
          <Pin size={11} className="shrink-0 text-primary" /><span className="nums">Pinned ({pinnedCmts.length})</span></button>
        <button type="button" onClick={() => savePins([])}
          title="Unpin all" className="inline-flex h-5 w-5 items-center justify-center rounded hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50"><PinOff size={11} /></button>
      </div>
      {!pinDockMin && (
        <div ref={pinListRef} className="relative min-h-0 flex-1 space-y-1.5 overflow-y-auto px-1.5 pb-1.5">
          {pinnedCmts.map((c) => (
            <AnchoredCommentCard key={"pin:" + c.id} comment={c} active={c.id === activeComment} orphaned={orphans.includes(c.id)} staticLayout
              pinned onPin={() => togglePin(c.id)}
              onOpenChange={(open) => onPinOpen(c.id, open)}
              registerRef={(el) => pinEls.current.set(c.id, el)}
              onActivate={() => setActiveComment(c.id)}
              onLocate={() => {
                setMarginOpen(true);
                setActiveComment(c.id);
                setSoloComment(c.id);
                const r = manuscript.current?.commentRanges().find((x) => x.id === c.id);
                if (r) scrollToParaPos(r.from, { eased: true, nearest: true });
              }}
              onBody={(v) => updateComment(c.id, { body: v })}
              onResolve={() => toggleResolved(c.id)}
              onDelete={() => deleteComment(c.id)} onReattach={() => reattachComment(c.id)}
              onReply={(v) => replyToComment(c.id, v)}
              onAccept={() => acceptSuggestion(c.id)} onReject={() => rejectSuggestion(c.id)} sugBase={suggestionBase(c)} acceptError={acceptErrs[c.id]}
              onProposed={(v) => setProposed(c.id, v)} onUseRewrite={(b) => rewriteToSuggestion(c.id, b)}
              onEscapeToText={() => manuscript.current?.focus()}
              onLayoutChange={noop} />
          ))}
        </div>
      )}
    </div>
  );

  return createPortal(
    <div ref={rootRef} tabIndex={-1} data-drafting-pane={pane ? pane.side : "full"}
      onMouseDownCapture={pane?.onFocusPane} onFocusCapture={pane?.onFocusPane}
      className={`fixed z-[100] bg-background flex flex-col animate-in fade-in duration-150 outline-none ${pane ? "top-0 bottom-0 border-border" + (pane.side === "right" ? " border-l" : " border-r") : "inset-0"}`}
      style={pane
        ? { ["--card-w" as string]: CARD_W + "px", left: pane.leftPct + "%", right: pane.rightPct + "%" }
        : { ["--card-w" as string]: CARD_W + "px" }}>
      {readMode ? (
        <div ref={hdrRef} data-hdr-tier={tier} className={`shrink-0 flex flex-nowrap items-center ${slim ? "gap-1" : "gap-1.5"} px-4 py-2 border-b border-border/60 bg-background/85 backdrop-blur-sm`}>
          <button type="button" onClick={exitRead} data-knav-back="2" title="Back to editing (Esc)" aria-label="Edit" className={pill("border-border text-muted-foreground hover:text-foreground hover:border-primary/50")}><SquarePen size={13} />{tier !== "tight" && <span>Edit</span>}</button>
          <div className="h-4 w-px bg-border mx-1 shrink-0" />
          <span className="text-[13.5px] font-medium truncate min-w-0 max-w-[30%]" style={{ fontFamily: SERIF }}>{liveTitle}</span>
          {!slim && <span className="text-[11px] text-muted-foreground/70 shrink-0 hidden sm:inline">Read mode</span>}
          <span className="flex-1" />
          {tier !== "tight" && <StatusTag status={paper.status === "saving" || ann.status === "saving" ? "saving" : (paper.dirty || ann.dirty) ? "idle" : "saved"} dirty={paper.dirty || ann.dirty} />}
          <button onClick={() => setMarginOpen((o) => !o)} title={marginOpen ? "Hide comments" : "Show comments"} aria-label="Comments" className={pill(marginOpen ? "border-primary/50 text-foreground" : "border-border text-muted-foreground hover:text-foreground hover:border-primary/50")}>{marginOpen ? <MessageSquareText size={13} /> : <MessageSquare size={13} />}{!slim && <span>Comments</span>}</button>
          <div className="inline-flex shrink-0 items-center gap-0.5 rounded-full border border-border px-1 py-0.5 text-muted-foreground">
            <button onClick={() => zoomBy(-0.1)} disabled={zoom <= 0.7} title="Zoom out" className="inline-flex items-center justify-center w-6 h-6 rounded-full hover:text-foreground hover:bg-accent disabled:opacity-40"><Minus size={13} /></button>
            <button onClick={zoomReset} title="Reset zoom to 100%" className="min-w-[44px] text-center text-[11.5px] nums hover:text-foreground">{Math.round(zoom * 100)}%</button>
            <button onClick={() => zoomBy(0.1)} disabled={zoom >= 1.8} title="Zoom in" className="inline-flex items-center justify-center w-6 h-6 rounded-full hover:text-foreground hover:bg-accent disabled:opacity-40"><Plus size={13} /></button>
          </div>
        </div>
      ) : (
      // its own tier above the Review row (z-70), so the header's menus still drop over it
      <div ref={hdrRef} data-hdr-tier={tier} className={`relative z-[80] shrink-0 flex flex-nowrap items-center ${slim ? "gap-1" : "gap-1.5"} px-4 py-2 border-b border-border bg-background`}>
        {onClosePane
          ? <button type="button" onClick={onClosePane} data-knav-back title="Close this pane (Esc) — the other document stays open" aria-label="Close pane" className="inline-flex shrink-0 items-center gap-1 text-[12.5px] text-muted-foreground hover:text-foreground"><X size={15} />{tier !== "tight" && <span>Close</span>}</button>
          : <button type="button" onClick={onExit} data-knav-back title="Back to Drafting" aria-label="Drafting" className="inline-flex shrink-0 items-center gap-1 text-[12.5px] text-muted-foreground hover:text-foreground"><ChevronLeft size={15} />{tier !== "tight" && <span>Drafting</span>}</button>}
        <div className="h-4 w-px bg-border mx-1 shrink-0" />
        <button onClick={copyPaperPath} onDoubleClick={() => api.open(doc.paper.rel)}
          title={(projectDoc ? "Click: copy the system path to this document" : "Click: copy the system path to " + docName + "") + ". Double-click: open the original markdown file in Obsidian"}
          className={`text-[14px] font-medium truncate text-left hover:text-primary transition-colors cursor-pointer ${slim ? "min-w-0 max-w-[200px]" : "min-w-[72px] max-w-[240px]"}`} style={{ fontFamily: SERIF }}>{liveTitle}</button>
        {projectDoc ? (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground shrink-0" title="Project document — edited and commented here, never published">
            <KindIcon kind={doc.kind} />
            <span className="font-medium text-foreground/80">{doc.label}</span>
            {!slim && <><span className="text-muted-foreground/40">·</span><span>project doc</span></>}
          </span>
        ) : (
        <div className="relative shrink-0">
          <button onClick={() => setStyleOpen((o) => !o)} title={"Document type and render style — matches how the publish step will typeset it (" + formatLabel(publish) + ")"}
            className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] transition-colors ${styleOpen ? "border-primary/50 text-foreground" : "border-border text-muted-foreground hover:text-foreground hover:border-primary/50"}`}>
            <KindIcon kind={doc.kind} />
            <span className="font-medium text-foreground/80">{doc.label}</span>
            {!slim && <><span className="text-muted-foreground/40">·</span><span>{formatLabel(publish)}</span></>}
          </button>
          {styleOpen && (
            <div className="absolute left-0 top-8 z-30 w-[256px] max-h-[60vh] overflow-y-auto rounded-lg border border-border bg-card shadow-xl py-1.5">
              <p className="px-3 pb-1 pt-0.5 text-[10px] uppercase tracking-wide text-muted-foreground/70" title={"Writes a publish: key in the frontmatter · default for a " + doc.label.toLowerCase() + " is " + formatLabel(kindDefault)}>Publish format · render style</p>
              {PUBLISH_FORMATS.map((f) => (
                <button key={f.id} onClick={() => setPublish(f.id)}
                  className="flex items-center gap-2 w-full text-left px-3 py-1 text-[12.5px] text-muted-foreground hover:text-foreground hover:bg-accent">
                  <span className="w-3.5 shrink-0">{publish === f.id ? <Check size={13} className="text-primary" /> : null}</span>
                  <span className="flex-1">{f.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        )}
        {!slim && <span className="text-[11.5px] text-muted-foreground nums whitespace-nowrap shrink-0" title={pageEst ? `${pageEst.approx ? "About " : ""}${pageEst.pages} pages in the ${pageProfile === "docx" ? "Word" : "PDF"} layout (${spacing}-spaced, print-geometry measurement${pageEst.approx ? "; the LaTeX estimate and figures/transclusions add tolerance" : ""}). Switch the layout profile in the eye menu's Page view.` : undefined}>
          {selWords > 0 && <span className="text-primary" title="Words in the selected passage">{selWords.toLocaleString()} of </span>}{countWords(paper.text).toLocaleString()} words
          {pageEst && <><span className="mx-1.5 text-muted-foreground/35">·</span>{pageEst.approx ? "≈" : ""}{pageEst.pages} pages</>}</span>}
        {slug && <button type="button" data-open-published aria-label="Open published files" title="Open published files"
          onClick={() => { openDir("writing", slug).then((r) => { if (!r?.ok) toast.error(r?.error || "The folder did not open"); }); }}
          className="ml-1 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground/70 hover:text-foreground hover:bg-accent transition-colors">
          <FolderOpen size={13} /></button>}
        <span className="flex-1" />
        {/* the alert appears ONLY for a true conflict (disk changed under unsaved
            edits) — a clean disk change auto-reloads silently (effect above) */}
        {paper.conflict && paper.dirty && <IconBtn onClick={() => { const t = paper.reloadFromDisk(); if (t != null) manuscript.current?.setContent(t); }} title="The paper changed on disk while you have unsaved edits — click to take the disk version"><AlertTriangle size={14} className="text-destructive" /></IconBtn>}
        {ann.conflict && ann.dirty && <IconBtn onClick={() => ann.reloadFromDisk()} title="The planning file changed on disk under unsaved edits — click to take the disk version"><AlertTriangle size={14} className="text-amber-500" /></IconBtn>}
        {tier !== "tight" && <StatusTag status={paper.status === "saving" || ann.status === "saving" ? "saving" : (paper.dirty || ann.dirty) ? "idle" : "saved"} dirty={paper.dirty || ann.dirty} />}
        <div className="h-4 w-px bg-border mx-1 shrink-0" />
        <div className="inline-flex shrink-0 items-center">
        <IconBtn on={find.open} onClick={find.toggle} title="Find / replace (⌘F) — click again to close"><Search size={15} /></IconBtn>
        {!projectDoc && <IconBtn onClick={() => syncOutline()} title="Sync the planning slots + cites from the manuscript, keeping your notes" disabled={syncing}><RotateCw size={14} className={syncing ? "animate-spin" : ""} /></IconBtn>}
        <div className="relative shrink-0">
          <IconBtn on={docOpen} onClick={() => { setDocOpen((o) => !o); setViewOpen(false); }} title="Document — spacing, fonts, open the source file"><FileText size={15} /></IconBtn>
          {docOpen && (
            <>
              <div className="fixed inset-0 z-20" onClick={() => setDocOpen(false)} />
              <div className="absolute right-0 top-9 z-30 w-[248px] rounded-lg border border-border bg-card shadow-xl p-2.5">
                <button onClick={() => { setDocOpen(false); api.open(doc.paper.rel); }}
                  className="flex items-center gap-2 w-full text-left rounded-md px-1.5 py-1.5 text-[12.5px] text-muted-foreground hover:bg-accent hover:text-foreground">
                  <ExternalLink size={13} className="shrink-0" />
                  <span className="flex-1">Open {projectDoc ? "in Obsidian" : docName + " in Obsidian"}</span>
                </button>
                {!projectDoc && (
                  <>
                    <p className="px-1.5 pb-1 pt-2 text-[10px] uppercase tracking-wide text-muted-foreground/70">Manuscript spacing</p>
                    {(["single", "double"] as const).map((s) => (
                      <button key={s} onClick={() => setSpacing(s)}
                        className={`flex items-center gap-2 w-full text-left rounded-md px-1.5 py-1 text-[12.5px] transition-colors ${spacing === s ? "bg-primary/10 text-foreground" : "text-muted-foreground hover:bg-accent"}`}>
                        <span className="w-3.5 shrink-0">{spacing === s ? <Check size={13} className="text-primary" /> : null}</span>
                        <span className="flex-1 capitalize">{s === "double" ? "Double-spaced" : "Single-spaced"}</span>
                        {s === spacingDefault && <span className="text-[10px] text-muted-foreground/60">{formatLabel(publish)} default</span>}
                      </button>
                    ))}
                  </>
                )}
                {!projectDoc && (
                  <>
                    <p className="px-1.5 pb-1 pt-2 border-t border-border/60 mt-2 text-[10px] uppercase tracking-wide text-muted-foreground/70">Font</p>
                    {Object.entries(DOC_FONTS).map(([id, f]) => (
                      <button key={id} onClick={() => setDocKey("font", id)}
                        className={`flex items-center gap-2 w-full text-left rounded-md px-1.5 py-1 text-[12.5px] transition-colors ${docFont === id ? "bg-primary/10 text-foreground" : "text-muted-foreground hover:bg-accent"}`}>
                        <span className="w-3.5 shrink-0">{docFont === id ? <Check size={13} className="text-primary" /> : null}</span>
                        <span className="flex-1" style={{ fontFamily: f.css }}>{f.label}</span>
                        {id === "times" && <span className="text-[10px] text-muted-foreground/60">default</span>}
                      </button>
                    ))}
                    <div className="flex items-center gap-1.5 px-1.5 pt-2">
                      <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70 flex-1">Size</span>
                      {[11, 12, 13].map((n) => (
                        <button key={n} onClick={() => setDocKey("fontsize", String(n))}
                          className={`rounded-full border px-2 py-0.5 text-[10.5px] nums ${docSize === n ? "border-primary/50 text-foreground bg-primary/10" : "border-border text-muted-foreground hover:text-foreground"}`}>
                          {n} pt
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </>
          )}
        </div>
        {doc.preview && (
          <IconBtn
            onClick={async () => { const r = await api.draftingOpenPreview(slug, docName); if (!r.ok) toast.error(r.error || "Couldn't open the live page"); }}
            title={"Live page — open the deployed page this report ships to (" + doc.preview + "). The deployed site may refuse framing, so it opens in your browser."}
          ><Globe size={15} /></IconBtn>
        )}
        <div className="relative shrink-0">
          <IconBtn on={viewOpen || pageView} onClick={() => { setViewOpen((o) => !o); setDocOpen(false); }} title="View — read view, page view, white page, comments"><Eye size={15} /></IconBtn>
          {viewOpen && (
            <>
              <div className="fixed inset-0 z-20" onClick={() => setViewOpen(false)} />
              <div className="absolute right-0 top-9 z-30 w-[248px] rounded-lg border border-border bg-card shadow-xl p-2.5">
                <p className="px-1.5 pb-1 text-[10px] uppercase tracking-wide text-muted-foreground/70">View</p>
                <button onClick={() => { setViewOpen(false); enterRead(); }}
                  className="flex items-center gap-2 w-full text-left rounded-md px-1.5 py-1.5 text-[12.5px] text-muted-foreground hover:bg-accent hover:text-foreground">
                  <BookOpen size={13} className="shrink-0" />
                  <span className="flex-1">Read view</span>
                </button>
                {!projectDoc && <button onClick={() => { setPageView((o) => !o); setViewOpen(false); }}
                  className={`flex items-center gap-2 w-full text-left rounded-md px-1.5 py-1.5 text-[12.5px] transition-colors ${pageView ? "bg-primary/10 text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground"}`}>
                  <FileStack size={13} className="shrink-0" />
                  <span className="flex-1">Page view</span>
                </button>}
                {!projectDoc && <button onClick={() => setShowBreaks((o) => !o)}
                  className={`flex items-center gap-2 w-full text-left rounded-md px-1.5 py-1.5 text-[12.5px] transition-colors ${showBreaks ? "text-foreground" : "text-muted-foreground"} hover:bg-accent`}
                  title="Mark where the compiled document starts each new page, right in the editor — live as you write">
                  <Minus size={13} className="shrink-0" />
                  <span className="flex-1">Page breaks in editor</span>
                  <span className="w-3.5 shrink-0">{showBreaks ? <Check size={13} className="text-primary" /> : null}</span>
                </button>}
                {!projectDoc && (
                  <div className="flex items-center gap-1.5 px-1.5 pb-1 pt-0.5">
                    <span className="text-[10px] text-muted-foreground/60">Layout:</span>
                    {(["docx", "pdf"] as const).map((p) => (
                      <button key={p} onClick={() => setPageProfile(p)}
                        className={`rounded-full border px-2 py-0.5 text-[10.5px] ${pageProfile === p ? "border-primary/50 text-foreground bg-primary/10" : "border-border text-muted-foreground hover:text-foreground"}`}
                        title={p === "docx" ? "Match the Word file (exact — calibrated against real Word output). Drives the page count, the in-editor breaks and Page view." : "Match the compiled PDF (estimate — LaTeX justifies and hyphenates). Drives the page count, the in-editor breaks and Page view."}>
                        {p === "docx" ? "Word" : "PDF"}
                      </button>
                    ))}
                  </div>
                )}
                <button onClick={() => setPageOn((o) => !o)}
                  className={`flex items-center gap-2 w-full text-left rounded-md px-1.5 py-1.5 text-[12.5px] transition-colors ${pageOn ? "text-foreground" : "text-muted-foreground"} hover:bg-accent`}>
                  <Sun size={13} className="shrink-0" />
                  <span className="flex-1">White page</span>
                  <span className="w-3.5 shrink-0">{pageOn ? <Check size={13} className="text-primary" /> : null}</span>
                </button>
                <button onClick={() => setMarginOpen((o) => !o)}
                  className={`flex items-center gap-2 w-full text-left rounded-md px-1.5 py-1.5 text-[12.5px] transition-colors ${marginOpen ? "text-foreground" : "text-muted-foreground"} hover:bg-accent`}>
                  <MessageSquareText size={13} className="shrink-0" />
                  <span className="flex-1">Comments rail</span>
                  <span className="w-3.5 shrink-0">{marginOpen ? <Check size={13} className="text-primary" /> : null}</span>
                </button>
                {/* at the tightest width the zoom pill folds in here, unchanged */}
                {tier === "tight" && (
                  <>
                    <p className="px-1.5 pb-1 pt-2 mt-1 border-t border-border/60 text-[10px] uppercase tracking-wide text-muted-foreground/70">Zoom · {Math.round(zoom * 100)}%</p>
                    <button onClick={() => zoomBy(-0.1)} disabled={zoom <= 0.7} data-qa="menu-zoom-out"
                      className="flex items-center gap-2 w-full text-left rounded-md px-1.5 py-1.5 text-[12.5px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40">
                      <Minus size={13} className="shrink-0" /><span className="flex-1">Zoom out</span>
                    </button>
                    <button onClick={zoomReset} data-qa="menu-zoom-reset"
                      className="flex items-center gap-2 w-full text-left rounded-md px-1.5 py-1.5 text-[12.5px] text-muted-foreground hover:bg-accent hover:text-foreground">
                      <RotateCcw size={13} className="shrink-0" /><span className="flex-1">Reset zoom</span>
                    </button>
                    <button onClick={() => zoomBy(0.1)} disabled={zoom >= 1.8} data-qa="menu-zoom-in"
                      className="flex items-center gap-2 w-full text-left rounded-md px-1.5 py-1.5 text-[12.5px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40">
                      <Plus size={13} className="shrink-0" /><span className="flex-1">Zoom in</span>
                    </button>
                  </>
                )}
              </div>
            </>
          )}
        </div>
        <div className="relative shrink-0">
          <button onClick={() => setPageOpen((o) => !o)}
            title="Paper — white page shade options"
            className={`inline-flex items-center justify-center w-7 h-7 rounded-md transition-colors ${pageOpen ? "text-foreground bg-accent" : "text-muted-foreground hover:text-foreground hover:bg-accent"}`}>
            <Sun size={15} />
          </button>
          {pageOpen && (
            <>
              <div className="fixed inset-0 z-20" onClick={() => setPageOpen(false)} />
              <div className="absolute right-0 top-9 z-30 w-[222px] rounded-lg border border-border bg-card shadow-xl p-2.5">
                <p className="px-1 pb-1.5 text-[10px] uppercase tracking-wide text-muted-foreground/70">Page</p>
                <button onClick={() => setPageOn((o) => !o)}
                  className={`flex items-center gap-2 w-full text-left rounded-md px-1.5 py-1.5 text-[12.5px] transition-colors ${pageOn ? "bg-primary/10 text-foreground" : "text-muted-foreground hover:bg-accent"}`}>
                  <span className="w-3.5 shrink-0">{pageOn ? <Check size={13} className="text-primary" /> : null}</span>
                  <span className="flex-1">White page</span>
                </button>
                <div className={`mt-2 px-1 transition-opacity ${pageOn ? "" : "opacity-40 pointer-events-none"}`}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[10.5px] text-muted-foreground/70">Paper shade</span>
                    <span className="text-[11px] text-muted-foreground nums">{paperShade}</span>
                  </div>
                  <input type="range" min={88} max={100} step={1} value={paperShade} disabled={!pageOn}
                    onChange={(e) => setPaperShade(Number(e.target.value))}
                    title="Soften the paper from warm to bright white"
                    className="w-full accent-primary cursor-pointer" />
                  <div className="mt-0.5 flex items-center justify-between text-[10px] text-muted-foreground/55">
                    <span>warm</span><span>white</span>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
        </div>
        {tier !== "tight" && (
        <div className="inline-flex shrink-0 items-center gap-0.5 rounded-full border border-border px-1 py-0.5 text-muted-foreground">
          <button onClick={() => zoomBy(-0.1)} disabled={zoom <= 0.7} title="Zoom out" className="inline-flex items-center justify-center w-6 h-6 rounded-full hover:text-foreground hover:bg-accent disabled:opacity-40"><Minus size={13} /></button>
          <button onClick={zoomReset} title="Reset zoom to 100%" className="min-w-[44px] text-center text-[11.5px] nums hover:text-foreground">{Math.round(zoom * 100)}%</button>
          <button onClick={() => zoomBy(0.1)} disabled={zoom >= 1.8} title="Zoom in" className="inline-flex items-center justify-center w-6 h-6 rounded-full hover:text-foreground hover:bg-accent disabled:opacity-40"><Plus size={13} /></button>
        </div>
        )}
        <div className="h-4 w-px bg-border mx-1 shrink-0" />
        {/* document-action group — kept together, Outline Comments Versions Corpus References Results Docs Publish. Docs opens on the left (like Outline/Corpus — three-way mutual exclusion) and folds in the doc switcher, Questions, Supplements & Publication checklists. README/PLAN (projectDoc) keep only Comments/Versions/Docs. */}
        {projectDoc && docName === "readme.md" && <button onClick={() => setPlanOpen(true)} title="Plan — the full planning workspace over this README (sections, datasets, readings, logs)" aria-label="Plan" className={pill("border-primary/40 text-primary hover:bg-primary/10")}><Compass size={13} />{!slim && <span>Plan</span>}</button>}
        {projectDoc && docName === "readme.md" && onSwitchDoc && projDocs && (projDocs.manuscripts.length > 0 || projDocs.tree === "papers") && (() => {
          const ms = projDocs.manuscripts;
          const target = ms.length ? (ms.find((m) => m.name === "paper.md") || ms[0]).name : "paper.md";
          const openDraft = async () => {
            if (!ms.length) {
              const heading = (doc.title || "").trim();   // the README's H1
              try {
                const r = await api.draftingCreateDoc(slug, "paper.md", heading);
                if (!r.ok) { toast.error(r.error || "Couldn't create the draft"); return; }
              } catch (err) { toast.error("Couldn't create the draft — " + ((err as Error)?.message || "no reply from the server")); return; }
              api.draftingProjectDocs(slug).then((d) => { if (!d.error) setProjDocs(d); }).catch(() => {});
            }
            onSwitchDoc(target);
          };
          return <button onClick={openDraft} title={ms.length ? `Draft — open ${target}` : "Draft — start writing/paper.md"} aria-label="Draft" className={pill("border-primary/40 text-primary hover:bg-primary/10")}><PenLine size={13} />{!slim && <span>Draft</span>}</button>;
        })()}
        {(!projectDoc || docName === "readme.md") && <button onClick={() => { setCorpusOpen((o) => { if (!o) setOutlineOpen(false); return !o; }); }} title="Corpus — browse every paper in your local corpus, preview it, copy a cite, open its note" aria-label="Corpus" className={pill(corpusOpen ? "border-primary/50 text-foreground bg-primary/10" : "border-border text-muted-foreground hover:text-foreground hover:border-primary/50")}><Library size={13} />{!slim && <span>Corpus</span>}</button>}
        {refBtnOn && <button onClick={() => setRefOpen(true)} aria-label="References"
          title={refFlags.flagged > 0
            ? `Reference list — ${refFlags.flagged} entr${refFlags.flagged === 1 ? "y needs" : "ies need"} fixing${refFlags.unmatched > 0 ? `, and ${refFlags.unmatched} in-text cite${refFlags.unmatched === 1 ? " has" : "s have"} no match` : ""}`
            : "Reference list — resolve every in-text cite, switch citation style, write references.md"}
          className={pill("relative border-border text-muted-foreground hover:text-foreground hover:border-primary/50")}><ListOrdered size={12} />{!slim && <span>References</span>}
          {refFlags.flagged > 0 && <span className={`inline-flex items-center justify-center min-w-[16px] h-[15px] px-1 rounded-full text-[9.5px] font-semibold nums ${refFlags.unmatched > 0 ? "bg-rose-500/20 text-rose-600 dark:text-rose-400" : "bg-amber-500/20 text-amber-600 dark:text-amber-400"}`}>{refFlags.flagged}</span>}</button>}
        {(!projectDoc || Object.keys(prov?.entries ?? {}).length > 0) && <button onClick={() => { setResultsOpen((o) => { if (!o) { refreshProv(); setDocSwitchOpen(false); } return !o; }); }} title="Results — every figure/table with its producing script, data, provenance & freshness; insert a number or an embed, or open the full view to comment coordinate by coordinate (docks on the right)" aria-label="Results" className={pill(`relative ${resultsOpen ? "border-primary/50 text-foreground bg-primary/10" : "border-border text-muted-foreground hover:text-foreground hover:border-primary/50"}`)}><FlaskConical size={13} />{!slim && <span>Results</span>}
          {integrity.total > 0 && <span className={`inline-flex items-center justify-center min-w-[16px] h-[15px] px-1 rounded-full text-[9.5px] font-semibold nums ${(integrity.cites + integrity.figs) > 0 ? "bg-rose-500/20 text-rose-600 dark:text-rose-400" : "bg-amber-500/20 text-amber-600 dark:text-amber-400"}`}>{integrity.total}</span>}</button>}
        {showDocsBtn && <button onClick={() => { setDocSwitchOpen((o) => { if (!o) setResultsOpen(false); return !o; }); }} title="Supplements — notes, cover letter, response letter, appendix, question log & publication checklists (docks on the right)" aria-label="Supplements" className={pill(docSwitchOpen ? "border-primary/50 text-foreground bg-primary/10" : "border-border text-muted-foreground hover:text-foreground hover:border-primary/50")}><Paperclip size={13} />{!slim && <span>Supplements</span>}</button>}
        <div className="relative shrink-0">
          <button ref={reviewBtnRef} onClick={toggleReview} data-review-toggle aria-expanded={reviewMenuOpen} aria-haspopup="menu" title="Review — comments, focus, rewrite, literature, checklist, outline and changes" aria-label="Review"
            className={pill(reviewMenuOpen || focusOpen || rewriteOpen || litOpen || checklistOpen || outlineOpen ? "border-primary/50 text-foreground bg-primary/10" : "border-border text-muted-foreground hover:text-foreground hover:border-primary/50")}><SearchCheck size={13} />{!slim && <span>Review</span>}
            {rewriteOpen && !!rwMenu?.unplaced.length && <span className="nums text-[10px] text-amber-600 dark:text-amber-400" title={`${rwMenu.unplaced.length} unplaced original${rwMenu.unplaced.length === 1 ? "" : "s"}`}>{rwMenu.unplaced.length}</span>}</button>
          {reviewMenuOpen && (() => {
            const item = (on: boolean) => `flex items-center gap-2 w-full text-left rounded-md px-1.5 py-1.5 text-[12.5px] transition-colors ${on ? "text-foreground" : "text-muted-foreground"} hover:bg-accent hover:text-foreground disabled:opacity-40 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50`;
            const sub = "flex items-center gap-2 w-full text-left rounded-md pl-7 pr-1.5 py-1 text-[12px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50";
            const tick = (on: boolean) => <span className="w-3.5 shrink-0">{on ? <Check size={13} className="text-primary" /> : null}</span>;
            const rm = rwMenu;
            return (<>
              {/* the backdrop's press must not move the keys first (they would land on the page) */}
              <div className="fixed inset-0 z-20" onMouseDown={(e) => e.preventDefault()} onClick={closeReviewMenu} />
              <div ref={reviewMenuRef} data-review-menu data-knav-modal role="menu" aria-label="Review" className="absolute right-0 top-9 z-30 w-[272px] max-h-[75vh] overflow-y-auto tinybar rounded-lg border border-border bg-card shadow-xl p-2.5">
                <p className="px-1.5 pb-1 text-[10px] uppercase tracking-wide text-muted-foreground/70">Review</p>
                <button type="button" role="menuitemcheckbox" aria-checked={marginOpen} data-review="comments" aria-label="Comments" onClick={() => setMarginOpen((o) => !o)}
                  title={marginOpen ? "Hide the comments rail" : "Show the comments rail"} className={item(marginOpen)}>
                  <MessageSquareText size={13} className="shrink-0" /><span className="flex-1">Comments</span>{tick(marginOpen)}</button>
                <button type="button" role="menuitemcheckbox" aria-checked={focusOpen} data-review="focus" aria-label="Focus"
                  onClick={() => { if (focusOpen) exitReview(); else openFocus(); setReviewMenuOpen(false); }}
                  title="Focus — one paragraph at a time with its comments; ← → move issue by issue, Esc returns" className={item(focusOpen)}>
                  <FocusIcon size={13} className="shrink-0" /><span className="flex-1">Focus</span>{tick(focusOpen)}</button>
                {focusOpen && (
                  <button type="button" role="menuitemcheckbox" aria-checked={issuesOnly} data-review-issues-only onClick={() => setIssuesOnly(!issuesOnly)}
                    title="← → walk only explicitly flagged paragraphs (Shift+F)" className={sub}>
                    <span className="flex-1">Issues only</span>{tick(issuesOnly)}</button>
                )}
                <button type="button" role="menuitemcheckbox" aria-checked={rewriteOpen} data-review="rewrite" aria-label="Rewrite"
                  onClick={() => { if (rewriteOpen) exitReview(); else openRewrite(); setReviewMenuOpen(false); }}
                  title="Rewrite — each paragraph against its original until the wording and structure are unrecognisably different; Esc returns" className={item(rewriteOpen)}>
                  <Repeat2 size={13} className="shrink-0" /><span className="flex-1">Rewrite</span>{tick(rewriteOpen)}</button>
                {rewriteOpen && rm && (<>
                  <button type="button" role="menuitemcheckbox" aria-checked={unpassedOnly} data-review-unpassed onClick={() => setUnpassedOnly(!unpassedOnly)}
                    title="← → walk only the paragraphs not yet passed (u)" className={sub}>
                    <span className="flex-1">Not passed only</span><span className="nums text-[11px]">{rm.notPassed}</span>{tick(unpassedOnly)}</button>
                  <button type="button" data-review-start-section disabled={!rm.canStart || !rm.untouchedSection} onClick={() => { closeReviewMenu(); rwApi.current?.startSection(); }}
                    title={rm.canStart ? "Take the current text of every untouched paragraph in this section as its original (Shift+S)" : rm.startTip} className={sub}>
                    <span className="flex-1">Start this section</span><span className="nums text-[11px]">{rm.untouchedSection}</span></button>
                  <button type="button" data-review-start-paper disabled={!rm.canStart || !rm.untouchedPaper} onClick={() => { closeReviewMenu(); rwApi.current?.startPaper(); }}
                    title={rm.canStart ? "Take the current text of every untouched paragraph in the paper as its original" : rm.startTip} className={sub}>
                    <span className="flex-1">Start the whole paper</span><span className="nums text-[11px]">{rm.untouchedPaper}</span></button>
                  {rm.hasEntry && <>
                    <button type="button" data-review-restart disabled={rm.busy} onClick={() => { closeReviewMenu(); rwApi.current?.restart(); }}
                      title="The paragraph's current text becomes its original" className={sub}><span className="flex-1">Restart this paragraph</span></button>
                    <button type="button" data-review-drop disabled={rm.busy} onClick={() => { closeReviewMenu(); rwApi.current?.drop(); }}
                      title="Let go of this paragraph's original" className={sub}><span className="flex-1">Drop this original</span></button>
                  </>}
                  {rm.unplaced.length > 0 && <>
                    <p data-rw-unplaced className="pl-7 pr-1.5 pt-1.5 pb-0.5 text-[10px] uppercase tracking-wide text-amber-600/90 dark:text-amber-400/90"
                      title="Originals whose paragraph is gone: attach one to the paragraph on screen, or drop it">Unplaced originals · {rm.unplaced.length}</p>
                    {rm.unplaced.map((o) => (
                      <div key={o.id} data-rw-unplaced-item={o.id} className="flex items-center gap-1 pl-7 pr-1">
                        <span className="min-w-0 flex-1 truncate text-[11.5px] text-foreground/75" style={{ fontFamily: SERIF }} title={o.title}>{o.label}</span>
                        <button type="button" data-rw-attach disabled={!rm.canAttach} onClick={() => { closeReviewMenu(); rwApi.current?.attach(o.id); }}
                          title={rm.canAttach ? "Attach to the paragraph on screen" : "The paragraph on screen already has an original"}
                          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent disabled:opacity-40 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50"><Link2 size={12} /></button>
                        <button type="button" data-rw-unplaced-drop disabled={rm.busy} onClick={() => rwApi.current?.dropUnplaced(o.id)} title="Drop this original"
                          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-destructive hover:bg-accent disabled:opacity-40 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50"><X size={12} /></button>
                      </div>
                    ))}
                  </>}
                </>)}
                {!projectDoc && <button type="button" role="menuitemcheckbox" aria-checked={litOpen} data-review="literature" aria-label="Literature"
                  onClick={() => { if (litOpen) exitReview(); else openLiterature(); setReviewMenuOpen(false); }}
                  title="Literature — every in-text cite in turn, its paragraph on the left and the cited PDF on the right; Space checks, f flags, Esc returns" className={item(litOpen)}>
                  <BookCheck size={13} className="shrink-0" /><span className="flex-1">Literature</span>{tick(litOpen)}</button>}
                <button type="button" role="menuitemcheckbox" aria-checked={checklistOpen} data-review="checklist" aria-label="Checklist"
                  onClick={() => { setChecklistOpen(!checklistOpen); closeReviewMenu(); }}
                  title="Checklist — this paper's own checklist beside the draft; pull items from a journal template or another paper" className={item(checklistOpen)}>
                  <ListChecks size={13} className="shrink-0" /><span className="flex-1">Checklist</span>{tick(checklistOpen)}</button>
                {!projectDoc && <button type="button" role="menuitemcheckbox" aria-checked={outlineOpen} data-review="outline" aria-label="Outline"
                  onClick={() => { setOutlineOpen((o) => { if (!o) setCorpusOpen(false); return !o; }); closeReviewMenu(); }}
                  title="Outline — thesis, core themes & per-section planning (opens on the left)" className={item(outlineOpen)}>
                  <List size={13} className="shrink-0" /><span className="flex-1">Outline</span>{tick(outlineOpen)}</button>}
                <button type="button" role="menuitem" data-review-accept-all disabled={openSuggestionIds.length === 0} onClick={acceptAllSuggestions}
                  title={openSuggestionIds.length ? "Accept every open suggestion; Undo restores the batch" : "No open suggested revisions"} className={item(false)}>
                  <CheckCheck size={13} className="shrink-0" /><span className="flex-1">Accept all suggestions ({openSuggestionIds.length})</span></button>
                <button type="button" role="menuitem" data-review-resolve-all disabled={openAgentCommentIds.length === 0} onClick={() => requestReviewBatch("resolve", openAgentCommentIds)}
                  title="Resolve open agent comments and flags; keep the user's comments open; Undo restores the batch" className={item(false)}>
                  <Check size={13} className="shrink-0" /><span className="flex-1">Resolve all comments ({openAgentCommentIds.length})</span></button>
                {reviewUndoAction && <button type="button" role="menuitem" data-review-undo className={item(false)}
                  title="Undo the last review batch, restoring its text and comments together"
                  onClick={() => { closeReviewMenu(); reviewUndoAction.onClick(); }}><Undo2 size={13} className="shrink-0" /><span className="flex-1">Undo</span></button>}
                {reviewConfirm && <div className="flex gap-1" data-review-confirm>
                  <button type="button" role="menuitem" data-review-confirm-apply className={item(false)} title="Confirm this batch"
                    onClick={() => runReviewBatch(reviewConfirm.action, reviewConfirm.ids)}>Confirm ({reviewConfirm.ids.length})</button>
                  <button type="button" role="menuitem" className={item(false)} title="Cancel this batch" onClick={() => setReviewConfirm(null)}>Cancel</button>
                </div>}
                <p className="px-1.5 pb-1 pt-2 mt-1 border-t border-border/60 text-[10px] uppercase tracking-wide text-muted-foreground/70" data-review-changes>Changes</p>
                <button type="button" data-review-versions aria-label="Versions" onClick={() => { closeReviewMenu(); setVersionsOpen(true); }}
                  title="Versions — save checkpoints, see a redline of what changed, compile a marked-up PDF for reviewers" className={item(false)}>
                  <History size={13} className="shrink-0" /><span className="flex-1">Version history</span></button>
              </div>
            </>);
          })()}
        </div>
        {!projectDoc && <button onClick={() => setPublishOpen(true)} title="Publish — compile to PDF, choose layout options, preview" aria-label="Publish" className={pill("border-primary/40 text-primary hover:bg-primary/10")}><FileOutput size={13} /><span>Publish</span></button>}
      </div>
      )}
      <div ref={setRowEl} className="relative flex-1 min-h-0 flex">
        {find.node && <div className="absolute top-3 z-50" style={{ right: rightDocksW + (isWide && corpusOpen && corpusSide === "right" ? corpusW : 0) + 16 }}>{find.node}</div>}
        {focusOpen && (
          // its own boundary: a throw in Focus must not take the paper down (Esc still leaves)
          <div aria-hidden={reviewMenuOpen || undefined} className="absolute inset-0 z-[45] bg-background" style={bannerH ? { top: bannerH } : undefined}><ErrorBoundary>
          <FocusMode slug={slug} docName={docName} text={paper.text} main={manuscript} comments={review.comments} tick={geoTick}
            style={style} zoom={zoom} citeMap={citeMap}
            onMention={onMention} onMentionKey={onMentionKey} mentionActive={!!mention} citeTarget={citeTarget}
            onCitationClick={(rel) => setSource({ rel, quote: "" })} onCitePage={(rel, page) => setPdfView({ rel, page })}
            activeComment={activeComment} onActivate={setActiveComment}
            startPos={focusStartRef.current}
            issuesOnly={issuesOnly} onIssuesOnly={setIssuesOnly}
            onFlag={addFlag} onUnflag={unflag}
            onAccept={acceptSuggestions} suggestionIds={openSuggestionIds}
            onRequestComment={(sel) => setComposer(sel)}
            onContextMenu={(info) => setCtxMenu(info)}
            onSave={() => { paper.flush(); ann.flush(); review.flush(); toast.success("Saved"); }}
            onExit={exitReview}
            renderCard={renderReviewCard} />
          </ErrorBoundary></div>
        )}
        {rewriteOpen && (
          <div aria-hidden={reviewMenuOpen || undefined} className="absolute inset-0 z-[45] bg-background" style={bannerH ? { top: bannerH } : undefined}><ErrorBoundary>
          <RewriteMode slug={slug} docName={docName} text={paper.text} main={manuscript}
            ready={diskReady && diverged?.kind !== "conflict"}
            unpassedOnly={unpassedOnly} onUnpassedOnly={setUnpassedOnly} apiRef={rwApi} onMenu={setRwMenu}
            style={style} zoom={zoom} citeMap={citeMap}
            onMention={onMention} onMentionKey={onMentionKey} mentionActive={!!mention} citeTarget={citeTarget}
            onCitationClick={(rel) => setSource({ rel, quote: "" })} onCitePage={(rel, page) => setPdfView({ rel, page })}
            startPos={focusStartRef.current}
            onContextMenu={(info) => setCtxMenu(info)}
            comments={review.comments} tick={geoTick} activeComment={activeComment} onActivate={setActiveComment}
            renderCard={renderReviewCard}
            onSave={() => { paper.flush(); ann.flush(); review.flush(); toast.success("Saved"); }}
            onExit={exitReview} />
          </ErrorBoundary></div>
        )}
        {litOpen && (
          <div aria-hidden={reviewMenuOpen || undefined} className="absolute inset-0 z-[45] bg-background" style={bannerH ? { top: bannerH } : undefined}><ErrorBoundary>
          <LiteratureMode slug={slug} docName={docName} text={paper.text} citeMap={citeMap} comments={review.comments} paused={reviewMenuOpen}
            onFlag={(from, to, note) => { const id = addFlag(from, to); if (id && note) updateComment(id, { body: note }); }}
            onOpenNote={(rel) => setSource({ rel, quote: "" })}
            onExit={exitReview} />
          </ErrorBoundary></div>
        )}
        {corpusOpen && corpusSide === "left" && <Dock wide={isWide} side="left">{corpusPanel}</Dock>}
        {outlineOpen && <Dock wide={isWide} side="left"><OutlinePanel slug={slug} docName={docName} title={liveTitle} headings={headings} comments={comments} paperText={paper.text} onDocKey={doc.kind === "paper" && !projectDoc && !/^(cover-letter|reviewer_response|appendix)\.md$/i.test(docName) ? setDocKey : undefined} onJump={(pos) => scrollToParaPos(pos)} onPoint={onPoint} onPaperEdit={applyPaperEdit} onOpenPlan={() => setPlanOpen(true)} onClose={() => setOutlineOpen(false)} /></Dock>}
        {pageView && !readMode && !projectDoc && (
          <PageView raw={paper.text} spacing={spacing} profile={pageProfile} slug={slug} zoom={zoom}
            onJump={(off) => { setPageView(false); setTimeout(() => manuscript.current?.scrollToPos(off), 60); }} />
        )}
        <div ref={scrollRef} className={`flex-1 min-h-0 overflow-y-auto${pageView && !readMode ? " hidden" : ""}`} onClick={() => { if (styleOpen) setStyleOpen(false); }}>
        <div ref={wrapRef} className="relative mx-auto px-6 py-6" style={{ maxWidth: paperW }}>
          <div ref={manuHostRef} style={{ marginRight: reserveW }}>
            <MarkdownEditor ref={manuscript} value={doc.paper.text} onChange={paper.setText} onBlur={paper.flush}
              slug={slug} embeds={embeds} tablePngs={tablePngs} style={style} zoom={zoom} pageStyle={pageStyle} paperBg={paperBg} pageTokens={pageActive}
              pageBreaks={showBreaks && !projectDoc ? pageBreaks : undefined}
              citeMap={citeMap} onCitationClick={(rel) => setSource({ rel, quote: "" })}
              onCitePage={(rel, page) => setPdfView({ rel, page })}
              onMention={onMainMention} onMentionKey={onMentionKey} mentionActive={!!mention}
              onGeometry={() => setGeoTick((t) => t + 1)} onCursor={() => { setActivePos(manuscript.current?.cursorPos() ?? 0); setSelWords(countWords(manuscript.current?.selectedText() ?? "")); }}
              onRequestComment={(sel) => setComposer(sel)}
              onCursorComment={(id, o) => { setActiveComment(id); if (o?.pointer && id) setSoloComment(id); else setSoloComment(null); }}
              onReplyAt={(id) => { setMarginOpen(true); setActiveComment(id); setSoloComment(id); setReplyReq((r) => ({ id, n: r.n + 1 })); }}
              onContextMenu={(info) => setCtxMenu(info)}
              figureRects={figRectData.by} onFigureRectClick={(id) => { setMarginOpen(true); setActiveComment(id); }}
              embedProv={embedProvMap} onProvenanceOpen={(d) => setProvPop(d)}
              onExpandFigure={openLightbox}
              onEditDiagram={(name) => setDiagramEd({ name })}
              onSave={() => { paper.flush(); ann.flush(); review.flush(); toast.success("Saved"); }}
              placeholder="Start writing the manuscript…" />
          </div>
          {marginOpen && !railFolded && !focusOpen && !rewriteOpen && !litOpen && (
            <div className="absolute top-6 right-6" style={{ width: CARD_W }}>
              {/* rail header: fold every reply thread / every section at once. Sits in the
                  gutter ABOVE the rail so it never covers a card docked at the top. */}
              {(() => {
                const hasCmts = review.comments.length > 0;
                return (
                <div data-cmt-rail-tools className="absolute bottom-full right-0 mb-0.5 flex max-w-full items-center gap-1">
                  {hasCmts && (<>
                  <label title="Sort the comments" className="inline-flex min-w-0 items-center gap-0.5 rounded px-1 py-0.5 text-[10.5px] text-muted-foreground hover:text-foreground hover:bg-muted/60 focus-within:ring-1 focus-within:ring-primary/50">
                    <ArrowUpDown size={11} className="shrink-0" />
                    <select data-cmt-sort aria-label="Sort the comments" value={railSort} onChange={(e) => setCmtSort(e.target.value as CmtSort)}
                      className="min-w-0 cursor-pointer appearance-none bg-transparent text-[10.5px] text-inherit focus:outline-none [&>option]:bg-card [&>option]:text-foreground">
                      {CMT_SORTS.filter((k) => hasOutline || !k.startsWith("outline")).map((k) => <option key={k} value={k}>{CMT_SORT_LABEL[k]}</option>)}
                    </select>
                  </label>
                  {review.comments.some((c) => c.author === "checker") && (
                    <button type="button" data-cmt-findings aria-pressed={findingsOnly} onClick={() => setFindingsOnly(!findingsOnly)}
                      title={findingsOnly ? "Show every comment" : "Show only open reviewer findings"}
                      className={`inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] ${findingsOnly ? "bg-amber-500/10 text-amber-600 dark:text-amber-400" : "text-muted-foreground hover:text-foreground hover:bg-muted/60"}`}>
                      <CheckCheck size={11} />{findingsOnly ? "Findings only" : "Findings"}</button>
                  )}
                  {openSuggestionIds.length > 1 && (
                    <button type="button" data-cmt-accept-all onClick={acceptAllSuggestions}
                      title="Accept every open suggestion; Undo restores the batch"
                      className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] text-primary hover:bg-primary/10">
                      <Check size={11} />Accept all <span className="nums">{openSuggestionIds.length}</span></button>
                  )}
                  {railHeadings.length > 0 && !listSorted && (
                    <button type="button" data-cmt-sections-all
                      onClick={() => setFolded(foldedSecs.size ? new Set() : new Set(orderedComments.map((c) => sectionOf(c.id).key)))}
                      title={foldedSecs.size ? "Expand every section" : "Collapse every section"}
                      className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] text-muted-foreground hover:text-foreground hover:bg-muted/60">
                      <ListTree size={11} />{foldedSecs.size ? "Open sections" : "Fold sections"}</button>
                  )}
                  <button type="button" data-cmt-threads-all
                    onClick={() => setThreadsAll((t) => ({ open: !t.open, n: t.n + 1 }))}
                    title={threadsAll.open ? "Collapse every comment to its main point" : "Expand every comment and its replies"}
                    className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] text-muted-foreground hover:text-foreground hover:bg-muted/60">
                    {threadsAll.open ? <ChevronsDownUp size={11} /> : <ChevronsUpDown size={11} />}{threadsAll.open ? "Collapse all" : "Expand all"}</button>
                  </>)}
                </div>);
              })()}
              {review.comments.length === 0 && !resolvedPending && (
                <div className="rounded-lg border border-dashed border-border p-3 text-[12px] text-muted-foreground leading-snug">Select text and <span className="text-foreground">right-click → Comment</span> to leave a note pinned to it. Per-paragraph planning lives in the <button onClick={() => setOutlineOpen(true)} className="text-primary hover:underline">Outline</button>.</div>
              )}
              {(() => {
              const shown = sortComments(orderedComments.filter(railKeep), railSort);
              railOrderRef.current = shown.map((c) => c.id);
              // an orphaned or filtered-out solo id has no card to show: fall back to the full rail
              const solo = soloComment && shown.some((c) => c.id === soloComment) ? soloComment : null;
              const groups: { key: string; title: string; at: number; end?: number; ids: string[] }[] = [];
              const secOf = new Map<string, string>();
              if (railHeadings.length && !listSorted) {
                for (const c of shown) {
                  const s = sectionOf(c.id);
                  secOf.set(c.id, s.key);
                  const g = groups[groups.length - 1];
                  if (g && g.key === s.key) g.ids.push(c.id); else groups.push({ ...s, ids: [c.id] });
                }
              }
              railSecsRef.current = groups.map((g) => ({ key: g.key, at: g.at, end: g.end, ids: g.ids }));
              return (<>
              {groups.map((g) => {
                const folded = foldedSecs.has(g.key);
                const open = g.ids.filter((id) => !shown.find((x) => x.id === id)?.resolved).length;
                return (
                  <button key={"sec:" + g.key} type="button" data-cmt-section={g.title} aria-expanded={!folded}
                    ref={(el) => { cardEls.current.set("sec:" + g.key, el as unknown as HTMLDivElement | null); }}
                    hidden={!!solo}
                    onClick={() => { const n = new Set(foldedSecs); if (folded) n.delete(g.key); else n.add(g.key); setFolded(n); }}
                    title={`${g.title} · ${folded ? "show" : "hide"} its comments`}
                    style={{ width: CARD_W, ...(solo ? { display: "none" } : null) }}
                    className="absolute right-0 flex items-center gap-1 border-b border-border/70 px-0.5 pb-0.5 text-left text-[10.5px] font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50">
                    {folded ? <ChevronRight size={11} className="shrink-0" /> : <ChevronDown size={11} className="shrink-0" />}
                    <span className="min-w-0 flex-1 truncate">{g.title}</span>
                    {/* until the resolved half lands a section's total is not known: show the open count alone */}
                    <span className="shrink-0 nums" title={resolvedPending ? `${open} open` : `${open} open of ${g.ids.length}`}>{resolvedPending || open === g.ids.length ? open : `${open}/${g.ids.length}`}</span>
                  </button>);
              })}
              {solo && (
                <button ref={soloPillRef} onClick={() => setSoloComment(null)} title="Show every comment (Esc)"
                  className="absolute right-0 inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2 py-0.5 text-[10.5px] text-muted-foreground hover:text-foreground">
                  <MessageSquare size={11} /> All comments ({shown.length + review.resolvedUnheld})</button>
              )}
              {shown.map((c) => (
                <AnchoredCommentCard key={"cmt:" + c.id} comment={c} active={c.id === activeComment} orphaned={orphans.includes(c.id)}
                  // solo shows one card whatever its section; otherwise a folded section
                  // hides its cards (still mounted, so drafts in them survive)
                  hidden={solo ? c.id !== solo : foldedSecs.has(secOf.get(c.id) ?? "")}
                  threadsAll={threadsAll}
                  solo={solo === c.id}
                  pinned={pins.includes(c.id)} onPin={() => togglePin(c.id)}
                  num={figRectData.nums[c.id]}
                  stack={anchorStacks.get(c.id)}
                  registerRef={(el) => cardEls.current.set("cmt:" + c.id, el)}
                  onActivate={() => setActiveComment(c.id)}
                  onLocate={() => {
                    setActiveComment(c.id);
                    setSoloComment(c.id);
                    focusCard(c.id);
                    const r = manuscript.current?.commentRanges().find((x) => x.id === c.id);
                    if (r) scrollToParaPos(r.from, { eased: true, nearest: true });
                  }}
                  onWalk={(dir, held) => {
                    const i = shown.findIndex((x) => x.id === c.id);
                    const next = i < 0 ? undefined : shown[i + dir];
                    if (!next) return;
                    setActiveComment(next.id);
                    setSoloComment(next.id);
                    const r = manuscript.current?.commentRanges().find((x) => x.id === next.id);
                    // held: a repeat ramps one continuous motion instead of restarting the
                    // ease under itself at every repeat
                    if (r) scrollToParaPos(r.from, { eased: true, nearest: true, held });
                    focusCard(next.id);
                  }}
                  onBody={(v) => updateComment(c.id, { body: v })}
                  onResolve={() => toggleResolved(c.id)}
                  onDelete={() => deleteComment(c.id)} onReattach={() => reattachComment(c.id)}
                  onReply={(v) => replyToComment(c.id, v)}
                  onAccept={() => acceptSuggestion(c.id)} onReject={() => rejectSuggestion(c.id)} sugBase={suggestionBase(c)} acceptError={acceptErrs[c.id]}
                  onProposed={(v) => setProposed(c.id, v)} onUseRewrite={(b) => rewriteToSuggestion(c.id, b)}
                  replyTick={replyReq.id === c.id ? replyReq.n : 0}
                  onEscapeToText={() => {
                    const r = manuscript.current?.commentRanges().find((x) => x.id === c.id);
                    if (r) manuscript.current?.caretTo(r.from); else manuscript.current?.focus();
                  }}
                  onLayoutChange={() => setGeoTick((t) => t + 1)} />
              ))}
              </>);
              })()}
            </div>
          )}
        </div>
        {pinnedCmts.length > 0 && !pinRaised && (
          <div className="sticky bottom-0 z-40 mx-auto h-0" style={{ maxWidth: paperW }}>{pinDock}</div>
        )}
        </div>
        {pinnedCmts.length > 0 && pinRaised && (
          <div className="absolute bottom-0 z-[46] h-0 w-0" style={{ right: rightDocksW + (isWide && corpusOpen && corpusSide === "right" ? corpusW : 0) }}>{pinDock}</div>
        )}
        {corpusOpen && corpusSide === "right" && <Dock wide={isWide} side="right">{corpusPanel}</Dock>}
        {resultsOpen && <Dock wide={isWide} side="right"><ResultsPanel slug={slug} docName={docName} prov={prov} assetStamps={assetStamps} citesUnresolved={integrity.cites} flagsOpen={integrity.flags}
          figComments={figCmts.comments} onClose={() => setResultsOpen(false)} onRefresh={() => { refreshProv(); refreshFigCmts(); }}
          onJumpToLine={jumpToLine} onViewFile={(candidates, title) => setFileView({ candidates, title })}
          onOpenReferences={() => setRefOpen(true)} onShowFlags={() => { setMarginOpen(true); const f = review.comments.find((c) => c.kind === "flag" && !c.resolved); if (f) setActiveComment(f.id); }}
          onInsertEmbed={insertEmbed} onOpenLightbox={(stem, kind) => setLightbox({ stem, kind })}
          numbersTick={numbersTick} onInsertNumber={() => { setNumPreselect(null); setNumPicker(true); }}
          onInsertCell={(cell: FindingCell) => { setNumPreselect(cell); setNumPicker(true); }}
          wide={wideDock} onWide={(v) => setWideOverride(v === railEmpty ? null : v)}
          onNewDiagram={newDiagram}
          onEditDiagram={(stem) => setDiagramEd({ name: stem + ".png" })} /></Dock>}
        {docSwitchOpen && <Dock wide={isWide} side="right"><SupplementsPanel docName={docName} projectDoc={projectDoc} onSwitchDoc={onSwitchDoc} projDocs={projDocs} supList={supList}
          onOpenBeside={onOpenBeside ? (name) => { onOpenBeside(name); setDocSwitchOpen(false); } : undefined}
          onNewDoc={newDocument}
          onOpenQuestions={(path) => { setFileView({ candidates: [path], title: "Questions" }); }}
          onOpenSupplement={(name) => setSupName(name)}
          onOpenChecklist={() => setJournalsOpen(true)}
          onClose={() => setDocSwitchOpen(false)} /></Dock>}
        {checklistOpen && <Dock wide={isWide} side="right"><ErrorBoundary><ChecklistPanel slug={slug} onClose={() => setChecklistOpen(false)} /></ErrorBoundary></Dock>}
        <NewDocumentDialog open={newDocOpen} onOpenChange={setNewDocOpen} existing={existingDocs} onCreate={createDocument} />
        {diverged && <DivergenceBanner state={diverged} onViewDiff={() => setDiffOpen({ oldText: diverged.oldText, newText: diverged.newText })}
          onUndo={undoApplied} onTakeTheirs={takeTheirs} onKeepMine={keepMine} onDismiss={() => setDiverged(null)} />}
        {!diverged && !readMode && prov && <EmbedIntegrityBanner problems={prov.embeds.filter((e) => !e.exempt && !e.resolved)} docName={docName} onJump={jumpToLine} onRepoint={repointEmbed} />}
      </div>

      {refOpen && <ReferencesPanel slug={slug} docName={docName} style={refStyle} setStyle={setRefStyle} onClose={() => setRefOpen(false)} onViewSource={(rel) => setSource({ rel, quote: "" })} />}
      {publishOpen && <DraftPublish slug={slug} docName={docName} title={liveTitle} flush={flushForPublish} setDocKeys={setDocKeys} onClose={() => setPublishOpen(false)} />}
      {supName && <SupplementPanel slug={slug} name0={supName} paperTitle={liveTitle}
        onOpenFull={openSupplementFull} onClose={() => { setSupName(null); setSupList(null); }} />}
      {journalsOpen && <JournalChecklistPanel publish={publish} onClose={() => setJournalsOpen(false)} />}
      {versionsOpen && <VersionsPanel slug={slug} docName={docName} title={liveTitle}
        getMtime={paper.mtime} flush={() => Promise.all([paper.flush(), ann.flush()]).then(() => {})}
        onRestored={(text, mtime) => { manuscript.current?.setContent(text); paper.applyExternal(text, mtime); }}
        onClose={() => setVersionsOpen(false)} />}
      {planOpen && <PlanWorkspace slug={slug} title={liveTitle}
        onReadmeSaved={(text, mtime) => { if (projectDoc && docName === "readme.md") { manuscript.current?.setContent(text); paper.applyExternal(text, mtime); } else cacheDraftPart(slug, "readme.md", "paper", text, mtime); }}
        flushReadme={projectDoc && docName === "readme.md" ? () => paper.flush() : undefined}
        onOpenReadmeEditor={onSwitchDoc && docName !== "readme.md" ? () => { setPlanOpen(false); onSwitchDoc("readme.md"); } : undefined}
        onViewFile={(candidates, title) => setFileView({ candidates, title })}
        onClose={() => setPlanOpen(false)} />}
      {source && <SourceViewer rel={source.rel} quote={source.quote} project={projectRelOf(doc.paper.rel)} onClose={() => setSource(null)} />}
      {fileView && <FileViewerPanel slug={slug} candidates={fileView.candidates} title={fileView.title} onClose={() => setFileView(null)} />}
      {provPop && <ProvenancePopover at={provPop} prov={prov} onViewFile={(candidates, title) => { setProvPop(null); setFileView({ candidates, title }); }} onClose={() => setProvPop(null)} />}
      {lightbox && <FigureLightbox slug={slug} stem={lightbox.stem} kind={lightbox.kind}
        gallery={lightboxGallery} onNavigate={(stem, kind) => setLightbox({ stem, kind })}
        initial={figCmts.comments[lightbox.stem] || []} prov={prov?.entries?.[lightbox.stem]}
        stamp={lightbox.kind === "table" ? null : assetStamps[lightbox.stem + ".png"]}
        onSave={(items) => saveFigCmts(lightbox.stem, items)} onClose={() => setLightbox(null)}
        onViewFile={(candidates, title) => setFileView({ candidates, title })} blockKeys={!!fileView} />}
      {diagramEd && <DiagramEditor slug={slug} name={diagramEd.name} title={diagramEd.title}
        onSaved={(stem, first) => { if (first) insertEmbed(stem, "figure"); else setTimeout(refreshProv, 300); }}
        onClose={() => { setDiagramEd(null); refreshProv(); }} />}
      {pdfView && <SourcePdfViewer rel={pdfView.rel} page={pdfView.page} onClose={() => setPdfView(null)} onOpenNote={(rel) => { setPdfView(null); setSource({ rel, quote: "" }); }} />}
      {composer && <CommentComposer sel={composer} onSubmit={(body, proposed) => { addComment(composer, body, proposed); setComposer(null); }} onCancel={() => setComposer(null)} />}
      {ctxMenu && <EditorContextMenu at={ctxMenu} hasSelection={ctxMenu.hasSelection} embeds={insertableEmbeds}
        onComment={() => { const sel = manuscript.current?.selectionRange(); if (sel) setComposer({ from: sel.from, to: sel.to, text: sel.text, x: ctxMenu.x, y: ctxMenu.y }); }}
        onSuggest={() => { const sel = manuscript.current?.selectionRange(); if (sel) setComposer({ from: sel.from, to: sel.to, text: sel.text, x: ctxMenu.x, y: ctxMenu.y, suggest: true }); }}
        onInsertEmbed={insertEmbed} onInsertCitation={insertCitation} onNewDiagram={newDiagram}
        onInsertNumber={projectDoc ? undefined : () => setNumPicker(true)}
        onInsertPageBreak={() => manuscript.current?.insertAtCursor("\\newpage")}
        onIndentParagraph={() => {
          const v = manuscript.current?.getView();
          if (!v) return;
          const d = v.state.doc, sel = v.state.selection.main;
          let a = d.lineAt(sel.from).number, b = d.lineAt(sel.to).number;
          while (a > 1 && d.line(a - 1).text.trim() !== "") a--;
          while (b < d.lines && d.line(b + 1).text.trim() !== "") b++;
          const lines = Array.from({ length: b - a + 1 }, (_, i) => d.line(a + i)).filter((l) => l.text.trim() !== "");
          if (!lines.length) return;
          const quoted = lines.every((l) => /^\s*>/.test(l.text));
          v.dispatch({
            changes: lines.map((l) => {
              if (!quoted) return { from: l.from, insert: "> " };
              const m = /^(\s*)> ?/.exec(l.text)!;
              return { from: l.from + m[1].length, to: l.from + m[0].length, insert: "" };
            }),
            userEvent: "input",
          });
        }}
        onOpenResults={() => setResultsOpen(true)} onClose={() => setCtxMenu(null)}
        onRefocus={() => requestAnimationFrame(() => {
          const pane = rootRef.current?.querySelector<HTMLElement>("[data-focus-text] .cm-content, [data-rw-live] .cm-content");
          if (pane) selectFromMain(manuscript.current?.getView(), pane, Number(pane.closest<HTMLElement>("[data-review-pos]")?.dataset.reviewPos ?? 0));
          else manuscript.current?.focus();
        })} />}
      {numPicker && <NumberPicker slug={slug} docName={docName} preselect={numPreselect} onInsert={insertNumber} onJumpToLine={jumpToLine}
        onViewFile={(candidates, title) => setFileView({ candidates, title })} onClose={() => { setNumPicker(false); setNumPreselect(null); }} />}
      {diffOpen && <DiffModal oldText={diffOpen.oldText} newText={diffOpen.newText} onClose={() => setDiffOpen(null)} />}
      {mention && <MentionSearch info={mention} hits={mentionHits} sel={mentionSel} mode={citeMode} loading={mentionLoading}
        level={mentionLevel} drillHit={drillHit} quoteSel={quoteSel} pending={pendingCites}
        onMode={setCiteMode} onPickHit={pickHit} onHover={setMentionSel} onAddAnother={addToGroup}
        onPickQuote={(i) => drillHit && insertQuote(drillHit, i)} onHoverQuote={setQuoteSel}
        onDropPending={(i) => setPendingCites((p) => p.filter((_, j) => j !== i))}
        onCommitGroup={commitGroup}
        onBack={() => { setMentionLevel(0); setDrillHit(null); }} />}
    </div>,
    document.body
  );
}

const SLIDE_RE = /^##\s+Slide\s+(\d+)\b/i;

function parseReview(text: string): Map<number, string> {
  const map = new Map<number, string>();
  let cur: number | null = null, buf: string[] = [];
  const flush = () => { if (cur !== null) { const t = buf.join("\n").trim(); if (t) map.set(cur, t); } };
  for (const ln of (text || "").split("\n")) {
    const m = ln.match(SLIDE_RE);
    if (m) { flush(); cur = parseInt(m[1], 10); buf = []; }
    else if (cur !== null) buf.push(ln);
  }
  flush();
  return map;
}

function serializeReview(map: Map<number, string>, title: string): string {
  const nums = [...map.keys()].filter((n) => (map.get(n) || "").trim()).sort((a, b) => a - b);
  if (!nums.length) return "";
  const parts = ["# " + (title || "Deck") + " — review comments", ""];
  for (const n of nums) parts.push("## Slide " + n, (map.get(n) || "").trim(), "");
  return parts.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

function MarpThumbs({ css, slides, current, onPick }: { css: string; slides: DeckSlide[]; current: number; onPick: (i: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const rootRef = useRef<ShadowRoot | null>(null);
  const pickRef = useRef(onPick); pickRef.current = onPick;
  useEffect(() => {
    const host = ref.current; if (!host) return;
    const root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    rootRef.current = root;
    const thumbs = slides.map((s, i) =>
      "<button class=\"thumb\" data-i=\"" + i + "\" title=\"Slide " + (i + 1) + "\">" +
      "<span class=\"n\">" + (i + 1) + "</span><div class=\"marpit\">" + s.svg + "</div></button>").join("");
    root.innerHTML =
      "<style>:host{display:block}" +
      " .rail{display:flex;gap:8px;overflow-x:auto;padding:6px 2px}" +
      " .thumb{position:relative;flex:0 0 auto;width:148px;padding:0;border:1px solid rgba(120,120,120,.3);border-radius:6px;overflow:hidden;cursor:pointer;background:#fff;" +
      "font:inherit;color:inherit;text-align:inherit;letter-spacing:inherit;word-spacing:inherit;text-indent:inherit;text-transform:inherit;text-shadow:inherit;line-height:0}" +
      " .thumb:hover{border-color:rgba(30,95,191,.6)}" +
      " .thumb.cur{outline:2px solid #1e5fbf;outline-offset:-2px;border-color:#1e5fbf}" +
      " .thumb .n{position:absolute;left:3px;top:2px;z-index:2;font:600 9px/1.4 system-ui;color:#444;background:rgba(255,255,255,.78);border-radius:3px;padding:0 3px}" +
      // line-height:0 above kills the inline-block descender gap under each thumb; neutralise
      // it here so it cannot reach the slide's text (MarpSurface does the same on :host).
      " .marpit{margin:0;padding:0;line-height:initial} svg[data-marpit-svg]{display:block;width:100%;height:auto;pointer-events:none}</style>" +
      "<style>" + css + "</style><div class=\"rail\">" + thumbs + "</div>";
    const onClick = (e: Event) => {
      const t = (e.target as HTMLElement).closest("[data-i]");
      if (t) pickRef.current(parseInt(t.getAttribute("data-i") || "0", 10));
    };
    root.addEventListener("click", onClick);
    return () => root.removeEventListener("click", onClick);
  }, [css, slides]);
  useEffect(() => {
    const root = rootRef.current; if (!root) return;
    root.querySelectorAll(".thumb").forEach((el, i) => (el as HTMLElement).classList.toggle("cur", i === current));
    (root.querySelector(".thumb.cur") as HTMLElement | null)?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
  }, [current]);
  return <div ref={ref} />;
}

function useDeckReview(slug: string, deck: string, initial: DeckReview, title: string) {
  const [map, setMap] = useState(() => parseReview(initial.text));
  const mtimeRef = useRef(initial.mtime || 0);
  const savedRef = useRef(initial.text || "");
  const mapRef = useRef(map); mapRef.current = map;
  const titleRef = useRef(title); titleRef.current = title;
  const save = useCallback((force = false) => {
    const text = serializeReview(mapRef.current, titleRef.current);
    if (text === savedRef.current) return Promise.resolve();
    return api.draftingSaveDeckReview({ slug, deck, text, baseMtime: mtimeRef.current || null, force })
      .then((r) => {
        if (r.ok) { savedRef.current = text; mtimeRef.current = r.mtime!; }
        else if (r.conflict) {
          toast("Deck comments changed on disk", { description: "Reload to get the latest.", action: { label: "Reload", onClick: () => api.draftingDeckReview(slug, deck).then((rv) => { setMap(parseReview(rv.text)); savedRef.current = rv.text; mtimeRef.current = rv.mtime; }) } });
        }
      }).catch(() => {});
  }, [slug, deck]);
  useEffect(() => { const id = setTimeout(() => save(), 900); return () => clearTimeout(id); }, [map, save]);
  useEffect(() => () => { save(true); }, [save]);
  const setComment = useCallback((nm: number, text: string) => setMap((m) => { const next = new Map(m); if (text.trim()) next.set(nm, text); else next.delete(nm); return next; }), []);
  return { map, setComment, save };
}

function useDeckNotes(slug: string, deck: string, slides: DeckSlide[], initialMtime: number) {
  const seed = useMemo(() => { const m: Record<number, string> = {}; slides.forEach((s, i) => { m[i + 1] = s.note || ""; }); return m; }, [slides]);
  const [notes, setNotes] = useState<Record<number, string>>(seed);
  const notesRef = useRef(notes); notesRef.current = notes;
  const savedRef = useRef<Record<number, string>>({ ...seed });
  const mtimeRef = useRef(initialMtime || 0);
  const dirtyRef = useRef<Set<number>>(new Set());
  const chainRef = useRef<Promise<void>>(Promise.resolve());
  const timers = useRef<Record<number, number>>({});
  const [saving, setSaving] = useState(false);
  const [dirtyN, setDirtyN] = useState(0);
  const [err, setErr] = useState(false);
  const mtRef = useRef(initialMtime); mtRef.current = initialMtime;
  // a fresh render (deck reload) reseeds from disk and drops any in-flight dirty state
  useEffect(() => {
    setNotes(seed); savedRef.current = { ...seed }; dirtyRef.current.clear();
    mtimeRef.current = mtRef.current || 0; setDirtyN(0); setErr(false);
  }, [seed]);

  const flush = useCallback((num: number) => {
    const text = notesRef.current[num] ?? "";
    if (text === (savedRef.current[num] ?? "")) return;
    chainRef.current = chainRef.current.then(async () => {
      setSaving(true);
      let r = await api.draftingSaveDeckNote({ slug, deck, slide: num, text, baseMtime: mtimeRef.current || null });
      if (r.conflict) r = await api.draftingSaveDeckNote({ slug, deck, slide: num, text, baseMtime: r.currentMtime ?? null });
      if (r.ok) { savedRef.current[num] = text; if (r.mtime) mtimeRef.current = r.mtime; dirtyRef.current.delete(num); setErr(false); }
      else setErr(true);
      setDirtyN(dirtyRef.current.size);
      setSaving(false);
    }).catch(() => { setErr(true); setSaving(false); });
  }, [slug, deck]);

  const setNote = useCallback((num: number, text: string) => {
    setNotes((m) => ({ ...m, [num]: text }));
    dirtyRef.current.add(num); setDirtyN(dirtyRef.current.size); setErr(false);
    if (timers.current[num]) window.clearTimeout(timers.current[num]);
    timers.current[num] = window.setTimeout(() => flush(num), 700);
  }, [flush]);

  const saveNow = useCallback(() => {
    Object.values(timers.current).forEach((t) => window.clearTimeout(t));
    Array.from(dirtyRef.current).forEach((num) => flush(num));
  }, [flush]);
  // flush any pending edits when the viewer closes (mirrors the manuscript editor)
  useEffect(() => () => {
    Object.values(timers.current).forEach((t) => window.clearTimeout(t));
    Array.from(dirtyRef.current).forEach((num) => flush(num));
  }, [flush]);

  return { notes, setNote, saveNow, saving, dirty: dirtyN > 0, error: err };
}
type DeckNotesState = ReturnType<typeof useDeckNotes>;

// tiny saved/saving/unsaved chip for the speaker-note editors
function NoteSaveDot({ s }: { s: DeckNotesState }) {
  if (s.error) return <span className="inline-flex items-center gap-1 text-[10px] normal-case text-red-500"><AlertTriangle size={11} /> save failed</span>;
  if (s.saving) return <span className="inline-flex items-center gap-1 text-[10px] normal-case text-amber-500"><Loader2 size={10} className="animate-spin" /> saving…</span>;
  if (s.dirty) return <span className="inline-flex items-center gap-1 text-[10px] normal-case text-amber-500"><span className="w-1.5 h-1.5 rounded-full bg-amber-500" /> unsaved</span>;
  return <span className="inline-flex items-center gap-1 text-[10px] normal-case text-emerald-600/80"><Check size={11} /> saved</span>;
}

// Full-screen ALL-NOTES review surface: every slide's number + title + full editable note
// on one scrollable page (same save store as the panel). Click a slide to jump the deck.
function NotesReview({ slides, title, idx, notes, deckNotesName, onGoto, onClose }:
  { slides: DeckSlide[]; title: string; idx: number; notes: DeckNotesState; deckNotesName: string; onGoto: (i: number) => void; onClose: () => void }) {
  const curRef = useRef<HTMLDivElement>(null);
  useEffect(() => { const id = setTimeout(() => curRef.current?.scrollIntoView({ block: "start", behavior: "auto" }), 60); return () => clearTimeout(id); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // the first Escape in a note only stops typing (the arrow engine re-arms it)
      if (e.key !== "Escape" || e.defaultPrevented || typingEscape(e)) return;
      e.preventDefault(); onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return createPortal(
    <div role="dialog" aria-modal="true" aria-label="All speaker notes" data-knav-modal className="fixed inset-0 z-[130] bg-background flex flex-col">
      <div className="flex items-center gap-2 px-4 h-12 border-b border-border shrink-0">
        <button type="button" onClick={onClose} data-knav-back="2" className="inline-flex items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground"><ChevronLeft size={16} /> Back to slides</button>
        <span className="inline-flex items-center gap-1 ml-1 shrink-0 rounded-full border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground"><StickyNote size={11} /> All speaker notes</span>
        <span className="text-[15px] font-medium tracking-tight truncate" style={{ fontFamily: SERIF }}>{title}</span>
        <NoteSaveDot s={notes} />
        <div className="flex-1" />
        <span className="text-[11.5px] text-muted-foreground nums">{slides.length} slides</span>
        <button onClick={onClose} title="Close (Esc)" className="ml-1 inline-flex items-center justify-center w-7 h-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent"><X size={16} /></button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="mx-auto max-w-[900px] px-6 py-6 space-y-5">
          <p className="text-[12px] text-muted-foreground">Edit any slide's speaker note here — changes save to <code className="text-[11px]">{deckNotesName}</code>. Click a slide number to jump the deck to it. The presenter picks up edits when you open it.</p>
          {slides.map((s, i) => (
            <div key={i} ref={i === idx ? curRef : undefined} className={"rounded-xl border px-4 py-3 " + (i === idx ? "border-primary/50 bg-primary/[0.03]" : "border-border bg-card/40")}>
              <div className="flex items-baseline gap-2 mb-2">
                <button onClick={() => onGoto(i)} title="Jump the deck to this slide"
                  className="inline-flex items-center gap-1.5 shrink-0 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:border-primary/60 hover:text-primary transition-colors">
                  <span className="nums font-medium">Slide {i + 1}</span>
                </button>
                <span className="text-[13.5px] font-medium tracking-tight text-foreground/90 truncate" style={{ fontFamily: SERIF }}>{s.noteTitle || ""}</span>
                <div className="flex-1" />
                <button onClick={() => onGoto(i)} className="shrink-0 text-[11px] text-muted-foreground hover:text-primary inline-flex items-center gap-1">Go to slide <ChevronRight size={12} /></button>
              </div>
              <GrowTextarea
                value={notes.notes[i + 1] ?? ""}
                onChange={(v) => notes.setNote(i + 1, v)}
                placeholder="No note yet — type to add one."
                className="w-full text-[14px] leading-relaxed rounded-lg border border-border bg-background px-3 py-2.5 focus:outline-none focus:border-primary/60 min-h-[70px]"
              />
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body
  );
}

function deckPortal(children: React.ReactNode) {
  return createPortal(<div data-deck-root className="fixed inset-0 z-[110] bg-background flex flex-col">{children}</div>, document.body);
}

function fmtClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}

type PresentMsg = { type: string; idx?: number; src?: string; t?: number };

function escHtmlAttr(s: string): string {
  return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function buildAudienceDoc(css: string, slides: DeckSlide[], startIdx: number, title: string, origin: string): string {
  const slideDivs = slides.map((s, i) =>
    "<div class=\"ap-slide" + (i === startIdx ? " on" : "") + "\" data-i=\"" + i + "\">" +
    "<div class=\"frame\"><div class=\"marpit\">" + s.svg + "</div></div></div>").join("");
  // render-only peer: listen on the bus, show the requested slide. No input, no posting.
  const script =
    "(function(){" +
    "var CH=" + JSON.stringify(PRESENT_CHANNEL) + ",KEY=" + JSON.stringify(PRESENT_BUS_KEY) + ";" +
    "var els=[].slice.call(document.querySelectorAll('.ap-slide'));" +
    "function show(i){for(var k=0;k<els.length;k++){els[k].classList.toggle('on',(+els[k].getAttribute('data-i'))===i);}}" +
    "function onMsg(m){if(m&&m.type==='goto'&&typeof m.idx==='number')show(m.idx);}" +
    "try{var bc=new BroadcastChannel(CH);bc.onmessage=function(e){onMsg(e.data);};}catch(e){}" +
    "window.addEventListener('storage',function(e){if(e.key===KEY&&e.newValue){try{onMsg(JSON.parse(e.newValue));}catch(x){}}});" +
    "})();";
  return "<!doctype html><html><head><meta charset=\"utf-8\">" +
    "<base href=\"" + escHtmlAttr(origin) + "/\">" +
    "<title>" + escHtmlAttr(title) + " — audience</title>" +
    "<style>html,body{margin:0;height:100%;background:#000;overflow:hidden}" +
    "#ap-stage{position:fixed;inset:0;display:grid;place-items:center}" +
    ".ap-slide{display:none;width:min(100vw,calc(100vh*16/9))}" +
    ".ap-slide.on{display:block}" +
    ".ap-slide .frame{aspect-ratio:16/9;overflow:hidden;background:#fff;width:100%}" +
    ".marpit{margin:0;padding:0}.ap-slide svg[data-marpit-svg]{display:block;width:100%;height:100%}</style>" +
    "<style>" + css + "</style></head>" +
    "<body><div id=\"ap-stage\">" + slideDivs + "</div>" +
    "<scr" + "ipt>" + script + "</scr" + "ipt></body></html>";
}

function openAudienceWindow(css: string, slides: DeckSlide[], startIdx: number, title: string): Window | null {
  const w = window.open("", "aioa-audience", "width=1280,height=760");
  if (!w) return null;
  try {
    w.document.open();
    w.document.write(buildAudienceDoc(css, slides, startIdx, title, window.location.origin));
    w.document.close();
  } catch { return null; }
  return w;
}

// Toggle the visible slide in an already-open audience window by class (same-origin DOM
// write — the reliable path that never depends on the audience running its own script).
function renderAudienceDom(w: Window | null, idx: number) {
  if (!w || w.closed) return;
  try {
    const els = w.document.querySelectorAll(".ap-slide");
    els.forEach((el) => el.classList.toggle("on", Number(el.getAttribute("data-i")) === idx));
  } catch { /* cross-origin / window gone */ }
}

function PresenterConsole({ css, slides, title, slug, deck, idx, setIdx, onExit }:
  { css: string; slides: DeckSlide[]; title: string; slug: string; deck: string; idx: number; setIdx: (i: number | ((p: number) => number)) => void; onExit: () => void }) {
  const n = slides.length;
  const cur = slides[idx];
  const next = slides[idx + 1];
  const [noteSize, setNoteSize] = usePersistent("aioa-present-note-size", 20);
  const [showNext, setShowNext] = usePersistent("aioa-present-next", true);
  const [start, setStart] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);
  const go = useCallback((d: number) => setIdx((i: number) => Math.max(0, Math.min(n - 1, i + d))), [n, setIdx]);
  const goRef = useRef(go); goRef.current = go;

  const bcRef = useRef<BroadcastChannel | null>(null);
  const idxRef = useRef(idx); idxRef.current = idx;
  const audRef = useRef<Window | null>(null);
  const remoteRef = useRef(false);
  // "popup" = same-browser window we drive directly; "remote" = a top-level page that
  // follows us over /present/state (pop-ups are blocked in the Obsidian pane)
  const [audienceOpen, setAudienceOpen] = useState<false | "popup" | "remote">(false);
  const post = useCallback((m: PresentMsg) => {
    const msg: PresentMsg = { ...m, src: "console" };
    if (bcRef.current) { try { bcRef.current.postMessage(msg); return; } catch { /* fall through */ } }
    try { localStorage.setItem(PRESENT_BUS_KEY, JSON.stringify({ ...msg, t: Date.now() })); } catch { /* quota */ }
  }, []);
  useEffect(() => {
    let bc: BroadcastChannel | null = null;
    try { bc = new BroadcastChannel(PRESENT_CHANNEL); } catch { bc = null; }
    bcRef.current = bc;
    const onMsg = (m: PresentMsg) => {
      if (!m || m.src === "console") return;
      if (m.type === "goto" && typeof m.idx === "number") setIdx(m.idx);
    };
    if (bc) bc.onmessage = (e) => onMsg(e.data as PresentMsg);
    const onStorage = (e: StorageEvent) => { if (e.key === PRESENT_BUS_KEY && e.newValue) { try { onMsg(JSON.parse(e.newValue)); } catch { /* ignore */ } } };
    window.addEventListener("storage", onStorage);
    return () => { window.removeEventListener("storage", onStorage); if (bc) bc.close(); bcRef.current = null; };
  }, [setIdx]);
  const lastMoveRef = useRef(0);
  useEffect(() => {
    lastMoveRef.current = Date.now();
    renderAudienceDom(audRef.current, idx);
    post({ type: "goto", idx });
    api.presentPublish({ slug, deck, idx, active: true, src: "console" });
  }, [idx, post, slug, deck]);
  useEffect(() => {
    let live = true;
    const id = setInterval(async () => {
      try {
        const s = await api.presentState();
        if (!live || !s || s.src !== "audience" || s.deck !== deck) return;
        if (typeof s.ts === "number" && s.ts < lastMoveRef.current) return;
        setIdx((cur) => (typeof s.idx === "number" && s.idx !== cur ? s.idx : cur));
      } catch { /* server briefly away — the console keeps its own slide */ }
    }, 400);
    return () => { live = false; clearInterval(id); };
  }, [deck, setIdx]);
  // when the console closes, mark the presentation over so the remote page shows it ended
  useEffect(() => () => { api.presentPublish({ slug, deck, idx: idxRef.current, active: false }); }, [slug, deck]);

  const openAudience = useCallback(() => {
    if (audRef.current && !audRef.current.closed) { try { audRef.current.focus(); } catch { /* ignore */ } setAudienceOpen("popup"); return; }
    if (remoteRef.current) return;   // a browser window is open or being opened
    const w = openAudienceWindow(css, slides, idxRef.current, title);
    if (!w) {
      remoteRef.current = true;
      api.presentPublish({ slug, deck, idx: idxRef.current, active: true, src: "console" });
      api.presentOpenRemote(slug, deck).then((r) => {
        if (r.error) {
          remoteRef.current = false;
          toast.error("Couldn't open the audience window", { description: "Allow pop-ups for this page, or open the dashboard in a browser to present." });
          setAudienceOpen(false);
        } else {
          toast.success("Audience window opened in your browser", { description: "Share that window over Zoom — click it or this console to advance; they stay in step." });
          setAudienceOpen("remote");
        }
      });
      return;
    }
    // the console owns the audience window's input (single, un-doubled advance path):
    // arrows/space/click advance the shared index; 'f' fullscreens the shared slide.
    try {
      w.addEventListener("keydown", (e: KeyboardEvent) => {
        const k = e.key;
        if (e.defaultPrevented) return;
        const tg = e.target as HTMLElement | null;
        if ((k === "Enter" || k === " ") && tg?.closest?.("button, a[href], input, select, textarea")) return;   // presses the control
        if (k === "ArrowRight" || k === "PageDown" || k === " " || k === "Enter") { e.preventDefault(); goRef.current(1); }
        else if (k === "ArrowLeft" || k === "PageUp" || k === "Backspace") { e.preventDefault(); goRef.current(-1); }
        else if (k === "Home") { e.preventDefault(); setIdx(0); }
        else if (k === "End") { e.preventDefault(); setIdx(n - 1); }
        else if (k === "f" || k === "F") { try { const d = w.document.documentElement; if (!w.document.fullscreenElement) d.requestFullscreen?.(); else w.document.exitFullscreen?.(); } catch { /* blocked */ } }
        else if (k === "Escape") onExit();
      });
      w.document.addEventListener("click", () => goRef.current(1));
    } catch { /* cross-origin (should not happen for a same-origin popup) */ }
    audRef.current = w;
    renderAudienceDom(w, idxRef.current);
    setAudienceOpen("popup");
  }, [css, slides, title, slug, deck, n, setIdx, onExit]);
  const autoOpenedRef = useRef(false);
  useEffect(() => {
    if (autoOpenedRef.current) return;
    autoOpenedRef.current = true;
    openAudience();
  }, [openAudience]);
  useEffect(() => {
    const id = setInterval(() => { if (audRef.current && audRef.current.closed) { audRef.current = null; setAudienceOpen(false); } }, 1000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => () => { try { audRef.current?.close(); } catch { /* ignore */ } audRef.current = null; }, []);

  const consoleRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.isContentEditable);
      if (typing) return;
      // Enter/Space on one of the console's own controls press that control, never advance
      const onControl = !!t && !!consoleRef.current?.contains(t) && !!t.closest("button, a[href], select");
      if (e.key === "Escape") { e.preventDefault(); onExit(); }
      else if ((e.key === "Enter" || e.key === " ") && onControl) return;
      else if (e.key === "ArrowRight" || e.key === "PageDown" || e.key === " " || e.key === "Enter") { e.preventDefault(); go(1); }
      else if (e.key === "ArrowLeft" || e.key === "PageUp" || e.key === "Backspace") { e.preventDefault(); go(-1); }
      else if (e.key === "Home") { e.preventDefault(); setIdx(0); }
      else if (e.key === "End") { e.preventDefault(); setIdx(n - 1); }
      else if (e.key.toLowerCase() === "p") setShowNext((v) => !v);
      else if (e.key === "+" || e.key === "=") setNoteSize((s) => Math.min(40, s + 1));
      else if (e.key === "-" || e.key === "_") setNoteSize((s) => Math.max(13, s - 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, onExit, n, setIdx, setShowNext, setNoteSize]);

  const clock = new Date(now).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const elapsed = fmtClock(now - start);
  return createPortal(
    // the console owns the arrows (they turn slides mid-talk, whatever holds focus)
    <div ref={consoleRef} role="dialog" aria-modal="true" aria-label="Presenter console" data-knav-modal data-knav-own="arrows" className="fixed inset-0 z-[140] bg-black text-white flex flex-col select-none">
      <div className="flex items-center gap-2 px-4 h-11 shrink-0 bg-white/[0.06] text-[12.5px]">
        <span className="font-medium truncate" style={{ fontFamily: SERIF }}>{title}</span>
        <span className="text-white/55 nums shrink-0">{idx + 1} / {n}</span>
        <div className="flex-1" />
        <span className="text-white/60 nums shrink-0" title="Time of day">{clock}</span>
        <span className="inline-flex items-center gap-1 text-white/80 nums shrink-0" title="Elapsed since you started"><Clock size={13} /> {elapsed}</span>
        <button onClick={() => setStart(Date.now())} className="text-white/45 hover:text-white shrink-0 w-6 h-6 grid place-items-center rounded hover:bg-white/10" title="Reset the elapsed timer"><RotateCcw size={13} /></button>
        <span className="w-px h-4 bg-white/15 shrink-0" />
        <span className="inline-flex items-center gap-0.5 shrink-0" title="Speaker-note text size">
          <button onClick={() => setNoteSize((s) => Math.max(13, s - 1))} className="text-white/60 hover:text-white w-6 h-6 grid place-items-center rounded hover:bg-white/10" title="Smaller note text (-)"><Minus size={13} /></button>
          <Type size={12} className="text-white/40" />
          <button onClick={() => setNoteSize((s) => Math.min(40, s + 1))} className="text-white/60 hover:text-white w-6 h-6 grid place-items-center rounded hover:bg-white/10" title="Bigger note text (+)"><Plus size={13} /></button>
        </span>
        <button onClick={() => setShowNext((v) => !v)} className={"shrink-0 w-6 h-6 grid place-items-center rounded hover:bg-white/10 " + (showNext ? "text-white" : "text-white/40")} title="Toggle the next-slide preview (p)"><Presentation size={14} /></button>
        <span className="w-px h-4 bg-white/15 shrink-0" />
        <button onClick={openAudience} className={"inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[12px] shrink-0 transition-colors " + (audienceOpen ? "border-emerald-400/40 text-emerald-200" : "border-white/25 text-white/85 hover:border-white/50")} title="Open the clean, chrome-free audience window to share over Zoom">
          <Monitor size={14} /> {audienceOpen === "remote" ? "Audience in browser" : audienceOpen ? "Audience open" : "Open audience view"}
        </button>
        <button type="button" onClick={onExit} data-knav-back="2" className="text-white/60 hover:text-white inline-flex items-center gap-1 shrink-0" title="Exit (Esc)"><Minimize2 size={14} /> Exit</button>
      </div>
      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-w-0 flex flex-col min-h-0">
          <div className="px-5 pt-3 pb-1 shrink-0 text-[10px] uppercase tracking-wide text-white/40 flex items-center gap-1"><StickyNote size={12} /> Speaker note &mdash; slide {idx + 1}</div>
          <div className="flex-1 min-h-0 overflow-y-auto px-5 pb-6">
            {cur?.note
              ? <div className="text-white/90 whitespace-pre-wrap" style={{ fontSize: noteSize, lineHeight: 1.55 }}>{cur.note}</div>
              : <div className="text-white/35 italic" style={{ fontSize: noteSize }}>No speaker note for this slide.</div>}
          </div>
        </div>
        <div className="w-[360px] shrink-0 border-l border-white/10 flex flex-col min-h-0 p-3 gap-3">
          <div className="shrink-0">
            <div className="text-[10px] uppercase tracking-wide text-white/40 mb-1 flex items-center justify-between"><span>On screen now</span><span className="nums text-white/30">{idx + 1} / {n}</span></div>
            <div className="rounded overflow-hidden border border-white/15 bg-white" style={{ aspectRatio: "16 / 9" }}>
              <MarpSurface css={css} html={cur?.svg || ""} style={{ width: "100%", height: "100%" }} />
            </div>
          </div>
          {showNext && (
            <div className="shrink-0">
              <div className="text-[10px] uppercase tracking-wide text-white/40 mb-1">Next</div>
              {next
                ? <button onClick={() => go(1)} className="block w-full rounded overflow-hidden border border-white/15 bg-white" style={{ aspectRatio: "16 / 9" }}>
                    <MarpSurface css={css} html={next.svg} style={{ width: "100%", height: "100%" }} />
                  </button>
                : <div className="rounded border border-white/10 grid place-items-center text-white/40 text-[12px]" style={{ aspectRatio: "16 / 9" }}>End of deck</div>}
            </div>
          )}
          <div className="mt-auto shrink-0 flex items-center gap-2">
            <button onClick={() => go(-1)} disabled={idx === 0} className="flex-1 h-9 grid place-items-center rounded-md border border-white/15 disabled:opacity-30 hover:border-white/40 transition-colors" title="Previous (Left)"><ChevronLeft size={18} /></button>
            <button onClick={() => go(1)} disabled={idx >= n - 1} className="flex-1 h-9 grid place-items-center rounded-md border border-white/15 disabled:opacity-30 hover:border-white/40 transition-colors" title="Next (Right / Space)"><ChevronRight size={18} /></button>
          </div>
        </div>
      </div>
      <div className="shrink-0 h-1 bg-white/10"><div className="h-full bg-white/55 transition-all" style={{ width: ((idx + 1) / n * 100) + "%" }} /></div>
    </div>,
    document.body
  );
}

function DeckViewer({ data, reloading, onReload, onExit }: { data: DraftDeck; reloading: boolean; onReload: () => void; onExit: () => void }) {
  const { slug, deck, css, slides, title, deckRel } = data;
  const n = slides.length;
  const [idx, setIdx] = useState(0);
  const [present, setPresent] = useState(false);
  const [allNotes, setAllNotes] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [showPanel, setShowPanel] = usePersistent("aioa-deck-panel", true);
  // stable — the presenter console keys callbacks off it, and a fresh arrow each render
  // is what made its audience-open effect re-fire in a loop
  const exitPresent = useCallback(() => setPresent(false), []);
  const review = useDeckReview(slug, deck, data.review, title);
  const notesState = useDeckNotes(slug, deck, slides, data.notesMtime || 0);
  // the presenter reads the LIVE edited notes (not just what was on disk at render time)
  const mergedSlides = useMemo(() => slides.map((s, i) => ({ ...s, note: notesState.notes[i + 1] ?? s.note })), [slides, notesState.notes]);
  const deckNotesName = (data.notesRel || "").split("/").pop() || "the notes file";
  useEffect(() => { setIdx((i) => Math.max(0, Math.min(n - 1, i))); }, [n]);
  const go = useCallback((d: number) => setIdx((i) => Math.max(0, Math.min(n - 1, i + d))), [n]);
  const vaultRoot = useVaultRoot();
  const copyDeckPath = useCallback(async () => {
    if (!vaultRoot) { toast.error("Couldn't resolve the vault path"); return; }
    const sys = vaultRoot + "/" + deckRel;
    (await copyPlain(sys)) ? toast.success("Slides path copied") : toast.error("Couldn't copy the path");
  }, [vaultRoot, deckRel]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (present || allNotes || versionsOpen) return;   // the presenter / all-notes / versions overlays own the keyboard
      if (e.defaultPrevented) return;
      const t = e.target as HTMLElement;
      const typing = !!t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.isContentEditable);
      if (e.key === "Escape") { if (typingEscape(e)) return; e.preventDefault(); onExit(); return; }
      if (typing) return;
      // ←/→ turn the slide from the slide itself (or before focus has entered the viewer);
      // on the toolbar, thumbnails and comment panel the arrows walk those controls
      const onControl = !!t && t !== document.body && !!t.closest?.("[data-deck-root]") && !t.closest("[data-deck-stage]");
      if (onControl && /^(ArrowLeft|ArrowRight| )$/.test(e.key)) return;
      if (e.key === "ArrowRight" || e.key === "PageDown" || e.key === " ") { e.preventDefault(); go(1); }
      else if (e.key === "ArrowLeft" || e.key === "PageUp") { e.preventDefault(); go(-1); }
      else if (e.key === "Home") setIdx(0);
      else if (e.key === "End") setIdx(n - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, onExit, n, present, allNotes, versionsOpen]);
  const cur = slides[idx];
  const comment = review.map.get(idx + 1) || "";
  const commented = review.map.size;
  return deckPortal(
    <>
      <div className="flex items-center gap-2 px-4 h-12 border-b border-border shrink-0">
        <button type="button" onClick={onExit} data-knav-back className="inline-flex items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground"><ChevronLeft size={16} /> Drafting</button>
        <span className="inline-flex items-center gap-1 ml-1 shrink-0 rounded-full border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground"><Presentation size={11} /> Slides</span>
        <button onClick={copyDeckPath} title="Copy the system path to the deck"
          className="text-[15px] font-medium tracking-tight truncate text-left hover:text-primary transition-colors cursor-pointer" style={{ fontFamily: SERIF }}>{title}</button>
        <span className="text-[12px] text-muted-foreground nums ml-1 shrink-0">{idx + 1} / {n}</span>
        {commented > 0 && <span className="hidden sm:inline-flex items-center gap-1 text-[11.5px] text-muted-foreground shrink-0"><MessageSquare size={11} /> {commented} commented</span>}
        <div className="flex-1" />
        <IconBtn onClick={() => { review.save(true); onReload(); }} title="Re-render (after editing the deck in Marp)">{reloading ? <Loader2 size={15} className="animate-spin" /> : <RotateCw size={15} />}</IconBtn>
        <IconBtn onClick={() => setShowPanel((v) => !v)} title="Toggle notes & comments" on={showPanel}><MessageSquareText size={15} /></IconBtn>
        <IconBtn onClick={() => api.open(deckRel)} title="Open the deck in Obsidian"><ExternalLink size={15} /></IconBtn>
        <button onClick={() => setVersionsOpen(true)} title="Versions — every earlier state of this deck, newest first; diff any two, restore one"
          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] transition-colors ${versionsOpen ? "border-primary/50 text-foreground bg-primary/10" : "border-border text-muted-foreground hover:text-foreground hover:border-primary/50"}`}><History size={13} /> Versions</button>
        <button onClick={() => setPresent(true)}
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-[12.5px] font-medium hover:border-primary/60 hover:text-primary transition-colors"
          title="Present — opens the note-heavy console and a clean audience window to share over Zoom (→/space to advance, Esc to exit)"><Projector size={14} /> Present</button>
      </div>
      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="flex-1 min-h-0 flex items-center justify-center gap-3 px-3 py-4 bg-muted/30">
            <button onClick={() => go(-1)} disabled={idx === 0} className="shrink-0 h-10 w-10 grid place-items-center rounded-full border border-border bg-card disabled:opacity-30 hover:border-primary/50 transition-colors"><ChevronLeft size={20} /></button>
            <div className="flex-1 min-w-0 h-full grid place-items-center">
              <div style={{ width: "100%", maxWidth: "calc((100vh - 230px) * 16 / 9)" }}>
                <div data-deck-stage data-knav-item tabIndex={0} aria-label={`Slide ${idx + 1} of ${n}`} style={{ aspectRatio: "16 / 9", boxShadow: "0 4px 24px rgba(0,0,0,.14)", borderRadius: 6, overflow: "hidden", background: "#fff" }}>
                  <MarpSurface css={css} html={cur?.svg || ""} style={{ width: "100%", height: "100%" }} />
                </div>
              </div>
            </div>
            <button onClick={() => go(1)} disabled={idx >= n - 1} className="shrink-0 h-10 w-10 grid place-items-center rounded-full border border-border bg-card disabled:opacity-30 hover:border-primary/50 transition-colors"><ChevronRight size={20} /></button>
          </div>
          <div className="shrink-0 border-t border-border px-3 py-1.5 bg-card/40">
            <MarpThumbs css={css} slides={slides} current={idx} onPick={setIdx} />
          </div>
        </div>
        {showPanel && (
          <div className="w-[360px] shrink-0 border-l border-border flex flex-col min-h-0 bg-card/30">
            <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
              <div>
                <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground mb-1.5">
                  <StickyNote size={12} /> <span>Speaker note</span>
                  <NoteSaveDot s={notesState} />
                  <div className="flex-1" />
                  <button onClick={() => setAllNotes(true)} title="Expand — read and edit every slide's notes on one surface"
                    className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] normal-case text-muted-foreground hover:text-foreground hover:bg-accent"><Maximize2 size={11} /> All notes</button>
                </div>
                <GrowTextarea
                  value={notesState.notes[idx + 1] ?? ""}
                  onChange={(v) => notesState.setNote(idx + 1, v)}
                  placeholder="Speaker note for this slide — type to add or edit it; saves to the deck's notes file."
                  className="w-full text-[13px] leading-relaxed rounded-lg border border-border bg-background px-3 py-2.5 focus:outline-none focus:border-primary/60 min-h-[120px]"
                />
                <p className="mt-1.5 text-[11px] text-muted-foreground/70">Saves to <code className="text-[10.5px]">{deckNotesName}</code> — the presenter picks up edits when you open it.</p>
              </div>
              <div>
                <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground mb-1.5"><MessageSquare size={12} /> Comments — slide {idx + 1}</div>
                <GrowTextarea
                  value={comment}
                  onChange={(v) => review.setComment(idx + 1, v)}
                  placeholder="What would make this slide better? Notes save to the deck's review file."
                  className="w-full text-[13px] leading-relaxed rounded-lg border border-border bg-background px-3 py-2.5 focus:outline-none focus:border-primary/60 min-h-[120px]"
                />
                <p className="mt-1.5 text-[11px] text-muted-foreground/70">Saved to <code className="text-[10.5px]">{deck.replace(/\.md$/, "")}.review.md</code> beside the deck — never written into the slides.</p>
              </div>
            </div>
          </div>
        )}
      </div>
      {present && <PresenterConsole css={css} slides={mergedSlides} title={title} slug={slug} deck={deck} idx={idx} setIdx={setIdx} onExit={exitPresent} />}
      {versionsOpen && <VersionsPanel slug={slug} docName={"deck:" + deck} title={title}
        getMtime={() => data.deckMtime} flush={async () => { /* the deck is edited on disk, not here */ }}
        onRestored={() => { setVersionsOpen(false); onReload(); }}
        onClose={() => setVersionsOpen(false)} />}
      {allNotes && <NotesReview slides={slides} title={title} idx={idx} notes={notesState} deckNotesName={deckNotesName} onGoto={(i) => { setIdx(i); setAllNotes(false); }} onClose={() => setAllNotes(false)} />}
    </>
  );
}

function DeckViewerLoader({ slug, deck, onExit }: { slug: string; deck: string; onExit: () => void }) {
  const [data, setData] = useState<DraftDeck | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(() => {
    setLoading(true);
    api.draftingDeck(slug, deck)
      .then((d) => { if (d.error) { setErr(d.error); } else { setData(d); setErr(null); preloadDeckImages(d.slides); } })
      .catch(() => setErr("could not render the deck"))
      .finally(() => setLoading(false));
  }, [slug, deck]);
  useEffect(() => { load(); }, [load]);
  if (!data && loading) return deckPortal(<div className="flex-1 grid place-items-center text-[13px] text-muted-foreground"><div className="flex items-center gap-2"><Loader2 size={16} className="animate-spin" /> Rendering “{deck}”…</div></div>);
  if (!data) return deckPortal(
    <div className="flex-1 grid place-items-center">
      <div className="text-center max-w-md px-6">
        <AlertTriangle size={26} className="mx-auto text-muted-foreground/50 mb-3" />
        <p className="text-[14px] text-foreground">Couldn't render this deck.</p>
        <p className="text-[12.5px] text-muted-foreground mt-1">{err}</p>
        <button type="button" onClick={onExit} data-knav-back className="mt-4 text-[13px] text-primary hover:underline">← Back to Drafting</button>
      </div>
    </div>
  );
  return <DeckViewer key={slug + ":" + deck} data={data} reloading={loading} onReload={load} onExit={onExit} />;
}

type LibType = "paper" | "deck" | "report" | "measure" | "grant" | "syllabus";
type NewProjectKind = "paper" | "grant" | "brief" | "report" | "letter";
const NEW_PROJECT_KINDS: { id: NewProjectKind; label: string; icon: typeof FileText; idea: string; hint: string }[] = [
  { id: "paper", label: "Paper", icon: FileText,
    idea: "The core idea — the specific tension, in a sentence or two (you can refine it in the planning workspace)…",
    hint: "papers/" + PROJECT_PREFIX + "<title>/ with README.md + logs/" },
  { id: "grant", label: "Grant", icon: ScrollText,
    idea: "The core objective — the problem and what the funded work would do (the funder rules get captured by the grant setup)…",
    hint: "grants/" + PROJECT_PREFIX + "<title>/ with README.md + rules/ + corpus/ + logs/" },
  { id: "brief", label: "Brief", icon: FileBarChart2,
    idea: "The dataset and the question — the few things this brief should show, in a sentence or two…",
    hint: "briefs/<title>/ with README.md + writing/report.md + logs/ (charts-first)" },
  { id: "report", label: "Report", icon: Newspaper,
    idea: "The argument and the audience — what this long-read makes the case for, in a sentence or two…",
    hint: "briefs/<title>/ with README.md + writing/report.md + logs/ (prose-first long-read)" },
  { id: "letter", label: "Letter", icon: Mail,
    idea: "Who it is for and what for — the program, the deadline, how it is submitted…",
    hint: "letters/<title>/ with README.md + writing/letter.md + logs/" },
];
type LibStatus = DraftStatus;
const STATUS_TITLE: Record<LibStatus, string> = { idea: "Idea", draft: "Drafting", under_review: "Review", published: "Published" };
const STATUS_ICON: Record<LibStatus, typeof Clock> = { idea: Lightbulb, draft: Clock, under_review: Send, published: CircleCheck };

function StatusSelect({ status, onChange }: { status: LibStatus; onChange: (s: LibStatus) => void }) {
  return (
    <select
      value={status}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => { e.stopPropagation(); onChange(e.target.value as LibStatus); }}
      title="Stage — Idea, Drafting, Review, Published"
      className="shrink-0 rounded-full border border-border bg-background px-2 py-0.5 text-[10.5px] text-muted-foreground hover:text-foreground hover:border-primary/50 focus:outline-none focus:border-primary/60 cursor-pointer"
    >
      <option value="idea">Idea</option>
      <option value="draft">Drafting</option>
      <option value="under_review">Review</option>
      <option value="published">Published</option>
    </select>
  );
}

function FilterChip({ active, onClick, icon: Icon, label, count }: { active: boolean; onClick: () => void; icon: typeof FileText; label: string; count: number }) {
  return (
    // below 1400px the chips shed padding and their icon so the row stays on one line
    <button type="button" onClick={onClick} className={`inline-flex items-center gap-1 min-[1400px]:gap-1.5 rounded-full border px-2.5 min-[1400px]:px-3 py-1.5 text-[12px] min-[1400px]:text-[12.5px] transition-colors ${active ? "border-primary/60 bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:text-foreground hover:border-primary/50"}`}>
      <Icon size={13} className="hidden min-[1400px]:block" />{label}
      {count > 0 && <span className="nums text-[10.5px] text-muted-foreground/70">{count}</span>}
    </button>
  );
}

// A clickable card whose outer element is a div (not a button) so it can host a
// real <select> — a <select>/<button> can't legally nest inside a <button>.
function cardA11y(onOpen: () => void, id?: string) {
  return {
    role: "button" as const, tabIndex: 0, onClick: onOpen,
    // Escape out of the item it opens brings focus back to this card
    "data-knav-id": id,
    onKeyDown: (e: React.KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } },
  };
}
const CARD_CLS = "group text-left rounded-xl border border-border bg-card/60 hover:bg-card hover:border-primary/50 px-4 py-3.5 transition-colors cursor-pointer";
const TITLE_CLS = "text-[16px] font-medium tracking-tight text-foreground group-hover:text-primary transition-colors line-clamp-2 break-words min-w-0";
const TITLE_STYLE = { fontFamily: SERIF };
// a library row lays out by its widget's width: under 600px the actions drop below the title
function useRowNarrow() {
  const w = useWidget();
  return !!w && (w.size === "xs" || w.size === "sm");
}
// a tile's arrow stops are its rows and their status; its buttons open with the focused view
function useRowKeys() {
  const w = useWidget();
  return { narrow: useRowNarrow(), focused: !!w?.focused, skip: w && !w.focused ? "" : undefined };
}
// a focused row carries its links beside its tools, every button right of the row's centre,
// so ← from a row rises out of the list instead of landing on the next row's buttons
function RowActions({ narrow, focused, links, tools, age, status }: { narrow: boolean; focused: boolean; links?: ReactNode; tools?: ReactNode; age: ReactNode; status: ReactNode }) {
  if (focused && narrow) return <>{age}{status}{tools}{links}</>;
  return <>{focused && links}{tools}{age}{status}</>;
}
const rowHeadCls = (narrow: boolean) => (narrow ? "flex flex-col items-stretch gap-1.5" : "flex items-baseline justify-between gap-3");
const rowActsCls = (narrow: boolean, gap = "gap-2") => `flex items-center ${gap} shrink-0${narrow ? " justify-end" : ""}`;
const META_CLS = "mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11.5px] text-muted-foreground";

function PaperRow({ p, onOpen, onStatus, onPin, onArchive }: { p: DraftingPaper; onOpen: () => void; onStatus: (s: LibStatus) => void; onPin: (pinned: boolean) => void; onArchive: (mode: "stalled" | "complete") => void }) {
  const { narrow, focused, skip } = useRowKeys();
  const [archOpen, setArchOpen] = useState(false);
  const pdf = p.pdf ? (
    <button data-knav-skip={skip}
      onClick={async (e) => { e.stopPropagation(); const res = await api.draftingOpenPdf(p.slug, p.doc); if (!res.ok) toast.error(res.error || "Couldn't open the PDF"); }}
      title={"Open the compiled PDF" + (p.pdfMtime ? " — built " + relAgo(p.pdfMtime) : "")}
      className="inline-flex items-center gap-1 text-[11.5px] text-primary hover:underline underline-offset-2"
    ><FileText size={11} /> PDF</button>
  ) : null;
  const tools = (
    <>
      <button data-knav-skip={skip} onClick={(e) => { e.stopPropagation(); onPin(!p.pinned); }}
        title={p.pinned ? "Unpin — back to the normal groups" : "Pin — keep this on top while you work on it"}
        className={`inline-flex items-center justify-center w-6 h-6 rounded-md transition-all ${p.pinned ? "text-primary" : "text-muted-foreground/50 opacity-0 group-hover/card:opacity-100 group-data-[focused]/widget:opacity-100 hover:text-foreground"}`}>
        <Star size={13} fill={p.pinned ? "currentColor" : "none"} />
      </button>
      <span className="relative">
        <button data-knav-skip={skip} onClick={(e) => { e.stopPropagation(); setArchOpen((o) => !o); }}
          title="Pause or archive this project (moves the folder to papers/archive/)"
          className="inline-flex items-center justify-center w-6 h-6 rounded-md text-muted-foreground/50 opacity-0 group-hover/card:opacity-100 group-data-[focused]/widget:opacity-100 hover:text-foreground transition-all">
          <FolderDown size={13} />
        </button>
        {archOpen && (
          <span className="absolute right-0 top-7 z-30 w-[210px] rounded-lg border border-border bg-card shadow-xl py-1" onMouseLeave={() => setArchOpen(false)}>
            <button onClick={(e) => { e.stopPropagation(); setArchOpen(false); onArchive("stalled"); }} className="flex items-center gap-2 w-full text-left px-3 py-1.5 text-[12px] text-muted-foreground hover:text-foreground hover:bg-accent"><Clock size={12} /> Pause — stalled</button>
            <button onClick={(e) => { e.stopPropagation(); setArchOpen(false); onArchive("complete"); }} className="flex items-center gap-2 w-full text-left px-3 py-1.5 text-[12px] text-muted-foreground hover:text-foreground hover:bg-accent"><CircleCheck size={12} /> Archive — complete</button>
          </span>
        )}
      </span>
    </>
  );
  return (
    <>
    <div {...cardA11y(onOpen, `paper:${p.slug}:${p.doc}`)} data-obsidian-file={p.paperRel || undefined} className={CARD_CLS + " group/card"}>
      <div className={rowHeadCls(narrow)}>
        <span className="flex items-baseline gap-2 min-w-0">
          <span className="inline-flex items-center gap-1 shrink-0 self-center rounded-full border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground"><KindIcon kind={p.kind} size={11} />{p.label}</span>
          <span className={TITLE_CLS} style={TITLE_STYLE}>{p.title}</span>
        </span>
        <span className={rowActsCls(narrow, "gap-1.5")}>
          <RowActions narrow={narrow} focused={focused} links={pdf} tools={tools}
            age={<span className="text-[11.5px] text-muted-foreground nums">{relAgo(p.paperMtime)}</span>}
            status={<StatusSelect status={p.status} onChange={onStatus} />} />
        </span>
      </div>
      <div className={META_CLS}>
        <span className="nums">{p.words.toLocaleString()} words</span>
        {(p.prevWords ?? 0) > 0 && <span className="nums" title="writing/previous-draft.md">previous draft {p.prevWords!.toLocaleString()}</span>}
        {p.kind === "project" ?<span className="inline-flex items-center gap-1"><Compass size={11} /> planning — opens the README</span> : <span>{formatLabel(p.publish)}</span>}
        {p.kind === "project" && (p.resultsCount ?? 0) > 0 && <span className="inline-flex items-center gap-1 text-primary" title="Figures/tables already produced in results/ — open the card and use Results to browse them"><FlaskConical size={11} /> {p.resultsCount} result{p.resultsCount === 1 ? "" : "s"}</span>}
        {p.hasEditor && <span className="inline-flex items-center gap-1"><MessageSquareText size={11} /> planning started</span>}
        <GrantMeta p={p} />
        {!focused && pdf}
      </div>
    </div>
    {/* a sibling, not a child: the dialog's clicks and Enter must never reach the card */}
    </>
  );
}

function GrantMeta({ p }: { p: DraftingPaper }) {
  const cap = p.maxPages ?? null;
  const pages = p.pages ?? null;
  const over = cap != null && pages != null && pages > cap;
  const atCap = cap != null && pages != null && pages === cap;

  let due: { text: string; late: boolean; tip: string } | null = null;
  if (p.deadlineDone) {
    due = { text: "submitted", late: false, tip: "The application deadline is marked completed in compliance.json" };
  } else if (p.deadlineUnknown) {
    due = { text: "deadline not published", late: false, tip: p.deadlineRaw || "The funder has not published a date" };
  } else if (p.deadline) {
    const d = new Date(p.deadline);
    const days = Math.round((d.getTime() - Date.now()) / 86_400_000);
    const when = days === 0 ? "today" : days === 1 ? "tomorrow" : days > 0 ? `in ${days} days`
      : days === -1 ? "yesterday" : `${-days} days ago`;
    due = { text: `due ${when}`, late: days < 0,
            tip: d.toLocaleString([], { weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" }) };
  }

  return (
    <>
      {due && (
        <span className={`inline-flex items-center gap-1 ${due.late ? "text-destructive" : ""}`} title={due.tip}>
          <CalendarClock size={11} /> {due.text}
        </span>
      )}
      {cap != null && (
        <span className={`inline-flex items-center gap-1 nums ${over ? "text-destructive" : ""}`}
          title={pages == null
            ? `The funder allows ${cap} pages. No compiled PDF yet, so there is nothing to measure.`
            : `${pages} of ${cap} pages${over ? " — over the funder's cap" : atCap ? " — at the cap" : ""}. Counted from the compiled PDF, so it is as fresh as the PDF beside it.`}>
          <FileText size={11} /> {pages == null ? `${cap} pages allowed` : `${pages} of ${cap} pages`}
        </span>
      )}
      {cap == null && p.maxChars != null && (
        <span className="inline-flex items-center gap-1 nums" title={`The funder's limit for this component is ${p.maxChars.toLocaleString()} characters`}>
          <FileText size={11} /> {p.maxChars.toLocaleString()} chars allowed
        </span>
      )}
    </>
  );
}

function DeckRow({ p, onOpen, onStatus }: { p: DraftPresentation; onOpen: () => void; onStatus: (s: LibStatus) => void }) {
  const narrow = useRowNarrow();
  return (
    <div {...cardA11y(onOpen, `deck:${p.slug}:${p.deck}`)} className={CARD_CLS}>
      <div className={rowHeadCls(narrow)}>
        <span className="flex items-baseline gap-2 min-w-0">
          <span className="inline-flex items-center gap-1 shrink-0 self-center rounded-full border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground"><Presentation size={11} /> Slides</span>
          <span className={TITLE_CLS} style={TITLE_STYLE}>{p.title}</span>
        </span>
        <span className={rowActsCls(narrow)}>
          <span className="text-[11.5px] text-muted-foreground nums">{relAgo(p.deckMtime)}</span>
          <StatusSelect status={p.status} onChange={onStatus} />
        </span>
      </div>
      <div className={META_CLS}>
        <span className="nums">{p.slides} slides</span>
        <span className="truncate">{p.slug}</span>
        {p.hasNotes && <span className="inline-flex items-center gap-1"><StickyNote size={11} /> speaker notes</span>}
        {p.hasReview && <span className="inline-flex items-center gap-1"><MessageSquare size={11} /> commented</span>}
      </div>
    </div>
  );
}

function ReportRow({ r, onOpen, onStatus }: { r: DraftReport; onOpen: () => void; onStatus: (s: LibStatus) => void }) {
  const { narrow, focused, skip } = useRowKeys();
  const live = r.previewUrl && r.slug ? (
    <button data-knav-skip={skip}
      onClick={async (e) => { e.stopPropagation(); const res = await api.draftingOpenPreview(r.slug!, r.doc || "report.md"); if (!res.ok) toast.error(res.error || "Couldn't open the live page"); }}
      title={"Open the live page in your browser — " + r.previewUrl}
      className="inline-flex items-center gap-1 text-[11.5px] text-primary hover:underline underline-offset-2"
    ><Globe size={11} /> live page</button>
  ) : null;
  const pdf = r.pdf && r.slug ? (
    <button data-knav-skip={skip}
      onClick={async (e) => { e.stopPropagation(); const res = await api.draftingOpenPdf(r.slug!, r.doc || "report.md"); if (!res.ok) toast.error(res.error || "Couldn't open the PDF"); }}
      title="Open the compiled PDF"
      className="inline-flex items-center gap-1 text-[11.5px] text-primary hover:underline underline-offset-2"
    ><FileText size={11} /> PDF</button>
  ) : null;
  return (
    <div {...cardA11y(onOpen, `report:${r.id}`)} className={CARD_CLS}>
      <div className={rowHeadCls(narrow)}>
        <span className="flex items-baseline gap-2 min-w-0">
          <span className="inline-flex items-center gap-1 shrink-0 self-center rounded-full border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">{r.doc === "letter.md" ? <><Mail size={11} /> Letter</> : <><FileBarChart2 size={11} /> Report</>}</span>
          <span className={TITLE_CLS} style={TITLE_STYLE}>{r.title}</span>
        </span>
        <span className={rowActsCls(narrow)}>
          <RowActions narrow={narrow} focused={focused} links={<>{live}{pdf}</>}
            age={<span className="text-[11.5px] text-muted-foreground nums">{relAgo(r.mtime)}</span>}
            status={<StatusSelect status={r.status} onChange={onStatus} />} />
        </span>
      </div>
      <div className={META_CLS}>
        {r.render === "html"
          ? <span className="inline-flex items-center gap-1"><ExternalLink size={11} /> opens in your browser</span>
          : <span className="nums">{r.words.toLocaleString()} words</span>}
        {r.render === "edit" && <span className="inline-flex items-center gap-1"><MessageSquareText size={11} /> drafts in the editor</span>}
        {!focused && live}
        {!focused && pdf}
      </div>
    </div>
  );
}

function MeasureRow({ m, onOpen, onStatus }: { m: DraftMeasure; onOpen: () => void; onStatus: (s: LibStatus) => void }) {
  const narrow = useRowNarrow();
  return (
    <div {...cardA11y(onOpen, `measure:${m.id}`)} className={CARD_CLS}>
      <div className={rowHeadCls(narrow)}>
        <span className="flex items-baseline gap-2 min-w-0">
          <span className="inline-flex items-center gap-1 shrink-0 self-center rounded-full border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground"><Feather size={11} />{m.category}</span>
          <span className={TITLE_CLS} style={TITLE_STYLE}>{m.title}</span>
        </span>
        <span className={rowActsCls(narrow)}>
          <span className="text-[11.5px] text-muted-foreground nums">{relAgo(m.mtime)}</span>
          <StatusSelect status={m.status} onChange={onStatus} />
        </span>
      </div>
      <div className={META_CLS}>
        <span className="uppercase">{m.ext}</span>
        {m.ext === "md" && <span className="inline-flex items-center gap-1"><SquarePen size={11} /> editable</span>}
        {m.ext === "docx" && <span className="inline-flex items-center gap-1"><Eye size={11} /> preview — opens in Word to edit</span>}
      </div>
    </div>
  );
}

function SyllabusRow({ s, onOpen, onStatus }: { s: DraftSyllabus; onOpen: () => void; onStatus: (st: LibStatus) => void }) {
  const narrow = useRowNarrow();
  // under ~1000px of widget the subtitle takes its own line, so the title keeps the head row
  const rowW = useWidget()?.width ?? 1200;
  const inline = !narrow && rowW >= 1000;
  const pdfStale = s.hasPdf && s.pdfMtime > 0 && s.pdfMtime < s.mtime;
  return (
    <div {...cardA11y(onOpen, `syllabus:${s.id}`)} className={CARD_CLS}>
      <div className={rowHeadCls(narrow)}>
        <span className="flex items-baseline gap-2 min-w-0">
          {s.kind === "syllabus"
            ? <span className="inline-flex items-center gap-1 shrink-0 self-center rounded-full border border-primary/40 text-primary px-1.5 py-0.5 text-[10px]"><GraduationCap size={11} /> Syllabus</span>
            : <span className="inline-flex items-center gap-1 shrink-0 self-center rounded-full border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground"><BookMarked size={11} /> Reading list</span>}
          <span className={TITLE_CLS} style={TITLE_STYLE}>{s.title}</span>
          {s.subtitle && inline && <span className="truncate min-w-0 text-[12px] text-muted-foreground/80">{s.subtitle}</span>}
        </span>
        <span className={rowActsCls(narrow)}>
          <span className="text-[11.5px] text-muted-foreground nums">{relAgo(s.mtime)}</span>
          <StatusSelect status={s.status} onChange={onStatus} />
        </span>
      </div>
      {s.subtitle && !inline && <div className="mt-0.5 truncate text-[12px] text-muted-foreground/80" title={s.subtitle}>{s.subtitle}</div>}
      <div className={META_CLS}>
        {(s.course || s.program) && <span className="truncate max-w-[260px]">{s.course || s.program}{s.term ? ` · ${s.term}` : ""}</span>}
        <span className="nums">{s.readings.toLocaleString()} readings</span>
        {s.hasPdf
          ? <span className={"inline-flex items-center gap-1 " + (pdfStale ? "text-warning" : "")} title={pdfStale ? "PDF is older than the source — re-render" : "Rendered PDF up to date"}><FileOutput size={11} /> PDF{pdfStale ? " (stale)" : ""}</span>
          : <span className="inline-flex items-center gap-1 opacity-70"><FileOutput size={11} /> not rendered</span>}
        <span className="inline-flex items-center gap-1"><SquarePen size={11} /> editable</span>
      </div>
    </div>
  );
}

function LibrarySection({ status, papers, decks, reports, measures, grants, syllabi, onOpen, onOpenDeck, onOpenReport, onOpenMeasure, onOpenSyllabus, onStatusChange, onPin, onArchive, onArchiveGrant }: {
  status: LibStatus;
  papers: DraftingPaper[]; decks: DraftPresentation[]; reports: DraftReport[]; measures: DraftMeasure[]; grants: DraftingPaper[]; syllabi: DraftSyllabus[];
  onOpen: (slug: string, doc: string) => void;
  onOpenDeck: (slug: string, deck: string) => void;
  onOpenReport: (r: DraftReport) => void;
  onOpenMeasure: (m: DraftMeasure) => void;
  onOpenSyllabus: (s: DraftSyllabus) => void;
  onStatusChange: (key: string, status: LibStatus) => void;
  onPin: (key: string, pinned: boolean) => void;
  onArchive: (slug: string, mode: "stalled" | "complete") => void;
  onArchiveGrant: (slug: string, mode: "stalled" | "complete") => void;
}) {
  if (!papers.length && !decks.length && !reports.length && !measures.length && !grants.length && !syllabi.length) return null;
  const Icon = STATUS_ICON[status];
  const slug = status === "draft" ? "recent" : status === "under_review" ? "under-review" : status === "idea" ? "idea" : "published";
  // outside Recent a sub-group names its status, so its widget title reads on its own
  const sub = (name: string) => (status === "draft" ? name : `${name} · ${STATUS_TITLE[status]}`);
  const subIcon = (I: typeof Clock) => <I size={13} className="text-muted-foreground/70 shrink-0" />;
  return (
    <div className="mt-7 grid gap-4">
      {papers.length > 0 ? (
        <LibGroup id={`drafting.${slug}`} title={STATUS_TITLE[status]} level="h2" icon={<Icon size={15} className="text-muted-foreground shrink-0" />}
          rows={papers.map((p) => <PaperRow key={p.slug + ":" + p.doc} p={p} onOpen={() => onOpen(p.slug, p.doc)} onStatus={(s) => onStatusChange(`paper:${p.slug}:${p.doc}`, s)}
            onPin={(v) => onPin(`paper:${p.slug}:${p.doc}`, v)} onArchive={(m) => onArchive(p.slug, m)} />)}
          entries={papers.map((p) => paperEntry(p, onOpen, onStatusChange, onPin, (m) => onArchive(p.slug, m)))} />
      ) : (
        <div className="flex items-center gap-2 -mb-1.5">
          <Icon size={15} className="text-muted-foreground" />
          <h2 className="text-[12px] font-medium uppercase tracking-wide text-muted-foreground">{STATUS_TITLE[status]}</h2>
        </div>
      )}
      {grants.length > 0 && (
        <LibGroup id={`drafting.${slug}.grants`} title={sub("Grants")} icon={subIcon(ScrollText)}
          rows={grants.map((p) => <PaperRow key={p.slug + ":" + p.doc} p={p} onOpen={() => onOpen(p.slug, p.doc)} onStatus={(s) => onStatusChange(`paper:${p.slug}:${p.doc}`, s)}
            onPin={(v) => onPin(`paper:${p.slug}:${p.doc}`, v)} onArchive={(m) => onArchiveGrant(p.slug, m)} />)}
          entries={grants.map((p) => paperEntry(p, onOpen, onStatusChange, onPin, (m) => onArchiveGrant(p.slug, m)))} />
      )}
      {decks.length > 0 && (
        <LibGroup id={`drafting.${slug}.presentations`} title={sub("Presentations")} icon={subIcon(Presentation)}
          rows={decks.map((p) => <DeckRow key={p.slug + ":" + p.deck} p={p} onOpen={() => onOpenDeck(p.slug, p.deck)} onStatus={(s) => onStatusChange(`deck:${p.slug}:${p.deck}`, s)} />)}
          entries={decks.map((p) => deckEntry(p, onOpenDeck, onStatusChange))} />
      )}
      {reports.length > 0 && (
        <LibGroup id={`drafting.${slug}.reports`} title={sub("Reports")} icon={subIcon(FileBarChart2)}
          rows={reports.map((r) => <ReportRow key={r.id} r={r} onOpen={() => onOpenReport(r)} onStatus={(s) => onStatusChange(`report:${r.id}`, s)} />)}
          entries={reports.map((r) => reportEntry(r, onOpenReport, onStatusChange))} />
      )}
      {syllabi.length > 0 && (
        <LibGroup id={`drafting.${slug}.syllabi`} title={sub("Syllabi & reading lists")} icon={subIcon(GraduationCap)}
          rows={syllabi.map((s) => <SyllabusRow key={s.id} s={s} onOpen={() => onOpenSyllabus(s)} onStatus={(st) => onStatusChange(`syllabus:${s.id}`, st)} />)}
          entries={syllabi.map((s) => syllabusEntry(s, onOpenSyllabus, onStatusChange))} />
      )}
      {measures.length > 0 && (
        <LibGroup id={`drafting.${slug}.measures`} title={sub("Measures")} icon={subIcon(Feather)}
          rows={measures.map((m) => <MeasureRow key={m.id} m={m} onOpen={() => onOpenMeasure(m)} onStatus={(s) => onStatusChange(`measure:${m.id}`, s)} />)}
          entries={measures.map((m) => measureEntry(m, onOpenMeasure, onStatusChange))} />
      )}
    </div>
  );
}

/** one library item as data, so a focused group can draw it as a table row, a preview or a card */
type LibEntry = {
  knavId: string;
  kind: ReactNode;
  title: string; subtitle?: string | null;
  /** null: this type carries no word count */
  words: number | null;
  status: LibStatus; onStatus: (s: LibStatus) => void;
  mtime: number;
  onOpen: () => void;
  /** open: a button; without it the cell is a rendered-state label */
  pdf: { open?: () => void; title: string; label: string } | null;
  live?: { open: () => void; title: string } | null;
  /** null: this type carries no review comments */
  comments: boolean | null;
  facts: string[];
  /** figures/tables already in results/ (papers); null: not counted */
  results?: number | null;
  /** the vault-relative file `o` / `e` open (data-obsidian-file); null: the index gives none */
  file?: string | null;
  /** this item's project, relative to Projects — the editor button's whole argument.
   *  null: the index gives no project, so the row draws no button. */
  project?: string | null;
  /** more of what the index already says, as label/value lines in the preview */
  details?: { label: string; value: string; tip?: string }[];
  pin?: { pinned: boolean; set: (v: boolean) => void };
  archive?: (mode: "stalled" | "complete") => void;
  /** a project that can be shared; `shared` null while it is not */
};

const kindChip = (icon: ReactNode, label: string, accent = false) => (
  <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-1.5 py-0.5 text-[10.5px] ${accent ? "border-primary/40 text-primary" : "border-border text-muted-foreground"}`}>{icon}{label}</span>
);
const openPdfOf = (slug: string, doc: string) => async () => {
  const res = await api.draftingOpenPdf(slug, doc);
  if (!res.ok) toast.error(res.error || "Couldn't open the PDF");
};

function paperEntry(p: DraftingPaper, onOpen: (slug: string, doc: string) => void, onStatusChange: (key: string, s: LibStatus) => void,
  onPin: (key: string, pinned: boolean) => void, onArchive: (mode: "stalled" | "complete") => void): LibEntry {
  const key = `paper:${p.slug}:${p.doc}`;
  return {
    knavId: key, kind: kindChip(<KindIcon kind={p.kind} size={11} />, p.label), title: p.title,
    words: p.words, status: p.status, onStatus: (s) => onStatusChange(key, s), mtime: p.paperMtime, onOpen: () => onOpen(p.slug, p.doc),
    pdf: p.pdf ? { open: openPdfOf(p.slug, p.doc), title: "Open the compiled PDF" + (p.pdfMtime ? " — built " + relAgo(p.pdfMtime) : ""), label: "PDF" } : null,
    comments: null,
    facts: [
      p.kind === "project" ? "planning — opens the README" : formatLabel(p.publish),
      ...(p.hasEditor ? ["planning started"] : []),
    ],
    results: p.resultsCount ?? null,
    file: p.paperRel || null,
    project: projectRelOf(p.paperRel),
    details: [
      ...(p.pdf && p.pdfMtime ? [{ label: "PDF built", value: relAgo(p.pdfMtime) }] : []),
      ...(p.hasEditor && p.editorMtime ? [{ label: "Planning notes", value: "edited " + relAgo(p.editorMtime), tip: p.editorRel }] : []),
      ...(p.paperRel ? [{ label: "File", value: p.paperRel.replace(/^Projects\/[^/]+\/[^/]+\//, ""), tip: p.paperRel }] : []),
    ],
    pin: { pinned: !!p.pinned, set: (v) => onPin(key, v) }, archive: onArchive,
  };
}
function deckEntry(p: DraftPresentation, onOpenDeck: (slug: string, deck: string) => void, onStatusChange: (key: string, s: LibStatus) => void): LibEntry {
  const key = `deck:${p.slug}:${p.deck}`;
  return {
    knavId: key, kind: kindChip(<Presentation size={11} />, "Slides"), title: p.title, words: null,
    status: p.status, onStatus: (s) => onStatusChange(key, s), mtime: p.deckMtime, onOpen: () => onOpenDeck(p.slug, p.deck),
    pdf: null, comments: p.hasReview, facts: [`${p.slides} slides`, p.slug, ...(p.hasNotes ? ["speaker notes"] : [])],
  };
}
function reportEntry(r: DraftReport, onOpenReport: (r: DraftReport) => void, onStatusChange: (key: string, s: LibStatus) => void): LibEntry {
  const key = `report:${r.id}`;
  return {
    knavId: key, kind: r.doc === "letter.md" ? kindChip(<Mail size={11} />, "Letter") : kindChip(<FileBarChart2 size={11} />, "Report"), title: r.title, words: r.render === "html" ? null : r.words,
    status: r.status, onStatus: (s) => onStatusChange(key, s), mtime: r.mtime, onOpen: () => onOpenReport(r),
    pdf: r.pdf && r.slug ? { open: openPdfOf(r.slug, r.doc || "report.md"), title: "Open the compiled PDF", label: "PDF" } : null,
    live: r.previewUrl && r.slug ? {
      open: async () => { const res = await api.draftingOpenPreview(r.slug!, r.doc || "report.md"); if (!res.ok) toast.error(res.error || "Couldn't open the live page"); },
      title: "Open the live page in your browser — " + r.previewUrl,
    } : null,
    comments: null,
    // a brief and its report share the Projects/briefs tree, so the id IS the project;
    // a letter lives in Projects/letters
    project: r.slug ? (r.doc === "letter.md" ? "letters/" : "briefs/") + r.slug : null,
    facts: r.render === "html" ? ["opens in your browser"] : r.render === "edit" ? ["drafts in the editor"] : [],
  };
}
function measureEntry(m: DraftMeasure, onOpenMeasure: (m: DraftMeasure) => void, onStatusChange: (key: string, s: LibStatus) => void): LibEntry {
  const key = `measure:${m.id}`;
  return {
    knavId: key, kind: kindChip(<Feather size={11} />, m.category), title: m.title, words: null,
    status: m.status, onStatus: (s) => onStatusChange(key, s), mtime: m.mtime, onOpen: () => onOpenMeasure(m),
    pdf: null, comments: null,
    facts: [m.ext.toUpperCase(), ...(m.ext === "md" ? ["editable"] : m.ext === "docx" ? ["preview — opens in Word to edit"] : [])],
  };
}
function syllabusEntry(s: DraftSyllabus, onOpenSyllabus: (s: DraftSyllabus) => void, onStatusChange: (key: string, s: LibStatus) => void): LibEntry {
  const key = `syllabus:${s.id}`;
  const stale = s.hasPdf && s.pdfMtime > 0 && s.pdfMtime < s.mtime;
  return {
    knavId: key,
    kind: s.kind === "syllabus" ? kindChip(<GraduationCap size={11} />, "Syllabus", true) : kindChip(<BookMarked size={11} />, "Reading list"),
    title: s.title, subtitle: s.subtitle, words: s.words,
    status: s.status, onStatus: (st) => onStatusChange(key, st), mtime: s.mtime, onOpen: () => onOpenSyllabus(s),
    pdf: s.hasPdf ? { title: stale ? "PDF is older than the source — re-render" : "Rendered PDF up to date", label: stale ? "stale" : "rendered" } : { title: "Not rendered yet", label: "not rendered" },
    comments: null,
    facts: [...(s.course || s.program ? [`${s.course || s.program}${s.term ? ` · ${s.term}` : ""}`] : []), `${s.readings.toLocaleString()} readings`, "editable"],
  };
}

const PILL_CLS = "inline-flex items-center gap-1.5 shrink-0 rounded-full border border-border px-3 py-1.5 text-[12.5px] text-muted-foreground hover:text-foreground hover:border-primary/50 transition-colors";
// the row opens only for keys pressed on the row itself, so ⏎ on its PDF button opens the PDF
const ownKeys = (open: () => void) => (ev: React.KeyboardEvent) => {
  if (ev.target !== ev.currentTarget) return;
  if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); open(); }
};
const stop = (fn: () => void) => (ev: React.MouseEvent) => { ev.stopPropagation(); fn(); };

/** a focused library group's table: only the columns this group has data for */
function LibTable({ entries, sel, setSel }: { entries: LibEntry[]; sel: number; setSel: (i: number) => void }) {
  const rest = useRestIntent();
  const hasWords = entries.some((e) => e.words != null);
  const hasPdf = entries.some((e) => e.pdf);
  const hasComments = entries.some((e) => e.comments != null);
  const cols = ["132px", "minmax(0,1fr)", hasWords ? "78px" : "", "118px", "84px", hasPdf ? "96px" : "", hasComments ? "104px" : ""].filter(Boolean).join(" ");
  const head = "text-[11px] uppercase tracking-wide text-muted-foreground/70";
  return (
    <div className="grid gap-1">
      <div className="grid items-center gap-3 px-3 pb-1.5 border-b border-border/60" style={{ gridTemplateColumns: cols }}>
        <span className={head}>Type</span><span className={head}>Title</span>
        {hasWords && <span className={head + " text-right"}>Words</span>}
        <span className={head}>Status</span><span className={head}>Edited</span>
        {hasPdf && <span className={head}>PDF</span>}
        {hasComments && <span className={head}>Comments</span>}
      </div>
      {entries.map((e, i) => (
        <div key={e.knavId} {...cardA11y(e.onOpen, e.knavId)} onKeyDown={ownKeys(e.onOpen)} data-obsidian-file={e.file || undefined}
          onFocus={() => setSel(i)} {...rest(e.knavId, () => setSel(i))}
          className={`group grid items-center gap-3 rounded-lg border px-3 py-2.5 cursor-pointer transition-colors ${sel === i ? "border-primary/40 bg-card" : "border-transparent hover:bg-card/60"}`}
          style={{ gridTemplateColumns: cols }}>
          <span className="min-w-0 overflow-hidden inline-flex items-center gap-1">{e.kind}</span>
          <span className="min-w-0 truncate text-[15px] text-foreground group-hover:text-primary transition-colors" style={TITLE_STYLE} title={e.title}>{e.title}</span>
          {hasWords && <span className="text-right text-[12.5px] nums text-muted-foreground">{e.words != null ? e.words.toLocaleString() : ""}</span>}
          <span className="min-w-0"><StatusSelect status={e.status} onChange={e.onStatus} /></span>
          <span className="text-[12px] nums text-muted-foreground whitespace-nowrap">{relAgo(e.mtime)}</span>
          {hasPdf && (
            <span className="min-w-0">
              {e.pdf?.open
                ? <button type="button" onClick={stop(e.pdf.open)} title={e.pdf.title} className="inline-flex items-center gap-1 text-[12px] text-primary hover:underline underline-offset-2"><FileText size={12} /> {e.pdf.label}</button>
                : e.pdf ? <span title={e.pdf.title} className="text-[12px] text-muted-foreground whitespace-nowrap">{e.pdf.label}</span> : null}
            </span>
          )}
          {hasComments && <span className="text-[12px] text-muted-foreground whitespace-nowrap">{e.comments ? <span className="inline-flex items-center gap-1"><MessageSquare size={12} /> commented</span> : ""}</span>}
        </div>
      ))}
    </div>
  );
}

/** the selected row at size, with every action the row carries; `card` makes the whole box the row */
function LibPreview({ e, card, minHeight }: { e: LibEntry; card?: boolean; minHeight?: number }) {
  // given a page height, the box takes it; the figures stay one row of compact cards and the
  // height goes to what the row already knows (results, PDF build, planning notes, file)
  const wsz = useWidget()?.size;
  const roomy = minHeight != null && (wsz === "lg" || wsz === "xl");
  const tile = (label: string, value: ReactNode, tip?: string) => (
    <div className="min-w-0 rounded-lg border border-border/60 px-3 py-2" title={tip}>
      <div className="truncate text-[10.5px] uppercase tracking-wide text-muted-foreground/70">{label}</div>
      <div className={`mt-0.5 font-semibold nums truncate ${roomy ? "text-[18px]" : "text-[16px]"}`}>{value}</div>
    </div>
  );
  const outer = card ? { ...cardA11y(e.onOpen, e.knavId), onKeyDown: ownKeys(e.onOpen) } : {};
  return (
    <div {...outer} data-obsidian-file={e.file || undefined} style={{ height: minHeight }}
      className={`group flex flex-col gap-4 min-w-0 min-h-fit rounded-xl border border-border bg-card/60 p-6 ${card ? "hover:bg-card hover:border-primary/50 cursor-pointer transition-colors" : ""}`}>
      <div className="min-w-0">
        <div className="flex items-center gap-2 mb-3 min-w-0">
          <span className="min-w-0 overflow-hidden">{e.kind}</span>
          <span className="ml-auto shrink-0 text-[12px] text-muted-foreground nums">edited {relAgo(e.mtime)}</span>
        </div>
        <div className={`text-[26px] leading-tight font-medium tracking-tight text-foreground line-clamp-4 break-words ${card ? "group-hover:text-primary transition-colors" : ""}`} style={TITLE_STYLE}>{e.title}</div>
        {e.subtitle && <div className="mt-1.5 text-[14px] text-muted-foreground line-clamp-2">{e.subtitle}</div>}
      </div>
      {/* compact figures in one row; they wrap only when the pane is too narrow to hold them */}
      <div className="grid gap-2 grid-cols-[repeat(auto-fit,minmax(84px,1fr))]">
        {e.words != null && tile("Words", e.words.toLocaleString())}
        {tile("Edited", relAgo(e.mtime))}
        {e.pdf && tile("PDF", e.pdf.open ? "compiled" : e.pdf.label, e.pdf.title)}
        {e.comments != null && tile("Comments", e.comments ? "commented" : "none")}
        {(e.results ?? 0) > 0 && tile("Results", (e.results ?? 0).toLocaleString(), "Figures and tables already in results/")}
      </div>
      {e.details && e.details.length > 0 && (
        <div className="grid gap-1.5 text-[12.5px]">
          {e.details.map((d) => (
            <div key={d.label} className="flex items-baseline gap-3 min-w-0">
              <span className="shrink-0 w-[104px] text-muted-foreground/70">{d.label}</span>
              <span className="min-w-0 truncate text-foreground/85" title={d.tip ?? d.value}>{d.value}</span>
            </div>
          ))}
        </div>
      )}
      {e.facts.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {e.facts.map((f) => <span key={f} className="rounded-md bg-secondary px-2 py-1 text-[12px] text-muted-foreground">{f}</span>)}
        </div>
      )}
      <div className="mt-auto flex flex-wrap items-center gap-2">
        {!card && <button type="button" onClick={e.onOpen} title="Open this item" className="inline-flex items-center gap-1.5 shrink-0 rounded-full border border-primary/40 bg-primary/10 px-3.5 py-1.5 text-[13px] text-primary hover:bg-primary/20"><SquarePen size={14} /> Open</button>}
        <StatusSelect status={e.status} onChange={e.onStatus} />
        {e.pdf?.open && <button type="button" onClick={stop(e.pdf.open)} title={e.pdf.title} className={PILL_CLS}><FileText size={13} /> PDF</button>}
        {e.live && <button type="button" onClick={stop(e.live.open)} title={e.live.title} className={PILL_CLS}><Globe size={13} /> live page</button>}
        {e.pin && (
          <button type="button" onClick={stop(() => e.pin!.set(!e.pin!.pinned))} title={e.pin.pinned ? "Unpin — back to the normal groups" : "Pin — keep this on top while you work on it"}
            className={PILL_CLS + (e.pin.pinned ? " text-primary border-primary/40" : "")}>
            <Star size={13} fill={e.pin.pinned ? "currentColor" : "none"} /> {e.pin.pinned ? "Pinned" : "Pin"}
          </button>
        )}
        {e.archive && (
          <>
            <button type="button" onClick={stop(() => e.archive!("stalled"))} title="Pause this project — stalled" className={PILL_CLS}><Clock size={13} /> Pause</button>
            <button type="button" onClick={stop(() => e.archive!("complete"))} title="Archive this project as complete" className={PILL_CLS}><FolderDown size={13} /> Archive</button>
          </>
        )}
      </div>
    </div>
  );
}

function LibGroup({ id, title, icon, level = "h3", rows, entries }: { id: string; title: string; icon: ReactNode; level?: "h2" | "h3"; rows: ReactNode[]; entries?: LibEntry[] }) {
  return (
    <WidgetFrame id={id} title={title}>
      <LibGroupBody title={title} icon={icon} level={level} rows={rows} entries={entries} />
    </WidgetFrame>
  );
}

function LibGroupBody({ title, icon, level, rows, entries }: { title: string; icon: ReactNode; level: "h2" | "h3"; rows: ReactNode[]; entries?: LibEntry[] }) {
  const w = useWidget();
  const [all, setAll] = useState(false);
  const [sel, setSel] = useState(0);
  const focused = !!w?.focused;
  const shown = rows.slice(0, all ? Infinity : rowCap(w, 3, 6));
  const hidden = rows.length - shown.length;
  const two = focused && w?.size === "xl";
  const wide = !!w && (w.size === "lg" || w.size === "xl");
  const narrow = !!w && (w.size === "xs" || w.size === "sm");
  const mode = !focused || !entries?.length ? "rows" : entries.length <= 3 ? "cards" : wide ? "table" : "rows";
  // the page below the heading: frame padding, the heading row and a little air
  const pageH = Math.max(320, (w?.height ?? 700) - 130);
  const Heading = level;
  return (
    <div>
      <div className="flex items-center gap-2 mb-2.5 min-w-0">
        {icon}
        <Heading className={level === "h2"
          ? "text-[12px] font-medium uppercase tracking-wide text-muted-foreground truncate"
          : "text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70 truncate"}>{title}</Heading>
        <span className="nums text-[11px] text-muted-foreground/60 shrink-0">{rows.length}</span>
      </div>
      {mode === "rows" && (
        <>
          <div className={`grid gap-2.5 ${two ? "grid-cols-2" : "grid-cols-1"}`}>{shown}</div>
          {hidden > 0 && (
            <button type="button" onClick={(e) => { if (!openWidgetFocus(e.currentTarget)) setAll(true); }} title="Open the full view" className="mt-2 text-[12px] text-muted-foreground hover:text-foreground">+ {hidden} more</button>
          )}
        </>
      )}
      {mode === "cards" && entries && (
        <div className={`grid gap-4 ${narrow || entries.length === 1 ? "grid-cols-1" : entries.length === 2 ? "grid-cols-2" : "grid-cols-3"}`}>
          {entries.map((e) => <LibPreview key={e.knavId} e={e} card minHeight={narrow ? undefined : pageH} />)}
        </div>
      )}
      {mode === "table" && entries && (
        <div className="flex items-start gap-5">
          <div className="min-w-0 flex-[65]"><LibTable entries={entries} sel={Math.min(sel, entries.length - 1)} setSel={setSel} /></div>
          <div className="min-w-0 flex-[35] sticky top-0">
            <LibPreview e={entries[Math.min(sel, entries.length - 1)]} minHeight={pageH} />
          </div>
        </div>
      )}
    </div>
  );
}

// the archive as a widget: a tile is the toggle and the first rows; the focused view opens the list
function ArchiveGroup({ show, setShow, archived, onRestore }: {
  show: boolean; setShow: React.Dispatch<React.SetStateAction<boolean>>;
  archived: ArchivedProject[] | null; onRestore: (name: string) => Promise<void>;
}) {
  const w = useWidget();
  const focused = !!w?.focused;
  const [all, setAll] = useState(false);
  useEffect(() => { if (focused) setShow(true); }, [focused]);   // eslint-disable-line react-hooks/exhaustive-deps
  const list = archived ?? [];
  const shown = list.slice(0, all ? Infinity : rowCap(w, 4, 8));
  // a focused view is one list of taller rows, each with when it was archived
  return (
    <div>
      <button onClick={() => setShow((o) => !o)} className="inline-flex items-center gap-2 text-left text-[12px] font-medium uppercase tracking-wide text-muted-foreground/70 hover:text-foreground">
        {show ? <ChevronDown size={14} className="shrink-0" /> : <ChevronRight size={14} className="shrink-0" />}
        <FolderDown size={14} className="shrink-0" /> Archive — paused & completed projects{archived ? ` (${archived.length})` : ""}
      </button>
      {show && (
        <div className={`mt-2.5 grid grid-cols-1 ${focused ? "gap-2" : "gap-1.5"}`}>
          {archived === null && <p className="text-[12px] text-muted-foreground px-1">loading…</p>}
          {archived?.length === 0 && <p className="text-[12px] text-muted-foreground px-1">The archive is empty.</p>}
          {shown.map((a) => (
            <div key={a.name} className={`flex items-center gap-3 min-w-0 rounded-lg border border-border/70 bg-card/50 ${focused ? "px-4 py-3.5" : "px-3 py-2"}`}>
              <span className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] ${a.mode === "complete" ? "border-success/40 text-success" : a.mode === "stalled" ? "border-warning/40 text-warning" : "border-border text-muted-foreground"}`}>{a.mode === "complete" ? "complete" : a.mode === "stalled" ? "paused" : "archived"}</span>
              <span className={`flex-1 min-w-0 truncate text-foreground/80 ${focused ? "text-[15px]" : "text-[13px]"}`} style={TITLE_STYLE} title={a.label}>{a.label}</span>
              {focused && a.mtime > 0 && <span className="shrink-0 text-[12px] nums text-muted-foreground" title="Archived">{relAgo(a.mtime)}</span>}
              <button onClick={() => onRestore(a.name)} title="Restore to the live projects" className="shrink-0 inline-flex items-center gap-1 text-[11.5px] text-muted-foreground hover:text-primary"><FolderUp size={12} /> restore</button>
            </div>
          ))}
        </div>
      )}
      {show && list.length > shown.length && (
        <button type="button" onClick={(e) => { if (!openWidgetFocus(e.currentTarget)) setAll(true); }} title="Open the full view" className="mt-2 text-[12px] text-muted-foreground hover:text-foreground">+ {list.length - shown.length} more</button>
      )}
    </div>
  );
}

function DraftingLibrary({ papers, presentations, reports, measures, grants, syllabi, onOpen, onOpenKey, onOpenDeck, onOpenReport, onOpenMeasure, onOpenSyllabus, onStatusChange, onPin, onArchive, onArchiveGrant, onRestore, onCreate }: {
  papers: DraftingPaper[]; presentations: DraftPresentation[]; reports: DraftReport[]; measures: DraftMeasure[]; grants: DraftingPaper[]; syllabi: DraftSyllabus[];
  onOpen: (slug: string, doc: string) => void;
  /** open a library item by its status key (paper:… deck:… report:… measure:… syllabus:…) */
  onOpenKey: (key: string) => void;
  onOpenDeck: (slug: string, deck: string) => void;
  onOpenReport: (r: DraftReport) => void;
  onOpenMeasure: (m: DraftMeasure) => void;
  onOpenSyllabus: (s: DraftSyllabus) => void;
  onStatusChange: (key: string, status: LibStatus) => void;
  onPin: (key: string, pinned: boolean) => void;
  onArchive: (slug: string, mode: "stalled" | "complete") => void;
  onArchiveGrant: (slug: string, mode: "stalled" | "complete") => void;
  onRestore: (name: string) => Promise<void>;
  onCreate: (title: string, idea: string, kind: NewProjectKind) => Promise<void>;
}) {
  const [q, setQ] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const [activeTypes, setActiveTypes] = useState<Set<LibType>>(() => new Set());
  const [activeStatuses, setActiveStatuses] = useState<Set<LibStatus>>(() => new Set());
  const [tab, setTab] = usePersistent<"library" | "pipeline">(DRAFTING_TAB_KEY, "library");
  useEffect(() => {
    const on = (e: Event) => { const t = (e as CustomEvent).detail; if (t === "library" || t === "pipeline") setTab(t); };
    window.addEventListener(DRAFTING_TAB_EVENT, on);
    return () => window.removeEventListener(DRAFTING_TAB_EVENT, on);
  }, [setTab]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !(e.ctrlKey || e.metaKey) || e.altKey || e.key.toLowerCase() !== "f") return;
      if (document.querySelector("[data-drafting-pane], [data-knav-modal], [role=dialog]")) return;
      e.preventDefault(); e.stopPropagation();
      setTab("library");   // the search lives on the list, not the overview
      requestAnimationFrame(() => { searchRef.current?.focus({ preventScroll: true }); searchRef.current?.select(); });
    };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [setTab]);
  // p toggles Progress Overview — only with the list itself on screen, never in a field
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.key !== "p") return;
      const a = document.activeElement as HTMLElement | null;
      if (a && (a.matches("input, textarea, select, [contenteditable=''], [contenteditable='true']") || a.isContentEditable)) return;
      if (document.documentElement.hasAttribute("data-board-prefix")) return;
      if (document.querySelector("[data-drafting-pane], [data-knav-modal], [role=dialog], body > .fixed.inset-0")) return;
      e.preventDefault();
      setTab((t) => (t === "pipeline" ? "library" : "pipeline"));
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [setTab]);
  const [creating, setCreating] = useState(false);
  const [newKind, setNewKind] = useState<NewProjectKind>("paper");
  const [newTitle, setNewTitle] = useState("");
  const [newIdea, setNewIdea] = useState("");
  const [createBusy, setCreateBusy] = useState(false);
  const [archShow, setArchShow] = useState(false);
  const [archived, setArchived] = useState<ArchivedProject[] | null>(null);
  const t = q.trim().toLowerCase();

  useEffect(() => {   // lazy-load the archive list when the section expands
    if (archShow && archived === null) api.draftingArchived().then((r) => setArchived(r.archived || [])).catch(() => setArchived([]));
  }, [archShow, archived]);

  const toggleType = (id: LibType) => setActiveTypes((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleStatus = (id: LibStatus) => setActiveStatuses((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const typeOn = (k: LibType) => activeTypes.size ? activeTypes.has(k) : k !== "report" && (!!t || (k !== "measure" && k !== "syllabus"));

  const mPapers = useMemo(() => t ? papers.filter((p) => (p.title + " " + p.slug + " " + p.label).toLowerCase().includes(t)) : papers, [papers, t]);
  const mDecks = useMemo(() => t ? presentations.filter((p) => (p.title + " " + p.slug + " " + p.deck).toLowerCase().includes(t)) : presentations, [presentations, t]);
  const mReports = useMemo(() => t ? reports.filter((r) => ((r.title || "") + " " + (r.id || "")).toLowerCase().includes(t)) : reports, [reports, t]);
  const mMeasures = useMemo(() => t ? measures.filter((m) => (m.title + " " + m.category).toLowerCase().includes(t)) : measures, [measures, t]);
  const mGrants = useMemo(() => t ? grants.filter((p) => (p.title + " " + p.slug + " " + p.label).toLowerCase().includes(t)) : grants, [grants, t]);
  const mSyllabi = useMemo(() => t ? syllabi.filter((s) => (s.title + " " + (s.subtitle || "") + " " + (s.course || "") + " " + (s.program || "") + " " + s.slug).toLowerCase().includes(t)) : syllabi, [syllabi, t]);

  const typeCounts: Record<LibType, number> = { paper: mPapers.length, deck: mDecks.length, report: mReports.length, measure: mMeasures.length, grant: mGrants.length, syllabus: mSyllabi.length };
  const statusCounts = useMemo(() => {
    const all = [...(typeOn("paper") ? mPapers : []), ...(typeOn("deck") ? mDecks : []), ...(typeOn("report") ? mReports : []), ...(typeOn("measure") ? mMeasures : []),
      ...(typeOn("grant") ? mGrants : []), ...(typeOn("syllabus") ? mSyllabi : [])];
    const n = (s: LibStatus) => all.filter((x) => x.status === s).length;
    return { idea: n("idea"), draft: n("draft"), under_review: n("under_review"), published: n("published") };
  }, [mPapers, mDecks, mReports, mMeasures, mGrants, mSyllabi, activeTypes, t]);   // eslint-disable-line react-hooks/exhaustive-deps

  // pinned papers lead the library in their own group; they leave the status groups
  const pinnedPapers = useMemo(() => (typeOn("paper") ? mPapers.filter((p) => p.pinned) : []), [mPapers, activeTypes]);   // eslint-disable-line react-hooks/exhaustive-deps
  const forStatus = (status: LibStatus) => ({
    papers: typeOn("paper") ? mPapers.filter((p) => p.status === status && !p.pinned) : [],
    decks: typeOn("deck") ? mDecks.filter((p) => p.status === status) : [],
    reports: typeOn("report") ? mReports.filter((r) => r.status === status) : [],
    measures: typeOn("measure") ? mMeasures.filter((m) => m.status === status) : [],
    grants: typeOn("grant") ? mGrants.filter((p) => p.status === status) : [],
    syllabi: typeOn("syllabus") ? mSyllabi.filter((s) => s.status === status) : [],
  });
  const showStatuses: LibStatus[] = activeStatuses.size
    ? (["draft", "idea", "under_review", "published"] as LibStatus[]).filter((s) => activeStatuses.has(s))
    : t ? ["draft", "idea", "under_review", "published"] : ["draft", "under_review", "published"];
  const totalShown = showStatuses.reduce((n, s) => { const g = forStatus(s); return n + g.papers.length + g.decks.length + g.reports.length + g.measures.length + g.grants.length + g.syllabi.length; }, 0);

  return (
    // a capped measure: on a wide screen a card's star, age and status sit near its title
    <div className="w-full max-w-[1180px] mx-auto">
      <div className="flex items-center gap-2 mb-5">
        <SquarePen size={22} className="text-primary" /><h1 className="text-[24px] font-semibold tracking-tight">Drafting</h1>
        <span className="flex-1" />
        {/* beside New project, so ← from it reaches the toggle rather than the chip row below */}
        <button type="button" aria-pressed={tab === "pipeline"} data-drafting-tab="pipeline"
          onClick={() => setTab((v) => (v === "pipeline" ? "library" : "pipeline"))}
          title="Progress Overview — Idea, Drafting, Review, Published (p)"
          className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12.5px] transition-colors ${tab === "pipeline" ? "border-primary/60 bg-primary/15 text-primary font-medium" : "border-border text-muted-foreground hover:text-foreground hover:border-primary/40"}`}>
          <Columns3 size={14} /> Progress Overview
        </button>
        <button onClick={() => setCreating(true)} className="inline-flex items-center gap-1.5 rounded-full border border-primary/40 text-primary px-3 py-1.5 text-[12.5px] hover:bg-primary/10"><Plus size={14} /> New project</button>
      </div>
      {creating && (() => {
        const kindCfg = NEW_PROJECT_KINDS.find((k) => k.id === newKind) || NEW_PROJECT_KINDS[0];
        const reset = () => { setCreating(false); setNewTitle(""); setNewIdea(""); setNewKind("paper"); };
        return (
        <div className="rounded-xl border border-primary/40 bg-card p-4 mb-4">
          <p className="text-[13px] font-medium mb-2.5 inline-flex items-center gap-1.5"><Compass size={14} className="text-primary" /> New project — starts with the README, the single audit document</p>
          <div className="flex flex-wrap items-center gap-1.5 mb-3">
            {NEW_PROJECT_KINDS.map((k) => {
              const Icon = k.icon; const on = k.id === newKind;
              return (
                <button key={k.id} onClick={() => setNewKind(k.id)}
                  className={"inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12.5px] transition-colors " + (on ? "border-primary/60 bg-primary/10 text-primary font-medium" : "border-border text-muted-foreground hover:text-foreground hover:border-primary/40")}>
                  <Icon size={13} /> {k.label}
                </button>
              );
            })}
          </div>
          <input autoFocus value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder={kindCfg.label + " title…"}
            className="w-full px-3 py-2 text-[13.5px] rounded-md border border-border bg-background focus:outline-none focus:border-primary/50 mb-2" />
          <textarea value={newIdea} onChange={(e) => setNewIdea(e.target.value)} placeholder={kindCfg.idea}
            rows={2} className="w-full px-3 py-2 text-[13px] rounded-md border border-border bg-background focus:outline-none focus:border-primary/50 resize-none mb-2" />
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={async () => { if (!newTitle.trim()) return; setCreateBusy(true); try { await onCreate(newTitle.trim(), newIdea.trim(), newKind); reset(); } finally { setCreateBusy(false); } }}
              disabled={createBusy || newTitle.trim().length < 3}
              className="inline-flex items-center gap-1.5 rounded-full border border-primary/40 text-primary px-3 py-1 text-[12.5px] hover:bg-primary/10 disabled:opacity-50">
              {createBusy ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />} Create & open the plan
            </button>
            <button onClick={reset} className="text-[12.5px] text-muted-foreground hover:text-foreground">cancel</button>
            <span className="flex-1" />
            <span className="text-[11px] text-muted-foreground/60">creates {kindCfg.hint}</span>
          </div>
        </div>
        );
      })()}
      {tab === "pipeline" ? (
        <DraftingPipeline onOpenKey={onOpenKey} onStatus={onStatusChange} />
      ) : (<>
      <div className="flex items-center gap-2 rounded-xl border border-border bg-card px-3.5 py-2.5 mb-3.5 focus-within:border-primary/60">
        <Search size={16} className="text-muted-foreground" />
        <input ref={searchRef} data-lib-search value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search your manuscripts, ideas, decks & writing…" className="flex-1 bg-transparent border-0 focus:outline-none text-[14px] placeholder:text-muted-foreground/60" />
        {q && <button onClick={() => setQ("")} className="text-muted-foreground hover:text-foreground"><X size={15} /></button>}
      </div>
      <div className="flex flex-wrap items-center gap-1.5 min-[1400px]:gap-2 mb-4">
        <FilterChip active={activeTypes.has("paper")} onClick={() => toggleType("paper")} icon={FileText} label="Drafts" count={typeCounts.paper} />
        <FilterChip active={activeTypes.has("deck")} onClick={() => toggleType("deck")} icon={Presentation} label="Presentations" count={typeCounts.deck} />
        <FilterChip active={activeTypes.has("report")} onClick={() => toggleType("report")} icon={FileBarChart2} label="Reports" count={typeCounts.report} />
        <FilterChip active={activeTypes.has("measure")} onClick={() => toggleType("measure")} icon={Feather} label="Measures" count={typeCounts.measure} />
        <FilterChip active={activeTypes.has("grant")} onClick={() => toggleType("grant")} icon={ScrollText} label="Grants" count={typeCounts.grant} />
        <FilterChip active={activeTypes.has("syllabus")} onClick={() => toggleType("syllabus")} icon={GraduationCap} label="Syllabi" count={typeCounts.syllabus} />
        <span className="w-px self-stretch bg-border mx-0.5" />
        <FilterChip active={activeStatuses.has("draft")} onClick={() => toggleStatus("draft")} icon={Clock} label="Drafting" count={statusCounts.draft} />
        <FilterChip active={activeStatuses.has("under_review")} onClick={() => toggleStatus("under_review")} icon={Send} label="Review" count={statusCounts.under_review} />
        <FilterChip active={activeStatuses.has("published")} onClick={() => toggleStatus("published")} icon={CircleCheck} label="Published" count={statusCounts.published} />
      </div>
      {pinnedPapers.length > 0 && (
        <LibGroup id="drafting.pinned" title="Pinned — working on now" level="h2" icon={<Star size={15} className="text-primary shrink-0" fill="currentColor" />}
          rows={pinnedPapers.map((p) => <PaperRow key={p.slug + ":" + p.doc} p={p} onOpen={() => onOpen(p.slug, p.doc)} onStatus={(s) => onStatusChange(`paper:${p.slug}:${p.doc}`, s)}
            onPin={(v) => onPin(`paper:${p.slug}:${p.doc}`, v)} onArchive={(m) => onArchive(p.slug, m)} />)}
          entries={pinnedPapers.map((p) => paperEntry(p, onOpen, onStatusChange, onPin, (m) => onArchive(p.slug, m)))} />
      )}
      {totalShown === 0 && <p className="text-[13px] text-muted-foreground text-center py-10">{q ? `Nothing matches “${q}”.` : "Nothing here for this filter."}</p>}
      {showStatuses.map((s) => {
        const g = forStatus(s);
        return (
          <LibrarySection key={s} status={s} {...g}
            onOpen={onOpen} onOpenDeck={onOpenDeck} onOpenReport={onOpenReport} onOpenMeasure={onOpenMeasure} onOpenSyllabus={onOpenSyllabus} onStatusChange={onStatusChange}
            onPin={onPin} onArchive={onArchive} onArchiveGrant={onArchiveGrant} />
        );
      })}
      {/* padded so the widget's focus ring clears the toggle's text */}
      <WidgetFrame id="drafting.archive" title="Archive — paused & completed projects" className="mt-8 mb-2 -mx-2.5 px-2.5 py-2">
        <ArchiveGroup show={archShow} setShow={setArchShow} archived={archived}
          onRestore={async (name) => { await onRestore(name); setArchived(null); }} />
      </WidgetFrame>
      </>)}
    </div>
  );
}

function TextFileViewer({ title, text, mtime, onExit }: { title?: string; text: string; mtime: number; onExit: () => void }) {
  return createPortal(
    <div className="fixed inset-0 z-[100] bg-background overflow-y-auto">
      <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-border bg-background/95 backdrop-blur px-6 py-3">
        <button type="button" onClick={onExit} data-knav-back className="inline-flex items-center gap-1 shrink-0 text-[13px] text-muted-foreground hover:text-foreground"><ChevronLeft size={16} /> Drafting</button>
        {title && <span className="text-[13px] font-medium truncate flex-1" style={{ fontFamily: SERIF }}>{title}</span>}
        <span className="text-[11.5px] text-muted-foreground nums shrink-0">{relAgo(mtime)}</span>
      </div>
      <div className="max-w-[760px] mx-auto px-6 py-10">
        <Markdown text={text} />
      </div>
    </div>, document.body);
}

function OpeningLine({ what }: { what: string }) {
  return createPortal(
    <div className="fixed inset-x-0 top-0 z-[100] h-[2px] bg-primary/20 pointer-events-none overflow-hidden"
      data-knav-skip aria-hidden="true" title={`Opening ${what}…`}>
      <div className="h-full w-1/3 bg-primary/70 animate-pulse" />
    </div>, document.body);
}

/** Escape must leave a loader that has not settled yet — otherwise a pending or failed
 *  open is a dead end. Loaders that already own a keydown handler do not use this. */
function useExitOnEscape(active: boolean, onExit: () => void) {
  useEffect(() => {
    if (!active) return;
    const k = (e: KeyboardEvent) => { if (e.key === "Escape" && !e.defaultPrevented) { e.preventDefault(); onExit(); } };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [active, onExit]);
}

function ReportViewerLoader({ id, onExit }: { id: string; onExit: () => void }) {
  const res = useApi(() => api.draftingReport(id), [id]);
  useExitOnEscape(!res.data || !!res.data.error, onExit);
  // res.error, not just data.error: api.ts's J throws on a non-ok status, so an HTTP
  // failure never reaches data and this screen would otherwise be unreachable
  if (res.error != null) return createPortal(
    <div className="fixed inset-0 z-[100] bg-background flex flex-col items-center justify-center gap-3">
      <p className="text-[14px] text-foreground">Couldn't load this report.</p>
      <button type="button" onClick={onExit} data-knav-back className="mt-1 text-[13px] text-primary hover:underline">← Back to Drafting</button>
    </div>, document.body);
  if (!res.data) return <OpeningLine what="this report" />;
  if (res.data.error || res.data.text == null) return createPortal(
    <div className="fixed inset-0 z-[100] bg-background flex flex-col items-center justify-center gap-3">
      <p className="text-[14px] text-foreground">Couldn't load this report.</p>
      <p className="text-[12.5px] text-muted-foreground">{res.data.error}</p>
      <button type="button" onClick={onExit} data-knav-back className="mt-1 text-[13px] text-primary hover:underline">← Back to Drafting</button>
    </div>, document.body);
  return <TextFileViewer title={res.data.title} text={res.data.text} mtime={res.data.mtime || 0} onExit={onExit} />;
}

function MeasureTextViewerLoader({ id, onExit }: { id: string; onExit: () => void }) {
  const res = useApi(() => api.draftingMeasureText(id), [id]);
  const [mode, setMode] = useState<"read" | "edit">("read");
  const [draft, setDraft] = useState("");
  const [baseMtime, setBaseMtime] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (res.data && !res.data.error && res.data.text != null) {
      setDraft(res.data.text);
      setBaseMtime(res.data.mtime ?? null);
    }
  }, [res.data]);
  useExitOnEscape(!res.data || !!res.data.error, onExit);

  if (res.error != null) return createPortal(
    <div className="fixed inset-0 z-[100] bg-background flex flex-col items-center justify-center gap-3">
      <p className="text-[14px] text-foreground">Couldn't load this file.</p>
      <button type="button" onClick={onExit} data-knav-back className="mt-1 text-[13px] text-primary hover:underline">← Back to Drafting</button>
    </div>, document.body);
  if (!res.data) return <OpeningLine what="this file" />;
  if (res.data.error || res.data.text == null) return createPortal(
    <div className="fixed inset-0 z-[100] bg-background flex flex-col items-center justify-center gap-3">
      <p className="text-[14px] text-foreground">Couldn't load this file.</p>
      <p className="text-[12.5px] text-muted-foreground">{res.data.error}</p>
      <button type="button" onClick={onExit} data-knav-back className="mt-1 text-[13px] text-primary hover:underline">← Back to Drafting</button>
    </div>, document.body);

  const data = res.data;
  const title = data.title || id;
  const isPoem = data.kind === "poem";

  const save = async () => {
    setSaving(true);
    const r = await api.draftingSaveMeasure(id, draft, baseMtime);
    setSaving(false);
    if (r.ok) {
      toast.success("Saved");
      setBaseMtime(r.mtime ?? baseMtime);
      res.set({ ...data, text: draft, mtime: r.mtime ?? data.mtime });
      setMode("read");
    } else if (r.conflict) {
      toast.error("This file changed elsewhere — reload before saving");
    } else {
      toast.error(r.error || "Couldn't save");
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[100] bg-background flex flex-col">
      <div className="shrink-0 flex items-center gap-2 px-6 py-3 border-b border-border">
        <button type="button" onClick={onExit} data-knav-back className="inline-flex items-center gap-1 shrink-0 text-[13px] text-muted-foreground hover:text-foreground"><ChevronLeft size={16} /> Drafting</button>
        <span className="text-[13px] font-medium truncate flex-1" style={{ fontFamily: SERIF }}>{title}</span>
        {mode === "read" ? (
          <button onClick={() => setMode("edit")} className="inline-flex items-center gap-1 shrink-0 text-[11.5px] text-muted-foreground hover:text-foreground"><SquarePen size={12} /> Edit</button>
        ) : (
          <>
            <button type="button" data-knav-back="2" onClick={() => { setDraft(data.text || ""); setMode("read"); }} className="shrink-0 text-[11.5px] text-muted-foreground hover:text-foreground">Cancel</button>
            <button onClick={save} disabled={saving} className="inline-flex items-center gap-1 shrink-0 text-[11.5px] text-primary hover:underline disabled:opacity-50"><Save size={12} /> {saving ? "Saving…" : "Save"}</button>
          </>
        )}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {mode === "edit" ? (
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck
            className="w-full h-full max-w-[700px] mx-auto block resize-none border-0 bg-background px-8 py-10 text-[15px] leading-[1.9] focus:outline-none"
            style={{ fontFamily: SERIF }}
          />
        ) : (
          <div className="max-w-[620px] mx-auto px-6 py-12">
            {isPoem ? <PoemView text={data.text || ""} /> : <Markdown text={data.text || ""} />}
          </div>
        )}
      </div>
    </div>, document.body);
}

function MeasurePdfViewerLoader({ id, onExit }: { id: string; onExit: () => void }) {
  const [loaded, setLoaded] = useState(false);
  const title = (id.split("/").pop() || id).replace(/\.(pdf|docx)$/i, "");
  const src = api.draftingMeasurePdfUrl(id);
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onExit(); } };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [onExit]);
  return createPortal(
    <div className="fixed inset-0 z-[100] bg-background flex flex-col">
      <div className="shrink-0 flex items-center gap-2 px-6 py-3 border-b border-border">
        <button type="button" onClick={onExit} data-knav-back className="inline-flex items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground"><ChevronLeft size={16} /> Drafting</button>
        <span className="text-[13px] font-medium truncate flex-1" title={title}>{title}</span>
        <button
          onClick={async () => { const r = await api.draftingOpenMeasure(id); if (!r.ok) toast.error(r.error || "Couldn't open this file"); }}
          title="Open in its native app (Word for .docx)"
          className="inline-flex items-center gap-1 text-[11.5px] text-muted-foreground hover:text-foreground"
        ><ExternalLink size={12} /> Open externally</button>
      </div>
      <div className="flex-1 min-h-0 bg-neutral-800/40 relative">
        {!loaded && (
          <div className="absolute inset-0 grid place-items-center text-[13px] text-muted-foreground">
            <span className="inline-flex items-center gap-2"><Loader2 size={15} className="animate-spin" />
              {id.toLowerCase().endsWith(".docx") ? "Converting for preview…" : "Loading…"}</span>
          </div>
        )}
        <iframe key={src} src={src} title={title} className="w-full h-full border-0" onLoad={() => setLoaded(true)} />
      </div>
    </div>, document.body);
}

function SyllabusEditorLoader({ s, onExit, onSaved }: { s: DraftSyllabus; onExit: () => void; onSaved: () => void }) {
  const res = useApi(() => api.draftingSyllabusText(s.id), [s.id]);
  const [draft, setDraft] = useState<string | null>(null);
  const [baseMtime, setBaseMtime] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [pdfStamp, setPdfStamp] = useState(0);
  const [hasPdf, setHasPdf] = useState(s.hasPdf);
  const [showPdf, setShowPdf] = useState(true);
  const [buildLog, setBuildLog] = useState<string | null>(null);
  const [pushOpen, setPushOpen] = useState(false);
  const [pushName, setPushName] = useState(s.title);
  const [pushSection, setPushSection] = useState<string>("");
  const [pushQueue, setPushQueue] = useState(true);
  const [pushBusy, setPushBusy] = useState(false);
  const [lists, setLists] = useState<SyllabusList[] | null>(null);
  const [pickOpen, setPickOpen] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);

  useEffect(() => {
    if (res.data && !res.data.error && res.data.text != null && draft === null) {
      setDraft(res.data.text);
      setBaseMtime(res.data.mtime ?? null);
      setHasPdf(!!res.data.hasPdf);
    }
  }, [res.data, draft]);
  const dirty = draft !== null && res.data?.text != null && draft !== res.data.text;
  const exit = useCallback(() => {
    if (dirty && !window.confirm("Discard unsaved changes?")) return;
    onExit();
  }, [dirty, onExit]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") { if (versionsOpen || typingEscape(e)) return; e.preventDefault(); e.stopPropagation(); exit(); } };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [exit, versionsOpen]);
  const loadLists = async () => { if (lists === null) { const r = await api.draftingSyllabusLists(); setLists(r.lists || []); } };

  // this loader owns Escape above (7345), so it needs no useExitOnEscape
  if (res.error != null) return createPortal(
    <div className="fixed inset-0 z-[100] bg-background flex flex-col items-center justify-center gap-3">
      <p className="text-[14px] text-foreground">Couldn't load this file.</p>
      <button type="button" onClick={onExit} data-knav-back className="mt-1 text-[13px] text-primary hover:underline">← Back to Drafting</button>
    </div>, document.body);
  if (!res.data) return <OpeningLine what="this file" />;
  if (res.data.error || res.data.text == null) return createPortal(
    <div className="fixed inset-0 z-[100] bg-background flex flex-col items-center justify-center gap-3">
      <p className="text-[14px] text-foreground">Couldn't load this file.</p>
      <p className="text-[12.5px] text-muted-foreground">{res.data.error}</p>
      <button type="button" onClick={onExit} data-knav-back className="mt-1 text-[13px] text-primary hover:underline">← Back to Drafting</button>
    </div>, document.body);

  const save = async (rebaseTo?: number | null): Promise<boolean> => {
    if (draft === null) return false;
    setSaving(true);
    const r = await api.draftingSyllabusSave({ id: s.id, text: draft, baseMtime: rebaseTo ?? baseMtime });
    setSaving(false);
    if (r.ok) {
      setBaseMtime(r.mtime ?? baseMtime);
      res.set({ ...res.data!, text: draft, mtime: r.mtime ?? res.data!.mtime });
      onSaved();
      toast.success("Saved");
      return true;
    }
    if (r.conflict) {
      if (window.confirm("This file changed elsewhere. Overwrite with your version? (Cancel keeps your draft in the editor.)")) return save(r.mtime ?? null);
      return false;
    }
    toast.error(r.error || "Couldn't save");
    return false;
  };

  const render = async () => {
    if (dirty) { const ok = await save(); if (!ok) return; }
    setRendering(true); setBuildLog(null);
    const r = await api.draftingSyllabusRender(s.id);
    setRendering(false);
    if (r.ok) { setHasPdf(true); setPdfStamp(Date.now()); setShowPdf(true); onSaved(); toast.success("PDF rendered"); }
    else { setBuildLog(r.log || r.error || "render failed"); toast.error("Render failed — see the build log"); }
  };

  const doPush = async () => {
    setPushBusy(true);
    const r = await api.draftingSyllabusPush({ list: s.slug, section: pushSection || null, name: pushName.trim() || undefined, queueDownloads: pushQueue });
    setPushBusy(false);
    if (r.error) { toast.error(r.error); return; }
    setPushOpen(false);
    toast.success(`Pushed ${r.total ?? 0} readings to the board — ${r.have ?? 0} owned · ${r.need ?? 0} queued to download`);
  };

  const distill = async (force = false) => {
    const r = await api.draftingSyllabusDistill({ slug: s.slug, force });
    if (r.ok) { toast.success(`Reading list created — ${r.readings} readings in ${r.sections} sections`); onSaved(); }
    else if (r.error === "exists" && !force) {
      if (window.confirm("A distilled list for this syllabus already exists. Regenerate it?")) return distill(true);
    } else toast.error(r.error || "Couldn't distill");
  };

  const addIncludeList = (slug: string) => {
    if (draft === null) return;
    let next = draft;
    if (/^include-lists:/m.test(next)) {
      if (new RegExp("^\\s*-\\s+" + slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*$", "m").test(next)) { toast("Already included"); setPickOpen(false); return; }
      next = next.replace(/^include-lists:\s*$/m, "include-lists:\n  - " + slug);
    } else if (/^---\s*\n/.test(next)) {
      const end = next.indexOf("\n---", 3);
      if (end !== -1) next = next.slice(0, end) + "\ninclude-lists:\n  - " + slug + next.slice(end);
    }
    if (next === draft) { toast.error("Couldn't edit the frontmatter — add include-lists by hand"); return; }
    setDraft(next);
    setPickOpen(false);
    toast.success(`Added ${slug} — save & render to see it appended`);
  };

  const pushableSections = (lists || []).find((l) => l.slug === s.slug)?.sections || [];
  const title = res.data.title || s.title;

  return createPortal(
    <div className="fixed inset-0 z-[100] bg-background flex flex-col">
      <div className="shrink-0 flex items-center gap-2.5 px-6 py-3 border-b border-border">
        <button type="button" onClick={exit} data-knav-back className="inline-flex items-center gap-1 shrink-0 text-[13px] text-muted-foreground hover:text-foreground"><ChevronLeft size={16} /> Drafting</button>
        {s.kind === "syllabus"
          ? <span className="inline-flex items-center gap-1 shrink-0 rounded-full border border-primary/40 text-primary px-1.5 py-0.5 text-[10px]"><GraduationCap size={11} /> Syllabus</span>
          : <span className="inline-flex items-center gap-1 shrink-0 rounded-full border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground"><BookMarked size={11} /> Reading list</span>}
        <span className="text-[13px] font-medium truncate flex-1" style={{ fontFamily: SERIF }}>{title}{dirty ? " •" : ""}</span>
        {s.kind === "syllabus" && (
          <span className="relative shrink-0">
            <button onClick={async () => { await loadLists(); setPickOpen((o) => !o); }} title="Append a formatted reading list to this syllabus's PDF (include-lists frontmatter)"
              className="inline-flex items-center gap-1 text-[11.5px] text-muted-foreground hover:text-foreground"><BookMarked size={12} /> Add reading list</button>
            {pickOpen && (
              <span className="absolute right-0 top-6 z-10 w-72 max-h-72 overflow-y-auto rounded-lg border border-border bg-card shadow-lg p-1">
                {(lists || []).length === 0 && <span className="block px-2 py-1.5 text-[12px] text-muted-foreground">No lists in Preparation/Reading/Lists.</span>}
                {(lists || []).map((l) => (
                  <button key={l.slug} onClick={() => addIncludeList(l.slug)} className="block w-full text-left rounded px-2 py-1.5 text-[12px] hover:bg-primary/10">
                    <span className="font-medium">{l.title}</span> <span className="text-muted-foreground nums">— {l.readings} readings</span>
                  </button>
                ))}
              </span>
            )}
          </span>
        )}
        {s.kind === "syllabus" && (
          <button onClick={() => distill()} title="Generate a companion reading list (Lists/<slug>-readings.md) from this syllabus's weekly readings"
            className="inline-flex items-center gap-1 shrink-0 text-[11.5px] text-muted-foreground hover:text-foreground"><ListOrdered size={12} /> Distill readings</button>
        )}
        {s.kind === "list" && (
          <button onClick={async () => { await loadLists(); setPushOpen(true); }} title="Push this list onto the board's To Read — owned readings link their PDFs, missing ones join the download queue"
            className="inline-flex items-center gap-1 shrink-0 text-[11.5px] text-muted-foreground hover:text-foreground"><Send size={12} /> Push to board</button>
        )}
        <button onClick={() => setVersionsOpen(true)} className="inline-flex items-center gap-1 shrink-0 text-[11.5px] text-muted-foreground hover:text-foreground" title="Versions — a checkpoint is saved on every save; diff any two, restore one">
          <History size={12} /> Versions</button>
        <button onClick={() => setShowPdf((v) => !v)} className="inline-flex items-center gap-1 shrink-0 text-[11.5px] text-muted-foreground hover:text-foreground" title={showPdf ? "Hide the PDF pane" : "Show the PDF pane"}>
          <Eye size={12} /> {showPdf ? "Hide PDF" : "Show PDF"}</button>
        <button onClick={render} disabled={rendering} className="inline-flex items-center gap-1 shrink-0 text-[11.5px] text-primary hover:underline disabled:opacity-50" title="Save & rebuild the PDF">
          {rendering ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} {rendering ? "Rendering…" : "Render PDF"}</button>
        <button onClick={() => save()} disabled={saving || !dirty} className="inline-flex items-center gap-1 shrink-0 text-[11.5px] text-primary hover:underline disabled:opacity-50">
          <Save size={12} /> {saving ? "Saving…" : "Save"}</button>
      </div>
      {buildLog && (
        <div className="shrink-0 border-b border-border bg-red-500/5 px-6 py-2">
          <p className="text-[11.5px] font-medium text-red-600 dark:text-red-400 mb-1">Build failed — log tail</p>
          <pre className="text-[10.5px] leading-snug text-muted-foreground max-h-28 overflow-y-auto whitespace-pre-wrap">{buildLog}</pre>
        </div>
      )}
      {pushOpen && (
        <div className="shrink-0 border-b border-border bg-card px-6 py-3 flex flex-wrap items-center gap-3">
          <span className="text-[12px] font-medium inline-flex items-center gap-1.5"><Send size={13} className="text-primary" /> Push to the board</span>
          <input value={pushName} onChange={(e) => setPushName(e.target.value)} placeholder="Board list name"
            className="px-2.5 py-1 text-[12.5px] rounded-md border border-border bg-background focus:outline-none focus:border-primary/50 w-72" />
          <select value={pushSection} onChange={(e) => setPushSection(e.target.value)}
            className="px-2 py-1 text-[12px] rounded-md border border-border bg-background focus:outline-none">
            <option value="">All sections</option>
            {pushableSections.map((sec) => <option key={sec.i} value={String(sec.i)}>{sec.name} ({sec.readings})</option>)}
          </select>
          <label className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground">
            <input type="checkbox" checked={pushQueue} onChange={(e) => setPushQueue(e.target.checked)} /> queue missing PDFs for download
          </label>
          <button onClick={doPush} disabled={pushBusy} className="inline-flex items-center gap-1 rounded-full border border-primary/40 text-primary px-3 py-1 text-[12px] hover:bg-primary/10 disabled:opacity-50">
            {pushBusy ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />} Push</button>
          <button onClick={() => setPushOpen(false)} className="text-[12px] text-muted-foreground hover:text-foreground">cancel</button>
        </div>
      )}
      <div className="flex-1 min-h-0 flex">
        <textarea
          value={draft ?? ""}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
          className={(showPdf ? "w-1/2 border-r border-border " : "w-full max-w-[860px] mx-auto ") + "h-full resize-none border-0 bg-background px-7 py-6 text-[12.5px] leading-[1.75] focus:outline-none font-mono"}
        />
        {showPdf && (
          <div className="w-1/2 h-full bg-neutral-800/40 relative">
            {hasPdf
              ? <iframe key={pdfStamp} src={api.syllabusPdfUrl(s.id, pdfStamp)} title={title} className="w-full h-full border-0" />
              : <div className="absolute inset-0 grid place-items-center text-[13px] text-muted-foreground"><span className="inline-flex items-center gap-2"><FileOutput size={15} /> No PDF yet — Render to preview</span></div>}
          </div>
        )}
      </div>
      {versionsOpen && <VersionsPanel slug="syllabi" docName={s.id} title={title}
        getMtime={() => baseMtime ?? 0} flush={async () => { if (dirty) await save(); }}
        onRestored={(text, mtime) => { setDraft(text); setBaseMtime(mtime); res.set({ ...res.data!, text, mtime }); onSaved(); }}
        onClose={() => setVersionsOpen(false)} />}
    </div>, document.body);
}

function SplitDivider({ pct, onPct }: { pct: number; onPct: (p: number) => void }) {
  const drag = useRef(false);
  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (!drag.current) return;
      e.preventDefault();
      onPct(Math.min(80, Math.max(20, (e.clientX / Math.max(1, window.innerWidth)) * 100)));
    };
    const up = () => { if (!drag.current) return; drag.current = false; document.body.style.cursor = ""; document.body.style.userSelect = ""; };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
  }, [onPct]);
  return createPortal(
    <div role="separator" aria-orientation="vertical" aria-label="Resize the two documents" tabIndex={0}
      title="Drag to resize — arrow keys move it, double-click to even the panes"
      onMouseDown={(e) => { e.preventDefault(); drag.current = true; document.body.style.cursor = "col-resize"; document.body.style.userSelect = "none"; }}
      onDoubleClick={() => onPct(50)}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") { e.preventDefault(); onPct(Math.max(20, pct - 2)); }
        else if (e.key === "ArrowRight") { e.preventDefault(); onPct(Math.min(80, pct + 2)); }
        else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPct(50); }
      }}
      className="fixed top-0 bottom-0 z-[101] w-2 -ml-1 cursor-col-resize bg-transparent hover:bg-primary/25 focus:bg-primary/35 focus:outline-none transition-colors"
      style={{ left: pct + "%" }} />, document.body);
}

type EditorLoaderProps = { slug: string; docName: string; onExit: () => void; onSwitchDoc: (doc: string) => void; onOpenBeside?: (doc: string) => void; pane?: PaneGeom; onClosePane?: () => void };

function EditorLoader(props: EditorLoaderProps) {
  const { slug, docName, onExit } = props;
  const [held, setHeld] = useState<Promise<void> | null>(() => draftHeld(slug, docName));
  useEffect(() => { const h = draftHeld(slug, docName); if (h) setHeld(h); }, [slug, docName]);
  useEffect(() => {
    if (!held) return;
    let on = true;
    const done = () => { if (on) setHeld(draftHeld(slug, docName)); };
    held.then(done, done);
    return () => { on = false; };
  }, [held, slug, docName]);
  useExitOnEscape(!!held, onExit);
  if (held) return <OpeningLine what={docName} />;
  return <EditorLoaderReady {...props} />;
}

function EditorLoaderReady({ slug, docName, onExit, onSwitchDoc, onOpenBeside, pane, onClosePane }: EditorLoaderProps) {
  // BEFORE the cache is read: a copy older than a save some window had confirmed is not
  // this document any more (idempotent, so safe in a render that React may run twice)
  useState(() => dropSupersededDraft(slug, docName));
  const docRes = useApi(draftDocFetcher(slug, docName), [slug, docName], 0, DRAFT_DOC_API);
  // the editor owns Escape once it is up; until then this loader does
  useExitOnEscape(!docRes.data || !!docRes.data.error, onExit);
  const settled = !!docRes.data || docRes.error != null;
  useEffect(() => { if (settled) releaseDraftingLists(); }, [settled]);

  if (docRes.error != null || docRes.data?.error) return createPortal(
    <div className="fixed inset-0 z-[100] bg-background flex flex-col items-center justify-center gap-3 text-center px-6">
      <p className="text-[14px] text-muted-foreground">{docRes.data?.error || `${docName} could not be opened.`}</p>
      <button type="button" onClick={onExit} data-knav-back className="text-[13px] text-primary hover:underline">← Back to Drafting</button>
    </div>, document.body);
  if (!docRes.data) return <OpeningLine what={docName} />;
  return <Editor key={slug + ":" + docName} doc={docRes.data} cacheDoc={docName} onExit={onExit} onSwitchDoc={onSwitchDoc}
    onOpenBeside={onOpenBeside} pane={pane} onClosePane={onClosePane} />;
}

export function Drafting() {
  const papersRes = useApi(() => api.draftingPapers(), []);
  const deckRes = useApi(() => api.draftingPresentations(), []);
  const reportsRes = useApi(() => api.draftingReports(), []);
  const grantsRes = useApi(() => api.draftingGrants(), []);
  const measuresRes = useApi(() => api.draftingMeasures(), []);
  const syllabiRes = useApi(() => api.draftingSyllabi(), []);
  const papers = papersRes.data?.papers ?? [];
  const presentations = deckRes.data?.presentations ?? [];
  const reports = reportsRes.data?.reports ?? [];
  const grants = grantsRes.data?.grants ?? [];
  const measures = measuresRes.data?.measures ?? [];
  const syllabi = syllabiRes.data?.syllabi ?? [];
  const [open, setOpen] = useState<{ kind: "paper" | "deck" | "report" | "measure-pdf" | "measure-text"; slug: string; name: string } | null>(() => {
    const p = pendingDraftOpen.current;
    return p ? { kind: "paper" as const, slug: p.slug, name: p.doc } : null;
  });
  const [openSyllabus, setOpenSyllabus] = useState<DraftSyllabus | null>(null);
  const [second, setSecond] = useState<{ slug: string; name: string } | null>(null);
  const [splitPct, setSplitPct] = usePersistent<number>("drafting-split-pct", 50);
  const [focusedPane, setFocusedPane] = useState<"left" | "right">("left");
  const closeSecond = useCallback(() => { setSecond(null); setFocusedPane("left"); }, []);
  const libraryNext = useMemo(() => papers.filter((p) => p.hasEditor && p.slug && p.doc).slice(0, 5).map((p) => p.slug + "\u0001" + p.doc).join("\u0002"),
    [papersRes.data]);   // eslint-disable-line react-hooks/exhaustive-deps
  const nothingOpen = open === null && openSyllabus === null;
  // which manuscripts have a planning sidecar: the prefetcher fetches no other kind
  useEffect(() => {
    if (papersRes.data && grantsRes.data) noteDraftRows([...papersRes.data.papers, ...grantsRes.data.grants]);
  }, [papersRes.data, grantsRes.data]);
  useEffect(() => {
    if (!nothingOpen || !libraryNext) return;
    return primeDrafts(libraryNext.split("\u0002").map((x) => { const [slug, doc] = x.split("\u0001"); return { slug, doc }; }));
  }, [nothingOpen, libraryNext]);
  const openBeside = useCallback((name: string) => {
    setOpen((o) => {
      if (!o || o.kind !== "paper") return o;
      setSecond((s) => (s && s.name === name && s.slug === o.slug ? s : { slug: o.slug, name }));
      return o;
    });
    setFocusedPane("right");
  }, []);

  // a task's smart link (or a #/drafting/<slug>/<doc> hash) queued a manuscript —
  // consume it once and land straight in the editor
  useEffect(() => {
    const take = () => {
      const p = pendingDraftOpen.current;
      if (!p) return;
      pendingDraftOpen.current = null;
      // the initial url was already opened during the first render; returning the current
      // value keeps React from remounting the loader and refetching the manuscript
      setOpen((cur) => (cur && cur.slug === p.slug && cur.name === p.doc ? cur : { kind: "paper", slug: p.slug, name: p.doc }));
    };
    take();                            // set BEFORE this view mounted: the initial url
    return onPendingDraftOpen(take);   // set AFTER it mounted: a hashchange, or a task link
  }, []);

  const setStatus = async (key: string, status: LibStatus) => {
    // optimistic — patch whichever list actually holds this key, then confirm with the server
    if (papersRes.data) papersRes.set({ papers: papersRes.data.papers.map((p) => (`paper:${p.slug}:${p.doc}` === key ? { ...p, status } : p)) });
    if (grantsRes.data) grantsRes.set({ grants: grantsRes.data.grants.map((p) => (`paper:${p.slug}:${p.doc}` === key ? { ...p, status } : p)) });
    if (deckRes.data) deckRes.set({ presentations: deckRes.data.presentations.map((p) => (`deck:${p.slug}:${p.deck}` === key ? { ...p, status } : p)) });
    if (reportsRes.data) reportsRes.set({ reports: reportsRes.data.reports.map((r) => (`report:${r.id}` === key ? { ...r, status } : r)) });
    if (measuresRes.data) measuresRes.set({ measures: measuresRes.data.measures.map((m) => (`measure:${m.id}` === key ? { ...m, status } : m)) });
    if (syllabiRes.data) syllabiRes.set({ syllabi: syllabiRes.data.syllabi.map((s) => (`syllabus:${s.id}` === key ? { ...s, status } : s)) });
    const res = await api.draftingSetStatus(key, status);
    if (!res.ok) {
      toast.error(res.error || "Couldn't update status");
      papersRes.reload(); grantsRes.reload(); deckRes.reload(); reportsRes.reload(); measuresRes.reload(); syllabiRes.reload();
    }
  };

  const openReport = async (r: DraftReport) => {
    if (r.render === "edit" && r.slug) { setOpen({ kind: "paper", slug: r.slug, name: r.doc || "report.md" }); return; }
    if (r.render === "md") { setOpen({ kind: "report", slug: "", name: r.id }); return; }
    const res = await api.draftingOpenReport(r.id);
    if (!res.ok) toast.error(res.error || "Couldn't open this report");
  };
  const openMeasure = async (m: DraftMeasure) => {
    if (m.ext === "md") { setOpen({ kind: "measure-text", slug: "", name: m.id }); return; }
    if (m.ext === "pdf" || m.ext === "docx") { setOpen({ kind: "measure-pdf", slug: "", name: m.id }); return; }
    const res = await api.draftingOpenMeasure(m.id);
    if (!res.ok) toast.error(res.error || "Couldn't open this file");
  };
  // the pipeline names items by their /drafting/status key; open each the way its library row does
  const openKey = (key: string) => {
    const i = key.indexOf(":");
    const kind = key.slice(0, i), rest = key.slice(i + 1);
    if (kind === "paper" || kind === "deck") {
      const j = rest.indexOf(":");
      if (j > 0) setOpen({ kind, slug: rest.slice(0, j), name: rest.slice(j + 1) });
      return;
    }
    if (kind === "report") { const r = reports.find((x) => x.id === rest); if (r) void openReport(r); return; }
    if (kind === "measure") { const m = measures.find((x) => x.id === rest); if (m) void openMeasure(m); return; }
    if (kind === "syllabus") { const s = syllabi.find((x) => x.id === rest); if (s) setOpenSyllabus(s); return; }
    toast.error("Couldn't open this item");
  };


  const setPin = async (key: string, pinned: boolean) => {
    if (papersRes.data) papersRes.set({ papers: papersRes.data.papers.map((p) => (`paper:${p.slug}:${p.doc}` === key ? { ...p, pinned } : p)) });
    if (grantsRes.data) grantsRes.set({ grants: grantsRes.data.grants.map((p) => (`paper:${p.slug}:${p.doc}` === key ? { ...p, pinned } : p)) });
    const r = await api.draftingPin(key, pinned);
    if (!r.ok) { toast.error(r.error || "Couldn't pin"); papersRes.reload(); grantsRes.reload(); }
  };
  // grants live under Projects/grants, not papers/archive — the paper archive
  // path doesn't apply. keep the card's menu honest rather than mis-filing.
  const archiveGrant = () => toast("Archive a grant from the file system (Projects/grants/) for now.");
  const archiveProject = async (slug: string, mode: "stalled" | "complete") => {
    if (!window.confirm(mode === "stalled"
      ? `Pause "${slug}"? The whole project folder moves to papers/archive/stalled - ${slug}.`
      : `Archive "${slug}" as complete? The whole project folder moves to papers/archive/complete - ${slug}.`)) return;
    const r = await api.draftingArchiveProject(slug, mode);
    if (r.ok) { toast.success(mode === "stalled" ? "Paused — restore it any time from the Archive section" : "Archived as complete"); papersRes.reload(); deckRes.reload(); }
    else toast.error(r.error || "Couldn't archive");
  };
  const restoreProject = async (name: string) => {
    const r = await api.draftingRestoreProject(name);
    if (r.ok) { toast.success("Restored to live projects"); papersRes.reload(); deckRes.reload(); }
    else toast.error(r.error || "Couldn't restore");
  };
  const createProject = async (title: string, idea: string, kind: NewProjectKind) => {
    const r = await api.draftingCreateProject(title, idea, kind);
    if (r.ok && r.slug) {
      toast.success(`${kind[0].toUpperCase()}${kind.slice(1)} created — opening the README`);
      // reload whichever library group this type lands in (grants + briefs/reports
      // live in their own trees), then open the README plan in the editor
      if (r.base === "grants") grantsRes.reload();
      else if (r.base === "briefs" || r.base === "letters") reportsRes.reload();
      else papersRes.reload();
      setOpen({ kind: "paper", slug: r.slug, name: r.doc || "readme.md" });
    } else toast.error(r.error || "Couldn't create the project");
  };

  const split = open?.kind === "paper" && second != null && second.slug === open.slug;
  const paperEditor = open?.kind === "paper"
    ? <Fragment key="drafting-editor">
        <EditorLoader key={open.slug + ":" + open.name} slug={open.slug} docName={open.name}
          onExit={() => { releaseDraftingLists(); closeSecond(); setOpen(null); }}
          onSwitchDoc={(name) => setOpen((o) => {
            if (!o) return o;
            // switching this pane onto the document the OTHER pane holds: swap, never
            // open the same file twice
            if (second && second.name === name && second.slug === o.slug) { setSecond({ slug: o.slug, name: o.name }); }
            return { ...o, name };
          })}
          onOpenBeside={openBeside}
          pane={split ? { leftPct: 0, rightPct: 100 - splitPct, side: "left", onFocusPane: () => setFocusedPane("left"), focused: focusedPane === "left" } : null} />
        {split && second && (
          <EditorLoader key={"beside:" + second.slug + ":" + second.name} slug={second.slug} docName={second.name}
            onExit={closeSecond}
            onSwitchDoc={(name) => setSecond((s) => {
              if (!s) return s;
              if (open && open.name === name) { setOpen((o) => (o ? { ...o, name: s.name } : o)); }
              return { ...s, name };
            })}
            onOpenBeside={(name) => setOpen((o) => (o ? { ...o, name } : o))}
            onClosePane={closeSecond}
            pane={{ leftPct: splitPct, rightPct: 0, side: "right", onFocusPane: () => setFocusedPane("right"), focused: focusedPane === "right" }} />
        )}
        {split && <SplitDivider pct={splitPct} onPct={setSplitPct} />}
      </Fragment>
    : null;

  if (!papersRes.data || !deckRes.data || !reportsRes.data || !grantsRes.data || !measuresRes.data || !syllabiRes.data) {
    // a deep link gets its editor NOW, over the skeleton, not after the library lands
    return <DialogsProvider>{paperEditor}<SkelOverview /></DialogsProvider>;
  }
  return (<DialogsProvider>
    <DraftingLibrary
      papers={papers}
      presentations={presentations}
      reports={reports}
      measures={measures}
      grants={grants}
      syllabi={syllabi}
      onOpen={(slug, doc) => setOpen({ kind: "paper", slug, name: doc })}
      onOpenKey={openKey}
      onOpenDeck={(slug, deck) => setOpen({ kind: "deck", slug, name: deck })}
      onOpenReport={openReport}
      onOpenMeasure={openMeasure}
      onOpenSyllabus={(s) => setOpenSyllabus(s)}
      onStatusChange={setStatus}
      onPin={setPin}
      onArchive={archiveProject}
      onArchiveGrant={archiveGrant}
      onRestore={restoreProject}
      onCreate={createProject}
    />
    {paperEditor}
    {open?.kind === "deck" && <DeckViewerLoader slug={open.slug} deck={open.name} onExit={() => setOpen(null)} />}
    {open?.kind === "report" && <ReportViewerLoader id={open.name} onExit={() => setOpen(null)} />}
    {open?.kind === "measure-pdf" && <MeasurePdfViewerLoader id={open.name} onExit={() => setOpen(null)} />}
    {open?.kind === "measure-text" && <MeasureTextViewerLoader id={open.name} onExit={() => setOpen(null)} />}
    {openSyllabus && <SyllabusEditorLoader key={openSyllabus.id} s={openSyllabus} onExit={() => setOpenSyllabus(null)} onSaved={() => syllabiRes.reload()} />}
  </DialogsProvider>);
}
