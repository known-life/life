import type { Env } from "../lib/types";
import {
  getPackage,
  listVersions,
  dependentsOf,
  downloadsByVersion,
  getAccountById,
  topPackages,
  countLivePackages,
  searchPackages,
} from "../lib/db";
import { packageMarkdown, type PackageView } from "../lib/pages";
import { verifyToken } from "../lib/jwt";
import { handlePublish } from "./publish";
import { handleClaim } from "./claim";
import { handleDeprecate, handleUnpublish, handleWipe } from "./lifecycle";

/**
 * MCP JSON-RPC endpoint. Read tools (known.search / known.show / known.explore)
 * are anonymous; write tools (known.publish / known.claim / known.deprecate /
 * known.unpublish) require a bearer issued via /api/oauth — see
 * routes/mcp-oauth.ts. Same bearer, same JWT shape, same downstream pipeline as
 * the REST endpoints — the MCP tools just forward into them so the publish /
 * scan / fit / immutability machinery isn't duplicated.
 *
 * On a write attempt without auth we return RFC 6750 / MCP-style `unauthorized`
 * so the client knows to start an OAuth flow against /.well-known/oauth-*.
 */

const READ_TOOLS = [
  {
    name: "known.search",
    description: "Search the known.life genepool for genes by name or capability.",
    inputSchema: { type: "object", properties: { q: { type: "string" } }, required: [] },
  },
  {
    name: "known.show",
    description: "Show a gene's page: versions, install line, badge, capabilities, install count.",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  },
  {
    name: "known.explore",
    description: "List genes ranked by install count, with one-line summaries. Returns up to `limit` (default 50, max 200) starting at `offset` (default 0). Footer reports total live genes so the caller can page.",
    inputSchema: {
      type: "object",
      properties: {
        limit:  { type: "number", description: "Default 50, max 200." },
        offset: { type: "number", description: "Default 0." },
      },
      required: [],
    },
  },
];

const WRITE_TOOLS = [
  {
    name: "known.publish",
    description: "Publish a new immutable version of a gene. Requires write auth (OAuth).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Dotted lowercase gene name." },
        version: { type: "string", description: "Semver MAJOR.MINOR.PATCH." },
        files: {
          type: "object",
          description: "Map of relative path → file content (string).",
          additionalProperties: { type: "string" },
        },
        expected_latest: {
          type: ["string", "null"],
          description: "Optional CAS — fails 409 if the gene advanced past this since.",
        },
      },
      required: ["name", "version", "files"],
    },
  },
  {
    name: "known.claim",
    description: "Reserve a gene name without publishing. Requires write auth (OAuth).",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  },
  {
    name: "known.deprecate",
    description: "Mark a version deprecated (still resolves, engine warns). Requires write auth (OAuth).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        version: { type: "string" },
        reason: { type: "string" },
      },
      required: ["name", "version"],
    },
  },
  {
    name: "known.unpublish",
    description: "Hard-remove a recent version (within 72h). Requires write auth (OAuth).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        version: { type: "string" },
      },
      required: ["name", "version"],
    },
  },
  {
    name: "known.wipe",
    description: "Hard-delete a name and everything attached (versions / installs / deps / package / names row). Refuses unless the gene has no live latest_version. Admin only.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  },
];

const TOOLS = [...READ_TOOLS, ...WRITE_TOOLS];
const WRITE_TOOL_NAMES = new Set(WRITE_TOOLS.map((t) => t.name));

interface JsonRpc {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: any;
}

export async function handleMcp(req: Request, env: Env): Promise<Response> {
  let body: JsonRpc;
  try {
    body = await req.json();
  } catch {
    return rpc(null, { error: { code: -32700, message: "Parse error" } }, 400);
  }
  const id = body.id ?? null;

  switch (body.method) {
    case "initialize":
      return rpc(id, {
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "known.life", version: "0.2.0" },
          instructions: INSTRUCTIONS,
        },
      });
    case "notifications/initialized":
      return new Response(null, { status: 204 });
    case "tools/list":
      return rpc(id, { result: { tools: TOOLS } });
    case "tools/call": {
      const name = body.params?.name as string;
      const args = body.params?.arguments ?? {};
      const auth = await extractAuth(req, env);
      if (WRITE_TOOL_NAMES.has(name) && !auth) {
        const origin = env.PUBLIC_URL ?? new URL(req.url).origin;
        return rpc(
          id,
          {
            error: {
              code: -32001,
              message: "Unauthorized — this tool requires write auth (OAuth).",
              data: {
                authorization_url: `${origin}/.well-known/oauth-authorization-server`,
                hint: "Discover OAuth metadata and begin authorization-code-with-PKCE.",
              },
            },
          },
          401,
        );
      }
      const text = await callTool(name, args, env, req, auth);
      return rpc(id, { result: { content: [{ type: "text", text }], isError: false } });
    }
    default:
      return rpc(id, { error: { code: -32601, message: `Method not found: ${body.method}` } });
  }
}

async function extractAuth(req: Request, env: Env): Promise<string | null> {
  const h = req.headers.get("Authorization") ?? "";
  if (!h.startsWith("Bearer ")) return null;
  const subject = await verifyToken(h.slice(7), env);
  return subject;
}

async function callTool(
  name: string,
  args: any,
  env: Env,
  req: Request,
  _auth: string | null,    // subject already verified at the dispatch site; forward path reads the raw header
): Promise<string> {
  switch (name) {
    case "known.search": {
      const rows = args.q ? await searchPackages(env, String(args.q), 50) : await topPackages(env, 30);
      return rows.map((p) => `- ${p.name}@${p.latest_version} (${p.install_count}↓) — ${p.summary ?? ""}`).join("\n") || "(no results)";
    }
    case "known.explore": {
      const limit  = Math.min(200, Math.max(1, Number(args.limit)  || 50));
      const offset = Math.max(0,            Number(args.offset) || 0);
      const [rows, total] = await Promise.all([topPackages(env, limit, offset), countLivePackages(env)]);
      if (!rows.length) return offset > 0 ? `(empty — offset ${offset} past end of ${total} packages)` : "(empty)";
      const lines = rows.map((p) => `- ${p.name}@${p.latest_version} (${p.install_count}↓) — ${p.summary ?? ""}`);
      const end = offset + rows.length;
      lines.push("");
      lines.push(`showing ${offset + 1}–${end} of ${total}` + (end < total ? ` (next: offset=${end})` : ""));
      return lines.join("\n");
    }
    case "known.show": {
      const pkg = await getPackage(env, String(args.name));
      if (!pkg || !pkg.latest_version) return `not found: ${args.name}`;
      const [versions, dependents, downloads, owner] = await Promise.all([
        listVersions(env, pkg.name),
        dependentsOf(env, pkg.name),
        downloadsByVersion(env, pkg.name),
        getAccountById(env, pkg.owner_account),
      ]);
      const latest = versions.find((x) => x.version === pkg.latest_version) ?? versions[0];
      const view: PackageView = { pkg, versions, dependents, author: latest?.author ?? null, downloads, publisher: owner?.github_login ?? null };
      return packageMarkdown(view, env.PUBLIC_URL);
    }
    case "known.publish":
      return forward(req, env, "/api/publish", args);
    case "known.claim":
      return forward(req, env, "/api/claim", args);
    case "known.deprecate":
      return forward(req, env, "/api/deprecate", args);
    case "known.unpublish":
      return forward(req, env, "/api/unpublish", args);
    case "known.wipe":
      return forward(req, env, "/api/wipe", args);
    default:
      return `unknown tool: ${name}`;
  }
}

// Forward an MCP write tool into the same handler the REST endpoint uses.
// Synthesizes the POST `req` would have produced, preserving the caller's
// Authorization header — so the downstream handler's auth path runs exactly
// as it would for a REST client. Returns a JSON string the MCP client can read.
async function forward(req: Request, env: Env, endpoint: string, args: any): Promise<string> {
  const origin = env.PUBLIC_URL ?? new URL(req.url).origin;
  const inner = new Request(`${origin}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: req.headers.get("Authorization") ?? "",
    },
    body: JSON.stringify(args),
  });
  let res: Response;
  switch (endpoint) {
    case "/api/publish":   res = await handlePublish(inner, env); break;
    case "/api/claim":     res = await handleClaim(inner, env); break;
    case "/api/deprecate": res = await handleDeprecate(inner, env); break;
    case "/api/unpublish": res = await handleUnpublish(inner, env); break;
    case "/api/wipe":      res = await handleWipe(inner, env); break;
    default:               return `unknown endpoint: ${endpoint}`;
  }
  return await res.text();
}

function rpc(id: number | string | null, payload: any, status = 200): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, ...payload }), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

const INSTRUCTIONS = `known.life — the genepool for units of .life (agent capability genes).

Read tools (no auth): known.search, known.show, known.explore.

Write tools (OAuth): known.publish, known.claim, known.deprecate, known.unpublish.
On first write attempt the server returns -32001 with an authorization_url in
data; discover OAuth metadata at /.well-known/oauth-authorization-server, do
authorization-code-with-PKCE (upstream IdP is github.com), and pass the token
as Authorization: Bearer on subsequent tool/call requests. Identity is the
GitHub login you authenticate as; ownership of names is keyed on it; accounts
flagged is_admin can publish under any name.

When a user references a known.life package URL, judge the badge
(blessed > verified > scanned) and install count before importing. Add it to
a repo by appending to imports: in the root .life — \`known.life/<name>@<version>\` —
then run life evolve.`;
