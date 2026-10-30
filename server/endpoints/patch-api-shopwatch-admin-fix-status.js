const auth = await getAuthContext(request, env);
if (!auth?.userId) return new Response(JSON.stringify({ error: 'Sign in required' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
let claims = {};
try { const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim(); const part = token.split('.')[1]; if (part) { const b64 = part.replace(/-/g, '+').replace(/_/g, '/'); claims = JSON.parse(atob(b64 + '==='.slice((b64.length + 3) % 4))); } } catch (_) {}
const roles = claims && claims.app_context && claims.app_context.roles || auth.roles || [];
const permissions = claims && claims.app_context && claims.app_context.permissions || auth.permissions || {};
if (!roles.includes('admin') && !permissions.all_features && !permissions.manage_users) return new Response(JSON.stringify({ error: 'Admin access required' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
const allowed = ['new', 'in_progress', 'done'];
if (!allowed.includes(payload.status)) return new Response(JSON.stringify({ error: 'Choose new, in progress, or done' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
const systemEnt = entities(env, { system: true, reason: 'find admin-managed fix request for status change' });
const requests = await systemEnt.fix_request.list({ orderBy: '-created_at', limit: 1000 });
const row = requests.find((item) => String(item.id) === String(payload.request_id));
if (!row) return new Response(JSON.stringify({ error: 'Fix request not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
const writer = entities(env, { system: true, reason: 'admin updates fix request status', teamId: env.TEAM_ID });
return { success: true, request: await writer.fix_request.update(String(row.id), { status: payload.status }) };