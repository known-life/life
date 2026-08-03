import { getCollection, type CollectionEntry } from "astro:content";
import { withBindingText, constitutionMarkdown } from "../../build/law-binding.mjs";

/**
 * The Book of Life, derived — never declared.
 *
 * There is no table of contents in this file, and there must never be one. The
 * canon's structure IS the `life-guide` gene's directory tree: a book is a
 * numbered directory, its preface is that directory's `index.md`, and its
 * chapters are the remaining files in filename order. Titles come from each
 * page's own H1. So a chapter added to the gene appears here on the next deploy
 * with nothing to update, and a rendering can never claim a chapter the gene does
 * not have (law/derive-dont-maintain — prefer the derived to the maintained).
 *
 * The only hand-written entries are OPENINGS: the two chapters whose files live
 * outside the knowledge tree because something load-bearing reads them where they
 * sit. They are structural, not a content index — see below.
 */

export type Chapter = {
  slug: string;
  title: string;
  href: string;
  entry: CollectionEntry<"canon"> | CollectionEntry<"scripture">;
  /**
   * The chapter as the web publishes it: the gene's own body, with Book II's
   * on-disk pointer to a Law swapped for that Law's binding text (see
   * `build/law-binding.mjs`). Every other chapter is its body, byte for byte.
   * The `.md` edition serves this, and the rendered pages run the same function
   * through remark, so the two editions carry the same text.
   */
  markdown: string;
};

export type Book = {
  slug: string;
  ordinal: number;
  numeral: string;
  title: string;
  blurb: string;
  href: string;
  preface: CollectionEntry<"canon">;
  chapters: Chapter[];
};

/**
 * The two chapters rendered from outside `.life.knowledge/`. `ABOUT-LIFE.md` is
 * read from the gene root by its own SessionStart hook; `LAWS.md` is the binding
 * constitution the `laws` gene injects in full every turn. Both are rendered here
 * from their real files, so the canon holds them without holding a second copy —
 * which is exactly what lets the Laws live in the book and stay injected from the
 * `laws` gene alone.
 */
const OPENINGS: Record<string, { id: string; slug: string; title: string; note: string }> = {
  genesis: {
    id: "life-guide/ABOUT-LIFE",
    slug: "the-waking",
    title: "The waking",
    note: "The always-on page. This is injected verbatim at the top of every session, before the Laws — the first thing any .life reads about itself.",
  },
  law: {
    id: "laws/LAWS",
    slug: "the-laws",
    title: "The Laws",
    note: "The binding text, rendered from the laws gene's own LAWS.md. It is injected in full into every waking and re-shown every turn; the book renders it, it does not hold a copy. If a commentary chapter and this text disagree, this text wins.",
  },
};

/** A one-line character sketch per book, for the canon index. */
const BLURBS: Record<string, string> = {
  genesis: "What a .life is, before anything you might do with one.",
  law: "The constitution, and the room it has no space for.",
  practice: "How a life is actually lived — the working chapters.",
  chronicles: "How Life got this shape, and what each rule is a scar of.",
  spec: "Where the book stops explaining and starts binding.",
  case: "Why this shape and not another — argued, not asserted.",
};

const NUMERALS = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];

/** `01-genesis` → `genesis`; `04-shape-of-the-tree` → `shape-of-the-tree`. */
const unordinal = (s: string) => s.replace(/^\d+-/, "");

/**
 * The first ATX H1 in a page — the title the author already wrote. Inline
 * markdown is stripped: a title appears in nav, prev/next, and `<title>`, where
 * `` `.life` `` would read as literal backticks rather than as code.
 */
function h1(body: string): string {
  const m = body.match(/^#\s+(.+?)\s*$/m);
  if (!m) throw new Error("book: page has no H1 title");
  return m[1].replace(/[`*_]/g, "");
}

let cached: Book[] | null = null;

/** The whole canon, in reading order. */
export async function getCanon(): Promise<Book[]> {
  if (cached) return cached;

  const pages = await getCollection("canon");
  const scripture = await getCollection("scripture");

  const dirs = [...new Set(pages.map((p) => p.id.split("/")[0]))].sort();

  cached = dirs.map((dir, i) => {
    const slug = unordinal(dir);
    // The glob loader collapses `<dir>/index.md` to the id `<dir>`, so a book's
    // preface is the entry whose id IS the directory name.
    const preface = pages.find((p) => p.id === dir);
    if (!preface) throw new Error(`book: ${dir} has no index.md preface`);

    const chapters: Chapter[] = pages
      .filter((p) => p.id.startsWith(`${dir}/`))
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((entry) => {
        const s = unordinal(entry.id.split("/")[1]);
        return {
          slug: s,
          title: h1(entry.body ?? ""),
          href: `/book/${slug}/${s}`,
          entry,
          markdown: withBindingText(entry.body ?? ""),
        };
      });

    const opening = OPENINGS[slug];
    if (opening) {
      const entry = scripture.find((s) => s.id === opening.id);
      if (!entry) throw new Error(`book: opening chapter ${opening.id} not found`);
      chapters.unshift({
        slug: opening.slug,
        title: opening.title,
        href: `/book/${slug}/${opening.slug}`,
        entry,
        // The Laws are no longer a file to echo: `LAWS.md` is a spine over the
        // gene's clause files, so the constitution is rendered from them (see
        // `constitutionMarkdown`). Every other opening IS its file.
        markdown: opening.id === OPENINGS.law.id ? constitutionMarkdown() : (entry.body ?? ""),
      });
    }

    return {
      slug,
      ordinal: i + 1,
      numeral: NUMERALS[i] ?? String(i + 1),
      title: h1(preface.body ?? ""),
      blurb: BLURBS[slug] ?? "",
      href: `/book/${slug}`,
      preface,
      chapters,
    };
  });

  return cached;
}

const COUNTS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

/**
 * `"six books"` and `"six books: Genesis, The Law, …"` — the canon's own shape as
 * a sentence, for the places prose has to state it (meta descriptions, the docs
 * on-ramp, the agent index). Derived for the same reason the index is: a
 * hand-written "in five books" is a claim that goes stale the day a book lands,
 * and this one already did.
 */
export async function canonSize(): Promise<string> {
  const n = (await getCanon()).length;
  return `${COUNTS[n] ?? n} books`;
}

export async function canonPhrase(): Promise<string> {
  const canon = await getCanon();
  return `${await canonSize()}: ${canon.map((b) => b.title).join(", ")}`;
}

/** The editorial note shown above an opening chapter, if it has one. */
export function openingNote(bookSlug: string, chapterSlug: string): string | null {
  const o = OPENINGS[bookSlug];
  return o && o.slug === chapterSlug ? o.note : null;
}

/** Flat reading order across the whole canon — for prev/next. */
export async function getReadingOrder(): Promise<{ book: Book; chapter: Chapter }[]> {
  const canon = await getCanon();
  return canon.flatMap((book) => book.chapters.map((chapter) => ({ book, chapter })));
}
