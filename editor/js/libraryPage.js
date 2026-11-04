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

// nothing verified yet / some verified / every segment verified
function statusOf(progress) {
  if (progress && progress.segments && progress.verified === progress.segments) return { key: "done", label: "Done" };
  if (progress && progress.verified > 0) return { key: "progress", label: "In progress" };
  return { key: "new", label: "Not started" };
}

let videos = [];

function viewOf(v, i) {
  const s = v.progress;
  const segments = s ? s.segments : v.vad_segments;
  return { v, i, s, segments, verified: s ? s.verified : 0, status: statusOf(s) };
}

function render() {
  const q = $("library-search").value.trim().toLowerCase();
  const hideDone = $("library-hide-done").checked;
  let rows = videos.map(viewOf);

  const totalSeg = rows.reduce((n, r) => n + r.segments, 0);
  const totalVer = rows.reduce((n, r) => n + r.verified, 0);
  const done = rows.filter((r) => r.status.key === "done").length;
  $("library-summary").replaceChildren(
    el("strong", { text: `${done} of ${rows.length}` }), " videos done, ",
    el("strong", { text: totalVer.toLocaleString() }), ` of ${totalSeg.toLocaleString()} segments verified`
  );
  const next = rows.find((r) => r.status.key !== "done");
  const nextBtn = $("open-next");
  nextBtn.hidden = !next;
  if (next) nextBtn.href = `index.html?id=${encodeURIComponent(next.v.id)}`;

  if (q) rows = rows.filter((r) => `${r.v.title} ${r.v.channel} ${r.v.id}`.toLowerCase().includes(q));
  if (hideDone) rows = rows.filter((r) => r.status.key !== "done");
  const sort = $("library-sort").value;
  const frac = (r) => (r.segments ? r.verified / r.segments : 0);
  if (sort === "duration") rows.sort((a, b) => b.v.duration_s - a.v.duration_s);
  else if (sort === "speakers") rows.sort((a, b) => b.v.speakers_detected - a.v.speakers_detected || a.i - b.i);
  else if (sort === "progress") rows.sort((a, b) => frac(a) - frac(b) || a.i - b.i);

  $("library-rows").replaceChildren(
    ...rows.map((r) => {
      const { v } = r;
      const multi = v.speakers_detected > 1;
      return el("tr", {},
        el("td", { class: "text-muted", text: String(r.i + 1) }),
        el("td", { class: "lib-title" },
          el("a", { href: `index.html?id=${encodeURIComponent(v.id)}`, text: v.title }),
          el("a", { class: "lib-yt", href: v.url, target: "_blank", rel: "noopener", title: "Open on YouTube" }, el("i", { class: "bi bi-box-arrow-up-right" }))),
        el("td", { text: v.channel }),
        el("td", { class: "lib-num", text: clock(v.duration_s) }),
        el("td", { class: `lib-num lib-speakers${multi ? " multi" : ""}`, title: v.speaker_share_pct ? `share of speech: ${v.speaker_share_pct.replaceAll("|", "  ")} %` : "", text: String(v.speakers_detected) }),
        el("td", { class: "lib-num", text: String(r.segments) }),
        el("td", {},
          el("span", { class: "small text-muted", text: `${r.verified} / ${r.segments}` }),
          el("div", { class: "lib-bar" }, el("span", { style: `width:${Math.round(100 * frac(r))}%` }))),
        el("td", {}, el("span", { class: `lib-status ${r.status.key}`, text: r.status.label })));
    })
  );
  $("library-empty").hidden = rows.length > 0;
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
  try {
    videos = await fetchIndex();
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
  for (const id of ["library-search", "library-sort", "library-hide-done"]) $(id).addEventListener("input", render);
  render();
}

boot();
