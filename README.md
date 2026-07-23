# Life

A repo convention for agent-legible infra.

Add a `.life` file to any directory and an agent knows what it does, what it needs, and what commands are safe to run.

## Get started

You don't install Life by hand — you tell your coding agent to become it. In any repo:

> **Read known.life and make this repo Life-aware.**

The agent fetches the instructions ([known.life/install.txt](https://known.life/install.txt)) and does the rest: drops in the engine and writes a `.life` manifest. The human types nothing. (The equivalent one-liner, if you'd rather run it yourself:)

```sh
curl -fsSL https://known.life/install.sh | sh
```

It leaves the repo root clean — the root holds the `.life` manifest, its
`.life.lock` (the install lock, npm-style), and the `.life.engine` binary;
installed genes live under `.genome/`:

```
.life                          # the root .life file (the manifest)
.life.lock                     # the install lock (once you import genes), sibling to .life
.life.engine                   # the engine binary (loads adapters, bundles none)
.genome/
  claude-code/                 # the harness adapter — a gene, like any other
  <gene>/                      # imported genepool genes
```

That's the entire footprint. Any directory can add a `.life` file to participate.

From "Life-aware" you can go fully **alive** — own lifekey identity, a private secrets vault, a baseline genome of [genes](https://known.life/explore) — with one agent-driven `life setup`: **sign in with GitHub once and approve one Cloudflare consent** (no token to create or paste, no account-id). Setup deploys a private secrets vault, generates an Ed25519 lifekey and **enrols its public half at known.life** (keyed by your repo, proven by the GitHub sign-in — no SSH paste to do by hand), and installs the baseline genome. No long-lived cloud token is ever held: Cloudflare is captured once via OAuth and brokered from known.life per-need, so the vault stores only the lifekey. After that, every session authenticates itself: the vault re-opens via a **tokenless `/exchange`** (the session proves it can push the repo — no credential is held in the session), and genepool writes are **signed by the lifekey**. One sign-in, one consent, set up once, forever. Full walkthrough: [known.life/docs/getting-started](https://known.life/docs/getting-started).

## The .life file

```yaml
name: blog
summary: Static essay site

requires:
  - infra.compute
  - infra.route: public

commands:
  build:
    run: pnpm build
  dev:
    run: pnpm dev

tests:
  - pnpm build

---

# Blog
Deploy is push-to-main.
```

YAML frontmatter for machines. Markdown body for agents.

## Commands

`life` is on PATH (a SessionStart hook prepends `.genome`), so commands
are bare from the agent's shell.

```
# repo — orient, look up, verify, keep in sync
life status                  # what's here, what's connected, what's missing (--json for the full index)
life ask <name|path|cap>     # look up anything — local, installed, on known.life, or the engine itself
life test [dir]              # verify against reality (--remote smoke-tests a deployed dir)
life <gene> <command>        # run a command a gene adds (life <gene> lists them)
life evolve                  # pull engine + deps + regen harness (runs automatically each session)

# genes (known.life genepool)
life inherit [src]           # resolve imports: (known.life/<name>) into .genome/ (--refresh re-resolves floats)
life mutate <dir>            # publish a new version of a gene (lifekey-signed; --reserve to claim a name only)
life lifekey show            # your identity (the Ed25519 lifekey publishes are signed with)

# infra
life connect <name>          # connect infra (cloudflare)
life deploy <dir>            # deploy via infra provider
life teardown <dir>          # destroy infra (--confirm)
```

## How it works

- **Capabilities** — directories declare `requires` and `provides`. The engine resolves the graph.
- **Infra** — `infra.compute`, `infra.datastore`, etc. The engine translates to vendor resources. The agent never names vendor products.
- **Genes** — capabilities are published to and resolved from the [known.life](https://known.life) genepool (`imports: known.life/<name>@<version>`). The genepool is the source of truth — genes don't live in this repo.
- **Identity** — writes (`mutate`) are signed by your **lifekey**: an Ed25519 key whose public half is **enrolled at known.life** (keyed by your repo, proven at setup by GitHub push access — the dedicated key `setup` generates and enrols for you). No password, no API key, no publish key to store — a signed challenge against the enrolled key is the only credential.
- **Harness / infra / repo are adapters — and adapters are genes.** The engine bundles none of them; it ships only the adapter *contract* and loads whatever adapter genes are installed in `.genome/` (`claude-code`, `codex`, `cloudflare`, `github`, …). Adding a provider is publishing a gene, not releasing the engine.
- **Tests** — the failing test is the product.

## Source

Fully open source. This repo is the live source of [known.life](https://known.life): the genepool registry worker and docs site live in [`site/`](site/), and the installer is [`install.sh`](install.sh). The engine is itself a gene — read it with `life fetch life` (or browse [`known.life/life`](https://known.life/life)). Issues are welcome.
