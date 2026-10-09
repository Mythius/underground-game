import { WAREHOUSE_SIZES } from './buildings.js';

// Parking lots beside roads, and delivery bays outside the places you trade at.
// Both are worked out from the roads and buildings, so saved maps get them too.
//
//   bay: { x, y, w, h, building, angle }   a car parked in it counts as your cargo at that building
//   lot: { x, y, w, h, spots: [{ x, y, angle }] }

const BAY_LONG = 170; // fits a box truck (150)
const BAY_WIDE = 84;
const SPACE = 72; // one parking space across

/** Buildings people deliver to or pick up from (gas stations are open-air: you drive right in). */
const DELIVERY = new Set(['market', 'shop', 'kiosk', 'gunstore', 'dealership', 'logging', 'farm', 'mine', 'oilwell', 'scrapyard', 'quarry', 'station', 'powerplant']);

const overlaps = (a, b, gap = 0) => a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;

/**
 * Delivery bays: every supplier, factory, warehouse and shop gets at least one.
 *   warehouses: straight out from each loading door (back the truck up to it)
 *   others, first that fits: beside the main door · straight out from a door · along any wall ·
 *   inside an open yard (farms, logging camps…) · a space of the building's own parking lot.
 * `isWet(rect)` keeps them out of the water; `avoid` rects (ATMs, roads, lots…) stay clear;
 * `lots` are the businesses' own parking lots (with `building`).
 */
export function generateBays(buildings, width, height, factoryTypes, isWet = () => false, avoid = [], lots = []) {
  const bays = [];
  const inMap = (r) => r.x > 0 && r.y > 0 && r.x + r.w < width && r.y + r.h < height;
  const clear = (r) => !bays.some((x) => overlaps(r, x, 6)) && !isWet(r);
  const fits = (r, own) => inMap(r) && clear(r) && !avoid.some((a) => overlaps(r, a, 8)) && !buildings.some((b) => overlaps(r, b, b === own ? -10 : 10)); // may tuck up to the own wall
  // Lying parallel to a wall (horizontal: long side along x).
  const flat = (cx, cy, horizontal) => (horizontal ? { x: cx - BAY_LONG / 2, y: cy - BAY_WIDE / 2, w: BAY_LONG, h: BAY_WIDE } : { x: cx - BAY_WIDE / 2, y: cy - BAY_LONG / 2, w: BAY_WIDE, h: BAY_LONG });
  const add = (r, b, angle) => bays.push({ ...round(r), building: b.id, angle });

  for (const b of buildings) {
    const doors = b.doors.filter((d) => d.exterior).sort((a, c) => Math.max(c.w, c.h) - Math.max(a.w, a.h));
    const straightOut = (d) => {
      const cx = d.x + d.w / 2 + d.nx * (BAY_LONG / 2 + 4), cy = d.y + d.h / 2 + d.ny * (BAY_LONG / 2 + 4);
      return flat(cx, cy, d.w <= d.h); // the truck points away from the wall
    };
    if (WAREHOUSE_SIZES[b.type]) {
      let any = false;
      for (const d of doors) {
        const r = straightOut(d);
        if (fits(r, b)) { add(r, b, Math.atan2(d.ny, d.nx)); any = true; }
      }
      if (any) continue;
    } else if (!DELIVERY.has(b.type) && !factoryTypes.includes(b.type)) continue;

    const tries = [];
    for (const d of doors) {
      const horizontal = d.w > d.h;
      const along = (horizontal ? d.w : d.h) / 2 + 24 + BAY_LONG / 2;
      const out = BAY_WIDE / 2 + 6;
      for (const side of [1, -1]) {
        tries.push([flat(d.x + d.w / 2 + d.nx * out + (horizontal ? along * side : 0), d.y + d.h / 2 + d.ny * out + (horizontal ? 0 : along * side), horizontal), horizontal ? 0 : Math.PI / 2]);
      }
      tries.push([straightOut(d), Math.atan2(d.ny, d.nx)]);
    }
    // Along any wall: three spots per side, just outside it.
    for (const [nx, ny] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
      const horizontal = ny !== 0;
      for (const f of [0.5, 0.2, 0.8]) {
        const cx = nx ? (nx > 0 ? b.x + b.w + 6 + BAY_WIDE / 2 : b.x - 6 - BAY_WIDE / 2) : b.x + b.w * f;
        const cy = ny ? (ny > 0 ? b.y + b.h + 6 + BAY_WIDE / 2 : b.y - 6 - BAY_WIDE / 2) : b.y + b.h * f;
        tries.push([flat(cx, cy, horizontal), horizontal ? 0 : Math.PI / 2]);
      }
    }
    let done = tries.some(([r, angle]) => fits(r, b) && (add(r, b, angle), true));
    // Open yards (no roof): somewhere inside, clear of the yard's own props.
    if (!done && b.pattern === 'none') {
      for (let gy = b.y + 20; !done && gy + BAY_WIDE < b.y + b.h - 10; gy += 30) {
        for (let gx = b.x + 20; !done && gx + BAY_LONG < b.x + b.w - 10; gx += 30) {
          const r = { x: gx, y: gy, w: BAY_LONG, h: BAY_WIDE };
          if (inMap(r) && clear(r) && !b.walls.some((w) => overlaps(r, w, 6))) { add(r, b, 0); done = true; }
        }
      }
    }
    // Last resort: paint one space of the building's own parking lot.
    if (!done) {
      const lot = lots.find((l) => l.building === b.id);
      const spot = lot?.spots[0];
      if (spot) {
        const r = lot.horizontal ? { x: spot.x - SPACE / 2 + 3, y: lot.y + 3, w: SPACE - 6, h: lot.h - 6 } : { x: lot.x + 3, y: spot.y - SPACE / 2 + 3, w: lot.w - 6, h: SPACE - 6 };
        if (clear(r)) add(r, b, spot.angle);
      }
    }
  }
  return bays;
}

/** Up to `count` parking lots, each against the edge of a road, clear of buildings, bays and water. */
export function generateLots(roads, buildings, bays, width, height, count, isWet = () => false, avoid = []) {
  const lots = [];
  if (!roads.length) return lots;
  for (let tries = 0; lots.length < count && tries < count * 60; tries++) {
    const road = roads[Math.floor(Math.random() * roads.length)];
    const horizontal = road.w > road.h;
    const spaces = 4 + Math.floor(Math.random() * 4);
    const long = spaces * SPACE;
    const deep = 130;
    const side = Math.random() < 0.5 ? -1 : 1;
    const along = (horizontal ? road.x : road.y) + 200 + Math.random() * Math.max(0, (horizontal ? road.w : road.h) - 400 - long);
    const r = horizontal
      ? { x: along, y: side < 0 ? road.y - deep : road.y + road.h, w: long, h: deep }
      : { x: side < 0 ? road.x - deep : road.x + road.w, y: along, w: deep, h: long };
    if (r.x < 50 || r.y < 50 || r.x + r.w > width - 50 || r.y + r.h > height - 50) continue;
    if (buildings.some((b) => overlaps(r, b, 30)) || bays.some((b) => overlaps(r, b, 20)) || lots.some((l) => overlaps(r, l, 60))) continue;
    if (roads.some((o) => o !== road && overlaps(r, o, 10)) || avoid.some((a) => overlaps(r, a, 10)) || isWet(r)) continue;
    lots.push(makeLot({ ...round(r), horizontal, side }));
  }
  return lots;
}

/** A lot's parking spaces, from its rect and which side of its road it's on. Cars park nose-in, away from the road. */
export function makeLot({ x, y, w, h, horizontal, side }) {
  const spots = [];
  const n = Math.max(1, Math.floor((horizontal ? w : h) / SPACE));
  for (let i = 0; i < n; i++) {
    spots.push(horizontal
      ? { x: Math.round(x + (i + 0.5) * SPACE), y: Math.round(y + h / 2), angle: side < 0 ? -Math.PI / 2 : Math.PI / 2 }
      : { x: Math.round(x + w / 2), y: Math.round(y + (i + 0.5) * SPACE), angle: side < 0 ? Math.PI : 0 });
  }
  return { x, y, w, h, horizontal, side, spots };
}

function round(r) {
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) };
}

/** Is a point (a vehicle's centre) inside a rect? */
export const inRect = (r, x, y) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
