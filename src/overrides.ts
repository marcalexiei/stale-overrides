import type { Json, Project } from './project.ts';
import { isObject, manifestSpec } from './project.ts';
import type { ChainLink, Override, OverrideValue, PackageManager, Selector } from './types.ts';
import { isRange } from './util/semver.ts';

/** Splits `name@range` at the `@` that is not a scope prefix. */
function parseSelector(text: string): Selector {
  const at = text.indexOf('@', 1);
  if (at === -1) {
    return { name: text, range: null };
  }
  const range = text.slice(at + 1);
  return { name: text.slice(0, at), range: range === '' ? null : range };
}

/** Splits `npm:name@range`, `name@range` or a bare range into its name and range. */
export function parseAliasSpec(spec: string): { name: string | null; range: string } {
  const body = spec.startsWith('npm:') ? spec.slice(4) : spec;
  if (isRange(body)) {
    return { name: null, range: body };
  }
  const selector = parseSelector(body);
  return { name: selector.name, range: selector.range ?? '*' };
}

interface ReadContext {
  readonly project: Project;
  readonly source: string;
  readonly allowRemoval: boolean;
  readonly allowReference: boolean;
}

/** Follows a `catalog:` or `$name` value to the spec it stands for; `null` when it is neither. */
function indirection(
  spec: string,
  target: string,
  context: ReadContext,
): string | OverrideValue | null {
  if (spec.startsWith('catalog:')) {
    const name = spec.slice('catalog:'.length) || 'default';
    const entry = context.project.catalogs.get(name)?.[target];
    return entry ?? { kind: 'invalid', reason: `catalog "${name}" has no entry for ${target}` };
  }
  if (spec.startsWith('$') && context.allowReference) {
    const name = spec.slice(1);
    const entry = manifestSpec(context.project.manifest, name);
    return (
      entry ?? { kind: 'invalid', reason: `the root package.json has no dependency on ${name}` }
    );
  }
  return null;
}

function parseValue(raw: string, target: string, context: ReadContext): OverrideValue {
  let spec = raw;
  for (let hop = 0; hop < 4; hop++) {
    if (spec === '-' && context.allowRemoval) {
      return { kind: 'removal' };
    }
    const next = indirection(spec, target, context);
    if (typeof next === 'string') {
      spec = next;
      continue;
    }
    if (next !== null) {
      return next;
    }
    const { name, range } = parseAliasSpec(spec);
    if ((name === null || name === target) && isRange(range)) {
      return { kind: 'range', range };
    }
    return { kind: 'replacement', spec };
  }
  return { kind: 'invalid', reason: `"${raw}" refers to itself` };
}

interface Entry {
  readonly path: ReadonlyArray<string>;
  readonly raw: unknown;
  readonly target: Selector;
  readonly chain: ReadonlyArray<ChainLink>;
}

function makeOverride(entry: Entry, context: ReadContext): Override {
  const { path, raw, target, chain } = entry;
  const value: OverrideValue =
    typeof raw === 'string'
      ? parseValue(raw, target.name, context)
      : { kind: 'invalid', reason: 'the value is not a string' };
  return {
    key: path.filter((part) => part !== '.').join('>'),
    source: context.source,
    path,
    raw: typeof raw === 'string' ? raw : JSON.stringify(raw),
    target,
    chain,
    value,
  };
}

/** npm nests a dependency's overrides under it; `.` is the override for that dependency itself. */
function readNpmStyle(object: Json, context: ReadContext): Array<Override> {
  const results: Array<Override> = [];
  const visit = (level: Json, parents: Array<string>): void => {
    for (const [key, raw] of Object.entries(level)) {
      if (key === '.') {
        continue;
      }
      const path = [...parents, key];
      const target = parseSelector(key);
      const chain: Array<ChainLink> = parents.map((parent) => ({
        selector: parseSelector(parent),
        relation: 'ancestor',
      }));
      if (!isObject(raw)) {
        results.push(makeOverride({ path, raw, target, chain }, context));
        continue;
      }
      if (raw['.'] !== undefined) {
        results.push(makeOverride({ path: [...path, '.'], raw: raw['.'], target, chain }, context));
      }
      visit(raw, path);
    }
  };
  visit(object, []);
  return results;
}

/** Finds the `>` that separate pnpm selectors, skipping those inside a range such as `@>=1`. */
export function splitPnpmKey(key: string): Array<string> {
  const parts: Array<string> = [];
  let start = 0;
  for (let i = 1; i < key.length - 1; i++) {
    if (key[i] !== '>') {
      continue;
    }
    const previous = key[i - 1] ?? '';
    const next = key[i + 1] ?? '';
    if (/[\s@<>=]/.test(previous) || !/[a-z0-9@_]/i.test(next) || /\d/.test(next)) {
      continue;
    }
    parts.push(key.slice(start, i));
    start = i + 1;
  }
  parts.push(key.slice(start));
  return parts;
}

function stripNpmProtocol(selector: Selector): Selector {
  return selector.range?.startsWith('npm:') === true
    ? { name: selector.name, range: selector.range.slice(4) }
    : selector;
}

/** Yarn keys: `child`, `parent/child`, `**\/child`, `parent/**\/child`, each optionally `@range`. */
export function parseYarnKey(key: string): { target: Selector; chain: Array<ChainLink> } {
  const raw = key.split('/');
  const segments: Array<string> = [];
  for (let i = 0; i < raw.length; i++) {
    const part = raw[i] ?? '';
    if (part.startsWith('@') && !part.includes('@', 1) && i + 1 < raw.length) {
      segments.push(`${part}/${raw[i + 1] ?? ''}`);
      i++;
    } else {
      segments.push(part);
    }
  }
  const links: Array<{ selector: Selector; relation: 'direct' | 'ancestor' }> = [];
  for (const segment of segments.slice(0, -1)) {
    if (segment === '**') {
      const previous = links.at(-1);
      if (previous !== undefined) {
        previous.relation = 'ancestor';
      }
      continue;
    }
    links.push({ selector: stripNpmProtocol(parseSelector(segment)), relation: 'direct' });
  }
  return { target: stripNpmProtocol(parseSelector(segments.at(-1) ?? key)), chain: links };
}

function readYarnStyle(object: Json, context: ReadContext): Array<Override> {
  return Object.entries(object).map(([key, raw]) => {
    const { target, chain } = parseYarnKey(key);
    return makeOverride({ path: [key], raw, target, chain }, context);
  });
}

function readPnpmStyle(object: Json, context: ReadContext): Array<Override> {
  return Object.entries(object).map(([key, raw]) => {
    const parts = splitPnpmKey(key).map((part) => parseSelector(part));
    const target = parts.at(-1) ?? parseSelector(key);
    const chain: Array<ChainLink> = parts
      .slice(0, -1)
      .map((selector) => ({ selector, relation: 'direct' }));
    return makeOverride({ path: [key], raw, target, chain }, context);
  });
}

export function readOverrides(project: Project): Array<Override> {
  const { manifest, pm } = project;
  const pnpmField = isObject(manifest['pnpm']) ? manifest['pnpm'] : {};
  const fields: Record<PackageManager, Array<[string, unknown, 'npm' | 'yarn' | 'pnpm']>> = {
    npm: [['package.json#overrides', manifest['overrides'], 'npm']],
    'yarn-classic': [['package.json#resolutions', manifest['resolutions'], 'yarn']],
    'yarn-berry': [['package.json#resolutions', manifest['resolutions'], 'yarn']],
    bun: [
      ['package.json#overrides', manifest['overrides'], 'npm'],
      ['package.json#resolutions', manifest['resolutions'], 'yarn'],
    ],
    pnpm: [
      ['package.json#pnpm.overrides', pnpmField['overrides'], 'pnpm'],
      ['package.json#resolutions', manifest['resolutions'], 'pnpm'],
      ['pnpm-workspace.yaml#overrides', project.workspaceYaml?.['overrides'], 'pnpm'],
    ],
  };
  const readers = { npm: readNpmStyle, yarn: readYarnStyle, pnpm: readPnpmStyle };
  return fields[pm].flatMap(([source, object, style]) =>
    isObject(object)
      ? readers[style](object, {
          project,
          source,
          allowRemoval: pm === 'pnpm',
          allowReference: pm === 'npm' || pm === 'pnpm' || pm === 'bun',
        })
      : [],
  );
}
