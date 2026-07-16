#!/usr/bin/env bash
# Re-vendor the known.life/registry gene's CORE SOURCE into this site's
# src/registry/ — generated output, hash-verified against the registry, never
# hand-edited. `site/` is the registry's canonical INSTANCE: it consumes the gene
# (imports: known.life/registry), vendors the core here, and mounts registryFetch
# from src/middleware.ts, deploying it under known.life's route + stores + secrets.
# Edit the gene, not these files: `life fetch registry <dir>` → edit → `life
# mutate` → re-run this. Usage: bash site/vendor.sh [version]   (default: latest)
#
# The vendored copy is COMMITTED (not vendored at build): site/ deploys known.life
# itself, so resolving the gene from known.life at build time would be circular.
set -euo pipefail
VER="${1:-latest}"
DIR="$(cd "$(dirname "$0")" && pwd)"
python3 - "https://known.life/api/resolve/registry/${VER}" "$DIR/src/registry" <<'PYEOF'
import hashlib, json, pathlib, sys, urllib.request
url, dest = sys.argv[1], pathlib.Path(sys.argv[2])
req = urllib.request.Request(url, headers={"User-Agent": "vendor"})
d = json.load(urllib.request.urlopen(req, timeout=30))
sha = lambda s: hashlib.sha256(s.encode()).hexdigest()
files = d["files"]
canonical = "\n".join(f"{p}\0{sha(files[p])}" for p in sorted(files))
if sha(canonical) != d["content_hash"]:
    sys.exit("integrity: served files do not hash to content_hash")
core = sorted(p for p in files if p.startswith("src/registry/"))
# Clear any stale vendored files, then write the fresh set verbatim.
for old in dest.rglob("*"):
    if old.is_file() and old.name != "VENDORED.txt":
        old.unlink()
for p in core:
    out = dest / p[len("src/registry/"):]
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(files[p])
(dest / "VENDORED.txt").write_text(
    f"registry@{d['version']} package={d['content_hash']}\n"
    + "".join(f"{p}={sha(files[p])}\n" for p in core))
print(f"vendored registry@{d['version']} core ({len(core)} files) -> {dest}/ (hash-verified)")
PYEOF
