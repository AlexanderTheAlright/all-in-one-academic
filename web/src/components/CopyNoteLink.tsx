import { Link2 } from "lucide-react";
import { toast } from "sonner";
import { copyPlain } from "@/lib/clipboard";
import { PRIMARY_SOURCES_DIR } from "@/lib/paths";

export const citePath = (name: string, collection?: string) =>
  collection === "historical" ? `${PRIMARY_SOURCES_DIR}/Citations/${name}.md` : `Preparation/Reading/Citations/${name}.md`;

export function CopyNoteLink({ citationName, vaultPath, collection, className = "opacity-0 group-hover/item:opacity-100 group-focus-within/item:opacity-100 transition-opacity" }:
{ citationName: string; vaultPath?: string; collection?: string; className?: string }) {
  const copy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const path = vaultPath ? `${vaultPath}/${citePath(citationName, collection)}` : citePath(citationName, collection);
    (await copyPlain(path))
      ? toast("Note path copied", { description: "Paste it wherever you need the note" })
      : toast.error("Couldn't copy");
  };
  return (
    <button type="button" onClick={copy} title="Copy the note's file path"
      className={`text-muted-foreground hover:text-primary shrink-0 focus-visible:opacity-100 ${className}`}>
      <Link2 size={13} />
    </button>
  );
}
