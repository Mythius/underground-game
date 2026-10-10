import { randRange } from '../utils/math.js';

// Signs (labels) are in Russian: the game is set in 1990s post-Soviet Russia.
// Buildings are made of axis-aligned rectangles so collision stays cheap and identical on the client.
// Each type is laid out in local coordinates (0..w, 0..h) and then rotated/placed on the map.
//   walls:     solid rectangles (block players and bullets); `c` overrides the wall colour
//   decor:     floor-level furniture, drawn only (no collision)
//   roofDecor: drawn on top of the roof (chimneys, vents, crosses…)
//   doors:     every doorway gap, with the outward direction for outside doors
//   npc:       where a shopkeeper stands (centre and facing), for buildings that sell food

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
export const WORK_SITES = { mine: 'pickaxe', logging: 'axe', farm: 'scythe', oilwell: null };

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

export const BUILDING_TYPES = {
  house: () => ({
    w: 260, h: 220,
    walls: [...perimeter(260, 220, 12, { s: door(0.3) }), ...wallLine(false, 160, 12, 208, 10, door(0.5, 56))],
    decor: [
      { x: 180, y: 30, w: 60, h: 80, c: '#b9c4d6' }, // bed
      { x: 180, y: 30, w: 60, h: 18, c: '#e8e8e8' }, // pillow
      { x: 40, y: 50, w: 70, h: 50, c: '#6b4a2b' }, // table
      { x: 30, y: 150, w: 90, h: 30, c: '#7a2e2e' }, // sofa
    ],
    roofDecor: [{ x: 190, y: 40, w: 26, h: 26, c: '#6e2a20' }],
    floor: '#8a6a4a', wall: '#d8cbb0', roof: '#4f6b4a', pattern: 'metal', // green-painted tin roof
  }),

  // Five-storey prefab apartment block (khrushchyovka): three stairwell entrances (podezds) on one side.
  panelka: () => ({
    w: 600, h: 220,
    walls: [
      ...perimeter(600, 220, 14, { s: [{ at: 1 / 6, width: 56 }, { at: 0.5, width: 56 }, { at: 5 / 6, width: 56 }] }),
      ...wallLine(false, 200, 14, 206, 10, door(0.7, 56)),
      ...wallLine(false, 400, 14, 206, 10, door(0.7, 56)),
    ],
    decor: [
      ...[0, 1, 2].flatMap((i) => [
        { x: 60 + i * 200, y: 120, w: 80, h: 70, c: '#7d7f82' }, // stairwell
        { x: 30 + i * 200, y: 30, w: 70, h: 60, c: '#7a2e2e' }, // carpet on the wall… and the floor
        { x: 120 + i * 200, y: 30, w: 60, h: 40, c: '#5a4632' }, // sideboard
      ]),
    ],
    roofDecor: [
      ...[0, 1, 2].map((i) => ({ x: 80 + i * 200, y: 90, w: 40, h: 40, c: '#6b6e72' })), // stairwell hatches
      { x: 160, y: 30, w: 6, h: 60, c: '#3a3a3a' }, // TV aerials
      { x: 430, y: 40, w: 6, h: 50, c: '#3a3a3a' },
    ],
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
      { x: 20, y: 20, w: 70, h: 100, c: '#c8b560' }, // a Lada
      { x: 240, y: 30, w: 60, h: 40, c: '#5a4a3a' }, // junk
      { x: 350, y: 25, w: 50, h: 50, c: '#3a3a3a', round: true }, // tyres
      { x: 460, y: 20, w: 70, h: 100, c: '#8a2a2a' },
    ],
    roofDecor: [],
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

  cabin: () => ({
    w: 180, h: 160,
    walls: perimeter(180, 160, 14, { e: door(0.5, 56) }),
    decor: [
      { x: 24, y: 24, w: 50, h: 70, c: '#5e7a4a' },
      { x: 100, y: 100, w: 40, h: 30, c: '#4a3020' },
      { x: 24, y: 120, w: 22, h: 22, c: '#2a2a2a', round: true }, // stove
    ],
    roofDecor: [{ x: 30, y: 30, w: 20, h: 20, c: '#3a3a3a' }],
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

  mansion: () => ({
    w: 520, h: 420,
    walls: [
      ...perimeter(520, 420, 14, { s: door(0.5, 80), n: door(0.8) }),
      ...wallLine(false, 250, 14, 406, 12, [{ at: 0.25, width: 60 }, { at: 0.8, width: 60 }]),
      ...wallLine(true, 200, 14, 250, 12, door(0.5)),
      ...wallLine(true, 200, 262, 506, 12, door(0.3)),
    ],
    decor: [
      { x: 40, y: 40, w: 90, h: 110, c: '#4a5d8a' }, // bed
      { x: 300, y: 40, w: 160, h: 70, c: '#5a3a24' }, // dining table
      { x: 40, y: 260, w: 140, h: 40, c: '#7a2e2e' }, // sofa
      { x: 320, y: 280, w: 120, h: 80, c: '#3f6b4a' }, // pool table
      { x: 262, y: 214, w: 244, h: 14, c: '#8b2232' }, // rug
    ],
    roofDecor: [
      { x: 60, y: 60, w: 26, h: 26, c: '#2a2a33' },
      { x: 430, y: 330, w: 26, h: 26, c: '#2a2a33' },
    ],
    floor: '#7d5a3c', wall: '#efe6d2', roof: '#3b3b46', pattern: 'shingle',
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
        { x: 60, y: h - 230, w: 140, h: 120, c: '#4f3a26' }, // a muddy yard by the gate
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
      ...[0, 1, 2, 3, 4].map((i) => ({ x: 44 + i * 42, y: 34, w: 30, h: 12, c: '#6b7078' })),
      { x: 60, y: 150, w: 160, h: 40, c: '#5a2a2a' }, // target-range mat
    ],
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
      { x: 40, y: 40, w: 60, h: 100, c: '#c0392b' }, // showroom cars
      { x: 130, y: 40, w: 60, h: 100, c: '#2e86de' },
      { x: 220, y: 40, w: 60, h: 100, c: '#f1c40f' },
      { x: 40, y: 170, w: 240, h: 90, c: '#d8d8d8' }, // polished floor
    ],
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

  garage: () => ({
    w: 260, h: 200,
    walls: [
      ...perimeter(260, 200, 12, { s: door(0.5, 160) }),
      { x: 30, y: 30, w: 70, h: 26, c: '#6b6f75' }, // workbench
    ],
    decor: [
      { x: 140, y: 40, w: 80, h: 130, c: '#2f5b8a' }, // car
      { x: 150, y: 70, w: 60, h: 50, c: '#9fc2e0' },
      { x: 40, y: 100, w: 40, h: 40, c: '#3a3a3a', round: true }, // oil stain
    ],
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
    size: size ? { w: layout.w, h: layout.h } : null, // work sites are sized to their block
    docks: layout.docks ? { in: move(layout.docks.in), out: move(layout.docks.out) } : null,
    // Oil field pumpjacks: where each stands and which way its beam points.
    ...(layout.pumps ? { pumps: layout.pumps.map((p) => { const at = move({ x: p.x, y: p.y, w: 0, h: 0 }); return { x: at.x, y: at.y, angle: p.angle + (rot * Math.PI) / 2 }; }) } : {}),
  };
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
