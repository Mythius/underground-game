import { config } from '../config.js';

/**
 * Time of day and weather for a room. Pure state advanced by step(dt); knows nothing about sockets.
 * A "week" is seven day/night cycles; each week rain and fog are each scheduled 0–2 times.
 * Seasons run on their own clock (every `seasonSec`), starting with the first in the list.
 */
export class Environment {
  constructor(opts = config.environment, rng = Math.random) {
    this.opts = opts;
    this.rng = rng;
    this.cycle = opts.daySec + opts.nightSec;
    this.week = this.cycle * 7;
    this.time = opts.startSec; // seconds since the room opened, in game time
    this.events = []; // { kind: 'rain' | 'fog', start, end }
    this.scheduledThrough = -1; // last week index with weather planned
    this.#planAhead();
  }

  /** Plan weather for this week and the next, so an event can start right as a week begins. */
  #planAhead() {
    const current = Math.floor(this.time / this.week);
    while (this.scheduledThrough < current + 1) {
      const w = ++this.scheduledThrough;
      for (const [kind, { minSec, maxSec }] of Object.entries(this.opts.weather)) {
        const count = Math.floor(this.rng() * (this.opts.maxPerWeek + 1)); // 0, 1 or 2
        for (let i = 0; i < count; i++) {
          const duration = minSec + this.rng() * (maxSec - minSec);
          const start = w * this.week + this.rng() * (this.week - duration);
          this.events.push({ kind, start, end: start + duration });
        }
      }
    }
  }

  step(dt) {
    this.time += dt;
    this.#planAhead();
    this.events = this.events.filter((e) => e.end > this.time);
  }

  /** Seconds into the current day/night cycle; night is the last `nightSec` of it. */
  get clock() {
    return this.time % this.cycle;
  }

  /** The current season's name, and seconds into it. */
  get season() {
    const { seasons, seasonSec } = this.opts;
    return { name: seasons[Math.floor(this.time / seasonSec) % seasons.length], sec: this.time % seasonSec };
  }

  get isNight() {
    return this.clock >= this.opts.daySec;
  }

  /** 0..1 strength of rain or fog right now, easing in and out over `fadeSec`. */
  intensity(kind) {
    const fade = this.opts.weatherFadeSec;
    let best = 0;
    for (const e of this.events) {
      if (e.kind !== kind || this.time < e.start || this.time > e.end) continue;
      best = Math.max(best, Math.min(1, (this.time - e.start) / fade, (e.end - this.time) / fade));
    }
    return best;
  }

  /** What clients need to draw the sky. */
  state() {
    return {
      clock: Math.round(this.clock * 10) / 10,
      daySec: this.opts.daySec,
      nightSec: this.opts.nightSec,
      rain: Math.round(this.intensity('rain') * 100) / 100,
      fog: Math.round(this.intensity('fog') * 100) / 100,
      season: this.season.name,
      seasonSec: Math.round(this.season.sec),
      seasonLength: this.opts.seasonSec,
      seasonBlend: this.opts.seasonBlendSec,
      seasons: this.opts.seasons,
    };
  }
}
