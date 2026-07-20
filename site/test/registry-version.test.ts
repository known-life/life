import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { handleMcp } from "../../.genome/registry/src/registry/routes/mcp";
import type { Env } from "../../.genome/registry/src/registry/lib/types";

// The MCP `initialize` handshake serves a serverInfo.version. That constant is
// hand-set in the gene at each publish, so this test derives the truth from the
// lockfile's registry pin and holds the served value to it — a publish that
// forgets the bump goes red here at the next re-vendor (it once drifted two
// majors, serving "0.2.0" from registry@2.2.1).

describe("MCP serverInfo.version tracks the registry gene version", () => {
  it("initialize serves the lockfile's resolved registry version", async () => {
    const lock = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../.life.lock"), "utf-8"));
    const pinned = lock.modules?.registry?.resolved;
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);

    const req = new Request("https://known.life/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    });
    const res = await handleMcp(req, {} as Env);
    const body = await res.json() as { result: { serverInfo: { version: string } } };
    expect(body.result.serverInfo.version).toBe(pinned);
  });
});
