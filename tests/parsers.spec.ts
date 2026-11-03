import { describe, expect, it } from 'vitest';

import { parseYarnClassic } from '../src/lockfile/read.ts';
import { parseJsonc } from '../src/util/jsonc.ts';
import { parseToml } from '../src/util/toml.ts';
import { parseYaml, parseYamlDocuments } from '../src/util/yaml.ts';

describe('yaml', () => {
  it('reads block and flow collections with comments', () => {
    const text = [
      'packages:',
      '- packages/*   # every package',
      "- 'apps/*'",
      'overrides:',
      "  '@scope/a>b': ^2.0.0",
      '  sitemap>@types/node: catalog:default',
      '  c@<2: "1.0.0"',
      'resolution: {integrity: sha512-abc==, tarball: https://x.test/a.tgz}',
      'cpu: [arm64, x64]',
      'empty: {}',
      'age: 4320',
      'flag: true',
      'version: 1.0.0',
      "lockfileVersion: '9.0'",
    ].join('\n');
    expect(parseYaml(text)).toStrictEqual({
      packages: ['packages/*', 'apps/*'],
      overrides: {
        '@scope/a>b': '^2.0.0',
        'sitemap>@types/node': 'catalog:default',
        'c@<2': '1.0.0',
      },
      resolution: { integrity: 'sha512-abc==', tarball: 'https://x.test/a.tgz' },
      cpu: ['arm64', 'x64'],
      empty: {},
      age: 4320,
      flag: true,
      version: '1.0.0',
      lockfileVersion: '9.0',
    });
  });

  it('reads mappings inside sequences, block scalars and escapes', () => {
    const text =
      "list:\n  - name: a\n    value: 1\n  - b\nnote: |\n  one\n  two\nquote: \"a\\\"b\"\nsingle: 'it''s'\n";
    expect(parseYaml(text)).toStrictEqual({
      list: [{ name: 'a', value: 1 }, 'b'],
      note: 'one\ntwo\n',
      quote: 'a"b',
      single: "it's",
    });
  });

  it('splits documents', () => {
    expect(parseYamlDocuments('---\na: 1\n---\nb: 2\n')).toStrictEqual([{ a: 1 }, { b: 2 }]);
  });

  it('refuses anchors instead of misreading them', () => {
    expect(() => parseYaml('a: &x 1\nb: *x\n')).toThrow(/not supported/);
  });
});

describe('toml', () => {
  it('reads tables, arrays and inline tables', () => {
    const text = [
      '[install]',
      'minimumReleaseAge = 259_200 # three days',
      'minimumReleaseAgeExcludes = ["@types/bun", \'typescript@5.4.5\']',
      'registry = { url = "https://r.test", token = "$TOKEN" }',
      '[install.scopes]',
      'myorg = "https://u:p@r.test/"',
    ].join('\n');
    expect(parseToml(text)).toStrictEqual({
      install: {
        minimumReleaseAge: 259_200,
        minimumReleaseAgeExcludes: ['@types/bun', 'typescript@5.4.5'],
        registry: { url: 'https://r.test', token: '$TOKEN' },
        scopes: { myorg: 'https://u:p@r.test/' },
      },
    });
  });
});

describe('jsonc', () => {
  it('drops comments and trailing commas but not string content', () => {
    expect(parseJsonc('{ "a": "x // y", /* c */ "b": [1, 2,], }')).toStrictEqual({
      a: 'x // y',
      b: [1, 2],
    });
  });
});

describe('yarn classic lockfile', () => {
  it('reads descriptors, fields and dependency sections', () => {
    const text = [
      '# yarn lockfile v1',
      '',
      '"@a/b@^1.0.0", "@a/b@^1.1.0":',
      '  version "1.2.0"',
      '  dependencies:',
      '    c "^2.0.0"',
    ].join('\n');
    expect(parseYarnClassic(text)).toStrictEqual([
      {
        descriptors: ['@a/b@^1.0.0', '@a/b@^1.1.0'],
        fields: { version: '1.2.0' },
        deps: { dependencies: { c: '^2.0.0' } },
      },
    ]);
  });
});
