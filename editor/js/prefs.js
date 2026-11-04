// Cross-project display preferences - font size, waveform zoom/speed, and
// the RSML preview's render mode / hide-disfluencies switches. Unlike
// everything in storage.js (one project's segments, audio, speakers, ...),
// these describe how *this person* likes to view things, not something tied
// to any one project, so they live in localStorage under their own key
// instead of inside the per-project IndexedDB record - opening a different
// or brand-new project keeps them as they were, rather than resetting to
// hardcoded defaults or an older project's own stale snapshot of them.

const KEY = "bhashacheck-ui-prefs-v1";

// Returns whatever subset of { zoom, speed, fontSize, rsmlRenderMode,
// rsmlHideDisfluencies } has been saved before - {} on first run, or if
// localStorage throws (disabled, private-browsing quota, etc.). Callers
// merge this over their own hardcoded defaults, so a missing/corrupt key
// here just falls back to those rather than breaking anything.
export function loadPrefs() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (err) {
    console.warn("[prefs] loadPrefs failed", err);
    return {};
  }
}

export function savePrefs(prefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch (err) {
    console.warn("[prefs] savePrefs failed", err);
  }
}
