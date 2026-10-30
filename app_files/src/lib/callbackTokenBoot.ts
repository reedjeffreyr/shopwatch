// FIRST import of the app (see main.tsx). Adopts the sign-in token the platform
// lands on /callback#access_token=… BEFORE anything imports overskill-sdk.
//
// Why the order is load-bearing (SW-102): the SDK constructs its eager
// `overskill` singleton at import and reads the stored token exactly once, and
// an SDK older than 0.5.10 adopts a hash token from ANY path with no checks.
// Adopting here means (1) the singleton — which the SDK's useEntitlement() and
// useAuth() hooks read — boots signed in instead of staying anonymous until a
// reload, and (2) an older SDK finds nothing in the URL to adopt insecurely.
//
// The rule itself (fragment only, /callback only, aud must name THIS app, exp
// in the future) lives in ./callbackToken. This module only runs it.
import { adoptCallbackToken } from './callbackToken'

if (adoptCallbackToken(import.meta.env.VITE_APP_ID)) {
  console.log('[lib/callbackTokenBoot] ✅ Callback token stored, URL cleaned. callback.tsx will handle redirect.')
}
