/** Token bucket: refills `ratePerSec` tokens per second up to `burst`. */
export class RateLimiter {
  constructor(ratePerSec, burst = ratePerSec, now = () => performance.now()) {
    this.rate = ratePerSec / 1000;
    this.burst = burst;
    this.tokens = burst;
    this.now = now;
    this.last = now();
  }

  tryConsume(cost = 1) {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + (t - this.last) * this.rate);
    this.last = t;
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }
}
