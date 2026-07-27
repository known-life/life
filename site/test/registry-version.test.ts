import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { handleMcp } from "../../.genome/registry/src/registry/routes/mcp";
import { registryVersion } from "../build/registry-version.mjs";
import type { Env } from "../../.genome/registry/src/registry/lib/types";

// The MCP `initialize` handshake serves a serverInfo.version. It used to be a
// literal in the gene, bumped by hand at each publish, and this file asserted the
// literal against the lockfile pin — a guard over a value nobody should have been
// authoring. It drifted two majors once and again in the session that documented
// the rule, each time costing an extra publish to correct.
//
// Now the CONSUMER derives it (build/registry-version.mjs reads the same pin) and
// hands it to the gene on Env, so there is nothing left to drift. What is worth
// holding is the WIRING: that the derivation finds a real version, and that a
// deployment which fails to supply it FAILS rather than serving a placeholder.

const lock = () =>
  JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../.life.lock"), "utf-8"));

async function initialize(env: Partial<Env>): Promise<Response> {
  const req = new Request("https://known.life/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
  });
  return handleMcp(req, env as Env);
}

describe("MCP serverInfo.version is derived, not maintained", () => {
  it("the consumer resolves it from the registry pin it actually vendored", () => {
    const pinned = lock().modules?.registry?.resolved;
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
    expect(registryVersion()).toBe(pinned);
  });

  it("the gene serves what the consumer supplies, never a version of its own", async () => {
    // A literal in the gene would ignore this and answer its own number.
    for (const v of ["9.9.9", registryVersion()]) {
      const body = (await (await initialize({ REGISTRY_VERSION: v })).json()) as {
        result: { serverInfo: { version: string } };
      };
      expect(body.result.serverInfo.version).toBe(v);
    }
  });

  it("FAILS the handshake when nothing supplied it, rather than serving a placeholder", async () => {
    // It briefly answered "unknown" here. That is a degrade wearing the clothes
    // of an announced fallthrough: there is no situation in which serving it is
    // the right outcome, so it is a second path that is not load-bearing —
    // exactly what Law 11.3 forbids. When the one path cannot do its job, say so
    // and stop.
    const res = await initialize({});
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: { message?: string }; result?: unknown };
    expect(body.result).toBeUndefined();
    expect(body.error?.message).toContain("REGISTRY_VERSION");
  });
});

describe("the build-time derivation refuses to guess", () => {
  it("throws on a lockfile with no registry pin, rather than returning a placeholder", () => {
    // The same rule one layer earlier: no pin means the genome could not have
    // materialized, so there is no build worth completing. A try/catch returning
    // a string here is the swallowed error Law 11.3 names.
    const empty = path.join(os.tmpdir(), "registry-version-no-pin.lock");
    fs.writeFileSync(empty, JSON.stringify({ modules: {} }));
    expect(() => registryVersion(pathToFileURL(empty))).toThrow(/no resolved registry pin/);
  });

  it("throws on a lockfile whose pin is not a version, rather than passing it through", () => {
    const junk = path.join(os.tmpdir(), "registry-version-junk.lock");
    fs.writeFileSync(junk, JSON.stringify({ modules: { registry: { resolved: "latest" } } }));
    expect(() => registryVersion(pathToFileURL(junk))).toThrow(/no resolved registry pin/);
  });
});
