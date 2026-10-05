'use client';

import { type ReactNode, useEffect, useRef } from 'react';

const NEAR_BOTTOM_PX = 160;

/**
 * Starts a conversation scrolled to its newest message, and follows new messages while the owner is at (or near) the
 * bottom. If they have scrolled up to read history, a new message must NOT yank them back down.
 */
export function ThreadScroller({ lastMessageId, children }: { lastMessageId: string | null; children: ReactNode }) {
  const nearBottom = useRef(true);

  useEffect(() => {
    const update = () => {
      nearBottom.current = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - NEAR_BOTTOM_PX;
    };
    window.addEventListener('scroll', update, { passive: true });
    return () => window.removeEventListener('scroll', update);
  }, []);

  useEffect(() => {
    // To the very bottom of the page, not to a marker above the reply box: the box is sticky and would otherwise sit on top of the
    // newest message. At the bottom of the document it is in normal flow, below the thread.
    if (nearBottom.current) window.scrollTo({ top: document.documentElement.scrollHeight });
  }, [lastMessageId]);

  return <>{children}</>;
}
