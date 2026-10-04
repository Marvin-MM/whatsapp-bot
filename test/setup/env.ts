// Supplies a complete, fake-but-valid environment for tests. Real env values win,
// so the same suite runs against docker compose or native Postgres/Redis.
const defaults: Record<string, string> = {
  APP_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgres://wab_app:wab_app_dev@localhost:5432/wab_test',
  DATABASE_MIGRATION_URL: 'postgres://wab_migrator:wab_migrator_dev@localhost:5432/wab_test',
  DATABASE_POOLER: 'none',
  REDIS_URL: 'redis://localhost:6379/15',
  BULLMQ_PREFIX: 'wab-test',
  LOG_LEVEL: 'silent',
  OWNER_TIMEZONE: 'Africa/Kampala',
  BETTER_AUTH_SECRET: 'test-secret-test-secret-test-secret-0123',
  BETTER_AUTH_URL: 'http://localhost:3000',
  OWNER_EMAIL: 'owner@example.test',
  META_GRAPH_VERSION: 'v25.0',
  META_APP_SECRET: 'test-meta-app-secret',
  WEBHOOK_VERIFY_TOKEN: 'test-verify-token',
  WHATSAPP_ACCESS_TOKEN: 'test-access-token',
  WHATSAPP_PHONE_NUMBER_ID: '100000000000001',
  WHATSAPP_WABA_ID: '100000000000002',
  GROQ_API_KEY: 'test-groq-key',
  LLM_MODEL_DRAFT: 'test-draft-model',
  LLM_MODEL_ANALYSIS: 'test-analysis-model',
  LLM_MODEL_VERIFY: 'test-verify-model',
  LLM_MODEL_TRANSCRIBE: 'test-transcribe-model',
  TRANSCRIBE_AUDIO: 'true',
  DRAFT_DEBOUNCE_SECONDS: '25',
  AUTOPILOT_MAX_EDIT_DISTANCE: '0.30',
  MEDIA_STORAGE_DIR: './data/media-test',
  TELEGRAM_BOT_TOKEN: 'test-telegram-token',
  TELEGRAM_CHAT_ID: '123456789',
  TELEGRAM_WEBHOOK_SECRET: 'test-telegram-secret',
};

for (const [name, value] of Object.entries(defaults)) {
  process.env[name] ??= value;
}

export const TEST_ENV_DEFAULTS: Readonly<Record<string, string>> = defaults;
