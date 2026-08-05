import { describe, it, expect } from "vitest";
import { resolveCacheControl } from "../../.genome/registry/src/registry/routes/resolve";

// The edge-cache write and the returned response used to carry DIFFERENT
// Cache-Control values: the put said `public, s-maxage=…` while the miss handed
// the caller `no-store`, so the origin cached an artifact it told every
// intermediary not to keep. Measured live 2026-08-05 — four cold exact-version
// resolves (soul/0.3.7, viewer/0.12.16, log/1.0.0, thought/0.1.0) came back
// `no-store` with no cf-cache-status header at all, and cold is the path CI's
// `inherit --locked`, a fresh session and the Sandbox runner take every time.
//
// One rule, one value, both call sites — so the two can no longer disagree.

describe("resolveCacheControl", () => {
  it("makes an exact, non-yanked version cacheable — it is immutable by the pool's rule", () => {
    expect(resolveCacheControl(true, 3600)).toBe("public, s-maxage=3600");
  });

  it("carries the TTL it is given rather than a constant of its own", () => {
    expect(resolveCacheControl(true, 60)).toBe("public, s-maxage=60");
  });

  it("refuses to cache anything else — `latest` moves, and a yank must stay live", () => {
    expect(resolveCacheControl(false, 3600)).toBe("no-store");
  });
});
