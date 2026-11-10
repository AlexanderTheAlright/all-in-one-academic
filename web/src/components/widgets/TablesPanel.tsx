
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, FileType2, Image, Table2 } from "lucide-react";
import { panelApi, type PanelTable, type PanelTableCard, type PanelTableGroup } from "@/lib/api";
import { ago, nfmt, type PaneSize } from "@/components/widgets/panel";
import { PanelEmpty, PanelHeader, useBracketStep, useHomeEnd, useLeftToTabs,
  type PanelChromeProps } from "@/components/widgets/PanelChrome";

const GROUPS: { key: PanelTableGroup; label: string }[] = [
  { key: "results", label: "Results" },
  { key: "supplementary", label: "Supplementary" },
  { key: "output", label: "Output" },
  { key: "pushed", label: "Pushed" },
];

const TAB_NO = /^(tab\.\d+\.)(.*)$/;

const TRACK: Record<PaneSize, number> = { xs: 104, sm: 104, md: 168, lg: 232, xl: 300 };

export function TablesPanel({ chrome, slug, project, session, size, right, openName, onOpened, onCount }: {
  chrome: PanelChromeProps;
  slug: string;
  /** the project's own name, so the header reads the same as the Figures tab's */
  project?: string;
  session: string;
  size: PaneSize;
  right?: React.ReactNode;
  /** a table event asks for this one to be standing open */
  openName?: string | null;
  onOpened?: () => void;
  /** how many tables this project has, for the tab's count */
  onCount?: (n: number) => void;
}) {
  const [list, setList] = useState<PanelTableCard[] | null>(null);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const restore = useRef<string | null>(null);
  const body = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!slug) { setList([]); return; }
    let live = true, stamp = "";
    const pull = () => {
      panelApi.tables(slug, session).then((r) => {
        if (!live) return;
        setErr(r.ok ? "" : r.error || "no tables");
        if (!r.stamp || r.stamp !== stamp) { stamp = r.stamp; setList(r.tables); }
      }).catch(() => { if (live) { setErr("couldn't read the tables"); setList([]); } });
    };
    pull();
    const t = window.setInterval(pull, 4000);
    window.addEventListener("focus", pull);
    return () => { live = false; window.clearInterval(t); window.removeEventListener("focus", pull); };
  }, [slug, session]);

  // a table event names the one to stand in. Taken once per name, so the callback that
  // clears it upstream cannot loop back through this effect.
  const took = useRef("");
  const onOpenedRef = useRef(onOpened);
  onOpenedRef.current = onOpened;
  useEffect(() => {
    if (!openName || took.current === openName) return;
    took.current = openName;
    restore.current = openName;
    setOpen(openName);
    onOpenedRef.current?.();
  }, [openName]);

  const rows = useMemo(() => list ?? [], [list]);
  useEffect(() => { onCount?.(rows.length); }, [rows.length, onCount]);
  const openCard = useCallback((name: string) => { restore.current = name; setOpen(name); }, []);
  const back = useCallback(() => setOpen(null), []);

  useEffect(() => {
    if (open || !restore.current) return;
    const el = body.current?.querySelector<HTMLElement>(`[data-table-card="${CSS.escape(restore.current)}"]`);
    if (el) { document.documentElement.setAttribute("data-knav", ""); el.focus({ preventScroll: false }); }
    restore.current = null;
  }, [open]);

  const at = open ? rows.findIndex((t) => t.name === open) : -1;
  const step = useCallback((d: -1 | 1) => {
    const n = rows[at + d];
    if (at >= 0 && n) { restore.current = n.name; setOpen(n.name); }
  }, [at, rows]);
  useBracketStep(open ? step : null);
  useHomeEnd("[data-table-card]");
  useLeftToTabs();

  const cur = open ? rows.find((t) => t.name === open) || null : null;

  return (
    <div data-panel="tables" data-size={size} className="h-screen flex flex-col bg-background text-foreground">
      <PanelHeader {...chrome} title={project || slug || "Tables"} titleHint={cur?.rel || slug} right={right} />
      <div ref={body} data-panel-body className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {cur ? (
          <TableDetail slug={slug} card={cur} onBack={back} size={size} />
        ) : list === null ? (
          <PanelEmpty>Reading the project</PanelEmpty>
        ) : !rows.length ? (
          <PanelEmpty>{err || (slug ? slug + " — no tables yet" : "No project for this pane")}</PanelEmpty>
        ) : GROUPS.map(({ key, label }) => {
          const group = rows.filter((t) => t.group === key);
          if (!group.length) return null;
          return (
            <section key={key}>
              <div className="sticky top-0 z-10 flex items-center gap-1.5 bg-background pt-1.5 pb-1">
                <span className="text-[9px] font-medium uppercase tracking-[0.08em] text-muted-foreground">{label}</span>
                <span className="h-px flex-1 bg-border/70" />
                <span className="nums text-[9px] text-muted-foreground">{group.length}</span>
              </div>
              <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${TRACK[size]}px, 1fr))` }}>
                {group.map((t) => <TableCard key={t.rel || t.name} t={t} size={size} onOpen={() => openCard(t.name)} />)}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function TableCard({ t, size, onOpen }: { t: PanelTableCard; size: PaneSize; onOpen: () => void }) {
  const m = TAB_NO.exec(t.name);
  const meta = size !== "xs" && size !== "sm";
  return (
    <button type="button" data-knav-item data-table-card={t.name} onClick={onOpen} aria-label={t.name}
      title={[t.name, nfmt(t.rows) + " × " + nfmt(t.cols), ago(t.mtime), t.hasPdf ? "typeset" : ""].filter(Boolean).join(" · ")}
      className="relative flex flex-col overflow-hidden rounded-md border border-border/60 bg-card/40 px-1.5 py-1 text-left outline-none
                 transition-transform hover:border-primary/50 focus-visible:-translate-y-px focus-visible:border-primary/70
                 focus-visible:shadow-pop focus-visible:ring-1 focus-visible:ring-primary/60">
      <span className="flex items-center gap-1">
        <Table2 size={11} className="shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-[9.5px] leading-[1.4] text-muted-foreground">
          {m ? <><span className="font-semibold text-foreground/80">{m[1]}</span>{m[2]}</> : t.name}
        </span>
        {t.hasPdf && <FileType2 size={10} className="shrink-0 text-primary" aria-hidden />}
      </span>
      <span className="nums mt-0.5 truncate text-[9px] text-muted-foreground">
        {nfmt(t.rows)} × {nfmt(t.cols)}{meta && t.mtime ? " · " + ago(t.mtime) : ""}
      </span>
    </button>
  );
}

/* ------------------------------------------------------------------- one table */

function TableDetail({ slug, card, onBack, size }: { slug: string; card: PanelTableCard; onBack: () => void; size: PaneSize }) {
  const [t, setT] = useState<PanelTable | null>(null);
  const [err, setErr] = useState("");
  const [grid, setGrid] = useState(false);
  /* The card that opened this is gone: stand on the back mark so the engine's Escape
   * has something to rise from, instead of the keys falling to the body. */
  const backRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    document.documentElement.setAttribute("data-knav", "");
    backRef.current?.focus({ preventScroll: true });
  }, [card.name]);

  useEffect(() => {
    let live = true;
    setT(null); setErr(""); setGrid(false);
    panelApi.table({ slug, name: card.name, id: card.id || undefined })
      .then((r) => { if (!live) return; if (r.ok) setT(r); else setErr(r.error || "that table didn't answer"); })
      .catch(() => { if (live) setErr("that table didn't answer"); });
    return () => { live = false; };
  }, [slug, card.name, card.id]);

  const showPng = !!t?.png && !grid;
  const spanners = useMemo(() => {
    const cols = t?.columns ?? [];
    if (!cols.some((c) => c.group)) return null;
    const out: { label: string | null; n: number }[] = [];
    for (const c of cols) {
      const last = out[out.length - 1];
      if (last && last.label === (c.group || null)) last.n++;
      else out.push({ label: c.group || null, n: 1 });
    }
    return out;
  }, [t]);

  return (
    <div data-table-detail={card.name} className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1.5 py-1">
        <button ref={backRef} type="button" data-knav-back="2" data-qa="table-back" onClick={onBack} title="Back to the tables (Esc)"
          className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground outline-none hover:bg-accent hover:text-foreground">
          <ArrowLeft size={12} />
        </button>
        <span className="min-w-0 flex-1 truncate text-[10.5px] font-medium" title={t?.title || card.name}>{t?.title || card.name}</span>
        {t?.truncated && (
          <span data-table-truncated className="shrink-0 rounded-full bg-muted px-1 text-[8.5px] leading-[13px] text-muted-foreground"
            title="The grid shows the first rows and columns only">truncated</span>
        )}
        {t?.png && (
          <button type="button" data-knav-item data-qa="table-toggle" onClick={() => setGrid((g) => !g)}
            title={showPng ? "Grid" : "Typeset"}
            className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground outline-none hover:bg-accent hover:text-foreground">
            {showPng ? <Table2 size={12} /> : <Image size={12} />}
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {err ? <PanelEmpty>{err}</PanelEmpty>
          : !t ? <PanelEmpty>Reading the table</PanelEmpty>
          : showPng ? (
            <div data-table-png className="tinybar h-full overflow-auto rounded-md bg-white p-1">
              <img src={t.png || ""} alt={t.title || card.name} className="mx-auto block max-w-full" />
            </div>
          ) : !t.columns.length && !t.rows.length ? <PanelEmpty>That table is empty</PanelEmpty>
          : (
            
            <div data-table-grid className="tinybar h-full overflow-auto">
              <div className="mx-auto w-full max-w-[1180px]">
                <table className="w-full border-collapse text-left" style={{ fontSize: size === "xs" || size === "sm" ? "9.5px" : "10.5px" }}>
                  <thead>
                    {spanners && (
                      <tr data-table-spanners>
                        <th className="sticky left-0 top-0 z-30 bg-background" />
                        {spanners.map((s, i) => (
                          <th key={i} colSpan={s.n}
                            className="sticky top-0 z-20 bg-background px-1.5 pb-[3px] align-bottom text-center text-[9px] font-medium text-muted-foreground">
                            {s.label ? (
                              <>
                                <span className="block leading-[1.35]">{s.label}</span>
                                <span data-table-cmidrule className="mx-[7px] mt-[2px] block h-px bg-border" />
                              </>
                            ) : null}
                          </th>
                        ))}
                      </tr>
                    )}
                    <tr>
                      <th data-table-stub-head className="sticky left-0 top-0 z-30 border-y-2 border-border bg-background px-1.5 py-1 text-left font-medium whitespace-nowrap">
                        {t.stubLabel}
                      </th>
                      {t.columns.map((c) => (
                        <th key={c.key} className="sticky top-0 z-20 border-y-2 border-border bg-background px-1.5 py-1 text-right font-medium whitespace-nowrap">
                          {c.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {t.rows.map((r, i) => {
                      const panel = r.kind === "panel";
                      const sub = r.kind === "sub";
                      return (
                        <tr key={i} data-table-row={r.kind}>
                          <th scope="row"
                            className={"sticky left-0 z-10 bg-background text-left font-normal whitespace-nowrap "
                              + (panel ? "pt-2 pb-[2px] font-semibold text-foreground" : sub ? "py-0 text-muted-foreground" : "py-[3px] text-foreground")}
                            style={{ paddingLeft: 6 + r.level * 10, paddingRight: 10 }}>
                            {r.stub}
                          </th>
                          {t.columns.map((c, ci) => (
                            <td key={c.key}
                              className={"nums px-1.5 text-right whitespace-nowrap "
                                + (panel ? "pt-2 pb-[2px] font-semibold" : sub ? "py-0 text-muted-foreground" : "py-[3px]")}>
                              {r.cells[ci] ?? ""}
                            </td>
                          ))}
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr><td className="border-t-2 border-border p-0" colSpan={t.columns.length + 1} /></tr>
                  </tfoot>
                </table>
                {t.notes.length > 0 && (
                  <div data-table-notes className="pt-1 text-[9px] leading-[1.45] text-muted-foreground">
                    {t.notes.map((n, i) => <p key={i}>{n}</p>)}
                  </div>
                )}
              </div>
            </div>
          )}
      </div>
    </div>
  );
}
