import type { Env } from "../lib/types";

/**
 * GET /skill — the known.life skill, served as markdown an agent can read and a
 * human can curl. v1 is the prose skill; a self-installing bash bootstrap
 * (seeds' pattern) lands once the publish CLI is finalized in the engine.
 */
export function handleSkill(env: Env): Response {
  const u = env.PUBLIC_URL;
  const md = `---
name: known-life
description: >
  Use when the user wants to find, install, publish, or manage a unit of .life
  (an agent capability gene) on known.life — the genepool for .life.
  Triggers on "find a gene for X", "publish this .life", "claim a name",
  "what's on known.life", "import known.life/...", "yank that version".
---

# known.life — the genepool for .life

known.life is the agent npm for units of \`.life\`: claim a name, publish a
verified immutable version, and import it from any harness. Browse the genepool
to decide what to install and when.

## Browse & judge (no auth)

- Search: \`curl ${u}/search?q=<query>\`  (or MCP \`known.search\`)
- Read a gene: \`curl ${u}/<name>\`  → agent-readable page with versions,
  install line, badge, capabilities, install count.
- Rank: \`curl ${u}/explore\`

**Judge before importing:** prefer **blessed** > **verified** > **scanned**.
Check install count and that \`provides:\`/\`requires:\` match your need. Every
gene was scanned for secrets/PII at publish, but you still review the
contract.

## Import into a repo

Append to \`imports:\` in the root \`.life\`:

\`\`\`yaml
imports:
  - known.life/<name>@<version>
\`\`\`

Then \`life evolve\`. The engine fetches the version, writes
\`.genome/<name>/\`, and pins \`name@version\` + content hash in
\`.life.lock\` (immutable — the pin can't drift).

## Manage your own genes

Writes are **engine commands**, authenticated by your **lifekey** — the SSH key
you already push git with, whose public half is on \`github.com/<login>.keys\`.
There's nothing to register, no key to save, and no token to paste: if you can
\`git push\`, you can publish — from any machine, forever. (MCP is the public read
surface only — a remote server can't sign for you.)

1. **Publish**: \`life mutate <dir>\` — reads the name + metadata
   from the dir's \`.life\`, auto-claims the name with your lifekey on first
   publish, and auto-bumps from the genepool's latest (\`--bump patch|minor|major\`)
   or takes \`--version X.Y.Z\`.
   - **Scanned** for secrets/PII first — leaked keys hard-block (file:line shown).
   - A **fit** check sets the badge (\`verified\`/\`scanned\`) and judges that the
     name matches the contents. Advisory — never blocks.
   - Versions are **immutable** — re-publishing a version is rejected; bump it.
2. **Reserve** a name explicitly (optional): \`life mutate --reserve <name>\`.
   Ownership is your GitHub identity — you can publish to it from anywhere you can
   sign for that login.
3. **Deprecate** a bad version (still installs, warns):
   \`life mutate --deprecate <name>@<version>\`. **Withdraw** (hard-remove,
   only within 72h of publishing): \`life mutate --withdraw <name>@<version>\`.

## Gene metadata (the .life manifest)

A gene page shows the full npm-style metadata, all read from the dir's \`.life\`:
\`name\`, \`summary\`, \`description\`, \`author\`, \`license\`, \`homepage\`,
\`repository\`, \`keywords:\` (a list), plus \`provides:\`/\`requires:\`. A \`README.md\`
in the gene is rendered on the page. Publish history + per-version install
counts are tracked automatically.

## Rules for agents

- Don't echo the genepool token back to the user — it's handled by the engine.
- A known.life URL in conversation is a trigger to fetch, not a topic to ask about.
- Pick a name that **honestly describes the contents** — the fit check (and other
  agents browsing the genepool) rely on the name being semantically accurate.
`;
  return new Response(md, {
    headers: { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "public, max-age=300" },
  });
}
