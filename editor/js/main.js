// App shell: state, persistence, screen routing, the upload/setup screens
// (upload audio, then import an RSML/SRT file or run client-side VAD), and rehydration
// on load. editor.js imports the helpers exported here.

import * as storage from "./storage.js";
import { loadPrefs, savePrefs } from "./prefs.js";
import * as wav from "./wav.js";
import { parseSRT, buildRSML } from "./srt.js";
import { buildExportConfig } from "./exportConfig.js";
import { mountEditor, unmountEditor } from "./editor.js";
import { renderRsmlSettings } from "./rsmlSettings.js";
import { renderCodeMixDefault, renderSpeakerSettings, defaultSpeakerId } from "./speakers.js";
import { renderInsights } from "./insights.js";
import { BHASHACHECK_VERSION } from "./version.js";
import { RSML_VERSION } from "./rsmlLib.js";
import { libraryId, fetchAudio, fetchRsml, fetchIndex, saveRsml, hasUnsaved } from "./library.js";

// Library mode (library.js): index.html?id=<video id> opens that video, with its audio and RSML
// fetched from the local server and every edit autosaved back into the RSML file. Nothing is kept
// in the browser while also syncing to the Hub. Without ?id= nothing below changes.
const LIB = libraryId();
const DECODE_OPTS = LIB ? { sampleRate: 16000 } : undefined; // the library's audio is 16 kHz

// ---------------------------------------------------------------- state ----

// Hardcoded fallback for whichever of these localStorage has never saved
// (first run, or an older save from before a given field existed).
// rsmlRenderMode/rsmlHideDisfluencies drive the RSML preview's Normalized/
// Verbatim and "hide disfluencies" switches in the editor toolbar - see
// editor.js's wireRsmlDisplay()/applyGlobalRsmlDisplay().
const UI_PREF_DEFAULTS = {
  zoom: 40,
  speed: 1,
  fontSize: 16,
  rsmlRenderMode: "normalized", // or "verbatim"
  rsmlHideDisfluencies: true,
};

const newState = () => ({
  version: 1,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  audioMeta: null, // { name, type, size, duration }
  segments: [], // { id, start, end, rsml, speaker, verified, flagged, note } - speaker is a speakers[].id or null
  speakers: [], // { id, gender, language } - the language this speaker speaks in; id is stable: monotonic, never reused; id 1 is
  // permanent (can't be removed) and doubles as "the" default speaker - see
  // speakers.js's defaultSpeakerId().
  defaultCodeMixLanguage: null, // language code; boosted to the top of the `!` autocomplete popup
  accents: {}, // { id: name } - app-only vocabulary for $id[...](...) accent tags; rsml itself has
  // no accents category (no add()/remove() support, unlike dialects/domains) so this is
  // maintained here and fed into the `$` autocomplete by editor.js's patchCompletions().
  // `screen` is the one field here that's genuinely per-project (which
  // screen this project was left on); every other field is a cross-project
  // display preference persisted separately in localStorage (see
  // prefs.js) - seeded from there up front so a brand-new project opens
  // with this person's actual current preferences, not hardcoded defaults.
  ui: { screen: "upload", ...UI_PREF_DEFAULTS, ...loadPrefs() },
  // null until the user customizes something in Settings -> RSML tags; a
  // straight snapshot of an RSMLAnnotator's own .opts otherwise (see
  // rsmlSettings.js). The library's own built-in defaults apply until then
  // — editor.js spreads this in as-is when constructing each segment's
  // annotator.
  rsmlConfig: null,
});

let state = newState();

// Not persisted; rebuilt each session.
export const runtime = {
  workingBlob: null,
};

export function getState() {
  return state;
}

export function segId() {
  return "s" + Math.random().toString(36).slice(2, 9);
}

// -------------------------------------------------------------- persist ----

let saveTimer = null;
const savedBadge = () => document.getElementById("save-indicator");

export function scheduleSave() {
  markDirty();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 500);
}

export async function saveNow({ urgent = false } = {}) {
  clearTimeout(saveTimer);
  state.updatedAt = Date.now();
  // Piggybacks on every debounced save rather than each individual control's
  // own handler - cheap even when unrelated (a segment edit, say) triggered
  // this save, and guarantees the two copies (this project's IndexedDB
  // record and the cross-project localStorage prefs) never drift apart.
  savePrefs({
    zoom: state.ui.zoom,
    speed: state.ui.speed,
    fontSize: state.ui.fontSize,
    rsmlRenderMode: state.ui.rsmlRenderMode,
    rsmlHideDisfluencies: state.ui.rsmlHideDisfluencies,
  });
  if (LIB) {
    // Keep a local recovery copy on every edit, including when Hub permissions/network fail.
    if (!state.segments.length) return;
    const text = buildRSML(state.segments, buildExportConfig(state));
    try {
      await storage.saveLibraryRsml(LIB, text);
      const b = savedBadge();
      if (b) { b.textContent = "Saved locally"; b.className = "save-indicator saved"; }
    } catch (err) {
      console.warn("local recovery save failed", err);
      const b = savedBadge();
      if (b) { b.textContent = "Local save failed"; b.className = "save-indicator error"; }
    }
    // Hub writes run on the five minute timer or when the user explicitly syncs/leaves.
    if (urgent) await syncToDisk(true);
    return;
  }
  try {
    await storage.saveState(state);
    const b = savedBadge();
    if (b) {
      b.textContent = "All changes saved";
      b.className = "save-indicator saved";
    }
  } catch (err) {
    console.warn("save failed", err);
    const b = savedBadge();
    if (b) {
      b.textContent = "Save failed";
      b.className = "save-indicator error";
    }
  }
}

// Library mode: a save writes the whole RSML into the video's file (library.js). The library queues
// the writes (one at a time, the newest text wins, commits spaced out), so this hands over the
// current text and reports the outcome once nothing newer is waiting. urgent: leaving the video.
function syncToDisk(urgent = false) {
  let ok = true;
  let reason = "";
  return saveRsml(LIB, buildRSML(state.segments, buildExportConfig(state)), { urgent }).then(
    () => {},
    (err) => {
      ok = false;
      reason = err.status === 401 ? "LOCAL COPY SAVED - add a token on the library page" : err.status === 403 ? "LOCAL COPY SAVED - token needs write access to OpenBhasha/rsml-bench" : "LOCAL COPY SAVED - Hugging Face sync failed";
      console.warn("disk save failed", err);
      const b = savedBadge();
      if (b) b.title = err.message || "";
    }
  ).then(() => {
    if (hasUnsaved()) return;   // a newer save is still waiting, and its outcome is the one to show
    const b = savedBadge();
    if (b) {
      b.textContent = ok ? "All changes saved" : reason;
      b.className = `save-indicator ${ok ? "saved" : "error"}`;
      if (ok) b.title = "";
    }
  });
}

function markDirty() {
  const b = savedBadge();
  if (b) {
    b.textContent = "Saving...";
    b.className = "save-indicator dirty";
  }
}

// --------------------------------------------------------------- toast ----

export function toast(message, kind = "info") {
  const area = document.getElementById("toast-area");
  if (!area) return;
  const el = document.createElement("div");
  el.className = `app-toast toast-${kind}`;
  el.innerHTML = `<span>${escapeHtml(message)}</span><button aria-label="Dismiss">&times;</button>`;
  el.querySelector("button").onclick = () => el.remove();
  area.appendChild(el);
  setTimeout(() => el.remove(), kind === "error" ? 9000 : 5000);
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// -------------------------------------------------------------- router ----

export async function showScreen(name) {
  state.ui.screen = name;
  for (const s of document.querySelectorAll("main > section")) {
    s.hidden = s.id !== `screen-${name}`;
  }
  document.body.dataset.screen = name;

  if (name === "editor") await mountEditor();
  else unmountEditor();

  scheduleSave();
}

// ------------------------------------------------------- working audio ----

export async function setWorkingAudio(blob) {
  runtime.workingBlob = blob;
  if (!LIB) await storage.putAudio("audio", blob); // library mode fetches the file from the server each time
  try {
    const info = await wav.loadAudio(blob, DECODE_OPTS);
    if (state.audioMeta) state.audioMeta.duration = info.duration;
  } catch (err) {
    console.warn("decodeAudioData failed", err);
    toast("Could not decode this audio in the browser, so waveform and slicing may not work.", "error");
  }
  scheduleSave();
}

// -------------------------------------------------------------- upload ----

function wireUpload() {
  const drop = document.getElementById("dropzone");
  const audioInput = document.getElementById("audio-input");
  const srtInput = document.getElementById("srt-input");

  const pickAudio = () => audioInput.click();
  drop.addEventListener("click", pickAudio);
  drop.addEventListener("dragover", (e) => {
    e.preventDefault();
    drop.classList.add("dragover");
  });
  drop.addEventListener("dragleave", () => drop.classList.remove("dragover"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("dragover");
    const f = e.dataTransfer.files[0];
    if (f) handleAudioFile(f);
  });
  audioInput.addEventListener("change", () => {
    if (audioInput.files[0]) handleAudioFile(audioInput.files[0]);
    audioInput.value = "";
  });
  srtInput.addEventListener("change", () => {
    if (srtInput.files[0]) importSrt(srtInput.files[0]);
    srtInput.value = "";
  });
}

async function handleAudioFile(file) {
  state = newState();
  syncSettingsPanels(); // new project: reset the settings panels to it, not the old one's
  state.audioMeta = { name: file.name, type: file.type, size: file.size, duration: 0 };
  await setWorkingAudio(file);
  await saveNow();
  toast(`Loaded ${file.name}`, "success");
  showScreen("setup");
}

// Adds a roster entry at the exact id an imported file's per-cue metadata line
// names (the OLD file layout, before the config block carried the whole roster -
// see srt.js's META_LINE_RE) (unlike matching by gender/language, this keeps any &sN-start/
// &sN-end tokens already baked into the imported rsml text pointing at the
// right speaker - see srt.js's header comment). A roster entry already at
// that id (this project's own, or an earlier cue in the same import) wins -
// this never overwrites it.
function upsertSpeaker(sp) {
  if (!state.speakers.some((s) => s.id === sp.id)) {
    state.speakers.push({ id: sp.id, gender: sp.gender, language: sp.language });
    return true;
  }
  return false;
}

// Applies the settings + tag set an RSML file's config block carries (see
// srt.js / configText.js, which has already validated it) to the current
// project: default code-mixing language, speaker roster, and every tag set the
// file lists. Whatever the file states REPLACES the project's value outright -
// the file is saying "this is the setting", and a merge would keep things it
// never had or ignore a change you made to it. That goes for a tag set (one the
// file doesn't mention is left alone) and for the roster: a file that lists
// speakers replaces the project's whole roster. (The cues it brings in refer to
// those speakers by id; keeping the project's own speaker 1 - maybe another
// gender or language - would silently re-attribute them.) A file with no roster
// block - a plain SRT, or the old layout with per-cue `speakers=` fields - leaves
// the roster alone, and any speakers it names are added by id (upsertSpeaker()).
//
// The tag set goes through syncSettingsPanels() -> rsmlSettings.js's
// getConfigAnnotator(), which loads it via rsml's own add() - and add()
// throws on a conflicting name (e.g. one tag registered under two
// categories, only possible in a hand-edited file). Left unhandled that would
// leave a rejected tag set saved in state, throwing again on every boot, so
// on failure every setting touched here is put back - all or nothing, never
// half of the file's config applied under an error saying it wasn't. Returns
// whether the file's settings were applied.
function applyImportedConfig(config) {
  const prev = {
    rsmlConfig: state.rsmlConfig,
    accents: state.accents,
    defaultCodeMixLanguage: state.defaultCodeMixLanguage,
    speakers: state.speakers.slice(),
  };
  if (config.defaultCodeMixLanguage !== undefined) state.defaultCodeMixLanguage = config.defaultCodeMixLanguage;
  if (config.speakers) state.speakers = config.speakers.map((sp) => ({ id: sp.id, gender: sp.gender, language: sp.language }));

  const sets = config.tagSets || {};
  if (sets.accents) state.accents = { ...sets.accents.legend };
  const rsmlKeys = Object.keys(sets).filter((key) => key !== "accents");
  if (rsmlKeys.length) {
    const next = { ...(state.rsmlConfig || {}) };
    for (const key of rsmlKeys) next[key] = sets[key].tags ? sets[key].tags.slice() : { ...sets[key].legend };
    state.rsmlConfig = next;
  }

  try {
    syncSettingsPanels();
    return true;
  } catch (err) {
    console.warn("imported config rejected by rsml", err);
    Object.assign(state, prev);
    syncSettingsPanels();
    toast(`The settings and tag set in that file couldn't be applied (${err.message}); kept this project's own.`, "error");
    return false;
  }
}

// Transcript import (an RSML or SRT file - one reader handles both, see
// srt.js) happens AFTER audio, from the setup screen. It keeps the audio
// already loaded, fills the segments from the cues, and jumps to the editor.
// An RSML file ends with a config block; its settings and tag set are applied
// too (see applyImportedConfig() above). A plain SRT has neither that nor
// per-cue metadata.
export async function importSrt(srtFile) {
  const text = await srtFile.text();
  const { cues, config } = parseSRT(text);
  if (!cues.length) {
    toast("No cues found in that file.", "error");
    return;
  }
  // Before the segments are built: the roster the file carries has to exist
  // by the time defaultSpeakerId() looks for speaker 1 just below.
  const configApplied = config ? applyImportedConfig(config) : false;
  const defaultSpeaker = defaultSpeakerId(state);
  let rosterChanged = false;
  state.segments = cues.map((c) => {
    if (!c.meta) {
      // Plain SRT (third-party, or this app's own .srt export) - no
      // speaker/verified/flag/note to recover, same defaults as always.
      return { id: segId(), start: c.start, end: c.end, rsml: c.text, speaker: defaultSpeaker, verified: false, flagged: false, note: "" };
    }
    for (const sp of c.meta.speakers) {
      if (upsertSpeaker(sp)) rosterChanged = true;
    }
    return { id: segId(), start: c.start, end: c.end, rsml: c.text, speaker: c.meta.primary, verified: c.meta.verified, flagged: c.meta.flagged, note: c.meta.note };
  });
  if (rosterChanged) syncSettingsPanels();
  await saveNow();
  toast(`Imported ${cues.length} segments${configApplied ? " (plus settings and tag set)" : ""} from ${srtFile.name}`, "success");
  showScreen("editor");
}

// Lazy-loaded on first use so a plain SRT-import project never pays for the
// VAD/ONNX-runtime download. vad-web's bundle is a UMD build that expects a
// global `ort` to already exist (it does NOT bundle onnxruntime-web itself),
// so onnxruntime-web's own global build has to load first, in order; only
// then does bundle.min.js set the global `vad`.
let vadLoadPromise = null;
const VAD_WEB_VERSION = "0.0.31";
const ORT_VERSION = "1.22.0";
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`could not load ${src}`));
    document.head.appendChild(s);
  });
}
function loadVadLib() {
  if (window.vad) return Promise.resolve();
  if (vadLoadPromise) return vadLoadPromise;
  vadLoadPromise = (async () => {
    if (!window.ort) await loadScript(`https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/ort.min.js`);
    await loadScript(`https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@${VAD_WEB_VERSION}/dist/bundle.min.js`);
  })();
  return vadLoadPromise;
}

// "Skip" on the setup screen: runs a browser-side Silero VAD pass (via
// @ricky0123/vad-web's NonRealTimeVAD, no server involved) over the already-
// decoded audio to seed segments automatically, then opens the editor either
// way — on any failure (no network for the CDN model on first use, browser
// unsupported, etc.) it still opens the editor with zero segments so the
// user can draw them by hand (drag on the waveform, or the "+" between
// segments once there's at least one).
export async function runManualVad() {
  const btn = document.getElementById("setup-skip-btn");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Analyzing audio...";
  }
  try {
    const samples = wav.getMonoSamples();
    if (!samples) throw new Error("no audio loaded");
    await loadVadLib();
    const detector = await window.vad.NonRealTimeVAD.new({
      baseAssetPath: `https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@${VAD_WEB_VERSION}/dist/`,
      onnxWASMBasePath: `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`,
      // vad-web's default redemptionMs is 500 (merges on anything shorter
      // than a 500ms pause) - user-reported ~5 segments on a real recording
      // that should have had ~514, i.e. nearly everything got merged
      // together. Dropping to 100 (the old server-side VAD's
      // min_silence_duration_ms, the Python silero-vad package's own
      // default, which server/providers/vad.py just ran unmodified) went
      // too far the other way: user-reported 543 on that same recording,
      // visibly over-fragmented on short inter-phrase pauses even though
      // the raw count landed close to the expected ~514. 200 is a
      // reasoned middle value - splits on pauses roughly sentence-length
      // or longer while tolerating shorter inter-phrase gaps - not a
      // number verified against the user's actual file (only checked here
      // against synthesized test speech); revisit if it's still off.
      redemptionMs: 200,
    });
    const spans = [];
    for await (const { start, end } of detector.run(samples.data, samples.sampleRate)) {
      spans.push({ start: start / 1000, end: end / 1000 });
    }
    spans.sort((a, b) => a.start - b.start);
    const defaultSpeaker = defaultSpeakerId(state);
    state.segments = spans.map((sp) => ({
      id: segId(),
      start: sp.start,
      end: sp.end,
      rsml: "",
      speaker: defaultSpeaker,
      verified: false,
      flagged: false,
      note: "",
    }));
    await saveNow();
    toast(
      spans.length ? `Found ${spans.length} speech segments.` : "No speech detected - drag on the waveform to add one.",
      spans.length ? "success" : "info"
    );
  } catch (err) {
    console.warn("client-side VAD failed", err);
    toast(`Automatic segmentation failed (${err.message || err}). Opening the editor - drag on the waveform to add segments.`, "warn");
  } finally {
    showScreen("editor");
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Skip";
    }
  }
}

function wireSetupNav() {
  const back = document.getElementById("setup-back-btn");
  if (back)
    back.onclick = () => {
      if (confirm("Go back to upload? Your current work stays saved and you can restore it.")) showScreen("upload");
    };

  const drop = document.getElementById("srt-dropzone");
  const srtInput = document.getElementById("srt-input");
  if (drop && srtInput) {
    drop.addEventListener("click", () => srtInput.click());
    drop.addEventListener("dragover", (e) => {
      e.preventDefault();
      drop.classList.add("dragover");
    });
    drop.addEventListener("dragleave", () => drop.classList.remove("dragover"));
    drop.addEventListener("drop", (e) => {
      e.preventDefault();
      drop.classList.remove("dragover");
      const f = e.dataTransfer.files[0];
      if (f) importSrt(f);
    });
  }

  const skipBtn = document.getElementById("setup-skip-btn");
  if (skipBtn) skipBtn.onclick = runManualVad;
}

// ------------------------------------------------------- settings drawer ----

function wireHeader() {
  const drawer = document.getElementById("settings-drawer");
  const backdrop = document.getElementById("settings-backdrop");
  const open = () => {
    drawer.hidden = false;
    backdrop.hidden = false;
  };
  const close = () => {
    drawer.hidden = true;
    backdrop.hidden = true;
  };
  document.getElementById("open-settings").onclick = open;
  document.getElementById("close-settings").onclick = close;
  backdrop.onclick = close;
  document.getElementById("drawer-startover").onclick = () => {
    if (confirm("Delete this project (segments, audio, progress) from the browser? This cannot be undone.")) resetAll();
  };

  const insightsModal = document.getElementById("insights-modal");
  const insightsBackdrop = document.getElementById("insights-backdrop");
  const openInsights = () => {
    renderInsights(document.getElementById("insights-modal-body"), { getState, escapeHtml });
    insightsModal.hidden = false;
    insightsBackdrop.hidden = false;
  };
  const closeInsights = () => {
    insightsModal.hidden = true;
    insightsBackdrop.hidden = true;
  };
  document.getElementById("open-insights").onclick = openInsights;
  document.getElementById("close-insights").onclick = closeInsights;
  insightsBackdrop.onclick = closeInsights;

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!insightsModal.hidden) closeInsights();
    else if (!drawer.hidden) close();
  });
}

// -------------------------------------------------------- reset / boot ----

export async function resetAll() {
  await storage.clearAll();
  location.reload();
}

async function rehydrate() {
  if (LIB) return false; // library mode: the rsml file is loaded fresh each time (openFromLibrary)
  const saved = await storage.loadState();
  if (!saved) return false;
  state = Object.assign(newState(), saved);
  state.ui = Object.assign(newState().ui, saved.ui || {});
  // Re-applied on top: zoom/speed/fontSize/rsmlRenderMode/
  // rsmlHideDisfluencies are cross-project preferences now (see prefs.js),
  // so today's actual preference should win over whatever this specific
  // project's own blob happened to have saved for them last time it was
  // open - otherwise reopening an older project would look like it
  // "reverted" a font-size or switch change made anywhere else since.
  // `screen` (this project's own left-off screen, from saved.ui above) is
  // untouched - loadPrefs() never returns that key.
  Object.assign(state.ui, loadPrefs());

  for (const seg of state.segments || []) {
    if (seg.verified == null) seg.verified = false;
    if (seg.flagged == null) seg.flagged = false;
    if (seg.note == null) seg.note = "";
  }

  // Migrate: a speaker's language used to be saved as `nativeLanguage`; it is
  // `language` now (the language that speaker speaks in). Carry the saved value
  // over, or a project saved before the rename would reopen with every
  // speaker's language blank. A `language` already there wins.
  for (const sp of state.speakers || []) {
    if ("nativeLanguage" in sp) {
      if (sp.language === undefined) sp.language = sp.nativeLanguage;
      delete sp.nativeLanguage;
    }
  }

  // Migrate: state.rsmlConfig existed before this app switched to
  // rsml@3.3.0's native add()/remove(). The old code stored the "isolated
  // @-tag" categories as bare names; the library itself always stores them
  // "@"-prefixed, and a bare-named entry saved under the old shape won't
  // compare equal to anything the library's own add()/remove() produce.
  // Rather than trying to salvage it, discard it outright — the library's
  // own current defaults are strictly better than stale, wrongly-shaped
  // data (and this is a one-time migration: state.rsmlConfig is always
  // written back in the library's own normalized shape from here on).
  const ISOLATED_TAG_CATEGORIES = ["hesitations", "isolatedParalinguistics", "isolatedOther"];
  if (
    state.rsmlConfig &&
    ISOLATED_TAG_CATEGORIES.some((k) => (state.rsmlConfig[k] || []).some((tag) => !tag.startsWith("@")))
  ) {
    state.rsmlConfig = null;
  }

  if (state.audioMeta) {
    const blob = await storage.getAudio("audio");
    if (blob) {
      runtime.workingBlob = blob;
      try {
        await wav.loadAudio(blob, DECODE_OPTS);
      } catch (err) {
        console.warn("decode on rehydrate failed", err);
      }
    }
  }
  return true;
}

// Rebuilds every settings-drawer panel (RSML tags, language defaults, speaker
// roster) against whatever project is current right now. Called once at
// boot, and again any time `state` is wholesale-replaced (a new audio upload
// starts a fresh project) — without this, the RSML-tags panel's own internal
// RSMLAnnotator (see rsmlSettings.js) would keep showing/editing the
// *previous* project's vocabulary, and the other two panels would too.
//
// applyToOpenRows is fetched via a dynamic import() rather than a static
// one, purely to avoid growing editor.js's existing cyclic import list (see
// rsmlSettings.js's header comment) — editor.js is already fully loaded by
// this point via the static import above, so this just reads a property
// off its already-resolved module namespace.
function syncSettingsPanels() {
  renderRsmlSettings(document.getElementById("rsml-tags-panel"), {
    getState,
    scheduleSave,
    toast,
    escapeHtml,
    applyToOpenRows: (...args) => import("./editor.js").then((m) => m.applyRsmlChange(...args)),
  });
  renderCodeMixDefault(document.getElementById("language-defaults-panel"), {
    getState,
    scheduleSave,
    toast,
    escapeHtml,
  });
  renderSpeakerSettings(document.getElementById("speaker-roster-panel"), {
    getState,
    scheduleSave,
    toast,
    escapeHtml,
    onRosterChange: () => import("./editor.js").then((m) => m.refreshSpeakerDropdowns()),
  });
}

// Shows the BhashaCheck and RSML versions (version.js / rsmlLib.js - the same
// two an exported .rsml file records in its config): a badge beside the name,
// with both in its tooltip, and spelled out in Settings -> About, where a touch
// screen (no hover) can read them too.
function showVersions() {
  const badge = document.getElementById("app-version");
  if (badge) {
    badge.textContent = `v${BHASHACHECK_VERSION}`;
    badge.title = `BhashaCheck ${BHASHACHECK_VERSION} - RSML ${RSML_VERSION}`;
  }
  const about = document.getElementById("about-versions");
  if (about) about.textContent = `BhashaCheck v${BHASHACHECK_VERSION}, using RSML v${RSML_VERSION}.`;
}

// Open a library video, preferring its IndexedDB recovery copy when one exists.
async function openFromLibrary(id) {
  try {
    const [audio, remoteRsml] = await Promise.all([fetchAudio(id), fetchRsml(id)]);
    const localRsml = await storage.loadLibraryRsml(id);
    const rsml = localRsml?.text || remoteRsml;
    state = newState();
    syncSettingsPanels();
    state.audioMeta = { name: `${id}.wav`, type: audio.type, size: audio.size, duration: 0 };
    await setWorkingAudio(audio);
    await importSrt(new File([rsml], `${id}.rsml`, { type: "text/plain" }));
    if (localRsml?.text && localRsml.text !== remoteRsml) {
      toast("Restored the local IndexedDB copy. Use Sync now to update Hugging Face.", "info");
      const b = savedBadge();
      if (b) { b.textContent = "Local edits need sync"; b.className = "save-indicator dirty"; }
    }
  } catch (err) {
    console.warn("library load failed", err);
    // not the upload screen: anything imported there would be autosaved over this video's file
    const box = document.createElement("div");
    box.className = "alert alert-danger m-4";
    box.textContent = `Could not load ${id} from the library (${err.message || err}). Nothing was changed. Reload to try again.`;
    document.querySelector("main").replaceChildren(box);
  }
}

// Library mode header: links back to the library and to the neighbouring videos, and the video's
// title in place of the tagline. Leaving a video saves first, so the last edit is never lost to
// the 500 ms save debounce.
async function wireLibraryNav(id) {
  document.getElementById("library-nav").hidden = false;
  // "Start over" is for local projects; library clips keep their recovery copy in IndexedDB.
  document.getElementById("drawer-startover").closest("section").hidden = true;
  const syncButton = document.getElementById("sync-now");
  syncButton.hidden = false;
  syncButton.onclick = async () => {
    syncButton.disabled = true;
    syncButton.innerHTML = '<i class="bi bi-arrow-repeat"></i> Syncing…';
    await saveNow({ urgent: true });
    syncButton.disabled = false;
    syncButton.innerHTML = '<i class="bi bi-cloud-arrow-up"></i> Sync now';
  };
  const link = (elId, href) => {
    const a = document.getElementById(elId);
    if (href) a.href = href;
    else a.classList.add("disabled");
    a.onclick = async (e) => {
      e.preventDefault();
      if (a.classList.contains("disabled")) return;
      await saveNow({ urgent: true });
      location.href = a.href;
    };
  };
  const video = (v) => v && `index.html?id=${encodeURIComponent(v.id)}`;
  link("library-link", "library.html");
  try {
    const index = await fetchIndex();
    const i = index.findIndex((v) => v.id === id);
    if (i === -1) return;
    link("library-prev", video(index[i - 1]));
    link("library-next", video(index[i + 1]));
    // the source video, in a new tab (only a youtube.com / youtu.be address is ever linked)
    const yt = document.getElementById("library-youtube");
    if (/^https:\/\/(www\.)?(youtube\.com|youtu\.be)\//.test(index[i].url || "")) {
      yt.href = index[i].url;
      yt.hidden = false;
    }
    const tagline = document.querySelector(".brand .tagline");
    if (tagline) tagline.textContent = `${index[i].title} - ${index[i].channel}`;
    document.title = `${index[i].title} - BhashaCheck`;
  } catch (err) {
    console.warn("library index unavailable", err);
  }
}

async function boot() {
  showVersions();
  wireUpload();
  wireHeader();
  wireSetupNav();

  const had = await rehydrate();
  // After rehydrate, since it may have replaced `state` wholesale — render
  // against the final object, not the pre-rehydrate placeholder.
  syncSettingsPanels();
  if (LIB) {
    wireLibraryNav(LIB);
    storage.purgeLibraryRecords().catch((err) => console.warn("could not remove old browser copies", err));
    // switching tabs / closing the window can land inside the 500 ms save debounce
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden" && state.segments.length) saveNow({ urgent: true });
    });
    await openFromLibrary(LIB);
    document.documentElement.classList.remove("library-loading");
    document.documentElement.setAttribute("aria-busy", "false");
    // Periodic direct commit to main; manual Sync now and navigation can sync sooner.
    setInterval(() => { if (state.segments.length) saveNow({ urgent: true }); }, 5 * 60 * 1000);
    return;
  }
  if (had && (state.segments.length || state.audioMeta)) {
    const saved = state.ui.screen === "stages" ? "setup" : state.ui.screen; // old name, pre-rename saves
    const target = saved && saved !== "upload" ? saved : state.segments.length ? "editor" : "setup";
    await showScreen(target);
    toast("Restored your previous session.", "info");
  } else {
    await showScreen("upload");
  }
}

// DOMContentLoaded may already have fired by the time this module (deferred,
// like all type="module" scripts) actually executes — a static <script>-tag
// listener registered after the fact would then just never run. Firing
// immediately when the document is already past "loading" covers that.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
