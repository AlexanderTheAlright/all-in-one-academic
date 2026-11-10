

export type OutlineSection = { level: 2 | 3; heading: string; plan: string };
export type OutlineExtra = { heading: string; body: string };
export type OutlineModel = { thesis: string; targetJournal: string; themes: string; sections: OutlineSection[]; extras: OutlineExtra[]; intro: string };

const H1 = /^#\s+(.*?)\s*$/;
const H23 = /^(#{2,3})\s+(.*?)\s*$/;

// the regenerated intro blockquote — must match drafting._OUTLINE_INTRO byte-for-byte
const INTRO =
  "> Plan the paper here. The locked thesis and core themes keep every section " +
  "coherent; each section note says what that section must accomplish. Section " +
  "headings track paper.md — Sync to refresh them. Edit here or in Obsidian.";

export function canonHeading(s: string): string {
  return (s || "").replace(/\s+/g, " ").trim().toLowerCase();
}

export function parseOutline(text: string): OutlineModel {
  const thesis: string[] = [], themes: string[] = [], journal: string[] = [], intro: string[] = [];
  const sections: OutlineSection[] = [];
  const extras: OutlineExtra[] = [];
  let mode: null | "thesis" | "themes" | "journal" | "sections" | "extra" = null;
  let cur: { level: 2 | 3; heading: string; plan: string[] } | null = null;
  let extra: { heading: string; body: string[] } | null = null;
  let h1n = 0;
  const flush = () => { if (cur) { sections.push({ level: cur.level, heading: cur.heading, plan: cur.plan.join("\n").replace(/^\n+|\n+$/g, "").trim() }); cur = null; } };
  const flushExtra = () => {
    if (!extra) return;
    const body = extra.body.join("\n").replace(/^\n+|\n+$/g, "").trim();
    if (body) extras.push({ heading: extra.heading, body });   // the title h1 has no body
    extra = null;
  };
  for (const raw of (text || "").split(/\r?\n/)) {
    const h1 = H1.exec(raw);
    if (h1) {
      flush(); flushExtra(); h1n++;
      const t = canonHeading(h1[1]);
      if (t === "thesis") mode = "thesis";
      else if (t === "target journal" || t === "journal") mode = "journal";
      else if (t === "concepts" || t === "core themes" || t === "themes" || t === "themes / contributions" || t === "contributions") mode = "themes";
      else if (t === "sections" || t === "outline" || t === "section plan") mode = "sections";
      else { mode = "extra"; extra = { heading: h1[1].trim(), body: [] }; }
      continue;
    }
    const h23 = H23.exec(raw);
    if (h23 && mode === "sections") {
      flush();
      cur = { level: h23[1].length === 3 ? 3 : 2, heading: h23[2].trim(), plan: [] };
      continue;
    }
    if (mode === "thesis") thesis.push(raw);
    else if (mode === "journal") journal.push(raw);
    else if (mode === "themes") themes.push(raw);
    else if (mode === "sections" && cur) cur.plan.push(raw);
    else if (mode === "extra" && extra) {
      // the intro blockquote sits under the FIRST h1 (the title), nowhere else
      if (h1n === 1 && raw.trim().startsWith(">")) intro.push(raw.trim());
      else extra.body.push(raw);
    }
  }
  flush(); flushExtra();
  return {
    thesis: thesis.join("\n").replace(/^\n+|\n+$/g, "").trim(),
    targetJournal: journal.join("\n").replace(/^\n+|\n+$/g, "").trim(),
    themes: themes.join("\n").replace(/^\n+|\n+$/g, "").trim(),
    sections,
    extras,
    intro: intro.join("\n").trim(),
  };
}

export function serializeOutline(model: OutlineModel, title: string): string {
  const o: string[] = ["---", "type: outline", "---", "", "# " + (title || "Untitled") + " — outline",
    "", (model.intro || "").trim() || INTRO, ""];
  const block = (heading: string, body: string) => {
    o.push("# " + heading); o.push("");
    if (body && body.trim()) { o.push(body.trim()); o.push(""); }
  };
  for (const x of model.extras || []) if ((x.body || "").trim()) block(x.heading || "Note", x.body);
  block("Thesis", model.thesis);
  block("Target journal", model.targetJournal);
  block("Concepts", model.themes);
  o.push("# Sections"); o.push("");
  for (const s of model.sections) {
    o.push((s.level === 3 ? "###" : "##") + " " + s.heading); o.push("");
    if (s.plan && s.plan.trim()) { o.push(s.plan.trim()); o.push(""); }
  }
  return o.join("\n").replace(/\n+$/, "") + "\n";
}
