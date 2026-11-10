

export type ManuPara = { pos: number; line: number; fp: string; preview: string; lead: string; words: number; isPlaceholder: boolean; label: string; isEmbed: boolean };
export type EHeading = { kind: "h2" | "h3"; text: string };
export type EPara = { kind: "para"; fp: string; cites: string; point: string; note: string; sources: string };
export type EItem = EHeading | EPara;

const HEADING = /^(#{2,3})\s+(.*?)\s*$/;
const PARA_MARK = /^\*\*¶(\d+)\*\*\s*(?:<!--\s*fp:\s*(.*?)\s*-->)?\s*$/;

/** Exact paths of text-table and PDF embeds referenced in the manuscript. Keep
 * directories so equal filenames in different project folders stay distinct. */
export function extractMdEmbeds(text: string): string[] {
  const out = new Set<string>();
  const re = /!\[\[([^\]|]+?\.(?:md|csv|txt|pdf))(?:\|[^\]]*)?\]\]/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.add(m[1].trim());
  return [...out];
}

export function fingerprint(text: string): string {
  const words = (text.toLowerCase().match(/[a-z0-9']+/g) || []).slice(0, 6);
  return words.join(" ").slice(0, 48);
}

type HLine = { idx: number; level: number; pos: number };
function scanHeadingLines(text: string): HLine[] {
  const lines = text.split("\n"); const out: HLine[] = []; let off = 0;
  for (let i = 0; i < lines.length; i++) { const m = /^(#{1,6})\s+/.exec(lines[i]); if (m) out.push({ idx: i, level: m[1].length, pos: off }); off += lines[i].length + 1; }
  return out;
}
function blockEnd(H: HLine[], k: number, totalLines: number): number {
  const L = H[k].level;
  for (let j = k + 1; j < H.length; j++) if (H[j].level <= L) return H[j].idx;
  return totalLines;
}

export function moveSection(text: string, pos: number, dir: number): string {
  const lines = text.split("\n"); const H = scanHeadingLines(text);
  const k = H.findIndex((h) => h.pos === pos); if (k < 0) return text;
  const L = H[k].level, start = H[k].idx, end = blockEnd(H, k, lines.length);
  if (dir < 0) {
    let j = -1; for (let t = k - 1; t >= 0; t--) { if (H[t].level < L) break; if (H[t].level === L) { j = t; break; } }
    if (j < 0) return text;
    const ps = H[j].idx;
    return [...lines.slice(0, ps), ...lines.slice(start, end), ...lines.slice(ps, start), ...lines.slice(end)].join("\n");
  } else {
    const t = H.find((h) => h.idx === end); if (!t || t.level !== L) return text;
    const ne = blockEnd(H, H.indexOf(t), lines.length);
    return [...lines.slice(0, start), ...lines.slice(end, ne), ...lines.slice(start, end), ...lines.slice(ne)].join("\n");
  }
}
/** Remove a section block (heading + body + nested subsections) entirely. */
export function removeSection(text: string, pos: number): string {
  const lines = text.split("\n"); const H = scanHeadingLines(text);
  const k = H.findIndex((h) => h.pos === pos); if (k < 0) return text;
  const start = H[k].idx, end = blockEnd(H, k, lines.length);
  const out = [...lines.slice(0, start), ...lines.slice(end)];
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}
/** Insert a new `## heading` (level 2 or 3) after the section at `afterPos` (or at the
 * end when afterPos is null). Returns { text, pos } — pos is the new heading's offset. */
export function insertSection(text: string, afterPos: number | null, heading: string, level: 2 | 3 = 2): { text: string; pos: number } {
  const hashes = "#".repeat(level); const head = `${hashes} ${heading.trim()}`;
  const lines = text.split("\n");
  let at: number;
  if (afterPos == null) { at = lines.length; }
  else { const H = scanHeadingLines(text); const k = H.findIndex((h) => h.pos === afterPos); at = k < 0 ? lines.length : blockEnd(H, k, lines.length); }
  const block = ["", head, ""];
  const next = [...lines.slice(0, at), ...block, ...lines.slice(at)];
  const text2 = next.join("\n");
  const pos = next.slice(0, at + 1).join("\n").length + 1;   // offset of the heading line
  return { text: text2, pos };
}

// a publish-invisible placeholder slot the writer fills in later: `<!--¶ label -->`
const PLACEHOLDER = /^<!--\s*¶\s*([\s\S]*?)\s*-->$/;
export function placeholderLabel(p: string): string | null {
  const m = PLACEHOLDER.exec(p.trim());
  return m ? m[1].trim() : null;
}

// every blank-line-separated block gets a comment — prose, figures, tables, captions,
// notes — only a horizontal rule or an HTML comment is skipped (mirrors drafting._is_slot_para)
function isSlotPara(p: string): boolean {
  const s = p.trim();
  if (!s) return false;
  if (s.startsWith("<!--")) return false;   // retired ¶-placeholder + stray comments
  if (/^-{3,}$/.test(s)) return false;       // horizontal rule
  return true;
}

// a readable margin label for a block: figure/table embeds show their name, captions
// show the caption text, prose shows its opening.
function blockPreview(para: string): string {
  const s = para.trim();
  const emb = /^!\[\[([^\]|]+)/.exec(s);
  if (emb) {
    const base = (emb[1].split("/").pop() || emb[1]).trim().replace(/\.(png|svg|jpe?g|gif|webp|md|csv|txt)$/i, "");
    const tag = /^tab/i.test(base) ? "Table · " : /^fig/i.test(base) ? "Figure · " : "Embed · ";
    return tag + base;
  }
  if (/^\*\*(Figure|Table)\b/.test(s)) return s.replace(/\*/g, "").trim().slice(0, 60);
  return s.replace(/[#*>`_]/g, "").trim().slice(0, 60);
}

// the outline's longer identifying line for a block: enough to know WHICH paragraph
// this is without opening it. Same cleaning as blockPreview, a wider window.
function blockLead(para: string): string {
  const s = para.trim();
  if (/^!\[\[/.test(s)) return blockPreview(para);
  const t = s.replace(/!?\[\[([^\]|]+?)(?:\|([^\]]*))?\]\]/g, (_m, a, b) => b || a)
    .replace(/[#*>`_]/g, "").replace(/\s+/g, " ").trim();
  return t.length <= 220 ? t : t.slice(0, 220).replace(/\s+\S*$/, "") + "…";
}
const countWords = (t: string) => (t.match(/[\w'’-]+/g) || []).length;

type Blk = { start: number; end: number; level: number };   // [start, end) lines; level 0 = prose
function scanBlocks(lines: string[]): Blk[] {
  const out: Blk[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!lines[i].trim()) { i++; continue; }
    const h = /^(#{1,6})\s/.exec(lines[i]);
    if (h) { out.push({ start: i, end: i + 1, level: h[1].length }); i++; continue; }
    const s = i;
    while (i < lines.length && lines[i].trim() && !/^#{1,6}\s/.test(lines[i])) i++;
    out.push({ start: s, end: i, level: 0 });
  }
  return out;
}

export function moveParagraph(text: string, pos: number, dir: number): string {
  const lines = text.split("\n");
  const off: number[] = []; { let c = 0; for (const ln of lines) { off.push(c); c += ln.length + 1; } }
  const B = scanBlocks(lines);
  const k = B.findIndex((b) => b.level === 0 && off[b.start] === pos);
  if (k < 0) return text;
  const j = dir < 0 ? k - 1 : k + 1;
  if (j < 0 || j >= B.length) return text;
  // moving up ACROSS a heading lands the paragraph before it — refuse when no
  // section heading precedes that point (it would fall out of the outline entirely)
  if (dir < 0 && B[j].level > 0 && !B.slice(0, j).some((b) => b.level === 2 || b.level === 3)) return text;
  const [a, b] = dir < 0 ? [B[j], B[k]] : [B[k], B[j]];
  return [...lines.slice(0, a.start), ...lines.slice(b.start, b.end), ...lines.slice(a.end, b.start),
    ...lines.slice(a.start, a.end), ...lines.slice(b.end)].join("\n");
}

/** Manuscript paragraphs that deserve a margin comment, in document order, with the
 * char offset of each paragraph's first line (for geometry) and its fingerprint. */
export function parseManuscript(text: string): ManuPara[] {
  const lines = text.split("\n");
  const lineOff: number[] = [];
  { let c = 0; for (const ln of lines) { lineOff.push(c); c += ln.length + 1; } }
  const out: ManuPara[] = [];
  let buf: string[] = [], bufLine = 0, h2 = "", h3 = "";
  const flush = () => {
    if (buf.length) {
      const para = buf.map((l) => l.trim()).join(" ").replace(/\s+/g, " ").trim();
      if (para && (h2 || h3) && isSlotPara(para)) {
        out.push({ pos: lineOff[bufLine], line: bufLine, fp: fingerprint(para),
          preview: blockPreview(para), lead: blockLead(para), words: countWords(para),
          isPlaceholder: false, label: "",
          isEmbed: /^!\[\[[^\]]+\]\]$/.test(para) });
      }
      buf = [];
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const h = HEADING.exec(ln);
    if (h) { flush(); if (h[1].length === 2) { h2 = h[2]; h3 = ""; } else h3 = h[2]; continue; }
    if (!ln.trim()) { flush(); continue; }
    if (!buf.length) bufLine = i;
    buf.push(ln);
  }
  flush();
  return out;
}

export function parseEditor(text: string): { preamble: string; items: EItem[] } {
  const lines = (text || "").split("\n");
  const items: EItem[] = [];
  let i = 0;
  const pre: string[] = [];
  while (i < lines.length && !HEADING.test(lines[i]) && !PARA_MARK.test(lines[i])) { pre.push(lines[i]); i++; }
  let cur: EPara | null = null;
  let field: null | "note" | "sources" | "point" = null;
  const commit = () => { if (cur) { cur.point = cur.point.replace(/\n+$/, ""); cur.note = cur.note.replace(/\n+$/, ""); cur.sources = cur.sources.replace(/\n+$/, ""); items.push(cur); cur = null; } };
  for (; i < lines.length; i++) {
    const ln = lines[i];
    const h = HEADING.exec(ln);
    if (h) { commit(); items.push({ kind: h[1].length === 2 ? "h2" : "h3", text: h[2] }); field = null; continue; }
    const pm = PARA_MARK.exec(ln);
    if (pm) { commit(); cur = { kind: "para", fp: (pm[2] || "").trim(), cites: "", point: "", note: "", sources: "" }; field = null; continue; }
    if (!cur) continue;
    if (/^cites:\s?/.test(ln)) { cur.cites = ln.replace(/^cites:\s?/, ""); field = null; continue; }
    const ptm = /^point:\s?(.*)$/.exec(ln);
    if (ptm) { cur.point = ptm[1]; field = "point"; continue; }
    const nm = /^note:\s?(.*)$/.exec(ln);
    if (nm) { cur.note = nm[1]; field = "note"; continue; }
    const sm = /^sources:\s?(.*)$/.exec(ln);
    if (sm) { cur.sources = sm[1]; field = "sources"; continue; }
    if (field === "note") cur.note += "\n" + ln;
    else if (field === "sources") cur.sources += "\n" + ln;
    else if (field === "point") cur.point += "\n" + ln;
  }
  commit();
  return { preamble: pre.join("\n").replace(/\n+$/, ""), items };
}

export function serializeEditor(preamble: string, items: EItem[]): string {
  const out: string[] = [];
  if (preamble.trim()) { out.push(preamble.trimEnd()); out.push(""); }
  let ord = 0;
  for (const it of items) {
    if (it.kind === "h2") { ord = 0; out.push("## " + it.text); out.push(""); }
    else if (it.kind === "h3") { ord = 0; out.push("### " + it.text); out.push(""); }
    else if (it.kind === "para") {
      ord++;
      out.push("**¶" + ord + "**" + (it.fp ? ` <!--fp:${it.fp}-->` : ""));
      out.push("cites: " + it.cites);
      out.push("point: " + it.point);
      out.push("note: " + it.note);
      out.push("sources:");
      if (it.sources) out.push(it.sources);
      out.push("");
    }
  }
  return out.join("\n").replace(/\n+$/, "") + "\n";
}

export type Comment = { para: ManuPara; cites: string; point: string; note: string; sources: string; itemIndex: number };

export function joinComments(manu: ManuPara[], ed: { items: EItem[] }): Comment[] {
  const paraItems = ed.items.map((it, idx) => ({ it, idx })).filter((x) => x.it.kind === "para");
  const byFp = new Map<string, number[]>();
  for (const { it, idx } of paraItems) { const fp = (it as EPara).fp; if (fp) { if (!byFp.has(fp)) byFp.set(fp, []); byFp.get(fp)!.push(idx); } }
  const used = new Set<number>();
  const out: Comment[] = [];
  let cursor = 0;
  for (const p of manu) {
    let idx = -1;
    const q = p.fp ? byFp.get(p.fp) : undefined;
    if (q) { while (q.length) { const cand = q.shift()!; if (!used.has(cand)) { idx = cand; break; } } }
    if (idx < 0) { while (cursor < paraItems.length && used.has(paraItems[cursor].idx)) cursor++; if (cursor < paraItems.length) { idx = paraItems[cursor].idx; cursor++; } }
    if (idx < 0) { out.push({ para: p, cites: "", point: "", note: "", sources: "", itemIndex: -1 }); continue; }
    used.add(idx);
    const it = ed.items[idx] as EPara;
    out.push({ para: p, cites: it.cites, point: it.point, note: it.note, sources: it.sources, itemIndex: idx });
  }
  return out;
}
