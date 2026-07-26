import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  trustedKeysFor,
  verifyAgainstTrustStore,
  enrolmentPair,
  K_AUTHPATH,
  K_LIFEKEY,
  K_LIFEKEY_LOGIN,
  K_LIFEKEY_REC,
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

// A GitHub `owner/repo` is case-insensitive — `DomVinyard/life` and
// `domvinyard/life` are one repo — but a KV key is bytes, so an un-normalized
// enrolment key made the store answer "not enrolled" for the repo it holds,
// decided only by how the caller spelled it. Live on 2026-07-26: the enrolment sat
// at `lifekey:rec:DomVinyard/life` while `cf:grant:` on the same store had always
// lowercased, so the two halves of one auth chain disagreed — the data plane, whose
// config spells the slug lowercase, got `not_enrolled` from prove for its own
// identity, and the whole /v1/infra family was dead. It also cost a design
// decision: a probe that lowercased the slug read as "this repo isn't enrolled",
// and two workers were built on pinned key literals because of it.
describe("enrolment keys are case-normalized (the slug is a repo, not bytes)", () => {
  let k: TestKey;
  beforeEach(async () => { k = await makeKey(); ownerKeys = ""; });

  it.each([
    ["the spelling it was written with", "DomVinyard/life"],
    ["all lower case", "domvinyard/life"],
    ["all upper case", "DOMVINYARD/LIFE"],
    ["mixed the other way", "domVinyard/Life"],
  ])("a record written as DomVinyard/life is found when asked with %s", async (_label, asked) => {
    const kv = makeKV();
    // Write through the same key builder a real enrolment uses.
    await kv.put(K_LIFEKEY_REC("DomVinyard/life"), JSON.stringify({ pubkey: k.opensshLine, login: "DomVinyard" }));
    const pair = await enrolmentPair(env(kv), asked);
    expect(pair.pubkey).toBe(k.opensshLine);
    // The DISPLAY case survives in the record's login — normalizing the KEY loses nothing.
    expect(pair.login).toBe("DomVinyard");
    const keys = await trustedKeysFor(env(kv), { repo: asked });
    expect(keys.map((t) => t.key)).toEqual([k.opensshLine]);
  });

  it("the legacy pub/login pair normalizes the same way", async () => {
    const kv = makeKV();
    await kv.put(K_LIFEKEY("Org/Repo"), k.opensshLine);
    await kv.put(K_LIFEKEY_LOGIN("Org/Repo"), "Alice");
    const pair = await enrolmentPair(env(kv), "org/repo");
    expect(pair.pubkey).toBe(k.opensshLine);
    expect(pair.login).toBe("Alice");
  });

  it("a DIFFERENT repo is still not enrolled — normalizing must not widen the match", async () => {
    const kv = makeKV();
    await kv.put(K_LIFEKEY_REC("DomVinyard/life"), JSON.stringify({ pubkey: k.opensshLine, login: "DomVinyard" }));
    expect((await enrolmentPair(env(kv), "domvinyard/other")).pubkey).toBeNull();
    expect(await trustedKeysFor(env(kv), { repo: "someone/life" })).toEqual([]);
  });
});
