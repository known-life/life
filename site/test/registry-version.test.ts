import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { handleMcp } from "../../.genome/registry/src/registry/routes/mcp";
import type { Env } from "../../.genome/registry/src/registry/lib/types";

// The MCP `initialize` handshake serves a serverInfo.version. It used to be a
// literal in the gene, bumped by hand at each publish, and this file asserted the
// literal against the lockfile pin — a guard over a value nobody should have been
// authoring. It drifted two majors once and again in the session that documented
// the rule, each time costing an extra publish to correct.
//
// It is now a `vars:` entry in this unit's `.life` (`REGISTRY_VERSION:
// "{{gene:registry}}"`), which the cloudflare adapter resolves from this repo's
// lockfile at deploy — so the value is DECLARED, and there is nothing to keep
// true. That template's own resolution is the adapter's to test
// (.genome/cloudflare/tests/adapter.test.mjs).
//
// What is left to hold here is the CONTRACT: the gene serves whatever the
// deployment supplies, never a version of its own, and a deployment that supplies
// nothing FAILS rather than serving a placeholder.

async function initialize(env: Partial<Env>): Promise<Response> {
  const req = new Request("https://known.life/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
  });
  return handleMcp(req, env as Env);
}

describe("MCP serverInfo.version is declared, not maintained", () => {
  it("the unit declares it as the registry pin, rather than a literal", () => {
    // The `.life` is the record: a template, not a number somebody typed.
    const life = fs.readFileSync(path.resolve(__dirname, "../.life"), "utf-8");
    expect(life).toContain('REGISTRY_VERSION: "{{gene:registry}}"');
  });

  it("the gene serves what the deployment supplies, never a version of its own", async () => {
    const pinned = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, "../../.life.lock"), "utf-8"),
    ).modules?.registry?.resolved as string;
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);

    // A literal in the gene would ignore both of these and answer its own number.
    for (const v of ["9.9.9", pinned]) {
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
    // exactly what law/fail-fast forbids. When the one path cannot do its job, say so
    // and stop.
    const res = await initialize({});
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: { message?: string }; result?: unknown };
    expect(body.result).toBeUndefined();
    expect(body.error?.message).toContain("REGISTRY_VERSION");
  });
});
