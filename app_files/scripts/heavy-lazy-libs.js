// Single source of truth for "heavy, lazy-only" libraries.
//
// These packages are large enough that pulling them into the EAGER worker
// bundle blows the 5.5MB Overskill eager-bundle budget (issue #2383 —
// `recharts` glued to React did exactly that for a chart app). The budget is
// an Overskill startup-time/load-time budget, not Cloudflare's cap, which is
// 64 MiB uncompressed. They MUST only
// be reached behind a dynamic `import()` / `React.lazy()` boundary so Vite
// code-splits them into their own lazily-loaded, R2-offloadable chunk.
//
// Consumed by:
//   - scripts/validate-and-fix.js  (pre-build SOURCE check → corrective
//     feedback to the AI generation loop)
//   - scripts/worker-size-guard.js (post-build BUNDLE check → hard size gate)
//
// Keep this list in lockstep with:
//   - vite.config.ts manualChunks (the `parser-*` split rules + the recharts
//     auto-split note)
//   - app/services/ai/prompts/agent-prompt.txt ("Charts / heavy libraries" +
//     the BLOCKED/dynamic-import rules)
//   - app/services/deployment/build_error_parser.rb (the bundle-size patterns)

/**
 * @typedef {Object} HeavyLib
 * @property {string} key            stable id for messages
 * @property {RegExp} importSpecifier matches the module specifier in an
 *   `import ... from "<specifier>"` statement (the thing in quotes)
 * @property {string} reason         short why-it's-heavy note
 * @property {string} fix            the canonical lazy-load remediation
 */

/** @type {HeavyLib[]} */
export const HEAVY_LAZY_LIBS = [
  {
    key: 'recharts',
    importSpecifier: /^recharts(\/|$)/,
    reason: 'recharts + its d3/victory-vendor deps are ~380KB and depend on React',
    fix:
      'Render charts inside a component that is loaded with React.lazy(() => import("./MyChart")), ' +
      'and import recharts (and "@/components/ui/chart") ONLY inside that lazily-loaded component. ' +
      'Never import recharts at the top level of an eagerly-rendered route/component.'
  },
  {
    // The shadcn chart wrapper statically imports recharts, so importing it
    // eagerly drags recharts into the eager bundle too.
    key: 'chart-wrapper',
    importSpecifier: /^(@\/components\/ui\/chart|\.{1,2}\/(?:.*\/)?components\/ui\/chart)$/,
    reason: 'the shared chart wrapper (@/components/ui/chart) statically imports recharts',
    fix:
      'Move the chart JSX into its own component file and load it with ' +
      'React.lazy(() => import("./MyChart")). Import "@/components/ui/chart" only inside that file.'
  },
  {
    key: 'pdfjs-dist',
    importSpecifier: /^pdfjs-dist(\/|$)/,
    reason: 'pdfjs-dist is ~1.5MB',
    fix: 'Use the platform helper `parseDocument(env, url)` server-side, or `await import("pdfjs-dist")` inside the handler that needs it. Never import it at module top level.'
  },
  {
    key: 'mammoth',
    importSpecifier: /^mammoth(\/|$)/,
    reason: 'mammoth (.docx parser) is ~400KB',
    fix: 'Use `parseDocument(env, url)` instead, or `await import("mammoth")` only where needed.'
  },
  {
    key: 'xlsx',
    importSpecifier: /^xlsx(-js-style)?(\/|$)/,
    reason: 'xlsx is ~800KB',
    fix: 'Use `parseDocument(env, url)` instead, or `await import("xlsx")` only where needed.'
  },
  {
    key: 'tesseract.js',
    importSpecifier: /^tesseract\.js(\/|$)/,
    reason: 'tesseract.js (OCR) is multiple MB',
    fix: 'Load with `await import("tesseract.js")` only inside the handler that runs OCR.'
  },
  {
    key: '@tensorflow/tfjs',
    importSpecifier: /^@tensorflow\/tfjs(\/|$)/,
    reason: '@tensorflow/tfjs is multiple MB',
    fix: 'Load with `await import("@tensorflow/tfjs")` only where inference runs.'
  },
  {
    key: 'face-api.js',
    importSpecifier: /^face-api\.js(\/|$)/,
    reason: 'face-api.js bundles a TF model runtime',
    fix: 'Load with `await import("face-api.js")` only where it is used.'
  }
];

// Substrings used to detect a heavy lib's MODULES inside a built chunk
// (worker-size-guard.js operates on bundled file contents / Vite manifest
// module ids, not on import specifiers). Order/wording is not significant.
export const HEAVY_LIB_MODULE_MARKERS = [
  'recharts',
  'victory-vendor',
  'pdfjs-dist',
  'mammoth',
  'xlsx',
  'tesseract.js',
  '@tensorflow/tfjs',
  'face-api.js'
];

/**
 * Find heavy-lib violations in a single source file's text.
 * Scans only TOP-LEVEL static `import ... from "<specifier>"` statements
 * (ignores dynamic `import(...)` and `import type`).
 *
 * @param {string} source  file contents
 * @returns {{key:string, specifier:string, reason:string, fix:string, line:number}[]}
 */
export function findHeavyStaticImports(source) {
  const hits = [];
  // Static import statements only. `import(` (call) won't match because we
  // require `from`. `import type` is excluded (type-only, erased at build).
  const importRe = /^\s*import\s+(?!type\b)(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/gm;
  let m;
  while ((m = importRe.exec(source)) !== null) {
    const specifier = m[1];
    const lib = HEAVY_LAZY_LIBS.find((l) => l.importSpecifier.test(specifier));
    if (lib) {
      const line = source.slice(0, m.index).split('\n').length;
      hits.push({ key: lib.key, specifier, reason: lib.reason, fix: lib.fix, line });
    }
  }
  return hits;
}
