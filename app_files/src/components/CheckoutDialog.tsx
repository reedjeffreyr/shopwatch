// PLATFORM-MANAGED: CheckoutDialog — the ONLY supported way to open the
// Whop checkout in a modal/dialog/popup. Prefer a full checkout PAGE when
// the design allows (see payments-basics Section 2); use this when the
// design genuinely calls for an in-page purchase modal.
//
// WHY THIS EXISTS (QA run 2846c3d3, pre_signup_then_buy, Jun 2026 — the
// "modal Join-click trap"): putting <WhopCheckoutEmbed> directly inside a
// generic <Dialog> (or a hand-rolled `fixed inset-0` overlay with an
// onClick-to-close backdrop) silently eats purchases:
//
//   1. The embed's iframe resizes and re-centers ITSELF mid-interaction
//      (postMessage "resize"/"center" events from the checkout). A click
//      aimed at the Join button can land on the dialog OVERLAY where the
//      iframe used to be — Radix's default pointer-down-outside behavior
//      then DISMISSES the dialog. Modal closes, iframe unmounts, purchase
//      never happens, zero feedback to the buyer.
//   2. @whop/checkout locks the iframe URL at mount and does NOT support
//      prop updates ("Updating props on the checkout embed is not
//      supported"). Any remount — unstable key, conditional re-render,
//      open-state flicker — creates a FRESH iframe and wipes everything
//      the buyer already typed (email, card, pending submit).
//
// This wrapper therefore:
//   - disables outside-click/backdrop dismissal entirely. A purchase
//     modal must never close by accident — explicit X or Escape only.
//   - renders the embed in a memoized subtree whose props are all
//     identity-stable, so parent re-renders (auth state, entitlement
//     polling, page state) can NEVER remount the iframe. The embed
//     remounts only when `planId` changes (intentional, via key).
//   - bakes in the required returnUrl + onIdentityCaptured wiring and a
//     default onComplete that navigates to the canonical /checkout/complete
//     route — the SAME place returnUrl points — so the in-SPA completion and
//     Whop's top-window redirect converge on one purchase-confirmation page
//     (which then bridges into purchase → login/signup → access). Also
//     refreshes entitlements on completion.
//
// Usage:
//   const [open, setOpen] = useState(false);
//   <Button onClick={() => setOpen(true)}>Join — $29/mo</Button>
//   <CheckoutDialog
//     open={open}
//     onOpenChange={setOpen}
//     planId={import.meta.env.VITE_PLAN_PRO}
//     title="Join Pro"
//   />

import * as React from "react";
import { useNavigate } from "react-router-dom";
import { AlertCircle, Loader2, RefreshCw } from "lucide-react";
import { WhopCheckoutEmbed } from "@whop/checkout/react";
import { useEntitlement } from "overskill-sdk";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAuth } from "@/lib/auth";
import {
  captureCheckoutEmail,
  captureCheckoutReceipt,
  resolvePostPurchaseDestination,
} from "@/lib/whop";
import { markPurchaseConfirming } from "@/lib/purchase-confirmation";
import { useCheckoutSession } from "@/hooks/useCheckoutSession";

export interface CheckoutDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Whop plan id — ALWAYS from import.meta.env.VITE_PLAN_*, never a literal. */
  planId: string;
  title?: string;
  description?: string;
  theme?: "light" | "dark" | "system";
  /**
   * Post-purchase destination for the default redirect — the app's REAL
   * primary authenticated surface (the route that renders the paid feature,
   * e.g. `/studio`). When omitted it's resolved via
   * `resolvePostPurchaseDestination`: `VITE_POST_LOGIN_ROUTE`, else
   * `/dashboard`. Pass it explicitly (or set `VITE_POST_LOGIN_ROUTE`) so
   * buyers never land on a placeholder `/dashboard` (#2524).
   */
  destination?: string;
  /**
   * Optional override for the post-purchase handler (e.g. funnels that
   * navigate to an upsell page). Read through a ref — passing an inline
   * arrow here is safe and will NOT remount the iframe. When omitted,
   * the default routes through postPurchaseRedirect (signed-in buyer →
   * destination; signed-out buyer → /login with claim + email prefill).
   */
  onComplete?: (planId?: string, receiptId?: string) => void;
}

type CompleteHandler = (planId?: string, receiptId?: string) => void;

interface StableEmbedProps {
  planId: string;
  /**
   * Whop checkout-configuration session id (`ch_xxx`) — REQUIRED by Whop's
   * v3 embed protocol (mounting with only planId throws "`sessionKey` is a
   * required property"). Minted server-side via useCheckoutSession before
   * this subtree renders, so it's a stable string at mount time.
   */
  sessionId: string;
  theme: "light" | "dark" | "system";
  /** Buyer email at OPEN time — locked at iframe mount (see below). */
  email?: string;
  returnUrl: string;
  /** Ref holding the latest complete handler — ref identity is stable. */
  onCompleteRef: React.MutableRefObject<CompleteHandler>;
  /**
   * Optional promo locked at iframe mount (#5295). Whop does not support
   * updating embed props after mount; typing the code later is lost when
   * the iframe resizes or the tax Confirm remounts the pane.
   */
  promoCode?: string;
}

// The iframe boundary. Every prop the embed receives is identity-stable
// across parent re-renders, and React.memo stops re-renders from reaching
// the embed at all. The Whop iframe locks its URL at mount, so prefill is
// also locked here (initial-value ref) instead of tracking later auth
// changes — updating it post-mount is unsupported by @whop/checkout anyway.
const StableCheckoutEmbed = React.memo(function StableCheckoutEmbed({
  planId,
  sessionId,
  theme,
  email,
  returnUrl,
  onCompleteRef,
  promoCode,
}: StableEmbedProps) {
  const initialEmailRef = React.useRef(email);
  const initialPromoRef = React.useRef(promoCode);
  const prefill = React.useMemo(
    () =>
      initialEmailRef.current ? { email: initialEmailRef.current } : undefined,
    []
  );

  // Identity-stable callback; always invokes the LATEST handler via ref.
  const handleComplete = React.useCallback(
    (completedPlanId?: string, receiptId?: string) => {
      onCompleteRef.current(completedPlanId, receiptId);
    },
    [onCompleteRef]
  );

  return (
    <WhopCheckoutEmbed
      key={planId}
      planId={planId}
      sessionId={sessionId}
      theme={theme}
      adaptivePricing
      promoCode={initialPromoRef.current}
      // Save the buyer's card for later off-session charges (one-click
      // OTO/upsells via chargeUpsell() — see @/lib/whop). Matches the raw
      // <WhopCheckoutEmbed> funnel examples; without it a post-purchase OTO
      // has no saved paymentMethodId and can't be one-click.
      setupFutureUsage="off_session"
      prefill={prefill}
      returnUrl={returnUrl}
      onIdentityCaptured={captureCheckoutEmail}
      onComplete={handleComplete}
    />
  );
});

export function CheckoutDialog({
  open,
  onOpenChange,
  planId,
  title,
  description,
  theme = "system",
  destination,
  onComplete,
}: CheckoutDialogProps) {
  const navigate = useNavigate();
  const { user } = useAuth();

  // The buyer's live entitlement — the completion signal the Apple Pay fallback
  // below watches, independent of the embed's onComplete callback.
  const entitlement = useEntitlement();

  // Exactly ONE completion per open dialog, whichever signal arrives first: the
  // embed's onComplete (card payments) or the entitlement fallback (Apple Pay,
  // which never fires onComplete). Reset each time the dialog opens.
  const completedRef = React.useRef(false);
  React.useEffect(() => {
    if (open) completedRef.current = false;
  }, [open]);

  // The shared "purchase finished" path. In a ref so both the embed callback and
  // the fallback effect see fresh user/onComplete/destination at fire time.
  const finishRef = React.useRef<CompleteHandler>(() => {});
  React.useEffect(() => {
    finishRef.current = (completedPlanId, receiptId) => {
      // Idempotent: the fallback and onComplete can both fire for one purchase.
      if (completedRef.current) return;
      completedRef.current = true;

      // Stash the receipt FIRST, for every completion path. This is the only
      // moment the receipt exists in the browser: the default path below
      // navigates to /checkout/complete with just status+redirect, and the
      // provider's own returnUrl redirect carries no receipt either — so
      // without this line a buyer who checked out with a different email than
      // they log in with has nothing to prove the purchase is theirs and stays
      // locked out. (No-op when the fallback fires — it has no receipt, but by
      // then the entitlement has already landed, so no claim is needed.)
      captureCheckoutReceipt(receiptId);

      // Open the post-purchase confirmation window (ticket OS-C7KWQF). Every
      // completion path must stamp this: a path that forgets it is a path where
      // the auth gate can still bounce the buyer onto /purchase — the paywall
      // for what they just bought — during the 1-2s before the entitlement
      // lands. This is the in-SPA path; /checkout/complete stamps the
      // returnUrl top-redirect path.
      markPurchaseConfirming();

      // Let useEntitlement() consumers refetch immediately (the SDK
      // listens for this event, and starts a bounded fast re-poll so the paid
      // feature unlocks within ~1s instead of on the next 30s tick).
      window.dispatchEvent(new Event("overskill:entitlement-changed"));
      onOpenChange(false);
      if (onComplete) {
        onComplete(completedPlanId, receiptId);
      } else {
        // Converge with the returnUrl path: send the buyer to the canonical
        // /checkout/complete route, which shows purchase confirmation,
        // resolves the checkout email, and bridges into purchase →
        // login/signup → access (postPurchaseRedirect with the email
        // prefilled). Navigating straight to /login here instead would
        // drop the buyer on a bare auth page with no confirmation — the
        // bolt-buy QA bug (#1604/#1660).
        // Resolve the app's REAL primary surface (explicit destination →
        // VITE_POST_LOGIN_ROUTE → /dashboard) so the buyer never lands on a
        // placeholder /dashboard that isn't wired to the paid feature (#2524).
        const resolvedDestination = resolvePostPurchaseDestination(destination);
        navigate(
          `/checkout/complete?status=success&redirect=${encodeURIComponent(resolvedDestination)}`
        );
      }
    };
  });

  // Latest-value ref keeps the embed's callback identity-stable while still
  // reaching the fresh shared finish above.
  const onCompleteRef = React.useRef<CompleteHandler>(() => {});
  React.useEffect(() => {
    onCompleteRef.current = (completedPlanId, receiptId) => {
      finishRef.current(completedPlanId, receiptId);
    };
  });

  // APPLE PAY / iframe-navigation completion fallback (#4830). Whop's
  // <WhopCheckoutEmbed> fires onComplete for card payments but NOT for Apple
  // Pay: the embed navigates to returnUrl INSIDE its own iframe, so the top page
  // never moves and the buyer is stranded on the pricing page even though the
  // charge, membership activation, and our webhooks all succeeded. Detect
  // completion independently — when a NEW active plan appears that was not
  // present when the dialog opened, finish the flow ourselves. Baseline-aware so
  // an upsell dialog opened by a buyer who ALREADY has an active plan never
  // false-completes on open; it fires only on a real transition.
  const baselineRef = React.useRef<string | null>(null);
  const baselineSetRef = React.useRef(false);
  React.useEffect(() => {
    if (!open) {
      baselineSetRef.current = false;
      baselineRef.current = null;
      return;
    }
    // Wait for the first SETTLED read while open — that is the "before" state.
    if (entitlement.isLoading) return;

    const active = entitlement.activePlan();
    // Key on the plan's STABLE identity only — never the whole record. Lifecycle
    // fields on the same plan mutate between polls (manage_url signing,
    // period_end on renewal, cancel_at_period_end toggling in another tab,
    // features[] order), and a deep-equality check would read any of those as
    // "a new purchase" and yank an upsell buyer out mid-checkout. plan_id is the
    // external id; tier_name is the fallback.
    const planKey = active
      ? String(active.plan_id ?? active.tier_name ?? "active")
      : null;
    if (!baselineSetRef.current) {
      baselineSetRef.current = true;
      baselineRef.current = planKey;
      return;
    }
    // A DIFFERENT active plan than the one present when we opened = this purchase
    // landed (null -> plan for a first buy; plan A -> plan B for an upsell).
    if (active && planKey !== baselineRef.current) {
      finishRef.current(planId);
    }
  }, [open, entitlement, planId]);

  // Apple Pay hands focus back to the tab when its native sheet closes; nudge a
  // fresh entitlement read so the fallback converges in ~1s instead of waiting
  // for the SDK's 30s poll tick.
  React.useEffect(() => {
    if (!open) return;
    const nudge = () => {
      if (document.visibilityState === "visible") {
        window.dispatchEvent(new Event("overskill:entitlement-changed"));
      }
    };
    window.addEventListener("focus", nudge);
    document.addEventListener("visibilitychange", nudge);
    return () => {
      window.removeEventListener("focus", nudge);
      document.removeEventListener("visibilitychange", nudge);
    };
  }, [open]);

  const returnUrl = React.useMemo(
    () => `${window.location.origin}/checkout/complete`,
    []
  );

  // Lock ?promo= at open so the embed mounts with the test/discount code
  // already applied (#5295). Typing it after mount is wiped by iframe resize.
  const promoFromUrl = React.useMemo(() => {
    try {
      return new URLSearchParams(window.location.search).get("promo") || undefined;
    } catch {
      return undefined;
    }
  }, []);

  // Whop's v3 embed protocol REQUIRES a server-created checkout session;
  // mounting the embed with only a planId throws "`sessionKey` is a required
  // property" and the pay button no-ops. Mint the session (keyed on planId)
  // only while the dialog is open, then mount the embed with sessionId.
  const { sessionId, status, error, liveUrl, retryable, retry } =
    useCheckoutSession(planId, {
    enabled: open,
    redirectUrl: returnUrl,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-lg max-h-[95vh] overflow-visible"
        // CRITICAL: a purchase modal must NEVER dismiss from a backdrop /
        // outside-pointer event. The checkout iframe resizes itself while
        // the buyer interacts, so a tap aimed at Join can land on the
        // overlay — without these guards that click CLOSES the modal and
        // destroys the in-progress checkout (the Jun 2026 silent-purchase
        // -loss bug). Close is explicit only: the X button or Escape.
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{title ?? "Complete your purchase"}</DialogTitle>
          {description ? (
            <DialogDescription>{description}</DialogDescription>
          ) : null}
        </DialogHeader>
        {status === "error" || (status === "ready" && !sessionId) ? (
          <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
            <AlertCircle className="h-8 w-8 text-destructive" />
            {/*
              `error` already says WHICH cause it was, in words fit to show.
              Render it verbatim — never substitute a guess about the seller's
              payment setup, which is wrong for most causes.
            */}
            <p className="text-sm text-muted-foreground">
              {error ?? "We couldn't start the checkout. Please try again."}
            </p>
            {liveUrl ? (
              <a
                href={liveUrl}
                className="inline-flex items-center gap-2 rounded-md border px-4 py-2 text-sm font-medium hover:bg-accent"
              >
                Open the live app
              </a>
            ) : null}
            {retryable ? (
              <button
                type="button"
                onClick={retry}
                className="inline-flex items-center gap-2 rounded-md border px-4 py-2 text-sm font-medium hover:bg-accent"
              >
                <RefreshCw className="h-4 w-4" />
                Retry
              </button>
            ) : null}
          </div>
        ) : sessionId ? (
          <StableCheckoutEmbed
            planId={planId}
            sessionId={sessionId}
            theme={theme}
            email={user?.email}
            returnUrl={returnUrl}
            onCompleteRef={onCompleteRef}
        promoCode={promoFromUrl}
      />
        ) : (
          <div className="flex items-center justify-center gap-2 py-12 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span className="text-sm">Loading secure checkout…</span>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default CheckoutDialog;
