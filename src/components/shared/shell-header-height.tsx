'use client';

import { useEffect } from 'react';

/**
 * Publishes the sticky app header's real height as `--shell-header-h`, so anything that sticks beneath it (the conversation
 * header) can sit exactly under it. The header wraps to two rows on narrow phones, so its height is not a constant and a
 * hard-coded offset hides content under it on exactly the screens where space is tightest.
 */
export function ShellHeaderHeight({ targetId }: { targetId: string }) {
  useEffect(() => {
    const element = document.getElementById(targetId);
    if (!element) return;
    const apply = () => document.documentElement.style.setProperty('--shell-header-h', `${element.getBoundingClientRect().height}px`);
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(element);
    return () => observer.disconnect();
  }, [targetId]);
  return null;
}
