#!/usr/bin/env bash
# Re-vendor the lifekey gene's canonical verify primitive into the registry
# worker's src/registry/lib/. Run before deploying if you want this cut of the
# registry to track the latest lifekey wire format.
#
# The lifekey gene is the SINGLE source of truth for worker-side verification
# (lib/verify.mjs) AND its known-answer conformance vector (tests/vector.json).
# This script copies BOTH in VERBATIM — no hand-port, no TS fork — so the
# registry can never semantically drift from canonical, and both the gene's
# suite and the worker's (test/lifekey-verify.test.ts) verify the SAME fixed
# signature: a drift in either copy fails its own suite. wrangler bundles
# relative .mjs imports (esbuild), and astro `check` infers types from the
# source via tsconfig allowJs, so the committed copy needs no type stub.
#
# The registry is the ONE downstream consumer — the secrets vault dropped its
# lifekey bootstrap in the secrets@2.13.0 auth collapse (tokenless /exchange
# only) and no longer vendors the verifier. Change the protocol in the lifekey
# gene, bump+publish it, then re-run this here.
#
# Usage:  bash scripts/vendor-lifekey.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CORE="${LIFE_CORE:-${ROOT}/../.life.engine}"
[ -x "$CORE" ] || { echo "✗ no engine at $CORE — set LIFE_CORE to your .life.engine."; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

"$CORE" fetch lifekey "$TMP/lifekey" --force >/dev/null
SRC="$TMP/lifekey/lib/verify.mjs"
[ -f "$SRC" ] || { echo "✗ lifekey gene has no lib/verify.mjs."; exit 1; }

DST="$ROOT/src/registry/lib/lifekey-verify.mjs"
mkdir -p "$(dirname "$DST")"
cp "$SRC" "$DST"
echo "✓ vendored lifekey verify → $(realpath --relative-to="$ROOT" "$DST")"

# The conformance vector — same canonical fixture the gene's own suite asserts.
VEC="$TMP/lifekey/tests/vector.json"
[ -f "$VEC" ] || { echo "✗ lifekey gene has no tests/vector.json (publish lifekey ≥1.5.1)."; exit 1; }
VDST="$ROOT/test/vectors/lifekey.json"
mkdir -p "$(dirname "$VDST")"
cp "$VEC" "$VDST"
echo "✓ vendored lifekey conformance vector → $(realpath --relative-to="$ROOT" "$VDST")"
