import 'server-only';
import pino from 'pino';
import { getEnv } from '@/lib/env';

/** Keys whose values must never reach a log line: tokens, message bodies, phone numbers. */
const REDACT_KEYS = [
  'token',
  'accessToken',
  'authorization',
  'password',
  'secret',
  'body',
  'content',
  'text',
  'phone',
  'phone_e164',
  'wa_id',
  'from',
];

export const REDACT_PATHS = REDACT_KEYS.flatMap((key) => [key, `*.${key}`, `headers.${key}`]);

/** Mask a phone number or WhatsApp id to its last four characters. */
export function maskPhone(value: string): string {
  const digits = value.replace(/\s+/g, '');
  if (digits.length <= 4) return '****';
  return `****${digits.slice(-4)}`;
}

let instance: pino.Logger | undefined;

function build(): pino.Logger {
  const env = getEnv();
  return pino({
    level: env.LOG_LEVEL,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    // pino-pretty is dev-only and never imported in production.
    ...(env.NODE_ENV === 'development' ? { transport: { target: 'pino-pretty' } } : {}),
  });
}

function getLogger(): pino.Logger {
  instance ??= build();
  return instance;
}

/** Lazy so importing this module never forces env validation (e.g. during `next build`). */
export const logger: pino.Logger = new Proxy({} as pino.Logger, {
  get(_target, prop) {
    const target = getLogger();
    const value: unknown = Reflect.get(target, prop);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});
