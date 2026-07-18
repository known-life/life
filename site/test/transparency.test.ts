import { describe, it, expect, beforeEach } from "vitest";
import { handleIndex } from "../../.genome/registry/src/registry/routes/transparency";
import { MockD1 } from "./d1-mock";

// The transparency index (productionize/21): the full public record of every
// cut version — package, version, content_hash, published_at, yanked, signer —
// deterministic for a given registry state (stable order, no timestamp), so the
// public mirror's diff gate commits only real registry changes and its git
// history reads as an append-only log.

describe("GET /api/index — the transparency index", () => {
  let db: MockD1;
  const env = () => ({ DB: db }) as any;
  beforeEach(async () => {
    db = new MockD1();
    await db.prepare("INSERT INTO accounts (id, email, created_at) VALUES ('acct','a@b.c',1)").bind().run();
    for (const name of ["beta", "alpha"]) {
      await db.prepare("INSERT INTO names (name, owner_account, created_at) VALUES (?,'acct',1)").bind(name).run();
      await db.prepare(
        "INSERT INTO packages (name, owner_account, latest_version, install_count, verified_state, created_at, updated_at) " +
        "VALUES (?,'acct','1.0.0',0,'scanned',1,1)",
      ).bind(name).run();
    }
    const prov = JSON.stringify({ v: 1, login: "someone", sig: "c2ln", key: "k" });
    await db.prepare("INSERT INTO versions (package, version, content_hash, manifest_json, published_at, yanked, provenance_json) VALUES ('beta','1.0.0','h-b1','{}',3,0,?)").bind(prov).run();
    await db.prepare("INSERT INTO versions (package, version, content_hash, manifest_json, published_at, yanked) VALUES ('alpha','1.0.0','h-a1','{}',1,0)").bind().run();
    await db.prepare("INSERT INTO versions (package, version, content_hash, manifest_json, published_at, yanked) VALUES ('alpha','1.1.0','h-a2','{}',2,1)").bind().run();
  });

  it("serves every version with hash, yank state, and signer, in stable order", async () => {
    const res = await handleIndex(new Request("https://x/api/index"), env());
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.count).toBe(3);
    expect(body.versions.map((v: any) => `${v.package}@${v.version}`))
      .toEqual(["alpha@1.0.0", "alpha@1.1.0", "beta@1.0.0"]);
    expect(body.versions[0]).toMatchObject({ content_hash: "h-a1", yanked: false, signer: null });
    expect(body.versions[1]).toMatchObject({ yanked: true });
    expect(body.versions[2]).toMatchObject({ content_hash: "h-b1", signer: "someone" });
  });

  it("is deterministic — two renders of the same state are byte-identical (no timestamp)", async () => {
    const a = await (await handleIndex(new Request("https://x/api/index"), env())).text();
    const b = await (await handleIndex(new Request("https://x/api/index"), env())).text();
    expect(a).toBe(b);
  });
});
