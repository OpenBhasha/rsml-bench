// Transcript file import/export: RSML, and plain SRT.
//
// RSML (.rsml, Rich Speech Markup Language) is this app's own format: an SRT
// with extras. Every cue is still index / timestamps / text, so anything that
// reads SRT still finds the transcript in it, plus two additions only this app
// reads:
//   - line 3 of every cue is a metadata line holding that segment's own facts
//     - which speaker, verified, flagged, note (see META_LINE_RE below);
//   - the file ends with a small INI-style config block - NOT a cue: no
//     index, no timestamps - carrying the project's settings and complete tag
//     set, with a code -> description legend for every coded tag (entities,
//     languages, dialects, domains, accents), so whoever opens the file can
//     decode the RSML in the cues without this app. It also lists the whole
//     speaker roster by its stable ids, so `primary=` here and any
//     &sN-start/&sN-end typed inside the text keep pointing at the right
//     speaker on re-import (see speakers.js's header comment for the ids, and
//     main.js's upsertSpeaker()). See configText.js for the block's format
//     and its parser.
//
// SRT (.srt) is the plain, standard form: index, timestamps, text, nothing
// else. The text is the raw RSML markup, as-is. It is lossy by nature - no
// speaker, flags, notes or config survive it.
//
// One parser, parseSRT(), reads both: a plain SRT is just an RSML file with
// neither extra. Files from earlier builds of this app (a metadata line that
// still carries a per-cue `speakers=` list, or the config written as one extra
// last cue) still import - see META_LINE_RE and LEGACY_CONFIG_CUE_RE.

import { configToText, splitOffConfig, textToConfig } from "./configText.js";

function pad(n, w = 2) {
  return String(Math.floor(n)).padStart(w, "0");
}

export function secondsToSrt(sec) {
  sec = Math.max(0, sec);
  const ms = Math.round((sec - Math.floor(sec)) * 1000);
  const s = Math.floor(sec) % 60;
  const m = Math.floor(sec / 60) % 60;
  const h = Math.floor(sec / 3600);
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

function srtToSeconds(str) {
  const m = str.trim().match(/(\d+):(\d+):(\d+)[,.](\d+)/);
  if (!m) return 0;
  return (
    parseInt(m[1], 10) * 3600 +
    parseInt(m[2], 10) * 60 +
    parseInt(m[3], 10) +
    parseInt(m[4].padEnd(3, "0").slice(0, 3), 10) / 1000
  );
}

// Metadata line format: fixed key order, pipe-delimited, `note=` last and
// unsplit (takes the rest of the line) so free-text notes never need to
// escape `|` - only a literal backslash and embedded newline are escaped,
// via escapeNote()/unescapeNote() below. `primary=` is this segment's own
// seg.speaker, empty when none.
//   primary=<id-or-empty>|verified=<0|1>|flagged=<0|1>|note=<escaped text>
// Older files also had a `speakers=<id:gender:lang,...>` field between
// `primary=` and `verified=` (every speaker the cue involves, written before
// the config block existed to carry the roster once). It is never written any
// more, but stays an optional field here so those files still read back.
const META_LINE_RE = /^primary=[^|]*(?:\|speakers=[^|]*)?\|verified=[01]\|flagged=[01]\|note=/;
const META_LINE_MATCH_RE = /^primary=([^|]*)(?:\|speakers=([^|]*))?\|verified=([01])\|flagged=([01])\|note=(.*)$/s;

function escapeNote(s) {
  return String(s || "").replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}
function unescapeNote(s) {
  return s.replace(/\\\\|\\n/g, (m) => (m === "\\n" ? "\n" : "\\"));
}

function decodeMetaLine(line) {
  const m = line.match(META_LINE_MATCH_RE);
  if (!m) return null;
  const [, primaryRaw, speakersRaw, verified, flagged, rawNote] = m;
  const speakers = speakersRaw // undefined (no `speakers=` field) or "" -> none; the config block carries the roster instead
    ? speakersRaw.split(",").map((entry) => {
        const [idRaw, gender, lang] = entry.split(":");
        return { id: parseInt(idRaw, 10), gender: gender || "unspecified", language: lang || null };
      })
    : [];
  return {
    primary: primaryRaw ? parseInt(primaryRaw, 10) : null,
    speakers,
    verified: verified === "1",
    flagged: flagged === "1",
    note: unescapeNote(rawNote),
  };
}

// An earlier build of this export wrote the config as one extra cue
// (`[bhashacheck-config v1]` as its first text line). Files from that build
// are still skipped on import rather than showing up as a bogus last segment;
// their config is not read back.
const LEGACY_CONFIG_CUE_RE = /^\[bhashacheck-config v\d+\]/;

// Word-level alignment is not this app's business: a separate aligner pipeline
// adds it to an .rsml file, under each cue's segment text, as indented
// triples - an indented timestamp line, an indented metrics line, an indented
// word - e.g.
//   \t00:00:14,820 --> 00:00:14,937
//   \tconfidence=1.000|...|kind=word|script=latin|flagged=0
//   \tIn
// Import reads the segment level only: a cue's text stops at the first
// indented timestamp line, and the word-level lines after it are ignored (export
// writes the segment level only, so they do not survive a round trip through
// this app). Matching an indented *timestamp* line - not just any indented
// line - keeps a segment whose own text happens to start with whitespace intact.
const WORD_LEVEL_RE = /^[ \t]+\d+:\d+:\d+[,.]\d+\s*-->/;

// -> { cues, config }. `cues` are the transcript cues; the config block at
// the end of an RSML file (see configText.js) is never one of them - it comes
// back as `config` instead (exportConfig.js's shape, only the parts the file
// actually states), or null when the file has no config block or nothing in it
// was recognizable. A cue's `meta` is null when it has no metadata line (plain
// SRT).
export function parseSRT(text) {
  // The config block is cut off first, so nothing in it (a description that
  // happens to contain "-->", say) can ever be read as part of a cue.
  const { rest, configText } = splitOffConfig(text.replace(/\r\n/g, "\n"));
  const config = configText && textToConfig(configText);
  const blocks = rest.split(/\n\s*\n/);
  const out = [];
  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.trim() !== "");
    if (!lines.length) continue;
    let i = 0;
    if (/^\d+$/.test(lines[0].trim())) i = 1; // optional index line
    const timeLine = lines[i] || "";
    if (!timeLine.includes("-->")) continue;
    const [rawStart, rawEnd] = timeLine.split("-->");
    const start = srtToSeconds(rawStart);
    const end = srtToSeconds(rawEnd);
    let bodyStart = i + 1;
    let meta = null;
    const metaLine = lines[bodyStart];
    if (metaLine && META_LINE_RE.test(metaLine)) {
      meta = decodeMetaLine(metaLine);
      bodyStart += 1;
    }
    // The segment's own text is everything up to the first word-level line (see
    // WORD_LEVEL_RE); anything from there on in the cue is dropped.
    const body = lines.slice(bodyStart);
    const wordLevelAt = body.findIndex((l) => WORD_LEVEL_RE.test(l));
    const content = (wordLevelAt === -1 ? body : body.slice(0, wordLevelAt)).join("\n").trim();
    if (LEGACY_CONFIG_CUE_RE.test(content)) continue; // see LEGACY_CONFIG_CUE_RE
    out.push({ start, end, text: content, meta });
  }
  return { cues: out, config: config || null };
}

function sortedRows(segments) {
  return [...segments].sort((a, b) => a.start - b.start);
}

// The first two lines of every cue, in both formats.
function cueHead(seg, idx) {
  return [String(idx + 1), `${secondsToSrt(seg.start)} --> ${secondsToSrt(seg.end)}`];
}

function metaLine(seg) {
  const primary = seg.speaker != null ? String(seg.speaker) : "";
  return `primary=${primary}|verified=${seg.verified ? "1" : "0"}|flagged=${seg.flagged ? "1" : "0"}|note=${escapeNote(seg.note)}`;
}

// RSML: the cues plus each one's metadata line, then the config block (see
// exportConfig.js's buildExportConfig()). The block follows the last cue - each
// cue already ends with a blank line - and is plain text, so it is not a cue.
export function buildRSML(segments, config) {
  const lines = [];
  sortedRows(segments).forEach((seg, idx) => lines.push(...cueHead(seg, idx), metaLine(seg), (seg.rsml || "").trim(), ""));
  lines.push(...configToText(config));
  return lines.join("\n").trim() + "\n";
}

// Plain, standard SRT: index, timestamps, text.
export function buildSRT(segments) {
  const lines = [];
  sortedRows(segments).forEach((seg, idx) => lines.push(...cueHead(seg, idx), (seg.rsml || "").trim(), ""));
  return lines.join("\n").trim() + "\n";
}

function download(filename, extension, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename.replace(/\.[^.]+$/, "") + extension;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// No registered media type for .rsml: it is plain UTF-8 text.
export function downloadRSML(filename, rsmlText) {
  download(filename, ".rsml", rsmlText, "text/plain;charset=utf-8");
}

export function downloadSRT(filename, srtText) {
  download(filename, ".srt", srtText, "application/x-subrip;charset=utf-8");
}
