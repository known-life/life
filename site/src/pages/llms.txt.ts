import type { APIRoute } from "astro";
import source from "../data/llms.txt?raw";
import { getCanon, canonSize } from "../lib/book.ts";

/**
 * `/llms.txt` — the agent index. The prose lives beside this file as plain text
 * (`src/data/llms.txt`) so it stays editable as prose; the one thing this
 * endpoint does is fill `{{books}}` from the real canon.
 *
 * It used to be a static asset in `public/`, with the books listed by hand. That
 * list said "five books" for as long as there were six — the same failure the
 * book index is built to be immune to (law/derive-dont-maintain). Anything here that restates
 * the canon's shape must be derived, or it must not be here.
 */
export const GET: APIRoute = async () => {
  const canon = await getCanon();
  const glossed = canon
    .map((b) => `${b.title} (${b.blurb.replace(/^./, (c) => c.toLowerCase()).replace(/\.$/, "")})`)
    .join(", ");
  const body = source.replace("{{books}}", `${await canonSize()}: ${glossed}`);
  if (body.includes("{{")) throw new Error("llms.txt: unfilled placeholder");

  return new Response(body, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
};
