import { glob, readFile } from 'node:fs/promises';
import { join, normalize, posix } from 'node:path';

import type { Json, Project } from '../project.ts';
import { isObject } from '../project.ts';
import { parseJsonc } from '../util/jsonc.ts';
import { parseYaml, parseYamlDocuments } from '../util/yaml.ts';

import type { GraphNode } from './graph.ts';
import { Graph, importerNode, LockfileError, packageNode, splitNameVersion } from './graph.ts';

async function readManifest(projectDir: string, dir: string): Promise<Json> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(join(projectDir, dir, 'package.json'), 'utf8'),
    );
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function toPosix(dir: string): string {
  const result = normalize(dir).replaceAll('\\', '/').replace(/\/$/, '');
  return result === '' ? '.' : result;
}

function depsOf(entry: unknown, fields: ReadonlyArray<string>): Array<[string, string]> {
  const result: Array<[string, string]> = [];
  if (!isObject(entry)) {
    return result;
  }
  for (const field of fields) {
    const deps = entry[field];
    if (!isObject(deps)) {
      continue;
    }
    for (const [name, value] of Object.entries(deps)) {
      if (typeof value === 'string') {
        result.push([name, value]);
      } else if (isObject(value) && typeof value['version'] === 'string') {
        result.push([name, value['version']]);
      }
    }
  }
  return result;
}

const PACKAGE_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies'] as const;
const IMPORTER_FIELDS = [...PACKAGE_FIELDS, 'devDependencies'] as const;

// pnpm-lock.yaml, lockfile v6 and v9

function stripPeers(ref: string): string {
  const paren = ref.indexOf('(');
  return paren === -1 ? ref : ref.slice(0, paren);
}

async function readPnpm(project: Project): Promise<Graph> {
  const documents = parseYamlDocuments(project.lockfileText).filter((document) =>
    isObject(document),
  );
  // pnpm 11+ writes its own install as a first document; the project's is the last one
  const lock = documents.at(-1);
  if (lock === undefined) {
    throw new LockfileError('pnpm-lock.yaml is empty');
  }
  const major = Number(String(lock['lockfileVersion']));
  if (!(major >= 6)) {
    throw new LockfileError(
      `pnpm lockfile version ${String(lock['lockfileVersion'])} is not supported`,
    );
  }
  const graph = new Graph();
  const snapshots = major >= 9 ? lock['snapshots'] : lock['packages'];
  const importers = isObject(lock['importers']) ? lock['importers'] : { '.': lock };

  const nodeForKey = (key: string): GraphNode | null => {
    const parsed = splitNameVersion(stripPeers(key.replace(/^\//, '')));
    return parsed === null ? null : graph.add(packageNode(parsed.name, parsed.version));
  };
  const importerNodes = new Map<string, GraphNode>();
  for (const dir of Object.keys(importers)) {
    const posixDir = toPosix(dir);
    importerNodes.set(
      posixDir,
      graph.add(importerNode(posixDir, await readManifest(project.dir, dir))),
    );
  }
  const resolve = (alias: string, ref: string, fromDir: string | null): GraphNode | null => {
    if (ref.startsWith('link:')) {
      return fromDir === null
        ? null
        : (importerNodes.get(toPosix(posix.join(fromDir, ref.slice(5)))) ?? null);
    }
    const bare = stripPeers(ref);
    const aliased = /^(@[^/]+\/)?[^@/]+@/.test(bare) ? splitNameVersion(bare) : null;
    return aliased === null
      ? graph.add(packageNode(alias, bare))
      : graph.add(packageNode(aliased.name, aliased.version));
  };

  if (isObject(snapshots)) {
    for (const [key, entry] of Object.entries(snapshots)) {
      const parent = nodeForKey(key);
      if (parent === null) {
        continue;
      }
      for (const [alias, ref] of depsOf(entry, ['dependencies', 'optionalDependencies'])) {
        graph.link(parent, alias, resolve(alias, ref, null));
      }
    }
  }
  for (const [dir, entry] of Object.entries(importers)) {
    const parent = importerNodes.get(toPosix(dir));
    if (parent === undefined) {
      continue;
    }
    for (const [alias, ref] of depsOf(entry, IMPORTER_FIELDS)) {
      graph.link(parent, alias, resolve(alias, ref, toPosix(dir)));
    }
  }
  return graph;
}

// package-lock.json and npm-shrinkwrap.json, lockfile v2 and v3

async function readNpm(project: Project): Promise<Graph> {
  const lock: unknown = JSON.parse(project.lockfileText);
  if (!isObject(lock) || !isObject(lock['packages'])) {
    throw new LockfileError(
      `${project.lockfile} v1 is not supported; run npm 7 or later to upgrade it`,
    );
  }
  const { packages } = lock;
  const graph = new Graph();
  const nodes = new Map<string, GraphNode>();

  for (const [path, entry] of Object.entries(packages)) {
    if (!isObject(entry) || entry['link'] === true) {
      continue;
    }
    if (!path.includes('node_modules/')) {
      const dir = path === '' ? '.' : path;
      nodes.set(path, graph.add(importerNode(dir, await readManifest(project.dir, dir))));
      continue;
    }
    const name =
      typeof entry['name'] === 'string'
        ? entry['name']
        : path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
    const version = typeof entry['version'] === 'string' ? entry['version'] : '';
    nodes.set(path, graph.add(packageNode(name, version)));
  }

  const lookup = (from: string, dep: string): GraphNode | null => {
    let base = from;
    for (;;) {
      const candidate = base === '' ? `node_modules/${dep}` : `${base}/node_modules/${dep}`;
      const entry = packages[candidate];
      if (isObject(entry)) {
        if (entry['link'] === true && typeof entry['resolved'] === 'string') {
          return nodes.get(entry['resolved']) ?? null;
        }
        return nodes.get(candidate) ?? null;
      }
      if (base === '') {
        return null;
      }
      const index = base.lastIndexOf('/node_modules/');
      base = index === -1 ? '' : base.slice(0, index);
    }
  };

  for (const [path, entry] of Object.entries(packages)) {
    const parent = nodes.get(path);
    if (parent === undefined) {
      continue;
    }
    const fields = parent.importer === undefined ? PACKAGE_FIELDS : IMPORTER_FIELDS;
    for (const [alias] of depsOf(entry, fields)) {
      graph.link(parent, alias, lookup(path, alias));
    }
  }
  return graph;
}

// yarn.lock

function unquote(text: string): string {
  const trimmed = text.trim();
  return trimmed.startsWith('"') && trimmed.endsWith('"')
    ? (JSON.parse(trimmed) as string)
    : trimmed;
}

interface YarnEntry {
  readonly descriptors: Array<string>;
  readonly fields: Record<string, string>;
  readonly deps: Record<string, Record<string, string>>;
}

/** Parses the Yarn classic lockfile format, which is not YAML. */
export function parseYarnClassic(text: string): Array<YarnEntry> {
  const entries: Array<YarnEntry> = [];
  let current: YarnEntry | null = null;
  let section: Record<string, string> | null = null;
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim() === '' || raw.trimStart().startsWith('#')) {
      continue;
    }
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();
    if (indent === 0) {
      const descriptors = line
        .replace(/:$/, '')
        .split(/,\s*/)
        .map((part) => unquote(part));
      current = { descriptors, fields: {}, deps: {} };
      entries.push(current);
      section = null;
      continue;
    }
    if (current === null) {
      throw new LockfileError(`unexpected line in yarn.lock: ${line}`);
    }
    if (indent === 2 && line.endsWith(':')) {
      section = {};
      current.deps[line.slice(0, -1)] = section;
      continue;
    }
    const match = /^("(?:[^"\\]|\\.)*"|\S+)\s+(.*)$/.exec(line);
    if (match === null) {
      continue;
    }
    const target = indent > 2 && section !== null ? section : current.fields;
    target[unquote(match[1] ?? '')] = unquote(match[2] ?? '');
  }
  return entries;
}

async function workspaceDirs(project: Project): Promise<Array<string>> {
  const field = project.manifest['workspaces'];
  const patterns = Array.isArray(field)
    ? field
    : isObject(field) && Array.isArray(field['packages'])
      ? field['packages']
      : [];
  const dirs = new Set<string>();
  for (const pattern of patterns) {
    if (typeof pattern !== 'string') {
      continue;
    }
    for await (const match of glob(posix.join(pattern, 'package.json'), {
      cwd: project.dir,
      exclude: (path) => path.includes('node_modules'),
    })) {
      dirs.add(toPosix(posix.dirname(match.replaceAll('\\', '/'))));
    }
  }
  return [...dirs];
}

function descriptorName(descriptor: string): { name: string; range: string } {
  const parsed = splitNameVersion(descriptor);
  return parsed === null
    ? { name: descriptor, range: '' }
    : { name: parsed.name, range: parsed.version };
}

async function readYarnClassic(project: Project): Promise<Graph> {
  const graph = new Graph();
  const byDescriptor = new Map<string, GraphNode>();
  const entries = parseYarnClassic(project.lockfileText);
  const nodes = entries.map((entry) => {
    const first = descriptorName(entry.descriptors[0] ?? '');
    const alias = first.range.startsWith('npm:') ? splitNameVersion(first.range.slice(4)) : null;
    const node = graph.add(packageNode(alias?.name ?? first.name, entry.fields['version'] ?? ''));
    for (const descriptor of entry.descriptors) {
      byDescriptor.set(descriptor, node);
    }
    return node;
  });
  const importers = new Map<string, GraphNode>();
  for (const dir of ['.', ...(await workspaceDirs(project))]) {
    const node = graph.add(
      importerNode(dir, dir === '.' ? project.manifest : await readManifest(project.dir, dir)),
    );
    importers.set(node.name, node);
  }
  for (const [index, entry] of entries.entries()) {
    const parent = nodes[index];
    if (parent === undefined) {
      continue;
    }
    for (const field of ['dependencies', 'optionalDependencies']) {
      for (const [alias, range] of Object.entries(entry.deps[field] ?? {})) {
        graph.link(parent, alias, byDescriptor.get(`${alias}@${range}`) ?? null);
      }
    }
  }

  for (const importer of importers.values()) {
    for (const [alias, range] of depsOf(importer.manifest, IMPORTER_FIELDS)) {
      graph.link(
        importer,
        alias,
        byDescriptor.get(`${alias}@${range}`) ?? importers.get(alias) ?? null,
      );
    }
  }
  return graph;
}

async function readYarnBerry(project: Project): Promise<Graph> {
  const lock = parseYaml(project.lockfileText);
  if (!isObject(lock)) {
    throw new LockfileError('yarn.lock is empty');
  }
  const graph = new Graph();
  const byDescriptor = new Map<string, GraphNode>();
  const parents: Array<[GraphNode, Json]> = [];
  for (const [key, entry] of Object.entries(lock)) {
    if (key === '__metadata' || !isObject(entry)) {
      continue;
    }
    const resolution = typeof entry['resolution'] === 'string' ? entry['resolution'] : key;
    const parsed = descriptorName(resolution);
    let node: GraphNode;
    if (parsed.range.startsWith('workspace:')) {
      const dir = toPosix(parsed.range.slice('workspace:'.length));
      node = graph.add(importerNode(dir, await readManifest(project.dir, dir)));
    } else {
      node = graph.add(
        packageNode(parsed.name, typeof entry['version'] === 'string' ? entry['version'] : ''),
      );
    }
    for (const descriptor of key.split(/,\s*/)) {
      byDescriptor.set(descriptor.trim(), node);
    }
    parents.push([node, entry]);
  }
  for (const [parent, entry] of parents) {
    for (const [alias, range] of depsOf(entry, PACKAGE_FIELDS)) {
      const child =
        byDescriptor.get(`${alias}@${range}`) ?? byDescriptor.get(`${alias}@npm:${range}`) ?? null;
      graph.link(parent, alias, child);
    }
  }
  return graph;
}

// bun.lock

function bunSegments(key: string): Array<string> {
  const raw = key.split('/');
  const segments: Array<string> = [];
  for (let i = 0; i < raw.length; i++) {
    const part = raw[i] ?? '';
    if (part.startsWith('@') && i + 1 < raw.length) {
      segments.push(`${part}/${raw[i + 1] ?? ''}`);
      i++;
    } else {
      segments.push(part);
    }
  }
  return segments;
}

function parseBunLock(text: string): { packages: Json; workspaces: Json } {
  let lock: unknown;
  try {
    lock = parseJsonc(text);
  } catch (error) {
    throw new LockfileError(`bun.lock: ${(error as Error).message}`);
  }
  if (!isObject(lock) || !isObject(lock['packages'])) {
    throw new LockfileError('bun.lock has no packages');
  }
  return {
    packages: lock['packages'],
    workspaces: isObject(lock['workspaces']) ? lock['workspaces'] : {},
  };
}

interface BunPackages {
  readonly nodes: Map<string, GraphNode>;
  readonly metas: Map<string, Json>;
}

function readBunPackages(
  graph: Graph,
  packages: Json,
  importers: ReadonlyMap<string, GraphNode>,
): BunPackages {
  const nodes = new Map<string, GraphNode>();
  const metas = new Map<string, Json>();
  for (const [key, value] of Object.entries(packages)) {
    if (!Array.isArray(value) || typeof value[0] !== 'string') {
      continue;
    }
    const [ident] = value as [string, ...Array<unknown>];
    const workspace = /@workspace:(.*)$/.exec(ident);
    if (workspace !== null) {
      const importer = importers.get(toPosix(workspace[1] ?? ''));
      if (importer !== undefined) {
        nodes.set(key, importer);
      }
      continue;
    }
    const parsed = splitNameVersion(ident);
    if (parsed === null) {
      continue;
    }
    nodes.set(key, graph.add(packageNode(parsed.name, parsed.version)));
    const meta: unknown = value.slice(1).find((part) => isObject(part));
    if (isObject(meta)) {
      metas.set(key, meta);
    }
  }
  return { nodes, metas };
}

/** Bun nests a package under its dependent's key, like `parent/child`, when it cannot hoist it. */
function bunLookup(
  nodes: ReadonlyMap<string, GraphNode>,
  fromKey: string | null,
  dep: string,
): GraphNode | null {
  const segments = fromKey === null ? [] : bunSegments(fromKey);
  for (let i = segments.length; i >= 0; i--) {
    const node = nodes.get([...segments.slice(0, i), dep].join('/'));
    if (node !== undefined) {
      return node;
    }
  }
  return null;
}

async function readBun(project: Project): Promise<Graph> {
  const { packages, workspaces } = parseBunLock(project.lockfileText);
  const graph = new Graph();
  const importers = new Map<string, GraphNode>();
  for (const dir of Object.keys(workspaces)) {
    const posixDir = dir === '' ? '.' : toPosix(dir);
    importers.set(
      posixDir,
      graph.add(importerNode(posixDir, await readManifest(project.dir, posixDir))),
    );
  }
  const { nodes, metas } = readBunPackages(graph, packages, importers);
  for (const [key, meta] of metas) {
    const parent = nodes.get(key);
    for (const [alias] of parent === undefined ? [] : depsOf(meta, PACKAGE_FIELDS)) {
      graph.link(parent as GraphNode, alias, bunLookup(nodes, key, alias));
    }
  }
  for (const [dir, entry] of Object.entries(workspaces)) {
    const parent = importers.get(dir === '' ? '.' : toPosix(dir));
    if (parent === undefined) {
      continue;
    }
    const scope = dir === '' ? null : parent.name;
    for (const [alias] of depsOf(entry, IMPORTER_FIELDS)) {
      graph.link(parent, alias, bunLookup(nodes, scope, alias));
    }
  }
  return graph;
}

export async function readGraph(project: Project): Promise<Graph> {
  switch (project.pm) {
    case 'pnpm':
      return readPnpm(project);
    case 'npm':
      return readNpm(project);
    case 'yarn-classic':
      return readYarnClassic(project);
    case 'yarn-berry':
      return readYarnBerry(project);
    case 'bun':
      return readBun(project);
  }
}
