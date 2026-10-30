// Build script to bundle the worker with static assets
import esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';

// Read all files from dist directory and create a manifest
const distPath = './dist';
const files = {};

function readDirectory(dir, basePath = '') {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relativePath = path.join(basePath, entry.name);
    
    if (entry.isDirectory()) {
      readDirectory(fullPath, relativePath);
    } else {
      const content = fs.readFileSync(fullPath);
      files[relativePath.replace(/\\/g, '/')] = content.toString('base64');
    }
  }
}

readDirectory(distPath);

// Create the worker bundle with embedded assets
const workerCode = `
// Auto-generated worker with embedded static assets
const STATIC_FILES = ${JSON.stringify(files)};

function getMimeType(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  const mimeTypes = {
    'html': 'text/html',
    'css': 'text/css',
    'js': 'application/javascript',
    'json': 'application/json',
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'gif': 'image/gif',
    'svg': 'image/svg+xml',
    'ico': 'image/x-icon',
    'woff': 'font/woff',
    'woff2': 'font/woff2',
    'ttf': 'font/ttf',
    'otf': 'font/otf'
  };
  return mimeTypes[ext] || 'application/octet-stream';
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    let pathname = url.pathname;
    
    // Remove leading slash for lookup
    if (pathname.startsWith('/')) {
      pathname = pathname.slice(1);
    }
    
    // Try to find the exact file
    let fileContent = STATIC_FILES[pathname];
    
    // If not found and no extension, try index.html in that directory
    if (!fileContent && !pathname.includes('.')) {
      const indexPath = pathname ? pathname + '/index.html' : 'index.html';
      fileContent = STATIC_FILES[indexPath];
    }
    
    // Default to root index.html for SPA routing
    if (!fileContent) {
      fileContent = STATIC_FILES['index.html'];
      pathname = 'index.html';
    }
    
    if (fileContent) {
      const content = Uint8Array.from(atob(fileContent), c => c.charCodeAt(0));
      return new Response(content, {
        headers: {
          'Content-Type': getMimeType(pathname),
          'Cache-Control': pathname === 'index.html' ? 'no-cache' : 'max-age=31536000',
        }
      });
    }
    
    return new Response('Not found', { status: 404 });
  }
};
`;

fs.writeFileSync('./dist/worker.js', workerCode);
console.log('✅ Worker bundle created at dist/worker.js');