import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { PackageManager } from './types.ts';
import { parseToml } from './util/toml.ts';
import { parseYaml } from './util/yaml.ts';

export type Json = Record<string, unknown>;

export interface Project {
  readonly dir: string;
  readonly pm: PackageManager;
  /** The version in `packageManager`, when it names this package manager. */
  readonly pmVersion: string | null;
  readonly manifest: Json;
  readonly lockfile: string;
  readonly lockfileText: string;
  readonly workspaceYaml: Json | null;
  readonly yarnrc: Json | null;
  readonly bunfig: Json | null;
  /** Catalog name to entries; the unnamed catalog is `default`. */
  readonly catalogs: ReadonlyMap<string, Readonly<Record<string, string>>>;
}

export class ProjectError extends Error {
  override name = 'ProjectError';
}

const LOCKFILES: ReadonlyArray<readonly [string, 'npm' | 'yarn' | 'bun' | 'pnpm']> = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['bun.lock', 'bun'],
  ['yarn.lock', 'yarn'],
  ['package-lock.json', 'npm'],
  ['npm-shrinkwrap.json', 'npm'],
];

export function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function parsePackageManagerField(manifest: Json): { name: string; version: string } | null {
  const field = manifest['packageManager'];
  if (typeof field !== 'string') {
    return null;
  }
  const match = /^(npm|pnpm|yarn|bun)@([^+\s]+)/.exec(field);
  return match === null ? null : { name: match[1] ?? '', version: match[2] ?? '' };
}

function stringRecord(value: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (isObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry === 'string') {
        result[key] = entry;
      }
    }
  }
  return result;
}

function collectCatalogs(sources: ReadonlyArray<Json | null>): Map<string, Record<string, string>> {
  const catalogs = new Map<string, Record<string, string>>();
  for (const source of sources) {
    if (source === null) {
      continue;
    }
    if (isObject(source['catalog'])) {
      catalogs.set('default', { ...catalogs.get('default'), ...stringRecord(source['catalog']) });
    }
    if (isObject(source['catalogs'])) {
      for (const [name, entries] of Object.entries(source['catalogs'])) {
        catalogs.set(name, { ...catalogs.get(name), ...stringRecord(entries) });
      }
    }
  }
  return catalogs;
}

export async function loadProject(dir: string): Promise<Project> {
  const manifestText = await readOptional(join(dir, 'package.json'));
  if (manifestText === null) {
    throw new ProjectError(`no package.json in ${dir}`);
  }
  const manifest: unknown = JSON.parse(manifestText);
  if (!isObject(manifest)) {
    throw new ProjectError('package.json is not an object');
  }
  const declared = parsePackageManagerField(manifest);

  let found = LOCKFILES.filter(([file]) => existsSync(join(dir, file)));
  if (found.length === 0) {
    const binary = existsSync(join(dir, 'bun.lockb'));
    throw new ProjectError(
      binary
        ? 'bun.lockb is binary; run `bun install --save-text-lockfile` to write bun.lock'
        : `no lockfile in ${dir}`,
    );
  }
  if (found.length > 1 && declared !== null) {
    found = found.filter(([, pm]) => pm === declared.name);
  }
  const [entry] = found;
  if (entry === undefined || found.length > 1) {
    throw new ProjectError(
      'several lockfiles and no `packageManager` field to choose between them',
    );
  }
  const [lockfile, family] = entry;
  const lockfileText = (await readOptional(join(dir, lockfile))) ?? '';

  const berry = /^__metadata:/m.test(lockfileText);
  const pm: PackageManager = family === 'yarn' ? (berry ? 'yarn-berry' : 'yarn-classic') : family;

  const workspaceText = pm === 'pnpm' ? await readOptional(join(dir, 'pnpm-workspace.yaml')) : null;
  const workspaceYaml = workspaceText === null ? null : parseYaml(workspaceText);
  const yarnrcText = pm === 'yarn-berry' ? await readOptional(join(dir, '.yarnrc.yml')) : null;
  const yarnrc = yarnrcText === null ? null : parseYaml(yarnrcText);
  const bunfigText = pm === 'bun' ? await readOptional(join(dir, 'bunfig.toml')) : null;
  const bunfig = bunfigText === null ? null : parseToml(bunfigText);

  const { workspaces } = manifest;
  const catalogs = collectCatalogs([
    isObject(workspaceYaml) ? workspaceYaml : null,
    isObject(yarnrc) ? yarnrc : null,
    pm === 'bun' ? manifest : null,
    pm === 'bun' && isObject(workspaces) ? workspaces : null,
  ]);

  return {
    dir,
    pm,
    pmVersion: declared !== null && pm.startsWith(declared.name) ? declared.version : null,
    manifest,
    lockfile,
    lockfileText,
    workspaceYaml: isObject(workspaceYaml) ? workspaceYaml : null,
    yarnrc: isObject(yarnrc) ? yarnrc : null,
    bunfig,
    catalogs,
  };
}

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;

/** The spec a manifest declares for `name`, from whichever dependency field holds it. */
export function manifestSpec(manifest: Json, name: string): string | undefined {
  for (const field of DEPENDENCY_FIELDS) {
    const deps = manifest[field];
    if (isObject(deps) && typeof deps[name] === 'string') {
      return deps[name];
    }
  }
  return undefined;
}
