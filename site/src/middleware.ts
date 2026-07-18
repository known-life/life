import { defineMiddleware } from "astro:middleware";
import { registryFetch } from "../../.genome/registry/src/registry/router";
import type { Env } from "../../.genome/registry/src/registry/lib/types";
import { viewerFetch } from "../../.genome/viewer/src/index";

/**
 * The merge seam between the docs site (Astro) and the genepool (a request
 * handler). Astro owns `/`, `/docs/*`, and the static assets in `public/`;
 * everything dynamic the genepool needs is forwarded to `registryFetch`.
 *
 * Two kinds of genepool path:
 *  - Owned outright (`/api/*`, `/explore`, `/search`, `/skill`, `/mcp`,
 *    `/healthz`): handled before Astro ever sees them.
 *  - Gene pages (`/laws`, `/secret.auth.proxy`, …): tried only AFTER Astro
 *    declines the path with a 404, so real Astro routes (e.g. `/docs`) and
 *    static assets always win and there's no name-collision guesswork.
 *
 * Bindings come from the Cloudflare adapter at `locals.runtime.env`. During a
 * plain `astro build` (no runtime) there are no bindings, so we no-op to Astro.
 */
export const onRequest = defineMiddleware(async (context, next) => {
  const { request } = context;
  const path = new URL(request.url).pathname;

  const runtime = (context.locals as { runtime?: { env?: Env; ctx?: { waitUntil(p: Promise<unknown>): void } } }).runtime;
  // No Cloudflare runtime (build-time) or no DB binding → pure Astro.
  if (!runtime?.env?.DB) return next();
  // The .life declares its bindings under the genepool's own names (env.DB,
  // env.KNOWN_KV, env.KNOWN_R2 — see site/.life), so the runtime env IS the
  // genepool Env. PUBLIC_URL is just where we're served, so derive it here.
  const env: Env = runtime.env;
  if (!env.PUBLIC_URL) env.PUBLIC_URL = new URL(request.url).origin;
  const ctx = runtime.ctx ?? { waitUntil() {} };

  // Agent-facing content negotiation for `/`: the site's thesis is
  // agent-legible infrastructure, and `/llms.txt` already exists as the plain
  // agent runbook. Browsers always send `text/html` in Accept; curl, wget, and
  // most agent fetchers send `*/*` or a non-HTML Accept. If `/` is requested
  // without a preference for HTML, serve `llms.txt` instead. UA sniffing is a
  // belt for clients that send `*/*` but should still be treated as agents.
  if (request.method === "GET" && path === "/") {
    const accept = request.headers.get("accept") ?? "";
    const ua = request.headers.get("user-agent") ?? "";
    const wantsHtml = accept.includes("text/html");
    const agentUa = /\b(curl|wget|httpie|claude|anthropic|gpt|openai|cohere|perplexity|bot|crawler|spider)\b/i.test(ua);
    // Link-preview crawlers must get the HTML (they read the og: tags to
    // render the share card) even though they send `Accept: */*` and their
    // UAs often contain "bot" (iMessage is literally "Facebot Twitterbot").
    const previewBot = /\b(whatsapp|facebookexternalhit|facebot|twitterbot|slackbot|telegrambot|discordbot|linkedinbot|pinterestbot|skypeuripreview|snapchat|viber)\b/i.test(ua);
    if ((!wantsHtml || agentUa) && !previewBot) {
      // Serve the runbook BODY (200), not a redirect: an agent curling `/`
      // without -L gets a bodyless 302 and reads the site as broken (lived
      // 2026-07-18). `/llms.txt` is a static asset excluded from the worker
      // via _routes.json — an internal Astro rewrite has no route to land on —
      // but the ASSETS binding reaches it in-process (site/.life assets:).
      // ASSETS is always bound in production (site/.life); if it ever isn't,
      // the throw surfaces as a 500 — visible, not silently divergent.
      const assets = (env as unknown as { ASSETS: { fetch(u: string): Promise<Response> } }).ASSETS;
      return assets.fetch(new URL("/llms.txt", request.url).toString());
    }
  }

  // The multi-life viewer (the known.life/viewer gene, vendored into
  // .genome/viewer/ — the repo holds no copy) owns /app. Mounted
  // registryFetch-style; its IdP calls go back through registryFetch
  // IN-PROCESS (a worker must not fetch() its own hostname), and its session
  // cookie rides the existing JWT_SIGNING_KEY — no new secrets, no new
  // deploy unit.
  if (path === "/app" || path.startsWith("/app/")) {
    const viewerRes = await viewerFetch(request, {
      basePath: "/app",
      idpOrigin: env.PUBLIC_URL,
      idpFetch: async (req) =>
        (await registryFetch(req, env, ctx)) ?? new Response("idp route missing", { status: 502 }),
      sessionSecret: env.JWT_SIGNING_KEY,
      brand: "Life",
      // App-parity data planes (viewer-app-parity node 06): IDENTITY mode —
      // the viewer calls each plane with the session's IdP-signed identity
      // token (minted at login when the identity keypair exists; public key
      // at /jwks) and the plane verifies the login itself. No secret here.
      planes: {
        "DomVinyard/justin": {
          url: "https://data.justin.vin",
          identity: true,
          owners: ["DomVinyard"],
          artifactHost: "https://artifact.justin.vin",
        },
      },
    });
    if (viewerRes) return viewerRes;
  }

  const ownedOutright =
    path === "/healthz" ||
    path === "/skill" ||
    path === "/install" ||
    path === "/mcp" ||
    path === "/explore" ||
    path === "/search" ||
    path.startsWith("/api/");

  if (ownedOutright) {
    const res = await registryFetch(request, env, ctx);
    if (res) return res;
    return next();
  }

  // Let Astro try; fall through to a registry package page only on a 404.
  const res = await next();
  if (res.status === 404) {
    const reg = await registryFetch(request, env, ctx);
    if (reg) return reg;
  }
  return res;
});
