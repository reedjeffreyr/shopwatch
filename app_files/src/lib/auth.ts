// Authentication utilities using overskill-sdk
// This file is pre-generated in the template - users rarely need to modify it
//
// IMPORTANT: Auth functions in this file NEVER do window.location.href redirects.
// They return results and let the caller (ProtectedRoute, etc.) handle navigation
// via React Router. This prevents full page reloads that break SPA state.

import React from 'react';
import { useState, useEffect, useCallback } from 'react'
import { createClient } from 'overskill-sdk'
import { sanitizeStoredToken, reconcileCacheOwner, forceSignOut } from './sessionIntegrity'
import {
  CONFIRM_POLL_INTERVAL_MS,
  CONFIRM_TIMEOUT_MS,
  pollUntil
} from '@/lib/purchase-confirmation'

// ============================================================================
// Types for app context (roles and permissions)
// ============================================================================

export interface AppPermissions {
  [key: string]: unknown
}

// /api/auth/me omits app_id; JWT/editor contexts also vary by token age and
// identity source. Claims are optional, IDs may be strings or numbers, and
// permission values are not restricted by the producer to a primitive union.
export interface AppContext {
  [claim: string]: unknown
  app_id?: string
  app_user_id?: string | number
  roles?: string[]
  permissions?: AppPermissions
}

export interface OverSkillUser {
  id: string
  email: string
  name?: string
  app_context?: AppContext
  /**
   * @deprecated Do not gate on this. It is a BACKWARD-COMPATIBILITY SHIM for
   * bundles that were published with the old gate below (see OS-9K723B): those
   * bundles are baked and cannot be changed from here, so the platform answers
   * the boolean for them server-side instead. It is a binary and cannot express
   * a tier.
   *
   * New code reads `overskill.entitlements` / the `useEntitlement()` hook, which
   * hit the KV-backed `/api/me/entitlements` endpoint and support multi-tier.
   * The field stays declared so already-generated apps that reference it keep
   * type-checking.
   */
  has_active_subscription?: boolean
}

/**
 * Result from checkAppAccess() - tells the caller whether access is granted
 * and where to redirect if not. The caller handles navigation (not this module).
 */
export interface AccessResult {
  allowed: boolean
  redirect?: string   // Where to redirect if not allowed (e.g. '/login', '/purchase')
  reason?: string     // Human-readable reason for logging
}

/**
 * Resolve the EFFECTIVE user id from a decoded JWT payload.
 *
 * OS-7E39Q8 (Jul 2026): a JWT carries TWO different id spaces, and the Worker
 * and the client MUST agree on which one is "me":
 *   - `app_context.app_user_id` / `app_user_id` -> app_users.id  (e.g. 2397)
 *   - `sub`                                    -> users.id       (e.g. 1271)
 *
 * The Worker resolves identity as `app_context.app_user_id || app_user_id || sub`
 * (see validateJWT in worker_api_template.rb) and stamps every row + participant
 * gate with THAT value. `/api/auth/me` echoes the same value as `user.id`.
 *
 * The local-decode fast paths below (used in the editor preview iframe to avoid
 * a race with the postMessage auth handshake) previously read bare `payload.sub`.
 * On any app where app_users.id !== users.id that made the browser believe it was
 * a different user than the server did, so every client-vs-server identity
 * comparison failed: 403 on participant-gated reads (re-firing on every poll),
 * own records rendering as another user's, and member counts disagreeing.
 *
 * Keep this precedence identical to the Worker's. Never read `sub` alone here.
 */
export function resolveEffectiveUserId(payload: any): string | undefined {
  const id =
    payload?.app_context?.app_user_id ??
    payload?.app_user_id ??
    payload?.sub

  return id == null ? undefined : String(id)
}

// The sign-in token the platform lands on /callback#access_token=… is adopted
// by lib/callbackTokenBoot.ts — main.tsx's FIRST import, so it runs before the
// `overskill-sdk` import above constructs the SDK singleton. Do not adopt it
// here: by the time this module body runs the SDK has already booted. The rule
// (fragment only, /callback only, aud must name THIS app, exp in the future)
// lives in ./callbackToken (SW-102).

// Session integrity boot gate (Russell's session-integrity report): purge an
// EXPIRED or malformed `overskill_token` from localStorage BEFORE the SDK client
// is constructed and before any authenticated UI paints. Historically nothing
// client-side read the token's `exp`, so a dead token was treated as a live
// session — the app rendered a phantom identity (decoded from the unverified
// JWT) over a wrong-uid empty cache. Runs AFTER the URL-hash extraction above so
// a fresh login token (not expired) is never dropped. This is a LOCAL claims
// read for UI gating; the server stays the authority on every request.
//
// Capture whether a DEAD token was dropped this load: sanitize itself never
// redirects or shows a message (that would break public routes), but an
// AUTHENTICATED route that then finds no session uses this to show the calm
// "Your session expired" copy instead of a bare login screen (acceptance #3).
const bootDroppedDeadToken = sanitizeStoredToken()

// Initialize OverSkill client
const overskillClient = createClient({
  appId: import.meta.env.VITE_APP_ID,
  debug: import.meta.env.DEV
})

// Export overskill client
export const overskill = overskillClient

/**
 * The contexts in which auth verification is legitimately SKIPPED for this
 * page load, or null when it is not.
 *
 * ONE list, because two call sites now need the same answer and a second copy
 * is how they drift. `checkAppAccess()` used to carry these three checks
 * inline; `resolveRouteAccess()` below needs exactly the same ones, and a
 * route gate that skipped a bypass the visibility gate honours would log
 * URLbox out of every screenshot and break every E2B preview.
 *
 * - `/logged-out` renders the logout confirmation and is reachable by
 *   definition signed out.
 * - SCREENSHOT_MODE is injected by the Worker after it validated URLbox's
 *   X-Preview-Auth header. Preview screenshots have no session and must not
 *   capture a login page.
 * - The HMR preview bypass trusts a token the editor delivered by postMessage,
 *   because inside an E2B sandbox the platform API routes are not reachable to
 *   verify it against.
 */
export function authVerificationBypassed(): string | null {
  if (typeof window === 'undefined') return null

  if (window.location.pathname === '/logged-out') return 'logged_out_route'

  if ((window as any).APP_CONFIG?.SCREENSHOT_MODE) return 'screenshot_mode'

  const isInIframe = window.self !== window.top
  const hostname = window.location.hostname
  // E2B hosts are current. The sprites.app/overskillprojects.com entries
  // remain only so already-published generated clients do not lose auth
  // compatibility. *.overskillprojects.dev is the multi-zone proxy domain
  // that fronts E2B sandboxes.
  const isHmrPreview =
    hostname.includes('sprites.app') ||
    hostname.includes('overskillprojects.com') ||
    hostname.includes('e2b.app') ||
    hostname.includes('overskillprojects.dev')

  // The editor token is held by the SDK even when third-party storage is
  // denied. Storage availability must not determine preview authentication.
  const hasPreviewToken = !!getAuthToken()

  if (isInIframe && isHmrPreview && hasPreviewToken) return 'hmr_preview'

  return null
}

/**
 * Require authentication for protected routes.
 * Returns the user if authenticated, or null if not.
 * DOES NOT redirect — the caller should use React Router <Navigate> for that.
 */
export async function requireAuth() {
  // Screenshot mode bypass: URLbox is capturing with valid X-Preview-Auth header
  // The Worker validated the token and injected SCREENSHOT_MODE=true
  // Return a mock user to bypass auth so URLbox can capture actual app content
  if (typeof window !== 'undefined' && (window as any).APP_CONFIG?.SCREENSHOT_MODE) {
    console.log('[OverSkill Auth] Screenshot mode detected in requireAuth(), returning mock user')
    return { id: 'screenshot-user', email: 'screenshot@overskill.app' }
  }

  try {
    const user = await overskill.auth.checkSession()

    if (!user) {
      console.warn(
        '🔒 [OverSkill Auth] requireAuth(): User not authenticated',
        {
          currentPath: window.location.pathname,
          timestamp: new Date().toISOString(),
          suggestion: 'Caller should redirect to /login via React Router.'
        }
      )
      return null
    }

    return user
  } catch (error) {
    console.error(
      '❌ [OverSkill Auth] requireAuth() error:',
      error instanceof Error ? error.message : String(error),
      {
        currentPath: window.location.pathname,
        suggestion: 'Check authentication configuration and API availability.'
      }
    )
    return null
  }
}

/**
 * Check app access based on visibility settings.
 * Returns an AccessResult telling the caller whether access is granted
 * and where to redirect if not.
 *
 * IMPORTANT: This function NEVER does window.location.href redirects.
 * The caller (ProtectedRoute) handles navigation via React Router <Navigate>.
 * This keeps everything within the SPA and prevents full page reload loops.
 *
 * Handles: public, login_required, purchase_required, domain_restricted
 */
export async function checkAppAccess(): Promise<AccessResult> {
  // Access-control single source of truth (access-control-visibility-sot, Jul 2026).
  //
  // BUG 2 (stale visibility bake): VITE_APP_VISIBILITY is a Vite BUILD-TIME env
  // var inlined into this bundle at build time. When a creator changes
  // app.visibility in the DB (e.g. domain_restricted -> public), this deployed
  // bundle keeps enforcing the OLD baked value until a rebuild — which stranded
  // a now-public app on /access-denied (the Mindflow / NbOBZj incident).
  //
  // Fix: PREFER the RUNTIME value the Worker injects into window.APP_CONFIG
  // (APP_CONFIG.appVisibility) over the stale build-time bake. The Worker only
  // injects APP_CONFIG.appVisibility when the :runtime_app_visibility flag is ON
  // for the app's team (WFP#generate_computed_environment_variables ->
  // injectAppConfig), so:
  //   - flag ON  : the DB value wins on the very next request, no rebuild
  //   - flag OFF : APP_CONFIG.appVisibility is undefined and we fall back to the
  //                baked import.meta.env.VITE_APP_VISIBILITY exactly as before
  //                (byte-identical behavior). Also the fallback for any bundle
  //                deployed before the Worker started injecting the runtime value.
  const runtimeVisibility =
    typeof window !== 'undefined' ? (window as any).APP_CONFIG?.appVisibility : undefined
  const appVisibility = runtimeVisibility || import.meta.env.VITE_APP_VISIBILITY || 'public'

  // The three legitimate bypasses (logged-out route, URLbox screenshot mode,
  // E2B preview handshake) live in ONE place now — a route gate needs exactly
  // the same list and a second copy is how the two drift apart.
  const bypassReason = authVerificationBypassed()
  if (bypassReason) {
    if (bypassReason !== 'logged_out_route') {
      console.log(`[OverSkill Auth] ${bypassReason} detected, bypassing auth check`)
    }
    return { allowed: true }
  }

  switch (appVisibility) {
    case 'public':
      // No restrictions - anyone can access
      return { allowed: true }

    case 'login_required':
      // Must be logged in to access
      try {
        const user = await overskill.auth.checkSession()
        if (!user) {
          console.warn(
            '🔒 [OverSkill Auth] Access denied: User not logged in (login_required)',
            {
              visibility: 'login_required',
              currentPath: window.location.pathname,
              timestamp: new Date().toISOString()
            }
          )
          // If we just dropped an EXPIRED token at boot, this is a lapsed
          // session (not a never-logged-in visitor) — stash the calm
          // "session expired" message so /login shows it (acceptance #3).
          if (bootDroppedDeadToken) {
            forceSignOut('session_expired', { appId: import.meta.env.VITE_APP_ID, skipRedirect: true })
          }
          return { allowed: false, redirect: '/login', reason: 'not_authenticated' }
        }
        // Identity-match assertion (session integrity, layer 2): the server-
        // confirmed uid must own the user-scoped cache on this device. If it
        // differs (e.g. a sibling-origin token for a different account, or a
        // shared device), do NOT render cached data or an empty dashboard under
        // the wrong identity — reconcileCacheOwner clears the stale pointer keys
        // for the OLD uid only, and we treat it as a forced logout. skipRedirect:
        // ProtectedRoute performs the SPA <Navigate to="/login"> below.
        if (reconcileCacheOwner(import.meta.env.VITE_APP_ID, String(user.id)) === 'mismatch') {
          forceSignOut('identity_mismatch', { appId: import.meta.env.VITE_APP_ID, skipRedirect: true })
          return { allowed: false, redirect: '/login', reason: 'identity_mismatch' }
        }
        return { allowed: true }
      } catch (error) {
        console.error(
          '❌ [OverSkill Auth] Authentication check failed:',
          error instanceof Error ? error.message : String(error),
          {
            visibility: 'login_required',
            currentPath: window.location.pathname,
            suggestion: 'Check if authentication API is accessible or token is valid.'
          }
        )
        return { allowed: false, redirect: '/login', reason: 'auth_check_failed' }
      }

    case 'purchase_required':
      // Must hold an ACTIVE entitlement for this app.
      //
      // DEAD-FIELD FIX (OS-9K723B / OS-AZT2BB, Aug 2026). This gate used to
      // branch on `paidUser.has_active_subscription`. When it shipped, no
      // platform endpoint emitted that key — `/api/auth/me` returned
      // { id, overskill_user_id, email, name, picture, roles, permissions,
      //   app_context{...}, isLegacyToken } and the SDK's AuthClient.me()
      // passed it through untouched — so the field was always `undefined`,
      // `!undefined` was always true, and EVERY authenticated buyer on a
      // `purchase_required` app was sent to /purchase, including buyers holding
      // a paid, active membership. The paywall was unconditional.
      //
      // Read live entitlements instead. `/api/me/entitlements` is KV-backed,
      // written by Apps::EntitlementKvWriter on AppMembership lifecycle hooks,
      // already populated, and already the surface `useEntitlement()` trusts.
      // The platform's own marketplace auditor and agent prompt already tell
      // creators not to branch on the boolean; this gate simply never migrated.
      //
      // THIS CHANGE ONLY REACHES APPS BUILT FROM THE TEMPLATE AFTER IT LANDS.
      // `src/lib/auth.ts` is baked into every bundle that is already published,
      // and PreviewFilePatcher does not touch this file (and is preview-only).
      // Already-published apps are unblocked by the platform emitting the old
      // boolean off this same KV, which needs no rebuild and no republish. Do
      // not reintroduce a read of that boolean here to "match" it: the shim
      // exists for bundles that cannot be changed, and it cannot express a tier.
      //
      // FAIL-CLOSED, deliberately: `overskill.entitlements.list()` swallows
      // network/auth failures and answers `[]`, so a transient blip sends the
      // buyer to /purchase rather than opening a paid app to the world. That is
      // the same posture as every other consumer of this endpoint. The
      // post-purchase race (a buyer arriving from checkout a few hundred ms
      // before the entitlement lands) is already handled one layer up by
      // waitForAppAccess()/ProtectedRoute, which re-asks this function on a
      // bounded poll instead of rendering the paywall on the first "no".
      try {
        const paidUser = await overskill.auth.checkSession()
        if (!paidUser) {
          if (bootDroppedDeadToken) {
            forceSignOut('session_expired', { appId: import.meta.env.VITE_APP_ID, skipRedirect: true })
          }
          return { allowed: false, redirect: '/login', reason: 'not_authenticated' }
        }
        // ACTIVE_STATUSES here MUST stay in sync with the SDK's
        // entitlement-client (`['active','trialing']`) and with Rails'
        // AppMembership::ENTITLED_STATUSES — all three agree today.
        const entitlements = await overskill.entitlements.list()
        const hasActiveEntitlement =
          Array.isArray(entitlements) &&
          entitlements.some(
            (e: { status?: string }) => e && (e.status === 'active' || e.status === 'trialing')
          )
        if (!hasActiveEntitlement) {
          return { allowed: false, redirect: '/purchase', reason: 'no_subscription' }
        }
        return { allowed: true }
      } catch (error) {
        return { allowed: false, redirect: '/login', reason: 'auth_check_failed' }
      }

    case 'domain_restricted':
      // Must login with allowed email domain
      try {
        const domainUser = await overskill.auth.checkSession()
        if (!domainUser) {
          if (bootDroppedDeadToken) {
            forceSignOut('session_expired', { appId: import.meta.env.VITE_APP_ID, skipRedirect: true })
          }
          return { allowed: false, redirect: '/login', reason: 'not_authenticated' }
        }
        // Prefer the RUNTIME email allow-list (APP_CONFIG.allowedEmailDomains,
        // injected by the Worker when :runtime_app_visibility is ON) over the
        // stale build-time bake (VITE_ALLOWED_DOMAINS). Same SoT logic as
        // appVisibility above. Fall back to the baked value when the runtime
        // value is absent (flag OFF / older bundle).
        const runtimeAllowed =
          typeof window !== 'undefined' ? (window as any).APP_CONFIG?.allowedEmailDomains : undefined
        const allowedDomainsRaw =
          runtimeAllowed !== undefined && runtimeAllowed !== null
            ? runtimeAllowed
            : (import.meta.env.VITE_ALLOWED_DOMAINS || '')
        const allowedDomains = allowedDomainsRaw.split(',').filter((d: string) => d)

        // BUG 1 (empty-allowlist-blocks-everyone, ungated correctness fix):
        // An EMPTY allow-list means "no domain restriction configured yet", NOT
        // "block everyone". Previously [].includes(anything) === false blocked
        // EVERY authenticated user (the empty-allowlist strand). Treat an empty
        // list as no-restriction and ALLOW any authenticated user — never
        // redirect to /access-denied on an empty list. Allowing on empty is
        // strictly safer and matches the intended "restrict to these domains"
        // semantics (with zero domains, there is nothing to restrict to).
        if (allowedDomains.length === 0) {
          return { allowed: true }
        }

        const userDomain = domainUser.email.split('@')[1]

        if (!allowedDomains.includes(userDomain)) {
          return { allowed: false, redirect: '/access-denied', reason: 'domain_not_allowed' }
        }
        return { allowed: true }
      } catch (error) {
        return { allowed: false, redirect: '/login', reason: 'auth_check_failed' }
      }

    default:
      return { allowed: true }
  }
}

/**
 * The decision a PROTECTED ROUTE actually needs: app visibility AND a
 * signed-in user.
 *
 * `checkAppAccess()` answers a different question — "may this VISITOR see this
 * APP?" — and on the default `public` visibility the honest answer is yes for
 * everybody. That is correct for the app, and it is why `<ProtectedRoute>`
 * protected nothing on a public app: the visibility gate said yes, the
 * component rendered its children, and the member-only page inside then hit
 * its own `if (!user) return` and stopped. The visitor got a nav shell, ZERO
 * data requests, no empty state, no error and no redirect — a working app that
 * looks broken.
 *
 * MEASURED on generated apps 402 and 403 (staging, 2026-08-27), issue #5505,
 * on a genuine full page load with no token, after 8 seconds:
 *
 *   { "url": ".../circle/courses", "token": null, "bodyTextLen": 172,
 *     "entityRequests": [], "navShowsLogOut": true,
 *     "hasEmptyStateOrError": false }
 *
 * Both apps DID wrap `/circle` in `<ProtectedRoute>`. The route gate was
 * asking the wrong question, not missing.
 *
 * So a protected route asks BOTH questions. Visibility first (an app-level
 * "no" — no entitlement, wrong email domain — keeps its own destination and
 * its own reason), then identity. Bypasses are honoured for the same reasons
 * `checkAppAccess()` honours them; see `authVerificationBypassed()`.
 */
export async function resolveRouteAccess(): Promise<AccessResult> {
  const visibility = await checkAppAccess()
  if (!visibility.allowed) return visibility

  if (authVerificationBypassed()) return visibility

  const user = await requireAuth()
  if (user) return visibility

  // A lapsed session, not a never-signed-in visitor: stash the calm "session
  // expired" message so /login shows it instead of a bare sign-in form. Same
  // treatment the login_required branch of checkAppAccess() already gives it.
  if (bootDroppedDeadToken) {
    forceSignOut('session_expired', { appId: import.meta.env.VITE_APP_ID, skipRedirect: true })
  }

  console.warn('🔒 [OverSkill Auth] Protected route requires a signed-in user', {
    currentPath: typeof window !== 'undefined' ? window.location.pathname : '',
    appVisibility: 'allowed_by_visibility'
  })

  return { allowed: false, redirect: '/login', reason: 'not_authenticated' }
}

/**
 * Re-ask checkAppAccess() on a fast bounded poll until access is GRANTED.
 *
 * The post-purchase confirmation read (ticket OS-C7KWQF). A buyer returning
 * from checkout gets their entitlement server-side in 1-2s, but the single
 * immediate `checkAppAccess()` on arrival is routinely a few hundred
 * milliseconds early — and on a `purchase_required` app that one early "no"
 * used to be rendered as `/purchase`, i.e. the paywall for the thing they had
 * just bought. Polling here is what turns that into "Confirming your
 * purchase…" followed by the app.
 *
 * Returns the LAST result observed, so a caller that timed out can still see
 * why it was denied. Never throws: `pollUntil` treats a throwing check as
 * "not yet", so a flaky session read can never collapse the confirming state
 * into a paywall.
 *
 * NOTE this only ever re-READS the server's decision — it cannot grant
 * anything. A buyer who genuinely has no entitlement still ends up denied,
 * just after a bounded wait instead of instantly.
 */
export async function waitForAppAccess(
  opts: { intervalMs?: number; timeoutMs?: number } = {}
): Promise<AccessResult> {
  let last: AccessResult = { allowed: false, reason: 'confirmation_pending' }

  await pollUntil(
    async () => {
      last = await checkAppAccess()
      return last.allowed === true
    },
    {
      intervalMs: opts.intervalMs ?? CONFIRM_POLL_INTERVAL_MS,
      timeoutMs: opts.timeoutMs ?? CONFIRM_TIMEOUT_MS
    }
  )

  return last
}

/**
 * Get current user or null (doesn't throw)
 */
export async function getCurrentUser() {
  return await overskill.auth.checkSession()
}

/**
 * Check if user is authenticated (synchronous)
 */
export function isAuthenticated() {
  return overskill.auth.isAuthenticated()
}

/**
 * Get the current authentication token (synchronous)
 * Use this for making authenticated API calls to backend endpoints
 *
 * @returns The JWT token string or null if not authenticated
 *
 * @example
 * ```typescript
 * import { getAuthToken } from '@/lib/auth'
 *
 * const response = await fetch('/api/backend/send-gmail-email', {
 *   method: 'POST',
 *   headers: {
 *     'Authorization': `Bearer ${getAuthToken()}`,
 *     'Content-Type': 'application/json'
 *   },
 *   body: JSON.stringify({ to: 'user@example.com', subject: 'Hello', body: 'Hi!' })
 * })
 * ```
 */
export function getAuthToken(): string | null {
  return overskill.auth.getToken()
}

// ============================================================================
// Role and Permission Helpers
// ============================================================================

// #2374: silently re-mint the JWT once per page load when a role/permission
// check comes back negative — covers the case where a role was granted
// server-side AFTER the 24h token was issued (the live token has stale claims).
// Guarded so it runs at most once and is a no-op on SDK builds that predate
// overskill.auth.refresh(). Returns true only when it actually refreshed this
// call, so the caller knows to re-check.
let attemptedSilentRoleRefresh = false
async function refreshRolesOnce(): Promise<boolean> {
  if (attemptedSilentRoleRefresh) return false
  attemptedSilentRoleRefresh = true

  const refreshFn = (overskill.auth as any)?.refresh
  if (typeof refreshFn !== 'function') return false

  try {
    const refreshedUser = await refreshFn.call(overskill.auth)
    return refreshedUser !== null
  } catch {
    // Best-effort — keep the current token.
    return false
  }
}

/**
 * Check if the current user has a specific role
 * @param roleKey - The role key to check (e.g., 'admin', 'premium')
 * @returns Promise<boolean>
 */
export async function hasRole(roleKey: string): Promise<boolean> {
  const user = await overskill.auth.checkSession()
  if (user?.app_context?.roles?.includes(roleKey)) return true

  // Negative result — try one silent refresh and re-check (issue #2374).
  if (await refreshRolesOnce()) {
    const refreshed = await overskill.auth.checkSession()
    return refreshed?.app_context?.roles?.includes(roleKey) ?? false
  }
  return false
}

/**
 * Check if the current user has any of the specified roles
 * @param roleKeys - Array of role keys to check
 * @returns Promise<boolean>
 */
export async function hasAnyRole(roleKeys: string[]): Promise<boolean> {
  const user = await overskill.auth.checkSession()
  if (roleKeys.some(key => (user?.app_context?.roles ?? []).includes(key))) return true

  if (await refreshRolesOnce()) {
    const refreshed = await overskill.auth.checkSession()
    const userRoles = refreshed?.app_context?.roles ?? []
    return roleKeys.some(key => userRoles.includes(key))
  }
  return false
}

/**
 * Check if the current user has all of the specified roles
 * @param roleKeys - Array of role keys to check
 * @returns Promise<boolean>
 */
export async function hasAllRoles(roleKeys: string[]): Promise<boolean> {
  const user = await overskill.auth.checkSession()
  if (roleKeys.every(key => (user?.app_context?.roles ?? []).includes(key))) return true

  if (await refreshRolesOnce()) {
    const refreshed = await overskill.auth.checkSession()
    const userRoles = refreshed?.app_context?.roles ?? []
    return roleKeys.every(key => userRoles.includes(key))
  }
  return false
}

/**
 * Check if the current user has a specific permission
 * @param permissionKey - The permission key to check
 * @returns Promise<boolean>
 */
export async function hasPermission(permissionKey: string): Promise<boolean> {
  const user = await overskill.auth.checkSession()
  if (Boolean(user?.app_context?.permissions?.[permissionKey])) return true

  if (await refreshRolesOnce()) {
    const refreshed = await overskill.auth.checkSession()
    return Boolean(refreshed?.app_context?.permissions?.[permissionKey])
  }
  return false
}

/**
 * Get a permission value for the current user
 * @param permissionKey - The permission key to get
 * @param defaultValue - Default value if permission is not set
 * @returns Promise<T>
 */
export async function getPermission<T = boolean | number | string>(
  permissionKey: string,
  defaultValue?: T
): Promise<T> {
  const user = await overskill.auth.checkSession()
  const value = user?.app_context?.permissions?.[permissionKey]
  if (value === undefined) {
    return defaultValue as T
  }
  return value as T
}

/**
 * Get all roles for the current user
 * @returns Promise<string[]>
 */
export async function getUserRoles(): Promise<string[]> {
  const user = await overskill.auth.checkSession()
  return user?.app_context?.roles ?? []
}

/**
 * Get all permissions for the current user
 * @returns Promise<Record<string, any>>
 */
export async function getUserPermissions(): Promise<AppPermissions> {
  const user = await overskill.auth.checkSession()
  return user?.app_context?.permissions ?? {}
}

// ============================================================================
// React Hook for Authentication
// ============================================================================

/**
 * React hook for authentication state management
 * Use this in components that need to react to auth state changes
 *
 * @example
 * ```tsx
 * function ProfilePage() {
 *   const { user, loading, logout } = useAuth()
 *
 *   if (loading) return <Spinner />
 *   if (!user) return <Navigate to="/login" />
 *
 *   return (
 *     <div>
 *       <p>Welcome, {user.email}!</p>
 *       <button onClick={logout}>Logout</button>
 *     </div>
 *   )
 * }
 * ```
 */
export function useAuth() {
  const [user, setUser] = useState<OverSkillUser | null>(null)
  const [loading, setLoading] = useState(true)

  // Check session on mount + listen for preview auth token arrival
  useEffect(() => {
    let mounted = true

    // Detect HMR preview mode (iframe on sprites.app, overskillprojects.com,
    // e2b.app, or overskillprojects.dev — the proxy zone for E2B).
    // May 2026: e2b.app + overskillprojects.dev added so login-required apps
    // in E2B sandboxes use the JWT-local-decode fast path;
    // otherwise the API call race makes auth flicker through
    // "loading → unauthenticated" before the token is parsed.
    const isInIframe = typeof window !== 'undefined' && window.self !== window.top
    const hostname = typeof window !== 'undefined' ? window.location.hostname : ''
    const isHmrPreview = isInIframe && (
      hostname.includes('sprites.app') ||
      hostname.includes('overskillprojects.com') ||
      hostname.includes('e2b.app') ||
      hostname.includes('overskillprojects.dev')
    )
    async function checkAuth() {
      try {
        // In HMR preview mode, try to decode JWT locally first
        // to avoid API call race condition with preview auth postMessage flow
        if (isHmrPreview) {
          const token = getAuthToken()
          if (token) {
            try {
              const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
              // Check if token is not expired
              if (payload.exp && payload.exp > Date.now() / 1000) {
                const localUser: OverSkillUser = {
                  // OS-7E39Q8: must match the Worker's identity precedence,
                  // NOT bare `sub` — see resolveEffectiveUserId().
                  id: resolveEffectiveUserId(payload) as string,
                  email: payload.email,
                  name: payload.name,
                  app_context: payload.app_context
                }
                if (mounted) {
                  setUser(localUser)
                  setLoading(false)
                }
                console.log('[useAuth] HMR preview: decoded user from JWT locally')
                return
              }
            } catch {
              // Token decode failed, fall through to normal check
            }
          }
          // No valid token yet in preview mode — stay in loading state
          // and wait for preview-auth-ready event
          console.log('[useAuth] HMR preview: no valid token yet, waiting for preview auth...')
          return
        }

        const currentUser = await overskill.auth.checkSession()
        if (mounted) {
          setUser(currentUser)
          setLoading(false)
        }
      } catch (error) {
        console.error('[useAuth] Failed to check session:', error)
        if (mounted) {
          setUser(null)
          setLoading(false)
        }
      }
    }

    checkAuth()

    // In HMR preview mode, listen for preview-auth-ready event.
    // This fires after preview-auth.ts receives the token from the parent editor
    function handlePreviewAuthReady() {
      if (!mounted) return
      console.log('[useAuth] Preview auth ready — re-checking session')
      setLoading(true)

      // Token was just set by preview-auth.ts via overskill.auth.setToken()
      // Decode locally to avoid API race condition
      const token = getAuthToken()
      if (token) {
        try {
          const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
          if (payload.exp && payload.exp > Date.now() / 1000) {
            const localUser: OverSkillUser = {
              // OS-7E39Q8: must match the Worker's identity precedence,
              // NOT bare `sub` — see resolveEffectiveUserId().
              id: resolveEffectiveUserId(payload) as string,
              email: payload.email,
              name: payload.name,
              app_context: payload.app_context
            }
            if (mounted) {
              setUser(localUser)
              setLoading(false)
            }
            console.log('[useAuth] Preview auth: user set from JWT')
            return
          }
        } catch {
          // Fall through
        }
      }

      // Fallback: try API call (token should be valid now)
      overskill.auth.checkSession().then(currentUser => {
        if (mounted) {
          setUser(currentUser)
          setLoading(false)
        }
      }).catch(() => {
        if (mounted) {
          setUser(null)
          setLoading(false)
        }
      })
    }

    if (isHmrPreview) {
      window.addEventListener('preview-auth-ready', handlePreviewAuthReady)
    }

    // Apr 2026: when the SDK clears the stored token after a 401 (stale,
    // expired, partial-OAuth-callback, etc.), re-render this component
    // as logged-out. Without this, the local-decode optimization above
    // would keep showing the cached user from the JWT payload forever
    // even though every API call is failing — that's the bug Todd hit
    // where the sidebar showed "Todd User" but APIs returned 401.
    function handleAuthCleared() {
      if (!mounted) return
      console.warn('[useAuth] Auth cleared by SDK (401 received) — clearing user state')
      setUser(null)
      setLoading(false)
    }
    window.addEventListener('overskill:auth-cleared', handleAuthCleared)

    return () => {
      mounted = false
      if (isHmrPreview) {
        window.removeEventListener('preview-auth-ready', handlePreviewAuthReady)
      }
      window.removeEventListener('overskill:auth-cleared', handleAuthCleared)
    }
  }, [])

  // Login function
  const login = useCallback(() => {
    overskill.auth.login()
  }, [])

  // Logout function
  const logout = useCallback(() => {
    overskill.auth.logout()
    setUser(null)
  }, [])

  // Refresh user data
  const refreshUser = useCallback(async () => {
    try {
      const currentUser = await overskill.auth.checkSession()
      setUser(currentUser)
      return currentUser
    } catch (error) {
      console.error('[useAuth] Failed to refresh user:', error)
      setUser(null)
      return null
    }
  }, [])

  return {
    user,
    loading,
    isAuthenticated: !!user,
    login,
    logout,
    refreshUser
  }
}
