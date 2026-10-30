// PLATFORM-MANAGED: loadWhopElements() — idempotent loader for Whop's hosted
// Elements runtime. Do NOT edit, and never load the runtime any other way.
//
// WHY A SCRIPT LOADER AND NOT AN NPM PACKAGE: Whop's Elements runtime IS the
// hosted script, which self-updates (30-second cache) — every app gets Whop's
// latest Elements at page load with no rebuild. The npm packages were 0.0.0
// stubs when this was written (2026-08-17); since 2026-09-21 @whop/elements
// 1.x ships, but it is only a "vanilla-js loader + types" whose loadWhop()
// injects the SAME runtime from cdn.whop.com (byte-identical to js.whop.cloud,
// verified 2026-09-30). Importing it would add a second script tag for the
// same 1.4 MB runtime, so this loader stays the ONLY place that URL may appear
// in a generated app; components consume the resolved constructor.
//
// Contract:
//   - Resolves window.WhopElements (the runtime's global constructor).
//   - Idempotent: concurrent callers share one in-flight load; an
//     already-present runtime resolves immediately; an already-present script
//     tag is reused rather than duplicated.
//   - A failed load rejects AND clears the in-flight promise so a later call
//     can retry (transient CDN/network failures must not brick checkout for
//     the rest of the session).

const WHOP_ELEMENTS_SRC = "https://js.whop.cloud/elements/amber/elements.js";

/** Minimal structural types for the slices of the runtime we consume. */
export type WhopElementsConstructor = (
  options?: Record<string, unknown>
) => WhopElementsHandle;

export interface WhopElementsHandle {
  checkout: WhopCheckoutGroupFactory;
  payments: WhopPaymentsGroupFactory;
}

export interface WhopPaymentsGroupFactory {
  create: (options: Record<string, unknown>) => WhopPaymentsGroupHandle;
  handleNextAction: (input: {
    clientSecret: string;
    returnUrl?: string;
    pollIntervalMs?: number;
  }) => Promise<WhopPaymentsNextActionResult>;
}

export interface WhopPaymentsNextActionResult {
  status: string;
  redirected: boolean;
  lastPaymentError?: {
    code?: string | null;
    decline_code?: string | null;
    message?: string | null;
  } | null;
}

export interface WhopBillingDetails {
  email?: string;
  name?: string;
  address?: {
    country?: string;
    line1?: string;
    line2?: string;
    city?: string;
    state?: string;
    postal_code?: string;
  };
}

export interface WhopPaymentsGroupHandle {
  create: (
    element: WhopPaymentsElementType,
    options?: Record<string, unknown>
  ) => WhopPaymentsElementHandle;
  // Amber host (verified 2026-08-31): pass billingDetails. Email is
  // required; cards also need name and an address containing line1 +
  // country. A no-arg OR address-only call throws before Basis Theory
  // is reached — that is what left Harbor Lane before POST /api/whop/confirm.
  // Tokenize runs on this Payments handle (js.whop.cloud iframe collect).
  // We never postMessage js.basistheory.com from generated-app code.
  createConfirmationToken: (input: {
    billingDetails?: WhopBillingDetails;
  }) => Promise<{ confirmationToken: string; type: string }>;
  update: (options: Record<string, unknown>) => void;
  destroy: () => void;
}

export type WhopPaymentsElementType =
  | "email"
  | "card"
  | "cardFields"
  | "address"
  | "payment"
  | "taxId"
  // Whop's required branding (SW-225): one per Payments handle, visible.
  | "branding";

export interface WhopPaymentsElementHandle {
  mount: (target: string | HTMLElement) => void;
  destroy: () => void;
  update?: (options: Record<string, unknown>) => void;
  getValues?: () => Promise<{
    address?: Record<string, unknown>;
    custom?: Record<string, string>;
  }>;
  validate?: () => Promise<{
    complete: boolean;
    address?: Record<string, unknown>;
    errors?: Record<string, string>;
  }>;
}

export interface WhopCheckoutGroupFactory {
  create: (options: Record<string, unknown>) => WhopCheckoutGroupHandle;
}

export interface WhopCheckoutGroupHandle {
  /**
   * Creates the CheckoutElement. The element takes no consumer props;
   * event callbacks (onLoaderStart / onReady / onError) ride the second
   * argument (verified against the live runtime, 2026-08-17).
   */
  create: (
    element: "checkout",
    events?: WhopCheckoutElementEvents
  ) => WhopCheckoutElementHandle;
  /** Legal for appearance/locale only — everything else is create-time. */
  update: (options: Record<string, unknown>) => void;
}

export interface WhopCheckoutElementEvents {
  onLoaderStart?: () => void;
  onReady?: () => void;
  onError?: (error: WhopCheckoutElementError) => void;
}

export interface WhopCheckoutElementError {
  message: string;
  code?: string;
  sourceKey?: string;
}

export interface WhopCheckoutElementHandle {
  mount: (target: string | HTMLElement) => void;
  destroy: () => void;
  update: (options: Record<string, unknown>) => void;
}

declare global {
  interface Window {
    WhopElements?: WhopElementsConstructor;
  }
}

let inFlightLoad: Promise<WhopElementsConstructor> | null = null;

export function loadWhopElements(): Promise<WhopElementsConstructor> {
  if (typeof window === "undefined") {
    return Promise.reject(
      new Error("Whop Elements can only load in a browser context")
    );
  }
  if (typeof window.WhopElements === "function") {
    return Promise.resolve(window.WhopElements);
  }
  if (inFlightLoad) return inFlightLoad;

  inFlightLoad = new Promise<WhopElementsConstructor>((resolve, reject) => {
    const settle = () => {
      if (typeof window.WhopElements === "function") {
        resolve(window.WhopElements);
      } else {
        inFlightLoad = null;
        reject(
          new Error(
            "Whop Elements runtime loaded but window.WhopElements is not a function"
          )
        );
      }
    };
    const fail = () => {
      inFlightLoad = null;
      reject(new Error("Failed to load the Whop Elements runtime"));
    };

    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${WHOP_ELEMENTS_SRC}"]`
    );
    if (existing) {
      // A tag is already present (e.g. two checkout surfaces on one page).
      // If its runtime already resolved we settle now; otherwise wait on it.
      if (typeof window.WhopElements === "function") {
        settle();
        return;
      }
      existing.addEventListener("load", settle, { once: true });
      existing.addEventListener("error", fail, { once: true });
      return;
    }

    const script = document.createElement("script");
    script.src = WHOP_ELEMENTS_SRC;
    script.async = true;
    // data-whop-elements appears on every documented script tag and on the
    // known-good production integrations. Its exact meaning is undocumented —
    // copy it verbatim; do not omit it.
    script.setAttribute("data-whop-elements", "");
    script.addEventListener("load", settle, { once: true });
    script.addEventListener("error", fail, { once: true });
    document.head.appendChild(script);
  });

  return inFlightLoad;
}

// --- payments charge XOR (plan OR inline amount, never both) ---
// Amber qd() (js.whop.cloud, verified 2026-09-02):
//   plan !== undefined + amount/currency/paymentMethodConfiguration
//     → ChargeConfigError PLAN_INLINE_CONFLICT
//   plan === undefined && (currency === undefined || amount === undefined)
//     → ChargeConfigError CHARGE_CONFIG_MISSING
//       "Pass a plan id, or an inline charge config with both currency
//       and amount — neither is mounted."
// payments.update Object.assigns, so a plan-primed handle plus later
// update({ amount }) is PLAN_INLINE_CONFLICT; unsetting plan without
// BOTH currency and amount is CHARGE_CONFIG_MISSING (Northline workbook
// bump after #5680). The controller then "keeps the last value" and
// bump totals lie.
//
// Pick one model and stick to it. A bump checkout that cannot prime
// inline must not fall back to plan — the next bump update would
// clear plan and miss. The Worker still charges catalog plan_ids;
// a client amount only gates payment methods.

export type PaymentsChargeConfig =
  | { mode: "plan"; plan: string }
  | { mode: "inline"; amount: number; currency: string };

export function usablePaymentsAmountCents(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

export function usablePaymentsCurrency(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

export function resolvePaymentsChargeConfig(
  input: Record<string, unknown>
): PaymentsChargeConfig | null {
  const amount = usablePaymentsAmountCents(input.amountCents);
  const currency = usablePaymentsCurrency(input.currency);
  const usesInlineAmount = input.usesInlineAmount === true;
  const planId = typeof input.planId === "string" ? input.planId : "";
  // Bump / custom-total checkouts stay on inline so update({ amount })
  // never reintroduces the catalog plan_id. Missing amount/currency is
  // a refused mount, not a plan-primed handle — that fallback is what
  // made Northline's bump toggle CHARGE_CONFIG_MISSING.
  if (usesInlineAmount) {
    if (amount && currency) {
      return { mode: "inline", amount: amount, currency: currency };
    }
    return null;
  }
  if (planId.length > 0) {
    return { mode: "plan", plan: planId };
  }
  return null;
}

export function paymentsChargeCreateFields(
  config: PaymentsChargeConfig
): Record<string, unknown> {
  if (config.mode === "inline") {
    return { amount: config.amount, currency: config.currency };
  }
  return { plan: config.plan };
}

export function paymentsChargeAmountUpdateFields(
  input: Record<string, unknown>
): Record<string, unknown> | null {
  const amount = usablePaymentsAmountCents(input.amountMinorUnits);
  const currency = usablePaymentsCurrency(input.currency);
  // Complete inline pair required. Unsetting plan with only amount is
  // Amber CHARGE_CONFIG_MISSING (Northline bump after #5680).
  if (!amount || !currency) return null;
  // Unset plan so Object.assign cannot keep a leftover plan_id beside
  // the new amount (Northline PLAN_INLINE_CONFLICT on bump toggle).
  return {
    plan: undefined,
    amount: amount,
    currency: currency,
  };
}
// --- end payments charge XOR ---

// --- whop elements locale ---
// Whop's built checkout-UI locales (getting-started.md, @whop/elements@1.7.0).
// Locale changes UI TEXT only — it never changes which payment methods are
// offered (Whop derives those from the account, plan currency, and the
// buyer's location). Any other tag falls back to English inside the runtime,
// so this mapping only needs the base language subtag.
export const WHOP_ELEMENTS_LOCALES = [
  "en",
  "es",
  "zh",
  "nl",
  "pt",
  "de",
  "hu",
  "it",
  "fr",
  "ja",
  "pl",
  "tr",
] as const;

export function resolveWhopElementsLocale(
  candidates: Array<string | null | undefined>
): string {
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const base = candidate.trim().toLowerCase().split(/[-_]/)[0];
    if ((WHOP_ELEMENTS_LOCALES as readonly string[]).includes(base)) return base;
  }
  return "en";
}

// Page language wins over browser language: a German buyer reading an
// English sales page should get an English checkout beside it.
export function detectWhopElementsLocale(): string {
  const candidates: Array<string | null | undefined> = [];
  if (typeof document !== "undefined") {
    candidates.push(document.documentElement?.lang);
  }
  if (typeof navigator !== "undefined") {
    candidates.push(navigator.language);
  }
  return resolveWhopElementsLocale(candidates);
}
// --- end whop elements locale ---

// --- payment element options ---
// PaymentElement props (payments/payment.md, @whop/elements@1.7.0): layout,
// order, separated, autoSelect, fields{billingDetails,phone}, defaultValues.
// Every name below is verified against those docs — never invent a prop.

export interface WhopPaymentElementFieldsOption {
  billingDetails?: "full" | "minimal" | "never";
  phone?: "never" | "auto";
}

export interface WhopPaymentElementDefaultValues {
  billingDetails?: {
    name?: string;
    /** E.164, e.g. "+15555550123". */
    phone?: string;
    address?: {
      line1?: string;
      line2?: string;
      city?: string;
      state?: string;
      postal_code?: string;
      /** ISO 3166-1 alpha-2. */
      country?: string;
    };
  };
}

// PaymentElement's internal billing block defaults to "minimal". When the
// page also mounts a WhopAddressElement in the same handle, two blocks would
// collect the same fields, so the platform hides PaymentElement's block
// automatically; an explicit caller billingDetails always wins. Always
// returns a concrete object so a later address unmount can RESTORE the
// billing block via element.update() rather than leaving it hidden.
export function resolvePaymentElementFields(
  fields: WhopPaymentElementFieldsOption | undefined,
  addressElementMounted: boolean
): WhopPaymentElementFieldsOption {
  const billingDetails =
    fields?.billingDetails || (addressElementMounted ? "never" : "minimal");
  return fields?.phone
    ? { billingDetails, phone: fields.phone }
    : { billingDetails };
}

// defaultValues may carry name / phone / address ONLY (an allowlist copy, so
// a stray runtime key can never ride along). Email is host-owned identity
// (WhopHostEmailInput) and must never be seeded into a Whop frame.
export function sanitizePaymentElementDefaultValues(
  input: WhopPaymentElementDefaultValues | undefined
): WhopPaymentElementDefaultValues | undefined {
  const billing = input?.billingDetails;
  if (!billing || typeof billing !== "object") return undefined;
  const next: NonNullable<WhopPaymentElementDefaultValues["billingDetails"]> = {};
  if (typeof billing.name === "string" && billing.name.trim()) {
    next.name = billing.name;
  }
  if (typeof billing.phone === "string" && billing.phone.trim()) {
    next.phone = billing.phone;
  }
  if (billing.address && typeof billing.address === "object") {
    const keep: Record<string, string> = {};
    for (const key of [
      "line1",
      "line2",
      "city",
      "state",
      "postal_code",
      "country",
    ]) {
      const value = (billing.address as Record<string, unknown>)[key];
      if (typeof value === "string" && value.trim()) keep[key] = value;
    }
    if (Object.keys(keep).length) {
      next.address = keep as NonNullable<
        NonNullable<WhopPaymentElementDefaultValues["billingDetails"]>["address"]
      >;
    }
  }
  return Object.keys(next).length ? { billingDetails: next } : undefined;
}
// --- end payment element options ---

// --- whop theme appearance ---
// Map the app's own design tokens onto Whop's Appearance object
// (appearance.md, @whop/elements@1.7.0) so the payment surfaces read as the
// app instead of a provider default: accentColor is the nearest of Whop's 28
// Radix scales to the app's --primary hue, grayColor follows the neutral
// (--muted), and the app's --radius rides the variables map. Everything here
// fails SOFT: an unparseable token just omits that key and Whop renders its
// default — never guess a brand.

const WHOP_ACCENT_HUES: ReadonlyArray<readonly [string, number]> = [
  ["tomato", 10],
  ["orange", 23],
  ["amber", 39],
  ["yellow", 53],
  ["lemon", 65],
  ["lime", 81],
  ["grass", 131],
  ["green", 151],
  ["jade", 164],
  ["mint", 167],
  ["teal", 173],
  ["cyan", 191],
  ["sky", 200],
  ["blue", 206],
  ["indigo", 226],
  ["iris", 240],
  ["violet", 252],
  ["purple", 272],
  ["plum", 292],
  ["magenta", 308],
  ["pink", 322],
  ["crimson", 332],
  ["ruby", 348],
  ["red", 358],
];

// Whop's warm low-saturation accents. Chosen only for a muted warm primary —
// a saturated orange must stay orange, not brown.
const WHOP_WARM_NEUTRAL_HUES: ReadonlyArray<readonly [string, number]> = [
  ["bronze", 18],
  ["brown", 28],
  ["gold", 40],
];

function circularHueDistance(a: number, b: number): number {
  const distance = Math.abs(a - b) % 360;
  return distance > 180 ? 360 - distance : distance;
}

function nearestHueName(
  hue: number,
  table: ReadonlyArray<readonly [string, number]>
): string {
  let bestName = table[0][0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const [name, anchor] of table) {
    const distance = circularHueDistance(hue, anchor);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestName = name;
    }
  }
  return bestName;
}

export interface ParsedHslTriplet {
  h: number;
  s: number;
  l: number;
}

// Tailwind/shadcn tokens store bare space-separated HSL triplets
// ("222.2 47.4% 11.2%"); hsl()/comma forms are accepted too. Anything else
// (hex, oklch, var() chains) returns null and the caller omits the key.
export function parseHslTriplet(
  value: string | null | undefined
): ParsedHslTriplet | null {
  if (typeof value !== "string") return null;
  const match = value
    .trim()
    .match(/^(?:hsla?\(\s*)?(-?[\d.]+)(?:deg)?[,\s]+([\d.]+)%[,\s]+([\d.]+)%/i);
  if (!match) return null;
  let h = Number(match[1]) % 360;
  if (h < 0) h += 360;
  const s = Number(match[2]);
  const l = Number(match[3]);
  if (!Number.isFinite(h) || !Number.isFinite(s) || !Number.isFinite(l)) {
    return null;
  }
  return { h, s, l };
}

export function whopAccentColorForHsl(
  hsl: ParsedHslTriplet | null
): string | null {
  if (!hsl) return null;
  if (hsl.s < 8) return "gray";
  if (hsl.s < 25 && hsl.h >= 12 && hsl.h <= 50) {
    return nearestHueName(hsl.h, WHOP_WARM_NEUTRAL_HUES);
  }
  return nearestHueName(hsl.h, WHOP_ACCENT_HUES);
}

export function whopGrayColorForHsl(hsl: ParsedHslTriplet): string {
  if (hsl.s < 2) return "gray";
  if (hsl.h >= 20 && hsl.h < 60) return "sand";
  if (hsl.h >= 60 && hsl.h < 120) return "olive";
  if (hsl.h >= 120 && hsl.h < 180) return "sage";
  if (hsl.h >= 180 && hsl.h < 250) return "slate";
  if (hsl.h >= 250 && hsl.h < 330) return "mauve";
  return "gray";
}

// Whop's variables map wants a concrete CSS length. The app's --radius is
// usually rem; inside Whop's iframe rem resolves against the IFRAME's root
// font size, not the app's, so convert against the app's real root size.
export function cssRadiusToPx(
  value: string | null | undefined,
  rootFontSizePx: number
): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const rem = trimmed.match(/^(-?[\d.]+)rem$/);
  if (rem) {
    const base =
      Number.isFinite(rootFontSizePx) && rootFontSizePx > 0
        ? rootFontSizePx
        : 16;
    const px = Number(rem[1]) * base;
    return Number.isFinite(px) ? `${Math.round(px * 100) / 100}px` : null;
  }
  const px = trimmed.match(/^(-?[\d.]+)px$/);
  if (px && Number.isFinite(Number(px[1]))) return `${Number(px[1])}px`;
  return null;
}

export interface WhopThemeTokens {
  /** The app's --primary triplet (accent source). */
  primary?: string | null;
  /** The app's --muted triplet (gray-family source). */
  neutral?: string | null;
  /** The app's resolved --radius ("0.5rem" / "8px"). */
  radius?: string | null;
  rootFontSizePx?: number;
}

// ONE appearance object for WhopElements({ appearance }) and the live
// update({ appearance }) on theme flip. theme.appearance is always present;
// every other key is added only when the app token resolved.
export function buildWhopAppearance(
  appearance: "light" | "dark",
  tokens: WhopThemeTokens = {}
): Record<string, unknown> {
  const theme: Record<string, unknown> = { appearance };
  const accent = whopAccentColorForHsl(parseHslTriplet(tokens.primary));
  if (accent) {
    theme.accentColor = accent;
    const neutral = parseHslTriplet(tokens.neutral);
    theme.grayColor = neutral ? whopGrayColorForHsl(neutral) : "auto";
  }
  const result: Record<string, unknown> = { theme };
  const radius = cssRadiusToPx(tokens.radius, tokens.rootFontSizePx ?? 16);
  if (radius) result.variables = { "--radius": radius };
  return result;
}
// --- end whop theme appearance ---
