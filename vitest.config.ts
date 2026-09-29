import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./test/support/setup.ts'],
    testTimeout: process.env.PB_FULL === '1' ? 60_000 : 20_000,
    hookTimeout: process.env.PB_FULL === '1' ? 60_000 : 20_000,
    // Worktrees de agentes (.claude/worktrees) e o scratchpad trazem CÓPIAS do
    // repo: sem isto o `npm test` roda os testes de cada cópia junto.
    exclude: [...configDefaults.exclude, '.claude/**', 'scratchpad/**'],
  },
});
