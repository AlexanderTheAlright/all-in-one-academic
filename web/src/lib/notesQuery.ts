
import type { GraphNode } from "@/lib/api";

export type Cmp = ">" | "<" | ">=" | "<=" | "=";
export type Clause =
  | { t: "tag"; v: string; neg: boolean }
  | { t: "type"; v: string; neg: boolean }
  | { t: "path"; v: string; neg: boolean }
  | { t: "links"; op: Cmp; n: number }
  | { t: "is"; v: string; neg: boolean }
  | { t: "near"; v: string };

export type Query = { clauses: Clause[]; text: string; terms: string[] };

const FIELD = /^(-?)(tag|type|path|folder|links|backlinks|is|near)$/i;
const RECENT_DAYS = 14;

// split on whitespace but keep "quoted phrases" together
function tokenize(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[1] !== undefined ? m[1] : m[2]);
  return out;
}

export function parseQuery(input: string): Query {
  const clauses: Clause[] = [];
  const terms: string[] = [];
  for (const tok of tokenize(input || "")) {
    const i = tok.indexOf(":");
    if (i > 0) {
      const rawField = tok.slice(0, i);
      const fm = rawField.match(FIELD);
      if (fm) {
        const neg = fm[1] === "-";
        const field = fm[2].toLowerCase();
        const val = tok.slice(i + 1).replace(/^"|"$/g, "").trim();
        if (!val && field !== "is") { continue; }
        if (field === "tag") clauses.push({ t: "tag", v: val.toLowerCase(), neg });
        else if (field === "type") clauses.push({ t: "type", v: val.toLowerCase(), neg });
        else if (field === "path" || field === "folder") clauses.push({ t: "path", v: val.toLowerCase(), neg });
        else if (field === "is") clauses.push({ t: "is", v: val.toLowerCase(), neg });
        else if (field === "near") clauses.push({ t: "near", v: val });
        else if (field === "links" || field === "backlinks") {
          const cm = val.match(/^(>=|<=|>|<|=)?\s*(\d+)$/);
          if (cm) clauses.push({ t: "links", op: (cm[1] as Cmp) || "=", n: +cm[2] });
        }
        continue;
      }
    }
    terms.push(tok);
  }
  return { clauses, text: terms.join(" "), terms: terms.map((t) => t.toLowerCase()) };
}

function cmp(op: Cmp, a: number, b: number): boolean {
  switch (op) { case ">": return a > b; case "<": return a < b; case ">=": return a >= b; case "<=": return a <= b; default: return a === b; }
}

// apply the STRUCTURED clauses (not free text) to a node — AND across clauses
export function matchClauses(n: GraphNode, clauses: Clause[]): boolean {
  for (const c of clauses) {
    if (c.t === "tag") {
      const has = (n.tags || []).some((t) => t.toLowerCase() === c.v);
      if (has === c.neg) return false;
    } else if (c.t === "type") {
      const is = (n.type || "").toLowerCase() === c.v;
      if (is === c.neg) return false;
    } else if (c.t === "path") {
      const hay = `${n.folder || ""}/${n.path || ""}`.toLowerCase();
      const has = hay.includes(c.v);
      if (has === c.neg) return false;
    } else if (c.t === "links") {
      if (!cmp(c.op, n.degree || 0, c.n)) return false;
    } else if (c.t === "is") {
      let v = false;
      if (c.v === "orphan") v = !!n.orphan;
      else if (c.v === "ghost") v = !!n.ghost;
      else if (c.v === "external") v = !!n.external;
      else if (c.v === "linked") v = (n.degree || 0) > 0;
      else if (c.v === "recent") v = !!n.mtime && Date.now() / 1000 - n.mtime < RECENT_DAYS * 86400;
      if (v === c.neg) return false;
    }
    // near: is handled by the semantic layer, not here
  }
  return true;
}

export const hasStructured = (q: Query) => q.clauses.some((c) => c.t !== "near");

// a human label for a clause chip
export function clauseLabel(c: Clause): string {
  const neg = "neg" in c && c.neg ? "−" : "";
  if (c.t === "links") return `links${c.op}${c.n}`;
  if (c.t === "near") return `near "${c.v}"`;
  return `${neg}${c.t}:${(c as { v: string }).v}`;
}

// remove one clause from a query string (so a chip's × writes back cleanly)
export function dropClause(input: string, target: Clause): string {
  const toks = tokenize(input);
  const want = clauseLabel(target).replace("−", "-");
  const kept = toks.filter((tok) => {
    const p = parseQuery(tok);
    const c = p.clauses[0];
    if (!c) return true;
    return clauseLabel(c).replace("−", "-") !== want;
  });
  return kept.join(" ");
}
