import { describe, expect, it } from 'vitest';
import { toJobId } from '@/lib/queue/enqueue';
import { QUEUE_NAMES, SCHEDULED_JOB_NAMES } from '@/lib/queue/names';
import { QUEUE_SETTINGS, defaultJobOptions } from '@/lib/queue/queues';

/** Spec 5.3 catalog, written out independently of the implementation. */
const SPEC: Record<string, { attempts: number; concurrency: number }> = {
  'process-webhook-event': { attempts: 5, concurrency: 5 },
  'download-media': { attempts: 5, concurrency: 2 },
  'generate-draft': { attempts: 3, concurrency: 2 },
  'outbound-send': { attempts: 3, concurrency: 1 },
  'autopilot-send': { attempts: 1, concurrency: 1 },
  'post-send-analysis': { attempts: 3, concurrency: 2 },
  'style-extract': { attempts: 2, concurrency: 1 },
  scheduled: { attempts: 3, concurrency: 1 },
};

describe('queue catalog (spec 5.3)', () => {
  it('has exactly the catalog queues', () => {
    expect([...QUEUE_NAMES].sort()).toEqual(Object.keys(SPEC).sort());
    expect(Object.keys(QUEUE_SETTINGS).sort()).toEqual(Object.keys(SPEC).sort());
  });

  it.each(Object.entries(SPEC))('%s uses the catalog attempts and concurrency', (name, expected) => {
    const settings = QUEUE_SETTINGS[name as keyof typeof QUEUE_SETTINGS];
    expect(settings.attempts).toBe(expected.attempts);
    expect(settings.concurrency).toBe(expected.concurrency);
  });

  it('uses exponential backoff from the catalog base delays', () => {
    const base = (name: keyof typeof QUEUE_SETTINGS) => defaultJobOptions(name).backoff;
    expect(base('process-webhook-event')).toEqual({ type: 'exponential', delay: 2000 });
    expect(base('download-media')).toEqual({ type: 'exponential', delay: 5000 });
    expect(base('generate-draft')).toEqual({ type: 'exponential', delay: 5000 });
    expect(base('post-send-analysis')).toEqual({ type: 'exponential', delay: 10000 });
  });

  it('autopilot-send is a single attempt with no backoff (a failed auto-send must fall back to approval, not retry)', () => {
    const options = defaultJobOptions('autopilot-send');
    expect(options.attempts).toBe(1);
    expect(options.backoff).toBeUndefined();
  });

  it('keeps failed jobs for 30 days (BullMQ has no dead-letter queue)', () => {
    for (const name of QUEUE_NAMES) {
      expect(defaultJobOptions(name).removeOnFail).toEqual({ age: 30 * 24 * 3600 });
    }
  });

  it('queue names are legal BullMQ names (no colon)', () => {
    for (const name of QUEUE_NAMES) expect(name).not.toContain(':');
  });

  it('has the five scheduled job names', () => {
    expect([...SCHEDULED_JOB_NAMES].sort()).toEqual(
      ['alerts-scan', 'autopilot-digest', 'purge-payloads', 'sweep-webhook-events', 'token-health'].sort(),
    );
  });
});

describe('toJobId', () => {
  it('removes every colon so BullMQ accepts the id', () => {
    for (const key of ['msg:wamid.A', 'status:wamid.A:delivered', 'echo:x', 'history:abc', 'send:0190', 'autopilot:0190']) {
      expect(toJobId(key)).not.toContain(':');
    }
  });

  it('is injective for the spec key formats, so two different events never share a job', () => {
    const keys = ['msg:wamid.A', 'status:wamid.A:sent', 'status:wamid.A:delivered', 'echo:wamid.A', 'msg:wamid.B', 'msg%3Awamid.A'];
    expect(new Set(keys.map(toJobId)).size).toBe(keys.length);
  });

  it('is stable (same key, same id) and never purely numeric (BullMQ rejects integer ids)', () => {
    expect(toJobId('msg:wamid.A')).toBe(toJobId('msg:wamid.A'));
    expect(Number.isInteger(Number(toJobId('msg:123')))).toBe(false);
  });
});
