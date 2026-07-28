// The signed-in dashboard this deployment actually mounts at /app — rendered
// straight from the vendored viewer gene, same as test/gene-icon.test.ts and
// test/provenance.test.ts reach into .genome/registry. The screen answers two
// questions and no third: which lives can I open, and what is in the genepool.
// The cases below are the two ways that shape breaks silently — a repo listing
// creeping back in, and a life going missing because the client sweep no longer
// promotes it into the grid.
import { describe, test, expect } from "vitest";
import { dashboardPage, type PoolRow, type RepoWithLife } from "../../.genome/viewer/src/pages";
import type { ViewerConfig } from "../../.genome/viewer/src/config";
import type { Session } from "../../.genome/viewer/src/session";

const repo = (name: string, isLife: boolean | null): RepoWithLife =>
  ({
    name,
    full_name: `dom/${name}`,
    private: false,
    description: `${name} desc`,
    pushed_at: new Date(Date.now() - 86_400_000).toISOString(),
    owner: { login: "dom", avatar_url: "https://example.invalid/a.png" },
    isLife,
  }) as unknown as RepoWithLife;

const cfg = {
  basePath: "/app",
  idpOrigin: "https://known.life",
  idpFetch: async () => new Response(""),
  sessionSecret: "x".repeat(32),
  brand: "Life",
} as unknown as ViewerConfig;

const session = { login: "dom", token: "t" } as unknown as Session;

const POOL: PoolRow[] = [
  { name: "laws", version: "1.61.0", summary: "The universal constitution", installs: 26, superseded_by: null },
  { name: "book-of-life", version: "9.0.0", summary: "the old one", installs: 40, superseded_by: "life-guide" },
];

const render = (repos: RepoWithLife[], pool: PoolRow[], more?: { pages: number; nextPages: number }) =>
  dashboardPage(cfg, session, repos, pool, more).text();

describe("dashboard: your lives", () => {
  test("a server-detected life is a card", async () => {
    const html = await render([repo("life", true)], POOL);
    expect(html).toContain("/app/dom/life");
    expect(html).toContain("chip-life");
  });

  test("the full repo listing is gone — a settled non-life repo renders nowhere", async () => {
    const html = await render([repo("life", true), repo("notalife", false)], POOL);
    expect(html).not.toMatch(/All repositories/i);
    expect(html).not.toContain("repo-row");
    expect(html).not.toContain("notalife");
  });

  // The listing's ONE load-bearing job. The server resolves only its first
  // window; every repo past it used to reach the screen solely as a badge
  // inside that list. It now rides as candidate DATA and the client sweep
  // builds a card — so if this regresses, a life outside the window becomes
  // unreachable rather than merely unstyled.
  test("an unresolved repo ships as candidate data with an anchor to promote into", async () => {
    const html = await render([repo("life", true), repo("maybe", null)], POOL);
    expect(html).toContain('"full":"dom/maybe"');
    expect(html).toContain('id="newLifeCard"');
    expect(html).toContain("/api/detect?repos=");
  });

  test("a truncated sweep says so rather than cutting silently", async () => {
    const html = await render([repo("life", true)], POOL, { pages: 3, nextPages: 6 });
    expect(html).toContain("?pages=6");
  });
});

describe("dashboard: the genepool", () => {
  test("every pool row is listed, linking to the gene's canonical page", async () => {
    const html = await render([repo("life", true)], POOL);
    expect(html).toMatch(/Genepool/);
    expect(html).toContain('href="https://known.life/laws"');
    expect(html).toContain("The universal constitution");
    expect(html).toContain('id="geneFilter"');
  });

  test("a superseded gene is badged, not silently ranked as live", async () => {
    const html = await render([repo("life", true)], POOL);
    expect(html).toMatch(/superseded/);
  });

  // The pool read fails to empty (a pool outage must not take the lives with
  // it), so the empty state has to be legible as "no answer", never as "no genes".
  test("an empty pool says the pool didn't answer", async () => {
    const html = await render([repo("life", true)], []);
    expect(html).toMatch(/didn't answer/);
  });
});

// The candidate repos ride into an inline <script> as JSON, and JSON.stringify
// alone does not escape `</script>` — so a repo whose DESCRIPTION carries a
// closing tag would end the script block early and inject into the signed-in
// dashboard. Repo descriptions are attacker-influenced (any repo the account
// can see, including org repos), which makes this reachable, not theoretical.
describe("dashboard: the inline script can't be broken out of", () => {
  const hostile = (field: "description" | "name") => {
    const r = repo("evil", null) as unknown as Record<string, unknown>;
    r[field] = '</script><img src=x onerror=alert(1)>';
    return r as unknown as RepoWithLife;
  };

  test("a repo description carrying a closing tag cannot end the script block", async () => {
    const html = await render([hostile("description")], POOL);
    // The payload survives as DATA (escaped), never as markup.
    expect(html).not.toContain("</script><img");
    expect(html).toContain("\\u003c/script\\u003e");
  });

  test("the whole document still has exactly the script blocks it authored", async () => {
    const clean = await render([repo("life", true)], POOL);
    const hostileHtml = await render([hostile("description"), hostile("name")], POOL);
    const count = (s: string) => (s.match(/<\/script>/gi) ?? []).length;
    expect(count(hostileHtml)).toBe(count(clean));
  });
});
