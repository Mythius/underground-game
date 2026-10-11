import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { clamp, distSq, pushCircleOutOfRect, randRange, segmentDistSq, segmentRectHit } from '../utils/math.js';
import { WAREHOUSE_SIZES, atmSpotsFor, buildBuilding, generateBuildings } from './buildings.js';
import { generateLamps, generatePaths, generateTrees, makeTree } from './terrain.js';
import { SIDEWALK, cityBox, generateTownRoads, inBox, placeSites, placeTown } from './placement.js';
import { Work } from './work.js';
import { generateLakes, generateRails, generateRivers, isSwimming, onIce, pushOutOfWater, waterDistance } from './water.js';
import { Bullet, Food, Pickup, Player, STARTER_WEAPON, makeWeapon, massToRadius } from './entities.js';
import { SpatialGrid } from './SpatialGrid.js';
import { Vehicle, emptyTankGas, stepVehicle, vehicleCircles, vehicleMotion } from './vehicles.js';
import { Economy } from './economy.js';
import { Townsfolk } from './townsfolk.js';
import { Police } from './police.js';
import { hotbarOf, trunkOf } from './cargo.js';
import { Warehouses } from './warehouse.js';
import { Homes } from './homes.js';
import { generateBays, generateLots, generatePads, makeLot } from './parking.js';
import { Railway, planRailway, railCorridor } from './railway.js';
import { Roadblocks } from './roadblocks.js';
import { Bodies, generateDumpsters } from './bodies.js';
import { Hires } from './hires.js';
import { Fishing } from './fishing.js';
import { radioAt } from '../radio.js';
import { Furnishings } from './furnishing.js';
import { Prison } from './prison.js';

/**
 * Pure simulation state. Knows nothing about sockets.
 * With `map` (a validated map file) the scenery comes from it; otherwise it's generated at random.
 */
/** Every map needs at least one of each of these, so every raw resource can be had. */
export const REQUIRED_SITES = ['mine', 'logging', 'farm', 'oilwell', 'scrapyard', 'quarry'];

/** The required sites a world is missing. */
export function missingSites(world) {
  return REQUIRED_SITES.filter((t) => !world.buildings.some((b) => b.type === t));
}

/**
 * A world from `map`, or a fresh random one that has every required site: random maps that come out
 * without one are made again (keeping the best try, in case the map is too small to ever fit them all).
 */
export function createWorld(opts = config.world, playerOpts = config.player, weapons = config.weapons, map = null, tries = 10) {
  if (map) return new World(opts, playerOpts, weapons, map);
  let best = null;
  for (let i = 0; i < tries; i++) {
    const world = new World(opts, playerOpts, weapons);
    const missing = missingSites(world).length;
    if (!missing) return world;
    if (!best || missing < best.missing) best = { world, missing };
  }
  logger.warn('random map is missing resource sites', { missing: missingSites(best.world) });
  return best.world;
}

/** This step's knock-back velocity (p.kx, p.ky), easing off; zero once it's spent. Keep in sync with the client. */
export function knockStep(p, dt) {
  if (!p.kx && !p.ky) return [0, 0];
  const out = [p.kx, p.ky];
  const k = Math.exp(-config.vehicles.knockDecay * dt);
  p.kx *= k;
  p.ky *= k;
  if (Math.hypot(p.kx, p.ky) < 15) p.kx = p.ky = 0;
  return out;
}

/** A saved trunk slot back as it goes in a car: goods, a gun (with its ammo), or nothing. */
export function trunkSlot(s) {
  if (s?.good && config.goods[s.good] && s.qty > 0) return { good: s.good, qty: s.qty };
  if (s?.type === 'rod') return { type: 'rod' };
  if (s?.type && config.weapons[s.type]) return { type: s.type, ammo: Math.max(0, Math.min(Number(s.ammo) || 0, config.weapons[s.type].magazineSize)), ...(s.illegal ? { illegal: true } : {}) };
  return null;
}

export class World {
  /** Every radio song's length in playlist order (the server sets this from the radio playlist). */
  static radioDurations = () => [];

  #near = new Set(); // (scratch set for car-grid lookups; never used by two loops at once)
  constructor(opts = config.world, playerOpts = config.player, weapons = config.weapons, map = null) {
    this.opts = map ? { ...opts, width: map.width, height: map.height } : opts;
    opts = this.opts;
    this.playerOpts = playerOpts;
    this.weapons = weapons;
    this.width = opts.width;
    this.height = opts.height;
    this.players = new Map();
    this.food = new Map();
    this.bullets = new Map();
    this.pickups = new Map();
    this.pickupTimer = 0;
    this.vehicles = new Map();
    this.vehicleRespawns = []; // seconds until each destroyed vehicle is replaced
    this.gripScale = 1; // set by the room from the weather
    this.frozen = false; // lakes freeze in winter (set by the room from the season)
    this.grid = new SpatialGrid(opts.width, opts.height, opts.gridCellSize);
    this.carGrid = new SpatialGrid(opts.width, opts.height, opts.gridCellSize); // just the cars, re-filed each tick after they move

    if (map) this.#sceneryFromMap(map);
    else this.#generateScenery();
    this.paths = generatePaths(this.buildings, this.roads);
    this.rails = generateRails(this.roads, this.water);
    // Delivery bays outside places you trade at, and parking lots along the roads. Trees make way for them.
    const wetRect = (r) => {
      for (let x = r.x; x <= r.x + r.w; x += 40) for (let y = r.y; y <= r.y + r.h; y += 40) if (waterDistance(this.water, x, y).d < 10) return true;
      return false;
    };
    const fixtures = [...this.atms, ...this.extraNpcs].map((a) => ({ x: a.x - 16, y: a.y - 16, w: 32, h: 32 }));
    // Roads plus, in town, their sidewalks: bays and lots stay off them.
    const roadZones = this.roads.map((r) => {
      const m = this.city && inBox(this.city, r.x + r.w / 2, r.y + r.h / 2) ? SIDEWALK : 4;
      return { x: r.x - m, y: r.y - m, w: r.w + m * 2, h: r.h + m * 2 };
    });
    const ownLots = map?.lots ? map.lots.map((l) => ({ ...makeLot(l), building: l.building })) : this.businessLots;
    const railStrip = this.railwayY !== null ? [railCorridor(this.width, this.railwayY)] : [];
    // (Off the tracks too: the station's bay goes round the front, by the street door.)
    this.bays = generateBays(this.buildings, this.width, this.height, Object.keys(config.factories), wetRect, [...fixtures, ...ownLots, ...roadZones, ...railStrip], ownLots);
    // A few more lots out along the country roads (town businesses have their own).
    this.lots = map?.lots
      ? ownLots
      : [...ownLots, ...generateLots(this.roads, this.buildings, [...this.bays, ...ownLots], this.width, this.height, opts.parkingLots ?? 0, wetRect, [...fixtures, ...this.rails, ...railStrip, ...(this.city ? [this.city] : [])])];
    // A car pad outside every starter house: its garage.
    this.pads = generatePads(this.buildings, config.homes.starterTypes, this.width, this.height, wetRect, [...fixtures, ...this.bays, ...this.lots, ...roadZones, ...railStrip]);
    const paved = [...this.bays, ...this.lots, ...this.pads, ...railStrip];
    this.trees = this.trees.filter((t) => {
      const m = t.canopy * 0.7; // keep canopies mostly off them, so parked cars aren't hidden
      return !paved.some((r) => t.x > r.x - m && t.x < r.x + r.w + m && t.y > r.y - m && t.y < r.y + r.h + m);
    });

    // Walls and tree trunks block players and bullets; they live in their own grid, built once.
    // Bridge rails are low: they stop people and cars but bullets fly over them.
    // Standalone shopkeepers get a solid block like the ones behind shop counters.
    // Dumpsters beside buildings (somewhere to get rid of a body), clear of roads, lots, bays and water.
    this.dumpsters = generateDumpsters(this.buildings, this.city, (r) =>
      r.x > 50 && r.y > 50 && r.x + r.w < this.width - 50 && r.y + r.h < this.height - 50 &&
      !this.buildings.some((b) => r.x < b.x + b.w + 6 && b.x < r.x + r.w + 6 && r.y < b.y + b.h + 6 && b.y < r.y + r.h + 6) &&
      ![...roadZones, ...this.lots, ...this.bays, ...this.pads, ...railStrip, ...fixtures].some((o) => r.x < o.x + o.w + 6 && o.x < r.x + r.w + 6 && r.y < o.y + o.h + 6 && o.y < r.y + r.h + 6) &&
      !this.trees.some((t) => Math.abs(t.x - (r.x + r.w / 2)) < 40 && Math.abs(t.y - (r.y + r.h / 2)) < 40) && !wetRect(r));
    const station = this.buildings.find((b) => b.type === 'station') ?? null;
    this.railway = this.railwayY !== null ? new Railway(this, this.railwayY, station) : null;
    this.blocks = [
      ...this.extraNpcs.map((n) => ({ x: n.x - 14, y: n.y - 14, w: 28, h: 28, npc: true })),
      ...(this.railway?.smuggler ? [{ x: this.railway.smuggler.x - 14, y: this.railway.smuggler.y - 14, w: 28, h: 28, npc: true }] : []),
      ...this.atms.map((a) => ({ x: a.x - 12, y: a.y - 12, w: 24, h: 24, atm: true })),
      ...this.dumpsters.map((d) => ({ ...d, dumpster: true })),
    ];
    this.wallGrid = new SpatialGrid(opts.width, opts.height, opts.gridCellSize);
    const solids = [...this.buildings.flatMap((b) => b.walls), ...this.trees.map((t) => t.trunk), ...this.blocks];
    for (const w of solids) this.wallGrid.insert({ x: w.x + w.w / 2, y: w.y + w.h / 2, radius: Math.max(w.w, w.h) / 2, rect: w, low: Boolean(w.low) }); // (barbed wire: low, see-through)
    for (const w of this.rails) this.wallGrid.insert({ x: w.x + w.w / 2, y: w.y + w.h / 2, radius: Math.max(w.w, w.h) / 2, rect: w, low: true });

    // Each building's NPC knows which building it works in.
    for (const b of this.buildings) if (b.npc) Object.assign(b.npc, { building: b.id, type: b.type });
    const buildingNpcs = this.buildings.filter((b) => b.npc).map((b) => b.npc);
    this.shopkeepers = [...buildingNpcs.filter((n) => n.role === 'shop'), ...this.extraNpcs];
    this.tellers = buildingNpcs.filter((n) => n.role === 'teller');
    this.economy = new Economy(this);
    this.townsfolk = new Townsfolk(this);
    this.bodies = new Bodies(this);
    this.work = new Work(this);

    // Doors fill their doorway and are solid while closed. They start closed.
    this.doors = this.buildings.flatMap((b) => b.doors.map((d) => Object.assign(d, { building: b.id })));
    this.doors.forEach((d, i) => {
      d.id = i + 1;
      d.open = false;
      this.wallGrid.insert({ x: d.x + d.w / 2, y: d.y + d.h / 2, radius: Math.max(d.w, d.h) / 2, rect: d, door: d });
    });
    this.nextEntityId = 1;
    this.tick = 0;
    for (let i = 0; i < opts.foodCount; i++) this.spawnFood();
    for (let i = 0; i < (opts.pickupStart ?? 0); i++) this.spawnPickup();
    // Vehicles start where the map put them; generated maps park them at random.
    if (map) {
      for (const v of map.vehicles) {
        const car = new Vehicle(this.nextEntityId++, v.type, v.x, v.y, v.angle);
        this.vehicles.set(car.id, car);
      }
    } else if (this.roads.length) {
      // About a third of the parking spaces start taken; the rest of the cars are parked along the roads.
      const spots = this.lots.flatMap((l) => l.spots).filter(() => Math.random() < 0.35);
      for (const s of spots.slice(0, config.vehicles.count ?? 0)) {
        const v = new Vehicle(this.nextEntityId++, this.#randomVehicleType(), s.x, s.y, s.angle);
        this.vehicles.set(v.id, v);
      }
      while (this.vehicles.size < (config.vehicles.count ?? 0) && this.spawnVehicle());
    }
    this.vehicleSpots = [...this.vehicles.values()].map((v) => ({ type: v.type, x: Math.round(v.x), y: Math.round(v.y), angle: v.angle }));
    this.police = new Police(this); // after vehicle ids start, so cruisers get their own
    this.warehouses = new Warehouses(this);
    this.homes = new Homes(this);
    this.areTeammates = () => false; // (a, b) players on the same team (the room knows; set there)
    this.onCarBought = null; // (vehicle) a car bought at a dealership: save it to the owner's garage
    this.onCarLost = null; // (vehicle) a saved car blown up: what was in its trunk is gone
    this.roadblocks = new Roadblocks(this, railStrip); // after vehicle ids start: their Militsiya cars are vehicles
    this.hires = new Hires(this); // goons, guards and hitmen from the БАР
    this.fishing = new Fishing(this);
    this.furnishings = new Furnishings(this); // cabinets, beds and sofas placed in homes and warehouses
    this.prison = new Prison(this); // where every arrest ends up (its guards join the police)
    this.brokenAtms = new Map(); // ATM key -> economy time it works again (smashed with a bat)
    this.atmsChanged = false; // (the room tells everyone which ATMs are broken)
    this.meleeDeaths = []; // knife kills this step (handed to step()'s deaths)
    this.pendingDoors = []; // doors opened outside #handleUse (picked locks), to announce
    this.rebuildGrid();
  }

  #sceneryFromMap(map) {
    this.water = { rivers: map.rivers, lakes: map.lakes };
    this.roads = map.roads;
    this.buildings = map.buildings.map((b, i) => buildBuilding(b.type, b.x, b.y, b.rot, i + 1, b.size ?? null));
    this.trees = map.trees.map((t) => makeTree(t.x, t.y, t.canopy, Math.round(t.x * 31 + t.y * 17)));
    this.forests = map.forests;
    this.lamps = map.lamps;
    this.extraNpcs = map.npcs;
    this.railwayY = map.railway?.y ?? null;
    this.city = map.city ?? null;
    this.businessLots = [];
    this.atms = map.atms ?? [];
    this.trails = map.trails;
  }

  /** The current scenery as a map file (what the editor loads). */
  toMap() {
    return {
      version: 1,
      width: this.width,
      height: this.height,
      roads: this.roads,
      rivers: this.water.rivers,
      lakes: this.water.lakes,
      trails: this.trails,
      buildings: this.buildings.map(({ type, x, y, rot, size }) => ({ type, x, y, rot, ...(size ? { size } : {}) })),
      trees: this.trees.map(({ x, y, canopy }) => ({ x, y, canopy })),
      forests: this.forests,
      lamps: this.lamps,
      vehicles: this.vehicleSpots,
      npcs: this.extraNpcs,
      atms: this.atms,
      lots: this.lots.map(({ x, y, w, h, horizontal, side, building }) => ({ x, y, w, h, horizontal, side, ...(building ? { building } : {}) })),
      ...(this.railwayY !== null ? { railway: { y: this.railwayY } } : {}),
      ...(this.city ? { city: this.city } : {}),
    };
  }

  #generateScenery() {
    const opts = this.opts;
    // Water first so everything else can keep its feet dry, then roads, buildings around them, and trees in the gaps.
    const terrain = opts.terrain !== false;
    this.water = {
      rivers: terrain ? generateRivers(opts.width, opts.height, opts.rivers ?? 0) : [],
      lakes: terrain ? generateLakes(opts.width, opts.height, opts.lakes ?? 0) : [],
    };
    const wet = (x, y, margin = 0) => waterDistance(this.water, x, y).d < margin;
    // A building spot is wet if any point on a 100-unit grid over it (plus a margin) is near water.
    const wetRect = ({ x, y, w, h }) => {
      for (let px = x - 40; px <= x + w + 40; px += 100) for (let py = y - 40; py <= y + h + 40; py += 100) if (wet(px, py, 60)) return true;
      return wet(x + w + 40, y + h + 40, 60);
    };
    this.city = terrain && opts.citySize ? cityBox(opts.width, opts.height, opts.citySize) : null;
    this.roads = terrain ? generateTownRoads(opts.width, opts.height, this.city) : [];
    // The essentials of a town first (so they always find a spot), then one city-run factory of each
    // kind (players build their own in warehouses), warehouses, and the rest.
    const fixed = { panelka: 0, police: 2, bar: 1, bank: 3, market: 3, gunstore: 2, dealership: 2, shop: 8, gas: 6, church: 1, office: 4, powerplant: 1 }; // panel blocks first: they need the most room
    for (const t of Object.keys(config.factories)) fixed[t] = 1;
    for (const [type, size] of Object.entries(WAREHOUSE_SIZES)) fixed[type] = config.warehouses.sizes[size].count;
    // A Soviet town: apartment blocks, street kiosks, lock-up garages (more of them on bigger maps).
    // (These scale with the town, not the whole map.)
    const k = opts.citySize ? (opts.citySize / 4000) ** 2 : (opts.width * opts.height) / (9000 * 9000);
    Object.assign(fixed, { panelka: Math.round(4 * k), kiosk: Math.round(2.5 * k), garages: Math.round(1.5 * k), scrapyard: 3, quarry: 3 });
    for (const t of [...Object.keys(config.work.sites), 'prison']) fixed[t] = 0; // work sites and the prison: placed on whole blocks below
    // The railway runs right across, between two roads; the freight station sits beside it.
    const plan = terrain && this.roads.length ? planRailway(opts.width, opts.height, this.roads, wetRect) : null;
    const corridor = plan ? [railCorridor(opts.width, plan.y), plan.station] : [];
    this.railwayY = plan?.y ?? null;
    // Every building fronts onto a road (city types in town, the rest in the country); shacks hide in the woods.
    // The mine, lumberyards, farms and oil fields first: each fills a whole country block.
    const sites = this.roads.length ? placeSites({ width: opts.width, height: opts.height, roads: this.roads, city: this.city, counts: config.work.sites, avoid: corridor, isWet: wetRect, prison: Boolean(config.prison) }) : [];
    ({ buildings: this.buildings, lots: this.businessLots } = this.roads.length
      ? placeTown({ width: opts.width, height: opts.height, roads: this.roads, city: this.city, count: (opts.buildingCount ?? 0) + sites.length, fixed, remote: new Set(['shack']), avoid: corridor, isWet: wetRect, pre: sites })
      : { buildings: generateBuildings(opts.width, opts.height, opts.buildingCount ?? 0, 120, corridor, 40, wetRect, fixed, new Set(['shack'])), lots: [] });
    if (plan) this.buildings.push(buildBuilding('station', plan.station.x, plan.station.y, 0, this.buildings.length + 1));
    const paths = terrain ? generatePaths(this.buildings, this.roads) : [];
    ({ trees: this.trees, forests: this.forests } = terrain
      ? generateTrees(opts.width, opts.height, { roads: [...this.roads, ...corridor], buildings: this.buildings, paths, inWater: wet, forests: opts.forests, scattered: opts.scatteredTrees })
      : { trees: [], forests: [] });
    // Street lamps only in town.
    this.lamps = terrain ? generateLamps(this.roads, this.water).filter((l) => !this.city || inBox(this.city, l.x, l.y)) : [];
    this.extraNpcs = [];
    // An ATM outside every shop, gas station and bank.
    this.atms = this.buildings
      .filter((b) => ['shop', 'gas', 'bank'].includes(b.type))
      .map((b) => {
        // Beside an outside door; open-air gas stations (no doors) get one next to the clerk.
        const spots = atmSpotsFor(b);
        if (!spots.length && b.npc) {
          const side = b.npc.angle + Math.PI / 2;
          spots.push({ x: Math.round(b.npc.x + Math.cos(side) * 60), y: Math.round(b.npc.y + Math.sin(side) * 60), angle: b.npc.angle });
        }
        return spots.find((a) => !wet(a.x, a.y, 20) && !this.roads.some((r) => a.x > r.x - 20 && a.x < r.x + r.w + 20 && a.y > r.y - 20 && a.y < r.y + r.h + 20));
      })
      .filter(Boolean);
    this.trails = [];
  }

  /** Parks a random car or truck in a lane, facing the way traffic flows, away from junctions and other vehicles. */
  spawnVehicle(type = null) {
    type ??= this.#randomVehicleType();
    for (let attempt = 0; attempt < 50; attempt++) {
      const road = this.roads[Math.floor(Math.random() * this.roads.length)];
      const horizontal = road.w > road.h;
      const size = horizontal ? road.h : road.w;
      const lane = Math.floor(Math.random() * 6);
      const across = (horizontal ? road.y : road.x) + ((lane + 0.5) * size) / 6;
      const along = (horizontal ? road.x : road.y) + randRange(200, (horizontal ? road.w : road.h) - 200); // roads needn't start at the map edge
      const x = horizontal ? along : across;
      const y = horizontal ? across : along;
      // Right-hand traffic: the far half of the road flows the other way.
      const angle = horizontal ? (lane >= 3 ? 0 : Math.PI) : lane >= 3 ? Math.PI / 2 : -Math.PI / 2;
      // Keep clear of junctions with the roads crossing this one.
      const crossRoad = this.roads.some((r) =>
        horizontal ? r.h > r.w && Math.abs(x - (r.x + r.w / 2)) < r.w / 2 + 120 : r.w > r.h && Math.abs(y - (r.y + r.h / 2)) < r.h / 2 + 120,
      );
      if (crossRoad) continue;
      if ([...this.vehicles.values()].some((v) => Math.hypot(v.x - x, v.y - y) < 220)) continue;
      const v = new Vehicle(this.nextEntityId++, type, x, y, angle);
      this.vehicles.set(v.id, v);
      return v;
    }
    return null;
  }

  #randomVehicleType() {
    const types = config.vehicles.types;
    let roll = Math.random() * Object.values(types).reduce((s, t) => s + t.spawnWeight, 0);
    return Object.keys(types).find((k) => (roll -= types[k].spawnWeight) < 0) ?? 'sedan';
  }

  /** Walls whose bounding boxes come within `range` of (x, y). Bullets pass `tall` to skip low bridge rails. */
  wallsNear(x, y, range, tall = false) {
    const out = [];
    for (const e of this.wallGrid.query(x, y, range)) if (!e.door?.open && !(tall && e.low)) out.push(e.rect);
    return out;
  }

  /** Is there a clear line from (ax, ay) to (bx, by)? Walls, closed doors, trunks and bins block it. */
  lineOfSight(ax, ay, bx, by) {
    const len = Math.hypot(bx - ax, by - ay);
    const steps = Math.max(1, Math.ceil(len / 250));
    const checked = new Set();
    for (let i = 0; i <= steps; i++) {
      const x = ax + ((bx - ax) * i) / steps;
      const y = ay + ((by - ay) * i) / steps;
      for (const w of this.wallsNear(x, y, 170, true)) {
        if (checked.has(w) || w.npc || w.atm) continue; // people and ATMs don't hide anyone
        checked.add(w);
        if (segmentRectHit(ax, ay, bx, by, w, 0) !== null) return false;
      }
    }
    return true;
  }

  /** Climb into a dumpster (out of sight, can't move) — or back out of it. */
  hideIn(p, d) {
    p.hidden = { dumpster: d };
    p.x = d.x + d.w / 2;
    p.y = d.y + d.h / 2;
  }

  unhide(p) {
    const d = p.hidden?.dumpster;
    p.hidden = null;
    if (d) {
      p.x = d.x + d.w / 2;
      p.y = d.y + d.h + p.radius + 4; // step out in front of it
    }
  }

  /** Would a circle at (x, y) overlap any wall? */
  isBlocked(x, y, r) {
    return this.wallsNear(x, y, r).some((w) => pushCircleOutOfRect({ x, y }, r, w));
  }

  /** Buys food from a shopkeeper in reach. Returns an error code, or null on success. */
  buy(p, item) {
    if (item === 'rod') return this.#buyRod(p);
    const food = config.economy.menu[item];
    if (!food) return 'unknown_item';
    const reach = config.economy.shopReach + p.radius;
    const keeper = this.shopkeepers.find((s) => Math.hypot(s.x - p.x, s.y - p.y) < reach);
    if (p.vehicle || !keeper) return 'too_far';
    // Shops in buildings sell from their bread stock; stand-alone shopkeepers have endless supply.
    const market = this.economy.markets.get(keeper.building);
    if (this.economy.isClosed(market)) return 'closed_raid';
    const bread = market?.goods.bread;
    if (bread && bread.stock < food.bread) return 'sold_out';
    const price = this.economy.foodPrice(market, item);
    if (p.cash < price) return 'not_enough_cash';
    if (!this.foodRoom(p, item)) return 'hotbar_full';
    p.cash -= price;
    if (bread) bread.stock -= food.bread;
    this.addFood(p, item, 1);
    return null;
  }

  /** A fishing rod from a shopkeeper in reach (cash). One's enough: it never wears out. */
  #buyRod(p) {
    const reach = config.economy.shopReach + p.radius;
    const keeper = this.shopkeepers.find((s) => Math.hypot(s.x - p.x, s.y - p.y) < reach);
    if (p.vehicle || !keeper) return 'too_far';
    if (this.economy.isClosed(this.economy.markets.get(keeper.building))) return 'closed_raid';
    if (p.inventory.some((s) => s?.type === 'rod')) return 'have_rod';
    if (p.cash < config.fishing.rodPrice) return 'not_enough_cash';
    const free = p.inventory.indexOf(null);
    if (free < 0) return 'hotbar_full';
    p.cash -= config.fishing.rodPrice;
    p.inventory[free] = { type: 'rod', tool: true };
    return null;
  }

  /** Room in p's hotbar for one more `item` of food: a stack of it that isn't full, or an empty slot. */
  foodRoom(p, item) {
    return p.inventory.some((s) => s === null || (s.food === item && s.qty < config.economy.foodStack));
  }

  /** Food into the hotbar (topping up stacks, then empty slots). Returns how many didn't fit. */
  addFood(p, item, qty) {
    for (const s of p.inventory) {
      if (qty <= 0) break;
      if (s?.food !== item) continue;
      const put = Math.min(qty, config.economy.foodStack - s.qty);
      s.qty += put;
      qty -= put;
    }
    for (let i = 0; i < p.inventory.length && qty > 0; i++) {
      if (p.inventory[i] !== null) continue;
      const put = Math.min(qty, config.economy.foodStack);
      p.inventory[i] = { food: item, qty: put };
      qty -= put;
    }
    return qty;
  }

  /** E with food selected: eat one. It heals over the next few seconds (see #digest). */
  eat(p) {
    const slot = p.inventory[p.selected];
    if (slot?.good === 'bat' || slot?.good === 'blackguns') { // a bat from the factory, or a boxed unregistered pistol: take it up as a weapon
      slot.qty -= 1;
      if (slot.qty <= 0) p.inventory[p.selected] = null;
      const free = p.inventory.indexOf(null);
      if (free < 0) { // (no room: it stays a good)
        hotbarOf(p).add(slot.good, 1);
        return 'no_room';
      }
      p.inventory[free] = slot.good === 'bat' ? makeWeapon('bat') : { ...makeWeapon('pistol'), illegal: true }; // (an unregistered pistol is still illegal in your hand)
      p.selected = free;
      return null;
    }
    // Shop food, a stack of bread from the bakery (it eats like a shop loaf), or a bottle of vodka.
    const vision = config.economy.visions[slot?.good]; // vodka, or a mix of it
    const food = slot?.food ? config.economy.menu[slot.food] : slot?.good === 'bread' ? config.economy.menu.bread : vision ? config.economy.vodka : slot?.good === 'fish' ? config.economy.fish : null;
    if (!food) return 'nothing_to_eat';
    if (p.jailed || p.hidden) return 'busy';
    slot.qty -= 1;
    if (slot.qty <= 0) p.inventory[p.selected] = null;
    p.mass += food.mass;
    (p.digesting ??= []).push({ perSec: food.heal / food.healSec, left: food.healSec });
    if (food.buzzSec) p.buzz = food.buzzSec;
    if (vision) (p.visions ??= {})[vision] = config.economy.visionSec; // how the world looks for a while — they stack: one of each kind at once
    if (food.stamina) {
      p.stamina = this.playerOpts.staminaMax;
      p.exhausted = false;
      p.staminaDelay = 0;
    }
    return null;
  }

  /**
   * E with fuel in hand beside a car: pour it in. One fuel fills fuelCanShare (20%) of a tank.
   * Vodka goes in the boost tank instead: perVodka (25%) a bottle.
   */
  pourFuel(p) {
    const slot = p.inventory[p.selected];
    if (slot?.good !== 'fuel' && slot?.good !== 'vodka') return 'no_fuel';
    if (p.vehicle || p.jailed || p.hidden) return 'busy';
    let car = null;
    let best = config.vehicles.reach;
    for (const v of this.vehicles.values()) {
      const d = this.#vehicleDistance(v, p.x, p.y) - p.radius;
      if (d < best) [car, best] = [v, d];
    }
    if (!car) return 'no_car_near';
    const key = slot.good === 'vodka' ? 'boost' : 'fuel';
    const share = slot.good === 'vodka' ? config.vehicles.boost.perVodka : config.vehicles.fuelCanShare;
    const units = Math.min(Math.ceil((100 - car[key]) / share), slot.qty);
    if (car[key] >= 99 || units <= 0) return key === 'boost' ? 'boost_full' : 'tank_full';
    slot.qty -= units;
    if (slot.qty <= 0) p.inventory[p.selected] = null;
    car[key] = Math.min(100, car[key] + units * share);
    return null;
  }

  /** Everyone heals slowly on their own; food eaten heals a little more every tick until it's done. */
  #digest(dt) {
    for (const p of this.players.values()) {
      if (p.alive && p.health > 0) p.heal((this.playerOpts.healthRegenPerSec ?? 0) * dt);
      if (p.buzz > 0) p.buzz = Math.max(0, p.buzz - dt);
      if (p.visions) for (const k of Object.keys(p.visions)) if ((p.visions[k] -= dt) <= 0) delete p.visions[k];
      if (!p.digesting?.length) continue;
      for (const d of p.digesting) {
        const t = Math.min(dt, d.left);
        p.heal(d.perSec * t);
        d.left -= t;
      }
      p.digesting = p.digesting.filter((d) => d.left > 0);
    }
  }

  /**
   * Deposit or withdraw at an ATM or bank teller in reach. `amount` is whole dollars.
   * Returns an error code, or null on success (the room saves the new balance).
   */
  bank(p, action, amount) {
    if (!p.account) return 'no_account';
    const { bankReach, atmReach } = config.economy;
    const near = (list, reach) => list.some((s) => Math.hypot(s.x - p.x, s.y - p.y) < reach + p.radius);
    if (p.vehicle || !(near(this.atms, atmReach) || near(this.tellers, bankReach))) return 'too_far';
    if (!near(this.tellers, bankReach) && !near(this.atms.filter((a) => !this.atmBroken(a)), atmReach)) return 'atm_broken'; // smashed: try another
    if (action === 'deposit') {
      if (amount > p.cash) return 'not_enough_cash';
      // Not straight back in at an ATM you've just robbed (a teller, or another ATM, is fine).
      const robbed = p.robbedAtms ?? new Map();
      const usable = this.atms.some((a) => Math.hypot(a.x - p.x, a.y - p.y) < atmReach + p.radius && !((robbed.get(`atm:${Math.round(a.x)},${Math.round(a.y)}`) ?? 0) > this.economy.time));
      if (!usable && !near(this.tellers, bankReach)) return 'robbed_atm';
      p.cash -= amount;
      p.account.bank += amount;
    } else {
      if (amount > p.account.bank) return 'not_enough_bank';
      p.account.bank -= amount;
      p.cash += amount;
    }
    return null;
  }

  /** Robbery (hold your ground until it's done) and pickpocketing: see Police. */
  rob(p) {
    return this.police.startRobbery(p);
  }

  pickpocket(p) {
    return this.police.pickpocket(p);
  }

  makeWeapon(type) {
    return makeWeapon(type);
  }

  /**
   * A brand-new vehicle for `owner`, parked outside building `buildingId`'s door, full tank.
   * Returns null if there's nowhere clear to put it.
   */
  parkNewVehicle(type, buildingId, owner) {
    const b = this.buildings[buildingId - 1];
    const d = b?.doors.find((x) => x.exterior);
    if (!d) return null;
    const stats = config.vehicles.types[type];
    const cx = d.x + d.w / 2;
    const cy = d.y + d.h / 2;
    const angle = Math.atan2(d.ny, d.nx) + Math.PI / 2; // parked along the front of the building
    for (const out of [stats.width + 80, stats.width + 200, stats.width + 320]) {
      for (const along of [0, 180, -180, 360, -360]) {
        const x = cx + d.nx * out - d.ny * along;
        const y = cy + d.ny * out + d.nx * along;
        const probe = { x, y, angle };
        const clear = vehicleCircles(probe, stats).every((c) => !this.isBlocked(c.x, c.y, c.r) && !this.isSwimming(c.x, c.y)) &&
          ![...this.vehicles.values()].some((o) => Math.hypot(o.x - x, o.y - y) < o.radius + stats.length / 2);
        if (!clear || x < stats.length || y < stats.length || x > this.width - stats.length || y > this.height - stats.length) continue;
        const v = new Vehicle(this.nextEntityId++, type, x, y, angle);
        v.owner = owner;
        v.fuel = 100;
        this.vehicles.set(v.id, v);
        this.grid.insert(v);
        return v;
      }
    }
    return null;
  }

  /**
   * Out of the garage: one of p's saved cars (`saved`: { id, type, color, fuel, cargo }) parked on
   * the car pad outside their home. If it's already out somewhere with nobody in it, it's brought back here.
   */
  bringCar(p, saved) {
    const home = this.homes.homeOf(p.account);
    if (!home) return 'no_home';
    if (!this.homes.atGarage(p)) return 'too_far';
    if (!config.vehicles.types[saved.type]) return 'unknown';
    const out = [...this.vehicles.values()].find((v) => v.carId === saved.id);
    if (out?.driver || out?.passenger) return 'car_in_use';
    if (out) {
      Object.assign(saved, { fuel: out.fuel, cargo: out.cargo.map((s) => s && { ...s }) });
      this.vehicles.delete(out.id);
    }
    const v = this.#parkOnPad(saved.type, this.homes.padOf(home), p) ?? this.parkNewVehicle(saved.type, home.id, p.account);
    if (!v) {
      if (out) this.vehicles.set(out.id, out); // nowhere to put it: leave it where it was
      return 'no_parking';
    }
    Object.assign(v, { carId: saved.id, color: saved.color, fuel: saved.fuel });
    saved.cargo.forEach((s, i) => { if (i < v.cargo.length) v.cargo[i] = trunkSlot(s); });
    p.lastVehicle = v;
    return null;
  }

  /** A new vehicle for p parked on a car pad, if nothing's in the way (p, standing on it, is nudged off). */
  #parkOnPad(type, pad, p) {
    if (!pad) return null;
    const stats = config.vehicles.types[type];
    const x = pad.x + pad.w / 2, y = pad.y + pad.h / 2;
    const probe = { x, y, angle: pad.angle };
    const circles = vehicleCircles(probe, stats);
    if (circles.some((c) => this.isBlocked(c.x, c.y, c.r)) || [...this.vehicles.values()].some((o) => Math.hypot(o.x - x, o.y - y) < o.radius + stats.length / 2)) return null;
    const v = new Vehicle(this.nextEntityId++, type, x, y, pad.angle);
    v.owner = p.account;
    v.fuel = 100;
    this.vehicles.set(v.id, v);
    this.grid.insert(v);
    // Step off the pad, to whichever long side you're on.
    const side = pad.w > pad.h ? (p.y < y ? -1 : 1) : (p.x < x ? -1 : 1);
    const off = Math.min(pad.w, pad.h) / 2 + p.radius + 12;
    if (circles.some((c) => Math.hypot(c.x - p.x, c.y - p.y) < c.r + p.radius)) {
      if (pad.w > pad.h) p.y = y + side * off; else p.x = x + side * off;
    }
    return v;
  }

  /**
   * The car radio (driver or passenger): V switches it on or off, N skips to the next song. Everyone
   * near the car hears it (see the client), from the same point in the song.
   */
  radio(p, action) {
    const v = p.vehicle;
    if (!v) return 'not_in_car';
    const now = this.economy.time;
    const durations = World.radioDurations();
    if (action === 'toggle') {
      if (v.radio) v.lastSong = radioAt(v.radio.song, now - v.radio.since, durations).index; // (back on, it picks up from that song)
      v.radio = v.radio ? null : { song: v.lastSong ?? 0, since: now };
      return null;
    }
    if (action === 'next') {
      // The one after whatever it's on now (it's been playing through the playlist since it started).
      const song = v.radio ? radioAt(v.radio.song, now - v.radio.since, durations).index + 1 : v.lastSong ?? 0;
      v.radio = { song, since: now };
      v.lastSong = song;
      return null;
    }
    return 'unknown';
  }

  /**
   * H: the siren of a Militsiya car you're driving, on or off. While it wails, the Militsiya know
   * exactly where you are and come for you (see Police.step).
   */
  toggleSiren(p) {
    const v = p.vehicle;
    if (v?.driver !== p) return 'not_driving';
    if (!v.police) return 'no_siren';
    v.siren = !v.siren;
    return null;
  }

  /** C: headlights on or off (driver only). */
  toggleLights(p) {
    if (p.vehicle?.driver !== p) return 'not_driving';
    p.vehicle.lights = !p.vehicle.lights;
    return null;
  }

  /** Q: drop the selected hotbar slot (goods or a found gun; the starting knife stays) at your feet. */
  drop(p, index = p.selected) {
    if (p.vehicle) return 'in_vehicle';
    const slot = p.inventory[index];
    if (!slot) return 'nothing_to_drop';
    if (slot.type === STARTER_WEAPON) return 'cant_drop_starter';
    if (slot.food) return 'cant_drop_food'; // eat it (E)
    if (slot.tool && slot.type !== 'rod') return 'cant_drop_tool'; // it's the foreman's (a fishing rod drops like a gun)
    p.inventory[index] = null;
    const pickup = slot.good
      ? new Pickup(this.nextEntityId++, p.x, p.y, null, 0, { good: slot.good, qty: slot.qty })
      : new Pickup(this.nextEntityId++, p.x, p.y, { ...slot, reloadTimer: 0 });
    pickup.droppedBy = p;
    pickup.noPickupUntil = this.tick + Math.round(config.cargo.dropPickupDelaySec * config.tickRate);
    this.pickups.set(pickup.id, pickup);
    this.grid.insert(pickup);
    return null;
  }

  /** X: drop some of your cash at your feet, for anyone to pick up. Returns how much, or an error. */
  dropCash(p, amount) {
    if (p.vehicle) return 'in_vehicle';
    const cash = Math.min(amount, p.cash);
    if (cash <= 0) return 'no_cash';
    p.cash -= cash;
    const bag = new Pickup(this.nextEntityId++, p.x, p.y, null, cash);
    bag.droppedBy = p;
    bag.noPickupUntil = this.tick + Math.round(config.cargo.dropPickupDelaySec * config.tickRate);
    this.pickups.set(bag.id, bag);
    this.grid.insert(bag);
    return cash;
  }

  /**
   * Trunks, only from the driver's seat: 'take' moves trunk slot `slot` into your hotbar, 'put' moves
   * hotbar slot `slot` into the trunk — as much as fits. A gun takes a whole slot either way (it keeps
   * its ammo). (Markets still use a nearby car's trunk.)
   */
  trunk(p, id, action, slot) {
    const v = this.vehicles.get(id);
    if (!v || p.vehicle !== v) return 'get_in';
    if (action !== 'take' && action !== 'put') return 'unknown';
    const [from, to, list] = action === 'take' ? [trunkOf(v), hotbarOf(p), v.cargo] : [hotbarOf(p), trunkOf(v), p.inventory];
    const stack = list[slot];
    const rod = stack?.type === 'rod';
    if (rod || (stack?.type && config.weapons[stack.type] && !stack.tool)) {
      const into = action === 'take' ? p.inventory : v.cargo;
      const free = into.indexOf(null);
      if (free < 0) return 'no_room';
      if (rod) into[free] = action === 'take' ? { type: 'rod', tool: true } : { type: 'rod' };
      else into[free] = { ...(action === 'take' ? makeWeapon(stack.type) : { type: stack.type }), ammo: stack.ammo, ...(stack.illegal ? { illegal: true } : {}) };
      list[slot] = null;
      return null;
    }
    if (!stack?.good) return 'nothing_there';
    const moved = Math.min(stack.qty, to.room(stack.good));
    if (moved <= 0) return 'no_room';
    from.add(stack.good, -moved);
    to.add(stack.good, moved);
    return null;
  }

  /** In water and not on a bridge. */
  isSwimming(x, y) {
    return isSwimming(this.water, this.roads, x, y, this.frozen);
  }

  isOnIce(x, y) {
    return onIce(this.water, x, y, this.frozen);
  }

  /** A random dry spot a circle of radius r fits, optionally inside a random building. */
  randomOpenPoint(r, insideBuilding = false) {
    for (let i = 0; i < 50; i++) {
      let x;
      let y;
      if (insideBuilding && this.buildings.length) {
        const b = this.buildings[Math.floor(Math.random() * this.buildings.length)];
        x = randRange(b.x + 30, b.x + b.w - 30);
        y = randRange(b.y + 30, b.y + b.h - 30);
      } else {
        x = randRange(100, this.width - 100);
        y = randRange(100, this.height - 100);
      }
      if (!this.isBlocked(x, y, r) && !this.isSwimming(x, y)) return { x, y };
    }
    return { x: this.width / 2, y: this.height / 2 };
  }

  /** Drops a random gun (weighted by spawnWeight) at (x, y), or at a random open spot — half the time inside a building. */
  spawnPickup(x = null, y = null, weapon = null) {
    if (x === null) ({ x, y } = this.randomOpenPoint(this.opts.pickupRadius, Math.random() < 0.5));
    if (!weapon) {
      const types = Object.keys(this.weapons).filter((t) => this.weapons[t].spawnWeight > 0);
      let roll = Math.random() * types.reduce((sum, t) => sum + this.weapons[t].spawnWeight, 0);
      const type = types.find((t) => (roll -= this.weapons[t].spawnWeight) < 0) ?? types[0];
      weapon = makeWeapon(type);
    }
    const pickup = new Pickup(this.nextEntityId++, x, y, weapon);
    this.pickups.set(pickup.id, pickup);
    return pickup;
  }

  spawnFood() {
    const { x, y } = this.randomOpenPoint(6);
    const f = new Food(this.nextEntityId++, x, y);
    this.food.set(f.id, f);
    return f;
  }

  /** A new player: at home if `account` has one (see Homes), otherwise somewhere open. */
  spawnPlayer(name, look = null, account = null) {
    const home = this.homes.homeOf(account);
    const { x, y } = home ? this.homes.spawnPoint(home) : this.#findSpawnPoint();
    const p = new Player(this.nextEntityId++, name, x, y, look);
    this.players.set(p.id, p);
    return p;
  }

  /** Out of whichever seat p has (driver or passenger), wherever the car is. */
  leaveSeat(p) {
    const v = p.vehicle;
    if (!v) return;
    if (v.driver === p && v.police && p.kind === 'player') v.siren = false; // (a thief's siren stops when they get out)
    if (v.driver === p) v.driver = null;
    if (v.passenger === p) v.passenger = null;
    p.vehicle = null;
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    if (p.vehicle) this.leaveSeat(p);
    p.alive = false;
    this.players.delete(id);
    if (p.carrying) {
      p.carrying.carriedBy = null;
      p.carrying = null;
    }
    if (p.health <= 0) {
      // Died: everything they carried (goods, found guns, cash) stays on the body, for anyone to loot.
      this.bodies.add({
        x: p.x, y: p.y, angle: p.input.aim ?? 0, kind: 'player', name: p.name, victimId: p.id,
        look: [p.look.skin, p.look.shirt, p.look.pants, p.look.hat],
        items: p.inventory.map((s) => (s && s.type !== STARTER_WEAPON && (!s.tool || s.type === 'rod') ? (s.good || s.food ? { ...s } : { ...s, reloadTimer: 0 }) : null)),
        cash: p.cash,
      });
      p.cash = 0;
      p.inventory = p.inventory.map((s) => (s?.type === STARTER_WEAPON ? s : null));
      return;
    }
    // Goods carried in the hotbar are lost; found guns are dropped below.
    p.inventory = p.inventory.map((s) => (s?.good ? null : s));
    // Carried cash falls to the ground for anyone to grab.
    if (p.cash > 0) {
      const bag = new Pickup(this.nextEntityId++, p.x, p.y, null, p.cash);
      this.pickups.set(bag.id, bag);
      p.cash = 0;
    }
    // Found guns fall where the player was, spread out a little.
    const found = p.inventory.filter((w) => w?.type && w.type !== STARTER_WEAPON && !w.tool); // (food is just lost)
    found.forEach((w, i) => {
      const a = (i / found.length) * Math.PI * 2;
      w.reloadTimer = 0;
      this.spawnPickup(clamp(p.x + Math.cos(a) * 40, 0, this.width), clamp(p.y + Math.sin(a) * 40, 0, this.height), w);
    });
  }

  #findSpawnPoint() {
    const safeSq = this.playerOpts.spawnSafeDistance ** 2;
    let best = null;
    let bestDist = -1;
    for (let i = 0; i < 20; i++) {
      const { x, y } = this.randomOpenPoint(this.playerOpts.startMass ** 0.5 * 4 + 10);
      let nearest = Infinity;
      for (const p of this.players.values()) nearest = Math.min(nearest, distSq(x, y, p.x, p.y));
      if (nearest >= safeSq) return { x, y };
      if (nearest > bestDist) [best, bestDist] = [{ x, y }, nearest];
    }
    return best;
  }

  rebuildGrid() {
    this.grid.clear();
    for (const f of this.food.values()) this.grid.insert(f);
    for (const p of this.players.values()) this.grid.insert(p);
    for (const g of this.pickups.values()) this.grid.insert(g);
    for (const v of this.vehicles.values()) this.grid.insert(v);
  }

  /**
   * Advance the simulation by `dt` seconds.
   * @returns {{ deaths: Array<{ victim: Player, killer: Player }> }}
   */
  step(dt) {
    this.tick++;
    const doorChanges = this.#handleUse();
    this.#movePlayers(dt);
    this.#bumpNpcs();
    this.work.step(dt);
    this.#moveVehicles(dt);
    this.#fireGuns(dt);
    this.rebuildGrid();
    const explosions = [];
    const deaths = this.#resolveCollisions(dt);
    deaths.push(...this.#moveBullets(dt, explosions), ...this.meleeDeaths.splice(0));

    this.economy.step(dt);
    this.warehouses.step(dt);
    this.homes.step(dt);
    this.roadblocks.step(dt);
    if (this.railway) {
      const { killed, wrecked } = this.railway.step(dt);
      for (const v of wrecked) if (this.vehicles.has(v.id)) this.#destroyVehicle(v, { name: 'the train' }, deaths, explosions);
      for (const p of killed) {
        if (!p.alive) continue;
        this.removePlayer(p.id);
        deaths.push({ victim: p, killer: { name: 'the train' } });
      }
    }
    this.#digest(dt);
    this.fishing.step(dt);
    this.townsfolk.step(dt);
    for (const p of this.townsfolk.kills.splice(0)) { // beaten by a townsperson who fought back
      if (!p.alive) continue;
      this.removePlayer(p.id);
      deaths.push({ victim: p, killer: { name: 'a townsperson' } });
    }
    this.hires.step(dt);
    for (const p of this.players.values()) p.arrest = 0;
    this.police.step(dt);
    this.prison.step(dt);
    for (const { victim, killer } of deaths) this.bodies.setKiller(victim.id, killer);
    this.bodies.step(dt);
    doorChanges.push(...this.pendingDoors.splice(0));

    for (let i = this.vehicleRespawns.length - 1; i >= 0; i--) {
      this.vehicleRespawns[i] -= dt;
      if (this.vehicleRespawns[i] <= 0 && this.spawnVehicle()) this.vehicleRespawns.splice(i, 1);
    }
    while (this.food.size < this.opts.foodCount) this.grid.insert(this.spawnFood());

    this.pickupTimer += dt;
    if (this.pickupTimer >= this.opts.pickupIntervalSec) {
      this.pickupTimer = 0;
      if (this.pickups.size < this.opts.pickupMax) this.grid.insert(this.spawnPickup());
    }
    return { deaths, doorChanges, explosions };
  }

  /** Is `door` locked to p: someone else's warehouse or a home that isn't theirs (lock not picked)? */
  lockedFor(door, p) {
    return this.warehouses.lockedFor(door, p) || this.homes.lockedFor(door, p) || this.prison.lockedFor(door);
  }

  /** A door locked to p within reach, for lock picking. */
  lockedDoorNear(p, reach = 90) {
    for (const d of this.doors) {
      if (d.open || !this.lockedFor(d, p) || this.prison.keyOnly(d)) continue; // (the prison's inner door: only a guard's key)
      if (Math.hypot(d.x + d.w / 2 - p.x, d.y + d.h / 2 - p.y) < reach + p.radius) return d;
    }
    return null;
  }

  /** Someone else's car (or a Militsiya one) is locked to you (not their teammates) until its lock is picked. */
  carLockedFor(v, p) {
    if (v.police) return !v.picked;
    if (!v.owner || v.owner === p.account || v.picked) return false;
    const owner = [...this.players.values()].find((o) => o.account === v.owner);
    return !(owner && this.areTeammates(owner, p));
  }

  /** A car locked to p within reach (and nobody in it), for lock picking. */
  lockedCarNear(p) {
    let best = null;
    let bestDist = config.vehicles.reach;
    for (const v of this.vehicles.values()) {
      if (v.driver || v.passenger || !this.carLockedFor(v, p)) continue;
      const d = this.#vehicleDistance(v, p.x, p.y) - p.radius;
      if (d < bestDist) [best, bestDist] = [v, d];
    }
    return best;
  }

  /**
   * The heading a walker at (x, y) should take to go `angle` without walking into a car: if a car body
   * is right in front of them, they turn to skirt round its edge (on whichever side is nearer their
   * way) rather than pressing into it and being shoved straight back. `except` is a car they're
   * walking up to on purpose.
   */
  steerAroundCars(x, y, angle, except = null) {
    const r = config.townsfolk.bodyRadius + 4;
    const fx = Math.cos(angle), fy = Math.sin(angle);
    let worst = null;
    for (const v of this.carGrid.query(x, y, r, this.#near.clear() ?? this.#near)) {
      if (v === except || Math.abs(v.x - x) > v.radius + r || Math.abs(v.y - y) > v.radius + r) continue;
      for (const c of vehicleCircles(v, v.stats)) {
        const dx = c.x - x, dy = c.y - y;
        const gap = Math.hypot(dx, dy) - c.r - r;
        if (gap > 0 || dx * fx + dy * fy <= 0) continue; // not touching, or already heading away
        if (!worst || gap < worst.gap) worst = { dx, dy, gap };
      }
    }
    if (!worst) return angle;
    const toCar = Math.atan2(worst.dy, worst.dx);
    const side = worst.dx * fy - worst.dy * fx >= 0 ? 1 : -1; // which way round is closer to where they're going
    return toCar + (side * Math.PI) / 2;
  }

  /** The key an ATM goes by (robberies, breakages): 'atm:x,y'. */
  atmKey(a) {
    return `atm:${Math.round(a.x)},${Math.round(a.y)}`;
  }

  /** Is this ATM smashed (a bat) and not mended yet? */
  atmBroken(a) {
    return (this.brokenAtms.get(this.atmKey(a)) ?? -Infinity) > this.economy.time;
  }

  /** ATMs smashed and not mended yet: [x, y, seconds until they work again] (for everyone to see). */
  brokenAtmList() {
    const now = this.economy.time;
    return this.atms.filter((a) => this.atmBroken(a)).map((a) => [Math.round(a.x), Math.round(a.y), Math.ceil(this.brokenAtms.get(this.atmKey(a)) - now)]);
  }

  /** A bat swung at an ATM: after enough hits it spills its cash and stays broken a while. A robbery (if seen). */
  #smashAtm(p, atm) {
    const rule = config.robbery.atmSmash;
    const key = this.atmKey(atm);
    if (this.atmBroken(atm)) return void this.police.events.push({ player: p, kind: 'error', code: 'atm_broken' });
    if (p.atmHits?.key !== key) p.atmHits = { key, n: 0 };
    p.atmHits.n++;
    if (p.atmHits.n === 1) this.police.crime(p, 'rob_atm'); // (only if someone sees it)
    if (p.atmHits.n < rule.hits) return void this.police.events.push({ player: p, kind: 'atm_hit', n: p.atmHits.n, of: rule.hits });
    p.atmHits = null;
    const take = Math.round(rule.min + Math.random() * (rule.max - rule.min));
    p.cash += take;
    this.brokenAtms.set(key, this.economy.time + rule.brokenSec);
    this.police.robCooldown.set(key, this.economy.time + rule.brokenSec);
    (p.robbedAtms ??= new Map()).set(key, this.economy.time + rule.brokenSec);
    this.atmsChanged = true;
    this.police.events.push({ player: p, kind: 'atm_smashed', amount: take, sec: rule.brokenSec });
  }

  /** Distance from a point to the edge of a vehicle's body (negative = inside). */
  #vehicleDistance(v, x, y) {
    return Math.min(...vehicleCircles(v, v.stats).map((c) => Math.hypot(c.x - x, c.y - y) - c.r));
  }

  /**
   * A stolen car taken back by the Militsiya: everyone's put out beside it. A saved car goes back to
   * its owner's garage (trunk and all); any other is left parked there, locked again.
   */
  impound(v) {
    for (const p of [v.driver, v.passenger]) if (p && !this.#exitVehicle(p)) this.leaveSeat(p);
    Object.assign(v, { vx: 0, vy: 0, picked: false });
    if (v.carId) {
      this.vehicles.delete(v.id);
      this.onCarLost?.(v);
    }
  }

  /** Gets the driver out beside the vehicle. Returns false if every side is blocked. */
  #exitVehicle(p) {
    const v = p.vehicle;
    const { length, width } = v.stats;
    const r = p.radius;
    const cos = Math.cos(v.angle);
    const sin = Math.sin(v.angle);
    const side = width / 2 + r + 8;
    const end = length / 2 + r + 8;
    for (const [ox, oy] of [[0, -side], [0, side], [-end, 0], [end, 0]]) {
      const x = v.x + cos * ox - sin * oy;
      const y = v.y + sin * ox + cos * oy;
      if (x < r || y < r || x > this.width - r || y > this.height - r || this.isBlocked(x, y, r)) continue;
      if ([...this.vehicles.values()].some((o) => o !== v && this.#vehicleDistance(o, x, y) < r)) continue;
      p.x = x;
      p.y = y;
      this.leaveSeat(p);
      p.lastVehicle = v;
      return true;
    }
    return false;
  }

  /**
   * E: drivers get out; everyone else uses the nearest door or vehicle in reach.
   * Returns the doors that changed.
   */
  #handleUse() {
    const changed = [];
    for (const p of this.players.values()) {
      if (!p.input.use) continue;
      p.input.use = false;
      if (p.jailed && !p.jailed.prison) continue; // (in the prison you get about inside the wire)
      if (p.hidden) {
        this.unhide(p);
        continue;
      }
      if (p.vehicle) {
        this.#exitVehicle(p);
        continue;
      }
      const reach = p.radius + this.opts.doorReach;
      let best = null;
      let bestDist = Infinity;
      for (const e of this.wallGrid.query(p.x, p.y, reach)) {
        if (!e.door) continue;
        const d = e.door;
        const cx = clamp(p.x, d.x, d.x + d.w);
        const cy = clamp(p.y, d.y, d.y + d.h);
        const dist = Math.hypot(p.x - cx, p.y - cy);
        if (dist < reach && dist < bestDist) [best, bestDist] = [d, dist];
      }
      for (const v of this.vehicles.values()) {
        if (p.carrying) continue; // put the body down first
        if (v.driver && (v.passenger || v.driver.kind !== 'player')) continue; // both seats taken
        if (!v.driver && v.passenger) continue; // (the passenger can climb over; not you)
        const dist = this.#vehicleDistance(v, p.x, p.y) - p.radius;
        if (dist < config.vehicles.reach && dist < bestDist) [best, bestDist] = [v, dist];
      }
      // A dumpster to hide in (not with a body over your shoulder).
      if (!p.carrying) {
        for (const d of this.dumpsters) {
          const dist = Math.hypot(Math.max(d.x - p.x, 0, p.x - (d.x + d.w)), Math.max(d.y - p.y, 0, p.y - (d.y + d.h))) - p.radius;
          if (dist < reach - p.radius && dist < bestDist) [best, bestDist] = [{ dumpster: d }, dist];
        }
      }
      if (!best) continue;
      if (best.dumpster) {
        this.hideIn(p, best.dumpster);
        continue;
      }
      if (best.kind === 'vehicle' && this.carLockedFor(best, p)) {
        this.police.events.push({ player: p, kind: 'error', code: 'car_locked' });
        continue;
      }
      if (best.kind === 'vehicle' && best.driver) { // someone's driving: hop in beside them
        best.passenger = p;
        p.vehicle = best;
        p.x = best.x;
        p.y = best.y;
        continue;
      }
      if (best.kind === 'vehicle') {
        if (best.police) this.police.crime(p, 'steal_police_car', true); // the radio's in it: they always know
        else if (best.owner && best.owner !== p.account) this.police.crime(p, 'steal_car');
        if (best.owner && best.owner === p.account) best.picked = false; // back in your own car: locked again
        best.driver = p;
        best.lights = true; // headlights on as you set off (C toggles them)
        p.vehicle = best;
        p.lastVehicle = best;
        p.x = best.x;
        p.y = best.y;
        continue;
      }
      if (this.prison.useKey(best, p)) continue; // a guard's key in the inner fence's door
      if (this.lockedFor(best, p)) {
        this.police.events.push({ player: p, kind: 'error', code: this.prison.keyOnly(best) ? 'prison_key_door' : this.prison.isPrisonDoor(best) ? 'prison_pick_door' : 'locked' });
        continue;
      }
      // Don't shut a door on someone standing in the doorway.
      if (best.open && [...this.players.values()].some((o) => pushCircleOutOfRect({ x: o.x, y: o.y }, o.radius, best))) continue;
      best.open = !best.open;
      changed.push(best);
    }
    return changed;
  }

  #movePlayers(dt) {
    const o = this.playerOpts;
    const { massShrinkPerSec, startMass } = o;

    for (const p of this.players.values()) {
      const { angle, boost } = p.input;
      const throttle = p.vehicle || (p.jailed && !p.jailed.prison) || p.hidden ? 0 : p.input.throttle; // drivers use gas/steer instead; prisoners and the hidden stay put
      const swimming = !p.vehicle && this.isSwimming(p.x, p.y);
      let speed = p.speed * throttle * (swimming ? o.swimSpeed : 1) * (p.carrying ? config.bodies.carrySpeed : 1); // keep in sync with the client

      // Keep in sync with stepMove() in public/index.html, which predicts this on the client.
      if (boost && !swimming && throttle > 0 && !p.exhausted && p.stamina > 0) {
        speed *= o.sprintMultiplier;
        p.stamina = Math.max(0, p.stamina - o.staminaDrainPerSec * dt);
        p.staminaDelay = o.staminaRegenDelaySec;
        if (p.stamina === 0) p.exhausted = true;
      } else {
        p.staminaDelay = Math.max(0, p.staminaDelay - dt);
        if (p.staminaDelay === 0) p.stamina = Math.min(o.staminaMax, p.stamina + o.staminaRegenPerSec * dt);
        if (p.exhausted && p.stamina >= o.staminaMinToSprint) p.exhausted = false;
      }

      p.mass -= (p.mass - startMass) * massShrinkPerSec * dt; // overeating wears off
      p.mass = Math.max(p.mass, startMass);
      p.health = Math.min(p.health, p.maxHealth); // shrinking lowers the cap

      // On ice you keep sliding: your velocity only slowly comes round to where you're trying to go.
      const ice = !p.vehicle && this.isOnIce(p.x, p.y);
      const wantX = Math.cos(angle) * speed, wantY = Math.sin(angle) * speed;
      if (ice) {
        const k = 1 - Math.exp(-o.iceGrip * dt);
        p.vx += (wantX - p.vx) * k;
        p.vy += (wantY - p.vy) * k;
      } else [p.vx, p.vy] = [wantX, wantY];
      const r = p.radius;
      const fromX = p.x, fromY = p.y;
      // Knocked flying by a car: a slide that dies away fast (walls stop it). Keep in sync with the client.
      const [kx, ky] = knockStep(p, dt);
      p.x = clamp(p.x + (p.vx + kx) * dt, r, this.width - r);
      p.y = clamp(p.y + (p.vy + ky) * dt, r, this.height - r);
      // Two passes settle corners where two walls meet. (Someone in a dumpster is inside its walls.)
      if (!p.hidden) for (let pass = 0; pass < 2; pass++) for (const w of this.wallsNear(p.x, p.y, r)) pushCircleOutOfRect(p, r, w);
      if (ice && dt > 0) [p.vx, p.vy] = [(p.x - fromX) / dt, (p.y - fromY) / dt]; // walls stop the slide
    }
  }

  #moveVehicles(dt) {
    // Vehicles can't go into water (bridges are fine).
    const collide = (c) => {
      let moved = pushOutOfWater(this.water, this.roads, c);
      for (const w of this.wallsNear(c.x, c.y, c.r)) if (pushCircleOutOfRect(c, c.r, w)) moved = true;
      return moved;
    };
    for (const v of this.vehicles.values()) {
      const d = v.driver;
      // Players drive with their input; police cruisers with the police AI's.
      const input = d ? d.input : v.ai ?? null;
      // Parked and still (most of them): nothing to simulate until something drives or shoves it.
      v.idle = !input && Math.abs(v.vx) + Math.abs(v.vy) < 1;
      if (v.idle) {
        v.vx = v.vy = 0;
        v.slipping = false;
        continue;
      }
      // An empty tank means no gas (braking and reversing still work). Keep in sync with the client.
      const gas = input ? (v.fuel > 0 || v.police ? input.gas : emptyTankGas(v, input.gas)) : 0;
      const fromX = v.x;
      const fromY = v.y;
      // Out of town (gravel, grass, snow) cars grip less than on city asphalt. Keep in sync with the client.
      const surface = !this.city || inBox(this.city, v.x, v.y) ? 1 : config.vehicles.gravelGrip;
      // Space with vodka in the boost tank (players only): burn it.
      v.boosting = Boolean(d && !v.police && input.boost && v.boost > 0 && gas > 0);
      if (v.boosting) v.boost = Math.max(0, v.boost - config.vehicles.boost.burnPerSec * dt);
      stepVehicle(v, v.stats, gas, input?.steer ?? 0, input?.drift ?? false, dt, this, collide, this.gripScale * surface, v.boosting);
      if ((d || v.stolenBy) && !v.police) v.fuel = Math.max(0, v.fuel - Math.hypot(v.x - fromX, v.y - fromY) * config.fuel.perUnit); // (a gangster joyriding burns it too)
      v.slipping = Math.abs(vehicleMotion(v).lateral) > 90;
      if (d) {
        d.x = v.x;
        d.y = v.y;
      }
    }
    for (const v of this.vehicles.values()) {
      if (!v.passenger) continue;
      v.passenger.x = v.x;
      v.passenger.y = v.y;
    }

    this.carGrid.clear();
    for (const v of this.vehicles.values()) this.carGrid.insert(v);
    this.#shovePedestrians();

    // Vehicles shove each other apart and lose speed when they collide (two parked cars never do).
    for (const a of this.vehicles.values()) {
      for (const b of this.carGrid.query(a.x, a.y, a.radius, this.#near.clear() ?? this.#near)) {
        if (b.id <= a.id || (a.idle && b.idle)) continue; // (each pair once)
        const reach = a.radius + b.radius;
        if (Math.abs(a.x - b.x) > reach || Math.abs(a.y - b.y) > reach || Math.hypot(a.x - b.x, a.y - b.y) > reach) continue;
        for (const ca of vehicleCircles(a, a.stats)) {
          for (const cb of vehicleCircles(b, b.stats)) {
            const dx = cb.x - ca.x;
            const dy = cb.y - ca.y;
            const dist = Math.hypot(dx, dy) || 1;
            const overlap = ca.r + cb.r - dist;
            if (overlap <= 0) continue;
            a.x -= (dx / dist) * overlap * 0.5;
            a.y -= (dy / dist) * overlap * 0.5;
            b.x += (dx / dist) * overlap * 0.5;
            b.y += (dy / dist) * overlap * 0.5;
            for (const car of [a, b]) {
              car.vx *= 0.7;
              car.vy *= 0.7;
            }
          }
        }
      }
    }
  }

  /** Players on foot bump townsfolk and officers out of their way (people don't walk through people). */
  #bumpNpcs() {
    const r = config.townsfolk.bodyRadius;
    const walkers = [...this.townsfolk.people.filter((t) => t.inside <= 0), ...this.police.units.map((u) => u.officer).filter((o) => o.onFoot && o.health > 0), ...this.hires.list.filter((h) => !h.vehicle)];
    for (const p of this.players.values()) {
      if (p.vehicle || !p.alive) continue;
      for (const w of walkers) {
        const dx = w.x - p.x;
        const dy = w.y - p.y;
        const reach = p.radius + r;
        if (Math.abs(dx) > reach || Math.abs(dy) > reach) continue;
        const dist = Math.hypot(dx, dy) || 1;
        if (dist >= reach) continue;
        w.x += (dx / dist) * (reach - dist);
        w.y += (dy / dist) * (reach - dist);
      }
    }
  }

  /**
   * Cars and NPCs on foot (townsfolk, officers) don't pass through each other: the NPC is pushed out of
   * the way and the car loses a touch of speed. Nobody is hurt and it's no crime.
   */
  #shovePedestrians() {
    const walkers = [
      ...this.townsfolk.people.filter((t) => t.inside <= 0),
      ...this.police.units.map((u) => u.officer).filter((o) => o.onFoot && o.health > 0),
      ...this.hires.list.filter((h) => !h.vehicle),
    ];
    const r = config.townsfolk.bodyRadius;
    for (const w of walkers) {
      for (const v of this.carGrid.query(w.x, w.y, r, this.#near.clear() ?? this.#near)) {
        if (Math.abs(w.x - v.x) > v.radius + r || Math.abs(w.y - v.y) > v.radius + r) continue;
        for (const c of vehicleCircles(v, v.stats)) {
          const dx = w.x - c.x;
          const dy = w.y - c.y;
          const dist = Math.hypot(dx, dy) || 1;
          const overlap = c.r + r - dist;
          if (overlap <= 0) continue;
          w.x += (dx / dist) * overlap;
          w.y += (dy / dist) * overlap;
          v.vx *= 0.92;
          v.vy *= 0.92;
        }
      }
    }
  }

  /** A vehicle at 0 health blows up: whoever is in it is thrown out and hurt, and a new one turns up later. */
  #destroyVehicle(v, attacker, deaths, explosions) {
    this.vehicles.delete(v.id);
    if (v.carId) { // a saved car: it's back in the owner's garage (insured), but not what was in the trunk
      v.cargo.fill(null);
      this.onCarLost?.(v);
    } else this.vehicleRespawns.push(config.vehicles.respawnSec);
    explosions.push({ x: Math.round(v.x), y: Math.round(v.y) });
    for (const p of [v.driver, v.passenger]) {
      if (!p) continue;
      if (!this.#exitVehicle(p)) this.leaveSeat(p);
      p.hurt(config.vehicles.exitDamage);
      if (p.health <= 0) {
        this.removePlayer(p.id);
        deaths.push({ victim: p, killer: attacker });
      }
    }
  }

  #fireGuns(dt) {
    for (const p of this.players.values()) {
      p.shotCooldown = Math.max(0, p.shotCooldown - dt);
      const gun = p.vehicle || p.jailed || p.carrying || p.hidden ? null : p.weapon; // no shooting while driving, in a cell or with your hands full
      const reloadRequested = p.input.reload;
      p.input.reload = false;
      if (!gun) continue; // empty hand

      const stats = this.weapons[gun.type];
      if (stats.melee) {
        if (!p.input.fire || p.shotCooldown > 0) continue;
        p.shotCooldown = stats.cooldownSec;
        this.#stab(p, stats);
        continue;
      }
      if (gun.reloadTimer > 0) {
        gun.reloadTimer = Math.max(0, gun.reloadTimer - dt);
        if (gun.reloadTimer === 0) gun.ammo = stats.magazineSize;
      }
      if (reloadRequested && gun.reloadTimer === 0 && gun.ammo < stats.magazineSize) gun.reloadTimer = stats.reloadSec;
      if (!p.input.fire || p.shotCooldown > 0 || gun.reloadTimer > 0 || gun.ammo === 0) continue;

      p.shotCooldown = stats.cooldownSec;
      gun.ammo--;
      if (gun.ammo === 0) gun.reloadTimer = stats.reloadSec; // empty: reload automatically
      // Bullets leave from the drawn barrel tip, clear of the shooter.
      const offset = p.radius * stats.barrel + config.bulletRadius;
      const { aim } = p.input;
      const sx = p.x + Math.cos(aim) * offset;
      const sy = p.y + Math.sin(aim) * offset;
      // Pressed against a wall: the shot hits the wall (the ammo is still spent).
      if (this.wallsNear(sx, sy, offset, true).some((w) => segmentRectHit(p.x, p.y, sx, sy, w, config.bulletRadius) !== null)) continue;
      for (let i = 0; i < stats.pellets; i++) {
        const angle = aim + (Math.random() - 0.5) * stats.spread;
        const b = new Bullet(this.nextEntityId++, p, sx, sy, angle, gun.type);
        this.bullets.set(b.id, b);
      }
      // Gunfire draws attention (checked at most once a second).
      if ((p.nextFireCrime ?? 0) <= this.economy.time) {
        p.nextFireCrime = this.economy.time + 1;
        this.police.crime(p, 'fire');
      }
    }
  }

  /** A townsperson hurt by player `attacker`: a crime, a body if they die, a fight if they don't. */
  #hurtTownsperson(person, damage, attacker) {
    const died = this.townsfolk.damage(person, damage);
    this.hires.noteAttack(attacker, person); // your goons join in
    this.police.crime(attacker, died ? 'murder' : 'assault');
    if (died) {
      this.bodies.add({ x: person.x, y: person.y, angle: person.angle ?? 0, kind: 'npc', look: [person.id * 7, person.id * 3, person.id * 5, person.id * 11], cash: person.wallet ?? 0, killer: attacker?.kind === 'player' ? attacker : null });
    } else this.townsfolk.provoke(person, attacker);
  }

  /**
   * A knife: stab whoever's nearest in front of you, within reach — a player, a townsperson or an
   * officer on foot. Each stab takes a share of their max health (three stabs kill).
   */
  #stab(p, base) {
    // A bat hits harder the bigger you are.
    const size = base.sizeScale ? clamp(p.radius / massToRadius(this.playerOpts.startMass), ...base.sizeRange) : 1;
    const stats = { ...base, share: base.share * size };
    const aim = p.input.aim ?? 0;
    const inFront = (x, y, r) => {
      const dx = x - p.x, dy = y - p.y;
      const d = Math.hypot(dx, dy) - r - p.radius;
      if (d > stats.reach) return Infinity;
      if (d > 4 && (dx * Math.cos(aim) + dy * Math.sin(aim)) / Math.hypot(dx, dy) < 0.5) return Infinity; // within about 60° of where you face
      return d;
    };
    let best = null, bestD = Infinity;
    const consider = (kind, ref, r) => {
      const d = inFront(ref.x, ref.y, r);
      if (d < bestD) [best, bestD] = [{ kind, ref }, d];
    };
    for (const o of this.players.values()) if (o !== p && o.alive && !o.vehicle && !o.hidden) consider('player', o, o.radius);
    for (const t of this.townsfolk.people) if (t.inside <= 0) consider('npc', t, 17);
    for (const u of this.police.units) if (u.officer.onFoot && u.officer.health > 0) consider('officer', u.officer, 20);
    for (const h of this.hires.list) if (!h.vehicle && h.employer !== p.account) consider('hire', h, h.radius);
    if (!best && base.sizeScale) { // nobody to hit: a bat swung at an ATM
      const atm = this.atms.find((a) => inFront(a.x, a.y, 16) < Infinity);
      if (atm) this.#smashAtm(p, atm);
      return;
    }
    if (!best) return;
    const t = best.ref;
    if (best.kind === 'officer') return this.police.damageOfficer(t, config.police.officerHealth * stats.share, p);
    if (best.kind === 'hire') return void this.hires.damage(t, config.hires.health * stats.share, p);
    this.hires.noteAttack(p, t);
    if (best.kind === 'npc') return this.#hurtTownsperson(t, config.townsfolk.health * stats.share + 0.01, p);
    t.hurt(t.maxHealth * stats.share + 0.01); // (+ a hair, so three stabs always do it)
    const killed = t.health <= 0;
    if (!this.police.lawful(p, t)) this.police.crime(p, killed ? 'murder' : 'assault');
    if (killed) {
      this.removePlayer(t.id);
      this.meleeDeaths.push({ victim: t, killer: p });
    }
  }

  /** Moves bullets and applies hits. Runs after the grid is rebuilt so it can query players. */
  #moveBullets(dt, explosions) {
    const deaths = [];
    const nearby = new Set();
    for (const b of this.bullets.values()) {
      const px = b.x;
      const py = b.y;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.ttl -= dt;
      if (b.ttl <= 0 || b.x < 0 || b.y < 0 || b.x > this.width || b.y > this.height) {
        this.bullets.delete(b.id);
        continue;
      }

      // Stop the path at the first wall it touches.
      let wallHit = false;
      const len = Math.hypot(b.x - px, b.y - py);
      for (const w of this.wallsNear((px + b.x) / 2, (py + b.y) / 2, len / 2 + b.radius, true)) {
        const t = segmentRectHit(px, py, b.x, b.y, w, b.radius);
        if (t === null) continue;
        wallHit = true;
        b.x = px + (b.x - px) * t;
        b.y = py + (b.y - py) * t;
      }

      // Hired muscle on foot (anyone's but the shooter's own side).
      const shooter = b.owner;
      const hire = this.hires.hitBy(px, py, b.x, b.y, b.radius, segmentDistSq, shooter);
      if (hire) {
        this.bullets.delete(b.id);
        this.hires.damage(hire, b.damage, shooter);
        continue;
      }
      // Officers on foot and townsfolk out walking.
      if (shooter.kind === 'player' || shooter.kind === 'hire') {
        const officer = shooter.role === 'gangster' ? null : this.police.officerHit(px, py, b.x, b.y, b.radius, segmentDistSq); // (gangsters and the Militsiya leave each other be)
        if (officer) {
          this.bullets.delete(b.id);
          this.police.damageOfficer(officer, b.damage, shooter);
          continue;
        }
        const person = this.townsfolk.hitBy(px, py, b.x, b.y, b.radius, segmentDistSq);
        if (person) {
          this.bullets.delete(b.id);
          this.#hurtTownsperson(person, b.damage, shooter);
          continue;
        }
      }

      nearby.clear();
      // Query the whole path travelled this tick so fast bullets can't skip past a player.
      this.grid.query((px + b.x) / 2, (py + b.y) / 2, Math.hypot(b.x - px, b.y - py) / 2 + b.radius, nearby);
      for (const p of nearby) {
        if (p.kind === 'vehicle') {
          if (!this.vehicles.has(p.id) || p === b.owner.vehicle) continue;
          if (shooter.kind === 'hire' && p.driver?.account === shooter.employer) continue; // not the boss's car
          const hit = vehicleCircles(p, p.stats).some((c) => segmentDistSq(px, py, b.x, b.y, c.x, c.y) < (c.r + b.radius) ** 2);
          if (!hit) continue;
          this.bullets.delete(b.id);
          p.health -= b.damage;
          if (p.driver && (shooter.kind === 'player' || shooter.kind === 'hire')) {
            if (!this.police.lawful(shooter, p.driver)) this.police.crime(shooter, 'assault');
            this.hires.noteAttack(shooter, p.driver);
          }
          if (p.health <= 0) this.#destroyVehicle(p, b.owner, deaths, explosions);
          break;
        }
        if (p.kind !== 'player' || !p.alive || p === b.owner || p.vehicle) continue;
        if (shooter.kind === 'hire' && p.account === shooter.employer) continue; // they don't hit their boss
        const reach = p.radius + b.radius;
        if (segmentDistSq(px, py, b.x, b.y, p.x, p.y) >= reach * reach) continue;
        this.bullets.delete(b.id);
        p.hurt(b.damage);
        const killed = p.health <= 0;
        if ((shooter.kind === 'player' || shooter.kind === 'hire') && !this.police.lawful(shooter, p)) this.police.crime(shooter, killed ? 'murder' : 'assault');
        this.hires.noteAttack(shooter, p);
        if (killed) {
          this.removePlayer(p.id);
          deaths.push({ victim: p, killer: b.owner });
        }
        break;
      }
      if (wallHit) this.bullets.delete(b.id);
    }
    return deaths;
  }

  #resolveCollisions(dt) {
    const deaths = [];
    const nearby = new Set();

    // Larger players resolve first so chains (A eats B eats C) are deterministic.
    const ordered = [...this.players.values()].sort((a, b) => b.mass - a.mass);

    for (const p of ordered) {
      p.hitCooldown = Math.max(0, p.hitCooldown - dt);
      if (!p.alive || p.vehicle) continue;
      nearby.clear();
      const r = p.radius;
      this.grid.query(p.x, p.y, r, nearby);

      for (const other of nearby) {
        if (other === p) continue;

        if (other.kind === 'vehicle') {
          this.#hitByVehicle(p, other, deaths);
          continue;
        }

        if (other.kind === 'pickup') {
          if (!this.pickups.has(other.id)) continue;
          const reach = r + other.radius;
          if (distSq(p.x, p.y, other.x, other.y) >= reach * reach) continue;
          if (other.droppedBy === p && this.tick < other.noPickupUntil) continue;
          if (other.goods) {
            // Goods go into the hotbar; whatever doesn't fit stays on the ground.
            const bar = hotbarOf(p);
            const take = Math.min(other.goods.qty, bar.room(other.goods.good));
            if (take > 0) {
              bar.add(other.goods.good, take);
              other.goods.qty -= take;
              if (other.goods.qty <= 0) this.pickups.delete(other.id);
            }
          } else if (other.cash) {
            p.cash += other.cash;
            this.pickups.delete(other.id);
          } else if (p.addWeapon(other.weapon)) { // (you can carry several of the same gun)
            this.pickups.delete(other.id);
          }
          continue;
        }

        if (other.kind === 'food') {
          if (!this.food.has(other.id)) continue;
          if (distSq(p.x, p.y, other.x, other.y) < r * r) {
            p.mass += other.mass;
            p.heal(this.opts.foodHeal ?? 0);
            this.food.delete(other.id);
          }
          continue;
        }

        // Players don't eat each other any more; they just overlap.
      }
    }
    return deaths;
  }

  /** Walking into a parked car pushes you aside; a fast one runs you over. */
  #hitByVehicle(p, v, deaths) {
    const r = p.radius;
    for (const c of vehicleCircles(v, v.stats)) {
      const dx = p.x - c.x;
      const dy = p.y - c.y;
      const dist = Math.hypot(dx, dy) || 1;
      const overlap = r + c.r - dist;
      if (overlap <= 0) continue;
      p.x += (dx / dist) * overlap;
      p.y += (dy / dist) * overlap;

      const { crush, maxSpeed } = v.stats;
      if (v.speed < config.vehicles.crushMinSpeed || p.hitCooldown > 0) continue;
      p.hitCooldown = 0.6;
      p.hurt(crush * Math.min(1, v.speed / maxSpeed));
      if (v.driver) this.hires.noteAttack(v.driver, p);
      // Sent flying away from the car (not too far): faster cars throw you further.
      const throwSpeed = clamp(v.speed * 1.1, 250, config.vehicles.knockMax);
      p.kx = (dx / dist) * throwSpeed + v.vx * 0.3;
      p.ky = (dy / dist) * throwSpeed + v.vy * 0.3;
      if (p.health <= 0 && p.alive) {
        this.removePlayer(p.id);
        deaths.push({ victim: p, killer: v.driver ?? { name: 'a runaway car' } });
      }
    }
    p.x = clamp(p.x, r, this.width - r);
    p.y = clamp(p.y, r, this.height - r);
  }

  /** Entities visible from (x, y). */
  queryView(x, y, range = this.opts.viewDistance) {
    return this.grid.query(x, y, range);
  }

  /** The richest players in the game, by bank balance — rounded, so nobody learns exact sums. */
  leaderboard(limit = 10) {
    const bank = (p) => p.account?.bank ?? 0;
    return [...this.players.values()]
      .sort((a, b) => bank(b) - bank(a))
      .slice(0, limit)
      .map((p) => ({ id: p.id, name: p.name, score: roughly(bank(p)) }));
  }
}

/** A rough figure: 2 significant digits (12 345 -> 12 000, 987 -> 990). */
export function roughly(n) {
  n = Math.max(0, Math.floor(n));
  if (n < 100) return n;
  const unit = 10 ** (Math.floor(Math.log10(n)) - 1);
  return Math.round(n / unit) * unit;
}
