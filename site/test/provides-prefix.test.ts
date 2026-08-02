import { describe, it, expect, beforeEach } from "vitest";
import { providersOf, providersUnder } from "../../.genome/registry/src/registry/lib/db";
import { MockD1 } from "../../.genome/registry/tests/d1-mock.ts";

// The reverse capability lookup, both questions.
//
// `providersOf` answers "who provides this EXACT capability?" and has always
// worked. `providersUnder` answers "who can fill this ROLE?" — every gene under
// a namespace prefix — and did not exist until 2026-08-02, though the engine's
// `provisionHarness` had been calling `/api/provides-prefix/` since it was
// written. Every one of those requests 404'd, the fail-open catch swallowed it,
// the candidate list came back empty, and auto-provisioning a harness onto a
// harness-free `.life` had therefore NEVER once worked — while reading, from the
// outside, exactly like a `.life` that already had one.
//
// That is the failure this file exists to make impossible to repeat: a route
// nobody tested, consumed through a catch that cannot tell "no answer" from
// "nothing to do" (Law 11.3). The PREFIX-ANCHORING cases below carry the weight
// — a prefix that matched mid-string would hand provisionHarness the wrong role
// entirely, and that is a silent wrong answer rather than a silent empty one.

const env = (db: MockD1) => ({ DB: db }) as any;

// One gene + its latest version, with the `provides:` array the lookup greps.
async function gene(db: MockD1, name: string, provides: string[], installs = 0) {
  await db.prepare("INSERT OR IGNORE INTO accounts (id, email, created_at) VALUES ('acct','a@b.c',1)").bind().run();
  await db.prepare("INSERT INTO names (name, owner_account, created_at) VALUES (?,'acct',1)").bind(name).run();
  await db.prepare(
    "INSERT INTO packages (name, owner_account, latest_version, install_count, verified_state, created_at, updated_at) " +
    "VALUES (?,'acct','1.0.0',?,'scanned',1,1)",
  ).bind(name, installs).run();
  await db.prepare(
    "INSERT INTO versions (package, version, content_hash, manifest_json, provides_json, published_at, yanked) " +
    "VALUES (?,'1.0.0','h','{}',?,1,0)",
  ).bind(name, JSON.stringify(provides)).run();
}

let db: MockD1;
beforeEach(async () => {
  db = new MockD1();
  db.raw("PRAGMA foreign_keys = ON");
});

describe("providersUnder — enumerate a capability namespace", () => {
  it("finds every gene under the prefix, ranked by installs", async () => {
    await gene(db, "claude-code", ["harness.claude-code", "ai.harness.claude-code"], 33);
    await gene(db, "some-harness", ["ai.harness.some-vendor"], 2);
    await gene(db, "knowledge", ["knowledge.query"], 36);

    const found = await providersUnder(env(db), "ai.harness.");
    expect(found.map((p) => p.name)).toEqual(["claude-code", "some-harness"]);
  });

  it("a role with no provider is an empty list, not an error", async () => {
    await gene(db, "knowledge", ["knowledge.query"]);
    expect(await providersUnder(env(db), "ai.harness.")).toEqual([]);
  });

  // THE anchoring case. `harness.` must not reach `ai.harness.claude-code`:
  // the prefix is matched against the opening quote of each JSON element, so it
  // can only match at the START of a capability. Without that anchor the
  // pre-trinity prefix would silently alias the trinity one, and every claim
  // about which genes are "still on the legacy key" would be wrong.
  it("anchors at the start of a capability — a prefix never matches mid-string", async () => {
    await gene(db, "claude-code", ["ai.harness.claude-code"]);
    expect(await providersUnder(env(db), "harness.")).toEqual([]);

    await gene(db, "legacy-harness", ["harness.legacy"]);
    expect((await providersUnder(env(db), "harness.")).map((p) => p.name)).toEqual(["legacy-harness"]);
  });

  it("a yanked latest version provides nothing — same rule as the exact lookup", async () => {
    await gene(db, "claude-code", ["ai.harness.claude-code"]);
    await db.prepare("UPDATE versions SET yanked = 1 WHERE package = 'claude-code'").bind().run();
    expect(await providersUnder(env(db), "ai.harness.")).toEqual([]);
  });

  it("the exact lookup still answers exactly — the two questions stay distinct", async () => {
    await gene(db, "claude-code", ["ai.harness.claude-code"]);
    await gene(db, "some-harness", ["ai.harness.some-vendor"]);

    expect((await providersOf(env(db), "ai.harness.claude-code")).map((p) => p.name)).toEqual(["claude-code"]);
    // The prefix is not a capability anyone provides, so asking exactly finds nothing.
    expect(await providersOf(env(db), "ai.harness.")).toEqual([]);
    // ...while asking by role finds both.
    expect((await providersUnder(env(db), "ai.harness.")).length).toBe(2);
  });
});
