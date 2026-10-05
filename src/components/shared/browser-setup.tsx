'use client';

import { z } from 'zod';

// Zod compiles a schema with `new Function` when the page allows it, and checks that on the first parse. The page policy forbids eval, so in a
// browser the check itself is reported as a CSP violation on every page that parses something. Declining the compiled path costs nothing here.
if (typeof window !== 'undefined') z.config({ jitless: true });

/** Renders nothing: it exists so the root layout loads the module above in every browser bundle. */
export function BrowserSetup() {
  return null;
}
