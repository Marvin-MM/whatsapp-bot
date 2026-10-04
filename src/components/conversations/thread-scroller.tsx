'use client';

import { type ReactNode, useEffect, useRef } from 'react';

const NEAR_BOTTOM_PX = 160;

/**
 * Starts a conversation scrolled to its newest message, and follows new messages while the owner is at (or near) the
 * bottom. If they have scrolled up to read history, a new message must NOT yank them back down.
 */
export function ThreadScroller({ lastMessageId, children }: { lastMessageId: string | null; children: ReactNode }) {
  const end = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);

  useEffect(() => {
    const update = () => {
      nearBottom.current = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - NEAR_BOTTOM_PX;
    };
    window.addEventListener('scroll', update, { passive: true });
    return () => window.removeEventListener('scroll', update);
  }, []);

  useEffect(() => {
    if (nearBottom.current) end.current?.scrollIntoView({ block: 'end' });
  }, [lastMessageId]);

  return (
    <>
      {children}
      {/* scroll-mb clears the fixed bottom navigation on phones, so the newest message is not hidden beneath it. */}
      <div ref={end} aria-hidden="true" className="scroll-mb-28 md:scroll-mb-8" />
    </>
  );
}
