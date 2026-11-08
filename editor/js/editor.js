// The editor screen: segment rows (each transcript field bound to a plain
// textarea + RSML live preview), an editable waveform with a free-moving
// playhead, per-segment playback, a per-segment "verified" flag, playback
// follow (auto-scroll + highlight), and RSML/SRT export.
//
// Large projects (hundreds of segments) stay responsive because the RSML
// preview binding is created only for rows near the viewport
// (IntersectionObserver + a backstop sweep) and torn down once they scroll
// far away. A collapsed row is just a bit of text.

import RSMLAnnotator from "./rsmlLib.js";
import {
  getState,
  runtime,
  segId,
  showScreen,
  scheduleSave,
  toast,
  escapeHtml,
} from "./main.js";
import { speakerColor, applySpeakerColor } from "./speakerColors.js";
import * as wav from "./wav.js";
import * as wf from "./waveform.js";
import { buildRSML, buildSRT, downloadRSML, downloadSRT } from "./srt.js";
import { buildExportConfig } from "./exportConfig.js";
import { speakerLabel, openSpeakerModal, defaultSpeakerId } from "./speakers.js";
import { watchMath, clearMath } from "./math.js";

const ACTIVATE_MARGIN = "600px"; // IntersectionObserver rootMargin
const ACTIVATE_DIST = 500; // px from the scroll viewport within which the sweep also activates
const KEEP_DIST = 1500; // px from the scroll viewport before a row is torn down
const MAX_ACTIVE = 24; // hard cap on live RSML preview bindings
const PLACEHOLDER = "(no transcript yet - click to edit)";

let mounted = false;
let rows = new Map(); // segId -> Row
let io = null;
let sweepTimer = null;
let keyHandler = null;
let activeId = null; // the one highlighted "active" segment (click / region / playback)
let lastAutoScroll = 0;

// Row = { seg, el, host, output, plainEl, textarea, annotator, active, els }

// --------------------------------------------------------------- mount ----

export async function mountEditor() {
  if (mounted) return;
  mounted = true;
  const s = getState();

  flaggedOnly = false;
  document.getElementById("seg-list").classList.remove("flagged-only");
  document.getElementById("editor-empty").hidden = s.segments.length > 0;
  wireChrome();
  wireWaveformControls();

  const list = document.getElementById("seg-list");
  list.innerHTML = "";
  rows.clear();
  list.appendChild(buildLeadingGap());
  s.segments.sort((a, b) => a.start - b.start);
  for (const seg of s.segments) {
    const rowEl = buildRow(seg);
    list.appendChild(rowEl);
    list.appendChild(rows.get(seg.id).gapEl);
  }
  reindex();
  updateVerifyCount();
  refreshIssueCount();

  io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) if (e.isIntersecting) activate(e.target.dataset.id, { focus: false });
    },
    { root: list, rootMargin: ACTIVATE_MARGIN }
  );
  for (const { el } of rows.values()) io.observe(el);

  await initWaveform();

  clearInterval(sweepTimer);
  sweepTimer = setInterval(sweep, 1200);

  keyHandler = handleShortcut;
  // Capture phase: a segment's CodeMirror instance has its own keymap and
  // sits between window and the event source, so a bubble-phase listener
  // could have combos like Tab silently eaten by CM6 before they reach us.
  // Capturing means we always see the keydown first and decide whether to
  // preventDefault() it ourselves, regardless of what currently has focus.
  window.addEventListener("keydown", keyHandler, true);
}

export function unmountEditor() {
  if (!mounted) return;
  mounted = false;
  clearInterval(sweepTimer);
  clearTimeout(issueTimer);
  issueHits = { errors: [], warnings: [] };
  flaggedOnly = false;
  if (keyHandler) window.removeEventListener("keydown", keyHandler, true);
  keyHandler = null;
  if (io) io.disconnect();
  io = null;
  activeId = null;
  for (const row of rows.values()) {
    syncOne(row);
    try {
      row.annotator && row.annotator.destroy && row.annotator.destroy();
    } catch {}
  }
  rows.clear();
  wf.destroy();
}

// --------------------------------------------------------- waveform ----

async function initWaveform() {
  const panel = document.getElementById("waveform-panel");
  const note = document.getElementById("waveform-note");
  if (!runtime.workingBlob || !wav.hasAudio()) {
    panel.hidden = true;
    note.hidden = false;
    return;
  }
  panel.hidden = false;
  note.hidden = true;
  try {
    await wf.initWaveform(document.getElementById("waveform"), runtime.workingBlob, {
      onRegionUpdate: (id, start, end) => {
        const seg = getState().segments.find((x) => x.id === id);
        if (!seg) return;
        seg.start = Math.max(0, start);
        seg.end = Math.max(seg.start + 0.02, end);
        refreshRowTimes(seg);
        scheduleSave();
      },
      onRegionClick: (id) => selectRow(id, false),
      onRegionCreate: (start, end) => addSegment(start, end),
      onTime: onPlayhead,
      onView: () => {
        updateScrubHead();
        updateScrubMarks();
      },
      onPlayState: (playing) => {
        const b = document.getElementById("wf-play");
        if (b) b.innerHTML = playing ? '<i class="bi bi-pause-fill"></i>' : '<i class="bi bi-play-fill"></i>';
        if (!playing) resetAllPlayButtons();
      },
      onSegmentEnd: (id) => setPlayButton(id, false),
      regionLabel,
    });
    wf.setZoom(getState().ui.zoom || 40);
    wf.setSpeed(getState().ui.speed || 1);
    wf.setRegions(getState().segments);
    updateClock(0);
    updateScrubHead(0);
    updateScrubMarks();
  } catch (err) {
    console.warn("waveform init failed", err);
    panel.hidden = true;
    note.hidden = false;
    note.textContent = "Waveform failed to load (needs internet for the WaveSurfer library on first run).";
  }
}

function onPlayhead(t) {
  updateClock(t);
  updateScrubHead(t);
  followPlayback(t);
}

// "current / total": the playhead position and the length of the whole audio.
// Both switch to h:mm:ss together once the audio is an hour or longer, so the
// two halves always line up.
function updateClock(t) {
  const clock = document.getElementById("wf-clock");
  if (!clock) return;
  const total = wf.isReady() ? wf.getDuration() : 0;
  const hours = total >= 3600;
  clock.textContent = total > 0 ? `${fmtClock(t, hours)} / ${fmtClock(total, hours)}` : fmtClock(t);
}

// Position the scrub-strip handle to match the WaveSurfer cursor. The strip
// spans the *visible* time window, so this holds at any zoom / scroll offset;
// the handle hides when the cursor is scrolled out of view.
function updateScrubHead(t) {
  const head = document.getElementById("wf-scrub-head");
  if (!head) return;
  const { start, end } = wf.getView();
  const span = end - start;
  if (span <= 0) {
    head.hidden = true;
    return;
  }
  const cur = t == null ? wf.getCurrentTime() : t;
  const f = (cur - start) / span;
  if (f < -0.001 || f > 1.001) {
    head.hidden = true;
    return;
  }
  head.hidden = false;
  head.style.left = `${Math.min(100, Math.max(0, f * 100))}%`;
}

// Speaker-colored overview bands, with status shown along their top edge.
function updateScrubMarks() {
  const scrub = document.getElementById("wf-scrub");
  if (!scrub || !wf.isReady()) return;
  let marks = scrub.querySelector(".wf-scrub-marks");
  if (!marks) {
    marks = document.createElement("div");
    marks.className = "wf-scrub-marks";
    scrub.prepend(marks); // behind #wf-scrub-head, which comes after it in the DOM
  }
  const { start, end } = wf.getView();
  const span = end - start;
  if (span <= 0) {
    marks.replaceChildren();
    return;
  }
  const html = getState()
    .segments
    .map((s) => {
      const l = Math.max(0, Math.min(1, (s.start - start) / span));
      const r = Math.max(0, Math.min(1, (s.end - start) / span));
      if (r <= l) return "";
      const cls = s.flagged ? "wf-scrub-mark wf-scrub-mark-flagged" : "wf-scrub-mark";
      return `<div class="${cls}" style="left:${(l * 100).toFixed(3)}%;width:${((r - l) * 100).toFixed(3)}%;background:${speakerColor(s.speaker, 0.35)};${s.flagged ? "border-top:2px solid var(--warn)" : s.verified ? "border-top:2px solid var(--ok)" : ""}"></div>`;
    })
    .join("");
  marks.innerHTML = html;
}

// The single "active segment" highlight. Set by a click anywhere in a row, a
// click on its waveform region, or playback moving into it.
function setActive(id, { scroll = false, seek = false } = {}) {
  if (!rows.has(id)) return;
  if (id !== activeId) {
    activeId = id;
    for (const [rid, r] of rows) r.el.classList.toggle("is-active", rid === id);
    if (wf.isReady()) wf.highlightRegion(id);
    wf.isReady() && wf.setLoop(document.getElementById("wf-loop")?.classList.contains("active") ? id : null);
  }
  const rec = rows.get(id);
  if (seek && wf.isReady()) {
    const seg = getState().segments.find((x) => x.id === id);
    if (seg) wf.seekTo(seg.start);
  }
  if (scroll) {
    const listEl = document.getElementById("seg-list");
    const ae = document.activeElement;
    const editing = listEl.contains(ae) && (ae.tagName === "TEXTAREA" || ae.tagName === "INPUT");
    const now = performance.now();
    if (!editing && now - lastAutoScroll > 350) {
      const rb = rec.el.getBoundingClientRect();
      const lb = listEl.getBoundingClientRect();
      if (rb.top < lb.top || rb.bottom > lb.bottom) {
        rec.el.scrollIntoView({ block: "center", behavior: "smooth" });
        lastAutoScroll = now;
      }
    }
  }
}

// The label inside a segment's waveform region: its number and its primary
// speaker (seg.speaker - the same one the row's dropdown and the `primary=`
// field of an .rsml file hold), e.g. "3 · S1 · M · te". Gender and language
// are left out when the speaker has none set. The tooltip spells it all out,
// since a short region clips the label with an ellipsis.
const GENDER_INITIAL = { male: "M", female: "F", other: "O" };
function regionLabel(seg, i) {
  const n = i + 1;
  if (seg.speaker == null) return { text: `${n} · no speaker`, title: `Segment ${n}: no speaker set` };
  const sp = getState().speakers.find((x) => x.id === seg.speaker);
  if (!sp) return { text: `${n} · S${seg.speaker}?`, title: `Segment ${n}: Speaker ${seg.speaker} (removed)` };
  const text = [n, `S${sp.id}`, GENDER_INITIAL[sp.gender], sp.language].filter(Boolean).join(" · ");
  return { text, title: `Segment ${n}: ${speakerLabel(sp)}` };
}

// While audio plays, keep the segment under the playhead active and in view.
// Guarded to actual playback (wf.isPlaying()) because WaveSurfer's
// "timeupdate" fires on *any* currentTime change, not just while playing -
// including a programmatic seek like addSegment()/mergeWithNext()/
// splitAtPlayhead()'s own selectRow() call. Without this guard, a stray
// timeupdate landing after one of those would immediately hop activeId
// back to whatever segment the (unrelated, stale) playhead sits in,
// undoing the focus shift to the segment that was just added/merged/split
// and making it look like the action had targeted the playhead instead.
function followPlayback(t) {
  if (!wf.isPlaying()) return;
  const segs = getState().segments;
  const current = segs.find((s) => s.id === activeId);
  if (current && t >= current.start && t < current.end) return; // still inside the active segment — don't hop to an earlier overlapping one
  for (const seg of segs) {
    if (t >= seg.start && t < seg.end) {
      setActive(seg.id, { scroll: wf.isPlaying() });
      return;
    }
  }
  // in a gap between segments: leave the current active row as-is
}

// -------------------------------------------------------------- rows ----

// The one fixed "add a segment before the first one" control at the top of
// #seg-list (mirrors each row's own trailing .seg-gap, which inserts after
// it). It looks up the current first segment at click time rather than
// capturing one, since which segment is first can change underneath it.
function buildLeadingGap() {
  const wrap = document.createElement("div");
  wrap.className = "seg-gap";
  wrap.innerHTML = '<button class="seg-gap-btn" title="Add segment before the first one"><i class="bi bi-plus-lg"></i> Add Segment</button>';
  wrap.querySelector("button").onclick = () => {
    const first = getState().segments[0];
    if (first) {
      const span = Math.max(1, first.end - first.start);
      addSegment(Math.max(0, first.start - span), first.start);
    } else {
      const t = wf.isReady() ? wf.getCurrentTime() : 0;
      const dur = wav.getDuration() || t + 2;
      addSegment(t, Math.min(t + 2, dur));
    }
  };
  return wrap;
}

function buildRow(seg) {
  const row = document.createElement("div");
  row.className = "seg-row" + (seg.verified ? " verified" : "") + (seg.flagged ? " flagged" : "");
  row.dataset.id = seg.id;
  applySpeakerColor(row, seg.speaker);
  row.innerHTML = `
    <div class="seg-bar">
      <input type="checkbox" class="seg-check" ${seg.verified ? "checked" : ""} title="Mark this segment verified" />
      <span class="seg-idx">0</span>
      <select class="seg-speaker" title="Speaker">${speakerOptionsHtml(seg.speaker)}</select>
      <div class="time-group" data-edge="start">${timeInputs(seg.start)}</div>
      <span class="time-sep">&rarr;</span>
      <div class="time-group" data-edge="end">${timeInputs(seg.end)}</div>
      <span class="seg-dur"></span>
      <span class="flex-spacer"></span>
      <button class="btn btn-sm btn-outline-secondary seg-flag" title="Flag this segment / add a note"><i class="bi ${seg.flagged ? "bi-flag-fill" : "bi-flag"}"></i></button>
      <button class="btn btn-sm btn-outline-primary seg-play" title="Play this segment"><i class="bi bi-play-fill"></i></button>
      <button class="btn btn-sm btn-link text-danger seg-del" title="Delete segment"><i class="bi bi-trash"></i></button>
    </div>
    <div class="seg-panes">
      <div class="seg-pane seg-editor">
        <div class="pane-label">RSML Transcription</div>
        <div class="rsml-host"></div>
      </div>
      <div class="seg-pane seg-preview">
        <div class="pane-label">Preview</div>
        <div class="rsml-output"></div>
      </div>
      <div class="panes-resize" title="Drag to resize"></div>
    </div>`;

  const els = {
    check: row.querySelector(".seg-check"),
    idx: row.querySelector(".seg-idx"),
    dur: row.querySelector(".seg-dur"),
    play: row.querySelector(".seg-play"),
    flag: row.querySelector(".seg-flag"),
    speaker: row.querySelector(".seg-speaker"),
    starts: row.querySelectorAll('.time-group[data-edge="start"] input'),
    ends: row.querySelectorAll('.time-group[data-edge="end"] input'),
  };
  const host = row.querySelector(".rsml-host");
  const output = row.querySelector(".rsml-output");
  // A small "add segment after this one" / "merge with next" control
  // rendered as its own sibling in #seg-list, between this row and the
  // next, rather than buttons inline in the row's own toolbar. The merge
  // button starts enabled and gets disabled by reindex() below whenever
  // this segment turns out to be the last one (nothing to merge into).
  const gapEl = document.createElement("div");
  gapEl.className = "seg-gap";
  gapEl.innerHTML =
    '<button class="seg-gap-btn" title="Add segment after this one"><i class="bi bi-plus-lg"></i> Add Segment</button>' +
    '<button class="seg-merge-btn" title="Merge with next segment"><i class="bi bi-arrows-collapse"></i> Merge with Next</button>';
  gapEl.querySelector(".seg-gap-btn").onclick = () => {
    const span = Math.max(1, seg.end - seg.start);
    addSegment(seg.end, wav.getDuration() ? Math.min(seg.end + span, wav.getDuration()) : seg.end + span);
  };
  const mergeBtn = gapEl.querySelector(".seg-merge-btn");
  mergeBtn.onclick = () => mergeWithNext(seg.id);
  const rec = { seg, el: row, host, output, gapEl, mergeBtn, plainEl: null, textarea: null, annotator: null, active: false, els };
  rows.set(seg.id, rec);

  setCollapsed(rec); // start collapsed; IntersectionObserver upgrades it

  // One shared puller resizes both the transcription editor and the preview
  // together (a --panes-h custom property both panes read their height from),
  // instead of each pane growing independently to its own content.
  const panesEl = row.querySelector(".seg-panes");
  const resizer = row.querySelector(".panes-resize");
  const PANES_MIN_H = 96;
  const PANES_MAX_H = 800;
  let resizeStartY = 0;
  let resizeStartH = 0;
  resizer.onpointerdown = (e) => {
    e.preventDefault();
    resizeStartY = e.clientY;
    resizeStartH = host.getBoundingClientRect().height || 320;
    resizer.classList.add("dragging");
    try {
      resizer.setPointerCapture(e.pointerId);
    } catch {}
  };
  resizer.onpointermove = (e) => {
    if (!resizer.hasPointerCapture || !resizer.hasPointerCapture(e.pointerId)) return;
    const h = Math.max(PANES_MIN_H, Math.min(PANES_MAX_H, resizeStartH + (e.clientY - resizeStartY)));
    panesEl.style.setProperty("--panes-h", `${h}px`);
  };
  const endResize = (e) => {
    resizer.classList.remove("dragging");
    try {
      resizer.releasePointerCapture(e.pointerId);
    } catch {}
  };
  resizer.onpointerup = endResize;
  resizer.onpointercancel = endResize;

  els.check.onchange = () => {
    seg.verified = els.check.checked;
    row.classList.toggle("verified", seg.verified);
    updateVerifyCount();
    scheduleSave();
  };
  els.speaker.onchange = () => {
    if (els.speaker.value === "__add__") {
      // Reset the visible selection back to whatever's actually assigned
      // while the modal is open, rather than sitting on "+ Add new speaker".
      els.speaker.innerHTML = speakerOptionsHtml(seg.speaker);
      openSpeakerModal(speakerDeps(), {
        onSaved: (sp) => {
          seg.speaker = sp.id;
          refreshSpeakerDropdowns();
          scheduleSave();
          els.speaker.innerHTML = speakerOptionsHtml(seg.speaker);
          if (wf.isReady()) wf.refreshRegionLabels(getState().segments);
        },
      });
      return;
    }
    seg.speaker = parseInt(els.speaker.value, 10);
    refreshSpeakerDropdowns();
    scheduleSave();
    if (wf.isReady()) wf.refreshRegionLabels(getState().segments);
  };
  // A click anywhere in the row (bar, times, textarea, preview, buttons) marks
  // it the active segment. No scroll / no seek here, so editing is undisturbed.
  row.addEventListener("pointerdown", () => setActive(seg.id));
  // Clicking the empty part of the bar additionally jumps the playhead there.
  row.querySelector(".seg-bar").addEventListener("click", (e) => {
    if (e.target.closest("button, input, select, .time-group")) return;
    selectRow(seg.id, true);
  });
  els.play.onclick = () => {
    if (!wf.isReady()) return;
    wf.toggleSegment(seg.id, (playing) => setPlayButton(seg.id, playing));
  };
  els.flag.onclick = () => openFlagModal(seg, rec);
  row.querySelector(".seg-del").onclick = () => removeSegment(seg.id);

  const onTimeInput = (edge) => {
    const inputs = edge === "start" ? els.starts : els.ends;
    let v = readTimeInputs(inputs);
    const dur = wav.getDuration() || Infinity;
    v = Math.max(0, Math.min(v, dur));
    if (edge === "start") seg.start = Math.min(v, seg.end - 0.02);
    else seg.end = Math.max(v, seg.start + 0.02);
    refreshRowTimes(seg);
    if (wf.isReady()) wf.updateRegion(seg.id, seg.start, seg.end);
    scheduleSave();
  };
  els.starts.forEach((i) => (i.onchange = () => onTimeInput("start")));
  els.ends.forEach((i) => (i.onchange = () => onTimeInput("end")));

  updateDur(seg);
  return row;
}

function setCollapsed(rec) {
  const p = document.createElement("div");
  p.className = "rsml-plain";
  p.textContent = rec.seg.rsml || PLACEHOLDER;
  if (!rec.seg.rsml) p.classList.add("is-empty");
  p.onclick = () => activate(rec.seg.id, { focus: true });
  rec.host.innerHTML = "";
  rec.host.appendChild(p);
  rec.plainEl = p;
  clearMath(rec.output);
  rec.output.textContent = rec.seg.rsml || "";
}

function activate(id, { focus }) {
  const rec = rows.get(id);
  if (!rec) return;
  if (rec.active) {
    if (focus && rec.textarea) rec.textarea.focus();
    return;
  }
  enforceCap(id);

  const ta = document.createElement("textarea");
  ta.className = "rsml-textarea";
  ta.spellcheck = false;
  ta.value = rec.seg.rsml || "";
  rec.host.innerHTML = "";
  rec.host.appendChild(ta);
  rec.output.innerHTML = "";
  rec.plainEl = null;
  rec.textarea = ta;
  rec.active = true;
  rec.el.classList.add("cm-live");

  // Hand the textarea + output straight to the rsml library and let it do its
  // full thing (CodeMirror editor, syntax highlighting, autocomplete, inline
  // validation, live preview). If it throws, fall back to a plain textarea that
  // at least mirrors its text into the preview.
  try {
    // state.rsmlConfig is a straight snapshot of a prior RSMLAnnotator's
    // .opts (see rsmlSettings.js), so it can be spread in as-is — same
    // shape the constructor already expects.
    rec.annotator = new RSMLAnnotator({ textarea: ta, output: rec.output, ...(getState().rsmlConfig || {}) });
    patchCompletions(rec.annotator);
    patchStatusAlwaysVisible(rec.annotator);
    watchMath(rec.annotator);
    applyGlobalRsmlDisplay(rec.annotator);
  } catch (err) {
    console.warn("RSMLAnnotator failed, plain textarea fallback", err);
    rec.annotator = null;
    rec.output.textContent = ta.value;
    ta.addEventListener("input", () => {
      rec.seg.rsml = ta.value;
      rec.output.textContent = ta.value;
      scheduleSave();
      scheduleIssueCount();
    });
  }
  // Always mirror edits straight to state on input (belt and braces alongside
  // the sweep's getValue() poll).
  ta.addEventListener("input", () => {
    if (rec.seg.rsml !== ta.value) {
      rec.seg.rsml = ta.value;
      scheduleSave();
      scheduleIssueCount();
    }
  });
  if (focus) ta.focus();
}

function deactivate(id) {
  const rec = rows.get(id);
  if (!rec || !rec.active) return;
  if (rec.el.contains(document.activeElement)) return; // don't yank a focused editor
  if (syncOne(rec)) scheduleIssueCount();
  try {
    rec.annotator && rec.annotator.destroy && rec.annotator.destroy();
  } catch {}
  rec.annotator = null;
  rec.textarea = null;
  rec.active = false;
  rec.el.classList.remove("cm-live");
  setCollapsed(rec);
}

// Called from the settings drawer after an RSMLAnnotator.add()/.remove()
// on the shared config instance (see rsmlSettings.js). Replays the exact
// same call on every already-active row's own annotator — rsml@3.3.0's
// add/remove update a live instance in place (re-render + CM6 decoration
// refresh included), so this needs no rebuild and is safe even on a row
// that's currently focused/mid-edit.
export function applyRsmlChange(category, action, value, label) {
  scheduleIssueCount(); // the vocabulary changed, so what counts as an error or warning may have too
  for (const rec of rows.values()) {
    if (!rec.active || !rec.annotator) continue;
    try {
      rec.annotator[action](category, value, label);
    } catch (err) {
      console.warn(`RSMLAnnotator.${action}("${category}", ...) failed on an open row`, err);
    }
  }
}

// Called after the speaker roster changes (add/edit/remove/default), from
// either the settings drawer or a segment's own "+ Add new speaker" —
// rebuilds every row's speaker <select> options against the current roster.
export function refreshSpeakerDropdowns() {
  for (const rec of rows.values()) {
    rec.els.speaker.innerHTML = speakerOptionsHtml(rec.seg.speaker);
    applySpeakerColor(rec.el, rec.seg.speaker);
  }
  if (wf.isReady()) {
    wf.refreshRegionLabels(getState().segments);
    wf.syncRegionColors(getState().segments);
    updateScrubMarks();
  }
}

// Mirrors rsml's own trigger regex exactly (see its _cmComplete source) so
// patchCompletions() can tell which prefix a given completion result came
// from without sniffing option labels for it.
const RSML_TRIGGER_RE = /\$\$[\w-]*|!![\w-]*|[@#!$&][\w-]*/;
function triggerPrefix(ctx) {
  const m = ctx.matchBefore(RSML_TRIGGER_RE);
  if (!m) return null;
  return m.text.startsWith("$$") ? "$$" : m.text.startsWith("!!") ? "!!" : m.text[0];
}

// Mirrors rsml's own internal bracketApply exactly (see the `!`/`#`/`$`/
// `$$`/`!!` cases in its _cmComplete source): scaffold-aware apply that
// reuses an existing `[verbatim]()` right after the trigger if present (the
// shape wrap-on-selection produces), otherwise inserts the full
// `typeSegment[]()` scaffold with the caret inside the normalized slot.
function bracketApply(typeSegment) {
  return (view, completion, from, to) => {
    const doc = view.state.doc;
    const after = doc.sliceString(to, Math.min(to + 500, doc.length));
    const scaf = /^\[([^\]]*)\](\([^)]*\))?/.exec(after);
    if (scaf) {
      const verbatim = scaf[1];
      view.dispatch({
        changes: { from, to, insert: typeSegment },
        selection: { anchor: from + typeSegment.length + 1 + verbatim.length + (scaf[2] ? 2 : 0) },
        userEvent: "input.complete",
      });
    } else {
      const insert = `${typeSegment}[]()`;
      view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + typeSegment.length + 3 }, userEvent: "input.complete" });
    }
  };
}

// Shadows this row's RSMLAnnotator._cmComplete (an instance property lookup
// inside the library's own closure - `self._cmComplete(ctx)`, where `self`
// is captured once per instance, not the shared prototype - so reassigning
// it here intercepts every completion this row's editor ever requests,
// cleanly, per row, without touching the library's class or any other row)
// to layer two things the library's public options can't reach:
//
// 1. Boosts the default code-mixing language to the very top of the `!`
//    popup, ahead of even rsml's own "! (unspecified language)" entry. Its
//    "!" completion source builds `{ label: "! (unspecified language)",
//    boost: 1 }` followed by every real language with no boost at all (0),
//    and CodeMirror's autocomplete ranks strictly by boost first
//    (score = matchScore + boost, sorted descending — see
//    @codemirror/autocomplete's sortOptions()), alphabetical only breaking
//    ties — confirmed by reading that package's source directly.
// 2. Appends this project's configured accents (state.accents, edited in
//    Settings -> RSML tags -> Accents) to the `$` popup, the same way
//    dialects/domains present theirs — rsml has no accents vocabulary of
//    its own at all (see rsmlSettings.js's header comment), so without this
//    the `$` popup would only ever offer "unspecified accent".
function patchCompletions(annotator) {
  if (!annotator || annotator.__completionsPatched || typeof annotator._cmComplete !== "function") return;
  annotator.__completionsPatched = true;
  const original = annotator._cmComplete.bind(annotator);
  annotator._cmComplete = (ctx) => {
    const result = original(ctx);
    if (!result || !Array.isArray(result.options)) return result;

    if (triggerPrefix(ctx) === "$") {
      const accents = getState().accents || {};
      const extra = Object.keys(accents)
        .sort()
        .map((id) => ({ label: `$${id}`, detail: accents[id] || null, apply: bracketApply(`$${id}`) }));
      result.options = result.options.concat(extra);
    }

    const state = getState();
    const defaults = [
      ["!", state.defaultCodeMixLanguage],
      ["$$", state.defaultDialect],
      ["$", state.defaultAccent],
      ["!!", state.defaultDomain],
    ];
    for (const [prefix, code] of defaults) {
      if (!code || triggerPrefix(ctx) !== prefix) continue;
      const i = result.options.findIndex((option) => option.label === `${prefix}${code}`);
      if (i >= 0) {
        const [option] = result.options.splice(i, 1);
        result.options.unshift({ ...option, boost: 99 });
      }
    }

    return result;
  };
}

// Shadows _updateStatus the same way (see patchCompletions() above for why
// that's safe) so the error/warning status bar never fully disappears. The
// library's own _updateStatus() sets display:none and empties it outright
// whenever the current segment has zero errors/warnings — meaning on any
// segment without a mistake in it (i.e. most of the time), there is no
// status bar at all, which reads as "this feature doesn't exist" rather
// than "this segment is clean". Force it visible either way, showing a
// quiet confirmation instead of nothing.
function patchStatusAlwaysVisible(annotator) {
  if (!annotator || annotator.__statusPatched || typeof annotator._updateStatus !== "function") return;
  annotator.__statusPatched = true;
  const original = annotator._updateStatus.bind(annotator);
  annotator._updateStatus = () => {
    original();
    const el = annotator._statusEl;
    if (el && el.style.display === "none") {
      el.style.display = "";
      el.innerHTML = `<span class="rsml-status-ok">&check; 0 errors</span>`;
    }
  };
  // The constructor's own initial call (before this patch could exist yet)
  // ran unpatched, so repaint immediately rather than waiting for the first
  // edit to reveal a clean segment's bar.
  annotator._updateStatus();
}

// rsml's own per-row toolbar (the Normalized/Verbatim switch + "hide
// disfluencies" gear popup it injects into every preview pane) is hidden
// entirely via CSS (.rsml-output .rsml-toolbar in app.css) — the editor
// toolbar's own controls (wireRsmlDisplay() below) are the only way to
// change these now, applying to every segment at once via state.ui rather
// than each row's annotator defaulting/toggling independently. This just
// seeds a freshly constructed row's annotator with the current app-wide
// values, since rsml's constructor always starts at its own hardcoded
// defaults ("normalized", hide-disfluencies on) regardless.
function applyGlobalRsmlDisplay(annotator) {
  if (!annotator) return;
  const ui = getState().ui;
  annotator.renderMode = ui.rsmlRenderMode;
  annotator._displaySettings.hideDisfluencies = ui.rsmlHideDisfluencies;
  annotator._applyRenderMode(annotator.output);
  annotator._applyDisplaySettings(annotator.output);
}

// Wires the editor toolbar's Normalized/Verbatim button and "hide
// disfluencies" checkbox (next to the A-/A/A+ font-size controls) — the
// single, global replacement for rsml's own per-segment toolbar. Each
// control updates state.ui, then applies straight to every currently active
// row's annotator; applyGlobalRsmlDisplay() above covers rows activated
// later (scrolled into view after this point).
function wireRsmlDisplay() {
  const modeInput = document.getElementById("rsml-mode-toggle");
  const modeLabel = document.getElementById("rsml-mode-toggle-label");
  const hideCb = document.getElementById("rsml-hide-disfluencies-toggle");
  if (!modeInput || !hideCb) return;

  const refresh = () => {
    const ui = getState().ui;
    const normalized = ui.rsmlRenderMode === "normalized";
    modeInput.checked = normalized;
    if (modeLabel) modeLabel.textContent = normalized ? "Normalized" : "Verbatim";
    hideCb.checked = ui.rsmlHideDisfluencies;
  };
  refresh();

  // Mirrors rsml's own toggle semantics exactly (see its _createRenderToggle
  // source): checked -> normalized, unchecked -> verbatim.
  modeInput.onchange = () => {
    const ui = getState().ui;
    ui.rsmlRenderMode = modeInput.checked ? "normalized" : "verbatim";
    refresh();
    scheduleSave();
    for (const rec of rows.values()) {
      if (!rec.annotator) continue;
      rec.annotator.renderMode = ui.rsmlRenderMode;
      rec.annotator._applyRenderMode(rec.annotator.output);
    }
  };

  hideCb.onchange = () => {
    const ui = getState().ui;
    ui.rsmlHideDisfluencies = hideCb.checked;
    scheduleSave();
    for (const rec of rows.values()) {
      if (!rec.annotator) continue;
      rec.annotator._displaySettings.hideDisfluencies = ui.rsmlHideDisfluencies;
      rec.annotator._applyDisplaySettings(rec.annotator.output);
    }
  };
}

function speakerOptionsHtml(selectedId) {
  const speakers = getState().speakers;
  // A native <select> with no option explicitly marked selected silently
  // shows the first option anyway — misleading here, since that would make
  // an unset segment *look* assigned to speaker 1 without seg.speaker
  // actually holding that value. An explicit placeholder keeps the two in
  // sync; it only ever appears while nothing real has been chosen yet.
  let html = selectedId == null ? `<option value="" selected disabled>Not set</option>` : "";
  html += speakers.map((sp) => `<option value="${sp.id}"${sp.id === selectedId ? " selected" : ""}>${escapeHtml(speakerLabel(sp))}</option>`).join("");
  if (selectedId != null && !speakers.some((sp) => sp.id === selectedId)) {
    html += `<option value="${selectedId}" selected disabled>Speaker ${selectedId} (removed)</option>`;
  }
  html += `<option value="__add__">+ Add new speaker</option>`;
  return html;
}

function speakerDeps() {
  return { getState, scheduleSave, toast, escapeHtml, onRosterChange: refreshSpeakerDropdowns };
}

function enforceCap(keepId) {
  let actives = [...rows.values()].filter((r) => r.active);
  if (actives.length < MAX_ACTIVE) return;
  const list = document.getElementById("seg-list");
  const vr = list.getBoundingClientRect();
  const cands = actives
    .filter((r) => r.seg.id !== keepId && r.seg.id !== activeId && !r.el.contains(document.activeElement))
    .map((r) => ({ r, d: distFromViewport(r.el, vr) }))
    .sort((a, b) => b.d - a.d);
  while ([...rows.values()].filter((r) => r.active).length >= MAX_ACTIVE && cands.length) {
    deactivate(cands.shift().r.seg.id);
  }
}

function timeInputs(sec) {
  const { h, m, s, ms } = splitTime(sec);
  return (
    `<input type="number" min="0" max="99" value="${h}" aria-label="hours">` +
    `<span>:</span><input type="number" min="0" max="59" value="${pad2(m)}" aria-label="minutes">` +
    `<span>:</span><input type="number" min="0" max="59" value="${pad2(s)}" aria-label="seconds">` +
    `<span>.</span><input type="number" min="0" max="999" value="${pad3(ms)}" class="ms" aria-label="milliseconds">`
  );
}

function readTimeInputs(inputs) {
  const [h, m, s, ms] = [...inputs].map((i) => parseInt(i.value || "0", 10) || 0);
  return h * 3600 + m * 60 + s + ms / 1000;
}

function refreshRowTimes(seg) {
  const r = rows.get(seg.id);
  if (!r) return;
  const setGroup = (inputs, sec) => {
    const { h, m, s, ms } = splitTime(sec);
    inputs[0].value = h;
    inputs[1].value = pad2(m);
    inputs[2].value = pad2(s);
    inputs[3].value = pad3(ms);
  };
  setGroup(r.els.starts, seg.start);
  setGroup(r.els.ends, seg.end);
  updateDur(seg);
}

function updateDur(seg) {
  const r = rows.get(seg.id);
  if (r) r.els.dur.textContent = `${(seg.end - seg.start).toFixed(2)}s`;
}

function setPlayButton(id, playing) {
  const r = rows.get(id);
  if (r) r.els.play.innerHTML = playing ? '<i class="bi bi-pause-fill"></i>' : '<i class="bi bi-play-fill"></i>';
}

function resetAllPlayButtons() {
  const active = wf.playingSegment();
  for (const [id, r] of rows) {
    if (id === active) continue;
    r.els.play.innerHTML = '<i class="bi bi-play-fill"></i>';
  }
}

function reindex() {
  const s = getState();
  s.segments.forEach((seg, i) => {
    const r = rows.get(seg.id);
    if (r) {
      r.els.idx.textContent = i + 1;
      applySpeakerColor(r.el, seg.speaker);
      // Nothing to merge into once this is the last segment - recomputed
      // here (rather than once at row-build time) since which segment is
      // last can change any time the list does.
      if (r.mergeBtn) r.mergeBtn.disabled = i === s.segments.length - 1;
    }
  });
  const n = document.getElementById("seg-count-n");
  if (n) n.textContent = s.segments.length;
}

// Full "go to this segment": highlight it, mount its editor, scroll it into
// view, and optionally move the playhead to its start.
function selectRow(id, seek) {
  ensureRowVisible(id);
  activate(id, { focus: false });
  setActive(id, { scroll: true, seek });
}

// ------------------------------------------------------- shortcuts ----
//
// Everything below is keyboard-only, meant to make a full transcribe pass
// possible without touching the mouse. Every combo carries a modifier
// (Ctrl+Shift+*, Shift+Enter, Tab/Shift+Tab) and fires regardless of focus,
// including while typing in a segment's own RSML editor — that's the
// point, since that's where time is actually spent. None of them are bare
// letters, so there's no need to gate on "not currently in a text field".

// Scopes shortcuts to the editor's own UI (segment list + waveform
// controls) so they don't fire while, say, typing into the settings
// drawer's "add tag name" field — that overlay sits on top of the editor
// screen without unmounting it, so it needs its own exclusion.
function inShortcutScope(e) {
  const el = e.target;
  if (el === document.body) return true;
  return !!(el.closest && el.closest("#seg-list, #wf-controls, #wf-scrub, #waveform-panel"));
}

// Focuses a row's actual editing surface. An already-active row's CM6
// view exists and is the real interactive surface (the textarea sits
// beneath it, hidden) - focus that directly. A freshly-activated row's
// view doesn't exist yet (it mounts asynchronously), so this retries
// below rather than assuming CM6 will pick up the focus on its own once
// it's ready - it doesn't (see the retry comment inside).
function focusSegmentEditor(id, attempt = 0) {
  const rec = rows.get(id);
  if (!rec) return;
  if (rec.annotator && rec.annotator.view) {
    rec.annotator.view.focus();
    return;
  }
  if (rec.textarea) rec.textarea.focus();
  // CM6 mounts asynchronously - rec.annotator.view isn't set yet the first
  // time this runs right after activate(). Focusing the raw textarea above
  // only ever "sticks" by luck: once CM6 does finish mounting, it hides
  // that textarea (display:none) with no code anywhere - ours or the
  // library's - that transfers focus to the new view first, so the browser
  // just drops focus to <body>. Retry a few animation frames until the
  // real view shows up and grab focus there instead (measured: on this
  // page CM6 is ready within 1-2 frames, so 20 is a generous ceiling, not
  // an expected count).
  if (!(rec.annotator && rec.annotator.view) && attempt < 20) {
    requestAnimationFrame(() => focusSegmentEditor(id, attempt + 1));
  }
}

// Moves the active segment by `dir` (+1/-1) in start-time order, seeks the
// playhead there, and focuses its editor — Tab/Shift+Tab and Shift+Enter
// all route through this so "keep moving forward while transcribing" stays
// one keystroke. No active segment yet: both directions land on the first.
function stepSegment(dir) {
  // With "only flagged" on, step through the flagged segments - the ones on screen.
  const ids = getState()
    .segments.filter((s) => !flaggedOnly || s.flagged)
    .map((s) => s.id);
  if (!ids.length) return;
  const cur = activeId ? ids.indexOf(activeId) : -1;
  const idx = cur === -1 ? 0 : cur + dir;
  if (idx < 0 || idx >= ids.length) return; // at a boundary — no wraparound
  const id = ids[idx];
  activate(id, { focus: false });
  setActive(id, { scroll: true, seek: true });
  focusSegmentEditor(id);
}

function verifyActive() {
  const seg = activeId && getState().segments.find((x) => x.id === activeId);
  if (!seg || seg.verified) return;
  seg.verified = true;
  const rec = rows.get(activeId);
  if (rec) {
    rec.el.classList.add("verified");
    rec.els.check.checked = true;
  }
  updateVerifyCount();
  scheduleSave();
}

function stepSpeed(dir) {
  const sel = document.getElementById("set-speed");
  if (!sel) return;
  const i = Math.min(sel.options.length - 1, Math.max(0, sel.selectedIndex + dir));
  if (i === sel.selectedIndex) return;
  sel.selectedIndex = i;
  sel.dispatchEvent(new Event("change"));
}

function toggleShortcutsModal(forceOpen) {
  const modal = document.getElementById("shortcuts-modal");
  const backdrop = document.getElementById("shortcuts-backdrop");
  if (!modal || !backdrop) return;
  const show = forceOpen != null ? forceOpen : modal.hidden;
  modal.hidden = !show;
  backdrop.hidden = !show;
}

// Updates a row's flag icon/highlight from its current seg.flagged, and
// re-colors its waveform region + scrub-strip band the same way a verified
// toggle already does via updateVerifyCount() - called right after the flag
// modal saves, and after a merge folds in the other segment's flag.
function applyFlagVisuals(rec) {
  rec.el.classList.toggle("flagged", !!rec.seg.flagged);
  updateFlaggedCount();
  const icon = rec.els.flag.querySelector("i");
  icon.className = "bi " + (rec.seg.flagged ? "bi-flag-fill" : "bi-flag");
  if (wf.isReady()) {
    wf.syncRegionColors(getState().segments);
    updateScrubMarks();
  }
}

function openFlagModal(seg, rec) {
  const backdrop = document.getElementById("flag-modal-backdrop");
  const modal = document.getElementById("flag-modal");
  if (!backdrop || !modal) return;
  const flaggedInput = modal.querySelector("#flag-modal-flagged");
  const noteInput = modal.querySelector("#flag-modal-note");
  flaggedInput.checked = !!seg.flagged;
  noteInput.value = seg.note || "";

  const close = () => {
    modal.hidden = true;
    backdrop.hidden = true;
  };
  backdrop.onclick = close;
  modal.querySelectorAll(".flag-modal-cancel").forEach((btn) => (btn.onclick = close));
  modal.querySelector(".flag-modal-save").onclick = () => {
    seg.flagged = flaggedInput.checked;
    seg.note = noteInput.value.trim();
    scheduleSave();
    close();
    applyFlagVisuals(rec);
  };

  modal.hidden = false;
  backdrop.hidden = false;
}

function handleShortcut(e) {
  // Ctrl+/ always toggles the shortcuts modal, regardless of scope/focus
  // — it's a "how do I use this thing" escape hatch, useful even if focus
  // has ended up somewhere unexpected.
  if (e.ctrlKey && e.key === "/") {
    e.preventDefault();
    toggleShortcutsModal();
    return;
  }
  const modalOpen = !document.getElementById("shortcuts-modal")?.hidden;
  if (modalOpen) {
    if (e.key === "Escape") toggleShortcutsModal(false);
    return; // modal open: don't let segment shortcuts fire underneath it
  }
  const flagModal = document.getElementById("flag-modal");
  if (flagModal && !flagModal.hidden) {
    if (e.key === "Escape") flagModal.querySelector(".flag-modal-cancel")?.click();
    return; // flag modal open: don't let segment shortcuts fire underneath it
  }

  if (!inShortcutScope(e)) return;

  // Shifted brackets may arrive as braces; physical codes cover either form.
  const seekLeft = e.code === "BracketLeft" || e.key === "[" || e.key === "{";
  const seekRight = e.code === "BracketRight" || e.key === "]" || e.key === "}";
  const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
  const seekModifier = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (seekModifier && e.shiftKey && !e.altKey && !e.isComposing && (seekLeft || seekRight)) {
    if (!wf.isReady()) return;
    e.preventDefault();
    e.stopPropagation();
    const direction = seekLeft ? -1 : 1;
    wf.seekTo(Math.max(0, Math.min(wf.getDuration(), wf.getCurrentTime() + direction * 2)));
    return;
  }

  if (e.shiftKey && e.code === "Space" && !e.ctrlKey) {
    e.preventDefault();
    if (wf.isReady()) wf.playPause();
    return;
  }
  if (e.ctrlKey && e.shiftKey && e.code === "Space") {
    e.preventDefault();
    if (wf.isReady() && activeId) wf.toggleSegment(activeId, (playing) => setPlayButton(activeId, playing));
    return;
  }
  // Checks e.code AND both possible e.key values: some browser/OS/layout
  // combinations don't recompute the shifted character once Ctrl is also
  // held, so Ctrl+Shift+. can come through as e.code:"Period" (the normal,
  // reliable case), or with e.code missing/unreliable and e.key stuck at
  // the unshifted "." instead of ">" — exactly why this didn't fire
  // reliably before. Covering all three keeps it working either way.
  if (e.ctrlKey && e.shiftKey && (e.code === "Period" || e.key === ">" || e.key === ".")) {
    e.preventDefault();
    stepSpeed(1);
    return;
  }
  if (e.ctrlKey && e.shiftKey && (e.code === "Comma" || e.key === "<" || e.key === ",")) {
    e.preventDefault();
    stepSpeed(-1);
    return;
  }
  if (e.shiftKey && e.key === "Enter") {
    e.preventDefault();
    verifyActive();
    stepSegment(1);
    return;
  }
  if (e.key === "Tab") {
    e.preventDefault();
    stepSegment(e.shiftKey ? -1 : 1);
    return;
  }
}

// ---------------------------------------------------------- segments ----

function addSegment(start, end, speakerOverride) {
  const s = getState();
  const dur = wav.getDuration() || end || start + 2;
  const seg = {
    id: segId(),
    start: Math.max(0, Math.min(start, dur)),
    end: Math.max(start + 0.02, Math.min(end, dur)),
    rsml: "",
    speaker: speakerOverride !== undefined ? speakerOverride : defaultSpeakerId(s),
    verified: false,
    flagged: false,
    note: "",
  };
  s.segments.push(seg);
  s.segments.sort((a, b) => a.start - b.start);
  scheduleIssueCount();
  const list = document.getElementById("seg-list");
  const rowEl = buildRow(seg);
  const gapEl = rows.get(seg.id).gapEl;
  const nextSeg = s.segments[s.segments.indexOf(seg) + 1];
  if (nextSeg && rows.get(nextSeg.id)) {
    list.insertBefore(rowEl, rows.get(nextSeg.id).el);
    list.insertBefore(gapEl, rows.get(nextSeg.id).el);
  } else {
    list.appendChild(rowEl);
    list.appendChild(gapEl);
  }
  if (io) io.observe(rowEl);
  reindex();
  updateVerifyCount();
  document.getElementById("editor-empty").hidden = true;
  if (wf.isReady()) wf.setRegions(s.segments);
  scheduleSave();
  selectRow(seg.id, false);
  focusSegmentEditor(seg.id); // straight into the new segment's own text field, ready to type
}

function removeSegment(id) {
  const s = getState();
  const r = rows.get(id);
  if (r) {
    try {
      r.annotator && r.annotator.destroy && r.annotator.destroy();
    } catch {}
    if (io) io.unobserve(r.el);
    r.el.remove();
    r.gapEl.remove();
    rows.delete(id);
  }
  if (activeId === id) activeId = null;
  s.segments = s.segments.filter((x) => x.id !== id);
  scheduleIssueCount();
  reindex();
  updateVerifyCount();
  document.getElementById("editor-empty").hidden = s.segments.length > 0;
  if (wf.isReady()) wf.setRegions(s.segments);
  scheduleSave();
}

// Merges a segment into the one right after it in start-time order: the
// combined span keeps this segment's id/start and the next one's end, RSML
// text concatenated with a space, this segment's speaker (falling back to
// the next one's only if this one has none), and re-opens for review
// (verified resets) since the combined text is new. Removing the *next*
// segment (rather than this one) reuses removeSegment() as-is for the
// reindex/verify-count/waveform-regions/save bookkeeping it already does,
// leaving only this row's own display to refresh below.
function mergeWithNext(id) {
  const s = getState();
  const idx = s.segments.findIndex((x) => x.id === id);
  if (idx === -1 || idx >= s.segments.length - 1) return; // already last - nothing to merge into
  const cur = s.segments[idx];
  const next = s.segments[idx + 1];

  // Pull in any live-edited text neither has synced to state yet (same
  // reason sweep()/deactivate() call this before reading rec.seg.rsml).
  const curRec = rows.get(cur.id);
  const nextRec = rows.get(next.id);
  if (curRec) syncOne(curRec);
  if (nextRec) syncOne(nextRec);

  cur.end = next.end;
  cur.rsml = [cur.rsml, next.rsml].map((t) => (t || "").trim()).filter(Boolean).join(" ");
  if (cur.speaker == null) cur.speaker = next.speaker;
  cur.verified = false;
  cur.flagged = cur.flagged || next.flagged;
  cur.note = [cur.note, next.note].map((t) => (t || "").trim()).filter(Boolean).join(" / ");

  removeSegment(next.id);

  if (curRec) {
    curRec.el.classList.remove("verified");
    curRec.els.check.checked = false;
    curRec.els.speaker.innerHTML = speakerOptionsHtml(cur.speaker);
    applyFlagVisuals(curRec);
    refreshRowTimes(cur);
    if (curRec.active) {
      // Tear down and remount to get CM6/the preview to pick up the new
      // merged text, without needing rsml's internal API surface -
      // deliberately NOT going through deactivate() here, since it calls
      // syncOne() first, which would read the *old*, still-unmerged text
      // straight out of the live CM6 doc and stomp the merge right back
      // out of cur.rsml before activate() below ever got to use it.
      try {
        curRec.annotator && curRec.annotator.destroy && curRec.annotator.destroy();
      } catch {}
      curRec.annotator = null;
      curRec.textarea = null;
      curRec.active = false;
      curRec.el.classList.remove("cm-live");
      activate(cur.id, { focus: false });
    } else {
      setCollapsed(curRec);
    }
  }
  selectRow(cur.id, false); // shift focus to the merged segment, whether or not it (or `next`) was already active
  focusSegmentEditor(cur.id); // straight into its text field, ready to type
}

// Splits whichever segment the playhead currently sits inside into two,
// right at that point: this segment keeps [start, playhead], a new one
// gets [playhead, end] with the same speaker. There's no way to know where
// mid-transcript the playhead falls, so the RSML text isn't auto-split -
// it all stays on the first half, and the new half starts blank.
function splitAtPlayhead() {
  if (!wf.isReady()) return;
  const t = wf.getCurrentTime();
  const s = getState();
  const seg = s.segments.find((x) => t > x.start + 0.02 && t < x.end - 0.02);
  if (!seg) {
    toast("Move the playhead inside a segment to split it there.", "info");
    return;
  }
  const rec = rows.get(seg.id);
  if (rec) syncOne(rec);
  const originalEnd = seg.end;
  const speaker = seg.speaker;
  seg.end = t;
  seg.verified = false;
  refreshRowTimes(seg);
  if (rec) {
    rec.el.classList.remove("verified");
    rec.els.check.checked = false;
  }
  addSegment(t, originalEnd, speaker); // reindexes, redraws waveform regions, and saves - covers seg's own shrunk end too
}

// ------------------------------------------------------------- verified ----

function updateVerifyCount() {
  updateFlaggedCount(); // also runs on mount / add / remove, the other times the flagged total can change
  const s = getState();
  const n = s.segments.filter((x) => x.verified).length;
  const cnt = document.getElementById("verify-count");
  if (cnt) cnt.textContent = `${n} / ${s.segments.length}`;
  const all = document.getElementById("verify-all");
  if (all) {
    all.checked = n > 0 && n === s.segments.length;
    all.indeterminate = n > 0 && n < s.segments.length;
  }
  if (wf.isReady()) {
    wf.syncRegionColors(s.segments);
    updateScrubMarks();
  }
}

// -------------------------------------------------------------- flagged ----
//
// The toolbar's "N flagged" is also the switch for "show only flagged
// segments". The filter itself is CSS (.seg-list.flagged-only hides every row
// without the .flagged class, see app.css), so flagging/unflagging a row
// updates the list on its own; this just owns the on/off state and the count.
// It is deliberately not saved: a reload, or opening another project, starts
// with everything showing.

let flaggedOnly = false;

// Is this segment's row hidden by the filter right now?
function hiddenByFilter(seg) {
  return flaggedOnly && !seg.flagged;
}

function updateFlaggedCount() {
  const btn = document.getElementById("flagged-btn");
  if (!btn) return;
  const n = getState().segments.filter((s) => s.flagged).length;
  btn.classList.toggle("has-flagged", n > 0);
  btn.setAttribute("aria-pressed", String(flaggedOnly));
  btn.querySelector("i").className = n > 0 || flaggedOnly ? "bi bi-flag-fill" : "bi bi-flag";
  // Same text either way: a longer "Showing N flagged" would widen the toolbar
  // enough to wrap it onto a second row at common window widths, shoving the
  // whole list down every time the filter toggles. The pressed pill (see
  // .flagged-btn in app.css) and the tooltip carry the state instead.
  document.getElementById("flagged-label").textContent = `${n} flagged`;
  btn.title = flaggedOnly
    ? "Showing only the flagged segments - click to show every segment"
    : n
      ? "Click to show only the flagged segments"
      : "No flagged segments";
  // Filtered down to nothing (the last flagged segment was just unflagged):
  // say so, rather than leave a blank list.
  document.getElementById("flagged-empty").hidden = !(flaggedOnly && n === 0);
}

function setFlaggedOnly(on, { recenter = true } = {}) {
  if (on === flaggedOnly) return;
  flaggedOnly = on;
  const list = document.getElementById("seg-list");
  list.classList.toggle("flagged-only", on);
  updateFlaggedCount();
  // The list just got much shorter or longer, so the old scroll offset means
  // nothing: start the short list at its top; on the way back, stay on the
  // segment you were working in (unless the caller is about to scroll
  // somewhere of its own - see ensureRowVisible()).
  if (on) list.scrollTop = 0;
  else if (recenter && activeId && rows.get(activeId)) rows.get(activeId).el.scrollIntoView({ block: "center" });
}

function toggleFlaggedOnly() {
  if (!flaggedOnly && !getState().segments.some((s) => s.flagged)) {
    toast("No flagged segments.", "info");
    return;
  }
  setFlaggedOnly(!flaggedOnly);
}

// Going to a segment on purpose (clicking its region, adding or merging one,
// "Jump to latest", the error/warning buttons) while the filter hides it would
// land on nothing you can see - so show everything first. Playback moving
// through segments deliberately doesn't do this.
function ensureRowVisible(id) {
  const seg = getState().segments.find((x) => x.id === id);
  if (seg && hiddenByFilter(seg)) setFlaggedOnly(false, { recenter: false }); // the caller scrolls to its own target
}

// ---------------------------------------------------------- rsml issues ----
//
// The toolbar's "N RSML errors" and "N RSML warnings": totals across EVERY
// segment, not just the rows that happen to have a live editor mounted (most
// don't - see sweep()). Counted with rsml's own validator, _findIssues(text),
// run over each segment's saved text by a throwaway hidden annotator built
// from the same tag vocabulary the rows use (so a tag that is valid here isn't
// miscounted). It returns both kinds in one pass, the same two a row's own
// status bar shows as "✕ N errors" and "⚠ N warnings":
//   errors   - structural: unpaired -start/-end, unclosed brackets, stray chars
//   warnings - semantic: unknown entity type, language code or @tag
// _findIssues is private to the library, so if a future version drops it the
// buttons hide themselves rather than lying.

// One entry per segment that has any: { id, count, first: { start, end, message } },
// in segment order. `null` when the validator isn't available.
let issueHits = { errors: [], warnings: [] };
let issueTimer = null;

const ISSUE_KINDS = {
  errors: {
    btn: "rsml-errors-btn",
    label: "rsml-errors-label",
    noun: "RSML error",
    single: "error",
    cls: "has-errors",
    iconOn: "bi bi-x-octagon-fill",
    iconOff: "bi bi-check-circle-fill",
  },
  warnings: {
    btn: "rsml-warnings-btn",
    label: "rsml-warnings-label",
    noun: "RSML warning",
    single: "warning",
    cls: "has-warnings",
    iconOn: "bi bi-exclamation-triangle-fill",
    iconOff: "bi bi-exclamation-triangle",
  },
};

function collectIssues() {
  const ta = document.createElement("textarea");
  const out = document.createElement("div");
  let validator;
  try {
    validator = new RSMLAnnotator({ textarea: ta, output: out, disableCodeMirror: true, ...(getState().rsmlConfig || {}) });
  } catch (err) {
    console.warn("RSML issue count unavailable", err);
    return null;
  }
  try {
    if (typeof validator._findIssues !== "function") return null;
    const hits = { errors: [], warnings: [] };
    const earliest = (list) => list.reduce((a, b) => (b.start < a.start ? b : a));
    for (const seg of getState().segments) {
      const found = validator._findIssues(seg.rsml || "");
      for (const kind of Object.keys(hits)) {
        const list = found[kind] || [];
        if (list.length) hits[kind].push({ id: seg.id, count: list.length, first: earliest(list) });
      }
    }
    return hits;
  } finally {
    try {
      validator.destroy();
    } catch {}
  }
}

function renderIssueCount() {
  const segs = getState().segments;
  for (const [kind, k] of Object.entries(ISSUE_KINDS)) {
    const btn = document.getElementById(k.btn);
    if (!btn) continue;
    if (issueHits === null) {
      btn.hidden = true;
      continue;
    }
    const hits = issueHits[kind];
    const total = hits.reduce((n, h) => n + h.count, 0);
    btn.hidden = false;
    btn.classList.toggle(k.cls, total > 0);
    btn.querySelector("i").className = total > 0 ? k.iconOn : k.iconOff;
    document.getElementById(k.label).textContent = `${total} ${k.noun}${total === 1 ? "" : "s"}`;
    btn.title = total
      ? `Click to jump to the first ${k.single} (segment ${segs.findIndex((x) => x.id === hits[0].id) + 1}); ${hits.length} segment${hits.length === 1 ? "" : "s"} affected`
      : `No RSML ${kind} in any segment`;
  }
}

function refreshIssueCount() {
  clearTimeout(issueTimer);
  if (!mounted) return;
  issueHits = collectIssues();
  renderIssueCount();
}

// Debounced: typing fires this on every keystroke, and a recount walks every
// segment.
function scheduleIssueCount() {
  clearTimeout(issueTimer);
  issueTimer = setTimeout(refreshIssueCount, 300);
}

// Jumps to the first segment (in order) with an issue of this kind: highlights
// it, mounts its editor, moves the playhead to it, smooth-scrolls it to the
// TOP of the list, and selects the offending text. Recounts first - from the
// live editors' text, not whatever the debounce last saw - so a click never
// chases an issue that has already been fixed.
//
// It does its own scrolling (scrollRowToTop) instead of selectRow()'s, which
// only scrolls if the row is out of view and then centers it; and the editor
// is focused with preventScroll and the selection set without CM6's
// scrollIntoView, because both of those scroll every scrollable ancestor
// INSTANTLY - they cancel a smooth scroll in flight and leave the row parked
// at the nearest edge (the bottom, for a jump from above).
function goToFirstIssue(kind) {
  for (const rec of rows.values()) if (rec.active) syncOne(rec);
  refreshIssueCount();
  const hit = issueHits && issueHits[kind][0];
  if (!hit) {
    toast(`No RSML ${kind}.`, "info");
    return;
  }
  ensureRowVisible(hit.id);
  activate(hit.id, { focus: false });
  setActive(hit.id, { seek: true });
  scrollRowToTop(hit.id);
  focusIssueRange(hit.id, hit.first);
}

const SCROLL_TOP_GAP = 8; // px between the list's top edge and the row it was scrolled to

// Smooth-scrolls #seg-list so this row's top sits just under the toolbar. Rows
// can change height while the scroll runs (editors mounting as they pass), so
// a distance measured up front may be slightly off by the time it lands; once
// the scroll has stopped, correct whatever drift is left (a few times at most -
// the last rows can't reach the top at all, since there's nothing below them to
// scroll into).
//
// The correction waits for the scroll to have MOVED and then STOPPED, not just
// "not changed lately": a smooth scroll can take a second to get going when the
// page is busy (e.g. right after a filter change re-showed the whole list), and
// while it is in flight scrollTop and the row's position trail the real offset
// by a few frames - at thousands of px/second that is hundreds of px of error.
// Targets are absolute (scrollTo) rather than relative (scrollBy) for the same
// reason.
function scrollRowToTop(id) {
  const rec = rows.get(id);
  if (!rec) return;
  const list = document.getElementById("seg-list");
  const gap = () => rec.el.getBoundingClientRect().top - list.getBoundingClientRect().top - SCROLL_TOP_GAP;
  const scrollToRow = () => list.scrollTo({ top: list.scrollTop + gap(), behavior: "smooth" });
  if (Math.abs(gap()) <= 2) return;
  scrollToRow();

  let corrections = 0;
  let last = list.scrollTop;
  let moved = false;
  const started = performance.now();
  let changedAt = started; // last time scrollTop changed
  let waitingSince = started; // when we began waiting for the scroll (or a correction) to start moving
  const watch = () => {
    const now = performance.now();
    if (list.scrollTop !== last) {
      last = list.scrollTop;
      changedAt = now;
      moved = true;
    }
    if (now - started > 8000) return;
    // Never started moving: nothing more to do (a correction that can't move -
    // the target is past the end of the list - gets a short wait, the original
    // scroll a generous one).
    if (!moved && now - waitingSince > (corrections ? 400 : 3000)) return;
    if (moved && now - changedAt > 160) {
      // moved, and has now stopped: trust the measurements again
      if (Math.abs(gap()) > 2 && corrections++ < 3) {
        scrollToRow();
        moved = false;
        waitingSince = now;
      } else {
        return;
      }
    }
    requestAnimationFrame(watch);
  };
  requestAnimationFrame(watch);
}

// Puts the selection on the issue's text in the row's editor and focuses it,
// without scrolling the page (see goToFirstIssue). CM6 mounts asynchronously
// after activate(), so - like focusSegmentEditor() above - this retries across
// a few frames until the view exists.
function focusIssueRange(id, issue, attempt = 0) {
  const rec = rows.get(id);
  if (!rec) return;
  const view = rec.annotator && rec.annotator.view;
  if (view) {
    const len = view.state.doc.length;
    const from = Math.min(issue.start, len);
    view.dispatch({ selection: { anchor: from, head: Math.min(issue.end, len) } });
    view.contentDOM.focus({ preventScroll: true });
    revealInEditor(view, from);
    return;
  }
  if (!rec.annotator && rec.textarea) {
    // plain-textarea fallback (RSMLAnnotator failed to construct)
    rec.textarea.focus({ preventScroll: true });
    rec.textarea.setSelectionRange(issue.start, issue.end);
    return;
  }
  if (attempt < 20) requestAnimationFrame(() => focusIssueRange(id, issue, attempt + 1));
}

// A long segment can scroll inside its own editor. Bring `pos` into view there
// by moving only the editor's own scroller - never the page.
function revealInEditor(view, pos) {
  const at = view.coordsAtPos(pos);
  if (!at) return;
  const box = view.scrollDOM.getBoundingClientRect();
  if (at.top < box.top) view.scrollDOM.scrollTop -= box.top - at.top + 8;
  else if (at.bottom > box.bottom) view.scrollDOM.scrollTop += at.bottom - box.bottom + 8;
}

function setAllVerified(v) {
  for (const seg of getState().segments) seg.verified = v;
  for (const r of rows.values()) {
    r.els.check.checked = v;
    r.el.classList.toggle("verified", v);
  }
  updateVerifyCount();
  scheduleSave();
}

// Jumps to the segment right after the last verified one (in start-time
// order) - "resume where I left off". No segment verified yet: the first
// segment. The last segment is already verified (nothing after it): stays
// on the last segment rather than doing nothing.
function jumpToLatest() {
  const segs = getState().segments;
  if (!segs.length) return;
  let lastVerified = -1;
  segs.forEach((s, i) => {
    if (s.verified) lastVerified = i;
  });
  const idx = Math.min(lastVerified + 1, segs.length - 1);
  const id = segs[idx].id;
  ensureRowVisible(id);
  activate(id, { focus: false });
  setActive(id, { scroll: true, seek: true });
  focusSegmentEditor(id);
}

// ------------------------------------------------------------- chrome ----

function wireChrome() {
  bind("jump-latest-btn", jumpToLatest);
  bind("shortcuts-btn", () => toggleShortcutsModal());
  bind("close-shortcuts", () => toggleShortcutsModal(false));
  const shortcutsBackdrop = document.getElementById("shortcuts-backdrop");
  if (shortcutsBackdrop) shortcutsBackdrop.onclick = () => toggleShortcutsModal(false);

  const all = document.getElementById("verify-all");
  if (all) all.onchange = () => setAllVerified(all.checked);

  wireFontSize();
  wireRsmlDisplay();

  bind("flagged-btn", toggleFlaggedOnly);
  bind("rsml-errors-btn", () => goToFirstIssue("errors"));
  bind("rsml-warnings-btn", () => goToFirstIssue("warnings"));
  bind("export-rsml-btn", () => {
    const s = getState();
    if (!s.segments.length) {
      toast("Nothing to export yet.", "info");
      return;
    }
    const name = (s.audioMeta && s.audioMeta.name) || "transcript";
    downloadRSML(name, buildRSML(s.segments, buildExportConfig(s)));
  });
  bind("export-srt-btn", () => {
    const s = getState();
    if (!s.segments.length) {
      toast("Nothing to export yet.", "info");
      return;
    }
    const name = (s.audioMeta && s.audioMeta.name) || "transcript";
    downloadSRT(name, buildSRT(s.segments));
  });
}

// A-/A+ in the toolbar scale every segment's transcription/preview text at
// once via the --rsml-font-size CSS custom property (see app.css) rather
// than touching each row - .rsml-host, .rsml-output and .rsml-plain all
// read that one variable, and CM6's own .cm-content picks it up through
// ordinary inheritance (rsml sets no font-size of its own on it).
const FONT_SIZE_MIN = 12;
const FONT_SIZE_MAX = 20;
const FONT_SIZE_STEP = 1;
const FONT_SIZE_DEFAULT = 16;

function applyFontSize() {
  const size = getState().ui.fontSize || FONT_SIZE_DEFAULT;
  document.documentElement.style.setProperty("--rsml-font-size", `${size}px`);
  const dec = document.getElementById("font-size-dec");
  const inc = document.getElementById("font-size-inc");
  if (dec) dec.disabled = size <= FONT_SIZE_MIN;
  if (inc) inc.disabled = size >= FONT_SIZE_MAX;
}

function wireFontSize() {
  const step = (delta) => {
    const ui = getState().ui;
    ui.fontSize = Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, (ui.fontSize || FONT_SIZE_DEFAULT) + delta));
    applyFontSize();
    scheduleSave();
  };
  bind("font-size-dec", () => step(-FONT_SIZE_STEP));
  bind("font-size-inc", () => step(FONT_SIZE_STEP));
  bind("font-size-reset", () => {
    getState().ui.fontSize = FONT_SIZE_DEFAULT;
    applyFontSize();
    scheduleSave();
  });
  applyFontSize();
}

function wireWaveformControls() {
  bind("wf-play", () => wf.isReady() && wf.playPause());
  bind("wf-stop", () => wf.isReady() && wf.stop());
  bind("wf-split", splitAtPlayhead);

  const zoom = document.getElementById("wf-zoom");
  if (zoom) {
    zoom.value = String(getState().ui.zoom || 40);
    zoom.oninput = () => {
      getState().ui.zoom = parseInt(zoom.value, 10);
      if (wf.isReady()) wf.setZoom(getState().ui.zoom);
      updateScrubHead();
      scheduleSave();
    };
  }

  const spd = document.getElementById("set-speed");
  if (spd) {
    spd.value = String(getState().ui.speed || 1);
    spd.onchange = () => {
      getState().ui.speed = parseFloat(spd.value);
      if (wf.isReady()) wf.setSpeed(getState().ui.speed);
      scheduleSave();
    };
  }

  const loop = document.getElementById("wf-loop");
  if (loop)
    loop.onclick = () => {
      loop.classList.toggle("active");
      wf.setLoop(loop.classList.contains("active") ? activeId : null);
    };

  // Dedicated scrub strip: drag anywhere on it to move the playhead, never
  // touching segment regions. Dragging to (or past) an edge auto-pans the
  // waveform so one drag can scrub the whole clip. Uses on* properties so
  // re-mounting the editor does not stack listeners on this persistent element.
  const scrub = document.getElementById("wf-scrub");
  if (scrub) {
    let dragging = false;
    let lastX = 0;
    let edgeTimer = null;

    const fracAt = (clientX) => {
      const r = scrub.getBoundingClientRect();
      const w = scrub.clientWidth || 1; // content box, matches the handle % origin
      return (clientX - r.left - scrub.clientLeft) / w; // may be <0 or >1 past an edge
    };
    const apply = () => {
      if (wf.isReady()) wf.scrubTo(fracAt(lastX));
    };
    const stopEdge = () => {
      if (edgeTimer) clearInterval(edgeTimer);
      edgeTimer = null;
    };
    const startEdge = () => {
      stopEdge();
      edgeTimer = setInterval(() => {
        if (!dragging || !wf.isReady()) return;
        const f = fracAt(lastX);
        if (f <= 0.06) wf.scrubTo(Math.min(f - 0.06, -0.01));
        else if (f >= 0.94) wf.scrubTo(Math.max(f + 0.06, 1.01));
      }, 110);
    };

    scrub.onpointerdown = (e) => {
      dragging = true;
      lastX = e.clientX;
      try {
        scrub.setPointerCapture(e.pointerId);
      } catch {}
      apply();
      startEdge();
    };
    scrub.onpointermove = (e) => {
      if (!dragging) return;
      lastX = e.clientX;
      apply();
    };
    const end = (e) => {
      dragging = false;
      stopEdge();
      try {
        if (e && e.pointerId != null) scrub.releasePointerCapture(e.pointerId);
      } catch {}
    };
    scrub.onpointerup = end;
    scrub.onpointercancel = end;
    scrub.onlostpointercapture = end;
  }

  // Mouse wheel / trackpad over the waveform (or the scrub strip) scrolls it
  // horizontally. Only pans; the playhead stays put.
  const wheelPan = (e) => {
    if (!wf.isReady()) return;
    const raw = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (!raw) return;
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? (e.currentTarget.clientWidth || 400) : 1;
    e.preventDefault();
    wf.scrollByPixels(raw * unit * 0.5); // 0.5 = gentler than a 1:1 wheel
  };
  const wfEl = document.getElementById("waveform");
  if (wfEl) wfEl.onwheel = wheelPan;
  if (scrub) scrub.onwheel = wheelPan;
}

// --------------------------------------------------------- rsml sync ----

function syncOne(rec) {
  if (!rec.annotator || !rec.annotator.getValue) {
    // plain textarea (annotator missing) - read it directly
    if (rec.textarea && rec.textarea.value !== rec.seg.rsml) {
      rec.seg.rsml = rec.textarea.value;
      return true;
    }
    return false;
  }
  let v;
  try {
    v = rec.annotator.getValue();
  } catch {
    v = rec.textarea ? rec.textarea.value : undefined;
  }
  const seg = rec.seg;
  if (typeof v !== "string" || v === seg.rsml) return false;
  if (v === "" && seg.rsml && (rec.textarea?.value || "").trim()) return false;
  seg.rsml = v;
  return true;
}

function distFromViewport(el, vr) {
  const b = el.getBoundingClientRect();
  if (b.bottom < vr.top) return vr.top - b.bottom;
  if (b.top > vr.bottom) return b.top - vr.bottom;
  return 0;
}

// Backstop to the IntersectionObserver: pulls edits out of live bindings, tears
// down rows that scrolled far away, activates rows that came near the viewport.
function sweep() {
  if (!mounted) return;
  const list = document.getElementById("seg-list");
  const vr = list.getBoundingClientRect();
  let changed = false;

  for (const rec of rows.values()) {
    if (rec.active && syncOne(rec)) changed = true;
  }
  for (const rec of rows.values()) {
    if (!rec.active) continue;
    if (rec.seg.id === activeId) continue;
    if (rec.el.contains(document.activeElement)) continue;
    if (hiddenByFilter(rec.seg) || distFromViewport(rec.el, vr) > KEEP_DIST) deactivate(rec.seg.id);
  }
  for (const rec of rows.values()) {
    if (rec.active) continue;
    // A display:none row measures as a zero rect at the page's top-left, which
    // reads as "near the viewport" - without this check the sweep would mount
    // editors for every row the filter has hidden.
    if (hiddenByFilter(rec.seg)) continue;
    if (distFromViewport(rec.el, vr) <= ACTIVATE_DIST) activate(rec.seg.id, { focus: false });
  }
  if (changed) {
    scheduleSave();
    scheduleIssueCount();
  }
}

// --------------------------------------------------------------- utils ----

function bind(id, fn) {
  const el = document.getElementById(id);
  if (el) el.onclick = fn;
}
function pad2(n) {
  return String(n).padStart(2, "0");
}
function pad3(n) {
  return String(n).padStart(3, "0");
}
function splitTime(sec) {
  sec = Math.max(0, sec || 0);
  const ms = Math.round((sec - Math.floor(sec)) * 1000);
  let whole = Math.floor(sec);
  if (ms === 1000) whole += 1;
  return { h: Math.floor(whole / 3600), m: Math.floor(whole / 60) % 60, s: whole % 60, ms: ms % 1000 };
}
function fmtClock(t, withHours = false) {
  const { h, m, s } = splitTime(t);
  return withHours || h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${pad2(m)}:${pad2(s)}`;
}
