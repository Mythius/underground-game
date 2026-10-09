import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/config.js';
import { World } from '../src/game/World.js';
import { loadSavedMap, saveMap, validateMap } from '../src/game/mapFile.js';

const opts = { ...config.world, foodCount: 0, pickupStart: 0 };

test('a generated world exports a map that rebuilds the same scenery', () => {
  const original = new World(opts);
  const { map, error } = validateMap(JSON.parse(JSON.stringify(original.toMap())));
  assert.equal(error, undefined);
  const copy = new World(opts, config.player, config.weapons, map);
  assert.equal(copy.buildings.length, original.buildings.length);
  assert.deepEqual(copy.buildings.map((b) => [b.type, b.x, b.y, b.w, b.h]), original.buildings.map((b) => [b.type, b.x, b.y, b.w, b.h]));
  assert.equal(copy.trees.length, original.trees.length);
  assert.equal(copy.roads.length, original.roads.length);
  assert.equal(copy.lamps.length, original.lamps.length);
  const parked = (w) => [...w.vehicles.values()].filter((v) => !v.roadblock).length; // checkpoints are placed at random each time
  assert.equal(parked(copy), parked(original));
  assert.equal(copy.doors.length, original.doors.length);
});

test('hand-made maps: rotated buildings, standalone shopkeepers that are solid, parked cars', () => {
  const { map, error } = validateMap({
    width: 3000,
    height: 3000,
    roads: [{ x: 0, y: 1000, w: 3000, h: 270 }],
    buildings: [{ type: 'house', x: 400, y: 300, rot: 1 }],
    npcs: [{ x: 1500, y: 600, angle: 0 }],
    vehicles: [{ type: 'truck', x: 1500, y: 1100, angle: 0 }],
    trees: [{ x: 2200, y: 2200, canopy: 60 }],
  });
  assert.equal(error, undefined);
  const world = new World(opts, config.player, config.weapons, map);
  assert.equal(world.width, 3000);
  const house = world.buildings[0];
  assert.deepEqual([house.w, house.h], [220, 260], 'turned a quarter: width and height swap');
  assert.ok(world.shopkeepers.some((s) => s.x === 1500 && s.y === 600));
  assert.ok(world.isBlocked(1500, 600, 5), 'the shopkeeper is solid');
  assert.equal([...world.vehicles.values()][0].type, 'truck');
  assert.ok(world.isBlocked(2200, 2200, 5), 'tree trunk is solid');
});

test('bad maps are rejected with a reason', () => {
  assert.match(validateMap(null).error, /object/);
  assert.match(validateMap({ width: 100, height: 3000 }).error, /width/);
  assert.match(validateMap({ width: 3000, height: 3000, buildings: [{ type: 'castle', x: 1, y: 1 }] }).error, /castle/);
  assert.match(validateMap({ width: 3000, height: 3000, trees: [{ x: 'a', y: 1 }] }).error, /tree x/);
  assert.match(validateMap({ width: 3000, height: 3000, lamps: Array(4000).fill({ x: 1, y: 1 }) }).error, /too many lamps/);
});

test('maps save and load from disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ug-map-'));
  try {
    const path = join(dir, 'nested', 'map.json');
    assert.equal(loadSavedMap(path), null);
    const { map } = validateMap({ width: 3000, height: 3000, lamps: [{ x: 5, y: 6 }] });
    saveMap(map, path);
    assert.deepEqual(loadSavedMap(path), map);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('maps keep hand-drawn dirt paths and can be any size', () => {
  const { map, error } = validateMap({ width: 5000, height: 3000, trails: [{ points: [[10, 10], [400, 300], [800, 320]], width: 40 }, { points: [[1, 1]], width: 40 }] });
  assert.equal(error, undefined);
  assert.equal(map.trails.length, 1, 'single-point trails are dropped');
  const world = new World(opts, config.player, config.weapons, map);
  assert.deepEqual([world.width, world.height], [5000, 3000]);
  assert.deepEqual(world.toMap().trails, map.trails);
  assert.match(validateMap({ width: 3000, height: 3000, trails: [{ points: [[0, 0], [9000, 0]], width: 40 }] }).error, /trail x/);
});
