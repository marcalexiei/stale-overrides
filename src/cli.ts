import { readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { check } from './check.ts';
import { formatReport } from './format.ts';
import { INTENT_FILE, initIntents } from './intent.ts';
import { readOverrides } from './overrides.ts';
import { loadProject } from './project.ts';

const HELP = `Usage: stale-overrides [dir] [options]

Tells which dependency overrides are no longer needed, for npm, Yarn, Bun and pnpm.

Options:
  --intent <file>  intent file, relative to dir (default: ${INTENT_FILE})
  --init           add an empty entry to the intent file for each override without one
  --verify         confirm each PRUNE with the package manager's lockfile-only install
  --json           print the report as JSON
  -h, --help       show this help
  -v, --version    show the version

Exit codes: 0 nothing to do, 1 something to prune or the intent file is out of sync, 2 an error.
`;

function version(): string {
  const manifest = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as {
    version: string;
  };
  return manifest.version;
}

async function main(argv: Array<string>): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      intent: { type: 'string' },
      init: { type: 'boolean' },
      verify: { type: 'boolean' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
  if (values.help === true) {
    process.stdout.write(HELP);
    return 0;
  }
  if (values.version === true) {
    process.stdout.write(`${version()}\n`);
    return 0;
  }
  const cwd = resolve(positionals[0] ?? '.');
  const intentFile = values.intent ?? INTENT_FILE;

  if (values.init === true) {
    const overrides = readOverrides(await loadProject(cwd));
    const path = isAbsolute(intentFile) ? intentFile : join(cwd, intentFile);
    const added = await initIntents(path, overrides);
    process.stderr.write(
      added.length === 0
        ? `${intentFile} already has an entry for every override\n`
        : `added ${added.length} entr${added.length === 1 ? 'y' : 'ies'} to ${intentFile}; fill in each "why"\n`,
    );
  }

  const report = await check({ cwd, intentFile, verify: values.verify === true });
  process.stdout.write(
    values.json === true
      ? `${JSON.stringify(report, null, 2)}\n`
      : formatReport(report, process.stdout.isTTY && !process.env['NO_COLOR']),
  );
  return report.exitCode;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(
    `stale-overrides: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 2;
}
