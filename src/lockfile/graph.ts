import type { Json } from '../project.ts';

export interface GraphNode {
  readonly id: string;
  /** The real package name, even when a dependent reaches it through an alias. */
  readonly name: string;
  /** `null` for workspace packages, whose ranges come from their own package.json. */
  readonly version: string | null;
  /** Set for workspace packages: the directory relative to the lockfile. */
  readonly importer?: string;
  /** Set for workspace packages. */
  readonly manifest?: Json;
}

export interface Edge {
  readonly parent: GraphNode;
  /** The name the parent depends on, which is what an override key matches. */
  readonly alias: string;
  /** `null` when the lockfile does not resolve it, such as a skipped optional dependency. */
  readonly child: GraphNode | null;
}

function push<Item>(map: Map<string, Array<Item>>, key: string, value: Item): void {
  const list = map.get(key);
  if (list === undefined) {
    map.set(key, [value]);
  } else {
    list.push(value);
  }
}

export class Graph {
  readonly nodes = new Map<string, GraphNode>();
  readonly edges: Array<Edge> = [];
  private readonly byAlias = new Map<string, Array<Edge>>();
  private readonly byChild = new Map<string, Array<Edge>>();

  add(node: GraphNode): GraphNode {
    const existing = this.nodes.get(node.id);
    if (existing !== undefined) {
      return existing;
    }
    this.nodes.set(node.id, node);
    return node;
  }

  link(parent: GraphNode, alias: string, child: GraphNode | null): void {
    const known = this.byAlias.get(alias);
    if (known?.some((edge) => edge.parent === parent && edge.child === child) === true) {
      return;
    }
    const edge: Edge = { parent, alias, child };
    this.edges.push(edge);
    push(this.byAlias, alias, edge);
    if (child !== null) {
      push(this.byChild, child.id, edge);
    }
  }

  /** Every edge whose dependency is declared under `alias`. */
  edgesNamed(alias: string): ReadonlyArray<Edge> {
    return this.byAlias.get(alias) ?? [];
  }

  /** Every edge that resolves to `node`. */
  dependentsOf(node: GraphNode): ReadonlyArray<Edge> {
    return this.byChild.get(node.id) ?? [];
  }

  importers(): Array<GraphNode> {
    return [...this.nodes.values()].filter((node) => node.importer !== undefined);
  }
}

export class LockfileError extends Error {
  override name = 'LockfileError';
}

export function packageNode(name: string, version: string): GraphNode {
  return { id: `${name}@${version}`, name, version };
}

export function importerNode(dir: string, manifest: Json): GraphNode {
  const name =
    typeof manifest['name'] === 'string' ? manifest['name'] : dir === '.' ? '(root)' : dir;
  return { id: `importer:${dir}`, name, version: null, importer: dir, manifest };
}

/** Splits `name@version`, keeping a scope's leading `@`. */
export function splitNameVersion(text: string): { name: string; version: string } | null {
  const at = text.indexOf('@', 1);
  if (at === -1) {
    return null;
  }
  return { name: text.slice(0, at), version: text.slice(at + 1) };
}
