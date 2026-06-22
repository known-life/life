import { describe, it, expect, beforeEach } from "vitest";
import {
  canManageName,
  isMaintainer,
  addMaintainer,
  removeMaintainer,
  listMaintainers,
  type Account,
} from "../src/registry/lib/db";
import { MockD1 } from "./d1-mock";

// Account-level maintainer delegation: a login the owner trusts to publish ANY
// name they own. canManageName is the single authority chokepoint behind
// publish + deprecate + unpublish, so these tests pin the three ways it says
// yes (owner / admin / delegated maintainer) and that revocation actually
// revokes — over the REAL schema.sql via node:sqlite (see d1-mock.ts).

const env = (db: MockD1) => ({ DB: db }) as any;

function account(p: Partial<Account> & { id: string }): Account {
  return {
    id: p.id,
    email: p.email ?? `github:${p.id}`,
    handle: p.handle ?? p.github_login ?? null,
    created_at: p.created_at ?? 1,
    github_id: p.github_id ?? null,
    github_login: p.github_login ?? null,
    github_avatar: null,
    display_name: null,
    is_admin: p.is_admin ?? 0,
  };
}

const OWNER = account({ id: "OWNER", github_login: "gene-owner" });
const TEAM = account({ id: "TEAM", github_login: "team-org" });
const STRANGER = account({ id: "STRANGER", github_login: "someone-else" });
const ADMIN = account({ id: "ADMIN", github_login: "root", is_admin: 1 });

let db: MockD1;
beforeEach(() => {
  db = new MockD1();
  // maintainers.owner_account has an FK to accounts(id) (enforced by the real
  // SQLite mock), so the owner accounts must exist before a grant references them.
  for (const a of [OWNER, STRANGER]) {
    db.raw(
      `INSERT INTO accounts (id, email, handle, created_at, github_login, is_admin)
       VALUES (?, ?, ?, ?, ?, ?)`,
      a.id, a.email, a.handle, a.created_at, a.github_login, a.is_admin,
    );
  }
});

describe("canManageName", () => {
  it("the owner of record can always manage their name", async () => {
    expect(await canManageName(env(db), OWNER.id, OWNER)).toBe(true);
  });

  it("an admin can manage any name without a grant", async () => {
    expect(await canManageName(env(db), OWNER.id, ADMIN)).toBe(true);
  });

  it("a stranger cannot manage another account's name", async () => {
    expect(await canManageName(env(db), OWNER.id, STRANGER)).toBe(false);
  });

  it("a delegated maintainer can manage every name the owner holds", async () => {
    expect(await canManageName(env(db), OWNER.id, TEAM)).toBe(false);
    await addMaintainer(env(db), OWNER.id, "team-org");
    expect(await canManageName(env(db), OWNER.id, TEAM)).toBe(true);
    // …but only over the owner who granted it, not a third account.
    expect(await canManageName(env(db), STRANGER.id, TEAM)).toBe(false);
  });

  it("revoking a maintainer removes the authority", async () => {
    await addMaintainer(env(db), OWNER.id, "team-org");
    expect(await canManageName(env(db), OWNER.id, TEAM)).toBe(true);
    await removeMaintainer(env(db), OWNER.id, "team-org");
    expect(await canManageName(env(db), OWNER.id, TEAM)).toBe(false);
  });

  it("an account with no resolved github login is never a maintainer", async () => {
    await addMaintainer(env(db), OWNER.id, "team-org");
    const ghost = account({ id: "GHOST", github_login: null });
    expect(await canManageName(env(db), OWNER.id, ghost)).toBe(false);
    expect(await isMaintainer(env(db), OWNER.id, null)).toBe(false);
  });
});

describe("addMaintainer / listMaintainers", () => {
  it("grants are idempotent and listed sorted", async () => {
    await addMaintainer(env(db), OWNER.id, "team-org");
    await addMaintainer(env(db), OWNER.id, "team-org"); // re-grant is a no-op
    await addMaintainer(env(db), OWNER.id, "alice");
    expect(await listMaintainers(env(db), OWNER.id)).toEqual(["alice", "team-org"]);
  });

  it("a maintainer grant on one owner doesn't leak to another", async () => {
    await addMaintainer(env(db), OWNER.id, "team-org");
    expect(await listMaintainers(env(db), STRANGER.id)).toEqual([]);
  });
});
