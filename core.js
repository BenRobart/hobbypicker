// Shared by the Node server and the Deno one. Knows nothing about how things
// are stored: it is handed a store with read(name) and write(name, value).
//
// The server keeps the deck and nothing else: cards, the columns they sit in,
// and the decks those belong to. Preferences (theme, timer length, alarm, which
// deck you are looking at) live in the browser, so the two deployments show the
// same cards while each machine keeps its own way of looking at them.

const ICONS = [
  'stack', 'music', 'quiet', 'bed', 'bolt', 'bulb',
  'book', 'game', 'pencil', 'sparkle', 'moon', 'heart', 'clock',
];

// Bumped whenever the page and the API need to agree on something. Reported by
// /api/state so a deployment running older code announces itself instead of
// failing somewhere further down with a confusing error.
export const BUILD = '2026-08-17';

const DEFAULT_DECK = { id: 'default', name: 'Cards' };
const DEFAULT_COLUMN = { name: 'Cards', icon: 'stack' };

const ok = (body, status = 200) => ({ status, body });
const fail = (error, status = 400) => ({ status, body: { error } });

/* Write mode. The password itself never leaves the server: the cookie carries a
   hash of it, derived rather than random, so it survives a restart and is the
   same on every instance. Both servers share all of this, so the Node one and
   the Deno one accept exactly the same cookie. */

const WRITE_COOKIE = 'deck_write';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function tokenFor(password) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(password));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

// Compares in constant time, so a wrong cookie cannot be guessed one character
// at a time by watching how long the answer takes.
function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function cookieToken(header) {
  const entry = String(header ?? '')
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${WRITE_COOKIE}=`));
  return entry ? entry.slice(WRITE_COOKIE.length + 1) : '';
}

export function canWriteFrom(header, token) {
  return Boolean(token) && sameSecret(cookieToken(header), token);
}

export function writeCookie(token, { unlock, secure }) {
  const life = unlock ? 'Max-Age=31536000' : 'Max-Age=0';
  return `${WRITE_COOKIE}=${unlock ? token : ''}; Path=/; ${life}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

function text(value, limit) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/\s+/g, ' ').slice(0, limit);
  return trimmed || null;
}

/* Reading. None of these ever write. A store that holds nothing yields sensible
   defaults; a store holding something malformed throws, so a broken file can
   never be quietly replaced by a working one. */

async function readDecks(store) {
  const raw = await store.read('decks');
  if (raw == null) return [{ ...DEFAULT_DECK }];

  if (!Array.isArray(raw) || !raw.length) {
    throw new Error('decks must be a list with at least one deck. Nothing has been changed.');
  }
  if (!raw.every((deck) => deck && typeof deck.id === 'string' && typeof deck.name === 'string')) {
    throw new Error('every deck needs an id and a name. Nothing has been changed.');
  }

  return raw.map((deck) => ({ id: deck.id, name: deck.name }));
}

// A deck with no columns of its own gets one invented here. It only becomes
// real on disk the first time something is written.
async function readColumns(store, decks) {
  const raw = (await store.read('columns')) ?? [];

  if (!Array.isArray(raw)) {
    throw new Error('columns must be a list. Nothing has been changed.');
  }
  if (!raw.every((col) => col && typeof col.id === 'string' && typeof col.name === 'string')) {
    throw new Error('every column needs an id and a name. Nothing has been changed.');
  }

  const known = new Set(decks.map((deck) => deck.id));
  const columns = raw
    .filter((col) => known.has(col.deck))
    .map((col) => ({
      id: col.id,
      name: col.name,
      icon: ICONS.includes(col.icon) ? col.icon : DEFAULT_COLUMN.icon,
      deck: col.deck,
    }));

  for (const deck of decks) {
    if (!columns.some((col) => col.deck === deck.id)) {
      columns.push({ ...DEFAULT_COLUMN, id: `${deck.id}-col`, deck: deck.id });
    }
  }

  return columns;
}

async function readCards(store, decks, columns) {
  const raw = (await store.read('cards')) ?? [];

  if (!Array.isArray(raw)) {
    throw new Error('cards must be a list. Nothing has been changed.');
  }
  if (!raw.every((card) => card && typeof card.id === 'string' && typeof card.text === 'string')) {
    throw new Error('every card needs an id and text. Nothing has been changed.');
  }

  const decksById = new Set(decks.map((deck) => deck.id));
  const firstColumn = new Map();
  for (const col of columns) {
    if (!firstColumn.has(col.deck)) firstColumn.set(col.deck, col.id);
  }

  // A card pointing at a deck or column that no longer exists lands in the
  // first available one rather than vanishing.
  return raw.map((card) => {
    const deck = decksById.has(card.deck) ? card.deck : decks[0].id;
    const column = columns.find((col) => col.id === card.column && col.deck === deck);
    return {
      id: card.id,
      text: card.text,
      deck,
      column: column ? column.id : firstColumn.get(deck),
    };
  });
}

async function readAll(store) {
  const decks = await readDecks(store);
  const columns = await readColumns(store, decks);
  const cards = await readCards(store, decks, columns);
  return { decks, columns, cards };
}

/* Routing */

// canWrite and token come from the server, which is the only part that can read
// a cookie. A result carrying a cookie field asks the server to set or clear it;
// the Secure flag is the server's to decide, since only it knows the protocol.
export async function handleApi({ method, pathname, body = {}, store, canWrite = false, token = '' }) {
  const cardId = pathname.match(/^\/api\/cards\/([\w-]+)$/)?.[1];
  const deckId = pathname.match(/^\/api\/decks\/([\w-]+)$/)?.[1];
  const columnId = pathname.match(/^\/api\/columns\/([\w-]+)$/)?.[1];

  if (pathname === '/api/state' && method === 'GET') {
    return ok({ ...(await readAll(store)), canWrite, build: BUILD });
  }

  if (pathname === '/api/unlock' && method === 'POST') {
    await pause(300); // A guess costs a third of a second.

    if (typeof body.password !== 'string' || !sameSecret(await tokenFor(body.password), token)) {
      return fail('That is not the password.', 401);
    }
    return { status: 200, body: { canWrite: true }, cookie: 'unlock' };
  }

  if (pathname === '/api/lock' && method === 'POST') {
    return { status: 200, body: { canWrite: false }, cookie: 'lock' };
  }

  // Everything past here changes something, so it needs write mode.
  if (method !== 'GET' && !canWrite) {
    return fail('Locked. Turn on write mode to make changes.', 403);
  }

  /* Decks */

  if (pathname === '/api/decks' && method === 'POST') {
    const name = text(body.name, 40);
    if (!name) return fail('A deck needs a name.');

    const decks = await readDecks(store);
    const columns = await readColumns(store, decks);
    const deck = { id: crypto.randomUUID(), name };

    decks.push(deck);
    columns.push({ ...DEFAULT_COLUMN, id: `${deck.id}-col`, deck: deck.id });
    await store.write('decks', decks);
    await store.write('columns', columns);
    return ok({ deck, columns }, 201);
  }

  if (deckId && method === 'PATCH') {
    const decks = await readDecks(store);
    const deck = decks.find((entry) => entry.id === deckId);
    if (!deck) return fail('That deck is gone.', 404);

    const name = text(body.name, 40);
    if (!name) return fail('A deck needs a name.');

    deck.name = name;
    await store.write('decks', decks);
    return ok(deck);
  }

  if (deckId && method === 'DELETE') {
    const decks = await readDecks(store);
    if (decks.length < 2) return fail('Keep at least one deck.');
    if (!decks.some((deck) => deck.id === deckId)) return fail('That deck is gone.', 404);

    // Cards, then columns, then the deck itself. Failing part way through this
    // order leaves things reachable; the reverse order would strand them.
    const columns = await readColumns(store, decks);
    const cards = await readCards(store, decks, columns);

    await store.write('cards', cards.filter((card) => card.deck !== deckId));
    await store.write('columns', columns.filter((col) => col.deck !== deckId));
    await store.write('decks', decks.filter((deck) => deck.id !== deckId));
    return ok({ id: deckId });
  }

  /* Columns */

  if (pathname === '/api/columns' && method === 'POST') {
    const name = text(body.name, 30);
    if (!name) return fail('A column needs a name.');
    if (!ICONS.includes(body.icon)) return fail('Pick one of the icons.');

    const decks = await readDecks(store);
    if (!decks.some((deck) => deck.id === body.deck)) return fail('That deck is gone.', 404);

    const columns = await readColumns(store, decks);
    const column = { id: crypto.randomUUID(), name, icon: body.icon, deck: body.deck };

    columns.push(column);
    await store.write('columns', columns);
    return ok(column, 201);
  }

  if (columnId && method === 'PATCH') {
    const decks = await readDecks(store);
    const columns = await readColumns(store, decks);
    const column = columns.find((entry) => entry.id === columnId);
    if (!column) return fail('That column is gone.', 404);

    if ('name' in body) {
      const name = text(body.name, 30);
      if (!name) return fail('A column needs a name.');
      column.name = name;
    }
    if ('icon' in body) {
      if (!ICONS.includes(body.icon)) return fail('Pick one of the icons.');
      column.icon = body.icon;
    }

    await store.write('columns', columns);
    return ok(column);
  }

  if (columnId && method === 'DELETE') {
    const decks = await readDecks(store);
    const columns = await readColumns(store, decks);
    const column = columns.find((entry) => entry.id === columnId);
    if (!column) return fail('That column is gone.', 404);

    if (columns.filter((entry) => entry.deck === column.deck).length < 2) {
      return fail('Keep at least one column in a deck.');
    }

    const cards = await readCards(store, decks, columns);
    await store.write('cards', cards.filter((card) => card.column !== columnId));
    await store.write('columns', columns.filter((entry) => entry.id !== columnId));
    return ok({ id: columnId });
  }

  /* Cards */

  if (pathname === '/api/cards' && method === 'POST') {
    const value = text(body.text, 200);
    if (!value) return fail('A card needs some text.');

    const decks = await readDecks(store);
    const columns = await readColumns(store, decks);
    const column = columns.find((entry) => entry.id === body.column);
    if (!column) return fail('That column is gone.', 404);

    const cards = await readCards(store, decks, columns);
    const card = { id: crypto.randomUUID(), text: value, deck: column.deck, column: column.id };

    cards.push(card);
    await store.write('cards', cards);
    return ok(card, 201);
  }

  if (pathname === '/api/cards/arrange' && method === 'PUT') {
    const items = Array.isArray(body.items) ? body.items : null;
    if (!items) return fail('Send the cards in their new order.');

    const decks = await readDecks(store);
    const columns = await readColumns(store, decks);
    const cards = await readCards(store, decks, columns);

    const wanted = new Set(items.map((item) => item?.id));
    const slots = [];
    cards.forEach((card, index) => {
      if (wanted.has(card.id)) slots.push(index);
    });

    if (wanted.size !== items.length || slots.length !== items.length) {
      return fail('That order does not match the deck.');
    }
    if (!items.every((item) => columns.some((col) => col.id === item.column))) {
      return fail('One of those columns is gone.', 404);
    }

    // The deck's cards are rewritten into the slots they already occupy, so
    // cards belonging to another deck never shift.
    const ordered = items.map((item) => {
      const card = cards.find((entry) => entry.id === item.id);
      const column = columns.find((col) => col.id === item.column);
      return { ...card, column: column.id, deck: column.deck };
    });
    slots.forEach((slot, index) => {
      cards[slot] = ordered[index];
    });

    await store.write('cards', cards);
    return ok({ arranged: ordered.length });
  }

  if (cardId && method === 'PATCH') {
    const decks = await readDecks(store);
    const columns = await readColumns(store, decks);
    const cards = await readCards(store, decks, columns);
    const card = cards.find((entry) => entry.id === cardId);
    if (!card) return fail('That card is no longer in the deck.', 404);

    if ('text' in body) {
      const value = text(body.text, 200);
      if (!value) return fail('A card needs some text.');
      card.text = value;
    }
    if ('column' in body) {
      const column = columns.find((entry) => entry.id === body.column);
      if (!column) return fail('That column is gone.', 404);
      card.column = column.id;
      card.deck = column.deck;
    }

    await store.write('cards', cards);
    return ok(card);
  }

  if (cardId && method === 'DELETE') {
    const decks = await readDecks(store);
    const columns = await readColumns(store, decks);
    const cards = await readCards(store, decks, columns);
    const next = cards.filter((card) => card.id !== cardId);

    if (next.length === cards.length) return fail('That card is no longer in the deck.', 404);

    await store.write('cards', next);
    return ok({ id: cardId });
  }

  return fail('No such route.', 404);
}
