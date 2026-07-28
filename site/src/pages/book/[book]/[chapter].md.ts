import type { APIRoute } from "astro";
import { getCanon } from "../../../lib/book.ts";
import { chapterMarkdown } from "../../../lib/book-markdown.ts";

export async function getStaticPaths() {
  const canon = await getCanon();
  return canon.flatMap((book) =>
    book.chapters.map((chapter) => ({
      params: { book: book.slug, chapter: chapter.slug },
      props: { book, chapter },
    })),
  );
}

/** One chapter, verbatim — the same bytes the gene ships. */
export const GET: APIRoute = async ({ props }) =>
  new Response(chapterMarkdown(props.book, props.chapter), {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
