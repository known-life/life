import type { Env } from "../lib/types";
import { getPackage, listVersions, dependentsOf, topPackages, searchPackages, downloadsByVersion, getAccountById, getAccountByHandle, listPackagesByOwner } from "../lib/db";
import {
  packageHtml,
  packageMarkdown,
  listHtml,
  listMarkdown,
  type PackageView,
} from "../lib/pages";
import { loadVersionFiles } from "../lib/files";
import { semanticSearch } from "../lib/semantic";

// Content negotiation: CLI/agent user-agents and Accept: json|markdown get the
// dense surface; browsers get vaporwave HTML. (seeds' CLI_AGENTS lineage.)
const CLI_AGENTS = /(curl|wget|httpie|fetch|HTTPClient|node-fetch|python|aiohttp|Go-http-client|Deno|Bun)/i;

function wantsMachine(req: Request): "json" | "markdown" | null {
  const accept = req.headers.get("Accept") ?? "";
  const ua = req.headers.get("User-Agent") ?? "";
  if (accept.includes("application/json")) return "json";
  if (accept.includes("text/markdown")) return "markdown";
  if (CLI_AGENTS.test(ua) && !accept.includes("text/html")) return "markdown";
  return null;
}

export async function handlePackage(req: Request, env: Env, name: string): Promise<Response> {
  const pkg = await getPackage(env, name);
  if (!pkg || !pkg.latest_version) {
    return new Response(JSON.stringify({ error: "not_found", name }), {
      status: 404,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }
  const [versions, dependents, downloads, owner] = await Promise.all([
    listVersions(env, name),
    dependentsOf(env, name),
    downloadsByVersion(env, name),
    getAccountById(env, pkg.owner_account),
  ]);
  const latest = versions.find((x) => x.version === pkg.latest_version) ?? versions[0];
  const author = latest?.author ?? null;
  const publisher = owner?.github_login ?? null;
  const view: PackageView = { pkg, versions, dependents, author, downloads, publisher };

  const mode = wantsMachine(req);
  if (mode === "json") {
    return new Response(
      JSON.stringify({
        name: pkg.name,
        summary: pkg.summary,
        description: pkg.description,
        publisher,
        publisher_url: publisher ? `https://github.com/${publisher}` : null,
        author,
        license: pkg.license,
        keywords: JSON.parse(pkg.keywords_json ?? "[]"),
        homepage: pkg.homepage,
        repository: pkg.repository,
        latest_version: pkg.latest_version,
        verified_state: pkg.verified_state,
        superseded_by: pkg.superseded_by,
        install_count: pkg.install_count,
        install: `known.life/${pkg.name}`,
        versions: versions.map((v) => ({
          version: v.version,
          published_at: v.published_at,
          downloads: downloads[v.version] ?? 0,
          deprecated: !!v.yanked,
          bytes: v.bytes,
          content_hash: v.content_hash,
        })),
        requires: JSON.parse(latest?.requires_json ?? "[]"),
        provides: JSON.parse(latest?.provides_json ?? "[]"),
        dependents,
        readme: pkg.readme,
        resolve: `${env.PUBLIC_URL}/api/resolve/${pkg.name}/latest`,
      }),
      { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=60" } },
    );
  }
  if (mode === "markdown") {
    return new Response(packageMarkdown(view, env.PUBLIC_URL), {
      headers: { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "public, max-age=60" },
    });
  }
  // HTML only: hydrate a version's files for the in-page viewer. `?v=<ver>`
  // selects which version to show (defaults to latest); an unknown value falls
  // back to latest. JSON/markdown stay metadata-only and skip the R2 reads.
  // A browse view never counts as an install — that stays gated to
  // /api/resolve?reason=install.
  const sel = new URL(req.url).searchParams.get("v");
  const viewerVersion = sel && versions.some((x) => x.version === sel) ? sel : pkg.latest_version;
  const loaded = await loadVersionFiles(env, name, viewerVersion);
  return new Response(
    packageHtml({ ...view, files: loaded?.files, filesMissing: loaded?.missing, viewerVersion }),
    { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=60" } },
  );
}

export async function handleExplore(req: Request, env: Env): Promise<Response> {
  const rows = await topPackages(env, 100);
  if (wantsMachine(req)) {
    return new Response(listMarkdown("explore — top packages", rows), {
      headers: { "Content-Type": "text/markdown; charset=utf-8" },
    });
  }
  return new Response(listHtml("explore — ranked by installs", rows), {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" },
  });
}

export async function handleSearch(req: Request, env: Env): Promise<Response> {
  const q = (new URL(req.url).searchParams.get("q") ?? "").trim();
  // Lexical finds vocabulary matches; semanticSearch re-ranks by intent and
  // adds genes the LIKE missed (failing open to lexical alone without env.AI).
  const rows = q
    ? await semanticSearch(env, q, await searchPackages(env, q, 50))
    : await topPackages(env, 30);
  const title = q ? `search: ${q}` : "search — popular packages";
  if (wantsMachine(req)) {
    return new Response(listMarkdown(title, rows), {
      headers: { "Content-Type": "text/markdown; charset=utf-8" },
    });
  }
  return new Response(listHtml(title, rows, q), {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}


// GET /api/owner/<login> — the genes a GitHub login owns. The genepool knows
// owner-per-gene (publish proves you via github.com/<login>.keys → an account
// keyed on github_login), but there was no read path; this is it. Public, JSON,
// so `life owned` can answer "what do I own on known.life?".
export async function handleOwner(env: Env, login: string): Promise<Response> {
  const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=60" };
  const account = await getAccountByHandle(env, login);
  if (!account) {
    return new Response(JSON.stringify({ error: "not_found", login }), { status: 404, headers });
  }
  const rows = await listPackagesByOwner(env, account.id);
  return new Response(
    JSON.stringify({
      login: account.github_login ?? account.handle,
      count: rows.length,
      packages: rows.map((p) => ({
        name: p.name,
        latest_version: p.latest_version,
        summary: p.summary,
        install_count: p.install_count,
      })),
    }),
    { headers },
  );
}
