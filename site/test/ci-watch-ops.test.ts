import { describe, it, expect, vi, afterEach } from "vitest";
import { generateKeyPairSync, sign as nodeSign } from "node:crypto";
import { handshakeMessage } from "../../.genome/registry/src/registry/lib/handshake";
import {
  APP_PERMS,
  CHECKS_READ_PERMS,
  COMMENT_WRITE_PERMS,
  MANIFEST_PERMS,
  PR_READ_PERMS,
} from "../../.genome/registry/src/registry/lib/github-app";
import {
  handleExchangeCheckRuns,
  handleExchangePr,
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

function gh({
  mintStatus = 200,
  checkRuns = [] as any[],
  totalCount = undefined as number | undefined,
  pr = { state: "open", draft: false, merged: false, mergeable: true, mergeable_state: "clean", head: { ref: "claude/x", sha: SHA }, base: { ref: "main" } } as any,
  prStatus = 200,
  filePages = [] as string[][],
} = {}) {
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
      if (/\/pulls\/\d+\/files\?/.test(u)) {
        expect((init.headers?.Authorization ?? "").replace(/^Bearer\s+/, "")).toBe("op-tok");
        const page = Number(new URL(u).searchParams.get("page"));
        const batch = filePages[page - 1] ?? [];
        return new Response(JSON.stringify(batch.map((filename) => ({ filename }))), { status: 200 });
      }
      if (/\/pulls\/\d+$/.test(u)) {
        expect((init.headers?.Authorization ?? "").replace(/^Bearer\s+/, "")).toBe("op-tok");
        if (prStatus !== 200) return new Response("nope", { status: prStatus });
        return new Response(JSON.stringify(pr), { status: 200 });
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

  it("takes a BRANCH or tag, not only a sha", async () => {
    // GitHub's check-runs endpoint accepts any ref, and both callers use that: a
    // watcher pins the head it watched, an agent asks about `main`. A hex-only rule
    // here was stricter than the API being wrapped and rejected `ref=main` outright —
    // found by calling the live probe, not by reading the code.
    for (const ref of ["main", "release/2.1", "v1.0.0", "feature_x", SHA, SHA.slice(0, 7)]) {
      const seen = gh({ checkRuns: [{ name: "g", status: "completed", conclusion: "success" }] });
      const r = await handleExchangeCheckRuns(post("/exchange/check-runs", { repo: REPO, sha: ref, ...sign("check-runs", ref) }), env());
      expect(r.status, `ref ${ref} was refused`).toBe(200);
      expect(seen.calls.some((u) => u.includes(encodeURIComponent(ref)))).toBe(true);
      vi.restoreAllMocks();
    }
  });

  it("a ref that could escape the URL path is refused before any GitHub call", async () => {
    // The ref lands in a path segment, so the charset is the guard. Refusing here
    // rather than leaning on encodeURIComponent means a malformed ref costs no token
    // mint and no GitHub call — the mint is the expensive, credential-touching half.
    const seen = gh();
    for (const ref of ["", "../../etc", "a..b", "-flag", "has space", "star*", "q?x", "a".repeat(201), undefined]) {
      const r = await handleExchangeCheckRuns(post("/exchange/check-runs", { repo: REPO, sha: ref, ...sign("check-runs", String(ref)) }), env());
      expect(r.status, `ref ${JSON.stringify(ref)} was ACCEPTED`).toBe(400);
    }
    expect(seen.calls.length).toBe(0);
  });

  it("a vanished ref is a named ANSWER, not a 502", async () => {
    // A force-push or a deleted branch removes the commit. Reported as a 502 it looks
    // like a broken op, so a polling watcher retries to its budget and then says
    // "timeout" — a report about waiting, for a head that was never coming back.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any, init: any = {}) => {
        const u = String(url);
        if (/\/repos\/[^?]+\/installation$/.test(u)) return new Response(JSON.stringify({ id: 99 }), { status: 200 });
        if (/access_tokens$/.test(u) && init.method === "POST") return new Response(JSON.stringify({ token: "op-tok" }), { status: 200 });
        if (/\/check-runs\?/.test(u)) return new Response("Not Found", { status: 404 });
        throw new Error(`unexpected fetch: ${u}`);
      }),
    );
    const r = await handleExchangeCheckRuns(post("/exchange/check-runs", { repo: REPO, sha: SHA, ...sign("check-runs", SHA) }), env());
    expect(r.status).toBe(200);
    const b = (await r.json()) as any;
    expect(b.ok).toBe(false);
    expect(b.reason).toBe("ref_not_found");
    expect(b.runs).toBeUndefined();
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

  it("a pr-read signature cannot be replayed as a comment", async () => {
    // pr and pr-comment differ only in whether the caller can WRITE, and both are
    // signed over the same (repo, pr) subject — so action separation is the only
    // thing standing between a read delegation and a public comment.
    const seen = gh();
    const ts = Math.floor(Date.now() / 1000);
    const sig = nodeSign(null, Buffer.from(handshakeMessage("pr", REPO, "1", ts)), owner.privateKey).toString("base64");
    const r = await handleExchangePrComment(post("/exchange/pr-comment", { repo: REPO, pr: 1, body: "hi", sig, ts }), env());
    expect(r.status).toBe(401);
    expect(seen.mint).toBeUndefined();
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

describe("/exchange/pr", () => {
  const signPr = (subject: string) => sign("pr", subject);

  it("reads the PR's facts with pull_requests:READ and no write anywhere", async () => {
    const seen = gh();
    const r = await handleExchangePr(post("/exchange/pr", { repo: REPO, pr: 1, ...signPr("1") }), env());
    const raw = await r.text();
    expect(r.status).toBe(200);
    expect(raw).not.toContain("op-tok");
    const b = JSON.parse(raw);
    expect(b.ok).toBe(true);
    expect(b.head_ref).toBe("claude/x");
    expect(b.head_sha).toBe(SHA);
    expect(b.base_ref).toBe("main");
    expect(b.merged).toBe(false);
    expect(seen.mint.permissions).toEqual(PR_READ_PERMS);
    // This op reads. The merge lives behind /exchange/merge-pr, sha-pinned.
    expect(seen.mint.permissions.pull_requests).toBe("read");
    expect(seen.mint.permissions.contents).toBeUndefined();
    expect(seen.mint.permissions.issues).toBeUndefined();
  });

  it("does not fetch files unless asked", async () => {
    // The default caller (an agent asking 'is this mergeable?') pays for one GitHub
    // call, not four.
    const seen = gh({ filePages: [["a.md"]] });
    const b = (await (await handleExchangePr(post("/exchange/pr", { repo: REPO, pr: 1, ...signPr("1") }), env())).json()) as any;
    expect(b.files).toBeUndefined();
    expect(seen.calls.some((u) => u.includes("/files"))).toBe(false);
  });

  it("pages the changed files and reports the list complete", async () => {
    gh({ filePages: [Array.from({ length: 100 }, (_, i) => `a${i}.md`), ["tail.md"]] });
    const b = (await (await handleExchangePr(post("/exchange/pr", { repo: REPO, pr: 1, files: true, ...signPr("1") }), env())).json()) as any;
    expect(b.files.length).toBe(101);
    expect(b.files[100]).toBe("tail.md");
    expect(b.files_truncated).toBe(false);
  });

  it("says TRUNCATED rather than hand back a short list that reads complete", async () => {
    // The whole reason this flag exists: an automerge policy asking 'is every changed
    // file inside a reversible class?' over a silently-cut list answers yes about
    // files it never saw, and merges substrate. It must fail closed, so it must know.
    gh({ filePages: [0, 1, 2].map((p) => Array.from({ length: 100 }, (_, i) => `p${p}-${i}.md`)) });
    const b = (await (await handleExchangePr(post("/exchange/pr", { repo: REPO, pr: 1, files: true, ...signPr("1") }), env())).json()) as any;
    expect(b.files.length).toBe(300);
    expect(b.files_truncated).toBe(true);
  });

  it("passes a still-computing mergeable through as null, never as false", async () => {
    // GitHub returns null while it computes the merge; coercing that to false would
    // read as 'conflicted' and a caller would report a blocked PR that is fine.
    gh({ pr: { state: "open", mergeable: null, mergeable_state: "unknown", head: { ref: "claude/x", sha: SHA }, base: { ref: "main" } } });
    const b = (await (await handleExchangePr(post("/exchange/pr", { repo: REPO, pr: 1, ...signPr("1") }), env())).json()) as any;
    expect(b.mergeable).toBeNull();
    expect(b.mergeable_state).toBe("unknown");
  });

  it("a missing PR is not_found, not a 502", async () => {
    gh({ prStatus: 404 });
    const r = await handleExchangePr(post("/exchange/pr", { repo: REPO, pr: 4242, ...signPr("4242") }), env());
    expect(r.status).toBe(200);
    const b = (await r.json()) as any;
    expect(b.ok).toBe(false);
    expect(b.reason).toBe("not_found");
  });

  it("a signature for one PR does not read another", async () => {
    const seen = gh();
    const r = await handleExchangePr(post("/exchange/pr", { repo: REPO, pr: 999, ...signPr("1") }), env());
    expect(r.status).toBe(401);
    expect(seen.mint).toBeUndefined();
  });

  it("a malformed pr number is refused before any GitHub call", async () => {
    const seen = gh();
    for (const pr of [0, -1, 1.5, "1", undefined]) {
      const r = await handleExchangePr(post("/exchange/pr", { repo: REPO, pr, ...signPr(String(pr)) }), env());
      expect(r.status).toBe(400);
    }
    expect(seen.calls.length).toBe(0);
  });
});

describe("MANIFEST_PERMS — the grant a FRESH App registration declares", () => {
  it("covers every op's grant, so a new .life's ops don't 422 forever", async () => {
    // This is the failure a hand-maintained union produces: an op ships, its perms
    // constant is added, and the manifest is not — so every EXISTING installation
    // works (its owner widened the App by hand) and every NEW registration 422s on
    // that op, permanently, with nothing in the diff pointing at why.
    for (const set of [APP_PERMS, PR_READ_PERMS, CHECKS_READ_PERMS, COMMENT_WRITE_PERMS]) {
      for (const [k, v] of Object.entries(set)) {
        expect(MANIFEST_PERMS[k], `manifest is missing ${k}`).toBeDefined();
        // Not merely present — present at AT LEAST the privilege the op requests.
        const rank: Record<string, number> = { read: 1, write: 2, admin: 3 };
        expect(rank[MANIFEST_PERMS[k]], `manifest has ${k}:${MANIFEST_PERMS[k]}, op needs ${v}`).toBeGreaterThanOrEqual(rank[v]);
      }
    }
  });

  it("a read set never DOWNGRADES a write one", async () => {
    // pull_requests appears as read (PR_READ_PERMS) and write (COMMENT_WRITE_PERMS).
    // A plain ordered spread would have let declaration order decide, and the
    // resulting manifest would silently break commenting on a fresh App.
    expect(PR_READ_PERMS.pull_requests).toBe("read");
    expect(COMMENT_WRITE_PERMS.pull_requests).toBe("write");
    expect(MANIFEST_PERMS.pull_requests).toBe("write");
    expect(MANIFEST_PERMS.contents).toBe("write");
  });
});
