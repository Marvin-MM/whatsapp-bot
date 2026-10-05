import 'server-only';
import { z } from 'zod';

/**
 * The only file allowed to read `process.env`.
 * Web and worker both validate at startup (`assertEnv`); an invalid or missing
 * variable prints its name and exits with code 1.
 */

const bool = z.enum(['true', 'false']).transform((value) => value === 'true');

const postgresUrl = z.url({ protocol: /^postgres(ql)?$/ });
const redisUrl = z.url({ protocol: /^rediss?$/ });

function isValidTimeZone(name: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/** Price per million tokens, per model id, in the owner's currency. Every number is the owner's: nothing here is a built-in price. */
export const aiPriceListSchema = z.object({
  currency: z.string().min(1).max(8),
  models: z.record(z.string().min(1), z.object({ input: z.number().min(0), output: z.number().min(0) })),
});
export type AiPriceList = z.infer<typeof aiPriceListSchema>;

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/** The configured price list, or null when none is set (or it is unusable: the env check already refuses a malformed one at startup). */
export function readAiPrices(raw: string | undefined): AiPriceList | null {
  if (raw === undefined) return null;
  const parsed = aiPriceListSchema.safeParse(parseJson(raw));
  return parsed.success ? parsed.data : null;
}

export const envSchema = z.object({
  // Core
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_URL: z.url(),
  DATABASE_URL: postgresUrl,
  DATABASE_MIGRATION_URL: postgresUrl,
  DATABASE_POOLER: z.enum(['none', 'transaction']).default('none'),
  REDIS_URL: redisUrl,
  BULLMQ_PREFIX: z.string().min(1).default('wab'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  OWNER_TIMEZONE: z.string().refine(isValidTimeZone, 'must be a valid IANA time zone'),
  // Auth
  BETTER_AUTH_SECRET: z.string().min(32, 'must be at least 32 characters'),
  BETTER_AUTH_URL: z.url(),
  OWNER_EMAIL: z.email(),
  // Meta / WhatsApp
  META_GRAPH_VERSION: z.string().regex(/^v\d+\.\d+$/, 'must look like v25.0'),
  META_APP_SECRET: z.string().min(1),
  WEBHOOK_VERIFY_TOKEN: z.string().min(1),
  WHATSAPP_ACCESS_TOKEN: z.string().min(1),
  WHATSAPP_PHONE_NUMBER_ID: z.string().min(1),
  WHATSAPP_WABA_ID: z.string().min(1),
  // AI
  GROQ_API_KEY: z.string().min(1),
  LLM_MODEL_DRAFT: z.string().min(1),
  LLM_MODEL_ANALYSIS: z.string().min(1),
  LLM_MODEL_VERIFY: z.string().min(1),
  LLM_MODEL_TRANSCRIBE: z.string().min(1),
  TRANSCRIBE_AUDIO: bool.default(true),
  DRAFT_DEBOUNCE_SECONDS: z.coerce.number().int().min(1).max(600).default(25),
  AUTOPILOT_MAX_EDIT_DISTANCE: z.coerce.number().min(0).max(1).default(0.3),
  // Optional: what the models cost, so Analytics can show a cost line. Without it only tokens are shown: a price is never guessed.
  AI_PRICE_PER_MTOK_JSON: z
    .string()
    .optional()
    .refine((value) => value === undefined || aiPriceListSchema.safeParse(parseJson(value)).success, 'must be JSON like {"currency":"USD","models":{"model-id":{"input":0.15,"output":0.6}}} (prices per million tokens)'),
  // Media
  MEDIA_STORAGE_DIR: z.string().min(1).default('./data/media'),
  // Telegram
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_CHAT_ID: z.string().min(1),
  TELEGRAM_WEBHOOK_SECRET: z.string().min(1),
});

export type Env = z.infer<typeof envSchema>;

export interface EnvIssue {
  name: string;
  message: string;
}

export type ParseEnvResult = { ok: true; env: Env } | { ok: false; issues: EnvIssue[] };

/** Treats empty strings (`KEY=` in a .env file) as unset so defaults apply and required vars fail by name. */
function dropEmpty(raw: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value !== undefined && value !== '') cleaned[key] = value;
  }
  return cleaned;
}

export function parseEnv(raw: Readonly<Record<string, string | undefined>>): ParseEnvResult {
  const result = envSchema.safeParse(dropEmpty(raw));
  if (result.success) return { ok: true, env: result.data };
  const issues = result.error.issues.map((issue) => ({
    name: String(issue.path[0] ?? '(root)'),
    message: issue.message,
  }));
  return { ok: false, issues };
}

function formatIssues(issues: EnvIssue[]): string {
  const lines = issues.map((issue) => `  - ${issue.name}: ${issue.message}`);
  return `Invalid or missing environment variables:\n${lines.join('\n')}\n`;
}

let cached: Env | undefined;

/** Validated env. Exits the process (code 1) naming every bad variable. */
export function getEnv(): Env {
  if (cached) return cached;
  const result = parseEnv(process.env);
  if (!result.ok) {
    process.stderr.write(formatIssues(result.issues));
    process.exit(1);
  }
  cached = result.env;
  return cached;
}

const migrationEnvSchema = z.object({ DATABASE_MIGRATION_URL: postgresUrl });

/** Migrations need only the migration URL; they must not require app secrets. */
export function getMigrationEnv(): z.infer<typeof migrationEnvSchema> {
  const result = migrationEnvSchema.safeParse(dropEmpty(process.env));
  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({
      name: String(issue.path[0] ?? '(root)'),
      message: issue.message,
    }));
    process.stderr.write(formatIssues(issues));
    process.exit(1);
  }
  return result.data;
}

/** `next build` runs without runtime secrets; validation is skipped then. */
export function isBuildPhase(): boolean {
  return process.env.NEXT_PHASE === 'phase-production-build';
}

/** Called at web and worker startup. */
export function assertEnv(): void {
  if (isBuildPhase()) return;
  getEnv();
}
