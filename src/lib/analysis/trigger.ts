import 'server-only';
import type { Effect } from '@/lib/ingest/effects';

/** After commit, once the owner's message is with Meta (or was sent from the phone): update the summary and the tasks. One job per message. */
export function analysisEffect(messageId: string): Effect {
  return { type: 'enqueue', queue: 'post-send-analysis', name: 'analyze', data: { messageId }, opts: { jobId: `analysis:${messageId}` } };
}
