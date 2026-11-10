

export type Bullet = { kind: "exhibit" | "cite"; tag: string; text: string };
export type Point = { done: boolean; text: string; ev: string; fig: string; bullets: Bullet[] };
export type Hyp = { label: string; text: string };
export type SectionPlan = { style: "list" | "lead"; points: Point[]; hyps: Hyp[]; notes: string };

const NOTES = /^notes\s*:\s*(.*)$/i;
// a list row: bullet or number, optional task box. Indented rows are not points.
const ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s+(?:\[([ xX])\]\s*)?(.*)$/;
const EV = /^ev(?:idence)?\s*:\s*/i;
const FIG = /^fig(?:ure)?\s*:\s*/i;
// the exhibit line in a prose-written section
const VISUAL = /^(?:visuals?|figures?|fig|tables?)\s*:\s*(.*)$/i;
// a bullet naming its exhibit: `FIGURE ONE: …`, `TABLE TWO: …`, `APPENDIX FIGURE 4: …`
const EXHIBIT = /^((?:appendix|supplementary|supplemental|online)\s+)?(figures?|fig\.?|tables?|visuals?|exhibits?|panels?)\b([^:]*):\s*(.*)$/i;
const HYP = /^\*\*\s*(h(?:ypothesis)?\s*\d+[^*]*?)\s*\*\*\s*(.*)$/i;
// what marks a section as LIST style: a task box, or the labelled-pipe grammar
const LISTY = /\|\s*(?:ev(?:idence)?|fig(?:ure)?)\s*:/i;

export const EMPTY_PLAN: SectionPlan = { style: "lead", points: [], hyps: [], notes: "" };

export const newPoint = (): Point => ({ done: false, text: "", ev: "", fig: "", bullets: [] });

export function parsePlan(text: string): SectionPlan {
  const lines = (text || "").split(/\r?\n/);
  // LIST style declares itself: a task box on a row, or a ` | ev:` / ` | fig:` pipe.
  const listy = lines.some((l) => {
    const m = ITEM.exec(l);
    return (m && m[1].length < 2 && m[2] !== undefined) || LISTY.test(l);
  });
  return listy ? parseListPlan(lines) : parseLeadPlan(lines);
}

/** The legacy task-row grammar, one point per `- [ ] …` row. */
function parseListPlan(lines: string[]): SectionPlan {
  const points: Point[] = [];
  const notes: string[] = [];
  let inNotes = false;
  for (const raw of lines) {
    if (inNotes) { notes.push(raw); continue; }
    const n = NOTES.exec(raw.trim());
    if (n) { inNotes = true; if (n[1].trim()) notes.push(n[1]); continue; }
    const m = ITEM.exec(raw);
    if (m && m[1].length < 2) {
      const p = newPoint();
      p.done = m[2] === "x" || m[2] === "X";
      const parts = m[3].split("|");
      p.text = (parts.shift() || "").trim();
      for (const seg of parts) {
        const s = seg.trim();
        if (EV.test(s)) p.ev = s.replace(EV, "").trim();
        else if (FIG.test(s)) p.fig = s.replace(FIG, "").trim();
        else if (s) p.text += " | " + s;          // an unlabelled pipe stays in the text
      }
      points.push(p);
      continue;
    }
    if (raw.trim()) notes.push(raw);
  }
  return { style: "list", points, hyps: [], notes: notes.join("\n").replace(/^\n+|\s+$/g, "") };
}

function parseLeadPlan(lines: string[]): SectionPlan {
  const points: Point[] = [];
  const hyps: Hyp[] = [];
  const notes: string[] = [];
  let inNotes = false;
  let par: string[] = [];
  let cur: Point | null = null;

  const flushPar = () => {
    if (!par.length) return;
    const joined = par.join(" ").replace(/\s+/g, " ").trim();
    par = [];
    if (!joined) return;
    const h = HYP.exec(joined);
    if (h) { hyps.push({ label: h[1].trim(), text: h[2].trim() }); return; }
    cur = newPoint();
    cur.text = joined;
    points.push(cur);
  };
  const attach = (b: Bullet) => {
    if (!cur) { cur = newPoint(); points.push(cur); }
    cur.bullets.push(b);
  };

  for (const raw of lines) {
    if (inNotes) { notes.push(raw); continue; }
    const ln = raw.trim();
    const n = NOTES.exec(ln);
    if (n) { flushPar(); inNotes = true; if (n[1].trim()) notes.push(n[1]); continue; }
    if (!ln) { flushPar(); continue; }
    const m = ITEM.exec(raw);
    if (m && m[1].length < 2) {
      flushPar();
      const body = m[3].trim();
      const ex = EXHIBIT.exec(body);
      if (ex) attach({ kind: "exhibit", tag: body.slice(0, body.indexOf(":")).trim(), text: ex[4].trim() });
      else attach({ kind: "cite", tag: "", text: body });
      continue;
    }
    const v = VISUAL.exec(ln);
    if (v) { flushPar(); attach({ kind: "exhibit", tag: "", text: v[1].trim() }); continue; }
    par.push(ln);
  }
  flushPar();
  return { style: "lead", points, hyps, notes: notes.join("\n").replace(/^\n+|\s+$/g, "") };
}

export function serializePlan(p: SectionPlan): string {
  if (p.style === "list") {
    const o: string[] = [];
    for (const pt of p.points) {
      let line = `- [${pt.done ? "x" : " "}] ` + pt.text.trim();
      if (pt.ev.trim()) line += " | ev: " + pt.ev.trim();
      if (pt.fig.trim()) line += " | fig: " + pt.fig.trim();
      o.push(line);
    }
    if (p.notes.trim()) {
      if (o.length) o.push("");
      o.push("Notes:");
      o.push(p.notes.trim());
    }
    return o.join("\n");
  }
  // lead style: the sentence, its bullets under it, hypotheses as their own paragraphs
  const chunks: string[] = [];
  for (const pt of p.points) {
    const lines: string[] = [];
    if (pt.text.trim()) lines.push(pt.text.trim());
    for (const b of pt.bullets) {
      const t = b.text.trim();
      if (!t && !b.tag.trim()) continue;
      lines.push("- " + (b.kind === "exhibit" && b.tag.trim() ? b.tag.trim() + ": " + t : t));
    }
    if (lines.length) chunks.push(lines.join("\n"));
  }
  for (const h of p.hyps) chunks.push(("**" + h.label.trim() + "** " + h.text.trim()).trim());
  if (p.notes.trim()) chunks.push("Notes:\n" + p.notes.trim());
  return chunks.join("\n\n");
}

/** A plan with points speaks the grammar; one with only prose does not, and drops to the
 * raw editor rather than silently rendering as an empty outline. */
export function isStructured(p: SectionPlan): boolean {
  return p.points.length > 0 || p.hyps.length > 0;
}

export function planProgress(p: SectionPlan): { done: number; total: number } {
  return { done: p.points.filter((x) => x.done).length, total: p.points.length };
}

/** "FIGURE ONE" / "APPENDIX FIGURE 4" as it should read on a chip: "Figure One",
 * "Appendix Figure 4". The tag is stored as typed; only the display is cased. */
export function exhibitTag(tag: string): string {
  return (tag || "").toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

export function hypBadge(label: string): { n: string; name: string } | null {
  const m = /^h(?:ypothesis)?\s*(\d+)\s*(?:\(([^)]*)\))?/i.exec((label || "").trim());
  if (!m) return null;
  return { n: "H" + m[1], name: (m[2] || "").trim() };
}

export function figureLabel(fig: string): string {
  const s = (fig || "").trim();
  if (!s) return "";
  if (!needsFigureLabel(s)) return s;
  const m = /^(\d+)\s*[,.·:-]?\s*(.*)$/.exec(s);
  if (!m) return "Figure " + s;
  const rest = m[2].trim();
  return "Figure " + String(Number(m[1])) + (rest ? " · " + rest : "");
}

export function needsFigureLabel(fig: string): boolean {
  return !/^\s*(figures?|fig\.?|tables?|visuals?|exhibits?|needed|none)\b/i.test(fig || "");
}
