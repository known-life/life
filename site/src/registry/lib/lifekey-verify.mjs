// lifekey verification — the canonical worker-side primitive.
//
// Runs in any verifier that can reach github.com: a Cloudflare Worker, a Node
// service, the registry, a self-hosted vault. Given a claimed GitHub login, a
// nonce the verifier issued, and one-or-more signatures, confirm a signature
// was made by a key GitHub publishes for that login — i.e. "this action is
// authorized by @login".
//
// Uses WebCrypto (Workers + Node 18+) so the same code verifies on the edge
// and on a server. No secret, no token — reads only PUBLIC github.com/<login>.keys.
//
// CONSUMERS — each vendors this file VERBATIM (never a hand-port: the retired
// TS port had silently drifted) and proves no semantic drift against the shared
// tests/vector.json known-answer fixture:
// - known.life registry worker — site/src/registry/lib/lifekey-verify.mjs via
//   site/scripts/vendor-lifekey.sh.
// - the secrets vault — src/lib/lifekey-verify.mjs via the secrets gene's own
//   vendor-lifekey.sh. (It had dropped lifekey in the secrets@2.13.0 auth
//   collapse, then re-became a consumer when Path B — the warm /exchange/lifekey
//   re-auth — was built: it verifyGithubIdentity's the owner's nonce signature.)
// - any other Life service that wants user-scoped identity proofs.
//
// This file is the source of truth. Re-vendor downstream via the consumer's
// vendor-lifekey script. Change the protocol here, version-bump, republish.

/** Parse an OpenSSH ssh-ed25519 line → raw 32-byte public key (Uint8Array|null). */
export function rawFromOpenSsh(line) {
  const m = line.trim().match(/^ssh-ed25519\s+([A-Za-z0-9+/=]+)/);
  if (!m) return null;
  const blob = Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0));
  const dv = new DataView(blob.buffer);
  let off = 0;
  const tlen = dv.getUint32(off); off += 4;
  const type = new TextDecoder().decode(blob.slice(off, off + tlen)); off += tlen;
  if (type !== "ssh-ed25519") return null;
  const klen = dv.getUint32(off); off += 4;
  if (klen !== 32) return null;
  return blob.slice(off, off + 32);
}

/**
 * Fetch the public ssh-ed25519 keys GitHub serves for a login.
 * Retries on transient failures (network blip / 5xx) — 3 attempts, ~300ms apart.
 * 404 → empty array (the login has no keys). Anything else still failing after
 * the retries → empty array (callers treat that as "couldn't fetch").
 */
export async function fetchGithubKeys(login, fetchImpl = fetch) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 300 * attempt));
    try {
      const res = await fetchImpl(`https://github.com/${encodeURIComponent(login)}.keys`, {
        headers: { "User-Agent": "lifekey" },
      });
      if (res.status === 404) return [];
      if (!res.ok) continue;
      const text = await res.text();
      return text.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("ssh-ed25519"));
    } catch {
      // network blip — retry
    }
  }
  return [];
}

/** Verify a raw Ed25519 signature (base64) over a message with a raw 32-byte key. */
export async function verifyRaw(rawKey, message, sigB64) {
  const key = await crypto.subtle.importKey("raw", rawKey, { name: "Ed25519" }, false, ["verify"]);
  const sig = Uint8Array.from(atob(sigB64), (c) => c.charCodeAt(0));
  const msg = typeof message === "string" ? new TextEncoder().encode(message) : message;
  return crypto.subtle.verify({ name: "Ed25519" }, key, sig, msg);
}

/**
 * The full check: does ANY of `signatures` over `nonce` come from a key GitHub
 * publishes for `login`? Accepts a single signature string or an array (a
 * client may offer several keys — one match is enough). Returns
 * `{ ok, matchedKey? }`.
 */
export async function verifyGithubIdentity(login, nonce, signatures, fetchImpl = fetch) {
  const sigs = Array.isArray(signatures) ? signatures : [signatures];
  const keys = await fetchGithubKeys(login, fetchImpl);
  for (const line of keys) {
    const raw = rawFromOpenSsh(line);
    if (!raw) continue;
    for (const sig of sigs) {
      try {
        if (await verifyRaw(raw, nonce, sig)) return { ok: true, matchedKey: line };
      } catch {
        // wrong key/sig shape; try the next
      }
    }
  }
  return { ok: false };
}
