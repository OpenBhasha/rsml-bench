// WaveSurfer v7 + Regions: renders the working audio and keeps one region per
// segment in two-way sync with the editor. Region ids ARE segment ids.

import WaveSurfer from "https://cdn.jsdelivr.net/npm/wavesurfer.js@7/dist/wavesurfer.esm.js";
import RegionsPlugin from "https://cdn.jsdelivr.net/npm/wavesurfer.js@7/dist/plugins/regions.esm.js";
import TimelinePlugin from "https://cdn.jsdelivr.net/npm/wavesurfer.js@7/dist/plugins/timeline.esm.js";

let ws = null;
let regions = null;
let objectUrl = null;
let handlers = {};
let knownIds = new Set();
let loopId = null;
let minPxPerSec = 40;
let suppress = false; // true while we mutate regions programmatically
let segPlayId = null; // region id currently in "play just this segment" mode
// The time window currently visible in the waveform viewport (seconds). Equals
// [0, duration] when the whole clip fits; narrows when zoomed and scrolled. The
// scrub strip maps its width to THIS window so its handle lines up with the
// WaveSurfer cursor at any zoom.
let viewStart = 0;
let viewEnd = 0;

const REGION_COLOR = "rgba(91,60,196,0.12)";
const REGION_COLOR_VERIFIED = "rgba(31,157,100,0.2)";
const REGION_COLOR_FLAGGED = "rgba(178,106,0,0.2)";

// A segment that's both flagged and verified reads as flagged - same
// precedence .seg-row.flagged takes over .seg-row.verified in the editor list.
function regionColorFor(seg) {
  if (seg.flagged) return REGION_COLOR_FLAGGED;
  if (seg.verified) return REGION_COLOR_VERIFIED;
  return REGION_COLOR;
}

export function isReady() {
  return !!ws;
}

export async function initWaveform(container, blob, h = {}) {
  destroy();
  handlers = h;
  regions = RegionsPlugin.create();
  objectUrl = URL.createObjectURL(blob);

  ws = WaveSurfer.create({
    container,
    height: 100,
    waveColor: "#f2b8a2",
    progressColor: "#e2703a",
    cursorColor: "#5b3cc4",
    cursorWidth: 2,
    minPxPerSec,
    fillParent: true,
    url: objectUrl,
    // dragToSeek is left off (default false): a *click* still seeks (that's
    // core wavesurfer's separate `interact` option, on by default), but a
    // *drag* on empty waveform space is reserved for enableDragSelection
    // below, to draw a new segment. The dedicated #wf-scrub strip above the
    // waveform remains the way to drag-scrub through the clip.
    plugins: [regions, TimelinePlugin.create({ height: 18 })],
  });

  regions.on("region-updated", (region) => {
    if (suppress) return;
    handlers.onRegionUpdate && handlers.onRegionUpdate(region.id, region.start, region.end);
  });
  regions.on("region-clicked", (region, e) => {
    e.stopPropagation();
    segPlayId = null;
    if (region.start != null) ws.setTime(region.start);
    handlers.onRegionClick && handlers.onRegionClick(region.id);
  });
  regions.on("region-created", (region) => {
    if (suppress || knownIds.has(region.id)) return;
    // user drew a new region on the waveform
    const { start, end } = region;
    region.remove();
    handlers.onRegionCreate && handlers.onRegionCreate(start, end);
  });
  regions.on("region-out", (region) => {
    if (loopId && region.id === loopId) region.play();
  });

  ws.on("timeupdate", (t) => {
    handlers.onTime && handlers.onTime(t);
    if (segPlayId) {
      const r = regions.getRegions().find((x) => x.id === segPlayId);
      if (r && t >= r.end - 0.006) {
        const ended = segPlayId;
        segPlayId = null;
        ws.pause();
        ws.setTime(r.start);
        handlers.onSegmentEnd && handlers.onSegmentEnd(ended);
      }
    }
  });
  ws.on("play", () => handlers.onPlayState && handlers.onPlayState(true));
  ws.on("pause", () => handlers.onPlayState && handlers.onPlayState(false));
  ws.on("finish", () => {
    segPlayId = null;
    handlers.onPlayState && handlers.onPlayState(false);
  });

  // Keep the visible-window in sync however it changes. refreshView() reads it
  // straight from the DOM so we do not depend on any event's argument shape.
  ws.on("scroll", () => refreshView());
  ws.on("zoom", () => refreshView());
  ws.on("redraw", () => refreshView());

  await new Promise((resolve) => {
    ws.on("decode", () => resolve());
    ws.on("error", () => resolve());
  });
  refreshView();
  // Dragging on empty waveform space draws a new region; region-created
  // (wired above) turns it into a real segment via handlers.onRegionCreate.
  regions.enableDragSelection({ color: REGION_COLOR, drag: true, resize: true });
}

// The WaveSurfer scroll container (parent of the canvas wrapper). Reading
// scrollLeft / scrollWidth / clientWidth off this ONE element keeps them
// mutually consistent even mid zoom-transition, unlike mixing ws.getScroll()
// with a separately-measured wrapper width.
function scroller() {
  try {
    const wrap = ws.getWrapper();
    return wrap && wrap.parentElement ? wrap.parentElement : null;
  } catch {
    return null;
  }
}

function pxPerSec() {
  if (!ws) return 0;
  const dur = ws.getDuration() || 0;
  if (!dur) return 0;
  const sc = scroller();
  const full = (sc && sc.scrollWidth) || 0;
  return full > 0 ? full / dur : 0;
}

// Width of the visible waveform viewport, in seconds.
function visibleDur() {
  const pps = pxPerSec();
  if (!pps) return ws ? ws.getDuration() : 0;
  const sc = scroller();
  const viewW = (sc && sc.clientWidth) || 0;
  return viewW > 0 ? viewW / pps : (ws ? ws.getDuration() : 0);
}

// Recompute the visible time window from the DOM. Cheap; call it freely so a
// stale value from a zoom transition never lingers past the next read.
function computeView() {
  const dur = ws ? ws.getDuration() : 0;
  if (!ws || !dur) {
    viewStart = 0;
    viewEnd = 0;
    return;
  }
  const sc = scroller();
  const full = (sc && sc.scrollWidth) || 0;
  const viewW = (sc && sc.clientWidth) || 0;
  if (sc && full > viewW + 1 && viewW > 0) {
    const pps = full / dur;
    viewStart = Math.max(0, Math.min(sc.scrollLeft / pps, dur - viewW / pps));
    viewEnd = viewStart + viewW / pps;
  } else {
    viewStart = 0;
    viewEnd = dur;
  }
}

function refreshView() {
  computeView();
  handlers.onView && handlers.onView(viewStart, viewEnd);
}

export function getView() {
  computeView();
  return { start: viewStart, end: viewEnd };
}

// Scroll so that `leftTime` sits at the left edge of the viewport.
function scrollLeftToTime(leftTime) {
  if (!ws) return;
  const pps = pxPerSec();
  const sc = scroller();
  if (!pps || !sc) return;
  const maxPx = Math.max(0, sc.scrollWidth - sc.clientWidth);
  const px = Math.max(0, Math.min(leftTime * pps, maxPx));
  try {
    if (typeof ws.setScroll === "function") ws.setScroll(px);
    else sc.scrollLeft = px;
  } catch {
    sc.scrollLeft = px;
  }
  refreshView();
}

// If `t` is near or past a viewport edge, pan the viewport to keep it ~10% in.
function ensureVisible(t) {
  const view = visibleDur();
  if (view <= 0) return;
  const dur = ws.getDuration() || 0;
  if (view >= dur - 0.01) return; // nothing to scroll
  const margin = view * 0.1;
  if (t < viewStart + margin) scrollLeftToTime(t - margin);
  else if (t > viewEnd - margin) scrollLeftToTime(t - view + margin);
}

// Move the playhead from a scrub-strip fraction.
//  - frac in [0,1]: seek exactly to that point of the visible window.
//  - frac outside [0,1]: the pointer is past a strip edge. Nudge the playhead
//    that way by a small step (larger the further past the edge), and let
//    ensureVisible() pan the waveform. The editor re-calls this on a timer while
//    the pointer is held past an edge, so holding = continuous scrub/scroll.
export function scrubTo(frac) {
  if (!ws) return;
  segPlayId = null;
  computeView();
  const dur = ws.getDuration() || 0;
  let span = viewEnd - viewStart;
  if (span <= 0) span = dur || 1;

  if (frac >= 0 && frac <= 1) {
    const t = Math.min(dur, Math.max(0, viewStart + frac * span));
    ws.setTime(t);
    ensureVisible(t);
    return;
  }

  // Past a strip edge: pan the visible window that way and park the playhead on
  // the leading edge. The step grows the further past the edge the pointer is,
  // so holding just past the edge scrolls slowly and dragging well past it
  // scrolls fast. scrollLeftToTime() clamps at the clip ends and refreshes the
  // window, so this settles cleanly at 0 / duration.
  const base = Math.max(visibleDur() * 0.012, 0.03);
  const over = frac < 0 ? -frac : frac - 1;
  const stepAmt = base * Math.min(5, 1 + over * 8);
  if (frac < 0) {
    scrollLeftToTime(viewStart - stepAmt);
    ws.setTime(Math.max(0, viewStart));
  } else {
    scrollLeftToTime(viewStart + stepAmt);
    ws.setTime(Math.min(dur, viewEnd));
  }
}

// Horizontal scroll of the waveform by a pixel delta (mouse wheel / trackpad).
// Only pans; never moves the playhead.
export function scrollByPixels(dpx) {
  if (!ws || !dpx) return;
  const sc = scroller();
  if (!sc) return;
  const maxScroll = Math.max(0, sc.scrollWidth - sc.clientWidth);
  if (maxScroll <= 0) return; // whole clip already fits
  const next = Math.max(0, Math.min(sc.scrollLeft + dpx, maxScroll));
  try {
    if (typeof ws.setScroll === "function") ws.setScroll(next);
    else sc.scrollLeft = next;
  } catch {
    sc.scrollLeft = next;
  }
  refreshView();
}

// What a region shows: `handlers.regionLabel(seg, index)` -> { text, title },
// supplied by the editor (which knows about speakers; this module doesn't).
// `text` is the label drawn inside the region, `title` the tooltip. Without
// that handler a region just shows its segment number, as it always did.
function labelFor(seg, i) {
  const label = handlers.regionLabel ? handlers.regionLabel(seg, i) : null;
  return { text: label ? label.text : String(i + 1), title: label && label.title ? label.title : "" };
}

export function setRegions(segments) {
  if (!regions) return;
  suppress = true;
  try {
    regions.clearRegions();
    knownIds = new Set();
    segments.forEach((seg, i) => {
      knownIds.add(seg.id);
      const label = labelFor(seg, i);
      const region = regions.addRegion({
        id: seg.id,
        start: seg.start,
        end: seg.end,
        color: regionColorFor(seg),
        drag: true,
        resize: true,
        content: label.text,
      });
      if (region && region.element) region.element.title = label.title;
    });
  } finally {
    suppress = false;
  }
}

// Redraw every region's label in place (a speaker was reassigned, or a
// speaker's gender/language was edited) without rebuilding the regions, so it
// never disturbs a drag in progress - same idea as syncRegionColors() below.
export function refreshRegionLabels(segments) {
  if (!regions) return;
  suppress = true;
  try {
    const byId = new Map(segments.map((seg, i) => [seg.id, { seg, i }]));
    regions.getRegions().forEach((r) => {
      const hit = byId.get(r.id);
      if (!hit) return;
      const label = labelFor(hit.seg, hit.i);
      r.setOptions({ content: label.text });
      if (r.element) r.element.title = label.title;
    });
  } finally {
    suppress = false;
  }
}

export function updateRegion(id, start, end) {
  if (!regions) return;
  const r = regions.getRegions().find((x) => x.id === id);
  if (!r) return;
  suppress = true;
  try {
    r.setOptions({ start, end });
  } finally {
    suppress = false;
  }
}

// Re-color regions in place (flagged -> amber, verified -> green, else the
// plain color) without rebuilding them, so a checkbox/flag toggle never
// disturbs an in-progress drag.
export function syncRegionColors(segments) {
  if (!regions) return;
  suppress = true;
  try {
    const byId = new Map(segments.map((s) => [s.id, s]));
    regions.getRegions().forEach((r) => {
      const seg = byId.get(r.id);
      if (!seg) return;
      r.setOptions({ color: regionColorFor(seg) });
    });
  } finally {
    suppress = false;
  }
}

export function highlightRegion(id) {
  if (!regions) return;
  regions.getRegions().forEach((r) => {
    const on = r.id === id;
    r.element && r.element.classList.toggle("region-active", on);
  });
}

export function playPause() {
  if (!ws) return;
  if (ws.isPlaying()) segPlayId = null;
  ws.playPause();
}

export function stop() {
  if (ws) {
    segPlayId = null;
    ws.pause();
    ws.setTime(0);
  }
}

// Play only this segment; a second call while it is playing pauses and rewinds
// to the segment start.
export function toggleSegment(id, onState) {
  if (!ws || !regions) return;
  const r = regions.getRegions().find((x) => x.id === id);
  if (!r) return;
  if (segPlayId === id && ws.isPlaying()) {
    segPlayId = null;
    ws.pause();
    ws.setTime(r.start);
    onState && onState(false);
    return;
  }
  segPlayId = id;
  ws.setTime(r.start);
  ws.play();
  onState && onState(true);
}

export function playingSegment() {
  return segPlayId;
}

export function seekTo(sec) {
  if (!ws) return;
  segPlayId = null;
  ws.setTime(sec);
}
// frac is 0..1 across the scrub strip; kept for callers that only want a
// clamped seek within the visible window.
export function seekFraction(frac) {
  scrubTo(Math.min(1, Math.max(0, frac || 0)));
}
export function getCurrentTime() {
  return ws ? ws.getCurrentTime() : 0;
}
export function getDuration() {
  return ws ? ws.getDuration() : 0;
}
export function setSpeed(rate) {
  // preservePitch=true: sets the underlying media element's preservesPitch,
  // so 0.5x/2x etc. change duration without the chipmunk/drone pitch shift.
  ws && ws.setPlaybackRate(rate, true);
}
export function setZoom(px) {
  minPxPerSec = px;
  if (!ws) return;
  try {
    ws.zoom(px);
  } catch {}
  // ws.zoom() re-renders the wrapper asynchronously. Poll across frames until
  // its width stops changing, refreshing the visible window each time so the
  // scrub handle never sticks to a mid-transition value.
  let last = -1;
  let tries = 0;
  const settle = () => {
    const sc = scroller();
    const w = sc ? sc.scrollWidth : 0;
    refreshView();
    if (w !== last && tries++ < 15) {
      last = w;
      requestAnimationFrame(settle);
    }
  };
  requestAnimationFrame(settle);
}
export function getZoom() {
  return minPxPerSec;
}
export function setLoop(id) {
  loopId = id;
}
export function getLoop() {
  return loopId;
}
export function isPlaying() {
  return ws ? ws.isPlaying() : false;
}

export function destroy() {
  if (ws) {
    try {
      ws.destroy();
    } catch {}
    ws = null;
  }
  regions = null;
  knownIds = new Set();
  loopId = null;
  segPlayId = null;
  viewStart = 0;
  viewEnd = 0;
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  }
}
