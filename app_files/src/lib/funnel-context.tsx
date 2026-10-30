// Shared funnel state for multi-page funnels (provided by OverSkill template).
//
// Wraps a multi-page funnel (front-end offer → upsells → downsells → thank you)
// with a React Context that tracks:
//   * memberId          — the Whop member created at the initial checkout
//   * paymentMethodId   — saved card for off-session upsell charges
//   * whopCapability    — short-lived signed checkout/session capability
//   * purchases         — list of every charge that succeeded in this funnel,
//                         in chronological order
//
// Why a primitive instead of one-off useState per page: a funnel redirects
// across routes (/, /upsell-1, /upsell-2, /thank-you). React Context state is
// lost on hard-nav, so we also mirror to sessionStorage on every update and
// rehydrate on mount. Pages that read funnel state get consistent data
// regardless of how they were navigated to.
//
// @example
// ```tsx
// // src/App.tsx
// import { FunnelProvider } from "@/lib/funnel-context";
// <FunnelProvider>
//   <Routes>...</Routes>
// </FunnelProvider>
//
// // src/pages/Upsell1.tsx
// import { useFunnel } from "@/lib/funnel-context";
// import { chargeUpsell } from "@/lib/whop";
// const funnel = useFunnel();
// const result = await chargeUpsell({
//   memberId: funnel.memberId!,
//   paymentMethodId: funnel.paymentMethodId!,
//   planId: "plan_yyy",
//   capability: funnel.whopCapability!,
// });
// if (result.success) funnel.recordPurchase({
//   planId: "plan_yyy",
//   paymentId: result.paymentId!,
// });
// ```

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useMemo,
  ReactNode,
} from "react";

const STORAGE_KEY = "overskill_funnel_state_v1";

export interface FunnelPurchase {
  planId?: string;
  paymentId?: string;
  // Inline-priced upsells don't have a planId; surface the price too so
  // analytics + thank-you pages can render line items.
  inlinePrice?: number;
  description?: string;
  occurredAt: string; // ISO8601
}

export interface FunnelState {
  memberId: string | null;
  paymentMethodId: string | null;
  whopCapability: string | null;
  purchases: FunnelPurchase[];
}

export interface FunnelContextValue extends FunnelState {
  /**
   * Set memberId + paymentMethodId after the initial checkout completes.
   * Typically called from the front-end offer page's onComplete handler.
   */
  setIdentity: (args: {
    memberId: string;
    paymentMethodId: string | null;
    whopCapability?: string | null;
  }) => void;

  /**
   * Append a successful purchase to the list. Pages call this after
   * chargeUpsell() / completeCheckout() succeeds. Idempotent on paymentId.
   */
  recordPurchase: (purchase: Omit<FunnelPurchase, "occurredAt"> & { occurredAt?: string }) => void;

  /**
   * Wipe all state (memberId, paymentMethodId, purchases). Use after the
   * user finishes the thank-you page if you want a clean slate for repeat
   * visitors, or in development when iterating.
   */
  reset: () => void;
}

const EMPTY_STATE: FunnelState = {
  memberId: null,
  paymentMethodId: null,
  whopCapability: null,
  purchases: [],
};

const FunnelContext = createContext<FunnelContextValue | null>(null);

function loadFromStorage(): FunnelState {
  if (typeof window === "undefined") return EMPTY_STATE;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY_STATE;
    const parsed = JSON.parse(raw) as Partial<FunnelState>;
    return {
      memberId: parsed.memberId ?? null,
      paymentMethodId: parsed.paymentMethodId ?? null,
      whopCapability: parsed.whopCapability ?? null,
      purchases: Array.isArray(parsed.purchases) ? parsed.purchases : [],
    };
  } catch {
    return EMPTY_STATE;
  }
}

function saveToStorage(state: FunnelState): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Quota exceeded / disabled storage — silent no-op.
  }
}

export function FunnelProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<FunnelState>(loadFromStorage);

  // Persist on every state change so cross-route reads see the latest.
  useEffect(() => {
    saveToStorage(state);
  }, [state]);

  const setIdentity = useCallback<FunnelContextValue["setIdentity"]>(
    ({ memberId, paymentMethodId, whopCapability }) => {
      setState((prev) => ({
        ...prev,
        memberId,
        paymentMethodId: paymentMethodId ?? prev.paymentMethodId,
        whopCapability: whopCapability ?? prev.whopCapability,
      }));
    },
    []
  );

  const recordPurchase = useCallback<FunnelContextValue["recordPurchase"]>(
    (purchase) => {
      const occurredAt = purchase.occurredAt ?? new Date().toISOString();
      setState((prev) => {
        // Dedup by paymentId so accidental double-fires don't double-log.
        if (purchase.paymentId && prev.purchases.some((p) => p.paymentId === purchase.paymentId)) {
          return prev;
        }
        return {
          ...prev,
          purchases: [...prev.purchases, { ...purchase, occurredAt }],
        };
      });
    },
    []
  );

  const reset = useCallback(() => {
    setState(EMPTY_STATE);
    if (typeof window !== "undefined") {
      try {
        window.sessionStorage.removeItem(STORAGE_KEY);
      } catch {
        // ignore
      }
    }
  }, []);

  const value = useMemo<FunnelContextValue>(
    () => ({
      ...state,
      setIdentity,
      recordPurchase,
      reset,
    }),
    [state, setIdentity, recordPurchase, reset]
  );

  return <FunnelContext.Provider value={value}>{children}</FunnelContext.Provider>;
}

/**
 * Read + mutate funnel state. Throws if used outside <FunnelProvider> so the
 * mistake surfaces in dev rather than silently passing null values around.
 */
export function useFunnel(): FunnelContextValue {
  const ctx = useContext(FunnelContext);
  if (!ctx) {
    throw new Error(
      "useFunnel() called outside <FunnelProvider>. Wrap your <Routes> in <FunnelProvider> (typically in App.tsx)."
    );
  }
  return ctx;
}
