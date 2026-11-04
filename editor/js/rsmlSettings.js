// Renders the "RSML tags" section of the settings drawer. All vocabulary
// editing goes through the `rsml` library's own RSMLAnnotator.add()/
// .remove() (rsml@3.3.0+) — no hand-rolled tag lists, defaults, or
// validation here. The category set itself (currently: hesitations,
// isolatedParalinguistics, isolatedOther, disfluencySpans,
// paralinguisticSpans, prosodySpans, entities, languages, dialects,
// domains) is discovered from a live annotator's own `.opts`, so a future
// library version adding another category shows up automatically.
//
// One exception: "Accents" (the `$id[...](...)` tag). rsml has no accents
// category at all — its own `$` completion is a single static "unspecified"
// entry with no backing vocabulary, no add()/remove() support, and the
// validator explicitly treats it as freeform (confirmed by reading
// rsml@3.3.0's source directly: CATEGORY_SPECS has no "accents" key, and
// there's no opts.accents anywhere). So this one category is hand-rolled —
// stored in state.accents ({id: name}) rather than routed through an
// annotator at all — and editor.js's patchCompletions() feeds it into the
// `$` autocomplete itself, the same way dialects/domains present theirs.
//
// Takes its app-shell hooks (getState/scheduleSave/toast/escapeHtml/
// applyToOpenRows) as a `deps` parameter rather than importing them from
// main.js/editor.js, keeping this a plain leaf module — see main.js's
// boot() for why that matters here.
import RSMLAnnotator from "./rsmlLib.js";

// Presentational only — a category missing from this map still renders
// fine, just with its raw key title-cased as the label and no hint line.
const CATEGORY_META = {
  hesitations: { label: "Hesitations", hint: "Isolated fillers — type @name while annotating." },
  isolatedParalinguistics: { label: "Paralinguistics (isolated)", hint: "Isolated sounds, e.g. laughter, cough — type @name." },
  isolatedOther: { label: "Other isolated tags", hint: "e.g. silence, unintelligible — type @name." },
  disfluencySpans: { label: "Disfluency spans", hint: "Wrapped around speech as @name-start ... @name-end." },
  paralinguisticSpans: { label: "Paralinguistic spans", hint: "Wrapped around speech as @name-start ... @name-end." },
  prosodySpans: { label: "Prosody spans", hint: "Wrapped around speech as @name-start ... @name-end." },
  entities: { label: "Entity types", hint: "Tagged as #CODE[text](normalized)." },
  languages: { label: "Languages", hint: "Tagged as !code[text](gloss) for code-mixed spans." },
  dialects: { label: "Dialects", hint: "Tagged as $$CODE[text](normalized) for dialect-specific phrasing." },
  domains: { label: "Domains", hint: "Tagged as !!CODE[text](normalized) for domain/register-specific terms." },
};

const NON_VOCAB_KEYS = new Set(["textarea", "output", "tags", "demoText", "disableCodeMirror"]);

function prettify(key) {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());
}

function vocabCategories(annotator) {
  return Object.keys(annotator.opts).filter((k) => !NON_VOCAB_KEYS.has(k));
}

function makeHiddenAnnotator(opts) {
  const ta = document.createElement("textarea");
  const out = document.createElement("div");
  ta.hidden = true;
  out.hidden = true;
  document.body.append(ta, out);
  return new RSMLAnnotator({ textarea: ta, output: out, disableCodeMirror: true, ...(opts || {}) });
}

// A hidden, never-shown RSMLAnnotator instance that exists purely to hold
// and mutate the *current* project's tag vocabulary via the library's own
// add()/remove(). Rebuilt fresh (old textarea/output discarded) on every
// renderRsmlSettings() call rather than cached across the page's lifetime
// — main.js calls renderRsmlSettings again whenever `state` is replaced by
// a new project, and reusing a stale instance here would keep editing the
// *previous* project's vocabulary instead of picking up the new one.
let configAnnotator = null;
function getConfigAnnotator(initialConfig) {
  if (configAnnotator) {
    configAnnotator.destroy();
    configAnnotator.textarea.remove();
    configAnnotator.output.remove();
  }
  // Built with no overrides (pure library defaults), then each saved
  // category is layered on via syncCategoryTo() rather than passed straight
  // into the constructor — see the "healing" comment in renderRsmlSettings
  // for why a raw spread here isn't safe against older/malformed saved data.
  configAnnotator = makeHiddenAnnotator();
  if (initialConfig) {
    for (const key of Object.keys(initialConfig)) {
      if (!NON_VOCAB_KEYS.has(key) && key in configAnnotator.opts) {
        syncCategoryTo(configAnnotator, key, initialConfig[key]);
      }
    }
  }
  return configAnnotator;
}

// A second hidden instance, constructed with no overrides, purely as a
// live reference for the library's own built-in defaults (used by "Reset
// to defaults" below). These never change project-to-project, so this one
// *is* a true page-lifetime singleton, lazily built at most once.
let defaultsAnnotator = null;
function getDefaultsAnnotator() {
  if (defaultsAnnotator) return defaultsAnnotator;
  defaultsAnnotator = makeHiddenAnnotator();
  return defaultsAnnotator;
}

function cloneValue(v) {
  return Array.isArray(v) ? v.slice() : Object.assign({}, v);
}

// Reconciles one category to exactly `desired` using only the library's own
// add()/remove() — clears whatever's there, then re-adds `desired` — rather
// than a raw Object.assign of the array/object. That matters because a
// straight assignment bypasses the library's own normalization (e.g. the
// isolated-tag families are always stored "@"-prefixed internally; a saved
// value that's missing the "@" — such as state.rsmlConfig written by an
// older version of this feature, before it used the library's native API —
// would sit there unnormalized and silently fail to compare equal to
// anything the library itself produces). Routing every value through
// add()/remove() means whatever shape `desired` is in, the result always
// matches what a real edit would have produced.
function syncCategoryTo(annotator, category, desired) {
  const current = annotator.opts[category];
  if (Array.isArray(desired)) {
    for (const name of current.slice()) annotator.remove(category, name);
    for (const name of desired) annotator.add(category, name);
  } else {
    for (const code of Object.keys(current)) annotator.remove(category, code);
    for (const [code, label] of Object.entries(desired)) annotator.add(category, code, label);
  }
}

export function renderRsmlSettings(root, deps) {
  if (!root) return;
  const state = deps.getState();
  const annotator = getConfigAnnotator(state.rsmlConfig);
  // state.rsmlConfig may have been written by an older version of this
  // feature (before rsml@3.3.0's native add/remove) in a shape the current
  // library doesn't produce on its own — getConfigAnnotator() above already
  // normalized it into the annotator via syncCategoryTo(); write that
  // normalized shape straight back so it doesn't keep re-triggering this
  // healing path (and so editor.js's plain `...state.rsmlConfig` spread for
  // new segments gets already-normalized data too). Only when there was
  // something to normalize in the first place — an untouched (null) project
  // stays null rather than eagerly materializing every default.
  if (state.rsmlConfig) {
    const healed = {};
    for (const key of vocabCategories(annotator)) healed[key] = cloneValue(annotator.opts[key]);
    state.rsmlConfig = healed;
    deps.scheduleSave();
  }
  root.innerHTML = "";
  for (const key of vocabCategories(annotator)) {
    root.appendChild(buildCategory(key, annotator, deps));
  }
  root.appendChild(buildAccentsCategory(deps));
}

// Runs one add()/remove() on the shared config annotator, and — only if it
// actually changed something — persists the resulting category value and
// replays the same call on every already-open segment editor so they
// reflect it immediately (the library supports this live, even mid-edit;
// no rebuild needed).
function mutate(annotator, deps, category, action, value, label) {
  let changed;
  try {
    changed = annotator[action](category, value, label);
  } catch (err) {
    deps.toast(err.message, "error");
    return false;
  }
  if (changed) {
    const state = deps.getState();
    if (!state.rsmlConfig) state.rsmlConfig = {};
    state.rsmlConfig[category] = cloneValue(annotator.opts[category]);
    deps.scheduleSave();
    deps.applyToOpenRows(category, action, value, label);
  }
  return changed;
}

// Resets a category to the library's own built-in default: clears whatever
// is currently registered, then re-adds the default set — same
// clear-then-repopulate approach as syncCategoryTo(), just routed through
// mutate() step by step so each change is persisted and replayed onto
// every open segment editor as it happens.
function resetCategory(annotator, deps, category) {
  const def = getDefaultsAnnotator().opts[category];
  const current = annotator.opts[category];
  if (Array.isArray(def)) {
    for (const name of current.slice()) mutate(annotator, deps, category, "remove", name);
    for (const name of def) mutate(annotator, deps, category, "add", name);
  } else {
    for (const code of Object.keys(current)) mutate(annotator, deps, category, "remove", code);
    for (const [code, label] of Object.entries(def)) mutate(annotator, deps, category, "add", code, label);
  }
}

function buildCategory(key, annotator, deps) {
  const meta = CATEGORY_META[key] || {};
  const isList = Array.isArray(annotator.opts[key]);

  const det = document.createElement("details");
  det.className = "rsml-cat";

  const summary = document.createElement("summary");
  const countEl = document.createElement("span");
  countEl.className = "rsml-cat-count";
  summary.append((meta.label || prettify(key)) + " ", countEl);
  det.appendChild(summary);

  if (meta.hint) {
    const hint = document.createElement("p");
    hint.className = "rsml-cat-hint muted small";
    hint.textContent = meta.hint;
    det.appendChild(hint);
  }

  const body = document.createElement("div");
  det.appendChild(body);

  const rerender = () => {
    const v = annotator.opts[key];
    countEl.textContent = Array.isArray(v) ? v.length : Object.keys(v).length;
    body.innerHTML = "";
    body.appendChild(isList ? buildListBody(key, annotator, deps, rerender) : buildMapBody(key, annotator, deps, rerender));
  };
  rerender();

  const resetBtn = document.createElement("button");
  resetBtn.type = "button";
  resetBtn.className = "btn btn-sm btn-link rsml-reset";
  resetBtn.textContent = "Reset to defaults";
  resetBtn.onclick = () => {
    resetCategory(annotator, deps, key);
    rerender();
  };
  det.appendChild(resetBtn);

  return det;
}

function buildListBody(key, annotator, deps, rerender) {
  const { escapeHtml } = deps;
  const frag = document.createDocumentFragment();

  const chipWrap = document.createElement("div");
  chipWrap.className = "rsml-chips";
  const values = annotator.opts[key];
  for (const word of values) {
    const chip = document.createElement("span");
    chip.className = "rsml-chip";
    chip.innerHTML = `${escapeHtml(word)} <button type="button" aria-label="Remove ${escapeHtml(word)}">&times;</button>`;
    chip.querySelector("button").onclick = () => {
      mutate(annotator, deps, key, "remove", word);
      rerender();
    };
    chipWrap.appendChild(chip);
  }
  if (!values.length) {
    const empty = document.createElement("span");
    empty.className = "rsml-cat-empty muted small";
    empty.textContent = "None — every @tag of this kind will show as unrecognized.";
    chipWrap.appendChild(empty);
  }
  frag.appendChild(chipWrap);

  const addRow = document.createElement("div");
  addRow.className = "rsml-add-row";
  addRow.innerHTML =
    `<input type="text" placeholder="add tag name" class="form-control form-control-sm" />` +
    `<button type="button" class="btn btn-sm btn-outline-secondary">Add</button>`;
  const input = addRow.querySelector("input");
  const doAdd = () => {
    const raw = input.value.trim();
    if (!raw) return;
    if (mutate(annotator, deps, key, "add", raw)) input.value = "";
    rerender();
  };
  addRow.querySelector("button").onclick = doAdd;
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      doAdd();
    }
  });
  frag.appendChild(addRow);

  return frag;
}

function buildMapBody(key, annotator, deps, rerender) {
  const { escapeHtml } = deps;
  const frag = document.createDocumentFragment();

  const rowsWrap = document.createElement("div");
  rowsWrap.className = "rsml-map-rows";
  const map = annotator.opts[key];
  const codes = Object.keys(map).sort();
  for (const code of codes) {
    const row = document.createElement("div");
    row.className = "rsml-map-row";
    row.innerHTML =
      `<code class="rsml-map-code">${escapeHtml(code)}</code>` +
      `<span class="rsml-map-label">${escapeHtml(map[code])}</span>` +
      `<button type="button" aria-label="Remove ${escapeHtml(code)}">&times;</button>`;
    row.querySelector("button").onclick = () => {
      mutate(annotator, deps, key, "remove", code);
      rerender();
    };
    rowsWrap.appendChild(row);
  }
  if (!codes.length) {
    const empty = document.createElement("p");
    empty.className = "rsml-cat-empty muted small";
    empty.textContent = "None configured.";
    rowsWrap.appendChild(empty);
  }
  frag.appendChild(rowsWrap);

  const addRow = document.createElement("div");
  addRow.className = "rsml-add-row rsml-add-row-map";
  addRow.innerHTML =
    `<input type="text" placeholder="code" class="form-control form-control-sm rsml-add-code" />` +
    `<input type="text" placeholder="label" class="form-control form-control-sm rsml-add-label" />` +
    `<button type="button" class="btn btn-sm btn-outline-secondary">Add</button>`;
  const codeInput = addRow.querySelector(".rsml-add-code");
  const labelInput = addRow.querySelector(".rsml-add-label");
  const doAdd = () => {
    const code = codeInput.value.trim();
    if (!code) return;
    if (mutate(annotator, deps, key, "add", code, labelInput.value.trim())) {
      codeInput.value = "";
      labelInput.value = "";
    }
    rerender();
  };
  addRow.querySelector("button").onclick = doAdd;
  for (const el of [codeInput, labelInput]) {
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        doAdd();
      }
    });
  }
  frag.appendChild(addRow);

  return frag;
}

// --------------------------------------------------------------- accents ----
//
// Same map-category look as buildMapBody() above, but reading/writing
// state.accents directly instead of an annotator's .opts — see this file's
// header comment for why accents can't go through the library's own
// add()/remove() at all.

function buildAccentsCategory(deps) {
  const { getState } = deps;

  const det = document.createElement("details");
  det.className = "rsml-cat";

  const summary = document.createElement("summary");
  const countEl = document.createElement("span");
  countEl.className = "rsml-cat-count";
  summary.append("Accents ", countEl);
  det.appendChild(summary);

  const hint = document.createElement("p");
  hint.className = "rsml-cat-hint muted small";
  hint.textContent = "Tagged as $ID[text](normalized) for accent-specific phrasing. App-only (rsml has no accents vocabulary of its own), so unlike the categories above these are never flagged by the validator.";
  det.appendChild(hint);

  const body = document.createElement("div");
  det.appendChild(body);

  const rerender = () => {
    const map = getState().accents || {};
    countEl.textContent = Object.keys(map).length;
    body.innerHTML = "";
    body.appendChild(buildAccentsBody(deps, rerender));
  };
  rerender();

  return det;
}

function buildAccentsBody(deps, rerender) {
  const { getState, scheduleSave, toast, escapeHtml } = deps;
  const frag = document.createDocumentFragment();
  const state = getState();
  if (!state.accents) state.accents = {};
  const map = state.accents;

  const rowsWrap = document.createElement("div");
  rowsWrap.className = "rsml-map-rows";
  const codes = Object.keys(map).sort();
  for (const id of codes) {
    const row = document.createElement("div");
    row.className = "rsml-map-row";
    row.innerHTML =
      `<code class="rsml-map-code">${escapeHtml(id)}</code>` +
      `<span class="rsml-map-label">${escapeHtml(map[id])}</span>` +
      `<button type="button" aria-label="Remove ${escapeHtml(id)}">&times;</button>`;
    row.querySelector("button").onclick = () => {
      delete map[id];
      scheduleSave();
      rerender();
    };
    rowsWrap.appendChild(row);
  }
  if (!codes.length) {
    const empty = document.createElement("p");
    empty.className = "rsml-cat-empty muted small";
    empty.textContent = "None configured.";
    rowsWrap.appendChild(empty);
  }
  frag.appendChild(rowsWrap);

  const addRow = document.createElement("div");
  addRow.className = "rsml-add-row rsml-add-row-map";
  addRow.innerHTML =
    `<input type="text" placeholder="id" class="form-control form-control-sm rsml-add-code" />` +
    `<input type="text" placeholder="name" class="form-control form-control-sm rsml-add-label" />` +
    `<button type="button" class="btn btn-sm btn-outline-secondary">Add</button>`;
  const idInput = addRow.querySelector(".rsml-add-code");
  const labelInput = addRow.querySelector(".rsml-add-label");
  const doAdd = () => {
    // $ID has to stay a single autocomplete-triggerable token — matches
    // the [\w-] character class rsml's own trigger regex accepts.
    const id = idInput.value.trim().replace(/[^\w-]/g, "");
    if (!id) {
      if (idInput.value.trim()) toast("Accent id can only contain letters, numbers, - and _.", "error");
      return;
    }
    map[id] = labelInput.value.trim();
    scheduleSave();
    idInput.value = "";
    labelInput.value = "";
    rerender();
  };
  addRow.querySelector("button").onclick = doAdd;
  for (const el of [idInput, labelInput]) {
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        doAdd();
      }
    });
  }
  frag.appendChild(addRow);

  return frag;
}
