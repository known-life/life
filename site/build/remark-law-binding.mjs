import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  withBindingText,
  declaredLaw,
  commentarySlugs,
  constitutionMarkdown,
  COMMENTARY_DIR,
} from "./law-binding.mjs";

/**
 * The rendered half of `law-binding.mjs`, both directions of the same seam.
 *
 * IN — a commentary chapter gets the Law it comments on rendered into the page,
 * in place of the on-disk pointer to it. See that file for why.
 *
 * OUT — the constitution itself (`/book/law/the-laws`, the one page that holds
 * every Law and every clause) gets a drill-down under each law heading, to the
 * chapter that comments on it. Without it that page is a wall you can read but
 * not leave: sixteen commentaries linked to it and nothing linked back.
 *
 * The `.md` editions differ here on purpose. The IN transform is content, so
 * `src/lib/book.ts` applies it to the markdown twin too and the two editions
 * carry the same clauses. The OUT one is a navigation affordance, and
 * `/book/law/the-laws.md` is the constitution as an agent should receive it —
 * every clause the session wall carries, with no inserted links to read past.
 */
/** Only the canon's own chapters — a docs page that happened to cite a clause is not one. */
const isCanonChapter = (file) => /\.life\.knowledge[\\/]/.test(pathOf(file));
const isConstitution = (file) => /laws[\\/]LAWS\.md$/.test(pathOf(file));
const pathOf = (file) => String(file?.path ?? file?.history?.[0] ?? "");

export function remarkLawBinding() {
  // unified calls an attacher with the processor as `this`, which is how the
  // inserted markdown gets parsed by the very same parser as the page around it
  // rather than by a second one that would drift from it.
  const processor = this;
  const slugs = commentarySlugs(
    readdirSync(COMMENTARY_DIR)
      .filter((file) => /^\d+-.*\.md$/.test(file))
      .map((file) => ({ file, body: readFileSync(join(COMMENTARY_DIR, file), "utf8") })),
  );

  return (tree, file) => {
    if (isConstitution(file)) {
      tree.children = processor.parse(constitutionMarkdown(slugs)).children;
      return;
    }

    if (!isCanonChapter(file)) return;

    const source = String(file.value ?? "");
    if (declaredLaw(source) === null) return;

    const rendered = withBindingText(source);
    if (rendered === source) return;

    tree.children = processor.parse(rendered).children;
  };
}
