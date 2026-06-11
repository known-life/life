/**
 * Gene names for known.life.
 *
 * Names are dotted, lowercase, 1–5 segments — e.g. `secret.auth.proxy`,
 * `sessions`, `markdown.memory`. They're the public, owned address; resolvable
 * by `import:` and `curl`. Flat namespace for v1 (squat risk accepted; scoped
 * `@account/...` reserved for later).
 *
 * Ownership and the right to publish are one thing: the GitHub identity behind
 * the caller's lifekey. There is no separate publish key — see routes/auth.ts.
 */

// 1–5 dot-separated segments, each [a-z0-9] with optional internal hyphens,
// up to 100 chars total.
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*){0,4}$/;

export function isValidName(s: string): boolean {
  return NAME_RE.test(s) && s.length <= 100;
}

// Semver MAJOR.MINOR.PATCH with optional -prerelease. No build metadata for v1.
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[a-z0-9.]+)?$/;

export function isValidVersion(s: string): boolean {
  return VERSION_RE.test(s) && s.length <= 64;
}
