import { assertEnv } from '@/lib/env';

/** Node.js-only startup: fail fast, naming the variable, if the environment is invalid. */
export function registerNode(): void {
  assertEnv();
}
