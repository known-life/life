// Semantic search over the pool — intent, not vocabulary. The lexical LIKE in
// db.ts finds genes by the words a publisher happened to use; this ranks every
// live gene against the query by embedding cosine, so "capture a webpage as an
// image" can find `browser` without sharing a token with its summary.
//
// Embeddings come from Workers AI (env.AI, the infra.ai binding) running
// @cf/baai/bge-base-en-v1.5 — deterministic 768-dim vectors, so ranking is
// reproducible and can't be steered by adversarial prose in a summary the way
// an LLM reranker could. They are computed lazily at search time and cached in
// D1 keyed by (package, latest_version): a publish bumps latest_version, the
// row goes stale, and the next search re-embeds just that package; steady
// state is one model call per search (the query itself).
//
// Everything fails open: no AI binding, a model error, an empty pool — the
// caller keeps the lexical results untouched.

import type { Env } from "./types";
import { getPackage, type PackageRecord } from "./db";

const MODEL = "@cf/baai/bge-base-en-v1.5";
// bge caps input at 512 tokens; ~4 chars/token keeps a long summary under it.
const MAX_EMBED_CHARS = 1800;
const EMBED_BATCH = 25;
// Relevance is RELATIVE, not absolute. bge-base is anisotropic: any two
// English texts score ~0.45–0.55, and a nonsense query's best gene can reach
// 0.60 — overlapping real matches, so no fixed floor separates them. What
// does separate them (measured against the live pool, 2026-06-11) is height
// above the pool's median: real intent queries put their hits +0.10–0.17
// over median ("take a picture of a webpage" → browser +0.145), while noise
// queries top out flat (+0.075, "underwater basket weaving"). So: if the
// best gene clears the median by less than NOISE_MARGIN the whole query is
// noise to the pool (return nothing semantic); otherwise accept genes in the
// top SIGNAL_FRACTION of the (top − median) band.
export const NOISE_MARGIN = 0.09;
export const SIGNAL_FRACTION = 0.6;

function embedText(name: string, summary: string | null): string {
  return `${name} — ${(summary ?? "").slice(0, MAX_EMBED_CHARS)}`;
}

async function embed(env: Env, texts: string[]): Promise<number[][] | null> {
  if (!env.AI || !texts.length) return null;
  const out: number[][] = [];
  try {
    for (let i = 0; i < texts.length; i += EMBED_BATCH) {
      const batch = texts.slice(i, i + EMBED_BATCH);
      const res = (await env.AI.run(MODEL, { text: batch })) as { data?: number[][] };
      if (!Array.isArray(res?.data) || res.data.length !== batch.length) return null;
      out.push(...res.data);
    }
    return out;
  } catch {
    return null;
  }
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom ? dot / denom : 0;
}

// Bring the cache up to date with the live pool: embed every package whose
// latest_version has no cached vector (new or republished). Zero rows stale →
// zero model calls.
export async function ensureEmbeddings(env: Env): Promise<void> {
  const stale = await env.DB.prepare(
    `SELECT p.name, p.latest_version AS version, p.summary FROM packages p
     LEFT JOIN embeddings e ON e.package = p.name AND e.version = p.latest_version
     WHERE p.latest_version IS NOT NULL AND e.package IS NULL`,
  ).all<{ name: string; version: string; summary: string | null }>();
  const rows = stale.results ?? [];
  if (!rows.length) return;
  const vectors = await embed(env, rows.map((r) => embedText(r.name, r.summary)));
  if (!vectors) return;
  await env.DB.batch(
    rows.map((r, i) =>
      env.DB.prepare(
        `INSERT INTO embeddings (package, version, vector) VALUES (?, ?, ?)
         ON CONFLICT(package) DO UPDATE SET version = excluded.version, vector = excluded.vector`,
      ).bind(r.name, r.version, JSON.stringify(vectors[i])),
    ),
  );
}

// Every live package scored against the query, as name → cosine. null means
// semantic is unavailable (no binding / model error) and the caller should
// keep its lexical results.
async function semanticScores(env: Env, q: string): Promise<Map<string, number> | null> {
  if (!env.AI) return null;
  await ensureEmbeddings(env);
  const qv = await embed(env, [q]);
  if (!qv) return null;
  const rows = await env.DB.prepare(
    `SELECT e.package, e.vector FROM embeddings e
     JOIN packages p ON p.name = e.package AND p.latest_version = e.version`,
  ).all<{ package: string; vector: string }>();
  const scores = new Map<string, number>();
  for (const r of rows.results ?? []) {
    try {
      scores.set(r.package, cosine(qv[0], JSON.parse(r.vector) as number[]));
    } catch {
      // an unparseable cached vector just drops out of the ranking
    }
  }
  return scores.size ? scores : null;
}

// The /search merge. Order: lexical NAME matches first (typing a gene's name
// must always find it), then the genes the adaptive cut accepts by cosine
// desc, then the remaining lexical hits (a vocabulary match is still a
// match) — deduped, capped. Lexical rows pass through untouched when
// semantic is unavailable.
export async function semanticSearch(
  env: Env,
  q: string,
  lexical: PackageRecord[],
  limit = 20,
): Promise<PackageRecord[]> {
  const scores = await semanticScores(env, q);
  if (!scores) return lexical;

  const ql = q.toLowerCase();
  const nameHits = lexical.filter((p) => p.name.toLowerCase().includes(ql));
  const sorted = [...scores.values()].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const top = sorted[sorted.length - 1];
  const cut = median + SIGNAL_FRACTION * (top - median);
  const semNames =
    top - median < NOISE_MARGIN
      ? []
      : [...scores.entries()]
          .filter(([, s]) => s >= cut)
          .sort((a, b) => b[1] - a[1])
          .map(([name]) => name);

  // Each getPackage() is an independent D1 lookup keyed by name — fetch the
  // ones lexical search didn't already return concurrently, not one await
  // per semantic match (same fix + rationale as routes/resolve.ts and
  // routes/publish.ts: this scales with pool size as the registry grows, and
  // it's on the hot /search path, not a one-off).
  const byName = new Map(lexical.map((p) => [p.name, p]));
  const toFetch = semNames.filter((name) => !byName.has(name));
  const fetched = await Promise.all(toFetch.map((name) => getPackage(env, name)));
  toFetch.forEach((name, i) => {
    const p = fetched[i];
    if (p) byName.set(name, p);
  });

  const ordered: PackageRecord[] = [];
  const seen = new Set<string>();
  for (const p of [
    ...nameHits,
    ...(semNames.map((n) => byName.get(n)).filter(Boolean) as PackageRecord[]),
    ...lexical,
  ]) {
    if (seen.has(p.name)) continue;
    seen.add(p.name);
    ordered.push(p);
  }
  return ordered.slice(0, limit);
}
