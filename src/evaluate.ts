import type { Edge, Graph, GraphNode } from './lockfile/graph.ts';
import { parseAliasSpec } from './overrides.ts';
import type { Project } from './project.ts';
import { manifestSpec } from './project.ts';
import type { Registry } from './registry/client.ts';
import { pickVersion, RegistryError } from './registry/client.ts';
import type { ReleasePolicy } from './registry/release-age.ts';
import type { ChainLink, Override, Selector, Verdict } from './types.ts';
import { intersects, isRange, satisfies, subset } from './util/semver.ts';

export interface EvaluationContext {
  readonly project: Project;
  readonly graph: Graph;
  readonly registry: Registry;
  readonly policy: ReleasePolicy;
}

/** How many dependents of a parent are re-resolved to find the version a fresh install picks. */
const MAX_DEPENDENTS = 20;
const MAX_REASONS = 6;

export function label(node: GraphNode): string {
  if (node.importer !== undefined) {
    return node.importer === '.' || node.name === node.importer
      ? node.name
      : `${node.name} (${node.importer})`;
  }
  return `${node.name}@${node.version ?? ''}`;
}

function nodeVersion(node: GraphNode): string | null {
  if (node.version !== null) {
    return node.version;
  }
  const version = node.manifest?.['version'];
  return typeof version === 'string' ? version : null;
}

function matchesSelector(node: GraphNode, selector: Selector): boolean {
  if (node.name !== selector.name) {
    return false;
  }
  if (selector.range === null) {
    return true;
  }
  const version = nodeVersion(node);
  return version !== null && satisfies(version, selector.range, true);
}

function ancestorsOf(graph: Graph, node: GraphNode): Array<GraphNode> {
  const seen = new Set<string>([node.id]);
  const queue = [node];
  const result: Array<GraphNode> = [];
  for (let current = queue.shift(); current !== undefined; current = queue.shift()) {
    for (const edge of graph.dependentsOf(current)) {
      if (!seen.has(edge.parent.id)) {
        seen.add(edge.parent.id);
        result.push(edge.parent);
        queue.push(edge.parent);
      }
    }
  }
  return result;
}

/** Whether `parent`, as the dependent of the target, sits where the override's chain scopes it. */
export function chainMatches(
  graph: Graph,
  parent: GraphNode,
  chain: ReadonlyArray<ChainLink>,
): boolean {
  if (chain.length === 0) {
    return true;
  }
  const memo = new Map<string, boolean>();
  const canMatch = (node: GraphNode, index: number): boolean => {
    const key = `${node.id}|${index}`;
    const known = memo.get(key);
    if (known !== undefined) {
      return known;
    }
    memo.set(key, false);
    const link = chain[index];
    let result = link !== undefined && matchesSelector(node, link.selector);
    if (result && index > 0) {
      const relation = chain[index - 1]?.relation;
      const above =
        relation === 'direct'
          ? graph.dependentsOf(node).map((edge) => edge.parent)
          : ancestorsOf(graph, node);
      result = above.some((candidate) => canMatch(candidate, index - 1));
    }
    memo.set(key, result);
    return result;
  };
  const last = chain.length - 1;
  const starts =
    chain[last]?.relation === 'direct' ? [parent] : [parent, ...ancestorsOf(graph, parent)];
  return starts.some((node) => canMatch(node, last));
}

function chainText(chain: ReadonlyArray<ChainLink>): string {
  return chain
    .map((link) =>
      link.selector.range === null
        ? link.selector.name
        : `${link.selector.name}@${link.selector.range}`,
    )
    .join(' > ');
}

/** Resolves a workspace manifest's `catalog:` spec, the way the package manager would. */
function resolveCatalog(project: Project, name: string, spec: string): string {
  if (!spec.startsWith('catalog:')) {
    return spec;
  }
  const catalog = spec.slice('catalog:'.length) || 'default';
  return project.catalogs.get(catalog)?.[name] ?? spec;
}

interface Asker {
  readonly node: GraphNode;
  /** The parent's version to read; `null` for a workspace package. */
  readonly version: string | null;
}

async function declaredSpec(
  context: EvaluationContext,
  { node: parent, version }: Asker,
  alias: string,
): Promise<string | undefined> {
  if (parent.importer !== undefined) {
    const spec = parent.manifest === undefined ? undefined : manifestSpec(parent.manifest, alias);
    return spec === undefined ? undefined : resolveCatalog(context.project, alias, spec);
  }
  const packument = await context.registry.packument(parent.name);
  const info = packument.versions.get(version ?? '');
  if (info === undefined) {
    throw new RegistryError(`${parent.name}@${version ?? ''} is not in the registry`);
  }
  return info.deps.get(alias);
}

function isRegistrySpec(spec: string): boolean {
  return !/^(workspace|link|file|portal|patch|git|git\+[a-z]+|github|gitlab|bitbucket|https?):/.test(
    spec,
  );
}

interface Candidate {
  readonly version: string | null;
  /** Who asks for the parent, and with which spec, when that is what picked this version. */
  readonly via: string | null;
  readonly fresh: boolean;
}

/** The locked version of a parent, plus whatever its own dependents would resolve it to today. */
async function candidatesFor(
  context: EvaluationContext,
  parent: GraphNode,
): Promise<Array<Candidate>> {
  if (parent.importer !== undefined) {
    return [{ version: null, via: null, fresh: false }];
  }
  const dependents = context.graph.dependentsOf(parent).slice(0, MAX_DEPENDENTS);
  const resolved = await Promise.all(
    dependents.map(async (edge) => {
      const spec = await declaredSpec(
        context,
        { node: edge.parent, version: edge.parent.version },
        edge.alias,
      );
      if (spec === undefined || !isRegistrySpec(spec)) {
        return null;
      }
      const { range } = parseAliasSpec(spec);
      const packument = await context.registry.packument(parent.name);
      const version = pickVersion(range, packument, context.policy);
      return { via: `${label(edge.parent)} depends on ${parent.name} ${spec}`, version, range };
    }),
  );
  const known = resolved.filter((entry) => entry !== null);
  const lockedVia =
    known.find((entry) => satisfies(parent.version ?? '', entry.range, true)) ?? known[0];
  const candidates: Array<Candidate> = [
    { version: parent.version, via: lockedVia?.via ?? null, fresh: false },
  ];
  for (const entry of known) {
    if (
      entry.version !== null &&
      !candidates.some((candidate) => candidate.version === entry.version)
    ) {
      candidates.push({ version: entry.version, via: entry.via, fresh: true });
    }
  }
  return candidates;
}

function selectorApplies(project: Project, selector: string | null, spec: string): boolean {
  if (selector === null) {
    return true;
  }
  const { range } = parseAliasSpec(spec);
  switch (project.pm) {
    case 'pnpm':
      return spec === selector || subset(range, selector);
    case 'yarn-classic':
    case 'yarn-berry':
      return range === selector.replace(/^npm:/, '');
    case 'npm':
    case 'bun':
      return intersects(range, selector);
  }
}

interface Judgement {
  readonly needs: boolean;
  /** Why a parent does not need it: it dropped the target, the selector misses it, or it resolves inside. */
  readonly free?: 'gone' | 'selector' | 'inside';
  readonly line: string;
}

async function judge(
  context: EvaluationContext,
  override: Override,
  { who, spec }: { readonly who: string; readonly spec: string | undefined },
): Promise<Judgement> {
  const target = override.target.name;
  if (spec === undefined) {
    return { needs: false, free: 'gone', line: `${who} no longer depends on ${target}` };
  }
  if (!selectorApplies(context.project, override.target.range, spec)) {
    return {
      needs: false,
      free: 'selector',
      line: `${who} asks for ${target} ${spec}, which the selector ${override.target.range ?? ''} does not match`,
    };
  }
  const { value } = override;
  if (value.kind !== 'range') {
    return { needs: true, line: `${who} still depends on ${target} ${spec}` };
  }
  const { name, range } = parseAliasSpec(spec);
  if ((name !== null && name !== target) || !isRegistrySpec(spec) || !isRange(range)) {
    return {
      needs: true,
      line: `${who} asks for ${target} as ${spec}, which is not a registry range`,
    };
  }
  const natural = pickVersion(range, await context.registry.packument(target), context.policy);
  if (natural === null) {
    return {
      needs: true,
      line: `${who} asks for ${target} ${spec}, and no published version matches`,
    };
  }
  if (satisfies(natural, value.range, true)) {
    return {
      needs: false,
      free: 'inside',
      line: `${who} asks for ${target} ${spec}, which already resolves to ${natural}`,
    };
  }
  return {
    needs: true,
    line: `${who} asks for ${target} ${spec}, which resolves to ${natural}, outside ${value.range}`,
  };
}

/** A removal leaves no edge in the lockfile, so every node the chain allows is a possible parent. */
function removalEdges(context: EvaluationContext, override: Override): Array<Edge> {
  return [...context.graph.nodes.values()]
    .filter((node) => chainMatches(context.graph, node, override.chain))
    .map((parent) => ({ parent, alias: override.target.name, child: null }));
}

function cap(lines: Array<string>): Array<string> {
  const unique = [...new Set(lines)];
  return unique.length <= MAX_REASONS
    ? unique
    : [...unique.slice(0, MAX_REASONS), `…and ${unique.length - MAX_REASONS} more`];
}

async function evaluateEdges(
  context: EvaluationContext,
  override: Override,
  edges: ReadonlyArray<Edge>,
): Promise<Verdict> {
  const keeping: Array<string> = [];
  const freeing: Array<string> = [];
  const reasons = new Set<Judgement['free']>();
  const seen = new Set<string>();
  for (const edge of edges) {
    if (seen.has(edge.parent.id)) {
      continue;
    }
    seen.add(edge.parent.id);
    const candidates = await candidatesFor(context, edge.parent);
    const results = await Promise.all(
      candidates.map(async (candidate) => {
        const who =
          candidate.version === null
            ? label(edge.parent)
            : `${edge.parent.name}@${candidate.version}`;
        const spec = await declaredSpec(
          context,
          { node: edge.parent, version: candidate.version },
          edge.alias,
        );
        const judgement = await judge(context, override, { who, spec });
        const prefix = candidate.via === null ? '' : `${candidate.via}, and `;
        return { candidate, judgement, line: prefix + judgement.line };
      }),
    );
    const [locked, ...fresh] = results;
    if (locked === undefined) {
      continue;
    }
    const freshNeeds = fresh.filter((result) => result.judgement.needs);
    if (locked.judgement.needs) {
      keeping.push(locked.line);
      const freed = fresh.find((result) => !result.judgement.needs);
      if (freed !== undefined && freshNeeds.length === 0) {
        keeping.push(
          `  updating ${edge.parent.name} to ${freed.candidate.version ?? ''} would end the need (${freed.candidate.via ?? ''})`,
        );
      }
    } else if (freshNeeds.length > 0) {
      keeping.push(...freshNeeds.map((result) => result.line));
    } else {
      freeing.push(locked.line);
      reasons.add(locked.judgement.free);
    }
  }
  if (keeping.length > 0) {
    return { status: 'keep', reasons: cap(keeping) };
  }
  const target = override.target.name;
  let summary = `every dependent already resolves ${target} within ${override.value.kind === 'range' ? override.value.range : ''}`;
  if (reasons.size === 1 && reasons.has('selector')) {
    summary = `no dependent asks for ${target} within the selector ${override.target.range ?? ''}`;
  } else if (!reasons.has('inside')) {
    summary = `nothing depends on ${target} any more`;
  }
  return { status: 'prune', reasons: cap([summary, ...freeing]) };
}

export async function evaluate(context: EvaluationContext, override: Override): Promise<Verdict> {
  if (override.value.kind === 'invalid') {
    return { status: 'error', reasons: [override.value.reason] };
  }
  try {
    const edges =
      override.value.kind === 'removal'
        ? removalEdges(context, override)
        : context.graph
            .edgesNamed(override.target.name)
            .filter((edge) => chainMatches(context.graph, edge.parent, override.chain));
    if (edges.length === 0) {
      const where = override.chain.length === 0 ? '' : ` under ${chainText(override.chain)}`;
      return {
        status: 'prune',
        reasons: [`nothing in the lockfile depends on ${override.target.name}${where}`],
      };
    }
    return await evaluateEdges(context, override, edges);
  } catch (error) {
    // a failure must never read as "nothing needs it"
    return { status: 'error', reasons: [error instanceof Error ? error.message : String(error)] };
  }
}
