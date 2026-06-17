/**
 * Shared genepool constants — the single source of truth for values that would
 * otherwise be retyped across routes and docs. Import from here; never inline a
 * copy.
 */

// Publish payload guards.
export const MAX_PACKAGE_FILES = 256;
export const MAX_PACKAGE_BYTES = 2 * 1024 * 1024;
export const MAX_PACKAGE_LABEL = "256 files / 2MB";
