import { defineConfig } from "vite";
// IMPORTANT: Using @vitejs/plugin-react (Babel) instead of @vitejs/plugin-react-swc
// This is required because our stable ID injection plugin uses Babel AST transforms.
// SWC plugins are written in Rust and don't support our JavaScript Babel plugin.
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import path from "path";
import overskillStableIds from "./vite-plugin-overskill-ids.js";
import overskillSdkImportGuard from "./vite-plugin-sdk-import-guard.js";
import overskillR2Assets from "./vite-plugin-overskill-r2-assets.js";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  server: {
    // Use IPv4 (0.0.0.0) instead of IPv6 (::) for container compatibility.
    host: "0.0.0.0",
    port: 8080,
    // Allow dynamic E2B/local preview hostnames.
    // This prevents "Blocked request" errors when accessing via dynamic hostnames
    allowedHosts: true,
    // HMR cascade fix (Jan 2026): Debounce file changes to prevent rapid-fire HMR updates
    // When AI writes multiple files, this waits for all writes to settle before triggering HMR
    watch: {
      // CRITICAL (Feb 2026): Enable polling for Tailwind CSS JIT detection in containers
      // In containerized environments, file changes via
      // HTTP PUT may not trigger native filesystem events (inotify). Without polling,
      // chokidar doesn't detect new files → Tailwind JIT doesn't scan for new classes
      // → CSS not rebuilt → new utility classes missing → "unstyled" elements
      // See: https://github.com/vitejs/vite/issues/15460
      // Also set by E2bPreviewService via CHOKIDAR_USEPOLLING=true.
      usePolling: true,
      // Wait 2000ms (2 seconds) after last file change before triggering HMR rebuild
      // This batches ALL file writes from a single AI operation into ONE HMR update
      // E2B file sync uploads files in batches that can span multiple polls.
      // which can take 500ms-2s for large changesets. Without this delay,
      // Vite processes files in multiple waves, each potentially causing a full reload.
      aggregateTimeout: 2000,
      // Poll interval in ms - balance between responsiveness and CPU usage
      interval: 150,
    },
    hmr: {
      timeout: 5000,
    },
    // Pre-transform common files on server start (Vite 5.4+)
    // This ensures modules are compiled before the browser requests them
    // Reduces cold-start latency in E2B previews.
    warmup: {
      clientFiles: [
        './src/main.tsx',
        './src/App.tsx',
        './src/index.css',
        './src/App.css',
      ],
    },
  },
  // Pre-bundle dependencies to avoid 502 errors during compilation
  // FIX (Jan 2026): Without this, first request to lucide-react, @radix-ui, etc.
  // returns 502 while Vite compiles them on-demand, causing reload cascade.
  optimizeDeps: {
    // Force include commonly-used deps so they're pre-bundled on server start
    include: [
      'react',
      'react-dom',
      'react-dom/client',
      'react-router-dom',
      'lucide-react',
      '@radix-ui/react-accordion',
      '@radix-ui/react-alert-dialog',
      '@radix-ui/react-avatar',
      '@radix-ui/react-checkbox',
      '@radix-ui/react-dialog',
      '@radix-ui/react-dropdown-menu',
      '@radix-ui/react-label',
      '@radix-ui/react-popover',
      '@radix-ui/react-scroll-area',
      '@radix-ui/react-select',
      '@radix-ui/react-separator',
      '@radix-ui/react-slot',
      '@radix-ui/react-switch',
      '@radix-ui/react-tabs',
      '@radix-ui/react-toast',
      '@radix-ui/react-tooltip',
      '@tanstack/react-query',
      'class-variance-authority',
      'clsx',
      'tailwind-merge',
      'sonner',
      'date-fns',
    ],
    // Don't re-bundle on every server restart if deps haven't changed
    // This speeds up sandbox warm starts.
    force: false,
    // Exclude deps that don't need pre-bundling or cause issues
    exclude: [],
  },
  plugins: [
    // CRITICAL: overskillStableIds MUST run BEFORE react()
    // The plugin has enforce: 'pre' which makes it run before other plugins.
    // This plugin injects data-overskill-id attributes into JSX elements
    // for reliable visual editing element-to-source mapping.
    overskillStableIds({
      mappingFile: 'dist/component-mappings.json',
      debug: mode === 'development'
    }),
    // Apr 2026 (Todd's QA): catch hallucinated `{ useEntity }` /
    // `{ useEntities }` imports from `overskill-sdk` at TRANSFORM TIME
    // and throw a Vite-formatted error with the canonical fix. Without
    // this, the import would compile and break at runtime with a
    // useless "useEntity is not defined" + blank screen. See
    // vite-plugin-sdk-import-guard.js for the rationale.
    overskillSdkImportGuard(),
    // May 2026: Mirror the production WFP worker's `/assets/*` → R2 proxy in
    // the Vite dev server, so the E2B editor preview renders generated images
    // consistently with production. The
    // agent prompt instructs the AI to reference images via worker-proxy
    // paths like `/assets/images/foo.jpg`; without this plugin, those paths
    // 404 in dev because there is no worker layer in front of Vite.
    // See vite-plugin-overskill-r2-assets.js for the full rationale.
    overskillR2Assets(),
    react(),
    // PWA support (May 2026): Generated apps install on iOS / Android home screen
    // and run full-screen as standalone PWAs. iOS 16.4+ enables Web Push for installed
    // PWAs (used by overskill-sdk push.subscribe()). Per-app branding (name,
    // theme_color, icon) overrides happen via injected env vars at build time —
    // see prepare-worker.js for the per-app customization point.
    //
    // devOptions.enabled: false — service worker is dev-disabled to avoid HMR conflicts
    // and the editor-iframe instrumentation in index.html. SW only runs on the
    // deployed Cloudflare Worker for end users.
    VitePWA({
      registerType: "autoUpdate",
      // FM-2 (Jul 2026): SW registration + the post-deploy update flow are
      // owned by src/lib/pwa-update.ts (workbox-window), imported from
      // main.tsx. injectRegister: false stops the plugin from injecting its
      // own registerSW.js <script>, which registered the SW with NO update
      // UX — open tabs (and commonly the first reload after a deploy) kept
      // serving the previous deploy's precached bundle. Do not flip this
      // back without removing the pwa-update import in main.tsx, or the SW
      // would be double-registered.
      injectRegister: false,
      includeAssets: ["overskill-logo.svg", "vite.svg"],
      manifest: {
        name: process.env.VITE_PWA_NAME || "OverSkill App",
        short_name: process.env.VITE_PWA_SHORT_NAME || "OverSkill",
        description:
          process.env.VITE_PWA_DESCRIPTION ||
          // Neutral, app-agnostic fallback (issue #3670): the OverSkill
          // marketing string shipped as every app's manifest description.
          // The deployed Worker rewrites this to the app's own description at
          // serve time (patchWebManifest, from VITE_APP_DESCRIPTION); this is
          // only the pre-rewrite build default.
          "A web app built with OverSkill.",
        theme_color: process.env.VITE_PWA_THEME_COLOR || "#0a0a0a",
        background_color: process.env.VITE_PWA_BG_COLOR || "#ffffff",
        display: "standalone",
        orientation: "any",
        scope: "/",
        start_url: "/",
        icons: [
          {
            src: "overskill-logo.svg",
            sizes: "any",
            type: "image/svg+xml",
            purpose: "any maskable",
          },
        ],
      },
      workbox: {
        // ONE service worker owns root scope, and it handles push (#3705 /
        // #4770 / #4200 — three confirmed customers).
        //
        // This app used to register TWO scripts on scope "/": this Workbox
        // precache worker at /sw.js (via src/lib/pwa-update.ts) and the SDK's
        // /sw-push.js (via overskill.push.subscribe()). A registration is keyed
        // by SCOPE, so registering a different script URL at an existing scope
        // REPLACES that registration — they clobbered each other. On an
        // installed Android home-screen PWA the Workbox worker reliably won, so
        // the push event reached a worker with no `push` listener and Android
        // rendered its own generic fallback instead of the app's branded
        // notification. Push looked healthy at every layer: the relay reported
        // delivered, and nothing appeared on the device.
        //
        // importScripts pulls the push/notificationclick handlers INTO this one
        // worker, so there is exactly one registration and it can receive push.
        // Do NOT "fix" this by giving /sw-push.js its own non-root scope: the
        // two registrations would then also fight over which one clients.claim()
        // last, which is the #4200 update-banner loop.
        importScripts: ["/sw-push.js"],
        // Do NOT precache the webmanifest (issue #3670). The deployed
        // Cloudflare Worker rewrites /manifest.webmanifest at serve time
        // (patchWebManifest — app name, description, theme/background colors,
        // icon) and serves it no-store. Precaching the stale BUILD-TIME
        // manifest lets an already-installed PWA bypass the network entirely,
        // so the patched manifest never reaches the device — which is why an
        // app rename / rebrand appeared stuck for users.
        // ⚠️ NO `html` IN THIS LIST, AND NEVER ADD IT BACK (Aug 2026).
        //
        // The comment below this block used to say "Don't precache HTML" while
        // `html` was still in globPatterns, so every build shipped an
        // `{url:"index.html",revision:"<hash>"}` entry in the precache
        // manifest. `precacheAndRoute` installs a CACHE-FIRST route for every
        // manifest entry, and the precached index.html answers `/` — so a
        // controlled client served the OLD deploy's index.html, which points
        // at the OLD deploy's content-hashed `/assets/index-<hash>.js`, which
        // is ALSO precached. The result is a fully self-consistent stale app
        // that survives every publish: the origin is correct, curl is correct,
        // and the member sees a months-old build indefinitely. It also makes
        // each new publish look like a no-op, and — once the old bundle's
        // routes no longer match the current data/auth shape — renders the
        // app's own "404 Page not found" to a signed-in member.
        //
        // `navigateFallback: null` did NOT prevent this. navigateFallback is
        // the OFFLINE fallback for navigations that miss; it has no effect on
        // a precache route that matches `/` and HITS.
        //
        // HTML must always be NETWORK-FIRST. It is the only file that is not
        // content-hashed, so it is the one file a stale copy of can pin an
        // entire app to a dead build.
        globPatterns: ["**/*.{js,css,svg,png,ico}"],
        globIgnores: ["**/*.html"],
        // Navigations: network-first with a short timeout, so a member always
        // gets the current index.html when online and still gets an offline
        // shell when they are not. NEVER change this to CacheFirst or
        // StaleWhileRevalidate — see above.
        runtimeCaching: [
          {
            urlPattern: ({ request }) => request.mode === "navigate",
            handler: "NetworkFirst",
            options: {
              cacheName: "overskill-html",
              networkTimeoutSeconds: 5,
              expiration: { maxEntries: 8, maxAgeSeconds: 60 * 60 * 24 },
              cacheableResponse: { statuses: [200] },
            },
          },
        ],
        cleanupOutdatedCaches: true,
        skipWaiting: true,
        clientsClaim: true,
        navigateFallback: null,
        // Skip large vendor chunks from precache (they're already content-hashed
        // and cache via standard HTTP cache headers)
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024, // 3MB
      },
      devOptions: {
        // Disable SW in dev to avoid conflicts with Vite HMR + editor-iframe
        // instrumentation (overskill-iframe-reloading, vite:error, etc.)
        enabled: false,
      },
    }),
  ].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
    // CRITICAL: Deduplicate React to prevent multiple instances
    // This fixes "Cannot read properties of undefined (reading 'createContext')"
    dedupe: ['react', 'react-dom', 'react-router-dom'],
    // CRITICAL: Explicit conditions to prevent @tanstack/custom-condition resolution failure
    // @tanstack/react-query v5.83+ exports a `@tanstack/custom-condition` pointing to ./src/index.ts
    // Vite 6.3+ now errors when this condition resolves to a missing/non-bundleable TS file
    // By explicitly listing conditions, Vite skips unknown ones and uses `import` correctly
    conditions: ['import', 'module', 'browser', 'default'],
  },
  build: {
    // Generate manifest for asset mapping
    manifest: true,

    // Ensure compatibility with modern browsers and Cloudflare Workers
    target: 'es2022',
    minify: mode === 'production' ? 'terser' : 'esbuild',

    // Generate proper content-hashed filenames
    rollupOptions: {
      output: {
        // Use content hashing for cache busting
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash].[ext]',

        // Use standard ES modules format (default)
        // WorkerScriptAssembler embeds all chunks in the worker.
        // and serve them with proper MIME types for module loading
        format: 'es',

        // Smart code splitting for optimal loading performance
        // CRITICAL: Keep React and React-dependent libs in same chunk to avoid
        // "Cannot read properties of undefined (reading 'createContext')" errors
        manualChunks: (id) => {
          if (id.includes('node_modules')) {
            // Heavy parser / ML / document packages must stay out of the
            // eager React vendor bundle. The agent prompt requires
            // `await import(...)`; these chunk names let Rollup keep those
            // lazy imports independently loadable and eligible for R2 offload.
            if (id.includes('pdfjs-dist')) return 'parser-pdfjs';
            if (id.includes('mammoth')) return 'parser-mammoth';
            if (id.includes('xlsx')) return 'parser-xlsx';
            if (id.includes('jszip')) return 'parser-jszip';
            if (id.includes('tesseract.js')) return 'parser-tesseract';
            if (id.includes('@tensorflow/tfjs')) return 'parser-tensorflow';
            if (id.includes('face-api.js')) return 'parser-face-api';
            if (id.includes('pdf-lib')) return 'parser-pdf-lib';
            if (id.includes('/docx/')) return 'parser-docx';
            if (id.includes('html2canvas')) return 'parser-html2canvas';
            if (id.includes('jspdf')) return 'parser-jspdf';

            // Charts: recharts + its transitive d3 / victory-vendor / animation
            // deps (~380KB). These are the issue #2383 offender — a chart app
            // blew past Cloudflare's 6MB eager Worker bundle because recharts
            // was glued into the React 'vendor' chunk.
            //
            // ⚠️ DO NOT force recharts into a manualChunk. Two traps:
            //   1. A manualChunks NAME does NOT make a chunk lazy — only a
            //      dynamic import() boundary at the consumer does. Naming a
            //      chunk 'charts' that is statically imported from an eager
            //      route still ships it eager.
            //   2. recharts DEPENDS ON React. When recharts is assigned its own
            //      manualChunk AND React is assigned 'vendor', Rollup MERGES the
            //      two chunks back together (the chart chunk imports the React
            //      chunk) and the merged result rides along with React's eager
            //      load — defeating the split entirely. (The parser-* chunks
            //      above DON'T hit this because they're React-INDEPENDENT, so
            //      Rollup never merges them into 'vendor'.)
            //
            // The fix: let Vite AUTO-SPLIT recharts on its dynamic-import
            // boundary (return undefined here). When a chart is rendered via a
            // React.lazy()/dynamic-import boundary (see src/components/ui/chart.tsx
            // and the "Charts / heavy libraries" rule in the agent prompt),
            // recharts lands in its own lazy async chunk (loaded on demand, and
            // R2-offloadable at deploy time via the platform's generic
            // hashed-chunk + budget offload passes). If a generated app instead
            // statically imports recharts from an eager route, auto-split
            // correctly leaves it eager and the prepare-worker.js size guard +
            // validate-and-fix.js flag it back to the agent to lazy-load.
            if (id.includes('recharts') ||
                id.includes('react-smooth') ||
                id.includes('victory-vendor') ||
                id.includes('internmap') ||
                /[\\/]d3-[a-z-]+[\\/]/.test(id) ||
                /[\\/]d3[\\/]/.test(id)) {
              return undefined; // auto-split — never glue charts to eager React
            }

            // React ecosystem - MUST be in same chunk
            if (id.includes('react') ||
                id.includes('react-dom') ||
                id.includes('react-router') ||
                id.includes('@radix-ui') ||
                id.includes('cmdk') ||
                id.includes('vaul') ||
                id.includes('sonner') ||
                id.includes('@tanstack')) {
              return 'vendor';  // All React-dependent libs together
            }
            // Utility libraries with no React dependency
            if (id.includes('date-fns') ||
                id.includes('clsx') ||
                id.includes('tailwind-merge') ||
                id.includes('class-variance-authority') ||
                id.includes('zod')) {
              return 'vendor-utils';
            }
            return 'vendor';
          }
        }
      }
    },

    // Terser options for production
    terserOptions: {
      compress: {
        drop_console: mode === 'production',
        drop_debugger: true
      }
    }
  }
}));
