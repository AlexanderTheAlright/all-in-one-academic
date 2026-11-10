
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Check, Copy, Keyboard, Search, X } from "lucide-react";
import { panelApi, PANEL_LANGS, type PanelDictionary, type PanelDictItem,
  type PanelLang } from "@/lib/api";
import { paneRecall, paneRemember, toks, useRememberedSearch, type PaneSize } from "@/components/widgets/panel";
import { FilledCode, PlaceholderFields, initialValues, outgoing, rememberPh,
  type PhDataset, type PhValues } from "@/components/widgets/placeholders";
import { PanelEmpty, PanelHeader, Hi, useBracketStep, useHomeEnd, useLeftToTabs,
  type PanelChromeProps } from "@/components/widgets/PanelChrome";
import { copyPlain } from "@/lib/clipboard";

/** one readable column however wide the pane gets, the same rule the other views keep */
const WRAP = "mx-auto w-full max-w-[1180px]";

/** the pane is narrow: the command moves off the row's right edge and under its label */
const folded = (size: PaneSize) => size === "xs" || size === "sm";

const isBool = (v: unknown): v is boolean => typeof v === "boolean";

/** a key row's cmd, "Ctrl-d · Ctrl-u" / "Space (wait)" / "/ … Enter": each key a chip;
 *  the separator, the ellipsis and a (note) stay plain text */
const plainTok = (t: string) => t === "·" || t === "…" || /^\(.*\)$/.test(t);

function KeyChips({ cmd, q, big }: { cmd: string; q: string[]; big?: boolean }) {
  const parts = cmd.split(/\s+/).filter(Boolean);
  return (
    <span data-key-chips className={"inline-flex min-w-0 items-center " + (big ? "flex-wrap gap-1" : "gap-[3px]")}>
      {parts.map((t, i) => plainTok(t) ? (
        <span key={i} className={"text-muted-foreground " + (big ? "text-[11px]" : "text-[9.5px] leading-[11px]")}>{t}</span>
      ) : (
        <kbd key={i} data-key-chip
          className={"rounded-sm border border-border/70 bg-muted px-1 font-mono text-foreground "
            + (big ? "text-[11px] leading-[16px]" : "text-[9.5px] leading-[9px]")}>
          <Hi text={t} q={q} />
        </kbd>
      ))}
    </span>
  );
}

export function StartPanel({ chrome, lang, onLang, size, right, onUnavailable, dataset }: {
  chrome: PanelChromeProps;
  /** the dataset the Variables tab is on: what a {{variable}} slot offers, and what a
   *  {{family}}/{{key}} slot defaults to. Null is fine — the slot is then free text. */
  dataset?: PhDataset;
  /** the language every snippet in the pane is written in — Start owns this choice */
  lang: PanelLang;
  onLang: (l: PanelLang) => void;
  size: PaneSize;
  right?: React.ReactNode;
  
  onUnavailable?: () => void;
}) {
  const [dict, setDict] = useState<PanelDictionary | null>(null);
  const [failed, setFailed] = useState("");
  const [q, setQ] = useRememberedSearch("start");
  const [keysOn, setKeysOn] = useState<boolean>(() => paneRecall<boolean>("start.keys", isBool) === true);
  const [open, setOpen] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const restore = useRef<string | null>(null);
  const body = useRef<HTMLDivElement>(null);
  // read through a ref so the dictionary effect never restarts on a new closure
  const gone = useRef(onUnavailable);
  gone.current = onUnavailable;

  useEffect(() => {
    let live = true;
    let stamp = "";
    let everAnswered = false;
    setDict(null);
    setFailed("");
    const pull = () => {
      panelApi.dictionary(lang).then((d) => {
        if (!live) return;
        setFailed(d.ok ? "" : d.error || "the dictionary didn't answer");
        if (!d.ok) { if (!everAnswered) gone.current?.(); return; }
        everAnswered = true;
        if (d.stamp && d.stamp === stamp) return;
        stamp = d.stamp;
        setDict(d);
      }).catch(() => {
        if (!live) return;
        setFailed("the dictionary didn't answer");
        if (!everAnswered) gone.current?.();
      });
    };
    pull();
    const t = window.setInterval(pull, 60_000);
    window.addEventListener("focus", pull);
    return () => { live = false; window.clearInterval(t); window.removeEventListener("focus", pull); };
  }, [lang]);

  // the Keys button shows the editor keys and nothing else; off, the code list without them
  const groups = useMemo(() => (dict?.groups ?? []).filter((g) => (g.source === "keys") === keysOn),
    [dict, keysOn]);
  const toggleKeys = useCallback(() => {
    setOpen(null);
    setKeysOn((v) => { paneRemember("start.keys", !v); return !v; });
  }, []);
  const tk = useMemo(() => toks(q), [q]);
  const hit = useCallback((it: PanelDictItem) => {
    if (!tk.length) return true;
    const hay = (it.label + " " + it.desc + " " + it.cmd + " " + it.category).toLowerCase();
    return tk.every((t) => hay.includes(t));
  }, [tk]);

  const shown = useMemo(() => groups
    .map((g) => ({ g, items: g.items.filter(hit) }))
    .filter((x) => x.items.length), [groups, hit]);
  const flat = useMemo<PanelDictItem[]>(() => shown.flatMap((x) => x.items), [shown]);
  const total = useMemo(() => groups.reduce((n, g) => n + g.items.length, 0), [groups]);

  const openRow = useCallback((id: string) => { restore.current = id; setOpen(id); }, []);

  // Esc out of a command puts the focus back on its row, with the query untouched
  useEffect(() => {
    if (open || !restore.current) return;
    const el = body.current?.querySelector<HTMLElement>(`[data-dict-row="${CSS.escape(restore.current)}"]`);
    if (el) { document.documentElement.setAttribute("data-knav", ""); el.focus({ preventScroll: false }); }
    restore.current = null;
  }, [open]);

  const at = open ? flat.findIndex((i) => i.id === open) : -1;
  const step = useCallback((d: -1 | 1) => {
    if (at < 0) return;
    const n = flat[at + d];
    if (n) { restore.current = n.id; setOpen(n.id); }
  }, [at, flat]);
  useBracketStep(open ? step : null);
  useHomeEnd("[data-dict-row]");
  useLeftToTabs();

  const cur = at >= 0 ? flat[at] : null;

  const langTitle = (l: PanelLang) => l + " snippets";

  const strip = (
    <div data-start-langs className={"flex shrink-0 items-center gap-0.5 " + WRAP}>
      {PANEL_LANGS.map((l) => {
        const on = l === lang;
        return (
          <button key={l} type="button" data-knav-item data-start-lang={l}
            aria-current={on ? "page" : undefined}
            onClick={() => onLang(l)} title={langTitle(l)}
            className={"relative inline-flex h-[17px] items-center gap-1 rounded-sm px-1.5 text-[10px] leading-none outline-none "
              + (on ? "text-foreground" : "text-muted-foreground hover:text-foreground")}>
            <span>{l}</span>
            {on && <span className="pointer-events-none absolute inset-x-1 bottom-0 h-[1.5px] rounded-full bg-primary" />}
          </button>
        );
      })}
      <span className="mx-1 h-2.5 w-px shrink-0 bg-border" />
      <button type="button" data-knav-item data-start-keys aria-pressed={keysOn}
        onClick={toggleKeys}
        title={keysOn ? "Back to the " + lang + " commands" : "Editor keys: the editor's own keys, not a language"}
        className={"inline-flex h-[17px] items-center gap-1 rounded-sm px-1.5 text-[10px] leading-none outline-none "
          + (keysOn ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground")}>
        <Keyboard size={11} className="shrink-0" />
        <span>Keys</span>
      </button>
      {note && <span data-start-note className="ml-1 min-w-0 truncate text-[9px] text-danger" title={note}>{note}</span>}
    </div>
  );

  return (
    <div data-panel="start" data-size={size} className="h-screen flex flex-col bg-background text-foreground">
      <PanelHeader {...chrome} title={cur ? cur.label : "Start"}
        titleHint={cur ? cur.category : keysOn ? "Editor keys" : lang + " — the language picker and your dictionary"} right={right} />

      <div className="shrink-0 px-2 pt-1 pb-1 border-b border-border/40">
        {strip}
        {!cur && (
          <div className={"mt-1 flex items-center gap-1.5 rounded-md border border-border bg-background px-1.5 " + WRAP}>
            <Search size={11} className="shrink-0 text-muted-foreground" />
            <input value={q} onChange={(e) => setQ(e.target.value)} data-panel-search data-qa="start-search"
              data-knav-own="arrows enter" placeholder={keysOn ? "search keys" : "search commands and recipes"}
              title={keysOn ? "Search what a key does, or the key itself" : "Search labels, descriptions, commands and categories"}
              onKeyDown={(e) => {
                if (e.defaultPrevented) return;
                if (e.key === "ArrowDown" || e.key === "Enter") {
                  e.preventDefault();
                  const el = body.current?.querySelector<HTMLElement>("[data-dict-row]");
                  if (el) { document.documentElement.setAttribute("data-knav", ""); el.focus({ preventScroll: false }); }
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  const t = document.querySelector<HTMLElement>("[data-panel-tab][aria-current]");
                  if (t) { document.documentElement.setAttribute("data-knav", ""); t.focus({ preventScroll: true }); }
                }
              }}
              className="min-w-0 flex-1 bg-transparent py-[3px] text-[11px] outline-none placeholder:text-muted-foreground/60" />
            {q && (
              <button type="button" onClick={() => setQ("")} title="Clear the search"
                className="shrink-0 text-muted-foreground outline-none hover:text-foreground"><X size={11} /></button>
            )}
            <span data-panel-count className="nums shrink-0 text-[9px] text-muted-foreground">
              {tk.length ? flat.length.toLocaleString("en-US") + " of " + total.toLocaleString("en-US")
                : total.toLocaleString("en-US")}
            </span>
          </div>
        )}
      </div>

      <div ref={body} data-panel-body className="min-h-0 flex-1 overflow-y-auto">
        {cur ? (
          <CommandDetail item={cur} size={size} dataset={dataset ?? null}
            onBack={() => setOpen(null)} onNote={setNote} />
        ) : !dict && !failed ? (
          <PanelEmpty>Reading the dictionary</PanelEmpty>
        ) : !total ? (
          <PanelEmpty>{keysOn ? "no keys on this Board yet" : "no entries for " + lang}</PanelEmpty>
        ) : !shown.length ? (
          <PanelEmpty>Nothing matches that search</PanelEmpty>
        ) : (
          <div className={"px-1 pb-2 " + WRAP}>
            {shown.map(({ g, items }) => (
              <section key={g.source + ":" + g.name}>
                <div data-dict-group={g.name} data-dict-source={g.source}
                  className={"sticky top-0 z-10 flex items-center gap-1.5 bg-background px-0.5 "
                    + (folded(size) ? "pt-1 pb-0.5" : "pt-1.5 pb-1")}>
                  <span className="shrink-0 text-[9px] font-medium uppercase leading-[12px] tracking-[0.08em] text-muted-foreground">{g.name}</span>
                  <span className="h-px flex-1 bg-border/70" />
                  <span className="nums shrink-0 text-[9px] leading-[12px] text-muted-foreground">{items.length.toLocaleString("en-US")}</span>
                </div>
                {items.map((it) => (
                  <CommandRow key={it.id} it={it} q={tk} size={size} onOpen={() => openRow(it.id)} />
                ))}
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function CommandRow({ it, q, size, onOpen }: {
  it: PanelDictItem; q: string[]; size: PaneSize; onOpen: () => void;
}) {
  const fold = folded(size);
  const wide = size === "lg" || size === "xl";
  const one = it.cmd.split("\n")[0];
  const cmd = it.multiline ? one + " …" : one;
  return (
    <button type="button" data-knav-item data-dict-row={it.id} onClick={onOpen}
      title={[it.label, it.desc, it.cmd].filter(Boolean).join(" · ")}
      className={"w-full rounded px-1.5 text-left outline-none hover:bg-accent/40 "
        + "focus-visible:bg-accent/50 focus-visible:ring-1 focus-visible:ring-primary/60 "
        + (fold ? "flex flex-col gap-0 py-[1px]" : "grid items-center gap-x-1.5 py-[3px]")}
      style={fold ? undefined
        : { gridTemplateColumns: (wide ? "210px" : "160px") + " minmax(0,1fr) minmax(0,1.3fr)" }}>
      <span className={fold ? "flex w-full min-w-0 items-center gap-1.5" : "contents"}>
        <span className="min-w-0 truncate text-[10.5px] leading-[12px] text-foreground"
          style={fold ? { maxWidth: 168, flexShrink: 0 } : undefined}>
          <Hi text={it.label} q={q} />
        </span>
        <span className={"min-w-0 truncate text-[10px] leading-[12px] text-muted-foreground " + (fold ? "flex-1" : "")}>
          <Hi text={it.desc} q={q} />
        </span>
      </span>
      {it.kind === "keys" ? (
        <span data-dict-cmd-line data-dict-keys
          className={"flex h-[11px] min-w-0 items-center overflow-hidden " + (fold ? "w-full" : "")}>
          <KeyChips cmd={it.cmd} q={q} />
        </span>
      ) : (
        <span data-dict-cmd-line
          className={"min-w-0 truncate font-mono text-[9.5px] leading-[11px] text-muted-foreground "
            + (fold ? "w-full" : "")}>
          <Hi text={cmd} q={q} />
        </span>
      )}
    </button>
  );
}

function CommandDetail({ item, size, dataset, onBack, onNote }: {
  item: PanelDictItem; size: PaneSize; dataset: PhDataset;
  onBack: () => void; onNote: (s: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const backRef = useRef<HTMLButtonElement>(null);

  const keys = item.kind === "keys";          // keys to press: nothing to fill, nothing to send
  const phs = item.placeholders;
  const [vals, setVals] = useState<PhValues>(() => initialValues(phs, item.lane, dataset));
  useEffect(() => { setVals(initialValues(item.placeholders, item.lane, dataset)); },
    [item.id, item.lane, item.placeholders, dataset]);
  const setVal = (name: string, v: string) => setVals((cur) => ({ ...cur, [name]: v }));
  const text = outgoing(item.cmd, vals);
  const keep = () => { for (const p of phs) rememberPh(item.lane, p.name, vals[p.name] || ""); };

  useEffect(() => {
    document.documentElement.setAttribute("data-knav", "");
    backRef.current?.focus({ preventScroll: true });
  }, [item.id]);

  const copy = async () => {
    if (!item.cmd) return;
    const ok = await copyPlain(text);
    if (ok) { keep(); setCopied(true); window.setTimeout(() => setCopied(false), 1500); }
    else onNote("couldn't reach the clipboard");
  };

  return (
    <div data-start-detail={item.id} className={"flex h-full min-h-0 flex-col " + WRAP}>
      <div className="flex shrink-0 items-center gap-1.5 px-1.5 py-1">
        <button ref={backRef} type="button" data-knav-back="2" data-qa="start-back" onClick={onBack}
          title="Back to the dictionary (Esc)"
          className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground outline-none hover:bg-accent hover:text-foreground">
          <ArrowLeft size={12} />
        </button>
        <span data-start-title className="shrink-0 truncate text-[11.5px] font-medium">{item.label}</span>
        <span data-dict-category={item.category}
          className="shrink-0 rounded-sm bg-muted px-1 text-[8.5px] uppercase leading-[13px] tracking-[0.04em] text-muted-foreground">{item.category}</span>
        <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground" title={item.desc}>{item.desc}</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {keys ? (
          <div data-start-keys-detail className="rounded border border-border/60 bg-background px-2 py-1.5">
            <KeyChips cmd={item.cmd} q={[]} big />
          </div>
        ) : (
          <>
            <FilledCode cmd={item.cmd} phs={phs} values={vals} lane={item.lane} />
            <PlaceholderFields phs={phs} values={vals} onChange={setVal} ds={dataset} size={size} />
          </>
        )}

        <div data-start-actions className="mt-1.5 flex items-center gap-1 border-t border-border/40 pt-1.5">
          <button type="button" data-knav-item data-qa="start-copy" onClick={() => void copy()}
            disabled={!item.cmd} title={keys ? "Copy the keys" : "Copy the command"}
            className="inline-flex h-[19px] shrink-0 items-center gap-1 rounded px-1.5 text-[10px] text-muted-foreground outline-none hover:bg-accent hover:text-foreground disabled:opacity-40">
            {copied ? <Check size={11} /> : <Copy size={11} />}{size === "xs" ? "" : "Copy"}
          </button>
        </div>
      </div>
    </div>
  );
}
