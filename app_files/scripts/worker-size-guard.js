#!/usr/bin/env node

// Post-build Worker bundle-size guard (issue #2383).
//
// Overskill budgets the EAGER Worker bundle at 5.5MB (hard-failing the build
// above it). This is an OVERSKILL budget, NOT a Cloudflare cap: Cloudflare
// allows 64 MiB uncompressed and enforces no compressed limit at all
// (https://developers.cloudflare.com/workers/platform/limits/#worker-size,
// re-verified 2026-09-26). The binding constraints are Worker startup time
// (hard 1s) and end-user load time, which is why the budget is ~8.6% of the
// platform cap. Keep this file and app/services/deployment/bundle_size_limits.rb
// in agreement.
//
// A generated app that statically imports a heavy library (recharts,
// pdfjs-dist, xlsx, …) from an EAGERLY-loaded route pulls that library into
// the eager bundle, blows the budget, and ships a slow-starting app —
// historically surfacing as a silent, credit-burning publish loop.
//
// This guard runs AFTER `vite build` (from scripts/prepare-worker.js and as a
// standalone CLI) and measures the EAGER graph: the entry chunk plus every
// chunk reachable through STATIC imports (Vite manifest `imports`), EXCLUDING
// `dynamicImports`. Lazy/async chunks are excluded because they load on demand
// and the platform offloads them to R2 at deploy time. If the eager graph
// exceeds the soft limit, the build FAILS LOUDLY with an actionable, model-
// readable correction naming the largest eager chunks + any heavy library that
// leaked into the eager graph + the lazy-load remediation.
//
// ⚠️ A manualChunks NAME does NOT make a chunk lazy. Only a dynamic import()
// boundary at the consumer splits a chunk out of the eager graph. See
// vite.config.ts and src/components/ui/chart.tsx.

import fs from 'fs';
import path from 'path';
import { HEAVY_LIB_MODULE_MARKERS } from './heavy-lazy-libs.js';

// Budget for the EAGER bundle. Default 5.5MB, sized so that base64 inlining
// (+33%) plus worker boilerplate still lands inside the ~10MB assembled-script
// budget in Deployment::BundleSizeLimits. Override with
// WORKER_EAGER_BUNDLE_LIMIT_MB.
export const DEFAULT_EAGER_LIMIT_BYTES = Math.round(5.5 * 1024 * 1024);

export function eagerLimitBytes(env = process.env) {
  const override = parseFloat(env.WORKER_EAGER_BUNDLE_LIMIT_MB || '');
  return Number.isFinite(override) && override > 0
    ? Math.round(override * 1024 * 1024)
    : DEFAULT_EAGER_LIMIT_BYTES;
}

const mb = (bytes) => (bytes / 1024 / 1024).toFixed(2) + 'MB';

/**
 * Locate the Vite build manifest. Vite 5/6 writes it to dist/.vite/manifest.json;
 * older configs used dist/manifest.json.
 */
export function findManifestPath(distDir) {
  for (const rel of ['.vite/manifest.json', 'manifest.json']) {
    const p = path.join(distDir, rel);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Compute the set of chunk FILES in the eager graph: the entry chunk plus every
 * chunk transitively reachable via STATIC `imports`. `dynamicImports` are NOT
 * followed — those are lazy/async chunks.
 *
 * @param {object} manifest  parsed Vite manifest (keyed by source/chunk id)
 * @returns {Set<string>} eager chunk file paths (relative to dist)
 */
export function computeEagerChunkFiles(manifest) {
  const eager = new Set();
  const seen = new Set();
  const entryKeys = Object.keys(manifest).filter((k) => manifest[k] && manifest[k].isEntry);

  const walk = (key) => {
    if (!key || seen.has(key)) return;
    seen.add(key);
    const node = manifest[key];
    if (!node) return;
    if (node.file) eager.add(node.file);
    for (const imp of node.imports || []) walk(imp);
    // intentionally NOT following node.dynamicImports
  };

  for (const k of entryKeys) walk(k);
  return eager;
}

/**
 * Evaluate the deployed Worker bundle's eager size.
 *
 * @param {object} opts
 * @param {string} opts.distDir   Vite output dir (default ./dist)
 * @param {number} [opts.limitBytes]
 * @returns {{ ok:boolean, eagerBytes:number, limitBytes:number,
 *             eagerChunks:{file:string,bytes:number}[],
 *             heavyEager:string[], usedFallback:boolean, message:string }}
 */
export function evaluateWorkerBundle(opts = {}) {
  const distDir = opts.distDir || './dist';
  const limit = opts.limitBytes || eagerLimitBytes();
  const assetsDir = path.join(distDir, 'assets');

  const sizeOf = (file) => {
    const p = path.join(distDir, file);
    try {
      return fs.statSync(p).size;
    } catch {
      return 0;
    }
  };

  let eagerFiles;
  let usedFallback = false;
  const manifestPath = findManifestPath(distDir);

  if (manifestPath) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    eagerFiles = [...computeEagerChunkFiles(manifest)].filter((f) => f.endsWith('.js'));
  } else {
    // No manifest → can't distinguish eager vs lazy. Conservatively treat ALL
    // built JS as eager so a missing manifest never silently disables the gate.
    usedFallback = true;
    eagerFiles = fs.existsSync(assetsDir)
      ? fs.readdirSync(assetsDir).filter((f) => f.endsWith('.js')).map((f) => `assets/${f}`)
      : [];
  }

  const eagerChunks = eagerFiles
    .map((file) => ({ file, bytes: sizeOf(file) }))
    .sort((a, b) => b.bytes - a.bytes);
  const eagerBytes = eagerChunks.reduce((sum, c) => sum + c.bytes, 0);

  // Which heavy libs leaked into the EAGER graph?
  const heavyEager = [];
  for (const marker of HEAVY_LIB_MODULE_MARKERS) {
    const inEager = eagerChunks.some((c) => {
      try {
        return fs.readFileSync(path.join(distDir, c.file), 'utf8').includes(marker);
      } catch {
        return false;
      }
    });
    if (inEager) heavyEager.push(marker);
  }

  const ok = eagerBytes <= limit;
  return {
    ok,
    eagerBytes,
    limitBytes: limit,
    eagerChunks,
    heavyEager,
    usedFallback,
    message: ok
      ? buildOkMessage({ eagerBytes, limit, usedFallback })
      : buildViolationMessage({ eagerBytes, limit, eagerChunks, heavyEager, usedFallback })
  };
}

function buildOkMessage({ eagerBytes, limit, usedFallback }) {
  return (
    `✅ Eager Worker bundle ${mb(eagerBytes)} (under the ${mb(limit)} safe limit).` +
    (usedFallback ? ' [no manifest — measured all JS as eager]' : '')
  );
}

// Structured, model-readable correction. The `WORKER_BUNDLE_TOO_LARGE` marker
// is matched by Deployment::BuildErrorParser so the generation auto-fix loop
// feeds this back to the AI as a fixable error.
function buildViolationMessage({ eagerBytes, limit, eagerChunks, heavyEager, usedFallback }) {
  const lines = [];
  lines.push(
    `❌ WORKER_BUNDLE_TOO_LARGE: the eager (initially-loaded) Worker bundle is ` +
      `${mb(eagerBytes)}, over the ${mb(limit)} budget. A bundle this large parses ` +
      `slowly enough to risk Cloudflare's hard 1s Worker startup limit and makes ` +
      `first paint noticeably worse for every visitor. Fix the import graph — do ` +
      `not just raise the budget.`
  );
  lines.push('');
  lines.push('Largest eager chunks:');
  for (const c of eagerChunks.slice(0, 6)) {
    lines.push(`  - ${mb(c.bytes)}  ${c.file}`);
  }
  if (heavyEager.length) {
    lines.push('');
    lines.push(
      'Heavy libraries found in the EAGER bundle (these MUST be lazy-loaded so ' +
        'they split into their own on-demand chunk):'
    );
    for (const h of heavyEager) lines.push(`  - ${h}`);
    if (heavyEager.includes('recharts') || heavyEager.includes('victory-vendor')) {
      lines.push('');
      lines.push(
        'FIX (charts): move the chart JSX into its own component file and load it ' +
          'with React.lazy(() => import("./MyChart")). Import "recharts" and ' +
          '"@/components/ui/chart" ONLY inside that lazily-loaded file — NEVER at the ' +
          'top level of an eagerly-rendered route/component. A manualChunks name does ' +
          'NOT make a chunk lazy; only the dynamic import() boundary does.'
      );
    }
  } else {
    lines.push('');
    lines.push(
      'FIX: code-split the largest eager chunks behind dynamic import() / React.lazy() ' +
        'boundaries, or remove heavy dependencies, so the eager bundle drops under the limit.'
    );
  }
  if (usedFallback) {
    lines.push('');
    lines.push('[no Vite manifest found — measured ALL built JS as eager (conservative)]');
  }
  return lines.join('\n');
}

// CLI entry: `node scripts/worker-size-guard.js [distDir]`
const isMain = (() => {
  try {
    return path.resolve(process.argv[1] || '') === path.resolve(new URL(import.meta.url).pathname);
  } catch {
    return false;
  }
})();

if (isMain) {
  const distDir = process.argv[2] || './dist';
  const result = evaluateWorkerBundle({ distDir });
  if (result.ok) {
    console.log(result.message);
    process.exit(0);
  } else {
    console.error('\n' + result.message + '\n');
    process.exit(1);
  }
}
