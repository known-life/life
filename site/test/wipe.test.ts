import { describe, it, expect, beforeEach } from "vitest";
import { wipeName, getPackage } from "../../.genome/registry/src/registry/lib/db";
import { MockD1 } from "./d1-mock";

// `--delete` (wipeName) hard-removes a gene and every row attached to it. The
// embeddings table has `package REFERENCES packages(name)`, so a gene that was
// ever searched (semantic.ts cached a vector) carries an embeddings row — and
// wipeName must delete it BEFORE the packages row or the FK constraint fails the
// whole batch. This reproduces that under FK enforcement (D1 enforces foreign
// keys; node:sqlite defaults them off, so we turn them on to match prod).

const env = (db: MockD1) => ({ DB: db }) as any;

let db: MockD1;
beforeEach(async () => {
  db = new MockD1();
  db.raw("PRAGMA foreign_keys = ON");
  await db.prepare("INSERT INTO accounts (id, email, created_at) VALUES ('acct','a@b.c',1)").bind().run();
  await db.prepare("INSERT INTO names (name, owner_account, created_at) VALUES ('gone','acct',1)").bind().run();
  await db.prepare(
    "INSERT INTO packages (name, owner_account, latest_version, install_count, verified_state, created_at, updated_at) " +
    "VALUES ('gone','acct','1.0.0',0,'scanned',1,1)",
  ).bind().run();
  await db.prepare("INSERT INTO versions (package, version, content_hash, manifest_json, published_at, yanked) VALUES ('gone','1.0.0','h','{}',1,0)").bind().run();
  // the row that made the live wipe 500: a cached semantic-search vector.
  await db.prepare("INSERT INTO embeddings (package, version, vector) VALUES ('gone','1.0.0','[0.1]')").bind().run();
});

describe("wipeName", () => {
  it("removes a searched gene (with an embeddings row) without an FK failure", async () => {
    await wipeName(env(db), "gone");
    expect(await getPackage(env(db), "gone")).toBeNull();
    expect(db.raw("SELECT package FROM embeddings WHERE package='gone'").length).toBe(0);
    expect(db.raw("SELECT package FROM versions WHERE package='gone'").length).toBe(0);
    expect(db.raw("SELECT name FROM names WHERE name='gone'").length).toBe(0);
  });
});
