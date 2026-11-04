// Math in the preview panes: $...$ (inline) and $$...$$ inside the (normalized)
// part of a tag - [verbatim]($x^2$) - are rendered with MathJax. The library
// itself (and its $-delimiter config) is loaded by plain <script> tags in
// index.html; this module is the glue between it and the rsml preview.
//
// Only the (normalized) slot is typeset. RSML keeps special characters there
// and nowhere else, and `$` is also RSML syntax ($en[text](norm) is an accent,
// $$TG[text](norm) a dialect), so prose and the [verbatim] slot are left alone.
//
// Why it isn't just "typeset the page":
//   - rsml rebuilds a preview pane's HTML from scratch on every edit, which
//     throws away whatever MathJax drew. So each render has to be followed by a
//     fresh typeset of that pane (see watchMath()).
//   - Each normalized slot is typeset on its own, so an expression can never
//     reach across two neighbouring tags.

const MATH_SPANS = ".rsml-normalized";

// MathJax's loader script (index.html) and its readiness, resolved once. Never
// rejects: if the CDN can't be reached it resolves to null and every call below
// quietly does nothing - the preview just shows the raw $...$ text.
let ready = null;
function mathJax() {
  if (ready) return ready;
  ready = new Promise((resolve) => {
    const settle = () => {
      const mj = window.MathJax;
      if (mj && mj.startup && mj.startup.promise) {
        mj.startup.promise.then(() => resolve(mj), (err) => {
          console.warn("[math] MathJax failed to start:", (err && err.message) || err);
          resolve(null);
        });
        return true;
      }
      return false;
    };
    if (settle()) return;
    // The loader tag flags a failure itself (onerror in index.html), since the
    // script can fail before this module has even run to hear about it.
    const script = document.getElementById("mathjax-script");
    if (!script || window.mathJaxFailed) return resolve(null);
    script.addEventListener("load", () => settle() || resolve(null));
    script.addEventListener("error", () => {
      console.warn("[math] could not load MathJax; $...$ will show as plain text");
      resolve(null);
    });
  });
  return ready;
}

// MathJax must typeset one batch at a time.
let queue = Promise.resolve();

// Typeset every $...$ / $$...$$ in a preview pane (call it right after rsml has
// rendered into it). Fire-and-forget; spans with no `$` in them never reach
// MathJax at all, so a pane without math costs one querySelectorAll.
export function typesetMath(pane) {
  if (!pane) return;
  const spans = [...pane.querySelectorAll(MATH_SPANS)].filter((el) => el.textContent.includes("$"));
  if (!spans.length) return;
  queue = queue
    .then(mathJax)
    .then((mj) => {
      if (!mj) return;
      // The pane may have been re-rendered (or its row torn down) while this
      // waited its turn; those spans are gone and the newer render queued its
      // own typeset.
      const live = spans.filter((el) => el.isConnected);
      if (live.length) return mj.typesetPromise(live);
    })
    .catch((err) => console.warn("[math] typeset failed:", (err && err.message) || err));
}

// Tell MathJax a pane is about to be thrown away (rsml re-render, or a row
// collapsing). Without this it keeps a reference to every math expression it
// ever drew - detached DOM and all - for the life of the page.
export function clearMath(pane) {
  const mj = window.MathJax;
  if (!pane || !mj || typeof mj.typesetClear !== "function") return;
  try {
    mj.typesetClear([pane]);
  } catch (err) {
    console.warn("[math] typesetClear failed:", (err && err.message) || err);
  }
}

// Keeps an rsml annotator's preview pane typeset: shadows its _render() (the
// same instance-level patch editor.js uses for _cmComplete / _updateStatus) so
// every re-render is followed by a typeset, and does the first one now - the
// constructor's own initial render ran before this patch could exist.
export function watchMath(annotator) {
  if (!annotator || annotator.__mathPatched || typeof annotator._render !== "function") return;
  annotator.__mathPatched = true;
  const original = annotator._render.bind(annotator);
  annotator._render = () => {
    clearMath(annotator.output);
    original();
    typesetMath(annotator.output);
  };
  typesetMath(annotator.output);
}
