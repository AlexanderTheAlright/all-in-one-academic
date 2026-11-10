
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { EditorState, Prec, Facet, StateField, StateEffect, ChangeSet, Compartment } from "@codemirror/state";
import type { Range, Transaction } from "@codemirror/state";
import { EditorView, Decoration, ViewPlugin, WidgetType, keymap, drawSelection, placeholder as cmPlaceholder } from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import { history, historyKeymap, defaultKeymap, indentWithTab, invertedEffects } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxTree, syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { search, findNext, findPrevious, selectNextOccurrence } from "@codemirror/search";
import { tags } from "@lezer/highlight";
import { softBreaks } from "./softBreaks";
import { findMath, texToMathML, mathDom } from "./texmath";
import type { MathSpan } from "./texmath";
import { DRAFT_STYLE_VARS } from "./draftStyle";
import type { DraftStyle } from "./draftStyle";

export type MdEditorHandle = {
  insertAtCursor: (text: string) => void;
  setContent: (text: string) => void;
  markSaveStart: (sentText: string) => void;
  adoptServerText: (sentText: string, mergedText: string) => boolean;
  replaceRange: (from: number, to: number, text: string) => void;
  getText: () => string;
  focus: () => void;
  scrollToLine: (line0: number) => void;
  posTop: (pos: number) => number;
  contentHeight: () => number;
  cursorPos: () => number;
  /** the selected text (every range, joined by a newline); "" when nothing is selected */
  selectedText: () => string;
  // find/replace is the app's own bar (components/drafting/FindBar.tsx), driven through
  // lib/cmFind.ts — this hands it the live view; CM's stock panel never shows
  getView: () => EditorView | null;
  requestMeasure: () => void;
  // anchored review comments
  setCommentRanges: (ranges: CRange[]) => void;     // reset highlights from saved anchors
  commentRanges: () => CRange[];                     // read back live (mapped) positions
  commentGoneAt: (id: string) => number | null;      // where a deleted span collapsed, mapped since
  setActiveComment: (id: string | null) => void;     // emphasise one comment's highlight
  setNumberFlags: (flags: NumRange[]) => void;       // inserted numbers that no longer match their cell
  selectionRange: () => { from: number; to: number; text: string } | null;
  scrollToPos: (pos: number) => void;
  caretTo: (pos: number) => void;
  posAtViewportY: (clientY: number) => number | null;
  screenTopOf: (pos: number) => number | null;
};

// the @-mention citation trigger: what the parent needs to anchor + query its popup
export type MentionInfo = { query: string; from: number; to: number; left: number; top: number; bottom: number };
export type MentionKey = "up" | "down" | "enter" | "escape" | "left" | "right" | "tab";

/** The single change that turns `a` into `b`: common prefix and suffix kept, the middle
 *  replaced. Never splits a surrogate pair. null when the texts are identical. */
function minimalChange(a: string, b: string): { from: number; to: number; insert: string } | null {
  if (a === b) return null;
  const max = Math.min(a.length, b.length);
  let s = 0;
  while (s < max && a.charCodeAt(s) === b.charCodeAt(s)) s++;
  if (s > 0) { const c = a.charCodeAt(s - 1); if (c >= 0xd800 && c <= 0xdbff) s--; }
  let e = 0;
  while (e < max - s && a.charCodeAt(a.length - 1 - e) === b.charCodeAt(b.length - 1 - e)) e++;
  if (e > 0) { const c = a.charCodeAt(a.length - e); if (c >= 0xdc00 && c <= 0xdfff) e--; }
  return { from: s, to: a.length - e, insert: b.slice(s, b.length - e) };
}

const HIDE = Decoration.replace({});
const lineClass = (cls: string) => Decoration.line({ class: cls });
const markClass = (cls: string) => Decoration.mark({ class: cls });

class ChipWidget extends WidgetType {
  label: string; kind: string;
  constructor(label: string, kind: string) { super(); this.label = label; this.kind = kind; }
  eq(o: ChipWidget) { return o.label === this.label && o.kind === this.kind; }
  toDOM() { const s = document.createElement("span"); s.className = this.kind === "embed" ? "cm-embed-chip" : "cm-wikilink-chip"; s.textContent = this.label; return s; }
  ignoreEvent() { return true; }
}

const assetBaseFacet = Facet.define<string, string>({ combine: (v) => (v.length ? v[0] : "") });
const setEmbeds = StateEffect.define<Record<string, string>>();
const embedField = StateField.define<Record<string, string>>({
  create: () => ({}),
  update: (v, tr) => { for (const e of tr.effects) if (e.is(setEmbeds)) return e.value; return v; },
});

const tablePngBaseFacet = Facet.define<string, string>({ combine: (v) => (v.length ? v[0] : "") });
const setTablePngs = StateEffect.define<Record<string, boolean>>();
const tablePngField = StateField.define<Record<string, boolean>>({
  create: () => ({}),
  update: (v, tr) => { for (const e of tr.effects) if (e.is(setTablePngs)) return e.value; return v; },
});

type CiteEntry = { status: string; rel: string };
export type FigRect = { id: string; n: number; rect: { x: number; y: number; w: number; h: number } };
const setFigureRects = StateEffect.define<Record<string, FigRect[]>>();
const figureRectsField = StateField.define<Record<string, FigRect[]>>({
  create: () => ({}),
  update: (v, tr) => { for (const e of tr.effects) if (e.is(setFigureRects)) return e.value; return v; },
});
export type EmbedProv = { status: string; label: string; suggestion?: string | null; diagram?: number | null; stamp?: string | null };
const setEmbedProv = StateEffect.define<Record<string, EmbedProv>>();
const embedProvField = StateField.define<Record<string, EmbedProv>>({
  create: () => ({}),
  update: (v, tr) => { for (const e of tr.effects) if (e.is(setEmbedProv)) return e.value; return v; },
});
function stampParam(p: EmbedProv | null | undefined): string {
  return p?.stamp ? "&v=" + encodeURIComponent(p.stamp) : "";
}
function assetVersionParam(p: EmbedProv | null | undefined): string {
  return stampParam(p) || (p?.diagram ? "&v=" + p.diagram : "");
}

const setCiteMap = StateEffect.define<Record<string, CiteEntry>>();
const citeMapField = StateField.define<Record<string, CiteEntry>>({
  create: () => ({}),
  update: (v, tr) => { for (const e of tr.effects) if (e.is(setCiteMap)) return e.value; return v; },
});

export type CRange = { id: string; from: number; to: number; resolved: boolean; reveal?: boolean };
const setCommentRanges = StateEffect.define<CRange[]>();
const setActiveComment = StateEffect.define<string | null>();
const restoreCommentSpan = StateEffect.define<CRange>({
  map: (r, ch) => ({ ...r, from: ch.mapPos(r.from, 1), to: ch.mapPos(r.to, -1) }),
});

export type NumRange = { id: string; from: number; to: number; kind: "drift" | "script"; title: string };
const setNumberFlagsFx = StateEffect.define<NumRange[]>();
function buildNumberDeco(flags: NumRange[], len: number): DecorationSet {
  const rs = flags
    .filter((f) => f.to > f.from && f.from >= 0 && f.to <= len)
    .sort((a, b) => a.from - b.from || a.to - b.to)
    .map((f) => Decoration.mark({
      class: f.kind === "drift" ? "cm-num-drift" : "cm-num-script",
      inclusive: false,
      attributes: { title: f.title, "data-num-flag": f.kind },
    }).range(f.from, f.to));
  return Decoration.set(rs, true);
}
const numberFlagField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setNumberFlagsFx)) return buildNumberDeco(e.value, tr.state.doc.length);
    return tr.docChanged ? v.map(tr.changes) : v;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export type PageBreakSpec = { offset: number; page: number };
const setPageBreaksFx = StateEffect.define<PageBreakSpec[]>();
class PageBreakWidget extends WidgetType {
  page: number;
  constructor(page: number) { super(); this.page = page; }
  eq(o: PageBreakWidget) { return o.page === this.page; }
  toDOM() {
    const s = document.createElement("span");
    s.className = "cm-pagebreak"; s.setAttribute("aria-hidden", "true");
    const r1 = document.createElement("span"); r1.className = "cm-pagebreak-rule";
    const lb = document.createElement("span"); lb.className = "cm-pagebreak-label"; lb.textContent = "page " + this.page;
    const r2 = document.createElement("span"); r2.className = "cm-pagebreak-rule";
    s.append(r1, lb, r2);
    return s;
  }
  ignoreEvent() { return true; }
}
class SoftSpaceWidget extends WidgetType {
  eq() { return true; }
  toDOM() { const s = document.createElement("span"); s.className = "cm-softbreak"; s.textContent = " "; return s; }
  ignoreEvent() { return false; }
}
const SOFT_SPACE = Decoration.replace({ widget: new SoftSpaceWidget() });
function buildSoftBreaks(state: EditorState): DecorationSet {
  return Decoration.set(softBreaks(state.doc.toString()).map((r) => SOFT_SPACE.range(r.from, r.to)));
}
const softBreakField = StateField.define<DecorationSet>({
  create: (state) => buildSoftBreaks(state),
  update: (v, tr) => (tr.docChanged ? buildSoftBreaks(tr.state) : v),
  provide: (f) => [EditorView.decorations.from(f), EditorView.atomicRanges.of((view) => view.state.field(f))],
});
const pageBreakField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(v, tr) {
    for (const e of tr.effects) {
      if (e.is(setPageBreaksFx)) {
        const len = tr.state.doc.length;
        return Decoration.set(
          e.value
            .filter((b) => b.offset > 0 && b.offset <= len)
            .map((b) => Decoration.widget({ widget: new PageBreakWidget(b.page), side: -1 }).range(Math.min(b.offset, len))),
          true);
      }
    }
    return tr.docChanged ? v.map(tr.changes) : v;
  },
  provide: (f) => EditorView.decorations.from(f),
});
type CSpec = { class: string; inclusive: boolean; id: string; resolved: boolean; reveal?: boolean };
function buildCommentDeco(ranges: CRange[], active: string | null): DecorationSet {
  const rs = ranges
    .filter((r) => r.to > r.from)
    .sort((a, b) => a.from - b.from || a.to - b.to)
    .map((r) => Decoration.mark({
      // Keep closed anchors mapped for the rail and undo, without painting them.
      class: r.resolved ? "" : "cm-comment-hl" + (r.id === active ? " cm-comment-active" : ""),
      inclusive: false, id: r.id, resolved: r.resolved, reveal: !!r.reveal && !r.resolved,
    } as CSpec).range(r.from, r.to));
  return Decoration.set(rs, true);
}
function readCommentRanges(set: DecorationSet): CRange[] {
  const out: CRange[] = [];
  const it = set.iter();
  while (it.value) {
    const s = it.value.spec as Partial<CSpec> | undefined;
    if (s && s.id) out.push({ id: s.id, from: it.from, to: it.to, resolved: !!s.resolved, ...(s.reveal ? { reveal: true } : null) });
    it.next();
  }
  return out;
}
const commentField = StateField.define<{ deco: DecorationSet; active: string | null; hidden: Set<string>; gone: Map<string, number> }>({
  create: () => ({ deco: Decoration.none, active: null, hidden: new Set<string>(), gone: new Map<string, number>() }),
  update(value, tr) {
    let deco = value.deco.map(tr.changes);
    let gone = value.gone;
    if (tr.docChanged) {
      if (gone.size) { gone = new Map(); for (const [id, p] of value.gone) gone.set(id, tr.changes.mapPos(p, -1)); }
      if (deco.size < value.deco.size) {
        const left = new Set(readCommentRanges(deco).map((r) => r.id));
        for (const r of readCommentRanges(value.deco)) if (!left.has(r.id)) { if (gone === value.gone) gone = new Map(gone); gone.set(r.id, tr.changes.mapPos(r.from, -1)); }
      }
    }
    let active = value.active, reset: CRange[] | null = null, restyle = false;
    const back: CRange[] = [];
    for (const e of tr.effects) {
      if (e.is(setCommentRanges)) reset = e.value;
      if (e.is(setActiveComment)) { active = e.value; restyle = true; }
      if (e.is(restoreCommentSpan)) back.push(e.value);
    }
    const hidden = new Set(value.hidden);
    if (reset) {
      const ids = new Set(reset.map((r) => r.id));
      // Explicit removal or resolution must survive an older undo event restoring
      // an open span. Text deletions still restore normally: their mapped span is gone.
      for (const r of readCommentRanges(deco)) if (!ids.has(r.id)) hidden.add(r.id);
      for (const r of reset) { if (r.resolved) hidden.add(r.id); else hidden.delete(r.id); }
      deco = buildCommentDeco(reset, active);
    }
    if (back.length) {
      const ids = new Set(back.map((r) => r.id));
      deco = buildCommentDeco([...readCommentRanges(deco).filter((r) => !ids.has(r.id)),
        ...back.map((r) => hidden.has(r.id) ? { ...r, resolved: true } : r)], active);
    }
    else if (restyle) deco = buildCommentDeco(readCommentRanges(deco), active);
    if (gone.size && (reset || back.length)) {
      const has = new Set(readCommentRanges(deco).map((r) => r.id));
      if ([...gone.keys()].some((id) => has.has(id))) { gone = new Map(gone); for (const id of has) gone.delete(id); }
    }
    return { deco, active, hidden, gone };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});
/** The spans of open suggested changes, which math and block embeds draw as source. */
function revealSpans(state: EditorState): { from: number; to: number }[] {
  const f = state.field(commentField, false);
  if (!f) return [];
  const out: { from: number; to: number }[] = [];
  const it = f.deco.iter();
  while (it.value) { const s = it.value.spec as Partial<CSpec> | undefined; if (s?.reveal) out.push({ from: it.from, to: it.to }); it.next(); }
  return out;
}
const commentsMoved = (tr: Transaction) => tr.startState.field(commentField, false)?.deco !== tr.state.field(commentField, false)?.deco;
// every comment span an edit deletes into (wholly or in part) is remembered in the undo
// event at its pre-edit extent, so ⌘Z restores the highlight along with the text.
const commentUndo = invertedEffects.of((tr) => {
  if (!tr.docChanged) return [];
  const spans = readCommentRanges(tr.startState.field(commentField).deco);
  if (!spans.length) return [];
  const out: StateEffect<unknown>[] = []; const seen = new Set<string>();
  tr.changes.iterChangedRanges((fromA, toA) => {
    if (toA <= fromA) return;
    for (const r of spans) if (!seen.has(r.id) && r.from < toA && r.to > fromA) { seen.add(r.id); out.push(restoreCommentSpan.of(r)); }
  });
  return out;
});
function commentIdAt(view: EditorView, pos: number): string | null {
  let id: string | null = null;
  const it = view.state.field(commentField).deco.iter();
  while (it.value) {
    const s = it.value.spec as Partial<CSpec> | undefined;
    if (s && s.id && !s.resolved && it.from <= pos && pos <= it.to) id = s.id;
    it.next();
  }
  return id;
}

const CITE_YEAR = "(?:1[6-9]\\d\\d|20\\d\\d)";
const CITE_PARTICLES = new Set(["van", "von", "de", "del", "della", "di", "da", "la", "le", "der", "den", "dos", "abu", "vander", "ten", "ter", "du", "dem", "st"]);
const CITE_COMBINING = new RegExp("[\\u0300-\\u036f]", "g");
const citeNormWord = (w: string) => w.normalize("NFKD").replace(CITE_COMBINING, "").toLowerCase().replace(/[^a-z]/g, "");
// lead-surname match key, mirroring references.py _lead_surname_phrase + _norm_key so the
// client key matches the server's resolver key exactly.
function citeLeadKey(author: string): string {
  const first = author.split(/,| and | & | et al/i)[0].trim();
  const toks = first.split(/\s+/).filter(Boolean);
  if (!toks.length) return "";
  const out: string[] = [];
  for (let i = 0; i < toks.length; i++) { out.push(toks[i]); if (CITE_PARTICLES.has(citeNormWord(toks[i])) && i + 1 < toks.length) continue; break; }
  return out.map(citeNormWord).join("");
}

export function citeKeyOf(token: string): string | null {
  const m = new RegExp("^(.*?)\\s+(" + CITE_YEAR + ")([a-z]?)\\s*$").exec((token || "").trim());
  if (!m || !m[1].trim()) return null;
  const k = citeLeadKey(m[1]);
  return k ? k + "|" + m[2] + m[3] : null;
}
/** The cite's map identity, mirroring references.py _cite_map_key: explicit author
 * lists retain every coauthor; an abbreviated et-al cite keeps its broad pattern. */
function citePattern(author: string): string {
  let a = author.replace(/['’]s\b/g, "");
  if (/\bet al\.?|\band colleagues\b/.test(a)) return "etal";
  a = a.trim().replace(/,$/, "").replace(/\s+and\s*$/, "").trim().replace(/,$/, "");
  const co = a.split(/,| and | & /).map((c) => c.trim()).filter(Boolean).slice(1).map(citeLeadKey).filter(Boolean);
  return co.length ? "co:" + co.join(",") : "solo";
}
/** cite-map lookup: "lead|year+letter|pattern" first, then the bare "lead|year" alias the
 * server sets only when every pattern under it names the same work. */
function citeLookup(map: Record<string, CiteEntry>, author: string, year: string, suf: string): CiteEntry | undefined {
  const lk = citeLeadKey(author) + "|" + year; const p = "|" + citePattern(author);
  return map[lk + suf + p] ?? (suf ? map[lk + p] : undefined) ?? map[lk + suf] ?? map[lk];
}

type CiteSpan = { from: number; to: number; entry: CiteEntry; page?: { from: number; to: number; num: string } };
const CITE_PAGE_RE = /^:\s?(\d+(?:[-–]\d+)?)/;   // an ASA page cite ':54' right after the year
function scanLineCites(text: string, lineFrom: number, map: Record<string, CiteEntry>): CiteSpan[] {
  const out: CiteSpan[] = [];
  const yearRe = new RegExp("\\b" + CITE_YEAR + "[a-z]?\\b");
  const paren = /\(([^()]*)\)/g;
  let pm: RegExpExecArray | null;
  while ((pm = paren.exec(text))) {
    const inner = pm[1];
    if (!yearRe.test(inner)) continue;
    const innerStart = pm.index + 1;
    let segOff = 0;
    for (const seg of inner.split(";")) {
      const m = new RegExp("^(\\s*)([^\\d].*?)\\s+(" + CITE_YEAR + ")([a-z]?)(?=[\\s,.:;)\\]]|$)").exec(seg);
      if (m) {
        // a lead-in ('see also', 'e.g.,', 'adapted from') is not the author: drop leading
        // lowercase words that are not name particles ('von', 'van der' stay)
        const lead = /^(?:([a-z][\w.]*,?)\s+)/;
        let lm: RegExpExecArray | null;
        while ((lm = lead.exec(m[2])) && !CITE_PARTICLES.has(citeNormWord(lm[1]))) { m[1] += lm[0]; m[2] = m[2].slice(lm[0].length); }
      }
      if (m && /[A-Z]/.test(m[2]) && !yearRe.test(m[2])) {
        const entry = citeLookup(map, m[2], m[3], m[4]);
        if (entry) {
          const citeTo = lineFrom + innerStart + segOff + m[0].length;
          const rec: CiteSpan = { from: lineFrom + innerStart + segOff + m[1].length, to: citeTo, entry };
          // a trailing ':page' immediately after the year -> a clickable page jump span
          const pg = CITE_PAGE_RE.exec(seg.slice(m[0].length));
          if (pg && entry.rel) rec.page = { from: citeTo, to: citeTo + pg[0].length, num: pg[1] };
          out.push(rec);
        }
        const moreRe = new RegExp("^(?::\\s?\\d+(?:[-–]\\d+)?)?(\\s*,\\s*)(" + CITE_YEAR + ")([a-z]?)(?=[\\s,.:;)\\]]|$)");
        let at = m[0].length, mm: RegExpExecArray | null;
        while ((mm = moreRe.exec(seg.slice(at)))) {
          const e2 = citeLookup(map, m[2], mm[2], mm[3]);
          const yFrom = lineFrom + innerStart + segOff + at + mm[0].length - mm[2].length - mm[3].length;
          if (e2) out.push({ from: yFrom, to: yFrom + mm[2].length + mm[3].length, entry: e2 });
          at += mm[0].length;
        }
      }
      segOff += seg.length + 1;
    }
  }
  // narrative "Author (Year)" or "Author (Year:page)" — capture the optional page inside.
  const narr = new RegExp("([A-Z][\\w'’.\\-]+(?:(?:,(?: and| &)?| and| &| et al\\.)\\s+[A-Z][\\w'’.\\-]+)*(?:\\s+et al\\.)?)\\s+\\((" + CITE_YEAR + ")([a-z]?)(?::(\\d+(?:[-–]\\d+)?))?\\)", "g");
  let nm: RegExpExecArray | null;
  while ((nm = narr.exec(text))) {
    const entry = citeLookup(map, nm[1].replace(/['’]s$/, ""), nm[2], nm[3]);
    if (!entry) continue;
    const rec: CiteSpan = { from: lineFrom + nm.index, to: lineFrom + nm.index + nm[0].length, entry };
    if (nm[4] && entry.rel) {
      const at = nm[0].lastIndexOf(":" + nm[4]);
      if (at >= 0) rec.page = { from: lineFrom + nm.index + at, to: lineFrom + nm.index + at + nm[4].length + 1, num: nm[4] };
    }
    out.push(rec);
  }
  return out;
}

export type DocCite = { from: number; to: number; status: string; rel: string; page: string };
export function scanDocCites(text: string, map: Record<string, CiteEntry>): DocCite[] {
  const out: DocCite[] = [];
  let pos = 0, inFm = false, inCmt = false;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i], from = pos;
    pos += ln.length + 1;
    if (i === 0 && ln.trim() === "---") { inFm = true; continue; }
    if (inFm) { if (ln.trim() === "---" || ln.trim() === "...") inFm = false; continue; }
    if (inCmt) { if (ln.includes("-->")) inCmt = false; continue; }
    if (ln.trimStart().startsWith("<!--")) { if (!ln.includes("-->")) inCmt = true; continue; }
    if (/^#{1,6}\s+(references|bibliography|works cited|literature cited)\s*$/i.test(ln.trim())) break;
    const spans = scanLineCites(ln, from, map).sort((a, b) => a.from - b.from);
    for (const s of spans) out.push({ from: s.from, to: Math.max(s.to, s.page?.to ?? 0), status: s.entry.status, rel: s.entry.rel, page: s.page?.num ?? "" });
  }
  return out;
}

const IMG_EXT = /\.(png|svg|jpe?g|gif|webp)$/i;

export type FigureCommentDetail = {
  from: number; text: string; x: number; y: number;
  rectPct: { x: number; y: number; w: number; h: number } | null;
};

export async function figureToPngBlob(src: string | string[]): Promise<Blob> {
  const candidates = Array.isArray(src) ? src : [src];
  let lastErr: unknown = new Error("no asset");
  for (const cand of candidates) {
    try {
      const blob = await (await fetch(cand)).blob();
      if (!/^image\//.test(blob.type)) throw new Error("not an image: " + blob.type);
      if (blob.type === "image/png") return blob;
      const url = URL.createObjectURL(blob);
      try {
        const im = await new Promise<HTMLImageElement>((res, rej) => {
          const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("load")); i.src = url;
        });
        const scale = 2;   // svg has no pixels of its own — rasterize at 2x for a crisp paste
        const w = Math.max(1, Math.round((im.naturalWidth || 1200) * scale));
        const h = Math.max(1, Math.round((im.naturalHeight || 800) * scale));
        const canvas = document.createElement("canvas"); canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext("2d")!;
        ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h);   // opaque bg so a transparent svg doesn't paste black
        ctx.drawImage(im, 0, 0, w, h);
        return await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("encode"))), "image/png"));
      } finally { URL.revokeObjectURL(url); }
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

function makeCopyButton(src: string | (() => string), rightPx: number): HTMLButtonElement {
  const GLYPH = "⧉";   // ⧉ overlapping squares — the universal copy affordance
  const btn = document.createElement("button");
  btn.type = "button"; btn.className = "cm-embed-copy-btn"; btn.style.right = rightPx + "px";
  btn.title = "Copy image to clipboard — paste it straight to a co-author";
  btn.textContent = GLYPH;
  btn.onmousedown = (e) => e.stopPropagation();
  btn.onclick = async (e) => {
    e.preventDefault(); e.stopPropagation();
    btn.disabled = true;
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": figureToPngBlob(typeof src === "function" ? src() : src) })]);
      btn.textContent = "✓"; btn.classList.add("copied");   // ✓
    } catch {
      btn.textContent = "✗"; btn.classList.add("failed");   // ✗
    }
    setTimeout(() => { btn.textContent = GLYPH; btn.classList.remove("copied", "failed"); btn.disabled = false; }, 1400);
  };
  return btn;
}

function wireCommentAffordances(view: EditorView, fig: HTMLElement, wrap: HTMLElement, img: HTMLImageElement, name: string, fullText: string, rects: FigRect[], noun: "figure" | "table"): HTMLButtonElement {
  const emit = (detail: FigureCommentDetail) => fig.dispatchEvent(new CustomEvent("cm-figure-comment", { bubbles: true, detail }));
  const expand = () => fig.dispatchEvent(new CustomEvent("cm-figure-expand", { bubbles: true, detail: { name } }));

  const commentBtn = document.createElement("button");
  commentBtn.type = "button";
  commentBtn.className = "cm-embed-comment-btn";
  commentBtn.title = "Comment on this " + noun + " — drag on the image to flag one region";
  commentBtn.textContent = "\u{1F4AC}";
  commentBtn.onmousedown = (e) => e.stopPropagation();
  commentBtn.onclick = (e) => {
    e.preventDefault(); e.stopPropagation();
    const from = view.posAtDOM(fig);
    const r = commentBtn.getBoundingClientRect();
    emit({ from, text: fullText, x: r.left, y: r.bottom, rectPct: null });
  };

  // drag-to-select a region on the image itself; a plain click (no meaningful drag)
  // opens the full view instead
  let dragStart: { x: number; y: number } | null = null;
  let box: HTMLDivElement | null = null;
  img.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const r = wrap.getBoundingClientRect();
    dragStart = { x: e.clientX, y: e.clientY };
    box = document.createElement("div"); box.className = "cm-embed-comment-rect";
    wrap.appendChild(box);
    const onMove = (ev: MouseEvent) => {
      if (!dragStart || !box) return;
      const x0 = Math.min(dragStart.x, ev.clientX), x1 = Math.max(dragStart.x, ev.clientX);
      const y0 = Math.min(dragStart.y, ev.clientY), y1 = Math.max(dragStart.y, ev.clientY);
      box.style.left = (x0 - r.left) + "px"; box.style.top = (y0 - r.top) + "px";
      box.style.width = (x1 - x0) + "px"; box.style.height = (y1 - y0) + "px";
    };
    const onUp = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      const dx = Math.abs(ev.clientX - dragStart!.x), dy = Math.abs(ev.clientY - dragStart!.y);
      const from = view.posAtDOM(fig);
      if (dx < 6 && dy < 6) {
        box?.remove();
        expand();   // a plain click opens the full view (drag still flags a region)
      } else {
        const x0 = Math.min(dragStart!.x, ev.clientX), x1 = Math.max(dragStart!.x, ev.clientX);
        const y0 = Math.min(dragStart!.y, ev.clientY), y1 = Math.max(dragStart!.y, ev.clientY);
        const rectPct = { x: (x0 - r.left) / r.width, y: (y0 - r.top) / r.height, w: (x1 - x0) / r.width, h: (y1 - y0) / r.height };
        box?.remove();
        emit({ from, text: fullText, x: ev.clientX, y: ev.clientY, rectPct });
      }
      dragStart = null; box = null;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });

  // persistent numbered overlays — one amber rect per OPEN comment with a region;
  // the badge is the clickable part (the rect itself never eats the drag)
  for (const fr of rects) {
    const o = document.createElement("div"); o.className = "cm-embed-rect";
    o.style.left = (fr.rect.x * 100) + "%"; o.style.top = (fr.rect.y * 100) + "%";
    o.style.width = (fr.rect.w * 100) + "%"; o.style.height = (fr.rect.h * 100) + "%";
    const b = document.createElement("button"); b.type = "button"; b.className = "cm-embed-rect-badge";
    b.textContent = String(fr.n);
    b.title = "Open comment #" + fr.n;
    b.onmousedown = (e) => e.stopPropagation();
    b.onclick = (e) => {
      e.preventDefault(); e.stopPropagation();
      fig.dispatchEvent(new CustomEvent("cm-figure-rect", { bubbles: true, detail: { id: fr.id } }));
    };
    o.appendChild(b);
    wrap.appendChild(o);
  }

  return commentBtn;
}

function blockWrap(inner: HTMLElement, kind: "fig" | "tablepng" | "latex" | "table"): HTMLElement {
  const o = document.createElement("div");
  o.className = "cm-embed-block cm-embed-block-" + kind;
  o.appendChild(inner);
  return o;
}

class ImgWidget extends WidgetType {
  name: string; src: string; fullText: string; rects: FigRect[]; prov: EmbedProv | null;
  rectsKey: string; provKey: string; block: boolean;
  constructor(name: string, src: string, fullText: string, rects: FigRect[] = [], prov: EmbedProv | null = null, block = false) {
    super(); this.name = name; this.src = src; this.fullText = fullText;
    this.rects = rects; this.prov = prov; this.block = block;
    // eq() folds EVERY input in via precomputed keys — comparing only src silently
    // freezes new widget data (a rect/prov change must re-render the embed)
    this.rectsKey = JSON.stringify(rects); this.provKey = JSON.stringify(prov);
  }
  eq(o: ImgWidget) { return o.src === this.src && o.rectsKey === this.rectsKey && o.provKey === this.provKey && o.block === this.block; }
  toDOM(view: EditorView) {
    const fig = document.createElement("div"); fig.className = "cm-embed-fig";
    const wrap = document.createElement("div"); wrap.className = "cm-embed-imgwrap";
    const img = document.createElement("img"); img.src = this.src; img.alt = this.name; img.loading = "lazy";
    img.onload = () => { try { view.requestMeasure(); } catch { /* noop */ } };
    img.onerror = () => {
      fig.className = "cm-embed-chip";
      fig.textContent = "figure not found: " + this.name
        + (this.prov?.suggestion ? " — did you mean " + this.prov.suggestion + "?" : "");
    };
    const cap = document.createElement("div"); cap.className = "cm-embed-cap";

    const commentBtn = wireCommentAffordances(view, fig, wrap, img, this.name, this.fullText, this.rects, "figure");

    // full-view: open the lightbox to inspect the figure large and drop precise pins
    const expandBtn = document.createElement("button");
    expandBtn.type = "button";
    expandBtn.className = "cm-embed-expand-btn";
    expandBtn.title = "Open full view — inspect large, comment coordinate by coordinate";
    expandBtn.textContent = "⤢";   // ⤢ diagonal arrows
    expandBtn.onmousedown = (e) => e.stopPropagation();
    expandBtn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); fig.dispatchEvent(new CustomEvent("cm-figure-expand", { bubbles: true, detail: { name: this.name } })); };

    // copy the figure to the clipboard for sharing with co-authors (left of comment/expand)
    const copyBtn = makeCopyButton(this.src, 62);

    // hand-drawn concept diagram (a results/<stem>.drawio source exists): open the
    // pop-out draw.io editor on it (left of the copy button)
    let diagramBtn: HTMLButtonElement | null = null;
    if (this.prov?.diagram) {
      diagramBtn = document.createElement("button");
      diagramBtn.type = "button"; diagramBtn.className = "cm-embed-diagram-btn"; diagramBtn.style.right = "90px";
      diagramBtn.title = "Edit diagram — reopen this figure's draw.io source";
      diagramBtn.textContent = "✎";   // ✎ pencil — the edit affordance
      diagramBtn.onmousedown = (e) => e.stopPropagation();
      diagramBtn.onclick = (e) => {
        e.preventDefault(); e.stopPropagation();
        fig.dispatchEvent(new CustomEvent("cm-diagram-edit", { bubbles: true, detail: { name: this.name } }));
      };
    }

    if (this.prov?.status) {
      const chip = document.createElement("button"); chip.type = "button";
      chip.className = "cm-embed-prov cm-embed-prov-" + this.prov.status;
      chip.textContent = this.prov.label;
      chip.title = "Provenance — the exact script, data, and freshness behind this asset";
      chip.onmousedown = (e) => e.stopPropagation();
      chip.onclick = (e) => {
        e.preventDefault(); e.stopPropagation();
        const r = chip.getBoundingClientRect();
        fig.dispatchEvent(new CustomEvent("cm-provenance-open", { bubbles: true, detail: { name: this.name, x: r.left, y: r.bottom } }));
      };
      cap.appendChild(chip);
    }

    wrap.appendChild(img);
    fig.appendChild(wrap); fig.appendChild(commentBtn); fig.appendChild(expandBtn); fig.appendChild(copyBtn);
    if (diagramBtn) fig.appendChild(diagramBtn);
    if (cap.childNodes.length) fig.appendChild(cap);   // no empty strip when an embed has no provenance chip
    return this.block ? blockWrap(fig, "fig") : fig;
  }
  ignoreEvent() { return true; }
}

class TablePngWidget extends WidgetType {
  name: string; src: string; fullText: string; rects: FigRect[]; rectsKey: string;
  constructor(name: string, src: string, fullText: string, rects: FigRect[] = []) {
    super(); this.name = name; this.src = src; this.fullText = fullText;
    this.rects = rects; this.rectsKey = JSON.stringify(rects);
  }
  eq(o: TablePngWidget) { return o.src === this.src && o.rectsKey === this.rectsKey; }
  toDOM(view: EditorView) {
    const fig = document.createElement("div"); fig.className = "cm-embed-fig cm-table-png";
    const wrap = document.createElement("div"); wrap.className = "cm-embed-imgwrap";
    const img = document.createElement("img"); img.src = this.src; img.alt = this.name; img.loading = "lazy";
    img.onload = () => { try { view.requestMeasure(); } catch { /* noop */ } };
    img.onerror = () => { fig.className = "cm-embed-chip"; fig.textContent = "table not typeset yet: " + this.name; };
    // same comment affordances as a figure: whole-table comment, drag a region, overlays
    const commentBtn = wireCommentAffordances(view, fig, wrap, img, this.name, this.fullText, this.rects, "table");
    const expandBtn = document.createElement("button");
    expandBtn.type = "button"; expandBtn.className = "cm-embed-expand-btn";
    expandBtn.title = "Open full view — inspect large, comment coordinate by coordinate"; expandBtn.textContent = "⤢";
    expandBtn.onmousedown = (e) => e.stopPropagation();
    expandBtn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); fig.dispatchEvent(new CustomEvent("cm-figure-expand", { bubbles: true, detail: { name: this.name } })); };
    // copy the typeset table image to the clipboard (left of comment/expand)
    const copyBtn = makeCopyButton(this.src, 62);
    wrap.appendChild(img);
    fig.appendChild(wrap); fig.appendChild(commentBtn); fig.appendChild(expandBtn); fig.appendChild(copyBtn);
    return blockWrap(fig, "tablepng");   // only ever a block embed
  }
  ignoreEvent() { return true; }
}

function renderTable(md: string): HTMLElement {
  const wrap = document.createElement("div"); wrap.className = "cm-table-wrap";
  const rows = md.split("\n").map((l) => l.trim()).filter((l) => l.includes("|"));
  const dataRows = rows.filter((r) => !/^\|?[\s:|-]+\|?$/.test(r));
  if (!dataRows.length) { wrap.className = "cm-embed-chip"; wrap.textContent = md.trim().slice(0, 120) || "empty table"; return wrap; }
  const table = document.createElement("table"); table.className = "cm-table";
  dataRows.forEach((r, i) => {
    const cells = r.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim().replace(/\*\*/g, ""));
    const tr = document.createElement("tr");
    cells.forEach((c) => { const cell = document.createElement(i === 0 ? "th" : "td"); cell.textContent = c; tr.appendChild(cell); });
    table.appendChild(tr);
  });
  wrap.appendChild(table);
  return wrap;
}

class TableWidget extends WidgetType {
  md: string; key: string; block: boolean;
  constructor(md: string, key: string, block = false) { super(); this.md = md; this.key = key; this.block = block; }
  eq(o: TableWidget) { return o.md === this.md && o.key === this.key && o.block === this.block; }
  toDOM() { const t = renderTable(this.md); return this.block ? blockWrap(t, "table") : t; }
  ignoreEvent() { return true; }
}

function findTableBlocks(state: EditorState): { from: number; to: number; md: string }[] {
  const doc = state.doc;
  const isDelim = (s: string) => s.includes("|") && s.includes("-") && /^[\s|:-]+$/.test(s.trim());
  const isRow = (s: string) => s.includes("|") && s.trim() !== "";
  const blocks: { from: number; to: number; md: string }[] = [];
  let l = 1;
  while (l < doc.lines) {
    const head = doc.line(l);
    if (isRow(head.text) && !isDelim(head.text) && isDelim(doc.line(l + 1).text)) {
      let end = l + 1;
      while (end + 1 <= doc.lines && isRow(doc.line(end + 1).text) && !isDelim(doc.line(end + 1).text)) end++;
      const from = head.from, to = doc.line(end).to;
      blocks.push({ from, to, md: doc.sliceString(from, to) });
      l = end + 1;
    } else l++;
  }
  return blocks;
}

// table ranges the cursor is NOT inside — used both to render the block widget and
// to stop the live-preview plugin from decorating (and thus overlapping) those lines.
function inactiveTableRanges(state: EditorState): { from: number; to: number }[] {
  const sel = state.selection.main;
  return findTableBlocks(state)
    .filter((b) => !(sel.from <= b.to && sel.to >= b.from))
    .map((b) => ({ from: b.from, to: b.to }));
}

// clicking the rendered table drops the caret at its edge, which reveals the raw
// markdown for editing — unlike the read-only ![[embed]] tables, which ignore clicks.
class InlineTableWidget extends TableWidget {
  ignoreEvent() { return false; }
}

function buildTableDecos(state: EditorState): DecorationSet {
  const sel = state.selection.main;
  const decos = findTableBlocks(state)
    .filter((b) => !(sel.from <= b.to && sel.to >= b.from))
    .map((b) => Decoration.replace({ widget: new InlineTableWidget(b.md, "t" + b.from, true), block: true }).range(b.from, b.to));
  return Decoration.set(decos, true);
}

const tableField = StateField.define<DecorationSet>({
  create: (state) => buildTableDecos(state),
  update: (value, tr) => (tr.docChanged || tr.selection ? buildTableDecos(tr.state) : value),
  provide: (f) => EditorView.decorations.from(f),
});

const BLOCK_EMBED_RE = /^!\[\[([^\]]+)\]\]$/;
function blockEmbedBase(lineText: string): string | null {
  const m = BLOCK_EMBED_RE.exec(lineText.trim());
  if (!m) return null;
  return m[1].split("|")[0].trim();
}
// Older comment/provenance records use basenames. Resolve those as a fallback,
// but asset requests and prefetched content always keep the exact embed path.
function embedMetadata<T>(map: Record<string, T>, path: string): T | undefined {
  return map[path] ?? map[path.split("/").pop() || path];
}
function buildBlockEmbeds(state: EditorState): DecorationSet {
  const sel = state.selection.main;
  const assetBase = state.facet(assetBaseFacet);
  const tablePngBase = state.facet(tablePngBaseFacet);
  const embeds = state.field(embedField, false) ?? {};
  const tablePngs = state.field(tablePngField, false) ?? {};
  const figRects = state.field(figureRectsField, false) ?? {};
  const provMap = state.field(embedProvField, false) ?? {};
  const reveal = revealSpans(state);
  const decos: { from: number; to: number; deco: Decoration }[] = [];
  for (let l = 1; l <= state.doc.lines; l++) {
    const line = state.doc.line(l);
    const base = blockEmbedBase(line.text);
    if (!base) continue;
    if (sel.from <= line.to && sel.to >= line.from) continue;   // cursor inside -> reveal raw
    if (reveal.some((r) => r.from < line.to && r.to > line.from)) continue;   // an open suggestion inside -> raw
    let widget: WidgetType;
    if (IMG_EXT.test(base) && assetBase) {
      // the results stamp — else a hand-drawn diagram's mtime — rides the src, so a
      // re-rendered figure swaps in and an unchanged one is never re-downloaded
      const p = embedMetadata(provMap, base) || null;
      widget = new ImgWidget(base, assetBase + encodeURIComponent(base) + assetVersionParam(p), line.text, embedMetadata(figRects, base) || [], p, true);
    }
    else if (/\.pdf$/i.test(base) && tablePngBase) {
      const p = embedMetadata(provMap, base) || null;
      widget = new ImgWidget(base, tablePngBase + encodeURIComponent(base) + assetVersionParam(p), line.text, embedMetadata(figRects, base) || [], p, true);
    }
    else if (/\.(md|csv|txt)$/i.test(base)) {
      if (tablePngs[base] && tablePngBase) widget = new TablePngWidget(base, tablePngBase + encodeURIComponent(base), line.text, embedMetadata(figRects, base) || []);
      else { const md = embeds[base]; widget = md === undefined ? new ChipWidget("table: " + base + " (loading…)", "embed") : new TableWidget(md, base, true); }
    } else widget = new ChipWidget("embed: " + base, "embed");
    decos.push({ from: line.from, to: line.to, deco: Decoration.replace({ widget, block: true }) });
  }
  return Decoration.set(decos.map((d) => d.deco.range(d.from, d.to)), true);
}
const blockEmbedField = StateField.define<DecorationSet>({
  create: (state) => buildBlockEmbeds(state),
  update: (value, tr) => (tr.docChanged || tr.selection || commentsMoved(tr) || tr.effects.some((e) => e.is(setEmbeds) || e.is(setTablePngs) || e.is(setFigureRects) || e.is(setEmbedProv)) ? buildBlockEmbeds(tr.state) : value),
  provide: (f) => EditorView.decorations.from(f),
});
function isBlockEmbedLine(state: EditorState, pos: number): boolean {
  return blockEmbedBase(state.doc.lineAt(pos).text) !== null;
}

class LatexFigWidget extends WidgetType {
  name: string; pngSrc: string; svgSrc: string; caption: string;
  constructor(name: string, pngSrc: string, svgSrc: string, caption: string) { super(); this.name = name; this.pngSrc = pngSrc; this.svgSrc = svgSrc; this.caption = caption; }
  eq(o: LatexFigWidget) { return o.pngSrc === this.pngSrc && o.caption === this.caption; }
  toDOM(view: EditorView) {
    const fig = document.createElement("div"); fig.className = "cm-embed-fig cm-latex-fig";
    if (this.caption) { const cap = document.createElement("div"); cap.className = "cm-latex-figcap"; cap.textContent = this.caption; fig.appendChild(cap); }
    const img = document.createElement("img"); img.src = this.pngSrc; img.alt = this.name; img.loading = "lazy";
    let triedSvg = false;
    img.onload = () => { try { view.requestMeasure(); } catch { /* noop */ } };
    img.onerror = () => { if (!triedSvg) { triedSvg = true; img.src = this.svgSrc; } else { fig.className = "cm-embed-chip"; fig.textContent = "figure not found: " + this.name; } };
    // copy the figure to the clipboard — read the live src so a png→svg fallback still copies
    const copyBtn = makeCopyButton(() => img.currentSrc || img.src, 6);
    fig.appendChild(img); fig.appendChild(copyBtn);
    return blockWrap(fig, "latex");   // only ever a block embed
  }
  ignoreEvent() { return true; }
}
const LATEX_IG_RE = /\\includegraphics(?:\[[^\]]*\])?\{([^}]+)\}/;
const LATEX_CAP_RE = /\\textbf\{([^}]*)\}\s*([^\\}]*)/;
function findLatexFigBlocks(state: EditorState): { from: number; to: number; name: string; caption: string }[] {
  const doc = state.doc; const blocks: { from: number; to: number; name: string; caption: string }[] = [];
  let l = 1;
  while (l <= doc.lines) {
    const t = doc.line(l).text.trim();
    if (t.startsWith("```") && /\{=latex\}/.test(t)) {
      let end = l + 1;
      while (end <= doc.lines && !/^`{3,}$/.test(doc.line(end).text.trim())) end++;
      if (end <= doc.lines) {
        const open = doc.line(l), close = doc.line(end);
        const blockText = doc.sliceString(open.from, close.to);
        const ig = LATEX_IG_RE.exec(blockText);
        if (ig) {
          const name = (ig[1].split("/").pop() || ig[1]).trim();
          const cap = LATEX_CAP_RE.exec(blockText);
          const caption = cap ? (cap[1] + " " + cap[2]).replace(/\s+/g, " ").trim() : "";
          blocks.push({ from: open.from, to: close.to, name, caption });
        }
        l = end + 1; continue;
      }
    }
    l++;
  }
  return blocks;
}
function buildLatexFigDecos(state: EditorState): DecorationSet {
  const sel = state.selection.main;
  const assetBase = state.facet(assetBaseFacet);
  if (!assetBase) return Decoration.none;
  // each extension carries its OWN stamp: a png stamp on the svg url would simply not
  // match, and /drafting/asset then answers no-cache, which is the safe side
  const provMap = state.field(embedProvField, false) ?? {};
  const decos = findLatexFigBlocks(state)
    .filter((b) => !(sel.from <= b.to && sel.to >= b.from))   // cursor inside -> reveal raw LaTeX
    .map((b) => Decoration.replace({
      widget: new LatexFigWidget(b.name,
        assetBase + encodeURIComponent(b.name + ".png") + stampParam(provMap[b.name + ".png"]),
        assetBase + encodeURIComponent(b.name + ".svg") + stampParam(provMap[b.name + ".svg"]), b.caption),
      block: true,
    }).range(b.from, b.to));
  return Decoration.set(decos, true);
}
const latexFigField = StateField.define<DecorationSet>({
  create: (state) => buildLatexFigDecos(state),
  update: (value, tr) => (tr.docChanged || tr.selection || tr.effects.some((e) => e.is(setEmbedProv)) ? buildLatexFigDecos(tr.state) : value),
  provide: (f) => EditorView.decorations.from(f),
});
function inactiveLatexFigRanges(state: EditorState): { from: number; to: number }[] {
  const sel = state.selection.main;
  return findLatexFigBlocks(state).filter((b) => !(sel.from <= b.to && sel.to >= b.from)).map((b) => ({ from: b.from, to: b.to }));
}

class MathWidget extends WidgetType {
  tex: string; display: boolean; block: boolean;
  constructor(tex: string, display: boolean, block: boolean) { super(); this.tex = tex; this.display = display; this.block = block; }
  eq(o: MathWidget) { return o.tex === this.tex && o.display === this.display && o.block === this.block; }
  toDOM(view: EditorView) {
    const r = texToMathML(this.tex, this.display);
    const wrap: HTMLElement = document.createElement(this.block ? "div" : "span");
    wrap.className = this.block ? "cm-math-block" : this.display ? "cm-math cm-math-display" : "cm-math";
    if (r.errors.length) { wrap.classList.add("cm-math-err"); wrap.title = r.errors.join("\n"); }
    wrap.appendChild(mathDom(r.node));
    // a click drops the caret just inside the opening delimiter — into the TeX, not beside it
    wrap.addEventListener("mousedown", (e: MouseEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const at = view.posAtDOM(wrap);
      const open = view.state.sliceDoc(at, at + 2) === "$$" ? 2 : view.state.sliceDoc(at, at + 1) === "$" ? 1 : 0;
      view.dispatch({ selection: { anchor: at + open } });
      view.focus();
    });
    return wrap;
  }
  // the mousedown above is the widget's own; everything else (and every key — the caret
  // steps onto an edge, which reveals the source) stays CodeMirror's
  ignoreEvent(e: Event) { return e.type === "mousedown"; }
}
/** The whole lines a display span fills, when it stands alone on them (a block equation). */
function mathBlockLines(state: EditorState, sp: MathSpan): { from: number; to: number } | null {
  if (!sp.display) return null;
  const a = state.doc.lineAt(sp.from), b = state.doc.lineAt(sp.to);
  if (state.doc.sliceString(a.from, sp.from).trim() || state.doc.sliceString(sp.to, b.to).trim()) return null;
  return { from: a.from, to: b.to };
}
const mathOpen = (state: EditorState, sp: { from: number; to: number }) => {
  const sel = state.selection.main;
  return sel.from <= sp.to && sel.to >= sp.from;           // caret on or in it -> raw TeX
};
function buildMathDecos(state: EditorState, spans: MathSpan[]): DecorationSet {
  const skip = inactiveTableRanges(state);                 // a table folded to a widget owns its lines
  const reveal = revealSpans(state);                      // an open suggestion inside -> raw TeX
  const out: Range<Decoration>[] = [];
  for (const sp of spans) {
    if (mathOpen(state, sp) || skip.some((r) => sp.from <= r.to && sp.to >= r.from)) continue;
    if (reveal.some((r) => r.from < sp.to && r.to > sp.from)) continue;
    const blk = mathBlockLines(state, sp);
    const w = new MathWidget(sp.tex, sp.display, !!blk);
    out.push(blk ? Decoration.replace({ widget: w, block: true }).range(blk.from, blk.to) : Decoration.replace({ widget: w }).range(sp.from, sp.to));
  }
  return Decoration.set(out, true);
}
const mathField = StateField.define<{ spans: MathSpan[]; deco: DecorationSet }>({
  create: (state) => { const spans = findMath(state.doc.toString()); return { spans, deco: buildMathDecos(state, spans) }; },
  update: (v, tr) => {
    if (tr.docChanged) { const spans = findMath(tr.state.doc.toString()); return { spans, deco: buildMathDecos(tr.state, spans) }; }
    return tr.selection || commentsMoved(tr) ? { spans: v.spans, deco: buildMathDecos(tr.state, v.spans) } : v;
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});
/** Does [from,to) overlap a math span? Spans are sorted, so a binary search. */
function overlapsMath(spans: MathSpan[], from: number, to: number): boolean {
  let lo = 0, hi = spans.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (spans[mid].to <= from) lo = mid + 1; else hi = mid; }
  return lo < spans.length && spans[lo].from < to;
}

const fmUnquote = (s: string) => s.trim().replace(/^["']|["']$/g, "");
// build settings the Publish panel and the Outline write (drafting.py resolves them);
// a block of nothing else is machinery, not writing, so the editor never shows it
const FM_SETTINGS_KEYS = new Set(["journal", "blind", "figures", "notes", "publish", "spacing", "font", "fontsize"]);
type FmInfo = { from: number; to: number; endLine: number; title: string; subtitle: string; settingsOnly: boolean };
function frontmatterInfo(state: EditorState): FmInfo | null {
  if (state.doc.lines < 2 || state.doc.line(1).text.trim() !== "---") return null;
  let endLine = 0;
  for (let l = 2; l <= state.doc.lines; l++) { if (state.doc.line(l).text.trim() === "---") { endLine = l; break; } }
  if (!endLine) return null;
  const get = (key: string) => {
    const re = new RegExp("^" + key + ":\\s*(.*)$");
    for (let l = 2; l < endLine; l++) { const m = re.exec(state.doc.line(l).text); if (m) return fmUnquote(m[1]); }
    return "";
  };
  const title = get("title");
  let settingsOnly = endLine > 2;
  for (let l = 2; l < endLine && settingsOnly; l++) {
    const t = state.doc.line(l).text;
    if (t.trim() && !FM_SETTINGS_KEYS.has((/^([A-Za-z-]+)\s*:/.exec(t)?.[1] ?? "").toLowerCase())) settingsOnly = false;
  }
  if (settingsOnly) {
    // hide the block and the blank lines under it, but never the doc's last line
    let e = endLine;
    while (e + 1 < state.doc.lines && !state.doc.line(e + 1).text.trim()) e++;
    return { from: state.doc.line(1).from, to: state.doc.line(e).to, endLine: e, title: "", subtitle: "", settingsOnly };
  }
  if (!title) return null;
  return { from: state.doc.line(1).from, to: state.doc.line(endLine).to, endLine, title, subtitle: get("subtitle"), settingsOnly };
}
function fmRevealed(state: EditorState, fm: FmInfo): boolean {
  if (fm.settingsOnly) return false;               // settings live in the Outline, never here
  const sel = state.selection.main;
  return sel.from <= fm.to && sel.to >= fm.from;   // cursor inside -> show raw YAML
}
class TitleWidget extends WidgetType {
  readonly title: string; readonly subtitle: string;
  constructor(title: string, subtitle: string) { super(); this.title = title; this.subtitle = subtitle; }
  eq(o: TitleWidget) { return o.title === this.title && o.subtitle === this.subtitle; }
  toDOM() {
    const wrap = document.createElement("div");
    wrap.className = "cm-title-block";
    const h = document.createElement("div");
    h.className = "cm-title";
    h.textContent = this.title || "(untitled)";
    wrap.appendChild(h);
    if (this.subtitle) { const s = document.createElement("div"); s.className = "cm-subtitle"; s.textContent = this.subtitle; wrap.appendChild(s); }
    // the gap below the rule is padding on an outer box, not a margin CodeMirror's
    // block-height measurement would miss (see blockWrap)
    const outer = document.createElement("div"); outer.className = "cm-title-outer";
    outer.appendChild(wrap);
    return outer;
  }
  ignoreEvent() { return false; }   // click reveals the raw YAML for editing
}
function buildFrontmatter(state: EditorState): DecorationSet {
  const fm = frontmatterInfo(state);
  if (!fm || fmRevealed(state, fm)) return Decoration.none;
  if (fm.settingsOnly) return Decoration.set([Decoration.replace({ block: true }).range(fm.from, fm.to)]);
  return Decoration.set([Decoration.replace({ widget: new TitleWidget(fm.title, fm.subtitle), block: true }).range(fm.from, fm.to)]);
}
const frontmatterField = StateField.define<DecorationSet>({
  create: (state) => buildFrontmatter(state),
  update: (value, tr) => (tr.docChanged || tr.selection ? buildFrontmatter(tr.state) : value),
  // a hidden settings block is atomic: arrows and clicks step over it. The title block
  // stays enterable, since a click there reveals the YAML for editing.
  provide: (f) => [
    EditorView.decorations.from(f),
    EditorView.atomicRanges.of((view) => (frontmatterInfo(view.state)?.settingsOnly ? view.state.field(f) : Decoration.none)),
    // a caret that still lands inside it (select-all collapse, a jump to 0) moves to the
    // first line below, so typing can never write into the YAML
    EditorState.transactionFilter.of((tr) => {
      if (!tr.selection && !tr.docChanged) return tr;
      const sel = tr.state.selection.main;
      if (!sel.empty) return tr;
      const fm = frontmatterInfo(tr.state);
      if (!fm?.settingsOnly || sel.head < fm.from || sel.head > fm.to || fm.to >= tr.state.doc.length) return tr;
      return [tr, { selection: { anchor: fm.to + 1 }, sequential: true }];
    }),
  ],
});

const EMBED_RE = /!\[\[([^\]]+)\]\]/g;
const WIKI_RE = /(^|[^!])\[\[([^\]]+)\]\]/g;
const PLACEHOLDER_RE = /^<!--\s*¶\s*([\s\S]*?)\s*-->$/;

function buildDecorations(view: EditorView): DecorationSet {
  const { state } = view;
  const assetBase = state.facet(assetBaseFacet);
  const tablePngBase = state.facet(tablePngBaseFacet);
  const embeds = state.field(embedField, false) ?? {};
  const citeMap = state.field(citeMapField, false) ?? {};
  const inlineFigRects = state.field(figureRectsField, false) ?? {};
  const inlineProvMap = state.field(embedProvField, false) ?? {};
  const hasCites = Object.keys(citeMap).length > 0;
  const decos: { from: number; to: number; deco: Decoration }[] = [];
  // only the line containing the primary cursor reveals its marks (no flicker on
  // multi-line selection, and a clean title on load)
  const activeLine = state.doc.lineAt(state.selection.main.head).number;
  const lineActive = (pos: number) => state.doc.lineAt(pos).number === activeLine;
  const tblRanges = inactiveTableRanges(state);
  const inTable = (pos: number) => tblRanges.some((r) => pos >= r.from && pos <= r.to);
  const inBlockEmbed = (pos: number) => state.doc.lineAt(pos).number !== activeLine && isBlockEmbedLine(state, pos);
  // raw-LaTeX figure blocks rendered as the figure image (latexFigField) — skip them here so
  // this plugin never styles the folded ```{=latex}``` lines as a code block under the widget.
  const figRanges = inactiveLatexFigRanges(state);
  const inFig = (pos: number) => figRanges.some((r) => pos >= r.from && pos <= r.to);
  // math: rendered block equations own their lines, and nothing styles INSIDE a math span
  // (a `_` in TeX is a subscript — lezer's emphasis there is noise, rendered or revealed)
  const mathSpans = state.field(mathField, false)?.spans ?? [];
  const mathBlocks = mathSpans.filter((sp) => !mathOpen(state, sp)).map((sp) => mathBlockLines(state, sp)).filter((r): r is { from: number; to: number } => !!r);
  const inMathBlock = (pos: number) => mathBlocks.some((r) => pos >= r.from && pos <= r.to);
  const inBlock = (pos: number) => inTable(pos) || inBlockEmbed(pos) || inFig(pos) || inMathBlock(pos);
  const hideMark = (from: number, to: number, eatSpace = false) => {
    if (lineActive(from)) return;
    let end = to;
    if (eatSpace && state.doc.sliceString(to, to + 1) === " ") end = to + 1;
    if (end > from) decos.push({ from, to: end, deco: HIDE });
  };
  const lineFor = (pos: number) => state.doc.lineAt(pos).from;

  const fm = frontmatterInfo(state);
  const feEnd = fm ? fm.endLine : 0;
  const fmShown = fm ? fmRevealed(state, fm) : false;   // true = raw YAML visible
  const fmReplaced = !!fm && !fmShown;                  // true = title widget shown instead
  if (feEnd && fmShown) for (let l = 1; l <= feEnd; l++) decos.push({ from: state.doc.line(l).from, to: state.doc.line(l).from, deco: lineClass("cm-frontmatter") });

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from, to,
      enter: (node) => {
        const n = node.name;
        const hm = /^ATXHeading(\d)$/.exec(n);
        if (hm) { decos.push({ from: lineFor(node.from), to: lineFor(node.from), deco: lineClass("cm-h" + hm[1]) }); return; }
        if (n === "HeaderMark") { hideMark(node.from, node.to, true); return; }
        if (n === "StrongEmphasis") { decos.push({ from: node.from, to: node.to, deco: markClass("cm-strong") }); return; }
        if (n === "Emphasis") { decos.push({ from: node.from, to: node.to, deco: markClass("cm-em") }); return; }
        if (n === "Strikethrough") { decos.push({ from: node.from, to: node.to, deco: markClass("cm-strike") }); return; }
        if (n === "InlineCode") { decos.push({ from: node.from, to: node.to, deco: markClass("cm-code") }); return; }
        if (n === "EmphasisMark" || n === "CodeMark" || n === "StrikethroughMark") { hideMark(node.from, node.to); return; }
        if (n === "Blockquote") { const a = state.doc.lineAt(node.from).number, b = state.doc.lineAt(node.to).number; for (let l = a; l <= b; l++) decos.push({ from: state.doc.line(l).from, to: state.doc.line(l).from, deco: lineClass("cm-quote") }); return; }
        if (n === "QuoteMark") { hideMark(node.from, node.to, true); return; }
        if (n === "ListMark") { decos.push({ from: lineFor(node.from), to: lineFor(node.from), deco: lineClass("cm-li") }); return; }
        if (n === "FencedCode" || n === "CodeBlock") { const a = state.doc.lineAt(node.from).number, b = state.doc.lineAt(Math.min(node.to, state.doc.length)).number; for (let l = a; l <= b; l++) decos.push({ from: state.doc.line(l).from, to: state.doc.line(l).from, deco: lineClass("cm-codeblock") }); return; }
        if (n === "Link") { decos.push({ from: node.from, to: node.to, deco: markClass("cm-link") }); return; }
        if (n === "URL" || n === "LinkMark") { hideMark(node.from, node.to); return; }
        if (n === "HorizontalRule") { if (state.doc.lineAt(node.from).number <= feEnd) return; decos.push({ from: lineFor(node.from), to: lineFor(node.from), deco: lineClass("cm-hr") }); hideMark(node.from, node.to); return; }
      },
    });
    // wikilinks / embeds (not parsed by commonmark): fold to a chip on inactive lines
    let pos = from;
    while (pos <= to && pos <= state.doc.length) {
      const line = state.doc.lineAt(pos);
      if (line.number !== activeLine && !inTable(line.from) && !inBlockEmbed(line.from)) {
        const txt = line.text;
        // the retired `<!--¶ -->` placeholder: just hide any stray marker (no ghost slot)
        if (PLACEHOLDER_RE.test(txt.trim())) { decos.push({ from: line.from, to: line.to, deco: HIDE }); pos = line.to + 1; continue; }
        let m: RegExpExecArray | null;
        EMBED_RE.lastIndex = 0;
        while ((m = EMBED_RE.exec(txt))) {
          const base = m[1].split("|")[0].trim();
          const a = line.from + m.index, b = a + m[0].length;
          const p = embedMetadata(inlineProvMap, base) || null;
          const rects = embedMetadata(inlineFigRects, base) || [];
          if (IMG_EXT.test(base) && assetBase) decos.push({ from: a, to: b, deco: Decoration.replace({ widget: new ImgWidget(base, assetBase + encodeURIComponent(base) + assetVersionParam(p), m[0], rects, p) }) });
          else if (/\.pdf$/i.test(base) && tablePngBase) decos.push({ from: a, to: b, deco: Decoration.replace({ widget: new ImgWidget(base, tablePngBase + encodeURIComponent(base) + assetVersionParam(p), m[0], rects, p) }) });
          else if (/\.(md|csv|txt)$/i.test(base)) { const md = embeds[base]; decos.push({ from: a, to: b, deco: md === undefined ? Decoration.replace({ widget: new ChipWidget("table: " + base + " (loading…)", "embed") }) : Decoration.replace({ widget: new TableWidget(md, base) }) }); }
          else decos.push({ from: a, to: b, deco: Decoration.replace({ widget: new ChipWidget("embed: " + base, "embed") }) });
        }
        WIKI_RE.lastIndex = 0;
        while ((m = WIKI_RE.exec(txt))) { const lead = m[1] || ""; const inner = m[2].split("|"); const label = (inner[1] || inner[0].split("/").pop() || inner[0]).trim(); const start = line.from + m.index + lead.length; decos.push({ from: start, to: start + (m[0].length - lead.length), deco: Decoration.replace({ widget: new ChipWidget(label, "wikilink") }) }); }
      }
      pos = line.to + 1;
    }
    if (hasCites) {
      let cp = from;
      while (cp <= to && cp <= state.doc.length) {
        const line = state.doc.lineAt(cp);
        if (!inTable(line.from) && !inBlockEmbed(line.from)) {
          for (const c of scanLineCites(line.text, line.from, citeMap)) {
            const cls = c.entry.status === "resolved" ? "cm-cite"
              : c.entry.status === "ambiguous" ? "cm-cite-amb"
                : c.entry.status === "prior" ? "cm-cite-prior" : "cm-cite-unres";
            decos.push({ from: c.from, to: c.to, deco: Decoration.mark({ class: cls, attributes: c.entry.rel ? { "data-cite-rel": c.entry.rel } : {} }) });
            // the ':page' suffix -> a distinct clickable span that jumps the source PDF to
            // that exact page (deterministic, from the note's stored highlight anchors).
            if (c.page && c.entry.rel) decos.push({ from: c.page.from, to: c.page.to, deco: Decoration.mark({ class: "cm-cite-page", attributes: { "data-cite-rel": c.entry.rel, "data-cite-page": c.page.num } }) });
          }
        }
        cp = line.to + 1;
      }
    }
  }
  const inFm = (pos: number) => fmReplaced && state.doc.lineAt(pos).number <= feEnd;
  return Decoration.set(decos.filter((d) => !inBlock(d.from) && !inFm(d.from) && !(d.to > d.from && overlapsMath(mathSpans, d.from, d.to))).map((d) => d.deco.range(d.from, d.to)), true);
}

const livePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    lastActive = -1;
    constructor(view: EditorView) { this.decorations = buildDecorations(view); this.lastActive = view.state.doc.lineAt(view.state.selection.main.head).number; }
    update(u: ViewUpdate) {
      const act = u.state.doc.lineAt(u.state.selection.main.head).number;
      const embedsChanged = u.startState.field(embedField, false) !== u.state.field(embedField, false);
      const citeChanged = u.startState.field(citeMapField, false) !== u.state.field(citeMapField, false);
      const rectsChanged = u.startState.field(figureRectsField, false) !== u.state.field(figureRectsField, false);
      const provChanged = u.startState.field(embedProvField, false) !== u.state.field(embedProvField, false);
      // a block equation opening or closing changes which lines this plugin may decorate
      const mathChanged = u.startState.field(mathField, false)?.deco !== u.state.field(mathField, false)?.deco;
      if (u.docChanged || u.viewportChanged || embedsChanged || citeChanged || rectsChanged || provChanged || mathChanged || (u.selectionSet && act !== this.lastActive)) { this.decorations = buildDecorations(u.view); this.lastActive = act; }
    }
  },
  { decorations: (v) => v.decorations }
);

const hl = HighlightStyle.define([
  { tag: tags.link, color: "hsl(var(--primary))" },
  { tag: tags.url, color: "hsl(var(--muted-foreground))" },
  { tag: tags.monospace, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" },
]);

const theme = EditorView.theme({
  "&": { height: "auto", backgroundColor: "transparent", color: "hsl(var(--foreground))" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--draft-font, Georgia, 'Times New Roman', serif)", lineHeight: "var(--draft-leading, 1.72)", overflow: "visible" },
  ".cm-content": { maxWidth: "calc(var(--draft-measure, 760px) * var(--draft-zoom, 1))", margin: "0 auto", padding: "8px 8px 30vh", fontSize: "calc(var(--draft-fontsize, 16.5px) * var(--draft-zoom, 1))", caretColor: "hsl(var(--foreground))" },
  ".cm-line": { padding: "0 2px" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "hsl(var(--foreground))", borderLeftWidth: "2px" },
  // !important so the brand-teal selection wins over CM's built-in #d7d4f0 default
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": { backgroundColor: "hsl(var(--primary) / 0.3) !important" },
  ".cm-placeholder": { color: "hsl(var(--muted-quiet))", fontStyle: "italic" },
  ".cm-hr": { display: "block", height: "1.6em", borderBottom: "1px solid hsl(var(--border))", marginBottom: "0.4em" },
  // artifact page-break marker: a full-row dashed rule with a small label, at the
  // exact char where the compiled document starts its next page
  ".cm-pagebreak": { display: "inline-flex", width: "100%", alignItems: "center", gap: "8px", userSelect: "none", pointerEvents: "none", verticalAlign: "baseline", padding: "1px 0" },
  ".cm-pagebreak-rule": { flex: "1", borderTop: "1px dashed hsl(var(--primary) / 0.4)" },
  ".cm-pagebreak-label": { fontFamily: "ui-sans-serif, system-ui, sans-serif", fontSize: "9.5px", letterSpacing: "0.05em", textTransform: "uppercase", color: "hsl(var(--primary-ink))", whiteSpace: "nowrap" },
  ".cm-frontmatter": { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "0.78em", color: "hsl(var(--muted-quiet))", fontStyle: "normal" },
  // YAML frontmatter rendered as the paper's title (em-sized -> scales with zoom).
  ".cm-title-outer": { display: "block", paddingBottom: "0.2em" },
  ".cm-title-block": { padding: "0.1em 0 0.5em", borderBottom: "1px solid hsl(var(--border) / 0.7)" },
  ".cm-title": { fontFamily: "Georgia, 'Times New Roman', serif", fontSize: "calc(var(--draft-h1, 2em) * 1.04)", fontWeight: "600", lineHeight: "1.22", color: "hsl(var(--foreground))" },
  ".cm-subtitle": { fontFamily: "Georgia, 'Times New Roman', serif", fontSize: "1.25em", fontStyle: "italic", color: "hsl(var(--muted-foreground))", lineHeight: "1.3", marginTop: "0.25em" },
  ".cm-h1": { fontSize: "var(--draft-h1, 2em)", fontWeight: "600", lineHeight: "1.25", paddingTop: "0.6em" },
  ".cm-h2": { fontSize: "var(--draft-h2, 1.5em)", fontWeight: "600", lineHeight: "1.3", paddingTop: "1.1em" },
  ".cm-h3": { fontSize: "var(--draft-h3, 1.22em)", fontWeight: "600", paddingTop: "0.8em" },
  ".cm-h4, .cm-h5, .cm-h6": { fontSize: "1.06em", fontWeight: "600", paddingTop: "0.5em" },
  ".cm-strong": { fontWeight: "700", color: "hsl(var(--foreground))" },
  ".cm-em": { fontStyle: "italic" },
  ".cm-strike": { textDecoration: "line-through", color: "hsl(var(--muted-foreground))" },
  ".cm-link": { color: "hsl(var(--primary))", textDecoration: "underline", textDecorationColor: "hsl(var(--primary) / 0.4)" },
  // in-text citations: resolved -> a clickable link to its note; the rest -> a quiet
  // dotted lint underline (amber = ambiguous collision, rose = no note yet).
  ".cm-cite": { color: "hsl(var(--primary))", cursor: "pointer", textDecoration: "underline", textDecorationStyle: "dotted", textDecorationColor: "hsl(var(--primary) / 0.45)", textUnderlineOffset: "2px" },
  ".cm-cite:hover": { textDecorationColor: "hsl(var(--primary))", backgroundColor: "hsl(var(--primary) / 0.08)", borderRadius: "2px" },
  ".cm-cite-prior": { color: "hsl(var(--primary-ink))", textDecoration: "underline", textDecorationStyle: "dotted", textDecorationColor: "hsl(var(--primary) / 0.3)", textUnderlineOffset: "2px" },
  ".cm-cite-amb": { textDecoration: "underline", textDecorationStyle: "wavy", textDecorationColor: "hsl(38 92% 50% / 0.7)", textUnderlineOffset: "2px" },
  ".cm-cite-unres": { textDecoration: "underline", textDecorationStyle: "wavy", textDecorationColor: "hsl(0 72% 55% / 0.55)", textUnderlineOffset: "2px" },
  // the ':page' suffix of a cite — a distinct, slightly stronger affordance: clicking it
  // opens the source PDF at that exact page (vs the author/year, which opens the note).
  ".cm-cite-page": { color: "hsl(var(--primary))", cursor: "pointer", fontWeight: "500", textDecoration: "underline", textDecorationColor: "hsl(var(--primary) / 0.55)", textUnderlineOffset: "2px" },
  ".cm-cite-page:hover": { backgroundColor: "hsl(var(--primary) / 0.14)", textDecorationColor: "hsl(var(--primary))", borderRadius: "2px" },
  ".cm-code": { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "0.86em", backgroundColor: "hsl(var(--secondary))", borderRadius: "3px", padding: "0.05em 0.3em", border: "1px solid hsl(var(--border))" },
  ".cm-codeblock": { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "0.86em", backgroundColor: "hsl(var(--secondary) / 0.5)" },
  ".cm-quote": { paddingLeft: "2.4em", paddingRight: "2.4em", color: "hsl(var(--foreground) / 0.85)" },
  ".cm-comment-hl": { backgroundColor: "hsl(45 90% 55% / 0.22)", borderBottom: "1.5px solid hsl(45 90% 45% / 0.55)", borderRadius: "1px", cursor: "pointer", transition: "background-color 120ms" },
  ".cm-comment-active": { backgroundColor: "hsl(45 95% 52% / 0.42)" },
  // an inserted number that drifted from its cell (wavy, danger) or whose producing
  // script was edited after the table was made (dotted, warning). Tooltip only.
  ".cm-num-drift": { textDecoration: "underline", textDecorationStyle: "wavy", textDecorationColor: "hsl(var(--danger))", textDecorationThickness: "1px", textUnderlineOffset: "3px" },
  ".cm-num-script": { textDecoration: "underline", textDecorationStyle: "dotted", textDecorationColor: "hsl(var(--warning))", textDecorationThickness: "2px", textUnderlineOffset: "3px" },
  // word-processor list rendering: indent the item from the body text and hang the wrap so
  // continuation lines align under the text, not under the marker (1. / - / •).
  ".cm-li": { paddingLeft: "2.4em", textIndent: "-1.2em" },
  ".cm-placeholder-slot": { display: "flex", alignItems: "center", gap: "0.55em", width: "100%", fontFamily: "system-ui, sans-serif", fontSize: "0.84em", fontStyle: "normal", color: "hsl(var(--muted-foreground))", backgroundColor: "hsl(var(--primary) / 0.045)", border: "1px dashed hsl(var(--primary) / 0.45)", borderRadius: "7px", padding: "0.5em 0.8em", margin: "0.15em 0" },
  ".cm-placeholder-pen": { color: "hsl(var(--primary-ink))", fontSize: "0.95em" },
  ".cm-placeholder-label": { flex: "1", lineHeight: "1.45" },
  ".cm-embed-chip": { display: "inline-flex", alignItems: "center", fontFamily: "system-ui, sans-serif", fontSize: "0.8em", color: "hsl(var(--muted-foreground))", backgroundColor: "hsl(var(--secondary) / 0.6)", border: "1px solid hsl(var(--border))", borderRadius: "5px", padding: "0.05em 0.5em", fontStyle: "normal" },
  ".cm-wikilink-chip": { color: "hsl(var(--primary))", fontStyle: "normal", borderBottom: "1px dotted hsl(var(--primary) / 0.5)" },
  ".cm-embed-fig": { position: "relative", display: "inline-block", width: "100%", margin: "0.6em 0", textAlign: "center" },
  ".cm-embed-fig img": { display: "block", maxWidth: "100%", margin: "0 auto", borderRadius: "4px", border: "1px solid hsl(var(--border))", cursor: "crosshair" },
  // the comment trigger sits top-right, hidden until the figure is hovered — a drag on
  // the image itself (handled in ImgWidget) flags one region rather than the whole figure
  ".cm-embed-comment-btn": { position: "absolute", top: "6px", right: "6px", zIndex: "5", width: "24px", height: "24px", borderRadius: "999px", border: "1px solid hsl(var(--border))", backgroundColor: "hsl(var(--background) / 0.9)", opacity: "0", transition: "opacity 120ms", cursor: "pointer", fontSize: "12px", lineHeight: "22px", padding: "0" },
  ".cm-embed-fig:hover .cm-embed-comment-btn": { opacity: "1" },
  // full-view (⤢) sits just left of the comment button, same hover-reveal
  ".cm-embed-expand-btn": { position: "absolute", top: "6px", right: "34px", zIndex: "5", width: "24px", height: "24px", borderRadius: "999px", border: "1px solid hsl(var(--border))", backgroundColor: "hsl(var(--background) / 0.9)", opacity: "0", transition: "opacity 120ms", cursor: "pointer", fontSize: "13px", lineHeight: "22px", padding: "0" },
  ".cm-embed-fig:hover .cm-embed-expand-btn": { opacity: "1" },
  // copy-to-clipboard (⧉) — same pill, its right offset set inline per widget; hover-reveal
  ".cm-embed-copy-btn": { position: "absolute", top: "6px", zIndex: "5", width: "24px", height: "24px", borderRadius: "999px", border: "1px solid hsl(var(--border))", backgroundColor: "hsl(var(--background) / 0.9)", opacity: "0", transition: "opacity 120ms", cursor: "pointer", fontSize: "13px", lineHeight: "22px", padding: "0" },
  ".cm-embed-fig:hover .cm-embed-copy-btn": { opacity: "1" },
  ".cm-embed-copy-btn.copied": { color: "rgb(16 185 129)", borderColor: "rgb(16 185 129 / 0.6)", opacity: "1" },
  ".cm-embed-copy-btn.failed": { color: "rgb(225 29 72)", borderColor: "rgb(244 63 94 / 0.6)", opacity: "1" },
  ".cm-embed-diagram-btn": { position: "absolute", top: "6px", zIndex: "5", width: "24px", height: "24px", borderRadius: "999px", border: "1px solid hsl(var(--border))", backgroundColor: "hsl(var(--background) / 0.9)", opacity: "0", transition: "opacity 120ms", cursor: "pointer", fontSize: "13px", lineHeight: "22px", padding: "0" },
  ".cm-embed-fig:hover .cm-embed-diagram-btn": { opacity: "1" },
  ".cm-embed-comment-rect": { position: "absolute", border: "2px solid hsl(var(--primary))", backgroundColor: "hsl(var(--primary) / 0.15)", pointerEvents: "none", zIndex: "4" },
  // the imgwrap hugs the rendered image so every rect positions against the IMAGE box
  ".cm-embed-imgwrap": { position: "relative", display: "inline-block", maxWidth: "100%" },
  ".cm-embed-imgwrap img": { display: "block" },
  // persistent numbered overlays for open figure comments (amber; badge is clickable)
  ".cm-embed-rect": { position: "absolute", border: "2px solid rgb(245 158 11 / 0.9)", backgroundColor: "rgb(245 158 11 / 0.10)", borderRadius: "2px", pointerEvents: "none", zIndex: "3" },
  ".cm-embed-rect-badge": { position: "absolute", top: "-9px", left: "-9px", minWidth: "18px", height: "18px", padding: "0 4px", borderRadius: "999px", border: "1px solid rgb(245 158 11)", backgroundColor: "rgb(245 158 11)", color: "#fff", fontSize: "10.5px", fontWeight: "600", lineHeight: "16px", cursor: "pointer", pointerEvents: "auto", fontFamily: "system-ui, sans-serif" },
  // provenance chip in the caption row: dot + short label, colored by grounding status
  ".cm-embed-prov": { display: "inline-flex", alignItems: "center", gap: "4px", marginLeft: "8px", padding: "0 7px", height: "16px", borderRadius: "999px", border: "1px solid hsl(var(--border))", backgroundColor: "hsl(var(--secondary) / 0.5)", color: "hsl(var(--muted-foreground))", fontSize: "9.5px", fontFamily: "system-ui, sans-serif", cursor: "pointer", verticalAlign: "middle" },
  ".cm-embed-prov::before": { content: "''", width: "6px", height: "6px", borderRadius: "999px", backgroundColor: "hsl(var(--muted-foreground))" },
  ".cm-embed-prov-fresh::before": { backgroundColor: "rgb(16 185 129)" },
  ".cm-embed-prov-stale": { borderColor: "rgb(245 158 11 / 0.6)", color: "hsl(var(--due-soon-ink))" },
  ".cm-embed-prov-stale::before": { backgroundColor: "rgb(245 158 11)" },
  ".cm-embed-prov-none": { borderColor: "rgb(244 63 94 / 0.6)", color: "hsl(var(--danger))" },
  ".cm-embed-prov-none::before": { backgroundColor: "rgb(244 63 94)" },
  // the typeset table PNG prints on a white card so it reads like the page, not a screenshot
  ".cm-table-png": { margin: "0.8em 0" },
  ".cm-table-png img": { backgroundColor: "#fff", border: "1px solid hsl(var(--border))", borderRadius: "5px", padding: "10px" },
  // raw-LaTeX figure: image on a white card (it prints on the page) + a serif caption above
  ".cm-latex-fig": { margin: "0.9em 0" },
  ".cm-latex-fig img": { backgroundColor: "#fff", padding: "8px" },
  ".cm-latex-figcap": { fontFamily: "Georgia, 'Times New Roman', serif", fontSize: "0.84em", fontWeight: "600", color: "hsl(var(--foreground))", textAlign: "left", lineHeight: "1.4", marginBottom: "0.45em" },
  ".cm-embed-cap": { fontFamily: "system-ui, sans-serif", fontSize: "0.72em", color: "hsl(var(--muted-foreground))", marginTop: "0.35em" },
  ".cm-table-wrap": { display: "inline-block", width: "100%", overflowX: "auto", margin: "0.5em 0" },
  ".cm-embed-block": { display: "block", position: "relative", width: "100%", boxSizing: "border-box", margin: "0" },
  ".cm-embed-block-fig": { padding: "0.6em 0" },
  ".cm-embed-block-tablepng": { padding: "0.8em 0" },
  ".cm-embed-block-latex": { padding: "0.9em 0" },
  ".cm-embed-block-table": { padding: "0.5em 0" },
  ".cm-embed-block > .cm-embed-fig, .cm-embed-block > .cm-table-wrap": { display: "block", margin: "0", boxSizing: "border-box" },
  // typeset math, in the page's own serif (index.css holds the MathML font rules); a block
  // equation's gap is padding, so CodeMirror measures its real height (see blockWrap)
  ".cm-math": { cursor: "text" },
  ".cm-math-display": { display: "inline-block", width: "100%", textAlign: "center" },
  ".cm-math-block": { display: "block", textAlign: "center", padding: "0.35em 0", cursor: "text", fontStyle: "normal" },
  ".cm-math-err": { textDecoration: "underline", textDecorationStyle: "wavy", textDecorationColor: "hsl(var(--danger))", textUnderlineOffset: "3px" },
  ".cm-table": { borderCollapse: "collapse", fontFamily: "system-ui, sans-serif", fontSize: "0.82em", width: "auto", margin: "0 auto" },
  ".cm-table th, .cm-table td": { border: "1px solid hsl(var(--border))", padding: "0.32em 0.7em", textAlign: "left", verticalAlign: "top" },
  ".cm-table th": { fontWeight: "600", backgroundColor: "hsl(var(--secondary) / 0.5)" },
  
  ".cm-panels, .cm-panels-top, .cm-panels-bottom": { display: "none", border: "none" },
  
  ".cm-searchMatch": { backgroundColor: "hsl(var(--primary) / 0.22)", borderRadius: "2px" },
  ".cm-searchMatch-selected": { backgroundColor: "hsl(var(--primary) / 0.38)", outline: "1px solid hsl(var(--primary))", borderRadius: "2px" },
});

const hiddenSearchPanel = () => {
  const dom = document.createElement("div");
  dom.className = "cm-find-hidden";
  dom.style.display = "none";
  return { dom, top: true };
};

// the first prose paragraph (so the cursor doesn't sit on the H1 and expose its "# ")
function firstProsePos(text: string): number {
  const lines = text.split("\n");
  let off = 0, seenHeading = false;
  // past a leading frontmatter block, so the caret never opens inside hidden settings
  const fm = /^---\n[\s\S]*?\n---(\n|$)/.exec(text);
  const skip = fm ? fm[0].length : 0;
  for (const ln of lines) {
    if (off < skip) { off += ln.length + 1; continue; }
    const s = ln.trim();
    if (/^#{1,6}\s/.test(s)) seenHeading = true;
    else if (seenHeading && s && !/^[-*]{3,}$/.test(s) && !s.startsWith("**") && !s.startsWith("*") && !s.startsWith("!")) return off;
    off += ln.length + 1;
  }
  return Math.min(skip, text.length);
}

function computeMention(view: EditorView): MentionInfo | null {
  const sel = view.state.selection.main;
  if (!sel.empty) return null;
  const head = sel.head;
  const line = view.state.doc.lineAt(head);
  const before = line.text.slice(0, head - line.from);
  const at = before.lastIndexOf("@");
  if (at < 0) return null;
  const prev = at > 0 ? before[at - 1] : "";
  if (prev && !/[\s([]/.test(prev)) return null;
  const query = before.slice(at + 1);
  if (/[@\n]/.test(query) || query.length > 64) return null;
  if (query.length && query[0] === " ") return null;
  const coords = view.coordsAtPos(head);
  if (!coords) return null;
  return { query, from: line.from + at, to: head, left: coords.left, top: coords.top, bottom: coords.bottom };
}

function computeWikilink(view: EditorView): MentionInfo | null {
  const sel = view.state.selection.main;
  if (!sel.empty) return null;
  const head = sel.head;
  const line = view.state.doc.lineAt(head);
  const before = line.text.slice(0, head - line.from);
  const at = before.lastIndexOf("[[");
  if (at < 0) return null;
  const query = before.slice(at + 2);
  if (/\]\]|\[\[|[|#\n]/.test(query) || query.length > 80) return null;
  const coords = view.coordsAtPos(head);
  if (!coords) return null;
  return { query, from: line.from + at, to: head, left: coords.left, top: coords.top, bottom: coords.bottom };
}

export const MarkdownEditor = forwardRef<MdEditorHandle, {
  readOnly?: boolean;
  value: string; onChange: (v: string) => void; onBlur?: () => void; onGeometry?: () => void; onSave?: () => void; onCursor?: () => void;
  slug?: string; embeds?: Record<string, string>; tablePngs?: Record<string, boolean>; placeholder?: string; style?: DraftStyle; zoom?: number; pageStyle?: React.CSSProperties; paperBg?: string; pageBreaks?: PageBreakSpec[];
  pageTokens?: boolean;   // white-page mode -> .paper-tokens on the wrapper (the day palette for this subtree)
  citeMap?: Record<string, { status: string; rel: string }>; onCitationClick?: (rel: string) => void; onCitePage?: (rel: string, page: string) => void;
  onMention?: (m: MentionInfo | null) => void; onMentionKey?: (k: MentionKey) => boolean; mentionActive?: boolean;
  onWikilink?: (m: MentionInfo | null) => void; onWikilinkKey?: (k: MentionKey) => boolean; wikilinkActive?: boolean;
  onRequestComment?: (sel: { from: number; to: number; text: string; x: number; y: number; kind?: "text" | "figure"; rectPct?: { x: number; y: number; w: number; h: number } | null }) => void;
  // the comment the caret now sits in (null = none). `pointer` says the caret got there
  // by a mouse click on the highlight, which is the host's cue to solo the rail.
  onCursorComment?: (id: string | null, opts: { pointer: boolean }) => void;
  // Mod-Enter with the caret inside a comment's anchor: reply to THAT comment. The same
  // chord sends the reply, so the whole loop is click the highlight, ⌘⏎, type, ⌘⏎.
  onReplyAt?: (id: string) => void;
  // a one-paragraph pane (Review > Focus / Rewrite): Enter breaks the paragraph in two
  paragraphEnter?: boolean;
  onContextMenu?: (info: { x: number; y: number; hasSelection: boolean }) => void;  // right-click -> host renders the drafting menu (insert figure / diagram / cite / comment)
  figureRects?: Record<string, FigRect[]>; onFigureRectClick?: (id: string) => void;
  embedProv?: Record<string, EmbedProv>; onProvenanceOpen?: (d: { name: string; x: number; y: number }) => void;
  onExpandFigure?: (name: string) => void;   // click a figure -> open the full-view lightbox
  onEditDiagram?: (name: string) => void;    // ✎ on a hand-drawn figure -> pop-out draw.io editor
}>(function MarkdownEditor({ value, onChange, onBlur, onGeometry, onSave, onCursor, slug, embeds, tablePngs, placeholder, style, zoom, pageStyle, paperBg, pageTokens, pageBreaks, citeMap, onCitationClick, onCitePage, onMention, onMentionKey, mentionActive, onWikilink, onWikilinkKey, wikilinkActive, onRequestComment, onCursorComment, onReplyAt, paragraphEnter, onContextMenu, figureRects, onFigureRectClick, embedProv, onProvenanceOpen, onExpandFigure, onEditDiagram, readOnly = false }, ref) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const editability = useRef(new Compartment());
  // edits made since the last save was sent (null = not tracking / origin unknown)
  const sinceSave = useRef<ChangeSet | null>(null);
  const onChangeRef = useRef(onChange);
  const onBlurRef = useRef(onBlur);
  const onGeoRef = useRef(onGeometry);
  const onSaveRef = useRef(onSave);
  const onCursorRef = useRef(onCursor);
  const onCiteClickRef = useRef(onCitationClick);
  const onCitePageRef = useRef(onCitePage);
  const onMentionRef = useRef(onMention);
  const onMentionKeyRef = useRef(onMentionKey);
  const mentionActiveRef = useRef(mentionActive);
  const onWikilinkRef = useRef(onWikilink);
  const onWikilinkKeyRef = useRef(onWikilinkKey);
  const wikilinkActiveRef = useRef(wikilinkActive);
  const onReqCommentRef = useRef(onRequestComment);
  const onCursorCommentRef = useRef(onCursorComment);
  const onReplyAtRef = useRef(onReplyAt);
  const onContextMenuRef = useRef(onContextMenu);
  const paragraphEnterRef = useRef(paragraphEnter); paragraphEnterRef.current = paragraphEnter;
  const onFigRectClickRef = useRef(onFigureRectClick);
  const onProvOpenRef = useRef(onProvenanceOpen);
  const onExpandRef = useRef(onExpandFigure);
  const onEditDiagramRef = useRef(onEditDiagram);
  const lastCommentId = useRef<string | null>(null);
  const geoRaf = useRef(0);
  useEffect(() => { onChangeRef.current = onChange; onBlurRef.current = onBlur; onGeoRef.current = onGeometry; onSaveRef.current = onSave; onCursorRef.current = onCursor; onCiteClickRef.current = onCitationClick; onCitePageRef.current = onCitePage; onMentionRef.current = onMention; onMentionKeyRef.current = onMentionKey; mentionActiveRef.current = mentionActive; onWikilinkRef.current = onWikilink; onWikilinkKeyRef.current = onWikilinkKey; wikilinkActiveRef.current = wikilinkActive; onReqCommentRef.current = onRequestComment; onCursorCommentRef.current = onCursorComment; onReplyAtRef.current = onReplyAt; onContextMenuRef.current = onContextMenu; onFigRectClickRef.current = onFigureRectClick; onProvOpenRef.current = onProvenanceOpen; onExpandRef.current = onExpandFigure; onEditDiagramRef.current = onEditDiagram; });

  useEffect(() => {
    if (!host.current) return;
    const scheduleGeo = () => { if (geoRaf.current) return; geoRaf.current = requestAnimationFrame(() => { geoRaf.current = 0; onGeoRef.current?.(); }); };
    const saveKey = Prec.high(keymap.of([{ key: "Mod-s", run: () => { onSaveRef.current?.(); return true; } }]));
    const followCite = (v: EditorView): boolean => {
      const head = v.state.selection.main.head;
      const line = v.state.doc.lineAt(head);
      const cites = scanLineCites(line.text, line.from, v.state.field(citeMapField, false) ?? {}).filter((c) => c.entry.rel);
      const pg = cites.find((c) => c.page && head > c.page.from && head <= c.page.to);
      if (pg?.page && onCitePageRef.current) { onCitePageRef.current(pg.entry.rel, pg.page.num); return true; }
      const hit = cites.find((c) => head >= c.from && head <= c.to);
      if (hit && onCiteClickRef.current) { onCiteClickRef.current(hit.entry.rel); return true; }
      return false;
    };
    const citeKey = Prec.high(keymap.of([{ key: "Alt-Enter", run: followCite }]));
    // Mod-Enter inside a comment's anchored span opens THAT comment's reply box; anywhere
    // else it falls through (returns false) to CodeMirror's own insertBlankLine.
    const replyKey = Prec.high(keymap.of([{
      key: "Mod-Enter",
      run: (v) => {
        const id = commentIdAt(v, v.state.selection.main.head);
        if (!id || !onReplyAtRef.current) return false;
        onReplyAtRef.current(id);
        return true;
      },
    }]));
    const splitKey = Prec.high(keymap.of([{
      key: "Enter",
      run: (v) => {
        if (!paragraphEnterRef.current) return false;
        if (v.state.readOnly) return true;
        const doc = v.state.doc, sel = v.state.selection.main;
        let a = sel.from, b = sel.to;
        while (a > 0 && /[ \t]/.test(doc.sliceString(a - 1, a))) a--;
        while (b < doc.length && /[ \t]/.test(doc.sliceString(b, b + 1))) b++;
        if (a === 0) return true;   // nothing above the caret to break from
        // already broken here (a second Enter out of habit): nothing more to do
        if (sel.empty && doc.sliceString(Math.max(0, a - 2), a) === "\n\n") return true;
        const up = doc.sliceString(a - 1, a) === "\n", down = doc.sliceString(b, b + 1) === "\n";
        const nl = up || down ? "\n" : "\n\n";
        // before a soft break the caret goes past it too, to the start of the new paragraph
        v.dispatch({ changes: { from: a, to: b, insert: nl }, selection: { anchor: a + nl.length + (down && !up ? 1 : 0) }, scrollIntoView: true, userEvent: "input" });
        return true;
      },
    }]));
    const mk = (k: MentionKey) => () => (mentionActiveRef.current ? (onMentionKeyRef.current?.(k) ?? false)
      : wikilinkActiveRef.current ? (onWikilinkKeyRef.current?.(k) ?? false) : false);
    const mentionKey = Prec.highest(keymap.of([
      { key: "ArrowDown", run: mk("down") }, { key: "ArrowUp", run: mk("up") },
      { key: "ArrowLeft", run: mk("left") }, { key: "ArrowRight", run: mk("right") },
      { key: "Enter", run: mk("enter") }, { key: "Tab", run: mk("tab") },
      { key: "Escape", run: mk("escape") },
    ]));
    const state = EditorState.create({
      doc: value,
      selection: { anchor: Math.min(firstProsePos(value), value.length) },
      extensions: [
        editability.current.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
        EditorState.lineSeparator.of("\n"),   // byte-clean: never re-split CRLF; emit \n
        assetBaseFacet.of(slug ? "/drafting/asset?slug=" + encodeURIComponent(slug) + "&name=" : ""),
        tablePngBaseFacet.of(slug ? "/drafting/table-png?slug=" + encodeURIComponent(slug) + "&name=" : ""),
        embedField,
        tablePngField,
        figureRectsField,
        embedProvField,
        citeMapField,
        commentField,
        commentUndo,
        numberFlagField,
        history(),
        drawSelection(),
        EditorView.lineWrapping,
        markdown({ base: markdownLanguage }),
        syntaxHighlighting(hl),
        livePreview,
        frontmatterField,
        tableField,
        blockEmbedField,
        latexFigField,
        mathField,
        pageBreakField,
        softBreakField,
        cmPlaceholder(placeholder ?? "Start writing…"),
        EditorView.contentAttributes.of({ spellcheck: "true", autocorrect: "off", autocapitalize: "off" }),
        mentionKey,
        saveKey,
        citeKey,
        replyKey,
        splitKey,
        search({ top: true, createPanel: hiddenSearchPanel }),
        keymap.of([
          { key: "F3", run: findNext, shift: findPrevious, preventDefault: true },
          { key: "Mod-g", run: findNext, shift: findPrevious, preventDefault: true },
          { key: "Mod-d", run: selectNextOccurrence, preventDefault: true },
        ]),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        EditorView.updateListener.of((u) => {
          // every edit since the last save was sent, so a server merge can be mapped around it
          if (u.docChanged && sinceSave.current) sinceSave.current = sinceSave.current.compose(u.changes);
          if (u.docChanged) onChangeRef.current(u.state.doc.toString());
          if (u.docChanged || u.geometryChanged || u.viewportChanged) scheduleGeo();
          if (u.selectionSet) {
            onCursorRef.current?.();
            const id = commentIdAt(u.view, u.state.selection.main.head);
            if (id !== lastCommentId.current) { lastCommentId.current = id; onCursorCommentRef.current?.(id, { pointer: false }); }
          }
          if (u.docChanged || u.selectionSet) onMentionRef.current?.(computeMention(u.view));
          if ((u.docChanged || u.selectionSet) && onWikilinkRef.current) onWikilinkRef.current(computeWikilink(u.view));
        }),
        EditorView.domEventHandlers({
          blur: () => { onBlurRef.current?.(); return false; },
          contextmenu: (e, v) => {
            if (onContextMenuRef.current) {
              e.preventDefault();
              const sel = v.state.selection.main;
              const pos = v.posAtCoords({ x: e.clientX, y: e.clientY });
              let hasSelection = !sel.empty;
              // the Menu key / Shift+F10 arrive as a synthetic event at the caret: keep the
              // caret and selection exactly where they are instead of re-hitting coordinates
              if (e.isTrusted && pos != null && (sel.empty || pos < sel.from || pos > sel.to)) {
                v.dispatch({ selection: { anchor: pos } });
                hasSelection = false;
              }
              onContextMenuRef.current({ x: e.clientX, y: e.clientY, hasSelection });
              return true;
            }
            const sel = v.state.selection.main;
            if (sel.empty || !onReqCommentRef.current) return false;
            e.preventDefault();
            onReqCommentRef.current({ from: sel.from, to: sel.to, text: v.state.sliceDoc(sel.from, sel.to), x: e.clientX, y: e.clientY });
            return true;
          },
          mousedown: (e) => {
            // the ':page' span jumps the source PDF to that page; the author/year opens
            // the note. Check the page span first (it sits inside/next to the cite span).
            const pel = (e.target as HTMLElement)?.closest?.("[data-cite-page]") as HTMLElement | null;
            if (pel && onCitePageRef.current) {
              const prel = pel.getAttribute("data-cite-rel"); const page = pel.getAttribute("data-cite-page");
              if (prel && page) { e.preventDefault(); onCitePageRef.current(prel, page); return true; }
            }
            const el = (e.target as HTMLElement)?.closest?.("[data-cite-rel]") as HTMLElement | null;
            const rel = el?.getAttribute("data-cite-rel");
            if (el && rel && onCiteClickRef.current) { e.preventDefault(); onCiteClickRef.current(rel); return true; }
            return false;
          },
        }),
        theme,
      ],
    });
    const v = new EditorView({ state, parent: host.current });
    view.current = v;
    const onFigureComment = (e: Event) => {
      const detail = (e as CustomEvent<FigureCommentDetail>).detail;
      if (!detail || !onReqCommentRef.current) return;
      onReqCommentRef.current({ from: detail.from, to: detail.from + detail.text.length, text: detail.text, x: detail.x, y: detail.y, kind: "figure", rectPct: detail.rectPct });
    };
    host.current.addEventListener("cm-figure-comment", onFigureComment);
    // a plain click on a figure (or its expand button) opens the full-view lightbox
    const onFigureExpand = (e: Event) => {
      const detail = (e as CustomEvent<{ name: string }>).detail;
      if (detail?.name) onExpandRef.current?.(detail.name);
    };
    host.current.addEventListener("cm-figure-expand", onFigureExpand);
    // numbered rect badge -> activate its comment; provenance chip -> host popover
    const onFigureRect = (e: Event) => {
      const detail = (e as CustomEvent<{ id: string }>).detail;
      if (detail?.id) onFigRectClickRef.current?.(detail.id);
    };
    const onProvOpen = (e: Event) => {
      const detail = (e as CustomEvent<{ name: string; x: number; y: number }>).detail;
      if (detail?.name) onProvOpenRef.current?.(detail);
    };
    host.current.addEventListener("cm-figure-rect", onFigureRect);
    host.current.addEventListener("cm-provenance-open", onProvOpen);
    // ✎ on a hand-drawn figure -> the host opens the pop-out draw.io editor
    const onDiagramEdit = (e: Event) => {
      const detail = (e as CustomEvent<{ name: string }>).detail;
      if (detail?.name) onEditDiagramRef.current?.(detail.name);
    };
    host.current.addEventListener("cm-diagram-edit", onDiagramEdit);
    const onCommentMouseDown = (ev: MouseEvent) => {
      const t = ev.target as HTMLElement | null;
      if (!t || typeof t.closest !== "function" || !t.closest(".cm-comment-hl")) return;
      const pos = v.posAtCoords({ x: ev.clientX, y: ev.clientY });
      const id = pos == null ? null : commentIdAt(v, pos);
      if (id) { lastCommentId.current = id; onCursorCommentRef.current?.(id, { pointer: true }); }
    };
    v.contentDOM.addEventListener("mousedown", onCommentMouseDown);
    requestAnimationFrame(() => onGeoRef.current?.());
    return () => { if (geoRaf.current) cancelAnimationFrame(geoRaf.current); host.current?.removeEventListener("cm-figure-comment", onFigureComment); host.current?.removeEventListener("cm-figure-expand", onFigureExpand); host.current?.removeEventListener("cm-figure-rect", onFigureRect); host.current?.removeEventListener("cm-provenance-open", onProvOpen); host.current?.removeEventListener("cm-diagram-edit", onDiagramEdit); v.contentDOM.removeEventListener("mousedown", onCommentMouseDown); v.destroy(); view.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    view.current?.dispatch({ effects: editability.current.reconfigure([
      EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly),
    ]) });
  }, [readOnly]);

  useEffect(() => { const v = view.current; if (v) v.dispatch({ effects: setEmbeds.of(embeds ?? {}) }); }, [embeds]);
  // artifact page-break markers (empty array clears them)
  useEffect(() => { const v = view.current; if (v) v.dispatch({ effects: setPageBreaksFx.of(pageBreaks ?? []) }); }, [pageBreaks]);
  // push figure-comment rect overlays + per-embed provenance chips into the view
  useEffect(() => { const v = view.current; if (v) v.dispatch({ effects: setFigureRects.of(figureRects ?? {}) }); }, [figureRects]);
  useEffect(() => { const v = view.current; if (v) v.dispatch({ effects: setEmbedProv.of(embedProv ?? {}) }); }, [embedProv]);

  // push the set of table embeds that have a typeset sibling PDF (render the PNG)
  useEffect(() => { const v = view.current; if (v) v.dispatch({ effects: setTablePngs.of(tablePngs ?? {}) }); }, [tablePngs]);

  // push the in-text citation resolution map so cites render as links / lint flags
  useEffect(() => { const v = view.current; if (v) v.dispatch({ effects: setCiteMap.of(citeMap ?? {}) }); }, [citeMap]);

  useEffect(() => {
    const v = view.current; if (!v) return;
    v.requestMeasure();
    const r1 = requestAnimationFrame(() => { v.requestMeasure(); onGeoRef.current?.(); });
    const r2 = requestAnimationFrame(() => onGeoRef.current?.());
    const t = setTimeout(() => { v.requestMeasure(); onGeoRef.current?.(); }, 120);
    return () => { cancelAnimationFrame(r1); cancelAnimationFrame(r2); clearTimeout(t); };
  }, [zoom]);

  useImperativeHandle(ref, () => ({
    insertAtCursor: (text: string) => {
      const v = view.current; if (!v) return;
      const pos = v.state.selection.main.head;
      const pre = pos > 0 && v.state.sliceDoc(pos - 1, pos) !== "\n" ? "\n" : "";
      const ins = pre + text + "\n";
      v.dispatch({ changes: { from: pos, insert: ins }, selection: { anchor: pos + ins.length }, scrollIntoView: true });
      v.focus();
    },
    setContent: (text: string) => {
      const v = view.current; if (!v) return;
      const ch = minimalChange(v.state.doc.toString(), text);
      if (!ch) return;
      v.dispatch({ changes: ch });
    },
    markSaveStart: (sentText: string) => {
      const v = view.current;
      sinceSave.current = v && v.state.doc.toString() === sentText ? ChangeSet.empty(v.state.doc.length) : null;
    },
    adoptServerText: (sentText: string, mergedText: string) => {
      const v = view.current, cs = sinceSave.current;
      if (!v || !cs || cs.length !== sentText.length) return false;
      const ch = minimalChange(sentText, mergedText);
      if (!ch) return true;
      // the foreign change must sit clear of everything typed since the save left
      if (cs.touchesRange(ch.from, ch.to)) return false;
      const from = cs.mapPos(ch.from, -1), to = cs.mapPos(ch.to, 1);
      if (from > to || to > v.state.doc.length) return false;
      if (v.state.sliceDoc(from, to) !== sentText.slice(ch.from, ch.to)) return false;
      v.dispatch({ changes: { from, to, insert: ch.insert } });
      return true;
    },
    // replace [from,to] with text and drop the caret after it — the @-mention insert
    // (swap the typed "@query" for a real in-text citation).
    replaceRange: (from: number, to: number, text: string) => {
      const v = view.current; if (!v) return;
      const len = v.state.doc.length;
      const f = Math.max(0, Math.min(from, len)), t = Math.max(f, Math.min(to, len));
      v.dispatch({ changes: { from: f, to: t, insert: text }, selection: { anchor: f + text.length }, scrollIntoView: true });
      v.focus();
    },
    getText: () => view.current?.state.doc.toString() ?? "",
    focus: () => view.current?.focus(),
    scrollToLine: (line0: number) => {
      const v = view.current; if (!v) return;
      const n = Math.min(Math.max(1, line0 + 1), v.state.doc.lines);
      const line = v.state.doc.line(n);
      v.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: "start", yMargin: 20 }) });
      v.focus();
    },
    posTop: (pos: number) => { const v = view.current; if (!v) return 0; const p = Math.min(Math.max(0, pos), v.state.doc.length); try { return v.lineBlockAt(p).top; } catch { return 0; } },
    contentHeight: () => view.current?.contentHeight ?? 0,
    cursorPos: () => view.current?.state.selection.main.head ?? 0,
    selectedText: () => {
      const s = view.current?.state;
      return s ? s.selection.ranges.filter((r) => !r.empty).map((r) => s.sliceDoc(r.from, r.to)).join("\n") : "";
    },
    getView: () => view.current,
    // re-measure the viewport (the outer container owns the scroll, so CM doesn't hear
    // scroll events — call this as it scrolls so far-off content renders, never blanks).
    requestMeasure: () => view.current?.requestMeasure(),
    // anchored review comments
    setCommentRanges: (ranges: CRange[]) => { const v = view.current; if (v) v.dispatch({ effects: setCommentRanges.of(ranges) }); },
    commentRanges: () => { const v = view.current; return v ? readCommentRanges(v.state.field(commentField).deco) : []; },
    commentGoneAt: (id: string) => { const v = view.current; return v ? v.state.field(commentField).gone.get(id) ?? null : null; },
    setActiveComment: (id: string | null) => { const v = view.current; if (v) v.dispatch({ effects: setActiveComment.of(id) }); },
    setNumberFlags: (flags: NumRange[]) => { const v = view.current; if (v) v.dispatch({ effects: setNumberFlagsFx.of(flags) }); },
    selectionRange: () => { const v = view.current; if (!v) return null; const s = v.state.selection.main; if (s.empty) return null; return { from: s.from, to: s.to, text: v.state.sliceDoc(s.from, s.to) }; },
    scrollToPos: (pos: number) => { const v = view.current; if (!v) return; const p = Math.min(Math.max(0, pos), v.state.doc.length); v.dispatch({ selection: { anchor: p }, effects: EditorView.scrollIntoView(p, { y: "center" }) }); v.focus(); },
    caretTo: (pos: number) => { const v = view.current; if (!v) return; const p = Math.min(Math.max(0, pos), v.state.doc.length); v.dispatch({ selection: { anchor: p }, effects: EditorView.scrollIntoView(p, { y: "nearest" }) }); v.focus(); },
    posAtViewportY: (clientY: number) => {
      const v = view.current; if (!v) return null;
      const rect = v.contentDOM.getBoundingClientRect();
      // probe at the content's horizontal centre so we land on a real line, never a gutter;
      // precise=false => nearest position (no null when y sits just past the last line).
      return v.posAtCoords({ x: rect.left + rect.width / 2, y: clientY }, false);
    },
    screenTopOf: (pos: number) => {
      const v = view.current; if (!v) return null;
      const p = Math.min(Math.max(0, pos), v.state.doc.length);
      return v.coordsAtPos(p)?.top ?? null;
    },
  }), []);

  const vars = { ...DRAFT_STYLE_VARS[style ?? "manuscript"], "--draft-zoom": String(zoom ?? 1), ...(pageStyle ?? {}) } as React.CSSProperties;
  return (
    <div className={`relative w-full${pageTokens ? " paper-tokens" : ""}`} style={vars}>
      {paperBg && (
        <div aria-hidden className="pointer-events-none absolute left-1/2 -translate-x-1/2"
          style={{ top: "-16px", bottom: "-16px", width: "min(calc((var(--draft-measure, 760px) * var(--draft-zoom, 1)) + 88px), calc(100% + 88px))", background: paperBg, border: "1px solid hsl(var(--border))", borderRadius: "4px", boxShadow: "0 4px 34px hsl(0 0% 0% / 0.26)", zIndex: 0 }} />
      )}
      <div ref={host} className="relative w-full" style={{ zIndex: 1 }} />
    </div>
  );
});
