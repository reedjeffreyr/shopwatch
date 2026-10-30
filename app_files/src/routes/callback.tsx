// OAuth Callback Page - Server-Side Token Exchange
// ⚠️ DO NOT MODIFY THIS FILE - Critical OAuth flow logic
//
// This page handles OAuth callback in TWO phases:
// 1. Receives ?code=xxx from OAuth provider → sends to Rails for token exchange
// 2. Receives #access_token=xxx from Rails → stores token and redirects to app
//
// CRITICAL: returnUrl MUST be /callback (not root /) so phase 2 runs here!
// If you change returnUrl to '/', the token handling useEffect won't execute.
// Redirects to Rails server for token exchange (avoids CORS issues)

import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { adoptCallbackToken } from '@/lib/callbackToken'

export default function CallbackPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const handleCallback = async () => {
      console.log('[OAuth Callback] Starting server-side exchange...')

      // Get authorization code from URL
      const code = searchParams.get('code')
      const errorParam = searchParams.get('error')

      if (errorParam) {
        console.error('[OAuth Callback] Authorization denied:', errorParam)
        setError('Authorization was denied')
        setTimeout(() => navigate('/'), 2000)
        return
      }

      if (!code) {
        // Don't error if a token arrived via the URL hash (phase 2 of OAuth)
        // OR if lib/auth.ts already extracted it at module-load time (which
        // strips the hash before React mounts). Without the sessionStorage
        // check below, the bounce flow falls through this block and schedules
        // navigate('/') → which fires AFTER the hash useEffect's
        // navigate('/dashboard'), bouncing the user back to the landing page
        // and making the app look logged out.
        // Apr 2026: Todd's QA caught this — see PR fix.
        if (
          window.location.hash.includes('access_token=') ||
          sessionStorage.getItem('overskill_token_extracted') === 'true' ||
          localStorage.getItem('overskill_token')
        ) {
          console.log('[OAuth Callback] No code but token already in flight — letting the hash useEffect redirect')
          return  // Let the hash useEffect handle it
        }

        console.error('[OAuth Callback] No authorization code in URL')
        setError('No authorization code received')
        setTimeout(() => navigate('/'), 2000)
        return
      }

      // Get app ID and platform URL from environment
      const appId = import.meta.env.VITE_APP_ID
      const platformUrl = import.meta.env.VITE_PLATFORM_URL || 'https://www.overskill.com'

      if (!appId) {
        console.error('[OAuth Callback] App ID not configured')
        setError('Configuration error')
        setTimeout(() => navigate('/'), 2000)
        return
      }

      console.log('[OAuth Callback] Code:', code.substring(0, 20) + '...')
      console.log('[OAuth Callback] App ID:', appId)
      console.log('[OAuth Callback] Platform URL:', platformUrl)

      // Redirect to Rails server for token exchange
      // Server-side avoids CORS and is more secure
      // IMPORTANT: Return to /callback (not root) so token handling logic runs here
      const returnUrl = `${window.location.origin}/callback`
      const exchangeUrl = `${platformUrl}/oauth/callback_exchange?code=${encodeURIComponent(code)}&app_id=${encodeURIComponent(appId)}&return_to=${encodeURIComponent(returnUrl)}`

      console.log('[OAuth Callback] Redirecting to server-side exchange...')

      // Redirect to Rails for server-side token exchange
      window.location.href = exchangeUrl
    }

    handleCallback()
  }, [navigate, searchParams])

  // Also check URL fragment for token (server redirects back with #access_token=...)
  useEffect(() => {
    // lib/auth.ts normally adopts the token at module import. If it did not
    // (storage was denied at that instant, or this route mounted some other
    // way) apply the SAME rule here: fragment only, /callback only, aud must
    // name this app, exp in the future (SW-102). Never a bare regex on the hash.
    adoptCallbackToken(import.meta.env.VITE_APP_ID)

    const tokenExtracted = sessionStorage.getItem('overskill_token_extracted')
    const tokenInStorage = localStorage.getItem('overskill_token')

    // Handle redirect regardless of who extracted the token
    if (tokenInStorage || tokenExtracted) {
      console.log('[OAuth Callback] Token available, handling post-login redirect')

      // Clear the extraction flag
      sessionStorage.removeItem('overskill_token_extracted')

      // Get redirect destination (priority order)
      const storedRedirect = sessionStorage.getItem('overskill_post_login_redirect')
      if (storedRedirect) {
        console.log('[OAuth Callback] Using stored redirect from login.tsx:', storedRedirect)
        sessionStorage.removeItem('overskill_post_login_redirect')
      }

      const envRedirect = import.meta.env.VITE_POST_LOGIN_ROUTE
      if (envRedirect) {
        console.log('[OAuth Callback] VITE_POST_LOGIN_ROUTE is set:', envRedirect)
      }

      // Priority: storedRedirect > VITE_POST_LOGIN_ROUTE > '/dashboard'
      // Default to /dashboard (not /) to avoid landing page loop for login_required apps
      const postLoginRoute = storedRedirect || envRedirect || '/dashboard'

      console.log('[OAuth Callback] Final post-login route:', postLoginRoute)

      // Small delay to ensure state updates
      setTimeout(() => {
        console.log('[OAuth Callback] Navigating to:', postLoginRoute)
        navigate(postLoginRoute)
      }, 100) // Reduced from 500ms to 100ms (faster UX)
    } else {
      console.log('[OAuth Callback] No token found, user may need to log in')
    }
  }, [navigate])

  return (
    <div className="min-h-screen flex items-center justify-center bg-primary">
      <div className="text-center">
        {error ? (
          <>
            {/* Red error text is intentional - universal error indicator */}
            <div className="text-red-100 text-lg mb-4">{error}</div>
            <p className="text-primary-foreground/80 text-sm">Redirecting...</p>
          </>
        ) : (
          <>
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-foreground mx-auto mb-4" />
            <p className="text-primary-foreground text-lg">Completing authorization...</p>
            <p className="text-primary-foreground/80 text-sm mt-2">Securely exchanging credentials...</p>
          </>
        )}
      </div>
    </div>
  )
}
