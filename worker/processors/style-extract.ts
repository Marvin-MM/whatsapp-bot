import { type Processor, UnrecoverableError } from 'bullmq';
import { raiseAlert } from '@/lib/alerts';
import { AiOutputError, AiProviderError } from '@/lib/ai/errors';
import { StyleExtractionError, extractStyleGuide } from '@/lib/ai/style';
import { writeStyleStatus } from '@/lib/ai/style-status';
import { getDb } from '@/lib/db';
import { logger } from '@/lib/logger';

/**
 * `style-extract`: one manual extraction (the owner pressed the button on /style). Too little data and a malformed model answer are not
 * worth retrying the same way; a provider outage is (the queue's second attempt). The page learns the outcome from the status entry.
 */
export const styleExtractProcessor: Processor = async (job) => {
  const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
  try {
    const result = await extractStyleGuide(getDb());
    await writeStyleStatus({ state: 'done', version: result.version, message: `Version ${result.version} extracted from ${result.sourceMessageCount} of your messages.` });
    return result;
  } catch (error) {
    const retryable = error instanceof AiProviderError && error.retryable;
    if (retryable && !finalAttempt) throw error;
    const message =
      error instanceof StyleExtractionError
        ? error.message
        : error instanceof AiOutputError
          ? 'The model did not return a usable style guide. Try again; if it keeps failing, the model may not suit this task.'
          : error instanceof AiProviderError
            ? 'The AI provider could not be reached. Try again in a few minutes.'
            : 'The extraction failed unexpectedly. See the worker log.';
    await writeStyleStatus({ state: 'failed', message });
    logger.warn({ error: error instanceof Error ? error.name : 'unknown' }, 'style extraction failed');
    if (!(error instanceof StyleExtractionError)) {
      await raiseAlert({ kind: 'style_extract_failed', severity: 'warning', dedupeKey: `style_extract_failed:${job.id ?? Date.now()}` });
    }
    throw new UnrecoverableError(error instanceof Error ? error.name : 'style extraction failed');
  }
};
