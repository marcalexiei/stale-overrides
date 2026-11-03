import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { Project } from '../project.ts';
import { isObject } from '../project.ts';

const DEFAULT_REGISTRY = 'https://registry.npmjs.org';

export class ConfigError extends Error {
  override name = 'ConfigError';
}

export interface RegistryTarget {
  readonly url: string;
  readonly authorization: string | null;
}

export interface RegistryConfig {
  /** Where to fetch the packument of `name` from, and with which credentials. */
  readonly targetFor: (name: string) => RegistryTarget;
  /** The flat `.npmrc` entries, which the release-age policy also reads. */
  readonly npmrc: ReadonlyMap<string, string>;
}

type Env = Readonly<Record<string, string | undefined>>;

function envConfig(env: Env, key: string): string | undefined {
  const wanted = `npm_config_${key}`.toLowerCase();
  for (const [name, value] of Object.entries(env)) {
    if (name.toLowerCase() === wanted && value !== undefined && value !== '') {
      return value;
    }
  }
  return undefined;
}

function expandEnv(value: string, env: Env): string {
  return value.replaceAll(/(\\*)\$\{([^${}]+)\}/g, (match, slashes: string, name: string) => {
    if (slashes.length % 2 === 1) {
      return match.slice(1);
    }
    const replacement = env[name];
    if (replacement === undefined) {
      throw new ConfigError(`.npmrc refers to \${${name}}, which is not set`);
    }
    return slashes + replacement;
  });
}

export function parseNpmrc(text: string, env: Env): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || /^[#;[]/.test(trimmed)) {
      continue;
    }
    const eq = trimmed.indexOf('=');
    if (eq === -1) {
      continue;
    }
    let value = trimmed.slice(eq + 1).trim();
    if (value.length >= 2 && /^["']/.test(value) && value.endsWith(value.charAt(0))) {
      value = value.slice(1, -1);
    }
    entries.set(trimmed.slice(0, eq).trim(), expandEnv(value, env));
  }
  return entries;
}

function stripSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function assertUrl(url: string): string {
  if (!URL.canParse(url)) {
    throw new ConfigError(`invalid registry url: ${url}`);
  }
  return stripSlash(url);
}

function nerfDart(url: string): string {
  const parsed = new URL(`${url}/`);
  return `//${parsed.host}${parsed.pathname}`;
}

function npmrcAuthorization(url: string, entries: ReadonlyMap<string, string>): string | null {
  let key = nerfDart(url);
  while (key.length > 2) {
    const token = entries.get(`${key}:_authToken`);
    if (token !== undefined) {
      return `Bearer ${token}`;
    }
    const basic = entries.get(`${key}:_auth`);
    if (basic !== undefined) {
      return `Basic ${basic}`;
    }
    const username = entries.get(`${key}:username`);
    const password = entries.get(`${key}:_password`);
    if (username !== undefined && password !== undefined) {
      const decoded = Buffer.from(password, 'base64').toString();
      return `Basic ${Buffer.from(`${username}:${decoded}`).toString('base64')}`;
    }
    key = key.replace(/([^/]+|\/)$/, '');
  }
  return null;
}

function urlAuthorization(url: string): { url: string; authorization: string | null } {
  const parsed = new URL(url);
  if (parsed.username === '') {
    return { url, authorization: null };
  }
  const credentials = `${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`;
  parsed.username = '';
  parsed.password = '';
  return {
    url: stripSlash(parsed.toString()),
    authorization: `Basic ${Buffer.from(credentials).toString('base64')}`,
  };
}

function scopeOf(name: string): string | null {
  return name.startsWith('@') && name.includes('/') ? name.slice(0, name.indexOf('/')) : null;
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

interface ScopedTarget {
  readonly url: string;
  readonly authorization: string | null;
}

/** Yarn berry ignores `.npmrc`: its registry, scopes and tokens live in `.yarnrc.yml`. */
function yarnTargets(
  project: Project,
  env: Env,
): { fallback: ScopedTarget | null; scopes: Map<string, ScopedTarget> } {
  const rc = project.yarnrc;
  const scopes = new Map<string, ScopedTarget>();
  if (rc === null) {
    return { fallback: null, scopes };
  }
  const expand = (value: unknown): string | null =>
    typeof value === 'string'
      ? value.replaceAll(
          /\$\{([^}:]+)(?::-([^}]*))?\}/g,
          (_m, name: string, fallback?: string) => env[name] ?? fallback ?? '',
        )
      : null;
  const tokenFor = (entry: Record<string, unknown>): string | null => {
    const token = expand(entry['npmAuthToken']);
    if (token !== null) {
      return `Bearer ${token}`;
    }
    const ident = expand(entry['npmAuthIdent']);
    return ident === null ? null : `Basic ${Buffer.from(ident).toString('base64')}`;
  };
  const server = expand(rc['npmRegistryServer']);
  const fallback = server === null ? null : { url: assertUrl(server), authorization: tokenFor(rc) };
  if (isObject(rc['npmScopes'])) {
    for (const [scope, entry] of Object.entries(rc['npmScopes'])) {
      if (!isObject(entry)) {
        continue;
      }
      const url = expand(entry['npmRegistryServer']) ?? fallback?.url ?? DEFAULT_REGISTRY;
      scopes.set(`@${scope.replace(/^@/, '')}`, {
        url: assertUrl(url),
        authorization: tokenFor(entry),
      });
    }
  }
  return { fallback, scopes };
}

/** Bun reads `.npmrc`, and `bunfig.toml` can set the registry and scopes on top of it. */
function bunTargets(
  project: Project,
  env: Env,
): { fallback: ScopedTarget | null; scopes: Map<string, ScopedTarget> } {
  const scopes = new Map<string, ScopedTarget>();
  const install = isObject(project.bunfig?.['install']) ? project.bunfig['install'] : null;
  if (install === null) {
    return { fallback: null, scopes };
  }
  const expand = (value: string): string =>
    value.replaceAll(/\$(\w+)/g, (_m, name: string) => env[name] ?? '');
  const toTarget = (value: unknown): ScopedTarget | null => {
    if (typeof value === 'string') {
      return urlAuthorization(assertUrl(expand(value)));
    }
    if (!isObject(value) || typeof value['url'] !== 'string') {
      return null;
    }
    const { url, authorization } = urlAuthorization(assertUrl(expand(value['url'])));
    if (typeof value['token'] === 'string') {
      return { url, authorization: `Bearer ${expand(value['token'])}` };
    }
    if (typeof value['username'] === 'string' && typeof value['password'] === 'string') {
      const pair = `${expand(value['username'])}:${expand(value['password'])}`;
      return { url, authorization: `Basic ${Buffer.from(pair).toString('base64')}` };
    }
    return { url, authorization };
  };
  if (isObject(install['scopes'])) {
    for (const [scope, value] of Object.entries(install['scopes'])) {
      const target = toTarget(value);
      if (target !== null) {
        scopes.set(`@${scope.replace(/^@/, '')}`, target);
      }
    }
  }
  return { fallback: toTarget(install['registry']), scopes };
}

export async function loadRegistryConfig(project: Project, env: Env): Promise<RegistryConfig> {
  const userPath = envConfig(env, 'userconfig') ?? join(homedir(), '.npmrc');
  const npmrc = new Map<string, string>();
  for (const text of [
    await readOptional(join(project.dir, '.npmrc')),
    await readOptional(userPath),
  ]) {
    if (text === null) {
      continue;
    }
    for (const [key, value] of parseNpmrc(text, env)) {
      if (!npmrc.has(key)) {
        npmrc.set(key, value);
      }
    }
  }
  const envRegistry = envConfig(env, 'registry');
  const pmTargets =
    project.pm === 'yarn-berry'
      ? yarnTargets(project, env)
      : project.pm === 'bun'
        ? bunTargets(project, env)
        : { fallback: null, scopes: new Map<string, ScopedTarget>() };
  const npmrcDefault = assertUrl(npmrc.get('registry') ?? DEFAULT_REGISTRY);

  return {
    npmrc,
    targetFor(name) {
      if (envRegistry !== undefined) {
        const url = assertUrl(envRegistry);
        return { url, authorization: npmrcAuthorization(url, npmrc) };
      }
      const scope = scopeOf(name);
      const scoped = scope === null ? undefined : pmTargets.scopes.get(scope);
      if (scoped !== undefined) {
        return scoped;
      }
      const npmrcScoped = scope === null ? undefined : npmrc.get(`${scope}:registry`);
      if (npmrcScoped !== undefined && project.pm !== 'yarn-berry') {
        const url = assertUrl(npmrcScoped);
        return { url, authorization: npmrcAuthorization(url, npmrc) };
      }
      if (pmTargets.fallback !== null) {
        return pmTargets.fallback;
      }
      return { url: npmrcDefault, authorization: npmrcAuthorization(npmrcDefault, npmrc) };
    },
  };
}
