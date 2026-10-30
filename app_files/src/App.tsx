import React from 'react';
import { lazy, Suspense, useEffect, useState, useCallback, useRef } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { AuthHeader } from "@/components/AuthHeader";
// OS-V7HMWA (#3756): app-wide "your push subscription died — re-enable" prompt.
// Renders null unless the signed-in user's device push is actually dead, so it
// is inert for everyone else. Mounted globally (below) because a user with no
// reason to visit settings is exactly who the silent-dead-push bug traps.
import { PushHealthBanner } from "@/components/PushHealthBanner";
import Index from "@/pages/Index";
import Dashboard from "@/pages/Dashboard";
import ShopAdmin from "@/pages/ShopAdmin";
import StoreDetail from "@/pages/StoreDetail";
import RequireRole from "@/components/RequireRole";
import NotFound from "@/pages/NotFound";
import "@/App.css";
// Platform-owned styles for OverSkill Remix Badge — DO NOT REMOVE.
// Lives in BLOCKED_PATHS so the AI can't edit it. Without this import,
// the badge in the bottom-right corner renders unstyled.
import "@/lib/overskill-badge.css";

// Lazy load auth pages (only loaded when needed)
const LoginPage = lazy(() => import("@/routes/login").catch(() => ({ default: () => <div>Login page not available</div> })));
const CallbackPage = lazy(() => import("@/routes/callback").catch(() => ({ default: () => <div>Redirecting...</div> })));
const AccessDeniedPage = lazy(() => import("@/routes/access-denied").catch(() => ({ default: () => <div>Access denied</div> })));
const LoggedOutPage = lazy(() => import("@/routes/logged-out").catch(() => ({ default: () => <div>Logged out</div> })));
const SettingsPage = lazy(() => import("@/routes/settings").catch(() => ({ default: () => <div>Settings not available</div> })));
// Canonical post-purchase landing — the WhopCheckoutEmbed returnUrl + CheckoutDialog
// onComplete both converge here. Public route (buyer is anonymous on arrival).
const CheckoutCompletePage = lazy(() => import("@/routes/checkout-complete").catch(() => ({ default: () => <div>Redirecting...</div> })));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

function App() {
  // OAuth token extraction removed - handled by lib/auth.ts at module level
  // This prevents race conditions and sessionStorage loss from page reloads
  // See: docs/ultrathink/oauth-post-login-route-bug-dec-2025/FIX_IMPLEMENTATION.md

  /**
   * Architecture: "Public Landing + Protected Interior"
   *
   * - / (Index/Landing) → ALWAYS public, even for login_required apps
   * - /dashboard → Protected, main app functionality
   * - /settings, /profile → Protected
   * - /login, /callback, etc. → Public auth routes
   *
   * This allows:
   * 1. Marketing/SEO on landing page
   * 2. Users can see what app does before signing up
   * 3. Protected content is inside the app (dashboard)
   */

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
        <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <Routes>
            {/* Auth routes - lazy loaded, always public */}
            <Route path="/login" element={
              <Suspense fallback={<LoadingScreen />}>
                <LoginPage />
              </Suspense>
            } />
            <Route path="/callback" element={
              <Suspense fallback={<LoadingScreen text="Logging in..." />}>
                <CallbackPage />
              </Suspense>
            } />
            <Route path="/access-denied" element={
              <Suspense fallback={<LoadingScreen />}>
                <AccessDeniedPage />
              </Suspense>
            } />
            <Route path="/logged-out" element={
              <Suspense fallback={<LoadingScreen />}>
                <LoggedOutPage />
              </Suspense>
            } />
            {/* Post-purchase landing — WhopCheckoutEmbed returnUrl + CheckoutDialog
                onComplete converge here. Public: the buyer is anonymous on arrival. */}
            <Route path="/checkout/complete" element={
              <Suspense fallback={<LoadingScreen text="Confirming your purchase..." />}>
                <CheckoutCompletePage />
              </Suspense>
            } />

            {/* Landing page - ALWAYS public (even for login_required apps) */}
            <Route path="/" element={<Index />} />

            {/* Dashboard - ALWAYS protected (main app area after login) */}
            <Route path="/dashboard" element={
              <ProtectedRoute>
                <Dashboard />
              </ProtectedRoute>
            } />

            {/* Store details - protected owner monitoring history */}
            <Route path="/dashboard/store/:storeId" element={
              <ProtectedRoute>
                <StoreDetail />
              </ProtectedRoute>
            } />

            {/* Cross-store admin tools - verified app role required */}
            <Route path="/admin" element={
              <ProtectedRoute>
                <RequireRole role="admin" fallback={<main className="mx-auto max-w-2xl p-8"><h1 className="font-display text-2xl font-bold">Admin access required</h1><p className="mt-2 text-muted-foreground">This dashboard is for Shopwatch administrators.</p></main>}>
                  <ShopAdmin />
                </RequireRole>
              </ProtectedRoute>
            } />

            {/* Settings/Profile - always protected */}
            <Route path="/settings" element={
              <ProtectedRoute>
                <Suspense fallback={<LoadingScreen text="Loading settings..." />}>
                  <SettingsPage />
                </Suspense>
              </ProtectedRoute>
            } />
            <Route path="/profile" element={
              <ProtectedRoute>
                <Suspense fallback={<LoadingScreen text="Loading settings..." />}>
                  <SettingsPage />
                </Suspense>
              </ProtectedRoute>
            } />

            {/* Catch-all 404 */}
            <Route path="*" element={<NotFound />} />
          </Routes>

          {/* Global UI elements */}
          <PushHealthBanner />
          <Toaster />
          <Sonner />
          <OverSkillBadge />
        </BrowserRouter>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

// Loading screen for lazy-loaded routes
function LoadingScreen({ text = "Loading..." }: { text?: string }) {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="text-center space-y-4">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto" />
        <p className="text-sm text-muted-foreground">{text}</p>
      </div>
    </div>
  );
}

/**
 * OverSkill Remix Badge - Expandable glyph-to-wordmark pill
 * (Jun 2026 redesign — Sanzone handoff, badge-reference-bundled.html)
 *
 * Features:
 * - Collapsed: 42px ink circle with the OverSkill glyph mark (compact, non-intrusive)
 * - Desktop hover/focus: pill widens to 179px, the glyph spins 360deg and the
 *   "Remix on OverSkill" SVG wordmark fades + slides in
 * - Mobile: Collapsed by default, first tap expands, second tap opens remix URL
 * - Theme-adaptive: dark badge (ink pill) on light sites; auto-inverts to the
 *   light badge (paper pill) while the app is in dark mode (`.dark` on <html>)
 * - Anchored bottom-right, so the expansion grows leftward and never
 *   overflows the viewport (grows rightward when flipped to bottom-left)
 * - Accessible: Keyboard navigable, screen reader friendly (aria-label carries
 *   the name; both SVGs are aria-hidden), respects reduced motion
 *
 * Styles live in src/lib/overskill-badge.css (platform-owned, AI-blocked).
 * APP_CONFIG is injected at runtime by WorkerScriptAssembler
 */
function OverSkillBadge() {
  const appConfig = (window as any).APP_CONFIG || {};
  const [expanded, setExpanded] = useState(false);
  const badgeRef = useRef<HTMLAnchorElement>(null);
  const collapseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Only show if app is cloneable (free users default to cloneable)
  // Hidden if explicitly set to not cloneable
  if (appConfig.isCloneable === false) {
    return null;
  }

  // Don't show badge if we don't have an app ID (no valid remix destination)
  const appId = appConfig.appId || appConfig.APP_ID;
  if (!appId) {
    return null;
  }

  // App-specific remix URL - injected by WorkerScriptAssembler
  // Falls back to constructing URL from app ID if remixUrl not provided
  const remixUrl = appConfig.remixUrl || `https://www.overskill.com/remix/${appId}`;

  // Badge label + destination mode (feat/badge-built-with-and-switcher).
  // When the creator has DISABLED remixing but still shows the badge, the pill
  // reads "Built with OverSkill" and links to the owner's affiliate deep link
  // (appConfig.builtWithUrl → https://www.overskill.com/?ref=<handle>) so the
  // owner earns commission on referrals from their badge — instead of the
  // "Remix on OverSkill" → /remix behavior (which would error "this app
  // doesn't allow remixing" once remixing is off).
  //
  // BACK-COMPAT: remixEnabled is undefined for apps whose worker bundle was
  // baked BEFORE this field existed (the badge state is baked at deploy time,
  // so already-deployed apps don't get remixEnabled/builtWithUrl until they
  // republish). Treat `undefined` as "remix on / current behavior" so NO live
  // site changes appearance until it republishes — only an explicit
  // `remixEnabled === false` flips the badge to the Built-with variant.
  // `poweredByUrl` is read as a fallback so a bundle baked in the brief window
  // between the two PRs still resolves the affiliate link.
  const remixEnabled = appConfig.remixEnabled !== false;
  const badgeHref = remixEnabled
    ? remixUrl
    : (appConfig.builtWithUrl || appConfig.poweredByUrl || 'https://www.overskill.com/');
  const badgeAriaLabel = remixEnabled ? 'Remix on OverSkill' : 'Built with OverSkill';

  // Yield bottom-right to the AI Helper widget when it might render. The
  // helper widget conventionally sits bottom-right (industry standard for
  // chat); both badges at right:1rem with overlapping ~48px footprints is
  // exactly the bug we hit on May 5 2026 (issue #349) where the helper's
  // chat icon was painted underneath the Remix badge and end-users couldn't
  // see it. We pre-emptively flip to bottom-LEFT when AI_HELPER_URL is set
  // (creator wired up the helper) — no coordination needed between the two
  // components, just a one-way preference. If the helper config endpoint
  // returns enabled:false at runtime the helper won't render but the badge
  // is still on the left, which is fine — it's just an empty right corner.
  const helperEnabled = !!appConfig.AI_HELPER_URL;

  // Detect touch device
  const isTouchDevice = typeof window !== 'undefined' &&
    window.matchMedia('(hover: none) and (pointer: coarse)').matches;

  // Collapse badge after inactivity on mobile (auto-close after 4 seconds)
  const scheduleCollapse = useCallback(() => {
    if (collapseTimerRef.current) {
      clearTimeout(collapseTimerRef.current);
    }
    collapseTimerRef.current = setTimeout(() => {
      setExpanded(false);
    }, 4000);
  }, []);

  // Close badge if user taps elsewhere on the page
  useEffect(() => {
    if (!expanded || !isTouchDevice) return;

    const handleOutsideClick = (e: MouseEvent | TouchEvent) => {
      if (badgeRef.current && !badgeRef.current.contains(e.target as Node)) {
        setExpanded(false);
        if (collapseTimerRef.current) {
          clearTimeout(collapseTimerRef.current);
        }
      }
    };

    document.addEventListener('touchstart', handleOutsideClick, { passive: true });
    return () => {
      document.removeEventListener('touchstart', handleOutsideClick);
      if (collapseTimerRef.current) {
        clearTimeout(collapseTimerRef.current);
      }
    };
  }, [expanded, isTouchDevice]);

  // Handle click/tap on the badge
  const handleClick = useCallback((e: React.MouseEvent<HTMLAnchorElement>) => {
    if (!isTouchDevice) {
      // Desktop: normal link behavior (hover already shows text)
      return;
    }

    if (!expanded) {
      // Mobile first tap: expand the badge, prevent navigation
      e.preventDefault();
      setExpanded(true);
      scheduleCollapse();
    } else {
      // Mobile second tap: badge is expanded, allow navigation to remix URL
      // Opens in new window via target="_blank"
      // No e.preventDefault() — let the <a> tag navigate naturally
    }
  }, [isTouchDevice, expanded, scheduleCollapse]);

  // Badge corner position (feat/badge-position-toggle + the
  // badge-built-with-and-switcher switcher fix). The creator can pin the badge
  // to the bottom-left or bottom-right corner from the publish modal; an
  // EXPLICIT preference is baked into APP_CONFIG.badgePosition at deploy time.
  // Resolution order:
  //   - 'left'  → explicit preference, force bottom-LEFT
  //   - 'right' → explicit preference, force bottom-RIGHT (base CSS) — HONORED
  //               over the auto-flip below, so a creator who picks Right gets
  //               Right even when an AI helper is present.
  //   - unset   → no explicit preference; fall back to the AI-Helper
  //               auto-flip-left behavior (issue #349) so helper apps keep
  //               yielding bottom-right to the chat icon. The assembler omits
  //               badgePosition for the "auto" (NULL) default precisely so
  //               untouched + generated apps land here and don't change.
  const badgePosition = appConfig.badgePosition;
  const positionClass =
    badgePosition === 'left'
      ? 'overskill-remix-badge--left'
      : badgePosition === 'right'
        ? ''
        : helperEnabled
          ? 'overskill-remix-badge--left'
          : '';

  return (
    <a
      ref={badgeRef}
      href={badgeHref}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={badgeAriaLabel}
      className={`overskill-remix-badge ${expanded ? 'expanded' : ''} ${positionClass} ${remixEnabled ? '' : 'overskill-remix-badge--builtwith'}`}
      onClick={handleClick}
    >
      {/* OverSkill glyph - always visible; spins 360deg while the pill expands */}
      <span className="overskill-remix-badge-logo">
        <OverSkillGlyph />
      </span>

      {/* Expanded label — cropped away while collapsed, fades + slides in on
          hover (desktop) or tap (mobile). "Remix on OverSkill" (SVG text
          paths) when remixing is on; "Built with OverSkill" when the creator
          disabled remixing (the badge still links out, to the owner's
          affiliate URL). */}
      <span className="overskill-remix-badge-label">
        {remixEnabled ? <OverSkillWordmark /> : <OverSkillBuiltWithWordmark />}
      </span>
    </a>
  );
}

/**
 * OverSkill glyph mark (42x42) — the bare "S" connector, no background square;
 * the badge pill itself is the background. Inline fills are the paper fallback;
 * overskill-badge.css recolors via `fill: var(--os-badge-mark)` per variant.
 */
function OverSkillGlyph() {
  return (
    <svg
      width="42"
      height="42"
      viewBox="0 0 42 42"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <rect x="18.3086" y="19.6855" width="5.39799" height="2.6291" rx="0.722687" fill="#F1F2F4"/>
      <path d="M11.9969 20.1925C11.9969 19.964 12.1021 19.7511 12.2849 19.6141C13.3566 18.8105 17.1867 15.9185 19.8067 13.6826C19.9384 13.5702 20.1047 13.5088 20.2778 13.5088C20.3609 13.5088 20.4486 13.5088 20.5894 13.5088L24.9463 13.5088C25.5835 13.5088 26.0996 14.0286 26.0996 14.6704L26.0996 16.2603C26.0996 16.9021 25.5835 17.4219 24.9463 17.4219L18.2178 17.4219C15.8974 17.4219 15.8823 19.1004 15.8823 19.4213L15.8823 21.1528C15.8823 21.7946 15.3662 22.3145 14.7289 22.3145L12.8785 22.3145C12.3919 22.3145 11.9969 21.9166 11.9969 21.4266L11.9969 20.1925Z" fill="#F1F2F4"/>
      <path d="M30.0011 21.8073C30.0011 22.0357 29.8959 22.2486 29.7131 22.3857C28.6414 23.1893 24.8113 26.0812 22.1913 28.3172C22.0597 28.4295 21.8934 28.491 21.7202 28.491C21.6371 28.491 21.5494 28.491 21.4086 28.491H17.0518C16.4146 28.491 15.8984 27.9712 15.8984 27.3294L15.8984 25.7394C15.8984 25.0977 16.4146 24.5778 17.0518 24.5778H23.7802C26.1006 24.5778 26.1157 22.8993 26.1157 22.5784V20.8469C26.1157 20.2051 26.6319 19.6853 27.2691 19.6853H29.1195C29.6061 19.6853 30.0011 20.0832 30.0011 20.5732V21.8073Z" fill="#F1F2F4"/>
    </svg>
  );
}

/**
 * "Remix on OverSkill" wordmark (180x42) — the label text pre-rendered as SVG
 * paths (from the design handoff) so typography is pixel-identical everywhere
 * regardless of the generated app's font stack. The leading 40px is blank to
 * clear the glyph. Recolored by overskill-badge.css like the glyph.
 */
function OverSkillWordmark() {
  return (
    <svg
      width="180"
      height="42"
      viewBox="0 0 180 42"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path d="M40.2177 26V15.35H44.4627C45.2227 15.35 45.8777 15.48 46.4277 15.74C46.9777 16 47.4027 16.37 47.7027 16.85C48.0027 17.33 48.1527 17.9 48.1527 18.56C48.1527 19.04 48.0427 19.47 47.8227 19.85C47.6127 20.23 47.3277 20.535 46.9677 20.765C46.6177 20.985 46.2427 21.11 45.8427 21.14L45.7677 21.005C46.4377 21.005 46.9577 21.16 47.3277 21.47C47.6977 21.77 47.9127 22.245 47.9727 22.895L48.2577 26H46.6227L46.3677 23.105C46.3377 22.675 46.1927 22.36 45.9327 22.16C45.6727 21.95 45.2477 21.845 44.6577 21.845H41.8377V26H40.2177ZM41.8377 20.36H44.4927C45.1027 20.36 45.5827 20.21 45.9327 19.91C46.2927 19.6 46.4727 19.165 46.4727 18.605C46.4727 18.035 46.2927 17.6 45.9327 17.3C45.5727 16.99 45.0477 16.835 44.3577 16.835H41.8377V20.36ZM53.328 26.18C52.548 26.18 51.873 26.01 51.303 25.67C50.743 25.33 50.308 24.845 49.998 24.215C49.698 23.585 49.548 22.85 49.548 22.01C49.548 21.17 49.698 20.44 49.998 19.82C50.308 19.19 50.743 18.705 51.303 18.365C51.863 18.015 52.523 17.84 53.283 17.84C54.003 17.84 54.638 18.01 55.188 18.35C55.738 18.68 56.163 19.16 56.463 19.79C56.773 20.42 56.928 21.18 56.928 22.07V22.475H51.198C51.238 23.255 51.443 23.84 51.813 24.23C52.193 24.62 52.703 24.815 53.343 24.815C53.813 24.815 54.203 24.705 54.513 24.485C54.823 24.265 55.038 23.97 55.158 23.6L56.808 23.705C56.598 24.445 56.183 25.045 55.563 25.505C54.953 25.955 54.208 26.18 53.328 26.18ZM51.198 21.275H55.248C55.198 20.565 54.993 20.04 54.633 19.7C54.283 19.36 53.833 19.19 53.283 19.19C52.713 19.19 52.243 19.37 51.873 19.73C51.513 20.08 51.288 20.595 51.198 21.275ZM58.5391 26V18.02H59.9941L60.0391 20L59.8591 19.94C59.9491 19.5 60.1041 19.125 60.3241 18.815C60.5541 18.505 60.8341 18.265 61.1641 18.095C61.4941 17.925 61.8541 17.84 62.2441 17.84C62.9241 17.84 63.4791 18.035 63.9091 18.425C64.3391 18.805 64.6091 19.33 64.7191 20H64.4641C64.5541 19.53 64.7041 19.14 64.9141 18.83C65.1341 18.51 65.4141 18.265 65.7541 18.095C66.0941 17.925 66.4791 17.84 66.9091 17.84C67.4691 17.84 67.9441 17.96 68.3341 18.2C68.7341 18.43 69.0341 18.77 69.2341 19.22C69.4441 19.67 69.5491 20.22 69.5491 20.87V26H67.9591V21.26C67.9591 20.57 67.8341 20.05 67.5841 19.7C67.3341 19.35 66.9541 19.175 66.4441 19.175C66.1141 19.175 65.8241 19.26 65.5741 19.43C65.3241 19.6 65.1291 19.845 64.9891 20.165C64.8591 20.485 64.7941 20.87 64.7941 21.32V26H63.2791V21.32C63.2791 20.64 63.1641 20.115 62.9341 19.745C62.7141 19.365 62.3341 19.175 61.7941 19.175C61.4541 19.175 61.1591 19.26 60.9091 19.43C60.6691 19.6 60.4791 19.85 60.3391 20.18C60.1991 20.5 60.1291 20.88 60.1291 21.32V26H58.5391ZM71.6641 26V18.02H73.2541V26H71.6641ZM71.6341 16.865V15.275H73.2841V16.865H71.6341ZM74.3349 26L77.2299 21.92L74.4549 18.02H76.2249L78.1899 20.885L80.0949 18.02H81.9099L79.1649 21.95L82.0299 26H80.2599L78.2049 22.955L76.1349 26H74.3349ZM90.7987 26.18C90.0387 26.18 89.3737 26.01 88.8037 25.67C88.2337 25.33 87.7937 24.845 87.4837 24.215C87.1737 23.585 87.0187 22.85 87.0187 22.01C87.0187 21.16 87.1737 20.425 87.4837 19.805C87.7937 19.185 88.2337 18.705 88.8037 18.365C89.3737 18.015 90.0387 17.84 90.7987 17.84C91.5587 17.84 92.2237 18.015 92.7937 18.365C93.3637 18.705 93.8037 19.185 94.1137 19.805C94.4237 20.425 94.5787 21.16 94.5787 22.01C94.5787 22.85 94.4237 23.585 94.1137 24.215C93.8037 24.845 93.3637 25.33 92.7937 25.67C92.2237 26.01 91.5587 26.18 90.7987 26.18ZM90.7987 24.8C91.4787 24.8 92.0037 24.555 92.3737 24.065C92.7437 23.565 92.9287 22.88 92.9287 22.01C92.9287 21.14 92.7437 20.46 92.3737 19.97C92.0037 19.47 91.4787 19.22 90.7987 19.22C90.1287 19.22 89.6037 19.47 89.2237 19.97C88.8537 20.46 88.6687 21.14 88.6687 22.01C88.6687 22.88 88.8537 23.565 89.2237 24.065C89.6037 24.555 90.1287 24.8 90.7987 24.8ZM96.1855 26V18.02H97.6405L97.7005 20.15L97.5055 20.045C97.5955 19.525 97.7655 19.105 98.0155 18.785C98.2655 18.465 98.5705 18.23 98.9305 18.08C99.2905 17.92 99.6805 17.84 100.101 17.84C100.701 17.84 101.196 17.975 101.586 18.245C101.986 18.505 102.286 18.865 102.486 19.325C102.696 19.775 102.801 20.29 102.801 20.87V26H101.211V21.35C101.211 20.88 101.161 20.485 101.061 20.165C100.961 19.845 100.796 19.6 100.566 19.43C100.336 19.26 100.036 19.175 99.6655 19.175C99.1055 19.175 98.6505 19.36 98.3005 19.73C97.9505 20.1 97.7755 20.64 97.7755 21.35V26H96.1855ZM111.98 26.18C111.22 26.18 110.555 26.01 109.985 25.67C109.415 25.33 108.975 24.845 108.665 24.215C108.355 23.585 108.2 22.85 108.2 22.01C108.2 21.16 108.355 20.425 108.665 19.805C108.975 19.185 109.415 18.705 109.985 18.365C110.555 18.015 111.22 17.84 111.98 17.84C112.74 17.84 113.405 18.015 113.975 18.365C114.545 18.705 114.985 19.185 115.295 19.805C115.605 20.425 115.76 21.16 115.76 22.01C115.76 22.85 115.605 23.585 115.295 24.215C114.985 24.845 114.545 25.33 113.975 25.67C113.405 26.01 112.74 26.18 111.98 26.18ZM111.98 24.8C112.66 24.8 113.185 24.555 113.555 24.065C113.925 23.565 114.11 22.88 114.11 22.01C114.11 21.14 113.925 20.46 113.555 19.97C113.185 19.47 112.66 19.22 111.98 19.22C111.31 19.22 110.785 19.47 110.405 19.97C110.035 20.46 109.85 21.14 109.85 22.01C109.85 22.88 110.035 23.565 110.405 24.065C110.785 24.555 111.31 24.8 111.98 24.8ZM119.233 26L116.323 18.02H118.018L120.193 24.38L122.368 18.02H124.078L121.153 26H119.233ZM128.387 26.18C127.607 26.18 126.932 26.01 126.362 25.67C125.802 25.33 125.367 24.845 125.057 24.215C124.757 23.585 124.607 22.85 124.607 22.01C124.607 21.17 124.757 20.44 125.057 19.82C125.367 19.19 125.802 18.705 126.362 18.365C126.922 18.015 127.582 17.84 128.342 17.84C129.062 17.84 129.697 18.01 130.247 18.35C130.797 18.68 131.222 19.16 131.522 19.79C131.832 20.42 131.987 21.18 131.987 22.07V22.475H126.257C126.297 23.255 126.502 23.84 126.872 24.23C127.252 24.62 127.762 24.815 128.402 24.815C128.872 24.815 129.262 24.705 129.572 24.485C129.882 24.265 130.097 23.97 130.217 23.6L131.867 23.705C131.657 24.445 131.242 25.045 130.622 25.505C130.012 25.955 129.267 26.18 128.387 26.18ZM126.257 21.275H130.307C130.257 20.565 130.052 20.04 129.692 19.7C129.342 19.36 128.892 19.19 128.342 19.19C127.772 19.19 127.302 19.37 126.932 19.73C126.572 20.08 126.347 20.595 126.257 21.275ZM133.598 26V18.02H135.053L135.113 20.135L134.978 20.09C135.088 19.37 135.308 18.845 135.638 18.515C135.978 18.185 136.433 18.02 137.003 18.02H137.768V19.445H137.003C136.603 19.445 136.268 19.51 135.998 19.64C135.728 19.77 135.523 19.97 135.383 20.24C135.253 20.51 135.188 20.86 135.188 21.29V26H133.598ZM141.975 26.18C141.225 26.18 140.59 26.065 140.07 25.835C139.56 25.605 139.165 25.29 138.885 24.89C138.605 24.48 138.445 24.01 138.405 23.48L140.04 23.405C140.12 23.845 140.31 24.195 140.61 24.455C140.91 24.715 141.365 24.845 141.975 24.845C142.475 24.845 142.87 24.765 143.16 24.605C143.45 24.445 143.595 24.19 143.595 23.84C143.595 23.65 143.545 23.49 143.445 23.36C143.355 23.22 143.175 23.105 142.905 23.015C142.635 22.915 142.235 22.82 141.705 22.73C140.915 22.58 140.295 22.405 139.845 22.205C139.395 22.005 139.075 21.75 138.885 21.44C138.695 21.13 138.6 20.755 138.6 20.315C138.6 19.585 138.87 18.99 139.41 18.53C139.96 18.07 140.75 17.84 141.78 17.84C142.47 17.84 143.05 17.96 143.52 18.2C143.99 18.43 144.355 18.745 144.615 19.145C144.885 19.535 145.055 19.975 145.125 20.465L143.49 20.555C143.44 20.275 143.34 20.035 143.19 19.835C143.05 19.625 142.86 19.465 142.62 19.355C142.38 19.235 142.095 19.175 141.765 19.175C141.255 19.175 140.875 19.275 140.625 19.475C140.375 19.675 140.25 19.935 140.25 20.255C140.25 20.495 140.305 20.69 140.415 20.84C140.535 20.99 140.725 21.115 140.985 21.215C141.245 21.305 141.59 21.385 142.02 21.455C142.85 21.595 143.5 21.77 143.97 21.98C144.44 22.18 144.77 22.43 144.96 22.73C145.15 23.03 145.245 23.395 145.245 23.825C145.245 24.325 145.105 24.75 144.825 25.1C144.545 25.45 144.16 25.72 143.67 25.91C143.18 26.09 142.615 26.18 141.975 26.18ZM146.854 26V15.35H148.444V21.965L152.029 18.02H154.039L150.919 21.38L154.159 26H152.329L149.854 22.37L148.444 23.87V26H146.854ZM155.248 26V18.02H156.838V26H155.248ZM155.218 16.865V15.275H156.868V16.865H155.218ZM160.709 26C160.189 26 159.769 25.865 159.449 25.595C159.129 25.325 158.969 24.895 158.969 24.305V15.35H160.559V24.155C160.559 24.335 160.604 24.47 160.694 24.56C160.794 24.65 160.934 24.695 161.114 24.695H161.744V26H160.709ZM164.796 26C164.276 26 163.856 25.865 163.536 25.595C163.216 25.325 163.056 24.895 163.056 24.305V15.35H164.646V24.155C164.646 24.335 164.691 24.47 164.781 24.56C164.881 24.65 165.021 24.695 165.201 24.695H165.831V26H164.796Z" fill="white"/>
    </svg>
  );
}

/**
 * "Built with OverSkill" wordmark (200x42) — the badge label used when the
 * creator has DISABLED remixing but still shows the badge
 * (feat/badge-built-with-and-switcher). Unlike the pre-rendered
 * "Remix on OverSkill" path wordmark, there's no SVG-path handoff for this
 * label, so it's an inline SVG <text> run. It's recolored the same way as the
 * glyph + path wordmark — overskill-badge.css applies `fill: var(--os-badge-mark)`
 * to `svg text` too — so it stays theme-adaptive (ink on the light-site badge,
 * paper on the dark-mode badge). The leading x=40 clears the 42px glyph, and
 * the `--builtwith` modifier on the pill widens the expanded label to fit.
 */
function OverSkillBuiltWithWordmark() {
  return (
    <svg
      width="200"
      height="42"
      viewBox="0 0 200 42"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <text
        x="40"
        y="26"
        fontFamily="system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
        fontSize="15"
        fontWeight="600"
        letterSpacing="-0.15"
      >
        Built with OverSkill
      </text>
    </svg>
  );
}

export default App;
