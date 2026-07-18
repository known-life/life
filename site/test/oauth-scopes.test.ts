import { describe, it, expect } from "vitest";
import { ALLOWED_SCOPES, isAllowedScope } from "../../.genome/registry/src/registry/routes/mcp-oauth";

// The scope allow-list is what stands between a random OAuth client and an
// escalated consent screen — and it's also where the ci-deploy convention's
// `workflow` requirement is enforced (without it the captured token can't
// push the generated deploy.yml; found live 2026-06-10). Pin both directions:
// the canonical setup sets (workflow-bearing) and the pre-workflow sets
// (pinned setup genes ≤2.20.0 stay usable) pass; escalations never do.

describe("isAllowedScope — what the bridge will put on a consent screen", () => {
  it.each([
    "read:user",
    "repo,workflow,read:user", // setup ≥2.36.0 — the .keys-free identity set
    "repo,workflow,admin:public_key,read:user",
    "repo,workflow,admin:public_key",
    "repo,admin:public_key,read:user",
    "repo,admin:public_key",
  ])("allows %s", (s) => expect(isAllowedScope(s)).toBe(true));

  it("is order- and whitespace-insensitive", () => {
    expect(isAllowedScope("workflow, repo ,read:user,admin:public_key")).toBe(true);
  });

  it.each([
    "admin:org",
    "delete_repo",
    "repo",                                          // repo alone is not a listed set
    "workflow",                                      // nor workflow alone
    "repo,workflow,admin:public_key,read:user,admin:org",  // smuggled escalation
    "repo,workflow",                                 // partial set
    "",
  ])("rejects %s", (s) => expect(isAllowedScope(s)).toBe(false));

  it("the canonical setup set carries workflow", () => {
    expect(ALLOWED_SCOPES[1].split(",")).toContain("workflow");
  });
});
