import { baseConfig } from '@marcalexiei/oxlint-config/base';
import { nodeConfig } from '@marcalexiei/oxlint-config/node';
import { typescriptConfig } from '@marcalexiei/oxlint-config/typescript';
import { vitestConfig } from '@marcalexiei/oxlint-config/vitest';
import { defineConfig } from 'oxlint';

export default defineConfig({
  extends: [baseConfig, typescriptConfig, nodeConfig],

  env: {
    node: true,
  },

  ignorePatterns: ['dist/**', 'tests/fixtures/**'],

  options: {
    reportUnusedDisableDirectives: 'error',
    typeAware: true,
  },

  rules: {
    // The YAML, TOML and lockfile readers walk text by index.
    'no-plusplus': 'off',
    'no-continue': 'off',
    'id-length': ['error', { exceptions: ['_', 'a', 'b', 'i', 'x', 'y'], properties: 'never' }],

    // The regexes are short and read their groups right away.
    'prefer-named-capture-group': 'off',

    // A module exports next to what it defines, so its shape reads top to bottom.
    'import/exports-last': 'off',

    // `--verify` runs one install at a time, and the readers consume files in order.
    'no-await-in-loop': 'off',

    // Verdict wording picks between two or three phrasings inline.
    'no-nested-ternary': 'off',

    // `path` is already the name of what these functions take, so the module is imported by member.
    'unicorn/import-style': [
      'error',
      { extendDefaultStyles: true, styles: { 'node:path': { named: true } } },
    ],

    // Each reader keeps its error class next to it.
    'max-classes-per-file': 'off',

    // tsc's exhaustive switches and `noImplicitReturns` already cover these.
    'default-case': 'off',
    'typescript/consistent-return': 'off',
  },

  overrides: [
    {
      files: ['tests/**/*.spec.ts'],
      ...vitestConfig,
      plugins: ['vitest'],
      rules: {
        ...vitestConfig.rules,
        // A file-level hook applies to every suite in the file; one wrapping `describe` only adds a level.
        'vitest/require-top-level-describe': 'off',
      },
    },
    {
      // Running the built entry point is all the bin shim does.
      files: ['bin.js'],
      rules: {
        'import/no-unassigned-import': 'off',
      },
    },
    {
      // The CLI reports to the terminal and says how it ended with an exit code.
      files: ['src/cli.ts'],
      rules: {
        'no-console': 'off',
        'unicorn/no-process-exit': 'off',
      },
    },
  ],
});
