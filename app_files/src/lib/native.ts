// Native (wrapped mobile app) bridge access.
//
// Most apps run only in a browser. But an app can ALSO be published as a branded
// native iOS app, in which case it runs inside a thin native shell that injects a
// small bridge onto `window` before this app's bundle executes.
//
// WHY THIS FILE EXISTS — the social-login break:
//
// Google and Apple refuse to complete sign-in inside an embedded webview. In the
// wrapper, the provider page escapes to Safari, the user signs in THERE, and the
// token lands in Safari instead of the app — so sign-in silently never completes.
//
// The shell's fix is to run the whole OAuth bounce through the SYSTEM browser and
// return to the app via a per-app custom URL scheme. The shell can auto-intercept
// ANCHOR clicks, but it cannot intercept a programmatic
// `window.location.href = …` navigation. Our login page navigates
// programmatically, so the app has to hand the bounce URL to the bridge itself.
// That handoff is `signInWithNativeBrowser` below.
//
// THREE RULES, each of which caused a real bug when broken:
//
//  1. Read `window.OverSkillNativeAuth` LAZILY, at call time. The shell only
//     assigns it when it detects a native container, and it does so from a module
//     script. Capturing it at import time yields `undefined`.
//  2. FEATURE-DETECT it. This same file ships to plain web and to the editor's
//     preview iframe, where nothing native exists and every function here must be
//     an inert no-op.
//  3. Pass the bounce URL through UNMODIFIED. The bridge rewrites the
//     `return_to` parameter to the app's custom scheme itself; pre-rewriting it
//     here would double-rewrite and break the round trip.

type NativeAuthBridge = {
  // Opens `bounceUrl` in the system browser after rewriting return_to to the
  // app's custom URL scheme. Resolves true when it opened.
  signIn?: (bounceUrl: string) => Promise<boolean> | boolean
  // Handles a returned custom-scheme deep link. The shell wires this itself; the
  // app never needs to call it.
  handleAuthCallbackUrl?: (url: string) => boolean
  isNative?: () => boolean
}

declare global {
  interface Window {
    OverSkillNativeAuth?: NativeAuthBridge
    OverSkillNativeConfig?: Record<string, unknown>
    Capacitor?: unknown
  }
}

/**
 * True when this app is running inside the native shell rather than a browser.
 *
 * Checks for the bridge first and the native container second, so it stays
 * correct if the shell ever changes how it announces itself.
 */
export function isNativeApp(): boolean {
  if (typeof window === 'undefined') return false
  if (typeof window.OverSkillNativeAuth !== 'undefined') return true
  return typeof window.Capacitor !== 'undefined'
}

/**
 * The bridge, or null on plain web. Always resolved fresh — never cached.
 */
export function nativeAuth(): NativeAuthBridge | null {
  if (typeof window === 'undefined') return null
  const bridge = window.OverSkillNativeAuth
  if (!bridge || typeof bridge.signIn !== 'function') return null
  return bridge
}

/**
 * Hand an OAuth bounce URL to the native shell so sign-in runs in the system
 * browser (where Google and Apple actually work) and returns to the app.
 *
 * Returns TRUE when the native bridge took over — the caller must then NOT
 * navigate. Returns FALSE on plain web, in the preview iframe, or if the bridge
 * throws, so the caller falls back to its normal browser redirect.
 *
 * `bounceUrl` is passed through untouched: the bridge owns the return_to rewrite.
 */
export function signInWithNativeBrowser(bounceUrl: string): boolean {
  if (!bounceUrl) return false

  const bridge = nativeAuth()
  if (!bridge || typeof bridge.signIn !== 'function') return false

  try {
    // signIn is async (it awaits the system-browser plugin), but we must decide
    // synchronously whether to suppress our own navigation — so we deliberately
    // do not await. A rejection is caught below and reported, not thrown: the
    // user is already in the system browser by then, and re-navigating the
    // webview on top of it would strand them.
    const opened = bridge.signIn(bounceUrl)
    if (opened && typeof (opened as Promise<boolean>).catch === 'function') {
      ;(opened as Promise<boolean>).catch((error: unknown) => {
        console.error('[native] system-browser sign-in failed:', error)
      })
    }
    return true
  } catch (error) {
    // A broken bridge must never block sign-in — fall back to the web redirect.
    console.error('[native] could not hand sign-in to the native shell:', error)
    return false
  }
}
