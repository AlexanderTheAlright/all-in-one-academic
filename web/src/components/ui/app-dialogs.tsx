
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

export type PromptOpts = { title: string; description?: string; defaultValue?: string; placeholder?: string; confirmLabel?: string };
export type ConfirmOpts = { title: string; description?: string; confirmLabel?: string; danger?: boolean };
type DialogRequest =
  | ({ kind: "prompt" } & PromptOpts & { resolve: (v: string | null) => void })
  | ({ kind: "confirm" } & ConfirmOpts & { resolve: (v: boolean) => void });

const DialogsContext = createContext<{
  prompt: (o: PromptOpts) => Promise<string | null>;
  confirm: (o: ConfirmOpts) => Promise<boolean>;
} | null>(null);

export function useDialogs() {
  const ctx = useContext(DialogsContext);
  if (!ctx) throw new Error("useDialogs must be used inside <DialogsProvider>");
  return ctx;
}

export function DialogsProvider({ children }: { children: ReactNode }) {
  const [req, setReq] = useState<DialogRequest | null>(null);
  const [value, setValue] = useState("");
  const pending = useRef<DialogRequest | null>(null);

  const settle = useCallback((r: DialogRequest | null, result: string | null | boolean) => {
    if (!r) return;
    if (r.kind === "prompt") r.resolve(typeof result === "string" ? result : null);
    else r.resolve(result === true);
  }, []);
  // dismissal for whatever kind is open: a prompt hands back null, a confirm false
  const dismissed = (r: DialogRequest | null) => (r?.kind === "confirm" ? false : null);
  const finish = useCallback((result: string | null | boolean) => {
    const r = pending.current;
    pending.current = null;
    setReq(null);
    settle(r, result);
  }, [settle]);
  const ask = useCallback((next: DialogRequest) => {
    const prev = pending.current;     // a second ask never strands the first
    pending.current = next;
    setReq(next);
    settle(prev, dismissed(prev));
  }, [settle]);
  useEffect(() => () => { const r = pending.current; pending.current = null; settle(r, dismissed(r)); }, [settle]);

  const prompt = useCallback((o: PromptOpts) => new Promise<string | null>((resolve) => {
    setValue(o.defaultValue || "");
    ask({ kind: "prompt", resolve, ...o });
  }), [ask]);
  const confirm = useCallback((o: ConfirmOpts) => new Promise<boolean>((resolve) => {
    ask({ kind: "confirm", resolve, ...o });
  }), [ask]);
  const value_ctx = useMemo(() => ({ prompt, confirm }), [prompt, confirm]);

  const submitPrompt = () => finish(value.trim() || null);

  return (
    <DialogsContext.Provider value={value_ctx}>
      {children}
      <Dialog open={!!req} onOpenChange={(o) => { if (!o) finish(req?.kind === "confirm" ? false : null); }}>
        <DialogContent className="sm:max-w-md">
          {req && (
            <>
              <DialogHeader>
                <DialogTitle>{req.title}</DialogTitle>
                {req.description && <DialogDescription>{req.description}</DialogDescription>}
              </DialogHeader>
              {req.kind === "prompt" && (
                <Input autoFocus value={value} onChange={(e) => setValue(e.target.value)}
                  placeholder={req.placeholder} className="h-9 text-[13.5px]"
                  onKeyDown={(e) => { if (e.key === "Enter") submitPrompt(); }} />
              )}
              <DialogFooter>
                <button onClick={() => finish(req.kind === "confirm" ? false : null)}
                  className="text-[13px] text-muted-foreground hover:text-foreground px-3 py-1.5 transition-colors">Cancel</button>
                <button onClick={() => (req.kind === "prompt" ? submitPrompt() : finish(true))}
                  className={`text-[13px] rounded-md px-3.5 py-1.5 hover:opacity-90 transition-opacity ${
                    req.kind === "confirm" && req.danger ? "bg-destructive text-destructive-foreground" : "bg-primary text-primary-foreground"}`}>
                  {req.confirmLabel || (req.kind === "confirm" ? "Confirm" : "Save")}
                </button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </DialogsContext.Provider>
  );
}
