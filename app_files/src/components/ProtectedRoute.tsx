// Protected Route Component
// Wraps content that requires a SIGNED-IN USER *and* satisfies the app's
// visibility setting.
//
// ARCHITECTURE: This component is the ONLY place that handles auth redirects.
// lib/auth.ts resolveRouteAccess() returns { allowed, redirect } but NEVER
// navigates. This component uses React Router <Navigate> for all redirects,
// keeping everything within the SPA (no full page reloads, no redirect loops).
//
// ⚠️ IT USED TO ASK ONLY ABOUT VISIBILITY, AND THAT IS WHY IT PROTECTED
// NOTHING ON A `public` APP (issue #5505). checkAppAccess() answers "may this
// VISITOR see this APP?", and on the default `public` visibility that is yes
// for everybody — so an anonymous visitor to a member-only route rendered the
// interior, every page inside stopped at its own `if (!user) return`, and the
// visitor got a nav shell with zero data requests, no empty state and no
// redirect. Measured on generated apps 402 and 403 (2026-08-27). The gate now
// calls resolveRouteAccess(), which asks BOTH questions; see its docblock.
//
// CRITICAL: In iframe preview mode, waits for overskill:preview-auth-ready event
// before checking authentication to avoid race conditions with async token delivery.
// See: docs/ultrathink/preview-auth-loop-jan-2026/ROOT_CAUSE_ANALYSIS.md
// Preview auth is supplied by the editor iframe handshake on E2B hosts.

import React from 'react';
import { useEffect, useState } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { CheckCircle2 } from 'lucide-react'
import { getAuthToken, resolveRouteAccess, waitForAppAccess } from '@/lib/auth'
import type { AccessResult } from '@/lib/auth'
import {
  clearPurchaseConfirming,
  isPurchaseConfirming,
  markPurchaseConfirming
} from '@/lib/purchase-confirmation'

interface ProtectedRouteProps {
  children: React.ReactNode
}

// One claim attempt per signed-in identity. A buyer who paid while signed OUT
// lands here after login/signup (postPurchaseRedirect sends them to
// /login?...&claim=1, and the destination is auth-gated), which makes this the
// one place every app reaches with BOTH a signed-in buyer and the stashed
// receipt — the app's own destination route is arbitrary, so there is nowhere
// else to hook that works for every generated app.
//
// Keyed on the auth TOKEN rather than a bare boolean: signing out and back in
// as someone else mints a new token, and that second person must get their own
// attempt instead of inheriting the first person's "already tried" flag.
let claimAttemptedForToken: string | null = null

/**
 * Spend a stashed checkout receipt, at most once per signed-in identity.
 *
 * Extracted because TWO paths now need it: the access-GRANTED path below (the
 * original caller) and the post-purchase CONFIRMING path (ticket OS-C7KWQF).
 * The confirming path is the case that matters most — on a
 * `purchase_required` app the buyer is not allowed in *until* the entitlement
 * exists, so a claim that only ran once access was already granted could never
 * be what produced it. Sharing ONE module-level guard is what keeps the two
 * callers from each firing their own claim for the same receipt.
 *
 * Deliberately fire-and-forget and fail-soft: nothing here gates rendering,
 * every failure leaves the page exactly as it would have been, and the claim
 * is allowed to FINISH after the component unmounts (same contract as
 * checkout-complete.tsx's `void claimPurchase()` — abandoning a money-path
 * grant halfway because the buyer navigated is strictly worse).
 *
 * The payments helper is imported LAZILY, inside try/catch. This component is
 * the auth gate in every generated app, while `src/lib/whop.ts` is app code
 * the builder AI freely rewrites.
 *
 * WHAT THIS DOES AND DOESN'T BUY: it does NOT make a broken whop.ts build — a
 * bundler still type-checks and bundles any module that is imported anywhere,
 * so a syntax or type error there fails the build regardless. What it does buy
 * is RUNTIME containment: if the module is absent, fails to evaluate, or no
 * longer exports these helpers, the rejected import is caught here and the
 * auth gate keeps rendering instead of throwing during its own module
 * evaluation. Optional-call syntax covers the "module loaded but helper
 * renamed" case.
 */
async function attemptPurchaseClaim(): Promise<void> {
  let token: string | null = null
  try {
    token = localStorage.getItem('overskill_token')
  } catch {
    // Storage unavailable — treat as a single anonymous identity.
  }
  const identity = token || 'anonymous'
  if (claimAttemptedForToken === identity) return

  try {
    const whop = await import('@/lib/whop')
    // Cheap guard first: no stashed receipt (the common case) means there is
    // nothing to claim and we cost one sessionStorage read.
    if (!whop.readCapturedCheckoutReceipt?.()) return

    // Arm the guard BEFORE awaiting so a concurrent mount can't fire a second
    // claim for the same identity...
    claimAttemptedForToken = identity
    const result = await whop.claimPurchase?.()

    // ...but re-arm on a RECOVERABLE outcome. A payment the provider cannot
    // read yet, or a plan the creator registers an hour later, would otherwise
    // never be retried inside this SPA session — the bounded retry policy only
    // ever got a second chance on a full page reload. The per-receipt attempt
    // budget still caps the total, and claimPurchase() drops the stash once it
    // is exhausted, so this cannot spin.
    if (whop.isClaimRetryable?.(result?.reason)) {
      claimAttemptedForToken = null
    }
  } catch (e) {
    // The helper is missing or broken — leave the guard armed so we don't
    // retry a module that isn't there.
    console.warn('[ProtectedRoute] purchase claim unavailable:', e)
  }
}

export function ProtectedRoute({ children }: ProtectedRouteProps) {
  const [isChecking, setIsChecking] = useState(true)
  const [accessResult, setAccessResult] = useState<AccessResult | null>(null)
  const [previewAuthReady, setPreviewAuthReady] = useState(false)
  // Post-purchase confirmation (ticket OS-C7KWQF). 'timed_out' is terminal for
  // this mount: the reassurance panel replaces both the spinner AND the
  // paywall redirect, so a buyer whose grant is genuinely slow is told we have
  // their payment instead of being asked to buy again.
  const [confirmState, setConfirmState] = useState<'idle' | 'timed_out'>('idle')
  const location = useLocation()

  // In iframe: Wait for preview-auth-ready event before checking access
  // This prevents race condition where we check auth before token arrives via postMessage
  useEffect(() => {
    const isInIframe = window.self !== window.top

    if (isInIframe) {
      console.log('[ProtectedRoute] In iframe - waiting for preview auth...')

      const handlePreviewAuthReady = () => {
        console.log('[ProtectedRoute] Preview auth ready event received')
        setPreviewAuthReady(true)
      }

      // Listen for both event names for compatibility
      // SDK dispatches 'overskill:preview-auth-ready', older code may dispatch 'preview-auth-ready'
      window.addEventListener('overskill:preview-auth-ready', handlePreviewAuthReady)
      window.addEventListener('preview-auth-ready', handlePreviewAuthReady)

      // Check if the token already arrived (preview auth may have completed
      // before mount).
      //
      // Asked through getAuthToken() — NOT localStorage — for exactly the
      // reason #6223 established on authVerificationBypassed(): in a
      // third-party iframe Chrome's 3P-cookie blocking makes the localStorage
      // PROPERTY ITSELF throw SecurityError, not just deny persistence. A bare
      // read here threw inside this effect, React tore the tree down (there is
      // no error boundary above the gate), and the app WHITE-SCREENED on
      // preview boot instead of merely starting out without a token. The
      // editor token lives in SDK memory, which is also the only place it can
      // live when persistence is denied, so this read is both fail-soft and
      // strictly more correct than the storage one it replaces.
      if (getAuthToken()) {
        console.log('[ProtectedRoute] Preview auth token already available')
        setPreviewAuthReady(true)
      }

      // 2-second timeout fallback - don't wait forever
      const timeout = setTimeout(() => {
        console.log('[ProtectedRoute] Preview auth timeout - proceeding with check')
        setPreviewAuthReady(true)
      }, 2000)

      return () => {
        window.removeEventListener('overskill:preview-auth-ready', handlePreviewAuthReady)
        window.removeEventListener('preview-auth-ready', handlePreviewAuthReady)
        clearTimeout(timeout)
      }
    } else {
      // Not in iframe: proceed immediately (production mode)
      setPreviewAuthReady(true)
    }
  }, [])

  // Check access only after preview auth is ready
  useEffect(() => {
    if (!previewAuthReady) return

    console.log('[ProtectedRoute] Checking route access (visibility + signed-in user)...')
    resolveRouteAccess().then(result => {
      console.log('[ProtectedRoute] Access check result:', result)
      setAccessResult(result)
      setIsChecking(false)
    }).catch((error) => {
      console.error('[ProtectedRoute] Access check error:', error)
      setAccessResult({ allowed: false, redirect: '/login', reason: 'unexpected_error' })
      setIsChecking(false)
    })
  }, [previewAuthReady])

  // Access granted and a checkout receipt is still stashed → the buyer paid
  // before they had an account. Spend the receipt now: the platform verifies
  // it against this app's own merchant and grants the entitlement, so
  // useEntitlement() unlocks the paid feature on its next poll.
  useEffect(() => {
    if (isChecking) return
    if (!accessResult || !accessResult.allowed) return

    void attemptPurchaseClaim()
  }, [isChecking, accessResult])

  // ─── Post-purchase confirmation hold (ticket OS-C7KWQF) ───────────────────
  //
  // Computed DURING RENDER, not in an effect, and that is the whole point.
  // Deriving this from state would leave one render tick where the deny branch
  // below still ran — and that branch NAVIGATES to /purchase, so a single tick
  // is enough to put a paying buyer back on the paywall. There is no such thing
  // as a brief flash of a redirect.
  //
  // `no_subscription` is the ONLY reason held: it is the "you haven't paid"
  // answer, and it is the one that is wrong for ~1-2s after a real payment.
  // A `not_authenticated` deny still redirects to /login instantly (the buyer
  // genuinely does need to sign in first), and a never-purchased visitor has no
  // marker, so their paywall is untouched.
  const holdForPurchaseConfirmation =
    !!accessResult &&
    !accessResult.allowed &&
    accessResult.reason === 'no_subscription' &&
    confirmState !== 'timed_out' &&
    isPurchaseConfirming()

  useEffect(() => {
    if (!holdForPurchaseConfirmation) return

    let cancelled = false

    // Spend the receipt HERE too. On a purchase_required app this is the claim
    // that can actually produce the entitlement we are waiting for — the
    // access-granted effect above cannot, because access is what's missing.
    void attemptPurchaseClaim()

    void (async () => {
      const result = await waitForAppAccess()
      if (cancelled) return

      if (result.allowed) {
        // Granted — drop the marker so a LATER genuine paywall (second
        // product, expired plan) shows its buy CTA immediately.
        clearPurchaseConfirming()
        setAccessResult(result)
      } else {
        setConfirmState('timed_out')
      }
    })()

    return () => {
      cancelled = true
    }
  }, [holdForPurchaseConfirmation])

  // Show loading state while checking access
  if (isChecking) {
    const isInIframe = typeof window !== 'undefined' && window.self !== window.top
    const message = isInIframe && !previewAuthReady
      ? 'Waiting for preview authentication...'
      : 'Checking access...'

    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center space-y-4">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto" />
          <p className="text-muted-foreground">{message}</p>
        </div>
      </div>
    )
  }

  // The buyer just paid and the entitlement hasn't landed yet — show that we
  // are confirming it. NEVER the buy CTA, and never a bare spinner: "it looks
  // like you have to buy the product again" is the exact complaint this
  // replaces. Ordered BEFORE the deny/redirect branch so /purchase is
  // unreachable while a purchase is settling.
  if (holdForPurchaseConfirmation) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <div className="text-center space-y-4 max-w-md">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto" />
          <h1 className="text-lg font-semibold text-foreground">
            Confirming your purchase…
          </h1>
          <p className="text-muted-foreground text-sm">
            Payment received. We&apos;re unlocking your access now — this usually
            takes just a few seconds.
          </p>
        </div>
      </div>
    )
  }

  // The grant is genuinely slow (or something is wrong upstream). Reassure and
  // hand the buyer a retry — still NOT the paywall. A buyer who has paid must
  // never be asked to pay again, no matter how long the grant takes.
  if (confirmState === 'timed_out') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <div className="bg-card text-card-foreground rounded-xl border border-border shadow-sm p-8 max-w-md w-full text-center space-y-4">
          <CheckCircle2 className="mx-auto h-12 w-12 text-primary" aria-hidden="true" />
          <h1 className="text-lg font-semibold text-foreground">
            We have your payment
          </h1>
          <p className="text-muted-foreground text-sm">
            Your access is taking longer than usual to unlock. Check your email
            for the confirmation and receipt — or refresh this page in a moment.
            You have not been charged twice, and there is nothing else to buy.
          </p>
          <button
            onClick={() => {
              // Renew the window before reloading. Otherwise a buyer who sat
              // here past the window reloads straight into /purchase — the
              // paywall for what they already paid for. Refreshing from a
              // post-payment screen is an explicit "I paid, let me in" action.
              markPurchaseConfirming()
              window.location.reload()
            }}
            className="inline-flex justify-center items-center rounded-md bg-primary text-primary-foreground px-5 py-2.5 text-sm font-semibold hover:bg-primary/90 transition-colors w-full sm:w-auto"
          >
            Refresh
          </button>
        </div>
      </div>
    )
  }

  // Access denied — redirect via React Router (SPA navigation, no page reload)
  if (accessResult && !accessResult.allowed && accessResult.redirect) {
    const redirectTarget = accessResult.redirect

    // For login redirects, preserve the current path so user returns here after login
    if (redirectTarget === '/login') {
      const returnPath = location.pathname + location.search
      console.log(`[ProtectedRoute] Redirecting to /login with return path: ${returnPath}`)
      return <Navigate to={`/login?redirect=${encodeURIComponent(returnPath)}`} replace />
    }

    // For other redirects (/purchase, /access-denied), redirect directly
    console.log(`[ProtectedRoute] Redirecting to ${redirectTarget} (reason: ${accessResult.reason})`)
    return <Navigate to={redirectTarget} replace />
  }

  // Access denied but no redirect specified (shouldn't happen, but be safe)
  if (accessResult && !accessResult.allowed) {
    return <Navigate to="/login" replace />
  }

  // Render protected content
  return <>{children}</>
}
