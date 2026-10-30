/**
 * Vite Plugin: OverSkill R2 Asset Proxy (dev only)
 *
 * May 2026: Mirrors the production WFP dispatch worker's `/assets/*` → R2
 * proxy behavior in the E2B Vite dev server.
 *
 * ## Why this exists
 *
 * The agent prompt instructs the AI to reference images via worker-proxy
 * paths (`/assets/images/foo.jpg`). In production this is intercepted by
 * the dispatch worker (see `worker_api_template.rb:7658` — the
 * `R2_ASSETS[path]` branch) and proxied to R2.
 *
 * In dev (Vite serving inside an E2B sandbox)
 * there is no equivalent middleware. Vite tries to resolve the request
 * from its own filesystem, finds either nothing or a placeholder text
 * file at `src/assets/images/foo.jpg` (the AppFile content is an HTML
 * comment, not the binary), and 404s. Result: broken images in editor
 * preview only, even though production works.
 *
 * This plugin closes the gap by intercepting `/assets/*` requests in the
 * dev server and:
 *   1. Reading `src/{path}` on disk to extract the R2 URL from the
 *      placeholder comment if present (most accurate — uses the exact
 *      URL the file was uploaded to).
 *   2. Falling back to constructing the URL from `VITE_APP_ID`,
 *      `VITE_ENVIRONMENT`, and `VITE_R2_BASE_URL` (matches
 *      `assetResolver.js` and `R2AssetService#build_s3_key`).
 *   3. Fetching from R2 and streaming the response back, with the
 *      original Content-Type and a short Cache-Control.
 *
 * Also handles `/cdn-cgi/image/{params}/{r2Url}` requests by stripping
 * the Cloudflare image-resizing prefix and proxying the underlying R2
 * URL (in production CF runs the resize transform, in dev we just serve
 * the original — close enough for preview).
 *
 * ## Manual verification
 *
 * After deploy, in a generated app's editor preview:
 *   1. Use `generate-image` to produce `src/assets/images/test.png`.
 *   2. Reference it as `<img src="/assets/images/test.png">` in JSX.
 *   3. Refresh the editor preview iframe. Image must render.
 *   4. Let the sandbox sleep, then reload.
 *   5. Image must STILL render (no broken-image / alt-text fallback).
 *
 * If step 3 fails, check `[overskill-r2-assets]` logs in the sandbox
 * Vite output — they include the resolved upstream URL on each request.
 */

import fs from 'node:fs';
import path from 'node:path';

// Pull the R2 URL out of the placeholder file written by
// ImageGenerationService#save_image_reference_to_app_files. The full
// format is documented there; we only need the URL on the first line.
const PLACEHOLDER_RE = /<!--\s*Image hosted on R2:\s*(\S+?)\s*-->/;

// Extensions the production worker treats as static assets (from
// R2AssetService::ASSET_EXTENSIONS). We only intercept these — anything
// else under /assets/ falls through to Vite's normal handling so we
// don't accidentally break Vite-internal paths.
const PROXYABLE_EXT_RE =
  /\.(png|jpe?g|webp|gif|svg|ico|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|pdf)$/i;

/**
 * `/assets/foo/bar.png` → matches ✓
 * `/assets/index-abc123.js` → no match (Vite build output, but irrelevant in dev)
 * `/src/assets/foo.png`     → no match (Vite handles directly via @fs)
 */
function isProxyableAssetRequest(pathname) {
  return pathname.startsWith('/assets/') && PROXYABLE_EXT_RE.test(pathname);
}

/**
 * `/cdn-cgi/image/w=480,q=85,f=auto/https://assets.overskill.com/...`
 * → strip prefix, return the upstream URL.
 *
 * The CF image-resizing service is production-only; in dev we just serve
 * the original (un-resized) image. The browser still gets a working
 * picture, which is what matters for preview.
 */
function extractCdnCgiUpstream(pathname) {
  // Format: /cdn-cgi/image/{params}/{rest}
  // {params} is comma-separated kv pairs, no slashes
  // {rest} is everything else, possibly a full URL
  const match = pathname.match(/^\/cdn-cgi\/image\/[^/]+\/(.+)$/);
  return match ? match[1] : null;
}

/**
 * Construct an R2 URL from env vars, mirroring R2AssetService#build_s3_key
 * and the worker's R2_ASSETS map: `app-{obfuscated_id}/{environment}/{path}`.
 *
 * Path normalization mirrors assetResolver.js:
 *   /assets/images/x.png → src/assets/images/x.png
 *   (anything not already under src/assets) → prepend src/assets/
 */
function buildR2UrlFromEnv(assetPath, env) {
  const appId = env.VITE_APP_ID;
  if (!appId) return null;

  const environment = env.VITE_ENVIRONMENT || 'production';
  const baseUrl = env.VITE_R2_BASE_URL || 'https://assets.overskill.com';

  const cleanPath = assetPath.replace(/^\/+/, '');
  // /assets/foo → src/assets/foo
  // (cleanPath always starts with "assets/" given our isProxyableAssetRequest gate)
  const r2Path = cleanPath.startsWith('src/') ? cleanPath : `src/${cleanPath}`;

  return `${baseUrl}/app-${appId}/${environment}/${r2Path}`;
}

/**
 * Resolve `/assets/foo.png` → R2 URL, preferring the placeholder file's
 * embedded URL (exact match for what was uploaded) over the constructed
 * fallback (which depends on env vars being correct).
 */
function resolveR2Url(reqPath, serverRoot, env) {
  // Try the local placeholder first — its URL is authoritative because it
  // was written by Ruby at upload time.
  // /assets/foo.png → src/assets/foo.png
  const localPath = path.join(serverRoot, 'src', reqPath);

  try {
    if (fs.existsSync(localPath)) {
      const content = fs.readFileSync(localPath, 'utf8');
      const match = content.match(PLACEHOLDER_RE);
      if (match) return match[1];
    }
  } catch (err) {
    // Fall through to constructed URL — we don't want a transient FS
    // error to take out asset serving.
    // eslint-disable-next-line no-console
    console.warn(
      `[overskill-r2-assets] Could not read placeholder at ${localPath}: ${err.message}`
    );
  }

  return buildR2UrlFromEnv(reqPath, env);
}

async function proxyToR2(res, upstreamUrl, reqPath) {
  let upstream;
  try {
    upstream = await fetch(upstreamUrl);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `[overskill-r2-assets] Network error fetching ${upstreamUrl}: ${err.message}`
    );
    res.statusCode = 502;
    res.end(`R2 proxy network error: ${err.message}`);
    return;
  }

  if (!upstream.ok) {
    // eslint-disable-next-line no-console
    console.warn(
      `[overskill-r2-assets] R2 ${upstream.status} for ${reqPath} → ${upstreamUrl}`
    );
    res.statusCode = upstream.status;
    res.end(`R2 returned ${upstream.status}`);
    return;
  }

  const contentType =
    upstream.headers.get('content-type') || 'application/octet-stream';
  const buffer = Buffer.from(await upstream.arrayBuffer());

  res.statusCode = 200;
  res.setHeader('Content-Type', contentType);
  // Short cache in dev — we want fresh images after re-generation but
  // don't want to hammer R2 during HMR cycles.
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.end(buffer);
}

export default function overskillR2AssetsPlugin() {
  let serverRoot;
  let env = {};

  return {
    name: 'overskill-r2-assets-proxy',
    // Dev-only — production builds rely on the worker template's R2_ASSETS
    // map injected at deploy time.
    apply: 'serve',

    configResolved(resolved) {
      serverRoot = resolved.root;
      env = resolved.env || {};
    },

    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const rawUrl = req.url || '';
        // Strip query string for the proxy decision; we'll forward the
        // path-only form to R2 since R2 doesn't honor query params.
        const pathname = rawUrl.split('?')[0];

        // Branch 1: Cloudflare image-resizing wrapper paths (production only).
        // In dev, just serve the original underlying URL.
        if (pathname.startsWith('/cdn-cgi/image/')) {
          const upstream = extractCdnCgiUpstream(pathname);
          if (!upstream) return next();
          // Upstream may be an absolute URL or another /assets/... path.
          // If absolute, fetch directly; else resolve via the same logic.
          const upstreamUrl = /^https?:\/\//i.test(upstream)
            ? upstream
            : resolveR2Url(
                upstream.startsWith('/') ? upstream : `/${upstream}`,
                serverRoot,
                env
              );
          if (!upstreamUrl) return next();
          await proxyToR2(res, upstreamUrl, pathname);
          return;
        }

        // Branch 2: Worker-proxy `/assets/...` paths.
        if (!isProxyableAssetRequest(pathname)) return next();

        const upstreamUrl = resolveR2Url(pathname, serverRoot, env);
        if (!upstreamUrl) {
          // No VITE_APP_ID and no placeholder — nothing we can do; let
          // Vite's default 404 surface so the issue is visible.
          // eslint-disable-next-line no-console
          console.warn(
            `[overskill-r2-assets] Could not resolve R2 URL for ${pathname} (missing VITE_APP_ID and no placeholder file)`
          );
          return next();
        }

        await proxyToR2(res, upstreamUrl, pathname);
      });
    },
  };
}
