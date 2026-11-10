
import { createElement, type ReactNode } from "react";
import { findMath, texToMathML, type MNode } from "./texmath";
import { openFile, openUrl } from "./opener";

/** a markdown link's target as the one attribute the click handler reads */
function linkAttr(href: string): Record<string, string> {
  if (/^(https?|mailto):/i.test(href)) return { "data-href": href };
  let path = href;
  try { path = decodeURIComponent(href); } catch { /* a literal % stays as written */ }
  return { "data-wikilink": path.replace(/^\.?\//, "") };
}

function onLinkClick(e: { target: EventTarget; preventDefault: () => void; stopPropagation: () => void },
  onWikiLink?: (target: string) => boolean) {
  const el = (e.target as HTMLElement).closest?.("[data-wikilink],[data-href]");
  if (!el) return;
  e.preventDefault(); e.stopPropagation();
  const href = el.getAttribute("data-href");
  if (href) { void openUrl(href); return; }
  const target = el.getAttribute("data-wikilink") || "";
  if (!onWikiLink?.(target)) void openFile(target);
}

export type Heading = { level: number; text: string; line: number; slug: string };

const COMMENT = /<!--[\s\S]*?-->/g;

export function mdSlug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function extractHeadings(text: string): Heading[] {
  const out: Heading[] = [];
  text.split("\n").forEach((ln, i) => {
    const m = ln.match(/^(#{1,6})\s+(.*?)\s*$/);
    if (m) {
      const t = m[2].replace(/\s*<!--[\s\S]*?-->\s*/g, "").trim();
      out.push({ level: m[1].length, text: t, line: i, slug: mdSlug(t) });
    }
  });
  return out;
}

/** Resolves an embed's bare filename to a URL. Notes pass one so a note READS
 * (images and diagrams render); Drafting passes none and keeps its placeholder. */
export type EmbedSrc = (name: string) => string | null;

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|avif)$/i;

function embedName(target: string): string {
  return (target.split("|")[0].trim().split("/").pop() || "").trim();
}

/** A MathML tree as React elements. String tags: React puts <math> and everything under
 * it in the MathML namespace; the one CSS attribute (table cell alignment) becomes an object. */
function mathReact(m: MNode, key: string | number): ReactNode {
  const props: Record<string, unknown> = { key };
  for (const [k, v] of Object.entries(m.attrs || {})) {
    props[k] = k !== "style" ? v : Object.fromEntries(v.split(";").filter(Boolean).map((d) => {
      const [p, val] = d.split(":");
      return [p.trim().replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()), val.trim()];
    }));
  }
  return createElement(m.tag, props, m.text !== undefined ? m.text : (m.kids || []).map((k, i) => mathReact(k, i)));
}

function mathSpan(tex: string, display: boolean, key: string): ReactNode {
  const r = texToMathML(tex, display);
  return <span key={key} title={r.errors.length ? r.errors.join("\n") : undefined}>{mathReact(r.node, "m")}</span>;
}

// math spans are stashed as private-use tokens before the inline regex runs, so a `_` or
// `*` inside TeX (Y_c … \beta_0) can never pair up into italics
const STASH = /(\d+)/g;
const ESC_DOLLAR = /\\\$/g;

/** Inline span parser: **bold**, *em* / _em_, `code`, ![[embed]], [[wikilink]], $math$. */
function inline(src: string, kb: string, embedSrc?: EmbedSrc): ReactNode[] {
  const math: ReactNode[] = [], raw: string[] = [];
  let s = src;
  const spans = findMath(src);
  if (spans.length) {
    let out = "", at = 0;
    spans.forEach((sp, j) => {
      out += src.slice(at, sp.from) + "" + j + "";
      math.push(mathSpan(sp.tex, sp.display, kb + "$" + j));
      raw.push(src.slice(sp.from, sp.to));
      at = sp.to;
    });
    s = out + src.slice(at);
  }
  // text back out of the stash: math as MathML (or its source, inside code and links), and
  // pandoc's escaped \$ as a plain dollar
  const un = (t: string): ReactNode => (math.length && t.includes("")
    ? t.split(STASH).map((p, j) => (j % 2 ? math[+p] : p.replace(ESC_DOLLAR, "$")))
    : t.replace(ESC_DOLLAR, "$"));
  const unRaw = (t: string): string => (raw.length ? t.replace(STASH, (_, j: string) => raw[+j]) : t);
  const re = /(\*\*([^*]+)\*\*)|(\*([^*\s][^*]*?)\*)|(__([^_]+)__)|(_([^_\s][^_]*?)_)|(`([^`]+)`)|(!\[\[([^\]]+)\]\])|(\[\[([^\]]+)\]\])|(\[([^\]]+)\]\(([^)\s]+)\))|(https?:\/\/[^\s<>)\]]+[^\s<>)\].,;:!?'"])/g;
  const nodes: ReactNode[] = [];
  let last = 0, k = 0, m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (m.index > last) nodes.push(un(s.slice(last, m.index)));
    if (m[1]) nodes.push(<strong key={kb + k++} className="font-semibold text-foreground">{un(m[2])}</strong>);
    else if (m[3]) nodes.push(<em key={kb + k++}>{un(m[4])}</em>);
    else if (m[5]) nodes.push(<strong key={kb + k++} className="font-semibold text-foreground">{un(m[6])}</strong>);
    else if (m[7]) nodes.push(<em key={kb + k++}>{un(m[8])}</em>);
    else if (m[9]) nodes.push(<code key={kb + k++} className="text-[0.9em] bg-secondary/60 rounded px-1 py-0.5">{unRaw(m[10])}</code>);
    else if (m[11]) {
      // an image embed renders for real when a resolver is supplied; everything else
      // (no resolver — Drafting — or a non-image like a .csv table) keeps the placeholder
      const name = embedName(unRaw(m[12]));
      const url = embedSrc && IMAGE_EXT.test(name) ? embedSrc(name) : null;
      if (url) nodes.push(<img key={kb + k++} src={url} alt={name} loading="lazy" className="max-w-full h-auto rounded-md border border-border/60" />);
      else nodes.push(<span key={kb + k++} className="text-muted-foreground/70 italic">[embed: {name}]</span>);
    }
    else if (m[13]) { const inner = unRaw(m[14]).split("|"); const lbl = (inner[1] || inner[0].split("/").pop() || inner[0]).trim(); nodes.push(<span key={kb + k++} data-wikilink={inner[0].trim()} className="text-primary underline decoration-dotted underline-offset-2">{lbl}</span>); }
    // [text](href) and bare URLs: a web address opens in this machine's browser, anything
    // else is taken as a vault path and opens in Obsidian here (see onLinkClick above)
    else if (m[15]) nodes.push(<span key={kb + k++} {...linkAttr(unRaw(m[17]))} className="text-primary underline decoration-dotted underline-offset-2">{un(m[16])}</span>);
    else if (m[18]) nodes.push(<span key={kb + k++} data-href={m[18]} className="text-primary underline decoration-dotted underline-offset-2 break-all">{m[18]}</span>);
    last = re.lastIndex;
  }
  if (last < s.length) nodes.push(un(s.slice(last)));
  return nodes.length ? nodes : [un(s)];
}

type Block =
  | { t: "h"; level: number; text: string }
  | { t: "hr" }
  | { t: "quote"; lines: string[] }
  | { t: "list"; ordered: boolean; items: string[] }
  | { t: "code"; lang: string; lines: string[] }
  | { t: "table"; header: string[]; rows: string[][] }
  | { t: "p"; lines: string[] };

const FENCE = /^(```+|~~~+)(.*)$/;
const TABLE_SEP = /^\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?$/;
/** Split a GFM table row into trimmed cells, tolerating optional outer pipes. */
function tableCells(row: string): string[] {
  return row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

function parseBlocks(src: string): Block[] {
  const text = src.replace(COMMENT, "");
  const lines = text.split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => { if (para.length) { blocks.push({ t: "p", lines: para }); para = []; } };
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const s = ln.trim();
    const fence = s.match(FENCE);
    if (fence) {
      flush();
      const lang = fence[2].trim();
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^\s*(```+|~~~+)\s*$/.test(lines[i])) { code.push(lines[i]); i++; }
      blocks.push({ t: "code", lang, lines: code }); continue;   // loop's i++ steps past the closing fence
    }
    const h = ln.match(/^(#{1,6})\s+(.*?)\s*$/);
    if (h) { flush(); blocks.push({ t: "h", level: h[1].length, text: h[2].trim() }); continue; }
    if (!s) { flush(); continue; }
    if (/^([-*_])\1{2,}$/.test(s)) { flush(); blocks.push({ t: "hr" }); continue; }
    if (s.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1].trim())) {
      flush();
      const header = tableCells(lines[i]);
      i += 2;   // skip header + separator
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) { rows.push(tableCells(lines[i])); i++; }
      i--; blocks.push({ t: "table", header, rows }); continue;
    }
    if (/^>\s?/.test(s)) {
      flush();
      const qlines: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { qlines.push(lines[i].replace(/^\s*>\s?/, "")); i++; }
      i--; blocks.push({ t: "quote", lines: qlines }); continue;
    }
    const li = s.match(/^([-*+]|\d+\.)\s+(.*)$/);
    if (li) {
      flush();
      const ordered = /\d+\./.test(li[1]);
      const items: string[] = [];
      while (i < lines.length) {
        const mm = lines[i].trim().match(/^([-*+]|\d+\.)\s+(.*)$/);
        if (!mm) break;
        items.push(mm[2]); i++;
      }
      i--; blocks.push({ t: "list", ordered, items }); continue;
    }
    para.push(ln);
  }
  flush();
  return blocks;
}

/** Render markdown to styled React nodes. `idPrefix` namespaces heading ids so two
 * Markdown panes on screen don't collide (used for TOC scroll). */
export function Markdown({ text, idPrefix, className, embedSrc, breaks, sans, onWikiLink }:
  { text: string; idPrefix?: string; className?: string; embedSrc?: EmbedSrc;
    /** a host that shows notes itself (the source viewer) takes a [[link]] first; true =
     *  handled, false = open it in Obsidian as usual */
    onWikiLink?: (target: string) => boolean;
    /** keep single line breaks inside a paragraph, as Obsidian shows a note (the
     * daily note's emails: To/Subject lines, a bold heading over a list of names) */
    breaks?: boolean;
    /** the app's own sans face instead of the reading serif (notes that sit in app UI) */
    sans?: boolean }) {
  if (!text.trim()) return <p className="text-[13px] text-muted-foreground italic">Nothing here yet.</p>;
  const blocks = parseBlocks(text);
  return (
    <div onClick={(e) => onLinkClick(e, onWikiLink)} className={(className ?? "text-[15px] leading-[1.75] text-foreground/90") + " [&_[data-wikilink]]:cursor-pointer [&_[data-href]]:cursor-pointer"} style={sans ? undefined : { fontFamily: "Georgia, 'Times New Roman', serif" }}>
      {blocks.map((b, i) => {
        if (b.t === "h") {
          const id = (idPrefix || "") + mdSlug(b.text);
          const size = b.level <= 1 ? "text-[22px]" : b.level === 2 ? "text-[18px]" : "text-[15.5px]";
          return <div key={i} id={id} className={`${size} font-semibold text-foreground mt-5 mb-2 first:mt-0 scroll-mt-4`}>{inline(b.text, id)}</div>;
        }
        if (b.t === "hr") return <div key={i} className="border-t border-border/60 my-4" />;
        if (b.t === "quote") return (
          <blockquote key={i} className="border-l-2 border-primary/40 pl-4 my-3 text-foreground/80 italic">
            {b.lines.map((l, j) => <p key={j}>{inline(l, `q${i}-${j}`, embedSrc)}</p>)}
          </blockquote>
        );
        if (b.t === "list") {
          const cls = `${b.ordered ? "list-decimal" : "list-disc"} pl-6 my-2.5 space-y-1`;
          const items = b.items.map((it, j) => <li key={j}>{inline(it, `l${i}-${j}`, embedSrc)}</li>);
          return b.ordered ? <ol key={i} className={cls}>{items}</ol> : <ul key={i} className={cls}>{items}</ul>;
        }
        if (b.t === "code") {
          return (
            <pre key={i} className="my-3 overflow-x-auto rounded-md border border-border bg-muted/40 px-3 py-2.5 text-[12.5px] leading-relaxed text-foreground/90"
              style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" }}>
              <code>{b.lines.join("\n")}</code>
            </pre>
          );
        }
        if (b.t === "table") {
          return (
            <div key={i} className="my-3 overflow-x-auto" style={{ fontFamily: "ui-sans-serif, system-ui, sans-serif" }}>
              <table className="w-full border-collapse text-[13px]">
                <thead>
                  <tr>{b.header.map((c, j) => (
                    <th key={j} className="border border-border bg-muted/50 px-2.5 py-1.5 text-left font-semibold text-foreground">{inline(c, `th${i}-${j}`)}</th>
                  ))}</tr>
                </thead>
                <tbody>{b.rows.map((r, ri) => (
                  <tr key={ri}>{b.header.map((_, ci) => (
                    <td key={ci} className="border border-border px-2.5 py-1.5 align-top text-foreground/90">{inline(r[ci] ?? "", `td${i}-${ri}-${ci}`)}</td>
                  ))}</tr>
                ))}</tbody>
              </table>
            </div>
          );
        }
        // a paragraph that is NOTHING but an image embed reads as a figure, not a
        // sentence — it gets the full column width while prose keeps its measure
        const joined = b.lines.join(" ");
        const only = joined.trim().match(/^!\[\[([^\]]+)\]\]$/);
        if (only && embedSrc) {
          const name = embedName(only[1]);
          const url = IMAGE_EXT.test(name) ? embedSrc(name) : null;
          if (url) return (
            <figure key={i} className="my-4">
              <img src={url} alt={name} loading="lazy" className="max-w-full h-auto rounded-md border border-border/60" />
            </figure>
          );
        }
        if (breaks && b.lines.length > 1) return (
          <p key={i} className="my-2.5 first:mt-0">
            {b.lines.map((l, j) => [j > 0 && <br key={`br${j}`} />, ...inline(l.trim(), `p${i}-${j}`, embedSrc)])}
          </p>
        );
        return <p key={i} className="my-2.5 first:mt-0">{inline(joined, `p${i}`, embedSrc)}</p>;
      })}
    </div>
  );
}

export function PoemView({ text, className }: { text: string; className?: string }) {
  const raw = (text || "").replace(COMMENT, "").split("\n");
  const lines = raw.slice();
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (!lines.length) return <p className="text-[13px] text-muted-foreground italic">Nothing here yet.</p>;

  const nodes: ReactNode[] = [];
  let stanza: ReactNode[] = [];
  const flushStanza = (key: string) => {
    if (stanza.length) { nodes.push(<p key={key} className="my-0">{stanza}</p>); stanza = []; }
  };
  lines.forEach((ln, i) => {
    const h = ln.match(/^(#{2,3})\s+(.*?)\s*$/);
    if (h) {
      flushStanza("s" + i);
      nodes.push(
        <div key={"h" + i} className="mt-10 mb-4 first:mt-0 text-center text-[12.5px] font-medium uppercase tracking-[0.18em] text-foreground/60">
          {inline(h[2].trim(), "h" + i)}
        </div>
      );
      return;
    }
    if (!ln.trim()) { flushStanza("s" + i); nodes.push(<div key={"gap" + i} className="h-6" />); return; }
    if (stanza.length) stanza.push(<br key={"br" + i} />);
    stanza.push(<span key={"l" + i}>{inline(ln, "l" + i)}</span>);
  });
  flushStanza("s-last");

  return (
    <div
      className={className ?? "text-[17px] leading-[2] text-foreground/90"}
      style={{ fontFamily: "Georgia, 'Times New Roman', serif", whiteSpace: "pre-wrap" }}
    >
      {nodes}
    </div>
  );
}
