import { describe, it, expect, beforeEach } from "vitest";
import {
  insertVersion, getVersionLines, fillVersionLines, censusRows, linesCoverage, linesByMonth,
} from "../../.genome/registry/src/registry/lib/db";
import { handleCensus } from "../../.genome/registry/src/registry/routes/census";
import { MockD1 } from "../../.genome/registry/tests/d1-mock.ts";

// The pool's own mass. `lib/lines.ts` decides what counts as code (pinned in the
// gene's own tests/lines.test.mjs); THIS file pins the storage and the answer —
// that a publish's counts survive the round-trip, that a version cut before the
// measurement reads as UNCOUNTED rather than zero, and that the totals never
// quietly include a number nobody took.
//
// The last one is the whole risk. A census that sums NULLs as zero looks exactly
// like a pool that shrank (Law 5.10), and the number it prints is the one someone
// quotes.

describe("version line counts — stored where the mass changes", () => {
  let db: MockD1;
  const env = () => ({ DB: db }) as any;

  // `published_at` is insertVersion's own Date.now() — the growth-curve test
  // below plants version rows directly so it can name the months it asserts on.
  const version = (name: string, v: string, lines: any) => ({
    package: name, version: v, content_hash: `h-${name}-${v}`, manifest: {}, contract: null,
    requires: [], provides: [], imports: [], inputs: [], scan_json: "{}", fit_json: "{}",
    provenance_json: null, summary: null, description: null, author: null, license: null,
    homepage: null, repository: null, keywords: [], readme: null, bytes: 1, lines, symbols: [],
  });

  const seed = async (name: string) => {
    await db.prepare("INSERT INTO accounts (id, email, created_at) VALUES ('acct','a@b.c',1)").bind().run()
      .catch(() => {});
    await db.prepare("INSERT INTO names (name, owner_account, created_at) VALUES (?,'acct',1)").bind(name).run();
    await db.prepare(
      "INSERT INTO packages (name, owner_account, latest_version, install_count, verified_state, created_at, updated_at) " +
      "VALUES (?,'acct',NULL,0,'scanned',1,1)",
    ).bind(name).run();
  };

  beforeEach(async () => {
    db = new MockD1();
    await db.prepare("INSERT INTO accounts (id, email, created_at) VALUES ('acct','a@b.c',1)").bind().run();
  });

  it("a publish's five buckets round-trip onto the version row", async () => {
    await seed("demo");
    await insertVersion(env(), version("demo", "1.0.0", { code: 412, test: 88, docs: 230, skill: 0, vendor: 17 }));
    expect(await getVersionLines(env(), "demo", "1.0.0")).toEqual({
      code: 412, test: 88, docs: 230, skill: 0, vendor: 17,
    });
  });

  it("a version cut before the measurement reads as null, not zero", async () => {
    await seed("old");
    await insertVersion(env(), version("old", "1.0.0", { code: 1, test: 0, docs: 0, skill: 0, vendor: 0 }));
    // The pre-measurement shape: the columns exist, the row predates them.
    await db.raw("UPDATE versions SET code_lines = NULL, test_lines = NULL WHERE package = 'old'");
    expect(await getVersionLines(env(), "old", "1.0.0")).toBeNull();
  });

  it("the backfill fills a null row once and never edits a counted one", async () => {
    await seed("back");
    await insertVersion(env(), version("back", "1.0.0", { code: 5, test: 0, docs: 0, skill: 0, vendor: 0 }));
    await db.raw("UPDATE versions SET code_lines = NULL WHERE package = 'back'");

    await fillVersionLines(env(), "back", "1.0.0", { code: 99, test: 1, docs: 2, skill: 3, vendor: 4 });
    expect((await getVersionLines(env(), "back", "1.0.0"))?.code).toBe(99);

    // A version is immutable, so a second fill can only ever be the same answer —
    // but the guard is what makes that a fact rather than a hope.
    await fillVersionLines(env(), "back", "1.0.0", { code: 1, test: 1, docs: 1, skill: 1, vendor: 1 });
    expect((await getVersionLines(env(), "back", "1.0.0"))?.code).toBe(99);
  });
});

describe("GET /api/census — the pool's mass, with its denominator", () => {
  let db: MockD1;
  const env = () => ({ DB: db }) as any;

  const add = async (name: string, v: string, code: number | null, opts: { retired?: boolean; at?: number } = {}) => {
    await db.prepare("INSERT INTO names (name, owner_account, created_at) VALUES (?,'acct',1)").bind(name).run();
    await db.prepare(
      "INSERT INTO packages (name, owner_account, latest_version, install_count, verified_state, created_at, updated_at, retired_reason) " +
      "VALUES (?,'acct',?,0,'scanned',1,1,?)",
    ).bind(name, v, opts.retired ? "superseded by the thing that replaced it" : null).run();
    await db.prepare(
      "INSERT INTO versions (package, version, content_hash, manifest_json, published_at, code_lines, test_lines, docs_lines, skill_lines, vendor_lines) " +
      "VALUES (?,?,'h','{}',?,?,?,?,?,?)",
    ).bind(name, v, opts.at ?? Date.UTC(2026, 6, 15), code, code == null ? null : 10, code == null ? null : 20, code == null ? null : 30, code == null ? null : 40).run();
  };

  beforeEach(async () => {
    db = new MockD1();
    await db.prepare("INSERT INTO accounts (id, email, created_at) VALUES ('acct','a@b.c',1)").bind().run();
  });

  it("totals cover LIVE genes only, and say how many they could not count", async () => {
    await add("alpha", "1.0.0", 100);
    await add("beta", "1.0.0", 200);
    await add("ghost", "1.0.0", null);            // predates the measurement
    await add("dead", "1.0.0", 9999, { retired: true });

    const body = await (await handleCensus(env())).json() as any;
    expect(body.totals.genes).toBe(3);
    expect(body.totals.retired).toBe(1);
    expect(body.totals.code).toBe(300);           // a retired gene is not the pool's live mass
    expect(body.totals.uncounted).toBe(1);        // and the gap is NAMED, not absorbed
    expect(body.totals.skill).toBe(60);
  });

  // The first live census called 10 CLAIMED NAMES "uncounted" — as if the pool
  // held mass nobody had measured. A name with no version has no bytes and never
  // did: same null, different fact, and lumping them made the honest denominator
  // dishonest in the other direction (Law 5.10).
  it("a claimed name holding no version is unpublished, not uncounted", async () => {
    await add("alpha", "1.0.0", 100);
    await db.prepare("INSERT INTO names (name, owner_account, created_at) VALUES ('reserved','acct',1)").bind().run();
    await db.prepare(
      "INSERT INTO packages (name, owner_account, latest_version, install_count, verified_state, created_at, updated_at) " +
      "VALUES ('reserved','acct',NULL,0,'scanned',1,1)",
    ).bind().run();

    const body = await (await handleCensus(env())).json() as any;
    expect(body.totals.genes).toBe(1);            // one gene has actually shipped bytes
    expect(body.totals.unpublished).toBe(1);
    expect(body.totals.uncounted).toBe(0);        // nothing went unmeasured
    expect(body.totals.code).toBe(100);
  });

  it("coverage travels with the total, so an unfilled history can't read as clean", async () => {
    await add("alpha", "1.0.0", 100);
    await add("ghost", "1.0.0", null);
    expect(await linesCoverage(env())).toEqual({ counted: 1, versions: 2 });
  });

  it("the growth curve is derived from published_at, not stamped by anything", async () => {
    await add("alpha", "1.0.0", 100, { at: Date.UTC(2026, 5, 2) });
    await add("beta", "1.0.0", 250, { at: Date.UTC(2026, 6, 9) });
    await add("gamma", "1.0.0", 50, { at: Date.UTC(2026, 6, 20) });
    expect(await linesByMonth(env())).toEqual([
      { month: "2026-06", publishes: 1, code: 100 },
      { month: "2026-07", publishes: 2, code: 300 },
    ]);
  });

  it("every gene appears in the table, retired ones included and flagged", async () => {
    await add("alpha", "1.0.0", 100);
    await add("dead", "2.0.0", 7, { retired: true });
    const body = await (await handleCensus(env())).json() as any;
    expect(body.genes.map((g: any) => [g.name, g.retired])).toEqual([["alpha", false], ["dead", true]]);
  });
});
