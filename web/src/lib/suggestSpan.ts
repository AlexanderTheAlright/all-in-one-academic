
export type Span = { from: number; to: number };

// paragraph = the block between blank lines that holds the anchor
function paragraphAround(text: string, from: number, to: number): Span {
  const before = text.lastIndexOf("\n\n", Math.max(0, from - 1));
  const start = before < 0 ? 0 : before + 2;
  const after = text.indexOf("\n\n", to);
  let end = after < 0 ? text.length : after;
  while (end > start && /\s/.test(text[end - 1])) end--;
  return { from: start, to: Math.max(end, to) };
}

// sentence ends: . ? ! (optionally closed by a quote, bracket or paren) then a space
const SENT_END = /[.?!]["'”’)\]]*\s+/g;
const ABBREV = /(?:\b(?:al|e\.g|i\.e|cf|vs|No|Fig|pp|p)\.)$/;

function sentencesAround(text: string, para: Span, from: number, to: number): Span {
  const body = text.slice(para.from, para.to);
  const cuts = [0];
  for (const m of body.matchAll(SENT_END)) {
    const end = (m.index ?? 0) + m[0].length;
    if (ABBREV.test(body.slice(0, (m.index ?? 0) + 1))) continue;
    cuts.push(end);
  }
  cuts.push(body.length);
  let s = 0, e = body.length;
  for (const c of cuts) if (para.from + c <= from) s = c;
  for (const c of [...cuts].reverse()) if (para.from + c >= to) e = c;
  let end = para.from + e;
  while (end > para.from + s && /\s/.test(text[end - 1])) end--;
  return { from: para.from + s, to: Math.max(end, to) };
}

// The span Accept overwrites. Candidates grow outward from the anchor; the one whose length
// is closest (in ratio) to the proposed text wins, the smaller one on a tie.
export function suggestionSpan(text: string, anchor: Span, proposed: string): Span {
  const para = paragraphAround(text, anchor.from, anchor.to);
  const sent = sentencesAround(text, para, anchor.from, anchor.to);
  // an anchor that is already whole sentences, a whole paragraph or several paragraphs was
  // placed on purpose: replace exactly that
  const startsClean = anchor.from === para.from || anchor.from === sent.from;
  const endsClean = anchor.to >= para.to || anchor.to === sent.to;
  if (startsClean && endsClean) return anchor;
  const want = Math.max(1, proposed.trim().length);
  const cands = [anchor, sent, para];
  let best = anchor, bestScore = Infinity;
  for (const c of cands) {
    const len = Math.max(1, c.to - c.from);
    const score = Math.abs(Math.log(want / len));
    if (score < bestScore - 1e-9) { best = c; bestScore = score; }
  }
  return best;
}

export function acceptedText(proposed: string): string {
  return proposed.replace(/(^|[\s(])\[(?!\[|XX\]|NEEDS CITE)([^[\]\n]+)\](?![[(:])/g, "$1$2");
}
