// React Hook for R2 Asset Management
// Provides easy asset loading with error handling and preloading

import { useState, useEffect, useCallback } from 'react';
import assetResolver from '@/assetResolver';

interface UseAssetOptions {
  preload?: boolean;
  fallback?: string | null;
  onError?: ((error: Error) => void) | null;
  onLoad?: ((url: string) => void) | null;
}

interface UseAssetReturn {
  url: string | null;
  loading: boolean;
  error: Error | null;
  reload: () => void;
}

/**
 * Hook for loading assets with automatic R2/local resolution
 *
 * @example
 * const { url, loading, error } = useAsset('/assets/images/hero.jpg');
 * if (loading) return <Spinner />;
 * if (error) return <Error />;
 * return <img src={url} />;
 */
export const useAsset = (
  assetPath: string | null | undefined,
  options: UseAssetOptions = {}
): UseAssetReturn => {
  const {
    preload = false,
    fallback = null,
    onError = null,
    onLoad = null
  } = options;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [url, setUrl] = useState<string | null>(null);

  const loadAsset = useCallback(async () => {
    if (!assetPath) {
      setUrl(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const resolvedUrl = assetResolver.resolve(assetPath);

      if (preload) {
        // Preload and verify asset exists
        const img = new Image();

        await new Promise<void>((resolve, reject) => {
          img.onload = () => {
            setUrl(resolvedUrl);
            setLoading(false);
            onLoad?.(resolvedUrl);
            resolve();
          };

          img.onerror = () => {
            const err = new Error(`Failed to load asset: ${assetPath}`);
            setError(err);
            setLoading(false);
            onError?.(err);

            // Try fallback if provided
            if (fallback) {
              setUrl(fallback);
            }

            reject(err);
          };

          img.src = resolvedUrl;
        });
      } else {
        // Just resolve URL without preloading
        setUrl(resolvedUrl);
        setLoading(false);
        onLoad?.(resolvedUrl);
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      setError(error);
      setLoading(false);
      onError?.(error);

      if (fallback) {
        setUrl(fallback);
      }
    }
  }, [assetPath, preload, fallback, onError, onLoad]);

  const reload = useCallback(() => {
    loadAsset();
  }, [loadAsset]);

  useEffect(() => {
    loadAsset();
  }, [loadAsset]);

  return { url, loading, error, reload };
};

interface UseAssetsOptions {
  preload?: boolean;
}

interface UseAssetsReturn {
  assets: Record<string, string>;
  loading: boolean;
  errors: Record<string, Error>;
  reload: () => void;
}

/**
 * Hook for batch loading multiple assets
 *
 * @example
 * const { assets, loading } = useAssets(['/images/a.jpg', '/images/b.jpg']);
 * return assets['/images/a.jpg'] && <img src={assets['/images/a.jpg']} />;
 */
export const useAssets = (
  assetPaths: string[] | null | undefined,
  options: UseAssetsOptions = {}
): UseAssetsReturn => {
  const { preload = false } = options;

  const [loading, setLoading] = useState(true);
  const [errors, setErrors] = useState<Record<string, Error>>({});
  const [assets, setAssets] = useState<Record<string, string>>({});

  const loadAssets = useCallback(async () => {
    if (!assetPaths?.length) {
      setAssets({});
      setLoading(false);
      return;
    }

    setLoading(true);
    setErrors({});

    const newAssets: Record<string, string> = {};
    const newErrors: Record<string, Error> = {};

    await Promise.allSettled(
      assetPaths.map(async (assetPath) => {
        try {
          const resolvedUrl = assetResolver.resolve(assetPath);

          if (preload) {
            await assetResolver.preload(assetPath);
          }

          newAssets[assetPath] = resolvedUrl;
        } catch (err) {
          newErrors[assetPath] = err instanceof Error ? err : new Error(String(err));
        }
      })
    );

    setAssets(newAssets);
    setErrors(newErrors);
    setLoading(false);
  }, [assetPaths, preload]);

  const reload = useCallback(() => {
    loadAssets();
  }, [loadAssets]);

  useEffect(() => {
    loadAssets();
  }, [loadAssets]);

  return { assets, loading, errors, reload };
};

interface UseCriticalAssetsReturn {
  preloaded: boolean;
  errors: Error[];
}

/**
 * Hook for preloading critical assets on app startup
 *
 * @example
 * const { preloaded } = useCriticalAssets(['/images/logo.svg', '/images/hero.jpg']);
 * if (!preloaded) return <SplashScreen />;
 */
export const useCriticalAssets = (
  criticalAssets: string[] | null | undefined
): UseCriticalAssetsReturn => {
  const [preloaded, setPreloaded] = useState(false);
  const [errors, setErrors] = useState<Error[]>([]);

  useEffect(() => {
    if (!criticalAssets?.length) return;

    const preloadCritical = async () => {
      try {
        await assetResolver.preloadCritical(criticalAssets);
        setPreloaded(true);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        setErrors(prev => [...prev, error]);
      }
    };

    preloadCritical();
  }, [criticalAssets]);

  return { preloaded, errors };
};

/**
 * Simple hook that just returns resolved asset URL
 *
 * @example
 * const logoUrl = useAssetUrl('/images/logo.svg');
 * return <img src={logoUrl} />;
 */
export const useAssetUrl = (assetPath: string | null | undefined): string | null => {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (assetPath) {
      setUrl(assetResolver.resolve(assetPath));
    } else {
      setUrl(null);
    }
  }, [assetPath]);

  return url;
};

export default useAsset;
