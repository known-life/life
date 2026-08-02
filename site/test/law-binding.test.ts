/**
 * Book II's commentary chapters bind to the constitution by PERMANENT ID.
 *
 * The `laws` gene owns the format and reads it — `readLaws(spineFile)` walks the
 * spine's groups and the one-file-per-clause dir. `build/law-binding.mjs` calls
 * that reader and renders; it does not parse. These cases pin the JOIN, never the
 * format: an ordinal assertion here would re-introduce the coupling clause ids
 * exist to remove — "ordinals were a position, and a position is not an
 * identity", the spine's own words.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { declaredLaw, withBindingText, commentarySlugs } from "../build/law-binding.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const LAW_BOOK = resolve(HERE, "../../.genome/life-guide/.life.knowledge/02-law");
const SPINE = resolve(HERE, "../../.genome/laws/LAWS.md");
const { readLaws } = createRequire(import.meta.url)(
  resolve(HERE, "../../.genome/laws/hooks/session-start-inject.js"),
);

const commentaries = readdirSync(LAW_BOOK)
  .filter((f) => f.endsWith(".md") && f !== "index.md")
  .sort()
  .map((file) => ({ file, body: readFileSync(join(LAW_BOOK, file), "utf8") }));

describe("the laws gene is the only reader of its own format", () => {
  const { groups } = readLaws(SPINE);

  it("returns every law group with a key, an emoji, a title and clauses", () => {
    expect(groups.length).toBeGreaterThan(0);
    for (const g of groups) {
      expect(g.key, "group key").toMatch(/^[a-z0-9-]+$/);
      expect(g.emoji, `${g.key} emoji`).not.toEqual("");
      expect(g.title, `${g.key} title`).toMatch(/\S/);
      expect(g.clauses.length, `${g.key} clauses`).toBeGreaterThan(0);
    }
  });

  it("gives every clause a permanent id and hands it to exactly one group", () => {
    const seen = new Map();
    for (const g of groups) {
      for (const c of g.clauses) {
        expect(seen.has(c.id), `clause ${c.id} claimed twice`).toBe(false);
        seen.set(c.id, g.key);
      }
    }
  });
});

describe("every commentary chapter is joined to the law it comments on", () => {
  const { groups } = readLaws(SPINE);
  const byKey = new Map(groups.map((g) => [g.key, g]));

  it("declares a law by id in its heading, and that id exists", () => {
    for (const c of commentaries) {
      const id = declaredLaw(c.body);
      expect(id, `${c.file} declares no id`).not.toBeNull();
      expect(byKey.has(id), `${c.file} declares '${id}', which the spine does not`).toBe(true);
    }
  });

  it("joins by id, never by filename", () => {
    const see = commentaries.find((c) => c.file.endsWith("-see.md"));
    if (see) expect(declaredLaw(see.body)).toEqual("sight");
  });

  it("renders that law's clauses into the page, and only that law's", () => {
    for (const c of commentaries) {
      const id = declaredLaw(c.body);
      const out = withBindingText(c.body, SPINE);
      for (const clause of byKey.get(id).clauses) {
        expect(out, `${c.file} is missing its own clause ${clause.id}`).toContain(`**${clause.id}**`);
      }
      for (const other of groups) {
        if (other.key === id) continue;
        for (const clause of other.clauses) {
          expect(out, `${c.file} leaked ${other.key}'s clause ${clause.id}`).not.toContain(`**${clause.id}**`);
        }
      }
    }
  });

  it("maps each law id to the slug of the chapter commenting on it", () => {
    const slugs = commentarySlugs(commentaries);
    for (const c of commentaries) {
      expect(slugs.get(declaredLaw(c.body))).toEqual(c.file.replace(/^\d+-/, "").replace(/\.md$/, ""));
    }
  });
});
