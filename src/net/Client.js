import WebSocket from 'ws';
import { config } from '../config.js';
import { encode } from './protocol.js';
import { RateLimiter } from './RateLimiter.js';

let nextClientId = 1;

/** One WebSocket connection. Survives player death/respawn. */
export class Client {
  constructor(ws, remoteAddress) {
    this.id = nextClientId++;
    this.ws = ws;
    this.remoteAddress = remoteAddress;
    this.isAlive = true; // heartbeat flag
    this.room = null;
    this.player = null;
    this.rateLimiter = new RateLimiter(config.net.maxMessagesPerSecond, config.net.messageBurst);
    this.violations = 0;
  }

  get isOpen() {
    return this.ws.readyState === WebSocket.OPEN;
  }

  /** Send a message. Droppable messages (snapshots) are skipped under backpressure. */
  send(msg, { droppable = false } = {}) {
    if (!this.isOpen) return false;
    if (droppable && this.ws.bufferedAmount > config.net.maxBufferedBytes) return false;
    this.ws.send(encode(msg));
    return true;
  }

  sendRaw(data) {
    if (this.isOpen) this.ws.send(data);
  }

  close(code = 1000, reason = '') {
    if (this.isOpen) this.ws.close(code, reason);
  }
}
