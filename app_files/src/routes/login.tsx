// Login Page - OAuth Redirect with Graceful Degradation
// Redirects to OverSkill OAuth authorization endpoint
// Shows friendly error if platform is unavailable
//
// CRITICAL: In iframe preview mode, waits for preview-auth-ready event
// before checking session to avoid race conditions with async token delivery.
// See: docs/ultrathink/preview-auth-loop-jan-2026/ROOT_CAUSE_ANALYSIS.md

import React from 'react';
import { overskill } from '@/lib/auth'
import { consumeSessionMessage } from '@/lib/sessionIntegrity'
import { signInWithNativeBrowser } from '@/lib/native'
import { useEffect, useState, useCallback } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'

type LoginState = 'waiting-preview-auth' | 'checking' | 'redirecting' | 'error' | 'config-error' | 'iframe-no-auth'

export default function LoginPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const [state, setState] = useState<LoginState>('waiting-preview-auth')
  const [errorMessage, setErrorMessage] = useState<string>('')
  // Calm "Your session expired — please sign in again." copy stashed by
  // forceSignOut (session integrity). Shown once, then cleared.
  const [sessionMessage, setSessionMessage] = useState<string | null>(null)

  // Auth-loop detector (Jun 2026): increments a counter each time we land on
  // /login in real (non-iframe) production WHILE a token is already stored but
  // the session check failed. Returns true once we've looped enough times to
  // be confident it's a genuine reject-loop (worker rejecting valid tokens),
  // not a one-off transient. Threshold of 2 means: first failure re-tries OAuth
  // once (covers a legitimately expired/stale token), second failure breaks.
  const detectAuthLoop = (): boolean => {
    try {
      const prev = parseInt(sessionStorage.getItem('overskill_auth_loop_count') || '0', 10) || 0
      const next = prev + 1
      sessionStorage.setItem('overskill_auth_loop_count', String(next))
      return next >= 2
    } catch {
      return false
    }
  }

  // Check session and redirect if already authenticated
  const checkSessionAndRedirect = useCallback(() => {
    const isInIframe = window.self !== window.top

    overskill.auth.checkSession().then(user => {
      if (user) {
        // Already logged in, redirect to stored URL or dashboard
        const storedRedirect = sessionStorage.getItem('overskill_post_login_redirect')
        sessionStorage.removeItem('overskill_post_login_redirect')

        // Clear the auth-loop guard on a successful session (Jun 2026 fix).
        sessionStorage.removeItem('overskill_auth_loop_count')

        // Post-login destination priority: storedRedirect > VITE_POST_LOGIN_ROUTE > '/dashboard'.
        //
        // This MUST match src/routes/callback.tsx, which already resolves in this
        // exact order. When login.tsx hardcoded '/dashboard' and ignored
        // VITE_POST_LOGIN_ROUTE, any app whose real home is NOT /dashboard got an
        // infinite redirect ping-pong for an already-authenticated user:
        //   /home -> (ProtectedRoute re-check) -> /login -> '/dashboard' -> /home -> ...
        // presenting as a flickering "Checking authentication..." spinner the user
        // can never escape. Never default to '/' — that caused a different loop for
        // login_required apps, which is why '/dashboard' remains the last resort.
        const envRedirect = import.meta.env.VITE_POST_LOGIN_ROUTE
        const redirectTo = storedRedirect || envRedirect || '/dashboard'

        console.log('[Login] Already authenticated, redirecting to:', redirectTo)
        navigate(redirectTo)
      } else if (!isInIframe && localStorage.getItem('overskill_token') && detectAuthLoop()) {
        // ───────────────────────────────────────────────────────────────
        // AUTH LOOP BREAKER (Jun 2026 — airlock OAuth redirect-loop fix)
        //
        // Loop signature: a token IS present in localStorage (the user just
        // completed OAuth and /callback stored it), but checkSession() ->
        // /api/auth/me still returns 401/null. Without this guard we bounce
        // straight back to OAuth, get another valid-looking token, store it,
        // and 401 again — an infinite ~1/sec spinner the user can never
        // escape and that hides the real cause.
        //
        // Root cause this guards against: the deployed Cloudflare Worker's
        // JWT_SECRET binding no longer matches the platform's current signing
        // secret (e.g. secret rotated / stale deploy), so the worker rejects
        // every freshly-issued token at signature verification. The right
        // operator fix is to REDEPLOY the app so the worker re-binds the
        // current JWT_SECRET — but the app itself can't do that, so the least
        // it can do is STOP looping and surface a clear, debuggable error
        // instead of spinning forever.
        // ───────────────────────────────────────────────────────────────
        console.error('[Login] Auth loop detected: token present but /api/auth/me keeps rejecting it. Breaking loop.')
        // Drop the rejected token so a future fixed deploy gets a clean retry.
        localStorage.removeItem('overskill_token')
        sessionStorage.removeItem('overskill_auth_loop_count')
        setState('error')
        setErrorMessage(
          'We could not verify your session after signing in. This usually means the app needs to be redeployed by its creator. Please try again in a few minutes or contact the app owner.'
        )
      } else if (isInIframe) {
        // Apr 2026 fix (bug #3): NEVER auto-OAuth from inside the editor preview iframe.
        // The OAuth redirect navigates the iframe to www.overskill.com and shows the
        // platform sign-in form, which looks like the app is broken.
        console.log('[Login] In iframe + not authenticated — showing preview-mode message')
        setState('iframe-no-auth')
      } else {
        // Not in iframe (real production): start OAuth flow with health check
        console.log('[Login] Not authenticated, starting OAuth flow')
        startOAuthFlowWithHealthCheck()
      }
    }).catch((error) => {
      console.error('[Login] Session check error:', error)
      if (isInIframe) {
        // See above — never OAuth from iframe.
        setState('iframe-no-auth')
      } else if (localStorage.getItem('overskill_token') && detectAuthLoop()) {
        // Same auth-loop breaker as the not-authenticated branch above:
        // token present but the session check keeps failing — stop bouncing.
        console.error('[Login] Auth loop detected (catch path): breaking loop.')
        localStorage.removeItem('overskill_token')
        sessionStorage.removeItem('overskill_auth_loop_count')
        setState('error')
        setErrorMessage(
          'We could not verify your session after signing in. This usually means the app needs to be redeployed by its creator. Please try again in a few minutes or contact the app owner.'
        )
      } else {
        startOAuthFlowWithHealthCheck()
      }
    })
  }, [navigate])

  useEffect(() => {
    // Surface the calm session-expired message if we arrived here via a forced
    // logout (session integrity). Consumed once so a later manual visit is clean.
    const msg = consumeSessionMessage()
    if (msg) setSessionMessage(msg)

    // Store redirect URL if provided (from overskill.auth.login(redirectUrl))
    const redirectUrl = searchParams.get('redirect')
    if (redirectUrl) {
      sessionStorage.setItem('overskill_post_login_redirect', redirectUrl)
      console.log('[Login] Stored post-login redirect:', redirectUrl)
    }

    // Post-purchase CLAIM flow (purchase -> login/signup -> access):
    // an anonymous checkout sends the buyer here with their checkout
    // email + claim=1. Forwarding the email as an OAuth login_hint lets
    // the platform prefill signup with the SAME email the purchase was
    // made under, so the entitlement reconciles to the new account by
    // email. claim=1 is just a marker for logging — the reconciliation
    // is automatic server-side on first app login. (GitHub #1604)
    const claimEmail = searchParams.get('email')
    if (claimEmail) {
      sessionStorage.setItem('overskill_claim_email', claimEmail)
      console.log('[Login] Stored post-purchase claim email for OAuth prefill')
    }

    const isInIframe = window.self !== window.top

    if (isInIframe) {
      // In iframe: Wait for preview-auth-ready event before checking session
      // This prevents race condition where we start OAuth before token arrives
      console.log('[Login] In iframe - waiting for preview auth...')

      const handlePreviewAuthReady = () => {
        console.log('[Login] Preview auth ready - now checking session')
        setState('checking')
        checkSessionAndRedirect()
      }

      window.addEventListener('preview-auth-ready', handlePreviewAuthReady)

      // Check if token already exists (preview auth may have completed before mount)
      if (localStorage.getItem('overskill_token')) {
        console.log('[Login] Token already exists - checking session')
        setState('checking')
        checkSessionAndRedirect()
      }

      // 5-second timeout fallback - don't wait forever.
      //
      // CRITICAL (Apr 2026): In iframe context, NEVER auto-redirect to OAuth.
      // Doing so navigates the iframe to www.overskill.com which shows the
      // platform sign-in form INSIDE the editor preview frame — looks like
      // the app is "broken" and asking the developer to sign in to Overskill
      // to test their own app. See bug #3 from Todd's QA pass.
      //
      // Instead, show a clear "preview mode — open in new tab to test
      // OAuth" message. Existing token + preview-auth-ready paths still
      // work; this only kicks in when neither happens within the timeout.
      //
      // Apr 2026 (Todd QA #1 follow-up): bumped 2000ms → 5000ms. On iOS
      // Hotwire Native (dev.overskill.com via ngrok), the parent's challenge
      // postMessage + token fetch round-trip can exceed 2s on cellular,
      // causing the spinner to flip to "Open in new tab" while the auth
      // handshake was actually completing in the background. 5s is still
      // well under any user-perceivable hang and gives slow mobile networks
      // headroom to deliver the token.
      const timeout = setTimeout(() => {
        console.log('[Login] Preview auth timeout in iframe — showing preview-mode message (no auto-OAuth)')
        setState('iframe-no-auth')
      }, 5000)

      return () => {
        window.removeEventListener('preview-auth-ready', handlePreviewAuthReady)
        clearTimeout(timeout)
      }
    } else {
      // Not in iframe: check session immediately (production mode)
      setState('checking')
      checkSessionAndRedirect()
    }
  }, [navigate, searchParams, checkSessionAndRedirect])

  const startOAuthFlowWithHealthCheck = async () => {
    // Get OAuth configuration from Vite environment
    const oauthClientId = import.meta.env.VITE_OAUTH_CLIENT_ID
    const platformUrl = import.meta.env.VITE_PLATFORM_URL || 'https://www.overskill.com'

    if (!oauthClientId) {
      console.error('[Login] OAuth not configured - missing VITE_OAUTH_CLIENT_ID')
      setState('config-error')
      setErrorMessage('This app is not configured for authentication. Please contact the app creator.')
      return
    }

    // Quick health check — but don't block login on CORS or network errors.
    // The bounce redirect itself will fail gracefully if the platform is actually down.
    let platformDown = false
    try {
      const healthCheck = await fetch(`${platformUrl}/api/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000)
      })

      if (!healthCheck.ok && healthCheck.status >= 500) {
        platformDown = true
      }
    } catch (error) {
      // CORS errors, network errors, timeouts — don't block login.
      console.warn('[Login] Health check failed (non-blocking):', error instanceof Error ? error.message : error)
    }

    if (platformDown) {
      console.warn('[Login] Platform returned 5xx — showing error')
      setState('error')
      setErrorMessage('The authentication service is temporarily unavailable. Please try again in a few minutes.')
      return
    }

    setState('redirecting')

    // Apr 2026 (Bug #4 from Todd's QA): use /oauth/bounce, NOT /oauth/authorize.
    //
    // Bounce is a same-domain hop on overskill.com that:
    //   - Reads the platform session cookie in a first-party context
    //     (where iOS Safari ITP delivers it reliably)
    //   - If signed in: mints a JWT and redirects back to <return_to>
    //     with #access_token=<jwt> in the URL fragment (the SDK already
    //     handles this format from the existing callback_exchange flow)
    //   - If not signed in: prompts sign-in, then completes the bounce
    //     after Devise returns
    //
    // This works for ALL deployment domains including custom domains
    // (where a shared parent-domain cookie strategy would NOT help).
    const returnTo = `${window.location.origin}/callback`
    let bounceUrl = `${platformUrl}/oauth/bounce?` +
      `client_id=${encodeURIComponent(oauthClientId)}&` +
      `return_to=${encodeURIComponent(returnTo)}`

    // Keep explicit logout distinct from an expired/missing session. Optional
    // method preserves compatibility until the updated SDK is published/pinned.
    if (searchParams.get('prompt') === 'login' || overskill.auth.getLoginPrompt?.() === 'login') {
      bounceUrl += '&prompt=login'
    }

    // Forward the post-purchase claim email as an OAuth login_hint so
    // signup prefills the buyer's checkout email (purchase -> login ->
    // access). Best-effort: harmless if the platform ignores it.
    const claimEmail = searchParams.get('email') || sessionStorage.getItem('overskill_claim_email')
    if (claimEmail) {
      bounceUrl += `&login_hint=${encodeURIComponent(claimEmail)}`
    }

    // Forward the explicit post-purchase CLAIM marker (postPurchaseRedirect
    // sends `/login?...&claim=1`). The platform gates the co-branded auth page's
    // "Your purchase is complete" banner on this marker — NOT on login_hint,
    // which is a generic email-prefill hint set by many non-purchase flows. This
    // is the clean signal; the platform also derives it from a purchase-only
    // login_hint at the bounce for back-compat.
    if (searchParams.get('claim') === '1') {
      bounceUrl += `&claim=1`
    }

    console.log('[Login] Redirecting via /oauth/bounce:', bounceUrl)

    // WRAPPED NATIVE APP (published to the App Store): hand the bounce to the
    // system browser instead of navigating this webview.
    //
    // Google and Apple refuse to complete sign-in inside an embedded webview. If
    // we navigate here, the provider page escapes to Safari, the user signs in
    // THERE, and the token lands in Safari — sign-in silently never completes in
    // the app. The native shell runs the whole bounce in the system browser and
    // returns via the app's custom URL scheme.
    //
    // The shell auto-intercepts ANCHOR clicks, but this is a programmatic
    // navigation, which cannot be intercepted — so the handoff has to happen
    // here. `bounceUrl` is passed UNMODIFIED: the bridge owns the return_to
    // rewrite, and pre-rewriting it would double-rewrite and break the round trip.
    //
    // On plain web (and in the editor preview iframe) this returns false and the
    // existing redirect below runs unchanged.
    if (signInWithNativeBrowser(bounceUrl)) {
      console.log('[Login] Native shell detected — signing in via the system browser')
      return
    }

    setTimeout(() => {
      window.location.href = bounceUrl
    }, 500)
  }

  const retry = () => {
    setState('checking')
    setErrorMessage('')
    startOAuthFlowWithHealthCheck()
  }

  // Apr 2026 — Editor preview iframe + not authenticated.
  // Show a clear message instead of OAuth-redirecting the iframe to overskill.com
  // (which previously made the editor look broken — bug #3).
  if (state === 'iframe-no-auth') {
    const openInNewTab = () => {
      window.open(window.location.origin, '_blank', 'noopener,noreferrer')
    }
    return (
      <div className="min-h-screen flex items-center justify-center bg-muted p-4">
        <div className="bg-card rounded-lg shadow-xl p-8 max-w-md text-center">
          <div className="text-5xl mb-4">🔒</div>
          <h1 className="text-xl font-semibold text-foreground mb-2">
            This page requires sign-in
          </h1>
          <p className="text-muted-foreground mb-2">
            You're viewing the editor preview, which can't complete the sign-in flow inside this iframe.
          </p>
          <p className="text-muted-foreground mb-6 text-sm">
            Open in a new tab to sign in and test authenticated views, or browse the app's public pages here.
          </p>
          <button
            onClick={openInNewTab}
            className="bg-primary text-primary-foreground px-6 py-2 rounded-lg hover:bg-primary/90 transition-colors w-full sm:w-auto"
          >
            Open in new tab
          </button>
          <p className="text-muted-foreground/60 text-xs mt-6">
            Editor preview mode · Powered by OverSkill
          </p>
        </div>
      </div>
    )
  }

  // Error state - platform unavailable
  if (state === 'error' || state === 'config-error') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-muted p-4">
        <div className="bg-card rounded-lg shadow-xl p-8 max-w-md text-center">
          <div className="text-5xl mb-4">
            {state === 'error' ? '🔧' : '⚠️'}
          </div>
          <h1 className="text-xl font-semibold text-foreground mb-2">
            {state === 'error' ? 'Service Temporarily Unavailable' : 'Configuration Error'}
          </h1>
          <p className="text-muted-foreground mb-6">
            {errorMessage}
          </p>
          {state === 'error' && (
            <button
              onClick={retry}
              className="bg-primary text-primary-foreground px-6 py-2 rounded-lg hover:bg-primary/90 transition-colors"
            >
              Try Again
            </button>
          )}
          <p className="text-muted-foreground/60 text-sm mt-6">
            Powered by OverSkill
          </p>
        </div>
      </div>
    )
  }

  // Loading state
  const getLoadingMessage = () => {
    switch (state) {
      case 'waiting-preview-auth':
        return 'Waiting for preview authentication...'
      case 'checking':
        return 'Checking authentication...'
      case 'redirecting':
        return 'Redirecting to OverSkill...'
      default:
        return 'Loading...'
    }
  }

  const showSubMessage = state === 'redirecting'

  return (
    <div className="min-h-screen flex items-center justify-center bg-primary">
      <div className="text-center">
        {sessionMessage && (
          <p className="text-primary-foreground/90 text-sm mb-4 max-w-xs mx-auto">{sessionMessage}</p>
        )}
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-foreground mx-auto mb-4" />
        <p className="text-primary-foreground text-lg">{getLoadingMessage()}</p>
        {showSubMessage && (
          <p className="text-primary-foreground/80 text-sm mt-2">You'll be asked to authorize this app</p>
        )}
      </div>
    </div>
  )
}
