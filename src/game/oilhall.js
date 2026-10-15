import { config } from '../config.js';
import { Pickup } from './entities.js';
import { hotbarOf } from './cargo.js';

// The oil hall underground (НЕФТЕХРАНИЛИЩЕ №3): two governor's guards and an overseer (a tax inspector, on loan)
// shoot anyone who walks in (see Hires). Shabby townsfolk work the little hand pumps at the edge of the
// oil pits, and when both their watchers are dead they drop everything and run for it. More are locked
// in the cells along the back wall: the doors can't be picked, only opened with the overseer's key, which
// is no good outside the hall. Let out, they run for it, and one presses something into your hand.
// Everything fills up again a while later, when nobody's in there to see.

const inRect = (r, x, y, m = 0) => r && x > r.x - m && x < r.x + r.w + m && y > r.y - m && y < r.y + r.h + m;

export class OilHall {
  constructor(world, layout) {
    this.world = world;
    this.layout = layout;
    this.oil = layout.oil;
    this.folk = []; // { id, kind: 'worker' | 'prisoner', x, y, angle, state: 'pump' | 'flee' | 'sit' | 'free', spot, cell, health, look, left }
    this.nextId = 1;
    this.time = 0;
    this.events = []; // { player, kind, … } for the room to pass on
    // The watchers' posts: [role, where, the overseer's beat]; each filled again on its own once its man is dead.
    this.posts = [['govguard', this.oil.guard], ['govguard', this.oil.guard2 ?? this.oil.guard], ['inspector', this.oil.inspector, this.oil.cells.map((c) => c.front)]];
    this.guardWait = this.posts.map(() => 0);
    this.cellWait = this.oil.cells.map(() => 0);
    this.keyCheck = 0;
    this.posts.forEach((_, i) => this.#spawnGuard(i));
    this.oil.pumps.forEach((_, i) => this.#spawnWorker(i));
    this.oil.cells.forEach((_, i) => this.#fillCell(i));
  }

  #door(cell) {
    return this.layout.doors[cell.door];
  }

  #anyoneIn(rect, m = 0) {
    return [...this.world.players.values()].some((p) => p.alive && inRect(rect, p.x, p.y, m));
  }

  #guards() {
    return this.world.hires.list.filter((h) => h.oil);
  }

  #spawnGuard(i) {
    const [role, at, beat] = this.posts[i];
    this.world.hires.spawnOil(role, at, this.oil.hall, beat ?? null).oilPost = i;
  }

  #spawnWorker(i) {
    const s = this.oil.pumps[i];
    this.folk.push({ id: this.nextId++, kind: 'worker', x: s.x, y: s.y, angle: s.a, state: 'pump', spot: i, health: config.oilHall.health, look: Math.floor(Math.random() * 8), left: 0 });
  }

  /** New prisoners in cell i, its door shut and locked on them. */
  #fillCell(i) {
    const c = this.oil.cells[i], door = this.#door(c), [lo, hi] = config.oilHall.prisonersPerCell;
    door.open = false;
    door.openedBy = null;
    this.world.pendingDoors.push(door); // (everyone sees it shut)
    for (let n = lo + Math.floor(Math.random() * (hi - lo + 1)), k = 0; k < n; k++) {
      this.folk.push({ id: this.nextId++, kind: 'prisoner', x: c.x + (k - (n - 1) / 2) * 44, y: c.y + (Math.random() - 0.5) * 30, angle: Math.random() * Math.PI * 2, state: 'sit', cell: i, health: config.oilHall.health, look: Math.floor(Math.random() * 8), left: 0 });
    }
  }

  /**
   * E on a cell door: with the overseer's key it swings open (and stays unlocked while it's open), and
   * whoever's inside is out. True if it was a cell door, whatever happened.
   */
  useKey(door, p) {
    if (!door.cell) return false;
    if (door.open) return false; // (shutting it: an ordinary door)
    if (!p.inventory.some((s) => s?.type === 'cellkey')) {
      this.events.push({ player: p, kind: 'error', code: 'cell_key_door' });
      return true;
    }
    door.open = true;
    door.openedBy = p;
    return true;
  }

  step(dt) {
    this.time += dt;
    const c = config.oilHall, o = this.oil, w = this.world;
    // The guards and the overseer: someone new a while after one's killed (not while anyone's in the hall).
    const guards = this.#guards();
    for (let i = 0; i < this.posts.length; i++) {
      if (guards.some((h) => h.oilPost === i)) { this.guardWait[i] = 0; continue; }
      if ((this.guardWait[i] += dt) < c.guardRespawnSec || this.#anyoneIn(o.hall, 200)) continue;
      this.guardWait[i] = 0;
      this.#spawnGuard(i);
    }
    const watched = this.#guards().length > 0;
    // Workers back at the pumps once there's someone watching again, and nobody about.
    if (watched && !this.#anyoneIn(o.hall, 200)) {
      const manned = new Set(this.folk.filter((f) => f.kind === 'worker').map((f) => f.spot));
      o.pumps.forEach((_, i) => { if (!manned.has(i)) this.#spawnWorker(i); });
    }
    // The cells: let out when the door's opened; filled again a good while after they're empty.
    o.cells.forEach((cell, i) => {
      const inside = this.folk.filter((f) => f.kind === 'prisoner' && f.cell === i && f.state === 'sit');
      const door = this.#door(cell);
      if (inside.length && door.open) {
        for (const f of inside) f.state = 'free';
        const by = door.openedBy && w.players.get(door.openedBy.id) === door.openedBy ? door.openedBy : [...w.players.values()].sort((a, b) => Math.hypot(a.x - cell.front.x, a.y - cell.front.y) - Math.hypot(b.x - cell.front.x, b.y - cell.front.y))[0];
        if (by) this.#thank(by);
      }
      if (this.folk.some((f) => f.kind === 'prisoner' && f.cell === i)) { this.cellWait[i] = 0; return; }
      if ((this.cellWait[i] += dt) < c.cellRefillSec) return;
      if ([...w.players.values()].some((p) => Math.hypot(p.x - cell.front.x, p.y - cell.front.y) < c.refillClear)) return;
      if ([...w.players.values()].some((p) => inRect(door, p.x, p.y, p.radius))) return; // (not on someone in the doorway)
      this.cellWait[i] = 0;
      this.#fillCell(i);
    });
    // Everyone: pumping, sitting, or running for the way out.
    for (const f of [...this.folk]) {
      if (f.kind === 'worker' && f.state === 'pump' && !watched) f.state = 'flee'; // (nobody watching: run!)
      if (f.state === 'pump') {
        const s = o.pumps[f.spot];
        if (Math.hypot(s.x - f.x, s.y - f.y) > 8) this.#step(f, s.x, s.y, c.walkSpeed * dt);
        else f.angle = s.a;
        continue;
      }
      if (f.state === 'sit') continue;
      // Running for it: the nearest way out of the hall, and gone (or gone anyway after a while).
      const out = o.doorsOut.reduce((best, d) => (Math.hypot(d.x - f.x, d.y - f.y) < Math.hypot(best.x - f.x, best.y - f.y) ? d : best), o.doorsOut[0]);
      f.left += dt;
      if (!out || Math.hypot(out.x - f.x, out.y - f.y) < 140 || f.left > c.fleeSec) { this.folk.splice(this.folk.indexOf(f), 1); continue; }
      // Out of a cell first (through its door), then across the hall.
      const cell = f.kind === 'prisoner' ? o.cells[f.cell] : null;
      const via = cell && !f.outOfCell ? cell.front : out;
      if (cell && !f.outOfCell && Math.hypot(cell.front.x - f.x, cell.front.y - f.y) < 30) f.outOfCell = true;
      this.#step(f, via.x, via.y, c.runSpeed * dt);
    }
    // The overseer's key is no good outside the hall (and his office): it's gone once you leave.
    if ((this.keyCheck -= dt) <= 0) {
      this.keyCheck = 0.5;
      for (const p of w.players.values()) {
        const i = p.inventory.findIndex((s) => s?.type === 'cellkey');
        if (i < 0 || (p.alive && (inRect(o.hall, p.x, p.y, 40) || inRect(o.office, p.x, p.y, 40)))) continue;
        p.inventory[i] = null;
        this.events.push({ player: p, kind: 'cellkey_gone' });
      }
    }
  }

  /** One of the prisoners presses something into p's hand on the way out: cash, a couple of bottles, or bread. */
  #thank(p) {
    const r = config.oilHall.reward, roll = Math.random();
    let what;
    if (roll < r.cashChance) {
      const cash = r.cash[0] + Math.floor(Math.random() * (r.cash[1] - r.cash[0] + 1));
      p.cash += cash;
      what = { cash };
    } else {
      const [good, qty] = roll < r.cashChance + r.vodkaChance ? ['vodka', r.vodka] : ['bread', r.bread];
      const left = hotbarOf(p).add(good, qty); // (what didn't fit)
      if (left > 0) { // (no room: at his feet)
        const k = new Pickup(this.world.nextEntityId++, p.x + 20, p.y, null, 0, { good, qty: left });
        this.world.pickups.set(k.id, k);
      }
      what = { good, qty };
    }
    this.events.push({ player: p, kind: 'prisoners_freed', ...what });
  }

  /** A step toward (tx, ty), pushed off the walls. */
  #step(f, tx, ty, step) {
    const dx = tx - f.x, dy = ty - f.y, d = Math.hypot(dx, dy);
    if (d < 1) return;
    f.angle = Math.atan2(dy, dx);
    f.x += (dx / d) * Math.min(step, d);
    f.y += (dy / d) * Math.min(step, d);
    const rad = config.oilHall.radius;
    for (const wall of this.world.wallsNear(f.x, f.y, rad)) {
      const cx = Math.min(Math.max(f.x, wall.x), wall.x + wall.w), cy = Math.min(Math.max(f.y, wall.y), wall.y + wall.h);
      const ex = f.x - cx, ey = f.y - cy, dd = Math.hypot(ex, ey);
      if (dd > 0 && dd < rad) { f.x += (ex / dd) * (rad - dd); f.y += (ey / dd) * (rad - dd); }
    }
  }

  // ---- getting hurt (the guard and the overseer's bullets go past them) ----------------------------

  hitBy(ax, ay, bx, by, r, segmentDistSq, shooter) {
    if (shooter?.side === 'state') return null;
    for (const f of this.folk) if (segmentDistSq(ax, ay, bx, by, f.x, f.y) < (config.oilHall.radius + r) ** 2) return f;
    return null;
  }

  damage(f, amount, attacker) {
    if (!this.folk.includes(f)) return false;
    if ((f.health -= amount) > 0) {
      if (f.state === 'pump' || f.state === 'sit') f.state = f.kind === 'worker' ? 'flee' : f.state; // (a worker shot at runs; a prisoner has nowhere to go)
      return false;
    }
    this.folk.splice(this.folk.indexOf(f), 1);
    this.world.bodies?.add({ x: f.x, y: f.y, angle: f.angle, kind: 'npc', look: [f.look, 1, 11, 9], items: [], cash: Math.floor(Math.random() * 6), killer: attacker?.kind === 'player' ? attacker : null });
    return true;
  }

  /** In view: [id, x, y, angle, state (0 pumping, 1 running, 2 sitting in a cell), look, health 0–100, prisoner]. */
  visible(x, y, range) {
    const states = { pump: 0, flee: 1, free: 1, sit: 2 };
    const out = [];
    for (const f of this.folk) {
      if (Math.abs(f.x - x) > range || Math.abs(f.y - y) > range) continue;
      out.push([f.id, Math.round(f.x), Math.round(f.y), Math.round(f.angle * 100) / 100, states[f.state], f.look, Math.round((f.health / config.oilHall.health) * 100), f.kind === 'prisoner' ? 1 : 0]);
    }
    return out;
  }
}
