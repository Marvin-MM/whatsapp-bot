import { describe, expect, it } from 'vitest';
import { analysisOutputSchema } from '@/lib/ai/schemas';
import { MAX_PAST_DUE_MS, type OpenTask, normaliseDescription, planOperations } from '@/lib/analysis/operations';

const NOW = new Date('2026-10-05T11:30:00Z');
const T1 = '0190aaaa-0000-7000-8000-000000000001';
const T2 = '0190aaaa-0000-7000-8000-000000000002';
const FOREIGN = '0190bbbb-0000-7000-8000-00000000ffff';
const open: OpenTask[] = [
  { id: T1, type: 'request', description: 'Send the blue dress photos', dueAt: null },
  { id: T2, type: 'followup', description: 'Call back about delivery', dueAt: new Date('2026-10-06T12:00:00Z') },
];
const plan = (operations: unknown[]) => planOperations(analysisOutputSchema.shape.operations.parse(operations), open, NOW);

describe('the output schema', () => {
  it('accepts the three operations and refuses anything else', () => {
    expect(analysisOutputSchema.safeParse({ summary: 'x', operations: [{ op: 'create', description: 'a', type: 'request', dueAt: null }, { op: 'complete', taskId: T1 }, { op: 'update', taskId: T1, dueAt: '2026-10-06T15:00:00+03:00' }] }).success).toBe(true);
    for (const bad of [
      { op: 'delete', taskId: T1 },
      { op: 'create', description: 'a', type: 'chore', dueAt: null },
      { op: 'create', description: '', type: 'request', dueAt: null },
      { op: 'create', description: 'a', type: 'request', dueAt: 'tomorrow 3pm' },
      { op: 'create', description: 'a', type: 'request', dueAt: '2026-10-06T15:00:00' }, // no offset: ambiguous, refused
      { op: 'complete', taskId: 'not-a-uuid' },
    ]) {
      expect(analysisOutputSchema.safeParse({ summary: 'x', operations: [bad] }).success, JSON.stringify(bad)).toBe(false);
    }
    expect(analysisOutputSchema.safeParse({ summary: 'x'.repeat(501), operations: [] }).success).toBe(false);
    expect(analysisOutputSchema.safeParse({ summary: 'x', operations: Array.from({ length: 11 }, () => ({ op: 'complete', taskId: T1 })) }).success).toBe(false);
  });
});

describe('planOperations', () => {
  it('accepts a sensible create, a completion and an update', () => {
    const { accepted, rejected } = plan([
      { op: 'create', description: 'Call the customer', type: 'followup', dueAt: '2026-10-06T15:00:00+03:00' },
      { op: 'complete', taskId: T1 },
      { op: 'update', taskId: T2, dueAt: '2026-10-07T09:00:00+03:00' },
    ]);
    expect(rejected).toEqual([]);
    expect(accepted).toEqual([
      { op: 'create', description: 'Call the customer', type: 'followup', dueAt: new Date('2026-10-06T12:00:00Z') },
      { op: 'complete', taskId: T1 },
      { op: 'update', taskId: T2, dueAt: new Date('2026-10-07T06:00:00Z') },
    ]);
  });

  it('REJECTS an id that is not an open task of this conversation (invented, another conversation’s) but keeps the rest', () => {
    const { accepted, rejected } = plan([
      { op: 'complete', taskId: FOREIGN },
      { op: 'update', taskId: FOREIGN, description: 'hijack' },
      { op: 'create', description: 'A real one', type: 'request', dueAt: null },
    ]);
    expect(rejected.map((r) => r.reason)).toEqual(['unknown_task', 'unknown_task']);
    expect(accepted).toHaveLength(1);
  });

  it('REJECTS due dates more than a day in the past, and allows one a few hours back (a task due "this morning")', () => {
    const justInside = new Date(NOW.getTime() - MAX_PAST_DUE_MS + 60_000).toISOString();
    const justOutside = new Date(NOW.getTime() - MAX_PAST_DUE_MS - 60_000).toISOString();
    const { accepted, rejected } = plan([
      { op: 'create', description: 'inside', type: 'reminder', dueAt: justInside },
      { op: 'create', description: 'outside', type: 'reminder', dueAt: justOutside },
      { op: 'update', taskId: T1, dueAt: '2020-01-01T00:00:00+03:00' },
    ]);
    expect(accepted.map((a) => (a.op === 'create' ? a.description : a.op))).toEqual(['inside']);
    expect(rejected.map((r) => r.reason)).toEqual(['past_due', 'past_due']);
  });

  it('uses a one-day tolerance in absolute terms: 23 hours back is fine, 25 hours back is a mistake, last year is a mistake', () => {
    const hoursBack = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();
    expect(MAX_PAST_DUE_MS).toBe(24 * 3_600_000);
    const { accepted, rejected } = plan([
      { op: 'create', description: 'twenty-three hours back', type: 'reminder', dueAt: hoursBack(23) },
      { op: 'create', description: 'twenty-five hours back', type: 'reminder', dueAt: hoursBack(25) },
      { op: 'create', description: 'a year back', type: 'reminder', dueAt: '2025-10-05T15:00:00+03:00' },
    ]);
    expect(accepted).toHaveLength(1);
    expect(rejected.map((r) => r.reason)).toEqual(['past_due', 'past_due']);
  });

  it('does not create what is already an open task (case, spacing and punctuation do not matter) nor the same thing twice in one answer', () => {
    const { accepted, rejected } = plan([
      { op: 'create', description: '  send THE blue dress photos!! ', type: 'request', dueAt: null },
      { op: 'create', description: 'Buy milk', type: 'reminder', dueAt: null },
      { op: 'create', description: 'buy  milk.', type: 'reminder', dueAt: null },
      { op: 'create', description: 'Buy milk', type: 'followup', dueAt: null }, // a different KIND of task is a different task
    ]);
    expect(rejected.map((r) => r.reason)).toEqual(['duplicate', 'duplicate']);
    expect(accepted.map((a) => (a.op === 'create' ? `${a.type}:${a.description}` : ''))).toEqual(['reminder:Buy milk', 'followup:Buy milk']);
  });

  it('refuses to touch a task after completing it in the same answer, and to complete twice', () => {
    const { accepted, rejected } = plan([
      { op: 'complete', taskId: T1 },
      { op: 'update', taskId: T1, description: 'Something else' },
      { op: 'complete', taskId: T1 },
    ]);
    expect(accepted).toEqual([{ op: 'complete', taskId: T1 }]);
    expect(rejected.map((r) => r.reason)).toEqual(['closed_in_batch', 'closed_in_batch']);
  });

  it('an update that changes nothing is not applied (so a re-run cannot churn the task or reset its overdue alert)', () => {
    const { accepted, rejected } = plan([
      { op: 'update', taskId: T2, dueAt: '2026-10-06T15:00:00+03:00' }, // the same instant as 12:00Z
      { op: 'update', taskId: T1, description: 'send the blue dress photos' },
      { op: 'update', taskId: T1 },
    ]);
    expect(accepted).toEqual([]);
    expect(rejected.map((r) => r.reason)).toEqual(['no_change', 'no_change', 'no_change']);
  });

  it('can clear a due date, and set one where there was none', () => {
    const { accepted } = plan([
      { op: 'update', taskId: T2, dueAt: null },
      { op: 'update', taskId: T1, dueAt: '2026-10-06T09:00:00+03:00' },
    ]);
    expect(accepted).toEqual([
      { op: 'update', taskId: T2, dueAt: null },
      { op: 'update', taskId: T1, dueAt: new Date('2026-10-06T06:00:00Z') },
    ]);
  });

  it('an empty operation list is fine', () => {
    expect(plan([])).toEqual({ accepted: [], rejected: [] });
  });
});

describe('normaliseDescription', () => {
  it('compares meaning, not typography', () => {
    expect(normaliseDescription('  Send the PHOTOS!! ')).toBe('send the photos');
    expect(normaliseDescription('Oli otya? — call back')).toBe('oli otya call back');
    expect(normaliseDescription('!!!')).toBe('');
  });
});
