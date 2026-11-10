
import { useState } from "react";
import { Copy } from "lucide-react";
import type { ExploreSpec } from "@/lib/api";
import { Chip, IconBtn } from "@/components/explore/ui";

export const homeRel = (p: string) => (p || "").replace(/^\/home\/[^/]+\//, "~/").replace(/^\/Users\/[^/]+\//, "~/");

function Row({ label, value, copy }: { label: string; value: string; copy?: boolean }) {
  const [done, setDone] = useState(false);
  if (!value) return null;
  return (
    <div className="flex min-w-0 items-start gap-2 py-[3px]">
      <span className="w-[68px] shrink-0 text-[10.5px] uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 break-all text-[12px] text-foreground">{value}</span>
      {copy && (
        <IconBtn title={done ? "Copied" : "Copy this path"} on={done}
          onClick={() => {
            navigator.clipboard?.writeText(value).then(() => { setDone(true); window.setTimeout(() => setDone(false), 1200); }, () => {});
          }}><Copy size={12} /></IconBtn>
      )}
    </div>
  );
}

export function SourcePanel({ spec, nRows, truncated }: { spec: ExploreSpec; nRows: number; truncated: boolean }) {
  const [copied, setCopied] = useState(false);
  const s = spec.source;
  return (
    <div className="space-y-3 p-3">
      <section className="rounded-md border border-border p-2">
        <Row label="Family" value={s?.family || ""} />
        <Row label="Key" value={s?.key || ""} />
        <Row label="Path" value={homeRel(s?.path || "")} copy />
        <Row label="Filter" value={s?.filter || ""} />
        <Row label="Rows" value={String(nRows || s?.n_rows || 0) + (truncated ? " (truncated)" : "")} />
        <Row label="Note" value={s?.note || ""} />
        {!!(s?.columns || []).length && (
          <div className="flex flex-wrap items-center gap-1 pt-1.5">
            {(s?.columns || []).map((c) => <Chip key={c} title="Column pulled for this figure">{c}</Chip>)}
          </div>
        )}
        {!s && <p className="text-[12px] text-muted-foreground">No recorded source</p>}
      </section>

      {!!spec.code && (
        <section className="rounded-md border border-border">
          <div className="flex items-center gap-2 border-b border-border px-2 py-1">
            <span className="text-[10.5px] uppercase tracking-wide text-muted-foreground">Code</span>
            <span className="ml-auto">
              <IconBtn title={copied ? "Copied" : "Copy the code that made this figure"} on={copied}
                onClick={() => {
                  navigator.clipboard?.writeText(spec.code).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1200); }, () => {});
                }}><Copy size={12} /></IconBtn>
            </span>
          </div>
          <pre className="tinybar max-h-[280px] overflow-auto p-2 font-mono text-[11px] leading-snug text-foreground">{spec.code}</pre>
        </section>
      )}

      <section className="rounded-md border border-border p-2">
        <span className="text-[10.5px] uppercase tracking-wide text-muted-foreground">History</span>
        <ul className="mt-1 space-y-1">
          {[...(spec.history || [])].reverse().map((h, i) => (
            <li key={`${h.version}-${i}`} className="flex items-baseline gap-2 text-[11.5px]">
              <Chip tone={h.version === spec.version ? "accent" : "muted"} title="Spec version">v{h.version}</Chip>
              <span className="text-muted-foreground">{h.by}</span>
              <span className="min-w-0 flex-1 truncate text-foreground" title={h.note || ""}>{h.note || ""}</span>
              <span className="shrink-0 text-muted-foreground">{(h.at || "").slice(0, 16).replace("T", " ")}</span>
            </li>
          ))}
          {!(spec.history || []).length && <li className="text-[12px] text-muted-foreground">No recorded history</li>}
        </ul>
      </section>
    </div>
  );
}
