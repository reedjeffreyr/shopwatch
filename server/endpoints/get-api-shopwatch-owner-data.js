const auth = await getAuthContext(request, env);
if (!auth?.userId) return new Response(JSON.stringify({ error: 'Sign in required' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
let claims = {};
try { const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim(); const part = token.split('.')[1]; if (part) { const b64 = part.replace(/-/g, '+').replace(/_/g, '/'); claims = JSON.parse(atob(b64 + '==='.slice((b64.length + 3) % 4))); } } catch (_) {}
const email = String(claims.email || auth.email || '').trim().toLowerCase();
if (!email) return new Response(JSON.stringify({ error: 'A verified account email is required' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
const ent = entities(env, { system: true, reason: 'return only shop rows linked to this signed-in owner id and verified email' });
const allStores = await ent.shop_store.list({ orderBy: '-created_at', limit: 1000 });
const stores = allStores.filter((row) => String(row.owner_email || '').toLowerCase() === email && (String(row.owner_user_id || '') === String(auth.userId) || row.is_client_managed === true));
const ids = new Set(stores.map((row) => String(row.id)));
const [checks, alerts, requests] = await Promise.all([ent.store_check.list({ orderBy: '-checked_at', limit: 1000 }), ent.store_alert.list({ orderBy: '-created_at', limit: 1000 }), ent.fix_request.list({ orderBy: '-created_at', limit: 1000 })]);
return { stores, checks: checks.filter((row) => ids.has(String(row.store_id))).slice(0, 200), alerts: alerts.filter((row) => ids.has(String(row.store_id))).slice(0, 200), fix_requests: requests.filter((row) => ids.has(String(row.store_id))).slice(0, 100) };