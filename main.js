// Deno Deploy entry point. Same logic as server.js, storing everything in
// Deno KV instead of JSON files on disk.
//
//   deno task start
//
// On Deno Deploy, set the entry point to main.js. KV is provisioned for you.

import { handleApi, canWriteFrom, tokenFor, writeCookie } from './core.js';

const kv = await Deno.openKv();
const page = await Deno.readTextFile(new URL('./public/index.html', import.meta.url));
const KEY = Deno.env.get('DECK_TOKEN') ?? '';

// Set DECK_PASSWORD in the Deploy dashboard to change it. Same default as the
// Node server, so the two behave identically.
const PASSWORD = Deno.env.get('DECK_PASSWORD') || 'qwerty';
const WRITE_TOKEN = await tokenFor(PASSWORD);

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

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
  });
}

// With no DECK_TOKEN set the deck is open to anyone with the URL. Set one in the
// Deploy dashboard and append ?key=... once; the page remembers it. This gates
// the whole app; the password below is a separate thing, and only gates writing.
function allowed(url, request) {
  if (!KEY) return true;
  return url.searchParams.get('key') === KEY || request.headers.get('x-deck-key') === KEY;
}

// Deploy always terminates TLS in front of the app, so trust the forwarded
// header the same way the Node server does.
function isSecure(url, request) {
  const forwarded = (request.headers.get('x-forwarded-proto') ?? '').split(',')[0].trim();
  return forwarded ? forwarded === 'https' : url.protocol === 'https:';
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
    const { status, body: payload, cookie } = await handleApi({
      method: request.method,
      pathname: url.pathname,
      body,
      store,
      canWrite: canWriteFrom(request.headers.get('cookie'), WRITE_TOKEN),
      token: WRITE_TOKEN,
    });

    const headers = cookie
      ? {
        'set-cookie': writeCookie(WRITE_TOKEN, {
          unlock: cookie === 'unlock',
          secure: isSecure(url, request),
        }),
      }
      : {};
    return json(status, payload, headers);
  } catch (err) {
    return json(500, { error: err.message });
  }
});
