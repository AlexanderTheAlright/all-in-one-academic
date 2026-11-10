/* Shared types and tiny fetch helpers used by every view. */

import * as opener from "@/lib/opener";
import { afterDraftingGate } from "@/lib/draftgate";

export type KCard = {
  raw: string; text: string; done: boolean;
  tags: string[]; priority: string | null; due: string | null; est?: number | null;
};
export type Lane = { name: string; cards: KCard[] };
export type Board = { lanes: Lane[]; error?: string };
export type Project = { name: string; path: string; slug?: string; done: number; open: number; mtime?: number; effort?: number; undated?: number };
// collection: "historical" for the primary-source lane (the primary_sources_dir setting,
// build_cache.py's second pass); absent means the literature corpus
export type Item = { name: string; author: string; year: number | null; type: string; status: string; rating: number | null; tags: string[]; collection?: string };
export type TaskLink = {
  kind: "reading" | "note" | "draft";
  label: string;
  action: "open" | "open-pdf" | "drafting" | "reading";
  file?: string; slug?: string; doc?: string;
  extras?: TaskLink[];
};
export type TLItem = { board: string; path: string; lane: string; text: string; due: string; priority: string | null; isPlanning: boolean; tags?: string[]; raw?: string; est?: number | null; link?: TaskLink | null };
export type EvtCategory = "meetings" | "seminars" | "deadlines" | "birthdays" | "holidays" | "social" | "teaching" | "conferences" | "travel" | "commitments";
export type Event = {
  title: string; date: string; endDate?: string | null;
  startTime: string | null; endTime: string | null;
  allDay: boolean; category: EvtCategory; color: string; path: string;
  recurring: boolean;
  completed: boolean; // resolved via the calendar tick-off (completed: stamp in the event file)
  // a meetings event can be a remote "call" (mode:"call") carrying a join link
  mode?: string | null; link?: string | null;
  tags?: string[]; project?: string | null;
  // the planning ledger's virtual "commitments" category: path "commitment:<id>", never editable here
  readOnly?: boolean; source?: string;
};
export type DayStat = { date: string; words: number; mtime: number; path: string };
export type Recent = { name: string; path: string; mtime: number; isPlanning: boolean; open: number; ago: number };
export type Hit = { board: string; path: string; lane: string; text: string; done: boolean; raw: string; due: string | null; priority: string | null };
export type Cache = {
  generated: string;
  kpi: { total: number; read: number; withPdf: number; rated: number; avgRating: number; projects: number; tasks: number };
  types: [string, number][]; decades: [string, number][]; topTags: [string, number][];
  tagStats?: TagStat2[];
  tagTotal?: number;          // distinct tags across every citation note, for an "N of M" label
  items: Item[]; projects: Project[];
};
export type TagStat2 = { tag: string; total: number; read: number; unread: number };
export type Today = {
  today: string;
  eventsToday: Event[]; eventsWeek: Event[];
  overdue: TLItem[]; dueToday: TLItem[]; dueSoon: TLItem[]; flagged: TLItem[];
};
export type TagStat = { tag: string; count: number; openCount: number; cardCount?: number; noteCount?: number; boards: string[] };
// a note carrying a tag — frontmatter or an inline #tag — with a context snippet + wikilink target
export type NoteHit = { title: string; path: string; link: string; source: "frontmatter" | "inline"; snippet: string };
export type TagOccurrences = { cards: Hit[]; notes: NoteHit[]; index?: { ready: boolean; tagCount: number; files: number } };
export type ReadState = "read" | "reading" | "unread";
// reading lists v2: a list -> ordered groups (sublists) -> items. Groups carry a
// "what to read" note; items carry a Read note (which sections) + a needs-download flag.
export type ReadingItem = {
  title: string; checked: boolean; status: string | null;
  readState: ReadState; citationName: string | null; citationPath: string | null;
  pdfPath: string | null; why: string | null; read: string | null; needsDownload: boolean;
  doi?: string | null;
  /** The WORK to download when this reading's title is a chapter range. */
  source?: string | null;
  /** `Download: retracted` — not a fetchable work, so no lane (and no click) chases it.
   *  The reason rides in `why` behind a "RETRACTED — " prefix; requeue is the way back. */
  retracted?: boolean;
  /** read-by date (`Due: YYYY-MM-DD`) and place in the read-next queue (1 = next) */
  due?: string | null;
  queue?: number | null;
};
export type ReadingNextItem = {
  key: string; list: string; group: string; title: string; read: string | null;
  due: string | null; queue: number | null; pdf: string | null; citation: string | null;
  download: "have" | "needed" | "manual" | "owned" | "retracted";
  status: ReadState;
};
export type ReadingReadBy = { date: string; daysLeft: number; items: ReadingNextItem[] };
export type ReadingNext = { queue: ReadingNextItem[]; readBy: ReadingReadBy[]; behind: number };
// an item for the next/due ops: its key, or its (list, group, item) position
export type ReadingItemRef = { key: string } | { list: string; group: number; item: number };
export type ReadingGroup = { name: string; level: number; note: string | null; prose: boolean; items: ReadingItem[] };
export type ReadingList = {
  name: string; date: string | null; note: string | null; archived: boolean;
  file: string | null; groups: ReadingGroup[]; read: number; total: number; needsDownload: number;
};
// lightweight archive index row (item bodies dropped; group names + counts kept)
export type ArchivedList = {
  name: string; date: string | null; note: string | null; file: string;
  groupNames: string[]; read: number; total: number; needsDownload: number;
};
export type PrintEntry = { id: string; kind: "quote" | "note"; page: string; text: string; tags: string[] };
export type PrintBook = {
  ok: boolean; error?: string; stem: string; path: string; print: boolean;
  citation: string; citekey: string; isbn: string; doi: string; entries: PrintEntry[];
};
export type PrintBookResult = {
  ok: boolean; error?: string; stem?: string; path?: string; created?: boolean; id?: string;
  linked?: string[]; fields?: CiteFields; from?: string;
};
export type ReadingType = "article" | "book" | "other";
export type QueueWhere = "active" | "queue" | "archived";
export type DownloadItem = {
  list: string; group: number; groupName: string; item: number;
  title: string; why: string | null; read: string | null; citationName: string | null;
  type: ReadingType; doi?: string | null; heldManual?: boolean;
  where?: QueueWhere; file?: string | null;
};
export type QueueSource = { name: string; note: string | null; total: number; needsDownload: number };
export type QueueAddResult = {
  ok: boolean; added?: boolean; error?: string; title?: string; source?: string; doi?: string | null;
  duplicate?: { where: QueueWhere; list: string; file: string | null; title: string; needsDownload: boolean };
};
// OpenAlex import — seed a download list (by author / pasted DOIs+titles / topic)
export type OAItem = {
  doi: string | null; title: string; displayTitle?: string; year: number | null;
  authors?: string[]; venue?: string | null; isOA?: boolean; oaStatus?: string | null;
  confidence?: string; openalexId?: string | null;
};
export type OAAuthor = { id: string; name: string; works: number; cited: number; institution: string | null };
export type OAImport = {
  items?: OAItem[]; author?: OAAuthor | null; alternatives?: OAAuthor[];
  built?: { list: string; added: number; skipped: number }; error?: string;
};
export type CorpusHit = {
  stem: string; rel: string; kind: "citation" | "clipping";
  author: string; year: number | null; title: string; status: string | null;
};
export type InboxFile = { name: string; size: number; mtime: number; stemOk: boolean; dupInCorpus: boolean };
export type InboxQueueMatch = { list: string; group: number; item: number; title: string; why: string | null; score: number; where?: QueueWhere; file?: string | null };
export type InboxDetail = {
  ok?: boolean; error?: string; name: string; size: number;
  verdict: "VALID" | "SUSPECT" | "GARBAGE"; reason: string; pages: number | null;
  stemOk: boolean; dupInCorpus: boolean;
  meta: { title: string; author: string; created: string };
  textHead: string;
  suggestion: { author: string; year: string; title: string };
  queueMatches: InboxQueueMatch[];
  linkedItems: { list: string; title: string }[];
};
export type InboxStemCheck = { valid: boolean; problem?: string; collision?: boolean; noteExists?: boolean };
// citation metadata + BibTeX captured while filing (CrossRef/OpenLibrary/OpenAlex suggestions)
export type CiteFields = {
  type: string; authors: string[]; year: string; title: string; container: string;
  publisher: string; address: string; volume: string; issue: string; pages: string;
  doi: string; isbn: string; editor: string; edition: string; url: string;
};
export type CiteCandidate = CiteFields & { _source: string; _score: number };
export type CiteSuggest = {
  ok?: boolean; error?: string; name: string;
  detected: { doi: string; isbn: string };
  candidates: CiteCandidate[]; prefill: CiteFields;
};
export type CitePreview = { ok: boolean; citekey: string; bibtex: string; citation: string };
export type InboxCiteResult = { cited: boolean; citekey?: string; noteWritten?: boolean; bibWritten?: boolean; error?: string };
export type InboxActResult = {
  ok?: boolean; error?: string; collision?: boolean;
  filed?: string; corpusRel?: string; repointed?: string[]; needsNote?: boolean; archived?: string;
  cite?: InboxCiteResult | null;
};
export type NoteInboxItem = { id: string; filename: string; title: string; preview: string; created: string; source: string; mtime: number };
export type NoteItem = { id: string; title: string; folder: string; type: string; tags: string[]; summary: string; preview: string; created: string; path: string; mtime: number };
export type GraphNode = { id: string; title: string; folder: string; type: string; tags: string[]; path: string; mtime: number; ghost: boolean; external: boolean; degree: number; orphan: boolean; group?: string; readonly?: boolean; synthetic?: boolean; citationCount?: number; aliases?: string[] };
// 'similar' = a within-group tag-overlap tie (notes_organizer's _similarity_edges)
// — only meaningful inside a GROUPED_TYPES family's nested group-atlas.
export type GraphEdge = { source: string; target: string; kind: "link" | "tag" | "similar"; tag?: string; weight?: number };
export type NoteGraph = { nodes: GraphNode[]; edges: GraphEdge[]; folders: string[]; types: string[]; tags: string[]; counts: Record<string, number> };
export type NoteRead = { ok: boolean; path: string; title: string; type: string; tags: string[]; summary: string; body: string; mtime: number; readonly?: boolean; error?: string };
export type BlockKind = "text" | "image" | "diagram";
export type BlockAsset = { png: string; excalidraw: string | null; url: string; source_url?: string; source_path?: string };
export type DrawerTemplate = { name: string; mtime: number; elements: number; doc: unknown | null };
export type DiagramItem = { name: string; png: string; title: string; editable: boolean; editor?: "excalidraw" | "drawio" | "drawer" | null; elements: number; empty: boolean; mtime: number; embed: string; url: string; path: string };
export type NoteBlock = { i: number; kind: BlockKind; heading: string | null; level: number; body: string; start: number; end: number; asset: BlockAsset | null };
export type NoteBlocks = { ok: boolean; path: string; title: string; type: string; tags: string[]; mtime: number; blocks: NoteBlock[]; error?: string };
export type NoteCreated = { ok: boolean; title?: string; folder?: string; type?: string; path?: string; mtime?: number; error?: string };
// filing/moving with undo (notes_filing.py): from = the old path, path = where it landed
export type NoteMoved = { ok: boolean; path?: string; from?: string; undo_id?: string; error?: string };
export type NoteHistoryItem = { undo_id: string; ts: string; action: string; title: string; from: string; to: string; undone: boolean };
export type ArchivedNote = { path: string; title: string; from_folder: string; archived_at: string; origin?: string };
export type ProjectTarget = { key: string; name: string; root: string; status: string };
export type ProjectNotesList = { key: string; name: string; notes: { path: string; title: string; created: string; mtime: number; kind: string }[] };
// one /search/vault hit; snippet marks the matched words with «…»
export type VaultHit = { path: string; title: string; area: string; type: string; tags: string[]; snippet: string; mtime: number; score: number; fuzzy?: boolean };
export type VaultSearch = { hits: VaultHit[]; took_ms: number; total: number; building: boolean; indexed: number };
export type BlockWrite = { ok: boolean; path?: string; mtime?: number; error?: string };
// semantic neighbours of a note (cosine over the embedding cache) — drives the drawer's Related panel
export type RelatedNote = { id: string; title: string; path: string; type: string; tags: string[]; sim: number };
export type AioaOverview = { counts: Record<string, number>; recent: { title: string; path: string; type: string; mtime: number }[] };
export type AioaAuthor = { key: string; name: string; works: number; lead: number; read: number; yearMin: number | null; yearMax: number | null; topTags: string[]; hasProfile: boolean; profilePath: string; recent: number };
export type AioaWork = { rel: string; title: string; author: string; year: number | null; status: string; rating: number; sourceType: string; source: string; tags: string[]; quotes: number; keyPoints: number; mtime: number; lead: boolean };
export type AioaAuthorDetail = {
  ok: boolean; key: string; name: string;
  profile: { path: string; hasBody: boolean } | null;
  stats: { works: number; lead: number; read: number; yearMin: number | null; yearMax: number | null };
  topTags: string[]; works: AioaWork[];
  projects: { project: string; notes: { path: string; title: string }[] }[];
  concepts: { title: string; path: string; n: number }[];
  meetings: { path: string; title: string; date: string; with: string[]; readonly: boolean }[];
};
export type AioaCitationsPage = {
  total: number; offset: number; limit: number; items: AioaWork[];
  facets: { total: number; topTags: { tag: string; n: number }[]; sourceTypes: { type: string; n: number }[]; statuses: Record<string, number>; yearMin: number | null; yearMax: number | null };
};
export type AioaMeeting = { path: string; title: string; date: string; startTime: string; with: string[]; tags: string[]; preview: string; mtime: number; readonly: boolean; event?: string; notePath?: string; noteTitle?: string };
export type MeetingNote = { ok: boolean; created?: boolean; path?: string; title?: string; error?: string };
export type AioaProject = { project: string; notes?: number; logs: number; corpus: number; mtime: number };
export type AioaProjectNotes = { project: string; notes?: { path: string; title: string; tags: string[]; mtime: number; created?: string; kind?: string }[]; logs: { path: string; title: string; tags: string[]; mtime: number }[]; corpus: { path: string; title: string; tags: string[]; mtime: number }[] };
export type ReadingToday = {
  label: string; path: string | null; citationName: string | null;
  due: string; overdue: boolean; priority: string | null; taskText: string; raw: string; boardPath: string;
};
export type InboxItem = { name: string; path: string; kind: "clipping" | "rss"; mtime: number };
// citation notes most recently opened/edited (mtime-sorted) — the reading hub's re-entry panel
export type RecentCitation = { name: string; path: string; mtime: number };
export type Reading = {
  lists: ReadingList[]; archived: ArchivedList[]; downloads: DownloadItem[];
  queue?: QueueSource[];
  inbox: InboxItem[]; recent: RecentCitation[]; today: ReadingToday[];
  next?: ReadingNext;
  vaultPath?: string;
};

export type AmbientWeather = {
  tempC: number; feelsC: number; code: number;
  kind: "clear" | "partly" | "overcast" | "fog" | "drizzle" | "rain" | "snow" | "storm";
  label: string; isDay: boolean; hiC: number | null; loC: number | null;
};
export type AmbientSun = { sunrise: string | null; sunset: string | null };
export type OnThisDayEntry = {
  date: string; ago: string; excerpt: string;
  habitsDone: number; habitsTotal: number; path: string;
};
export type Ambient = {
  date: string; now: string; stale: boolean;
  weather: AmbientWeather | null; sun: AmbientSun | null;
  epigraph: { text: string; source: string } | null;
  onThisDay: OnThisDayEntry[];
};

// --- routines ---
export type HabitDay = { date: string; done: Record<string, boolean> | null; exists: boolean };
export type DailySections = {
  exists: boolean; dailyNotes: string;
  work?: string; workFilled?: boolean;
  eodHappened: string; eodTomorrow: string; eodSentence: string;
  morningFilled: boolean; todayFilled: boolean; eodFilled: boolean; words: number;
};
// 30-day consistency per habit: completion rate over logged days + best streak.
export type HabitStat = { done: number; logged: number; days: number; rate: number; best: number };
export type Routines = {
  date: string; day: string;
  habits: Record<string, boolean>; habitKeys: string[];
  streaks: Record<string, number>; habitStats?: Record<string, HabitStat>; grid: HabitDay[];
  sections: DailySections; dailyPath: string;
};
export type ProjectMilestone = {
  id: string; title: string; date?: string; hard?: boolean;
  dependsOn?: string[]; lead?: number; goal?: boolean; calendar?: boolean; status?: string;
};
export type ProjectTask = {
  text: string; milestone?: string; due?: string; offset?: number;
  priority?: "high" | "medium" | "low"; est?: string;
};
export type ProjectProposal = {
  status: "none" | "proposed";
  slug?: string; title?: string; tag?: string; generated?: string; boardPath?: string;
  source?: string;            // "manual" = built in the app, no agent involved
  editedAt?: string;          // last in-app edit
  hardDeadline?: { date?: string | null; title?: string };
  milestones?: ProjectMilestone[];
  tasks?: ProjectTask[];
  alerts?: string[];
}

export type BoardProposal = {
  id: string; text: string; board: string; lane: string;
  due?: string | null; priority?: string | null; est?: string | null;
  tag?: string | null; note?: string | null; source?: string; ts?: string;
  status: "pending" | "accepted" | "rejected";
  resolvedAt?: string;
  committedTo?: { board: string; lane: string; body: string };
}
export type BoardProposalList = { proposals: BoardProposal[]; pending: number }
export type AcceptResult = { ok: boolean; board: string; lane: string; body: string; proposals: BoardProposal[] };
// the durable project-plan.json chain (persists post-finalize) — timeline project lanes
export type ProjectPlan = {
  status: "none" | "proposed" | "finalized" | "dismissed" | "archived";
  slug?: string; title?: string; tag?: string; boardPath?: string;
  generated?: string; editedAt?: string; alerts?: string[];
  hardDeadline?: { date?: string; title?: string };
  milestones?: ProjectMilestone[];
  tasks?: ProjectTask[];
};
// GET /insights/archive — the reflective record behind the Insights Archive pane
export type ArchivePipelineItem = { slug: string; doc: string; kind: string; label: string; title: string; status: "draft" | "under_review" | "published"; words: number; mtime: number };
export type ArchiveChain = {
  slug?: string; title?: string; status?: string; finalizedAt?: string; archivedAt?: string;
  done: boolean; completedOn: string | null;
  milestones: { title?: string; date?: string; done: boolean }[];
};
export type ArchiveData = {
  kpis: { underReview: number; published: number; milestonesDone: number; goalsTotal: number; tasksDone: number; estMinutes: number };
  pipeline: ArchivePipelineItem[];
  chains: ArchiveChain[];
  timeline: { date: string; kind: string; title: string }[];
  weekly: { week: string; count: number; minutes: number }[];
  tags: [string, number][];
  recentTasks: { text: string; due: string | null; tags: string[]; est: number | null; lane: string | null }[];
};
export type ProjectFinalize = {
  ok: boolean;
  committed: { slug: string; goals: number; calendar: string[]; cards: number };
};
export type SectionAnchor = "daily-notes" | "work" | "log-entry" | "log-next" | "log-summary";
// one past/present day's journal, fetched for backfill
export type DayJournal = DailySections & { date: string; dailyPath: string };
// a whole past daily note, read-only, for the all-days browser
export type DayNote = { date: string; path: string; text: string };
// light status for the Today day-picker (which recent days already have writing)
export type JournalDayMeta = {
  date: string; weekday: string; isToday: boolean;
  words: number; exists: boolean; morningFilled: boolean; eodFilled: boolean;
};

// --- learning / flashcards ---
export type DeckSection = "inProgress" | "queue";
export type Module = { sub: string; module: string; total: number; due: number; new: number; img?: number };
export type Deck = { deck: string; total: number; due: number; new: number; img?: number; subs: number; modules?: Module[]; section?: DeckSection; shelved?: boolean };
export type LearnScan = {
  decks: Deck[]; total: number; due: number; new: number; reviewed: number;
  maturity: { new: number; learning: number; young: number; mature: number };
  sections?: { inProgress: string[]; queue: string[] };
  forecast?: LearnForecast;
};

export type LearnForecastDay = { date: string; due: number };
export type LearnForecast = {
  horizonDays: number; from: string; to: string;
  overdue: number; total: number; peak: number; days: LearnForecastDay[];
};
// a clickable region on an image card (fractions 0..1 of the image box). A circle
// (r) or a rectangle (w,h); clicking inside it reveals the answer as "correct".
export type Hotspot = { x: number; y: number; r?: number; w?: number; h?: number; label?: string };
export type FlashCard = {
  path: string; ord: number; deck: string; sub: string; front: string; back: string;
  new: boolean; siblings: number; hasImage?: boolean; image?: string | null; hotspots?: Hotspot[];
};
export type CardFlag = {
  id: string; path: string; ord: number; deck: string; front: string;
  reason: string; created: string; status: "open" | "fixed"; updated?: string;
};

export const IMG_WIDTHS = [320, 640, 960, 1280, 1920] as const;
/** snap UP to the closed set, so every caller of a given size shares one cache key */
export const snapWidth = (css: number, dpr = 1): number => {
  const want = Math.ceil(css * (dpr || 1));
  return IMG_WIDTHS.find((x) => x >= want) ?? IMG_WIDTHS[IMG_WIDTHS.length - 1];
};

export const learningAssetUrl = (path: string, name: string, w?: number) =>
  "/learning/asset?path=" + encodeURIComponent(path) + "&name=" + encodeURIComponent(name) +
  (w ? "&w=" + snapWidth(w) : "");

export type Quote = { text: string; attribution: string };

export type DraftStatus = "idea" | "draft" | "under_review" | "published";
export type PlanCommitment = { id: string; title: string; date: string; days: number; source: string; project?: string | null; editable: boolean; note?: string | null; done?: boolean };
export type PipelineItem = { key: string; title: string; kind: string; stage: DraftStatus; next: string; commitment: PlanCommitment | null; mtime: number; stale: boolean; focus: boolean };
export type PlanningPipeline = { items: PipelineItem[]; week: string };
export type DraftingPaper = { slug: string; doc: string; kind: string; label: string; publish: string; style: string; title: string; paperRel: string; editorRel: string; words: number; prevWords?: number; paperMtime: number; editorMtime: number; hasEditor: boolean; pdf?: boolean; pdfMtime?: number; status: DraftStatus; pinned?: boolean; resultsCount?: number; }
  & Partial<GrantLimits>;
export type GrantLimits = {
  deadline: string | null; deadlineRaw: string | null; deadlineKind: string;
  deadlineDone: boolean; deadlineUnknown: boolean;
  component: string | null;
  limitType: "pages" | "characters" | "characters_per_category" | "none" | null;
  maxPages: number | null; maxPagesFr: number | null; maxChars: number | null;
  pages: number | null;
};
export type ReadmeSection = { name: string; present: boolean; pending: boolean; words: number };
export type ReadmeStatus = { slug?: string; exists: boolean; rel?: string; mtime?: number; sections: ReadmeSection[]; markers: string[]; checklist: { done: boolean; text: string }[]; legacyPlan: boolean; error?: string };
export type DraftLog = { name: string; path: string; rel: string; mtime: number; size: number; kind: "index" | "questions" | "criticism" | "robustness" | "memo" | "run" };
export type DatasetHit = { name: string; kind: "file" | "context"; rel: string; path?: string; mtime: number };
export type ArchivedProject = { name: string; label: string; mode: "stalled" | "complete" | "other"; mtime: number };
export type DraftReport = { id: string; render: "md" | "html" | "edit"; title: string; words: number; mtime: number; status: DraftStatus; slug?: string; doc?: string; previewUrl?: string; pdf?: boolean };
export type DraftMeasure = { id: string; category: string; title: string; ext: string; mtime: number; status: DraftStatus };
export type DraftSyllabus = {
  id: string; kind: "syllabus" | "list"; slug: string;
  title: string; subtitle?: string | null;
  course?: string | null; term?: string | null; program?: string | null;
  readings: number; words: number; mtime: number;
  hasPdf: boolean; pdfMtime: number; status: DraftStatus;
};
export type SyllabusListSection = { i: number; name: string; readings: number };
export type SyllabusList = { slug: string; title: string; readings: number; sections: SyllabusListSection[] };
// result of pushing a reading list onto the board — per-section owned/needed counts
export type SyllabusPushResult = { list?: string; sections?: { name: string; have: number; need: number }[]; have?: number; need?: number; total?: number; error?: string };
export type DraftPart = { text: string; mtime: number; rel: string; words?: number; generated?: boolean };
export type DraftCommentRect = { x: number; y: number; w: number; h: number };
export type DraftCommentProvenance = { scriptRel?: string | null; generated?: number | null };
export type PdfComment = {
  id: string; target: "pdf" | "docx"; page: number; quote: string; rectPct?: DraftCommentRect | null;
  body: string; resolved: boolean; orphaned?: boolean; created: number; updated: number;
};
export type PdfCommentsLoad = { ok?: boolean; comments?: PdfComment[]; mtime?: number; version?: string; rel?: string; error?: string };

export type PdfCommentsSave = {
  ok?: boolean; mtime?: number; version?: string; rel?: string; error?: string;
  conflict?: boolean; currentMtime?: number; currentVersion?: string; currentComments?: PdfComment[];
};
export type PdfTextWord = { text: string; x0: number; y0: number; x1: number; y1: number };
export type PdfTextPage = { page: number; width: number; height: number; words: PdfTextWord[] };
export type PdfTextLayer = { ok?: boolean; pages?: PdfTextPage[]; error?: string };

export type DraftComment = {
  id: string; quote: string; prefix: string; suffix: string; body: string; resolved: boolean; orphaned?: boolean; created: number; updated: number;
  kind?: "text" | "figure" | "flag";
  focusFlag?: boolean;                 // explicit paragraph issue for Focus, independent of kind
  detached?: boolean; detachedAt?: number; detachedSection?: string; detachedOffset?: number;
  author?: "owner" | "checker";
  rectPct?: DraftCommentRect | null;   // drag-selected region on the figure image, as fractions of its rendered size
  provenance?: DraftCommentProvenance; // read-time join from results/provenance.json, kind="figure" only
  replies?: DraftCommentReply[];       // the thread under the finding — see DraftCommentReply
  reviewer?: string;                   // reviewer-response card: "R1".."R9" | "Editor" | "AE" (grounding.py --reviewer)
  outline?: boolean;                   // section-materials card: one per sentence-outline stub (drafting._sanitize_comments keeps only `true`)
  suggestion?: DraftCommentSuggestion; // suggested change: the quote is the span, `proposed` replaces it on Accept
};
export type OverleafZip = { name: string; mtime: number; size: number };
export type OverleafInfo = { ok?: boolean; error?: string; paperMtime?: number; named?: OverleafZip | null; anon?: OverleafZip | null };
export type DraftCommentSuggestion = { proposed: string; status: "open" | "accepted" | "rejected"; original?: string; decided?: string };
export type DraftCommentReply = { id: string; author: "owner" | "checker"; body: string; created: number };

export type RewriteEntry = {
  id: string; baseline: string;
  heading: string; section: string; pos: number;   // nearest heading, nearest ##, index under that heading
  key: string; last: string;                       // the live paragraph's key and text when last seen
  started?: number; updated?: number; passedAt?: number; best?: number;
  rev?: number; updatedAt?: number; dropped?: boolean;
};
/** a paragraph suggested for a paper (writing/versioning/suggested-paragraphs.json).
 *  Shown ONLY in Review > Rewrite beside its slot; never inserted, never copyable. */

export type SuggestionTweak = { text: string; was: string; why: string };
export type SuggestedParagraph = { id: string; after: string; anchor: string; text: string; sources: string[]; created: string; status: "open" | "dismissed";
  adopted?: boolean; tweaks?: SuggestionTweak[] };
export type RewriteSaveResult = { ok?: boolean; error?: string; paras?: Record<string, RewriteEntry>; stale?: string[]; mtime?: number };
export type DraftCommentsLoad = { ok?: boolean; comments?: DraftComment[]; mtime?: number; version?: string; rel?: string; error?: string;
  resolvedOmitted?: number; resolvedOnly?: boolean };
export type DraftCommentsSave = { ok?: boolean; mtime?: number; version?: string; rel?: string;
  /** a partial save only: how many stored resolved comments the server kept */
  resolvedKept?: number;
  
  keptAbsent?: number;
  conflict?: boolean; currentMtime?: number; currentVersion?: string; currentComments?: DraftComment[]; error?: string };
// coordinate-pinned comments on a RESULTS asset itself (the figure/table lightbox), keyed
// by asset stem. x/y/w/h are fractions of the image box; a point pin has w == h == 0.
export type FigureComment = { id: string; x: number; y: number; w: number; h: number; body: string; resolved: boolean; author: string; created: number; updated: number;
  reply?: string; for_agent?: boolean };
export type FigureCommentProv = { script?: string | null; kind?: string; dataSources?: string[] | null; generated?: number | null };
export type FigureCommentsLoad = { ok?: boolean; comments?: Record<string, FigureComment[]>; provenance?: Record<string, FigureCommentProv>; mtime?: number; version?: string; rel?: string; error?: string };
export type DraftProvStatus = "fresh" | "stale" | "external" | "none";
export type DraftProvEntry = {
  kind: string; script: string | null; dataSources: string[] | null; commit: string | null;
  generated: number | null; generatedBy: string | null; manualNote: string | null;
  verified: boolean | null; environment: { python?: string; packages?: Record<string, string> } | null;
  sessionId: string | null; notesAnchor: string | null; notesRel: string | null; caption: string | null;
  notesSource?: "header" | "notes" | null; notesScript?: string | null;
  freshness: Record<string, "fresh" | "stale" | "missing">; status: DraftProvStatus;
  // mtime of the stem's editable results/<stem>.drawio source (hand-drawn concept
  // diagram); null when the figure wasn't drawn in the in-app draw.io editor
  diagram?: number | null;
};
export type DraftProvEmbed = {
  doc: string; line: number; name: string; stem: string; kind: string;
  resolved: boolean; exempt: boolean; suggestion: string | null; provenance: string;
};
export type DraftAsset = { name: string; stem: string; kind: string; caption: string | null; diagram?: boolean };
export type DraftProvenance = { ok?: boolean; slug?: string; entries: Record<string, DraftProvEntry>; embeds: DraftProvEmbed[]; assets?: DraftAsset[]; error?: string };
// the one-click deterministic integrity report (POST /drafting/verify): cites +
// prose quotes + editor sources + numbers + provenance, no LLM in the loop.
export type VerifyQuoteRow = { line: number; quote: string; cite: string; page: string | null; status: string; rel?: string; detail?: string };
export type NumbersScriptState = "current" | "edited" | "missing" | "unrecorded";
export type NumbersStale = {
  id?: string | null; doc?: string; line?: number | null; written?: string; current?: string | null;
  file?: string; column?: string; row?: Record<string, string> | number | null;
  script?: string | null; scriptState?: NumbersScriptState | null;
};
export type NumbersScriptStale = { file: string; script: string | null; ids: (string | null)[] };
export type VerifyNumbers = {
  bound?: boolean; traced?: number; failing?: number; unboundTotal?: number; blocking?: string[];
  advisory?: string[]; advisoryCount?: number; inserted?: number;
  stale?: NumbersStale[]; scriptStale?: NumbersScriptStale[]; error?: string;
};
// per-binding numbers report (GET /drafting/numbers) — every numbers.json entry
// with its verdict + source cell + quote line, plus the advisory unbound sweep
export type NumbersEntryRow = {
  status: "TRACED" | "DRIFT" | "ORPHANED" | "NOT-FOUND" | "AMBIGUOUS" | "ENTRY-ERROR";
  msg: string; id?: string | null; quote?: string; written?: string;
  file?: string; column?: string; row?: Record<string, string> | number | null;
  scale?: number; mode?: string; note?: string | null; line?: number | null;
  // Insert-number additions: pinned key number, when/how it was inserted, the
  // source table's provenance join, and whether that table changed since the insert
  key?: boolean; insertedAt?: number | null; display?: string | null;
  provenance?: NumbersProv | null; sourceSha256?: string | null; sourceMtime?: number | null;
  sourceChanged?: boolean;
  inserted?: boolean; insertedBy?: string | null; blocks?: boolean;
  current?: string | null; reanchored?: boolean;
  scriptState?: NumbersScriptState | null; script?: string | null;
};
// Insert-number: the catalogue of every citable cell (GET /drafting/numbers-catalogue)
export type NumbersProv = {
  freshness: "fresh" | "stale" | "unrecorded" | "missing"; stem?: string; script?: string | null;
  scriptSha256?: string | null; generated?: number | null; generatedBy?: string | null;
  commit?: string | null; dataSources?: string[] | null; verified?: boolean | null;
};
export type NumbersRow = { i: number; label: string; selector: Record<string, string> | number; cells: Record<string, string>; bound: Record<string, string[]> };
export type NumbersTable = {
  file: string; stem: string; name: string; root: string; caption: string | null;
  sha256: string | null; mtime: number | null; provenance: NumbersProv | null;
  columns: string[]; numericColumns: string[]; labelColumns: string[];
  rowCount: number; truncated: boolean; rows: NumbersRow[];
};
export type NumbersCatalogue = {
  ok?: boolean; tables?: NumbersTable[]; hits?: unknown[] | null; skipped?: { file: string; reason: string }[];
  entries?: number; storePath?: string | null; error?: string;
};
export type NumberBindEntry = {
  quote?: string; written: string; file: string; column: string; row: Record<string, string> | number | null;
  scale: number; mode: "numeric" | "threshold" | "text"; doc?: string; display?: string; note?: string; key?: boolean;
};
export type NumbersUnboundRow = { line: number; token: string; context: string };
export type NumbersDocReport = { counts: Record<string, number>; results: NumbersEntryRow[]; unbound: NumbersUnboundRow[]; missing?: boolean };
export type DraftNumbers = {
  bound?: boolean; storePath?: string | null; docs?: Record<string, NumbersDocReport>;
  blocking?: string[]; traced?: number; failing?: number; unboundTotal?: number; error?: string;
  advisory?: string[]; advisoryCount?: number; inserted?: number;
  stale?: NumbersStale[]; scriptStale?: NumbersScriptStale[];
};
export type DraftVerify = {
  slug?: string; doc?: string; ok?: boolean; blocking?: string[];
  cites?: { counts?: Record<string, number>; unresolved?: string[]; ambiguous?: string[]; error?: string };
  proseQuotes?: { results?: VerifyQuoteRow[]; blocking?: string[]; counts?: Record<string, number>; error?: string };
  editorSources?: { results?: { line: string; reason: string }[]; failing?: number; checked?: number; error?: string };
  numbers?: VerifyNumbers;
  provenance?: DraftProvenance;
  error?: string;
};
// the read-only project-file viewer behind the workbench's View script / View data
export type DraftFileView = { ok?: boolean; name?: string; rel?: string; kind?: "text" | "csv" | "binary"; lang?: string; text?: string; rows?: string[][]; ext?: string; size?: number; error?: string };
// project-wide script/data inventory (the "browse everything" fallback beside the
// per-figure provenance record — see list_replication_files in drafting.py)
export type DraftReplScript = { rel: string; name: string; dir: string; lang: string; size: number };
export type DraftReplDataDir = { rel: string; name: string; fileCount: number; exts: string[] };
export type DraftReplDataRef = { rel: string; line: number; text: string };
export type DraftReplicationFiles = {
  ok?: boolean; hasReplication?: boolean; scripts?: DraftReplScript[];
  dataDirs?: DraftReplDataDir[]; dataRefs?: DraftReplDataRef[]; error?: string;
};
export type FindingLive = { value: number | null; status: "traced" | "drift" | "missing"; raw?: string; msg?: string };
export type FindingNumber = {
  label: string; value: number | null; precision?: number; display: string; kind?: string;
  file: string; row: string | Record<string, string> | number | null; column: string;
  output?: string | null; outputRow?: string | null; outputColumn?: string | null;
  script?: string | null; lines?: string | null; anchor?: string | null; scale?: number;
  sample?: { lock?: string; n?: number } | null; provenance?: string | null;
  // stamped by the backend on every read
  live: FindingLive; freshness: "fresh" | "stale" | "unrecorded" | "missing";
  provenanceRecord?: NumbersProv | null; scriptExists?: boolean;
};
export type FindingRow = {
  id: string; title: string; claim: string; verdict?: string; outcome?: string;
  numbers: FindingNumber[]; sections?: string[]; caveats?: string[]; sources?: string[];
  related?: string[]; audit?: { status?: string; checked?: string; method?: string } | null;
  drift?: number; missing?: number;
};
export type FindingTheme = { id: string; title: string; order?: number; summary?: string; findings: FindingRow[] };
export type DraftFindings = {
  ok?: boolean; slug?: string; schema?: number; project?: string; built?: string; lock?: string;
  path?: string; mtime?: number; sections?: string[]; themes?: FindingTheme[];
  counts?: { themes: number; findings: number; numbers: number; traced: number; drift: number; missing: number };
  error?: string; expected?: string;
};
export type DraftDocStatus = { ok?: boolean; exists?: boolean; paperMtime?: number; editorMtime?: number; commentsMtime?: number; assets?: Record<string, string>; resultsStamp?: string; error?: string };
export type DraftDoc = { slug: string; doc: string; kind: string; label: string; publish: string; style: string; title: string; preview?: string; projectDoc?: boolean; paper: DraftPart; editor: DraftPart; comments?: DraftCommentsLoad; error?: string };
export type DraftProjectDoc = { name: string; label: string; kind: string; path: string; exists: boolean; rel: string; mtime: number; words: number };
export type DraftManuscriptRow = { name: string; label: string; kind: string; mtime: number };
export type DraftProjectDocs = { slug?: string; tree?: string; projectDocs: DraftProjectDoc[]; manuscripts: DraftManuscriptRow[]; questions: { exists: boolean; path: string; rel: string; mtime: number }; error?: string };
export type DraftWhich = "paper" | "editor" | "outline";
export type DraftSave = { ok?: boolean; mtime?: number; rel?: string; conflict?: boolean; currentMtime?: number; currentText?: string; merged?: boolean; text?: string; error?: string };
export type DraftDocCreate = { ok?: boolean; existed?: boolean; name?: string; label?: string; rel?: string; mtime?: number; text?: string; error?: string };
/** The starter outlines New document offers: key and label only. The headings live in
 *  toolkit/templates/outlines.json and are written by the server (drafting.py create_document). */
export const DOC_OUTLINE_KINDS: { key: string; label: string }[] = [
  { key: "", label: "Blank" },
  { key: "paper", label: "Paper" },
  { key: "report", label: "Brief / report" },
  { key: "proposal", label: "Proposal" },
  { key: "dissertation", label: "Dissertation proposal" },
  { key: "extended-abstract", label: "Extended abstract" },
  { key: "reviewer-response", label: "Response to reviewers" },
  { key: "oped", label: "Op-ed" },
];
export type DraftSync = { ok?: boolean; editor?: DraftPart; conflict?: boolean; currentMtime?: number; currentText?: string; error?: string };
export type OutlineSectionWire = { level: number; heading: string; plan: string };
export type DraftOutline = { slug: string; doc: string; title: string; outline: DraftPart; thesis: string; targetJournal?: string; themes: string; sections: OutlineSectionWire[]; extras?: { heading: string; body: string }[]; intro?: string; error?: string };
export type DraftOutlineSync = { ok?: boolean; outline?: DraftPart; sections?: OutlineSectionWire[]; conflict?: boolean; currentMtime?: number; currentText?: string; error?: string };
export type DraftPublish = { ok?: boolean; pdfRel?: string; pagesBoth?: { double?: number; single?: number }; pages?: number | null; latexErrors?: string[]; mtime?: number; error?: string; log?: string[]; stderr?: string; edited?: boolean; separate?: boolean; figuresPdfRel?: string; figuresPages?: number | null; figuresMtime?: number; figuresError?: string; texSaved?: string[];
  // Word (.docx) output — the build_docx sibling pipeline
  docxRel?: string; docxMtime?: number; paragraphs?: number; tables?: number; images?: number; figuresDocxRel?: string; figuresTables?: number; figuresImages?: number; titlePageRel?: string; titlePageMtime?: number; warnings?: string[] };
export type DraftOutput = "pdf" | "docx";
export type DraftJournal = "working" | "asr" | "ajs" | "social-forces" | "jhsb" | "spq" | "socius" | "soc-theory" | "esr" | "ser" | "work-occ" | "wes";
export type DraftPubOptions = { format: DraftJournal; blind: boolean; endnotes: boolean; figures: "inline" | "atend" | "separate"; template?: string };
export type DraftTemplate = { cls: string; label: string; hint: string; live: boolean };
export type DraftPublishSetup = { slug: string; doc: string; pagesBoth?: { double?: number; single?: number }; title?: string; ready?: boolean; error?: string; cls?: string; template?: string; templates?: DraftTemplate[]; editable?: boolean; wrapper?: string; defaults?: DraftPubOptions; pdfRel?: string; pdfMtime?: number | null; docxRel?: string; docxMtime?: number | null;
  note?: string; lane?: string; grant?: boolean; projectDoc?: boolean;
  output?: DraftOutput; mdMtime?: number | null; previewPages?: number; previewMtime?: number | null;
  autoCompileError?: string; autoCompileLog?: string };
// the cheap companion to publish-setup: never compiles, just says whether the rendered
// preview still matches the manuscript, so an open panel can refresh itself.
export type DraftPreviewStatus = { ok?: boolean; output?: DraftOutput; mdMtime?: number | null; previewMtime?: number | null; previewPages?: number; stale?: boolean; compiling?: boolean; error?: string };
// supplements: a paper's sibling docs in the same writing/ folder (cover letter / response
// letter / appendix), opened from the Supplement dropdown
export type DraftSupplement = { name: string; label: string; kind: string; exists: boolean; rel: string; mtime: number; words: number; hasPdf: boolean; pdfName: string | null; pdfMtime: number; pendingCount?: number };
export type DraftReview = { exists: boolean; name: string; rel: string; mtime: number; text?: string };
export type DraftSupplementList = { slug?: string; supplements: DraftSupplement[]; review: DraftReview; error?: string };
export type DraftSupplementDoc = DraftSupplement & { slug: string; text: string; review?: DraftReview; ok?: boolean; error?: string };
// the journals knowledge base, surfaced in the Drafting view's "Publication
// checklists" viewer: each journal folder + its markdown docs (checklist/guidelines).
export type JournalDoc = { file: string; label: string };
export type JournalInfo = { name: string; docs: JournalDoc[]; default: string };
export type JournalChecklist = { name?: string; file?: string; label?: string; markdown?: string; docs?: JournalDoc[]; error?: string };
export type PaperChecklist = { ok?: boolean; text: string; exists: boolean; mtime: number; error?: string };
export type ChecklistSources = { journals: (JournalInfo & { template: boolean })[]; papers: { slug: string; kind: string; items: number }[] };
// in-house version control: a saved CHECKPOINT of a doc's exact bytes, kept under
// writing/versions/. Diffed in-app (word redline) and via a latexdiff PDF for reviewers.
export type DraftVersionArtifacts = { pdf?: string; docx?: string; appendixPdf?: string; appendixDocx?: string; titlepageDocx?: string; figuresPdf?: string };
export type DraftVersion = { id: string; ts: number; label: string; note: string; doc: string; file: string; words: number; chars: number; sha: string; auto?: boolean; artifacts?: DraftVersionArtifacts };
export type DraftVersionList = { ok?: boolean; slug?: string; doc?: string; versions: DraftVersion[]; current: { words: number; chars: number; mtime: number; sha: string }; dirtyVsNewest: boolean; error?: string };
export type DiffSegment = { op: "equal" | "insert" | "delete"; text: string };
export type DiffSide = { id: string; label: string; ts: number; words: number; current?: boolean };
export type DraftVersionDiff = { ok?: boolean; slug?: string; doc?: string; old: DiffSide; new: DiffSide; segments: DiffSegment[]; stats: { added: number; removed: number; changed: number }; error?: string };
export type DraftDiffPdf = { ok?: boolean; pdfRel?: string; pages?: number; mtime?: number; old?: DiffSide; new?: DiffSide; latexErrors?: string[]; error?: string; log?: string[] };
export type DraftConcept = { slug: string; name: string; rel: string; mtime: number; words?: number };
export type DraftConceptNote = { slug: string; name: string; text: string; exists: boolean; rel: string; mtime: number; error?: string; conflict?: boolean; currentMtime?: number; currentText?: string };
export type CiteQuote = { text: string; page: string | null; tag?: string | null; link?: string | null };
export type CiteKind = "citation" | "clipping";
export type CiteHit = { stem: string; rel: string; kind?: CiteKind; author: string; year: number | null; intext?: string; suffix?: string; title: string; citekey: string; source: string; tags: string[]; citation: string; keyPoints: string[]; quotes: CiteQuote[]; alreadyCited: boolean; nQuotes?: number; nKeyPoints?: number; partial?: boolean };
export type SourceNote = { rel: string; name: string; text: string; found: boolean; matchLine: number; quote: string; error?: string };
export type CiteStatus = "resolved" | "unresolved" | "ambiguous" | "prior";
export type CiteMapEntry = { status: CiteStatus; rel: string; citekey?: string; candidates?: number; alias?: boolean };
export type CiteMap = { map: Record<string, CiteMapEntry>; counts: { resolved: number; unresolved: number; ambiguous: number }; error?: string };
export type RefStyle = "asa" | "apa" | "chicago" | "mla";
export type RefEntry = { text: string; rel: string; citekey: string; confidence: string; flags: string[] };
export type RefAmbiguous = { token: string; candidates: { citekey: string; rel: string; stem: string; title: string; author: string }[] };
export type RefAudit = { style: string; total: number; complete: number; incomplete: number; ambiguous: number; not_found: number };
export type RefBuild = { style: RefStyle; markdown: string; audit: RefAudit; entries: RefEntry[]; unresolved: string[]; ambiguous: RefAmbiguous[]; existing: string | null; existsMtime: number; error?: string };
export type RefWrite = { ok?: boolean; mtime?: number; rel?: string; style?: string; audit?: RefAudit; conflict?: boolean; currentMtime?: number; currentText?: string; error?: string };
export type RefEdit = { ok?: boolean; note?: boolean; frontmatter?: boolean; bib?: boolean; bibInserted?: boolean; refsMd?: boolean; entry?: string; noteMtime?: number; conflict?: boolean; currentMtime?: number; which?: string; error?: string };

// --- Corpus browser (every read paper in the local Citations corpus, with preview) ---
export type CorpusRow = { stem: string; rel: string; kind: CiteKind; author: string; year: number | null; intext?: string; suffix?: string; title: string; citekey: string; source: string; tags: string[]; citation: string; keyPoints: string[]; nKeyPoints: number; nQuotes: number; alreadyCited: boolean };
export type CorpusSort = "author" | "year" | "relevance" | "cited";
export type CorpusBrowse = { rows: CorpusRow[]; count: number; total: number; sort: CorpusSort; query: string; index: { ready: boolean; count: number } };

export type DraftCorpusHitKind = "citation" | "clipping" | "historical" | "idea" | "concept" | "author" | "reflection" | "meeting" | "corpus"
  | "inbox" | "freewriting" | "projectnote" | "draft";
export type DraftCorpusPassageField = "head" | "key" | "quote" | "section";
export type DraftCorpusPassage = { field: DraftCorpusPassageField; text: string; page: string | null; heading: string | null; line: number | null; score?: number };
export type DraftCorpusHit = {
  rel: string; stem: string; kind: DraftCorpusHitKind; author: string; year: number | string | null; title: string;
  intext?: string; suffix?: string;   // the ASA in-text label + a/b letter (citationindex)
  slug?: string | null; doc?: string | null;   // the project a corpus/project note or draft belongs to; a draft's file
  citekey: string; tags: string[]; cited: boolean; score: number;
  best: DraftCorpusPassage | null; passages: DraftCorpusPassage[];
  citeRel?: string | null;
};
export type DraftCorpusIndexInfo = { ready?: boolean; builtAt?: number | string | null; chunks?: number; notes?: number; byKind?: Record<string, number>; model?: string; reason?: string };
export type DraftCorpusSearch = { ok?: boolean; mode: "hybrid" | "lexical" | "none"; reason?: string; ms?: number; index?: DraftCorpusIndexInfo | null; hits: DraftCorpusHit[] };
export type ClaimProject = { folder: string; name: string };
export type ClaimHit = {
  id: string; note: string; n: number; headline: string; pages: string; tags: string[];
  kind: string; strength: string; citekey: string; author: string; year: number | string | null;
  title: string; source: string; rating: number | null; structured: boolean; evidence: string;
  scope: string; supports: [string, string][]; n_quotes: number; projects: ClaimProject[];
  snippet?: string; score?: number; shared?: string[];
};
export type ClaimSearch = { hits: ClaimHit[]; total: number; took_ms?: number; building?: boolean; indexed_claims?: number; indexed_papers?: number; error?: string };
export type ClaimQuote = { text: string; page: number | string | null; pdf_page?: number | null; pdf_link?: string; tags?: string[]; linked?: "explicit" | "inferred"; why?: string; supports?: unknown };
export type ClaimShort = { id: string | null; n?: number; headline?: string; kind?: string; strength?: string; pages?: string; unresolved?: string } & Partial<ClaimHit>;
export type ClaimPaper = {
  path: string; citekey: string; author: string; year: number | string | null; title: string; source: string;
  rating: number | null; structured: boolean; summary: string; citation: string; limitations: string[] | string;
  unattached_quotes: ClaimQuote[]; n_quotes: number; projects: ClaimProject[];
};
export type ClaimDetail = {
  claim: ClaimHit & { detail: string; contests: unknown[]; extends: unknown[]; quotes: ClaimQuote[] };
  paper: ClaimPaper; claims: ClaimShort[]; error?: string;
};
export type ClaimRelated = { id: string; related: ClaimShort[]; contests: ClaimShort[]; contested_by: ClaimShort[]; extends: ClaimShort[]; extended_by: ClaimShort[]; error?: string };
export type ClaimFilters = { concept?: string; kind?: string; strength?: string; tag?: string; project?: string; year_from?: number | string; year_to?: number | string };
// clicking the ':54' of a cite -> the source PDF + the PHYSICAL page of the file for the
// cited PRINTED page (deterministic from the note's stored highlight anchors).
export type CitePageTarget = { ok?: boolean; pdfRel: string; pdfExists: boolean; physicalPage: number; printedPage: number; selection: string; quote: string; exact: boolean; noteRel: string; error?: string };
// --- Marp presentation decks (render + flick + per-slide comments) in the Drafting view
export type DraftPresentation = { slug: string; deck: string; deckRel: string; title: string; slides: number; deckMtime: number; hasNotes: boolean; hasReview: boolean; reviewMtime: number; status: DraftStatus };
export type DeckSlide = { svg: string; note: string; noteTitle?: string };
export type DeckReview = { text: string; mtime: number; rel: string };
export type DraftDeck = { slug: string; deck: string; deckRel: string; title: string; count: number; css: string; slides: DeckSlide[]; notesRel: string; notesMtime?: number; deckMtime: number; review: DeckReview; error?: string; stderr?: string };
// the presenter console's published slide position, polled by the remote audience page
export type PresentState = { active: boolean; slug: string; deck: string; idx: number; ts: number; src?: "console" | "audience" };
export type DeckNoteSave = { ok?: boolean; mtime?: number; notesRel?: string; conflict?: boolean; currentMtime?: number; error?: string };

/** Frontmatter lists reach us in three shapes: a real array, a bracketed string
 *  ("[clipping, rss]") when the YAML was unquoted, or nothing. Always answer an array. */
const tagList = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  if (typeof v === "string") return v.replace(/^\[|\]$/g, "").split(",").map((t) => t.trim()).filter(Boolean);
  return [];
};

const J = async <T,>(p: string, ms?: number): Promise<T> => {
  const ctl = ms ? new AbortController() : null;
  const t = ctl ? window.setTimeout(() => ctl.abort(), ms) : null;
  try {
    const r = await fetch(p, ctl ? { signal: ctl.signal } : undefined);
    if (!r.ok) throw new Error(`GET ${p.split("?")[0]} failed (${r.status})`);
    return (await r.json()) as T;
  } finally { if (t !== null) window.clearTimeout(t); }
};

/** POST JSON and surface the server's `error` string as a thrown message, so a card
 *  can show WHY a save was refused instead of a bare "failed". */
const POST = async <T,>(path: string, body: unknown): Promise<T> => {
  const r = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((d as { error?: string }).error || "request failed");
  return d as T;
};

const noForce = <T extends object>(body: T): Omit<T, "force"> => {
  const { force: _dropped, ...wire } = body as T & { force?: boolean };
  return wire as Omit<T, "force">;
};

export const api = {
  cache:    () => J<Cache>("/dashboard-data.json"),
  vaultPath: () => J<{ vaultPath: string }>("/vault-path"),
  projects: () => J<{ projects: Project[] }>("/projects").then((d) => d.projects ?? []),
  timeline: () => J<{ items: TLItem[] }>("/timeline").then((d) => d.items ?? []),
  events:   (fromIso?: string, toIso?: string) => {
    const qs = new URLSearchParams();
    if (fromIso) qs.set("from", fromIso);
    if (toIso) qs.set("to", toIso);
    return J<{ events: Event[]; categories: { key: EvtCategory; color: string; virtual?: boolean }[] }>("/events?" + qs.toString());
  },
  createEvent: async (e: { title: string; date: string; category: EvtCategory;
                           allDay?: boolean; startTime?: string; endTime?: string;
                           repeatsYearly?: boolean; note?: string; link?: string;
                           project?: string | null }) => {
    const r = await fetch("/events/create", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(e),
    });
    return r.json() as Promise<{ ok?: boolean; error?: string; path?: string }>;
  },
  updateEvent: async (e: { path: string; title: string; date: string; category: EvtCategory;
                           allDay?: boolean; startTime?: string; endTime?: string;
                           repeatsYearly?: boolean; note?: string; link?: string;
                           project?: string | null }) => {
    const r = await fetch("/events/update", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(e),
    });
    return r.json() as Promise<{ ok?: boolean; error?: string; path?: string }>;
  },
  eventBody: (path: string) => J<{ ok?: boolean; error?: string; body?: string }>("/events/read?path=" + encodeURIComponent(path)),
  deleteEvent: async (path: string) => {
    const r = await fetch("/events/delete", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }),
    });
    return r.json() as Promise<{ ok?: boolean; error?: string }>;
  },
  resolveEvent: async (path: string, done: boolean) => {
    const r = await fetch("/events/resolve", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, done }),
    });
    return r.json() as Promise<{ ok?: boolean; error?: string; completed?: boolean }>;
  },
  daily:    () => J<{ days: DayStat[] }>("/daily").then((d) => d.days ?? []),
  activity: () => J<{ recent: Recent[] }>("/activity").then((d) => d.recent ?? []),
  search:   (q: string) => J<{ hits: Hit[] }>("/search?q=" + encodeURIComponent(q)).then((d) => d.hits ?? []),
  today:    () => J<Today>("/today"),
  tags:     () => J<{ tags: TagStat[]; index?: { ready: boolean; tagCount: number; files: number } }>("/tags"),
  tagOccurrences: (tag: string) => J<TagOccurrences>("/tags/occurrences?tag=" + encodeURIComponent(tag)),
  reading:  () => J<Reading>("/reading"),
  readingArchive: (q: string) =>
    J<{ archived: ArchivedList[] }>("/reading/archive?q=" + encodeURIComponent(q)).then((d) => d.archived ?? []),
  // dynamic "add a reading" search — your own corpus (already-read papers + clippings)
  readingCorpusSearch: (q: string) =>
    J<{ hits: CorpusHit[] }>("/reading/corpus-search?q=" + encodeURIComponent(q)).then((d) => d.hits ?? []),
  readingInbox: () => J<{ count: number; items: InboxFile[] }>("/reading/inbox/list"),
  readingInboxDetail: (name: string) =>
    J<InboxDetail>("/reading/inbox/detail?name=" + encodeURIComponent(name)),
  readingInboxPdfUrl: (name: string) => "/reading/inbox/pdf?name=" + encodeURIComponent(name),
  readingInboxCheckStem: (stem: string) =>
    J<InboxStemCheck>("/reading/inbox/check-stem?stem=" + encodeURIComponent(stem)),
  // citation metadata suggestions (CrossRef/OpenLibrary/OpenAlex) + live BibTeX preview
  readingInboxCiteSuggest: (name: string) =>
    J<CiteSuggest>("/reading/inbox/cite-suggest?name=" + encodeURIComponent(name)),
  readingInboxCitePreview: async (fields: CiteFields): Promise<CitePreview> => {
    const r = await fetch("/reading/inbox/cite-preview", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fields }),
    });
    return r.json();
  },
  readingInboxAct: async (body: {
    action: "file" | "archive"; name: string; stem?: string; reason?: string;
    link?: { list: string; group: number; item: number; title?: string; where?: QueueWhere; file?: string | null } | null;
    citation?: CiteFields | null;
  }): Promise<InboxActResult> => {
    const r = await fetch("/reading/inbox/act", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const d = await r.json().catch(() => ({ error: `server returned HTTP ${r.status}` }));
    if (!r.ok && !d.error) d.error = `server returned HTTP ${r.status} — restart serve.py?`;
    return d;
  },
  // print-book note-taker: reference capture + page-anchored quotes/notes (printbook.py)
  printbookList: () => J<{ ok: boolean; books: string[] }>("/printbook/list").then((d) => d.books ?? []),
  printbookGet: (stem: string) => J<PrintBook>("/printbook/get?stem=" + encodeURIComponent(stem)),
  printbookOp: async <T = PrintBookResult>(op: "lookup" | "create" | "add" | "delete", body: Record<string, unknown>): Promise<T> => {
    const r = await fetch("/printbook/" + op, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return r.json().catch(() => ({ ok: false, error: `server returned HTTP ${r.status}` }));
  },
  // generic reading mutation — one POST helper for every /reading/<op>
  readingOp: async (op: string, body: Record<string, unknown>): Promise<{ ok?: boolean; name?: string; readState?: ReadState }> => {
    const r = await fetch("/reading/" + op, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(op + " failed");
    return r.json();
  },
  // the read-next queue and the read-by dates; each write goes through readingOp
  readingNext: () => J<ReadingNext>("/reading/next"),
  readingItemNext: (ref: ReadingItemRef, on: boolean, position?: number) =>
    api.readingOp("item/next", { ...ref, on, ...(position != null ? { position } : {}) }),
  readingNextReorder: (order: string[]) => api.readingOp("next/reorder", { order }),
  readingQueueAdd: async (body: { doi?: string; title?: string; why?: string; source?: string }): Promise<QueueAddResult> => {
    const r = await fetch("/reading/queue/add", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const d = await r.json().catch(() => ({ ok: false, error: `server returned HTTP ${r.status}` }));
    if (!r.ok && !d.error) d.error = `server returned HTTP ${r.status}`;
    return d;
  },
  // OpenAlex import: preview (mode+query) -> {items, author?}, or build (items+listName) -> {built}
  readingImportPreview: async (mode: string, query: string, limit?: number): Promise<OAImport> => {
    const r = await fetch("/reading/openalex-import", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode, query, limit }),
    });
    // surface the server's error (incl. HTTP 404 when serve.py hasn't been restarted)
    const body = await r.json().catch(() => ({ error: `server returned HTTP ${r.status}` }));
    if (!r.ok && !body.error) body.error = `server returned HTTP ${r.status} — restart serve.py?`;
    return body;
  },
  readingImportBuild: async (items: OAItem[], listName: string, query?: string): Promise<OAImport> => {
    const r = await fetch("/reading/openalex-import", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ build: true, items, listName, query }),
    });
    const body = await r.json().catch(() => ({ error: `server returned HTTP ${r.status}` }));
    if (!r.ok && !body.error) body.error = `server returned HTTP ${r.status}`;
    return body;
  },
  // back-compat: add a clipping/source straight to a list (used by Inbox/Recently-opened +)
  readingAdd: async (list: string, path: string, title: string): Promise<void> => {
    const r = await fetch("/reading/item/add", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ list, title, citationPath: path, needsDownload: false }),
    });
    if (!r.ok) throw new Error("add failed");
  },
  rebuildCache: async (): Promise<void> => {
    const r = await fetch("/rebuild-cache", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    if (!r.ok) throw new Error("rebuild failed");
  },
  toggleHabit: async (key: string): Promise<Record<string, boolean>> => {
    const r = await fetch("/daily/habit", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key }),
    });
    if (!r.ok) throw new Error("toggle failed");
    return (await r.json()).habits as Record<string, boolean>;
  },
  routines: () => J<Routines>("/routines"),
  ambient:  () => J<Ambient>("/ambient"),
  dailySection: async (anchor: SectionAnchor, text: string, date?: string): Promise<{ ok: boolean; created?: boolean }> => {
    const r = await fetch("/daily/section", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(date ? { anchor, text, date } : { anchor, text }),
    });
    if (!r.ok) throw new Error("section failed");
    return r.json();
  },
  dailySections: (date: string) => J<DayJournal>("/daily/sections?date=" + encodeURIComponent(date)),
  dailyRecent: (days = 6) => J<{ days: JournalDayMeta[] }>("/daily/recent?days=" + days).then((d) => d.days ?? []),
  dailyDates: () => J<{ dates: string[]; today: string }>("/daily/dates"),
  dailyRead: (date: string) => J<DayNote>("/daily/read?date=" + encodeURIComponent(date)),
  canon: () => J<{ quotes: Quote[] }>("/canon").then((d) => d.quotes ?? []),
  learning: () => J<LearnScan>("/learning"),
  learningQueue: (deck: string, limit = 40, opts?: { module?: string; ordered?: boolean; random?: boolean; image?: boolean }) => {
    const qs = new URLSearchParams({ deck, limit: String(limit) });
    if (opts?.module) qs.set("module", opts.module);
    if (opts?.ordered) qs.set("ordered", "1");
    if (opts?.random) qs.set("random", "1");   // "All modules — random" (interleaved practice)
    if (opts?.image) qs.set("image", "1");
    return J<{ cards: FlashCard[] }>("/learning/queue?" + qs.toString()).then((d) => d.cards ?? []);
  },
  learningBoard: async (inProgress: string[], queue: string[]): Promise<LearnScan> => {
    const r = await fetch("/learning/board", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ inProgress, queue }),
    });
    if (!r.ok) throw new Error("board save failed");
    return r.json();
  },
  learningReview: async (path: string, ord: number, response: string): Promise<{ ok: boolean; next?: string; interval?: number }> => {
    const r = await fetch("/learning/review", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, ord, response }),
    });
    if (!r.ok) throw new Error("review failed");
    return r.json();
  },
  // flag the card under review for correction; `clear` drops the flag again
  learningFlag: async (card: { path: string; ord: number; deck?: string; front?: string },
                       opts?: { reason?: string; clear?: boolean }): Promise<{ ok: boolean; flag?: CardFlag; cleared?: boolean; id?: string }> => {
    const r = await fetch("/learning/flag", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...card, reason: opts?.reason ?? "", ...(opts?.clear ? { clear: true } : {}) }),
    });
    if (!r.ok) throw new Error("flag failed");
    return r.json();
  },
  board:    (path: string) => J<Board>("/board?path=" + encodeURIComponent(path)),
  boardOp:  async (path: string, op: string, body: unknown): Promise<Board> => {
    const r = await fetch("/board/" + op + "?path=" + encodeURIComponent(path), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error("op failed");
    return r.json();
  },
  open:     (file: string) => opener.openFile(file).catch(() => {}),
  openUrl:  (url: string) => opener.openUrl(url).catch(() => {}),
  projectProposal: (slug: string) => J<ProjectProposal>(`/project/proposal?slug=${encodeURIComponent(slug)}`),
  projectPlans: () => J<{ plans: ProjectPlan[] }>("/project/plans").then((d) => d.plans ?? []),
  finalizeProject: async (slug: string, override?: { tasks?: ProjectTask[] }): Promise<ProjectFinalize> => {
    const r = await fetch("/project/finalize", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...(override || {}), slug }) });
    if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error((e as { error?: string }).error || "approve failed"); }
    return r.json();
  },
  dismissProject: async (slug: string): Promise<{ ok: boolean; status: string }> => {
    const r = await fetch("/project/dismiss", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug }) });
    if (!r.ok) throw new Error("dismiss failed");
    return r.json();
  },

  saveProject: async (patch: Partial<ProjectProposal>): Promise<ProjectProposal> =>
    POST<ProjectProposal>("/project/save", patch),
  newProject: async (intent: Partial<ProjectProposal>): Promise<ProjectProposal> =>
    POST<ProjectProposal>("/project/new", intent),

  boardProposals: (all = false) =>
    J<BoardProposalList>(`/board/proposals?${all ? "all=1&" : ""}`),
  acceptProposal: async (id: string, card?: Partial<BoardProposal>): Promise<AcceptResult> =>
    POST<AcceptResult>("/board/proposals/accept", { id, card }),
  rejectProposal: async (id: string): Promise<BoardProposalList> =>
    POST<BoardProposalList>("/board/proposals/reject", { id }),
  // unpin the finalized chain from the timeline; its record moves to Insights → Archive
  archiveProject: async (slug: string): Promise<{ ok?: boolean; status?: string; error?: string }> => {
    const r = await fetch("/project/archive", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug }) });
    return r.json();
  },
  // the reflective record for the Insights Archive pane
  insightsArchive: () => J<ArchiveData>("/insights/archive"),
  readingInboxPdfs: () => J<{ count: number; names: string[] }>("/reading/inbox-pdfs"),
  noteCapture: async (body: string, title?: string): Promise<{ ok: boolean; filename: string; inbox: number }> => {
    const r = await fetch("/note/capture", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body, title, source: "dashboard" }) });
    if (!r.ok) throw new Error("capture failed");
    return r.json();
  },
  noteInbox: () => J<{ count: number; items: NoteInboxItem[] }>("/note/inbox"),
  notesAll: () => J<{ count: number; items: NoteItem[] }>("/notes/all"),
  // the note knowledge graph + single-note read/save for the graph drawer
  notesGraph: () => J<NoteGraph>("/notes/graph"),
  // 'search through everything' — matching filed notes + inbox + citations/corpus
  // as graph nodes, merged into the live graph so the whole corpus is reachable.
  notesSearch: (q: string, limit = 80) =>
    J<{ nodes: GraphNode[]; count: number }>("/notes/search?q=" + encodeURIComponent(q) + "&limit=" + limit),
  noteRead: async (path: string): Promise<NoteRead> => {
    const r = await J<NoteRead>("/note/read?path=" + encodeURIComponent(path));
    return { ...r, tags: tagList((r as { tags?: unknown }).tags) };
  },
  // top-k semantically nearest filed notes (graceful [] when vectors absent) — the drawer's Related panel
  notesRelated: (path: string, k = 6) =>
    J<{ related: RelatedNote[] }>("/notes/related?path=" + encodeURIComponent(path) + "&k=" + k),
  noteSave: async (path: string, body: string): Promise<{ ok: boolean; path: string; mtime: number; error?: string }> => {
    const r = await fetch("/note/save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, body }) });
    if (!r.ok) throw new Error("save failed");
    return r.json();
  },
  // one-click ARCHIVE from the notes list: soft-delete into Notes/Archive (reversible, never deletes).
  // `archived` is the new path — pass it to noteUnarchive for Undo.
  noteArchive: async (path: string): Promise<{ ok: boolean; title?: string; archived?: string; error?: string }> => {
    const r = await fetch("/note/archive", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }) });
    return r.json();
  },
  noteBlocks: (path: string) => J<NoteBlocks>("/notes/blocks?path=" + encodeURIComponent(path)),
  // write a NEW note straight into its section, skipping the inbox entirely
  noteCreate: async (folder: string, title: string, body = "", tags: string[] = []): Promise<NoteCreated> => {
    const r = await fetch("/note/create", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ folder, title, body, tags }) });
    return r.json();
  },
  noteBlockSave: async (path: string, index: number, patch: { heading?: string; body?: string }): Promise<BlockWrite> => {
    const r = await fetch("/note/block-save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, index, ...patch }) });
    return r.json();
  },
  noteBlockAdd: async (path: string, heading: string, body = "", after?: number, kind?: BlockKind): Promise<BlockWrite & { index?: number }> => {
    const r = await fetch("/note/block-add", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, heading, body, after, ...(kind ? { kind } : {}) }) });
    return r.json();
  },
  noteBlockDelete: async (path: string, index: number): Promise<BlockWrite> => {
    const r = await fetch("/note/block-delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, index }) });
    return r.json();
  },
  noteBlockMove: async (path: string, index: number, to: number): Promise<BlockWrite> => {
    const r = await fetch("/note/block-move", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, index, to }) });
    return r.json();
  },
  // a pasted or dropped image -> Notes/attachments; returns the ![[embed]] to drop in
  noteAttachmentSave: async (data: string, stem: string): Promise<{ ok: boolean; name?: string; embed?: string; url?: string; error?: string }> => {
    const r = await fetch("/note/attachment-save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data, stem }) });
    return r.json();
  },
  // the diagram library — Preparation/Diagrams, each one embeddable in ANY note
  notesDiagrams: () => J<{ count: number; items: DiagramItem[] }>("/notes/diagrams"),
  noteDrawer: (name: string) =>
    J<{ ok?: boolean; name?: string; title?: string; doc?: unknown; mtime?: number; error?: string }>("/notes/drawer?name=" + encodeURIComponent(name)),
  noteDrawerSave: async (body: { name?: string; title?: string; doc: unknown; png: string; baseMtime?: number }) => {
    const r = await fetch("/note/drawer-save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({})) as { ok?: boolean; name?: string; title?: string; png?: string; embed?: string; mtime?: number; conflict?: boolean; currentMtime?: number; error?: string };
    if (!r.ok && !d.conflict) throw new Error(d.error || "diagram save failed");
    return d;
  },
  // rename a library drawing: its files move, [[Old.png]] links in notes follow (409: name taken)
  noteDrawerRename: async (name: string, title: string) => {
    const r = await fetch("/note/drawer-rename", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, title }) });
    return await r.json().catch(() => ({ ok: false, error: "rename failed" })) as { ok: boolean; name?: string; title?: string; png?: string; mtime?: number; notes?: number; error?: string };
  },
  noteDrawerTemplates: () => J<{ count: number; items: DrawerTemplate[] }>("/notes/drawer-templates"),
  noteDrawerTemplateSave: async (body: { name: string; doc: unknown; overwrite?: boolean }) =>
    (await POSTAT<{ ok?: boolean; exists?: boolean; name?: string; error?: string }>("/note/drawer-template-save", body)).data,
  noteDrawerTemplateDelete: (name: string) =>
    POST<{ ok: boolean; name?: string; archived?: string; error?: string }>("/note/drawer-template-delete", { name }),
  // Delete = move the diagram's files into Preparation/Diagrams/archive/; restore undoes it
  noteDiagramArchive: (name: string) =>
    POST<{ ok: boolean; moved?: { from: string; to: string }[]; error?: string }>("/note/diagram-archive", { name }),
  noteDiagramRestore: (moved: { from: string; to: string }[]) =>
    POST<{ ok: boolean; restored?: string[]; error?: string }>("/note/diagram-restore", { moved }),
  // the byte route every note image resolves through (also the <img src>)
  noteAttachmentUrl: (name: string) => "/notes/attachment?name=" + encodeURIComponent(name),

  noteUnarchive: async (path: string): Promise<{ ok: boolean; title?: string; path?: string; error?: string }> => {
    const r = await fetch("/note/unarchive", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }) });
    return r.json();
  },
  // ---- filing with undo: every file/move answers an undo_id that /note/undo reverses.
  // `folder`/`to` is ideas|concepts|reflections|meetings|authors|project:<key> (+ inbox for a move).
  noteFileTo: (path: string, folder: string) => POST<NoteMoved>("/note/file", { path, folder }),
  noteMove: (path: string, to: string) => POST<NoteMoved>("/note/move", { path, to }),
  noteUndo: (undoId?: string) => POST<{ ok: boolean; path?: string; kept_edited?: boolean; error?: string }>("/note/undo", undoId ? { undo_id: undoId } : {}),
  noteHistory: (limit = 20) => J<{ items: NoteHistoryItem[] }>("/note/history?limit=" + limit),
  notesArchived: () => J<{ items: ArchivedNote[] }>("/notes/archived"),
  notesProjectTargets: () => J<{ projects: ProjectTarget[] }>("/notes/project-targets"),
  notesProject: (key: string) => J<ProjectNotesList>("/notes/project?key=" + encodeURIComponent(key)),
  aioaAuthorNotes: () => J<{ notes: { path: string; title: string; created: string; mtime: number }[] }>("/app/author-notes"),
  searchVault: (q: string, limit = 40, signal?: AbortSignal) =>
    fetch("/search/vault?q=" + encodeURIComponent(q) + "&limit=" + limit, signal ? { signal } : undefined)
      .then(async (r) => {
        if (!r.ok) { const e = new Error(`search ${r.status}`) as Error & { status?: number }; e.status = r.status; throw e; }
        const d = await r.json() as VaultSearch;
        return { ...d, hits: (d.hits || []).map((h) => ({ ...h, tags: tagList((h as { tags?: unknown }).tags) })) };
      }),
  aioaOverview: () => J<AioaOverview>("/app/overview"),
  aioaAuthors: (q = "", sort = "works") =>
    J<{ count: number; authors: AioaAuthor[] }>("/app/authors?q=" + encodeURIComponent(q) + "&sort=" + sort),
  aioaAuthor: (key: string) => J<AioaAuthorDetail>("/app/author?key=" + encodeURIComponent(key)),
  aioaCitations: (p: { q?: string; tag?: string; status?: string; type?: string; author?: string; sort?: string; offset?: number; limit?: number }) => {
    const parts = Object.entries(p).filter(([, v]) => v !== undefined && v !== "" && v !== 0)
      .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
    return J<AioaCitationsPage>("/app/citations?" + parts.join("&"));
  },
  aioaMeetings: () => J<{ count: number; items: AioaMeeting[] }>("/app/meetings"),
  // open-or-create the filed note for a calendar meeting; idempotent server-side
  meetingNote: async (event: string): Promise<MeetingNote> => {
    const r = await fetch("/meeting/note", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ event }) });
    return r.json();
  },
  aioaProjects: () => J<{ count: number; projects: AioaProject[] }>("/app/projects"),
  aioaProjectNotes: (name: string) => J<AioaProjectNotes>("/app/projects?name=" + encodeURIComponent(name)),
  aioaAuthorProfile: async (name: string): Promise<{ ok: boolean; path?: string; existed?: boolean; error?: string }> => {
    const r = await fetch("/app/author-profile", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
    return r.json();
  },
  

  draftingPapers: () => afterDraftingGate(() => J<{ papers: DraftingPaper[] }>("/drafting/papers")),
  // planning pipeline — shapes normalised here so a partial response degrades to empty
  planningPipeline: async (): Promise<PlanningPipeline> => {
    const r = await J<Partial<PlanningPipeline>>("/planning/pipeline");
    return { week: r?.week || "", items: Array.isArray(r?.items) ? r.items.filter((x) => x && x.key).map((x) => ({ ...x, next: x.next || "", title: x.title || x.key, commitment: x.commitment || null })) : [] };
  },
  planningCommitments: async (): Promise<PlanCommitment[]> => {
    const r = await J<{ commitments?: PlanCommitment[] }>("/planning/commitments");
    return Array.isArray(r?.commitments) ? r.commitments.filter((c) => c && c.id && c.date) : [];
  },
  planningSaveCommitment: (body: { id?: string; title: string; date: string; project?: string | null; note?: string; done?: boolean }) =>
    POST<{ ok?: boolean; id?: string; error?: string }>("/planning/commitment", body),
  planningDeleteCommitment: (id: string) => POST<{ ok?: boolean; error?: string }>("/planning/commitment/delete", { id }),
  planningSetNext: (key: string, text: string) => POST<{ ok?: boolean; error?: string }>("/planning/next", { key, text }),
  planningSetFocus: (keys: string[]) => POST<{ ok?: boolean; keys?: string[]; error?: string }>("/planning/focus", { keys }),
  draftingDoc: (slug: string, doc = "paper.md") => J<DraftDoc>("/drafting/doc?slug=" + encodeURIComponent(slug) + "&doc=" + encodeURIComponent(doc), 45000),
  draftingDocLite: (slug: string, doc = "paper.md") => J<DraftDoc>("/drafting/doc?slug=" + encodeURIComponent(slug) + "&doc=" + encodeURIComponent(doc) + "&lite=1", 45000),
  draftingSave: async (body: { slug: string; which: DraftWhich; text: string; baseMtime: number | null; doc?: string; baseText?: string }): Promise<DraftSave> => {
    const r = await fetch("/drafting/save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(noForce(body)) });
    const d = await r.json().catch(() => ({})) as DraftSave;
    if (!r.ok && !d.conflict) throw new Error(d.error || "save failed");
    return d;
  },
  draftingSyncEditor: async (slug: string, baseMtime: number | null, doc = "paper.md"): Promise<DraftSync> => {
    const r = await fetch("/drafting/sync-editor", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug, baseMtime, doc }) });
    const d = await r.json().catch(() => ({})) as DraftSync;
    if (!r.ok && !d.conflict) throw new Error(d.error || "sync failed");
    return d;
  },
  draftingOutline: (slug: string, doc = "paper.md") => J<DraftOutline>("/drafting/outline?slug=" + encodeURIComponent(slug) + "&doc=" + encodeURIComponent(doc)),
  draftingOutlinePdf: async (slug: string, doc = "paper.md", open = false): Promise<{ ok: true; blob: Blob; name: string } | { ok: false; error: string }> => {
    const path = "/drafting/outline-pdf?slug=" + encodeURIComponent(slug) + "&doc=" + encodeURIComponent(doc);
    const b = await opener.act(path, { open: open ? "1" : "0" });
    if (!b.ok) {
      const j = await b.json().catch(() => ({} as { error?: string }));
      return { ok: false, error: j.error || "the outline PDF did not build" };
    }
    const r = await fetch(path);
    if (!r.ok) {
      const j = await r.json().catch(() => ({} as { error?: string }));
      return { ok: false, error: j.error || "the outline PDF did not build" };
    }
    const cd = r.headers.get("Content-Disposition") || "";
    const m = /filename="([^"]+)"/.exec(cd);
    return { ok: true, blob: await r.blob(), name: m ? m[1] : slug + "-outline.pdf" };
  },
  draftingSyncOutline: async (slug: string, baseMtime: number | null, doc = "paper.md"): Promise<DraftOutlineSync> => {
    const r = await fetch("/drafting/sync-outline", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug, baseMtime, doc }) });
    const d = await r.json().catch(() => ({})) as DraftOutlineSync;
    if (!r.ok && !d.conflict) throw new Error(d.error || "sync failed");
    return d;
  },
  draftingProjectDocs: (slug: string) =>
    J<DraftProjectDocs>("/drafting/project-docs?slug=" + encodeURIComponent(slug)),
  draftingSupplements: (slug: string) =>
    J<DraftSupplementList>("/drafting/supplements?slug=" + encodeURIComponent(slug)),
  draftingSupplement: (slug: string, name: string) =>
    J<DraftSupplementDoc>("/drafting/supplement?slug=" + encodeURIComponent(slug) + "&name=" + encodeURIComponent(name)),
  draftingCreateSupplement: async (slug: string, name: string): Promise<DraftSupplementDoc> => {
    const r = await fetch("/drafting/supplement-create", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug, name }) });
    return await r.json().catch(() => ({ error: "bad response" })) as DraftSupplementDoc;
  },
  draftingCreateDoc: async (slug: string, name: string, title?: string, kind?: string): Promise<DraftDocCreate> => {
    const r = await fetch("/drafting/doc-create", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug, name, title: title || "", ...(kind ? { kind } : null) }) });
    return await r.json().catch(() => ({ error: "bad response" })) as DraftDocCreate;
  },
  // publication-checklist viewer: every journal in the toolkit, then one journal's
  // checklist/guidelines markdown (file defaults to that journal's best doc).
  draftingJournals: () => J<{ journals: JournalInfo[] }>("/drafting/journals"),
  draftingJournal: (name: string, file = "") =>
    J<JournalChecklist>("/drafting/journal?name=" + encodeURIComponent(name) + (file ? "&file=" + encodeURIComponent(file) : "")),
  draftingChecklist: (slug: string) => J<PaperChecklist>("/drafting/checklist?slug=" + encodeURIComponent(slug)),
  draftingChecklistSources: (slug: string) => J<ChecklistSources>("/drafting/checklist-sources?slug=" + encodeURIComponent(slug)),
  // baseMtime = the mtime last read (0 = no file yet); a 409 answers {error:"stale", text, mtime}
  draftingChecklistSave: async (slug: string, text: string, baseMtime: number): Promise<{ ok?: boolean; mtime?: number; error?: string; text?: string }> => {
    const r = await fetch("/drafting/checklist-save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug, text, baseMtime }) });
    return await r.json().catch(() => ({ error: "bad response" }));
  },
  draftingChecklistTemplateSave: async (journal: string, text: string): Promise<{ ok?: boolean; error?: string }> => {
    const r = await fetch("/drafting/checklist-template-save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ journal, text }) });
    return await r.json().catch(() => ({ error: "bad response" }));
  },
  draftingPublish: async (slug: string, doc = "paper.md", options: DraftPubOptions | null = null, output: "pdf" | "docx" = "pdf"): Promise<DraftPublish> => {
    const r = await fetch("/drafting/publish", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug, doc, options, output }) });
    return await r.json().catch(() => ({ error: "bad response" })) as DraftPublish;
  },
  draftingOpenPdf: (slug: string, doc = "paper.md", which: "paper" | "figures" = "paper") => opener.openResolved<{ ok?: boolean; rel?: string; error?: string }>("/drafting/open-pdf?slug=" + encodeURIComponent(slug) + "&doc=" + encodeURIComponent(doc) + (which === "figures" ? "&which=figures" : "")),
  // Word (.docx) — download URL (attachment) + open in the host's default app (Word)
  draftingDocxUrl: (slug: string, doc = "paper.md", t?: number, which: "paper" | "figures" | "titlepage" = "paper") => "/drafting/docx?slug=" + encodeURIComponent(slug) + "&doc=" + encodeURIComponent(doc) + (which !== "paper" ? "&which=" + which : "") + (t ? "&t=" + t : ""),
  draftingOpenDocx: (slug: string, doc = "paper.md", which: "paper" | "figures" | "titlepage" = "paper") => opener.openResolved<{ ok?: boolean; rel?: string; error?: string }>("/drafting/open-docx?slug=" + encodeURIComponent(slug) + "&doc=" + encodeURIComponent(doc) + (which !== "paper" ? "&which=" + which : "")),
  // Overleaf export zips (toolkit/scripts/export_overleaf.py): download URL + build times
  draftingOverleafUrl: (slug: string, doc = "paper.md", anon = false, t?: number) => "/drafting/overleaf?slug=" + encodeURIComponent(slug) + "&doc=" + encodeURIComponent(doc) + (anon ? "&anon=1" : "") + (t ? "&t=" + t : ""),
  draftingOverleafBuild: async (slug: string, doc = "paper.md"): Promise<OverleafInfo & { log?: string[]; stale?: boolean }> => {
    const r = await fetch("/drafting/overleaf-build", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug, doc }) });
    return r.json().catch(() => ({ error: "HTTP " + r.status }));
  },
  draftingOverleafTex: (slug: string, doc = "paper.md", anon = false) => J<{ ok?: boolean; error?: string; tex?: string; name?: string; mtime?: number; stale?: boolean }>("/drafting/overleaf-tex?slug=" + encodeURIComponent(slug) + "&doc=" + encodeURIComponent(doc) + (anon ? "&anon=1" : "") + "&t=" + Date.now()),
  draftingOverleafInfo: (slug: string, doc = "paper.md") => J<OverleafInfo>("/drafting/overleaf-info?slug=" + encodeURIComponent(slug) + "&doc=" + encodeURIComponent(doc)),
  draftingDocStatus: (slug: string, doc = "paper.md") => J<DraftDocStatus>("/drafting/doc-status?slug=" + encodeURIComponent(slug) + "&doc=" + encodeURIComponent(doc)),
  // anchored review comments — load the durable sidecar, save with optimistic concurrency
  // Review > Rewrite baselines (writing/versioning/rewrite.json); saves merge by id
  draftingRewrite: (slug: string, doc = "paper.md") => J<{ ok?: boolean; paras?: Record<string, RewriteEntry>; error?: string }>("/drafting/rewrite?slug=" + encodeURIComponent(slug) + "&doc=" + encodeURIComponent(doc)),
  draftingRewriteSave: async (body: { slug: string; doc?: string; set?: Record<string, Partial<RewriteEntry> & { rev: number }>; drop?: string[] }): Promise<RewriteSaveResult> => {
    const r = await fetch("/drafting/rewrite-save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({})) as RewriteSaveResult;
    // `status` tells a refusal (4xx: never retry the same bytes) from a dropped connection
    if (!r.ok) throw Object.assign(new Error(d.error || "save failed"), { status: r.status });
    return d;
  },
  // Review > Rewrite: suggested paragraphs (read only; the tab can set only `status`)
  draftingSuggested: (slug: string) => J<{ ok?: boolean; suggestions?: SuggestedParagraph[]; error?: string }>("/drafting/suggested?slug=" + encodeURIComponent(slug)),
  draftingSuggestedStatus: async (slug: string, id: string, status: "open" | "dismissed"): Promise<{ ok?: boolean; error?: string }> => {
    const r = await fetch("/drafting/suggested-status", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug, id, status }) });
    const d = await r.json().catch(() => ({})) as { ok?: boolean; error?: string };
    if (!r.ok) throw new Error(d.error || "could not save");
    return d;
  },
  draftingComments: (slug: string, doc = "paper.md") => J<DraftCommentsLoad>("/drafting/comments?slug=" + encodeURIComponent(slug) + "&doc=" + encodeURIComponent(doc)),
  // the resolved half of the store, fetched once the editor is idle
  draftingResolvedComments: (slug: string, doc = "paper.md") => J<DraftCommentsLoad>("/drafting/comments?slug=" + encodeURIComponent(slug) + "&doc=" + encodeURIComponent(doc) + "&resolved=1"),
  draftingSaveComments: async (body: { slug: string; doc?: string; comments: DraftComment[]; baseMtime: number | null; baseVersion?: string | null; partial?: boolean; deletedIds?: string[] }): Promise<DraftCommentsSave> => {
    const r = await fetch("/drafting/comments-save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({})) as DraftCommentsSave;
    if (!r.ok && !d.conflict) throw new Error(d.error || "save failed");
    return d;
  },
  draftingDiagram: (slug: string, name: string) =>
    J<{ ok?: boolean; stem?: string; xml?: string; mtime?: number; error?: string }>("/drafting/diagram?slug=" + encodeURIComponent(slug) + "&name=" + encodeURIComponent(name)),
  draftingDiagramSave: async (body: { slug: string; name?: string; title?: string; xml: string; png: string; baseMtime?: number; force?: boolean }) => {
    const r = await fetch("/drafting/diagram-save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(noForce(body)) });
    const d = await r.json().catch(() => ({})) as { ok?: boolean; stem?: string; mtime?: number; png?: string; conflict?: boolean; currentMtime?: number; error?: string };
    if (!r.ok && !d.conflict) throw new Error(d.error || "diagram save failed");
    return d;
  },
  draftingFigureComments: (slug: string) => J<FigureCommentsLoad>("/drafting/figure-comments?slug=" + encodeURIComponent(slug)),
  
  draftingSaveFigureComments: async (body: { slug: string; stem: string; items: FigureComment[]; baseMtime: number | null; baseVersion?: string }): Promise<DraftSave & { currentComments?: FigureComment[]; currentVersion?: string; version?: string; comments?: FigureComment[] }> => {
    const r = await fetch("/drafting/figure-comments-save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({})) as DraftSave & { currentComments?: FigureComment[]; currentVersion?: string; version?: string; comments?: FigureComment[] };
    if (!r.ok && !d.conflict) throw new Error(d.error || "save failed");
    return d;
  },
  draftingPublishSetup: (slug: string, doc = "paper.md", output?: DraftOutput) =>
    J<DraftPublishSetup>("/drafting/publish-setup?slug=" + encodeURIComponent(slug) + "&doc=" + encodeURIComponent(doc) + (output ? "&output=" + output : "")),
  // cheap freshness probe for an open Publish panel — never compiles
  draftingPreviewStatus: (slug: string, doc = "paper.md", output: DraftOutput = "pdf") =>
    J<DraftPreviewStatus>("/drafting/preview-status?slug=" + encodeURIComponent(slug) + "&doc=" + encodeURIComponent(doc) + "&output=" + output),
  // the last compile's LaTeX as text (body = \maketitle..\end{document}, tables inlined),
  // for Publish's Copy LaTeX into a coauthor's Overleaf. Resolves the server's error too.
  draftingLatex: async (slug: string, doc = "paper.md", part: "body" | "full" = "body") => {
    const r = await fetch("/drafting/latex?slug=" + encodeURIComponent(slug) + "&doc=" + encodeURIComponent(doc) + "&part=" + part);
    return (await r.json().catch(() => ({ ok: false, error: `failed (${r.status})` }))) as
      { ok: boolean; latex?: string; part?: string; file?: string; stale?: boolean; error?: string };
  },
  // the compiled PDF bytes, for the in-panel preview iframe (t = mtime, cache-busts)
  draftingPdfUrl: (slug: string, doc = "paper.md", t?: number, which: "paper" | "figures" = "paper") => "/drafting/pdf?slug=" + encodeURIComponent(slug) + "&doc=" + encodeURIComponent(doc) + (which === "figures" ? "&which=figures" : "") + (t ? "&t=" + t : ""),
  draftingPdfComments: (slug: string, doc = "paper.md") =>
    J<PdfCommentsLoad>("/drafting/pdf-comments?slug=" + encodeURIComponent(slug) + "&doc=" + encodeURIComponent(doc)),
  
  draftingSavePdfComments: async (body: { slug: string; doc?: string; comments: PdfComment[]; baseMtime: number | null; baseVersion?: string | null }): Promise<PdfCommentsSave> => {
    const r = await fetch("/drafting/pdf-comments-save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(noForce(body)) });
    const d = await r.json().catch(() => ({})) as PdfCommentsSave;
    if (!r.ok && !d.conflict) throw new Error(d.error || "save failed");
    return d;
  },
  draftingPdfTextLayer: (slug: string, doc: string, target: "pdf" | "docx", which = "paper") =>
    J<PdfTextLayer>("/drafting/pdf-text-layer?slug=" + encodeURIComponent(slug) + "&doc=" + encodeURIComponent(doc) + "&target=" + target + "&which=" + which),
  draftingPdfPagePngUrl: (slug: string, doc: string, page: number, target: "pdf" | "docx", which = "paper", v?: number | null) =>
    "/drafting/pdf-page-png?slug=" + encodeURIComponent(slug) + "&doc=" + encodeURIComponent(doc) + "&page=" + page + "&target=" + target + "&which=" + which + (v ? "&v=" + v : ""),
  draftingVersionArtifactUrl: (slug: string, vid: string, which: keyof DraftVersionArtifacts, doc = "paper.md") =>
    "/drafting/version-artifact?slug=" + encodeURIComponent(slug) + "&doc=" + encodeURIComponent(doc) + "&vid=" + encodeURIComponent(vid) + "&which=" + which,
  // VERSION CONTROL — checkpoints + word-level diff + latexdiff redline PDF for reviewers
  draftingVersions: (slug: string, doc = "paper.md") => J<DraftVersionList>("/drafting/versions?slug=" + encodeURIComponent(slug) + "&doc=" + encodeURIComponent(doc)),
  draftingVersionDiff: (slug: string, a: string, b = "current", doc = "paper.md") => J<DraftVersionDiff>("/drafting/version-diff?slug=" + encodeURIComponent(slug) + "&a=" + encodeURIComponent(a) + "&b=" + encodeURIComponent(b) + "&doc=" + encodeURIComponent(doc)),
  draftingSaveVersion: async (slug: string, doc = "paper.md", label = "", note = ""): Promise<{ ok?: boolean; unchanged?: boolean; version?: DraftVersion; error?: string }> => {
    const r = await fetch("/drafting/version-save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug, doc, label, note }) });
    return await r.json().catch(() => ({ error: "bad response" }));
  },
  draftingUpdateVersion: async (slug: string, id: string, label?: string, note?: string, doc = "paper.md"): Promise<{ ok?: boolean; version?: DraftVersion; error?: string }> => {
    const r = await fetch("/drafting/version-update", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug, id, label, note, doc }) });
    return await r.json().catch(() => ({ error: "bad response" }));
  },
  draftingDeleteVersion: async (slug: string, id: string, doc = "paper.md"): Promise<{ ok?: boolean; error?: string }> => {
    const r = await fetch("/drafting/version-delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug, id, doc }) });
    return await r.json().catch(() => ({ error: "bad response" }));
  },
  draftingRestoreVersion: async (slug: string, id: string, doc = "paper.md", baseMtime: number | null = null): Promise<DraftSave & { restoredFrom?: string; text?: string }> => {
    const r = await fetch("/drafting/version-restore", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug, id, doc, baseMtime }) });
    return await r.json().catch(() => ({ error: "bad response" }));
  },
  draftingDiffPdf: async (slug: string, a: string | null, b = "current", doc = "paper.md"): Promise<DraftDiffPdf> => {
    const r = await fetch("/drafting/diff-pdf", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug, a, b, doc }) });
    return await r.json().catch(() => ({ error: "bad response" }));
  },
  draftingDiffPdfUrl: (slug: string, doc = "paper.md", t?: number) => "/drafting/diff-pdf?slug=" + encodeURIComponent(slug) + "&doc=" + encodeURIComponent(doc) + (t ? "&t=" + t : ""),
  draftingOpenDiffPdf: (slug: string, doc = "paper.md") => opener.openResolved<{ ok?: boolean; rel?: string; error?: string }>("/drafting/open-diff-pdf?slug=" + encodeURIComponent(slug) + "&doc=" + encodeURIComponent(doc)),
  // PRESENTATIONS — Marp decks rendered for flick-through review + per-slide comments
  draftingPresentations: () => afterDraftingGate(() => J<{ presentations: DraftPresentation[] }>("/drafting/presentations")),

  draftingReports: () => afterDraftingGate(() => J<{ reports: DraftReport[] }>("/drafting/reports")),
  draftingGrants: () => afterDraftingGate(() => J<{ grants: DraftingPaper[] }>("/drafting/grants")),
  draftingReport: (id: string) => J<{ id?: string; title?: string; text?: string; mtime?: number; error?: string }>("/drafting/report?id=" + encodeURIComponent(id)),
  draftingOpenReport: (id: string) => opener.openResolved<{ ok?: boolean; error?: string }>("/drafting/open-report?id=" + encodeURIComponent(id)),
  draftingOpenPreview: (slug: string, doc = "report.md") => opener.openResolved<{ ok?: boolean; error?: string }>("/drafting/open-preview?slug=" + encodeURIComponent(slug) + "&doc=" + encodeURIComponent(doc)),

  draftingMeasures: () => afterDraftingGate(() => J<{ measures: DraftMeasure[] }>("/drafting/measures")),
  draftingOpenMeasure: (id: string) => opener.openResolved<{ ok?: boolean; error?: string }>("/drafting/open-measure?id=" + encodeURIComponent(id)),
  draftingMeasurePdfUrl: (id: string) => "/drafting/measure-pdf?id=" + encodeURIComponent(id),
  draftingMeasureText: (id: string) => J<{ id?: string; title?: string; kind?: "poem" | "prose"; text?: string; mtime?: number; error?: string }>("/drafting/measure-text?id=" + encodeURIComponent(id)),
  draftingSaveMeasure: async (id: string, text: string, baseMtime: number | null): Promise<{ ok?: boolean; conflict?: boolean; mtime?: number; text?: string; error?: string }> => {
    const r = await fetch("/drafting/measure-save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, text, baseMtime }) });
    return r.json();
  },

  // SYLLABI — course syllabi + formatted reading lists (edit as markdown → the PDF)
  draftingSyllabi: () => afterDraftingGate(() => J<{ syllabi: DraftSyllabus[] }>("/drafting/syllabi")),
  draftingSyllabusText: (id: string) => J<{ id?: string; title?: string; text?: string; mtime?: number; kind?: "syllabus" | "list"; hasPdf?: boolean; error?: string }>("/drafting/syllabus-text?id=" + encodeURIComponent(id)),
  // the rendered PDF GET url; pass a bump `t` to bust the iframe cache after a re-render
  syllabusPdfUrl: (id: string, t?: number) => "/drafting/syllabus-pdf?id=" + encodeURIComponent(id) + (t ? "&t=" + t : ""),
  draftingSyllabusLists: () => J<{ lists: SyllabusList[] }>("/drafting/syllabus-lists"),
  draftingSyllabusSave: async (body: { id: string; text: string; baseMtime: number | null; force?: boolean }): Promise<{ ok?: boolean; conflict?: boolean; mtime?: number; text?: string; error?: string }> => {
    const r = await fetch("/drafting/syllabus-save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(noForce(body)) });
    return r.json();
  },
  draftingSyllabusRender: async (id: string): Promise<{ ok?: boolean; pdf?: string; mtime?: number; log?: string; error?: string }> => {
    const r = await fetch("/drafting/syllabus-render", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
    return r.json();
  },
  draftingSyllabusPush: async (body: { list: string; section?: string | null; name?: string; queueDownloads?: boolean }): Promise<SyllabusPushResult> => {
    const r = await fetch("/drafting/syllabus-push", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return r.json();
  },
  draftingSyllabusDistill: async (body: { slug: string; force?: boolean }): Promise<{ ok?: boolean; path?: string; sections?: number; readings?: number; error?: string }> => {
    const r = await fetch("/drafting/syllabus-distill", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return r.json();
  },

  draftingSetStatus: async (key: string, status: DraftStatus): Promise<{ ok?: boolean; error?: string }> => {
    const r = await fetch("/drafting/status", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key, status }) });
    return r.json();
  },
  draftingReadmeStatus: (slug: string) => J<ReadmeStatus>("/drafting/readme-status?slug=" + encodeURIComponent(slug)),
  draftingLogs: (slug: string) => J<{ slug?: string; exists: boolean; logs: DraftLog[]; error?: string }>("/drafting/logs?slug=" + encodeURIComponent(slug)),
  draftingDatasets: (q: string) => J<{ hits: DatasetHit[]; count: number }>("/drafting/datasets?q=" + encodeURIComponent(q)),
  draftingArchived: () => J<{ archived: ArchivedProject[] }>("/drafting/archived"),
  draftingPin: async (key: string, pinned: boolean): Promise<{ ok?: boolean; error?: string }> => {
    const r = await fetch("/drafting/pin", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key, pinned }) });
    return r.json();
  },
  draftingCreateProject: async (title: string, idea: string, kind: string = "paper"): Promise<{ ok?: boolean; slug?: string; kind?: string; base?: string; doc?: string; error?: string }> => {
    const r = await fetch("/drafting/create-project", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title, idea, kind }) });
    return r.json();
  },
  draftingScaffoldProject: async (slug: string): Promise<{ ok?: boolean; created?: string[]; error?: string }> => {
    const r = await fetch("/drafting/scaffold-project", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug }) });
    return r.json();
  },
  draftingArchiveProject: async (slug: string, mode: "stalled" | "complete"): Promise<{ ok?: boolean; name?: string; error?: string }> => {
    const r = await fetch("/drafting/archive-project", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug, mode }) });
    return r.json();
  },
  draftingRestoreProject: async (name: string): Promise<{ ok?: boolean; slug?: string; error?: string }> => {
    const r = await fetch("/drafting/restore-project", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
    return r.json();
  },
  draftingDeck: (slug: string, deck: string) => J<DraftDeck>("/drafting/deck?slug=" + encodeURIComponent(slug) + "&deck=" + encodeURIComponent(deck)),
  presentState: () => J<PresentState>("/present/state"),
  presentPublish: (body: { slug: string; deck: string; idx: number; active: boolean; src?: "console" | "audience" }) =>
    fetch("/present/state", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(() => undefined).catch(() => undefined),
  presentOpenRemote: async (slug: string, deck: string): Promise<{ ok?: boolean; target?: "obsidian" | "browser"; error?: string }> =>
    opener.openPresent(slug, deck).then((r) => ({ ...r, target: "browser" as const }))
      .catch(() => ({ ok: false, error: "bad response" })),
  draftingDeckReview: (slug: string, deck: string) => J<DeckReview>("/drafting/deck-review?slug=" + encodeURIComponent(slug) + "&deck=" + encodeURIComponent(deck)),
  draftingSaveDeckReview: async (body: { slug: string; deck: string; text: string; baseMtime: number | null; force?: boolean }): Promise<DraftSave> => {
    const r = await fetch("/drafting/deck-review", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(noForce(body)) });
    return await r.json().catch(() => ({ error: "bad response" })) as DraftSave;
  },
  // save ONE slide's speaker note back to the deck's companion notes file (surgical, mtime-guarded)
  draftingSaveDeckNote: async (body: { slug: string; deck: string; slide: number; text: string; baseMtime: number | null; force?: boolean }): Promise<DeckNoteSave> => {
    const r = await fetch("/drafting/deck-note", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(noForce(body)) });
    return await r.json().catch(() => ({ error: "bad response" })) as DeckNoteSave;
  },
  // CONCEPT notes (Preparation/Notes/Concepts) — the outline's clickable, linkable, shared vocabulary
  draftingConcepts: () => J<{ items: DraftConcept[] }>("/drafting/concepts"),
  draftingConcept: (slug: string, name?: string) => J<DraftConceptNote>("/drafting/concept?slug=" + encodeURIComponent(slug) + (name ? "&name=" + encodeURIComponent(name) : "")),
  draftingSaveConcept: async (slug: string, text: string, baseMtime?: number): Promise<DraftConceptNote & { ok?: boolean }> => {
    const r = await fetch("/drafting/concept", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug, text, baseMtime }) });
    return await r.json().catch(() => ({ error: "bad response" })) as DraftConceptNote & { ok?: boolean };
  },
  // deep-link a comment's citation to the EXACT source note + quote, in-dashboard
  draftingSource: (rel: string, quote?: string) =>
    J<SourceNote>("/drafting/source?rel=" + encodeURIComponent(rel) + (quote ? "&quote=" + encodeURIComponent(quote) : "")),
  draftingAssetUrl: (slug: string, name: string) => "/drafting/asset?slug=" + encodeURIComponent(slug) + "&name=" + encodeURIComponent(name),
  draftingTablePngUrl: (slug: string, name: string) => "/drafting/table-png?slug=" + encodeURIComponent(slug) + "&name=" + encodeURIComponent(name),
  draftingEmbed: (slug: string, name: string) => J<{ text?: string; name?: string; typesetPdf?: string | null; error?: string }>("/drafting/embed?slug=" + encodeURIComponent(slug) + "&name=" + encodeURIComponent(name)),
  // Results workbench: the full provenance picture (entries per asset stem + per-embed
  // resolution), and the read-only project-file viewer (script / data / notes).
  draftingProvenance: (slug: string, doc?: string) =>
    J<DraftProvenance>("/drafting/provenance?slug=" + encodeURIComponent(slug) + (doc ? "&doc=" + encodeURIComponent(doc) : "")),
  draftingFile: (slug: string, path: string) =>
    J<DraftFileView>("/drafting/file?slug=" + encodeURIComponent(slug) + "&path=" + encodeURIComponent(path)),
  draftingReplicationFiles: (slug: string) =>
    J<DraftReplicationFiles>("/drafting/replication-files?slug=" + encodeURIComponent(slug)),
  // Findings tab: results/findings.json with live drift per number. Lazy — fetched
  // only when the tab opens, never on the editor's load path.
  draftingFindings: (slug: string) =>
    J<DraftFindings>("/drafting/findings?slug=" + encodeURIComponent(slug)),
  draftingCiteMap: (slug: string, doc = "paper.md") =>
    J<CiteMap>("/drafting/cite-map?slug=" + encodeURIComponent(slug) + "&doc=" + encodeURIComponent(doc)),
  draftingReferences: (slug: string, doc = "paper.md", style: RefStyle = "asa") =>
    J<RefBuild>("/drafting/references?slug=" + encodeURIComponent(slug) + "&doc=" + encodeURIComponent(doc) + "&style=" + style),
  draftingWriteReferences: async (body: { slug: string; doc?: string; style: RefStyle; baseMtime: number | null; force?: boolean }): Promise<RefWrite> => {
    const r = await fetch("/drafting/write-references", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(noForce(body)) });
    return await r.json().catch(() => ({ error: "bad response" })) as RefWrite;
  },
  draftingEditReference: async (body: { slug: string; doc?: string; rel: string; citekey: string; text: string; noteMtime?: number | null; force?: boolean }): Promise<RefEdit> => {
    const r = await fetch("/drafting/edit-reference", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(noForce(body)) });
    return await r.json().catch(() => ({ error: "bad response" })) as RefEdit;
  },
  // Corpus browser: every read paper in the local Citations corpus with preview + a deep
  // link to its note. Empty q = browse all; q filters; sort author|year|relevance|cited.
  draftingCorpus: (slug: string, doc = "paper.md", q = "", sort: CorpusSort = "author", limit = 400) =>
    J<CorpusBrowse>("/drafting/corpus?slug=" + encodeURIComponent(slug) + "&doc=" + encodeURIComponent(doc) + "&q=" + encodeURIComponent(q) + "&sort=" + sort + "&limit=" + limit),
  draftingCorpusSearch: (slug: string, doc = "paper.md", q = "", k = 60, kinds = "") =>
    J<DraftCorpusSearch>("/drafting/corpus-search?slug=" + encodeURIComponent(slug) + "&doc=" + encodeURIComponent(doc) + "&q=" + encodeURIComponent(q) + "&k=" + k + (kinds ? "&kinds=" + encodeURIComponent(kinds) : "")),
  claimsSearch: (q: string, f: ClaimFilters = {}, limit = 60, signal?: AbortSignal) => {
    const p = new URLSearchParams({ q, limit: String(limit) });
    for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
    return fetch("/claims/search?" + p.toString(), signal ? { signal } : undefined).then(async (r) => {
      if (!r.ok) throw new Error(`GET /claims/search failed (${r.status})`);
      return (await r.json()) as ClaimSearch;
    });
  },
  claimsClaim: (id: string) => J<ClaimDetail>("/claims/claim?id=" + encodeURIComponent(id), 15000),
  claimsRelated: (id: string) => J<ClaimRelated>("/claims/related?id=" + encodeURIComponent(id), 15000),
  claimsStats: () => J<{ indexed_claims?: number; claims?: number; building?: boolean }>("/claims/stats", 8000),
  // a cited PRINTED page -> the source PDF + the PHYSICAL page of the file (+ the quote)
  // the one-click integrity report — mirrors exactly what the Publish gates refuse on
  draftingVerify: async (slug: string, doc = "paper.md"): Promise<DraftVerify> => {
    const r = await fetch("/drafting/verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug, doc }) });
    return await r.json().catch(() => ({ error: "bad response" })) as DraftVerify;
  },
  draftingNumbers: (slug: string, doc = "paper.md", opts?: { inserted?: boolean }) =>
    J<DraftNumbers>("/drafting/numbers?slug=" + encodeURIComponent(slug) + "&doc=" + encodeURIComponent(doc)
      + (opts?.inserted ? "&inserted=1" : "")),
  // Insert-number: the catalogue of every citable cell with provenance, the bind that
  // records an insertion in numbers.json, and pin/note/re-snapshot/retire on a binding
  draftingNumbersCatalogue: (slug: string, q = "") =>
    J<NumbersCatalogue>("/drafting/numbers-catalogue?slug=" + encodeURIComponent(slug) + (q ? "&q=" + encodeURIComponent(q) : "")),
  draftingNumbersBind: async (slug: string, entry: NumberBindEntry): Promise<{ ok?: boolean; id?: string; storeMtime?: number; error?: string }> => {
    const r = await fetch("/drafting/numbers-bind", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug, entry }) });
    return await r.json().catch(() => ({ error: "bad response" }));
  },
  draftingNumbersUpdate: async (slug: string, id: string, patch: { key?: boolean; note?: string; resnapshot?: boolean; retire?: boolean; reason?: string }): Promise<{ ok?: boolean; error?: string }> => {
    const r = await fetch("/drafting/numbers-update", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug, id, patch }) });
    return await r.json().catch(() => ({ error: "bad response" }));
  },
  // gate one source line against the LIVE note (quote verbatim + page) before inserting
  draftingVerifyLine: async (line: string): Promise<{ ok: boolean; reason: string }> => {
    const r = await fetch("/drafting/verify-line", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ line }) });
    return await r.json().catch(() => ({ ok: true, reason: "gate unreachable (fail-open)" })) as { ok: boolean; reason: string };
  },
  draftingCitePage: (rel: string, page: string) =>
    J<CitePageTarget>("/drafting/cite-page?rel=" + encodeURIComponent(rel) + "&page=" + encodeURIComponent(page)),
  // bytes URL for a source PDF, so the viewer can open it at a page via '#page=N'
  draftingSourcePdfUrl: (rel: string) => "/drafting/source-pdf?rel=" + encodeURIComponent(rel),
  // Ctrl+F inside a source PDF: every page + snippet where the text occurs (drafting.source_pdf_find)
  draftingSourcePdfFind: (rel: string, q: string) =>
    J<{ hits?: { page: number; before: string; match: string; after: string }[]; pages?: number; error?: string }>(
      "/drafting/source-pdf-find?rel=" + encodeURIComponent(rel) + "&q=" + encodeURIComponent(q)),
  // the collapsed menu's glimpse: one compact snapshot per view (Sidebar, components/glimpse)
  glimpse: () => J<GlimpseSnapshot>("/glimpse"),
};

export type VlSpec = Record<string, unknown>;
export type ExploreColType = "quantitative" | "nominal" | "ordinal" | "temporal";
export type ExploreColumn = { name: string; type: ExploreColType };
export type ExploreMeta = { columns: ExploreColumn[]; n_rows: number; truncated: boolean; labels: Record<string, string> };
export type ExploreSource = {
  family: string; key: string; path: string; columns: string[];
  n_rows: number; filter: string | null; note: string | null;
};
export type ExploreHistory = { version: number; at: string; by: string; note?: string };
export type ExploreSpec = {
  id: string; version: number; kind: "vl" | "image"; title: string; name: string;
  created: string; updated: string; lane: "python" | "r" | "stata" | string; author: string;
  source: ExploreSource | null; code: string; vl: VlSpec | null;
  image: { png: string | null; svg: string | null } | null;
  history: ExploreHistory[];
};
export type ExploreComment = {
  id: string; x: number; y: number; w: number; h: number;
  body: string; resolved: boolean; author: string;
  created: string; updated: string; reply: string; for_agent: boolean;
};
export type ExploreCard = {
  id: string; title: string; kind: "vl" | "image"; lane: string;
  created: string; updated: string; n_rows: number; png: string;
  openComments: number; forAgent: number;
};
export type ExploreIndex = { ok: boolean; generated: string; figures: ExploreCard[]; root: string; note?: string };

export type GalleryFigure = {
  name: string; group: "results" | "supplementary" | "interactive" | "exploration" | "runs";
  rel: string; mtime: number; url: string; w: number; h: number;
  script: string | null; id?: string; ver?: number;
  
  kind?: "figure" | "interactive";
  /** interactive only: the PNG twin's image URL for the card's thumbnail, or null when
   *  the page has no twin (the card then draws a neutral tile with the name). */
  thumb?: string | null;
  
  preview?: string;
  /** the file's size in bytes (results and exploration pictures) */
  size?: number;
};
export type ProjectGallery = {
  ok?: boolean; error?: string; slug: string; name: string; root: string;
  stamp: string; count: number; figures: GalleryFigure[];
};
export type ExploreFigure = {
  ok: boolean; id: string; spec: ExploreSpec; meta: ExploreMeta | null;
  comments: ExploreComment[]; version: string;
  hasData: boolean; hasSvg: boolean; hasPng: boolean; dir: string;
};
export type ExploreSaveSpec = { ok?: boolean; conflict?: boolean; error?: string;
  spec?: ExploreSpec; version?: number; currentSpec?: ExploreSpec; currentVersion?: number;
  render?: string; renderPng?: string; index?: string };
export type ExploreSaveComments = { ok?: boolean; conflict?: boolean; error?: string;
  comments?: ExploreComment[]; version?: string;
  currentComments?: ExploreComment[]; currentVersion?: string };

/** POST that hands back the STATUS as well as the body, because a 409 from the explore
 *  writes carries the state the caller has to merge against — throwing would lose it. */
const POSTAT = async <T,>(path: string, body: unknown): Promise<{ status: number; data: T }> => {
  const r = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const d = await r.json().catch(() => ({}));
  return { status: r.status, data: d as T };
};

export const exploreApi = {
  index: () => J<ExploreIndex>("/explore/index"),
  figure: (id: string) => J<ExploreFigure>("/explore/figure?id=" + encodeURIComponent(id)),
  /** the saved picture. `v` is the spec version: it cache-busts without `?_=`. */
  renderUrl: (id: string, theme: "day" | "night", v: number) =>
    `/explore/render?id=${encodeURIComponent(id)}&theme=${theme}&v=${v}`,
  /** the live preview of an UNSAVED spec — SVG text, or the server's error message.
   *  `body` names the source: {source:"open",id} or {source:"project",slug,stem}. */
  previewAt: async (body: Record<string, unknown>, signal?: AbortSignal): Promise<string> => {
    const r = await fetch("/explore/render", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body), signal,
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({} as { error?: string }));
      throw new Error(d.error || `preview failed (${r.status})`);
    }
    return r.text();
  },
  saveSpecAt: (body: Record<string, unknown>) => POSTAT<ExploreSaveSpec>("/explore/spec-save", body),
  /** a project figure's sibling spec, when its producer left one */
  projectFigure: (slug: string, stem: string) =>
    J<{ ok: boolean; hasSpec: boolean; spec: ExploreSpec | null; meta: ExploreMeta | null; hasData?: boolean }>(
      "/explore/figure?source=project&slug=" + encodeURIComponent(slug) + "&stem=" + encodeURIComponent(stem)),

  selection: (scope?: { sessions?: string[]; project?: string }) =>
    opener.act("/explore/selection", {
      consume: "1", session: (scope?.sessions ?? []).filter(Boolean), ...(scope?.project ? { project: scope.project } : {}),
    }).then((r) => {
      if (!r.ok) throw new Error("/explore/selection → " + r.status);
      return r.json() as Promise<{ ts?: number; source?: string; id?: string; slug?: string; stem?: string; session?: string; project?: string }>;
    }),
  projectGallery: (slug: string) =>
    J<ProjectGallery>("/w/figure/project?slug=" + encodeURIComponent(slug)),
  toAgentAt: (body: Record<string, unknown>) =>
    POSTAT<{ ok?: boolean; error?: string; comment?: ExploreComment; version?: string }>("/explore/to-agent", body),
  saveComments: (body: { id: string; comments: ExploreComment[]; baseVersion: string }) =>
    POSTAT<ExploreSaveComments>("/explore/comments-save", body),
  refetch: (id: string) =>
    POSTAT<{ ok?: boolean; error?: string; meta?: ExploreMeta | null; spec?: ExploreSpec; render?: string }>(
      "/explore/refetch", { id }),
};

export type GlimpseTone = "good" | "warn" | "bad" | "muted";
export type GlimpseView = "today" | "calendar" | "drafting" | "notes" | "reading" | "learning" | "library" | "systems" | "insights";
export type GlimpseSeries = { kind: "bars" | "line" | "dots" | "heat"; label: string; unit?: string; points: { x: string; y: number }[] }; // ≤90
export type Glimpse = {
  headline: string;   // one line, numbers first
  stats: { label: string; value: string | number; tone?: GlimpseTone }[];   // 2–8; the card shows what its region fits
  series?: GlimpseSeries;
  series2?: GlimpseSeries;
  list?: { title: string; meta?: string; tone?: GlimpseTone }[];   // ≤12
  updated: string; error?: string;
};
export type GlimpseSnapshot = { generated: string; views: Record<GlimpseView, Glimpse> };

export type PanelEventKind = "dataset" | "table" | "coding" | "figure" | "pdf";
export type PanelEvent = {
  seq: number; ts: number; kind: PanelEventKind; session: string; project: string;
  family: string; key: string; frame: string; name: string; id: string; title: string;
  
  path: string;
  /** a coding event: the set, and optionally the unit, the pane opens on */
  set: string; unit: string;
  /** a figure event: a picture inside `project` by its project-relative path (`id` is a
   *  store figure instead), and that file's `<mtime_ns hex>-<size hex>` stamp */
  rel: string; v: string;
  /** a pdf event (the Reader tab): a hub document by its hub-relative path (else `rel`
   *  inside `project`), and the page to open on (0 = none) */
  hubRel: string; page: number;
};
export type PanelEvents = { seq: number; events: PanelEvent[] };

/** a document the Reader can open: a hub file by `hubRel`, or a project's PDF by
 *  `project` + `rel`. `v` is the file's stamp (immutable caching when it matches). */
export type ReaderDoc = { hubRel: string; project: string; rel: string; name: string; v: string; bytes: number | null };
export type ReaderGroup = { id: string; label: string; docs: ReaderDoc[] };
export type ReaderCodebooks = { ok: boolean; error: string; family: string; key: string; groups: ReaderGroup[] };

export type PanelProfile = "ready" | "building" | "failed" | "none";
/** one level of a categorical variable, as the profile counted it */
export type PanelLevel = { value: string; label: string; n: number; pct: number };
export type PanelHist = { edges: number[]; counts: number[] };
export type PanelVariable = {
  name: string; label: string; dtype: string; storage: string; ordinal: number;
  n: number | null; miss: number | null; missPct: number | null; uniq: number | null;
  min: number | null; median: number | null; max: number | null;
  mean: number | null; sd: number | null;
  top: PanelLevel[]; hist: PanelHist | null; valueLabels: Record<string, string>;
};
export type PanelDatasetSource = {
  family: string; key: string; path: string; format: string;
  bytes: number | null; mtime: number | null; nRows: number | null; nCols: number | null;
};
export type PanelDataset = {
  ok: boolean; error: string; source: PanelDatasetSource; profile: PanelProfile;
  stamp: string; sampled: boolean; sampleN: number | null;
  /** a very wide file: the LIST payload drops hists and value labels and caps `top`,
   *  so a row draws what it has and the variable detail asks /w/panel/variable */
  trimmed: boolean; trimmedFields: string[];
  variables: PanelVariable[];
};
/** one variable, never trimmed: what the detail view stands on */
export type PanelVariableAnswer = {
  ok: boolean; error: string; source: PanelDatasetSource; profile: PanelProfile;
  variable: PanelVariable | null;
};
export type PanelDatasetCard = {
  family: string; key: string; frame: string; path: string; title: string;
  nRows: number | null; nCols: number | null; ts: number | null; profile: PanelProfile;
};

export type PanelTableGroup = "results" | "supplementary" | "output" | "pushed";
export type PanelTableCard = {
  name: string; rel: string; group: PanelTableGroup; mtime: number | null;
  rows: number | null; cols: number | null; hasPdf: boolean; id: string; title: string;
  /** a pushed DataFrame knows which session pushed it */
  session: string;
};
export type PanelTables = { ok: boolean; error: string; stamp: string; tables: PanelTableCard[] };
export type PanelTableColumn = { key: string; label: string; group: string | null };
export type PanelTableRow = { stub: string; level: number; kind: "panel" | "row" | "sub"; cells: (string | null)[] };
export type PanelTable = {
  ok: boolean; error: string; name: string; title: string; group: PanelTableGroup;
  /** the header text over the stub column; "" leaves it blank, as booktabs usually does */
  stubLabel: string;
  columns: PanelTableColumn[]; rows: PanelTableRow[]; notes: string[];
  png: string | null; shape: [number, number]; truncated: boolean;
};

export type PanelLang = "python" | "stata" | "r";
export const PANEL_LANGS: PanelLang[] = ["python", "stata", "r"];
export type PanelUsage = Record<PanelLang, string>;
export type PanelCatalogDataset = {
  key: string; format: string; bytes: number | null; mtime: number | null;
  rows: number | null; cols: number | null; label: string;
  usage: PanelUsage;
  /** the one-liner, when the hub has one; null otherwise */
  usageShort: PanelUsage | null;
};
export type PanelCatalogFamily = {
  family: string; path: string; readme: boolean; fallback: string | null; n: number;
  datasets: PanelCatalogDataset[];
};
export type PanelCatalog = {
  ok: boolean; error: string; stamp: string; hub: string; families: PanelCatalogFamily[];
};

export type PanelScope = {
  ok: boolean; kind: "project" | "family" | "none"; project: string; label: string;
  families: string[]; whole: string[]; datasets: string[]; evidence: Record<string, string[]>;
  stamp: string;
};

export type PanelDictSource = "recipes" | "dictionary" | "keys";

export type PanelDictKind = "code" | "keys";

export type PanelPlaceholderKind =
  "variable" | "variables" | "family" | "key" | "path" | "int" | "number" | "text";
export type PanelPlaceholder = { name: string; kind: PanelPlaceholderKind; default: string };

export type PanelDictItem = {
  id: string; lane: string; category: string; label: string; cmd: string; desc: string;
  /** the cmd is a block, not a line: the detail keeps its newlines and Send pastes it whole */
  multiline: boolean;
  /** every {{slot}} in `cmd`, in the order it first appears */
  placeholders: PanelPlaceholder[];
  kind: PanelDictKind;
};

const PH_KINDS = new Set<string>(["variable", "variables", "family", "key", "path", "int", "number", "text"]);

/** the {{slots}} in a command, deduped, in first-appearance order */
export const placeholdersIn = (cmd: string): string[] => {
  const out: string[] = [];
  const re = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
  for (let m = re.exec(cmd); m; m = re.exec(cmd)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
};

/** substitute; a slot with no value keeps its braces, which is why Send is gated on filled */
export const fillPlaceholders = (cmd: string, values: Record<string, string>): string =>
  cmd.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g,
    (whole, name: string) => (values[name] ?? "").trim() || whole);
export type PanelDictGroup = { name: string; source: PanelDictSource; items: PanelDictItem[] };
export type PanelDictionary = {
  ok: boolean; error: string; stamp: string; lane: string; groups: PanelDictGroup[];
};

type Raw = Record<string, unknown>;
const pRec = (v: unknown): Raw => (v && typeof v === "object" && !Array.isArray(v) ? (v as Raw) : {});
const pArr = (v: unknown): Raw[] => (Array.isArray(v) ? v.map(pRec) : []);
const pStr = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const pNum = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const pInt = (v: unknown, d = 0): number => pNum(v) ?? d;
const pBool = (v: unknown): boolean => v === true;
const pStrs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const pMap = (v: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(pRec(v))) out[k] = pStr(val);
  return out;
};
const pProfile = (v: unknown): PanelProfile =>
  v === "ready" || v === "building" || v === "failed" ? v : "none";
const pGroup = (v: unknown): PanelTableGroup =>
  v === "supplementary" || v === "output" || v === "pushed" ? v : "results";

const EVENT_KINDS: readonly PanelEventKind[] = ["dataset", "table", "coding", "figure", "pdf"];
const normEvent = (r: Raw): PanelEvent | null => (!(EVENT_KINDS as readonly unknown[]).includes(r.kind) ? null : {
  seq: pInt(r.seq), ts: pNum(r.ts) ?? 0,
  kind: r.kind as PanelEventKind,
  session: pStr(r.session), project: pStr(r.project), family: pStr(r.family),
  key: pStr(r.key), frame: pStr(r.frame), name: pStr(r.name), id: pStr(r.id), title: pStr(r.title),
  path: pStr(r.path), set: pStr(r.set), unit: pStr(r.unit), rel: pStr(r.rel), v: pStr(r.v),
  hubRel: pStr(r.hub_rel ?? r.hubRel), page: Math.max(0, pInt(r.page)),
});
const normReaderDoc = (r: Raw): ReaderDoc => ({
  hubRel: pStr(r.hub_rel ?? r.hubRel), project: pStr(r.project), rel: pStr(r.rel),
  name: pStr(r.name) || (pStr(r.hub_rel ?? r.rel).split("/").pop() || "").replace(/\.pdf$/i, ""),
  v: pStr(r.v), bytes: pNum(r.bytes),
});
const normVariable = (r: Raw, i: number): PanelVariable => {
  const h = pRec(r.hist);
  const edges = Array.isArray(h.edges) ? h.edges.map((x) => pNum(x) ?? 0) : [];
  const counts = Array.isArray(h.counts) ? h.counts.map((x) => pNum(x) ?? 0) : [];
  return {
    name: pStr(r.name), label: pStr(r.label), dtype: pStr(r.dtype) || "str",
    storage: pStr(r.storage), ordinal: pNum(r.ordinal) ?? i,
    n: pNum(r.n), miss: pNum(r.miss), missPct: pNum(r.miss_pct ?? r.missPct), uniq: pNum(r.uniq),
    min: pNum(r.min), median: pNum(r.median), max: pNum(r.max), mean: pNum(r.mean), sd: pNum(r.sd),
    top: pArr(r.top).map((t) => ({
      value: pStr(t.value), label: pStr(t.label) || pStr(t.value), n: pInt(t.n), pct: pNum(t.pct) ?? 0,
    })),
    hist: edges.length > 1 && counts.length ? { edges, counts } : null,
    valueLabels: pMap(r.value_labels ?? r.valueLabels),
  };
};
const normDataset = (d: Raw): PanelDataset => {
  const s = pRec(d.source);
  return {
    ok: d.ok !== false, error: pStr(d.error),
    source: normSource(s),
    profile: pProfile(d.profile), stamp: pStr(d.stamp),
    sampled: pBool(d.sampled), sampleN: pNum(d.sample_n ?? d.sampleN),
    trimmed: pBool(d.trimmed), trimmedFields: pStrs(d.trimmed_fields ?? d.trimmedFields),
    variables: pArr(d.variables).map(normVariable),
  };
};
const normSource = (s: Raw): PanelDatasetSource => ({
  family: pStr(s.family), key: pStr(s.key), path: pStr(s.path), format: pStr(s.format),
  bytes: pNum(s.bytes), mtime: pNum(s.mtime), nRows: pNum(s.n_rows ?? s.nRows), nCols: pNum(s.n_cols ?? s.nCols),
});
const normTable = (d: Raw): PanelTable => {
  const shape = Array.isArray(d.shape) ? d.shape : [];
  return {
    ok: d.ok !== false, error: pStr(d.error), name: pStr(d.name),
    title: pStr(d.title) || pStr(d.name), group: pGroup(d.group),
    stubLabel: pStr(d.stub_label ?? d.stubLabel),
    columns: pArr(d.columns).map((c) => ({
      key: pStr(c.key), label: pStr(c.label) || pStr(c.key),
      group: typeof c.group === "string" && c.group ? c.group : null,
    })),
    rows: pArr(d.rows).map((r) => ({
      stub: pStr(r.stub), level: pInt(r.level),
      kind: r.kind === "panel" || r.kind === "sub" ? r.kind : "row",
      cells: Array.isArray(r.cells) ? r.cells.map((c) => (typeof c === "string" ? c : c == null ? null : String(c))) : [],
    })),
    notes: pStrs(d.notes), png: typeof d.png === "string" && d.png ? d.png : null,
    shape: [pInt(shape[0]), pInt(shape[1])], truncated: pBool(d.truncated),
  };
};

/** a usage block: every lane a string, so no render site guards for a missing language */
const normUsage = (v: unknown): PanelUsage => {
  const r = pRec(v);
  return { python: pStr(r.python), stata: pStr(r.stata), r: pStr(r.r) };
};
/** null unless at least one lane actually carries a short form */
const normUsageShort = (v: unknown): PanelUsage | null => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const u = normUsage(v);
  return u.python || u.stata || u.r ? u : null;
};
const normCatalog = (d: Raw): PanelCatalog => ({
  ok: d.ok !== false, error: pStr(d.error), stamp: pStr(d.stamp), hub: pStr(d.hub),
  families: pArr(d.families).map((f) => {
    const datasets = pArr(f.datasets).map((s) => ({
      key: pStr(s.key), format: pStr(s.format), bytes: pNum(s.bytes), mtime: pNum(s.mtime),
      rows: pNum(s.rows ?? s.n_rows), cols: pNum(s.cols ?? s.n_cols), label: pStr(s.label),
      usage: normUsage(s.usage), usageShort: normUsageShort(s.usage_short ?? s.usageShort),
    }));
    return {
      family: pStr(f.family), path: pStr(f.path), readme: pBool(f.readme),
      fallback: pStr(f.default) || null, n: pNum(f.n) ?? datasets.length, datasets,
    };
  }).filter((f) => !!f.family),
});

const normScope = (d: Raw): PanelScope => {
  const kind = d.kind === "project" || d.kind === "family" ? d.kind : "none";
  const ev: Record<string, string[]> = {};
  const rawEv = pRec(d.evidence);
  for (const k of Object.keys(rawEv)) {
    const v = rawEv[k];
    ev[k] = Array.isArray(v) ? v.map((x) => pStr(x)).filter(Boolean) : [];
  }
  const strs = (v: unknown) => (Array.isArray(v) ? v.map((x) => pStr(x)).filter(Boolean) : []);
  const datasets = strs(d.datasets);
  return {
    ok: d.ok !== false, kind: datasets.length ? kind : "none", project: pStr(d.project),
    label: pStr(d.label), families: strs(d.families), whole: strs(d.whole), datasets,
    evidence: ev, stamp: pStr(d.stamp),
  };
};

/** The cmd names the slots; a declaration only says what KIND each one is and what it
 *  defaults to. A declared slot that is not in the cmd is dropped: it cannot be filled in. */
const normPlaceholders = (raw: unknown, cmd: string): PanelPlaceholder[] => {
  const declared = new Map<string, PanelPlaceholder>();
  for (const p of pArr(raw)) {
    const name = pStr(p.name);
    if (!name) continue;
    const kind = pStr(p.kind);
    declared.set(name, { name, kind: (PH_KINDS.has(kind) ? kind : "text") as PanelPlaceholderKind,
      default: pStr(p.default) });
  }
  return placeholdersIn(cmd).map((n) => declared.get(n)
    || { name: n, kind: "text" as PanelPlaceholderKind, default: "" });
};

const normDictionary = (d: Raw): PanelDictionary => {
  const lane = pStr(d.lane);
  const groups = pArr(d.groups).map((g) => {
    const source: PanelDictSource = g.source === "recipes" ? "recipes"
      : g.source === "keys" ? "keys" : "dictionary";
    return {
      name: pStr(g.name), source,
      items: pArr(g.items).map((i, n) => {
        const keys = source === "keys" || i.kind === "keys";
        return {
          id: pStr(i.id) || pStr(g.name) + ":" + n,
          lane: pStr(i.lane) || lane, category: pStr(i.category) || pStr(g.name),
          label: pStr(i.label), cmd: pStr(i.cmd), desc: pStr(i.desc),
          multiline: !keys && (pBool(i.multiline) || pStr(i.cmd).includes("\n")),
          placeholders: keys ? [] : normPlaceholders(i.placeholders, pStr(i.cmd)),
          kind: (keys ? "keys" : "code") as PanelDictKind,
        };
      }).filter((i) => !!i.label || !!i.cmd),
    };
  }).filter((g) => !!g.name && g.items.length);
  const rank = (s: PanelDictSource) => (s === "recipes" ? 0 : s === "keys" ? 2 : 1);
  return {
    ok: d.ok !== false, error: pStr(d.error), stamp: pStr(d.stamp), lane,
    groups: groups.map((g, i) => ({ g, i })).sort((a, b) =>
      rank(a.g.source) - rank(b.g.source) || a.i - b.i).map((x) => x.g),
  };
};

const qs = (parts: Record<string, string | number | null | undefined>) =>
  Object.entries(parts)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => k + "=" + encodeURIComponent(String(v)))
    .join("&");

export const panelApi = {
  /** the hub's families and their datasets, with the load line for each lane */
  catalog: (): Promise<PanelCatalog> => J<Raw>("/w/panel/catalog").then(normCatalog),
  /** the datasets this pane's project (or data group) uses; empty = no scope */
  scope: (sel: { project?: string; family?: string }): Promise<PanelScope> => {
    const q = qs({ project: sel.project, family: sel.family });
    if (!q) return Promise.resolve(normScope({}));
    return J<Raw>("/w/panel/scope?" + q).then(normScope);
  },
  /** the recipes and cheat dictionary for one lane: what Start lists under the picker */
  dictionary: (lane: string): Promise<PanelDictionary> =>
    J<Raw>("/w/panel/dictionary?lane=" + encodeURIComponent(lane)).then(normDictionary),
  /** the event cursor. `since` omitted = the newest event of each kind. Never cached. */
  events: (session: string, since: number | null): Promise<PanelEvents> =>
    J<Raw>("/w/panel/events" + (qs({ session, since }) ? "?" + qs({ session, since }) : ""))
      .then((d) => ({ seq: pInt(d.seq), events: pArr(d.events).map(normEvent).filter((e): e is PanelEvent => !!e) })),
  /** the Reader: one dataset's codebook(s), then its family's other documents */
  codebooks: (sel: { family?: string; key?: string; path?: string }): Promise<ReaderCodebooks> =>
    J<Raw>("/w/panel/codebooks?" + qs({ family: sel.family, key: sel.key, path: sel.path })).then((d) => ({
      ok: d.ok !== false, error: pStr(d.error), family: pStr(d.family), key: pStr(d.key),
      groups: pArr(d.groups).map((g) => ({ id: pStr(g.id), label: pStr(g.label),
        docs: pArr(g.docs).map(normReaderDoc).filter((x) => !!(x.hubRel || (x.project && x.rel))) }))
        .filter((g) => g.docs.length > 0),
    })),
  
  pdfUrl: (doc: { hubRel?: string; project?: string; rel?: string; v?: string }, page = 0): string =>
    "/w/panel/pdf?" + (doc.hubRel ? qs({ hub_rel: doc.hubRel, v: doc.v }) : qs({ project: doc.project, rel: doc.rel, v: doc.v }))
      + "#" + (page > 0 ? "page=" + page + "&" : "") + "navpanes=0&view=FitH",
  /** one dataset's variables. Names arrive at once; the stats land when profile flips. */
  dataset: (sel: { family?: string; key?: string; frame?: string; path?: string }): Promise<PanelDataset> =>
    J<Raw>("/w/panel/dataset?" + qs({ family: sel.family, key: sel.key, frame: sel.frame, path: sel.path })).then(normDataset),
  /** every dataset this session has loaded, newest first (the Data view's waiting state) */
  datasets: (session: string): Promise<PanelDatasetCard[]> =>
    J<Raw>("/w/panel/datasets" + (session ? "?session=" + encodeURIComponent(session) : "")).then((d) =>
      pArr(d.datasets).map((r) => ({
        family: pStr(r.family), key: pStr(r.key), frame: pStr(r.frame), path: pStr(r.path),
        title: pStr(r.title) || [pStr(r.family), pStr(r.key)].filter(Boolean).join("/")
          || pStr(r.path).split("/").pop() || "",
        nRows: pNum(r.n_rows ?? r.nRows), nCols: pNum(r.n_cols ?? r.nCols),
        ts: pNum(r.ts), profile: pProfile(r.profile),
      }))),
  /** a project's tables, grouped by where they live */
  tables: (slug: string, session: string): Promise<PanelTables> =>
    J<Raw>("/w/panel/tables?" + qs({ slug, session })).then((d) => ({
      ok: d.ok !== false, error: pStr(d.error), stamp: pStr(d.stamp),
      tables: pArr(d.tables).map((r) => ({
        name: pStr(r.name), rel: pStr(r.rel), group: pGroup(r.group), mtime: pNum(r.mtime),
        rows: pNum(r.rows), cols: pNum(r.cols), hasPdf: pBool(r.hasPdf ?? r.has_pdf),
        id: pStr(r.id), title: pStr(r.title) || pStr(r.name), session: pStr(r.session),
      })),
    })),
  /** one variable, untrimmed: the detail view asks for this rather than trusting a row */
  variable: (sel: { family?: string; key?: string; frame?: string; path?: string; name: string }): Promise<PanelVariableAnswer> =>
    J<Raw>("/w/panel/variable?" + qs({ family: sel.family, key: sel.key, frame: sel.frame, path: sel.path, name: sel.name }))
      .then((d) => ({
        ok: d.ok !== false, error: pStr(d.error), source: normSource(pRec(d.source)),
        profile: pProfile(d.profile),
        variable: d.variable && typeof d.variable === "object" ? normVariable(pRec(d.variable), 0) : null,
      })),
  /** one table: the typeset PNG that ships, and the grid behind it */
  table: (sel: { slug: string; name?: string; id?: string }): Promise<PanelTable> =>
    J<Raw>("/w/panel/table?" + qs({ slug: sel.slug, name: sel.name, id: sel.id })).then(normTable),
  /** the Coding view's reads and writes; a getter, because codingApi is declared below */
  get coding() { return codingApi; },
};

export type CodingConfidence = "high" | "medium" | "low";
export type CodingVerdict = "agree" | "disagree" | "unsure";
export type CodingFilter = "" | "todo" | "coded" | "disagree" | "reviewed" | "noted" | "revisit";
export type CodingStatus = "todo" | "draft" | "done";
export type CodingExample = { text: string; reasoning: string };
export type CodingCode = {
  /** display: the human label; short: the one-line definition the option rows show */
  label: string; display: string; short: string; definition: string; decisionRules: string[]; inclusion: string[]; exclusion: string[];
  positive: CodingExample[]; negative: CodingExample[]; confusable: string[];
  derived: boolean; noneOf: string[];
};
export type CodingSetCard = {
  id: string; title: string; project: string; projectName: string; units: number; done: number;
  blind: boolean; coders: string[]; codebookVersion: string; error: string;
};
export type CodingRow = {
  id: string; preview: string; status: CodingStatus; codes: string[];
  disagree: boolean; reviews: number; agentReviews: number; reviewed: boolean;
  
  noted: boolean; note: string;
  
  revisit: string[];
};
export type CodingCoderInfo = { name: string; kind: string; codebookVersion: string; error: string };
export type CodingSet = {
  ok: boolean; error: string; stamp: string;
  set: CodingSetCard & { metaFields: string[]; codebookNote: string; noteMax: number;
    
    choice: "single" | "multi";
    /** the per-code confidence chips, only when the manifest asks */
    confidence: boolean };
  codebook: CodingCode[]; coders: CodingCoderInfo[];
  counts: { total: number; todo: number; draft: number; done: number; disagree: number; reviewed: number; noted: number;
    /** done units a promoted codebook touched (the set's revisit_count) */
    revisit: number };
  ids: string[]; offset: number; limit: number; rows: CodingRow[];
};
/** where in the media a code was seen: seconds into the file, or a box in 0..1 of the picture */
export type CodingAnchor = { t0: number; t1: number } | { x: number; y: number; w: number; h: number };
/** a media set's file. `error` names one the server could not hand over, and then there is no url */
export type CodingMedia = {
  kind: "image" | "audio" | "video"; url: string; mime: string; size: number; stamp: string;
  start: number | null; end: number | null; autoplay: boolean; preview: string; error: string;
};
export type CodingDetail = { code: string; present: boolean; confidence: CodingConfidence; evidence: string; reasoning: string;
  anchor: CodingAnchor | null };
export type CodingRecord = { codesApplied: string[]; details: CodingDetail[]; note: string; codedAt: string; done: boolean };
/** another coder on one code: present true/false, null = its codebook never had the code */
export type CodingCell = { present: boolean | null; confidence: string; evidence: string; reasoning: string; anchor: CodingAnchor | null };
export type CodingCoderView = { name: string; kind: string; codebookVersion: string; coded: boolean; codes: Record<string, CodingCell | null> };
export type CodingReview = {
  id: string; unitId: string; code: string; targetCoder: string; reviewer: string;
  verdict: CodingVerdict; note: string; ts: string; resolved: boolean;
};
/** what the unit is read inside of; every field may be missing */
export type CodingContext = { title: string; opener: string; parent: string; parentIsOpener: boolean; kind: string };
export type CodingUnit = {
  ok: boolean; error: string;
  unit: { id: string; text: string; meta: Record<string, string>; index: number; total: number; context: CodingContext;
    /** null on a text set */
    media: CodingMedia | null;
    /** the codes to look at again after a promotion */
    revisit: string[] };
  record: CodingRecord | null; base: string; revealed: boolean;
  coders: CodingCoderView[]; reviews: CodingReview[];
};
export type CodingPair = { alpha: number | null; pct: number | null; n: number; disagree: string[]; nDisagree: number };
export type CodingAgreement = {
  ok: boolean; error: string; nDone: number; nUnits: number; codes: string[]; coders: string[];
  perCode: Record<string, { vs: Record<string, CodingPair>; pairs: Record<string, CodingPair> }>;
  disagreeUnits: string[];
  /** a short preview of every unit the lists name */
  previews: Record<string, string>;
};
export type CodingSaveBody = {
  project: string; set: string; unit: string; base: string; note: string; done: boolean;
  codes: Record<string, { present: boolean; confidence: CodingConfidence; evidence: string; anchor?: CodingAnchor }>;
};
export type CodingSaveResult = { ok: boolean; conflict: boolean; error: string; record: CodingRecord | null; base: string;
  
  counts: { done: number; total: number } | null };
/** the server's note cap when it does not name one (coding.py NOTE_MAX) */
export const CODING_NOTE_MAX = 2000;

export type CodingDraftCode = CodingCode & { id: string; removed: boolean };
export type CodingDraft = {
  rev: number; updated: string; stale: boolean; basedOn: { version: string; sha256: string };
  codes: CodingDraftCode[];
  changed: Record<string, string[]>; added: string[]; removed: string[]; renamed: Record<string, [string, string]>;
  revisitIfPromoted: number;
  /** the codes are in another order than the file in use */
  reordered: boolean;
  
  reverts: Record<string, string[]>;
};
export type CodingLogEntry = {
  id: string; ts: string; rev: number; op: string; code: string; label: string; field: string;
  before: unknown; after: unknown; unitId: string; why: string;
  /** before / after were cut by the server: show them as text, never parse them */
  truncated: boolean;
  
  reverts: Record<string, string[]>;
};
export type CodingHistoryEntry = {
  version: string; sha256: string; promotedAt: string; fromVersion: string;
  changed: string[]; added: string[]; removed: string[]; renamed: Record<string, string>; note: string;
};
export type CodingLimits = {
  label: number; display: number; short: number; definition: number; listItems: number; listItem: number;
  examples: number; exampleText: number; exampleReasoning: number; codes: number; why: number; version: number;
};
export type CodingCodebook = {
  ok: boolean; error: string; version: string; sha256: string; locked: boolean; lockReason: string;
  /** the set holding the lock, which can be another set on the same file */
  lockedBy: string;
  /** a draft file the server cannot read: its error, and only Discard is offered */
  unreadable: string;
  /** sets whose manifest would stop a promotion */
  brokenSets: string[];
  /** the change log could not be read: its error, shown in place of the log */
  logError: string;
  sharedWith: string[]; codes: CodingCode[]; draft: CodingDraft | null;
  log: CodingLogEntry[]; history: CodingHistoryEntry[]; suggestVersion: string; limits: CodingLimits;
};
export type CodingDraftOp =
  | { op: "set"; code: string; field: string; value: unknown }
  | { op: "add"; after: string | null; label: string }
  | { op: "remove" | "restore"; code: string }
  | { op: "move"; code: string; to: number }
  | { op: "memo" };
/** any codebook write's answer; `status` tells a 400 from a 409 from a 423 */
export type CodingDraftResult = {
  ok: boolean; status: number; error: string; draft: CodingDraft | null; hasDraft: boolean; logAdded: CodingLogEntry[];
  unreadable: boolean; lockedBy: string;
  lockReason: string; stale: boolean; version: string; sha256: string; archive: string; revisitCount: number; sharedWith: string[];
};
export const CODING_LIMITS: CodingLimits = { label: 60, display: 80, short: 300, definition: 4000, listItems: 40, listItem: 600,
  examples: 20, exampleText: 2000, exampleReasoning: 600, codes: 60, why: 600, version: 40 };

const pConf = (v: unknown): CodingConfidence => (v === "medium" || v === "low" ? v : "high");
const pVerdict = (v: unknown): CodingVerdict => (v === "disagree" || v === "unsure" ? v : "agree");
const pStatus = (v: unknown): CodingStatus => (v === "draft" || v === "done" ? v : "todo");
const pExamples = (v: unknown): CodingExample[] => pArr(v).map((x) => ({ text: pStr(x.text), reasoning: pStr(x.reasoning) }));
const normSetCard = (r: Raw): CodingSetCard => ({
  id: pStr(r.id), title: pStr(r.title) || pStr(r.id), project: pStr(r.project),
  projectName: pStr(r.project_name), units: pInt(r.units), done: pInt(r.done), blind: r.blind !== false,
  coders: pStrs(r.coders), codebookVersion: pStr(r.codebook_version), error: pStr(r.error),
});
const normAnchor = (v: unknown): CodingAnchor | null => {
  const r = pRec(v);
  const t0 = pNum(r.t0), t1 = pNum(r.t1);
  if (t0 !== null && t1 !== null) return t0 >= 0 && t1 > t0 ? { t0, t1 } : null;
  const x = pNum(r.x), y = pNum(r.y), w = pNum(r.w), h = pNum(r.h);
  if (x === null || y === null || w === null || h === null) return null;
  return x >= 0 && y >= 0 && w > 0 && h > 0 && x + w <= 1.0001 && y + h <= 1.0001 ? { x, y, w, h } : null;
};
/** a path on this origin, or nothing: the pane never loads media from anywhere else */
const ownPath = (v: unknown): string => { const s = pStr(v); return /^\/(?!\/)/.test(s) ? s : ""; };
const normMedia = (v: unknown): CodingMedia | null => {
  const r = pRec(v);
  const kind = r.kind === "image" || r.kind === "audio" || r.kind === "video" ? r.kind : null;
  if (!kind) return null;
  const url = ownPath(r.url);
  const a = pNum(r.start), b = pNum(r.end);
  const start = a !== null && a >= 0 ? a : null;
  return { kind, url, mime: pStr(r.mime), size: pInt(r.size), stamp: pStr(r.stamp),
    start, end: b !== null && b > (start ?? 0) ? b : null, autoplay: pBool(r.autoplay),
    preview: ownPath(r.preview), error: pStr(r.error) || (url ? "" : "missing") };
};
const normRecord = (v: unknown): CodingRecord | null => {
  if (!v || typeof v !== "object") return null;
  const r = pRec(v);
  return {
    codesApplied: pStrs(r.codes_applied), note: pStr(r.note), codedAt: pStr(r.coded_at), done: pBool(r.done),
    details: pArr(r.code_details).map((d) => ({
      code: pStr(d.code), present: pBool(d.present), confidence: pConf(d.confidence),
      evidence: pStr(d.evidence), reasoning: pStr(d.reasoning), anchor: normAnchor(d.anchor),
    })),
  };
};
const normCode = (x: Raw): CodingCode => ({
  label: pStr(x.label), display: pStr(x.display), short: pStr(x.short),
  definition: pStr(x.definition), decisionRules: pStrs(x.decision_rules),
  inclusion: pStrs(x.inclusion_criteria), exclusion: pStrs(x.exclusion_criteria),
  positive: pExamples(x.positive_examples), negative: pExamples(x.negative_examples),
  confusable: pStrs(x.confusable_with), derived: pBool(x.derived), noneOf: pStrs(x.none_of),
});
const normDraft = (v: unknown): CodingDraft | null => {
  if (!v || typeof v !== "object") return null;
  const r = pRec(v);
  if (r.unreadable === true) return null;
  const b = pRec(r.based_on);
  return {
    rev: pInt(r.rev), updated: pStr(r.updated), stale: r.stale === true,
    basedOn: { version: pStr(b.version), sha256: pStr(b.sha256) },
    codes: pArr(r.codes).map((x) => ({ ...normCode(x), id: pStr(x._id) || pStr(x.label), removed: x.removed === true })),
    changed: Object.fromEntries(Object.entries(pRec(r.changed)).map(([k, x]) => [k, pStrs(x)])),
    added: pStrs(r.added), removed: pStrs(r.removed),
    renamed: Object.fromEntries(Object.entries(pRec(r.renamed)).map(([k, x]) => { const p = pStrs(x); return [k, [p[0] || "", p[1] || ""] as [string, string]]; })),
    revisitIfPromoted: pInt(r.revisit_if_promoted),
    reordered: r.reordered === true || (Array.isArray(r.reordered) && r.reordered.length > 0),
    reverts: Object.fromEntries(Object.entries(pRec(r.reverts)).map(([k, x]) => [k, pStrs(x)])),
  };
};
const normLog = (v: unknown): CodingLogEntry[] => pArr(v).map((x) => ({
  id: pStr(x.id), ts: pStr(x.ts), rev: pInt(x.rev), op: pStr(x.op), code: pStr(x.code), label: pStr(x.label), field: pStr(x.field),
  before: x.before ?? null, after: x.after ?? null, unitId: pStr(x.unit_id), why: pStr(x.why), truncated: x.truncated === true,
  reverts: Object.fromEntries(Object.entries(pRec(x.reverts)).map(([k, v]) => [k, pStrs(v)])),
}));
const draftPost = async (path: string, body: unknown): Promise<CodingDraftResult> => {
  const text = JSON.stringify(body);
  // keepalive so a write on the wire outlives the page; Chromium refuses it past 64 KiB
  const r = await fetch("/w/panel/coding/codebook/" + path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: text, keepalive: text.length < 60000,
  });
  const d = pRec(await r.json().catch(() => ({})));
  return {
    ok: r.ok && d.ok !== false, status: r.status, error: pStr(d.error) || (r.ok ? "" : "not saved (" + r.status + ")"),
    draft: normDraft(d.draft), hasDraft: "draft" in d, logAdded: normLog(d.log_added),
    unreadable: d.unreadable === true || pRec(d.draft).unreadable === true, lockedBy: pStr(d.locked_by),
    lockReason: pStr(d.lock_reason), stale: d.stale === true || /\bstale\b/i.test(pStr(d.error)),
    version: pStr(d.version), sha256: pStr(d.sha256), archive: pStr(d.archive), revisitCount: pInt(d.revisit_count), sharedWith: pStrs(d.shared_with),
  };
};
const normPair = (v: unknown): CodingPair => {
  const r = pRec(v);
  const dis = pStrs(r.disagree);
  return { alpha: pNum(r.alpha), pct: pNum(r.pct), n: pInt(r.n), disagree: dis, nDisagree: pNum(r.n_disagree) ?? dis.length };
};
const pairs = (v: unknown): Record<string, CodingPair> =>
  Object.fromEntries(Object.entries(pRec(v)).map(([k, x]) => [k, normPair(x)]));
const metaStr = (v: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(pRec(v))) out[k] = typeof x === "boolean" ? String(x) : pStr(x);
  return out;
};

/** a GET whose refusal is an answer: the body comes back on any status */
const JA = async (p: string): Promise<Raw> => {
  const r = await fetch(p);
  const d = pRec(await r.json().catch(() => ({})));
  if (!r.ok && d.ok !== false) return { ok: false, error: pStr(d.error) || "the server answered " + r.status };
  return d;
};

export const codingApi = {
  sets: (project: string): Promise<{ ok: boolean; error: string; sets: CodingSetCard[] }> =>
    JA("/w/panel/coding/sets" + (project ? "?project=" + encodeURIComponent(project) : "")).then((d) => ({
      ok: d.ok !== false, error: pStr(d.error), sets: pArr(d.sets).map(normSetCard),
    })),
  set: (sel: { project: string; set: string; filter?: CodingFilter; q?: string; offset?: number; limit?: number }): Promise<CodingSet> =>
    JA("/w/panel/coding/set?" + qs({ project: sel.project, set: sel.set, filter: sel.filter, q: sel.q, offset: sel.offset, limit: sel.limit }))
      .then((d) => {
        const s = pRec(d.set);
        const c = pRec(d.counts);
        return {
          ok: d.ok !== false, error: pStr(d.error), stamp: pStr(d.stamp),
          set: { ...normSetCard(s), metaFields: pStrs(s.meta_fields), codebookNote: pStr(s.codebook_note),
            noteMax: pInt(s.note_max) || CODING_NOTE_MAX,
            choice: s.choice === "single" ? "single" : "multi", confidence: s.confidence === true },
          codebook: pArr(d.codebook).map(normCode).filter((x) => x.label),
          coders: pArr(d.coders).map((x) => ({ name: pStr(x.name), kind: pStr(x.kind), codebookVersion: pStr(x.codebook_version), error: pStr(x.error) })),
          counts: { total: pInt(c.total), todo: pInt(c.todo), draft: pInt(c.draft), done: pInt(c.done),
            disagree: pInt(c.disagree), reviewed: pInt(c.reviewed), noted: pInt(c.noted),
            revisit: pNum(d.revisit_count) ?? pNum(s.revisit_count) ?? pInt(c.revisit) },
          ids: pStrs(d.ids), offset: pInt(d.offset), limit: pInt(d.limit),
          rows: pArr(d.rows).map((r) => ({
            id: pStr(r.id), preview: pStr(r.preview), status: pStatus(r.status), codes: pStrs(r.codes),
            disagree: pBool(r.disagree), reviews: pInt(r.reviews), agentReviews: pInt(r.agent_reviews), reviewed: pBool(r.reviewed),
            noted: pBool(r.noted), note: pStr(r.note), revisit: pStrs(r.revisit),
          })),
        };
      }),
  unit: (sel: { project: string; set: string; unit: string; reveal?: boolean }): Promise<CodingUnit> =>
    JA("/w/panel/coding/unit?" + qs({ project: sel.project, set: sel.set, unit: sel.unit, reveal: sel.reveal ? 1 : null }))
      .then((d) => {
        const u = pRec(d.unit);
        return {
          ok: d.ok !== false, error: pStr(d.error),
          unit: { id: pStr(u.id), text: pStr(u.text), meta: metaStr(u.meta), index: pInt(u.index), total: pInt(u.total),
            context: (() => { const c = pRec(u.context); return { title: pStr(c.title), opener: pStr(c.opener),
              parent: pStr(c.parent), parentIsOpener: c.parent_is_opener === true, kind: pStr(c.kind) }; })(),
            media: normMedia(u.media), revisit: pStrs(u.revisit) },
          record: normRecord(d.record), base: pStr(d.base), revealed: pBool(d.revealed),
          coders: pArr(d.coders).map((c) => ({
            name: pStr(c.name), kind: pStr(c.kind), codebookVersion: pStr(c.codebook_version), coded: pBool(c.coded),
            codes: Object.fromEntries(Object.entries(pRec(c.codes)).map(([k, v]) => [k, v && typeof v === "object" ? {
              present: typeof pRec(v).present === "boolean" ? (pRec(v).present as boolean) : null,
              confidence: pStr(pRec(v).confidence), evidence: pStr(pRec(v).evidence), reasoning: pStr(pRec(v).reasoning),
              anchor: normAnchor(pRec(v).anchor),
            } : null])),
          })),
          reviews: pArr(d.reviews).map((r) => ({
            id: pStr(r.id), unitId: pStr(r.unit_id), code: pStr(r.code), targetCoder: pStr(r.target_coder),
            reviewer: pStr(r.reviewer), verdict: pVerdict(r.verdict), note: pStr(r.note), ts: pStr(r.ts), resolved: pBool(r.resolved),
          })),
        };
      }),
  agreement: (project: string, set: string): Promise<CodingAgreement> =>
    JA("/w/panel/coding/agreement?" + qs({ project, set })).then((d) => ({
      ok: d.ok !== false, error: pStr(d.error), nDone: pInt(d.n_done), nUnits: pInt(d.n_units),
      codes: pStrs(d.codes), coders: pStrs(d.coders), disagreeUnits: pStrs(d.disagree_units), previews: pMap(d.previews),
      perCode: Object.fromEntries(Object.entries(pRec(d.per_code)).map(([k, v]) =>
        [k, { vs: pairs(pRec(v).vs), pairs: pairs(pRec(v).pairs) }])),
    })),
  /** a 409 is an answer too: the other window's record and its base come back with it.
   *  keepalive: a save already on the wire lands even if the pane dies under it. */
  save: async (body: CodingSaveBody): Promise<CodingSaveResult> => {
    const r = await fetch("/w/panel/coding/save", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), keepalive: true,
    });
    const d = pRec(await r.json().catch(() => ({})));
    const c = d.counts && typeof d.counts === "object" ? pRec(d.counts) : null;
    return { ok: r.ok && d.ok !== false, conflict: r.status === 409, error: pStr(d.error) || (r.ok ? "" : "not saved (" + r.status + ")"),
      record: normRecord(d.record), base: pStr(d.base), counts: c ? { done: pInt(c.done), total: pInt(c.total) } : null };
  },
  review: (body: { project: string; set: string; unit?: string; code?: string; targetCoder?: string;
    verdict?: CodingVerdict; note?: string; id?: string; resolved?: boolean }) =>
    POST<Raw>("/w/panel/coding/review", body.id
      ? { project: body.project, set: body.set, id: body.id, resolved: body.resolved !== false }
      : { project: body.project, set: body.set, unit: body.unit, code: body.code,
          target_coder: body.targetCoder, verdict: body.verdict, note: body.note || "" }),
  /** the codebook in use, the draft beside it, the change log and the promotion history */
  codebook: (project: string, set: string): Promise<CodingCodebook> =>
    JA("/w/panel/coding/codebook?" + qs({ project, set })).then((d) => {
      const lim = pRec(d.limits);
      const L = CODING_LIMITS;
      const reason = pStr(d.lock_reason) || (typeof d.locked === "string" ? d.locked : "");
      return {
        ok: d.ok !== false, error: pStr(d.error), version: pStr(d.version), sha256: pStr(d.sha256),
        locked: d.locked === true || !!reason, lockReason: reason, lockedBy: pStr(d.locked_by),
        unreadable: pRec(d.draft).unreadable === true ? pStr(pRec(d.draft).error) || "the draft cannot be read" : "",
        sharedWith: pStrs(d.shared_with), brokenSets: pStrs(d.broken_sets), logError: pStr(d.log_error),
        codes: pArr(d.codes).map(normCode).filter((x) => x.label), draft: normDraft(d.draft),
        log: normLog(d.log), suggestVersion: pStr(d.suggest_version),
        history: pArr(d.history).map((h) => ({
          version: pStr(h.version), sha256: pStr(h.sha256), promotedAt: pStr(h.promoted_at), fromVersion: pStr(h.from_version),
          changed: pStrs(h.changed), added: pStrs(h.added), removed: pStrs(h.removed), renamed: pMap(h.renamed), note: pStr(h.note),
        })),
        limits: { label: pInt(lim.label, L.label), display: pInt(lim.display, L.display), short: pInt(lim.short, L.short),
          definition: pInt(lim.definition, L.definition), listItems: pInt(lim.list_items, L.listItems), listItem: pInt(lim.list_item, L.listItem),
          examples: pInt(lim.examples, L.examples), exampleText: pInt(lim.example_text, L.exampleText),
          exampleReasoning: pInt(lim.example_reasoning, L.exampleReasoning), codes: pInt(lim.codes, L.codes),
          why: pInt(lim.why, L.why), version: pInt(lim.version, L.version) },
      };
    }),
  codebookEdit: (body: { project: string; set: string; baseRev: number | null; unitId: string | null; why: string; ops: CodingDraftOp[] }) =>
    draftPost("edit", { project: body.project, set: body.set, base_rev: body.baseRev, unit_id: body.unitId, why: body.why, ops: body.ops }),
  codebookDiscard: (body: { project: string; set: string; baseRev: number | null }) =>
    draftPost("discard", { project: body.project, set: body.set, base_rev: body.baseRev }),
  codebookRebase: (body: { project: string; set: string; baseRev: number | null }) =>
    draftPost("rebase", { project: body.project, set: body.set, base_rev: body.baseRev }),
  codebookPromote: (body: { project: string; set: string; baseRev: number | null; version: string; note: string }) =>
    draftPost("promote", { project: body.project, set: body.set, base_rev: body.baseRev, version: body.version, note: body.note }),
};
