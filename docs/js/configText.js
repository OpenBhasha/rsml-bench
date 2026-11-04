// The config block at the end of every RSML file (see srt.js) - plain
// INI-style text, not a cue - and its inverse, so import can read the same
// settings and tag set back in. Writer and parser live side by side so they
// can't drift apart. Pure functions, no DOM, so srt.js stays a plain leaf
// module.
//
//   # BhashaCheck config
//   [versions]
//   bhashacheck = 1.0.1
//   rsml = 3.3.3
//
//   [settings]
//   default_code_mixing_language = en
//
//   [speakers]
//   1 = male, te
//   2 = female, te
//
//   [tags]
//   hesitations = @umm, @uhh
//   disfluencySpans = filler, repetition
//
//   [entities]
//   GPE = Geo Political Entity
//   HON = Honorific
//
//   [languages]
//   hi = Hindi
//   te = Telugu
//
// - `[versions]` says what wrote the file: the BhashaCheck version and the RSML
//   version the tags in it were written under. It is information for whoever
//   reads the file; import does not act on it (and ignores it - see
//   textToConfig()).
// - `[tags]` holds the self-explanatory sets (hesitations, paralinguistics,
//   fillers, prosody...), one `name = a, b, c` line each - no legend needed.
// - Every coded set (entities, languages, dialects, domains, accents) is its
//   own section of `code = description` lines, the legend.
// - Speakers are `id = gender, language-code`: the language that speaker speaks
//   in. `default_code_mixing_language` is the language mixed in within it
//   (e.g. English inside Telugu speech). Both are decoded by `[languages]`.
// Keys are the same category names as the app's own tag-set config. A set
// that's empty is still written (`hesitations =`, or an empty section) so an
// emptied set round-trips as empty rather than as "not mentioned".

export const CONFIG_MARKER = "# BhashaCheck config";
const CONFIG_MARKER_RE = /^# BhashaCheck config[ \t]*$/gm;

// Which category names exist, and whether each is a list of tag names (lives
// under `[tags]`) or a code -> description map (its own section). Parsing only
// accepts categories listed here, so a stray section in a hand-edited file
// can't leak into the project's tag set.
const TAG_SET_KIND = {
  hesitations: "list",
  isolatedParalinguistics: "list",
  isolatedOther: "list",
  disfluencySpans: "list",
  paralinguisticSpans: "list",
  prosodySpans: "list",
  entities: "map",
  languages: "map",
  dialects: "map",
  domains: "map",
  accents: "map",
};

// A description with a newline in it must not become two lines.
function oneLine(s) {
  return String(s).replace(/\s+/g, " ").trim();
}

// `key = value`, with no trailing space when the value is empty.
function kv(key, value) {
  return value ? `${key} = ${value}` : `${key} =`;
}

// ------------------------------------------------------------------ write ----

// config (exportConfig.js's shape) -> array of lines, starting with
// CONFIG_MARKER. Walks whatever tagSets the config holds, so a set added later
// shows up without touching this (it is only read back if it is listed in
// TAG_SET_KIND).
export function configToText(config) {
  const lines = [CONFIG_MARKER];
  if (config.versions) {
    lines.push("[versions]", kv("bhashacheck", config.versions.bhashacheck || ""), kv("rsml", config.versions.rsml || ""), "");
  }
  lines.push("[settings]", kv("default_code_mixing_language", config.defaultCodeMixLanguage || ""), "", "[speakers]");
  for (const sp of config.speakers || []) {
    lines.push(kv(sp.id, [oneLine(sp.gender || "unspecified"), sp.language || ""].filter(Boolean).join(", ")));
  }

  const sets = Object.entries(config.tagSets || {});
  const lists = sets.filter(([, set]) => !set.legend);
  if (lists.length) {
    lines.push("", "[tags]");
    for (const [key, set] of lists) lines.push(kv(key, (set.tags || []).map(oneLine).join(", ")));
  }
  for (const [key, set] of sets) {
    if (!set.legend) continue;
    lines.push("", `[${key}]`);
    for (const [code, description] of Object.entries(set.legend)) lines.push(kv(code, oneLine(description)));
  }
  return lines;
}

// ------------------------------------------------------------------- read ----

// Same character classes rsml itself accepts: a tag / span name is [\w-]+
// (isolated tags usually "@"-prefixed), a code is a single [\w-] token.
// Anything else in a hand-edited file is dropped here rather than handed to
// rsml's add(), which throws on it.
const TAG_NAME_RE = /^@?[\w-]+$/;
const CODE_RE = /^[\w-]+$/;

// Splits a file's text into the part before the config block and the config
// block itself (from the marker line to the end), or configText: null when
// there's no marker. The marker is searched for from the end: the block is
// always last.
export function splitOffConfig(text) {
  let at = -1;
  for (const m of text.matchAll(CONFIG_MARKER_RE)) at = m.index;
  return at === -1 ? { rest: text, configText: null } : { rest: text.slice(0, at), configText: text.slice(at) };
}

// The one gate an imported config goes through (see textToConfig()): anything
// -> exportConfig.js's shape, with only valid, well-formed values left in, or
// null if nothing recognizable remained. It keeps only what the source
// actually states - no `speakers` key if it listed none, a tag set absent from
// `tagSets` if it wasn't mentioned - so importing never blanks out something
// the file simply didn't cover. Only categories in TAG_SET_KIND are accepted,
// and each must have the right shape for its kind (a list of tag names, or a
// code -> description map), so a hand-edited file can't hand rsml something it
// would throw on or mis-store.
function sanitizeConfig(raw) {
  if (!raw || typeof raw !== "object") return null;
  const config = {};
  let found = false;

  if ("defaultCodeMixLanguage" in raw) {
    const lang = typeof raw.defaultCodeMixLanguage === "string" ? raw.defaultCodeMixLanguage.trim() : "";
    config.defaultCodeMixLanguage = lang || null;
    found = true;
  }

  if (Array.isArray(raw.speakers)) {
    const seen = new Set();
    config.speakers = [];
    for (const sp of raw.speakers) {
      if (!sp || !Number.isInteger(sp.id) || sp.id < 1 || seen.has(sp.id)) continue;
      seen.add(sp.id);
      const gender = typeof sp.gender === "string" ? oneLine(sp.gender) : "";
      const lang = typeof sp.language === "string" ? sp.language.trim() : "";
      config.speakers.push({ id: sp.id, gender: gender || "unspecified", language: lang || null });
    }
    found = true;
  }

  if (raw.tagSets && typeof raw.tagSets === "object") {
    const tagSets = {};
    for (const [key, set] of Object.entries(raw.tagSets)) {
      const kind = TAG_SET_KIND[key];
      if (!kind || !set || typeof set !== "object") continue;
      if (kind === "list" && Array.isArray(set.tags)) {
        tagSets[key] = { tags: set.tags.filter((t) => typeof t === "string").map((t) => t.trim()).filter((t) => TAG_NAME_RE.test(t)) };
      } else if (kind === "map" && set.legend && typeof set.legend === "object" && !Array.isArray(set.legend)) {
        const legend = {};
        for (const [code, description] of Object.entries(set.legend)) {
          if (CODE_RE.test(code)) legend[code] = oneLine(description == null ? "" : description) || code;
        }
        tagSets[key] = { legend };
      }
    }
    if (Object.keys(tagSets).length) {
      config.tagSets = tagSets;
      found = true;
    }
  }
  return found ? config : null;
}

// An RSML file's config block (INI-style text) -> the same shape, via
// sanitizeConfig(); null if nothing in it was recognized. This only reads the
// structure; what's valid is sanitizeConfig()'s call.
export function textToConfig(text) {
  const raw = {};
  let section = null;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;

    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      section = header[1].trim();
      if (section === "speakers") {
        raw.speakers = [];
      } else if (TAG_SET_KIND[section] === "map") {
        raw.tagSets = raw.tagSets || {};
        raw.tagSets[section] = { legend: {} };
      }
      continue;
    }

    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();

    // `[versions]` is deliberately not read: it describes what wrote the file
    // (see the header comment), not anything to apply to the project. Falling
    // through it here is what keeps its keys ("bhashacheck", "rsml") from ever
    // being mistaken for a tag set.
    if (section === "versions") continue;

    if (section === "settings") {
      // `default_language` is what files exported before the rename call it.
      if (key === "default_code_mixing_language" || key === "default_language") raw.defaultCodeMixLanguage = value;
    } else if (section === "speakers") {
      if (/^\d+$/.test(key)) {
        const comma = value.indexOf(",");
        raw.speakers.push({
          id: parseInt(key, 10),
          gender: comma === -1 ? value : value.slice(0, comma),
          language: comma === -1 ? "" : value.slice(comma + 1),
        });
      }
    } else if (section === "tags") {
      if (TAG_SET_KIND[key] === "list") {
        raw.tagSets = raw.tagSets || {};
        raw.tagSets[key] = { tags: value.split(",") };
      }
    } else if (raw.tagSets && raw.tagSets[section] && raw.tagSets[section].legend) {
      raw.tagSets[section].legend[key] = value;
    }
  }
  return sanitizeConfig(raw);
}
