import { clock, productivity } from "./libraryStats.js";

const format = (value) => value == null ? "—" : value.toLocaleString();
const duration = (value) => value == null ? "—" : clock(value);
const pair = (formatter, part, total) => `${formatter(part)} / ${formatter(total)}`;

export function renderFileStats(video) {
  const { progress, comparison, segmentComparison, seconds } = video;
  const rate = productivity(progress, seconds);
  const difference = comparison ? comparison.referenceWords - comparison.draftWords : null;
  const wer = segmentComparison?.segmentWer;
  const rows = [
    ["Status", !progress ? "Unavailable" : !progress.verified ? "Not started" :
      progress.verified === progress.segments ? "Done" : "In progress"],
    ["Channel", video.channel || "—"],
    ["Style", video.style || "—"],
    ["Speakers", format(video.speakers_detected)],
    ["ASR draft", window.RSML_BENCH.asrDraftIds.includes(video.id) ? "IndicConformer" : "Unrecorded"],
    ["Finished / overall raw", pair(duration, progress?.verifiedRawSeconds, video.duration_s)],
    ["Finished / overall segments", pair(duration, progress?.verifiedSeconds, progress?.segmentSeconds)],
    ["Transcribed segments", pair(format, progress?.transcribed, progress?.segments)],
    ["Verified segments", pair(format, progress?.verified, progress?.segments)],
    ["Verified / total words", pair(format, progress?.verifiedWords, progress?.words)],
    ["Flags", format(progress?.flagged)],
    ["Words Δ", (difference > 0 ? "+" : "") + format(difference)],
    ["Avg. Segment WER", wer == null ? "—" : (100 * wer).toFixed(1) + "%"],
    ["Compared segments", format(segmentComparison?.comparedSegments)],
    ["Active time", duration(seconds)],
    ["Productivity", rate == null ? "—" : clock(rate) + " / hr"],
  ];
  const cells = rows.flatMap(([label, value]) => {
    const term = document.createElement("dt");
    const description = document.createElement("dd");
    term.textContent = label;
    description.textContent = value;
    return [term, description];
  });
  document.getElementById("file-stats-values").replaceChildren(...cells);
  document.getElementById("file-stats").hidden = false;
}
