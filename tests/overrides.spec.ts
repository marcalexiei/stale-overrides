import { describe, expect, it } from 'vitest';

import { parseYarnKey, readOverrides, splitPnpmKey } from '../src/overrides.ts';
import type { Json, Project } from '../src/project.ts';
import type { PackageManager } from '../src/types.ts';

function project(pm: PackageManager, manifest: Json, workspaceYaml: Json | null = null): Project {
  return {
    dir: '/fixture',
    pm,
    pmVersion: null,
    manifest,
    lockfile: 'lock',
    lockfileText: '',
    workspaceYaml,
    yarnrc: null,
    bunfig: null,
    catalogs: new Map([
      ['default', { '@types/node': '26.6.6' }],
      ['legacy', { react: '^18.3.1' }],
    ]),
  };
}

describe('npm overrides', () => {
  const overrides = readOverrides(
    project('npm', {
      dependencies: { foo: '^1.2.0' },
      overrides: {
        foo: '$foo',
        'bar@^2': '2.1.0',
        baz: { '.': '1.0.0', qux: { quux: '3.0.0' } },
        alias: 'npm:other@^1',
      },
    }),
  );

  it('flattens nested objects into `>` keys, with `.` as the parent itself', () => {
    expect(overrides.map((override) => override.key)).toStrictEqual([
      'foo',
      'bar@^2',
      'baz',
      'baz>qux>quux',
      'alias',
    ]);
  });

  it('scopes a nested override to its ancestors, anywhere above', () => {
    const nested = overrides.find((override) => override.key === 'baz>qux>quux');
    expect(nested?.chain.map((link) => [link.selector.name, link.relation])).toStrictEqual([
      ['baz', 'ancestor'],
      ['qux', 'ancestor'],
    ]);
    expect(nested?.path).toStrictEqual(['baz', 'qux', 'quux']);
  });

  it('resolves `$name` from the root dependencies and keeps selectors', () => {
    expect(overrides[0]?.value).toStrictEqual({ kind: 'range', range: '^1.2.0' });
    expect(overrides[1]?.target).toStrictEqual({ name: 'bar', range: '^2' });
  });

  it('treats an alias to another package as a replacement', () => {
    expect(overrides[4]?.value).toStrictEqual({ kind: 'replacement', spec: 'npm:other@^1' });
  });
});

describe('pnpm overrides', () => {
  const overrides = readOverrides(
    project(
      'pnpm',
      { pnpm: { overrides: { 'qar@1>zoo': '2' } } },
      {
        overrides: {
          'sitemap>@types/node': 'catalog:default',
          'foo@>=1 <2': '-',
          react: 'catalog:legacy',
          missing: 'catalog:',
          'node-fetch': 'npm:node-fetch-native@^1.6.7',
          'foo>bar': 'npm:bar@^3',
        },
      },
    ),
  );

  it('splits `parent>child` but not a `>` inside a range', () => {
    expect(splitPnpmKey('@octokit/graphql-schema>graphql')).toStrictEqual([
      '@octokit/graphql-schema',
      'graphql',
    ]);
    expect(splitPnpmKey('foo@>=1 <2')).toStrictEqual(['foo@>=1 <2']);
    expect(splitPnpmKey('foo@>1>bar@<2')).toStrictEqual(['foo@>1', 'bar@<2']);
  });

  it('reads both sources with direct parents', () => {
    const [qar, sitemap] = overrides;
    expect(qar?.source).toBe('package.json#pnpm.overrides');
    expect(qar?.chain).toStrictEqual([
      { selector: { name: 'qar', range: '1' }, relation: 'direct' },
    ]);
    expect(sitemap?.source).toBe('pnpm-workspace.yaml#overrides');
  });

  it('resolves catalogs, removals and aliases', () => {
    expect(overrides.map((override) => override.value)).toStrictEqual([
      { kind: 'range', range: '2' },
      { kind: 'range', range: '26.6.6' },
      { kind: 'removal' },
      { kind: 'range', range: '^18.3.1' },
      { kind: 'invalid', reason: 'catalog "default" has no entry for missing' },
      { kind: 'replacement', spec: 'npm:node-fetch-native@^1.6.7' },
      { kind: 'range', range: '^3' },
    ]);
  });
});

describe('yarn resolutions', () => {
  it.each([
    ['child', [], 'child'],
    ['**/child', [], 'child'],
    ['parent/child', [['parent', 'direct']], 'child'],
    ['parent/**/child', [['parent', 'ancestor']], 'child'],
    ['@s/a/@s/b', [['@s/a', 'direct']], '@s/b'],
    [
      'a/b/c',
      [
        ['a', 'direct'],
        ['b', 'direct'],
      ],
      'c',
    ],
  ])('reads %s', (key, chain, target) => {
    const parsed = parseYarnKey(key);
    expect(parsed.chain.map((link) => [link.selector.name, link.relation])).toStrictEqual(chain);
    expect(parsed.target.name).toBe(target);
  });

  it('strips the npm: protocol from a berry descriptor selector', () => {
    expect(parseYarnKey('child@npm:^1.0.0').target).toStrictEqual({
      name: 'child',
      range: '^1.0.0',
    });
  });

  it('never treats `-` as a removal outside pnpm', () => {
    const [override] = readOverrides(project('yarn-berry', { resolutions: { foo: '-' } }));
    expect(override?.value).toStrictEqual({ kind: 'replacement', spec: '-' });
  });
});

describe('bun overrides', () => {
  it('reads both `overrides` and `resolutions`', () => {
    const overrides = readOverrides(
      project('bun', { overrides: { a: '1.0.0' }, resolutions: { b: '2.0.0' } }),
    );
    expect(overrides.map((override) => override.source)).toStrictEqual([
      'package.json#overrides',
      'package.json#resolutions',
    ]);
  });
});
