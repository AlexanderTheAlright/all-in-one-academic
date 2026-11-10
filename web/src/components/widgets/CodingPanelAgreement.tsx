
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { codingApi, type CodingAgreement, type CodingPair } from "@/lib/api";
import { nfmt, type PaneSize } from "@/components/widgets/panel";
import { PanelEmpty } from "@/components/widgets/PanelChrome";

const fa = (x: number | null) => (x === null ? "–" : x.toFixed(2).replace(/^(-?)0\./, "$1."));

export type AgreePick = { code: string; key: string; label: string; units: string[] };

export function CodingAgreementView({ project, set, size, pick, onPick, focusUnit, drawerOpen, onBack, onOpenUnit }: {
  project: string; set: string; size: PaneSize;
  /** the codebook drawer is over this view: its Escape is the drawer's */
  drawerOpen: boolean;
  /** held by the panel, so Esc out of a unit comes back to the same cell and list */
  pick: AgreePick | null; onPick: (p: AgreePick) => void;
  
  focusUnit: string | null;
  onBack: () => void; onOpenUnit: (id: string, ids: string[]) => void;
}) {
  const [a, setA] = useState<CodingAgreement | null>(null);
  const setPick = onPick;
  const backRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    codingApi.agreement(project, set).then((r) => { if (live) setA(r); })
      .catch(() => { if (live) setA({ ok: false, error: "the agreement didn't answer" } as CodingAgreement); });
    return () => { live = false; };
  }, [project, set]);

  // Escape is taken here, not by the engine, whose restore would reach for whatever ⏎
  // last opened -- a unit row whose text a queue row repeats word for word
  const backNow = useRef(onBack);
  backNow.current = onBack;
  const drawerNow = useRef(drawerOpen);
  drawerNow.current = drawerOpen;
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || drawerNow.current) return;
      const a = document.activeElement as HTMLElement | null;
      if (a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.isContentEditable)) return;
      e.preventDefault();
      backNow.current();
    };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, []);

  const stood = useRef(false);
  useEffect(() => {
    if (stood.current || !a) return;
    document.documentElement.setAttribute("data-knav", "");
    const row = focusUnit ? listRef.current?.querySelector<HTMLElement>(`[data-coding-dis-unit="${CSS.escape(focusUnit)}"]`) : null;
    if (row) { row.focus({ preventScroll: false }); stood.current = true; return; }
    if (backRef.current) { backRef.current.focus({ preventScroll: true }); stood.current = true; }
  }, [a, focusUnit, pick]);

  // the first cell that has something to look at is where the list opens
  useEffect(() => {
    if (!a?.ok || pick) return;
    for (const code of a.codes) for (const k of a.coders) {
      const r = a.perCode[code]?.vs[k];
      if (r && r.disagree.length) { setPick({ code, key: k, label: "you vs " + k, units: r.disagree }); return; }
    }
  }, [a, pick]);

  const wide = size !== "xs" && size !== "sm";
  const pairs = useMemo(() => (a?.ok ? Object.keys(a.perCode[a.codes[0]]?.pairs || {}) : []), [a]);

  if (!a) return <PanelEmpty>Reading the agreement</PanelEmpty>;
  if (!a.ok) return <PanelEmpty>{a.error || "the agreement didn't answer"}</PanelEmpty>;

  const cellBtn = (code: string, key: string, label: string, r: CodingPair | undefined) => {
    const on = pick?.code === code && pick.key === key;
    const n = r?.n || 0;
    const dis = r ? r.nDisagree || r.disagree.length : 0;
    return (
      <button type="button" data-knav-item data-coding-agree-cell={code + ":" + key}
        onClick={() => { setPick({ code, key, label, units: r?.disagree || [] });
          window.setTimeout(() => { listRef.current?.querySelector<HTMLElement>("[data-coding-dis-unit]")?.focus({ preventScroll: false }); }, 0); }}
        title={label + " on " + code + ": alpha " + fa(r?.alpha ?? null) + ", agreement " + (r?.pct === null || r?.pct === undefined ? "–" : Math.round(r.pct * 100) + "%")
          + ", n " + n + (dis ? ", " + dis + " disagreeing" : "")}
        className={"inline-flex w-full min-w-[54px] flex-col items-center rounded px-1 py-[2px] outline-none focus-visible:ring-1 focus-visible:ring-primary/60 "
          + (on ? "bg-accent " : "hover:bg-accent/50 ")}>
        <span className={"nums text-[11px] font-medium " + (r?.alpha !== null && r?.alpha !== undefined && r.alpha < 0.667 ? "text-danger" : "text-foreground")}>
          {fa(r?.alpha ?? null)}
        </span>
        <span className="nums text-[8.5px] text-muted-foreground">n {nfmt(n)}{dis ? " · " + dis : ""}</span>
      </button>
    );
  };

  return (
    <div data-coding-agreement className="flex h-full min-h-0 flex-col">
      <div className="flex h-6 shrink-0 items-center gap-1.5 border-b border-border/40 px-2">
        <button ref={backRef} type="button" data-knav-back="2" data-qa="coding-agreement-back" onClick={onBack} title="Back to the queue (Esc)"
          className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground outline-none hover:bg-accent hover:text-foreground">
          <ArrowLeft size={12} />
        </button>
        <span className="text-[10.5px] font-medium">Agreement</span>
        <span className="nums text-[10px] text-muted-foreground" title="Units you have marked done">
          {nfmt(a.nDone)}/{nfmt(a.nUnits)} done
        </span>
      </div>
      <div className="tinybar min-h-0 flex-1 overflow-y-auto px-2 py-1">
        <div className={"mx-auto max-w-[1180px] " + (wide ? "grid grid-cols-[minmax(0,1fr)_minmax(0,0.8fr)] gap-3" : "")}>
          <div>
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className="py-[2px] pr-1 text-left text-[9px] font-medium uppercase tracking-[0.08em] text-muted-foreground">you vs</th>
                  {a.coders.map((k) => (
                    <th key={k} className="px-0.5 py-[2px] text-center text-[10px] font-medium text-muted-foreground">{k}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {a.codes.map((code) => (
                  <tr key={code}>
                    <th scope="row" className="truncate py-[1px] pr-1 text-left text-[10px] font-normal text-muted-foreground" style={{ maxWidth: 120 }} title={code}>{code}</th>
                    {a.coders.map((k) => (
                      <td key={k} className="px-0.5 py-[1px]">{cellBtn(code, k, "you vs " + k, a.perCode[code]?.vs[k])}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {pairs.length > 0 && (
              <table className="mt-2 w-full border-collapse">
                <thead>
                  <tr>
                    <th className="py-[2px] pr-1 text-left text-[9px] font-medium uppercase tracking-[0.08em] text-muted-foreground">among coders</th>
                    {pairs.map((p) => (
                      <th key={p} className="px-0.5 py-[2px] text-center text-[9.5px] font-medium text-muted-foreground">{p.replace("|", " · ")}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {a.codes.map((code) => (
                    <tr key={code}>
                      <th scope="row" className="truncate py-[1px] pr-1 text-left text-[10px] font-normal text-muted-foreground" style={{ maxWidth: 120 }}>{code}</th>
                      {pairs.map((p) => (
                        <td key={p} className="px-0.5 py-[1px]">{cellBtn(code, p, p.replace("|", " vs "), a.perCode[code]?.pairs[p])}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <div ref={listRef} data-coding-dis-list className={wide ? "" : "mt-2"}>
            <div className="sticky top-0 z-10 flex items-center gap-1.5 bg-background pt-1 pb-1">
              <span className="min-w-0 truncate text-[9px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                {pick ? pick.code + " · " + pick.label : "disagreements"}
              </span>
              <span className="h-px flex-1 bg-border/70" />
              <span className="nums text-[9px] text-muted-foreground">{pick ? pick.units.length : 0}</span>
            </div>
            {!pick || !pick.units.length ? (
              <div data-coding-none className="py-1 text-[10.5px] text-muted-foreground">
                {a.nDone ? "No disagreements here" : "Nothing marked done yet"}
              </div>
            ) : pick.units.map((id) => (
              <button key={id} type="button" data-knav-item data-coding-dis-unit={id}
                onClick={() => onOpenUnit(id, pick.units)} title={id + (a.previews[id] ? ": " + a.previews[id] : "")}
                className="flex w-full items-center gap-1.5 rounded px-1.5 py-[2px] text-left outline-none hover:bg-accent/40 focus-visible:bg-accent/50 focus-visible:ring-1 focus-visible:ring-primary/60">
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{id}</span>
                <span className="min-w-0 flex-1 truncate text-[10.5px]">{a.previews[id] || ""}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
