import { describe, it, expect, beforeEach } from "vitest";
import { handlePublish } from "../../.genome/registry/src/registry/routes/publish";
import { issueRegistryToken } from "../../.genome/registry/src/registry/lib/jwt";
import { insertVersion, getVersion } from "../../.genome/registry/src/registry/lib/db";
import { MockD1 } from "../../.genome/registry/tests/d1-mock.ts";

// POST /api/publish — the last gate before "published is forever". Every other
// surface in the pool is recoverable by publishing again; this one mints the
// artifact, so its refusals ARE the contract. Until now nothing drove the
// handler: the consumer rail covered the libs it composes (scan, jwt, trust
// store, db) and the gene's own suite covered the collision, but no test ever
// made a request and read the answer.
//
// It lives HERE rather than in the gene because publish imports jose (jwt),
// tweetnacl/blakejs (gh-secrets) and the Anthropic SDK (fit) — the runtime deps
// the gene declares and the CONSUMER provides. A gene-side test can prove any
// verb whose imports are self-contained (tests/resolve.test.ts does); this verb's
// are not, so the rail that has the deps is where its proof belongs.
//
// The assertions stop at the provenance gate on purpose. Everything before it is
// a pure decision about the request; the signature check itself is trust-store.test.ts's
// subject and re-driving it here would be a second copy of that contract.

const KEY = "test-signing-key-at-least-32-bytes-long!!";

function kv() {
  const store = new Map<string, string>();
  return {
    async get(k: string) { return store.get(k) ?? null; },
    async put(k: string, v: string) { store.set(k, v); },
  };
}

function r2() {
  const store = new Map<string, string>();
  return {
    async get(k: string) { return store.has(k) ? { text: async () => store.get(k)! } : null; },
    async head(k: string) { return store.has(k) ? {} : null; },
    async put(k: string, v: string) { store.set(k, v); },
  };
}

describe("POST /api/publish — the refusals are the contract", () => {
  let db: MockD1;
  const env = () => ({
    DB: db, KNOWN_KV: kv(), KNOWN_R2: r2(),
    JWT_SIGNING_KEY: KEY, PUBLIC_URL: "https://known.life",
  }) as any;

  const POST = async (body: unknown, token?: string) =>
    new Request("https://known.life/api/publish", {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: JSON.stringify(body),
    });

  const files = { ".life": "life: 1.0\nname: demo\n" };
  const good = { name: "demo", version: "1.0.0", files, provenance: { sig: "not-a-real-signature" } };

  let token: string;

  beforeEach(async () => {
    db = new MockD1();
    await db.prepare(
      "INSERT INTO accounts (id, email, created_at, github_login, handle) VALUES ('acct','github:1',1,'dom','dom')",
    ).bind().run();
    token = await issueRegistryToken("github:dom", env());
  });

  // `null` means "send no Authorization header" — distinct from omitting the
  // argument, which uses the signed-in token. A default parameter cannot express
  // that difference: passing `undefined` fires the default, so an anonymous-caller
  // test written that way silently authenticates and asserts the wrong gate.
  const publish = async (body: unknown, tok: string | null = token) =>
    handlePublish(await POST(body, tok ?? undefined), env());

  it("refuses an unauthenticated caller before reading the body", async () => {
    const res = await publish(good, null);
    expect(res.status).toBe(401);
    expect((await res.json() as any).error).toBe("unauthorized");
  });

  // A name in the pool is FOREVER — versioning is total, so a name accepted once
  // is resolvable always. These two gates are the only thing between the commons
  // and a name nobody can type.
  it("refuses an invalid name and an invalid version, each by its own error", async () => {
    const badName = await publish({ ...good, name: "Demo Gene" });
    expect(badName.status).toBe(400);
    expect((await badName.json() as any).error).toBe("invalid_name");

    const badVersion = await publish({ ...good, version: "1.0" });
    expect(badVersion.status).toBe(400);
    expect((await badVersion.json() as any).error).toBe("invalid_version");
  });

  it("refuses an empty publish rather than cutting an empty version", async () => {
    const res = await publish({ ...good, files: {} });
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toBe("no_files");
  });

  it("refuses a package over the size cap, and says what the cap is", async () => {
    const huge = { "big.mjs": "x".repeat(30 * 1024 * 1024) };
    const res = await publish({ ...good, files: huge });
    expect(res.status).toBe(413);
    const body = await res.json() as any;
    expect(body.error).toBe("too_large");
    expect(body.limit).toBeTruthy();
  });

  // First publish to a free name auto-claims it; a name someone else owns is a
  // 403 that NAMES the caller, because "not_owner" without a login is unactionable
  // for an agent holding two identities.
  it("refuses publishing to a name another identity owns", async () => {
    await db.prepare("INSERT INTO accounts (id, email, created_at, github_login, handle) VALUES ('other','github:2',1,'someone','someone')").bind().run();
    await db.prepare("INSERT INTO names (name, owner_account, created_at) VALUES ('taken','other',1)").bind().run();
    await db.prepare(
      "INSERT INTO packages (name, owner_account, latest_version, install_count, verified_state, created_at, updated_at) VALUES ('taken','other',NULL,0,'scanned',1,1)",
    ).bind().run();

    const res = await publish({ ...good, name: "taken" });
    expect(res.status).toBe(403);
    const body = await res.json() as any;
    expect(body.error).toBe("not_owner");
    expect(body.hint).toContain("dom");
  });

  // IMMUTABLE. The pre-check and the PRIMARY KEY collision must answer with the
  // SAME wire contract — a 409 `version_exists` — because the engine branches on
  // it. (The collision path is tests/publish-collision.test.mjs in the gene.)
  it("refuses a version that is already cut", async () => {
    await db.prepare("INSERT INTO names (name, owner_account, created_at) VALUES ('demo','acct',1)").bind().run();
    await db.prepare(
      "INSERT INTO packages (name, owner_account, latest_version, install_count, verified_state, created_at, updated_at) VALUES ('demo','acct','1.0.0',0,'scanned',1,1)",
    ).bind().run();
    await insertVersion(env(), {
      package: "demo", version: "1.0.0", content_hash: "h", manifest: {}, contract: null,
      requires: [], provides: [], imports: [], inputs: [], scan_json: "{}", fit_json: "{}",
      provenance_json: null, summary: null, description: null, author: null, license: null,
      homepage: null, repository: null, keywords: [], readme: null, bytes: 1,
      lines: { code: 0, test: 0, docs: 1, skill: 0, vendor: 0 }, symbols: [],
    });

    const res = await publish(good);
    expect(res.status).toBe(409);
    expect((await res.json() as any).error).toBe("version_exists");
  });

  // The compare-and-swap on `latest`. Without it, two sessions that both read
  // latest and both auto-bump publish over each other's intent — the read-then-write
  // race that the engine turns into "re-pull and retry" on this exact error.
  it("refuses when latest moved under a caller who declared what it based on", async () => {
    await db.prepare("INSERT INTO names (name, owner_account, created_at) VALUES ('demo','acct',1)").bind().run();
    await db.prepare(
      "INSERT INTO packages (name, owner_account, latest_version, install_count, verified_state, created_at, updated_at) VALUES ('demo','acct','2.0.0',0,'scanned',1,1)",
    ).bind().run();

    const res = await publish({ ...good, version: "1.0.1", expected_latest: "1.0.0" });
    expect(res.status).toBe(409);
    const body = await res.json() as any;
    expect(body.error).toBe("latest_moved");
    expect(body.current_latest).toBe("2.0.0");
  });

  // Provenance is REQUIRED on every publish. An unsigned one is refused with the
  // re-enrolment pointer rather than stored — a version nobody can attribute is
  // worse than one that never landed.
  it("refuses an unsigned publish and points at re-enrolment", async () => {
    const res = await publish({ name: "demo", version: "1.0.0", files });
    expect(res.status).toBe(422);
    const body = await res.json() as any;
    expect(body.error).toBe("provenance_required");
    expect(body.hint).toContain("life setup");
  });

  // Blocking, not advisory: publishing is public forever, so a secret in the
  // bytes must stop the publish rather than warn beside it.
  it("blocks a publish carrying a secret, before anything is stored", async () => {
    const leaky = { ".life": "life: 1.0\n", "config.mjs": 'export const k = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"\n' };
    const res = await publish({ ...good, files: leaky });
    expect(res.status).toBe(422);
    const body = await res.json() as any;
    expect(body.error).toBe("secrets_detected");
    expect(body.blocking.length).toBeGreaterThan(0);
    expect(await getVersion(env(), "demo", "1.0.0")).toBeNull();
  });
});
