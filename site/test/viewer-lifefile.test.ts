import { describe, it, expect } from "vitest";
import { parseLifeFile, lifeMeta } from "../../.genome/viewer/src/lifefile";

const SAMPLE = `life: 0.1
name: act
summary: "Life's own agent runtime"
# a comment line
imports:
  - known.life/claude-code
  - known.life/queue
deploy_name: life-act

---

# act — the headless runner

Body prose here.
`;

describe(".life parsing", () => {
  it("splits head and body and parses scalars + lists", () => {
    const { head, headText, body } = parseLifeFile(SAMPLE);
    expect(head.name).toBe("act");
    expect(head.summary).toBe("Life's own agent runtime");
    expect(head.imports).toEqual(["known.life/claude-code", "known.life/queue"]);
    expect(head.deploy_name).toBe("life-act");
    expect(headText).toContain("life: 0.1");
    expect(body.startsWith("# act")).toBe(true);
  });

  it("tolerates a headless file (no --- rule)", () => {
    const { head, body } = parseLifeFile("name: x\nsummary: y");
    expect(head.name).toBe("x");
    expect(body).toBe("");
  });

  it("extracts meta, normalizing a bare harness host to https", () => {
    expect(lifeMeta(SAMPLE)).toEqual({ name: "act", summary: "Life's own agent runtime", harness: null });
    const withHarness = lifeMeta("name: justin\nharness: harness.justin.vin\n---\nbody");
    expect(withHarness.harness).toBe("https://harness.justin.vin");
    const already = lifeMeta("name: j\nharness: https://h.example\n---\n");
    expect(already.harness).toBe("https://h.example");
  });
});
