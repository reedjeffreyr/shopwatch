// Lazy Loading Image Component for R2 Assets
// Optimized for performance with intersection observer and error handling
// Now supports Cloudflare Image Optimization via /cdn-cgi/image/ URLs

import React, { useState, useRef, useEffect, forwardRef } from 'react';
import { useAsset } from '@/hooks/useAsset';
import { scheduleLazyLoadFallback, LAZY_LOAD_FALLBACK_MS } from '@/lib/lazyLoad';
import { shouldOptimizeImages } from '@/lib/imageOrigin';

/**
 * Get app configuration for image optimization
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
    enableOptimization: config?.ENABLE_IMAGE_OPTIMIZATION !== false,
  };
};

/**
 * Build full R2 URL for image optimization
 */
export const isAlreadyResolvedAssetUrl = (value: string | null | undefined): boolean => {
  if (!value) return false;
  // Already-optimized URL, relative or absolute. Resolving one a second time
  // prefixes the R2 asset base onto it and re-wraps it → permanent 404.
  return value.startsWith('/cdn-cgi/') || value.includes('/cdn-cgi/image/');
};

const buildR2Url = (imagePath: string | null | undefined): string => {
  const config = getConfig();
  const { appId, environment, r2BaseUrl } = config;

  if (imagePath?.startsWith('http://') || imagePath?.startsWith('https://')) {
    return imagePath;
  }

  // Idempotence guard: an already-resolved /cdn-cgi/image/ URL must pass
  // through untouched rather than being treated as a relative asset path.
  if (isAlreadyResolvedAssetUrl(imagePath)) {
    return imagePath as string;
  }

  let cleanPath = imagePath?.replace(/^\/+/, '') || '';

  // Map path patterns to R2 structure
  if (cleanPath.startsWith('assets/images/')) {
    cleanPath = `src/${cleanPath}`;
  } else if (cleanPath.startsWith('images/')) {
    cleanPath = `src/assets/${cleanPath}`;
  } else if (!cleanPath.startsWith('src/')) {
    cleanPath = `src/assets/${cleanPath}`;
  }

  return `${r2BaseUrl}/app-${appId}/${environment}/${cleanPath}`;
};

/**
 * Build /cdn-cgi/image/ URL for Cloudflare optimization
 */
const buildOptimizedUrl = (originalR2Url: string, { width, quality = 85 }: { width?: number; quality?: number }) => {
  // Never double-wrap an existing /cdn-cgi/image/ transform.
  if (isAlreadyResolvedAssetUrl(originalR2Url)) {
    return originalR2Url;
  }

  const params: string[] = [];
  if (width) params.push(`w=${width}`);
  params.push(`q=${quality}`);
  params.push(`f=auto`); // WebP/AVIF based on browser
  params.push(`fit=scale-down`);
  params.push(`metadata=none`);

  return `/cdn-cgi/image/${params.join(',')}/${originalR2Url}`;
};

/**
 * Default responsive widths
 */
const DEFAULT_WIDTHS = [480, 800, 1200, 1920];

interface LazyImageProps extends React.HTMLAttributes<HTMLDivElement> {
  src: string;
  alt?: string;
  className?: string;
  placeholderClassName?: string;
  errorClassName?: string;
  onLoad?: (() => void) | null;
  onError?: ((e: React.SyntheticEvent<HTMLImageElement>) => void) | null;
  threshold?: number;
  rootMargin?: string;
  fallbackSrc?: string | null;
  loadingComponent?: React.ComponentType | null;
  errorComponent?: React.ComponentType<{ error: Error }> | null;
  optimized?: boolean;
  quality?: number;
  widths?: number[];
  sizes?: string;
  /** Explicit width for layout stability (CLS) */
  width?: number | string;
  /** Explicit height for layout stability (CLS) */
  height?: number | string;
}

/**
 * Lazy loading image component with R2 asset resolver
 * Now supports Cloudflare Image Optimization
 *
 * @param {boolean} optimized - Enable /cdn-cgi/image/ optimization (default: true)
 * @param {number} quality - Image quality 1-100 (default: 85)
 * @param {number[]} widths - Responsive breakpoint widths
 * @param {string} sizes - Responsive sizes attribute
 * @param {number|string} width - Explicit width for CLS prevention
 * @param {number|string} height - Explicit height for CLS prevention
 *
 * @example
 * // Basic usage with lazy loading
 * <LazyImage src="/assets/images/hero.jpg" alt="Hero" width={800} height={600} />
 *
 * @example
 * // With responsive sizes (saves bandwidth on mobile)
 * <LazyImage
 *   src="/assets/images/hero.jpg"
 *   alt="Hero"
 *   sizes="(max-width: 768px) 100vw, 50vw"
 *   width={1200}
 *   height={800}
 * />
 */
const LazyImage = forwardRef<HTMLDivElement, LazyImageProps>(({
  src,
  alt = '',
  className = '',
  placeholderClassName = '',
  errorClassName = '',
  onLoad = null,
  onError = null,
  threshold = 0.1,
  rootMargin = '50px',
  fallbackSrc = null,
  loadingComponent: LoadingComponent = null,
  errorComponent: ErrorComponent = null,
  // Optimization props
  optimized = true,
  quality = 85,
  widths = DEFAULT_WIDTHS,
  sizes = '100vw',
  // Layout props for CLS
  width,
  height,
  ...props
}, ref) => {
  const [isVisible, setIsVisible] = useState(false);
  const imgRef = useRef<HTMLDivElement>(null);
  const [hasIntersected, setHasIntersected] = useState(false);
  const [hasError, setHasError] = useState(false);

  const config = getConfig();
  // Origin-gated: /cdn-cgi/image/ is root-relative and only resolves on the
  // *.overskill.app zone. On the E2B preview sandbox (*.overskillprojects.dev)
  // it 404s and every image renders blank -- fall back to the plain R2 URL.
  const useOptimization = optimized && shouldOptimizeImages(config.enableOptimization, hasError);

  // Determine if we should use asset resolver or direct URL
  const isFullUrl = src && (src.startsWith('http://') || src.startsWith('https://'));
  const isWorkerProxyPath = src && src.startsWith('/assets/');
  const isCdnCgiPath = src && src.startsWith('/cdn-cgi/');
  const shouldResolve = !isFullUrl && !isWorkerProxyPath && !isCdnCgiPath && !useOptimization;

  // Use asset resolver for non-optimized paths
  const { url, loading, error } = useAsset(
    hasIntersected && shouldResolve ? src : null,
    {
      preload: true,
      fallback: fallbackSrc,
    }
  );

  // Generate optimized URLs
  const getOptimizedUrls = (): { defaultSrc: string | null; srcSet: string | null } => {
    if (!useOptimization || !src) return { defaultSrc: null, srcSet: null };

    const originalR2Url = buildR2Url(src);
    const defaultWidth = widths[Math.floor(widths.length / 2)];
    const defaultSrc = buildOptimizedUrl(originalR2Url, { width: defaultWidth, quality });
    const srcSet = widths
      .map(w => `${buildOptimizedUrl(originalR2Url, { width: w, quality })} ${w}w`)
      .join(', ');

    return { defaultSrc, srcSet };
  };

  const { defaultSrc: optimizedSrc, srcSet } = getOptimizedUrls();

  // Determine final URL based on optimization mode
  const getFinalUrl = (): string | null => {
    if (useOptimization && optimizedSrc) {
      return optimizedSrc;
    }
    if (isFullUrl) return src;
    if (isWorkerProxyPath || isCdnCgiPath) return src;
    return url;
  };

  const finalUrl = getFinalUrl();

  // Intersection Observer for lazy loading, plus a fallback timer.
  //
  // The observer is the happy path (below-the-fold images load on scroll).
  // But a wrapper with zero intrinsic dimensions or inside a hidden/collapsed
  // container (display:none tab, accordion, off-screen) NEVER intersects, so
  // `hasIntersected` would stay false forever and the <img> would never mount
  // — the platform-wide "image stuck, complete:false, valid 200 URL" bug.
  // The fallback timer force-loads such genuinely-stuck images while leaving
  // real-dimension below-the-fold images to the observer (see @/lib/lazyLoad).
  useEffect(() => {
    const currentImgRef = imgRef.current;
    if (!currentImgRef || hasIntersected) return;

    const forceLoad = () => {
      setIsVisible(true);
      setHasIntersected(true);
    };

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          observer.disconnect();
          forceLoad();
        }
      },
      {
        threshold,
        rootMargin
      }
    );

    observer.observe(currentImgRef);

    // Safety net: if the wrapper never becomes viewport-reachable (zero-area /
    // hidden container), the observer can't fire — force the load anyway.
    const cancelFallback = scheduleLazyLoadFallback(
      () => imgRef.current,
      forceLoad,
      LAZY_LOAD_FALLBACK_MS
    );

    return () => {
      observer.disconnect();
      cancelFallback();
    };
  }, [threshold, rootMargin, hasIntersected]);

  // Handle error - disable optimization and retry
  const handleError = (e: React.SyntheticEvent<HTMLImageElement>) => {
    console.warn(`[LazyImage] Error loading: ${src} -> ${finalUrl}`);
    if (useOptimization && !hasError) {
      // Disable optimization and retry with original path
      setHasError(true);
    }
    onError?.(e);
  };

  // Default loading component
  const DefaultLoading = () => (
    <div className={`bg-gray-200 animate-pulse flex items-center justify-center ${placeholderClassName}`}>
      <svg className="w-8 h-8 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
      </svg>
    </div>
  );

  // Default error component
  const DefaultError = () => (
    <div className={`bg-gray-100 border-2 border-dashed border-gray-300 flex items-center justify-center ${errorClassName}`}>
      <div className="text-center text-gray-500">
        <svg className="w-8 h-8 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <p className="text-sm">Failed to load</p>
      </div>
    </div>
  );

  // Calculate aspect ratio style for CLS prevention
  const aspectStyle: React.CSSProperties = {};
  if (width && height) {
    aspectStyle.aspectRatio = `${width} / ${height}`;
  }

  return (
    <div
      ref={(node) => {
        imgRef.current = node;
        if (ref) {
          if (typeof ref === 'function') {
            ref(node);
          } else {
            (ref as React.MutableRefObject<HTMLDivElement | null>).current = node;
          }
        }
      }}
      className={className}
      style={{ ...aspectStyle }}
      {...props}
    >
      {!hasIntersected && (
        <div className={`bg-gray-100 w-full h-full ${placeholderClassName}`} style={aspectStyle} />
      )}

      {hasIntersected && shouldResolve && loading && (
        LoadingComponent ? <LoadingComponent /> : <DefaultLoading />
      )}

      {hasIntersected && shouldResolve && error && (
        ErrorComponent ? <ErrorComponent error={error} /> : <DefaultError />
      )}

      {hasIntersected && (useOptimization || isFullUrl || isWorkerProxyPath || isCdnCgiPath || (!loading && !error && url)) && finalUrl && (
        <img
          src={finalUrl}
          srcSet={useOptimization ? srcSet || undefined : undefined}
          sizes={useOptimization && srcSet ? sizes : undefined}
          alt={alt}
          className="w-full h-full object-cover"
          width={width}
          height={height}
          // The IntersectionObserver above IS our lazy gate — this <img> only
          // mounts once we've decided to load it. Native lazy-loading here
          // would be redundant AND would re-defer a force-loaded image inside a
          // hidden container (the browser lazy heuristic skips hidden elements),
          // reintroducing the stuck-forever bug. So load eagerly on mount.
          loading="eager"
          decoding="async"
          onLoad={() => {
            console.log(`[LazyImage] Loaded: ${src} -> ${finalUrl}`);
            onLoad?.();
          }}
          onError={handleError}
        />
      )}
    </div>
  );
});

LazyImage.displayName = 'LazyImage';

export default LazyImage;

/**
 * Eager loading image component with optimization
 * For above-the-fold images that should load immediately
 *
 * @example
 * // Hero image (above the fold)
 * <EagerImage src="/assets/images/hero.jpg" alt="Hero" width={1200} height={600} />
 */
export const EagerImage: React.FC<{
  src: string;
  alt?: string;
  className?: string;
  fallbackSrc?: string | null;
  optimized?: boolean;
  quality?: number;
  widths?: number[];
  sizes?: string;
  width?: number | string;
  height?: number | string;
  [key: string]: any;
}> = ({
  src,
  alt = '',
  className = '',
  fallbackSrc = null,
  optimized = true,
  quality = 85,
  widths = DEFAULT_WIDTHS,
  sizes = '100vw',
  width,
  height,
  ...props
}) => {
  const [hasError, setHasError] = useState(false);
  const config = getConfig();
  // Origin-gated: /cdn-cgi/image/ is root-relative and only resolves on the
  // *.overskill.app zone. On the E2B preview sandbox (*.overskillprojects.dev)
  // it 404s and every image renders blank -- fall back to the plain R2 URL.
  const useOptimization = optimized && shouldOptimizeImages(config.enableOptimization, hasError);

  const isFullUrl = src && (src.startsWith('http://') || src.startsWith('https://'));
  const isWorkerProxyPath = src && src.startsWith('/assets/');
  const shouldResolve = !isFullUrl && !isWorkerProxyPath && !useOptimization;

  const { url, loading, error } = useAsset(
    shouldResolve ? src : null,
    {
      preload: true,
      fallback: fallbackSrc
    }
  );

  // Generate optimized URLs
  const getOptimizedUrls = (): { defaultSrc: string | null; srcSet: string | null } => {
    if (!useOptimization || !src) return { defaultSrc: null, srcSet: null };

    const originalR2Url = buildR2Url(src);
    const defaultWidth = widths[Math.floor(widths.length / 2)];
    const defaultSrc = buildOptimizedUrl(originalR2Url, { width: defaultWidth, quality });
    const srcSet = widths
      .map(w => `${buildOptimizedUrl(originalR2Url, { width: w, quality })} ${w}w`)
      .join(', ');

    return { defaultSrc, srcSet };
  };

  const { defaultSrc: optimizedSrc, srcSet } = getOptimizedUrls();

  const finalUrl = useOptimization && optimizedSrc ? optimizedSrc : (isFullUrl ? src : (isWorkerProxyPath ? src : url));

  if (shouldResolve && loading) {
    return (
      <div className={`bg-gray-200 animate-pulse ${className}`} />
    );
  }

  if (shouldResolve && error) {
    return (
      <div className={`bg-gray-100 border border-gray-300 flex items-center justify-center ${className}`}>
        <span className="text-gray-500 text-sm">Image failed to load</span>
      </div>
    );
  }

  return (
    <img
      src={finalUrl || ''}
      srcSet={useOptimization ? srcSet || undefined : undefined}
      sizes={useOptimization && srcSet ? sizes : undefined}
      alt={alt}
      className={className}
      width={width}
      height={height}
      loading="eager"
      decoding="sync"
      onError={() => {
        if (useOptimization && !hasError) {
          setHasError(true);
        }
      }}
      {...props}
    />
  );
};

/**
 * Background image component with optimization
 *
 * @example
 * <BackgroundImage src="/assets/images/hero.jpg" className="h-96">
 *   <h1>Hero Content</h1>
 * </BackgroundImage>
 */
export const BackgroundImage: React.FC<{
  src: string;
  children?: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  fallbackSrc?: string | null;
  optimized?: boolean;
  quality?: number;
  width?: number;
  [key: string]: any;
}> = ({
  src,
  children,
  className = '',
  style = {},
  fallbackSrc = null,
  optimized = true,
  quality = 85,
  width = 1920,
  ...props
}) => {
  const [hasError, setHasError] = useState(false);
  const config = getConfig();
  // Origin-gated: /cdn-cgi/image/ is root-relative and only resolves on the
  // *.overskill.app zone. On the E2B preview sandbox (*.overskillprojects.dev)
  // it 404s and every image renders blank -- fall back to the plain R2 URL.
  const useOptimization = optimized && shouldOptimizeImages(config.enableOptimization, hasError);

  const isFullUrl = src && (src.startsWith('http://') || src.startsWith('https://'));
  const isWorkerProxyPath = src && src.startsWith('/assets/');
  const shouldResolve = !isFullUrl && !isWorkerProxyPath && !useOptimization;

  const { url, loading, error } = useAsset(
    shouldResolve ? src : null,
    { fallback: fallbackSrc }
  );

  // Generate optimized URL for background
  const getOptimizedUrl = (): string | null => {
    if (!useOptimization || !src) return null;
    const originalR2Url = buildR2Url(src);
    return buildOptimizedUrl(originalR2Url, { width, quality });
  };

  const optimizedUrl = getOptimizedUrl();
  const finalUrl = useOptimization && optimizedUrl ? optimizedUrl : (isFullUrl ? src : (isWorkerProxyPath ? src : url));

  const backgroundStyle: React.CSSProperties = {
    ...style,
    backgroundImage: finalUrl && (!loading || !shouldResolve) && !error ? `url(${finalUrl})` : undefined,
    backgroundSize: style.backgroundSize || 'cover',
    backgroundPosition: style.backgroundPosition || 'center',
    backgroundRepeat: style.backgroundRepeat || 'no-repeat'
  };

  return (
    <div
      className={`${className} ${shouldResolve && loading ? 'bg-gray-200 animate-pulse' : ''}`}
      style={backgroundStyle}
      {...props}
    >
      {children}
    </div>
  );
};
