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

  it("extracts meta, normalizing bare url-shaped hosts to https", () => {
    expect(lifeMeta(SAMPLE)).toEqual({ name: "act", summary: "Life's own agent runtime", dataplane: null, artifacts: null });
    const bare = lifeMeta("name: justin\ndataplane: data.justin.vin\n---\nbody");
    expect(bare.dataplane).toBe("https://data.justin.vin");
    const already = lifeMeta("name: j\ndataplane: https://d.example\n---\n");
    expect(already.dataplane).toBe("https://d.example");
  });

  it("discovers the plane and artifact host from the head (the one data path)", () => {
    const m = lifeMeta("name: j\ndataplane: data.justin.vin\nartifacts: https://artifact.justin.vin\n---\n");
    expect(m.dataplane).toBe("https://data.justin.vin");
    expect(m.artifacts).toBe("https://artifact.justin.vin");
  });
});
