// Deno Deploy entry point. Same logic as server.js, storing everything in
// Deno KV instead of JSON files on disk.
//
//   deno run --unstable-kv --allow-net --allow-read --allow-env main.js
//
// On Deno Deploy, set the entry point to main.js. KV is provisioned for you.

import { handleApi } from './core.js';

const kv = await Deno.openKv();
const page = await Deno.readTextFile(new URL('./public/index.html', import.meta.url));
const TOKEN = Deno.env.get('DECK_TOKEN') ?? '';

const store = {
  async read(name) {
    const entry = await kv.get(['deck', name]);
    return entry.value ?? null;
  },
  async write(name, value) {
    // Keep the previous value under its own key, mirroring the .bak files the
    // Node version writes.
    const current = await kv.get(['deck', name]);
    if (current.value != null) await kv.set(['deck-previous', name], current.value);
    await kv.set(['deck', name], value);
  },
};

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

// With no DECK_TOKEN set the deck is open to anyone with the URL. Set one in the
// Deploy dashboard and append ?key=... once; the page remembers it.
function allowed(url, request) {
  if (!TOKEN) return true;
  return url.searchParams.get('key') === TOKEN || request.headers.get('x-deck-key') === TOKEN;
}

Deno.serve(async (request) => {
  const url = new URL(request.url);

  if (!allowed(url, request)) {
    return url.pathname.startsWith('/api/')
      ? json(401, { error: 'Wrong or missing key.' })
      : new Response('Not found', { status: 404 });
  }

  if (!url.pathname.startsWith('/api/')) {
    if (url.pathname !== '/') return new Response('Not found', { status: 404 });
    return new Response(page, {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' },
    });
  }

  try {
    const body = request.method === 'GET' ? {} : await request.json().catch(() => ({}));
    const { status, body: payload } = await handleApi({
      method: request.method,
      pathname: url.pathname,
      body,
      store,
    });
    return json(status, payload);
  } catch (err) {
    return json(500, { error: err.message });
  }
});
