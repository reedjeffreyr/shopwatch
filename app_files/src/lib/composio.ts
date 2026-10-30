/**
 * Composio SDK Integration for OverSkill
 *
 * Provides workspace-level integration management via Composio.dev
 * - 850+ OAuth integrations (Slack, Google Sheets, Notion, Salesforce, HubSpot, etc.)
 * - Team-level OAuth (connect once, use in all apps)
 * - Server-side OAuth flow (more reliable than client-side SDK)
 * - Automatic token refresh and error handling
 *
 * Based on Composio API (February 2026):
 * - OAuth connection managed by OverSkill platform (creator connects in dashboard)
 * - Action execution via Worker → Composio API directly (pure edge, no Rails proxy)
 * - Action names in UPPER_SNAKE_CASE (e.g., SLACK_SEND_MESSAGE)
 *
 * @see https://docs.composio.dev
 */

import { useState, useCallback, useEffect } from 'react';

// ============================================
// Types
// ============================================

export interface ComposioAction {
  name: string;
  description: string;
  parameters: Record<string, any>;
  required: string[];
}

export interface ActionResult {
  success: boolean;
  output?: any;
  error?: string;
}

export interface ConnectionStatus {
  connected: boolean;
  provider: string;
  connectedAt?: string;
  expiresAt?: string;
}

// ============================================
// Core Functions
// ============================================

/**
 * Execute a Composio action
 *
 * Actions are named in UPPER_SNAKE_CASE format:
 * - SLACK_SEND_MESSAGE
 * - HUBSPOT_CREATE_CONTACT
 * - NOTION_CREATE_PAGE
 * - GOOGLE_SHEETS_APPEND_ROW
 *
 * @example
 * ```typescript
 * const result = await executeAction('SLACK_SEND_MESSAGE', {
 *   channel: '#general',
 *   text: 'Hello from OverSkill!'
 * });
 *
 * // Run it on ONE named account when the user connected several
 * const result = await executeAction('GMAIL_SEND_EMAIL', { ... }, { alias: 'Work' });
 * ```
 *
 * @param options.alias Optional — the NAME the user gave one of their own
 *        connected accounts at connect time ("Work", "Personal"). Without it
 *        the action runs on their DEFAULT account. A name that matches nothing
 *        is an error, never a silent fall back to the default: sending from the
 *        wrong mailbox is the bug this exists to prevent.
 */
/**
 * One normalization for every place an account name leaves this file. Rails
 * STORES the trimmed name and the worker MATCHES the trimmed name, so a
 * padded " Work" sent raw would create a connection under one name and then
 * fail to select — or disconnect — it ever after.
 *
 * A name that was SUPPLIED but is blank after trimming throws instead of
 * being dropped: silently omitting it would make executeAction fall through
 * to the DEFAULT account — running the action on a mailbox the caller never
 * named, the exact failure the alias option exists to prevent.
 */
function cleanAlias(alias?: string): string | undefined {
  if (alias === undefined || alias === null) return undefined;
  const trimmed = alias.trim();
  if (!trimmed) {
    throw new Error('alias, when provided, must be a non-empty string');
  }
  return trimmed;
}

export async function executeAction(
  actionName: string,
  params: Record<string, any>,
  options?: { alias?: string }
): Promise<any> {
  const token = getAuthToken();
  if (!token) {
    throw new Error('No authentication token available');
  }

  const startTime = Date.now();
  const alias = cleanAlias(options?.alias);

  try {
    // Derive provider from action name (e.g., SLACK_SEND_MESSAGE → slack)
    const provider = actionName.split('_')[0]?.toLowerCase() || '';

    const response = await fetch('/api/composio/execute', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        action: actionName,
        params,
        provider,
        // Only sent when named. An `alias: undefined` key would serialize
        // away anyway, but an explicit null would reach the worker as a
        // "requested" alias and 400.
        ...(alias ? { alias } : {})
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || `Action failed: ${response.statusText}`);
    }

    const result = await response.json();

    // Track usage for analytics
    trackActionUsage(actionName, 'success', Date.now() - startTime);

    return result.data || result.output || result;

  } catch (error: any) {
    trackActionUsage(actionName, 'error', Date.now() - startTime);
    throw error;
  }
}

/**
 * Execute a public, no-auth Composio action — Pattern A (May 2026).
 *
 * Use this INSTEAD of `executeAction()` when:
 *   1. The app is public-visible (anonymous visitors can use it)
 *   2. The toolkit is no_auth (Cats, Tavily, Exa, HackerNews,
 *      Wikipedia, Brave Search, Composio Search, etc.)
 *
 * No Bearer token is sent. The deployed worker proxies the call to
 * Composio using server-only credentials (the creator's COMPOSIO_API_KEY
 * never leaves the worker). The worker enforces:
 *   - Origin pinning (request must come from this app's hostname)
 *   - No-auth-toolkit allowlist (auth'd toolkits return 403)
 *   - Per-IP hourly + per-app daily rate limits
 *
 * For auth'd toolkits (Slack/Gmail/creator's API keys) you MUST use
 * `executeAction()` with a signed-in user — the public path will reject
 * those with code `PUBLIC_PROXY_REQUIRES_AUTH`.
 *
 * @example
 * ```typescript
 * const cat = await publicAction('CATS_SEARCH_IMAGES', { breed_ids: 'beng' })
 * ```
 */
export async function publicAction(
  actionName: string,
  params: Record<string, any>
): Promise<any> {
  const startTime = Date.now()

  try {
    const provider = actionName.split('_')[0]?.toLowerCase() || ''

    // Note: NO Authorization header. The worker uses server-side
    // creds. Adding a Bearer here would just be ignored.
    const response = await fetch('/api/composio/public/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: actionName, params, provider })
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      // Surface the worker's structured error code so callers can
      // distinguish "needs sign-in" from "rate limited" from generic
      // failure and render the right UI state.
      const err: any = new Error(errorData.error || `Action failed: ${response.statusText}`)
      err.code = errorData.code
      err.cap = errorData.cap
      err.scope = errorData.scope
      throw err
    }

    const result = await response.json()
    trackActionUsage(actionName, 'success', Date.now() - startTime)
    return result.data || result.output || result
  } catch (error: any) {
    trackActionUsage(actionName, 'error', Date.now() - startTime)
    throw error
  }
}

/**
 * Check if an integration is connected
 *
 * @example
 * ```typescript
 * const isConnected = await isIntegrationConnected('slack');
 * if (!isConnected) {
 *   // Show connect button
 * }
 * ```
 */
export async function isIntegrationConnected(integrationSlug: string): Promise<boolean> {
  const token = getAuthToken();
  if (!token) return false;

  try {
    const response = await fetch(`/api/composio/status/${integrationSlug}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) return false;

    const data = await response.json();
    return data.connected === true;

  } catch {
    return false;
  }
}

/**
 * Get connection status with details
 */
export async function getConnectionStatus(integrationSlug: string): Promise<ConnectionStatus | null> {
  const token = getAuthToken();
  if (!token) return null;

  try {
    const response = await fetch(`/api/composio/status/${integrationSlug}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) return null;

    return await response.json();

  } catch {
    return null;
  }
}

/**
 * Initiate OAuth connection flow — Pattern B (May 2026).
 *
 * Sends the SIGNED-IN user through the OverSkill-managed Composio OAuth
 * flow for the named provider. Their resulting `connected_account_id`
 * becomes user-scoped (NOT shared with other visitors), so subsequent
 * `executeAction('GMAIL_SEND_EMAIL', ...)` calls execute against THIS
 * user's account.
 *
 * Pre-condition: the user MUST be signed in (we use their JWT). Calling
 * this anonymously throws because per-user OAuth has no meaning without
 * a user identity.
 *
 * @example
 * ```typescript
 * // In a "Connect my Gmail" button click handler
 * await initiateConnection('gmail');
 * // User redirects to Composio → Google → back here
 *
 * // Connect a SECOND account and name it, so actions can pick between them
 * await initiateConnection('gmail', { alias: 'Work' });
 * ```
 *
 * @param options.alias Optional — name this connection. REQUIRED to connect a
 *        second account for the same provider: without a name the re-click is
 *        read as a plain reconnect of the existing one. Pass the same name to
 *        `executeAction(..., { alias })` to run an action on this account.
 */
export async function initiateConnection(
  integrationSlug: string,
  options?: { returnTo?: string; alias?: string }
): Promise<void> {
  const token = getAuthToken();
  if (!token) {
    throw new Error(
      `Sign-in required to connect ${integrationSlug}. ` +
      `Per-user integrations require an authenticated user — anonymous visitors cannot connect their own accounts.`
    );
  }

  // Where to send the user after OAuth completes. Defaults to the
  // current path INCLUDING query string + hash so the connect flow
  // returns to wherever the user clicked the button — preserves
  // deep-linked state (e.g. /dashboard?tab=integrations#gmail).
  // Sourcery (PR #462 review) flagged that path-only would drop
  // search + hash and lose deep-linked context.
  const currentPathWithState = typeof window !== 'undefined'
    ? window.location.pathname + window.location.search + window.location.hash
    : '/'
  const returnTo = options?.returnTo || currentPathWithState

  // Hit the platform's per-user connect endpoint. Rails owns the
  // ComposioService instantiation with `scope: :user` so the
  // resulting connected_account is tied to THIS user's app_user_id,
  // not the creator's team.
  //
  // Use VITE_PLATFORM_URL — the canonical platform-host system var bound on
  // every app (AppEnvVar.system_defaults) and healed to the CORS-safe www
  // host on each deploy (AppEnvVar.heal_platform_url! ->
  // OverskillJwtService.platform_issuer_url, which normalizes apex->www per
  // PR #1898). The www fallback matches every other template file
  // (callback/login/settings/logged-out/access-denied/ErrorBoundary).
  // Previously this read an unbound legacy var and fell back to the apex
  // host, whose 301->www drops the POST body cross-origin and silently broke
  // per-user Composio connect (audit MEDIUM-1, same root cause as PR #1898).
  const apiBase = (import.meta as any).env?.VITE_PLATFORM_URL || 'https://www.overskill.com'
  const finalReturnUrl = typeof window !== 'undefined' ? `${window.location.origin}${returnTo}` : returnTo

  const alias = cleanAlias(options?.alias)
  const response = await fetch(`${apiBase}/api/v1/user_integrations/${integrationSlug}/connect_url`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      return_url: finalReturnUrl,
      ...(alias ? { alias } : {})
    })
  })

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}))
    throw new Error(errorData.error || `Failed to start ${integrationSlug} connection: ${response.statusText}`)
  }

  // Endpoint returns { type: 'redirect', provider: 'composio', url: '...' }
  const { url: redirectUrl } = await response.json()
  if (!redirectUrl) {
    throw new Error(`No redirect URL returned for ${integrationSlug} — platform may not support per-user OAuth for this provider yet.`)
  }

  // Hard navigate (NOT a fetch) — Composio needs to render its own
  // consent screen and capture the user's interaction. After they
  // complete OAuth, Rails handles the callback, writes the
  // UserIntegration row, mirrors it to KV (so this app's worker can
  // see it), and redirects back to `return_url`.
  if (typeof window !== 'undefined') {
    window.location.href = redirectUrl
  }
}

/**
 * Disconnect the current user's integration — Pattern B.
 *
 * Removes their UserIntegration row in Rails, which triggers a
 * Cloudflare KV delete so the worker can no longer find this user's
 * connected_account_id for the named provider. Future
 * `executeAction()` calls fall through to the team-level connection
 * (if any) or return an "integration not connected" error.
 *
 * @param integrationSlug Toolkit slug (e.g. 'gmail', 'slack')
 * @param options.alias Optional — disconnect a SPECIFIC instance
 *        ("Personal Gmail" vs "Work Gmail"). Without it, disconnects
 *        ALL the user's instances for this slug. Sourcery (PR #462
 *        review) suggested exposing alias to support multi-instance
 *        UIs where users connect more than one of the same provider.
 */
export async function disconnectIntegration(
  integrationSlug: string,
  options?: { alias?: string }
): Promise<boolean> {
  const token = getAuthToken();
  if (!token) {
    console.warn(`[Composio] Cannot disconnect ${integrationSlug} — not signed in.`)
    return false
  }

  try {
    // VITE_PLATFORM_URL — the bound, www-normalized platform host (see the
    // matching note in initiateConnection). The previous apex fallback's
    // 301->www dropped the DELETE body cross-origin, so per-user disconnect
    // silently failed (audit MEDIUM-1).
    const apiBase = (import.meta as any).env?.VITE_PLATFORM_URL || 'https://www.overskill.com'
    const url = new URL(`${apiBase}/api/v1/user_integrations/${integrationSlug}`)
    const alias = cleanAlias(options?.alias)
    if (alias) url.searchParams.set('alias', alias)

    const response = await fetch(url.toString(), {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    })
    return response.ok
  } catch (error: any) {
    console.error(`[Composio] disconnect ${integrationSlug} error:`, error?.message)
    return false
  }
}

// ============================================
// React Hooks
// ============================================

/**
 * React Hook: useComposio
 *
 * Provides Composio action execution
 *
 * @example
 * ```typescript
 * function NotificationSender() {
 *   const { execute, loading, error } = useComposio();
 *
 *   const sendSlackMessage = async () => {
 *     await execute('SLACK_SEND_MESSAGE', {
 *       channel: '#alerts',
 *       text: 'New order received!'
 *     });
 *   };
 *
 *   return (
 *     <Button onClick={sendSlackMessage} disabled={loading}>
 *       Send Notification
 *     </Button>
 *   );
 * }
 * ```
 */
export function useComposio() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const execute = useCallback(async (actionName: string, params: Record<string, any>) => {
    setLoading(true);
    setError(null);

    try {
      const result = await executeAction(actionName, params);
      return result;
    } catch (err: any) {
      setError(err.message);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  return { execute, loading, error };
}

/**
 * React Hook: useIntegrationConnection
 *
 * Check and manage integration connection status
 *
 * @example
 * ```typescript
 * function SlackIntegration() {
 *   const { connected, loading, connect, disconnect } = useIntegrationConnection('slack');
 *
 *   if (loading) return <LoadingSpinner />;
 *
 *   if (!connected) {
 *     return <Button onClick={connect}>Connect Slack</Button>;
 *   }
 *
 *   return (
 *     <div>
 *       <span>Slack connected!</span>
 *       <Button onClick={disconnect} variant="outline">Disconnect</Button>
 *     </div>
 *   );
 * }
 * ```
 */
export function useIntegrationConnection(integrationSlug: string) {
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;

    isIntegrationConnected(integrationSlug)
      .then(isConnected => {
        if (mounted) {
          setConnected(isConnected);
          setLoading(false);
        }
      })
      .catch(() => {
        if (mounted) {
          setConnected(false);
          setLoading(false);
        }
      });

    return () => {
      mounted = false;
    };
  }, [integrationSlug]);

  const connect = useCallback(async () => {
    await initiateConnection(integrationSlug);
  }, [integrationSlug]);

  const disconnect = useCallback(async () => {
    const success = await disconnectIntegration(integrationSlug);
    if (success) {
      setConnected(false);
    }
    return success;
  }, [integrationSlug]);

  return { connected, loading, connect, disconnect };
}

// ============================================
// Helper Functions
// ============================================

/**
 * Get authentication token from storage
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
 * Track action usage for analytics
 */
function trackActionUsage(actionName: string, status: string, durationMs: number) {
  try {
    // Non-blocking analytics
    fetch('/api/analytics/record', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        integrationSlug: actionName.split('_')[0].toLowerCase(),
        endpoint: actionName,
        tier: 'composio',
        status,
        responseTimeMs: durationMs
      })
    }).catch(() => {
      // Don't fail if analytics fails
    });
  } catch {
    // Ignore analytics errors
  }
}

// ============================================
// Exports
// ============================================

export default {
  executeAction,
  isIntegrationConnected,
  getConnectionStatus,
  initiateConnection,
  disconnectIntegration,
  useComposio,
  useIntegrationConnection
};
