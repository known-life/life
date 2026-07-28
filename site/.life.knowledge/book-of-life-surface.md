---
summary: "How known.life/book is built — the Book of Life rendered from the life-guide and laws genes rather than authored here: the content collections, the derived canon (no table of contents anywhere), the two editions (page + .md twin), the file-link rewrite, why every surface around the book derives its size too (and /llms.txt became an endpoint), why the Accept negotiation was tried and dropped, and where the old /docs pages went."
---

# The /book surface — rendering the canon, not copying it

`known.life/book` is the Book of Life: the canon of the Life protocol and its
normative spec, in six books. **None of it is authored in this repo.** Every
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
| `src/pages/llms.txt.ts` + `src/data/llms.txt` | The agent index. The prose is plain text beside the endpoint; the endpoint's only job is to fill `{{books}}` from the real canon. |
| `test/book.test.ts` | Gates the convention both halves depend on: the source shape, every cross-link resolving, the rewrite's exact inverse cases, and that no `.astro` page writes the canon's size down. |

`site/.life` imports both genes, so `.life.lock` pins *which edition of the canon
this deployment serves*, and the existing `deploy_inputs: .life.lock` redeploys
the worker when either pin moves. The gene's own publish gate holds the same
shape at publish time; `test/book.test.ts` holds it for the vendored copy this
worker actually builds from — a different moment, and a different failure (a
stale `.genome/` renders a book the pool has moved past).

## Nothing outside the book states its shape either

Deriving the index was only half of it. Four surfaces *around* the book wrote the
canon's shape down in prose — the `/book` meta description and frontispiece, the
`/docs` on-ramp paragraph and its "where to read what" table, the docs sidebar,
and `/llms.txt` — and when Book VI landed, two of them said **five books** while
the book beside them rendered six. That is the same failure the index is built to
be immune to, one layer out.

All four now read `canonSize()` / `canonPhrase()` from `src/lib/book.ts`, and
`/llms.txt` moved from `public/` (a static file, unable to interpolate) to a
prerendered endpoint over the same prose. `test/book.test.ts` holds it: **no
`.astro` file may contain a book count at all.** The rule is deliberately blunt —
a correct hand-written count is indistinguishable from one that has not gone
stale *yet*.

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
Practice ch7. The seven redirects are declared **once, in `src/middleware.ts`** —
and getting there cost two live failures worth recording, because both
framework-native routes look right and neither works on this deployment:

1. Astro's default emits `dist/_redirects`. Cloudflare documents that file for
   Workers static assets; here nothing parses it — all seven 404'd in production
   with the file sitting in the bundle.
2. `build: { redirects: false }` moves them into the SSR manifest instead. They
   404'd again — a `output: "static"` build has no handler behind the entry.

What holds is the seam this worker already runs on: **an asset miss falls through
to the middleware**, which is the only reason a gene page like `/laws` answers at
all. Declare a redirect where it actually runs. The general lesson, twice over:
this deployment's asset layer does less than the docs promise, so anything
resting on it (`_redirects`, `run_worker_first`) must be verified live before it
is believed — and a config that lies is worse than no config (Law 5.10).

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
