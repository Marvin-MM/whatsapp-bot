import 'server-only';
import { z } from 'zod';
import type { Tx } from '@/lib/db';
import { settings } from '@/lib/db/schema';

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const notificationSettingsSchema = z.object({
  notifyTelegram: z.boolean(),
  quietHours: z.object({
    start: z.string().regex(HHMM, 'Use a time like 22:00'),
    end: z.string().regex(HHMM, 'Use a time like 07:00'),
  }),
});
export type NotificationSettings = z.infer<typeof notificationSettingsSchema>;

export async function applyNotificationSettings(tx: Tx, input: NotificationSettings): Promise<{ previous: NotificationSettings | null }> {
  const [before] = await tx.select({ notifyTelegram: settings.notifyTelegram, quietHours: settings.quietHours }).from(settings).limit(1);
  await tx
    .insert(settings)
    .values({ id: 1, notifyTelegram: input.notifyTelegram, quietHours: input.quietHours })
    .onConflictDoUpdate({ target: settings.id, set: { notifyTelegram: input.notifyTelegram, quietHours: input.quietHours, updatedAt: new Date() } });
  return { previous: before ? { notifyTelegram: before.notifyTelegram, quietHours: before.quietHours } : null };
}
