import { buildBuilding, BUILDING_TYPES } from './buildings.js';
import { randRange } from '../utils/math.js';
import { makeLot } from './parking.js';

// Town planning: a city in the middle (asphalt streets with sidewalks) and countryside around it
// (gravel roads). Every building fronts onto a road with its main door facing it — close in the city,
// anywhere from close to well back in the country (a gravel path leads up to the door). Businesses and
// warehouses get a few parking spaces beside them. Shacks hide in the woods, far from any road.

export const SIDEWALK = 40;

/** Building types that belong in the city; everything else goes in the countryside. */
export const CITY_TYPES = new Set(['shop', 'kiosk', 'bar', 'bank', 'police', 'market', 'gunstore', 'dealership', 'panelka', 'office', 'church', 'garages', 'house', 'garage']);
/** Types that get parking spaces of their own. */
export const BUSINESS_TYPES = new Set([
  'shop', 'kiosk', 'bank', 'police', 'market', 'gunstore', 'dealership', 'office', 'gas',
  'logging', 'farm', 'mine', 'oilwell', 'scrapyard', 'quarry', 'smallwarehouse', 'warehouse', 'bigwarehouse',
  'sawmill', 'furniture', 'flourmill', 'bakery', 'foundry', 'machineshop', 'refinery', 'glassworks', 'carfactory', 'gunfactory',
]);

/** The city: a square of `size` in the middle of the map. */
export const cityBox = (width, height, size) => ({ x: Math.round(width / 2 - size / 2), y: Math.round(height / 2 - size / 2), w: size, h: size });
export const inBox = (box, x, y) => Boolean(box) && x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h;

/** Is (x, y) on an asphalt (city) road? Everywhere else — gravel roads, grass, snow — has less grip. */
export function onAsphalt(roads, city, x, y) {
  if (city && !inBox(city, x, y)) return false;
  return roads.some((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h);
}

/**
 * Roads: long country roads across the whole map every ~2200 (gravel outside the city), plus a ring
 * road round the city and a tighter grid of city streets inside it.
 */
export function generateTownRoads(width, height, city, { mainWidth = 270, streetWidth = 220, spacing = 2200, streetSpacing = 900 } = {}) {
  const roads = [];
  const across = (size) => {
    const n = Math.max(2, Math.round(size / spacing));
    return Array.from({ length: n }, (_, k) => Math.round(((k + 0.5) / n + randRange(-0.12, 0.12) / n) * size - mainWidth / 2));
  };
  for (const y of across(height)) roads.push({ x: 0, y, w: width, h: mainWidth });
  for (const x of across(width)) roads.push({ x, y: 0, w: mainWidth, h: height });
  if (!city) return roads;
  const main = [...roads];
  const clear = (r, gap) => !main.concat(roads).some((o) => (o.w > o.h) === (r.w > r.h) && (r.w > r.h ? Math.abs(o.y - r.y) < gap : Math.abs(o.x - r.x) < gap));
  // Ring road (streets end on it, so every street has a junction at both ends).
  const { x, y, w, h } = city;
  // (Inside the city box, so the whole town — ring included — is asphalt.)
  const ring = [
    { x, y, w, h: streetWidth },
    { x, y: y + h - streetWidth, w, h: streetWidth },
    { x, y, w: streetWidth, h },
    { x: x + w - streetWidth, y, w: streetWidth, h },
  ];
  for (const r of ring) if (clear(r, 500)) roads.push(r);
  // Streets between the ring roads, skipping any too close to a road already there.
  for (let sy = y + streetSpacing; sy < y + h - streetSpacing / 2; sy += streetSpacing) {
    const r = { x, y: Math.round(sy + randRange(-60, 60)), w, h: streetWidth };
    if (clear(r, 560)) roads.push(r);
  }
  for (let sx = x + streetSpacing; sx < x + w - streetSpacing / 2; sx += streetSpacing) {
    const r = { x: Math.round(sx + randRange(-60, 60)), y, w: streetWidth, h };
    if (clear(r, 560)) roads.push(r);
  }
  return roads;
}

/**
 * Work sites (mine, lumberyards, farms, oil fields), each filling a whole country block between the
 * long gravel roads, its gate facing one of them. `counts`: { type: n }. Returns the buildings.
 */
export function placeSites({ width, height, roads, city, counts, avoid = [], isWet = () => false }) {
  const horizontal = roads.filter((r) => r.w >= width - 1).sort((a, b) => a.y - b.y);
  const vertical = roads.filter((r) => r.h >= height - 1).sort((a, b) => a.x - b.x);
  const M = 70; // keep off the roads
  const blocks = [];
  for (let i = 0; i + 1 < vertical.length; i++) {
    for (let j = 0; j + 1 < horizontal.length; j++) {
      const b = { x: vertical[i].x + vertical[i].w + M, y: horizontal[j].y + horizontal[j].h + M, w: 0, h: 0 };
      b.w = vertical[i + 1].x - M - b.x;
      b.h = horizontal[j + 1].y - M - b.y;
      if (b.w < 900 || b.h < 900) continue;
      if (city && overlaps(b, city, 400)) continue;
      if (avoid.some((a) => overlaps(b, a, 20)) || isWet(b)) continue;
      blocks.push({ ...b, roads: { n: horizontal[j], s: horizontal[j + 1], w: vertical[i], e: vertical[i + 1] } });
    }
  }
  blocks.sort(() => Math.random() - 0.5);
  const out = [];
  // One of each kind first (so a map short of blocks drops extras, never a whole resource), then the rest.
  // The mine gets the biggest block.
  const kinds = Object.keys(counts).filter((t) => counts[t] > 0).sort((a, b) => (b === 'mine') - (a === 'mine'));
  const order = [...kinds, ...Object.entries(counts).flatMap(([t, n]) => Array(Math.max(0, n - 1)).fill(t))];
  if (order[0] === 'mine') blocks.sort((a, b) => b.w * b.h - a.w * a.h);
  for (const type of order) {
    const block = blocks.shift();
    if (!block) break;
    // Gate toward one of its roads: rot 0 = south, 1 = west, 2 = north, 3 = east.
    const rot = Math.floor(Math.random() * 4);
    let size = rot % 2 ? { w: Math.round(block.h), h: Math.round(block.w) } : { w: Math.round(block.w), h: Math.round(block.h) };
    let { x, y } = block;
    if (type === 'oilwell') {
      // Oil fields take a quarter of the block (half each way), against the road their gate faces.
      size = { w: Math.round(Math.min(size.w, Math.max(700, size.w / 2))), h: Math.round(Math.min(size.h, Math.max(700, size.h / 2))) };
      const fw = rot % 2 ? size.h : size.w, fh = rot % 2 ? size.w : size.h; // its footprint on the map
      x += [(block.w - fw) / 2, 0, (block.w - fw) / 2, block.w - fw][rot];
      y += [block.h - fh, (block.h - fh) / 2, 0, (block.h - fh) / 2][rot];
    }
    out.push(buildBuilding(type, Math.round(x), Math.round(y), rot, out.length + 1, size));
    if (order[0] === 'mine' && type === 'mine') blocks.sort(() => Math.random() - 0.5); // the rest anywhere
  }
  return out;
}

/** For each rotation: which way the main (widest outside) door — or the seller — faces, and the size. Cached per type. */
const facingCache = new Map();
function facings(type) {
  if (facingCache.has(type)) return facingCache.get(type);
  const out = [0, 1, 2, 3].map((rot) => {
    const b = buildBuilding(type, 0, 0, rot, 0);
    const doors = b.doors.filter((d) => d.exterior).sort((a, c) => Math.max(c.w, c.h) - Math.max(a.w, a.h));
    // No doors (kiosk window, gas forecourt, open farm): face the way the seller looks out.
    const look = b.npc ? [Math.round(Math.cos(b.npc.angle)), Math.round(Math.sin(b.npc.angle))] : [null, null];
    return { rot, w: b.w, h: b.h, nx: doors[0]?.nx ?? look[0], ny: doors[0]?.ny ?? look[1] };
  });
  facingCache.set(type, out);
  return out;
}

const overlaps = (a, b, gap = 0) => a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;

/**
 * Places `count` buildings (types in `fixed` first, exactly that many; then cycling through the rest)
 * along the roads. Returns { buildings, lots } (lots: the parking beside businesses, with `building`).
 */
export function placeTown({ width, height, roads, city, count, fixed = {}, remote = new Set(), avoid = [], isWet = () => false, pre = [] }) {
  const others = Object.keys(BUILDING_TYPES).filter((t) => !(t in fixed) && t !== 'station');
  // One of each fixed type first, so a crowded map drops extras rather than a whole kind (a quarry, a scrapyard).
  const order = [...Object.keys(fixed).filter((t) => fixed[t] > 0), ...Object.entries(fixed).flatMap(([t, n]) => Array(Math.max(0, n - 1)).fill(t))];
  for (let i = 0; order.length < count; i++) order.push(others[i % others.length]);
  const placed = [...pre]; // already placed (the work sites)
  const lots = [];
  const cityRoads = city ? roads.filter((r) => overlaps(r, city, -1)) : roads;
  const roadGap = (r) => (city && overlaps(r, city, -1) ? SIDEWALK + 8 : 20); // keep off roads (and city sidewalks)
  const blocked = (r, gap, ignoreRoad = null) =>
    r.x < 100 || r.y < 100 || r.x + r.w > width - 100 || r.y + r.h > height - 100 ||
    placed.some((b) => overlaps(r, b, gap)) || lots.some((l) => overlaps(r, l, 12)) || avoid.some((a) => overlaps(r, a, 30)) ||
    roads.some((o) => o !== ignoreRoad && overlaps(r, o, roadGap(o))) || isWet(r);

  for (const type of order.slice(0, Math.max(count, 0))) {
    const id = placed.length + 1;
    if (remote.has(type)) {
      // Out in the woods, well away from any road.
      const { w, h } = facings(type)[0];
      for (let attempt = 0; attempt < 300; attempt++) {
        const r = { x: Math.round(randRange(150, width - 150 - w)), y: Math.round(randRange(150, height - 150 - h)), w, h };
        if (blocked(r, 120) || roads.some((o) => overlaps(r, o, 700)) || inBox(city, r.x + w / 2, r.y + h / 2)) continue;
        placed.push(buildBuilding(type, r.x, r.y, Math.floor(Math.random() * 4), id));
        break;
      }
      continue;
    }
    const inCityType = Boolean(city) && CITY_TYPES.has(type);
    const pool = inCityType ? cityRoads : roads;
    for (let attempt = 0; attempt < (inCityType ? 1500 : 500); attempt++) {
      const road = pool[Math.floor(Math.random() * pool.length)];
      if (!road) break;
      const horizontal = road.w > road.h;
      const side = Math.random() < 0.5 ? -1 : 1; // which side of the road (−1: above / left)
      const toRoad = horizontal ? [0, -side] : [-side, 0]; // the way the front door must face
      const options = facings(type).filter((f) => (f.nx === null ? (horizontal ? f.w >= f.h : f.h >= f.w) : f.nx === toRoad[0] && f.ny === toRoad[1]));
      if (!options.length) break;
      const f = options[Math.floor(Math.random() * options.length)];
      const sidewalk = inCityType ? SIDEWALK : 0;
      // Setback from the road edge: snug in town; in the country often well back up a gravel path.
      const yard = /warehouse|^farm$|logging|mine|oilwell|scrapyard|quarry/.test(type) ? 200 : 100;
      // Warehouses need room in front for a truck at the loading bay; other suppliers for a bay by the door.
      const near = /warehouse/.test(type) ? 195 : BUSINESS_TYPES.has(type) ? 100 : yard * 0.4;
      const setback = Math.round(sidewalk + (inCityType ? randRange(8, 70) : Math.random() < 0.55 ? randRange(near, Math.max(near, yard) + 40) : randRange(Math.max(near, yard), 650)));
      const span = horizontal ? road.w : road.h;
      const along = (horizontal ? road.x : road.y) + randRange(150, span - 150);
      const r = horizontal
        ? { x: Math.round(along - f.w / 2), y: side > 0 ? road.y + road.h + setback : road.y - setback - f.h, w: f.w, h: f.h }
        : { x: side > 0 ? road.x + road.w + setback : road.x - setback - f.w, y: Math.round(along - f.h / 2), w: f.w, h: f.h };
      const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
      if (city && inCityType !== (inBox(city, r.x, r.y) && inBox(city, r.x + r.w, r.y + r.h))) continue; // city types fully in town, the rest out of it
      if (city && !inCityType && overlaps(r, city, 60)) continue;
      if (blocked(r, inCityType ? 40 : 110)) continue;
      const building = buildBuilding(type, r.x, r.y, f.rot, id);
      placed.push(building);
      if (BUSINESS_TYPES.has(type)) addParking(building, road, horizontal, side, sidewalk);
      break;
    }
  }

  /** A few parking spaces right beside a business, against its road. */
  function addParking(b, road, horizontal, side, sidewalk) {
    const deep = 130;
    for (const spaces of [4, 3, 2]) {
      const long = spaces * 72;
      for (const end of Math.random() < 0.5 ? [1, -1] : [-1, 1]) {
        const lot = horizontal
          ? { x: Math.round(end > 0 ? b.x + b.w + 14 : b.x - 14 - long), y: side > 0 ? road.y + road.h + sidewalk : road.y - sidewalk - deep, w: long, h: deep }
          : { x: side > 0 ? road.x + road.w + sidewalk : road.x - sidewalk - deep, y: Math.round(end > 0 ? b.y + b.h + 14 : b.y - 14 - long), w: deep, h: long };
        if (lot.x < 50 || lot.y < 50 || lot.x + lot.w > width - 50 || lot.y + lot.h > height - 50) continue;
        if (placed.some((o) => o !== b && overlaps(lot, o, 10)) || overlaps(lot, b, 4) || lots.some((l) => overlaps(lot, l, 10))) continue;
        if (roads.some((o) => o !== road && overlaps(lot, o, roadGap(o))) || avoid.some((a) => overlaps(lot, a, 10)) || isWet(lot)) continue;
        lots.push({ ...makeLot({ ...lot, horizontal, side }), building: b.id });
        return;
      }
    }
  }

  return { buildings: placed, lots };
}
