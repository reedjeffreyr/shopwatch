/**
 * useWalletBalance — buyer credit wallet state for the current user
 * (buyer credit wallets, Jul 2026).
 *
 * PLATFORM-MANAGED. Reads the deployed worker's read-only wallet endpoint:
 *
 *   GET /api/wallet/balance
 *     → { enabled: false, wallet: null }   wallets not enabled for this app
 *     → { enabled: true,  wallet: null }   signed-in user has no wallet
 *     → { enabled: true,  wallet: { balance, included_credits,
 *         period_resets_at, top_up_url, plan_id, updated_at } }
 *
 * Consumers (the settings page "AI Credits" card) render NOTHING unless
 * `enabled && wallet` — the overwhelming majority of apps don't use buyer
 * credit wallets and must see zero wallet UI and zero network noise.
 *
 * SHARED STORE (fixes the "stale counter" bug, Jul 2026): every
 * `useWalletBalance()` call subscribes to ONE module-level store — a single
 * balance value + a single in-flight fetch shared across every component
 * (dashboard meter, chat composer, settings card). Before this, each hook
 * instance held its OWN state and only refetched on mount + tab-visibility,
 * so a dashboard whose hook already mounted PRE-purchase never saw the new
 * balance after an in-SPA return from checkout (Jason Sich QA: "counter
 * didn't upgrade on the main app, but it did on my profile page" — the
 * profile page's hook mounted fresh, the dashboard's didn't). With a shared
 * store, ONE refresh updates every consumer at once.
 *
 * Refresh triggers (no tight/infinite polling):
 *   1. First mount (initial read).
 *   2. Tab regains visibility — "topped up in the checkout tab and came back".
 *   3. `overskill:entitlement-changed` window event — the SAME signal
 *      <CheckoutDialog> already fires on completion (see CheckoutDialog.tsx)
 *      and useEntitlement() consumers already listen for. This covers the
 *      in-SPA "complete checkout → navigate back to dashboard" path that the
 *      stale counter bug came from.
 *   4. `pollWalletBalanceUntilChanged()` — a BOUNDED re-poll (every ~2s, up
 *      to ~20s, auto-stops on the first change) the /checkout/complete route
 *      fires to bridge the wallet-SEED lag: the wallet is seeded by the
 *      AppMembership activation webhook, which can trail the post-purchase
 *      redirect by a few seconds, so a single immediate refetch can still
 *      read the pre-seed (or old-plan) balance.
 *
 * Self-contained by design (direct SDK http call rather than an SDK hook)
 * for the same reason settings.tsx inlines `isManagedBackend()`: the SDK
 * version pinned in this template's lockfile may predate a dedicated
 * wallet surface. `overskill.http` has existed since 0.1.x, so this hook
 * works on every SDK version. Once the template's SDK pin includes
 * `overskill.wallet.*` this hook can delegate to it.
 *
 * LLM customization rules:
 *   - DO use this hook anywhere you want to show remaining AI credits
 *     (dashboards, chat composers, usage meters) — every instance stays in
 *     sync via the shared store, and a purchase refreshes them all.
 *   - After a custom checkout/return flow that grants credits, call
 *     `refreshWalletBalance()` (or `window.overskill?.wallet?.refresh?.()`)
 *     to force an immediate refetch, or `pollWalletBalanceUntilChanged()`
 *     if the grant may lag the redirect by a few seconds.
 *   - DO NOT fetch /api/wallet/balance with raw fetch() — this hook
 *     handles auth gating + graceful absence for you.
 *   - DO NOT invent other wallet endpoints (there is no /api/wallet/topup
 *     etc.) — top-ups happen via the `top_up_url` (a checkout/pricing
 *     page), never an API call.
 */

import { useEffect, useState } from 'react'
import { overskill, getAuthToken } from '@/lib/auth'

export interface WalletBalance {
  /** Remaining buyer credits (may be <= 0 after a burst before settlement). */
  balance: number
  /** Credits included with the buyer's plan each billing period (null when unknown). */
  included_credits: number | null
  /** ISO8601 timestamp of the next period reset (null for non-resetting wallets). */
  period_resets_at: string | null
  /** Where to send the buyer to top up / upgrade. Always present ('/pricing' fallback). */
  top_up_url: string
  plan_id: number | null
  updated_at: string | null
}

export interface WalletBalanceState {
  /** True when buyer credit wallets are enabled for this app AND the user has a wallet. */
  hasWallet: boolean
  /** True while the initial read is in flight (consumers should render nothing). */
  isLoading: boolean
  wallet: WalletBalance | null
  refresh: () => Promise<void>
}

interface StoreState {
  hasWallet: boolean
  wallet: WalletBalance | null
  isLoading: boolean
}

const INACTIVE: { hasWallet: false; wallet: null } = { hasWallet: false, wallet: null }

// ---------------------------------------------------------------------------
// Module-level shared store. ONE balance + ONE fetch shared across every
// useWalletBalance() consumer, so a single refresh updates them all — this is
// what makes a post-purchase refresh reach the dashboard meter that already
// mounted, not just the settings card that mounted fresh.
// ---------------------------------------------------------------------------
let storeState: StoreState = { ...INACTIVE, isLoading: true }
const subscribers = new Set<(s: StoreState) => void>()

// Coalesce concurrent refreshes: many hook instances mount at once (dashboard
// + composer + settings). Share the single in-flight promise so we make ONE
// network call, and every subscriber lands on the same result.
let inFlight: Promise<void> | null = null

function setStore(next: StoreState) {
  storeState = next
  for (const notify of subscribers) notify(storeState)
}

/**
 * Refresh the shared wallet balance. Coalesces concurrent callers onto a
 * single in-flight request. Never throws — any failure (disabled, no wallet,
 * 401 stale token, 404 older worker, network blip) resolves to graceful
 * absence (hasWallet: false), identical to the pre-store behavior.
 */
export function refreshWalletBalance(): Promise<void> {
  if (inFlight) return inFlight

  inFlight = (async () => {
    // Auth gate: never fire an unauthenticated read. Signed-out users have
    // no wallet by definition, and skipping the call avoids 401 noise (and
    // the SDK's stale-token handling) during the OAuth-callback window.
    if (!getAuthToken()) {
      setStore({ ...INACTIVE, isLoading: false })
      return
    }

    try {
      const data = await overskill.http.get<{ enabled?: boolean; wallet?: WalletBalance | null }>(
        '/api/wallet/balance'
      )
      if (data && data.enabled === true && data.wallet && typeof data.wallet.balance === 'number') {
        setStore({
          hasWallet: true,
          wallet: { ...data.wallet, top_up_url: data.wallet.top_up_url || '/pricing' },
          isLoading: false
        })
      } else {
        setStore({ ...INACTIVE, isLoading: false })
      }
    } catch {
      // Graceful absence: any failure (401 stale token, network blip, older
      // worker deploy without the endpoint → 404) renders as "no wallet".
      setStore({ ...INACTIVE, isLoading: false })
    } finally {
      inFlight = null
    }
  })()

  return inFlight
}

let pollActive = false

/**
 * BOUNDED re-poll for the post-purchase / checkout-return path. Refetches the
 * wallet every `intervalMs` (default 2s) up to `maxMs` (default 20s) and stops
 * on the FIRST observed change (balance, plan, or updated_at moved, or a
 * wallet appeared). This bridges the wallet-SEED lag — the wallet is seeded by
 * the AppMembership activation webhook, which can trail the redirect by a few
 * seconds, so a single immediate refetch may still read the pre-seed balance.
 *
 * Idempotent: a second call while a poll is running is a no-op (no stacked
 * timers). Never throws. Safe to call from any post-checkout code path.
 */
export function pollWalletBalanceUntilChanged(
  { intervalMs = 2000, maxMs = 20000 }: { intervalMs?: number; maxMs?: number } = {}
): void {
  if (pollActive) return
  pollActive = true

  const before = storeState.wallet
  const startedAt = Date.now()

  const changed = (w: WalletBalance | null): boolean => {
    if (!before) return !!w // wallet appeared where there was none
    if (!w) return false
    return (
      w.balance !== before.balance ||
      w.plan_id !== before.plan_id ||
      w.updated_at !== before.updated_at
    )
  }

  const tick = async () => {
    await refreshWalletBalance()
    if (changed(storeState.wallet) || Date.now() - startedAt >= maxMs) {
      pollActive = false
      return
    }
    window.setTimeout(() => void tick(), intervalMs)
  }

  void tick()
}

// Expose a stable global bridge so non-React code paths (a custom checkout
// return handler, the CheckoutDialog onComplete, an inline script) can force a
// refresh without importing the hook: `window.overskill?.wallet?.refresh?.()`.
// Best-effort + guarded — never assume the global exists or is writable, and
// preserve any pre-existing overskill.wallet surface a newer SDK may provide.
if (typeof window !== 'undefined') {
  try {
    const w = window as unknown as {
      overskill?: { wallet?: Record<string, unknown> }
    }
    w.overskill = w.overskill || {}
    w.overskill.wallet = {
      ...(w.overskill.wallet || {}),
      refresh: refreshWalletBalance,
      pollUntilChanged: pollWalletBalanceUntilChanged
    }
  } catch {
    // A frozen/guarded global is fine — the hook + exports still work.
  }
}

export function useWalletBalance(): WalletBalanceState {
  const [snapshot, setSnapshot] = useState<StoreState>(storeState)

  useEffect(() => {
    // Subscribe this instance to the shared store, then reconcile with the
    // latest state in case it changed between render and effect.
    subscribers.add(setSnapshot)
    setSnapshot(storeState)

    // Kick a read on the FIRST subscriber. Later subscribers reuse the shared
    // value (and the coalesced in-flight fetch) — no per-instance refetch.
    if (subscribers.size === 1) void refreshWalletBalance()

    // Refetch when the tab regains visibility — covers "buyer topped up in
    // the checkout tab and came back" (same mechanism useEntitlement uses).
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void refreshWalletBalance()
    }
    // Refetch on the SAME event <CheckoutDialog> fires on completion, so an
    // in-SPA purchase updates every wallet consumer at once (the stale
    // counter fix). useEntitlement() already listens for this event.
    const onEntitlementChanged = () => void refreshWalletBalance()

    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('overskill:entitlement-changed', onEntitlementChanged)
    return () => {
      subscribers.delete(setSnapshot)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('overskill:entitlement-changed', onEntitlementChanged)
    }
  }, [])

  return {
    hasWallet: snapshot.hasWallet,
    wallet: snapshot.wallet,
    isLoading: snapshot.isLoading,
    refresh: refreshWalletBalance
  }
}
