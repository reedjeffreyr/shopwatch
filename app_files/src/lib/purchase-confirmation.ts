// PLATFORM-MANAGED: the post-purchase CONFIRMATION WINDOW.
//
// WHY THIS EXISTS (ticket OS-C7KWQF, app 14090 "The Power of 5", Aug 2026 —
// buyers believed they were being charged twice):
//
// Entitlement is granted SERVER-SIDE in 1-2s (prod-verified: 17/17
// payment.succeeded webhooks completed within 1-2s, 17/17 memberships active).
// But the buyer's browser came back from checkout and asked "am I entitled?"
// exactly ONCE — and that single question is routinely asked a few hundred
// milliseconds too early. A "no" that early was then rendered as the PAYWALL:
//   - `purchase_required` apps: ProtectedRoute bounced the buyer to /purchase
//   - `useEntitlement()` gates: the paid feature re-rendered its buy CTA
// so the buyer sat looking at a purchase screen for the paid thing they had
// just paid for, and the next entitlement refresh was up to 30s later. Their
// words: "it looks like you have to buy the product again."
//
// The fix is a WINDOW, not a longer single wait. A completed checkout stamps
// this marker; every gate that would otherwise render a paywall first asks
// "did this buyer just pay?" and, if so, renders "Confirming your purchase…"
// while it re-asks the entitlement question on a FAST bounded poll. The three
// rules that come out of that, and that the specs pin:
//
//   1. On checkout return, NEVER the buy CTA — confirming, or the app.
//   2. Poll fast (~1s) because the grant lands in 1-2s, and enter the app the
//      moment it does.
//   3. On timeout, reassure ("we have your payment") — still never the paywall.
//      A buyer who paid and hit a slow grant must not be told to pay again.
//
// This module is deliberately DEPENDENCY-FREE (no overskill-sdk, no React, no
// import.meta.env). That is what lets the auth gate import it statically —
// unlike `@/lib/whop`, which ProtectedRoute must lazy-import because the
// builder AI freely rewrites it — and what lets the vitest suite
// (spec/javascript/template_post_purchase_confirmation.test.js) exercise the
// REAL functions instead of a hand-copied transcription of them.

/** sessionStorage key holding the ms timestamp of the last completed checkout. */
export const PURCHASE_CONFIRMING_KEY = "overskill_purchase_confirming_at";

/**
 * How long after a completed checkout a "no entitlement" answer is treated as
 * "not yet" rather than "must buy". Generous relative to the 1-2s grant: it
 * has to survive the whole purchase → login/signup → access bridge (an OAuth
 * round-trip through the platform, which can take a buyer tens of seconds),
 * because the destination they land on afterwards is the gate that used to
 * show them the paywall.
 *
 * Scoped to sessionStorage (this tab, this session) so it cannot leak into a
 * later browsing session, and only ever DELAYS a paywall — it never grants
 * access, which is decided server-side.
 */
export const PURCHASE_CONFIRMING_WINDOW_MS = 120_000;

/** Re-ask cadence while confirming. The grant lands in 1-2s, so ask ~1x/s. */
export const CONFIRM_POLL_INTERVAL_MS = 1_000;

/**
 * How long a gate holds the confirming state before falling through to the
 * reassurance message. Long enough to cover a slow webhook by a wide margin,
 * short enough that a buyer is never staring at a spinner with no explanation.
 */
export const CONFIRM_TIMEOUT_MS = 25_000;

/** The subset of the Storage API this module uses (injectable for tests). */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface ConfirmingOptions {
  /** Inject a fake storage in tests. Pass `null` to force the no-storage path. */
  storage?: StorageLike | null;
  /** Inject a fixed clock in tests. */
  now?: number;
}

/**
 * sessionStorage, or null when it is unavailable OR THROWS. Safari private
 * mode and some embedded webviews throw on mere property ACCESS, so this is
 * wrapped rather than feature-detected — an exception here would take down the
 * auth gate of every generated app.
 */
function defaultStorage(): StorageLike | null {
  try {
    if (typeof sessionStorage === "undefined") return null;
    return sessionStorage;
  } catch {
    return null;
  }
}

// `storage: null` must mean "no storage" (a real test case), while an ABSENT
// key means "use the default" — so check for the property, not truthiness.
function resolveStorage(opts: ConfirmingOptions): StorageLike | null {
  if (opts && Object.prototype.hasOwnProperty.call(opts, "storage")) {
    return opts.storage ?? null;
  }
  return defaultStorage();
}

/**
 * Stamp "a checkout just completed in this tab". Call this at EVERY completion
 * path (the in-SPA CheckoutDialog onComplete and the /checkout/complete return
 * route) — a path that forgets to stamp is a path where the buyer can still be
 * shown the paywall.
 */
export function markPurchaseConfirming(opts: ConfirmingOptions = {}): void {
  const storage = resolveStorage(opts);
  if (!storage) return;
  const now = opts.now ?? Date.now();
  try {
    storage.setItem(PURCHASE_CONFIRMING_KEY, String(now));
  } catch {
    // Storage full / denied — the gates just lose the grace window and
    // behave exactly as they did before this fix. Never throw at a buyer.
  }
}

/** The stamped completion time, or null when absent/unparseable. */
export function readPurchaseConfirmingAt(opts: ConfirmingOptions = {}): number | null {
  const storage = resolveStorage(opts);
  if (!storage) return null;

  let raw: string | null = null;
  try {
    raw = storage.getItem(PURCHASE_CONFIRMING_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Pure window test. A FUTURE stamp (negative age) is deliberately NOT in the
 * window: it can only come from a corrupted value or a backwards clock, and
 * failing that case toward "not confirming" keeps a genuine never-purchased
 * visitor's paywall working. The stamp is written and read seconds apart in
 * one tab, so a legitimate negative age effectively does not occur.
 */
export function isWithinConfirmingWindow(stampedAt: number | null, now: number): boolean {
  if (stampedAt === null || !Number.isFinite(stampedAt)) return false;
  const age = now - stampedAt;
  return age >= 0 && age < PURCHASE_CONFIRMING_WINDOW_MS;
}

/** Did a checkout complete in this tab recently enough to still be settling? */
export function isPurchaseConfirming(opts: ConfirmingOptions = {}): boolean {
  return isWithinConfirmingWindow(readPurchaseConfirmingAt(opts), opts.now ?? Date.now());
}

/**
 * Drop the marker. Call this once access is actually granted, so a LATER visit
 * to a genuine paywall (a second product, an expired plan) shows the buy CTA
 * immediately instead of inheriting this purchase's grace window.
 */
export function clearPurchaseConfirming(opts: ConfirmingOptions = {}): void {
  const storage = resolveStorage(opts);
  if (!storage) return;
  try {
    storage.removeItem(PURCHASE_CONFIRMING_KEY);
  } catch {
    // Nothing to do — a stale marker expires on its own via the window.
  }
}

export interface PollUntilResult {
  /** The predicate returned true before the deadline. */
  ok: boolean;
  /** The deadline passed with the predicate still false. */
  timedOut: boolean;
  /** How many times the predicate was evaluated (always >= 1). */
  attempts: number;
}

export interface PollUntilOptions {
  intervalMs?: number;
  timeoutMs?: number;
  /** Injectable sleep (tests pass a synchronous advance-the-clock stub). */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock (tests pass a controllable one). */
  now?: () => number;
}

/**
 * Bounded "keep asking until it's true" poll. Mirrors
 * `pollWalletBalanceUntilChanged()` (the wallet-seed lag bridge) — same
 * bounded-retry shape, made generic and injectable so it is unit-testable
 * without timers.
 *
 * Contract:
 *   - the predicate is evaluated IMMEDIATELY (attempt 1), before any sleep, so
 *     an already-granted entitlement costs zero delay
 *   - a predicate that THROWS counts as "not yet", never as a failure — a
 *     flaky network read must not collapse the confirming state into a paywall
 *   - it always terminates: either the predicate is satisfied or the deadline
 *     passes
 */
export async function pollUntil(
  predicate: () => boolean | Promise<boolean>,
  opts: PollUntilOptions = {}
): Promise<PollUntilResult> {
  const intervalMs = opts.intervalMs ?? CONFIRM_POLL_INTERVAL_MS;
  const timeoutMs = opts.timeoutMs ?? CONFIRM_TIMEOUT_MS;
  const clock = opts.now ?? (() => Date.now());
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const startedAt = clock();
  let attempts = 0;

  for (;;) {
    attempts += 1;

    let satisfied = false;
    try {
      satisfied = (await predicate()) === true;
    } catch {
      satisfied = false;
    }
    if (satisfied) return { ok: true, timedOut: false, attempts };

    if (clock() - startedAt >= timeoutMs) {
      return { ok: false, timedOut: true, attempts };
    }

    await sleep(intervalMs);
  }
}
