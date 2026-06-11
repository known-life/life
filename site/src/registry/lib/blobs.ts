import type { Env } from "./types";

/**
 * Content-addressed blob store on R2. Adapted from slices' putBlob/getBlob
 * (idempotent, dedup'd by sha256). A gene version is a manifest of
 * `path → blob sha`; identical file bytes across versions share one blob.
 */

export async function sha256Hex(content: string): Promise<string> {
  const data = new TextEncoder().encode(content);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Store file bytes, return their sha. No-op write if the blob already exists. */
export async function putBlob(env: Env, content: string): Promise<string> {
  const sha = await sha256Hex(content);
  const key = `blobs/${sha}`;
  const head = await env.KNOWN_R2.head(key);
  if (!head) await env.KNOWN_R2.put(key, content);
  return sha;
}

export async function getBlob(env: Env, sha: string): Promise<string | null> {
  const obj = await env.KNOWN_R2.get(`blobs/${sha}`);
  if (!obj) return null;
  return await obj.text();
}

/**
 * A version's content hash: a deterministic digest over its sorted
 * (path → blob-sha) manifest. Stable regardless of file insertion order;
 * this is what `.life.lock` pins and the engine re-verifies on install.
 */
export async function manifestHash(files: Record<string, string>): Promise<string> {
  const canonical = Object.keys(files)
    .sort()
    .map((p) => `${p}\0${files[p]}`)
    .join("\n");
  return await sha256Hex(canonical);
}
