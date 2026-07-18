// The app-parity plane seam (viewer-app-parity node 01): a repo with a
// configured data plane — and the signed-in login in its owners — renders the
// justin app's Life tab off the plane instead of the GitHub-derived screens;
// browser pages reach the plane only through the /plane proxy; the bearer
// never leaves the server. Fidelity source: knowledge/viewer-app-parity-plan.md.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { viewerFetch } from "../../.genome/viewer/src/router";
import { seal } from "../../.genome/viewer/src/crypto";
import type { ViewerConfig } from "../../.genome/viewer/src/config";

const ORIGIN = "https://known.life";
const SECRET = "0123456789abcdef0123456789abcdef"; // synthetic fixture, not a credential — gitleaks:allow
const PLANE = "https://plane.example";
const BEARER = "plane-admin-bearer-test"; // synthetic fixture, not a credential — gitleaks:allow

const cfg: ViewerConfig = {
  basePath: "/app",
  idpOrigin: ORIGIN,
  idpFetch: async () => new Response("unused", { status: 500 }),
  sessionSecret: SECRET,
  planes: {
    "DomVinyard/life": {
      url: PLANE,
      bearer: BEARER,
      owners: ["DomVinyard"],
      artifactHost: "https://artifact.example",
    },
  },
};

const seenAuth: string[] = [];
const seenWrites: string[] = [];

function planeMock(url: string, init?: RequestInit): Response | null {
  const u = new URL(url);
  if (u.origin !== PLANE) return null;
  seenAuth.push(String((init?.headers as Record<string, string>)?.Authorization ?? ""));
  const env = (data: unknown, meta?: unknown) => Response.json({ data, ...(meta ? { meta } : {}) });
  switch (u.pathname) {
    case "/v1/self": return env({ counts: { genesInstalled: 31 } });
    case "/v1/infra/workers": return env([{}, {}, {}]);
    case "/v1/infra/kv": return env([{}]);
    case "/v1/infra/r2": return env([{}]);
    case "/v1/infra/d1": return env([{}, {}]);
    case "/v1/conversations": return env({
      active: [{ slug: "s1", title: "Fix the viewer", status: "working", updated: new Date(Date.now()-300000).toISOString(),
        frontier: { primary: "delivered", topic: "Viewer fixes", topicEmoji: "🛠️", headline: "The menu closes on mobile now" } }],
      days: [{ key: "2026-07-17", lead: "Shipped the viewer.", rows: [{ slug: "s2", title: "Old one", updated: null }] }],
      weeks: [{ key: "2026-W28", lead: null, rows: [{ slug: "s3", title: "Older", updated: null }] }] });
    case "/v1/conversations/s1": return env({ title: "Fix the viewer", messages: [
      { id: 1, ts: new Date().toISOString(), type: "user_message", text: "How is it looking?" },
      { id: 2, ts: new Date().toISOString(), type: "response", text: "All green." },
      { id: 3, ts: new Date().toISOString(), type: "injection", text: "hidden nudge" },
    ] });
    case "/v1/settings": return env({ groups: [{ key: "appearance", label: "Appearance", settings: [
      { key: "model", type: "enum", label: "Model", value: "a", writable: true,
        options: [{ value: "a", label: "Kimi" }, { value: "b", label: "Llama" }] },
      { key: "tint", type: "string", label: "Tint", value: "orange" },
    ] }] });
    case "/v1/search": return env({ query: u.searchParams.get("q"), results: [
      { path: "site", title: "site", type: "cell" },
      { path: "install.sh", type: "file" },
    ] });
    case "/v1/schedules": return env({ schedules: [{}, {}] });
    case "/v1/nodes/": return env({ path: ".", kind: "self", life: {
      name: "life", summary: "The genepool dogfood.", icon: "planet-outline", kind: "self",
      contract: { requires: ["infra.compute"], provides: ["registry"], imports: ["known.life/registry"] },
      bodyLead: "# life\n\nLead.", body: "# life\n\nLead.\n\nMore depth here.",
    }, children: [
      { name: "site", path: "site", type: "dir", cell: true, title: "site", summary: "The genepool worker.", icon: "cloud-outline" },
      { name: "scripts", path: "scripts", type: "dir" },
      { name: "install.sh", path: "install.sh", type: "file", size: 10 },
    ] });
    case "/v1/nodes/site": return env({ path: "site", kind: "cell", life: {
      name: "site", summary: "The genepool worker.", icon: "cloud-outline", kind: "service",
      contract: { requires: [], provides: [], imports: [] }, bodyLead: "Body.", body: "Body.",
    }, children: [] });
    case "/v1/files/install.sh": return env({ path: "install.sh", size: 10, content: "#!/bin/sh\necho hi" });
    case "/v1/artifacts": return Response.json({ data: [
      { token: "a".repeat(32), kind: "page", label: "My Chart", path: null, visibility: "link", allow: [], slug: null, host: null, created: 1752800000000, expires: null, views: 3, pinned: true },
      { token: "b".repeat(32), kind: "bookmark", label: null, path: null, visibility: "private", allow: [], slug: null, host: null, created: 1752800000000, expires: null, views: 0, url: "https://example.com/x", group: "Tools" },
    ], meta: { groups: { Tools: { pinned: false } } } });
    default: return Response.json({ type: "about:blank", title: "not found" }, { status: 404 });
  }
}

function ghMock(url: string): Response | null {
  const u = new URL(url);
  if (u.origin !== "https://api.github.com") return null;
  if (u.pathname === "/repos/DomVinyard/plain/pulls") return Response.json([]);
  if (u.pathname === "/repos/DomVinyard/plain/branches") return Response.json([]);
  if (u.pathname === "/repos/DomVinyard/plain/commits") return Response.json([]);
  if (u.pathname === "/repos/DomVinyard/plain/contents/.life") return new Response("no", { status: 404 });
  if (u.pathname === "/repos/DomVinyard/plain") {
    return Response.json({ full_name: "DomVinyard/plain", name: "plain", owner: { login: "DomVinyard" }, default_branch: "main", private: true, description: "", pushed_at: "2026-07-01T00:00:00Z", html_url: "https://github.com/DomVinyard/plain" });
  }
  return Response.json({}, { status: 200 });
}

let cookieFor = "";

async function signIn(login: string) {
  const sealed = await seal(
    { v: 1, login, name: login, avatar: "https://a/1", token: "gho_test", iat: Math.floor(Date.now() / 1000) },
    SECRET,
  );
  cookieFor = `life_view=${sealed}`;
}

beforeEach(async () => {
  seenAuth.length = 0;
  seenWrites.length = 0;
  await signIn("DomVinyard");
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(PLANE) && init?.method && init.method !== "GET") {
      seenWrites.push(`${init.method} ${new URL(url).pathname} ${String(init.body ?? "")}`);
      return Response.json({ data: { ok: true } });
    }
    return planeMock(url, init) ?? ghMock(url) ?? new Response("unexpected " + url, { status: 500 });
  }));
});
afterEach(() => vi.unstubAllGlobals());

const call = (path: string, init?: RequestInit) =>
  viewerFetch(new Request(`${ORIGIN}${path}`, { ...init, headers: { Cookie: cookieFor, ...(init?.headers ?? {}) } }), cfg);

describe("viewer plane seam (app parity)", () => {
  it("a planed repo renders the app Life tab, word-identical, with live counts", async () => {
    const res = await call("/app/DomVinyard/life");
    expect(res?.status).toBe(200);
    const html = await res!.text();
    // StructureView's words, verbatim — plus the one Artifacts departure.
    for (const s of ["Search Life", "Conversations", "Scheduled", "Cells", "Artifacts", "Settings", "Infrastructure", "Genes", "Workers", "Storage", "Secrets"]) {
      expect(html).toContain(s);
    }
    expect(html).toContain(">31<");        // genesInstalled
    expect(html).toContain(">3<");         // workers
    expect(html).toContain(">4<");         // storage = kv+r2+d1
    expect(html).toContain("gift-outline"); // the Artifacts row's glyph
    expect(html).not.toContain("Your lives"); // not the dashboard
  });

  it("the plane bearer never reaches the page, and every plane call carried it", async () => {
    const res = await call("/app/DomVinyard/life");
    const html = await res!.text();
    expect(html).not.toContain(BEARER);
    expect(seenAuth.length).toBeGreaterThan(0);
    for (const a of seenAuth) expect(a).toBe(`Bearer ${BEARER}`);
  });

  it("the /plane proxy forwards /v1 reads with the server-held bearer", async () => {
    const res = await call("/app/DomVinyard/life/plane/v1/search?q=site");
    expect(res?.status).toBe(200);
    const env = (await res!.json()) as { data: { results: unknown[] } };
    expect(env.data.results).toHaveLength(2);
    expect(seenAuth.at(-1)).toBe(`Bearer ${BEARER}`);
  });

  it("the proxy pins paths under /v1", async () => {
    const res = await call("/app/DomVinyard/life/plane/admin/anything");
    expect(res?.status).toBe(404);
  });

  it("a login outside owners gets no plane: GitHub view, proxy 404", async () => {
    await signIn("SomeoneElse");
    const proxied = await call("/app/DomVinyard/life/plane/v1/self");
    expect(proxied?.status).toBe(404);
    const html = await (await call("/app/DomVinyard/life"))!.text();
    expect(html).not.toContain("Search Life");
  });

  it("the cells tree renders the .life lead + served-order children off /v1/nodes", async () => {
    const res = await call("/app/DomVinyard/life/cells");
    expect(res?.status).toBe(200);
    const html = await res!.text();
    // LifeHeader + unit contract, word-identical.
    for (const s of ["The self", "Provides", "Requires", "Imports",
      "Capabilities it offers the rest of the life.",
      "Specific genes it pulls in directly.", "Contents", "Show more", "Other"]) {
      expect(html).toContain(s);
    }
    expect(html).toContain("The genepool worker."); // cell summary rides the row
    expect(html).toContain("planet-outline");       // declared icon resolves
  });

  it("a file preview serves the plane's content, and a deep cell renders", async () => {
    const file = await (await call("/app/DomVinyard/life/preview/install.sh"))!.text();
    expect(file).toContain("echo hi");
    const cell = await (await call("/app/DomVinyard/life/cells/site"))!.text();
    expect(cell).toContain("Service"); // KindPill for kind: service
  });

  it("artifacts renders the grid + stream + manage vocabulary off /v1/artifacts", async () => {
    const res = await call("/app/DomVinyard/life/artifacts");
    expect(res?.status).toBe(200);
    const html = await res!.text();
    for (const s of ["My Chart", "Tools", "1 item", "Move to Folder", "Visibility", "Delete", "New Folder"]) {
      expect(html).toContain(s);
    }
    expect(html).toContain("artifact.example/" + "a".repeat(32)); // open URL off artifactHost
  });

  it("artifact writes ride the proxy: PATCH pin, :publish, DELETE", async () => {
    const t = "a".repeat(32);
    const patch = await call(`/app/DomVinyard/life/plane/v1/artifacts/${t}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ pinned: false }) });
    expect(patch?.status).toBe(200);
    const pub = await call(`/app/DomVinyard/life/plane/v1/artifacts/${t}:publish`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ to: "private" }) });
    expect(pub?.status).toBe(200);
    const del = await call(`/app/DomVinyard/life/plane/v1/artifacts/${t}`, { method: "DELETE" });
    expect(del?.status).toBe(200);
    expect(seenWrites.some((w) => w.startsWith("PATCH /v1/artifacts/") && w.includes("pinned"))).toBe(true);
    expect(seenWrites.some((w) => w.includes(":publish"))).toBe(true);
    expect(seenWrites.some((w) => w.startsWith("DELETE /v1/artifacts/"))).toBe(true);
  });

  it("conversations renders the served pyramid: Active card, day + week rows", async () => {
    const html = await (await call("/app/DomVinyard/life/conversations"))!.text();
    for (const s of ["Conversations", "Active", "This week", "Earlier weeks", "Viewer fixes",
      "The menu closes on mobile now", "delivered", "No conversations yet".slice(0, 0) || "Earlier weeks"]) {
      expect(html).toContain(s);
    }
    expect(html).toContain("Jul 6"); // weekLabel for 2026-W28 → "Jul 6 – 12"
  });

  it("a transcript reads user/agent bubbles and drops injections", async () => {
    const html = await (await call("/app/DomVinyard/life/conversations/s1"))!.text();
    expect(html).toContain("How is it looking?");
    expect(html).toContain("All green.");
    expect(html).not.toContain("hidden nudge");
  });

  it("settings renders schema-driven groups with a writable enum", async () => {
    const html = await (await call("/app/DomVinyard/life/settings"))!.text();
    for (const s of ["Appearance", "Model", "Kimi", "Llama", "Tint", "orange"]) expect(html).toContain(s);
    expect(html).toContain("data-key=\"model\"");
  });

  it("identity mode: the session's identity token is the bearer; without one, re-login", async () => {
    const idCfg: ViewerConfig = { ...cfg, planes: { "DomVinyard/life": { url: PLANE, identity: true, owners: ["DomVinyard"] } } };
    // Pre-identity session → the sign-in nudge, never a silent GitHub view.
    let res = await viewerFetch(new Request(`${ORIGIN}/app/DomVinyard/life`, { headers: { Cookie: cookieFor } }), idCfg);
    expect(await res!.text()).toContain("Sign in again to unlock");
    // Session carrying an identity token → it IS the plane bearer.
    const sealed = await seal({ v: 1, login: "DomVinyard", name: "D", avatar: "a", token: "t",
      iat: Math.floor(Date.now() / 1000), identityToken: "id.jwt.token" }, SECRET);
    res = await viewerFetch(new Request(`${ORIGIN}/app/DomVinyard/life/plane/v1/self`, { headers: { Cookie: `life_view=${sealed}` } }), idCfg);
    expect(res?.status).toBe(200);
    expect(seenAuth.at(-1)).toBe("Bearer id.jwt.token");
  });

  it("a repo without a plane keeps the GitHub-derived sessions view", async () => {
    const res = await call("/app/DomVinyard/plain");
    expect(res?.status).toBe(200);
    const html = await res!.text();
    expect(html).not.toContain("Search Life");
  });
});
