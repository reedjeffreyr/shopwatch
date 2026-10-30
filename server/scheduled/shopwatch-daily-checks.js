const admin = entities(env, { system: true, reason: 'run scheduled Shopwatch checks across monitored storefronts', teamId: env.TEAM_ID });
const stores = await admin.shop_store.list({ orderBy: 'created_at', limit: 1000 });
if (!stores.length) return { success: true, checked: 0, message: 'No monitored stores.' };
const states = await admin.monitor_state.list({ limit: 1 });
const state = states[0] || null;
const start = Math.max(0, Number(state && state.scan_offset || 0)) % stores.length;
const batchSize = Math.min(50, stores.length);
const batch = Array.from({ length: batchSize }, (_, i) => stores[(start + i) % stores.length]);
const now = new Date().toISOString();
const day = now.slice(0, 10);
const headers = { 'User-Agent': 'ShopwatchMonitor/1.0', Accept: 'text/html,application/json;q=0.9,*/*;q=0.8' };
async function get(url, extra) {
  try {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(8000), headers: Object.assign({}, headers, extra || {}) });
    return { status: response.status, ok: response.ok, body: await response.text(), setCookie: response.headers.get('set-cookie') || '', location: response.headers.get('location') || '' };
  } catch (_) { return { status: 0, ok: false, body: '', setCookie: '', location: '' }; }
}
function privateHost(host) {
  host = String(host || '').toLowerCase();
  return host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host === '169.254.169.254';
}
function decodeTitle(html, fallback) {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html || '');
  return match && match[1] ? match[1].replace(/<[^>]+>/g, '').trim().slice(0, 160) || fallback : fallback;
}
function readableText(html, ignored) {
  let text = String(html || '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ').replace(/<!--([\s\S]*?)-->/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/gi, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  for (const term of String(ignored || '').split(/[\n,]/).map((x) => x.trim().toLowerCase()).filter(Boolean)) text = text.split(term).join(' ');
  return text.replace(/\s+/g, ' ').trim().slice(0, 7000);
}
async function runStore(store) {
  const ownerId = String(store.owner_user_id || '');
  if (!ownerId) return { skipped: true, store_id: store.id, reason: 'missing owner id' };
  const own = entities(env, { system: true, reason: 'write scheduled check and alert for the store owner', userId: ownerId });
  const recent = await own.store_check.list({ orderBy: '-checked_at', limit: 50 });
  if (recent.some((row) => String(row.store_id) === String(store.id) && String(row.checked_at || '').slice(0, 10) === day)) return { skipped: true, store_id: store.id, reason: 'already checked today' };
  let root;
  try { root = new URL(String(store.store_url || '')); } catch (_) { return { skipped: true, store_id: store.id, reason: 'invalid store URL' }; }
  if (root.protocol !== 'https:' || root.username || root.password || privateHost(root.hostname)) return { skipped: true, store_id: store.id, reason: 'store URL is not a public HTTPS address' };
  const origin = root.origin;
  const began = Date.now();
  const [home, collection, products, initialCart, checkout] = await Promise.all([
    get(origin + '/'), get(origin + '/collections/all'), get(origin + '/products.json?limit=1'), get(origin + '/cart.js', { Accept: 'application/json' }), get(origin + '/checkout')
  ]);
  const code = { home: home.status, collection: collection.status, product: products.status, cart: initialCart.status, checkout: checkout.status, add: 'not_tested' };
  const issues = [];
  if (!home.ok || home.status >= 400) issues.push('The homepage returned HTTP ' + home.status + '.');
  else if (home.body.length < 800 || !/<body[\s>]/i.test(home.body)) issues.push('The homepage response looks unexpectedly empty.');
  if (!collection.ok || collection.status >= 400) issues.push('The all-products collection returned HTTP ' + collection.status + '.');
  let product = null;
  if (products.ok) {
    try { const parsed = JSON.parse(products.body); product = parsed && parsed.products && parsed.products[0] || null; } catch (_) {}
  }
  let productHtml = '';
  if (!products.ok || products.status >= 400) issues.push('Shopify product data returned HTTP ' + products.status + '.');
  else if (product && product.handle) {
    const page = await get(origin + '/products/' + encodeURIComponent(String(product.handle)));
    code.product = page.status; productHtml = page.body;
    if (!page.ok || page.status >= 400) issues.push('A sample product page returned HTTP ' + page.status + '.');
  } else issues.push('No public sample product was available to verify.');
  let cartCookie = '';
  const variant = product && product.variants && product.variants[0] ? String(product.variants[0].id) : '';
  if (variant) {
    try {
      const add = await fetch(origin + '/cart/add.js', { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(8000), headers: Object.assign({}, headers, { 'Content-Type': 'application/json' }), body: JSON.stringify({ id: Number(variant), quantity: 1 }) });
      const cookie = /(?:^|,\s*)(cart=[^; ,]+)/i.exec(add.headers.get('set-cookie') || '');
      if (cookie) cartCookie = cookie[1];
      const addData = await add.json().catch(() => ({}));
      code.add = add.ok && !(addData && addData.status >= 400) ? 'working' : 'failed';
      if (code.add === 'failed') issues.push('A sample product could not be added to the temporary test cart.');
    } catch (_) { code.add = 'failed'; issues.push('The add-to-cart test did not complete.'); }
  }
  const cookieHeaders = cartCookie ? { Cookie: cartCookie } : {};
  try {
    const cart = await fetch(origin + '/cart.js', { redirect: 'manual', signal: AbortSignal.timeout(8000), headers: Object.assign({}, headers, { Accept: 'application/json' }, cookieHeaders) });
    code.cart = cart.status;
    const cartData = await cart.json().catch(() => null);
    if (!cart.ok || cart.status >= 400 || (code.add === 'working' && Number(cartData && cartData.item_count || 0) < 1)) { if (code.add === 'working') code.add = 'failed'; issues.push('The cart did not show the sample product after it was added.'); }
  } catch (_) { code.cart = 0; issues.push('The cart could not be checked.'); }
  try {
    const cartPage = await get(origin + '/cart', cookieHeaders);
    if (cartPage.status >= 400) issues.push('The cart page returned HTTP ' + cartPage.status + '.');
    if (!/name\s*=\s*["']checkout|href\s*=\s*["'][^"']*\/checkout|action\s*=\s*["'][^"']*\/checkout/i.test(cartPage.body)) issues.push('The cart page did not show a checkout control.');
    let checkoutValid = checkout.status > 0 && checkout.status < 400;
    if (checkout.status >= 300 && checkout.status < 400 && checkout.location) { try { const dest = new URL(checkout.location, origin); checkoutValid = /checkout/i.test(dest.pathname) || /checkout/i.test(dest.hostname); } catch (_) { checkoutValid = false; } }
    if (!checkoutValid) issues.push('The checkout path did not lead to a checkout page. No order was placed.');
  } catch (_) { issues.push('The cart or checkout path could not be checked. No order was placed.'); }
  if (code.add === 'working') {
    try { const clear = await fetch(origin + '/cart/clear.js', { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(5000), headers: Object.assign({}, headers, { 'Content-Type': 'application/json' }, cookieHeaders), body: '{}' }); await clear.body.cancel(); }
    catch (_) { console.warn('[shopwatch] temporary cart cleanup failed', store.id); }
  }
  const title = decodeTitle(home.body, String(store.store_name || root.hostname));
  const text = readableText(home.body, store.ignored_terms);
  const layout = { has_header: /<(?:header|nav)\b/i.test(home.body), has_main: /<main\b/i.test(home.body), title_present: /<title[^>]*>\s*[^<\s]/i.test(home.body), image_count: (home.body.match(/<img\b/gi) || []).length };
  let baseline = null;
  try { const parsed = JSON.parse(String(store.baseline_signature || '')); if (parsed && parsed.version === 2) baseline = parsed; } catch (_) {}
  if (baseline && baseline.text) {
    const before = new Set(String(baseline.text).split(/\s+/).filter((x) => x.length > 2));
    const after = new Set(text.split(/\s+/).filter((x) => x.length > 2));
    let common = 0; for (const word of after) if (before.has(word)) common++;
    const similarity = common / Math.max(1, Math.max(before.size, after.size));
    if (String(baseline.text).length > 300 && text.length < String(baseline.text).length * 0.45) issues.push('A large part of the homepage content appears to be missing.');
    else if (before.size > 80 && similarity < 0.52) issues.push('The homepage content has changed substantially from its saved starting point.');
    const oldLayout = baseline.layout || {};
    if ((oldLayout.has_header && !layout.has_header) || (oldLayout.has_main && !layout.has_main) || (oldLayout.title_present && !layout.title_present)) issues.push('A key part of the homepage structure is missing.');
    if (Number(oldLayout.image_count) >= 3 && layout.image_count <= Number(oldLayout.image_count) * 0.35) issues.push('Most homepage images are no longer appearing in the page.');
  }
  const loadMs = Date.now() - began;
  const slowAt = store.baseline_load_ms ? Math.max(2500, Number(store.baseline_load_ms) * 1.7) : 8000;
  if (store.baseline_signature && loadMs > slowAt) issues.push('The homepage is taking noticeably longer to respond than usual.');
  const broken = code.home === 0 || code.home >= 400 || code.collection === 0 || code.collection >= 400 || code.product === 0 || code.product >= 400 || code.cart === 0 || code.cart >= 400 || code.add === 'failed' || code.checkout === 0 || code.checkout === 404 || code.checkout >= 500;
  const status = issues.length ? (broken ? 'broken' : 'needs_attention') : 'healthy';
  const signature = String(store.baseline_signature || '') || JSON.stringify({ version: 2, text, layout });
  const baselineFields = store.baseline_signature ? {} : { baseline_title: title, baseline_signature: signature, baseline_load_ms: loadMs, baseline_scripts_json: '[]', baseline_product_page: productHtml.slice(0, 2000), baseline_collection_page: origin + '/collections/all' };
  await admin.shop_store.update(String(store.id), Object.assign(baselineFields, { status, last_check_status: status, last_checked_at: now }));
  const summary = issues[0] || (store.baseline_signature ? 'All checked pages responded and the storefront looks consistent with its starting point.' : 'Starting point saved from this visit.');
  await own.store_check.create({ store_id: String(store.id), owner_user_id: ownerId, checked_at: now, status, summary, issues_json: JSON.stringify(issues), homepage_status: code.home, collection_status: code.collection, product_status: code.product, cart_status: code.cart, checkout_status: code.checkout, add_to_cart_status: code.add, load_ms: loadMs, page_title: title, page_signature: signature, scripts_json: '[]' });
  if (issues.length) {
    const alerts = await own.store_alert.list({ orderBy: '-created_at', limit: 100 });
    const duplicate = alerts.find((row) => String(row.store_id) === String(store.id) && row.status === 'open' && Date.now() - new Date(row.created_at).getTime() < 20 * 60 * 60 * 1000);
    if (!duplicate) {
      const subject = status === 'broken' ? 'Your store needs attention now' : 'A store change needs a look';
      await own.store_alert.create({ store_id: String(store.id), owner_user_id: ownerId, severity: status, title: subject, message: summary + ' Details: ' + issues.slice(0, 3).join(' '), status: 'open' });
      try { await sendEmail(env).send({ to: String(store.alert_email || store.owner_email), subject: subject + ' — ' + title, text: 'Hi,\n\n' + summary + '\n\nWhat we found:\n- ' + issues.slice(0, 5).join('\n- ') + '\n\nStore: ' + origin + '\n\nOpen your Shopwatch dashboard to review the history or request help fixing this.' }); }
      catch (error) { console.error('[shopwatch] alert email was not accepted', String(error && error.message || error)); }
    }
  }
  return { store_id: store.id, status };
}
let checked = 0, skipped = 0, failed = 0;
for (let i = 0; i < batch.length; i += 6) {
  const results = await Promise.all(batch.slice(i, i + 6).map(async (store) => {
    try { return await runStore(store); }
    catch (error) { console.error('[shopwatch] scheduled store check failed', String(store.id), String(error && error.message || error)); return { failed: true }; }
  }));
  for (const result of results) { if (result && result.failed) failed++; else if (result && result.skipped) skipped++; else checked++; }
}
const nextOffset = (start + batch.length) % stores.length;
if (state) await admin.monitor_state.update(String(state.id), { scan_offset: nextOffset, last_scan_at: now });
else await admin.monitor_state.create({ scan_offset: nextOffset, last_scan_at: now });
return { success: failed === 0, checked, skipped, failed, stores_total: stores.length, next_offset: nextOffset, date_utc: day };