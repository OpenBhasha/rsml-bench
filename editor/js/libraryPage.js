// library.html: every video in the library, with progress read from its RSML file.

import { fetchIndex, isLocal, getToken, setToken, whoami, lastActiveId } from "./library.js";

const $ = (id) => document.getElementById(id);

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else e.setAttribute(k, v);
  }
  for (const kid of kids) if (kid) e.append(kid);
  return e;
}

function clock(seconds) {
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor(s / 60) % 60;
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

const asrDraftIds = new Set(window.RSML_BENCH.asrDraftIds);
const editorLink = (id) => {
  const params = new URLSearchParams({ id });
  const backend = new URLSearchParams(location.search).get("backend");
  if (backend) params.set("backend", backend);
  return "index.html?" + params;
};

function viewOf(v, i) {
  const s = v.progress;
  const asr = asrDraftIds.has(v.id) ? "yes" : "unknown";
  if (!s) return { v, i, s, asr, coverage: "unknown", status: { key: "unknown", label: "Unavailable" } };
  const coverage = !s.transcribed ? "none" : s.transcribed === s.segments ? "full" : "partial";
  const status = !s.verified ? { key: "new", label: "Not started" }
    : s.verified === s.segments ? { key: "done", label: "Done" }
    : { key: "progress", label: "In progress" };
  return { v, i, s, asr, coverage, status };
}

const format = (n) => n.toLocaleString();
const percent = (n, total) => total ? (100 * n / total).toFixed(1) + "%" : "—";
const signed = (n) => (n > 0 ? "+" : "") + format(n);
const numericCell = (n, label) => el("td", {
  class: "lib-num", "data-order": n ?? -1, text: label ?? (n == null ? "—" : format(n)),
});

function renderRow({ v, i, s, asr, status, seconds }) {
  const fraction = s?.segments ? s.verified / s.segments : 0;
  const comparison = v.comparison;
  const segmentComparison = v.segmentComparison;
  const segmentWer = segmentComparison?.segmentWer;
  const productivity = seconds > 0 && s ? 3600 * s.verifiedSeconds / seconds : null;
  const title = el("td", { class: "lib-title", "data-search": v.title + " " + v.id },
    el("a", { href: editorLink(v.id), text: v.title }));
  if (/^https:\/\/(www\.)?(youtube\.com|youtu\.be)\//.test(v.url || "")) {
    title.append(el("a", { class: "lib-yt", href: v.url, target: "_blank", rel: "noopener", "aria-label": "Open on YouTube" },
      el("i", { class: "bi bi-box-arrow-up-right", "aria-hidden": "true" })));
  }
  return el("tr", {},
    numericCell(i + 1), title,
    el("td", {}, el("span", { class: "lib-status " + status.key, text: status.label })),
    el("td", { text: v.channel }), el("td", { text: v.style || "—" }),
    numericCell(v.duration_s, clock(v.duration_s)), numericCell(v.speakers_detected),
    el("td", { text: asr === "yes" ? "IndicConformer" : "Unrecorded" }),
    numericCell(s?.transcribed, s ? format(s.transcribed) + " / " + format(s.segments) : null),
    numericCell(s?.words), numericCell(s?.verifiedWords),
    el("td", { "data-order": s ? fraction : -1 },
      el("span", { class: "small text-muted", text: s ? format(s.verified) + " / " + format(s.segments) : "—" }),
      s && el("div", { class: "lib-bar", "aria-hidden": "true" },
        el("span", { style: "width:" + Math.round(100 * fraction) + "%" }))),
    numericCell(s?.flagged),
    comparison ? numericCell(comparison.referenceWords - comparison.draftWords, signed(comparison.referenceWords - comparison.draftWords)) : numericCell(null),
    numericCell(seconds, seconds == null ? null : clock(seconds)),
    el("td", { class: "lib-num", "data-order": segmentWer ?? -1,
      title: segmentWer == null ? "No comparable verified segments" : segmentComparison.comparedSegments + " verified segments",
      text: segmentWer == null ? "—" : percent(segmentWer, 1) }),
    numericCell(s?.verifiedSeconds, s ? clock(s.verifiedSeconds) : null),
    numericCell(s?.verifiedRawSeconds, s ? clock(s.verifiedRawSeconds) : null),
    numericCell(productivity, productivity == null ? null : clock(productivity) + " / hr"));
}

function card(label, value, tone, icon, definition) {
  const tooltipId = "info-" + label.toLowerCase().replaceAll(" ", "-");
  const info = el("span", { class: "library-info" },
    el("span", { class: "library-info-icon", tabindex: "0", "aria-label": label + " info", "aria-describedby": tooltipId },
      el("i", { class: "bi bi-info-circle", "aria-hidden": "true" })),
    el("span", { class: "library-info-popover", id: tooltipId, role: "tooltip", text: definition }));
  return el("div", { class: "library-stat " + tone },
    el("dt", {}, el("i", { class: "bi bi-" + icon + " me-2", "aria-hidden": "true" }), el("span", { text: label }), info),
    el("dd", { text: value }));
}

function renderTaskProgress(rows) {
  const countStatus = (status) => rows.filter((row) => row.status.key === status).length;
  const notStarted = countStatus("new");
  const inProgress = countStatus("progress");
  const unavailable = countStatus("unknown");
  const flagged = rows.reduce((sum, row) => sum + (row.s?.flagged || 0), 0);
  const cards = [
    card("Total tasks", format(rows.length), "blue", "collection", "All audio files in the library."),
    card("Pending tasks", format(notStarted + inProgress), "amber", "hourglass-split", "Tasks in progress or awaiting verification."),
    card("Verified tasks", format(countStatus("done")), "green", "check-circle", "Tasks with every segment verified."),
    card("In progress", format(inProgress), "teal", "play-circle", "Tasks with some segments verified."),
    card("Not started", format(notStarted), "slate", "circle", "Tasks with zero verified segments."),
    card("Flags", format(flagged), "rose", "flag", "Total flagged segments."),
  ];
  if (unavailable) cards.push(card("Unavailable", format(unavailable), "slate", "cloud-slash", "Tasks whose transcripts could not be loaded."));
  $("library-task-stats").replaceChildren(...cards);
  $("library-work").hidden = false;
}

function renderOverview(rows) {
  const raw = rows.reduce((sum, row) => sum + row.v.duration_s, 0);
  const sumProgress = (key) => rows.reduce((sum, row) => sum + (row.s?.[key] ?? 0), 0);
  const verifiedRaw = sumProgress("verifiedRawSeconds");
  const verified = sumProgress("verifiedSeconds");
  const segmented = sumProgress("segmentSeconds");
  const compared = rows.flatMap(({ v }) => v.segmentComparison?.comparedSegments ? [v.segmentComparison] : []);
  const comparedSegments = compared.reduce((sum, result) => sum + result.comparedSegments, 0);
  const segmentWerSum = compared.reduce((sum, result) => sum + result.segmentWer * result.comparedSegments, 0);
  const timed = rows.filter((row) => row.seconds != null && row.s?.verifiedSeconds > 0);
  const timedSeconds = timed.reduce((sum, row) => sum + row.seconds, 0);
  const timedVerified = timed.reduce((sum, row) => sum + row.s.verifiedSeconds, 0);
  $("library-stats").replaceChildren(
    card("Overall raw duration", clock(verifiedRaw) + " / " + clock(raw), "blue", "soundwave",
      "Verified time / total. Includes silence from the file start through consecutive verified segments, plus later verified segment durations."),
    card("Overall segment duration", clock(verified) + " / " + clock(segmented), "teal", "bar-chart-steps",
      "Verified segment time / total segment time. Overlaps count once."),
    card("Verified words", format(sumProgress("verifiedWords")) + " / " + format(sumProgress("words")), "green", "fonts",
      "Words in verified segments / all transcript words."),
    card("Avg. Segment WER", percent(segmentWerSum, comparedSegments), "rose", "spellcheck",
      "Mean WER across all comparable verified segments. Each segment has equal weight."),
    card("Productivity", timedSeconds ? clock(3600 * timedVerified / timedSeconds) + " / hr" : "—", "amber", "speedometer2",
      "Verified segment audio per active hour. Autosave gaps over five minutes are excluded."));
  $("library-overview").hidden = false;
}

function updateSummary(rows, total) {
  const missing = rows.filter((r) => !r.s).length;
  $("library-summary").textContent =
    format(rows.length) + " of " + format(total) + " tasks" +
    (missing ? " · " + format(missing) + " unavailable" : "");
}

function setupTable(videos) {
  const rows = videos.map(viewOf);
  for (const row of rows) {
    row.seconds = row.v.seconds ?? null;
  }
  const lastIndex = rows.findIndex((row) => row.v.id === lastActiveId());
  const unfinished = (row) => row && ["new", "progress"].includes(row.status.key);
  const last = rows[lastIndex];
  const next = unfinished(last) ? last
    : rows.slice(lastIndex + 1).find(unfinished) || rows.slice(0, Math.max(0, lastIndex)).find(unfinished);
  const continueLink = $("library-continue");
  continueLink.hidden = !next;
  if (next) {
    continueLink.href = editorLink(next.v.id);
    continueLink.title = next.v.title;
  }
  renderTaskProgress(rows);
  renderOverview(rows);
  $("library-rows").replaceChildren(...rows.map(renderRow));
  updateSummary(rows, rows.length);

  if (!window.DataTable) {
    $("library-error").textContent = "Table controls unavailable.";
    $("library-error").hidden = false;
    return;
  }

  const styleFilter = $("library-style");
  for (const style of [...new Set(videos.map((v) => v.style).filter(Boolean))].sort()) {
    styleFilter.append(el("option", { value: style, text: style }));
  }
  const table = new window.DataTable("#library-table", {
    order: [[0, "asc"]],
    pageLength: 5,
    lengthMenu: [5, 10, 25, 50, { label: "All", value: -1 }],
    scrollX: true,
    language: { emptyTable: "No videos in this library.", zeroRecords: "No videos match.", searchPlaceholder: "Title, channel or ID" },
  });
  $("library-summary").classList.add("visually-hidden");
  const value = (name) => $("library-" + name).value;
  table.search.fixed("library-filters", (_search, _data, index) => {
    const { v, s, asr, coverage, status } = rows[index];
    const speakers = value("speakers");
    const min = value("min-words"), max = value("max-words");
    return (!value("asr") || value("asr") === asr) &&
      (!value("transcript") || value("transcript") === coverage) &&
      (!value("verification") || value("verification") === status.key) &&
      (!styleFilter.value || styleFilter.value === v.style) &&
      (!speakers || (speakers === "single" ? v.speakers_detected === 1 : v.speakers_detected > 1)) &&
      (!min || (s && s.words >= Number(min))) &&
      (!max || (s && s.words <= Number(max))) &&
      (!$("library-flagged").checked || s?.flagged > 0);
  });
  table.on("draw", () => {
    const filtered = table.rows({ search: "applied" }).indexes().toArray();
    updateSummary(filtered.map((index) => rows[index]), rows.length);
  });
  const filters = $("library-filters");
  filters.addEventListener("input", () => table.draw());
  filters.addEventListener("submit", (event) => event.preventDefault());
  filters.addEventListener("reset", () => setTimeout(() => table.search("").draw(), 0));
  filters.hidden = false;
}

// Deployed site only: the token that lets autosave commit to the Hub (see hf.js).
function wireToken() {
  if (isLocal) return;
  const { dataset } = window.RSML_BENCH;
  const box = $("hf-token-box");
  const status = $("hf-token-status");
  const link = $("hf-dataset-link");
  link.href = `https://huggingface.co/datasets/${dataset}`;
  link.textContent = dataset;
  box.hidden = false;

  const show = async () => {
    const token = getToken();
    if (!token) {
      status.textContent = "Not signed in";
      status.className = "small mt-1 text-warning";
      return;
    }
    status.textContent = "Signing in…";
    status.className = "small mt-1 text-muted";
    try {
      const me = await whoami(token);
      status.textContent = `Signed in as ${me.name}`;
      status.className = "small mt-1 text-success";
    } catch (err) {
      if (err.status === 401 || err.status === 403) setToken("");
      status.textContent = `${err.message}.`;
      status.className = "small mt-1 text-danger";
    }
  };
  $("hf-token-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = $("hf-token-input");
    const value = input.value.trim();
    input.value = "";
    if (!value) return;
    setToken(value);
    await show();
    if (getToken()) location.reload();   // the library loads with the token, so reload to read it
  });
  $("hf-token-clear").addEventListener("click", () => {
    setToken("");
    location.reload();
  });
  show();
}

async function boot() {
  wireToken();
  let videos;
  try {
    videos = await fetchIndex({ withStats: true });
  } catch (err) {
    const box = $("library-error");
    const denied = err.status === 401 || err.status === 403;
    if (!isLocal && denied) {
      box.textContent = getToken() ? "Hugging Face dataset access denied." : "Hugging Face sign-in required.";
    } else {
      box.textContent = `Could not load the library (${err.message || err}).`;
    }
    box.hidden = false;
    $("library-summary").textContent = "";
    return;
  }
  setupTable(videos);
}

boot();
