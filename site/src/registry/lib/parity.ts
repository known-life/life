/**
 * Pre-publish isolate-parity scan — ADVISORY, never blocking. The lesson this
 * encodes (learned live, 2026-07-01, write-up in the justin .life's
 * think-full-conversion plan): a gene command can declare `run: node <file>` —
 * satisfying every shallow "isolate-friendly" check, which only ever looked at
 * the declared interpreter — while the body itself is completely broken in a
 * shell-less isolate. Two published genes (`priorities`, `improve`) shipped
 * broken for days exactly this way: real `node:fs` cannot see the isolate's
 * hydrated tree (only `globalThis.__LIFE_IO_BACKEND__.fs` can), a bare
 * top-level script's output is discarded (the runner calls `run()`), and
 * `import.meta.url` throws in a CJS isolate load.
 *
 * So this scan reads each `run: node <file>` command body named by the .life
 * and warns on the three proven failure shapes. Warnings surface in every
 * `life mutate` result (`scan_warnings`) — the publisher sees them at the
 * moment they can act. Advisory because a gene may legitimately be
 * container-only; the warning states the consequence, the publisher decides.
 */

import type { ScanFinding } from "./scan";

// The command bodies a .life declares: every `run:` whose interpreter is node
// (the isolate-runnable claim). Hook bodies (`hooks/*.js`) have a different
// loading contract and are not judged here.
export function nodeCommandBodies(lifeText: string): string[] {
  const out = new Set<string>();
  for (const raw of lifeText.split("\n")) {
    const m = raw.match(/^\s+run:\s*["']?node\s+(\S+?\.(?:mjs|cjs|js))\b/);
    if (m) out.add(m[1].replace(/^\.?\//, ""));
  }
  return [...out];
}

const RUN_EXPORT = /(?:module\.)?exports(?:\.run\b|\s*=\s*\{[^}]*\brun\b|\s*=\s*run\b)|export\s+(?:async\s+)?function\s+run\b|export\s*\{[^}]*\brun\b/;
const RAW_FS = /require\(\s*["'](?:node:)?fs["']\s*\)|from\s+["'](?:node:)?fs["']/;
const RAW_CHILD_PROCESS = /require\(\s*["'](?:node:)?child_process["']\s*\)|from\s+["'](?:node:)?child_process["']/;
const BK = /__LIFE_IO_BACKEND__/;
const IMPORT_META_URL = /\bimport\.meta\.url\b/;

function lineOf(content: string, re: RegExp): number {
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) return i + 1;
  return 1;
}

/** Advisory findings for every `run: node <file>` body in the gene. */
export function scanIsolateParity(files: Record<string, string>): ScanFinding[] {
  const lifeText = files[".life"];
  if (!lifeText) return [];
  const warnings: ScanFinding[] = [];
  for (const path of nodeCommandBodies(lifeText)) {
    const body = files[path];
    if (body === undefined) {
      warnings.push({
        path: ".life", line: 1, rule: "isolate-body-missing",
        excerpt: `run: node ${path} — but ${path} is not in the published files`,
      });
      continue;
    }
    if (!RUN_EXPORT.test(body)) {
      warnings.push({
        path, line: 1, rule: "isolate-no-run-export",
        excerpt: "command body exposes no run() export — a shell-less isolate discards a bare top-level script's output",
      });
    }
    const usesBk = BK.test(body);
    if (RAW_FS.test(body) && !usesBk) {
      warnings.push({
        path, line: lineOf(body, RAW_FS), rule: "isolate-raw-fs",
        excerpt: "uses Node fs without consulting __LIFE_IO_BACKEND__ — real fs cannot see an isolate's hydrated tree",
      });
    }
    if (RAW_CHILD_PROCESS.test(body) && !usesBk) {
      warnings.push({
        path, line: lineOf(body, RAW_CHILD_PROCESS), rule: "isolate-raw-child-process",
        excerpt: "uses child_process without consulting __LIFE_IO_BACKEND__ — there is no shell in an isolate",
      });
    }
    if (IMPORT_META_URL.test(body)) {
      warnings.push({
        path, line: lineOf(body, IMPORT_META_URL), rule: "isolate-import-meta-url",
        excerpt: "uses import.meta.url — undefined when the body loads as CJS in an isolate; resolve paths repo-relative instead",
      });
    }
  }
  return warnings;
}
