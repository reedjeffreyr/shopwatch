// The ONE rule for adopting a session token out of the page URL (SW-102).
//
// Mirrors `callback-token.ts` in overskill-sdk. The template keeps its own copy
// because `src/lib/callbackTokenBoot.ts` adopts the token at module-import
// time, before overskill-sdk is even imported, and the template's SDK pin may
// lag the version that ships the export. Keep the two in lockstep.
//
// The platform hands a freshly minted app JWT to this app by redirecting to
// `https://<app>/callback#access_token=<jwt>` — the OAuth bounce, the code
// exchange, the sandbox-customer sign-in and MarketingSecrets SSO all use that
// exact landing. Before this rule the template (and the SDK) read `access_token=`
// out of the fragment on ANY path, and the SDK also read it out of the QUERY
// STRING, without looking at the token. A link like
// `https://this-app/anything?access_token=<attacker jwt>` therefore signed the
// visitor in AS THE ATTACKER (token fixation / login CSRF). So adoption is gated:
//
//   1. Only on `/callback` — the one page the platform ever redirects a token to.
//   2. Only from the FRAGMENT (never sent to a server or a Referer). A query
//      string token is never adopted, only scrubbed from the URL.
//   3. Only when `aud` names THIS app (`overskill-app-<VITE_APP_ID>` or the bare
//      id — the two audiences Rails' OverskillJwtService accepts).
//   4. Only when `exp` is in the future (same 60s skew as the boot gate).
//
// This is a LOCAL claims read; nothing here verifies the signature. The Worker
// and Rails remain the authority on every request. It only stops the client
// from ever STORING a token that could not be a legitimate sign-in to this app.

import { decodeJwtPayload, isSessionTokenViable } from './sessionIntegrity'

export const CALLBACK_PATH = '/callback'

/**
 * Fired on `window` when a token is adopted, carrying `{ token }` in `detail`.
 * Every overskill-sdk AuthClient on the page (0.5.10+) listens and takes the
 * same token into memory — the SDK's eager `overskill` singleton has no appId
 * and can never adopt on its own. Same-page only.
 */
export const CALLBACK_TOKEN_ADOPTED_EVENT = 'overskill:callback-token-adopted'

/** The post-login destination key `login.tsx` writes and `callback.tsx` reads. */
export const POST_LOGIN_REDIRECT_KEY = 'overskill_post_login_redirect'

/**
 * An app-relative path the platform may hand us in the fragment (`return_to=`)
 * to land the user somewhere specific after sign-in — MarketingSecrets SSO uses
 * it for its `return` param. One leading `/` (never two: `//evil.com` is a
 * protocol-relative URL), then unreserved path characters only. Same shape
 * Apps::MsaiSessionsController::RETURN_PATH_FORMAT enforces server-side.
 */
export const RETURN_PATH_FORMAT = /^\/(?!\/)[A-Za-z0-9\-._~/]*$/

export interface CallbackLocation {
  pathname: string
  search: string
  hash: string
}

export type CallbackTokenRejection =
  | 'not_callback_path'
  | 'query_string_token'
  | 'no_app_id'
  | 'ambiguous'
  | 'malformed'
  | 'expired'
  | 'audience_mismatch'

export interface CallbackTokenOutcome {
  /** A token that passed every gate — the only value a caller may store. */
  token: string | null
  rejection?: CallbackTokenRejection
  /** A same-origin path from the fragment's `return_to`, present only when a token was adopted. */
  returnTo: string | null
  /**
   * True when token material appeared in the URL (fragment OR query, ANY path)
   * and appId is known; the caller scrubs the URL, adopted or not, so a refused
   * token never lingers — including for an OLDER overskill-sdk on the same page
   * that would still adopt it from anywhere.
   */
  scrub: boolean
  /**
   * The URL with token material removed. On /callback the whole fragment is
   * dropped; elsewhere only `access_token=` is cut out of query and fragment so
   * a hash-routed page keeps its route.
   */
  cleanUrl: string
}

export function isCallbackPath(pathname: string): boolean {
  const path = pathname.replace(/\/+$/, '') || '/'
  return path === CALLBACK_PATH
}

export function acceptedAudiences(appId: string): string[] {
  return [`overskill-app-${appId}`, appId]
}

export function tokenAudienceMatches(token: string, appId: string): boolean {
  const payload = decodeJwtPayload(token)
  if (!payload) return false
  const aud = payload.aud
  const accepted = acceptedAudiences(appId)
  if (typeof aud === 'string') return accepted.includes(aud)
  if (Array.isArray(aud)) return aud.some((a) => typeof a === 'string' && accepted.includes(a))
  return false
}

export function safeReturnPath(raw: string | null | undefined): string | null {
  if (!raw) return null
  return RETURN_PATH_FORMAT.test(raw) ? raw : null
}

/**
 * Is this raw `key=value` pair an access_token pair? The name is compared
 * DECODED — `%61ccess_token` is what URLSearchParams (and every older SDK on
 * the page) reads as `access_token`, so it must be caught too.
 */
function isTokenPair(pair: string): boolean {
  const rawKey = pair.split('=', 1)[0].replace(/\+/g, ' ')
  let key = rawKey
  try {
    key = decodeURIComponent(rawKey)
  } catch {
    /* malformed escape — compare raw */
  }
  return key === 'access_token'
}

/**
 * The literal an SDK older than 0.5.10 keyed its adoption on
 * (`hash.includes('access_token=')` + `match(/access_token=([^&]+)/)`, any
 * path, no delimiter check). Token MATERIAL is a superset of that predicate
 * plus decoded pair names — never a list of shapes we thought of — or a new app
 * on the pinned SDK is signed in by the very link this rule exists to stop.
 */
const LITERAL_TOKEN = /access_token=[^&]*/g

function hasTokenMaterial(body: string): boolean {
  return /access_token=/.test(body) || body.split('&').some(isTokenPair)
}

/**
 * Cut every access_token pair — exact decoded name, or the literal wherever it
 * sits — out of a `?query`/`#fragment` string without re-encoding the rest. A
 * hash route keeps its own `?query` when other params survive.
 */
function withoutTokenParam(str: string): string {
  if (!str) return ''
  const lead = str[0] === '?' || str[0] === '#' ? str[0] : ''
  const body = str
    .slice(lead.length)
    .split('&')
    .filter((pair) => !isTokenPair(pair))
    .join('&')
    .replace(LITERAL_TOKEN, '')
    .replace(/\?&/g, '?')
    .replace(/&&+/g, '&')
    .replace(/^&+/, '')
    .replace(/[?&]+$/, '')
  return body ? lead + body : ''
}

function hasTokenParam(str: string): boolean {
  if (!str) return false
  const lead = str[0] === '?' || str[0] === '#' ? 1 : 0
  return hasTokenMaterial(str.slice(lead))
}

/** Pure decision. Never touches the DOM or storage. */
export function readCallbackToken(
  location: CallbackLocation,
  appId: string | null | undefined,
  nowMs: number = Date.now()
): CallbackTokenOutcome {
  const cleanSearch = withoutTokenParam(location.search)
  const queryHasToken = hasTokenParam(location.search)

  if (!isCallbackPath(location.pathname)) {
    // Not ours to adopt, and not something to leave for an older SDK either.
    const cleanUrl = location.pathname + cleanSearch + withoutTokenParam(location.hash)
    const present = queryHasToken || hasTokenParam(location.hash)
    return { token: null, returnTo: null, cleanUrl, rejection: 'not_callback_path', scrub: Boolean(appId) && present }
  }

  const cleanUrl = location.pathname + cleanSearch
  const base = { token: null, returnTo: null, cleanUrl }
  const fragment = new URLSearchParams(location.hash.replace(/^#/, ''))
  const tokens = fragment.getAll('access_token').filter((t) => t.length > 0)

  if (tokens.length === 0) {
    if (queryHasToken) return { ...base, rejection: 'query_string_token', scrub: Boolean(appId) }
    // `#/?access_token=…` is not a fragment PAIR (key reads as `/?access_token`),
    // so it is never adopted — but an older SDK would regex-match it. Clear it.
    if (hasTokenParam(location.hash)) return { ...base, rejection: 'malformed', scrub: Boolean(appId) }
    return { ...base, scrub: false }
  }

  // Two candidates is exactly the shape of a crafted return_to
  // (`…/callback#access_token=ATTACKER` + the platform's own append). Refuse both.
  if (tokens.length > 1) return { ...base, rejection: 'ambiguous', scrub: Boolean(appId) }

  if (!appId) return { ...base, rejection: 'no_app_id', scrub: false }

  const token = tokens[0]
  if (!decodeJwtPayload(token)) return { ...base, rejection: 'malformed', scrub: true }
  if (!isSessionTokenViable(token, nowMs)) return { ...base, rejection: 'expired', scrub: true }
  if (!tokenAudienceMatches(token, appId)) return { ...base, rejection: 'audience_mismatch', scrub: true }

  return { ...base, token, returnTo: safeReturnPath(fragment.get('return_to')), scrub: true }
}

/**
 * Apply the rule to the live page: store an accepted token as `overskill_token`,
 * stash its `return_to` for `callback.tsx`, tell any SDK client already on the
 * page, and rewrite the URL in place.
 *
 * MUST run before `overskill-sdk` is imported (see callbackTokenBoot.ts): the
 * SDK constructs its eager `overskill` singleton at import, which reads the
 * stored token exactly once — and an SDK older than 0.5.10 adopts a hash token
 * from ANY path with no checks. Running first means the singleton boots signed
 * in and the old SDK finds nothing left in the URL.
 *
 * `history.replaceState`, NOT `location.hash = ''`: assigning the hash is a
 * same-document navigation that PUSHES a history entry, leaving the token URL
 * one Back-press away. Returns true when a token was adopted.
 */
export function adoptCallbackToken(appId: string | null | undefined, nowMs: number = Date.now()): boolean {
  if (typeof window === 'undefined') return false
  const outcome = readCallbackToken(window.location, appId, nowMs)

  let stored = false
  if (outcome.token) {
    // Two INDEPENDENT guards, not one wrapper: this runs at module import in a
    // cross-site iframe where storage may be denied (SecurityError out of the
    // module body was the white screen), and a denied localStorage must not
    // skip the session flag below, nor the reverse.
    try {
      localStorage.setItem('overskill_token', outcome.token)
      stored = true
    } catch {
      // Third-party storage denied (a framed preview). Leave the fragment in
      // place: the SDK client built right after this, with the same appId,
      // applies the same rule and holds the token in memory.
    }
    try {
      // Tells callback.tsx the token was already taken out of the URL, so it
      // does not conclude "no code and no token" and bounce to the landing page.
      // A hint only: callback.tsx ORs it with the hash and the stored token.
      sessionStorage.setItem('overskill_token_extracted', 'true')
      if (outcome.returnTo) sessionStorage.setItem(POST_LOGIN_REDIRECT_KEY, outcome.returnTo)
    } catch {
      /* session hint not persisted — costs only the dedupe shortcut */
    }
  } else if (outcome.rejection && outcome.rejection !== 'not_callback_path') {
    console.warn(`[lib/callbackToken] Refused a token in the URL (${outcome.rejection})`)
  }

  if (outcome.token) {
    try {
      window.dispatchEvent(new CustomEvent(CALLBACK_TOKEN_ADOPTED_EVENT, { detail: { token: outcome.token } }))
    } catch {
      /* no CustomEvent (non-browser) */
    }
  }

  if (outcome.scrub && (stored || !outcome.token)) {
    try {
      window.history.replaceState({}, '', outcome.cleanUrl)
    } catch {
      /* history unavailable */
    }
  }

  return outcome.token != null
}
