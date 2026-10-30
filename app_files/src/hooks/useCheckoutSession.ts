// useCheckoutSession — fetch a Whop checkout-configuration session for a plan
// so you can mount <WhopCheckoutEmbed sessionId={...}>.
//
// REQUIRED: Whop's current (v3) embed protocol throws
// "`sessionKey` is a required property" when <WhopCheckoutEmbed> mounts with
// only a `planId`. You must first create a server-side session and pass its
// id as `sessionId`. This hook does that, with loading / error / retry state.
//
// ```tsx
// import { WhopCheckoutEmbed } from "@whop/checkout/react";
// import { useCheckoutSession } from "@/hooks/useCheckoutSession";
// import { captureCheckoutEmail } from "@/lib/whop";
//
// function Paywall() {
//   const planId = import.meta.env.VITE_PLAN_PRO;
//   const { sessionId, status, error, liveUrl, retryable, retry } =
//     useCheckoutSession(planId);
//   if (status === "loading") return <div>Loading checkout…</div>;
//   if (status === "error" || !sessionId) {
//     // `error` is already written for a human — show it verbatim. Never
//     // replace it with a guess about the account's payment setup: that guess
//     // is wrong for most causes, and it cost creators launch-day sales.
//     return (
//       <div>
//         <p>{error ?? "We couldn't start the checkout."}</p>
//         {liveUrl && <a href={liveUrl}>Open your live app</a>}
//         {retryable && <button onClick={retry}>Retry</button>}
//       </div>
//     );
//   }
//   return (
//     <WhopCheckoutEmbed
//       planId={planId}
//       sessionId={sessionId}
//       returnUrl={`${window.location.origin}/checkout/complete`}
//       onIdentityCaptured={captureCheckoutEmail}
//     />
//   );
// }
// ```
//
// To force a NEW session when the plan changes (e.g. an order bump toggling
// planId), pass the changing planId in — the hook re-fetches automatically.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  createCheckoutSession,
  CheckoutSessionRateLimitError,
  CheckoutUnavailableError,
  type CheckoutUnavailableReason,
  type CreateCheckoutSessionOptions,
} from "@/lib/whop";

export type CheckoutSessionStatus = "idle" | "loading" | "ready" | "error";

// Shown when the server gave no reason we can turn into specific advice.
const GENERIC_CHECKOUT_ERROR = "We couldn't start the checkout. Please try again.";
// An exhausted 429 backoff arrives as CheckoutSessionRateLimitError, which the
// server never labels with a reason — say the true thing anyway.
const RATE_LIMITED_CHECKOUT_ERROR =
  "Too many checkout attempts just now. Give it a few seconds and try again.";

export interface UseCheckoutSessionResult {
  /** The Whop checkout-configuration session id (`ch_xxx`), or null until ready. */
  sessionId: string | null;
  status: CheckoutSessionStatus;
  /** Convenience: true while the session is being created. */
  loading: boolean;
  /**
   * Presentable message when the session couldn't be created, else null.
   * Already written for a human — render it as-is.
   */
  error: string | null;
  /**
   * WHICH cause it was, when the server said. Null for an unknown/older server.
   * Branch on this only for extra affordances (a link, a different icon) — the
   * wording is already in `error`.
   */
  errorReason: CheckoutUnavailableReason | null;
  /**
   * Raw underlying message for a failure the server did not classify (network
   * error, exhausted retry, bug). For logging — never render it.
   */
  errorDetail: string | null;
  /**
   * The address this checkout WILL work on. Set only when the caller is on the
   * editor preview window; link it so the creator can get straight there.
   */
  liveUrl: string | null;
  /**
   * False when retrying cannot help (wrong address, missing plan, payments not
   * set up). Hide the retry button rather than inviting a loop that can't win.
   */
  retryable: boolean;
  /** Re-attempt session creation (e.g. wire to a "Retry" button). */
  retry: () => void;
}

export interface UseCheckoutSessionOptions extends CreateCheckoutSessionOptions {
  // Defer fetching until true. Useful when the embed is in a modal that
  // hasn't opened yet — pass `enabled={open}`. Defaults to true.
  enabled?: boolean;
}

export function useCheckoutSession(
  planId: string | null | undefined,
  options: UseCheckoutSessionOptions = {}
): UseCheckoutSessionResult {
  const { enabled = true, metadata, redirectUrl } = options;

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [status, setStatus] = useState<CheckoutSessionStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [errorReason, setErrorReason] =
    useState<CheckoutUnavailableReason | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const [liveUrl, setLiveUrl] = useState<string | null>(null);
  const [retryable, setRetryable] = useState(true);
  const [attempt, setAttempt] = useState(0);

  // Stabilize the effect deps: metadata is an object literal callers will
  // often pass inline, so key off its JSON to avoid refetching every render.
  const metadataKey = metadata ? JSON.stringify(metadata) : "";

  // DEDUPE: remember the session we already minted for a given
  // (plan, metadata, redirect) tuple so we DON'T re-mint on every re-render,
  // React StrictMode double-mount, or repeated enable toggle. Re-minting on
  // every mount is what drove the per-IP session-mint cap into 429s and
  // surfaced as an intermittent "couldn't load checkout" (issue #3107). We
  // only mint a fresh session when the tuple actually changes or the caller
  // explicitly retries.
  const mintKey = `${planId ?? ""}|${metadataKey}|${redirectUrl ?? ""}`;
  const mintedRef = useRef<{ key: string; sessionId: string } | null>(null);

  // Reset every failure field together. They are one fact in four pieces, and a
  // stale `liveUrl` or `retryable` outliving its `error` is exactly the kind of
  // half-cleared state that puts wrong advice in front of a creator.
  const clearFailure = useCallback(() => {
    setError(null);
    setErrorDetail(null);
    setErrorReason(null);
    setLiveUrl(null);
    setRetryable(true);
  }, []);

  useEffect(() => {
    if (!enabled || !planId) {
      setStatus("idle");
      clearFailure();
      // Do NOT clear a session we already minted for this plan — clearing it
      // here caused a re-mint the moment `enabled` flipped back on.
      if (!planId) {
        setSessionId(null);
        mintedRef.current = null;
      }
      return;
    }

    // Reuse the already-minted session for this exact tuple — no network call.
    if (mintedRef.current && mintedRef.current.key === mintKey) {
      setSessionId(mintedRef.current.sessionId);
      setStatus("ready");
      clearFailure();
      return;
    }

    let cancelled = false;
    let backoffTimer: ReturnType<typeof setTimeout> | undefined;
    setStatus("loading");
    clearFailure();
    setSessionId(null);

    // Auto-retry a transient 429 (per-IP mint cap) after the server's
    // Retry-After window instead of surfacing a hard failure. Bounded to a
    // couple of attempts so a genuinely rate-limited buyer still gets a
    // retry affordance rather than an infinite spinner.
    const MAX_BACKOFF_ATTEMPTS = 2;
    const mint = (backoffAttempt: number) => {
      createCheckoutSession(planId, { metadata, redirectUrl })
        .then((id) => {
          if (cancelled) return;
          mintedRef.current = { key: mintKey, sessionId: id };
          setSessionId(id);
          setStatus("ready");
        })
        .catch((e: unknown) => {
          if (cancelled) return;
          if (
            e instanceof CheckoutSessionRateLimitError &&
            backoffAttempt < MAX_BACKOFF_ATTEMPTS
          ) {
            backoffTimer = setTimeout(
              () => mint(backoffAttempt + 1),
              e.retryAfterMs
            );
            return;
          }
          // CheckoutUnavailableError already carries copy fit to render, plus
          // the link for the editor-preview case.
          if (e instanceof CheckoutUnavailableError) {
            setError(e.message);
            setErrorReason(e.reason);
            setLiveUrl(e.liveUrl);
            setRetryable(e.retryable);
          } else {
            // Everything else is an exhausted rate-limit retry, a network
            // failure, or a bug — and its `message` is a developer string like
            // "checkout_rate_limited" or "Failed to fetch". `error` is
            // documented as presentable, so it NEVER gets that; the raw text
            // goes to `errorDetail` for logging.
            setError(
              e instanceof CheckoutSessionRateLimitError
                ? RATE_LIMITED_CHECKOUT_ERROR
                : GENERIC_CHECKOUT_ERROR
            );
            setErrorDetail(e instanceof Error ? e.message : String(e));
            setErrorReason(null);
            setLiveUrl(null);
            setRetryable(true);
          }
          setStatus("error");
        });
    };
    mint(0);

    return () => {
      cancelled = true;
      if (backoffTimer) clearTimeout(backoffTimer);
    };
    // metadataKey (via mintKey) stands in for `metadata`; attempt drives
    // manual retries (which force a fresh mint below).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planId, enabled, mintKey, attempt]);

  const retry = useCallback(() => {
    // Force a fresh mint on the next effect run (bypass the dedupe cache).
    mintedRef.current = null;
    setAttempt((n) => n + 1);
  }, []);

  return {
    sessionId,
    status,
    loading: status === "loading",
    error,
    errorDetail,
    errorReason,
    liveUrl,
    retryable,
    retry,
  };
}
