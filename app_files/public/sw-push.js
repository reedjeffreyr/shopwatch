/* OverSkill Web Push Service Worker.
 *
 * Companion to the SDK's `overskill.push.subscribe()`. Receives `push`
 * events from the platform's push relay and shows a system notification.
 *
 * HOW THIS IS LOADED (issue #3705 / #4770 / #4200 — read before changing it):
 *
 * vite.config.ts pulls this file INTO the Workbox service worker with
 * `workbox.importScripts: ["/sw-push.js"]`, so the app has exactly ONE
 * service worker at scope "/" and that worker handles both precaching and
 * push. This file is still served at /sw-push.js so it can also be
 * registered standalone by an app that has no PWA precache worker.
 *
 * ⚠️ An earlier version of this comment claimed the opposite:
 *
 *     "If your generated app needs both PWA precaching AND push, both SWs
 *      coexist fine — each owns its own scope."
 *
 * That was wrong, and it was the origin of the bug. A service-worker
 * registration is keyed by SCOPE, and BOTH scripts asked for "/" — the
 * Workbox worker at /sw.js and this one at /sw-push.js. Registering a
 * different script URL at an existing scope REPLACES that registration, so
 * they clobbered each other on every page load. When the Workbox worker won
 * (which it reliably does on an installed Android home-screen PWA), the push
 * event was delivered to a worker with NO `push` listener: Android rendered
 * its own generic "Tap to copy the URL for this app" notification instead of
 * the app's branded one, while the relay reported the send as delivered.
 *
 * So: never register a second service-worker script at scope "/". If you need
 * to add behavior to the worker, add it here (or to another file this one
 * imports).
 */

/* ---- Push capability ping -------------------------------------------------
 * A page cannot introspect a service worker's listeners, so a worker that
 * handles push says so out loud. overskill-runtime-sdk (platform.js) uses this
 * to tell "the worker that owns / can receive push" apart from "the worker
 * that owns / is a bare precache worker", and reuses the existing registration
 * instead of replacing it. Kept in lockstep with
 * Deployment::WorkerApiTemplate::PUSH_SW_MARKER, which injects an equivalent
 * responder into apps deployed before this file existed.
 */
self.__overskillPushSw = 1;

self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || data.type !== 'OVERSKILL_PUSH_SW_PING') return;
  const reply = { type: 'OVERSKILL_PUSH_SW_PONG', pushSw: self.__overskillPushSw };
  try {
    if (event.ports && event.ports[0]) {
      event.ports[0].postMessage(reply);
      return;
    }
  } catch (err) {
    // Fall through to the client channel below.
  }
  try {
    if (event.source && typeof event.source.postMessage === 'function') {
      event.source.postMessage(reply);
    }
  } catch (err) {
    // A page we cannot answer simply times out and treats us as
    // push-incapable — the safe direction (it registers its own worker).
  }
});

// install/activate stay declared even though the Workbox worker that imports
// this file already ships skipWaiting + clientsClaim: repeating them is
// idempotent, and it keeps this file correct when it is registered standalone.
self.addEventListener('install', () => {
  // Activate immediately on first install so the user gets push reception
  // without needing to refresh after subscribe.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch (err) {
    payload = { title: 'Notification', body: event.data.text() };
  }

  const title = payload.title || 'Notification';
  const options = {
    body: payload.body,
    icon: payload.icon || '/icon-192.png',
    badge: payload.badge || payload.icon || '/icon-192.png',
    data: {
      url: payload.url || '/',
      ...(payload.data || {})
    }
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/';

  // Focus an existing window with the same URL if possible; otherwise
  // open a new one. Standard "click to deep-link" UX.
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.endsWith(targetUrl) && 'focus' in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});
