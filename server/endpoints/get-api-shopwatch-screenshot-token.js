if (!/^[0-9a-f-]{36}$/i.test(String(params.token || ''))) return new Response('Not found', { status: 404 });
const object = await userStorage(env).get('shopwatch/screenshots/' + params.token + '.png');
if (!object) return new Response('Not found', { status: 404 });
return new Response(object.body || object, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' } });