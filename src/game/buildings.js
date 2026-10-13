import { randRange } from '../utils/math.js';

// Signs (labels) are in Russian: the game is set in 1990s post-Soviet Russia.
// Buildings are made of axis-aligned rectangles so collision stays cheap and identical on the client.
// Each type is laid out in local coordinates (0..w, 0..h) and then rotated/placed on the map.
//   walls:     solid rectangles (block players and bullets); `c` overrides the wall colour
//   decor:     floor-level furniture, drawn only (no collision)
//   roofDecor: drawn on top of the roof (chimneys, vents, crosses…)
//   doors:     every doorway gap, with the outward direction for outside doors
//   npc:       where a shopkeeper stands (centre and facing), for buildings that sell food

const PRISON_CELLS = 8; // the cell block's cells (2 bunks each), in two rows
const MIN_DOOR = 90; // comfortably wider than a starting player (40)

// Doorways recorded while a layout is being built (layouts are built one at a time).
let doorways = [];

/**
 * Horizontal (y fixed) or vertical (x fixed) wall from `from` to `to`, with door gaps at fractions along it.
 * `outward` is the outside direction for perimeter walls; interior walls leave it null.
 */
function wallLine(horizontal, fixed, from, to, t, gaps = [], outward = null) {
  const len = to - from;
  const cuts = gaps
    .map(({ at, width }) => {
      const half = Math.max(MIN_DOOR, Math.round(width * 1.4)) / 2;
      return [Math.max(from, from + at * len - half), Math.min(to, from + at * len + half)];
    })
    .sort((a, b) => a[0] - b[0]);
  for (const [g0, g1] of cuts) {
    const [nx, ny] = outward ?? (horizontal ? [0, 1] : [1, 0]);
    const rect = horizontal ? { x: g0, y: fixed, w: g1 - g0, h: t } : { x: fixed, y: g0, w: t, h: g1 - g0 };
    doorways.push({ ...rect, nx, ny, exterior: outward !== null });
  }
  const rects = [];
  let start = from;
  for (const [g0, g1] of [...cuts, [to, to]]) {
    if (g0 - start > 0.5) {
      rects.push(horizontal ? { x: start, y: fixed, w: g0 - start, h: t } : { x: fixed, y: start, w: t, h: g0 - start });
    }
    start = Math.max(start, g1);
  }
  return rects;
}

/** Outer walls. doors: { n|s|e|w: [{ at, width }] } */
function perimeter(w, h, t, doors = {}) {
  return [
    ...wallLine(true, 0, 0, w, t, doors.n, [0, -1]),
    ...wallLine(true, h - t, 0, w, t, doors.s, [0, 1]),
    ...wallLine(false, 0, t, h - t, t, doors.w, [-1, 0]),
    ...wallLine(false, w - t, t, h - t, t, doors.e, [1, 0]),
  ];
}

const door = (at = 0.5, width = 60) => [{ at, width }];

/**
 * A factory hall: loading door at the front, a staff door on the side, machinery inside, and an
 * office clerk (the factory's "terminal") just inside the staff door.
 */
function industrial({ roof, wall = '#9aa1a8', floor = '#6f7378', machines = [], roofDecor = [], label }) {
  const w = 380, h = 270;
  return {
    w, h,
    walls: [
      ...perimeter(w, h, 14, { s: door(0.42, 120), e: door(0.75, 60) }),
      ...wallLine(false, 270, 140, 256, 10, door(0.5, 60)), // office partition
      ...machines.filter((m) => m.solid).map(({ x, y, w: mw, h: mh, c }) => ({ x, y, w: mw, h: mh, c })),
    ],
    decor: [
      { x: 284, y: 150, w: 80, h: 30, c: '#5a4632' }, // office desk
      { x: 20, y: 236, w: 230, h: 8, c: '#c9a227' }, // floor markings
      ...machines.filter((m) => !m.solid),
    ],
    roofDecor,
    npc: { x: 320, y: 215, angle: 0, role: 'factory' },
    floor, wall, roof, pattern: 'metal', label,
  };
}

/**
 * A work site the size of a whole country block (mine, lumberyard, farm, oil field): open air, a fence
 * with a wide gate in the south side (rotate to face the road), the foreman's hut just inside the gate
 * with the foreman out front, and a `work` area where the resources are (placed by the server).
 */
function site({ w, h, label, ground, fence, decor = [], props = [], work, hut: withHut = true, npc = null, picket = false, groundDecor = true, roofs = [], pumps = null }) {
  const gx = w / 2;
  const hut = { x: gx + 140, y: h - 6 - 150, w: 150, h: 110 };
  const fenceWalls = perimeter(w, h, 6, { s: door(0.5, 170) }).map((f) => (picket ? { ...f, picket: true } : f));
  return {
    w, h,
    walls: [
      ...fenceWalls,
      // The foreman's hut (door facing the gate road).
      ...(withHut
        ? [
            ...wallLine(true, hut.y, hut.x, hut.x + hut.w, 8),
            ...wallLine(false, hut.x, hut.y + 8, hut.y + hut.h, 8),
            ...wallLine(false, hut.x + hut.w - 8, hut.y + 8, hut.y + hut.h, 8),
            ...wallLine(true, hut.y + hut.h - 8, hut.x, hut.x + hut.w, 8, door(0.3, 60)),
          ]
        : []),
      ...props,
    ],
    decor: [...(groundDecor ? [{ x: 0, y: 0, w, h, c: ground }] : []), ...(withHut ? [{ x: hut.x + 8, y: hut.y + 8, w: hut.w - 16, h: hut.h - 16, c: '#7a6a55' }] : []), ...decor],
    roofDecor: [],
    // Open air, but the buildings inside it have roofs of their own (they fade when you walk in).
    roofs: [...(withHut ? [{ x: hut.x - 4, y: hut.y - 4, w: hut.w + 8, h: hut.h + 8, c: '#6b5a48', pattern: 'planks' }] : []), ...roofs],
    npc: npc ?? { x: gx + 100, y: h - 6 - 50, angle: Math.PI / 2, role: 'market' }, // by the gate, facing the road
    work: work ?? { x: 80, y: 80, w: w - 160, h: h - 330 },
    floor: ground, wall: fence, roof: ground, pattern: 'none', label,
    ...(pumps ? { pumps } : {}),
  };
}

/** An open-air yard (no roof) with a low fence, a gate, and a foreman who sells its raw good. */
function yard({ w = 360, h = 270, ground, fence = '#8a6d4a', props = [], decor = [], fenced = true, label }) {
  return {
    w, h,
    walls: [
      ...(fenced ? perimeter(w, h, 6, { s: door(0.5, 130) }) : []),
      ...props.map(({ x, y, w: pw, h: ph, c }) => ({ x, y, w: pw, h: ph, c })),
    ],
    decor: [{ x: 0, y: 0, w, h, c: ground }, ...decor],
    roofDecor: [],
    npc: { x: w / 2 + 90, y: h - 50, angle: Math.PI / 2, role: 'market' },
    floor: ground, wall: fence, roof: ground, pattern: 'none', label,
  };
}

const MACHINE = '#4b525a';

/** Building type -> warehouse size (prices etc. in config.warehouses.sizes), and each size's floor grid. */
/** Work sites: borrow the tool from the foreman and gather (the oil field pumps on its own). */
export const WORK_SITES = { mine: 'pickaxe', logging: 'axe', farm: 'scythe', oilwell: null, prison: 'pickaxe' }; // (the prison's pickaxes are handed out, not borrowed)

export const WAREHOUSE_SIZES = { smallwarehouse: 'small', warehouse: 'medium', bigwarehouse: 'large', shack: 'shack' };
export const WAREHOUSE_TILE = 40;
export const WAREHOUSE_GRIDS = { small: { cols: 6, rows: 6 }, medium: { cols: 10, rows: 8 }, large: { cols: 14, rows: 10 }, shack: { cols: 6, rows: 5 } };

/**
 * An empty warehouse: walls around a `cols`×`rows` grid of 40-unit tiles. The bottom-left 2×2 is the
 * IN dock and the bottom-right 2×2 the OUT dock, each with a loading door right behind it.
 */
function warehouse(size) {
  const { cols, rows } = WAREHOUSE_GRIDS[size];
  const T = WAREHOUSE_TILE;
  const m = 36; // wall plus a walkway
  const w = cols * T + m * 2, h = rows * T + m * 2;
  const dockIn = { x: m, y: m + (rows - 2) * T, w: 2 * T, h: 2 * T };
  const dockOut = { x: m + (cols - 2) * T, y: m + (rows - 2) * T, w: 2 * T, h: 2 * T };
  return {
    w, h,
    walls: perimeter(w, h, 16, { s: [{ at: (m + T) / w, width: 70 }, { at: (m + (cols - 1) * T) / w, width: 70 }] }),
    decor: [
      { x: m - 6, y: m - 6, w: cols * T + 12, h: 4, c: '#c9a227' }, // floor markings round the grid
      { x: m - 6, y: m + rows * T + 2, w: cols * T + 12, h: 4, c: '#c9a227' },
    ],
    roofDecor: [
      { x: w * 0.25 - 15, y: h / 2 - 15, w: 30, h: 30, c: '#5f666d', round: true },
      { x: w * 0.75 - 15, y: h / 2 - 15, w: 30, h: 30, c: '#5f666d', round: true },
    ],
    grid: { x: m, y: m, w: cols * T, h: rows * T },
    docks: { in: dockIn, out: dockOut },
    floor: '#6c6f73', wall: '#4d5560', roof: '#8d969e', pattern: 'metal', label: 'СКЛАД',
  };
}

/**
 * A small cobblestone fireplace against a wall, its opening facing (nx, ny) into the room. Solid (you
 * can't walk into the fire); the client draws the stones, the flames and the warm glow.
 */
const fireplace = (x, y, w, h, nx, ny) => ({ x, y, w, h, c: '#7d746a', fireplace: true, nx, ny });
/** Solid furniture that comes with a building (a desk, sofa, bookshelf…), its front facing (nx, ny). Drawn by the client's drawProp. */
const prop = (kind, x, y, w, h, nx, ny) => ({ x, y, w, h, c: '#5a3418', prop: kind, nx, ny });
/** Its chimney on the roof (a little smoke drifts off it). */
const chimney = (x, y) => ({ x, y, w: 22, h: 22, c: '#6e5a50', chimney: true, small: true });
/**
 * Furniture a home comes with, in its own layout coordinates: [kind, x, y, rot]. rot says which way it's
 * turned (its front faces west, north, east, south for 0, 1, 2, 3). Starter homes get only the bed and
 * cabinet; the rest is set out in homes nobody owns (and comes with them when bought).
 */
const furnish = (list) => list.map(([kind, x, y, rot]) => ({ kind, x, y, rot }));

export const BUILDING_TYPES = {
  house: () => ({
    w: 260, h: 220,
    walls: [
      ...perimeter(260, 220, 12, { s: door(0.3) }), ...wallLine(false, 160, 12, 208, 10, door(0.5, 56)),
      fireplace(12, 122, 20, 44, 1, 0), // on the west wall of the front room
    ],
    decor: [{ x: 32, y: 132, w: 34, h: 24, c: '#6b3a2a' }], // a rag rug before the fire
    roofDecor: [chimney(10, 133)],
    furnish: furnish([['bed', 20, 20, 3], ['cabinet', 78, 20, 3], ['table', 205, 140, 0], ['chair', 213, 112, 3]]),
    floor: '#8a6a4a', wall: '#d8cbb0', roof: '#4f6b4a', pattern: 'metal', // green-painted tin roof
  }),

  // Five-storey prefab apartment block (khrushchyovka): three stairwell entrances (podezds) on one side.
  // Three flats, one behind each entrance (walled off from each other: each one can be rented).
  panelka: () => ({
    w: 600, h: 220,
    walls: [
      ...perimeter(600, 220, 14, { s: [{ at: 1 / 6, width: 56 }, { at: 0.5, width: 56 }, { at: 5 / 6, width: 56 }] }),
      ...wallLine(false, 200, 14, 206, 10),
      ...wallLine(false, 400, 14, 206, 10),
      ...[0, 1, 2].map((i) => fireplace(i * 200 + 132, 14, 44, 20, 0, 1)), // on each flat's back wall
    ],
    decor: [
      ...[0, 1, 2].flatMap((i) => [
        { x: 60 + i * 200, y: 150, w: 80, h: 40, c: '#7d7f82' }, // the landing by the door
        { x: 136 + i * 200, y: 36, w: 36, h: 22, c: '#7a2e2e' }, // a rug before the fire
      ]),
    ],
    roofDecor: [
      ...[0, 1, 2].map((i) => ({ x: 80 + i * 200, y: 150, w: 40, h: 40, c: '#6b6e72' })), // stairwell hatches
      ...[0, 1, 2].map((i) => chimney(i * 200 + 143, 10)),
      { x: 60, y: 30, w: 6, h: 60, c: '#3a3a3a' }, // TV aerials
      { x: 430, y: 40, w: 6, h: 50, c: '#3a3a3a' },
    ],
    rooms: [0, 1, 2].map((i) => ({ x: i * 200 + (i ? 10 : 14), y: 14, w: 200 - (i ? 10 : 14) - (i < 2 ? 0 : 14), h: 192 })), // the flats, for renting
    furnish: furnish([0, 1, 2].flatMap((i) => [['bed', i * 200 + 24, 22, 3], ['cabinet', i * 200 + 82, 22, 3], ['table', i * 200 + 140, 72, 0], ['chair', i * 200 + 112, 90, 2]])),
    floor: '#9a8a74', wall: '#c9c6bd', roof: '#8c8f93', pattern: 'flat',
  }),

  // A row of lock-up garages (garazhi): each box has its own door, some hold a car or junk.
  garages: () => ({
    w: 550, h: 150,
    walls: [
      ...perimeter(550, 150, 10, { s: [0, 1, 2, 3, 4].map((i) => ({ at: (i + 0.5) / 5, width: 60 })) }),
      ...[1, 2, 3, 4].flatMap((i) => wallLine(false, i * 110 - 4, 10, 140, 8)),
    ],
    decor: [
      { x: 25, y: 48, w: 62, h: 88, c: '#c8b560' }, // a Lada
      { x: 240, y: 62, w: 60, h: 40, c: '#5a4a3a' }, // junk
      { x: 350, y: 62, w: 50, h: 50, c: '#3a3a3a', round: true }, // tyres
      { x: 462, y: 48, w: 62, h: 88, c: '#8a2a2a' },
    ],
    roofDecor: [],
    rooms: [0, 1, 2, 3, 4].map((i) => ({ x: i * 110 + (i ? 4 : 10), y: 10, w: 110 - (i ? 4 : 10) - (i < 4 ? 4 : 10), h: 130 })), // the boxes, for renting
    furnish: furnish([0, 1, 2, 3, 4].map((i) => ['cabinet', i * 110 + 32, 14, 3])), // a cabinet at the back of each box
    floor: '#5a5d61', wall: '#8a7f72', roof: '#7a5a48', pattern: 'metal', // rusty tin
  }),

  // Street kiosk (larek): a closed booth with a seller behind the window. Sells food like a shop.
  kiosk: () => ({
    w: 150, h: 110,
    walls: [
      ...perimeter(150, 110, 8),
      { x: 20, y: 72, w: 110, h: 10, c: '#6b4a2b' }, // counter under the window
    ],
    decor: [{ x: 14, y: 14, w: 122, h: 30, c: '#c94a2b' }], // shelves of snacks and vodka
    roofDecor: [],
    npc: { x: 75, y: 50, angle: Math.PI / 2, role: 'shop' },
    floor: '#b8a890', wall: '#3f6d8a', roof: '#d8a23a', pattern: 'flat', label: 'ЛАРЁК',
  }),

  // A smoky dive where the barman knows people: hire goons, guards and hitmen here.
  bar: () => ({
    w: 320, h: 240,
    walls: [
      ...perimeter(320, 240, 12, { s: door(0.75, 70) }),
      { x: 30, y: 80, w: 170, h: 18, c: '#5a3a22' }, // the bar
      { x: 210, y: 12, w: 12, h: 100 }, // back room
    ],
    decor: [
      { x: 24, y: 20, w: 180, h: 16, c: '#7a4a2a' }, // bottles on the back shelf
      { x: 40, y: 140, w: 36, h: 36, c: '#6b4a2b' }, // tables
      { x: 110, y: 160, w: 36, h: 36, c: '#6b4a2b' },
      { x: 240, y: 30, w: 56, h: 56, c: '#2f5a3a' }, // card table in the back
      { x: 30, y: 196, w: 120, h: 20, c: '#8b1a1a' }, // worn carpet
    ],
    roofDecor: [{ x: 250, y: 160, w: 30, h: 30, c: '#4a4f54' }], // vent
    npc: { x: 110, y: 56, angle: Math.PI / 2, role: 'barman' }, // behind the bar
    floor: '#5a4636', wall: '#4a3428', roof: '#3b2f2a', pattern: 'flat', label: 'БАР',
  }),

  cabin: () => ({
    w: 180, h: 160,
    walls: [...perimeter(180, 160, 14, { e: door(0.5, 56) }), fireplace(84, 126, 44, 20, 0, -1)], // the fire on the south wall
    decor: [{ x: 90, y: 100, w: 32, h: 22, c: '#5e3a2a' }], // a rug before it
    roofDecor: [chimney(95, 136)],
    furnish: furnish([['bed', 22, 22, 3], ['cabinet', 82, 22, 3], ['chair', 24, 118, 2]]),
    floor: '#7a5434', wall: '#5b3a1e', roof: '#4a3020', pattern: 'planks',
  }),

  barn: () => ({
    w: 420, h: 300,
    walls: [
      ...perimeter(420, 300, 14, { s: door(0.5, 130), n: door(0.2) }),
      // Hay bales: solid cover.
      { x: 40, y: 50, w: 50, h: 34, c: '#d8b24a' },
      { x: 40, y: 90, w: 50, h: 34, c: '#cfa940' },
      { x: 320, y: 60, w: 34, h: 50, c: '#d8b24a' },
      { x: 300, y: 200, w: 50, h: 34, c: '#cfa940' },
    ],
    decor: [
      { x: 150, y: 40, w: 120, h: 80, c: '#a88c4e' }, // loose straw
      { x: 30, y: 180, w: 80, h: 90, c: '#5a4632' }, // stall
    ],
    roofDecor: [
      { x: 0, y: 145, w: 420, h: 10, c: '#5a2019' }, // ridge
      { x: 195, y: 0, w: 30, h: 300, c: '#f2f2f2' },
    ],
    floor: '#9c8455', wall: '#8e2b22', roof: '#7a2a24', pattern: 'planks',
  }),

  // Empty warehouses for sale: a floor grid for machines and belts, an IN and an OUT dock just inside the loading doors.
  smallwarehouse: () => warehouse('small'),
  warehouse: () => warehouse('medium'),
  bigwarehouse: () => warehouse('large'),
  shack: () => ({ ...warehouse('shack'), wall: '#5b4630', roof: '#6b5a48', floor: '#6a5a46', pattern: 'planks', label: null }), // a timber shack in the woods

  // The freight station (vokzal): the railway runs along its south side; the freight clerk buys
  // whatever the next train's export contracts want.
  station: () => ({
    w: 720, h: 260,
    walls: [
      ...perimeter(720, 260, 16, { s: [{ at: 0.2, width: 90 }, { at: 0.5, width: 110 }, { at: 0.8, width: 90 }], n: door(0.5, 80) }),
      { x: 300, y: 130, w: 160, h: 18, c: '#6b4a2b' }, // freight office counter
    ],
    decor: [
      { x: 40, y: 40, w: 200, h: 60, c: '#7a5a3a' }, // waiting benches
      { x: 480, y: 40, w: 200, h: 60, c: '#7a5a3a' },
      { x: 300, y: 30, w: 160, h: 50, c: '#2c3e50' }, // departures board
      { x: 60, y: 170, w: 160, h: 50, c: '#8a6236' }, // crates waiting to ship
      { x: 520, y: 170, w: 140, h: 50, c: '#8a6236' },
    ],
    roofDecor: [
      { x: 330, y: 20, w: 60, h: 60, c: '#c9a227', round: true }, // clock
      { x: 120, y: 90, w: 30, h: 30, c: '#5f666d' },
      { x: 570, y: 90, w: 30, h: 30, c: '#5f666d' },
    ],
    npc: { x: 380, y: 170, angle: Math.PI / 2, role: 'station' }, // faces the platform side
    floor: '#b9ae9a', wall: '#e8d9b5', roof: '#3f6b55', pattern: 'shingle', label: 'ВОКЗАЛ',
  }),

  shop: () => ({
    w: 300, h: 220,
    walls: [
      ...perimeter(300, 220, 12, { s: door(0.5, 90) }),
      { x: 40, y: 110, w: 90, h: 18, c: '#7a5a3a' }, // counter
    ],
    decor: [
      { x: 20, y: 20, w: 260, h: 22, c: '#9a8a6a' }, // shelves
      { x: 200, y: 70, w: 22, h: 100, c: '#9a8a6a' },
      { x: 250, y: 70, w: 22, h: 100, c: '#9a8a6a' },
    ],
    // What it sells, out on the shelves (just to look at: you buy from the shopkeeper).
    displays: [
      { x: 20, y: 20, w: 260, h: 22, kind: 'shelf', show: ['food:bread', 'food:burger', 'food:drink', 'food:feast', 'tool:rod'] },
      { x: 200, y: 70, w: 22, h: 100, kind: 'shelf', show: ['food:drink', 'food:bread'] },
      { x: 250, y: 70, w: 22, h: 100, kind: 'shelf', show: ['food:burger', 'food:feast'] },
    ],
    roofDecor: [],
    npc: { x: 85, y: 88, angle: Math.PI / 2, role: 'shop' }, // behind the counter, facing the door
    floor: '#c9c1b4', wall: '#e8e2d6', roof: '#2f6f8f', pattern: 'flat', label: 'МАГАЗИН',
  }),

  bunker: () => ({
    w: 200, h: 200,
    walls: perimeter(200, 200, 28, { w: door(0.5, 50) }),
    decor: [
      { x: 50, y: 50, w: 40, h: 100, c: '#4a5a3a' }, // cots
      { x: 110, y: 50, w: 40, h: 100, c: '#4a5a3a' },
    ],
    roofDecor: [{ x: 80, y: 80, w: 40, h: 40, c: '#4a4f54' }], // hatch
    floor: '#55595c', wall: '#3a3d40', roof: '#5f6468', pattern: 'flat',
  }),

  church: () => ({
    w: 240, h: 440,
    // Orthodox: no pews (people stand), an icon screen before the altar, onion domes on the roof.
    walls: [...perimeter(240, 440, 14, { s: door(0.5, 70), e: door(0.2, 56) })],
    decor: [
      { x: 30, y: 110, w: 180, h: 14, c: '#c9a227' }, // iconostasis
      ...[0, 1, 2, 3, 4].map((i) => ({ x: 40 + i * 34, y: 96, w: 24, h: 14, c: '#8b5a2b' })), // icons
      { x: 80, y: 40, w: 80, h: 40, c: '#e0d6b8' }, // altar
      { x: 110, y: 130, w: 20, h: 300, c: '#8b2232' }, // carpet
    ],
    roofDecor: [
      { x: 80, y: 180, w: 80, h: 80, c: '#d4a017', round: true }, // main dome
      { x: 104, y: 204, w: 32, h: 32, c: '#f1c40f', round: true },
      { x: 30, y: 60, w: 50, h: 50, c: '#2e5e9e', round: true }, // smaller blue domes
      { x: 160, y: 60, w: 50, h: 50, c: '#2e5e9e', round: true },
      { x: 30, y: 340, w: 50, h: 50, c: '#2e5e9e', round: true },
      { x: 160, y: 340, w: 50, h: 50, c: '#2e5e9e', round: true },
      { x: 114, y: 150, w: 12, h: 50, c: '#f1c40f' }, // cross
      { x: 102, y: 162, w: 36, h: 8, c: '#f1c40f' },
    ],
    floor: '#a08a6a', wall: '#f0ece2', roof: '#5f8fbf', pattern: 'metal',
  }),

  watchtower: () => ({
    w: 140, h: 140,
    walls: perimeter(140, 140, 10, { n: door(0.5, 50), s: door(0.5, 50), e: door(0.5, 50), w: door(0.5, 50) }),
    decor: [{ x: 50, y: 50, w: 40, h: 40, c: '#4b3a24' }], // ladder
    roofDecor: [{ x: 60, y: 60, w: 20, h: 20, c: '#4a1f1f' }],
    floor: '#6b5536', wall: '#4b3a24', roof: '#7b2f2f', pattern: 'tiles',
  }),

  // An open-plan mansion (no inner walls): beds and a cabinet in one corner, a dining table, a sitting
  // area round the fire with sofas, and a pool table.
  mansion: () => ({
    w: 520, h: 420,
    walls: [
      ...perimeter(520, 420, 14, { s: door(0.5, 80), n: door(0.8) }),
      fireplace(14, 188, 20, 44, 1, 0), // on the west wall
    ],
    decor: [
      { x: 320, y: 280, w: 120, h: 80, c: '#3f6b4a' }, // pool table
      { x: 36, y: 176, w: 72, h: 68, c: '#8b2232' }, // a rug before the fire
      { x: 200, y: 150, w: 120, h: 100, c: '#6b3a3a' }, // a big rug in the middle
    ],
    roofDecor: [
      chimney(13, 199),
      { x: 430, y: 330, w: 26, h: 26, c: '#2a2a33' },
    ],
    furnish: furnish([
      ['bed', 30, 24, 3], ['bed', 100, 24, 3], ['cabinet', 158, 24, 3], // the beds
      ['table', 300, 70, 1], ['chair', 306, 40, 3], ['chair', 306, 116, 1], ['chair', 370, 78, 0], // dining
      ['furniture', 120, 172, 0], ['furniture', 40, 290, 1], ['chair', 60, 150, 3], // round the fire
      ['furniture', 342, 236, 3], // by the pool table
      ['cabinet', 440, 370, 1],
    ]),
    floor: '#7d5a3c', wall: '#efe6d2', roof: '#3b3b46', pattern: 'shingle',
  }),

  // The governor's residence: a yellow-and-white classical manor (a dvoryanskaya usadba) behind iron
  // railings, a green roof with a little dome, a portico of columns, a fountain in the forecourt and a
  // gravel drive out to the gate. Open grounds (pattern none); the house has a roof of its own.
  governor: () => {
    const W = 1100, H = 900;
    const hx = 230, hy = 90, hw = 640, hh = 360, t = 16; // the house
    const gate = W / 2;
    const columns = [430, 462, 622, 654].map((x) => ({ x, y: hy + hh + 4, w: 16, h: 16, c: '#f4f0e6', column: true }));
    const fir = (x, y, r = 26) => ({ x: x - r, y: y - r, w: r * 2, h: r * 2, c: '#2d5634', round: true, fir: true });
    return {
      w: W, h: H,
      walls: [
        ...perimeter(W, H, 8, { s: door(0.5, 130) }).map((f) => ({ ...f, c: '#25272b', railing: true })), // iron railings
        { x: gate - 91 - 30, y: H - 40, w: 30, h: 40, c: '#efe9da' }, { x: gate + 91, y: H - 40, w: 30, h: 40, c: '#efe9da' }, // gate pillars
        // The house: front door under the portico, a garden door at the back, two wings off the hall.
        // (Inside the grounds, so not "outside" doors: the household walks in by waypoints, see spots.)
        ...wallLine(true, hy, hx, hx + hw, t, door(0.5, 56)),
        ...wallLine(true, hy + hh - t, hx, hx + hw, t, door(0.5, 70)),
        ...wallLine(false, hx, hy + t, hy + hh - t, t),
        ...wallLine(false, hx + hw - t, hy + t, hy + hh - t, t),
        ...wallLine(false, hx + 210, hy + t, hy + hh - t, 12, door(0.72, 60)),
        ...wallLine(false, hx + 430, hy + t, hy + hh - t, 12, door(0.72, 60)),
        fireplace(hx + 300, hy + t, 40, 20, 0, 1), // in the hall, on the back wall
        // The west wing, his study: the big desk against the back wall, books, a sofa for visitors.
        prop('desk', hx + 50, hy + 16, 100, 46, 0, 1),
        prop('bookshelf', hx + 158, hy + 16, 46, 22, 0, 1),
        prop('bookshelf', hx + 16, hy + 96, 22, 210, 1, 0),
        prop('sofa', hx + 66, hy + 308, 104, 36, 0, -1),
        // The hall: two sofas facing each other by the fire.
        prop('sofa', hx + 226, hy + 56, 36, 92, 1, 0),
        prop('sofa', hx + 378, hy + 56, 36, 92, -1, 0),
        // The east wing, the inspector's office: his desk against the side wall, the files, a sofa.
        prop('desk', hx + 578, hy + 34, 46, 104, -1, 0),
        prop('bookshelf', hx + 446, hy + 16, 64, 22, 0, 1),
        prop('bookshelf', hx + 602, hy + 186, 22, 140, -1, 0),
        prop('sofa', hx + 470, hy + 308, 100, 36, 0, -1),
        ...columns,
      ].map((wl) => (wl.c ? wl : { ...wl, c: '#e3bf5a' })), // ochre walls
      decor: [
        { x: 0, y: 0, w: W, h: H, c: '#5c8a46' }, // lawn
        { x: gate - 60, y: 600, w: 120, h: H - 600, c: '#c9bc98' }, // the gravel drive
        { x: gate - 115, y: 488, w: 230, h: 230, c: '#c9bc98', round: true }, // the forecourt
        { x: gate - 46, y: 557, w: 92, h: 92, c: '#dcd6c6', round: true }, // the fountain's basin
        { x: gate - 34, y: 569, w: 68, h: 68, c: '#4f8fbf', round: true, water: true },
        { x: hx, y: hy, w: hw, h: hh, c: '#8a5a32', parquet: true }, // parquet floors
        { x: hx + 290, y: hy + 60, w: 60, h: hh - 70, c: '#9b1c24' }, // red carpet up the hall
        { x: hx + 40, y: hy + 200, w: 140, h: 110, c: '#7a2230' }, // rugs in the wings
        { x: hx + 470, y: hy + 210, w: 140, h: 110, c: '#2f4a6b' },
        { x: hx + 20, y: hy + hh + 8, w: 170, h: 24, c: '#b8324a', flowers: true }, // flowerbeds along the front
        { x: hx + hw - 190, y: hy + hh + 8, w: 170, h: 24, c: '#d8a23a', flowers: true },
        { x: gate - 90, y: 740, w: 24, h: 120, c: '#b8324a', flowers: true }, { x: gate + 66, y: 740, w: 24, h: 120, c: '#b8324a', flowers: true },
        ...[60, 160, 260, 840, 940, 1040].map((x) => fir(x, 60)),
        ...[60, 1040].flatMap((x) => [200, 340, 480, 620, 760].map((y) => fir(x, y))),
        fir(150, 820, 30), fir(950, 820, 30), fir(250, 700, 22), fir(850, 700, 22),
      ],
      roofDecor: [],
      roofs: [
        { x: hx - 8, y: hy - 8, w: hw + 16, h: hh + 16, c: '#3f7a55', pattern: 'metal', ridge: true, manor: true }, // green tin, a dome in the middle
        { x: 412, y: hy + hh - 6, w: 276, h: 34, c: '#f2eee4', ridge: true, portico: true },
      ],
      spots: {
        governor: [{ x: hx + 110, y: hy + 220 }, { x: hx + 320, y: hy + 220 }, { x: hx + 530, y: hy + 240 }, { x: hx + 100, y: hy + 92 }], // (the last: at his desk)
        inspector: { x: hx + 540, y: hy + 70 },
        guards: [{ x: gate - 150, y: H + 40, angle: Math.PI / 2 }, { x: gate + 150, y: H + 40, angle: Math.PI / 2 }],
        car: { x: gate + 300, y: H + 60, angle: 0 }, // the inspector's black Lada, parked along the front
        // The way in: the gate (outside, inside), the porch, the hall; the doors into each wing.
        gateOut: { x: gate, y: H + 50 }, gateIn: { x: gate, y: H - 70 }, porch: { x: gate, y: hy + hh + 50 }, hall: { x: gate, y: hy + hh - 70 },
        doorW: { x: hx + 210 + 6, y: hy + t + 0.72 * (hh - 2 * t) }, doorE: { x: hx + 430 + 6, y: hy + t + 0.72 * (hh - 2 * t) },
        house: { x: hx, y: hy, w: hw, h: hh }, grounds: { x: 0, y: 0, w: W, h: H },
      },
      floor: '#5c8a46', wall: '#25272b', roof: '#5c8a46', pattern: 'none', label: 'ГУБЕРНАТОР',
    };
  },

  // A little brick shed tacked onto the end of a panelka: a cash-counting machine that turns your
  // cash into a bank balance with no questions asked, for the panelka's owner only. Placed beside a panelka, not on its own.
  laundry: () => ({
    w: 140, h: 120,
    walls: perimeter(140, 120, 10, { s: door(0.5, 50) }),
    decor: [
      { x: 18, y: 18, w: 40, h: 26, c: '#3d5a3a' }, // bundles of notes on a table
      { x: 92, y: 70, w: 30, h: 30, c: '#4a4a4a', round: true }, // an old tyre
    ],
    roofDecor: [],
    npc: { x: 82, y: 40, angle: Math.PI / 2, role: 'laundry' }, // the machine, facing the door
    floor: '#6a6d70', wall: '#8a5a44', roof: '#6e5848', pattern: 'metal', label: 'ПРАЧЕЧНАЯ',
  }),

  gas: () => ({
    // Open canopy on pillars, with a small kiosk.
    w: 340, h: 220,
    walls: [
      { x: 30, y: 30, w: 22, h: 22, c: '#d0d0d0' },
      { x: 288, y: 30, w: 22, h: 22, c: '#d0d0d0' },
      { x: 30, y: 168, w: 22, h: 22, c: '#d0d0d0' },
      { x: 288, y: 168, w: 22, h: 22, c: '#d0d0d0' },
      { x: 120, y: 95, w: 30, h: 30, c: '#c8312b' }, // pumps
      { x: 190, y: 95, w: 30, h: 30, c: '#c8312b' },
    ],
    decor: [
      { x: 0, y: 0, w: 340, h: 220, c: '#3f4247' },
      { x: 60, y: 108, w: 220, h: 4, c: '#e8e8e8' },
    ],
    roofDecor: [{ x: 0, y: 0, w: 340, h: 14, c: '#f2f2f2' }],
    npc: { x: 170, y: 168, angle: Math.PI / 2, role: 'shop' }, // by the pumps
    floor: '#3f4247', wall: '#d0d0d0', roof: '#c8312b', pattern: 'flat', label: 'АЗС',
  }),

  bank: () => ({
    w: 320, h: 240,
    walls: [
      ...perimeter(320, 240, 16, { s: door(0.5, 80) }),
      { x: 60, y: 110, w: 200, h: 18, c: '#8a6d3b' }, // teller counter
      { x: 30, y: 24, w: 70, h: 56, c: '#6b7078' }, // vault
    ],
    decor: [
      { x: 120, y: 30, w: 170, h: 50, c: '#3b5f4a' }, // back office carpet
      { x: 130, y: 150, w: 60, h: 60, c: '#7a1e2e' }, // rug
      { x: 50, y: 40, w: 34, h: 24, c: '#4a4f57', round: true }, // vault door wheel
    ],
    roofDecor: [{ x: 140, y: 100, w: 40, h: 40, c: '#c9a227', round: true }],
    npc: { x: 160, y: 90, angle: Math.PI / 2, role: 'teller' }, // behind the counter
    floor: '#d9d2c3', wall: '#e9e4da', roof: '#2f5d4a', pattern: 'flat', label: 'БАНК',
  }),

  // ---- factories (one per production chain) ----
  sawmill: () => industrial({ label: 'ЛЕСОПИЛКА', roof: '#7a5434', machines: [
    { x: 40, y: 50, w: 180, h: 40, c: '#8b5a2b', solid: true }, // saw line
    { x: 40, y: 130, w: 70, h: 70, c: '#a0703c' }, // log stack
  ], roofDecor: [{ x: 60, y: 60, w: 26, h: 26, c: '#5a3d22', round: true }] }),
  furniture: () => industrial({ label: 'МЕБЕЛЬ', roof: '#8b4a2b', machines: [
    { x: 40, y: 50, w: 70, h: 50, c: MACHINE, solid: true },
    { x: 140, y: 50, w: 70, h: 50, c: MACHINE, solid: true },
    { x: 40, y: 140, w: 170, h: 60, c: '#7a2e2e' }, // sofas waiting to ship
  ] }),
  flourmill: () => industrial({ label: 'МЕЛЬНИЦА', roof: '#c9b27a', machines: [
    { x: 50, y: 50, w: 80, h: 80, c: '#d9d2c3', solid: true, round: true }, // millstone
    { x: 160, y: 60, w: 70, h: 120, c: '#e8dcc0' }, // sacks
  ], roofDecor: [{ x: 70, y: 70, w: 40, h: 40, c: '#9a8a6a', round: true }] }),
  bakery: () => industrial({ label: 'ХЛЕБОЗАВОД', roof: '#c0782f', floor: '#c9c1b4', machines: [
    { x: 40, y: 50, w: 110, h: 40, c: '#5a5a5a', solid: true }, // ovens
    { x: 40, y: 140, w: 180, h: 40, c: '#d9b07a' }, // dough tables
  ], roofDecor: [{ x: 70, y: 40, w: 22, h: 22, c: '#3a3a3a' }, { x: 120, y: 40, w: 22, h: 22, c: '#3a3a3a' }] }),
  foundry: () => industrial({ label: 'ЛИТЕЙНЫЙ ЦЕХ', roof: '#4a4f57', floor: '#4a4a4a', machines: [
    { x: 50, y: 50, w: 90, h: 90, c: '#2a2a2a', solid: true }, // furnace
    { x: 60, y: 60, w: 70, h: 70, c: '#e0582f', round: true }, // molten glow
    { x: 170, y: 60, w: 70, h: 110, c: '#6b7078' }, // ingots
  ], roofDecor: [{ x: 75, y: 75, w: 40, h: 40, c: '#222', round: true }] }),
  machineshop: () => industrial({ label: 'МЕХЦЕХ', roof: '#5d6d7e', machines: [
    { x: 40, y: 50, w: 50, h: 50, c: MACHINE, solid: true },
    { x: 110, y: 50, w: 50, h: 50, c: MACHINE, solid: true },
    { x: 180, y: 50, w: 50, h: 50, c: MACHINE, solid: true },
    { x: 40, y: 140, w: 190, h: 50, c: '#7f8c8d' }, // parts racks
  ] }),
  refinery: () => industrial({ label: 'НПЗ', roof: '#7f8c8d', machines: [
    { x: 40, y: 40, w: 70, h: 70, c: '#bdc3c7', solid: true, round: true }, // tanks
    { x: 130, y: 40, w: 70, h: 70, c: '#bdc3c7', solid: true, round: true },
    { x: 40, y: 140, w: 200, h: 14, c: '#e67e22' }, // pipes
  ], roofDecor: [{ x: 210, y: 40, w: 30, h: 30, c: '#2c3e50', round: true }] }),
  glassworks: () => industrial({ label: 'СТЕКОЛЬНЫЙ', roof: '#48c9b0', machines: [
    { x: 50, y: 50, w: 80, h: 60, c: '#2a2a2a', solid: true }, // kiln
    { x: 160, y: 50, w: 80, h: 130, c: '#aee9f0' }, // panes
  ] }),
  carfactory: () => industrial({ label: 'АВТОЗАВОД', roof: '#34495e', machines: [
    { x: 30, y: 50, w: 230, h: 20, c: '#e1b12c' }, // assembly line
    { x: 50, y: 90, w: 60, h: 100, c: '#2e86de' }, // cars on the line
    { x: 150, y: 90, w: 60, h: 100, c: '#c0392b' },
  ], roofDecor: [{ x: 40, y: 40, w: 200, h: 60, c: '#2d4f7c' }] }),
  gunfactory: () => industrial({ label: 'ОРУЖЕЙНЫЙ ЗАВОД', roof: '#3d3d3d', machines: [
    { x: 40, y: 50, w: 60, h: 60, c: MACHINE, solid: true },
    { x: 130, y: 50, w: 110, h: 40, c: '#2a2a2a', solid: true }, // test range wall
    { x: 40, y: 150, w: 200, h: 30, c: '#5d4037' }, // crates
  ] }),

  // ---- the coal power station (ТЭЦ): the power lines run from here to every building ----
  powerplant: () => ({
    w: 560, h: 400,
    walls: [
      ...perimeter(560, 400, 16, { s: door(0.3, 120), e: door(0.6, 60) }),
      ...wallLine(false, 300, 16, 384, 12, door(0.6, 60)), // boiler house | turbine hall
      { x: 40, y: 40, w: 220, h: 90, c: '#3b3b3b' }, // boilers
      { x: 330, y: 60, w: 180, h: 60, c: '#5d6d7e' }, // turbines
    ],
    decor: [
      { x: 40, y: 180, w: 220, h: 120, c: '#161616' }, // coal heap
      { x: 330, y: 180, w: 180, h: 140, c: '#4a5560' }, // switchgear
    ],
    roofDecor: [
      { x: 90, y: 70, w: 60, h: 60, c: '#b03a2e', round: true, chimney: true }, // red-and-white stacks
      { x: 102, y: 82, w: 36, h: 36, c: '#ecebe4', round: true },
      { x: 190, y: 70, w: 60, h: 60, c: '#b03a2e', round: true, chimney: true },
      { x: 202, y: 82, w: 36, h: 36, c: '#ecebe4', round: true },
      { x: 360, y: 240, w: 120, h: 70, c: '#5f666d' }, // transformer yard
    ],
    floor: '#5a5d61', wall: '#8c8f93', roof: '#6b6f75', pattern: 'metal', label: 'ТЭЦ',
  }),

  // ---- raw sites (sell one raw good) ----
  // Work sites: each fills a country block (size given when placed; these defaults are for the editor).
  logging: (size = { w: 1500, h: 1500 }) => {
    const { w, h } = size;
    return site({ ...size, label: 'ЛЕСПРОМХОЗ', ground: '#6e6247', fence: '#7a5a3a', groundDecor: false, // the trees stand on the ordinary ground
      decor: [
        { x: 60, y: h - 280, w: w * 0.35, h: 60, c: '#8b5a2b' }, { x: 60, y: h - 200, w: w * 0.35, h: 60, c: '#7a4a22' }, // log stacks by the gate
        { x: w * 0.42, y: h - 300, w: 90, h: 90, c: '#a0703c', round: true }, // sawdust heap
      ],
      props: [{ x: w * 0.42 + 120, y: h - 290, w: 140, h: 40, c: '#5a4a3a' }], // loading ramp
    });
  },
  // A kolkhoz: straight rows of wheat on brown ploughed earth inside a white picket fence, with a red
  // barn and a grain silo by the gate. The foreman waits at the barn door.
  farm: (size = { w: 1500, h: 1500 }) => {
    const { w, h } = size;
    const barn = { x: w / 2 + 130, y: h - 6 - 270, w: 300, h: 200 };
    const silo = { x: barn.x - 150, y: barn.y + 40, r: 62 };
    const red = '#9b2a22';
    return site({ ...size, label: 'КОЛХОЗ', ground: '#3e2c1c', fence: '#f2f0ea', picket: true, hut: false, groundDecor: false,
      roofs: [
        { x: barn.x - 10, y: barn.y - 10, w: barn.w + 20, h: barn.h + 20, c: '#7a2a24', pattern: 'metal', ridge: true }, // gable roof
        { x: silo.x - silo.r - 4, y: silo.y - silo.r - 4, w: (silo.r + 4) * 2, h: (silo.r + 4) * 2, c: '#8c939a', round: true, cone: true },
      ],
      work: { x: 70, y: 70, w: w - 140, h: h - 380 },
      npc: { x: barn.x + barn.w / 2, y: barn.y + barn.h + 34, angle: Math.PI / 2, role: 'market' },
      decor: [
        { x: barn.x + 10, y: barn.y + 10, w: barn.w - 20, h: barn.h - 20, c: '#8a6a44' }, // barn floor
        { x: barn.x + 20, y: barn.y + 20, w: 80, h: 50, c: '#d8b24a' }, { x: barn.x + 20, y: barn.y + 76, w: 80, h: 50, c: '#cfa940' }, // hay bales
        { x: barn.x + 180, y: barn.y + 30, w: 90, h: 50, c: '#b03a2e' }, // the tractor, under cover
        { x: silo.x - silo.r - 6, y: silo.y - silo.r - 6, w: (silo.r + 6) * 2, h: (silo.r + 6) * 2, c: 'rgba(0,0,0,.25)', round: true }, // the silo
        { x: silo.x - silo.r, y: silo.y - silo.r, w: silo.r * 2, h: silo.r * 2, c: '#a9afb5', round: true },
        { x: silo.x - silo.r + 12, y: silo.y - silo.r + 12, w: (silo.r - 12) * 2, h: (silo.r - 12) * 2, c: '#c6ccd2', round: true },
        { x: silo.x - 16, y: silo.y - 16, w: 32, h: 32, c: '#7d838a', round: true },
      ],
      props: [
        // The barn: red board walls, big doors facing the road.
        ...wallLine(true, barn.y, barn.x, barn.x + barn.w, 12).map((r) => ({ ...r, c: red })),
        ...wallLine(false, barn.x, barn.y + 12, barn.y + barn.h, 12).map((r) => ({ ...r, c: red })),
        ...wallLine(false, barn.x + barn.w - 12, barn.y + 12, barn.y + barn.h, 12).map((r) => ({ ...r, c: red })),
        ...wallLine(true, barn.y + barn.h - 12, barn.x, barn.x + barn.w, 12, door(0.5, 90)).map((r) => ({ ...r, c: red })),
        { x: silo.x - 22, y: silo.y - 22, w: 44, h: 44, c: '#7d838a' }, // the silo's solid core
      ],
    });
  },
  mine: (size = { w: 1800, h: 1800 }) => {
    const { w, h } = size;
    // An open pit stepping down in terraces, a headframe and an ore heap by the gate.
    const pit = [0, 1, 2, 3].map((i) => ({ x: 60 + i * 70, y: 60 + i * 60, w: w - 120 - i * 140, h: h - 380 - i * 120, c: ['#6b6258', '#5e564d', '#524b43', '#463f38'][i] }));
    return site({ ...size, label: 'ШАХТА', ground: '#77706a', fence: '#5a5a5a',
      decor: [...pit, { x: 70, y: h - 270, w: 160, h: 120, c: '#3d3833', round: true }], // ore heap
      props: [{ x: w - 320, y: h - 290, w: 90, h: 90, c: '#3a3d42' }], // headframe base
      roofs: [{ x: w - 330, y: h - 300, w: 110, h: 110, c: '#4a4f55', pattern: 'metal', ridge: true }], // the headframe's housing
      work: { x: 90, y: 90, w: w - 180, h: h - 420 },
    });
  },
  oilwell: (size = { w: 800, h: 800 }) => {
    const { w, h } = size;
    // An oil field: six big pumpjacks nodding on concrete pads (drawn by the client from `pumps`), in two
    // columns of three, flow lines to a trunk line and on to the tank farm by the gate, and the foreman
    // at the gate. It pumps on its own; nobody works it.
    const top = 70, bottom = h - 290;
    const cols = [w / 4, (w * 3) / 4].map(Math.round);
    const rows = [1 / 6, 3 / 6, 5 / 6].map((f) => Math.round(top + (bottom - top) * f));
    const pumps = rows.flatMap((y) => cols.map((x) => ({ x, y, angle: 0 })));
    const tanks = [{ x: 50, y: h - 230 }, { x: 160, y: h - 230 }];
    const pipe = '#6b6f73';
    const trunkX = cols[1] + 112 + 26; // just past the right-hand wellheads
    const mainY = h - 262; // across to the tanks
    return site({ ...size, label: 'НЕФТЕВЫШКА', ground: '#5f584c', fence: '#555', hut: false,
      npc: { x: w / 2 + 120, y: h - 56, angle: Math.PI / 2, role: 'market' },
      decor: [
        ...pumps.map((p) => ({ x: p.x - 150, y: p.y - 50, w: 300, h: 100, c: '#8a857a', concrete: true })), // concrete pads
        ...pumps.map((p) => ({ x: p.x + 80, y: p.y - 34, w: 66, h: 66, c: 'rgba(20, 16, 10, .5)', round: true })), // oil stains round the wellheads
        ...rows.map((y) => ({ x: cols[0] + 112, y: y + 40, w: trunkX - cols[0] - 112 + 8, h: 8, c: pipe })), // flow lines from each row
        { x: trunkX, y: rows[0] + 40, w: 8, h: mainY - rows[0] - 40 + 8, c: pipe }, // the trunk line
        { x: 100, y: mainY, w: trunkX - 100 + 8, h: 8, c: pipe }, // …across to the tanks
        ...tanks.map((t) => ({ x: t.x + 41, y: mainY, w: 8, h: t.y - mainY + 4, c: pipe })),
      ],
      props: [
        ...pumps.map((p) => ({ x: p.x - 132, y: p.y - 32, w: 264, h: 64, c: '#3a3d42', pump: true })), // the pumpjack (solid)
        ...tanks.map((t) => ({ x: t.x, y: t.y, w: 90, h: 90, c: '#7f8c8d' })),
      ],
      roofs: tanks.map((t) => ({ x: t.x - 5, y: t.y - 5, w: 100, h: 100, c: '#9aa3a8', round: true, cone: true })), // round tank tops
      work: { x: 0, y: 0, w: 0, h: 0 },
      pumps,
    });
  },
  scrapyard: () => yard({ label: 'МЕТАЛЛОЛОМ', ground: '#5f5a52', fence: '#7a7a7a', props: [
    { x: 40, y: 40, w: 80, h: 60, c: '#6d6d6d' }, { x: 150, y: 50, w: 70, h: 50, c: '#8a5a3a' }, { x: 250, y: 40, w: 70, h: 70, c: '#5a6268' },
  ] }),
  quarry: () => yard({ label: 'КАРЬЕР', ground: '#c9b27a', fence: '#8a7a5a', props: [
    { x: 40, y: 40, w: 60, h: 50, c: '#9a8a6a' }, { x: 260, y: 50, w: 60, h: 40, c: '#8a7a5a' },
  ], decor: [{ x: 110, y: 60, w: 130, h: 110, c: '#b89a5a', round: true }] }),

  // ---- the prison (ИТК): a gulag on the edge of town, filling a country block ----
  // Two barbed-wire fences with a raked "death strip" between them and watchtowers on the corners.
  // Inside: the coal face (west half), barracks and the boiler house with its coal bunker (east), a
  // parade ground, and the gatehouse (КПП) in the south fence, where the warden stands at a counter
  // between the visitors' room (from the road) and the prisoners' side. Against the south fence: the
  // cell block west of the gatehouse (two rows of cells either side of a corridor) and the kitchen
  // east of it. Escape: dig through the concrete section of the inner fence with your pickaxe (unseen by
  // the guards), then open the door in the outer fence with a key lifted off a guard.
  prison: (size = { w: 1800, h: 1800 }) => {
    const { w, h } = size;
    const T = 6, S = 100, gx = Math.round(w / 2);
    const gh = { x: gx - 150, y: h - S - 150, w: 300, h: S + 150 }; // the gatehouse
    const wire = (r) => ({ ...r, wire: true, low: true }); // people can't get through; bullets and eyes can
    const fences = [
      ...wallLine(true, 0, 0, w, T, door(0.85, 60)), // outer, north: the door a guard's key opens
      ...wallLine(false, 0, T, h - T, T),
      ...wallLine(false, w - T, T, h - T, T),
      ...wallLine(true, h - T, 0, gh.x, T),
      ...wallLine(true, h - T, gh.x + gh.w, w, T),
      ...wallLine(true, S, S, w - S, T, door(0.6, 60)), // inner, north: a concrete section you dig through
      ...wallLine(false, S, S + T, h - S, T),
      ...wallLine(false, w - S - T, S + T, h - S, T),
      ...wallLine(true, h - S - T, S, gh.x, T),
      ...wallLine(true, h - S - T, gh.x + gh.w, w - S, T),
    ].map(wire);
    const gates = [h - T - 3, h - S - T - 3].map((y) => ({ x: gx + 200, y, w: 200, h: T + 6, c: '#4d5358', gate: true })); // the truck gates (shut)
    const GT = 14;
    const cy = Math.round(gh.y + gh.h / 2); // the counter across the gatehouse
    const gatehouse = [
      ...wallLine(true, gh.y, gh.x, gh.x + gh.w, GT, door(0.5, 60)), // to the camp
      ...wallLine(true, h - GT, gh.x, gh.x + gh.w, GT, door(0.5, 60), [0, 1]), // to the road (visitors)
      ...wallLine(false, gh.x, gh.y + GT, h - GT, GT),
      ...wallLine(false, gh.x + gh.w - GT, gh.y + GT, h - GT, GT),
      { x: gh.x + GT, y: cy - 8, w: gx - 16 - gh.x - GT, h: 16, c: '#6b4a2e' }, // the counter (the warden stands in the gap)
      { x: gx + 16, y: cy - 8, w: gh.x + gh.w - GT - gx - 16, h: 16, c: '#6b4a2e' },
    ];
    // Watchtowers: the corners of the strip, and halfway down the long sides of a big camp.
    const towers = [[S / 2, S / 2], [w - S / 2, S / 2], [S / 2, h - S / 2], [w - S / 2, h - S / 2], ...(h > 1300 ? [[S / 2, h / 2], [w - S / 2, h / 2]] : [])].map(([x, y]) => ({ x: Math.round(x), y: Math.round(y) }));
    // The cell block: two rows of cells facing each other across a corridor that opens toward the
    // gatehouse, against the south fence west of it.
    const yard = h - S - T; // the inside edge of the south fence
    const CH = 100, BH = 3 * CH; // a cell's depth; the block (cells, corridor, cells)
    const blockTop = yard - BH;
    const cellX1 = gh.x - 20;
    const perRow = Math.max(1, Math.min(Math.ceil(PRISON_CELLS / 2), Math.floor((cellX1 - S - 20) / 115)));
    const cw = Math.min(140, Math.floor((cellX1 - S - 20) / perRow));
    const cellX0 = cellX1 - perRow * cw;
    const concrete = '#7d7a72';
    const cellRows = [{ y: blockTop, doorY: blockTop + CH - 10, ny: 1 }, { y: yard - CH, doorY: yard - CH, ny: -1 }];
    const cells = cellRows.flatMap((r) => Array.from({ length: perRow }, (_, k) => ({ x: cellX0 + k * cw + 10, y: r.y + 10, w: cw - 20, h: CH - 20 })));
    const cellDoors = cellRows.flatMap((r) => Array.from({ length: perRow }, (_, k) => ({ x: cellX0 + (k + 0.5) * cw, y: r.doorY + 5 })));
    const doorsAlong = Array.from({ length: perRow }, (_, k) => ({ at: (k + 0.5) / perRow, width: 60 }));
    const cellWalls = [
      ...wallLine(true, blockTop, cellX0, cellX1, 10), // the top row's back wall
      ...wallLine(true, blockTop + CH - 10, cellX0, cellX1, 10, doorsAlong), // the top row's barred fronts
      ...wallLine(true, yard - CH, cellX0, cellX1, 10, doorsAlong), // the bottom row's
      ...wallLine(false, cellX0, blockTop + CH, yard - CH, 10), // the corridor's blind end
      ...Array.from({ length: perRow + 1 }, (_, k) => [
        ...wallLine(false, Math.min(cellX0 + k * cw, cellX1 - 10), blockTop + 10, blockTop + CH - 10, 10),
        ...wallLine(false, Math.min(cellX0 + k * cw, cellX1 - 10), yard - CH + 10, yard, 10),
      ]).flat(),
    ].map((r) => ({ ...r, c: concrete }));
    // The kitchen: east of the gatehouse, past the truck gates; the cook ladles slop over the counter.
    const kw = 320, kh = 200;
    const kx = Math.min(w - S - 20 - kw, gx + 430), ky = yard - kh;
    const kitchenWalls = [
      ...wallLine(true, ky, kx, kx + kw, 12, door(0.5, 60)), // (inside the wire: not an outside door)
      ...wallLine(true, yard - 12, kx, kx + kw, 12),
      ...wallLine(false, kx, ky + 12, yard - 12, 12),
      ...wallLine(false, kx + kw - 12, ky + 12, yard - 12, 12),
      { x: kx + 40, y: ky + 112, w: kw - 80, h: 16, c: '#8a8f94' }, // the serving counter
    ].map((r) => ({ c: '#8b5a4a', ...r }));
    const cook = { x: kx + kw / 2, y: ky + 150 };
    const serve = { x: kx + kw / 2, y: ky + 80 };
    // East half: barracks (as many as fit) above the boiler house; the coal face fills the west half.
    const ex0 = gx + 60, ex1 = w - S - 110, top = S + 110;
    const boiler = { w: 250, h: 190 };
    const room = blockTop - 90 - top - boiler.h; // above the boiler house, which stays clear of the guards' walk
    const huts = Math.max(0, Math.min(3, Math.floor(room / 220)));
    const hutW = Math.min(560, ex1 - ex0);
    const barracks = Array.from({ length: huts }, (_, i) => ({ x: ex0, y: top + i * 220, w: hutW, h: 160 }));
    boiler.x = ex0;
    boiler.y = top + huts * 220;
    const hopper = { x: boiler.x - 75, y: boiler.y + 45 }; // the coal bunker, by the boiler house's side door
    const mine = { x: S + 50, y: S + 50, w: gx - 70 - (S + 50), h: blockTop - 70 - (S + 50) };
    const parade = { x: gx - 160, y: gh.y - 170, w: 320, h: 140 };
    const wood = '#6e5a44', brick = '#8b4a3a';
    const hutWalls = barracks.flatMap((b) => [
      ...wallLine(true, b.y, b.x, b.x + b.w, 10),
      ...wallLine(true, b.y + b.h - 10, b.x, b.x + b.w, 10, door(0.5, 60)),
      ...wallLine(false, b.x, b.y + 10, b.y + b.h - 10, 10),
      ...wallLine(false, b.x + b.w - 10, b.y + 10, b.y + b.h - 10, 10),
    ].map((r) => ({ ...r, c: wood })));
    const boilerWalls = [
      ...wallLine(true, boiler.y, boiler.x, boiler.x + boiler.w, 12),
      ...wallLine(true, boiler.y + boiler.h - 12, boiler.x, boiler.x + boiler.w, 12),
      ...wallLine(false, boiler.x, boiler.y + 12, boiler.y + boiler.h - 12, 12, door(0.7, 60)),
      ...wallLine(false, boiler.x + boiler.w - 12, boiler.y + 12, boiler.y + boiler.h - 12, 12),
    ].map((r) => ({ ...r, c: brick }));
    const chimney = { x: boiler.x + boiler.w - 75, y: boiler.y + 25, w: 50, h: 50 };
    const terraces = [0, 1, 2].map((i) => ({ x: mine.x + i * 45, y: mine.y + i * 40, w: mine.w - i * 90, h: mine.h - i * 80, c: ['#4d4842', '#3f3b37', '#33302d'][i] }));
    const railY = mine.y + mine.h + 30;
    return {
      w, h,
      walls: [...fences, ...gates, ...gatehouse, ...hutWalls, ...boilerWalls, ...cellWalls, ...kitchenWalls, ...towers.map((t) => ({ x: t.x - 20, y: t.y - 20, w: 40, h: 40, c: '#4a3a2a', tower: true, low: true })), // (the snipers shoot from up top)
        { x: hopper.x - 35, y: hopper.y - 35, w: 70, h: 70, c: '#55514c', bunker: true }],
      decor: [
        { x: 0, y: 0, w, h, c: '#a39579', rake: true }, // the raked death strip
        { x: S, y: S, w: w - 2 * S, h: h - 2 * S, c: '#6a6259' }, // trodden mud inside the wire
        ...terraces,
        { x: mine.x + 20, y: railY - 6, w: hopper.x - 40 - mine.x - 20, h: 14, c: '#3a3530', rail: true }, // a narrow-gauge line from the coal face to the bunker
        { x: mine.x + 60, y: railY - 11, w: 44, h: 24, c: '#5b5f63', cart: true }, { x: mine.x + 120, y: railY - 11, w: 44, h: 24, c: '#5b5f63', cart: true },
        { ...parade, c: '#8a857a', concrete: true },
        { x: gh.x + GT, y: gh.y + GT, w: gh.w - 2 * GT, h: gh.h - 2 * GT, c: '#9a948a' }, // gatehouse floor
        { x: gh.x + GT + 6, y: cy - 3, w: gh.w - 2 * GT - 12, h: 6, c: 'rgba(190, 220, 235, .55)' }, // the glass over the counter
        ...barracks.flatMap((b) => [
          { x: b.x + 10, y: b.y + 10, w: b.w - 20, h: b.h - 20, c: '#7a6a55' },
          ...Array.from({ length: Math.floor((b.w - 40) / 60) }, (_, k) => ({ x: b.x + 22 + k * 60, y: b.y + 18, w: 40, h: 70, c: '#4f4f47' })), // bunks
        ]),
        { x: boiler.x + 12, y: boiler.y + 12, w: boiler.w - 24, h: boiler.h - 24, c: '#5a5652' },
        { x: boiler.x + 40, y: boiler.y + 45, w: 110, h: 100, c: '#2c2c2e', round: true }, // the boiler
        { x: boiler.x + 160, y: boiler.y + 120, w: 60, h: 45, c: '#1f1d1c', round: true }, // coal by the firebox
        { x: cellX0, y: blockTop, w: cellX1 - cellX0, h: BH, c: '#8a877f' }, // the cell block's concrete floor
        ...cells.flatMap((c) => [ // two bunks in each, along the side walls
          { x: c.x + 4, y: c.y + 6, w: 26, h: c.h - 12, c: '#4f4f47' },
          { x: c.x + c.w - 30, y: c.y + 6, w: 26, h: c.h - 12, c: '#4f4f47' },
          { x: c.x + c.w / 2 - 8, y: c.y + (c.y < blockTop + CH ? 4 : c.h - 20), w: 16, h: 16, c: '#b9b6ad', round: true }, // the bucket
        ]),
        { x: kx + 12, y: ky + 12, w: kw - 24, h: kh - 24, c: '#a69f92' }, // the kitchen's tiled floor
        { x: kx + 30, y: yard - 50, w: 90, h: 34, c: '#2f3133' }, { x: kx + kw - 120, y: yard - 50, w: 90, h: 34, c: '#2f3133' }, // the stoves
        { x: kx + 60, y: yard - 48, w: 30, h: 30, c: '#8f949a', round: true }, { x: kx + kw - 90, y: yard - 48, w: 30, h: 30, c: '#8f949a', round: true }, // the slop pots
        { x: kx + 30, y: ky + 30, w: 110, h: 30, c: '#6b4a2e' }, { x: kx + kw - 140, y: ky + 30, w: 110, h: 30, c: '#6b4a2e' }, // tables
      ],
      roofDecor: [{ ...chimney, c: brick, chimney: true }], // (smoke only: the camp has no roof of its own)
      roofs: [
        ...barracks.map((b) => ({ x: b.x - 8, y: b.y - 8, w: b.w + 16, h: b.h + 16, c: '#4a4038', pattern: 'planks', ridge: true })),
        { x: boiler.x - 6, y: boiler.y - 6, w: boiler.w + 12, h: boiler.h + 12, c: '#5d6166', pattern: 'metal', ridge: true },
        { ...chimney, c: '#9b4a3a', round: true },
        { x: gh.x - 6, y: gh.y - 6, w: gh.w + 12, h: gh.h + 12, c: '#5f6a60', pattern: 'metal' },
        { x: cellX0 - 6, y: blockTop - 6, w: cellX1 - cellX0 + 12, h: BH + 6, c: '#5d6166', pattern: 'metal' },
        { x: kx - 6, y: ky - 6, w: kw + 12, h: kh + 6, c: '#6a5048', pattern: 'metal', ridge: true },
        ...towers.map((t) => ({ x: t.x - 34, y: t.y - 34, w: 68, h: 68, c: '#5b4630', pattern: 'planks', tower: true })),
      ],
      npc: { x: gx, y: cy, angle: -Math.PI / 2, role: 'warden' },
      work: { x: mine.x + 30, y: mine.y + 30, w: mine.w - 60, h: mine.h - 60 },
      prison: {
        spawn: { x: gx, y: parade.y + parade.h / 2 },
        release: { x: gx, y: h + 70 }, // out on the road side of the gatehouse
        hopper,
        wallDoor: { x: S + 0.6 * (w - 2 * S), y: S + T / 2 },
        keyDoor: { x: 0.85 * w, y: T / 2 },
        inner: { x: S, y: S, w: w - 2 * S, h: h - 2 * S },
        patrol: [[S + 56, S + 56], [w - S - 56, S + 56], [w - S - 56, blockTop - 45], [S + 56, blockTop - 45]].map(([x, y]) => ({ x, y })),
        cells, // inside each cell (rects)
        cellDoors, // where each cell's door is
        block: { x: cellX0, y: blockTop, w: cellX1 - cellX0, h: BH },
        cook, serve,
        towers,
      },
      floor: '#6a6259', wall: '#7a7a7a', roof: '#6a6259', pattern: 'none', label: 'ИТК-7',
    };
  },

  // ---- police station: patrol cars start here and arrested players are held here ----
  police: () => ({
    w: 380, h: 280,
    walls: [
      ...perimeter(380, 280, 16, { s: door(0.3, 90), e: door(0.5, 70) }),
      { x: 30, y: 30, w: 14, h: 100, c: '#6b7078' }, // cell bars
      { x: 110, y: 30, w: 14, h: 100, c: '#6b7078' },
      { x: 30, y: 130, w: 94, h: 10, c: '#6b7078' },
      { x: 220, y: 120, w: 120, h: 18, c: '#2c3e50' }, // front desk
    ],
    decor: [
      { x: 44, y: 40, w: 66, h: 30, c: '#5a4632' }, // cell bench
      { x: 160, y: 40, w: 180, h: 60, c: '#1f3a5f' }, // briefing room carpet
    ],
    roofDecor: [{ x: 300, y: 30, w: 40, h: 40, c: '#c0392b', round: true }, { x: 300, y: 80, w: 40, h: 40, c: '#2e86de', round: true }],
    npc: { x: 280, y: 100, angle: Math.PI / 2, role: 'police' },
    jail: { x: 77, y: 90 }, // inside the cell
    floor: '#9aa3ad', wall: '#d5d8dc', roof: '#1f3a5f', pattern: 'flat', label: 'МИЛИЦИЯ',
  }),

  // ---- gun store and car dealership ----
  gunstore: () => ({
    w: 280, h: 220,
    walls: [
      ...perimeter(280, 220, 14, { s: door(0.5, 80) }),
      { x: 40, y: 100, w: 200, h: 18, c: '#4a3a2a' }, // counter
      { x: 30, y: 30, w: 220, h: 20, c: '#2a2a2a' }, // gun racks
    ],
    decor: [
      { x: 60, y: 150, w: 160, h: 40, c: '#5a2a2a' }, // target-range mat
    ],
    displays: [{ x: 30, y: 30, w: 220, h: 20, kind: 'rack', show: ['smg', 'shotgun', 'rifle', 'sniper', 'bat'] }], // the guns on the rack behind the counter
    roofDecor: [{ x: 120, y: 90, w: 40, h: 40, c: '#8b0000', round: true }],
    npc: { x: 140, y: 80, angle: Math.PI / 2, role: 'gunshop' },
    floor: '#6b6258', wall: '#3d3d3d', roof: '#2d2d2d', pattern: 'flat', label: 'ОРУЖИЕ',
  }),
  dealership: () => ({
    w: 420, h: 300,
    walls: [
      ...perimeter(420, 300, 12, { s: door(0.35, 160), e: door(0.3, 60) }),
      { x: 300, y: 40, w: 90, h: 18, c: '#c9c9c9' }, // sales desk
    ],
    decor: [
      ...[40, 130, 220].map((x) => ({ x: x - 4, y: 36, w: 68, h: 108, c: '#cfd3d8' })), // a raised plinth for each
      { x: 40, y: 170, w: 240, h: 90, c: '#d8d8d8' }, // polished floor
    ],
    // Three Mercedes 600s in the showroom: just to look at (they're no cars: walk right over them).
    displays: [['#a3161a', 40], ['#15171c', 130], ['#c3c8cf', 220]].map(([color, x]) => ({ x, y: 40, w: 60, h: 100, kind: 'car', car: 'sports', color, angle: Math.PI / 2 })),
    roofDecor: [{ x: 20, y: 20, w: 380, h: 10, c: '#ecf0f1' }],
    npc: { x: 345, y: 80, angle: Math.PI / 2, role: 'dealer' },
    floor: '#e8e8e8', wall: '#aeb6bf', roof: '#5d6d7e', pattern: 'flat', label: 'АВТОСАЛОН',
  }),

  // ---- trade depot: buys and sells every good ----
  market: () => ({
    w: 380, h: 280,
    walls: [
      ...perimeter(380, 280, 14, { s: door(0.3, 110), n: door(0.7, 90) }),
      { x: 140, y: 120, w: 160, h: 18, c: '#8a6d3b' }, // trading counter
    ],
    decor: [
      ...[0, 1, 2, 3].map((i) => ({ x: 30 + i * 85, y: 30, w: 70, h: 50, c: ['#c0392b', '#2980b9', '#27ae60', '#f39c12'][i] })), // stalls
      { x: 30, y: 200, w: 320, h: 40, c: '#7a5a3a' }, // crates
    ],
    // Its goods laid out on the stalls and the crates (to look at: you trade with the man at the counter).
    displays: [
      ...[['bread', 'fish', 'wheat', 'flour'], ['logs', 'planks', 'ore', 'sand'], ['steel', 'glass', 'plastic', 'parts'], ['vodka', 'fuel', 'energy', 'scrap']]
        .map((show, i) => ({ x: 30 + i * 85, y: 30, w: 70, h: 50, kind: 'stall', show })),
      { x: 30, y: 200, w: 320, h: 40, kind: 'crates', show: ['furniture', 'cabinet', 'table', 'chair', 'bed', 'crude', 'guns', 'car'] },
    ],
    roofDecor: [{ x: 170, y: 110, w: 40, h: 40, c: '#e1b12c', round: true }],
    npc: { x: 220, y: 105, angle: Math.PI / 2, role: 'market' },
    floor: '#bfae8f', wall: '#e8dcc0', roof: '#a04000', pattern: 'tiles', label: 'РЫНОК',
  }),

  office: () => ({
    w: 400, h: 320,
    walls: [
      ...perimeter(400, 320, 12, { s: door(0.5, 70), n: door(0.15) }),
      ...wallLine(true, 150, 12, 388, 10, [{ at: 0.2, width: 56 }, { at: 0.5, width: 56 }, { at: 0.8, width: 56 }]),
      ...wallLine(false, 140, 12, 150, 10),
      ...wallLine(false, 260, 12, 150, 10),
    ],
    decor: [
      { x: 30, y: 40, w: 80, h: 40, c: '#5a4632' }, // desks
      { x: 160, y: 40, w: 80, h: 40, c: '#5a4632' },
      { x: 290, y: 40, w: 80, h: 40, c: '#5a4632' },
      { x: 60, y: 210, w: 280, h: 60, c: '#4a3a2a' }, // meeting table
    ],
    roofDecor: [
      { x: 30, y: 30, w: 120, h: 70, c: '#2d4f7c' }, // solar panels
      { x: 170, y: 30, w: 120, h: 70, c: '#2d4f7c' },
      { x: 320, y: 230, w: 50, h: 50, c: '#8a929a' }, // AC unit
    ],
    floor: '#9aa3ad', wall: '#b7c0c9', roof: '#4f5862', pattern: 'flat',
  }),

  // A single garage: buy it and E at the spot inside brings out any of your cars (as at your home's pad).
  garage: () => ({
    w: 260, h: 200,
    walls: [
      ...perimeter(260, 200, 12, { s: door(0.5, 160) }),
      { x: 30, y: 30, w: 70, h: 26, c: '#6b6f75' }, // workbench
    ],
    decor: [
      { x: 152, y: 52, w: 56, h: 108, c: '#4e5156' }, // the bay, worn smooth by tyres
      { x: 60, y: 128, w: 34, h: 30, c: '#3a3a3a', round: true }, // oil stain
    ],
    carSpot: { x: 180, y: 106, angle: Math.PI / 2 }, // where your car's parked, nose to the door
    furnish: furnish([['cabinet', 106, 14, 3], ['cabinet', 20, 70, 2]]),
    roofDecor: [],
    floor: '#5a5d61', wall: '#9b8f7e', roof: '#6a6f75', pattern: 'metal',
  }),
};

/** Rotate a local rect (and its nx/ny direction, if any) by quarter turns inside a w×h box, then move it to (ox, oy). */
function place(r, rot, w, h, ox, oy) {
  let { x, y, w: rw, h: rh, nx, ny } = r;
  for (let i = 0; i < rot; i++) {
    // 90° clockwise inside a box whose size alternates each turn.
    const boxH = i % 2 === 0 ? h : w;
    [x, y, rw, rh] = [boxH - y - rh, x, rh, rw];
    if (nx !== undefined) [nx, ny] = [-ny, nx];
  }
  const out = { ...r, x: x + ox, y: y + oy, w: rw, h: rh };
  if (nx !== undefined) Object.assign(out, { nx, ny });
  return out;
}

/**
 * One building of `type` with its top-left corner at (x, y), turned `rot` quarter turns clockwise.
 * Used by the generator, saved maps and the map editor alike.
 */
export function buildBuilding(type, x, y, rot, id, size = null) {
  doorways = [];
  const layout = size ? BUILDING_TYPES[type](size) : BUILDING_TYPES[type]();
  layout.doors = doorways;
  const w = rot % 2 ? layout.h : layout.w;
  const h = rot % 2 ? layout.w : layout.h;
  const move = (r) => place(r, rot, layout.w, layout.h, x, y);
  // The shopkeeper is solid (an invisible wall) so nobody walks through them.
  let npc = null;
  const walls = layout.walls.map(move);
  if (layout.npc) {
    const at = move({ x: layout.npc.x, y: layout.npc.y, w: 0, h: 0 });
    npc = { x: at.x, y: at.y, angle: layout.npc.angle + (rot * Math.PI) / 2, role: layout.npc.role ?? 'shop' };
    walls.push({ x: at.x - 14, y: at.y - 14, w: 28, h: 28, npc: true });
  }
  return {
    id,
    type,
    rot,
    jail: layout.jail ? (({ x: jx, y: jy }) => ({ x: jx, y: jy }))(move({ x: layout.jail.x, y: layout.jail.y, w: 0, h: 0 })) : null,
    x, y, w, h,
    walls,
    npc,
    decor: layout.decor.map(move),
    roofDecor: layout.roofDecor.map(move),
    doors: layout.doors.map(move),
    floor: layout.floor,
    wall: layout.wall,
    roof: layout.roof,
    pattern: layout.pattern,
    label: layout.label ?? null,
    grid: layout.grid ? move(layout.grid) : null,
    work: layout.work ? move(layout.work) : null, // work sites: where the rocks / trees / wheat are
    roofs: (layout.roofs ?? []).map(move), // separate roofs over buildings inside an open-air site
    rooms: layout.rooms ? layout.rooms.map(move) : null, // rooms to rent (panelka flats, garage boxes)
    carSpot: layout.carSpot ? { ...(({ x: cx, y: cy }) => ({ x: cx, y: cy }))(move({ x: layout.carSpot.x, y: layout.carSpot.y, w: 0, h: 0 })), angle: layout.carSpot.angle + (rot * Math.PI) / 2 } : null, // a garage's parking spot
    // What a shop shows on its shelves (and the showroom cars): drawn only, nothing to touch or bump into.
    displays: (layout.displays ?? []).map((d) => ({ ...move(d), ...(d.angle !== undefined ? { angle: d.angle + (rot * Math.PI) / 2 } : {}) })),
    furnish: layout.furnish ?? null, // the furniture it comes with, in layout coordinates (see Furnishings.loadIn)
    size: size ? { w: layout.w, h: layout.h } : null, // work sites are sized to their block
    docks: layout.docks ? { in: move(layout.docks.in), out: move(layout.docks.out) } : null,
    // The prison: its spots (points) and the inside of the inner fence (a rect), placed like the rest.
    ...(layout.prison ? { prison: prisonSpots(layout.prison, move) } : {}),
    // Named spots (the governor's residence: where everyone stands), turned with the building.
    ...(layout.spots ? { spots: turnSpots(layout.spots, move, rot) } : {}),
    // Oil field pumpjacks: where each stands and which way its beam points.
    ...(layout.pumps ? { pumps: layout.pumps.map((p) => { const at = move({ x: p.x, y: p.y, w: 0, h: 0 }); return { x: at.x, y: at.y, angle: p.angle + (rot * Math.PI) / 2 }; }) } : {}),
  };
}

function turnSpots(spots, move, rot) {
  const at = (e) => {
    if (e.w !== undefined) return (({ x, y, w, h }) => ({ x, y, w, h }))(move(e)); // (a rect)
    const r = move({ x: e.x, y: e.y, w: 0, h: 0 });
    return e.angle === undefined ? { x: r.x, y: r.y } : { x: r.x, y: r.y, angle: e.angle + (rot * Math.PI) / 2 };
  };
  return Object.fromEntries(Object.entries(spots).map(([k, v]) => [k, Array.isArray(v) ? v.map(at) : at(v)]));
}

function prisonSpots(spots, move) {
  const at = ({ x, y }) => { const r = move({ x, y, w: 0, h: 0 }); return { x: r.x, y: r.y }; };
  const out = {};
  const rect = (v) => (({ x, y, w, h }) => ({ x, y, w, h }))(move(v));
  for (const [k, v] of Object.entries(spots)) out[k] = Array.isArray(v) ? v.map((e) => (e.w !== undefined ? rect(e) : at(e))) : v.w !== undefined ? rect(v) : at(v);
  return out;
}

/** Spots for an ATM just outside each of a building's outside doors, on either side of the doorway. */
export function atmSpotsFor(building) {
  const spots = [];
  for (const d of building.doors.filter((x) => x.exterior)) {
    const horizontal = d.w > d.h;
    const along = (horizontal ? d.w : d.h) / 2 + 40;
    for (const side of [1, -1]) {
      spots.push({
        x: Math.round(d.x + d.w / 2 + d.nx * 40 + (horizontal ? along * side : 0)),
        y: Math.round(d.y + d.h / 2 + d.ny * 40 + (horizontal ? 0 : along * side)),
        angle: Math.atan2(d.ny, d.nx), // screen faces out, away from the building
      });
    }
  }
  return spots;
}

/** Footprint size of a type after `rot` quarter turns. */
export function buildingSize(type, rot, size = null) {
  const { w, h } = size ? BUILDING_TYPES[type](size) : BUILDING_TYPES[type]();
  return rot % 2 ? { w: h, h: w } : { w, h };
}

/**
 * Scatter `count` non-overlapping buildings over the map, staying clear of `avoid` rects. Types in
 * `fixed` ({ type: n }) get exactly n each (placed first); the rest cycle through every other type.
 */
export function generateBuildings(width, height, count, gap = 120, avoid = [], avoidGap = 40, isBadSpot = () => false, fixed = {}, remote = new Set(), remoteGap = 700) {
  const others = Object.keys(BUILDING_TYPES).filter((t) => !(t in fixed) && t !== 'station'); // the station goes by the railway
  const order = Object.entries(fixed).flatMap(([t, n]) => Array(n).fill(t));
  for (let i = 0; order.length < count; i++) order.push(others[i % others.length]);
  const placed = [];
  for (const type of order.slice(0, Math.max(count, 0))) {
    const rot = Math.floor(Math.random() * 4);
    const { w, h } = buildingSize(type, rot);
    for (let attempt = 0; attempt < 200; attempt++) {
      const x = Math.round(randRange(150, width - 150 - w));
      const y = Math.round(randRange(150, height - 150 - h));
      const apart = (b, g) => x + w + g < b.x || b.x + b.w + g < x || y + h + g < b.y || b.y + b.h + g < y;
      // Remote types (shacks) keep well away from roads too.
      const clear = placed.every((b) => apart(b, gap)) && avoid.every((r) => apart(r, remote.has(type) ? remoteGap : avoidGap));
      if (!clear || isBadSpot({ x, y, w, h })) continue;
      placed.push(buildBuilding(type, x, y, rot, placed.length + 1));
      break;
    }
  }
  return placed;
}
