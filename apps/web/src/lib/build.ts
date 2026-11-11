/**
 * The build this page runs: index.html's `<meta name="compass-build">`,
 * which vite.config.ts fills with VITE_BUILD_SHA (the commit a deploy
 * builds) or else the build's start time. null when the tag is missing or
 * was never filled.
 *
 * Review COREWEB2-22 (2026-11-12): the version check and the saved query
 * cache each read the tag, with different fallbacks. Review COREWEB1-12:
 * Settings → About showed a constant no build defined, so always "dev".
 */
export function runningBuildId(): string | null {
  if (typeof document === 'undefined') return null;
  const v = (document.querySelector('meta[name="compass-build"]') as HTMLMetaElement | null)
    ?.content;
  return v && v !== '%VITE_BUILD_SHA%' ? v : null;
}
