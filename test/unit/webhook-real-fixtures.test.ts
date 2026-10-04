import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseEnvelope } from '@/lib/whatsapp/webhook-schema';
import { splitEnvelope } from '@/lib/whatsapp/webhook-split';

/**
 * Contract tests for REAL Meta payloads. Drop payloads copied from Meta's webhook test tool (or production logs, with
 * personal data removed) into test/fixtures/webhooks/real/*.json and they are checked here automatically. Until then the
 * suite passes with zero files: the synthetic fixtures are what the rest of the suite uses.
 */
const DIR = 'test/fixtures/webhooks/real';
const files = existsSync(DIR) ? readdirSync(DIR).filter((file) => file.endsWith('.json')) : [];

describe('real webhook payloads', () => {
  it(`found ${files.length} real fixture(s) (add more under ${DIR})`, () => {
    expect(files.length).toBeGreaterThanOrEqual(0);
  });

  it.each(files)('%s parses and splits into replay-stable events', (file) => {
    const json = JSON.parse(readFileSync(join(DIR, file), 'utf8')) as unknown;
    const parsed = parseEnvelope(json);
    expect(parsed.ok, `envelope: ${JSON.stringify(parsed)}`).toBe(true);
    if (!parsed.ok) return;

    const items = splitEnvelope(parsed.envelope);
    expect(items.length).toBeGreaterThan(0);
    // Nothing may be silently parked: a real payload that lands in `other` with parseError means a schema gap.
    const parked = items.filter((item) => item.item.parseError === true);
    expect(parked, 'a real payload was parked as unparseable: extend webhook-schema.ts').toEqual([]);
    expect(splitEnvelope(parsed.envelope).map((item) => item.dedupeKey)).toEqual(items.map((item) => item.dedupeKey));
  });
});
