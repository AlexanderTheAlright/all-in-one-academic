
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, BookOpen, Bot, Check, ChevronDown, ChevronUp, CircleHelp, Crop, X } from "lucide-react";
import { codingApi, type CodingAnchor, type CodingCode, type CodingCoderInfo, type CodingConfidence, type CodingContext,
  type CodingMedia, type CodingRecord, type CodingUnit, type CodingVerdict } from "@/lib/api";
import { CodingMediaBlock, anchorLabel, isSpan, warmMedia, type MediaHandle } from "@/components/widgets/CodingPanelMedia";
import { useSaveKey } from "@/lib/savekey";
import { readerScroll } from "@/lib/scroll";
import { useRestIntent } from "@/lib/restIntent";
import { PanelEmpty, useBracketStep } from "@/components/widgets/PanelChrome";
import { DraftDot } from "@/components/widgets/CodingPanelCodebookEdit";
import { nfmt, type PaneSize } from "@/components/widgets/panel";

type CodeState = { present: boolean; confidence: CodingConfidence; evidence: string; anchor?: CodingAnchor };
type Local = { unit: string; codes: Record<string, CodeState>; note: string; done: boolean };
type SaveState = { s: "idle" | "saving" | "saved" | "conflict" | "error"; msg?: string };

const FIELD = new Set(["INPUT", "TEXTAREA", "SELECT"]);
const NOTE_DEBOUNCE = 250;
const CACHE_MAX = 24;
/** the first sentence of a definition, when the codebook has no `short` */
const firstLine = (s: string) => {
  const t = s.replace(/\s+/g, " ").trim();
  const m = /^(.{20,}?[.;:])(\s|$)/.exec(t);
  return m ? m[1] : t;
};
/** what a code is called on screen: its `display`, else its label made readable */
export const codeName = (c: { label: string; display?: string }) => {
  if (c.display) return c.display;
  const t = c.label.replace(/_/g, " ").trim();
  return /[a-z]/.test(t) ? t : t.charAt(0) + t.slice(1).toLowerCase();
};
const codeShort = (c: CodingCode) => c.short || firstLine(c.definition);
const NEXT_CONF: Record<CodingConfidence, CodingConfidence> = { high: "medium", medium: "low", low: "high" };
const CONF_SHORT: Record<string, string> = { high: "hi", medium: "med", low: "lo" };
const VERDICTS: { v: CodingVerdict; label: string; key: string }[] = [
  { v: "agree", label: "Agree", key: "a" }, { v: "disagree", label: "Disagree", key: "d" }, { v: "unsure", label: "Unsure", key: "u" },
];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function niceDate(v: string): string {
  const m = /^(\d{4})-(\d\d)-(\d\d)/.exec(v.trim());
  if (!m) return v;
  const mo = Number(m[2]);
  return mo >= 1 && mo <= 12 ? Number(m[3]) + " " + MONTHS[mo - 1] + " " + m[1] : v;
}

const firstClause = (v: string) => v.split(/\s*;\s*|\s+\+\s+/)[0].trim() || v;

export function metaParts(meta: Record<string, string>): { key: string; text: string; title: string }[] {
  const has = (k: string) => (meta[k] ?? "").trim() !== "";
  const out: { key: string; text: string; title: string }[] = [];
  const used = new Set<string>();
  const sub = Object.keys(meta).find((k) => /^(subreddit|sub)$/i.test(k) && has(k));
  if (sub) { out.push({ key: sub, text: /^r\//.test(meta[sub]) ? meta[sub] : "r/" + meta[sub], title: "subreddit" }); used.add(sub); }
  const date = Object.keys(meta).find((k) => /^(date|created_utc|created|posted)$/i.test(k) && has(k));
  if (date) { out.push({ key: date, text: niceDate(meta[date]), title: meta[date] }); used.add(date); }
  const day = Object.keys(meta).find((k) => /^days?_after(_release)?$/i.test(k) && has(k));
  const rel = has("release") ? "release" : "";
  const relDate = has("release_date") ? meta.release_date : "";
  if (day && /^-?\d+$/.test(meta[day].trim())) {
    const n = Number(meta[day]);
    const what = rel ? firstClause(meta[rel]) : "the release";
    out.push({ key: day, text: n === 0 ? "release day, " + what : n + (n === 1 ? " day" : " days") + " after " + what,
      title: (rel ? meta[rel] : "") + (relDate ? " · released " + niceDate(relDate) : "") });
    used.add(day);
    if (rel) used.add(rel);
  } else if (rel) {
    out.push({ key: rel, text: firstClause(meta[rel]), title: meta[rel] + (relDate ? " · released " + niceDate(relDate) : "") });
    used.add(rel);
  }
  used.add("release_date");
  for (const [k, v] of Object.entries(meta)) {
    if (used.has(k) || !has(k)) continue;
    out.push({ key: k, text: /^\d{4}-\d\d-\d\dT/.test(v) ? niceDate(v) : v, title: k.replace(/_/g, " ") });
  }
  return out;
}

/** a code's state by its label, never anything the prototype chain would answer */
const stateOf = (codes: Record<string, CodeState>, label: string): CodeState | undefined =>
  (Object.prototype.hasOwnProperty.call(codes, label) ? codes[label] : undefined);

function fromRecord(unit: string, codebook: CodingCode[], rec: CodingRecord | null): Local {
  const codes: Record<string, CodeState> = Object.create(null);
  for (const c of codebook) {
    if (c.derived) continue;
    const d = rec?.details.find((x) => x.code === c.label);
    codes[c.label] = { present: !!d?.present, confidence: d?.confidence || "high", evidence: d?.evidence || "",
      ...(d?.present && d.anchor ? { anchor: d.anchor } : {}) };
  }
  return { unit, codes, note: rec?.note || "", done: !!rec?.done };
}

/** where a quote sits in the text: exact first, then across a line break the DOM flattened */
function locate(text: string, quote: string): [number, number] | null {
  if (!quote) return null;
  const i = text.indexOf(quote);
  if (i >= 0) return [i, i + quote.length];
  const words = quote.split(/\s+/).filter(Boolean).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!words.length) return null;
  const m = new RegExp(words.join("\\s+")).exec(text);
  return m ? [m.index, m.index + m[0].length] : null;
}

/** the selection inside the post as offsets into the unit's own text */
function selectionIn(box: HTMLElement | null, text: string): [number, number] | null {
  const sel = window.getSelection();
  if (!box || !sel || !sel.rangeCount || sel.isCollapsed) return null;
  const r = sel.getRangeAt(0);
  if (!box.contains(r.startContainer) || !box.contains(r.endContainer)) return null;
  const pre = document.createRange();
  pre.selectNodeContents(box);
  pre.setEnd(r.startContainer, r.startOffset);
  let a = pre.toString().length;
  let b = a + r.toString().length;
  while (a < b && /\s/.test(text[a] || "")) a++;
  while (b > a && /\s/.test(text[b - 1] || "")) b--;
  return b > a ? [a, b] : null;
}

type Mark = { a: number; b: number; kind: "mine" | "theirs"; code: string };

function Segments({ text, marks, hot }: { text: string; marks: Mark[]; hot: string | null }) {
  const cuts = new Set<number>([0, text.length]);
  for (const m of marks) { cuts.add(m.a); cuts.add(m.b); }
  const pts = Array.from(cuts).filter((x) => x >= 0 && x <= text.length).sort((x, y) => x - y);
  const out: React.ReactNode[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (b <= a) continue;
    const on = marks.filter((m) => m.a <= a && m.b >= b);
    const mine = on.filter((m) => m.kind === "mine");
    const theirs = on.some((m) => m.kind === "theirs");
    const strong = mine.some((m) => m.code === hot);
    const cls = (mine.length ? (strong ? "rounded-[2px] bg-primary/45 " : "rounded-[2px] bg-primary/20 ") : "")
      + (theirs ? "underline decoration-primary decoration-2 underline-offset-[3px] bg-accent " : "");
    out.push(
      <span key={a} data-o={a} className={cls || undefined}
        data-coding-evidence={mine.length ? mine.map((m) => m.code).join(" ") : undefined}
        data-coding-theirs={theirs ? "" : undefined}>{text.slice(a, b)}</span>);
  }
  return <>{out}</>;
}

/** A block of thread context, clamped to `lines` until its key (or a click) opens it.
 *  Clamped, its blank lines fold into spaces so the lines shown carry words. */
function Clamp({ lines, open, onToggle, keyName, what, attr, className, text }: {
  lines: number; open: boolean; onToggle: () => void; keyName: string; what: string; attr: string;
  className: string; text: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [over, setOver] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const f = () => setOver(el.scrollHeight > el.clientHeight + 1);
    f();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(f) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [text, open]);
  const can = over || open;
  return (
    <div {...{ [attr]: open ? "open" : "clamped" }} className={"group relative " + className}>
      <div ref={ref} className={"break-words " + (open ? "whitespace-pre-wrap" : "")}
        style={open ? undefined : { display: "-webkit-box", WebkitLineClamp: lines, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
        {open ? text.trim() : text.replace(/\s+/g, " ").trim()}
      </div>
      {can && (
        <button type="button" data-knav-item onClick={onToggle} onMouseDown={(e) => e.preventDefault()}
          title={(open ? "Fold the " : "The whole ") + what + " (" + keyName + ")"}
          className="mt-0.5 inline-flex h-4 items-center rounded px-0.5 text-muted-foreground/80 outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-primary/60">
          {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </button>
      )}
    </div>
  );
}

export function CodingUnitView({ project, set, unitId, ids, codebook, coders, size, roomy = false, twoCol = false, counts = null,
  doneIds = null, noteMax = 2000, choice = "multi", confidence = false, onStep, onBack, onCodebook, drawerOpen,
  draftMarks = null, bookVersion = "", onEdit, onMemo, flushRef }: {
  project: string; set: string; unitId: string; ids: string[];
  codebook: CodingCode[]; coders: CodingCoderInfo[]; size: PaneSize;
  /** >= 800 px: the codebook docks beside the text */
  roomy?: boolean;
  /** >= 1000 px: reading and decision side by side */
  twoCol?: boolean;
  /** the set's done/total as the queue last read it */
  counts?: { done: number; total: number } | null;
  /** every unit already done, so Enter can skip to the next one that is not */
  doneIds?: string[] | null;
  /** the server's note cap */
  noteMax?: number;
  /** single: one code per unit */
  choice?: "single" | "multi";
  /** show the confidence chips (and Shift+1-9) */
  confidence?: boolean;
  onStep: (id: string) => void; onBack: () => void;
  onCodebook: (label: string) => void; drawerOpen: boolean;
  /** the codes whose wording differs in the codebook's draft */
  draftMarks?: Set<string> | null;
  /** the codebook version in use: a promotion changes it, and the unit is read again */
  bookVersion?: string;
  onEdit?: (label: string) => void; onMemo?: () => void;
  /** lets a promotion wait for this unit's last save */
  flushRef?: React.MutableRefObject<(() => Promise<void>) | null>;
}) {
  const [u, setU] = useState<CodingUnit | null>(null);
  const [doneN, setDoneN] = useState<{ done: number; total: number } | null>(counts);
  const [jump, setJump] = useState<string | null>(null);
  const [local, setLocal] = useState<Local | null>(null);
  const [save, setSave] = useState<SaveState>({ s: "idle" });
  const [hot, setHot] = useState<string | null>(null);
  const [cell, setCell] = useState<{ coder: string; code: string } | null>(null);
  const [peek, setPeek] = useState<{ coder: string; code: string } | null>(null);
  const [reviewNote, setReviewNote] = useState("");
  const [openerOpen, setOpenerOpen] = useState(false);
  const [parentOpen, setParentOpen] = useState(false);
  const cbRef = useRef(codebook);
  cbRef.current = codebook;
  const textRef = useRef<HTMLDivElement>(null);
  const postRef = useRef<HTMLDivElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const mediaRef = useRef<MediaHandle>(null);
  const [aheadTick, setAheadTick] = useState(0);
  const [warm, setWarm] = useState<CodingMedia | null>(null);
  const jumpRef = useRef<HTMLInputElement>(null);
  const localRef = useRef<Local | null>(null);
  // the Local last drawn from the server: a re-read may replace it only while it is untouched
  const shown = useRef<Local | null>(null);
  // units read ahead or already seen, so a step draws at once
  const cache = useRef(new Map<string, CodingUnit>());
  const ahead = useRef(new Set<string>());
  const unitRef = useRef(unitId);
  unitRef.current = unitId;
  const bases = useRef(new Map<string, string>());
  const queue = useRef(new Map<string, Local>());
  const result = useRef(new Map<string, "ok" | "conflict" | "error">());
  const running = useRef<Promise<void> | null>(null);
  const flying = useRef<string | null>(null);
  const timer = useRef<number | null>(null);
  const drawerRef = useRef(drawerOpen);
  drawerRef.current = drawerOpen;
  // docked, the codebook is beside the text and the unit keeps its keys
  const dockedRef = useRef(roomy);
  dockedRef.current = roomy;
  // the units known done: the queue's list, then every save this view makes
  const doneSet = useRef(new Set<string>(doneIds || []));
  const [doneTick, setDoneTick] = useState(0);
  useEffect(() => {
    if (!doneIds) return;
    for (const x of doneIds) doneSet.current.add(x);
    setDoneTick((t) => t + 1);
  }, [doneIds]);

  useEffect(() => { if (counts) setDoneN(counts); }, [counts?.done, counts?.total]);  // eslint-disable-line react-hooks/exhaustive-deps

  const remember = useCallback((uid: string, d: CodingUnit) => {
    const c = cache.current;
    c.delete(uid);
    c.set(uid, d);
    while (c.size > CACHE_MAX) c.delete(c.keys().next().value as string);
    setAheadTick((t) => t + 1);
  }, []);
  const base = useMemo(() => codebook.filter((c) => !c.derived), [codebook]);
  const derived = useMemo(() => codebook.filter((c) => c.derived), [codebook]);
  const single = choice === "single";

  // -- reading -------------------------------------------------------------------
  const read = useCallback((reset: boolean, force = false) => {
    const uid = unitRef.current;
    return codingApi.unit({ project, set, unit: uid }).then((d) => {
      if (d.ok) remember(uid, d);
      if (uid !== unitRef.current) return;
      setU(d);
      if (!d.ok) return;
      if (!queue.current.has(uid) && flying.current !== uid) bases.current.set(uid, d.base);
      if (reset && cbRef.current.length) {
        const L0 = localRef.current;
        if (!force && L0 && L0.unit === uid && L0 !== shown.current) return;
        if (!force && queue.current.has(uid)) return;
        const L = fromRecord(uid, cbRef.current, d.record);
        localRef.current = L;
        shown.current = L;
        setLocal(L);
      }
    }).catch(() => { if (uid === unitRef.current) setU({ ok: false, error: "that unit didn't answer" } as CodingUnit); });
  }, [project, set, remember]);

  useEffect(() => {
    setCell(null);
    setPeek(null);
    setOpenerOpen(false);
    setParentOpen(false);
    setReviewNote("");
    setSave({ s: "idle" });
    setJump(null);
    const hit = cache.current.get(unitId);
    if (hit && hit.ok && cbRef.current.length) {
      // drawn at once from what was read ahead; the read below only confirms it
      setU(hit);
      if (!queue.current.has(unitId) && flying.current !== unitId) bases.current.set(unitId, hit.base);
      const L = queue.current.get(unitId) || fromRecord(unitId, cbRef.current, hit.record);
      localRef.current = L;
      shown.current = queue.current.has(unitId) ? null : L;
      setLocal(L);
    } else {
      // the last unit stays drawn until this one lands; its keys wait for it
      localRef.current = null;
    }
    void read(true);
  }, [unitId, read]);

  // the codebook can land after the unit (a unit opened by an event, before its set)
  useEffect(() => {
    if (u?.ok && !localRef.current && codebook.length && u.unit.id === unitId) {
      const L = fromRecord(unitId, codebook, u.record);
      localRef.current = L;
      shown.current = L;
      setLocal(L);
    }
  }, [u, codebook, unitId]);

  useEffect(() => {
    const f = () => { void read(false); };
    window.addEventListener("focus", f);
    return () => window.removeEventListener("focus", f);
  }, [read]);

  // the text is where the keys live: stand on it whenever a unit opens
  useEffect(() => {
    if (!u?.ok || u.unit.id !== unitId) return;
    document.documentElement.setAttribute("data-knav", "");
    textRef.current?.focus({ preventScroll: true });
    if (textRef.current) textRef.current.scrollTop = 0;
  }, [u?.ok, u?.unit.id, unitId]);

  // -- saving ----------------------------------------------------------------------
  const pump = useCallback((): Promise<void> => {
    if (running.current) return running.current;
    const run = (async () => {
      while (queue.current.size) {
        const [uid, L] = queue.current.entries().next().value as [string, Local];
        queue.current.delete(uid);
        if (uid === unitRef.current) setSave({ s: "saving" });
        flying.current = uid;
        const r = await codingApi.save({ project, set, unit: uid, base: bases.current.get(uid) || "",
          codes: L.codes, note: L.note, done: L.done }).catch(() => null);
        flying.current = null;
        if (r && r.ok) {
          bases.current.set(uid, r.base);
          result.current.set(uid, "ok");
          const c = cache.current.get(uid);
          if (c && r.record) cache.current.set(uid, { ...c, record: r.record, base: r.base });
          if (r.counts && r.counts.total) setDoneN(r.counts);
          if (r.record) { if (r.record.done) doneSet.current.add(uid); else doneSet.current.delete(uid); }
          if (uid === unitRef.current && !queue.current.has(uid)) setSave({ s: "saved" });
        } else if (r && r.conflict) {
          // another window saved this unit: its record wins, and this one shows it
          bases.current.set(uid, r.base);
          queue.current.delete(uid);
          result.current.set(uid, "conflict");
          if (uid === unitRef.current) {
            const fresh = fromRecord(uid, cbRef.current, r.record);
            localRef.current = fresh;
            setLocal(fresh);
            setSave({ s: "conflict", msg: "changed in another window, reloaded" });
          }
        } else {
          result.current.set(uid, "error");
          if (uid === unitRef.current) setSave({ s: "error", msg: r?.error || "not saved: the Board didn't answer" });
          if (r === null && !queue.current.has(uid)) queue.current.set(uid, L);
          if (r === null) break;
        }
      }
    })();
    running.current = run.finally(() => { running.current = null; });
    return running.current;
  }, [project, set]);

  const flush = useCallback(async () => {
    if (timer.current !== null) { window.clearTimeout(timer.current); timer.current = null; }
    await pump();
    if (queue.current.size) await pump();
  }, [pump]);

  const apply = useCallback((next: Local, delay = 200) => {
    localRef.current = next;
    setLocal(next);
    queue.current.set(next.unit, next);
    result.current.delete(next.unit);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { timer.current = null; void pump(); }, delay);
  }, [pump]);

  // leaving the unit or the view never drops a change
  useEffect(() => () => { void flush(); }, [unitId, flush]);
  useSaveKey(() => flush());
  useEffect(() => {
    if (!flushRef) return;
    flushRef.current = flush;
    return () => { flushRef.current = null; };
  }, [flushRef, flush]);

  const seenVersion = useRef(bookVersion);
  useEffect(() => {
    if (seenVersion.current === bookVersion) return;
    const first = !seenVersion.current;
    seenVersion.current = bookVersion;
    if (first) return;
    // what is keyed by the old labels is not sent: the record as the server renamed it wins
    cache.current.clear();
    if (timer.current !== null) { window.clearTimeout(timer.current); timer.current = null; }
    queue.current.clear();
    void (running.current || Promise.resolve()).then(() => read(true, true));
  }, [bookVersion, codebook, read]);

  useEffect(() => {
    const now = () => {
      if (timer.current !== null) { window.clearTimeout(timer.current); timer.current = null; }
    };
    const hidden = () => { if (document.visibilityState === "hidden") { now(); void pump(); } };
    const dying = () => {
      now();
      if (!running.current) void pump();     // takes the first queued unit, on the wire now
      for (const [uid, L] of Array.from(queue.current.entries())) {
        queue.current.delete(uid);
        void codingApi.save({ project, set, unit: uid, base: bases.current.get(uid) || "",
          codes: L.codes, note: L.note, done: L.done }).catch(() => null);
      }
    };
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", dying);
    return () => { document.removeEventListener("visibilitychange", hidden); window.removeEventListener("pagehide", dying); };
  }, [pump, project, set]);

  // -- coding ----------------------------------------------------------------------
  const text = u?.ok ? u.unit.text : "";

  const toggle = useCallback((label: string, sel: [number, number] | null) => {
    const L = localRef.current;
    const c = L ? stateOf(L.codes, label) : undefined;
    if (!L || !c) return;
    // a marked range or region is spent the way a selection is
    const anc = mediaRef.current?.take() || null;
    const off = (s: CodeState): CodeState => ({ present: false, confidence: s.confidence, evidence: "" });
    let codes: Record<string, CodeState>;
    if (single) {
      // one choice: this one on (with the selection as its evidence), every other off
      codes = Object.create(null) as Record<string, CodeState>;
      for (const [k, s] of Object.entries(L.codes)) {
        codes[k] = k === label
          ? { ...(s.present ? s : off(s)), present: true, evidence: sel ? text.slice(sel[0], sel[1]) : (s.present ? s.evidence : ""),
            ...(anc ? { anchor: anc } : {}) }
          : off(s);
      }
      if (!sel && !anc && c.present) { if (drawerRef.current && dockedRef.current) onCodebook(label); return; }
    } else {
      const next: CodeState = sel || anc
        ? { ...c, present: true, ...(sel ? { evidence: text.slice(sel[0], sel[1]) } : {}), ...(anc ? { anchor: anc } : {}) }
        : c.present ? off(c) : { ...c, present: true };
      codes = { ...L.codes, [label]: next };
    }
    apply({ ...L, codes });
    if (sel) window.getSelection()?.removeAllRanges();
    if (drawerRef.current && dockedRef.current) onCodebook(label);
  }, [apply, text, onCodebook, single]);

  const cycle = useCallback((label: string) => {
    const L = localRef.current;
    const c = L ? stateOf(L.codes, label) : undefined;
    if (!L || !c) return;
    apply({ ...L, codes: { ...L.codes, [label]: { ...c, confidence: NEXT_CONF[c.confidence] } } });
  }, [apply]);

  const at = ids.indexOf(unitId);
  const step = useCallback((d: -1 | 1) => {
    const n = at >= 0 ? ids[at + d] : undefined;
    if (!n) return;
    void flush();
    onStep(n);
  }, [at, ids, onStep, flush]);
  useBracketStep(drawerOpen && !roomy ? null : step);

  // read the units either side ahead, once this one is on screen
  const shownId = u?.ok ? u.unit.id : "";
  useEffect(() => {
    if (shownId !== unitId || at < 0) return;
    for (const n of [ids[at + 1], ids[at - 1]]) {
      if (!n || cache.current.has(n) || ahead.current.has(n)) continue;
      ahead.current.add(n);
      void codingApi.unit({ project, set, unit: n })
        .then((d) => { if (d.ok && !queue.current.has(n)) remember(n, d); })
        .catch(() => null)
        .finally(() => ahead.current.delete(n));
    }
  }, [shownId, unitId, at, ids, project, set, remember]);

  // the next unit's file is warmed once its JSON is in; one unit ahead, let go of on a step
  useEffect(() => {
    const n = shownId === unitId && at >= 0 ? ids[at + 1] : undefined;
    const d = n ? cache.current.get(n) : undefined;
    const m = d?.ok ? d.unit.media : null;
    setWarm((w) => ((w?.url || "") === (m?.url || "") ? w : m));
  }, [shownId, unitId, at, ids, aheadTick]);
  const warmUrl = warm?.url || "";
  useEffect(() => (warm ? warmMedia(warm) : undefined), [warmUrl]);  // eslint-disable-line react-hooks/exhaustive-deps

  const jumpTo = useCallback((raw: string) => {
    const v = raw.trim();
    setJump(null);
    const n = /^\d+$/.test(v) ? Number(v) : NaN;
    const id = Number.isFinite(n) ? ids[Math.min(Math.max(n, 1), ids.length) - 1] : ids.find((x) => x === v);
    document.documentElement.setAttribute("data-knav", "");
    textRef.current?.focus({ preventScroll: true });
    if (id && id !== unitRef.current) { void flush(); onStep(id); }
  }, [ids, onStep, flush]);

  /** the next unit after this one that is not done, wrapping round; none when all are */
  const nextUndone = useMemo(() => {
    void doneTick;
    if (at < 0) return undefined;
    for (let k = 1; k < ids.length; k++) {
      const n = ids[(at + k) % ids.length];
      if (n !== unitId && !doneSet.current.has(n)) return n;
    }
    return undefined;
  }, [at, ids, unitId, doneTick]);

  // and that one is read ahead too, so Enter lands on a unit already drawn
  useEffect(() => {
    if (shownId !== unitId || !nextUndone || cache.current.has(nextUndone) || ahead.current.has(nextUndone)) return;
    const n = nextUndone;
    ahead.current.add(n);
    void codingApi.unit({ project, set, unit: n })
      .then((d) => { if (d.ok && !queue.current.has(n)) remember(n, d); })
      .catch(() => null)
      .finally(() => ahead.current.delete(n));
  }, [shownId, unitId, nextUndone, project, set, remember]);

  const done = useCallback(async (stay: boolean) => {
    const L = localRef.current;
    if (!L) return;
    apply({ ...L, done: true }, 0);
    await flush();
    if (result.current.get(L.unit) !== "ok" || L.unit !== unitRef.current) return;
    doneSet.current.add(L.unit);
    if (stay) { void read(false); return; }
    let n: string | undefined;
    for (let k = 1; k < ids.length && at >= 0; k++) {
      const x = ids[(at + k) % ids.length];
      if (x !== L.unit && !doneSet.current.has(x)) { n = x; break; }
    }
    // everything done: the next in order, as before, and the queue after the last
    if (!n && at >= 0) n = ids[at + 1];
    if (n) onStep(n); else onBack();
  }, [apply, flush, at, ids, onStep, onBack, read]);

  // -- reviews ---------------------------------------------------------------------
  const verdict = useCallback(async (coder: string, code: string, v: CodingVerdict) => {
    try {
      await codingApi.review({ project, set, unit: unitId, code, targetCoder: coder, verdict: v, note: reviewNote });
      setReviewNote("");
      void read(false);
    } catch (e) { setSave({ s: "error", msg: (e as Error).message || "the review didn't save" }); }
  }, [project, set, unitId, reviewNote, read]);

  const resolve = useCallback(async (id: string) => {
    try {
      await codingApi.review({ project, set, id, resolved: true });
      void read(false);
    } catch (e) { setSave({ s: "error", msg: (e as Error).message || "couldn't resolve it" }); }
  }, [project, set, read]);

  // -- keys ------------------------------------------------------------------------
  const hasOpener = useRef(false);
  const hasParent = useRef(false);
  const keys = useRef({ toggle, cycle, done, verdict, onCodebook, onBack, base, text, flush, confidence, onEdit, onMemo });
  keys.current = { toggle, cycle, done, verdict, onCodebook, onBack, base, text, flush, confidence, onEdit, onMemo };
  
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const k = keys.current;
      const a = document.activeElement as HTMLElement | null;
      // the note: Enter is a new line; Esc and Ctrl+Enter save it and go back to the text
      if (a && a === noteRef.current) {
        if (e.key === "Escape" || (e.key === "Enter" && (e.ctrlKey || e.metaKey))) {
          e.preventDefault();
          e.stopPropagation();
          void k.flush();
          document.documentElement.setAttribute("data-knav", "");
          textRef.current?.focus({ preventScroll: true });
        }
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // the codebook over the pane holds the keys; docked beside the text it holds only ? and Esc
      if (drawerRef.current && (!dockedRef.current || e.key === "Escape" || e.key === "?")) return;
      if (a && (FIELD.has(a.tagName) || a.isContentEditable)) return;
      // the focus inside the docked codebook: its digits, its e and m, and no media keys
      const inBook = !!a?.closest?.("[data-coding-codebook]");
      const m = /^(?:Digit|Numpad)([1-9])$/.exec(e.code);
      if (m && inBook) return;
      if (m) {
        const c = k.base[Number(m[1]) - 1];
        if (!c) return;
        e.preventDefault();
        if (e.shiftKey) { if (k.confidence) k.cycle(c.label); }
        else k.toggle(c.label, selectionIn(postRef.current, k.text));
        return;
      }
      if (e.key === "?") {
        e.preventDefault(); e.stopPropagation();
        const L = localRef.current;
        k.onCodebook((L && k.base.find((c) => L.codes[c.label]?.present)?.label) || "");
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        k.onBack();
        return;
      }
      if (e.key === "n" && !e.shiftKey) {
        e.preventDefault();
        const t = noteRef.current;
        if (t) { t.focus(); t.setSelectionRange(t.value.length, t.value.length); }
        return;
      }
      if (e.key === "t" && !e.shiftKey && hasOpener.current) { e.preventDefault(); setOpenerOpen((x) => !x); return; }
      if (e.key === "p" && !e.shiftKey && hasParent.current) { e.preventDefault(); setParentOpen((x) => !x); return; }
      if (e.key === ":") { e.preventDefault(); e.stopPropagation(); setJump(""); return; }
      if ((e.key === "e" || e.key === "m") && !e.shiftKey && !inBook && !document.documentElement.hasAttribute("data-board-prefix")) {
        if (e.key === "m") { if (k.onMemo) { e.preventDefault(); k.onMemo(); } return; }
        if (!k.onEdit) return;
        e.preventDefault();
        const L = localRef.current;
        k.onEdit(a?.closest?.("[data-coding-code]")?.getAttribute("data-coding-code")
          || (L && k.base.find((c) => L.codes[c.label]?.present)?.label) || "");
        return;
      }
      if (e.key === "Enter") {
        if (a && a !== textRef.current && a.tagName === "BUTTON") return;   // the button's own action
        e.preventDefault();
        void k.done(e.shiftKey);
        return;
      }
      const cellAttr = a?.getAttribute("data-coding-cell") || "";
      if (cellAttr && !cellAttr.startsWith("owner:") && !e.shiftKey && (e.key === "a" || e.key === "d" || e.key === "u")) {
        const [coder, code] = cellAttr.split(":");
        e.preventDefault();
        void k.verdict(coder, code, e.key === "a" ? "agree" : e.key === "d" ? "disagree" : "unsure");
        return;
      }
      const box = textRef.current;
      // the media's keys; Space and the arrows only from the text, so a focused button keeps its own
      if (!inBook && mediaRef.current?.key(e, !a || a === box || a === document.body)) { e.preventDefault(); return; }
      if (box && a === box) {
        if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !e.shiftKey) {
          if (readerScroll(box, e.key === "ArrowDown" ? 1 : -1, false, e.repeat)) e.preventDefault();
        } else if (e.key === " ") {
          if (readerScroll(box, e.shiftKey ? -1 : 1, true, false)) e.preventDefault();
        }
      }
    };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, []);

  useEffect(() => { if (jump !== null) jumpRef.current?.focus({ preventScroll: true }); }, [jump !== null]);  // eslint-disable-line react-hooks/exhaustive-deps

  // -- drawing ---------------------------------------------------------------------
  const marks = useMemo<Mark[]>(() => {
    const out: Mark[] = [];
    if (!local || !text) return out;
    for (const [code, c] of Object.entries(local.codes)) {
      const r = c.present ? locate(text, c.evidence) : null;
      if (r) out.push({ a: r[0], b: r[1], kind: "mine", code });
    }
    const look = peek || cell;
    if (look && look.coder !== "owner") {
      const cv = u?.coders.find((x) => x.name === look.coder)?.codes[look.code];
      const r = cv?.evidence ? locate(text, cv.evidence) : null;
      if (r) out.push({ a: r[0], b: r[1], kind: "theirs", code: look.code });
    }
    return out;
  }, [local, text, cell, peek, u]);

  if (!u) return <PanelEmpty>Reading the unit</PanelEmpty>;
  if (!u.ok) return <PanelEmpty>{u.error || "that unit didn't answer"}</PanelEmpty>;
  if (!codebook.length || !local) return <PanelEmpty>Reading the codebook</PanelEmpty>;

  const wide = size === "lg" || size === "xl";
  const pos = at >= 0 ? (at + 1) + "/" + ids.length : (u.unit.index + 1) + "/" + u.unit.total;
  const present = new Set(Object.entries(local.codes).filter(([, c]) => c.present).map(([k]) => k));
  const derivedOn = (c: CodingCode) => !c.noneOf.some((x) => present.has(x));
  const compare = u.revealed && u.coders.length > 0;
  // the last unit, still drawn while the next one is on its way
  const stale = u.unit.id !== unitId || local.unit !== unitId;
  const tally = doneN || counts;
  const cx: CodingContext = u.unit.context;
  const same = (x: string) => x.replace(/\s+/g, " ").trim() === text.replace(/\s+/g, " ").trim();
  // a post that opens its thread is its own opener; a reply to the opener has it as parent
  const showOpener = !!cx.opener && cx.kind !== "post" && !same(cx.opener);
  const showParent = !!cx.parent && !cx.parentIsOpener && !same(cx.parent) && !(showOpener && cx.parent === cx.opener);
  hasOpener.current = showOpener;
  hasParent.current = showParent;
  const parts = metaParts(u.unit.meta);
  // "*": the codebook file was changed outside the pane; a mark, never a code's name
  const revisit = (u.unit.revisit || []).filter((x) => x !== "*");
  const outside = (u.unit.revisit || []).includes("*");
  const chosen = base.filter((c) => local.codes[c.label]?.present);
  const pct = tally && tally.total ? Math.min(100, (tally.done / tally.total) * 100) : 0;
  const media = u.unit.media;
  const cols = twoCol || (roomy && !!media);
  // a picture or a video takes the room the text leaves
  const staged = !!media && !media.error && !!media.url && media.kind !== "audio";
  const look = peek || cell;
  const theirs = look && look.coder !== "owner" ? u.coders.find((x) => x.name === look.coder)?.codes[look.code]?.anchor || null : null;
  const shownAnchor = theirs || (hot && local.codes[hot]?.present ? local.codes[hot].anchor || null : null);
  // stacked, two option columns once there is room for them
  const optCols = !cols && size !== "xs" && size !== "sm" ? "grid grid-cols-2 gap-2" : "flex flex-col gap-2";

  const reading = (
    <article data-coding-reading style={staged ? { minHeight: cols ? "100%" : "min(100%, 460px)" } : undefined}
      className={"w-full " + (staged ? "flex max-w-[72rem] flex-col " : "max-w-[46rem] ")
        + (cols ? (media ? "mx-auto px-6 pb-5 pt-5" : "mx-auto px-10 pb-10 pt-7") : size === "xs" ? "px-3 pb-4 pt-3"
          : media && size === "sm" ? "mx-auto px-4 pb-3 pt-3" : "mx-auto px-6 pb-5 pt-5")}>
      {cx.title && (
        <h2 data-coding-thread className="text-[13.5px] font-semibold leading-snug text-foreground/85">{cx.title}</h2>
      )}
      {showOpener && (
        <Clamp lines={3} open={openerOpen} onToggle={() => setOpenerOpen((x) => !x)} keyName="t" what="opener" attr="data-coding-opener"
          className={(cx.title ? "mt-1.5 " : "") + "text-[13.5px] leading-[1.55] text-muted-foreground"} text={cx.opener} />
      )}
      {showParent && (
        <Clamp lines={4} open={parentOpen} onToggle={() => setParentOpen((x) => !x)} keyName="p" what="parent comment" attr="data-coding-parent"
          className="mt-4 border-l-2 border-border pl-3.5 text-[13.5px] leading-[1.55] text-muted-foreground" text={cx.parent} />
      )}
      {media && (
        <div data-coding-media-slot className={(cx.title || showOpener || showParent ? "mt-3 " : "") + (staged ? "flex min-h-0 flex-1 flex-col" : "")
          + (stale ? " opacity-60" : "")}>
          <CodingMediaBlock key={u.unit.id + "|" + media.url} ref={mediaRef} media={media} live={!stale}
            compact={size === "xs" || size === "sm"} shown={shownAnchor} />
        </div>
      )}
      {(text || !media) && (
        <div ref={postRef} data-coding-post
          title="Select a passage, then press a code's number to quote it"
          className={"max-w-[72ch] whitespace-pre-wrap break-words text-left text-foreground "
            + (media ? "mt-3 shrink-0 text-[15px] leading-[1.55]"
              : (cx.title || showOpener || showParent ? "mt-5 " : "") + (size === "xs" ? "text-[16px] leading-[1.6]" : "text-[19px] leading-[1.6]"))
            + (stale ? " opacity-60" : "")}>
          <Segments text={text} marks={marks} hot={hot} />
        </div>
      )}
      {(parts.length > 0 || revisit.length > 0 || outside) && (
        <div data-coding-metaline className={(media ? "mt-2 shrink-0" : "mt-4") + " text-[12px] leading-[1.5] text-muted-foreground"}>
          {parts.map((p, i) => (
            <span key={p.key} data-coding-meta={p.key} title={p.title || undefined}>{i ? " · " : ""}{p.text}</span>
          ))}
          {(revisit.length > 0 || outside) && (
            <span data-coding-revisit className="text-warning" title="The codebook changed these codes after this unit was coded: mark it done again to clear it">
              {parts.length ? " · " : ""}revisit {revisit.map((x) => codeName({ label: x, display: codebook.find((y) => y.label === x)?.display })).join(", ")}
              {outside && <span data-coding-revisit-outside className="ml-1 inline-flex align-middle"><DraftDot title="codebook changed outside the pane" /></span>}
            </span>
          )}
        </div>
      )}
    </article>
  );

  const decision = (
    <div data-coding-decision-body className={cols ? (media ? "px-5 pb-5 pt-5" : "px-6 pb-6 pt-7") : size === "xs" ? "px-3 pb-4 pt-3" : "mx-auto w-full max-w-[46rem] px-6 pb-5 pt-4"}>
      <div data-coding-codes data-coding-choice={single ? "single" : "multi"} role="group" aria-label="Codes" className={optCols}>
        {base.map((c, i) => {
          // a code promoted in a moment ago has no state until the unit is read again
          const s = stateOf(local.codes, c.label) || { present: false, confidence: "high" as CodingConfidence, evidence: "" };
          const on = s.present;
          return (
            <div key={c.label} data-coding-code={c.label} data-present={on ? "1" : "0"}
              onMouseEnter={() => setHot(c.label)} onMouseLeave={() => setHot(null)}
              className={"group/opt relative flex items-stretch rounded-lg border transition-colors "
                + (on ? "border-primary/55 bg-primary/[0.09]" : "border-border/70 hover:border-border hover:bg-accent/35")}>
              <button type="button" data-knav-item data-coding-toggle={c.label} aria-pressed={on}
                onMouseDown={(e) => e.preventDefault()}
                onFocus={() => setHot(c.label)} onBlur={() => setHot(null)}
                onClick={() => toggle(c.label, selectionIn(postRef.current, text))}
                title={codeName(c) + " (" + (i + 1) + ")" + (s.evidence ? ": “" + s.evidence.slice(0, 80) + "”" : "")}
                className={"flex min-w-0 flex-1 items-start gap-3 rounded-lg pl-3 pr-8 pt-2.5 text-left outline-none focus-visible:ring-1 focus-visible:ring-primary/60 "
                  + (on && s.anchor ? "pb-8" : "pb-2.5")}>
                <span className={"nums mt-[1px] inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md text-[12px] font-medium "
                  + (on ? "bg-primary text-primary-foreground" : "border border-border text-muted-foreground")}>
                  {i < 9 ? i + 1 : ""}
                </span>
                <span className="min-w-0 flex-1">
                  <span data-coding-name className="block text-[14.5px] font-medium leading-snug text-foreground">
                    {codeName(c)}
                    {draftMarks?.has(c.label) && <span className="ml-1.5 inline-flex align-middle"><DraftDot /></span>}
                  </span>
                  <span data-coding-short className="mt-0.5 block text-[12px] leading-[1.45] text-muted-foreground">{codeShort(c)}</span>
                  {on && s.evidence && (
                    <span data-coding-quote className="mt-1 block truncate text-[11.5px] italic text-foreground/75">“{s.evidence}”</span>
                  )}
                </span>
              </button>
              {on && s.anchor && (
                <button type="button" data-knav-item data-coding-anchor={c.label} onMouseDown={(e) => e.preventDefault()}
                  onClick={() => { if (s.anchor) mediaRef.current?.show(s.anchor); }}
                  title={isSpan(s.anchor) ? "Play this range" : "Show this region"}
                  className="nums absolute bottom-1.5 left-[46px] inline-flex h-5 items-center rounded bg-primary/10 px-1.5 text-[10.5px] text-foreground outline-none hover:bg-primary/20 focus-visible:ring-1 focus-visible:ring-primary/60">
                  {isSpan(s.anchor) ? anchorLabel(s.anchor, media) : <Crop size={11} />}
                </button>
              )}
              <span className="absolute right-1.5 top-2 flex items-center gap-0.5">
                {confidence && (
                  <button type="button" data-knav-item data-coding-conf={c.label} onClick={() => cycle(c.label)}
                    title={"Confidence: " + s.confidence + " (Shift+" + (i + 1) + ")"}
                    className="inline-flex h-5 items-center rounded px-1 text-[10px] text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-primary/60">
                    {CONF_SHORT[s.confidence]}
                  </button>
                )}
                <button type="button" data-knav-item data-coding-label={c.label} onClick={() => onCodebook(c.label)}
                  title={"Codebook: " + codeName(c)}
                  className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground opacity-0 outline-none transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-primary/60 group-hover/opt:opacity-100">
                  <BookOpen size={12} />
                </button>
              </span>
            </div>
          );
        })}
      </div>
      {derived.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 px-1">
          {derived.map((c) => (
            <span key={c.label} data-coding-derived={c.label} data-present={derivedOn(c) ? "1" : "0"}
              title={codeName(c) + ": present when none of " + c.noneOf.map((x) => codeName({ label: x, display: codebook.find((y) => y.label === x)?.display })).join(", ") + " is"}
              className={"inline-flex items-center gap-1.5 text-[12px] " + (derivedOn(c) ? "text-foreground" : "text-muted-foreground")}>
              <span className={"h-[7px] w-[7px] rounded-full " + (derivedOn(c) ? "bg-primary" : "border border-muted-foreground/60")} />
              {codeName(c)}
            </span>
          ))}
        </div>
      )}
      <div className="relative mt-4">
        <textarea ref={noteRef} value={local.note} data-coding-note rows={5} maxLength={noteMax} placeholder="note"
          title="Note (n) · Enter a new line · Esc or Ctrl+Enter back to the text"
          onChange={(e) => { const L = localRef.current; if (L) apply({ ...L, note: e.target.value }, NOTE_DEBOUNCE); }}
          className="block min-h-[calc(5*1.5em+18px)] max-h-[calc(12*1.5em+18px)] w-full resize-none overflow-y-auto rounded-lg border border-border/70 bg-background px-3 py-2 text-[13px] leading-[1.5] text-foreground outline-none [field-sizing:content] placeholder:text-muted-foreground/60 focus:border-primary/60" />
        {local.note.length >= Math.floor(noteMax * 0.8) && (
          <span data-coding-note-count title="Characters in the note, of what the note can hold"
            className={"nums pointer-events-none absolute bottom-[6px] right-2 rounded bg-background/90 px-1 text-[10px] "
              + (local.note.length >= noteMax ? "text-danger" : "text-muted-foreground")}>
            {nfmt(local.note.length)}/{nfmt(noteMax)}
          </span>
        )}
      </div>
      {compare && (
        <Compare u={u} local={local} codebook={codebook} coders={coders} wide={wide} inline
          cell={cell} onCell={setCell} onPeek={setPeek} reviewNote={reviewNote} onReviewNote={setReviewNote}
          media={media} onAnchor={(a) => mediaRef.current?.show(a)}
          onVerdict={(coder, code, v) => void verdict(coder, code, v)} onResolve={(id) => void resolve(id)} />
      )}
    </div>
  );

  return (
    <div data-coding-unit={u.unit.id} data-coding-stale={stale ? "1" : undefined} data-coding-revealed={u.revealed ? "1" : "0"}
      data-coding-layout={cols ? "columns" : "stacked"} className="flex h-full min-h-0 flex-col">
      <div data-coding-bar className="flex h-8 shrink-0 items-center gap-2 border-b border-border/40 px-2.5">
        <button type="button" data-knav-back="2" data-qa="coding-unit-back" onClick={onBack} title="Back to the queue (Esc)"
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground outline-none hover:bg-accent hover:text-foreground">
          <ArrowLeft size={13} />
        </button>
        {jump !== null ? (
          <input ref={jumpRef} data-coding-jump value={jump} inputMode="numeric" placeholder={"1-" + ids.length}
            title="Go to a unit: its number in the queue, or its id (Enter)"
            onChange={(e) => setJump(e.target.value)} onBlur={() => setJump(null)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); jumpTo(jump); }
              else if (e.key === "Escape") {
                e.preventDefault(); e.stopPropagation(); setJump(null);
                document.documentElement.setAttribute("data-knav", "");
                textRef.current?.focus({ preventScroll: true });
              }
            }}
            className="nums h-[20px] w-16 shrink-0 rounded border border-primary/60 bg-background px-1 text-[11px] outline-none" />
        ) : (
          <span data-coding-pos className="nums shrink-0 text-[11px] text-muted-foreground"
            title={"Unit " + pos + " in this queue · id " + u.unit.id + " · previous / next: [ ] · go to a unit: :"}>{pos}</span>
        )}
        {tally && (
          <>
            <span data-coding-progressbar aria-hidden className={"relative h-[3px] shrink-0 overflow-hidden rounded-full bg-muted " + (size === "xs" ? "w-10" : "w-28")}>
              <span className="absolute inset-y-0 left-0 rounded-full bg-primary/70" style={{ width: pct + "%" }} />
            </span>
            <span data-coding-donecount className="nums shrink-0 text-[11px] text-muted-foreground"
              title={"Coded of all units in the set · this unit's id: " + u.unit.id}>
              {size === "xs" ? nfmt(tally.done) + "/" + nfmt(tally.total) : nfmt(tally.done) + " of " + nfmt(tally.total) + " done"}
            </span>
          </>
        )}
        <span className="min-w-0 flex-1" />
        {!cols && chosen.length > 0 && (
          <span data-coding-chosen className="min-w-0 truncate rounded-full bg-primary/10 px-2 text-[11px] leading-[18px] text-foreground"
            title="Your code for this unit">
            {chosen.map((c) => codeName(c)).join(", ")}
          </span>
        )}
        <SaveMark s={save} />
        <button type="button" data-knav-item data-qa="coding-unit-codebook" onClick={() => onCodebook("")} title="Codebook (?)"
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-primary/60">
          <BookOpen size={13} />
        </button>
        <button type="button" data-knav-item data-qa="coding-done" aria-pressed={local.done}
          onClick={(e) => void done(e.shiftKey)} title={local.done ? "Done: next unit (Enter)" : "Done and next (Enter) · done and compare (Shift+Enter)"}
          className={"inline-flex h-6 shrink-0 items-center gap-1 rounded px-2 text-[11px] outline-none focus-visible:ring-1 focus-visible:ring-primary/60 "
            + (local.done ? "bg-primary/15 text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground")}>
          <Check size={12} />{size === "xs" ? "" : "Done"}
        </button>
      </div>

      {cols ? (
        <div className="flex min-h-0 flex-1">
          <div ref={textRef} tabIndex={0} data-knav-item data-coding-text
            className="tinybar min-h-0 min-w-0 flex-1 overflow-y-auto outline-none">
            {reading}
          </div>
          <aside data-coding-decision className="tinybar min-h-0 w-[38%] shrink-0 overflow-y-auto border-l border-border/50">
            {decision}
          </aside>
        </div>
      ) : (
        <div ref={textRef} tabIndex={0} data-knav-item data-coding-text
          className="tinybar min-h-0 flex-1 overflow-y-auto outline-none">
          {reading}
          <div data-coding-decision className="border-t border-border/50">
            {decision}
          </div>
        </div>
      )}
    </div>
  );
}

function SaveMark({ s }: { s: SaveState }) {
  if (s.s === "idle") return <span data-coding-save="idle" className="h-[7px] w-[7px] shrink-0" />;
  // a save that did not land says so in words, never only as a dot to hover
  if (s.s === "error" || s.s === "conflict") {
    const msg = s.msg || (s.s === "conflict" ? "changed in another window" : "not saved");
    return (
      <span data-coding-save={s.s} title={msg} aria-label={msg}
        className={"inline-flex min-w-0 shrink items-center gap-1 text-[9.5px] " + (s.s === "error" ? "text-danger" : "text-warning")}>
        <span className={"h-[7px] w-[7px] shrink-0 rounded-full " + (s.s === "error" ? "bg-danger" : "bg-warning")} />
        <span data-coding-save-msg className="truncate" style={{ maxWidth: 180 }}>{msg}</span>
      </span>
    );
  }
  const title = s.s === "saved" ? "Saved" : s.s === "saving" ? "Saving" : s.msg || (s.s === "conflict" ? "Changed in another window" : "Not saved");
  const cls = s.s === "saved" ? "border border-primary/60"
    : s.s === "saving" ? "bg-primary/60 animate-pulse"
    : s.s === "conflict" ? "bg-warning" : "bg-danger";
  return <span data-coding-save={s.s} title={title} aria-label={title} className={"h-[7px] w-[7px] shrink-0 rounded-full " + cls} />;
}

/* ------------------------------------------------------------------ the comparison */

function Compare({ u, local, codebook, coders, wide, inline = false, cell, onCell, onPeek, reviewNote, onReviewNote, onVerdict, onResolve,
  media = null, onAnchor }: {
  u: CodingUnit; local: Local; codebook: CodingCode[]; coders: CodingCoderInfo[]; wide: boolean;
  /** under the note, in the decision column, rather than a column of its own */
  inline?: boolean;
  cell: { coder: string; code: string } | null; onCell: (c: { coder: string; code: string } | null) => void;
  onPeek: (c: { coder: string; code: string } | null) => void;
  reviewNote: string; onReviewNote: (s: string) => void;
  onVerdict: (coder: string, code: string, v: CodingVerdict) => void; onResolve: (id: string) => void;
  media?: CodingMedia | null; onAnchor?: (a: CodingAnchor) => void;
}) {
  const present = new Set(Object.entries(local.codes).filter(([, c]) => c.present).map(([k]) => k));
  const mine = (c: CodingCode): boolean => (c.derived ? !c.noneOf.some((x) => present.has(x)) : present.has(c.label));
  const mineConf = (c: CodingCode) => (c.derived ? "" : local.codes[c.label]?.confidence || "");
  const open = u.reviews.filter((r) => !r.resolved);
  const kindOf = (name: string) => coders.find((c) => c.name === name)?.kind || "";
  const sel = cell;
  const rest = useRestIntent();
  const selCode = sel ? codebook.find((c) => c.label === sel.code) : null;
  const selView = sel && sel.coder !== "owner" ? u.coders.find((x) => x.name === sel.coder) : null;
  const selCell = selView ? selView.codes[sel!.code] : null;
  const myReview = sel && sel.coder !== "owner"
    ? open.find((r) => r.reviewer === "owner" && r.targetCoder === sel.coder && r.code === sel.code) : null;
  const agentOnMine = sel && sel.coder === "owner"
    ? open.filter((r) => r.targetCoder === "owner" && r.code === sel.code && r.reviewer !== "owner") : [];

  return (
    <div data-coding-compare className={"tinybar shrink-0 overflow-y-auto border-border/40 px-2 py-1 "
      + (inline ? "mt-4 border-t pt-2" : wide ? "w-[340px] border-l" : "max-h-[46%] border-t")}>
      <table className="w-auto border-collapse text-[11px]">
        <thead>
          <tr>
            <th className="py-[2px] pr-1 text-left font-medium text-muted-foreground" />
            <th className="px-0.5 py-[2px] text-center font-medium text-foreground" title="Your codes">you</th>
            {u.coders.map((c) => (
              <th key={c.name} className="max-w-[64px] truncate px-0.5 py-[2px] text-center font-medium text-muted-foreground"
                title={[c.name, c.kind, c.codebookVersion, c.coded ? "" : "did not code this unit"].filter(Boolean).join(" · ")}>
                <span className="inline-flex items-center gap-0.5">
                  {c.kind === "agent" && <Bot size={9} aria-hidden />}{c.name}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {codebook.map((c) => {
            const m = mine(c);
            const agentOpen = open.filter((r) => r.targetCoder === "owner" && r.code === c.label && r.reviewer !== "owner");
            return (
              <tr key={c.label}>
                <th scope="row" className="truncate py-[1px] pr-1 text-left font-normal text-muted-foreground" style={{ maxWidth: 110 }} title={c.label}>
                  {codeName(c)}
                </th>
                <td className="px-0.5 py-[1px] text-center">
                  <button type="button" data-knav-item data-coding-cell={"owner:" + c.label}
                    onFocus={() => onCell({ coder: "owner", code: c.label })} onClick={() => onCell({ coder: "owner", code: c.label })}
                    title={"You: " + (m ? "present" : "absent") + (mineConf(c) ? ", " + mineConf(c) : "") + (agentOpen.length ? " · agent review" : "")}
                    className={"inline-flex h-[17px] min-w-[34px] items-center justify-center gap-0.5 rounded px-1 outline-none focus-visible:ring-1 focus-visible:ring-primary/60 "
                      + (sel?.coder === "owner" && sel.code === c.label ? "bg-accent" : "")}>
                    <Dot v={m} />
                    <span className="text-[8.5px] text-muted-foreground">{CONF_SHORT[mineConf(c)] || ""}</span>
                    {agentOpen.length > 0 && <Bot size={9} data-coding-agent-review className="text-primary" />}
                  </button>
                </td>
                {u.coders.map((cv) => {
                  const x = cv.codes[c.label];
                  const v = x ? x.present : null;
                  const diff = v !== null && v !== undefined && v !== m;
                  const same = v !== null && v !== undefined && v === m;
                  const r = open.find((q) => q.reviewer === "owner" && q.targetCoder === cv.name && q.code === c.label);
                  const on = sel?.coder === cv.name && sel.code === c.label;
                  return (
                    <td key={cv.name} className="px-0.5 py-[1px] text-center">
                      <button type="button" data-knav-item data-coding-cell={cv.name + ":" + c.label}
                        data-coding-agree={diff ? "0" : same ? "1" : ""}
                        onFocus={() => onCell({ coder: cv.name, code: c.label })} onClick={() => onCell({ coder: cv.name, code: c.label })}
                        {...rest(cv.name + ":" + c.label, () => onPeek({ coder: cv.name, code: c.label }))} onMouseLeave={() => onPeek(null)}
                        title={cv.name + ": " + (!x ? "did not code this unit" : v === null ? "not in its codebook" : (v ? "present" : "absent") + (x.confidence ? ", " + x.confidence : ""))
                          + (r ? " · you: " + r.verdict : "") + " · a / d / u"}
                        className={"inline-flex h-[17px] min-w-[34px] items-center justify-center gap-0.5 rounded px-1 outline-none focus-visible:ring-1 focus-visible:ring-primary/60 "
                          + (diff ? "bg-danger/15 ring-1 ring-danger/50 " : same ? "bg-primary/10 " : "")
                          + (on ? "outline outline-1 outline-primary/70" : "")}>
                        {!x || v === null ? <span className="text-muted-foreground">–</span> : <Dot v={!!v} />}
                        <span className="text-[8.5px] text-muted-foreground">{x && v !== null ? CONF_SHORT[x.confidence] || "" : ""}</span>
                        {r && <VerdictMark v={r.verdict} />}
                      </button>
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>

      {sel && selCode && (
        <div data-coding-review className="mt-1 border-t border-border/40 pt-1">
          {sel.coder === "owner" ? (
            agentOnMine.length ? agentOnMine.map((r) => (
              <div key={r.id} data-coding-agent-note className="flex items-start gap-1 py-[2px] text-[10px]">
                <Bot size={10} className="mt-[2px] shrink-0 text-primary" aria-label="agent review" />
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{r.verdict}</span>
                  {r.note && <span className="text-muted-foreground"> {r.note}</span>}
                </span>
                <button type="button" data-knav-item data-coding-resolve={r.id} onClick={() => onResolve(r.id)} title="Resolve"
                  className="inline-flex h-[16px] w-[16px] shrink-0 items-center justify-center rounded text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-primary/60">
                  <Check size={10} />
                </button>
              </div>
            )) : <div className="text-[10px] text-muted-foreground">{codeName(selCode)}: no agent review</div>
          ) : (
            <>
              <div className="text-[10px] leading-[1.4]">
                <span className="font-medium">{sel.coder}</span>
                <span className="text-muted-foreground"> · {codeName(selCode)}</span>
                {kindOf(sel.coder) && <span className="text-muted-foreground"> · {kindOf(sel.coder)}</span>}
              </div>
              {selCell?.reasoning && (
                <div data-coding-reasoning className="mt-0.5 line-clamp-4 text-[10px] leading-[1.4] text-muted-foreground" title={selCell.reasoning}>
                  {selCell.reasoning}
                </div>
              )}
              {selCell?.anchor && onAnchor && (
                <button type="button" data-knav-item data-coding-their-anchor onClick={() => { if (selCell.anchor) onAnchor(selCell.anchor); }}
                  title={isSpan(selCell.anchor) ? "Play this range" : "Show this region"}
                  className="nums mt-0.5 inline-flex h-[18px] items-center rounded bg-primary/10 px-1.5 text-[10px] text-foreground outline-none hover:bg-primary/20 focus-visible:ring-1 focus-visible:ring-primary/60">
                  {isSpan(selCell.anchor) ? anchorLabel(selCell.anchor, media) : <Crop size={10} />}
                </button>
              )}
              {selCell && selCell.present !== null && (
                <div className="mt-1 flex flex-wrap items-center gap-1">
                  {VERDICTS.map((x) => (
                    <button key={x.v} type="button" data-knav-item data-coding-verdict={x.v}
                      aria-pressed={myReview?.verdict === x.v}
                      onClick={() => onVerdict(sel.coder, sel.code, x.v)} title={x.label + " (" + x.key + " on the cell)"}
                      className={"inline-flex h-[18px] items-center rounded border px-1.5 text-[9.5px] outline-none focus-visible:ring-1 focus-visible:ring-primary/60 "
                        + (myReview?.verdict === x.v ? "border-primary/60 bg-primary/15 text-foreground" : "border-border/70 text-muted-foreground hover:text-foreground")}>
                      {x.label}
                    </button>
                  ))}
                  <input value={reviewNote} onChange={(e) => onReviewNote(e.target.value)} data-coding-review-note
                    placeholder={myReview?.note || "why"} title="A note with the verdict"
                    className="min-w-[80px] flex-1 rounded border border-border/70 bg-background px-1 py-[1px] text-[10px] outline-none placeholder:text-muted-foreground/60 focus:border-primary/60" />
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Dot({ v }: { v: boolean }) {
  return <span className={"inline-block h-[7px] w-[7px] rounded-full " + (v ? "bg-primary" : "border border-muted-foreground/70")} />;
}

function VerdictMark({ v }: { v: CodingVerdict }) {
  if (v === "agree") return <Check size={8} strokeWidth={3} className="text-primary" aria-label="you agree" />;
  if (v === "disagree") return <X size={8} strokeWidth={3} className="text-danger" aria-label="you disagree" />;
  return <CircleHelp size={8} className="text-muted-foreground" aria-label="unsure" />;
}

