import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';

// Keeping a public game civil: a basic swear filter for chat and names, and the admin's bans
// (by IP and by account, saved in data/bans.json so they outlast a restart).

// ---- swear filter ------------------------------------------------------------------------------

// Words that are bad with anything after them ("fucking", "shitty"), and words that are only bad
// on their own (so "class", "assassin", "Scunthorpe" and "cocktail" are fine). Compared after
// undoing leetspeak and squashing repeated letters, so "f4ck", "fuuuck" and "$h1t" are caught too.
const ROOTS = [
  'fuck', 'fuk', 'fck', 'shit', 'bitch', 'cunt', 'twat', 'wank', 'whore', 'slut', 'bastard', 'motherfuck',
  'nigger', 'nigga', 'faggot', 'retard', 'dickhead', 'asshole', 'arsehole', 'pussy', 'cock', 'jizz',
  // Russian mat
  'блят', 'бляд', 'сук', 'хуй', 'хуе', 'хуё', 'пизд', 'ебат', 'ебан', 'ёбан', 'еба', 'мудак', 'пидор', 'пидар', 'залуп', 'шлюх',
];
const WORDS = ['ass', 'arse', 'dick', 'fag', 'fags', 'tits', 'cum', 'dildo', 'rape', 'kys', 'nazi', 'blyat', 'suka', 'cyka'];
const ROOT_EXCEPTIONS = ['cockpit', 'cockroach', 'cocktail', 'cockatoo', 'cocker', 'сукно'];

const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', 9: 'g', '@': 'a', $: 's', '!': 'i', '|': 'i', '+': 't' };
const squash = (s) => s.replace(/(.)\1+/gu, '$1');
const deLeet = (word) => [...word.toLowerCase()].map((c) => LEET[c] ?? c).join('').replace(/[^\p{L}]/gu, '');
const normalize = (word) => squash(deLeet(word));
const ROOTS_N = ROOTS.map(squash);
// Whole words keep their double letters ("ass" mustn't become "as"); only runs of 3+ are trimmed.
const WORDS_N = new Set(WORDS);
const EXCEPTIONS_N = ROOT_EXCEPTIONS.map(squash);

function isSwear(word) {
  if (WORDS_N.has(deLeet(word).replace(/(.)\1{2,}/gu, '$1$1'))) return true;
  const w = normalize(word);
  if (w.length < 2) return false;
  if (EXCEPTIONS_N.some((e) => w.startsWith(e))) return false;
  return ROOTS_N.some((r) => w.startsWith(r) || (r.length >= 5 && w.includes(r)));
}

/** The text with every swear word starred out ("what the ****"). */
export function censor(text) {
  // A "word" here includes leetspeak symbols, so "$h1t" is looked at as one word.
  return text.replace(/[\p{L}\p{N}@$!|+]+/gu, (word) => (isSwear(word) ? '*'.repeat([...word].length) : word));
}

/** Whether a name has anything rude in it (even run together: "BigFuckingGuy"). */
export function rudeName(name) {
  if (censor(name) !== name) return true;
  const joined = normalize(name);
  return ROOTS_N.some((r) => r.length >= 4 && joined.includes(r)) && !EXCEPTIONS_N.some((e) => joined.includes(e));
}

// ---- reports -------------------------------------------------------------------------------------

/** Players' reports about other players, newest last (data/reports.json, the last 500). Also used for
 *  bug reports and update requests (data/feedback.json), which the admin can tick off (remove). */
export class ReportLog {
  constructor(file = new URL('../data/reports.json', import.meta.url)) {
    this.file = file;
    this.reports = [];
    try {
      if (existsSync(file)) this.reports = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      this.reports = [];
    }
  }

  add(report) {
    this.reports.push({ ...report, id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`, at: Date.now() });
    if (this.reports.length > 500) this.reports.splice(0, this.reports.length - 500);
    this.#save();
  }

  /** Take one out (by id). False if there's no such entry. */
  remove(id) {
    const i = this.reports.findIndex((r) => r.id === id);
    if (i < 0) return false;
    this.reports.splice(i, 1);
    this.#save();
    return true;
  }

  /** Reported players, most reported first: { name, accountId, count, last, reasons: { reason: n }, reports (newest first) }. */
  byPlayer() {
    const out = new Map();
    for (const r of this.reports) {
      const key = r.about.accountId ? `a${r.about.accountId}` : `n${r.about.name.toLowerCase()}`;
      let p = out.get(key);
      if (!p) out.set(key, (p = { name: r.about.name, accountId: r.about.accountId, count: 0, last: 0, reasons: {}, reports: [] }));
      p.name = r.about.name; // (the latest name they went by)
      p.count++;
      p.last = Math.max(p.last, r.at);
      p.reasons[r.reason] = (p.reasons[r.reason] ?? 0) + 1;
      p.reports.unshift({ at: r.at, by: r.by.name, reason: r.reason, text: r.text, chat: r.chat ?? [] });
    }
    return [...out.values()].sort((a, b) => b.count - a.count || b.last - a.last);
  }

  #save() {
    const tmp = `${this.file.pathname ?? this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.reports, null, 1));
    renameSync(tmp, this.file);
  }
}

// ---- bans --------------------------------------------------------------------------------------

export class BanList {
  constructor(file = new URL('../data/bans.json', import.meta.url)) {
    this.file = file;
    this.bans = []; // [{ ip, accountId, name, at }]
    try {
      if (existsSync(file)) this.bans = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      this.bans = [];
    }
  }

  #save() {
    const tmp = `${this.file.pathname ?? this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.bans, null, 1));
    renameSync(tmp, this.file);
  }

  isBanned({ ip = null, accountId = null }) {
    return this.bans.some((b) => (ip && b.ip === ip) || (accountId && b.accountId === accountId));
  }

  ban({ ip = null, accountId = null, name = '?' }) {
    this.bans.push({ ip, accountId, name, at: Date.now() });
    this.#save();
  }

  /** Lift bans by name (case-insensitive) or IP. Returns how many were lifted. */
  unban(who) {
    const key = who.toLowerCase();
    const before = this.bans.length;
    this.bans = this.bans.filter((b) => b.ip !== who && b.name.toLowerCase() !== key);
    if (this.bans.length !== before) this.#save();
    return before - this.bans.length;
  }
}
