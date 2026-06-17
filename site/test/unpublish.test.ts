import { describe, it, expect, beforeEach } from "vitest";
import { downloadsByVersion, dependentsOf, unpublishVersion, getVersion, highestVersion } from "../src/registry/lib/db";
import { MockD1 } from "./d1-mock";

// unpublish lost its arbitrary 72h time window (lifecycle.ts) — you own your
// genes and may hard-remove any version at any age. The ONE guard left is
// use-based: a version is refused only if another life has it locked (an install
// of that EXACT version) or another gene imports the package. These tests pin the
// two primitives that guard composes (downloadsByVersion, dependentsOf) over the
// real schema, plus the clean-delete cascade unpublishVersion performs.

const env = (db: MockD1) => ({ DB: db }) as any;

let db: MockD1;
beforeEach(async () => {
  db = new MockD1();
  db.raw("PRAGMA foreign_keys = ON");
  // accounts ← names ← packages ← versions
  await db.prepare("INSERT INTO accounts (id, email, created_at) VALUES ('acct','a@b.c',1)").bind().run();
  await db.prepare("INSERT INTO names (name, owner_account, created_at) VALUES ('demo','acct',1)").bind().run();
  await db.prepare(
    "INSERT INTO packages (name, owner_account, latest_version, install_count, verified_state, created_at, updated_at) " +
    "VALUES ('demo','acct','1.1.0',0,'scanned',1,1)",
  ).bind().run();
  for (const v of ["1.0.0", "1.1.0"]) {
    await db.prepare(
      "INSERT INTO versions (package, version, content_hash, manifest_json, published_at, yanked) VALUES ('demo',?,'h','{}',1,0)",
    ).bind(v).run();
  }
});

describe("unpublish guard primitives", () => {
  it("a version nobody installed reads zero — the guard lets it through", async () => {
    expect((await downloadsByVersion(env(db), "demo"))["1.0.0"] ?? 0).toBe(0);
    expect(await dependentsOf(env(db), "demo")).toEqual([]);
  });

  it("a version a life has locked reads >0 — the guard refuses it", async () => {
    await db.prepare(
      "INSERT INTO install_lives (package, version, life_id, first_at) VALUES ('demo','1.1.0','life-x',1)",
    ).bind().run();
    expect((await downloadsByVersion(env(db), "demo"))["1.1.0"] ?? 0).toBe(1);
    // a different version is still free
    expect((await downloadsByVersion(env(db), "demo"))["1.0.0"] ?? 0).toBe(0);
  });

  it("a gene that imports the package is a dependent — the guard refuses it", async () => {
    await db.prepare("INSERT INTO names (name, owner_account, created_at) VALUES ('consumer','acct',1)").bind().run();
    await db.prepare(
      "INSERT INTO packages (name, owner_account, latest_version, install_count, verified_state, created_at, updated_at) " +
      "VALUES ('consumer','acct','1.0.0',0,'scanned',1,1)",
    ).bind().run();
    await db.prepare("INSERT INTO versions (package, version, content_hash, manifest_json, published_at, yanked) VALUES ('consumer','1.0.0','h','{}',1,0)").bind().run();
    await db.prepare("INSERT INTO deps (package, version, dep_name, dep_range) VALUES ('consumer','1.0.0','demo','^1.0.0')").bind().run();
    expect(await dependentsOf(env(db), "demo")).toContain("consumer");
  });

  it("unpublishing a clean version deletes it and flips latest back", async () => {
    await unpublishVersion(env(db), "demo", "1.1.0");
    expect(await getVersion(env(db), "demo", "1.1.0")).toBeNull();
    expect(await highestVersion(env(db), "demo")).toBe("1.0.0");
  });
});
