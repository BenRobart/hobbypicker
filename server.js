import http from 'node:http';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleApi } from './core.js';

const PORT = Number(process.env.PORT) || 4173;
const ROOT = path.dirname(fileURLToPath(import.meta.url));

const FILES = {
  cards: path.join(ROOT, 'cards.json'),
  decks: path.join(ROOT, 'decks.json'),
  columns: path.join(ROOT, 'columns.json'),
  settings: path.join(ROOT, 'settings.json'),
};

// Serve from public/ when it is there, otherwise from alongside server.js.
const PUBLIC_DIR = existsSync(path.join(ROOT, 'public', 'index.html'))
  ? path.join(ROOT, 'public')
  : ROOT;

const PRIVATE_FILES = new Set(
  ['server.js', 'core.js', 'main.js', 'package.json', ...Object.keys(FILES).map((k) => `${k}.json`)]
    .flatMap((name) => [name, `${name}.tmp`, `${name}.bak`]),
);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const store = {
  // Reading never writes. A missing file is nothing at all; a file that cannot
  // be parsed is an error, so it can never be replaced by a fresh one.
  async read(name) {
    let raw;
    try {
      raw = await fs.readFile(FILES[name], 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }

    try {
      return JSON.parse(raw);
    } catch {
      throw new Error(`${name}.json is not valid JSON. Nothing has been changed.`);
    }
  },

  // Write to a temp file and keep the previous version as a .bak, so a crash or
  // a bad write always leaves one intact copy behind.
  async write(name, value) {
    const file = FILES[name];
    await fs.writeFile(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`, 'utf8');

    try {
      await fs.copyFile(file, `${file}.bak`);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }

    await fs.rename(`${file}.tmp`, file);
  },
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
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

async function serveStatic(req, res, url) {
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url);

  try {
    const { status, body } = await handleApi({
      method: req.method,
      pathname: url.pathname,
      body: await readBody(req),
      store,
    });
    sendJson(res, status, body);
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Deck running at http://localhost:${PORT}`);
  console.log(`Cards stored in ${FILES.cards}`);
});
