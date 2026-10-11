import { config } from '../config.js';
import { WORK_SITES } from './buildings.js';
import { hotbarOf } from './cargo.js';

// Working the land: the early-game living. At a mine, lumberyard or farm you borrow the site's tool
// from the foreman (it goes back the moment you leave the site), hit the rocks / trees / wheat to
// gather into your hotbar, and sell the haul to the foreman. Resources grow back after a while.
//
//   node: { id, site, kind: 'rock' | 'vein' | 'tree' | 'wheat', x, y, r, hp, max, readyAt }
//
// Anyone can work any site. A player can buy a site: then the foreman's wages come out of their bank,
// and whatever the site sells goes into it.

const KIND_OF_TOOL = { pickaxe: ['rock', 'vein'], axe: ['tree'], scythe: ['wheat'] };

export class Work {
  constructor(world) {
    this.world = world;
    this.nodes = new Map();
    this.changed = []; // nodes whose state changed this step, for the room to broadcast
    this.events = []; // { player, kind, ... }
    this.timer = 0;
    let id = 1;
    const w = config.work;
    for (const b of world.buildings) {
      if (!WORK_SITES[b.type] || !b.work?.w) continue;
      const area = b.work;
      const spec = w.nodes[b.type];
      const gx = spec.gapX ?? spec.gap, gy = spec.gapY ?? spec.gap;
      const jitter = spec.rows ? 0 : 0.4; // farm rows are dead straight
      for (let y = area.y + gy / 2; y < area.y + area.h - gy / 3; y += gy) {
        for (let x = area.x + gx / 2; x < area.x + area.w - gx / 3; x += gx) {
          if (Math.random() > spec.density) continue;
          const jx = x + (Math.random() - 0.5) * gx * jitter, jy = y + (Math.random() - 0.5) * gy * jitter;
          if (world.isSwimming(jx, jy)) continue;
          const kind = b.type === 'mine' ? (Math.random() < w.veinChance ? 'vein' : 'rock') : spec.kind;
          const max = w.hp[kind];
          this.nodes.set(id, { id, site: b.id, kind, x: Math.round(jx), y: Math.round(jy), r: spec.r, hp: max, max, readyAt: 0 });
          id++;
        }
      }
    }
  }

  get time() {
    return this.world.economy.time;
  }

  siteOf(id) {
    return this.world.buildings[id - 1] ?? null;
  }

  step(dt) {
    const w = this.world;
    // Swings: a tool in hand and the mouse down.
    for (const p of w.players.values()) {
      p.swingCooldown = Math.max(0, (p.swingCooldown ?? 0) - dt);
      const tool = p.tool;
      if (!tool || !p.input.fire || p.vehicle || p.carrying || p.hidden || p.swingCooldown > 0) continue;
      p.swingCooldown = config.work.swingSec;
      this.#swing(p, tool);
    }
    // Regrowth, and tools taken back from anyone who wanders off the site.
    this.timer += dt;
    if (this.timer < 1) return;
    this.timer = 0;
    for (const n of this.nodes.values()) {
      if (n.hp <= 0 && this.time >= n.readyAt) {
        n.hp = n.max;
        this.changed.push(n);
      }
    }
    for (const p of w.players.values()) {
      p.inventory.forEach((slot, i) => {
        if (!slot?.tool || !slot.site) return; // (a fishing rod is yours to keep)
        const b = this.siteOf(slot.site);
        const m = config.work.leaveRange;
        if (b && p.x > b.x - m && p.x < b.x + b.w + m && p.y > b.y - m && p.y < b.y + b.h + m && p.alive) return;
        p.inventory[i] = null;
        this.events.push({ player: p, kind: 'tool_returned', tool: slot.type });
      });
    }
  }

  /** One hit at the nearest thing in front of you that this tool works on. */
  #swing(p, tool) {
    const kinds = KIND_OF_TOOL[tool.type] ?? [];
    const reach = config.work.reach + p.radius;
    const aim = p.input.aim ?? 0;
    let best = null;
    let bestD = Infinity;
    for (const n of this.nodes.values()) {
      if (n.hp <= 0 || !kinds.includes(n.kind)) continue;
      if (n.kind === 'wheat' && this.world.frozen) continue; // no wheat in winter
      const dx = n.x - p.x, dy = n.y - p.y;
      if (Math.abs(dx) > reach + n.r || Math.abs(dy) > reach + n.r) continue;
      const d = Math.hypot(dx, dy) - n.r;
      if (d > reach || d >= bestD) continue;
      if (d > 10 && (dx * Math.cos(aim) + dy * Math.sin(aim)) / (d + n.r) < 0.3) continue; // has to be in front of you
      [best, bestD] = [n, d];
    }
    if (!best) return;
    const yieldOf = this.#yield(best);
    if (best.hp === 1) {
      // The last hit: make sure it all fits first.
      const bag = hotbarOf(p).clone();
      for (const [g, q] of Object.entries(yieldOf)) {
        if (bag.room(g) < q) {
          this.events.push({ player: p, kind: 'error', code: 'bag_full' });
          return;
        }
        bag.add(g, q);
      }
      for (const [g, q] of Object.entries(yieldOf)) hotbarOf(p).add(g, q);
      best.hp = 0;
      best.readyAt = this.time + config.work.regrowSec[best.kind];
      this.events.push({ player: p, kind: 'gathered', items: yieldOf });
    } else best.hp -= 1;
    this.changed.push(best);
  }

  /** What a node gives when it's worked out (a little luck at the rock face). */
  #yield(n) {
    const w = config.work;
    if (n.kind === 'rock') {
      const out = { ore: 1 };
      if (Math.random() < w.extraSand) out.sand = 1;
      else if (Math.random() < w.extraScrap) out.scrap = 1;
      return out;
    }
    return { ...w.yield[n.kind] };
  }

  // ---- the foreman ---------------------------------------------------------------------

  /** Borrow the site's tool (or hand it back). */
  tool(p, siteId) {
    const b = this.siteOf(siteId);
    const type = b && WORK_SITES[b.type];
    if (!type) return 'no_work_here';
    const held = p.inventory.findIndex((s) => s?.tool && s.site === siteId);
    if (held >= 0) {
      p.inventory[held] = null;
      return { returned: type };
    }
    if (p.inventory.some((s) => s?.tool && s.site)) return 'one_tool';
    const free = p.inventory.indexOf(null);
    if (free < 0) return 'no_room';
    p.inventory[free] = { type, tool: true, site: siteId };
    p.selected = free;
    return { borrowed: type };
  }

  /** What the foreman pays per unit for what you gathered. */
  wage(good) {
    return Math.max(1, Math.round(config.goods[good].base * config.work.wageShare));
  }

  /** Which goods this site's foreman takes off your hands. */
  takes(type) {
    return config.work.takes[type] ?? [];
  }
}
