import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { viewerFetch } from "../../.genome/viewer/src/router";
import { seal } from "../../.genome/viewer/src/crypto";
import { readSession } from "../../.genome/viewer/src/session";
import { renderMarkdown } from "../../.genome/viewer/src/markdown";
import { parseLifeFile, lifeMeta } from "../../.genome/viewer/src/lifefile";
import { deriveSessions, groupSessions, humanizeBranch, agentOf } from "../../.genome/viewer/src/sessions";
import { validRepoName, scaffoldFiles } from "../../.genome/viewer/src/scaffold";
import { resolveRel } from "../../.genome/viewer/src/pages-tree";
import type { ViewerConfig } from "../../.genome/viewer/src/config";

/**
 * The stress battery — adversarial and pathological inputs across every seam:
 * URLs, cookies, markdown, .life parsing, session derivation, scaffolding,
 * and the rendered-HTML escape discipline. Each case is either a security
 * property (must never regress) or a graceful-degradation contract.
 */

const SECRET = "0123456789abcdef0123456789abcdef-test-secret"; // synthetic fixture, not a credential — gitleaks:allow
const ORIGIN = "https://known.life";

const cfg: ViewerConfig = {
  basePath: "/app",
  idpOrigin: ORIGIN,
  idpFetch: async () => new Response("{}", { status: 500 }),
  sessionSecret: SECRET,
};

async function sessionCookie(): Promise<string> {
  const sealed = await seal(
    { v: 1, login: "DomVinyard", name: null, avatar: null, token: "gho_test", iat: Math.floor(Date.now() / 1000) },
    SECRET,
  );
  return `life_view=${sealed}`;
}

// A GitHub mock that records what got requested and serves adversarial content.
const requested: string[] = [];
function ghMock(url: string): Response {
  const u = new URL(url);
  requested.push(u.pathname);
  const p = u.pathname;
  const json = (d: unknown, status = 200) => Response.json(d, { status });

  if (p === "/repos/DomVinyard/evil") {
    return json({
      full_name: "DomVinyard/evil", name: "evil",
      owner: { login: "DomVinyard", avatar_url: "https://a/1\" onerror=\"alert(1)" },
      description: `<img src=x onerror=alert(1)> "quoted" & <script>`,
      private: false, default_branch: "main",
      pushed_at: "2026-07-16T00:00:00Z", html_url: "https://github.com/DomVinyard/evil",
    });
  }
  if (p === "/repos/DomVinyard/evil/pulls") {
    if (u.searchParams.get("head")) {
      return json([{
        number: 1, title: `</div><script>alert(1)</script>`, state: "open", merged_at: null,
        updated_at: "2026-07-16T12:00:00Z", html_url: "https://github.com/x/pull/1",
        head: { ref: "claude/söme-brañch-✨" }, base: { ref: "main" },
        body: "[x](javascript:alert(1)) <svg onload=alert(1)>",
        user: { login: "eve", avatar_url: "https://a/e" },
      }]);
    }
    return json([{
      number: 1, title: `</div><script>alert(1)</script>`, state: "open", merged_at: null,
      updated_at: "2026-07-16T12:00:00Z", html_url: "https://github.com/x/pull/1",
      head: { ref: "claude/söme-brañch-✨" },
      user: { login: "eve", avatar_url: "https://a/e" },
    }]);
  }
  if (p === "/repos/DomVinyard/evil/branches") return json([{ name: "main", commit: { sha: "a" } }]);
  if (p === "/repos/DomVinyard/evil/contents/.life") {
    return new Response(`name: evil\nsummary: "<b>bold</b> & <script>alert(1)</script>"\nharness: javascript:alert(1)\n---\nBody <script>x</script>`, { status: 200 });
  }
  if (p.startsWith("/repos/DomVinyard/evil/compare/")) {
    return json({ ahead_by: 1, behind_by: 0, html_url: "https://github.com/cmp",
      commits: [{ sha: "abcd1234", html_url: "https://github.com/c", commit: { message: `<script>alert(1)</script> commit`, author: { date: "2026-07-16T00:00:00Z" } } }],
      files: [{ filename: `"><img src=x onerror=alert(1)>.ts`, status: "added", additions: 1, deletions: 0 }] });
  }
  if (p === "/repos/DomVinyard/evil/contents/") {
    return json([
      { name: `"><script>pwn</script>.md`, path: `"><script>pwn</script>.md`, type: "file", size: 10 },
      { name: ".life", path: ".life", type: "file", size: 40 },
    ]);
  }
  // Traversal probes must never reach here with dots intact.
  if (p.includes("..")) return json({ boom: true }, 500);
  return new Response("{}", { status: 404 });
}

beforeEach(() => {
  requested.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => ghMock(String(input instanceof Request ? input.url : input))));
});
afterEach(() => vi.unstubAllGlobals());

const get = async (path: string) =>
  viewerFetch(new Request(`${ORIGIN}${path}`, { headers: { Cookie: await sessionCookie() } }), cfg);

describe("router edges", () => {
  it("path scoping is exact: /app matches, /appx and / do not", async () => {
    expect(await viewerFetch(new Request(`${ORIGIN}/appx`), cfg)).toBeNull();
    expect(await viewerFetch(new Request(`${ORIGIN}/application/x`), cfg)).toBeNull();
    expect(await viewerFetch(new Request(`${ORIGIN}/`), cfg)).toBeNull();
    expect((await viewerFetch(new Request(`${ORIGIN}/app/`), cfg))?.status).toBe(200);
  });

  it("rejects malformed owners/repos instead of forwarding them to GitHub", async () => {
    for (const bad of ["/app/..%2F..%2Fetc/repo", "/app/own%20er/repo", "/app/-lead/repo", "/app/a/re%20po"]) {
      const res = await get(bad);
      expect(res?.status).toBe(404);
    }
    expect(requested.filter((p) => p.includes(".."))).toEqual([]);
  });

  it("strips traversal segments from tree and raw paths", async () => {
    await get("/app/DomVinyard/evil/life/..%2F..%2Fsecrets");
    await get("/app/DomVinyard/evil/raw/..%2F..%2F..%2Fetc%2Fpasswd");
    expect(requested.filter((p) => p.includes(".."))).toEqual([]);
  });

  it("a GitHub error on ANY route renders the friendly page, never crashes the handler", async () => {
    // Regression: bare `return handler()` inside viewerFetch's try let the
    // handler's rejection escape the catch (async return isn't awaited). Every
    // real route must degrade to an error page, not throw.
    for (const path of [
      "/app/DomVinyard/missing",             // sessionsView → getRepo 404
      "/app/DomVinyard/missing/life",        // treeView
      "/app/DomVinyard/missing/session/x",   // sessionDetail
      "/app/DomVinyard/missing/raw/x.md",    // rawView
    ]) {
      const res = await get(path);
      expect(res, path).not.toBeNull();
      expect([404, 502], path).toContain(res!.status);
      expect(await res!.text()).not.toContain("boom");
    }
  });

  it("unicode branch names survive the URL round-trip", async () => {
    const res = await get(`/app/DomVinyard/evil/session/${encodeURIComponent("claude/söme-brañch-✨")}`);
    expect(res?.status).toBe(200);
    const html = await res!.text();
    expect(html).toContain("söme-brañch-✨");
  });

  it("detect api caps the batch and drops malformed names", async () => {
    const many = Array.from({ length: 50 }, (_, i) => `o/r${i}`).join(",");
    const res = await get(`/app/api/detect?repos=${encodeURIComponent(many + ",a/b/c,<script>,x")}`);
    const body = (await res!.json()) as Record<string, boolean>;
    expect(Object.keys(body).length).toBeLessThanOrEqual(20);
    expect(Object.keys(body).every((k) => /^[^<>]+\/[^<>]+$/.test(k))).toBe(true);
  });
});

describe("rendered-HTML escape discipline (XSS)", () => {
  it("hostile PR titles, branch names, and .life summaries render inert", async () => {
    const res = await get("/app/DomVinyard/evil");
    const html = await res!.text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");           // escaped, still visible
    expect(html).not.toContain("<img src=x onerror");
    // harness: javascript: scheme must not become a clickable protocol
    expect(html).not.toMatch(/href="javascript:/);
  });

  it("hostile filenames in tree listings and diffs render inert", async () => {
    const tree = await (await get("/app/DomVinyard/evil/life"))!.text();
    expect(tree).not.toContain("<script>pwn</script>");
    const detail = await (await get(`/app/DomVinyard/evil/session/${encodeURIComponent("claude/söme-brañch-✨")}`))!.text();
    expect(detail).not.toContain('"><img src=x onerror');
    expect(detail).not.toContain("<script>alert(1)</script>");
  });

  it("PR body markdown strips javascript: links and raw HTML", async () => {
    const detail = await (await get(`/app/DomVinyard/evil/session/${encodeURIComponent("claude/söme-brañch-✨")}`))!.text();
    expect(detail).not.toMatch(/href="javascript:/);
    expect(detail).not.toContain("<svg onload");
  });
});

describe("session cookie edges", () => {
  it("rejects tampering, wrong version, and garbage", async () => {
    const good = (await sessionCookie()).split("=")[1];
    const flip = good.slice(0, -2) + (good.endsWith("A") ? "BB" : "AA");
    const req = (c: string) => new Request(`${ORIGIN}/app`, { headers: { Cookie: `life_view=${c}` } });
    expect(await readSession(req(flip), cfg)).toBeNull();
    expect(await readSession(req("zzzz"), cfg)).toBeNull();
    const v2 = await seal({ v: 2, login: "x", token: "t", iat: Math.floor(Date.now() / 1000) }, SECRET);
    expect(await readSession(req(v2), cfg)).toBeNull();
    const noToken = await seal({ v: 1, login: "x", iat: Math.floor(Date.now() / 1000) }, SECRET);
    expect(await readSession(req(noToken), cfg)).toBeNull();
  });

  it("a session sealed under a different secret is invisible", async () => {
    const other = await seal({ v: 1, login: "x", name: null, avatar: null, token: "t", iat: Math.floor(Date.now() / 1000) }, "another-32-byte-secret-for-testing!!");
    const res = await viewerFetch(new Request(`${ORIGIN}/app`, { headers: { Cookie: `life_view=${other}` } }), cfg);
    expect(await res!.text()).toContain("Continue with GitHub"); // treated as signed out
  });
});

describe("markdown pathological inputs", () => {
  it("survives an unterminated fence at EOF", () => {
    const html = renderMarkdown("before\n```js\nconst x = 1;\n"); // no closing fence
    expect(html).toContain("const x = 1;");
    expect(html).toContain("<pre>");
  });

  it("clamps absurd list nesting and handles 1000 nested blockquotes without blowing the stack", () => {
    const deepList = Array.from({ length: 20 }, (_, i) => `${"  ".repeat(i)}- item${i}`).join("\n");
    expect(renderMarkdown(deepList)).toContain('data-depth="3"'); // clamped, not 20
    const deepQuote = "> ".repeat(1000) + "end";
    expect(() => renderMarkdown(deepQuote)).not.toThrow();
  });

  it("handles a 100KB single line in bounded time", () => {
    const big = "a*b_c`d[e](f) ".repeat(7000); // ~100KB of inline-trigger chars
    const t0 = Date.now();
    renderMarkdown(big);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("nested/spoofed link syntax cannot smuggle attributes", () => {
    const html = renderMarkdown(`[a"><script>x</script>](https://ok.example) ![alt"onerror=x](https://img.example/i.png)`);
    expect(html).not.toContain("<script>x</script>");
    expect(html).not.toMatch(/onerror=x[^"]/);
  });

  it("data: images allowed only for image payloads", () => {
    expect(renderMarkdown("![x](data:image/png;base64,AAAA)")).toContain("data:image/png");
    expect(renderMarkdown("![x](data:text/html,<b>)")).not.toContain("data:text/html");
  });
});

describe(".life parsing edges", () => {
  it("CRLF, tabs, comments, and duplicate keys degrade gracefully", () => {
    const { head, body } = parseLifeFile("name: a\r\nsummary: \"s\"\r\nname: b\r\n---\r\nBody\r\n");
    expect(head.name).toBe("b"); // last wins, no throw
    expect(body).toContain("Body");
  });

  it("a file that is ALL yaml (no ---) has an empty body; all-markdown gets an empty head", () => {
    expect(parseLifeFile("name: x").body).toBe("");
    const md = parseLifeFile("---\njust markdown");
    expect(Object.keys(md.head)).toHaveLength(0);
    expect(md.body).toBe("just markdown");
  });

  it("harness values that are not http(s) never become clickable schemes", () => {
    expect(lifeMeta('name: x\nharness: "javascript:alert(1)"\n---\n').harness).toBe("https://javascript:alert(1)");
    expect(lifeMeta("name: x\nharness: ftp.example.com\n---\n").harness).toBe("https://ftp.example.com");
  });
});

describe("session derivation edges", () => {
  it("humanize handles degenerate branch names", () => {
    expect(humanizeBranch("claude/")).toBe("claude/"); // falls back to the raw name
    expect(humanizeBranch("x")).toBe("x");
    expect(humanizeBranch("claude/a-b1c2d3")).toBe("a");
    expect(agentOf("CLAUDE/x")).toBe("claude");
    expect(agentOf("claude")).toBeNull(); // no slash → not an agent branch
  });

  it("empty inputs produce empty groups, not crashes", () => {
    expect(deriveSessions([], [], "main")).toEqual([]);
    expect(groupSessions([])).toEqual([]);
  });

  it("rows with missing dates sort last and land in Older", () => {
    const rows = deriveSessions(
      [],
      [{ name: "a", date: null }, { name: "b", date: "2026-07-16T00:00:00Z" }],
      "main",
    );
    expect(rows[0].branch).toBe("b");
    const groups = groupSessions(rows, new Date("2026-07-17T00:00:00Z"));
    expect(groups.find((g) => g.label === "Older")!.rows.some((r) => r.branch === "a")).toBe(true);
  });
});

describe("scaffold edges", () => {
  it("repo-name validation refuses url-hostile and git-special names", () => {
    for (const bad of ["", ".", "..", "a".repeat(101), "-x", "x-", "has space", "ünïcode", "x.git", "a/b"]) {
      expect(validRepoName(bad), bad).toBe(false);
    }
    for (const ok of ["a", "a.b-c_d", "A9", "x".repeat(100)]) {
      expect(validRepoName(ok), ok).toBe(true);
    }
  });

  it("scaffold content escapes nothing it shouldn't (plain text seeds)", () => {
    const files = scaffoldFiles("my-life", "https://known.life");
    expect(files[0].content).toContain("name: my-life");
    expect(files[0].content).toContain("LIFE_ALIVE");
  });
});

describe("relative-link resolution", () => {
  it("cannot escape the repo root", () => {
    expect(resolveRel("a/b", "../../../../etc/passwd")).toBe("etc/passwd");
    expect(resolveRel("", "../..")).toBe("");
    expect(resolveRel("docs", "./x.md#frag")).toBe("docs/x.md#frag");
  });
});
