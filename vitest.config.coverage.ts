import { defineConfig, mergeConfig } from 'vitest/config';

import root from './vitest.config.ts';

export default mergeConfig(
  root,
  defineConfig({
    test: {
      coverage: {
        enabled: true,
        // every source file, so one no test imports counts as uncovered rather than unseen
        include: ['src/**/*.ts'],
        // run only as a process by tests/cli.spec.ts, which coverage cannot see into
        exclude: ['src/cli.ts'],
        reporter: ['text'],
        // floors just under what the tests reach, so a drop fails CI
        thresholds: { lines: 81, statements: 81, functions: 87, branches: 69 },
      },
    },
  }),
);
