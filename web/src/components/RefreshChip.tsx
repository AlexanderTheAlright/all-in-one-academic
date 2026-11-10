
import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { syncedAgo } from "@/lib/format";

export function RefreshChip({ generated, onRefresh }: { generated?: string; onRefresh: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const go = async () => {
    if (busy) return;
    setBusy(true);
    try { await onRefresh(); toast("Analytics refreshed from the vault"); }
    catch { toast.error("Refresh failed"); }
    finally { setBusy(false); }
  };
  const label = busy ? "refreshing…" : generated ? `synced ${syncedAgo(generated)}` : "refresh";
  return (
    <button onClick={go} disabled={busy} title="Rebuild analytics from the vault now"
      className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground hover:text-foreground transition-colors nums disabled:opacity-60">
      <RefreshCw size={12} className={busy ? "animate-spin" : ""} /> {label}
    </button>
  );
}
