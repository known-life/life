import { describe, it, expect, beforeEach } from "vitest";
import { ensureEmbeddings, semanticSearch } from "../../.genome/registry/src/registry/lib/semantic";
import { searchPackages, type PackageRecord } from "../../.genome/registry/src/registry/lib/db";
import { MockD1 } from "./d1-mock";

// Semantic /search pins three contracts, all over the REAL schema.sql:
//   1. the embeddings cache lifecycle — filled lazily, keyed to latest_version,
//      re-embedding ONLY what a publish made stale;
//   2. the merge — lexical name-matches pinned first, then cosine order, then
//      leftover lexical hits, deduped;
//   3. fail-open — no AI binding or a model error leaves lexical untouched.
// Ranking QUALITY is a property of the real bge model + the live pool and is
// verified there; these tests use a hand-built embedding space (one axis per
// topic) so cosine order is exact and the mechanics are the thing under test.

// One axis per topic: [pictures, memory, widgets, zebras] — cosine ignores
// magnitude, so "unrelated" must mean a different DIRECTION, not a small one.
const VECS: Record<string, number[]> = {
  // gene texts (embedText output starts with the gene name)
  "shutter": [1, 0, 0, 0], // pictures gene; summary never says "picture"
  "scrapbook": [0.1, 0.9, 0, 0], // memory gene
  "widget": [0, 0, 1, 0], // unrelated gene
  // queries
  "take a picture of a webpage": [0.9, 0.1, 0, 0],
  "picture": [1, 0, 0, 0],
  "zebra juggling": [0, 0, 0, 1],
};

function fakeAI(log: string[][] = []) {
  return {
    async run(_model: string, input: Record<string, unknown>) {
      const texts = input.text as string[];
      log.push(texts);
      return {
        data: texts.map((t) => {
          const key = Object.keys(VECS).find((k) => t.startsWith(k) || t === k);
          if (!key) throw new Error(`no fixture vector for: ${t}`);
          return VECS[key];
        }),
      };
    },
  };
}

let db: MockD1;
const env = (ai?: ReturnType<typeof fakeAI>) => ({ DB: db, AI: ai }) as any;

beforeEach(async () => {
  db = new MockD1();
  await db.prepare("INSERT INTO accounts (id, email, created_at) VALUES ('acct', 'a@b.c', 1)").bind().run();
  const genes: Array<[string, string, number]> = [
    ["shutter", "capture any URL to a PNG from a session", 5],
    ["scrapbook", "durable markdown memory across sessions", 9],
    ["widget", "a dashboard widget toolkit", 2],
  ];
  for (const [name, summary, installs] of genes) {
    await db.prepare("INSERT INTO names (name, owner_account, created_at) VALUES (?, 'acct', 1)").bind(name).run();
    await db
      .prepare(
        "INSERT INTO packages (name, owner_account, summary, latest_version, install_count, verified_state, created_at, updated_at) VALUES (?, 'acct', ?, '1.0.0', ?, 'scanned', 1, 1)",
      )
      .bind(name, summary, installs)
      .run();
    await db
      .prepare(
        "INSERT INTO versions (package, version, content_hash, manifest_json, provides_json, requires_json, published_at, yanked) VALUES (?, '1.0.0', 'hash', '{}', '[]', '[]', 1, 0)",
      )
      .bind(name)
      .run();
  }
});

describe("embeddings cache lifecycle", () => {
  it("fills lazily, then makes zero model calls at steady state", async () => {
    const log: string[][] = [];
    await ensureEmbeddings(env(fakeAI(log)));
    expect(db.raw("SELECT package, version FROM embeddings ORDER BY package")).toEqual([
      { package: "scrapbook", version: "1.0.0" },
      { package: "shutter", version: "1.0.0" },
      { package: "widget", version: "1.0.0" },
    ]);
    expect(log.length).toBe(1); // one batched call for all three

    await ensureEmbeddings(env(fakeAI(log)));
    expect(log.length).toBe(1); // steady state: nothing stale, no call
  });

  it("a publish bumps latest_version and only that gene re-embeds", async () => {
    await ensureEmbeddings(env(fakeAI()));
    await db.prepare("UPDATE packages SET latest_version = '1.1.0' WHERE name = 'shutter'").bind().run();
    await db
      .prepare(
        "INSERT INTO versions (package, version, content_hash, manifest_json, provides_json, requires_json, published_at, yanked) VALUES ('shutter', '1.1.0', 'hash2', '{}', '[]', '[]', 2, 0)",
      )
      .bind()
      .run();

    const log: string[][] = [];
    await ensureEmbeddings(env(fakeAI(log)));
    expect(log).toEqual([["shutter — capture any URL to a PNG from a session"]]);
    const row = db.raw("SELECT version FROM embeddings WHERE package = 'shutter'") as Array<{ version: string }>;
    expect(row[0].version).toBe("1.1.0");
  });
});

describe("semantic merge", () => {
  it("finds a gene by intent when no token matches its summary", async () => {
    const q = "take a picture of a webpage";
    const lexical = await searchPackages(env(), q, 50);
    expect(lexical).toEqual([]); // "picture" appears nowhere — the lexical miss

    const rows = await semanticSearch(env(fakeAI()), q, lexical);
    // shutter towers over the pool median; the others fall below the adaptive cut
    expect(rows.map((p: PackageRecord) => p.name)).toEqual(["shutter"]);
  });

  it("pins a lexical name-match first even when cosine prefers another gene", async () => {
    // "scrapbook" names a gene, and the query vector also clears the floor for
    // shutter — the name match must stay on top regardless of cosine order.
    const orig = VECS["scrapbook"];
    VECS["scrapbook query"] = [0.7, 0.7, 0];
    VECS["scrapbook"] = orig;
    const lexical = await searchPackages(env(), "scrapbook", 50);
    expect(lexical.map((p) => p.name)).toEqual(["scrapbook"]);

    const rows = await semanticSearch(env(fakeAI()), "scrapbook query", lexical);
    expect(rows[0].name).toBe("scrapbook");
    delete VECS["scrapbook query"];
  });

  it("returns nothing for a query the whole pool is noise to", async () => {
    const rows = await semanticSearch(env(fakeAI()), "zebra juggling", []);
    expect(rows).toEqual([]);
  });
});

describe("fail-open", () => {
  it("no AI binding → lexical results pass through untouched", async () => {
    const lexical = await searchPackages(env(), "memory", 50);
    expect(lexical.map((p) => p.name)).toEqual(["scrapbook"]);
    const rows = await semanticSearch(env(undefined), "memory", lexical);
    expect(rows).toEqual(lexical);
  });

  it("a model error → lexical results pass through, nothing cached", async () => {
    const broken = { async run() { throw new Error("model down"); } } as any;
    const lexical = await searchPackages(env(), "memory", 50);
    const rows = await semanticSearch({ DB: db, AI: broken } as any, "memory", lexical);
    expect(rows).toEqual(lexical);
    expect(db.raw("SELECT COUNT(*) AS n FROM embeddings")).toEqual([{ n: 0 }]);
  });
});
