// Which registry-gene version this deployment vendored — read from the lockfile
// that decided it, at build time.
//
// The genepool's MCP handshake reports this as `serverInfo.version`. The gene
// cannot know it: a Worker has no filesystem, and a gene's version is assigned
// at publish rather than written into the gene. So the CONSUMER supplies it, and
// this repo's `.life.lock` is the record of what it resolved — the same pin the
// engine re-verifies on install.
//
// It was a literal in the gene, bumped by hand at every publish. It drifted two
// majors once, and again in the very session that documented the rule — each
// time costing an extra publish to correct. A value the structure already holds
// is not worth authoring twice (Law 11.9).
//
// THROWS rather than returning a placeholder. There is no lockfile state in
// which "build anyway" is right: no registry pin means the genome could not have
// materialized, so the worker being built has no registry core in it. A
// try/catch returning "unknown" here is a swallowed error — the exact thing
// Law 11.3 names — and it buys a green build that ships a handshake misreporting
// its own version. A red build says so and stops, at the moment it is cheapest.
//
// Build-time only (node, not the Worker): imported by astro.config.mjs, which
// stamps the value into the worker through a vite `define`.
import { readFileSync } from "node:fs";

const LOCK = new URL("../../.life.lock", import.meta.url);

/**
 * The resolved `registry` pin. Throws if the lockfile cannot say.
 * `lockUrl` is a seam for the test — production always reads this repo's lock.
 */
export function registryVersion(lockUrl = LOCK) {
  const lock = JSON.parse(readFileSync(lockUrl, "utf-8"));
  const resolved = lock?.modules?.registry?.resolved;
  if (typeof resolved !== "string" || !/^\d+\.\d+\.\d+$/.test(resolved)) {
    throw new Error(
      `registry-version: no resolved registry pin in ${lockUrl.pathname ?? lockUrl} ` +
        `(found ${JSON.stringify(resolved)}). The worker's registry core comes from that pin, ` +
        `so a build without it would ship a genepool that misreports its own version.`,
    );
  }
  return resolved;
}
