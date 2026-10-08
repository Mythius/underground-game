// Spawns N bot clients that wander around. Useful for smoke/load testing.
// Usage: node scripts/bots.js [count] [url]
import WebSocket from 'ws';

const count = Number(process.argv[2] ?? 10);
const url = process.argv[3] ?? `ws://localhost:${process.env.PORT ?? 3000}`;

let snapshots = 0;
let deaths = 0;

for (let i = 0; i < count; i++) {
  const ws = new WebSocket(url);
  let seq = 0;
  let angle = Math.random() * Math.PI * 2;
  let timer;

  ws.on('open', () => {
    ws.send(JSON.stringify({ t: 'join', name: `bot${i}` }));
    timer = setInterval(() => {
      angle += (Math.random() - 0.5) * 0.6;
      ws.send(JSON.stringify({ t: 'input', seq: seq++, angle, throttle: 1, boost: Math.random() < 0.05 }));
    }, 50);
  });

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.t === 'snapshot') snapshots++;
    if (msg.t === 'died') {
      deaths++;
      setTimeout(() => ws.send(JSON.stringify({ t: 'join', name: `bot${i}` })), 1000);
    }
  });

  ws.on('close', () => clearInterval(timer));
  ws.on('error', (err) => console.error(`bot${i}:`, err.message));
}

setInterval(() => {
  console.log(`bots=${count} snapshots/s=${snapshots} deaths=${deaths}`);
  snapshots = 0;
}, 1000);
