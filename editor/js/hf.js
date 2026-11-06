// Hugging Face backend for library mode (the deployed site). The videos (data/<lang>/<id>.wav),
// their transcripts (data/<lang>/<id>.rsml) and metadata.csv live in a public dataset repo on the
// Hub. Each autosave commits the video's .rsml to that repo, so the Hub copy is the only copy.
// There is no server: the browser talks to huggingface.co directly.

const { dataset, lang } = window.RSML_BENCH;
const HUB = "https://huggingface.co";
const FILES = `${HUB}/datasets/${dataset}/resolve/main/data/${lang}`;
const API = `${HUB}/api/datasets/${dataset}`;
const TOKEN_KEY = "rsmlbench.hfToken";
const MIN_GAP_MS = 30_000;   // the Hub limits commits per repo: a burst of edits becomes one commit
const RETRY_MS = 60_000;     // wait after a "too many requests" answer, then try again
const KEEPALIVE_MAX = 60_000; // fetch(keepalive) refuses bodies over 64 KB

// ----------------------------------------------------------------- token ----
// Kept in this tab only (sessionStorage): sent to huggingface.co and nowhere else, gone when the tab closes.
export function getToken() {
  try { return sessionStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; }
}
export function setToken(token) {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch { /* a private window may refuse storage: the token then lasts for one page only */ }
}
export async function whoami(token) {
  const r = await fetch(`${HUB}/api/whoami-v2`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw httpError(`Hugging Face rejected that token (HTTP ${r.status})`, r.status);
  const d = await r.json();
  return { name: d.name, role: (d.auth && d.auth.accessToken && d.auth.accessToken.role) || "" };
}

// ------------------------------------------------------------------ read ----
const known = new Map();   // id -> the RSML text the Hub holds (as last read or committed)

// the per-cue metadata line, as library_server.py counts it
const META = /^primary=[^|]*\|verified=([01])\|flagged=([01])\|note=/gm;
export function progressOf(text) {
  const metas = [...text.matchAll(META)];
  return {
    segments: metas.length,
    verified: metas.filter((m) => m[1] === "1").length,
    flagged: metas.filter((m) => m[2] === "1").length,
  };
}

// The dataset is gated: anyone who has been approved on the Hub reads it with their token.
function authHeaders() {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}
function readError(what, r) {
  const denied = r.status === 401 || r.status === 403;
  const message = denied
    ? `${what}: access needed (the dataset is gated, so the token must belong to an approved user)`
    : `${what}: HTTP ${r.status}`;
  return httpError(message, r.status);
}

export async function fetchAudio(id) {
  const r = await fetch(`${FILES}/${encodeURIComponent(id)}.wav`, { headers: authHeaders() });
  if (!r.ok) throw readError(`${id}.wav`, r);
  return r.blob();
}

export async function fetchRsml(id) {
  const r = await fetch(`${FILES}/${encodeURIComponent(id)}.rsml`, { cache: "no-store", headers: authHeaders() });
  if (!r.ok) throw readError(`${id}.rsml`, r);
  const text = await r.text();
  known.set(id, text);
  return text;
}

export async function fetchAsrDraft(id) {
  const revision = window.RSML_BENCH.asrDraftRevision;
  const url = `${HUB}/datasets/${dataset}/resolve/${revision}/data/${lang}/${encodeURIComponent(id)}.rsml`;
  const r = await fetch(url, { headers: authHeaders() });
  if (!r.ok) throw readError(`ASR draft for ${id}`, r);
  return r.text();
}

// [{ id, title, channel, url, duration_s, speakers_detected, speaker_share_pct, ... }]
export async function fetchIndex() {
  const r = await fetch(`${FILES}/metadata.csv`, { cache: "no-store", headers: authHeaders() });
  if (!r.ok) throw readError("metadata.csv", r);
  const videos = parseCsv(await r.text()).filter((v) => v.id);
  return videos.map((v) => ({
    ...v,
    batch: +v.batch || 0,
    duration_s: +v.duration_s || 0,
    speakers_detected: +v.speakers_detected || 0,
    vad_segments: +v.vad_segments || 0,
    vad_speech_s: +v.vad_speech_s || 0,
  }));
}

// Small CSV reader: quoted fields, doubled quotes, commas and line breaks inside quotes.
function parseCsv(text) {
  text = text.replace(/^﻿/, "");
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [head, ...body] = rows.filter((r) => r.length > 1 || r[0]);
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}

// ----------------------------------------------------------------- write ----
// Saves are queued here, not sent one per keystroke. One commit runs at a time, always with the
// newest text, and commits are at least MIN_GAP_MS apart (an urgent save, such as leaving the
// video, skips the wait). Callers share the queue's promise, so each one learns whether its text
// reached the Hub.
let pending = null;     // the newest text waiting to be committed: { id, text, urgent }
let running = null;     // the queue loop, while it runs
let lastCommitAt = 0;
let wakeUp = null;      // ends the wait between commits early, for an urgent save

export const hasUnsaved = () => pending !== null || running !== null;

export function saveRsml(id, text, { urgent = false } = {}) {
  pending = { id, text, urgent };
  if (urgent && wakeUp) wakeUp();
  // start the loop after this call returns: if it finished at once, its finally would clear `running`
  // before it was set, and every later save would be dropped
  if (!running) running = Promise.resolve().then(drain);
  return running;
}

async function drain() {
  try {
    while (pending) {
      const wait = lastCommitAt + MIN_GAP_MS - Date.now();
      if (wait > 0 && !pending.urgent) await nap(wait);
      if (!pending) break;
      const job = pending;
      pending = null;
      if (known.get(job.id) !== job.text) await commitWithRetry(job);
    }
  } finally {
    running = null;
  }
}

function nap(ms) {
  return new Promise((done) => {
    wakeUp = done;
    setTimeout(done, ms);
  });
}

async function commitWithRetry(job) {
  for (let attempt = 1; ; attempt++) {
    try {
      await commit(job);
      lastCommitAt = Date.now();
      return;
    } catch (err) {
      if (err.status !== 429 || attempt >= 4) throw err;
      await nap(RETRY_MS);
    }
  }
}

function commitBody(job) {
  const { segments, verified } = progressOf(job.text);
  const lines = [
    { key: "header", value: { summary: `${job.id}: ${segments} segments, ${verified} verified`, description: "Autosaved from RSML Bench." } },
    { key: "file", value: { path: `data/${lang}/${job.id}.rsml`, encoding: "base64", content: toBase64(new TextEncoder().encode(job.text)) } },
  ];
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

async function commit(job, { keepalive = false } = {}) {
  const token = getToken();
  if (!token) throw httpError("Not signed in to Hugging Face. Add a token on the library page.", 401);
  const body = commitBody(job);
  const r = await fetch(`${API}/commit/main`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-ndjson" },
    body,
    keepalive: keepalive && body.length < KEEPALIVE_MAX,
  });
  if (!r.ok) {
    const detail = (await r.text().catch(() => "")).slice(0, 200);
    throw httpError(`Hugging Face did not save ${job.id} (HTTP ${r.status}${detail ? `: ${detail}` : ""})`, r.status);
  }
  known.set(job.id, job.text);
}

function toBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function httpError(message, status) {
  return Object.assign(new Error(message), { status });
}

// Leaving the page: send a waiting save now (keepalive lets the request outlive the page), and
// warn while a save is still waiting, so closing the tab does not silently drop it.
addEventListener("pagehide", () => {
  if (!pending || !getToken()) return;
  const job = pending;
  pending = null;
  commit(job, { keepalive: true }).catch((err) => console.warn("could not save on exit", err));
});
addEventListener("beforeunload", (e) => {
  if (hasUnsaved()) {
    e.preventDefault();
    e.returnValue = "";
  }
});
