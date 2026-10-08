import { readFileSync } from 'node:fs';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { config } from './config.js';
import { RoomManager } from './game/RoomManager.js';
import { Client } from './net/Client.js';
import { ClientMsg, ServerMsg, decodeClientMessage } from './net/protocol.js';
import { logger } from './utils/logger.js';

const MAX_VIOLATIONS = 20;

const landingPage = readFileSync(new URL('../public/index.html', import.meta.url));

const rooms = new RoomManager();
const clients = new Set();

// ---- HTTP (health checks / ops) ------------------------------------------

const server = http.createServer((req, res) => {
  const json = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(landingPage);
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
    rooms.leave(client);
    clients.delete(client);
    logger.info('client disconnected', { client: client.id, code });
  });

  ws.on('error', (err) => logger.warn('socket error', { client: client.id, err: err.message }));
});

function handleMessage(client, msg) {
  switch (msg.t) {
    case ClientMsg.JOIN:
      client.room?.spawn(client, msg.name);
      break;
    case ClientMsg.INPUT:
      client.room?.handleInput(client, msg);
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
