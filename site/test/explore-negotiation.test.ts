// /explore is the pool's one listing, and it is content-negotiated. A human
// gets HTML, a CLI gets markdown — and a machine that asks for JSON used to get
// markdown under an `application/json` Accept, which meant the only structured
// view of the genepool was one you had to parse prose out of. The viewer's
// signed-in gene explorer reads this route, so the JSON arm is now load-bearing:
// these cases pin each intent to its own body.
import { describe, it, expect, beforeEach } from "vitest";
import { handleExplore } from "../../.genome/registry/src/registry/routes/package";
import { MockD1 } from "./d1-mock";

const env = (db: MockD1) => ({ DB: db }) as any;

const OWNER = { id: "acct_1", email: "o@known.life", handle: "dom", created_at: 1, github_login: "dom", is_admin: 0 };

let db: MockD1;
beforeEach(() => {
  db = new MockD1();
  db.raw(
    `INSERT INTO accounts (id, email, handle, created_at, github_login, is_admin) VALUES (?, ?, ?, ?, ?, ?)`,
    OWNER.id, OWNER.email, OWNER.handle, OWNER.created_at, OWNER.github_login, OWNER.is_admin,
  );
  // packages.name has an FK to names(name) — the reservation comes first, as
  // it does on a real publish.
  const pkg = (name: string, version: string, installs: number, summary: string, superseded: string | null) => {
    db.raw(`INSERT INTO names (name, owner_account, created_at) VALUES (?, ?, ?)`, name, OWNER.id, 1);
    db.raw(
      `INSERT INTO packages (name, owner_account, summary, latest_version, install_count, verified_state,
                             created_at, updated_at, superseded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      name, OWNER.id, summary, version, installs, "scanned", 1, 1, superseded,
    );
  };
  pkg("laws", "1.61.0", 26, "The universal constitution", null);
  pkg("book-of-life", "9.0.0", 99, "the superseded one", "life-guide");
});

const get = (accept?: string) =>
  handleExplore(new Request("https://known.life/explore", accept ? { headers: { Accept: accept } } : undefined), env(db));

describe("GET /explore", () => {
  it("serves JSON to a caller that asks for JSON", async () => {
    const res = await get("application/json");
    expect(res.headers.get("Content-Type")).toMatch(/application\/json/);
    const body = (await res.json()) as { data: Array<Record<string, unknown>> };
    expect(Array.isArray(body.data)).toBe(true);
    const laws = body.data.find((r) => r.name === "laws");
    expect(laws).toMatchObject({ name: "laws", version: "1.61.0", installs: 26, superseded_by: null });
  });

  it("carries the successor pointer so a consumer can badge a dead gene", async () => {
    const body = (await (await get("application/json")).json()) as { data: Array<Record<string, unknown>> };
    expect(body.data.find((r) => r.name === "book-of-life")?.superseded_by).toBe("life-guide");
  });

  // Rank is the route's contract, not the caller's job: live genes first, each
  // tier install-ranked — so a legacy gene with more historical installs never
  // outranks its live successor.
  it("sinks a superseded gene below a live one it out-installs", async () => {
    const body = (await (await get("application/json")).json()) as { data: Array<{ name: string }> };
    expect(body.data.map((r) => r.name)).toEqual(["laws", "book-of-life"]);
  });

  it("still serves markdown to a CLI and HTML to a browser", async () => {
    const md = await get("text/markdown");
    expect(md.headers.get("Content-Type")).toMatch(/text\/markdown/);
    expect(await md.text()).toContain("**laws**");

    const html = await get("text/html");
    expect(html.headers.get("Content-Type")).toMatch(/text\/html/);
    expect(await html.text()).toContain("<");
  });
});
