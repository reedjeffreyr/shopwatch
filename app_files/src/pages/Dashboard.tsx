import React from 'react';
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { overskill, useAuth } from "@/lib/auth";
import AppBrand from "@/components/AppBrand";
import { Loader2, LogIn, Shield } from "lucide-react";
import ShopDashboard from "@/pages/ShopDashboard";

/**
 * Dashboard Page (Protected)
 *
 * This is the main app area where authenticated users interact with the app.
 * This page is ALWAYS protected - users must be logged in to access it.
 *
 * Architecture: "Public Landing + Protected Interior"
 * - / (landing) -> Always public
 * - /dashboard (this page) -> Protected, main app functionality
 * - /settings, /profile -> Protected
 *
 * Put the app's main functionality HERE on the dashboard, not on the landing
 * page — the landing page is for marketing/CTA only.
 *
 * ============================================================================
 * ENTITY ACCESS PATTERN (reference — this scaffold ships NO live entity calls)
 * ============================================================================
 * ⚠️ This starter page deliberately makes ZERO `overskill.entities.*` calls.
 * An entity call against an entity that was never created with
 * os-create-entity fails at runtime (404 "Not Found") for every real user —
 * so entity plumbing and os-create-entity MUST land in the SAME turn.
 *
 * When you build the app's real functionality here:
 *   1. Create each entity FIRST: os-create-entity (entity_name: 'item', ...)
 *   2. Then use the client (imported from @/lib/auth):
 *
 *   import { overskill } from "@/lib/auth"
 *
 *   const items   = await overskill.entities.item.list()
 *   const active  = await overskill.entities.item.filter({ done: false })
 *   const found   = await overskill.entities.item.search(term)   // server-side FTS5
 *   const newItem = await overskill.entities.item.create({ title: "New" })
 *   await overskill.entities.item.update(itemId, { done: true })
 *   await overskill.entities.item.delete(itemId)
 *
 * FETCH-ON-MOUNT AUTH GUARD (required for any page fetching user-scoped
 * entities): OAuth callback lands with #access_token=... in the URL hash and
 * React's useEffect can fire BEFORE auth.ts finishes extracting it — causing
 * 401 "API Error" toasts on first load after login. Always gate mount-time
 * fetches on auth state and re-run once it resolves:
 *
 *   const { user, loading: authLoading } = useAuth();
 *   const [isLoading, setIsLoading] = useState(true);
 *   useEffect(() => {
 *     if (authLoading) return;        // auth still resolving — wait
 *     if (!user) {                    // REQUIRED — settled and logged OUT.
 *       setIsLoading(false);          // Clear the flag or the page hangs.
 *       return;
 *     }
 *     loadItems();                    // clears isLoading in its finally
 *   }, [authLoading, user]);
 *
 * ⚠️ THE `!user` BRANCH MUST CLEAR YOUR OWN DATA-LOADING FLAG. A data flag
 * declared `useState(true)` is only ever cleared inside the fetch, so if the
 * effect returns early for a logged-out visitor the flag stays true FOREVER.
 * Gate any spinner on it — `if (authLoading || isLoading) return <Spinner/>`
 * — and a logged-out visitor who lands on this route directly (typed URL,
 * bookmark, refresh) gets an infinite spinner that no timeout can clear,
 * because nothing is in flight. It looks like a hung auth check; it is not.
 * Note this bites ONLY on direct navigation: in-app links usually originate
 * from an authenticated session, so the bug hides during click-through QA.
 * A `public`-visibility app is the sharp edge — ProtectedRoute allows anonymous
 * visitors through to user-scoped pages, so the logged-out render really happens.
 * If the route should never render logged-out, redirect in that branch instead:
 * `return <Navigate to="/login" replace />`. Either way, never leave the flag set.
 *
 * ERROR HANDLING (do NOT remove or hollow out):
 * Wrap entity calls in try/catch and surface failures to the user — e.g.
 * toast.error(...) from "@/components/ui/sonner". NEVER swallow errors with
 * an empty catch: silent catches hide real failures (auth issues, network
 * problems, server errors) from users AND from the platform's automated
 * build monitor, so broken apps look "working" until someone reports them.
 *
 *   try {
 *     const items = await overskill.entities.item.list();
 *     setItems(items || []);
 *   } catch (error) {
 *     console.error("Failed to load items:", error);
 *     toast.error("Couldn't load your items.");
 *   }
 * ============================================================================
 */

export default function Dashboard() {
  const navigate = useNavigate();

  // Auth state for the signed-in account card below. See the doc block above
  // for the mount-time fetch guard REQUIRED when you add entity calls here.
  const { user, loading } = useAuth();

  const handleLogout = async () => {
    await overskill.auth.logout();
    navigate('/logged-out');
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Dashboard Header */}
      <div className="border-b">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <AppBrand name="Shopwatch" icon={<Shield aria-hidden="true" className="h-5 w-5" />} className="flex shrink-0 items-center gap-3" />
            <span className="hidden border-l border-border pl-3 text-sm font-semibold text-muted-foreground sm:inline">Your stores</span>
          </div>
          <div className="flex items-center gap-2 sm:gap-3">
            <span className="hidden max-w-48 truncate text-sm text-muted-foreground md:inline">{user?.email}</span>
            {loading ? null : user ? (
              <>
                <Button variant="ghost" onClick={() => navigate('/settings')}>Settings</Button>
                <Button variant="outline" onClick={handleLogout}>Log out</Button>
              </>
            ) : (
              <Button variant="default" onClick={() => overskill.auth.login()}>Sign in</Button>
            )}
          </div>
        </div>
      </div>

      {/* Dashboard Content — replace this placeholder with the app's real
          functionality (see ENTITY ACCESS PATTERN above). */}
      <div className="container mx-auto px-4 py-8">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : !user ? (
          /* SETTLED AND LOGGED OUT. This branch is REQUIRED, and it is the one
             a click-through QA pass never sees: in-app links originate from an
             authenticated session, so only a typed URL, a bookmark or a refresh
             lands here. Without it the page rendered "Welcome", "You're signed
             in." and a Logout button to an anonymous visitor whose
             /api/auth/me had already answered 401 — measured on a live app,
             2026-08-24. Never assert an auth state you have not confirmed:
             `user?.email ? ... : "You're signed in."` treated a MISSING user as
             a signed-in one with an unknown address. */
          <div className="max-w-lg mx-auto">
            <Card>
              <CardHeader>
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted">
                    <LogIn className="h-5 w-5 text-muted-foreground" />
                  </div>
                  <div>
                    <CardTitle>You're not signed in</CardTitle>
                    <CardDescription>
                      Sign in to see your account area.
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  This page is your account area once you're signed in. Your
                  profile and preferences live behind sign-in.
                </p>
                <Button onClick={() => overskill.auth.login()}>Sign in</Button>
              </CardContent>
            </Card>
          </div>
        ) : (
          <div className="container mx-auto px-4 py-8">
            <ShopDashboard />
          </div>
        )}
      </div>
    </div>
  );
}