/** Parses JSON that may hold comments and trailing commas, as `bun.lock` does. */
export function parseJsonc(text: string): unknown {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const char = text[i] ?? '';
    if (char === '"') {
      const start = i;
      i++;
      while (i < text.length && text[i] !== '"') {
        i += text[i] === '\\' ? 2 : 1;
      }
      i++;
      out += text.slice(start, i);
      continue;
    }
    if (char === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') {
        i++;
      }
      continue;
    }
    if (char === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
      continue;
    }
    if (char === ',') {
      const rest = /^,(?:\s|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*([}\]])/.exec(text.slice(i));
      if (rest !== null) {
        i++;
        continue;
      }
    }
    out += char;
    i++;
  }
  return JSON.parse(out);
}
