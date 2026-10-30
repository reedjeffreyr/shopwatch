const auth = await getAuthContext(request, env);
if (!auth?.userId) return new Response(JSON.stringify({ error: 'Sign in required' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
let claims = {};
try { const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim(); const part = token.split('.')[1]; if (part) { const b64 = part.replace(/-/g, '+').replace(/_/g, '/'); claims = JSON.parse(atob(b64 + '==='.slice((b64.length + 3) % 4))); } } catch (_) {}
const roles = claims && claims.app_context && claims.app_context.roles || auth.roles || [];
const permissions = claims && claims.app_context && claims.app_context.permissions || auth.permissions || {};
if (!roles.includes('admin') && !permissions.all_features && !permissions.manage_users) return new Response(JSON.stringify({ error: 'Admin access required' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
const ent = entities(env, { system: true, reason: 'admin reads cross-store Shopwatch overview' });
const [stores, checks, alerts, fix_requests] = await Promise.all([ent.shop_store.list({ orderBy: '-created_at', limit: 1000 }), ent.store_check.list({ orderBy: '-checked_at', limit: 1000 }), ent.store_alert.list({ orderBy: '-created_at', limit: 1000 }), ent.fix_request.list({ orderBy: '-created_at', limit: 1000 })]);
const order = { broken: 0, needs_attention: 1, checking: 2, healthy: 3 };
stores.sort((a, b) => (order[a.status] === undefined ? 4 : order[a.status]) - (order[b.status] === undefined ? 4 : order[b.status]));
return { stores, checks, alerts, fix_requests };