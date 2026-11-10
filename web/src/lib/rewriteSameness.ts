

export const THRESH = { sameness: 25, run: 4, containment: 0.10, order: 0.30, vocab: 0.80 };
export const WEIGHTS = { a: 0.30, b: 0.20, c: 0.35, d: 0.15 };
export const RUN_FLOOR = 2, RUN_CEIL = 9;        // runN = (run - floor) / (ceil - floor), clamped
export const SKEL_FLOOR = 0.15, SKEL_CEIL = 0.55; // unrelated prose sits near the floor
export const ORDER_MIN_WORDS = 6;                 // the order gate needs this many content words each side

const FUNCTION_WORDS = new Set((
  "a an the and or but nor so yet for of in on at to from by with without within into onto upon " +
  "about above across after against along among around as before behind below beneath beside besides between beyond " +
  "despite down during except inside like near off out outside over past since than through throughout till toward towards " +
  "under underneath unlike until up via whether while whereas although though because if unless once when whenever where " +
  "wherever which whichever who whom whose whoever what whatever that this these those there here " +
  "i me my mine myself we us our ours ourselves you your yours yourself yourselves he him his himself she her hers herself " +
  "it its itself they them their theirs themselves one ones oneself " +
  "is am are was were be been being have has had having do does did doing done will would shall should can could may might must " +
  "not no nor only also too very just even still then thus hence therefore however moreover furthermore indeed instead rather " +
  "such same other another each every either neither both all any some many much more most less least few fewer several " +
  "own s t don't doesn't isn't aren't wasn't weren't can't cannot won't wouldn't shouldn't couldn't it's that's there's " +
  "how why again already ever never often always perhaps quite almost enough so-called etc"
).split(/\s+/));

const ABBREV = new Set(["al", "cf", "vs", "eg", "ie", "fig", "figs", "no", "vol", "pp", "ch", "ed", "eds", "approx", "esp", "resp", "viz", "mr", "mrs", "ms", "dr", "st"]);

export type Word = { w: string; from: number; to: number; gap?: boolean };
type Tok = { t: string; kind: "w" | "p" | "end"; from: number; to: number; gap: boolean };

export type Analysis = {
  words: Word[];              // every counted word, lowercased, raw offsets
  sentences: Word[][];        // the same words split at sentence ends
  skeleton: string[];         // the paragraph skeleton, "|" between sentences
};

// spans that never count: citations, markers, numbers, links, math, comments
const MASKS: RegExp[] = [
  /<!--[\s\S]*?-->/g,
  /!\[\[[^\]]*\]\]/g,                                     // embeds
  /!\[[^\]]*\]\([^)]*\)/g,
  /\]\([^)]*\)/g,                                          // link targets (the text stays)
  /\[\[[^\]|]*\|/g,                                        // wikilink target before an alias
  /\[@[^\]]*\]/g, /(^|[\s(;])@[A-Za-z][\w:.-]*/g,          // pandoc cites
  /\((?:[^()]|\([^()]*\))*?\b(?:1[6-9]\d{2}|20\d{2})[a-z]?\b(?:[^()]|\([^()]*\))*?\)/g,   // (Author Year...)
  /\[(?:X{2,}|TK|NEEDS?\s+CITE[^\]]*|TODO[^\]]*|[A-Z][A-Z0-9 ,.:;?!/'’-]{1,80})\]/g,   // [XX] [NEEDS CITE] markers
  /\[\^[^\]]+\]/g,                                         // footnote refs
  /\$[^$\n]+\$/g,                                           // inline math
  /https?:\/\/\S+/g,
  /\bet\s+al\.?/gi,
  /[\p{L}]*\d(?:[\p{L}\d%]|[.,](?=\d))*/gu,               // numbers and tokens carrying digits (a final "." stays a sentence end)
];

// verbatim spans a rewrite must keep: quotes and block quotes
const QUOTES: RegExp[] = [
  /"[^"\n]{1,600}"/g,
  /“[^”\n]{1,600}”/g,
  /(?<![\p{L}\p{N}])‘[^’\n]{1,600}’(?![\p{L}])/gu,
  /^[ \t]*>(?![ \t]*(?:\*\*|__|\[|\*?(?:hypothes|proposition|research question|h\d)))[^\n]*$/gim,
];
// Title Case runs: 3+ capitalised words, short lowercase connectors allowed inside
const CAP = String.raw`\p{Lu}[\p{L}\p{M}'’-]*`;
const CONNECT = String.raw`(?:of|and|the|for|in|on|to|at|de|du|des|la|le|von|van|der|&)`;
const NAMES = new RegExp(String.raw`(?<![\p{L}\p{M}])${CAP}(?:[ \t]+(?:${CONNECT}[ \t]+)*${CAP}){2,}(?![\p{L}\p{M}])`, "gu");

function markAll(text: string, res: RegExp[], m: Uint8Array, v = 1) {
  for (const re of res) {
    re.lastIndex = 0;
    let r: RegExpExecArray | null;
    while ((r = re.exec(text))) {
      if (!r[0].length) { re.lastIndex++; continue; }
      m.fill(v, r.index, r.index + r[0].length);
    }
  }
}

function masked(text: string): Uint8Array {
  const m = new Uint8Array(text.length + 1);
  markAll(text, MASKS, m);
  return m;
}

// 1 = inside a quote, 2 = inside a proper name / Title Case term
function exemptMask(text: string): Uint8Array {
  const m = new Uint8Array(text.length + 1);
  markAll(text, [NAMES], m, 2);
  markAll(text, QUOTES, m, 1);
  return m;
}

// CJK scripts are written without spaces: one character is one word
const CJK = String.raw`\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}`;
const TOKEN = new RegExp(String.raw`[${CJK}]|(?:(?![${CJK}])[\p{L}])[\p{L}\p{M}]*(?:['’](?:(?![${CJK}])[\p{L}])[\p{L}\p{M}]*)*|[.?!。！？]+|[,;:()"“”—–、，；：]`, "gu");
const IS_WORD = /^\p{L}/u;
const IS_END = /^[.?!。！？]+$/;

/** a "." after a one-letter word: an initial ("J. Smith"), part of "e.g."/"i.e.", or the
 *  end of a sentence ("... factor X. The next")? */
function oneLetterEnds(text: string, word: string, at: number): boolean {
  const rest = text.slice(at + 1, at + 40);
  if (!rest.trim()) return true;                              // end of the paragraph
  if (/^\S/.test(rest)) return false;                         // "e.g." "i.e.," "U.S."
  if (/^\s*\n/.test(rest)) return true;
  if (/^\s+[\d(\[]/.test(rest)) return false;                 // "p. 12", "n. (3)"
  const nx = /^\s+([\p{L}][\p{L}'’]*)/u.exec(rest);
  if (!nx) return true;
  const n = nx[1];
  if (/^\p{Ll}/u.test(n)) return false;                        // "p. 12", "a. b" mid-sentence
  if (/^\p{Lu}$/u.test(n)) return false;                       // "W. E. B."
  if (word === word.toLowerCase()) return true;                // "model a. The"
  return FUNCTION_WORDS.has(n.toLowerCase());                  // "X. The" ends, "J. Smith" does not
}

function tokens(text: string, extra?: Uint8Array): Tok[] {
  const src = text ?? "";
  const m = masked(src);
  const out: Tok[] = [];
  let gap = false;
  TOKEN.lastIndex = 0;
  let r: RegExpExecArray | null, lastEnd = 0;
  while ((r = TOKEN.exec(src))) {
    const from = r.index, to = from + r[0].length;
    // a masked stretch between two tokens breaks a phrase
    for (let i = lastEnd; i < from; i++) if (m[i]) { gap = true; break; }
    lastEnd = to;
    let hit = false;
    for (let i = from; i < to; i++) if (m[i]) { hit = true; break; }
    const s = r[0];
    if (hit) { gap = true; continue; }
    if (IS_END.test(s)) {
      const prev = out[out.length - 1];
      const adjacent = prev && prev.kind === "w" && prev.to === from;
      // "e.g.", initials and abbreviations never end a sentence; a number or a
      // one-letter word before the stop can
      if (s === "." && adjacent && ABBREV.has(prev.t)) continue;
      if (s === "." && adjacent && [...prev.t].length === 1 && !oneLetterEnds(src, src.slice(prev.from, prev.to), from)) continue;
      out.push({ t: s[0] === "。" ? "." : s[0] === "！" ? "!" : s[0] === "？" ? "?" : s[0], kind: "end", from, to, gap: false });
      gap = false;
    } else if (IS_WORD.test(s)) {
      if (extra && extra[from]) {
        gap = true;
        continue;
      }
      out.push({ t: s.toLowerCase().replace(/’/g, "'"), kind: "w", from, to, gap });
      gap = false;
    } else {
      if (extra && extra[from]) continue;
      out.push({ t: s === "“" || s === "”" ? "\"" : s === "–" ? "—" : s === "、" || s === "，" ? "," : s === "；" ? ";" : s === "：" ? ":" : s, kind: "p", from, to, gap: false });
    }
  }
  return out;
}

export const isFunctionWord = (w: string) => FUNCTION_WORDS.has(w);

function build(toks: Tok[]): Analysis {
  const words: Word[] = [], sentences: Word[][] = [], skeleton: string[] = [];
  let cur: Word[] = [], sk: string[] = [];
  const close = () => {
    if (cur.length) { sentences.push(cur); if (skeleton.length) skeleton.push("|"); skeleton.push(...sk); }
    cur = []; sk = [];
  };
  for (const t of toks) {
    if (t.kind === "end") { if (cur.length) sk.push(t.t); close(); continue; }
    if (t.kind === "p") { if (cur.length || t.t === "(" || t.t === "\"") sk.push(t.t); continue; }
    const w: Word = { w: t.t, from: t.from, to: t.to, gap: t.gap || undefined };
    words.push(w); cur.push(w);
    sk.push(FUNCTION_WORDS.has(t.t) ? t.t : "W");
  }
  close();
  return { words, sentences, skeleton };
}

export function analyse(text: string, opts: { exempt?: boolean } = {}): Analysis {
  return build(tokens(text, opts.exempt ? exemptMask(text ?? "") : undefined));
}

const gram = (a: string[], i: number, n: number) => a.slice(i, i + n).join(" ");
/** n-grams that never straddle a masked/exempt gap; `at` = start index of each */
function gramsOf(ws: Word[], n: number): { g: string; at: number }[] {
  const out: { g: string; at: number }[] = [];
  const a = ws.map((x) => x.w);
  for (let i = 0; i + n <= ws.length; i++) {
    let ok = true;
    for (let k = i + 1; k < i + n; k++) if (ws[k].gap) { ok = false; break; }
    if (ok) out.push({ g: gram(a, i, n), at: i });
  }
  return out;
}

export function stem(w: string): string {
  let s = w.replace(/'s$/, "");
  for (const suf of ["ational", "ization", "ations", "ation", "ments", "ment", "ness", "ities", "ity", "ings", "ing", "edly", "ed", "ies", "es", "ly", "s"]) {
    if (s.length - suf.length >= 3 && s.endsWith(suf)) { s = s.slice(0, -suf.length); break; }
  }
  return s;
}
const isContent = (w: string) => !FUNCTION_WORDS.has(w) && ([...w].length >= 3 || /^[^\p{Script=Latin}]/u.test(w));

export type Shared = { from: number; to: number };   // raw offsets in the NEW text

export type Sameness = {
  score: number;              // 0-100
  pass: boolean;
  containment: number;        // a
  run: number;                // b, in words (function words trimmed at the ends)
  runText: string;            // the longest shared run, as it reads in the new text
  skeleton: number;           // c, raw Jaccard
  openings: number;           // d
  content: number;            // e, information only
  order: number;              // f, content-word LCS / shorter sequence
  vocab: number;              // share of the new text's content stems found in the original
  reasons: string[];          // why it has not passed (empty when it has)
  shared: Shared[];           // phrases (>= 3 words) still shared with the original
  exempt: Shared[];           // quotes, names and terms left out of every measure
  words: number;              // words counted in the new text
};

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** The token streams of both texts with every exempt span taken out (see header). */
function prepare(original: string, next: string) {
  const ea = exemptMask(original), eb = exemptMask(next);
  // the words inside quotes, either text: any 3-word phrase of theirs is exempt everywhere
  const quoted = new Set<string>();
  for (const [t, e] of [[original, ea], [next, eb]] as const) {
    const qs = tokens(t).filter((x) => x.kind === "w");
    let run: Tok[] = [];
    const flushQ = () => { for (let i = 0; i + 3 <= run.length; i++) quoted.add(run.slice(i, i + 3).map((x) => x.t).join(" ")); run = []; };
    for (const x of qs) { if (e[x.from] === 1 && !(run.length && x.gap)) run.push(x); else { flushQ(); if (e[x.from] === 1) run.push(x); } }
    flushQ();
  }
  let TA = tokens(original, ea), TB = tokens(next, eb);
  const wordsOf = (T: Tok[]) => T.filter((x) => x.kind === "w").map((x) => ({ w: x.t, from: x.from, to: x.to, gap: x.gap })) as Word[];
  const drop = (T: Tok[], ws: Word[], hits: Set<number>) => {
    if (!hits.size) return T;
    const kill = new Set<number>();
    for (const i of hits) kill.add(ws[i].from);
    let gap = false;
    const out: Tok[] = [];
    for (const t of T) {
      if (t.kind === "w" && kill.has(t.from)) { gap = true; continue; }
      if (t.kind === "w") { out.push(gap ? { ...t, gap: true } : t); gap = false; } else { out.push(t); if (t.kind === "end") gap = false; }
    }
    return out;
  };
  let wa = wordsOf(TA), wb = wordsOf(TB);
  // a TERM recurs in different company: two of its uses differ in the word before AND the
  // word after (a paragraph that simply repeats itself is not a list of terms)
  const usesOf = (ws: Word[], n: number) => {
    const c = new Map<string, string[]>();
    for (const { g, at } of gramsOf(ws, n)) {
      const ctx = (ws[at - 1]?.w ?? "^") + "\u0000" + (ws[at + n]?.w ?? "$");
      const l = c.get(g); if (l) l.push(ctx); else c.set(g, [ctx]);
    }
    return c;
  };
  const recurs = (ctxs: string[] | undefined) => {
    if (!ctxs || ctxs.length < 2) return false;
    const sp = ctxs.map((x) => x.split("\u0000"));
    for (let i = 0; i < sp.length; i++) for (let j = i + 1; j < sp.length; j++) if (sp[i][0] !== sp[j][0] && sp[i][1] !== sp[j][1]) return true;
    return false;
  };
  const terms = new Set<string>();
  for (const n of [3, 4]) {
    const ca = usesOf(wa, n), cb = usesOf(wb, n);
    for (const [g, k] of cb) {
      const ka = ca.get(g);
      if (!ka || !(recurs(k) || recurs(ka))) continue;
      const parts = g.split(" ");
      if (!isContent(parts[0]) || !isContent(parts[parts.length - 1])) continue;
      terms.add(g);
    }
  }
  const hitsOf = (ws: Word[]) => {
    const h = new Set<number>();
    for (const { g, at } of gramsOf(ws, 3)) if (quoted.has(g)) for (let k = 0; k < 3; k++) h.add(at + k);
    for (const n of [3, 4]) for (const { g, at } of gramsOf(ws, n)) if (terms.has(g)) for (let k = 0; k < n; k++) h.add(at + k);
    return h;
  };
  const hb = hitsOf(wb);
  const ha = hitsOf(wa);
  const exemptB: Shared[] = [];
  // exempt ranges in the new text, for the highlight: the masks plus the dropped phrases
  {
    let i = 0;
    while (i < next.length) {
      if (eb[i]) { let j = i; while (j < next.length && eb[j]) j++; const s = next.slice(i, j); const lead = s.length - s.trimStart().length; const trail = s.length - s.trimEnd().length; if (j - trail > i + lead) exemptB.push({ from: i + lead, to: j - trail }); i = j; } else i++;
    }
    const idx = [...hb].sort((x, y) => x - y);
    for (let k = 0; k < idx.length;) {
      let e = k; while (e + 1 < idx.length && idx[e + 1] === idx[e] + 1 && !wb[idx[e + 1]].gap) e++;
      exemptB.push({ from: wb[idx[k]].from, to: wb[idx[e]].to });
      k = e + 1;
    }
    exemptB.sort((x, y) => x.from - y.from);
  }
  TA = drop(TA, wa, ha); TB = drop(TB, wb, hb);
  return { A: build(TA), B: build(TB), exempt: exemptB };
}

function lcs(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  let prev = new Uint16Array(b.length + 1), row = new Uint16Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) row[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], row[j - 1]);
    [prev, row] = [row, prev];
  }
  return prev[b.length];
}

export function sameness(original: string, next: string): Sameness {
  const { A, B, exempt } = prepare(original ?? "", next ?? "");
  const aw = A.words.map((x) => x.w), bw = B.words.map((x) => x.w);

  // a. trigram containment, by the new text's trigram positions (never across a gap)
  const aTri = new Set(gramsOf(A.words, 3).map((x) => x.g));
  const bTri = gramsOf(B.words, 3);
  let hitN = 0;
  const covered = new Uint8Array(bw.length);
  for (const { g, at } of bTri) if (aTri.has(g)) { hitN++; covered[at] = covered[at + 1] = covered[at + 2] = 1; }
  const containment = bTri.length ? hitN / bTri.length : 0;

  // b. longest common run of consecutive words (DP over rows of the original); a gap on
  // either side restarts the run
  let run = 0, runAt = -1, runLen = 0;
  if (aw.length && bw.length) {
    let prev = new Uint16Array(aw.length + 1), row = new Uint16Array(aw.length + 1);
    for (let i = 1; i <= bw.length; i++) {
      for (let j = 1; j <= aw.length; j++) {
        row[j] = bw[i - 1] === aw[j - 1] ? (B.words[i - 1].gap || A.words[j - 1].gap ? 1 : prev[j - 1] + 1) : 0;
      }
      // a run ends here when the next pair does not extend it; score it trimmed
      for (let j = 1; j <= aw.length; j++) {
        const L = row[j];
        if (!L) continue;
        const extends_ = i < bw.length && j < aw.length && bw[i] === aw[j] && !B.words[i].gap && !A.words[j].gap;
        if (extends_) continue;
        let s = i - L, e = i;                       // [s, e) in B
        while (s < e && FUNCTION_WORDS.has(bw[s])) s++;
        while (e > s && FUNCTION_WORDS.has(bw[e - 1])) e--;
        if (e - s > run) { run = e - s; runAt = s; runLen = e - s; }
      }
      [prev, row] = [row, prev];
      row.fill(0);
    }
  }
  const runText = runAt >= 0 ? next.slice(B.words[runAt].from, B.words[runAt + runLen - 1].to) : "";

  // c. skeleton trigram Jaccard
  const sg = (s: string[]) => { const o = new Set<string>(); for (let i = 0; i + 3 <= s.length; i++) o.add(gram(s, i, 3)); return o; };
  const sa = sg(A.skeleton), sb = sg(B.skeleton);
  let inter = 0;
  for (const g of sb) if (sa.has(g)) inter++;
  const uni = sa.size + sb.size - inter;
  const skeleton = uni ? inter / uni : 0;

  // d. sentence openings reused
  const opens = new Set(A.sentences.filter((s) => s.length >= 2).map((s) => s[0].w + " " + s[1].w));
  const bOpen = B.sentences.filter((s) => s.length >= 2);
  const openings = bOpen.length ? bOpen.filter((s) => opens.has(s[0].w + " " + s[1].w)).length / bOpen.length : 0;

  // e. content words (information only), f. their order
  const sa2 = aw.filter(isContent).map(stem), sb2 = bw.filter(isContent).map(stem);
  const ca = new Set(sa2), cb = new Set(sb2);
  let ci = 0;
  for (const w of cb) if (ca.has(w)) ci++;
  const cu = ca.size + cb.size - ci;
  const content = cu ? ci / cu : 0;
  const caAll = new Set(analyse(original ?? "").words.map((x) => x.w).filter(isContent).map(stem));
  let kept = 0;
  for (const w of cb) if (caAll.has(w)) kept++;
  const vocab = cb.size ? kept / cb.size : 0;
  const shorter = Math.min(sa2.length, sb2.length);
  const order = shorter >= ORDER_MIN_WORDS ? lcs(sa2, sb2) / shorter : 0;

  const runN = clamp01((run - RUN_FLOOR) / (RUN_CEIL - RUN_FLOOR));
  const skelN = clamp01((skeleton - SKEL_FLOOR) / (SKEL_CEIL - SKEL_FLOOR));
  const raw = WEIGHTS.a * containment + WEIGHTS.b * runN + WEIGHTS.c * skelN + WEIGHTS.d * openings;
  const hasLetters = /\p{L}/u.test((next ?? "").replace(/<!--[\s\S]*?-->/g, ""));
  const score = bw.length ? Math.round(100 * raw) : hasLetters ? 0 : 100;

  const reasons: string[] = [];
  if (!hasLetters) reasons.push("Nothing written yet");
  else if (bw.length) {
    if (score > THRESH.sameness) reasons.push(`Sameness ${score} > ${THRESH.sameness}`);
    if (run > THRESH.run) reasons.push(`Shared run of ${run} words: "${runText}"`);
    if (containment > THRESH.containment) reasons.push(`${Math.round(containment * 100)}% of trigrams still in the original (max ${Math.round(THRESH.containment * 100)}%)`);
    if (order >= THRESH.order && vocab >= THRESH.vocab) reasons.push(`Same words in the same order (${Math.round(order * 100)}% in order, ${Math.round(vocab * 100)}% kept)`);
  }

  // shared phrases: maximal stretches of covered words, as raw offsets in the new text
  const shared: Shared[] = [];
  for (let i = 0; i < covered.length; i++) {
    if (!covered[i]) continue;
    let j = i;
    while (j + 1 < covered.length && covered[j + 1] && !B.words[j + 1].gap) j++;
    shared.push({ from: B.words[i].from, to: B.words[j].to });
    i = j;
  }

  return { score, pass: reasons.length === 0, containment, run, runText, skeleton, openings, content, order, vocab, reasons, shared, exempt, words: bw.length };
}

export function contentOverlap(a: string, b: string): number {
  const cw = (t: string) => new Set(analyse(t).words.map((x) => x.w).filter(isContent).map(stem));
  const ca = cw(a), cb = cw(b);
  let i = 0;
  for (const w of cb) if (ca.has(w)) i++;
  const u = ca.size + cb.size - i;
  return u ? i / u : 0;
}
