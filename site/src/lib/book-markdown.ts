import { getCanon, type Book, type Chapter } from "./book.ts";

/**
 * The machine edition of the canon. Same bytes as the gene ships — the rendered
 * pages and these files are two views of one source, so an agent that reads
 * `/book.md` and a person reading `/book` are looking at the same text.
 *
 * Everything added here is a locator (where this came from, what it is called,
 * where the rest is), never a restatement of content.
 *
 * `chapter.markdown`, not `chapter.entry.body`: Book II's commentary chapters are
 * published with the Law they comment on rendered in, because their on-disk
 * pointer to `.genome/laws/LAWS.md` is a dead end for anyone who arrived over
 * HTTP (build/law-binding.mjs). Still one source — the clauses are read from the
 * `laws` gene, which is also where the rendered pages get them.
 */

const SITE = "https://known.life";

function chapterSection(book: Book, chapter: Chapter, depth: number): string {
  const body = chapter.markdown.trim();
  // The page's own H1 is the chapter title; nest it under the book heading so
  // the assembled file has one coherent outline instead of a run of H1s.
  const nested = body.replace(/^#\s+/, "#".repeat(depth) + " ");
  return `${nested}\n\n[${SITE}${chapter.href}]\n`;
}

/** One chapter, as its own file. */
export function chapterMarkdown(book: Book, chapter: Chapter): string {
  return [
    `<!-- The Book of Life · Book ${book.numeral}: ${book.title} · ${SITE}${chapter.href}`,
    `     Source: the known.life/life-guide gene. Whole canon: ${SITE}/book.md -->`,
    "",
    chapter.markdown.trim(),
    "",
  ].join("\n");
}

/** One book: its preface, then every chapter in order. */
export function bookMarkdown(book: Book): string {
  const preface = (book.preface.body ?? "").trim().replace(/^#\s+/, "# ");
  return [
    `<!-- The Book of Life · Book ${book.numeral} of the canon · ${SITE}${book.href}`,
    `     Source: the known.life/life-guide gene. Whole canon: ${SITE}/book.md -->`,
    "",
    preface,
    "",
    ...book.chapters.map((c) => chapterSection(book, c, 2)),
  ].join("\n");
}

/** The whole canon, one file, in reading order. */
export async function canonMarkdown(): Promise<string> {
  const canon = await getCanon();
  const toc = canon
    .map(
      (b) =>
        `- **Book ${b.numeral} — ${b.title}** — ${b.blurb}\n` +
        b.chapters.map((c) => `  - ${c.title} (${SITE}${c.href})`).join("\n"),
    )
    .join("\n");

  const head = [
    "# The Book of Life",
    "",
    "The canon of the Life protocol — a protocol for agent-legible repos, where a",
    "`.life` is a git repo that remembers, acts, and evolves across mortal sessions.",
    "",
    "This file is the whole canon in one fetch, assembled from the source it is",
    "written in: every chapter is a markdown page of the `known.life/life-guide`",
    "gene, and Book II's first chapter is the `known.life/laws` gene's own",
    "`LAWS.md` — the binding constitution every `.life` has injected in full at the",
    "top of every session. Nothing here is a restatement; there is no second copy",
    "to drift.",
    "",
    `Rendered edition: ${SITE}/book · per-page markdown: any book URL with \`.md\``,
    "appended. Inside a `.life` the same text is already installed:",
    "`life ask life-guide`.",
    "",
    "## Contents",
    "",
    toc,
    "",
  ].join("\n");

  const body = canon.map((book) => {
    const preface = (book.preface.body ?? "").trim().replace(/^#\s+(.*)$/m, `# Book ${book.numeral} — $1`);
    return [preface, "", ...book.chapters.map((c) => chapterSection(book, c, 2))].join("\n");
  });

  return [head, ...body].join("\n---\n\n");
}
