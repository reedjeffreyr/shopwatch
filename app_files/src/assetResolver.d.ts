// TypeScript declarations for assetResolver.js

declare class AssetResolver {
  appId: string | undefined;
  environment: string;
  r2BaseUrl: string;
  useLocalAssets: boolean;
  urlCache: Map<string, string>;

  constructor();

  /**
   * Resolve asset path to full R2 URL
   */
  resolve(assetPath: string): string;

  /**
   * Resolve to R2 bucket URL
   */
  resolveR2(assetPath: string): string;

  /**
   * Preload an asset for better performance
   */
  preload(assetPath: string, as?: string): Promise<void>;

  /**
   * Get asset URL with error handling and fallback
   */
  getAssetUrl(assetPath: string, fallback?: string | null): string;

  /**
   * Batch preload critical assets
   */
  preloadCritical(assetPaths: string[]): Promise<void>;

  /**
   * Debug helper - log asset resolution
   */
  debug(assetPath: string): void;
}

declare const assetResolver: AssetResolver;

export { assetResolver, AssetResolver };
export default assetResolver;
