import type { Env } from "./types";

/**
 * Simple fixed-window rate limiter on KV. Keyed by an arbitrary bucket string
 * (e.g. `publish:ip:1.2.3.4` or `claim:acct:<id>`). Returns whether the call is
 * allowed and, if not, roughly how long until the window resets.
 *
 * Fixed-window is good enough here (low-stakes genepool abuse control, seed.show
 * used the same shape). KV's eventual consistency means the cap is approximate
 * under a burst from many colos — acceptable; it's a floor against spray, not a
 * billing meter.
 */
export interface RateResult {
  ok: boolean;
  remaining: number;
  retryAfter: number; // seconds until window reset (0 when ok)
}

export async function checkRate(
  env: Env,
  bucket: string,
  limit: number,
  windowSeconds: number,
): Promise<RateResult> {
  const now = Math.floor(Date.now() / 1000);
  const window = Math.floor(now / windowSeconds);
  const key = `rl:${bucket}:${window}`;
  const raw = await env.KNOWN_KV.get(key);
  const count = raw ? parseInt(raw, 10) || 0 : 0;

  if (count >= limit) {
    const reset = (window + 1) * windowSeconds - now;
    return { ok: false, remaining: 0, retryAfter: reset };
  }

  // Increment; set TTL so the window key self-expires.
  await env.KNOWN_KV.put(key, String(count + 1), { expirationTtl: windowSeconds + 5 });
  return { ok: true, remaining: limit - count - 1, retryAfter: 0 };
}

/**
 * Enforce two buckets (per-IP and per-account) at once for a write action.
 * Returns the first failure, or ok.
 */
export async function checkWriteRate(
  env: Env,
  action: string,
  ip: string,
  account: string | null,
  perIp: { limit: number; windowS: number },
  perAcct: { limit: number; windowS: number },
): Promise<RateResult> {
  const ipRes = await checkRate(env, `${action}:ip:${ip}`, perIp.limit, perIp.windowS);
  if (!ipRes.ok) return ipRes;
  if (account) {
    const acctRes = await checkRate(env, `${action}:acct:${account}`, perAcct.limit, perAcct.windowS);
    if (!acctRes.ok) return acctRes;
  }
  return ipRes;
}
