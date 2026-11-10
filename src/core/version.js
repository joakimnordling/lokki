// Which build this is. The builds replace __LOKKI_BUILD__ (scripts/build-info.js); unbundled, in development, there is none.
export const REPO = "https://github.com/joakimnordling/lokki";
/* global __LOKKI_BUILD__ */
export const BUILD =
  typeof __LOKKI_BUILD__ === "object" ? __LOKKI_BUILD__ : { version: "development", commit: "", built: "" };
/** A link to exactly this build's source: its commit, or the repository when unknown. */
export const sourceUrl = () => (BUILD.commit ? `${REPO}/tree/${BUILD.commit}` : REPO);
