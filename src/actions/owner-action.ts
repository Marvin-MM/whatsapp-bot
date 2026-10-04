import 'server-only';
import { headers } from 'next/headers';
import { createOwnerAction } from '@/lib/actions/owner-action-core';

/** `ownerAction` bound to the current request's headers. Use it for every mutation in src/actions. */
export const ownerAction = createOwnerAction(async () => new Headers(await headers()));
