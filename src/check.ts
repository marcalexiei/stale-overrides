import { isAbsolute, join, resolve } from 'node:path';

import type { EvaluationContext } from './evaluate.ts';
import { evaluate } from './evaluate.ts';
import type { Intent } from './intent.ts';
import { INTENT_FILE, readIntents } from './intent.ts';
import { readGraph } from './lockfile/read.ts';
import { readOverrides } from './overrides.ts';
import { loadProject } from './project.ts';
import { createRegistry } from './registry/client.ts';
import { loadRegistryConfig } from './registry/config.ts';
import { createReleasePolicy } from './registry/release-age.ts';
import type { Override, PackageManager, Verdict } from './types.ts';
import { verifyPrunes } from './verify.ts';

export interface CheckOptions {
  /** The project root: where package.json and the lockfile are. */
  readonly cwd: string;
  /** The intent file, relative to `cwd`; defaults to `overrides.json`. */
  readonly intentFile?: string;
  /** Confirm each PRUNE with the package manager's own lockfile-only install. */
  readonly verify?: boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly now?: Date;
  readonly fetch?: typeof fetch;
}

export interface OverrideReport {
  readonly override: Override;
  readonly intent: Intent | null;
  readonly verdict: Verdict;
}

export interface Report {
  readonly dir: string;
  readonly pm: PackageManager;
  readonly lockfile: string;
  readonly releaseAge: string;
  readonly intentFile: string;
  readonly overrides: ReadonlyArray<OverrideReport>;
  /** Overrides with no entry in the intent file. */
  readonly missingIntents: ReadonlyArray<string>;
  /** Intent entries with no matching override. */
  readonly orphanIntents: ReadonlyArray<string>;
  readonly intentProblems: ReadonlyArray<string>;
  /** 0 nothing to do, 1 something to prune or the intent file is out of sync, 2 an error. */
  readonly exitCode: 0 | 1 | 2;
}

export function exitCodeOf(report: Omit<Report, 'exitCode'>): 0 | 1 | 2 {
  if (report.overrides.some((entry) => entry.verdict.status === 'error')) {
    return 2;
  }
  const outOfSync =
    report.missingIntents.length > 0 ||
    report.orphanIntents.length > 0 ||
    report.intentProblems.length > 0;
  return outOfSync || report.overrides.some((entry) => entry.verdict.status === 'prune') ? 1 : 0;
}

export async function check(options: CheckOptions): Promise<Report> {
  const dir = resolve(options.cwd);
  const env = options.env ?? process.env;
  const project = await loadProject(dir);
  const overrides = readOverrides(project);
  const intentFile = options.intentFile ?? INTENT_FILE;
  const intents = await readIntents(isAbsolute(intentFile) ? intentFile : join(dir, intentFile));
  const registryConfig = await loadRegistryConfig(project, env);
  const policy = createReleasePolicy(project, registryConfig.npmrc, options.now ?? new Date());

  const context: EvaluationContext = {
    project,
    graph: await readGraph(project),
    registry: createRegistry(registryConfig, policy, options.fetch),
    policy,
  };

  let reports: Array<OverrideReport> = await Promise.all(
    overrides.map(async (override) => {
      const intent = intents.entries?.get(override.key) ?? null;
      if (intent?.ceiling === true) {
        const verdict: Verdict = {
          status: 'keep',
          ceiling: true,
          reasons: [`deliberate ceiling${intent.why === '' ? '' : `: ${intent.why}`}`],
        };
        return { override, intent, verdict };
      }
      return { override, intent, verdict: await evaluate(context, override) };
    }),
  );
  if (options.verify === true) {
    reports = await verifyPrunes(project, context.graph, reports);
  }

  const keys = new Set(overrides.map((override) => override.key));
  const partial = {
    dir,
    pm: project.pm,
    lockfile: project.lockfile,
    releaseAge: policy.description,
    intentFile,
    overrides: reports,
    missingIntents: overrides
      .filter((override) => intents.entries?.has(override.key) !== true)
      .map((override) => override.key),
    orphanIntents: [...(intents.entries?.keys() ?? [])].filter((key) => !keys.has(key)),
    intentProblems: intents.problems,
  };
  return { ...partial, exitCode: exitCodeOf(partial) };
}
