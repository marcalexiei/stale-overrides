import { cp, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CheckOptions, Report } from '../../src/check.ts';
import { check } from '../../src/check.ts';

import { NOW } from './packages.ts';

export const FIXTURES = join(import.meta.dirname, '..', 'fixtures');

export function fixtureEnv(registryUrl: string): Record<string, string> {
  return {
    npm_config_registry: registryUrl,
    npm_config_userconfig: join(FIXTURES, 'no-such-npmrc'),
  };
}

export async function checkFixture(
  dir: string,
  registryUrl: string,
  options: Partial<CheckOptions> = {},
): Promise<Report> {
  return check({
    cwd: dir.startsWith('/') ? dir : join(FIXTURES, dir),
    now: NOW,
    env: fixtureEnv(registryUrl),
    ...options,
  });
}

/** A writable copy of a fixture, for tests that change its files. */
export async function copyFixture(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `stale-overrides-${name}-`));
  await cp(join(FIXTURES, name), dir, { recursive: true });
  return dir;
}

export function statuses(report: Report): Record<string, string> {
  return Object.fromEntries(
    report.overrides.map(({ override, verdict }) => [override.key, verdict.status]),
  );
}

export function reasonsOf(report: Report, key: string): ReadonlyArray<string> {
  return report.overrides.find((entry) => entry.override.key === key)?.verdict.reasons ?? [];
}
