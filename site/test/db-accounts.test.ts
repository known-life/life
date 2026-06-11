import { describe, it, expect, beforeEach } from "vitest";
import { getOrCreateGithubAccount, syntheticGithubId, type Account } from "../src/registry/lib/db";
import { MockD1 } from "./d1-mock";

// The account upsert is the auth root of every publish: /api/auth/prove calls
// getOrCreateGithubAccount after lifekey proof, and a 500 here takes publishing
// down for everyone (#321 — a rate-limited GitHub users API turned into a
// UNIQUE(handle) collision and an uncaught D1 error). These tests pin the
// contract over a REAL SQLite enforcing the real schema.sql (see d1-mock.ts):
// resolve by the PROVEN login first, COALESCE so a null/synthetic id never
// clobbers a real github_id, and no input shape may escape as a raw D1 throw.
//
// (Deliberately not in the coverage ratchet's include list — that ratchet pins
// the security-spine trio; this suite gates the upsert contract by assertion,
// not by line count.)

const env = (db: MockD1) => ({ DB: db }) as any;

const ALICE = { githubId: 111, login: "alice", avatar: "https://a.png", name: "Alice" };

let db: MockD1;
beforeEach(() => {
  db = new MockD1();
});

function plant(a: Partial<Account> & { id: string; email: string }) {
  db.raw(
    `INSERT INTO accounts (id, email, handle, created_at, github_id, github_login, github_avatar, display_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    a.id, a.email, a.handle ?? null, a.created_at ?? 1, a.github_id ?? null,
    a.github_login ?? null, a.github_avatar ?? null, a.display_name ?? null,
  );
}

const rows = () => db.raw("SELECT * FROM accounts ORDER BY id") as Account[];

describe("getOrCreateGithubAccount — fresh identities", () => {
  it("creates an account from a fully-resolved GitHub identity", async () => {
    const acc = await getOrCreateGithubAccount(env(db), ALICE);
    expect(acc.github_id).toBe(111);
    expect(acc.handle).toBe("alice");
    expect(rows()).toHaveLength(1);
    expect(rows()[0].email).toBe("github:111");
  });

  it("users API down (null id): synthesises a negative id, and a repeat prove is idempotent", async () => {
    const first = await getOrCreateGithubAccount(env(db), { ...ALICE, githubId: null });
    expect(first.github_id).toBe(syntheticGithubId("alice"));
    expect(first.github_id!).toBeLessThan(0);

    const again = await getOrCreateGithubAccount(env(db), { ...ALICE, githubId: null });
    expect(again.id).toBe(first.id);
    expect(rows()).toHaveLength(1);
  });
});

describe("getOrCreateGithubAccount — existing identities", () => {
  it("a null id never wipes a known github_id (COALESCE contract)", async () => {
    plant({ id: "A", email: "github:111", handle: "alice", github_login: "alice", github_id: 111, display_name: "Alice" });
    const acc = await getOrCreateGithubAccount(env(db), { ...ALICE, githubId: null, name: null });
    expect(acc.id).toBe("A");
    expect(rows()[0].github_id).toBe(111);
    expect(rows()[0].display_name).toBe("Alice"); // null name didn't clobber either
  });

  it("a renamed GitHub login is adopted via the github_id fallback", async () => {
    plant({ id: "A", email: "github:111", handle: "oldalice", github_login: "oldalice", github_id: 111 });
    const acc = await getOrCreateGithubAccount(env(db), { ...ALICE, login: "alice" });
    expect(acc.id).toBe("A");
    expect(rows()[0].handle).toBe("alice");
    expect(rows()[0].github_login).toBe("alice");
  });

  it("the #321 outage shape: canonical row + phantom synthetic-id duplicate → canonical wins, no throw", async () => {
    // The outage: with GitHub rate-limiting, prove resolved accounts by a
    // synthetic github_id FIRST, matched the phantom row, then
    // `SET handle = 'alice'` collided with the canonical row's UNIQUE(handle)
    // → uncaught D1 error → 500 on every publish until the API recovered.
    plant({ id: "CANON", email: "github:111", handle: "alice", github_login: "alice", github_id: 111 });
    plant({ id: "PHANTOM", email: "github:-999", handle: "alice-dup", github_login: null, github_id: syntheticGithubId("alice") });

    // Worst-case caller: the synthetic id itself arrives as the lookup id.
    const acc = await getOrCreateGithubAccount(env(db), { ...ALICE, githubId: syntheticGithubId("alice") });

    expect(acc.id).toBe("CANON");
    const canon = rows().find((r) => r.id === "CANON")!;
    const phantom = rows().find((r) => r.id === "PHANTOM")!;
    expect(canon.handle).toBe("alice");
    expect(phantom.handle).toBe("alice-dup"); // untouched — no UNIQUE collision attempted
  });

  it("an unresolvable UNIQUE conflict surfaces as a typed error, never a raw D1 throw", async () => {
    // A row already owns this identity's synthetic email but is invisible to
    // the login/handle/id lookups — the INSERT must collide, and the catch
    // must produce the named error (the route maps it, instead of 500ing on
    // a bare D1Error as the pre-#321 code did).
    plant({ id: "SQUATTER", email: `github:${syntheticGithubId("alice")}`, handle: "squatter", github_login: "someone-else" });
    await expect(getOrCreateGithubAccount(env(db), { ...ALICE, githubId: null }))
      .rejects.toThrow(/insert conflict/);
  });
});
