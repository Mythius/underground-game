import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

// Custom sound effects and music, uploaded from the sound editor (admin password).
// Every slot has a built-in synthesised default in the client; an uploaded file replaces it.
// Files live in data/sounds/, with manifest.json recording which slots are custom and their volume.

export const SOUNDS_DIR = fileURLToPath(new URL('../data/sounds/', import.meta.url));

/** Every sound in the game. loop: plays continuously (its volume follows the game: speed, rain…). */
export const SOUND_SLOTS = [
  { group: 'Music & ambience', slots: [
    { id: 'rain', name: 'Rain', loop: true, note: 'Louder the harder it rains (spring–autumn).' },
    { id: 'wind', name: 'Winter wind', loop: true, note: 'Plays in winter, louder while it snows. No default.' },
    { id: 'night', name: 'Night ambience', loop: true, note: 'Crickets / night noises after dark. No default.' },
  ] },
  { group: 'Guns', slots: [
    { id: 'pistol', name: 'Pistol shot' },
    { id: 'smg', name: 'SMG shot' },
    { id: 'rifle', name: 'Rifle shot' },
    { id: 'shotgun', name: 'Shotgun blast' },
    { id: 'sniper', name: 'Sniper shot' },
    { id: 'reload', name: 'Reload' },
  ] },
  { group: 'Combat', slots: [
    { id: 'hurt', name: 'You get hurt' },
    { id: 'hit', name: 'Someone else gets hit' },
    { id: 'death', name: 'Death' },
    { id: 'explosion', name: 'Vehicle explosion' },
    { id: 'bat', name: 'Swinging a baseball bat' },
    { id: 'batHit', name: 'A bat smashing into an ATM' },
  ] },
  { group: 'Vehicles', slots: [
    { id: 'engine', name: 'Engine', loop: true, note: 'Pitch rises with speed. Used for any car without its own engine sound below.' },
    // Each kind of car can have its own engine (falling back to the one above).
    ...Object.entries(config.vehicles.types).map(([type, t]) => ({ id: `engine${type[0].toUpperCase()}${type.slice(1)}`, name: `Engine — ${t.name}`, loop: true, note: `Your engine while driving a ${t.name}.` })),
    { id: 'skid', name: 'Tyre skid', loop: true, note: 'While sliding or drifting.' },
    { id: 'siren', name: 'Militsiya siren', loop: true, note: 'Louder the closer a car with its siren on.' },
    { id: 'carDoor', name: 'Get in / out of a car' },
    { id: 'crash', name: 'Crashing your car into something' },
    { id: 'backfire', name: 'Exhaust backfire', note: 'Pops on a gear change or lifting off at high revs.' },
    { id: 'boost', name: 'Vodka boost (fire from the exhaust)', loop: true, note: 'While a car near you burns its boost (Space).' },
    { id: 'pour', name: 'Pour fuel or vodka into a car' },
  ] },
  { group: 'Player', slots: [
    { id: 'footstep', name: 'Footstep' },
    { id: 'snowStep', name: 'Footstep in snow' },
    { id: 'swim', name: 'Swimming stroke' },
    { id: 'pickup', name: 'Pick something up' },
    { id: 'drop', name: 'Drop an item' },
    { id: 'eat', name: 'Eating' },
    { id: 'drink', name: 'Drinking vodka' },
    { id: 'furnish', name: 'Put down a cabinet, bed or sofa' },
    { id: 'cabinet', name: 'Open a cabinet' },
  ] },
  { group: 'Work', slots: [
    { id: 'pick', name: 'Pickaxe on rock' },
    { id: 'chop', name: 'Axe on a tree' },
    { id: 'harvest', name: 'Scything wheat' },
    { id: 'cast', name: 'Casting a fishing line' },
    { id: 'splash', name: 'A fish splashing on the line' },
    { id: 'reel', name: 'Reeling in' },
    { id: 'catch', name: 'Landing a catch' },
    { id: 'hooked', name: 'Hooking a player (or being hooked)' },
    { id: 'grab', name: 'Take an item off a conveyor belt' },
  ] },
  { group: 'Town & money', slots: [
    { id: 'doorOpen', name: 'Door opens' },
    { id: 'doorClose', name: 'Door closes' },
    { id: 'coin', name: 'Money / buying' },
    { id: 'build', name: 'Place a machine or belt' },
    { id: 'chat', name: 'Chat message' },
    { id: 'error', name: "Can't do that (error)" },
  ] },
  { group: 'Animals', slots: [
    { id: 'howl', name: 'A wolf howling (at night, in the woods)' },
    { id: 'growl', name: 'Wolves snarling as they run at you' },
    { id: 'caw', name: 'A crow cawing' },
    { id: 'meow', name: 'A cat meowing (fed, or wriggling free)' },
    { id: 'purr', name: 'A cat purring (petted)' },
    { id: 'wings', name: 'Crows flapping up into the air' },
  ] },
  { group: 'Crime', slots: [
    { id: 'alarm', name: 'Wanted (crime reported)' },
    { id: 'busted', name: 'Arrested' },
    { id: 'lockpick', name: 'Picking a lock (repeats)' },
    { id: 'pickpocket', name: 'Pickpocketing' },
    { id: 'atmSmash', name: 'An ATM bursting open (bat)' },
    { id: 'bribe', name: 'Paying a bribe at a checkpoint' },
    { id: 'hire', name: 'Hiring muscle at the bar' },
    { id: 'campBell', name: 'The prison bell (meal times)' },
    { id: 'whistle', name: 'A guard\'s whistle (lights out at the prison)' },
  ] },
];
export const SLOT_IDS = new Set(SOUND_SLOTS.flatMap((g) => g.slots.map((s) => s.id)));

/** Audio types we accept, by content-type, and the file extension each is saved with. */
export const AUDIO_TYPES = { 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/flac': 'flac' };
const TYPE_OF_EXT = { mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', webm: 'audio/webm', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac' };

export class SoundStore {
  constructor(dir = SOUNDS_DIR) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
    try {
      this.manifest = JSON.parse(readFileSync(`${dir}manifest.json`, 'utf8'));
    } catch {
      this.manifest = {}; // slot -> { file, version, volume }
    }
  }

  saveManifest() {
    writeFileSync(`${this.dir}manifest.json.tmp`, JSON.stringify(this.manifest, null, 2));
    renameSync(`${this.dir}manifest.json.tmp`, `${this.dir}manifest.json`);
  }

  /** What the client needs: the catalogue plus every custom slot ({ url, volume }). */
  list() {
    const custom = {};
    for (const [slot, m] of Object.entries(this.manifest)) {
      if (!SLOT_IDS.has(slot)) continue;
      custom[slot] = { url: m.file ? `/sounds/file/${m.file}?v=${m.version}` : null, volume: m.volume ?? 1 };
    }
    return { slots: SOUND_SLOTS, custom };
  }

  /** Saves an uploaded file as `slot`'s sound. Returns an error string, or null. */
  upload(slot, contentType, data) {
    if (!SLOT_IDS.has(slot)) return 'unknown sound';
    const ext = AUDIO_TYPES[(contentType ?? '').split(';')[0].trim().toLowerCase()];
    if (!ext) return 'not an audio file (mp3, ogg, wav, m4a, webm or flac)';
    if (!data.length) return 'empty file';
    const old = this.manifest[slot];
    const file = `${slot}.${ext}`;
    writeFileSync(`${this.dir}${file}.tmp`, data);
    renameSync(`${this.dir}${file}.tmp`, `${this.dir}${file}`);
    if (old?.file && old.file !== file) this.#unlink(old.file);
    this.manifest[slot] = { file, version: (old?.version ?? 0) + 1, volume: old?.volume ?? 1 };
    this.saveManifest();
    return null;
  }

  /** Volume 0–2 for a slot (works for built-in sounds too). */
  setVolume(slot, volume) {
    if (!SLOT_IDS.has(slot)) return 'unknown sound';
    if (typeof volume !== 'number' || !Number.isFinite(volume)) return 'bad volume';
    const m = this.manifest[slot] ?? { file: null, version: 0 };
    m.volume = Math.min(2, Math.max(0, volume));
    this.manifest[slot] = m;
    this.saveManifest();
    return null;
  }

  /** Back to the built-in sound (and normal volume). */
  reset(slot) {
    if (!SLOT_IDS.has(slot)) return 'unknown sound';
    const m = this.manifest[slot];
    if (m?.file) this.#unlink(m.file);
    delete this.manifest[slot];
    this.saveManifest();
    return null;
  }

  /** { data, type } for a stored file name, or null. */
  read(file) {
    if (!/^[A-Za-z0-9]+\.[a-z0-9]+$/.test(file)) return null; // (slot names may end in a number: radio1…)
    const [slot, ext] = file.split('.');
    if (!SLOT_IDS.has(slot) || this.manifest[slot]?.file !== file) return null;
    try {
      return { data: readFileSync(`${this.dir}${file}`), type: TYPE_OF_EXT[ext] ?? 'application/octet-stream' };
    } catch {
      return null;
    }
  }

  #unlink(file) {
    try {
      unlinkSync(`${this.dir}${file}`);
    } catch {}
  }
}
