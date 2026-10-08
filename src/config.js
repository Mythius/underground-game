import { fileURLToPath } from 'node:url';

// Load .env from the project root. Missing file is fine; existing env vars win.
try {
  process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)));
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}

const env = process.env;

function int(name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) throw new Error(`Invalid integer for ${name}: ${raw}`);
  return value;
}

function list(name) {
  const raw = env[name];
  if (!raw) return null;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

export const config = Object.freeze({
  port: int('PORT', 3000),
  host: env.HOST || '0.0.0.0',
  logLevel: env.LOG_LEVEL || 'info',
  allowedOrigins: list('ALLOWED_ORIGINS'),

  // Simulation runs at tickRate; state is sent to clients at snapshotRate.
  tickRate: int('TICK_RATE', 30),
  snapshotRate: int('SNAPSHOT_RATE', 15),
  leaderboardIntervalMs: 1000,
  maxPlayersPerRoom: int('MAX_PLAYERS_PER_ROOM', 50),

  net: {
    maxPayloadBytes: 1024,
    maxMessagesPerSecond: 60,
    messageBurst: 120,
    heartbeatIntervalMs: 10_000,
    // Snapshots are skipped for a client whose socket buffer is above this.
    maxBufferedBytes: 256 * 1024,
  },

  world: {
    width: 4000,
    height: 4000,
    gridCellSize: 250,
    foodCount: 600,
    foodMass: 1,
    viewDistance: 1400,
  },

  player: {
    nameMaxLength: 16,
    startMass: 25,
    baseSpeed: 260, // units/sec at start mass
    boostMultiplier: 1.7,
    boostDrainPerSec: 0.04, // fraction of mass lost per second while boosting
    minBoostMass: 30,
    massDecayPerSec: 0.002, // passive shrink for large players
    decayThreshold: 200,
    eatRatio: 1.15, // must be this much larger (by radius) to eat another player
    spawnSafeDistance: 400,
  },
});
