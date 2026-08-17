/**
 * Deck, for Deno. Same API as the Node version, with Deno KV in place of the
 * JSON files so it can run unchanged on Deno Deploy, which has no writable disk.
 *
 * Local:  deno run --unstable-kv --allow-net --allow-read --allow-env server.ts
 * Deploy: set the entry point to server.ts and enable KV.
 */

type Card = { id: string; text: string; music: boolean; deck: string };
type Deck = { id: string; name: string };
type Settings = { minutes: number; theme: string; deck: string };

const PORT = Number(Deno.env.get("PORT")) || 4173;

// Bind everywhere by default: a host that cannot reach the server just fails
// silently, which is a miserable thing to debug. HOST=127.0.0.1 restricts it,
// and the start task in deno.json does exactly that for local runs.
const HOSTNAME = Deno.env.get("HOST") || "0.0.0.0";

const CARDS_KEY = ["cards"];
const CARDS_BACKUP_KEY = ["cards_backup"];
const DECKS_KEY = ["decks"];
const SETTINGS_KEY = ["settings"];

const DEFAULT_DECK: Deck = { id: "default", name: "Cards" };
const THEMES = new Set(["auto", "dark", "pastel"]);
const DEFAULT_SETTINGS: Settings = { minutes: 20, theme: "auto", deck: DEFAULT_DECK.id };

// Set DECK_PASSWORD in the app's environment variables to change it.
const PASSWORD = Deno.env.get("DECK_PASSWORD") || "qwerty";
const COOKIE = "deck_write";

async function hash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// The cookie holds the hash of the password rather than the password itself, and
// is derived from it so it survives restarts and works across every instance.
const TOKEN = await hash(PASSWORD);

function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function canWrite(req: Request): boolean {
  const jar = req.headers.get("cookie") ?? "";
  const entry = jar.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE}=`));
  return entry ? sameSecret(entry.slice(COOKIE.length + 1), TOKEN) : false;
}

function writeCookie(req: Request, unlock: boolean): string {
  const proto = req.headers.get("x-forwarded-proto") ?? new URL(req.url).protocol.replace(":", "");
  const secure = proto === "https" ? "; Secure" : "";
  const life = unlock ? "Max-Age=31536000" : "Max-Age=0";
  return `${COOKIE}=${unlock ? TOKEN : ""}; Path=/; ${life}; HttpOnly; SameSite=Lax${secure}`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

// Deploy provides its own KV database. Locally, DECK_KV can point at a specific
// file (handy for backups and for keeping test data separate).
const kv = await Deno.openKv(Deno.env.get("DECK_KV") || undefined);

/* Storage ---------------------------------------------------------------- */

/** A KV entry that has never been written reads as an empty deck, exactly as a
 *  missing cards.json does. Anything present but malformed is an error rather
 *  than something to quietly repair, so bad data can never be overwritten by a
 *  well-meaning write. */
function parseCards(value: unknown): Card[] {
  if (value === null || value === undefined) return [];

  if (!Array.isArray(value)) {
    throw new Error("The stored deck is not a list of cards. Nothing has been changed.");
  }

  const valid = value.every(
    (card) => card && typeof card.id === "string" && typeof card.text === "string",
  );
  if (!valid) {
    throw new Error("Every stored card needs an id and text. Nothing has been changed.");
  }

  return value.map((card) => ({
    id: card.id,
    text: card.text,
    music: Boolean(card.music),
    deck: typeof card.deck === "string" && card.deck ? card.deck : DEFAULT_DECK.id,
  }));
}

/** Returns the cards and the versionstamp they were read at, so a write can
 *  refuse to land on top of someone else's edit. */
async function readCards(): Promise<{ cards: Card[]; versionstamp: string | null }> {
  const entry = await kv.get<Card[]>(CARDS_KEY);
  return { cards: parseCards(entry.value), versionstamp: entry.versionstamp };
}

/** Keeps the previous deck under a backup key, in the same spirit as the .bak
 *  file, and only commits if nothing changed underneath us. */
async function writeCards(cards: Card[], versionstamp: string | null) {
  const previous = await kv.get<Card[]>(CARDS_KEY);

  const result = await kv.atomic()
    .check({ key: CARDS_KEY, versionstamp })
    .set(CARDS_BACKUP_KEY, previous.value ?? [])
    .set(CARDS_KEY, cards)
    .commit();

  if (!result.ok) {
    throw new Error("The deck changed in another tab or on another device. Reload and try again.");
  }
}

async function readDecks(): Promise<Deck[]> {
  const entry = await kv.get<Deck[]>(DECKS_KEY);
  if (entry.value === null || entry.value === undefined) return [DEFAULT_DECK];

  if (!Array.isArray(entry.value) || !entry.value.length) {
    throw new Error("The stored decks are not a list. Nothing has been changed.");
  }

  const valid = entry.value.every(
    (deck) => deck && typeof deck.id === "string" && typeof deck.name === "string",
  );
  if (!valid) {
    throw new Error("Every stored deck needs an id and a name. Nothing has been changed.");
  }

  return entry.value.map((deck) => ({ id: deck.id, name: deck.name }));
}

async function readSettings(decks: Deck[]): Promise<Settings> {
  const entry = await kv.get<Partial<Settings>>(SETTINGS_KEY);
  const stored = entry.value && typeof entry.value === "object" ? entry.value : {};
  const deckExists = decks.some((deck) => deck.id === stored.deck);

  return {
    minutes: cleanMinutes(stored.minutes) ?? DEFAULT_SETTINGS.minutes,
    theme: THEMES.has(stored.theme as string) ? stored.theme as string : DEFAULT_SETTINGS.theme,
    deck: deckExists ? stored.deck as string : decks[0]?.id ?? DEFAULT_SETTINGS.deck,
  };
}

/* Helpers ---------------------------------------------------------------- */

function cleanMinutes(value: unknown): number | null {
  const minutes = Number(value);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 180) return null;
  return minutes;
}

function cleanText(value: unknown, limit = 200): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim().replace(/\s+/g, " ").slice(0, limit);
  return text || null;
}

function json(payload: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  const raw = await req.text();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Body is not valid JSON");
  }
}

/* Static files ------------------------------------------------------------ */

// Serve from public/ when it is there, otherwise from alongside server.ts.
const PUBLIC_DIR = await (async () => {
  const nested = new URL("./public/", import.meta.url);
  try {
    await Deno.stat(new URL("index.html", nested));
    return nested;
  } catch {
    return new URL("./", import.meta.url);
  }
})();

const PRIVATE_FILES = new Set(["server.ts", "server.js", "deno.json", "deno.lock"]);

async function serveStatic(pathname: string) {
  const rel = pathname === "/" ? "index.html" : pathname.slice(1);
  const target = new URL(rel, PUBLIC_DIR);

  if (!target.href.startsWith(PUBLIC_DIR.href) || PRIVATE_FILES.has(rel)) {
    return new Response("Forbidden", { status: 403 });
  }

  try {
    const file = await Deno.readFile(target);
    const ext = rel.slice(rel.lastIndexOf("."));
    return new Response(file, {
      headers: {
        "Content-Type": MIME[ext] ?? "application/octet-stream",
        "Cache-Control": "no-cache",
      },
    });
  } catch {
    return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain" } });
  }
}

/* API --------------------------------------------------------------------- */

async function handleApi(req: Request, url: URL): Promise<Response> {
  const cardMatch = url.pathname.match(/^\/api\/cards\/([\w-]+)$/);
  const deckMatch = url.pathname.match(/^\/api\/decks\/([\w-]+)$/);

  if (url.pathname === "/api/state" && req.method === "GET") {
    const [{ cards }, decks] = await Promise.all([readCards(), readDecks()]);
    const known = new Set(decks.map((deck) => deck.id));
    return json({
      // A card left behind by a deleted deck falls back to the first deck
      // rather than disappearing. This is a view of it, not a write.
      cards: cards.map((card) => (known.has(card.deck) ? card : { ...card, deck: decks[0].id })),
      decks,
      settings: await readSettings(decks),
      canWrite: canWrite(req),
    });
  }

  if (url.pathname === "/api/unlock" && req.method === "POST") {
    const body = await readBody(req);
    await sleep(300); // A guess costs a third of a second.

    if (typeof body.password !== "string" || !sameSecret(await hash(body.password), TOKEN)) {
      return json({ error: "That is not the password." }, 401);
    }
    return json({ canWrite: true }, 200, { "Set-Cookie": writeCookie(req, true) });
  }

  if (url.pathname === "/api/lock" && req.method === "POST") {
    return json({ canWrite: false }, 200, { "Set-Cookie": writeCookie(req, false) });
  }

  // Everything past here changes something, so it needs the password.
  if (req.method !== "GET" && !canWrite(req)) {
    return json({ error: "Locked. Enter the password to make changes." }, 403);
  }

  if (url.pathname === "/api/export" && req.method === "GET") {
    const [{ cards }, decks] = await Promise.all([readCards(), readDecks()]);
    const stamp = new Date().toISOString().slice(0, 10);

    return json(
      { exported: new Date().toISOString(), decks, cards, settings: await readSettings(decks) },
      200,
      { "Content-Disposition": `attachment; filename="deck-${stamp}.json"` },
    );
  }

  if (url.pathname === "/api/settings" && req.method === "PATCH") {
    const body = await readBody(req);
    const decks = await readDecks();
    const settings = await readSettings(decks);

    if ("minutes" in body) {
      const minutes = cleanMinutes(body.minutes);
      if (!minutes) return json({ error: "Pick a whole number of minutes between 1 and 180." }, 400);
      settings.minutes = minutes;
    }
    if ("theme" in body) {
      if (!THEMES.has(body.theme as string)) return json({ error: "Unknown theme." }, 400);
      settings.theme = body.theme as string;
    }
    if ("deck" in body) {
      if (!decks.some((deck) => deck.id === body.deck)) return json({ error: "That deck is gone." }, 404);
      settings.deck = body.deck as string;
    }

    await kv.set(SETTINGS_KEY, settings);
    return json(settings);
  }

  if (url.pathname === "/api/decks" && req.method === "POST") {
    const body = await readBody(req);
    const name = cleanText(body.name, 40);
    if (!name) return json({ error: "A deck needs a name." }, 400);

    const decks = await readDecks();
    const deck: Deck = { id: crypto.randomUUID(), name };
    decks.push(deck);
    await kv.set(DECKS_KEY, decks);
    return json(deck, 201);
  }

  if (deckMatch && req.method === "PATCH") {
    const decks = await readDecks();
    const deck = decks.find((item) => item.id === deckMatch[1]);
    if (!deck) return json({ error: "That deck is gone." }, 404);

    const body = await readBody(req);
    const name = cleanText(body.name, 40);
    if (!name) return json({ error: "A deck needs a name." }, 400);

    deck.name = name;
    await kv.set(DECKS_KEY, decks);
    return json(deck);
  }

  if (deckMatch && req.method === "DELETE") {
    const decks = await readDecks();
    if (decks.length < 2) return json({ error: "Keep at least one deck." }, 400);
    if (!decks.some((deck) => deck.id === deckMatch[1])) return json({ error: "That deck is gone." }, 404);

    // Cards go first. If this fails halfway, the deck still exists and nothing
    // is orphaned; the reverse order could strand cards in a deck that is gone.
    const { cards, versionstamp } = await readCards();
    await writeCards(cards.filter((card) => card.deck !== deckMatch[1]), versionstamp);
    await kv.set(DECKS_KEY, decks.filter((deck) => deck.id !== deckMatch[1]));
    return json({ id: deckMatch[1] });
  }

  if (url.pathname === "/api/cards" && req.method === "POST") {
    const body = await readBody(req);
    const text = cleanText(body.text);
    if (!text) return json({ error: "A card needs some text." }, 400);

    const decks = await readDecks();
    const deck = decks.some((item) => item.id === body.deck) ? body.deck as string : decks[0].id;
    const { cards, versionstamp } = await readCards();
    const card: Card = { id: crypto.randomUUID(), text, music: Boolean(body.music), deck };

    cards.push(card);
    await writeCards(cards, versionstamp);
    return json(card, 201);
  }

  if (url.pathname === "/api/cards/arrange" && req.method === "PUT") {
    const body = await readBody(req);
    const items = Array.isArray(body.items) ? body.items as { id: string; music: boolean }[] : null;
    if (!items) return json({ error: "Send the cards in their new order." }, 400);

    const { cards, versionstamp } = await readCards();
    const wanted = new Set(items.map((item) => item?.id));
    const slots: number[] = [];
    cards.forEach((card, index) => {
      if (wanted.has(card.id)) slots.push(index);
    });

    if (wanted.size !== items.length || slots.length !== items.length) {
      return json({ error: "That order does not match the deck." }, 400);
    }

    const ordered = items.map((item) => ({
      ...cards.find((entry) => entry.id === item.id)!,
      music: Boolean(item.music),
    }));
    slots.forEach((slot, index) => {
      cards[slot] = ordered[index];
    });

    await writeCards(cards, versionstamp);
    return json({ arranged: ordered.length });
  }

  if (cardMatch && req.method === "PATCH") {
    const { cards, versionstamp } = await readCards();
    const card = cards.find((entry) => entry.id === cardMatch[1]);
    if (!card) return json({ error: "That card is no longer in the deck." }, 404);

    const body = await readBody(req);
    if ("text" in body) {
      const text = cleanText(body.text);
      if (!text) return json({ error: "A card needs some text." }, 400);
      card.text = text;
    }
    if ("music" in body) card.music = Boolean(body.music);
    if ("deck" in body) {
      const decks = await readDecks();
      if (!decks.some((deck) => deck.id === body.deck)) return json({ error: "That deck is gone." }, 404);
      card.deck = body.deck as string;
    }

    await writeCards(cards, versionstamp);
    return json(card);
  }

  if (cardMatch && req.method === "DELETE") {
    const { cards, versionstamp } = await readCards();
    const next = cards.filter((card) => card.id !== cardMatch[1]);
    if (next.length === cards.length) return json({ error: "That card is no longer in the deck." }, 404);

    await writeCards(next, versionstamp);
    return json({ id: cardMatch[1] });
  }

  return json({ error: "No such route." }, 404);
}

/* Server ------------------------------------------------------------------ */

function handler(req: Request): Promise<Response> | Response {
  const url = new URL(req.url);

  if (!url.pathname.startsWith("/api/")) return serveStatic(url.pathname);

  return handleApi(req, url).catch((err) => json({ error: err.message }, 500));
}

Deno.serve({
  port: PORT,
  hostname: HOSTNAME,
  onListen: ({ hostname, port }) => console.log(`Deck running at http://${hostname}:${port}`),
}, handler);
