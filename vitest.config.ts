import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/*/test/**/*.test.ts'],
          exclude: ['**/node_modules/**', 'packages/*/test/e2e/**'],
          environment: 'node',
          testTimeout: 30_000,
        },
      },
      {
        test: {
          name: 'e2e',
          include: ['packages/*/test/e2e/**/*.test.ts'],
          environment: 'node',
          testTimeout: 120_000,
          hookTimeout: 120_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
