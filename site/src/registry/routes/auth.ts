import type { Env } from "../lib/types";
import { issueRegistryToken } from "../lib/jwt";
import { getOrCreateGithubAccount } from "../lib/db";
import { checkRate } from "../lib/ratelimit";
import { verifyGithubIdentity } from "../lib/lifekey-verify.mjs";

/**
 * lifekey sign-in — the ONE way to authenticate. Git identity, no human step.
 *
 *   POST /api/auth/challenge { login }   → { nonce }   (5-min TTL)
 *   POST /api/auth/prove     { login, signatures }
 *       → fetch github.com/<login>.keys, verify a signature over the nonce,
 *         bind the account to the GitHub identity, return a known.life token.
 *
 * The agent signs the nonce locally with the lifekey — the SSH key it already
 * pushes git with — whose public half is on github.com/<login>.keys. It may
 * offer several signatures (one per available key); any match proves identity.
 * The genepool only ever reads PUBLIC keys; no credential reaches known.life.
 */

const CHALLENGE_TTL = 300;

export async function handleAuthChallenge(req: Request, env: Env): Promise<Response> {
  const ip = req.headers.get("CF-Connecting-IP") ?? "unknown";
  const rl = await checkRate(env, `auth:${ip}`, 30, 60 * 60);
  if (!rl.ok) return json(429, { error: "rate_limited", retry_after_s: rl.retryAfter });

  const body = (await req.json().catch(() => null)) as { login?: string } | null;
  const login = body?.login?.trim();
  if (!login || !/^[a-zA-Z0-9-]{1,39}$/.test(login)) return json(400, { error: "invalid_login" });

  const nonceBytes = new Uint8Array(24);
  crypto.getRandomValues(nonceBytes);
  const nonce = "knl-" + [...nonceBytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  await env.KNOWN_KV.put(`authchallenge:${login.toLowerCase()}`, nonce, { expirationTtl: CHALLENGE_TTL });

  return json(200, {
    ok: true,
    nonce,
    expires_in: CHALLENGE_TTL,
    instructions: `Sign this nonce with your lifekey (the SSH key you push git with) and POST /api/auth/prove {"login":"${login}","signatures":["<base64>"]}. The engine does this for you: life mutate.`,
  });
}

export async function handleAuthProve(req: Request, env: Env): Promise<Response> {
  const ip = req.headers.get("CF-Connecting-IP") ?? "unknown";
  const rl = await checkRate(env, `auth:${ip}`, 30, 60 * 60);
  if (!rl.ok) return json(429, { error: "rate_limited", retry_after_s: rl.retryAfter });

  const body = (await req.json().catch(() => null)) as
    | { login?: string; signature?: string; signatures?: string[] }
    | null;
  const login = body?.login?.trim();
  // Accept a single `signature` (back-compat) or a `signatures` array.
  const signatures = (body?.signatures ?? (body?.signature ? [body.signature] : []))
    .map((s) => (typeof s === "string" ? s.trim() : ""))
    .filter(Boolean);
  if (!login || signatures.length === 0) return json(400, { error: "missing_fields" });

  const nonce = await env.KNOWN_KV.get(`authchallenge:${login.toLowerCase()}`);
  if (!nonce) return json(400, { error: "no_pending_challenge", hint: "call /api/auth/challenge first (nonce expires in 5 min)" });

  // Verify against the login's PUBLIC GitHub keys. Wrapped so a GitHub transport
  // blip stays retryable (keep the nonce, 502) rather than a hard 403.
  let result: { ok: boolean; matchedKey?: string };
  try {
    result = await verifyGithubIdentity(login, nonce, signatures);
  } catch {
    return json(502, { error: "github_unreachable", hint: "try again — the genepool couldn't read your GitHub keys just now" });
  }

  if (!result.ok) {
    // Consume the nonce so it can't be brute-forced.
    await env.KNOWN_KV.delete(`authchallenge:${login.toLowerCase()}`);
    return json(403, {
      error: "signature_invalid",
      hint: `no signature matched a key on github.com/${login}.keys. Sign with the SSH key you push git with (add it to ssh-agent), or publish a key at https://github.com/settings/keys`,
    });
  }

  // Consume the challenge (one-time).
  await env.KNOWN_KV.delete(`authchallenge:${login.toLowerCase()}`);

  // Resolve the canonical GitHub id (stable across login renames) for binding.
  let githubId: number | null = null;
  let avatar: string | null = null;
  try {
    const u = await fetch(`https://api.github.com/users/${encodeURIComponent(login)}`, {
      headers: { "User-Agent": "known.life", Accept: "application/vnd.github+json" },
    });
    if (u.ok) {
      const d = (await u.json()) as { id?: number; avatar_url?: string };
      githubId = d.id ?? null;
      avatar = d.avatar_url ?? null;
    }
  } catch {
    // non-fatal — fall back to a login-derived id below
  }

  const account = await getOrCreateGithubAccount(env, {
    // May be null when the users API was unreachable above — getOrCreateGithubAccount
    // resolves by the proven login first and never lets a null wipe a known id.
    githubId,
    login,
    avatar,
    name: null,
  });
  const token = await issueRegistryToken(`github:${login}`, env);

  return json(200, {
    ok: true,
    github_login: login,
    account: account.id,
    token,
    message: `Verified ownership of @${login} via your lifekey. Use this token as your known.life Authorization bearer (store it; don't echo it to the user).`,
  });
}

function json(status: number, data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
