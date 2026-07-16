import { describe, it, expect } from "vitest";
import { scanFiles } from "../../.genome/registry/src/registry/lib/scan";

// scanFiles is the BLOCKING leak gate for a PUBLIC commons: every gene published
// to known.life passes through it first. A regression is one of two disasters —
// a real credential gets served to the world (missed block), or a false positive
// bricks legitimate publishes (over-block). The contract: high-precision
// credential/PII shapes block; common-in-docs shapes (email/phone) only warn;
// the redacted excerpt never reveals the secret. We assert that contract
// directly. Secrets are assembled at runtime so no full token literal lives in
// this source (it would be a finding itself).

const A = (n: number) => "A".repeat(n);
const N = (n: number) => "1".repeat(n);
const file = (content: string) => scanFiles({ "gene.ts": content });

// One representative value per BLOCKING rule. Concatenated so the committed test
// file contains no contiguous secret literal.
const BLOCKING: Record<string, string> = {
  "aws-access-key-id": "AKIA" + "IOSFODNN7EXAMPLE",
  "github-pat": "ghp_" + A(36),
  "github-fine-grained-pat": "github_pat_" + A(60),
  "gitlab-pat": "glpat-" + A(20),
  "stripe-secret-key": "sk_live_" + A(24),
  "stripe-restricted-key": "rk_test_" + A(24),
  "openai-key": "sk-" + A(20) + "T3BlbkFJ" + A(20),
  "anthropic-key": "sk-ant-" + A(24),
  "google-api-key": "AIza" + A(35),
  "slack-token": "xoxb-" + N(10) + A(4),
  "jwt": "eyJ" + A(12) + "." + A(12) + "." + A(12),
  "credit-card": "4111" + N(12), // Visa shape, 16 digits
  "us-ssn": "123-45-6789",
};

describe("blocking rules — every high-confidence shape is rejected", () => {
  it.each(Object.entries(BLOCKING))("blocks %s and sets ok=false", (rule, secret) => {
    const r = file(`const leaked = "${secret}";`);
    expect(r.ok).toBe(false);
    expect(r.blocking.map((f) => f.rule)).toContain(rule);
  });

  it("blocks a bare PEM private-key header on its own line", () => {
    const r = file("-----BEGIN OPENSSH PRIVATE KEY-----");
    expect(r.ok).toBe(false);
    expect(r.blocking.map((f) => f.rule)).toContain("private-key-block");
  });

  it("aggregates multiple distinct leaks in one file", () => {
    const r = file(`a = "${BLOCKING["github-pat"]}"\nb = "${BLOCKING["aws-access-key-id"]}"`);
    expect(r.ok).toBe(false);
    expect(r.blocking.length).toBe(2);
  });
});

describe("precision guards — legitimate content must NOT be over-blocked", () => {
  it("does not block code that merely MENTIONS the PEM marker (key-parsing genes)", () => {
    // The exact false-positive the rule comment calls out: a regex parsing SSH
    // keys. After the marker comes `(`, not eol/quote/base64 — must not fire, or
    // lifekey/core become unpublishable.
    const r = file("const m = pem.match(/-----BEGIN OPENSSH PRIVATE KEY-----([\\s\\S]*?)-----END/);");
    expect(r.blocking.map((f) => f.rule)).not.toContain("private-key-block");
  });

  it.each([
    ["area 000", "000-12-3456"],
    ["area 666", "666-12-3456"],
    ["area 9xx", "912-34-5678"],
    ["group 00", "123-00-4567"],
    ["serial 0000", "123-45-0000"],
  ])("does not treat a reserved/invalid SSN (%s) as a blocking secret", (_l, ssn) => {
    expect(file(`id: ${ssn}`).blocking.map((f) => f.rule)).not.toContain("us-ssn");
  });

  it("treats an email address as advisory (warn), never blocking", () => {
    const r = file("Contact: alice@example.com for support.");
    expect(r.ok).toBe(true);
    expect(r.warnings.map((f) => f.rule)).toContain("email-address");
    expect(r.blocking).toEqual([]);
  });

  it("passes a clean file with no findings at all", () => {
    const r = file("# A normal gene\n\nThis gene does a thing. No secrets here.\n");
    expect(r.ok).toBe(true);
    expect(r.blocking).toEqual([]);
    expect(r.warnings).toEqual([]);
  });
});

describe("redaction — the excerpt never reveals the secret", () => {
  it("reveals at most a 4-char prefix + 2-char suffix; the middle never leaks", () => {
    // Distinctive body: a long unique run so ANY over-reveal of the middle is
    // visible. redact() shows first4 + "…" + last2 for matches >8 chars, so the
    // exact revealed shape is asserted — a regression that widened the window
    // (e.g. first20…last10) would surface the body run and fail here, where a
    // bare `not.toContain(secret)` would not (the spliced "…" alone satisfies it).
    const body = "Qm" + "x".repeat(32) + "Zk"; // 36 chars, all [A-Za-z0-9]
    const secret = "ghp_" + body; // the full 40-char github-pat match
    const r = file(`token = "${secret}"`);
    const finding = r.blocking.find((f) => f.rule === "github-pat")!;
    expect(finding.excerpt).toContain("ghp_…Zk"); // exactly first4 + … + last2
    expect(finding.excerpt).not.toContain("xxxxx"); // the hidden middle never survives
    expect(finding.excerpt).not.toContain(secret); // and never the whole secret
  });

  it("fully masks a short match (no characters revealed)", () => {
    // A short advisory match (≤8 chars, e.g. a tiny email) is masked entirely.
    const r = file("ping x@y.io anytime");
    const finding = r.warnings.find((f) => f.rule === "email-address")!;
    expect(finding.excerpt).not.toContain("x@y.io");
    expect(finding.excerpt).toContain("******");
  });
});

describe("structural behaviour", () => {
  it("skips binary-ish / lockfile paths entirely", () => {
    const secret = "ghp_" + A(36);
    expect(scanFiles({ "yarn.lock": `dep ${secret}` }).ok).toBe(true);
    expect(scanFiles({ "logo.png": secret }).ok).toBe(true);
  });

  it("skips minified blobs (lines over 4000 chars)", () => {
    const secret = "ghp_" + A(36);
    const longLine = "x".repeat(4001) + secret;
    expect(scanFiles({ "bundle.js": longLine }).ok).toBe(true);
  });

  it("reports a 1-based line number", () => {
    const secret = "AKIA" + "IOSFODNN7EXAMPLE";
    const r = file(`line one\nline two\nkey = "${secret}"`);
    expect(r.blocking[0].line).toBe(3);
  });

  it("flags a high-entropy assignment as an advisory warning", () => {
    // 40 random-looking chars, no secret keyword → only the entropy backstop fires.
    const r = file('value: "aZ3kP9qLmX7vB2nR8wT4yU6iO1pcD5sE0fG2hJ4kQ"');
    expect(r.ok).toBe(true);
    expect(r.warnings.map((f) => f.rule)).toContain("high-entropy-string");
  });
});
