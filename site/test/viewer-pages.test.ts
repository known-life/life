import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { viewerFetch } from "../../.genome/viewer/src/router";
import { seal } from "../../.genome/viewer/src/crypto";
import type { ViewerConfig } from "../../.genome/viewer/src/config";

/**
 * End-to-end renders of the GitHub-owned surface — dashboard, detection, New
 * Life — against a mocked GitHub API. (Life-scoped screens are plane-served;
 * their suite is viewer-plane.test.ts.)
 */

const SECRET = "0123456789abcdef0123456789abcdef-test-secret"; // synthetic fixture, not a credential — gitleaks:allow
const ORIGIN = "https://known.life";

const cfg: ViewerConfig = {
  basePath: "/app",
  idpOrigin: ORIGIN,
  idpFetch: async () => new Response("{}", { status: 500 }),
  sessionSecret: SECRET,
};

const repoLife = {
  full_name: "DomVinyard/life",
  name: "life",
  owner: { login: "DomVinyard", avatar_url: "https://a/1" },
  description: "The genepool",
  private: true,
  default_branch: "main",
  pushed_at: "2026-07-16T00:00:00Z",
  html_url: "https://github.com/DomVinyard/life",
};
const repoPlain = { ...repoLife, full_name: "DomVinyard/plain", name: "plain", description: "Not a life" };

const LIFE_TEXT = `name: life\nsummary: "The known.life genepool"\n\n---\n\n# life\n\nBody.`;

function ghMock(url: string, init?: RequestInit): Response | null {
  const u = new URL(url);
  if (u.origin !== "https://api.github.com") return null;
  const p = u.pathname;
  const json = (d: unknown, status = 200) => Response.json(d, { status });

  if (p === "/user/repos") return json([repoLife, repoPlain]);
  if (p === "/user/orgs") return json([{ login: "known-life", avatar_url: "https://a/o" }]);
  if (p === "/repos/DomVinyard/life/contents/.life") return new Response(LIFE_TEXT, { status: 200 });
  // Root .life is the ONE life marker — a repo without it is not a life.
  if (p === "/repos/DomVinyard/plain/contents/.life") return new Response("nope", { status: 404 });
  if (p === "/user/repos" && init?.method === "POST") return json(repoLife, 201);
  return new Response(`unmocked ${p}`, { status: 500 });
}

let sessionCookie = "";

beforeEach(async () => {
  const sealed = await seal(
    { v: 1, login: "DomVinyard", name: "Dom", avatar: "https://a/1", token: "gho_test", iat: Math.floor(Date.now() / 1000) },
    SECRET,
  );
  sessionCookie = `life_view=${sealed}`;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const res = ghMock(url, init);
    if (res) return res;
    return new Response("unexpected fetch " + url, { status: 500 });
  }));
});
afterEach(() => vi.unstubAllGlobals());

const get = (path: string) => viewerFetch(new Request(`${ORIGIN}${path}`, { headers: { Cookie: sessionCookie } }), cfg);

describe("viewer pages (mocked GitHub)", () => {
  it("dashboard shows lives and the genepool — and nothing that is neither", async () => {
    const res = await get("/app");
    expect(res?.status).toBe(200);
    const html = await res!.text();
    expect(html).toContain("Your lives");
    expect(html).toContain("DomVinyard/<strong>life</strong>");   // life card
    expect(html).toContain("New Life");
    // What REPLACED the repo listing, asserted so the swap is pinned from both
    // sides: the row is gone AND the genepool is there. An absence alone would
    // still pass against a dashboard that rendered neither.
    expect(html).toContain("Genepool");
    // A repo the SERVER already settled as not-a-life is DROPPED, never rendered:
    // the full repo listing that used to carry it is gone, and its one real job
    // (surfacing lives past the detection window) moved into the grid. Only
    // `isLife === null` (still unchecked) rides to the client as a candidate the
    // sweep may promote — see the partition in the viewer's pages.ts. This used
    // to assert a "plain repo row"; the stale expectation survived because site's
    // suite only runs when site or the lock changes, so the viewer bump that
    // removed the row never re-ran it.
    expect(html).not.toContain("DomVinyard/plain");
    expect(html).not.toMatch(/All repositories/i);
  });

  it("says so plainly when the genepool does not answer — and still renders your lives", async () => {
    // `idpFetch` in this suite returns 500, which is the pool being unreachable.
    // The dashboard must NAME that rather than render an empty list that reads
    // as "there are no genes" (law/fail-fast — no silent fallthrough). And the outage
    // must cost the genes section ONLY: a pool that is down taking the lives with
    // it would be the whole screen lost for half a reason.
    const html = await (await get("/app"))!.text();
    expect(html).toContain("The genepool didn't answer");
    expect(html).toContain("DomVinyard/<strong>life</strong>");
  });

  it("avatar menu dismisses on pointerdown, not click (iOS Safari fires no document click on body taps)", async () => {
    const res = await get("/app");
    const html = await res!.text();
    // The rendered chrome's menu script must close on an outside pointerdown —
    // iOS Safari never synthesizes click events on document for taps on
    // non-interactive elements, so a click-based outside-dismiss leaves the
    // menu stuck open on mobile (viewer@0.1.3). Behavior proven in a real
    // browser at fix time; this pins the mechanism in the shipped bytes.
    expect(html).toContain("document.addEventListener('pointerdown'");
    expect(html).toContain("m.contains(e.target)");
    expect(html).not.toContain("e.stopPropagation()");
  });

  it("detect api flags lives", async () => {
    const res = await get("/app/api/detect?repos=DomVinyard/life,DomVinyard/plain");
    expect(await res!.json()).toEqual({ "DomVinyard/life": true, "DomVinyard/plain": false });
  });

  it("new life form renders accounts and validates names", async () => {
    const form = await get("/app/new");
    const html = await form!.text();
    expect(html).toContain("@DomVinyard (you)");
    expect(html).toContain("@known-life");

    const bad = await viewerFetch(
      new Request(`${ORIGIN}/app/new`, {
        method: "POST",
        headers: { Cookie: sessionCookie, "Content-Type": "application/x-www-form-urlencoded" },
        body: "account=DomVinyard&name=bad name",
      }),
      cfg,
    );
    expect(bad?.status).toBe(400);
    expect(await bad!.text()).toContain("valid repository name");
  });
});
