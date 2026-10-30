# Shopwatch

The "what broke?" monitor for Shopify stores, by Fixed Mark Digital. It watches a store's public storefront every day and emails the owner when something that costs sales stops working.

> **Status: archived.** This is the Overskill export (October 30, 2026), saved here so the idea isn't lost. It is **not deployable as-is**: the server code calls Overskill platform helpers (`entities(...)`, `sendEmail(...)`, Overskill auth) that would need replacing. See "Bringing it back" below.

## What it does

- **Owners add a store** (public HTTPS Shopify URL) and set an alert email plus "ignored terms" for content that changes often.
- **Each check** fetches the storefront, a collection page, a product (via `products.json`), and a **safe temporary cart → checkout** path. It compares the results against a saved **baseline**: page title, text and layout signature (header, main, images), scripts, and load time.
- **A daily scheduled job** checks stores in batches of 50, saves check history and alerts, and emails the owner when a problem shows up.
- **Fix requests**: an owner can ask for help from the dashboard, and the admin (Jeff) gets an email.
- **Admin view**: a cross-store overview, adding stores for clients, and updating fix-request status.
- **Screenshots** are served through unguessable per-image tokens.

## Layout

| Path | What's there |
|---|---|
| `app_files/src/pages/` | `Index` (landing), `ShopDashboard`, `StoreDetail`, `ShopAdmin` |
| `app_files/src/components/shopwatch/` | Store form/list, check results, alert list, status pill |
| `server/endpoints/` | One file per API route (add store, run check, owner data, admin, fix request, settings, screenshot) |
| `server/scheduled/shopwatch-daily-checks.js` | The daily batch checker. Most of the monitoring logic lives here and in `post-api-shopwatch-run-check.js` |
| `server/manifest.json` | Routes, auth requirements, schedule, and environment variable **names** |
| `schema.sql` | Postgres table definitions: `shop_stores`, `store_checks`, `store_alerts`, `fix_requests`, `monitor_states` (no data) |

The rest of `app_files/` (auth, Whop checkout, PWA, `vite-plugin-overskill-*`, `ui/` kit) is Overskill platform boilerplate.

## Bringing it back

Most likely target: **Cloudflare Workers + D1 + Cron Triggers + Resend**, the same stack Plainsight moved to. Free tier, with a daily cron.

1. Swap `entities(env, …).<table>.list/create/update` for D1 queries, and port `schema.sql` to SQLite.
2. Swap `sendEmail(env)` for Resend.
3. Replace Overskill login with something simple (magic-link email, or Cloudflare Access for an admin-only version).
4. Move the daily job to a Cron Trigger.
5. Drop the Whop checkout unless it becomes a paid product.

Check volume and CPU: each store check does several fetches but light parsing. Batches of 50 should fit on Cloudflare's free tier. Watch the 10ms CPU limit on the HTML signature step.

Data from the Overskill account (one test store) is kept in Jeff's local export zip, not in this repo.
