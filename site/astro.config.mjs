import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";
import { fileURLToPath } from "node:url";
import { registryVersion } from "./build/registry-version.mjs";

// The registry core is the known.life/registry gene, materialized into
// ../.genome/registry and imported by src/middleware.ts. Its npm deps live in
// THIS project's node_modules, but rollup resolves bare imports by walking up
// from the importing file (in .genome/, outside this root), so it can't see
// them. Alias the gene's four deps to this project's node_modules.
const dep = (name) => fileURLToPath(new URL(`./node_modules/${name}`, import.meta.url));

// The docs site is also the genepool. Most pages are static (prerendered docs),
// but the homepage renders on-demand (it shows live "popular genes" from D1)
// and `src/middleware.ts` forwards the dynamic genepool routes to the genepool
// handler — both need the Cloudflare runtime, hence the adapter. Static output
// keeps the docs as edge assets; on-demand routes run in the worker.
export default defineConfig({
  site: "https://known.life",
  output: "static",
  adapter: cloudflare({
    platformProxy: { enabled: true }, // local `astro dev` gets D1/KV/R2 bindings
  }),
  vite: {
    // The registry gene serves its own version on the MCP handshake but cannot
    // know it (no filesystem in a Worker, and a gene's version is assigned at
    // publish). This deployment DOES know — it is the lockfile pin it vendored —
    // so stamp it in at build time and let the middleware hand it over.
    define: { __REGISTRY_VERSION__: JSON.stringify(registryVersion()) },
    resolve: {
      alias: {
        jose: dep("jose"),
        tweetnacl: dep("tweetnacl"),
        blakejs: dep("blakejs"),
        "@anthropic-ai/sdk": dep("@anthropic-ai/sdk"),
      },
    },
  },
});
