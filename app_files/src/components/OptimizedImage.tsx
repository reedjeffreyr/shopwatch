// OptimizedImage - Cloudflare Image Optimization Component
// Uses /cdn-cgi/image/ URLs for automatic WebP/AVIF conversion and resizing
// Bypasses Workers entirely for best performance with WFP architecture

import React, { useState, useRef, useEffect, forwardRef } from 'react';
import { scheduleLazyLoadFallback, LAZY_LOAD_FALLBACK_MS } from '@/lib/lazyLoad';
import { shouldOptimizeImages } from '@/lib/imageOrigin';

/**
 * Configuration for image optimization
 * These can be overridden via window.APP_CONFIG
 */
const getConfig = () => {
  const config = typeof window !== 'undefined' ? (window as any).APP_CONFIG : {};
  return {
    appId: config?.APP_ID || (import.meta as any).env?.VITE_APP_ID || '',
    // May 2026: defaults aligned with R2AssetService#build_s3_key
    // (`Rails.env` = `production` on Render → R2 layout is
    // `app-{id}/production/...`) and assetResolver.js. The previous
    // 'preview' default produced 404s because no R2 keys live under that
    // prefix — fix #2 from the May 2026 image-rendering investigation.
    environment: config?.ENVIRONMENT || (import.meta as any).env?.VITE_ENVIRONMENT || 'production',
    r2BaseUrl: config?.R2_BASE_URL || (import.meta as any).env?.VITE_R2_BASE_URL || 'https://assets.overskill.com',
    // Enable/disable optimization (useful for debugging)
    enableOptimization: config?.ENABLE_IMAGE_OPTIMIZATION !== false,
  };
};

/**
 * Default responsive breakpoints (in pixels)
 * Optimized for common device widths
 */
const DEFAULT_WIDTHS = [480, 800, 1200, 1920];

/**
 * Build Cloudflare /cdn-cgi/image/ transformation URL
 *
 * @param {string} originalUrl - Full URL to original image in R2
 * @param {object} options - Transformation options
 * @returns {string} - /cdn-cgi/image/ URL
 */
export const isAlreadyResolvedAssetUrl = (value: string | null | undefined): boolean => {
  if (!value) return false;
  // An already-optimized URL, in either relative ('/cdn-cgi/image/...') or
  // absolute ('https://host/cdn-cgi/image/...') form. Resolving one of these a
  // second time prefixes the R2 asset base onto it and re-wraps it, producing a
  // permanent 404 (see the double-prefix regression this guard exists to stop).
  return value.startsWith('/cdn-cgi/') || value.includes('/cdn-cgi/image/');
};

const buildCdnCgiUrl = (originalUrl: string, options: {
  width?: number;
  height?: number;
  quality?: number;
  format?: string;
  fit?: string;
  metadata?: string;
} = {}) => {
  // Idempotence: never wrap a URL that is already a /cdn-cgi/image/ transform.
  if (isAlreadyResolvedAssetUrl(originalUrl)) {
    return originalUrl;
  }

  const {
    width,
    height,
    quality = 85,
    format = 'auto', // auto = WebP/AVIF based on browser support
    fit = 'scale-down', // Never enlarge images
    metadata = 'none', // Strip EXIF data
  } = options;

  // Build transformation parameters
  const params: string[] = [];
  if (width) params.push(`w=${width}`);
  if (height) params.push(`h=${height}`);
  params.push(`q=${quality}`);
  params.push(`f=${format}`);
  params.push(`fit=${fit}`);
  params.push(`metadata=${metadata}`);

  const transformString = params.join(',');

  // /cdn-cgi/image/ URL format
  return `/cdn-cgi/image/${transformString}/${originalUrl}`;
};

/**
 * Build full R2 URL for an image path
 *
 * @param {string} imagePath - Image path (e.g., '/assets/images/hero.jpg' or 'images/hero.jpg')
 * @param {object} config - App configuration
 * @returns {string} - Full R2 URL
 */
const buildR2Url = (imagePath: string | null | undefined, config: ReturnType<typeof getConfig>): string => {
  // If already a full URL, return as-is
  if (imagePath?.startsWith('http://') || imagePath?.startsWith('https://')) {
    return imagePath;
  }

  // If already resolved to a /cdn-cgi/image/ transform, return as-is. Without
  // this the leading '/' is stripped and the R2 base is prefixed onto an
  // already-complete URL, yielding
  // `${r2BaseUrl}/app-{id}/{env}/src/assets/cdn-cgi/image/...` — a 404.
  if (isAlreadyResolvedAssetUrl(imagePath)) {
    return imagePath as string;
  }

  const { appId, environment, r2BaseUrl } = config;

  // Clean the path
  let cleanPath = imagePath?.replace(/^\/+/, '') || '';

  // Map common path patterns to R2 structure
  if (cleanPath.startsWith('assets/images/')) {
    cleanPath = `src/${cleanPath}`;
  } else if (cleanPath.startsWith('images/')) {
    cleanPath = `src/assets/${cleanPath}`;
  } else if (!cleanPath.startsWith('src/')) {
    cleanPath = `src/assets/${cleanPath}`;
  }

  // Build full R2 URL
  // Format: https://assets.overskill.com/app-{id}/{environment}/{path}
  return `${r2BaseUrl}/app-${appId}/${environment}/${cleanPath}`;
};

interface OptimizedImageProps extends React.ImgHTMLAttributes<HTMLImageElement> {
  src: string;
  alt?: string;
  className?: string;
  /** Explicit width - REQUIRED for preventing CLS */
  width?: number | string;
  /** Explicit height - REQUIRED for preventing CLS */
  height?: number | string;
  sizes?: string;
  quality?: number;
  widths?: number[];
  loading?: 'lazy' | 'eager';
  decoding?: 'async' | 'sync' | 'auto';
  /** If true, preload the image in <head> */
  priority?: boolean;
  onLoad?: (e: React.SyntheticEvent<HTMLImageElement>) => void;
  onError?: (e: React.SyntheticEvent<HTMLImageElement>) => void;
  fallbackSrc?: string;
  style?: React.CSSProperties;
}

/**
 * OptimizedImage Component
 *
 * Renders images with Cloudflare Image Resizing optimization.
 * Generates srcset for responsive images and uses /cdn-cgi/image/ URLs
 * for automatic format conversion (WebP/AVIF) and compression.
 *
 * ⚠️ IMPORTANT: Always provide width and height to prevent Cumulative Layout Shift (CLS)!
 *
 * @example
 * // Basic usage - ALWAYS include width/height!
 * <OptimizedImage src="/assets/images/hero.jpg" alt="Hero" width={800} height={600} />
 *
 * @example
 * // With responsive sizes (saves bandwidth on mobile)
 * <OptimizedImage
 *   src="/assets/images/hero.jpg"
 *   alt="Hero"
 *   width={1200}
 *   height={800}
 *   sizes="(max-width: 768px) 100vw, 50vw"
 *   quality={85}
 * />
 *
 * @example
 * // Above-the-fold image (eager loading + preload)
 * <OptimizedImage
 *   src="/assets/images/hero.jpg"
 *   alt="Hero"
 *   width={1920}
 *   height={1080}
 *   loading="eager"
 *   priority
 * />
 */
const OptimizedImage = forwardRef<HTMLImageElement, OptimizedImageProps>(({
  src,
  alt = '',
  className = '',
  width: explicitWidth,
  height: explicitHeight,
  sizes = '100vw',
  quality = 85,
  widths = DEFAULT_WIDTHS,
  loading = 'lazy',
  decoding = 'async',
  priority = false, // If true, preload the image
  onLoad,
  onError,
  fallbackSrc,
  style,
  ...props
}, ref) => {
  const [hasError, setHasError] = useState(false);
  const [isLoaded, setIsLoaded] = useState(false);
  // Set true by the fallback timer when this image is "lazy-stuck" (zero-area /
  // hidden container) — native loading="lazy" never fetches such elements, so
  // we upgrade to eager to force the load. Declared with the other state (never
  // conditionally) so the hooks order is stable across the `!src` early return.
  const [forceEager, setForceEager] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);

  const config = getConfig();

  // Handle missing src
  if (!src) {
    return (
      <div
        className={`bg-gray-200 flex items-center justify-center ${className}`}
        style={{ ...style, width: explicitWidth, height: explicitHeight }}
        {...props}
      >
        <span className="text-gray-400 text-sm">No image</span>
      </div>
    );
  }

  // Build the full R2 URL for the original image
  const originalR2Url = buildR2Url(src, config);

  // Check if optimization is enabled.
  //
  // `/cdn-cgi/image/` is ROOT-RELATIVE, so it resolves against the origin the
  // app is currently served from. Cloudflare Image Resizing only exists on the
  // *.overskill.app zone — on the E2B preview sandbox (*.overskillprojects.dev,
  // which backs the in-editor preview and the Visual Editor) the exact same URL
  // returns a 404 HTML page and EVERY image renders blank. Gate on the live
  // origin so the sandbox falls back to the plain R2 URL, which always 200s.
  const useOptimization = shouldOptimizeImages(config.enableOptimization, hasError);

  // Generate srcset with optimized URLs
  const generateSrcSet = (): string | undefined => {
    if (!useOptimization) return undefined;

    return widths
      .map(w => {
        const optimizedUrl = buildCdnCgiUrl(originalR2Url, { width: w, quality });
        return `${optimizedUrl} ${w}w`;
      })
      .join(', ');
  };

  // Generate default src (middle size for good balance)
  const getDefaultSrc = (): string => {
    if (!useOptimization) {
      // Unoptimized fallback. `originalR2Url` is already the fully-resolved
      // absolute R2 URL (buildR2Url passes absolute inputs through untouched),
      // so serve it directly.
      //
      // The previous form here was
      //   src.startsWith('/') ? src : `/assets/images/${src.replace(...)}`
      // which, for an ABSOLUTE src, produced the nonsense path
      //   /assets/images/https://assets.overskill.com/...
      // i.e. the error fallback could never recover an absolute-URL image.
      return originalR2Url;
    }

    // Use medium width as default
    const defaultWidth = typeof explicitWidth === 'number' ? explicitWidth : widths[Math.floor(widths.length / 2)];
    return buildCdnCgiUrl(originalR2Url, {
      width: defaultWidth,
      height: typeof explicitHeight === 'number' ? explicitHeight : undefined,
      quality
    });
  };

  const srcSet = generateSrcSet();
  const defaultSrc = getDefaultSrc();

  // Handle image load
  const handleLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    setIsLoaded(true);
    onLoad?.(e);
  };

  // Handle image error - fall back to unoptimized
  const handleError = (e: React.SyntheticEvent<HTMLImageElement>) => {
    console.warn(`[OptimizedImage] Failed to load: ${src}`, e);
    setHasError(true);
    onError?.(e);
  };

  // Preload priority images
  useEffect(() => {
    if (priority && typeof document !== 'undefined') {
      const link = document.createElement('link');
      link.rel = 'preload';
      link.as = 'image';
      link.href = defaultSrc;
      if (srcSet) {
        link.imageSrcset = srcSet;
        link.imageSizes = sizes;
      }
      document.head.appendChild(link);

      return () => {
        document.head.removeChild(link);
      };
    }
  }, [priority, defaultSrc, srcSet, sizes]);

  // Fallback for the native-lazy stuck case. `loading="lazy"` never fetches an
  // image with zero intrinsic dimensions or inside a hidden/collapsed container
  // (display:none tab, accordion, off-screen) — the platform-wide "image stuck,
  // valid 200 URL, never fetched" bug. After a short delay, if the element is
  // still lazy-stuck, upgrade it to eager so the browser fetches it regardless
  // of layout. A real-dimension below-the-fold image is NOT stuck, so it keeps
  // native lazy loading and the bandwidth win (see @/lib/lazyLoad).
  useEffect(() => {
    if (priority || forceEager) return; // already eager — nothing to force
    return scheduleLazyLoadFallback(
      () => imgRef.current,
      () => setForceEager(true),
      LAZY_LOAD_FALLBACK_MS
    );
  }, [priority, forceEager, defaultSrc]);

  // Our JS fallback (forceEager) and the caller's `priority` both mean "load
  // now, don't defer".
  const effectiveLoading: 'lazy' | 'eager' = priority || forceEager ? 'eager' : loading;

  // Combine refs
  const setRef = (node: HTMLImageElement | null) => {
    imgRef.current = node;
    if (ref) {
      if (typeof ref === 'function') {
        ref(node);
      } else {
        (ref as React.MutableRefObject<HTMLImageElement | null>).current = node;
      }
    }
  };

  // If error and fallback provided, use fallback
  if (hasError && fallbackSrc) {
    return (
      <img
        ref={setRef}
        src={fallbackSrc}
        alt={alt}
        className={className}
        style={style}
        width={explicitWidth}
        height={explicitHeight}
        loading={effectiveLoading}
        decoding={decoding}
        onLoad={handleLoad}
        {...props}
      />
    );
  }

  return (
    <img
      ref={setRef}
      src={defaultSrc}
      srcSet={srcSet}
      sizes={srcSet ? sizes : undefined}
      alt={alt}
      className={className}
      style={style}
      width={explicitWidth}
      height={explicitHeight}
      loading={effectiveLoading}
      decoding={decoding}
      onLoad={handleLoad}
      onError={handleError}
      {...props}
    />
  );
});

OptimizedImage.displayName = 'OptimizedImage';

/**
 * OptimizedBackgroundImage Component
 *
 * Renders a div with an optimized background image.
 * Uses the same /cdn-cgi/image/ optimization as OptimizedImage.
 *
 * @example
 * <OptimizedBackgroundImage src="/assets/images/hero.jpg" className="h-96 w-full">
 *   <h1 className="text-white">Hero Content</h1>
 * </OptimizedBackgroundImage>
 */
export const OptimizedBackgroundImage: React.FC<{
  src: string;
  children?: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  width?: number;
  quality?: number;
  [key: string]: any;
}> = ({
  src,
  children,
  className = '',
  style = {},
  width = 1920, // Default to large for backgrounds
  quality = 85,
  ...props
}) => {
  const config = getConfig();

  if (!src) {
    return (
      <div className={className} style={style} {...props}>
        {children}
      </div>
    );
  }

  const originalR2Url = buildR2Url(src, config);
  const optimizedUrl = config.enableOptimization
    ? buildCdnCgiUrl(originalR2Url, { width, quality })
    : src;

  const backgroundStyle: React.CSSProperties = {
    ...style,
    backgroundImage: `url(${optimizedUrl})`,
    backgroundSize: style.backgroundSize || 'cover',
    backgroundPosition: style.backgroundPosition || 'center',
    backgroundRepeat: style.backgroundRepeat || 'no-repeat',
  };

  return (
    <div className={className} style={backgroundStyle} {...props}>
      {children}
    </div>
  );
};

/**
 * Utility function to get an optimized image URL
 * Useful for inline styles or other non-component uses
 *
 * @example
 * const heroUrl = getOptimizedImageUrl('/assets/images/hero.jpg', { width: 1200 });
 */
export const getOptimizedImageUrl = (src: string, options: {
  width?: number;
  height?: number;
  quality?: number;
} = {}): string => {
  const config = getConfig();
  const originalR2Url = buildR2Url(src, config);

  if (!config.enableOptimization) {
    return src.startsWith('/') ? src : `/assets/images/${src}`;
  }

  return buildCdnCgiUrl(originalR2Url, options);
};

/**
 * Hook for getting optimized image URLs
 *
 * @example
 * const { url, srcSet } = useOptimizedImage('/assets/images/hero.jpg');
 */
export const useOptimizedImage = (src: string | null, options: {
  quality?: number;
  widths?: number[];
  width?: number;
  height?: number;
} = {}): { url: string | null; srcSet: string | null; originalUrl: string | null } => {
  const {
    quality = 85,
    widths = DEFAULT_WIDTHS,
    width,
    height,
  } = options;

  const config = getConfig();

  if (!src) {
    return { url: null, srcSet: null, originalUrl: null };
  }

  const originalR2Url = buildR2Url(src, config);

  if (!config.enableOptimization) {
    return {
      url: src.startsWith('/') ? src : `/assets/images/${src}`,
      srcSet: null,
      originalUrl: originalR2Url,
    };
  }

  const url = buildCdnCgiUrl(originalR2Url, {
    width: width || widths[Math.floor(widths.length / 2)],
    height,
    quality
  });

  const srcSet = widths
    .map(w => `${buildCdnCgiUrl(originalR2Url, { width: w, quality })} ${w}w`)
    .join(', ');

  return { url, srcSet, originalUrl: originalR2Url };
};

export default OptimizedImage;
