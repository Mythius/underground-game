import { config } from '../config.js';
import { WAREHOUSE_GRIDS, WAREHOUSE_SIZES, WAREHOUSE_TILE } from './buildings.js';

// Player-built factories inside warehouses.
//
// A warehouse's floor is a grid of tiles. On it sit two fixed 2×2 docks (IN and OUT) and whatever the
// owner places: 2×2 machines and 1-tile belt pieces. Every piece faces one of four directions
// (0 east, 1 south, 2 west, 3 north — clockwise, in world space).
//
// Items ride belts one per tile. When an item reaches the end of its tile it's handed to the tile it
// points at, which may refuse (full, wrong side, not wanted) — then it waits. "Moving in direction m"
// means entering the next tile from its side opposite m.
//   belt     takes items from behind only;           passes them out of the front
//   turnL/R  takes items arriving from its left/right side (they turn left/right) and passes them forward
//   merger   takes from behind and both sides;     passes forward
//   splitter takes from behind;                    deals items out left, forward and right in turn (only ways
//            something can take them; a way that's full at the time is skipped)
//   filter   takes from behind;                    everything else goes forward, its chosen good left and right in turn
//   invfilter takes from behind;                   the opposite: its chosen good goes forward, everything else left and right
// Each item remembers the way it came in (`from`) and, on a splitter or filter, the way it's going out
// (`to`, picked as it comes in) — so the client can draw it flowing from that side, through the middle,
// and out the other.
//   machine  takes recipe inputs moving its way (into its back half); puts outputs out of its front
//   IN dock  puts the goods unloaded into it out onto any belt leading away from it
//   OUT dock takes anything, from any side
//   container takes anything from any side (up to its capacity) and puts it out onto any belt pointing away
//            from it (a plain belt running past its side is left alone; pallets and machines too)
// The docks (drawn as wooden pallets) and containers can also be loaded and emptied by hand.

export const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];
const turn = (d, by) => (((d + by) % 4) + 4) % 4;

/** p's hotbar stacks of shop food that counts as `good` (energy drinks bought in a shop are the 'energy' good). */
function foodAs(p, good) {
  return p.inventory.filter((s) => s?.food && config.economy.menu[s.food]?.good === good);
}

/** 'foundry:1' -> that recipe plus its factory's time per batch ('illegal:vodka' -> config.illegalRecipes). */
export function recipeOf(key) {
  const [factory, index] = key.split(':');
  if (factory === 'illegal') {
    const r = config.illegalRecipes[index];
    return r ? { ...r, key, illegal: true } : null;
  }
  const def = config.factories[factory];
  const recipe = def?.recipes[Number(index)];
  return recipe ? { ...recipe, sec: def.sec, key } : null;
}

const add = (bag, good, qty) => {
  bag[good] = (bag[good] ?? 0) + qty;
  if (bag[good] <= 0) delete bag[good];
};
const total = (bag) => Object.values(bag).reduce((a, b) => a + b, 0);

export class Warehouse {
  /** `building` is a warehouse building (buildBuilding output with `grid` and `docks`). */
  constructor(building) {
    this.id = building.id;
    this.building = building;
    this.type = building.type;
    this.size = WAREHOUSE_SIZES[building.type];
    const T = WAREHOUSE_TILE;
    const grid = building.grid; // already rotated into world space
    this.origin = { x: grid.x, y: grid.y };
    this.cols = Math.round(grid.w / T);
    this.rows = Math.round(grid.h / T);
    this.owner = null; // a live account object
    this.ownerId = null;
    this.spent = 0; // what the owner has paid for the warehouse and its contents (for selling back)
    this.taxOwed = 0;
    this.unpaid = false; // tax couldn't be paid: everything stops until it can
    this.unlockedUntil = -Infinity; // a picked lock lasts until this (world time)
    this.heat = 0; // from illegal production; at 100 the Militsiya raid it
    this.version = 1; // bumped whenever the layout changes, so clients re-fetch it
    this.nextPieceId = 1;
    this.reset();
  }

  /** Empties it: just the two docks, no stock. */
  reset() {
    this.cells = new Array(this.cols * this.rows).fill(null);
    this.pieces = new Map();
    const T = WAREHOUSE_TILE;
    for (const [kind, rect] of [['dockIn', this.building.docks.in], ['dockOut', this.building.docks.out]]) {
      const x = Math.round((rect.x - this.origin.x) / T);
      const y = Math.round((rect.y - this.origin.y) / T);
      this.#put({ id: this.nextPieceId++, kind, x, y, w: 2, h: 2, dir: 0, stock: {}, emitTimer: 0, next: 0 });
    }
    this.version++;
  }

  get dockIn() {
    return [...this.pieces.values()].find((p) => p.kind === 'dockIn');
  }

  get dockOut() {
    return [...this.pieces.values()].find((p) => p.kind === 'dockOut');
  }

  /** Tile coordinates -> world centre. */
  tileCenter(x, y) {
    return { x: this.origin.x + (x + 0.5) * WAREHOUSE_TILE, y: this.origin.y + (y + 0.5) * WAREHOUSE_TILE };
  }

  /** World rect of a piece. */
  rectOf(piece) {
    const T = WAREHOUSE_TILE;
    return { x: this.origin.x + piece.x * T, y: this.origin.y + piece.y * T, w: piece.w * T, h: piece.h * T };
  }

  contains(x, y) {
    const b = this.building;
    return x > b.x && x < b.x + b.w && y > b.y && y < b.y + b.h;
  }

  at(x, y) {
    if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) return undefined; // off the floor
    return this.cells[y * this.cols + x];
  }

  #put(piece) {
    this.pieces.set(piece.id, piece);
    for (let dy = 0; dy < piece.h; dy++) for (let dx = 0; dx < piece.w; dx++) this.cells[(piece.y + dy) * this.cols + piece.x + dx] = piece;
  }

  #remove(piece) {
    this.pieces.delete(piece.id);
    for (let i = 0; i < this.cells.length; i++) if (this.cells[i] === piece) this.cells[i] = null;
  }

  // ---- building (each returns an error code, or null) ---------------------------------

  /** What placing `kind` costs, or null if it isn't a thing. */
  static price(kind) {
    return config.machines[kind]?.price ?? config.belts[kind]?.price ?? null;
  }

  canPlace(kind, x, y) {
    const n = config.machines[kind] ? 2 : 1;
    for (let dy = 0; dy < n; dy++) for (let dx = 0; dx < n; dx++) if (this.at(x + dx, y + dy) !== null) return false;
    const T = WAREHOUSE_TILE;
    return !this.covered?.({ x: this.origin.x + x * T, y: this.origin.y + y * T, w: n * T, h: n * T }); // (a cabinet or bed in the way)
  }

  /** Puts a new piece down (already paid for). */
  place(kind, x, y, dir) {
    const machine = config.machines[kind];
    if (!machine && !config.belts[kind]) return 'unknown';
    if (machine && !machine.illegal && config.warehouses.sizes[this.size].illegalOnly) return 'shack_illegal_only';
    if (!this.canPlace(kind, x, y)) return 'blocked';
    const piece = { id: this.nextPieceId++, kind, x, y, dir: turn(dir, 0), w: 1, h: 1, item: null, alt: 0 };
    if (machine) Object.assign(piece, { w: 2, h: 2, recipe: machine.recipes[0], in: {}, out: {}, progress: 0, emitTimer: 0, next: 0 });
    if (kind === 'filter' || kind === 'invfilter') piece.filter = Object.keys(config.goods)[0];
    if (kind === 'container') Object.assign(piece, { stock: {}, emitTimer: 0, next: 0 });
    this.#put(piece);
    this.version++;
    return null;
  }

  /** Takes a piece away; returns it (its contents are lost), or an error code. */
  removeAt(x, y) {
    const piece = this.at(x, y);
    if (!piece) return 'nothing_there';
    if (piece.kind === 'dockIn' || piece.kind === 'dockOut') return 'cant_remove_dock';
    if (piece.kind === 'container' && total(piece.stock) >= 1) return 'not_empty'; // empty it first
    this.#remove(piece);
    this.version++;
    return piece;
  }

  rotateAt(x, y) {
    const piece = this.at(x, y);
    if (!piece || piece.kind.startsWith('dock')) return 'nothing_there';
    piece.dir = turn(piece.dir, 1);
    this.version++;
    return null;
  }

  /** Choose a machine's recipe or a filter's good. */
  configure(x, y, value) {
    const piece = this.at(x, y);
    if (!piece) return 'nothing_there';
    if (config.machines[piece.kind]) {
      if (!config.machines[piece.kind].recipes.includes(value)) return 'unknown';
      if (piece.recipe !== value) Object.assign(piece, { recipe: value, in: {}, progress: 0 }); // unused inputs are lost
    } else if (piece.kind === 'filter' || piece.kind === 'invfilter') {
      if (!config.goods[value]) return 'unknown';
      piece.filter = value;
    } else return 'unknown';
    this.version++;
    return null;
  }

  // ---- simulation ----------------------------------------------------------------------

  step(dt) {
    if (this.heat > 0) this.heat = Math.max(0, this.heat - (config.warehouses.heatDecayPerMin * dt) / 60);
    if (!this.owner || this.unpaid) return;
    const { beltSpeed, emitEverySec } = config.warehouses;
    for (const piece of this.pieces.values()) {
      if (piece.kind === 'container') {
        piece.emitTimer += dt;
        if (piece.emitTimer >= emitEverySec) {
          piece.emitTimer = 0;
          this.#emit(piece, piece.stock, this.#around(piece));
        }
      } else if (piece.w === 1) {
        if (!piece.item) continue;
        piece.item.p = Math.min(1, piece.item.p + beltSpeed * dt);
        if (piece.item.p >= 1) this.#forward(piece);
      } else if (piece.kind === 'dockIn') {
        piece.emitTimer += dt;
        if (piece.emitTimer >= emitEverySec) {
          piece.emitTimer = 0;
          this.#emitFromDock(piece);
        }
      } else if (piece.kind !== 'dockOut') {
        this.#runMachine(piece, dt);
        piece.emitTimer += dt;
        if (piece.emitTimer >= emitEverySec) {
          piece.emitTimer = 0;
          this.#emitFromMachine(piece);
        }
      }
    }
  }

  /** The ways an item can leave `piece`, in the order to try them (its planned way first). */
  #exits(piece, item) {
    const left = turn(piece.dir, -1), right = turn(piece.dir, 1);
    const planned = item.to ?? piece.dir;
    if (piece.kind === 'splitter') return [planned, ...[left, piece.dir, right].filter((m) => m !== planned)];
    if (piece.kind === 'filter' || piece.kind === 'invfilter') {
      const sideways = (item.good === piece.filter) === (piece.kind === 'filter');
      return sideways ? (planned === right ? [right, left] : [left, right]) : [piece.dir];
    }
    return [piece.dir];
  }

  /**
   * An item coming onto a splitter or filter: which way it'll go out. A splitter deals left, forward,
   * right in turn — skipping ways with nothing there to take it; a filter sends what goes sideways to
   * each side in turn.
   */
  #plan(piece, good) {
    const left = turn(piece.dir, -1), right = turn(piece.dir, 1);
    const open = (m) => this.#couldTake(piece.x + DIRS[m][0], piece.y + DIRS[m][1], m, good);
    if (piece.kind === 'splitter') {
      const ways = [left, piece.dir, right];
      for (let k = 0; k < 3; k++) {
        const i = ((piece.alt ?? 0) + k) % 3;
        if (!open(ways[i])) continue;
        piece.alt = (i + 1) % 3;
        return ways[i];
      }
      return piece.dir;
    }
    if (piece.kind === 'filter' || piece.kind === 'invfilter') {
      if ((good === piece.filter) !== (piece.kind === 'filter')) return piece.dir;
      const sides = piece.alt ? [right, left] : [left, right];
      const m = sides.find(open) ?? sides[0];
      piece.alt = m === left ? 1 : 0; // the other side next
      return m;
    }
    return piece.dir;
  }

  /** A belt item at the end of its tile tries to move on. */
  #forward(piece) {
    const item = piece.item;
    for (const m of this.#exits(piece, item)) {
      if (this.#handTo(piece.x + DIRS[m][0], piece.y + DIRS[m][1], m, item.good)) {
        piece.item = null;
        return;
      }
    }
  }

  /** Would whatever's at (x, y) ever take `good` moving in direction m? (Ignoring whether it's busy right now.) */
  #couldTake(x, y, m, good) {
    const target = this.at(x, y);
    if (!target) return false;
    if (target.kind === 'container' || target.kind === 'dockOut') return true;
    if (target.w === 1) return this.#entersFrom(target, m);
    if (target.kind === 'dockIn') return false;
    return m === target.dir && Boolean(recipeOf(target.recipe)?.in[good]);
  }

  /** Does belt piece `target` take items moving in direction m (into it)? */
  #entersFrom(target, m) {
    const d = target.dir;
    if (target.kind === 'turnL') return m === turn(d, 1);
    if (target.kind === 'turnR') return m === turn(d, -1);
    if (target.kind === 'merger') return m !== turn(d, 2); // from behind or either side
    return m === d; // belts, splitters and filters: from behind only (out of the front)
  }

  /** Offer `good`, moving in direction m, to whatever is at tile (x, y). True if it was taken. */
  #handTo(x, y, m, good) {
    const target = this.at(x, y);
    if (!target) return false;
    if (target.kind === 'container') {
      if (total(target.stock) >= config.warehouses.containerCapacity) return false;
      add(target.stock, good, 1);
      return true;
    }
    if (target.w === 1) {
      if (target.item || !this.#entersFrom(target, m)) return false;
      target.item = { good, p: 0, from: m };
      target.item.to = this.#plan(target, good);
      return true;
    }
    if (target.kind === 'dockOut') {
      if (total(target.stock) >= config.warehouses.dockCapacity) return false;
      add(target.stock, good, 1);
      return true;
    }
    if (target.kind === 'dockIn') return false;
    // A machine: only recipe inputs, only into its back, only while there's room.
    const recipe = recipeOf(target.recipe);
    if (m !== target.dir || !recipe?.in[good]) return false;
    if ((target.in[good] ?? 0) >= recipe.in[good] * config.warehouses.machineBuffer) return false;
    add(target.in, good, 1);
    return true;
  }

  /** The tiles just outside a piece, with the direction an item would move to get there. */
  #around(piece, sides = [0, 1, 2, 3]) {
    const out = [];
    for (const side of sides) {
      const [dx, dy] = DIRS[side];
      for (let i = 0; i < piece.w; i++) {
        const x = dx === 1 ? piece.x + piece.w : dx === -1 ? piece.x - 1 : piece.x + i;
        const y = dy === 1 ? piece.y + piece.h : dy === -1 ? piece.y - 1 : piece.y + i;
        out.push({ x, y, m: side });
      }
    }
    return out;
  }

  /** Puts one unit out of a bag into the next free neighbour that takes it. Round-robin over goods and exits. */
  #emit(piece, bag, exits) {
    const goods = Object.keys(bag).filter((g) => bag[g] >= 1);
    if (!goods.length || !exits.length) return;
    for (let i = 0; i < exits.length * goods.length; i++) {
      const k = (piece.next + i) % (exits.length * goods.length);
      const exit = exits[k % exits.length];
      const good = goods[Math.floor(k / exits.length) % goods.length];
      if (this.#handTo(exit.x, exit.y, exit.m, good)) {
        add(bag, good, -1);
        piece.next = k + 1;
        return;
      }
    }
  }

  #emitFromDock(piece) {
    this.#emit(piece, piece.stock, this.#around(piece));
  }

  #emitFromMachine(piece) {
    this.#emit(piece, piece.out, this.#around(piece, [piece.dir]));
  }

  #runMachine(piece, dt) {
    const recipe = recipeOf(piece.recipe);
    const ready = recipe && !(recipe.illegal && this.owner?.cop) && Object.entries(recipe.in).every(([g, q]) => (piece.in[g] ?? 0) >= q) && total(piece.out) < config.warehouses.machineSlot;
    if (!ready) {
      piece.progress = 0;
      return;
    }
    piece.progress += dt;
    if (piece.progress < recipe.sec) return;
    piece.progress = 0;
    for (const [g, q] of Object.entries(recipe.in)) add(piece.in, g, -q);
    for (const [g, q] of Object.entries(recipe.out)) add(piece.out, g, q);
    if (recipe.illegal) {
      // Contraband production draws attention, much less out in a shack in the woods.
      const value = Object.entries(recipe.out).reduce((sum, [g, q]) => sum + config.goods[g].base * q, 0);
      this.heat += (value / config.warehouses.heatPerValue) * (this.size === 'shack' ? config.warehouses.shackHeat : 1);
    }
  }

  /** The Militsiya raid: every bit of contraband inside is seized. Returns { good: qty } taken. */
  raid() {
    const seized = {};
    const strip = (bag) => {
      for (const g of Object.keys(bag ?? {})) {
        if (!config.goods[g]?.illegal) continue;
        seized[g] = (seized[g] ?? 0) + Math.floor(bag[g]);
        delete bag[g];
      }
    };
    for (const p of this.pieces.values()) {
      strip(p.stock);
      strip(p.in);
      strip(p.out);
      if (p.item && config.goods[p.item.good]?.illegal) {
        seized[p.item.good] = (seized[p.item.good] ?? 0) + 1;
        p.item = null;
      }
    }
    this.heat = 0;
    return seized;
  }

  /** Property tax, by the minute, from the owner's bank. Returns true if the bank changed. */
  chargeTax(dt) {
    if (!this.owner) return false;
    this.taxOwed += (config.warehouses.sizes[this.size].taxPerHour * dt) / 3600;
    if (this.taxOwed < 1) return false;
    const due = Math.floor(this.taxOwed);
    if (this.owner.bank < due) {
      this.unpaid = true;
      this.taxOwed = Math.min(this.taxOwed, config.warehouses.sizes[this.size].taxPerHour); // at most an hour behind
      return false;
    }
    this.owner.bank -= due;
    this.taxOwed -= due;
    this.unpaid = false;
    return true;
  }

  // ---- what clients see, and saving ----------------------------------------------------

  /** The layout (changes rarely): pieces without their moving contents. */
  layout() {
    return {
      id: this.id,
      version: this.version,
      owner: this.owner?.name ?? null,
      size: this.size,
      cols: this.cols,
      rows: this.rows,
      origin: this.origin,
      pieces: [...this.pieces.values()].map((p) => ({ id: p.id, kind: p.kind, x: p.x, y: p.y, w: p.w, h: p.h, dir: p.dir, recipe: p.recipe, filter: p.filter })),
    };
  }

  /** What's moving: belt items, machine progress and buffers, dock stock. */
  live() {
    const items = [];
    const machines = [];
    for (const p of this.pieces.values()) {
      if (p.kind === 'container') {
        machines.push([p.id, 0, p.stock]);
      } else if (p.w === 1) {
        if (p.item) items.push([p.x, p.y, p.item.good, Math.round(p.item.p * 100) / 100, p.item.from ?? p.dir, p.item.to ?? p.dir]); // [x, y, good, progress, came in moving, goes out]
      } else if (p.kind.startsWith('dock')) {
        machines.push([p.id, 0, p.stock]);
      } else {
        const recipe = recipeOf(p.recipe);
        machines.push([p.id, recipe ? Math.round((p.progress / recipe.sec) * 100) / 100 : 0, p.in, p.out]);
      }
    }
    return { id: this.id, items, machines, unpaid: this.unpaid, heat: Math.round(this.heat) };
  }

  /** Everything needed to rebuild it after a restart. */
  save() {
    return {
      size: this.size,
      spent: this.spent,
      taxOwed: this.taxOwed,
      heat: this.heat,
      pieces: [...this.pieces.values()].map(({ kind, x, y, dir, recipe, filter, stock, in: input, out, item }) => ({ kind, x, y, dir, recipe, filter, stock, in: input, out, item })),
    };
  }

  load(data) {
    this.reset();
    this.spent = data.spent ?? 0;
    this.taxOwed = data.taxOwed ?? 0;
    this.heat = data.heat ?? 0;
    const fit = this.#turnToFit(data.pieces ?? []);
    for (const saved of data.pieces ?? []) {
      if (saved.kind === 'dockIn' || saved.kind === 'dockOut') {
        Object.assign(saved.kind === 'dockIn' ? this.dockIn : this.dockOut, { stock: { ...saved.stock } });
        continue;
      }
      const p = fit(saved);
      if (this.place(p.kind, p.x, p.y, p.dir) !== null) continue;
      const piece = this.at(p.x, p.y);
      if (p.recipe && config.machines[p.kind]?.recipes.includes(p.recipe)) piece.recipe = p.recipe;
      if (p.filter && config.goods[p.filter]) piece.filter = p.filter;
      if (piece.in && p.in && piece.recipe === p.recipe) piece.in = { ...p.in }; // (a recipe no longer allowed resets, inputs and all)
      if (piece.out && p.out) piece.out = { ...p.out };
      if (piece.w === 1 && p.item && config.goods[p.item.good]) piece.item = { good: p.item.good, p: p.item.p, from: piece.dir, to: piece.dir }; // (it carries on straight)
      if (piece.kind === 'container' && p.stock) piece.stock = { ...p.stock };
    }
    this.version++;
  }

  /**
   * A saved layout may come from a warehouse of this size facing another way (a different map, or a
   * different building after a reset). Finds the quarter turns that put its IN and OUT pallets on
   * this one's, and returns a function turning each saved piece (place and facing) to match.
   */
  #turnToFit(pieces) {
    const savedIn = pieces.find((p) => p.kind === 'dockIn'), savedOut = pieces.find((p) => p.kind === 'dockOut');
    const turned = (p, k) => {
      const size = config.machines[p.kind] || p.kind.startsWith('dock') ? 2 : 1;
      let { x, y } = p;
      let rows = k % 2 ? this.cols : this.rows; // the saved floor's height (sizes swap each turn)
      for (let i = 0; i < k; i++) {
        [x, y] = [rows - y - size, x]; // 90° clockwise, as buildings turn
        rows = rows === this.rows ? this.cols : this.rows;
      }
      return { ...p, x, y, dir: turn(p.dir ?? 0, k) };
    };
    let k = 0;
    if (savedIn && savedOut) {
      const same = (a, b) => a.x === b.x && a.y === b.y;
      k = [0, 1, 2, 3].find((n) => same(turned(savedIn, n), this.dockIn) && same(turned(savedOut, n), this.dockOut)) ?? 0;
    }
    return (p) => turned(p, k);
  }
}

/** Every warehouse in a world, and what players do with them. */
export class Warehouses {
  constructor(world) {
    this.world = world;
    this.all = new Map(); // building id -> Warehouse
    for (const b of world.buildings) if (WAREHOUSE_SIZES[b.type] && b.grid) this.all.set(b.id, new Warehouse(b));
    for (const w of this.all.values()) w.covered = (r) => world.furnishings?.covers(r) ?? false;
    this.taxTimer = 0;
    this.changed = false; // something worth saving happened
    this.events = []; // raids, for the room to tell the owner about
    // Factories saved before a restart (the map is new each time): [{ accountId, slot, data }]. Each
    // waits here until its owner loads it into a free warehouse of the same size (see 'bring').
    this.stored = [];
  }

  get time() {
    return this.world.economy.time;
  }

  step(dt) {
    for (const w of this.all.values()) {
      if (w.heat >= 100) this.events.push({ account: w.owner, kind: 'raid', building: w.id, seized: w.raid() });
      w.step(dt);
    }
    this.taxTimer += dt;
    if (this.taxTimer < 1) return;
    for (const w of this.all.values()) if (w.chargeTax(this.taxTimer)) this.world.onBankChange?.(w.owner);
    this.taxTimer = 0;
  }

  /** The warehouse a point is inside, if any. */
  containing(x, y) {
    for (const w of this.all.values()) if (w.contains(x, y)) return w;
    return null;
  }

  /** Is `door` a locked warehouse door, as far as player p is concerned? */
  lockedFor(door, p) {
    const w = this.all.get(door.building);
    // Anyone inside can always get out.
    return Boolean(w?.owner && w.owner !== p.account && w.unlockedUntil < this.time && !w.contains(p.x, p.y));
  }

  /** A picked lock: anyone can open the doors for a while. */
  unlock(door) {
    const w = this.all.get(door.building);
    if (w) w.unlockedUntil = this.time + config.warehouses.unlockedSec;
  }

  /** Does `account` already own a warehouse of this size? (One of each size per player.) */
  #ownsSize(account, size) {
    return [...this.all.values()].some((x) => x.owner && x.ownerId === account.id && x.size === size);
  }

  #nearDock(p, w, dock) {
    const r = w.rectOf(dock);
    const dx = Math.max(r.x - p.x, 0, p.x - (r.x + r.w));
    const dy = Math.max(r.y - p.y, 0, p.y - (r.y + r.h));
    return Math.hypot(dx, dy) < config.warehouses.dockReach + p.radius;
  }

  /**
   * Everything players do: buy, sell, place, remove, rotate, configure (building, owner only, from
   * inside); load (cargo -> IN dock), take (OUT dock -> cargo; or IN dock with `dock: 'in'`).
   * Returns an error code, or null.
   */
  action(p, msg) {
    const w = this.all.get(msg.id);
    if (!w) return 'unknown';
    const account = p.account;
    const mine = Boolean(account && w.owner === account);
    const size = config.warehouses.sizes[w.size];
    const result = (() => {
      if (msg.action === 'buy') {
        if (w.owner) return 'already_owned';
        if (!w.contains(p.x, p.y) && Math.hypot(w.building.x + w.building.w / 2 - p.x, w.building.y + w.building.h / 2 - p.y) > Math.max(w.building.w, w.building.h)) return 'too_far';
        if (!account || account.guest) return 'need_account';
        if (this.#ownsSize(account, w.size)) return 'one_per_size';
        if (size.illegalOnly && account.cop) return 'cop_no_illegal'; // (a shack only takes illegal machines)
        if (this.stored.some((r) => r.accountId === account.id && r.data.size === w.size)) return 'load_saved_instead'; // (you've a saved one of this size: load it)
        if (account.bank < size.price) return 'not_enough_bank';
        account.bank -= size.price;
        w.reset();
        Object.assign(w, { owner: account, ownerId: account.id, spent: size.price, taxOwed: 0, unpaid: false });
        this.world.onBankChange?.(account);
        return null;
      }
      if (msg.action === 'bring') {
        // Your factory from before the restart, moved into this free warehouse of the same size (no charge).
        if (w.owner) return 'already_owned';
        if (!w.contains(p.x, p.y) && Math.hypot(w.building.x + w.building.w / 2 - p.x, w.building.y + w.building.h / 2 - p.y) > Math.max(w.building.w, w.building.h)) return 'too_far';
        const row = account?.id ? this.stored.find((r) => r.accountId === account.id && r.data.size === w.size) : null;
        if (!row) return 'nothing_stored';
        if (this.#ownsSize(account, w.size)) return 'one_per_size';
        this.stored.splice(this.stored.indexOf(row), 1);
        w.load(row.data);
        Object.assign(w, { owner: account, ownerId: account.id, unpaid: false });
        this.world.furnishings.loadIn(w.building, row.data.furnishings, account); // its cabinets and all
        return null;
      }
      if (msg.action === 'load' || msg.action === 'take') {
        const dock = msg.action === 'load' || msg.dock === 'in' ? w.dockIn : w.dockOut;
        const stealing = !mine;
        if (stealing && (msg.action === 'load' || !w.owner)) return 'not_owner';
        if (stealing && w.unlockedUntil < this.time) return 'locked';
        if (!this.#nearDock(p, w, dock)) return 'too_far';
        const holder = this.world.economy.cargoOf(p);
        let moved = 0;
        if (msg.action === 'load') {
          for (const [good, have] of Object.entries(holder.items)) {
            const qty = Math.min(have, config.warehouses.dockCapacity - total(dock.stock));
            if (qty <= 0) continue;
            holder.add(good, -qty);
            add(dock.stock, good, qty);
            moved += qty;
          }
          return moved ? null : 'nothing_to_load';
        }
        for (const [good, have] of Object.entries(dock.stock)) {
          const qty = Math.min(Math.floor(have), holder.room(good));
          if (qty <= 0) continue;
          add(dock.stock, good, -qty);
          holder.add(good, qty);
          moved += qty;
        }
        if (!moved) return total(dock.stock) ? 'no_room' : 'nothing_to_take';
        if (stealing) this.world.police.crime(p, 'break_in');
        return null;
      }
      if (msg.action === 'ptake' || msg.action === 'pput') return this.#byHand(p, w, mine, msg);
      if (!mine) return 'not_owner';
      if (msg.action === 'sell') {
        if (this.world.furnishings.anyIn(w.building)) return 'remove_furniture_first';
        account.bank += Math.floor(w.spent * config.warehouses.sellBack);
        w.reset();
        Object.assign(w, { owner: null, ownerId: null, spent: 0, taxOwed: 0, unpaid: false });
        this.world.onBankChange?.(account);
        return null;
      }
      if (!w.contains(p.x, p.y)) return 'go_inside';
      const x = msg.x | 0;
      const y = msg.y | 0;
      if (msg.action === 'grab') { // the item riding a belt, into your cargo
        const piece = w.at(x, y);
        if (!piece?.item) return 'nothing_there';
        const holder = this.world.economy.cargoOf(p);
        if (holder.room(piece.item.good) < 1) return 'no_room';
        holder.add(piece.item.good, 1);
        piece.item = null;
        return null;
      }
      if (msg.action === 'place') {
        const price = Warehouse.price(msg.kind);
        if (price === null) return 'unknown';
        if (config.machines[msg.kind]?.illegal && account.cop) return 'cop_no_illegal';
        if (!w.canPlace(msg.kind, x, y)) return 'blocked';
        if (account.bank < price) return 'not_enough_bank';
        const error = w.place(msg.kind, x, y, msg.dir | 0);
        if (error) return error;
        account.bank -= price;
        w.spent += price;
        this.world.onBankChange?.(account);
        return null;
      }
      if (msg.action === 'remove') {
        const piece = w.removeAt(x, y);
        if (typeof piece === 'string') return piece;
        const price = Warehouse.price(piece.kind); // moving things around is free: full refund
        account.bank += price;
        w.spent = Math.max(0, w.spent - price);
        this.world.onBankChange?.(account);
        return null;
      }
      if (msg.action === 'mload' || msg.action === 'mtake') {
        const piece = w.at(x, y);
        if (!piece || !config.machines[piece.kind]) return 'nothing_there';
        if (!this.#nearPiece(p, w, piece)) return 'too_far';
        return msg.action === 'mload' ? this.#loadMachine(p, piece, msg.slot | 0) : this.#takeFromMachine(p, piece, msg.dock === 'in' ? 'in' : 'out');
      }
      if (msg.action === 'chop') return this.#chop(p, w);
      if (msg.action === 'rotate') return w.rotateAt(x, y);
      if (msg.action === 'configure') return w.configure(x, y, String(msg.value ?? ''));
      return 'unknown';
    })();
    if (result === null) this.changed = true;
    return result;
  }

  /**
   * Chop shop: a car that isn't yours, parked inside your warehouse or shack, is stripped for stolen
   * parts (contraband) — they and whatever was in its trunk go into the IN dock. The car is gone.
   */
  #chop(p, w) {
    const b = w.building;
    const car = [...this.world.vehicles.values()].find(
      (v) => !v.driver && !v.roadblock && v.owner !== p.account && v.x > b.x && v.x < b.x + b.w && v.y > b.y && v.y < b.y + b.h,
    );
    if (!car) return 'no_car_inside';
    const dock = w.dockIn.stock;
    add(dock, 'hotparts', config.warehouses.chopParts[car.type] ?? 6);
    for (const s of car.cargo) if (s?.good) add(dock, s.good, s.qty);
    this.world.vehicles.delete(car.id);
    this.world.vehicleRespawns.push(config.vehicles.respawnSec);
    if (car.police) this.world.police.crime(p, 'steal_police_car'); // only if someone sees
    return null;
  }

  /**
   * By hand at a pallet (dock) or container: 'ptake' moves up to `qty` of `good` into your cargo,
   * 'pput' moves up to `qty` of it from your cargo onto it. Taking from someone else's (lock picked) is a break-in.
   */
  #byHand(p, w, mine, msg) {
    const piece = w.at(msg.x | 0, msg.y | 0);
    if (!piece || !(piece.kind === 'dockIn' || piece.kind === 'dockOut' || piece.kind === 'container')) return 'nothing_there';
    if (!mine && (msg.action === 'pput' || !w.owner)) return 'not_owner';
    if (!mine && w.unlockedUntil < this.time) return 'locked';
    if (!(piece.kind === 'container' ? this.#nearPiece(p, w, piece) : this.#nearDock(p, w, piece))) return 'too_far';
    const good = msg.good;
    if (!config.goods[good]) return 'unknown';
    const holder = this.world.economy.cargoOf(p);
    if (msg.action === 'pput') {
      const room = (piece.kind === 'container' ? config.warehouses.containerCapacity : config.warehouses.dockCapacity) - total(piece.stock);
      const food = foodAs(p, good); // shop food that counts as this good (energy drinks)
      const have = holder.count(good) + food.reduce((n, s) => n + s.qty, 0);
      const qty = Math.min(msg.qty, have, Math.floor(room));
      if (qty <= 0) return have ? 'no_room' : 'not_carrying';
      let left = qty - Math.min(qty, holder.count(good));
      holder.add(good, -(qty - left));
      for (const s of food) {
        const n = Math.min(left, s.qty);
        s.qty -= n;
        left -= n;
        if (s.qty <= 0) p.inventory[p.inventory.indexOf(s)] = null;
      }
      add(piece.stock, good, qty);
      return null;
    }
    const qty = Math.min(msg.qty, Math.floor(piece.stock[good] ?? 0), holder.room(good));
    if (qty <= 0) return piece.stock[good] >= 1 ? 'no_room' : 'nothing_to_take';
    add(piece.stock, good, -qty);
    holder.add(good, qty);
    if (!mine) this.world.police.crime(p, 'break_in');
    return null;
  }

  #nearPiece(p, w, piece) {
    const r = w.rectOf(piece);
    return Math.hypot(Math.max(r.x - p.x, 0, p.x - (r.x + r.w)), Math.max(r.y - p.y, 0, p.y - (r.y + r.h))) < 140 + p.radius;
  }

  /** By hand: a hotbar slot of one of the recipe's inputs into the machine's input slot. */
  #loadMachine(p, piece, index) {
    const stack = p.inventory[index];
    const good = stack?.good ?? config.economy.menu[stack?.food]?.good; // (a shop energy drink is an energy drink)
    if (!good) return 'nothing_there';
    const recipe = recipeOf(piece.recipe);
    if (!recipe?.in[good]) return 'wrong_input';
    const qty = Math.min(stack.qty, config.warehouses.machineSlot - (piece.in[good] ?? 0));
    if (qty <= 0) return 'machine_full';
    stack.qty -= qty;
    if (stack.qty <= 0) p.inventory[index] = null;
    add(piece.in, good, qty);
    return null;
  }

  /** By hand: everything in the machine's output (or input) slot into your cargo, as much as fits. */
  #takeFromMachine(p, piece, which) {
    const bag = piece[which];
    const holder = this.world.economy.cargoOf(p);
    let moved = 0;
    for (const [good, have] of Object.entries(bag)) {
      const qty = Math.min(Math.floor(have), holder.room(good));
      if (qty <= 0) continue;
      add(bag, good, -qty);
      holder.add(good, qty);
      moved += qty;
    }
    if (!moved) return total(bag) >= 1 ? 'no_room' : 'nothing_to_take';
    return null;
  }

  /** Owner names, for map labels. */
  ownership() {
    return [...this.all.values()].map((w) => [w.id, w.owner?.name ?? null]);
  }

  // ---- saving ---------------------------------------------------------------------

  /** Sizes of the saved factories account has waiting to be loaded into a free warehouse. */
  storedFor(account) {
    return account?.id ? this.stored.filter((r) => r.accountId === account.id).map((r) => r.data.size) : [];
  }

  /** slot name -> warehouse; a slot is "<size>-<n>", the n-th warehouse of that size by building id. */
  slots() {
    const out = new Map();
    const seen = {};
    for (const w of [...this.all.values()].sort((a, b) => a.id - b.id)) {
      seen[w.size] = (seen[w.size] ?? 0) + 1;
      out.set(`${w.size}-${seen[w.size]}`, w);
    }
    return out;
  }

  slotOf(w) {
    for (const [slot, x] of this.slots()) if (x === w) return slot;
    return null;
  }

  /** Rows to save: one per owned warehouse, and the ones still waiting to be loaded. */
  toSave() {
    return [...[...this.slots()].filter(([, w]) => w.owner).map(([slot, w]) => ({ slot, accountId: w.ownerId, data: { ...w.save(), furnishings: this.world.furnishings.saveIn(w.building) } })), ...this.stored];
  }
}
