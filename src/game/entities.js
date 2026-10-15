import { config } from '../config.js';

const COLORS = ['#e6194b', '#3cb44b', '#ffe119', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6', '#bfef45', '#fabed4'];

export const massToRadius = (mass) => 4 * Math.sqrt(mass);

/** A gun in someone's inventory. Ammo and reload progress belong to the gun, not the player. */
/** What everyone starts with; it can't be dropped or looted. */
export const STARTER_WEAPON = 'knife';

export const makeWeapon = (type) => ({ type, ammo: config.weapons[type].magazineSize, reloadTimer: 0 });

export class Player {
  constructor(id, name, x, y, look = null) {
    this.kind = 'player';
    this.id = id;
    this.name = name;
    // Chosen look (indexes into config.looks); the shirt doubles as the player's colour in chat and the leaderboard.
    this.look = look ?? { skin: id % config.looks.skins.length, shirt: id % config.looks.shirts.length, pants: 0, hat: id % config.looks.hats.length };
    this.color = config.looks.shirts[this.look.shirt] ?? COLORS[id % COLORS.length];
    this.x = x;
    this.y = y;
    this.mass = config.player.startMass;
    this.health = config.player.maxHealth;
    this.stamina = config.player.staminaMax;
    this.vx = 0; // walking velocity: only matters on ice, where it carries you along
    this.vy = 0;
    this.staminaDelay = 0; // seconds until stamina starts refilling
    this.exhausted = false; // ran dry; can't sprint until staminaMinToSprint is back
    this.shotCooldown = 0;
    this.inventory = Array.from({ length: config.player.inventorySize }, () => null);
    this.inventory[0] = makeWeapon(STARTER_WEAPON);
    this.selected = 0;
    this.vehicle = null; // the Vehicle being driven
    this.lastVehicle = null; // the one they last drove (its cargo counts as theirs while it's close)

    this.cash = 0; // carried dollars: dropped on death; bank them to keep them
    this.wanted = 0; // police stars, 0–5
    this.lastSeen = 0; // when police last saw them (economy time)
    this.robbing = null; // robbery in progress
    this.jailed = null; // { until, station } while in a cell
    this.arrest = 0; // 0–1: how close an officer is to arresting them (this tick)
    this.shotPolice = false;
    this.account = null; // { id, name, bank, guest } — set when spawned
    this.hitCooldown = 0; // after being hit by a car
    this.alive = true;
    this.input = { angle: 0, throttle: 0, boost: false, aim: 0, fire: false, reload: false, use: false, gas: 0, steer: 0, drift: false, rob: false };
    this.lastInputSeq = -1;
    this.spawnedAt = Date.now();
  }

  get radius() {
    return massToRadius(this.mass);
  }

  get score() {
    return Math.floor(this.mass);
  }

  /** Bigger players move slower… */
  get speed() {
    const { baseSpeed, startMass, speedExponent } = config.player;
    return baseSpeed * Math.pow(startMass / this.mass, speedExponent);
  }

  /** …but can take more hits. */
  get maxHealth() {
    const { maxHealth, startMass, healthExponent } = config.player;
    return Math.round(maxHealth * Math.pow(this.mass / startMass, healthExponent));
  }

  heal(amount) {
    this.health = Math.min(this.maxHealth, this.health + amount);
  }

  /** Take damage: less of it with a vodka buzz on. */
  hurt(amount) {
    this.health -= this.buzz > 0 ? amount * config.economy.vodka.damageTaken : amount;
    this.sleeping = null; // (that wakes you up)
  }

  /** The gun in the selected slot, or null (empty hand, or a stack of goods). */
  get weapon() {
    const slot = this.inventory[this.selected];
    return slot?.type && !slot.tool ? slot : null;
  }

  /** The work tool in hand (pickaxe, axe, scythe), if that's what's selected. */
  get tool() {
    const slot = this.inventory[this.selected];
    return slot?.tool ? slot : null;
  }

  hasWeapon(type) {
    return this.inventory.some((w) => w?.type === type);
  }

  /** Puts a gun in the first free slot. Returns false if full. */
  addWeapon(weapon) {
    const most = config.weapons[weapon.type]?.thrown ? config.weapons[weapon.type].magazineSize : 0; // (Molotovs stack)
    const pile = most && this.inventory.find((s) => s?.type === weapon.type && s.ammo + weapon.ammo <= most);
    if (pile) { pile.ammo += weapon.ammo; return true; }
    const slot = this.inventory.indexOf(null);
    if (slot === -1) return false;
    this.inventory[slot] = weapon;
    return true;
  }

  selectSlot(slot) {
    if (slot === this.selected) return;
    // Switching away cancels a reload in progress.
    if (this.weapon) this.weapon.reloadTimer = 0;
    this.selected = slot;
  }

  applyInput({ seq, angle, throttle, boost, aim = angle, fire = false, reload = false, use = false, slot = null, gas = 0, steer = 0, drift = false, rob = false }) {
    if (seq <= this.lastInputSeq) return; // stale / reordered
    this.lastInputSeq = seq;
    this.input.angle = angle;
    this.input.throttle = throttle;
    this.input.boost = boost;
    this.input.aim = aim;
    this.input.fire = fire;
    // Latched until the world handles it, so a later input can't swallow a reload press.
    if (reload) this.input.reload = true;
    if (use) this.input.use = true;
    this.input.gas = gas;
    this.input.steer = steer;
    this.input.drift = drift;
    this.input.rob = rob; // held: robbing goes on only while F is down
    if (slot !== null && slot < this.inventory.length) this.selectSlot(slot);
  }

  get publicInfo() {
    return { id: this.id, name: this.name, color: this.color, look: this.look };
  }
}

export class Bullet {
  constructor(id, owner, x, y, angle, weaponType) {
    const { bulletSpeed, bulletLifetimeSec, damage } = config.weapons[weaponType];
    this.kind = 'bullet';
    this.id = id;
    this.owner = owner;
    this.x = x;
    this.y = y;
    this.vx = Math.cos(angle) * bulletSpeed;
    this.vy = Math.sin(angle) * bulletSpeed;
    this.ttl = bulletLifetimeSec;
    this.damage = damage;
    this.weaponType = weaponType;
    this.radius = config.bulletRadius;
  }
}

/** A gun, a bag of cash or a stack of goods lying on the ground, picked up by walking over it. */
export class Pickup {
  constructor(id, x, y, weapon, cash = 0, goods = null) {
    this.kind = 'pickup';
    this.id = id;
    this.x = x;
    this.y = y;
    this.weapon = weapon; // null for cash and goods
    this.cash = cash;
    this.goods = goods; // { good, qty }
    this.droppedBy = null; // who can't pick it straight back up…
    this.noPickupUntil = 0; // …until this world tick
    this.radius = config.world.pickupRadius;
  }
}

export class Food {
  constructor(id, x, y) {
    this.kind = 'food';
    this.id = id;
    this.x = x;
    this.y = y;
    this.mass = config.world.foodMass;
    this.radius = 6;
  }
}
