import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";
import { fileURLToPath } from "node:url";
import { remarkCanonLinks } from "./build/remark-canon-links.mjs";

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
  // The spec moved into the Book of Life. It used to be hand-written HTML here,
  // beside a `life-guide` gene that documented the same fields — two sources, and
  // the docs copy was the one that had gone stale (it still described the
  // open-world head the epoch-2 waist replaced). The canon renders from the gene,
  // so there is nothing left to keep in step; these keep every published link
  // working. Governance stays site-side: it is THIS registry's operating policy,
  // not the protocol, and does not belong in a gene every .life inherits.
  redirects: {
    "/docs/interface": "/book/spec/life-schema",
    "/docs/spec/manifest": "/book/spec/manifest-format",
    "/docs/spec/registry-protocol": "/book/spec/registry-protocol",
    "/docs/spec/governance": "/docs/governance",
    // The three adapter pages went the same way, and for the same reason: they
    // restated the `claude-code` / `cloudflare` / `github` genes by hand, and had
    // drifted (the harness page still taught `surfaces:`, a key the epoch-2 waist
    // retired). The shape they share is one book chapter; the per-adapter detail
    // is each gene's own doc, which is the only copy that ships with the code.
    "/docs/adapters/harness": "/book/practice/adapters",
    "/docs/adapters/infrastructure": "/book/practice/adapters",
    "/docs/adapters/storage": "/book/practice/adapters",
  },
  adapter: cloudflare({
    platformProxy: { enabled: true }, // local `astro dev` gets D1/KV/R2 bindings
  }),
  // The Book of Life's chapters cross-link as files (they are read from disk as
  // often as from the web); this turns those `.md` links into book URLs.
  markdown: { remarkPlugins: [remarkCanonLinks] },
  vite: {
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
