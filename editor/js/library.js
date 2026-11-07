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

function coveredSeconds(sorted, limit) {
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

function longestVerifiedRun(segments, limit) {
  let longest = null;
  let run = null;
  for (const segment of segments) {
    if (!segment.meta?.verified) {
      run = null;
      continue;
    }
    const start = Math.max(0, segment.start);
    const end = Math.min(limit, segment.end);
    if (end <= start) continue;
    run = { start: run?.start ?? start, end: Math.max(run?.end ?? end, end) };
    if (!longest || run.end - run.start > longest.end - longest.start) longest = run;
  }
  return longest;
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
  const segments = [...cues].sort((a, b) => a.start - b.start);
  const verified = segments.filter((segment) => segment.meta?.verified);
  let verifiedRawSeconds = 0;
  if (duration > 0 && verified.length) {
    if (verified.length === segments.length) {
      verifiedRawSeconds = duration;
    } else {
      const run = longestVerifiedRun(segments, limit);
      // Take the union so segments inside the run are counted only once.
      const intervals = run ? [...verified, run].sort((a, b) => a.start - b.start) : verified;
      verifiedRawSeconds = coveredSeconds(intervals, limit);
    }
  }
  return {
    ...stats,
    segmentSeconds: coveredSeconds(segments, limit),
    verifiedSeconds: coveredSeconds(verified, limit),
    verifiedRawSeconds,
  };
}

export function transcriptStats(text, duration) {
  return summarizeCues(parseSRT(text).cues, duration);
}

function compareDraft(reference, draft) {
  const segments = parseSRT(reference).cues.sort((a, b) => a.start - b.start);
  const referenceTokens = segments.map((segment) => tokens(segment.text));
  const ref = referenceTokens.flat();
  const words = (text) => parseSRT(text).cues.sort((a, b) => a.start - b.start).flatMap((cue) => tokens(cue.text));
  // The original upload left a blank line between cue metadata and the ASR text.
  // Keep the separator when the next line is another cue number.
  const asr = words(draft.replace(/^(primary=[^\r\n]*)\r?\n[ \t]*\r?\n(?!(?:\d+[ \t]*\r?$))(?=[^\r\n])/gm, "$1\n"));
  if (!ref.length || !asr.length) return null;
  // Retain edit directions to assign errors to the current segment boundaries.
  const width = asr.length + 1;
  const directions = new Uint8Array((ref.length + 1) * width);
  let previous = Array.from({ length: asr.length + 1 }, (_, i) => i);
  let current = new Uint32Array(asr.length + 1);
  for (let i = 1; i <= ref.length; i++) {
    current[0] = i;
    for (let j = 1; j <= asr.length; j++) {
      const diagonal = previous[j - 1] + Number(ref[i - 1] !== asr[j - 1]);
      const deletion = previous[j] + 1;
      const insertion = current[j - 1] + 1;
      current[j] = Math.min(diagonal, deletion, insertion);
      directions[i * width + j] = current[j] === diagonal ? 0 : current[j] === deletion ? 1 : 2;
    }
    [previous, current] = [current, previous];
  }
  const tokenSegments = referenceTokens.flatMap((tokens, index) => tokens.map(() => index));
  const segmentErrors = new Uint32Array(segments.length);
  let i = ref.length, j = asr.length;
  while (i || j) {
    const direction = !i ? 2 : !j ? 1 : directions[i * width + j];
    const segment = tokenSegments[Math.max(0, i - 1)];
    if (direction === 2) {
      segmentErrors[segment]++;
      j--;
    } else if (direction === 1) {
      segmentErrors[segment]++;
      i--;
    } else {
      segmentErrors[segment] += Number(ref[i - 1] !== asr[j - 1]);
      i--;
      j--;
    }
  }
  const rates = segments.flatMap((segment, index) =>
    segment.meta?.verified && referenceTokens[index].length ? [segmentErrors[index] / referenceTokens[index].length] : []);
  return {
    errors: previous[asr.length], referenceWords: ref.length, draftWords: asr.length,
    segmentWer: rates.length ? rates.reduce((sum, rate) => sum + rate, 0) / rates.length : null,
    comparedSegments: rates.length,
  };
}

export async function fetchIndex({ withStats = false } = {}) {
  const videos = await (isLocal ? localFetchIndex() : hf.fetchIndex());
  if (!withStats) return videos;
  return Promise.all(videos.map(async (video) => {
    let progress = null;
    let comparison = null;
    let segmentComparison = null;
    try {
      const transcript = await fetchRsml(video.id);
      progress = transcriptStats(transcript, video.duration_s);
      if (progress.verified && draftIds.has(video.id)) {
        segmentComparison = compareDraft(transcript, await hf.fetchAsrDraft(video.id));
        if (progress.verified === progress.segments) comparison = segmentComparison;
      }
    } catch { /* the transcript or original draft is unavailable */ }
    return { ...video, progress, comparison, segmentComparison };
  }));
}

export async function fetchActivity() {
  if (isLocal) return new Map();
  return hf.fetchActivity();
}

export function activeSeconds(commits = [], completed = false) {
  let seconds = 0;
  for (let i = 1; i < commits.length; i++) {
    if (completed && commits[i - 1].done) break;
    const gap = (commits[i].time - commits[i - 1].time) / 1000;
    if (gap > 0 && gap <= 300) seconds += gap;
  }
  return seconds || null;
}

// Resolves once the text is in the library. Rejects (with .status when there is one) if it is not.
export const saveRsml = (id, rsmlText, opts) => (isLocal ? localSaveRsml(id, rsmlText) : hf.saveRsml(id, rsmlText, opts));
export const hasUnsaved = () => (isLocal ? false : hf.hasUnsaved());

// Hugging Face token (the deployed site only; see hf.js)
export const getToken = hf.getToken;
export const setToken = hf.setToken;
export const whoami = hf.whoami;
