import type { Effect } from './effects';

/** Facts every handler needs; built once per event so handlers stay pure functions of (tx, item, context). */
export interface IngestContext {
  /** The processing time. Injected so tests can fix it; never read the clock inside a handler. */
  now: Date;
  /** Our business phone number as Meta reports it (metadata.display_phone_number); the owner side of a chat. */
  ownNumber: string | null;
  /** Transcribe voice notes (env TRANSCRIBE_AUDIO). */
  transcribeAudio: boolean;
  /** The webhook_events.dedupe_key being processed: stable across replays, so it is the right alert dedupe seed. */
  eventKey: string;
  /** The last BullMQ attempt: handlers that retry while a related row is missing stop waiting and settle. */
  finalAttempt: boolean;
}

/** What a handler produced: effects to run after commit, plus a short reason when it deliberately did nothing. */
export interface HandlerResult {
  effects: Effect[];
  /** Stored in webhook_events.last_error on a processed row, e.g. `group_message_ignored`. Never message content. */
  note?: string;
}

/** Thrown to make BullMQ retry the job with backoff (a related row has not arrived yet). */
export class RetryLaterError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'RetryLaterError';
  }
}

/** A handler that had nothing to do (a fresh object each time: results are never shared). */
export const nothing = (note?: string): HandlerResult => (note === undefined ? { effects: [] } : { effects: [], note });
