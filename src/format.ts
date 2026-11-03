import { styleText } from 'node:util';

import type { Report } from './check.ts';
import type { Status } from './types.ts';

type Style = Parameters<typeof styleText>[0];

const LABELS: Record<Status, [string, Style]> = {
  prune: ['PRUNE', 'yellow'],
  keep: ['KEEP ', 'green'],
  error: ['ERROR', 'red'],
};

function paint(style: Style, text: string, color: boolean): string {
  return color ? styleText(style, text, { validateStream: false }) : text;
}

export function formatReport(report: Report, color: boolean): string {
  const out: Array<string> = [
    paint(
      'bold',
      `stale-overrides · ${report.pm} · ${report.lockfile} · ${report.releaseAge}`,
      color,
    ),
  ];
  if (report.overrides.length === 0) {
    out.push('', 'No overrides found.');
  }

  const bySource = Map.groupBy(report.overrides, (entry) => entry.override.source);
  for (const [source, entries] of bySource) {
    out.push('', paint('underline', source, color));
    for (const { override, verdict } of entries) {
      const [text, style] = LABELS[verdict.status];
      const tag = verdict.ceiling === true ? ' (ceiling)' : '';
      out.push(
        `  ${paint(style, text, color)}  ${override.key}: ${override.raw}${paint('dim', tag, color)}`,
      );
      for (const reason of verdict.reasons) {
        out.push(`         ${paint('dim', reason, color)}`);
      }
      if (verdict.verified !== undefined) {
        out.push(`         ${paint('dim', verdict.verified, color)}`);
      }
    }
  }

  const sync = [
    ...report.missingIntents.map((key) => `  MISSING  ${key}: add an entry with a "why"`),
    ...report.orphanIntents.map((key) => `  ORPHAN   ${key}: no override has this key`),
    ...report.intentProblems.map((problem) => `  INVALID  ${problem}`),
  ];
  if (sync.length > 0) {
    out.push(
      '',
      paint('underline', report.intentFile, color),
      ...sync.map((line) => paint('yellow', line, color)),
    );
  }

  const count = (status: Status): number =>
    report.overrides.filter((entry) => entry.verdict.status === status).length;
  const total = report.overrides.length;
  const outOfSync = sync.length > 0 ? `; ${report.intentFile} out of sync` : '';
  out.push(
    '',
    `${total} override${total === 1 ? '' : 's'}: ${count('keep')} keep, ${count('prune')} prune, ${count('error')} error${outOfSync}`,
  );
  return `${out.join('\n')}\n`;
}
