import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { lifeStub, scaffoldFiles, validRepoName } from "../../.genome/viewer/src/scaffold";

describe("new-life scaffold", () => {
  it("writes the exact .life stub install.sh writes (name aside)", () => {
    // The installer is the source of truth for the stub — parity here means a
    // web-scaffolded life and a curl-scaffolded life are indistinguishable.
    const installSh = readFileSync(fileURLToPath(new URL("../../install.sh", import.meta.url)), "utf8");
    const heredoc = installSh.match(/cat > \.life << 'EOF'\n([\s\S]*?)\nEOF/);
    expect(heredoc).not.toBeNull();
    const expected = heredoc![1].replace("name: my-project", "name: demo") + "\n";
    expect(lifeStub("demo")).toBe(expected);
  });

  it("seeds .life, README, and .gitignore, installer derived from the mount's origin", () => {
    const files = scaffoldFiles("demo", "https://known.life");
    expect(files.map((f) => f.path)).toEqual([".life", "README.md", ".gitignore"]);
    expect(files[1].content).toContain("curl -fsSL https://known.life/install.sh | sh");
    expect(files[2].content).toContain(".genome/");
    // Nothing hardcodes the genepool host — another mount seeds its own origin.
    const other = scaffoldFiles("demo", "https://pool.example");
    expect(other[1].content).toContain("curl -fsSL https://pool.example/install.sh | sh");
    expect(other[1].content).not.toContain("known.life/install.sh");
  });

  it("validates repo names", () => {
    expect(validRepoName("my-life")).toBe(true);
    expect(validRepoName("My.Life_2")).toBe(true);
    expect(validRepoName("")).toBe(false);
    expect(validRepoName("-leading")).toBe(false);
    expect(validRepoName("has space")).toBe(false);
    expect(validRepoName("x".repeat(120))).toBe(false);
    expect(validRepoName("thing.git")).toBe(false);
  });
});
