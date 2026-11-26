import { defineConfig } from 'vitest/config';
import path from 'node:path';
export default defineConfig({
  resolve: { alias: { '@ragyu/core': path.resolve(__dirname, 'packages/core/src/index.ts') } },
  test: {
    environment: 'node', include: ['tests/**/*.test.ts'], testTimeout: 30000, hookTimeout: 60000, fileParallelism: false,
    env: { NODE_ENV: 'test', QUEUE_MODE: 'inline', SETUP_TOKEN: 'test-setup-token-0123456789', SCRAPER_ALLOW_HOSTS: 'localhost,127.0.0.1,localhost:0',
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5433/ragyu_test', LOGIN_MAX_FAILS: '5' },
  },
});
