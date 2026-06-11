// Test helpers — build the openssh wire format from a raw Ed25519 public key and
// mint fresh keypairs/signatures in-runtime, so the lifekey suite never depends
// on a rotting fixture. Mirrors exactly what github.com/<login>.keys serves and
// what a lifekey signing client produces.

const enc = new TextEncoder();

export function b64(u8: Uint8Array): string {
  let s = "";
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s);
}

/** Pack a raw 32-byte Ed25519 public key into an `ssh-ed25519 <base64> <comment>` line. */
export function toOpenSshLine(rawPub: Uint8Array, comment = "test@known.life"): string {
  const tname = enc.encode("ssh-ed25519");
  const blob = new Uint8Array(4 + tname.length + 4 + 32);
  const dv = new DataView(blob.buffer);
  let off = 0;
  dv.setUint32(off, tname.length); off += 4;
  blob.set(tname, off); off += tname.length;
  dv.setUint32(off, 32); off += 4;
  blob.set(rawPub, off);
  return `ssh-ed25519 ${b64(blob)} ${comment}`;
}

export interface TestKey {
  opensshLine: string;
  rawPub: Uint8Array;
  sign(message: string): Promise<string>; // returns base64 signature
}

/** Generate a fresh Ed25519 keypair and expose its openssh line + a signer. */
export async function makeKey(comment?: string): Promise<TestKey> {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const rawPub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  return {
    opensshLine: toOpenSshLine(rawPub, comment),
    rawPub,
    async sign(message: string) {
      const sig = new Uint8Array(
        await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, enc.encode(message)),
      );
      return b64(sig);
    },
  };
}
