import 'server-only';
import { headers } from 'next/headers';
import { createOwnerAction, createOwnerQuery } from '@/lib/actions/owner-action-core';

/** `ownerAction` bound to the current request's headers. Use it for every mutation in src/actions. */
export const ownerAction = createOwnerAction(async () => new Headers(await headers()));

/** `ownerQuery` bound to the current request's headers: for read-only server actions (no audit entry, no transaction). */
export const ownerQuery = createOwnerQuery(async () => new Headers(await headers()));
