import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
const gene = (f) => fileURLToPath(new URL(`../.genome/registry/src/registry/lib/${f}`, import.meta.url));
// lifekey's own tree. `verify.mjs` used to be covered through a vendored COPY
// inside the registry gene; registry@3.3.5 deleted every vendor dir and imports
// the sibling directly, so the coverage entry has to follow the code to its
// owner. It stays in the spine either way — it is the auth root of trust.
const lk = (f) => fileURLToPath(new URL(`../.genome/lifekey/lib/${f}`, import.meta.url));

// The worker's security spine — scan (leak gate), lifekey-verify (auth root of
// trust), jwt (the write-endpoint bearer), gh-secrets (the CI-credential
// sealer). These modules use only standard
// web-platform crypto (WebCrypto Ed25519, jose HS256, tweetnacl sealed box)
// and regex — no Cloudflare
// bindings, no network (every fetch is stubbed) — so they
// behave identically in Node and workerd, and run here under the plain Node
// runner: fast, credential-free, and rides the clean CI tier. (If a future lib
// test needs a real binding, switch this project to @cloudflare/vitest-pool-
// workers; nothing here does.)
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      // The security-spine modules now live in the known.life/registry gene,
      // materialized (gitignored) at ../.genome/registry/. allowExternal lets v8
      // instrument files outside this project root (the gene tree).
      allowExternal: true,
      include: [
        // A coverage include that resolves to no file does not FAIL — it silently
        // drops out of the ratchet, which then guards less than it claims to
        // (Law 5.10). This list has been wrong that way once already, so every
        // entry here is a real path with a real extension.
        gene("scan.ts"), gene("jwt.ts"), gene("gh-secrets.ts"), lk("verify.mjs"),
      ],
      // A regression ratchet set just below achieved coverage — it fails CI the
      // moment a future edit drops a tested path. Not 100%: the residual lines
      // are unreachable defensive guards (a valid-prefix-but-wrong-type ssh blob,
      // a non-ok-non-404 github response); the contract tests, not these last
      // branches, are the real assurance.
      thresholds: { lines: 97, functions: 100, statements: 95, branches: 88 },
      reporter: ["text-summary"],
    },
  },
});
