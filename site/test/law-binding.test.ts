import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseLaws, declaredLaw, withBindingText } from "../build/law-binding.mjs";

/**
 * Book II's commentary chapters are published with the Law each one comments on
 * rendered into the page (build/law-binding.mjs). Nothing is authored to make
 * that work: the chapter declares its Law in its own H1, the clauses come out of
 * the `laws` gene's `LAWS.md`, and the two are matched at build time. So what
 * these tests hold is the join — that every chapter finds its Law, that the Law
 * it finds is the one its title claims, and that a page never carries another
 * Law's clauses.
 *
 * The failure they exist for is the one the book shipped with: sixteen pages
 * discussing clauses they only pointed at, the pointer being a filesystem path a
 * web reader cannot open.
 */

const KNOWLEDGE = resolve(__dirname, "../../.genome/life-guide/.life.knowledge");
const LAW_BOOK = join(KNOWLEDGE, "02-law");
const LAWS_MD = readFileSync(resolve(__dirname, "../../.genome/laws/LAWS.md"), "utf8");

const commentaries = readdirSync(LAW_BOOK)
  .filter((f) => /^\d\d-[a-z0-9-]+\.md$/.test(f))
  .sort()
  .map((file) => ({ file, body: readFileSync(join(LAW_BOOK, file), "utf8") }));

describe("LAWS.md parses by the laws gene's own convention", () => {
  const laws = parseLaws(LAWS_MD);

  it("finds every law, numbered by its heading, in file order", () => {
    expect(laws.length).toBeGreaterThan(0);
    expect(laws.map((l) => l.n)).toEqual(laws.map((_, i) => i + 1));
    for (const law of laws) {
      expect(law.emoji, `Law ${law.n} emoji`).not.toEqual("");
      expect(law.title, `Law ${law.n} title`).toMatch(/\S/);
    }
  });

  it("keeps each law's clauses whole and gives them to no one else", () => {
    for (const law of laws) {
      // Every clause of Law n is prefixed `n.m` — the writing convention the
      // constitution is cited by. A clause landing in the wrong law's body means
      // the heading split drifted, and the page would render the wrong text.
      const clauses = [...law.body.matchAll(/^- \*\*(\d+)\.(\d+)\*\*/gm)];
      expect(clauses.length, `Law ${law.n} has clauses`).toBeGreaterThan(0);
      for (const [, n] of clauses) expect(Number(n), `Law ${law.n} clause owner`).toBe(law.n);
    }
  });

  it("drops the file's own comment block, not an hr inside a law", () => {
    expect(parseLaws(LAWS_MD).map((l) => l.title)).not.toContain("");
    const synthetic = [
      "---",
      "# a comment block",
      "---",
      "",
      "# THE LAWS",
      "",
      "## 1. 🔒 First",
      "- **1.1** one",
      "",
      "---",
      "",
      "- **1.2** two",
      "",
      "## 2. 🫀 Second",
      "- **2.1** three",
    ].join("\n");
    const [first, second] = parseLaws(synthetic);
    expect(first).toMatchObject({ n: 1, emoji: "🔒", title: "First" });
    expect(first.body).toContain("---");
    expect(first.body).toContain("- **1.2** two");
    expect(second).toMatchObject({ n: 2, emoji: "🫀", title: "Second" });
  });
});

describe("every commentary chapter is joined to the Law it comments on", () => {
  const laws = parseLaws(LAWS_MD);

  it("has one commentary per law, in the same order", () => {
    expect(commentaries.map((c) => declaredLaw(c.body))).toEqual(laws.map((l) => l.n));
  });

  it("agrees with LAWS.md about what each law is called", () => {
    // The chapter H1 restates the law's title, which is the one duplication the
    // canon carries. It is allowed to exist and not allowed to drift.
    for (const { file, body } of commentaries) {
      const n = declaredLaw(body)!;
      const law = laws.find((l) => l.n === n)!;
      const h1 = body.match(/^#[ \t]+(.*)$/m)![1];
      expect(h1, file).toBe(`Law ${law.n} · ${law.emoji} ${law.title}`);
    }
  });

  it("renders that law's clauses into the page, and only that law's", () => {
    for (const { file, body } of commentaries) {
      const n = declaredLaw(body)!;
      const law = laws.find((l) => l.n === n)!;
      const published = withBindingText(body, LAWS_MD);

      expect(published, file).toContain(law.body);
      for (const [clause] of law.body.matchAll(/^- \*\*\d+\.\d+\*\*/gm)) {
        expect(published, `${file} ${clause}`).toContain(clause);
      }
      for (const other of laws.filter((l) => l.n !== n)) {
        expect(published, `${file} must not carry Law ${other.n}`).not.toContain(other.body);
      }
    }
  });

  it("puts the binding text above the commentary, under the chapter title", () => {
    for (const { file, body } of commentaries) {
      const published = withBindingText(body, LAWS_MD);
      const law = parseLaws(LAWS_MD).find((l) => l.n === declaredLaw(body))!;
      const lines = published.split("\n");

      expect(lines[0], file).toMatch(/^# Law \d+ · /);
      expect(published.indexOf(law.body), file).toBeLessThan(published.indexOf("**In practice.**"));
      // The rule that closes the quotation: what follows it is commentary.
      const rule = published.indexOf("\n---\n");
      expect(rule, `${file} rule`).toBeGreaterThan(published.indexOf(law.body));
      expect(rule, `${file} rule`).toBeLessThan(published.indexOf("**In practice.**"));
    }
  });

  it("drops the on-disk pointer once the text it points at is on the page", () => {
    for (const { file, body } of commentaries) {
      expect(body, `${file} still points at the file on disk`).toMatch(/^> Binding text:/m);
      expect(withBindingText(body, LAWS_MD), file).not.toMatch(/^> Binding text:/m);
    }
  });
});

describe("the transform stays inside Book II", () => {
  it("leaves a page that comments on no law exactly as written", () => {
    const page = "# The anatomy of a gene\n\nA gene is a published `.life` cell.\n";
    expect(declaredLaw(page)).toBeNull();
    expect(withBindingText(page, LAWS_MD)).toBe(page);
  });

  it("leaves the constitution itself alone — it is not a commentary on itself", () => {
    expect(declaredLaw(LAWS_MD)).toBeNull();
    expect(withBindingText(LAWS_MD, LAWS_MD)).toBe(LAWS_MD);
  });

  it("fails loudly when a chapter claims a law the constitution does not have", () => {
    // The silent version of this bug renders a page whose subject is missing —
    // exactly the state the book was in. A build that cannot find the text stops.
    const orphan = "# Law 99 · 🧨 A law that was never passed\n\n**In practice.** …\n";
    expect(() => withBindingText(orphan, LAWS_MD)).toThrow(/Law 99/);
  });
});
