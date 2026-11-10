

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BookOpen, Check, ChevronLeft, ChevronRight, Flag, AlertTriangle } from "lucide-react";
import { api, type CitePageTarget, type DraftComment } from "@/lib/api";
import { scanDocCites, type DocCite } from "@/lib/markdownEditor";
import { citeDetailCached, type CiteDetail } from "@/lib/citeIndex";
import { locate, commentIsOpen } from "@/lib/anchors";
import { SERIF, pdfFindKey, PdfFindFrame } from "@/components/draftingShared";

type Mark = "ok" | "flag";
type Store = { marks?: Record<string, Mark>; key?: string; uncheckedOnly?: boolean };

function lsGet(k: string): Store {
  try { const v = JSON.parse(localStorage.getItem(k) || "null"); return v && typeof v === "object" ? v : {}; } catch { return {}; }
}
function lsSet(k: string, v: Store) {
  try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private window: per-session only */ }
}

const typing = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.matches?.("input, textarea, select") || !!el.closest?.("[contenteditable=true], .cm-content"));
};

type Item = DocCite & { raw: string; paraFrom: number; paraTo: number; section: string; id: string };

function buildItems(text: string, cites: DocCite[]): Item[] {
  const seen = new Map<string, number>();
  return cites.map((c) => {
    const a = text.lastIndexOf("\n\n", c.from);
    const paraFrom = a < 0 ? 0 : a + 2;
    const b = text.indexOf("\n\n", c.to);
    const paraTo = b < 0 ? text.length : b;
    const before = text.slice(0, paraFrom);
    const hm = [...before.matchAll(/^#{1,6}\s+(.+)$/gm)].pop();
    const raw = text.slice(c.from, c.to);
    const fp = text.slice(paraFrom, paraTo).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 48);
    const base = raw + "|" + fp;
    const n = seen.get(base) ?? 0; seen.set(base, n + 1);
    return { ...c, raw, paraFrom, paraTo, section: hm ? hm[1].trim() : "", id: base + "|" + n };
  });
}

const STATUS_TIP: Record<string, string> = {
  ambiguous: "Several notes match this cite; the reference list did not settle which",
  unresolved: "No citation note or corpus PDF matches this cite",
  prior: "Only in this paper's references.md; no citation note",
};

export function LiteratureMode({ slug, docName, text, citeMap, comments, paused = false, onFlag, onOpenNote, onExit }: {
  slug: string; docName: string;
  text: string;                                             // the live manuscript
  citeMap: Record<string, { status: string; rel: string }>;
  comments: DraftComment[];
  paused?: boolean;                                         // the Review menu is open over the layer
  onFlag: (from: number, to: number, note: string) => void; // files an open flag comment on the cite
  onOpenNote: (rel: string) => void;
  onExit: (pos: number) => void;
}) {
  const store = `all_in_one_academic:lit:${slug}:${docName}`;
  const [saved, setSaved] = useState<Store>(() => lsGet(store));
  useEffect(() => { setSaved(lsGet(store)); }, [store]);
  const marks = saved.marks ?? {};
  const uncheckedOnly = saved.uncheckedOnly === true;
  const save = useCallback((patch: Store) => {
    setSaved((s) => { const n = { ...s, ...patch }; lsSet(store, n); return n; });
  }, [store]);

  const items = useMemo(() => buildItems(text, scanDocCites(text, citeMap)), [text, citeMap]);
  const [idx, setIdx] = useState(0);
  // open on the remembered cite once the list exists; afterwards keep the same cite when
  // the paper changes under it (its id, else the nearest index)
  const curId = useRef<string | null>(lsGet(store).key ?? null);
  useEffect(() => {
    if (!items.length) return;
    const at = curId.current ? items.findIndex((it) => it.id === curId.current) : -1;
    if (at >= 0) { if (at !== idx) setIdx(at); }
    else if (idx >= items.length) setIdx(items.length - 1);
  }, [items]);   // eslint-disable-line react-hooks/exhaustive-deps
  const cur = items[Math.min(idx, items.length - 1)] as Item | undefined;
  useEffect(() => { if (cur) { curId.current = cur.id; save({ key: cur.id }); } }, [cur?.id]);   // eslint-disable-line react-hooks/exhaustive-deps

  const counts = useMemo(() => {
    let ok = 0, flag = 0;
    for (const it of items) { const m = marks[it.id]; if (m === "ok") ok++; else if (m === "flag") flag++; }
    return { ok, flag, left: items.length - ok - flag };
  }, [items, marks]);

  const step = useCallback((dir: 1 | -1, only = uncheckedOnly) => {
    setIdx((i) => {
      for (let j = i + dir; j >= 0 && j < items.length; j += dir) if (!only || !marks[items[j].id]) return j;
      return i;
    });
  }, [items, marks, uncheckedOnly]);

  // the PDF target for this cite
  const [target, setTarget] = useState<CitePageTarget | null>(null);
  const [tErr, setTErr] = useState(false);
  const [detail, setDetail] = useState<CiteDetail | null>(null);
  const [adj, setAdj] = useState(0);
  const firstPage = (cur?.page || "").split(/[-–]/)[0];
  useEffect(() => {
    setTarget(null); setTErr(false); setDetail(null); setAdj(0);
    if (!cur || !cur.rel) return;
    let live = true;
    if (/\.pdf$/i.test(cur.rel)) {
      // a project-corpus PDF with no note: its printed pages are unknown, so p.N is page N
      const n = Number(firstPage) || 1;
      setTarget({ ok: true, pdfRel: cur.rel, pdfExists: true, physicalPage: n, printedPage: n, selection: "", quote: "", exact: false, noteRel: "" });
      return;
    }
    api.draftingCitePage(cur.rel, firstPage).then((r) => { if (!live) return; if (r.error) setTErr(true); else setTarget(r); }).catch(() => live && setTErr(true));
    citeDetailCached(cur.rel).then((d) => { if (live && d?.ok) setDetail(d); }).catch(() => {});
    return () => { live = false; };
  }, [cur?.rel, firstPage, cur?.id]);   // eslint-disable-line react-hooks/exhaustive-deps
  const pdfPage = target ? Math.max(1, (target.physicalPage || 1) + adj) : 1;
  const pdfSrc = target?.pdfExists ? api.draftingSourcePdfUrl(target.pdfRel) + "#page=" + pdfPage + "&zoom=page-width" : "";

  // open comments that touch the cite
  const onCite = useMemo(() => {
    if (!cur) return [];
    return comments.filter((c) => {
      if (!commentIsOpen(c)) return false;
      const r = locate(text, c);
      return !!r && r.from < cur.to && r.to > cur.from;
    });
  }, [comments, text, cur]);

  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState("");
  const noteRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (noting) noteRef.current?.focus(); }, [noting]);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => { rootRef.current?.focus({ preventScroll: true }); }, []);
  // small windows: keep the marked cite inside the left pane, which scrolls on its own
  const paneRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const pane = paneRef.current, m = pane?.querySelector<HTMLElement>("[data-lit-cite]");
    if (!pane || !m) return;
    const pr = pane.getBoundingClientRect(), mr = m.getBoundingClientRect();
    if (mr.top < pr.top || mr.bottom > pr.bottom) pane.scrollTop += mr.top - pr.top - Math.max(8, (pr.height - mr.height) / 2);
  }, [cur?.id, noting]);

  const markOk = useCallback(() => {
    if (!cur) return;
    const next = { ...marks }; if (next[cur.id] === "ok") delete next[cur.id]; else next[cur.id] = "ok";
    save({ marks: next });
    if (next[cur.id] === "ok") step(1, false);
  }, [cur, marks, save, step]);
  const fileFlag = () => {
    if (!cur) return;
    onFlag(cur.from, cur.to, note.trim());
    save({ marks: { ...marks, [cur.id]: "flag" } });
    setNoting(false); setNote("");
    step(1, false);
    rootRef.current?.focus({ preventScroll: true });
  };

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (paused || e.defaultPrevented) return;
      if (document.querySelector("[role=dialog][aria-modal=true]")) return;
      if ((e.target as HTMLElement | null)?.closest?.("[data-pdf-find-bar]")) return;
      if (e.key === "Escape") {
        if (noting) { e.preventDefault(); e.stopPropagation(); setNoting(false); rootRef.current?.focus({ preventScroll: true }); return; }
        e.preventDefault(); e.stopPropagation(); onExit(cur?.from ?? 0); return;
      }
      if (!typing(e.target) && pdfFindKey(e, rootRef.current?.querySelector<HTMLIFrameElement>("[data-lit-pdf]"))) return;
      if (typing(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key;
      const act = (fn: () => void) => { e.preventDefault(); e.stopPropagation(); fn(); };
      if (k === "ArrowRight" || k === "j") act(() => step(1));
      else if (k === "ArrowLeft" || k === "k") act(() => step(-1));
      else if (k === " " || k === "y" || k === "Enter") act(markOk);
      else if (k === "f") act(() => { setNote(""); setNoting(true); });
      else if (k === "u") act(() => save({ uncheckedOnly: !uncheckedOnly }));
      else if (k === "]") act(() => setAdj((a) => a + 1));
      else if (k === "[") act(() => setAdj((a) => a - 1));
      else if (k === "o") act(() => { if (cur?.rel && !/\.pdf$/i.test(cur.rel)) onOpenNote(cur.rel); });
      else if (k === "e") act(() => onExit(cur?.from ?? 0));
    };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [paused, noting, cur, step, markOk, save, uncheckedOnly, onExit, onOpenNote]);

  if (!items.length) {
    return (
      <div ref={rootRef} tabIndex={-1} data-literature-mode data-native-find data-review-pos={0} className="h-full flex items-center justify-center text-[13px] text-muted-foreground outline-none">
        No in-text citations in this document.
      </div>
    );
  }
  const it = cur!;
  const mark = marks[it.id];
  // the paragraph with this cite marked and its other cites underlined
  const siblings = items.filter((x) => x.paraFrom === it.paraFrom && x.id !== it.id);
  const cuts = [...siblings.map((s) => ({ from: s.from, to: s.to, me: false })), { from: it.from, to: it.to, me: true }].sort((a, b) => a.from - b.from);
  const segs: React.ReactNode[] = [];
  let at = it.paraFrom;
  cuts.forEach((c, i) => {
    if (c.from < at) return;
    segs.push(text.slice(at, c.from));
    segs.push(c.me
      ? <mark key={i} data-lit-cite className="rounded px-0.5 bg-primary/20 text-foreground ring-1 ring-primary/50">{text.slice(c.from, c.to)}</mark>
      : <span key={i} className="underline decoration-dotted decoration-muted-foreground/60 underline-offset-2">{text.slice(c.from, c.to)}</span>);
    at = c.to;
  });
  segs.push(text.slice(at, it.paraTo));
  const bad = it.status !== "resolved";
  const btn = "inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12px] text-muted-foreground hover:text-foreground hover:bg-accent disabled:opacity-40 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50";

  return (
    <div ref={rootRef} tabIndex={-1} data-literature-mode data-native-find data-review-pos={it.from} className="h-full flex flex-col outline-none">
      <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-border text-[12px] text-muted-foreground">
        <button type="button" className={btn} onClick={() => step(-1)} aria-label="Previous citation" title="Previous citation (← or k)"><ChevronLeft size={14} /></button>
        <span className="nums text-foreground whitespace-nowrap shrink-0" data-lit-pos>{idx + 1} / {items.length}</span>
        <button type="button" className={btn} onClick={() => step(1)} aria-label="Next citation" title="Next citation (→ or j)"><ChevronRight size={14} /></button>
        <span className="min-w-0 flex-1 truncate" title={it.section}>{it.section}</span>
        <button type="button" data-lit-unchecked aria-pressed={uncheckedOnly} onClick={() => save({ uncheckedOnly: !uncheckedOnly })}
          className={`${btn} shrink-0 whitespace-nowrap ${uncheckedOnly ? "text-foreground bg-primary/10" : ""}`} title="← → walk only cites not yet checked or flagged (u)">Unchecked only</button>
        <span className="nums whitespace-nowrap shrink-0" data-lit-counts title={`${counts.ok} checked, ${counts.flag} flagged, ${counts.left} to go`}>
          <Check size={12} className="inline -mt-0.5 text-primary" /> {counts.ok} · <Flag size={11} className="inline -mt-0.5 text-amber-500" /> {counts.flag} · {counts.left} left</span>
      </div>
      <div className="flex-1 min-h-0 flex flex-col md:flex-row">
        <div ref={paneRef} className="max-h-[42%] md:max-h-none md:w-[40%] min-h-0 shrink-0 overflow-y-auto tinybar border-b md:border-b-0 md:border-r border-border px-5 py-4 space-y-4">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[15px] font-medium" style={{ fontFamily: SERIF }}>{it.raw}</span>
            {bad && <span data-lit-status={it.status} title={STATUS_TIP[it.status] || it.status}
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] ${it.status === "prior" ? "bg-amber-500/15 text-amber-600 dark:text-amber-400" : "bg-rose-500/15 text-rose-600 dark:text-rose-400"}`}>
              <AlertTriangle size={11} />{it.status}</span>}
            {mark === "ok" && <span data-lit-mark="ok" className="inline-flex items-center gap-1 text-[11.5px] text-primary"><Check size={12} />checked</span>}
            {mark === "flag" && <span data-lit-mark="flag" className="inline-flex items-center gap-1 text-[11.5px] text-amber-600 dark:text-amber-400"><Flag size={11} />flagged</span>}
          </div>
          {noting ? (
            <form onSubmit={(e) => { e.preventDefault(); fileFlag(); }} className="flex gap-1.5">
              <input ref={noteRef} data-lit-note value={note} onChange={(e) => setNote(e.target.value)} placeholder="What is wrong with this cite"
                className="flex-1 min-w-0 rounded-md border border-primary/40 bg-background px-2 py-1 text-[12.5px] focus:outline-none focus:border-primary/60" />
              <button type="submit" className={btn} title="File the flag and move on (Enter)"><Flag size={12} />Flag</button>
            </form>
          ) : (
            <div className="flex items-center gap-1 flex-wrap">
              <button type="button" data-lit-ok className={btn} onClick={markOk} title="Checked, next (Space or y)"><Check size={13} />{mark === "ok" ? "Uncheck" : "Checked"}</button>
              <button type="button" data-lit-flag className={btn} onClick={() => { setNote(""); setNoting(true); }} title="Flag it with a note, filed as a comment on the cite (f)"><Flag size={12} />Flag</button>
              {it.rel && !/\.pdf$/i.test(it.rel) && <button type="button" className={btn} onClick={() => onOpenNote(it.rel)} title="Open the citation note (o)"><BookOpen size={12} />Note</button>}
              <button type="button" className={btn} onClick={() => onExit(it.from)} title="Back to the paper at this cite (e or Esc)">Edit</button>
            </div>
          )}
          {detail?.citation && <p data-lit-reference className="text-[12.5px] leading-snug text-foreground/80 border-l-2 border-primary/40 pl-2.5" style={{ fontFamily: SERIF }}>{detail.citation}</p>}
          <p data-lit-context className="text-[14.5px] leading-relaxed whitespace-pre-wrap text-foreground/90" style={{ fontFamily: SERIF }}>{segs}</p>
          {target?.quote && <p className="text-[12.5px] italic leading-snug text-foreground/70 border-l-2 border-border pl-2.5" style={{ fontFamily: SERIF }} title="Your stored quote on this page">“{target.quote}”</p>}
          {onCite.map((c) => (
            <div key={c.id} data-lit-comment className="rounded-md border border-amber-500/30 bg-amber-500/5 px-2.5 py-1.5 text-[12.5px] leading-snug">
              <Flag size={11} className="inline -mt-0.5 mr-1 text-amber-500" />{c.body || <span className="text-muted-foreground">(no note)</span>}</div>
          ))}
        </div>
        <div className="flex-1 min-h-0 min-w-0 flex flex-col">
          <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-border text-[11.5px] text-muted-foreground">
            <span className="min-w-0 flex-1 truncate" title={target?.pdfRel}>{target?.pdfRel ? target.pdfRel.split("/").pop() : ""}</span>
            {target?.pdfExists && <>
              <button type="button" className={btn} onClick={() => setAdj((a) => a - 1)} aria-label="Previous PDF page" title="Previous PDF page ([)"><ChevronLeft size={13} /></button>
              <span className="nums" data-lit-page title={target.exact ? "Exact page, from a stored highlight on it" : firstPage ? "Estimated page: printed page + this note's front-matter offset" : "No page in the cite"}>
                {firstPage ? `p.${it.page} → ` : ""}PDF p.{pdfPage}{target.exact || !firstPage || adj ? "" : " ≈"}</span>
              <button type="button" className={btn} onClick={() => setAdj((a) => a + 1)} aria-label="Next PDF page" title="Next PDF page (])"><ChevronRight size={13} /></button>
            </>}
          </div>
          <div className={`flex-1 min-h-[120px] ${pdfSrc ? "bg-neutral-800/40" : ""}`}>
            {!it.rel && <p className="p-5 text-[13px] text-muted-foreground"><AlertTriangle size={14} className="inline -mt-0.5 mr-1 text-amber-500" />{STATUS_TIP[it.status] || "No source for this cite"}.</p>}
            {it.rel && tErr && <p className="p-5 text-[13px] text-destructive">Couldn't resolve this citation's PDF.</p>}
            {it.rel && !tErr && !target && <p className="p-5 text-[13px] text-muted-foreground">Locating the page…</p>}
            {target && !target.pdfExists && (
              <p className="p-5 text-[13px] text-muted-foreground"><AlertTriangle size={14} className="inline -mt-0.5 mr-1 text-amber-500" />No PDF on disk for this source{target.pdfRel ? <> (expected at <code className="text-[11px]">{target.pdfRel}</code>)</> : null}.</p>
            )}
            {pdfSrc && target && <PdfFindFrame rel={target.pdfRel} page={pdfPage} title="Cited PDF" iframeProps={{ "data-lit-pdf": "" }} />}
          </div>
        </div>
      </div>
    </div>
  );
}
