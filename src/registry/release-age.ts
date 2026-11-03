import type { Project } from '../project.ts';
import { isObject } from '../project.ts';
import { parseVersion } from '../util/semver.ts';

export interface ReleasePolicy {
  /** Versions published after this instant are not candidates; `null` turns the gate off. */
  readonly cutoff: Date | null;
  /** Human-readable origin, shown in the report header. */
  readonly description: string;
  readonly isExempt: (name: string, version: string) => boolean;
}

interface Settings {
  readonly minutes: number;
  readonly exclude: ReadonlyArray<string>;
  readonly description: string;
}

const MINUTE = 60_000;

function patternMatcher(pattern: string): (name: string, version: string) => boolean {
  const at = pattern.indexOf('@', pattern.startsWith('@') ? 1 : 0);
  const namePart = at === -1 ? pattern : pattern.slice(0, at);
  const versions =
    at === -1
      ? null
      : pattern
          .slice(at + 1)
          .split('||')
          .map((entry) => entry.trim().replace(/^npm:/, ''));
  const escaped = namePart
    .split('*')
    .map((part) => part.replaceAll(/[.+?^${}()|[\]\\]/g, String.raw`\$&`))
    .join('.*');
  const regex = new RegExp(`^${escaped}$`);
  return (name, version) =>
    regex.test(name) && (versions === null || versions.includes(version) || versions.includes('*'));
}

/** Yarn durations are minutes when bare, or a number with a `s`, `m`, `h`, `d` or `w` unit. */
function parseDurationMinutes(value: unknown): number {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value !== 'string') {
    return 0;
  }
  const match = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)?\s*$/.exec(value);
  if (match === null) {
    return 0;
  }
  const amount = Number(match[1]);
  const factors: Record<string, number> = {
    ms: 1 / 60_000,
    s: 1 / 60,
    m: 1,
    h: 60,
    d: 1440,
    w: 10_080,
  };
  return amount * (factors[match[2] ?? 'm'] ?? 1);
}

function stringList(value: unknown): Array<string> {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function pnpmSettings(project: Project, npmrc: ReadonlyMap<string, string>): Settings {
  const yaml = project.workspaceYaml ?? {};
  const pnpmField = isObject(project.manifest['pnpm']) ? project.manifest['pnpm'] : {};
  const configured =
    yaml['minimumReleaseAge'] ?? pnpmField['minimumReleaseAge'] ?? npmrc.get('minimum-release-age');
  const exclude = stringList(
    yaml['minimumReleaseAgeExclude'] ?? pnpmField['minimumReleaseAgeExclude'],
  );
  if (configured !== undefined) {
    return { minutes: Number(configured) || 0, exclude, description: 'pnpm minimumReleaseAge' };
  }
  // pnpm 11 turned the gate on by default, at one day
  const major = parseVersion(project.pmVersion ?? '')?.major ?? 11;
  return {
    minutes: major >= 11 ? 1440 : 0,
    exclude,
    description: 'pnpm default minimumReleaseAge',
  };
}

function settingsFor(project: Project, npmrc: ReadonlyMap<string, string>): Settings {
  switch (project.pm) {
    case 'pnpm':
      return pnpmSettings(project, npmrc);
    case 'npm': {
      const days = Number(npmrc.get('min-release-age') ?? 0) || 0;
      return { minutes: days * 1440, exclude: [], description: 'npm min-release-age' };
    }
    case 'yarn-berry':
      return {
        minutes: parseDurationMinutes(project.yarnrc?.['npmMinimalAgeGate']),
        exclude: stringList(project.yarnrc?.['npmPreapprovedPackages']),
        description: 'yarn npmMinimalAgeGate',
      };
    case 'bun': {
      const install = isObject(project.bunfig?.['install']) ? project.bunfig['install'] : {};
      const seconds = Number(install['minimumReleaseAge'] ?? 0) || 0;
      return {
        minutes: seconds / 60,
        exclude: stringList(install['minimumReleaseAgeExcludes']),
        description: 'bun minimumReleaseAge',
      };
    }
    case 'yarn-classic':
      return { minutes: 0, exclude: [], description: 'none' };
  }
}

function formatMinutes(minutes: number): string {
  if (minutes % 1440 === 0) {
    return `${minutes / 1440}d`;
  }
  if (minutes % 60 === 0) {
    return `${minutes / 60}h`;
  }
  return `${Math.round(minutes)}m`;
}

export function createReleasePolicy(
  project: Project,
  npmrc: ReadonlyMap<string, string>,
  now: Date,
): ReleasePolicy {
  const settings = settingsFor(project, npmrc);
  const matchers = settings.exclude.map(patternMatcher);
  return {
    cutoff: settings.minutes > 0 ? new Date(now.getTime() - settings.minutes * MINUTE) : null,
    description:
      settings.minutes > 0
        ? `${settings.description} ${formatMinutes(settings.minutes)}`
        : 'no release age gate',
    isExempt: (name, version) => matchers.some((matches) => matches(name, version)),
  };
}
