// Which registry-gene version this deployment vendored — read from the lockfile
// that decided it, at build time.
//
// The genepool's MCP handshake reports this as `serverInfo.version`. The gene
// cannot know it: a Worker has no filesystem, and a gene's version is assigned
// at publish rather than written into the gene. So the CONSUMER supplies it, and
// the consumer's own `.life.lock` is the record of what it resolved — the same
// pin the engine re-verifies on install.
//
// It was a literal in the gene, bumped by hand in the same publish. It drifted
// two majors once, and again in the very session that documented the rule —
// each time costing an extra publish to correct. A value the structure already
// holds is not worth maintaining twice (Law 11.9).
//
// Build-time only (node, not the Worker): imported by astro.config.mjs, which
// hands it to the middleware through a vite `define`.
import { readFileSync } from "node:fs";

const LOCK = new URL("../../.life.lock", import.meta.url);

/** The resolved `registry` pin, or "unknown" if the lockfile can't say. */
export function registryVersion() {
  try {
    const lock = JSON.parse(readFileSync(LOCK, "utf-8"));
    const resolved = lock?.modules?.registry?.resolved;
    // Announce the fallthrough by name rather than serving a made-up number:
    // a build whose lockfile has no registry pin has a real problem, and
    // "unknown" on the handshake is how it says so (Law 11.3).
    return typeof resolved === "string" && /^\d+\.\d+\.\d+$/.test(resolved) ? resolved : "unknown";
  } catch {
    return "unknown";
  }
}
