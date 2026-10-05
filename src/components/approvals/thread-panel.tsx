'use client';

import { ChevronDown, ChevronUp } from 'lucide-react';
import { type ReactNode, useId, useState, useSyncExternalStore } from 'react';

/**
 * The conversation above the draft, collapsible. On a phone it starts collapsed so the draft, its warnings and the reason a button is off
 * are on the first screen; what the customer is waiting for is still shown (`unanswered`), so the owner never decides blind. From `lg` up
 * there is room for both and it starts open. Once the owner has chosen, their choice stays across drafts (this component is not remounted
 * when the page moves to the next draft). The thread itself is rendered on the server (children); collapsed content is unmounted, not
 * just hidden, so it is not read out or tabbed into while closed.
 */
const NARROW = '(max-width: 1023px)';

function subscribeNarrow(onChange: () => void): () => void {
  const query = window.matchMedia(NARROW);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

export function ThreadPanel({ children, messageCount, unanswered }: { children: ReactNode; messageCount: number; unanswered: string }) {
  // The server (and the first client render) assume a wide screen, so the markup matches; a phone re-reads the query right after hydration.
  const narrow = useSyncExternalStore(subscribeNarrow, () => window.matchMedia(NARROW).matches, () => false);
  // null until the owner chooses: then their choice wins, and it survives moving between drafts.
  const [chosen, setChosen] = useState<boolean | null>(null);
  const open = chosen ?? !narrow;
  const panelId = useId();

  return (
    <section aria-label="Conversation so far" className="rounded-lg border border-border bg-card">
      <button
        type="button"
        onClick={() => setChosen(!open)}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex w-full items-center justify-between gap-2 rounded-lg px-4 py-2.5 text-sm font-medium hover:bg-muted"
      >
        <span>
          Conversation <span className="font-normal text-muted-foreground">({messageCount} recent message{messageCount === 1 ? '' : 's'})</span>
        </span>
        {open ? <ChevronUp aria-hidden="true" className="h-4 w-4" /> : <ChevronDown aria-hidden="true" className="h-4 w-4" />}
      </button>
      {open ? (
        <div id={panelId} className="max-h-[42dvh] overflow-y-auto border-t border-border px-4 py-3 lg:max-h-[50dvh]">
          {children}
        </div>
      ) : unanswered ? (
        <div className="border-t border-border px-4 py-2.5">
          {/* The clamp sits on an inner element: padding on a clamped element lets a sliver of the next line show. */}
          <p className="line-clamp-3 text-sm">
            <span className="text-muted-foreground">Customer: </span>
            {unanswered}
          </p>
        </div>
      ) : null}
    </section>
  );
}
