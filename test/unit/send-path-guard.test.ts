import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Structural guards for the send path (spec 6.5, CLAUDE.md "one send path"). They read the source tree, so the rule holds
 * for code that does not exist yet: a future file that talks to Meta's send endpoint, or inserts an outbound row, fails here.
 */
const ROOT = process.cwd();

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

const files = ['src', 'worker', 'scripts'].flatMap((dir) => sourceFiles(join(ROOT, dir))).map((file) => ({ path: relative(ROOT, file), text: readFileSync(file, 'utf8') }));

describe('there is ONE send path', () => {
  it('only send-message.ts imports the module that calls Meta’s send endpoint', () => {
    const importers = files.filter((file) => /from ['"][^'"]*whatsapp\/send-api['"]/.test(file.text)).map((file) => file.path);
    expect(importers).toEqual(['src/lib/send/send-message.ts']);
  });

  it('nothing outside send-api.ts builds a /messages URL on the Graph API', () => {
    const offenders = files.filter((file) => file.path !== 'src/lib/whatsapp/send-api.ts' && /\/messages[`'"]/.test(file.text) && /graph\.facebook\.com|GRAPH_ORIGIN/.test(file.text));
    expect(offenders.map((file) => file.path)).toEqual([]);
  });

  it('only the ingest handlers, the chat importer and send-message.ts insert into the messages table', () => {
    const inserters = files.filter((file) => /\.insert\(messages\)/.test(file.text)).map((file) => file.path).sort();
    // The importer writes finished history (`imported`, status sent / received); it can never produce a `queued` row, and the test below proves it.
    expect(inserters).toEqual(['src/lib/import/import-chat.ts', 'src/lib/ingest/echoes.ts', 'src/lib/ingest/history.ts', 'src/lib/ingest/messages.ts', 'src/lib/send/send-message.ts']);
  });

  it('only send-message.ts creates OUTBOUND rows that Meta has not seen yet (status queued)', () => {
    const queuers = files.filter((file) => /status:\s*'queued'/.test(file.text) && /\.insert\(/.test(file.text)).map((file) => file.path);
    expect(queuers).toEqual(['src/lib/send/send-message.ts']);
  });
});
