import { describe, expect, it } from 'vitest';
import { HEARTBEAT_INTERVAL_SECONDS, HEARTBEAT_TTL_SECONDS, WORKER_STALE_AFTER_SECONDS, heartbeatKey, judgeHeartbeat } from '@/lib/ops/worker-health';

const NOW = new Date('2026-10-05T12:00:00Z');
const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000).toISOString();

describe('judgeHeartbeat', () => {
  it('is alive with a fresh beat and says how old it is', () => {
    expect(judgeHeartbeat(ago(3), NOW)).toEqual({ alive: true, ageSeconds: 3 });
    expect(judgeHeartbeat(ago(0), NOW)).toEqual({ alive: true, ageSeconds: 0 });
  });

  it('tolerates two missed beats but not three', () => {
    expect(judgeHeartbeat(ago(WORKER_STALE_AFTER_SECONDS), NOW).alive).toBe(true);
    expect(judgeHeartbeat(ago(WORKER_STALE_AFTER_SECONDS + 1), NOW)).toEqual({ alive: false, ageSeconds: WORKER_STALE_AFTER_SECONDS + 1 });
  });

  it('no beat, or an unreadable one, is not alive', () => {
    expect(judgeHeartbeat(null, NOW)).toEqual({ alive: false, ageSeconds: null });
    expect(judgeHeartbeat('yesterday', NOW)).toEqual({ alive: false, ageSeconds: null });
    expect(judgeHeartbeat('', NOW)).toEqual({ alive: false, ageSeconds: null });
  });

  it('a beat from the future (clock skew) counts as just now, not as eternal life', () => {
    expect(judgeHeartbeat(new Date(NOW.getTime() + 10 * 60 * 1000).toISOString(), NOW)).toEqual({ alive: true, ageSeconds: 0 });
  });

  it('the staleness limit sits between one beat and the key’s expiry, so "alive" never outlasts the key', () => {
    expect(WORKER_STALE_AFTER_SECONDS).toBeGreaterThan(HEARTBEAT_INTERVAL_SECONDS);
    expect(WORKER_STALE_AFTER_SECONDS).toBeLessThan(HEARTBEAT_TTL_SECONDS);
    expect(heartbeatKey('wab')).toBe('wab:worker:heartbeat');
  });
});
