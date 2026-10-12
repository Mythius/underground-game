import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AUDIO_TYPES } from './sounds.js';

// The car radio's playlist: as many songs as you like, uploaded in the sound editor (admin password).
// Files live in data/radio/ with a playlist.json listing them in order: { id, name, file, duration, volume }.
// A car's radio plays one song over and over until someone skips (N); clients stream the files
// (they can be long) and everyone near the car hears the same point in the same song.

export const RADIO_DIR = fileURLToPath(new URL('../data/radio/', import.meta.url));
// The background music playlist is the same kind of store, in data/music/, served under /music.
export const MUSIC_DIR = fileURLToPath(new URL('../data/music/', import.meta.url));
// …and the prison camp's music (played instead while you're locked up), in data/prison-music/, under /prison.
export const PRISON_MUSIC_DIR = fileURLToPath(new URL('../data/prison-music/', import.meta.url));
// …and the action music: in a fight (data/fight-music/, /fight) and in a car chase with the Militsiya (data/chase-music/, /chase).
export const FIGHT_MUSIC_DIR = fileURLToPath(new URL('../data/fight-music/', import.meta.url));
export const CHASE_MUSIC_DIR = fileURLToPath(new URL('../data/chase-music/', import.meta.url));
const FALLBACK_SEC = 180; // a song whose length couldn't be measured is taken to be this long
const NAME_MAX = 80;

/** How long an audio file is, in seconds (ffprobe), or null if it can't tell. */
function probe(path) {
  return new Promise((resolve) => {
    execFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path], { timeout: 15000 }, (err, out) => {
      const sec = Number.parseFloat(String(out ?? '').trim());
      resolve(!err && Number.isFinite(sec) && sec > 0 ? Math.round(sec * 100) / 100 : null);
    });
  });
}

const cleanName = (name) => String(name ?? '').replace(/[\p{C}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX) || 'Untitled';

/**
 * Which song a radio that started song number `song` `elapsed` seconds ago is playing, and how far in:
 * { index, offset }. It repeats that song until someone presses N. Keep in sync with radioAt() in public/index.html.
 */
export function radioAt(song, elapsed, durations) {
  const n = durations.length;
  if (!n) return { index: song, offset: elapsed }; // (no playlist yet: the song number stands)
  const index = ((song % n) + n) % n;
  const d = durations[index] > 0 ? durations[index] : 1;
  return { index, offset: ((elapsed % d) + d) % d };
}

export class RadioStore {
  constructor(dir = RADIO_DIR, route = 'radio') {
    this.dir = dir;
    this.route = route; // its files are streamed from /<route>/file/…
    mkdirSync(dir, { recursive: true });
    try {
      this.songs = JSON.parse(readFileSync(`${dir}playlist.json`, 'utf8'));
    } catch {
      this.songs = [];
    }
  }

  #save() {
    writeFileSync(`${this.dir}playlist.json.tmp`, JSON.stringify(this.songs, null, 2));
    renameSync(`${this.dir}playlist.json.tmp`, `${this.dir}playlist.json`);
  }

  /** What clients need: the playlist in order, with where to stream each song from. */
  list() {
    return this.songs.map((s) => ({ id: s.id, name: s.name, url: `/${this.route}/file/${s.file}`, duration: s.duration ?? FALLBACK_SEC, volume: s.volume ?? 1 }));
  }

  /** Every song's length, in playlist order (for working out what a radio is playing). */
  durations() {
    return this.songs.map((s) => s.duration ?? FALLBACK_SEC);
  }

  /** Add an uploaded song to the end of the playlist. Returns an error string, or null. */
  async add(name, contentType, data) {
    const ext = AUDIO_TYPES[(contentType ?? '').split(';')[0].trim().toLowerCase()];
    if (!ext) return 'not an audio file (mp3, ogg, wav, m4a, webm or flac)';
    if (!data?.length) return 'empty file';
    const id = randomBytes(6).toString('hex');
    const file = `${id}.${ext}`;
    writeFileSync(`${this.dir}${file}`, data);
    const duration = await probe(`${this.dir}${file}`);
    this.songs.push({ id, name: cleanName(name), file, duration, volume: 1 });
    this.#save();
    return null;
  }

  /** Bring in a file already on disk (the old fixed radio slots). */
  async import(path, name) {
    const ext = path.split('.').pop().toLowerCase();
    const id = randomBytes(6).toString('hex');
    const file = `${id}.${ext}`;
    copyFileSync(path, `${this.dir}${file}`);
    this.songs.push({ id, name: cleanName(name), file, duration: await probe(`${this.dir}${file}`), volume: 1 });
    this.#save();
  }

  /** Rename, set the volume of, or move (to position `to`) a song. */
  update(id, { name, volume, to } = {}) {
    const i = this.songs.findIndex((s) => s.id === id);
    if (i < 0) return 'unknown song';
    const s = this.songs[i];
    if (name !== undefined) s.name = cleanName(name);
    if (volume !== undefined) {
      if (!(typeof volume === 'number' && volume >= 0 && volume <= 2)) return 'volume must be 0–2';
      s.volume = volume;
    }
    if (to !== undefined) {
      if (!Number.isInteger(to)) return 'bad position';
      this.songs.splice(i, 1);
      this.songs.splice(Math.max(0, Math.min(this.songs.length, to)), 0, s);
    }
    this.#save();
    return null;
  }

  remove(id) {
    const i = this.songs.findIndex((s) => s.id === id);
    if (i < 0) return 'unknown song';
    const [s] = this.songs.splice(i, 1);
    try { unlinkSync(`${this.dir}${s.file}`); } catch {}
    this.#save();
    return null;
  }

  /** A song file to stream: { path, size, type }, or null. */
  file(name) {
    if (!/^[a-f0-9]{12}\.[a-z0-9]+$/.test(name) || !this.songs.some((s) => s.file === name)) return null;
    const ext = name.split('.').pop();
    const type = Object.entries(AUDIO_TYPES).find(([, e]) => e === ext)?.[0] ?? 'application/octet-stream';
    try {
      return { path: `${this.dir}${name}`, size: statSync(`${this.dir}${name}`).size, type };
    } catch {
      return null;
    }
  }
}
