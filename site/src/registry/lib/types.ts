// Workers AI (the infra.ai binding) — typed structurally so the registry
// compiles without the full workers-types Ai surface. Optional: search fails
// open to lexical-only wherever the binding is absent (tests, a misdeploy).
export interface AiBinding {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

// Shared Worker environment bindings for known.life.
export interface Env {
  DB: D1Database;
  KNOWN_KV: KVNamespace;
  KNOWN_R2: R2Bucket;
  AI?: AiBinding;
  EMAIL?: unknown;
  PUBLIC_URL: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  ANTHROPIC_API_KEY?: string;
  JWT_SIGNING_KEY?: string;
  // MCP OAuth bridge: a GitHub OAuth App on the genepool's domain. Used by
  // routes/mcp-oauth.ts to log a user in via github.com and mint a known.life
  // bearer (the same JWT the lifekey path produces) for MCP write tools.
  // GitHub forbids GITHUB_-prefixed names on Actions secrets, hence KNOWN_OAUTH_*.
  KNOWN_OAUTH_CLIENT_ID?: string;
  KNOWN_OAUTH_CLIENT_SECRET?: string;
}
