/**
 * Runs once when the Next server starts and must finish before it serves requests:
 * validate the environment so a bad config fails at boot, naming the variable.
 */
export async function register(): Promise<void> {
  const { assertEnv } = await import('@/lib/env');
  assertEnv();
}
