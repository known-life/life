// Node 05b's remainder: the Genes browser (App-Store style, /v1/genes) and the
// commit view (/v1/commits/{sha}) — plane-served, transcribed from the RN
// screens in DomVinyard/justin make/mobile (app/genes/*, app/commit/[sha]).
// Fidelity source: knowledge/viewer-app-parity-plan.md.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { viewerFetch } from "../../.genome/viewer/src/router";
import { seal } from "../../.genome/viewer/src/crypto";
import type { ViewerConfig } from "../../.genome/viewer/src/config";

const ORIGIN = "https://known.life";
const SECRET = "0123456789abcdef0123456789abcdef"; // synthetic fixture, not a credential — gitleaks:allow
const PLANE = "https://plane.example";
const IDTOK = "idtok.genes.test"; // synthetic fixture, not a credential — gitleaks:allow

const cfg: ViewerConfig = {
  basePath: "/app",
  idpOrigin: ORIGIN,
  idpFetch: async () => new Response("unused", { status: 500 }),
  sessionSecret: SECRET,
};

const LIFE_MANIFEST = `name: life\ndataplane: ${PLANE}\n---\nbody`;

const SHA = "0123abcd0123abcd0123abcd0123abcd0123abcd";

function planeMock(url: string, auth: string): Response | null {
  const u = new URL(url);
  if (u.origin !== PLANE) return null;
  if (auth !== `Bearer ${IDTOK}`) return Response.json({ title: "unauthorized" }, { status: 401 });
  const env = (data: unknown) => Response.json({ data });
  if (u.pathname === "/v1/genes") return env([
    { name: "secrets", installed: true, installedVersion: "4.1.0", poolVersion: "4.1.0", installs: 27, description: "KV-backed credential vault + egress proxy." },
    { name: "dataplane", installed: true, installedVersion: "1.3.0", poolVersion: "1.3.0", installs: 2, description: "The Life data plane." },
    { name: "video", installed: false, installedVersion: null, poolVersion: "0.4.2", installs: 2, description: "Make videos from a Life session." },
  ]);
  if (u.pathname === "/v1/genes/secrets") return env({
    name: "secrets", version: "4.1.0", installed: true, installedVersion: "4.1.0", yanked: false,
    contract: { requires: ["infra.compute", "infra.kv"], provides: ["secrets.store"] },
    files: [{ path: "hooks/vault-hydrate.mjs", size: 7000 }, { path: "README.md", size: 900 }],
  });
  if (u.pathname === "/v1/genes/secrets/files/README.md")
    return env({ content: "# secrets\n\nThe vault." });
  if (u.pathname === "/v1/genes/secrets/files/hooks/vault-hydrate.mjs")
    return env({ content: "// hydrate\nconst n = 1;\n" });
  if (u.pathname === `/v1/commits/${SHA}`) return env({
    sha: SHA, message: "I lit the plane\n\nDetails of the change.",
    author: "domvinyard", date: "2026-07-18T18:00:00Z",
    stats: { additions: 12, deletions: 3 },
    files: [
      { filename: "dataplane/.life", status: "modified", additions: 10, deletions: 3, patch: "@@ -1,2 +1,2 @@\n-old line\n+new line\n context" },
      { filename: "assets/logo.png", status: "added", additions: 2, deletions: 0, patch: null },
    ],
  });
  return Response.json({ title: "not found" }, { status: 404 });
}

function ghMock(url: string): Response | null {
  const u = new URL(url);
  if (u.origin !== "https://api.github.com") return null;
  if (u.pathname === "/repos/DomVinyard/life/contents/.life") return new Response(LIFE_MANIFEST);
  return Response.json({}, { status: 200 });
}

let cookieFor = "";

beforeEach(async () => {
  const sealed = await seal(
    { v: 1, login: "DomVinyard", name: "DomVinyard", avatar: "https://a/1", token: "gho_test",
      iat: Math.floor(Date.now() / 1000), identityToken: IDTOK },
    SECRET,
  );
  cookieFor = `life_view=${sealed}`;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : null;
    const url = String(req ? req.url : input);
    const auth = req?.headers.get("authorization") ?? (init?.headers as Record<string, string>)?.Authorization ?? "";
    return planeMock(url, auth) ?? ghMock(url) ?? new Response("unexpected " + url, { status: 500 });
  }));
});
afterEach(() => vi.unstubAllGlobals());

const call = (path: string) =>
  viewerFetch(new Request(`${ORIGIN}${path}`, { headers: { Cookie: cookieFor } }), cfg);

describe("genes browser (App-Store, plane-served)", () => {
  it("lists Installed on top (alpha) then Available, with count pill and filter box", async () => {
    const res = await call("/app/DomVinyard/life/genes");
    expect(res?.status).toBe(200);
    const html = await res!.text();
    expect(html).toContain("Genes");
    expect(html).toContain("2 / 3"); // installed / pool count pill
    expect(html).toContain("Installed ·");
    expect(html).toContain("Available ·");
    // alpha within installed: dataplane before secrets
    expect(html.indexOf(">dataplane<")).toBeLessThan(html.indexOf(">secrets<"));
    expect(html).toContain("Filter genes");
    expect(html).toContain("no genes"); // the hidden filter-miss string
  });

  it("gene detail renders the store hero: version · installs, Installed pill, contract, files tree", async () => {
    const res = await call("/app/DomVinyard/life/genes/secrets");
    expect(res?.status).toBe(200);
    const html = await res!.text();
    expect(html).toContain("4.1.0  ·  27 installs");
    expect(html).toContain("Installed");
    expect(html).toContain("Provides");
    expect(html).toContain("secrets.store");
    expect(html).toContain("Requires");
    expect(html).toContain("Files · 2");
    expect(html).toContain("README.md");
    expect(html).toContain("hooks"); // folder row
    // Read-only surface: the app's Inherit/Remove chat directive has no web twin.
    expect(html).not.toContain(">Inherit<");
    expect(html).not.toContain(">Remove<");
  });

  it("markdown gene file renders rich; source renders with a line gutter", async () => {
    const md = await call("/app/DomVinyard/life/genes/secrets/file/README.md");
    expect(md?.status).toBe(200);
    const mdHtml = await md!.text();
    expect(mdHtml).toContain("The vault.");
    expect(mdHtml).toContain("README.md · 3 lines");

    const src = await call("/app/DomVinyard/life/genes/secrets/file/hooks/vault-hydrate.mjs");
    expect(src?.status).toBe(200);
    const srcHtml = await src!.text();
    expect(srcHtml).toContain("code-gutter");
    expect(srcHtml).toContain("// hydrate"); // comment token survives escaping
  });
});

describe("commit view (plane-served)", () => {
  it("renders subject, body, author · date, stats, and per-file diffs colored by role", async () => {
    const res = await call(`/app/DomVinyard/life/commit/${SHA}`);
    expect(res?.status).toBe(200);
    const html = await res!.text();
    expect(html).toContain(`Commit ${SHA.slice(0, 8)}`);
    expect(html).toContain("I lit the plane");
    expect(html).toContain("Details of the change.");
    expect(html).toContain("domvinyard");
    expect(html).toContain("2026-07-18 18:00Z");
    expect(html).toContain("2 files");
    expect(html).toContain("+12");
    expect(html).toContain("−3");
    expect(html).toContain("dataplane/.life");
    expect(html).toContain("cm-add"); // +new line
    expect(html).toContain("cm-del"); // -old line
    expect(html).toContain("cm-hunk"); // @@ header
    expect(html).toContain("No text diff (binary or too large)");
  });

  it("an unknown sha renders the app's empty state, not an error page", async () => {
    const res = await call(`/app/DomVinyard/life/commit/ffffffffffffffffffffffffffffffffffffffff`);
    expect(res?.status).toBe(200);
    expect(await res!.text()).toContain("Commit not found");
  });
});
