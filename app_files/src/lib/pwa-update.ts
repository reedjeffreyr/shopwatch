/**
 * PWA post-deploy update flow (FM-2 fix, Jul 2026).
 *
 * Owns service-worker REGISTRATION for the app (vite.config.ts sets
 * `injectRegister: false`, so the PWA plugin no longer injects its own
 * registerSW.js script) and makes new deploys reach users reliably:
 *
 * 1. Guarded one-time reload on `controllerchange`. The Workbox SW ships
 *    skipWaiting + clientsClaim, so after a deploy the NEW service worker
 *    takes control of the page while the page is still running the OLD
 *    precached bundle. When that takeover happens right after page load
 *    (the "first navigation after a deploy" case), we reload once so the
 *    user lands on fresh assets instead of the previous deploy's bundle.
 *    The reload is budgeted to AT MOST ONCE per tab session — see
 *    ./pwa-update-guard.ts for the loop-safety contract.
 *
 * 2. "New version available — Reload" banner for long-lived sessions.
 *    A mid-session takeover (periodic update check found a new deploy)
 *    never yanks the page; the user gets a small non-blocking banner and
 *    reloads on their own terms.
 *
 * 3. Periodic update checks (interval + tab-becomes-visible) so open tabs
 *    actually LEARN about new deploys. Without these, the browser only
 *    checks sw.js on navigation / every ~24h, so an open tab could sit on
 *    a stale bundle for its whole session.
 *
 * Why not `virtual:pwa-register` (vite-plugin-pwa's virtual module)?
 * - In `autoUpdate` mode it reloads UNCONDITIONALLY when an updated SW
 *   activates: mid-session tabs get yanked (form-input loss) and there is
 *   no once-per-session guard.
 * - In `prompt` mode (`onNeedRefresh`) it requires the new SW to sit in the
 *   WAITING state, which is incompatible with the skipWaiting/clientsClaim
 *   config we keep for immediate first-load takeover (and for parity with
 *   every already-deployed app).
 * Registering directly with workbox-window (officially supported via
 * `injectRegister: false`) gives us both behaviors safely.
 */

import { Workbox } from "workbox-window";
import {
  createControllerChangeHandler,
  SESSION_RELOAD_FLAG,
} from "./pwa-update-guard";

/** How often an open tab proactively checks for a new deploy. */
const UPDATE_CHECK_INTERVAL_MS = 15 * 60 * 1000;

/** Minimum gap between visibility-triggered update checks. */
const VISIBILITY_CHECK_MIN_GAP_MS = 60 * 1000;

export const UPDATE_BANNER_ID = "overskill-pwa-update-banner";

/**
 * Where this module publishes the app's ONE service-worker registration
 * (#3705 / #4770 / #4200).
 *
 * This app must never have two service-worker scripts registered at scope "/".
 * A registration is keyed by scope, so a second `register()` with a different
 * script URL REPLACES the first — which is exactly how the Workbox precache
 * worker and the SDK's /sw-push.js used to clobber each other, leaving push
 * events in a worker with no `push` listener.
 *
 * The push client therefore needs a way to find the registration this module
 * owns instead of creating a competing one. The handoff is written
 * SYNCHRONOUSLY, at module-eval time, before `wb.register()` can resolve — so a
 * `push.subscribe()` that fires early in app startup sees "a registration is
 * coming, wait for it" rather than "there is no registration, make one". Same
 * race-free idiom as `__overskillReactPushBanner`.
 *
 * Consumers: overskill-sdk's PushClient and overskill-runtime-sdk's push scope
 * guard. Keep the key in lockstep with both.
 */
export const SERVICE_WORKER_HANDOFF_KEY = "__overskillServiceWorker";

/** Shape published at `window[SERVICE_WORKER_HANDOFF_KEY]`. */
export interface ServiceWorkerHandoff {
  /** The one script URL this app registers. */
  scriptPath: string;
  scope: string;
  /**
   * Resolves with the registration, or `undefined` when registration failed.
   * NEVER rejects — a consumer must be able to `await` it unguarded.
   */
  registration: Promise<ServiceWorkerRegistration | undefined>;
}

function readAutoReloadUsed(): boolean {
  try {
    return window.sessionStorage.getItem(SESSION_RELOAD_FLAG) !== null;
  } catch {
    // Storage unavailable → we can't know. Assume spent: worst case the user
    // sees the update banner instead of an automatic reload. Never risk an
    // unguarded reload.
    return true;
  }
}

function markAutoReloadUsed(): boolean {
  try {
    window.sessionStorage.setItem(SESSION_RELOAD_FLAG, String(Date.now()));
    // Read back so a silently-dropped write (private-mode quirks) counts as
    // "not persisted" and downgrades the reload to a prompt.
    return window.sessionStorage.getItem(SESSION_RELOAD_FLAG) !== null;
  } catch {
    return false;
  }
}

/**
 * Small, self-contained update banner. Deliberately plain DOM (not sonner/
 * React): it must work even while the page is running a previous deploy's
 * bundle, before React mounts, and regardless of how the generated app's
 * component tree has been customized.
 */
export function showUpdateBanner(doc: Document = document): void {
  if (doc.getElementById(UPDATE_BANNER_ID)) return;
  if (!doc.body) {
    doc.addEventListener("DOMContentLoaded", () => showUpdateBanner(doc), {
      once: true,
    });
    return;
  }

  const banner = doc.createElement("div");
  banner.id = UPDATE_BANNER_ID;
  banner.setAttribute("role", "status");
  banner.setAttribute("aria-live", "polite");
  banner.style.cssText = [
    "position:fixed",
    "left:50%",
    "transform:translateX(-50%)",
    "bottom:calc(16px + env(safe-area-inset-bottom, 0px))",
    "z-index:2147483000",
    "display:flex",
    "align-items:center",
    "gap:12px",
    "padding:10px 12px 10px 16px",
    "border-radius:12px",
    "background:#18181b",
    "color:#fafafa",
    "font:500 13px/1.4 system-ui,-apple-system,'Segoe UI',sans-serif",
    "box-shadow:0 8px 24px rgba(0,0,0,0.35)",
    "max-width:calc(100vw - 32px)",
  ].join(";");

  const label = doc.createElement("span");
  label.textContent = "A new version of this app is available.";

  const reloadButton = doc.createElement("button");
  reloadButton.type = "button";
  reloadButton.textContent = "Reload";
  reloadButton.style.cssText = [
    "border:none",
    "border-radius:8px",
    "padding:6px 12px",
    "background:#fafafa",
    "color:#18181b",
    "font:600 13px/1 system-ui,-apple-system,'Segoe UI',sans-serif",
    "cursor:pointer",
  ].join(";");
  reloadButton.addEventListener("click", () => {
    // The new service worker already controls the page (skipWaiting +
    // clientsClaim) — a plain reload lands on the fresh precache.
    window.location.reload();
  });

  const dismissButton = doc.createElement("button");
  dismissButton.type = "button";
  dismissButton.textContent = "Dismiss";
  dismissButton.setAttribute("aria-label", "Dismiss update notification");
  dismissButton.style.cssText = [
    "border:none",
    "background:transparent",
    "color:#a1a1aa",
    "font:500 13px/1 system-ui,-apple-system,'Segoe UI',sans-serif",
    "cursor:pointer",
    "padding:6px 4px",
  ].join(";");
  dismissButton.addEventListener("click", () => {
    banner.remove();
  });

  banner.append(label, reloadButton, dismissButton);
  doc.body.appendChild(banner);
}

export function setupPwaUpdate(): void {
  if (typeof window === "undefined") return;
  if (!("serviceWorker" in navigator)) return;
  // The Workbox SW only serves production builds (devOptions.enabled: false
  // in vite.config.ts keeps it out of the E2B dev preview, where it would
  // fight Vite HMR). Registering in dev would 404 on /sw.js and spam the
  // fetch-interceptor's AI-debugging channel with phantom network errors.
  if (!import.meta.env.PROD) return;

  const handleControllerChange = createControllerChangeHandler({
    hadControllerAtLoad: navigator.serviceWorker.controller !== null,
    pageLoadedAt: Date.now(),
    now: () => Date.now(),
    readAutoReloadUsed,
    markAutoReloadUsed,
    reload: () => window.location.reload(),
    showUpdatePrompt: () => showUpdateBanner(),
  });
  navigator.serviceWorker.addEventListener(
    "controllerchange",
    handleControllerChange
  );

  const wb = new Workbox("/sw.js");

  wb.addEventListener("activated", (event) => {
    if (!event.isUpdate) {
      // First install — precache is populated, offline works from here on.
      console.info("[overskill:pwa] App is ready to work offline.");
    }
  });

  let lastUpdateCheckAt = Date.now();
  const checkForUpdates = () => {
    lastUpdateCheckAt = Date.now();
    wb.update().catch(() => {
      // Offline or sw.js momentarily unreachable — the next check retries.
    });
  };

  const registering = wb.register();

  // Published SYNCHRONOUSLY (see SERVICE_WORKER_HANDOFF_KEY): the promise is
  // handed over before it can settle, so a push client that runs during app
  // startup waits for THIS registration instead of racing it with a second
  // script at the same scope. `.catch` here (not on `registering`) so the
  // handoff never rejects while the caller below still sees the failure.
  const handoff: ServiceWorkerHandoff = {
    scriptPath: "/sw.js",
    scope: "/",
    registration: registering.catch(() => undefined),
  };
  (window as unknown as Record<string, unknown>)[SERVICE_WORKER_HANDOFF_KEY] =
    handoff;

  registering
    .then(() => {
      // Registration itself triggers the browser's initial update check;
      // these keep LONG-LIVED tabs converging on new deploys.
      window.setInterval(checkForUpdates, UPDATE_CHECK_INTERVAL_MS);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState !== "visible") return;
        if (Date.now() - lastUpdateCheckAt < VISIBILITY_CHECK_MIN_GAP_MS) return;
        checkForUpdates();
      });
    })
    .catch((error) => {
      console.warn(
        "[overskill:pwa] Service worker registration failed:",
        error
      );
    });
}

setupPwaUpdate();
