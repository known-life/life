#!/bin/sh
set -eu

# Life installer
# Usage: curl -fsSL https://known.life/install.sh | sh
#
# Fully inspectable at the URL above (this file is the source of truth;
# site/public/install.sh is a build-time copy — site/.life declares this file
# under deploy_inputs:, so an edit here auto-deploys the site that serves it).
# Source: https://github.com/known-life/life

REGISTRY="${KNOWN_LIFE_URL:-https://known.life}"

# Silence Node's experimental-API warnings for the whole cold-start chain (the
# node -e extractors below AND the engine `setup` exec at the end). On a proxied
# harness — Claude Code on the web, the primary onboarding path — Node eagerly
# constructs undici's EnvHttpProxyAgent and prints a multi-line UNDICI-EHPA
# "experimental" warning on every spawn. It's harmless proxy noise, but to a
# fresh onboarding agent three scary-looking warnings read as "something broke."
# None of these warnings are user-actionable during install, so suppress them.
export NODE_NO_WARNINGS=1

echo "Life"
echo ""

# Cold-start sequence — three packages over the wire, one process exec.
#
# The Life root surface is `.life` (manifest) + `.life.lock` (resolved) +
# `.life.engine` (runtime binary); compiled output lives under .genome/.
# The engine, harness adapter, and setup gene are all genes in the
# registry, fetched via /api/resolve/<name>/latest the same way every Life
# fetches everything else. The engine binary is files["life"] in the engine
# package's resolve response.

mkdir -p .genome

# 1. Engine → .life.engine
echo "Fetching engine → .life.engine ..."
curl -fsSL "$REGISTRY/api/resolve/life/latest" -o .genome/.engine.json
node -e 'const fs=require("fs");const d=JSON.parse(fs.readFileSync(".genome/.engine.json","utf8"));if(!d||!d.files||typeof d.files.life!=="string"){console.error("life gene has no engine binary (files.life)");process.exit(1)}fs.writeFileSync(".life.engine",d.files.life)'
chmod +x .life.engine
rm -f .genome/.engine.json

# 2. Harness adapter (claude-code) — the engine bundles no adapters; session-1
# `evolve` compiles the harness layer and needs an adapter present.
echo "Fetching harness adapter → .genome/claude-code ..."
curl -fsSL "$REGISTRY/api/resolve/claude-code/latest" -o .genome/.adapter.json
node -e 'const fs=require("fs"),p=require("path");const d=JSON.parse(fs.readFileSync(".genome/.adapter.json","utf8"));if(!d||!d.files){console.error("adapter gene malformed");process.exit(1)}const dest=".genome/claude-code";for(const[rel,c]of Object.entries(d.files)){const f=p.join(dest,rel);fs.mkdirSync(p.dirname(f),{recursive:true});fs.writeFileSync(f,c)}'
rm -f .genome/.adapter.json

# 3. Setup package — the come-alive flow. Pre-fetching it (rather than letting
# the engine fetch lazily) means the agent reaches the wizard immediately on
# the exec below, with no per-package latency hiccup in between.
echo "Fetching setup → .genome/setup ..."
curl -fsSL "$REGISTRY/api/resolve/setup/latest" -o .genome/.setup.json
node -e 'const fs=require("fs"),p=require("path");const d=JSON.parse(fs.readFileSync(".genome/.setup.json","utf8"));if(!d||!d.files){console.error("setup gene malformed");process.exit(1)}const dest=".genome/setup";for(const[rel,c]of Object.entries(d.files)){const f=p.join(dest,rel);fs.mkdirSync(p.dirname(f),{recursive:true});fs.writeFileSync(f,c)}const sh=p.join(dest,"bin","setup.sh");if(fs.existsSync(sh))fs.chmodSync(sh,0o755);'
rm -f .genome/.setup.json

# 4. Stub .life if absent. One paragraph, no verb list — the agent should be
# in the setup wizard before reading anything else. The harness adapter fetched
# in step 2 must be DECLARED here, not just present on disk: `.genome/` is
# materialized from the lock, so the first `life evolve` garbage-collects any
# adapter dir that no .life imports — leaving session-1 with no harness and no
# .claude/settings.json. Declaring the import pins it (setup preserves the block;
# it only inserts secrets_worker_url after `name:`).
if [ ! -f .life ]; then
  cat > .life << 'EOF'
life: 1.0
name: my-project
summary: "A Life — just installed via known.life"
imports:
  known.life/claude-code:

---

# This repo is a Life.

The setup wizard is running. Follow its instructions until you see the
literal sentinel line:

    LIFE_ALIVE: <login>

That marks the come-alive moment. Until then there is nothing else worth
reading — the wizard is the contract.
EOF
  echo "Created .life"
fi

echo ""

# Hand off to setup. The engine's `setup` verb execs the setup gene's
# bin/setup.sh, which is a resumable state machine:
#
#   - env has CLOUDFLARE_API_TOKEN + GITHUB_TOKEN + CLOUDFLARE_ACCOUNT_ID
#     (CI / pre-populated env) → fast-path straight to provisioning.
#   - env empty (raw curl from an agent) → device flow for GitHub → one
#     Cloudflare OAuth consent (known.life brokers a short-lived deploy token;
#     no token paste) → provision. Each step exits 0 with a `NEED:` block the
#     agent relays to the user; user acts; agent re-runs.
#
# Either path lands at the same provisioning code and ends with the literal
# sentinel `LIFE_ALIVE: <login>` on success.

# LIFE_SKIP_SETUP lets a non-interactive caller stop before the setup handoff —
# the engine is installed and `life inherit` works, but no GitHub device flow is
# started. Used by reconstruct CI (which needs no credentials) so a credentials-
# free reproducibility test never depends on GitHub's live device endpoint.
[ -n "${LIFE_SKIP_SETUP:-}" ] && { echo "LIFE_SKIP_SETUP set — engine installed, skipping setup handoff."; exit 0; }

exec ./.life.engine setup
