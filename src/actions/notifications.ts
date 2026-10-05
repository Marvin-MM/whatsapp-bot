'use server';

import { z } from 'zod';
import { ActionRefusal, type ActionResult } from '@/lib/actions/owner-action-core';
import { applyNotificationSettings, notificationSettingsSchema } from '@/lib/settings/notifications';
import { sendTelegramMessage } from '@/lib/notify/telegram';
import { ownerAction, ownerQuery } from './owner-action';

const save = ownerAction({
  name: 'settings.notifications',
  schema: notificationSettingsSchema,
  handler: async ({ input, tx }) => {
    const { previous } = await applyNotificationSettings(tx, input);
    return {
      data: input,
      audit: {
        action: 'settings.notifications',
        entityType: 'settings',
        entityId: '1',
        metadata: { notifyTelegram: input.notifyTelegram, quietHours: input.quietHours, previous },
      },
    };
  },
});

/** Telegram on/off and quiet hours (the owner's local time). Owner-only, audited. */
export async function saveNotificationSettings(input: unknown) {
  return save(input);
}

const test = ownerQuery({
  name: 'telegram.test',
  schema: z.object({}),
  handler: async () => {
    const result = await sendTelegramMessage('✅ Test from your WhatsApp assistant: if you can read this, alerts will reach you here.');
    if (!result.ok) throw new ActionRefusal(`telegram_${result.reason}`, result.detail);
    return { delivered: true as const };
  },
});

/** Sends a test message to the owner's Telegram chat so a wrong token or chat id is found now, not during an incident. */
export async function testTelegram(input: unknown): Promise<ActionResult<{ delivered: true }>> {
  return test(input);
}
