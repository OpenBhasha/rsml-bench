// BhashaCheck's own version - semantic versioning (MAJOR.MINOR.PATCH):
//   MAJOR  a change that breaks something people already have: a file format
//          change older files can't be read under, or a saved-project change
//          that needs a migration older versions can't cope with
//   MINOR  new features, backwards compatible
//   PATCH  fixes
// This one constant is the single source. It is shown in the app (header badge
// and Settings -> About) and written into every exported .rsml file's config
// (see exportConfig.js), next to the RSML version (see rsmlLib.js).
//
// The PATCH number is raised automatically: every push to main that changes the
// app is versioned by CI (.github/workflows/deploy-pages.yml running
// scripts/bump-version.sh), which commits the new number right here and tags it
// vMAJOR.MINOR.PATCH. So don't touch the patch number yourself. MINOR and MAJOR
// are yours: set them in this file in your push, and CI keeps your number (and
// tags it) instead of bumping it again.
export const BHASHACHECK_VERSION = "1.0.4";
