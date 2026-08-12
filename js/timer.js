/** Round timer maths and a shared ticker. */

/** Seconds left, derived from the shared end timestamp so every client agrees. */
export function remainingSeconds(room, now = Date.now()) {
  const timer = room?.timer;
  if (!timer) return 0;
  if (!timer.running) return Math.max(0, Math.round(timer.remaining ?? room.timerDuration ?? 0));
  return Math.max(0, Math.round(((timer.endsAt ?? now) - now) / 1000));
}

export function isTimerFinished(room, now = Date.now()) {
  return Boolean(room?.timer?.running) && remainingSeconds(room, now) <= 0;
}

/** One interval for the whole app, so timers and presence stay cheap. */
export function createTicker(intervalMs = 500) {
  const listeners = new Set();
  let handle = null;

  function tick() {
    const now = Date.now();
    for (const listener of listeners) listener(now);
  }

  return {
    add(listener) {
      listeners.add(listener);
      if (handle === null) handle = setInterval(tick, intervalMs);
      return () => {
        listeners.delete(listener);
        if (!listeners.size && handle !== null) {
          clearInterval(handle);
          handle = null;
        }
      };
    },
    stop() {
      listeners.clear();
      if (handle !== null) clearInterval(handle);
      handle = null;
    },
  };
}
