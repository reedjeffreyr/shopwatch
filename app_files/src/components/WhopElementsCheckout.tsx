// PLATFORM-MANAGED: WhopElementsCheckout — the Whop Elements checkout surface
// (hosted-runtime path). Render this wherever the app sells access to ONE plan.
//
// Usage (planId ALWAYS from import.meta.env.VITE_PLAN_*, never a literal):
//   <WhopElementsCheckout planId={import.meta.env.VITE_PLAN_PRO} />
//
// Contract this component owns so page code never has to:
//   - MINTS THE PURCHASE IDENTITY SERVER-SIDE FIRST (mintCheckoutIdentity from
//     @/lib/whop → /api/whop/checkout-session → Whop::GeneratedAppCheckoutSession).
//     That server seam is the ONE money identity: it refuses a plan that isn't
//     an active plan on THIS app, refuses an origin that isn't one of the
//     app's hosts, inserts the checkout intent, and composes the metadata blob
//     (kind + checkout_intent_token + overskill ids) the fulfillment webhook
//     trusts. The Elements checkout mounts a client-minted checkout session
//     (the element cannot mount from a ch_xxx configuration), so this
//     component passes that server blob to the element VERBATIM — and REFUSES
//     to mount at all when the identity is missing (fail closed: a checkout
//     that cannot be fulfilled must not be able to take money).
//   - Loads the hosted runtime via loadWhopElements() (@/lib/whop-elements) —
//     NEVER hand-roll the script tag or call window.WhopElements directly.
//   - Mounts the Checkout element and destroys it on unmount. The element
//     renders in its OWN iframe; page CSS cannot reach inside it.
//   - EVERY checkout option is CREATE-TIME. Changing planId / quantity /
//     promoCode remounts a fresh checkout (which re-mints the identity).
//     Appearance is the one live-updatable thing and follows the theme prop
//     without a remount.
//   - Uses the SERVER's redirect (the app's own /checkout/complete on an
//     allowed host). A finished checkout NAVIGATES THE WHOLE TAB there — there
//     is no onComplete/onSuccess callback on this surface. Fulfillment is
//     webhook-driven; never grant access from browser code.
//   - Hands off its loading skeleton at onLoaderStart; surfaces onError as an
//     honest inline state (blank space with a console-only error is the
//     documented failure mode we refuse to ship).

import * as React from "react";
import { AlertCircle, Loader2, RefreshCw } from "lucide-react";
import {
  loadWhopElements,
  type WhopCheckoutElementError,
  type WhopCheckoutElementHandle,
  type WhopCheckoutGroupHandle,
} from "@/lib/whop-elements";
import {
  CheckoutSessionRateLimitError,
  CheckoutUnavailableError,
  mintCheckoutIdentity,
  type CheckoutIdentity,
} from "@/lib/whop";

// Buyer-visible copy ONLY — never render a raw internal error string here
// (independent review D1: loader failures leak the processor brand and the
// rate-limit error's message is a literal token; the platform rule forbids
// naming the processor in buyer-visible text). The real error goes to
// console + the onError telemetry callback.
const GENERIC_CHECKOUT_ERROR_COPY =
  "We couldn't load the checkout. Please try again.";
const CHECKOUT_BUSY_COPY =
  "Checkout is busy right now — please try again in a moment.";

// Auto-retry a transient 429 (per-IP mint cap) after the server's Retry-After
// window — parity with the legacy lane's session-hook backoff (same cap).
// Bounded so a genuinely rate-limited buyer still gets a Retry affordance
// rather than an infinite spinner.
const MAX_RATE_LIMIT_BACKOFF_ATTEMPTS = 2;

function buyerSafeCheckoutErrorCopy(error: unknown): string {
  // CheckoutUnavailableError.message is composed server-aware and already fit
  // to show (it names WHICH cause without naming the processor).
  if (error instanceof CheckoutUnavailableError) return error.message;
  if (error instanceof CheckoutSessionRateLimitError) return CHECKOUT_BUSY_COPY;
  return GENERIC_CHECKOUT_ERROR_COPY;
}

export interface WhopElementsCheckoutProps {
  /** Whop plan id — ALWAYS from import.meta.env.VITE_PLAN_*, never a literal. */
  planId: string;
  /** Default 1. Plans that disallow multiples refuse >1 at mount. */
  quantity?: number;
  /** Applied before the buyer sees a price; invalid codes open at full price. */
  promoCode?: string;
  /** UTM/funnel attribution for the seller's reporting (utmSource, funnelId, …). */
  attribution?: Record<string, string | undefined>;
  theme?: "light" | "dark" | "system";
  className?: string;
  onReady?: () => void;
  onError?: (error: WhopCheckoutElementError) => void;
}

type SurfaceState = "loading" | "ready" | "error";

function resolveThemeAppearance(theme: "light" | "dark" | "system") {
  const resolved =
    theme === "system"
      ? window.matchMedia?.("(prefers-color-scheme: dark)")?.matches
        ? "dark"
        : "light"
      : theme;
  return { theme: { appearance: resolved } };
}

export function WhopElementsCheckout({
  planId,
  quantity,
  promoCode,
  attribution,
  theme = "system",
  className,
  onReady,
  onError,
}: WhopElementsCheckoutProps) {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const groupRef = React.useRef<WhopCheckoutGroupHandle | null>(null);
  const [state, setState] = React.useState<SurfaceState>("loading");
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [attempt, setAttempt] = React.useState(0);

  // Latest-value refs keep the element's callbacks identity-stable while the
  // mount effect stays keyed on create-time options only.
  const onReadyRef = React.useRef(onReady);
  const onErrorRef = React.useRef(onError);
  React.useEffect(() => {
    onReadyRef.current = onReady;
    onErrorRef.current = onError;
  });

  // Create-time options are serialized into ONE key: any change remounts a
  // fresh checkout (the runtime's own rule — see the header comment), which
  // also re-mints the server identity for the new plan. Theme is deliberately
  // EXCLUDED: appearance updates live without a remount.
  const createKey = React.useMemo(
    () =>
      JSON.stringify([
        planId,
        quantity ?? null,
        promoCode ?? null,
        attribution ?? null,
      ]),
    [planId, quantity, promoCode, attribution]
  );

  React.useEffect(() => {
    if (!planId) {
      setState("error");
      setErrorMessage("This checkout isn't configured yet (missing plan).");
      return;
    }

    let cancelled = false;
    let element: WhopCheckoutElementHandle | null = null;
    setState("loading");
    setErrorMessage(null);

    const options = JSON.parse(createKey) as [
      string,
      number | null,
      string | null,
      Record<string, string | undefined> | null,
    ];
    const [plan, qty, promo, attributionInput] = options;

    // Bounded 429 backoff (legacy-lane parity): retry the mint after the
    // server's Retry-After window, up to the cap, then surface the busy copy.
    const mintWithBackoff = async (): Promise<CheckoutIdentity> => {
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await mintCheckoutIdentity(plan);
        } catch (error) {
          if (
            error instanceof CheckoutSessionRateLimitError &&
            attempt < MAX_RATE_LIMIT_BACKOFF_ATTEMPTS &&
            !cancelled
          ) {
            await new Promise((resolve) =>
              setTimeout(resolve, error.retryAfterMs)
            );
            if (!cancelled) continue;
          }
          throw error;
        }
      }
    };

    // The runtime load and the server identity mint are independent — run them
    // in parallel; the mount waits on both.
    Promise.all([loadWhopElements(), mintWithBackoff()])
      .then(([WhopElements, identity]: [
        Awaited<ReturnType<typeof loadWhopElements>>,
        CheckoutIdentity,
      ]) => {
        if (cancelled || !containerRef.current) return;

        // FAIL CLOSED — never mount an identity-less checkout. Without the
        // server metadata (which embeds the checkout_intent_token) the
        // fulfillment webhook refuses the purchase (untrusted_checkout_context)
        // and the buyer would pay and then look unpaid. The redirect is part
        // of the same server-owned identity (independent review D5): a
        // browser-composed returnUrl must never enter the money path, so a
        // missing redirectUrl refuses too. A worker that predates the identity
        // fields returns nulls; refuse and say so.
        if (
          !identity.metadata ||
          !identity.metadata.checkout_intent_token ||
          !identity.redirectUrl
        ) {
          setState("error");
          setErrorMessage(
            "Checkout is temporarily unavailable. Please try again shortly."
          );
          onErrorRef.current?.({ message: "checkout_identity_unavailable" });
          return;
        }

        const whop = WhopElements({
          locale: "en",
          appearance: resolveThemeAppearance(theme),
        });
        const group = whop.checkout.create({
          // The SERVER's plan id (it validated the plan belongs to this app).
          plan: identity.planId,
          ...(qty ? { quantity: qty } : {}),
          ...(promo ? { promoCode: promo } : {}),
          ...(attributionInput ? { attribution: attributionInput } : {}),
          // The server-composed purchase identity, VERBATIM. Never add,
          // remove, or rewrite keys here — the webhook trust gate verifies the
          // embedded intent token against the server's own record.
          metadata: identity.metadata,
          // The SERVER's redirect, unconditionally: the app's own public
          // /checkout/complete on a validated allowed host. No browser-composed
          // fallback (independent review D5) — a missing redirect fails closed
          // above instead. The finished checkout redirects the WHOLE TAB here;
          // keep that route public and fulfill from webhooks.
          returnUrl: identity.redirectUrl,
        });
        groupRef.current = group;

        element = group.create("checkout", {
          onLoaderStart: () => {
            // The element's own skeleton has painted — the earliest moment we
            // can hand off our loading state without ever exposing a blank.
            if (!cancelled) setState("ready");
          },
          onReady: () => {
            if (cancelled) return;
            setState("ready");
            onReadyRef.current?.();
          },
          onError: (error) => {
            if (cancelled) return;
            setState("error");
            // The element's own error messages are internal (e.g. a raw JS
            // TypeError from inside its frame) — buyer-safe copy only; the
            // real error goes to console + the telemetry callback (D1).
            console.error("[WhopElementsCheckout] element error:", error);
            setErrorMessage(GENERIC_CHECKOUT_ERROR_COPY);
            onErrorRef.current?.(error);
          },
        });
        element.mount(containerRef.current);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState("error");
        // Buyer-safe copy only (D1): CheckoutUnavailableError.message is
        // composed to be shown and says WHICH cause it was; every other error
        // (loader failures, exhausted rate-limit backoff, unexpected throws)
        // maps to generic copy. The real error goes to console + telemetry.
        console.error("[WhopElementsCheckout] checkout failed to load:", error);
        setErrorMessage(buyerSafeCheckoutErrorCopy(error));
        onErrorRef.current?.({
          message:
            error instanceof Error ? error.message : "checkout_load_failed",
        });
      });

    return () => {
      cancelled = true;
      groupRef.current = null;
      try {
        element?.destroy();
      } catch {
        // The frame may already be gone (tab navigation via returnUrl).
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createKey, attempt]);

  // Theme changes restyle the MOUNTED checkout in place (appearance is the
  // one live-updatable option) — never a remount, never lost buyer input.
  React.useEffect(() => {
    if (!groupRef.current) return;
    try {
      groupRef.current.update({ appearance: resolveThemeAppearance(theme) });
    } catch {
      // Appearance is cosmetic — a failed restyle must never break checkout.
    }
  }, [theme]);

  return (
    <div className={className}>
      {state === "loading" ? (
        <div className="flex items-center justify-center gap-2 py-12 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span className="text-sm">Loading secure checkout…</span>
        </div>
      ) : null}
      {state === "error" ? (
        <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
          <AlertCircle className="h-8 w-8 text-destructive" />
          <p className="text-sm text-muted-foreground">
            {errorMessage ?? "We couldn't load the checkout. Please retry."}
          </p>
          <button
            type="button"
            onClick={() => setAttempt((n) => n + 1)}
            className="inline-flex items-center gap-2 rounded-md border px-4 py-2 text-sm font-medium hover:bg-accent"
          >
            <RefreshCw className="h-4 w-4" />
            Retry
          </button>
        </div>
      ) : null}
      {/* Never display:none while booting — the frame sizes itself and needs
          layout. A zero-height clamp hides the boot without breaking it. */}
      <div
        ref={containerRef}
        data-testid="whop-elements-checkout"
        style={state === "ready" ? undefined : { height: 0, overflow: "hidden" }}
      />
    </div>
  );
}

export default WhopElementsCheckout;
