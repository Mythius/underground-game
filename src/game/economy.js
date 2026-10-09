import { config } from '../config.js';
import { Combined, fits, hotbarOf, trunkOf } from './cargo.js';
import { inRect } from './parking.js';

// Markets, factories and cargo. Pure state advanced by step(dt); the World owns one of these.
//
//   raw site  (logging, farm, mine, …): sells its one raw good and slowly produces more.
//   depot     (market building):        buys and sells every good.
//   gas       (gas station):            buys fuel deliveries, sells fuel as car refills.
//   shop      (food shop):              buys bread, sells meals made from it.
//   gunstore  (gun store):              buys crates of guns, sells guns to carry.
//   dealership(car dealer):             buys new cars from factories, sells drivable vehicles.
//
// Delivery jobs ask players to haul goods (provided free) between markets for pay.
//
// Each market keeps a stock per good; price = base × (1.5 − 0.5 × stock/target), clamped to 0.5–1.5×,
// so buying out a good makes it dearer and flooding it makes it cheap. Stock drifts back toward 60%
// of normal over time (NPC trade) — that's what keeps prices "breathing".

const RAW_SITES = { logging: 'logs', farm: 'wheat', mine: 'ore', oilwell: 'crude', scrapyard: 'scrap', quarry: 'sand' };
const DEPOT_TARGETS = { car: 4, guns: 10, furniture: 20, parts: 25 }; // big-ticket goods: smaller normal stock

const add = (bag, good, qty) => {
  bag[good] = (bag[good] ?? 0) + qty;
  if (bag[good] <= 0) delete bag[good];
};

export class Economy {
  constructor(world) {
    this.world = world;
    this.markets = new Map(); // building id -> market
    this.factories = new Map(); // building id -> factory
    this.jobs = new Map(); // id -> delivery job
    this.events = []; // raids etc., for the room to announce
    this.nextJobId = 1;
    this.jobTimer = 0;
    this.time = 0; // seconds since the world began
    this.trendTimer = 0;
    const m = config.markets;
    for (const b of world.buildings) {
      if (!b.npc) continue;
      const at = { id: b.id, type: b.type, x: b.npc.x, y: b.npc.y };
      if (RAW_SITES[b.type]) {
        const goods = { [RAW_SITES[b.type]]: { stock: m.rawTarget, target: m.rawTarget } };
        // The mine also sells the sand and scrap that turn up at the rock face.
        if (b.type === 'mine') Object.assign(goods, { sand: { stock: 40, target: 60 }, scrap: { stock: 30, target: 60 } });
        this.markets.set(b.id, { ...at, kind: 'raw', goods, work: Boolean(config.work.prices[b.type]), owner: null });
      } else if (b.type === 'market') {
        const goods = {};
        for (const g of Object.keys(config.goods)) {
          if (config.goods[g].illegal) continue; // contraband goes under the table or to the black market
          const target = DEPOT_TARGETS[g] ?? m.depotTarget;
          goods[g] = { stock: Math.round(target * 0.6), target };
        }
        this.markets.set(b.id, { ...at, kind: 'depot', goods });
      } else if (b.type === 'gas') {
        this.markets.set(b.id, { ...at, kind: 'gas', goods: { fuel: { stock: 120, target: 200 }, bread: { stock: 15, target: 25 } } });
      } else if (b.type === 'shop' || b.type === 'kiosk') {
        this.markets.set(b.id, { ...at, kind: 'shop', goods: { bread: { stock: 30, target: 50 } } });
      } else if (b.type === 'gunstore') {
        this.markets.set(b.id, { ...at, kind: 'gunstore', goods: { guns: { stock: 12, target: 20 } } });
      } else if (b.type === 'dealership') {
        this.markets.set(b.id, { ...at, kind: 'dealership', goods: { car: { stock: 3, target: 6 } } });
      } else if (config.factories[b.type]) {
        this.factories.set(b.id, at); // city-run: anyone pays a toll to process their own goods here
      }
    }
  }

  // ---- prices ---------------------------------------------------------------

  price(market, good) {
    const entry = market.goods[good];
    const ratio = entry ? entry.stock / entry.target : 1;
    return config.goods[good].base * Math.min(1.5, Math.max(0.5, 1.5 - 0.5 * ratio));
  }
  /** What a player pays per unit. */
  buyPrice(market, good) {
    return Math.max(1, Math.ceil(this.price(market, good) * (1 + config.markets.spread)));
  }
  /** What a player is paid per unit. */
  sellPrice(market, good) {
    return Math.max(1, Math.floor(this.price(market, good) * (1 - config.markets.spread)));
  }
  /** Goods a player can buy here as goods (gun stores and dealers sell guns and vehicles instead). */
  sells(market, good) {
    return (market.kind === 'raw' || market.kind === 'depot') && Boolean(market.goods[good]);
  }
  buys(market, good) {
    if (market.kind === 'depot') return true;
    return Boolean(market.goods[good]) && market.kind !== 'raw';
  }
  /** A meal's price at a food shop (or gas station): its menu price × how scarce bread is there. */
  foodPrice(market, item) {
    const food = config.economy.menu[item];
    return market?.goods.bread && food.bread ? Math.round(food.price * this.scarcity(market, 'bread')) : food.price;
  }

  /** Price multiplier from a market's stock of `good` (1 at normal stock). */
  scarcity(market, good) {
    return this.price(market, good) / config.goods[good].base;
  }

  // ---- cargo ------------------------------------------------------------------

  /** The vehicle whose trunk counts as p's: the one they're driving, or last drove/opened if it's close. */
  vehicleOf(p) {
    if (p.vehicle) return p.vehicle;
    const v = p.lastVehicle;
    const live = v && this.world.vehicles.has(v.id);
    if (live && Math.hypot(v.x - p.x, v.y - p.y) < config.cargo.nearbyVehicle) return v;
    // Further off, but parked in the delivery bay of the building you're at (yours, or the last you drove).
    for (const bay of [...(this.world.bays ?? []), ...(this.world.lots ?? []).filter((l) => l.building)]) { // a business's own parking counts too
      const b = this.world.buildings[bay.building - 1];
      const m = config.cargo.bayReach;
      if (!b || p.x < b.x - m || p.x > b.x + b.w + m || p.y < b.y - m || p.y > b.y + b.h + m) continue;
      for (const car of [live ? v : null, ...this.world.vehicles.values()]) {
        if (!car || car.driver || (car !== v && !(car.owner && car.owner === p.account))) continue;
        if (inRect(bay, car.x, car.y)) return car;
      }
    }
    return null;
  }

  /**
   * Everything a player can trade with, as one: their hotbar plus their vehicle's trunk. Goods are taken
   * from the hotbar first and put in the trunk first.
   */
  cargoOf(p) {
    const v = this.vehicleOf(p);
    return new Combined(v ? [hotbarOf(p), trunkOf(v)] : [hotbarOf(p)]);
  }

  // ---- simulation -------------------------------------------------------------

  step(dt) {
    this.time += dt;
    this.#jobsStep(dt);
    // Remember prices now and then, so panels can show which way they're heading.
    this.trendTimer += dt;
    if (this.trendTimer >= config.markets.trendEverySec || !this.trendTimer) {
      this.trendTimer = 0;
      for (const market of this.markets.values()) {
        market.lastPrices = market.prices ?? null;
        market.prices = Object.fromEntries(Object.keys(market.goods).map((g) => [g, this.price(market, g)]));
      }
    }
    const m = config.markets;
    const cool = (config.underTable.heatDecayPerMin * dt) / 60;
    for (const market of this.markets.values()) if (market.heat) market.heat = Math.max(0, market.heat - cool);
    for (const market of this.markets.values()) {
      for (const entry of Object.values(market.goods)) {
        // Raw sites produce a little on their own (NPC hands); work sites mostly need players.
        if (market.kind === 'raw') entry.stock = Math.min(entry.target * 1.5, entry.stock + (market.work ? config.work.npcProducePerSec : m.rawProducePerSec) * dt);
        else entry.stock += (entry.target * 0.6 - entry.stock) * m.driftPerSec * dt;
      }
    }
  }

  #best(accept, score) {
    let best = null;
    let bestScore = -Infinity;
    for (const mk of this.markets.values()) {
      if (!accept(mk)) continue;
      const s = score(mk);
      if (s > bestScore) [best, bestScore] = [mk, s];
    }
    return best;
  }

  // ---- player actions (each returns an error code, or null on success) --------

  #near(p, place, reach) {
    return Math.hypot(place.x - p.x, place.y - p.y) < reach + p.radius;
  }

  /** Buy (`side: 'buy'`) or sell `qty` of `good` at market `id`, paying/receiving carried cash. */
  trade(p, id, good, qty, side) {
    const market = this.markets.get(id);
    if (!market || !config.goods[good]) return 'unknown';
    if (!this.#near(p, market, config.markets.reach)) return 'too_far';
    const holder = this.cargoOf(p);
    if (side === 'buy') {
      if (!this.sells(market, good)) return 'not_sold_here';
      qty = Math.min(qty, Math.floor(market.goods[good].stock));
      if (qty <= 0) return 'sold_out';
      if (holder.room(good) < qty) return 'no_room';
      const cost = this.buyPrice(market, good) * qty;
      if (p.cash < cost) return 'not_enough_cash';
      p.cash -= cost;
      market.goods[good].stock -= qty;
      holder.add(good, qty);
      if (market.owner) { // an owned site: the takings go to the owner
        market.owner.bank += cost;
        this.world.onBankChange?.(market.owner);
      }
    } else {
      if (!this.buys(market, good)) return 'not_bought_here';
      if (holder.count(good) < qty) return 'not_carrying';
      p.cash += this.sellPrice(market, good) * qty;
      market.goods[good].stock += qty;
      holder.add(good, -qty);
    }
    return null;
  }

  /** The fee to process one batch of `recipe` for someone who doesn't own the factory. */
  tollFee(recipe) {
    const value = (bag) => Object.entries(bag).reduce((sum, [g, q]) => sum + config.goods[g].base * q, 0);
    return Math.max(1, Math.round((value(recipe.out) - value(recipe.in)) * config.factory.tollShare));
  }

  /**
   * What toll processing would do for player p at factory f: the first recipe their cargo can make,
   * as many batches as their inputs, cargo space and cash allow. { recipe, batches, wanted, fee } or an error code.
   */
  #processPlan(p, f) {
    const holder = this.cargoOf(p);
    for (const recipe of config.factories[f.type].recipes) {
      const wanted = Math.min(...Object.entries(recipe.in).map(([g, q]) => Math.floor(holder.count(g) / q)));
      if (wanted <= 0) continue;
      const scale = (bag, n) => Object.fromEntries(Object.entries(bag).map(([g, q]) => [g, q * n]));
      // Most batches whose outputs still fit once the inputs are used up.
      let lo = 0;
      let hi = wanted;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (fits(holder, scale(recipe.in, mid), scale(recipe.out, mid))) lo = mid;
        else hi = mid - 1;
      }
      if (lo <= 0) return { error: 'no_room', wanted };
      const fee = this.tollFee(recipe);
      const batches = Math.min(lo, Math.floor(p.cash / fee));
      if (batches <= 0) return { error: 'not_enough_cash', wanted, fee };
      return { recipe, batches, wanted, fee, holder, scale };
    }
    return { error: 'nothing_to_process' };
  }

  /**
   * Toll processing at a city factory: turn the inputs in your cargo into outputs right now, paying
   * the fee per batch. Returns an error code, or { batches, fee }.
   */
  process(p, id) {
    const f = this.factories.get(id);
    if (!f) return 'unknown';
    if (!this.#near(p, f, config.factory.reach)) return 'too_far';
    const plan = this.#processPlan(p, f);
    if (plan.error) return plan.error;
    const { recipe, batches, fee, holder, scale } = plan;
    for (const [g, q] of Object.entries(scale(recipe.in, batches))) holder.add(g, -q);
    for (const [g, q] of Object.entries(scale(recipe.out, batches))) holder.add(g, q);
    p.cash -= fee * batches;
    return { batches, fee: fee * batches };
  }

  // ---- contraband over the counter ----------------------------------------------------

  /** Can this market buy contraband under the table? (Shops and kiosks.) */
  underTableHere(market) {
    return market?.kind === 'shop';
  }

  isClosed(market) {
    return (market?.closedUntil ?? 0) > this.time;
  }

  /**
   * Sell contraband at a shop or kiosk: full base price, but it raises the place's heat; at 100 the
   * Militsiya raid it and it shuts for a while. Selling it in front of the Militsiya is a crime.
   */
  underTable(p, id, good, qty) {
    const market = this.markets.get(id);
    if (!this.underTableHere(market) || !config.goods[good]?.illegal) return 'not_bought_here';
    if (!this.#near(p, market, config.markets.reach)) return 'too_far';
    if (this.isClosed(market)) return 'closed_raid';
    const holder = this.cargoOf(p);
    qty = Math.min(qty, holder.count(good));
    if (qty <= 0) return 'not_carrying';
    const pay = config.goods[good].base * qty;
    holder.add(good, -qty);
    p.cash += pay;
    market.heat = (market.heat ?? 0) + pay / config.underTable.heatPerValue;
    if (this.world.police.policeSee(p.x, p.y)) this.world.police.crime(p, 'sell_contraband', true);
    if (market.heat >= 100) {
      market.heat = 0;
      market.closedUntil = this.time + config.underTable.raidClosedSec;
      this.events.push({ kind: 'raid', building: id });
    }
    return { qty, paid: pay };
  }

  // ---- work sites: the foreman --------------------------------------------------------

  /** tool (borrow / give back) · haul (sell what you gathered) · buy / sell (the whole site). */
  workAction(p, id, action) {
    const market = this.markets.get(id);
    if (!market?.work) return 'no_work_here';
    if (!this.#near(p, market, config.markets.reach)) return 'too_far';
    const work = this.world.work;
    if (action === 'tool') return work.tool(p, id);
    if (action === 'haul') {
      const holder = hotbarOf(p); // what you carry by hand (the foreman doesn't unload cars)
      let qty = 0, pay = 0;
      for (const good of work.takes(market.type)) {
        const n = holder.count(good);
        if (!n) continue;
        qty += n;
        pay += n * work.wage(good);
      }
      if (!qty) return 'nothing_to_sell';
      if (market.owner && market.owner.bank < pay) return 'owner_broke';
      for (const good of work.takes(market.type)) {
        const n = holder.count(good);
        if (!n) continue;
        holder.add(good, -n);
        market.goods[good] ??= { stock: 0, target: 60 };
        market.goods[good].stock += n;
      }
      p.cash += pay;
      if (market.owner) {
        market.owner.bank -= pay;
        this.world.onBankChange?.(market.owner);
      }
      return { qty, paid: pay };
    }
    const price = config.work.prices[market.type];
    if (action === 'buy') {
      if (market.owner) return 'already_owned';
      if (!p.account || p.account.guest) return 'need_account';
      if (p.account.bank < price) return 'not_enough_bank';
      p.account.bank -= price;
      market.owner = p.account;
      this.world.onBankChange?.(p.account);
      return { bought: market.type };
    }
    if (action === 'sell') {
      if (market.owner !== p.account) return 'not_owner';
      p.account.bank += Math.floor(price * config.work.sellBack);
      market.owner = null;
      this.world.onBankChange?.(p.account);
      return { sold: market.type };
    }
    return 'unknown';
  }

  /** Who owns each work site. */
  siteOwners() {
    return [...this.markets.values()].filter((m) => m.work).map((m) => [m.id, m.owner?.name ?? null]);
  }

  /** Fill the tank of the car you're in (or just got out of) at a gas station, paying cash. */
  refuel(p) {
    const station = [...this.markets.values()].find((m) => m.kind === 'gas' && this.#near(p, m, config.fuel.pumpReach));
    if (!station) return 'too_far';
    const v = p.vehicle ?? p.lastVehicle;
    if (!v || !this.world.vehicles.has(v.id) || Math.hypot(v.x - station.x, v.y - station.y) > config.fuel.pumpReach + v.radius) return 'no_car';
    // One unit of fuel fills 10% of a tank.
    const units = Math.min(Math.ceil((100 - v.fuel) / 10), Math.floor(station.goods.fuel.stock));
    if (units <= 0) return v.fuel >= 99 ? 'tank_full' : 'sold_out';
    const unit = this.buyPrice(station, 'fuel');
    const affordable = Math.min(units, Math.floor(p.cash / unit));
    if (affordable <= 0) return 'not_enough_cash';
    p.cash -= affordable * unit;
    station.goods.fuel.stock -= affordable;
    v.fuel = Math.min(100, v.fuel + affordable * 10);
    return null;
  }

  // ---- gun stores and dealerships -----------------------------------------------

  gunPrice(market, type) {
    return Math.round(config.gunstore.guns[type].price * this.scarcity(market, 'guns'));
  }
  vehiclePrice(market, type) {
    return Math.round(config.dealership.vehicles[type] * this.scarcity(market, 'car'));
  }

  /** Buy a gun to carry (cash). */
  buyGun(p, id, type) {
    const store = this.markets.get(id);
    const item = config.gunstore.guns[type];
    if (!store || store.kind !== 'gunstore' || !item) return 'unknown';
    if (!this.#near(p, store, config.markets.reach)) return 'too_far';
    if (store.goods.guns.stock < item.uses) return 'sold_out';
    if (p.hasWeapon(type)) return 'already_have';
    if (!p.inventory.includes(null)) return 'no_room';
    const price = this.gunPrice(store, type);
    if (p.cash < price) return 'not_enough_cash';
    p.cash -= price;
    store.goods.guns.stock -= item.uses;
    p.addWeapon(this.world.makeWeapon(type));
    return null;
  }

  /** Buy a new vehicle (from the bank); it's parked outside with your name on it. */
  buyVehicle(p, id, type) {
    const dealer = this.markets.get(id);
    if (!dealer || dealer.kind !== 'dealership' || !config.dealership.vehicles[type]) return 'unknown';
    if (!this.#near(p, dealer, config.markets.reach)) return 'too_far';
    if (dealer.goods.car.stock < 1) return 'sold_out';
    const price = this.vehiclePrice(dealer, type);
    if (!p.account || p.account.bank < price) return 'not_enough_bank';
    const v = this.world.parkNewVehicle(type, dealer.id, p.account);
    if (!v) return 'no_parking';
    p.account.bank -= price;
    dealer.goods.car.stock -= 1;
    p.lastVehicle = v;
    this.world.onBankChange?.(p.account);
    return null;
  }

  // ---- delivery jobs --------------------------------------------------------------

  #jobsStep(dt) {
    const j = config.jobs;
    for (const job of this.jobs.values()) {
      if (job.taker ? this.time > job.deadline : this.time > job.offeredUntil) this.jobs.delete(job.id);
    }
    this.jobTimer += dt;
    if (this.jobTimer < j.everySec) return;
    this.jobTimer = 0;
    if ([...this.jobs.values()].filter((x) => !x.taker).length >= j.max) return;
    this.#offerJob();
  }

  /** A new job: some good a market sells, wanted by another market that buys it, far enough apart. */
  #offerJob() {
    const markets = [...this.markets.values()];
    if (markets.length < 2) return null;
    // Most jobs feed the freight train: haul something its contracts want to the station.
    const rail = this.world.railway;
    if (rail?.station && Math.random() < config.railway.jobShare) {
      const wanted = rail.contracts.filter((c) => c.delivered < c.qty && config.goods[c.good].weight <= 3);
      const c = wanted[Math.floor(Math.random() * wanted.length)];
      const sources = c ? markets.filter((m) => this.sells(m, c.good) && m.goods[c.good].stock >= config.jobs.minQty) : [];
      if (sources.length) {
        const from = sources[Math.floor(Math.random() * sources.length)];
        const to = rail.clerk;
        const { minQty, maxQty, valueShare, perDistance, offerLifeSec } = config.jobs;
        const qty = Math.min(c.qty - c.delivered, Math.round((minQty + Math.random() * (maxQty - minQty)) / 5) * 5) || minQty;
        const distance = Math.hypot(to.x - from.x, to.y - from.y);
        const reward = Math.round(config.goods[c.good].base * qty * valueShare * config.railway.premium + distance * perDistance);
        const job = { id: this.nextJobId++, good: c.good, qty, from: from.id, to: rail.station.id, train: true, reward, distance: Math.round(distance), taker: null, picked: false, offeredUntil: this.time + offerLifeSec, deadline: 0 };
        this.jobs.set(job.id, job);
        return job;
      }
    }
    for (let tries = 0; tries < 20; tries++) {
      const from = markets[Math.floor(Math.random() * markets.length)];
      const goods = Object.keys(from.goods).filter((g) => this.sells(from, g) && from.goods[g].stock >= config.jobs.minQty && config.goods[g].weight <= 3);
      if (!goods.length) continue;
      const good = goods[Math.floor(Math.random() * goods.length)];
      const targets = markets.filter((m) => m !== from && this.buys(m, good) && Math.hypot(m.x - from.x, m.y - from.y) > 800);
      if (!targets.length) continue;
      const to = targets[Math.floor(Math.random() * targets.length)];
      const { minQty, maxQty, valueShare, perDistance, offerLifeSec } = config.jobs;
      const qty = Math.round((minQty + Math.random() * (maxQty - minQty)) / 5) * 5;
      const distance = Math.hypot(to.x - from.x, to.y - from.y);
      const reward = Math.round(config.goods[good].base * qty * valueShare + distance * perDistance);
      const job = { id: this.nextJobId++, good, qty, from: from.id, to: to.id, reward, distance: Math.round(distance), taker: null, picked: false, offeredUntil: this.time + offerLifeSec, deadline: 0 };
      this.jobs.set(job.id, job);
      return job;
    }
    return null;
  }

  jobOf(p) {
    for (const job of this.jobs.values()) if (job.taker === p) return job;
    return null;
  }

  /** accept (anywhere) | pickup (at the start) | deliver (at the destination) | abandon. */
  jobAction(p, action, id) {
    if (action === 'accept') {
      if (this.jobOf(p)) return 'already_on_job';
      const job = this.jobs.get(id);
      if (!job || job.taker) return 'job_gone';
      job.taker = p;
      job.deadline = this.time + config.jobs.timeLimitSec;
      return null;
    }
    const job = this.jobOf(p);
    if (!job) return 'no_job';
    if (action === 'abandon') {
      this.jobs.delete(job.id);
      return null;
    }
    const holder = this.cargoOf(p);
    if (action === 'pickup') {
      if (job.picked) return 'already_picked';
      if (!this.#near(p, this.markets.get(job.from), config.markets.reach)) return 'too_far';
      if (holder.room(job.good) < job.qty) return 'no_room';
      holder.add(job.good, job.qty);
      job.picked = true;
      return null;
    }
    if (action === 'deliver') {
      if (!job.picked) return 'not_picked';
      const rail = job.train ? this.world.railway : null;
      if (!this.#near(p, rail ? rail.clerk : this.markets.get(job.to), rail ? config.railway.reach : config.markets.reach)) return 'too_far';
      if (holder.count(job.good) < job.qty) return 'missing_cargo';
      holder.add(job.good, -job.qty);
      if (rail) rail.receive(job.good, job.qty); // it goes on the train
      else this.markets.get(job.to).goods[job.good].stock += job.qty;
      p.account.bank += job.reward;
      this.world.onBankChange?.(p.account);
      this.jobs.delete(job.id);
      return null;
    }
    return 'unknown';
  }

  /** Open offers plus your own job, for the job board. */
  jobBoard(p) {
    const row = (job) => ({
      id: job.id,
      good: job.good,
      qty: job.qty,
      from: job.from,
      to: job.to,
      reward: job.reward,
      distance: job.distance,
      picked: job.picked,
      train: Boolean(job.train),
      secondsLeft: Math.max(0, Math.round((job.taker ? job.deadline : job.offeredUntil) - this.time)),
    });
    const mine = this.jobOf(p);
    return { mine: mine ? row(mine) : null, offers: [...this.jobs.values()].filter((j) => !j.taker).map(row) };
  }

  // ---- what clients see -------------------------------------------------------

  /** Everything the panel for market/factory `id` shows, including what `player` (if given) can do there. */
  describe(id, viewer, player = null) {
    const market = this.markets.get(id);
    if (market) {
      const cargo = player ? this.cargoOf(player) : null;
      return {
        kind: 'market',
        id,
        type: market.type,
        market: market.kind,
        // Work sites: the tool to borrow, what the foreman pays for your haul, and who owns it.
        work: market.work
          ? {
              tool: this.world.work.siteOf(id) ? config.work.tools[market.type] : null,
              holding: Boolean(player?.inventory.some((x) => x?.tool && x.site === id)),
              haul: this.world.work.takes(market.type).map((good) => ({ good, price: this.world.work.wage(good), have: player ? hotbarOf(player).count(good) : 0 })),
              owner: market.owner?.name ?? null,
              mine: Boolean(market.owner && market.owner === viewer),
              price: config.work.prices[market.type],
            }
          : null,
        closed: this.isClosed(market) ? Math.round(market.closedUntil - this.time) : 0,
        heat: Math.round(market.heat ?? 0),
        // What they'll quietly take off your hands (only offered for things you're carrying).
        contraband: this.underTableHere(market)
          ? Object.entries(config.goods).filter(([g, d]) => d.illegal && cargo?.count(g)).map(([good, d]) => ({ good, price: d.base, have: cargo.count(good) }))
          : null,
        catalog:
          market.kind === 'gunstore'
            ? Object.entries(config.gunstore.guns).map(([type, g]) => ({ type, price: this.gunPrice(market, type), uses: g.uses }))
            : market.kind === 'dealership'
              ? Object.keys(config.dealership.vehicles).map((type) => ({ type, price: this.vehiclePrice(market, type) }))
              : market.goods.bread && (market.kind === 'shop' || market.kind === 'gas')
                ? Object.keys(config.economy.menu).map((item) => ({ item, price: this.foodPrice(market, item) }))
                : null,
        goods: Object.entries(market.goods).map(([g, e]) => ({
          good: g,
          stock: Math.floor(e.stock),
          buy: this.sells(market, g) ? this.buyPrice(market, g) : null,
          sell: this.buys(market, g) ? this.sellPrice(market, g) : null,
          trend: (() => {
            const before = market.lastPrices?.[g];
            if (!before) return 0;
            const change = this.price(market, g) / before - 1;
            return Math.abs(change) < 0.02 ? 0 : Math.sign(change);
          })(),
          room: player ? this.cargoOf(player).room(g) : 0,
          have: player ? this.cargoOf(player).count(g) : 0,
        })),
      };
    }
    const f = this.factories.get(id);
    if (!f) return null;
    const def = config.factories[f.type];
    return {
      kind: 'factory',
      id,
      type: f.type,
      name: def.name,
      sec: def.sec,
      recipes: def.recipes,
      tolls: def.recipes.map((r) => this.tollFee(r)),
      plan: player ? (({ batches = 0, wanted = 0, fee = 0, error = null }) => ({ batches, wanted, fee, error }))(this.#processPlan(player, f)) : null,
    };
  }
}
