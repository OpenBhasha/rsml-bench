// Library mode. library.html opens a video as index.html?id=<video id>. Instead of an upload, that
// video's audio and RSML come from the library, and every edit is autosaved straight back into that
// video's RSML file. The browser stores nothing for a library video (no IndexedDB): the file is the
// only copy.
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

export function transcriptStats(text) {
  const { cues } = parseSRT(text);
  const stats = { segments: cues.length, transcribed: 0, verified: 0, flagged: 0, words: 0, verifiedWords: 0 };
  for (const cue of cues) {
    // Keep the spoken span, dropping normalized forms and standalone RSML markers.
    const spoken = cue.text
      .replace(/(?:!!?|\$\$?|#)[\w-]*(?=\[)/g, "")
      .replace(/\[([^\]]*)\](?:\([^)]*\))?/g, "$1")
      .replace(/(^|\s)(?:@|&)\w[\w-]*/g, "$1");
    const words = spoken.split(/\s+/u).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
    stats.words += words;
    stats.transcribed += Number(words > 0);
    stats.flagged += Number(Boolean(cue.meta?.flagged));
    if (cue.meta?.verified) {
      stats.verified++;
      stats.verifiedWords += words;
    }
  }
  return stats;
}

export async function fetchIndex({ withStats = false } = {}) {
  const videos = await (isLocal ? localFetchIndex() : hf.fetchIndex());
  if (!withStats) return videos;
  return Promise.all(videos.map(async (video) => {
    let progress = null;
    try { progress = transcriptStats(await fetchRsml(video.id)); } catch { /* transcript unavailable */ }
    return { ...video, progress };
  }));
}

// Resolves once the text is in the library. Rejects (with .status when there is one) if it is not.
export const saveRsml = (id, rsmlText, opts) => (isLocal ? localSaveRsml(id, rsmlText) : hf.saveRsml(id, rsmlText, opts));
export const hasUnsaved = () => (isLocal ? false : hf.hasUnsaved());

// Hugging Face token (the deployed site only; see hf.js)
export const getToken = hf.getToken;
export const setToken = hf.setToken;
export const whoami = hf.whoami;
