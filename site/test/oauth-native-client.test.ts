import { describe, it, expect } from "vitest";
import { handleAuthorize, handleConsent, handleToken, handleRevoke } from "../../.genome/registry/src/registry/routes/mcp-oauth";
import { issueSsoSession, SSO_COOKIE } from "../../.genome/registry/src/registry/lib/jwt";

// The native public client (registry@2.2.1): a custom-scheme redirect
// (known-life://auth — the Life app) is a first-class PKCE client. Pins:
// scheme admitted at authorize; consent keyed per-SCHEME (custom schemes have
// origin "null" — one shared key would collapse every native app together);
// the code exchange hands a refresh_token ONLY to custom-scheme bindings;
// refresh rotates on use (until revoked); /api/oauth/revoke ends the line.

const KEY = "test-signing-key-deterministic-0123456789abcdef";
function makeKV(seed: Record<string, string> = {}) {
  const m = new Map(Object.entries(seed));
  return {
    get: async (k: string) => (m.has(k) ? m.get(k)! : null),
    put: async (k: string, v: string) => void m.set(k, v),
    delete: async (k: string) => void m.delete(k),
    _m: m,
  } as any;
}
const env = (kv = makeKV()) =>
  ({ KNOWN_KV: kv, PUBLIC_URL: "https://known.life", JWT_SIGNING_KEY: KEY,
     KNOWN_OAUTH_CLIENT_ID: "cid", KNOWN_OAUTH_CLIENT_SECRET: "sec" } as any);

const ssoCookie = async (e: any, sub = "github:octocat") =>
  `${SSO_COOKIE}=${await issueSsoSession(sub, e)}`;

// Real S256 pair so the exchange path runs end to end.
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

const authUrl = (redirect: string) =>
  `https://known.life/api/oauth/authorize?response_type=code&client_id=life-app&redirect_uri=${encodeURIComponent(redirect)}&code_challenge=${CHALLENGE}&code_challenge_method=S256`;

const tokenReq = (params: Record<string, string>) =>
  new Request("https://known.life/api/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "CF-Connecting-IP": "1.2.3.4" },
    body: new URLSearchParams(params).toString(),
  });

// Drive authorize (SSO'd) through consent to a minted code for the given redirect.
async function mintCodeFor(e: any, redirect: string): Promise<string> {
  const first = await handleAuthorize(new Request(authUrl(redirect), { headers: { Cookie: await ssoCookie(e) } }), e);
  if (first.status === 302) {
    return new URL(first.headers.get("location")!).searchParams.get("code")!;
  }
  // consent page — approve it
  expect(first.status).toBe(200);
  const html = await first.text();
  const token = html.match(/name="token" value="([^"]+)"/)![1];
  const consent = await handleConsent(new Request("https://known.life/api/oauth/consent", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: await ssoCookie(e) },
    body: new URLSearchParams({ token, decision: "approve" }).toString(),
  }), e);
  expect(consent.status).toBe(302);
  return new URL(consent.headers.get("location")!).searchParams.get("code")!;
}

describe("native custom-scheme client", () => {
  it("admits a well-formed custom-scheme redirect at authorize (no SSO → github hop, not 400)", async () => {
    const e = env();
    const r = await handleAuthorize(new Request(authUrl("known-life://auth")), e);
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toContain("github.com");
  });

  it("still rejects browser-executable schemes", async () => {
    const e = env();
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd"]) {
      const r = await handleAuthorize(new Request(authUrl(bad)), e);
      expect(r.status).toBe(400);
    }
  });

  it("SSO'd custom scheme needs one-time consent, remembered under the SCHEME key", async () => {
    const e = env();
    const first = await handleAuthorize(new Request(authUrl("known-life://auth"), { headers: { Cookie: await ssoCookie(e) } }), e);
    expect(first.status).toBe(200); // consent page, not a silent mint
    const code = await mintCodeFor(e, "known-life://auth");
    expect(code).toBeTruthy();
    expect(e.KNOWN_KV._m.has("oauth-consent:github:octocat:known-life:")).toBe(true);
    // second run: silent
    const again = await handleAuthorize(new Request(authUrl("known-life://auth"), { headers: { Cookie: await ssoCookie(e) } }), e);
    expect(again.status).toBe(302);
    expect(new URL(again.headers.get("location")!).searchParams.get("code")).toBeTruthy();
  });

  it("code exchange for a custom-scheme binding returns a refresh_token; https binding does not", async () => {
    const e = env();
    const nativeCode = await mintCodeFor(e, "known-life://auth");
    const nat = await (await handleToken(tokenReq({
      grant_type: "authorization_code", code: nativeCode, redirect_uri: "known-life://auth", code_verifier: VERIFIER,
    }), e)).json();
    expect(nat.access_token).toBeTruthy();
    expect(nat.refresh_token).toBeTruthy();

    const webCode = await mintCodeFor(e, "https://known.life/cb");
    const web = await (await handleToken(tokenReq({
      grant_type: "authorization_code", code: webCode, redirect_uri: "https://known.life/cb", code_verifier: VERIFIER,
    }), e)).json();
    expect(web.access_token).toBeTruthy();
    expect(web.refresh_token).toBeUndefined();
  });

  it("refresh rotates on use — the presented token dies, the successor works", async () => {
    const e = env();
    const code = await mintCodeFor(e, "known-life://auth");
    const first = await (await handleToken(tokenReq({
      grant_type: "authorization_code", code, redirect_uri: "known-life://auth", code_verifier: VERIFIER,
    }), e)).json();

    const second = await (await handleToken(tokenReq({
      grant_type: "refresh_token", refresh_token: first.refresh_token,
    }), e)).json();
    expect(second.access_token).toBeTruthy();
    expect(second.refresh_token).toBeTruthy();
    expect(second.refresh_token).not.toBe(first.refresh_token);

    // replaying the consumed token fails
    const replay = await handleToken(tokenReq({ grant_type: "refresh_token", refresh_token: first.refresh_token }), e);
    expect(replay.status).toBe(400);

    // the successor still works
    const third = await handleToken(tokenReq({ grant_type: "refresh_token", refresh_token: second.refresh_token }), e);
    expect(third.status).toBe(200);
  });

  it("revoke ends the line (200 even for unknown tokens — RFC 7009)", async () => {
    const e = env();
    const code = await mintCodeFor(e, "known-life://auth");
    const t = await (await handleToken(tokenReq({
      grant_type: "authorization_code", code, redirect_uri: "known-life://auth", code_verifier: VERIFIER,
    }), e)).json();

    const rev = await handleRevoke(new Request("https://known.life/api/oauth/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "CF-Connecting-IP": "1.2.3.4" },
      body: new URLSearchParams({ token: t.refresh_token }).toString(),
    }), e);
    expect(rev.status).toBe(200);

    const after = await handleToken(tokenReq({ grant_type: "refresh_token", refresh_token: t.refresh_token }), e);
    expect(after.status).toBe(400);

    const unknown = await handleRevoke(new Request("https://known.life/api/oauth/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "CF-Connecting-IP": "1.2.3.4" },
      body: new URLSearchParams({ token: "nope" }).toString(),
    }), e);
    expect(unknown.status).toBe(200);
  });

  it("http(s) consent keys are unchanged by the audience helper (no regression)", async () => {
    const e = env();
    await mintCodeFor(e, "https://external.example.com/cb");
    expect(e.KNOWN_KV._m.has("oauth-consent:github:octocat:https://external.example.com")).toBe(true);
  });
});
