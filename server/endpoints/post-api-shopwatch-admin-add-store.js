const auth = await getAuthContext(request, env);
if (!auth?.userId) return new Response(JSON.stringify({ error: 'Sign in required' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
let claims = {};
try { const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim(); const part = token.split('.')[1]; if (part) { const b64 = part.replace(/-/g, '+').replace(/_/g, '/'); claims = JSON.parse(atob(b64 + '==='.slice((b64.length + 3) % 4))); } } catch (_) {}
const roles = claims && claims.app_context && claims.app_context.roles || auth.roles || [];
const permissions = claims && claims.app_context && claims.app_context.permissions || auth.permissions || {};
if (!roles.includes('admin') && !permissions.all_features && !permissions.manage_users) return new Response(JSON.stringify({ error: 'Admin access required' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
const email = String(payload.owner_email || '').trim().toLowerCase();
let raw = String(payload.store_url || '').trim();
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !raw) return new Response(JSON.stringify({ error: 'Enter a valid store URL and owner email' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw;
let url;
try { url = new URL(raw); } catch (_) { return new Response(JSON.stringify({ error: 'Enter a valid store URL' }), { status: 400, headers: { 'Content-Type': 'application/json' } }); }
const host = url.hostname.toLowerCase();
const blocked = host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host === '169.254.169.254';
if (url.protocol !== 'https:' || url.username || url.password || blocked) return new Response(JSON.stringify({ error: 'Use a public HTTPS Shopify storefront URL' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
const ent = entities(env, { system: true, reason: 'admin-created client store with its client email as the private access boundary', teamId: env.TEAM_ID });
const store = await ent.shop_store.create({ owner_email: email, owner_user_id: String(auth.userId), store_url: url.origin, store_name: host, status: 'checking', last_check_status: 'checking', alert_email: email, weekly_summary: false, is_client_managed: true, created_by_email: String(claims.email || auth.email || '') });
return { success: true, store };