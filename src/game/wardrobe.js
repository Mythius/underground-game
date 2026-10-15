import { config } from '../config.js';

// Hats, coats and shades you earn by doing things. No hat and the baseball cap are everyone's from the
// start; the rest are won once per account and kept. A look ({ skin, shirt, pants, hat (index into
// config.looks.hats), coat ('trench' | 'leather' | 'prison' | null), shades, goggles (not both)) only wears what you've earned.

export const WARDROBE = [
  { id: 'cap', part: 'hat', name: 'Baseball cap', free: true },
  { id: 'none', part: 'hat', name: 'No hat', free: true },
  { id: 'tophat', part: 'hat', name: 'Top hat', why: 'First factory' },
  { id: 'miner', part: 'hat', name: 'Hard hat', why: 'First haul from a work site' },
  { id: 'crown', part: 'hat', name: 'Crown', why: 'Killed the governor' },
  { id: 'helmet', part: 'hat', name: 'Army helmet', why: 'Hired a hitman' },
  { id: 'party', part: 'hat', name: 'Party hat', why: 'First vodka' },
  { id: 'ushanka', part: 'hat', name: 'Ushanka', why: 'Robbed a bank' },
  { id: 'furazhka', part: 'hat', name: 'Furazhka', why: 'Joined the Militsiya' },
  { id: 'cowboy', part: 'hat', name: 'Cowboy hat', why: 'Fed the crows' },
  { id: 'beanie', part: 'hat', name: 'Beanie', why: 'Fed a stray cat' },
  { id: 'wolfhat', part: 'hat', name: 'Wolf-fur hat', why: 'Killed a wolf' },
  { id: 'papakha', part: 'hat', name: 'Bear-fur papakha', why: 'Killed the albino bear' },
  { id: 'bucket', part: 'hat', name: 'Fishing hat', why: 'Caught a fish' },
  { id: 'kepka', part: 'hat', name: 'Kepka', why: 'Own a panelka and the lock-up garages' },
  { id: 'kubanka', part: 'hat', name: 'Kubanka', why: 'Drank every kind of vodka' },
  { id: 'trench', part: 'coat', name: 'Trench coat', why: 'Freed the oil hall\'s prisoners' },
  { id: 'leather', part: 'coat', name: 'Leather jacket', why: 'Sold over 20,000 ₽ to the man in the leather jacket' },
  { id: 'zek', part: 'hat', name: 'Prison cap', why: 'Dug 2,000 coal at the prison camp' },
  { id: 'prison', part: 'coat', name: 'Prison outfit', why: 'Dug 2,000 coal at the prison camp' },
  { id: 'shades', part: 'shades', name: 'Shades', why: 'Killed one of the governor\'s guards' },
  { id: 'goggles', part: 'goggles', name: 'Swimming goggles', why: 'Survived a flood wave underground' },
];
const BY_ID = new Map(WARDROBE.map((w) => [w.id, w]));
export const FREE = WARDROBE.filter((w) => w.free).map((w) => w.id);
export const SMUGGLED = 20000; // sold to the man in the leather jacket, for the jacket
export const COAL = 2000; // dug at the prison camp, all told, for the prison outfit (and its cap)

const DONE_WHAT = { wh_buy: 'tophat', work_buy: 'tophat', work_haul: 'miner', hire_hitman: 'helmet', cop_apply: 'furazhka' };
const POLICE_KIND = { governor_killed: 'crown', govguard_killed: 'shades', fish_caught: 'bucket', cat_fed: 'beanie', wolf_killed: 'wolfhat', bear_killed: 'papakha', prisoners_freed: 'trench', flood_survived: 'goggles' };

/** What an account has won so far ({ have: [ids], drank: [vodka kinds], smuggled: ₽, coal: dug in prison }). */
export function wardrobeOf(account) {
  account.wardrobe ??= {};
  account.wardrobe.have ??= [];
  account.wardrobe.drank ??= [];
  account.wardrobe.smuggled ??= 0;
  account.wardrobe.coal ??= 0;
  return account.wardrobe;
}

/** The piece a message on its way to a player means they've won, if any. */
export function fromMessage(msg) {
  if (msg.t === 'done') return DONE_WHAT[msg.what] ?? null;
  if (msg.t === 'police') return msg.kind === 'robbed' ? (msg.what === 'bank' ? 'ushanka' : null) : POLICE_KIND[msg.kind] ?? null;
  return null;
}

/** Marks `id` won on the account. True if it's new. */
export function unlock(account, id) {
  if (!account || !BY_ID.has(id) || BY_ID.get(id).free) return false;
  const w = wardrobeOf(account);
  if (w.have.includes(id)) return false;
  w.have.push(id);
  return true;
}

/** Drank a bottle of `good`: the party hat, and the kubanka once they've had every kind. */
export function drank(account, good) {
  if (!account || !(good in config.economy.visions)) return [];
  const w = wardrobeOf(account);
  if (!w.drank.includes(good)) w.drank.push(good);
  return Object.keys(config.economy.visions).every((k) => w.drank.includes(k)) ? ['party', 'kubanka'] : ['party'];
}

/** Sold `paid` ₽ of contraband to the man in the leather jacket: the jacket, past SMUGGLED in all. */
export function smuggled(account, paid) {
  if (!account) return null;
  const w = wardrobeOf(account);
  w.smuggled += paid;
  return w.smuggled > SMUGGLED ? 'leather' : null;
}

/** Dug `qty` coal at the prison camp: the prison outfit and cap, at COAL in all. */
export function coalMined(account, qty) {
  if (!account) return [];
  const w = wardrobeOf(account);
  w.coal += qty;
  return w.coal >= COAL ? ['prison', 'zek'] : [];
}

/** The look they asked for, with anything they haven't won taken off (a hat they haven't got: the cap). */
export function fitLook(look, account) {
  if (!look || typeof look !== 'object') return null;
  const have = new Set([...FREE, ...(account ? wardrobeOf(account).have : [])]);
  const int = (v) => (Number.isInteger(v) ? v : 0);
  const hats = config.looks.hats;
  let hat = int(look.hat);
  if (!have.has(hats[hat])) hat = hats.indexOf('cap');
  const coat = ['trench', 'leather', 'prison'].includes(look.coat) && have.has(look.coat) ? look.coat : null;
  const goggles = Boolean(look.goggles) && have.has('goggles');
  return { skin: int(look.skin), shirt: int(look.shirt), pants: int(look.pants), hat, coat, shades: !goggles && Boolean(look.shades) && have.has('shades'), goggles };
}
