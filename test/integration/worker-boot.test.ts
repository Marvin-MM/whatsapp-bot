import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { heartbeatKey } from '../../worker/runtime';
import { createTestRedis } from '../helpers/redis';

let redis: Redis;
const children: ChildProcess[] = [];
const prefix = () => process.env.BULLMQ_PREFIX ?? 'wab-test';

beforeAll(() => {
  redis = createTestRedis();
});

afterAll(async () => {
  for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
  await redis.del(heartbeatKey(prefix()));
  await redis.quit();
});

/** Starts the real worker entrypoint the way `pnpm worker` does: tsx with the react-server condition. */
function startWorker(env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, ['--conditions=react-server', '--import', 'tsx', 'worker/index.ts'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  return { child, output: () => ({ stdout, stderr }) };
}

async function until(condition: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

describe('worker process', () => {
  it('boots under tsx with server-only modules, publishes a heartbeat, and shuts down cleanly on SIGTERM (exit 0)', async () => {
    await redis.del(heartbeatKey(prefix()));
    const { child, output } = startWorker({ ...process.env, LOG_LEVEL: 'info', NODE_ENV: 'test' });

    await until(() => output().stdout.includes('worker ready'));
    expect(await redis.get(heartbeatKey(prefix()))).not.toBeNull();

    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const [code] = (await exited) as [number | null];

    expect(code).toBe(0);
    expect(output().stdout).toContain('worker shutting down');
    expect(output().stdout).toContain('worker stopped');
    // A stopped worker must not look alive to the web health check.
    expect(await redis.get(heartbeatKey(prefix()))).toBeNull();
  }, 30_000);

  it('exits 1 and names the variable when META_APP_SECRET is missing', async () => {
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'test' };
    delete env.META_APP_SECRET;
    const { child, output } = startWorker(env);

    const [code] = (await once(child, 'exit')) as [number | null];
    expect(code).toBe(1);
    expect(output().stderr).toContain('META_APP_SECRET');
  }, 30_000);

  it('exits 1 without starting any worker when the database/redis URL is malformed', async () => {
    const { child, output } = startWorker({ ...process.env, NODE_ENV: 'test', REDIS_URL: 'http://not-redis' });
    const [code] = (await once(child, 'exit')) as [number | null];
    expect(code).toBe(1);
    expect(output().stderr).toContain('REDIS_URL');
    expect(output().stdout).not.toContain('worker ready');
  }, 30_000);
});
