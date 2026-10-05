'use client';

import { useSyncExternalStore } from 'react';

/**
 * A one-line confirmation that survives the navigation to the next draft ("Sent to Amina."). The approvals page replaces the card the
 * moment a decision is made, so the confirmation lives in this tiny module-level store rather than in the card that is about to unmount.
 * It clears itself, and says nothing on a fresh page load.
 */

interface FlashMessage {
  tone: 'success' | 'neutral';
  text: string;
}

const CLEAR_AFTER_MS = 6000;
const listeners = new Set<() => void>();
let current: FlashMessage | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

function set(next: FlashMessage | null): void {
  current = next;
  listeners.forEach((notify) => notify());
}

export function showFlash(message: FlashMessage): void {
  clearTimeout(timer);
  set(message);
  timer = setTimeout(() => set(null), CLEAR_AFTER_MS);
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function Flash() {
  const message = useSyncExternalStore(subscribe, () => current, () => null);
  // role=status is a polite live region: a screen reader announces the confirmation without interrupting.
  return (
    <div role="status" aria-live="polite" className="min-h-0">
      {message ? (
        <p className={message.tone === 'success' ? 'mb-3 rounded-lg border border-success/40 bg-success/10 px-3 py-2 text-sm text-success' : 'mb-3 rounded-lg border border-border bg-muted px-3 py-2 text-sm'}>
          {message.text}
        </p>
      ) : null}
    </div>
  );
}
