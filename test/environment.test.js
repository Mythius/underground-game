import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config } from '../src/config.js';
import { Environment } from '../src/game/Environment.js';

const opts = config.environment;

test('20 minutes of day, then 5 of night, repeating', () => {
  const env = new Environment({ ...opts, startSec: 0 });
  assert.equal(env.isNight, false);
  env.step(opts.daySec - 1);
  assert.equal(env.isNight, false);
  env.step(2);
  assert.equal(env.isNight, true);
  env.step(opts.nightSec);
  assert.equal(env.isNight, false, 'morning again');
  assert.ok(env.clock < 5);
});

test('rain and fog each happen 0–2 times per week and fade in and out', () => {
  // A seeded generator so the test is repeatable.
  let seed = 7;
  const rng = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const env = new Environment({ ...opts, startSec: 0 }, rng);
  const week = (opts.daySec + opts.nightSec) * 7;
  const counts = [];
  for (let w = 0; w < 20; w++) {
    const inWeek = (kind) => env.events.filter((e) => e.kind === kind && e.start >= w * week && e.start < (w + 1) * week).length;
    // Events for week w are planned by the time week w starts.
    while (env.time < w * week) env.step(600);
    counts.push(inWeek('rain'), inWeek('fog'));
  }
  assert.ok(counts.every((n) => n >= 0 && n <= opts.maxPerWeek));
  assert.ok(counts.some((n) => n > 0), 'some weather happens');

  // A lone shower fades in over weatherFadeSec, holds at full strength, then fades out.
  env.events = [{ kind: 'rain', start: env.time + 10, end: env.time + 10 + 600 }];
  env.step(10 + opts.weatherFadeSec / 2);
  assert.ok(Math.abs(env.intensity('rain') - 0.5) < 0.01, 'half-way through fading in');
  env.step(opts.weatherFadeSec);
  assert.equal(env.intensity('rain'), 1);
  env.step(600 - opts.weatherFadeSec * 2);
  assert.ok(env.intensity('rain') < 1, 'fading out');
  assert.equal(env.intensity('fog'), 0);
});

test('seasons change every 40 minutes, starting in winter', async () => {
  const { Environment } = await import('../src/game/Environment.js');
  const { config } = await import('../src/config.js');
  const env = new Environment({ ...config.environment, startSec: 0 });
  assert.equal(env.state().season, 'winter');
  env.step(40 * 60 + 1);
  assert.equal(env.state().season, 'spring');
  env.step(80 * 60);
  assert.equal(env.state().season, 'autumn');
  env.step(40 * 60);
  assert.equal(env.state().season, 'winter');
});
