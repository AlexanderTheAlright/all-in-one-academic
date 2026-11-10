

const HOLD_MAX_MS = 8_000;

let gate: Promise<void> | null = null;
let release: (() => void) | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

/** Hold the six Drafting library lists. Idempotent; a second call does not extend the hold. */
export function holdDraftingLists(maxMs: number = HOLD_MAX_MS): void {
  if (gate) return;
  gate = new Promise<void>((resolve) => { release = resolve; });
  timer = setTimeout(() => releaseDraftingLists(), maxMs);
}

/** Let them go. Safe to call when nothing is held, and safe to call twice. */
export function releaseDraftingLists(): void {
  if (timer !== null) { clearTimeout(timer); timer = null; }
  const r = release;
  release = null;
  gate = null;
  r?.();
}

/** True while the six are held — for tests and for the probe. */
export function draftingListsHeld(): boolean { return gate !== null; }

/** Run `job` now, or as soon as the hold lifts. Resolves with whatever `job` resolves to. */
export function afterDraftingGate<T>(job: () => Promise<T>): Promise<T> {
  const g = gate;
  return g ? g.then(job) : job();
}
