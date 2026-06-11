import type { Env } from "../lib/types";
import { resolveAccountFromSubject, addMaintainer, removeMaintainer, listMaintainers } from "../lib/db";
import { verifyToken } from "../lib/jwt";

/**
 * Maintainer delegation — let an owner share publish rights without giving away
 * their account.
 *
 *   GET  /api/maintainers                       (Bearer auth)
 *      → { owner, maintainers: [login, …] }     the caller's own delegated set
 *
 *   POST /api/maintainers  { add?: login, remove?: login }   (Bearer auth)
 *      → grant/revoke a login over EVERY name the caller owns (now and future),
 *        then return the updated set.
 *
 * Scope is always the CALLER'S OWN names — `owner_account` is the authenticated
 * account, never a target you pass in. You can only delegate what you own; an
 * admin already publishes anything and needs no grant. A maintainer gets the
 * owner's full publish/deprecate/unpublish authority (canManageName), minus the
 * admin-only `wipe`. Granted by GitHub login, so a teammate who hasn't signed in
 * yet can be pre-authorized.
 */

// GitHub login grammar (mirrors routes/auth.ts): 1–39 of [A-Za-z0-9-].
const LOGIN_RE = /^[a-zA-Z0-9-]{1,39}$/;

export async function handleMaintainers(req: Request, env: Env): Promise<Response> {
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const subject = token ? await verifyToken(token, env) : null;
  if (!subject) return json(401, { error: "unauthorized", hint: "sign in first (the engine does this)" });
  const account = await resolveAccountFromSubject(env, subject);
  if (!account) return json(401, { error: "unknown_account" });

  if (req.method === "GET") {
    return json(200, { owner: account.github_login, maintainers: await listMaintainers(env, account.id) });
  }

  const body = (await req.json().catch(() => null)) as { add?: string; remove?: string } | null;
  if (!body || (!body.add && !body.remove)) return json(400, { error: "missing_fields", hint: "pass { add: <login> } or { remove: <login> }" });

  const add = body.add?.trim();
  const remove = body.remove?.trim();
  if (add && !LOGIN_RE.test(add)) return json(400, { error: "invalid_login", field: "add" });
  if (remove && !LOGIN_RE.test(remove)) return json(400, { error: "invalid_login", field: "remove" });
  // A login can't maintain its own account — that's just ownership.
  if (add && add === account.github_login) return json(400, { error: "self_grant", hint: "you already own your own names" });

  if (add) await addMaintainer(env, account.id, add);
  if (remove) await removeMaintainer(env, account.id, remove);

  return json(200, { owner: account.github_login, maintainers: await listMaintainers(env, account.id) });
}

function json(status: number, data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
