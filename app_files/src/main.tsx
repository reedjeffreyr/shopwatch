// MUST stay the first import (SW-102): adopts the /callback sign-in token
// before anything imports overskill-sdk. See lib/callbackTokenBoot.ts.
import "./lib/callbackTokenBoot";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.tsx";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./index.css";

// CRITICAL: Initialize fetch interceptor FIRST (before any fetch calls)
// This captures 401, 404, and network errors for AI debugging
import "./lib/fetch-interceptor";

// Initialize analytics tracking (page views, sessions, errors, Core Web Vitals)
// Sends data to /__analytics endpoint -> Cloudflare Analytics Engine
import "./lib/analytics";

// Capture the affiliate ref the visitor may have arrived with (?a= / ?ref= /
// ?affiliate= — the creator's Whop affiliate program). The param is only on
// the LANDING URL, so this runs once at boot; lib/whop.ts sends the stored
// value with any later checkout mint and the platform decides whether it
// attributes. DO NOT remove — without it a buyer who browses before buying
// loses the affiliate who referred them.
import { captureAffiliateRef } from "./lib/whop";
captureAffiliateRef();

// Console logging for AI debugging is now handled by the OverSkill Platform SDK
// loaded from CDN in index.html (https://sdk.overskill.com/v1/platform.js)
// This enables hot-updates to logging without rebuilding apps

// Initialize preview auth for iframe OAuth testing (development only)
import "./lib/preview-auth";

// Session integrity (Russell's session-integrity report): wire the 401 reaction
// (one silent re-auth, else forced logout) + the resume-revalidation listener
// (tab backgrounded for days → on refocus re-check exp + one authed request).
// The synchronous exp-gate that drops a dead token before first paint runs at
// import time inside lib/auth.ts (sanitizeStoredToken). This install only adds
// listeners — it never acts unless a token is present, so public / no-login
// share/view flows are untouched.
import { installSessionIntegrity } from "./lib/sessionIntegrity";
import { overskill } from "./lib/auth";
installSessionIntegrity({
  appId: import.meta.env.VITE_APP_ID,
  // One silent re-auth attempt on a 401 (re-mints from the current token if the
  // Worker supports /api/auth/refresh). Fails soft; a dead token can't refresh.
  silentReauth: async () => {
    const refresh = (overskill.auth as unknown as { refresh?: () => Promise<unknown> }).refresh;
    if (typeof refresh !== "function") return false;
    try {
      return !!(await refresh.call(overskill.auth));
    } catch {
      return false;
    }
  },
  // One lightweight authenticated request on resume.
  revalidate: async () => !!(await overskill.auth.checkSession()),
});

// Initialize theme preview listener for OverSkill editor integration
import "./lib/theme-preview";

// PWA post-deploy update flow (FM-2, Jul 2026). Registers the Workbox service
// worker (vite.config.ts sets injectRegister: false — registration is owned
// here) and makes new deploys reach open tabs: one guarded auto-reload when a
// new service worker takes control right after page load, plus a small
// "New version available — Reload" banner for long-lived sessions.
// DO NOT remove this import — without it the service worker never registers
// and users keep seeing the previous deploy's cached bundle.
import "./lib/pwa-update";

// Window-level safety net for non-React errors (event handlers, async callbacks).
// React render errors are caught by <ErrorBoundary> below — they do NOT fire
// window.onerror and would otherwise crash the tree silently.
window.addEventListener('error', (event) => {
  console.error('Application Error:', event.message, {
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno
  });
});

// NOTE: App.tsx already includes BrowserRouter with routing
// Auth routes are pre-configured: /login, /callback, /logged-out, /access-denied
// Don't add another BrowserRouter here - causes double routing and React crashes

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
