import type { Env } from "../lib/types";
import { verifyToken } from "../lib/jwt";
import { checkRate } from "../lib/ratelimit";
import {
  cfOAuthConfigured,
  cfCallbackUrl,
  buildAuthorizeUrl,
  exchangeCode,
  listAccounts,
  encryptSecret,
  putGrant,
  getGrant,
  clearCachedToken,
  mintAccessToken,
  chooseGrantAccount,
  genVerifier,
  s256,
  randomToken,
  type CfGrant,
  type GrantRefusal,
} from "../lib/cf-oauth";

/**
 * Cloudflare OAuth — the consent flow that replaces the cf-drop token paste.
 *
 *   POST /api/setup/cf-oauth/start   (Bearer known.life JWT)
 *     The agent calls this. We mint a PKCE verifier + opaque `state` bound to the
 *     caller's github:<login>, stash them in KV, and return the dash.cloudflare.com
 *     consent URL. The agent shows the URL to the user — one tap, no paste.
 *
 *   GET  /oauth/cf/callback          (the user's browser lands here post-consent)
 *     Validate `state`, exchange `code` at /oauth2/token (confidential client +
 *     PKCE verifier), record which account(s) the grant can see, and persist the
 *     REFRESH token (encrypted) under the user at central. Access tokens are minted
 *     on demand by lib/cf-oauth mintAccessToken, which caches the short-lived token
 *     (encrypted) so concurrent sessions of one self share it instead of each
 *     racing the single rotating refresh token (the parallel-deploy stomping fix).
 *
 * The CF credential never reaches the agent transcript or the container: it lives
 * only in this worker (KV, encrypted) and is brokered. Mirrors the cf-drop auth
 * model (JWT-bound at creation) but eliminates the paste.
 */

const STATE_TTL_S = 600; // 10 min — user has to click through the CF consent

interface PendingCfOAuth {
  login: string;
  code_verifier: string;
  // The cross-account-poisoning guards (2026-06-20), both optional:
  //   expected_account_id — bind the grant to exactly this CF account or refuse.
  //   rebind — allow a re-consent to switch the connected account on purpose.
  expected_account_id?: string;
  rebind?: boolean;
}

// POST /api/setup/cf-oauth/start
export async function handleCfOAuthStart(req: Request, env: Env): Promise<Response> {
  const ip = req.headers.get("CF-Connecting-IP") ?? "unknown";
  const rl = await checkRate(env, `cf-oauth-start:${ip}`, 20, 60 * 60);
  if (!rl.ok) return json(429, { error: "rate_limited", retry_after_s: rl.retryAfter });

  if (!cfOAuthConfigured(env)) {
    return json(503, { error: "not_configured", hint: "CF_OAUTH_CLIENT_ID/SECRET unset on the worker" });
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  const tok = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const subject = tok ? await verifyToken(tok, env) : null;
  if (!subject || !subject.startsWith("github:")) return json(401, { error: "unauthorized" });
  const login = subject.slice("github:".length);

  // Optional account-binding hints (the poisoning guards). A caller that knows
  // which CF account this `.life` must deploy to passes expected_account_id so a
  // consent under the wrong login is refused at the callback; rebind opts into a
  // deliberate account switch. Body is optional — a bare start still works.
  let expected_account_id: string | undefined;
  let rebind = false;
  try {
    const body = (await req.json()) as { expected_account_id?: unknown; rebind?: unknown };
    if (typeof body?.expected_account_id === "string" && body.expected_account_id) expected_account_id = body.expected_account_id;
    if (body?.rebind === true) rebind = true;
  } catch {
    /* no/!json body → unguarded consent, unchanged */
  }

  const verifier = genVerifier();
  const challenge = await s256(verifier);
  const state = randomToken(24);
  const pending: PendingCfOAuth = { login, code_verifier: verifier, expected_account_id, rebind };
  await env.KNOWN_KV.put(`cf-oauth:pending:${state}`, JSON.stringify(pending), { expirationTtl: STATE_TTL_S });

  const authorize_url = buildAuthorizeUrl(env, {
    state,
    codeChallenge: challenge,
    redirectUri: cfCallbackUrl(env),
  });
  return json(200, { ok: true, authorize_url, state, expires_in: STATE_TTL_S });
}

// GET /oauth/cf/callback?code=&state=
export async function handleCfOAuthCallback(req: Request, env: Env): Promise<Response> {
  if (!cfOAuthConfigured(env)) return htmlResp(503, page("Not configured", "This known.life deploy has no Cloudflare OAuth client set."));

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthErr = url.searchParams.get("error");
  if (oauthErr) return htmlResp(400, page("Cancelled", `Cloudflare returned "${escapeHtml(oauthErr)}". Re-run setup in your agent to try again.`));
  if (!code || !state) return htmlResp(400, page("Bad request", "Missing code/state from Cloudflare."));

  const raw = await env.KNOWN_KV.get(`cf-oauth:pending:${state}`);
  if (!raw) return htmlResp(410, page("Expired", "This link expired or was already used. Re-run setup in your agent for a fresh one."));
  await env.KNOWN_KV.delete(`cf-oauth:pending:${state}`); // single-use
  const pending: PendingCfOAuth = JSON.parse(raw);

  let tok;
  try {
    tok = await exchangeCode(env, { code, codeVerifier: pending.code_verifier, redirectUri: cfCallbackUrl(env) });
  } catch (e) {
    return htmlResp(502, page("Couldn't connect", `Token exchange with Cloudflare failed: ${escapeHtml(String((e as Error).message))}`));
  }
  if (!tok.refresh_token) {
    return htmlResp(502, page("Couldn't connect", "Cloudflare returned no refresh token (the offline_access scope is required)."));
  }

  // Record which account(s) the grant can reach — the deploy target. The
  // account-binding policy (chooseGrantAccount) is the cross-account-poisoning
  // guard: it NEVER blindly takes accounts[0], and it refuses (leaving any prior
  // grant untouched) a consent that would repoint the `.life` to the wrong
  // account. See knowledge/cf-account-poisoning-incident.md.
  const accounts = await listAccounts(tok.access_token);
  const prior = await getGrant(env, pending.login);
  const choice = chooseGrantAccount({
    accounts,
    priorAccountId: prior?.account_id ?? null,
    expectedAccountId: pending.expected_account_id ?? null,
    rebind: pending.rebind ?? false,
  });

  if (!choice.ok) {
    // Refuse WITHOUT writing the grant — the connected account stays whatever it
    // was. The minted access+refresh tokens are simply dropped (never persisted).
    return htmlResp(409, page("Wrong Cloudflare account", refusalMessage(choice.reason!, pending, accounts)));
  }
  const chosen = choice.chosen!;

  const grant: CfGrant = {
    refresh_token_enc: await encryptSecret(env, tok.refresh_token),
    account_id: chosen.id,
    account_name: chosen.name,
    accounts,
    updated_at: Date.now(),
  };
  await putGrant(env, pending.login, grant);
  // The access-token cache is derived from the grant; a re-consent can change the
  // account, so purge it or the next mint serves the pre-consent token for up to
  // its full lifetime (the 2026-06-20 poisoning fix was masked ~16h this way).
  await clearCachedToken(env, pending.login);

  const acctNote =
    accounts.length === 1
      ? `Connected account: ${escapeHtml(chosen.name)}.`
      : `Connected ${accounts.length} accounts; deploys will target ${escapeHtml(chosen.name)}.`;

  return htmlResp(200, page("Connected", `Cloudflare is connected for @${escapeHtml(pending.login)}. ${acctNote} Return to your agent — it has everything it needs. You can close this tab.`));
}

// GET /api/setup/cf-oauth/status  (Bearer known.life JWT)
//
// The broker's read surface: does this user have a live Cloudflare grant, and
// does it actually work? `connected` reflects a stored grant; `ready` is proven
// by minting a short-lived access token from the stored refresh token (the live
// token exchange, performed server-side). The access token is NEVER returned —
// this is status/verify only, and the idempotency check setup uses to know CF is
// already connected (so a re-run resumes instead of re-consenting).
export async function handleCfOAuthStatus(req: Request, env: Env): Promise<Response> {
  const ip = req.headers.get("CF-Connecting-IP") ?? "unknown";
  const rl = await checkRate(env, `cf-oauth-status:${ip}`, 60, 60 * 60);
  if (!rl.ok) return json(429, { error: "rate_limited", retry_after_s: rl.retryAfter });

  const authHeader = req.headers.get("Authorization") ?? "";
  const tok = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const subject = tok ? await verifyToken(tok, env) : null;
  if (!subject || !subject.startsWith("github:")) return json(401, { error: "unauthorized" });
  const login = subject.slice("github:".length);

  const grant = await getGrant(env, login);
  if (!grant) return json(200, { connected: false });

  // Prove the grant works by minting from the stored refresh token. Report only
  // status — never the token. A mint failure (revoked grant, rotated-out refresh)
  // surfaces as ready:false so onboarding can prompt a reconnect.
  try {
    const minted = await mintAccessToken(env, login);
    return json(200, {
      connected: true,
      ready: Boolean(minted),
      account_id: grant.account_id,
      account_name: grant.account_name,
      accounts: grant.accounts.length,
    });
  } catch (e) {
    return json(200, {
      connected: true,
      ready: false,
      account_id: grant.account_id,
      account_name: grant.account_name,
      error: String((e as Error).message),
    });
  }
}

// POST /api/setup/cf-oauth/token  (Bearer known.life JWT)
//
// The broker's MINT surface — the short-lived-token model (Option A): a caller
// proving the owner's lifekey-bound bearer gets a freshly-minted, short-lived CF
// access token (+ the deploy-target account_id) to provision the vault and run
// ordinary deploys. The durable REFRESH token never leaves this worker; only the
// ephemeral access token crosses the wire, and the grant is revocable at any time
// (revoke the OAuth grant → mint fails → ready:false). This is what setup.sh and
// CI deploys call instead of holding a long-lived CLOUDFLARE_API_TOKEN. It is the
// one endpoint that returns a CF token, so it is rate-limited tighter than status.
export async function handleCfOAuthToken(req: Request, env: Env): Promise<Response> {
  const ip = req.headers.get("CF-Connecting-IP") ?? "unknown";
  const rl = await checkRate(env, `cf-oauth-token:${ip}`, 30, 60 * 60);
  if (!rl.ok) return json(429, { error: "rate_limited", retry_after_s: rl.retryAfter });

  if (!cfOAuthConfigured(env)) {
    return json(503, { error: "not_configured", hint: "CF_OAUTH_CLIENT_ID/SECRET unset on the worker" });
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  const tok = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const subject = tok ? await verifyToken(tok, env) : null;
  if (!subject || !subject.startsWith("github:")) return json(401, { error: "unauthorized" });
  const login = subject.slice("github:".length);

  const grant = await getGrant(env, login);
  if (!grant) return json(409, { error: "not_connected", hint: "no Cloudflare grant — run cf-oauth/start and consent first" });

  let minted;
  try {
    minted = await mintAccessToken(env, login);
  } catch (e) {
    return json(502, { error: "mint_failed", hint: String((e as Error).message) });
  }
  if (!minted) {
    return json(409, { error: "grant_unusable", hint: "the stored Cloudflare grant could not mint a token — re-consent via cf-oauth/start" });
  }

  return json(200, {
    ok: true,
    access_token: minted.access_token,
    account_id: minted.account_id ?? grant.account_id,
    expires_in: minted.expires_in,
  });
}

// --- helpers ---

// The human-facing explanation when chooseGrantAccount refuses a consent. Each
// case names exactly what went wrong and the one move that fixes it — the grant
// was NOT changed, so the fix is always "re-consent with the right account".
function refusalMessage(reason: GrantRefusal, pending: PendingCfOAuth, accounts: Array<{ id: string; name: string }>): string {
  const saw = accounts.length === 0 ? "no account" : accounts.map((a) => escapeHtml(a.name)).join(", ");
  switch (reason) {
    case "no_account_visible":
      return "That Cloudflare login exposed no account to the grant. Re-run setup in your agent and consent with an account selected. Nothing was changed.";
    case "expected_account_absent":
      return `This consent connected ${saw}, but @${escapeHtml(pending.login)} expected account <code>${escapeHtml(pending.expected_account_id ?? "")}</code>. You were likely logged into the wrong Cloudflare account — switch accounts at dash.cloudflare.com and re-run setup. Your existing connection was left untouched.`;
    case "would_repoint_account":
      return `@${escapeHtml(pending.login)} is already connected to a different Cloudflare account, and this consent (${saw}) would have repointed every one of your .life deploys to it. Refused — your existing connection is untouched. If you really mean to switch accounts, re-run setup with rebind.`;
    case "ambiguous_account":
      return `This consent exposed multiple Cloudflare accounts (${saw}) and none was specified, so the grant can't tell which to deploy to. Re-run setup with the intended account, or pass its expected_account_id. Nothing was changed.`;
  }
}

function json(status: number, data: unknown): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
}

function htmlResp(status: number, body: string): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} — known.life</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
         max-width: 32rem; margin: 4rem auto 2rem; padding: 0 1.25rem; }
  h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
  p { color: #333; } @media (prefers-color-scheme: dark) { p { color: #ccc; } }
</style></head><body><h1>${escapeHtml(title)}</h1><p>${body}</p></body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}
