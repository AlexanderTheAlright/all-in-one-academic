

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, ChevronLeft, ChevronRight, PanelRightClose, PanelRightOpen, X } from "lucide-react";
import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import { toast } from "sonner";
import { MarkdownEditor } from "@/lib/markdownEditor";
import { SERIF } from "@/components/draftingShared";
import type { MdEditorHandle, CRange, MentionInfo, MentionKey } from "@/lib/markdownEditor";
import type { DraftComment } from "@/lib/api";
import { locate, commentIsOpen, detachedPos } from "@/lib/anchors";
import type { DraftStyle } from "@/lib/draftStyle";
import { api, type RewriteEntry, type SuggestedParagraph } from "@/lib/api";
import { suggestionOverlap, suggestedSegments, SUGGESTION_OVERLAP_MAX } from "@/lib/suggestionOverlap";
import type { SuggestionTweak } from "@/lib/api";

/** an adopted suggestion's tweaks placed in its text, in order, never overlapping, numbered */
type PlacedTweak = SuggestionTweak & { n: number; from: number; to: number };
function placeTweaks(text: string, tweaks: SuggestionTweak[]): PlacedTweak[] {
  const out: PlacedTweak[] = [];
  for (const t of tweaks) {
    if (!t.text) continue;
    let i = text.indexOf(t.text);
    while (i >= 0 && out.some((o) => i < o.to && i + t.text.length > o.from)) i = text.indexOf(t.text, i + 1);
    if (i >= 0) out.push({ ...t, n: 0, from: i, to: i + t.text.length });
  }
  out.sort((a, b) => a.from - b.from).forEach((t, k) => { t.n = k + 1; });
  return out;
}
/** *italics* as italics: the suggestion is read, never edited, so no raw markdown stars */
function emph(text: string): ReactNode[] {
  return text.split(/(\*[^*\n]+\*)/g).map((x, i) => (i % 2 ? <em key={"e" + i + x}>{x.slice(1, -1)}</em> : x));
}

function tweakedText(text: string, tweaks: PlacedTweak[]): ReactNode[] {
  const out: ReactNode[] = [];
  let at = 0;
  for (const t of tweaks) {
    if (t.from > at) out.push(...emph(text.slice(at, t.from)));
    out.push(
      <mark key={"t" + t.n} data-rw-tweak={t.n} title={[t.why, t.was && `Yours: “${t.was}”`].filter(Boolean).join("\n")}
        className="rounded-sm bg-primary/15 px-0.5 text-foreground underline decoration-primary/70 decoration-[1.5px] underline-offset-[3px]">
        {text.slice(t.from, t.to)}<sup className="ml-0.5 text-[0.7em] font-medium text-primary">{t.n}</sup>
      </mark>,
    );
    at = t.to;
  }
  if (at < text.length) out.push(...emph(text.slice(at)));
  return out;
}
import { parseFocusParagraphs, paraAt, paraKey, resolvePara } from "@/lib/focusParagraphs";
import { sameness, contentOverlap, THRESH, type Sameness } from "@/lib/rewriteSameness";
import { withPos, relocate, newRewriteId, SKIP_SECTION, type RPara } from "@/lib/rewriteIdentity";
import { writePane, focusBackInside, selectInMain, type PaneRange } from "@/lib/paneWrite";

type Mem = { key?: string; idx?: number; slot?: string; unpassed?: boolean; scope?: "section" | "paper"; collapsed?: boolean };

type Slot = { sg: SuggestedParagraph; at: number; heading: string; section: string; lost?: boolean };
type Item = { kind: "p"; p: RPara; at: number } | { kind: "s"; s: Slot; at: number };
const sugNorm = (x: string) => (x || "").replace(/^#+\s*/, "").replace(/\*\*/g, "").replace(/\s+/g, " ").trim().toLowerCase();
function lsGet(k: string): Mem {
  try { const v = JSON.parse(localStorage.getItem(k) || "null"); return v && typeof v === "object" ? v : {}; } catch { return {}; }
}
function lsSet(k: string, v: Mem) {
  try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private window: per-session only */ }
}

/** the server's per-text cap (drafting._RW_TEXT): a longer paragraph cannot be an original */
const MAX_TEXT = 20000;

const typing = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.matches?.("input, textarea, select") || !!el.closest?.("[contenteditable=true], .cm-content"));
};

// the phrases still shared with the original, and the exempt spans (quotes, names, terms),
// marked in the live editor
type Marks = { shared: { from: number; to: number }[]; exempt: { from: number; to: number }[] };
const setMarks = StateEffect.define<Marks>();
const marksField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setMarks)) continue;
      const len = tr.state.doc.length;
      const sh = Decoration.mark({ class: "cm-rw-shared" }), ex = Decoration.mark({ class: "cm-rw-exempt", attributes: { title: "Exempt: quoted, a name or a defined term" } });
      const ok = (r: { from: number; to: number }) => r.from < r.to && r.to <= len;
      deco = Decoration.set([...e.value.shared.filter(ok).map((r) => sh.range(r.from, r.to)), ...e.value.exempt.filter(ok).map((r) => ex.range(r.from, r.to))], true);
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});
const marksExt: Extension = [marksField, EditorView.baseTheme({
  ".cm-rw-shared": { backgroundColor: "hsl(var(--primary) / 0.16)", borderBottom: "1.5px solid hsl(var(--primary) / 0.6)", borderRadius: "2px" },
  ".cm-rw-exempt": { textDecoration: "underline dotted hsl(var(--muted-foreground) / 0.55)", textUnderlineOffset: "3px" },
})];
const wired = new WeakSet<EditorView>();

type Status = "passed" | "progress" | "untouched";

/** what the Review menu shows for Rewrite, and what it can ask of it */
export type RewriteMenu = {
  hasEntry: boolean; canStart: boolean; startTip: string; busy: boolean;
  untouchedSection: number; untouchedPaper: number; notPassed: number;
  unplaced: { id: string; label: string; title: string }[]; canAttach: boolean;
};
export type RewriteApi = {
  startSection: () => void; startPaper: () => void; restart: () => void; drop: () => void;
  attach: (id: string) => void; dropUnplaced: (id: string) => void;
  // the pane's selection onto the main editor (a detached card's Attach acts on it); false
  // when it has none or the pane is out of step with the main text
  selectionToMain: () => boolean;
};
type Patch = Partial<Omit<RewriteEntry, "passedAt" | "best">> & { passedAt?: number | null; best?: number | null };

/** what the tab shows: the stored entry with this tab's unsent patch on top (null clears) */
function apply(base: RewriteEntry | undefined, p: Patch | undefined): RewriteEntry | undefined {
  if (!p) return base;
  const out = { ...(base ?? {}), ...p } as Record<string, unknown>;
  for (const k of Object.keys(p)) if ((p as Record<string, unknown>)[k] === null) delete out[k];
  return out as RewriteEntry;
}

export function RewriteMode({ slug, docName, text, main, style, zoom, citeMap, onCitationClick, onCitePage, onSave, onExit, startPos, ready = true,
  unpassedOnly = false, onUnpassedOnly, apiRef, onMenu, onContextMenu,
  comments = [], tick = 0, activeComment = null, onActivate, renderCard,
  onMention, onMentionKey, mentionActive = false, citeTarget }: {
  slug: string; docName: string;
  text: string;
  main: React.RefObject<MdEditorHandle | null>;
  style?: DraftStyle; zoom?: number;
  citeMap?: Record<string, { status: string; rel: string }>;
  onCitationClick?: (rel: string) => void; onCitePage?: (rel: string, page: string) => void;
  onSave: () => void;
  onExit: (pos: number) => void;
  startPos?: number;
  ready?: boolean;          // the text on screen has been checked against disk (no cached copy)
  unpassedOnly?: boolean;   // ← → walk only the paragraphs not yet passed
  onUnpassedOnly?: (on: boolean) => void;   // u (the Review menu holds the toggle)
  apiRef?: React.MutableRefObject<RewriteApi | null>;
  onMenu?: (m: RewriteMenu) => void;
  // right-click in the live paragraph: the host's drafting menu, which acts on the main editor
  onContextMenu?: (info: { x: number; y: number; hasSelection: boolean }) => void;
  comments?: DraftComment[];
  tick?: number;                                 // bumps when the main editor's ranges move
  activeComment?: string | null; onActivate?: (id: string | null) => void;
  renderCard?: (c: DraftComment, o: { onEscapeToText: () => void; onLocate: () => void; escapeTo: () => void }) => ReactNode;
  // the @ citation picker: this pane's editor is its target while Rewrite is open
  onMention?: (m: MentionInfo | null) => void; onMentionKey?: (k: MentionKey) => boolean; mentionActive?: boolean;
  citeTarget?: React.MutableRefObject<React.RefObject<MdEditorHandle | null> | null>;
}) {
  const store = `all_in_one_academic:rewrite:${slug}:${docName}`;
  const allParas = useMemo(() => withPos(parseFocusParagraphs(text), text), [text]);
  const rootRef = useRef<HTMLDivElement>(null);
  const fed = useRef<MdEditorHandle>(null);
  const textRef = useRef(text); textRef.current = text;
  const parasRef = useRef(allParas); parasRef.current = allParas;
  const onMentionRef = useRef(onMention); onMentionRef.current = onMention;
  useEffect(() => {
    if (!citeTarget) return;
    citeTarget.current = fed;
    return () => { citeTarget.current = null; onMentionRef.current?.(null); };
  }, [citeTarget]);

  const server = useRef<Record<string, RewriteEntry>>({});
  const overlay = useRef<Record<string, Patch>>({});
  const sendingRef = useRef<Record<string, Patch>>({});
  const baseRev = useRef<Record<string, number>>({});
  const inflight = useRef<Promise<void> | null>(null);
  const [entries, setEntriesRaw] = useState<Record<string, RewriteEntry>>({});
  const entriesRef = useRef(entries);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const timer = useRef<number | null>(null);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);

  const recompute = useCallback(() => {
    const out: Record<string, RewriteEntry> = {};
    for (const id of new Set([...Object.keys(server.current), ...Object.keys(sendingRef.current), ...Object.keys(overlay.current)])) {
      const e = apply(apply(server.current[id], sendingRef.current[id]), overlay.current[id]);
      if (e && !e.dropped && typeof e.baseline === "string" && e.baseline) out[id] = { ...e, id };
    }
    entriesRef.current = out;
    if (live.current) setEntriesRaw(out);
  }, []);
  const revOf = (id: string) => server.current[id]?.rev ?? 0;

  // Reads and saves can finish out of order. Merge each entry by revision, keeping
  // tombstones and entries absent from an older response.
  const mergeServer = useCallback((paras: Record<string, RewriteEntry> | undefined) => {
    if (!paras || typeof paras !== "object") return;
    for (const [id, e] of Object.entries(paras)) {
      if ((e.rev ?? 0) >= (server.current[id]?.rev ?? 0)) server.current[id] = e;
    }
  }, []);

  /** the store answered: take it, and drop any unsent change made on a revision that is
   *  no longer the stored one (another tab moved that entry: ours is stale) */
  const adopt = useCallback((paras: Record<string, RewriteEntry> | undefined) => {
    mergeServer(paras);
    for (const id of Object.keys(overlay.current)) {
      if ((baseRev.current[id] ?? 0) < revOf(id) || server.current[id]?.dropped) { delete overlay.current[id]; delete baseRev.current[id]; }
    }
    recompute();
  }, [recompute, mergeServer]);   // eslint-disable-line react-hooks/exhaustive-deps

  const flush = useCallback((): Promise<void> => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    if (inflight.current) return inflight.current.then(() => flush());
    const ids = Object.keys(overlay.current);
    if (!ids.length) return Promise.resolve();
    const sending = overlay.current, bases = baseRev.current;
    const set: Record<string, Patch & { rev: number }> = {};
    for (const id of ids) set[id] = { ...sending[id], rev: (bases[id] ?? 0) + 1 };
    overlay.current = {}; baseRev.current = {};
    sendingRef.current = sending;
    // a change made while this is in the air sits on the revision this write will get
    for (const id of ids) baseRev.current[id] = (bases[id] ?? 0) + 1;
    const p = api.draftingRewriteSave({ slug, doc: docName, set: set as Record<string, Partial<RewriteEntry> & { rev: number }> }).then((r) => {
      const stale = new Set(r.stale ?? []);
      sendingRef.current = {};
      mergeServer(r.paras);
      for (const id of ids) {
        if (stale.has(id) || server.current[id]?.dropped) { delete overlay.current[id]; delete baseRev.current[id]; }
        else if (!overlay.current[id]) delete baseRev.current[id];
      }
      if (stale.size) toast("Another window changed this original first; showing its version", { id: "rw-stale" });
      recompute();
    }).catch((err: { status?: number; message?: string }) => {
      sendingRef.current = {};
      if (err && typeof err.status === "number" && err.status >= 400 && err.status < 500) {
        // refused (too long, malformed): never resend the same bytes
        for (const id of ids) if (!overlay.current[id]) delete baseRev.current[id];
        toast.error("Rewrite could not save: " + (err.message || "refused"), { id: "rw-refused" });
        recompute();
        return;
      }
      // the connection dropped: put the change back under anything typed since, retry
      for (const id of ids) {
        overlay.current[id] = { ...sending[id], ...(overlay.current[id] ?? {}) };
        baseRev.current[id] = bases[id] ?? 0;
      }
      if (live.current && !timer.current) timer.current = window.setTimeout(() => { void flush(); }, 4000);
    }).finally(() => { inflight.current = null; });
    inflight.current = p;
    return p;
  }, [slug, docName, recompute, mergeServer]);

  const change = useCallback((id: string, patch: Patch, now = false) => {
    if (!(id in overlay.current)) { overlay.current[id] = {}; if (!(id in baseRev.current)) baseRev.current[id] = revOf(id); }
    overlay.current[id] = { ...overlay.current[id], ...patch };
    recompute();
    if (now) void flush();
    else if (!timer.current) timer.current = window.setTimeout(() => { void flush(); }, 1200);
  }, [recompute, flush]);   // eslint-disable-line react-hooks/exhaustive-deps

  /** read rewrite.json again (after any write in the air): another tab may have dropped,
   *  restarted or started something since this one last looked */
  const refetch = useCallback(async () => {
    try { await inflight.current; } catch { /* its own catch handles it */ }
    try {
      const r = await api.draftingRewrite(slug, docName);
      if (r && r.paras) { adopt(r.paras); if (live.current) setLoaded(true); }
      return true;
    } catch { return false; }
  }, [slug, docName, adopt]);

  useEffect(() => {
    let on = true;
    api.draftingRewrite(slug, docName).then((r) => {
      if (!on) return;
      adopt(r && r.paras && typeof r.paras === "object" ? r.paras : {});
      setLoaded(true);
    }).catch(() => { /* stay read-only until a retry loads the originals */ });
    return () => { on = false; };
  }, [slug, docName, adopt]);
  useEffect(() => () => { void flush(); }, [flush]);
  // coming back to the window is when another tab's changes matter
  useEffect(() => {
    const h = () => { if (!document.hidden) void refetch(); };
    window.addEventListener("focus", h);
    document.addEventListener("visibilitychange", h);
    return () => { window.removeEventListener("focus", h); document.removeEventListener("visibilitychange", h); };
  }, [refetch]);

  // ---- which paragraph each baseline belongs to --------------------------------------
  const relocated = useMemo(() => relocate(allParas, Object.values(entries), contentOverlap), [allParas, entries]);
  const eligible = useMemo(() => allParas.filter((p) => !SKIP_SECTION.test(p.section.trim())), [allParas]);

  const cache = useRef(new Map<string, Sameness>());
  const measure = useCallback((base: string, now: string): Sameness => {
    const k = base + "\u0000" + now;
    let m = cache.current.get(k);
    if (!m) {
      m = sameness(base, now);
      if (cache.current.size > 3000) cache.current.clear();
      cache.current.set(k, m);
    }
    return m;
  }, []);
  const statusOf = (p: RPara): Status => {
    const e = entryOf(p.i);
    if (!e) return "untouched";
    return measure(e.baseline, p.text).pass ? "passed" : "progress";
  };

  // ---- the paragraph on screen (Focus's write path) ----------------------------------
  const rangeRef = useRef<Omit<PaneRange, "empty"> | null>(null);
  const shownRef = useRef("");
  const keyRef = useRef("");
  const expectedRef = useRef(text);
  const [ver, setVer] = useState(0);
  const refocus = useRef<"editor" | "keep" | null>(null);
  const [, setSync] = useState(0);
  const unpassed = unpassedOnly;
  const emptyRef = useRef(false);
  const lastParaRef = useRef<RPara | null>(null);
  // the entry on screen: kept through the empty state so the new text stays its paragraph
  const shownIdRef = useRef<string | null>(null);
  // the suggestion whose empty slot is on screen (null on a paragraph)
  const slotRef = useRef<string | null>(null);
  const slotsRef = useRef<Slot[]>([]);
  const stickyRef = useRef(new Set<string>());
  const sugStickyRef = useRef<string[]>([]);

  const show = useCallback((p: RPara | undefined) => {
    if (!p) return;
    emptyRef.current = false;
    shownIdRef.current = null;
    slotRef.current = null;
    stickyRef.current = new Set();
    sugStickyRef.current = [];
    rangeRef.current = { from: p.from, to: p.to };
    shownRef.current = textRef.current.slice(p.from, p.to);
    keyRef.current = p.key;
    expectedRef.current = textRef.current;
    lsSet(store, { ...lsGet(store), key: p.key, idx: p.i, slot: undefined });
    refocus.current = document.activeElement?.closest?.("[data-rw-live]") ? "editor" : "keep";
    setVer((v) => v + 1);
  }, [store]);

  const started = useRef(false);
  if (!started.current) {
    started.current = true;
    const mem = lsGet(store);
    let i = mem.key || typeof mem.idx === "number" ? resolvePara(allParas, mem.key, mem.idx) : paraAt(allParas, startPos ?? 0);
    if (allParas[i] && SKIP_SECTION.test(allParas[i].section.trim())) i = eligible[0]?.i ?? -1;
    const p = allParas[i];
    if (p) { rangeRef.current = { from: p.from, to: p.to }; shownRef.current = text.slice(p.from, p.to); keyRef.current = p.key; }
  }
  const empty = emptyRef.current;
  const curIdx = rangeRef.current && !empty ? paraAt(allParas, rangeRef.current.from) : -1;
  const cur = curIdx >= 0 ? allParas[curIdx] : undefined;
  if (cur) lastParaRef.current = cur;
  const at = cur ?? (empty ? lastParaRef.current ?? undefined : undefined);
  const pinned = !empty && shownIdRef.current ? entries[shownIdRef.current] ?? entriesRef.current[shownIdRef.current] : undefined;
  const pinId = pinned ? pinned.id : null;
  const pinAt = pinId && cur ? cur.i : -1;
  const assign = useMemo(() => {
    if (!pinId || pinAt < 0) return relocated;
    const m = new Map(relocated);
    for (const [i, id] of m) if (id === pinId) m.delete(i);
    m.set(pinAt, pinId);
    return m;
  }, [relocated, pinId, pinAt]);
  const entryOf = (i: number): RewriteEntry | undefined => { const id = assign.get(i); return id ? entries[id] : undefined; };
  const curEntry = pinned ?? (cur ? entryOf(cur.i) : empty && shownIdRef.current ? entries[shownIdRef.current] : undefined);
  if (!empty && !pinned && cur) shownIdRef.current = curEntry?.id ?? null;
  const assignRef = useRef(assign); assignRef.current = assign;

  const resync = useCallback(() => {
    const ps = parasRef.current, t = textRef.current, r = rangeRef.current;
    expectedRef.current = t;
    if (!r) return;
    if (emptyRef.current) { delete r.framing; r.from = r.to = Math.min(r.from, t.length); setSync((n) => n + 1); return; }
    const i = resolvePara(ps, keyRef.current, paraAt(ps, Math.min(r.from, t.length)));
    const p = ps[i];
    if (!p) return;
    rangeRef.current = { from: p.from, to: p.to };
    keyRef.current = p.key;
    const now = t.slice(p.from, p.to);
    if (now !== shownRef.current) { shownRef.current = now; fed.current?.setContent(now); }
    setSync((n) => n + 1);
  }, []);

  // the entry on screen follows the typing: key + last re-find it next time
  const follow = useCallback((next: string) => {
    const id = shownIdRef.current;
    const e = id ? entriesRef.current[id] : undefined;
    if (!e || !next) return;
    const m = measure(e.baseline, next);
    const now = Date.now();
    const patch: Patch = { key: paraKey(next), last: next.slice(0, MAX_TEXT), updated: now };
    const best = Math.min(typeof e.best === "number" ? e.best : 100, m.score);
    if (best !== e.best) patch.best = best;
    if (m.pass && !e.passedAt) patch.passedAt = now;
    change(e.id, patch);
  }, [measure, change]);

  const onChange = useCallback((next: string) => {
    const r = rangeRef.current, v = main.current?.getView();
    if (!r || !v) return;
    const prev = shownRef.current;
    if (next === prev) return;
    if (!autoStartOk.current) { fed.current?.setContent(prev); return; }
    const was = emptyRef.current;
    const sl = was && slotRef.current && !shownIdRef.current ? slotsRef.current.find((s) => s.sg.id === slotRef.current) : undefined;
    if (sl && next) {
      r.from = r.to = sl.at; delete r.framing;
      const id = newRewriteId(), now = Date.now();
      shownIdRef.current = id;
      change(id, { baseline: sl.sg.text, heading: sl.heading, section: sl.section, pos: 0, key: paraKey(next), last: next.slice(0, MAX_TEXT), started: now, updated: now });
    }
    // the first keystroke in a paragraph with no original takes one: the text as it stood
    // just before this edit (never a stale cache: only once the disk copy is confirmed)
    if (!shownIdRef.current && !was && prev && autoStartOk.current && v.state.sliceDoc(r.from, r.to) === prev) {
      if (prev.length > MAX_TEXT) toast.error(`This paragraph is over ${MAX_TEXT.toLocaleString()} characters: too long for Rewrite`, { id: "rw-long" });
      else {
        const p = parasRef.current[paraAt(parasRef.current, r.from)];
        if (p && p.from === r.from) {
          // an original already taken from exactly this text and not placed (a twin key
          // group relocate() will not split) is this paragraph's: never take a second one
          const placed = new Set(assignRef.current.values());
          const twin = Object.values(entriesRef.current).filter((e) => !placed.has(e.id) && (e.last || e.baseline) === p.text)
            .sort((a, b) => (a.started ?? 0) - (b.started ?? 0))[0];
          if (twin) {
            shownIdRef.current = twin.id;
            change(twin.id, { key: p.key, heading: p.heading, section: p.section, pos: p.pos });
          } else {
            const { id, ...rest } = snap(p);
            shownIdRef.current = id;
            change(id, rest);
          }
        }
      }
    }
    const res = writePane(v, { ...r, empty: was }, prev, next);
    if (!res) { resync(); return; }   // never write blind
    rangeRef.current = res;
    emptyRef.current = res.empty;
    if (!res.empty) slotRef.current = null;
    shownRef.current = next;
    keyRef.current = paraKey(next);
    expectedRef.current = v.state.doc.toString();
    follow(next);
    if (was !== res.empty) setSync((n) => n + 1);
  }, [main, resync, follow, change]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (text !== expectedRef.current) resync(); }, [text, resync]);

  // ---- baselines ------------------------------------------------------------------------
  const snap = (p: RPara): RewriteEntry => ({
    id: newRewriteId(), baseline: p.text, heading: p.heading, section: p.section, pos: p.pos,
    key: p.key, last: p.text, started: Date.now(), updated: Date.now(),
  });
  const canStart = loaded && ready && !busy;
  const autoStartOk = useRef(false); autoStartOk.current = loaded && ready;
  const startTip = !loaded ? "Reading the saved originals…" : !ready ? "Waiting for the paper on disk…" : "Take this paragraph's current text as the original and start rewriting it (s)";
  /** every write that changes WHICH original a paragraph has looks at the store first */
  const guarded = async (fn: () => void) => {
    if (busy) return;
    setBusy(true);
    try { await refetch(); if (live.current) fn(); } finally { if (live.current) setBusy(false); }
  };
  const start = () => {
    if (!canStart || empty || !cur || curEntry) return;
    if (cur.text.length > MAX_TEXT) { toast.error(`This paragraph is over ${MAX_TEXT.toLocaleString()} characters: too long for Rewrite`, { id: "rw-long" }); return; }
    void guarded(() => {
      const p = parasRef.current[cur.i];
      if (!p || p.key !== cur.key) return;
      // another window may have started it meanwhile
      const again = relocate(parasRef.current, Object.values(entriesRef.current), contentOverlap);
      if (again.has(p.i)) return;
      const e = snap(p);
      const { id, ...rest } = e;
      change(id, rest, true);
    });
  };
  const startPass = (scope: "section" | "paper") => {
    if (!canStart) return;
    const sectionAt = at?.sectionAt;
    void guarded(() => {
      const ps = parasRef.current;
      const again = relocate(ps, Object.values(entriesRef.current), contentOverlap);
      let n = 0, long = 0;
      for (const p of ps) {
        if (SKIP_SECTION.test(p.section.trim()) || (scope === "section" && p.sectionAt !== sectionAt) || again.has(p.i)) continue;
        if (p.text.length > MAX_TEXT) { long++; continue; }
        const { id, ...rest } = snap(p);
        change(id, rest);
        n++;
      }
      if (n) void flush();
      if (long) toast(`${long} paragraph${long === 1 ? " is" : "s are"} over ${MAX_TEXT.toLocaleString()} characters and kept out of the pass`, { id: "rw-long" });
    });
  };
  const rebase = () => {
    const id = curEntry?.id;
    if (!id || !cur || busy) return;
    void guarded(() => {
      const e = entriesRef.current[id], p = parasRef.current[cur.i];
      if (!e || !p) return;
      if (p.text.length > MAX_TEXT) { toast.error(`This paragraph is over ${MAX_TEXT.toLocaleString()} characters: too long for Rewrite`, { id: "rw-long" }); return; }
      change(id, { baseline: p.text, last: p.text, key: p.key, heading: p.heading, section: p.section, pos: p.pos, started: Date.now(), updated: Date.now(), passedAt: null, best: null }, true);
    });
  };
  const dropId = (id: string | undefined) => {
    if (!id || busy) return;
    void guarded(() => { if (entriesRef.current[id]) change(id, { dropped: true }, true); });
  };
  const attach = (id: string) => {
    if (!cur || curEntry || busy) return;
    void guarded(() => {
      const p = parasRef.current[cur.i];
      if (!p || !entriesRef.current[id]) return;
      change(id, { key: p.key, last: p.text, heading: p.heading, section: p.section, pos: p.pos, updated: Date.now() }, true);
    });
  };

  // ---- suggested paragraphs: read only, each in its own slot ---------------------------
  const [suggested, setSuggested] = useState<SuggestedParagraph[]>([]);
  const loadSuggested = useCallback(() => {
    if (docName !== "paper.md" && docName !== "letter.md") return;
    api.draftingSuggested(slug).then((r) => {
      if (live.current) setSuggested(Array.isArray(r?.suggestions) ? r.suggestions : []);
    }).catch(() => { /* no store, or no paper: no suggestions */ });
  }, [slug, docName]);
  useEffect(() => {
    loadSuggested();
    const h = () => { if (!document.hidden) loadSuggested(); };
    window.addEventListener("focus", h);
    return () => window.removeEventListener("focus", h);
  }, [loadSuggested]);
  const sugTexts = useMemo(() => new Set(suggested.map((s) => s.text)), [suggested]);
  const { slotted, slots } = useMemo(() => {
    const out = new Map<number, SuggestedParagraph[]>();
    const floating: SuggestedParagraph[] = [];
    const slots: Slot[] = [];
    const add = (i: number, sg: SuggestedParagraph) => { const l = out.get(i) ?? []; if (!l.includes(sg)) l.push(sg); out.set(i, l); };
    const open = suggested.filter((s) => s.status === "open");
    const pairedAt = new Map<string, number>();
    for (const [i, id] of assign) {
      const b = entries[id]?.baseline;
      if (b) for (const sg of open) if (sg.text === b && !pairedAt.has(sg.id)) pairedAt.set(sg.id, i);
    }
    const lines: { from: number; to: number; text: string; level: number }[] = [];
    { let o = 0; for (const ln of text.split("\n")) { const hm = /^(#{1,6})\s+\S/.exec(ln); lines.push({ from: o, to: o + ln.length, text: ln, level: hm ? hm[1].length : 0 }); o += ln.length + 1; } }
    const title = (l: { text: string }) => l.text.replace(/^#+\s*/, "").trim();
    const slotAt = (h: string): Omit<Slot, "sg" | "lost"> | null => {
      const under = eligible.filter((p) => sugNorm(p.heading) === h || sugNorm(p.section) === h);
      const last = under[under.length - 1];
      let end: number, heading: string, section: string;
      if (last) { end = last.to; heading = last.heading; section = last.section; }
      else {
        let li = lines.findIndex((l) => l.level > 0 && sugNorm(l.text) === h);
        if (li < 0) li = lines.findIndex((l) => l.text.trim() && sugNorm(l.text).startsWith(h));
        if (li < 0) return null;
        let k = li;
        if (!lines[li].level) while (k + 1 < lines.length && lines[k + 1].text.trim() && !lines[k + 1].level) k++;   // past the whole block
        end = lines[k].to;
        let hi = li; while (hi >= 0 && !lines[hi].level) hi--;
        let si = hi; while (si >= 0 && !(lines[si].level > 0 && lines[si].level <= 2)) si--;
        heading = hi >= 0 ? title(lines[hi]) : ""; section = si >= 0 ? title(lines[si]) : heading;
      }
      const gap = /^\n*/.exec(text.slice(end))![0];
      return { at: end + gap.length, heading, section };
    };
    for (const sg of open) {
      const pi = pairedAt.get(sg.id);
      if (pi !== undefined) { add(pi, sg); continue; }
      let hit = false;
      // an anchor that is another suggestion's id says "after that one": store order does it
      const an = open.some((o) => o.id === sg.anchor) || suggested.some((o) => o.id === sg.anchor) ? "" : sugNorm(sg.anchor);
      if (an) for (const p of eligible) {
        const id = assign.get(p.i), base = id ? entries[id]?.baseline ?? "" : "";
        if (!sugNorm(p.text).startsWith(an) && !sugNorm(base).startsWith(an)) continue;
        hit = true; add(p.i, sg);
        const nx = allParas[p.i + 1];
        if (!sg.adopted && nx && nx.sectionAt === p.sectionAt && nx.heading === p.heading) add(nx.i, sg);
      }
      if (hit) continue;
      const h = sugNorm(sg.after);
      if (h) {
        const s = slotAt(h);
        if (s) { slots.push({ sg, ...s }); continue; }
      }
      if (allParas.length || slots.length) slots.push({ sg, at: text.length, heading: "Unplaced", section: "Unplaced", lost: true });
      else floating.push(sg);
    }
    return { slotted: { out, floating }, slots };
  }, [suggested, eligible, allParas, assign, entries, text]);
  slotsRef.current = slots;
  const curSlot = empty && slotRef.current && !shownIdRef.current ? slots.find((s) => s.sg.id === slotRef.current) : undefined;
  if (curSlot && rangeRef.current) { rangeRef.current.from = rangeRef.current.to = curSlot.at; delete rangeRef.current.framing; }

  const showSlot = (s: Slot) => {
    emptyRef.current = true;
    shownIdRef.current = null;
    slotRef.current = s.sg.id;
    stickyRef.current = new Set();
    sugStickyRef.current = [];
    rangeRef.current = { from: s.at, to: s.at };
    shownRef.current = "";
    keyRef.current = "";
    lastParaRef.current = { i: -1, from: s.at, to: s.at, key: "", heading: s.heading, section: s.section, sectionAt: -2, text: "", pos: 0 };
    expectedRef.current = textRef.current;
    lsSet(store, { ...lsGet(store), slot: s.sg.id });
    refocus.current = document.activeElement?.closest?.("[data-rw-live]") ? "editor" : "keep";
    setVer((v) => v + 1);
  };
  // a paper with only headings opens on its first slot; a remembered slot reopens
  const slotOpened = useRef(false);
  useEffect(() => {
    if (slotOpened.current || !slots.length) return;
    slotOpened.current = true;
    const mem = lsGet(store);
    const s = (mem.slot && slots.find((x) => x.sg.id === mem.slot)) || (!rangeRef.current ? slots[0] : undefined);
    if (s) showSlot(s);
  });   // eslint-disable-line react-hooks/exhaustive-deps

  // ---- moving ---------------------------------------------------------------------------
  const nav = unpassed ? eligible.filter((p) => statusOf(p) !== "passed" || p.i === cur?.i) : eligible;
  // the walk: paragraphs and the suggestions' empty slots, in document order (a slot sits
  // before a paragraph that starts where it does)
  const items: Item[] = [...nav.map((p): Item => ({ kind: "p", p, at: p.from })), ...slots.map((s): Item => ({ kind: "s", s, at: s.at }))]
    .sort((a, b) => a.at - b.at || (a.kind === b.kind ? 0 : a.kind === "s" ? -1 : 1));
  const pos = curSlot ? items.findIndex((it) => it.kind === "s" && it.s.sg.id === curSlot.sg.id)
    : cur ? items.findIndex((it) => it.kind === "p" && it.p.i === cur.i) : -1;
  const hole = empty ? rangeRef.current?.from ?? 0 : -1;
  const goTo = (it: Item | undefined) => { if (!it) return; void flush(); if (it.kind === "p") show(it.p); else showSlot(it.s); };
  const go = (dir: 1 | -1) => {
    if (pos >= 0) goTo(items[pos + dir]);
    else if (empty) goTo(dir > 0 ? items.find((it) => it.at >= hole) : [...items].reverse().find((it) => it.at < hole));
    else if (dir > 0) goTo(items[0]);
  };
  const hasPrev = pos >= 0 ? pos > 0 : empty ? items.some((it) => it.at < hole) : false;
  const hasNext = pos >= 0 ? pos < items.length - 1 : empty ? items.some((it) => it.at >= hole) : items.length > 0;
  // turning "Not passed only" on while a passed paragraph is on screen moves off it
  const wasUnpassed = useRef(unpassed);
  useEffect(() => {
    if (unpassed && !wasUnpassed.current && cur && statusOf(cur) === "passed") {
      const rest = eligible.filter((p) => statusOf(p) !== "passed");
      const n = rest.find((p) => p.i > cur.i) ?? rest[0];
      if (n) show(n);
    }
    wasUnpassed.current = unpassed;
  });   // eslint-disable-line react-hooks/exhaustive-deps

  // ---- the meter, and the marks in the live editor -------------------------------------
  const m = curEntry && (cur || empty) ? measure(curEntry.baseline, shownRef.current) : null;
  useEffect(() => {
    const t = setTimeout(() => {
      const v = fed.current?.getView();
      if (!v) return;
      if (!wired.has(v)) { wired.add(v); v.dispatch({ effects: StateEffect.appendConfig.of(marksExt) }); }
      v.dispatch({ effects: setMarks.of(m ? { shared: m.pass ? [] : m.shared, exempt: m.exempt } : { shared: [], exempt: [] }) });
    }, 0);
    return () => clearTimeout(t);
  });

  useEffect(() => {
    const h = (e: FocusEvent) => {
      const cm = main.current?.getView()?.contentDOM;
      if (cm && e.target instanceof Node && cm.contains(e.target)) (focusBackInside(rootRef.current, e) ?? rootRef.current)?.focus({ preventScroll: true });
    };
    document.addEventListener("focusin", h, true);
    return () => document.removeEventListener("focusin", h, true);
  }, [main]);
  useEffect(() => {
    const v = fed.current?.getView();
    if (v) v.dispatch({ effects: StateEffect.appendConfig.of(EditorView.contentAttributes.of({ tabindex: "-1" })) });
    const how = refocus.current; refocus.current = null;
    if (ver === 0 || how === "editor") {
      if (v) v.focus(); else rootRef.current?.focus({ preventScroll: true });
      return;
    }
    const a = document.activeElement;
    if (how && (!a || a === document.body || !rootRef.current?.contains(a))) rootRef.current?.focus({ preventScroll: true });
  }, [ver]);

  // the drafting menu comments and inserts through the MAIN editor's selection, so the
  // paragraph's selection (or the caret the right-click just placed) is put there first
  const onCtx = (info: { x: number; y: number; hasSelection: boolean }) => {
    if (!onContextMenu || !selectInMain(main.current?.getView(), fed.current?.getView(), rangeRef.current)) return;
    onContextMenu(info);
  };
  const exit = () => { void flush(); onExit(rangeRef.current?.from ?? 0); };
  const edit = () => fed.current?.focus();
  const toRoot = () => rootRef.current?.focus({ preventScroll: true });

  const MOVE: Record<string, 1 | -1> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 1, ArrowUp: -1 };
  const onKeyDownCapture = (e: React.KeyboardEvent) => {
    if (e.altKey && !e.ctrlKey && !e.metaKey && MOVE[e.key]) {
      e.preventDefault(); e.stopPropagation(); go(MOVE[e.key]);
      return;
    }
    // THE ESC LADDER: Esc in the paragraph leaves it for the layer in one press (a
    // selection collapsed on the way)
    if (e.key === "Escape" && mentionActive) return;   // the @ picker's own Esc (CodeMirror keymap)
    if (e.key === "Escape" && !e.defaultPrevented && (e.target as HTMLElement).closest?.("[data-rw-live] .cm-content")) {
      e.preventDefault(); e.stopPropagation();
      const v = fed.current?.getView();
      if (v && !v.state.selection.main.empty) v.dispatch({ selection: { anchor: v.state.selection.main.head } });
      toRoot();
    }
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.defaultPrevented) return;
    const t = e.target as HTMLElement;
    if (e.key === "Escape") {
      e.preventDefault();
      if (typing(t)) { toRoot(); return; }
      exit(); return;
    }
    if (typing(t) || e.ctrlKey || e.metaKey || e.altKey) return;
    const onRoot = t === rootRef.current;
    if (e.key === "j" || (onRoot && (e.key === "ArrowDown" || e.key === "ArrowRight"))) { e.preventDefault(); go(1); return; }
    if (e.key === "k" || (onRoot && (e.key === "ArrowUp" || e.key === "ArrowLeft"))) { e.preventDefault(); go(-1); return; }
    if (e.key === "s") { e.preventDefault(); start(); return; }
    if (e.key === "S") { e.preventDefault(); startPass("section"); return; }
    if (e.key === "u") { e.preventDefault(); onUnpassedOnly?.(!unpassed); return; }
    if (e.key === "d" && slotSugs.length) {
      e.preventDefault();
      dismissSug(t.closest?.("[data-rw-suggestion]")?.getAttribute("data-rw-suggestion") ?? slotSugs[0].id);
      return;
    }
    if (e.key === "c" && here.length) { e.preventDefault(); toRoot(); setNotesCollapsed(!notesCollapsed); return; }
    if ((e.key === "e" || (onRoot && e.key === "Enter")) && (cur || empty)) { e.preventDefault(); edit(); return; }
  };

  const notPassedAll = eligible.filter((p) => statusOf(p) !== "passed").length;

  const placedSugs = [...(curSlot ? [curSlot.sg] : at && !empty ? slotted.out.get(at.i) ?? [] : []), ...slotted.floating];
  for (const sg of placedSugs) if (!sugStickyRef.current.includes(sg.id)) sugStickyRef.current.push(sg.id);
  const slotSugs = [...placedSugs, ...sugStickyRef.current
    .filter((id) => !placedSugs.some((x) => x.id === id))
    .map((id) => suggested.find((x) => x.id === id))
    .filter((x): x is SuggestedParagraph => !!x && x.status === "open")];
  const setSugStatus = (id: string, status: "open" | "dismissed") => {
    setSuggested((xs) => xs.map((x) => (x.id === id ? { ...x, status } : x)));
    api.draftingSuggestedStatus(slug, id, status).then(() => {
      if (status === "dismissed") toast("Suggestion dismissed", { id: "rw-sug", action: { label: "Undo", onClick: () => setSugStatus(id, "open") } });
    }).catch((err: Error) => { toast.error("Could not save: " + err.message, { id: "rw-sug" }); loadSuggested(); });
  };
  const dismissSug = (id: string | undefined) => {
    if (!id) return;
    // dismissing the slot on screen moves on to the next place in the walk
    const nx = curSlot && curSlot.sg.id === id && pos >= 0 ? items[pos + 1] ?? items[pos - 1] : undefined;
    setSugStatus(id, "dismissed");
    if (nx) goTo(nx);
    toRoot();
  };
  // copy, cut, drag and the context menu never take a suggestion's words
  const blockSug = (e: React.SyntheticEvent) => { e.preventDefault(); e.stopPropagation(); };
  const onCopyCapture = (e: React.ClipboardEvent) => {
    const sel = window.getSelection();
    const hit = sel && !sel.isCollapsed && Array.from(rootRef.current?.querySelectorAll("[data-rw-suggestion]") ?? []).some((n) => sel.containsNode(n, true));
    if (hit) { e.preventDefault(); e.stopPropagation(); e.clipboardData?.setData("text/plain", ""); }
  };

  // ---- comments: everything anchored in this paragraph (as Focus) -------------------
  const noteStore = `all_in_one_academic:rewrite-notes:${slug}`;
  const [notesCollapsed, setNotesCollapsedRaw] = useState(() => lsGet(noteStore).collapsed === true);
  const setNotesCollapsed = (v: boolean) => { setNotesCollapsedRaw(v); lsSet(noteStore, { collapsed: v }); };
  void tick;
  const liveRanges = new Map((main.current?.commentRanges() ?? ([] as CRange[])).map((x) => [x.id, x] as const));
  const rr = rangeRef.current;
  const anchorOf = (c: DraftComment) => { const l = liveRanges.get(c.id); return l && l.to > l.from ? l : locate(text, c) ?? l; };
  const anchoredHere = rr && !empty ? comments
    .map((c) => ({ c, at: anchorOf(c) }))
    .filter((x) => commentIsOpen(x.c) && x.at && x.at.from <= rr.to && x.at.to >= rr.from)
    .sort((a, b) => (a.c.author && a.c.author !== "owner" ? 0 : 1) - (b.c.author && b.c.author !== "owner" ? 0 : 1)
      || a.at!.from - b.at!.from || a.c.created - b.c.created)
    .map((x) => x.c) : [];
  const memStore = `all_in_one_academic:rewrite-comments:${slug}:${docName}`;
  const memRef = useRef<{ store: string; m: Record<string, string[]> } | null>(null);
  if (!memRef.current || memRef.current.store !== memStore) {
    let m: Record<string, string[]> = {};
    try { const v = JSON.parse(localStorage.getItem(memStore) || "null"); if (v && typeof v === "object") m = v; } catch { /* per-session only */ }
    memRef.current = { store: memStore, m };
  }
  for (const c of anchoredHere) stickyRef.current.add(c.id);
  if (curEntry) {
    const had = memRef.current.m[curEntry.id] ?? [];
    const add = anchoredHere.map((c) => c.id).filter((id) => !had.includes(id));
    if (add.length) {
      memRef.current.m[curEntry.id] = [...had, ...add];
      try { localStorage.setItem(memStore, JSON.stringify(memRef.current.m)); } catch { /* per-session only */ }
    }
    for (const id of memRef.current.m[curEntry.id] ?? []) stickyRef.current.add(id);
  }
  const detachedHere = rr && renderCard ? comments.filter((c) => {
    if (!c.detached || !commentIsOpen(c) || anchorOf(c)) return false;
    const p = detachedPos(text, c); if (p == null) return false;
    if (empty) return Math.abs(p - rr.from) <= 2;
    const home = allParas.find((x) => x.to >= p) ?? allParas[allParas.length - 1];
    return !!home && home.from <= rr.to && home.to >= rr.from;
  }) : [];
  for (const c of detachedHere) stickyRef.current.add(c.id);
  const hereIds = new Set(anchoredHere.map((c) => c.id));
  const here = renderCard ? [...anchoredHere, ...comments.filter((c) => !hereIds.has(c.id) && stickyRef.current.has(c.id) && commentIsOpen(c))] : [];
  const caretAt = (id: string) => {
    const r0 = rangeRef.current; const l = main.current?.commentRanges().find((x) => x.id === id);
    if (r0 && l) fed.current?.caretTo(Math.max(0, l.from - r0.from)); else fed.current?.focus();
  };
  const crumb = at ? (at.heading && at.heading !== at.section ? `${at.section} › ${at.heading}` : at.section) : "";
  const arrow = "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50 disabled:opacity-30 disabled:pointer-events-none";
  const pct = (x: number) => Math.round(x * 100) + "%";
  const meterTip = m ? [
    m.pass ? "Passed" : m.reasons.join("\n"),
    "",
    `Sameness ${m.score} (pass at ${THRESH.sameness} or less)`,
    `Trigrams still in the original ${pct(m.containment)} (max ${pct(THRESH.containment)})`,
    `Longest shared run ${m.run} words (max ${THRESH.run})${m.runText ? `: "${m.runText}"` : ""}`,
    `Sentence skeleton ${m.skeleton.toFixed(2)}`,
    `Sentence openings reused ${pct(m.openings)}`,
    `Content words in the same order ${pct(m.order)}, kept ${pct(m.vocab)} (fails at ${pct(THRESH.order)} and ${pct(THRESH.vocab)} together)`,
    `Content words kept ${pct(m.content)} (not counted)`,
    m.exempt.length ? `Exempt (dotted): ${m.exempt.length} quoted span${m.exempt.length === 1 ? "" : "s"}, name${m.exempt.length === 1 ? "" : "s"} or term${m.exempt.length === 1 ? "" : "s"}` : "",
  ].filter((x, i, a) => x || (i > 0 && a[i - 1])).join("\n") : "";

  // ---- the Review menu's view of Rewrite, and its handle ---------------------------------
  const untouchedSection = at ? eligible.filter((p) => p.sectionAt === at.sectionAt && !assign.has(p.i)).length : 0;
  const untouchedPaper = eligible.filter((p) => !assign.has(p.i)).length;
  const menu: RewriteMenu = {
    hasEntry: !!curEntry, canStart, startTip, busy, untouchedSection, untouchedPaper, notPassed: notPassedAll,
    unplaced: [],
    canAttach: !!cur && !curEntry && !busy,
  };
  const menuSig = JSON.stringify(menu);
  const onMenuRef = useRef(onMenu); onMenuRef.current = onMenu;
  useEffect(() => { onMenuRef.current?.(JSON.parse(menuSig)); }, [menuSig]);
  if (apiRef) apiRef.current = {
    startSection: () => startPass("section"), startPaper: () => startPass("paper"),
    restart: rebase, drop: () => dropId(curEntry?.id),
    attach: (id) => { attach(id); toRoot(); }, dropUnplaced: (id) => dropId(id),
    selectionToMain: () => !!fed.current?.getView() && !fed.current.getView()!.state.selection.main.empty
      && selectInMain(main.current?.getView(), fed.current.getView(), rangeRef.current),
  };
  useEffect(() => () => { if (apiRef) apiRef.current = null; onMenuRef.current?.({ ...menu, unplaced: [], hasEntry: false }); }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div ref={rootRef} role="dialog" aria-label="Rewrite" data-knav-modal data-rewrite-mode data-rw-empty={empty ? "1" : undefined}
      data-review-pos={rangeRef.current?.from ?? 0}
      data-rw-ready={canStart ? "1" : "0"} data-rw-unpassed={unpassed ? "1" : "0"} tabIndex={-1}
      onKeyDownCapture={onKeyDownCapture} onKeyDown={onKeyDown} onCopyCapture={onCopyCapture} onCutCapture={onCopyCapture}
      className="absolute inset-0 z-[45] flex flex-col bg-background text-foreground focus:outline-none">
      <div data-rw-head className="flex h-8 shrink-0 items-center gap-1 border-b border-border/60 px-3">
        <button type="button" data-rw-prev className={arrow} onClick={() => go(-1)} disabled={!hasPrev}
          title="Previous paragraph (←)"><ChevronLeft size={14} /></button>
        <span data-rw-count className="min-w-[3.5rem] shrink-0 text-center text-[11px] tabular-nums text-muted-foreground"
          title={curSlot?.lost ? "This suggestion lost its place in the paper: dismiss it (d)" : curSlot ? "Your paragraph for this suggestion: type it here" : empty ? "An empty paragraph: type to put it back, or move on" : unpassed ? `Paragraph ${pos + 1} of the ${items.length} not yet passed` : `Paragraph ${pos + 1} of ${items.length}`}>
          {pos >= 0 ? pos + 1 : "–"} / {items.length}</span>
        <button type="button" data-rw-next className={arrow} onClick={() => go(1)} disabled={!hasNext}
          title="Next paragraph (→)"><ChevronRight size={14} /></button>
        <span data-rw-section className="ml-2 min-w-0 truncate text-[11px] text-muted-foreground/70" title={crumb}>{crumb}</span>
        <span className="flex-1" />
        {here.length > 0 && (
          <button type="button" data-rw-collapse aria-expanded={!notesCollapsed} className={arrow}
            title={notesCollapsed ? `Show comments (c): ${here.length}` : "Hide comments (c)"} onClick={() => setNotesCollapsed(!notesCollapsed)}>
            {notesCollapsed ? <PanelRightOpen size={14} /> : <PanelRightClose size={14} />}
          </button>
        )}
        {m ? (
          <span data-rw-meter data-pass={m.pass ? "1" : "0"} data-score={m.score} title={meterTip}
            className={`inline-flex shrink-0 items-center gap-1 text-[12px] tabular-nums ${m.pass ? "text-primary font-medium" : "text-foreground/80"}`}>
            <span data-rw-score aria-label={`Sameness ${m.score}`}>{m.score}</span>
            {m.pass && <Check data-rw-passed size={13} />}
          </span>
        ) : (cur || empty) && (
          <span data-rw-meter-idle className="shrink-0 text-[12px] tabular-nums text-muted-foreground/50"
            title={canStart ? "No original yet: start typing (or s) and the text as it stands becomes the original" : startTip}>{canStart ? "–" : "…"}</span>
        )}
      </div>
      <div className="flex min-h-0 flex-1">
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto tinybar">
        <div className="mx-auto w-full px-8 pt-6 pb-10" style={{ maxWidth: "calc(var(--draft-measure, 760px) + 64px)" }}>
          {curEntry && !sugTexts.has(curEntry.baseline) && !slotSugs.some((x) => x.adopted) && (
            <div data-rw-original aria-readonly="true" title={curEntry.started ? "The original, taken " + new Date(curEntry.started).toLocaleString() : "The original"}
              className="mb-5 select-text whitespace-pre-wrap border-l-2 border-border pl-3 text-foreground/45"
              style={{ fontFamily: `var(--draft-font, ${SERIF})`, fontSize: `calc(var(--draft-fontsize, 16.5px) * ${(zoom ?? 1) * 0.8})`, lineHeight: 1.55 }}>{curEntry.baseline}</div>
          )}
          {slotSugs.map((sg) => {
            const o = suggestionOverlap(shownRef.current, suggestedSegments(sg));
            const tweaks = sg.adopted ? placeTweaks(sg.text, sg.tweaks ?? []) : [];
            const tip = o.verbatim
              ? `A whole sentence of the suggestion is in your paragraph: "${o.verbatim}"`
              : `Shared 5-word phrases with ${sg.adopted ? "the highlighted tweaks" : "this suggestion"}: ${Math.round(o.score * 100)}% (too close at ${Math.round(SUGGESTION_OVERLAP_MAX * 100)}% or a whole sentence). Your own words and quotes are not counted.`;
            return (
              <div key={sg.id} data-rw-suggestion={sg.id} data-close={o.close ? "1" : "0"} aria-roledescription="suggestion"
                draggable={false} onCopy={blockSug} onCut={blockSug} onDragStart={blockSug} onContextMenu={blockSug}
                onMouseDown={(e) => { if (e.detail > 1) e.preventDefault(); }}
                style={{ userSelect: "none", WebkitUserSelect: "none" }}
                className="mb-5 max-h-[34vh] select-none overflow-y-auto tinybar rounded-md border border-dashed border-primary/45 bg-primary/[0.04] px-3 py-2">
                <div className="mb-1 flex items-center gap-2 text-[11px]">
                  <span className="shrink-0 whitespace-nowrap font-medium uppercase tracking-wide text-primary/80"
                    title={[sg.adopted && "Your paragraph, with the highlighted tweaks still to make", sg.after && `Slot: ${sg.after}`, sg.anchor && `After: "${sg.anchor}"`, sg.created && `Suggested ${sg.created}`].filter(Boolean).join("\n")}>
                    {sg.adopted ? `Your text · ${tweaks.length} ${tweaks.length === 1 ? "tweak" : "tweaks"}` : "Suggestion"}</span>
                  {sg.sources.length > 0 && <span className="min-w-0 truncate text-muted-foreground/70" title={sg.sources.join(", ")}>{sg.sources.join(", ")}</span>}
                  <span className="flex-1" />
                  {!o.none && (
                    <span data-rw-sug-overlap data-score={Math.round(o.score * 100)} title={tip}
                      className={`shrink-0 tabular-nums ${o.close ? "font-medium text-destructive" : "text-muted-foreground"}`}>
                      {Math.round(o.score * 100)}%{o.close && " · too close"}</span>
                  )}
                  <button type="button" data-rw-sug-dismiss className={arrow} title="Dismiss suggestion (d)"
                    onClick={() => dismissSug(sg.id)}><X size={13} /></button>
                </div>
                <div data-rw-sug-text className="whitespace-pre-wrap text-foreground/60"
                  style={{ fontFamily: `var(--draft-font, ${SERIF})`, fontSize: `calc(var(--draft-fontsize, 16.5px) * ${(zoom ?? 1) * 0.85})`, lineHeight: 1.55 }}>
                  {sg.adopted ? tweakedText(sg.text, tweaks) : emph(sg.text)}</div>
                {tweaks.length > 0 && (
                  <ol data-rw-sug-tweaks className="mt-2 space-y-0.5 border-t border-primary/20 pt-1.5 text-[11.5px] text-foreground/75">
                    {tweaks.map((t) => (
                      <li key={t.n} className="flex gap-1.5">
                        <span className="shrink-0 font-medium tabular-nums text-primary">{t.n}</span>
                        <span>{t.why || "Change"}{t.was && <span className="text-muted-foreground"> · yours: “{t.was}”</span>}</span>
                      </li>
                    ))}
                  </ol>
                )}
                {/* the card scrolls when it is taller than its cap: a fade marks the fold */}
                <div aria-hidden className="pointer-events-none sticky -bottom-2 -mx-3 -mb-2 h-6 bg-gradient-to-t from-background to-transparent" />
              </div>
            );
          })}
          <div data-rw-live aria-disabled={!loaded || !ready} title={!loaded || !ready ? startTip : undefined}
            className={!loaded || !ready ? "opacity-60" : undefined}>
            {cur || empty || pinned ? (
              <MarkdownEditor key={ver} ref={fed} value={shownRef.current} onChange={onChange}
                readOnly={!loaded || !ready || !!curSlot?.lost}
                slug={slug} style={style} zoom={zoom} citeMap={citeMap}
                onCitationClick={onCitationClick} onCitePage={onCitePage} onSave={onSave}
                onMention={onMention} onMentionKey={onMentionKey} mentionActive={mentionActive}
                onCursorComment={(id, o) => { if (id && o.pointer) onActivate?.(id); }}
                paragraphEnter
                onContextMenu={onContextMenu ? onCtx : undefined}
                placeholder="" />
            ) : (
              <div className="py-10 text-center text-[12px] text-muted-foreground">No paragraphs</div>
            )}
          </div>
        </div>
      </div>
      {here.length > 0 && renderCard && (
        <div data-rw-cards data-active={activeComment ?? undefined}
          style={notesCollapsed ? { display: "none" } : undefined}
          className="min-h-0 min-w-0 w-[40%] shrink-0 space-y-3 overflow-y-auto tinybar border-l border-border/60 bg-background p-2 sm:p-4">
          {here.map((c) => (
            <div key={c.id} data-rw-card={c.id}>
              {renderCard(c, { onEscapeToText: () => caretAt(c.id), onLocate: () => caretAt(c.id), escapeTo: toRoot })}
            </div>
          ))}
        </div>
      )}
      </div>
    </div>
  );
}
