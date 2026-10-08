import { config } from '../config.js';

// Every message is a JSON object with a `t` (type) field.

export const ClientMsg = Object.freeze({
  JOIN: 'join', // { t, name }           -> spawn (or respawn) a player
  INPUT: 'input', // { t, seq, angle, throttle, boost }
  PING: 'ping', // { t, ts }
});

export const ServerMsg = Object.freeze({
  WELCOME: 'welcome', // { t, clientId, roomId, world, tickRate, snapshotRate }
  SPAWNED: 'spawned', // { t, playerId, players: [{id,name,color}] }
  PLAYER_JOINED: 'player_joined', // { t, id, name, color }
  PLAYER_LEFT: 'player_left', // { t, id }
  SNAPSHOT: 'snapshot', // { t, tick, ack, you, players: [[id,x,y,r]], food: [[id,x,y]] }
  DIED: 'died', // { t, killedBy, score }
  LEADERBOARD: 'leaderboard', // { t, entries: [{name, score}] }
  PONG: 'pong', // { t, ts, serverTime }
  ERROR: 'error', // { t, code, message }
});

const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);

function sanitizeName(name) {
  if (typeof name !== 'string') return 'Player';
  // Strip control characters and collapse whitespace.
  const clean = name.replace(/[\p{C}]/gu, '').replace(/\s+/g, ' ').trim();
  return clean.slice(0, config.player.nameMaxLength) || 'Player';
}

const validators = {
  [ClientMsg.JOIN]: (m) => ({ t: m.t, name: sanitizeName(m.name) }),

  [ClientMsg.INPUT]: (m) => {
    if (!Number.isInteger(m.seq) || m.seq < 0) return null;
    if (!isFiniteNumber(m.angle)) return null;
    const throttle = isFiniteNumber(m.throttle) ? Math.min(Math.max(m.throttle, 0), 1) : 1;
    return { t: m.t, seq: m.seq, angle: m.angle, throttle, boost: m.boost === true };
  },

  [ClientMsg.PING]: (m) => (isFiniteNumber(m.ts) ? { t: m.t, ts: m.ts } : null),
};

/**
 * Parse and validate a raw client frame.
 * @returns {{ ok: true, msg: object } | { ok: false, error: string }}
 */
export function decodeClientMessage(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'invalid_json' };
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, error: 'invalid_shape' };
  }
  const validate = validators[data.t];
  if (!validate) return { ok: false, error: 'unknown_type' };
  const msg = validate(data);
  return msg ? { ok: true, msg } : { ok: false, error: 'invalid_payload' };
}

export const encode = (msg) => JSON.stringify(msg);
