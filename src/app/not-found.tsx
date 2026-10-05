import type { Metadata } from 'next';
import Link from 'next/link';
import { connection } from 'next/server';

export const metadata: Metadata = { title: 'Not found' };

/**
 * Rendered per request (`connection()`), not prerendered: the page policy gives scripts a nonce that exists only for a live request, and a
 * prerendered page has none, so its scripts would be refused.
 */
export default async function NotFound() {
  await connection();
  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="max-w-sm space-y-3 text-center">
        <h1 className="text-xl font-semibold">That page does not exist</h1>
        <p className="text-sm text-muted-foreground">The link may be old, or the conversation may have been removed.</p>
        <Link href="/" className="inline-flex h-9 items-center rounded-full border border-border bg-card px-4 text-sm hover:bg-muted">
          Back to Overview
        </Link>
      </div>
    </main>
  );
}
