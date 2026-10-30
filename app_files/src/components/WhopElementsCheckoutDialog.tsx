// PLATFORM-MANAGED: WhopElementsCheckoutDialog — the ONLY supported way to
// open the Whop Elements checkout in a modal/dialog/popup. Prefer a full
// checkout PAGE when the design allows; use this when the design genuinely
// calls for an in-page purchase modal.
//
// This is the Elements sibling of CheckoutDialog (the legacy-embed modal,
// which stays intact for apps on that path). It preserves every guard the
// legacy dialog earned the hard way (QA run 2846c3d3, the "modal Join-click
// trap"):
//
//   - Backdrop/outside-click dismissal is DISABLED. A purchase modal must
//     never close by accident — explicit X or Escape only. The checkout
//     frame lays itself out mid-interaction, so a click aimed at Pay can
//     land on the overlay; without these guards that click silently closes
//     the modal and destroys the in-progress checkout.
//   - The checkout subtree is memoized with identity-stable props, so parent
//     re-renders (auth state, entitlement polling, page state) can NEVER
//     remount the frame and wipe what the buyer already typed. The checkout
//     remounts only when planId changes (intentional, via key) — every
//     checkout option is create-time on this surface.
//
// There is deliberately NO onComplete prop: the Elements checkout has no
// completion callback. A finished purchase navigates the WHOLE TAB to the
// public /checkout/complete route (wired inside WhopElementsCheckout), which
// stamps the post-purchase confirmation window and bridges into
// purchase → login/signup → access. Fulfillment is webhook-driven.
//
// Usage:
//   const [open, setOpen] = useState(false);
//   <Button onClick={() => setOpen(true)}>Join — $29/mo</Button>
//   <WhopElementsCheckoutDialog
//     open={open}
//     onOpenChange={setOpen}
//     planId={import.meta.env.VITE_PLAN_PRO}
//     title="Join Pro"
//   />

import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { WhopElementsCheckout } from "@/components/WhopElementsCheckout";

export interface WhopElementsCheckoutDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Whop plan id — ALWAYS from import.meta.env.VITE_PLAN_*, never a literal. */
  planId: string;
  title?: string;
  description?: string;
  theme?: "light" | "dark" | "system";
  promoCode?: string;
}

interface StableCheckoutProps {
  planId: string;
  theme: "light" | "dark" | "system";
  /** Locked at open time — create-time options never change on a mounted checkout. */
  promoCode?: string;
}

// The frame boundary. Every prop the checkout receives is identity-stable
// across parent re-renders, and React.memo stops re-renders from reaching the
// checkout at all. Remounts happen ONLY on plan change (key={planId}).
const StableElementsCheckout = React.memo(function StableElementsCheckout({
  planId,
  theme,
  promoCode,
}: StableCheckoutProps) {
  const initialPromoRef = React.useRef(promoCode);

  return (
    <WhopElementsCheckout
      key={planId}
      planId={planId}
      theme={theme}
      promoCode={initialPromoRef.current}
    />
  );
});

export function WhopElementsCheckoutDialog({
  open,
  onOpenChange,
  planId,
  title,
  description,
  theme = "system",
  promoCode,
}: WhopElementsCheckoutDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-lg max-h-[90vh] overflow-y-auto"
        // CRITICAL: a purchase modal must NEVER dismiss from a backdrop /
        // outside-pointer event — see the header comment. Close is explicit
        // only: the X button or Escape.
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{title ?? "Complete your purchase"}</DialogTitle>
          {description ? (
            <DialogDescription>{description}</DialogDescription>
          ) : null}
        </DialogHeader>
        {open ? (
          <StableElementsCheckout
            planId={planId}
            theme={theme}
            promoCode={promoCode}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export default WhopElementsCheckoutDialog;
