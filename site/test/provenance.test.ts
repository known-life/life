import { describe, it, expect, beforeEach } from "vitest";
import { rawFromOpenSsh, verifyRaw } from "../../.genome/registry/src/registry/lib/lifekey-verify";
import { insertVersion, getVersion } from "../../.genome/registry/src/registry/lib/db";
import { MockD1 } from "./d1-mock";
import { makeKey } from "./helpers";

// Publisher-signed provenance (productionize/20): the publish route verifies an
// optional lifekey signature over the canonical statement
//   life-provenance-v1\n<name>@<version>\n<content_hash>
// against the caller's GitHub keys, stores it on the version row, and resolve
// serves it back — so a consumer can re-verify published bytes independently of
// the registry. These tests pin the two primitives the route composes: the
// statement/verify contract (shared with the engine's signing side), and the
// column round-trip over the real schema.

const statement = (name: string, version: string, hash: string) =>
  `life-provenance-v1\n${name}@${version}\n${hash}`;

describe("provenance statement — sign/verify contract", () => {
  it("a signature over the exact statement verifies against the signer's enrolled key", async () => {
    const k = await makeKey();
    const st = statement("demo", "1.0.0", "abc123");
    const sig = await k.sign(st);
    expect(await verifyRaw(rawFromOpenSsh(k.opensshLine)!, st, sig)).toBe(true);
  });

  it("the same signature over a DIFFERENT name@version or hash is refused (no replay)", async () => {
    const k = await makeKey();
    const sig = await k.sign(statement("demo", "1.0.0", "abc123"));
    const raw = rawFromOpenSsh(k.opensshLine)!;
    for (const st of [
      statement("other", "1.0.0", "abc123"),   // another gene
      statement("demo", "1.0.1", "abc123"),    // another version
      statement("demo", "1.0.0", "tampered"),  // other bytes
    ]) {
      expect(await verifyRaw(raw, st, sig)).toBe(false);
    }
  });

  it("a signature by a key that is not the enrolled one is refused", async () => {
    const k = await makeKey();
    const other = await makeKey();
    const st = statement("demo", "1.0.0", "abc123");
    const sig = await k.sign(st);
    expect(await verifyRaw(rawFromOpenSsh(other.opensshLine)!, st, sig)).toBe(false);
  });
});

describe("provenance column — round-trips the version row", () => {
  let db: MockD1;
  const env = () => ({ DB: db }) as any;
  beforeEach(async () => {
    db = new MockD1();
    await db.prepare("INSERT INTO accounts (id, email, created_at) VALUES ('acct','a@b.c',1)").bind().run();
    await db.prepare("INSERT INTO names (name, owner_account, created_at) VALUES ('demo','acct',1)").bind().run();
    await db.prepare(
      "INSERT INTO packages (name, owner_account, latest_version, install_count, verified_state, created_at, updated_at) " +
      "VALUES ('demo','acct',NULL,0,'scanned',1,1)",
    ).bind().run();
  });

  const input = (version: string, provenance_json: string | null) => ({
    package: "demo", version, content_hash: "h", manifest: {}, contract: null,
    requires: [], provides: [], imports: [], inputs: [], scan_json: "{}", fit_json: "{}",
    provenance_json, summary: null, description: null, author: null, license: null,
    homepage: null, repository: null, keywords: [], readme: null, bytes: 1,
  });

  it("a signed publish stores {v,login,sig,key} and reads it back", async () => {
    const prov = JSON.stringify({ v: 1, login: "someone", sig: "c2ln", key: "ssh-ed25519 AAAA" });
    await insertVersion(env(), input("1.0.0", prov));
    const row = await getVersion(env(), "demo", "1.0.0");
    expect(row?.provenance_json).toBe(prov);
    expect(JSON.parse(row!.provenance_json!)).toMatchObject({ v: 1, login: "someone" });
  });

  it("an unsigned publish stores null (the whole pre-provenance pool stays valid)", async () => {
    await insertVersion(env(), input("1.0.1", null));
    const row = await getVersion(env(), "demo", "1.0.1");
    expect(row?.provenance_json).toBeNull();
  });
});
