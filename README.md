# underground-game — server

Authoritative real-time `.io`-style game server: Node.js + WebSockets (`ws`).

```bash
cp .env.example .env   # PORT etc. are read from .env
npm install
npm start              # or: npm run dev (restarts on file changes)
npm test
npm run bots -- 30     # connect 30 wandering bots for smoke/load testing
```

- `ws://localhost:3000` — game socket
- `GET /health` — liveness check
- `GET /stats` — connections, memory, per-room tick timings

## Layout

```
src/
  index.js            HTTP + WebSocket server, message dispatch, heartbeat, shutdown
  config.js           all tunables; loads .env, env vars override
  net/
    protocol.js       message types + validation of every client message
    Client.js         one connection: send w/ backpressure, rate limiter
    RateLimiter.js    token bucket
  game/
    RoomManager.js    matchmaking: fills rooms, spins up new ones when full
    Room.js           fixed-timestep loop, spawns, per-client snapshots
    World.js          pure simulation (movement, eating, food) — no I/O
    entities.js       Player, Food
    SpatialGrid.js    broad-phase collisions + area-of-interest culling
  utils/              JSON logger, math helpers
scripts/bots.js       bot clients
test/                 node:test unit tests
```

## Model

- **Server-authoritative.** Clients send only *intent* (`angle`, `throttle`, `boost`);
  the server simulates and broadcasts results. Clients can't teleport or set their mass.
- **Fixed timestep** (`TICK_RATE`, default 30 Hz) with an accumulator, decoupled from
  the **snapshot rate** (`SNAPSHOT_RATE`, default 15 Hz — rounded to divide the tick rate).
- **Interest management:** each client gets only entities within `viewDistance` of its player.
- **Input sequencing:** every input carries `seq`; snapshots echo the last processed one
  as `ack`, enabling client-side prediction + reconciliation.
- **Hardening:** max frame size, per-connection rate limit, schema validation, origin
  allow-list (`ALLOWED_ORIGINS`), ping/pong heartbeat, snapshots dropped for slow clients.

## Protocol (JSON, `t` = type)

Client → server

| t       | fields                                                   |
|---------|----------------------------------------------------------|
| `join`  | `name` — spawn, or respawn after death                   |
| `input` | `seq` (int), `angle` (radians), `throttle` 0..1, `boost` |
| `ping`  | `ts`                                                     |

Server → client

| t               | fields                                                                     |
|-----------------|----------------------------------------------------------------------------|
| `welcome`       | `clientId`, `roomId`, `world {width,height}`, `tickRate`, `snapshotRate`   |
| `spawned`       | `playerId`, `players [{id,name,color}]`                                    |
| `player_joined` | `id`, `name`, `color`                                                      |
| `player_left`   | `id`                                                                       |
| `snapshot`      | `tick`, `ack`, `you {id,x,y,mass}`, `players [[id,x,y,r]]`, `food [[id,x,y]]` |
| `died`          | `killedBy`, `score`                                                        |
| `leaderboard`   | `entries [{id,name,score}]` (1 Hz)                                         |
| `pong`          | `ts`, `serverTime`                                                         |
| `error`         | `code`                                                                     |

## Next steps

- Swap JSON for a binary encoding (e.g. `DataView` / msgpack) once bandwidth matters.
- Delta-compress food (it's static; send add/remove events instead of positions).
- Horizontal scaling: one process per N rooms behind a router/lobby service.
