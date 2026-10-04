import { parseArgs } from 'node:util';
import { eq } from 'drizzle-orm';
import { writeAudit } from '@/lib/audit';
import { closeDb, getDb } from '@/lib/db';
import { user as userTable } from '@/lib/db/auth-schema';
import { settings } from '@/lib/db/schema';
import { getEnv } from '@/lib/env';
import { beginTotpEnrollment, createOwnerUser, resetOwnerCredentials } from '@/lib/owner';
import { secretFromOtpauthUri, totp } from '@/lib/totp';
import { ask, askHidden, readStdin } from './lib/prompt';

const DEFAULT_BUSINESS_NAME = 'agent_47';
const MIN_PASSWORD_LENGTH = 12;

const USAGE = `Usage: pnpm seed:owner [options]

Creates the single owner account (email from OWNER_EMAIL), enrolls TOTP, and seeds the settings row.

Options:
  --name <text>       Owner name used in drafts (prompted if omitted)
  --password-stdin    Read the password from stdin instead of prompting
  --auto-verify       Confirm TOTP with a code generated here. For CI and tests ONLY:
                      it does not prove your authenticator app works
  --reset             Existing owner: set a new password, remove TOTP, revoke all sessions
  -h, --help          Show this help
`;

const { values } = parseArgs({
  options: {
    name: { type: 'string' },
    'password-stdin': { type: 'boolean', default: false },
    'auto-verify': { type: 'boolean', default: false },
    reset: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

async function readPassword(): Promise<string> {
  if (values['password-stdin']) return readStdin();
  const first = await askHidden('Password (min 12 characters): ');
  const second = await askHidden('Repeat password: ');
  if (first !== second) fail('Passwords do not match.');
  return first;
}

async function confirmTotp(secret: string, confirm: (code: string) => Promise<void>): Promise<void> {
  if (values['auto-verify']) {
    await confirm(totp(secret));
    return;
  }
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const code = await ask('Enter the 6-digit code from your authenticator app to confirm: ');
    try {
      await confirm(code);
      return;
    } catch {
      process.stderr.write(`That code was not accepted (${attempt}/3).\n`);
    }
  }
  fail('TOTP was not confirmed. Run again with --reset to start over.');
}

async function main(): Promise<void> {
  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }

  const env = getEnv();
  const name = values.name?.trim() || (await ask('Owner name (used in drafts): '));
  if (!name) fail('An owner name is required.');

  const password = await readPassword();
  if (password.length < MIN_PASSWORD_LENGTH) fail(`The password must be at least ${MIN_PASSWORD_LENGTH} characters.`);

  const db = getDb();
  const [existing] = await db.select().from(userTable).where(eq(userTable.email, env.OWNER_EMAIL));

  let userId: string;
  if (existing) {
    if (!values.reset) {
      fail(`The owner (${env.OWNER_EMAIL}) already exists. Use --reset to set a new password and re-enroll TOTP.`);
    }
    userId = existing.id;
    await resetOwnerCredentials({ userId, password });
  } else {
    userId = (await createOwnerUser({ email: env.OWNER_EMAIL, name, password })).userId;
  }

  await db.transaction(async (tx) => {
    await tx
      .insert(settings)
      .values({ id: 1, ownerName: name, businessName: DEFAULT_BUSINESS_NAME })
      .onConflictDoUpdate({ target: settings.id, set: { ownerName: name, updatedAt: new Date() } });
    await writeAudit(tx, { actor: 'system', action: 'owner.seed', entityType: 'settings', entityId: '1', metadata: { userId } });
  });

  const enrollment = await beginTotpEnrollment({ email: env.OWNER_EMAIL, password });
  const secret = secretFromOtpauthUri(enrollment.totpURI);

  process.stdout.write(`
Add this account to your authenticator app:
  Account:     ${env.OWNER_EMAIL}
  Setup key:   ${secret}
  URI:         ${enrollment.totpURI}

Backup codes (each works once; store them somewhere safe, they are not shown again):
${enrollment.backupCodes.map((code) => `  ${code}`).join('\n')}

`);

  await confirmTotp(secret, enrollment.confirm);
  process.stdout.write(`Owner ready. Sign in at ${env.APP_URL}/login with ${env.OWNER_EMAIL}, your password and a TOTP code.\n`);
}

try {
  await main();
} finally {
  await closeDb();
}
