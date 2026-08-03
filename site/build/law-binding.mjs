import { createRequire } from "node:module";
import path from "node:path";
// CommonJS: `module.exports = {…}` names nothing to an ESM importer, so the
// default IS the exports object.
import genomeGene from "../../.genome/genome/bin/gene.cjs";

const { genomeRoot } = genomeGene;

/**
 * Book II's commentary chapters, given the text they comment on.
 *
 * Each chapter in `02-law/` opens `# <mark><id> · <emoji> <title>` and
 * then a pointer — "Binding text: `.genome/laws/LAWS.md`" — before the commentary
 * starts. That pointer is right on disk, where an agent reading the gene has the
 * clause files a path away. On the web it is a dead end: the reader is given a
 * filesystem path they cannot open, so the page discusses clauses it never shows.
 * This swaps the pointer for the thing it points at.
 *
 * It is a rendering, not a copy: the `laws` gene reads its own clause files
 * (`readLaws`) and this hands back what comes out, so the format has exactly one
 * reader and no law text is authored here or in `life-guide`.
 *
 * One rule, two pipelines: `src/lib/book.ts` applies it to every chapter body,
 * which is the whole `.md` edition, and `remark-law-binding.mjs` applies it to
 * the markdown Astro compiles into pages. Both call the function below, so the
 * two editions cannot disagree about the binding text either.
 */

/**
 * The genome, by walk-up rather than by depth.
 *
 * This module's own location is not an anchor: Astro prerenders the book from
 * `dist/_worker.js/chunks/`, so anything written `../../.genome` against this
 * file resolves inside `dist/` and reads nothing — which is exactly how the
 * un-fork of this file first shipped, and it reddened the deploy. The `genome`
 * gene owns finding a genome; the build always runs inside the repo, so walking
 * up from its own directory is the one anchor the bundler cannot move.
 */
const GENOME = genomeRoot(process.cwd());
if (!GENOME) throw new Error(`law-binding: no .genome above ${process.cwd()}`);

/**
 * The `laws` gene reads its own format — this file must never parse it again.
 * Required at its resolved path rather than imported: the hook ends in a
 * `require.main === module` self-run guard, which is correct CommonJS and
 * survives bundling as an undefined `require` in ESM scope.
 */
const { readLaws } = createRequire(import.meta.url)(
  path.join(GENOME, "laws", "hooks", "session-start-inject.js"),
);

/** The spine the `laws` gene parses; its clause files sit beside it in `laws/`. */
export const LAWS_SPINE = path.join(GENOME, "laws", "LAWS.md");

/** Book II's commentary chapters, in the `life-guide` gene. */
export const COMMENTARY_DIR = path.join(GENOME, "life-guide", ".life.knowledge", "02-law");

/**
 * The clause a commentary chapter declares — the sigil-prefixed `<id>` in its H1,
 * the permanent
 * id the `laws` gene keys a group by. An id, not a position: a Law can be reworded,
 * re-ranked, or moved and every citation ever written still resolves.
 */
export function declaredLaw(body) {
  // The SIGIL is not pinned here. It is the laws gene's presentation choice and it
  // has changed; a copy of it in this file is a second source that drifts silently
  // and takes the whole join down with it (※derive-dont-maintain). What is stable
  // is the SHAPE — one leading mark, the clause id, the middot — so match that and
  // let the mark be whatever the gene renders.
  const m = String(body).match(/^#[ \t]+[^\s\w]?([a-z0-9-]+)[ \t]*·/mu);
  return m ? m[1] : null;
}

/**
 * Clause id → the slug of the chapter that comments on it, derived from the
 * commentary chapters themselves: the filename gives the URL (the canon's
 * `<ordinal>-<slug>` rule), the H1 gives the clause. No table, so a chapter
 * renamed or a Law re-ranked needs nothing here — and a Law with no commentary
 * yet simply has no entry, which is the honest state rather than a dead link.
 *
 * This is the return trip. `withBindingText` carries the constitution INTO the
 * commentary; this carries a reader from the constitution OUT to it, so the one
 * page that holds every Law and every clause is also where you drill down from.
 */
export function commentarySlugs(chapters) {
  const slugs = new Map();
  for (const { file, body } of chapters) {
    const id = declaredLaw(body);
    if (id !== null) slugs.set(id, file.replace(/^\d+-/, "").replace(/\.md$/, ""));
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
export function withBindingText(body, spineFile = LAWS_SPINE) {
  const id = declaredLaw(body);
  if (id === null) return String(body);

  const { groups } = readLaws(spineFile);
  const law = groups.find((g) => g.key === id);
  if (!law) throw new Error(`law-binding: chapter declares ※${id}, but the laws gene has no group '${id}'`);

  const block = [
    "",
    `> **※${law.key} — the binding text**, rendered from the \`laws\` gene's own clause files:` +
      " the only source of truth, injected in full into every waking. Everything after" +
      ` the rule below is commentary. [The whole constitution →](${CANON_URL})`,
    "",
    law.clauses.map((c) => `- **${c.slug}** ${c.body}`).join("\n"),
    "",
    "---",
    "",
  ].join("\n");

  return String(body)
    .replace(POINTER, "")
    // Same reason as declaredLaw: match the SHAPE, not the gene's current mark.
    .replace(/^(#[ \t]+[^\s\w]?[a-z0-9-]+[ \t]*·[^\n]*\n)/mu, `$1${block}`);
}

/**
 * The constitution itself — the one page that holds every Law and every clause.
 *
 * `LAWS.md` alone will not do it any more: since the split to one-file-per-clause
 * it is a SPINE, frontmatter naming the groups in order over an opening body, and
 * a page rendered from it shows the framing with no law under it. So the page is
 * rendered the way the session wall is, from the gene's own `readLaws` — spine
 * order for the groups, rank order within each — and the web edition cannot say
 * something the injected constitution does not.
 *
 * `slugs` (from `commentarySlugs`) adds the drill-down out to each Law's
 * commentary chapter. The markdown twin passes none: `/book/law/the-laws.md` is
 * the constitution as an agent should receive it, with no inserted links to read
 * past — while the page without them is a wall you can read but not leave.
 */
export function constitutionMarkdown(slugs = new Map(), spineFile = LAWS_SPINE) {
  const { header, groups } = readLaws(spineFile);
  if (!groups.length) throw new Error(`law-binding: the laws gene read no groups from ${spineFile}`);

  const out = [header, ""];
  for (const g of groups) {
    out.push(`## ※${g.key} ${g.emoji} ${g.title}`, "");
    const slug = slugs.get(g.key);
    if (slug) {
      out.push(
        `<p class="law-drill"><a href="/book/law/${slug}">Commentary on ※${g.key}` +
          " — what it means in practice, and the failure it prevents →</a></p>",
        "",
      );
    }
    out.push(g.clauses.map((c) => `- **${c.slug}** ${c.body}`).join("\n"), "");
  }
  return out.join("\n");
}
