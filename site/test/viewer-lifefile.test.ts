import { describe, it, expect } from "vitest";
import { lifeMeta, LIFE_MARKER } from "../../.genome/viewer/src/lifefile";

// The viewer no longer has a `.life` parser — it BINDS to `known.life/lifefile`,
// the engine's own head grammar (2026-07-30, the sweep that found fourteen
// hand-rolled parsers and retired thirteen). So the head grammar itself is
// tested where it lives, in lifefile's 21-fixture conformance suite, and what is
// tested HERE is the only thing the viewer still owns: `lifeMeta` — which keys
// it lifts, how it normalizes a host, and what it does with a head that will
// not parse.
//
// This file used to import `parseLifeFile` and assert the lenient behaviour of
// the viewer's own reader, including heads the engine REFUSES. Those tests could
// only ever have passed against a parser that disagreed with the engine, which
// is the bug the sweep removed.

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

describe("lifeMeta — what the viewer lifts from a head", () => {
  it("lifts the four keys it renders from, and nothing else", () => {
    expect(lifeMeta(SAMPLE)).toEqual({
      name: "act",
      summary: "Life's own agent runtime",
      dataplane: null,
      artifacts: null,
      error: null,
    });
  });

  it("normalizes a bare url-shaped host to https, and leaves a real URL alone", () => {
    // A bare host is a legal plain scalar — it carries no `:`. This is exactly
    // why the quoted form below is the one a declared URL has to take.
    const bare = lifeMeta("name: justin\ndataplane: data.justin.vin\n---\nbody");
    expect(bare.dataplane).toBe("https://data.justin.vin");
    expect(bare.error).toBe(null);

    const already = lifeMeta('name: j\ndataplane: "https://d.example"\n---\n');
    expect(already.dataplane).toBe("https://d.example");
  });

  it("discovers the plane and artifact host from one head (the one data path)", () => {
    // The artifact host is declared where every real `.life` declares it — the
    // `artifact` gene's own `imports:` entry. `declaredHost` strips the owner
    // prefix and falls back to the GENE's name, so a bare top-level key would
    // have to be `artifact:`; no `.life` in the tree uses one, and asserting a
    // plural `artifacts:` here tested a shape the system does not have.
    const m = lifeMeta(
      'name: j\ndataplane: data.justin.vin\nimports:\n  known.life/artifact: "https://artifact.justin.vin"\n---\n',
    );
    expect(m.dataplane).toBe("https://data.justin.vin");
    expect(m.artifacts).toBe("https://artifact.justin.vin");
    expect(m.error).toBe(null);
  });

  it("a life that declares no artifact host reads null — the gene derives it", () => {
    const m = lifeMeta("name: j\ndataplane: data.justin.vin\n---\n");
    expect(m.artifacts).toBe(null);
    expect(m.error).toBe(null);
  });

  it("REFUSES an unquoted URL, and says where", () => {
    // The `.life` head is a strict subset of YAML: a plain scalar may not
    // contain `:`, so `dataplane: https://x` is not a declaration the engine
    // would accept — and a viewer that rendered it anyway would be showing a
    // life that does not exist. The refusal has to carry the position, because
    // "your .life is broken" without a line number is not actionable.
    const m = lifeMeta("name: j\ndataplane: https://d.example\n---\n");
    expect(m.error).toMatch(/plain scalar contains/);
    expect(m.error).toMatch(/\.life:2:/);
    expect(m.dataplane).toBe(null);
    expect(m.name).toBe(null);
  });

  it("a head that will not parse yields NO fields — never a partial read", () => {
    // The old parser was "tolerant of everything else (unknown structure is
    // simply not surfaced)", which rendered a planeless page for a life whose
    // plane was declared right there. Every field null WITH an error is the
    // contract that replaced it: a caller must branch, and cannot mistake a
    // broken head for an empty one.
    const m = lifeMeta("name: j\n\tdataplane: x\n---\n");   // a tab indent is fatal
    expect(m.error).not.toBe(null);
    for (const v of [m.name, m.summary, m.dataplane, m.artifacts]) expect(v).toBe(null);
  });

  it("reads a head with no --- rule at all", () => {
    const m = lifeMeta("name: x\nsummary: y");
    expect(m.name).toBe("x");
    expect(m.summary).toBe("y");
    expect(m.error).toBe(null);
  });

  it("survives a CRLF head — a trailing \\r must not read as a grammar error", () => {
    const m = lifeMeta("name: x\r\ndataplane: d.example\r\n---\r\nbody");
    expect(m.error).toBe(null);
    expect(m.dataplane).toBe("https://d.example");
  });

  it("the life marker is the root .life, and that is the whole of detection", () => {
    expect(LIFE_MARKER).toBe(".life");
  });
});
