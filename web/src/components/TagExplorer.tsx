
import { TASKS_BOARD } from "@/lib/paths";
import { useState, useMemo, useRef } from "react";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Hash, Copy, Check, CheckCheck, ExternalLink, FileText, SquareKanban, ArrowLeft } from "lucide-react";
import { useApi } from "@/lib/hooks";
import { api } from "@/lib/api";
import type { TagStat, Hit, NoteHit } from "@/lib/api";
import { titleCase } from "@/lib/format";
import { copyPlain } from "@/lib/clipboard";
import { toast } from "sonner";

const RENDER_CAP = 220;
const SEP = "\u0001";

// a checked item — a card or a note — annotated with the tag it was picked under
type SelCard = { kind: "card"; tag: string; text: string; board: string; lane: string; done: boolean; due: string | null };
type SelNote = { kind: "note"; tag: string; title: string; link: string; snippet: string };
type SelItem = SelCard | SelNote;
const cardId = (tag: string, h: Hit) => "c" + SEP + tag + SEP + h.path + SEP + h.raw;
const noteId = (tag: string, n: NoteHit) => "n" + SEP + tag + SEP + n.path + SEP + n.source;

const copyText = copyPlain;

function lineFor(it: SelItem): string {
  if (it.kind === "card") {
    const ctx = [it.board, it.lane].filter(Boolean).join(" · ");
    const due = it.due ? ` (due ${it.due})` : "";
    return `- [${it.done ? "x" : " "}] ${it.text}${ctx ? ` — ${ctx}` : ""}${due}`;
  }
  const alias = it.title && it.title !== it.link ? `|${it.title}` : "";
  const snip = it.snippet && it.snippet !== it.title ? ` — ${it.snippet}` : "";
  return `- [[${it.link}${alias}]]${snip}`;
}

// folder label for a note path, e.g. "Citations" / "Notes/Daily"
function folderOf(path: string): string {
  const parts = path.split("/");
  parts.pop();
  return parts.slice(-2).join("/") || parts.join("/");
}

export function TagExplorer({
  open, setOpen, openBoard,
}: {
  open: boolean; setOpen: (b: boolean) => void;
  openBoard: (path: string, title: string, isPaper: boolean) => void;
}) {
  const tagsRes = useApi(
    () => (open ? api.tags() : Promise.resolve({ tags: [] as TagStat[], index: undefined })),
    [open],
  );
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [cards, setCards] = useState<Hit[]>([]);
  const [notes, setNotes] = useState<NoteHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");
  const [picked, setPicked] = useState<Record<string, SelItem>>({});

  const all: TagStat[] = tagsRes.data?.tags || [];
  const index = tagsRes.data?.index;
  const visible = useMemo(() => {
    const needle = filter.toLowerCase();
    return all.filter((t) => !needle || t.tag.toLowerCase().includes(needle));
  }, [all, filter]);
  const shown = visible.slice(0, RENDER_CAP);
  const overflow = visible.length - shown.length;
  const maxCount = Math.max(1, ...all.slice(0, 50).map((t) => t.count));

  const reqTag = useRef<string | null>(null);
  const cloudRef = useRef<HTMLDivElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const reset = () => { reqTag.current = null; setSelectedTag(null); setCards([]); setNotes([]); setFilter(""); setPicked({}); };

  const pickTag = (t: TagStat) => {
    reqTag.current = t.tag;
    setSelectedTag(t.tag);
    setLoading(true);
    api.tagOccurrences(t.tag)
      .then((o) => { if (reqTag.current === t.tag) { setCards(o.cards || []); setNotes(o.notes || []); } })
      .catch(() => { if (reqTag.current === t.tag) { setCards([]); setNotes([]); } })
      .finally(() => { if (reqTag.current === t.tag) setLoading(false); });
  };

  // back from one tag's places to the whole tag list; checked items stay checked.
  // Focus that would fall with the results lands on the tag you came from.
  const backToTags = () => {
    const tag = selectedTag;
    const a = document.activeElement;
    const lost = !a || a === document.body || !!resultsRef.current?.contains(a);
    reqTag.current = null;
    setSelectedTag(null); setCards([]); setNotes([]); setLoading(false);
    if (lost && tag) requestAnimationFrame(() => {
      const el = Array.from(cloudRef.current?.querySelectorAll<HTMLElement>("[data-knav-id]") || [])
        .find((b) => b.getAttribute("data-knav-id") === `tag-${tag}`);
      el?.focus();
    });
  };

  const setSel = (id: string, val: SelItem | null) =>
    setPicked((prev) => { const n = { ...prev }; if (val) n[id] = val; else delete n[id]; return n; });

  const cardSel = (h: Hit): SelCard => ({ kind: "card", tag: selectedTag!, text: h.text, board: h.board, lane: h.lane, done: h.done, due: h.due });
  const noteSel = (n: NoteHit): SelNote => ({ kind: "note", tag: selectedTag!, title: n.title, link: n.link, snippet: n.snippet });

  const allIds = useMemo(() => [
    ...cards.map((h) => cardId(selectedTag || "", h)),
    ...notes.map((n) => noteId(selectedTag || "", n)),
  ], [cards, notes, selectedTag]);
  const total = cards.length + notes.length;
  const allShownSelected = total > 0 && allIds.every((id) => picked[id]);

  const toggleAllShown = () => {
    if (!selectedTag) return;
    setPicked((prev) => {
      const next = { ...prev };
      if (allShownSelected) { for (const id of allIds) delete next[id]; }
      else {
        for (const h of cards) next[cardId(selectedTag, h)] = cardSel(h);
        for (const n of notes) next[noteId(selectedTag, n)] = noteSel(n);
      }
      return next;
    });
  };

  const copyAllShown = async () => {
    if (!selectedTag || total === 0) return;
    const lines = [
      ...cards.map((h) => lineFor(cardSel(h))),
      ...notes.map((n) => lineFor(noteSel(n))),
    ];
    (await copyText(`#${selectedTag}\n` + lines.join("\n")))
      ? toast.success(`Copied ${total} item${total === 1 ? "" : "s"} for #${selectedTag}`, { description: "paste into your note" })
      : toast.error("Couldn't copy");
  };

  const pickedCount = Object.keys(picked).length;
  const copyPicked = async () => {
    const items = Object.values(picked);
    if (!items.length) return;
    const byTag = new Map<string, SelItem[]>();
    for (const it of items) { if (!byTag.has(it.tag)) byTag.set(it.tag, []); byTag.get(it.tag)!.push(it); }
    const md = [...byTag.entries()].map(([tag, its]) => `#${tag}\n` + its.map(lineFor).join("\n")).join("\n\n");
    if (!(await copyText(md))) { toast.error("Couldn't copy"); return; }
    toast.success(`Copied ${items.length} item${items.length === 1 ? "" : "s"}`, {
      description: byTag.size > 1 ? `across ${byTag.size} tags — paste into your note` : "paste into your note",
    });
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset(); }}>
      <DialogContent className="max-w-2xl"
        onEscapeKeyDown={(e) => { if (selectedTag) { e.preventDefault(); backToTags(); } }}>
        <DialogTitle className="flex items-center gap-2"><Hash size={16} />Tags
          {all.length > 0 && <span className="text-[11px] font-normal text-muted-foreground nums">{all.length.toLocaleString()}</span>}
        </DialogTitle>
        <DialogDescription className="sr-only">Browse every tag across your vault and copy tagged items into a note</DialogDescription>
        <Input value={filter} onChange={(e) => setFilter(e.target.value)}
               placeholder="Filter tags…" className="mb-3 text-[13px]" />
        <div ref={cloudRef} className="flex flex-wrap gap-1.5 max-h-[170px] overflow-y-auto tinybar pr-1">
          {shown.map((t) => {
            const w = 0.6 + 0.4 * Math.min(1, t.count / maxCount);
            const on = selectedTag === t.tag;
            const tip = [t.noteCount ? `${t.noteCount} notes` : "", t.cardCount ? `${t.cardCount} cards` : ""].filter(Boolean).join(" · ");
            return (
              <button key={t.tag} onClick={() => pickTag(t)} title={tip || `${t.count}`} data-knav-id={`tag-${t.tag}`}
                aria-pressed={on}
                className={`px-2.5 py-1 rounded-full border transition-colors flex items-center gap-1.5 ${on ? "bg-primary text-primary-foreground border-primary" : "border-border text-muted-foreground hover:text-foreground hover:border-primary/60"}`}
                style={{ fontSize: `${10 + w * 4}px` }}>
                #{t.tag}
                <span className={`text-[10px] nums ${on ? "text-primary-foreground/80" : "text-muted-foreground"}`}>{t.count}</span>
              </button>
            );
          })}
          {shown.length === 0 && (
            <div className="text-[13px] text-muted-foreground py-2">
              {index && !index.ready ? "Indexing your vault… reopen in a moment." : `No tags match "${filter}"`}
            </div>
          )}
        </div>
        {overflow > 0 && (
          <div className="mt-1 text-[10.5px] text-muted-foreground/70">+{overflow.toLocaleString()} more — keep typing to narrow</div>
        )}

        {selectedTag && (
          <div className="mt-4" ref={resultsRef}>
            <div className="flex items-center gap-2 mb-2">
              <button onClick={backToTags} data-knav-back title="Back to all tags" aria-label="Back to all tags"
                className="inline-flex items-center justify-center h-6 w-6 shrink-0 rounded-full border border-border text-muted-foreground hover:text-foreground hover:border-primary/50 transition-colors">
                <ArrowLeft size={12} />
              </button>
              <div className="text-[11px] uppercase tracking-[0.08em] font-semibold text-muted-foreground">
                #{selectedTag} · {total} {total === 1 ? "place" : "places"}
              </div>
              <div className="ml-auto flex items-center gap-1.5">
                <button onClick={toggleAllShown} disabled={total === 0}
                  className="inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-1 text-[11px] text-muted-foreground hover:text-foreground hover:border-primary/50 transition-colors disabled:opacity-40">
                  <CheckCheck size={12} /> {allShownSelected ? "Clear shown" : "Check all"}
                </button>
                <button onClick={copyAllShown} disabled={total === 0}
                  className="inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-1 text-[11px] text-muted-foreground hover:text-foreground hover:border-primary/50 transition-colors disabled:opacity-40">
                  <Copy size={12} /> Copy all
                </button>
              </div>
            </div>

            <div className="max-h-[320px] overflow-y-auto tinybar -mx-1 px-1">
              {loading && <div className="text-[13px] text-muted-foreground py-3">loading…</div>}

              {!loading && cards.length > 0 && (
                <>
                  <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.1em] font-semibold text-muted-foreground/80 mt-1 mb-1">
                    <SquareKanban size={11} /> On your boards · {cards.length}
                  </div>
                  <div className="divide-y divide-border/40">
                    {cards.map((h) => {
                      const id = cardId(selectedTag, h);
                      const on = !!picked[id];
                      return (
                        <div key={id} className="flex items-start gap-2 py-2 group rounded hover:bg-accent/40 transition-colors">
                          <button onClick={() => setSel(id, on ? null : cardSel(h))} aria-pressed={on}
                            className={`mt-0.5 w-4 h-4 shrink-0 rounded border flex items-center justify-center transition-colors ${on ? "bg-primary border-primary text-primary-foreground" : "border-border hover:border-primary/70"}`}>
                            {on && <Check size={11} strokeWidth={3} />}
                          </button>
                          <button onClick={() => setSel(id, on ? null : cardSel(h))} className="min-w-0 flex-1 text-left">
                            <span className={`block text-[13px] leading-snug ${h.done ? "line-through text-muted-foreground" : "text-foreground/90"}`}>{h.text}</span>
                            <span className="text-[10.5px] text-muted-foreground capitalize nums">{h.board} · {h.lane}{h.due ? ` · due ${h.due}` : ""}</span>
                          </button>
                          <button onClick={() => { openBoard(h.path, titleCase(h.board), h.path !== TASKS_BOARD); setOpen(false); }}
                            title="Open this board" aria-label={`Open the ${h.board} board`}
                            className="mt-0.5 shrink-0 text-muted-foreground/50 hover:text-primary opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 transition-opacity">
                            <ExternalLink size={13} />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}

              {!loading && notes.length > 0 && (
                <>
                  <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.1em] font-semibold text-muted-foreground/80 mt-3 mb-1">
                    <FileText size={11} /> In your notes · {notes.length}
                  </div>
                  <div className="divide-y divide-border/40">
                    {notes.map((n) => {
                      const id = noteId(selectedTag, n);
                      const on = !!picked[id];
                      return (
                        <div key={id} className="flex items-start gap-2 py-2 group rounded hover:bg-accent/40 transition-colors">
                          <button onClick={() => setSel(id, on ? null : noteSel(n))} aria-pressed={on}
                            className={`mt-0.5 w-4 h-4 shrink-0 rounded border flex items-center justify-center transition-colors ${on ? "bg-primary border-primary text-primary-foreground" : "border-border hover:border-primary/70"}`}>
                            {on && <Check size={11} strokeWidth={3} />}
                          </button>
                          <button onClick={() => setSel(id, on ? null : noteSel(n))} className="min-w-0 flex-1 text-left">
                            <span className="block text-[13px] leading-snug text-foreground/90">{n.title}</span>
                            {n.snippet && n.snippet !== n.title && (
                              <span className="block text-[11.5px] text-muted-foreground/90 leading-snug line-clamp-2 mt-0.5">{n.snippet}</span>
                            )}
                            <span className="text-[10.5px] text-muted-foreground nums">{folderOf(n.path)} · {n.source}</span>
                          </button>
                          <button onClick={() => api.open(n.path)} title="Open this note in Obsidian" aria-label={`Open ${n.title} in Obsidian`}
                            className="mt-0.5 shrink-0 text-muted-foreground/50 hover:text-primary opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 transition-opacity">
                            <ExternalLink size={13} />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}

              {!loading && total === 0 && <div className="text-[13px] text-muted-foreground py-3">No cards or notes carry #{selectedTag}.</div>}
            </div>
          </div>
        )}

        {pickedCount > 0 && (
          <div className="mt-3 flex items-center gap-2 border-t border-border pt-3">
            <span className="text-[12px] text-muted-foreground">
              <span className="nums font-medium text-foreground">{pickedCount}</span> checked
            </span>
            <button onClick={() => setPicked({})}
              className="text-[11px] text-muted-foreground hover:text-foreground underline-offset-2 hover:underline">clear</button>
            <button onClick={copyPicked}
              className="ml-auto inline-flex items-center gap-1.5 rounded-full bg-primary text-primary-foreground px-4 py-1.5 text-[12px] font-medium hover:opacity-90 transition-opacity">
              <Copy size={13} /> Copy {pickedCount} for your note
            </button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
