import { describe, it, expect, vi, afterEach } from "vitest";
import { generateKeyPairSync, sign as nodeSign } from "node:crypto";
import { handshakeMessage } from "../../.genome/registry/src/registry/lib/handshake";
import { CHECKS_READ_PERMS, COMMENT_WRITE_PERMS } from "../../.genome/registry/src/registry/lib/github-app";
import {
  handleExchangeCheckRuns,
  handleExchangePrComment,
} from "../../.genome/registry/src/registry/routes/git-broker";

// The CI-watch ops. A .life's CI watcher is a durable Worker workflow — it
// outlives the session that started it, so it cannot borrow that session's github
// MCP the way an interactive agent does. Its only previous option was a standing
// account-wide PAT sitting in a Worker, which is the credential the whole broker
// exists to retire.
//
// So these are OPS, not tokens: central mints internally, acts, returns the
// ANSWER. That is the entire justification for them requesting more than
// APP_PERMS while /exchange/repo-token stays pinned — so the tests that matter
// are (1) the credential never appears in a response, (2) each op requests only
// its own minimum, and (3) a signature cannot be replayed across subjects.

const owner = generateKeyPairSync("ed25519");
const sshString = (b: Buffer) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(b.length, 0);
  return Buffer.concat([len, b]);
};
const RAW = owner.publicKey.export({ type: "spki", format: "der" }).subarray(-32);
const OPENSSH =
  "ssh-ed25519 " +
  Buffer.concat([sshString(Buffer.from("ssh-ed25519")), sshString(Buffer.from(RAW))]).toString("base64");

const REPO = "o/r";
const SHA = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const sign = (action: string, subject: string, ts = Math.floor(Date.now() / 1000)) => ({
  sig: nodeSign(null, Buffer.from(handshakeMessage(action, REPO, subject, ts)), owner.privateKey).toString("base64"),
  ts,
});

const kp = generateKeyPairSync("rsa", { modulusLength: 2048 });
const APP_PEM = kp.privateKey.export({ type: "pkcs1", format: "pem" }) as string;
const makeKV = (seed: Record<string, string>) => {
  const m = new Map(Object.entries(seed));
  return {
    get: async (k: string) => (m.has(k) ? m.get(k)! : null),
    put: async (k: string, v: string) => void m.set(k, v),
    delete: async (k: string) => void m.delete(k),
  } as any;
};
const env = () =>
  ({
    KNOWN_KV: makeKV({
      "ghapp:id": "424242",
      "ghapp:pem": APP_PEM,
      "ghapp:slug": "known-life-verifier",
      [`lifekey:pub:${REPO}`]: OPENSSH,
    }),
    PUBLIC_URL: "https://known.life",
  }) as any;

function gh({ mintStatus = 200, checkRuns = [] as any[], totalCount = undefined as number | undefined } = {}) {
  const seen: { mint?: any; calls: string[] } = { calls: [] };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: any, init: any = {}) => {
      const u = String(url);
      seen.calls.push(u);
      if (/\/repos\/[^?]+\/installation$/.test(u)) return new Response(JSON.stringify({ id: 99 }), { status: 200 });
      if (/access_tokens$/.test(u) && init.method === "POST") {
        seen.mint = JSON.parse(init.body);
        if (mintStatus !== 200) return new Response("refused", { status: mintStatus });
        return new Response(JSON.stringify({ token: "op-tok" }), { status: 200 });
      }
      if (/\/check-runs\?/.test(u)) {
        expect((init.headers?.Authorization ?? "").replace(/^Bearer\s+/, "")).toBe("op-tok");
        return new Response(JSON.stringify({ total_count: totalCount ?? checkRuns.length, check_runs: checkRuns }), { status: 200 });
      }
      if (/\/issues\/\d+\/comments$/.test(u) && init.method === "POST") {
        expect((init.headers?.Authorization ?? "").replace(/^Bearer\s+/, "")).toBe("op-tok");
        return new Response(JSON.stringify({ id: 7, html_url: "https://github.com/o/r/pull/1#c7" }), { status: 201 });
      }
      throw new Error(`unexpected fetch: ${u}`);
    }),
  );
  return seen;
}

const post = (path: string, body: unknown) =>
  new Request(`https://known.life${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": "5.5.5.5" },
    body: JSON.stringify(body),
  });

afterEach(() => vi.restoreAllMocks());

describe("/exchange/check-runs", () => {
  it("returns the verdict and NEVER the credential", async () => {
    const seen = gh({ checkRuns: [{ name: "guard", status: "completed", conclusion: "success" }] });
    const r = await handleExchangeCheckRuns(post("/exchange/check-runs", { repo: REPO, sha: SHA, ...sign("check-runs", SHA) }), env());
    const raw = await r.text();
    expect(r.status).toBe(200);
    // The whole point of an op: the token stayed inside.
    expect(raw).not.toContain("op-tok");
    const b = JSON.parse(raw);
    expect(b.ok).toBe(true);
    expect(b.runs).toEqual([{ name: "guard", status: "completed", conclusion: "success" }]);
    expect(b.pending).toBe(0);
    // Requests only what a read needs — no contents, no write anywhere.
    expect(seen.mint.permissions).toEqual(CHECKS_READ_PERMS);
  });

  it("reports pending and truncation rather than implying a clean verdict", async () => {
    // A caller computing "all green" over a silently truncated list computes a lie.
    const runs = Array.from({ length: 100 }, (_, i) => ({ name: `c${i}`, status: i < 98 ? "completed" : "in_progress", conclusion: i < 98 ? "success" : null }));
    gh({ checkRuns: runs, totalCount: 137 });
    const b = (await (await handleExchangeCheckRuns(post("/exchange/check-runs", { repo: REPO, sha: SHA, ...sign("check-runs", SHA) }), env())).json()) as any;
    expect(b.pending).toBe(2);
    expect(b.truncated).toBe(true);
  });

  it("a signature for one sha does not authorize another", async () => {
    const seen = gh();
    const other = "c0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ff";
    const r = await handleExchangeCheckRuns(post("/exchange/check-runs", { repo: REPO, sha: other, ...sign("check-runs", SHA) }), env());
    expect(r.status).toBe(401);
    expect(seen.mint).toBeUndefined();
  });

  it("a malformed sha is refused before any GitHub call", async () => {
    const seen = gh();
    for (const sha of ["zzz", "", "abc", undefined]) {
      const r = await handleExchangeCheckRuns(post("/exchange/check-runs", { repo: REPO, sha, ...sign("check-runs", String(sha)) }), env());
      expect(r.status).toBe(400);
    }
    expect(seen.calls.length).toBe(0);
  });

  it("an ungranted permission says so, and names the fix", async () => {
    // The expected state until the App owner accepts the widened grant. It must
    // read as two clicks pending, never as a bug or a missing App.
    gh({ mintStatus: 422 });
    const b = (await (await handleExchangeCheckRuns(post("/exchange/check-runs", { repo: REPO, sha: SHA, ...sign("check-runs", SHA) }), env())).json()) as any;
    expect(b.ok).toBe(false);
    expect(b.reason).toBe("perms_not_granted");
    expect(b.need).toEqual(CHECKS_READ_PERMS);
    expect(b.hint).toMatch(/accepts the update/);
  });
});

describe("/exchange/pr-comment", () => {
  it("posts the comment and returns its URL, not the credential", async () => {
    const seen = gh();
    const r = await handleExchangePrComment(post("/exchange/pr-comment", { repo: REPO, pr: 1, body: "CI green.", ...sign("pr-comment", "1") }), env());
    const raw = await r.text();
    expect(r.status).toBe(200);
    expect(raw).not.toContain("op-tok");
    const b = JSON.parse(raw);
    expect(b.url).toBe("https://github.com/o/r/pull/1#c7");
    expect(seen.mint.permissions).toEqual(COMMENT_WRITE_PERMS);
    // pull_requests:write is REQUIRED, not incidental: POST /issues/{n}/comments
    // 403s on a pull request without it, which issues:write alone does not reveal
    // until the POST — the mint succeeds first (verified live 2026-07-30).
    expect(seen.mint.permissions.pull_requests).toBe("write");
    // But contents stays out: this op can comment, never commit.
    expect(seen.mint.permissions.contents).toBeUndefined();
  });

  it("a signature for one PR does not authorize commenting on another", async () => {
    const seen = gh();
    const r = await handleExchangePrComment(post("/exchange/pr-comment", { repo: REPO, pr: 999, body: "hi", ...sign("pr-comment", "1") }), env());
    expect(r.status).toBe(401);
    expect(seen.mint).toBeUndefined();
  });

  it("refuses an empty body and a runaway one", async () => {
    const seen = gh();
    expect((await handleExchangePrComment(post("/exchange/pr-comment", { repo: REPO, pr: 1, body: "   ", ...sign("pr-comment", "1") }), env())).status).toBe(400);
    // A comment is public and permanent; a watcher must not be able to paste a
    // whole build log into someone's PR.
    expect((await handleExchangePrComment(post("/exchange/pr-comment", { repo: REPO, pr: 1, body: "x".repeat(60_001), ...sign("pr-comment", "1") }), env())).status).toBe(413);
    expect(seen.calls.length).toBe(0);
  });

  it("a check-runs signature cannot be replayed as a comment", async () => {
    // Domain separation by action, which is why the handshake includes it.
    const seen = gh();
    const ts = Math.floor(Date.now() / 1000);
    const sig = nodeSign(null, Buffer.from(handshakeMessage("check-runs", REPO, "1", ts)), owner.privateKey).toString("base64");
    const r = await handleExchangePrComment(post("/exchange/pr-comment", { repo: REPO, pr: 1, body: "hi", sig, ts }), env());
    expect(r.status).toBe(401);
    expect(seen.mint).toBeUndefined();
  });
});
