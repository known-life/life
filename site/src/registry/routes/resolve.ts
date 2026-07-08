import type { Env } from "../lib/types";
import { getVersion, getPackage, bumpInstall, providersOf } from "../lib/db";
import { getBlob } from "../lib/blobs";
import { checkRate } from "../lib/ratelimit";

/**
 * GET /api/provides/:cap — reverse capability lookup.
 *
 * Returns the gene(s) whose latest version provides `:cap`, ranked by
 * installs. The engine uses this to resolve an unmet `requires: <cap>` to the
 * REAL provider gene, instead of guessing the gene name from the cap's
 * namespace (which breaks when they differ — e.g. `identity.lifekey` →
 * `lifekey`, not `identity`).
 */
export async function handleProvides(env: Env, cap: string): Promise<Response> {
  const providers = await providersOf(env, cap);
  return new Response(JSON.stringify({ cap, providers }), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

// Exact `name@x.y.z` payloads are IMMUTABLE (versioning is the record; nothing
// is withdrawn-and-rewritten), so they are served from the edge cache. The TTL
// is NOT a correctness bound on the files — those can never change — it bounds
// how long the ADVISORY flags (yanked, superseded_by, verified_state) may lag a
// post-publish mutate. A yank purges best-effort below, but the Cache API is
// per-colo, so the TTL is the real ceiling.
const RESOLVE_EDGE_TTL = 3600;
// The Workers runtime's default edge cache; the DOM lib's CacheStorage type
// doesn't know `.default`, hence the cast (tsconfig doesn't pull workers-types).
const edgeCache = () => (caches as unknown as { default: Cache }).default;
const exactVersion = (v: string) => /^\d+\.\d+\.\d+$/.test(v);

// The one ranking side effect on the resolve path — MUST run on cache hits and
// misses alike, or edge caching silently freezes the install rankings. Counts a
// genuine adoption only (?reason=install and `have` differs), capped per-IP so a
// forged spray can't inflate the signal; off the response path via waitUntil.
function countInstall(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  name: string,
  version: string,
  life: string | null,
  isInstall: boolean,
  have: string | null,
): void {
  if (!isInstall || have === version) return;
  const ip = req.headers.get("CF-Connecting-IP") ?? "unknown";
  ctx.waitUntil(
    checkRate(env, `install-bump:${ip}`, 60, 3600).then((rl) => {
      if (rl.ok) return bumpInstall(env, name, version, life);
    }),
  );
}

/**
 * GET /api/resolve/:name/:version — the engine install endpoint.
 *
 * Returns a gene version as a manifest plus inlined file blobs, so the Life
 * engine's known.life resolver can write `.genome/<name>/` and pin
 * `name@version` + content_hash in `.life.lock`. `:version` may be `latest`.
 *
 * Counts an install (deferred) so rankings reflect real engine pulls, not just
 * browser/curl page views.
 */
export async function handleResolve(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  name: string,
  versionArg: string,
): Promise<Response> {
  // Only a real install counts toward rankings. The engine's install path passes
  // ?reason=install; `fetch` (editing) and `fresh` (staleness) deliberately don't.
  // But an install/sync resolve counts only when it's a GENUINE adoption — the
  // engine sends `have=<version this .life already has pinned>`, and we bump the
  // counter only when the version we serve differs from it (or there's no prior,
  // so `have` is absent). This is what stops every ephemeral cold boot — which
  // re-resolves the same floating defaults each session — from inflating the
  // count: a steady-state re-sync sends `have` equal to what it resolves to and
  // is not counted; a first install or a moved float still is.
  const reqUrl = new URL(req.url);
  const isInstall = reqUrl.searchParams.get("reason") === "install";
  const have = reqUrl.searchParams.get("have");
  const life = reqUrl.searchParams.get("life");

  // Immutable fast path: query string stripped from the key (?reason/have/life
  // vary per caller; the body is identical), counting still runs per request.
  const cacheKey = new Request(`${reqUrl.origin}/api/resolve/${name}/${versionArg}`);
  if (exactVersion(versionArg)) {
    const hit = await edgeCache().match(cacheKey);
    if (hit) {
      countInstall(req, env, ctx, name, versionArg, life, isInstall, have);
      const res = new Response(hit.body, hit);
      res.headers.set("X-Registry-Cache", "hit");
      return res;
    }
  }

  const pkg = await getPackage(env, name);
  if (!pkg) {
    // Common agent misfire: someone said "install known.life" and the agent
    // treated it as a gene name. known.life is the registry, not a gene.
    // Signpost the runbook so the agent can recover without searching.
    const normalised = name.toLowerCase().replace(/^known\.life\/?/, "").replace(/^\/+/, "");
    if (normalised === "" || name.toLowerCase() === "known.life" || name.toLowerCase() === "life-setup") {
      return json(404, {
        error: "not_a_gene",
        name,
        hint: "known.life is the registry, not a gene. To set up a fresh repo, follow https://known.life/install.txt (or https://known.life/llms.txt). The cold-start one-liner is: curl -fsSL https://known.life/install.sh | sh",
        runbook: "https://known.life/install.txt",
        llms: "https://known.life/llms.txt",
      });
    }
    return json(404, { error: "no_such_package", name });
  }

  const version = versionArg === "latest" ? pkg.latest_version : versionArg;
  if (!version) return json(404, { error: "no_version", name });

  const v = await getVersion(env, name, version);
  if (!v) return json(404, { error: "no_such_version", name, version });

  // Conditional resolve: the lockfile already pins content_hash, so a sync
  // that only asks "did latest move?" can send If-None-Match and get a 304
  // BEFORE any blob assembly — this is what turns an evolve's ~31 full-payload
  // latest checks into ~31 empty round-trips. (No install counted on a 304:
  // an unchanged pin is by definition not an adoption.)
  const inm = req.headers.get("If-None-Match");
  if (inm && inm.replace(/^W\//, "").replace(/"/g, "") === v.content_hash) {
    return new Response(null, {
      status: 304,
      headers: { ETag: `"${v.content_hash}"`, "Cache-Control": "no-store" },
    });
  }
  if (v.yanked) {
    // Still resolvable (reproducibility) but loudly flagged.
    // The engine surfaces this as a warning on install.
  }

  // Blob reads are independent R2 gets — fetch them concurrently, not one
  // await at a time. A sequential loop scales resolve latency linearly with
  // file count (a few hundred ms round-trip × hundreds of files → seconds,
  // enough to trip a caller's own request timeout for a large gene); this way
  // it scales with the SLOWEST single read, not the sum of all of them.
  const manifest = JSON.parse(v.manifest_json) as Record<string, string>;
  const entries = Object.entries(manifest);
  const contents = await Promise.all(entries.map(([, sha]) => getBlob(env, sha)));
  const files: Record<string, string> = {};
  for (let i = 0; i < entries.length; i++) {
    const [path, sha] = entries[i];
    const content = contents[i];
    if (content === null) return json(500, { error: "missing_blob", path, sha });
    files[path] = content;
  }

  countInstall(req, env, ctx, name, version, life, isInstall, have);

  const payload = JSON.stringify({
    name,
    version,
    content_hash: v.content_hash,
    yanked: !!v.yanked,
    yanked_reason: v.yanked_reason ?? null,
    verified_state: pkg.verified_state,
    superseded_by: pkg.superseded_by ?? null,
    requires: JSON.parse(v.requires_json ?? "[]"),
    provides: JSON.parse(v.provides_json ?? "[]"),
    inputs: JSON.parse(v.inputs_json ?? "[]"),
    files,
  });

  // Populate the edge cache only for exact-version requests (a `latest` request
  // must stay fresh — tonight's publishes moved it four times in an evening) and
  // only for non-yanked versions; yanked stays origin-only so the flag is live.
  if (exactVersion(versionArg) && !v.yanked) {
    ctx.waitUntil(edgeCache().put(cacheKey, new Response(payload, {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": `public, s-maxage=${RESOLVE_EDGE_TTL}`,
        ETag: `"${v.content_hash}"`,
      },
    })));
  }

  return new Response(payload, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Registry-Cache": "miss",
      ETag: `"${v.content_hash}"`,
    },
  });
}

function json(status: number, data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}
