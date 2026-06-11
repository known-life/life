import { describe, it, expect, afterEach, vi } from "vitest";
import {
  issueRegistryToken,
  verifyToken,
  issueSsoSession,
  verifySsoSession,
  SSO_COOKIE,
  SSO_COOKIE_TTL_S,
} from "../src/registry/lib/jwt";

// Genepool tokens are the ONLY credential for write endpoints (publish / setup /
// mcp / lifecycle / claim all gate on verifyToken). The token logic is HS256
// over a per-deployment key with issuer+audience bound to the origin. These
// tests pin: a genuine token round-trips, and every tamper/wrong-key/wrong-
// origin/expiry/cross-kind path is rejected.

const env = (over: Record<string, string> = {}) =>
  ({ JWT_SIGNING_KEY: "test-signing-key-deterministic", PUBLIC_URL: "https://known.life", ...over }) as any;

const SUB = "github:octocat";

describe("registry bearer — issue/verify round-trip", () => {
  it("verifies a freshly minted token back to its subject", async () => {
    const e = env();
    expect(await verifyToken(await issueRegistryToken(SUB, e), e)).toBe(SUB);
  });

  it("rejects a token signed with a different signing key", async () => {
    const tok = await issueRegistryToken(SUB, env({ JWT_SIGNING_KEY: "key-A" }));
    expect(await verifyToken(tok, env({ JWT_SIGNING_KEY: "key-B" }))).toBeNull();
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

  it("round-trips under the built-in dev defaults when env is unset", async () => {
    // getKey/origin fall back to a dev key + https://known.life; a token minted
    // and verified under the same (empty) env must still round-trip.
    const empty = {} as any;
    expect(await verifyToken(await issueRegistryToken(SUB, empty), empty)).toBe(SUB);
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
