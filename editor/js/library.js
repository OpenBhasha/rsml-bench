// Library mode. library.html opens a video as index.html?id=<video id>. Instead of an upload, that
// video's audio and RSML come from the library, and every edit is autosaved straight back into that
// video's RSML file. The library remembers the last opened video separately from its transcript.
//
// Two places the library can be:
//   - "hf"    the deployed site: the Hugging Face dataset (see hf.js, and config.js for which one)
//   - "local" library_server.py on this computer: data/<lang>/ on disk (the default on localhost)
// Add ?backend=local or ?backend=hf to the address to choose one by hand.

import * as hf from "./hf.js";
import { parseSRT } from "./srt.js";

export const libraryId = () => new URLSearchParams(location.search).get("id") || null;

const override = new URLSearchParams(location.search).get("backend");
export const isLocal = override ? override === "local" : ["localhost", "127.0.0.1"].includes(location.hostname);
const { dataset, lang, asrDraftIds } = window.RSML_BENCH;
const draftIds = new Set(asrDraftIds);
const lastActiveKey = `rsmlbench.lastActive.${dataset}.${lang}.${isLocal ? "local" : "hf"}`;

export function lastActiveId() {
  try { return localStorage.getItem(lastActiveKey); } catch { return null; }
}

export function rememberActive(id) {
  try { localStorage.setItem(lastActiveKey, id); } catch { /* storage is optional */ }
}

async function get(path) {
  const r = await fetch(`library/${path}`, { cache: "no-store" });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r;
}

const localFetchAudio = async (id) => (await get(`audio/${encodeURIComponent(id)}.wav`)).blob();
const localFetchRsml = async (id) => (await get(`rsml/${encodeURIComponent(id)}.rsml`)).text();
const localFetchIndex = async () => (await get("index.json")).json();

// Autosave: the server replaces rsml/<id>.rsml with the whole RSML text. The X-Library header is
// what lets the server tell this app from another website's request.
async function localSaveRsml(id, rsmlText) {
  const r = await fetch(`library/save/${encodeURIComponent(id)}`, {
    method: "POST",
    headers: { "X-Library": "1", "Content-Type": "text/plain; charset=utf-8" },
    body: rsmlText,
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
}

export const fetchAudio = (id) => (isLocal ? localFetchAudio(id) : hf.fetchAudio(id));
export const fetchRsml = (id) => (isLocal ? localFetchRsml(id) : hf.fetchRsml(id));

function matchingClose(text, start, open, close) {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === open) depth++;
    if (text[i] === close && --depth === 0) return i;
  }
  return -1;
}

function verbatimText(text) {
  const tags = /(?:!!?|\$\$?|#)[\w-]*\[|\[/g;
  let output = "";
  let offset = 0;
  for (let match; (match = tags.exec(text)); ) {
    const start = tags.lastIndex - 1;
    const end = matchingClose(text, start, "[", "]");
    if (end === -1 || text[end + 1] !== "(") continue;
    const normalizedEnd = matchingClose(text, end + 1, "(", ")");
    if (normalizedEnd === -1) continue;
    output += text.slice(offset, match.index) + verbatimText(text.slice(start + 1, end));
    offset = tags.lastIndex = normalizedEnd + 1;
  }
  return (output + text.slice(offset)).replace(/(?<![\p{L}\p{M}\p{N}])(?:@|&)\w[\w-]*/gu, " ");
}

function tokens(text) {
  return verbatimText(text).normalize("NFC").toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}\u200c\u200d]*/gu) || [];
}

function coveredSeconds(cues, limit) {
  const sorted = [...cues].sort((a, b) => a.start - b.start);
  let end = 0, seconds = 0;
  for (const cue of sorted) {
    const next = Math.min(cue.end, limit);
    const start = Math.max(end, cue.start);
    if (next > start) {
      seconds += next - start;
      end = next;
    }
  }
  return seconds;
}

function summarizeCues(cues, duration) {
  const stats = { segments: cues.length, transcribed: 0, verified: 0, flagged: 0, words: 0, verifiedWords: 0 };
  for (const cue of cues) {
    const words = tokens(cue.text).length;
    stats.words += words;
    stats.transcribed += Number(words > 0);
    stats.flagged += Number(Boolean(cue.meta?.flagged));
    if (cue.meta?.verified) {
      stats.verified++;
      stats.verifiedWords += words;
    }
  }
  const limit = duration > 0 ? duration : Infinity;
  return {
    ...stats,
    segmentSeconds: coveredSeconds(cues, limit),
    verifiedSeconds: coveredSeconds(cues.filter((cue) => cue.meta?.verified), limit),
  };
}

export function transcriptStats(text, duration) {
  return summarizeCues(parseSRT(text).cues, duration);
}

function compareDraft(reference, draft) {
  const words = (text) => parseSRT(text).cues.sort((a, b) => a.start - b.start).flatMap((cue) => tokens(cue.text));
  const ref = words(reference);
  // The original upload left a blank line between cue metadata and the ASR text.
  // Keep the separator when the next line is another cue number.
  const asr = words(draft.replace(/^(primary=[^\r\n]*)\r?\n[ \t]*\r?\n(?!(?:\d+[ \t]*\r?$))(?=[^\r\n])/gm, "$1\n"));
  if (!ref.length || !asr.length) return null;
  // Levenshtein distance with two rows, keeping memory linear in the draft length.
  let previous = Array.from({ length: asr.length + 1 }, (_, i) => i);
  let current = new Uint32Array(asr.length + 1);
  for (let i = 1; i <= ref.length; i++) {
    current[0] = i;
    for (let j = 1; j <= asr.length; j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1,
        previous[j - 1] + Number(ref[i - 1] !== asr[j - 1]));
    }
    [previous, current] = [current, previous];
  }
  return { errors: previous[asr.length], referenceWords: ref.length, draftWords: asr.length };
}

export async function fetchIndex({ withStats = false } = {}) {
  const videos = await (isLocal ? localFetchIndex() : hf.fetchIndex());
  if (!withStats) return videos;
  return Promise.all(videos.map(async (video) => {
    let progress = null;
    let comparison = null;
    try {
      const transcript = await fetchRsml(video.id);
      progress = transcriptStats(transcript, video.duration_s);
      if (progress.verified && progress.verified === progress.segments && draftIds.has(video.id)) {
        comparison = compareDraft(transcript, await hf.fetchAsrDraft(video.id));
      }
    } catch { /* the transcript or original draft is unavailable */ }
    return { ...video, progress, comparison };
  }));
}

// Resolves once the text is in the library. Rejects (with .status when there is one) if it is not.
export const saveRsml = (id, rsmlText, opts) => (isLocal ? localSaveRsml(id, rsmlText) : hf.saveRsml(id, rsmlText, opts));
export const hasUnsaved = () => (isLocal ? false : hf.hasUnsaved());

// Hugging Face token (the deployed site only; see hf.js)
export const getToken = hf.getToken;
export const setToken = hf.setToken;
export const whoami = hf.whoami;
