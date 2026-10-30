// Session integrity — the platform's shared "boot identity gate + forced-logout
// hygiene" for every generated app (Russell's session-integrity report).
//
// WHY A SELF-CONTAINED TEMPLATE MODULE (not just the SDK)
// ------------------------------------------------------
// The app-user JWT (`overskill_token`, ~24h life, NO refresh token) silently
// expires and NOTHING client-side read its `exp`: the SDK's isAuthenticated()
// is just `!!localStorage.overskill_token` and the http-client re-hydrates the
// token every request with no exp check. So an expired token was treated as a
// live session at boot — the app painted an identity decoded from the unverified
// JWT, keyed user-scoped caches off a uid that could disagree with the server
// (sub=users.id vs app_context.app_user_id, OS-7E39Q8) or belong to a still-
// valid SIBLING-ORIGIN token for a different account (residual #2169), and list
// views rendered the new-user empty state on a failed fetch — so a dead session
// looked like "a stranger's empty account / my data was deleted". The SERVER is
// correct (Rails verify_exp + the Worker's validateJWT both 401 an expired
// token; neither substitutes another identity) — the fix is entirely here.
//
// This module is BUNDLED into each app at build, so it ships to newly generated
// apps AND reaches existing apps on their next rebuild/redeploy with NO npm
// publish and NO CDN flip. It is kept in lockstep with the SDK reference copy
// `packages/overskill-sdk/src/session-integrity.ts` (parity pinned by
// spec/javascript/session_integrity_parity.test.js); change both together.
//
// INVARIANTS (do not weaken):
//   - Local claims read for UI GATING ONLY. The server stays the authority on
//     every request; a viable-looking token here grants nothing.
//   - NEVER indexedDB.deleteDatabase / never wipe IndexedDB (unsynced edits).
//     Never touch service workers / workbox caches.
//   - NO client-side pruning: a local row absent from a server response is
//     never deleted. forceSignOut clears only auth + `overskill:`-namespaced
//     POINTER keys, never app data rows.
//   - Public / no-login routes bypass entirely — nothing here acts unless a
//     token is (or was) present.

export const SESSION_TOKEN_KEY = 'overskill_token'
export const CLOCK_SKEW_MS = 60_000
export const SESSION_EXPIRED_MESSAGE = 'Your session expired — please sign in again.'
export const SESSION_MESSAGE_KEY = 'overskill_session_message'

const AUTH_SESSION_KEYS = [
  'overskill_token_extracted',
  'overskill_auth_loop_count',
  'overskill_post_login_redirect',
  'overskill_claim_email',
]

// The marker is PER APP: `overskill_logout_<obfuscatedId>`. Its domain is
// `.overskill.app` (to reach the app's sibling subdomain), which every app
// shares, so the old unscoped `overskill_logout` signed the user out of EVERY
// app. Mirrors overskill-sdk auth-session `logoutCookieName`.
const LOGOUT_COOKIE_NAME = 'overskill_logout'
const LOGOUT_COOKIE_MAX_AGE_SECONDS = 24 * 60 * 60

function ns(appId: string): string {
  return `overskill:${appId}:`
}

// ─── JWT claims read (base64url; NO signature verification) ──────────────────

// Inline ~10-line base64url decoder — NO new JWT dependency. Mirrors the SDK.
function decodeBase64Url(segment: string): string {
  let b64 = segment.replace(/-/g, '+').replace(/_/g, '/')
  while (b64.length % 4 !== 0) b64 += '='
  return atob(b64)
}

export function decodeJwtPayload(token: string | null | undefined): Record<string, any> | null {
  if (!token || typeof token !== 'string') return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    const payload = JSON.parse(decodeBase64Url(parts[1]))
    return payload && typeof payload === 'object' ? payload : null
  } catch {
    return null
  }
}

function tokenExpiryMs(token: string | null | undefined): number | null {
  const payload = decodeJwtPayload(token)
  const exp = payload?.exp
  return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : null
}

/**
 * LAYER 1 — is this stored token viable for UI gating? False when missing,
 * malformed (≠3 segments / undecodable payload / no numeric exp), or expired
 * within a 60s skew. Never verifies the signature.
 */
export function isSessionTokenViable(token: string | null | undefined, nowMs: number = Date.now()): boolean {
  if (!token || typeof token !== 'string') return false
  if (token.split('.').length !== 3) return false
  const expiryMs = tokenExpiryMs(token)
  if (expiryMs == null) return false
  return expiryMs > nowMs + CLOCK_SKEW_MS
}

/** Worker-matching precedence: app_context.app_user_id → app_user_id → sub. */
export function resolveTokenUid(payload: Record<string, any> | null | undefined): string | null {
  const id = payload?.app_context?.app_user_id ?? payload?.app_user_id ?? payload?.sub
  return id == null ? null : String(id)
}

// ─── Storage helpers (fail-soft; Safari private mode can throw) ──────────────

function local(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null
  } catch {
    return null
  }
}
function session(): Storage | null {
  try {
    return typeof sessionStorage !== 'undefined' ? sessionStorage : null
  } catch {
    return null
  }
}

// ─── LAYER 2 — identity-match assertion (cache-owner pointer) ────────────────

export function cacheOwnerKey(appId: string): string {
  return `${ns(appId)}cacheOwnerUid`
}

export function readCacheOwnerUid(appId: string): string | null {
  try {
    return local()?.getItem(cacheOwnerKey(appId)) ?? null
  } catch {
    return null
  }
}

export function writeCacheOwnerUid(appId: string, uid: string): void {
  try {
    local()?.setItem(cacheOwnerKey(appId), uid)
  } catch {
    /* ignore */
  }
}

/** Remove ONLY the platform pointer keys for a stale uid — never data rows, never IndexedDB. */
export function clearStaleUserScopedPointers(appId: string, staleUid: string | null | undefined): void {
  const ls = local()
  if (!ls) return
  try {
    ls.removeItem(cacheOwnerKey(appId))
    if (!staleUid) return
    const prefix = `${ns(appId)}${staleUid}:`
    const doomed: string[] = []
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i)
      if (k && k.startsWith(prefix)) doomed.push(k)
    }
    for (const k of doomed) ls.removeItem(k)
  } catch {
    /* ignore */
  }
}

export type CacheOwnerOutcome = 'first-seen' | 'match' | 'mismatch'

/**
 * Compare the authenticated uid against the persisted cache owner. On mismatch,
 * clear the stale pointer keys for the OLD uid only and return 'mismatch' so the
 * caller treats it as a forced logout — never rendering cached data or an empty
 * dashboard for the wrong identity.
 */
export function reconcileCacheOwner(appId: string, uid: string | null | undefined): CacheOwnerOutcome {
  const stored = readCacheOwnerUid(appId)
  if (!uid) {
    if (stored) {
      clearStaleUserScopedPointers(appId, stored)
      return 'mismatch'
    }
    return 'first-seen'
  }
  if (stored == null) {
    writeCacheOwnerUid(appId, uid)
    return 'first-seen'
  }
  if (stored === uid) return 'match'
  clearStaleUserScopedPointers(appId, stored)
  return 'mismatch'
}

// ─── LAYER 4 — three-state empty guard ───────────────────────────────────────

export function hasEverSeenDataKey(appId: string): string {
  return `${ns(appId)}hasEverSeenData`
}
export function markHasEverSeenData(appId: string): void {
  try {
    local()?.setItem(hasEverSeenDataKey(appId), '1')
  } catch {
    /* ignore */
  }
}
export function hasEverSeenData(appId: string): boolean {
  try {
    return local()?.getItem(hasEverSeenDataKey(appId)) === '1'
  } catch {
    return false
  }
}

export type ListLoadStatus = 'loading' | 'success' | 'error'
export type ListDisplayState = 'loading' | 'data' | 'empty' | 'failed'

/**
 * Distinguish loaded-empty (200 + empty list) vs loading vs failed so a list
 * view NEVER renders the new-user empty state from a failure:
 *   loading → 'loading' · error → 'failed' · success+items → 'data' ·
 *   success+0 items → 'empty'.
 */
export function classifyListDisplayState(status: ListLoadStatus, itemCount: number): ListDisplayState {
  if (status === 'loading') return 'loading'
  if (status === 'error') return 'failed'
  return itemCount > 0 ? 'data' : 'empty'
}

// ─── LAYER 5 — forceSignOut (the ONLY path that clears auth) ─────────────────

let forceSignOutInFlight = false

export interface ForceSignOutOptions {
  appId?: string
  message?: string
  redirectTo?: string
  /** Skip navigation (caller drives its own router). */
  skipRedirect?: boolean
}

/**
 * Clear auth and route to login with a calm message. The ONLY code path that
 * clears auth. Removes the token + login breadcrumbs from local/session storage
 * and the user-scoped POINTER keys (never data rows, never IndexedDB, never SW
 * caches), drops this app's cross-origin `.overskill.app` logout marker so
 * sibling origins invalidate their own copy (#2169), stashes the message, then
 * redirects. Idempotent per load.
 */
export function forceSignOut(reason: string, opts: ForceSignOutOptions = {}): void {
  if (forceSignOutInFlight) return
  forceSignOutInFlight = true

  const ls = local()
  const ss = session()
  // The marker is named for the signed-out token's app; read it before removal.
  let signedOutToken: string | null = null
  try {
    signedOutToken = ls?.getItem(SESSION_TOKEN_KEY) ?? null
  } catch {
    /* ignore */
  }
  try {
    ls?.removeItem(SESSION_TOKEN_KEY)
  } catch {
    /* ignore */
  }
  for (const k of AUTH_SESSION_KEYS) {
    try {
      ss?.removeItem(k)
    } catch {
      /* ignore */
    }
  }
  if (opts.appId) clearStaleUserScopedPointers(opts.appId, readCacheOwnerUid(opts.appId))

  writeLogoutMarker(logoutMarkerAppId(signedOutToken, opts.appId))

  try {
    ss?.setItem(SESSION_MESSAGE_KEY, opts.message ?? SESSION_EXPIRED_MESSAGE)
  } catch {
    /* ignore */
  }
  try {
    console.warn(`[OverSkill session] Signing out: ${reason}`)
  } catch {
    /* ignore */
  }

  if (opts.skipRedirect) return
  try {
    if (typeof window !== 'undefined' && window.location) {
      window.location.assign(opts.redirectTo ?? '/login')
    }
  } catch {
    /* ignore */
  }
}

/**
 * Which app's logout marker to write: the signed-out token's own app (`aud` =
 * `overskill-app-<id>`), else the configured appId. Null when neither names a
 * plain id. Mirrors overskill-sdk auth-session `logoutMarkerAppId`.
 */
export function logoutMarkerAppId(token: string | null | undefined, configuredAppId?: string | null): string | null {
  const isId = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id)
  const aud = decodeJwtPayload(token)?.aud
  for (const a of Array.isArray(aud) ? aud : [aud]) {
    if (typeof a !== 'string' || !a.startsWith('overskill-app-')) continue
    const id = a.slice('overskill-app-'.length)
    if (isId(id)) return id
  }
  return isId(configuredAppId) ? configuredAppId : null
}

/**
 * Cross-origin logout marker — mirrors overskill-sdk auth-session
 * buildLogoutCookie. Writes nothing without an app id: an unscoped marker
 * would sign the user out of every app on overskill.app.
 */
function writeLogoutMarker(appId: string | null): void {
  if (typeof document === 'undefined') return
  if (!appId) return
  try {
    const hostname = (typeof window !== 'undefined' && window.location?.hostname) || ''
    const isSecure = typeof window === 'undefined' || window.location?.protocol === 'https:'
    const host = hostname.toLowerCase()
    const domain = host === 'overskill.app' || host.endsWith('.overskill.app') ? '.overskill.app' : null
    const attrs = [
      `${LOGOUT_COOKIE_NAME}_${appId}=${Date.now()}`,
      'path=/',
      `max-age=${LOGOUT_COOKIE_MAX_AGE_SECONDS}`,
      'SameSite=Lax',
    ]
    if (domain) attrs.push(`domain=${domain}`)
    if (isSecure) attrs.push('Secure')
    document.cookie = attrs.join('; ')
  } catch {
    /* ignore */
  }
}

/** Read + clear the calm message stashed by forceSignOut (login screen uses this). */
export function consumeSessionMessage(): string | null {
  const ss = session()
  try {
    const msg = ss?.getItem(SESSION_MESSAGE_KEY) ?? null
    if (msg) ss?.removeItem(SESSION_MESSAGE_KEY)
    return msg
  } catch {
    return null
  }
}

// ─── LAYER 1 (pre-boot) — sanitize a dead token out of storage ───────────────

/**
 * Synchronous pre-boot cleanup: if a stored token exists but is NOT viable
 * (expired within skew, or malformed), remove it so no downstream code paints
 * authenticated UI or sends a dead token. Safe on EVERY route (a public visitor
 * with no token is a no-op). Does NOT redirect — that would break public routes;
 * the authenticated-route gate + interceptor handle navigation. Returns true
 * when a dead token was removed.
 */
export function sanitizeStoredToken(nowMs: number = Date.now()): boolean {
  const ls = local()
  if (!ls) return false
  let token: string | null = null
  try {
    token = ls.getItem(SESSION_TOKEN_KEY)
  } catch {
    return false
  }
  if (!token) return false
  if (isSessionTokenViable(token, nowMs)) return false
  try {
    ls.removeItem(SESSION_TOKEN_KEY)
  } catch {
    /* ignore */
  }
  return true
}

// ─── LAYER 3 — 401 reaction + resume revalidation ────────────────────────────

let silentReauthAttempted = false

export interface InstallSessionIntegrityOptions {
  appId?: string
  /** One silent re-auth attempt (e.g. overskill.auth.refresh); returns a viable session. */
  silentReauth?: () => Promise<boolean>
  /** One lightweight authenticated request on resume; returns true when still valid. */
  revalidate?: () => Promise<boolean>
}

/**
 * Wire the session-integrity reactions onto the running app:
 *  a) `overskill:auth-cleared` (dispatched by the SDK http-client after a 401 —
 *     the single response interceptor): one silent re-auth, else forceSignOut.
 *     Never loops.
 *  b) `visibilitychange` → visible (the real scenario: a phone tab backgrounded
 *     for days): re-run the exp check, then one lightweight authed request; on
 *     either failure, forceSignOut. Only acts when a token is present, so
 *     public/no-login visitors are untouched.
 * Returns an uninstall function; no-ops off the browser.
 */
export function installSessionIntegrity(opts: InstallSessionIntegrityOptions = {}): () => void {
  if (typeof window === 'undefined') return () => {}

  const onAuthCleared = () => {
    void (async () => {
      if (!silentReauthAttempted && opts.silentReauth) {
        silentReauthAttempted = true
        try {
          if (await opts.silentReauth()) return // recovered — do not sign out
        } catch {
          /* fall through */
        }
      }
      forceSignOut('auth_cleared_401', { appId: opts.appId })
    })()
  }

  let revalidating = false
  const onVisible = () => {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
    if (revalidating) return
    let token: string | null = null
    try {
      token = local()?.getItem(SESSION_TOKEN_KEY) ?? null
    } catch {
      token = null
    }
    if (!token) return // signed-out / public visitor — nothing to revalidate
    if (!isSessionTokenViable(token)) {
      forceSignOut('resume_token_expired', { appId: opts.appId })
      return
    }
    if (!opts.revalidate) return
    revalidating = true
    void Promise.resolve()
      .then(() => opts.revalidate!())
      .then((ok) => {
        if (!ok) forceSignOut('resume_revalidation_failed', { appId: opts.appId })
      })
      .catch(() => {
        // A network hiccup is not proof the session died — let the next
        // authenticated request (which 401s cleanly) decide.
      })
      .finally(() => {
        revalidating = false
      })
  }

  window.addEventListener('overskill:auth-cleared', onAuthCleared)
  document.addEventListener('visibilitychange', onVisible)
  return () => {
    window.removeEventListener('overskill:auth-cleared', onAuthCleared)
    document.removeEventListener('visibilitychange', onVisible)
  }
}
