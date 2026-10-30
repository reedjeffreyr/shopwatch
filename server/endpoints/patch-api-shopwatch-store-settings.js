const auth = await getAuthContext(request, env);
if (!auth?.userId) return new Response(JSON.stringify({ error: 'Sign in required' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
let claims = {};
try { const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim(); const part = token.split('.')[1]; if (part) { const b64 = part.replace(/-/g, '+').replace(/_/g, '/'); claims = JSON.parse(atob(b64 + '==='.slice((b64.length + 3) % 4))); } } catch (_) {}
const email = String(claims.email || auth.email || '').trim().toLowerCase();
if (!email) return new Response(JSON.stringify({ error: 'A verified account email is required' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
const systemEnt = entities(env, { system: true, reason: 'verify verified owner email before updating preferences' });
const stores = await systemEnt.shop_store.list({ orderBy: '-created_at', limit: 1000 });
const store = stores.find((row) => String(row.id) === String(payload.store_id) && String(row.owner_email || '').toLowerCase() === email && (String(row.owner_user_id || '') === String(auth.userId) || row.is_client_managed === true));
if (!store) return new Response(JSON.stringify({ error: 'Store not found for this account' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
const updates = {};
if (typeof payload.alert_email === 'string') { const value = payload.alert_email.trim().toLowerCase(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return new Response(JSON.stringify({ error: 'Enter a valid alert email' }), { status: 400, headers: { 'Content-Type': 'application/json' } }); updates.alert_email = value; }
if (typeof payload.ignored_terms === 'string') updates.ignored_terms = payload.ignored_terms.slice(0, 1000);
const writer = entities(env, { system: true, reason: 'update verified owner preferences on the admin-managed store row', teamId: env.TEAM_ID });
return { success: true, store: await writer.shop_store.update(String(store.id), updates) };