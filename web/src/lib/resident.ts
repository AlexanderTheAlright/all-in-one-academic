
const q = (() => {
  try { return new URLSearchParams(window.location.search); } catch { return null; }
})();

export const IS_RESIDENT = q?.get("resident") === "1";

let woken = !IS_RESIDENT;          // an ordinary window is awake from the start
if (IS_RESIDENT && typeof window !== "undefined") {
  window.addEventListener("focus", () => { woken = true; }, { once: true });
  // a window that is already focused at load was summoned, not parked
  if (typeof document !== "undefined" && document.hasFocus?.()) woken = true;
}

/** true while this is a resident window that has never been summoned */
export const idleResident = (): boolean => IS_RESIDENT && !woken;
