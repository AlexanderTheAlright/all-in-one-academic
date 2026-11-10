
import { parseDate } from "@/lib/format";

export const isoToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export const isoAdd = (iso: string, n: number) => {
  const d = parseDate(iso)!;
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** strip the `- [ ]` checkbox prefix off a raw card line */
export function bodyOf(raw: string) {
  return raw.replace(/^\s*-\s*\[.\]\s*/, "");
}

/** swap, append, or remove the @due token on a raw card line. iso===null unpins it. */
export function withDue(raw: string, iso: string | null) {
  let b = bodyOf(raw);
  if (iso === null) b = b.replace(/\s*@due\([^)]*\)/, "");
  else if (/@due\([^)]*\)/.test(b)) b = b.replace(/@due\([^)]*\)/, `@due(${iso})`);
  else b = `${b} @due(${iso})`;
  return b.replace(/\s{2,}/g, " ").trim();
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

export function parseQuickAdd(input: string, defaultDue: string | null) {
  let text = input.trim();
  let due: string | null = defaultDue;
  let prio = "";
  let est = "";
  text = text.replace(/@due\(([^)]*)\)|@(\d{4}-\d{2}-\d{2})|@(today|tomorrow|[a-z]{3,9})\b/gi, (m, p1, p2, p3) => {
    if (p1 || p2) { due = (p1 || p2); return ""; }
    const w = (p3 || "").toLowerCase();
    if (w === "today") { due = isoToday(); return ""; }
    if (w === "tomorrow") { due = isoAdd(isoToday(), 1); return ""; }
    const wd = WEEKDAYS.findIndex((d) => d.startsWith(w));
    if (wd >= 0 && w.length >= 3) {
      const now = new Date();
      const diff = (wd - now.getDay() + 7) % 7;
      due = isoAdd(isoToday(), diff === 0 ? 7 : diff);
      return "";
    }
    return m; // not a date word — leave it (e.g. an @mention in the text)
  });
  text = text.replace(/!(high|h|1)\b/i, () => { prio = "@high"; return ""; })
             .replace(/!(medium|med|m|2)\b/i, () => { prio = "@medium"; return ""; })
             .replace(/!(low|l|3)\b/i, () => { prio = "@low"; return ""; });
  text = text.replace(/~(\d+)\s*m\b/i, (_, n) => { est = `@est(${n}m)`; return ""; })
             .replace(/~(\d+)h(\d+)?\b/i, (_, h, m) => { est = `@est(${Number(h) * 60 + Number(m || 0)}m)`; return ""; });
  const clean = text.replace(/\s{2,}/g, " ").trim();
  const parts = [clean];
  if (due) parts.push(`@due(${due})`);
  if (prio) parts.push(prio);
  if (est) parts.push(est);
  return { text: clean, due, card: parts.join(" ").trim() };
}
