/**
 * Conversation stages (spec 9.4), derived deterministically from timestamps and direction only: the same answer every time, no model.
 *
 * A conversation is cut into SEGMENTS wherever two consecutive messages (either side) are 24 hours or more apart. Each owner message
 * is then, in this order of precedence:
 *
 *   opening   the first owner message of its segment (the conversation, or a new round of it, has just started)
 *   closing   followed by 24 h or more of silence (the last word of its segment), or, with nothing after it, 24 h old at `now`
 *   followup  directly after another owner message, with no customer message in between
 *   mid       everything else
 *
 * The same rules exist in SQL (`fewshot-sql.ts`) so retrieval can run in the database; `test/integration/stages-parity.test.ts` proves the
 * two agree on randomly generated conversations. Only real messages count: reactions and failed sends are left out by the caller.
 */

export type Stage = 'opening' | 'mid' | 'closing' | 'followup';

export const SILENCE_MS = 24 * 60 * 60 * 1000;

export interface StageMessage {
  id: string;
  direction: 'inbound' | 'outbound';
  occurredAt: Date;
}

const byTime = (a: StageMessage, b: StageMessage): number => a.occurredAt.getTime() - b.occurredAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The stage of every OUTBOUND message. `messages` need not be sorted. */
export function deriveStages(messages: readonly StageMessage[], now: Date): Map<string, Stage> {
  const sorted = [...messages].sort(byTime);
  const stages = new Map<string, Stage>();
  let segmentHasOwner = false;

  sorted.forEach((message, index) => {
    const previous = sorted[index - 1];
    const next = sorted[index + 1];
    if (previous === undefined || message.occurredAt.getTime() - previous.occurredAt.getTime() >= SILENCE_MS) segmentHasOwner = false;
    if (message.direction !== 'outbound') return;

    const firstOwnerInSegment = !segmentHasOwner;
    segmentHasOwner = true;
    const silenceAfter = next === undefined ? now.getTime() - message.occurredAt.getTime() >= SILENCE_MS : next.occurredAt.getTime() - message.occurredAt.getTime() >= SILENCE_MS;

    if (firstOwnerInSegment) stages.set(message.id, 'opening');
    else if (silenceAfter) stages.set(message.id, 'closing');
    else if (previous?.direction === 'outbound') stages.set(message.id, 'followup');
    else stages.set(message.id, 'mid');
  });
  return stages;
}

/**
 * The stage the NEXT owner message would have, for a conversation whose newest messages are a customer burst: `opening` when nobody
 * from the owner's side has spoken in the current segment, otherwise `mid`. (A reply to a customer is never a follow-up or a closing at
 * the moment it is written.)
 */
export function stageOfNextReply(messages: readonly StageMessage[]): 'opening' | 'mid' {
  const sorted = [...messages].sort(byTime);
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    const message = sorted[index];
    if (message?.direction === 'outbound') return 'mid';
    const before = sorted[index - 1];
    if (before === undefined || (message !== undefined && message.occurredAt.getTime() - before.occurredAt.getTime() >= SILENCE_MS)) return 'opening';
  }
  return 'opening';
}
