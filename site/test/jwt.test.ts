import { describe, it, expect, afterEach, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { jwtVerify, importJWK } from "jose";
import {
  issueRegistryToken,
  verifyToken,
  issueSsoSession,
  verifySsoSession,
  issueIdentityToken,
  identityJwks,
  IDENTITY_AUD,
  SSO_COOKIE,
  SSO_COOKIE_TTL_S,
} from "../../.genome/registry/src/registry/lib/jwt";

// Genepool tokens are the ONLY credential for write endpoints (publish / setup /
// mcp / lifecycle / claim all gate on verifyToken). The token logic is HS256
// over a per-deployment key with issuer+audience bound to the origin. These
// tests pin: a genuine token round-trips, and every tamper/wrong-key/wrong-
// origin/expiry/cross-kind path is rejected.

const env = (over: Record<string, string> = {}) =>
  ({ JWT_SIGNING_KEY: "test-signing-key-deterministic-0123456789abcdef", PUBLIC_URL: "https://known.life", ...over }) as any;

const SUB = "github:octocat";

describe("registry bearer — issue/verify round-trip", () => {
  it("verifies a freshly minted token back to its subject", async () => {
    const e = env();
    expect(await verifyToken(await issueRegistryToken(SUB, e), e)).toBe(SUB);
  });

  it("rejects a token signed with a different signing key", async () => {
    const tok = await issueRegistryToken(SUB, env({ JWT_SIGNING_KEY: "key-A-padded-to-at-least-thirty-two-bytes-aaaa" }));
    expect(await verifyToken(tok, env({ JWT_SIGNING_KEY: "key-B-padded-to-at-least-thirty-two-bytes-bbbb" }))).toBeNull();
  });

  it("fails CLOSED with no signing key — verify returns null, issue throws (no insecure fallback)", async () => {
    const noKey = { PUBLIC_URL: "https://known.life" } as any;
    // A real token, but verified in an env with no key → must not validate.
    const tok = await issueRegistryToken(SUB, env());
    expect(await verifyToken(tok, noKey)).toBeNull();
    await expect(issueRegistryToken(SUB, noKey)).rejects.toThrow(/JWT_SIGNING_KEY/);
    // A too-short key is also refused (the old code zero-padded it — insecure).
    await expect(issueRegistryToken(SUB, env({ JWT_SIGNING_KEY: "short" }))).rejects.toThrow(/under 32 bytes/);
  });

  it("rejects a token minted for a different origin (issuer/audience bound)", async () => {
    const tok = await issueRegistryToken(SUB, env({ PUBLIC_URL: "https://evil.example" }));
    expect(await verifyToken(tok, env({ PUBLIC_URL: "https://known.life" }))).toBeNull();
  });

  it("rejects a tampered token", async () => {
    const e = env();
    const tok = await issueRegistryToken(SUB, e);
    const [h, p, s] = tok.split(".");
    // flip a character in the payload segment
    const bad = `${h}.${p.slice(0, -1)}${p.slice(-1) === "A" ? "B" : "A"}.${s}`;
    expect(await verifyToken(bad, e)).toBeNull();
  });

  it("rejects structurally invalid garbage", async () => {
    const e = env();
    for (const junk of ["", "not-a-jwt", "a.b.c", "....", "Bearer x"]) {
      expect(await verifyToken(junk, e)).toBeNull();
    }
  });

  it("refuses to mint under an empty env — no insecure dev-key fallback", async () => {
    // There is deliberately NO fallback signing key. A deploy that forgets
    // JWT_SIGNING_KEY fails closed (mint throws, verify returns null) rather
    // than silently signing with a constant anyone could forge against.
    const empty = {} as any;
    await expect(issueRegistryToken(SUB, empty)).rejects.toThrow(/JWT_SIGNING_KEY/);
  });

  it("exposes the SSO cookie name and TTL", () => {
    expect(SSO_COOKIE).toBe("known_sso");
    expect(SSO_COOKIE_TTL_S).toBe(30 * 24 * 60 * 60);
  });

  it("rejects an expired token", async () => {
    vi.useFakeTimers();
    try {
      const e = env();
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const tok = await issueRegistryToken(SUB, e);
      expect(await verifyToken(tok, e)).toBe(SUB); // valid now
      vi.setSystemTime(new Date("2026-01-01T02:00:00Z")); // +2h, past the 1h TTL
      expect(await verifyToken(tok, e)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("SSO session — issue/verify round-trip", () => {
  it("verifies a freshly minted SSO session back to its subject", async () => {
    const e = env();
    expect(await verifySsoSession(await issueSsoSession(SUB, e), e)).toBe(SUB);
  });
});

describe("cross-kind replay is impossible (the two token kinds never substitute)", () => {
  // jwt.ts's stated invariant: "an SSO cookie can never be replayed as an API
  // bearer." Same key/issuer/audience sign both, so only the explicit kind check
  // separates them. These two assertions are that invariant, both directions.
  it("an SSO session token is NOT accepted as a registry bearer", async () => {
    const e = env();
    const sso = await issueSsoSession(SUB, e);
    expect(await verifyToken(sso, e)).toBeNull();
  });

  it("a registry bearer is NOT accepted as an SSO session", async () => {
    const e = env();
    const bearer = await issueRegistryToken(SUB, e);
    expect(await verifySsoSession(bearer, e)).toBeNull();
  });
});

describe("identity tokens — the IdP's asymmetric anchor (registry@0.8.0)", () => {
  // The Ed25519 IDENTITY_PRIVATE_KEY signs long-lived identity tokens any data
  // plane verifies via GET /jwks — no shared secret. These pin the contract:
  // token verifies against the served JWKS (right issuer/audience/subject), the
  // JWKS never leaks the private scalar, and an unset/malformed key disables
  // the feature entirely (null token, empty JWKS) rather than half-working.
  const pem = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  it("mints an EdDSA identity token the served JWKS verifies", async () => {
    const e = env({ IDENTITY_PRIVATE_KEY: pem });
    const tok = await issueIdentityToken(SUB, e);
    expect(tok).toBeTruthy();
    const jwks = await identityJwks(e);
    expect(jwks.keys).toHaveLength(1);
    const key = await importJWK(jwks.keys[0] as any, "EdDSA");
    const { payload, protectedHeader } = await jwtVerify(tok!, key, {
      issuer: "https://known.life",
      audience: IDENTITY_AUD,
    });
    expect(payload.sub).toBe(SUB);
    expect(protectedHeader.alg).toBe("EdDSA");
  });

  it("the served JWKS never contains the private scalar", async () => {
    const jwks = await identityJwks(env({ IDENTITY_PRIVATE_KEY: pem }));
    expect((jwks.keys[0] as Record<string, unknown>).d).toBeUndefined();
  });

  it("unset key disables the feature: null token, empty JWKS", async () => {
    const e = env();
    expect(await issueIdentityToken(SUB, e)).toBeNull();
    expect((await identityJwks(e)).keys).toHaveLength(0);
  });

  it("a malformed key disables the feature, never half-signs", async () => {
    const e = env({ IDENTITY_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nnot-a-key\n-----END PRIVATE KEY-----" });
    expect(await issueIdentityToken(SUB, e)).toBeNull();
    expect((await identityJwks(e)).keys).toHaveLength(0);
  });
});
