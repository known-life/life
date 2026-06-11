/**
 * Pre-publish secret + PII scan. DETERMINISTIC and BLOCKING — a gene that
 * trips a high-confidence rule is rejected before it can ever be served. This
 * is the "verify before accepted" gate: nothing public has leaked keys or PII.
 *
 * Design: high-precision regexes for known credential shapes (the gitleaks
 * lineage), a Shannon-entropy backstop for assignment-like lines, and a small
 * set of PII shapes. We bias toward precision over recall on the BLOCKING set —
 * a false reject is worse than a missed low-confidence match — and surface
 * lower-confidence hits as advisory warnings the publisher can see but that
 * don't block.
 */

export interface ScanFinding {
  path: string;
  line: number;
  rule: string;
  excerpt: string; // redacted preview, never the full secret
}

export interface ScanResult {
  ok: boolean; // false → publish blocked
  blocking: ScanFinding[];
  warnings: ScanFinding[];
}

interface Rule {
  id: string;
  re: RegExp;
  blocking: boolean;
}

// High-precision credential patterns. Blocking ones are near-zero false-positive.
const RULES: Rule[] = [
  { id: "aws-access-key-id", re: /\bAKIA[0-9A-Z]{16}\b/, blocking: true },
  { id: "github-pat", re: /\bghp_[A-Za-z0-9]{36}\b/, blocking: true },
  { id: "github-fine-grained-pat", re: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/, blocking: true },
  { id: "gitlab-pat", re: /\bglpat-[A-Za-z0-9_-]{20}\b/, blocking: true },
  { id: "stripe-secret-key", re: /\bsk_(live|test)_[A-Za-z0-9]{24,}\b/, blocking: true },
  { id: "stripe-restricted-key", re: /\brk_(live|test)_[A-Za-z0-9]{24,}\b/, blocking: true },
  { id: "openai-key", re: /\bsk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}\b/, blocking: true },
  { id: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9-]{20,}\b/, blocking: true },
  { id: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/, blocking: true },
  { id: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, blocking: true },
  // A real PEM key: the BEGIN marker alone on its line, OR followed inline by a
  // quote/backslash (string-embedded key) or actual base64 material. This avoids
  // firing on code that merely *mentions* the marker — e.g. a regex that parses
  // SSH keys (`pem.match(/-----BEGIN OPENSSH PRIVATE KEY-----([\s\S]*?).../)`),
  // which would otherwise make any key-handling gene (lifekey, core) unpublishable.
  { id: "private-key-block", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----(?:[ \t]*$|["'\\]|[A-Za-z0-9+/]{20})/, blocking: true },
  { id: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, blocking: true },
  // PII — blocking on the high-confidence shapes.
  { id: "credit-card", re: /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13})\b/, blocking: true },
  { id: "us-ssn", re: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/, blocking: true },
  // Advisory only — common in legit docs/examples, so warn don't block.
  { id: "email-address", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/, blocking: false },
  { id: "phone-number", re: /\b\+?\d{1,3}[-.\s]?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/, blocking: false },
  { id: "generic-secret-assignment", re: /\b(?:api[_-]?key|secret|password|passwd|token|bearer)\b\s*[:=]\s*['"]?[^\s'"]{12,}/i, blocking: false },
];

// Files whose contents we never scan (binary-ish / lockfiles produce noise).
const SKIP_PATH = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|lock)$/i;

function redact(line: string, match: string): string {
  const masked =
    match.length <= 8 ? "*".repeat(match.length) : match.slice(0, 4) + "…" + match.slice(-2);
  const idx = line.indexOf(match);
  const start = Math.max(0, idx - 16);
  return line.slice(start, idx).trimStart() + masked + line.slice(idx + match.length).slice(0, 16);
}

/** Shannon entropy (bits/char) — high values flag random-looking strings. */
function entropy(s: string): number {
  const freq: Record<string, number> = {};
  for (const c of s) freq[c] = (freq[c] ?? 0) + 1;
  let h = 0;
  for (const c in freq) {
    const p = freq[c] / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

const HIGH_ENTROPY_TOKEN = /['"=:\s]([A-Za-z0-9+/_-]{32,})['"\s]?/g;

export function scanFiles(files: Record<string, string>): ScanResult {
  const blocking: ScanFinding[] = [];
  const warnings: ScanFinding[] = [];

  for (const [path, content] of Object.entries(files)) {
    if (SKIP_PATH.test(path)) continue;
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.length > 4000) continue; // skip minified blobs
      for (const rule of RULES) {
        const m = rule.re.exec(line);
        if (m) {
          const finding: ScanFinding = {
            path,
            line: i + 1,
            rule: rule.id,
            excerpt: redact(line, m[0]),
          };
          (rule.blocking ? blocking : warnings).push(finding);
        }
      }
      // Entropy backstop: a long, high-entropy token next to an assignment is
      // probably a secret. Advisory (precision varies), but loud.
      let em: RegExpExecArray | null;
      HIGH_ENTROPY_TOKEN.lastIndex = 0;
      while ((em = HIGH_ENTROPY_TOKEN.exec(line))) {
        const token = em[1];
        if (entropy(token) >= 4.0 && /[0-9]/.test(token) && /[A-Za-z]/.test(token)) {
          warnings.push({
            path,
            line: i + 1,
            rule: "high-entropy-string",
            excerpt: redact(line, token),
          });
          break; // one per line is enough signal
        }
      }
    }
  }

  return { ok: blocking.length === 0, blocking, warnings };
}
