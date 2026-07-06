import type { Env } from "./types";
import { getVersion } from "./db";
import { getBlob } from "./blobs";

/**
 * Reconstruct a published version's full file set from storage: the version's
 * `manifest_json` in D1 maps `path -> blob sha`, and each blob's bytes live in
 * R2. This is the read side of the publish path (routes/publish.ts), shared by
 * the in-page gene viewer.
 *
 * Unlike the engine resolve endpoint (routes/resolve.ts), a missing blob is
 * tolerated here — it's recorded in `missing` rather than failing the whole
 * page — because a half-rendered viewer is better than a 500 for a human
 * browsing. Returns null only when the version itself doesn't exist.
 *
 * Caching: a version's file set is fixed by its `content_hash` (a digest over
 * the sorted manifest — see blobs.manifestHash), so once hydrated it can be
 * memoized indefinitely with no invalidation; a new publish only ever produces
 * a *new* hash. We cache the hydrated set in KV keyed by content_hash, which
 * also dedupes identical content across names/versions. This turns the common
 * gene-page view into one KV read instead of N R2 reads — the "static-like"
 * win without coupling to a build/deploy or going stale on publish.
 */
export interface VersionFiles {
  files: Record<string, string>;
  missing: string[];
}

const CACHE_PREFIX = "files:";
// 30d bounds KV growth; immutable content just re-hydrates cheaply if evicted.
const CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;
// Don't cache pathologically large sets (KV value cap is 25 MB — stay well under).
const CACHE_MAX_BYTES = 2_000_000;

export async function loadVersionFiles(
  env: Env,
  name: string,
  version: string,
): Promise<VersionFiles | null> {
  const v = await getVersion(env, name, version);
  if (!v) return null;

  const cacheKey = `${CACHE_PREFIX}${v.content_hash}`;
  const cached = (await env.KNOWN_KV.get(cacheKey, "json")) as VersionFiles | null;
  if (cached) return cached;

  // Concurrent R2 reads, not one await at a time — see the same fix + rationale
  // in routes/resolve.ts. This path is KV-cached after first hydration, but a
  // cold/evicted large package still pays the full sequential cost otherwise.
  const manifest = JSON.parse(v.manifest_json) as Record<string, string>;
  const entries = Object.entries(manifest);
  const contents = await Promise.all(entries.map(([, sha]) => getBlob(env, sha)));
  const files: Record<string, string> = {};
  const missing: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const [path] = entries[i];
    const content = contents[i];
    if (content === null) missing.push(path);
    else files[path] = content;
  }
  const result: VersionFiles = { files, missing };

  // Cache only a *complete* hydration — never memoize a transient missing-blob
  // state (so R2 gets a chance to heal) — and only when it's small enough to
  // belong in KV. The write is best-effort: a failure just re-hydrates next view.
  if (!missing.length) {
    const serialized = JSON.stringify(result);
    if (serialized.length <= CACHE_MAX_BYTES) {
      try {
        await env.KNOWN_KV.put(cacheKey, serialized, { expirationTtl: CACHE_TTL_SECONDS });
      } catch {
        /* best-effort cache write */
      }
    }
  }
  return result;
}
