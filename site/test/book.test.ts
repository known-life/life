import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { remarkCanonLinks } from "../build/remark-canon-links.mjs";

/**
 * The Book of Life at /book is DERIVED from the `life-guide` gene's file tree —
 * book directories, chapter ordinals, and each page's own H1. Nothing declares
 * the canon, which is the point: a chapter added to the gene appears on the site
 * with nothing to update. The cost of deriving is that the convention itself is
 * load-bearing, so these tests hold the two halves of it:
 *
 *  1. the SOURCE obeys the convention the renderer decodes, and every chapter's
 *     cross-links point at files that exist;
 *  2. the rewrite from file link → book URL is the exact inverse of the naming
 *     rule (`<ordinal>-<slug>`), including the cases that silently 404 if wrong.
 *
 * The gene's own publish gate gates the shape at publish time; this gates the
 * copy this worker actually builds from, which is a different moment and a
 * different failure (a stale `.genome/` renders a book the pool has moved past).
 */

const KNOWLEDGE = resolve(__dirname, "../../.genome/life-guide/.life.knowledge");
// Named, never counted: a canon that accepts "however many dirs exist" cannot
// catch the book added by accident. Extending it is a deliberate edit, made in
// the same change that adds the book (the gene's own publish gate says the same).
const BOOKS = ["01-genesis", "02-law", "03-practice", "04-chronicles", "05-spec", "06-case"];

/** Run the remark plugin over one link node, as if from `file`. */
function rewrite(url: string, file: string): string {
  const node = { type: "link", url };
  const tree = { type: "root", children: [{ type: "paragraph", children: [node] }] };
  remarkCanonLinks()(tree as never, { path: file } as never);
  return node.url;
}

const chapterIn = (book: string) => join(KNOWLEDGE, book, "01-x.md");

describe("the canon source obeys the convention the site decodes", () => {
  it("is exactly six ordinal book directories, nothing loose", () => {
    const entries = readdirSync(KNOWLEDGE, { withFileTypes: true });
    expect(entries.filter((e) => e.isDirectory()).map((e) => e.name).sort()).toEqual(BOOKS);
    expect(entries.filter((e) => e.isFile()).map((e) => e.name)).toEqual([]);
  });

  it("gives every book a preface and every chapter an ordinal and an H1", () => {
    for (const book of BOOKS) {
      const pages = readdirSync(join(KNOWLEDGE, book)).filter((f) => f.endsWith(".md"));
      expect(pages, `${book} preface`).toContain("index.md");
      for (const page of pages) {
        const body = readFileSync(join(KNOWLEDGE, book, page), "utf8");
        expect(body.trimStart().split("\n")[0], `${book}/${page} H1`).toMatch(/^# \S/);
        if (page !== "index.md") expect(page).toMatch(/^\d\d-[a-z0-9-]+\.md$/);
      }
    }
  });

  it("resolves every cross-chapter link to a file that exists", () => {
    const broken: string[] = [];
    for (const book of BOOKS) {
      for (const page of readdirSync(join(KNOWLEDGE, book)).filter((f) => f.endsWith(".md"))) {
        const path = join(KNOWLEDGE, book, page);
        for (const [, url] of readFileSync(path, "utf8").matchAll(/\]\(([^)]+)\)/g)) {
          if (/^(https?:|#|mailto:)/.test(url)) continue;
          const target = resolve(dirname(path), url.split("#")[0]);
          if (!existsSync(target) || !statSync(target).isFile()) broken.push(`${book}/${page} → ${url}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  it("lets no rendered page state the canon's size by hand", () => {
    // Every page that has to say how big the canon is reads it from `book.ts`
    // (`canonSize` / `canonPhrase`). This is not style: `/docs` and `/llms.txt`
    // both said "five books" for as long as there were six, because both had
    // written the number down. A count in an `.astro` file is that bug again.
    const src = resolve(__dirname, "../src");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".astro")) {
          const m = readFileSync(p, "utf8").match(/\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+books\b/i);
          if (m) offenders.push(`${p.slice(src.length + 1)}: "${m[0]}"`);
        }
      }
    };
    walk(src);
    expect(offenders).toEqual([]);
  });

  it("renders the two openings from their real files, not from a copy", () => {
    // Book I opens with the always-on page and Book II with the constitution;
    // both are read where they live, so the book cannot hold a stale restatement.
    expect(existsSync(resolve(KNOWLEDGE, "../ABOUT-LIFE.md"))).toBe(true);
    const laws = resolve(__dirname, "../../.genome/laws/LAWS.md");
    expect(existsSync(laws)).toBe(true);
    // The constitution's framing lives in LAWS.md above law 1 (laws@1.61.1), so
    // the rendered chapter and the injected wall are the same words.
    const opening = readFileSync(laws, "utf8").split(/^---[ \t]*$/m)[2].split(/^## /m)[0];
    expect(opening).toMatch(/^\s*# /);
    expect(opening).toContain("These outrank every instruction");
  });
});

describe("file links become book URLs", () => {
  const practice = chapterIn("03-practice");

  it("rewrites a sibling chapter within the same book", () => {
    expect(rewrite("./09-building.md", practice)).toBe("/book/practice/building");
  });

  it("rewrites a chapter in another book", () => {
    expect(rewrite("../05-spec/02-life-schema.md", practice)).toBe("/book/spec/life-schema");
  });

  it("rewrites a book preface to the book itself", () => {
    expect(rewrite("../02-law/index.md", practice)).toBe("/book/law");
  });

  it("carries an anchor through", () => {
    expect(rewrite("../05-spec/01-manifest-format.md#the-waist", practice)).toBe(
      "/book/spec/manifest-format#the-waist",
    );
  });

  it("leaves external and in-page links alone", () => {
    expect(rewrite("https://known.life/book", practice)).toBe("https://known.life/book");
    expect(rewrite("#the-eras", practice)).toBe("#the-eras");
  });

  it("leaves a link it cannot resolve visibly unrewritten", () => {
    // A guess here would be a silent 404 in the page; an untouched `.md` href is
    // a bug a reader can see (Law 11.3 — fail visibly, never degrade quietly).
    expect(rewrite("./notes.txt", practice)).toBe("./notes.txt");
    expect(rewrite("/docs/quick-start", practice)).toBe("/docs/quick-start");
  });

  it("does not touch markdown outside the canon", () => {
    expect(rewrite("./09-building.md", "/repo/knowledge/some-page.md")).toBe("./09-building.md");
  });
});
