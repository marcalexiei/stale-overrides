/**
 * A YAML reader for the subset package managers write: block and flow collections, quoted and
 * plain scalars, block scalars and comments. Anchors, aliases, tags and complex keys are refused.
 */

export class YamlError extends Error {
  override name = 'YamlError';
}

interface Line {
  readonly indent: number;
  readonly text: string;
  readonly number: number;
}

function stripComment(raw: string): string {
  let quote: string | null = null;
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    if (quote !== null) {
      if (quote === '"' && char === '\\') {
        i++;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      const previous = raw[i - 1];
      // a quote only opens a scalar at its start, not inside `it's`
      if (previous === undefined || /[\s:,[{-]/.test(previous)) {
        quote = char;
      }
    } else if (char === '#' && (i === 0 || /\s/.test(raw[i - 1] ?? ''))) {
      return raw.slice(0, i).trimEnd();
    }
  }
  return raw.trimEnd();
}

function unescapeDouble(body: string, line: number): string {
  return body.replaceAll(/\\(u[\da-fA-F]{4}|x[\da-fA-F]{2}|.)/g, (_match, code: string) => {
    switch (code.charAt(0)) {
      case 'n':
        return '\n';
      case 't':
        return '\t';
      case 'r':
        return '\r';
      case '0':
        return '\0';
      case 'u':
      case 'x':
        return String.fromCodePoint(Number.parseInt(code.slice(1), 16));
      case '"':
      case '\\':
      case '/':
      case ' ':
        return code;
      default:
        throw new YamlError(`unsupported escape \\${code} on line ${line}`);
    }
  });
}

/** Reads a quoted scalar starting at `start`; returns the value and the index after it. */
function readQuoted(text: string, start: number, line: number): [string, number] {
  const quote = text[start];
  let i = start + 1;
  let body = '';
  while (i < text.length) {
    const char = text[i];
    if (quote === '"' && char === '\\') {
      body += text.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (char === quote) {
      if (quote === "'" && text[i + 1] === "'") {
        body += "'";
        i += 2;
        continue;
      }
      return [quote === '"' ? unescapeDouble(body, line) : body, i + 1];
    }
    body += char;
    i++;
  }
  throw new YamlError(`unterminated string on line ${line}`);
}

function plainScalar(text: string, line: number): unknown {
  const value = text.trim();
  if (/^[&*!]/.test(value) || value.startsWith('? ')) {
    throw new YamlError(`anchors, aliases, tags and complex keys are not supported (line ${line})`);
  }
  if (value === '' || value === '~' || value === 'null' || value === 'Null' || value === 'NULL') {
    return null;
  }
  if (value === 'true' || value === 'True' || value === 'TRUE') {
    return true;
  }
  if (value === 'false' || value === 'False' || value === 'FALSE') {
    return false;
  }
  if (/^[-+]?\d+$/.test(value)) {
    return Number(value);
  }
  if (/^[-+]?(?:\d+\.\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(value)) {
    return Number(value);
  }
  return value;
}

class FlowReader {
  private index = 0;

  private readonly text: string;
  private readonly line: number;

  constructor(text: string, line: number) {
    this.text = text;
    this.line = line;
  }

  read(): unknown {
    const value = this.value();
    this.skipSpace();
    if (this.index < this.text.length) {
      throw new YamlError(`unexpected "${this.text.slice(this.index)}" on line ${this.line}`);
    }
    return value;
  }

  private skipSpace(): void {
    while (/\s/.test(this.text[this.index] ?? '')) {
      this.index++;
    }
  }

  private value(): unknown {
    this.skipSpace();
    const char = this.text[this.index];
    if (char === '{') {
      return this.mapping();
    }
    if (char === '[') {
      return this.sequence();
    }
    if (char === '"' || char === "'") {
      const [value, next] = readQuoted(this.text, this.index, this.line);
      this.index = next;
      return value;
    }
    const start = this.index;
    while (this.index < this.text.length && !/[,}\]]/.test(this.text[this.index] ?? '')) {
      this.index++;
    }
    return plainScalar(this.text.slice(start, this.index), this.line);
  }

  private key(): string {
    this.skipSpace();
    const char = this.text[this.index];
    if (char === '"' || char === "'") {
      const [value, next] = readQuoted(this.text, this.index, this.line);
      this.index = next;
      return value;
    }
    const start = this.index;
    while (this.index < this.text.length) {
      const current = this.text[this.index];
      const next = this.text[this.index + 1] ?? ' ';
      if (current === ':' && /[\s,}\]]/.test(next)) {
        break;
      }
      if (current === ',' || current === '}') {
        break;
      }
      this.index++;
    }
    return this.text.slice(start, this.index).trim();
  }

  private mapping(): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    this.index++;
    for (;;) {
      this.skipSpace();
      if (this.text[this.index] === '}') {
        this.index++;
        return result;
      }
      const key = this.key();
      this.skipSpace();
      let value: unknown = null;
      if (this.text[this.index] === ':') {
        this.index++;
        value = this.value();
      }
      result[key] = value;
      this.skipSpace();
      if (this.text[this.index] === ',') {
        this.index++;
      } else if (this.text[this.index] !== '}') {
        throw new YamlError(`expected "," or "}" on line ${this.line}`);
      }
    }
  }

  private sequence(): Array<unknown> {
    const result: Array<unknown> = [];
    this.index++;
    for (;;) {
      this.skipSpace();
      if (this.text[this.index] === ']') {
        this.index++;
        return result;
      }
      result.push(this.value());
      this.skipSpace();
      if (this.text[this.index] === ',') {
        this.index++;
      } else if (this.text[this.index] !== ']') {
        throw new YamlError(`expected "," or "]" on line ${this.line}`);
      }
    }
  }
}

function flowBalance(text: string): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote !== null) {
      if (quote === '"' && char === '\\') {
        i++;
      } else if (char === quote) {
        quote = null;
      }
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '{' || char === '[') {
      depth++;
    } else if (char === '}' || char === ']') {
      depth--;
    }
  }
  return depth;
}

/** Folded scalars join lines with a space; an empty line stays a line break. */
function foldLines(lines: ReadonlyArray<string>): string {
  let body = lines[0] ?? '';
  for (const part of lines.slice(1)) {
    body = part === '' ? `${body}\n` : `${body} ${part}`;
  }
  return body;
}

/** Finds the `:` that ends a block mapping key, or -1 when the line is not a key. */
function keyEnd(text: string): number {
  if (text.startsWith('"') || text.startsWith("'")) {
    let end: number;
    try {
      [, end] = readQuoted(text, 0, 0);
    } catch {
      return -1;
    }
    const rest = text.slice(end).trimStart();
    return rest.startsWith(':') && /^:(\s|$)/.test(rest) ? text.length - rest.length : -1;
  }
  if (text.startsWith('{') || text.startsWith('[')) {
    return -1;
  }
  const spaced = text.indexOf(': ');
  if (spaced !== -1) {
    return spaced;
  }
  return text.endsWith(':') ? text.length - 1 : -1;
}

function readKey(text: string, end: number, line: number): string {
  const raw = text.slice(0, end).trim();
  if (raw.startsWith('"') || raw.startsWith("'")) {
    return readQuoted(raw, 0, line)[0];
  }
  if (raw.startsWith('? ') || /^[&*!]/.test(raw)) {
    throw new YamlError(`complex keys, anchors and tags are not supported (line ${line})`);
  }
  return raw;
}

class BlockReader {
  private readonly raw: Array<string>;
  private index = 0;

  constructor(text: string) {
    this.raw = text.split(/\r?\n/);
  }

  read(): unknown {
    const value = this.node(0);
    const next = this.peek();
    if (next !== null) {
      throw new YamlError(`unexpected content on line ${next.number}`);
    }
    return value;
  }

  private peek(): Line | null {
    while (this.index < this.raw.length) {
      const raw = this.raw[this.index] ?? '';
      const text = stripComment(raw);
      if (text.trim() === '') {
        this.index++;
        continue;
      }
      if (raw.startsWith('\t')) {
        throw new YamlError(`tabs cannot indent YAML (line ${this.index + 1})`);
      }
      const indent = text.length - text.trimStart().length;
      return { indent, text: text.trimStart(), number: this.index + 1 };
    }
    return null;
  }

  private node(minIndent: number): unknown {
    const line = this.peek();
    if (line === null || line.indent < minIndent) {
      return null;
    }
    if (line.text === '-' || line.text.startsWith('- ')) {
      return this.sequence(line.indent);
    }
    if (keyEnd(line.text) !== -1) {
      return this.mapping(line.indent);
    }
    this.index++;
    return this.inlineValue(line.text, line.number, line.indent);
  }

  private inlineValue(text: string, number: number, indent: number): unknown {
    if (/^[|>][-+]?\d*$/.test(text)) {
      return this.blockScalar(text, indent);
    }
    if (text.startsWith('{') || text.startsWith('[')) {
      let joined = text;
      while (flowBalance(joined) > 0) {
        const next = this.raw[this.index];
        if (next === undefined) {
          throw new YamlError(`unterminated flow collection on line ${number}`);
        }
        joined += ` ${stripComment(next).trim()}`;
        this.index++;
      }
      return new FlowReader(joined, number).read();
    }
    if (text.startsWith('"') || text.startsWith("'")) {
      const [value, end] = readQuoted(text, 0, number);
      if (text.slice(end).trim() !== '') {
        throw new YamlError(`unexpected text after string on line ${number}`);
      }
      return value;
    }
    return plainScalar(text, number);
  }

  private blockScalar(header: string, parentIndent: number): string {
    const folded = header.startsWith('>');
    const chomp = header.includes('-') ? 'strip' : header.includes('+') ? 'keep' : 'clip';
    const lines: Array<string> = [];
    let indent: number | null = null;
    while (this.index < this.raw.length) {
      const raw = this.raw[this.index] ?? '';
      if (raw.trim() === '') {
        lines.push('');
        this.index++;
        continue;
      }
      const current = raw.length - raw.trimStart().length;
      if (current <= parentIndent) {
        break;
      }
      indent ??= current;
      if (current < indent) {
        break;
      }
      lines.push(raw.slice(indent));
      this.index++;
    }
    let trailing = 0;
    while (lines.length > 0 && lines.at(-1) === '') {
      lines.pop();
      trailing++;
    }
    const body = folded ? foldLines(lines) : lines.join('\n');
    if (chomp === 'strip' || body === '') {
      return body;
    }
    return chomp === 'keep' ? body + '\n'.repeat(trailing + 1) : `${body}\n`;
  }

  private mapping(indent: number): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (;;) {
      const line = this.peek();
      if (line === null || line.indent < indent) {
        return result;
      }
      if (line.indent > indent) {
        throw new YamlError(`unexpected indentation on line ${line.number}`);
      }
      const end = keyEnd(line.text);
      if (end === -1) {
        throw new YamlError(`expected a "key: value" pair on line ${line.number}`);
      }
      const key = readKey(line.text, end, line.number);
      const rest = line.text.slice(end + 1).trim();
      this.index++;
      if (rest === '') {
        const next = this.peek();
        const sameIndentSequence =
          next?.indent === indent && (next.text === '-' || next.text.startsWith('- '));
        result[key] = sameIndentSequence ? this.sequence(indent) : this.node(indent + 1);
      } else {
        result[key] = this.inlineValue(rest, line.number, indent);
      }
    }
  }

  private sequence(indent: number): Array<unknown> {
    const result: Array<unknown> = [];
    for (;;) {
      const line = this.peek();
      if (
        line === null ||
        line.indent !== indent ||
        !(line.text === '-' || line.text.startsWith('- '))
      ) {
        return result;
      }
      const content = line.text.slice(1).trimStart();
      if (content === '') {
        this.index++;
        result.push(this.node(indent + 1));
        continue;
      }
      const offset = line.text.length - content.length;
      if (keyEnd(content) !== -1 || content === '-' || content.startsWith('- ')) {
        // the item's first key sits after the dash: re-read the line as if the dash were spaces
        this.raw[this.index] = ' '.repeat(indent + offset) + content;
        result.push(this.node(indent + offset));
        continue;
      }
      this.index++;
      result.push(this.inlineValue(content, line.number, indent));
    }
  }
}

/** Parses every document of a YAML stream. */
export function parseYamlDocuments(text: string): Array<unknown> {
  const documents: Array<string> = [];
  let current: Array<string> = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^---(\s|$)/.test(line)) {
      if (current.some((entry) => stripComment(entry).trim() !== '')) {
        documents.push(current.join('\n'));
      }
      current = [line.slice(3)];
    } else if (/^\.\.\.(\s|$)/.test(line)) {
      documents.push(current.join('\n'));
      current = [];
    } else {
      current.push(line);
    }
  }
  if (current.some((entry) => stripComment(entry).trim() !== '')) {
    documents.push(current.join('\n'));
  }
  return documents.map((document) => new BlockReader(document).read());
}

/** Parses a single-document YAML file; a multi-document stream yields its last document. */
export function parseYaml(text: string): unknown {
  const documents = parseYamlDocuments(text);
  return documents.at(-1) ?? null;
}
