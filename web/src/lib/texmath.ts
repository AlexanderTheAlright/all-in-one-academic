

export type MNode = { tag: string; attrs?: Record<string, string>; kids?: MNode[]; text?: string };
export type MathSpan = { from: number; to: number; tex: string; display: boolean };
export type MathResult = { node: MNode; errors: string[] };

export const MATHML_NS = "http://www.w3.org/1998/Math/MathML";

const isBlank = (c: string | undefined) => c === " " || c === "\t";

/** The line starting at `k` holds only spaces/tabs (or the text ends there). */
function blankLineAt(t: string, k: number): boolean {
  while (k < t.length && isBlank(t[k])) k++;
  return k >= t.length || t[k] === "\n";
}

function scanInline(t: string, i: number): MathSpan | null {
  const n = t.length;
  let j = i + 1;
  if (j >= n || /\s/.test(t[j])) return null;
  while (j < n) {
    const c = t[j];
    if (c === "$") {
      if (/[0-9]/.test(t[j + 1] || "")) return null;          // "$5 … $10" — a price, not math
      return { from: i, to: j + 1, tex: t.slice(i + 1, j), display: false };
    }
    if (c === "\\") {
      // \text{…} may hold a $; pandoc skips it as a balanced group
      if (t.startsWith("text{", j + 1)) {
        let d = 0, k = j + 5;
        for (; k < n; k++) { if (t[k] === "{") d++; else if (t[k] === "}" && --d === 0) break; }
        if (k >= n) return null;
        j = k + 1; continue;
      }
      j += 2; continue;
    }
    if (isBlank(c) || c === "\n") {
      let k = j;
      while (k < n && isBlank(t[k])) k++;
      if (t[k] === "\n") { k++; if (blankLineAt(t, k)) return null; while (k < n && isBlank(t[k])) k++; }
      if (k >= n || t[k] === "$") return null;               // space before the closing $
      j = k; continue;
    }
    j++;
  }
  return null;
}

function scanDisplay(t: string, i: number): MathSpan | null {
  const n = t.length;
  let j = i + 2;
  if (t.startsWith("$$", j)) return null;                    // $$$$ is empty
  while (j < n) {
    if (j > i + 2 && t.startsWith("$$", j)) return { from: i, to: j + 2, tex: t.slice(i + 2, j), display: true };
    if (t[j] === "\n" && blankLineAt(t, j + 1)) return null;
    j++;
  }
  return null;
}

/** Every math span in `text`, in document order, with [from,to) including delimiters. */
export function findMath(text: string): MathSpan[] {
  const out: MathSpan[] = [];
  const n = text.length;
  let i = 0;
  if (text.startsWith("---\n")) {                             // YAML frontmatter
    const m = /\n(---|\.\.\.)[ \t]*(\n|$)/.exec(text.slice(3));
    if (m) i = 3 + m.index + m[0].length;
  }
  let lineStart = true;
  while (i < n) {
    const c = text[i];
    if (lineStart) {
      lineStart = false;
      const f = /^ {0,3}(`{3,}|~{3,})/.exec(text.slice(i, i + 24));
      if (f) {                                                // fenced code: skip to its closing fence
        const close = new RegExp("\\n {0,3}" + (f[1][0] === "`" ? "`" : "~") + "{" + f[1].length + ",}[ \\t]*(?=\\n|$)", "g");
        close.lastIndex = i;
        const m = close.exec(text);
        i = m ? m.index + m[0].length : n;
        continue;
      }
    }
    if (c === "\n") { lineStart = true; i++; continue; }
    if (c === "\\") { i += 2; continue; }                    // an escape: \$ is a literal dollar
    if (c === "`") {                                          // code span: a matching backtick run
      let r = 1;
      while (text[i + r] === "`") r++;
      const run = "`".repeat(r);
      let k = text.indexOf(run, i + r);
      while (k !== -1 && text[k + r] === "`") { let e = k; while (text[e] === "`") e++; k = text.indexOf(run, e); }
      i = k === -1 ? i + r : k + r;
      continue;
    }
    if (c === "<" && text.startsWith("<!--", i)) { const e = text.indexOf("-->", i + 4); i = e === -1 ? n : e + 3; continue; }
    if (c === "$") {
      const dbl = text[i + 1] === "$";
      const sp = dbl ? scanDisplay(text, i) : scanInline(text, i);
      if (sp) { out.push(sp); i = sp.to; continue; }
      i += dbl ? 2 : 1; continue;
    }
    i++;
  }
  return out;
}

// ---- symbol tables ---------------------------------------------------------------------
const GREEK: Record<string, string> = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ϵ", varepsilon: "ε", zeta: "ζ", eta: "η",
  theta: "θ", vartheta: "ϑ", iota: "ι", kappa: "κ", varkappa: "ϰ", lambda: "λ", mu: "μ", nu: "ν",
  xi: "ξ", omicron: "ο", pi: "π", varpi: "ϖ", rho: "ρ", varrho: "ϱ", sigma: "σ", varsigma: "ς",
  tau: "τ", upsilon: "υ", phi: "ϕ", varphi: "φ", chi: "χ", psi: "ψ", omega: "ω",
  Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π", Sigma: "Σ", Upsilon: "Υ",
  Phi: "Φ", Psi: "Ψ", Omega: "Ω", varGamma: "𝛤", varDelta: "𝛥", varTheta: "𝛩", varLambda: "𝛬",
  varSigma: "𝛴", varPhi: "𝛷", varPsi: "𝛹", varOmega: "𝛺",
};

// ordinary symbols (mi, as pandoc emits them)
const MI_SYM: Record<string, string> = {
  infty: "∞", partial: "∂", nabla: "∇", ell: "ℓ", hbar: "ℏ", imath: "ı", jmath: "ȷ", emptyset: "∅",
  varnothing: "∅", aleph: "ℵ", Re: "ℜ", Im: "ℑ", wp: "℘", ldots: "…", dots: "…", dotsc: "…", dotsb: "⋯",
  cdots: "⋯", vdots: "⋮", ddots: "⋱", angle: "∠", triangle: "△", top: "⊤", degree: "°", dagger: "†",
  ddagger: "‡", S: "§", checkmark: "✓", square: "□", Box: "□", diamond: "⋄", flat: "♭", sharp: "♯",
};

// operators and relations (mo)
const MO_SYM: Record<string, string> = {
  times: "×", cdot: "⋅", cdotp: "⋅", pm: "±", mp: "∓", div: "÷", ast: "∗", star: "⋆", circ: "∘",
  bullet: "∙", oplus: "⊕", ominus: "⊖", otimes: "⊗", odot: "⊙", le: "≤", leq: "≤", ge: "≥", geq: "≥",
  leqslant: "⩽", geqslant: "⩾", lt: "<", gt: ">", neq: "≠", ne: "≠", approx: "≈", sim: "∼", simeq: "≃",
  cong: "≅", equiv: "≡", propto: "∝", ll: "≪", gg: "≫", doteq: "≐", asymp: "≍", in: "∈", notin: "∉",
  ni: "∋", subset: "⊂", subseteq: "⊆", supset: "⊃", supseteq: "⊇", subsetneq: "⊊", supsetneq: "⊋",
  cup: "∪", cap: "∩", setminus: "∖", smallsetminus: "∖", sqcup: "⊔", sqcap: "⊓", to: "→",
  rightarrow: "→", leftarrow: "←", gets: "←", Rightarrow: "⇒", Leftarrow: "⇐", leftrightarrow: "↔",
  Leftrightarrow: "⇔", implies: "⟹", impliedby: "⟸", iff: "⟺", mapsto: "↦", longrightarrow: "⟶",
  longleftarrow: "⟵", Longrightarrow: "⟹", Longleftarrow: "⟸", longmapsto: "⟼", uparrow: "↑",
  downarrow: "↓", updownarrow: "↕", Uparrow: "⇑", Downarrow: "⇓", nearrow: "↗", searrow: "↘",
  hookrightarrow: "↪", rightleftharpoons: "⇌", prime: "′", mid: "∣", nmid: "∤", parallel: "∥",
  perp: "⊥", bot: "⊥", wedge: "∧", land: "∧", vee: "∨", lor: "∨", neg: "¬", lnot: "¬", forall: "∀",
  exists: "∃", nexists: "∄", therefore: "∴", because: "∵", models: "⊨", vdash: "⊢", dashv: "⊣",
  coloneqq: "≔", triangleq: "≜", nsim: "≁", ncong: "≇", nleq: "≰", ngeq: "≱", prec: "≺", succ: "≻",
  preceq: "⪯", succeq: "⪰", ltimes: "⋉", rtimes: "⋊", wr: "≀", amalg: "⨿", colon: ":", vert: "|",
  lvert: "|", rvert: "|", Vert: "‖", lVert: "‖", rVert: "‖", "|": "‖", langle: "⟨", rangle: "⟩",
  lfloor: "⌊", rfloor: "⌋", lceil: "⌈", rceil: "⌉", lbrace: "{", rbrace: "}", lbrack: "[", rbrack: "]",
  "{": "{", "}": "}", backslash: "∖", "%": "%", "$": "$", "&": "&", "#": "#", "_": "_", bmod: "mod",
};
// fences that must not stretch unless \left/\right says so (TeX's behaviour; MathML's default stretches)
const FENCE_CH = new Set(["(", ")", "[", "]", "{", "}", "|", "‖", "⟨", "⟩", "⌊", "⌋", "⌈", "⌉"]);

const SPACE: Record<string, string> = {
  ",": "0.167em", ":": "0.222em", ">": "0.222em", ";": "0.278em", "!": "-0.167em", " ": "0.333em",
  quad: "1em", qquad: "2em", enspace: "0.5em", thinspace: "0.167em", medspace: "0.222em",
  thickspace: "0.278em", negthinspace: "-0.167em", negmedspace: "-0.222em", negthickspace: "-0.278em",
};

// big operators: sums take limits in display; integrals keep their scripts at the side
const BIGOP: Record<string, string> = {
  sum: "∑", prod: "∏", coprod: "∐", bigcup: "⋃", bigcap: "⋂", bigoplus: "⨁", bigotimes: "⨂",
  bigodot: "⨀", bigvee: "⋁", bigwedge: "⋀", bigsqcup: "⨆",
};
const INTOP: Record<string, string> = { int: "∫", iint: "∬", iiint: "∭", oint: "∮" };

// named functions -> upright mi; LIMIT_FN take limits underneath in display
const FUNCS: Record<string, string> = {
  log: "log", exp: "exp", ln: "ln", lg: "lg", min: "min", max: "max", sup: "sup", inf: "inf",
  lim: "lim", limsup: "lim sup", liminf: "lim inf", sin: "sin", cos: "cos", tan: "tan", sec: "sec",
  csc: "csc", cot: "cot", sinh: "sinh", cosh: "cosh", tanh: "tanh", coth: "coth", arcsin: "arcsin",
  arccos: "arccos", arctan: "arctan", det: "det", dim: "dim", ker: "ker", hom: "hom", deg: "deg",
  gcd: "gcd", arg: "arg", Pr: "Pr",
};
// Only what LaTeX and pandoc both define: \var, \argmax and the like fail to publish, so
// they fall through to the unknown-command error; \operatorname{Var} is the portable form.
const LIMIT_FN = new Set(["lim", "limsup", "liminf", "min", "max", "sup", "inf", "det", "gcd", "Pr"]);

// accents over (mover accent) / under (munder accentunder): [char, stretchy]
const OVER: Record<string, [string, boolean]> = {
  bar: ["¯", false], overline: ["‾", true], hat: ["^", false], widehat: ["^", true], tilde: ["~", false],
  widetilde: ["~", true], vec: ["→", false], overrightarrow: ["→", true], overleftarrow: ["←", true],
  dot: ["˙", false], ddot: ["¨", false], dddot: ["⃛", false], check: ["ˇ", false], breve: ["˘", false],
  acute: ["´", false], grave: ["`", false], mathring: ["˚", false], overbrace: ["⏞", true],
};
const UNDER: Record<string, [string, boolean]> = {
  underline: ["_", true], underbrace: ["⏟", true], underrightarrow: ["→", true], underleftarrow: ["←", true],
};

const FONT: Record<string, string> = {
  mathrm: "rm", mathup: "rm", mathnormal: "it", mathit: "it", mathbf: "bf", boldsymbol: "bi", bm: "bi",
  mathbfit: "bi", mathcal: "cal", mathscr: "cal", mathbb: "bb", mathfrak: "frak", mathsf: "sf", mathtt: "tt",
};
const TEXT: Record<string, string> = {
  text: "", textrm: "", textnormal: "", textup: "", textmd: "", mbox: "", hbox: "", textsf: "",
  texttt: "", textit: "it", emph: "it", textsl: "it", textbf: "bf",
};
const STYLE: Record<string, Record<string, string>> = {
  displaystyle: { displaystyle: "true", scriptlevel: "0" },
  textstyle: { displaystyle: "false", scriptlevel: "0" },
  scriptstyle: { displaystyle: "false", scriptlevel: "1" },
  scriptscriptstyle: { displaystyle: "false", scriptlevel: "2" },
};
const BIG: Record<string, string> = { big: "1.2em", Big: "1.623em", bigg: "2.047em", Bigg: "2.470em" };
const DELIM_CMD: Record<string, string> = {
  "{": "{", "}": "}", "|": "‖", langle: "⟨", rangle: "⟩", lvert: "|", rvert: "|", vert: "|", Vert: "‖",
  lVert: "‖", rVert: "‖", lfloor: "⌊", rfloor: "⌋", lceil: "⌈", rceil: "⌉", lbrace: "{", rbrace: "}",
  lbrack: "[", rbrack: "]", backslash: "∖", uparrow: "↑", downarrow: "↓", updownarrow: "↕",
  Uparrow: "⇑", Downarrow: "⇓", lgroup: "⟮", rgroup: "⟯",
};
// environments: [left fence, right fence, column alignment]
const ENVS: Record<string, [string, string, "c" | "l" | "rl" | "spec"]> = {
  matrix: ["", "", "c"], smallmatrix: ["", "", "c"], pmatrix: ["(", ")", "c"], bmatrix: ["[", "]", "c"],
  Bmatrix: ["{", "}", "c"], vmatrix: ["|", "|", "c"], Vmatrix: ["‖", "‖", "c"], cases: ["{", "", "l"],
  dcases: ["{", "", "l"], rcases: ["", "}", "l"], aligned: ["", "", "rl"], align: ["", "", "rl"],
  alignat: ["", "", "rl"], alignedat: ["", "", "rl"], split: ["", "", "rl"], eqnarray: ["", "", "rl"],
  flalign: ["", "", "rl"], gathered: ["", "", "c"], gather: ["", "", "c"], multline: ["", "", "c"],
  array: ["", "", "spec"], subarray: ["", "", "spec"], equation: ["", "", "c"], displaymath: ["", "", "c"],
};

// ---- Unicode math alphanumerics (MathML Core ignores mathvariant other than "normal") ---
// [A, a, 0] block starts per variant; 0 = the variant has no such range
const ALNUM: Record<string, [number, number, number]> = {
  it: [0x1d434, 0x1d44e, 0], bf: [0x1d400, 0x1d41a, 0x1d7ce], bi: [0x1d468, 0x1d482, 0x1d7ce],
  cal: [0x1d49c, 0x1d4b6, 0], bb: [0x1d538, 0x1d552, 0x1d7d8], frak: [0x1d504, 0x1d51e, 0],
  sf: [0x1d5a0, 0x1d5ba, 0x1d7e2], tt: [0x1d670, 0x1d68a, 0x1d7f6],
};
// Greek (capital Α, small α) block starts
const ALGREEK: Record<string, [number, number]> = { bf: [0x1d6a8, 0x1d6c2], it: [0x1d6e2, 0x1d6fc], bi: [0x1d71c, 0x1d736] };
const GREEK_VAR: Record<string, number> = { "∂": 0x19, "ϵ": 0x1a, "ϑ": 0x1b, "ϰ": 0x1c, "ϕ": 0x1d, "ϱ": 0x1e, "ϖ": 0x1f };
// the letters Unicode placed in Letterlike Symbols before the math block existed
const HOLES: Record<string, Record<string, string>> = {
  it: { h: "ℎ" },
  cal: { B: "ℬ", E: "ℰ", F: "ℱ", H: "ℋ", I: "ℐ", L: "ℒ", M: "ℳ", R: "ℛ", e: "ℯ", g: "ℊ", o: "ℴ" },
  frak: { C: "ℭ", H: "ℌ", I: "ℑ", R: "ℜ", Z: "ℨ" },
  bb: { C: "ℂ", H: "ℍ", N: "ℕ", P: "ℙ", Q: "ℚ", R: "ℝ", Z: "ℤ" },
};

function styleChars(t: string, v: string): string {
  const tab = ALNUM[v];
  if (!tab) return t;
  let out = "";
  for (const ch of t) {
    const hole = HOLES[v]?.[ch];
    if (hole) { out += hole; continue; }
    const c = ch.codePointAt(0)!;
    const g = ALGREEK[v];
    if (c >= 65 && c <= 90) out += String.fromCodePoint(tab[0] + c - 65);
    else if (c >= 97 && c <= 122) out += String.fromCodePoint(tab[1] + c - 97);
    else if (c >= 48 && c <= 57 && tab[2]) out += String.fromCodePoint(tab[2] + c - 48);
    else if (g && c >= 0x391 && c <= 0x3a9) out += String.fromCodePoint(g[0] + c - 0x391);
    else if (g && c >= 0x3b1 && c <= 0x3c9) out += String.fromCodePoint(g[1] + c - 0x3b1);
    else if (g && GREEK_VAR[ch] !== undefined) out += String.fromCodePoint(g[1] + GREEK_VAR[ch]);
    else out += ch;
  }
  return out;
}

// ---- tree helpers ----------------------------------------------------------------------
const el = (tag: string, kids: MNode[] = [], attrs?: Record<string, string>): MNode => (attrs ? { tag, kids, attrs } : { tag, kids });
const leaf = (tag: string, text: string, attrs?: Record<string, string>): MNode => (attrs ? { tag, text, attrs } : { tag, text });
const row = (kids: MNode[]): MNode => (kids.length === 1 ? kids[0] : el("mrow", kids));
const space = (w: string): MNode => el("mspace", [], { width: w });
const NORMAL = { mathvariant: "normal" };
const errNode = (src: string): MNode => el("merror", [leaf("mtext", src)]);

/** Apply a font command to parsed content: adjacent letters merge into one identifier
 *  (\mathrm{Var} is one word), and letters/digits map to the styled alphanumerics. */
function applyFont(kids: MNode[], v: string): MNode[] {
  const merged: MNode[] = [];
  for (const k of kids) {
    const prev = merged[merged.length - 1];
    if (k.tag === "mi" && prev?.tag === "mi" && k.text !== undefined && prev.text !== undefined && !k.attrs && !prev.attrs) {
      merged[merged.length - 1] = { tag: "mi", text: prev.text + k.text };
    } else merged.push(k);
  }
  const walk = (m: MNode): MNode => {
    if (m.text !== undefined && (m.tag === "mi" || m.tag === "mn" || m.tag === "mtext")) {
      const text = v === "rm" ? m.text : styleChars(m.text, v);
      return m.tag === "mi" ? leaf("mi", text, NORMAL) : leaf(m.tag, text, m.attrs);
    }
    return m.kids ? { ...m, kids: m.kids.map(walk) } : m;
  };
  return merged.map(walk);
}

/** Braces balance, counting neither \{ \} nor anything after a %. */
function bracesBalanced(t: string): boolean {
  let d = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === "\\") { i++; continue; }
    if (c === "%") { while (i < t.length && t[i] !== "\n") i++; continue; }
    if (c === "{") d++;
    else if (c === "}" && --d < 0) return false;
  }
  return d === 0;
}

/** CSS length from a TeX dimension (mu -> em at 18mu = 1em). */
function texLength(raw: string): string {
  const m = /^\s*(-?[0-9]*\.?[0-9]+)\s*(em|ex|pt|mm|cm|in|px|mu)?\s*$/.exec(raw);
  if (!m) return "0.333em";
  const v = parseFloat(m[1]), u = m[2] || "em";
  return u === "mu" ? (v / 18).toFixed(3) + "em" : v + u;
}

// ---- the parser ------------------------------------------------------------------------
type Stops = { brace?: boolean; cell?: boolean; right?: boolean; env?: boolean };

function convert(s: string, display: boolean, errors: string[]): MNode[] {
  const n = s.length;
  let i = 0;
  const LIMITS = new WeakSet<MNode>();    // nodes that take limits underneath in display

  const ws = () => {
    for (;;) {
      while (i < n && /\s/.test(s[i])) i++;
      if (s[i] === "%") { while (i < n && s[i] !== "\n") i++; continue; }
      return;
    }
  };
  const readCmd = (): string => {         // at a backslash
    i++;
    if (i >= n) return "";
    if (/[A-Za-z]/.test(s[i])) { const st = i; while (i < n && /[A-Za-z]/.test(s[i])) i++; return s.slice(st, i); }
    return s[i++];
  };
  const atCmd = (name: string) => s.startsWith("\\" + name, i) && !/[A-Za-z]/.test(s[i + 1 + name.length] || "");
  // a raw brace group's text (or the next single token when there is no brace)
  const readRaw = (): string => {
    ws();
    if (s[i] !== "{") {
      if (s[i] === "\\") { const st = i; readCmd(); return s.slice(st, i); }
      return i < n ? s[i++] : "";
    }
    let d = 0; const st = i + 1;
    for (; i < n; i++) {
      if (s[i] === "\\") { i++; continue; }
      if (s[i] === "{") d++;
      else if (s[i] === "}" && --d === 0) { i++; return s.slice(st, i - 1); }
    }
    return s.slice(st);
  };
  const readOptional = (): string | null => {
    ws();
    if (s[i] !== "[") return null;
    let d = 0; const st = i + 1;
    for (; i < n; i++) {
      if (s[i] === "\\") { i++; continue; }
      if (s[i] === "{") d++;
      else if (s[i] === "}") d--;
      else if (s[i] === "]" && d === 0) { i++; return s.slice(st, i - 1); }
    }
    return s.slice(st);
  };
  const sub = (t: string): MNode => row(convert(t, display, errors));
  const opCh = (c: string): MNode => (FENCE_CH.has(c) ? leaf("mo", c, { stretchy: "false" }) : leaf("mo", c));

  const readDelim = (): string => {
    ws();
    if (s[i] === "\\") {
      const name = readCmd();
      if (DELIM_CMD[name] !== undefined) return DELIM_CMD[name];
      errors.push("unknown delimiter \\" + name);
      return "";
    }
    const c = s[i++] || ".";
    return c === "." ? "" : c === "<" ? "⟨" : c === ">" ? "⟩" : c;
  };
  const fence = (d: string, form: string): MNode[] => (d ? [leaf("mo", d, { fence: "true", stretchy: "true", form })] : []);

  // one argument: a brace group, one command, or one character
  const parseArg = (): MNode => {
    ws();
    if (i >= n) { errors.push("missing argument"); return el("mrow"); }
    if (s[i] === "{") return parseAtom() ?? el("mrow");
    if (s[i] === "\\") return parseAtom() ?? el("mrow");
    const c = s[i];
    if (/[0-9]/.test(c)) { i++; return leaf("mn", c); }
    return parseAtom() ?? el("mrow");
  };

  const parseScripts = (base: MNode): MNode => {
    let lo: MNode | null = null, hi: MNode | null = null, limits: boolean | null = null;
    const primes: MNode[] = [];
    for (;;) {
      const save = i;
      ws();
      if (s[i] === "'") { i++; primes.push(leaf("mo", "′")); continue; }
      if (atCmd("limits")) { i += 7; limits = true; continue; }
      if (atCmd("nolimits")) { i += 9; limits = false; continue; }
      if (s[i] === "_") { i++; if (lo) errors.push("double subscript"); lo = parseArg(); continue; }
      if (s[i] === "^") { i++; if (hi) errors.push("double superscript"); hi = parseArg(); continue; }
      i = save; break;
    }
    if (primes.length) hi = hi ? row([...primes, hi]) : row(primes);
    if (!lo && !hi) return base;
    const under = limits ?? (display && LIMITS.has(base));
    if (under) return lo && hi ? el("munderover", [base, lo, hi]) : lo ? el("munder", [base, lo]) : el("mover", [base, hi!]);
    return lo && hi ? el("msubsup", [base, lo, hi]) : lo ? el("msub", [base, lo]) : el("msup", [base, hi!]);
  };

  const parseSeq = (stops: Stops): MNode[] => {
    const out: MNode[] = [];
    while (i < n) {
      ws();
      if (i >= n) break;
      const c = s[i];
      if (c === "}") { if (stops.brace) break; i++; continue; }
      if (c === "&") { if (stops.cell) break; i++; continue; }
      if (c === "\\") {
        const save = i;
        const name = readCmd();
        if ((name === "\\" || name === "cr") && stops.cell) { i = save; break; }
        if (name === "end" && stops.env) { i = save; break; }
        if (name === "right" && stops.right) { i = save; break; }
        if (name === "middle" && stops.right) { out.push(...fence(readDelim(), "infix")); continue; }
        if (STYLE[name]) { out.push(el("mstyle", parseSeq(stops), STYLE[name])); break; }
        i = save;
      }
      const atom = parseAtom();
      if (atom) out.push(parseScripts(atom));
    }
    return out;
  };

  const parseAtom = (): MNode | null => {
    const c = s[i];
    if (c === "{") {
      i++;
      const k = parseSeq({ brace: true });
      if (s[i] === "}") i++;
      return k.length === 1 ? k[0] : el("mrow", k);
    }
    if (c === "^" || c === "_" || c === "'") return el("mrow");          // a script with no base
    const num = /^(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)/.exec(s.slice(i, i + 64));
    if (num) { i += num[0].length; return leaf("mn", num[0]); }
    if (/[A-Za-z]/.test(c)) { i++; return leaf("mi", c); }
    if (c === "\\") return parseCommand();
    if (c === "~") { i++; return space("0.222em"); }
    const ch = String.fromCodePoint(s.codePointAt(i)!);
    i += ch.length;
    if (ch === "-") return leaf("mo", "−");
    if (ch === "*") return leaf("mo", "∗");
    if (/\p{L}/u.test(ch)) return leaf("mi", ch);
    if (/\p{N}/u.test(ch)) return leaf("mn", ch);
    return opCh(ch);
  };

  const parseEnv = (name: string): MNode => {
    const base = name.replace(/\*$/, "");
    const env = ENVS[base];
    if (!env) errors.push("unknown environment {" + name + "}");
    const [lf, rf, alignKind] = env ?? ["", "", "c"];
    let spec: string[] = [];
    if (alignKind === "spec") spec = readRaw().replace(/[^lcr]/g, "").split("");
    if (base === "alignat" || base === "alignedat") readRaw();
    const rows = parseRows(true);
    if (atCmd("end")) {
      readCmd();
      const e = readRaw();
      if (e !== name) errors.push("\\begin{" + name + "} closed by \\end{" + e + "}");
    } else errors.push("missing \\end{" + name + "}");
    if (base === "equation" || base === "displaymath") return row(rows.map((r) => row(r.flat())));
    const align = (j: number): string =>
      alignKind === "l" ? "left" : alignKind === "rl" ? (j % 2 === 0 ? "right" : "left")
        : alignKind === "spec" ? ({ l: "left", r: "right" } as Record<string, string>)[spec[j]] ?? "center" : "center";
    const tbl = table(rows, align, alignKind === "rl", alignKind === "rl" || base === "gathered" || base === "gather" || base === "dcases");
    return lf || rf ? el("mrow", [...fence(lf, "prefix"), tbl, ...fence(rf, "postfix")]) : tbl;
  };

  // rows of cells up to \end (in an environment) or the end of the text (top level)
  const parseRows = (inEnv: boolean): MNode[][][] => {
    const rows: MNode[][][] = [];
    let cells: MNode[][] = [];
    for (;;) {
      cells.push(parseSeq({ cell: true, env: inEnv }));
      if (i >= n) break;
      if (s[i] === "&") { i++; continue; }
      if (s[i] === "\\") {
        const save = i;
        const name = readCmd();
        if (name === "\\" || name === "cr") { readOptional(); rows.push(cells); cells = []; continue; }
        i = save;
      }
      break;
    }
    rows.push(cells);
    if (rows.length > 1 && rows[rows.length - 1].every((c) => c.length === 0)) rows.pop();
    return rows;
  };

  const table = (rows: MNode[][][], align: (j: number) => string, tight: boolean, displayCells: boolean): MNode => {
    const trs = rows.map((r) => el("mtr", r.map((cell, j) => {
      const a = align(j);
      const style = "text-align:" + a + (tight ? (a === "right" ? ";padding-right:0" : ";padding-left:0") : "");
      const content = displayCells && display ? el("mstyle", cell, { displaystyle: "true" }) : row(cell);
      return el("mtd", [content], { style });
    })));
    return el("mtable", trs);
  };

  const parseCommand = (): MNode | null => {
    const name = readCmd();
    if (!name) { errors.push("trailing backslash"); return null; }
    if (GREEK[name]) return /^[A-Z]/.test(name) ? leaf("mi", GREEK[name], NORMAL) : leaf("mi", GREEK[name]);
    if (MI_SYM[name]) return leaf("mi", MI_SYM[name]);
    if (MO_SYM[name]) return opCh(MO_SYM[name]);
    if (SPACE[name]) return space(SPACE[name]);
    // largeop spelled out so the stylesheet can hand these glyphs to a font with a MATH table
    if (BIGOP[name]) { const m = leaf("mo", BIGOP[name], { largeop: "true" }); LIMITS.add(m); return m; }
    if (INTOP[name]) return leaf("mo", INTOP[name], { largeop: "true" });
    if (FUNCS[name]) {
      const m = el("mrow", [leaf("mi", FUNCS[name], NORMAL), leaf("mo", "⁡")]);
      if (LIMIT_FN.has(name)) LIMITS.add(m);
      return m;
    }
    if (OVER[name]) {
      const [ch, st] = OVER[name];
      return el("mover", [parseArg(), leaf("mo", ch, { stretchy: String(st) })], { accent: "true" });
    }
    if (UNDER[name]) {
      const [ch, st] = UNDER[name];
      return el("munder", [parseArg(), leaf("mo", ch, { stretchy: String(st) })], { accentunder: "true" });
    }
    if (FONT[name]) return row(applyFont(convert(readRaw(), display, errors), FONT[name]));
    if (TEXT[name] !== undefined) {
      let t = readRaw().replace(/\\([%$&#_{} ])/g, "$1").replace(/~/g, " ").replace(/^ | $/g, " ");
      if (TEXT[name]) t = styleChars(t, TEXT[name]);
      return leaf("mtext", t);
    }
    if (STYLE[name]) return null;                     // inside a script argument: nothing to wrap
    const bigBase = name.replace(/[lrm]$/, "");
    if (BIG[name] || BIG[bigBase]) {
      const size = BIG[name] || BIG[bigBase];
      const d = readDelim();
      return d ? leaf("mo", d, { minsize: size, maxsize: size, stretchy: "true" }) : space("0.12em");
    }
    switch (name) {
      case "frac": case "dfrac": case "tfrac": case "cfrac": {
        const f = el("mfrac", [parseArg(), parseArg()]);
        return name === "dfrac" || name === "cfrac" ? el("mstyle", [f], { displaystyle: "true" })
          : name === "tfrac" ? el("mstyle", [f], { displaystyle: "false" }) : f;
      }
      case "binom": case "dbinom": case "tbinom": {
        const f = el("mfrac", [parseArg(), parseArg()], { linethickness: "0" });
        const r = el("mrow", [...fence("(", "prefix"), f, ...fence(")", "postfix")]);
        return name === "dbinom" ? el("mstyle", [r], { displaystyle: "true" }) : name === "tbinom" ? el("mstyle", [r], { displaystyle: "false" }) : r;
      }
      case "sqrt": {
        const idx = readOptional();
        const body = parseArg();
        return idx !== null ? el("mroot", [body, sub(idx)]) : el("msqrt", [body]);
      }
      case "overset": case "stackrel": { const a = parseArg(); return el("mover", [parseArg(), a]); }
      case "underset": { const a = parseArg(); return el("munder", [parseArg(), a]); }
      case "operatorname": case "mathop": {
        const star = s[i] === "*" ? (i++, true) : false;
        const raw = readRaw();
        const plain = raw.replace(/\\[,;:! ]/g, " ");
        const inner = /\\/.test(plain) ? applyFont(convert(raw, display, errors), "rm") : [leaf("mi", plain.trim(), NORMAL)];
        const m = el("mrow", [...inner, leaf("mo", "⁡")]);
        if (star || name === "mathop") LIMITS.add(m);
        return m;
      }
      case "left": {
        const l = readDelim();
        const body = parseSeq({ right: true, brace: true });
        let r = "";
        if (atCmd("right")) { readCmd(); r = readDelim(); }
        else errors.push("\\left without \\right");
        return el("mrow", [...fence(l, "prefix"), ...body, ...fence(r, "postfix")]);
      }
      case "right": errors.push("\\right without \\left"); readDelim(); return null;
      case "middle": return row(fence(readDelim(), "infix"));
      case "begin": return parseEnv(readRaw());
      case "end": errors.push("\\end{" + readRaw() + "} without \\begin"); return null;
      case "not": {
        ws();
        const a = i < n ? parseAtom() : null;
        if (a && a.text !== undefined) return leaf("mo", (a.text + "̸").normalize("NFC"));
        return a;
      }
      case "pmod": {
        const b = parseArg();
        return el("mrow", [space("1em"), leaf("mo", "(", { stretchy: "false" }), leaf("mi", "mod", NORMAL), space("0.333em"), b, leaf("mo", ")", { stretchy: "false" })]);
      }
      case "mod": return el("mrow", [space("1em"), leaf("mi", "mod", NORMAL), space("0.333em")]);
      case "phantom": return el("mphantom", [parseArg()]);
      case "hphantom": case "vphantom": return el("mphantom", [parseArg()]);
      case "hspace": case "mspace": case "kern": case "mkern": case "hskip": case "mskip":
        if (s[i] === "*") i++;
        return space(texLength(readRaw()));
      case "label": case "tag": readRaw(); return null;
      case "nonumber": case "notag": case "limits": case "nolimits": case "allowbreak": case "hline": return null;
      case "\\": case "cr": return null;           // a row break outside rows (inside braces)
    }
    errors.push("unknown command \\" + name);
    return errNode("\\" + name);
  };

  const rows = parseRows(false);
  if (rows.length === 1 && rows[0].length === 1) return rows[0][0];
  // top-level & or \\ (as pandoc would take them): an aligned block when & is present
  const hasAmp = rows.some((r) => r.length > 1);
  return [table(rows, (j) => (hasAmp ? (j % 2 === 0 ? "right" : "left") : "center"), hasAmp, display)];
}

// ---- entry points ----------------------------------------------------------------------
const CACHE = new Map<string, MathResult>();

export function texToMathML(tex: string, display: boolean): MathResult {
  const key = (display ? "D" : "I") + tex;
  const hit = CACHE.get(key);
  if (hit) return hit;
  const errors: string[] = [];
  let kids: MNode[];
  if (!bracesBalanced(tex)) { errors.push("unbalanced braces"); kids = [errNode(tex)]; }
  else kids = convert(tex, display, errors);
  const res: MathResult = { node: el("math", [el("mrow", kids)], { display: display ? "block" : "inline" }), errors };
  if (CACHE.size > 2000) CACHE.clear();
  CACHE.set(key, res);
  return res;
}

/** A tree as live DOM (createElementNS; text via textContent — never markup). */
export function mathDom(node: MNode, doc: Document = document): Element {
  const e = doc.createElementNS(MATHML_NS, node.tag);
  if (node.attrs) for (const k of Object.keys(node.attrs)) e.setAttribute(k, node.attrs[k]);
  if (node.text !== undefined) e.textContent = node.text;
  else if (node.kids) for (const k of node.kids) e.appendChild(mathDom(k, doc));
  return e;
}

/** A tree as MathML source (tests and diagnostics only; the app never parses it). */
export function mathXml(node: MNode): string {
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const attrs = node.attrs ? Object.keys(node.attrs).map((k) => ` ${k}="${esc(node.attrs![k])}"`).join("") : "";
  const ns = node.tag === "math" ? ` xmlns="${MATHML_NS}"` : "";
  const body = node.text !== undefined ? esc(node.text) : (node.kids || []).map(mathXml).join("");
  return `<${node.tag}${ns}${attrs}>${body}</${node.tag}>`;
}

/** A tall construct (fraction, big operator, root, stretched fence, table) — Page view
 *  gives a display equation holding one more height. */
export function mathIsTall(tex: string): boolean {
  return /\\(d?t?frac|cfrac|binom|sum|prod|int|iint|oint|sqrt|left|big|Big|begin|overbrace|underbrace|lim|max|min)\b|\\\\/.test(tex);
}
