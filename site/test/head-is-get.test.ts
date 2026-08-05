import { describe, it, expect } from "vitest";
import { registryFetch } from "../../.genome/registry/src/registry/router";
import type { Env } from "../../.genome/registry/src/registry/lib/types";

// A HEAD is a GET whose response carries no body. The router dispatches on an
// exact `method === "GET"`, so before this every HEAD fell through to 404 —
// measured live 2026-08-05: `curl -I https://known.life/api/resolve/queue/0.11.20`
// answered 404 while a GET on the identical URL answered 200. A HEAD is the cheap
// way to ask "does this version exist", so the pool's front door was denying live
// versions (law:lying-signal), and any header read off one of those 404s described
// a resource that was not there.
//
// Pinned here rather than per-route: the normalisation is ONE branch at the top of
// the router, so one test covers every GET it will ever serve.

const env = {} as Env;
const ctx = {} as never;
const url = "https://known.life/healthz";

describe("HEAD mirrors GET", () => {
  it("answers a HEAD with the GET's status, never a fall-through 404", async () => {
    const get = await registryFetch(new Request(url), env, ctx);
    const head = await registryFetch(new Request(url, { method: "HEAD" }), env, ctx);
    expect(get?.status).toBe(200);
    expect(head?.status).toBe(get?.status);
  });

  it("carries no body, which is what makes it a HEAD and not a GET", async () => {
    const head = await registryFetch(new Request(url, { method: "HEAD" }), env, ctx);
    expect(await head!.text()).toBe("");
  });

  it("keeps the GET's headers, so a header-only probe reads the real resource", async () => {
    const get = await registryFetch(new Request(url), env, ctx);
    const head = await registryFetch(new Request(url, { method: "HEAD" }), env, ctx);
    expect(head!.headers.get("content-type")).toBe(get!.headers.get("content-type"));
  });

  it("passes a non-route through as null, so the site still gets its turn", async () => {
    const head = await registryFetch(
      new Request("https://known.life/a/deep/path/no/route/claims", { method: "HEAD" }), env, ctx);
    expect(head).toBeNull();
  });
});
