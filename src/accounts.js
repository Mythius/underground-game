import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

export const DB_PATH = fileURLToPath(new URL('../data/game.db', import.meta.url));

/**
 * Player accounts: the bank balance, plus what you were carrying (cash and hotbar) when you last left.
 * Warehouses, cars and your home hang off the account too (their own tables).
 *
 * Every browser gets an account automatically (provider 'device'): the browser keeps the session
 * token in localStorage. Signing in with Google (through the CAS server) links a Google identity to
 * that account — or, if that Google account is already linked, switches the browser to it — so the
 * same account can be played from any device. Login methods live in `identities`, apart from `accounts`.
 */
export class AccountStore {
  constructor(path = DB_PATH) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS accounts (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        bank INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS identities (
        provider TEXT NOT NULL,          -- 'device' now; 'google' later
        subject TEXT NOT NULL,           -- a random id for 'device', the provider's user id otherwise
        account_id INTEGER NOT NULL REFERENCES accounts(id),
        secret TEXT,                     -- unused for now (kept for providers that need one)
        PRIMARY KEY (provider, subject)
      );
      CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, done_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS warehouses (
        id INTEGER PRIMARY KEY,
        account_id INTEGER NOT NULL REFERENCES accounts(id),
        slot TEXT NOT NULL,              -- which warehouse on the map ("medium-2"); the closest match is used if the map changed
        data TEXT NOT NULL,              -- JSON: machines, belts, dock stock (Warehouse.save())
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS homes (
        account_id INTEGER PRIMARY KEY REFERENCES accounts(id),
        slot TEXT NOT NULL               -- which starter house ("house-3"); another free one is used if it's gone or taken
      );
      CREATE TABLE IF NOT EXISTS cars (
        id INTEGER PRIMARY KEY,
        account_id INTEGER NOT NULL REFERENCES accounts(id),
        type TEXT NOT NULL,
        color TEXT NOT NULL,
        fuel REAL NOT NULL,
        cargo TEXT NOT NULL,             -- JSON: trunk slots ({ good, qty } | null)
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        account_id INTEGER NOT NULL REFERENCES accounts(id),
        expires_at INTEGER NOT NULL
      );
    `);
    // Columns added after the tables were first made.
    const has = (table, column) => this.db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
    if (!has('accounts', 'cash')) this.db.exec('ALTER TABLE accounts ADD COLUMN cash INTEGER NOT NULL DEFAULT 0');
    if (!has('accounts', 'carried')) this.db.exec('ALTER TABLE accounts ADD COLUMN carried TEXT'); // JSON hotbar slots when they left
    if (!has('identities', 'email')) this.db.exec('ALTER TABLE identities ADD COLUMN email TEXT');
    this.q = {
      accountById: this.db.prepare('SELECT id, name, bank, cash, carried FROM accounts WHERE id = ?'),
      accountByName: this.db.prepare('SELECT id FROM accounts WHERE name = ?'),
      insertAccount: this.db.prepare('INSERT INTO accounts (name, bank, created_at) VALUES (?, ?, ?)'),
      identity: this.db.prepare('SELECT account_id, secret FROM identities WHERE provider = ? AND subject = ?'),
      insertIdentity: this.db.prepare('INSERT INTO identities (provider, subject, account_id, secret) VALUES (?, ?, ?, ?)'),
      insertSession: this.db.prepare('INSERT INTO sessions (token, account_id, expires_at) VALUES (?, ?, ?)'),
      session: this.db.prepare('SELECT account_id, expires_at FROM sessions WHERE token = ?'),
      pruneSessions: this.db.prepare('DELETE FROM sessions WHERE expires_at < ?'),
      setBank: this.db.prepare('UPDATE accounts SET bank = ? WHERE id = ?'),
      setCarried: this.db.prepare('UPDATE accounts SET cash = ?, carried = ? WHERE id = ?'),
      linked: this.db.prepare("SELECT provider, email FROM identities WHERE account_id = ? AND provider != 'device' LIMIT 1"),
      rename: this.db.prepare('UPDATE accounts SET name = ? WHERE id = ?'),
    };
    this.liveAccounts = new Map(); // account id -> the one shared { id, name, bank, guest, … } object
    this.q.pruneSessions.run(Date.now());
    this.#migrate();
  }

  /** One-off data changes, each applied once. */
  #migrate() {
    const once = (name, fn) => {
      if (this.db.prepare('SELECT 1 FROM migrations WHERE name = ?').get(name)) return;
      fn();
      this.db.prepare('INSERT INTO migrations (name, done_at) VALUES (?, ?)').run(name, Date.now());
    };
    // Testing money for accounts made before the starting balance went up.
    once(`top-up-${config.accounts.topUpTo}`, () => this.db.prepare('UPDATE accounts SET bank = ? WHERE bank < ?').run(config.accounts.topUpTo, config.accounts.topUpTo));
  }

  #newSession(accountId, days = config.accounts.sessionDays) {
    const token = randomBytes(32).toString('base64url');
    this.q.insertSession.run(token, accountId, Date.now() + days * 86_400_000);
    return token;
  }

  #createAccount(name) {
    const { lastInsertRowid } = this.q.insertAccount.run(name, config.accounts.startingBank, Date.now());
    return Number(lastInsertRowid);
  }

  #freeName(base) {
    let name = base.replace(/[^A-Za-z0-9_]/g, '').slice(0, 12) || 'player';
    while (name.length < 3 || this.q.accountByName.get(name)) name = `${name.slice(0, 12)}${Math.floor(Math.random() * 10000)}`;
    return name;
  }

  /**
   * A new account for a browser that has never played. The returned token is the browser's
   * key to it (kept in localStorage); there's no username or password.
   */
  createDeviceAccount() {
    const id = this.#createAccount(this.#freeName('player'));
    this.q.insertIdentity.run('device', randomBytes(16).toString('hex'), id, null);
    return { token: this.#newSession(id, config.accounts.deviceDays), account: this.account(id) };
  }

  /**
   * Signing in with an outside provider (Google via CAS): the account already linked to that
   * identity; otherwise this browser's account (`currentId`), if it isn't linked to anyone else yet,
   * becomes theirs (keeping its progress); otherwise a new account. Returns { token, account }.
   */
  signIn(provider, subject, { name = 'player', email = null, currentId = null } = {}) {
    const row = this.q.identity.get(provider, subject);
    if (row) return { token: this.#newSession(row.account_id), account: this.account(row.account_id) };
    let id = currentId && this.account(currentId) && !this.q.linked.get(currentId) ? currentId : null;
    if (id) {
      // A browser account's made-up name ("player1234") gives way to their real one.
      if (/^player\d*$/i.test(this.account(id).name)) {
        const fresh = this.#freeName(name);
        this.q.rename.run(fresh, id);
        if (this.liveAccounts.has(id)) this.liveAccounts.get(id).name = fresh;
      }
    } else id = this.#createAccount(this.#freeName(name));
    this.q.insertIdentity.run(provider, subject, id, null);
    this.db.prepare('UPDATE identities SET email = ? WHERE provider = ? AND subject = ?').run(email, provider, subject);
    return { token: this.#newSession(id), account: this.account(id) };
  }

  /** The outside login linked to an account ({ provider, email }), or null. */
  linkedLogin(id) {
    const row = this.q.linked.get(id);
    return row ? { provider: row.provider, email: row.email } : null;
  }

  /** The account a session token belongs to, or null if it's unknown or expired. */
  accountForToken(token) {
    if (typeof token !== 'string' || token.length > 100) return null;
    const row = this.q.session.get(token);
    if (!row || row.expires_at < Date.now()) return null;
    return this.account(row.account_id);
  }

  account(id) {
    const row = this.q.accountById.get(id);
    if (!row) return null;
    let carried = null;
    try { carried = row.carried ? JSON.parse(row.carried) : null; } catch {}
    return { id: row.id, name: row.name, bank: row.bank, cash: row.cash, carried };
  }

  /** What they're carrying (cash and hotbar slots) — saved when they leave, cleared when they die. */
  setCarried(id, cash, slots) {
    this.q.setCarried.run(Math.max(0, Math.round(cash)), slots ? JSON.stringify(slots) : null, id);
    const live = this.liveAccounts.get(id);
    if (live) Object.assign(live, { cash: Math.max(0, Math.round(cash)), carried: slots });
  }

  /**
   * The one live object for an account. Everything that changes a balance (the player, their
   * warehouses' taxes while they're offline) must share it, so it's cached for the server's lifetime.
   */
  live(id) {
    if (!this.liveAccounts.has(id)) {
      const account = this.account(id);
      if (!account) return null;
      this.liveAccounts.set(id, { ...account, guest: false });
    }
    return this.liveAccounts.get(id);
  }

  /** Every saved warehouse: [{ accountId, slot, data }]. */
  loadWarehouses() {
    return this.db
      .prepare('SELECT account_id, slot, data FROM warehouses ORDER BY id')
      .all()
      .map((r) => ({ accountId: r.account_id, slot: r.slot, data: JSON.parse(r.data) }));
  }

  /** Replaces all saved warehouses with `rows` ([{ accountId, slot, data }]). */
  saveWarehouses(rows) {
    const insert = this.db.prepare('INSERT INTO warehouses (account_id, slot, data, updated_at) VALUES (?, ?, ?, ?)');
    const now = Date.now();
    this.db.exec('BEGIN');
    try {
      this.db.exec('DELETE FROM warehouses');
      for (const r of rows) insert.run(r.accountId, r.slot, JSON.stringify(r.data), now);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** The starter house slot an account had, or null. */
  homeSlot(accountId) {
    return this.db.prepare('SELECT slot FROM homes WHERE account_id = ?').get(accountId)?.slot ?? null;
  }

  setHomeSlot(accountId, slot) {
    this.db.prepare('INSERT INTO homes (account_id, slot) VALUES (?, ?) ON CONFLICT(account_id) DO UPDATE SET slot = excluded.slot').run(accountId, slot);
  }

  /** An account's bought cars: [{ id, type, color, fuel, cargo }]. */
  cars(accountId) {
    return this.db
      .prepare('SELECT id, type, color, fuel, cargo FROM cars WHERE account_id = ? ORDER BY id')
      .all(accountId)
      .map((r) => ({ id: r.id, type: r.type, color: r.color, fuel: r.fuel, cargo: JSON.parse(r.cargo) }));
  }

  /** Saves a newly bought car; returns its id. */
  addCar(accountId, { type, color, fuel, cargo }) {
    const { lastInsertRowid } = this.db
      .prepare('INSERT INTO cars (account_id, type, color, fuel, cargo, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(accountId, type, color, fuel, JSON.stringify(cargo), Date.now());
    return Number(lastInsertRowid);
  }

  /** A car's fuel and trunk, as they are now. */
  saveCar(id, { fuel, cargo }) {
    this.db.prepare('UPDATE cars SET fuel = ?, cargo = ? WHERE id = ?').run(fuel, JSON.stringify(cargo), id);
  }

  setBank(id, amount) {
    this.q.setBank.run(Math.max(0, Math.round(amount)), id);
  }
}
