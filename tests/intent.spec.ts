import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { checkFixture, copyFixture, reasonsOf, statuses } from './helpers/fixtures.ts';
import { PACKAGES } from './helpers/packages.ts';
import type { FakeRegistry } from './helpers/registry.ts';
import { startRegistry } from './helpers/registry.ts';

let registry: FakeRegistry;
let dir: string;

beforeAll(async () => {
  registry = await startRegistry(PACKAGES);
  dir = await copyFixture('npm');
});

afterAll(async () => {
  await registry.close();
  await rm(dir, { recursive: true, force: true });
});

async function withIntents(intents: unknown): Promise<ReturnType<typeof checkFixture>> {
  await writeFile(join(dir, 'overrides.json'), JSON.stringify(intents));
  return checkFixture(dir, registry.url);
}

const ALL = {
  child: { why: 'stuck asks for child 1' },
  'modern>child': { why: 'old incident' },
  gone: { why: 'old cap' },
  'old-fetch': { why: 'deprecated shim' },
};

describe('overrides.json', () => {
  it('is in sync when every override has an entry', async () => {
    const report = await withIntents(ALL);
    expect(report.missingIntents).toStrictEqual([]);
    expect(report.orphanIntents).toStrictEqual([]);
    expect(report.intentProblems).toStrictEqual([]);
  });

  it('never prunes a ceiling', async () => {
    const report = await withIntents({
      ...ALL,
      gone: { why: 'never let gone reach 2.x', ceiling: true },
      'modern>child': { why: 'pinned for the audit', ceiling: true },
    });
    expect(statuses(report)).toStrictEqual({
      child: 'keep',
      'modern>child': 'keep',
      gone: 'keep',
      'old-fetch': 'keep',
    });
    expect(reasonsOf(report, 'gone')).toStrictEqual([
      'deliberate ceiling: never let gone reach 2.x',
    ]);
    expect(report.exitCode).toBe(0);
  });

  it('fails on an override without an entry and an entry without an override', async () => {
    const { gone: _gone, ...rest } = ALL;
    const report = await withIntents({ ...rest, removed: { why: 'was pruned last month' } });
    expect(report.missingIntents).toStrictEqual(['gone']);
    expect(report.orphanIntents).toStrictEqual(['removed']);
    expect(report.exitCode).toBe(1);
  });

  it('reports entries with no why, unknown fields or a ceiling that is not true', async () => {
    const report = await withIntents({
      ...ALL,
      child: { why: '' },
      gone: { why: 'x', ceiling: false },
      'old-fetch': { why: 'x', note: 'y' },
    });
    expect(report.intentProblems).toStrictEqual([
      '"child" needs a "why" saying what the override is for',
      '"gone" sets "ceiling" to something other than true',
      '"old-fetch" has unknown fields: note',
    ]);
  });

  it('treats a missing file as every override missing', async () => {
    await rm(join(dir, 'overrides.json'));
    const report = await checkFixture(dir, registry.url);
    expect(report.missingIntents).toHaveLength(4);
  });

  it('refuses a file that is not JSON', async () => {
    await writeFile(join(dir, 'overrides.json'), '{ nope');
    await expect(checkFixture(dir, registry.url)).rejects.toThrow(/not valid JSON/);
  });

  it('reads a custom path', async () => {
    await writeFile(join(dir, 'intents.json'), JSON.stringify(ALL));
    const report = await checkFixture(dir, registry.url, { intentFile: 'intents.json' });
    expect(report.missingIntents).toStrictEqual([]);
    expect(JSON.parse(await readFile(join(dir, 'intents.json'), 'utf8'))).toStrictEqual(ALL);
  });
});
