// PLATFORM-MANAGED: WebMcpCheckoutTools — mount this next to the checkout and
// an in-browser AI agent (Chrome's WebMCP registry) can read and help drive it
// for the shopper. Renders NOTHING.
//
// Usage inside a Model B composition — the only surface an agent can drive:
//
//   <WhopPayments planId={import.meta.env.VITE_PLAN_PRO} bumpPlanIds={[BUMP]}>
//     <WhopHostEmailInput /> … <WhopCardElement /> <WhopPayButton />
//     <WebMcpCheckoutTools
//       productName="Pro Membership"
//       plans={[{ id: PRO, name: "Pro monthly", priceLabel: "$29/mo" }]}
//       onSelectPlan={setPlanId}
//       bumps={[{ id: BUMP, name: "Workbook", priceLabel: "$19" }]}
//       onSetBump={(id, on) => setBump(id, on)}
//     />
//   </WhopPayments>
//
// Beside the hosted one-plan checkout (or the legacy embed), pass
// `surface="hosted"`: the whole purchase happens inside the provider's frame,
// so the agent gets READ-ONLY state and is told plainly that the shopper
// completes it themselves. That refusal is the feature — an agent that knows
// it cannot act asks the person instead of fabricating a click.
//
// WHY THIS COMPONENT EXISTS RATHER THAN PAGE CODE CALLING THE BROWSER API:
// every rule that makes an agent-driveable checkout safe (no card frame
// access, no PII in tool results, no charge without the shopper's own payment
// keystroke and approval, exact plan matching) lives in one reviewed place.
// Page code that hand-rolled `document.modelContext` would have none of them.
//
// Never renders an error and never throws: a browser with no WebMCP — which
// is nearly all of them today — silently registers nothing.

import * as React from "react";
import {
  useOptionalWhopPayments,
  type WhopPaymentsHostBillingField,
} from "@/components/WhopPayments";
import { registerWebMcpTools } from "@/lib/webmcp";
import {
  buildCheckoutAgentTools,
  checkoutToolSignature,
  CHECKOUT_FILLABLE_CONTACT_FIELDS,
  type CheckoutAgentBridge,
  type CheckoutContactFieldState,
  type CheckoutPlanOption,
} from "@/lib/webmcp-checkout";

export interface WebMcpCheckoutToolsProps {
  /**
   * Buyer-visible offer name, used in the confirmation the shopper sees before
   * a charge. Creator content — reported to the agent as untrusted.
   */
  productName?: string;
  /**
   * The plans this page lets the shopper choose between. Omit for a
   * single-plan checkout: `select-plan` is then not registered at all.
   */
  plans?: CheckoutPlanOption[];
  /** Required for `select-plan` to exist. Swap the plan your page is selling. */
  onSelectPlan?: (planId: string) => void;
  /**
   * Order bumps this page offers. Ids MUST also be in the `bumpPlanIds`
   * allowlist on `<WhopPayments>`; anything else is dropped rather than
   * advertised, because ticking it could never bill.
   */
  bumps?: CheckoutPlanOption[];
  /**
   * Your own bump handler — the same one your checkbox calls, so the mounted
   * payment methods keep tracking your summary's subtotal. Without it the tool
   * falls back to `setBumpSelected(id, selected)`, which still bills correctly
   * (the server charges each selected catalog plan) but does not restyle the
   * payment surface for the new total.
   */
  onSetBump?: (planId: string, selected: boolean) => void;
  /**
   * Set TRUE when this page's pay action would charge a card already on file
   * (a post-purchase upsell). `submit-order` then refuses outright — an agent
   * may never spend a saved card.
   */
  hasSavedPaymentMethod?: boolean;
  /**
   * "hosted" for the one-plan Elements checkout or the legacy embed (read-only
   * state, nothing driveable). Defaults to "composition" inside
   * `<WhopPayments>` and "hosted" anywhere else.
   */
  surface?: "composition" | "hosted";
}

const HOSTED_SURFACE_REASON =
  "This checkout runs inside the payment provider's secure frame. Its fields and its pay button belong to the shopper — read the state, then ask them to complete it.";

/**
 * Let React apply the state a just-awaited action set, so the outcome we
 * report is the one the shopper can now see. `confirm()` and the promo apply
 * both resolve BEFORE their `setState`s have rendered, and reading the stale
 * render would report "submitted" for a declined card.
 */
function afterStateFlush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

type PaymentsHandle = ReturnType<typeof useOptionalWhopPayments>;

interface BridgeInputs {
  payments: PaymentsHandle;
  props: WebMcpCheckoutToolsProps;
}

export function WebMcpCheckoutTools(props: WebMcpCheckoutToolsProps) {
  const payments = useOptionalWhopPayments();

  // Tools are registered once per CAPABILITY set but must read live state, so
  // every execute() goes through this ref rather than a captured render.
  const latest = React.useRef<BridgeInputs>({ payments, props });
  latest.current = { payments, props };

  const releaseRef = React.useRef<(() => void) | null>(null);
  const abortRef = React.useRef<AbortController | null>(null);

  const releaseTools = React.useCallback(() => {
    try {
      abortRef.current?.abort();
    } catch {
      // Already aborted.
    }
    try {
      releaseRef.current?.();
    } catch {
      // Already released.
    }
  }, []);

  const buildBridge = React.useCallback((): CheckoutAgentBridge => {
    const { payments: handle, props: current } = latest.current;
    const surface =
      current.surface ?? (handle ? "composition" : ("hosted" as const));
    const hasSavedPaymentMethod = current.hasSavedPaymentMethod === true;

    if (surface !== "composition" || !handle) {
      return {
        surface: "hosted",
        hostedReason: HOSTED_SURFACE_REASON,
        productName: current.productName,
        plans: current.plans ?? [],
        selectedPlanId: handle?.planId ?? null,
        bumps: [],
        payment: {
          method: "none",
          detailsComplete: false,
          hasSavedPaymentMethod,
        },
        totals: {
          currency: handle?.identity?.currency ?? null,
          subtotalCents: handle?.identity?.amountCents ?? null,
          discountCents: null,
          dueTodayCents: handle?.identity?.amountCents ?? null,
        },
        status: { busy: false, error: null, errorField: null },
      };
    }

    // Only ids on the <WhopPayments> allowlist can ever bill, so anything else
    // the page declared is dropped instead of advertised.
    const bumps = (current.bumps ?? [])
      .filter((bump) => handle.bumpPlanIds.includes(bump.id))
      .map((bump) => ({
        ...bump,
        selected: handle.selectedBumpIds.includes(bump.id),
      }));

    const quote = handle.promo.quote;
    const invalidField = handle.errorSurface;
    const contactFields: CheckoutContactFieldState[] =
      CHECKOUT_FILLABLE_CONTACT_FIELDS.map((field) => ({
        field,
        present: handle.hostBilling.present(
          field as WhopPaymentsHostBillingField
        ),
        invalid:
          invalidField === "email"
            ? field === "email"
            : invalidField === "name"
              ? field !== "email"
              : false,
        fillable: handle.hostBilling.mounted(
          field as WhopPaymentsHostBillingField
        ),
      }));
    // The address lives in the provider's frame. Report it only once that
    // element has actually reported on itself — never assert a field this page
    // may not even render.
    if (handle.complete.address !== undefined) {
      contactFields.push({
        field: "address",
        present: Boolean(handle.complete.address),
        invalid: false,
        fillable: false,
      });
    }

    const setBump = current.onSetBump;
    return {
      surface: "composition",
      productName: current.productName,
      plans: current.plans ?? [],
      selectedPlanId: handle.planId ?? null,
      selectPlan: current.onSelectPlan
        ? (planId: string) => current.onSelectPlan?.(planId)
        : undefined,
      bumps,
      setBumpSelected: bumps.length
        ? (planId: string, selected: boolean) => {
            if (setBump) setBump(planId, selected);
            else handle.setBumpSelected(planId, selected);
          }
        : undefined,
      discount: {
        applied: handle.promo.applied,
        busy: handle.promo.busy,
        notice: handle.promo.notice,
        label: quote ? quote.discountLabel : null,
        apply: async (code: string) => {
          const applied = await handle.promo.apply(code);
          await afterStateFlush();
          return {
            applied: applied ? applied.code : null,
            notice: latest.current.payments?.promo.notice ?? null,
          };
        },
        clear: () => handle.promo.clear(),
      },
      contact: {
        fields: contactFields,
        fill: (values) => handle.hostBilling.fill(values),
      },
      payment: {
        // Which surface has reported input. A mounted-but-untouched element is
        // "none" on purpose: `detailsComplete` is the only claim that matters,
        // and it is the provider element's own word, never our inference.
        method:
          handle.complete.payment !== undefined
            ? "payment"
            : handle.complete.card !== undefined
              ? "card"
              : "none",
        detailsComplete: Boolean(
          handle.complete.card || handle.complete.payment
        ),
        hasSavedPaymentMethod,
      },
      totals: {
        currency: handle.identity?.currency ?? null,
        subtotalCents: quote
          ? quote.subtotalCents
          : (handle.identity?.amountCents ?? null),
        discountCents: quote ? quote.discountCents : null,
        dueTodayCents: quote
          ? quote.totalCents
          : (handle.identity?.amountCents ?? null),
      },
      status: {
        busy: handle.confirming || handle.promo.busy,
        error: handle.errorMessage,
        errorField: handle.errorSurface,
      },
      submit: async () => {
        try {
          await handle.confirm();
        } catch {
          // The internal reason is not buyer-safe copy; the page's own visible
          // state is, so point the agent at it rather than relaying a raw error.
          return {
            ok: false,
            error: "submit_failed",
            message:
              "The order could not be submitted. Call get-checkout-state to read what the page is showing the shopper.",
          };
        }
        await afterStateFlush();
        const after = latest.current.payments;
        if (after?.errorMessage) {
          return {
            ok: false,
            error: "payment_declined",
            message: after.errorMessage,
          };
        }
        return { ok: true };
      },
      onSubmitted: releaseTools,
    };
  }, [releaseTools]);

  // Registering on every state change would churn the registry on each typed
  // character. The tool SET only changes when a capability appears or goes.
  const signature = checkoutToolSignature(buildBridge());

  React.useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;
    const release = registerWebMcpTools(buildCheckoutAgentTools(buildBridge), {
      signal: controller.signal,
    });
    releaseRef.current = release;
    return () => {
      try {
        controller.abort();
      } catch {
        // Nothing listening.
      }
      release();
      releaseRef.current = null;
      abortRef.current = null;
    };
  }, [signature, buildBridge]);

  return null;
}

export default WebMcpCheckoutTools;
