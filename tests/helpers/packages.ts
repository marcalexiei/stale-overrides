import type { FakePackage } from './registry.ts';

/** The instant every fixture is checked at: `child@2.1.0` is an hour old, the rest years. */
export const NOW = new Date('2026-01-01T13:00:00Z');

const OLD = '2020-01-01T00:00:00Z';

/**
 * - `stuck` still asks for `child ^1`, so `child: ^2` is needed
 * - `modern` asks for `child ^2`, so an override scoped to it is a no-op
 * - `fixable` asks for `child ^1` at 1.0.0, but 1.1.0 moved to `^2`
 * - `legacy-fetch` still depends on `old-fetch`, which an alias swaps for `new-fetch`
 * - `tiny` declares `child ^1`, which a pnpm removal drops from the lockfile
 */
export const PACKAGES: Record<string, FakePackage> = {
  child: {
    versions: {
      '1.0.0': { time: OLD },
      '1.2.0': { time: '2020-06-01T00:00:00Z' },
      '2.0.0': { time: '2021-01-01T00:00:00Z' },
      '2.1.0': { time: '2026-01-01T12:00:00Z' },
    },
  },
  stuck: { versions: { '1.0.0': { time: OLD, deps: { child: '^1.0.0' } } } },
  modern: { versions: { '1.0.0': { time: OLD, deps: { child: '^2.0.0' } } } },
  fixable: {
    versions: {
      '1.0.0': { time: OLD, deps: { child: '^1.0.0' } },
      '1.1.0': { time: '2022-01-01T00:00:00Z', deps: { child: '^2.0.0' } },
    },
  },
  'legacy-fetch': { versions: { '1.0.0': { time: OLD, deps: { 'old-fetch': '^3.0.0' } } } },
  'old-fetch': { versions: { '3.0.0': { time: OLD } } },
  'new-fetch': { versions: { '1.0.0': { time: OLD } } },
  tiny: { versions: { '1.0.0': { time: OLD, deps: { child: '^1.0.0' } } } },
};
