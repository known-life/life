import type { Env } from "./types";

/**
 * Cloudflare self-managed OAuth — the central half of paste-free infra onboarding.
 *
 * known.life holds ONE registered OAuth client (client_id 12eb82cb…, registered
 * 2026-06-13 — see the `cloudflare-oauth` knowledge plan + the `cloudflare` skill).
 * A user authorizes it once via a consent link; we exchange the code for an
 * access + refresh token, and keep the REFRESH token here at central (encrypted),
 * minting short-lived access tokens on demand. The container never holds a CF
 * credential — central brokers it. This is the CF twin of the GitHub-App verifier.
 *
 * Endpoints (verified live): authorize https://dash.cloudflare.com/oauth2/auth,
 * token https://dash.cloudflare.com/oauth2/token. Flow: auth-code + PKCE (S256).
 * The client is confidential (token_endpoint_auth_method client_secret_basic), so
 * the token leg authenticates with HTTP Basic client_id:client_secret AND the PKCE
 * verifier.
 *
 * Scopes are Cloudflare's canonical **dot-notation scope IDs**, discovered from
 * `GET https://api.cloudflare.com/client/v4/oauth/scopes` (the authoritative list;
 * needs an OAuth-App-Registrations token). Hard-won 2026-06-13 across two failed
 * consents: the create API only format-checks scopes (rejects a colon `:` with
 * `70722`, but waves through any snake_case string), so the client was first
 * registered with made-up `account_read`-style names — which the create API and
 * even the authorize endpoint accepted, yet the **consent screen** rejected as
 * `Unknown oauth scope` because they aren't real scope IDs. The dot IDs below are
 * the real ones from `/oauth/scopes`; the client's REGISTERED scopes must match
 * this set exactly (the authorize endpoint rejects any requested scope not
 * registered). `offline_access` is the standard OIDC scope (not in `/oauth/scopes`
 * but valid) that yields the refresh token.
 */

const CF_AUTHORIZE = "https://dash.cloudflare.com/oauth2/auth";
const CF_TOKEN = "https://dash.cloudflare.com/oauth2/token";
const CF_ACCOUNTS = "https://api.cloudflare.com/client/v4/accounts";

// The scopes onboarding requests — the FULL Workers developer-platform surface a
// `.life` could ever deploy or bind. Dot-notation IDs from /oauth/scopes (see the
// header note); this set EXACTLY mirrors the registered client (PATCH
// /accounts/{id}/oauth_clients/{id}), which is its ceiling — the authorize endpoint
// rejects any requested scope not registered.
//
// Deliberately BROAD, requested once. Rationale (decided 2026-06-13, see
// knowledge/cloudflare-oauth.md): the onboarding thesis is "two taps and never
// another credential action", so a single broad consent beats deriving a minimal
// set per-repo and re-prompting whenever a `.life` grows a capability — that
// re-consent flow is exactly the recurring-new-grant shape the durable-github-
// verifier "within-grant rule" scar warns against, and it's edge-case-rich. These
// are all developer-platform scopes (not personal data), per-user-consented, and
// the refresh token only ever mints during that user's own deploys. ⚠ Note: a
// minted per-deploy token carries the FULL grant — Cloudflare IGNORES a narrowed
// `scope` on the refresh-token grant (verified live 2026-06-14, #597 reverted), so
// least-privilege-at-mint is NOT achievable here. The broad-once decision stands on
// its other merits; just know the tokens are broad. Security/zone-admin scopes
// (WAF, firewall, load-balancers, access-management, DNS-security, billing) are
// intentionally excluded from the grant itself, which is the real bound.
export const CF_OAUTH_SCOPES = [
  // identity + refresh
  "memberships.read", // list the user's accounts (the callback's GET /accounts)
  "user-details.read",
  "offline_access", // yields the refresh token
  // core compute + data bindings (write + read for idempotent, preserve-on-redeploy)
  "workers-scripts.write", "workers-scripts.read",
  "workers-kv-storage.write", "workers-kv-storage.read",
  "workers-r2.write", "workers-r2.read",
  "d1.write", "d1.read",
  "workers-routes.write", "workers-routes.read",
  // async + vector + AI
  "queues.write", "queues.read",
  "vectorize.write", "vectorize.read",
  "ai.write", "ai.read",
  // secrets, observability
  "secrets-store.write", "secrets-store.read",
  "workers-observability.write", "workers-observability.read", "workers-tail.read", "logs.read",
  // compute extras + media
  "browser-rendering.write", "browser-rendering.read",
  "containers.write", "containers.read",
  "images.write", "images.read",
  // custom domains (route:secure) + email
  "dns.write", "dns.read", "zone.read",
  "email-routing-rule.write", "email-routing-rule.read", "email-sending.write",
];

export interface CfTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
}

// The per-REPO grant we persist at central (KV `cf:grant:<login>:<repo>`). The
// refresh token is encrypted at rest; the access token is NEVER stored (minted on
// demand). Each `.life` repo owns its own grant — see the scope note at GRANT_KEY.
export interface CfGrant {
  refresh_token_enc: string;
  account_id: string | null;
  account_name: string | null;
  accounts: Array<{ id: string; name: string }>;
  repo: string; // the owner/repo this grant deploys (the namespace half of the key)
  updated_at: number;
}

export function cfOAuthConfigured(env: Env): boolean {
  return Boolean(env.CF_OAUTH_CLIENT_ID && env.CF_OAUTH_CLIENT_SECRET);
}

// --- grant account-binding policy (the cross-account-poisoning guard) ---
//
// The 2026-06-20 incident: a consent performed while the browser was logged into
// the WRONG Cloudflare account silently overwrote the correct grant, because the
// callback blindly recorded accounts[0]
// with no check that the new account matched the connected one. Every `.life`
// under that login then deployed to the foreign account, invisibly.
//
// This policy is the fix: the callback NEVER blindly trusts accounts[0]. It binds
// the grant only to an account that is (1) the caller's EXPECTED account, (2) the
// already-connected account on a re-consent, or (3) the single unambiguous account
// on a first connect. Anything else is REFUSED with the prior grant left untouched
// — a wrong-account consent can no longer repoint a `.life`. One canonical path,
// no silent guess. Pure (no I/O) so it is pinned by the credential-free vitest.
export type GrantRefusal =
  | "no_account_visible"
  | "expected_account_absent"
  | "would_repoint_account"
  | "ambiguous_account";

export interface GrantAccountChoice {
  ok: boolean;
  chosen?: { id: string; name: string };
  reason?: GrantRefusal;
}

export function chooseGrantAccount(opts: {
  accounts: Array<{ id: string; name: string }>;
  priorAccountId?: string | null;
  expectedAccountId?: string | null;
  rebind?: boolean;
}): GrantAccountChoice {
  const { accounts, priorAccountId, expectedAccountId, rebind } = opts;

  if (accounts.length === 0) return { ok: false, reason: "no_account_visible" };

  // 1 · An explicit expected account (the caller's declared CF identity) is the
  //     strongest bind: the consent MUST include it, else refuse untouched.
  if (expectedAccountId) {
    const chosen = accounts.find((a) => a.id === expectedAccountId);
    return chosen ? { ok: true, chosen } : { ok: false, reason: "expected_account_absent" };
  }

  // 2 · A re-consent (a grant already exists) must still include the connected
  //     account — a consent that drops it is the poisoning shape; refuse unless
  //     the caller explicitly asked to switch accounts (rebind).
  if (priorAccountId && !rebind) {
    const chosen = accounts.find((a) => a.id === priorAccountId);
    return chosen ? { ok: true, chosen } : { ok: false, reason: "would_repoint_account" };
  }

  // 3 · First connect (or an explicit rebind): a single visible account is
  //     unambiguous; multiple with nothing to disambiguate is refused rather than
  //     guessing accounts[0].
  if (accounts.length === 1) return { ok: true, chosen: accounts[0] };
  return { ok: false, reason: "ambiguous_account" };
}

export function cfCallbackUrl(env: Env): string {
  const origin = env.PUBLIC_URL ?? "https://known.life";
  return `${origin}/oauth/cf/callback`;
}

// --- PKCE + opaque tokens ---

export function randomToken(bytes = 32): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return Array.from(b, (n) => n.toString(16).padStart(2, "0")).join("");
}

// A PKCE code_verifier: 43–128 chars of unreserved set. 64 hex chars qualifies.
export function genVerifier(): string {
  return randomToken(32);
}

export async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const b = String.fromCharCode(...new Uint8Array(digest));
  return btoa(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// --- authorize URL ---

export function buildAuthorizeUrl(
  env: Env,
  opts: { state: string; codeChallenge: string; redirectUri: string },
): string {
  const u = new URL(CF_AUTHORIZE);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", env.CF_OAUTH_CLIENT_ID!);
  u.searchParams.set("redirect_uri", opts.redirectUri);
  u.searchParams.set("scope", CF_OAUTH_SCOPES.join(" "));
  u.searchParams.set("state", opts.state);
  u.searchParams.set("code_challenge", opts.codeChallenge);
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

// --- token leg (confidential client: HTTP Basic + PKCE verifier) ---

function basicAuth(env: Env): string {
  return "Basic " + btoa(`${env.CF_OAUTH_CLIENT_ID}:${env.CF_OAUTH_CLIENT_SECRET}`);
}

export async function exchangeCode(
  env: Env,
  opts: { code: string; codeVerifier: string; redirectUri: string },
): Promise<CfTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: opts.code,
    redirect_uri: opts.redirectUri,
    code_verifier: opts.codeVerifier,
  });
  return cfTokenRequest(env, body);
}

export async function refreshAccessToken(env: Env, refreshToken: string): Promise<CfTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  return cfTokenRequest(env, body);
}

async function cfTokenRequest(env: Env, body: URLSearchParams): Promise<CfTokenResponse> {
  const res = await fetch(CF_TOKEN, {
    method: "POST",
    headers: {
      Authorization: basicAuth(env),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });
  const j = (await res.json().catch(() => ({}))) as CfTokenResponse & { error?: string; error_description?: string };
  if (!res.ok || !j.access_token) {
    throw new Error(`cf token endpoint ${res.status}: ${j.error ?? "no_access_token"}${j.error_description ? ` (${j.error_description})` : ""}`);
  }
  return j;
}

// --- list accounts the granted token can see (to record the deploy target) ---

export async function listAccounts(accessToken: string): Promise<Array<{ id: string; name: string }>> {
  const res = await fetch(CF_ACCOUNTS, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  const j = (await res.json().catch(() => ({}))) as { success?: boolean; result?: Array<{ id: string; name: string }> };
  if (!res.ok || !j.success || !Array.isArray(j.result)) return [];
  return j.result.map((a) => ({ id: a.id, name: a.name }));
}

// --- encryption at rest (AES-GCM, key derived from JWT_SIGNING_KEY) ---
//
// The refresh token is long-lived and account-powerful; we never store it in the
// clear. The worker already holds a ≥32-byte JWT_SIGNING_KEY secret — derive an
// AES-256 key from it via SHA-256 so there is no second secret to manage.

async function aesKey(env: Env): Promise<CryptoKey> {
  const raw = env.JWT_SIGNING_KEY;
  if (!raw || raw.length < 32) {
    throw new Error("JWT_SIGNING_KEY missing/too short — refusing to encrypt CF refresh token");
  }
  const material = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`cf-oauth:${raw}`));
  return crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(env: Env, plaintext: string): Promise<string> {
  const key = await aesKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext));
  return `${b64(iv)}.${b64(new Uint8Array(ct))}`;
}

export async function decryptSecret(env: Env, blob: string): Promise<string> {
  const key = await aesKey(env);
  const [ivB64, ctB64] = blob.split(".");
  if (!ivB64 || !ctB64) throw new Error("malformed encrypted blob");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(ivB64) }, key, unb64(ctB64));
  return new TextDecoder().decode(pt);
}

function b64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}
function unb64(s: string) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// --- per-repo grant store (KV) ---
//
// Keyed by `cf:grant:<login>:<repo>` — a SCOPE of two halves:
//   • login — the SECURITY BOUNDARY. Cryptographically proven (lifekey sig vs
//     github.com/<login>.keys); a caller can only ever prove their own login, so
//     it can only ever read/write its own `cf:grant:<login>:*` namespace.
//   • repo — the NAMESPACE within that boundary (`owner/repo`). Self-asserted by
//     the caller, which is SAFE: user X asserting repo=`Y/foo` writes
//     `cf:grant:X:Y/foo` (X's own namespace), never Y's grant. This is what makes
//     two `.life` repos under one GitHub account independent — each owns its own
//     CF connection + deploy account, and a consent on one never touches another.
//
// Both halves LOWERCASED: GitHub logins are case-insensitive and the JWT
// subject's casing varies by auth path (lifekey /auth/prove preserves what the
// client sent; the device-flow bridge uses GitHub's canonical casing); repo
// slugs are likewise case-insensitive. Without normalizing, a grant stored via
// one path is invisible to another — caught live 2026-06-13 (device-flow Octocat
// vs lifekey octocat). One chokepoint fixes both ends.
const scope = (login: string, repo: string) => `${login.toLowerCase()}:${repo.toLowerCase()}`;
const GRANT_KEY = (login: string, repo: string) => `cf:grant:${scope(login, repo)}`;

export async function putGrant(env: Env, login: string, repo: string, grant: CfGrant): Promise<void> {
  await env.KNOWN_KV.put(GRANT_KEY(login, repo), JSON.stringify(grant));
}

export async function getGrant(env: Env, login: string, repo: string): Promise<CfGrant | null> {
  const raw = await env.KNOWN_KV.get(GRANT_KEY(login, repo));
  return raw ? (JSON.parse(raw) as CfGrant) : null;
}

// --- access-token cache (KV `cf:token:<login>`, encrypted at rest) ---
//
// WHY this exists — concurrency. The refresh token CF returns is single-use and
// ROTATED on every refresh, and there is exactly ONE per login at central. Before
// caching, every `life deploy` / `life data` minted afresh, so N parallel sessions
// of one self (a `.life` routinely runs several at once) raced that single rotating
// refresh token: CF's refresh-token reuse-detection revoked tokens out from under
// each other mid-deploy — the intermittent `10000 "Authentication error"` at random
// deploy stages, diagnosed live 2026-06-14 (a token that listed workers then died
// seconds later, untouched). Caching collapses N mints-per-minute into ONE refresh
// per token lifetime: every session reads the SAME still-valid access token, so the
// rotating exchange is rare and parallel deploys stop stomping each other.
//
// The access token is short-lived (vs the account-powerful refresh token) but still
// encrypted at rest, same AES-GCM key as the grant.
const TOKEN_KEY = (login: string, repo: string) => `cf:token:${scope(login, repo)}`;
const LOCK_KEY = (login: string, repo: string) => `cf:token:lock:${scope(login, repo)}`;
const REFRESH_MARGIN_MS = 5 * 60 * 1000; // refresh this long before CF's own expiry

interface CachedToken {
  access_token_enc: string;
  expires_at: number;
  account_id: string | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const remainingSecs = (expires_at: number) => Math.max(60, Math.floor((expires_at - Date.now()) / 1000));

// Read the cached token if present and not within REFRESH_MARGIN of expiry.
export async function getCachedToken(
  env: Env,
  login: string,
  repo: string,
): Promise<{ access_token: string; expires_at: number; account_id: string | null } | null> {
  const raw = await env.KNOWN_KV.get(TOKEN_KEY(login, repo));
  if (!raw) return null;
  let c: CachedToken;
  try {
    c = JSON.parse(raw) as CachedToken;
  } catch {
    return null;
  }
  if (c.expires_at - Date.now() < REFRESH_MARGIN_MS) return null; // (near-)expired → refresh
  try {
    return { access_token: await decryptSecret(env, c.access_token_enc), expires_at: c.expires_at, account_id: c.account_id };
  } catch {
    return null;
  }
}

export async function putCachedToken(env: Env, login: string, repo: string, access_token: string, expires_in: number, account_id: string | null): Promise<void> {
  const c: CachedToken = {
    access_token_enc: await encryptSecret(env, access_token),
    expires_at: Date.now() + expires_in * 1000,
    account_id,
  };
  // KV TTL a minute past the token's own expiry so a stale entry self-evicts.
  await env.KNOWN_KV.put(TOKEN_KEY(login, repo), JSON.stringify(c), { expirationTtl: Math.max(60, expires_in + 60) });
}

// Drop the cached access token for a login. The cache is DERIVED from the grant
// (it holds a token minted from the grant's refresh token, tagged with the grant's
// account), so any write that can change the grant's account — a re-consent — must
// purge it, else the next mint serves the pre-change token from cache for up to its
// full lifetime. 2026-06-20 incident: a poisoning re-consent flipped the grant to
// the correct account but `mintAccessToken` kept returning the wrong-account cached
// token for ~16h, masking the fix fleet-wide until the key was hand-deleted.
export async function clearCachedToken(env: Env, login: string, repo: string): Promise<void> {
  await env.KNOWN_KV.delete(TOKEN_KEY(login, repo));
}

// --- mint an access token on demand (cache-first; refresh + persist rotation) ---
//
// The broker entrypoint: given a github login with a stored grant, return a valid
// access token — from the shared cache when possible, else by refreshing (which
// rotates the refresh token, so re-encrypt + persist the new one). Returns null if
// the user has no grant (never connected, or revoked).

export async function mintAccessToken(
  env: Env,
  login: string,
  repo: string,
): Promise<{ access_token: string; expires_in: number; account_id: string | null } | null> {
  const grant = await getGrant(env, login, repo);
  if (!grant) return null;

  // 1 · Serve a cached, still-valid access token — the common path, shared across
  //     all of this self's concurrent sessions (no refresh-token touch → no race).
  const cached = await getCachedToken(env, login, repo);
  if (cached) {
    return { access_token: cached.access_token, expires_in: remainingSecs(cached.expires_at), account_id: cached.account_id ?? grant.account_id };
  }

  // 2 · Cache miss/expiry → refresh. Best-effort lock so a thundering herd of
  //     simultaneous expiries doesn't fire many concurrent refreshes at the one
  //     rotating refresh token. If another session holds the lock, briefly wait for
  //     it to populate the cache and reuse that. (KV has no atomic CAS, so this is
  //     best-effort — but it shrinks the refresh race from once-per-deploy to the
  //     once-per-token-lifetime boundary, where a rare double-refresh is recovered
  //     by re-reading the cache below.)
  if (await env.KNOWN_KV.get(LOCK_KEY(login, repo))) {
    for (let i = 0; i < 10; i++) {
      await sleep(150);
      const c = await getCachedToken(env, login, repo);
      if (c) return { access_token: c.access_token, expires_in: remainingSecs(c.expires_at), account_id: c.account_id ?? grant.account_id };
    }
  }
  await env.KNOWN_KV.put(LOCK_KEY(login, repo), "1", { expirationTtl: 60 }); // CF KV minimum is 60s

  try {
    const refresh = await decryptSecret(env, grant.refresh_token_enc);
    let tok: CfTokenResponse;
    try {
      tok = await refreshAccessToken(env, refresh);
    } catch (e) {
      // A concurrent session may have rotated the refresh token out from under us;
      // if it populated the cache meanwhile, prefer that over surfacing the error.
      const c = await getCachedToken(env, login, repo);
      if (c) return { access_token: c.access_token, expires_in: remainingSecs(c.expires_at), account_id: c.account_id ?? grant.account_id };
      throw e;
    }
    if (tok.refresh_token && tok.refresh_token !== refresh) {
      grant.refresh_token_enc = await encryptSecret(env, tok.refresh_token);
      grant.updated_at = Date.now();
      await putGrant(env, login, repo, grant);
    }
    const expires_in = tok.expires_in ?? 3600;
    await putCachedToken(env, login, repo, tok.access_token, expires_in, grant.account_id);
    return { access_token: tok.access_token, expires_in, account_id: grant.account_id };
  } finally {
    await env.KNOWN_KV.delete(LOCK_KEY(login, repo)).catch(() => {});
  }
}
