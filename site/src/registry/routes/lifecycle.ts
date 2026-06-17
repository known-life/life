import type { Env } from "../lib/types";
import { getName, getPackage, resolveAccountFromSubject, getVersion, deprecateVersion, unpublishVersion, wipeName, canManageName, setSuperseded, downloadsByVersion, dependentsOf } from "../lib/db";
import { verifyToken } from "../lib/jwt";

/**
 * Gene lifecycle endpoints — the publisher verbs beyond publish:
 *
 *   POST /api/deprecate  { name, version, reason? }   (Bearer auth)
 *     Mark a version deprecated (npm semantics). It still resolves
 *     (reproducibility) but the engine warns on install. Never deletes.
 *
 *   POST /api/unpublish  { name, version }            (Bearer auth)
 *     Hard-remove a version of your own gene — at ANY age. You own your genes;
 *     there is no arbitrary time window. The ONE guard left is the only one that
 *     isn't arbitrary: a version someone else is actually standing on can't be
 *     yanked from under them — if another life has it locked (an install of that
 *     exact version) or another gene imports the package, unpublish refuses and
 *     points at deprecate (which keeps it resolvable). Deleting a version nobody
 *     uses is free; deleting one others depend on is deleting THEIR gene, not
 *     yours, so that path stays deprecate. Reversible either way: republish.
 *
 *   POST /api/supersede  { name, successor | null }   (Bearer auth)
 *     Mark a whole package renamed/replaced by a successor gene (package-level,
 *     unlike per-version deprecate). It still resolves; explore sinks it below
 *     every live gene and badges it "→ superseded by <successor>". A null
 *     successor clears the pointer (un-retire). Never deletes.
 *
 * All authorize on the caller's lifekey identity owning the name — same as
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

  // The only non-arbitrary guard: refuse to yank a version someone else is
  // standing on. A live install of this EXACT version = a life whose lock pins
  // it; a dependent gene = a composition that resolves it. Either way a hard
  // delete would break a third party — that's deleting their gene, not yours, so
  // route it to deprecate (still resolvable). No installs + no dependents → free.
  const installs = (await downloadsByVersion(env, body.name!))[body.version!] ?? 0;
  const dependents = await dependentsOf(env, body.name!);
  if (installs > 0 || dependents.length > 0) {
    const who = [
      installs > 0 ? `${installs} life(s) have it locked` : null,
      dependents.length > 0 ? `gene(s) depend on it: ${dependents.join(", ")}` : null,
    ].filter(Boolean).join("; ");
    return json(409, {
      error: "in_use",
      hint: `${body.name}@${body.version} is in use (${who}); a hard unpublish would break them. Use /api/deprecate (keeps it resolvable), or remove the dependents first.`,
    });
  }

  await unpublishVersion(env, body.name!, body.version!);
  return json(200, { ok: true, name: body.name, version: body.version, unpublished: true });
}

export async function handleSupersede(req: Request, env: Env): Promise<Response> {
  const body = await req.json().catch(() => null) as
    | { name?: string; successor?: string | null }
    | null;
  if (!body) return json(400, { error: "bad_json" });
  const auth = await authOwner(req, env, body.name);
  if (!auth.ok) return json(auth.status, { error: auth.error });

  const pkg = await getPackage(env, body.name!);
  if (!pkg) return json(404, { error: "no_such_package" });

  // A null/empty successor clears the pointer (un-retire). A non-empty one must
  // name a real, different gene — pointing a gene at itself or at a typo would
  // make the badge lie.
  const successor = body.successor ? String(body.successor).trim() : null;
  if (successor) {
    if (successor === body.name) return json(400, { error: "self_supersede", hint: "a gene cannot supersede itself" });
    const target = await getPackage(env, successor);
    if (!target || !target.latest_version) {
      return json(400, { error: "unknown_successor", hint: `no live gene named '${successor}' to supersede '${body.name}' with` });
    }
  }

  await setSuperseded(env, body.name!, successor);
  return json(200, { ok: true, name: body.name, superseded_by: successor });
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
