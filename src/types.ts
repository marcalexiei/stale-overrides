export type PackageManager = 'npm' | 'yarn-classic' | 'yarn-berry' | 'bun' | 'pnpm';

/** A package name with an optional version selector, as in `foo@^1`. */
export interface Selector {
  readonly name: string;
  readonly range: string | null;
}

/**
 * One ancestor the override is scoped to.
 * `relation` says how it reaches the next link, or the target for the last link:
 * `direct` means it is the immediate dependent, `ancestor` means anywhere above.
 */
export interface ChainLink {
  readonly selector: Selector;
  readonly relation: 'direct' | 'ancestor';
}

export type OverrideValue =
  | { readonly kind: 'range'; readonly range: string }
  | { readonly kind: 'replacement'; readonly spec: string }
  | { readonly kind: 'removal' }
  | { readonly kind: 'invalid'; readonly reason: string };

export interface Override {
  /** The key exactly as written; nested npm overrides join their path with `>`. */
  readonly key: string;
  /** Where it is declared, such as `package.json#overrides`. */
  readonly source: string;
  /** The keys leading to the value inside its source object; npm nests, the others do not. */
  readonly path: ReadonlyArray<string>;
  /** The value exactly as written. */
  readonly raw: string;
  readonly target: Selector;
  /** Outermost ancestor first; empty when the override applies everywhere. */
  readonly chain: ReadonlyArray<ChainLink>;
  readonly value: OverrideValue;
}

export type Status = 'prune' | 'keep' | 'error';

export interface Verdict {
  readonly status: Status;
  /** One line per parent or fact that decided the verdict. */
  readonly reasons: ReadonlyArray<string>;
  /** Set when a `ceiling: true` intent turned a PRUNE into a KEEP. */
  readonly ceiling?: true;
  /** What `--verify` found, when it ran. */
  readonly verified?: string;
}
