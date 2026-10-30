// Whop funnel primitives (provided by OverSkill template).
//
// Thin client-side helpers wrapping the most common operations a Whop-backed
// funnel needs. Import from here rather than reinventing the wheel each time.
//
// Architecture:
//   - createCheckoutSession() — mints a Whop checkout-configuration session
//     (`ch_xxx`) for a plan_id via the OverSkill worker. The browser MUST
//     pass that id to the embed as `sessionId` — Whop's current (v3) embed
//     protocol throws "`sessionKey` is a required property" when the embed
//     mounts with only a planId. Use the useCheckoutSession() hook
//     (@/hooks/useCheckoutSession) to fetch it; or CheckoutDialog /
//     pre-built components that do it for you.
//   - The browser embeds Whop's checkout via @whop/checkout (see
//     <WhopCheckoutEmbed planId="..." sessionId="...">). The embed fires
//     postMessage events when checkout completes.
//   - completeCheckout() — runs once the embed reports a receiptId. Hits the
//     OverSkill worker at /api/whop/checkout-complete which looks up the
//     payment + saved card via the app's sub-merchant API key (server-side
//     only, never exposed to the browser).
//   - chargeUpsell() — runs off-session charges for upsell pages later in the
//     funnel using the saved paymentMethodId. When the generated-app Whop
//     capability canary is enabled, pass the signed checkout/session
//     capability returned by completeCheckout().
//
// Server-side: see app/services/deployment/worker_api_template.rb for the
// /api/whop/checkout-complete and /api/whop/charge route handlers. The app's
// per-merchant whop_api_key (ak_xxx) lives in worker env as WHOP_API_KEY and
// is never sent to the browser.

export interface CheckoutCompletePayload {
  // Optional: the returnUrl top-redirect path only has the receipt
  // identifier from the query string — no plan in memory. Pass planId
  // when you have it (the in-SPA onComplete path).
  planId?: string;
  receiptId: string;
}

export interface CheckoutCompleteResult {
  memberId: string;
  paymentMethodId: string | null;
  // The buyer's email collected at checkout. For an ANONYMOUS buyer
  // (no app login) this is what you forward to /login?email=... so the
  // signup/login prefills the SAME email the purchase was made under —
  // letting the platform reconcile the entitlement to the new account
  // by email (the default purchase -> login/signup -> access flow).
  // null when the worker couldn't resolve it from the payment record.
  memberEmail: string | null;
  // Echoed back so callers don't have to thread state separately.
  planId?: string;
  receiptId: string;
  // Short-lived signed checkout/session capability. Present only when the
  // generated-app Whop capability canary is enabled for this app/team.
  capability: string | null;
}

export interface ChargeUpsellOptions {
  memberId: string;
  paymentMethodId: string;
  // Either an existing plan (preferred — supports recurring) OR an inline
  // one-time price in whole dollars (or a fractional dollar amount).
  planId?: string;
  inlinePrice?: number;
  // Free-form data attached to the resulting payment record on Whop. Keep
  // keys short; values must be JSON-scalar.
  metadata?: Record<string, string | number | boolean>;
  // Optional human-readable description shown on receipts.
  description?: string;
  // Signed checkout/session capability returned by completeCheckout().
  // Required only when VITE_WHOP_CAPABILITY_AUTHZ_ENABLED is true.
  capability?: string | null;
  // Idempotency key for this charge attempt. The helper derives a stable key
  // when omitted, but explicit keys are best for multi-button flows.
  idempotencyKey?: string;
}

export interface ChargeUpsellResult {
  success: boolean;
  paymentId?: string;
  error?: string;
  // Echoed for caller convenience.
  memberId?: string;
}

// ---------------------------------------------------------------------------
// createCheckoutSession — REQUIRED before mounting <WhopCheckoutEmbed>
// ---------------------------------------------------------------------------

export interface CreateCheckoutSessionOptions {
  // Retained for source compatibility. Protected checkout metadata and the
  // destination are derived by OverSkill from the authenticated app.
  metadata?: Record<string, string | number | boolean>;
  redirectUrl?: string;
}

/**
 * Mint a Whop checkout-configuration SESSION for a plan and return its id
 * (`ch_xxx`). You MUST pass this id to the embed as `sessionId`:
 *
 * ```tsx
 * <WhopCheckoutEmbed planId={planId} sessionId={sessionId} />
 * ```
 *
 * WHY: Whop's current (v3) embedded-checkout protocol requires a
 * server-created session. Mounting `<WhopCheckoutEmbed>` with only a
 * `planId` makes the iframe throw "`sessionKey` is a required property" and
 * the pay button silently no-ops — checkout is completely broken. Creating
 * the session server-side (where the app's sub-merchant key lives, never
 * exposed to the browser) and handing the id to the embed is the fix.
 *
 * Most callers should use the `useCheckoutSession(planId)` hook from
 * `@/hooks/useCheckoutSession` (handles loading/error/retry) rather than
 * calling this directly. Hits the OverSkill worker route
 * `/api/whop/checkout-session`.
 *
 * @throws if planId is missing, the worker errors, or no session id is
 *   returned. Callers should surface a retry affordance (the hook does).
 */
export class CheckoutSessionRateLimitError extends Error {
  readonly status = 429;
  readonly retryAfterMs: number;
  constructor(retryAfterMs: number) {
    super("checkout_rate_limited");
    this.name = "CheckoutSessionRateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Why a checkout session could not be created, as reported by the server.
 *
 * These arrive as the `reason` field next to `checkout_unavailable`. Treat an
 * unknown or missing value as "generic failure, offer a retry" — older servers
 * and older workers send no reason at all.
 */
export type CheckoutUnavailableReason =
  /** Asked from the editor preview window. Checkout only runs on the live app. */
  | "preview_origin"
  /** Asked through a proxy that is not the editor preview. */
  | "proxied_origin"
  /** Asked from a page that is not one of this app's own addresses. */
  | "origin_mismatch"
  | "origin_not_allowed"
  /** The plan id is not an active plan on this app. */
  | "plan_unavailable"
  /** The app really does need its payment setup finished. */
  | "payments_not_configured"
  /** The app is archived, suspended, or its team is not active. */
  | "app_not_live"
  /** The server could not route this app at all. Our bug, not the caller's. */
  | "unknown_app"
  /** The request itself was malformed — commonly a stale or deleted plan id. */
  | "bad_request"
  /** Staging traffic, which deliberately has no checkout. */
  | "staging_environment"
  /** The checkout shield is missing its configuration. Our bug. */
  | "dispatch_not_configured"
  /** Transient: too many session mints; retry after the server's window. */
  | "rate_limited"
  /** The payment provider or the platform failed. Retry. */
  | "upstream_error"
  | "provider_unavailable";

/**
 * Human-readable copy per reason, safe to show a shopper OR a creator testing
 * their own app.
 *
 * WHY THIS EXISTS: the server used to answer every failure with one opaque
 * `checkout_unavailable`, so app UIs had to guess, and the guess that spread was
 * "payments aren't set up on this account". That is true for exactly ONE reason
 * below. Creators who had simply clicked their own checkout button inside the
 * editor preview window were told to go fix identity verification and payment
 * setup that were working perfectly — and could not get past it. Do not
 * re-collapse these into one string.
 */
const CHECKOUT_UNAVAILABLE_MESSAGES: Record<CheckoutUnavailableReason, string> = {
  // Overridden below when the server also sent the live address.
  preview_origin:
    "Checkout doesn't run in the editor preview window. Open your published app's own link and try there.",
  proxied_origin:
    "This checkout can only be started from the app's own live address.",
  origin_mismatch:
    "This checkout can only be started from the app's own live address.",
  origin_not_allowed:
    "This checkout can only be started from the app's own live address.",
  plan_unavailable:
    "That plan isn't available on this app right now.",
  payments_not_configured:
    "This app hasn't finished setting up payments yet.",
  app_not_live:
    "This app isn't currently live.",
  unknown_app:
    "We couldn't start the checkout. Please try again in a moment.",
  bad_request:
    "We couldn't read that checkout request. Please try again.",
  staging_environment:
    "Checkout isn't available on this test environment.",
  dispatch_not_configured:
    "We couldn't start the checkout. Please try again in a moment.",
  rate_limited:
    "Too many checkout attempts just now. Give it a few seconds and try again.",
  upstream_error:
    "We couldn't reach the payment provider. Please try again in a moment.",
  provider_unavailable:
    "We couldn't reach the payment provider. Please try again in a moment.",
};

// Reasons a retry could plausibly clear. Everything else repeats forever, and a
// Retry button on a permanent failure is what makes someone conclude the product
// is broken rather than that they are on the wrong page.
const RETRYABLE_CHECKOUT_REASONS: readonly CheckoutUnavailableReason[] = [
  "upstream_error",
  "provider_unavailable",
  "rate_limited",
  "unknown_app",
  "dispatch_not_configured",
];

const GENERIC_CHECKOUT_UNAVAILABLE_MESSAGE =
  "We couldn't start the checkout. Please try again.";

/**
 * A checkout session the server declined, carrying WHICH cause it was.
 *
 * `message` is already presentable — render it directly rather than composing
 * your own copy from `reason`, so every app in the fleet says the same true
 * thing. `liveUrl` is set only for `preview_origin`, where the server knows the
 * address the checkout WILL work on; link it.
 */
export class CheckoutUnavailableError extends Error {
  readonly status: number;
  readonly reason: CheckoutUnavailableReason | null;
  readonly liveUrl: string | null;
  /** True when retrying the same call could plausibly succeed. */
  readonly retryable: boolean;

  constructor(
    status: number,
    reason: CheckoutUnavailableReason | null,
    liveUrl: string | null
  ) {
    // Only trust an https link the server sent; it goes straight into an href.
    const safeLiveUrl =
      liveUrl && /^https:\/\//i.test(liveUrl) ? liveUrl : null;
    super(
      reason === "preview_origin" && safeLiveUrl
        ? "Checkout doesn't run in the editor preview window. Open your live app link and try there."
        : (reason && CHECKOUT_UNAVAILABLE_MESSAGES[reason]) ||
            GENERIC_CHECKOUT_UNAVAILABLE_MESSAGE
    );
    this.name = "CheckoutUnavailableError";
    this.status = status;
    this.reason = reason ?? null;
    this.liveUrl = safeLiveUrl;
    // An unknown reason keeps the old generic message, so it must also keep the
    // old retry affordance — a future server-side reason this bundle predates
    // must not silently strip the only way forward from an already-deployed app.
    this.retryable =
      !reason ||
      !(reason in CHECKOUT_UNAVAILABLE_MESSAGES) ||
      RETRYABLE_CHECKOUT_REASONS.includes(reason);
  }
}

/**
 * The server-owned checkout identity for ONE checkout, minted by
 * Whop::GeneratedAppCheckoutSession behind /api/whop/checkout-session.
 *
 * `metadata` is the SAME blob the platform stamps on the ch_xxx checkout
 * configuration (kind + checkout_intent_token + overskill ids). The Whop
 * Elements lane passes it VERBATIM on the element's `metadata` option because
 * the element mounts a client-minted checkout session and cannot mount from a
 * ch_xxx — this is how the ONE money identity rides that lane. Never compose
 * checkout metadata client-side.
 *
 * `metadata`/`redirectUrl` are null when the serving worker predates the
 * fields (e.g. the fleet dispatch shield before its next redeploy) — callers
 * that REQUIRE the identity (WhopElementsCheckout) must fail closed on null,
 * never mount without it.
 *
 * `accountId` is additive for Model B (Payments.create). Rails returns it
 * top-level. Production/preview `/api/whop/checkout-session` is served by
 * the dispatch shield, which WHITELISTS fields — a shield that predates
 * those keys still returns 201 and drops them (Harbor Club / ekaWDj after
 * #5527). The company id is already inside the metadata blob the shield
 * has relayed since #4943 (`overskill_company_id`). resolveCheckoutAccountId
 * reads that when the additive field is missing so Model B can mount.
 */
export interface CheckoutIdentity {
  sessionId: string;
  planId: string;
  metadata: Record<string, string> | null;
  redirectUrl: string | null;
  checkoutIntentToken: string | null;
  /** Sub-merchant biz_ id — required to mount a Payments handle (Model B). */
  accountId: string | null;
  /** Catalog SUBTOTAL in minor units. Prime Payments with this, never a discount. */
  amountCents: number | null;
  currency: string | null;
}

/**
 * Sub-merchant account id for Payments.create({ accountId }).
 *
 * Prefer the additive top-level field Rails minted. When a stale dispatch
 * whitelist dropped it, recover from the already-relayed metadata blob —
 * never invent a company id the server did not stamp.
 */
export function resolveCheckoutAccountId(
  json: { accountId?: string | null; account_id?: string | null },
  metadata: Record<string, string> | null
): string | null {
  const topLevel = json.accountId ?? json.account_id;
  if (typeof topLevel === "string" && topLevel.length > 0) return topLevel;
  const fromMetadata =
    metadata && (metadata.overskill_company_id || metadata.overskillCompanyId);
  if (typeof fromMetadata === "string" && fromMetadata.length > 0) {
    return fromMetadata;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Affiliate ref capture — the creator's Whop affiliate program, on THIS app's
// own domain.
//
// Whop's own attribution is a cookie on whop.com set by `?a=<username>`
// links, so it can never see a buyer landing here. The app captures the ref
// itself: main.tsx calls captureAffiliateRef() once at boot (the param is on
// the LANDING URL and is gone after the first SPA navigation), and
// mintCheckoutIdentity sends the stored value to the platform as
// `affiliate_code`. The platform is the authority — it validates the shape,
// drops a creator self-referral, and forwards to Whop only when the team's
// attribution flag is on. This file is capture + transport only; never
// compute commissions client-side.
//
// Accepted params, in PRECEDENCE order (first present wins):
//   1. ?a=         — the parameter Whop's own referral links use
//   2. ?ref=       — the common generic spelling
//   3. ?affiliate= — the explicit spelling
// A later arrival carrying a ref OVERWRITES a stored one (last click wins,
// mirroring Whop's own cookie behavior). The ref persists in BOTH
// sessionStorage (same-tab fast path) and a first-party cookie with a 30-day
// window (mirrors Whop's default attribution window), so it survives a
// browse-now-buy-later gap on this domain.
// ---------------------------------------------------------------------------

export const AFFILIATE_REF_PARAMS = ["a", "ref", "affiliate"] as const;
/** 30 days — mirrors Whop's default affiliate attribution window. */
export const AFFILIATE_REF_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const AFFILIATE_REF_STORAGE_KEY = "os_affiliate_ref";
const AFFILIATE_REF_COOKIE = "os_aff_ref";
// Whop username shape — letters/digits/underscore/period/hyphen, bounded.
// LOCKSTEP with the Worker relays and the platform's
// Affiliates::GeneratedAppCheckoutAttribution::CODE_PATTERN; a value this
// pattern refuses would be dropped server-side anyway, so never widen it
// only here.
const AFFILIATE_REF_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/** A Whop-username-shaped ref, or null. NEVER throws. */
export function normalizeAffiliateRef(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  return AFFILIATE_REF_PATTERN.test(value) ? value : null;
}

/**
 * Capture an affiliate ref from the (current) URL and persist it for 30 days.
 * Returns the captured ref, or null when the URL carries none. NEVER throws —
 * blocked storage degrades to whichever store still works, and attribution is
 * always best-effort.
 */
export function captureAffiliateRef(
  search?: string,
  now?: number
): string | null {
  let ref: string | null = null;
  try {
    const query =
      search ?? (typeof window === "undefined" ? "" : window.location.search);
    const params = new URLSearchParams(query);
    for (const name of AFFILIATE_REF_PARAMS) {
      ref = normalizeAffiliateRef(params.get(name));
      if (ref) break;
    }
  } catch {
    return null;
  }
  if (!ref) return null;

  const timestamp = now ?? Date.now();
  try {
    sessionStorage.setItem(
      AFFILIATE_REF_STORAGE_KEY,
      JSON.stringify({ v: ref, e: timestamp + AFFILIATE_REF_WINDOW_MS })
    );
  } catch {
    // Storage unavailable (privacy mode) — the cookie below may still work.
  }
  try {
    const secure =
      typeof window !== "undefined" && window.location.protocol === "https:"
        ? "; Secure"
        : "";
    document.cookie =
      AFFILIATE_REF_COOKIE +
      "=" +
      encodeURIComponent(ref) +
      "; Max-Age=" +
      Math.floor(AFFILIATE_REF_WINDOW_MS / 1000) +
      "; Path=/; SameSite=Lax" +
      secure;
  } catch {
    // Cookies blocked — sessionStorage above may still carry this tab.
  }
  return ref;
}

/**
 * The stored affiliate ref, or null. sessionStorage first (validated and
 * expiry-checked), then the first-party cookie (the browser expires it; the
 * shape is still re-validated). NEVER throws.
 */
export function readAffiliateRef(now?: number): string | null {
  const timestamp = now ?? Date.now();
  try {
    const raw = sessionStorage.getItem(AFFILIATE_REF_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { v?: unknown; e?: unknown };
      const value = normalizeAffiliateRef(parsed.v);
      if (value && typeof parsed.e === "number" && parsed.e > timestamp) {
        return value;
      }
      // Expired or malformed — forget it so it cannot shadow the cookie.
      try {
        sessionStorage.removeItem(AFFILIATE_REF_STORAGE_KEY);
      } catch {
        // best-effort
      }
    }
  } catch {
    // Fall through to the cookie.
  }

  try {
    const prefix = AFFILIATE_REF_COOKIE + "=";
    const entry = document.cookie
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(prefix));
    if (entry) {
      return normalizeAffiliateRef(decodeURIComponent(entry.slice(prefix.length)));
    }
  } catch {
    // No cookie access either.
  }
  return null;
}

/**
 * The affiliate_code to send on a checkout mint: an opportunistic re-capture
 * from the CURRENT URL first (last click wins), then whatever an earlier page
 * view stored. Null when the visit carries no attribution — the mint body
 * must stay byte-identical to an unattributed one in that case.
 */
export function resolveAffiliateCode(now?: number): string | null {
  return captureAffiliateRef(undefined, now) ?? readAffiliateRef(now);
}

// NOTE: the Whop Elements lane (mount_lane on the intent) is resolved
// SERVER-SIDE from the app team's feature flag — deliberately NOT a request
// parameter (independent review D2: a browser-suppliable lane let any caller
// opt an intent out of the webhook's checkout-id binding). The POSTed body is
// the plan hint, plus the captured affiliate ref when one exists — which the
// platform validates, self-referral-guards, and flag-gates server-side, so
// sending it grants nothing.
export async function mintCheckoutIdentity(
  planId: string
): Promise<CheckoutIdentity> {
  if (!planId) throw new Error("mintCheckoutIdentity: planId is required");

  // #4880 — send the signed-in buyer's token so the server can record WHO
  // started this checkout and later attach the purchased membership to THIS
  // identity, not to whoever owns the Whop buyer email (the "Sign in with
  // Apple" private-relay case, where the login email can never match the Whop
  // account). Best-effort and anonymous-safe: a signed-out buyer sends no
  // token, and the server falls back to email matching exactly as before.
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  try {
    const token = localStorage.getItem("overskill_token");
    if (token) headers.Authorization = `Bearer ${token}`;
  } catch {
    // localStorage unavailable — the checkout still mints anonymously.
  }

  // The creator-program affiliate ref this visit carries, if any. Absent ⇒
  // the body stays byte-identical to an unattributed mint; the platform
  // validates, self-referral-guards and flag-gates the value server-side.
  const affiliateCode = resolveAffiliateCode();

  const res = await fetch("/api/whop/checkout-session", {
    method: "POST",
    headers,
    body: JSON.stringify(
      affiliateCode ? { planId, affiliate_code: affiliateCode } : { planId }
    ),
  });

  // A 429 is transient back-pressure (per-IP session-mint cap), NOT a broken
  // checkout. Surface it as a typed error so the hook can auto-retry after
  // the server-provided Retry-After window instead of showing a hard
  // failure. See useCheckoutSession's backoff handling.
  if (res.status === 429) {
    const retryAfterMs = parseRetryAfterMs(res);
    throw new CheckoutSessionRateLimitError(retryAfterMs);
  }

  if (!res.ok) {
    const body = await safeText(res);
    // The server tells us WHICH cause it was. Parse it into a typed error whose
    // `message` is already fit to show, instead of surfacing an HTTP dump that a
    // UI then has to reinterpret (and historically reinterpreted wrongly — see
    // CheckoutUnavailableError).
    let reason: CheckoutUnavailableReason | null = null;
    let liveUrl: string | null = null;
    try {
      const parsed = body ? JSON.parse(body) : null;
      if (parsed && typeof parsed.reason === "string") {
        reason = parsed.reason as CheckoutUnavailableReason;
      }
      const parsedLiveUrl = parsed && (parsed.live_url ?? parsed.liveUrl);
      if (typeof parsedLiveUrl === "string" && parsedLiveUrl) {
        liveUrl = parsedLiveUrl;
      }
    } catch {
      // Non-JSON body — fall through to the generic message.
    }
    throw new CheckoutUnavailableError(res.status, reason, liveUrl);
  }

  const json = (await res.json()) as {
    session_id?: string;
    sessionId?: string;
    plan_id?: string;
    planId?: string;
    checkout_intent_token?: string | null;
    checkoutIntentToken?: string | null;
    checkout_metadata?: Record<string, string> | null;
    checkoutMetadata?: Record<string, string> | null;
    redirect_url?: string | null;
    redirectUrl?: string | null;
    account_id?: string | null;
    accountId?: string | null;
    amount_cents?: number | null;
    amountCents?: number | null;
    currency?: string | null;
  };
  const sessionId = json.sessionId ?? json.session_id ?? "";
  if (!sessionId) {
    throw new Error("mintCheckoutIdentity: worker returned no sessionId");
  }
  const checkoutIntentToken =
    json.checkoutIntentToken ?? json.checkout_intent_token ?? null;
  // Remember the intent token for THIS checkout (side effect, same shape as
  // rememberWhopCapability above). It is the corroborating factor claimPurchase
  // sends: proof that this browser is the session that opened the checkout,
  // which is the only way a buyer whose checkout email differs from their login
  // email can claim their purchase.
  rememberCheckoutIntentToken(checkoutIntentToken);
  const metadata = json.checkoutMetadata ?? json.checkout_metadata ?? null;
  const amountRaw = json.amountCents ?? json.amount_cents;
  const amountCents =
    typeof amountRaw === "number" && Number.isFinite(amountRaw) ? amountRaw : null;
  return {
    sessionId,
    planId: json.planId ?? json.plan_id ?? planId,
    metadata,
    redirectUrl: json.redirectUrl ?? json.redirect_url ?? null,
    checkoutIntentToken,
    accountId: resolveCheckoutAccountId(json, metadata),
    amountCents,
    currency: json.currency ?? null,
  };
}

export async function createCheckoutSession(
  planId: string,
  _opts: CreateCheckoutSessionOptions = {}
): Promise<string> {
  if (!planId) throw new Error("createCheckoutSession: planId is required");
  const identity = await mintCheckoutIdentity(planId);
  return identity.sessionId;
}

export interface ConfirmWhopPaymentInput {
  confirmationToken?: string;
  planId: string;
  checkoutIntentToken: string;
  bumpPlanIds?: string[];
  email?: string;
  promoCode?: string;
}

// Typed / ?promo= / prop input. Buyer-facing refuse copy lives next to
// buyerFacingCheckoutError so the paid-checkout eval harness (which
// slices from PAID_CHECKOUT_STATUSES) can classify a promo refusal
// without a silent drop (SW-82 / #6402).
export const WHOP_PROMO_MAX_LENGTH = 64;

export function normalizeWhopPromoCode(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const normalized = raw.trim().replace(/\s+/g, "");
  if (!normalized) return undefined;
  return normalized.slice(0, WHOP_PROMO_MAX_LENGTH);
}

export function readWhopCheckoutPromoFromUrl(search?: string): string | undefined {
  try {
    const query =
      search ?? (typeof window === "undefined" ? "" : window.location.search);
    return normalizeWhopPromoCode(new URLSearchParams(query).get("promo") || "");
  } catch {
    return undefined;
  }
}

export interface LastPaymentErrorLike {
  code?: string | null;
  decline_code?: string | null;
  declineCode?: string | null;
  message?: string | null;
}

export interface ConfirmWhopPaymentResult {
  status: string;
  clientSecret: string | null;
  paymentId: string | null;
  bumpError: string | null;
  bumpPaymentIds: string[];
  bumpsDeferred: boolean;
  lastPaymentError: LastPaymentErrorLike | null;
  bumpLastPaymentError: LastPaymentErrorLike | null;
  idempotent: boolean;
}

/**
 * Confirm a Model B Payments token. The Worker holds the secret, resumes the
 * page-load purchase identity (same checkout_intent_token the browser
 * remembered), and ignores any client amount. Each selected bump is charged
 * as its own catalog plan_id after the primary no longer needs a next
 * action. Pair with handleNextAction when a secret is returned, then call
 * again to charge deferred bumps. A later confirm charges only the
 * `deferred_bump_ids` the Worker stored — an empty or expanded request
 * list cannot add catalog SKUs after the primary is claimed. A missing
 * secret with a payment id is an accepted primary charge — check bumpError
 * before treating the cart as done.
 */
export async function confirmWhopPayment(
  input: ConfirmWhopPaymentInput
): Promise<ConfirmWhopPaymentResult> {
  if (!input.planId) {
    throw new Error("confirmWhopPayment: planId is required");
  }
  if (!input.checkoutIntentToken) {
    throw new Error("confirmWhopPayment: checkoutIntentToken is required");
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  try {
    const token = localStorage.getItem("overskill_token");
    if (token) headers.Authorization = `Bearer ${token}`;
  } catch {
    // anonymous-safe
  }

  const res = await fetch("/api/whop/confirm", {
    method: "POST",
    headers,
    body: JSON.stringify({
      confirmation_token: input.confirmationToken,
      checkout_intent_token: input.checkoutIntentToken,
      cart: {
        plan_id: input.planId,
        bump_plan_ids: input.bumpPlanIds || [],
      },
      buyer: input.email ? { email: input.email } : undefined,
      promo_code: input.promoCode,
    }),
  });

  if (res.status === 429) {
    const retryAfterMs = parseRetryAfterMs(res);
    throw new CheckoutSessionRateLimitError(retryAfterMs);
  }

  if (!res.ok) {
    const body = await safeText(res);
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = body ? (JSON.parse(body) as Record<string, unknown>) : null;
    } catch {
      parsed = null;
    }
    if (parsed && isWhopPromoErrorCode(parsed.error)) {
      const err = new Error(whopPromoErrorMessage(parsed)) as Error & {
        lastPaymentError?: LastPaymentErrorLike | null;
        promoError?: string;
      };
      err.name = "CheckoutPromoError";
      err.lastPaymentError = null;
      err.promoError = parsed.error;
      throw err;
    }
    const lastPaymentError = normalizeLastPaymentError(parsed);
    // Issuer/processor declines are a payments answer. Prefer card copy
    // even when an older Worker also stamped plan_unavailable.
    if (isIssuerDeclinePayload(lastPaymentError || parsed)) {
      const faced = buyerFacingCheckoutError(lastPaymentError || parsed);
      const err = new Error(faced.message) as Error & {
        lastPaymentError?: LastPaymentErrorLike | null;
      };
      err.name = "CheckoutPaymentError";
      err.lastPaymentError = lastPaymentError;
      throw err;
    }
    const faced = buyerFacingCheckoutError(lastPaymentError || parsed);
    if (faced.message && faced.message !== GENERIC_CHECKOUT_PAY_ERROR) {
      const err = new Error(faced.message) as Error & {
        lastPaymentError?: LastPaymentErrorLike | null;
      };
      err.name = "CheckoutPaymentError";
      err.lastPaymentError = lastPaymentError;
      throw err;
    }
    throw new CheckoutUnavailableError(
      res.status,
      checkoutUnavailableReasonFrom(parsed),
      null
    );
  }

  const json = (await res.json()) as {
    status?: string;
    client_secret?: string | null;
    clientSecret?: string | null;
    payment_id?: string | null;
    paymentId?: string | null;
    bump_error?: string | null;
    bumpError?: string | null;
    bump_payment_ids?: string[];
    bumps_deferred?: boolean;
    last_payment_error?: LastPaymentErrorLike | null;
    lastPaymentError?: LastPaymentErrorLike | null;
    bump_last_payment_error?: LastPaymentErrorLike | null;
    bumpLastPaymentError?: LastPaymentErrorLike | null;
    message?: string | null;
    idempotent?: boolean;
  };
  const paymentId = json.paymentId ?? json.payment_id ?? null;
  const clientSecret = json.clientSecret ?? json.client_secret ?? null;
  if (!clientSecret && !paymentId) {
    throw new Error("confirmWhopPayment: worker returned no payment");
  }
  const bumpError = json.bumpError ?? json.bump_error ?? null;
  const rawLastPaymentError = normalizeLastPaymentError(
    json.lastPaymentError ?? json.last_payment_error ?? null
  );
  const bumpLastPaymentError =
    normalizeLastPaymentError(
      json.bumpLastPaymentError ?? json.bump_last_payment_error ?? null
    ) || (bumpError ? rawLastPaymentError : null);
  return {
    status: json.status || "pending",
    clientSecret,
    paymentId,
    bumpError,
    bumpPaymentIds: json.bump_payment_ids || [],
    bumpsDeferred: !!json.bumps_deferred,
    // A bump decline must not occupy lastPaymentError. Remint helpers
    // treat open/incomplete + lastPaymentError as a dead PRIMARY.
    lastPaymentError: bumpError ? null : rawLastPaymentError,
    bumpLastPaymentError,
    idempotent: json.idempotent === true,
  };
}

export interface WhopPromoQuote {
  code: string;
  promoCodeId: string;
  discountCents: number;
  subtotalCents: number;
  totalCents: number;
  discountLabel: string;
  durationNote: string | null;
}

export function formatWhopMoneyCents(cents: number, currency = "usd"): string {
  const amount = cents / 100;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: String(currency || "usd").toUpperCase(),
    }).format(amount);
  } catch {
    return `$${amount.toFixed(2)}`;
  }
}

function isWhopPromoIdValue(value: string): boolean {
  return /^promo_[A-Za-z0-9_-]{1,120}$/.test(value);
}

// A Worker quote is only applied when it names a promo_… id AND the
// three money fields reconcile. Anything else is a refusal — this is
// what made the live SW-82 FAIL look successful ("will be applied")
// while the price stayed $29.
export function parseWhopPromoQuote(raw: unknown): WhopPromoQuote | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const promo =
    record.promo && typeof record.promo === "object"
      ? (record.promo as Record<string, unknown>)
      : record;
  const code = normalizeWhopPromoCode(promo.code);
  const promoCodeId = String(promo.promo_code_id ?? promo.promoCodeId ?? "");
  const discountCents = Number(promo.discount_cents ?? promo.discountCents);
  const subtotalCents = Number(promo.subtotal_cents ?? promo.subtotalCents);
  const totalCents = Number(promo.total_cents ?? promo.totalCents);
  if (!code || !isWhopPromoIdValue(promoCodeId)) return null;
  if (!Number.isFinite(discountCents) || discountCents <= 0) return null;
  if (!Number.isFinite(subtotalCents) || subtotalCents <= 0) return null;
  if (!Number.isFinite(totalCents) || totalCents < 0) return null;
  if (totalCents !== subtotalCents - discountCents) return null;
  const durationNoteRaw = promo.duration_note ?? promo.durationNote;
  return {
    code,
    promoCodeId,
    discountCents,
    subtotalCents,
    totalCents,
    discountLabel: String(
      promo.discount_label ?? promo.discountLabel ?? `Discount (${code})`
    ),
    durationNote:
      typeof durationNoteRaw === "string" && durationNoteRaw
        ? durationNoteRaw
        : null,
  };
}

function throwCheckoutPromoError(parsed: Record<string, unknown> | null): never {
  const err = new Error(whopPromoErrorMessage(parsed || "promo_unavailable")) as Error & {
    lastPaymentError?: LastPaymentErrorLike | null;
    promoError?: string;
  };
  err.name = "CheckoutPromoError";
  err.lastPaymentError = null;
  err.promoError =
    parsed && isWhopPromoErrorCode(parsed.error)
      ? parsed.error
      : "promo_unavailable";
  throw err;
}

/**
 * Resolve a Model B word / promo_… code and quote it against the plan
 * BEFORE pay. The Payments handle stays at the catalog SUBTOTAL; the
 * returned quote is the host-owned due-today number. A bad code throws
 * CheckoutPromoError — never an optimistic "will be applied".
 */
export async function quoteWhopPromo(input: {
  promoCode: string;
  planId: string;
}): Promise<WhopPromoQuote> {
  if (!input.planId) {
    throw new Error("quoteWhopPromo: planId is required");
  }
  const promoCode = normalizeWhopPromoCode(input.promoCode);
  if (!promoCode) throwCheckoutPromoError({ error: "promo_required" });

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  try {
    const token = localStorage.getItem("overskill_token");
    if (token) headers.Authorization = `Bearer ${token}`;
  } catch {
    // anonymous-safe
  }

  const res = await fetch("/api/whop/promo", {
    method: "POST",
    headers,
    body: JSON.stringify({
      promo_code: promoCode,
      plan_id: input.planId,
    }),
  });

  if (res.status === 429) {
    throw new CheckoutSessionRateLimitError(parseRetryAfterMs(res));
  }

  const body = await safeText(res);
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = body ? (JSON.parse(body) as Record<string, unknown>) : null;
  } catch {
    parsed = null;
  }

  if (!res.ok) {
    throwCheckoutPromoError(
      parsed && isWhopPromoErrorCode(parsed.error)
        ? parsed
        : { error: "promo_unavailable" }
    );
  }

  const quote = parseWhopPromoQuote(parsed);
  if (!quote) throwCheckoutPromoError({ error: "promo_unavailable" });
  return quote;
}

// ---------------------------------------------------------------------------
// completeCheckout
// ---------------------------------------------------------------------------

/**
 * Resolve a Whop checkout that just finished into the {memberId, paymentMethodId}
 * pair needed for follow-on off-session charges.
 *
 * Call this from the WhopCheckoutEmbed's `onComplete` handler. The receiptId
 * comes from the postMessage payload (see WhopCheckoutEmbed docs).
 *
 * The worker looks up the underlying Whop payment + member, lists payment
 * methods, and returns the saved card. If no card was saved (rare), the
 * paymentMethodId comes back as null — upsells won't be possible without
 * collecting a method, so funnels typically branch on that.
 *
 * @example
 * ```tsx
 * // Always reference plan IDs via env vars — never hardcode strings.
 * <WhopCheckoutEmbed
 *   planId={import.meta.env.VITE_PLAN_PRO}
 *   onComplete={async (e) => {
 *     const { memberId, paymentMethodId, capability } = await completeCheckout({
 *       planId: e.planId,
 *       receiptId: e.receiptId,
 *     });
 *     funnel.setIdentity({ memberId, paymentMethodId, whopCapability: capability });
 *     funnel.recordPurchase({ planId: e.planId });
 *     navigate("/upsell-1");
 *   }}
 * />
 * ```
 */
export async function completeCheckout(
  payload: CheckoutCompletePayload
): Promise<CheckoutCompleteResult> {
  // planId is intentionally NOT required — the returnUrl top-redirect
  // path resolves a checkout from just the receipt identifier.
  if (!payload.receiptId) throw new Error("completeCheckout: receiptId is required");

  const res = await fetch("/api/whop/checkout-complete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await safeText(res);
    throw new Error(
      `completeCheckout failed: HTTP ${res.status} ${body || res.statusText}`
    );
  }

  const json = (await res.json()) as {
    member_id?: string;
    memberId?: string;
    payment_method_id?: string | null;
    paymentMethodId?: string | null;
    member_email?: string | null;
    memberEmail?: string | null;
    capability?: string | null;
    whop_capability?: string | null;
  };

  const memberId = json.memberId ?? json.member_id ?? "";
  if (!memberId) {
    throw new Error("completeCheckout: worker returned no memberId");
  }

  const capability = json.capability ?? json.whop_capability ?? null;
  rememberWhopCapability(capability);
  // Stash the receipt for the built-in claim (see claimPurchase). Same
  // motivation as the email stash: the buyer is frequently signed OUT at this
  // moment, so the proof of purchase has to survive the trip through
  // login/signup before it can be spent.
  captureCheckoutReceipt(payload.receiptId);

  return {
    memberId,
    paymentMethodId: json.paymentMethodId ?? json.payment_method_id ?? null,
    memberEmail: json.memberEmail ?? json.member_email ?? null,
    planId: payload.planId,
    receiptId: payload.receiptId,
    capability,
  };
}

// ---------------------------------------------------------------------------
// captureCheckoutEmail / resolveCheckoutEmail — anonymous-buyer email bridge
// for the returnUrl top-redirect path.
// ---------------------------------------------------------------------------

// sessionStorage key shared by the capture + resolve pair (and read by the
// canonical /checkout/complete route guidance).
const CHECKOUT_EMAIL_KEY = "checkout_email";
const WHOP_CAPABILITY_KEY = "whop_capability";
// The receipt of the checkout that just completed, stashed for the same
// reason the email is: it must survive the provider's same-tab top-window
// redirect AND the trip through login/signup, because the buyer often isn't
// signed in at the moment they pay. claimPurchase() spends it.
const CHECKOUT_RECEIPT_KEY = "checkout_receipt_id";
// The checkout-intent token minted for THIS checkout, handed to us by
// createCheckoutSession. Sent with the claim as the corroborating factor that
// proves this browser opened the checkout — the only way a buyer whose
// checkout email differs from their login email can claim their purchase.
const CHECKOUT_INTENT_KEY = "checkout_intent_token";
// Selected bump plan ids stashed before a 3DS full-page redirect so
// /checkout/complete can POST confirm after the primary settles.
const DEFERRED_WHOP_BUMPS_KEY = "whop_deferred_bumps";
// Where the buyer's checkout page lives, stashed before an off-site step
// (3DS / bank redirect / PayPal) leaves the SPA, so a failed|canceled return
// can offer a real "back to checkout" instead of guessing at the home page.
const CHECKOUT_RETURN_PATH_KEY = "whop_checkout_return_path";

export function rememberCheckoutReturnPath(): void {
  try {
    sessionStorage.setItem(
      CHECKOUT_RETURN_PATH_KEY,
      `${window.location.pathname}${window.location.search}`
    );
  } catch {
    // sessionStorage unavailable — the complete page falls back to home.
  }
}

export function readCheckoutReturnPath(): string | null {
  try {
    const stored = sessionStorage.getItem(CHECKOUT_RETURN_PATH_KEY);
    // Same-app path only — never an absolute URL (nothing stored can
    // navigate the buyer off this app).
    return stored && stored.startsWith("/") && !stored.startsWith("//")
      ? stored
      : null;
  } catch {
    return null;
  }
}
// Bounded retry bookkeeping for a stashed receipt whose claim failed for a
// RECOVERABLE reason (see claimPurchase). Stored as ONE record that names the
// receipt it belongs to — a fresh purchase must start with a fresh budget, not
// inherit the exhausted count of the receipt before it.
const CLAIM_RETRY_KEY = "checkout_claim_retry";

// Query-param names a payment provider may use for the receipt/payment
// identifier on the returnUrl redirect. Whop's documented returnUrl params
// (payments/payment.md, 2026-10) are `payment` (the pay_… id), `status`
// (succeeded | failed | canceled | processing…), and `client_secret`; the
// other names are opportunistic for older/self-written links —
// resolveCheckoutEmail scans them all and degrades gracefully when absent.
const RECEIPT_PARAM_NAMES = [
  "receipt_id",
  "receiptId",
  "receipt",
  "payment_id",
  "payment",
  "session_id",
];

// The subset that can carry a RECEIPT specifically. `session_id` is excluded:
// a checkout-session id (`ch_xxx`) is not a receipt, and stashing one would
// guarantee a failed claim. (resolveCheckoutEmail keeps the wider list above —
// it feeds a server-side lookup that simply misses on a non-receipt, and
// narrowing it would change shipped email-prefill behavior for no gain.)
const RECEIPT_ID_PARAM_NAMES = RECEIPT_PARAM_NAMES.filter(
  (name) => name !== "session_id"
);

// Whop receipt ids. Validated before stashing so a session id, an empty
// string, or a stray query value can never be spent as a receipt.
const RECEIPT_ID_PATTERN = /^pay_[A-Za-z0-9_-]{1,120}$/;

/**
 * Stash the buyer's checkout email the moment they type it INSIDE the
 * checkout iframe — pass this directly to the embed's `onIdentityCaptured`
 * prop:
 *
 * ```tsx
 * <WhopCheckoutEmbed
 *   planId={import.meta.env.VITE_PLAN_PRO}
 *   returnUrl={`${window.location.origin}/checkout/complete`}
 *   onIdentityCaptured={captureCheckoutEmail}
 *   onComplete={() => postPurchaseRedirect(navigate, user, { destination: "/dashboard" })}
 * />
 * ```
 *
 * WHY: an anonymous buyer types their email inside the provider's iframe,
 * and after purchase the provider TOP-WINDOW-redirects to /checkout/complete
 * WITHOUT carrying that email. `onIdentityCaptured` is the provider's
 * documented parent-page callback for "email entered or login" — capturing
 * here (sessionStorage survives the same-tab redirect) is what lets
 * /checkout/complete prefill signup with the SAME email the purchase was
 * made under, so the platform reconciles the purchase to the new account
 * by email match.
 */
export function captureCheckoutEmail(data: { email?: string; user_id?: string }): void {
  try {
    if (data && data.email) sessionStorage.setItem(CHECKOUT_EMAIL_KEY, data.email);
  } catch {
    // sessionStorage unavailable (privacy mode) — prefill is best-effort.
  }
}

/**
 * Synchronously read the checkout email captured by `captureCheckoutEmail`
 * (the embed's `onIdentityCaptured` callback). Returns null when none is
 * stored or sessionStorage is unavailable — NEVER throws.
 *
 * This is the sync companion to `resolveCheckoutEmail` (which also does the
 * async server-side receipt lookup). `postPurchaseRedirect` uses it as a
 * fallback so the buyer's checkout email always rides along to login/signup
 * even when the caller forgot to pass `opts.email` — that omission is what
 * left the anonymous-buyer sign-in/sign-up forms blank (#1604/#1660;
 * bolt-buy QA: the captured email was stranded in sessionStorage and the
 * default onComplete never forwarded it).
 */
export function readCapturedCheckoutEmail(): string | null {
  try {
    return sessionStorage.getItem(CHECKOUT_EMAIL_KEY) || null;
  } catch {
    return null;
  }
}

export function readWhopCapability(): string | null {
  try {
    return sessionStorage.getItem(WHOP_CAPABILITY_KEY) || null;
  } catch {
    return null;
  }
}

function rememberWhopCapability(capability?: string | null): void {
  if (!capability) return;
  try {
    sessionStorage.setItem(WHOP_CAPABILITY_KEY, capability);
  } catch {
    // sessionStorage unavailable — callers can still pass capability directly.
  }
}

/**
 * Resolve the buyer's checkout email on the /checkout/complete return route.
 * NEVER throws; returns null when no email is resolvable (callers fall back
 * to the plain login flow — same behavior as before this helper existed).
 *
 * Resolution order:
 *   1. sessionStorage (captured via `onIdentityCaptured={captureCheckoutEmail}`
 *      on the embed — survives the provider's same-tab top-window redirect).
 *   2. Server-side lookup: when the redirect carried a receipt/payment
 *      identifier (e.g. `?receipt_id=...` — not guaranteed by the provider),
 *      POST /api/whop/checkout-complete resolves the buyer email from the
 *      payment record using the app's server-side key.
 *
 * ```tsx
 * const [params] = useSearchParams();
 * const email = (await resolveCheckoutEmail(params)) || undefined;
 * postPurchaseRedirect(navigate, user, { destination: "/dashboard", email });
 * ```
 */
export async function resolveCheckoutEmail(
  params?: URLSearchParams | null
): Promise<string | null> {
  try {
    const stored = sessionStorage.getItem(CHECKOUT_EMAIL_KEY);
    if (stored) return stored;
  } catch {
    // sessionStorage unavailable — fall through to the server lookup.
  }

  const search = params ?? new URLSearchParams(window.location.search);
  let receiptId: string | null = null;
  for (const name of RECEIPT_PARAM_NAMES) {
    const value = search.get(name);
    if (value) {
      receiptId = value;
      break;
    }
  }
  if (!receiptId) return null;

  try {
    const { memberEmail } = await completeCheckout({ receiptId });
    return memberEmail || null;
  } catch (err) {
    // Lookup is best-effort: the buyer can still sign up manually with the
    // same email and the claim reconciles. Don't break the return route.
    console.warn(
      "[whop] resolveCheckoutEmail lookup failed:",
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// claimPurchase — the BUILT-IN "I paid, let me in" grant.
//
// DO NOT hand-build a verify-receipt-then-assignRole endpoint for a standard
// purchase. This is that flow, already wired: the worker hands the receipt to
// the platform, which verifies it against THIS app's own merchant account,
// attaches the purchase to the signed-in buyer, and writes the entitlement
// useEntitlement() reads. Gate your paid features with useEntitlement() /
// RequireRole and let this run.
// ---------------------------------------------------------------------------

export interface ClaimPurchaseResult {
  success: boolean;
  // Machine-readable outcome. Successes: "claimed" (just granted),
  // "already_yours" (you already had it). Failures include "already_claimed"
  // (someone else got there first), "claim_not_corroborated" (we can't tie
  // this purchase to this account), "payment_refunded", "unknown_plan",
  // "company_mismatch", "receipt_not_found", "no_receipt" (nothing stashed),
  // "not_signed_in", "unavailable".
  reason: string;
  // Buyer-safe message from the platform, when it sent one.
  error?: string;
  planId?: string;
}

// Reasons that will NEVER succeed on a retry — the receipt is spent (or the
// answer cannot change), so clear the stash instead of re-POSTing it on every
// page view.
const TERMINAL_CLAIM_REASONS = new Set([
  "claimed",
  "already_yours",
  "already_claimed",
  "payment_refunded",
  "company_mismatch",
  "plan_not_for_app",
  "membership_app_mismatch",
  // The payment is tagged for a different app — a 403 that no amount of
  // retrying can turn into a grant.
  "app_mismatch",
  "invalid_receipt",
  // Nothing the buyer's browser holds will corroborate a later attempt, so
  // retrying only burns rate limit.
  "claim_not_corroborated",
]);

// Reasons that are RECOVERABLE — the same receipt may well succeed later:
//   * receipt_not_found — the payment isn't readable at the provider YET
//     (settlement and read-after-write both lag a completed checkout).
//   * unknown_plan — the creator hasn't registered that plan yet; when they
//     do, this exact receipt becomes claimable.
//   * payment_not_settled — still settling.
//   * provider_unavailable / unavailable / claim_failed — transient.
// Treating these as terminal (the round-1 bug) destroyed the buyer's only
// proof of purchase on the FIRST attempt, which is precisely the "I paid and
// I'm locked out" outcome this feature exists to prevent.
//
// Bounded so a permanently-unclaimable receipt can't retry forever: attempts
// and first-attempt time are stored beside the stash.
const MAX_CLAIM_ATTEMPTS = 8;
const CLAIM_RETRY_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * Is this claim outcome worth another attempt later?
 *
 * `false` for a success and for any permanent refusal (refunded, already
 * someone else's, wrong app, uncorroborated). `true` for the transient shapes —
 * a payment the provider can't read yet, a plan the creator hasn't registered
 * yet, a network blip. Callers that hold a one-shot guard (the auth gate) use
 * this to re-arm; the per-receipt attempt budget still bounds the total.
 */
export function isClaimRetryable(reason?: string | null): boolean {
  if (!reason) return false;
  return !TERMINAL_CLAIM_REASONS.has(reason);
}

/**
 * Stash the receipt of a completed checkout. `completeCheckout()` calls this
 * for you; call it directly on the return route when the redirect carried a
 * receipt in its query string and `completeCheckout()` didn't run.
 *
 * Validates the shape first: a checkout-session id (`ch_xxx`) or a stray query
 * value is not a receipt and must never be stashed as one.
 */
export function captureCheckoutReceipt(receiptId?: string | null): void {
  if (!receiptId || !RECEIPT_ID_PATTERN.test(receiptId)) return;
  try {
    sessionStorage.setItem(CHECKOUT_RECEIPT_KEY, receiptId);
  } catch {
    // sessionStorage unavailable (privacy mode) — the claim can still be run
    // with an explicit receiptId.
  }
}

/** Read the stashed receipt, or null. NEVER throws. */
export function readCapturedCheckoutReceipt(): string | null {
  try {
    return sessionStorage.getItem(CHECKOUT_RECEIPT_KEY) || null;
  } catch {
    return null;
  }
}

/**
 * Forget the stashed receipt, its retry bookkeeping, AND the checkout-intent
 * token that went with it. The token belongs to the same purchase — leaving it
 * behind would attach a stale proof-of-session to the NEXT receipt stashed in
 * this tab. NEVER throws.
 *
 * ⚠️ Calling this DISARMS token corroboration for the rest of this tab. A buyer
 * whose checkout email differs from their login email can then only claim if
 * they sign in with the address they paid with. Only call it when the purchase
 * is genuinely finished with — `claimPurchase()` already clears it at the right
 * moments.
 */
export function clearCapturedCheckoutReceipt(): void {
  try {
    sessionStorage.removeItem(CHECKOUT_RECEIPT_KEY);
    sessionStorage.removeItem(CLAIM_RETRY_KEY);
    sessionStorage.removeItem(CHECKOUT_INTENT_KEY);
    // Do not clear DEFERRED_WHOP_BUMPS_KEY. A terminal primary claim can
    // land while selected bumps are still deferred; that stash is the
    // complete page's planId for the follow-up confirm.
  } catch {
    // Nothing to do — a stale stash is harmless (the claim is idempotent).
  }
}

// Remember the token for the checkout just minted. A NULL/absent token CLEARS
// any previous one: minting a new checkout in this tab means the old token no
// longer describes what the buyer is about to pay for, and a stale token can
// only produce a confusing failed claim.
function rememberCheckoutIntentToken(token?: string | null): void {
  try {
    if (token) {
      sessionStorage.setItem(CHECKOUT_INTENT_KEY, token);
      // Compare against the stash's own token, not CHECKOUT_INTENT_KEY.
      // A terminal claim already cleared that key, so "previous !== token"
      // would miss and keep the prior cart's bumps for a later complete.
      const stash = peekDeferredWhopBumps();
      if (stash && stash.checkoutIntentToken !== token) {
        sessionStorage.removeItem(DEFERRED_WHOP_BUMPS_KEY);
      }
    } else {
      sessionStorage.removeItem(CHECKOUT_INTENT_KEY);
      sessionStorage.removeItem(DEFERRED_WHOP_BUMPS_KEY);
    }
  } catch {
    // sessionStorage unavailable — an email-matching buyer still claims fine.
  }
}

/** The checkout-intent token for the checkout this browser opened, or null. */
export function readCheckoutIntentToken(): string | null {
  try {
    return sessionStorage.getItem(CHECKOUT_INTENT_KEY) || null;
  } catch {
    return null;
  }
}

// A full-page handleNextAction redirect returns before the in-page bump
// follow-up. Stash the selected catalog plan ids so /checkout/complete can
// POST confirm after the primary settles. The Worker also persists
// deferred_bump_ids on the primary record; this stash is the browser half
// (it carries planId, which the complete page otherwise does not have).

export interface DeferredWhopBumps {
  checkoutIntentToken: string;
  planId: string;
  bumpPlanIds: string[];
}

export function stashDeferredWhopBumps(payload: DeferredWhopBumps): void {
  try {
    if (!payload.checkoutIntentToken || !payload.planId || !payload.bumpPlanIds.length) {
      sessionStorage.removeItem(DEFERRED_WHOP_BUMPS_KEY);
      return;
    }
    sessionStorage.setItem(
      DEFERRED_WHOP_BUMPS_KEY,
      JSON.stringify({
        checkoutIntentToken: payload.checkoutIntentToken,
        planId: payload.planId,
        bumpPlanIds: payload.bumpPlanIds,
      })
    );
  } catch {
    // sessionStorage unavailable — Worker-stored deferred_bump_ids still
    // charge if a later confirm can supply planId.
  }
}

export function peekDeferredWhopBumps(): DeferredWhopBumps | null {
  try {
    const raw = sessionStorage.getItem(DEFERRED_WHOP_BUMPS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<DeferredWhopBumps>;
    const bumpPlanIds = Array.isArray(parsed.bumpPlanIds)
      ? parsed.bumpPlanIds.filter((id): id is string => typeof id === "string" && id.startsWith("plan_"))
      : [];
    if (!parsed.checkoutIntentToken || !parsed.planId || !bumpPlanIds.length) {
      return null;
    }
    return {
      checkoutIntentToken: String(parsed.checkoutIntentToken),
      planId: String(parsed.planId),
      bumpPlanIds,
    };
  } catch {
    return null;
  }
}

export function clearDeferredWhopBumps(): void {
  try {
    sessionStorage.removeItem(DEFERRED_WHOP_BUMPS_KEY);
  } catch {
    // nothing to do
  }
}

let deferredBumpChargeInFlight: Promise<void> | null = null;

/**
 * Charge bumps stashed before a 3DS redirect. Fire from /checkout/complete
 * on success. Never throws — a missed bump must not hide the paid primary.
 */
export async function chargeDeferredWhopBumps(): Promise<void> {
  if (deferredBumpChargeInFlight) return deferredBumpChargeInFlight;
  deferredBumpChargeInFlight = chargeDeferredWhopBumpsOnce().finally(() => {
    deferredBumpChargeInFlight = null;
  });
  return deferredBumpChargeInFlight;
}

async function chargeDeferredWhopBumpsOnce(): Promise<void> {
  const stash = peekDeferredWhopBumps();
  if (!stash) return;
  const currentIntent = readCheckoutIntentToken();
  if (currentIntent && currentIntent !== stash.checkoutIntentToken) {
    clearDeferredWhopBumps();
    return;
  }
  try {
    const result = await confirmWhopPayment({
      planId: stash.planId,
      checkoutIntentToken: stash.checkoutIntentToken,
      bumpPlanIds: stash.bumpPlanIds,
    });
    if (result.bumpError) {
      console.error("[whop] deferred bump charge failed:", result.bumpError);
      return;
    }
    // A 200 with payment_id and no bump_error is not enough — a still-deferred
    // follow-up (primary not settled, or a failed payment GET) looks like
    // that and must keep the stash for another try.
    if (deferredWhopBumpsChargeComplete(result)) {
      clearDeferredWhopBumps();
    }
  } catch (error) {
    console.error("[whop] deferred bump charge failed:", error);
  }
}

/** True only when confirm actually charged the selected/deferred bumps. */
export function deferredWhopBumpsChargeComplete(result: ConfirmWhopPaymentResult): boolean {
  return !result.bumpError && !result.bumpsDeferred && result.bumpPaymentIds.length > 0;
}

// Record a recoverable failure against a SPECIFIC receipt and report whether
// that receipt's budget is now exhausted (too many attempts, or first attempt
// older than the retry window). A receipt we haven't seen before starts a
// fresh record, so a second purchase in the same tab never inherits the first
// one's exhausted count. NEVER throws.
function recordRecoverableClaimAttempt(receipt: string): boolean {
  try {
    let record: { r?: string; n?: number; t?: number } = {};
    try {
      record = JSON.parse(sessionStorage.getItem(CLAIM_RETRY_KEY) || "{}") || {};
    } catch {
      record = {};
    }
    if (record.r !== receipt) record = { r: receipt, n: 0, t: Date.now() };

    const attempts = (record.n || 0) + 1;
    const firstAt = record.t || Date.now();
    sessionStorage.setItem(
      CLAIM_RETRY_KEY,
      JSON.stringify({ r: receipt, n: attempts, t: firstAt })
    );

    return (
      attempts >= MAX_CLAIM_ATTEMPTS ||
      Date.now() - firstAt > CLAIM_RETRY_WINDOW_MS
    );
  } catch {
    // No storage to count with — don't loop forever on an unknowable state.
    return true;
  }
}

/**
 * Scan a return URL's query string for a receipt identifier and stash it.
 * Returns the receipt when one was found. Whop's documented return param is
 * `?payment=<pay_…>` (beside `status` and `client_secret`); the other names
 * are opportunistic — the same best-effort scan `resolveCheckoutEmail` does,
 * minus `session_id` (a session id is not a receipt) and validated before
 * stashing.
 */
export function captureCheckoutReceiptFromParams(
  params?: URLSearchParams | null
): string | null {
  let search: URLSearchParams;
  try {
    search = params ?? new URLSearchParams(window.location.search);
  } catch {
    return null;
  }
  for (const name of RECEIPT_ID_PARAM_NAMES) {
    const value = search.get(name);
    if (value && RECEIPT_ID_PATTERN.test(value)) {
      captureCheckoutReceipt(value);
      return value;
    }
  }
  return null;
}

/**
 * Claim a completed purchase for the SIGNED-IN buyer.
 *
 * Pass a receipt, or omit it to spend the one stashed at checkout. Requires a
 * signed-in buyer — the claim attaches the purchase to whoever is asking.
 *
 * FAIL-SOFT BY CONTRACT: this never throws and never rejects. A failed claim
 * must not break the page the buyer is on; `useEntitlement()` keeps polling
 * and the provider's own webhook may still land the grant independently.
 *
 * Idempotent: claiming twice as the same buyer returns `already_yours`, and
 * the receipt is cleared once the outcome can't change.
 *
 * @example
 * ```tsx
 * // On the page the buyer lands on after paying (or after signing in):
 * useEffect(() => { void claimPurchase(); }, []);
 * const entitlement = useEntitlement(); // picks up the grant
 * ```
 */
export async function claimPurchase(
  receiptId?: string | null
): Promise<ClaimPurchaseResult> {
  const stashed = readCapturedCheckoutReceipt();
  const receipt = receiptId || stashed;
  if (!receipt) return { success: false, reason: "no_receipt" };
  // Retry bookkeeping and stash clearing apply ONLY when we're spending the
  // stashed receipt — an explicit one is the caller's to manage.
  const isStashed = receipt === stashed;

  const headers = whopRequestHeaders(null);
  if (!headers.Authorization) {
    // Signed out — keep the receipt stashed; postPurchaseRedirect sends the
    // buyer through login/signup and the claim runs on the far side.
    return { success: false, reason: "not_signed_in" };
  }

  try {
    const res = await fetch("/api/whop/claim", {
      method: "POST",
      headers,
      body: JSON.stringify({
        receiptId: receipt,
        // Corroborating factor: proof this browser opened the checkout. Only
        // needed when the buyer's login email differs from the one they
        // checked out with — harmless to send either way.
        checkoutIntentToken: readCheckoutIntentToken(),
      }),
    });
    const json = (await res.json().catch(() => ({}))) as {
      success?: boolean;
      reason?: string;
      error?: string;
      plan_id?: string;
      planId?: string;
    };

    const success = res.ok && json.success === true;
    const reason = json.reason || (success ? "claimed" : "unavailable");

    // Only the STASHED receipt has a stash to manage. A caller passing an
    // explicit receipt must not spend the stashed one's retry budget, and must
    // never clear a DIFFERENT purchase's stash on its own exhaustion.
    if (isStashed) {
      if (TERMINAL_CLAIM_REASONS.has(reason)) {
        clearCapturedCheckoutReceipt();
      } else if (recordRecoverableClaimAttempt(receipt)) {
        // Recoverable, but we've retried enough (or long enough) — stop
        // holding a receipt that is never going to land.
        clearCapturedCheckoutReceipt();
      }
    }

    return {
      success,
      reason,
      error: json.error,
      planId: json.planId ?? json.plan_id,
    };
  } catch (err) {
    // Network/parse failure — recoverable, so keep the receipt (subject to the
    // same bounded retry policy) and let a later attempt land the grant.
    console.warn(
      "[whop] claimPurchase failed:",
      err instanceof Error ? err.message : err
    );
    if (isStashed && recordRecoverableClaimAttempt(receipt)) {
      clearCapturedCheckoutReceipt();
    }
    return { success: false, reason: "unavailable" };
  }
}

// ---------------------------------------------------------------------------
// resolvePaidCheckoutRedirect — in-page Model B success after confirm.
// ---------------------------------------------------------------------------

/**
 * Statuses that mean the primary charge is paid. Shared by the Worker
 * (`whopPaymentNeedsNextAction`) and handleNextAction. `success` is the
 * extra alias some next-action payloads use; it is not a Worker status.
 */
export const PAID_CHECKOUT_STATUSES = [
  "succeeded",
  "paid",
  "complete",
  "success",
] as const;

export function isPaidCheckoutStatus(status: unknown): boolean {
  if (typeof status !== "string") return false;
  const normalized = status.trim().toLowerCase();
  return (PAID_CHECKOUT_STATUSES as readonly string[]).includes(normalized);
}

/**
 * Terminal decline / cancel statuses. Distinct from "not yet paid"
 * (`open`, `pending`, `incomplete`) — those also fail the paid check,
 * but these must lose even if another field looks settled.
 *
 * Northline / joaMke (2026-08-31): Whop minted pay_31tb9M0Tp5WjiA on a
 * CVC decline (Visa ••5387). Events were payment.created open/incomplete
 * then payment.failed open/failed. Nothing captured. A paymentId is
 * not a charge.
 */
export const FAILED_CHECKOUT_STATUSES = [
  "failed",
  "declined",
  "canceled",
  "cancelled",
  "voided",
] as const;

export function isFailedCheckoutStatus(status: unknown): boolean {
  if (typeof status !== "string") return false;
  const normalized = status.trim().toLowerCase();
  return (FAILED_CHECKOUT_STATUSES as readonly string[]).includes(normalized);
}

/**
 * Create-time lifecycle values that are not a captured charge.
 * Northline's CVC decline was `open` / `incomplete` (then `open` /
 * `failed`). `pending` is NOT here — Worker confirm defaults omitted
 * status to `pending` and the no-3DS harness returns `pending` with
 * no client_secret for a captured primary.
 */
export const UNSETTLED_CHECKOUT_STATUSES = [
  "open",
  "incomplete",
  "requires_action",
  "requires_confirmation",
  "processing",
] as const;

export function isUnsettledCheckoutStatus(status: unknown): boolean {
  if (typeof status !== "string") return false;
  const normalized = status.trim().toLowerCase();
  return (UNSETTLED_CHECKOUT_STATUSES as readonly string[]).includes(normalized);
}

export function isPendingCheckoutStatus(status: unknown): boolean {
  if (typeof status !== "string") return false;
  return status.trim().toLowerCase() === "pending";
}

export function isProcessingCheckoutStatus(status: unknown): boolean {
  if (typeof status !== "string") return false;
  return status.trim().toLowerCase() === "processing";
}

// --- checkout return status (the /checkout/complete query contract) ---
// Whop appends `?payment=<pay_…>&status=<status>&client_secret=` to the
// returnUrl when an off-site step (iDEAL, Bancontact, PayPal, full-page 3DS)
// navigates the tab away and back. Documented statuses: succeeded | failed |
// canceled | processing (plus pending-family values). Our own in-SPA paths
// write `status=success|error`. The complete page treats the query as a
// DISPLAY of the outcome, never as proof of payment — fulfillment stays
// webhook-driven (payment.succeeded).

export function isSuccessCheckoutReturnStatus(
  status: string | null | undefined
): boolean {
  if (typeof status !== "string") return false;
  const normalized = status.trim().toLowerCase();
  return normalized === "success" || normalized === "succeeded";
}

export function isErrorCheckoutReturnStatus(
  status: string | null | undefined
): boolean {
  if (typeof status !== "string") return false;
  const normalized = status.trim().toLowerCase();
  return (
    normalized === "error" ||
    normalized === "failed" ||
    normalized === "canceled" ||
    normalized === "cancelled"
  );
}

// A charge still being decided (ACH / SEPA / bank transfers settle in days;
// a dismissed 3DS dialog leaves requires_action). NOT an error — the buyer
// may still be charged, so the page must never say "no charge was made";
// the grant lands via the payment.succeeded webhook when it clears.
export function isPendingCheckoutReturnStatus(
  status: string | null | undefined
): boolean {
  if (typeof status !== "string") return false;
  const normalized = status.trim().toLowerCase();
  return (
    normalized === "processing" ||
    normalized === "pending" ||
    normalized === "requires_action"
  );
}
// --- end checkout return status ---

/**
 * Public claim+login hop when the server-minted redirect is missing.
 * `status=success` is what `/checkout/complete` keys the confirming window
 * and deferred-bump charge on. A `pay_*` id rides `payment_id` so the
 * complete page can stash the receipt for claimPurchase.
 */
export function fallbackPaidCheckoutPath(paymentId?: string | null): string {
  const params = new URLSearchParams({ status: "success" });
  if (typeof paymentId === "string" && RECEIPT_ID_PATTERN.test(paymentId)) {
    params.set("payment_id", paymentId);
  }
  return `/checkout/complete?${params.toString()}`;
}

/**
 * `/checkout/complete` keys the confirming window and deferred-bump
 * charge on `status=success`. The server-minted redirect is the bare
 * path (`https://host/checkout/complete`) — assigning it as-is after a
 * paid confirm skipped both. Keep the server host; only add the query
 * the complete page already documents. Leave any other destination
 * untouched (never invent a return host).
 */
export function withPaidCheckoutQuery(
  url: string,
  paymentId?: string | null
): string {
  try {
    const absolute = /^https?:\/\//i.test(url);
    const parsed = new URL(url, "https://overskill.invalid");
    if (!/\/checkout\/complete\/?$/.test(parsed.pathname)) return url;
    if (parsed.searchParams.get("status") !== "error") {
      parsed.searchParams.set("status", "success");
    }
    if (
      typeof paymentId === "string" &&
      RECEIPT_ID_PATTERN.test(paymentId) &&
      !parsed.searchParams.get("payment_id") &&
      !parsed.searchParams.get("receipt_id")
    ) {
      parsed.searchParams.set("payment_id", paymentId);
    }
    if (!absolute) return `${parsed.pathname}${parsed.search}`;
    return parsed.toString();
  } catch {
    return url;
  }
}

export interface PaidCheckoutRedirectInput {
  paymentId?: string | null;
  redirectUrl?: string | null;
  confirmStatus?: string | null;
  nextActionStatus?: string | null;
  nextActionError?: { message?: string | null } | null;
  nextActionAttempted?: boolean;
  // After a bounded wait, a follow-up confirm may report the no-3DS
  // captured alias (`pending`) even though handleNextAction ran.
  settlementWaited?: boolean;
}

export type PaidCheckoutRedirectDecision =
  | { ok: true; url: string }
  | { ok: false };

/**
 * After POST /api/whop/confirm (and optional handleNextAction), decide
 * whether the buyer already paid and where to send them.
 *
 * Harbor Lane / NDRQbJ (2026-08-31): a settled charge with no
 * redirectUrl must still leave checkout. Use the server redirect when
 * present; otherwise the public /checkout/complete claim+login hop.
 * Never show checkout-failed copy after a successful charge. Whop
 * collects in the background — create-time status is often `pending`
 * (Worker harness + confirmWhopPayment default), not a paid alias.
 * A pay_* with no next action and `pending` is that captured path.
 *
 * Northline / joaMke (2026-08-31): a paymentId is NOT settlement.
 * Whop emits pay_* on payment.created, including CVC failure
 * (`open` / `incomplete` then `open` / `failed`). lastPaymentError
 * and failed / open / incomplete statuses stay on the form.
 * Unrecognized next-action is not success unless confirm already
 * reported paid (or the no-3DS pending capture above).
 *
 * Northline / joaMke (2026-09-02): `processing` + no last_payment_error
 * is NOT a terminal fail. handleNextAction returned processing on
 * pay_gvbhkHc5xLkSWV (correct CVC); Whop captured; the form showed
 * GENERIC_CHECKOUT_PAY_ERROR. Inverse of the success-lie — money
 * moved, page said fail. Wait until paid or failed. After that wait,
 * a paid confirm or a pending/paid NEXT-ACTION is a capture (deferred
 * bumps charge on /checkout/complete). Create-time confirm `pending`
 * is not — that is the Worker default and must not skip the wait or
 * stamp settlementWaited. `processing` itself is never paid.
 */
export function resolvePaidCheckoutRedirect(
  input: PaidCheckoutRedirectInput
): PaidCheckoutRedirectDecision {
  if (input.nextActionError) return { ok: false };
  if (
    isFailedCheckoutStatus(input.confirmStatus) ||
    isFailedCheckoutStatus(input.nextActionStatus)
  ) {
    return { ok: false };
  }
  const paymentId =
    typeof input.paymentId === "string" && input.paymentId.trim()
      ? input.paymentId.trim()
      : null;
  const capturedWithoutNextAction =
    !!paymentId &&
    !input.nextActionAttempted &&
    isPendingCheckoutStatus(input.confirmStatus);
  // Create-time confirm is often `pending` (Worker default). That is
  // NOT a capture once handleNextAction ran — capturedWithoutNextAction
  // required no next-action for that reason. A later invalid_cvc must
  // not hit /checkout/complete. After a real wait, only a paid status
  // or a pending NEXT-ACTION (handleNextAction captured alias) is paid.
  const capturedAfterSettlementWait =
    !!paymentId &&
    !!input.settlementWaited &&
    (isPaidCheckoutStatus(input.confirmStatus) ||
      isPaidCheckoutStatus(input.nextActionStatus) ||
      isPendingCheckoutStatus(input.nextActionStatus));
  const paid =
    isPaidCheckoutStatus(input.confirmStatus) ||
    isPaidCheckoutStatus(input.nextActionStatus) ||
    isPendingCheckoutStatus(input.nextActionStatus) ||
    capturedWithoutNextAction ||
    capturedAfterSettlementWait;
  if (!paid) return { ok: false };
  const redirectUrl =
    typeof input.redirectUrl === "string" && input.redirectUrl.trim()
      ? input.redirectUrl.trim()
      : null;
  return {
    ok: true,
    url: withPaidCheckoutQuery(
      redirectUrl || fallbackPaidCheckoutPath(paymentId),
      paymentId
    ),
  };
}

// ---------------------------------------------------------------------------
// buyerFacingCheckoutError — Whop decline copy + dead-intent retry.
// Northline / joaMke (2026-09-01): a declined CVC still minted pay_*
// and Worker confirm is idempotent on intent+plan, so the next Pay
// reused that dead payment. last_payment_error.message was dropped
// for a generic host sentence. Prefer Whop's copy; remint the intent
// after a dead payment so the next click POSTs a new pay_*.
// ---------------------------------------------------------------------------

export const GENERIC_CHECKOUT_PAY_ERROR =
  "We couldn't complete checkout. Please try again.";

// Fallback when Whop sent decline_code but no human message.
// Prefer last_payment_error.message when it is usable.
export const CHECKOUT_DECLINE_COPY = {
  invalid_cvc:
    "The security code (CVC) is incorrect. Please check the 3-4 digit code on the back of your card.",
  incorrect_cvc:
    "The security code (CVC) is incorrect. Please check the 3-4 digit code on the back of your card.",
  insufficient_funds: "Your card has insufficient funds.",
  expired_card: "Your card has expired.",
  incorrect_number: "Your card number is incorrect.",
  invalid_number: "Your card number is incorrect.",
  lost_card: "Your card was declined.",
  stolen_card: "Your card was declined.",
  generic_decline: "Your card was declined.",
  card_declined: "Your card was declined.",
  do_not_honor: "Your card was declined.",
  processing_error:
    "The card issuer could not process this payment. Please try again.",
  incorrect_zip: "The postal code does not match this card.",
  postal_code_invalid: "The postal code does not match this card.",
  fraudulent:
    "Your card was declined. Please try a different card or contact your bank.",
  suspected_fraud:
    "Your card was declined. Please try a different card or contact your bank.",
  highest_risk_level:
    "Your card was declined. Please try a different card or contact your bank.",
  pickup_card: "Your card was declined.",
  restricted_card: "Your card was declined.",
  security_violation: "Your card was declined.",
  transaction_not_allowed: "Your card was declined.",
  try_again_later: "Your card was declined. Please try again in a moment.",
  card_velocity_exceeded: "Your card was declined. Please try again later.",
  withdrawal_count_limit_exceeded:
    "Your card was declined. Please try again later.",
  authentication_required:
    "Your bank needs to confirm this payment. Please try again.",
};

const CARD_DECLINE_CODES = {
  invalid_cvc: true,
  incorrect_cvc: true,
  insufficient_funds: true,
  expired_card: true,
  incorrect_number: true,
  invalid_number: true,
  lost_card: true,
  stolen_card: true,
  generic_decline: true,
  card_declined: true,
  do_not_honor: true,
  processing_error: true,
  incorrect_zip: true,
  postal_code_invalid: true,
  fraudulent: true,
  suspected_fraud: true,
  highest_risk_level: true,
  pickup_card: true,
  restricted_card: true,
  security_violation: true,
  transaction_not_allowed: true,
  try_again_later: true,
  card_velocity_exceeded: true,
  withdrawal_count_limit_exceeded: true,
  authentication_required: true,
};

export function normalizeLastPaymentError(raw: unknown): LastPaymentErrorLike | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as any;
  const nested = record.last_payment_error || record.lastPaymentError;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    return normalizeLastPaymentError(nested);
  }
  const inner = record.error;
  if (inner && typeof inner === "object" && !Array.isArray(inner)) {
    const fromInner = normalizeLastPaymentError(inner);
    if (fromInner) return fromInner;
  }
  const code = typeof record.code === "string" ? record.code.trim() : "";
  const declineCode =
    (typeof record.decline_code === "string" && record.decline_code.trim()) ||
    (typeof record.declineCode === "string" && record.declineCode.trim()) ||
    "";
  const message = typeof record.message === "string" ? record.message.trim() : "";
  if (!code && !declineCode && !message) return null;
  return {
    code: code || null,
    decline_code: declineCode || null,
    message: message || null,
  };
}

export function declineCodeOf(error: unknown) {
  const normalized = normalizeLastPaymentError(error);
  if (!normalized || !normalized.decline_code) return "";
  return String(normalized.decline_code).trim().toLowerCase();
}

export function isIssuerDeclineCode(code: unknown) {
  if (typeof code !== "string") return false;
  const normalized = code.trim().toLowerCase();
  return !!normalized && !!(CARD_DECLINE_CODES as any)[normalized];
}

export function isIssuerDeclinePayload(input: unknown) {
  if (!input || typeof input !== "object") return false;
  const record = input as any;
  if (isFailedCheckoutStatus(record.status)) return true;
  const last = lastPaymentErrorFrom(input) || normalizeLastPaymentError(input);
  if (!last) return false;
  if (isIssuerDeclineCode(last.decline_code) || isIssuerDeclineCode(last.code)) {
    return true;
  }
  if (last.decline_code) return true;
  const message = usableBuyerCheckoutMessage(last.message);
  return !!(
    message &&
    /card was declined|insufficient|security code|cvc|expired|fraud|suspicious|do not honor|contact your bank/i.test(
      message
    )
  );
}

export function checkoutUnavailableReasonFrom(
  input: unknown
): CheckoutUnavailableReason | null {
  if (isIssuerDeclinePayload(input)) return null;
  const record = input && typeof input === "object" ? (input as any) : {};
  const candidates = [record.reason, record.error];
  for (let i = 0; i < candidates.length; i++) {
    const value = candidates[i];
    if (typeof value !== "string") continue;
    // Keep this list aligned with CheckoutUnavailableReason. Do not treat
    // confirm_refused / bump_charge_* as an unavailable plan.
    if (
      value === "plan_unavailable" ||
      value === "payments_not_configured" ||
      value === "origin_not_allowed" ||
      value === "origin_mismatch" ||
      value === "preview_origin" ||
      value === "proxied_origin" ||
      value === "app_not_live" ||
      value === "unknown_app" ||
      value === "bad_request" ||
      value === "staging_environment" ||
      value === "dispatch_not_configured" ||
      value === "rate_limited" ||
      value === "upstream_error" ||
      value === "provider_unavailable"
    ) {
      return value as CheckoutUnavailableReason;
    }
  }
  return null;
}

export function usableBuyerCheckoutMessage(value: unknown) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed === GENERIC_CHECKOUT_PAY_ERROR) return undefined;
  if (/^[a-z0-9]+(?:_[a-z0-9]+)+$/i.test(trimmed)) return undefined;
  if (
    /confirmWhopPayment|createConfirmationToken|worker returned|Failed to fetch|payments_not_ready|NetworkError|checkout_rate_limited/i.test(
      trimmed
    )
  ) {
    return undefined;
  }
  if (trimmed.length > 400) return trimmed.slice(0, 400);
  return trimmed;
}

// Buyer-facing copy for Model B promo resolve/confirm. Keep lockstep with
// Checkout::PromoCode::ERRORS / app/javascript/checkout/promo_code.ts and
// the Worker `whopPromoBuyerMessage` twin. A present code that cannot be
// resolved is never charged at full price in silence (SW-82 / #6402).
// Lives in the PAID_CHECKOUT_STATUSES…resolvePostPurchaseDestination
// slice so template_whop_paid_checkout_redirect.test.js can eval it.
export const WHOP_PROMO_ERROR_COPY = {
  promo_required: "Enter a promo code.",
  promo_unknown: "That code isn't valid.",
  promo_inactive: "That code isn't active any more.",
  promo_expired: "That code has expired.",
  promo_used_up: "That code has already been used.",
  promo_not_applicable: "That code doesn't apply to this plan.",
  promo_rejected: "That code doesn't apply to this plan.",
  promo_unavailable: "We couldn't check that code. Please try again.",
} as const;

export type WhopPromoErrorCode = keyof typeof WHOP_PROMO_ERROR_COPY;

export function isWhopPromoErrorCode(value: unknown): value is WhopPromoErrorCode {
  return typeof value === "string" && value in WHOP_PROMO_ERROR_COPY;
}

export function whopPromoErrorMessage(error: unknown): string {
  if (isWhopPromoErrorCode(error)) return WHOP_PROMO_ERROR_COPY[error];
  if (error && typeof error === "object") {
    const record = error as { error?: unknown; code?: unknown; message?: unknown };
    if (isWhopPromoErrorCode(record.error)) return WHOP_PROMO_ERROR_COPY[record.error];
    if (isWhopPromoErrorCode(record.code)) return WHOP_PROMO_ERROR_COPY[record.code];
    const message = usableBuyerCheckoutMessage(record.message);
    if (message) return message;
  }
  return "We couldn't apply that code. Please try again.";
}

// last_payment_error only — never a raw Error or a confirm result blob.
// Treating Error.message as a decline leaked confirmWhopPayment internals.
export function lastPaymentErrorFrom(input: unknown) {
  if (input instanceof Error) {
    const attached = (input as any).lastPaymentError;
    if (input.name === "CheckoutPaymentError" && attached) {
      return normalizeLastPaymentError(attached);
    }
    return null;
  }
  if (!input || typeof input !== "object") return null;
  const record = input as any;
  return normalizeLastPaymentError(
    record.lastPaymentError || record.last_payment_error || input
  );
}

export function isDeadCheckoutPayment(input: unknown) {
  const record = input && typeof input === "object" ? (input as any) : {};
  const status = record.status;
  const lastPaymentError = lastPaymentErrorFrom(input);
  if (isFailedCheckoutStatus(status)) return true;
  // pending is the no-3DS captured alias. paid is settled. Neither is
  // a dead attempt even if a leftover last_payment_error rides along.
  if (isPaidCheckoutStatus(status) || isPendingCheckoutStatus(status)) {
    return false;
  }
  // A declined bump's last_payment_error can ride the same 200 as an
  // open/incomplete primary. That is not a dead primary — remint would
  // look like the first charge failed and risk a second one.
  if (record.bumpError || record.bump_error) return false;
  return !!lastPaymentError;
}

// Worker confirm keys idempotency on intent+plan. Remint ONLY a
// truly dead / declined payment so the next Pay is a new intent.
// Never retire pending / processing / open with a live pay_* —
// unrecognized handleNextAction already stays on the form, and a
// remint there can charge a second time while the first captures.
export function shouldRetireCheckoutIntent(input: unknown) {
  const record = input && typeof input === "object" ? (input as any) : {};
  if (record.paid === true) return false;
  if (isPaidCheckoutStatus(record.status) || isPendingCheckoutStatus(record.status)) {
    return false;
  }
  return isDeadCheckoutPayment(input);
}

export function checkoutErrorSurface(input: unknown) {
  const record = input && typeof input === "object" ? (input as any) : {};
  if (isWhopPromoErrorCode(record.error) || isWhopPromoErrorCode(record.promoError) || record.name === "CheckoutPromoError") {
    return "promo";
  }
  const missing: string[] = Array.isArray(record.missing)
    ? record.missing.map(function (item: unknown) {
        return String(item);
      })
    : [];
  if (missing.indexOf("email") !== -1 && missing.length === 1) return "email";
  if (missing.indexOf("name") !== -1 && !missing.some(function (item) {
    return item.indexOf("address") === 0;
  })) {
    return "name";
  }
  if (missing.some(function (item) {
    return item.indexOf("address") === 0;
  })) {
    return "card";
  }
  if (missing.indexOf("email") !== -1) return "email";
  const decline = declineCodeOf(input);
  if (decline && (CARD_DECLINE_CODES as any)[decline]) {
    return "card";
  }
  const nestedMessage =
    record.lastPaymentError && typeof record.lastPaymentError === "object"
      ? record.lastPaymentError.message
      : null;
  const message = usableBuyerCheckoutMessage(record.message || nestedMessage);
  if (
    message &&
    /cvc|security code|card number|card has|card was declined|your card was declined|expired|insufficient|contact your bank|try a different card/i.test(
      message
    )
  ) {
    return "card";
  }
  if (message && /\bemail\b/i.test(message)) return "email";
  if (message && /\bname\b/i.test(message) && !/cardholder/i.test(message)) return "name";
  if (decline) return "card";
  return "generic";
}

export function buyerFacingCheckoutError(input: unknown) {
  const record = input && typeof input === "object" ? (input as any) : {};
  if (
    input instanceof Error && input.name === "CheckoutPromoError"
  ) {
    return {
      message: whopPromoErrorMessage(input),
      surface: "promo" as const,
      declineCode: null,
      code: (input as Error & { promoError?: string }).promoError || "promo_unknown",
    };
  }
  if (isWhopPromoErrorCode(record.error) || isWhopPromoErrorCode(record.promoError)) {
    return {
      message: whopPromoErrorMessage(record),
      surface: "promo" as const,
      declineCode: null,
      code: record.error || record.promoError,
    };
  }
  const missing = Array.isArray(record.missing) ? record.missing.map(String) : [];
  if (missing.length) {
    const surface = checkoutErrorSurface({ missing });
    if (surface === "email") {
      return { message: "Enter your email to continue.", surface };
    }
    if (surface === "name") {
      return { message: "Enter the name on the card.", surface };
    }
    if (surface === "card") {
      return { message: "Enter the billing address for this card.", surface };
    }
    return { message: GENERIC_CHECKOUT_PAY_ERROR, surface: "generic" };
  }
  const lastPaymentError = lastPaymentErrorFrom(input);
  const decline = declineCodeOf(lastPaymentError);
  const fromWhop = usableBuyerCheckoutMessage(
    lastPaymentError && lastPaymentError.message
  );
  const mapped = decline && (CHECKOUT_DECLINE_COPY as any)[decline];
  const fromThrown =
    input instanceof Error && input.name === "CheckoutPaymentError"
      ? usableBuyerCheckoutMessage(input.message)
      : undefined;
  const message =
    fromWhop || mapped || fromThrown || GENERIC_CHECKOUT_PAY_ERROR;
  return {
    message,
    surface: checkoutErrorSurface({
      missing,
      message,
      lastPaymentError,
    }),
    declineCode: decline || null,
    code: (lastPaymentError && lastPaymentError.code) || null,
  };
}

// Northline / joaMke (2026-09-02): handleNextAction returned processing
// with last_payment_error null (~2s). payment.failed + invalid_cvc landed
// ~6s later. Bound the wait; prefer a real last_payment_error over the
// generic host sentence. Do not wait forever.
export const CHECKOUT_SETTLEMENT_POLL_MS = 400;
export const CHECKOUT_SETTLEMENT_MAX_MS = 8000;

export function shouldWaitForCheckoutSettlement(input: unknown) {
  const record = input && typeof input === "object" ? (input as any) : {};
  if (!record.nextActionAttempted) return false;
  if (record.nextActionError) return false;
  if (lastPaymentErrorFrom(record.lastPaymentError || record)) return false;
  if (
    isPaidCheckoutStatus(record.nextActionStatus) ||
    isPaidCheckoutStatus(record.confirmStatus) ||
    isPendingCheckoutStatus(record.nextActionStatus)
  ) {
    return false;
  }
  if (
    isFailedCheckoutStatus(record.nextActionStatus) ||
    isFailedCheckoutStatus(record.confirmStatus)
  ) {
    return false;
  }
  // Only `processing` is the Northline in-flight race. Waiting on
  // requires_action / open / pending re-invokes handleNextAction and
  // can replay 3DS or hold a captured pending until the generic fail.
  return (
    isProcessingCheckoutStatus(record.nextActionStatus) ||
    isProcessingCheckoutStatus(record.confirmStatus)
  );
}

export async function awaitCheckoutSettlement(opts: unknown) {
  const o = opts && typeof opts === "object" ? (opts as any) : {};
  const readStatus = o.readStatus;
  const now = typeof o.now === "function" ? o.now : Date.now;
  const sleep =
    typeof o.sleep === "function"
      ? o.sleep
      : function (ms: unknown) {
          return new Promise(function (resolve) {
            setTimeout(resolve, ms as any);
          });
        };
  const pollMs =
    typeof o.pollMs === "number" && o.pollMs > 0
      ? o.pollMs
      : CHECKOUT_SETTLEMENT_POLL_MS;
  const maxMs =
    typeof o.maxMs === "number" && o.maxMs > 0
      ? o.maxMs
      : CHECKOUT_SETTLEMENT_MAX_MS;
  let latest = o.initial && typeof o.initial === "object" ? o.initial : {};
  const started = now();

  function snapshotOf(raw: unknown) {
    const record = raw && typeof raw === "object" ? (raw as any) : {};
    return {
      status: record.status || null,
      lastPaymentError: lastPaymentErrorFrom(record.lastPaymentError || record),
      redirected: !!record.redirected,
    };
  }

  function stillProcessing(snap: unknown) {
    const s = snap && typeof snap === "object" ? (snap as any) : {};
    if (s.redirected) return false;
    if (s.lastPaymentError) return false;
    return isProcessingCheckoutStatus(s.status);
  }

  let snap = snapshotOf(latest);
  if (!stillProcessing(snap)) {
    return Object.assign({ timedOut: false }, snap);
  }

  while (now() - started < maxMs) {
    await sleep(pollMs);
    if (typeof readStatus === "function") {
      try {
        latest = await readStatus();
      } catch (_err) {
        // keep last snapshot; still bound by maxMs
      }
    }
    snap = snapshotOf(latest);
    if (!stillProcessing(snap)) {
      return Object.assign({ timedOut: false }, snap);
    }
  }
  return Object.assign({ timedOut: true }, snap);
}

// Host highlight targets. Card/CVC live in Whop's Amber iframe — ring
// the host payment container. Do not claim we can style the inner CVC.
export function checkoutHostInvalidSelector(surface: unknown) {
  if (surface === "email") {
    return 'input[autocomplete="email"], input[type="email"]';
  }
  if (surface === "name") {
    return 'input[autocomplete="name"], input[autocomplete="given-name"]';
  }
  if (surface === "card") {
    return '[data-testid="whop-card-element"], [data-testid="whop-payment-element"]';
  }
  if (surface === "promo") {
    return '[data-testid="whop-promo-input"]';
  }
  return null;
}

// Northline / joaMke (2026-09-02): after a CVC decline, the next Pay
// reused checkout_intent_token (Worker idempotent:true + the dead
// pay_*). handleNextAction then re-read invalid_cvc and showed the old
// CVC sentence on the corrected code. Remint first; do not run
// handleNextAction on that reuse. A knownDeadPaymentId catches the
// case where Worker cache still says open and omitted last_payment_error.
export function isIdempotentDeadPaymentReuse(
  input: unknown,
  knownDeadPaymentId: unknown
) {
  const record = input && typeof input === "object" ? (input as any) : {};
  if (record.idempotent !== true && record.idempotent !== "true") return false;
  if (record.paid === true) return false;
  if (isPaidCheckoutStatus(record.status) || isPendingCheckoutStatus(record.status)) {
    return false;
  }
  if (isDeadCheckoutPayment(input)) return true;
  const paymentId =
    (typeof record.paymentId === "string" && record.paymentId.trim()) ||
    (typeof record.payment_id === "string" && record.payment_id.trim()) ||
    "";
  const known =
    typeof knownDeadPaymentId === "string" ? knownDeadPaymentId.trim() : "";
  return !!(known && paymentId && paymentId === known);
}

// processing + no last_payment_error is in-flight, not a decline.
// Jason's pay_gvbhkHc5xLkSWV captured while the UI showed generic fail.
export function isInFlightCheckoutSettlement(input: unknown) {
  const record = input && typeof input === "object" ? (input as any) : {};
  if (lastPaymentErrorFrom(record.lastPaymentError || record)) return false;
  if (record.nextActionError) return false;
  if (
    isPaidCheckoutStatus(record.nextActionStatus) ||
    isPaidCheckoutStatus(record.confirmStatus) ||
    isPaidCheckoutStatus(record.status)
  ) {
    return false;
  }
  if (
    isFailedCheckoutStatus(record.nextActionStatus) ||
    isFailedCheckoutStatus(record.confirmStatus) ||
    isFailedCheckoutStatus(record.status)
  ) {
    return false;
  }
  if (
    isPendingCheckoutStatus(record.confirmStatus) &&
    !record.nextActionAttempted
  ) {
    return false;
  }
  const status =
    record.nextActionStatus || record.confirmStatus || record.status;
  return isUnsettledCheckoutStatus(status);
}

// Remint ONLY a dead / declined payment. Worker confirm is keyed on
// intent+plan and does not void the first pay_*. A still-processing
// or open payment with no last_payment_error must keep the same
// intent — remint there is a second charge (PR #5763 security HIGH).
// A next-action attempt or stay-on-form flag is not a remint reason.
export function shouldRemintAfterUnpaidCheckout(input: unknown) {
  const record = input && typeof input === "object" ? (input as any) : {};
  if (record.paid === true) return false;
  if (
    isPaidCheckoutStatus(record.status) ||
    isPendingCheckoutStatus(record.status) ||
    isPaidCheckoutStatus(record.nextActionStatus) ||
    isPaidCheckoutStatus(record.confirmStatus) ||
    isPendingCheckoutStatus(record.confirmStatus)
  ) {
    return false;
  }
  if (isInFlightCheckoutSettlement(input)) return false;
  const lastPaymentError = lastPaymentErrorFrom(
    record.lastPaymentError || record
  );
  if (!lastPaymentError && !record.nextActionError) {
    const live = [
      record.status,
      record.nextActionStatus,
      record.confirmStatus,
    ];
    for (let i = 0; i < live.length; i++) {
      if (isUnsettledCheckoutStatus(live[i])) return false;
    }
  }
  return shouldRetireCheckoutIntent(input);
}

// ---------------------------------------------------------------------------
// resolvePostPurchaseDestination — where the buyer lands once they're IN.
// ---------------------------------------------------------------------------

/**
 * Resolve the post-purchase / post-signup destination: the app's PRIMARY
 * authenticated surface — the route that actually renders the feature the
 * buyer paid for.
 *
 * Resolution order (mirrors the OAuth callback's post-login route in
 * `src/routes/callback.tsx` — `storedRedirect || VITE_POST_LOGIN_ROUTE ||
 * '/dashboard'` — so the page a buyer lands on after a PURCHASE is the SAME
 * one they'd reach after a normal login, never a divergent hardcoded
 * literal):
 *   1. An explicit `destination` the caller passed (the offer page knows
 *      exactly where its paid feature lives — strongly preferred).
 *   2. `import.meta.env.VITE_POST_LOGIN_ROUTE` — the app's configured
 *      primary authenticated route. Setting this makes the fallback follow
 *      the app's REAL main surface (e.g. `/studio`, `/workspace`) instead of
 *      a hardcoded `/dashboard`.
 *   3. `/dashboard` — last-resort literal (the template's default protected
 *      route).
 *
 * WHY (issue #2524, app eVPKEj / "Thumbnail Studio"): the old hardcoded
 * `/dashboard` fallback dropped a paying buyer on a leftover PLACEHOLDER
 * `/dashboard` route that was never wired to the app's actual feature
 * (`/studio`) — a real dead-end after a real purchase, even though checkout
 * AND auth both succeeded. Tie the fallback to `VITE_POST_LOGIN_ROUTE` so
 * the destination follows the app's configured primary surface, and pass an
 * explicit `destination` from the offer page whenever the feature route is
 * known.
 */
export function resolvePostPurchaseDestination(explicit?: string | null): string {
  if (explicit) return explicit;

  const envRoute = import.meta.env.VITE_POST_LOGIN_ROUTE;
  if (envRoute) return envRoute;

  // Neither an explicit destination nor a configured primary route — we're
  // about to fall back to the bare `/dashboard` literal, which may be inert
  // template scaffolding (#2524). Leave a dev-only breadcrumb so this shows
  // up in local/QA consoles; NEVER throw (checkout must not break).
  if (import.meta.env.DEV) {
    console.warn(
      "[whop] post-purchase destination fell back to /dashboard. Pass an " +
        "explicit `destination` (the route that renders the paid feature) or " +
        "set VITE_POST_LOGIN_ROUTE, so buyers don't land on a placeholder page."
    );
  }
  return "/dashboard";
}

// ---------------------------------------------------------------------------
// postPurchaseRedirect — the canonical post-checkout routing helper.
// ---------------------------------------------------------------------------

/**
 * Route the buyer correctly AFTER a successful checkout — the single
 * canonical helper every `onComplete` should call.
 *
 * OverSkill's default purchase flow is purchase -> login/signup ->
 * access. The post-purchase destination (e.g. /dashboard) is ALWAYS
 * auth-gated (wrapped in <ProtectedRoute> or VITE_APP_VISIBILITY). So
 * `onComplete` must NEVER blind-navigate a signed-OUT buyer straight
 * into protected content — they'd just bounce to /login with no email
 * context and the purchase wouldn't reconcile to an account.
 *
 * The `destination` is resolved via `resolvePostPurchaseDestination`:
 * an explicit `opts.destination` wins, else `VITE_POST_LOGIN_ROUTE`,
 * else `/dashboard`. Pass the app's REAL primary route (the page that
 * renders the paid feature — e.g. `/studio`) as `destination` — do NOT
 * rely on the bare `/dashboard` literal, which may be a placeholder that
 * isn't wired to the feature the buyer paid for (#2524).
 *
 * This helper resolves that:
 *   - Signed-IN buyer  → navigate(destination) directly.
 *   - Signed-OUT buyer → navigate(/login?redirect=<destination>&claim=1
 *                        [&email=<buyer email>]). After they create /
 *                        sign into their account (with the prefilled
 *                        checkout email), the platform reconciles the
 *                        anonymous purchase to their new account by
 *                        email and <ProtectedRoute> lets them in.
 *
 * Pass the `user` from `useAuth()` (or null). Pass the buyer's
 * `email` (from `completeCheckout(...).memberEmail`) when you have it
 * so signup prefills the matching address — strongly recommended for
 * anonymous checkouts, since email-match is how the claim works.
 *
 * Always pair the embed with `returnUrl={`${window.location.origin}/checkout/complete`}`
 * (REQUIRED — without it Whop strands the buyer on its own hub after
 * purchase) plus a public `/checkout/complete` route that calls this
 * helper on `?status=success`. `onComplete` is the in-SPA happy path;
 * `returnUrl` is the guaranteed fallback when Whop does a full
 * top-window redirect.
 *
 * @example
 * ```tsx
 * const navigate = useNavigate();
 * const { user } = useAuth();
 *
 * // Pass the app's REAL primary route (the page that renders the paid
 * // feature) as `destination` — here `/studio`, not a placeholder.
 * <WhopCheckoutEmbed
 *   planId={import.meta.env.VITE_PLAN_PRO}
 *   returnUrl={`${window.location.origin}/checkout/complete`}
 *   onComplete={() => postPurchaseRedirect(navigate, user, { destination: "/studio" })}
 * />
 *
 * // With email prefill for the anonymous-buyer claim (recommended):
 * <WhopCheckoutEmbed
 *   planId={import.meta.env.VITE_PLAN_PRO}
 *   returnUrl={`${window.location.origin}/checkout/complete`}
 *   onComplete={async (planId, receiptId) => {
 *     const { memberEmail } = await completeCheckout({ planId, receiptId });
 *     postPurchaseRedirect(navigate, user, { destination: "/studio", email: memberEmail });
 *   }}
 * />
 * ```
 */
export function postPurchaseRedirect(
  navigate: (to: string, opts?: { replace?: boolean }) => void,
  user: { email?: string } | null | undefined,
  opts: { destination?: string; email?: string | null } = {}
): void {
  // Resolve the app's real primary authenticated surface (explicit →
  // VITE_POST_LOGIN_ROUTE → /dashboard). NEVER a bare "/dashboard" literal
  // that might be placeholder scaffolding (#2524).
  const destination = resolvePostPurchaseDestination(opts.destination);

  // Signed-in buyer: go straight to the (auth-gated) destination.
  if (user) {
    navigate(destination);
    return;
  }

  // Signed-out buyer: send to login/signup with a return path + claim
  // marker, prefilling the checkout email when we have it so signup
  // matches the email the purchase was made under.
  const params = new URLSearchParams();
  params.set("redirect", destination);
  params.set("claim", "1");
  if (opts.email) {
    params.set("email", opts.email);
  } else {
    // Fallback: pull the email captured at checkout (onIdentityCaptured →
    // captureCheckoutEmail → sessionStorage) when the caller didn't thread
    // it explicitly. Without this, an anonymous buyer landed on a BLANK
    // sign-in/sign-up form — the captured email was stranded in
    // sessionStorage and never forwarded as the OAuth login_hint
    // (#1604/#1660; bolt-buy QA).
    const captured = readCapturedCheckoutEmail();
    if (captured) params.set("email", captured);
  }

  navigate(`/login?${params.toString()}`);
}

// ---------------------------------------------------------------------------
// Funnel next step — where a multi-page funnel continues after checkout.
// ---------------------------------------------------------------------------

// A finished Elements checkout (WhopPayments / WhopElementsCheckout) sends
// the WHOLE TAB to the public /checkout/complete route. There is no
// completion callback and the return URL is minted server-side, so the page
// that took the order cannot say "continue to /upsell" on the way out. A
// funnel says it here instead, BEFORE the buyer pays:
//
//   useEffect(() => { rememberFunnelNextStep("/upsell"); }, []);
//
// /checkout/complete, on a successful purchase, finishes its own work
// (receipt stash, confirmation window, deferred bump charges) and then sends
// the buyer to that step instead of the login bridge. The step reads the
// stashed receipt (readCapturedCheckoutReceipt) and calls completeCheckout()
// to get the saved card for a one-click chargeUpsell(). The funnel's last
// step (thank-you) runs postPurchaseRedirect as usual, and the claim runs on
// the far side of login exactly as it does without a funnel.
//
// Same-tab storage only, same-app paths only, and it expires: a marker left
// by an order form the buyer abandoned must not redirect a later purchase.
const FUNNEL_NEXT_STEP_KEY = "overskill_funnel_next_step";
export const FUNNEL_NEXT_STEP_MAX_AGE_MS = 2 * 60 * 60 * 1000;

/** A plain same-app path (`/upsell`), never a URL, query, or auth route. */
export function isFunnelNextStepPath(path: unknown): path is string {
  if (typeof path !== "string") return false;
  if (!/^\/[A-Za-z0-9\-._~/]*$/.test(path)) return false;
  if (path.startsWith("//")) return false;
  // `/../login` resolves to /login — refuse dot segments outright.
  if (path.split("/").some((segment) => segment === "." || segment === "..")) return false;
  if (/^\/(checkout\/complete|login|callback)(\/|$)/.test(path)) return false;
  return true;
}

/** Remember where this funnel continues after a successful checkout. NEVER throws. */
export function rememberFunnelNextStep(path: string, now: number = Date.now()): void {
  if (!isFunnelNextStepPath(path)) return;
  try {
    sessionStorage.setItem(FUNNEL_NEXT_STEP_KEY, JSON.stringify({ path, at: now }));
  } catch {
    // sessionStorage unavailable — the buyer takes the normal login bridge.
  }
}

/** The remembered next step, or null when absent, invalid, or stale. NEVER throws. */
export function readFunnelNextStep(now: number = Date.now()): string | null {
  try {
    const raw = sessionStorage.getItem(FUNNEL_NEXT_STEP_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { path?: unknown; at?: unknown };
    if (!isFunnelNextStepPath(parsed.path)) return null;
    if (typeof parsed.at !== "number" || !Number.isFinite(parsed.at)) return null;
    if (now - parsed.at > FUNNEL_NEXT_STEP_MAX_AGE_MS || parsed.at > now + 60_000) {
      return null;
    }
    return parsed.path;
  } catch {
    return null;
  }
}

/** Forget the remembered next step. NEVER throws. */
export function clearFunnelNextStep(): void {
  try {
    sessionStorage.removeItem(FUNNEL_NEXT_STEP_KEY);
  } catch {
    // Nothing to do.
  }
}

// ---------------------------------------------------------------------------
// chargeUpsell
// ---------------------------------------------------------------------------

/**
 * Fire an off-session upsell charge against a saved payment method.
 *
 * Call this from upsell pages AFTER the user clicks "Yes, add it". The user
 * never sees a payment form — the saved card runs in the background.
 *
 * Provide EITHER `planId` (existing Whop plan — supports recurring) OR
 * `inlinePrice` (dollar amount for a one-time charge). Passing both is
 * an error.
 *
 * The worker returns `{success: true, paymentId}` on success or
 * `{success: false, error}` on decline / failure — this method does NOT
 * throw on payment failure, because most funnel flows treat a decline as
 * "skip the upsell" rather than an exceptional condition. It DOES throw
 * on network errors or 5xx from the worker.
 *
 * @example
 * ```tsx
 * const result = await chargeUpsell({
 *   memberId: funnel.memberId!,
 *   paymentMethodId: funnel.paymentMethodId!,
 *   planId: "plan_yyy",
 *   capability: funnel.whopCapability,
 *   metadata: { funnel_step: "upsell_1" },
 * });
 * if (result.success) {
 *   funnel.recordPurchase({ planId: "plan_yyy", paymentId: result.paymentId });
 *   navigate("/upsell-2");
 * } else {
 *   navigate("/downsell-1");
 * }
 * ```
 */
export async function chargeUpsell(
  opts: ChargeUpsellOptions
): Promise<ChargeUpsellResult> {
  if (!opts.memberId) throw new Error("chargeUpsell: memberId is required");
  if (!opts.paymentMethodId) {
    throw new Error("chargeUpsell: paymentMethodId is required");
  }
  if (!opts.planId && opts.inlinePrice == null) {
    throw new Error("chargeUpsell: provide either planId or inlinePrice");
  }
  if (opts.planId && opts.inlinePrice != null) {
    throw new Error("chargeUpsell: pass planId OR inlinePrice, not both");
  }
  const capability = opts.capability ?? readWhopCapability();
  if (whopCapabilityAuthzEnabled() && !capability) {
    throw new Error("chargeUpsell: capability is required");
  }

  const res = await fetch("/api/whop/charge", {
    method: "POST",
    headers: whopRequestHeaders(capability),
    body: JSON.stringify({
      member_id: opts.memberId,
      payment_method_id: opts.paymentMethodId,
      plan_id: opts.planId,
      inline_price: opts.inlinePrice,
      metadata: opts.metadata ?? {},
      description: opts.description,
      idempotency_key: opts.idempotencyKey ?? defaultChargeIdempotencyKey(opts),
    }),
  });

  if (res.status >= 500) {
    const body = await safeText(res);
    throw new Error(`chargeUpsell: server error ${res.status} ${body || ""}`);
  }

  const json = (await res.json()) as {
    success?: boolean;
    payment_id?: string;
    paymentId?: string;
    error?: string;
  };

  return {
    success: !!json.success,
    paymentId: json.paymentId ?? json.payment_id,
    error: json.error,
    memberId: opts.memberId,
  };
}

// ---------------------------------------------------------------------------
// listMemberships / cancelMembership — the upgrade double-billing fix.
//
// When a buyer upgrades (e.g. buys the ¥49,800 BREAKTHROUGH plan), their
// OLD plans (¥19,800 VSL/LP/WEBINAR) keep auto-renewing unless you cancel
// them. Whop treats every subscription as independent — there is no
// automatic stop. Use these to cancel the prior plan(s) at_period_end so
// the current period is honored (no refund) and the next renewal stops.
//
// Typical upgrade flow:
// ```ts
// const { memberId, capability } = await completeCheckout({ planId: BREAKTHROUGH, receiptId });
// // stop the old single-tier plans for THIS buyer, next renewal only:
// await cancelMembershipsForPlans({
//   userId: memberId,
//   planIds: [VSL_SCRIPT, LP_OFFER, WEBINAR],
//   capability,
// });
// ```
// Requires the app to have OverSkill Payments enabled (os-enable-payments
// + KYC). Without it these return a 503-backed error.
// ---------------------------------------------------------------------------

export interface Membership {
  id: string;
  status?: string;
  planId?: string;
  valid?: boolean;
  cancelAtPeriodEnd?: boolean;
  capability?: string | null;
}

/**
 * List the buyer's memberships under this app's sub-merchant. Pass a
 * `planId` to filter to a single plan. Used to resolve the membership id
 * to cancel on upgrade.
 */
export async function listMemberships(opts: {
  userId: string;
  planId?: string;
  capability?: string | null;
}): Promise<Membership[]> {
  if (!opts.userId) throw new Error("listMemberships: userId is required");
  const capability = opts.capability ?? readWhopCapability();
  // A capability is minted by completeCheckout and expires in 15 minutes, so a
  // RETURNING member never has one (OS-9T9CFK / #4304). A signed-in caller is
  // still allowed through: the Worker resolves their Whop identity server-side
  // from the forwarded JWT and treats that verified identity as satisfying the
  // capability requirement for THEIR OWN memberships. Throwing here would make
  // "manage my subscription" impossible on a capability-authz app. With
  // neither a capability nor a session there is nothing to authorize on, so
  // the guard stands.
  if (whopCapabilityAuthzEnabled() && !capability && !hasSignedInSession()) {
    throw new Error("listMemberships: capability or a signed-in session is required");
  }
  const qs = new URLSearchParams({ user_id: opts.userId });
  if (opts.planId) qs.set("plan_id", opts.planId);

  const res = await fetch(`/api/whop/memberships?${qs.toString()}`, {
    method: "GET",
    headers: whopRequestHeaders(capability, { contentType: false }),
  });
  if (!res.ok) {
    const body = await safeText(res);
    throw new Error(`listMemberships: ${res.status} ${body || res.statusText}`);
  }
  const json = (await res.json()) as {
    memberships?: Array<{
      id: string;
      status?: string;
      plan_id?: string;
      valid?: boolean;
      cancel_at_period_end?: boolean;
      capability?: string | null;
      whop_capability?: string | null;
    }>;
  };
  return (json.memberships ?? []).map((m) => ({
    id: m.id,
    status: m.status,
    planId: m.plan_id,
    valid: m.valid,
    cancelAtPeriodEnd: m.cancel_at_period_end,
    capability: m.capability ?? m.whop_capability ?? null,
  }));
}

export interface CancelMembershipResult {
  success: boolean;
  membershipId?: string;
  status?: string;
  error?: string;
}

/**
 * Cancel a single membership. Defaults to period-end (stops the next
 * renewal, keeps access through the current paid period, NO refund of the
 * current period). Pass `immediate: true` to revoke access now.
 */
export async function cancelMembership(opts: {
  membershipId: string;
  immediate?: boolean;
  capability?: string | null;
}): Promise<CancelMembershipResult> {
  if (!opts.membershipId) {
    throw new Error("cancelMembership: membershipId is required");
  }
  const capability = opts.capability ?? readWhopCapability();
  if (whopCapabilityAuthzEnabled() && !capability) {
    throw new Error("cancelMembership: capability is required");
  }
  const res = await fetch("/api/whop/cancel", {
    method: "POST",
    headers: whopRequestHeaders(capability),
    body: JSON.stringify({
      membership_id: opts.membershipId,
      immediate: !!opts.immediate,
    }),
  });
  if (res.status >= 500) {
    const body = await safeText(res);
    throw new Error(`cancelMembership: server error ${res.status} ${body || ""}`);
  }
  const json = (await res.json()) as {
    success?: boolean;
    membership_id?: string;
    membershipId?: string;
    status?: string;
    error?: string;
  };
  return {
    success: !!json.success,
    membershipId: json.membershipId ?? json.membership_id ?? opts.membershipId,
    status: json.status,
    error: json.error,
  };
}

/**
 * Convenience: cancel ALL of a buyer's active memberships that match any of
 * `planIds`, at period-end. This is the one-liner for "on upgrade, stop the
 * old single-tier plans." Returns the per-membership results.
 */
export async function cancelMembershipsForPlans(opts: {
  userId: string;
  planIds: string[];
  immediate?: boolean;
  capability?: string | null;
}): Promise<CancelMembershipResult[]> {
  if (!opts.userId) throw new Error("cancelMembershipsForPlans: userId is required");
  const capability = opts.capability ?? readWhopCapability();
  if (whopCapabilityAuthzEnabled() && !capability) {
    throw new Error("cancelMembershipsForPlans: capability is required");
  }
  const wanted = new Set((opts.planIds ?? []).filter(Boolean));
  if (wanted.size === 0) return [];

  const memberships = await listMemberships({ userId: opts.userId, capability });
  const targets = memberships.filter(
    (m) =>
      m.planId &&
      wanted.has(m.planId) &&
      m.valid !== false &&
      !m.cancelAtPeriodEnd
  );

  const results: CancelMembershipResult[] = [];
  for (const m of targets) {
    try {
      results.push(
        await cancelMembership({
          membershipId: m.id,
          immediate: opts.immediate,
          capability: m.capability || capability,
        })
      );
    } catch (e) {
      results.push({
        success: false,
        membershipId: m.id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// listenCheckoutMessages — helper for funnels that want to read the embed's
// raw postMessage stream (e.g. analytics on form interactions). Most funnels
// can use WhopCheckoutEmbed's `onComplete` prop and don't need this.
// ---------------------------------------------------------------------------

export interface CheckoutCompleteMessage {
  planId: string;
  receiptId: string;
}

export type CheckoutEventHandler = (e: CheckoutCompleteMessage) => void;

/**
 * Subscribe to Whop checkout completion postMessage events at the window
 * level. Returns an unsubscribe function. Filters out unrelated postMessages
 * automatically — handlers only fire for Whop checkout completions.
 *
 * Useful when you can't (or don't want to) wire onComplete directly on the
 * WhopCheckoutEmbed — e.g. an embed that lives in a third-party component.
 */
export function listenCheckoutMessages(handler: CheckoutEventHandler): () => void {
  if (typeof window === "undefined") return () => {};

  const listener = (event: MessageEvent) => {
    const data = event.data;
    if (!data || typeof data !== "object") return;
    // Whop's embed emits `event: "checkout-complete"` with planId + receiptId.
    if (data.event !== "checkout-complete") return;
    if (!data.planId || !data.receiptId) return;
    handler({ planId: data.planId, receiptId: data.receiptId });
  };

  window.addEventListener("message", listener);
  return () => window.removeEventListener("message", listener);
}

// ---------------------------------------------------------------------------
// internal
// ---------------------------------------------------------------------------

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "";
  }
}

// Resolve how long to wait before retrying a 429'd checkout-session mint.
// Prefers the standard `Retry-After` header (seconds), then a `retry_after`
// field the worker echoes in the JSON body, then a safe default. Clamped to
// 1..15s so a bad value can never hang the buyer on a spinner.
function parseRetryAfterMs(res: Response): number {
  const DEFAULT_MS = 2000;
  const MIN_MS = 1000;
  const MAX_MS = 15000;
  const clamp = (ms: number) => Math.min(MAX_MS, Math.max(MIN_MS, ms));

  const header = res.headers.get("Retry-After");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds > 0) return clamp(seconds * 1000);
  }
  return clamp(DEFAULT_MS);
}

function whopRequestHeaders(
  capability?: string | null,
  opts: { contentType?: boolean } = {}
): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (capability) headers["X-Whop-Capability"] = capability;
  if (opts.contentType !== false) headers["Content-Type"] = "application/json";

  try {
    const token = localStorage.getItem("overskill_token");
    if (token) headers.Authorization = `Bearer ${token}`;
  } catch {
    // localStorage unavailable — capability auth is enough for these calls.
  }

  return headers;
}

function whopCapabilityAuthzEnabled(): boolean {
  return import.meta.env.VITE_WHOP_CAPABILITY_AUTHZ_ENABLED === "true";
}

// Is there an app JWT for whopRequestHeaders to forward? Same token and same
// failure handling as that function — this only answers "will the request
// carry an identity the Worker can verify?", never "is that identity valid".
function hasSignedInSession(): boolean {
  try {
    return !!localStorage.getItem("overskill_token");
  } catch {
    return false;
  }
}

function defaultChargeIdempotencyKey(opts: ChargeUpsellOptions): string {
  const target = opts.planId
    ? `plan:${opts.planId}`
    : `inline:${Math.round(Number(opts.inlinePrice) * 100)}`;
  return stableIdempotencyKey([
    "whop-charge",
    opts.memberId,
    opts.paymentMethodId,
    target,
    opts.description || "",
  ].join("|"));
}

function stableIdempotencyKey(value: string): string {
  let h = 5381;
  for (let i = 0; i < value.length; i++) {
    h = ((h << 5) + h + value.charCodeAt(i)) >>> 0;
  }
  return `idem_${h.toString(16)}`;
}
