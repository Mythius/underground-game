import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { BUILDING_TYPES } from './buildings.js';

// A map file describes everything placeable; doors, paths and bridge rails are derived from it.
//   { version: 1, width, height,
//     roads: [{x,y,w,h}], rivers: [{points:[[x,y]...], width}], lakes: [{x,y,r}], trails: [{points, width}] (dirt paths),
//     buildings: [{type,x,y,rot}], trees: [{x,y,canopy}], forests: [{x,y,r}], lamps: [{x,y}],
//     vehicles: [{type,x,y,angle}], npcs: [{x,y,angle}], atms: [{x,y,angle}] }

export const MAP_PATH = fileURLToPath(new URL('../../data/map.json', import.meta.url));

const LIMITS = { roads: 120, rivers: 12, riverPoints: 600, trails: 400, trailPoints: 200, lakes: 60, buildings: 800, trees: 15000, forests: 800, lamps: 3000, vehicles: 500, npcs: 150, atms: 300, lots: 200 };
const MIN_SIZE = 2000;
const MAX_SIZE = 30000;

/** Checks a map from the editor. Returns { map } with only known fields, or { error }. */
export function validateMap(input) {
  try {
    return { map: clean(input) };
  } catch (err) {
    return { error: err.message };
  }
}

function clean(m) {
  const fail = (msg) => {
    throw new Error(msg);
  };
  if (!m || typeof m !== 'object') fail('map must be an object');
  const num = (v, lo, hi, what) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) fail(`${what} must be a number from ${lo} to ${hi}`);
    return Math.round(v * 100) / 100;
  };
  const list = (v, max, what) => {
    if (v === undefined) return [];
    if (!Array.isArray(v)) fail(`${what} must be a list`);
    if (v.length > max) fail(`too many ${what} (max ${max})`);
    return v;
  };

  const width = num(m.width, MIN_SIZE, MAX_SIZE, 'width');
  const height = num(m.height, MIN_SIZE, MAX_SIZE, 'height');
  const X = (v, what) => num(v, 0, width, what);
  const Y = (v, what) => num(v, 0, height, what);
  const angle = (v) => num(v ?? 0, -100, 100, 'angle');

  return {
    version: 1,
    width,
    height,
    roads: list(m.roads, LIMITS.roads, 'roads').map((r) => {
      const x = X(r.x, 'road x');
      const y = Y(r.y, 'road y');
      return { x, y, w: num(r.w, 60, width - x, 'road width'), h: num(r.h, 60, height - y, 'road height') };
    }),
    rivers: list(m.rivers, LIMITS.rivers, 'rivers').map((river) => ({
      // Rivers may start and end just off the map edge.
      points: list(river.points, LIMITS.riverPoints, 'river points').map((p) => {
        if (!Array.isArray(p)) fail('river points must be [x, y]');
        return [num(p[0], -600, width + 600, 'river x'), num(p[1], -600, height + 600, 'river y')];
      }),
      width: num(river.width, 40, 800, 'river width'),
    })).filter((r) => r.points.length >= 2),
    trails: list(m.trails, LIMITS.trails, 'trails').map((trail) => ({
      points: list(trail.points, LIMITS.trailPoints, 'trail points').map((p) => {
        if (!Array.isArray(p)) fail('trail points must be [x, y]');
        return [num(p[0], -100, width + 100, 'trail x'), num(p[1], -100, height + 100, 'trail y')];
      }),
      width: num(trail.width, 16, 200, 'trail width'),
    })).filter((t) => t.points.length >= 2),
    lakes: list(m.lakes, LIMITS.lakes, 'lakes').map((l) => ({ x: X(l.x, 'lake x'), y: Y(l.y, 'lake y'), r: num(l.r, 40, 2000, 'lake radius') })),
    buildings: list(m.buildings, LIMITS.buildings, 'buildings').map((b) => {
      if (!Object.hasOwn(BUILDING_TYPES, b.type)) fail(`unknown building type ${b.type}`);
      // Work sites carry their own size (they fill a block).
      const size = b.size ? { w: num(b.size.w, 400, 5000, 'site width'), h: num(b.size.h, 400, 5000, 'site height') } : null;
      return { type: b.type, x: X(b.x, 'building x'), y: Y(b.y, 'building y'), rot: num(b.rot ?? 0, 0, 3, 'building rotation') | 0, ...(size ? { size } : {}) };
    }),
    trees: list(m.trees, LIMITS.trees, 'trees').map((t) => ({ x: X(t.x, 'tree x'), y: Y(t.y, 'tree y'), canopy: num(t.canopy ?? 60, 20, 200, 'canopy') })),
    forests: list(m.forests, LIMITS.forests, 'forests').map((f) => ({ x: X(f.x, 'forest x'), y: Y(f.y, 'forest y'), r: num(f.r, 50, 3000, 'forest radius') })),
    lamps: list(m.lamps, LIMITS.lamps, 'lamps').map((l) => ({ x: X(l.x, 'lamp x'), y: Y(l.y, 'lamp y') })),
    vehicles: list(m.vehicles, LIMITS.vehicles, 'vehicles').map((v) => {
      if (!Object.hasOwn(config.vehicles.types, v.type)) fail(`unknown vehicle type ${v.type}`);
      return { type: v.type, x: X(v.x, 'vehicle x'), y: Y(v.y, 'vehicle y'), angle: angle(v.angle) };
    }),
    npcs: list(m.npcs, LIMITS.npcs, 'npcs').map((n) => ({ x: X(n.x, 'npc x'), y: Y(n.y, 'npc y'), angle: angle(n.angle) })),
    atms: list(m.atms, LIMITS.atms, 'atms').map((a) => ({ x: X(a.x, 'atm x'), y: Y(a.y, 'atm y'), angle: angle(a.angle) })),
    // The town (asphalt + sidewalks inside, gravel outside); maps without one are asphalt everywhere.
    ...(m.city ? { city: { x: X(m.city.x, 'city x'), y: Y(m.city.y, 'city y'), w: num(m.city.w, 500, width, 'city width'), h: num(m.city.h, 500, height, 'city height') } } : {}),
    // The railway's centre line (y); maps without one have no train.
    ...(m.railway ? { railway: { y: Y(m.railway.y, 'railway y') } } : {}),
    // Parking lots; maps saved before lots existed leave this out and get them generated.
    ...(m.lots === undefined ? {} : {
      lots: list(m.lots, LIMITS.lots, 'lots').map((l) => ({
        x: X(l.x, 'lot x'), y: Y(l.y, 'lot y'), w: num(l.w, 60, 2000, 'lot width'), h: num(l.h, 60, 2000, 'lot height'),
        horizontal: Boolean(l.horizontal), side: l.side < 0 ? -1 : 1,
        ...(Number.isInteger(l.building) && l.building > 0 ? { building: l.building } : {}), // a business's own parking
      })),
    }),
  };
}

/** The saved live map, or null if none has been saved (or it can't be read). */
export function loadSavedMap(path = MAP_PATH) {
  try {
    const { map } = validateMap(JSON.parse(readFileSync(path, 'utf8')));
    return map ?? null;
  } catch {
    return null;
  }
}

/** Writes atomically so a crash mid-save can't leave a half-written map. */
export function saveMap(map, path = MAP_PATH) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(map));
  renameSync(`${path}.tmp`, path);
}
