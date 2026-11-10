
import { useEffect, useState } from "react";
import { Toaster } from "@/components/ui/sonner";
import { DiagramsView } from "@/components/Aioa";
import { pathDiagram } from "@/lib/pathroute";
import { setPendingDiagramStart } from "@/lib/taskdest";

// DiagramsView lays its grid out by the frame it is drawn in (ui/widget.tsx); here the
// frame is the window, with breakpoints that keep a card wide enough for its four buttons
const sizeOf = (w: number) => (w < 700 ? "xs" : w < 1000 ? "sm" : w < 1300 ? "md" : w < 1700 ? "lg" : "xl");
const drawerOpen = () => !!document.querySelector('[role=dialog][aria-label="Diagram drawer"]');

export function DiagramWidget({ library = false }: { library?: boolean }) {
  // set BEFORE DiagramsView mounts, so its mount effect finds the target
  useState(() => { if (!library) setPendingDiagramStart(pathDiagram() ?? { kind: "new" }); return 0; });
  const [size, setSize] = useState(() => sizeOf(window.innerWidth));
  useEffect(() => {
    const on = () => setSize(sizeOf(window.innerWidth));
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);

  useEffect(() => {
    if (library || pathDiagram()) return;
    let away = false;
    const blur = () => { away = true; };
    const focus = () => {
      if (!away) return;
      away = false;
      if (!drawerOpen()) setPendingDiagramStart({ kind: "new" });
    };
    window.addEventListener("blur", blur);
    window.addEventListener("focus", focus);
    return () => { window.removeEventListener("blur", blur); window.removeEventListener("focus", focus); };
  }, [library]);

  return (
    <div data-size={size} className="group/widget mx-auto h-full w-full max-w-[1720px] overflow-y-auto">
      <Toaster position="bottom-right" />
      <DiagramsView />
    </div>
  );
}
