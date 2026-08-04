---
summary: "How known.life/book renders the Book of Life from the life-guide and laws genes instead of copying it: derived canon with no table of contents, page + .md twin editions, file-link rewrite, Book II commentaries with clauses rendered in via the laws gene's own reader, genome resolved by walk-up."
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
| `build/law-binding.mjs` + `build/remark-law-binding.mjs` | Book II's commentary chapters, given the text they comment on — see below. |
| `src/pages/llms.txt.ts` + `src/data/llms.txt` | The agent index. The prose is plain text beside the endpoint; the endpoint's only job is to fill `{{books}}` from the real canon. |
| `test/book.test.ts` | Gates the convention both halves depend on: the source shape, every cross-link resolving, the rewrite's exact inverse cases, and that no `.astro` page writes the canon's size down. |

`site/.life` imports both genes, so `.life.lock` pins *which edition of the canon
this deployment serves*, and the existing `deploy_inputs: .life.lock` redeploys
the worker when either pin moves. The gene's own publish gate holds the same
shape at publish time; `test/book.test.ts` holds it for the vendored copy this
worker actually builds from — a different moment, and a different failure (a
stale `.genome/` renders a book the pool has moved past).

## Book II shows the clauses, it does not point at them

The seventeen commentary chapters of Book II open the same way — `# law/<key> ·
<emoji> <title>`, then a pointer: *"Binding text: `.genome/laws/laws/`, law/<key> —
the only source of truth. This is commentary."* On disk that is exactly right; an
agent reading the gene has the clause files a path away. **On the web it is a
dead end.** The book shipped for months with pages arguing about clauses they
never showed, and the only thing offered instead was a filesystem path a browser
cannot open. `/book/law/the-laws` had the whole constitution, but nothing carried
a reader from the commentary on law:verify to law:verify itself.

`build/law-binding.mjs` swaps the pointer for the thing it points at. It parses
nothing: the `laws` gene's `readLaws(spineFile)` walks its own spine and clause
files and hands back `{header, groups}`, and this file renders what comes out.
That is not a convenience — this file used to carry a hand-ported copy of the
gene's parser, the split to one-clause-per-file landed, and the copy went on
decoding a shape that no longer existed. One format, one reader.

It matches each chapter to the group its H1 declares and renders that group's
clauses in where the pointer was, closed by a rule. So the page reads: title,
binding text, `---`, commentary.

Two things make this a rendering rather than the second copy the whole surface
exists to avoid. The clauses are read from the `laws` gene at build time and
authored nowhere — not here, not in `life-guide`. And the join is derived: the
chapter's own H1 says which group it comments on, so a chapter added or a clause
re-ranked needs nothing here. It is a **permanent slug**, never a position —
law:go-and-look survives a rewording, a re-rank, or a move between groups, which is
the whole point of the clause-file scheme. `test/law-binding.test.ts` holds the
join — every chapter finds its group, a page carries no other group's clauses,
and a chapter naming a group that does not exist **throws** rather than rendering
commentary with nothing to comment on. The cases pin the join and never the
format; an ordinal assertion here would re-introduce the exact coupling the
permanent slugs exist to remove.

The return trip is the other half of the same seam. `/book/law/the-laws` is the
one page that holds every Law and every clause, and it was a wall you could read
but not leave — sixteen commentaries linked *to* it and nothing linked back. Each
law heading now carries a drill-down to its commentary, derived the same way in
reverse (`commentarySlugs()`: the chapter's filename gives the URL, its H1 gives
the clause id), and a Law nothing comments on simply gets no link rather than a
dead one. **The `.md` editions differ here on purpose**: the binding text is
content, so the markdown twin carries it, but the drill-down is navigation, and
`/book/law/the-laws.md` is the constitution as an agent should receive it — every
clause the session wall carries, with no inserted links to read past.

That page is itself a rendering now, not a file. `LAWS.md` is a **spine** —
frontmatter naming the groups in order, over an opening body — so echoing it puts
the framing on screen with no law under it, which is what the page did for the
first hour after the split. `constitutionMarkdown()` builds it from `readLaws`:
groups in spine order, clauses in rank order, the drill-down inserted per group
for the page edition and omitted for the twin.

One transform, two pipelines, because the editions are compiled differently:
`src/lib/book.ts` applies it to every chapter body (`Chapter.markdown`, which is
the whole `.md` edition), and `remark-law-binding.mjs` applies it inside Astro's
markdown compile. Both call the same function over the same source, so the two
editions cannot disagree about the constitution either. The remark half runs
*first* in `astro.config.mjs` — it re-parses the page it rewrites, so it must not
land on a tree `remarkCanonLinks` has already edited.

**A `build/` file must never write `../../.genome` against its own location.**
`build/` is called from both pipelines, and they resolve paths from different
places: the remark half runs unbundled from source, but `src/lib/book.ts` is
compiled into the worker and Astro prerenders it from `dist/_worker.js/chunks/`,
where every `../..` lands inside `dist/`. A path that is right in vitest and in
remark is wrong in the build, which is how the un-fork shipped eleven red deploys
behind 450 green tests. `law-binding.mjs` resolves the genome once, by walk-up —
`genomeRoot(process.cwd())`, the `genome` gene's own resolver — and exports
`LAWS_SPINE` and `COMMENTARY_DIR` for everything else to import. Gene *code* can
be reached by static import (the bundler follows it and inlines it, as
`middleware.ts` does with `registry` and `viewer`), but a CommonJS gene ending in
`require.main === module` cannot: that guard survives as an undefined `require`
in ESM scope, so require it at the resolved path instead. Gene *data* — the
clause files — can never be inlined and always needs the walk-up.

That is also why `site/.life` runs `npm run build` inside its test command. The
suite must run the build it vouches for; nothing else in the rail executes
`build/` the way the deploy does.

**Verifying a remark change locally needs `rm -rf .astro dist` first.** Astro's
content layer caches rendered markdown, so a plugin edit with no source edit
rebuilds from the cache and the change silently does not appear — which reads
exactly like a plugin that does not fire. CI never hits this (fresh checkout); a
session checking its own work does, every time.

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
is believed — and a config that lies is worse than no config (law:lying-signal).

**Governance stayed site-side**, at `/docs/governance`. It is *this registry's*
operating policy — namespace rules, operator scope, takedowns — not the protocol,
and it does not belong in a gene every `.life` inherits (law:lift-not-copy: publish the
generic shape, keep what is only yours). The registry protocol chapter links out
to it rather than absorbing it.

## Changing the book

Never here. `life edit life-guide` → edit the chapter → `life mutate life-guide`
→ `life evolve`, and the site picks it up on the next deploy. The same for the
Laws via the `laws` gene. If a change to the canon requires a change in `site/`,
that is the signal something has been hard-coded that should have been derived.

## Summary (unabridged)

How known.life/book is built — the Book of Life rendered from the life-guide and laws genes rather than authored here: the content collections, the derived canon (no table of contents anywhere), the two editions (page + .md twin), the file-link rewrite, how Book II's commentaries get the Law's binding text rendered in instead of a filesystem path (through the laws gene's own reader — this file carried a hand-ported copy of that parser and it cost a red deploy), why a build/ file must resolve the genome by walk-up rather than against its own location, why every surface around the book derives its size too (and /llms.txt became an endpoint), why the Accept negotiation was tried and dropped, and where the old /docs pages went.
