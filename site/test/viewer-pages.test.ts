import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { viewerFetch } from "../../.genome/viewer/src/router";
import { seal } from "../../.genome/viewer/src/crypto";
import type { ViewerConfig } from "../../.genome/viewer/src/config";

/**
 * End-to-end page renders against a mocked GitHub API — the whole route
 * surface driven through viewerFetch exactly as the worker runs it.
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

const LIFE_TEXT = `name: life\nsummary: "The known.life genepool"\nharness: harness.example.dev\n\n---\n\n# life\n\nBody.`;

function ghMock(url: string, init?: RequestInit): Response | null {
  const u = new URL(url);
  if (u.origin !== "https://api.github.com") return null;
  const p = u.pathname;
  const json = (d: unknown, status = 200) => Response.json(d, { status });
  const wantsRaw = String((init?.headers as Record<string, string> | undefined)?.Accept ?? "").includes("raw");

  if (p === "/user/repos") return json([repoLife, repoPlain]);
  if (p === "/user/orgs") return json([{ login: "known-life", avatar_url: "https://a/o" }]);
  if (p === "/repos/DomVinyard/life") return json(repoLife);
  if (p === "/repos/DomVinyard/life/pulls") {
    if (u.searchParams.get("head")) {
      return json([{ number: 7, title: "Build the viewer", state: "open", merged_at: null, updated_at: "2026-07-16T12:00:00Z", html_url: "https://github.com/DomVinyard/life/pull/7", head: { ref: "claude/build-viewer-x1y2z3" }, base: { ref: "main" }, body: "It **works**.", user: { login: "DomVinyard", avatar_url: "https://a/1" } }]);
    }
    return json([{ number: 7, title: "Build the viewer", state: "open", merged_at: null, updated_at: "2026-07-16T12:00:00Z", html_url: "https://github.com/DomVinyard/life/pull/7", head: { ref: "claude/build-viewer-x1y2z3" }, user: { login: "DomVinyard", avatar_url: "https://a/1" } }]);
  }
  if (p === "/repos/DomVinyard/life/branches") return json([{ name: "main", commit: { sha: "a" } }, { name: "claude/build-viewer-x1y2z3", commit: { sha: "b" } }, { name: "claude/orphan-9q8w7e", commit: { sha: "c" } }]);
  if (p === "/repos/DomVinyard/life/commits") return json([{ sha: "c1", html_url: "https://github.com/c/1", commit: { message: "tip", author: { date: "2026-07-15T00:00:00Z" } } }]);
  if (p === "/repos/DomVinyard/life/compare/main...claude%2Fbuild-viewer-x1y2z3" || p === "/repos/DomVinyard/life/compare/main...claude/build-viewer-x1y2z3") {
    return json({ ahead_by: 2, behind_by: 0, html_url: "https://github.com/cmp", commits: [{ sha: "abc1234def", html_url: "https://github.com/c/abc", commit: { message: "Add viewer\n\nbody", author: { date: "2026-07-16T10:00:00Z" } }, author: { login: "DomVinyard", avatar_url: "https://a/1" } }], files: [{ filename: "site/src/viewer/router.ts", status: "added", additions: 300, deletions: 0 }] });
  }
  if (p === "/repos/DomVinyard/life/contents/.life") return new Response(LIFE_TEXT, { status: 200 });
  // Root .life is the ONE life marker — a repo without it is not a life.
  if (p === "/repos/DomVinyard/plain/contents/.life") return new Response("nope", { status: 404 });
  if (p === "/repos/DomVinyard/life/contents/") return json([
    { name: "knowledge", path: "knowledge", type: "dir", size: 0 },
    { name: ".life", path: ".life", type: "file", size: LIFE_TEXT.length },
    { name: "README.md", path: "README.md", type: "file", size: 20 },
    { name: "chart.html", path: "chart.html", type: "file", size: 400 },
  ]);
  if (p === "/repos/DomVinyard/life/contents/README.md") return new Response("# Readme\n\nHello **world**", { status: 200 });
  if (p === "/repos/DomVinyard/life/contents/chart.html") {
    // GitHub returns the JSON file object for the default media type, raw
    // body only for application/vnd.github.raw — the viewer relies on that.
    return wantsRaw
      ? new Response("<html><script>draw()</script></html>", { status: 200 })
      : json({ name: "chart.html", path: "chart.html", type: "file", size: 400 });
  }
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
  it("dashboard lists lives first with detection badges", async () => {
    const res = await get("/app");
    expect(res?.status).toBe(200);
    const html = await res!.text();
    expect(html).toContain("Your lives");
    expect(html).toContain("DomVinyard/<strong>life</strong>");   // life card
    expect(html).toContain("DomVinyard/plain");                    // plain repo row
    expect(html).toContain("New Life");
  });

  it("sessions page derives rows from PRs + branches and shows the harness link", async () => {
    const res = await get("/app/DomVinyard/life");
    expect(res?.status).toBe(200);
    const html = await res!.text();
    expect(html).toContain("Build the viewer");
    expect(html).toContain("claude/orphan-9q8w7e");
    expect(html).toContain("harness.example.dev");
    expect(html).toContain("chip-agent");
    expect(html).toContain("The known.life genepool"); // .life summary preferred
  });

  it("session detail renders PR, commits and diffstat", async () => {
    const res = await get("/app/DomVinyard/life/session/claude%2Fbuild-viewer-x1y2z3");
    expect(res?.status).toBe(200);
    const html = await res!.text();
    expect(html).toContain("#7 on GitHub");
    expect(html).toContain("abc1234");
    expect(html).toContain("site/src/viewer/router.ts");
    expect(html).toContain("+300");
    expect(html).toContain("It <strong>works</strong>."); // PR body markdown
  });

  it("life tab lists the tree and renders the cell's .life beneath", async () => {
    const res = await get("/app/DomVinyard/life/life");
    expect(res?.status).toBe(200);
    const html = await res!.text();
    expect(html).toContain("knowledge/");
    expect(html).toContain("chart.html");
    expect(html).toContain("yaml-head"); // .life head panel
    expect(html).toContain("Body.");
  });

  it("html artifacts preview in a sandboxed iframe and raw carries CSP sandbox", async () => {
    const file = await get("/app/DomVinyard/life/life/chart.html");
    const html = await file!.text();
    expect(html).toContain(`sandbox="allow-scripts"`);
    expect(html).toContain("/app/DomVinyard/life/raw/chart.html");

    const raw = await get("/app/DomVinyard/life/raw/chart.html");
    expect(raw?.status).toBe(200);
    expect(raw?.headers.get("Content-Security-Policy")).toBe("sandbox allow-scripts");
    expect(raw?.headers.get("Content-Type")).toContain("text/html");
    expect(await raw!.text()).toContain("draw()");
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
