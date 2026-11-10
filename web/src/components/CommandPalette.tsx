
import { TASKS_BOARD } from "@/lib/paths";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  CommandDialog, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem,
} from "@/components/ui/command";
import { ExternalLink, FileText, LayoutGrid, Calendar, Hash, Sun, BookOpen, ArrowRight, SquarePen, Check } from "lucide-react";
import { api } from "@/lib/api";
import { VIEW_KEYS, VIEW_LABEL, EDITOR_LABEL, editorChoice, setEditorChoice } from "@/lib/keymap";
import type { EditorChoice } from "@/lib/keymap";
import type { Hit, Project, Recent, Today, Item, Event } from "@/lib/api";
import { fmtTime, paperDir, titleCase, fmtDateLong, fmtDate, categoryColor } from "@/lib/format";
import { toast } from "sonner";

/* the sidebar's order, and only the canonical letter for each view (p and m are
   legacy aliases for the calendar, so they are not listed twice) */
const GO_ORDER = ["t", "c", "d", "r", "l", "n", "i", "a", "h", "f", "k", "x"];

export function CommandPalette({
  open, setOpen, papers, today, recent, items, onPick, onGo,
}: {
  open: boolean; setOpen: (b: boolean) => void;
  papers: Project[]; today: Today | null; recent: Recent[]; items: Item[];
  onPick: (p: Project) => void;
  /** run a navigation action — the same destinations as the `g <letter>` keys */
  onGo?: (view: string) => void;
}) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [events, setEvents] = useState<Event[]>([]);
  const searching = q.trim().length >= 2;

  useEffect(() => { if (!open) { setQ(""); setHits([]); } }, [open]);
  // closing (Esc or a pick) hands focus back to where the palette was opened from, so a row
  // keeps its keys (`e` right after choosing the editor); the dialog's own restore lands on body
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const onIn = (e: FocusEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && t !== document.body && !t.closest?.("[role=dialog]")) opener.current = t;
    };
    document.addEventListener("focusin", onIn);
    return () => document.removeEventListener("focusin", onIn);
  }, []);
  useEffect(() => {
    if (open) return;
    let ticks = 0;
    const id = window.setInterval(() => {
      const a = document.activeElement as HTMLElement | null;
      if (a?.closest?.("[role=dialog]") && ticks++ < 20) return;   // still animating out, input focused
      window.clearInterval(id);
      const el = opener.current;
      if (el && el.isConnected && (!a || a === document.body)) el.focus({ preventScroll: true });
    }, 40);
    return () => window.clearInterval(id);
  }, [open]);
  // load the event window once when the palette opens
  useEffect(() => { if (open) api.events().then((r) => setEvents(r.events)).catch(() => setEvents([])); }, [open]);
  // debounced server card search
  useEffect(() => {
    if (!searching) { setHits([]); return; }
    let alive = true;
    const t = setTimeout(() => {
      api.search(q).then((h) => { if (alive) setHits(h); }).catch(() => alive && setHits([]));
    }, 140);
    return () => { alive = false; clearTimeout(t); };
  }, [q, searching]);

  // client-side citation + event matches
  const needle = q.trim().toLowerCase();
  const citations = useMemo(() => {
    if (!searching) return [];
    return items.filter((it) => (it.name + " " + it.author).toLowerCase().includes(needle)).slice(0, 8);
  }, [items, needle, searching]);
  const eventHits = useMemo(() => {
    if (!searching) return [];
    return events.filter((e) => e.title.toLowerCase().includes(needle)).slice(0, 6);
  }, [events, needle, searching]);

  const openNote = (file: string, label?: string) => { api.open(file); toast("Opened in Obsidian", { description: label || file }); };
  const editor = editorChoice();   // read on every render, so the tick follows the stored value

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Search cards, citations, events · jump to a board…" value={q} onValueChange={setQ} />
      <CommandList>
        <CommandEmpty>No matches.</CommandEmpty>

        {/* ---------------- search mode ---------------- */}
        {searching && hits.length > 0 && (
          <CommandGroup heading={`Cards · ${hits.length}`}>
            {hits.slice(0, 10).map((h, i) => (
              <CommandItem key={i} value={"card " + i + " " + h.text}
                onSelect={() => { onPick({ name: h.board, path: h.path, done: 0, open: 0 }); setOpen(false); }}>
                <Hash size={14} className="mr-2 opacity-60" />
                <span className="truncate">{h.text}</span>
                <span className="ml-auto text-[10.5px] text-muted-foreground nums shrink-0 capitalize">
                  {h.board} · {h.lane}{h.due ? " · " + h.due.slice(5) : ""}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {searching && citations.length > 0 && (
          <CommandGroup heading={`Library · ${citations.length}`}>
            {citations.map((c) => (
              <CommandItem key={c.name} value={"cite " + c.name + " " + c.author}
                onSelect={() => { openNote(`Preparation/Reading/Citations/${c.name}.md`, c.name); setOpen(false); }}>
                <BookOpen size={14} className="mr-2 opacity-60" />
                <span className="truncate">{c.name}</span>
                <span className="ml-auto text-[10.5px] text-muted-foreground nums shrink-0">{c.year || ""}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {searching && eventHits.length > 0 && (
          <CommandGroup heading={`Events · ${eventHits.length}`}>
            {eventHits.map((e) => (
              <CommandItem key={e.path} value={"event " + e.title}
                onSelect={() => { openNote(e.path, e.title); setOpen(false); }}>
                <span className="mr-2 w-2 h-2 rounded-full shrink-0" style={{ background: categoryColor(e.category) }} />
                <span className="truncate">{e.title}</span>
                <span className="ml-auto text-[10.5px] text-muted-foreground nums shrink-0">{fmtDate(e.date)}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {/* the palette RUNS navigation, it does not only search: every view the
            `g <letter>` keys reach is here too, with its chord shown */}
        {onGo && (
          <CommandGroup heading="Go to">
            {GO_ORDER.map((k) => {
              const view = VIEW_KEYS[k];
              return (
                <CommandItem key={"go-" + k} value={"go " + view + " " + VIEW_LABEL[view]}
                  onSelect={() => { onGo(view); setOpen(false); }}>
                  <ArrowRight size={14} className="mr-2 opacity-60" />
                  <span className="truncate">{VIEW_LABEL[view]}</span>
                  <span className="ml-auto shrink-0 text-[10.5px] text-muted-foreground nums">g {k}</span>
                </CommandItem>
              );
            })}
          </CommandGroup>
        )}

        <CommandGroup heading="Editor for e">
          {(["obsidian", "nvim"] as EditorChoice[]).map((k) => (
            <CommandItem key={"editor-" + k} value={"editor setting e opens in " + EDITOR_LABEL[k]}
              onSelect={() => { setEditorChoice(k); toast("e opens in " + EDITOR_LABEL[k]); setOpen(false); }}>
              <SquarePen size={14} className="mr-2 opacity-60" />
              <span className="truncate">Open with e in {EDITOR_LABEL[k]}</span>
              {editor === k && <Check size={14} aria-label="current" className="ml-auto shrink-0 text-primary" />}
            </CommandItem>
          ))}
        </CommandGroup>

        {/* boards stay searchable in both modes (cmdk fuzzy-filters by value) */}
        <CommandGroup heading="Boards">
          <CommandItem value="board planning"
            onSelect={() => { onPick({ name: "Planning", path: TASKS_BOARD, done: 0, open: 0 }); setOpen(false); }}>
            <LayoutGrid size={14} className="mr-2" /> Planning
          </CommandItem>
          {papers.map((p) => (
            <CommandItem key={p.path} value={"board " + p.name} onSelect={() => { onPick(p); setOpen(false); }}>
              <FileText size={14} className="mr-2 opacity-60" /> <span className="capitalize truncate">{p.name}</span>
              {p.open > 0 && <span className="ml-auto text-[11px] text-muted-foreground nums shrink-0">{p.open} open</span>}
            </CommandItem>
          ))}
        </CommandGroup>

        {/* ---------------- idle mode ---------------- */}
        {!searching && today && today.eventsToday.length > 0 && (
          <CommandGroup heading="Today's calendar">
            {today.eventsToday.map((e) => (
              <CommandItem key={e.path} value={"today-event " + e.title} onSelect={() => { openNote(e.path, e.title); setOpen(false); }}>
                <span className="mr-2 w-2 h-2 rounded-full" style={{ background: categoryColor(e.category) }} />
                <span className="truncate">{e.title}</span>
                <span className="ml-auto text-[10.5px] text-muted-foreground nums shrink-0">{e.allDay ? "all day" : fmtTime(e.startTime)}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {!searching && recent.length > 0 && (
          <CommandGroup heading="Recently edited boards">
            {recent.slice(0, 4).map((r) => (
              <CommandItem key={r.path} value={"recent " + r.name}
                onSelect={() => { onPick({ name: r.name, path: r.path, done: 0, open: r.open }); setOpen(false); }}>
                <FileText size={14} className="mr-2 opacity-60" />
                <span className="capitalize truncate">{r.name}</span>
                {r.open > 0 && <span className="ml-auto text-[10.5px] text-muted-foreground nums shrink-0">{r.open} open</span>}
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {!searching && (
          <CommandGroup heading="Jump to daily note">
            {[0, -1, -2, 1].map((off) => {
              const d = new Date(); d.setDate(d.getDate() + off);
              const iso = d.toISOString().slice(0, 10);
              const lbl = off === 0 ? "Today" : off === -1 ? "Yesterday" : off === 1 ? "Tomorrow" : fmtDateLong(iso);
              return (
                <CommandItem key={iso} value={"daily " + iso}
                  onSelect={() => { openNote("Preparation/Notes/Daily/" + iso + ".md", lbl); setOpen(false); }}>
                  <Sun size={14} className="mr-2 opacity-60" /> {lbl}
                  <span className="ml-auto text-[10.5px] text-muted-foreground nums shrink-0">{fmtDate(iso)}</span>
                </CommandItem>
              );
            })}
          </CommandGroup>
        )}

        {!searching && (
          <CommandGroup heading="Open in Obsidian">
            <CommandItem value="open planning" onSelect={() => { openNote(TASKS_BOARD, "Planning"); setOpen(false); }}>
              <ExternalLink size={14} className="mr-2" /> Tasks.md
            </CommandItem>
            {papers.slice(0, 12).map((p) => (
              <CommandItem key={p.path + "-o"} value={"open " + p.name}
                onSelect={() => { openNote(paperDir(p.path) + "/README.md", titleCase(p.name)); setOpen(false); }}>
                <ExternalLink size={14} className="mr-2 opacity-60" /> <span className="capitalize truncate">{p.name}</span> README
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
      <div className="border-t border-border px-3 py-1.5 flex items-center justify-between text-[10.5px] text-muted-foreground bg-card/40">
        <span className="flex items-center gap-2">
          {searching
            ? <><Hash size={11} /> {hits.length + citations.length + eventHits.length} matches across cards · library · events</>
            : <><Calendar size={11} /> {today?.today}</>}
        </span>
        <span className="flex items-center gap-3 nums">
          <span><kbd className="text-[10px] bg-secondary px-1 py-0.5 rounded">↑↓</kbd> navigate</span>
          <span><kbd className="text-[10px] bg-secondary px-1 py-0.5 rounded">↵</kbd> open</span>
          <span><kbd className="text-[10px] bg-secondary px-1 py-0.5 rounded">esc</kbd> close</span>
        </span>
      </div>
    </CommandDialog>
  );
}
