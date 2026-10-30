/**
 * PWA post-deploy reload-guard logic (FM-2 fix, Jul 2026).
 *
 * Pure logic — no imports, no globals, no side effects — so the
 * "reloads at most once" guarantee is unit-testable on the platform side
 * (spec/javascript/template_pwa_update_guard.test.js) without a browser
 * or workbox-window. The side-effectful wiring lives in ./pwa-update.ts.
 *
 * Background: generated apps ship a Workbox service worker with
 * skipWaiting + clientsClaim (see vite.config.ts). After a deploy, the new
 * service worker takes control of open pages (`controllerchange`) but the
 * page keeps running the OLD precached JS until it reloads. Historically
 * nothing reloaded, so the first load after a deploy commonly served the
 * previous bundle — a false "still broken" signal right after a real fix
 * shipped.
 *
 * Decision model for a `controllerchange` event:
 *
 * - "ignore"      → first-install claim: the page had NO controller when it
 *                   loaded, so its assets came fresh from the network.
 *                   Nothing is stale; reloading would only slow first load.
 * - "auto-reload" → the takeover happened moments after page load (the
 *                   "first navigation after a deploy" case: the old SW served
 *                   stale precache, then the new SW installed + claimed).
 *                   One automatic reload lands the user on fresh assets.
 *                   Budgeted to AT MOST ONE per tab session so a pathological
 *                   controller churn (e.g. a proxy serving byte-different
 *                   sw.js on every request) can never reload-loop.
 * - "prompt"      → the page has been open a while (mid-session deploy) or
 *                   the session's auto-reload budget is spent. Never yank the
 *                   page out from under the user — show the non-blocking
 *                   "New version available — Reload" banner instead.
 */

/**
 * A controllerchange later than this after page load is treated as a
 * mid-session update (prompt) rather than a first-load takeover (reload).
 */
export const AUTO_RELOAD_MAX_PAGE_AGE_MS = 30_000;

/**
 * sessionStorage key marking that this tab already spent its one automatic
 * post-deploy reload. sessionStorage survives reloads within the tab (and is
 * cleared when the tab closes), which is exactly the lifetime we want: a
 * reload loop would require two automatic reloads in the same tab session,
 * and the flag makes the second one structurally impossible.
 */
export const SESSION_RELOAD_FLAG = "overskill-pwa-auto-reloaded";

export type ControllerChangeDecision = "ignore" | "auto-reload" | "prompt";

export function decideOnControllerChange(input: {
  hadControllerAtLoad: boolean;
  pageAgeMs: number;
  autoReloadAlreadyUsed: boolean;
}): ControllerChangeDecision {
  if (!input.hadControllerAtLoad) return "ignore";
  if (
    input.pageAgeMs <= AUTO_RELOAD_MAX_PAGE_AGE_MS &&
    !input.autoReloadAlreadyUsed
  ) {
    return "auto-reload";
  }
  return "prompt";
}

export interface ControllerChangeDeps {
  /** Whether navigator.serviceWorker.controller was set when the page loaded. */
  hadControllerAtLoad: boolean;
  /** Timestamp (ms) captured when the page loaded. */
  pageLoadedAt: number;
  now: () => number;
  /**
   * Reads the per-tab-session auto-reload flag. Implementations MUST return
   * true when the flag state is unknowable (e.g. sessionStorage blocked) —
   * "assume spent" is the safe direction; it can only downgrade a reload to
   * a prompt, never cause a loop.
   */
  readAutoReloadUsed: () => boolean;
  /**
   * Persists the per-tab-session auto-reload flag. MUST return true only
   * when the flag was durably written — the handler refuses to auto-reload
   * without a persisted guard (an unguarded reload could loop if
   * controllerchange fired on every page load).
   */
  markAutoReloadUsed: () => boolean;
  reload: () => void;
  showUpdatePrompt: () => void;
}

/**
 * Builds the `controllerchange` handler. Guarantees, in order:
 *
 * 1. Never reloads on the first-install claim (no prior controller).
 * 2. Auto-reloads AT MOST ONCE per page lifetime (in-memory latch) AND at
 *    most once per tab session (persisted flag, written BEFORE reloading).
 * 3. If the persisted guard cannot be written, falls back to the prompt —
 *    an automatic reload is never issued without a durable loop guard.
 * 4. Every suppressed reload still surfaces the update prompt, so a new
 *    deploy is never silently unreachable.
 */
export function createControllerChangeHandler(
  deps: ControllerChangeDeps
): () => void {
  let autoReloadedThisPage = false;

  return () => {
    const decision = decideOnControllerChange({
      hadControllerAtLoad: deps.hadControllerAtLoad,
      pageAgeMs: deps.now() - deps.pageLoadedAt,
      autoReloadAlreadyUsed: autoReloadedThisPage || deps.readAutoReloadUsed(),
    });

    if (decision === "ignore") return;

    if (decision === "auto-reload") {
      autoReloadedThisPage = true;
      // Persist BEFORE reloading: sessionStorage survives the reload in this
      // tab, so even if the very next page load immediately sees another
      // controllerchange, it can never auto-reload again.
      if (deps.markAutoReloadUsed()) {
        deps.reload();
      } else {
        deps.showUpdatePrompt();
      }
      return;
    }

    deps.showUpdatePrompt();
  };
}
