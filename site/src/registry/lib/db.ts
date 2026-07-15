import type { Env } from "./types";

/**
 * D1 data access for the genepool. Thin typed wrappers over the schema in
 * migrations/0001_init.sql. All write paths go through here so the route
 * handlers stay declarative.
 */

export type VerifiedState = "blessed" | "verified" | "scanned";

export interface Account {
  id: string;
  email: string;
  handle: string | null;
  created_at: number;
  github_id: number | null;
  github_login: string | null;
  github_avatar: string | null;
  display_name: string | null;
  is_admin: number;  // 0 | 1 — D1 has no bool; 1 bypasses the owner check on publish/lifecycle
}

export interface NameRecord {
  name: string;
  owner_account: string;
  created_at: number;
}

export interface PackageRecord {
  name: string;
  owner_account: string;
  summary: string | null;
  latest_version: string | null;
  install_count: number;
  verified_state: VerifiedState;
  created_at: number;
  updated_at: number;
  // npm metadata (migration 0002)
  description: string | null;
  keywords_json: string | null;
  license: string | null;
  homepage: string | null;
  repository: string | null;
  readme: string | null;
  // The successor gene this package was renamed/replaced by, or null if live.
  // Owner-set via /api/supersede; sinks the row in explore and badges it.
  superseded_by: string | null;
}

export interface VersionRecord {
  package: string;
  version: string;
  content_hash: string;
  manifest_json: string;
  contract: string | null;
  requires_json: string | null;
  provides_json: string | null;
  inputs_json: string | null;
  scan_json: string | null;
  fit_json: string | null;
  published_at: number;
  yanked: number;
  yanked_reason: string | null;
  author: string | null;
  description: string | null;
  bytes: number | null;
}

// --- semver ---

/** Compare two semver strings. Returns >0 if a is newer. Prereleases sort
 *  below their release (1.2.0-rc < 1.2.0); invalid strings sort lowest. */
export function compareSemver(a: string, b: string): number {
  const parse = (s: string) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(s);
    if (!m) return null;
    return { nums: [+m[1], +m[2], +m[3]], pre: m[4] ?? null };
  };
  const pa = parse(a), pb = parse(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  for (let i = 0; i < 3; i++) if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] - pb.nums[i];
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === null) return 1;  // release > prerelease
  if (pb.pre === null) return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

/** The highest non-yanked version of a gene, or null if none. This is the
 *  authoritative `latest` — never "the one most recently published". */
export async function highestVersion(env: Env, pkg: string): Promise<string | null> {
  const res = await env.DB.prepare(
    "SELECT version FROM versions WHERE package = ? AND yanked = 0",
  ).bind(pkg).all<{ version: string }>();
  const versions = (res.results ?? []).map((r: { version: string }) => r.version);
  if (!versions.length) return null;
  return versions.reduce((best: string, v: string) => (compareSemver(v, best) > 0 ? v : best));
}

// --- accounts ---

// Deterministic synthetic id for a brand-new account created while the
// (unauthenticated) GitHub users API is unreachable. Negative so it can never
// collide with a real positive GitHub id. ONLY ever used for a fresh INSERT —
// never as a LOOKUP key. (Using it as a lookup key was the publishing outage:
// a rate-limited users API made every /api/auth/prove fall back to this id,
// match a phantom duplicate row, then collide on UNIQUE(handle) → uncaught 500.)
export function syntheticGithubId(login: string): number {
  let h = 0;
  for (const c of login.toLowerCase()) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return -h;
}

/** Find-or-create an account bound to a verified GitHub identity.
 *
 *  Resolves by the PROVEN login/handle FIRST, then by the numeric github_id.
 *  The caller has already proven ownership of `login` (its key is on
 *  github.com/<login>.keys), so the login/handle is the authoritative key.
 *  Resolving by github_id first was the publishing outage: when the
 *  unauthenticated GitHub users API rate-limited the worker, `githubId` arrived
 *  as a synthetic fallback (or null) that matched a phantom duplicate row, and
 *  the subsequent `SET handle = login` collided with the canonical row's
 *  UNIQUE(handle) → an uncaught D1 error → 500 on every publish.
 *
 *  `githubId` may be null (users API unreachable): we never let that wipe a
 *  known id (COALESCE on update) and only synthesise one for a genuinely new
 *  row. Both writes are collision-tolerant — on a UNIQUE conflict (a concurrent
 *  writer, or a lingering duplicate) we adopt the canonical row rather than 500. */
export async function getOrCreateGithubAccount(
  env: Env,
  gh: { githubId: number | null; login: string; avatar: string | null; name: string | null },
): Promise<Account> {
  const now = Date.now();
  const byLogin = await env.DB.prepare("SELECT * FROM accounts WHERE github_login = ? OR handle = ?")
    .bind(gh.login, gh.login)
    .first<Account>();
  const prior = byLogin
    ?? (gh.githubId != null
      ? await env.DB.prepare("SELECT * FROM accounts WHERE github_id = ?").bind(gh.githubId).first<Account>()
      : null);
  if (prior) {
    try {
      await env.DB.prepare(
        `UPDATE accounts SET github_id = COALESCE(?, github_id), github_login = ?, handle = ?,
           github_avatar = ?, display_name = COALESCE(?, display_name) WHERE id = ?`,
      ).bind(gh.githubId, gh.login, gh.login, gh.avatar, gh.name, prior.id).run();
    } catch {
      const canonical = await env.DB.prepare("SELECT * FROM accounts WHERE github_login = ? OR handle = ?")
        .bind(gh.login, gh.login).first<Account>();
      if (canonical) return canonical;
      throw new Error("account upsert conflict with no resolvable canonical row");
    }
    return { ...prior, github_id: gh.githubId ?? prior.github_id, github_login: gh.login, handle: gh.login, github_avatar: gh.avatar };
  }
  const id = crypto.randomUUID();
  const ghId = gh.githubId ?? syntheticGithubId(gh.login);
  // Synthetic email keeps the UNIQUE(email) contract while GitHub is the real identity.
  const email = `github:${ghId}`;
  try {
    await env.DB.prepare(
      `INSERT INTO accounts (id, email, handle, created_at, github_id, github_login, github_avatar, display_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, email, gh.login, now, ghId, gh.login, gh.avatar, gh.name).run();
  } catch {
    const canonical = await env.DB.prepare("SELECT * FROM accounts WHERE github_login = ? OR handle = ?")
      .bind(gh.login, gh.login).first<Account>();
    if (canonical) return canonical;
    throw new Error("account insert conflict with no resolvable canonical row");
  }
  return { id, email, handle: gh.login, created_at: now, github_id: ghId, github_login: gh.login, github_avatar: gh.avatar, display_name: gh.name, is_admin: 0 };
}

export async function getAccountByHandle(env: Env, handle: string): Promise<Account | null> {
  return env.DB.prepare("SELECT * FROM accounts WHERE handle = ? OR github_login = ?")
    .bind(handle, handle)
    .first<Account>();
}

export async function getAccountById(env: Env, id: string): Promise<Account | null> {
  return env.DB.prepare("SELECT * FROM accounts WHERE id = ?").bind(id).first<Account>();
}

/** Resolve an account from a JWT subject. Tokens carry a `github:<login>`
 *  subject — git identity is the only identity. Anything else resolves to null. */
export async function resolveAccountFromSubject(env: Env, subject: string): Promise<Account | null> {
  if (!subject.startsWith("github:")) return null;
  const login = subject.slice("github:".length);
  return env.DB.prepare("SELECT * FROM accounts WHERE github_login = ?").bind(login).first<Account>();
}

// --- names (ownership + publish credential) ---

export async function getName(env: Env, name: string): Promise<NameRecord | null> {
  return env.DB.prepare("SELECT * FROM names WHERE name = ?").bind(name).first<NameRecord>();
}

export async function claimName(
  env: Env,
  name: string,
  account: Account,
): Promise<void> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO names (name, owner_account, created_at) VALUES (?, ?, ?)",
    ).bind(name, account.id, now),
    env.DB.prepare(
      `INSERT INTO packages (name, owner_account, summary, latest_version, install_count,
         verified_state, created_at, updated_at)
       VALUES (?, ?, NULL, NULL, 0, 'scanned', ?, ?)`,
    ).bind(name, account.id, now, now),
  ]);
}

// Hard-delete a name and everything attached to it (versions, install counts,
// dep edges, package row, the name itself). R2 content blobs are NOT deleted —
// they're content-addressed and may be shared across genes. Caller must
// gate on the package having no live `latest_version` (refuse otherwise) and
// admin-only auth — see routes/lifecycle.ts. There's deliberately no soft
// "release name back to the commons" path: the immutability invariant means
// that once released-and-reclaimed, the (name, oldVer) collision check is
// gone, so a wipe is cleaner than a release.
export async function wipeName(env: Env, name: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM deps WHERE package = ?").bind(name),
    env.DB.prepare("DELETE FROM install_lives WHERE package = ?").bind(name),
    // embeddings.package REFERENCES packages(name) — must go before the package
    // row or the FK constraint fails the whole batch (the wipe 500 a delete of
    // a searched-and-cached gene hit).
    env.DB.prepare("DELETE FROM embeddings WHERE package = ?").bind(name),
    env.DB.prepare("DELETE FROM versions WHERE package = ?").bind(name),
    env.DB.prepare("DELETE FROM packages WHERE name = ?").bind(name),
    env.DB.prepare("DELETE FROM names WHERE name = ?").bind(name),
  ]);
}

// --- maintainers (account-level publish delegation) ---

/** True if `login` is a maintainer the owner has delegated to. A null login
 *  (an account with no resolved GitHub handle) is never a maintainer. */
export async function isMaintainer(env: Env, ownerAccount: string, login: string | null): Promise<boolean> {
  if (!login) return false;
  const row = await env.DB.prepare(
    "SELECT 1 FROM maintainers WHERE owner_account = ? AND maintainer_login = ?",
  ).bind(ownerAccount, login).first();
  return !!row;
}

/** The authority check behind every publish/lifecycle write: may `account`
 *  manage a name owned by `ownerAccount`? True for the owner of record, any
 *  admin (the global bypass), or a login the owner delegated to via
 *  /api/maintainers. The single chokepoint so publish, deprecate and unpublish
 *  share one definition of "can write this gene". `wipe` deliberately does NOT
 *  use this — it keeps its own explicit admin-only gate. */
export async function canManageName(env: Env, ownerAccount: string, account: Account): Promise<boolean> {
  if (ownerAccount === account.id) return true;
  if (account.is_admin) return true;
  return isMaintainer(env, ownerAccount, account.github_login);
}

/** Grant `login` publish rights over every name `ownerAccount` holds.
 *  Idempotent — re-granting an existing maintainer is a no-op. */
export async function addMaintainer(env: Env, ownerAccount: string, login: string): Promise<void> {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO maintainers (owner_account, maintainer_login, created_at) VALUES (?, ?, ?)",
  ).bind(ownerAccount, login, Date.now()).run();
}

/** Revoke a previously-granted maintainer. Idempotent. */
export async function removeMaintainer(env: Env, ownerAccount: string, login: string): Promise<void> {
  await env.DB.prepare(
    "DELETE FROM maintainers WHERE owner_account = ? AND maintainer_login = ?",
  ).bind(ownerAccount, login).run();
}

/** The logins this owner has delegated publish rights to. */
export async function listMaintainers(env: Env, ownerAccount: string): Promise<string[]> {
  const res = await env.DB.prepare(
    "SELECT maintainer_login FROM maintainers WHERE owner_account = ? ORDER BY maintainer_login",
  ).bind(ownerAccount).all<{ maintainer_login: string }>();
  return (res.results ?? []).map((r) => r.maintainer_login);
}

// --- packages ---

export async function getPackage(env: Env, name: string): Promise<PackageRecord | null> {
  return env.DB.prepare("SELECT * FROM packages WHERE name = ?").bind(name).first<PackageRecord>();
}

export async function listPackagesByOwner(env: Env, accountId: string): Promise<PackageRecord[]> {
  const res = await env.DB.prepare("SELECT * FROM packages WHERE owner_account = ? ORDER BY name")
    .bind(accountId)
    .all<PackageRecord>();
  return res.results ?? [];
}

export async function topPackages(env: Env, limit = 100, offset = 0): Promise<PackageRecord[]> {
  // Live genes first, superseded ones sunk to the bottom; each tier still
  // install-ranked. So a legacy gene with more historical installs (book-of-life
  // @9) no longer outranks its live successor (life-guide @3).
  const res = await env.DB.prepare(
    "SELECT * FROM packages WHERE latest_version IS NOT NULL ORDER BY (superseded_by IS NOT NULL) ASC, install_count DESC LIMIT ? OFFSET ?",
  )
    .bind(limit, offset)
    .all<PackageRecord>();
  return res.results ?? [];
}

/** Set or clear a package's successor pointer. `successor = null` clears it
 *  (a gene un-retired). The owner/auth check lives in the route. */
export async function setSuperseded(env: Env, name: string, successor: string | null): Promise<void> {
  await env.DB.prepare("UPDATE packages SET superseded_by = ?, updated_at = ? WHERE name = ?")
    .bind(successor, Date.now(), name)
    .run();
}

export async function countLivePackages(env: Env): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) as n FROM packages WHERE latest_version IS NOT NULL",
  ).first<{ n: number }>();
  return row?.n ?? 0;
}

// Search matches name, summary, keywords AND capabilities (the latest version's
// provides/requires) — so "find a gene that provides X" actually works, which
// is how agents compose by capability. Joins each package to its latest cut.
export async function searchPackages(env: Env, q: string, limit = 50): Promise<PackageRecord[]> {
  const like = `%${q.toLowerCase()}%`;
  // Rank by relevance, then installs: a name match (the agent typed the gene)
  // beats a keyword/capability match, which beats an incidental summary mention.
  // Without this, install_count alone surfaces popular genes whose summary
  // happens to contain the term (e.g. `laws` for "memory") above the actual
  // name match (`markdown-memory`).
  const res = await env.DB.prepare(
    `SELECT p.* FROM packages p
     JOIN versions v ON v.package = p.name AND v.version = p.latest_version
     WHERE p.latest_version IS NOT NULL
       AND (lower(p.name) LIKE ? OR lower(p.summary) LIKE ? OR lower(p.keywords_json) LIKE ?
            OR lower(v.provides_json) LIKE ? OR lower(v.requires_json) LIKE ?)
     ORDER BY
       (CASE WHEN lower(p.name) LIKE ? THEN 3
             WHEN (lower(p.keywords_json) LIKE ? OR lower(v.provides_json) LIKE ?) THEN 2
             ELSE 1 END) DESC,
       p.install_count DESC
     LIMIT ?`,
  )
    .bind(like, like, like, like, like, like, like, like, limit)
    .all<PackageRecord>();
  return res.results ?? [];
}

// Reverse capability lookup: the gene(s) whose LATEST (non-yanked) version
// provides the given capability, ranked by installs. This is what lets the
// engine resolve a `requires: <ns>.<x>` to the gene that actually PROVIDES
// it — instead of guessing the gene name from the capability's namespace,
// which breaks whenever they differ (e.g. `identity.lifekey` is provided by the
// `lifekey` gene, not a gene called `identity`). Matches the quoted cap
// inside the JSON array so `identity.lifekey` can't prefix-collide.
export async function providersOf(env: Env, cap: string): Promise<{ name: string; version: string }[]> {
  const res = await env.DB.prepare(
    `SELECT p.name AS name, p.latest_version AS version
     FROM packages p JOIN versions v ON v.package = p.name AND v.version = p.latest_version
     WHERE p.latest_version IS NOT NULL AND v.yanked = 0 AND v.provides_json LIKE ?
     ORDER BY p.install_count DESC`,
  )
    .bind(`%"${cap}"%`)
    .all<{ name: string; version: string }>();
  return res.results ?? [];
}

export async function bumpInstall(env: Env, name: string, version: string, lifeId?: string | null): Promise<void> {
  // install_lives is the single source of truth: one row per distinct
  // (package, version, life). The headline install_count is COUNT(DISTINCT life)
  // for the package; the per-version download column is COUNT(*) per
  // (package, version). Both measure distinct LIVES, never resolve events — so
  // an ephemeral cold boot re-resolving the same floats inflates neither.
  // No life id (older engine) → record nothing, rather than count blind.
  if (!lifeId) return;
  const r = await env.DB.prepare(
    `INSERT OR IGNORE INTO install_lives (package, version, life_id, first_at) VALUES (?, ?, ?, ?)`,
  ).bind(name, version, lifeId, Date.now()).run();
  if (r.meta?.changes) {
    await env.DB.prepare(
      `UPDATE packages SET install_count = (SELECT COUNT(DISTINCT life_id) FROM install_lives WHERE package = ?) WHERE name = ?`,
    ).bind(name, name).run();
  }
}


/** Reconcile a single life's adoption rows against the set it CURRENTLY holds.
 *  install_lives is written on adoption (resolve ?reason=install) but never on
 *  shed — a life that `life shed`s a gene stops resolving it, so the registry
 *  never hears and the row lingers, holding install_count above zero forever.
 *  That stale count is exactly what wedges an owner's `--withdraw`
 *  (handleUnpublish's in_use guard) long after the last real consumer let go.
 *  The engine reports this life's currently-held known.life pins; we drop every
 *  row for the life that isn't in that set and recompute the affected packages'
 *  install_count. Deletes only ever shrink THIS life's own rows — never another
 *  life's, and never the deps graph the withdraw guard also honours. Returns the
 *  number of rows removed. */
export async function reconcileLifeInstalls(
  env: Env,
  lifeId: string,
  held: { package: string; version: string }[],
): Promise<{ removed: number }> {
  if (!lifeId) return { removed: 0 };
  const before = await env.DB.prepare(
    "SELECT package, version FROM install_lives WHERE life_id = ?",
  ).bind(lifeId).all<{ package: string; version: string }>();
  const rows = before.results ?? [];
  if (!rows.length) return { removed: 0 };
  const heldSet = new Set(held.map((h) => `${h.package} ${h.version}`));
  const stale = rows.filter((r) => !heldSet.has(`${r.package} ${r.version}`));
  if (!stale.length) return { removed: 0 };
  const affected = [...new Set(stale.map((r) => r.package))];
  const stmts: D1PreparedStatement[] = stale.map((r) =>
    env.DB.prepare(
      "DELETE FROM install_lives WHERE life_id = ? AND package = ? AND version = ?",
    ).bind(lifeId, r.package, r.version),
  );
  for (const pkg of affected) {
    stmts.push(
      env.DB.prepare(
        "UPDATE packages SET install_count = (SELECT COUNT(DISTINCT life_id) FROM install_lives WHERE package = ?) WHERE name = ?",
      ).bind(pkg, pkg),
    );
  }
  await env.DB.batch(stmts);
  return { removed: stale.length };
}

// --- versions ---

export async function getVersion(
  env: Env,
  pkg: string,
  version: string,
): Promise<VersionRecord | null> {
  return env.DB.prepare("SELECT * FROM versions WHERE package = ? AND version = ?")
    .bind(pkg, version)
    .first<VersionRecord>();
}

export async function listVersions(env: Env, pkg: string): Promise<VersionRecord[]> {
  const res = await env.DB.prepare(
    "SELECT * FROM versions WHERE package = ? ORDER BY published_at DESC",
  )
    .bind(pkg)
    .all<VersionRecord>();
  return res.results ?? [];
}

export interface InsertVersionInput {
  package: string;
  version: string;
  content_hash: string;
  manifest: Record<string, string>;
  contract: string | null;
  requires: string[];
  provides: string[];
  imports: string[];
  inputs: string[];
  scan_json: string;
  fit_json: string;
  summary: string | null;
  // npm metadata
  description: string | null;
  author: string | null;
  license: string | null;
  homepage: string | null;
  repository: string | null;
  keywords: string[];
  readme: string | null;
  bytes: number;
}

/** Parse an `imports:` entry into a dependency edge. `known.life/<name>[@range]`
 *  → the bare name (so `dependentsOf` resolves); a github source → its ref-less
 *  form; a local path → no edge. */
function parseImport(source: string): { depName: string | null; depRange: string } {
  if (source.startsWith("./") || source.startsWith("../") || source.startsWith("/"))
    return { depName: null, depRange: "*" };
  const kl = source.match(/^known\.life\/([a-z0-9.-]+)(?:@(.+))?$/);
  if (kl) return { depName: kl[1], depRange: kl[2] || "*" };
  const gh = source.match(/^(github\.com\/.+?)(?:@(.+))?$/);
  if (gh) return { depName: gh[1], depRange: gh[2] || "*" };
  return { depName: source || null, depRange: "*" };
}

/** Cut an immutable version: write the version row, its deps, metadata, advance
 *  latest. `latest` is the highest semver among non-yanked versions — so a
 *  backport patch to an old line never drags `latest` backwards. */
export async function insertVersion(env: Env, v: InsertVersionInput): Promise<void> {
  const now = Date.now();
  const prevLatest = await highestVersion(env, v.package);
  const latest = !prevLatest || compareSemver(v.version, prevLatest) > 0 ? v.version : prevLatest;
  const stmts: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO versions (package, version, content_hash, manifest_json, contract,
         requires_json, provides_json, inputs_json, scan_json, fit_json, published_at, yanked,
         author, description, bytes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    ).bind(
      v.package,
      v.version,
      v.content_hash,
      JSON.stringify(v.manifest),
      v.contract,
      JSON.stringify(v.requires),
      JSON.stringify(v.provides),
      JSON.stringify(v.inputs),
      v.scan_json,
      v.fit_json,
      now,
      v.author,
      v.description,
      v.bytes,
    ),
    // Package-level metadata reflects the LATEST version (npm behaviour). When
    // this cut isn't the latest (a backport to an old line), only the version
    // row is added — the package's summary/readme/latest_version stay put.
    latest === v.version
      ? env.DB.prepare(
          `UPDATE packages SET latest_version = ?, summary = COALESCE(?, summary),
             description = COALESCE(?, description), keywords_json = ?, license = COALESCE(?, license),
             homepage = COALESCE(?, homepage), repository = COALESCE(?, repository),
             readme = COALESCE(?, readme), updated_at = ? WHERE name = ?`,
        ).bind(
          latest, v.summary, v.description, JSON.stringify(v.keywords), v.license,
          v.homepage, v.repository, v.readme, now, v.package,
        )
      : env.DB.prepare(
          "UPDATE packages SET updated_at = ? WHERE name = ?",
        ).bind(now, v.package),
  ];
  // The gene network is built from `imports` (real gene deps), NOT from
  // `requires` (capabilities). An import is `known.life/<name>[@<range>]` or a
  // github source; dep_name is the bare gene name so `dependentsOf` resolves.
  for (const imp of v.imports) {
    const { depName, depRange } = parseImport(imp);
    if (!depName) continue;
    stmts.push(
      env.DB.prepare(
        "INSERT OR REPLACE INTO deps (package, version, dep_name, dep_range) VALUES (?, ?, ?, ?)",
      ).bind(v.package, v.version, depName, depRange),
    );
  }
  await env.DB.batch(stmts);
}

export async function deprecateVersion(
  env: Env,
  pkg: string,
  version: string,
  reason?: string | null,
): Promise<void> {
  // Kept under the column name `yanked`; surfaced as "deprecated". The reason
  // travels with the version: resolve serves it, the engine prints it when a
  // yanked pin installs, and the MVS flip's yank-on-new-selection error will
  // carry it (bzlmod's error-with-reason model — the agent-legible failure).
  await env.DB.prepare("UPDATE versions SET yanked = 1, yanked_reason = ? WHERE package = ? AND version = ?")
    .bind(reason ?? null, pkg, version)
    .run();
  // Best-effort purge of the resolve edge cache so the yanked flag propagates
  // fast in this colo; the Cache API can't reach other colos, so the resolve
  // route's RESOLVE_EDGE_TTL is the real ceiling on flag staleness.
  try { await (caches as unknown as { default: Cache }).default.delete(new Request(`https://known.life/api/resolve/${pkg}/${version}`)); } catch { /* advisory */ }
  // If the deprecated cut was `latest`, drop back to the highest non-yanked one
  // so consumers resolving `latest` skip a deprecated version.
  const latest = await highestVersion(env, pkg);
  await env.DB.prepare("UPDATE packages SET latest_version = ?, updated_at = ? WHERE name = ?")
    .bind(latest, Date.now(), pkg)
    .run();
}

/** Hard-remove a version within the safety window. If it was the only/latest
 *  version, repoint latest to the newest remaining (or null the package). */
export async function unpublishVersion(env: Env, pkg: string, version: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM versions WHERE package = ? AND version = ?").bind(pkg, version),
    env.DB.prepare("DELETE FROM deps WHERE package = ? AND version = ?").bind(pkg, version),
    env.DB.prepare("DELETE FROM install_lives WHERE package = ? AND version = ?").bind(pkg, version),
  ]);
  const remaining = await highestVersion(env, pkg);
  await env.DB.prepare("UPDATE packages SET latest_version = ?, updated_at = ? WHERE name = ?")
    .bind(remaining, Date.now(), pkg)
    .run();
}

/** Distinct lives per version, for the page's per-version download column.
 *  PK(package, version, life_id) makes COUNT(*) per version the distinct-life
 *  count — consistent with the headline install_count. */
export async function downloadsByVersion(env: Env, pkg: string): Promise<Record<string, number>> {
  const res = await env.DB.prepare(
    "SELECT version, COUNT(*) AS total FROM install_lives WHERE package = ? GROUP BY version",
  ).bind(pkg).all<{ version: string; total: number }>();
  const out: Record<string, number> = {};
  for (const r of res.results ?? []) out[r.version] = r.total;
  return out;
}

export async function dependentsOf(env: Env, name: string): Promise<string[]> {
  const res = await env.DB.prepare("SELECT DISTINCT package FROM deps WHERE dep_name = ?")
    .bind(name)
    .all<{ package: string }>();
  return (res.results ?? []).map((r) => r.package);
}
