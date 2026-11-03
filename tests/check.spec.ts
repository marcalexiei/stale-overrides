import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readGraph } from '../src/lockfile/read.ts';
import { loadProject } from '../src/project.ts';

import { checkFixture, FIXTURES, reasonsOf, statuses } from './helpers/fixtures.ts';
import { PACKAGES } from './helpers/packages.ts';
import type { FakeRegistry } from './helpers/registry.ts';
import { startRegistry } from './helpers/registry.ts';

let registry: FakeRegistry;

beforeAll(async () => {
  registry = await startRegistry(PACKAGES);
});

afterAll(async () => {
  await registry.close();
});

describe.each([
  ['npm', 'package-lock.json'],
  ['yarn-classic', 'yarn.lock'],
  ['yarn-berry', 'yarn.lock'],
  ['bun', 'bun.lock'],
  ['pnpm', 'pnpm-lock.yaml'],
])('%s lockfile', (pm, lockfile) => {
  it(`finds who depends on child in ${lockfile}`, async () => {
    const project = await loadProject(`${FIXTURES}/${pm}`);
    expect(project.pm).toBe(pm);
    const graph = await readGraph(project);
    const parents = graph.edgesNamed('child').map((edge) => edge.parent.name);
    expect(parents).toStrictEqual(expect.arrayContaining(['stuck', 'modern']));
  });

  it('keeps the alias while a parent still depends on the original name', async () => {
    const report = await checkFixture(pm, registry.url);
    expect(statuses(report)['old-fetch']).toBe('keep');
    expect(reasonsOf(report, 'old-fetch').join('\n')).toContain(
      'legacy-fetch@1.0.0 still depends on old-fetch ^3.0.0',
    );
  });
});

describe('npm', () => {
  it('judges global, nested, unused and alias overrides', async () => {
    const report = await checkFixture('npm', registry.url);
    expect(statuses(report)).toStrictEqual({
      child: 'keep',
      'modern>child': 'prune',
      gone: 'prune',
      'old-fetch': 'keep',
    });
    expect(reasonsOf(report, 'child')).toContain(
      'fixture-npm depends on stuck 1.0.0, and stuck@1.0.0 asks for child ^1.0.0, which resolves to 1.2.0, outside ^2.0.0',
    );
    expect(reasonsOf(report, 'gone')).toStrictEqual(['nothing in the lockfile depends on gone']);
    expect(report.exitCode).toBe(1);
  });

  it('says when updating the parent would end the need', async () => {
    const report = await checkFixture('npm', registry.url);
    expect(reasonsOf(report, 'child')).toContain(
      '  updating fixable to 1.1.0 would end the need (fixture-npm depends on fixable ^1.0.0)',
    );
  });

  it('honours min-release-age: child@2.1.0 is an hour old, so ^2 lands on 2.0.0', async () => {
    const report = await checkFixture('npm', registry.url);
    expect(report.releaseAge).toBe('npm min-release-age 1d');
    expect(reasonsOf(report, 'modern>child').join('\n')).toContain('already resolves to 2.0.0');
    expect(registry.requests).toContain('child full');
  });
});

describe('yarn', () => {
  it('reads classic `**/` and `parent/` keys, with no release age gate', async () => {
    const report = await checkFixture('yarn-classic', registry.url);
    expect(statuses(report)).toStrictEqual({
      '**/child': 'keep',
      'modern/child': 'prune',
      gone: 'prune',
      'old-fetch': 'keep',
    });
    expect(reasonsOf(report, 'modern/child').join('\n')).toContain('already resolves to 2.1.0');
  });

  it('reads berry descriptors and npmMinimalAgeGate', async () => {
    const report = await checkFixture('yarn-berry', registry.url);
    expect(report.releaseAge).toBe('yarn npmMinimalAgeGate 1d');
    expect(statuses(report)).toStrictEqual({
      child: 'keep',
      'modern/child': 'prune',
      gone: 'prune',
      'old-fetch': 'keep',
    });
  });
});

describe('bun', () => {
  it('reads overrides, resolutions and bunfig minimumReleaseAge', async () => {
    const report = await checkFixture('bun', registry.url);
    expect(report.releaseAge).toBe('bun minimumReleaseAge 1d');
    expect(statuses(report)).toStrictEqual({
      child: 'keep',
      'old-fetch': 'keep',
      'modern/child': 'prune',
      gone: 'prune',
    });
  });
});

describe('pnpm', () => {
  it('judges catalogs, selectors, aliases and removals', async () => {
    const report = await checkFixture('pnpm', registry.url);
    expect(statuses(report)).toStrictEqual({
      gone: 'prune',
      child: 'keep',
      'modern>child': 'prune',
      'child@<2': 'prune',
      'modern>child@^1': 'prune',
      'old-fetch': 'keep',
      'tiny>child': 'keep',
    });
  });

  it('resolves `catalog:` and names the workspace package that asks', async () => {
    const report = await checkFixture('pnpm', registry.url);
    expect(reasonsOf(report, 'child')).toContain(
      'app (packages/app) depends on stuck 1.0.0, and stuck@1.0.0 asks for child ^1.0.0, which resolves to 1.2.0, outside ^2.0.0',
    );
  });

  it('checks a removal against the registry, since the lockfile no longer has the edge', async () => {
    const report = await checkFixture('pnpm', registry.url);
    expect(reasonsOf(report, 'tiny>child')).toStrictEqual([
      'fixture-pnpm depends on tiny 1.0.0, and tiny@1.0.0 still depends on child ^1.0.0',
    ]);
  });

  it('prunes a selector that no dependent range falls inside', async () => {
    const report = await checkFixture('pnpm', registry.url);
    expect(reasonsOf(report, 'modern>child@^1')[0]).toBe(
      'no dependent asks for child within the selector ^1',
    );
  });
});

describe('failures', () => {
  it('reports ERROR, never PRUNE, when the registry fails', async () => {
    const flaky = await startRegistry(PACKAGES, new Set(['modern', 'child']));
    try {
      const report = await checkFixture('npm', flaky.url);
      expect(statuses(report)['modern>child']).toBe('error');
      expect(reasonsOf(report, 'modern>child')[0]).toMatch(/HTTP 500/);
      expect(report.exitCode).toBe(2);
    } finally {
      await flaky.close();
    }
  }, 15_000);

  it('reports ERROR when a parent is missing from the registry', async () => {
    const { stuck: _stuck, ...withoutStuck } = PACKAGES;
    const partial = await startRegistry(withoutStuck);
    try {
      const report = await checkFixture('npm', partial.url);
      expect(statuses(report)['child']).toBe('error');
      expect(reasonsOf(report, 'child')[0]).toContain('stuck is not in the registry');
    } finally {
      await partial.close();
    }
  });
});
