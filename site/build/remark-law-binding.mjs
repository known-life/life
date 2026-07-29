import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { withBindingText, declaredLaw } from "./law-binding.mjs";

/**
 * The rendered half of `law-binding.mjs`: Book II's commentary chapters get the
 * Law they comment on rendered into the page, in place of the on-disk pointer to
 * it. See that file for why — this one only carries the text into Astro's
 * markdown pipeline.
 *
 * The `.md` edition needs no plugin (`src/lib/book.ts` transforms the body it
 * serves), so both editions run the same function over the same source and the
 * page cannot show a clause the markdown twin does not.
 */
const LAWS = fileURLToPath(new URL("../../.genome/laws/LAWS.md", import.meta.url));

/** Only the canon's own chapters — a docs page that happened to say "Law 3" is not one. */
const isCanonChapter = (file) =>
  /\.life\.knowledge[\\/]/.test(String(file?.path ?? file?.history?.[0] ?? ""));

export function remarkLawBinding() {
  // unified calls an attacher with the processor as `this`, which is how the
  // inserted markdown gets parsed by the very same parser as the page around it
  // rather than by a second one that would drift from it.
  const processor = this;
  const lawsText = readFileSync(LAWS, "utf8");

  return (tree, file) => {
    if (!isCanonChapter(file)) return;

    const source = String(file.value ?? "");
    if (declaredLaw(source) === null) return;

    const rendered = withBindingText(source, lawsText);
    if (rendered === source) return;

    tree.children = processor.parse(rendered).children;
  };
}
