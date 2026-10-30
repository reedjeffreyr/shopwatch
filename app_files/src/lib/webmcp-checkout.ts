// PLATFORM-MANAGED: webmcp-checkout.ts — the WebMCP tool set for this app's
// checkout, and the whole security boundary that makes exposing one safe.
//
// This file is deliberately FRAMEWORK-FREE and side-effect-free: it turns a
// `CheckoutAgentBridge` (built by `@/components/WebMcpCheckoutTools` from the
// page's own checkout wrapper) into tool descriptors. Everything below is a
// pure decision, so every rule here is unit-testable without a browser.
//
// THE FOUR RULES THIS FILE EXISTS TO ENFORCE
// ------------------------------------------
// 1. NEVER REACH INTO THE PAYMENT FRAME. Card number, expiry and CVC live in
//    the payment provider's cross-origin iframe. No tool reads it, writes it,
//    or pretends to. The only thing we ever learn about it is the boolean the
//    element itself reports: "the shopper has entered complete details".
//
// 2. NO SILENT CHARGE. `submit-order` carries `consequentialHint` AND refuses
//    unless the shopper personally entered payment details in this session
//    (`payment.detailsComplete`) AND the browser's own
//    `requestUserInteraction` approval came back positive. A page that would
//    charge a card already on file with no keystroke in the secure frame is
//    refused outright — an agent may not spend a saved card.
//
// 3. NO PII DUMP. `get-checkout-state` reports which contact fields are
//    PRESENT and which are flagged INVALID. It never returns the email, name,
//    phone or address the shopper typed, and never a checkout session id,
//    intent token, payment id, payment-method id, confirmation token or
//    promo-code id. `CHECKOUT_STATE_WITHHELD` says so in the payload itself,
//    so an agent stops looking instead of hunting the DOM for it.
//    (Plan ids ARE returned: they are catalog product ids already compiled
//    into this page's public bundle, and round-tripping them is what makes
//    `select-plan` / `set-order-bump` unambiguous.)
//
// 4. EXACT MATCHING ONLY. A plan or bump is addressed by its exact id or its
//    exact visible name. There is no substring fallback — "Pro" must never
//    silently resolve to "Pro Annual" and buy the wrong thing.
//
// Failures are RETURNED (`{ ok: false, error, message }`), never thrown, so an
// agent can read the reason and stop rather than retry blindly.

import {
  requestUserApproval,
  webMcpRefusal,
  webMcpResult,
  type WebMcpExecuteOptions,
  type WebMcpTool,
} from "./webmcp";

export const CHECKOUT_TOOL_NAMES = {
  state: "get-checkout-state",
  selectPlan: "select-plan",
  orderBump: "set-order-bump",
  applyDiscount: "apply-discount-code",
  removeDiscount: "remove-discount-code",
  fillContact: "fill-contact-information",
  submit: "submit-order",
} as const;

/** Named in the state payload so an agent knows these are refusals, not gaps. */
export const CHECKOUT_STATE_WITHHELD = [
  "contact values (email, name, phone, address) — presence and validity only",
  "checkout session id, checkout intent token, and checkout metadata",
  "payment id, payment-method id, confirmation token, and promo code id",
  "anything inside the payment provider's frame, including card details",
] as const;

export const CHECKOUT_FILLABLE_CONTACT_FIELDS = [
  "email",
  "firstName",
  "lastName",
  "name",
] as const;

export type CheckoutContactField =
  (typeof CHECKOUT_FILLABLE_CONTACT_FIELDS)[number];

/** Longest value we will hand to the checkout identity store. */
export const CHECKOUT_CONTACT_MAX_LENGTH = 320;

export interface CheckoutPlanOption {
  id: string;
  /** Buyer-visible name. Creator-controlled — untrusted content. */
  name: string;
  /** Buyer-visible price label, e.g. "$29/mo". Creator-controlled. */
  priceLabel?: string;
}

export interface CheckoutBumpOption extends CheckoutPlanOption {
  selected: boolean;
}

export interface CheckoutContactFieldState {
  field: CheckoutContactField | "address";
  present: boolean;
  invalid: boolean;
  /** False for anything that lives in the provider's frame. */
  fillable: boolean;
}

export interface CheckoutContactBridge {
  fields: CheckoutContactFieldState[];
  fill: (values: Partial<Record<CheckoutContactField, string>>) => {
    filled: CheckoutContactField[];
    unavailable: CheckoutContactField[];
  };
}

export interface CheckoutDiscountBridge {
  /** The code currently applied, or null. */
  applied: string | null;
  busy: boolean;
  /** Buyer-visible promo row copy. Creator/vendor-controlled — untrusted. */
  notice: string | null;
  /** e.g. "50% off first month". Creator-controlled — untrusted. */
  label: string | null;
  apply: (
    code: string
  ) => Promise<{ applied: string | null; notice: string | null }>;
  clear: () => void | Promise<void>;
}

export interface CheckoutPaymentState {
  /** Which payment surface the page mounted. */
  method: "card" | "payment" | "none";
  /** The provider's own element says the shopper entered complete details. */
  detailsComplete: boolean;
  /** This page's pay action would charge a card already on file. */
  hasSavedPaymentMethod: boolean;
}

export interface CheckoutTotals {
  currency: string | null;
  subtotalCents: number | null;
  discountCents: number | null;
  dueTodayCents: number | null;
}

export interface CheckoutStatus {
  busy: boolean;
  /** Buyer-visible error copy. Creator/vendor-controlled — untrusted. */
  error: string | null;
  errorField: string | null;
}

export interface CheckoutSubmitOutcome {
  ok: boolean;
  error?: string | null;
  message?: string | null;
}

export interface CheckoutAgentBridge {
  /**
   * "composition" — the page owns the fields, the bump and the pay button, so
   * an agent can drive it. "hosted" — the whole checkout is the provider's
   * frame; state is readable, nothing is driveable.
   */
  surface: "composition" | "hosted";
  hostedReason?: string;
  /** Buyer-visible offer name. Creator-controlled — untrusted. */
  productName?: string;
  plans: CheckoutPlanOption[];
  selectedPlanId: string | null;
  selectPlan?: (planId: string) => void | Promise<void>;
  bumps: CheckoutBumpOption[];
  setBumpSelected?: (planId: string, selected: boolean) => void | Promise<void>;
  discount?: CheckoutDiscountBridge;
  contact?: CheckoutContactBridge;
  payment: CheckoutPaymentState;
  totals: CheckoutTotals;
  status: CheckoutStatus;
  submit?: () => Promise<CheckoutSubmitOutcome>;
  /** Called after a submit the page reports as accepted (releases the tools). */
  onSubmitted?: () => void;
}

export type CheckoutBridgeReader = () => CheckoutAgentBridge;

/**
 * EXACT match only — the id, or the visible name after trimming surrounding
 * whitespace. No case folding, no `includes`: a near-miss must refuse and say
 * what the real options are, never buy the closest thing.
 */
export function matchCheckoutOption<T extends CheckoutPlanOption>(
  options: T[],
  needle: unknown
): T | null {
  if (typeof needle !== "string") return null;
  const wanted = needle.trim();
  if (!wanted) return null;
  for (const option of options) {
    if (option.id === wanted) return option;
  }
  for (const option of options) {
    if (typeof option.name === "string" && option.name.trim() === wanted) {
      return option;
    }
  }
  return null;
}

function optionLabels(options: CheckoutPlanOption[]): string[] {
  return options.map((option) => option.name || option.id);
}

function formatMinorUnits(
  cents: number | null | undefined,
  currency: string | null | undefined
): string | null {
  if (typeof cents !== "number" || !Number.isFinite(cents)) return null;
  const code = String(currency || "usd").toUpperCase();
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: code,
    }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${code}`;
  }
}

/**
 * The no-PII projection of the checkout. This is the ONLY shape any tool
 * returns state in — one function so a new tool cannot invent a leakier one.
 */
export function checkoutStateSnapshot(bridge: CheckoutAgentBridge) {
  const driveable = bridge.surface === "composition";
  return {
    surface: bridge.surface,
    canDrive: driveable,
    ...(driveable
      ? {}
      : {
          reason:
            bridge.hostedReason ||
            "This checkout runs entirely inside the payment provider's secure frame. The shopper completes it themselves.",
        }),
    product: bridge.productName ?? null,
    plans: bridge.plans.map((plan) => ({
      id: plan.id,
      name: plan.name,
      price: plan.priceLabel ?? null,
      selected: plan.id === bridge.selectedPlanId,
    })),
    orderBumps: bridge.bumps.map((bump) => ({
      id: bump.id,
      name: bump.name,
      price: bump.priceLabel ?? null,
      selected: bump.selected,
    })),
    discount: bridge.discount
      ? {
          available: true,
          applied: bridge.discount.applied,
          label: bridge.discount.label,
          notice: bridge.discount.notice,
        }
      : { available: false, applied: null, label: null, notice: null },
    contact: (bridge.contact?.fields ?? []).map((field) => ({
      field: field.field,
      present: field.present,
      invalid: field.invalid,
      fillable: field.fillable,
    })),
    payment: {
      method: bridge.payment.method,
      detailsComplete: bridge.payment.detailsComplete,
      hasSavedPaymentMethod: bridge.payment.hasSavedPaymentMethod,
    },
    totals: {
      currency: bridge.totals.currency,
      subtotalCents: bridge.totals.subtotalCents,
      discountCents: bridge.totals.discountCents,
      dueTodayCents: bridge.totals.dueTodayCents,
    },
    status: {
      busy: bridge.status.busy,
      error: bridge.status.error,
      errorField: bridge.status.errorField,
    },
    withheld: [...CHECKOUT_STATE_WITHHELD],
  };
}

function contactRefusalForUnsupported(unsupported: string[]) {
  return webMcpRefusal(
    "unsupported_field",
    `This checkout only accepts ${CHECKOUT_FILLABLE_CONTACT_FIELDS.join(", ")}. ` +
      `Card details and the billing address live in the payment provider's secure frame and must be typed by the shopper. ` +
      `Rejected: ${unsupported.join(", ")}.`,
    { unsupported }
  );
}

function stateTool(getBridge: CheckoutBridgeReader): WebMcpTool {
  return {
    name: CHECKOUT_TOOL_NAMES.state,
    title: "Read checkout state",
    description:
      "Read this page's checkout: which plan and order bumps are selected, whether a discount code is applied, the totals, which contact fields are filled or flagged invalid, and whether payment details have been entered. " +
      "Returns NO personal data — no email, name or address values, and no checkout, payment or promo ids. Call this before and after every other checkout tool.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute: () => webMcpResult(checkoutStateSnapshot(getBridge())),
  };
}

function selectPlanTool(getBridge: CheckoutBridgeReader): WebMcpTool {
  return {
    name: CHECKOUT_TOOL_NAMES.selectPlan,
    title: "Choose a plan",
    description:
      "Choose which plan this checkout will buy. Identify it by the exact `id` or the exact `name` from get-checkout-state — partial names are refused. " +
      "Changing the plan RESTARTS the checkout, which clears any payment details already entered, so confirm the choice with the shopper first.",
    inputSchema: {
      type: "object",
      properties: {
        plan: {
          type: "string",
          description: "Exact plan id or exact plan name from get-checkout-state.",
          minLength: 1,
          maxLength: 200,
        },
      },
      required: ["plan"],
      additionalProperties: false,
    },
    annotations: { untrustedContentHint: true },
    execute: async (input) => {
      const bridge = getBridge();
      if (!bridge.selectPlan || !bridge.plans.length) {
        return webMcpRefusal(
          "no_plan_choice",
          "This checkout sells a single plan — there is nothing to choose."
        );
      }
      const plan = matchCheckoutOption(bridge.plans, input?.plan);
      if (!plan) {
        return webMcpRefusal(
          "unknown_plan",
          "No plan matches that exactly. Use an exact id or name from get-checkout-state.",
          { available: optionLabels(bridge.plans) }
        );
      }
      if (plan.id === bridge.selectedPlanId) {
        return webMcpResult({ plan: plan.name, planId: plan.id, changed: false });
      }
      await bridge.selectPlan(plan.id);
      return webMcpResult({
        plan: plan.name,
        planId: plan.id,
        changed: true,
        note: "The checkout restarted — payment details must be entered again.",
      });
    },
  };
}

function orderBumpTool(getBridge: CheckoutBridgeReader): WebMcpTool {
  return {
    name: CHECKOUT_TOOL_NAMES.orderBump,
    title: "Add or remove an order bump",
    description:
      "Add or remove an optional add-on offered alongside the main purchase. Identify it by the exact `id` or exact `name` from get-checkout-state. " +
      "This only changes what the order WILL contain; nothing is charged until submit-order.",
    inputSchema: {
      type: "object",
      properties: {
        bump: {
          type: "string",
          description: "Exact order-bump id or name from get-checkout-state.",
          minLength: 1,
          maxLength: 200,
        },
        selected: {
          type: "boolean",
          description: "True to add it to the order, false to remove it.",
        },
      },
      required: ["bump", "selected"],
      additionalProperties: false,
    },
    annotations: { untrustedContentHint: true },
    execute: async (input) => {
      const bridge = getBridge();
      if (!bridge.setBumpSelected || !bridge.bumps.length) {
        return webMcpRefusal(
          "no_order_bumps",
          "This checkout offers no order bumps."
        );
      }
      if (typeof input?.selected !== "boolean") {
        return webMcpRefusal(
          "invalid_arguments",
          "`selected` must be true or false."
        );
      }
      const bump = matchCheckoutOption(bridge.bumps, input?.bump);
      if (!bump) {
        return webMcpRefusal(
          "unknown_order_bump",
          "No order bump matches that exactly. Use an exact id or name from get-checkout-state.",
          { available: optionLabels(bridge.bumps) }
        );
      }
      await bridge.setBumpSelected(bump.id, input.selected);
      return webMcpResult({
        bump: bump.name,
        bumpId: bump.id,
        selected: input.selected,
      });
    },
  };
}

function applyDiscountTool(getBridge: CheckoutBridgeReader): WebMcpTool {
  return {
    name: CHECKOUT_TOOL_NAMES.applyDiscount,
    title: "Apply a discount code",
    description:
      "Apply a discount code the shopper already has. The code is checked against the seller's catalog before it counts as applied — an unknown, expired or used-up code is refused with the seller's own reason. Never invent a code.",
    inputSchema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "The discount code exactly as the shopper gave it.",
          minLength: 1,
          maxLength: 120,
        },
      },
      required: ["code"],
      additionalProperties: false,
    },
    annotations: { untrustedContentHint: true },
    execute: async (input) => {
      const bridge = getBridge();
      if (!bridge.discount) {
        return webMcpRefusal(
          "no_discount_field",
          "This checkout does not take discount codes."
        );
      }
      const code = typeof input?.code === "string" ? input.code.trim() : "";
      if (!code) {
        return webMcpRefusal("invalid_arguments", "`code` must not be empty.");
      }
      if (bridge.discount.busy || bridge.status.busy) {
        return webMcpRefusal(
          "checkout_busy",
          "The checkout is mid-request. Read get-checkout-state and try again."
        );
      }
      const outcome = await bridge.discount.apply(code);
      if (!outcome.applied) {
        return webMcpRefusal(
          "discount_rejected",
          outcome.notice || "That code was not accepted.",
          { code }
        );
      }
      const after = getBridge();
      return webMcpResult({
        applied: outcome.applied,
        label: after.discount?.label ?? null,
        totals: {
          currency: after.totals.currency,
          discountCents: after.totals.discountCents,
          dueTodayCents: after.totals.dueTodayCents,
        },
      });
    },
  };
}

function removeDiscountTool(getBridge: CheckoutBridgeReader): WebMcpTool {
  return {
    name: CHECKOUT_TOOL_NAMES.removeDiscount,
    title: "Remove the discount code",
    description:
      "Remove the discount code currently applied to this checkout and return to the full price.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { untrustedContentHint: true },
    execute: async () => {
      const bridge = getBridge();
      if (!bridge.discount) {
        return webMcpRefusal(
          "no_discount_field",
          "This checkout does not take discount codes."
        );
      }
      if (!bridge.discount.applied) {
        return webMcpResult({ applied: null, changed: false });
      }
      await bridge.discount.clear();
      return webMcpResult({ applied: null, changed: true });
    },
  };
}

function fillContactTool(getBridge: CheckoutBridgeReader): WebMcpTool {
  return {
    name: CHECKOUT_TOOL_NAMES.fillContact,
    title: "Fill the contact fields",
    description:
      "Fill this checkout's contact fields with details the shopper has given you. Accepts email, firstName, lastName and name only. " +
      "Card details and the billing address are inside the payment provider's secure frame and can only be typed by the shopper. " +
      "Echoes back only the field NAMES it set — never the values.",
    inputSchema: {
      type: "object",
      properties: {
        email: { type: "string", maxLength: CHECKOUT_CONTACT_MAX_LENGTH },
        firstName: { type: "string", maxLength: CHECKOUT_CONTACT_MAX_LENGTH },
        lastName: { type: "string", maxLength: CHECKOUT_CONTACT_MAX_LENGTH },
        name: { type: "string", maxLength: CHECKOUT_CONTACT_MAX_LENGTH },
      },
      additionalProperties: false,
    },
    execute: async (input) => {
      const bridge = getBridge();
      if (!bridge.contact) {
        return webMcpRefusal(
          "not_driveable",
          bridge.hostedReason ||
            "This checkout's fields are inside the payment provider's secure frame."
        );
      }
      const supplied = (input || {}) as Record<string, unknown>;
      const keys = Object.keys(supplied);
      if (!keys.length) {
        return webMcpRefusal(
          "invalid_arguments",
          `Supply at least one of ${CHECKOUT_FILLABLE_CONTACT_FIELDS.join(", ")}.`
        );
      }
      const unsupported = keys.filter(
        (key) =>
          !(CHECKOUT_FILLABLE_CONTACT_FIELDS as readonly string[]).includes(key)
      );
      if (unsupported.length) return contactRefusalForUnsupported(unsupported);

      const values: Partial<Record<CheckoutContactField, string>> = {};
      for (const field of CHECKOUT_FILLABLE_CONTACT_FIELDS) {
        const raw = supplied[field];
        if (raw === undefined) continue;
        if (typeof raw !== "string") {
          return webMcpRefusal(
            "invalid_arguments",
            `\`${field}\` must be a string.`
          );
        }
        const value = raw.trim();
        if (!value) {
          return webMcpRefusal(
            "invalid_arguments",
            `\`${field}\` must not be empty.`
          );
        }
        if (value.length > CHECKOUT_CONTACT_MAX_LENGTH) {
          return webMcpRefusal(
            "invalid_arguments",
            `\`${field}\` is longer than ${CHECKOUT_CONTACT_MAX_LENGTH} characters.`
          );
        }
        values[field] = value;
      }

      const { filled, unavailable } = bridge.contact.fill(values);
      if (!filled.length) {
        return webMcpRefusal(
          "field_not_on_page",
          "This checkout does not show any of those fields.",
          { unavailable }
        );
      }
      // Field NAMES only. Echoing the values back would hand an agent the
      // shopper's identity every time it set one.
      return webMcpResult({
        filled,
        ...(unavailable.length ? { unavailable } : {}),
      });
    },
  };
}

function submitTool(getBridge: CheckoutBridgeReader): WebMcpTool {
  return {
    name: CHECKOUT_TOOL_NAMES.submit,
    title: "Place the order",
    description:
      "Place this order and take payment. The shopper must have entered their payment details in the secure frame themselves and must approve the charge — this tool refuses otherwise, including when a card is already on file. On success the browser leaves for the order confirmation page.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { consequentialHint: true, untrustedContentHint: true },
    execute: async (_input, options?: WebMcpExecuteOptions) => {
      const bridge = getBridge();
      if (bridge.surface !== "composition" || !bridge.submit) {
        return webMcpRefusal(
          "not_driveable",
          bridge.hostedReason ||
            "This checkout is completed inside the payment provider's secure frame by the shopper."
        );
      }
      if (bridge.status.busy) {
        return webMcpRefusal(
          "checkout_busy",
          "This checkout is already submitting. Read get-checkout-state before retrying."
        );
      }
      if (!bridge.payment.detailsComplete) {
        // THE SAVED-CARD REFUSAL. A page whose pay action would charge a card
        // on file needs no keystroke in the secure frame, which is exactly the
        // silent charge this tool must never make possible.
        if (bridge.payment.hasSavedPaymentMethod) {
          return webMcpRefusal(
            "saved_payment_method_requires_shopper",
            "This order would charge a card already on file. Only the shopper can authorise that — ask them to press the pay button on the page themselves."
          );
        }
        return webMcpRefusal(
          "payment_details_required",
          "No payment details have been entered. The shopper must type their card into the secure payment field on the page; it cannot be filled by a tool."
        );
      }

      const amount = formatMinorUnits(
        bridge.totals.dueTodayCents ?? bridge.totals.subtotalCents,
        bridge.totals.currency
      );
      const approved = await requestUserApproval(
        {
          type: "confirm",
          title: "Place this order?",
          description: amount
            ? `${bridge.productName || "This order"} — ${amount} will be charged now.`
            : `${bridge.productName || "This order"} will be charged now for the total shown on the page.`,
          action: "Place order",
        },
        options
      );
      if (!approved) {
        return webMcpRefusal(
          "shopper_confirmation_required",
          "The shopper did not confirm the charge, or this browser cannot ask them. Have them press the pay button on the page."
        );
      }

      const outcome = await bridge.submit();
      if (!outcome.ok) {
        return webMcpRefusal(
          outcome.error || "submit_failed",
          outcome.message || "The order was not completed.",
          { charged: false }
        );
      }
      // Accepted. Release the tools: a completed checkout navigates away, and
      // an agent must never be able to submit the same order twice.
      try {
        bridge.onSubmitted?.();
      } catch {
        // Releasing is best-effort; the order already went through.
      }
      return webMcpResult({
        submitted: true,
        note: "Payment was accepted. The browser is leaving for the order confirmation page; access is granted by the seller's systems, not here.",
      });
    },
  };
}

/**
 * The tool set for this checkout.
 *
 * Capability-shaped ON PURPOSE: a tool we would always refuse is never
 * registered. Advertising `select-plan` on a one-plan page, or `submit-order`
 * on a hosted frame we cannot submit, teaches an agent this page can do
 * something it cannot — the capability leak this platform already banned for
 * its own public WebMCP tools.
 */
export function buildCheckoutAgentTools(
  getBridge: CheckoutBridgeReader
): WebMcpTool[] {
  const bridge = getBridge();
  const tools: WebMcpTool[] = [stateTool(getBridge)];
  if (bridge.surface !== "composition") return tools;

  if (bridge.selectPlan && bridge.plans.length > 1) {
    tools.push(selectPlanTool(getBridge));
  }
  if (bridge.setBumpSelected && bridge.bumps.length) {
    tools.push(orderBumpTool(getBridge));
  }
  if (bridge.discount) {
    tools.push(applyDiscountTool(getBridge), removeDiscountTool(getBridge));
  }
  if (bridge.contact?.fields.some((field) => field.fillable)) {
    tools.push(fillContactTool(getBridge));
  }
  if (bridge.submit) tools.push(submitTool(getBridge));
  return tools;
}

/**
 * Which tools `buildCheckoutAgentTools` would register — the registration
 * effect keys on this so a capability change re-registers, while ordinary
 * state changes (a typed character, a bump tick) do not.
 */
export function checkoutToolSignature(bridge: CheckoutAgentBridge): string {
  return [
    bridge.surface,
    bridge.selectPlan && bridge.plans.length > 1 ? "plans" : "",
    bridge.setBumpSelected && bridge.bumps.length ? "bumps" : "",
    bridge.discount ? "discount" : "",
    bridge.contact?.fields.some((field) => field.fillable) ? "contact" : "",
    bridge.submit ? "submit" : "",
  ].join("|");
}
