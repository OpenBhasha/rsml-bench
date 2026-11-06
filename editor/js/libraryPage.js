// library.html: every video in the library with its speaker facts and its progress, both from the
// server (progress is read from each video's rsml file; nothing is stored in the browser).

import { fetchIndex, isLocal, getToken, setToken, whoami } from "./library.js";

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
const numericCell = (n, label) => el("td", {
  class: "lib-num", "data-order": n ?? -1, text: label ?? (n == null ? "—" : format(n)),
});

function renderRow({ v, i, s, asr, status }) {
  const fraction = s?.segments ? s.verified / s.segments : 0;
  const title = el("td", { class: "lib-title", "data-search": v.title + " " + v.id },
    el("a", { href: editorLink(v.id), text: v.title }));
  if (/^https:\/\/(www\.)?(youtube\.com|youtu\.be)\//.test(v.url || "")) {
    title.append(el("a", { class: "lib-yt", href: v.url, target: "_blank", rel: "noopener", "aria-label": "Open on YouTube" },
      el("i", { class: "bi bi-box-arrow-up-right", "aria-hidden": "true" })));
  }
  return el("tr", {},
    numericCell(i + 1), title, el("td", { text: v.channel }), el("td", { text: v.style || "—" }),
    numericCell(v.duration_s, clock(v.duration_s)), numericCell(v.speakers_detected),
    el("td", { text: asr === "yes" ? "IndicConformer" : "Unrecorded" }),
    numericCell(s?.transcribed, s ? format(s.transcribed) + " / " + format(s.segments) : null),
    numericCell(s?.words), numericCell(s?.verifiedWords),
    el("td", { "data-order": s ? fraction : -1 },
      el("span", { class: "small text-muted", text: s ? format(s.verified) + " / " + format(s.segments) : "—" }),
      s && el("div", { class: "lib-bar", "aria-hidden": "true" },
        el("span", { style: "width:" + Math.round(100 * fraction) + "%" }))),
    numericCell(s?.flagged),
    el("td", {}, el("span", { class: "lib-status " + status.key, text: status.label })));
}

function updateSummary(rows, total) {
  const count = (predicate) => rows.filter(predicate).length;
  const sum = (key) => format(rows.reduce((n, r) => n + (r.s?.[key] ?? 0), 0));
  const missing = count((r) => !r.s);
  $("library-summary").textContent =
    format(rows.length) + " of " + format(total) + " tasks · " +
    format(count((r) => r.asr === "yes")) + " with recorded ASR · " +
    format(count((r) => r.s?.transcribed > 0)) + " with transcript text · " +
    sum("words") + " words · " + sum("verifiedWords") + " words in verified cues · " +
    sum("verified") + " of " + sum("segments") + " cues verified · " +
    format(count((r) => r.status.key === "done")) + " tasks fully verified" +
    (missing ? " · " + format(missing) + " unavailable" : "");
}

function setupTable(videos) {
  const rows = videos.map(viewOf);
  const next = rows.find((r) => ["new", "progress"].includes(r.status.key));
  $("open-next").hidden = !next;
  if (next) $("open-next").href = editorLink(next.v.id);
  $("library-rows").replaceChildren(...rows.map(renderRow));
  updateSummary(rows, rows.length);

  if (!window.DataTable) {
    $("library-error").textContent = "Table controls could not load. Reload to try again.";
    $("library-error").hidden = false;
    return;
  }

  const styleFilter = $("library-style");
  for (const style of [...new Set(videos.map((v) => v.style).filter(Boolean))].sort()) {
    styleFilter.append(el("option", { value: style, text: style }));
  }
  const table = new window.DataTable("#library-table", {
    order: [[0, "asc"]],
    pageLength: 25,
    lengthMenu: [10, 25, 50, { label: "All", value: -1 }],
    scrollX: true,
    language: { emptyTable: "No videos in this library.", zeroRecords: "No videos match.", searchPlaceholder: "Title, channel or ID" },
  });
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
      status.textContent = "Not signed in: edits will not save until you add a token.";
      status.className = "small mt-1 text-warning";
      return;
    }
    status.textContent = "Checking the token...";
    status.className = "small mt-1 text-muted";
    try {
      const me = await whoami(token);
      status.textContent = `Signed in as ${me.name}. Edits from this tab save to ${dataset}.`;
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
      box.textContent = getToken()
        ? "This token cannot read the library yet. Request access to the dataset on Hugging Face, then reload."
        : "This library is gated. Request access to the dataset on Hugging Face, then paste your access token above.";
    } else {
      box.textContent = `Could not load the library (${err.message || err}).${isLocal ? " Start it with library_server.py and open the page it prints." : " Check the connection and reload."}`;
    }
    box.hidden = false;
    $("library-summary").textContent = "";
    return;
  }
  setupTable(videos);
}

boot();
