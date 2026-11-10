
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, BarChart3, BookOpen, Bot, Check, EyeOff, RotateCcw, Search, StickyNote, X } from "lucide-react";
import { stripProjectPrefix } from "@/lib/paths";
import { CODING_NOTE_MAX, codingApi, type CodingFilter, type CodingRow, type CodingSet, type CodingSetCard } from "@/lib/api";
import { paneRecall, paneRemember, nfmt, useRememberedSearch, type PaneSize } from "@/components/widgets/panel";
import { PanelEmpty, PanelHeader, useHomeEnd, useLeftToTabs, type PanelChromeProps } from "@/components/widgets/PanelChrome";
import { CodingUnitView, codeName } from "@/components/widgets/CodingPanelUnit";
import { CodingAgreementView, type AgreePick } from "@/components/widgets/CodingPanelAgreement";
import { CodebookDrawer } from "@/components/widgets/CodingPanelCodebook";
import { MemoLine, useCodebookDraft } from "@/components/widgets/CodingPanelCodebookEdit";

export type CodingOpen = { seq: number; project: string; set: string; unit: string } | null;

type Where = { project: string; set: string };
type Mode = "sets" | "queue" | "unit" | "agreement";

const FILTERS: { id: CodingFilter; label: string; count: keyof CodingSet["counts"]; hint: string }[] = [
  { id: "todo", label: "To code", count: "todo", hint: "Not marked done" },
  { id: "coded", label: "Coded", count: "done", hint: "Marked done" },
  { id: "disagree", label: "Disagree", count: "disagree", hint: "You and a coder differ on a code" },
  { id: "reviewed", label: "Reviewed", count: "reviewed", hint: "Has a review, yours or an agent's" },
  { id: "noted", label: "Noted", count: "noted", hint: "Has your note" },
  // drawn only once a promoted codebook has touched a done unit
  { id: "revisit", label: "Revisit", count: "revisit", hint: "Coded before a codebook change that touches them" },
];

const ROOMY = 800;
const TWO_COL = 1000;
function useRoomy(): { roomy: boolean; twoCol: boolean } {
  const read = () => ({ roomy: window.innerWidth >= ROOMY, twoCol: window.innerWidth >= TWO_COL });
  const [r, setR] = useState(read);
  useEffect(() => {
    const f = () => setR((cur) => { const n = read(); return n.roomy === cur.roomy && n.twoCol === cur.twoCol ? cur : n; });
    window.addEventListener("resize", f);
    return () => window.removeEventListener("resize", f);
  }, []);
  return r;
}

const memoKey = (project: string) => "coding." + (project || "*");
type Memo = { project: string; set: string; unit: string };
const isMemo = (v: unknown): v is Memo => {
  const m = v as Record<string, unknown> | null;
  return !!m && typeof m === "object" && ["project", "set", "unit"].every((k) => typeof m[k] === "string");
};

function focusSel(root: ParentNode | null | undefined, sel: string): boolean {
  const el = root?.querySelector<HTMLElement>(sel);
  if (!el) return false;
  document.documentElement.setAttribute("data-knav", "");
  el.focus({ preventScroll: false });
  return true;
}

export function CodingPanel({ chrome, project, size, open, right }: {
  chrome: PanelChromeProps;
  /** the pane's project (its ?project=); empty lists every project's sets */
  project: string;
  size: PaneSize;
  /** a coding event asks for this set, and maybe this unit */
  open: CodingOpen;
  right?: React.ReactNode;
}) {
  const memo = useMemo(() => paneRecall<Memo>(memoKey(project), isMemo), [project]);
  const [where, setWhere] = useState<Where | null>(() => (memo && memo.set ? { project: memo.project, set: memo.set } : null));
  const [mode, setMode] = useState<Mode>(() => (memo && memo.set ? "queue" : "sets"));
  const [unit, setUnit] = useState<{ id: string; ids: string[]; from: "queue" | "agreement" } | null>(null);
  const [drawer, setDrawer] = useState<string | null>(null);
  const [agreePick, setAgreePick] = useState<AgreePick | null>(null);
  const [agreeBack, setAgreeBack] = useState<string | null>(null);
  const [sets, setSets] = useState<CodingSetCard[] | null>(null);
  const [setsErr, setSetsErr] = useState("");
  const [data, setData] = useState<CodingSet | null>(null);
  const [rows, setRows] = useState<CodingRow[]>([]);
  const [err, setErr] = useState("");
  const [filter, setFilter] = useState<CodingFilter>("");
  const [q, setQ] = useRememberedSearch("coding");
  const restore = useRef<string | null>(memo?.unit || null);
  const body = useRef<HTMLDivElement>(null);
  const tick = useRef(0);
  const { roomy, twoCol } = useRoomy();
  // the units already done, so ⏎ in a unit skips to the next one that is not
  const [doneIds, setDoneIds] = useState<string[] | null>(null);
  const inUnit = mode === "unit";
  useEffect(() => {
    if (!where || !inUnit) return;
    let live = true;
    void codingApi.set({ project: where.project, set: where.set, filter: "coded", limit: 1 })
      .then((d) => { if (live && d.ok) setDoneIds(d.ids); }).catch(() => null);
    return () => { live = false; };
  }, [where, inUnit]);

  // the sets: read on mount, on focus, and whenever the level comes back to them
  useEffect(() => {
    let live = true;
    const pull = () => codingApi.sets(project).then((r) => {
      if (!live) return;
      setSetsErr(r.ok ? "" : r.error || "the sets didn't answer");
      setSets(r.sets);
    }).catch(() => { if (live) { setSetsErr("the sets didn't answer"); setSets([]); } });
    void pull();
    window.addEventListener("focus", pull);
    return () => { live = false; window.removeEventListener("focus", pull); };
  }, [project, mode === "sets"]);  // eslint-disable-line react-hooks/exhaustive-deps

  const readQueue = useCallback((keepRows = false) => {
    if (!where) return Promise.resolve();
    const my = ++tick.current;
    return codingApi.set({ project: where.project, set: where.set, filter, q }).then((d) => {
      if (my !== tick.current) return;
      setErr(d.ok ? "" : d.error || "that set didn't answer");
      if (!d.ok) {
        setData(null); setRows([]);
        if (/^set: .* is missing$/.test(d.error || "")) { setErr(""); setUnit(null); setWhere(null); setMode("sets"); }
        return;
      }
      setData((cur) => (cur && cur.stamp === d.stamp && cur.ids.length === d.ids.length
        && cur.set.codebookVersion === d.set.codebookVersion && cur.counts.revisit === d.counts.revisit
        && cur.ids.every((x, i) => x === d.ids[i]) ? cur : d));
      setRows((cur) => (keepRows && cur.length > d.rows.length && d.rows.every((r, i) => cur[i]?.id === r.id)
        ? [...d.rows, ...cur.slice(d.rows.length)] : d.rows));
    }).catch(() => { if (my === tick.current) setErr("that set didn't answer"); });
  }, [where, filter, q]);

  useEffect(() => {
    if (!where || (mode !== "queue" && mode !== "unit" && mode !== "agreement")) return;
    void readQueue(false);
    if (mode !== "queue") return;
    const t = window.setInterval(() => { void readQueue(true); }, 5000);
    const f = () => { void readQueue(true); };
    window.addEventListener("focus", f);
    return () => { window.clearInterval(t); window.removeEventListener("focus", f); };
  }, [where, mode, readQueue]);

  const more = useCallback(() => {
    if (!where || !data || rows.length >= data.ids.length) return;
    void codingApi.set({ project: where.project, set: where.set, filter, q, offset: rows.length }).then((d) => {
      if (d.ok) setRows((cur) => [...cur, ...d.rows.filter((r) => !cur.some((c) => c.id === r.id))]);
    });
  }, [where, data, rows.length, filter, q]);

  // a remembered set the server no longer lists (its manifest cannot be opened): back to the sets
  useEffect(() => {
    if (!where || !sets || !err || data || mode === "sets") return;
    if (sets.some((s) => s.project === where.project && s.id === where.set)) return;
    setErr(""); setUnit(null); setWhere(null); setMode("sets");
  }, [where, sets, err, data, mode]);

  useEffect(() => {
    if (!where) { paneRemember(memoKey(project), { project: "", set: "", unit: "" }); return; }
    paneRemember(memoKey(project), { project: where.project, set: where.set, unit: unit?.id || restore.current || "" });
  }, [project, where, unit]);

  // a coding event: open the set, and the unit when it names one
  const took = useRef(0);
  useEffect(() => {
    if (!open || open.seq <= took.current) return;
    took.current = open.seq;
    setWhere({ project: open.project, set: open.set });
    setFilter("");
    setDrawer(null);
    if (open.unit) {
      setUnit({ id: open.unit, ids: [], from: "queue" });
      setMode("unit");
    } else {
      setUnit(null);
      setMode("queue");
    }
  }, [open]);

  // a unit opened by an event has no order to step through yet: the set's own order
  useEffect(() => {
    if (mode === "unit" && unit && !unit.ids.length && data?.ids.length && data.set.id === where?.set) {
      setUnit((u) => (u && !u.ids.length ? { ...u, ids: data.ids.includes(u.id) ? data.ids : [u.id, ...data.ids] } : u));
    }
  }, [mode, unit, data, where]);

  // Esc back to a list lands on the row it left, never on the top of the list
  useEffect(() => {
    if (mode === "queue" && restore.current === "@agreement") {
      if (focusSel(document, "[data-qa='coding-agreement']")) restore.current = null;
    } else if (mode === "queue" && restore.current && rows.length) {
      // a row past the first page is simply not stood on; the next pages never steal the focus
      focusSel(body.current, `[data-coding-row="${CSS.escape(restore.current)}"]`);
      restore.current = null;
    }
    if (mode === "sets" && where === null && restore.current?.startsWith("set:")) {
      if (focusSel(body.current, `[data-coding-set="${CSS.escape(restore.current.slice(4))}"]`)) restore.current = null;
    }
  }, [mode, rows, where, sets]);

  const openSet = (s: CodingSetCard) => {
    setWhere({ project: s.project, set: s.id });
    setFilter("");
    setRows([]);
    setData(null);
    restore.current = null;
    setMode("queue");
  };
  const backToSets = () => {
    restore.current = where ? "set:" + where.project + "/" + where.set : null;
    setWhere(null);
    setData(null);
    setRows([]);
    setMode("sets");
  };
  const openUnit = (id: string, ids: string[], from: "queue" | "agreement") => {
    restore.current = id;
    setUnit({ id, ids, from });
    setMode("unit");
    // a search found the unit; [ ] then walk the whole queue (its filter, not the search)
    if (from === "queue" && q && where) {
      void codingApi.set({ project: where.project, set: where.set, filter, q: "", limit: 1 }).then((d) => {
        if (d.ok && d.ids.includes(id)) setUnit((u) => (u && u.ids === ids ? { ...u, ids: d.ids } : u));
      }).catch(() => { /* the search's order still steps */ });
    }
  };
  const backFromUnit = () => {
    const from = unit?.from || "queue";
    restore.current = from === "queue" ? unit?.id || null : null;
    setAgreeBack(from === "agreement" ? unit?.id || null : null);
    setUnit(null);
    setMode(from);
    // the last save may still be on the wire; the queue asks again once it has landed
    window.setTimeout(() => { void readQueue(false); }, 400);
  };

  useLeftToTabs();
  useHomeEnd(mode === "sets" ? "[data-coding-set]" : mode === "queue" ? "[data-coding-row]" : "[data-coding-none]");

  const title = where ? (data?.set.title || where.set) : "Coding";
  const codebook = useMemo(() => data?.codebook ?? [], [data]);

  // the codebook's draft and its save queue
  const unitFlush = useRef<(() => Promise<void>) | null>(null);
  const [editReq, setEditReq] = useState<{ seq: number; code: string } | null>(null);
  const [memoOpen, setMemoOpen] = useState(false);
  const book = useCodebookDraft({ project: where?.project || "", set: where?.set || "",
    unitId: mode === "unit" ? unit?.id || null : null, stamp: data?.stamp || "",
    beforePromote: () => unitFlush.current?.(), onPromoted: () => { void readQueue(false); } });
  // once per set open, in the background: unit rows carry the marks of a draft from an earlier session
  const openSetId = data && where && data.set.id === where.set ? data.set.id : "";
  useEffect(() => { if (openSetId) book.want(); }, [openSetId]);  // eslint-disable-line react-hooks/exhaustive-deps
  const editCode = (label: string) => {
    if (!codebook.length) return;
    setDrawer((cur) => label || cur || codebook[0].label);
    setEditReq((r) => ({ seq: (r?.seq || 0) + 1, code: label }));
  };
  const toRevisit = () => {
    restore.current = null;
    if (!roomy) setDrawer(null);
    setUnit(null);
    setFilter("revisit");
    setMode("queue");
  };
  const drawerMore = { draft: book, editReq, onEditTaken: () => setEditReq(null),
    onMemo: () => setMemoOpen(true), onRevisit: toRevisit };

  // `?` opens the codebook from the queue and the agreement too (the unit binds its own)
  useEffect(() => {
    if (mode !== "queue" && mode !== "agreement") return;
    const h = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.key !== "?" || drawer !== null || !codebook.length) return;
      const a = document.activeElement as HTMLElement | null;
      if (a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.isContentEditable)) return;
      e.preventDefault();
      e.stopPropagation();
      setDrawer(codebook[0].label);
    };
    // capture, and stopped: KeyLayer's bubble listener would open the key sheet on `?`
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [mode, drawer, codebook]);

  return (
    <div data-panel="coding" data-size={size} className="relative h-screen flex flex-col bg-background text-foreground">
      <PanelHeader {...chrome} title={title} titleHint={where ? where.project + " / " + where.set : "Qualitative coding sets"} right={right} />

      {mode === "queue" && where && (
        <QueueBar data={data} filter={filter} onFilter={(f) => setFilter((cur) => (cur === f ? "" : f))}
          q={q} onQ={setQ} body={body} onBack={backToSets}
          onAgreement={() => { setAgreeBack(null); setMode("agreement"); }}
          onCodebook={() => setDrawer(codebook[0]?.label || "")} />
      )}

      <div className="relative flex min-h-0 flex-1">
      <div ref={body} data-panel-body className="tinybar relative min-h-0 min-w-0 flex-1 overflow-y-auto">
        {mode === "sets" ? (
          <SetList sets={sets} err={setsErr} project={project} onOpen={openSet} />
        ) : !where ? (
          <PanelEmpty>No set open</PanelEmpty>
        ) : mode === "unit" && unit ? (
          <CodingUnitView key={where.project + "/" + where.set} project={where.project} set={where.set}
            unitId={unit.id} ids={unit.ids} codebook={codebook} coders={data?.coders ?? []} size={size}
            roomy={roomy} twoCol={twoCol} counts={data ? { done: data.counts.done, total: data.counts.total } : null}
            doneIds={doneIds} noteMax={data?.set.noteMax || CODING_NOTE_MAX}
            choice={data?.set.choice || "multi"} confidence={!!data?.set.confidence}
            onStep={(id) => { restore.current = id; setUnit((u) => (u ? { ...u, id } : u)); }}
            onBack={backFromUnit} onCodebook={(label) => setDrawer(label || codebook[0]?.label || "")}
            drawerOpen={drawer !== null} draftMarks={book.book ? book.marks : null} bookVersion={data?.set.codebookVersion || ""}
            onEdit={editCode} onMemo={() => setMemoOpen(true)} flushRef={unitFlush} />
        ) : mode === "agreement" ? (
          <CodingAgreementView project={where.project} set={where.set} size={size}
            pick={agreePick} onPick={setAgreePick} focusUnit={agreeBack} drawerOpen={drawer !== null}
            onBack={() => { setAgreePick(null); setAgreeBack(null); restore.current = "@agreement"; setMode("queue"); }}
            onOpenUnit={(id, ids) => openUnit(id, ids, "agreement")} />
        ) : err ? (
          <PanelEmpty>{err}</PanelEmpty>
        ) : !data ? (
          <PanelEmpty>Reading the set</PanelEmpty>
        ) : !rows.length ? (
          <PanelEmpty>{q ? "Nothing matches that search" : filter ? "No units under that filter" : "This set has no units"}</PanelEmpty>
        ) : (
          <UnitRows rows={rows} total={data.ids.length} codebook={codebook.map((c) => c.label)}
            names={Object.fromEntries(codebook.map((c) => [c.label, codeName(c)]))} size={size}
            onOpen={(id) => openUnit(id, data.ids, "queue")} onMore={more} />
        )}
      </div>
      {drawer !== null && roomy && codebook.length > 0 && (
        <CodebookDrawer docked unitKeys={mode === "unit"} codes={codebook} at={drawer} onAt={setDrawer} size={size}
          note={data?.set.codebookNote || ""} version={data?.set.codebookVersion || ""} onClose={() => setDrawer(null)} {...drawerMore} />
      )}
      </div>

      {drawer !== null && !roomy && codebook.length > 0 && (
        <CodebookDrawer codes={codebook} at={drawer} onAt={setDrawer} size={size} note={data?.set.codebookNote || ""}
          version={data?.set.codebookVersion || ""} onClose={() => setDrawer(null)} {...drawerMore} />
      )}
      {memoOpen && where && (
        <MemoLine unitId={mode === "unit" ? unit?.id || null : null} max={book.book?.limits.why}
          onSend={async (t) => { const r = await book.memo(t); return r && r.ok ? "" : r?.error || "not saved: the Board didn't answer"; }}
          onClose={() => setMemoOpen(false)} />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------------ the sets */

function SetList({ sets, err, project, onOpen }: {
  sets: CodingSetCard[] | null; err: string; project: string; onOpen: (s: CodingSetCard) => void;
}) {
  if (err) return <PanelEmpty>{err}</PanelEmpty>;
  if (!sets) return <PanelEmpty>Reading the sets</PanelEmpty>;
  if (!sets.length) return <PanelEmpty>{project ? "No coding sets in this project" : "No coding sets yet"}</PanelEmpty>;
  const groups: { project: string; name: string; sets: CodingSetCard[] }[] = [];
  for (const s of sets) {
    const g = groups.find((x) => x.project === s.project);
    if (g) g.sets.push(s); else groups.push({ project: s.project, name: s.projectName, sets: [s] });
  }
  return (
    <div className="mx-auto w-full max-w-[1180px] px-1 pb-2">
      {groups.map((g) => (
        <section key={g.project}>
          <div className="sticky top-0 z-10 flex items-center gap-1.5 bg-background px-0.5 pt-1.5 pb-1">
            <span className="min-w-0 truncate text-[9px] font-medium uppercase tracking-[0.08em] text-muted-foreground" title={g.name}>
              {stripProjectPrefix(g.name)}
            </span>
            <span className="h-px flex-1 bg-border/70" />
            <span className="nums shrink-0 text-[9px] text-muted-foreground">{g.sets.length}</span>
          </div>
          {g.sets.map((s) => (
            <button key={s.id} type="button" data-knav-item data-coding-set={s.project + "/" + s.id}
              disabled={!!s.error} onClick={() => onOpen(s)}
              title={s.error || [s.title, s.done + " of " + s.units + " coded", s.coders.length ? "coders: " + s.coders.join(", ") : "",
                s.blind ? "blind" : "not blind", s.codebookVersion].filter(Boolean).join(" · ")}
              className="flex w-full items-center gap-1.5 rounded px-1.5 py-[3px] text-left outline-none
                         hover:bg-accent/40 focus-visible:bg-accent/50 focus-visible:ring-1 focus-visible:ring-primary/60 disabled:opacity-50">
              <span className="min-w-0 flex-1 truncate text-[11px] text-foreground">{s.title}</span>
              {s.error
                ? <span className="shrink-0 text-[9.5px] text-danger">{s.error}</span>
                : <>
                    <Progress done={s.done} total={s.units} />
                    <span className="nums shrink-0 text-[9.5px] text-muted-foreground">{nfmt(s.done)}/{nfmt(s.units)}</span>
                    {s.blind && <EyeOff size={10} className="shrink-0 text-muted-foreground" aria-label="blind" />}
                  </>}
            </button>
          ))}
        </section>
      ))}
    </div>
  );
}

function Progress({ done, total }: { done: number; total: number }) {
  const pct = total ? Math.min(100, (done / total) * 100) : 0;
  return (
    <span className="relative h-[3px] w-12 shrink-0 overflow-hidden rounded-full bg-muted" aria-hidden>
      <span className="absolute inset-y-0 left-0 rounded-full bg-primary" style={{ width: pct + "%" }} />
    </span>
  );
}

/* ----------------------------------------------------------------------- the queue */

function QueueBar({ data, filter, onFilter, q, onQ, body, onBack, onAgreement, onCodebook }: {
  data: CodingSet | null; filter: CodingFilter; onFilter: (f: CodingFilter) => void;
  q: string; onQ: (q: string) => void; body: React.RefObject<HTMLDivElement | null>;
  onBack: () => void; onAgreement: () => void; onCodebook: () => void;
}) {
  const c = data?.counts;
  return (
    <div className="shrink-0 border-b border-border/40 px-2 pt-1 pb-1">
      <div className="mx-auto flex w-full max-w-[1180px] items-center gap-1">
        <button type="button" data-knav-back="1" data-qa="coding-sets-back" onClick={onBack} title="The sets (Esc)"
          className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground outline-none hover:bg-accent hover:text-foreground">
          <ArrowLeft size={12} />
        </button>
        {c && <Progress done={c.done} total={c.total} />}
        <span data-coding-progress className="nums shrink-0 text-[10px] text-muted-foreground" title="Coded of all units">
          {c ? nfmt(c.done) + "/" + nfmt(c.total) : ""}
        </span>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-0.5">
          {FILTERS.filter((f) => f.id !== "revisit" || filter === "revisit" || !!c?.revisit).map((f) => {
            const on = filter === f.id;
            return (
              <button key={f.id} type="button" data-knav-item data-coding-filter={f.id} aria-pressed={on}
                onClick={() => onFilter(f.id)} title={f.hint}
                className={"inline-flex h-[18px] shrink-0 items-center gap-1 rounded-full border px-1.5 text-[9.5px] outline-none "
                  + "focus-visible:ring-1 focus-visible:ring-primary/60 "
                  + (on ? "border-primary/60 bg-primary/15 text-foreground" : "border-border/60 text-muted-foreground hover:text-foreground")}>
                {f.label}<span className="nums text-[9px] text-muted-foreground">{c ? nfmt(c[f.count]) : ""}</span>
              </button>
            );
          })}
        </div>
        <button type="button" data-knav-item data-qa="coding-agreement" onClick={onAgreement} title="Agreement"
          className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-primary/60">
          <BarChart3 size={12} />
        </button>
        <button type="button" data-knav-item data-qa="coding-codebook" onClick={onCodebook} title="Codebook (?)"
          className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-primary/60">
          <BookOpen size={12} />
        </button>
      </div>
      <div className="mx-auto mt-1 flex w-full max-w-[1180px] items-center gap-1.5 rounded-md border border-border bg-background px-1.5">
        <Search size={11} className="shrink-0 text-muted-foreground" />
        <input value={q} onChange={(e) => onQ(e.target.value)} data-panel-search data-qa="coding-search"
          data-knav-own="arrows enter" placeholder="search units" title="Search ids, text and your notes"
          onKeyDown={(e) => {
            if (e.defaultPrevented) return;
            if (e.key === "ArrowDown" || e.key === "Enter") {
              e.preventDefault();
              focusSel(body.current, "[data-coding-row]");
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              focusSel(document, "[data-coding-filter]");
            }
          }}
          className="min-w-0 flex-1 bg-transparent py-[3px] text-[11px] outline-none placeholder:text-muted-foreground/60" />
        {q && (
          <button type="button" onClick={() => onQ("")} title="Clear the search"
            className="shrink-0 text-muted-foreground outline-none hover:text-foreground"><X size={11} /></button>
        )}
        <span data-panel-count className="nums shrink-0 text-[9px] text-muted-foreground">
          {data ? nfmt(data.ids.length) : ""}
        </span>
      </div>
    </div>
  );
}

function UnitRows({ rows, total, codebook, names, size, onOpen, onMore }: {
  rows: CodingRow[]; total: number; codebook: string[]; names: Record<string, string>; size: PaneSize;
  onOpen: (id: string) => void; onMore: () => void;
}) {
  const moreRef = useRef<HTMLButtonElement>(null);
  const wide = size !== "xs";
  // a label is data: the lookup must not answer with something off the prototype chain
  const nameOf = (c: string) => (Object.prototype.hasOwnProperty.call(names, c) ? names[c] : c);
  useEffect(() => {
    const el = moreRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) onMore(); });
    io.observe(el);
    return () => io.disconnect();
  }, [onMore, rows.length]);
  return (
    <div className="mx-auto w-full max-w-[1180px] px-1 py-1">
      {rows.map((r) => (
        <button key={r.id} type="button" data-knav-item data-coding-row={r.id} data-coding-status={r.status}
          onClick={() => onOpen(r.id)}
          title={[r.id, r.status === "done" ? "coded" : r.status === "draft" ? "started" : "to code",
            r.codes.length ? r.codes.map(nameOf).join(", ") : "", r.disagree ? "differs from a coder" : "",
            r.agentReviews ? r.agentReviews + " agent review" + (r.agentReviews > 1 ? "s" : "") : "",
            r.noted ? "note: " + r.note : "",
            r.revisit.length ? "revisit: " + r.revisit.map((c) => (c === "*" ? "codebook changed outside the pane" : nameOf(c))).join(", ") : ""].filter(Boolean).join(" · ")}
          className="flex w-full items-center gap-1.5 rounded px-1.5 py-[3px] text-left outline-none
                     hover:bg-accent/40 focus-visible:bg-accent/50 focus-visible:ring-1 focus-visible:ring-primary/60">
          <span className="inline-flex w-3 shrink-0 justify-center" aria-hidden>
            {r.status === "done" ? <Check size={10} className="text-primary" />
              : r.status === "draft" ? <span className="h-[5px] w-[5px] rounded-full border border-primary" /> : null}
          </span>
          <span className="shrink-0 truncate font-mono text-[10px] text-muted-foreground" style={{ maxWidth: wide ? 88 : 64 }}>{r.id}</span>
          <span className="min-w-0 flex-1 truncate text-[10.5px] text-foreground">{r.preview}</span>
          <span data-coding-dots className="flex shrink-0 items-center gap-[3px]" aria-hidden>
            {codebook.map((c) => (
              <span key={c} title={nameOf(c)}
                className={"h-[6px] w-[6px] rounded-full " + (r.codes.includes(c) ? "bg-primary" : r.status === "todo" ? "bg-muted" : "border border-border")} />
            ))}
          </span>
          {r.noted && <StickyNote size={10} data-coding-row-noted className="shrink-0 text-muted-foreground" aria-hidden />}
          {r.revisit.length > 0 && <RotateCcw size={10} data-coding-row-revisit className="shrink-0 text-warning" aria-hidden />}
          {r.disagree && <span data-coding-row-disagree className="h-[5px] w-[5px] shrink-0 rounded-full bg-danger" aria-hidden />}
          {r.agentReviews > 0 && <Bot size={10} data-coding-row-agent className="shrink-0 text-primary" aria-hidden />}
        </button>
      ))}
      {rows.length < total && (
        <button ref={moreRef} type="button" data-knav-item data-coding-more onClick={onMore} title="The next units"
          className="mt-0.5 w-full rounded px-1.5 py-[3px] text-center text-[10px] text-muted-foreground outline-none hover:bg-accent/40 focus-visible:ring-1 focus-visible:ring-primary/60">
          {nfmt(total - rows.length)} more
        </button>
      )}
    </div>
  );
}
