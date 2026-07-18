import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { viewerFetch } from "../../.genome/viewer/src/router";
import { seal } from "../../.genome/viewer/src/crypto";
import { readSession } from "../../.genome/viewer/src/session";
import { renderMarkdown } from "../../.genome/viewer/src/markdown";
import { parseLifeFile, lifeMeta } from "../../.genome/viewer/src/lifefile";
import { validRepoName, scaffoldFiles } from "../../.genome/viewer/src/scaffold";
import type { ViewerConfig } from "../../.genome/viewer/src/config";

/**
 * The stress battery — adversarial and pathological inputs across every seam:
 * URLs, cookies, markdown, .life parsing, hostile plane data, scaffolding,
 * and the rendered-HTML escape discipline. Each case is either a security
 * property (must never regress) or a graceful-degradation contract.
 */

const SECRET = "0123456789abcdef0123456789abcdef-test-secret"; // synthetic fixture, not a credential — gitleaks:allow
const ORIGIN = "https://known.life";
const PLANE = "https://plane.example";

const cfg: ViewerConfig = {
  basePath: "/app",
  idpOrigin: ORIGIN,
  idpFetch: async () => new Response("{}", { status: 500 }),
  sessionSecret: SECRET,
};

async function sessionCookie(): Promise<string> {
  const sealed = await seal(
    { v: 1, login: "DomVinyard", name: null, avatar: null, token: "gho_test", iat: Math.floor(Date.now() / 1000), identityToken: "idtok" },
    SECRET,
  );
  return `life_view=${sealed}`;
}

// Mocks that record what got requested and serve adversarial content — the
// evil life declares a plane whose data is hostile (plane data is a semi-
// trusted upstream: the escape discipline must hold against it too).
const requested: string[] = [];
function mock(url: string): Response {
  const u = new URL(url);
  requested.push(u.pathname);
  const p = u.pathname;
  const json = (d: unknown, status = 200) => Response.json(d, { status });

  if (u.origin === "https://api.github.com") {
    if (p === "/repos/DomVinyard/evil/contents/.life") {
      return new Response(`name: evil\ndataplane: ${PLANE}\n---\nBody`, { status: 200 });
    }
    if (p.includes("..")) return json({ boom: true }, 500);
    return new Response("{}", { status: 404 });
  }

  if (u.origin === PLANE) {
    if (p.includes("..")) return json({ boom: true }, 500);
    if (p === "/v1/nodes/" || p.startsWith("/v1/nodes/")) {
      return json({ data: { path: ".", kind: "self", life: {
        name: `<script>alert(1)</script>`,
        summary: `<img src=x onerror=alert(1)> "quoted" & <script>`,
        icon: `x" onerror="alert(1)`, kind: "self",
        contract: { requires: [`<svg onload=alert(1)>`], provides: [], imports: [] },
        bodyLead: "[x](javascript:alert(1)) <svg onload=alert(1)>",
        body: "[x](javascript:alert(1)) <svg onload=alert(1)>",
      }, children: [
        { name: `"><script>pwn</script>.md`, path: `"><script>pwn</script>.md`, type: "file", size: 10 },
      ] } });
    }
    return json({ type: "about:blank", title: "not found" }, 404);
  }
  return new Response("unexpected " + url, { status: 500 });
}

beforeEach(() => {
  requested.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => mock(String(input instanceof Request ? input.url : input))));
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

  it("rejects malformed owners/repos instead of forwarding them anywhere", async () => {
    for (const bad of ["/app/..%2F..%2Fetc/repo", "/app/own%20er/repo", "/app/-lead/repo", "/app/a/re%20po"]) {
      const res = await get(bad);
      expect(res?.status).toBe(404);
    }
    expect(requested.filter((p) => p.includes(".."))).toEqual([]);
  });

  it("strips traversal segments from cells, preview, and plane-proxy paths", async () => {
    await get("/app/DomVinyard/evil/cells/..%2F..%2Fsecrets");
    await get("/app/DomVinyard/evil/preview/..%2F..%2F..%2Fetc%2Fpasswd");
    await get("/app/DomVinyard/evil/plane/v1/..%2Fadmin");
    expect(requested.filter((p) => p.includes(".."))).toEqual([]);
  });

  it("a repo whose .life is missing renders the friendly 404, never crashes the handler", async () => {
    const res = await get("/app/DomVinyard/missing");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(404);
    expect(await res!.text()).not.toContain("boom");
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
  it("hostile plane data — names, summaries, contract entries, filenames — renders inert", async () => {
    const res = await get("/app/DomVinyard/evil/cells");
    const html = await res!.text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");           // escaped, still visible
    expect(html).not.toContain("<img src=x onerror");
    expect(html).not.toContain("<script>pwn</script>");
    expect(html).not.toContain("<svg onload");
    expect(html).not.toMatch(/href="javascript:/);
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

  it("url-shaped head values that are not http(s) never become clickable schemes", () => {
    expect(lifeMeta('name: x\ndataplane: "javascript:alert(1)"\n---\n').dataplane).toBe("https://javascript:alert(1)");
    expect(lifeMeta("name: x\ndataplane: ftp.example.com\n---\n").dataplane).toBe("https://ftp.example.com");
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
