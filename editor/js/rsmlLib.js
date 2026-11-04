// The ONE place the app loads the rsml library (RSMLAnnotator) from - every
// other module imports it from here, never straight from the CDN. That makes
// "which RSML version is this app running?" a single fact, which is what an
// exported .rsml file's config records (see exportConfig.js, via RSML_VERSION);
// it also means the browser downloads one copy of the library.
//
// The app follows npm's latest release automatically. At startup it asks the
// npm registry what `rsml`'s latest version is, then imports that exact version
// from the jsDelivr CDN. (jsDelivr's own "@latest" is not used: it is cached for
// up to 12 hours on the CDN and a week in the browser, so it can lag a release
// by a day. The registry's answer is at most five minutes old, and an exact
// version URL is immutable, so it caches forever once fetched.)
//
// If that can't be done - offline, registry blocked or slow, the new version not
// on the CDN yet, or a version that fails to load - it falls back, in order, to
// the last version that loaded successfully in this browser (already in the
// browser's cache, so the app keeps working offline after a first load) and
// then to FALLBACK_VERSION. Whichever one actually loaded is RSML_VERSION.
//
// Two things to know about following "latest":
//   - A new release can change behavior. 3.3.4, for one, changed the library's
//     DEFAULT tag set (no more @silence / @pause defaults; high-pitch / low-pitch
//     added), which untouched projects pick up. The fallback only protects
//     against a version that fails to LOAD, not one that loads and behaves
//     differently.
//   - To stop following latest (say, a release broke something), set
//     PINNED_VERSION below - that version is then the only one ever loaded.
//
// This module uses top-level await, so everything that imports it waits for the
// library to be ready before it runs (browsers since 2021: Chrome/Edge 89,
// Firefox 89, Safari 15).

// Set to a version string (e.g. "3.3.4") to stop following npm's latest.
const PINNED_VERSION = null;

// The last version known to work with this app; used when latest can't be
// determined or loaded and nothing better is remembered. Bump it when you have
// tried the app against a newer release.
const FALLBACK_VERSION = "3.3.4";

const NPM_LATEST_URL = "https://registry.npmjs.org/rsml/latest";
const LOOKUP_TIMEOUT_MS = 3000; // never let a slow registry hold the whole app hostage
const LAST_GOOD_KEY = "bhashacheck-rsml-last-good-v1";
const SEMVER = /^\d+\.\d+\.\d+$/;

const cdnUrl = (version) => `https://cdn.jsdelivr.net/npm/rsml@${version}/rsml.esm.js`;

// npm's latest version of rsml, or null if it can't be had (never throws).
async function latestFromNpm() {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), LOOKUP_TIMEOUT_MS);
  try {
    const res = await fetch(NPM_LATEST_URL, { signal: abort.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { version } = await res.json();
    if (typeof version !== "string" || !SEMVER.test(version)) throw new Error(`unexpected version ${JSON.stringify(version)}`);
    return version;
  } catch (err) {
    console.warn("[rsml] could not look up the latest version on npm:", (err && err.message) || err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function loadVersion(version) {
  const lib = (await import(cdnUrl(version))).default;
  if (typeof lib !== "function") throw new Error("rsml.esm.js did not provide RSMLAnnotator");
  return lib;
}

function readLastGood() {
  try {
    const v = localStorage.getItem(LAST_GOOD_KEY);
    return v && SEMVER.test(v) ? v : null;
  } catch {
    return null;
  }
}

function saveLastGood(version) {
  try {
    localStorage.setItem(LAST_GOOD_KEY, version);
  } catch {}
}

async function loadBest() {
  const candidates = [];
  if (PINNED_VERSION) {
    candidates.push(PINNED_VERSION);
  } else {
    const latest = await latestFromNpm();
    if (latest) candidates.push(latest);
    const lastGood = readLastGood();
    if (lastGood) candidates.push(lastGood);
    candidates.push(FALLBACK_VERSION);
  }
  const tried = [];
  for (const version of candidates) {
    if (tried.includes(version)) continue;
    tried.push(version);
    try {
      const lib = await loadVersion(version);
      if (!PINNED_VERSION) saveLastGood(version);
      return { lib, version };
    } catch (err) {
      console.warn(`[rsml] could not load rsml@${version}:`, (err && err.message) || err);
    }
  }
  throw new Error(`could not load the rsml library (tried ${tried.join(", ")})`);
}

const { lib, version } = await loadBest();

export const RSML_VERSION = version;

export default lib;
