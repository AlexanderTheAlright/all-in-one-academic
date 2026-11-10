

export type DraftStyle = "manuscript" | "oped" | "thesis";

export const PUBLISH_FORMATS: { id: string; label: string }[] = [
  { id: "working", label: "Working paper" },
  { id: "asr", label: "ASR / ASA journal" },
  { id: "ajs", label: "AJS" },
  { id: "sage", label: "Work & Occupations (SAGE)" },
  { id: "wes", label: "Work, Employment & Society" },
  { id: "thesis", label: "Thesis / dissertation" },
  { id: "proposal", label: "Proposal" },
  { id: "oped", label: "Op-ed" },
  { id: "long-report", label: "Long report" },
  { id: "prof-brief", label: "Professor brief" },
  { id: "qualitative", label: "Qualitative" },
  { id: "book-draft", label: "Book draft" },
];

const FORMAT_LABEL: Record<string, string> = Object.fromEntries(
  PUBLISH_FORMATS.map((f) => [f.id, f.label]),
);
export const formatLabel = (publish: string): string =>
  FORMAT_LABEL[(publish || "").toLowerCase()] || (publish || "—");

export function renderPreset(publish: string | null | undefined): DraftStyle {
  const p = (publish || "").toLowerCase();
  if (p === "thesis" || p === "dissertation") return "thesis";
  if (p === "oped" || p === "op-ed") return "oped";
  return "manuscript";
}

export const DRAFT_MEASURE: Record<DraftStyle, number> = { manuscript: 780, oped: 600, thesis: 800 };

// CSS custom properties consumed by the CodeMirror theme (markdownEditor.tsx). Set
// on the editor host; they cascade into .cm-content / .cm-scroller / headings.
export const DRAFT_STYLE_VARS: Record<DraftStyle, Record<string, string>> = {
  manuscript: {
    "--draft-measure": DRAFT_MEASURE.manuscript + "px", "--draft-fontsize": "16.5px", "--draft-leading": "1.72",
    "--draft-h1": "2em", "--draft-h2": "1.5em", "--draft-h3": "1.22em",
  },
  oped: {
    "--draft-measure": DRAFT_MEASURE.oped + "px", "--draft-fontsize": "18px", "--draft-leading": "1.6",
    "--draft-h1": "1.7em", "--draft-h2": "1.2em", "--draft-h3": "1.08em",
  },
  thesis: {
    "--draft-measure": DRAFT_MEASURE.thesis + "px", "--draft-fontsize": "16.5px", "--draft-leading": "1.95",
    "--draft-h1": "2.2em", "--draft-h2": "1.62em", "--draft-h3": "1.28em",
  },
};

export const STYLE_LABEL: Record<DraftStyle, string> = {
  manuscript: "Manuscript", oped: "Op-ed column", thesis: "Thesis",
};

export const KIND_DEFAULT_PUBLISH: Record<string, string> = {
  paper: "working", oped: "oped", dissertation: "thesis", proposal: "proposal",
  report: "long-report",
};

// the journal styles a manuscript's `journal:` key takes (drafting.py's format tokens);
// the Publish panel and the Outline's settings both offer exactly this list
export const PUB_JOURNALS: { value: string; label: string }[] = [
  { value: "working", label: "Working paper" },
  { value: "asr", label: "American Sociological Review (ASR)" },
  { value: "ajs", label: "American Journal of Sociology (AJS)" },
  { value: "social-forces", label: "Social Forces" },
  { value: "smh", label: "Society and Mental Health" },
  { value: "jhsb", label: "Journal of Health and Social Behavior" },
  { value: "spq", label: "Social Psychology Quarterly" },
  { value: "socius", label: "Socius" },
  { value: "soc-theory", label: "Sociological Theory" },
  { value: "esr", label: "European Sociological Review" },
  { value: "ser", label: "Socio-Economic Review" },
  { value: "work-occ", label: "Work and Occupations" },
  { value: "wes", label: "Work, Employment and Society" },
];

// --- frontmatter: read / rewrite the leading YAML block (publish: key) ---------
// matches md_to_latex.strip_frontmatter: a --- fence at byte 0 to the next ---.
const FM_RE = /^---\n([\s\S]*?)\n---\n?/;

/** The `publish:` value in the leading frontmatter, lowercased, or null. */
export function readPublish(text: string): string | null {
  const m = FM_RE.exec(text || "");
  if (!m) return null;
  const k = /^publish\s*:\s*(.+?)\s*$/m.exec(m[1]);
  if (!k) return null;
  const v = k[1].trim().replace(/^["']|["']$/g, "").toLowerCase();
  return v || null;
}

export function readSpacingKey(text: string): "single" | "double" | null {
  const m = FM_RE.exec(text || "");
  if (!m) return null;
  const k = /^spacing\s*:\s*(.+?)\s*$/m.exec(m[1]);
  if (!k) return null;
  const v = k[1].trim().replace(/^["']|["']$/g, "").toLowerCase();
  return v === "double" || v === "single" ? v : null;
}

export function withSpacing(text: string, spacing: "single" | "double"): string {
  return withFmKey(text, "spacing", spacing);
}

/** Generic frontmatter key reader (lowercased, quotes stripped) — `font:`,
 * `fontsize:` and friends ride the same channel as `publish:`/`spacing:`. */
export function readFmKey(text: string, key: string): string | null {
  const m = FM_RE.exec(text || "");
  if (!m) return null;
  const k = new RegExp("^" + key + "\\s*:\\s*(.+?)\\s*$", "m").exec(m[1]);
  if (!k) return null;
  const v = k[1].trim().replace(/^["']|["']$/g, "").toLowerCase();
  return v || null;
}

/** Set/remove any frontmatter key, preserving the others + the body. Passing
 * null removes the key. */
export function withFmKey(text: string, key: string, value: string | null): string {
  const t = text || "";
  const m = FM_RE.exec(t);
  const body = (m ? t.slice(m[0].length) : t).replace(/^\n+/, "");
  const re = new RegExp("^" + key + "\\s*:");
  const keys = m ? m[1].split("\n").filter((l) => l.trim() && !re.test(l)) : [];
  if (value) keys.push(key + ": " + value);
  if (!keys.length) return body;
  return "---\n" + keys.join("\n") + "\n---\n\n" + body;
}

export function withPublish(text: string, publish: string, kindDefault: string): string {
  const t = text || "";
  const m = FM_RE.exec(t);
  const body = (m ? t.slice(m[0].length) : t).replace(/^\n+/, "");
  const keys = m
    ? m[1].split("\n").filter((l) => l.trim() && !/^publish\s*:/.test(l))
    : [];
  if (publish && publish.toLowerCase() !== (kindDefault || "").toLowerCase()) {
    keys.push("publish: " + publish);
  }
  if (!keys.length) return body;
  return "---\n" + keys.join("\n") + "\n---\n\n" + body;
}
