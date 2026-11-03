import { defineConfig } from '@marcalexiei/oxfmt-config';

export default defineConfig({
  // fixtures mirror what each package manager writes, byte for byte
  ignorePatterns: ['**/dist', '**/CHANGELOG.md', 'tests/fixtures/**', 'pnpm-lock.yaml'],
});
