import type { Env } from "../lib/types";
import { isValidName, isValidVersion } from "../lib/id";
import { putBlob, manifestHash } from "../lib/blobs";
import { scanFiles } from "../lib/scan";
import { scanIsolateParity } from "../lib/parity";
import { checkFit } from "../lib/fit";
import type { PublishManifest } from "../lib/manifest";
import { getName, claimName, resolveAccountFromSubject, getVersion, insertVersion, getPackage, canManageName } from "../lib/db";
import { verifyToken } from "../lib/jwt";
import { checkWriteRate } from "../lib/ratelimit";
import { MAX_PACKAGE_FILES, MAX_PACKAGE_BYTES, MAX_PACKAGE_LABEL } from "../lib/config";

/**
 * POST /api/publish — the publish pipeline.
 *
 *   Authorization: Bearer <jwt>   { name, version, files: { path: content } }
 *      → AUTH       caller's lifekey identity owns the name?  (auto-claims if free)
 *      → IMMUTABLE  (name, version) unused?         (D1 unique)
 *      → SCAN       secrets + PII  ── BLOCKING ──>   reject (scan.ts)
 *      → FIT        contract↔contents ── ADVISORY ─> badge  (fit.ts)
 *      → ACCEPT     blobs→R2; version row→D1; latest advanced
 *
 * Auth is the caller's GitHub identity, proven by a lifekey signature (the token
 * from /api/auth/prove). There is no publish key: if you can sign for the owner,
 * you can publish — from any machine, forever. The response is structured +
 * agent-readable on every failure path so a publishing agent can repair + retry.
 */
export async function handlePublish(req: Request, env: Env): Promise<Response> {
  // AUTH — a JWT in `Authorization: Bearer`, either minted by the lifekey path
  // (/api/auth/prove) or the MCP OAuth bridge (/api/oauth/*). Same subject
  // shape (`github:<login>`) either way. Bypassing the ownership check on
  // someone else's name requires the account to be flagged is_admin in D1.
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const subject = token ? await verifyToken(token, env) : null;
  if (!subject) return json(401, { error: "unauthorized", hint: "sign in first (the engine does this: life mutate)" });
  const account = await resolveAccountFromSubject(env, subject);
  if (!account) return json(401, { error: "unknown_account" });

  let body: {
    name?: string;
    version?: string;
    files?: Record<string, string>;
    manifest?: PublishManifest;
    expected_latest?: string | null;
  };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "bad_json" });
  }

  const { name, version, files } = body;
  if (!name || !isValidName(name)) return json(400, { error: "invalid_name", hint: "dotted lowercase, 1–5 segments" });
  if (!version || !isValidVersion(version)) return json(400, { error: "invalid_version", hint: "semver MAJOR.MINOR.PATCH" });
  if (!files || typeof files !== "object" || Object.keys(files).length === 0)
    return json(400, { error: "no_files" });

  // Size guard.
  const totalBytes = Object.values(files).reduce((n, c) => n + c.length, 0);
  if (Object.keys(files).length > MAX_PACKAGE_FILES || totalBytes > MAX_PACKAGE_BYTES)
    return json(413, { error: "too_large", limit: MAX_PACKAGE_LABEL });

  // RATE LIMIT — per-IP and per-owner-account. Generous for legit iteration,
  // tight enough to blunt spray.
  const ip = req.headers.get("CF-Connecting-IP") ?? "unknown";
  const rl = await checkWriteRate(
    env, "publish", ip, account.id,
    { limit: 30, windowS: 60 },        // 30/min/IP
    { limit: 300, windowS: 24 * 3600 }, // 300/day/account
  );
  if (!rl.ok) return json(429, { error: "rate_limited", retry_after_s: rl.retryAfter });

  // OWNERSHIP — first publish to a free name auto-claims it for the caller;
  // otherwise the caller must be able to manage it: owner of record, admin, or
  // a maintainer the owner delegated to (see canManageName).
  const nameRec = await getName(env, name);
  if (!nameRec) {
    await claimName(env, name, account);
  } else if (!(await canManageName(env, nameRec.owner_account, account))) {
    return json(403, { error: "not_owner", hint: `@${account.github_login} can't publish ${name}` });
  }

  // COMPARE-AND-SWAP — optional optimistic concurrency on the `latest` pointer.
  // If the caller tells us which latest they based this publish on, reject when
  // the gene has advanced since (a concurrent publish landed between the
  // caller reading latest and posting). This protects the `latest` pointer the
  // way IMMUTABLE protects a cut version, turning the auto-bump read-then-write
  // race into a clean "re-pull and retry". Omitting `expected_latest` keeps the
  // old behaviour (backward-compatible: pre-CAS clients are unaffected).
  if (body.expected_latest != null) {
    const currentLatest = (await getPackage(env, name))?.latest_version ?? null;
    if (currentLatest !== body.expected_latest) {
      return json(409, {
        error: "latest_moved",
        current_latest: currentLatest,
        expected: body.expected_latest,
        hint: `${name} advanced to ${currentLatest ?? "(none)"} since you based this on ${body.expected_latest} — re-pull latest and retry`,
      });
    }
  }

  // IMMUTABLE — a cut version is forever.
  const existing = await getVersion(env, name, version);
  if (existing) return json(409, { error: "version_exists", hint: "versions are immutable; bump the version" });

  // SCAN — blocking (secrets/PII) + advisory isolate-parity findings, which
  // ride the same warnings channel so the publisher sees them in the mutate
  // result at the moment they can act.
  const scan = scanFiles(files);
  scan.warnings.push(...scanIsolateParity(files));
  if (!scan.ok) {
    return json(422, {
      error: "secrets_detected",
      message: "Publish blocked: secret/PII patterns found. Remove them and republish.",
      blocking: scan.blocking,
      warnings: scan.warnings,
    });
  }

  // The engine sent the normalized manifest (it's the one parser). Fall back to
  // empty fields if a non-engine client omitted it — the .life file is still
  // stored verbatim as the contract regardless.
  const m: PublishManifest = body.manifest ?? {
    summary: null, description: null, author: null, license: null, homepage: null,
    repository: null, keywords: [], requires: [], provides: [], imports: [], inputs: [], body: null,
  };
  const lifeText = files[".life"] ?? "";
  const requires = m.requires;   // capabilities
  const provides = m.provides;
  const imports = m.imports;      // gene deps → the gene network
  const inputs = m.inputs;
  const summary = m.summary;
  // README: the gene's README.md if present, else the manifest body.
  const readme = files["README.md"] ?? files["readme.md"] ?? m.body ?? null;
  const bytes = Object.values(files).reduce((n, c) => n + c.length, 0);

  // FIT — advisory; sets the badge. Also judges name↔content coherence so a
  // gene's name stays meaningful to a browsing agent.
  const fit = await checkFit(
    env,
    { name, contract: lifeText || m.body || "", requires, provides },
    Object.entries(files).map(([path, content]) => ({ path, content })),
  );

  // ACCEPT — store blobs, compute manifest hash, write the version row.
  // Each putBlob() is an independent R2 head+put keyed by that file's own
  // content hash, so — same fix + rationale as the read side in
  // routes/resolve.ts — fetch them concurrently rather than one await per
  // file; latency then scales with the slowest single write, not the sum.
  const entries = Object.entries(files);
  const shas = await Promise.all(entries.map(([, content]) => putBlob(env, content)));
  const blobManifest: Record<string, string> = {};
  entries.forEach(([path], i) => { blobManifest[path] = shas[i]; });
  const contentHash = await manifestHash(blobManifest);

  await insertVersion(env, {
    package: name,
    version,
    content_hash: contentHash,
    manifest: blobManifest,
    contract: lifeText || m.body || null,
    requires,
    provides,
    imports,
    inputs,
    scan_json: JSON.stringify(scan),
    fit_json: JSON.stringify(fit),
    summary,
    description: m.description,
    author: m.author,
    license: m.license,
    homepage: m.homepage,
    repository: m.repository,
    keywords: m.keywords,
    readme,
    bytes,
  });

  // Badge: blessed is set out-of-band; here we record verified/scanned from fit.
  const pkg = await getPackage(env, name);
  const badge = pkg?.verified_state === "blessed" ? "blessed" : fit.verdict;
  if (badge !== pkg?.verified_state) {
    await env.DB.prepare("UPDATE packages SET verified_state = ? WHERE name = ?").bind(badge, name).run();
  }

  return json(200, {
    ok: true,
    name,
    version,
    content_hash: contentHash,
    verified_state: badge,
    install: `known.life/${name}@${version}`,
    fit_notes: fit.notes,
    scan_warnings: scan.warnings,
    url: `${env.PUBLIC_URL}/${name}`,
  });
}

function json(status: number, data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
