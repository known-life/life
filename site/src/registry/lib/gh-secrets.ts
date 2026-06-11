import nacl from "tweetnacl";
import { blake2b } from "blakejs";

/**
 * GitHub Actions repo-secret seeding — the CI half of the setup flow's
 * "one pasted token, two destinations". The Cloudflare credentials the user
 * hands /setup go to the vault for sessions AND, via this module, into the
 * repo's Actions secrets so the generated deploy.yml (the ci-deploy
 * convention) can deploy from the very first push — no hand-set secrets.
 *
 * GitHub's contract (REST 2022-11-28): fetch the repo's public key, encrypt
 * each value as a libsodium *sealed box* against it, PUT base64(sealed) +
 * key_id. OAuth tokens need the `repo` scope — exactly what the /setup OAuth
 * flow already requests.
 */

const GH_API = "https://api.github.com";

/**
 * libsodium crypto_box_seal, composed from tweetnacl + blake2b (Workers have
 * no libsodium): ephemeral keypair → nonce = blake2b24(epk ‖ recipient_pk) →
 * sealed = epk ‖ box(msg, nonce, recipient_pk, esk). Returns base64.
 */
export function sealForGitHub(value: string, recipientPublicKeyB64: string): string {
  const recipientPk = fromB64(recipientPublicKeyB64);
  if (recipientPk.length !== nacl.box.publicKeyLength) {
    throw new Error(`bad public key length ${recipientPk.length}`);
  }
  const eph = nacl.box.keyPair();
  const nonce = sealNonce(eph.publicKey, recipientPk);
  const boxed = nacl.box(new TextEncoder().encode(value), nonce, recipientPk, eph.secretKey);
  const sealed = new Uint8Array(eph.publicKey.length + boxed.length);
  sealed.set(eph.publicKey, 0);
  sealed.set(boxed, eph.publicKey.length);
  return toB64(sealed);
}

// Exported for the test's open-side of the roundtrip.
export function sealNonce(ephemeralPk: Uint8Array, recipientPk: Uint8Array): Uint8Array {
  const input = new Uint8Array(ephemeralPk.length + recipientPk.length);
  input.set(ephemeralPk, 0);
  input.set(recipientPk, ephemeralPk.length);
  return blake2b(input, undefined, nacl.box.nonceLength);
}

export interface SeedResult {
  ok: boolean;
  error?: string;
}

/**
 * Seed `secrets` as Actions repo secrets on `repoSlug` using the user's own
 * OAuth token. Returns a non-throwing result: callers treat failure as
 * surfaceable-but-non-fatal (the vault path is unaffected; CI deploys are
 * what would break, and the error string says why).
 */
export async function seedActionsSecrets(
  ghToken: string,
  repoSlug: string,
  secrets: Record<string, string>,
): Promise<SeedResult> {
  const headers = {
    Authorization: `Bearer ${ghToken}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "known.life-setup",
  };
  const pkRes = await fetch(`${GH_API}/repos/${repoSlug}/actions/secrets/public-key`, { headers });
  if (!pkRes.ok) return { ok: false, error: `public_key_fetch_failed_${pkRes.status}` };
  const pk = await pkRes.json().catch(() => null) as { key_id?: string; key?: string } | null;
  if (!pk?.key_id || !pk?.key) return { ok: false, error: "public_key_malformed" };

  for (const [name, value] of Object.entries(secrets)) {
    const res = await fetch(`${GH_API}/repos/${repoSlug}/actions/secrets/${name}`, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ encrypted_value: sealForGitHub(value, pk.key), key_id: pk.key_id }),
    });
    // 201 = created, 204 = updated.
    if (res.status !== 201 && res.status !== 204) {
      return { ok: false, error: `put_${name}_failed_${res.status}` };
    }
  }
  return { ok: true };
}

function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toB64(b: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
  return btoa(bin);
}
