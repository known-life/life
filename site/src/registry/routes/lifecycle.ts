import type { Env } from "../lib/types";
import { getName, getPackage, resolveAccountFromSubject, getVersion, deprecateVersion, unpublishVersion, wipeName, canManageName } from "../lib/db";
import { verifyToken } from "../lib/jwt";
import { UNPUBLISH_WINDOW_MS, UNPUBLISH_WINDOW_LABEL } from "../lib/config";

/**
 * Gene lifecycle endpoints — the publisher verbs beyond publish:
 *
 *   POST /api/deprecate  { name, version, reason? }   (Bearer auth)
 *     Mark a version deprecated (npm semantics). It still resolves
 *     (reproducibility) but the engine warns on install. Never deletes.
 *
 *   POST /api/unpublish  { name, version }            (Bearer auth)
 *     Hard-remove a version, but only within a short safety window after it was
 *     published (genuine mistakes — a leaked file, a broken cut). Outside the
 *     window, deprecate instead. Immutability holds for anything anyone may
 *     already depend on.
 *
 * Both authorize on the caller's lifekey identity owning the name — same as
 * publish. No publish key.
 */

async function authOwner(
  req: Request,
  env: Env,
  name: string | undefined,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  if (!name) return { ok: false, status: 400, error: "missing_fields" };
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const subject = token ? await verifyToken(token, env) : null;
  if (!subject) return { ok: false, status: 401, error: "unauthorized" };
  const account = await resolveAccountFromSubject(env, subject);
  if (!account) return { ok: false, status: 401, error: "unknown_account" };
  const nameRec = await getName(env, name);
  if (!nameRec) return { ok: false, status: 404, error: "unclaimed_name" };
  if (!(await canManageName(env, nameRec.owner_account, account))) return { ok: false, status: 403, error: "not_owner" };
  return { ok: true };
}

export async function handleDeprecate(req: Request, env: Env): Promise<Response> {
  const body = await req.json().catch(() => null) as
    | { name?: string; version?: string; reason?: string }
    | null;
  if (!body) return json(400, { error: "bad_json" });
  const auth = await authOwner(req, env, body.name);
  if (!auth.ok) return json(auth.status, { error: auth.error });

  const v = await getVersion(env, body.name!, body.version!);
  if (!v) return json(404, { error: "no_such_version" });

  await deprecateVersion(env, body.name!, body.version!, body.reason ?? null);
  return json(200, { ok: true, name: body.name, version: body.version, deprecated: true, reason: body.reason ?? null });
}

export async function handleUnpublish(req: Request, env: Env): Promise<Response> {
  const body = await req.json().catch(() => null) as
    | { name?: string; version?: string }
    | null;
  if (!body) return json(400, { error: "bad_json" });
  const auth = await authOwner(req, env, body.name);
  if (!auth.ok) return json(auth.status, { error: auth.error });

  const v = await getVersion(env, body.name!, body.version!);
  if (!v) return json(404, { error: "no_such_version" });

  const age = Date.now() - v.published_at;
  if (age > UNPUBLISH_WINDOW_MS) {
    return json(409, {
      error: "outside_window",
      hint: `unpublish is only allowed within ${UNPUBLISH_WINDOW_LABEL} of publishing; use /api/deprecate instead`,
    });
  }

  await unpublishVersion(env, body.name!, body.version!);
  return json(200, { ok: true, name: body.name, version: body.version, unpublished: true });
}

/**
 * POST /api/wipe { name }   (Bearer auth, admin only)
 *
 * Hard-delete a name and everything attached: versions, install counts, dep
 * edges, package row, names row. Refuses unless the package has no live
 * `latest_version` (i.e. nothing currently published) — that's the safety
 * predicate keeping immutability honest. Use deprecate/unpublish first to
 * clear all live versions, then wipe to free the name. R2 blobs are left
 * intact (content-addressed; potentially shared).
 */
export async function handleWipe(req: Request, env: Env): Promise<Response> {
  const body = await req.json().catch(() => null) as { name?: string } | null;
  if (!body?.name) return json(400, { error: "missing_fields" });

  // Auth: admin-only. The owner check `authOwner` allows is_admin too, but
  // wipe is destructive enough that we require the admin flag explicitly
  // rather than implicit owner-of-record.
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const subject = token ? await verifyToken(token, env) : null;
  if (!subject) return json(401, { error: "unauthorized" });
  const account = await resolveAccountFromSubject(env, subject);
  if (!account) return json(401, { error: "unknown_account" });
  if (!account.is_admin) return json(403, { error: "admin_only", hint: "wipe is admin-only; deprecate/unpublish for owner-driven cleanup" });

  const nameRec = await getName(env, body.name);
  if (!nameRec) return json(404, { error: "unclaimed_name" });

  const pkg = await getPackage(env, body.name);
  if (pkg?.latest_version) {
    return json(409, {
      error: "live_version_present",
      hint: `${body.name} still has latest_version=${pkg.latest_version}; deprecate/unpublish every version first`,
    });
  }

  await wipeName(env, body.name);
  return json(200, { ok: true, name: body.name, wiped: true });
}

function json(status: number, data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
