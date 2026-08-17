const http = require('http');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 4173;
const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, 'cards.json');
const DECKS_FILE = path.join(ROOT, 'decks.json');
const SETTINGS_FILE = path.join(ROOT, 'settings.json');

// Serve from public/ when it is there, otherwise from alongside server.js.
const PUBLIC_DIR = require('fs').existsSync(path.join(ROOT, 'public', 'index.html'))
  ? path.join(ROOT, 'public')
  : ROOT;

const PRIVATE_FILES = new Set(
  ['server.js', 'cards.json', 'decks.json', 'settings.json'].flatMap((name) => [
    name,
    `${name}.tmp`,
    `${name}.bak`,
  ]),
);

const DEFAULT_DECK = { id: 'default', name: 'Cards' };
const THEMES = new Set(['auto', 'dark', 'pastel']);
const DEFAULT_SETTINGS = { minutes: 20, theme: 'auto', deck: DEFAULT_DECK.id };

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// Reading never writes. A missing file is empty; a broken file is an error, so a
// malformed file can never be quietly replaced by a good one.
async function readJson(file, fallback) {
  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${path.basename(file)} is not valid JSON. Nothing has been changed.`);
  }
}

// Write to a temp file and keep the previous version as a .bak, so a crash or a
// bad write always leaves one intact copy behind.
async function writeJson(file, value) {
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');

  try {
    await fs.copyFile(file, `${file}.bak`);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  await fs.rename(tmp, file);
}

async function readCards() {
  const parsed = await readJson(DATA_FILE, []);
  const name = path.basename(DATA_FILE);

  if (!Array.isArray(parsed)) {
    throw new Error(`${name} must hold an array of cards. Nothing has been changed.`);
  }

  const valid = parsed.every(
    (card) => card && typeof card.id === 'string' && typeof card.text === 'string',
  );
  if (!valid) {
    throw new Error(`Every card in ${name} needs an id and text. Nothing has been changed.`);
  }

  return parsed.map((card) => ({
    id: card.id,
    text: card.text,
    music: Boolean(card.music),
    deck: typeof card.deck === 'string' && card.deck ? card.deck : DEFAULT_DECK.id,
  }));
}

async function readDecks() {
  const parsed = await readJson(DECKS_FILE, [DEFAULT_DECK]);
  const name = path.basename(DECKS_FILE);

  if (!Array.isArray(parsed) || !parsed.length) {
    throw new Error(`${name} must hold at least one deck. Nothing has been changed.`);
  }

  const valid = parsed.every(
    (deck) => deck && typeof deck.id === 'string' && typeof deck.name === 'string',
  );
  if (!valid) {
    throw new Error(`Every deck in ${name} needs an id and a name. Nothing has been changed.`);
  }

  return parsed.map((deck) => ({ id: deck.id, name: deck.name }));
}

async function readSettings(decks) {
  const parsed = await readJson(SETTINGS_FILE, {});
  const stored = parsed && typeof parsed === 'object' ? parsed : {};
  const deckExists = decks?.some((deck) => deck.id === stored.deck);

  return {
    minutes: cleanMinutes(stored.minutes) ?? DEFAULT_SETTINGS.minutes,
    theme: THEMES.has(stored.theme) ? stored.theme : DEFAULT_SETTINGS.theme,
    deck: deckExists ? stored.deck : decks?.[0]?.id ?? DEFAULT_SETTINGS.deck,
  };
}

function cleanMinutes(value) {
  const minutes = Number(value);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 180) return null;
  return minutes;
}

function cleanText(value, limit = 200) {
  if (typeof value !== 'string') return null;
  const text = value.trim().replace(/\s+/g, ' ').slice(0, limit);
  return text || null;
}

function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1e6) {
        reject(new Error('Body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const filePath = path.join(PUBLIC_DIR, rel);

  if (!filePath.startsWith(PUBLIC_DIR) || PRIVATE_FILES.has(path.basename(filePath))) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const file = await fs.readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(file);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

async function handleApi(req, res, url) {
  const cardMatch = url.pathname.match(/^\/api\/cards\/([\w-]+)$/);
  const deckMatch = url.pathname.match(/^\/api\/decks\/([\w-]+)$/);

  if (url.pathname === '/api/state' && req.method === 'GET') {
    const [cards, decks] = await Promise.all([readCards(), readDecks()]);
    const known = new Set(decks.map((deck) => deck.id));
    return sendJson(res, 200, {
      // A card left behind by a deleted deck falls back to the first deck
      // rather than disappearing. This is a view of it, not a write.
      cards: cards.map((card) => (known.has(card.deck) ? card : { ...card, deck: decks[0].id })),
      decks,
      settings: await readSettings(decks),
    });
  }

  if (url.pathname === '/api/export' && req.method === 'GET') {
    const [cards, decks] = await Promise.all([readCards(), readDecks()]);
    const stamp = new Date().toISOString().slice(0, 10);

    return sendJson(
      res,
      200,
      { exported: new Date().toISOString(), decks, cards, settings: await readSettings(decks) },
      { 'Content-Disposition': `attachment; filename="deck-${stamp}.json"` },
    );
  }

  if (url.pathname === '/api/settings' && req.method === 'PATCH') {
    const body = await readBody(req);
    const decks = await readDecks();
    const settings = await readSettings(decks);

    if ('minutes' in body) {
      const minutes = cleanMinutes(body.minutes);
      if (!minutes) {
        return sendJson(res, 400, { error: 'Pick a whole number of minutes between 1 and 180.' });
      }
      settings.minutes = minutes;
    }
    if ('theme' in body) {
      if (!THEMES.has(body.theme)) return sendJson(res, 400, { error: 'Unknown theme.' });
      settings.theme = body.theme;
    }
    if ('deck' in body) {
      if (!decks.some((deck) => deck.id === body.deck)) {
        return sendJson(res, 404, { error: 'That deck is gone.' });
      }
      settings.deck = body.deck;
    }

    await writeJson(SETTINGS_FILE, settings);
    return sendJson(res, 200, settings);
  }

  if (url.pathname === '/api/decks' && req.method === 'POST') {
    const body = await readBody(req);
    const name = cleanText(body.name, 40);
    if (!name) return sendJson(res, 400, { error: 'A deck needs a name.' });

    const decks = await readDecks();
    const deck = { id: crypto.randomUUID(), name };
    decks.push(deck);
    await writeJson(DECKS_FILE, decks);
    return sendJson(res, 201, deck);
  }

  if (deckMatch && req.method === 'PATCH') {
    const decks = await readDecks();
    const deck = decks.find((item) => item.id === deckMatch[1]);
    if (!deck) return sendJson(res, 404, { error: 'That deck is gone.' });

    const body = await readBody(req);
    const name = cleanText(body.name, 40);
    if (!name) return sendJson(res, 400, { error: 'A deck needs a name.' });

    deck.name = name;
    await writeJson(DECKS_FILE, decks);
    return sendJson(res, 200, deck);
  }

  if (deckMatch && req.method === 'DELETE') {
    const decks = await readDecks();
    if (decks.length < 2) return sendJson(res, 400, { error: 'Keep at least one deck.' });
    if (!decks.some((deck) => deck.id === deckMatch[1])) {
      return sendJson(res, 404, { error: 'That deck is gone.' });
    }

    // Cards go first. If this fails halfway, the deck still exists and nothing
    // is orphaned; the reverse order could strand cards in a deck that is gone.
    const cards = await readCards();
    await writeJson(DATA_FILE, cards.filter((card) => card.deck !== deckMatch[1]));
    await writeJson(DECKS_FILE, decks.filter((deck) => deck.id !== deckMatch[1]));
    return sendJson(res, 200, { id: deckMatch[1] });
  }

  if (url.pathname === '/api/cards' && req.method === 'POST') {
    const body = await readBody(req);
    const text = cleanText(body.text);
    if (!text) return sendJson(res, 400, { error: 'A card needs some text.' });

    const decks = await readDecks();
    const deck = decks.some((item) => item.id === body.deck) ? body.deck : decks[0].id;
    const cards = await readCards();
    const card = { id: crypto.randomUUID(), text, music: Boolean(body.music), deck };

    cards.push(card);
    await writeJson(DATA_FILE, cards);
    return sendJson(res, 201, card);
  }

  if (url.pathname === '/api/cards/arrange' && req.method === 'PUT') {
    const body = await readBody(req);
    const items = Array.isArray(body.items) ? body.items : null;
    if (!items) return sendJson(res, 400, { error: 'Send the cards in their new order.' });

    const cards = await readCards();
    const wanted = new Set(items.map((item) => item?.id));
    const slots = [];
    cards.forEach((card, index) => {
      if (wanted.has(card.id)) slots.push(index);
    });

    if (wanted.size !== items.length || slots.length !== items.length) {
      return sendJson(res, 400, { error: 'That order does not match the deck.' });
    }

    const ordered = items.map((item) => {
      const card = cards.find((entry) => entry.id === item.id);
      return { ...card, music: Boolean(item.music) };
    });
    slots.forEach((slot, index) => {
      cards[slot] = ordered[index];
    });

    await writeJson(DATA_FILE, cards);
    return sendJson(res, 200, { arranged: ordered.length });
  }

  if (cardMatch && req.method === 'PATCH') {
    const cards = await readCards();
    const card = cards.find((entry) => entry.id === cardMatch[1]);
    if (!card) return sendJson(res, 404, { error: 'That card is no longer in the deck.' });

    const body = await readBody(req);
    if ('text' in body) {
      const text = cleanText(body.text);
      if (!text) return sendJson(res, 400, { error: 'A card needs some text.' });
      card.text = text;
    }
    if ('music' in body) card.music = Boolean(body.music);
    if ('deck' in body) {
      const decks = await readDecks();
      if (!decks.some((deck) => deck.id === body.deck)) {
        return sendJson(res, 404, { error: 'That deck is gone.' });
      }
      card.deck = body.deck;
    }

    await writeJson(DATA_FILE, cards);
    return sendJson(res, 200, card);
  }

  if (cardMatch && req.method === 'DELETE') {
    const cards = await readCards();
    const next = cards.filter((card) => card.id !== cardMatch[1]);
    if (next.length === cards.length) {
      return sendJson(res, 404, { error: 'That card is no longer in the deck.' });
    }

    await writeJson(DATA_FILE, next);
    return sendJson(res, 200, { id: cardMatch[1] });
  }

  return sendJson(res, 404, { error: 'No such route.' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res);

  try {
    await handleApi(req, res, url);
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Deck running at http://localhost:${PORT}`);
  console.log(`Cards stored in ${DATA_FILE}`);
});
