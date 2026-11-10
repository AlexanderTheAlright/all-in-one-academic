

import type { SuggestedParagraph } from "@/lib/api";

export const SUGGESTION_OVERLAP_MAX = 0.30;

const QUOTE = /"[^"\n]*"|“[^”\n]*”/g;

/** the suggestion's own words: an adopted one's tweaks, else all of it,
 *  with quotes cut out (a cut breaks the segment so no shingle spans it) */
export function suggestedSegments(sg: Pick<SuggestedParagraph, "text" | "adopted" | "tweaks">): string[] {
  const raw = sg.adopted ? (sg.tweaks ?? []).map((t) => t.text) : [sg.text];
  return raw.flatMap((s) => s.split(QUOTE)).map((s) => s.trim()).filter(Boolean);
}

function shingles(text: string, n = 5): Set<string> {
  const words = text.toLowerCase().match(/[a-z0-9']+/g) ?? [];
  const out = new Set<string>();
  for (let i = 0; i + n <= words.length; i++) out.add(words.slice(i, i + n).join(" "));
  return out;
}

export type Overlap = { score: number; verbatim: string | null; close: boolean; none: boolean };

export function suggestionOverlap(mine: string, segments: string[]): Overlap {
  if (!segments.length) return { score: 0, verbatim: null, close: false, none: true };
  for (const seg of segments) for (const sent of seg.split(/(?<=[.!?])\s+/)) {
    const s = sent.trim();
    if (s.split(/\s+/).filter(Boolean).length >= 6 && mine.includes(s)) return { score: 1, verbatim: s, close: true, none: false };
  }
  const a = shingles(mine), b = new Set<string>();
  for (const seg of segments) for (const x of shingles(seg)) b.add(x);
  let score = 0;
  if (a.size && b.size) {
    let shared = 0;
    for (const x of a) if (b.has(x)) shared++;
    score = shared / Math.min(a.size, b.size);
  }
  return { score, verbatim: null, close: score >= SUGGESTION_OVERLAP_MAX, none: false };
}
