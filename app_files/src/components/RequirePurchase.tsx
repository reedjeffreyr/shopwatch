// RequirePurchase — the canonical ENTITLEMENT GATE for a paid app.
//
// Use this to gate routes on a purchase. It layers ON TOP of <ProtectedRoute>
// (auth) and reads the platform entitlement system (useEntitlement) — it does
// NOT touch auth/login files:
//
//   <ProtectedRoute>
//     <RequirePurchase>
//       <Dashboard />
//     </RequirePurchase>
//   </ProtectedRoute>
//
// States, in the order they are decided:
//   - entitlement still loading        → spinner
//   - JUST PAID, grant not landed yet  → "Confirming your purchase…"
//   - grant is genuinely slow          → "We have your payment" + retry
//   - SIGNED OUT / status unknown      → the login route
//   - resolved, owns nothing           → the paywall route
//   - entitled                         → the app
//
// WHY THIS FILE EXISTS AT ALL (ticket OS-HSK7CE, Aug 2026).
// Until now the template shipped NO purchase gate, so every creator selling on
// a `public`-visibility app got one written from scratch per app — and the
// hand-written ones modelled four states (loading, confirming, timed out,
// paywall) with no answer for "we do not know who you are". A token-less
// visitor fell through to the paywall in a single render tick.
//
// That is not theoretical. A buyer signed in through Safari, added the app to
// her iOS home screen, and was asked to buy the product again: an installed PWA
// gets its OWN localStorage partition, so the `overskill_token` Safari holds is
// invisible to the installed instance and a paying customer boots as a
// stranger. Her words: "It is literally the sales page all over again. The only
// option and button is to buy."
//
// THE RULE THIS GATE ENCODES, and the reason to reach for it instead of writing
// your own: an EMPTY entitlement list is not the same as an entitlement list
// that says "nothing". `useEntitlement()` returns
// `{ list: [], isLoading: false, resolved: false }` for a signed-out visitor
// and on any auth/network failure — nothing was learned, so nothing can be
// asserted. Only `resolved: true` with an empty list means the server actually
// said "you own nothing", and only that may render a paywall. (The SDK spells
// this out at entitlement-client.ts and names the bug class after ticket
// OS-6CH7XR, where the same mistake told paying customers their subscription
// had vanished.)

import React from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { AlertTriangle, CheckCircle2, LogIn, RefreshCw } from 'lucide-react'
import { useEntitlement } from 'overskill-sdk'
import { useAuth } from '@/lib/auth'
import {
  CONFIRM_POLL_INTERVAL_MS,
  CONFIRM_TIMEOUT_MS,
  clearPurchaseConfirming,
  isPurchaseConfirming,
  markPurchaseConfirming,
  pollUntil
} from '@/lib/purchase-confirmation'

interface RequirePurchaseProps {
  children: React.ReactNode

  // The plan the visitor must hold. Omit on a single-product app to accept ANY
  // active entitlement. Pass the plan id from an env var (the payment tools
  // write one per plan, e.g. VITE_PLAN_LIFETIME_ACCESS) — never a literal.
  planId?: string

  // Where a visitor who genuinely owns nothing is sent. This is your sales
  // page. It MUST offer a way to sign in as well as a way to buy: a buyer who
  // reaches it with no session otherwise has no exit.
  paywallPath?: string

  // Where a visitor we cannot identify is sent.
  loginPath?: string
}

export function RequirePurchase({
  children,
  planId,
  paywallPath = '/pricing',
  loginPath = '/login'
}: RequirePurchaseProps) {
  const ent = useEntitlement()
  const { user, loading: authLoading } = useAuth()
  const location = useLocation()
  const [timedOut, setTimedOut] = React.useState(false)

  // Entitled if they hold the named plan, or — when no plan is named — carry
  // any active entitlement at all.
  const entitled = planId ? ent.has(planId) : ent.list.length > 0

  // "We do not KNOW your status", as distinct from "you own nothing". This one
  // boolean is the whole point of the component; see the header note.
  //
  // `resolved` landed in overskill-sdk 0.5.7. On an older SDK the field is
  // `undefined`, and reading that as "unknown" would hide the paywall from
  // every signed-in visitor who genuinely has not bought — so fall back to the
  // signed-in check, which still keeps a token-less visitor off the paywall.
  // (Same shape as the entitlementResolved guard in routes/settings.tsx.)
  const entitlementUnknown =
    typeof (ent as { resolved?: boolean }).resolved === 'boolean'
      ? !(ent as { resolved?: boolean }).resolved
      : !user

  // Latest-value refs so the poll below sees fresh values without re-running
  // (and without putting the whole `ent` object in a dependency array, which
  // changes identity on every render).
  const entitledRef = React.useRef(entitled)
  entitledRef.current = entitled
  const refreshRef = React.useRef(ent.refresh)
  refreshRef.current = ent.refresh

  // Computed DURING RENDER, not from effect-set state. Deriving it from state
  // leaves one render tick where the deny branch still runs, and that branch
  // NAVIGATES — there is no such thing as a brief flash of a redirect.
  // `isLoading` is excluded on purpose: while the first read is in flight the
  // spinner below already covers it, and that branch is not the paywall.
  const holdForPurchaseConfirmation =
    !ent.isLoading && !entitled && !timedOut && isPurchaseConfirming()

  // Granted — drop the marker so a LATER genuine paywall (a second product, an
  // expired plan) shows its buy CTA immediately instead of a stale hold.
  React.useEffect(() => {
    if (entitled) clearPurchaseConfirming()
  }, [entitled])

  React.useEffect(() => {
    if (!holdForPurchaseConfirmation) return

    let cancelled = false

    void (async () => {
      const result = await pollUntil(
        async () => {
          if (cancelled || entitledRef.current) return true
          // The SDK's public forced refetch. The store notifies subscribers on
          // change, which re-renders this component and updates entitledRef, so
          // the next attempt (or the render itself) ends the hold.
          await refreshRef.current()
          return entitledRef.current
        },
        { intervalMs: CONFIRM_POLL_INTERVAL_MS, timeoutMs: CONFIRM_TIMEOUT_MS }
      )

      if (cancelled) return
      if (!result.ok) setTimedOut(true)
    })()

    return () => {
      cancelled = true
    }
  }, [holdForPurchaseConfirmation])

  if (ent.isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-center space-y-4">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto" />
          <p className="text-muted-foreground">Checking your access…</p>
        </div>
      </div>
    )
  }

  // The buyer just paid and the entitlement hasn't landed yet (ticket
  // OS-C7KWQF). NEVER the buy CTA, and never a bare spinner. Ordered BEFORE
  // every deny branch so the paywall is unreachable while a purchase settles.
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
  if (timedOut && !entitled) {
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
              // here past the window reloads straight into the paywall for what
              // they already paid for. Refreshing from a post-payment screen is
              // an explicit "I paid, let me in".
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

  // Signed out, or the entitlement read never answered — NEVER the paywall.
  //
  // Two exits, because the two situations recover differently:
  //   - nobody signed in → the login route, carrying where they were headed.
  //     This is the iOS home-screen case: a valid purchase, just no token in
  //     THIS storage partition, and a login screen is the whole fix.
  //   - signed in but the entitlement read FAILED → say so and offer a retry.
  //     Sending THEM to /login would ping-pong: /login finds a valid session
  //     and navigates straight back here, which loops.
  if (!entitled && entitlementUnknown) {
    // Auth still settling — hold rather than decide. `ent.isLoading` reflects
    // the SDK's own auth context, not this hook's; they settle independently,
    // and guessing "signed out" in that gap costs a needless trip to /login.
    if (authLoading) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-background">
          <div className="text-center space-y-4">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto" />
            <p className="text-muted-foreground">Checking your access…</p>
          </div>
        </div>
      )
    }

    if (!user) {
      // Same shape <ProtectedRoute> uses for its login redirects, so the return
      // path round-trips through the platform bounce exactly as it does there.
      const returnPath = location.pathname + location.search
      return (
        <Navigate
          to={`${loginPath}?redirect=${encodeURIComponent(returnPath)}`}
          replace
        />
      )
    }

    // Signed in, but we could not read the entitlement. Recoverable, in place.
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <div className="bg-card text-card-foreground rounded-xl border border-border shadow-sm p-8 max-w-md w-full text-center space-y-4">
          <AlertTriangle className="mx-auto h-12 w-12 text-primary" aria-hidden="true" />
          <h1 className="text-lg font-semibold text-foreground">
            We couldn&apos;t check your access
          </h1>
          <p className="text-muted-foreground text-sm">
            That is a problem on our side, not with your purchase — nothing has
            changed about what you own. Try again in a moment. If you bought
            this in a different browser or on another device, sign in with the
            same email and you&apos;ll be straight back in.
          </p>
          <button
            onClick={() => window.location.reload()}
            className="inline-flex justify-center items-center gap-2 rounded-md bg-primary text-primary-foreground px-5 py-2.5 text-sm font-semibold hover:bg-primary/90 transition-colors w-full sm:w-auto"
          >
            <RefreshCw className="w-4 h-4" aria-hidden="true" /> Try again
          </button>
          <p>
            <a
              href={loginPath}
              className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
            >
              <LogIn className="w-4 h-4" aria-hidden="true" /> Sign in with a
              different account
            </a>
          </p>
        </div>
      </div>
    )
  }

  // Resolved, signed in, owns nothing. This is the ONLY branch that may show a
  // paywall, and it is deliberately last.
  if (!entitled) {
    return <Navigate to={paywallPath} replace />
  }

  return <>{children}</>
}

export default RequirePurchase
