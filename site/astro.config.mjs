import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";

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
});
