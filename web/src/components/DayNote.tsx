
import { useCallback, useEffect, useRef, useState, type Ref } from "react";
import { Copy, ExternalLink, FileCode2, Mail, NotebookPen, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { copyPlain, copyRich } from "@/lib/clipboard";
import { Markdown } from "@/lib/markdown";
import { Chip, PanelSection } from "@/components/calrows";

const DAILY_DIR = "Preparation/Notes/Daily/";

type Section = { title: string; body: string };
type PrepItem = { title: string; raw: string; meta: [string, string][]; subject: string | null; body: string };

/** `## ` sections, with the `---` dividers and the closing `#daily-note` tag dropped. */
function splitSections(text: string): Section[] {
  const lines = text.replace(/\r/g, "").split("\n")
    .filter((l) => l.trim() !== "---" && !/^\s*#[\w/-]+(\s+#[\w/-]+)*\s*$/.test(l));
  const out: Section[] = [];
  let cur: Section = { title: "", body: "" };
  for (const l of lines) {
    const h = l.match(/^##\s+(.*?)\s*$/);
    if (h) { out.push(cur); cur = { title: h[1], body: "" }; continue; }
    cur.body += l + "\n";
  }
  out.push(cur);
  return out.map((s) => ({ ...s, body: s.body.trim() }));
}

/** A section with nothing but its template (`###` prompts, the italic cue) is empty. */
const isEmpty = (body: string) =>
  !body.split("\n").some((l) => l.trim() && !/^#{3,6}\s/.test(l) && !/^_[^_].*_$/.test(l.trim()));

const META = /^\*\*(To|Cc|Bcc|From|Subject):\*\*\s*(.*)$/i;

/** Prep split at `###`; an email's header lines become meta, the rest its body. */
function prepItems(body: string): PrepItem[] {
  const parts: { title: string; raw: string }[] = [];
  let cur = { title: "", raw: "" };
  for (const l of body.split("\n")) {
    const h = l.match(/^###\s+(.*?)\s*$/);
    if (h) { parts.push(cur); cur = { title: h[1], raw: "" }; continue; }
    cur.raw += l + "\n";
  }
  parts.push(cur);
  return parts.map((p) => ({ ...p, raw: p.raw.trim() })).filter((p) => p.raw).map((p) => {
    const lines = p.raw.split("\n");
    const meta: [string, string][] = [];
    while (lines.length && META.test(lines[0].trim())) {
      const m = lines.shift()!.trim().match(META)!;
      meta.push([m[1][0].toUpperCase() + m[1].slice(1).toLowerCase(), m[2].trim()]);
    }
    const subject = meta.find(([k]) => k === "Subject")?.[1] || null;
    return { ...p, meta, subject, body: lines.join("\n").trim() };
  });
}

/** The rendered body as bare HTML for the clipboard: structure kept, app styling dropped. */
function cleanHtml(el: HTMLElement): string {
  const c = el.cloneNode(true) as HTMLElement;
  c.querySelectorAll("*").forEach((n) => { n.removeAttribute("class"); n.removeAttribute("style"); n.removeAttribute("id"); });
  return c.innerHTML;
}

const unmark = (md: string) => md.replace(/\*\*(.+?)\*\*/g, "$1").replace(/__(.+?)__/g, "$1");

async function say(ok: boolean, what: string) {
  if (ok) toast.success(what + " copied");
  else toast.error("Couldn't copy");
}

function PrepCard({ it }: { it: PrepItem }) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const email = it.meta.length > 0;
  const copyBody = async () => {
    const el = bodyRef.current;
    say(el ? await copyRich(cleanHtml(el), unmark(it.body)) : await copyPlain(it.body), email ? "Body" : "Text");
  };
  return (
    <article className="rounded-xl border border-border bg-card/60 overflow-hidden">
      <header className="flex items-start gap-2 px-4 pt-3 pb-2">
        <div className="flex-1 min-w-0 text-[13.5px] font-semibold leading-snug text-foreground flex items-center gap-1.5">
          {email && <Mail size={13} className="shrink-0 text-primary/80" />}
          <span>{it.title || "Prep"}</span>
        </div>
        <div className="shrink-0 flex items-center gap-1">
          {it.subject && (
            <Chip onClick={async () => say(await copyPlain(it.subject!), "Subject")} title="Copy the subject line">Subject</Chip>
          )}
          <Chip onClick={copyBody} title={email ? "Copy the body, formatted for email" : "Copy, formatted for email or Word"}>
            <Copy size={10} /> {email ? "Body" : "Copy"}
          </Chip>
          <Chip onClick={async () => say(await copyPlain(it.raw), "Markdown")} title="Copy as markdown">
            <FileCode2 size={10} /> MD
          </Chip>
        </div>
      </header>
      {email && (
        <dl className="mx-4 mb-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[12.5px] border-b border-border/50 pb-2">
          {it.meta.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted-foreground/80">{k}</dt>
              <dd className="text-foreground/90 min-w-0 break-words">{v}</dd>
            </div>
          ))}
        </dl>
      )}
      <div ref={bodyRef} className="px-4 pb-3.5 select-text">
        <Markdown text={it.body} breaks sans className="text-[14px] leading-[1.7] text-foreground" />
      </div>
    </article>
  );
}

export function DayNote({ day, onLoaded, sectionRef }: {
  day: string;
  /** tells the panel whether there is anything to show (its header button scrolls here) */
  onLoaded?: (has: boolean) => void;
  sectionRef?: Ref<HTMLDivElement>;
}) {
  const [text, setText] = useState<string | null>(null);
  const load = useCallback(() => {
    api.dailyRead(day).then((n) => setText(n.text || "")).catch(() => setText(""));
  }, [day]);
  useEffect(() => { setText(null); load(); }, [load]);
  // an edit made in Obsidian shows when the Board window is back in front
  useEffect(() => {
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, [load]);

  const sections = text ? splitSections(text) : [];
  const prep = sections.find((s) => /^prep\b/i.test(s.title));
  const items = prep ? prepItems(prep.body) : [];
  const rest = sections.filter((s) => s !== prep && !isEmpty(s.body));
  const has = items.length + rest.length > 0;
  useEffect(() => { if (text !== null) onLoaded?.(has); }, [text, has, onLoaded]);
  if (!has) return null;

  return (
    <div ref={sectionRef} className="scroll-mt-4">
      <PanelSection label="Daily note" icon={<NotebookPen size={12} />}
        right={
          <div className="flex items-center gap-1">
            <Chip onClick={async () => say(await copyPlain(text || ""), "Note")} title="Copy the whole note as markdown"><Copy size={10} /></Chip>
            <Chip onClick={load} title="Reload the note"><RotateCcw size={10} /></Chip>
            <Chip onClick={() => api.open(DAILY_DIR + day + ".md")} title="Open in Obsidian"><ExternalLink size={10} /></Chip>
          </div>
        }>
        {items.length > 0 && (
          <div className="grid gap-2.5 mb-4">
            {items.map((it, i) => <PrepCard key={i + it.title} it={it} />)}
          </div>
        )}
        {rest.map((s, i) => (
          <div key={i + s.title} className="mb-4 last:mb-0">
            {s.title && (
              <div className="text-[11px] uppercase tracking-[0.08em] font-semibold text-muted-foreground/80 mb-1.5">{s.title}</div>
            )}
            <Markdown text={s.body} breaks sans className="text-[14px] leading-[1.7] text-foreground" />
          </div>
        ))}
      </PanelSection>
    </div>
  );
}
