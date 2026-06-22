-- known.life registry schema — the single, idempotent source of truth.
--
-- The engine's Cloudflare infra adapter applies this on every `life deploy`
-- (it splits on `;` and runs each statement), so every statement is written
-- IF NOT EXISTS and the former 0002 ALTER columns are folded into the CREATEs.
-- Re-applying on a populated DB is a no-op.
--
-- accounts  — a human/agent identity (a GitHub login). Owns names.
-- names     — a claimed package name, owned by an account. Ownership IS the
--             right to publish: there is no separate publish key.
-- maintainers — account-level delegation: a login the owner trusts to publish
--             ANY name that owner holds (existing + future). Co-maintainership
--             without per-gene bookkeeping.
-- packages  — the public package record: latest version, install count, badge, npm metadata.
-- versions  — immutable cut versions; manifest + scan/fit + per-version metadata.
-- installs  — per-day install counts, rolled up for rankings.
-- deps      — the dependency graph (a version's requires/imports edges).

CREATE TABLE IF NOT EXISTS accounts (
  id            TEXT PRIMARY KEY,        -- uuid
  email         TEXT NOT NULL UNIQUE,    -- real, or synthetic `github:<id>` for GitHub-identity accounts
  handle        TEXT UNIQUE,             -- publisher profile slug; nullable until set
  display_name  TEXT,                    -- npm shows a person, not just an email
  github_id     INTEGER,                 -- stable GitHub user id (a login can be renamed; the id can't)
  github_login  TEXT,                    -- @handle (may change)
  github_avatar TEXT,                    -- avatar_url for the profile
  is_admin      INTEGER NOT NULL DEFAULT 0,  -- 1 → bypasses the owner check on publish/lifecycle
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_accounts_github_id ON accounts(github_id);
CREATE INDEX IF NOT EXISTS idx_accounts_github_login ON accounts(github_login);

CREATE TABLE IF NOT EXISTS names (
  name           TEXT PRIMARY KEY,
  owner_account  TEXT NOT NULL REFERENCES accounts(id),
  created_at     INTEGER NOT NULL
);

-- maintainers — account-level publish delegation. A row (owner_account,
-- maintainer_login) means the GitHub login `maintainer_login` may publish /
-- deprecate / unpublish EVERY name owned by `owner_account`, present and future
-- — the same authority as the owner, minus the admin-only `wipe`. Keyed on the
-- maintainer's LOGIN (not an account id) so a grant can be made before that
-- login has ever signed in, and survives the account being created lazily on
-- first auth. The owner manages their own set via /api/maintainers.
CREATE TABLE IF NOT EXISTS maintainers (
  owner_account     TEXT NOT NULL REFERENCES accounts(id),
  maintainer_login  TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  PRIMARY KEY (owner_account, maintainer_login)
);
CREATE INDEX IF NOT EXISTS idx_maintainers_login ON maintainers(maintainer_login);

CREATE TABLE IF NOT EXISTS packages (
  name            TEXT PRIMARY KEY REFERENCES names(name),
  owner_account   TEXT NOT NULL REFERENCES accounts(id),
  summary         TEXT,
  latest_version  TEXT,
  install_count   INTEGER NOT NULL DEFAULT 0,
  verified_state  TEXT NOT NULL DEFAULT 'scanned',  -- blessed | verified | scanned
  description     TEXT,                 -- longer than summary; the package pitch
  keywords_json   TEXT,                 -- string[] for search/browse
  license         TEXT,                 -- SPDX id, e.g. MIT
  homepage        TEXT,                 -- project URL
  repository      TEXT,                 -- source repo URL
  readme          TEXT,                 -- README.md of the latest version
  superseded_by   TEXT,                 -- a successor gene name: this package is renamed/replaced by it. Owner-set via /api/supersede; sinks the row in explore + badges it. NULL = live.
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS versions (
  package        TEXT NOT NULL REFERENCES packages(name),
  version        TEXT NOT NULL,
  content_hash   TEXT NOT NULL,        -- manifestHash; what .life.lock pins
  manifest_json  TEXT NOT NULL,        -- { path: blob_sha }
  contract       TEXT,                 -- the .life manifest body / summary
  requires_json  TEXT,                 -- string[]
  provides_json  TEXT,                 -- string[]
  inputs_json    TEXT,                 -- string[]
  scan_json      TEXT,                 -- ScanResult
  fit_json       TEXT,                 -- FitResult (advisory)
  author         TEXT,                 -- display author for this version
  description    TEXT,                 -- description as of this version
  bytes          INTEGER,              -- unpacked size, for the page
  published_at   INTEGER NOT NULL,
  yanked         INTEGER NOT NULL DEFAULT 0,
  yanked_reason  TEXT,                 -- why it was deprecated; served on resolve
  PRIMARY KEY (package, version)
);

-- install_lives — the single source of truth for adoption: one row per
-- distinct (package, version, life). The headline install_count is
-- COUNT(DISTINCT life) per package; the per-version download column is COUNT(*)
-- per (package, version). Both measure distinct LIVES, never resolve events, so
-- an ephemeral cold boot re-resolving the same floats inflates neither. life_id
-- is an opaque hash the engine sends; no repo identity is stored. (Replaced the
-- old per-day `installs` tally, which counted raw resolves.)
CREATE TABLE IF NOT EXISTS install_lives (
  package   TEXT NOT NULL,
  version   TEXT NOT NULL,
  life_id   TEXT NOT NULL,
  first_at  INTEGER NOT NULL,
  PRIMARY KEY (package, version, life_id)
);

CREATE TABLE IF NOT EXISTS deps (
  package    TEXT NOT NULL,
  version    TEXT NOT NULL,
  dep_name   TEXT NOT NULL,
  dep_range  TEXT NOT NULL,
  PRIMARY KEY (package, version, dep_name)
);

CREATE INDEX IF NOT EXISTS idx_packages_installs ON packages(install_count DESC);
CREATE INDEX IF NOT EXISTS idx_versions_package ON versions(package, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_deps_depname ON deps(dep_name);

-- migration (idempotent via the adapter's duplicate-column skip):
ALTER TABLE versions ADD COLUMN yanked_reason TEXT;
ALTER TABLE packages ADD COLUMN superseded_by TEXT;

-- auth_challenge — outstanding lifekey sign-in nonces (routes/auth.ts). ONE ROW
-- PER CHALLENGE, keyed by the nonce itself — NOT a single per-login slot. The
-- former KV slot `authchallenge:<login>` was last-write-wins, so two concurrent
-- mints as the same login (e.g. the deploy's `auto` + `hook-think` jobs) clobbered
-- each other's nonce and one/both proves failed. D1 is strongly consistent and
-- holds N rows, so concurrent challenges never collide. Ephemeral (5-min TTL,
-- swept opportunistically on each challenge); a matched nonce is deleted on a
-- successful prove (one-time use).
CREATE TABLE IF NOT EXISTS auth_challenge (
  nonce      TEXT PRIMARY KEY,
  login      TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_challenge_login ON auth_challenge(login);

-- embeddings — the semantic-search cache (lib/semantic.ts): one bge-base
-- vector per package, keyed to the latest_version it was computed from.
-- Lazily (re)filled at search time: a publish bumps latest_version, the row
-- goes stale, and the next /search re-embeds just that package. vector is a
-- JSON float array (768 dims).
CREATE TABLE IF NOT EXISTS embeddings (
  package  TEXT PRIMARY KEY REFERENCES packages(name),
  version  TEXT NOT NULL,
  vector   TEXT NOT NULL
);
