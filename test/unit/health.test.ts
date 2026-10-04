import { describe, expect, it } from 'vitest';
import { withDeadline } from '@/lib/async';
import { checkHealth } from '@/lib/health';

const ok = () => Promise.resolve('fine');
const fail = () => Promise.reject(new Error('connect ECONNREFUSED 10.0.0.5:5432 password=hunter2'));
const hang = () => new Promise<never>(() => undefined);

describe('checkHealth', () => {
  it('reports ok when every dependency answers', async () => {
    expect(await checkHealth({ db: ok, redis: ok })).toEqual({ ok: true, db: true, redis: true });
  });

  it('reports which dependency is down and flips ok to false', async () => {
    expect(await checkHealth({ db: fail, redis: ok })).toEqual({ ok: false, db: false, redis: true });
    expect(await checkHealth({ db: ok, redis: fail })).toEqual({ ok: false, db: true, redis: false });
    expect(await checkHealth({ db: fail, redis: fail })).toEqual({ ok: false, db: false, redis: false });
  });

  it('treats a dependency that never answers as down, within the timeout', async () => {
    const started = Date.now();
    const result = await checkHealth({ db: ok, redis: hang }, 150);
    expect(result).toEqual({ ok: false, db: true, redis: false });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('probes in parallel, so total time is the slowest probe and not the sum', async () => {
    const slow = () => new Promise<void>((resolve) => setTimeout(resolve, 120));
    const started = Date.now();
    await checkHealth({ db: slow, redis: slow }, 1000);
    expect(Date.now() - started).toBeLessThan(230);
  });

  it('never leaks error text, hosts or credentials in the (public) result', async () => {
    const result = await checkHealth({ db: fail, redis: fail });
    expect(JSON.stringify(result)).not.toMatch(/ECONNREFUSED|hunter2|10\.0\.0\.5/);
    expect(Object.keys(result).sort()).toEqual(['db', 'ok', 'redis']);
  });

  it('survives a probe that throws synchronously', async () => {
    const result = await checkHealth({
      db: () => {
        throw new Error('sync boom');
      },
      redis: ok,
    });
    expect(result).toEqual({ ok: false, db: false, redis: true });
  });
});

describe('withDeadline', () => {
  it('resolves with the value when the promise wins', async () => {
    expect(await withDeadline(Promise.resolve(42), 500, () => new Error('late'))).toBe(42);
  });

  it('rejects with the supplied error when the deadline wins', async () => {
    await expect(withDeadline(hang(), 50, () => new TypeError('too slow'))).rejects.toThrow(TypeError);
  });

  it('propagates the original rejection when the promise fails first', async () => {
    await expect(withDeadline(Promise.reject(new Error('real failure')), 500, () => new Error('late'))).rejects.toThrow('real failure');
  });

  it('does not raise an unhandled rejection when the loser rejects after the deadline', async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', listener);
    try {
      const lateFailure = new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('after deadline')), 80));
      await expect(withDeadline(lateFailure, 20, () => new Error('deadline'))).rejects.toThrow('deadline');
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', listener);
    }
  });
});
