import { createRequire } from "node:module";
const { readLaws } = createRequire(import.meta.url)("../../.genome/laws/hooks/session-start-inject.js");

/**
 * Book II's commentary chapters, given the text they comment on.
 *
 * Each of the sixteen chapters in `02-law/` opens `# Law N · <emoji> <title>` and
 * then a pointer — "Binding text: `.genome/laws/LAWS.md`, Law N" — before the
 * commentary starts. That pointer is right on disk, where an agent reading the
 * gene has `.genome/laws/LAWS.md` a path away. On the web it is a dead end: the
 * reader is given a filesystem path they cannot open, so the page discusses
 * clauses it never shows. This swaps the pointer for the thing it points at.
 *
 * It is a rendering, not a copy. The clauses are read out of the `laws` gene's own
 * `LAWS.md` at build time and parsed with that gene's own convention (`## <n>.
 * <emoji> <title>`, body until the next `## ` — the same shape
 * `hooks/session-start-inject.js` decodes to build the session wall). No law text
 * is authored here or in `life-guide`, so the constitution still has exactly one
 * source and this file cannot make the book say something LAWS.md does not.
 *
 * One rule, two pipelines: `src/lib/book.ts` applies it to every chapter body,
 * which is the whole `.md` edition, and `remark-law-binding.mjs` applies it to
 * the markdown Astro compiles into pages. Both call the function below, so the
 * two editions cannot disagree about the binding text either.
 */

/**
 * `LAWS.md` → its laws, in file order. A faithful port of the `laws` gene's own
 * parser (the `lawsBlock` loop in `hooks/session-start-inject.js`), differing only
 * in what it returns: structured laws rather than the `<life-laws>` wall. The
 * ordinal is split off the title here because the chapter H1 already carries
 * "Law N ·" — repeating it would be the restatement this whole file avoids.
 */
export function declaredLaw(body) {
  const m = String(body).match(/^#[ \t]+⚖([a-z0-9-]+)[ \t]*·/m);
  return m ? m[1] : null;
}

/**
 * Law number → the slug of the chapter that comments on it, derived from the
 * commentary chapters themselves: the filename gives the URL (the canon's
 * `<ordinal>-<slug>` rule), the H1 gives the Law. No table, so a chapter renamed
 * or a Law renumbered needs nothing here — and a Law with no commentary yet
 * simply has no entry, which is the honest state rather than a dead link.
 *
 * This is the return trip. `withBindingText` carries the constitution INTO the
 * commentary; this carries a reader from the constitution OUT to it, so the one
 * page that holds every Law and every clause is also where you drill down from.
 */
export function commentarySlugs(chapters) {
  const slugs = new Map();
  for (const { file, body } of chapters) {
    const n = declaredLaw(body);
    if (n !== null) slugs.set(n, file.replace(/^\d+-/, "").replace(/\.md$/, ""));
  }
  return slugs;
}

/**
 * The on-disk pointer, in whatever form the gene writes it. Removed once the text
 * it points at is on the page: a "the real thing is over there" note sitting above
 * the real thing is noise, and the path it names does not exist for a web reader.
 */
const POINTER = /^>[ \t]*Binding text:[^\n]*\n(?:>[^\n]*\n)*\n?/m;

const CANON_URL = "https://known.life/book/law/the-laws";

/**
 * A Book II commentary chapter, with its Law's clauses rendered in where the
 * pointer to them used to be. Any other page is returned untouched — this is a
 * scope test (does this page comment on a Law?), not a fallback: a chapter that
 * DOES declare a Law and cannot be matched to one throws rather than quietly
 * rendering commentary with nothing to comment on.
 */
export function withBindingText(body, spineFile) {
  const id = declaredLaw(body);
  if (id === null) return String(body);

  const { groups } = readLaws(spineFile);
  const law = groups.find((g) => g.key === id);
  if (!law) throw new Error(`law-binding: chapter declares ⚖${id}, but the laws gene has no group '${id}'`);

  const block = [
    "",
    `> **⚖${law.key} — the binding text**, rendered from the \`laws\` gene's own clause files:` +
      " the only source of truth, injected in full into every waking. Everything after" +
      ` the rule below is commentary. [The whole constitution →](${CANON_URL})`,
    "",
    law.clauses.map((c) => `- **${c.id}** ${c.body}`).join("\n"),
    "",
    "---",
    "",
  ].join("\n");

  return String(body)
    .replace(POINTER, "")
    .replace(/^(#[ \t]+⚖[a-z0-9-]+[ \t]*·[^\n]*\n)/m, `$1${block}`);
}
