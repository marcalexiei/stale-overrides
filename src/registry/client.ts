import { setTimeout as sleep } from 'node:timers/promises';

import { isObject } from '../project.ts';
import {
  compareVersions,
  isPrerelease,
  isRange,
  maxSatisfying,
  satisfies,
} from '../util/semver.ts';

import type { RegistryConfig } from './config.ts';
import type { ReleasePolicy } from './release-age.ts';

export class RegistryError extends Error {
  override name = 'RegistryError';
}

export interface VersionInfo {
  /** `dependencies`, then `optionalDependencies`, then `peerDependencies`, first one wins. */
  readonly deps: ReadonlyMap<string, string>;
  readonly deprecated: boolean;
}

export interface Packument {
  readonly name: string;
  readonly versions: ReadonlyMap<string, VersionInfo>;
  readonly distTags: Readonly<Record<string, string>>;
  readonly modified: Date | null;
  /** Publish times, only present in the full document. */
  readonly times: ReadonlyMap<string, Date> | null;
}

export interface Registry {
  readonly packument: (name: string) => Promise<Packument>;
}

const ACCEPT = {
  abbreviated: 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*',
  full: 'application/json',
} as const;
const TIMEOUT_MS = 30_000;
const RETRY_DELAYS_MS = [500, 1500];
const CONCURRENCY = 16;

function parseDate(value: unknown): Date | null {
  if (typeof value !== 'string') {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function parsePackument(name: string, raw: unknown): Packument {
  if (!isObject(raw) || !isObject(raw['versions'])) {
    throw new RegistryError(`the registry sent no versions for ${name}`);
  }
  const versions = new Map<string, VersionInfo>();
  for (const [version, record] of Object.entries(raw['versions'])) {
    if (!isObject(record)) {
      continue;
    }
    const deps = new Map<string, string>();
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      const entries = record[field];
      if (!isObject(entries)) {
        continue;
      }
      for (const [dep, spec] of Object.entries(entries)) {
        if (typeof spec === 'string' && !deps.has(dep)) {
          deps.set(dep, spec);
        }
      }
    }
    versions.set(version, { deps, deprecated: typeof record['deprecated'] === 'string' });
  }
  const distTags: Record<string, string> = {};
  if (isObject(raw['dist-tags'])) {
    for (const [tag, version] of Object.entries(raw['dist-tags'])) {
      if (typeof version === 'string') {
        distTags[tag] = version;
      }
    }
  }
  let times: Map<string, Date> | null = null;
  if (isObject(raw['time'])) {
    times = new Map();
    for (const version of versions.keys()) {
      const date = parseDate(raw['time'][version]);
      if (date !== null) {
        times.set(version, date);
      }
    }
  }
  return { name, versions, distTags, modified: parseDate(raw['modified']), times };
}

function semaphore(limit: number): <Result>(task: () => Promise<Result>) => Promise<Result> {
  let active = 0;
  const queue: Array<() => void> = [];
  return async (task) => {
    if (active >= limit) {
      await new Promise<void>((resolve) => {
        queue.push(resolve);
      });
    }
    active++;
    try {
      return await task();
    } finally {
      active--;
      queue.shift()?.();
    }
  };
}

export function createRegistry(
  config: RegistryConfig,
  policy: ReleasePolicy,
  fetchImpl: typeof fetch = fetch,
): Registry {
  const cache = new Map<string, Promise<Packument>>();
  const limit = semaphore(CONCURRENCY);

  const request = async (name: string, form: keyof typeof ACCEPT): Promise<Packument> => {
    const target = config.targetFor(name);
    const url = `${target.url}/${name
      .split('/')
      .map((part) => encodeURIComponent(part))
      .join('/')}`;
    const headers: Record<string, string> = { accept: ACCEPT[form] };
    if (target.authorization !== null) {
      headers['authorization'] = target.authorization;
    }
    for (let attempt = 0; ; attempt++) {
      const delay = RETRY_DELAYS_MS[attempt];
      let response: Response;
      try {
        response = await limit(async () =>
          fetchImpl(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) }),
        );
      } catch (error) {
        if (delay === undefined) {
          throw new RegistryError(`could not fetch ${name}: ${(error as Error).message}`);
        }
        await sleep(delay);
        continue;
      }
      if (response.status === 404) {
        throw new RegistryError(`${name} is not in the registry at ${target.url}`);
      }
      if (!response.ok) {
        if ((response.status >= 500 || response.status === 429) && delay !== undefined) {
          await sleep(delay);
          continue;
        }
        throw new RegistryError(`could not fetch ${name}: HTTP ${response.status}`);
      }
      try {
        return parsePackument(name, await response.json());
      } catch (error) {
        throw error instanceof RegistryError
          ? error
          : new RegistryError(`could not read ${name}: ${(error as Error).message}`);
      }
    }
  };

  const load = async (name: string): Promise<Packument> => {
    const abbreviated = await request(name, 'abbreviated');
    const { cutoff } = policy;
    const needsTimes =
      cutoff !== null &&
      abbreviated.times === null &&
      !policy.isExempt(name, '') &&
      (abbreviated.modified === null || abbreviated.modified > cutoff);
    return needsTimes ? request(name, 'full') : abbreviated;
  };

  return {
    async packument(name) {
      let cached = cache.get(name);
      if (cached === undefined) {
        cached = load(name);
        cache.set(name, cached);
      }
      return cached;
    },
  };
}

function eligibleVersions(packument: Packument, policy: ReleasePolicy): Array<string> {
  const all = [...packument.versions.keys()];
  const { cutoff } = policy;
  const { times } = packument;
  if (cutoff === null || times === null) {
    return all;
  }
  return all.filter((version) => {
    const time = times.get(version);
    return policy.isExempt(packument.name, version) || (time !== undefined && time <= cutoff);
  });
}

function pickFrom(spec: string, versions: Array<string>, packument: Packument): string | null {
  const { latest } = packument.distTags;
  let tagged: string | null = null;
  if (latest !== undefined) {
    if (versions.includes(latest)) {
      tagged = latest;
    } else {
      // the gate hid `latest`: fall back to the newest admitted version at or below it
      const below = versions.filter(
        (version) =>
          compareVersions(version, latest) <= 0 && isPrerelease(version) === isPrerelease(latest),
      );
      tagged = below.toSorted(compareVersions).at(-1) ?? null;
    }
  }
  if (tagged !== null && satisfies(tagged, spec)) {
    return tagged;
  }
  const best = maxSatisfying(versions, spec);
  if (best !== null && packument.versions.get(best)?.deprecated === true) {
    const alternative = maxSatisfying(
      versions.filter((version) => packument.versions.get(version)?.deprecated !== true),
      spec,
    );
    return alternative ?? best;
  }
  return best;
}

/**
 * The version a fresh install would pick for `spec`: `latest` when it fits, otherwise the newest
 * match, skipping deprecated ones and versions younger than the release age gate.
 */
export function pickVersion(
  spec: string,
  packument: Packument,
  policy: ReleasePolicy,
): string | null {
  const tag = packument.distTags[spec];
  if (tag !== undefined) {
    return tag;
  }
  if (!isRange(spec)) {
    return null;
  }
  return (
    pickFrom(spec, eligibleVersions(packument, policy), packument) ??
    pickFrom(spec, [...packument.versions.keys()], packument)
  );
}
