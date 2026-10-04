import { twoFactorClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';

/** Browser-side Better Auth client (same origin). Imported only from client components. */
export const authClient = createAuthClient({ plugins: [twoFactorClient()] });
