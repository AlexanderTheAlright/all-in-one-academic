/* Date and string helpers used across views. */

export const PRIO_VAR: Record<string, string> = {
  high: "var(--p-high)", medium: "var(--p-med)", low: "var(--p-low)",
};
export const prioColor = (p: string | null) =>
  `hsl(${PRIO_VAR[p || "low"] || "var(--p-low)"})`;

export const pct = (done: number, open: number) =>
  done + open ? Math.round((100 * done) / (done + open)) : 0;

export const titleCase = (s: string) =>
  s.replace(/\b\w/g, (c) => c.toUpperCase());

export const paperDir = (path: string) =>
  path.replace(/\/PATH\.md$/, "");

export function parseDate(s: string): Date | null {
  const d = new Date(s + "T00:00:00");
  return isNaN(+d) ? null : d;
}

export type Tone = "over" | "soon" | "ok";

export function relDue(due: string | null): { label: string; tone: Tone } | null {
  const d = due ? parseDate(due) : null;
  if (!d) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((+d - +today) / 86400000);
  if (diff < 0) return { label: `${-diff}d overdue`, tone: "over" };
  if (diff === 0) return { label: "today", tone: "soon" };
  if (diff <= 3) return { label: `in ${diff}d`, tone: "soon" };
  if (diff <= 21) return { label: `in ${diff}d`, tone: "ok" };
  return { label: due!.slice(5), tone: "ok" };
}

/* Urgency (due-date pressure) owns the warning ramp — distinct from priority. */
export const toneColor = (t: Tone) =>
  t === "over" ? "hsl(var(--due-over))" :
  t === "soon" ? "hsl(var(--due-soon))" : "hsl(var(--due-ok))";

const CATEGORY_HSL: Record<string, string> = {
  meetings:    "205 52% 44%",   // 4.31 -> 4.65:1
  seminars:    "262 36% 54%",   // 4.99:1 already
  deadlines:   "349 36% 53%",   // dusty rose, not bright red — 4.20 -> 4.52:1
  birthdays:   "330 62% 52%",   // pink — 4.55:1 already
  holidays:    "174 70% 30%",   // teal — 3.75 -> 4.67:1
  social:      "145 38% 37%",   // 3.88 -> 4.64:1
  teaching:    "28 64% 41%",    // 3.46 -> 4.57:1
  conferences: "190 48% 38%",   // 4.16 -> 4.55:1
  travel:      "42 58% 36%",    // 3.20 -> 4.57:1
  commitments: "349 36% 53%",   // the planning ledger (virtual, read-only): deadlines' shade
};

const srgb = (u: number) => (u <= 0.03928 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4);
const lumOf = (r: number, g: number, b: number) => 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
function bgLuminance(css: string): number | null {
  const hsl = css.match(/hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%/i);
  if (hsl) {
    const h = +hsl[1] / 360, sat = +hsl[2] / 100, l = +hsl[3] / 100;
    if (sat === 0) return lumOf(l, l, l);
    const q = l < 0.5 ? l * (1 + sat) : l + sat - l * sat;
    const p = 2 * l - q;
    const hue = (t: number) => {
      let x = t; if (x < 0) x += 1; if (x > 1) x -= 1;
      if (x < 1 / 6) return p + (q - p) * 6 * x;
      if (x < 1 / 2) return q;
      if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
      return p;
    };
    return lumOf(hue(h + 1 / 3), hue(h), hue(h - 1 / 3));
  }
  const hex = css.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const v = hex[1].length === 3 ? hex[1].split("").map((c) => c + c).join("") : hex[1];
    return lumOf(parseInt(v.slice(0, 2), 16) / 255, parseInt(v.slice(2, 4), 16) / 255, parseInt(v.slice(4, 6), 16) / 255);
  }
  return null;   // a colour we cannot parse: keep the historical white rather than guess
}
/** Readable chip text for `bg`: white unless a dark ink scores better against it. */
export function chipInk(bg: string): string {
  const L = bgLuminance(bg);
  if (L === null) return "#fff";
  const onWhite = 1.05 / (L + 0.05);
  const onInk = (L + 0.05) / (0.0175 + 0.05);   // #1a1a1a
  return onInk > onWhite ? "#1a1a1a" : "#fff";
}

const AA = 4.5;
function toHsl(css: string): [number, number, number] | null {
  const m = css.match(/hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%/i);
  if (m) return [+m[1], +m[2], +m[3]];
  const hex = css.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!hex) return null;
  const v = hex[1].length === 3 ? hex[1].split("").map((c) => c + c).join("") : hex[1];
  const r = parseInt(v.slice(0, 2), 16) / 255, g = parseInt(v.slice(2, 4), 16) / 255, b = parseInt(v.slice(4, 6), 16) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, l = (mx + mn) / 2;
  if (!d) return [0, 0, l * 100];
  const sat = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  return [h, sat * 100, l * 100];
}
const whiteOn = (h: number, s: number, l: number): number => {
  const L = bgLuminance(`hsl(${h} ${s}% ${l}%)`);
  return L === null ? 0 : 1.05 / (L + 0.05);
};

export function chipStyle(bg: string): { background: string; color: string } {
  const hsl = toHsl(bg);
  if (!hsl) return { background: bg, color: chipInk(bg) };   // unparseable: measure, do not move
  const [h, s, l] = hsl;
  if (whiteOn(h, s, l) >= AA) return { background: bg, color: "#fff" };
  for (let nl = Math.round(l) - 1; nl >= 0; nl--) {
    if (whiteOn(h, s, nl) >= AA) return { background: `hsl(${h.toFixed(1)} ${s.toFixed(1)}% ${nl}%)`, color: "#fff" };
  }
  return { background: bg, color: chipInk(bg) };             // unreachable in practice: black is 21:1
}
export const categoryColor = (cat: string, fallback = "#888") =>
  CATEGORY_HSL[cat] ? `hsl(${CATEGORY_HSL[cat]})` : fallback;

/** an event's colour: its own e.color, except a read-only virtual one (the commitments
 *  ledger), whose server hex is ignored for the category's theme shade */
export const eventColor = (e: { color?: string; category: string; readOnly?: boolean }) =>
  e.readOnly || e.category === "commitments" ? categoryColor(e.category) : (e.color || categoryColor(e.category));

/* Effort estimates: parse @est(90m) / @est(2h) / @est(1.5h) from a raw card line.
 * Returns minutes, or null if none. */
export function parseEst(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const m = raw.match(/@est\(\s*([\d.]+)\s*(m|min|h|hr)?\s*\)/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (isNaN(n)) return null;
  const unit = (m[2] || "h").toLowerCase();
  return unit.startsWith("m") ? Math.round(n) : Math.round(n * 60);
}

/* Format minutes as a compact human duration: 90 → "1.5h", 45 → "45m". */
export function fmtEst(mins: number): string {
  if (mins < 60) return `${mins}m`;
  const h = mins / 60;
  return (Number.isInteger(h) ? h.toString() : h.toFixed(1)) + "h";
}

export function syncedAgo(generated?: string): string {
  if (!generated) return "";
  const d = new Date(generated.replace(" UTC", "Z").replace(" ", "T"));
  if (isNaN(+d)) return "";
  return relativeAgo(Math.max(0, Math.round((Date.now() - +d) / 1000)));
}

export function relativeAgo(secs: number) {
  if (secs < 90) return "just now";
  const m = Math.round(secs / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return `${Math.round(d / 30)}mo ago`;
}

export function fmtTime(s: string | null) {
  if (!s) return "";
  const [hh, mm] = s.split(":");
  const h = parseInt(hh, 10);
  const ap = h >= 12 ? "p" : "a";
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return mm === "00" ? `${h12}${ap}` : `${h12}:${mm}${ap}`;
}

export function fmtDate(s: string) {
  const d = parseDate(s);
  return d ? d.toLocaleDateString("en", { month: "short", day: "numeric" }) : s;
}

export function fmtDateLong(s: string) {
  const d = parseDate(s);
  return d ? d.toLocaleDateString("en", { weekday: "short", month: "short", day: "numeric" }) : s;
}

/** Tokenize card text: [[wiki-link]] becomes a {link} token, **bold** becomes {bold},
 * plain runs stay as {text}. Used to render cards with clickable references. */
type Token = { kind: "text" | "link" | "bold"; value: string };
export function tokenize(text: string): Token[] {
  const out: Token[] = [];
  const re = /\[\[([^\]]+?)\]\]|\*\*([^*]+?)\*\*/g;
  let last = 0; let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push({ kind: "text", value: text.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ kind: "link", value: m[1] });
    else if (m[2] !== undefined) out.push({ kind: "bold", value: m[2] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ kind: "text", value: text.slice(last) });
  return out;
}
