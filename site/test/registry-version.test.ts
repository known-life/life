import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
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
// holding is the WIRING: that the derivation finds a real version, and that the
// gene serves whatever it is given rather than a number of its own.

const lock = () =>
  JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../.life.lock"), "utf-8"));

async function initialize(env: Partial<Env>): Promise<string> {
  const req = new Request("https://known.life/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
  });
  const res = await handleMcp(req, env as Env);
  const body = (await res.json()) as { result: { serverInfo: { version: string } } };
  return body.result.serverInfo.version;
}

describe("MCP serverInfo.version is derived, not maintained", () => {
  it("the consumer resolves it from the registry pin it actually vendored", () => {
    const pinned = lock().modules?.registry?.resolved;
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
    expect(registryVersion()).toBe(pinned);
  });

  it("the gene serves what the consumer supplies, never a version of its own", async () => {
    // A literal in the gene would ignore this and answer its own number.
    expect(await initialize({ REGISTRY_VERSION: "9.9.9" })).toBe("9.9.9");
    expect(await initialize({ REGISTRY_VERSION: registryVersion() })).toBe(registryVersion());
  });

  it("says 'unknown' rather than inventing one when nothing supplied it", async () => {
    // A consumer that hasn't wired this up should be legible as such, not served
    // a plausible number the gene made up (Law 11.3 — announce the fallthrough).
    expect(await initialize({})).toBe("unknown");
  });
});
