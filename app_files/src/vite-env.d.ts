/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_APP_ID: string
  readonly VITE_OWNER_ID: string
  readonly VITE_ENVIRONMENT: string
  readonly VITE_R2_BASE_URL: string
  readonly VITE_USE_LOCAL_ASSETS: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

// App configuration interface (injected by WorkerScriptAssembler at runtime)
interface AppConfig {
  showOverskillBadge?: boolean;
  /** Whether this app can be remixed/cloned by other users */
  isCloneable?: boolean;
  /** URL to remix this specific app */
  remixUrl?: string;
  /** Obfuscated app ID */
  appId?: string;
  /** Owner team ID */
  ownerId?: string;
  /** Deployment environment (preview/production) */
  environment?: string;
}

// Extend Window interface to include APP_CONFIG
declare global {
  interface Window {
    APP_CONFIG?: AppConfig;
  }
}
