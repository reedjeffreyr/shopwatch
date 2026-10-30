// PLATFORM-MANAGED: WhopPayments — Model B composition primitives.
// Arrange Email / Card / Address / Payment / your summary / your bump / your
// pay button however the page needs. This file does NOT lock a two-step
// ClickFunnels layout — that is one valid composition, not the only one.
//
// Usage (plan IDs ALWAYS from import.meta.env.VITE_PLAN_*):
//   <WhopPayments planId={import.meta.env.VITE_PLAN_PRO}>
//     <WhopHostEmailInput />
//     <WhopHostGivenNameInput />
//     <WhopHostFamilyNameInput />
//     <YourOrderSummary />
//     <WhopPaymentElement />
//     <WhopPayButton>Complete order</WhopPayButton>
//   </WhopPayments>
//
// WhopPaymentElement is the DEFAULT payment surface: Whop fills its method
// list (cards, Apple Pay / Google Pay, PayPal, Cash App, iDEAL / Bancontact /
// SEPA / ACH, crypto, approved BNPL) from the creator's account, the plan's
// currency, and the buyer's location — no app code per method. Only on an
// explicit card-only ask swap it for the compact card form:
//     <WhopCardElement layout="compact" />
//     <WhopAddressElement scope="minimal" name="none" />
//
// Host-owned email/name ARE the identity fields. WhopEmailElement is a
// compatibility name for WhopHostEmailInput. AddressElement renders host
// name controls for name="split"|"combined" and keeps name out of its frame.
//
// Host-owned name seeds from the checkout URL or the opt-in session
// when already known (`useHostOwnedBillingPrefill` / empty-input seed
// on first paint). Host-owned email seeds from the same-tab opt-in
// session only — never from a shareable `?email=` / hash (confirm
// sends that as buyer.email). No known person → blank form. Never
// write defaultValues / update() into Card or Address iframes.
//
// Contract:
//   - One Payments handle for the page. Never two routes for one checkout —
//     hide/show views, keep this provider mounted.
//   - CardElement, CardFields, and PaymentElement are mutually exclusive.
//     Mount one. Destroy it before mounting another. AddressElement is NOT
//     a payment surface — it may sit beside Card. Mounting two exclusive
//     surfaces is a refusal (looks like a platform bug).
//   - Charge config is plan XOR inline amount, never both (amber
//     PLAN_INLINE_CONFLICT). A bump-capable checkout primes inline with the
//     catalog SUBTOTAL (identity.amountCents + currency) and restyles via
//     payments.update({ amount, currency }) only — never a second plan_id,
//     and never unset plan without both inline fields (amber
//     CHARGE_CONFIG_MISSING). Missing mint amount/currency refuses the
//     mount; do not fall back to plan. A no-bump checkout passes plan
//     only. Never a fully-discounted $0 inline amount — Whop then offers
//     no payment methods.
//   - Pay: createConfirmationToken({ billingDetails }) on the SAME Payments
//     handle that mounted the card/payment iframe (js.whop.cloud). Never
//     postMessage to js.basistheory.com ourselves — amber tokenizes from
//     the mounted iframe. Never tokenize with no arguments or with
//     address-only billingDetails. Cards need email, name, and the mounted
//     AddressElement floor (minimal: country + postal; full: also line1).
//     Do not call tokenize, and do not POST confirm,
//     if those fields are missing or tokenize fails. Host-owned name/email
//     stay in our inputs; we pass them as billingDetails and do not write
//     them into Whop frames.
//   - After confirm: a paid status, or a no-3DS pending capture
//     (paymentId + pending + no client_secret), is success. Redirect
//     to the server redirectUrl when present, otherwise
//     /checkout/complete (claim+login). A paymentId is not settlement
//     — Whop mints pay_* on CVC decline (open/incomplete). Never show
//     "We couldn't complete checkout" after a successful charge.
//     handleNextAction paid statuses succeed too. An unrecognized
//     next-action still consults confirmStatus (paid confirm leaves;
//     open/failed stays). If handleNextAction returns processing with
//     no last_payment_error, wait a bounded time for settlement —
//     prefer a real last_payment_error over generic. Do not tokenize
//     or confirm again.
//   - After a decline (failed / declined / requires_confirmation +
//     last_payment_error), remint the checkout intent before the next
//     Pay. Worker confirm is idempotent on intent+plan, so reusing the
//     dead pay_* is a no-op. Never remint a paid primary. Never remint
//     processing/open with no last_payment_error — that charge may
//     still capture. Do not handleNextAction on an idempotent reuse of
//     a known-dead pay_* — remint first, then confirm the new intent
//     once (corrected CVC must not re-show the old CVC sentence).
//   - Show Whop's last_payment_error.message (or the mapped
//     decline_code copy). Generic "try again" only when Whop sent
//     nothing usable. Card/CVC copy sits next to the card block.
//     Ring the host card/payment container (Amber iframe). Do not
//     claim we can style the inner CVC input. Host email/name can
//     be marked invalid — never on a card decline.
//   - Promo: `promoCode` prop, `?promo=`, or the typed row. Apply
//     calls POST /api/whop/promo and only marks a code applied when
//     the Worker returns a discounted quote (promo_… id + money
//     fields). A bad code fails on the row — never "will be applied
//     at checkout" at full price. Confirm sends the quoted promo_…
//     id. Confirm promo_rejected / promo_not_applicable clears
//     applied + quote (full price) like guest checkout `failed`,
//     keeps the typed draft, and leaves the ?promo= seed ref so
//     Pay sends no promo_code until Apply. The Payments handle
//     stays at the catalog SUBTOTAL.
//   - PCI stays in Whop frames. Never read or POST card numbers.
//   - Whop branding (SW-225): Whop refuses payment from 2026-10-01 unless
//     its branding element ("Powered by Whop · Terms · Privacy") is VISIBLE
//     on the page, mounted on THIS Payments handle. The provider mounts it
//     under the form by default. <WhopBrandingElement /> only moves it —
//     never remove it, never hide or cover it (createConfirmationToken then
//     throws BRANDING_HIDDEN), and never create a second "branding"
//     element yourself (the handle refuses a second one).

import * as React from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import {
  loadWhopElements,
  buildWhopAppearance,
  detectWhopElementsLocale,
  paymentsChargeAmountUpdateFields,
  paymentsChargeCreateFields,
  resolvePaymentElementFields,
  resolvePaymentsChargeConfig,
  sanitizePaymentElementDefaultValues,
  usablePaymentsCurrency,
  type WhopBillingDetails,
  type WhopPaymentElementDefaultValues,
  type WhopPaymentElementFieldsOption,
  type WhopPaymentsElementHandle,
  type WhopPaymentsGroupHandle,
  type WhopPaymentsElementType,
} from "@/lib/whop-elements";
import {
  CheckoutUnavailableError,
  CheckoutSessionRateLimitError,
  captureCheckoutReceipt,
  confirmWhopPayment,
  mintCheckoutIdentity,
  rememberCheckoutReturnPath,
  stashDeferredWhopBumps,
  clearDeferredWhopBumps,
  deferredWhopBumpsChargeComplete,
  isPaidCheckoutStatus,
  resolvePaidCheckoutRedirect,
  buyerFacingCheckoutError,
  shouldRetireCheckoutIntent,
  shouldWaitForCheckoutSettlement,
  awaitCheckoutSettlement,
  checkoutHostInvalidSelector,
  isIdempotentDeadPaymentReuse,
  shouldRemintAfterUnpaidCheckout,
  isInFlightCheckoutSettlement,
  isDeadCheckoutPayment,
  GENERIC_CHECKOUT_PAY_ERROR,
  normalizeWhopPromoCode,
  quoteWhopPromo,
  formatWhopMoneyCents,
  readWhopCheckoutPromoFromUrl,
  type CheckoutIdentity,
  type WhopPromoQuote,
} from "@/lib/whop";
import {
  joinPrefillName,
  readHostOwnedBillingPrefill,
  type HostOwnedBillingPrefill,
} from "@/lib/host-owned-billing-prefill";

export {
  FUNNEL_LEAD_STORAGE_KEY,
  hasHostOwnedBillingPrefill,
  joinPrefillName,
  readHostOwnedBillingPrefill,
} from "@/lib/host-owned-billing-prefill";
export type { HostOwnedBillingPrefill } from "@/lib/host-owned-billing-prefill";

const GENERIC_PAY_ERROR = GENERIC_CHECKOUT_PAY_ERROR;
const GENERIC_LOAD_ERROR =
  "We couldn't load checkout. Please try again.";

function buyerSafeErrorCopy(error: unknown): string {
  if (error instanceof CheckoutUnavailableError) return error.message;
  if (error instanceof CheckoutSessionRateLimitError) {
    return "Checkout is busy right now — please try again in a moment.";
  }
  return buyerFacingCheckoutError(error).message;
}

function compactString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function addressFromElementPayload(
  payload: Record<string, unknown> | undefined
): NonNullable<WhopBillingDetails["address"]> | undefined {
  if (!payload) return undefined;
  const address = {
    country: compactString(payload.country),
    line1: compactString(payload.line1),
    line2: compactString(payload.line2),
    city: compactString(payload.city),
    state: compactString(payload.state),
    postal_code: compactString(payload.postal_code),
  };
  return Object.values(address).some(Boolean) ? address : undefined;
}

function nameFromAddressPayload(
  payload: Record<string, unknown> | undefined
): string | undefined {
  const combined = compactString(payload?.name);
  if (combined) return combined;
  const joined = [compactString(payload?.first_name), compactString(payload?.last_name)]
    .filter(Boolean)
    .join(" ")
    .trim();
  return joined || undefined;
}

// Only values registered by the platform-owned host inputs reach Whop.
// Generated page markup is presentation, not an identity source: scraping
// arbitrary email inputs made a `?email=` binding indistinguishable from a
// buyer edit. Email prefill enters through readHostOwnedBillingPrefill(),
// whose trust boundary is same-tab sessionStorage.
export function collectHostOwnedBillingDetails(
  prefill: HostOwnedBillingPrefill
): WhopBillingDetails {
  return compactBillingDetails({
    email: compactString(prefill.email),
    name:
      compactString(prefill.name) ||
      joinPrefillName(
        compactString(prefill.firstName),
        compactString(prefill.lastName)
      ),
  });
}

export function useHostOwnedBillingPrefill(): HostOwnedBillingPrefill {
  return React.useMemo(() => readHostOwnedBillingPrefill(), []);
}

type HostOwnedInputProps = Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "value" | "defaultValue"
>;
type HostBillingField = "email" | "firstName" | "lastName" | "name";
// Every host-owned identity field, in one list. The agent-tool fill seam
// (`hostBilling.fill`) and the presence projection both iterate THIS — a new
// host input that is not here is invisible to both rather than half-wired.
const HOST_BILLING_FIELDS: HostBillingField[] = [
  "email",
  "firstName",
  "lastName",
  "name",
];
// A platform-initiated value for one host input. `seq` is what makes a REPEAT
// of the same value still apply (the shopper may have edited it since).
interface HostFillRequest {
  value: string;
  seq: number;
}
// Public alias — platform surfaces that read or fill host identity (the WebMCP
// checkout tools) need the field names without importing an internal type.
export type WhopPaymentsHostBillingField = HostBillingField;
const HOST_OWNED_AUTOFILL_ANIMATION = "whop-host-autofill-start";
const HOST_OWNED_AUTOFILL_CSS = `
@keyframes ${HOST_OWNED_AUTOFILL_ANIMATION} { from {} to {} }
[data-whop-host-input]:autofill {
  animation-name: ${HOST_OWNED_AUTOFILL_ANIMATION};
  animation-duration: 1ms;
}
[data-whop-host-input]:-webkit-autofill {
  animation-name: ${HOST_OWNED_AUTOFILL_ANIMATION};
  animation-duration: 1ms;
}
`;

function isBrowserAutofilled(input: HTMLInputElement): boolean {
  for (const selector of [":autofill", ":-webkit-autofill"]) {
    try {
      if (input.matches(selector)) return true;
    } catch {
      // The browser does not implement this autofill selector.
    }
  }
  return false;
}

// A bar pinned to the bottom of the viewport, parented to <html> so no
// clipping ancestor (e.g. a Dialog scroll lock on <body>) can hide it.
function createBrandingBar(): HTMLDivElement | null {
  if (typeof document === "undefined") return null;
  const bar = document.createElement("div");
  bar.setAttribute("data-testid", "whop-branding-bar");
  Object.assign(bar.style, {
    position: "fixed",
    left: "0",
    right: "0",
    bottom: "0",
    zIndex: "2147483647",
    padding: "4px 8px",
    background: "rgba(255,255,255,0.97)",
    boxShadow: "0 -1px 4px rgba(0,0,0,0.12)",
  });
  document.documentElement.appendChild(bar);
  return bar;
}

function isBrandingHiddenError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  const message = (error as { message?: unknown }).message;
  return (
    code === "BRANDING_HIDDEN" ||
    (typeof message === "string" && message.includes("BRANDING_HIDDEN"))
  );
}

interface PlatformPaymentsContextValue {
  payments: WhopPaymentsGroupHandle | null;
  setComplete: (key: string, value: boolean) => void;
  registerElement: (key: string, handle: WhopPaymentsElementHandle | null) => void;
  exclusiveSurfaceConflict: (key: string) => string | null;
  rememberAddressScope: (scope: AddressElementScope) => void;
  // Reactive: lets WhopPaymentElement hide its internal billing block while a
  // WhopAddressElement is mounted in the same handle (and restore it after).
  addressElementMounted: boolean;
  rememberBillingFromChange: (
    event: { address?: Record<string, unknown>; clearAddress?: boolean }
  ) => void;
  rememberHostBilling: (field: HostBillingField, value: string) => void;
  readHostBilling: (field: HostBillingField) => string | undefined;
  hasExplicitHostNameInput: boolean;
  registerExplicitHostNameInput: (mounted: boolean) => void;
  // Which host inputs this page actually rendered. Nothing may be filled into
  // a field the shopper cannot see.
  registerHostInput: (field: HostBillingField, mounted: boolean) => void;
  hostFillRequests: Partial<Record<HostBillingField, HostFillRequest>>;
  registerBrandingSlot: (node: HTMLDivElement | null) => void;
}

const PlatformPaymentsContext = React.createContext<PlatformPaymentsContextValue | null>(null);

function usePlatformPayments(): PlatformPaymentsContextValue {
  const ctx = React.useContext(PlatformPaymentsContext);
  if (!ctx) {
    throw new Error("Whop platform inputs must be used inside <WhopPayments>");
  }
  return ctx;
}

// The platform owns initial identity. value/defaultValue are deliberately
// ignored so generated page code cannot turn a shareable URL into buyer.email.
// Buyer edits and real browser autofill flow into private component state.
// Arbitrary DOM mutations never become buyer identity at confirmation.
function HostOwnedTextInput({
  prefillValue,
  field,
  autoComplete,
  testId,
  compatibilityName = false,
  type,
  className,
  value: _ignoredValue,
  defaultValue: _ignoredDefaultValue,
  onChange,
  onInput,
  onFocus,
  onAnimationStart,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & {
  prefillValue: string | undefined;
  field: HostBillingField;
  autoComplete: string;
  testId: string;
  compatibilityName?: boolean;
}) {
  const {
    readHostBilling,
    registerExplicitHostNameInput,
    registerHostInput,
    hostFillRequests,
    rememberHostBilling,
  } = usePlatformPayments();
  const [inputValue, setInputValue] = React.useState(
    () => readHostBilling(field) ?? prefillValue ?? ""
  );
  const initialValueRef = React.useRef(inputValue);
  const acceptSignaledValue = React.useCallback(
    (input: HTMLInputElement, isTrusted: boolean) => {
      if (!isTrusted && !isBrowserAutofilled(input)) return;
      setInputValue(input.value);
      rememberHostBilling(field, input.value);
    },
    [field, rememberHostBilling]
  );
  React.useEffect(() => {
    const initialValue = compactString(initialValueRef.current);
    if (initialValue) rememberHostBilling(field, initialValue);
  }, [field, rememberHostBilling]);
  React.useEffect(() => {
    if (field === "email" || compatibilityName) return;
    registerExplicitHostNameInput(true);
    return () => registerExplicitHostNameInput(false);
  }, [compatibilityName, field, registerExplicitHostNameInput]);
  React.useEffect(() => {
    registerHostInput(field, true);
    return () => registerHostInput(field, false);
  }, [field, registerHostInput]);
  // PLATFORM-INITIATED FILL. The untrusted-event guard above deliberately
  // refuses a synthetic `input` event, because generated page markup is
  // presentation and must never become buyer identity. This effect is the ONE
  // sanctioned way past it: the value arrives through the platform's own
  // `hostBilling.fill` seam (used by the WebMCP contact tool), which the
  // shopper's agent drives on their behalf and which is visible in the field
  // they can still edit. A DOM mutation still becomes nothing.
  const fillRequest = hostFillRequests[field];
  const appliedFillSeqRef = React.useRef(0);
  React.useEffect(() => {
    if (!fillRequest || fillRequest.seq === appliedFillSeqRef.current) return;
    appliedFillSeqRef.current = fillRequest.seq;
    setInputValue(fillRequest.value);
    rememberHostBilling(field, fillRequest.value);
  }, [fillRequest, field, rememberHostBilling]);
  return (
    <input
      {...props}
      type={type}
      autoComplete={autoComplete}
      className={className}
      data-testid={testId}
      data-whop-host-input=""
      value={inputValue}
      onChange={(event) => {
        acceptSignaledValue(event.currentTarget, event.nativeEvent.isTrusted);
        onChange?.(event);
      }}
      onInput={(event) => {
        acceptSignaledValue(event.currentTarget, event.nativeEvent.isTrusted);
        onInput?.(event);
      }}
      onFocus={(event) => {
        if (isBrowserAutofilled(event.currentTarget)) {
          acceptSignaledValue(event.currentTarget, event.nativeEvent.isTrusted);
        }
        onFocus?.(event);
      }}
      onAnimationStart={(event) => {
        if (
          event.animationName === HOST_OWNED_AUTOFILL_ANIMATION &&
          isBrowserAutofilled(event.currentTarget)
        ) {
          acceptSignaledValue(event.currentTarget, event.nativeEvent.isTrusted);
        }
        onAnimationStart?.(event);
      }}
    />
  );
}

export function WhopHostEmailInput(props: HostOwnedInputProps) {
  const prefill = useHostOwnedBillingPrefill();
  return (
    <HostOwnedTextInput
      {...props}
      field="email"
      type={props.type || "email"}
      autoComplete="email"
      testId="whop-host-email"
      prefillValue={prefill.email}
    />
  );
}

export function WhopHostGivenNameInput(props: HostOwnedInputProps) {
  const prefill = useHostOwnedBillingPrefill();
  return (
    <HostOwnedTextInput
      {...props}
      field="firstName"
      type={props.type || "text"}
      autoComplete="given-name"
      testId="whop-host-given-name"
      prefillValue={prefill.firstName}
    />
  );
}

export function WhopHostFamilyNameInput(props: HostOwnedInputProps) {
  const prefill = useHostOwnedBillingPrefill();
  return (
    <HostOwnedTextInput
      {...props}
      field="lastName"
      type={props.type || "text"}
      autoComplete="family-name"
      testId="whop-host-family-name"
      prefillValue={prefill.lastName}
    />
  );
}

export function WhopHostNameInput(props: HostOwnedInputProps) {
  const prefill = useHostOwnedBillingPrefill();
  return (
    <HostOwnedTextInput
      {...props}
      field="name"
      type={props.type || "text"}
      autoComplete="name"
      testId="whop-host-name"
      prefillValue={prefill.name}
    />
  );
}

// Omit empty email / name / address. createConfirmationToken treats an
// explicit empty name or address as an override of PaymentElement's
// internal billing block (and of EmailElement's mounted email).
export function compactBillingDetails(
  details: WhopBillingDetails
): WhopBillingDetails {
  const next: WhopBillingDetails = {};
  if (details.email) next.email = details.email;
  if (details.name) next.name = details.name;
  if (details.address && Object.values(details.address).some(Boolean)) {
    next.address = details.address;
  }
  return next;
}

// CardElement / CardFields / PaymentElement — one handle, one of these.
// Address / Email / TaxId are not in this set.
export const EXCLUSIVE_PAYMENT_SURFACES = ["card", "cardFields", "payment"] as const;

export function exclusivePaymentSurfaceConflict(
  mounted: Iterable<string>,
  next: string
): string | null {
  if (!(EXCLUSIVE_PAYMENT_SURFACES as readonly string[]).includes(next)) return null;
  for (const key of mounted) {
    if (
      key !== next &&
      (EXCLUSIVE_PAYMENT_SURFACES as readonly string[]).includes(key)
    ) {
      return key;
    }
  }
  return null;
}

export type TokenizeSurface = "card" | "payment" | "none";

export function tokenizeSurfaceForHandles(handles: {
  card?: unknown;
  payment?: unknown;
}): TokenizeSurface {
  if (handles.payment) return "payment";
  if (handles.card) return "card";
  return "none";
}

export type AddressElementScope = "full" | "minimal" | "none";

// Amber createConfirmationToken (verified 2026-08-31 host runtime): email
// is always required. Cards need name plus the mounted AddressElement's
// floor — AddressElement docs: name + country + postal (AVS). Overview's
// "line1 + country" is the full-address shape. scope=minimal (digital-goods
// default) never collects line1; requiring it skips tokenize forever.
// Harbor Lane mounts scope=full, so Join still needs street. PaymentElement
// owns its billing block; requiring host address there would override it.
export function tokenizeBillingMissing(
  details: WhopBillingDetails,
  surface: TokenizeSurface,
  addressScope: AddressElementScope = "none"
): string[] {
  const missing: string[] = [];
  if (!compactString(details.email)) missing.push("email");
  if (surface === "card") {
    if (!compactString(details.name)) missing.push("name");
    if (!compactString(details.address?.country)) missing.push("address.country");
    if (!compactString(details.address?.postal_code)) missing.push("address.postal_code");
    if (addressScope === "full" && !compactString(details.address?.line1)) {
      missing.push("address.line1");
    }
  }
  return missing;
}

async function readFreshElementAddress(
  handle: WhopPaymentsElementHandle | null
): Promise<{
  complete: boolean;
  address?: NonNullable<WhopBillingDetails["address"]>;
  name?: string;
} | null> {
  if (!handle) return null;
  if (handle.validate) {
    try {
      const result = await handle.validate();
      const payload = result?.address as Record<string, unknown> | undefined;
      return {
        complete: !!result?.complete,
        address: addressFromElementPayload(payload),
        name: nameFromAddressPayload(payload),
      };
    } catch {
      // try getValues
    }
  }
  if (handle.getValues) {
    try {
      const values = await handle.getValues();
      const payload = values?.address as Record<string, unknown> | undefined;
      const address = addressFromElementPayload(payload);
      return {
        // getValues has no completeness flag. A present address object
        // can be country-only; treating that as complete forwarded a
        // partial override of PaymentElement's internal billing.
        complete: false,
        address,
        name: nameFromAddressPayload(payload),
      };
    } catch {
      return null;
    }
  }
  return null;
}

export async function collectBillingDetailsForToken(args: {
  host: HostOwnedBillingPrefill;
  snapshots: WhopBillingDetails;
  addressHandle: WhopPaymentsElementHandle | null;
  paymentHandle?: WhopPaymentsElementHandle | null;
}): Promise<WhopBillingDetails> {
  const host = collectHostOwnedBillingDetails(args.host);
  let address: WhopBillingDetails["address"];
  // PaymentElement: never seed name from the snapshot. Incomplete
  // onAddressChange used to clear address and leave name, and confirm
  // then forwarded that leftover as a tokenize override.
  let name = args.paymentHandle ? undefined : args.snapshots.name;

  // AddressElement: a live getValues/validate is the address truth.
  if (args.addressHandle) {
    const fresh = await readFreshElementAddress(args.addressHandle);
    if (fresh?.address) {
      address = fresh.address;
      name = fresh.name || name;
    } else {
      address = args.snapshots.address;
    }
  } else if (args.paymentHandle) {
    // PaymentElement owns its billing block. An explicit address or name
    // overrides that block, so only pass a FRESH complete read — never the
    // debounced onAddressChange snapshot (stale across the ~300ms window,
    // and kept after an incomplete edit we previously ignored). getValues
    // alone cannot prove completeness.
    const fresh = await readFreshElementAddress(args.paymentHandle);
    if (fresh?.complete && fresh.address) {
      address = fresh.address;
      name = fresh.name;
    }
  } else {
    address = args.snapshots.address;
  }

  return compactBillingDetails({
    email: host.email,
    name: host.name || name,
    address,
  });
}

export interface WhopPaymentsProps {
  planId: string;
  bumpPlanIds?: string[];
  /** Dashboard word code (`FOUNDING50`) or `promo_…` id. Also reads `?promo=`. */
  promoCode?: string;
  /**
   * Optional payment-method allow/deny config. Honoured ONLY on a
   * bump-capable (inline {currency, amount}) checkout: a plan carries its
   * own method configuration, and Amber treats this beside `plan` as a
   * charge-config conflict, so the plan shape never forwards it.
   */
  paymentMethodConfiguration?: {
    enabled?: string[];
    disabled?: string[];
    include_platform_defaults?: boolean;
  };
  theme?: "light" | "dark" | "system";
  className?: string;
  children?: React.ReactNode;
  onReady?: () => void;
  onError?: (error: { message: string }) => void;
}

type SurfaceState = "loading" | "ready" | "error";

interface PaymentsContextValue {
  identity: CheckoutIdentity | null;
  planId: string;
  bumpPlanIds: string[];
  selectedBumpIds: string[];
  setBumpSelected: (planId: string, selected: boolean, amountCents?: number) => void;
  complete: Record<string, boolean>;
  updateAmount: (amountMinorUnits: number) => void;
  confirm: () => Promise<void>;
  confirming: boolean;
  errorMessage: string | null;
  errorSurface: string | null;
  // The promo row's own state and actions. Exposed so a platform surface (the
  // WebMCP checkout tools) can read and drive the SAME row the shopper sees
  // rather than synthesising events at its markup.
  promo: {
    draft: string;
    applied: string | null;
    quote: WhopPromoQuote | null;
    busy: boolean;
    notice: string | null;
    apply: (code?: string) => Promise<WhopPromoQuote | null>;
    clear: () => void;
  };
  // Host-owned identity, projected WITHOUT the values. `present` answers "is
  // there something in this field"; the value itself never leaves the
  // component. `fill` is the one sanctioned programmatic write.
  hostBilling: {
    mounted: (field: HostBillingField) => boolean;
    present: (field: HostBillingField) => boolean;
    fill: (values: Partial<Record<HostBillingField, string>>) => {
      filled: HostBillingField[];
      unavailable: HostBillingField[];
    };
  };
}

const PaymentsContext = React.createContext<PaymentsContextValue | null>(null);

export function useWhopPayments(): PaymentsContextValue {
  const ctx = React.useContext(PaymentsContext);
  if (!ctx) {
    throw new Error("useWhopPayments must be used inside <WhopPayments>");
  }
  return ctx;
}

// Same handle, but null instead of a throw when there is no <WhopPayments>
// above. A platform component that also has to work beside the hosted Model A
// checkout (which has no composition to read) needs to ASK rather than crash.
export function useOptionalWhopPayments(): PaymentsContextValue | null {
  return React.useContext(PaymentsContext);
}

// Resolve the app's RENDERED theme, not just the prop: generated apps toggle
// dark via a .dark class on <html>, which prefers-color-scheme never sees —
// that mismatch is how dark apps got white payment fields. Then forward the
// app's own tokens (accent, gray family, radius) so the bigger PaymentElement
// surface reads as the app; buildWhopAppearance fails soft per token.
function resolveThemeAppearance(theme: "light" | "dark" | "system") {
  const root = typeof document !== "undefined" ? document.documentElement : null;
  const resolved: "light" | "dark" =
    theme === "system"
      ? root?.classList.contains("dark") ||
        window.matchMedia?.("(prefers-color-scheme: dark)")?.matches
        ? "dark"
        : "light"
      : theme;
  if (!root || typeof window === "undefined" || !window.getComputedStyle) {
    return { theme: { appearance: resolved } };
  }
  const styles = window.getComputedStyle(root);
  return buildWhopAppearance(resolved, {
    primary: styles.getPropertyValue("--primary"),
    neutral: styles.getPropertyValue("--muted"),
    radius: styles.getPropertyValue("--radius"),
    rootFontSizePx: Number.parseFloat(styles.fontSize),
  });
}

export function WhopPayments({
  planId,
  bumpPlanIds = [],
  promoCode,
  paymentMethodConfiguration,
  theme = "system",
  className,
  children,
  onReady,
  onError,
}: WhopPaymentsProps) {
  const [state, setState] = React.useState<SurfaceState>("loading");
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [errorSurface, setErrorSurface] = React.useState<string | null>(null);
  const [identity, setIdentity] = React.useState<CheckoutIdentity | null>(null);
  const [confirming, setConfirming] = React.useState(false);
  const [selectedBumpIds, setSelectedBumpIds] = React.useState<string[]>([]);
  const [complete, setCompleteState] = React.useState<Record<string, boolean>>({});
  const [explicitHostNameInputCount, setExplicitHostNameInputCount] = React.useState(0);
  const [hostInputMounts, setHostInputMounts] = React.useState<
    Partial<Record<HostBillingField, number>>
  >({});
  const [hostFillRequests, setHostFillRequests] = React.useState<
    Partial<Record<HostBillingField, HostFillRequest>>
  >({});
  const hostFillSeqRef = React.useRef(0);
  // Whop branding (SW-225): one element on THIS handle, mounted into the
  // page's <WhopBrandingElement /> slot when present, else the default slot.
  const [brandingSlot, setBrandingSlot] = React.useState<HTMLDivElement | null>(null);
  const [defaultBrandingSlot, setDefaultBrandingSlot] =
    React.useState<HTMLDivElement | null>(null);
  const brandingTargetRef = React.useRef<HTMLDivElement | null>(null);
  const brandingElementRef = React.useRef<WhopPaymentsElementHandle | null>(null);
  // Last-resort home for the branding: a bar pinned to the viewport (see
  // confirm). Removed with the provider.
  const [brandingBar, setBrandingBar] = React.useState<HTMLDivElement | null>(null);
  const brandingBarRef = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    return () => {
      brandingBar?.remove();
      if (brandingBarRef.current === brandingBar) brandingBarRef.current = null;
    };
  }, [brandingBar]);
  // Bumped once per Payments handle, so a new checkout identity (e.g. the
  // remint after a decline) does not tear down a branding frame that is
  // already visible — a fresh frame is invisible until it loads.
  const [paymentsGeneration, setPaymentsGeneration] = React.useState(0);
  // Bumped after an unbranded fallback payment so the branding comes back
  // for the next attempt.
  const [brandingRemount, setBrandingRemount] = React.useState(0);
  const paymentsRef = React.useRef<WhopPaymentsGroupHandle | null>(null);
  const chargeCurrencyRef = React.useRef<string | null>(null);
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const elementHandlesRef = React.useRef<Partial<Record<string, WhopPaymentsElementHandle>>>({});
  const billingSnapshotRef = React.useRef<WhopBillingDetails>({});
  const hostBillingRef = React.useRef<HostOwnedBillingPrefill>({});
  const addressScopeRef = React.useRef<AddressElementScope>("none");
  const lastDeadPaymentIdRef = React.useRef<string | null>(null);
  const seededPromo = React.useMemo(
    () => normalizeWhopPromoCode(promoCode) || readWhopCheckoutPromoFromUrl(),
    [promoCode]
  );
  const [promoDraft, setPromoDraft] = React.useState(seededPromo || "");
  const [promoApplied, setPromoApplied] = React.useState<string | null>(null);
  const [promoQuote, setPromoQuote] = React.useState<WhopPromoQuote | null>(null);
  const [promoNotice, setPromoNotice] = React.useState<string | null>(null);
  const [promoBusy, setPromoBusy] = React.useState(false);
  const seededQuoteRef = React.useRef<string | null>(null);
  const promoDraftRef = React.useRef(promoDraft);
  promoDraftRef.current = promoDraft;
  // Confirm-level refusal of this draft. Pay must not requote it
  // or resend its promo_… id until the buyer clicks Apply.
  const promoRefusedDraftRef = React.useRef<string | null>(null);
  const onReadyRef = React.useRef(onReady);
  const onErrorRef = React.useRef(onError);
  React.useEffect(() => {
    onReadyRef.current = onReady;
    onErrorRef.current = onError;
  });

  const setComplete = React.useCallback((key: string, value: boolean) => {
    setCompleteState((prev) => (prev[key] === value ? prev : { ...prev, [key]: value }));
  }, []);

  const exclusiveSurfaceConflict = React.useCallback((key: string) => {
    return exclusivePaymentSurfaceConflict(Object.keys(elementHandlesRef.current), key);
  }, []);

  const [addressElementMounted, setAddressElementMounted] = React.useState(false);

  const rememberAddressScope = React.useCallback((scope: AddressElementScope) => {
    addressScopeRef.current = scope;
    setAddressElementMounted(scope !== "none");
  }, []);

  const registerElement = React.useCallback(
    (key: string, handle: WhopPaymentsElementHandle | null) => {
      if (handle) {
        const conflict = exclusivePaymentSurfaceConflict(
          Object.keys(elementHandlesRef.current),
          key
        );
        if (conflict) {
          console.error(
            "[WhopPayments] exclusive payment surfaces: cannot mount " +
              key +
              " while " +
              conflict +
              " is mounted"
          );
          return;
        }
        elementHandlesRef.current[key] = handle;
      } else {
        delete elementHandlesRef.current[key];
      }
    },
    []
  );

  const rememberBillingFromChange = React.useCallback(
    (
      event: { address?: Record<string, unknown>; clearAddress?: boolean }
    ) => {
      if (event.clearAddress) {
        billingSnapshotRef.current = {
          ...billingSnapshotRef.current,
          address: undefined,
          name: undefined,
        };
        return;
      }
      if (event.address) {
        billingSnapshotRef.current = {
          ...billingSnapshotRef.current,
          address: addressFromElementPayload(event.address) || billingSnapshotRef.current.address,
          name:
            nameFromAddressPayload(event.address) || billingSnapshotRef.current.name,
        };
      }
    },
    []
  );

  const rememberHostBilling = React.useCallback(
    (field: HostBillingField, value: string) => {
      const next = { ...hostBillingRef.current };
      const compact = compactString(value);
      next[field] = compact;
      if (field === "firstName" || field === "lastName") {
        next.name = joinPrefillName(next.firstName, next.lastName);
      }
      hostBillingRef.current = next;
    },
    []
  );

  const readHostBilling = React.useCallback((field: HostBillingField) => {
    return compactString(hostBillingRef.current[field]);
  }, []);

  const registerExplicitHostNameInput = React.useCallback((mounted: boolean) => {
    setExplicitHostNameInputCount((count) => Math.max(0, count + (mounted ? 1 : -1)));
  }, []);

  const registerHostInput = React.useCallback(
    (field: HostBillingField, mounted: boolean) => {
      setHostInputMounts((prev) => {
        const next = Math.max(0, (prev[field] || 0) + (mounted ? 1 : -1));
        if ((prev[field] || 0) === next) return prev;
        return { ...prev, [field]: next };
      });
    },
    []
  );

  // Platform-owned programmatic fill — the ONE way a value the shopper did not
  // type becomes checkout identity (see the guard in HostOwnedTextInput).
  // Refuses any field this page did not render: filling an invisible input
  // would bind an identity the shopper never sees and cannot correct.
  const fillHostBilling = React.useCallback(
    (values: Partial<Record<HostBillingField, string>>) => {
      const filled: HostBillingField[] = [];
      const unavailable: HostBillingField[] = [];
      const patch: Partial<Record<HostBillingField, HostFillRequest>> = {};
      for (const field of HOST_BILLING_FIELDS) {
        const raw = values[field];
        if (typeof raw !== "string") continue;
        const value = raw.trim();
        if (!value) continue;
        if (!hostInputMounts[field]) {
          unavailable.push(field);
          continue;
        }
        hostFillSeqRef.current += 1;
        patch[field] = { value, seq: hostFillSeqRef.current };
        filled.push(field);
        // Remember immediately as well as through the input: a confirm that
        // races the re-render must still see what was just supplied.
        rememberHostBilling(field, value);
      }
      if (filled.length) setHostFillRequests((prev) => ({ ...prev, ...patch }));
      return { filled, unavailable };
    },
    [hostInputMounts, rememberHostBilling]
  );

  const hostBillingMounted = React.useCallback(
    (field: HostBillingField) => Boolean(hostInputMounts[field]),
    [hostInputMounts]
  );

  const hostBillingPresent = React.useCallback(
    (field: HostBillingField) => Boolean(readHostBilling(field)),
    [readHostBilling]
  );

  React.useEffect(() => {
    const payments = paymentsRef.current;
    const target = brandingBar || brandingSlot || defaultBrandingSlot;
    if (!payments || !target) return;
    let element: WhopPaymentsElementHandle | null = null;
    try {
      element = payments.create("branding", {
        onError: (error: unknown) => {
          console.error("[WhopPayments] branding element error:", error);
        },
      });
      element.mount(target);
      brandingTargetRef.current = target;
      brandingElementRef.current = element;
    } catch (error) {
      console.error("[WhopPayments] mount branding failed:", error);
    }
    return () => {
      if (brandingTargetRef.current === target) brandingTargetRef.current = null;
      if (brandingElementRef.current === element) brandingElementRef.current = null;
      try {
        element?.destroy();
      } catch {
        // already gone
      }
    };
  }, [paymentsGeneration, brandingRemount, brandingBar, brandingSlot, defaultBrandingSlot]);

  React.useEffect(() => {
    if (!planId) {
      setState("error");
      setErrorMessage("This checkout isn't configured yet (missing plan).");
      return;
    }
    let cancelled = false;
    setState("loading");
    setErrorMessage(null);
    setErrorSurface(null);
    setSelectedBumpIds([]);

    Promise.all([loadWhopElements(), mintCheckoutIdentity(planId)])
      .then(([WhopElements, minted]) => {
        if (cancelled) return;
        if (
          !minted.metadata ||
          !minted.metadata.checkout_intent_token ||
          !minted.redirectUrl ||
          !minted.accountId
        ) {
          setState("error");
          setErrorMessage("Checkout is temporarily unavailable. Please try again shortly.");
          onErrorRef.current?.({ message: "checkout_identity_unavailable" });
          return;
        }

        const whop = WhopElements({
          // UI language only (page lang, then browser language, fallback en).
          // Which METHODS show is Whop's call — account, currency, location.
          locale: detectWhopElementsLocale(),
          appearance: resolveThemeAppearance(theme),
        });
        const createOptions: Record<string, unknown> = {
          accountId: minted.accountId,
          setupFutureUsage: "off_session",
          returnUrl: minted.redirectUrl,
          metadata: minted.metadata,
        };
        // Plan XOR inline amount. Bump allowlist → inline subtotal so a
        // later update({ amount, currency }) cannot Object.assign onto
        // plan. Missing inline pair refuses the mount (do not prime
        // plan — Northline CHARGE_CONFIG_MISSING). A $0 inline amount
        // offers no payment methods.
        const charge = resolvePaymentsChargeConfig({
          planId: minted.planId,
          amountCents: minted.amountCents,
          currency: minted.currency,
          usesInlineAmount: bumpPlanIds.length > 0,
        });
        const chargeFields = charge ? paymentsChargeCreateFields(charge) : null;
        if (!chargeFields) {
          setState("error");
          setErrorMessage("This checkout isn't configured yet. Please try again shortly.");
          onErrorRef.current?.({ message: "checkout_charge_config_unavailable" });
          return;
        }
        Object.assign(createOptions, chargeFields);
        // Inline shape only: a plan carries its own method configuration and
        // Amber refuses paymentMethodConfiguration beside `plan` (the same
        // charge-config conflict family as amount/currency). Create-time and
        // closure-read like bumpPlanIds — not an effect dep.
        if (charge?.mode === "inline" && paymentMethodConfiguration) {
          createOptions.paymentMethodConfiguration = paymentMethodConfiguration;
        }
        chargeCurrencyRef.current = usablePaymentsCurrency(minted.currency);
        const handle = whop.payments.create(createOptions);
        paymentsRef.current = handle;
        setPaymentsGeneration((n) => n + 1);
        setIdentity(minted);
        setState("ready");
        onReadyRef.current?.();
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        console.error("[WhopPayments] failed to load:", error);
        setState("error");
        setErrorMessage(
          error instanceof CheckoutUnavailableError ? error.message : GENERIC_LOAD_ERROR
        );
        onErrorRef.current?.({
          message: error instanceof Error ? error.message : "payments_load_failed",
        });
      });

    return () => {
      cancelled = true;
      try {
        paymentsRef.current?.destroy();
      } catch {
        // frame already gone
      }
      paymentsRef.current = null;
      chargeCurrencyRef.current = null;
    };
    // theme restyles live; remount only when the plan changes.
    // bumpPlanIds is create-time for the charge model (inline vs plan);
    // parents pass a fresh array literal, so it cannot be an effect dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planId]);

  React.useEffect(() => {
    if (!paymentsRef.current) return;
    try {
      paymentsRef.current.update({ appearance: resolveThemeAppearance(theme) });
    } catch {
      // cosmetic
    }
  }, [theme]);

  const updateAmount = React.useCallback((amountMinorUnits: number) => {
    if (!paymentsRef.current) return;
    const fields = paymentsChargeAmountUpdateFields({
      amountMinorUnits,
      currency: chargeCurrencyRef.current,
    });
    if (!fields) {
      console.error(
        "[WhopPayments] update amount skipped: incomplete inline charge config"
      );
      return;
    }
    try {
      paymentsRef.current.update(fields);
    } catch (error) {
      console.error("[WhopPayments] update amount failed:", error);
    }
  }, []);

  // bumpPlanIds is the allowlist. Confirm bills only what setBumpSelected
  // marked selected — passing the prop alone must not charge an unchecked bump.
  const setBumpSelected = React.useCallback(
    (nextPlanId: string, selected: boolean, amountCents?: number) => {
      if (!bumpPlanIds.includes(nextPlanId)) return;
      setSelectedBumpIds((prev) => {
        const has = prev.includes(nextPlanId);
        if (selected && !has) return [...prev, nextPlanId];
        if (!selected && has) return prev.filter((id) => id !== nextPlanId);
        return prev;
      });
      if (typeof amountCents === "number") updateAmount(amountCents);
    },
    [bumpPlanIds, updateAmount]
  );

  const applyPromoCode = React.useCallback(
    async (raw?: string) => {
      const code = normalizeWhopPromoCode(raw ?? promoDraft);
      if (!code) {
        setPromoApplied(null);
        setPromoQuote(null);
        setPromoNotice("Enter a promo code.");
        setErrorSurface("promo");
        setErrorMessage("Enter a promo code.");
        return null;
      }
      if (!planId) {
        setPromoApplied(null);
        setPromoQuote(null);
        setPromoNotice("This checkout isn't configured yet (missing plan).");
        setErrorSurface("promo");
        setErrorMessage("This checkout isn't configured yet (missing plan).");
        return null;
      }
      setPromoBusy(true);
      setPromoNotice(null);
      if (errorSurface === "promo") {
        setErrorMessage(null);
        setErrorSurface(null);
      }
      try {
        const quote = await quoteWhopPromo({ promoCode: code, planId });
        promoRefusedDraftRef.current = null;
        setPromoDraft(quote.code);
        setPromoApplied(quote.code);
        setPromoQuote(quote);
        setPromoNotice(null);
        return quote;
      } catch (error) {
        setPromoApplied(null);
        setPromoQuote(null);
        if (error instanceof Error && error.name === "CheckoutPromoError") {
          setPromoNotice(error.message);
          setErrorSurface("promo");
          setErrorMessage(error.message);
          return null;
        }
        if (error instanceof CheckoutSessionRateLimitError) {
          const message = "Checkout is busy right now — please try again in a moment.";
          setPromoNotice(message);
          setErrorSurface("promo");
          setErrorMessage(message);
          return null;
        }
        const message = "We couldn't check that code. Please try again.";
        setPromoNotice(message);
        setErrorSurface("promo");
        setErrorMessage(message);
        return null;
      } finally {
        setPromoBusy(false);
      }
    },
    [promoDraft, planId, errorSurface]
  );

  const applyPromo = React.useCallback(() => {
    return applyPromoCode();
  }, [applyPromoCode]);

  React.useEffect(() => {
    if (!identity || !seededPromo) return;
    if (seededQuoteRef.current === seededPromo) return;
    seededQuoteRef.current = seededPromo;
    void applyPromoCode(seededPromo);
  }, [identity, seededPromo, applyPromoCode]);

  const clearPromo = React.useCallback(() => {
    setPromoDraft("");
    setPromoApplied(null);
    setPromoQuote(null);
    setPromoNotice(null);
    promoRefusedDraftRef.current = null;
    seededQuoteRef.current = null;
    if (errorSurface === "promo") {
      setErrorMessage(null);
      setErrorSurface(null);
    }
  }, [errorSurface]);

  const setPayError = React.useCallback((input: unknown) => {
    if (input instanceof Error && input.name === "CheckoutPromoError") {
      const promoError = (input as Error & { promoError?: string }).promoError;
      // Confirm promo_rejected / promo_not_applicable: like guest
      // checkout `failed`, clear applied + quote (full price) and
      // keep the typed draft so the buyer can edit. Do not null
      // seededQuoteRef — Remove does that, and the seed effect
      // would re-apply ?promo= and wipe this error. Pay then
      // skips unmatched-draft requote for this refused word.
      if (promoError === "promo_rejected" || promoError === "promo_not_applicable") {
        setPromoApplied(null);
        setPromoQuote(null);
        const refused = normalizeWhopPromoCode(promoDraftRef.current);
        if (refused) promoRefusedDraftRef.current = refused;
      }
      setErrorMessage(input.message);
      setErrorSurface("promo");
      setPromoNotice(input.message);
      return { message: input.message, surface: "promo" };
    }
    if (input instanceof CheckoutUnavailableError) {
      setErrorMessage(input.message);
      setErrorSurface("generic");
      return { message: input.message, surface: "generic" };
    }
    if (input instanceof CheckoutSessionRateLimitError) {
      const message = "Checkout is busy right now — please try again in a moment.";
      setErrorMessage(message);
      setErrorSurface("generic");
      return { message, surface: "generic" };
    }
    const faced = buyerFacingCheckoutError(input);
    setErrorMessage(faced.message);
    setErrorSurface(faced.surface);
    return faced;
  }, []);

  // Worker confirm keys idempotency on intent+plan. After a declined
  // pay_* the next ctok_ is a no-op unless we mint a new intent.
  // Remint only a dead payment — never a pending/open live pay_*.
  const retireDeadCheckoutIntent = React.useCallback(async () => {
    try {
      const next = await mintCheckoutIdentity(planId);
      if (
        next.metadata &&
        next.metadata.checkout_intent_token &&
        next.redirectUrl &&
        next.accountId
      ) {
        setIdentity(next);
        return next;
      }
    } catch (error) {
      console.error("[WhopPayments] remint after decline failed:", error);
    }
    return null;
  }, [planId]);

  React.useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    root.querySelectorAll("[data-whop-host-invalid]").forEach((el) => {
      el.removeAttribute("data-whop-host-invalid");
      el.removeAttribute("aria-invalid");
      if (el instanceof HTMLElement) {
        el.classList.remove("border-destructive", "ring-2", "ring-destructive");
      }
    });
    const selector = checkoutHostInvalidSelector(errorSurface);
    if (!selector) return;
    const host = root.querySelector<HTMLElement>(selector);
    if (!host) return;
    host.setAttribute("data-whop-host-invalid", "");
    host.setAttribute("aria-invalid", "true");
    host.classList.add("border-destructive");
    // CVC lives inside Amber's iframe. Ring the host payment container
    // only — do not highlight email/name on a card decline.
    if (errorSurface === "card") {
      host.classList.add("ring-2", "ring-destructive");
    }
  }, [errorSurface, errorMessage]);

  const confirm = React.useCallback(async () => {
    const payments = paymentsRef.current;
    let minted = identity;
    let checkoutIntentToken =
      minted.checkoutIntentToken || minted.metadata?.checkout_intent_token;
    if (!payments || !minted || !checkoutIntentToken) {
      throw new Error("payments_not_ready");
    }
    setConfirming(true);
    setErrorMessage(null);
    setErrorSurface(null);
    try {
      const draftCode = normalizeWhopPromoCode(promoDraft);
      let quoted = promoQuote;
      if (draftCode) {
        const quotedMatches =
          quoted &&
          (quoted.code.toLowerCase() === draftCode.toLowerCase() ||
            quoted.promoCodeId === draftCode);
        const refusedDraft =
          promoRefusedDraftRef.current != null &&
          promoRefusedDraftRef.current.toLowerCase() === draftCode.toLowerCase();
        if (!quotedMatches) {
          // Confirm-level refusal: send no promo_code until Apply.
          // Requoting here would resend promo_founding and wipe
          // the row error.
          if (refusedDraft) {
            quoted = null;
          } else {
            quoted = await applyPromoCode(draftCode);
            if (!quoted) return;
          }
        }
      }
      const billingDetails = await collectBillingDetailsForToken({
        host: hostBillingRef.current,
        snapshots: billingSnapshotRef.current,
        addressHandle: elementHandlesRef.current.address || null,
        paymentHandle: elementHandlesRef.current.payment || null,
      });
      const surface = tokenizeSurfaceForHandles(elementHandlesRef.current);
      const missing = tokenizeBillingMissing(
        billingDetails,
        surface,
        addressScopeRef.current
      );
      if (missing.length) {
        console.error(
          "[WhopPayments] createConfirmationToken skipped: missing " +
            missing.join(", ")
        );
        setPayError({ missing });
        onErrorRef.current?.({ message: "create_confirmation_token_incomplete_billing" });
        return;
      }
      let token: { confirmationToken?: string };
      try {
        // Same Payments handle that mounted the card/payment iframe.
        // Amber collects from that js.whop.cloud frame — we never
        // postMessage js.basistheory.com from this file.
        try {
          token = await payments.createConfirmationToken({ billingDetails });
        } catch (error) {
          // Whop refuses while its branding is on the page but not
          // visible (still loading, scrolled out of a clipped box, or
          // covered — e.g. a Dialog's body scroll lock on a short page).
          // Bring it into view and retry; then pin it to the bottom of the
          // viewport and retry; only then remove it and pay as before
          // branding existed. Never refuse a payment Whop would accept.
          if (!isBrandingHiddenError(error)) throw error;
          brandingTargetRef.current?.scrollIntoView?.({ block: "nearest" });
          token = {};
          const retryWhileHidden = async (waits: number[], first: unknown) => {
            let last: unknown = first;
            for (const waitMs of waits) {
              await new Promise((resolve) => setTimeout(resolve, waitMs));
              try {
                token = await payments.createConfirmationToken({ billingDetails });
                return null;
              } catch (next) {
                if (!isBrandingHiddenError(next)) throw next;
                last = next;
              }
            }
            return last;
          };
          let retryError = await retryWhileHidden([250, 500, 750], error);
          if (retryError && !brandingBarRef.current) {
            const bar = createBrandingBar();
            if (bar) {
              brandingBarRef.current = bar;
              setBrandingBar(bar);
              retryError = await retryWhileHidden([600, 600, 800, 1000], retryError);
            }
          }
          if (retryError) {
            console.error("[WhopPayments] branding stayed hidden; paying without it:", retryError);
            try {
              brandingElementRef.current?.destroy();
            } catch {
              // already gone
            }
            brandingElementRef.current = null;
            try {
              token = await payments.createConfirmationToken({ billingDetails });
            } finally {
              setBrandingRemount((n) => n + 1);
            }
          }
        }
      } catch (error) {
        console.error("[WhopPayments] createConfirmationToken failed:", error);
        setPayError(error);
        onErrorRef.current?.({
          message: error instanceof Error ? error.message : "create_confirmation_token_failed",
        });
        return;
      }
      if (!token?.confirmationToken) {
        console.error(
          "[WhopPayments] createConfirmationToken failed: missing confirmationToken",
          token
        );
        setPayError(GENERIC_PAY_ERROR);
        onErrorRef.current?.({ message: "create_confirmation_token_failed" });
        return;
      }
      const promoCodeId = quoted?.promoCodeId;
      let confirmed = await confirmWhopPayment({
        confirmationToken: token.confirmationToken,
        planId: minted.planId,
        bumpPlanIds: selectedBumpIds,
        checkoutIntentToken,
        email: billingDetails.email,
        promoCode: promoCodeId,
      });
      // Idempotent reuse of a dead pay_* (Northline / joaMke 2026-09-02):
      // Worker returns the declined payment. handleNextAction would
      // re-read invalid_cvc and show the old CVC sentence on a
      // corrected code. Remint first, then confirm the new intent once.
      if (
        isIdempotentDeadPaymentReuse(confirmed, lastDeadPaymentIdRef.current)
      ) {
        const reminted = await retireDeadCheckoutIntent();
        const remintedToken =
          reminted?.checkoutIntentToken ||
          reminted?.metadata?.checkout_intent_token;
        if (reminted && remintedToken) {
          minted = reminted;
          checkoutIntentToken = remintedToken;
          confirmed = await confirmWhopPayment({
            confirmationToken: token.confirmationToken,
            planId: reminted.planId,
            bumpPlanIds: selectedBumpIds,
            checkoutIntentToken,
            email: billingDetails.email,
            promoCode: promoCodeId,
          });
        } else {
          clearDeferredWhopBumps();
          if (
            confirmed.paymentId &&
            isDeadCheckoutPayment({
              status: confirmed.status,
              lastPaymentError: confirmed.lastPaymentError,
              paymentId: confirmed.paymentId,
            })
          ) {
            lastDeadPaymentIdRef.current = confirmed.paymentId;
          }
          setPayError({
            status: confirmed.status,
            lastPaymentError: confirmed.lastPaymentError,
            message:
              confirmed.lastPaymentError && confirmed.lastPaymentError.message,
          });
          return;
        }
      }
      let nextActionStatus: string | null = null;
      let nextActionAttempted = false;
      let nextActionLastPaymentError: typeof confirmed.lastPaymentError = null;
      let settlementWaited = false;
      if (confirmed.clientSecret) {
        // An off-site step (3DS, iDEAL/Bancontact bank page, PayPal) may
        // navigate the whole tab away. Stash where the checkout lives so a
        // failed|canceled return can offer a real "back to checkout".
        rememberCheckoutReturnPath();
        // A full-page 3DS redirect returns before the follow-up confirm.
        // Stash first so /checkout/complete can charge the selected bumps.
        if (selectedBumpIds.length) {
          stashDeferredWhopBumps({
            checkoutIntentToken,
            planId: minted.planId,
            bumpPlanIds: selectedBumpIds,
          });
        }
        const next = await loadWhopElements();
        const result = await next().payments.handleNextAction({
          clientSecret: confirmed.clientSecret,
          // Server-owned identity only — never a browser-composed returnUrl
          // (independent review D5). In-page success without a minted
          // redirect uses fallbackPaidCheckoutPath after this returns.
          returnUrl: minted.redirectUrl || undefined,
        });
        if (result.redirected) {
          // Tab is leaving for the 3DS returnUrl. Stash the receipt so
          // /checkout/complete can claim even if the provider omits it.
          if (confirmed.paymentId) captureCheckoutReceipt(confirmed.paymentId);
          return;
        }
        nextActionAttempted = true;
        nextActionStatus = result.status || null;
        nextActionLastPaymentError = result.lastPaymentError || null;
        if (
          shouldWaitForCheckoutSettlement({
            confirmStatus: confirmed.status,
            nextActionStatus,
            lastPaymentError: nextActionLastPaymentError,
            nextActionAttempted,
          })
        ) {
          settlementWaited = true;
          const settled = await awaitCheckoutSettlement({
            initial: {
              status: nextActionStatus,
              lastPaymentError: nextActionLastPaymentError,
            },
            readStatus: async () => {
              const again = await next().payments.handleNextAction({
                clientSecret: confirmed.clientSecret as string,
                returnUrl: minted.redirectUrl || undefined,
              });
              return {
                status: again.status,
                lastPaymentError: again.lastPaymentError || null,
                redirected: !!again.redirected,
              };
            },
          });
          if (settled.redirected) {
            if (confirmed.paymentId) captureCheckoutReceipt(confirmed.paymentId);
            return;
          }
          nextActionStatus = settled.status || nextActionStatus;
          nextActionLastPaymentError =
            settled.lastPaymentError || nextActionLastPaymentError;
        }
        if (isPaidCheckoutStatus(nextActionStatus)) {
          if (selectedBumpIds.length) {
            confirmed = await confirmWhopPayment({
              planId: minted.planId,
              bumpPlanIds: selectedBumpIds,
              checkoutIntentToken,
            });
          }
          if (deferredWhopBumpsChargeComplete(confirmed)) {
            clearDeferredWhopBumps();
          }
        } else if (nextActionLastPaymentError) {
          clearDeferredWhopBumps();
          setPayError(nextActionLastPaymentError);
          onErrorRef.current?.({
            message:
              nextActionLastPaymentError.message || "payment_requires_action",
          });
          if (
            confirmed.paymentId &&
            isDeadCheckoutPayment({
              status: nextActionStatus || confirmed.status,
              lastPaymentError: nextActionLastPaymentError,
              paymentId: confirmed.paymentId,
            })
          ) {
            lastDeadPaymentIdRef.current = confirmed.paymentId;
          }
          if (
            shouldRemintAfterUnpaidCheckout({
              status: nextActionStatus || confirmed.status,
              lastPaymentError: nextActionLastPaymentError,
              paymentId: confirmed.paymentId,
              nextActionAttempted,
            })
          ) {
            await retireDeadCheckoutIntent();
          }
          return;
        }
        // Unrecognized next-action: do not return. A paid confirmStatus
        // must still reach resolvePaidCheckoutRedirect (Harbor Lane).
        // The helper refuses open/failed + paymentId (Northline).
      }
      if (confirmed.bumpError) {
        // Primary already charged. Surface telemetry, but do not show
        // checkout-failed or skip the paid redirect — leftover bumps
        // charge from /checkout/complete.
        onErrorRef.current?.({ message: confirmed.bumpError });
      }
      const assignPaidRedirect = (paidRedirect: { ok: true; url: string }) => {
        // Complete-page bump charge needs the stash AND status=success
        // (withPaidCheckoutQuery stamps the query on the server complete
        // URL). Stash any selected set that this tab did not finish —
        // the no-3DS path never stashed before handleNextAction.
        if (
          selectedBumpIds.length &&
          !deferredWhopBumpsChargeComplete(confirmed)
        ) {
          stashDeferredWhopBumps({
            checkoutIntentToken,
            planId: minted.planId,
            bumpPlanIds: selectedBumpIds,
          });
        }
        if (confirmed.paymentId) captureCheckoutReceipt(confirmed.paymentId);
        window.location.assign(paidRedirect.url);
      };

      let paidRedirect = resolvePaidCheckoutRedirect({
        paymentId: confirmed.paymentId,
        redirectUrl: minted.redirectUrl,
        confirmStatus: confirmed.status,
        nextActionStatus,
        nextActionAttempted,
        settlementWaited,
      });
      if (paidRedirect.ok) {
        assignPaidRedirect(paidRedirect);
        return;
      }

      // processing + no last_payment_error is not a terminal fail.
      // Follow-up confirm re-reads the live payment (Worker) so a
      // capture that landed during the wait (pay_gvbhkHc5xLkSWV)
      // still reaches /checkout/complete. Do not remint — that can
      // charge a second time while the first captures.
      if (
        isInFlightCheckoutSettlement({
          confirmStatus: confirmed.status,
          nextActionStatus,
          lastPaymentError: nextActionLastPaymentError,
          nextActionAttempted,
        })
      ) {
        try {
          // Status re-read only. Do not send selected bumps — token-less
          // confirm is the deferred-bump charge path and must not run
          // while the primary is still processing. Leftover bumps charge
          // on /checkout/complete after the paid redirect.
          confirmed = await confirmWhopPayment({
            planId: minted.planId,
            checkoutIntentToken,
          });
        } catch (error) {
          console.error("[WhopPayments] settlement follow-up confirm failed:", error);
        }
        paidRedirect = resolvePaidCheckoutRedirect({
          paymentId: confirmed.paymentId,
          redirectUrl: minted.redirectUrl,
          confirmStatus: confirmed.status,
          nextActionStatus,
          nextActionAttempted,
          settlementWaited,
        });
        if (paidRedirect.ok) {
          assignPaidRedirect(paidRedirect);
          return;
        }
        nextActionLastPaymentError =
          confirmed.lastPaymentError || nextActionLastPaymentError;
        if (
          isInFlightCheckoutSettlement({
            confirmStatus: confirmed.status,
            nextActionStatus,
            lastPaymentError: nextActionLastPaymentError,
            nextActionAttempted,
          })
        ) {
          // Still collecting. Do not show generic fail and do not remint.
          return;
        }
      }

      const lastPaymentError =
        nextActionLastPaymentError || confirmed.lastPaymentError;
      setPayError({
        status: nextActionStatus || confirmed.status,
        lastPaymentError,
        message: lastPaymentError && lastPaymentError.message,
      });
      if (
        confirmed.paymentId &&
        isDeadCheckoutPayment({
          status: nextActionStatus || confirmed.status,
          lastPaymentError,
          paymentId: confirmed.paymentId,
        })
      ) {
        lastDeadPaymentIdRef.current = confirmed.paymentId;
      }
      if (
        shouldRemintAfterUnpaidCheckout({
          status: nextActionStatus || confirmed.status,
          lastPaymentError,
          paymentId: confirmed.paymentId,
          nextActionAttempted,
        })
      ) {
        await retireDeadCheckoutIntent();
      }
    } catch (error) {
      console.error("[WhopPayments] confirm failed:", error);
      setPayError(error);
      onErrorRef.current?.({
        message: error instanceof Error ? error.message : "confirm_failed",
      });
      if (
        error instanceof Error &&
        error.name === "CheckoutPaymentError" &&
        shouldRetireCheckoutIntent({ lastPaymentError: error })
      ) {
        await retireDeadCheckoutIntent();
      }
    } finally {
      setConfirming(false);
    }
  }, [identity, selectedBumpIds, promoDraft, promoQuote, applyPromoCode, retireDeadCheckoutIntent, setPayError]);

  const ctx: PaymentsContextValue = {
    identity,
    planId,
    bumpPlanIds,
    selectedBumpIds,
    setBumpSelected,
    complete,
    updateAmount,
    confirm,
    confirming,
    errorMessage,
    errorSurface,
    promo: {
      draft: promoDraft,
      applied: promoApplied,
      quote: promoQuote,
      busy: promoBusy,
      notice: promoNotice,
      apply: applyPromoCode,
      clear: clearPromo,
    },
    hostBilling: {
      mounted: hostBillingMounted,
      present: hostBillingPresent,
      fill: fillHostBilling,
    },
  };
  const platformCtx: PlatformPaymentsContextValue = {
    payments: paymentsRef.current,
    setComplete,
    registerElement,
    exclusiveSurfaceConflict,
    rememberAddressScope,
    addressElementMounted,
    rememberBillingFromChange,
    readHostBilling,
    rememberHostBilling,
    hasExplicitHostNameInput: explicitHostNameInputCount > 0,
    registerExplicitHostNameInput,
    registerHostInput,
    hostFillRequests,
    registerBrandingSlot: setBrandingSlot,
  };

  return (
    <PlatformPaymentsContext.Provider value={platformCtx}>
      <PaymentsContext.Provider value={ctx}>
        <div ref={rootRef} className={className} data-testid="whop-payments">
          <style>{HOST_OWNED_AUTOFILL_CSS}</style>
          {state === "loading" ? (
            <div className="flex items-center justify-center gap-2 py-8 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
              <span className="text-sm">Loading secure checkout…</span>
            </div>
          ) : null}
          {state === "error" && !identity ? (
            <div className="flex flex-col items-center justify-center gap-3 py-8 text-center">
              <AlertCircle className="h-8 w-8 text-destructive" />
              <p className="text-sm text-muted-foreground">
                {errorMessage ?? GENERIC_LOAD_ERROR}
              </p>
            </div>
          ) : null}
          {state === "ready" || identity ? (
            <>
              {children}
              <div className="mt-4" data-testid="whop-promo-row">
                <label className="text-sm font-medium" htmlFor="whop-promo-code">
                  Promo code
                </label>
                <div className="mt-1 flex gap-2">
                  <input
                    id="whop-promo-code"
                    data-testid="whop-promo-input"
                    className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    value={promoDraft}
                    disabled={confirming || promoBusy}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => {
                      const next = event.target.value;
                      setPromoDraft(next);
                      setPromoNotice(null);
                      if (
                        promoApplied &&
                        normalizeWhopPromoCode(next) !== promoApplied
                      ) {
                        setPromoApplied(null);
                        setPromoQuote(null);
                      }
                      if (errorSurface === "promo") {
                        setErrorMessage(null);
                        setErrorSurface(null);
                      }
                    }}
                  />
                  {promoApplied ? (
                    <button
                      type="button"
                      className="shrink-0 text-sm underline"
                      data-testid="whop-promo-remove"
                      disabled={confirming || promoBusy}
                      onClick={clearPromo}
                    >
                      Remove
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="shrink-0 text-sm underline"
                      data-testid="whop-promo-apply"
                      disabled={confirming || promoBusy || !normalizeWhopPromoCode(promoDraft)}
                      onClick={applyPromo}
                    >
                      {promoBusy ? "Checking…" : "Apply"}
                    </button>
                  )}
                </div>
                {promoQuote && promoApplied && !promoNotice ? (
                  <div className="mt-2 text-sm" data-testid="whop-promo-quote">
                    <p data-testid="whop-promo-applied">{promoQuote.code} applied.</p>
                    <p className="text-muted-foreground">
                      {promoQuote.discountLabel}: −
                      {formatWhopMoneyCents(promoQuote.discountCents)}
                    </p>
                    <p>
                      Due today: {formatWhopMoneyCents(promoQuote.totalCents)}
                      <span className="ml-2 text-muted-foreground line-through">
                        {formatWhopMoneyCents(promoQuote.subtotalCents)}
                      </span>
                    </p>
                    {promoQuote.durationNote ? (
                      <p className="text-muted-foreground">{promoQuote.durationNote}</p>
                    ) : null}
                  </div>
                ) : null}
                {promoNotice ? (
                  <p
                    className="mt-2 text-sm text-destructive"
                    role="alert"
                    data-testid="whop-promo-error"
                  >
                    {promoNotice}
                  </p>
                ) : null}
              </div>
              {/* Whop branding default slot (SW-225). Empty when the page
                  places <WhopBrandingElement /> itself. */}
              <div
                ref={setDefaultBrandingSlot}
                className={brandingSlot ? undefined : "mt-4"}
                data-testid="whop-branding-default-slot"
              />
            </>
          ) : null}
          {errorMessage && identity && errorSurface !== "card" && errorSurface !== "promo" ? (
            <p className="mt-3 text-sm text-destructive" role="alert" data-testid="whop-pay-error">
              {errorMessage}
            </p>
          ) : null}
        </div>
      </PaymentsContext.Provider>
    </PlatformPaymentsContext.Provider>
  );
}

function useMountedElement(
  type: WhopPaymentsElementType,
  options: Record<string, unknown> | undefined,
  completeKey: string,
  // Options applied through element.update() when they change AFTER mount,
  // instead of a remount (a remount wipes what the buyer already typed into
  // the secure frame). Their current value also rides the create options.
  liveOptions?: Record<string, unknown>
) {
  const {
    payments,
    setComplete,
    registerElement,
    exclusiveSurfaceConflict,
    rememberAddressScope,
    rememberBillingFromChange,
  } = usePlatformPayments();
  const ref = React.useRef<HTMLDivElement | null>(null);
  const handleRef = React.useRef<WhopPaymentsElementHandle | null>(null);
  const liveOptionsRef = React.useRef(liveOptions);
  liveOptionsRef.current = liveOptions;
  const appliedLiveOptionsRef = React.useRef<string | null>(null);
  const liveOptionsJson = JSON.stringify(liveOptions ?? null);

  React.useEffect(() => {
    if (!payments || !ref.current) return;
    const conflict = exclusiveSurfaceConflict(type);
    if (conflict) {
      console.error(
        "[WhopPayments] exclusive payment surfaces: cannot mount " +
          type +
          " while " +
          conflict +
          " is mounted"
      );
      return;
    }
    let cancelled = false;
    try {
      const createOptions: Record<string, unknown> = {
        ...(options || {}),
        ...(liveOptionsRef.current || {}),
        onChange: (event: {
          complete?: boolean;
          email?: string;
          address?: Record<string, unknown>;
        }) => {
          if (cancelled) return;
          setComplete(completeKey, !!event.complete);
          rememberBillingFromChange(event);
        },
      };
      // PaymentElement owns its billing block. Address rides onAddressChange
      // (~300ms), not onChange. Keep a snapshot for tax/quoting, but confirm
      // re-reads the payment handle and omits address unless that read is
      // fresh and complete — a stale complete snapshot would override the
      // element's internal billing. Incomplete edits clear the snapshot.
      if (type === "payment") {
        createOptions.onAddressChange = (event: {
          complete?: boolean;
          address?: Record<string, unknown>;
        }) => {
          if (cancelled) return;
          if (!event.complete || !event.address) {
            rememberBillingFromChange({ clearAddress: true });
            return;
          }
          rememberBillingFromChange(event);
        };
      }
      const element = payments.create(type, createOptions);
      element.mount(ref.current);
      handleRef.current = element;
      appliedLiveOptionsRef.current = JSON.stringify(liveOptionsRef.current ?? null);
      registerElement(completeKey, element);
      if (type === "address") {
        rememberAddressScope(options?.scope === "full" ? "full" : "minimal");
      }
    } catch (error) {
      console.error("[WhopPayments] mount " + type + " failed:", error);
    }
    return () => {
      cancelled = true;
      registerElement(completeKey, null);
      if (type === "address") rememberAddressScope("none");
      try {
        handleRef.current?.destroy();
      } catch {
        // already gone
      }
      handleRef.current = null;
    };
    // remount when the handle or option key changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payments, type, JSON.stringify(options || {}), completeKey, setComplete, registerElement, exclusiveSurfaceConflict, rememberAddressScope, rememberBillingFromChange]);

  React.useEffect(() => {
    if (!liveOptions || !handleRef.current?.update) return;
    if (appliedLiveOptionsRef.current === liveOptionsJson) return;
    appliedLiveOptionsRef.current = liveOptionsJson;
    try {
      handleRef.current.update(liveOptions);
    } catch (error) {
      console.error("[WhopPayments] update " + type + " options failed:", error);
    }
    // update() restyles in place — never remount for a live-option change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveOptionsJson]);

  return ref;
}

export function WhopEmailElement({ className }: { className?: string }) {
  // Backward-compatible host input. Existing pages keep their import, but
  // email no longer mounts inside a Whop iframe.
  return (
    <div data-testid="whop-email-element">
      <WhopHostEmailInput className={className} />
    </div>
  );
}

function CardSurfaceError() {
  const { errorMessage, errorSurface } = useWhopPayments();
  if (errorSurface !== "card" || !errorMessage) return null;
  return (
    <p
      className="mt-2 text-sm text-destructive"
      role="alert"
      data-testid="whop-card-error"
    >
      {errorMessage}
    </p>
  );
}

export function WhopCardElement({
  className,
  layout = "compact",
}: {
  className?: string;
  layout?: "stacked" | "compact";
}) {
  const ref = useMountedElement("card", { layout }, "card");
  return (
    <div data-testid="whop-card-block">
      <div ref={ref} className={className} data-testid="whop-card-element" />
      <CardSurfaceError />
    </div>
  );
}

// Digital goods: scope=minimal. `name` chooses which HOST controls this
// compatibility component renders; the Whop frame always receives name=none.
// Explicit WhopHost* name fields take precedence, so compatibility controls do
// not duplicate them. A full AddressElement is for physical shipping — it is
// allowed beside Card, but it is not what amber tokenizes against.
export function WhopAddressElement({
  className,
  scope = "minimal",
  name = "combined",
}: {
  className?: string;
  scope?: "full" | "minimal";
  name?: "combined" | "split" | "none";
}) {
  const prefill = useHostOwnedBillingPrefill();
  const { hasExplicitHostNameInput } = usePlatformPayments();
  const ref = useMountedElement("address", { scope, name: "none" }, "address");
  const legacyNameClassName =
    "mb-3 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm";
  return (
    <div className={className} data-testid="whop-address-element">
      {!hasExplicitHostNameInput && name === "combined" ? (
        <HostOwnedTextInput
          prefillValue={prefill.name || joinPrefillName(prefill.firstName, prefill.lastName)}
          field="name"
          type="text"
          autoComplete="name"
          testId="whop-host-name"
          compatibilityName
          aria-label="Name"
          placeholder="Name"
          className={legacyNameClassName}
        />
      ) : null}
      {!hasExplicitHostNameInput && name === "split" ? (
        <div className="mb-3 grid grid-cols-2 gap-3">
          <HostOwnedTextInput
            prefillValue={prefill.firstName}
            field="firstName"
            type="text"
            autoComplete="given-name"
            testId="whop-host-given-name"
            compatibilityName
            aria-label="First name"
            placeholder="First name"
            className={legacyNameClassName}
          />
          <HostOwnedTextInput
            prefillValue={prefill.lastName}
            field="lastName"
            type="text"
            autoComplete="family-name"
            testId="whop-host-family-name"
            compatibilityName
            aria-label="Last name"
            placeholder="Last name"
            className={legacyNameClassName}
          />
        </div>
      ) : null}
      <div ref={ref} />
    </div>
  );
}

// The DEFAULT payment surface. Whop fills the method list (cards, wallets,
// local bank methods, BNPL once the creator is approved) from the creator's
// account, the plan's currency, and the buyer's location — never render your
// own "Apple Pay" / "PayPal" buttons or badges around it. Prop names are
// verified against payments/payment.md (@whop/elements@1.7.0).
export interface WhopPaymentElementProps {
  className?: string;
  /** "accordion" (default) stacks methods; "horizontal" shows equal tiles. */
  layout?: "accordion" | "horizontal";
  /** Display order (method type strings). Never affects availability. */
  order?: string[];
  /** Accordion only: card styling between methods. */
  separated?: boolean;
  /** Select the first offered method once resolved (Whop default: true). */
  autoSelect?: boolean;
  /**
   * Billing block density. Defaults to Whop's "minimal"; the platform flips
   * it to "never" automatically while a WhopAddressElement is mounted in the
   * same handle, so the buyer never sees two address blocks.
   */
  fields?: WhopPaymentElementFieldsOption;
  /** Prefill for name / phone / address ONLY — email stays host-owned. */
  defaultValues?: WhopPaymentElementDefaultValues;
}

export function WhopPaymentElement({
  className,
  layout = "accordion",
  order,
  separated,
  autoSelect,
  fields,
  defaultValues,
}: WhopPaymentElementProps) {
  const { addressElementMounted } = usePlatformPayments();
  const orderJson = JSON.stringify(order ?? null);
  const defaultValuesJson = JSON.stringify(defaultValues ?? null);
  const mountOptions = React.useMemo(() => {
    const options: Record<string, unknown> = { layout };
    if (Array.isArray(order) && order.length) options.order = order;
    if (typeof separated === "boolean") options.separated = separated;
    if (typeof autoSelect === "boolean") options.autoSelect = autoSelect;
    const safeDefaults = sanitizePaymentElementDefaultValues(defaultValues);
    if (safeDefaults) options.defaultValues = safeDefaults;
    return options;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, orderJson, separated, autoSelect, defaultValuesJson]);
  // fields ride element.update() instead of the mount options: the
  // address-mounted flip can arrive AFTER this element mounts, and a remount
  // would wipe what the buyer already typed into the payment frame.
  const fieldsJson = JSON.stringify(fields ?? null);
  const liveOptions = React.useMemo(
    () => ({ fields: resolvePaymentElementFields(fields, addressElementMounted) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fieldsJson, addressElementMounted]
  );
  const ref = useMountedElement("payment", mountOptions, "payment", liveOptions);
  return (
    <div data-testid="whop-payment-block">
      <div ref={ref} className={className} data-testid="whop-payment-element" />
      <CardSurfaceError />
    </div>
  );
}

// Whop's required branding ("Powered by Whop · Terms · Privacy"). The
// provider already mounts it under the form; render this only to choose
// WHERE it sits (e.g. right under your pay button). One per <WhopPayments>.
// It must stay visible: never hide, clip, or cover it (SW-225).
export function WhopBrandingElement({ className }: { className?: string }) {
  const { registerBrandingSlot } = usePlatformPayments();
  return (
    <div
      ref={registerBrandingSlot}
      className={className}
      data-testid="whop-branding-element"
    />
  );
}

export function WhopTaxIdElement({ className }: { className?: string }) {
  const ref = useMountedElement("taxId", undefined, "taxId");
  return <div ref={ref} className={className} data-testid="whop-taxid-element" />;
}

export function WhopPayButton({
  children,
  className,
  disabled: disabledProp,
}: {
  children?: React.ReactNode;
  className?: string;
  disabled?: boolean;
}) {
  const { confirm, confirming, complete } = useWhopPayments();
  const methodReady = complete.card || complete.payment;
  const disabled = disabledProp || confirming || !methodReady;
  return (
    <button
      type="button"
      className={className}
      data-testid="whop-pay-button"
      disabled={disabled}
      onClick={() => {
        void confirm();
      }}
    >
      {confirming ? "Processing…" : children || "Complete order"}
    </button>
  );
}

export default WhopPayments;
