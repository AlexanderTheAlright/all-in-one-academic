

import { findMath, texToMathML, mathDom, mathIsTall } from "./texmath";

export type SpacingMode = "single" | "double";
export type PageProfile = "docx" | "pdf";

export interface PgBlock {
  kind: "title" | "byline" | "heading" | "para" | "quote" | "listitem" | "figure" | "table" | "refmark" | "pagebreak" | "abstracthead" | "math";
  mathLines?: number;         // math: a display equation's height in body lines (an estimate)
  level?: number;             // headings: 2..4 (1 = title)
  from: number; to: number;   // char range in the RAW markdown (inclusive start, exclusive end)
  text: string;               // inline-markdown source for measurement
  indent?: boolean;           // body para that takes the 0.5in first-line indent
  isNote?: boolean;           // a *Note.* line under a figure/table — 10pt, single-spaced
  embedName?: string;         // figure/table: the ![[name]] target
  inAbstract?: boolean;
  inRefs?: boolean;
}

export interface PageSlice {
  page: number;               // 1-based, printed page of the BODY artifact
  topOffset: number;          // markdown char offset where this page begins
  breakMidBlock: boolean;     // the page starts mid-paragraph
}

export interface PaginationResult {
  profile: PageProfile;
  spacing: SpacingMode;
  pages: number;              // total pages of the artifact (docx: incl. title/abstract page)
  bodyPages: number;
  slices: PageSlice[];        // one per page, in order — page view renders from these
  approx: boolean;            // pdf profile: line-level positions are estimates
  refsUnknown: boolean;       // a ![[references]] transclusion exists whose text we can't see
  lineStarts: { offset: number; y: number; h: number; blockIdx: number; page: number }[];
  blockList: PgBlock[];
  contentHeightPx: number;
}

// ---- geometry constants (pt; 1pt = 96/72 px) -------------------------------
export const PT = 96 / 72;
const PAGE_CONTENT_PT = 648;             // 9in body box
const COL_PX = 624;                      // 6.5in at 96dpi

const DOCX = {
  pitch: { single: 13.8, double: 27.6 },
  headBefore: 12, headAfter: 0,
  paraBefore: 0, paraAfter: 0,
  indentPx: 48,                           // 0.5in first-line indent
  quoteIndentPx: 48,                      // 0.5in each side
  listBefore: 1.8, listAfter: 1.8,        // "Compact" 36 twips
  refHang: true,
};

const PDF = {
  pitch: { single: 14.5, double: 24.0 },  // \baselineskip 12pt cls / setspace 1.655
  topskip: 12,                            // first baseline sits 12pt below body top
  headBefore: 12, headAfter: 6,
  indentPx: 48,
  refSep: 6,
};

const FM_RE = /^---\n[\s\S]*?\n---\n?/;

/** Read the `spacing:` frontmatter key (single|double) or null. */
export function readSpacing(text: string): SpacingMode | null {
  const m = FM_RE.exec(text || "");
  if (!m) return null;
  const k = /^spacing\s*:\s*(.+?)\s*$/m.exec(m[0]);
  if (!k) return null;
  const v = k[1].trim().replace(/^["']|["']$/g, "").toLowerCase();
  return v === "double" || v === "single" ? (v as SpacingMode) : null;
}

export const DOC_FONTS: Record<string, { label: string; factor: number; css: string; latex: string | null }> = {
  times:    { label: "Times New Roman",  factor: 1.15, css: "'Times New Roman','Liberation Serif',serif", latex: "ptm" },
  georgia:  { label: "Georgia",          factor: 1.14, css: "Georgia,'Times New Roman',serif",            latex: null },
  palatino: { label: "Palatino",         factor: 1.35, css: "'Palatino Linotype','Book Antiqua',Palatino,serif", latex: "ppl" },
  cambria:  { label: "Cambria",          factor: 1.17, css: "Cambria,Georgia,serif",                      latex: null },
};

/** The `font:`/`fontsize:` frontmatter keys (document typography). */
export function readDocFont(text: string): string {
  const m = FM_RE.exec(text || "");
  const k = m && /^font\s*:\s*(.+?)\s*$/m.exec(m[0]);
  const v = k ? k[1].trim().replace(/^["']|["']$/g, "").toLowerCase() : "";
  return DOC_FONTS[v] ? v : "times";
}
export function readDocSize(text: string): number {
  const m = FM_RE.exec(text || "");
  const k = m && /^fontsize\s*:\s*"?(\d{1,2})/m.exec(m[0]);
  const v = k ? parseInt(k[1], 10) : 12;
  return v >= 9 && v <= 14 ? v : 12;
}

export function formatDefaultSpacing(publish: string | null | undefined): SpacingMode {
  return (publish || "working").toLowerCase() === "working" ? "single" : "double";
}

const ACK_RE = /^#{1,3}\s*(acknowledge?ments|funding|author\s+note)\b/i;   // mirrors _ACK_SECTION_RE
const FIGCAP_RE = /^\*\*(Figure|Table)\s+[^*]*\*\*/;
const EMBED_RE = /^!\[\[([^\]]+)\]\]\s*$/;
const NOTE_RE = /^\*Note\b/;
// mirrors build_docx._DRAFT_NOTE_RE — a fully-italic line opening with one of these
// phrases is an editorial draft note and never reaches the compiled body
const DRAFT_NOTE_RE = /^(target\s+journal|draft\b|draft\s+dated|working\s+draft|version|submitted\s+to|prepared\s+for|do\s+not\s+cite|word\s+count|source\s+for|note\s+to)\b/i;
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|svg|webp)$/i;
const FOOTNOTE_DEF_RE = /^\[\^[^\]]+\]:/;
const COMMENT_ONLY_RE = /^(<!--[\s\S]*?-->\s*)+$/;

export function parseBlocks(raw: string): { blocks: PgBlock[]; refsUnknown: boolean } {
  const blocks: PgBlock[] = [];
  let refsUnknown = false;
  const fm = FM_RE.exec(raw);
  let pos = fm ? fm[0].length : 0;
  const len = raw.length;
  let seenTitle = false, inAbstract = false, inRefs = false, skipSection = false;
  let afterHeading = true;

  while (pos < len) {
    // paragraph = run of non-blank lines
    let end = pos;
    while (end < len && raw[end] === "\n") { pos++; end++; }
    if (pos >= len) break;
    let pend = raw.indexOf("\n\n", pos);
    if (pend === -1) pend = len;
    const text = raw.slice(pos, pend);
    let t = text.trim();
    const from = pos, to = pend;
    pos = pend;
    if (!t) continue;

    let h = /^(#{1,6})\s+(.*)$/.exec(t);
    // setext heading: "Title\n====" (H1) or "Title\n----" (H2) inside one paragraph
    if (!h) {
      const sx = /^([^\n]+)\n(={3,}|-{3,})\s*$/.exec(t);
      if (sx) h = ["", sx[2][0] === "=" ? "#" : "##", sx[1].trim()] as unknown as RegExpExecArray;
    }
    if (h) {
      const level = h[1].length;
      if (level === 1 && !seenTitle) {
        seenTitle = true; skipSection = false; inAbstract = false; inRefs = false;
        blocks.push({ kind: "title", level: 1, from, to, text: h[2] });
        afterHeading = true;
        continue;
      }
      skipSection = ACK_RE.test(t);
      inAbstract = /^#{1,3}\s*abstract\s*$/i.test(t);
      inRefs = /^#{1,3}\s*references\s*$/i.test(t);
      if (skipSection) continue;
      blocks.push({ kind: inAbstract ? "abstracthead" : "heading", level, from, to, text: h[2], inAbstract, inRefs });
      afterHeading = true;
      continue;
    }
    if (skipSection) continue;
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) continue;                                // thematic breaks stripped
    if (/^\\(newpage|clearpage|pagebreak)\s*$/.test(t)) {                          // manual page break (context menu)
      blocks.push({ kind: "pagebreak", from, to, text: t });
      continue;
    }
    if (COMMENT_ONLY_RE.test(t)) continue;
    if (FOOTNOTE_DEF_RE.test(t)) continue;                                          // footnote defs render at page bottom, not in flow
    if (/^\*[^*].*\*$/.test(t) && DRAFT_NOTE_RE.test(t.replace(/^[*_ ]+|[*_ ]+$/g, ""))) continue;  // draft notes
    // the byline ZONE: build_docx._blind_scrub drops EVERYTHING between the title
    // heading and the next #/## heading — affiliations, word counts, all of it
    const last = blocks[blocks.length - 1];
    if (seenTitle && last && (last.kind === "title" || last.kind === "byline") && !EMBED_RE.test(t)) {
      blocks.push({ kind: "byline", from, to, text: t });                          // stripped when blind
      continue;
    }
    const em = EMBED_RE.exec(t);
    if (em) {
      const name = em[1].split("|")[0].trim();
      if (/references(\.md)?$/i.test(name)) { blocks.push({ kind: "refmark", from, to, text: t }); refsUnknown = true; continue; }
      const isTable = /^tab[.\-_]/i.test(name) || /\.csv$/i.test(name);
      const isImage = IMAGE_EXT_RE.test(name);
      if (!isTable && !isImage) {
        // a non-image, non-table embed is a markdown transclusion — its printed
        // length is unknown here, exactly like ![[references]]
        blocks.push({ kind: "refmark", from, to, text: t });
        refsUnknown = true;
        continue;
      }
      blocks.push({ kind: isTable ? "table" : "figure", from, to, text: t, embedName: name, inAbstract, inRefs });
      afterHeading = false;
      continue;
    }
    const dm = /^\$\$/.test(t) ? findMath(t) : [];
    if (dm.length === 1 && dm[0].display && dm[0].from === 0 && dm[0].to === t.length) {
      const rows = 1 + (dm[0].tex.match(/\\\\/g) || []).length;
      blocks.push({ kind: "math", from, to, text: t, mathLines: rows * (mathIsTall(dm[0].tex) ? 2.4 : 1.6), inAbstract, inRefs });
      afterHeading = false;
      continue;
    }
    if (/^>/.test(t)) {
      blocks.push({ kind: "quote", from, to, text: t.replace(/^>\s?/gm, ""), inAbstract, inRefs });
      afterHeading = false;
      continue;
    }
    if (/^([-*+]|\d+\.)\s/.test(t)) {
      // each list line is its own Compact paragraph in the docx
      let lstart = from;
      for (const line of text.split("\n")) {
        const lfrom = lstart; lstart += line.length + 1;
        const lt = line.trim();
        if (!lt) continue;
        blocks.push({ kind: "listitem", from: lfrom, to: Math.min(lstart, to), text: lt.replace(/^([-*+]|\d+\.)\s+/, ""), inAbstract, inRefs });
      }
      afterHeading = false;
      continue;
    }
    blocks.push({ kind: "para", from, to, text: t, indent: !afterHeading && !inAbstract && !FIGCAP_RE.test(t) && !NOTE_RE.test(t), isNote: NOTE_RE.test(t), inAbstract, inRefs });
    afterHeading = false;
  }
  return { blocks, refsUnknown };
}

// ---- inline markdown → DOM (bold/italic/code/links/cites as Word renders) ---
function inlineDom(text: string, into: HTMLElement, baseOffset: number) {
  // wrap every word in a span carrying its source offset; keep bold/italic real
  // (they change advance widths). Strip markers the artifact never prints.
  let i = 0; const n = text.length;
  let bold = false, ital = false;
  let wordStart = -1, word = "";
  const flush = (at: number) => {
    if (!word) return;
    const s = document.createElement("span");
    s.textContent = word;
    if (bold) s.style.fontWeight = "bold";
    if (ital) s.style.fontStyle = "italic";
    s.setAttribute("data-off", String(baseOffset + wordStart));
    into.appendChild(s);
    word = ""; wordStart = -1;
    void at;
  };
  const space = () => { into.appendChild(document.createTextNode(" ")); };
  // $…$ spans measure and print as MathML, one "word" each; nothing inside them toggles
  // italics (a `_` in TeX is a subscript, not emphasis)
  const math = new Map(findMath(text).map((m) => [m.from, m]));
  while (i < n) {
    const c = text[i];
    const mm = c === "$" ? math.get(i) : undefined;
    if (mm) {
      flush(i);
      const r = texToMathML(mm.tex, mm.display);
      const s = document.createElement("span");
      s.setAttribute("data-off", String(baseOffset + i));
      if (r.errors.length) s.title = r.errors.join("\n");
      s.appendChild(mathDom(r.node));
      into.appendChild(s);
      i = mm.to; continue;
    }
    if (c === "\\" && text[i + 1] === "$") {                      // pandoc's escaped dollar prints bare
      if (wordStart === -1) wordStart = i;
      word += "$"; i += 2; continue;
    }
    if (c === "<" && text.startsWith("<!--", i)) {                // inline HTML comment — never prints
      const close = text.indexOf("-->", i);
      flush(i);
      i = close === -1 ? n : close + 3;
      continue;
    }
    if (c === "*" || c === "_") {
      let run = 1;
      while (i + run < n && text[i + run] === c) run++;
      flush(i);
      if (run >= 2) bold = !bold; else ital = !ital;
      i += Math.min(run, 2);
      continue;
    }
    if (c === "[" && text[i + 1] === "[") {                       // [[wiki|label]]
      const close = text.indexOf("]]", i);
      if (close !== -1) {
        const inner = text.slice(i + 2, close);
        const label = inner.includes("|") ? inner.slice(inner.indexOf("|") + 1) : inner;
        flush(i);
        for (const w of label.split(/\s+/)) { if (w) { word = w; wordStart = i; flush(i); space(); } }
        i = close + 2; continue;
      }
    }
    if (c === "[") {                                              // [text](url)
      const mid = text.indexOf("](", i);
      const close = mid !== -1 ? text.indexOf(")", mid) : -1;
      if (mid !== -1 && close !== -1) {
        const label = text.slice(i + 1, mid);
        flush(i);
        for (const w of label.split(/\s+/)) { if (w) { word = w; wordStart = i; flush(i); space(); } }
        i = close + 1; continue;
      }
    }
    if (c === "`") { i++; continue; }
    if (/\s/.test(c)) { flush(i); space(); i++; continue; }
    if (wordStart === -1) wordStart = i;
    word += c; i++;
  }
  flush(n);
}

// ---- measurement -----------------------------------------------------------
export interface EmbedSizes { [name: string]: { w: number; h: number } }  // natural px

interface Measured {
  block: PgBlock;
  lines: { offset: number }[];   // wrapped lines with their start offsets
  extraPt: number;               // fixed vertical add-ons that are not pitch lines (images)
}

let HOST: HTMLDivElement | null = null;
let HOST_KEY = "";
let MEASURE_FONT = DOC_FONTS.times.css;
let MEASURE_SIZE_PX = 16;
function setMeasureCtx(fontCss: string, sizePx: number) {
  MEASURE_FONT = fontCss; MEASURE_SIZE_PX = sizePx;
}
function host(): HTMLDivElement {
  const key = MEASURE_FONT + "|" + MEASURE_SIZE_PX;
  if (HOST && document.body.contains(HOST) && HOST_KEY === key) return HOST;
  if (HOST && document.body.contains(HOST)) document.body.removeChild(HOST);
  const d = document.createElement("div");
  d.setAttribute("aria-hidden", "true");
  d.style.cssText = `position:absolute;left:-10000px;top:0;width:${COL_PX}px;visibility:hidden;pointer-events:none;` +
    `font-family:${MEASURE_FONT};font-size:${MEASURE_SIZE_PX}px;line-height:1.15;text-align:left;`;
  document.body.appendChild(d);
  HOST = d; HOST_KEY = key;
  return d;
}

/** The styled DOM element for one print block — the ONE renderer both the
 * measurement pass and the Page-view preview use, so they can never disagree. */
export function buildBlockEl(b: PgBlock, profile: PageProfile): HTMLDivElement {
  const el = document.createElement("div");
  el.style.margin = "0"; el.style.padding = "0";
  if (b.kind === "title") { el.style.fontWeight = "bold"; el.style.textAlign = "center"; }
  if (b.kind === "heading" || b.kind === "abstracthead") {
    if ((b.level ?? 2) === 3) { el.style.fontStyle = "italic"; }
    else el.style.fontWeight = "bold";
    if (profile === "docx" && (b.level ?? 2) === 2 && b.inAbstract) el.style.fontWeight = "bold";
  }
  if (b.kind === "quote") { el.style.paddingLeft = DOCX.quoteIndentPx + "px"; el.style.paddingRight = DOCX.quoteIndentPx + "px"; }
  if (b.kind === "listitem") { el.style.paddingLeft = "32px"; el.style.textIndent = "-16px"; }
  if (b.kind === "para" && b.indent) el.style.textIndent = DOCX.indentPx + "px";
  if (b.isNote) el.style.fontSize = "13.3px";                                    // 10pt figure note
  if (b.kind === "para" && b.inRefs) {                                           // hanging reference entry
    el.style.paddingLeft = DOCX.indentPx + "px"; el.style.textIndent = -DOCX.indentPx + "px";
  }
  if (profile === "pdf" && b.kind === "para" && !b.isNote && !b.inRefs) { el.style.textAlign = "justify"; if (b.indent) el.style.textIndent = DOCX.indentPx + "px"; }
  if (b.kind === "math") {
    // centred on one line box: inline math in display style, so Page view's line-height
    // (the block's whole estimated height) centres it vertically
    const m = findMath(b.text)[0];
    const r = texToMathML(m ? m.tex : b.text, true);
    const node = mathDom(r.node);
    node.setAttribute("display", "inline");
    node.setAttribute("displaystyle", "true");
    el.style.textAlign = "center";
    if (r.errors.length) el.title = r.errors.join("\n");
    el.appendChild(node);
    return el;
  }
  if (b.kind !== "figure" && b.kind !== "table" && b.kind !== "refmark" && b.kind !== "pagebreak") {
    inlineDom(b.text, el, b.from);
  }
  return el;
}

/** Print column width (px at 96dpi) and font stack for preview containers. */
export const PRINT_COL_PX = COL_PX;
export const PRINT_FONT = `"Times New Roman","Liberation Serif",serif`;

/** The document's typography for preview containers (frontmatter-driven). */
export function docTypography(raw: string): { css: string; sizePx: number } {
  const f = DOC_FONTS[readDocFont(raw)];
  return { css: f.css, sizePx: Math.round(readDocSize(raw) * PT * 100) / 100 };
}

function measureBlock(b: PgBlock, embeds: EmbedSizes | undefined, profile: PageProfile): Measured {
  const h = host();

  if (b.kind === "figure" || b.kind === "table") {
    // vertical size comes from the embed's aspect ratio at 6in print width
    const nat = embeds?.[b.embedName || ""];
    const wIn = 6.0;
    const hIn = nat && nat.w > 0 ? Math.min((nat.h / nat.w) * wIn, 8.0) : 4.0;   // unknown → 4in placeholder
    return { block: b, lines: [{ offset: b.from }], extraPt: hIn * 72 };
  }
  if (b.kind === "refmark" || b.kind === "pagebreak" || b.kind === "math") return { block: b, lines: [{ offset: b.from }], extraPt: 0 };

  const el = buildBlockEl(b, profile);
  h.appendChild(el);
  const spans = el.querySelectorAll("span[data-off]");
  const lines: { offset: number }[] = [];
  let lastTop = -1e9;
  spans.forEach((s) => {
    const r = (s as HTMLElement).getClientRects()[0];
    if (!r) return;
    if (r.top - lastTop > 4) { lines.push({ offset: Number((s as HTMLElement).getAttribute("data-off")) }); lastTop = r.top; }
  });
  if (!lines.length) lines.push({ offset: b.from });
  h.removeChild(el);
  return { block: b, lines, extraPt: 0 };
}

// ---- pagination ------------------------------------------------------------
export function paginate(raw: string, opts: {
  profile: PageProfile; spacing: SpacingMode; embeds?: EmbedSizes; blind?: boolean;
}): PaginationResult {
  const { profile, spacing } = opts;
  const blind = opts.blind !== false;               // dashboard compiles --blind by default
  const { blocks: all, refsUnknown } = parseBlocks(raw);
  const blocks = all
    .filter((b) => !(blind && b.kind === "byline"))
    .filter((b) => !(profile === "pdf" && (b.kind === "title" || b.kind === "byline" || b.kind === "abstracthead" || b.inAbstract)));

  const docFont = readDocFont(raw);
  const docSize = readDocSize(raw);
  const F = DOC_FONTS[docFont];
  setMeasureCtx(F.css, docSize * PT);
  const baseLine = Math.round(F.factor * docSize * 100) / 100;   // single-space line height, pt
  const pitch = profile === "docx"
    ? (spacing === "double" ? baseLine * 2 : baseLine)
    : (spacing === "double" ? 2.0 * docSize : Math.round(1.2083 * docSize * 100) / 100);
  const pagePt = PAGE_CONTENT_PT;

  // measure everything up front
  const measured = blocks.map((b) => measureBlock(b, opts.embeds, profile));

  // walk: place lines page by page
  interface Placed { offset: number; y: number; h: number; blockIdx: number; page: number }
  const lineStarts: Placed[] = [];
  const slices: PageSlice[] = [];
  let page = 1;                                     // artifact page (docx: title+abstract = page 1)
  let y = 0;                                        // pt used on current page
  let contentYPx = 0;                               // continuous y for the page view
  const newPage = (offset: number, mid: boolean) => {
    page++; y = 0;
    slices.push({ page, topOffset: offset, breakMidBlock: mid });
  };
  slices.push({ page: 1, topOffset: blocks.length ? blocks[0].from : 0, breakMidBlock: false });

  const headBefore = profile === "pdf" ? PDF.headBefore : DOCX.headBefore;
  const headAfter = profile === "pdf" ? PDF.headAfter : DOCX.headAfter;
  const single = baseLine;
  // LaTeX: baselines sit \topskip below the box top; textheight is 650.43 TeX pt.
  const texHeight = 650.43;
  const EPS = 0.01;    // FP slack — 41.4/13.8 is 3.0000000000000004 in doubles
  const maxFit = (yy: number): number => {
    if (profile === "docx") {
      if (yy + single > pagePt + EPS) return 0;
      return Math.floor((pagePt - yy - single + EPS) / pitch) + 1;
    }
    if (yy + PDF.topskip > texHeight + EPS) return 0;
    return Math.floor((texHeight - yy - PDF.topskip + EPS) / pitch) + 1;
  };
  const isHeadKind = (k: PgBlock["kind"]) => k === "heading" || k === "title" || k === "abstracthead";
  const keepChainPt = (bi: number): number => {
    let pt = 0;
    let i = bi;
    while (i < measured.length && isHeadKind(measured[i].block.kind)) {
      if (i > bi) pt += headBefore;
      pt += measured[i].lines.length * pitch;
      i++;
    }
    if (i < measured.length) {
      const nx = measured[i];
      if (nx.block.kind === "figure" || nx.block.kind === "table") pt += 2 * pitch;
      else if (nx.block.kind === "math") pt += (nx.block.mathLines ?? 1.6) * pitch;
      else pt += Math.min(2, nx.lines.length) * pitch;
    }
    return pt;
  };

  for (let bi = 0; bi < measured.length; bi++) {
    const m = measured[bi];
    const b = m.block;
    const isHead = isHeadKind(b.kind);
    const before = isHead ? headBefore : b.kind === "listitem" ? DOCX.listBefore : 0;
    const after = isHead ? headAfter : b.kind === "listitem" ? DOCX.listAfter : 0;

    if (b.kind === "refmark") continue;             // transcluded refs: unknown length
    if (b.kind === "pagebreak") {                   // manual \newpage — force the break
      if (y > 0) newPage(b.to, false);
      continue;
    }

    // docx: explicit page break after the abstract (before the first body heading)
    if (profile === "docx" && b.kind === "heading" && bi > 0 &&
        measured.slice(0, bi).some((x) => x.block.kind === "abstracthead") &&
        !measured.slice(0, bi).some((x) => x.block.kind === "heading" && !x.block.inAbstract)) {
      if (y > 0) newPage(b.from, false);
    }
    // docx: references heading breaks to its own page
    if (profile === "docx" && b.kind === "heading" && b.inRefs && y > 0) newPage(b.from, false);

    if (b.kind === "figure" || b.kind === "table" || b.kind === "math") {
      // a display equation never splits: it moves whole, like a figure
      const imgPt = b.kind === "math" ? (b.mathLines ?? 1.6) * pitch : m.extraPt;
      if (y + before + imgPt > pagePt && y > 0) newPage(b.from, false);
      lineStarts.push({ offset: b.from, y: contentYPx, h: imgPt * PT, blockIdx: bi, page });
      y += (y === 0 ? 0 : before) + Math.min(imgPt, pagePt) + after;
      contentYPx += imgPt * PT;
      continue;
    }

    const n = m.lines.length;
    const bPitch = profile === "docx" && b.inRefs && b.kind === "para" ? baseLine * 2
      : b.isNote ? 11.5 : pitch;
    const bGlyph = b.isNote ? 11.5 : single;
    const bMaxFit = (yy: number): number => {
      if (profile === "docx") {
        if (yy + bGlyph > pagePt + EPS) return 0;
        return Math.floor((pagePt - yy - bGlyph + EPS) / bPitch) + 1;
      }
      return maxFit(yy);
    };
    const effBefore = before + (b.isNote ? 2 : 0);
    const effAfter = after + (b.isNote ? 6 : 0);
    let placedInBlock = 0;
    while (placedInBlock < n) {
      const remainingLines = n - placedInBlock;
      const beforeHere = y === 0 || placedInBlock > 0 ? 0 : effBefore;
      if (isHead && placedInBlock === 0 && y > 0) {
        const chainPt = keepChainPt(bi) - (profile === "docx" ? pitch - single : 0);
        if (y + beforeHere + chainPt > (profile === "docx" ? pagePt : texHeight - PDF.topskip) + EPS) {
          newPage(b.from, false);
          continue;
        }
      }
      let fit = bMaxFit(y + beforeHere);
      let breakAfter = false;                       // a keep rule trimmed the fit — page ends here
      if (fit >= remainingLines) fit = remainingLines;
      else {
        breakAfter = true;                          // block continues on the next page
        // widow/orphan: never strand a single line of a multi-line paragraph
        if (b.kind === "para" || b.kind === "quote") {
          if (placedInBlock === 0 && fit === 1 && n > 1) fit = 0;                  // orphan
          if (fit > 0 && remainingLines - fit === 1 && fit >= 2) fit -= 1;         // widow
        }
        if (isHead) fit = 0;                        // heading won't split from its next block
      }
      if (fit <= 0) {
        if (y === 0) { fit = Math.max(1, Math.min(remainingLines, bMaxFit(0))); breakAfter = fit < remainingLines; }
        else { newPage(m.lines[placedInBlock].offset, placedInBlock > 0); continue; }
      }
      y += beforeHere;
      for (let k = 0; k < fit; k++) {
        lineStarts.push({ offset: m.lines[placedInBlock + k].offset, y: contentYPx, h: bPitch * PT, blockIdx: bi, page });
        contentYPx += bPitch * PT;
      }
      y += fit * bPitch;
      placedInBlock += fit;
      if (placedInBlock >= n) y += effAfter;
      else if (breakAfter) newPage(m.lines[placedInBlock].offset, true);
    }
  }

  // pdf: two front sheets (title, abstract) precede the body
  const front = profile === "pdf" ? 2 : 0;
  return {
    profile, spacing,
    pages: page + front,
    bodyPages: page,
    slices,
    approx: profile === "pdf",
    refsUnknown,
    lineStarts,
    blockList: blocks,
    contentHeightPx: contentYPx,
  };
}

/** Cheap page-count for the toolbar: paginate with a shared cached host. */
export function pageCount(raw: string, opts: { profile: PageProfile; spacing: SpacingMode; embeds?: EmbedSizes }): number {
  try { return paginate(raw, opts).pages; } catch { return 0; }
}
