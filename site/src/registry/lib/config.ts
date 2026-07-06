/**
 * Shared genepool constants — the single source of truth for values that would
 * otherwise be retyped across routes and docs. Import from here; never inline a
 * copy.
 */

// Publish payload guards. Not a platform ceiling (R2 blob storage is
// effectively unbounded per file; the D1 manifest row holds only path→sha256,
// not content) — this bounds the synchronous per-request work in one Worker
// invocation: scanFiles() runs ~19 regexes + a Shannon-entropy pass over every
// line of every file (O(total bytes)), and the accept step does one sequential
// R2 head+put per file (O(file count)). checkFit()'s LLM call is separately
// bounded (24KB) regardless of this cap. Raised 2MB/256 → 8MB/1000 on
// 2026-07-06 after a legitimate ~2.4MB/199-file toolkit publish hit the old
// cap and needed manual bisection to fit — that shouldn't be the normal
// publishing experience. 8MB of text is still a small fraction of a Worker's
// CPU-time and subrequest budget; raise again if a real publish outgrows it.
export const MAX_PACKAGE_FILES = 1000;
export const MAX_PACKAGE_BYTES = 8 * 1024 * 1024;
export const MAX_PACKAGE_LABEL = "1000 files / 8MB";
