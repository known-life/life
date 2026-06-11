import type { Env } from "../lib/types";
import { isValidName } from "../lib/id";
import { resolveAccountFromSubject, getName, claimName } from "../lib/db";
import { verifyToken } from "../lib/jwt";
import { checkWriteRate } from "../lib/ratelimit";

/**
 * POST /api/claim — claim a gene name (auth required).
 *
 *   Authorization: Bearer <jwt>   { name }
 *      → name must be valid + unclaimed
 *      → bind it to the caller's GitHub identity (the account behind the lifekey)
 *
 * Ownership is identity, full stop: whoever can sign for the GitHub login owns
 * the name and may publish to it. There is no separate publish key to store,
 * lose, or rotate. (Publishing to an unclaimed name auto-claims it, so most
 * callers never hit this endpoint directly — see routes/publish.ts.)
 */
export async function handleClaim(req: Request, env: Env): Promise<Response> {
  const auth = req.headers.get("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  const subject = token ? await verifyToken(token, env) : null;
  if (!subject) return json(401, { error: "unauthorized", hint: "sign in with your lifekey: POST /api/auth/challenge then /api/auth/prove (the engine does this: life mutate)" });

  const account = await resolveAccountFromSubject(env, subject);
  if (!account) return json(401, { error: "unknown_account" });

  let body: { name?: string };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "bad_json" });
  }
  const name = body.name;
  if (!name || !isValidName(name)) return json(400, { error: "invalid_name" });

  // RATE LIMIT — claiming is the squat vector, so keep it tight.
  const ip = req.headers.get("CF-Connecting-IP") ?? "unknown";
  const rl = await checkWriteRate(
    env, "claim", ip, account.id,
    { limit: 10, windowS: 60 },        // 10/min/IP
    { limit: 50, windowS: 24 * 3600 }, // 50/day/account
  );
  if (!rl.ok) return json(429, { error: "rate_limited", retry_after_s: rl.retryAfter });

  const existing = await getName(env, name);
  if (existing) return json(409, { error: "name_taken", name });

  await claimName(env, name, account);

  return json(200, {
    ok: true,
    name,
    owner: account.github_login ?? account.handle,
    message: `Claimed ${name}. Publish to it any time you can sign for @${account.github_login ?? account.handle} — no key to save.`,
  });
}

function json(status: number, data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
