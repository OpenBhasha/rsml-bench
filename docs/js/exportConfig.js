// Builds the "config" an RSML export carries (configText.js renders it as the
// file's config block, and reads it back on import): the project's settings
// plus the complete, *effective* tag set, so the file is readable on its own
// without this app (or this project's Settings drawer) to decode it.
//
// "Effective" matters: state.rsmlConfig is null until someone customizes
// Settings -> RSML tags, and even afterwards a category can be missing from
// it - the library's built-in defaults (GPE = "Geo Political Entity", every
// default language, ...) only exist inside rsml itself. So this resolves the
// tag set the same way editor.js does when it builds a segment's annotator -
// a hidden RSMLAnnotator constructed with `...state.rsmlConfig` - and reads
// the result back off its .opts, rather than trusting whatever state happens
// to hold.
//
// Two shapes of tag set come out of that:
//   - self-explanatory ones (hesitations, paralinguistic sounds, fillers, ...)
//     are just `{ tags: [...] }` - the name says what it is, no legend needed;
//   - anything written as a code or id (entities, languages, dialects,
//     domains, accents) is `{ legend: { code: description } }`, since "GPE" or
//     "hi" means nothing without it.
//
// The same rsml library every other module uses (see rsmlLib.js).
import RSMLAnnotator, { RSML_VERSION } from "./rsmlLib.js";
import { BHASHACHECK_VERSION } from "./version.js";

// Same set rsmlSettings.js skips when it discovers vocabulary categories from
// a live annotator's .opts - everything else there is a tag set, so a future
// library version adding one is exported automatically.
const NON_VOCAB_KEYS = new Set(["textarea", "output", "tags", "demoText", "disableCodeMirror"]);

// One tag set -> its exported form. Lists stay lists; code -> label maps become
// a sorted legend (same order the Settings panel shows them in). A blank
// description falls back to the code itself, mirroring what rsml's own add()
// does for entities/languages/dialects/domains - accents are the one map that
// can otherwise end up with an empty name.
function describeTagSet(value) {
  if (Array.isArray(value)) return { tags: value.slice() };
  const legend = {};
  for (const code of Object.keys(value).sort()) legend[code] = value[code] || code;
  return { legend };
}

function resolveRsmlTagSets(rsmlConfig) {
  const ta = document.createElement("textarea");
  const out = document.createElement("div");
  ta.hidden = true;
  out.hidden = true;
  document.body.append(ta, out);
  const annotator = new RSMLAnnotator({ textarea: ta, output: out, disableCodeMirror: true, ...(rsmlConfig || {}) });
  try {
    const tagSets = {};
    for (const key of Object.keys(annotator.opts)) {
      if (NON_VOCAB_KEYS.has(key)) continue;
      tagSets[key] = describeTagSet(annotator.opts[key]);
    }
    return tagSets;
  } finally {
    annotator.destroy();
    ta.remove();
    out.remove();
  }
}

// { versions, defaultCodeMixLanguage, speakers, tagSets } - plain data, no
// references back into `state`. `versions` says what wrote the file: the
// BhashaCheck version (version.js) and the RSML version (rsmlLib.js) the tags in
// it were written under, so a reader - a person, or a pipeline like the
// aligner - can tell which rules apply to it. Each speaker's `language` (the language they speak in) and
// defaultCodeMixLanguage (the language mixed in within it) are language codes,
// decoded by tagSets.languages.legend.
export function buildExportConfig(state) {
  return {
    versions: { bhashacheck: BHASHACHECK_VERSION, rsml: RSML_VERSION },
    defaultCodeMixLanguage: state.defaultCodeMixLanguage || null,
    speakers: (state.speakers || []).map((sp) => ({ id: sp.id, gender: sp.gender, language: sp.language || null })),
    tagSets: {
      ...resolveRsmlTagSets(state.rsmlConfig),
      // rsml has no accents category at all (see rsmlSettings.js's header
      // comment), so these come from state.accents, not an annotator.
      accents: describeTagSet(state.accents || {}),
    },
  };
}
