import { describe, expect, it } from 'vitest';

import {
  compareVersions,
  intersects,
  maxSatisfying,
  parseRange,
  satisfies,
  subset,
} from '../src/util/semver.ts';

describe('range matching', () => {
  it.each([
    ['1.2.3', '^1.0.0', true],
    ['2.0.0', '^1.0.0', false],
    ['0.2.5', '^0.2.0', true],
    ['0.3.0', '^0.2.0', false],
    ['0.0.4', '^0.0.3', false],
    ['1.2.9', '~1.2.3', true],
    ['1.3.0', '~1.2.3', false],
    ['1.9.9', '1.x', true],
    ['2.0.0', '1.x', false],
    ['1.5.0', '>=1.2.0 <2', true],
    ['2.0.0', '>=1.2.0 <2', false],
    ['1.0.0', '<1', false],
    ['1.9.0', '<=1', true],
    ['1.5.0', '1.2 - 1.6', true],
    ['1.7.0', '1.2 - 1.6', false],
    ['3.0.0', '^1 || ^3', true],
    ['5.0.0', '*', true],
    ['5.0.0', '', true],
    ['2.0.0-beta.1', '^1.0.0', false],
    ['1.2.3-beta.2', '>=1.2.3-beta.1 <2', true],
    ['1.2.4-beta.2', '>=1.2.3-beta.1 <2', false],
  ])('%s in %s is %s', (version, range, expected) => {
    expect(satisfies(version, range)).toBe(expected);
  });

  it('lets prereleases through when asked', () => {
    expect(satisfies('2.0.0-beta.1', '>=1', true)).toBe(true);
  });

  it('refuses what is not a range', () => {
    expect(parseRange('latest')).toBeNull();
    expect(parseRange('npm:foo@1')).toBeNull();
    expect(parseRange('github:a/b')).toBeNull();
  });
});

describe('ordering', () => {
  it('orders prereleases before their release', () => {
    expect(compareVersions('1.0.0-alpha', '1.0.0')).toBe(-1);
    expect(compareVersions('1.0.0-alpha.2', '1.0.0-alpha.10')).toBe(-1);
    expect(compareVersions('1.0.0-alpha', '1.0.0-beta')).toBe(-1);
  });

  it('picks the newest match', () => {
    expect(maxSatisfying(['1.0.0', '1.2.0', '2.0.0'], '^1')).toBe('1.2.0');
    expect(maxSatisfying(['1.0.0'], '^2')).toBeNull();
  });
});

describe('set relations', () => {
  it('finds overlapping ranges', () => {
    expect(intersects('^1.2.0', '>=1.5.0')).toBe(true);
    expect(intersects('^1.2.0', '^2')).toBe(false);
    expect(intersects('1.x || 3.x', '>=3.1')).toBe(true);
  });

  it('tells a subset apart', () => {
    expect(subset('^1.2.0', '<2')).toBe(true);
    expect(subset('^1.2.0', '<1.5')).toBe(false);
    expect(subset('1.2.3', '^1')).toBe(true);
    expect(subset('^1 || ^2', '>=1 <3')).toBe(true);
    expect(subset('^2.0.0', '^1')).toBe(false);
  });
});
