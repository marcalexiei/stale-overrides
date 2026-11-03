import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { OverrideReport } from './check.ts';
import { chainMatches, label } from './evaluate.ts';
import type { Graph } from './lockfile/graph.ts';
import { readGraph } from './lockfile/read.ts';
import type { Project } from './project.ts';
import { isObject, loadProject } from './project.ts';
import type { Override, PackageManager } from './types.ts';
import { satisfies } from './util/semver.ts';
import { parseYaml } from './util/yaml.ts';

const INSTALL_TIMEOUT_MS = 10 * 60_000;

async function run(bin: string, args: ReadonlyArray<string>, cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile(
      bin,
      args,
      {
        cwd,
        timeout: INSTALL_TIMEOUT_MS,
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, YARN_ENABLE_IMMUTABLE_INSTALLS: 'false' },
      },
      (error, _stdout, stderr) => {
        if (error === null) {
          resolve();
          return;
        }
        const detail = stderr.trim().split('\n').slice(-3).join(' ');
        reject(new Error(detail === '' ? error.message : detail, { cause: error }));
      },
    );
  });
}

const COMMANDS: Record<PackageManager, readonly [string, ReadonlyArray<string>] | null> = {
  npm: ['npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund']],
  pnpm: ['pnpm', ['install', '--lockfile-only', '--ignore-scripts', '--no-frozen-lockfile']],
  'yarn-berry': ['yarn', ['install', '--mode=update-lockfile']],
  bun: ['bun', ['install', '--lockfile-only', '--ignore-scripts']],
  // Yarn classic cannot resolve without installing node_modules
  'yarn-classic': null,
};

const CONFIG_FILES = [
  '.npmrc',
  'pnpm-workspace.yaml',
  '.pnpmfile.cjs',
  '.pnpmfile.mjs',
  '.yarnrc.yml',
  'bunfig.toml',
  'patches',
  '.yarn/releases',
  '.yarn/plugins',
  '.yarn/patches',
];

async function copyIfExists(from: string, to: string): Promise<void> {
  try {
    await mkdir(dirname(to), { recursive: true });
    await cp(from, to, { recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}

export function removeFromJson(manifest: Record<string, unknown>, override: Override): void {
  const field = override.source.slice('package.json#'.length).split('.');
  let container: unknown = manifest;
  for (const part of field) {
    container = isObject(container) ? container[part] : undefined;
  }
  for (const part of override.path.slice(0, -1)) {
    container = isObject(container) ? container[part] : undefined;
  }
  if (isObject(container)) {
    Reflect.deleteProperty(container, override.path.at(-1) ?? '');
  }
}

export function removeFromWorkspaceYaml(text: string, key: string): string {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => /^overrides:\s*(#.*)?$/.test(line));
  if (start === -1) {
    return text;
  }
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (/^\S/.test(line)) {
      break;
    }
    if (line.trim() === '' || line.trim().startsWith('#')) {
      continue;
    }
    const parsed = parseYaml(line.trim());
    if (isObject(parsed) && Object.keys(parsed)[0] === key) {
      lines.splice(i, 1);
      break;
    }
  }
  return lines.join('\n');
}

async function prepareCopy(project: Project, graph: Graph, override: Override): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'stale-overrides-'));
  await cp(join(project.dir, project.lockfile), join(dir, project.lockfile));
  for (const file of CONFIG_FILES) {
    await copyIfExists(join(project.dir, file), join(dir, file));
  }
  for (const importer of graph.importers()) {
    const relative = join(importer.importer ?? '.', 'package.json');
    await copyIfExists(join(project.dir, relative), join(dir, relative));
  }
  await copyIfExists(join(project.dir, 'package.json'), join(dir, 'package.json'));

  if (override.source.startsWith('package.json#')) {
    const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    removeFromJson(manifest, override);
    await writeFile(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  } else {
    const path = join(dir, 'pnpm-workspace.yaml');
    await writeFile(path, removeFromWorkspaceYaml(await readFile(path, 'utf8'), override.key));
  }
  return dir;
}

/** What the fresh lockfile says about the target, where the override used to apply. */
function mismatches(graph: Graph, override: Override): Array<string> {
  const lines: Array<string> = [];
  for (const edge of graph.edgesNamed(override.target.name)) {
    if (!chainMatches(graph, edge.parent, override.chain)) {
      continue;
    }
    if (override.value.kind !== 'range') {
      lines.push(`${label(edge.parent)} depends on ${override.target.name} again`);
      continue;
    }
    const name = edge.child?.name ?? '';
    const version = edge.child?.version ?? null;
    if (version === null) {
      continue;
    }
    if (override.target.range !== null && !satisfies(version, override.target.range, true)) {
      continue;
    }
    if (name !== override.target.name || !satisfies(version, override.value.range, true)) {
      lines.push(
        `${label(edge.parent)} now gets ${name}@${version}, outside ${override.value.range}`,
      );
    }
  }
  return [...new Set(lines)];
}

export async function verifyPrunes(
  project: Project,
  graph: Graph,
  reports: ReadonlyArray<OverrideReport>,
): Promise<Array<OverrideReport>> {
  const command = COMMANDS[project.pm];
  const results: Array<OverrideReport> = [];
  for (const report of reports) {
    if (report.verdict.status !== 'prune') {
      results.push(report);
      continue;
    }
    if (command === null) {
      results.push({
        ...report,
        verdict: {
          ...report.verdict,
          verified: 'not verified: Yarn classic has no lockfile-only install',
        },
      });
      continue;
    }
    const [bin, args] = command;
    const commandText = `${bin} ${args.join(' ')}`;
    let dir: string | null = null;
    try {
      dir = await prepareCopy(project, graph, report.override);
      await run(bin, args, dir);
      const fresh = await loadProject(dir);
      const lines = mismatches(await readGraph(fresh), report.override);
      results.push({
        ...report,
        verdict:
          lines.length === 0
            ? { ...report.verdict, verified: `confirmed by \`${commandText}\` without it` }
            : {
                status: 'keep',
                reasons: lines,
                verified: `\`${commandText}\` without it disagrees`,
              },
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      results.push({
        ...report,
        verdict: { status: 'error', reasons: [`--verify: \`${commandText}\` failed: ${detail}`] },
      });
    } finally {
      if (dir !== null) {
        await rm(dir, { recursive: true, force: true });
      }
    }
  }
  return results;
}
