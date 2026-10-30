import { useEffect, useState, useCallback } from 'react'
import { AlertTriangle, X } from 'lucide-react'
import { overskill, getAuthToken, isAuthenticated } from '@/lib/auth'

/**
 * PushHealthBanner (OS-V7HMWA / #3756)
 *
 * When a user's web-push subscription DIES (the browser cleared site data,
 * reset the notification permission, or the PWA was reinstalled), the platform
 * relay gets a 410/404 on the next send and permanently deactivates the
 * subscription. Before this banner, NOTHING told the user: their in-app bell
 * kept filling on schedule so the app looked healthy while push delivery was
 * silently dead until they happened to toggle the setting off and on.
 *
 * This is the unmissable, app-wide re-enable prompt. It reads the DERIVED
 * `health.needs_resubscribe` verdict from the worker's own `/api/push/status`
 * route (no inference required) and, when true, shows a top banner whose one
 * action calls `overskill.push.subscribe()` — the same path the "Notify me"
 * button uses. It is mounted GLOBALLY (App.tsx), not on the settings page: a
 * user with no reason to visit settings is exactly the person this bug traps.
 *
 * Rules honored:
 *  - Only shows for an authenticated user whose device push is actually dead.
 *  - "never_subscribed" (a user who simply never opted in) is NOT a breakage —
 *    health.needs_resubscribe is false for them, so this stays hidden.
 *  - Dismissible PER SESSION at most; it comes back on the next visit until an
 *    active subscription exists (re-checking clears the dismissal once healthy).
 *  - Push is non-essential: every failure path is caught so a status hiccup can't
 *    break the app. The one visible failure is a one-line reason after the user's
 *    own "Turn on" click (SW-250 — a silently resetting button read as broken).
 *  - Never shown in a frame or on a preview host (SW-250): the permission prompt
 *    cannot appear there.
 */

const DISMISS_KEY = 'overskill_push_reenable_dismissed'

// Coordination with the runtime SDK's push-recovery surface (platform.js, OS-V7HMWA /
// #3795). The CDN SDK ALSO ships a dead-push banner so it can reach apps created before
// #3792 (this component only lands at app-creation via the after_create copy_template_files
// hook). New apps therefore have BOTH — to guarantee exactly one banner, this template
// claims ownership SYNCHRONOUSLY at module-eval time (before the SDK's async /api/push/status
// fetch can resolve). The SDK checks this flag (and the data attribute below) and defers.
if (typeof window !== 'undefined') {
  try {
    const w = window as unknown as { __overskillReactPushBanner?: boolean }
    w.__overskillReactPushBanner = true
  } catch {
    // A frozen/guarded global is fine — the banner still renders and coordinates via
    // its data-overskill-push-recovery="react" attribute.
  }
}

// SW-250: never show where "Turn on" cannot work. Browsers refuse the permission
// prompt inside a cross-origin frame (the editor preview), and a preview host is never
// where customers receive push. Copy below is shared verbatim with the runtime SDK banner.
const PREVIEW_HOST_SUFFIXES = ['.overskillprojects.dev', '.e2b.app']
const CANONICAL_PREVIEW_HOST = /^(?:staging-)?preview-[a-z0-9-]+\.overskill\.app$/

function unavailableHere(): boolean {
  try {
    if (window.self !== window.top) return true
  } catch {
    return true
  }
  const host = window.location.hostname.toLowerCase()
  return CANONICAL_PREVIEW_HOST.test(host) || PREVIEW_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))
}

function failureReason(permission: string | null): string {
  try {
    return failureReasonFor(permission)
  } catch {
    return "Couldn't turn notifications on. Please try again."
  }
}

function failureReasonFor(permission: string | null): string {
  if (permission === 'denied') {
    return 'Notifications are blocked for this app. Allow them in your browser or phone settings, then tap Turn on again.'
  }
  const ios =
    /iP(hone|ad|od)/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  const standalone =
    window.matchMedia?.('(display-mode: standalone)')?.matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true
  if (ios && !standalone) {
    return 'On iPhone, open this app from your Home Screen icon, then tap Turn on.'
  }
  return "Couldn't turn notifications on. Please try again."
}

function readDismissed(): boolean {
  try {
    return sessionStorage.getItem(DISMISS_KEY) === '1'
  } catch {
    return false
  }
}

export function PushHealthBanner() {
  const [needsResubscribe, setNeedsResubscribe] = useState(false)
  const [busy, setBusy] = useState(false)
  const [dismissed, setDismissed] = useState<boolean>(readDismissed)
  const [failure, setFailure] = useState<string | null>(null)

  const checkHealth = useCallback(async () => {
    try {
      if (unavailableHere() || !isAuthenticated()) {
        setNeedsResubscribe(false)
        return
      }
      // If this browser can't do Web Push at all, a "re-enable" prompt is
      // pointless — stay hidden.
      const push = overskill?.push
      if (push && typeof push.isSupported === 'function' && !push.isSupported()) {
        setNeedsResubscribe(false)
        return
      }
      const token = getAuthToken()
      if (!token) {
        setNeedsResubscribe(false)
        return
      }
      const res = await fetch('/api/push/status', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) {
        setNeedsResubscribe(false)
        return
      }
      const data = await res.json().catch(() => null)
      const needs = !!(data && data.health && data.health.needs_resubscribe)
      setNeedsResubscribe(needs)
      // Healthy again → drop the per-session dismissal so a FUTURE breakage
      // shows the banner rather than staying suppressed.
      if (!needs) {
        try {
          sessionStorage.removeItem(DISMISS_KEY)
        } catch {
          /* ignore */
        }
        setDismissed(false)
      }
    } catch {
      // Push is non-essential — never surface an error to the user.
      setNeedsResubscribe(false)
    }
  }, [])

  useEffect(() => {
    checkHealth()
    // Re-check when the tab regains focus — catches a re-subscribe that
    // happened elsewhere (e.g. the settings page) so the banner clears.
    const onFocus = () => checkHealth()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [checkHealth])

  const handleReenable = useCallback(async () => {
    setBusy(true)
    setFailure(null)
    let permission: string | null = null
    try {
      const ok = await overskill.push.subscribe({
        onPermissionDenied: () => {
          // Called for ANY non-granted answer, including a dismissed prompt
          // (`default`, retryable) — record the real state so only a truly
          // blocked permission is told to go to settings.
          try {
            permission = Notification.permission
          } catch {
            /* ignore */
          }
        },
      })
      if (!ok) {
        try {
          permission = permission ?? Notification.permission
        } catch {
          /* ignore */
        }
        setFailure(failureReason(permission))
      } else {
        try {
          sessionStorage.removeItem(DISMISS_KEY)
        } catch {
          /* ignore */
        }
        setDismissed(false)
        await checkHealth()
      }
    } catch {
      setFailure(failureReason(permission))
    } finally {
      setBusy(false)
    }
  }, [checkHealth])

  const handleDismiss = useCallback(() => {
    try {
      sessionStorage.setItem(DISMISS_KEY, '1')
    } catch {
      /* ignore */
    }
    setDismissed(true)
  }, [])

  if (!needsResubscribe || dismissed) return null

  return (
    <div
      role="alert"
      data-overskill-push-recovery="react"
      className="fixed top-0 inset-x-0 z-[100] border-b border-amber-600/40 bg-amber-500 text-amber-950 shadow-md dark:bg-amber-950 dark:text-amber-50"
    >
      <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-2.5">
        <AlertTriangle className="h-5 w-5 shrink-0" aria-hidden="true" />
        <p className="flex-1 text-sm font-medium">
          {failure ?? 'Notifications stopped working on this device — tap to re-enable.'}
        </p>
        <button
          type="button"
          onClick={handleReenable}
          disabled={busy}
          className="shrink-0 rounded-md bg-amber-950 px-3 py-1.5 text-sm font-semibold text-amber-50 transition hover:bg-amber-900 disabled:opacity-60 dark:bg-amber-50 dark:text-amber-950 dark:hover:bg-amber-100"
        >
          {busy ? 'Enabling…' : 'Turn on'}
        </button>
        <button
          type="button"
          onClick={handleDismiss}
          aria-label="Dismiss"
          className="shrink-0 rounded-md p-1 text-amber-950/70 transition hover:text-amber-950 dark:text-amber-50/70 dark:hover:text-amber-50"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}

export default PushHealthBanner
