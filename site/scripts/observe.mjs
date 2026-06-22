#!/usr/bin/env node
// observe.mjs — read the known-life worker's logs & traces from Cloudflare
// Workers Observability, in the terminal (Law 13: my own eyes on the one
// production surface every .life depends on, no dashboard required).
//
// This is the READ side of the [observability] block in ../wrangler.toml: that
// turns span/log capture ON; this reads it back. Same telemetry the Cloudflare
// dashboard shows, via POST /accounts/{id}/workers/observability/telemetry/query.
//
// Auth: CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID from the environment if set,
// else minted on demand via the cloudflare gene's mint-cf-token.sh — the same
// short-lived broker token CI deploys with, so there is no long-lived secret and
// no second auth path.
//
// Usage:
//   node site/scripts/observe.mjs                 # last 1h of known-life events
//   node site/scripts/observe.mjs --since 6h --limit 50
//   node site/scripts/observe.mjs --errors        # only level=error
//   node site/scripts/observe.mjs --traces        # span view (handler/fetch/KV/R2/D1)
//   node site/scripts/observe.mjs --service justin-harness-cf  # another worker
//   node site/scripts/observe.mjs publish         # free text → message filter
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const flag = (name) => argv.includes(`--${name}`);
const since = opt("since", "1h");
const limit = parseInt(opt("limit", "20"), 10);
const service = opt("service", "known-life");
const traces = flag("traces");
const errorsOnly = flag("errors");
const grep = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--") && argv[i - 1] !== "--errors" && argv[i - 1] !== "--traces")).join(" ").trim();

const DUR = { s: 1e3, m: 6e4, h: 36e5, d: 864e5 };
const m = /^(\d+)([smhd])$/.exec(since);
if (!m) { console.error(`bad --since "${since}" (use 30m, 6h, 2d)`); process.exit(2); }
const spanMs = parseInt(m[1], 10) * DUR[m[2]];

// ── credentials: env, else mint via the cloudflare gene ──────────────────────
let token = process.env.CLOUDFLARE_API_TOKEN;
let account = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!token || !account) {
  const dir = mkdtempSync(join(tmpdir(), "obs-"));
  const out = join(dir, "cf.env");
  try {
    execFileSync("bash", [join(REPO_ROOT, ".genome/cloudflare/mint-cf-token.sh"), out], {
      stdio: ["ignore", "ignore", "ignore"],
      env: { ...process.env, CLAUDE_PROJECT_DIR: REPO_ROOT },
    });
    for (const line of readFileSync(out, "utf8").split("\n")) {
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      const k = line.slice(0, eq), v = line.slice(eq + 1);
      if (k === "CLOUDFLARE_API_TOKEN") token = v;
      if (k === "CLOUDFLARE_ACCOUNT_ID") account = v;
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
if (!token || !account) {
  console.error("no Cloudflare credentials — set CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID, or ensure the broker mint works (life ask cloudflare).");
  process.exit(1);
}

// ── query ────────────────────────────────────────────────────────────────────
const now = Date.now();
const filters = [{ key: "$metadata.service", operation: "eq", value: service, type: "string" }];
if (errorsOnly) filters.push({ key: "$metadata.level", operation: "eq", value: "error", type: "string" });
if (grep) filters.push({ key: "$metadata.message", operation: "includes", value: grep, type: "string" });

const body = {
  queryId: "life-observe",
  timeframe: { from: now - spanMs, to: now },
  limit,
  view: traces ? "traces" : "events",
  parameters: { datasets: ["cloudflare-workers"], filters },
};

const res = await fetch(
  `https://api.cloudflare.com/client/v4/accounts/${account}/workers/observability/telemetry/query`,
  { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) },
);
const json = await res.json();
if (!json.success) {
  console.error("query failed:", JSON.stringify(json.errors || json, null, 2));
  process.exit(1);
}

// ── render ───────────────────────────────────────────────────────────────────
const get = (obj, path) => path.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
const ts = (n) => new Date(n).toISOString().replace("T", " ").replace("Z", "");
const lvl = (l) => ({ error: "✗", warn: "!", info: "·", debug: "…", log: "·" }[l] || "·");

const r = json.result || {};
const events = get(r, "events.events") || r.events || [];
const rows = traces ? (get(r, "traces.traces") || r.traces || events) : events;

console.log(`\n${service} · last ${since} · ${rows.length} ${traces ? "spans" : "events"}${errorsOnly ? " (errors)" : ""}${grep ? ` matching "${grep}"` : ""}\n`);
if (!rows.length) {
  console.log("  (none — if this worker just enabled observability, give it a request or two)\n");
  process.exit(0);
}
for (const e of rows) {
  const t = ts(e.timestamp || get(e, "$metadata.timestamp") || now);
  const level = get(e, "source.level") || get(e, "$metadata.level") || "log";
  const msg = get(e, "source.message") || get(e, "$metadata.message") || get(e, "$metadata.spanName") || JSON.stringify(e.source || e).slice(0, 160);
  const rid = (get(e, "$metadata.requestId") || "").slice(0, 8);
  console.log(`  ${t}  ${lvl(level)} ${rid ? rid + "  " : ""}${msg}`);
}
console.log("");
