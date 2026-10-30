// Shared origin gate for Cloudflare Image Resizing (/cdn-cgi/image/).
//
// WHY THIS EXISTS
// ---------------
// `buildCdnCgiUrl()` in <OptimizedImage /> and <LazyImage /> emits a
// ROOT-RELATIVE path:
//
//     /cdn-cgi/image/w=1200,q=85,f=auto/https://assets.overskill.com/...
//
// Root-relative means it resolves against whatever origin the app is
// CURRENTLY served from — not against the zone we designed it for.
// Cloudflare Image Resizing only exists on the `*.overskill.app` zone, so
// the same emitted URL behaves completely differently by host (measured
// 2026-08-18 against a live published app):
//
//   https://<id>.overskill.app/cdn-cgi/image/.../<r2url>          -> 200 image/png
//   https://preview-<id>.overskill.app/cdn-cgi/image/.../<r2url>  -> 200 image/png
//   https://preview-<id>-5173-<sandbox>.overskillprojects.dev/... -> 404 text/html
//
// The E2B preview sandbox that backs the in-editor preview (and therefore
// the Visual Editor) is served from `overskillprojects.dev`, which is NOT an
// image-resizing zone. Result: EVERY image in the editor preview 404s while
// the published site is perfectly fine. To a user that reads as "my photos
// are missing" and — because a picked image renders once and then blanks on
// the next render — as "the Visual Editor won't save my image".
//
// THE RULE
// --------
// Emit /cdn-cgi/image/ only on origins that can actually serve it. Anywhere
// else, use the original R2 URL directly: it is a plain public object and
// always 200s (verified: direct CDN fetch returns image/png). We lose
// resizing/WebP in the sandbox, which is a preview-only bandwidth cost, and
// we gain the image actually appearing.
//
// This is deliberately a DENY-list, not an allow-list: the only origins we
// have positively measured as unable to serve /cdn-cgi/image/ are the
// sandbox hosts. Custom domains are left on the existing code path so this
// change cannot regress a customer domain we have not measured.

/** Hosts known NOT to serve Cloudflare Image Resizing. */
const NON_RESIZING_HOST_SUFFIXES = [
  '.overskillprojects.dev', // E2B preview sandbox (editor + Visual Editor)
  '.overskillprojects.com', // retired Sprite preview hosts
  '.e2b.app',               // raw E2B host, pre-proxy-rewrite
  '.e2b.dev',
];

/** Local dev hosts — no Cloudflare in front of them at all. */
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '0.0.0.0', '[::1]'];

/**
 * Can this origin serve /cdn-cgi/image/ transformations?
 *
 * @param hostname - typically `window.location.hostname`
 * @returns false for sandbox/local hosts, true otherwise (unknown hosts keep
 *          the pre-existing optimized behavior)
 */
export const supportsCloudflareImageResizing = (
  hostname: string | null | undefined
): boolean => {
  if (!hostname) return true; // SSR/unknown: preserve legacy behavior

  const host = hostname.toLowerCase();

  if (LOCAL_HOSTS.includes(host)) return false;
  if (host.endsWith('.local')) return false;

  return !NON_RESIZING_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
};

/**
 * Read the current hostname defensively (SSR, workers, tests).
 */
export const currentHostname = (): string | null => {
  if (typeof window === 'undefined' || !window.location) return null;
  return window.location.hostname || null;
};

/**
 * Should image optimization be used right now?
 *
 * @param enabledByConfig - the app's ENABLE_IMAGE_OPTIMIZATION setting
 * @param hasError        - a previous load already failed
 * @param hostname        - defaults to the live hostname
 */
export const shouldOptimizeImages = (
  enabledByConfig: boolean,
  hasError: boolean,
  hostname: string | null | undefined = currentHostname()
): boolean => {
  if (!enabledByConfig) return false;
  if (hasError) return false;
  return supportsCloudflareImageResizing(hostname);
};

export default supportsCloudflareImageResizing;
