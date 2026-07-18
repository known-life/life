import { describe, it, expect } from "vitest";
import { rawFromOpenSsh, verifyRaw } from "../../.genome/registry/src/registry/lib/lifekey-verify";
import { makeKey, b64 } from "./helpers";
import vector from "./vectors/lifekey.json";

// lifekey-verify is the verification primitive under the trust store: parse an
// ssh-ed25519 line, verify an Ed25519 signature. A bug here either accepts
// forged signatures (anyone publishes as anyone) or rejects valid ones (locks
// everyone out). The .keys identity half (fetchGithubKeys/verifyGithubIdentity)
// was deleted in the secrets-4 sunset — WHICH keys to trust is the trust
// store's question (trust-store.test.ts).

describe("rawFromOpenSsh — public-key line parsing", () => {
  it("extracts the 32 raw bytes from a real ssh-ed25519 line", async () => {
    const k = await makeKey();
    const raw = rawFromOpenSsh(k.opensshLine);
    expect(raw).not.toBeNull();
    expect(raw!.length).toBe(32);
    expect(b64(raw!)).toBe(b64(k.rawPub));
  });

  it("tolerates leading/trailing whitespace", async () => {
    const k = await makeKey();
    expect(rawFromOpenSsh(`  \t${k.opensshLine}\n`)).not.toBeNull();
  });

  it.each([
    ["a non-ed25519 algorithm", "ssh-rsa AAAAB3NzaC1yc2E hello"],
    ["an empty line", ""],
    ["a comment-only line", "# just a comment"],
    ["garbage base64", "ssh-ed25519 !!!notbase64!!!"],
    ["a truncated blob (wrong key length)", "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAAA=="],
  ])("returns null (never throws) for %s", (_label, line) => {
    expect(() => rawFromOpenSsh(line)).not.toThrow();
    expect(rawFromOpenSsh(line)).toBeNull();
  });
});

describe("verifyRaw — Ed25519 signature verification", () => {
  it("accepts a genuine signature over the nonce", async () => {
    const k = await makeKey();
    const nonce = "nonce-" + crypto.randomUUID();
    const sig = await k.sign(nonce);
    expect(await verifyRaw(k.rawPub, nonce, sig)).toBe(true);
  });

  it("rejects a signature over a DIFFERENT message (tampered nonce)", async () => {
    const k = await makeKey();
    const sig = await k.sign("the-real-nonce");
    expect(await verifyRaw(k.rawPub, "a-different-nonce", sig)).toBe(false);
  });

  it("rejects a signature made by a DIFFERENT key (forgery)", async () => {
    const signer = await makeKey();
    const attacker = await makeKey();
    const nonce = "nonce";
    const sig = await signer.sign(nonce);
    // attacker presents the victim's nonce signed by their own key
    expect(await verifyRaw(attacker.rawPub, nonce, sig)).toBe(false);
  });

  it("rejects a bit-flipped signature", async () => {
    const k = await makeKey();
    const nonce = "nonce";
    const good = Uint8Array.from(atob(await k.sign(nonce)), (c) => c.charCodeAt(0));
    good[0] ^= 0x01;
    expect(await verifyRaw(k.rawPub, nonce, b64(good))).toBe(false);
  });
});

describe("known-answer vector (cross-copy parity anchor)", () => {
  // This same vector must verify identically against the lifekey gene's
  // lib/verify.mjs — the canonical source this worker copy is vendored from. If
  // the two implementations ever drift, one of them fails this fixed case.
  it("verifies the committed valid signature", async () => {
    const raw = rawFromOpenSsh(vector.openssh_pubkey);
    expect(raw).not.toBeNull();
    expect(await verifyRaw(raw!, vector.nonce, vector.signature_b64)).toBe(true);
  });

  it("rejects the committed tampered signature", async () => {
    const raw = rawFromOpenSsh(vector.openssh_pubkey)!;
    expect(await verifyRaw(raw, vector.nonce, vector.tampered_signature_b64)).toBe(false);
  });
});
