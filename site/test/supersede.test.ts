import { describe, it, expect, beforeEach } from "vitest";
import { setSuperseded, getPackage, topPackages } from "../src/registry/lib/db";
import { listMarkdown } from "../src/registry/lib/pages";
import { MockD1 } from "./d1-mock";

// superseded_by is the package-level "this gene was renamed/replaced" pointer
// that de-clutters explore: legacy genes with more historical installs
// (book-of-life @9) must NOT outrank their live successor (life-guide @3).
// These pin the column round-trip, the explore sink-to-bottom sort, the
// un-retire (null) path, and the listing badge — over the REAL schema.sql
// (including the packages.superseded_by migration ALTER) via node:sqlite.

const env = (db: MockD1) => ({ DB: db }) as any;

let db: MockD1;
beforeEach(async () => {
  db = new MockD1();
  await db.prepare(
    "INSERT INTO accounts (id, email, created_at) VALUES ('acct', 'a@b.c', 1)",
  ).bind().run();
  // legacy book-of-life (9 installs) + its live successor life-guide (3)
  for (const [name, installs] of [["book-of-life", 9], ["life-guide", 3]] as const) {
    await db.prepare("INSERT INTO names (name, owner_account, created_at) VALUES (?, 'acct', 1)").bind(name).run();
    await db.prepare(
      "INSERT INTO packages (name, owner_account, summary, latest_version, install_count, verified_state, created_at, updated_at) " +
      "VALUES (?, 'acct', ?, '1.0.0', ?, 'scanned', 1, 1)",
    ).bind(name, `the ${name} gene`, installs).run();
  }
});

describe("superseded_by", () => {
  it("sets and reads the successor pointer; null is live", async () => {
    expect((await getPackage(env(db), "book-of-life"))?.superseded_by).toBeNull();
    await setSuperseded(env(db), "book-of-life", "life-guide");
    expect((await getPackage(env(db), "book-of-life"))?.superseded_by).toBe("life-guide");
  });

  it("explore ranks live genes first — a superseded @9 sinks below a live @3", async () => {
    // Before: pure install order — the legacy gene leads.
    expect((await topPackages(env(db))).map((p) => p.name)).toEqual(["book-of-life", "life-guide"]);
    await setSuperseded(env(db), "book-of-life", "life-guide");
    // After: the live successor leads despite 3× fewer installs.
    expect((await topPackages(env(db))).map((p) => p.name)).toEqual(["life-guide", "book-of-life"]);
  });

  it("clearing the pointer (null) un-retires the gene back to install order", async () => {
    await setSuperseded(env(db), "book-of-life", "life-guide");
    await setSuperseded(env(db), "book-of-life", null);
    expect((await getPackage(env(db), "book-of-life"))?.superseded_by).toBeNull();
    expect((await topPackages(env(db))).map((p) => p.name)).toEqual(["book-of-life", "life-guide"]);
  });

  it("the explore markdown badges a superseded gene with its successor", async () => {
    await setSuperseded(env(db), "book-of-life", "life-guide");
    const md = listMarkdown("explore", await topPackages(env(db)));
    expect(md).toContain("superseded by **life-guide**");
    // the live successor's row carries no supersede tag
    expect(md).toMatch(/life-guide\*\*@1\.0\.0 — 3 installs — /);
  });
});
