/**
 * Integry SDK Integration for OverSkill
 *
 * ⚠️ DEPRECATED: This library is deprecated. Use composio.ts instead.
 *
 * DO_NOT_REMOVE: Existing generated apps may import from this file.
 * SAFE TO REMOVE WHEN: All deployed apps have been rebuilt with Composio imports.
 *
 * Migration Guide (January 2026):
 * - Replace: import { useIntegry, callIntegryFunction } from '@/lib/integry'
 * - With:    import { useComposio, executeAction } from '@/lib/composio'
 *
 * - Replace: callIntegryFunction('slack-post-message', params)
 * - With:    executeAction('SLACK_SEND_MESSAGE', params)
 *
 * - Replace: useIntegry()
 * - With:    useComposio()
 *
 * Why Composio?
 * - 850+ integrations (vs Integry's 300+)
 * - Server-side OAuth (more reliable)
 * - 96% cost reduction ($29/month vs $10K+/month)
 *
 * This file is kept for backward compatibility only.
 * All new features should use composio.ts.
 *
 * @deprecated Use composio.ts instead
 * @see https://docs.overskill.com/integrations/composio-migration
 */

import React from 'react';
import { useEffect, useState, useCallback } from 'react';
import { Button } from '@/components/ui/button'

// IntegryJS types (will be provided by @integry/sdk package)
declare global {
  interface Window {
    IntegryJS: any;
  }
}

export interface IntegryConfig {
  appKey: string;
  hash: string;
  user: {
    userId: string;
  };
  lang?: 'en' | 'es' | 'fr' | 'ja' | 'pt-br';
  options?: {
    title?: string;
    tags?: string[];
    debug?: boolean;
    // Declared because initIntegry() below passes `fetchAll: false` in this
    // literal (see the `const config: IntegryConfig` block). Without it every
    // generated app carrying this template emits
    //   integry.ts(214,11): error TS2353: Object literal may only specify known
    //   properties, and 'fetchAll' does not exist in type '{ title?; tags?; debug?; }'
    // on every build. It is non-blocking for vite, but it lands as the FIRST
    // line of the captured tsc output, so BuildErrorAutoFixJob targets this
    // file instead of whatever error actually failed the build — the decoy that
    // burned a customer's credits across repeated "fix" attempts (issue #3641).
    fetchAll?: boolean;
  };
  theme?: {
    primaryColor?: string;
    logo?: string;
    companyName?: string;
  };
}

export interface IntegryInstance {
  // App Management
  showApps(options?: ShowAppsOptions): Promise<void>;
  connectApp(appName: string): Promise<string>;  // Returns connected_account_id
  disconnectApp(appName: string, connectedAccountId?: string): Promise<void>;
  isAppConnected(appName: string): Promise<boolean>;
  getConnectedAccounts(appName: string): Promise<ConnectedAccountsResponse>;

  // Function Execution
  invokeFunction(functionName: string, params: any): Promise<FunctionResult>;
  showFunctionUI(functionName: string, options?: FunctionUIOptions): Promise<any>;
  getFunction(functionName: string): Promise<FunctionSpec>;

  // Event Handling
  eventEmitter: {
    on(event: string, callback: (data: any) => void): void;
    unsub(event: string, callback: (data: any) => void): void;
  };

  // Internal
  on(event: string, callback: () => void): void;
}

export interface ShowAppsOptions {
  renderMode?: 'MODAL' | 'INLINE';
  containerId?: string;
  layout?: 'WIDE' | 'NARROW';
  fetchAll?: boolean;
  useLoadMoreButton?: boolean;
  authOnly?: boolean;
  tags?: string[];
}

export interface FunctionUIOptions {
  params?: any;
  renderMode?: 'MODAL' | 'INLINE';
}

export interface ConnectedAccountsResponse {
  connected_accounts: Array<{
    id: string;
    display_name: string;
    modified_at: string;
  }>;
}

export interface FunctionResult {
  network_code: number;
  output: any;
  _cursor?: string;  // For pagination
}

export interface FunctionSpec {
  name: string;
  description: string;
  parameters: any;  // JSON Schema
  required: string[];
}

// Singleton instance
let integryInstance: IntegryInstance | null = null;
let initializationPromise: Promise<IntegryInstance> | null = null;

/**
 * Initialize Integry SDK
 * Fetches credentials from Worker and initializes IntegryJS
 *
 * @returns Promise<IntegryInstance>
 */
export async function initializeIntegry(): Promise<IntegryInstance> {
  // Return existing instance if already initialized
  if (integryInstance) {
    return integryInstance;
  }

  // Return existing initialization promise if in progress
  if (initializationPromise) {
    return initializationPromise;
  }

  initializationPromise = (async () => {
    try {
      // Get authentication token
      const token = getAuthToken();
      if (!token) {
        throw new Error('No authentication token available');
      }

      // Fetch Integry credentials from Worker
      const response = await fetch('/api/integry/credentials', {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch Integry credentials: ${response.statusText}`);
      }

      const credentials = await response.json();

      // Load IntegryJS SDK dynamically (only when actually needed!)
      // This prevents slow page loads when integrations aren't used
      // IMPORTANT: Uses timeout to prevent blocking if Integry CDN is down
      if (typeof window.IntegryJS === 'undefined') {
        console.log('[Integry] Loading SDK dynamically...');

        const SDK_LOAD_TIMEOUT_MS = 10000; // 10 second timeout
        // Official Integry SDK UMD bundle from unpkg (recommended by Integry docs)
        // Note: cdn.integry.io is broken (returns 302 redirect), use unpkg instead
        const SDK_URL = 'https://unpkg.com/@integry/sdk/dist/umd/index.umd.js';

        await Promise.race([
          new Promise<void>((resolve, reject) => {
            const script = document.createElement('script');
            script.src = SDK_URL;
            script.crossOrigin = 'anonymous';
            script.async = true;

            script.onload = () => {
              // Verify the SDK actually loaded (CDN might return empty/redirect)
              if (typeof window.IntegryJS === 'undefined') {
                reject(new Error('IntegryJS SDK loaded but IntegryJS is not defined - CDN may be returning invalid response'));
              } else {
                console.log('[Integry] SDK loaded successfully');
                resolve();
              }
            };

            script.onerror = () => {
              reject(new Error('Failed to load IntegryJS SDK - network error or CDN unavailable'));
            };

            document.head.appendChild(script);
          }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`IntegryJS SDK load timeout after ${SDK_LOAD_TIMEOUT_MS}ms - CDN may be down`)), SDK_LOAD_TIMEOUT_MS)
          )
        ]);
      }

      // Initialize IntegryJS with OverSkill branding
      const config: IntegryConfig = {
        appKey: credentials.app_key,
        hash: credentials.hash,
        user: {
          userId: credentials.user_id
        },
        lang: 'en',
        options: {
          title: 'Integrations',
          debug: import.meta.env.DEV,
          fetchAll: false  // Don't preload all 300+ apps (load on-demand for better performance)
        },
        theme: {
          primaryColor: '#2563eb',  // OverSkill blue
          logo: '/overskill-logo.svg',
          companyName: 'OverSkill'
        }
      };

      const instance = new window.IntegryJS(config);

      // Wait for ready event
      await new Promise<void>((resolve) => {
        instance.on('ready', () => {
          console.log('[Integry] SDK initialized successfully');
          resolve();
        });
      });

      // Set up event listeners for analytics tracking
      setupAnalyticsTracking(instance);

      integryInstance = instance;
      return instance;

    } catch (error) {
      console.error('[Integry] Initialization failed:', error);
      initializationPromise = null;  // Reset so retry is possible
      throw error;
    }
  })();

  return initializationPromise;
}

/**
 * Set up analytics tracking for Integry function calls
 * Records usage to Cloudflare Analytics Engine for billing
 */
function setupAnalyticsTracking(instance: IntegryInstance) {
  // Track when apps are connected
  instance.eventEmitter.on('app-connected', (data: any) => {
    console.log('[Integry] App connected:', data.name);

    // Record connection event
    recordIntegrationAnalytics({
      integrationSlug: data.name,
      endpoint: 'connect',
      tier: 'integry',
      status: 'success',
      costCents: 0
    });
  });

  // Track when integrations are created
  instance.eventEmitter.on('integration-created', (data: any) => {
    console.log('[Integry] Integration created with callback:', data.callbackUrl);

    // TODO: Store callback URL in database if needed for webhook triggers
  });

  // Track when apps are disconnected
  instance.eventEmitter.on('app-disconnected', (data: any) => {
    console.log('[Integry] App disconnected:', data.name);
  });
}

/**
 * Record integration analytics to Worker for Cloudflare Analytics Engine
 */
async function recordIntegrationAnalytics(event: {
  integrationSlug: string;
  endpoint: string;
  tier: string;
  status: string;
  responseTimeMs?: number;
  costCents?: number;
  tokens?: number;
}) {
  try {
    // Non-blocking analytics recording
    fetch('/api/analytics/record', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: getUserId(),
        integrationSlug: event.integrationSlug,
        endpoint: event.endpoint,
        tier: event.tier,
        status: event.status,
        responseTimeMs: event.responseTimeMs || 0,
        costCents: event.costCents || 4,  // Default Integry cost: $0.04
        tokens: event.tokens || 0
      })
    }).catch(error => {
      // Don't fail if analytics fails
      console.warn('[Analytics] Failed to record:', error);
    });
  } catch (error) {
    console.warn('[Analytics] Record error:', error);
  }
}

/**
 * Get current user ID from auth token
 */
function getUserId(): string {
  try {
    const token = getAuthToken();
    if (!token) return 'anonymous';

    const payload = JSON.parse(atob(token.split('.')[1]));
    return payload.sub || payload.overskill_user_id || 'unknown';
  } catch {
    return 'anonymous';
  }
}

/**
 * Get authentication token from localStorage or cookies
 */
function getAuthToken(): string | null {
  // Try localStorage first (where OAuth callback stores it)
  const token = localStorage.getItem('overskill_token');
  if (token) return token;

  // Try sessionStorage
  const sessionToken = sessionStorage.getItem('overskill_token');
  if (sessionToken) return sessionToken;

  // Try cookies
  const cookies = document.cookie.split(';');
  for (const cookie of cookies) {
    const [name, value] = cookie.trim().split('=');
    if (name === 'overskill_token') {
      return value;
    }
  }

  return null;
}

/**
 * React Hook: useIntegry
 *
 * Provides Integry instance and loading state
 * NOW USES LAZY INITIALIZATION - doesn't load IntegryJS until actually needed!
 * This prevents slow page loads from Integry API requests.
 *
 * Usage:
 * ```typescript
 * function MyComponent() {
 *   const { integry, ready, error, initialize } = useIntegry();
 *
 *   // Initialize when user tries to use integrations
 *   const sendToSlack = async () => {
 *     if (!ready) {
 *       await initialize();  // Lazy init
 *     }
 *
 *     await integry.invokeFunction('slack-post-message', {
 *       channel: '#general',
 *       text: 'Hello from OverSkill!'
 *     });
 *   };
 *
 *   return <Button onClick={sendToSlack}>Send to Slack</Button>;
 * }
 * ```
 */
export function useIntegry() {
  const [integry, setIntegry] = useState<IntegryInstance | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [initializing, setInitializing] = useState(false);

  // Lazy initialization - only when explicitly called
  const initialize = useCallback(async () => {
    if (integry || initializing) return integry;

    setInitializing(true);

    try {
      const instance = await initializeIntegry();
      setIntegry(instance);
      setReady(true);
      return instance;
    } catch (err: any) {
      setError(err.message);
      console.error('[useIntegry] Initialization failed:', err);
      throw err;
    } finally {
      setInitializing(false);
    }
  }, [integry, initializing]);

  // DON'T auto-initialize! Only when user explicitly uses integrations
  // This prevents slow page loads from Integry API requests

  return { integry, ready, error, initializing, initialize };
}

/**
 * React Hook: useIntegrationConnection
 *
 * Check if a specific integration is connected
 *
 * Usage:
 * ```typescript
 * const { connected, loading } = useIntegrationConnection('slack');
 *
 * if (loading) return <LoadingSpinner />;
 * if (!connected) return <ConnectButton app="slack" />;
 *
 * return <SlackNotificationButton />;
 * ```
 */
export function useIntegrationConnection(appName: string) {
  const { integry, ready } = useIntegry();
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!ready || !integry) {
      setLoading(false);
      return;
    }

    let mounted = true;

    integry.isAppConnected(appName)
      .then(isConnected => {
        if (mounted) {
          setConnected(isConnected);
          setLoading(false);
        }
      })
      .catch(error => {
        console.error(`[useIntegrationConnection] Failed to check ${appName}:`, error);
        if (mounted) {
          setLoading(false);
        }
      });

    return () => {
      mounted = false;
    };
  }, [appName, integry, ready]);

  const connect = useCallback(async () => {
    if (!integry) return;

    try {
      const accountId = await integry.connectApp(appName);
      console.log(`[Integry] Connected ${appName} with account ID:`, accountId);
      setConnected(true);
      return accountId;
    } catch (error) {
      console.error(`[Integry] Failed to connect ${appName}:`, error);
      throw error;
    }
  }, [integry, appName]);

  const disconnect = useCallback(async (connectedAccountId?: string) => {
    if (!integry) return;

    try {
      await integry.disconnectApp(appName, connectedAccountId);
      console.log(`[Integry] Disconnected ${appName}`);
      setConnected(false);
    } catch (error) {
      console.error(`[Integry] Failed to disconnect ${appName}:`, error);
      throw error;
    }
  }, [integry, appName]);

  return { connected, loading, connect, disconnect };
}

/**
 * Helper: Call an Integry function with automatic analytics tracking
 *
 * Usage:
 * ```typescript
 * const result = await callIntegryFunction('slack-post-message', {
 *   channel: '#general',
 *   text: 'Hello!'
 * });
 * ```
 */
export async function callIntegryFunction(
  functionName: string,
  params: any
): Promise<any> {
  const instance = await initializeIntegry();
  const startTime = Date.now();

  try {
    const result = await instance.invokeFunction(functionName, params);

    // Record analytics
    const [integration, action] = functionName.split(/[-.]/, 2);
    await recordIntegrationAnalytics({
      integrationSlug: integration,
      endpoint: functionName,
      tier: 'integry',
      status: 'success',
      responseTimeMs: Date.now() - startTime
    });

    return result.output;

  } catch (error: any) {
    // Record failure
    const [integration] = functionName.split(/[-.]/, 2);
    await recordIntegrationAnalytics({
      integrationSlug: integration,
      endpoint: functionName,
      tier: 'integry',
      status: 'failed',
      responseTimeMs: Date.now() - startTime
    });

    throw error;
  }
}

/**
 * Helper: Get channels/resources from an integration (supporting functions)
 *
 * Usage:
 * ```typescript
 * const channels = await getIntegrationResources('slack', 'get-channels');
 * // Returns: [{ id: 'C123', name: '#general' }, ...]
 *
 * const spreadsheets = await getIntegrationResources('google-sheets', 'get-spreadsheets');
 * // Returns: [{ id: 'sheet123', name: 'My Spreadsheet' }, ...]
 * ```
 */
export async function getIntegrationResources(
  integration: string,
  resourceType: string,
  params: any = {}
): Promise<any[]> {
  const functionName = `${integration}-${resourceType}`;
  const result = await callIntegryFunction(functionName, params);
  return result || [];
}

/**
 * Helper: Show connection UI for an integration
 * Opens Integry's white-labeled OAuth flow
 */
export async function showConnectionUI(appName: string): Promise<void> {
  const instance = await initializeIntegry();
  await instance.connectApp(appName);
}

/**
 * Helper: Show integrations marketplace
 * Displays all 850+ available integrations
 */
export async function showIntegrationsMarketplace(options?: ShowAppsOptions): Promise<void> {
  const instance = await initializeIntegry();
  await instance.showApps(options || {
    renderMode: 'MODAL',
    layout: 'WIDE'
  });
}

/**
 * Get Integry instance (if initialized)
 * Returns null if not yet initialized
 */
export function getIntegry(): IntegryInstance | null {
  return integryInstance;
}

/**
 * Check if Integry is initialized
 */
export function isIntegryReady(): boolean {
  return integryInstance !== null;
}
