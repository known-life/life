import { describe, it, expect } from "vitest";
import { enrolmentPair, safeRawFromOpenSsh } from "../../.genome/registry/src/registry/lib/trust-store";
import type { Env } from "../../.genome/registry/src/registry/lib/types";

// node 56 — the enrolment record migration. enrolmentPair is the ONE reader every
// trust-store consumer goes through; these hold its record-first-with-legacy-fallback
// contract so a re-enrolment (record written, legacy pair cleared) never strands a
// consumer, and safeRawFromOpenSsh's guard (crafted pubkey → null, not a throw) holds.

const kv = (obj: Record<string, string>) =>
  ({ KNOWN_KV: { get: async (k: string) => (k in obj ? obj[k] : null) } } as unknown as Env);

describe("enrolmentPair — record-first with legacy fallback", () => {
  it("reads the atomic record", async () => {
    const env = kv({ "lifekey:rec:o/r": JSON.stringify({ pubkey: "ssh-ed25519 REC", login: "alice" }) });
    expect(await enrolmentPair(env, "o/r")).toEqual({ pubkey: "ssh-ed25519 REC", login: "alice" });
  });

  it("falls back to the legacy pair for a pre-record repo", async () => {
    const env = kv({ "lifekey:pub:o/r": "ssh-ed25519 LEG", "lifekey:login:o/r": "bob" });
    expect(await enrolmentPair(env, "o/r")).toEqual({ pubkey: "ssh-ed25519 LEG", login: "bob" });
  });

  it("prefers the record over stale legacy keys (re-enrolled repo)", async () => {
    const env = kv({
      "lifekey:pub:o/r": "ssh-ed25519 OLD",
      "lifekey:login:o/r": "bob",
      "lifekey:rec:o/r": JSON.stringify({ pubkey: "ssh-ed25519 NEW", login: "alice" }),
    });
    expect(await enrolmentPair(env, "o/r")).toEqual({ pubkey: "ssh-ed25519 NEW", login: "alice" });
  });

  it("returns nulls on a malformed record — never throws", async () => {
    const env = kv({ "lifekey:rec:o/r": "{not json" });
    expect(await enrolmentPair(env, "o/r")).toEqual({ pubkey: null, login: null });
  });

  it("returns nulls when nothing is enrolled", async () => {
    expect(await enrolmentPair(kv({}), "o/r")).toEqual({ pubkey: null, login: null });
  });
});

describe("safeRawFromOpenSsh — guards the crafted-pubkey 500", () => {
  it("null on a line that matches the prefix but has bad base64", () => {
    expect(safeRawFromOpenSsh("ssh-ed25519 =====")).toBeNull();
  });
  it("null on a too-short blob (DataView overrun)", () => {
    expect(safeRawFromOpenSsh("ssh-ed25519 AAA")).toBeNull();
  });
  it("null on a non-ed25519 line", () => {
    expect(safeRawFromOpenSsh("not a key")).toBeNull();
  });
});
