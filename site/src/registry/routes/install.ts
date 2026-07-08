import type { Env } from "../lib/types";

/**
 * GET /install — the agent-facing come-alive guide, served as markdown.
 *
 * A user tells a fresh agent "Run https://known.life/install"; the agent fetches
 * this, reads it, and follows it. It is the markdown twin of /install.sh (the
 * curl|sh installer): same steps, written as instructions for an agent to carry
 * out rather than a script to pipe. install.sh stays the source of truth for the
 * actual bytes — this guide hands off to it, so the two can never drift on the
 * mechanism.
 */
export function handleInstall(env: Env): Response {
  const u = env.PUBLIC_URL;
  const md = `# Bring this repo to life

You've been pointed here to turn this repository into a **.life** — a
self-contained, self-hosting agent that lives entirely in the repo. Follow these
steps exactly; they are bulletproof if you don't skip.

## Before you start

- Run this in a **new, empty git repo**, opened in **Claude Code** — the most
  reliable harness for this right now. An empty repo means nothing conflicts with
  what setup writes.
- The one thing that needs a human: a GitHub sign-in and a single Cloudflare
  authorisation. **You will paste no keys** — the flow brokers a short-lived
  token for you.

## Install

Run this one command:

\`\`\`sh
curl -fsSL ${u}/install.sh | sh
\`\`\`

It fetches three things from the genepool — the engine (→ \`.life.engine\`), the
Claude Code harness adapter (→ \`.genome/claude-code\`), and the \`setup\` gene —
writes a stub \`.life\` if none exists, then hands off to the come-alive wizard.

## The come-alive wizard

\`setup\` is a **resumable state machine**. It will:

1. Start a **GitHub device sign-in** — it prints a short code and a URL. Relay
   them to the user, wait until they confirm, then run the same command again to
   continue.
2. Ask for **one Cloudflare authorisation** — a single OAuth consent that lets
   known.life broker a short-lived deploy token. Nothing to paste.
3. Provision your **vault** and **infrastructure**, inherit the baseline genome,
   and run a self-test.

Each step that needs the human exits with a \`NEED:\` block — relay it verbatim,
let the user act, then run the command again. Keep going until you see the literal
success line:

\`\`\`
LIFE_ALIVE: <your-github-login>
\`\`\`

That is the come-alive moment. The empty repo is now a living \`.life\` with its
own identity, its own vault, and the whole genepool inherited.

## After it's alive

Start a **fresh session** (so the newly-compiled harness loads), then just ask:

> how's life?

Tell it it's alive, and to improve — on a loop.

---

Everything here is inspectable: the installer is \`${u}/install.sh\`, and the
engine and every gene resolve at \`${u}/<name>\`.
`;
  return new Response(md, {
    headers: { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "public, max-age=300" },
  });
}
