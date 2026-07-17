import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { viewerFetch } from "../../.genome/viewer/src/router";
import { s256 } from "../../.genome/viewer/src/crypto";
import { readSession } from "../../.genome/viewer/src/session";
import type { ViewerConfig } from "../../.genome/viewer/src/config";

/**
 * The full login handshake against a fake IdP — the contract the viewer
 * expects from the registry's OAuth bridge (mcp-oauth.ts + setup.ts), pinned
 * here so a drift on either side fails fast.
 */

const SECRET = "0123456789abcdef0123456789abcdef-test-secret"; // synthetic fixture, not a credential — gitleaks:allow
const ORIGIN = "https://known.life";

function makeCfg(over: Partial<ViewerConfig> & { ghTokenStatus?: number[] } = {}): ViewerConfig {
  const ghStatuses = over.ghTokenStatus ?? [200];
  let call = 0;
  return {
    basePath: "/app",
    idpOrigin: ORIGIN,
    sessionSecret: SECRET,
    idpFetch: async (req: Request) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/oauth/token" && req.method === "POST") {
        const body = new URLSearchParams(await req.text());
        if (body.get("grant_type") !== "authorization_code" || !body.get("code") || !body.get("code_verifier")) {
          return Response.json({ error: "invalid_request" }, { status: 400 });
        }
        if (body.get("code") === "bad-code") return Response.json({ error: "invalid_grant" }, { status: 400 });
        return Response.json({ access_token: "jwt-1", token_type: "Bearer", expires_in: 3600 });
      }
      if (url.pathname === "/api/setup/github-token" && req.method === "POST") {
        if (req.headers.get("Authorization") !== "Bearer jwt-1") return Response.json({ error: "unauthorized" }, { status: 401 });
        const status = ghStatuses[Math.min(call++, ghStatuses.length - 1)];
        if (status !== 200) return Response.json({ error: "gh_token_expired" }, { status });
        return Response.json({ ok: true, github_login: "DomVinyard", github_token: "gho_test", scope: "repo" });
      }
      return new Response("unexpected idp call " + url.pathname, { status: 500 });
    },
    ...over,
  };
}

function cookiesOf(res: Response): string[] {
  // getSetCookie is available in Node 20+/undici.
  const anyHeaders = res.headers as Headers & { getSetCookie?: () => string[] };
  return anyHeaders.getSetCookie ? anyHeaders.getSetCookie() : [];
}

function cookiePair(setCookie: string): string {
  return setCookie.split(";")[0];
}

async function doLogin(cfg: ViewerConfig, retry = false) {
  const res = await viewerFetch(new Request(`${ORIGIN}/app/auth/login${retry ? "?retry=1" : ""}`), cfg);
  expect(res?.status).toBe(302);
  const loc = new URL(res!.headers.get("Location")!);
  const cookies = cookiesOf(res!);
  const stateCookie = cookies.find((c) => c.startsWith("life_view_state="))!;
  return { loc, stateCookie, cookies };
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === "https://api.github.com/user") {
      return Response.json({ login: "DomVinyard", name: "Dom", avatar_url: "https://avatars.example/1" });
    }
    return new Response("unexpected fetch " + url, { status: 500 });
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe("viewer auth handshake", () => {
  it("ignores paths outside the base path", async () => {
    expect(await viewerFetch(new Request(`${ORIGIN}/api/publish`), makeCfg())).toBeNull();
    expect(await viewerFetch(new Request(`${ORIGIN}/application`), makeCfg())).toBeNull();
  });

  it("shows sign-in when logged out, on / and on deep links", async () => {
    const cfg = makeCfg();
    const home = await viewerFetch(new Request(`${ORIGIN}/app`), cfg);
    expect(home?.status).toBe(200);
    expect(await home!.text()).toContain("Continue with GitHub");
    const deep = await viewerFetch(new Request(`${ORIGIN}/app/o/r/life`), cfg);
    expect(await deep!.text()).toContain("Continue with GitHub");
  });

  it("login redirects to the IdP with PKCE and demands a fresh upstream hop", async () => {
    const { loc } = await doLogin(makeCfg());
    expect(loc.origin + loc.pathname).toBe(`${ORIGIN}/api/oauth/authorize`);
    expect(loc.searchParams.get("response_type")).toBe("code");
    expect(loc.searchParams.get("client_id")).toBe(`${ORIGIN}/app`);
    expect(loc.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/app/auth/callback`);
    expect(loc.searchParams.get("scope")).toBe("repo,workflow,admin:public_key,read:user");
    expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
    expect(loc.searchParams.get("code_challenge")).toBeTruthy();
    // prompt=login (registry ≥0.4.0) is what refreshes the IdP's gh:tok cache —
    // the silent-SSO path never touches GitHub.
    expect(loc.searchParams.get("prompt")).toBe("login");
  });

  it("completes the code exchange and seals a session", async () => {
    const cfg = makeCfg();
    const { loc, stateCookie } = await doLogin(cfg);
    const state = loc.searchParams.get("state")!;

    const res = await viewerFetch(
      new Request(`${ORIGIN}/app/auth/callback?code=good&state=${state}`, {
        headers: { Cookie: cookiePair(stateCookie) },
      }),
      cfg,
    );
    expect(res?.status).toBe(302);
    expect(res?.headers.get("Location")).toBe("/app");
    const sessionCookie = cookiesOf(res!).find((c) => c.startsWith("life_view="))!;
    expect(sessionCookie).toContain("HttpOnly");
    expect(sessionCookie).toContain("Secure");

    const session = await readSession(
      new Request(`${ORIGIN}/app`, { headers: { Cookie: cookiePair(sessionCookie) } }),
      cfg,
    );
    expect(session?.login).toBe("DomVinyard");
    expect(session?.token).toBe("gho_test");
  });

  it("PKCE: the verifier it sends hashes to the challenge it registered", async () => {
    let sentVerifier = "";
    const cfg = makeCfg();
    const inner = cfg.idpFetch;
    cfg.idpFetch = async (req) => {
      if (new URL(req.url).pathname === "/api/oauth/token") {
        const clone = req.clone();
        sentVerifier = new URLSearchParams(await clone.text()).get("code_verifier") ?? "";
      }
      return inner(req);
    };
    const { loc, stateCookie } = await doLogin(cfg);
    await viewerFetch(
      new Request(`${ORIGIN}/app/auth/callback?code=good&state=${loc.searchParams.get("state")}`, {
        headers: { Cookie: cookiePair(stateCookie) },
      }),
      cfg,
    );
    expect(sentVerifier).toBeTruthy();
    expect(await s256(sentVerifier)).toBe(loc.searchParams.get("code_challenge"));
  });

  it("rejects a state mismatch", async () => {
    const cfg = makeCfg();
    const { stateCookie } = await doLogin(cfg);
    const res = await viewerFetch(
      new Request(`${ORIGIN}/app/auth/callback?code=good&state=WRONG`, {
        headers: { Cookie: cookiePair(stateCookie) },
      }),
      cfg,
    );
    expect(res?.status).toBe(400);
    expect(await res!.text()).toContain("handshake expired");
  });

  it("recovers from a gh:tok cache miss with one forced retry, then errors", async () => {
    const cfg = makeCfg({ ghTokenStatus: [410, 410] });
    const first = await doLogin(cfg);
    const res1 = await viewerFetch(
      new Request(`${ORIGIN}/app/auth/callback?code=good&state=${first.loc.searchParams.get("state")}`, {
        headers: { Cookie: cookiePair(first.stateCookie) },
      }),
      cfg,
    );
    expect(res1?.status).toBe(302);
    expect(res1?.headers.get("Location")).toBe("/app/auth/login?retry=1");

    const second = await doLogin(cfg, true);
    const res2 = await viewerFetch(
      new Request(`${ORIGIN}/app/auth/callback?code=good&state=${second.loc.searchParams.get("state")}`, {
        headers: { Cookie: cookiePair(second.stateCookie) },
      }),
      cfg,
    );
    expect(res2?.status).toBe(400);
    expect(await res2!.text()).toContain("no repo token reached the viewer");
  });

  it("logout clears the viewer session only (the IdP session is the IdP's)", async () => {
    const cfg = makeCfg();
    const res = await viewerFetch(new Request(`${ORIGIN}/app/auth/logout`, { method: "POST" }), cfg);
    expect(res?.status).toBe(302);
    const cookies = cookiesOf(res!);
    expect(cookies.some((c) => c.startsWith("life_view=;"))).toBe(true);
    expect(cookies.some((c) => c.startsWith("known_sso"))).toBe(false);
  });

  it("reports unconfigured deployments instead of redirecting", async () => {
    const cfg = makeCfg({ sessionSecret: undefined });
    const res = await viewerFetch(new Request(`${ORIGIN}/app/auth/login`), cfg);
    expect(res?.status).toBe(200);
    expect(await res!.text()).toContain("isn't configured");
  });
});
