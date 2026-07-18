// The IdP's asymmetric identity (viewer-app-parity node 06): issueIdentityToken
// mints an EdDSA JWT (aud life-plane) a data plane can verify against the JWKS
// — and the JWKS NEVER leaks the private scalar. Unset key → feature off.
import { describe, it, expect } from "vitest";
import { generateKeyPair, exportPKCS8, jwtVerify, importJWK } from "jose";
import { issueIdentityToken, identityJwks } from "../../.genome/registry/src/registry/lib/jwt";
import type { Env } from "../../.genome/registry/src/registry/lib/types";

async function envWithKey(): Promise<Env> {
  const { privateKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
  return { IDENTITY_PRIVATE_KEY: await exportPKCS8(privateKey), PUBLIC_URL: "https://known.life" } as unknown as Env;
}

describe("IdP identity (EdDSA + /jwks)", () => {
  it("mints a token the served JWKS verifies, aud life-plane, sub intact", async () => {
    const env = await envWithKey();
    const token = await issueIdentityToken("github:DomVinyard", env);
    expect(token).toBeTruthy();
    const jwks = await identityJwks(env);
    expect(jwks.keys).toHaveLength(1);
    const key = await importJWK(jwks.keys[0] as Parameters<typeof importJWK>[0], "EdDSA");
    const { payload } = await jwtVerify(token!, key, { audience: "life-plane", issuer: "https://known.life" });
    expect(payload.sub).toBe("github:DomVinyard");
    expect((payload.exp! - payload.iat!) / 86400).toBe(30);
  });

  it("the JWKS never carries the private scalar", async () => {
    const jwks = await identityJwks(await envWithKey());
    expect(JSON.stringify(jwks)).not.toContain('"d"');
  });

  it("unset key: no token, empty JWKS — off, never forgeable", async () => {
    const env = { PUBLIC_URL: "https://known.life" } as unknown as Env;
    expect(await issueIdentityToken("github:x", env)).toBeNull();
    expect((await identityJwks(env)).keys).toHaveLength(0);
  });
});
