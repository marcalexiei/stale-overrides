import { readFile, writeFile } from 'node:fs/promises';

import { isObject } from './project.ts';
import type { Override } from './types.ts';

export const INTENT_FILE = 'overrides.json';

export interface Intent {
  readonly why: string;
  readonly ceiling?: true;
}

class IntentError extends Error {
  override name = 'IntentError';
}

export interface IntentFile {
  /** `null` when the file does not exist. */
  readonly entries: ReadonlyMap<string, Intent> | null;
  /** Entries whose shape is wrong, such as an empty `why`. */
  readonly problems: ReadonlyArray<string>;
}

export async function readIntents(path: string): Promise<IntentFile> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { entries: null, problems: [] };
    }
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new IntentError(`${INTENT_FILE} is not valid JSON: ${(error as Error).message}`);
  }
  if (!isObject(raw)) {
    throw new IntentError(`${INTENT_FILE} must be an object keyed by override`);
  }
  const entries = new Map<string, Intent>();
  const problems: Array<string> = [];
  for (const [key, value] of Object.entries(raw)) {
    if (!isObject(value)) {
      problems.push(`"${key}" must be an object with a "why"`);
      continue;
    }
    const extra = Object.keys(value).filter((field) => field !== 'why' && field !== 'ceiling');
    if (extra.length > 0) {
      problems.push(`"${key}" has unknown fields: ${extra.join(', ')}`);
    }
    if (typeof value['why'] !== 'string' || value['why'].trim() === '') {
      problems.push(`"${key}" needs a "why" saying what the override is for`);
    }
    if (value['ceiling'] !== undefined && value['ceiling'] !== true) {
      problems.push(`"${key}" sets "ceiling" to something other than true`);
    }
    entries.set(key, {
      why: typeof value['why'] === 'string' ? value['why'] : '',
      ...(value['ceiling'] === true ? { ceiling: true } : {}),
    });
  }
  return { entries, problems };
}

/** Adds an empty entry for every override that has none, keeping the existing ones as they are. */
export async function initIntents(
  path: string,
  overrides: ReadonlyArray<Override>,
): Promise<Array<string>> {
  let output: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (isObject(parsed)) {
      output = parsed;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  const added: Array<string> = [];
  for (const override of overrides) {
    if (!(override.key in output)) {
      output[override.key] = { why: '' };
      added.push(override.key);
    }
  }
  if (added.length > 0) {
    await writeFile(path, `${JSON.stringify(output, null, 2)}\n`);
  }
  return added;
}
