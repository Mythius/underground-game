import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { AccountStore } from './accounts.js';
import { SoundStore } from './sounds.js';
import { config } from './config.js';
import { RoomManager } from './game/RoomManager.js';
import { World } from './game/World.js';
import { saveMap, validateMap } from './game/mapFile.js';
import { Client } from './net/Client.js';
import { ClientMsg, ServerMsg, decodeClientMessage } from './net/protocol.js';
import { logger } from './utils/logger.js';

const MAX_VIOLATIONS = 20;

const landingPage = readFileSync(new URL('../public/index.html', import.meta.url));

const accounts = new AccountStore();
// Bank balances are saved the moment they change (guests' money isn't saved).
// Owned warehouses are saved too, in the first room (normally the only one).
const rooms = new RoomManager({ onBankChange: (account) => !account.guest && accounts.setBank(account.id, account.bank), store: accounts });
rooms.warm();
const playingAccounts = new Map(); // account id -> client, so one account can't play twice at once
const clients = new Set();

// ---- HTTP (page, map editor API, health checks) ----------------------------

// Game modules the map editor runs in the browser, so placed buildings look exactly like the game's.
const SHARED_MODULES = new Set(['/src/game/buildings.js', '/src/game/terrain.js', '/src/game/water.js', '/src/utils/math.js']);
const MAX_MAP_BYTES = 4 * 1024 * 1024;
const MAX_SOUND_BYTES = 30 * 1024 * 1024; // a few minutes of music
const sounds = new SoundStore();

function passwordMatches(given) {
  if (!config.adminPassword || typeof given !== 'string') return false;
  const hash = (s) => createHash('sha256').update(s).digest();
  return timingSafeEqual(hash(given), hash(config.adminPassword));
}

/** The raw request body as a Buffer (up to `limit` bytes). */
function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('too_large'));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('too_large'));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

let lastRandomMap = 0;

// New browser accounts per IP per minute.
const authAttempts = new Map();
function tooManyAuthAttempts(ip) {
  const now = Date.now();
  const entry = authAttempts.get(ip);
  if (!entry || entry.reset < now) {
    authAttempts.set(ip, { count: 1, reset: now + 60_000 });
    return false;
  }
  return ++entry.count > 15;
}

const bearer = (req) => (req.headers.authorization ?? '').replace(/^Bearer /, '');

const server = http.createServer(async (req, res) => {
  const json = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(landingPage);
  }
  if (req.method === 'GET' && SHARED_MODULES.has(req.url)) {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' });
    return res.end(readFileSync(new URL(`..${req.url}`, import.meta.url)));
  }
  if (req.method === 'GET' && req.url === '/map') {
    return json(200, { map: rooms.currentMap(), canSave: Boolean(config.adminPassword) });
  }
  if (req.method === 'GET' && req.url.startsWith('/map/random')) {
    // Generating takes a few hundred ms; don't let anyone hammer it.
    if (Date.now() - lastRandomMap < 2000) return json(429, { error: 'slow_down' });
    lastRandomMap = Date.now();
    // Optional ?w=&h= size; everything that's "per map" scales with the area.
    const q = new URL(req.url, 'http://x').searchParams;
    const size = (v, fallback) => Math.min(Math.max(Number(v) || fallback, 2000), 20000);
    const width = size(q.get('w'), config.world.width);
    const height = size(q.get('h'), config.world.height);
    const k = (width * height) / (config.world.width * config.world.height);
    const scaled = (n) => Math.max(1, Math.round(n * k));
    const opts = {
      ...config.world, width, height, foodCount: 0, pickupStart: 0,
      buildingCount: scaled(config.world.buildingCount), forests: scaled(config.world.forests), scatteredTrees: scaled(config.world.scatteredTrees),
      lakes: scaled(config.world.lakes), rivers: Math.max(1, Math.round(config.world.rivers * Math.sqrt(k))),
    };
    return json(200, { map: new World(opts).toMap() });
  }
  if (req.method === 'POST' && req.url === '/map') {
    if (!config.adminPassword) return json(403, { error: 'saving is disabled: set ADMIN_PASSWORD in .env' });
    if (!passwordMatches(req.headers['x-admin-password'])) {
      logger.warn('map save with wrong password', { ip: req.socket.remoteAddress });
      return json(401, { error: 'wrong password' });
    }
    let body;
    try {
      body = JSON.parse(await readBody(req, MAX_MAP_BYTES));
    } catch (err) {
      return json(400, { error: err.message === 'too_large' ? 'map is too big' : 'not valid JSON' });
    }
    const { map, error } = validateMap(body);
    if (error) return json(400, { error });
    saveMap(map);
    rooms.applyMap(map);
    logger.info('map saved', { buildings: map.buildings.length, trees: map.trees.length, ip: req.socket.remoteAddress });
    return json(200, { ok: true });
  }
  // ---- sound editor: list, serve, upload (admin), volume (admin), reset (admin) ----
  if (req.method === 'GET' && req.url === '/sounds') return json(200, { ...sounds.list(), canSave: Boolean(config.adminPassword) });
  if (req.method === 'GET' && req.url.startsWith('/sounds/file/')) {
    const file = sounds.read(decodeURIComponent(req.url.slice('/sounds/file/'.length).split('?')[0]));
    if (!file) return json(404, { error: 'not_found' });
    res.writeHead(200, { 'content-type': file.type, 'cache-control': 'public, max-age=31536000, immutable' }); // the URL has a version
    return res.end(file.data);
  }
  const soundRoute = req.url.match(/^\/sounds\/([A-Za-z]+)(\/volume)?$/);
  if (soundRoute && (req.method === 'POST' || req.method === 'DELETE')) {
    if (!config.adminPassword) return json(403, { error: 'saving is disabled: set ADMIN_PASSWORD in .env' });
    if (!passwordMatches(req.headers['x-admin-password'])) {
      logger.warn('sound edit with wrong password', { ip: req.socket.remoteAddress });
      return json(401, { error: 'wrong password' });
    }
    const [, slot, volume] = soundRoute;
    let error;
    try {
      if (req.method === 'DELETE') error = sounds.reset(slot);
      else if (volume) error = sounds.setVolume(slot, JSON.parse(await readBody(req, 1000)).volume);
      else error = sounds.upload(slot, req.headers['content-type'], await readRaw(req, MAX_SOUND_BYTES));
    } catch (err) {
      error = err.message === 'too_large' ? `file is too big (max ${MAX_SOUND_BYTES / 1e6} MB)` : 'bad request';
    }
    if (error) return json(400, { error });
    logger.info('sound changed', { slot, action: req.method === 'DELETE' ? 'reset' : volume ? 'volume' : 'upload' });
    rooms.broadcastAll({ t: ServerMsg.SOUNDS_CHANGED }); // everyone playing picks it up right away
    return json(200, { ok: true, ...sounds.list() });
  }
  if (req.method === 'POST' && req.url === '/auth/device') {
    // A first-time browser asks for its own account; limited per IP so nobody can mint thousands.
    if (tooManyAuthAttempts(req.socket.remoteAddress)) return json(429, { error: 'Too many tries — wait a minute' });
    return json(200, accounts.createDeviceAccount());
  }
  if (req.method === 'GET' && req.url === '/auth/me') {
    const account = accounts.accountForToken(bearer(req));
    return account ? json(200, { account }) : json(401, { error: 'not logged in' });
  }
  if (req.url === '/health') return json(200, { ok: true });
  if (req.url === '/stats') {
    return json(200, {
      uptimeSec: Math.round(process.uptime()),
      connections: clients.size,
      memoryMb: Math.round(process.memoryUsage().rss / 1e6),
      rooms: rooms.stats(),
    });
  }
  json(404, { error: 'not_found' });
});

// ---- WebSocket -----------------------------------------------------------

const wss = new WebSocketServer({
  server,
  maxPayload: config.net.maxPayloadBytes,
  perMessageDeflate: false, // CPU cost isn't worth it for small, frequent frames
  verifyClient: ({ origin }, done) => {
    if (!config.allowedOrigins || config.allowedOrigins.includes(origin)) return done(true);
    logger.warn('rejected origin', { origin });
    done(false, 403, 'Forbidden');
  },
});

wss.on('connection', (ws, req) => {
  const client = new Client(ws, req.socket.remoteAddress);
  clients.add(client);
  rooms.join(client);
  logger.info('client connected', { client: client.id, ip: client.remoteAddress, room: client.room?.id });

  ws.on('pong', () => {
    client.isAlive = true;
  });

  ws.on('message', (data, isBinary) => {
    if (isBinary) return penalize(client, 'binary_not_supported');
    if (!client.rateLimiter.tryConsume()) return penalize(client, 'rate_limited');

    const result = decodeClientMessage(data.toString());
    if (!result.ok) return penalize(client, result.error);
    handleMessage(client, result.msg);
  });

  ws.on('close', (code) => {
    if (client.account?.id && playingAccounts.get(client.account.id) === client) playingAccounts.delete(client.account.id);
    rooms.leave(client);
    clients.delete(client);
    logger.info('client disconnected', { client: client.id, code });
  });

  ws.on('error', (err) => logger.warn('socket error', { client: client.id, err: err.message }));
});

function handleMessage(client, msg) {
  switch (msg.t) {
    case ClientMsg.JOIN: {
      // First join on this connection decides the account: logged in (token) or a guest.
      if (!client.account) {
        if (msg.token) {
          const account = accounts.accountForToken(msg.token);
          if (!account) return client.send({ t: ServerMsg.ERROR, code: 'session_expired' });
          const other = playingAccounts.get(account.id);
          if (other && other !== client && other.isOpen) return client.send({ t: ServerMsg.ERROR, code: 'already_playing' });
          playingAccounts.set(account.id, client);
          client.account = accounts.live(account.id); // shared: warehouse taxes change it while they're away
        } else {
          client.account = { id: null, name: msg.name, bank: config.accounts.startingBank, guest: true };
        }
      }
      client.room?.spawn(client, msg.name, msg.look);
      break;
    }
    case ClientMsg.BANK:
      client.room?.bank(client, msg.action, msg.amount);
      break;
    case ClientMsg.INSPECT:
      client.room?.inspect(client, msg.id);
      break;
    case ClientMsg.TRADE:
    case ClientMsg.FACTORY:
    case ClientMsg.WAREHOUSE:
    case ClientMsg.WORK:
    case ClientMsg.REFUEL:
    case ClientMsg.BUY_GUN:
    case ClientMsg.BUY_CAR:
    case ClientMsg.JOB:
      client.room?.economyAction(client, msg);
      break;
    case ClientMsg.DROP:
    case ClientMsg.LIGHTS:
    case ClientMsg.TRUNK:
      client.room?.inventoryAction(client, msg);
      break;
    case ClientMsg.PICKPOCKET:
    case ClientMsg.BRIBE:
      client.room?.crimeAction(client, msg);
      break;
    case ClientMsg.TRAIN:
      client.room?.trainAction(client, msg);
      break;
    case ClientMsg.BODY:
      client.room?.bodyAction(client, msg);
      break;
    case ClientMsg.INPUT:
      client.room?.handleInput(client, msg);
      break;
    case ClientMsg.BUY:
      client.room?.buy(client, msg.item);
      break;
    case ClientMsg.CHAT:
      client.room?.chat(client, msg.text);
      break;
    case ClientMsg.PING:
      client.send({ t: ServerMsg.PONG, ts: msg.ts, serverTime: Date.now() });
      break;
  }
}

function penalize(client, code) {
  client.violations++;
  if (client.violations === 1 || client.violations % 10 === 0) {
    logger.warn('client violation', { client: client.id, code, count: client.violations });
  }
  if (code !== 'rate_limited') client.send({ t: ServerMsg.ERROR, code });
  if (client.violations >= MAX_VIOLATIONS) client.close(1008, 'policy_violation');
}

// Terminate sockets that stop answering pings (dead TCP connections).
const heartbeat = setInterval(() => {
  for (const client of clients) {
    if (!client.isAlive) {
      client.ws.terminate();
      continue;
    }
    client.isAlive = false;
    client.ws.ping();
  }
}, config.net.heartbeatIntervalMs);

// ---- startup / shutdown --------------------------------------------------

server.listen(config.port, config.host, () => {
  logger.info('server listening', { host: config.host, port: config.port, tickRate: config.tickRate });
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('shutting down', { signal });
  clearInterval(heartbeat);
  rooms.stopAll();
  for (const client of clients) client.close(1001, 'server_shutdown');
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
