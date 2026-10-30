// R2 Asset Resolver for OverSkill Generated Apps
// Handles dynamic asset URL resolution between development and production
// Based on Cloudflare R2 bucket strategy

class AssetResolver {
  constructor() {
    // Get app-specific configuration from environment or embedded config
    this.appId = typeof window !== 'undefined' && window.APP_CONFIG?.APP_ID || process.env.VITE_APP_ID;
    this.environment = typeof window !== 'undefined' && window.APP_CONFIG?.ENVIRONMENT || process.env.VITE_ENVIRONMENT || 'production';
    
    // R2 Configuration
    this.r2BaseUrl = typeof window !== 'undefined' && window.APP_CONFIG?.R2_BASE_URL || process.env.VITE_R2_BASE_URL || 'https://assets.overskill.com';
    this.useLocalAssets = typeof window !== 'undefined' && window.APP_CONFIG?.USE_LOCAL_ASSETS || process.env.VITE_USE_LOCAL_ASSETS === 'true';
    
    // Cache for resolved URLs
    this.urlCache = new Map();
  }

  /**
   * Resolve asset path to full R2 URL
   * @param {string} assetPath - Relative path like 'images/hero.jpg' or '/assets/images/hero.jpg'
   * @returns {string} - Full R2 URL to asset or worker proxy path
   *
   * Path mapping:
   *   'images/hero.jpg' → 'src/assets/images/hero.jpg' → R2 URL
   *   '/assets/images/hero.jpg' → '/assets/images/hero.jpg' (worker proxy path, return as-is)
   *   'icons/logo.svg' → 'src/assets/icons/logo.svg' → R2 URL
   */
  resolve(assetPath) {
    // Return cached URL if available
    if (this.urlCache.has(assetPath)) {
      return this.urlCache.get(assetPath);
    }

    // IDEMPOTENCE: a value that is already a fully-resolved URL must pass through
    // untouched. Absolute URLs and /cdn-cgi/image/ transforms are already final;
    // re-resolving one strips its leading slash and prefixes the R2 asset base
    // onto it, producing `.../src/assets/cdn-cgi/image/https://...` which 404s.
    if (assetPath && (assetPath.startsWith('http://') || assetPath.startsWith('https://') ||
        assetPath.startsWith('/cdn-cgi/') || assetPath.includes('/cdn-cgi/image/'))) {
      this.urlCache.set(assetPath, assetPath);
      return assetPath;
    }

    // CRITICAL FIX: If path starts with /assets/, return as-is for worker proxy
    // Worker intercepts /assets/* requests and proxies to R2 with proper CORS
    // Bypassing this would cause double /assets/ prefix and direct R2 URLs (CORS blocked)
    if (assetPath && assetPath.startsWith('/assets/')) {
      console.log(`[AssetResolver] Worker proxy path detected: ${assetPath} (using as-is)`);
      this.urlCache.set(assetPath, assetPath);
      return assetPath;  // Return unchanged - worker will handle it
    }

    // Always use R2 (both dev and prod use R2, just different environment subfolders)
    const resolvedUrl = this.resolveR2(assetPath);

    // Cache the resolved URL
    this.urlCache.set(assetPath, resolvedUrl);
    return resolvedUrl;
  }

  /**
   * Resolve to R2 bucket URL (used for both development and production)
   * Development: https://assets.overskill.com/app-{id}/development/src/assets/...
   * Production: https://assets.overskill.com/app-{id}/production/src/assets/...
   */
  resolveR2(assetPath) {
    const cleanPath = assetPath.replace(/^\/+/, ''); // Remove leading slashes

    // CRITICAL FIX: Handle "assets/..." paths (from /assets/... after cleaning)
    // These should NOT get another "src/assets" prefix (causes double assets/)
    // Return as worker proxy path instead of R2 direct URL
    if (cleanPath.startsWith('assets/')) {
      const workerPath = `/${cleanPath}`;  // Re-add leading slash
      console.warn(`[AssetResolver] Converted ${assetPath} to worker proxy path: ${workerPath}`);
      return workerPath;  // Worker will handle R2 fetch
    }

    // Map shorthand paths to full R2 storage paths
    let finalPath = cleanPath;

    // Map "images/*" → "src/assets/images/*"
    if (cleanPath.startsWith('images/')) {
      finalPath = `src/assets/${cleanPath}`;
    }
    // Map "icons/*" → "src/assets/icons/*"
    else if (cleanPath.startsWith('icons/')) {
      finalPath = `src/assets/${cleanPath}`;
    }
    // Map "fonts/*" → "src/assets/fonts/*"
    else if (cleanPath.startsWith('fonts/')) {
      finalPath = `src/assets/${cleanPath}`;
    }
    // If already has src/assets prefix, use as-is
    else if (cleanPath.startsWith('src/assets/')) {
      finalPath = cleanPath;
    }
    // Fallback: prepend src/assets (only for paths that don't have any prefix)
    else if (!cleanPath.startsWith('app-') && !cleanPath.includes('/')) {
      finalPath = `src/assets/${cleanPath}`;
    }
    else {
      // Unknown pattern - return as worker proxy path (safe fallback)
      console.warn(`[AssetResolver] Unknown path pattern: ${assetPath}, using as worker proxy path`);
      return `/${cleanPath}`;
    }

    // Construct R2 URL with actual environment (development or production)
    // Format: https://assets.overskill.com/app-{slug}/{environment}/{full-path}
    return `${this.r2BaseUrl}/app-${this.appId}/${this.environment}/${finalPath}`;
  }

  /**
   * Preload an asset for better performance
   */
  preload(assetPath, as = 'image') {
    if (typeof document === 'undefined') return Promise.resolve();
    
    const url = this.resolve(assetPath);
    const link = document.createElement('link');
    link.rel = 'preload';
    link.href = url;
    link.as = as;
    
    return new Promise((resolve, reject) => {
      link.onload = resolve;
      link.onerror = reject;
      document.head.appendChild(link);
    });
  }

  /**
   * Get asset URL with error handling and fallback
   */
  getAssetUrl(assetPath, fallback = null) {
    try {
      return this.resolve(assetPath);
    } catch (error) {
      console.warn(`Failed to resolve asset: ${assetPath}`, error);
      return fallback || `/${assetPath}`;
    }
  }

  /**
   * Batch preload critical assets
   */
  async preloadCritical(assetPaths) {
    const promises = assetPaths.map(path => this.preload(path).catch(err => {
      console.warn(`Failed to preload: ${path}`, err);
    }));
    
    await Promise.allSettled(promises);
  }

  /**
   * Debug helper - log asset resolution
   */
  debug(assetPath) {
    console.log(`[AssetResolver] ${assetPath} -> ${this.resolve(assetPath)}`, {
      appId: this.appId,
      environment: this.environment,
      r2BaseUrl: this.r2BaseUrl,
      useLocalAssets: this.useLocalAssets
    });
  }
}

// Create singleton instance
const assetResolver = new AssetResolver();

// Export for different module systems
if (typeof module !== 'undefined' && module.exports) {
  // CommonJS
  module.exports = { assetResolver, AssetResolver };
} else if (typeof window !== 'undefined') {
  // Browser global
  window.assetResolver = assetResolver;
}

export { assetResolver, AssetResolver };
export default assetResolver;