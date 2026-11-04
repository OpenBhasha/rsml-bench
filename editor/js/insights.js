// Renders the "Insights" popup opened from the settings drawer: frequency
// counts of every RSML tag category (code-mixing, named entities,
// disfluencies, and the rest of the vocabulary configured in Settings ->
// RSML tags) across every segment in the current project.
//
// Counting is a plain string scan, not a live RSMLAnnotator render — a
// segment's tagged text is walked with the same bracket-matching approach
// rsml's own _transformRSML() uses internally (mirrored here, since the
// library exposes no public "parse and count" API), recursing into a
// bracket tag's verbatim payload so nested tags (e.g. an entity wrapped
// around a code-switched phrase) are still counted. A single hidden,
// disposable RSMLAnnotator is built per call purely to read the *current*
// project's vocabulary (opts.languages, opts.entities, ...) for friendly
// labels and for classifying which family an @tag/span name belongs to —
// same technique rsmlSettings.js uses for its own config editor.
import RSMLAnnotator from "./rsmlLib.js";

// Display order: code-mixing and named entities first (the categories
// called out by name when this feature was requested), then disfluencies,
// then everything else the RSML tag vocabulary covers. Always listed, even
// at zero — same "every category shows up, used or not" rule the RSML tags
// settings panel itself follows (rsmlSettings.js's vocabCategories()) —
// otherwise a category with no occurrences yet (e.g. a project that hasn't
// used code-mixing at all) would silently vanish from the popup instead of
// reading as "0 so far".
const CATEGORY_ORDER = [
  "languages",
  "entities",
  "disfluencySpans",
  "paralinguisticSpans",
  "prosodySpans",
  "hesitations",
  "isolatedParalinguistics",
  "isolatedOther",
  "dialects",
  "domains",
  "accents",
  "mispronunciations",
];

// Diagnostic-only overflow buckets for @tags/spans that don't match any
// configured name (typos, etc.) — unlike CATEGORY_ORDER above, these stay
// hidden when empty; showing "Unrecognized @-tags 0" on every clean project
// would just be noise.
const DIAGNOSTIC_ORDER = ["unknownTags", "unknownSpans"];

const CATEGORY_LABELS = {
  languages: "Code-mixing",
  entities: "Named entities",
  disfluencySpans: "Disfluencies",
  paralinguisticSpans: "Paralinguistic spans",
  prosodySpans: "Prosody spans",
  hesitations: "Hesitations",
  isolatedParalinguistics: "Paralinguistics (isolated)",
  isolatedOther: "Other isolated tags",
  dialects: "Dialects",
  domains: "Domains",
  accents: "Accents",
  mispronunciations: "Mispronunciations",
  unknownTags: "Unrecognized @-tags",
  unknownSpans: "Unrecognized span tags",
};

function makeLookupAnnotator(rsmlConfig) {
  const ta = document.createElement("textarea");
  const out = document.createElement("div");
  ta.hidden = true;
  out.hidden = true;
  document.body.append(ta, out);
  // Same straight-spread editor.js uses for each segment's live annotator —
  // safe here too, since by the time Insights can be opened,
  // rsmlSettings.js's renderRsmlSettings() has already normalized
  // state.rsmlConfig at least once (run at boot via syncSettingsPanels()).
  return new RSMLAnnotator({ textarea: ta, output: out, disableCodeMirror: true, ...(rsmlConfig || {}) });
}

function buildLookups(annotator) {
  const atCategory = new Map(); // bare @tag name -> category key
  const stripAt = (t) => (t[0] === "@" ? t.slice(1) : t);
  for (const t of annotator.opts.hesitations) atCategory.set(stripAt(t), "hesitations");
  for (const t of annotator.opts.isolatedParalinguistics) atCategory.set(stripAt(t), "isolatedParalinguistics");
  for (const t of annotator.opts.isolatedOther) atCategory.set(stripAt(t), "isolatedOther");

  const spanCategory = new Map(); // span base name -> category key
  for (const b of annotator.opts.disfluencySpans) spanCategory.set(b, "disfluencySpans");
  for (const b of annotator.opts.paralinguisticSpans) spanCategory.set(b, "paralinguisticSpans");
  for (const b of annotator.opts.prosodySpans) spanCategory.set(b, "prosodySpans");

  return { atCategory, spanCategory };
}

// Identical algorithm to rsml.js's own _matchBracket(): depth-counts from
// `start` and returns the index of the matching close, or -1.
function matchBracket(text, start, open, close) {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === open) depth++;
    else if (text[i] === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function bump(counts, category, key) {
  if (!counts[category]) counts[category] = {};
  counts[category][key] = (counts[category][key] || 0) + 1;
}

function tallyBracket(prefix, type, counts) {
  if (prefix === "!!") bump(counts, "domains", type || "(unspecified)");
  else if (prefix === "!") bump(counts, "languages", type ? type.toLowerCase() : "(unspecified)");
  else if (prefix === "$$") bump(counts, "dialects", type || "(unspecified)");
  else if (prefix === "$") bump(counts, "accents", type || "(unspecified)");
  else if (prefix === "#") bump(counts, "entities", type || "(unspecified)");
}

// Walks one segment's raw RSML text, tallying every tag it finds into
// `counts` (breakdown categories) / `flatTotals` (categories with no
// meaningful subtype, currently just plain mispronunciations). Mirrors
// _transformRSML()'s main loop, minus the HTML building.
function scanText(text, lookups, counts, flatTotals) {
  const n = text.length;
  let i = 0;
  while (i < n) {
    // Prefixed bracket form: ! # $ $$ !! + optional type + [verbatim](normalized)
    const pm = /^(\$\$|!!|[!#$])([A-Za-z][\w-]*)?\[/.exec(text.slice(i));
    if (pm) {
      const prefix = pm[1];
      const type = pm[2] || "";
      const openBracket = i + pm[0].length - 1;
      const closeBracket = matchBracket(text, openBracket, "[", "]");
      if (closeBracket !== -1 && text[closeBracket + 1] === "(") {
        const closeParen = matchBracket(text, closeBracket + 1, "(", ")");
        if (closeParen !== -1) {
          tallyBracket(prefix, type, counts);
          scanText(text.slice(openBracket + 1, closeBracket), lookups, counts, flatTotals);
          i = closeParen + 1;
          continue;
        }
      }
    }

    // Bare mispronunciation: [verbatim](normalized), no prefix.
    if (text[i] === "[") {
      const closeBracket = matchBracket(text, i, "[", "]");
      if (closeBracket !== -1 && text[closeBracket + 1] === "(") {
        const closeParen = matchBracket(text, closeBracket + 1, "(", ")");
        if (closeParen !== -1) {
          flatTotals.mispronunciations = (flatTotals.mispronunciations || 0) + 1;
          scanText(text.slice(i + 1, closeBracket), lookups, counts, flatTotals);
          i = closeParen + 1;
          continue;
        }
      }
    }

    // @tag / @name-start / @name-end. Only -start is counted for span
    // pairs, so each annotated span is tallied once (at -end, the same
    // instance would otherwise be double counted).
    if (text[i] === "@") {
      const at = /^@([\w-]+)/.exec(text.slice(i));
      if (at) {
        const name = at[1];
        if (name.endsWith("-start")) {
          const base = name.slice(0, -6);
          bump(counts, lookups.spanCategory.get(base) || "unknownSpans", base);
        } else if (!name.endsWith("-end")) {
          bump(counts, lookups.atCategory.get(name) || "unknownTags", name);
        }
        i += at[0].length;
        continue;
      }
    }

    i++;
  }
}

function countAll(counts, flatTotals) {
  let n = 0;
  for (const key in counts) for (const code in counts[key]) n += counts[key][code];
  for (const key in flatTotals) n += flatTotals[key];
  return n;
}

// Pure function: { totalSegments, taggedSegments, grandTotal, categories }
// where categories is an ordered array of
// { key, label, total, entries: [{ code, label, count }, ...] | null }.
// `entries` is null for a flat category (mispronunciations) that has no
// meaningful subtype breakdown. Every category in CATEGORY_ORDER is always
// present (possibly at total: 0 / entries: []) — see that array's comment.
export function computeInsights(state) {
  const annotator = makeLookupAnnotator(state.rsmlConfig);
  try {
    const lookups = buildLookups(annotator);
    const counts = {};
    const flatTotals = {};
    const segments = state.segments || [];
    let taggedSegments = 0;
    for (const seg of segments) {
      const before = countAll(counts, flatTotals);
      scanText(seg.rsml || "", lookups, counts, flatTotals);
      if (countAll(counts, flatTotals) > before) taggedSegments++;
    }

    const labelMaps = {
      languages: annotator.opts.languages,
      entities: annotator.opts.entities,
      dialects: annotator.opts.dialects,
      domains: annotator.opts.domains,
      accents: state.accents || {},
    };

    const toEntries = (bucket, map) =>
      Object.entries(bucket || {})
        .map(([code, count]) => ({ code, label: (map && map[code]) || null, count }))
        .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));

    const categories = [];
    for (const key of CATEGORY_ORDER) {
      if (key === "mispronunciations") {
        categories.push({ key, label: CATEGORY_LABELS[key], total: flatTotals.mispronunciations || 0, entries: null });
        continue;
      }
      const entries = toEntries(counts[key], labelMaps[key]);
      const total = entries.reduce((sum, e) => sum + e.count, 0);
      categories.push({ key, label: CATEGORY_LABELS[key] || key, total, entries });
    }
    // Diagnostic buckets only surface when there's actually something in them.
    for (const key of DIAGNOSTIC_ORDER) {
      if (!counts[key] || !Object.keys(counts[key]).length) continue;
      const entries = toEntries(counts[key], null);
      const total = entries.reduce((sum, e) => sum + e.count, 0);
      categories.push({ key, label: CATEGORY_LABELS[key], total, entries });
    }

    const grandTotal = categories.reduce((sum, c) => sum + c.total, 0);
    return { totalSegments: segments.length, taggedSegments, grandTotal, categories };
  } finally {
    annotator.destroy();
    annotator.textarea.remove();
    annotator.output.remove();
  }
}

function emptyRow() {
  const p = document.createElement("p");
  p.className = "rsml-cat-empty muted small";
  p.textContent = "None tagged yet.";
  return p;
}

function buildCategoryBlock(cat, escapeHtml) {
  const det = document.createElement("details");
  det.className = "rsml-cat insight-cat";
  // Populated categories open automatically (this is a report, not an
  // editor — worth seeing at a glance); an unused one stays collapsed so a
  // fresh project's popup isn't a wall of "None tagged yet." rows, while
  // still being listed (with its real 0) rather than omitted outright.
  det.open = cat.total > 0;

  const summary = document.createElement("summary");
  const countEl = document.createElement("span");
  countEl.className = "rsml-cat-count";
  countEl.textContent = cat.total;
  summary.append(cat.label + " ", countEl);
  det.appendChild(summary);

  const body = document.createElement("div");
  body.className = "insight-rows";

  if (cat.entries === null) {
    if (cat.total) {
      const row = document.createElement("div");
      row.className = "insight-row";
      row.innerHTML =
        `<span class="insight-row-name">Occurrences</span>` +
        `<span class="insight-bar-track"><span class="insight-bar-fill" style="width:100%"></span></span>` +
        `<span class="insight-row-count">${cat.total}</span>`;
      body.appendChild(row);
    } else {
      body.appendChild(emptyRow());
    }
  } else if (!cat.entries.length) {
    body.appendChild(emptyRow());
  } else {
    const max = cat.entries[0].count;
    for (const e of cat.entries) {
      const row = document.createElement("div");
      row.className = "insight-row";
      const nameHtml = e.label
        ? `<code class="rsml-map-code">${escapeHtml(e.code)}</code> <span class="rsml-map-label">${escapeHtml(e.label)}</span>`
        : `<code class="rsml-map-code">${escapeHtml(e.code)}</code>`;
      const pct = max ? Math.max(4, Math.round((e.count / max) * 100)) : 0;
      row.innerHTML =
        `<span class="insight-row-name">${nameHtml}</span>` +
        `<span class="insight-bar-track"><span class="insight-bar-fill" style="width:${pct}%"></span></span>` +
        `<span class="insight-row-count">${e.count}</span>`;
      body.appendChild(row);
    }
  }

  det.appendChild(body);
  return det;
}

// Computes fresh (the project may have changed since the modal was last
// opened) and rebuilds `root`'s contents. Call this each time the Insights
// modal is opened, same as the shortcuts/speaker/flag modals build their
// content on open rather than keeping a live-updating view.
export function renderInsights(root, deps) {
  if (!root) return;
  const { getState, escapeHtml } = deps;
  const data = computeInsights(getState());

  root.innerHTML = "";

  const summary = document.createElement("p");
  summary.className = "insight-summary muted small";
  summary.textContent = data.grandTotal
    ? `${data.grandTotal} tagged occurrence${data.grandTotal === 1 ? "" : "s"} across ${data.taggedSegments} of ${data.totalSegments} segment${data.totalSegments === 1 ? "" : "s"}.`
    : `No RSML tags found yet across ${data.totalSegments} segment${data.totalSegments === 1 ? "" : "s"}.`;
  root.appendChild(summary);

  for (const cat of data.categories) {
    root.appendChild(buildCategoryBlock(cat, escapeHtml));
  }
}
