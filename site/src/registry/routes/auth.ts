import type { Env } from "../lib/types";
import { issueRegistryToken } from "../lib/jwt";
import { getOrCreateGithubAccount } from "../lib/db";
import { checkRate } from "../lib/ratelimit";
import { fetchGithubKeys, rawFromOpenSsh, verifyRaw } from "../lib/lifekey-verify.mjs";

/**
 * lifekey sign-in — the ONE way to authenticate. Git identity, no human step.
 *
 *   POST /api/auth/challenge { login }   → { nonce }   (5-min TTL)
 *   POST /api/auth/prove     { login, signatures }
 *       → fetch github.com/<login>.keys, verify a signature over ANY of the
 *         login's outstanding nonces, bind the account, return a known.life token.
 *
 * The agent signs the nonce locally with the lifekey — the SSH key it already
 * pushes git with — whose public half is on github.com/<login>.keys. It may
 * offer several signatures (one per available key); any match proves identity.
 * The genepool only ever reads PUBLIC keys; no credential reaches known.life.
 *
 * Nonces live in D1 (`auth_challenge`), ONE ROW PER CHALLENGE keyed by the nonce
 * — not a single per-login KV slot. The slot was last-write-wins, so two
 * concurrent sign-ins as the same login (e.g. a deploy's parallel mint jobs)
 * overwrote each other's nonce and one/both proves failed. D1 is strongly
 * consistent and holds N rows, so concurrent challenges never collide; `prove`
 * accepts a signature over any of the login's unexpired nonces. No client change.
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

  const nowSec = Math.floor(Date.now() / 1000);
  // D1 has no native TTL — sweep expired rows opportunistically (cheap; auth
  // challenges are low-volume), then insert this one. One row per challenge so
  // concurrent sign-ins for the same login never overwrite each other.
  await env.DB.prepare("DELETE FROM auth_challenge WHERE created_at < ?").bind(nowSec - CHALLENGE_TTL).run();
  await env.DB.prepare("INSERT INTO auth_challenge (nonce, login, created_at) VALUES (?, ?, ?)")
    .bind(nonce, login.toLowerCase(), nowSec)
    .run();

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
    | { login?: string; signatures?: string[] }
    | null;
  const login = body?.login?.trim();
  // ONE canonical shape: a `signatures` array (the engine sends every available
  // key's signature; any match proves identity). No singular `signature` back-compat.
  const signatures = (Array.isArray(body?.signatures) ? body!.signatures : [])
    .map((s) => (typeof s === "string" ? s.trim() : ""))
    .filter(Boolean);
  if (!login || signatures.length === 0) return json(400, { error: "missing_fields" });

  // All of the login's UNEXPIRED outstanding nonces (one row per challenge).
  const nowSec = Math.floor(Date.now() / 1000);
  const rows = (await env.DB.prepare(
    "SELECT nonce FROM auth_challenge WHERE login = ? AND created_at > ?",
  ).bind(login.toLowerCase(), nowSec - CHALLENGE_TTL).all<{ nonce: string }>()).results;
  if (!rows.length) return json(400, { error: "no_pending_challenge", hint: "call /api/auth/challenge first (nonce expires in 5 min)" });

  // Fetch the login's PUBLIC GitHub keys ONCE, then check the signatures against
  // each outstanding nonce. A match on ANY nonce proves identity (the caller
  // signed one of them); concurrent sign-ins each match their own row. Wrapped so
  // a GitHub transport blip stays retryable (502) rather than a hard 403.
  let matchedNonce: string | null = null;
  try {
    const keys = await fetchGithubKeys(login);
    outer: for (const { nonce } of rows) {
      for (const line of keys) {
        const raw = rawFromOpenSsh(line);
        if (!raw) continue;
        for (const sig of signatures) {
          try {
            if (await verifyRaw(raw, nonce, sig)) { matchedNonce = nonce; break outer; }
          } catch {
            // malformed key/sig shape — try the next
          }
        }
      }
    }
  } catch {
    return json(502, { error: "github_unreachable", hint: "try again — the genepool couldn't read your GitHub keys just now" });
  }

  if (!matchedNonce) {
    // No delete on failure: brute-force is bounded by the IP rate-limit above,
    // and deleting here would wipe a concurrent sign-in's still-valid nonce.
    return json(403, {
      error: "signature_invalid",
      hint: `no signature matched a key on github.com/${login}.keys. Sign with the SSH key you push git with (add it to ssh-agent), or publish a key at https://github.com/settings/keys`,
    });
  }

  // Consume the matched challenge (one-time); other outstanding nonces stand.
  await env.DB.prepare("DELETE FROM auth_challenge WHERE nonce = ?").bind(matchedNonce).run();

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
