import { execFile } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Report } from '../src/check.ts';

import { copyFixture, FIXTURES, fixtureEnv } from './helpers/fixtures.ts';
import { PACKAGES } from './helpers/packages.ts';
import type { FakeRegistry } from './helpers/registry.ts';
import { startRegistry } from './helpers/registry.ts';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');

let registry: FakeRegistry;

beforeAll(async () => {
  registry = await startRegistry(PACKAGES);
});

afterAll(async () => {
  await registry.close();
});

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function cli(args: ReadonlyArray<string>): Promise<Run> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { env: { ...process.env, ...fixtureEnv(registry.url), NO_COLOR: '1' } },
      (error, stdout, stderr) => {
        resolve({ code: error === null ? 0 : Number(error.code), stdout, stderr });
      },
    );
  });
}

describe('cli', () => {
  it('exits 1 when something can be pruned', async () => {
    const run = await cli([join(FIXTURES, 'npm')]);
    expect(run.code).toBe(1);
    expect(run.stdout).toContain('PRUNE  gone: 1.0.0');
    expect(run.stdout).toContain('4 overrides: 2 keep, 2 prune, 0 error');
  });

  it('prints the report as JSON', async () => {
    const run = await cli([join(FIXTURES, 'npm'), '--json']);
    const report = JSON.parse(run.stdout) as Report;
    expect(report.pm).toBe('npm');
    expect(report.overrides.map((entry) => entry.verdict.status)).toStrictEqual([
      'keep',
      'prune',
      'prune',
      'keep',
    ]);
  });

  it('exits 2 when the project cannot be read', async () => {
    const run = await cli([join(FIXTURES, 'does-not-exist')]);
    expect(run.code).toBe(2);
    expect(run.stderr).toMatch(/no package\.json/);
  });

  it('writes an empty entry per override with --init, which still fails until filled', async () => {
    const dir = await copyFixture('yarn-classic');
    try {
      const run = await cli([dir, '--init']);
      expect(run.stderr).toContain('added 4 entries to overrides.json');
      const written = JSON.parse(await readFile(join(dir, 'overrides.json'), 'utf8')) as Record<
        string,
        unknown
      >;
      expect(Object.keys(written)).toStrictEqual(['**/child', 'modern/child', 'gone', 'old-fetch']);
      expect(run.stdout).toContain('INVALID  "**/child" needs a "why"');
      expect(run.code).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('prints help', async () => {
    const run = await cli(['--help']);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('Usage: stale-overrides');
  });
});
