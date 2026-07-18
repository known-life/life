import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  trustedKeysFor,
  verifyAgainstTrustStore,
  K_AUTHPATH,
  logAuthDecision,
} from "../../.genome/registry/src/registry/lib/trust-store";
import { makeKey, type TestKey } from "./helpers";

// The trust store is the ONE answer to "which public keys may speak for this
// principal?" — consumed by the handshake (prove + /exchange caller-auth) and
// the provenance check. Its ONE source is the enrolment record (github.com/.keys
// left the trust chain in the secrets-4 sunset). These tests pin the admission
// rules and the regression the extraction exists to prevent: a provenance-style
// statement verifying via the ENROLLED key with nothing on github (the studio
// bad_provenance bug — the pre-trust-store verifier read only .keys).

function makeKV(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed));
  return {
    async get(k: string) { return store.get(k) ?? null; },
    async put(k: string, v: string) { store.set(k, v); },
    async delete(k: string) { store.delete(k); },
  };
}

let ownerKeys = "";
beforeEach(() => {
  vi.stubGlobal("fetch", async (url: string | URL) => {
    const u = String(url);
    if (/github\.com\/.*\.keys$/.test(u)) return new Response(ownerKeys);
    throw new Error(`unexpected fetch in trust-store test: ${u}`);
  });
});
afterEach(() => vi.unstubAllGlobals());

const env = (kv: ReturnType<typeof makeKV>) => ({ KNOWN_KV: kv }) as any;

describe("trustedKeysFor — admission rules", () => {
  let k: TestKey;
  beforeEach(async () => { k = await makeKey(); ownerKeys = ""; });

  it("admits the enrolled key when the claimed login matches the enrolment record", async () => {
    const kv = makeKV({ "lifekey:pub:org/r": k.opensshLine, "lifekey:login:org/r": "Alice" });
    const keys = await trustedKeysFor(env(kv), { login: "alice", repo: "org/r" });
    expect(keys).toHaveLength(1);
    expect(keys[0].source).toBe("enrolled");
  });

  it("refuses the enrolled key for a login other than the one that enrolled it", async () => {
    const kv = makeKV({ "lifekey:pub:org/r": k.opensshLine, "lifekey:login:org/r": "alice" });
    const keys = await trustedKeysFor(env(kv), { login: "mallory", repo: "org/r" });
    expect(keys.filter((x) => x.source === "enrolled")).toHaveLength(0);
  });

  it("repo-only (no login claim) resolves the enrolled key alone — the /exchange flavor", async () => {
    const kv = makeKV({ "lifekey:pub:org/r": k.opensshLine, "lifekey:login:org/r": "alice" });
    const keys = await trustedKeysFor(env(kv), { repo: "org/r" });
    expect(keys.map((x) => x.source)).toEqual(["enrolled"]);
  });

});

describe("verifyAgainstTrustStore — the provenance regression pin", () => {
  it("a statement signed by the enrolled key verifies with EMPTY .keys (web-only/org .life attests)", async () => {
    const k = await makeKey();
    ownerKeys = ""; // nothing on github.com/<login>.keys — the studio situation
    const kv = makeKV({ "lifekey:pub:attn-st6/studio": k.opensshLine, "lifekey:login:attn-st6/studio": "someone" });
    const statement = "life-provenance-v1\ndemo@1.0.0\nabc123";
    const sig = await k.sign(statement);
    const res = await verifyAgainstTrustStore(env(kv), { login: "someone", repo: "attn-st6/studio" }, statement, sig);
    expect(res).toMatchObject({ ok: true, source: "enrolled" });
  });

  it("refuses when no enrolment exists for the principal (.keys is no longer a source)", async () => {
    const k = await makeKey();
    const res = await verifyAgainstTrustStore(env(makeKV()), { login: "someone", repo: "someone/repo" }, "msg", await k.sign("msg"));
    expect(res.ok).toBe(false);
  });
});

describe("logAuthDecision — the .keys sunset's read-zero counters", () => {
  it("an accept bumps the per-(source, surface) counter; a refusal does not", async () => {
    const kv = makeKV();
    const e = env(kv);
    await logAuthDecision(e, { surface: "prove", outcome: "ok", source: "enrolled", login: "a" });
    await logAuthDecision(e, { surface: "prove", outcome: "ok", source: "enrolled", login: "a" });
    await logAuthDecision(e, { surface: "prove", outcome: "refused", login: "a", reason: "x" });
    const row = JSON.parse((await kv.get(K_AUTHPATH("enrolled", "prove")))!);
    expect(row.count).toBe(2);
    expect(typeof row.last).toBe("string");
    expect(await kv.get(K_AUTHPATH("enrolled", "exchange"))).toBeNull();
  });
});
