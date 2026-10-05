import type { NextConfig } from 'next';

// The fixed security headers for API responses. Pages get theirs (plus a per-request CSP nonce) from src/proxy.ts; the API is outside the proxy on
// purpose (see there). test/unit/security-headers.test.ts keeps these literals equal to BASE_SECURITY_HEADERS.
export const API_SECURITY_HEADERS = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'same-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()' },
];

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Native/worker-thread packages must not be bundled into server output.
  serverExternalPackages: ['pino', 'pino-pretty', 'thread-stream', 'postgres', 'bullmq', 'ioredis'],
  async headers() {
    return [{ source: '/api/:path*', headers: API_SECURITY_HEADERS }];
  },
};

export default config;
