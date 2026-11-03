import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { readOverrides } from '../src/overrides.ts';
import { loadProject } from '../src/project.ts';
import type { Override } from '../src/types.ts';
import { removeFromJson, removeFromWorkspaceYaml } from '../src/verify.ts';

import { checkFixture, FIXTURES } from './helpers/fixtures.ts';
import { PACKAGES } from './helpers/packages.ts';
import type { FakeRegistry } from './helpers/registry.ts';
import { startRegistry } from './helpers/registry.ts';

/** Stands in for `npm install --package-lock-only`: it locks child at $FAKE_CHILD. */
const FAKE_NPM = `#!/usr/bin/env node
const { readFileSync, writeFileSync } = require('node:fs');
const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'])) {
  process.stderr.write('unexpected arguments');
  process.exit(1);
}
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
lock.packages['node_modules/child'].version = process.env.FAKE_CHILD;
lock.packages[''].overridesSeen = manifest.overrides;
writeFileSync('package-lock.json', JSON.stringify(lock));
`;

let registry: FakeRegistry;
let bin: string;

beforeAll(async () => {
  registry = await startRegistry(PACKAGES);
  bin = await mkdtemp(join(tmpdir(), 'stale-overrides-bin-'));
  await writeFile(join(bin, 'npm'), FAKE_NPM);
  await chmod(join(bin, 'npm'), 0o755);
  vi.stubEnv('PATH', `${bin}${delimiter}${process.env['PATH'] ?? ''}`);
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await registry.close();
  await rm(bin, { recursive: true, force: true });
});

describe('--verify', () => {
  it('confirms a PRUNE when the fresh lockfile keeps the target in range', async () => {
    vi.stubEnv('FAKE_CHILD', '2.0.0');
    const report = await checkFixture('npm', registry.url, { verify: true });
    const modern = report.overrides.find((entry) => entry.override.key === 'modern>child');
    expect(modern?.verdict.status).toBe('prune');
    expect(modern?.verdict.verified).toBe(
      'confirmed by `npm install --package-lock-only --ignore-scripts --no-audit --no-fund` without it',
    );
  });

  it('turns a PRUNE into a KEEP when the package manager disagrees', async () => {
    vi.stubEnv('FAKE_CHILD', '1.2.0');
    const report = await checkFixture('npm', registry.url, { verify: true });
    const modern = report.overrides.find((entry) => entry.override.key === 'modern>child');
    expect(modern?.verdict.status).toBe('keep');
    expect(modern?.verdict.reasons).toStrictEqual([
      'modern@1.0.0 now gets child@1.2.0, outside ^2.0.0',
    ]);
  });

  it('leaves KEEP verdicts alone', async () => {
    vi.stubEnv('FAKE_CHILD', '2.0.0');
    const report = await checkFixture('npm', registry.url, { verify: true });
    const child = report.overrides.find((entry) => entry.override.key === 'child');
    expect(child?.verdict.verified).toBeUndefined();
  });
});

describe('removing one override from a copy', () => {
  it('deletes a nested npm key and nothing else', async () => {
    const project = await loadProject(join(FIXTURES, 'npm'));
    const nested = readOverrides(project).find((override) => override.key === 'modern>child');
    const manifest = structuredClone(project.manifest);
    expect(nested).toBeDefined();
    removeFromJson(manifest, nested as Override);
    expect(manifest['overrides']).toStrictEqual({
      child: '^2.0.0',
      modern: {},
      gone: '1.0.0',
      'old-fetch': 'npm:new-fetch@^1.0.0',
    });
  });

  it('deletes a quoted pnpm-workspace.yaml key and keeps the comments', () => {
    const text = "overrides:\n  # why\n  'a>b': ^2\n  c: 1\ncatalog:\n  'a>b': 3\n";
    expect(removeFromWorkspaceYaml(text, 'a>b')).toBe(
      "overrides:\n  # why\n  c: 1\ncatalog:\n  'a>b': 3\n",
    );
  });
});
