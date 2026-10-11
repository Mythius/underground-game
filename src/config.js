import { fileURLToPath } from 'node:url';

// Load .env from the project root. Missing file is fine; existing env vars win.
try {
  process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)));
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}

const env = process.env;

function int(name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) throw new Error(`Invalid integer for ${name}: ${raw}`);
  return value;
}

function list(name) {
  const raw = env[name];
  if (!raw) return null;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

export const config = Object.freeze({
  port: int('PORT', 3000),
  host: env.HOST || '0.0.0.0',
  logLevel: env.LOG_LEVEL || 'info',
  allowedOrigins: list('ALLOWED_ORIGINS'),
  // Needed to save maps from the editor. Unset = saving is disabled.
  adminPassword: env.ADMIN_PASSWORD || null,
  // Google sign-in goes through our CAS server (msouthwick-cas): it sends the browser back to
  // <this site>/auth/callback/cas with a signed token, which we check with the CAS server's /auth/verify.
  // The game must be listed as `clientId` in the CAS server's clients.json, with that callback address.
  cas: {
    url: env.CAS_URL || 'https://cas.msouthwick.com',
    clientId: env.CAS_CLIENT_ID || 'underground',
  },

  // Simulation runs at tickRate; state is sent to clients at snapshotRate.
  tickRate: int('TICK_RATE', 30),
  snapshotRate: int('SNAPSHOT_RATE', 30),
  leaderboardIntervalMs: 1000,
  maxPlayersPerRoom: int('MAX_PLAYERS_PER_ROOM', 50),

  net: {
    maxPayloadBytes: 1024,
    maxMessagesPerSecond: 60,
    messageBurst: 120,
    heartbeatIntervalMs: 10_000,
    chatMaxLength: 120,
    chatPerSecond: 1, // sustained rate; chatBurst allows short flurries
    chatBurst: 4,
    // Snapshots are skipped for a client whose socket buffer is above this.
    maxBufferedBytes: 256 * 1024,
  },

  world: {
    width: 27000, // a big country: the town in the middle, kolkhozes, forests, the mine, a railway across
    height: 27000,
    gridCellSize: 250,
    foodCount: 0, // no free food on the ground; buy it from shopkeepers
    foodMass: 1,
    foodHeal: 4, // health restored per food dot
    viewDistance: 1400,
    buildingCount: 320, // cycles through every building type (work sites are placed separately)
    parkingLots: 30, // extra lots along the country roads (businesses get their own parking too)
    citySize: 8000, // the town in the middle: asphalt streets and sidewalks; gravel roads outside
    terrain: true, // roads, dirt paths, trees and water
    forests: 260,
    scatteredTrees: 1400,
    rivers: 4,
    lakes: 18,
    // Guns no longer appear on the ground (buy them at gun stores); these stay for testing/old maps.
    pickupStart: 0,
    pickupIntervalSec: 1.5,
    pickupMax: 0,
    pickupRadius: 22,
    doorReach: 45, // how far past your edge you can reach a door with E
  },

  player: {
    nameMaxLength: 16,
    startMass: 25,
    baseSpeed: 220, // units/sec at start mass
    swimSpeed: 0.5, // multiplier in water (and no sprinting)
    iceGrip: 1.2, // on a frozen lake you only slowly speed up, turn or stop (higher = less slippery)
    // Size trade-off: speed × (startMass / mass)^speedExponent, max health × (mass / startMass)^healthExponent.
    // e.g. at 4× start mass: 0.57× speed and 2× health.
    speedExponent: 0.4,
    healthExponent: 0.5,
    // Sprinting (the `boost` input) spends stamina.
    sprintMultiplier: 1.6,
    staminaMax: 100,
    staminaDrainPerSec: 35,
    staminaRegenPerSec: 22,
    healthRegenPerSec: 1, // everyone slowly heals on their own (food heals faster)
    staminaRegenDelaySec: 0.8, // pause after sprinting before stamina refills
    staminaMinToSprint: 25, // after running dry, wait until this much is back
    massShrinkPerSec: 0.01, // extra size from overeating fades by this fraction per second
    spawnSafeDistance: 400,
    maxHealth: 100, // at start mass; grows with size
    inventorySize: 5,
  },

  bulletRadius: 4,

  // Every player starts with a knife (melee: a stab takes `share` of the target's max health); guns are bought or found.
  // barrel: where bullets leave the gun, in player radii from the centre (matches the drawing).
  weapons: {
    knife: { name: 'Knife', melee: true, share: 1 / 3, reach: 38, cooldownSec: 0.55, magazineSize: 0, reloadSec: 0, barrel: 1.1, spawnWeight: 0 },
    // A baseball bat: hits harder the bigger you are (share × your size against a starting player's,
    // within sizeRange), reaches further than the knife, and smashes ATMs open (robbery.atmSmash).
    bat: { name: 'Baseball bat', melee: true, share: 0.2, sizeScale: true, sizeRange: [0.8, 3], reach: 52, cooldownSec: 0.7, magazineSize: 0, reloadSec: 0, barrel: 1.7, spawnWeight: 0 },
    pistol: { name: 'Pistol', damage: 20, cooldownSec: 0.2, magazineSize: 5, reloadSec: 1.5, bulletSpeed: 900, bulletLifetimeSec: 1.2, pellets: 1, spread: 0, barrel: 1.6, spawnWeight: 0 },
    smg: { name: 'SMG', damage: 9, cooldownSec: 0.08, magazineSize: 25, reloadSec: 2, bulletSpeed: 950, bulletLifetimeSec: 0.9, pellets: 1, spread: 0.09, barrel: 1.8, spawnWeight: 30 },
    shotgun: { name: 'Shotgun', damage: 12, cooldownSec: 0.18, magazineSize: 5, reloadSec: 1.8, bulletSpeed: 800, bulletLifetimeSec: 0.45, pellets: 6, spread: 0.35, barrel: 2.0, spawnWeight: 25 },
    rifle: { name: 'Rifle', damage: 16, cooldownSec: 0.14, magazineSize: 15, reloadSec: 2, bulletSpeed: 1150, bulletLifetimeSec: 1.2, pellets: 1, spread: 0.03, barrel: 2.2, spawnWeight: 30 },
    sniper: { name: 'Sniper', damage: 75, cooldownSec: 1.1, magazineSize: 3, reloadSec: 2.5, bulletSpeed: 1900, bulletLifetimeSec: 1.3, pellets: 1, spread: 0, barrel: 2.6, spawnWeight: 15 },
  },

  // Drivable cars and trucks, parked on the roads. E to get in/out, W/S gas/brake, A/D steer, Shift to drift, Space to boost (vodka).
  vehicles: {
    fuelCanShare: 20, // one fuel poured in by hand fills this % of a tank
    // Vodka poured into a car fills its boost tank (a second gauge); Space burns it while you drive for
    // harder acceleration and a higher top speed.
    boost: { perVodka: 25, burnPerSec: 6, accel: 1.9, topSpeed: 1.35 }, // (a full tank: ~17 s of boost)
    count: 260,
    gravelGrip: 0.8, // grip outside the city (gravel roads, grass, snow) compared with city asphalt
    respawnSec: 20, // after one is destroyed
    reach: 40, // how far past your edge you can get in
    crushMinSpeed: 120, // slower than this, cars just push people
    knockMax: 700, // a car hitting someone throws them off at up to this speed…
    knockDecay: 6, // …slowing like this (so ~40–120 px: sent flying, not far)
    exitDamage: 35, // to the driver when their vehicle is destroyed
    lockpickSec: 5, // holding F at someone else's car to pick its lock (it stays open until they're back in it)
    types: { // (top speeds ~15% lower than at first: cars felt a little fast)
      // grip: how fast sideways sliding dies away (higher = stickier). driftGrip applies while holding Space.
      sedan: { name: 'Lada 2107', length: 90, width: 46, maxSpeed: 360, accel: 325, brake: 800, turnRate: 2.6, grip: 7, driftGrip: 0.9, health: 180, crush: 60, spawnWeight: 40 },
      sports: { name: 'Mercedes 600', length: 88, width: 42, maxSpeed: 460, accel: 415, brake: 900, turnRate: 3.0, grip: 8, driftGrip: 0.8, health: 140, crush: 55, spawnWeight: 15 },
      pickup: { name: 'UAZ-469', length: 106, width: 50, maxSpeed: 305, accel: 260, brake: 700, turnRate: 2.2, grip: 6, driftGrip: 1.0, health: 260, crush: 75, spawnWeight: 25 },
      // Militsiya cars: driven by police AI only (never parked at random or sold).
      police: { name: 'Militsiya Lada', length: 92, width: 46, maxSpeed: 400, accel: 380, brake: 900, turnRate: 2.8, grip: 8, driftGrip: 1, health: 320, crush: 50, spawnWeight: 0 },
      truck: { name: 'KAMAZ', length: 150, width: 58, maxSpeed: 245, accel: 170, brake: 550, turnRate: 1.6, grip: 5, driftGrip: 1.2, health: 400, crush: 100, spawnWeight: 20 },
    },
  },

  // Each browser gets an account automatically; it keeps only a bank balance.
  // Carried cash is dropped when you die or leave.
  accounts: {
    startingBank: 500, // what a new account (or a guest) starts with in the bank
    topUpTo: 20000, // a one-time top-up that already ran (keyed by this amount: changing it would run it again)
    sessionDays: 365, // Google sign-ins (through CAS) stay signed in this long
    deviceDays: 3650, // a browser keeps its account this long
  },

  // Dollars: carried cash buys food; deposit at banks and ATMs to keep it.
  economy: {
    shopReach: 120, // from the shopkeeper's centre to your edge
    bankReach: 120, // from a bank teller's centre to your edge
    atmReach: 60, // from an ATM's centre to your edge
    // Meals use `bread` from the shop's stock (supplied by bakeries); prices rise as the stock runs low.
    // Food goes into your hotbar (up to foodStack of a kind per slot); select it and press E to eat.
    // It heals `heal` over `healSec` seconds, not all at once. (An energy drink's stamina is instant.)
    menu: {
      bread: { name: 'Bread', icon: '🍞', price: 10, heal: 15, healSec: 6, mass: 2, bread: 1 },
      burger: { name: 'Burger', icon: '🍔', price: 25, heal: 40, healSec: 10, mass: 6, bread: 2 },
      drink: { name: 'Energy drink', icon: '🥤', price: 15, heal: 10, healSec: 4, mass: 0, stamina: true, bread: 0 },
      feast: { name: 'Feast', icon: '🍗', price: 60, heal: 1000, healSec: 20, mass: 15, bread: 4 },
    },
    foodStack: 5,
    // What drinking vodka (or a mix of it, from a mixing station) does to how you see the world, for
    // `visionSec`: plain vodka turns the colours inside out; the mixes each light the world their own way.
    // They drink like vodka otherwise (its healing and buzz).
    visions: { vodka: 'invert', jetvodka: 'jet', firewater: 'fire', blackvodka: 'crude' },
    visionSec: 180, // (3 minutes)
    // A fish (the good) eats like food too.
    fish: { name: 'Fish', icon: '🐟', heal: 20, healSec: 6, mass: 2 },
    // Vodka (the illegal good) drinks like food: middling healing, and while the buzz lasts you take
    // only `damageTaken` of any damage.
    vodka: { name: 'Vodka', icon: '🍾', heal: 25, healSec: 8, mass: 0, buzzSec: 60, damageTaken: 0.7 },
  },

  // Day/night and weather. A week is 7 day/night cycles (~2.9 hours).
  environment: {
    daySec: 20 * 60,
    nightSec: 5 * 60,
    startSec: 90, // rooms open in the early morning, just after dawn
    maxPerWeek: 2, // rain and fog each happen 0..maxPerWeek times a week
    weatherFadeSec: 60,
    weather: {
      rain: { minSec: 6 * 60, maxSec: 15 * 60 },
      fog: { minSec: 5 * 60, maxSec: 12 * 60 },
    },
    // Seasons follow each other every 40 minutes, blending over the last few minutes of each.
    // Rain falls as snow in winter.
    seasons: ['winter', 'spring', 'summer', 'autumn'],
    seasonSec: 40 * 60,
    seasonBlendSec: 3 * 60,
    rainGrip: 0.6, // car grip multiplier at full rain (or snow)
    broadcastEverySec: 2,
  },

  // Character customisation offered on the start menu. Players send an index into each list.
  looks: {
    skins: ['#ffdbac', '#f1c27d', '#e0ac69', '#c68642', '#8d5524', '#5c3a1e'],
    shirts: ['#e6194b', '#3cb44b', '#ffe119', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6', '#bfef45', '#fabed4', '#ffffff', '#222222'],
    pants: ['#34495e', '#2c3e50', '#5d4037', '#1b5e20', '#6d6d6d', '#111111', '#1e88e5', '#b0855b'],
    hats: ['none', 'miner', 'cowboy', 'tophat', 'cap', 'beanie', 'crown', 'helmet', 'party', 'ushanka', 'furazhka'],
  },

  // ---- goods, factories and markets (stage 2) ---------------------------------
  // Prices are "fair" base prices; markets move them with their stock. weight = cargo space per unit.
  goods: {
    logs: { name: 'Logs', icon: '🪵', base: 8, weight: 1, tier: 'raw' },
    wheat: { name: 'Wheat', icon: '🌾', base: 6, weight: 1, tier: 'raw' },
    ore: { name: 'Iron ore', icon: '⛏️', base: 12, weight: 1, tier: 'raw' },
    crude: { name: 'Crude oil', icon: '🛢️', base: 10, weight: 1, tier: 'raw' },
    scrap: { name: 'Scrap metal', icon: '🔩', base: 7, weight: 1, tier: 'raw' },
    sand: { name: 'Sand', icon: '🏖️', base: 4, weight: 1, tier: 'raw' },
    fish: { name: 'Fish', icon: '🐟', base: 18, weight: 1, tier: 'raw' }, // caught with a rod (see config.fishing); it eats too
    planks: { name: 'Planks', icon: '🪚', base: 20, weight: 1, tier: 'processed' },
    flour: { name: 'Flour', icon: '🥡', base: 15, weight: 1, tier: 'processed' },
    steel: { name: 'Steel', icon: '🔗', base: 40, weight: 1, tier: 'processed' },
    fuel: { name: 'Fuel', icon: '⛽', base: 25, weight: 1, tier: 'processed' },
    plastic: { name: 'Plastic', icon: '🧴', base: 22, weight: 1, tier: 'processed' },
    glass: { name: 'Glass', icon: '🪟', base: 18, weight: 1, tier: 'processed' },
    parts: { name: 'Parts', icon: '⚙️', base: 130, weight: 1, tier: 'processed' },
    furniture: { name: 'Furniture', icon: '🛋️', base: 140, weight: 3, tier: 'finished' }, // a sofa: place it in your home or warehouse
    cabinet: { name: 'Cabinet', icon: '🗄️', base: 200, weight: 3, tier: 'finished' }, // storage: place it, then keep 10 slots of anything in it
    bed: { name: 'Bed', icon: '🛏️', base: 180, weight: 3, tier: 'finished' },
    bread: { name: 'Bread', icon: '🍞', base: 30, weight: 1, tier: 'finished' },
    bat: { name: 'Baseball bat', icon: '🏏', base: 60, weight: 1, tier: 'finished' }, // made from planks; E with it in hand to take it up as a weapon
    energy: { name: 'Energy drinks', icon: '🥤', base: 14, weight: 1, tier: 'finished' }, // by the crate, from markets (a mixing station mixes them into vodka)
    car: { name: 'New car', icon: '🚗', base: 2500, weight: 10, tier: 'finished', vehicles: ['pickup', 'truck'] }, // only fits a pickup or truck
    guns: { name: 'Licensed guns', icon: '🔫', base: 600, weight: 2, tier: 'finished' },
    // Contraband: seized if the Militsiya search you, sold under the table (shops, kiosks) or to the
    // black-market buyer behind the freight station. Never bought or sold by markets.
    vodka: { name: 'Vodka', icon: '🍾', base: 60, weight: 1, tier: 'illegal', illegal: true },
    // Vodka mixed on a mixing station (see economy.mixes for what they do when you drink them).
    jetvodka: { name: 'Jet vodka', icon: '⚡', base: 120, weight: 1, tier: 'illegal', illegal: true }, // vodka + energy drink
    firewater: { name: 'Firewater', icon: '🔥', base: 130, weight: 1, tier: 'illegal', illegal: true }, // vodka + petrol
    blackvodka: { name: 'Black crude vodka', icon: '🛢️', base: 110, weight: 1, tier: 'illegal', illegal: true }, // vodka + crude oil
    counterfeit: { name: 'Counterfeit rubles', icon: '💸', base: 280, weight: 1, tier: 'illegal', illegal: true },
    hotparts: { name: 'Stolen car parts', icon: '🧰', base: 220, weight: 2, tier: 'illegal', illegal: true },
    blackguns: { name: 'Unregistered pistol', icon: '🔫', base: 900, weight: 1, tier: 'illegal', illegal: true }, // boxed, from a gunsmith bench: E with one in hand takes it up as a (still illegal) pistol
  },
  // Recipes only illegal machines run (keys 'illegal:<name>').
  illegalRecipes: {
    vodka: { in: { wheat: 2 }, out: { vodka: 1 }, sec: 10 },
    counterfeit: { in: { plastic: 2 }, out: { counterfeit: 1 }, sec: 20 },
    blackguns: { in: { steel: 3, parts: 1 }, out: { blackguns: 1 }, sec: 30 },
    jetvodka: { in: { vodka: 1, energy: 1 }, out: { jetvodka: 1 }, sec: 8 },
    firewater: { in: { vodka: 1, fuel: 1 }, out: { firewater: 1 }, sec: 8 },
    blackvodka: { in: { vodka: 1, crude: 1 }, out: { blackvodka: 1 }, sec: 8 },
  },

  // A factory turns inputs into outputs every `sec` seconds while it has the inputs and room for the outputs.
  // `recipes` are tried in order (the foundry takes ore or scrap). Warehouse machines run these recipes too.
  factories: {
    sawmill: { name: 'Sawmill', recipes: [{ in: { logs: 1 }, out: { planks: 1 } }], sec: 8 },
    furniture: { name: 'Furniture factory', recipes: [{ in: { planks: 4 }, out: { furniture: 1 } }, { in: { planks: 3, steel: 1 }, out: { cabinet: 1 } }, { in: { planks: 3, plastic: 2 }, out: { bed: 1 } }, { in: { planks: 2 }, out: { bat: 1 } }], sec: 20 },
    flourmill: { name: 'Flour mill', recipes: [{ in: { wheat: 2 }, out: { flour: 1 } }], sec: 8 },
    bakery: { name: 'Bakery', recipes: [{ in: { flour: 1 }, out: { bread: 1 } }], sec: 6 },
    foundry: { name: 'Foundry', recipes: [{ in: { ore: 1 }, out: { steel: 1 } }, { in: { scrap: 2 }, out: { steel: 1 } }], sec: 12 },
    machineshop: { name: 'Machine shop', recipes: [{ in: { steel: 2 }, out: { parts: 1 } }], sec: 15 },
    refinery: { name: 'Refinery', recipes: [{ in: { crude: 2 }, out: { fuel: 1, plastic: 1 } }], sec: 12 },
    glassworks: { name: 'Glassworks', recipes: [{ in: { sand: 3 }, out: { glass: 1 } }], sec: 10 },
    carfactory: { name: 'Car factory', recipes: [{ in: { parts: 6, glass: 4, plastic: 6 }, out: { car: 1 } }], sec: 90 },
    // Licensed guns are made for the gun stores only: nobody can have them made here or in a warehouse
    // (players make unregistered ones, on a gunsmith bench).
    gunfactory: { name: 'Gun factory', recipes: [{ in: { steel: 3, parts: 2 }, out: { guns: 1 } }], sec: 40, noToll: true },
  },
  factory: {
    reach: 130, // from the office clerk to your edge
    // City factories (one of each) process anyone's inputs on the spot for a fee per batch:
    // this share of the value the recipe adds (outputs − inputs, at base prices).
    tollShare: 0.5,
  },

  // Player factories: buy an empty warehouse, then place machines and belts on its floor grid.
  // Goods come in at the IN dock (unload your cargo there) and finished goods collect at the OUT dock.
  warehouses: {
    // Floor grids (tiles of 40 units) are in buildings.js: small 6×6, medium 10×8, large 14×10.
    sizes: {
      small: { name: 'Small warehouse', price: 3000, taxPerHour: 60, count: 8 },
      medium: { name: 'Warehouse', price: 8000, taxPerHour: 150, count: 8 },
      large: { name: 'Large warehouse', price: 20000, taxPerHour: 360, count: 4 },
      // Shacks in the woods: cheap, small, illegal machines only, and far less likely to be raided.
      shack: { name: 'Shack', price: 2000, taxPerHour: 20, count: 10, illegalOnly: true },
    },
    dockCapacity: 200, // units each dock pallet holds (all goods together)
    containerCapacity: 100, // units a container holds
    dockReach: 150, // from a dock's edge
    beltSpeed: 2, // tiles per second
    machineBuffer: 3, // belts fill a machine's input slot up to this many batches
    machineSlot: 20, // its input slot holds this many of each input by hand, and its output slot this many in all
    emitEverySec: 0.5, // docks and machines put an item out this often
    sellBack: 0.5, // selling returns this share of what you paid (warehouse + everything placed)
    lockpickSec: 6, // holding F at a locked warehouse door
    // Chop shop: drive a car that isn't yours into your warehouse or shack and strip it for parts.
    chopParts: { sedan: 6, sports: 10, pickup: 8, truck: 12, police: 8 },
    // Heat from illegal production: each batch adds its value / heatPerValue (shacks: × shackHeat).
    // Heat fades by heatDecayPerMin; at 100 the Militsiya raid it and seize all contraband inside.
    heatPerValue: 300,
    shackHeat: 0.25,
    heatDecayPerMin: 4,
    unlockedSec: 90, // a picked lock stays open this long
    saveEverySec: 20,
  },
  // Configurable machines (2×2 tiles). Each runs one recipe at a time, taken from the city factories.
  machines: {
    saw: { name: 'Saw', icon: '🪚', price: 800, recipes: ['sawmill:0'] },
    mill: { name: 'Mill', icon: '🌾', price: 700, recipes: ['flourmill:0'] },
    furnace: { name: 'Furnace', icon: '🔥', price: 3000, recipes: ['foundry:0', 'foundry:1', 'glassworks:0', 'bakery:0'] },
    press: { name: 'Press', icon: '🛢️', price: 4000, recipes: ['refinery:0', 'machineshop:0'] },
    assembler: { name: 'Assembler', icon: '🏭', price: 7000, recipes: ['furniture:0', 'furniture:1', 'furniture:2', 'furniture:3', 'carfactory:0'] },
    // Illegal: their output is contraband, and running them draws the Militsiya (see `heat`).
    still: { name: 'Still', icon: '🍾', price: 1500, recipes: ['illegal:vodka'], illegal: true },
    mixer: { name: 'Mixing station', icon: '🍸', price: 2500, recipes: ['illegal:jetvodka', 'illegal:firewater', 'illegal:blackvodka'], illegal: true }, // vodka + energy drink / petrol / crude
    printer: { name: 'Printing press', icon: '💸', price: 5000, recipes: ['illegal:counterfeit'], illegal: true },
    gunsmith: { name: 'Gunsmith bench', icon: '🔫', price: 6000, recipes: ['illegal:blackguns'], illegal: true },
  },
  // Belt pieces (1 tile). Belts only take items from behind; turns from one side; mergers from behind and both sides.
  belts: {
    belt: { name: 'Belt', price: 20 },
    turnL: { name: 'Turn left', price: 20 },
    turnR: { name: 'Turn right', price: 20 },
    merger: { name: 'Merger', price: 60 },
    splitter: { name: 'Splitter', price: 80 },
    filter: { name: 'Filter', price: 120 },
    invfilter: { name: 'Inverse filter', price: 120 }, // the opposite of a filter: its good goes straight on, everything else to the sides
    container: { name: 'Container', price: 300 }, // stores goods: belts feed it from any side, belts leading away pull them out
  },

  // Raw sites sell one raw good and slowly produce more; trade depots buy and sell everything.
  markets: {
    rawProducePerSec: 0.5, // units of its raw good a raw site makes per second (until full)
    rawTarget: 150, // a raw site's "normal" stock
    depotTarget: 40, // a depot's normal stock of each good
    driftPerSec: 1 / 1200, // background NPC trade nudges stock back toward 60% of normal (townsfolk do the rest)
    trendEverySec: 60, // markets compare today's prices with this long ago to show ↑ / ↓
    spread: 0.08, // buy at price × (1 + spread), sell at price × (1 − spread)
    reach: 130,
  },

  // Goods sit in slots, one kind per slot: your hotbar's free slots on foot, and each vehicle's trunk.
  cargo: {
    slotWeight: 5, // a hotbar slot holds this much (by weight) of one good: 5 logs, or 1 furniture
    vehicleSlotWeight: 10, // a trunk slot holds twice that
    vehicles: { sedan: 2, sports: 1, pickup: 4, truck: 12 }, // trunk slots per vehicle
    nearbyVehicle: 300, // the vehicle you last drove (or opened) counts as your cargo within this range
    bayReach: 150, // …or anywhere in (or this close to) a building whose delivery bay it's parked in
    trunkReach: 70, // how close to a vehicle's back you need to be to open its trunk
    dropPickupDelaySec: 2, // you can't instantly pick up what you just dropped
    cashDrop: 500, // X drops this much cash (or all you have, if less)
  },

  // Teams: invite a player, they accept; teammates show on each other's maps.
  teams: {
    maxSize: 4,
    inviteSec: 60, // an invite lasts this long
  },

  fuel: {
    perUnit: 100 / 120000, // a full tank lasts about 120,000 units of driving
    pumpReach: 220, // a car this close to a gas station's clerk can be refilled
  },

  // Gun stores sell (licensed) guns for cash; each sale uses `uses` of their 'guns' stock (restocked by
  // gun factories). On top of the price you pay the gun licence tax, a share of it.
  gunstore: {
    taxRate: 0.3,
    guns: {
      smg: { price: 550, uses: 1 },
      shotgun: { price: 450, uses: 1 },
      rifle: { price: 350, uses: 1 },
      sniper: { price: 900, uses: 2 },
      bat: { price: 150, uses: 0 }, // (not a gun: no licensed stock needed)
    },
  },

  // Car dealerships sell new vehicles (paid from the bank); each uses one 'car' from their stock.
  dealership: {
    vehicles: { sedan: 1800, sports: 4500, pickup: 2800, truck: 6500 },
  },

  // Delivery jobs: haul goods (provided free) from one market to another for pay into your bank.
  jobs: {
    max: 14, // open offers at once
    everySec: 15, // a new offer appears this often (while below max)
    timeLimitSec: 600, // to finish once accepted
    offerLifeSec: 300, // an offer nobody takes disappears after this
    minQty: 10,
    maxQty: 40,
    valueShare: 0.12, // pay = goods value × this…
    perDistance: 0.07, // …plus this per unit of distance
  },

  // NPC townsfolk walking between buildings and spending money: the town's demand.
  townsfolk: {
    perBuilding: 1.1, // how many live in town, per building…
    maxPopulation: 300, // …but never more than this on a map (anyone killed is replaced, see replaceSec)
    walkSpeed: 80,
    minStaySec: 8, // time spent inside each place they visit
    maxStaySec: 45,
    wagePerVisit: 20, // $ they earn per stop (it's what they spend)
    marketBasket: ['bread', 'furniture', 'fuel', 'glass', 'plastic', 'planks', 'parts'], // what they buy at markets
    health: 40, // they can be shot (a crime); cars just shove them aside
    bodyRadius: 16, // for being pushed out of the way of cars
    replaceSec: 60, // someone new moves into one of the houses this long after a townsperson dies
    // Stab, shoot or pickpocket one and (if they're still standing) they come at you swinging a purse,
    // land a couple of hits, then run off and call the Militsiya once they're clear.
    fightSec: 20, // they give up after this long…
    fightGiveUpRange: 700, // …or once you're this far away
    fightSpeed: 230, // running at you (players walk at about 250)
    fightCooldownSec: 1.1, // between their swings
    purseReach: 34, // how far a purse swing lands
    purseShare: 0.15, // of your max health per hit
    purseHits: 2, // hits before they run for it
    fleeSec: 5, // running away this long, then (if still alive) they call the cops
  },

  // Every account gets a small starter house: you (re)spawn there, and E on the car pad outside opens
  // your garage of bought cars. Homes (houses, cabins, mansions, apartment blocks) are locked to everyone but their
  // owner; hold F at a door to pick it (a break-in).
  homes: {
    starterTypes: ['house', 'cabin'], // what can be handed out as a starter house
    lockedTypes: ['house', 'cabin', 'mansion', 'panelka'], // whose outside doors are locked
    lockpickSec: 5,
    unlockedSec: 90, // a picked lock stays open this long
    garageReach: 140, // from the middle of the car pad outside
    saveCarsEverySec: 20, // fuel and trunk of saved cars out on the road
  },

  // ---- crime and police (stage 4) -------------------------------------------------
  // Each crime sets your wanted level to at least its stars — if the police see it, or a townsperson
  // nearby calls it in. Alarms (robberies) always report.
  crime: {
    stars: { fire: 1, steal_car: 1, pickpocket: 1, assault: 2, rob_atm: 2, rob_shop: 2, steal_police_car: 2, rob_bank: 3, mugging: 2, illegal_gun: 1, break_in: 1, carry_body: 2, near_body: 1, sell_contraband: 2, smuggling: 2, run_roadblock: 3, murder: 3, attack_police: 4 },
    policeSees: 750, // police notice crimes this close
    witnessSees: 320, // townsfolk out walking notice (and phone it in) this close
    // Everyone sees a half circle in front of them (walls block). After a crime the Militsiya search
    // from where you were last seen; they give up this long (by stars) after last seeing you.
    searchSec: [0, 30, 50, 75, 110, 150],
  },
  robbery: {
    atm: { sec: 5, min: 150, max: 400, cooldownSec: 300, needsGun: false, noDepositSec: 300 }, // noDepositSec: you can't pay the cash straight back in at the ATM you robbed
    shop: { sec: 4, min: 200, max: 600, cooldownSec: 300, needsGun: true },
    bank: { sec: 10, min: 1500, max: 4000, cooldownSec: 600, needsGun: true },
    // A baseball bat on an ATM: `hits` swings and it spills its cash — and it's broken (no banking,
    // nothing to rob) for brokenSec.
    atmSmash: { hits: 3, min: 200, max: 500, brokenSec: 300 },
  },
  // Selling contraband over the counter at shops and kiosks: they pay the base price, but every sale
  // adds heat (value / heatPerValue); at 100 the place is raided and shut for raidClosedSec.
  underTable: { heatPerValue: 250, heatDecayPerMin: 6, raidClosedSec: 300 },
  // The black-market buyer behind the freight station: always buys contraband, for this share of base.
  blackMarket: { share: 0.7 },
  // Militsiya checkpoints on the roads. Stop in one and they search you; a bribe (cash) waves you through.
  roadblocks: { count: 10, searchSec: 1.5, slowSpeed: 90, range: 500, checkWithinSec: 10, bribe: 500, bribeSec: 120, againSec: 45 },
  // Placing furniture (cabinets, beds, sofas) in your home or warehouse; see src/game/furnishing.js.
  furnishing: {
    cabinetSlots: 10,
    reach: 50, // from the thing's edge to yours
  },
  // Fishing: buy a rod at a shop, stand by a river or lake, click to cast. After a while a fish bites and
  // fights the line; every `cycleSec` (± a little) it tires for `tiredShare` of the cycle, and that's when
  // you pull (click). Pull while it's fighting and it breaks free. `pulls` good pulls land it.
  fishing: {
    rodPrice: 150,
    cast: [70, 240], // how far out the float lands (from you, toward the mouse), if there's water there
    biteSec: [4, 12], // waiting for a bite
    cycleSec: 1.8,
    tiredShare: 0.28,
    pulls: 3,
    giveUpSec: 9, // no pull for this long and it swims off
    slackSec: 0.35, // allowance for lag when judging a pull (what the player saw vs. the server's clock)
    lineReach: 40, // walk further than this from where you cast and the line comes in
    hookBreak: 160, // a hooked player who walks this far from where they were hooked snaps the line
    fishChance: 0.8, // otherwise something else is on the hook:
    junk: { food: 0.65, gun: 0.35 },
    junkGuns: { pistol: 5, smg: 2, shotgun: 2, rifle: 1, sniper: 0.5 }, // relative odds; it has a few rounds in it
    junkAmmo: [1, 4],
  },
  // The freight train: every `everySec` it stops at the station for `dockSec` with export contracts.
  railway: {
    everySec: 8 * 60,
    dockSec: 3 * 60,
    speed: 650, // cruising (units/s)
    wagons: 8,
    contracts: [3, 5], // how many per train
    premium: 1.5, // contract price = base × premium
    freightShare: 0.8, // the clerk also buys any legal good, any time, at base × this
    contractValue: [2000, 9000], // each contract is worth about this much in total (at most ~a truckload)
    jobShare: 0.7, // share of new delivery jobs that haul contract goods to the station
    reach: 160,
  },
  // Working the land (the early-game living): borrow the site's tool from the foreman, hit the
  // rocks / trees / wheat, sell the haul back to the foreman. Work sites fill whole country blocks.
  work: {
    sites: { mine: 1, logging: 3, farm: 4, oilwell: 3 }, // the oil fields pump on their own
    tools: { mine: 'pickaxe', logging: 'axe', farm: 'scythe' },
    takes: { mine: ['ore', 'sand', 'scrap'], logging: ['logs'], farm: ['wheat'] }, // what each foreman buys
    prices: { mine: 40000, logging: 15000, farm: 12000 }, // to buy the whole site (bank)
    sellBack: 0.5,
    wageShare: 0.6, // the foreman pays this share of the base price per unit
    npcProducePerSec: 0.1, // a work site's own output without players (raw sites otherwise make rawProducePerSec)
    reach: 55, // from your edge to a rock / tree / wheat patch
    swingSec: 0.5,
    leaveRange: 400, // walk this far off the site and the tool goes back to the foreman
    veinChance: 0.22, // share of the mine's rocks that are rich ore veins
    extraSand: 0.25, extraScrap: 0.12, // a worked-out rock sometimes gives sand or scrap too
    hp: { rock: 3, vein: 4, tree: 4, wheat: 1 }, // hits to work one out
    yield: { vein: { ore: 2 }, tree: { logs: 3 }, wheat: { wheat: 2 } }, // (a rock: 1 ore)
    regrowSec: { rock: 150, vein: 200, tree: 180, wheat: 90 },
    nodes: {
      mine: { gap: 100, density: 0.85, r: 26, kind: 'rock' },
      logging: { gap: 120, density: 0.9, r: 30, kind: 'tree' },
      farm: { gapX: 70, gapY: 54, density: 1, r: 26, kind: 'wheat', rows: true }, // straight rows, end to end, close together
    },
  },
  // Bodies: loot them (E), carry them (slowly, no shooting), and hide them before someone finds them.
  bodies: { reach: 55, waterReach: 40, lifeSec: 600, max: 60, carrySpeed: 0.65, nearRange: 120 }, // nearRange: seen this close to a body (in the open) and you're wanted
  pickpocket: { reach: 45, npcMin: 10, npcMax: 60, playerShare: 0.15, cooldownSec: 3 },
  police: {
    carsPerBuildings: 1 / 12, // patrol cars on duty, per building…
    maxUnits: 20, // …but never more than this on a map (anyone killed is replaced, see respawnSec)
    footSpeed: 230,
    responseSec: 8, // a reported crime takes this long before cars are sent
    chaseThrottle: 0.85, // how hard they drive after you
    searchRadius: 550, // hiding spots (trees, dumpsters, cars, buildings) they check round your last known spot
    illegalGunEverySec: 15, // an unregistered gun seen in your hand is reported at most this often
    guardRange: 700, // a bank guard deals with trouble this close to his post (and no further)
    postRange: 1800, // a checkpoint's own car answers calls this close to its checkpoint (and always chases whoever runs it)
    cruiseRadius: 1800, // lost in a car chase: they cruise the roads this far round where you were last seen
    inspectSec: 1.5, // looking into each one
    hideSeenRange: 140, // under a tree or in a parked car you're only noticed this close
    exitRange: 260, // officers get out of the car this close to a suspect on foot…
    stuckExitRange: 700, // …or this close if the car is stuck on something
    arrestRange: 48,
    arrestSec: 2.5, // standing next to an officer this long gets you arrested
    shootFrom: 3, // officers shoot at suspects with this many stars or more
    shootRange: 520,
    fireEverySec: 0.8,
    aimSpread: 0.18,
    officerHealth: 100,
    officerArmor: 0.25, // body armour: officers take this much less damage
    respawnSec: 60, // a downed officer is replaced at the station after this (a new car, when there's a space)
    bailPerStar: 250, // paid from cash, then the bank
    jailSecPerStar: 30, // if you can't make bail
  },
  // Hired muscle from the БАР (the barman): goons follow you (and ride along in your car), guards hold
  // your home or a warehouse from the inside, a hitman hunts one player. Hiring is paid from the bank;
  // goons and guards also draw a wage every minute and walk off if you can't pay it.
  // Gangsters: a few hard men in trench coats with rifles, walking the town (see src/game/hires.js).
  //   They take armor less damage, don't heal on their own, and come back (new faces) a while after one's killed or arrested.
  //   Spotting you on foot, there's a robChance they hold you up: holdupSec standing still with your hands up
  //   and they take `take` of your carried cash; run off or pull a trigger and they open fire.
  //   Spotting a player's parked car with its owner away, they steal it, drive it off and leave it
  //   somewhere after joyrideSec (its owner is told where).
  //   They also buy any vodka (and the mixes) for vodkaPrice × base. The Militsiya only go after them
  //   for crimes they're seen doing.
  gangsters: {
    count: 4,
    health: 160,
    armor: 0.3,
    weapon: 'rifle',
    walkSpeed: 75,
    sight: 520,
    robChance: 0.2,
    holdupRange: 120,
    holdupSec: 4,
    holdupMove: 45, // moving more than this during a hold-up counts as running off
    take: 0.5,
    playerCooldownSec: 180, // once he's sized you up, he leaves you be this long
    theftCooldownSec: 240,
    ownerAwayRange: 260, // a car's owner within this of it: he leaves it alone
    joyrideSec: [40, 70],
    fightRange: 700,
    vodkaPrice: 3,
    tradeReach: 110,
    respawnSec: 120,
  },
  hires: {
    barVodkaPrice: 250, // a bottle of vodka from the barman (cash): dear — no questions asked
    reach: 130, // from the barman's centre to your edge (same as a market's, which the client's E prompt uses)
    radius: 18,
    health: 150,
    armor: 0.5, // body armour: share of each hit it soaks up
    regenPerSec: 1,
    speed: 250, // walking; goons catching up with you and hitmen on the hunt run at runSpeed
    runSpeed: 320,
    weapon: 'rifle',
    fireEverySec: 0.35,
    aimSpread: 0.12,
    shootRange: 600,
    engageRange: 750, // goons and guards go for threats this close
    foeSec: 15, // whoever fights you (or your hire) is fair game this long
    traceChance: 0.35, // a goon or guard's crime is traced back to whoever hired them (hitmen never are)
    catchUpRange: 2200, // goons this far behind turn up near you again
    goonOfflineSec: 120, // goons whose boss has left go home after this
    boardRange: 400, // goons this close to your car when you get in walk over and hop in
    lockpickSec: 5, // a hitman picks a locked door this fast
    goon: { name: 'Goon', fee: 2500, wagePerMin: 40, max: 2 },
    guard: { name: 'Guard', fee: 2000, wagePerMin: 30, max: 3 },
    // A hitman drives his own car, parks in range and snipes: he lines up each shot for aimSec (a red
    // laser shows), likes to be range[0]–range[1] away, and drives again when you're past driveFrom.
    hitman: { name: 'Hitman', fee: 6000, contractSec: 600, refundShare: 0.5, max: 1, weapon: 'sniper', car: 'sedan', range: [450, 1150], aimSec: 1.1, spread: 0.02, driveFrom: 1600 },
  },
});
