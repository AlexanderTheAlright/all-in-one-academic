
import { useMemo, useState } from "react";
import { Inbox, BookMarked } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { WidgetFrame, useWidget, rowCap } from "@/components/ui/widget";
import { openWidgetFocus } from "@/lib/arrownav";
import { api } from "@/lib/api";
import type { Cache, Item } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { PRIMARY_SOURCES_DIR } from "@/lib/paths";
import { RefreshChip } from "@/components/RefreshChip";
import { CopyNoteLink, citePath } from "@/components/CopyNoteLink";
import { InboxTriage } from "@/components/InboxTriage";
import { PrintBookHost, openPrintBook } from "@/components/PrintBook";

export function Library({ cache, onRefresh }: { cache: Cache; onRefresh: () => Promise<void> }) {
  const vaultPath = useApi(() => api.vaultPath(), [], 3_600_000).data?.vaultPath;
  // the Reading Inbox backlog — downloaded PDFs waiting to be named + filed to Corpus
  const inbox = useApi(() => api.readingInbox(), [], 120_000);
  const [triage, setTriage] = useState(false);
  const inboxCount = inbox.data?.count ?? 0;

  return (
    <div>
      <header className="mb-5 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <h1 className="text-[26px] font-semibold tracking-tight">Library</h1>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setTriage(true)}
            title="Step through the Reading Inbox one PDF at a time — rename to convention and file into the Corpus">
            <Inbox size={14} className="mr-1.5" /> File inbox{inboxCount > 0 ? ` · ${inboxCount}` : ""}
          </Button>
          <Button variant="outline" size="sm" onClick={() => openPrintBook()}
            title="Take notes from a book you own in print">
            <BookMarked size={14} className="mr-1.5" /> Print book
          </Button>
          <RefreshChip generated={cache.generated} onRefresh={onRefresh} />
        </div>
      </header>
      {triage && <InboxTriage onClose={() => { setTriage(false); inbox.reload(); }} />}
      <PrintBookHost />
      <WidgetFrame id="library.results" title="Sources">
        <LibraryResults cache={cache} vaultPath={vaultPath} />
      </WidgetFrame>
    </div>
  );
}

function LibraryResults({ cache, vaultPath }: { cache: Cache; vaultPath?: string }) {
  const w = useWidget();
  const focused = !!w?.focused;
  const size = w?.size ?? "lg";
  const [q, setQ] = useState("");
  // until a status chip is picked, the tile leads with what is still unread and the focused view searches everything
  const [pick, setPick] = useState<string | null>(null);
  const status = pick ?? (focused ? "all" : "unread");
  const [type, setType] = useState("all");
  // literature corpus vs the historical primary-source lane; a missing collection is literature
  const [collection, setCollection] = useState("all");
  const [sort, setSort] = useState("recent");
  const [more, setMore] = useState(0);

  const rows = useMemo(() => {
    // tokenized AND-match across title, author, tags, type and year, so a bare tag
    // or a mix like "burnout 2020" both narrow the list.
    const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
    let r = cache.items.filter((it) => {
      if (status !== "all" && it.status !== status) return false;
      if (type !== "all" && it.type !== type) return false;
      if (collection !== "all" && (it.collection || "literature") !== collection) return false;
      if (tokens.length) {
        const hay = `${it.name} ${it.author} ${it.tags.join(" ")} ${it.type} ${it.year ?? ""}`.toLowerCase();
        if (!tokens.every((t) => hay.includes(t))) return false;
      }
      return true;
    });
    if (sort === "year") r = [...r].sort((a, b) => (b.year || 0) - (a.year || 0));
    else if (sort === "rating") r = [...r].sort((a, b) => (b.rating || 0) - (a.rating || 0));
    else if (sort === "title") r = [...r].sort((a, b) => a.name.localeCompare(b.name));
    else r = [...r].reverse();
    return r;
  }, [cache.items, q, status, type, collection, sort]);

  const types = ["all", ...cache.types.map((t) => t[0]).slice(0, 6)];
  const fold = size === "xs" || size === "sm" || size === "md";
  const k = cache.kpi;
  // columns by the widget's own width; a focused view on a wide screen takes three
  const cols = size === "xl" ? (focused ? 3 : 2) : size === "lg" ? 2 : 1;
  const page = focused ? 20 * cols : rowCap(w, 8, 16);
  const limit = page + more;
  const reset = () => setMore(0);

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
      <p className="text-muted-foreground text-sm nums">
        {k.total.toLocaleString()} sources · {k.read.toLocaleString()} read · {(k.total - k.read).toLocaleString()} unread · {(k.total - k.withPdf).toLocaleString()} missing PDFs
      </p>
      <Input value={q} onChange={(e) => { setQ(e.target.value); reset(); }}
        placeholder="Search title, author, or tag…" />
      {/* under 900px the type chips fold into one dropdown and the sort chips join the filter row,
        * so the results start high in a quarter tile */}
      <div className="flex flex-wrap items-center gap-1.5">
        <Chips options={["all", "read", "unread"]} value={status} onChange={(v) => { setPick(v); reset(); }} />
        <span className="w-px h-5 bg-border mx-1.5" />
        <Chips options={[["all", "all"], ["literature", "literature"], ["historical", "archive"]]} value={collection}
          onChange={(v) => { setCollection(v); reset(); }} titles={COLLECTION_TIPS} qa="library-collection" />
        <span className="w-px h-5 bg-border mx-1.5" />
        {fold ? (
          <select value={type} onChange={(e) => { setType(e.target.value); reset(); }} title="Filter by source type"
            className={`text-[12px] pl-3 pr-2 py-1 rounded-full border bg-background cursor-pointer focus:outline-none focus:border-primary/60 transition-colors ${type !== "all" ? "border-primary text-foreground" : "border-border text-muted-foreground hover:text-foreground hover:border-primary/60"}`}>
            {types.map((t) => <option key={t} value={t}>{t === "all" ? "all types" : t}</option>)}
          </select>
        ) : (
          <Chips options={types} value={type} onChange={(v) => { setType(v); reset(); }} />
        )}
        {fold && <SortRow sort={sort} setSort={setSort} count={rows.length} folded />}
      </div>
      {/* the count rides the sort row, which wraps rather than pushing past the widget */}
      {!fold && <SortRow sort={sort} setSort={setSort} count={rows.length} />}
      <div className={`grid gap-x-10 ${cols === 3 ? "grid-cols-3" : cols === 2 ? "grid-cols-2" : "grid-cols-1"}`}>
        {rows.slice(0, limit).map((it) => (
          <SourceRow key={it.name} it={it} vaultPath={vaultPath} detail={focused} tags={size !== "xs"} />
        ))}
      </div>
      {limit < rows.length && (
        <Button variant="outline" className="w-full mt-1" onClick={(e) => { if (!openWidgetFocus(e.currentTarget)) setMore(more + (focused ? 20 * cols : 40)); }}>
          Show more ({(rows.length - limit).toLocaleString()} hidden)
        </Button>
      )}
    </div>
  );
}

function SortRow({ sort, setSort, count, folded }: { sort: string; setSort: (v: string) => void; count: number; folded?: boolean }) {
  const body = (
    <>
      {folded && <span className="w-px h-5 bg-border mx-1.5" />}
      <span className="text-[11px] text-muted-foreground mr-1">sort</span>
      <Chips options={[["recent", "recent"], ["year", "newest"], ["rating", "top rated"], ["title", "A–Z"]]} value={sort} onChange={setSort} />
      <span className="ml-auto pl-2 text-[12px] text-muted-foreground nums whitespace-nowrap">{count.toLocaleString()} shown</span>
    </>
  );
  return folded ? body : <div className="flex flex-wrap items-center gap-1.5">{body}</div>;
}

function SourceRow({ it, vaultPath, detail, tags }: { it: Item; vaultPath?: string; detail: boolean; tags: boolean }) {
  const meta = [it.author, it.type, it.rating ? `${it.rating}★` : ""].filter(Boolean).join(" · ");
  return (
    <div className="w-full min-w-0 flex items-start gap-3 py-3 border-b border-border group">
      <button onClick={() => api.open(citePath(it.name, it.collection))} data-library-row={it.collection || "literature"}
        className="text-left flex items-start gap-3 min-w-0 flex-1">
        <span className="mt-1.5 h-2 w-2 rounded-full shrink-0"
          style={{ background: it.status === "read" ? "hsl(var(--primary))" : "transparent",
                   border: it.status === "read" ? "none" : "1.5px solid hsl(var(--muted-foreground))" }} />
        <span className="min-w-0 flex-1">
          <span className="block text-[14px] leading-snug break-words group-hover:text-primary transition-colors">{it.name}</span>
          {detail && meta && <span className="block mt-0.5 text-[11.5px] text-muted-foreground truncate" title={meta}>{meta}</span>}
          {tags && it.tags.length > 0 && (
            <span className="flex flex-wrap gap-1.5 mt-1">
              {it.tags.slice(0, detail ? 8 : 4).map((t) =>
                <span key={t} className="text-[10px] text-muted-foreground bg-secondary px-1.5 py-0.5 rounded">{t}</span>
              )}
            </span>
          )}
        </span>
      </button>
      <span className="text-[12px] text-muted-foreground nums shrink-0 mt-0.5">{it.year || "—"}</span>
      <CopyNoteLink citationName={it.name} vaultPath={vaultPath} collection={it.collection} className="mt-0.5" />
    </div>
  );
}

const COLLECTION_TIPS: Record<string, string> = {
  all: "Literature and archive sources together",
  literature: "The literature corpus (Preparation/Reading/Citations)",
  historical: `Primary sources (${PRIMARY_SOURCES_DIR})`,
};

function Chips({ options, value, onChange, titles, qa }:
{ options: (string | [string, string])[]; value: string; onChange: (v: string) => void; titles?: Record<string, string>; qa?: string }) {
  return <>{options.map((o) => {
    const [val, label] = Array.isArray(o) ? o : [o, o]; const on = value === val;
    return (
      <button key={val} onClick={() => onChange(val)} title={titles?.[val]} data-qa={qa ? `${qa}-${val}` : undefined}
        className={`text-[12px] px-3 py-1 rounded-full border transition-colors ${on ? "bg-primary border-primary text-primary-foreground" : "border-border text-muted-foreground hover:text-foreground hover:border-primary/60"}`}>
        {label}
      </button>
    );
  })}</>;
}
