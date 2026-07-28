---
summary: "How known.life/book is built — the Book of Life rendered from the life-guide and laws genes rather than authored here: the content collections, the derived canon (no table of contents anywhere), the two editions (page + .md twin), the file-link rewrite, why the Accept negotiation was tried and dropped, and where the old /docs pages went."
---

# The /book surface — rendering the canon, not copying it

`known.life/book` is the Book of Life: the canon of the Life protocol and its
normative spec, in five books. **None of it is authored in this repo.** Every
chapter is a markdown page of the `known.life/life-guide` gene, and Book II's
first chapter is the `known.life/laws` gene's own `LAWS.md` — the same file that
is injected into every session in full. The site renders those genes; it holds no
copy of either.

That is the whole design constraint. A docs site that *describes* a spec drifts
from it — this repo proved it: `/docs/interface` still taught the open-world
manifest head that epoch 2 replaced, sitting a click away from a `life-guide`
gene that documented the real one. Rendering the gene removes the second source
rather than promising to keep it in step.

## The pieces

| file | what it does |
|---|---|
| `src/content.config.ts` | Two collections: `canon` (glob over `../.genome/life-guide/.life.knowledge/**/*.md`) and `scripture` (the two openings — `life-guide/ABOUT-LIFE.md` and `laws/LAWS.md` — which stay where they are because a hook and the constitution's injection read them there). |
| `src/lib/book.ts` | Derives the canon. **There is no table of contents in it and there must never be one:** book directories give the books, `<ordinal>-<slug>.md` gives chapter order and URL, each page's H1 gives its title, `index.md` is the book's preface. The only hand-written entries are the two openings, which are structural. |
| `src/lib/book-markdown.ts` | The machine edition — one chapter, one book, or the whole canon, assembled from the same entries the pages render. Everything it adds is a locator, never a restatement. |
| `src/pages/book/**` | The rendered edition (`Book.astro` layout — a serif measure, deliberately unlike `/docs`) plus the `.md` endpoints beside each page. |
| `build/remark-canon-links.mjs` | Chapters cross-link as *files* (`../05-spec/02-life-schema.md`), because agents read them from disk as often as from the web. This runs the naming rule backwards into `/book/spec/life-schema`. A link it cannot resolve is left visibly unrewritten rather than guessed at. |
| `test/book.test.ts` | Gates the convention both halves depend on: the source shape, every cross-link resolving, and the rewrite's exact inverse cases. |

`site/.life` imports both genes, so `.life.lock` pins *which edition of the canon
this deployment serves*, and the existing `deploy_inputs: .life.lock` redeploys
the worker when either pin moves. The gene's own publish gate holds the same
shape at publish time; `test/book.test.ts` holds it for the vendored copy this
worker actually builds from — a different moment, and a different failure (a
stale `.genome/` renders a book the pool has moved past).

## Two editions

Every chapter exists twice: the rendered page, and a prerendered markdown twin at
the same path + `.md`. `/book.md` is the whole canon in one fetch (~300KB), which
is the shape an agent actually wants. Both are generated from the same entries in
the same build, so the two editions cannot disagree.

**There is no `Accept` negotiation, and the attempt is worth recording.** The
first shape served both editions from one URL, choosing in the middleware — which
requires the Worker to run *ahead of* the asset layer (`run_worker_first`, via
`assets: dynamic:`). Shipped, it did not fire: `/book` with `Accept: */*` returned
HTML in production. Rather than keep a feature I could not verify, the `.md` URL
is the one canonical agent path — explicit, cacheable, linkable, and true.

## Where the old spec pages went

`/docs/spec/*`, `/docs/interface`, and `/docs/adapters/*` are now Book V and
Practice ch7. The redirects are declared once in `astro.config.mjs` with
`build: { redirects: false }`, which emits them as **worker routes**. The default
is a `dist/_redirects` asset file, and Cloudflare documents that for Workers
static assets — but on this deployment it is not applied: every legacy path 404'd
in production with the file sitting in `dist/` (verified live 2026-07-28). A
redirect that exists only in a file nothing reads is a lying config.

**Governance stayed site-side**, at `/docs/governance`. It is *this registry's*
operating policy — namespace rules, operator scope, takedowns — not the protocol,
and it does not belong in a gene every `.life` inherits (Law 9.4: publish the
generic shape, keep what is only yours). The registry protocol chapter links out
to it rather than absorbing it.

## Changing the book

Never here. `life edit life-guide` → edit the chapter → `life mutate life-guide`
→ `life evolve`, and the site picks it up on the next deploy. The same for the
Laws via the `laws` gene. If a change to the canon requires a change in `site/`,
that is the signal something has been hard-coded that should have been derived.
