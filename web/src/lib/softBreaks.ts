

export type SoftBreak = { from: number; to: number };   // [end of L, start of N's text)

const WRAP_MIN = 55;
const WRAP_COL = 72;

const NOT_PROSE = /^(#{1,6}(\s|$)|[-*+]\s|\d+[.)]\s|\||!\[\[|<!--|```|~~~|\$\$|\\begin\{|\\end\{|\\\[|\[\^[^\]]*\]:|(-{3,}|\*{3,}|_{3,}|={3,})\s*$|<\/?(div|table|figure|details|summary)\b)/;
const BOLD_LINE = /^\*\*[^*].*\*\*[:.]?\s*$/;
const QUOTE = /^(\s{0,3}>\s?)+/;

/** Every soft break in `text`, as [from,to) ranges in document order. */
export function softBreaks(text: string): SoftBreak[] {
  const out: SoftBreak[] = [];
  const lines = text.split("\n");
  const starts: number[] = new Array(lines.length);
  for (let i = 0, p = 0; i < lines.length; i++) { starts[i] = p; p += lines[i].length + 1; }

  // lines that sit inside a block whose line structure is literal
  const literal = new Uint8Array(lines.length);
  let i0 = 0;
  if (lines[0] === "---") {                                  // YAML frontmatter
    for (let j = 1; j < lines.length; j++) if (/^(---|\.\.\.)\s*$/.test(lines[j])) { for (let k = 0; k <= j; k++) literal[k] = 1; i0 = j + 1; break; }
  }
  let fence: string | null = null, math = false, latex = 0, comment = false;
  for (let i = i0; i < lines.length; i++) {
    const t = lines[i].replace(QUOTE, "").trim();
    if (fence) { literal[i] = 1; if (t.startsWith(fence)) fence = null; continue; }
    if (math) { literal[i] = 1; if (t.startsWith("$$")) math = false; continue; }
    if (comment) { literal[i] = 1; if (t.includes("-->")) comment = false; continue; }
    if (latex) { literal[i] = 1; if (/^\\end\{/.test(t)) latex--; if (/^\\begin\{/.test(t)) latex++; continue; }
    const f = /^(```|~~~)/.exec(t);
    if (f) { literal[i] = 1; fence = f[1]; continue; }
    if (t.startsWith("$$")) { literal[i] = 1; if (!(t.length > 2 && t.endsWith("$$"))) math = true; continue; }
    if (t.startsWith("<!--")) { literal[i] = 1; if (!t.includes("-->")) comment = true; continue; }
    if (/^\\begin\{/.test(t) && !/\\end\{/.test(t)) { literal[i] = 1; latex = 1; continue; }
  }

  const prose = (i: number): { depth: string; body: string } | null => {
    if (literal[i]) return null;
    const line = lines[i];
    const q = QUOTE.exec(line);
    const depth = q ? q[0].replace(/\s/g, "") : "";
    const body = q ? line.slice(q[0].length) : line;
    if (!body.trim()) return null;
    if (/^\s{4,}|^\t/.test(body) && !depth) return null;      // indented code / list continuation
    const b = body.trimStart();
    if (NOT_PROSE.test(b) || BOLD_LINE.test(b.trimEnd())) return null;
    return { depth, body };
  };

  for (let i = 0; i + 1 < lines.length; i++) {
    const L = lines[i];
    if (/( {2}|\\)$/.test(L)) continue;                       // markdown hard break
    const a = prose(i); if (!a) continue;
    const b = prose(i + 1); if (!b || b.depth !== a.depth) continue;
    const Lt = L.trimEnd();
    const nb = b.body.trimStart();
    const firstWord = nb.split(/\s/, 1)[0];
    const wrapped = Lt.length >= WRAP_MIN || Lt.length + 1 + firstWord.length > WRAP_COL;
    if (!wrapped) continue;
    const nStart = starts[i + 1] + (lines[i + 1].length - nb.length);
    out.push({ from: starts[i] + Lt.length, to: nStart });
  }
  return out;
}
