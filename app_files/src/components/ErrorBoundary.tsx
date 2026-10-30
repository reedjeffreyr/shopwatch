/**
 * ErrorBoundary — React error boundary that renders a recovery fallback UI
 * and reports crash details to the OverSkill editor.
 *
 * 🔒 PROTECTED TEMPLATE FILE — DO NOT MODIFY OR RECREATE.
 * Owned by the OverSkill platform. The platform parses the postMessage
 * envelope below; if the shape changes, the editor's error popup will
 * stop working.
 *
 * Audience-aware recovery — the fallback UI DIFFERS by context so we never
 * leak internal details or owner-only actions to a published app's end users
 * (e.g. other players in a multiplayer app):
 * - Editor preview (iframe): the OWNER, debugging in their own editor. Shows
 *   the raw error message + an "Ask OverSkill to Fix" button that posts the
 *   `runtime_error` envelope (message + stack + componentStack — the LLM's
 *   debug gold) to the editor parent (error_popup_controller.js opens the fix
 *   popup). "Try again" is a bare state reset — meaningful here because Vite
 *   HMR swaps in the fixed module before the re-render.
 * - Standalone/published runtime (top window): ANY end user. Shows a clean,
 *   generic "something went wrong" card with a Reload button ONLY — NO raw
 *   error text (privacy — the message can contain code identifiers / secrets)
 *   and NO "Ask OverSkill to Fix" button (that's an owner action; a
 *   non-owner clicking it just dead-ends on an inaccessible editor). Reload is
 *   the only reset that can recover a static bundle. The render error still
 *   reaches OverSkill for debugging via the existing analytics pipe (see
 *   componentDidCatch → __overskill_analytics.trackError) — so masking the UI
 *   does NOT blind us: deterministic errors reproduce for the owner in the
 *   editor preview above, and the analytics event flags routes throwing for
 *   real users, all without exposing anything to the player.
 *
 * NOTE: the owner's fix path lives ENTIRELY in the editor preview now. There
 * is deliberately no standalone deep-link to the editor (it was shown to
 * every end user and leaked). The owner reaches the editor from their
 * dashboard as usual and reproduces the (deterministic) error there.
 *
 * KNOWN LIMITATION: isRunningInEditor() only tells "am I in an iframe", not
 * "am I in the OverSkill editor specifically" — cross-origin, the parent's
 * origin can't be read. So a published app embedded in an <iframe> on a
 * third-party site also gets the editor branch (raw message + a fix button
 * that dead-ends off-editor). The common multiplayer case (app as the top
 * window) is fully covered; closing the embed case needs a parent handshake
 * or a preview-host check and is a deliberate follow-up, not done here.
 *
 * What it catches:
 * - Errors thrown during React render, lifecycle, or in constructors of
 *   child components. (window.onerror does NOT catch these — React swallows
 *   them and unmounts the subtree, leaving the user with a blank screen.)
 *
 * What it does NOT catch (handled by other layers):
 * - Event handler errors → window.onerror → runtime SDK error-reporter
 * - Async/promise errors → unhandledrejection → runtime SDK error-reporter
 * - SSR errors (we're SPA-only)
 * - Errors in the boundary component itself (intentional — fail loud)
 */

import React from 'react'

/**
 * True when the app runs inside the OverSkill editor's preview iframe (the
 * editor parent listens for our `runtime_error` postMessage envelopes).
 * False in the standalone/published runtime, where the app is the top window
 * and there is nothing to receive those messages.
 */
function isRunningInEditor(): boolean {
  try {
    return typeof window !== 'undefined' && !!window.parent && window.parent !== window
  } catch {
    return false
  }
}

/**
 * True when the caught error matches the Vite dev-server "two copies of
 * React" dep-graph mismatch (#3163): after a full file sync (e.g. a theme
 * apply) re-runs Vite's dep optimizer, an HMR patch can import chunks from
 * the NEW dep graph (react-router-dom?v=NEW) into a page still running the
 * OLD one → two React copies → "Invalid hook call" / null hook dispatcher.
 * A fresh full page load always gets one consistent dep graph, so a reload
 * deterministically clears this class.
 */
function isDualReactDepMismatch(error: Error): boolean {
  const text = String(error?.message || '')
  return (
    text.includes('Invalid hook call') ||
    text.includes('more than one copy of React') ||
    /Cannot read properties of null \(reading 'use[A-Z]/.test(text)
  )
}

interface ErrorBoundaryProps {
  children: React.ReactNode
}

interface ErrorBoundaryState {
  hasError: boolean
  error: Error | null
  componentStack: string | null
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false, error: null, componentStack: null }
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    this.setState({ componentStack: errorInfo.componentStack ?? null })

    // Always log so the runtime SDK's console-logger forwards it to the editor.
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary] React render error:', error, errorInfo)

    // Surface published-app render errors to OverSkill via the existing
    // analytics pipe (/__analytics → Cloudflare Analytics Engine). This is how
    // OverSkill still learns about errors we mask from the player's UI — no new
    // server infrastructure. Minimal payload: a truncated message, no stack.
    // The analytics singleton self-disables in the editor/preview iframe, so
    // this only actually sends from real published apps (no duplicate next to
    // the editor postMessage below). Never throws.
    try {
      ;(window as any).__overskill_analytics?.trackError?.(
        'react_render_error',
        error.message || 'React render error'
      )
    } catch {
      // Error reporting must never throw from inside a boundary
    }

    // Post a structured error envelope to the editor (cross-origin safe).
    // error_popup_controller.js listens for `runtime_error` and shows the modal
    // with the "Ask OverSkill to Fix Error" button.
    try {
      if (typeof window !== 'undefined' && window.parent && window.parent !== window) {
        window.parent.postMessage(
          {
            type: 'runtime_error',
            error: {
              message: error.message || 'React render error',
              stack: error.stack,
              componentStack: errorInfo.componentStack, // ← gold for the LLM
              source: 'react_error_boundary',
              timestamp: new Date().toISOString(),
              url: window.location.href
            }
          },
          '*'
        )
      }
    } catch {
      // Never throw from inside an error boundary
    }

    // #3163 stopgap: auto-recover from the dual-React dep-mismatch crash with
    // ONE full reload. The platform also force-reloads the preview after
    // theme applies and auto-recovers off our error postMessages, but both
    // need a live editor connection — this in-app fallback covers the rest
    // (and only ships to apps built from this template version).
    // Editor-iframe only: published static bundles cannot dep-hash mismatch.
    // Loop-guarded via sessionStorage so a genuine user-code hook bug (same
    // error text) can never reload-loop — at most one auto-reload per minute.
    try {
      if (isRunningInEditor() && isDualReactDepMismatch(error)) {
        const guardKey = 'os_dual_react_reload_at'
        const lastReloadAt = Number(window.sessionStorage?.getItem(guardKey) || 0)
        if (!lastReloadAt || Date.now() - lastReloadAt > 60_000) {
          window.sessionStorage?.setItem(guardKey, String(Date.now()))
          // Small delay so the runtime_error envelope + analytics flush first.
          window.setTimeout(() => window.location.reload(), 400)
        }
      }
    } catch {
      // Never throw from inside an error boundary
    }
  }

  handleReset = () => {
    if (isRunningInEditor()) {
      // Editor preview: a bare reset is meaningful — once the AI's fix lands,
      // Vite HMR has already swapped the module, so re-rendering mounts the
      // fixed code without reloading the editor session.
      this.setState({ hasError: false, error: null, componentStack: null })
      return
    }
    // Standalone/published runtime: the bundle is static, so re-rendering the
    // same subtree just re-throws deterministic errors and the button looks
    // dead (issue #1358). A full reload is the only reset that can actually
    // recover (fresh data fetch, fresh state, transient races cleared).
    window.location.reload()
  }

  handleAskAiToFix = () => {
    // Editor-iframe context only (the standalone runtime renders an editor
    // deep-link instead — see render()). Re-post the error with an explicit
    // `ask_ai_to_fix` flag so the editor can open the popup pre-focused on
    // the fix button (or, if the popup is already open, this is a no-op
    // duplicate that the popup dedupes).
    try {
      if (typeof window !== 'undefined' && window.parent && window.parent !== window) {
        window.parent.postMessage(
          {
            type: 'runtime_error',
            error: {
              message: this.state.error?.message || 'React render error',
              stack: this.state.error?.stack,
              componentStack: this.state.componentStack,
              source: 'react_error_boundary',
              ask_ai_to_fix: true,
              timestamp: new Date().toISOString(),
              url: window.location.href
            }
          },
          '*'
        )
      }
    } catch {
      // Silent — error reporting must never throw
    }
  }

  render() {
    if (!this.state.hasError) {
      return this.props.children
    }

    // Audience decides what the fallback shows. Editor iframe = the owner
    // debugging → full detail + fix button. Standalone = any end user → a
    // clean, generic card with no internal detail and no owner-only action.
    const inEditor = isRunningInEditor()

    // Inline styles so the fallback works even if Tailwind/CSS failed to load.
    const shellStyle: React.CSSProperties = {
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '24px',
      background: '#0b0c0f',
      color: '#e4e6ec',
      fontFamily:
        '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'
    }
    const primaryActionStyle: React.CSSProperties = {
      appearance: 'none',
      border: 0,
      cursor: 'pointer',
      padding: '10px 16px',
      borderRadius: 8,
      background: '#45e760',
      color: '#0b0c0f',
      fontWeight: 600,
      fontSize: 14
    }
    const secondaryActionStyle: React.CSSProperties = {
      appearance: 'none',
      cursor: 'pointer',
      padding: '10px 16px',
      borderRadius: 8,
      background: 'transparent',
      color: '#e4e6ec',
      border: '1px solid #2d2f3a',
      fontWeight: 600,
      fontSize: 14
    }

    // ── Standalone / published runtime: shown to ANY end user. Generic and
    // detail-free on purpose (no raw error message, no "Ask OverSkill to Fix").
    // The error still reaches OverSkill via analytics.trackError (above). ──
    if (!inEditor) {
      return (
        <div role="alert" style={shellStyle}>
          <div style={{ maxWidth: 480, width: '100%', textAlign: 'center' }}>
            <h1 style={{ fontSize: 22, fontWeight: 700, margin: '0 0 8px 0' }}>
              Something went wrong
            </h1>
            <p style={{ color: '#9098ad', margin: '0 0 20px 0', lineHeight: 1.5 }}>
              This page ran into an unexpected problem. Reloading usually fixes it. If it
              keeps happening, please try again later.
            </p>
            <button type="button" onClick={this.handleReset} style={primaryActionStyle}>
              Reload page
            </button>
          </div>
        </div>
      )
    }

    // ── Editor preview (iframe): the owner, debugging in their own editor.
    // Full detail + the "Ask OverSkill to Fix" flow (posts the runtime_error
    // envelope to the editor parent). Only the owner ever sees this. ──
    return (
      <div role="alert" style={shellStyle}>
        <div style={{ maxWidth: 560, width: '100%' }}>
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              padding: '4px 10px',
              borderRadius: 999,
              background: 'rgba(239, 68, 68, 0.12)',
              color: '#fca5a5',
              fontSize: 12,
              fontWeight: 600,
              letterSpacing: 0.2,
              marginBottom: 16
            }}
          >
            <span aria-hidden>●</span> Something broke while rendering
          </div>
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: '0 0 8px 0' }}>
            This page hit a render error
          </h1>
          <p style={{ color: '#9098ad', margin: '0 0 16px 0', lineHeight: 1.5 }}>
            The app caught a React rendering error before it could crash the whole tab.
            You can ask OverSkill to fix it, or try again.
          </p>

          {this.state.error?.message && (
            <pre
              style={{
                background: '#1c1d22',
                border: '1px solid #2d2f3a',
                borderRadius: 8,
                padding: 12,
                fontSize: 12,
                lineHeight: 1.5,
                color: '#fca5a5',
                overflow: 'auto',
                margin: '0 0 16px 0',
                maxHeight: 160,
                whiteSpace: 'pre-wrap'
              }}
            >
              {this.state.error.message}
            </pre>
          )}

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" onClick={this.handleAskAiToFix} style={primaryActionStyle}>
              Ask OverSkill to Fix
            </button>
            <button type="button" onClick={this.handleReset} style={secondaryActionStyle}>
              Try again
            </button>
          </div>
        </div>
      </div>
    )
  }
}

export default ErrorBoundary
