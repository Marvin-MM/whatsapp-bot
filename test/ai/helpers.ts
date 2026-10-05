import { expect } from 'vitest';

/**
 * Shared by the opt-in real-model suites (`pnpm test:ai`). A model is not deterministic, so each scenario is asked SAMPLES times and must
 * hold in at least REQUIRED of them; the counts are printed so a pass at 3/3 and a pass at 2/3 are not the same news.
 */
export const RUN = process.env.AI_TESTS === '1';
export const SAMPLES = 3;
export const REQUIRED = 2;

export function holds<T>(name: string, outputs: readonly T[], check: (output: T) => boolean): void {
  const passed = outputs.filter(check).length;
  process.stdout.write(`  ${name}: ${passed}/${outputs.length}\n`);
  expect(passed, `${name} held in ${passed}/${outputs.length} samples; ${REQUIRED} are required. Outputs: ${JSON.stringify(outputs)}`).toBeGreaterThanOrEqual(REQUIRED);
}
