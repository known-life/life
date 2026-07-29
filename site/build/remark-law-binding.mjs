import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { withBindingText, declaredLaw, commentarySlugs } from "./law-binding.mjs";

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
 * byte for byte what `LAWS.md` says, with no sixteen inserted links to read past.
 */
const GENOME = new URL("../../.genome/", import.meta.url);
const LAWS_FILE = fileURLToPath(new URL("laws/LAWS.md", GENOME));
const COMMENTARY_DIR = fileURLToPath(new URL("life-guide/.life.knowledge/02-law/", GENOME));

/** Only the canon's own chapters — a docs page that happened to say "Law 3" is not one. */
const isCanonChapter = (file) => /\.life\.knowledge[\\/]/.test(pathOf(file));
const isConstitution = (file) => /laws[\\/]LAWS\.md$/.test(pathOf(file));
const pathOf = (file) => String(file?.path ?? file?.history?.[0] ?? "");

/** A heading's plain text, for reading the `N.` ordinal off `## 1. 🔒 You evolve…`. */
function headingText(node) {
  let out = "";
  const walk = (n) => {
    if (typeof n.value === "string") out += n.value;
    (n.children ?? []).forEach(walk);
  };
  walk(node);
  return out;
}

export function remarkLawBinding() {
  // unified calls an attacher with the processor as `this`, which is how the
  // inserted markdown gets parsed by the very same parser as the page around it
  // rather than by a second one that would drift from it.
  const processor = this;
  const lawsText = readFileSync(LAWS_FILE, "utf8");
  const slugs = commentarySlugs(
    readdirSync(COMMENTARY_DIR)
      .filter((file) => /^\d+-.*\.md$/.test(file))
      .map((file) => ({ file, body: readFileSync(COMMENTARY_DIR + file, "utf8") })),
  );

  return (tree, file) => {
    if (isConstitution(file)) {
      // Walk backwards: every insertion shifts the indices after it.
      for (let i = tree.children.length - 1; i >= 0; i--) {
        const node = tree.children[i];
        if (node.type !== "heading" || node.depth !== 2) continue;
        const n = Number(headingText(node).match(/^(\d+)\./)?.[1]);
        const slug = slugs.get(n);
        if (!slug) continue;
        tree.children.splice(i + 1, 0, {
          type: "html",
          value: `<p class="law-drill"><a href="/book/law/${slug}">Commentary on Law ${n} — what it means in practice, and the failure it prevents →</a></p>`,
        });
      }
      return;
    }

    if (!isCanonChapter(file)) return;

    const source = String(file.value ?? "");
    if (declaredLaw(source) === null) return;

    const rendered = withBindingText(source, lawsText);
    if (rendered === source) return;

    tree.children = processor.parse(rendered).children;
  };
}
