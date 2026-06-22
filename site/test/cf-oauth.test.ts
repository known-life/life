import { describe, it, expect, beforeEach } from "vitest";
import {
  s256,
  genVerifier,
  buildAuthorizeUrl,
  encryptSecret,
  decryptSecret,
  putGrant,
  getGrant,
  putCachedToken,
  getCachedToken,
  clearCachedToken,
  mintAccessToken,
  chooseGrantAccount,
  CF_OAUTH_SCOPES,
  type CfGrant,
} from "../src/registry/lib/cf-oauth";
import { handleCfOAuthStart, handleCfOAuthStatus, handleCfOAuthToken } from "../src/registry/routes/cloudflare-oauth";
import { issueRegistryToken } from "../src/registry/lib/jwt";

// The CF OAuth flow is the paste-free infra-onboarding credential path: a wrong
// PKCE challenge, a leaked-in-the-clear refresh token, or a start route that
// mints a consent URL for an unauthenticated caller would each be a security
// hole. These tests pin the pure logic credential-free (no live Cloudflare).

// Minimal in-memory KV mock — get/put/delete. Mirrors Cloudflare KV's real
// constraint that expirationTtl must be >= 60 (a sub-60 TTL is a 400 at the edge,
// which once shipped a broker regression that broke every CF mint — caught here now).
class MockKV {
  private m = new Map<string, string>();
  async get(k: string): Promise<string | null> {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  async put(k: string, v: string, opts?: { expirationTtl?: number }): Promise<void> {
    if (opts?.expirationTtl !== undefined && opts.expirationTtl < 60) {
      throw new Error(`Invalid expiration_ttl of ${opts.expirationTtl}. Expiration TTL must be at least 60.`);
    }
    this.m.set(k, v);
  }
  async delete(k: string): Promise<void> {
    this.m.delete(k);
  }
}

const SIGNING = "test-signing-key-deterministic-0123456789abcdef";
const env = (over: Record<string, unknown> = {}) =>
  ({
    JWT_SIGNING_KEY: SIGNING,
    PUBLIC_URL: "https://known.life",
    CF_OAUTH_CLIENT_ID: "12eb82cbtest",
    CF_OAUTH_CLIENT_SECRET: "shh-secret",
    KNOWN_KV: new MockKV(),
    ...over,
  }) as any;

describe("PKCE s256", () => {
  it("matches the RFC 7636 reference vector", async () => {
    // verifier → challenge from RFC 7636 Appendix B.
    expect(await s256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("genVerifier produces a valid-length verifier (43–128 chars)", () => {
    const v = genVerifier();
    expect(v.length).toBeGreaterThanOrEqual(43);
    expect(v.length).toBeLessThanOrEqual(128);
  });
});

describe("authorize URL", () => {
  it("carries the OAuth params and the registered scope set", () => {
    const u = new URL(buildAuthorizeUrl(env(), { state: "ST", codeChallenge: "CH", redirectUri: "https://known.life/oauth/cf/callback" }));
    expect(u.origin + u.pathname).toBe("https://dash.cloudflare.com/oauth2/auth");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("client_id")).toBe("12eb82cbtest");
    expect(u.searchParams.get("redirect_uri")).toBe("https://known.life/oauth/cf/callback");
    expect(u.searchParams.get("state")).toBe("ST");
    expect(u.searchParams.get("code_challenge")).toBe("CH");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    const scope = u.searchParams.get("scope") ?? "";
    expect(scope.split(" ")).toEqual(CF_OAUTH_SCOPES);
    expect(scope).toContain("offline_access");
  });
});

describe("refresh-token encryption at rest", () => {
  it("round-trips through encrypt/decrypt", async () => {
    const e = env();
    const blob = await encryptSecret(e, "refresh-abc-123");
    expect(blob).not.toContain("refresh-abc-123"); // not stored in the clear
    expect(await decryptSecret(e, blob)).toBe("refresh-abc-123");
  });

  it("fails to decrypt a tampered blob", async () => {
    const e = env();
    const blob = await encryptSecret(e, "refresh-abc-123");
    const [iv, ct] = blob.split(".");
    const tampered = `${iv}.${ct.slice(0, -2)}AA`;
    await expect(decryptSecret(e, tampered)).rejects.toBeTruthy();
  });

  it("a different signing key cannot decrypt", async () => {
    const blob = await encryptSecret(env(), "refresh-abc-123");
    await expect(decryptSecret(env({ JWT_SIGNING_KEY: "another-key-padded-to-thirty-two-bytes-xxxx" }), blob)).rejects.toBeTruthy();
  });
});

describe("per-repo grant store", () => {
  const mk = (over: Partial<CfGrant> = {}): CfGrant => ({
    refresh_token_enc: "iv.ct",
    account_id: "acc1",
    account_name: "Acme",
    accounts: [{ id: "acc1", name: "Acme" }],
    repo: "octocat/life",
    updated_at: 1,
    ...over,
  });

  it("round-trips a grant through KV, scoped to (login, repo)", async () => {
    const e = env();
    const grant = mk();
    await putGrant(e, "octocat", "octocat/life", grant);
    expect(await getGrant(e, "octocat", "octocat/life")).toEqual(grant);
    expect(await getGrant(e, "nobody", "octocat/life")).toBeNull();
  });

  it("two repos under ONE login are independent — this is the per-repo fix", async () => {
    // Dom's bug: a CF consent on repo B used to overwrite repo A's grant because
    // both keyed `cf:grant:<login>`. Now each owns its own grant; writing one must
    // never be visible as the other.
    const e = env();
    const a = mk({ account_id: "accA", account_name: "acct-A", repo: "octocat/life" });
    const b = mk({ account_id: "accB", account_name: "acct-B", repo: "octocat/other" });
    await putGrant(e, "octocat", "octocat/life", a);
    await putGrant(e, "octocat", "octocat/other", b);
    expect((await getGrant(e, "octocat", "octocat/life"))?.account_id).toBe("accA");
    expect((await getGrant(e, "octocat", "octocat/other"))?.account_id).toBe("accB");
    // Re-consenting repo B (rebind to a third account) leaves repo A untouched.
    await putGrant(e, "octocat", "octocat/other", mk({ account_id: "accC", repo: "octocat/other" }));
    expect((await getGrant(e, "octocat", "octocat/life"))?.account_id).toBe("accA");
  });

  it("a different user can NOT reach another login's repo grant (login is the boundary)", async () => {
    // Self-asserted repo is safe because the login namespaces it: user `evil`
    // asserting repo=`octocat/life` writes cf:grant:evil:octocat/life, never
    // octocat's grant.
    const e = env();
    await putGrant(e, "octocat", "octocat/life", mk({ account_id: "victim" }));
    await putGrant(e, "evil", "octocat/life", mk({ account_id: "attacker" }));
    expect((await getGrant(e, "octocat", "octocat/life"))?.account_id).toBe("victim");
    expect((await getGrant(e, "evil", "octocat/life"))?.account_id).toBe("attacker");
  });

  it("is case-insensitive in BOTH login and repo (GitHub slugs are)", async () => {
    // The bug caught live 2026-06-13: a device-flow session (GitHub-canonical
    // "Octocat") couldn't see a grant a lifekey session stored as "octocat".
    const e = env();
    const grant = mk();
    await putGrant(e, "Octocat", "Octocat/Life", grant);
    expect(await getGrant(e, "octocat", "octocat/life")).toEqual(grant);
    expect(await getGrant(e, "OCTOCAT", "OCTOCAT/LIFE")).toEqual(grant);
  });
});

describe("access-token cache (parallel-deploy stomping fix)", () => {
  const REPO = "octocat/life";
  const grant: CfGrant = {
    refresh_token_enc: "iv.ct",
    account_id: "acc1",
    account_name: "Acme",
    accounts: [{ id: "acc1", name: "Acme" }],
    repo: REPO,
    updated_at: 1,
  };

  it("round-trips a cached token, encrypted at rest, keyed by (login, repo)", async () => {
    const e = env();
    await putCachedToken(e, "octocat", REPO, "cf-access-xyz", 3600, "acc1");
    const raw = await e.KNOWN_KV.get("cf:token:octocat:octocat/life");
    expect(raw).toBeTruthy();
    expect(raw).not.toContain("cf-access-xyz"); // not stored in the clear
    const c = await getCachedToken(e, "octocat", REPO);
    expect(c?.access_token).toBe("cf-access-xyz");
    expect(c?.account_id).toBe("acc1");
  });

  it("two repos' cached tokens don't collide", async () => {
    const e = env();
    await putCachedToken(e, "octocat", "octocat/life", "tok-A", 3600, "accA");
    await putCachedToken(e, "octocat", "octocat/other", "tok-B", 3600, "accB");
    expect((await getCachedToken(e, "octocat", "octocat/life"))?.access_token).toBe("tok-A");
    expect((await getCachedToken(e, "octocat", "octocat/other"))?.access_token).toBe("tok-B");
  });

  it("treats a (near-)expired cached token as a miss", async () => {
    const e = env();
    await putCachedToken(e, "octocat", REPO, "cf-access-old", 60, "acc1"); // within the 5-min margin
    expect(await getCachedToken(e, "octocat", REPO)).toBeNull();
  });

  it("is case-insensitive in login and repo (a token cached under one casing is found under another)", async () => {
    const e = env();
    await putCachedToken(e, "Octocat", "Octocat/Life", "cf-access-xyz", 3600, "acc1");
    expect((await getCachedToken(e, "octocat", "octocat/life"))?.access_token).toBe("cf-access-xyz");
  });

  it("mintAccessToken serves the cached token WITHOUT a refresh-token exchange (no network)", async () => {
    // The crux of the fix: with a fresh cache, a mint never touches CF's token
    // endpoint — so N concurrent sessions never race the rotating refresh token.
    // refreshAccessToken would throw here (no live CF); a cache hit avoids it.
    const e = env();
    await putGrant(e, "octocat", REPO, grant);
    await putCachedToken(e, "octocat", REPO, "cf-access-cached", 3600, "acc1");
    const minted = await mintAccessToken(e, "octocat", REPO);
    expect(minted?.access_token).toBe("cf-access-cached");
    expect(minted?.account_id).toBe("acc1");
    expect(minted!.expires_in).toBeGreaterThan(0);
  });

  it("mintAccessToken returns null with no grant, before any cache work", async () => {
    expect(await mintAccessToken(env(), "nobody", REPO)).toBeNull();
  });

  it("the refresh-path lock uses a CF-valid TTL (>=60) — guards the live regression", async () => {
    // Cache miss → the refresh path runs, which acquires a KV lock FIRST. A sub-60
    // lock TTL is a 400 at real CF KV (which once broke every mint); the strict
    // MockKV now throws that same error. The grant's refresh_token_enc is bogus, so
    // the mint fails — but it must fail at decrypt, NOT at the lock's TTL.
    const e = env();
    await putGrant(e, "octocat", REPO, grant); // refresh_token_enc "iv.ct" → decrypt throws after the lock
    let err: unknown;
    try {
      await mintAccessToken(e, "octocat", REPO);
    } catch (x) {
      err = x;
    }
    expect(err).toBeTruthy();
    expect(String((err as Error).message)).not.toContain("expiration_ttl");
  });
});

describe("clearCachedToken — a re-consent must not be masked by the token cache", () => {
  // 2026-06-20 incident: a poisoning re-consent flipped cf:grant to the correct
  // account, but mintAccessToken kept serving the wrong-account token from
  // cf:token:<login> for ~16h, masking the fix fleet-wide. The callback now purges
  // the cache on every grant write; these pin that the purge actually un-masks.
  const REPO = "octocat/life";
  const staleGrant: CfGrant = {
    refresh_token_enc: "iv.ct", // bogus → a real refresh would throw (proves no network on a cache hit)
    account_id: "acctB",
    account_name: "acme-co",
    accounts: [{ id: "acctB", name: "acme-co" }],
    repo: REPO,
    updated_at: 1,
  };

  it("removes the cached token", async () => {
    const e = env();
    await putCachedToken(e, "octocat", REPO, "cf-access-stale", 3600, "acctB");
    expect(await getCachedToken(e, "octocat", REPO)).not.toBeNull();
    await clearCachedToken(e, "octocat", REPO);
    expect(await getCachedToken(e, "octocat", REPO)).toBeNull();
    expect(await e.KNOWN_KV.get("cf:token:octocat:octocat/life")).toBeNull();
  });

  it("is case-insensitive (purges a token cached under any casing)", async () => {
    const e = env();
    await putCachedToken(e, "Octocat", "Octocat/Life", "cf-access-stale", 3600, "acctB");
    await clearCachedToken(e, "octocat", "octocat/life");
    expect(await getCachedToken(e, "Octocat", "Octocat/Life")).toBeNull();
  });

  it("after the purge, mintAccessToken no longer serves the pre-consent token", async () => {
    // With the stale cache present, mint returns it WITHOUT a refresh (the masking
    // bug). After clearCachedToken, the next mint must fall through to the refresh
    // path — which here throws on the bogus refresh token — i.e. it is NOT serving
    // the stale account from cache anymore.
    const e = env();
    await putGrant(e, "octocat", REPO, staleGrant);
    await putCachedToken(e, "octocat", REPO, "cf-access-stale", 3600, "acctB");
    expect((await mintAccessToken(e, "octocat", REPO))?.access_token).toBe("cf-access-stale"); // masked

    await clearCachedToken(e, "octocat", REPO);
    await expect(mintAccessToken(e, "octocat", REPO)).rejects.toBeTruthy(); // no longer masked → hits refresh
  });
});

describe("chooseGrantAccount — the cross-account-poisoning guard", () => {
  const A = { id: "accA", name: "alice@example.com" };
  const B = { id: "accB", name: "acme-co" };

  it("the incident shape: a re-consent that drops the connected account is REFUSED, grant untouched", () => {
    // the user was connected to A (…e134e3); a consent under the wrong login
    // saw only B (acme-co). The old code took B blindly; now it refuses.
    const c = chooseGrantAccount({ accounts: [B], priorAccountId: A.id });
    expect(c.ok).toBe(false);
    expect(c.reason).toBe("would_repoint_account");
    expect(c.chosen).toBeUndefined();
  });

  it("a re-consent that still includes the connected account binds to it (not accounts[0])", () => {
    // Connected to A; consent exposes [B, A] — must pick A, never the first (B).
    const c = chooseGrantAccount({ accounts: [B, A], priorAccountId: A.id });
    expect(c.ok).toBe(true);
    expect(c.chosen).toEqual(A);
  });

  it("rebind opts into a deliberate account switch", () => {
    const c = chooseGrantAccount({ accounts: [B], priorAccountId: A.id, rebind: true });
    expect(c.ok).toBe(true);
    expect(c.chosen).toEqual(B);
  });

  it("an expected account must be present in the consent, else refuse", () => {
    expect(chooseGrantAccount({ accounts: [A], expectedAccountId: A.id }).chosen).toEqual(A);
    const miss = chooseGrantAccount({ accounts: [B], expectedAccountId: A.id });
    expect(miss.ok).toBe(false);
    expect(miss.reason).toBe("expected_account_absent");
  });

  it("expected account wins even amid multiple visible accounts (no accounts[0] guess)", () => {
    const c = chooseGrantAccount({ accounts: [B, A], expectedAccountId: A.id });
    expect(c.chosen).toEqual(A);
  });

  it("first connect with a single account is unambiguous", () => {
    expect(chooseGrantAccount({ accounts: [A] }).chosen).toEqual(A);
  });

  it("first connect with multiple accounts and nothing to disambiguate is REFUSED (no blind accounts[0])", () => {
    const c = chooseGrantAccount({ accounts: [A, B] });
    expect(c.ok).toBe(false);
    expect(c.reason).toBe("ambiguous_account");
  });

  it("no visible account is refused", () => {
    expect(chooseGrantAccount({ accounts: [] }).reason).toBe("no_account_visible");
  });
});

describe("POST /api/setup/cf-oauth/start", () => {
  const REPO = "octocat/life";
  const post = (e: any, headers: Record<string, string> = {}, repo: string | null = REPO) =>
    handleCfOAuthStart(
      new Request(`https://known.life/api/setup/cf-oauth/start${repo === null ? "" : `?repo=${encodeURIComponent(repo)}`}`, { method: "POST", headers }),
      e,
    );

  it("503 when the CF client is not configured", async () => {
    const res = await post(env({ CF_OAUTH_CLIENT_ID: undefined, CF_OAUTH_CLIENT_SECRET: undefined }));
    expect(res.status).toBe(503);
  });

  it("401 without a bearer", async () => {
    expect((await post(env())).status).toBe(401);
  });

  it("401 with a non-github subject is impossible — a valid github bearer is required", async () => {
    const bad = await post(env(), { Authorization: "Bearer not-a-real-jwt" });
    expect(bad.status).toBe(401);
  });

  it("400 repo_required when ?repo is absent or malformed (no per-login fallback)", async () => {
    const e = env();
    const bearer = await issueRegistryToken("github:octocat", e);
    expect((await post(e, { Authorization: `Bearer ${bearer}` }, null)).status).toBe(400);
    expect((await post(e, { Authorization: `Bearer ${bearer}` }, "not-a-slug")).status).toBe(400);
  });

  it("200 with a valid github bearer + repo → consent URL whose challenge matches the stashed verifier; repo is bound", async () => {
    const e = env();
    const bearer = await issueRegistryToken("github:octocat", e);
    const res = await post(e, { Authorization: `Bearer ${bearer}` });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { authorize_url: string; state: string };
    const u = new URL(body.authorize_url);
    expect(u.searchParams.get("state")).toBe(body.state);

    // The pending entry must hold the verifier whose S256 equals the URL challenge,
    // bound to the proven login AND the requested repo.
    const pendingRaw = await e.KNOWN_KV.get(`cf-oauth:pending:${body.state}`);
    expect(pendingRaw).toBeTruthy();
    const pending = JSON.parse(pendingRaw!) as { login: string; repo: string; code_verifier: string };
    expect(pending.login).toBe("octocat");
    expect(pending.repo).toBe(REPO);
    expect(await s256(pending.code_verifier)).toBe(u.searchParams.get("code_challenge"));
  });
});

describe("GET /api/setup/cf-oauth/status", () => {
  const REPO = "octocat/life";
  const get = (e: any, headers: Record<string, string> = {}, repo: string | null = REPO) =>
    handleCfOAuthStatus(new Request(`https://known.life/api/setup/cf-oauth/status${repo === null ? "" : `?repo=${encodeURIComponent(repo)}`}`, { headers }), e);

  it("401 without a bearer", async () => {
    expect((await get(env())).status).toBe(401);
  });

  it("400 repo_required without ?repo", async () => {
    const e = env();
    const bearer = await issueRegistryToken("github:octocat", e);
    expect((await get(e, { Authorization: `Bearer ${bearer}` }, null)).status).toBe(400);
  });

  it("connected:false for a github bearer + repo with no stored grant (no network)", async () => {
    const e = env();
    const bearer = await issueRegistryToken("github:octocat", e);
    const res = await get(e, { Authorization: `Bearer ${bearer}` });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connected: false });
  });
});

describe("POST /api/setup/cf-oauth/token (the brokered mint surface)", () => {
  const REPO = "octocat/life";
  const post = (e: any, headers: Record<string, string> = {}, repo: string | null = REPO) =>
    handleCfOAuthToken(new Request(`https://known.life/api/setup/cf-oauth/token${repo === null ? "" : `?repo=${encodeURIComponent(repo)}`}`, { method: "POST", headers }), e);

  it("503 when the CF client is not configured", async () => {
    const res = await post(env({ CF_OAUTH_CLIENT_ID: undefined, CF_OAUTH_CLIENT_SECRET: undefined }));
    expect(res.status).toBe(503);
  });

  it("401 without a bearer", async () => {
    expect((await post(env())).status).toBe(401);
  });

  it("401 with an invalid bearer", async () => {
    expect((await post(env(), { Authorization: "Bearer not-a-real-jwt" })).status).toBe(401);
  });

  it("400 repo_required without ?repo", async () => {
    const e = env();
    const bearer = await issueRegistryToken("github:octocat", e);
    expect((await post(e, { Authorization: `Bearer ${bearer}` }, null)).status).toBe(400);
  });

  it("409 not_connected for a valid github bearer + repo with no stored grant (no network)", async () => {
    const e = env();
    const bearer = await issueRegistryToken("github:octocat", e);
    const res = await post(e, { Authorization: `Bearer ${bearer}` });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("not_connected");
  });
});
