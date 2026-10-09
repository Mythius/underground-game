import { config } from '../config.js';

// Every message is a JSON object with a `t` (type) field.

export const ClientMsg = Object.freeze({
  JOIN: 'join', // { t, name, look: { skin, shirt, pants, hat }, token? } -> spawn or respawn (token = logged-in session)
  INPUT: 'input', // { t, seq, angle, throttle, boost (sprint), aim, fire, reload, use (E: doors/vehicles), slot, gas, steer, drift, rob (F held) }
  PING: 'ping', // { t, ts }
  CHAT: 'chat', // { t, text }
  BUY: 'buy', // { t, item } from a shopkeeper you're standing next to
  BANK: 'bank', // { t, action: 'deposit' | 'withdraw', amount } at an ATM or bank teller
  INSPECT: 'inspect', // { t, id } -> PLACE: what a market or factory (by building id) has
  TRADE: 'trade', // { t, id, good, qty, side: 'buy' | 'sell' | 'under' (contraband over a shop counter) } at a market
  FACTORY: 'factory', // { t, id, action: 'process' } toll processing at a city factory
  WAREHOUSE: 'wh', // { t, id, action: 'buy' | 'sell' | 'place' | 'remove' | 'rotate' | 'configure' | 'load' | 'take' | 'mload' (hotbar slot -> machine at x,y) | 'mtake' (machine's 'in'/'out' slot -> cargo, via dock), kind?, x?, y?, dir?, value?, slot?, dock? }
  REFUEL: 'refuel', // { t } fill your car at a gas station
  DROP: 'drop', // { t, slot? } Q (the selected hotbar slot) or dragging a slot out of the hotbar
  BUY_GUN: 'buygun', // { t, id, type } at a gun store (cash)
  BUY_CAR: 'buycar', // { t, id, type } at a car dealership (bank)
  PICKPOCKET: 'pickpocket', // { t } F: lift cash from the nearest person
  JOB: 'job', // { t, action: 'list' | 'accept' | 'pickup' | 'deliver' | 'abandon', id? } delivery jobs
  TRAIN: 'train', // { t, action: 'deliver' (contract, at the freight clerk) | 'black' (contraband, back door), good, qty }
  BRIBE: 'bribe', // { t } pay off the Militsiya at a roadblock
  LIGHTS: 'lights', // { t } C: toggle your car's headlights
  WORK: 'work', // { t, id, action: 'tool' | 'haul' | 'buy' | 'sell' } at a work site's foreman
  BODY: 'body', // { t, action: 'open' | 'loot' | 'carry' | 'drop', id?, slot? } (drop: the body you carry — into a dumpster, water, under a tree, or down)
  TRUNK: 'trunk', // { t, id, action: 'open' | 'take' | 'put', slot } a vehicle's trunk
});

export const ServerMsg = Object.freeze({
  WELCOME: 'welcome', // { t, clientId, roomId, world, tickRate, snapshotRate, buildings, doorReach, vehicles, env, rainGrip, shop, terrain, player, weapons }
  SPAWNED: 'spawned', // { t, playerId, account (account name, null for guests), players: [{id,name,color,look}] }
  PLAYER_JOINED: 'player_joined', // { t, id, name, color, look }
  PLAYER_LEFT: 'player_left', // { t, id }
  SNAPSHOT: 'snapshot', // { t, tick, ack, you: {id,x,y,mass,stamina,cash,bank,trunk: [vehicleId, type, slots] | null,job: {id,good,qty,from,to,reward,picked,secondsLeft} | null,wanted,jail (s left),rob: [kind, 0–1] | null,arrest (0–1),slot,car: [x,y,angle,vx,vy,id,type,fuel],inv: [[gun, ammo, reload] | ['goods', good, qty] | null]}, players: [[id,x,y,r,health,aim,weapon,maxHealth]], food, pickups: [[id,x,y,gunType] | [id,x,y,'cash',amount] | [id,x,y,'goods',good,qty]], vehicles: [[id,type,x,y,angle,driverId,health,color,slipping,ownerName,siren,lights]], npcs: [[id,x,y,angle]] (townsfolk), cops: [[id,x,y,angle]] (officers on foot); vehicles[10] = siren, bullets: [[id,x,y,weapon]] }
  DIED: 'died', // { t, killedBy, score }
  LEADERBOARD: 'leaderboard', // { t, entries: [{name, score}] }
  PONG: 'pong', // { t, ts, serverTime }
  CHAT: 'chat', // { t, id, name, color, text }
  DOOR: 'door', // { t, id, open }
  BOOM: 'boom', // { t, x, y } a vehicle exploded
  BOUGHT: 'bought', // { t, item, cash }
  BANKED: 'banked', // { t, action, amount, cash, bank }
  PLACE: 'place', // { t, ...economy.describe() } a market's prices or a factory's state
  OWNERS: 'owners', // { t, list: [[buildingId, ownerName | null]] } who owns each warehouse
  WAREHOUSE: 'wh', // { t, layout } a warehouse's pieces changed (see Warehouse.layout())
  WH_LIVE: 'whlive', // { t, list: [Warehouse.live()] } belt items, machines and docks in warehouses near you
  JOBS: 'jobs', // { t, mine, offers } the job board
  POLICE: 'police', // { t, kind: 'busted' | 'released' | 'robbed' | 'pickpocketed' | 'crime' | 'stole', … } things that happened to you
  DONE: 'done', // { t, what, ... } a trade, factory action or refuel went through (process: batches, fee)
  TRAIN: 'train', // { t, x, speed, state, nextIn } the freight train (a few times a second)
  NODES: 'nodes', // { t, list: [[id, hp]] } rocks / trees / wheat worked or grown back
  BODY: 'body', // { t, id, kind, name, cash, items } what's on a body you're looking at
  NEWS: 'news', // { t, kind: 'raid', building } something everyone hears about
  SOUNDS_CHANGED: 'sounds_changed', // { t } the sound editor changed a sound; fetch GET /sounds again
  MAP_CHANGED: 'map_changed', // { t } the admin saved a new map; back to the menu (a new welcome follows)
  ENV: 'env', // { t, clock, daySec, nightSec, rain, fog } every couple of seconds
  ERROR: 'error', // { t, code, message }
});

const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);

function sanitizeName(name) {
  if (typeof name !== 'string') return 'Player';
  // Strip control characters and collapse whitespace.
  const clean = name.replace(/[\p{C}]/gu, '').replace(/\s+/g, ' ').trim();
  return clean.slice(0, config.player.nameMaxLength) || 'Player';
}

/** Each part must be a valid index into its list; anything else falls back to a random choice. */
function sanitizeLook(look) {
  const pick = (value, list) => (Number.isInteger(value) && value >= 0 && value < list.length ? value : Math.floor(Math.random() * list.length));
  const { skins, shirts, pants, hats } = config.looks;
  const l = look && typeof look === 'object' ? look : {};
  return { skin: pick(l.skin, skins), shirt: pick(l.shirt, shirts), pants: pick(l.pants, pants), hat: pick(l.hat, hats) };
}

const validators = {
  [ClientMsg.JOIN]: (m) => ({
    t: m.t,
    name: sanitizeName(m.name),
    look: sanitizeLook(m.look),
    token: typeof m.token === 'string' && m.token.length <= 100 ? m.token : null,
  }),

  [ClientMsg.INPUT]: (m) => {
    if (!Number.isInteger(m.seq) || m.seq < 0) return null;
    if (!isFiniteNumber(m.angle)) return null;
    const throttle = isFiniteNumber(m.throttle) ? Math.min(Math.max(m.throttle, 0), 1) : 1;
    const aim = isFiniteNumber(m.aim) ? m.aim : m.angle;
    const unit = (v) => (isFiniteNumber(v) ? Math.min(Math.max(v, -1), 1) : 0);
    const slot = Number.isInteger(m.slot) && m.slot >= 0 && m.slot < config.player.inventorySize ? m.slot : null;
    return { t: m.t, seq: m.seq, angle: m.angle, throttle, boost: m.boost === true, aim, fire: m.fire === true, reload: m.reload === true, use: m.use === true, slot, gas: unit(m.gas), steer: unit(m.steer), drift: m.drift === true, rob: m.rob === true };
  },

  [ClientMsg.CHAT]: (m) => {
    if (typeof m.text !== 'string') return null;
    const text = m.text.replace(/[\p{C}]/gu, '').replace(/\s+/g, ' ').trim().slice(0, config.net.chatMaxLength);
    return text ? { t: m.t, text } : null;
  },

  [ClientMsg.BUY]: (m) => (typeof m.item === 'string' && Object.hasOwn(config.economy.menu, m.item) ? { t: m.t, item: m.item } : null),

  [ClientMsg.BANK]: (m) =>
    (m.action === 'deposit' || m.action === 'withdraw') && Number.isInteger(m.amount) && m.amount > 0 && m.amount <= 1e9
      ? { t: m.t, action: m.action, amount: m.amount }
      : null,

  [ClientMsg.INSPECT]: (m) => (Number.isInteger(m.id) ? { t: m.t, id: m.id } : null),

  [ClientMsg.TRADE]: (m) =>
    Number.isInteger(m.id) && typeof m.good === 'string' && Object.hasOwn(config.goods, m.good) && Number.isInteger(m.qty) && m.qty > 0 && m.qty <= 1000 && ['buy', 'sell', 'under'].includes(m.side)
      ? { t: m.t, id: m.id, good: m.good, qty: m.qty, side: m.side }
      : null,

  [ClientMsg.FACTORY]: (m) => (Number.isInteger(m.id) && m.action === 'process' ? { t: m.t, id: m.id, action: m.action } : null),

  [ClientMsg.WAREHOUSE]: (m) => {
    if (!Number.isInteger(m.id) || !['buy', 'sell', 'place', 'remove', 'rotate', 'configure', 'load', 'take', 'mload', 'mtake', 'chop'].includes(m.action)) return null;
    const tile = (v) => Number.isInteger(v) && v >= 0 && v < 64;
    if (['place', 'remove', 'rotate', 'configure', 'mload', 'mtake'].includes(m.action) && !(tile(m.x) && tile(m.y))) return null;
    if (m.action === 'mload' && !(Number.isInteger(m.slot) && m.slot >= 0 && m.slot < 64)) return null;
    if (m.action === 'place' && !(typeof m.kind === 'string' && (Object.hasOwn(config.machines, m.kind) || Object.hasOwn(config.belts, m.kind)) && [0, 1, 2, 3].includes(m.dir))) return null;
    if (m.action === 'configure' && !(typeof m.value === 'string' && m.value.length < 40)) return null;
    return { t: m.t, id: m.id, action: m.action, kind: m.kind, x: m.x, y: m.y, dir: m.dir, value: m.value, slot: m.slot, dock: m.dock === 'in' ? 'in' : 'out' };
  },

  [ClientMsg.REFUEL]: (m) => ({ t: m.t }),

  [ClientMsg.DROP]: (m) => (m.slot === undefined ? { t: m.t } : Number.isInteger(m.slot) && m.slot >= 0 && m.slot < 64 ? { t: m.t, slot: m.slot } : null),

  [ClientMsg.PICKPOCKET]: (m) => ({ t: m.t }),

  [ClientMsg.BUY_GUN]: (m) => (Number.isInteger(m.id) && Object.hasOwn(config.gunstore.guns, m.type) ? { t: m.t, id: m.id, type: m.type } : null),

  [ClientMsg.BUY_CAR]: (m) => (Number.isInteger(m.id) && Object.hasOwn(config.dealership.vehicles, m.type) ? { t: m.t, id: m.id, type: m.type } : null),

  [ClientMsg.JOB]: (m) =>
    ['list', 'accept', 'pickup', 'deliver', 'abandon'].includes(m.action) && (m.action !== 'accept' || Number.isInteger(m.id))
      ? { t: m.t, action: m.action, id: m.id ?? 0 }
      : null,

  [ClientMsg.TRUNK]: (m) =>
    Number.isInteger(m.id) && ['open', 'take', 'put'].includes(m.action) && (m.action === 'open' || (Number.isInteger(m.slot) && m.slot >= 0 && m.slot < 64))
      ? { t: m.t, id: m.id, action: m.action, slot: m.slot ?? 0 }
      : null,

  [ClientMsg.TRAIN]: (m) =>
    ['deliver', 'black'].includes(m.action) && typeof m.good === 'string' && Object.hasOwn(config.goods, m.good) && Number.isInteger(m.qty) && m.qty > 0 && m.qty <= 10000
      ? { t: m.t, action: m.action, good: m.good, qty: m.qty }
      : null,

  [ClientMsg.BRIBE]: (m) => ({ t: m.t }),

  [ClientMsg.LIGHTS]: (m) => ({ t: m.t }),

  [ClientMsg.WORK]: (m) => (Number.isInteger(m.id) && ['tool', 'haul', 'buy', 'sell'].includes(m.action) ? { t: m.t, id: m.id, action: m.action } : null),

  [ClientMsg.BODY]: (m) =>
    ['open', 'loot', 'carry', 'drop'].includes(m.action) && (m.action === 'drop' || Number.isInteger(m.id)) && (m.action !== 'loot' || (Number.isInteger(m.slot) && m.slot >= -1 && m.slot < 64))
      ? { t: m.t, action: m.action, id: m.id ?? 0, slot: m.slot ?? 0 }
      : null,

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
