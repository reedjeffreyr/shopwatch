const auth = await getAuthContext(request, env);
if (!auth?.userId) return new Response(JSON.stringify({ error: 'Sign in required' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
let claims = {};
try { const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim(); const part = token.split('.')[1]; if (part) { const b64 = part.replace(/-/g, '+').replace(/_/g, '/'); claims = JSON.parse(atob(b64 + '==='.slice((b64.length + 3) % 4))); } } catch (_) {}
const email = String(claims.email || auth.email || '').trim().toLowerCase();
if (!email) return new Response(JSON.stringify({ error: 'A verified account email is required' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
const readEnt = entities(env, { system: true, reason: 'verify store owner email before creating their help request' });
const stores = await readEnt.shop_store.list({ orderBy: '-created_at', limit: 1000 });
const store = stores.find((row) => String(row.id) === String(payload.store_id) && String(row.owner_email || '').toLowerCase() === email && (String(row.owner_user_id || '') === String(auth.userId) || row.is_client_managed === true));
if (!store) return new Response(JSON.stringify({ error: 'Store not found for this account' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
const writer = entities(env, { system: true, reason: 'save verified owner fix request on the app-admin-owned record', teamId: env.TEAM_ID });
const requestRow = await writer.fix_request.create({ store_id: String(store.id), owner_user_id: String(store.owner_user_id || auth.userId), owner_email: email, store_url: String(store.store_url), issue_summary: String(payload.issue_summary || 'Store owner requested help').slice(0, 2000), status: 'new' });
let emailAccepted = false; let emailError = null;
try { const sent = await sendEmail(env).send({ to: env.SHOPWATCH_ADMIN_EMAIL, subject: 'Shopwatch fix request — ' + String(store.store_name || store.store_url), text: 'A store owner requested help.\n\nStore: ' + store.store_url + '\nOwner: ' + email + '\nRequest: ' + requestRow.issue_summary + '\nRequest ID: ' + requestRow.id }); emailAccepted = Boolean(sent.accepted); }
catch (error) { emailError = String(error && error.message || error); }
return { success: true, request: requestRow, email_accepted: emailAccepted, email_error: emailError };