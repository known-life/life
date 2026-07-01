import { describe, it, expect } from "vitest";
import { scanIsolateParity, nodeCommandBodies } from "../src/registry/lib/parity";

// The isolate-parity advisory scan. The contract it pins (learned live: two
// published genes shipped isolate-broken while passing the shallow
// interpreter-only check): a `run: node <file>` command body must export run(),
// reach IO through __LIFE_IO_BACKEND__ when it touches fs/child_process, and
// never rely on import.meta.url. All findings are ADVISORY — nothing here may
// ever block a publish (a container-only gene is legitimate).

const LIFE = `life: 0.1
name: demo
commands:
  census:
    run: node bin/demo.mjs census
    desc: count things
  report:
    run: "node bin/report.js"
    desc: report things
  shellish:
    run: bash bin/x.sh
    desc: not a node body — never judged
`;

describe("nodeCommandBodies — which files are judged", () => {
  it("collects every `run: node <file>` body, quoted or not, and skips non-node runs", () => {
    expect(nodeCommandBodies(LIFE).sort()).toEqual(["bin/demo.mjs", "bin/report.js"]);
  });
});

describe("the three proven failure shapes warn (never block)", () => {
  it("a bare top-level script with raw fs gets no-run-export + raw-fs", () => {
    const r = scanIsolateParity({
      ".life": LIFE,
      "bin/demo.mjs": `import fs from 'node:fs';\nconsole.log(fs.readdirSync('.'));`,
      "bin/report.js": `module.exports = { run: async () => {} };`,
    });
    const rules = r.map((f) => f.rule);
    expect(rules).toContain("isolate-no-run-export");
    expect(rules).toContain("isolate-raw-fs");
    // the compliant body produced no findings
    expect(r.filter((f) => f.path === "bin/report.js")).toEqual([]);
  });

  it("child_process without the backend warns; with the backend it does not", () => {
    const naked = scanIsolateParity({
      ".life": LIFE,
      "bin/demo.mjs": `exports.run = () => require('child_process').execSync('git log');`,
      "bin/report.js": `exports.run = () => {};`,
    });
    expect(naked.map((f) => f.rule)).toContain("isolate-raw-child-process");

    const seamed = scanIsolateParity({
      ".life": LIFE,
      "bin/demo.mjs": `exports.run = () => {\nconst BK = globalThis.__LIFE_IO_BACKEND__;\nconst cp = BK ? BK.childProcess : require('child_process');\n};`,
      "bin/report.js": `exports.run = () => {};`,
    });
    expect(seamed.filter((f) => f.path === "bin/demo.mjs")).toEqual([]);
  });

  it("import.meta.url warns even in an otherwise-compliant ESM body", () => {
    const r = scanIsolateParity({
      ".life": LIFE,
      "bin/demo.mjs": `export async function run() { return new URL('.', import.meta.url); }`,
      "bin/report.js": `exports.run = () => {};`,
    });
    expect(r.map((f) => f.rule)).toContain("isolate-import-meta-url");
  });

  it("a declared body missing from the files map is itself a finding", () => {
    const r = scanIsolateParity({ ".life": LIFE, "bin/report.js": `exports.run = () => {};` });
    expect(r.map((f) => f.rule)).toContain("isolate-body-missing");
  });
});

describe("recognized run() export shapes", () => {
  const shapes = [
    `module.exports = { run };`,
    `module.exports.run = async () => {};`,
    `exports.run = () => {};`,
    `export async function run() {}`,
    `export function run() {}`,
    `export { run };`,
  ];
  it.each(shapes)("%s counts as a run export", (shape) => {
    const r = scanIsolateParity({
      ".life": LIFE,
      "bin/demo.mjs": shape,
      "bin/report.js": `exports.run = () => {};`,
    });
    expect(r.filter((f) => f.rule === "isolate-no-run-export")).toEqual([]);
  });
});

describe("genes with no node commands are untouched", () => {
  it("no .life or no node runs → no findings", () => {
    expect(scanIsolateParity({ "adapter.js": "whatever" })).toEqual([]);
    expect(scanIsolateParity({ ".life": "life: 0.1\nname: x\n" })).toEqual([]);
  });
});
