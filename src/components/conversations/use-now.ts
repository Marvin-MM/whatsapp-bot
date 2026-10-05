'use client';

import { useSyncExternalStore } from 'react';

const TICK_MS = 10_000;

const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;
let current = Date.now();

/**
 * One interval for the whole page, however many countdowns are mounted; it stops when the last one unmounts. The clock is
 * refreshed on subscribe as well as on every tick, so a countdown that mounts late never starts from a stale time.
 */
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  current = Date.now();
  timer ??= setInterval(() => {
    current = Date.now();
    listeners.forEach((notify) => notify());
  }, TICK_MS);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

/** A stable value between ticks, which is what useSyncExternalStore needs (a fresh Date.now() on every call would loop). */
const snapshot = (): number => current;

/**
 * The current time, ticking every 10 seconds. `serverNow` is what the server rendered with: the hydration render uses it so the
 * markup matches, and the real clock takes over straight after, so a thread left open for hours shows the real countdown.
 */
export function useNow(serverNow: Date): Date {
  const now = useSyncExternalStore(subscribe, snapshot, () => serverNow.getTime());
  return new Date(now);
}
