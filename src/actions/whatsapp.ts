'use server';

import { z } from 'zod';
import type { ActionResult } from '@/lib/actions/owner-action-core';
import { type TokenHealth, checkTokenHealth } from '@/lib/ops/token-health';
import { ownerQuery } from './owner-action';

const check = ownerQuery({
  name: 'whatsapp.checkToken',
  schema: z.object({}),
  handler: async (): Promise<TokenHealth> => checkTokenHealth(),
});

/** Asks Meta, right now, whether the access token still works (the daily check, on demand). */
export async function checkWhatsappToken(input: unknown): Promise<ActionResult<TokenHealth>> {
  return check(input);
}
