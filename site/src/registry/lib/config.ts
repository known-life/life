/**
 * Shared genepool constants — the single source of truth for values that would
 * otherwise be retyped across routes and docs. Import from here; never inline a
 * copy.
 */

// How long after publishing a version may be hard-removed (`unpublish`). After
// this, only `deprecate` (which keeps it resolvable for existing locks).
export const UNPUBLISH_WINDOW_HOURS = 72;
export const UNPUBLISH_WINDOW_MS = UNPUBLISH_WINDOW_HOURS * 60 * 60 * 1000;
export const UNPUBLISH_WINDOW_LABEL = `${UNPUBLISH_WINDOW_HOURS}h`;

// Publish payload guards.
export const MAX_PACKAGE_FILES = 256;
export const MAX_PACKAGE_BYTES = 2 * 1024 * 1024;
export const MAX_PACKAGE_LABEL = "256 files / 2MB";
