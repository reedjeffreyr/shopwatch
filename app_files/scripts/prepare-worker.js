#!/usr/bin/env node

// This script prepares the Vite build output for Cloudflare Workers deployment
// It bundles the static files into a worker that serves them
//
// May 2026: Extended to bundle root-level static assets (PWA manifest,
// service worker, icons, etc.) with correct MIME types. The previous version
// only served /assets/* and would 404 on /manifest.webmanifest, /sw.js, and
// /overskill-logo.svg — breaking PWA installability in production.

import fs from 'fs';
import path from 'path';
import { evaluateWorkerBundle } from './worker-size-guard.js';

// Ensure dist directory exists
if (!fs.existsSync('./dist')) {
  console.error('❌ dist directory not found. Run "npm run build" first.');
  process.exit(1);
}

// Worker bundle-size guard (issue #2383) — LAST LINE OF DEFENSE.
// Fail the build NOW with a clear, actionable message if the eager bundle
// would exceed Cloudflare's Worker asset limit, instead of letting it fail
// later at the Cloudflare deploy step with a cryptic error (the old silent,
// credit-burning publish loop). The same WORKER_BUNDLE_TOO_LARGE message is
// recognized by Deployment::BuildErrorParser so the generation auto-fix loop
// feeds it back to the AI to lazy-load the offending library.
{
  const sizeResult = evaluateWorkerBundle({ distDir: './dist' });
  if (!sizeResult.ok) {
    console.error('\n' + sizeResult.message + '\n');
    process.exit(1);
  }
  console.log('✅ ' + sizeResult.message.replace(/^✅ /, ''));
}

// Read the built index.html file
const indexHtml = fs.readFileSync('./dist/index.html', 'utf-8');

// MIME type lookup for files served at the dist root (PWA artifacts, icons,
// favicons, etc). Anything not in this map is logged and excluded from the
// bundle (see warning below). Service workers MUST be served from a parent
// path of their scope, so sw.js at the root is required for scope: "/".
//
// Extending: when adding a new asset type, add the extension here. Modern web
// fonts (.woff2), image formats (.webp, .avif), and audio (.mp3) are common
// candidates. The warning below ensures new files don't silently 404.
const ROOT_FILE_MIME_TYPES = {
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
  '.js': 'application/javascript',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain',
  '.xml': 'application/xml',
};

// Files we deliberately exclude from the bundle (they're either the entry
// point, build artifacts, or not meant to ship).
const ROOT_FILES_EXCLUDE = new Set([
  'index.html',
  'index.js',
  'component-mappings.json',
]);

// Read all CSS and JS files from dist/assets (these get content-hashed and
// served with immutable cache headers under /assets/*)
const assets = {};
const assetsDir = './dist/assets';
if (fs.existsSync(assetsDir)) {
  const files = fs.readdirSync(assetsDir);
  files.forEach(file => {
    const filePath = path.join(assetsDir, file);
    const content = fs.readFileSync(filePath, 'utf-8');
    assets[`/assets/${file}`] = {
      content,
      contentType: file.endsWith('.css') ? 'text/css' : 'application/javascript',
      cacheControl: 'public, max-age=31536000, immutable',
    };
  });
  console.log(`✅ Bundled ${Object.keys(assets).length} asset files`);
}

// Read root-level static files (manifest.webmanifest, sw.js, registerSW.js,
// workbox-*.js, overskill-logo.svg, etc.). These are served at their root
// paths (e.g. GET /manifest.webmanifest, GET /sw.js).
//
// Service workers and the manifest must NOT be cached aggressively or the
// browser won't pick up updates. Static icons get a moderate cache.
const rootFiles = {};
const distRoot = './dist';
if (fs.existsSync(distRoot)) {
  fs.readdirSync(distRoot).forEach(name => {
    const fullPath = path.join(distRoot, name);
    const stat = fs.statSync(fullPath);
    if (!stat.isFile()) return;
    if (ROOT_FILES_EXCLUDE.has(name)) return;
    if (name.startsWith('.')) return;

    const ext = path.extname(name).toLowerCase();
    const contentType = ROOT_FILE_MIME_TYPES[ext];
    if (!contentType) {
      // Don't silently drop unknown extensions — log a warning so adding a new
      // asset type (e.g. .webp, .avif, .woff2) without updating the whitelist
      // surfaces in the build log instead of mysteriously 404'ing in prod.
      // Add the new ext to ROOT_FILE_MIME_TYPES above to fix.
      console.warn(`⚠️  prepare-worker: skipping ${name} — no MIME mapping for "${ext}". Add it to ROOT_FILE_MIME_TYPES.`);
      return;
    }

    // Service worker + manifest must be re-validated on every load so PWA
    // updates roll out. Other root assets (icons, etc.) can cache for a day.
    const isCriticalPwaFile =
      name === 'sw.js' ||
      name === 'manifest.webmanifest' ||
      name === 'registerSW.js';
    const cacheControl = isCriticalPwaFile
      ? 'no-cache, no-store, must-revalidate'
      : 'public, max-age=86400';

    // SVG can be read as utf-8; binary formats (PNG/JPG/ICO) need base64.
    const isText = ext === '.svg' || ext === '.json' || ext === '.webmanifest' ||
                   ext === '.js' || ext === '.txt' || ext === '.xml';
    const content = isText
      ? fs.readFileSync(fullPath, 'utf-8')
      : fs.readFileSync(fullPath).toString('base64');

    rootFiles[`/${name}`] = {
      content,
      contentType,
      cacheControl,
      isBase64: !isText,
    };
  });
  console.log(`✅ Bundled ${Object.keys(rootFiles).length} root-level files (PWA manifest, SW, icons)`);
}

// Create the worker code with embedded assets
const workerCode = `
// Static file server for Cloudflare Workers
// Serves the Vite-built React SPA with all assets embedded.
//
// Routes:
//   /assets/*                        — content-hashed JS/CSS, immutable cache
//   /sw.js, /manifest.webmanifest    — PWA artifacts, no-cache (must revalidate)
//   /<root-asset>                    — icons, favicons, etc. (24h cache)
//   /*                               — SPA route, returns index.html (no-cache)

const indexHtml = ${JSON.stringify(indexHtml)};
const assets = ${JSON.stringify(assets)};
const rootFiles = ${JSON.stringify(rootFiles)};

function serveAsset(asset) {
  let body;
  if (asset.isBase64) {
    // Decode base64 → Uint8Array for binary files
    const binary = atob(asset.content);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    body = bytes;
  } else {
    body = asset.content;
  }
  return new Response(body, {
    headers: {
      'Content-Type': asset.contentType,
      'Cache-Control': asset.cacheControl || 'public, max-age=31536000, immutable',
    },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // 1. Content-hashed assets at /assets/*
    if (path.startsWith('/assets/')) {
      const asset = assets[path];
      if (asset) return serveAsset(asset);
      return new Response('Asset not found', { status: 404 });
    }

    // 2. Root-level static files (PWA manifest, sw.js, icons, etc.)
    if (rootFiles[path]) {
      return serveAsset(rootFiles[path]);
    }

    // 3. Legacy favicon fallback (return 204 if no real favicon shipped)
    if (path === '/favicon.ico') {
      return new Response(null, { status: 204 });
    }

    // 4. SPA fallback — every other route renders index.html
    return new Response(indexHtml, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
      },
    });
  },
};
`;

// Write the worker file
fs.writeFileSync('./dist/index.js', workerCode);
console.log('✅ Created dist/index.js for Workers deployment');
console.log(`📦 Bundled index.html + ${Object.keys(assets).length} hashed assets + ${Object.keys(rootFiles).length} root files into worker`);
