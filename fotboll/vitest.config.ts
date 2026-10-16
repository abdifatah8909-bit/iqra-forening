import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Server tests share one database, so test files must not run in parallel.
    fileParallelism: false,
    projects: [
      { test: { name: 'shared', include: ['shared/test/**/*.test.ts'] } },
      { test: { name: 'server', include: ['server/test/**/*.test.ts'] } },
      { test: { name: 'web', include: ['web/test/**/*.test.ts'] } },
    ],
  },
});
