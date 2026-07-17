import { describe, it, expect } from "vitest";
import { seal, open, s256, randomToken, b64urlEncode, b64urlDecode } from "../../.genome/viewer/src/crypto";
import { readSession } from "../../.genome/viewer/src/session";
import type { ViewerConfig } from "../../.genome/viewer/src/config";

const SECRET = "0123456789abcdef0123456789abcdef-test-secret"; // synthetic fixture, not a credential — gitleaks:allow

const cfg: ViewerConfig = {
  basePath: "/app",
  idpOrigin: "https://known.life",
  idpFetch: async () => new Response("{}"),
  sessionSecret: SECRET,
};

describe("viewer crypto", () => {
  it("seals and opens a round-trip value", async () => {
    const value = { login: "octocat", token: "gho_x", nested: { a: [1, 2, 3] } };
    const sealed = await seal(value, SECRET);
    expect(sealed).not.toContain("octocat");
    expect(await open(sealed, SECRET)).toEqual(value);
  });

  it("returns null on tamper, wrong key, and garbage", async () => {
    const sealed = await seal({ ok: true }, SECRET);
    const flipped = sealed.slice(0, -2) + (sealed.endsWith("A") ? "BB" : "AA");
    expect(await open(flipped, SECRET)).toBeNull();
    expect(await open(sealed, "another-secret-another-secret-32b")).toBeNull();
    expect(await open("not-a-token", SECRET)).toBeNull();
    expect(await open("", SECRET)).toBeNull();
  });

  it("b64url round-trips arbitrary bytes", () => {
    const bytes = new Uint8Array([0, 1, 250, 255, 128, 63]);
    expect(b64urlDecode(b64urlEncode(bytes))).toEqual(bytes);
  });

  it("computes the RFC 7636 S256 challenge", async () => {
    // Appendix B of RFC 7636.
    expect(await s256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("random tokens are unique and url-safe", () => {
    const a = randomToken();
    const b = randomToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("viewer session cookie", () => {
  it("reads back a valid session and rejects a stale one", async () => {
    const now = Math.floor(Date.now() / 1000);
    const good = await seal({ v: 1, login: "octocat", name: null, avatar: null, token: "gho_x", iat: now }, SECRET);
    const stale = await seal({ v: 1, login: "octocat", name: null, avatar: null, token: "gho_x", iat: now - 40 * 24 * 3600 }, SECRET);
    const reqWith = (c: string) => new Request("https://known.life/app", { headers: { Cookie: `life_view=${c}` } });
    expect((await readSession(reqWith(good), cfg))?.login).toBe("octocat");
    expect(await readSession(reqWith(stale), cfg)).toBeNull();
    expect(await readSession(new Request("https://known.life/app"), cfg)).toBeNull();
  });
});
