import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Native/worker-thread packages must not be bundled into server output.
  serverExternalPackages: ['pino', 'pino-pretty', 'thread-stream', 'postgres', 'bullmq', 'ioredis'],
};

export default config;
