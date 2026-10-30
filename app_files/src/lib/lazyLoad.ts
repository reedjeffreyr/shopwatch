// Shared lazy-load fallback logic for <LazyImage /> and <OptimizedImage />.
//
// WHY THIS EXISTS (platform-wide render bug, confirmed on prod apps):
// Both image components defer their real fetch until the element is "visible"
// — LazyImage gates the <img> mount behind an IntersectionObserver, and
// OptimizedImage relies on the native loading="lazy" attribute. Both of those
// mechanisms NEVER fire for an element that has zero intrinsic dimensions
// (w:0/h:0) or that sits inside an initially-hidden/collapsed container
// (display:none tab/accordion/carousel slide, off-screen). Such an element can
// never satisfy an IntersectionObserver threshold and the browser's lazy-load
// heuristic will never schedule its fetch, so the image is stuck forever with
// `complete === false` even though its URL is a valid 200. (The /cdn-cgi/ +
// R2 delivery layer is healthy — the bug is purely the load *trigger*.)
//
// FIX: after the normal lazy mechanism is set up, arm a short fallback timer.
// When it fires, if the element is STILL "lazy-stuck" (zero-area / hidden), we
// force the load. A real-dimension element that is merely below the fold is
// NOT stuck (it will intersect on scroll), so the lazy bandwidth win is
// preserved for the common case.

/** Default delay (ms) before force-loading an image the lazy mechanism never triggered. */
export const LAZY_LOAD_FALLBACK_MS = 2500;

/**
 * True when `el` occupies no viewport-reachable layout box and therefore can
 * NEVER trigger an IntersectionObserver threshold or a native lazy fetch:
 *
 *   - `getClientRects()` is empty  → display:none / collapsed / detached
 *   - bounding rect has zero width or height → zero intrinsic dimensions
 *
 * A real-dimension element that is simply scrolled off-screen (below the fold)
 * returns `false`: it has a non-zero box and will intersect on scroll, so it
 * should stay lazy. This is the distinction that lets the fallback fix the
 * stuck case without force-loading every below-the-fold image (which would
 * defeat lazy loading).
 */
export function isElementLazyStuck(el: Element | null | undefined): boolean {
  if (!el || typeof el.getBoundingClientRect !== 'function') return false;

  // Empty client-rect list == not rendered (display:none / detached).
  if (typeof el.getClientRects === 'function' && el.getClientRects().length === 0) {
    return true;
  }

  const rect = el.getBoundingClientRect();
  return rect.width === 0 || rect.height === 0;
}

/**
 * Arm a one-shot fallback timer. After `delay` ms, re-evaluate the element via
 * `getEl()`: if it is still lazy-stuck, invoke `onForceLoad()` so the image
 * loads regardless of layout. Returns a cleanup function that cancels a
 * still-pending timer.
 *
 * The stuck check runs at FIRE time (not schedule time) so an element that
 * gained real dimensions in the interim — e.g. its container became visible
 * and the IntersectionObserver already loaded it — is left alone.
 */
export function scheduleLazyLoadFallback(
  getEl: () => Element | null | undefined,
  onForceLoad: () => void,
  delay: number = LAZY_LOAD_FALLBACK_MS
): () => void {
  const timer = setTimeout(() => {
    if (isElementLazyStuck(getEl())) {
      onForceLoad();
    }
  }, delay);

  return () => clearTimeout(timer);
}
