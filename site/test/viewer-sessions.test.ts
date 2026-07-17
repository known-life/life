import { describe, it, expect } from "vitest";
import { deriveSessions, groupSessions, humanizeBranch, agentOf } from "../../.genome/viewer/src/sessions";

const pr = (over: Partial<Parameters<typeof deriveSessions>[0][number]> = {}) => ({
  number: 1,
  title: "Add the thing",
  state: "open",
  merged_at: null,
  updated_at: "2026-07-16T10:00:00Z",
  html_url: "https://github.com/o/r/pull/1",
  head: { ref: "claude/add-the-thing-ab12cd" },
  user: { login: "DomVinyard", avatar_url: "https://a" },
  ...over,
});

describe("session derivation", () => {
  it("maps PR lifecycle to session state", () => {
    const rows = deriveSessions(
      [
        pr(),
        pr({ number: 2, state: "closed", merged_at: "2026-07-10T00:00:00Z", head: { ref: "claude/b-x1y2z" }, updated_at: "2026-07-10T00:00:00Z" }),
        pr({ number: 3, state: "closed", head: { ref: "claude/c-9k8j7" }, updated_at: "2026-07-01T00:00:00Z" }),
        pr({ number: 4, state: "open", draft: true, head: { ref: "feat/manual" }, updated_at: "2026-07-15T00:00:00Z" }),
      ],
      [],
      "main",
    );
    expect(rows.map((r) => r.state)).toEqual(["open", "draft", "merged", "closed"]);
    expect(rows[0].agent).toBe("claude");
    expect(rows[1].agent).toBeNull(); // feat/manual — not an agent branch
  });

  it("keeps only the newest PR per branch and adds PR-less branches", () => {
    const rows = deriveSessions(
      [pr({ number: 5, updated_at: "2026-07-16T10:00:00Z" }), pr({ number: 4, updated_at: "2026-07-01T00:00:00Z" })],
      [{ name: "main" }, { name: "claude/add-the-thing-ab12cd" }, { name: "codex/orphan", date: "2026-07-14T00:00:00Z" }],
      "main",
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].prNumber).toBe(5);
    const orphan = rows.find((r) => r.branch === "codex/orphan");
    expect(orphan?.state).toBe("branch");
    expect(orphan?.agent).toBe("codex");
  });

  it("humanizes branch names, dropping machine slugs", () => {
    expect(humanizeBranch("claude/expo-justin-web-app-8nlh85")).toBe("expo justin web app");
    expect(humanizeBranch("fix-login")).toBe("fix login");
    expect(humanizeBranch("claude/one")).toBe("one");
    expect(agentOf("claude/x")).toBe("claude");
    expect(agentOf("main")).toBeNull();
  });

  it("groups active first, then by recency", () => {
    const now = new Date("2026-07-17T00:00:00Z");
    const rows = deriveSessions(
      [
        pr({ number: 1, state: "open", updated_at: "2026-06-01T00:00:00Z" }),
        pr({ number: 2, state: "closed", merged_at: "x", head: { ref: "b/two" }, updated_at: "2026-07-15T00:00:00Z" }),
        pr({ number: 3, state: "closed", merged_at: "x", head: { ref: "b/three" }, updated_at: "2026-01-01T00:00:00Z" }),
      ],
      [],
      "main",
    );
    const groups = groupSessions(rows, now);
    expect(groups.map((g) => g.label)).toEqual(["Active", "This week", "Older"]);
    expect(groups[0].rows[0].prNumber).toBe(1);
  });
});
