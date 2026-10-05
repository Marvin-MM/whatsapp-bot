import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';
import { closeDb, getDb } from '@/lib/db';
import { getEnv } from '@/lib/env';
import { ImportError, type ImportResult, importChatInDb, resolveRoles } from '@/lib/import/import-chat';
import { ExportParseError, type ParsedExport, parseWhatsAppExport } from '@/lib/import/parse-export';
import { ask } from './lib/prompt';

const USAGE = `Usage: pnpm import:chats <file-or-folder> [options]

Imports WhatsApp "Export chat" .txt files (one customer per file) as history the assistant learns your style from.
Importing the same file again changes nothing. Group chats are refused.

Options:
  --me <name>          Which sender in the file is YOU, exactly as it appears in the export (asked if omitted)
  --contact <uuid>     Attach a single file to this existing contact instead of matching by phone number / name
  --date-order <o>     dmy | mdy: force day/month or month/day when the file cannot tell (it says so)
  --dry-run            Parse and report only; write nothing
  -h, --help           Show this help

Times in the file are read in OWNER_TIMEZONE. Nothing is sent anywhere: this only writes to your own database.
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    me: { type: 'string' },
    contact: { type: 'string' },
    'date-order': { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function filesIn(target: string): string[] {
  const info = statSync(target, { throwIfNoEntry: false });
  if (!info) fail(`No such file or folder: ${target}`);
  if (info.isFile()) return [target];
  return readdirSync(target)
    .filter((name) => name.toLowerCase().endsWith('.txt'))
    .sort()
    .map((name) => join(target, name));
}

function describe(result: ImportResult): string {
  const parts = [`${result.inserted} imported (${result.ownerInserted} yours, ${result.customerInserted} theirs)`];
  if (result.alreadyImported > 0) parts.push(`${result.alreadyImported} already imported`);
  if (result.alreadyPresent > 0) parts.push(`${result.alreadyPresent} already in WhatsApp history`);
  if (result.skippedDeleted > 0) parts.push(`${result.skippedDeleted} deleted skipped`);
  if (result.mediaPlaceholders > 0) parts.push(`${result.mediaPlaceholders} photos/files noted`);
  return parts.join(', ');
}

async function chooseMe(parsed: ParsedExport, remembered: string | undefined): Promise<string> {
  if (values.me) return values.me;
  if (remembered && parsed.authors.some((author) => author.trim().toLowerCase() === remembered.trim().toLowerCase())) return remembered;
  if (!process.stdin.isTTY) fail('Pass --me "<your name as it appears in the export>" (this is not an interactive terminal).');
  const answer = await ask(`Which of these is you? ${parsed.authors.map((author, index) => `${index + 1}) ${author}`).join('   ')}\n> `);
  const picked = parsed.authors[Number(answer) - 1] ?? parsed.authors.find((author) => author.toLowerCase() === answer.trim().toLowerCase());
  if (!picked) fail(`"${answer}" is not one of the senders.`);
  return picked;
}

async function main(): Promise<void> {
  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }
  const target = positionals[0];
  if (!target) fail(`${USAGE}\nGive a file or a folder of exports.`);
  const order = values['date-order'];
  if (order !== undefined && order !== 'dmy' && order !== 'mdy') fail('--date-order must be dmy or mdy.');
  const files = filesIn(target);
  if (files.length === 0) fail(`No .txt files in ${target}.`);
  if (values.contact && files.length > 1) fail('--contact attaches ONE chat to one contact: give a single file.');

  const timeZone = getEnv().OWNER_TIMEZONE;
  let me: string | undefined;
  let failures = 0;
  let totalInserted = 0;

  for (const file of files) {
    const label = basename(file);
    let parsed: ParsedExport;
    try {
      parsed = parseWhatsAppExport(readFileSync(file, 'utf8'), order ? { forceDateOrder: order } : {});
    } catch (error) {
      if (!(error instanceof ExportParseError)) throw error;
      failures += 1;
      process.stderr.write(`SKIPPED ${label}: ${error.message}\n`);
      continue;
    }
    for (const warning of parsed.warnings) process.stdout.write(`WARNING ${label}: ${warning}\n`);

    try {
      me = await chooseMe(parsed, me);
      if (values['dry-run']) {
        const { counterpart } = resolveRoles(parsed, me);
        process.stdout.write(`${label}: would import ${parsed.messages.length} messages with "${counterpart}" (${parsed.format}, ${parsed.dateOrder === 'dmy' ? 'day/month' : 'month/day'} dates)\n`);
        continue;
      }
      const result = await importChatInDb(getDb(), parsed, { me, timeZone, fileLabel: label, ...(values.contact ? { contactId: values.contact } : {}) });
      totalInserted += result.inserted;
      process.stdout.write(`${label}: ${describe(result)}${result.createdContact ? ' (new contact)' : ''}\n`);
    } catch (error) {
      if (!(error instanceof ImportError)) throw error;
      failures += 1;
      process.stderr.write(`SKIPPED ${label}: ${error.message}\n`);
    }
  }

  process.stdout.write(`\n${values['dry-run'] ? 'Dry run: nothing was written.' : `Done: ${totalInserted} messages imported from ${files.length - failures} of ${files.length} files.`}\n`);
  if (!values['dry-run'] && totalInserted > 0) {
    process.stdout.write('Next: open /style in the dashboard and extract a style guide (needs at least 30 of your messages).\n');
  }
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
