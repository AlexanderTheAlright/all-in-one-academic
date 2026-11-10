
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Loader2, PenLine, X } from "lucide-react";
import { api } from "@/lib/api";

const DRAWIO_ORIGIN = "https://embed.diagrams.net";
const DRAWIO_URL = DRAWIO_ORIGIN + "/?embed=1&proto=json&spin=1&libraries=1&ui=atlas&saveAndExit=0";

export function DiagramEditor({ slug, name, title, onSaved, onClose }: {
  slug: string;
  name: string | null;   // existing figure basename (fig.NN.slug.png) — null starts a NEW diagram
  title?: string;        // short name for a new diagram -> fig.<next>.<slug-of-title>.png
  onSaved: (stem: string, firstSave: boolean) => void;
  onClose: () => void;
}) {
  const initialStem = name ? name.replace(/^.*[\\/]/, "").replace(/\.(png|drawio|svg)$/i, "") : null;
  const [stem, setStem] = useState<string | null>(initialStem);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const xmlRef = useRef("");                       // latest editor XML (arrives with the save event)
  const mtimeRef = useRef<number | undefined>(undefined);
  const stemRef = useRef<string | null>(initialStem);
  const initXmlRef = useRef<string | null>(null);  // fetched source, held until draw.io says init
  const initSeenRef = useRef(false);
  const loadSentRef = useRef(false);
  const insertedRef = useRef(false);               // the new-diagram embed inserts exactly once
  const onSavedRef = useRef(onSaved); onSavedRef.current = onSaved;
  const onCloseRef = useRef(onClose); onCloseRef.current = onClose;

  const post = useCallback((msg: Record<string, unknown>) => {
    frame.current?.contentWindow?.postMessage(JSON.stringify(msg), DRAWIO_ORIGIN);
  }, []);
  const maybeLoad = useCallback(() => {
    if (!initSeenRef.current || initXmlRef.current === null || loadSentRef.current) return;
    loadSentRef.current = true;
    post({ action: "load", autosave: 0, xml: initXmlRef.current, title: stemRef.current || title || "diagram" });
  }, [post, title]);

  // fetch the existing .drawio source (an empty canvas for a new diagram)
  useEffect(() => {
    let live = true;
    if (!name) { initXmlRef.current = ""; maybeLoad(); return; }
    api.draftingDiagram(slug, name).then((r) => {
      if (!live) return;
      if (r.error) { toast.error("Couldn't read the diagram source: " + r.error); onCloseRef.current(); return; }
      initXmlRef.current = r.xml || "";
      mtimeRef.current = r.mtime || undefined;
      if (r.stem) { stemRef.current = r.stem; setStem(r.stem); }
      maybeLoad();
    }).catch(() => { if (live) { toast.error("Couldn't reach the diagram endpoint"); onCloseRef.current(); } });
    return () => { live = false; };
  }, [slug, name, maybeLoad]);

  const persist = useCallback(async (pngDataUrl: string) => {
    const body = { slug, name: stemRef.current || undefined, title, xml: xmlRef.current, png: pngDataUrl, baseMtime: mtimeRef.current };
    const finish = (r: { stem?: string; mtime?: number }) => {
      mtimeRef.current = r.mtime;
      if (r.stem && !stemRef.current) { stemRef.current = r.stem; setStem(r.stem); }
      setSavedAt(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
      post({ action: "status", message: "saved", modified: false });
      const first = !name && !insertedRef.current;
      insertedRef.current = true;
      toast.success("Saved " + (r.stem || stemRef.current) + ".png");
      if (r.stem) onSavedRef.current(r.stem, first);
    };
    try {
      const r = await api.draftingDiagramSave(body);
      if (r.conflict) {
        if (window.confirm("This diagram changed on disk since you opened it — overwrite with your version?")) {
          const rf = await api.draftingDiagramSave({ ...body, baseMtime: r.currentMtime });
          if (rf.ok) finish(rf); else toast.error(rf.error || "diagram save failed");
        } else {
          post({ action: "status", message: "not saved — changed on disk", modified: true });
        }
      } else if (r.ok) finish(r);
      else toast.error(r.error || "diagram save failed");
    } catch {
      toast.error("Diagram save failed — is the server up?");
    } finally {
      setSaving(false);
    }
  }, [slug, name, title, post]);

  // the draw.io embed protocol: init -> load(xml); Save -> save event (xml) -> we
  // request an xmlpng export -> export event (png data URL) -> persist both
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.origin !== DRAWIO_ORIGIN || typeof e.data !== "string" || !e.data) return;
      let msg: { event?: string; xml?: string; data?: string; modified?: boolean };
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.event === "init") { initSeenRef.current = true; maybeLoad(); }
      else if (msg.event === "load") setReady(true);
      else if (msg.event === "save") {
        xmlRef.current = msg.xml || xmlRef.current;
        setSaving(true);
        // xmlpng embeds the diagram XML in the PNG itself; scale for print sharpness
        post({ action: "export", format: "xmlpng", scale: 2.5, border: 4 });
      } else if (msg.event === "export") {
        if (msg.data) void persist(msg.data);
        else { setSaving(false); toast.error("draw.io returned no image"); }
      } else if (msg.event === "exit") onCloseRef.current();
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [maybeLoad, persist, post]);

  // Esc closes (draw.io's own Exit button guards unsaved changes; this path confirms)
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault(); e.stopPropagation();
      if (window.confirm("Close the diagram editor? Unsaved changes will be lost.")) onCloseRef.current();
    };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, []);

  return (
    <div role="dialog" aria-modal="true" aria-label="Diagram editor" data-knav-modal className="fixed inset-0 z-[170] bg-background flex flex-col animate-in fade-in duration-150">
      <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-border">
        <PenLine size={15} className="text-primary shrink-0" />
        <span className="text-[13px] font-medium truncate">{stem ? stem + ".png" : (title || "New diagram")}</span>
        <span className="text-[11px] text-muted-foreground truncate">
          concept diagram — Save writes results/{stem || "fig.<next>." + (title || "…")}.png + its editable .drawio source</span>
        <span className="flex-1" />
        {saving ? (
          <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground"><Loader2 size={12} className="animate-spin" /> saving…</span>
        ) : savedAt ? (
          <span className="text-[11px] text-muted-foreground nums">saved {savedAt}</span>
        ) : null}
        <button
          onClick={() => { if (window.confirm("Close the diagram editor? Unsaved changes will be lost.")) onClose(); }}
          type="button" data-knav-back="2" aria-label="Close"
          title="Close (Esc)" className="w-7 h-7 rounded-md hover:bg-accent inline-flex items-center justify-center">
          <X size={16} />
        </button>
      </div>
      <div className="flex-1 min-h-0 relative">
        <iframe ref={frame} src={DRAWIO_URL} title="draw.io diagram editor" className="absolute inset-0 w-full h-full border-0" />
        {!ready && (
          <div className="absolute inset-0 bg-background flex items-center justify-center">
            <div className="text-center space-y-2">
              <Loader2 size={20} className="animate-spin mx-auto text-muted-foreground" />
              <p className="text-[12.5px] text-muted-foreground">Loading the draw.io editor… (needs internet; the diagram itself never leaves this page)</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
