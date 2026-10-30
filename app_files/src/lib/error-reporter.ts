import { isEditorOrigin } from './editor-origins'

/**
 * Error Reporter for OverSkill Generated Apps
 *
 * Provides "Ask AI to Fix" functionality for runtime errors in preview mode.
 * When the app is running in the OverSkill editor iframe, API errors can be
 * reported to the parent editor, which injects them into the AI chat for
 * automatic debugging and fixing.
 *
 * Architecture:
 * 1. fetch-interceptor.ts detects errors with __overskill_error flag
 * 2. This module formats the error and provides reporting functions
 * 3. postMessage sends error to parent editor
 * 4. Editor injects error details into AI chat
 */

// CRITICAL DEBUG: Log immediately when this module loads
console.log('[ErrorReporter] 🚀 MODULE LOADED - error-reporter.ts is being executed');

import { toast } from 'sonner'

console.log('[ErrorReporter] 📦 Sonner toast imported:', typeof toast, toast ? 'exists' : 'undefined');

// Check if we're running in preview mode (iframe in OverSkill editor)
export function isPreviewMode(): boolean {
  // Check if we're in an iframe
  if (window.self === window.top) {
    return false
  }

  // Check if hostname indicates preview
  const hostname = window.location.hostname
  return hostname.startsWith('preview-') && hostname.endsWith('.overskill.app')
}

// Check if we're being captured by URLbox for a template/gallery screenshot.
//
// The Cloudflare Worker injects window.APP_CONFIG.SCREENSHOT_MODE = true when
// it serves HTML to a request carrying a valid X-Preview-Auth header (the
// AppScreenshotGenerationJob → UrlboxService path). In that context the
// page is rendered once, headless, to bake the gallery card + template
// show-page preview image. ANY error toast shown here gets permanently
// baked into that screenshot — e.g. the benign 401 on /api/auth/me
// (screenshot user is unauthenticated for some routes) surfaced an
// "API Error / Forbidden" toast that ended up in Crate's published preview.
//
// Screenshots must capture a clean rendered state, so when SCREENSHOT_MODE
// is on we suppress ALL error toasts at the source. Errors are still logged
// to the console (for debugging) — we only skip the visible toast UI.
export function isScreenshotMode(): boolean {
  try {
    return typeof window !== 'undefined' && (window as any).APP_CONFIG?.SCREENSHOT_MODE === true
  } catch {
    return false
  }
}

// ─── Toast flood guard (Jul 2026, support ticket #752) ─────────────────────
//
// Two independent protections, both applied inside showErrorToast() (the
// single choke point every toast goes through):
//
// 1. BACKGROUND-ENDPOINT SUPPRESSION. Some endpoints are polled passively by
//    the SDK — not triggered by a user action — so a persistent failure must
//    NEVER surface as a user-facing toast. The canonical example is
//    /api/me/entitlements: the SDK's useEntitlement() hook refetches it on a
//    30s interval, on every visibilitychange, and on every consumer mount.
//    The SDK already swallows its errors (EntitlementClient.list() returns []
//    on any failure), but the RAW non-2xx response passes through the global
//    fetch interceptor BEFORE that swallow — which used to pop an "API Error"
//    toast per poll tick per mounted consumer ("hundreds of toasts within
//    minutes", tickets #711/#748/#752). Suppressed errors are still logged to
//    the console so the editor's AI debugging pipeline keeps seeing them.
//
// 2. DEDUP + RATE LIMIT. Identical error toasts show at most once per
//    TOAST_DEDUP_WINDOW_MS, and at most TOAST_RATE_MAX error toasts total can
//    appear per TOAST_RATE_WINDOW_MS regardless of key. A failing endpoint —
//    ANY endpoint — can therefore never flood the screen; the user sees the
//    first toast (actionable) instead of hundreds (unusable app).

export const BACKGROUND_TOAST_SUPPRESSED_PATHS = [
  '/api/me/entitlements',
  // Buyer wallet balance (Jul 2026): background read behind the settings
  // "AI Credits" card + useWalletBalance(). A failing read hides the card;
  // it must never toast (same contract as the entitlements poll).
  '/api/wallet/balance'
]

// Show the same error toast at most once per 30s.
const TOAST_DEDUP_WINDOW_MS = 30_000
// Across ALL error keys, at most 3 toasts per 10s window.
const TOAST_RATE_WINDOW_MS = 10_000
const TOAST_RATE_MAX = 3

const recentToastsByKey = new Map<string, number>()
let toastRateWindowStart = 0
let toastRateWindowCount = 0

/**
 * Is this URL a background/polling read whose errors must never toast?
 * Accepts absolute URLs, root-relative paths, and paths with query strings.
 */
export function isBackgroundEndpoint(url: string | null | undefined): boolean {
  if (!url) return false
  let path = url
  try {
    if (/^https?:\/\//i.test(url)) {
      path = new URL(url).pathname
    } else {
      path = url.split('?')[0].split('#')[0]
    }
  } catch {
    return false
  }
  return BACKGROUND_TOAST_SUPPRESSED_PATHS.some(
    (suppressed) => path === suppressed || path.startsWith(suppressed + '/')
  )
}

/**
 * Flood-guard predicate: returns true when a toast for `key` may be shown
 * right now, and records it. Pure enough to unit-test by passing `now`.
 */
export function shouldShowErrorToast(key: string, now: number = Date.now()): boolean {
  const lastShownAt = recentToastsByKey.get(key)
  if (lastShownAt !== undefined && now - lastShownAt < TOAST_DEDUP_WINDOW_MS) {
    return false
  }

  if (now - toastRateWindowStart >= TOAST_RATE_WINDOW_MS) {
    toastRateWindowStart = now
    toastRateWindowCount = 0
  }
  if (toastRateWindowCount >= TOAST_RATE_MAX) {
    return false
  }

  toastRateWindowCount++
  recentToastsByKey.set(key, now)

  // Bound the map — prune entries older than the dedup window.
  if (recentToastsByKey.size > 50) {
    for (const [k, shownAt] of recentToastsByKey) {
      if (now - shownAt >= TOAST_DEDUP_WINDOW_MS) recentToastsByKey.delete(k)
    }
  }

  return true
}

/** Test-only: clear flood-guard state between test cases. */
export function resetToastFloodGuardForTests(): void {
  recentToastsByKey.clear()
  toastRateWindowStart = 0
  toastRateWindowCount = 0
}

// Get the parent editor origin for postMessage
function getEditorOrigin(): string | null {
  // In production, use the referrer to determine origin
  try {
    const referrer = document.referrer
    if (referrer) {
      const url = new URL(referrer)
      if (isEditorOrigin(url.origin)) {
        return url.origin
      }
    }
  } catch (e) {
    // Referrer parsing failed, try other methods
  }

  // Fallback: try each valid origin
  // In dev, it's likely localhost or dev.overskill.com
  if (window.location.hostname.includes('localhost') || window.location.hostname.includes('dev.')) {
    return 'https://dev.overskill.com'
  }

  return 'https://www.overskill.com'
}

// Format error for display and reporting
export interface OverskillError {
  error: string
  category?: string
  status: number
  endpoint?: string
  method?: string
  timestamp: string
  suggestion?: string
  invalidColumns?: string[]
  validColumns?: string[]
  docUrl?: string
  requestBody?: any
  __overskill_error: true
  __error_meta?: {
    timestamp: string
    status: number
    endpoint?: string
    method?: string
  }
}

// Report error to parent editor via postMessage
export function reportErrorToEditor(error: OverskillError, context?: {
  url?: string
  method?: string
  requestBody?: any
}): void {
  if (!isPreviewMode()) {
    console.log('[ErrorReporter] Not in preview mode, skipping editor report')
    return
  }

  const editorOrigin = getEditorOrigin()
  if (!editorOrigin) {
    console.warn('[ErrorReporter] Could not determine editor origin')
    return
  }

  // Format error message for AI chat injection
  const errorReport = {
    type: 'OVERSKILL_RUNTIME_ERROR',
    error: {
      message: error.error,
      category: error.category || 'UNKNOWN',
      status: error.status || error.__error_meta?.status || 500,
      endpoint: context?.url || error.endpoint || error.__error_meta?.endpoint,
      method: context?.method || error.method || error.__error_meta?.method,
      timestamp: error.timestamp || error.__error_meta?.timestamp || new Date().toISOString(),
      suggestion: error.suggestion,
      invalidColumns: error.invalidColumns,
      validColumns: error.validColumns,
      docUrl: error.docUrl,
      requestBody: context?.requestBody
    },
    appUrl: window.location.href,
    userAgent: navigator.userAgent
  }

  console.log('[ErrorReporter] Sending runtime error to editor:', errorReport)

  try {
    window.parent.postMessage(errorReport, editorOrigin)
    console.log('[ErrorReporter] ✅ Error reported to editor')
  } catch (e) {
    console.error('[ErrorReporter] Failed to send error to editor:', e)
  }
}

// Show error toast with "Ask AI to Fix" action in preview mode
export function showErrorToast(error: OverskillError, context?: {
  url?: string
  method?: string
  requestBody?: any
}): void {
  console.log('[ErrorReporter] 🎯 showErrorToast ENTRY POINT', {
    error: error?.error?.substring?.(0, 100),
    category: error?.category,
    __overskill_error: error?.__overskill_error
  });

  const errorMessage = error.error || 'An error occurred'
  const suggestion = error.suggestion

  // Background/polling endpoints (30s entitlement poll etc.) must never
  // surface a toast — a persistent failure would re-toast on every tick and
  // every consumer mount. Console-only so AI debugging still sees it.
  // See "Toast flood guard" block above (ticket #752).
  const requestEndpoint = context?.url || error.endpoint || error.__error_meta?.endpoint
  if (isBackgroundEndpoint(requestEndpoint)) {
    console.log('[ErrorReporter] 🤫 Background endpoint error — toast suppressed', {
      endpoint: requestEndpoint,
      status: error.status,
      error: errorMessage?.substring?.(0, 100)
    });
    return;
  }

  // Format the title based on category
  let title = 'API Error'
  if (error.category) {
    switch (error.category) {
      case 'COLUMN_NOT_FOUND':
        title = 'Missing Column'
        break
      case 'USER_SCOPING_ERROR':
      case 'ENTITY_SCOPING_MISMATCH':
        title = 'Entity Scoping Error'
        break
      case 'ENTITY_NOT_FOUND':
        title = 'Entity Not Found'
        break
      case 'VALIDATION_ERROR':
        title = 'Validation Failed'
        break
      default:
        title = 'API Error'
    }
  }

  // Suppress all error toasts during URLbox screenshot capture so we never
  // bake a transient error overlay (e.g. the benign /api/auth/me 401) into a
  // published gallery card or template show-page preview image. The error is
  // still logged below via console for debugging; only the toast UI is skipped.
  if (isScreenshotMode()) {
    console.log('[ErrorReporter] 📸 SCREENSHOT_MODE active — suppressing error toast to keep capture clean', {
      title,
      status: error.status,
      category: error.category
    });
    return;
  }

  // Dedup + rate limit (ticket #752): the same error toasts at most once per
  // 30s, and no more than 3 error toasts can appear per 10s overall. A
  // repeatedly-failing request (polling hook, remount burst on navigation)
  // shows ONE actionable toast instead of flooding the screen. Suppressed
  // repeats are still console-logged for the AI debugging pipeline.
  let endpointKey = requestEndpoint || 'unknown'
  try {
    if (/^https?:\/\//i.test(endpointKey)) endpointKey = new URL(endpointKey).pathname
    else endpointKey = endpointKey.split('?')[0].split('#')[0]
  } catch {
    // keep raw value
  }
  const toastKey = `${error.category || 'API_ERROR'}|${error.status}|${endpointKey}|${errorMessage}`
  if (!shouldShowErrorToast(toastKey)) {
    console.log('[ErrorReporter] 🔁 Duplicate/rate-limited error toast suppressed', {
      toastKey: toastKey.substring(0, 160),
      status: error.status
    });
    return;
  }

  const previewMode = isPreviewMode();
  console.log('[ErrorReporter] 🔔 showErrorToast preparing toast', {
    title,
    errorMessage: errorMessage.substring(0, 100),
    category: error.category,
    isPreviewMode: previewMode,
    hostname: window.location.hostname,
    inIframe: window.self !== window.top,
    toastFunction: typeof toast,
    toastErrorFunction: typeof toast?.error
  })

  // In preview mode, show toast with "Ask AI to Fix" button
  if (previewMode) {
    console.log('[ErrorReporter] 🎉 PREVIEW MODE - showing toast with Ask AI to Fix button');
    try {
      toast.error(title, {
        description: errorMessage,
        duration: 10000, // Keep visible longer for action
        action: {
          label: 'Ask AI to Fix',
          onClick: () => {
            console.log('[ErrorReporter] 🖱️ Ask AI to Fix button CLICKED');
            reportErrorToEditor(error, context)

            // Show confirmation
            toast.info('Error sent to AI', {
              description: 'Check the chat for debugging assistance',
              duration: 3000
            })
          }
        }
      })
      console.log('[ErrorReporter] ✅ toast.error() called successfully (preview mode)');
    } catch (toastError) {
      console.error('[ErrorReporter] 💥 ERROR calling toast.error():', toastError);
    }
  } else {
    console.log('[ErrorReporter] 📢 PRODUCTION MODE - showing standard toast');
    try {
      // In production, show standard error toast without AI fix option
      toast.error(title, {
        description: suggestion || errorMessage,
        duration: 5000
      })
      console.log('[ErrorReporter] ✅ toast.error() called successfully (production mode)');
    } catch (toastError) {
      console.error('[ErrorReporter] 💥 ERROR calling toast.error():', toastError);
    }
  }
}

// Parse response to detect Overskill errors
export async function detectOverskillError(response: Response): Promise<OverskillError | null> {
  console.log('[ErrorReporter] detectOverskillError called', {
    ok: response.ok,
    status: response.status,
    url: response.url
  });

  // Only check error responses
  if (response.ok) {
    console.log('[ErrorReporter] Response is OK, returning null');
    return null
  }

  try {
    // Clone response so it can be read again by caller
    console.log('[ErrorReporter] Cloning response...');
    const clone = response.clone()
    console.log('[ErrorReporter] Parsing JSON...');
    const data = await clone.json()
    console.log('[ErrorReporter] Parsed JSON data:', {
      hasData: !!data,
      __overskill_error: data?.__overskill_error,
      error: data?.error?.substring?.(0, 100),
      category: data?.category
    });

    // Check for __overskill_error flag
    if (data && data.__overskill_error === true) {
      console.log('[ErrorReporter] ✅ __overskill_error flag FOUND!');
      return data as OverskillError
    }

    // Also handle errors that look like Overskill format even without flag
    if (data && data.error && (data.category || data.suggestion)) {
      console.log('[ErrorReporter] ✅ Overskill-like error format detected (no flag)');
      return {
        ...data,
        __overskill_error: true,
        status: response.status,
        timestamp: new Date().toISOString()
      } as OverskillError
    }

    console.log('[ErrorReporter] ⚠️ No __overskill_error flag in response');
  } catch (e) {
    // Response wasn't JSON — this is the EXPECTED case for HTML 500 pages,
    // plain-text responses, empty bodies, etc. Log at `debug` level (NOT
    // `error`) so it doesn't trip the OverSkill editor's auto-fix loop.
    //
    // Background (May 2026): Previously this used console.error, which the
    // runtime SDK's console interceptor captured and forwarded to the editor
    // as a build error. The error_detector_controller's /SyntaxError/i
    // actionable-pattern matched (because Response.json() rejection is a
    // SyntaxError), routing the noise to AI auto-fix and burning credits on
    // a non-existent code bug. The comment "Response wasn't JSON, ignore"
    // captured the original intent — `console.debug` makes it actually true.
    console.debug('[ErrorReporter] Response not JSON (expected for non-OverSkill errors):', e);
  }

  return null
}

// Initialize error reporter logging
console.log('[OverSkill] Error reporter initialized', {
  isPreviewMode: isPreviewMode(),
  hostname: window.location.hostname
})

export {}
