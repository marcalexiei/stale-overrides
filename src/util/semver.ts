export interface SemVer {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: ReadonlyArray<string | number>;
  readonly raw: string;
}

type Operator = '<' | '<=' | '>' | '>=' | '=';

interface Comparator {
  readonly operator: Operator;
  readonly version: SemVer;
}

/** A union of comparator sets: a version matches when it passes every comparator of one set. */
export type Range = ReadonlyArray<ReadonlyArray<Comparator>>;

const VERSION_RE =
  /^[v=\s]*(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-z-]+(?:\.[\da-z-]+)*))?(?:\+[\da-z-]+(?:\.[\da-z-]+)*)?$/i;

const PARTIAL_RE =
  /^[v=\s]*(\d+|[x*])(?:\.(\d+|[x*]))?(?:\.(\d+|[x*]))?(?:-([\da-z-]+(?:\.[\da-z-]+)*))?(?:\+[\da-z-]+(?:\.[\da-z-]+)*)?$/i;

function parsePrerelease(value: string | undefined): Array<string | number> {
  if (value === undefined) {
    return [];
  }
  return value.split('.').map((id) => (/^\d+$/.test(id) ? Number(id) : id));
}

export function parseVersion(input: string): SemVer | null {
  const match = VERSION_RE.exec(input.trim());
  if (match === null) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: parsePrerelease(match[4]),
    raw: input.trim(),
  };
}

function compareIdentifiers(a: string | number, b: string | number): number {
  if (typeof a === 'number' && typeof b === 'number') {
    return a - b;
  }
  if (typeof a === 'number') {
    return -1;
  }
  if (typeof b === 'number') {
    return 1;
  }
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

function compareSemVer(a: SemVer, b: SemVer): number {
  const main = a.major - b.major || a.minor - b.minor || a.patch - b.patch;
  if (main !== 0) {
    return Math.sign(main);
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return Math.sign(b.prerelease.length - a.prerelease.length);
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < length; i++) {
    const left = a.prerelease[i];
    const right = b.prerelease[i];
    if (left === undefined) {
      return -1;
    }
    if (right === undefined) {
      return 1;
    }
    const result = compareIdentifiers(left, right);
    if (result !== 0) {
      return Math.sign(result);
    }
  }
  return 0;
}

export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (left === null || right === null) {
    return a.localeCompare(b);
  }
  return compareSemVer(left, right);
}

function semver(
  [major, minor, patch]: readonly [number, number, number],
  prerelease: Array<string | number> = [],
): SemVer {
  const pre = prerelease.length > 0 ? `-${prerelease.join('.')}` : '';
  return { major, minor, patch, prerelease, raw: `${major}.${minor}.${patch}${pre}` };
}

interface Partial {
  readonly major: number | null;
  readonly minor: number | null;
  readonly patch: number | null;
  readonly prerelease: Array<string | number>;
}

function partialNumber(value: string | undefined): number | null {
  return value === undefined || /^[x*]$/i.test(value) ? null : Number(value);
}

function parsePartial(input: string): Partial | null {
  if (input === '' || input === '*' || input.toLowerCase() === 'x') {
    return { major: null, minor: null, patch: null, prerelease: [] };
  }
  const match = PARTIAL_RE.exec(input);
  if (match === null) {
    return null;
  }
  const major = partialNumber(match[1]);
  const minor = major === null ? null : partialNumber(match[2]);
  const patch = minor === null ? null : partialNumber(match[3]);
  return { major, minor, patch, prerelease: patch === null ? [] : parsePrerelease(match[4]) };
}

const ANY: Array<Comparator> = [{ operator: '>=', version: semver([0, 0, 0]) }];

function lowerOf(partial: Partial): SemVer {
  return semver([partial.major ?? 0, partial.minor ?? 0, partial.patch ?? 0], partial.prerelease);
}

/** The exclusive upper bound of a partial: `1.2` is below `1.3.0-0`. */
function upperOf(partial: Partial): SemVer | null {
  if (partial.major === null) {
    return null;
  }
  if (partial.minor === null) {
    return semver([partial.major + 1, 0, 0], [0]);
  }
  return semver([partial.major, partial.minor + 1, 0], [0]);
}

function xRange(partial: Partial): Array<Comparator> {
  if (partial.major === null) {
    return ANY;
  }
  if (partial.patch !== null) {
    return [{ operator: '=', version: lowerOf(partial) }];
  }
  const upper = upperOf(partial);
  const comparators: Array<Comparator> = [{ operator: '>=', version: lowerOf(partial) }];
  if (upper !== null) {
    comparators.push({ operator: '<', version: upper });
  }
  return comparators;
}

function caret(partial: Partial): Array<Comparator> {
  const { major, minor, patch } = partial;
  if (major === null) {
    return ANY;
  }
  let upper: SemVer;
  if (major > 0 || minor === null) {
    upper = semver([major + 1, 0, 0], [0]);
  } else if (minor > 0 || patch === null) {
    upper = semver([0, minor + 1, 0], [0]);
  } else {
    upper = semver([0, 0, patch + 1], [0]);
  }
  return [
    { operator: '>=', version: lowerOf(partial) },
    { operator: '<', version: upper },
  ];
}

function tilde(partial: Partial): Array<Comparator> {
  const { major, minor } = partial;
  if (major === null) {
    return ANY;
  }
  const upper =
    minor === null ? semver([major + 1, 0, 0], [0]) : semver([major, minor + 1, 0], [0]);
  return [
    { operator: '>=', version: lowerOf(partial) },
    { operator: '<', version: upper },
  ];
}

function primitive(operator: Operator, partial: Partial): Array<Comparator> | null {
  if (operator === '=') {
    return xRange(partial);
  }
  if (partial.major === null) {
    return operator === '<' || operator === '>'
      ? [{ operator: '<', version: semver([0, 0, 0], [0]) }]
      : ANY;
  }
  if (partial.patch !== null) {
    return [{ operator, version: lowerOf(partial) }];
  }
  const upper = upperOf(partial);
  switch (operator) {
    case '>':
      return upper === null ? null : [{ operator: '>=', version: upper }];
    case '>=':
      return [{ operator: '>=', version: lowerOf(partial) }];
    case '<':
      return [{ operator: '<', version: semver([partial.major, partial.minor ?? 0, 0], [0]) }];
    case '<=':
      return upper === null ? null : [{ operator: '<', version: upper }];
  }
}

function parseComparatorToken(token: string): Array<Comparator> | null {
  const match = /^(~>|~|\^|<=|>=|<|>|=)?(.*)$/.exec(token);
  if (match === null) {
    return null;
  }
  const partial = parsePartial(match[2] ?? '');
  if (partial === null) {
    return null;
  }
  switch (match[1]) {
    case '^':
      return caret(partial);
    case '~':
    case '~>':
      return tilde(partial);
    case undefined:
      return xRange(partial);
    default:
      return primitive(match[1] as Operator, partial);
  }
}

function parseHyphen(from: string, to: string): Array<Comparator> | null {
  const lower = parsePartial(from);
  const upper = parsePartial(to);
  if (lower === null || upper === null) {
    return null;
  }
  const comparators: Array<Comparator> = [{ operator: '>=', version: lowerOf(lower) }];
  if (upper.major === null) {
    return comparators;
  }
  if (upper.patch === null) {
    const bound = upperOf(upper);
    if (bound !== null) {
      comparators.push({ operator: '<', version: bound });
    }
  } else {
    comparators.push({ operator: '<=', version: lowerOf(upper) });
  }
  return comparators;
}

const rangeCache = new Map<string, Range | null>();

/** Parses an npm range; `null` when the string is not one (a dist-tag, a URL, a protocol). */
export function parseRange(input: string): Range | null {
  const cached = rangeCache.get(input);
  if (cached !== undefined) {
    return cached;
  }
  const sets: Array<Array<Comparator>> = [];
  for (const rawPart of input.split('||')) {
    const part = rawPart.trim();
    const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(part);
    let set: Array<Comparator> | null = [];
    if (hyphen === null) {
      const tokens = part.replaceAll(/(~>|~|\^|<=|>=|<|>|=)\s+/g, '$1').split(/\s+/);
      for (const token of tokens) {
        const comparators = parseComparatorToken(token);
        if (comparators === null) {
          set = null;
          break;
        }
        set.push(...comparators);
      }
    } else {
      set = parseHyphen(hyphen[1] ?? '', hyphen[2] ?? '');
    }
    if (set === null) {
      rangeCache.set(input, null);
      return null;
    }
    sets.push(set.length === 0 ? ANY : set);
  }
  rangeCache.set(input, sets);
  return sets;
}

export function isRange(input: string): boolean {
  return parseRange(input) !== null;
}

function testComparator(version: SemVer, comparator: Comparator): boolean {
  const result = compareSemVer(version, comparator.version);
  switch (comparator.operator) {
    case '<':
      return result < 0;
    case '<=':
      return result <= 0;
    case '>':
      return result > 0;
    case '>=':
      return result >= 0;
    case '=':
      return result === 0;
  }
}

function sameTuple(a: SemVer, b: SemVer): boolean {
  return a.major === b.major && a.minor === b.minor && a.patch === b.patch;
}

function testSet(
  version: SemVer,
  set: ReadonlyArray<Comparator>,
  includePrerelease: boolean,
): boolean {
  if (!set.every((comparator) => testComparator(version, comparator))) {
    return false;
  }
  if (version.prerelease.length === 0 || includePrerelease) {
    return true;
  }
  // a prerelease only matches a set that names a prerelease of the same version
  return set.some(
    (comparator) =>
      comparator.version.prerelease.length > 0 && sameTuple(comparator.version, version),
  );
}

export function satisfies(version: string, range: string, includePrerelease = false): boolean {
  const parsedVersion = parseVersion(version);
  const parsedRange = parseRange(range);
  if (parsedVersion === null || parsedRange === null) {
    return false;
  }
  return parsedRange.some((set) => testSet(parsedVersion, set, includePrerelease));
}

export function maxSatisfying(versions: Iterable<string>, range: string): string | null {
  let best: string | null = null;
  for (const version of versions) {
    if (satisfies(version, range) && (best === null || compareVersions(version, best) > 0)) {
      best = version;
    }
  }
  return best;
}

export function isPrerelease(version: string): boolean {
  return (parseVersion(version)?.prerelease.length ?? 0) > 0;
}

// Interval arithmetic for `intersects` and `subset`; prerelease tags only order the bounds.

interface Bound {
  readonly version: SemVer;
  readonly inclusive: boolean;
}

interface Interval {
  readonly lower: Bound | null;
  readonly upper: Bound | null;
}

function tighterLower(a: Bound | null, b: Bound): Bound {
  if (a === null) {
    return b;
  }
  const result = compareSemVer(a.version, b.version);
  if (result !== 0) {
    return result > 0 ? a : b;
  }
  return a.inclusive ? b : a;
}

function tighterUpper(a: Bound | null, b: Bound): Bound {
  if (a === null) {
    return b;
  }
  const result = compareSemVer(a.version, b.version);
  if (result !== 0) {
    return result < 0 ? a : b;
  }
  return a.inclusive ? b : a;
}

function isEmpty(interval: Interval): boolean {
  if (interval.lower === null || interval.upper === null) {
    return false;
  }
  const result = compareSemVer(interval.lower.version, interval.upper.version);
  return result > 0 || (result === 0 && !(interval.lower.inclusive && interval.upper.inclusive));
}

function toInterval(set: ReadonlyArray<Comparator>): Interval {
  let lower: Bound | null = null;
  let upper: Bound | null = null;
  for (const { operator, version } of set) {
    if (operator === '>' || operator === '>=' || operator === '=') {
      lower = tighterLower(lower, { version, inclusive: operator !== '>' });
    }
    if (operator === '<' || operator === '<=' || operator === '=') {
      upper = tighterUpper(upper, { version, inclusive: operator !== '<' });
    }
  }
  return { lower, upper };
}

function intervalsOf(range: Range): Array<Interval> {
  return range.map((set) => toInterval(set)).filter((interval) => !isEmpty(interval));
}

function overlap(a: Interval, b: Interval): Interval {
  return {
    lower: b.lower === null ? a.lower : tighterLower(a.lower, b.lower),
    upper: b.upper === null ? a.upper : tighterUpper(a.upper, b.upper),
  };
}

export function intersects(a: string, b: string): boolean {
  const left = parseRange(a);
  const right = parseRange(b);
  if (left === null || right === null) {
    return false;
  }
  return intervalsOf(left).some((x) => intervalsOf(right).some((y) => !isEmpty(overlap(x, y))));
}

function lowerCovers(outer: Bound | null, inner: Bound | null): boolean {
  if (outer === null) {
    return true;
  }
  if (inner === null) {
    return false;
  }
  const result = compareSemVer(outer.version, inner.version);
  return result < 0 || (result === 0 && (outer.inclusive || !inner.inclusive));
}

function upperCovers(outer: Bound | null, inner: Bound | null): boolean {
  if (outer === null) {
    return true;
  }
  if (inner === null) {
    return false;
  }
  const result = compareSemVer(outer.version, inner.version);
  return result > 0 || (result === 0 && (outer.inclusive || !inner.inclusive));
}

/** Whether every version `sub` allows is also allowed by `dom`. */
export function subset(sub: string, dom: string): boolean {
  const inner = parseRange(sub);
  const outer = parseRange(dom);
  if (inner === null || outer === null) {
    return false;
  }
  const outerIntervals = intervalsOf(outer);
  return intervalsOf(inner).every((interval) =>
    outerIntervals.some(
      (candidate) =>
        lowerCovers(candidate.lower, interval.lower) &&
        upperCovers(candidate.upper, interval.upper),
    ),
  );
}
