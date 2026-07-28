import type { APIRoute } from "astro";
import { canonMarkdown } from "../lib/book-markdown.ts";

/** The whole canon in one fetch — the agent edition of `known.life/book`. */
export const GET: APIRoute = async () =>
  new Response(await canonMarkdown(), {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
