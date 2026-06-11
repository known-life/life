import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "./types";

/**
 * Fitness check — ADVISORY. Adapted from slices' tier2.ts (same Haiku call,
 * same single-line-JSON contract). Unlike slices, the verdict never blocks a
 * publish: it sets the gene's badge (`verified` vs `scanned`) and surfaces
 * notes the publishing agent can act on. The hard gate is scan.ts; this is the
 * "does the contract match the contents, is it coherent and installable" read.
 */

export interface FitResult {
  verdict: "verified" | "scanned"; // verified = coherent; scanned = passed scan but fit unsure
  notes: string[];
  reasoning?: string;
}

export async function checkFit(
  env: Env,
  manifest: { name: string; contract: string; requires: string[]; provides: string[] },
  files: { path: string; content: string }[],
): Promise<FitResult> {
  if (!env.ANTHROPIC_API_KEY) {
    return { verdict: "scanned", notes: [], reasoning: "ANTHROPIC_API_KEY not configured; fit skipped." };
  }

  const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  const tree = files
    .map((f) => `### ${f.path}\n\n${f.content.slice(0, 3000)}`)
    .join("\n\n")
    .slice(0, 24000);

  const prompt = `You are a fitness reviewer for known.life, a genepool for units of ".life" (agent capability genes).

The gene being published:
- name: ${manifest.name}
- declares provides: ${JSON.stringify(manifest.provides)}
- declares requires: ${JSON.stringify(manifest.requires)}
- contract / manifest body:
---
${manifest.contract.slice(0, 4000)}
---

Its files:

${tree}

Judge whether this is a coherent, installable .life gene whose NAME and contract match its contents. A good gene: its name semantically fits what it does (an agent browsing the genepool should be able to trust that "${manifest.name}" describes these files), it does what its contract claims, declares the capabilities it actually provides/requires, and has no obvious incoherence or scope confusion. If the name is misleading relative to the contents, note it and withhold "verified". This is ADVISORY — be encouraging; only withhold "verified" when there's a real mismatch (name↔content or contract↔content).

Return ONLY a JSON object on a single line, no other text:
{"verdict":"verified"|"scanned","notes":["..."]}`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 600,
      messages: [{ role: "user", content: prompt }],
    });
    const text = response.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
      .trim();
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return { verdict: "scanned", notes: [], reasoning: `non-JSON: ${text.slice(0, 200)}` };
    const parsed = JSON.parse(m[0]);
    return {
      verdict: parsed.verdict === "verified" ? "verified" : "scanned",
      notes: Array.isArray(parsed.notes) ? parsed.notes : [],
      reasoning: parsed.reasoning,
    };
  } catch (err) {
    return {
      verdict: "scanned",
      notes: [],
      reasoning: `fit error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
