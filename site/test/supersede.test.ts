import { describe, it, expect, beforeEach } from "vitest";
import { setRetired, getPackage, topPackages, isRetired } from "../../.genome/registry/src/registry/lib/db";
import { listMarkdown } from "../../.genome/registry/src/registry/lib/pages";
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
    await setRetired(env(db), "book-of-life", "life-guide", null);
    expect((await getPackage(env(db), "book-of-life"))?.superseded_by).toBe("life-guide");
  });

  it("explore ranks live genes first — a superseded @9 sinks below a live @3", async () => {
    // Before: pure install order — the legacy gene leads.
    expect((await topPackages(env(db))).map((p) => p.name)).toEqual(["book-of-life", "life-guide"]);
    await setRetired(env(db), "book-of-life", "life-guide", null);
    // After: the live successor leads despite 3× fewer installs.
    expect((await topPackages(env(db))).map((p) => p.name)).toEqual(["life-guide", "book-of-life"]);
  });

  it("clearing the pointer (null) un-retires the gene back to install order", async () => {
    await setRetired(env(db), "book-of-life", "life-guide", null);
    await setRetired(env(db), "book-of-life", null, null);
    expect((await getPackage(env(db), "book-of-life"))?.superseded_by).toBeNull();
    expect((await topPackages(env(db))).map((p) => p.name)).toEqual(["book-of-life", "life-guide"]);
  });

  it("the explore markdown badges a superseded gene with its successor", async () => {
    await setRetired(env(db), "book-of-life", "life-guide", null);
    const md = listMarkdown("explore", await topPackages(env(db)));
    expect(md).toContain("superseded by **life-guide**");
    // the live successor's row carries no supersede tag
    expect(md).toMatch(/life-guide\*\*@1\.0\.0 — 3 installs — /);
  });

  // Retirement with NO successor — the case the pool could not express before,
  // which left `think` and `harness` carrying it as prose in their summaries.
  // It must sink and badge exactly like a rename, without inventing a successor.
  it("a reason with no successor retires the gene: sinks, badges, stays resolvable", async () => {
    await setRetired(env(db), "book-of-life", null, "the thesis it embodied was retired");
    const p = (await getPackage(env(db), "book-of-life"))!;
    expect(p.superseded_by).toBe(null);
    expect(p.retired_reason).toBe("the thesis it embodied was retired");
    expect(isRetired(p)).toBe(true);
    expect((await topPackages(env(db))).map((r) => r.name)).toEqual(["life-guide", "book-of-life"]);
  });

  // The predicate is what makes "superseded but not retired" unrepresentable:
  // one concept, read the same way at every sink, badge and warn.
  it("isRetired is true for either mark and false only when both are clear", () => {
    expect(isRetired({ superseded_by: "life-guide", retired_reason: null })).toBe(true);
    expect(isRetired({ superseded_by: null, retired_reason: "gone" })).toBe(true);
    expect(isRetired({ superseded_by: "life-guide", retired_reason: "gone" })).toBe(true);
    expect(isRetired({ superseded_by: null, retired_reason: null })).toBe(false);
  });
});
