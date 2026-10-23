"use strict";

/**
 * Evenly spaced permits: N per minute means one every 60/N seconds, however
 * many workers ask and however slow the work is. Shared by the crawler and
 * the feed reader.
 */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class SteadyRate {
  constructor(perMinute) {
    this.intervalMs = 60000 / perMinute;
    this.nextAt = 0;
  }

  async acquire(shouldStop) {
    const now = Date.now();
    const slotAt = Math.max(now, this.nextAt);
    this.nextAt = slotAt + this.intervalMs;

    let remaining = slotAt - now;
    while (remaining > 0) {
      if (shouldStop()) {
        return false;
      }
      const chunk = Math.min(remaining, 250);
      await sleep(chunk);
      remaining -= chunk;
    }
    return true;
  }
}

module.exports = { SteadyRate };
