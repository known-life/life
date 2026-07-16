import { describe, it, expect, afterEach, vi } from "vitest";
import { handleAuthChallenge, handleAuthProve } from "../../.genome/registry/src/registry/routes/auth";
import { MockD1 } from "./d1-mock";
import { makeKey, type TestKey } from "./helpers";

// The lifekey sign-in: challenge → prove. The bug these pin: the challenge nonce
// used to live in a single per-login KV slot (last-write-wins), so two concurrent
// sign-ins as the same login clobbered each other and one/both proves failed.
// The fix stores one D1 row per challenge; prove accepts a signature over ANY of
// the login's outstanding nonces. The headline test is `concurrent` — it FAILS on
// the old single-slot design and passes on the multi-row one.

class MockKV {
  private m = new Map<string, string>();
  async get(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  async put(k: string, v: string) { this.m.set(k, v); }
  async delete(k: string) { this.m.delete(k); }
}

const SIGNING = "test-signing-key-deterministic-0123456789abcdef";
const env = (over: Record<string, unknown> = {}) =>
  ({ JWT_SIGNING_KEY: SIGNING, KNOWN_KV: new MockKV(), DB: new MockD1(), ...over }) as any;

// Stub github.com/<login>.keys (and the api.github.com/users id lookup) so the
// only key that verifies is the one we hand it.
function serveKeys(...lines: string[]) {
  globalThis.fetch = vi.fn(async (input: any) => {
    const url = String(input);
    if (url.includes("github.com") && url.endsWith(".keys")) return new Response(lines.join("\n"), { status: 200 });
    if (url.includes("api.github.com/users/")) return new Response(JSON.stringify({ id: 42, avatar_url: "a" }), { status: 200 });
    return new Response("not found", { status: 404 });
  }) as any;
}
afterEach(() => vi.restoreAllMocks());

const challenge = async (e: any, login: string): Promise<string> => {
  const res = await handleAuthChallenge(
    new Request("https://known.life/api/auth/challenge", { method: "POST", body: JSON.stringify({ login }) }), e);
  expect(res.status).toBe(200);
  return ((await res.json()) as { nonce: string }).nonce;
};
const prove = (e: any, login: string, signatures: string[]) =>
  handleAuthProve(new Request("https://known.life/api/auth/prove", { method: "POST", body: JSON.stringify({ login, signatures }) }), e);

describe("lifekey challenge/prove", () => {
  it("concurrent sign-ins for the same login BOTH succeed (the nonce-race fix)", async () => {
    const e = env();
    const key = await makeKey();
    serveKeys(key.opensshLine);
    // Two overlapping challenges (the deploy's parallel mint jobs) — two D1 rows,
    // no clobber. Each prove signs its own nonce; both must succeed.
    const nonceA = await challenge(e, "octocat");
    const nonceB = await challenge(e, "octocat");
    expect(nonceA).not.toBe(nonceB);
    const resA = await prove(e, "octocat", [await key.sign(nonceA)]);
    const resB = await prove(e, "octocat", [await key.sign(nonceB)]);
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    expect(((await resA.json()) as { token: string }).token).toBeTruthy();
  });

  it("a valid signature over the nonce proves identity (200 + token)", async () => {
    const e = env();
    const key = await makeKey();
    serveKeys(key.opensshLine);
    const nonce = await challenge(e, "octocat");
    const res = await prove(e, "octocat", [await key.sign(nonce)]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { github_login: string; token: string };
    expect(body.github_login).toBe("octocat");
    expect(body.token).toBeTruthy();
  });

  it("a consumed nonce can't be replayed (single-use)", async () => {
    const e = env();
    const key = await makeKey();
    serveKeys(key.opensshLine);
    const nonce = await challenge(e, "octocat");
    const sig = await key.sign(nonce);
    expect((await prove(e, "octocat", [sig])).status).toBe(200);
    const replay = await prove(e, "octocat", [sig]);
    expect(replay.status).toBe(400); // no rows left → no_pending_challenge
  });

  it("a signature from a key NOT on github.com/<login>.keys is rejected (403)", async () => {
    const e = env();
    const onKeys = await makeKey();
    const attacker = await makeKey();
    serveKeys(onKeys.opensshLine); // attacker's key is not served
    const nonce = await challenge(e, "octocat");
    const res = await prove(e, "octocat", [await attacker.sign(nonce)]);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("signature_invalid");
  });

  it("prove with no outstanding challenge → 400", async () => {
    const e = env();
    const key = await makeKey();
    serveKeys(key.opensshLine);
    const res = await prove(e, "octocat", [await key.sign("knl-never-issued")]);
    expect(res.status).toBe(400);
  });

  it("expired nonces are swept and don't authenticate", async () => {
    const e = env();
    const key = await makeKey();
    serveKeys(key.opensshLine);
    // Plant an expired row directly, then a fresh challenge triggers the sweep.
    const stale = "knl-stale";
    await e.DB.prepare("INSERT INTO auth_challenge (nonce, login, created_at) VALUES (?, ?, ?)")
      .bind(stale, "octocat", Math.floor(Date.now() / 1000) - 9999).run();
    await challenge(e, "octocat"); // sweeps created_at < now-300
    const gone = await e.DB.prepare("SELECT count(*) c FROM auth_challenge WHERE nonce = ?").bind(stale).first();
    expect((gone as { c: number }).c).toBe(0);
  });
});
