import { describe, it, expect } from "vitest";
import { registryFetch } from "../../.genome/registry/src/registry/router";
import { handleIcon } from "../../.genome/registry/src/registry/routes/icon";
// Plain .mjs, shared with scripts/put-icons.mjs so the key layout has
// exactly one definition; tsconfig's allowJs resolves it.
import { iconKey } from "../../.genome/registry/src/registry/lib/icons.mjs";
import type { Env } from "../../.genome/registry/src/registry/lib/types";

// A gene's icon is addressed by the gene's NAME — `GET /:name/icon` reads
// `icons/<name>.png` from the pool's object store — so no consumer keeps a
// name→asset map. The three things worth holding to:
//   • the key is DERIVED from the name (the one thing the upload script and the
//     route must agree on, which is why they import the same function),
//   • a gene with no art answers 404 rather than something broken, because the
//     consumer's fallback is a real design (a drawn glyph tile), and
//   • the route is reached through the router, at the path consumers derive.

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** An Env whose R2 holds exactly the given keys. */
function envWith(objects: Record<string, Uint8Array>): Env {
  const meta = (bytes: Uint8Array) => ({
    size: bytes.byteLength,
    httpMetadata: { contentType: "image/png" },
    httpEtag: '"etag-for-test"',
  });
  return {
    KNOWN_R2: {
      async get(key: string) {
        const bytes = objects[key];
        if (!bytes) return null;
        return { ...meta(bytes), body: new Blob([bytes as BlobPart]).stream() };
      },
      // HEAD reads metadata only — no body, and no bytes off R2 either.
      async head(key: string) {
        const bytes = objects[key];
        return bytes ? meta(bytes) : null;
      },
    },
  } as unknown as Env;
}

describe("a gene's icon is served by the pool that holds the gene", () => {
  it("addresses the icon by the gene's own name", () => {
    expect(iconKey("expo")).toBe("icons/expo.png");
    expect(iconKey("stripe-billing")).toBe("icons/stripe-billing.png");
  });

  it("serves the bytes for a gene that has art", async () => {
    const res = await handleIcon(envWith({ [iconKey("expo")]: PNG }), "expo", "GET");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
  });

  it("caches for a day rather than forever — gene art gets redrawn", async () => {
    const res = await handleIcon(envWith({ [iconKey("expo")]: PNG }), "expo", "GET");
    const cc = res.headers.get("Cache-Control") ?? "";
    expect(cc).toContain("max-age=86400");
    expect(cc).not.toContain("immutable");
    expect(res.headers.get("ETag")).toBeTruthy();
  });

  it("404s for a gene with no art, so the consumer draws its own fallback", async () => {
    const res = await handleIcon(envWith({}), "a-gene-published-tomorrow", "GET");
    expect(res.status).toBe(404);
    // Cached, but briefly: publishing art must show up without a purge.
    expect(res.headers.get("Cache-Control")).toContain("max-age=300");
  });

  it("is reachable at /:name/icon through the router", async () => {
    const env = envWith({ [iconKey("queue")]: PNG });
    const res = await registryFetch(
      new Request("https://known.life/queue/icon"),
      env,
      { waitUntil() {} },
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(res!.headers.get("Content-Type")).toBe("image/png");
  });

  it("answers HEAD about art that is there, instead of 404ing over it", async () => {
    // A GET-only route sends HEAD to the site's own 404, so a probe asking
    // "does this icon exist?" is told no about a file sitting in the store.
    const env = envWith({ [iconKey("queue")]: PNG });
    const res = await registryFetch(
      new Request("https://known.life/queue/icon", { method: "HEAD" }),
      env,
      { waitUntil() {} },
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(res!.headers.get("Content-Type")).toBe("image/png");
    expect(res!.headers.get("Content-Length")).toBe(String(PNG.byteLength));
    expect((await res!.arrayBuffer()).byteLength).toBe(0);
  });

  it("does not swallow paths that only look like it", async () => {
    const env = envWith({});
    // A POST is not this route, and a deeper path is nobody's — both must fall
    // through to Astro (null) rather than 404 from the genepool.
    for (const req of [
      new Request("https://known.life/queue/icon", { method: "POST" }),
      new Request("https://known.life/queue/icon/large"),
    ]) {
      expect(await registryFetch(req, env, { waitUntil() {} })).toBeNull();
    }
  });
});
