import type { APIRoute } from "astro";
import { getCanon } from "../../lib/book.ts";
import { bookMarkdown } from "../../lib/book-markdown.ts";

export async function getStaticPaths() {
  const canon = await getCanon();
  return canon.map((book) => ({ params: { book: book.slug }, props: { book } }));
}

/** One book of the canon, preface and chapters, as plain markdown. */
export const GET: APIRoute = async ({ props }) =>
  new Response(bookMarkdown(props.book), {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
