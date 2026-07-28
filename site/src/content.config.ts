import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";

/**
 * The Book of Life is not authored here. Its chapters ARE the markdown files of
 * the `life-guide` gene, and its constitution IS the `laws` gene's LAWS.md — both
 * vendored into `.genome/` by `life evolve` and pinned in `.life.lock`, exactly
 * like the registry and viewer code this worker already builds from. Loading them
 * as collections means known.life renders the gene rather than a copy of it, so
 * the web edition cannot say something the gene does not (the whole point of
 * putting the book on the web at all).
 *
 * `site/.life` imports both genes so the dependency is real and pinned, and
 * `deploy_inputs: .life.lock` already redeploys this worker when either pin moves.
 */
const canon = defineCollection({
  loader: glob({
    base: "../.genome/life-guide/.life.knowledge",
    pattern: "**/*.md",
  }),
});

/**
 * The two chapters the canon renders from outside the knowledge tree, because
 * their files are load-bearing where they sit: `ABOUT-LIFE.md` is read by the
 * gene's SessionStart hook from the gene root, and `LAWS.md` is the binding text
 * the `laws` gene injects every turn. Rendering them here is what keeps Book I's
 * opening and Book II's first chapter from becoming second copies.
 */
const scripture = defineCollection({
  loader: glob({
    base: "../.genome",
    pattern: ["life-guide/ABOUT-LIFE.md", "laws/LAWS.md"],
    // Keep the id as the real path minus the extension. These two are addressed
    // by name in src/lib/book.ts, so a slugified id would silently rename the
    // constitution's entry the day its filename casing changed.
    generateId: ({ entry }) => entry.replace(/\.md$/, ""),
  }),
});

export const collections = { canon, scripture };
