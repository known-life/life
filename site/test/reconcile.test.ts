import { describe, it, expect, beforeEach } from "vitest";
import { reconcileLifeInstalls, downloadsByVersion, getPackage } from "../src/registry/lib/db";
import { MockD1 } from "./d1-mock";

const env = (db: MockD1) => ({ DB: db }) as any;

let db: MockD1;
beforeEach(async () => {
  db = new MockD1();
  db.raw("PRAGMA foreign_keys = ON");
  await db.prepare("INSERT INTO accounts (id, email, created_at) VALUES ('acct','a@b.c',1)").bind().run();
  await db.prepare("INSERT INTO names (name, owner_account, created_at) VALUES ('demo','acct',1)").bind().run();
  await db.prepare(
    "INSERT INTO packages (name, owner_account, latest_version, install_count, verified_state, created_at, updated_at) " +
    "VALUES ('demo','acct','1.1.0',0,'scanned',1,1)",
  ).bind().run();
  await db.prepare("INSERT INTO versions (package, version, content_hash, manifest_json, published_at, yanked) VALUES ('demo','1.1.0','h','{}',1,0)").bind().run();
});

describe("reconcileLifeInstalls — the shed self-heal", () => {
  it("a life that shed the gene stops blocking withdraw: its stale row is dropped and the count recomputes to 0", async () => {
    await db.prepare("INSERT INTO install_lives (package, version, life_id, first_at) VALUES ('demo','1.1.0','life-x',1)").bind().run();
    await db.prepare("UPDATE packages SET install_count = 1 WHERE name = 'demo'").bind().run();
    expect((await downloadsByVersion(env(db), "demo"))["1.1.0"] ?? 0).toBe(1);

    const { removed } = await reconcileLifeInstalls(env(db), "life-x", []);
    expect(removed).toBe(1);

    expect((await downloadsByVersion(env(db), "demo"))["1.1.0"] ?? 0).toBe(0);
    expect((await getPackage(env(db), "demo"))!.install_count).toBe(0);
  });

  it("a still-held pin is preserved — reconcile only drops what the life let go", async () => {
    await db.prepare("INSERT INTO versions (package, version, content_hash, manifest_json, published_at, yanked) VALUES ('demo','1.0.0','h','{}',1,0)").bind().run();
    await db.prepare("INSERT INTO install_lives (package, version, life_id, first_at) VALUES ('demo','1.0.0','life-x',1)").bind().run();
    await db.prepare("INSERT INTO install_lives (package, version, life_id, first_at) VALUES ('demo','1.1.0','life-x',1)").bind().run();

    const { removed } = await reconcileLifeInstalls(env(db), "life-x", [{ package: "demo", version: "1.1.0" }]);
    expect(removed).toBe(1);
    expect((await downloadsByVersion(env(db), "demo"))["1.0.0"] ?? 0).toBe(0);
    expect((await downloadsByVersion(env(db), "demo"))["1.1.0"] ?? 0).toBe(1);
  });

  it("only the reporting life's rows are touched — another life still standing keeps blocking", async () => {
    await db.prepare("INSERT INTO install_lives (package, version, life_id, first_at) VALUES ('demo','1.1.0','life-x',1)").bind().run();
    await db.prepare("INSERT INTO install_lives (package, version, life_id, first_at) VALUES ('demo','1.1.0','life-y',1)").bind().run();
    await db.prepare("UPDATE packages SET install_count = 2 WHERE name = 'demo'").bind().run();

    const { removed } = await reconcileLifeInstalls(env(db), "life-x", []);
    expect(removed).toBe(1);
    expect((await downloadsByVersion(env(db), "demo"))["1.1.0"] ?? 0).toBe(1);
    expect((await getPackage(env(db), "demo"))!.install_count).toBe(1);
  });

  it("a no-op reconcile (nothing shed) removes nothing", async () => {
    await db.prepare("INSERT INTO install_lives (package, version, life_id, first_at) VALUES ('demo','1.1.0','life-x',1)").bind().run();
    const { removed } = await reconcileLifeInstalls(env(db), "life-x", [{ package: "demo", version: "1.1.0" }]);
    expect(removed).toBe(0);
    expect((await downloadsByVersion(env(db), "demo"))["1.1.0"] ?? 0).toBe(1);
  });
});
