import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./test/support/setup.ts'],
    testTimeout: process.env.PB_FULL === '1' ? 60_000 : 20_000,
    hookTimeout: process.env.PB_FULL === '1' ? 60_000 : 20_000,
  },
});
