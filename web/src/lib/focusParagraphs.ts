

export type FocusPara = {
  i: number;            // index among paragraphs
  from: number;         // start offset in the document
  to: number;           // end offset (exclusive, before the trailing newline)
  key: string;          // first 64 normalised chars: the durable identity
  heading: string;      // the nearest heading above (any level), "" before the first
  section: string;      // the nearest level-1/2 heading above: what the outline groups by
  sectionAt: number;    // offset of that section heading (-1 = none), a stable group id
};

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s{0,3}(```|~~~)/;
const MATH = /^\s*\$\$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const EMBED = /^\s*(!\[\[[^\]]*\]\]|!\[[^\]]*\]\([^)]*\))\s*$/;
const TABLE = /^\s*\|/;
const LATEX = /^\s*\\[A-Za-z]+(\[[^\]]*\])?(\{[^}]*\})*\s*$/;
const HTMLTAG = /^\s*<\/?[A-Za-z][^>]*>\s*$/;
const CAPTION = /^\s*[*_]{0,2}(figure|fig\.|table|exhibit|panel)\s+[a-z]?\d+[a-z]?\s*[*_]{0,2}\s*[.:|—–-]/i;
const KEYWORDS = /^\s*[*_]{0,2}key\s*words?\s*[*_]{0,2}\s*:/i;
const NOTE = /^\s*[*_]{0,2}(notes?|sources?)\s*[*_]{0,2}\s*[.:]/i;
// a bullet starts a list anywhere, a number only at the start of a block (a hard-wrapped
// prose line may begin "2."); a list or a footnote definition runs to the next blank line
const BULLET = /^\s{0,3}[-*+]\s+\S/;
const ORDERED = /^\s{0,3}\d{1,3}[.)]\s+\S/;
const FOOTDEF = /^\s{0,3}\[\^[^\]]+\]:/;
const ABSTRACT = /^\s*[*_]{0,2}abstract[*_]{0,2}\s*[:.]?\s*$/i;

export function paraKey(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase().slice(0, 64);
}

export function parseFocusParagraphs(text: string): FocusPara[] {
  const out: FocusPara[] = [];
  const src = text ?? "";
  let pos = 0;
  const lines: { s: string; at: number }[] = [];
  for (const s of src.split("\n")) { lines.push({ s, at: pos }); pos += s.length + 1; }
  let i = 0;
  // YAML frontmatter at the very top
  if (lines.length && /^---\s*$/.test(lines[0].s)) {
    for (let j = 1; j < lines.length; j++) if (/^(---|\.\.\.)\s*$/.test(lines[j].s)) { i = j + 1; break; }
  }
  let heading = "", section = "", sectionAt = -1;
  let headingsSeen = 0, inTitle = false;
  let buf: { s: string; at: number }[] = [];
  const flush = () => {
    if (!buf.length) return;
    const first = buf[0], last = buf[buf.length - 1];
    const from = first.at, to = last.at + last.s.length;
    const body = src.slice(from, to);
    if (!inTitle && body.trim()) {
      out.push({ i: out.length, from, to, key: paraKey(body), heading, section, sectionAt });
    }
    buf = [];
  };
  for (; i < lines.length; i++) {
    const { s, at } = lines[i];
    const t = s.trim();
    if (FENCE.test(s)) {   // fenced block: skip to its close
      flush();
      const mark = s.trim().slice(0, 3);
      for (i++; i < lines.length && !lines[i].s.trim().startsWith(mark); i++) { /* skip */ }
      continue;
    }
    if (MATH.test(s)) {    // $$ display math (one line, or up to the closing $$)
      flush();
      if (!/\$\$.*\$\$/.test(t) || t === "$$") for (i++; i < lines.length && !lines[i].s.includes("$$"); i++) { /* skip */ }
      continue;
    }
    if (t.startsWith("<!--")) {   // HTML comment (a ¶ slot, a note to self)
      flush();
      if (!t.includes("-->")) for (i++; i < lines.length && !lines[i].s.includes("-->"); i++) { /* skip */ }
      continue;
    }
    if (ABSTRACT.test(s)) {
      flush();
      heading = section = "Abstract"; sectionAt = at;
      inTitle = false; headingsSeen++;
      continue;
    }
    const h = HEADING.exec(s);
    if (h) {
      flush();
      const level = h[1].length;
      heading = h[2].trim();
      if (level <= 2) { section = heading; sectionAt = at; }
      // anything under the document's opening "# Title", before the next heading, is the
      // byline/title block, not the body
      inTitle = headingsSeen === 0 && level === 1;
      headingsSeen++;
      continue;
    }
    if (BULLET.test(s) || FOOTDEF.test(s) || (!buf.length && ORDERED.test(s))) {
      flush();
      for (i++; i < lines.length && lines[i].s.trim() && !HEADING.test(lines[i].s); i++) { /* skip the block */ }
      i--;
      continue;
    }
    if (!t || RULE.test(s) || EMBED.test(s) || TABLE.test(s) || LATEX.test(s) || HTMLTAG.test(s)
        || CAPTION.test(s) || KEYWORDS.test(s) || NOTE.test(s)) {
      flush();
      continue;
    }
    buf.push({ s, at });
  }
  flush();
  return out;
}

/** the paragraph containing `pos` (or the first one after it), -1 when none */
export function paraAt(paras: FocusPara[], pos: number): number {
  for (const p of paras) if (pos <= p.to) return p.i;
  return paras.length ? paras.length - 1 : -1;
}

/** where a remembered paragraph is now: same key, else a key sharing its opening, else
 *  the same index, clamped */
export function resolvePara(paras: FocusPara[], key: string | undefined, idx: number | undefined): number {
  if (!paras.length) return -1;
  if (key) {
    const exact = paras.find((p) => p.key === key);
    if (exact) return exact.i;
    const head = key.slice(0, 28);
    if (head.length >= 12) {
      const near = paras.find((p) => p.key.startsWith(head));
      if (near) return near.i;
    }
  }
  const n = typeof idx === "number" && Number.isFinite(idx) ? Math.round(idx) : 0;
  return Math.max(0, Math.min(paras.length - 1, n));
}

/** the anchor a new flag takes: the paragraph's first sentence (20-160 chars), trimmed
 *  to a word boundary, as offsets into the document */
export function flagAnchor(text: string, p: FocusPara): { from: number; to: number } {
  const body = text.slice(p.from, p.to);
  const m = /[.?!]["'”’)]*(\s|$)/g;
  let end = -1, r: RegExpExecArray | null;
  while ((r = m.exec(body))) { if (r.index >= 20) { end = r.index + r[0].trimEnd().length; break; } }
  if (end < 0 || end > 160) {
    end = Math.min(body.length, 160);
    if (end < body.length) { const sp = body.lastIndexOf(" ", end); if (sp > 20) end = sp; }
  }
  // never end on whitespace (a soft-wrapped line ends in "\n")
  while (end > 1 && /\s/.test(body[end - 1])) end--;
  return { from: p.from, to: p.from + Math.max(1, end) };
}
