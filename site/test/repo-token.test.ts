import { describe, it, expect, vi, afterEach } from "vitest";
import { generateKeyPairSync, sign as nodeSign } from "node:crypto";
import { handshakeMessage } from "../../.genome/registry/src/registry/lib/handshake";
import { APP_PERMS } from "../../.genome/registry/src/registry/lib/github-app";
import { handleExchangeRepoToken } from "../../.genome/registry/src/registry/routes/git-broker";

// /exchange/repo-token is the ONE door in the whole registry that hands a GitHub
// credential to a caller. Everything else (verify, delete-branch) acts server-side
// and never releases one. Until 2026-07-29 it had no test at all.
//
// The property under test is NARROWNESS, and it is about to come under pressure:
// the App's own grant has to grow — justin-inference's CI watcher needs
// checks/pull_requests/issues that APP_PERMS deliberately withholds — and
// `installationToken` happily accepts a `perms` argument. On the day the App
// widens, ANY path that forwards caller input into that argument turns this door
// into a wide-credential dispenser for every .life at once, silently, with no
// error and no log line. So the mint here must be pinned, and pinned by a test
// rather than by everyone remembering.

const owner = generateKeyPairSync("ed25519");
const sshString = (b: Buffer) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(b.length, 0);
  return Buffer.concat([len, b]);
};
const RAW_PUB = owner.publicKey.export({ type: "spki", format: "der" }).subarray(-32);
const OWNER_OPENSSH =
  "ssh-ed25519 " +
  Buffer.concat([sshString(Buffer.from("ssh-ed25519")), sshString(Buffer.from(RAW_PUB))]).toString("base64");

const REPO = "o/r";
function sign(repo = REPO, ts = Math.floor(Date.now() / 1000)) {
  const msg = handshakeMessage("repo-token", repo, repo, ts);
  return { sig: nodeSign(null, Buffer.from(msg), owner.privateKey).toString("base64"), ts };
}

function makeKV(seed: Record<string, string>) {
  const m = new Map(Object.entries(seed));
  return {
    get: async (k: string) => (m.has(k) ? m.get(k)! : null),
    put: async (k: string, v: string) => void m.set(k, v),
    delete: async (k: string) => void m.delete(k),
  } as any;
}

const kp = generateKeyPairSync("rsa", { modulusLength: 2048 });
const APP_PEM = kp.privateKey.export({ type: "pkcs1", format: "pem" }) as string;

const env = () =>
  ({
    KNOWN_KV: makeKV({
      "ghapp:id": "424242",
      "ghapp:pem": APP_PEM,
      "ghapp:slug": "known-life-verifier",
      [`lifekey:pub:${REPO}`]: OWNER_OPENSSH,
    }),
    PUBLIC_URL: "https://known.life",
  }) as any;

// Captures the body POSTed to GitHub's access_tokens endpoint — the actual grant
// being requested, which is the thing worth asserting on.
function ghMock({ installed = true } = {}) {
  const seen: { mint?: any } = {};
  const fetchMock = vi.fn(async (url: any, init: any = {}) => {
    const u = String(url);
    if (/\/repos\/[^?]+\/installation$/.test(u)) {
      return installed
        ? new Response(JSON.stringify({ id: 99 }), { status: 200 })
        : new Response("Not Found", { status: 404 });
    }
    if (/\/app\/installations\/[^/]+\/access_tokens$/.test(u) && init.method === "POST") {
      seen.mint = init.body ? JSON.parse(init.body) : null;
      return new Response(JSON.stringify({ token: "inst-tok", expires_at: "2026-07-29T18:00:00Z" }), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${u}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { seen, fetchMock };
}

const POST = (body: unknown) =>
  new Request("https://known.life/exchange/repo-token", {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": "9.9.9.9" },
    body: JSON.stringify(body),
  });

afterEach(() => vi.restoreAllMocks());

describe("/exchange/repo-token — the one door that releases a credential", () => {
  it("mints exactly APP_PERMS, narrowed to the single repo", async () => {
    const { seen } = ghMock();
    const r = await handleExchangeRepoToken(POST({ repo: REPO, ...sign() }), env());
    const body = (await r.json()) as any;

    expect(r.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.token).toBe("inst-tok");
    // The grant actually requested of GitHub — not merely what we report back.
    expect(seen.mint.permissions).toEqual(APP_PERMS);
    expect(seen.mint.repositories).toEqual(["r"]);
    // And what we report matches what we asked for, so a caller reading
    // `permissions` is not being told a comfortable fiction.
    expect(body.permissions).toEqual(APP_PERMS);
  });

  it("IGNORES caller-supplied permissions — the pin", async () => {
    // The regression that matters. If this door ever forwards request input into
    // installationToken's perms argument, a caller could name its own grant, and
    // once the App widens for the CI watcher that becomes a wide credential
    // handed to anyone who can sign a handshake. Narrowness here is what bounds
    // the blast radius of a leaked consumer Worker.
    const { seen } = ghMock();
    const r = await handleExchangeRepoToken(
      POST({
        repo: REPO,
        ...sign(),
        permissions: { checks: "read", issues: "write", administration: "write" },
        perms: { administration: "write" },
      }),
      env(),
    );
    expect(r.status).toBe(200);
    expect(seen.mint.permissions).toEqual(APP_PERMS);
    expect(seen.mint.permissions.administration).toBeUndefined();
    expect(seen.mint.permissions.issues).toBeUndefined();
    expect(seen.mint.permissions.checks).toBeUndefined();
  });

  it("a token for one repo is never minted for another", async () => {
    // The signature is bound to (repo, repo, ts); a body naming a different
    // repository must not widen the mint beyond the one that was proven.
    const { seen } = ghMock();
    await handleExchangeRepoToken(
      POST({ repo: REPO, ...sign(), repositories: ["other", "r"] }),
      env(),
    );
    expect(seen.mint.repositories).toEqual(["r"]);
  });

  it("an unsigned request is refused, and GitHub is never touched", async () => {
    const { fetchMock } = ghMock();
    const r = await handleExchangeRepoToken(POST({ repo: REPO }), env());
    expect(r.status).toBe(401);
    expect((await r.json() as any).ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a signature from the wrong key is refused", async () => {
    const { fetchMock } = ghMock();
    const other = generateKeyPairSync("ed25519");
    const ts = Math.floor(Date.now() / 1000);
    const sig = nodeSign(null, Buffer.from(handshakeMessage("repo-token", REPO, REPO, ts)), other.privateKey).toString("base64");
    const r = await handleExchangeRepoToken(POST({ repo: REPO, sig, ts }), env());
    expect(r.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a signature for a DIFFERENT action does not authorize a token mint", async () => {
    // The handshake is domain-separated by action precisely so a signature
    // gathered for one delegation cannot be replayed as another.
    const { fetchMock } = ghMock();
    const ts = Math.floor(Date.now() / 1000);
    const sig = nodeSign(null, Buffer.from(handshakeMessage("delete-branch", REPO, REPO, ts)), owner.privateKey).toString("base64");
    const r = await handleExchangeRepoToken(POST({ repo: REPO, sig, ts }), env());
    expect(r.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a malformed repo is refused before any signature work", async () => {
    const { fetchMock } = ghMock();
    for (const repo of ["justin", "", "a/b/c", undefined]) {
      const r = await handleExchangeRepoToken(POST({ repo, ...sign() }), env());
      expect(r.status).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a REFUSED permission set is not reported as an unregistered App", async () => {
    // These two used to be the same bare null, and every route turned it into
    // "verifier app not registered" — telling an operator to re-register a
    // perfectly healthy App when the real fix was to accept a pending permission
    // update. That misreport is exactly the state a partial App widening
    // produces, so it has to name itself (law:lying-signal).
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any, init: any = {}) => {
        const u = String(url);
        if (/\/repos\/[^?]+\/installation$/.test(u)) return new Response(JSON.stringify({ id: 99 }), { status: 200 });
        if (/access_tokens$/.test(u) && init.method === "POST") return new Response("perms exceed grant", { status: 422 });
        throw new Error(`unexpected fetch: ${u}`);
      }),
    );
    const r = await handleExchangeRepoToken(POST({ repo: REPO, ...sign() }), env());
    const body = (await r.json()) as any;
    expect(body.ok).toBe(false);
    expect(body.error).not.toMatch(/not registered/);
    expect(body.hint).toMatch(/permission update/);
    expect(body.token).toBeUndefined();
  });

  it("not_installed answers 200 with ok:false — the caller must read the body", async () => {
    // This one is a trap for consumers: it is NOT an HTTP error, so anything
    // checking only res.ok treats it as a malformed success.
    ghMock({ installed: false });
    const r = await handleExchangeRepoToken(POST({ repo: REPO, ...sign() }), env());
    expect(r.status).toBe(200);
    const body = (await r.json()) as any;
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("not_installed");
    expect(body.token).toBeUndefined();
  });
});
