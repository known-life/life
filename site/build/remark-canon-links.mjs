import { visit } from "unist-util-visit";

/**
 * Chapters of the Book of Life link to each other the way files do — the gene's
 * pages are read from disk by agents as often as from the web, so a chapter says
 * `[the shape of the tree](../03-practice/04-shape-of-the-tree.md)` and that link
 * has to work in a terminal. This rewrites those file links to their web
 * addresses at render time.
 *
 * It is a translation, not a mapping table: the same `<ordinal>-<slug>` rule the
 * canon is derived from (src/lib/book.ts) run backwards. So a chapter added or
 * renumbered in the gene needs nothing here.
 *
 * A link that does NOT resolve is left exactly as written rather than guessed at
 * — a visibly broken `.md` href in the page is a bug you can see, where a
 * silently rewritten wrong URL is one you cannot (law/fail-fast).
 */
const unordinal = (s) => s.replace(/^\d+-/, "");

/** `.../.life.knowledge/03-practice/09-building.md` → `03-practice`, or null. */
function bookDirOf(filePath = "") {
  const m = filePath.replace(/\\/g, "/").match(/\.life\.knowledge\/([^/]+)\//);
  return m ? m[1] : null;
}

export function remarkCanonLinks() {
  return (tree, file) => {
    const here = bookDirOf(file?.path ?? file?.history?.[0] ?? "");
    if (!here) return; // not a canon chapter — leave every link alone

    visit(tree, "link", (node) => {
      const m = String(node.url).match(/^\.{1,2}\/(?:([^/]+)\/)?([^/]+)\.md(#.*)?$/);
      if (!m) return;
      const [, dir, page, anchor = ""] = m;
      const book = unordinal(dir ?? here);
      node.url = page === "index" ? `/book/${book}${anchor}` : `/book/${book}/${unordinal(page)}${anchor}`;
    });
  };
}
