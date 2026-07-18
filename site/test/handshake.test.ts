import { describe, it, expect, afterEach, vi } from "vitest";
import { handleHandshakeNonce, handleHandshakeProve } from "../../.genome/registry/src/registry/routes/handshake";
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

// Stub outbound fetch: the api.github.com/users id lookup that runs after a
// successful prove. github.com/.keys left the trust chain (secrets-4 tranche D)
// — nothing here serves keys; identity comes only from the enrolment records.
function stubGithub() {
  globalThis.fetch = vi.fn(async (input: any) => {
    const url = String(input);
    if (url.includes("api.github.com/users/")) return new Response(JSON.stringify({ id: 42, avatar_url: "a" }), { status: 200 });
    return new Response("not found", { status: 404 });
  }) as any;
}
afterEach(() => vi.restoreAllMocks());

const challenge = async (e: any, login: string): Promise<string> => {
  const res = await handleHandshakeNonce(
    new Request("https://known.life/api/handshake/nonce", { method: "POST", body: JSON.stringify({ login }) }), e);
  expect(res.status).toBe(200);
  return ((await res.json()) as { nonce: string }).nonce;
};
const prove = (e: any, login: string, signatures: string[], repo?: string) =>
  handleHandshakeProve(new Request("https://known.life/api/handshake/prove", { method: "POST", body: JSON.stringify({ login, repo, signatures }) }), e);

describe("lifekey challenge/prove", () => {
  const enrol = async (e: any, repo: string, key: TestKey, login?: string) => {
    await e.KNOWN_KV.put(`lifekey:pub:${repo}`, key.opensshLine);
    if (login) await e.KNOWN_KV.put(`lifekey:login:${repo}`, login);
  };
  const REPO = "octocat/dotfiles";

  it("concurrent sign-ins for the same login BOTH succeed (the nonce-race fix)", async () => {
    const e = env();
    const key = await makeKey();
    stubGithub();
    await enrol(e, REPO, key, "octocat");
    // Two overlapping challenges (the deploy's parallel mint jobs) — two D1 rows,
    // no clobber. Each prove signs its own nonce; both must succeed.
    const nonceA = await challenge(e, "octocat");
    const nonceB = await challenge(e, "octocat");
    expect(nonceA).not.toBe(nonceB);
    const resA = await prove(e, "octocat", [await key.sign(nonceA)], REPO);
    const resB = await prove(e, "octocat", [await key.sign(nonceB)], REPO);
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    expect(((await resA.json()) as { token: string }).token).toBeTruthy();
  });

  it("a valid signature over the nonce proves identity (200 + token)", async () => {
    const e = env();
    const key = await makeKey();
    stubGithub();
    await enrol(e, REPO, key, "octocat");
    const nonce = await challenge(e, "octocat");
    const res = await prove(e, "octocat", [await key.sign(nonce)], REPO);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { github_login: string; token: string };
    expect(body.github_login).toBe("octocat");
    expect(body.token).toBeTruthy();
  });

  it("a consumed nonce can't be replayed (single-use)", async () => {
    const e = env();
    const key = await makeKey();
    stubGithub();
    await enrol(e, REPO, key, "octocat");
    const nonce = await challenge(e, "octocat");
    const sig = await key.sign(nonce);
    expect((await prove(e, "octocat", [sig], REPO)).status).toBe(200);
    const replay = await prove(e, "octocat", [sig], REPO);
    expect(replay.status).toBe(400); // no rows left → no_pending_challenge
  });

  it("a login-only prove (no repo) can never authenticate — .keys left the trust chain (403)", async () => {
    const e = env();
    const key = await makeKey();
    stubGithub();
    await enrol(e, REPO, key, "octocat"); // enrolled, but the request names no repo
    const nonce = await challenge(e, "octocat");
    const res = await prove(e, "octocat", [await key.sign(nonce)]);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("signature_invalid");
  });

  it("prove with no outstanding challenge → 400", async () => {
    const e = env();
    const key = await makeKey();
    stubGithub();
    await enrol(e, REPO, key, "octocat");
    const res = await prove(e, "octocat", [await key.sign("knl-never-issued")], REPO);
    expect(res.status).toBe(400);
  });

  // ── the enrolment binding rules ──
  it("web-only/org: the repo-enrolled key proves identity with EMPTY .keys (200 + token)", async () => {
    const e = env();
    const key = await makeKey();
    stubGithub();
    await enrol(e, "attn-st6/studio", key, "octocat");
    const nonce = await challenge(e, "octocat");
    const res = await prove(e, "octocat", [await key.sign(nonce)], "attn-st6/studio");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { token: string }).token).toBeTruthy();
  });

  it("an enrolled key WITHOUT a recorded login cannot mint (403 — the identity binding is required)", async () => {
    const e = env();
    const key = await makeKey();
    stubGithub();
    await enrol(e, "attn-st6/studio", key); // pre-change enrolment: pubkey only
    const nonce = await challenge(e, "octocat");
    const res = await prove(e, "octocat", [await key.sign(nonce)], "attn-st6/studio");
    expect(res.status).toBe(403);
  });

  it("an enrolled key cannot mint a DIFFERENT login than the one that enrolled it (403)", async () => {
    const e = env();
    const key = await makeKey();
    stubGithub();
    await enrol(e, "attn-st6/studio", key, "octocat");
    const nonce = await challenge(e, "mallory");
    const res = await prove(e, "mallory", [await key.sign(nonce)], "attn-st6/studio");
    expect(res.status).toBe(403);
  });

  it("a signature NOT by the enrolled key is rejected on the enrolled path (403)", async () => {
    const e = env();
    const enrolled = await makeKey();
    const attacker = await makeKey();
    stubGithub();
    await enrol(e, "attn-st6/studio", enrolled, "octocat");
    const nonce = await challenge(e, "octocat");
    const res = await prove(e, "octocat", [await attacker.sign(nonce)], "attn-st6/studio");
    expect(res.status).toBe(403);
  });

  it("expired nonces are swept and don't authenticate", async () => {
    const e = env();
    const key = await makeKey();
    stubGithub();
    await enrol(e, REPO, key, "octocat");
    // Plant an expired row directly, then a fresh challenge triggers the sweep.
    const stale = "knl-stale";
    await e.DB.prepare("INSERT INTO auth_challenge (nonce, login, created_at) VALUES (?, ?, ?)")
      .bind(stale, "octocat", Math.floor(Date.now() / 1000) - 9999).run();
    await challenge(e, "octocat"); // sweeps created_at < now-300
    const gone = await e.DB.prepare("SELECT count(*) c FROM auth_challenge WHERE nonce = ?").bind(stale).first();
    expect((gone as { c: number }).c).toBe(0);
  });
});
