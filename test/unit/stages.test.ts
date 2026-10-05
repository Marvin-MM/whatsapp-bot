import { describe, expect, it } from 'vitest';
import { type StageMessage, deriveStages, stageOfNextReply } from '@/lib/ai/stages';

const T0 = new Date('2026-01-10T08:00:00Z').getTime();
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
let n = 0;
const m = (direction: 'in' | 'out', atMs: number, id?: string): StageMessage => ({ id: id ?? `m${String(++n).padStart(3, '0')}`, direction: direction === 'in' ? 'inbound' : 'outbound', occurredAt: new Date(T0 + atMs) });
const NOW = new Date(T0 + 400 * HOUR);
const stagesOf = (messages: StageMessage[], now = NOW) => {
  const result = deriveStages(messages, now);
  return messages.filter((x) => x.direction === 'outbound').map((x) => result.get(x.id));
};

describe('deriveStages', () => {
  it('the first owner message of a conversation is `opening`', () => {
    expect(stagesOf([m('in', 0), m('out', 5 * MIN)])).toEqual(['opening']);
    expect(stagesOf([m('out', 0)])).toEqual(['opening']);
  });

  it('later messages in the same exchange are `mid`', () => {
    expect(stagesOf([m('in', 0), m('out', 5 * MIN), m('in', 10 * MIN), m('out', 12 * MIN), m('in', 20 * MIN), m('out', 22 * MIN)], new Date(T0 + 23 * MIN))).toEqual(['opening', 'mid', 'mid']);
  });

  it('an owner message directly after another owner message is a `followup`', () => {
    expect(stagesOf([m('in', 0), m('out', 5 * MIN), m('out', 2 * HOUR)], new Date(T0 + 3 * HOUR))).toEqual(['opening', 'followup']);
  });

  it('the last word before 24h of silence is `closing`', () => {
    const messages = [m('in', 0), m('out', 5 * MIN), m('in', 10 * MIN), m('out', 12 * MIN), m('in', 40 * HOUR), m('out', 40 * HOUR + MIN)];
    // the second owner message ends its segment; the third starts a new one
    expect(stagesOf(messages)).toEqual(['opening', 'closing', 'opening']);
  });

  it('the very last owner message is `closing` only once it is 24h old at `now`, and `mid` before that', () => {
    const messages = [m('in', 0), m('out', MIN), m('in', 2 * MIN), m('out', 3 * MIN)];
    expect(stagesOf(messages, new Date(T0 + 3 * MIN + 23 * HOUR + 59 * MIN))).toEqual(['opening', 'mid']);
    expect(stagesOf(messages, new Date(T0 + 3 * MIN + 24 * HOUR))).toEqual(['opening', 'closing']);
  });

  it('exactly 24 hours of silence counts (>=), 23h59m does not', () => {
    expect(stagesOf([m('in', 0), m('out', MIN), m('in', 2 * MIN), m('out', 3 * MIN), m('in', 3 * MIN + 24 * HOUR), m('out', 4 * MIN + 24 * HOUR)])).toEqual(['opening', 'closing', 'opening']);
    expect(stagesOf([m('in', 0), m('out', MIN), m('in', 2 * MIN), m('out', 3 * MIN), m('in', 3 * MIN + 23 * HOUR + 59 * MIN), m('out', 4 * MIN + 23 * HOUR + 59 * MIN)], new Date(T0 + 30 * HOUR))).toEqual(['opening', 'mid', 'mid']);
  });

  it('precedence: opening beats closing, and closing beats followup', () => {
    // a lone owner message that is also followed by silence is `opening`
    expect(stagesOf([m('in', 0), m('out', MIN)], NOW)).toEqual(['opening']);
    // an owner follow-up that ends the segment is `closing`
    expect(stagesOf([m('in', 0), m('out', MIN), m('out', 2 * MIN)], NOW)).toEqual(['opening', 'closing']);
  });

  it('does not care about input order, and breaks timestamp ties by id', () => {
    const a = m('in', 0, 'a');
    const b = m('out', 0, 'b');
    const c = m('out', MIN, 'c');
    expect(deriveStages([c, b, a], new Date(T0 + 2 * MIN))).toEqual(deriveStages([a, b, c], new Date(T0 + 2 * MIN)));
    expect([...deriveStages([c, b, a], new Date(T0 + 2 * MIN))]).toEqual([['b', 'opening'], ['c', 'followup']]);
  });

  it('gives inbound messages no stage', () => {
    const messages = [m('in', 0), m('out', MIN)];
    expect(deriveStages(messages, NOW).size).toBe(1);
  });
});

describe('stageOfNextReply', () => {
  it('opening when nobody from the owner has spoken in the current segment, otherwise mid', () => {
    expect(stageOfNextReply([])).toBe('opening');
    expect(stageOfNextReply([m('in', 0)])).toBe('opening');
    expect(stageOfNextReply([m('in', 0), m('in', MIN)])).toBe('opening');
    expect(stageOfNextReply([m('in', 0), m('out', MIN), m('in', 2 * MIN)])).toBe('mid');
    expect(stageOfNextReply([m('out', 0), m('in', HOUR)])).toBe('mid');
  });

  it('a customer who returns after 24h+ of silence starts a new segment, even if the owner spoke before', () => {
    expect(stageOfNextReply([m('in', 0), m('out', MIN), m('in', 30 * HOUR)])).toBe('opening');
    expect(stageOfNextReply([m('in', 0), m('out', MIN), m('in', 23 * HOUR)])).toBe('mid');
    expect(stageOfNextReply([m('in', 0), m('out', MIN), m('in', 25 * HOUR), m('in', 25 * HOUR + MIN)])).toBe('opening');
  });
});
