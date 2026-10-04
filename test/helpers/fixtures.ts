import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DIR = 'test/fixtures/webhooks';

/** Identities used across the webhook fixtures (see the generator notes in test/fixtures/webhooks/README.md). */
export const FIXTURE = {
  businessPhone: '256700000001',
  phoneNumberId: '100000000000001',
  wabaId: '100000000000002',
  amina: { wa: '256700123456', bsuid: 'UG.13491208655302741918', name: 'Amina Customer' },
  brian: { wa: '256700654321', bsuid: 'UG.22222222222222222222', name: 'Brian Buyer' },
  kato: { bsuid: 'UG.99999999999999999999', username: 'kato_k', name: 'Kato K' },
} as const;

/** The exact bytes of a fixture file, as Meta would POST them. */
export function fixtureBytes(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(DIR, `${name}.json`)));
}

export function fixtureJson(name: string): unknown {
  return JSON.parse(readFileSync(join(DIR, `${name}.json`), 'utf8')) as unknown;
}

export function allFixtureNames(): string[] {
  return readdirSync(DIR)
    .filter((file) => file.endsWith('.json') && file !== 'index.json')
    .map((file) => file.replace(/\.json$/, ''))
    .sort();
}

export function manifest(): Record<string, { confidence: string; source: string }> {
  return JSON.parse(readFileSync(join(DIR, 'index.json'), 'utf8')) as Record<string, { confidence: string; source: string }>;
}
