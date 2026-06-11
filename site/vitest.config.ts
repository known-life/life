import { defineConfig } from "vitest/config";

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
      include: [
        "src/registry/lib/scan.ts",
        "src/registry/lib/lifekey-verify.ts",
        "src/registry/lib/jwt.ts",
        "src/registry/lib/gh-secrets.ts",
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
