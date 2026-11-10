

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Check, Download, ListChecks, Plus, Upload, X } from "lucide-react";
import { toast } from "sonner";
import { api, type ChecklistSources } from "@/lib/api";

type Row = { kind: "item"; text: string; done: boolean } | { kind: "raw"; text: string };
type Group = { title: string; rows: Row[] };
type Model = { head: string[]; groups: Group[] };

const ITEM_RE = /^\s*[-*+]\s+\[([ xX])\]\s?(.*)$/;
const H2_RE = /^##\s+(.*)$/;

// the paper's own file: '## ' starts a group, '- [ ]' an item; anything else is kept verbatim
export function parseChecklist(md: string): Model {
  const head: string[] = [], groups: Group[] = [];
  let g: Group | null = null;
  for (const ln of (md || "").replace(/\r\n/g, "\n").split("\n")) {
    const h = H2_RE.exec(ln);
    if (h) { g = { title: h[1].trim(), rows: [] }; groups.push(g); continue; }
    const it = ITEM_RE.exec(ln);
    if (it) {
      if (!g) { g = { title: "", rows: [] }; groups.push(g); }
      g.rows.push({ kind: "item", text: it[2].trim(), done: it[1] !== " " });
      continue;
    }
    if (!g) head.push(ln);
    else if (ln.trim()) g.rows.push({ kind: "raw", text: ln });
  }
  while (head.length && !head[head.length - 1].trim()) head.pop();
  return { head, groups };
}

export function serializeChecklist(m: Model): string {
  const out: string[] = [...m.head];
  for (const g of m.groups) {
    if (out.length) out.push("");
    if (g.title || out.length) out.push("## " + (g.title || "Checklist"));
    for (const r of g.rows) out.push(r.kind === "item" ? `- [${r.done ? "x" : " "}] ${r.text}` : r.text);
  }
  return out.join("\n").replace(/^\n+/, "") + "\n";
}

const plain = (s: string) => s.replace(/\*\*(.+?)\*\*/g, "$1").replace(/__(.+?)__/g, "$1").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/\s+/g, " ").trim();
const norm = (s: string) => plain(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// a template doc (a journal's checklist or guidelines, or another paper's checklist):
// '- [ ]' items when there are any, else every bullet and numbered line, by heading
function parseTemplate(md: string, fallback: string): { title: string; items: string[] }[] {
  const body = (md || "").replace(/\r\n/g, "\n").replace(/^---\n[\s\S]*?\n---\n/, "");
  const lines = body.split("\n");
  const boxes = lines.some((l) => ITEM_RE.test(l));
  const groups: { title: string; items: string[] }[] = [];
  let g: { title: string; items: string[] } | null = null;
  let open = false;   // the last line was a taken item, so an indented line continues it
  for (const ln of lines) {
    const h = /^#{1,6}\s+(.*)$/.exec(ln);
    if (h) { g = { title: plain(h[1]), items: [] }; groups.push(g); open = false; continue; }
    let t: string | null = null;
    const it = ITEM_RE.exec(ln);
    const b = it ? null : /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(ln);
    if (it) t = it[2];
    else if (b && !boxes) t = b[1];
    else if (!b && open && g && /^\s+\S/.test(ln)) { g.items[g.items.length - 1] += " " + ln.trim(); continue; }
    if (!t || !t.trim()) { open = false; continue; }
    if (!g) { g = { title: fallback, items: [] }; groups.push(g); }
    g.items.push(t.trim()); open = true;
  }
  return groups.map((x) => ({ ...x, items: x.items.map(plain).filter(Boolean) })).filter((x) => x.items.length);
}

type Src = { kind: "journal"; name: string; file: string } | { kind: "paper"; slug: string };
type Preview = { groups: { title: string; items: { text: string; on: boolean }[] }[] };

const OPEN_KEY = (slug: string) => `all_in_one_academic:checklist:${slug}`;
function lsGet(k: string): { hideDone?: boolean } {
  try { const v = JSON.parse(localStorage.getItem(k) || "null"); return v && typeof v === "object" ? v : {}; } catch { return {}; }
}
function lsSet(k: string, v: object) {
  try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private window */ }
}

export function ChecklistPanel({ slug, onClose }: { slug: string; onClose: () => void }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [model, setModel] = useState<Model | null>(null);
  const [loadErr, setLoadErr] = useState("");
  const mtime = useRef(0);
  const dirty = useRef(false);
  const inFlight = useRef(false);
  const timer = useRef<number | null>(null);
  const modelRef = useRef<Model | null>(null); modelRef.current = model;
  const [hideDone, setHideDone] = useState(() => lsGet(OPEN_KEY(slug)).hideDone === true);
  useEffect(() => { setHideDone(lsGet(OPEN_KEY(slug)).hideDone === true); }, [slug]);

  const load = useCallback(() => {
    api.draftingChecklist(slug).then((r) => {
      if (r.error) { setLoadErr(r.error); return; }
      if (dirty.current || inFlight.current) return;
      mtime.current = r.mtime || 0; setLoadErr("");
      setModel(parseChecklist(r.text || ""));
    }).catch(() => setLoadErr("Couldn't load the checklist"));
  }, [slug]);
  useEffect(() => { setModel(null); dirty.current = false; load(); }, [load]);
  useEffect(() => {
    const h = () => { if (document.visibilityState !== "hidden" && !dirty.current && !inFlight.current) load(); };
    window.addEventListener("focus", h); document.addEventListener("visibilitychange", h);
    return () => { window.removeEventListener("focus", h); document.removeEventListener("visibilitychange", h); };
  }, [load]);

  const flush = useCallback(async () => {
    if (timer.current) { window.clearTimeout(timer.current); timer.current = null; }
    if (!dirty.current || inFlight.current || !modelRef.current) return;
    inFlight.current = true; dirty.current = false;
    const text = serializeChecklist(modelRef.current);
    try {
      const r = await api.draftingChecklistSave(slug, text, mtime.current);
      if (r.ok) mtime.current = r.mtime || 0;
      else if (r.error === "stale") {
        mtime.current = r.mtime || 0;
        setModel(parseChecklist(r.text || ""));
        toast("The checklist changed elsewhere; showing that copy. Redo your last change.");
      } else { dirty.current = true; toast.error("Checklist not saved: " + (r.error || "no reply")); }
    } catch { dirty.current = true; toast.error("Checklist not saved: no reply from the server"); }
    inFlight.current = false;
    if (dirty.current) timer.current = window.setTimeout(() => { void flush(); }, 2000);
  }, [slug]);
  useEffect(() => () => { void flush(); }, [flush]);

  const change = (fn: (m: Model) => Model) => {
    setModel((m) => { const n = fn(m ?? { head: [], groups: [] }); modelRef.current = n; return n; });
    dirty.current = true;
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { void flush(); }, 500);
  };
  const editGroup = (gi: number, fn: (g: Group) => Group | null) => change((m) => {
    const groups = m.groups.map((g, i) => i === gi ? fn(g) : g).filter(Boolean) as Group[];
    return { ...m, groups };
  });

  const counts = useMemo(() => {
    let done = 0, all = 0;
    for (const g of model?.groups ?? []) for (const r of g.rows) if (r.kind === "item") { all++; if (r.done) done++; }
    return { done, all };
  }, [model]);

  // inline editing: one field at a time, keyed "g:i" for an item, "g:t" for a title, "g:new"
  const [edit, setEdit] = useState<{ key: string; value: string } | null>(null);
  const commitEdit = (keep = false) => {
    if (!edit) return;
    const [gs, what] = edit.key.split(":"), gi = Number(gs), v = edit.value.trim();
    if (what === "t") editGroup(gi, (g) => ({ ...g, title: v || g.title }));
    else if (what === "new") { if (v) editGroup(gi, (g) => ({ ...g, rows: [...g.rows, { kind: "item", text: v, done: false }] })); }
    else {
      const ri = Number(what);
      editGroup(gi, (g) => ({ ...g, rows: v ? g.rows.map((r, i) => i === ri && r.kind === "item" ? { ...r, text: v } : r) : g.rows.filter((_, i) => i !== ri) }));
    }
    setEdit(keep && what === "new" && v ? { key: edit.key, value: "" } : null);
  };
  const moveRow = (gi: number, ri: number, d: -1 | 1) => editGroup(gi, (g) => {
    const j = ri + d; if (j < 0 || j >= g.rows.length) return g;
    const rows = [...g.rows]; [rows[ri], rows[j]] = [rows[j], rows[ri]]; return { ...g, rows };
  });
  const moveGroup = (gi: number, d: -1 | 1) => change((m) => {
    const j = gi + d; if (j < 0 || j >= m.groups.length) return m;
    const groups = [...m.groups]; [groups[gi], groups[j]] = [groups[j], groups[gi]]; return { ...m, groups };
  });

  // Pull from / Save as template
  const [sources, setSources] = useState<ChecklistSources | null>(null);
  const [mode, setMode] = useState<"" | "pull" | "template">("");
  const [src, setSrc] = useState<Src | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [tplJournal, setTplJournal] = useState("");
  const openMode = (m: "pull" | "template") => {
    setMode((cur) => cur === m ? "" : m); setSrc(null); setPreview(null);
    api.draftingChecklistSources(slug).then(setSources).catch(() => toast.error("Couldn't list journals and papers"));
  };
  useEffect(() => {
    setPreview(null);
    if (!src) return;
    let live = true;
    const take = (md: string, label: string) => {
      if (!live) return;
      const gs = parseTemplate(md, label);
      setPreview({ groups: gs.map((g) => ({ title: g.title, items: g.items.map((t) => ({ text: t, on: true })) })) });
    };
    if (src.kind === "journal") api.draftingJournal(src.name, src.file).then((r) => take(r.markdown || "", src.name)).catch(() => live && toast.error("Couldn't read that journal doc"));
    else api.draftingChecklist(src.slug).then((r) => take(r.text || "", src.slug)).catch(() => live && toast.error("Couldn't read that checklist"));
    return () => { live = false; };
  }, [src]);
  const picked = preview ? preview.groups.reduce((n, g) => n + g.items.filter((i) => i.on).length, 0) : 0;
  const addPicked = () => {
    if (!preview) return;
    let added = 0;
    change((m) => {
      const groups = m.groups.map((g) => ({ ...g, rows: [...g.rows] }));
      for (const pg of preview.groups) {
        const items = pg.items.filter((i) => i.on);
        if (!items.length) continue;
        let g = groups.find((x) => norm(x.title) === norm(pg.title));
        if (!g) { g = { title: pg.title, rows: [] }; groups.push(g); }
        const have = new Set(g.rows.filter((r) => r.kind === "item").map((r) => norm(r.text)));
        for (const it of items) if (!have.has(norm(it.text))) { g.rows.push({ kind: "item", text: it.text, done: false }); have.add(norm(it.text)); added++; }
      }
      return { ...m, groups };
    });
    toast.success(added ? `Added ${added} item${added === 1 ? "" : "s"}` : "Nothing new to add");
    setMode(""); setSrc(null); setPreview(null);
  };
  const saveTemplate = async () => {
    if (!tplJournal || !model) return;
    const blank: Model = { ...model, groups: model.groups.map((g) => ({ ...g, rows: g.rows.map((r) => r.kind === "item" ? { ...r, done: false } : r) })) };
    const r = await api.draftingChecklistTemplateSave(tplJournal, serializeChecklist(blank)).catch(() => ({ error: "no reply" } as { ok?: boolean; error?: string }));
    if (r.ok) { toast.success(`Saved as the ${tplJournal} template`); setMode(""); }
    else toast.error("Template not saved: " + (r.error || "no reply"));
  };

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const t = e.target as HTMLElement | null;
      if (!rootRef.current?.contains(t)) return;
      if (t?.matches?.("input, textarea, select")) return;   // the field's own Esc handles it
      e.preventDefault(); e.stopPropagation();
      if (mode) setMode(""); else onClose();
    };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [mode, onClose]);

  const iconBtn = "inline-flex items-center justify-center w-6 h-6 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent disabled:opacity-40 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50";
  const textBtn = "inline-flex items-center gap-1 h-7 rounded-md px-2 text-[12px] text-muted-foreground hover:text-foreground hover:bg-accent disabled:opacity-40 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50";
  const field = "w-full rounded-md border border-primary/40 bg-background px-1.5 py-0.5 text-[12.5px] leading-snug focus:outline-none focus:border-primary/60";
  const fieldKeys = (e: React.KeyboardEvent, gi: number, ri?: number) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commitEdit(true); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setEdit(null); }
    else if (e.altKey && ri !== undefined && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault(); commitEdit(); moveRow(gi, ri, e.key === "ArrowUp" ? -1 : 1);
    }
  };

  const groups = model?.groups ?? [];
  return (
    <div ref={rootRef} data-checklist-panel className="flex flex-col h-full w-[320px] shrink-0 border-l border-border bg-secondary/20">
      <div className="shrink-0 flex items-center gap-1.5 px-3 py-2 border-b border-border">
        <ListChecks size={15} className="text-primary shrink-0" />
        <span className="text-[13px] font-medium flex-1 truncate">Checklist</span>
        {counts.all > 0 && <span className="nums text-[11.5px] text-muted-foreground" data-checklist-count title={`${counts.done} of ${counts.all} done`}>{counts.done}/{counts.all}</span>}
        <button type="button" onClick={() => openMode("pull")} aria-pressed={mode === "pull"} data-checklist-pull title="Pull items from a journal template or another paper's checklist" className={`${iconBtn} ${mode === "pull" ? "text-foreground bg-accent" : ""}`}><Download size={13} /></button>
        <button type="button" onClick={() => openMode("template")} aria-pressed={mode === "template"} disabled={!counts.all} data-checklist-template title="Save this checklist, unticked, as a journal's template" className={`${iconBtn} ${mode === "template" ? "text-foreground bg-accent" : ""}`}><Upload size={13} /></button>
        <button type="button" onClick={onClose} data-knav-back="2" title="Close" aria-label="Close checklist" className={iconBtn}><X size={15} /></button>
      </div>

      {mode === "pull" && (
        <div data-checklist-pullbox className="shrink-0 max-h-[60%] flex flex-col border-b border-border bg-background/60">
          <div className="px-3 pt-2 pb-1.5 flex gap-1.5">
            <select data-checklist-source value={src ? (src.kind === "journal" ? "j:" + src.name : "p:" + src.slug) : ""} aria-label="Pull from"
              onChange={(e) => {
                const v = e.target.value;
                if (v.startsWith("j:")) { const j = sources?.journals.find((x) => x.name === v.slice(2)); if (j) setSrc({ kind: "journal", name: j.name, file: j.docs.some((d) => d.file === "Checklist template.md") ? "Checklist template.md" : j.default || "" }); }
                else if (v.startsWith("p:")) setSrc({ kind: "paper", slug: v.slice(2) });
                else setSrc(null);
              }}
              className="flex-1 min-w-0 h-7 rounded-md border border-border bg-background px-1.5 text-[12px] focus:outline-none focus:border-primary/60">
              <option value="">{sources ? "Pull from…" : "Loading…"}</option>
              {!!sources?.journals.length && <optgroup label="Journals">{sources.journals.map((j) => <option key={j.name} value={"j:" + j.name}>{j.name}{j.template ? " · template" : ""}</option>)}</optgroup>}
              {!!sources?.papers.length && <optgroup label="Other checklists">{sources.papers.map((p) => <option key={p.slug} value={"p:" + p.slug}>{p.slug} ({p.items})</option>)}</optgroup>}
            </select>
          </div>
          {src?.kind === "journal" && (() => {
            const j = sources?.journals.find((x) => x.name === src.name);
            return j && j.docs.length > 1 ? (
              <div className="px-3 pb-1.5">
                <select value={src.file} aria-label="Journal document" onChange={(e) => setSrc({ ...src, file: e.target.value })}
                  className="w-full h-7 rounded-md border border-border bg-background px-1.5 text-[12px] focus:outline-none focus:border-primary/60">
                  {j.docs.map((d) => <option key={d.file} value={d.file}>{d.label}</option>)}
                </select>
              </div>
            ) : null;
          })()}
          {src && !preview && <p className="px-3 pb-2 text-[12px] text-muted-foreground">Reading…</p>}
          {preview && preview.groups.length === 0 && <p className="px-3 pb-2 text-[12px] text-muted-foreground">No list items in that document.</p>}
          {preview && preview.groups.length > 0 && <>
            <div className="flex-1 min-h-0 overflow-y-auto tinybar px-3 pb-1 space-y-2">
              {preview.groups.map((g, gi) => {
                const all = g.items.every((i) => i.on);
                const setG = (fn: (i: { text: string; on: boolean }, k: number) => boolean) => setPreview((p) => p && ({ groups: p.groups.map((x, xi) => xi !== gi ? x : { ...x, items: x.items.map((i, k) => ({ ...i, on: fn(i, k) })) }) }));
                return (
                  <div key={gi}>
                    <label className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground cursor-pointer">
                      <input type="checkbox" checked={all} onChange={() => setG(() => !all)} className="accent-primary" />{g.title}</label>
                    {g.items.map((it, k) => (
                      <label key={k} className="flex items-start gap-1.5 pl-4 py-0.5 text-[12px] leading-snug cursor-pointer">
                        <input type="checkbox" checked={it.on} onChange={() => setG((i, kk) => kk === k ? !i.on : i.on)} className="mt-0.5 accent-primary" />
                        <span className={it.on ? "text-foreground/90" : "text-muted-foreground line-through"}>{it.text}</span></label>
                    ))}
                  </div>
                );
              })}
            </div>
            <div className="shrink-0 px-3 py-1.5 flex justify-end gap-1 border-t border-border/60">
              <button type="button" className={textBtn} onClick={() => { setMode(""); setSrc(null); }}>Cancel</button>
              <button type="button" data-checklist-add disabled={!picked} className={`${textBtn} text-primary`} onClick={addPicked}><Plus size={12} />Add {picked}</button>
            </div>
          </>}
        </div>
      )}

      {mode === "template" && (
        <div data-checklist-tplbox className="shrink-0 px-3 py-2 border-b border-border bg-background/60 flex gap-1.5 items-center">
          <select value={tplJournal} onChange={(e) => setTplJournal(e.target.value)} aria-label="Journal"
            className="flex-1 min-w-0 h-7 rounded-md border border-border bg-background px-1.5 text-[12px] focus:outline-none focus:border-primary/60">
            <option value="">{sources ? "Journal…" : "Loading…"}</option>
            {sources?.journals.map((j) => <option key={j.name} value={j.name}>{j.name}{j.template ? " · has template" : ""}</option>)}
          </select>
          <button type="button" disabled={!tplJournal} className={`${textBtn} text-primary`} onClick={saveTemplate}
            title="Writes toolkit/journals/<journal>/Checklist template.md, every item unticked">
            {sources?.journals.find((j) => j.name === tplJournal)?.template ? "Replace" : "Save"}</button>
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto tinybar py-1.5">
        {loadErr && <p className="px-3 py-2 text-[12.5px] text-destructive">{loadErr}</p>}
        {!loadErr && !model && <p className="px-3 py-2 text-[12.5px] text-muted-foreground">Loading…</p>}
        {model && groups.length === 0 && mode !== "pull" && (
          <div className="px-3 py-3 space-y-1.5">
            <button type="button" className={textBtn} onClick={() => openMode("pull")}><Download size={12} />Pull from a journal or paper</button>
            <button type="button" className={textBtn} onClick={() => { change((m) => ({ ...m, groups: [{ title: "Checklist", rows: [] }] })); setEdit({ key: "0:new", value: "" }); }}><Plus size={12} />Start blank</button>
          </div>
        )}
        {groups.map((g, gi) => {
          const rows = g.rows.map((r, ri) => ({ r, ri })).filter(({ r }) => !(hideDone && r.kind === "item" && r.done));
          const gDone = g.rows.filter((r) => r.kind === "item" && r.done).length, gAll = g.rows.filter((r) => r.kind === "item").length;
          return (
            <div key={gi} data-checklist-group className="group/g px-2 pb-2">
              <div className="flex items-center gap-1 px-1 pt-1.5 pb-0.5">
                {edit?.key === gi + ":t"
                  ? <input autoFocus value={edit.value} onChange={(e) => setEdit({ ...edit, value: e.target.value })} onBlur={() => commitEdit()} onKeyDown={(e) => fieldKeys(e, gi)} className={field} aria-label="Group title" />
                  : <button type="button" onClick={() => setEdit({ key: gi + ":t", value: g.title })} title="Rename this group"
                      className="flex-1 min-w-0 truncate text-left text-[11px] uppercase tracking-wide text-muted-foreground hover:text-foreground">{g.title || "Checklist"}</button>}
                <span className="nums text-[10.5px] text-muted-foreground/70">{gDone}/{gAll}</span>
                <span className="flex opacity-0 group-hover/g:opacity-100 focus-within:opacity-100">
                  <button type="button" className={iconBtn} disabled={gi === 0} onClick={() => moveGroup(gi, -1)} title="Move group up" aria-label="Move group up"><ArrowUp size={11} /></button>
                  <button type="button" className={iconBtn} disabled={gi === groups.length - 1} onClick={() => moveGroup(gi, 1)} title="Move group down" aria-label="Move group down"><ArrowDown size={11} /></button>
                  <button type="button" className={iconBtn} onClick={() => { if (!gAll || window.confirm(`Delete "${g.title}" and its ${gAll} item${gAll === 1 ? "" : "s"}?`)) editGroup(gi, () => null); }} title="Delete group" aria-label="Delete group"><X size={11} /></button>
                </span>
              </div>
              {rows.map(({ r, ri }) => r.kind === "raw"
                ? <p key={ri} className="pl-7 pr-1 text-[11.5px] text-muted-foreground/80 whitespace-pre-wrap">{r.text}</p>
                : (
                  <div key={ri} data-checklist-item data-done={r.done || undefined} className="group/i flex items-start gap-1.5 rounded-md px-1 py-0.5 hover:bg-accent/50">
                    <button type="button" role="checkbox" aria-checked={r.done} onClick={() => editGroup(gi, (x) => ({ ...x, rows: x.rows.map((y, i) => i === ri && y.kind === "item" ? { ...y, done: !y.done } : y) }))}
                      title={r.done ? "Untick" : "Tick"}
                      className={`mt-[3px] inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] border focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50 ${r.done ? "bg-primary border-primary text-primary-foreground" : "border-muted-foreground/50 hover:border-primary"}`}>
                      {r.done && <Check size={10} strokeWidth={3} />}</button>
                    {edit?.key === gi + ":" + ri
                      ? <textarea autoFocus rows={Math.min(6, Math.ceil(edit.value.length / 38) || 1)} value={edit.value} onChange={(e) => setEdit({ ...edit, value: e.target.value })} onBlur={() => commitEdit()} onKeyDown={(e) => fieldKeys(e, gi, ri)} className={`${field} resize-none`} aria-label="Item" />
                      : <button type="button" onClick={() => setEdit({ key: gi + ":" + ri, value: r.text })} title="Edit (empty it to delete; Alt+↑↓ moves it)"
                          className={`flex-1 min-w-0 text-left text-[12.5px] leading-snug ${r.done ? "text-muted-foreground line-through decoration-muted-foreground/50" : "text-foreground/90"}`}>{r.text}</button>}
                    {edit?.key !== gi + ":" + ri && <button type="button" className={`${iconBtn} opacity-0 group-hover/i:opacity-100 focus-visible:opacity-100`} onClick={() => editGroup(gi, (x) => ({ ...x, rows: x.rows.filter((_, i) => i !== ri) }))} title="Delete item" aria-label="Delete item"><X size={11} /></button>}
                  </div>
                ))}
              {edit?.key === gi + ":new"
                ? <div className="pl-6 pr-1 pt-0.5"><input autoFocus value={edit.value} placeholder="New item" onChange={(e) => setEdit({ ...edit, value: e.target.value })} onBlur={() => commitEdit()} onKeyDown={(e) => fieldKeys(e, gi)} className={field} aria-label="New item" data-checklist-new /></div>
                : <button type="button" onClick={() => setEdit({ key: gi + ":new", value: "" })} className={`${textBtn} ml-5 h-6 text-[11.5px]`}><Plus size={11} />Add item</button>}
            </div>
          );
        })}
        {groups.length > 0 && (
          <div className="px-3 pt-1 flex flex-wrap gap-1 border-t border-border/50 mt-1">
            <button type="button" className={textBtn} onClick={() => { change((m) => ({ ...m, groups: [...m.groups, { title: "New group", rows: [] }] })); setEdit({ key: groups.length + ":t", value: "New group" }); }}><Plus size={12} />Group</button>
            <button type="button" aria-pressed={hideDone} className={`${textBtn} ${hideDone ? "text-foreground bg-accent" : ""}`} onClick={() => { const v = !hideDone; setHideDone(v); lsSet(OPEN_KEY(slug), { hideDone: v }); }} title="Hide ticked items">Hide done</button>
            <button type="button" className={textBtn} disabled={!counts.done} onClick={() => { if (window.confirm("Untick every item?")) change((m) => ({ ...m, groups: m.groups.map((g) => ({ ...g, rows: g.rows.map((r) => r.kind === "item" ? { ...r, done: false } : r) })) })); }} title="Untick every item, to run the list again">Untick all</button>
          </div>
        )}
      </div>
    </div>
  );
}
