// Preview Mode Authentication
// Enables OAuth testing in OverSkill editor iframe
// Only accepts messages from the actual parent on an approved editor origin
//
// CRITICAL FIX #1 (Jan 2026): Must call SDK's setToken() to update internal state.
// Just storing in localStorage is NOT enough - SDK was constructed before token arrived.
//
// CRITICAL FIX #2 (Jan 2026): Do NOT use window.location.href for navigation!
// Chrome's third-party storage partitioning isolates localStorage for cross-origin iframes.
// A full page reload makes the token inaccessible. Instead, dispatch 'preview-auth-ready'
// event and let login.tsx handle navigation via React Router (preserves in-memory state).
//
// See: docs/ultrathink/preview-auth-loop-jan-2026/ROOT_CAUSE_ANALYSIS.md

import { overskill } from './auth'
import { isEditorOrigin } from './editor-origins'

let previewAuthInitialized = false
let previewAuthReady = false
let helloTimers: number[] = []

export function initializePreviewAuth() {
  if (previewAuthInitialized) return

  // Check if we're in an iframe
  if (window.self === window.top) {
    console.log('[Preview Auth] Not in iframe - skipping preview auth')
    return
  }

  console.log('[Preview Auth] Initializing in iframe context...')

  // Listen for auth challenge and token from parent editor
  window.addEventListener('message', (event) => {
    // Origin and window identity are separate checks: a trusted sibling is not our editor.
    if (event.source !== window.parent || !isEditorOrigin(event.origin) ||
        !event.data || typeof event.data !== 'object') return

    // Handle auth challenge from parent
    if (event.data.type === 'PREVIEW_AUTH_CHALLENGE' &&
        typeof event.data.challenge === 'string' && event.data.challenge.length > 0) {
      console.log('[Preview Auth] Received challenge from parent')

      // Respond to challenge to request token
      window.parent.postMessage({
        type: 'PREVIEW_AUTH_REQUEST',
        challenge: event.data.challenge
      }, event.origin)

      console.log('[Preview Auth] Sent auth request to parent')
    }

    // Handle preview token from parent
    if (event.data.type === 'PREVIEW_AUTH_TOKEN' && typeof event.data.token === 'string') {
      console.log('[Preview Auth] ✅ Received preview token from editor')
      previewAuthReady = true
      helloTimers.forEach(timer => window.clearTimeout(timer))
      helloTimers = []

      // CRITICAL: Use SDK's setToken() method to update BOTH localStorage AND internal SDK state
      // The SDK was constructed before this token arrived, so just setting localStorage
      // won't update the SDK's internal this.token or the HTTP client's auth header.
      // This was the root cause of the preview auth loop bug (Jan 2026).
      overskill.auth.setToken(event.data.token)
      console.log('[Preview Auth] ✅ Token set via SDK (localStorage + internal state + HTTP client)')

      // Notify app that auth is ready
      // IMPORTANT: Do NOT do window.location.href redirect here!
      // Due to Chrome's third-party storage partitioning, a full page reload
      // in a cross-origin iframe causes localStorage to become inaccessible.
      // Instead, we dispatch the event and let login.tsx handle navigation
      // via React Router, which preserves in-memory state.
      // See: docs/ultrathink/preview-auth-loop-jan-2026/ROOT_CAUSE_ANALYSIS.md
      window.dispatchEvent(new CustomEvent('preview-auth-ready', {
        detail: { token: event.data.token }
      }))

      console.log('[Preview Auth] ✅ Event dispatched - login.tsx will handle navigation via React Router')
    }
  })

  previewAuthInitialized = true
  console.log('[Preview Auth] ✓ Initialized - waiting for parent challenge...')

  // Apr 2026 (Bug #4 / Fix B from Todd's QA): proactively announce ourselves
  // to the parent editor. Fixes the race where the iframe boots BEFORE the
  // parent's preview_auth_controller (Stimulus) has attached its `load`
  // listener — in that scenario the parent never sends a PREVIEW_AUTH_CHALLENGE,
  // login.tsx hits its 5s timeout, and the creator sees "Open in new tab"
  // for their own app. The parent now responds to PREVIEW_AUTH_HELLO by
  // sending a fresh challenge, kicking off the standard token-delivery flow.
  //
  // We post to all valid parent origins; the parent silently ignores
  // messages from origins it doesn't recognize. Sent both immediately and
  // again at 1s/3s in case the parent attaches mid-handshake.
  const announceToParent = () => {
    if (previewAuthReady) return
    if (!window.parent || window.parent === window) return
    try {
      // postMessage to '*' is safe here because the message contains no
      // sensitive data — it's just a "hello, send me a challenge" signal.
      // The challenge itself is delivered with a specific targetOrigin.
      window.parent.postMessage({type: 'PREVIEW_AUTH_HELLO'}, '*')
      console.log('[Preview Auth] Sent PREVIEW_AUTH_HELLO to parent')
    } catch (e) {
      console.warn('[Preview Auth] PREVIEW_AUTH_HELLO postMessage failed:', e)
    }
  }
  announceToParent()
  helloTimers = [
    window.setTimeout(announceToParent, 1000),
    window.setTimeout(announceToParent, 3000)
  ]
}

// Auto-initialize when module loads
if (typeof window !== 'undefined') {
  // Initialize after DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializePreviewAuth)
  } else {
    // DOM already loaded
    initializePreviewAuth()
  }
}
