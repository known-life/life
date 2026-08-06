import { defineConfig } from "vitest/config";

// What is left here is the CONSUMER's half: the Book of Life's build-time
// transforms, the law-binding render, the viewer scaffold, and the parity check
// that the MCP `serverInfo.version` this worker serves is the registry pin from
// its own lockfile. Everything that tests a GENE moved into that gene — the
// registry core to `known.life/registry`, the auth root of trust to
// `known.life/lifekey` — where a .life inheriting it runs the assertions too,
// and each carries its own coverage ratchet over its own security spine
// (law:no-second-copy). A ratchet here would have measured someone else's code.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
