/** A TOML reader for what `bunfig.toml` holds: tables, strings, numbers, booleans, arrays and inline tables. */

export class TomlError extends Error {
  override name = 'TomlError';
}

type Table = Record<string, unknown>;

function tableAt(root: Table, path: Array<string>): Table {
  let current = root;
  for (const part of path) {
    const next: unknown = current[part] ?? {};
    if (typeof next !== 'object' || next === null || Array.isArray(next)) {
      throw new TomlError(`"${path.join('.')}" is not a table`);
    }
    current[part] = next;
    current = next as Table;
  }
  return current;
}

function assign(root: Table, key: Array<string>, value: unknown): void {
  const last = key.at(-1) ?? '';
  tableAt(root, key.slice(0, -1))[last] = value;
}

class ValueReader {
  index = 0;

  private readonly text: string;
  private readonly line: number;

  constructor(text: string, line: number) {
    this.text = text;
    this.line = line;
  }

  skip(): void {
    for (;;) {
      while (/\s/.test(this.text[this.index] ?? '')) {
        this.index++;
      }
      if (this.text[this.index] !== '#') {
        return;
      }
      while (this.index < this.text.length && this.text[this.index] !== '\n') {
        this.index++;
      }
    }
  }

  done(): boolean {
    this.skip();
    return this.index >= this.text.length;
  }

  value(): unknown {
    this.skip();
    const char = this.text[this.index];
    if (char === '"' || char === "'") {
      return this.string();
    }
    if (char === '[') {
      return this.array();
    }
    if (char === '{') {
      return this.inlineTable();
    }
    const match = /^[^\s,\]}#]+/.exec(this.text.slice(this.index));
    if (match === null) {
      throw new TomlError(`expected a value on line ${this.line}`);
    }
    const [raw] = match;
    this.index += raw.length;
    if (raw === 'true' || raw === 'false') {
      return raw === 'true';
    }
    const number = Number(raw.replaceAll('_', ''));
    if (Number.isNaN(number)) {
      throw new TomlError(`unsupported value "${raw}" on line ${this.line}`);
    }
    return number;
  }

  key(): Array<string> {
    const parts: Array<string> = [];
    for (;;) {
      this.skip();
      const char = this.text[this.index];
      if (char === '"' || char === "'") {
        parts.push(this.string());
      } else {
        const match = /^[\w-]+/.exec(this.text.slice(this.index));
        if (match === null) {
          throw new TomlError(`expected a key on line ${this.line}`);
        }
        this.index += match[0].length;
        parts.push(match[0]);
      }
      this.skip();
      if (this.text[this.index] !== '.') {
        return parts;
      }
      this.index++;
    }
  }

  private string(): string {
    const quote = this.text[this.index];
    this.index++;
    let body = '';
    while (this.index < this.text.length) {
      const char = this.text[this.index] ?? '';
      if (char === quote) {
        this.index++;
        return quote === '"' ? (JSON.parse(`"${body}"`) as string) : body;
      }
      if (quote === '"' && char === '\\') {
        body += this.text.slice(this.index, this.index + 2);
        this.index += 2;
        continue;
      }
      body += char;
      this.index++;
    }
    throw new TomlError(`unterminated string on line ${this.line}`);
  }

  private array(): Array<unknown> {
    const result: Array<unknown> = [];
    this.index++;
    for (;;) {
      this.skip();
      if (this.text[this.index] === ']') {
        this.index++;
        return result;
      }
      result.push(this.value());
      this.skip();
      if (this.text[this.index] === ',') {
        this.index++;
      } else if (this.text[this.index] !== ']') {
        throw new TomlError(`expected "," or "]" on line ${this.line}`);
      }
    }
  }

  private inlineTable(): Table {
    const result: Table = {};
    this.index++;
    for (;;) {
      this.skip();
      if (this.text[this.index] === '}') {
        this.index++;
        return result;
      }
      const key = this.key();
      this.skip();
      if (this.text[this.index] !== '=') {
        throw new TomlError(`expected "=" on line ${this.line}`);
      }
      this.index++;
      assign(result, key, this.value());
      this.skip();
      if (this.text[this.index] === ',') {
        this.index++;
      }
    }
  }
}

function bracketDepth(text: string): number {
  let depth = 0;
  let quote: string | null = null;
  for (const char of text) {
    if (quote !== null) {
      if (char === quote) {
        quote = null;
      }
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '#') {
      break;
    } else if (char === '[' || char === '{') {
      depth++;
    } else if (char === ']' || char === '}') {
      depth--;
    }
  }
  return depth;
}

export function parseToml(text: string): Table {
  const root: Table = {};
  let current = root;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const number = i + 1;
    let line = (lines[i] ?? '').trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    const header = /^\[([^[\]]+)\]\s*(?:#.*)?$/.exec(line);
    if (header !== null) {
      const reader = new ValueReader(header[1] ?? '', number);
      current = tableAt(root, reader.key());
      continue;
    }
    if (line.startsWith('[[')) {
      throw new TomlError(`arrays of tables are not supported (line ${number})`);
    }
    while (bracketDepth(line) > 0 && i + 1 < lines.length) {
      i++;
      line += `\n${lines[i] ?? ''}`;
    }
    const reader = new ValueReader(line, number);
    const key = reader.key();
    reader.skip();
    if (line[reader.index] !== '=') {
      throw new TomlError(`expected "key = value" on line ${number}`);
    }
    reader.index++;
    assign(current, key, reader.value());
    if (!reader.done()) {
      throw new TomlError(`unexpected text on line ${number}`);
    }
  }
  return root;
}
