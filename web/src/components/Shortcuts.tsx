
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { KEY_GROUPS } from "@/lib/keymap";
import type { KeyGroup, KeyRow } from "@/lib/keymap";

function Row({ r }: { r: KeyRow }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1 text-[13px]">
      <span className="min-w-0 flex-1 text-foreground">{r.what}</span>
      <span className="flex shrink-0 items-center gap-1">
        {r.keys.split(" ").map((k, i) => (
          <kbd key={i} className="nums rounded border border-border bg-secondary px-1.5 py-0.5 text-[11px] font-medium text-secondary-foreground">{k}</kbd>
        ))}
      </span>
    </div>
  );
}

function Group({ g }: { g: KeyGroup }) {
  return (
    <div className="mb-3 break-inside-avoid">
      <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">{g.title}</div>
      <div className="divide-y divide-border/40">{g.rows.map((r) => <Row key={g.title + r.keys} r={r} />)}</div>
    </div>
  );
}

export function Shortcuts({ open, setOpen }: { open: boolean; setOpen: (b: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-3xl">
        <DialogTitle>Keys</DialogTitle>
        <DialogDescription className="sr-only">Every in-app keyboard shortcut, grouped by what it does</DialogDescription>
        <div className="mt-2 max-h-[70vh] overflow-y-auto sm:columns-2 sm:gap-8">
          {KEY_GROUPS.map((g) => <Group key={g.title} g={g} />)}
        </div>
        <div className="mt-2 text-[11px] text-muted-foreground">
          Keys work when you are not typing; a field, the editor and the palette keep their own.
        </div>
      </DialogContent>
    </Dialog>
  );
}
