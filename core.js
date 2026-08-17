// Shared by the Node server and the Deno one. Knows nothing about how things
// are stored: it is handed a store with read(name) and write(name, value).

export const ICONS = [
  'stack', 'music', 'quiet', 'bed', 'bolt', 'bulb',
  'book', 'game', 'pencil', 'sparkle', 'moon', 'heart', 'clock',
];

const THEMES = new Set(['auto', 'dark', 'pastel']);
const DEFAULT_DECK = { id: 'default', name: 'Cards' };
const DEFAULT_COLUMN = { name: 'Cards', icon: 'stack' };
const DEFAULT_SETTINGS = { minutes: 20, theme: 'auto', deck: DEFAULT_DECK.id };

const ok = (body, status = 200) => ({ status, body });
const fail = (error, status = 400) => ({ status, body: { error } });

function text(value, limit) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/\s+/g, ' ').slice(0, limit);
  return trimmed || null;
}

function minutesOf(value) {
  const minutes = Number(value);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 180) return null;
  return minutes;
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

async function readSettings(store, decks) {
  const raw = await store.read('settings');
  const stored = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};

  return {
    minutes: minutesOf(stored.minutes) ?? DEFAULT_SETTINGS.minutes,
    theme: THEMES.has(stored.theme) ? stored.theme : DEFAULT_SETTINGS.theme,
    deck: decks.some((deck) => deck.id === stored.deck) ? stored.deck : decks[0].id,
  };
}

async function readAll(store) {
  const decks = await readDecks(store);
  const columns = await readColumns(store, decks);
  const [cards, settings] = await Promise.all([
    readCards(store, decks, columns),
    readSettings(store, decks),
  ]);
  return { decks, columns, cards, settings };
}

/* Routing */

export async function handleApi({ method, pathname, body = {}, store }) {
  const cardId = pathname.match(/^\/api\/cards\/([\w-]+)$/)?.[1];
  const deckId = pathname.match(/^\/api\/decks\/([\w-]+)$/)?.[1];
  const columnId = pathname.match(/^\/api\/columns\/([\w-]+)$/)?.[1];

  if (pathname === '/api/state' && method === 'GET') {
    return ok(await readAll(store));
  }

  if (pathname === '/api/settings' && method === 'PATCH') {
    const decks = await readDecks(store);
    const settings = await readSettings(store, decks);

    if ('minutes' in body) {
      const minutes = minutesOf(body.minutes);
      if (!minutes) return fail('Pick a whole number of minutes between 1 and 180.');
      settings.minutes = minutes;
    }
    if ('theme' in body) {
      if (!THEMES.has(body.theme)) return fail('Unknown theme.');
      settings.theme = body.theme;
    }
    if ('deck' in body) {
      if (!decks.some((deck) => deck.id === body.deck)) return fail('That deck is gone.', 404);
      settings.deck = body.deck;
    }

    await store.write('settings', settings);
    return ok(settings);
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
