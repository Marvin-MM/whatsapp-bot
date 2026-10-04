import 'server-only';
import { getProducerConnection } from '@/lib/queue/connection';
import { getEnv } from '@/lib/env';
import { type DashboardEventInput, dashboardChannel, dashboardEventSchema } from './events';

/**
 * Publishes a validated event to the dashboard channel. Throws if the event is malformed (a bug) or
 * Redis is unreachable (callers on the request path let that become a 500; workers retry the job).
 */
export async function publishEvent(input: DashboardEventInput): Promise<void> {
  const event = dashboardEventSchema.parse({ ...input, at: new Date().toISOString() });
  await getProducerConnection().publish(dashboardChannel(getEnv().BULLMQ_PREFIX), JSON.stringify(event));
}
