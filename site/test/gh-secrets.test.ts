import { describe, it, expect, vi, afterEach } from "vitest";
import nacl from "tweetnacl";
import { sealForGitHub, sealNonce, seedActionsSecrets } from "../src/registry/lib/gh-secrets";

// gh-secrets is the CI-secret bootstrap: /setup seals the user's Cloudflare
// credentials as GitHub Actions repo secrets so the generated deploy.yml works
// from the first push. Two failure modes matter: a seal GitHub can't open
// (secret silently garbage → every CI deploy fails with a "valid" secret), and
// a wrong API contract (wrong endpoint/body → nothing seeded). The roundtrip
// test proves the sealed-box construction against the libsodium spec by
// opening it with the recipient key; the contract tests pin the REST shape.

const td = new TextDecoder();
const toB64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

// crypto_box_seal_open: split epk ‖ box, re-derive the blake2b24 nonce,
// open with the recipient's secret key. If this opens, GitHub's libsodium can
// open the same bytes.
function sealOpen(sealedB64: string, recipient: nacl.BoxKeyPair): string | null {
  const sealed = fromB64(sealedB64);
  const epk = sealed.slice(0, nacl.box.publicKeyLength);
  const boxed = sealed.slice(nacl.box.publicKeyLength);
  const nonce = sealNonce(epk, recipient.publicKey);
  const opened = nacl.box.open(boxed, nonce, epk, recipient.secretKey);
  return opened ? td.decode(opened) : null;
}

describe("sealForGitHub — libsodium sealed box", () => {
  it("roundtrips: the recipient can open what we seal", () => {
    const recipient = nacl.box.keyPair();
    const sealed = sealForGitHub("cf-token-123", toB64(recipient.publicKey));
    expect(sealOpen(sealed, recipient)).toBe("cf-token-123");
  });

  it("a different recipient cannot open it", () => {
    const recipient = nacl.box.keyPair();
    const stranger = nacl.box.keyPair();
    const sealed = sealForGitHub("cf-token-123", toB64(recipient.publicKey));
    expect(sealOpen(sealed, stranger)).toBeNull();
  });

  it("is randomized per seal (fresh ephemeral key each time)", () => {
    const recipient = nacl.box.keyPair();
    const pk = toB64(recipient.publicKey);
    expect(sealForGitHub("same", pk)).not.toBe(sealForGitHub("same", pk));
  });

  it("rejects a malformed public key", () => {
    expect(() => sealForGitHub("v", toB64(new Uint8Array(16)))).toThrow(/public key/);
  });
});

describe("seedActionsSecrets — GitHub REST contract", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubGitHub(recipient: nacl.BoxKeyPair, putStatus = 201) {
    const puts: Array<{ url: string; body: { encrypted_value: string; key_id: string } }> = [];
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/actions/secrets/public-key")) {
        return new Response(JSON.stringify({ key_id: "kid-1", key: toB64(recipient.publicKey) }), { status: 200 });
      }
      if (init?.method === "PUT") {
        puts.push({ url: u, body: JSON.parse(String(init.body)) });
        return new Response(null, { status: putStatus });
      }
      return new Response("unexpected", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);
    return { puts, fetchMock };
  }

  it("PUTs each secret sealed against the repo key, with key_id", async () => {
    const recipient = nacl.box.keyPair();
    const { puts, fetchMock } = stubGitHub(recipient);
    const r = await seedActionsSecrets("gh-tok", "alice/my-life", {
      CLOUDFLARE_API_TOKEN: "cf-tok",
      CLOUDFLARE_ACCOUNT_ID: "acc-id",
    });
    expect(r.ok).toBe(true);
    expect(puts.map((p) => p.url)).toEqual([
      "https://api.github.com/repos/alice/my-life/actions/secrets/CLOUDFLARE_API_TOKEN",
      "https://api.github.com/repos/alice/my-life/actions/secrets/CLOUDFLARE_ACCOUNT_ID",
    ]);
    for (const p of puts) expect(p.body.key_id).toBe("kid-1");
    expect(sealOpen(puts[0].body.encrypted_value, recipient)).toBe("cf-tok");
    expect(sealOpen(puts[1].body.encrypted_value, recipient)).toBe("acc-id");
    // Auth rides the user's own OAuth token.
    const pkCall = fetchMock.mock.calls[0][1] as RequestInit;
    expect((pkCall.headers as Record<string, string>).Authorization).toBe("Bearer gh-tok");
  });

  it("accepts 204 (secret updated) as success", async () => {
    const recipient = nacl.box.keyPair();
    stubGitHub(recipient, 204);
    const r = await seedActionsSecrets("t", "a/b", { X: "1" });
    expect(r.ok).toBe(true);
  });

  it("reports a public-key fetch failure without throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 403 })));
    const r = await seedActionsSecrets("t", "a/b", { X: "1" });
    expect(r).toEqual({ ok: false, error: "public_key_fetch_failed_403" });
  });

  it("reports a non-JSON public-key response as malformed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not-json", { status: 200 })));
    const r = await seedActionsSecrets("t", "a/b", { X: "1" });
    expect(r).toEqual({ ok: false, error: "public_key_malformed" });
  });

  it("reports a failed PUT by secret name", async () => {
    const recipient = nacl.box.keyPair();
    stubGitHub(recipient, 403);
    const r = await seedActionsSecrets("t", "a/b", { CLOUDFLARE_API_TOKEN: "v" });
    expect(r).toEqual({ ok: false, error: "put_CLOUDFLARE_API_TOKEN_failed_403" });
  });
});
