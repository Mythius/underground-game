import { config } from '../config.js';
import { hotbarOf } from './cargo.js';
import { Vehicle } from './vehicles.js';
import { Environment } from './Environment.js';

// The tutorial: a world of its own for new accounts. A log cabin in a snowed-in forest, the lake out
// back, a long winding gravel driveway out to a country road. Always winter.
//
// The story (each player's own — nobody else sees their sister, the black car or the fire):
//   wake      Katya hits you with a snowball in bed: breakfast! (WASD, E for doors)
//   rod       in the kitchen she hands you Dad's rod: the fridge is empty, go and catch breakfast
//   fish      at the hole in the ice out back; once you've caught one she comes out (Dad's favourite spot)
//             and shows you how to pick a pocket — on you
//   back      bring the fish in (pick her pocket on the way and she's furious)
//   axe       she hands you the axe: firewood, from the birches out past the bend in the driveway
//   blackcar  while you chop, a black car comes up the driveway and goes past you to the house
//   fire      run back (Shift): the cabin's burning, Katya's gone, the black car's leaving — your Lada's out front
//   chase     after it, down the driveway and along the road…
//   crash     …until black ice halfway across the map puts you into a tree. Black. (Then the gulag.)

export const STAGES = ['wake', 'rod', 'fish', 'back', 'axe', 'blackcar', 'fire', 'chase', 'crash'];
const CABIN_W = 440, CABIN_H = 300;

/** A small seeded random generator (mulberry32): the same seed, the same forest. */
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Distance from (x, y) to the polyline `pts`, and how far along it the nearest point is: { d, s }. */
export function alongRoute(pts, cum, x, y) {
  let best = { d: Infinity, s: 0 };
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2));
    const px = ax + dx * t, py = ay + dy * t, d = Math.hypot(x - px, y - py);
    if (d < best.d) best = { d, s: cum[i - 1] + Math.sqrt(len2) * t };
  }
  return best;
}

/** The point `s` along the polyline, and which way it runs there: { x, y, angle }. */
export function routePoint(pts, cum, s) {
  s = Math.max(0, Math.min(cum.at(-1), s));
  let i = 1;
  while (i < pts.length - 1 && cum[i] < s) i++;
  const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
  const len = cum[i] - cum[i - 1] || 1, t = (s - cum[i - 1]) / len;
  return { x: ax + (bx - ax) * t, y: ay + (by - ay) * t, angle: Math.atan2(by - ay, bx - ax) };
}

const cumulative = (pts) => pts.reduce((out, p, i) => (out.push(i ? out[i - 1] + Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) : 0), out), []);

/** The tutorial world, as a map the World can be built from (no roads: the driveway and road are gravel trails). */
export function tutorialMap() {
  const { width: W, height: H, crashX } = config.tutorial;
  const rnd = seeded(1991);
  const C = { x: 900, y: 2100 }; // the cabin's top-left corner
  const door = { x: C.x + CABIN_W * 0.3, y: C.y + CABIN_H }; // its front door (south)
  const lake = { x: C.x + 200, y: C.y - 580, r: 430 }; // out back (north)
  // The driveway: down from the front door, round the yard and off east, winding through the forest; the
  // road it comes out on keeps winding east off the edge of the map.
  const route = [[door.x, door.y + 20], [door.x + 8, door.y + 230], [door.x + 170, door.y + 480], [door.x + 520, door.y + 620]];
  for (let x = door.x + 900; x <= W + 300; x += 300) {
    const y = 2750 + 600 * Math.sin((x - 1900) / 1300) + 210 * Math.sin(x / 430);
    route.push([Math.round(x), Math.round(Math.max(900, Math.min(H - 900, y)))]);
  }
  const cum = cumulative(route);
  const joinAt = route.findIndex(([x]) => x > 4800); // where the driveway meets the road
  const trails = [
    { points: route.slice(0, joinAt + 1), width: 110, gravel: true },
    { points: route.slice(joinAt), width: 150, gravel: true },
  ];
  // The birches for firewood: off the driveway past the first bend, a good walk from the house.
  const wood = routePoint(route, cum, 2300);
  const side = { x: -Math.sin(wood.angle), y: Math.cos(wood.angle) }; // (to the right of the way out)
  const woodlot = { x: Math.round(wood.x + side.x * 360), y: Math.round(wood.y + side.y * 360), r: 260 };
  const woodTrees = Array.from({ length: 7 }, (_, i) => {
    const a = (i / 7) * Math.PI * 2 + 0.4, d = i % 2 ? 190 : 120;
    return [Math.round(woodlot.x + Math.cos(a) * d), Math.round(woodlot.y + Math.sin(a) * d)];
  });
  // The black ice: on the bend nearest crashX, with a big birch on the outside of it.
  const ci = route.reduce((best, [x], i) => (Math.abs(x - crashX) < Math.abs(route[best][0] - crashX) ? i : best), 1);
  const [px, py] = route[ci], [ax, ay] = route[ci - 1], [bx, by] = route[ci + 1];
  const turn = Math.sign((px - ax) * (by - py) - (py - ay) * (bx - px)) || 1; // which way the road bends there
  const dir = Math.atan2(by - ay, bx - ax), out = { x: Math.sin(dir) * turn, y: -Math.cos(dir) * turn }; // (the outside of the bend)
  const crash = { x: px, y: py, s: cum[ci], tree: { x: Math.round(px + out.x * 170 + Math.cos(dir) * 120), y: Math.round(py + out.y * 170 + Math.sin(dir) * 120) } };

  // The forest: everywhere but the yard, the lake, the driveway and road, and the woodlot's clearing.
  const near = (x, y) =>
    Math.hypot(x - (C.x + CABIN_W / 2), y - (C.y + CABIN_H / 2)) < 620 ||
    Math.hypot(x - lake.x, y - lake.y) < lake.r + 160 ||
    Math.hypot(x - woodlot.x, y - woodlot.y) < woodlot.r + 140 ||
    Math.hypot(x - crash.tree.x, y - crash.tree.y) < 160 ||
    alongRoute(route, cum, x, y).d < 230;
  const trees = [{ x: crash.tree.x, y: crash.tree.y, canopy: 105 }];
  for (let tries = 0; trees.length < 1700 && tries < 9000; tries++) {
    const x = 60 + rnd() * (W - 120), y = 60 + rnd() * (H - 120);
    if (near(x, y) || trees.some((t) => Math.abs(t.x - x) < 120 && Math.abs(t.y - y) < 120)) continue;
    trees.push({ x: Math.round(x), y: Math.round(y), canopy: Math.round(60 + rnd() * 50) });
  }
  const forests = [];
  for (let x = 1200; x < W; x += 2200) for (let y = 900; y < H; y += 2000) if (!near(x, y)) forests.push({ x, y, r: 1300 });

  const at = (dx, dy) => ({ x: C.x + dx, y: C.y + dy });
  const layout = {
    cabin: { x: C.x, y: C.y, w: CABIN_W, h: CABIN_H },
    spots: {
      bed: at(392, 160), // where you wake up (beside the bed)
      bedroom: at(334, 150), // Katya in the bedroom doorway, snowball in hand
      doorway: at(296, 150),
      kitchen: at(215, 96),
      backIn: at(132, 50), backOut: at(132, -70),
      porch: at(190, -80),
      frontOut: at(132, CABIN_H + 70),
    },
    lake,
    iceHoles: [{ x: lake.x + 40, y: lake.y + lake.r - 120, r: 42 }],
    woodlot, woodTrees,
    park: { x: C.x + 290, y: C.y + CABIN_H + 140, angle: Math.PI / 2 }, // your Lada, out front
    route, cum, crash,
  };
  return {
    version: 1, width: W, height: H, roads: [], rivers: [], lakes: [lake], trails,
    buildings: [{ type: 'logcabin', x: C.x, y: C.y, rot: 0 }],
    trees, forests, lamps: [], vehicles: [], npcs: [], atms: [], lots: [],
    tutorial: layout,
  };
}

/** Each newcomer's story, in the tutorial world. */
export class Story {
  constructor(world, layout) {
    this.world = world;
    this.layout = layout;
    this.events = []; // { player, kind, … } for the room to pass on
    this.finished = []; // players whose story's over (the room sends them on to the gulag)
    world.iceHoles = layout.iceHoles; // (fishing through the ice)
    for (const [x, y] of layout.woodTrees) world.work.addNode('tree', x, y, config.work.nodes.logging.r);
    const cabin = world.buildings.find((b) => b.type === 'logcabin');
    if (cabin) world.furnishings.loadIn(cabin, cabin.furnish ?? [], null);
  }

  /** A newcomer wakes up in bed: nothing on them but a little cash. */
  start(p) {
    const s = this.layout.spots;
    Object.assign(p, { x: s.bed.x, y: s.bed.y, cash: config.tutorial.startCash, selected: 0 });
    p.inventory = p.inventory.map(() => null);
    p.story = { stage: 'wake', t: 0, katya: { x: s.bedroom.x, y: s.bedroom.y, angle: 0, path: [], gone: false }, held: 0, lifted: false, mad: false, black: null, car: null };
    this.#say(p, 'wake');
  }

  /** They've left the tutorial world (or logged off): their car goes too. */
  drop(p) {
    const car = p.story?.car;
    if (car && this.world.vehicles.get(car.id) === car) {
      for (const q of [car.driver, car.passenger]) if (q) this.world.leaveSeat(q);
      this.world.vehicles.delete(car.id);
    }
    if (p.story) p.story.car = null;
  }

  #say(p, kind, extra = {}) {
    this.events.push({ player: p, kind, stage: p.story.stage, ...extra });
  }

  #to(p, stage) {
    p.story.stage = stage;
    p.story.t = 0;
    this.#say(p, stage);
  }

  #walk(k, ...pts) {
    k.path = pts.map((q) => ({ x: q.x, y: q.y }));
  }

  /** F near Katya: picking her pocket. Returns null if she isn't in reach (an ordinary pickpocket, then). */
  pickpocket(p) {
    const st = p.story, k = st?.katya;
    if (!k || k.gone || Math.hypot(k.x - p.x, k.y - p.y) > config.pickpocket.reach + p.radius + 20) return null;
    if (!st.held) {
      this.#say(p, 'katya_empty');
      return {};
    }
    p.cash += st.held; // (your own money back, at least)
    const amount = st.held;
    st.held = 0;
    st.mad = true;
    this.#say(p, 'katya_mad', { amount });
    return { amount };
  }

  step(dt) {
    const T = config.tutorial, s = this.layout.spots;
    for (const p of this.world.players.values()) {
      const st = p.story;
      if (!st || !p.alive) continue;
      st.t += dt;
      const k = st.katya;
      // Katya walks wherever she's headed next.
      if (k.path.length) {
        const to = k.path[0], d = Math.hypot(to.x - k.x, to.y - k.y), step = T.katyaSpeed * dt;
        k.angle = Math.atan2(to.y - k.y, to.x - k.x);
        if (d <= step) { k.x = to.x; k.y = to.y; k.path.shift(); } else { k.x += ((to.x - k.x) / d) * step; k.y += ((to.y - k.y) / d) * step; }
      } else if (!k.gone && Math.hypot(p.x - k.x, p.y - k.y) < 500) k.angle = Math.atan2(p.y - k.y, p.x - k.x); // (she looks at you)
      const near = (q, r = T.talkReach) => Math.hypot(p.x - q.x, p.y - q.y) < r + p.radius;
      switch (st.stage) {
        case 'wake':
          if (st.t > 3.2 + config.tutorial.beatSec && !st.left) { st.left = true; this.#walk(k, s.doorway, s.kitchen); }
          if (st.left && !k.path.length && near(k)) this.#giveRod(p);
          break;
        case 'rod':
          if (p.fishing) this.#to(p, 'fish');
          break;
        case 'fish': { // once you've a fish, she comes out to see it — and shows you how to pick a pocket
          if (hotbarOf(p).count('fish') > 0 && !st.coming) {
            st.coming = true;
            this.#walk(k, s.backIn, s.backOut);
          }
          if (st.coming && !st.praised && !k.path.length) {
            const d = Math.hypot(p.x - k.x, p.y - k.y) || 1;
            if (d < p.radius + 60) {
              st.praised = true;
              st.praisedAt = st.t;
              this.#say(p, 'dads_spot');
            } else k.path = [{ x: p.x + ((k.x - p.x) / d) * (p.radius + 40), y: p.y + ((k.y - p.y) / d) * (p.radius + 40) }];
          }
          if (st.praised && !st.lifted && st.t - st.praisedAt > 6 + config.tutorial.beatSec) { // she slips round behind you…
            const aim = p.input.aim ?? 0, behind = { x: p.x - Math.cos(aim) * 34, y: p.y - Math.sin(aim) * 34 };
            if (Math.hypot(behind.x - k.x, behind.y - k.y) < 14 || (st.t - st.praisedAt > 12 + config.tutorial.beatSec && Math.hypot(p.x - k.x, p.y - k.y) < p.radius + 30)) {
              st.lifted = true; // …and lifts your cash, to show you how it's done
              st.held = p.cash;
              p.cash = 0;
              this.#say(p, 'lifted', { amount: st.held });
              this.#to(p, 'back');
              this.#walk(k, { x: k.x + 60, y: k.y + 80 }, s.backOut, s.backIn, s.kitchen);
            } else k.path = [behind];
          }
          break;
        }
        case 'back':
          if (!k.path.length && near(k) && hotbarOf(p).count('fish') > 0) {
            hotbarOf(p).add('fish', -hotbarOf(p).count('fish')); // (she'll fry it)
            const free = p.inventory.indexOf(null);
            if (free >= 0) { p.inventory[free] = { type: 'axe', tool: true }; p.selected = free; }
            this.#to(p, 'axe');
          }
          break;
        case 'axe':
          if (hotbarOf(p).count('logs') > 0) st.choppedAt ??= st.t;
          if (st.choppedAt !== undefined && st.t - st.choppedAt > config.tutorial.beatSec) this.#blackCar(p); // (a moment after the first tree's down)
          break;
        case 'blackcar': {
          const b = st.black;
          b.s = Math.max(0, b.s - T.blackSpeed * dt);
          this.#placeBlack(b);
          if (!b.passed && b.s < alongRoute(this.layout.route, this.layout.cum, p.x, p.y).s - 100) { b.passed = true; this.#say(p, 'passed'); }
          if (b.s <= 0) { // at the house: Katya's taken, the place set alight
            k.gone = true;
            k.path = [];
            st.held = 0;
            this.#parkCar(p);
            this.#to(p, 'fire');
          }
          break;
        }
        case 'fire': {
          const b = st.black;
          if (!b.leaving && (st.t > 25 || Math.hypot(p.x - b.x, p.y - b.y) < 900)) b.leaving = true; // (it's seen you coming)
          if (b.leaving) this.#chaseStep(p, b, dt, true);
          if (st.car && st.car.driver === p) this.#to(p, 'chase');
          break;
        }
        case 'chase':
          this.#chaseStep(p, st.black, dt, false);
          if ((p.vehicle?.x ?? 0) > this.layout.crash.x - 260) this.#crash(p);
          break;
        case 'crash': {
          const v = p.vehicle;
          if (v?.script) { // sliding on the ice: off the road and into the birch
            const tr = this.layout.crash.tree, want = Math.atan2(tr.y - v.y, tr.x - v.x);
            v.script.steer = Math.max(-1, Math.min(1, Math.atan2(Math.sin(want - v.angle), Math.cos(want - v.angle)) * 3));
            if (Math.hypot(tr.x - v.x, tr.y - v.y) < 75 || st.t > T.crashSec) { v.vx *= 0.1; v.vy *= 0.1; v.script = { gas: 0, steer: 0, grip: 0.2 }; }
          }
          this.#chaseStep(p, st.black, dt, false);
          if (st.t > T.crashSec + T.blackoutSec && !st.done) {
            st.done = true;
            this.finished.push(p);
          }
          break;
        }
      }
    }
  }

  #giveRod(p) {
    const free = p.inventory.indexOf(null);
    if (free >= 0 && !p.inventory.some((x) => x?.type === 'rod')) { p.inventory[free] = { type: 'rod', tool: true }; p.selected = free; }
    this.#to(p, 'rod');
  }

  /** The black car turns in at the road end and comes up the driveway, past you, to the house. */
  #blackCar(p) {
    const at = alongRoute(this.layout.route, this.layout.cum, p.x, p.y).s;
    p.story.black = { s: at + config.tutorial.blackLead, x: 0, y: 0, angle: 0, back: true };
    this.#placeBlack(p.story.black);
    this.#to(p, 'blackcar');
  }

  #placeBlack(b) {
    const at = routePoint(this.layout.route, this.layout.cum, b.s);
    Object.assign(b, { x: at.x, y: at.y, angle: b.back ? at.angle + Math.PI : at.angle });
  }

  /** Your Lada, out front of the house (yours alone: locked to anyone else). */
  #parkCar(p) {
    if (p.story.car) return;
    const w = this.world, at = this.layout.park, n = [...w.players.values()].filter((q) => q.story?.car).length;
    const v = new Vehicle(w.nextEntityId++, 'sedan', at.x + (n % 4) * 70, at.y + Math.floor(n / 4) * 120, at.angle);
    Object.assign(v, { color: '#7a1f2b', fuel: 100, storyOf: p }); // (no owner: it isn't saved anywhere)
    w.vehicles.set(v.id, v);
    p.story.car = v;
  }

  /** The black car making off down the road, keeping just ahead of you (`waiting`: before you're in your car, it only gets so far). */
  #chaseStep(p, b, dt, waiting) {
    if (!b) return;
    const T = config.tutorial, L = this.layout;
    b.back = false;
    const you = p.vehicle ?? p;
    const mine = alongRoute(L.route, L.cum, you.x, you.y).s;
    const gap = b.s - mine;
    const [fast, normal, slow] = T.chaseSpeed;
    let speed = gap < T.chaseGap * 0.6 ? fast : gap > T.chaseGap * 1.6 ? slow : normal;
    if (waiting && b.s > 3200) speed = gap > T.chaseGap * 2.5 ? 0 : speed; // (round the bend, out of sight: it idles till you come)
    if (!waiting && gap > T.chaseGap * 2.5) speed = 0;
    b.s = Math.min(L.cum.at(-1), b.s + speed * dt);
    this.#placeBlack(b);
  }

  #crash(p) {
    const v = p.vehicle;
    if (v) v.script = { gas: 0.6, steer: 0, grip: 0.12 }; // (black ice: the wheel goes light)
    this.#to(p, 'crash');
  }

  /** What the client draws of my story: [stage, seconds in it, Katya [x, y, angle] | 0, black car [x, y, angle] | 0, Katya has my cash, she's mad]. */
  view(p) {
    const st = p.story;
    if (!st) return 0;
    const k = st.katya, b = st.black, r = (n) => Math.round(n * 10) / 10;
    return [STAGES.indexOf(st.stage), r(st.t), k.gone ? 0 : [r(k.x), r(k.y), r(k.angle)], b ? [r(b.x), r(b.y), Math.round(b.angle * 100) / 100] : 0, st.held, st.mad ? 1 : 0];
  }
}

/** The tutorial's weather: always winter, always mid-morning, a little snow coming down. */
export class WinterMorning extends Environment {
  constructor() {
    super({ ...config.environment, daySec: 1e7, startSec: 600, seasons: ['winter'], seasonSec: 1e9, maxPerWeek: 0 });
  }

  intensity(kind) {
    return kind === 'rain' ? 0.35 : kind === 'fog' ? 0.1 : 0;
  }
}
