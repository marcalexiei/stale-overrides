import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeVersion {
  readonly deps?: Record<string, string>;
  readonly time: string;
  readonly deprecated?: string;
}

export interface FakePackage {
  readonly versions: Record<string, FakeVersion>;
  readonly latest?: string;
}

export interface FakeRegistry {
  readonly url: string;
  /** Names requested, with `full` when the full document was asked for. */
  readonly requests: Array<string>;
  close: () => Promise<void>;
}

function packument(name: string, fake: FakePackage, full: boolean): unknown {
  const entries = Object.entries(fake.versions);
  const versions = Object.fromEntries(
    entries.map(([version, info]) => [
      version,
      {
        name,
        version,
        dependencies: info.deps ?? {},
        ...(info.deprecated === undefined ? {} : { deprecated: info.deprecated }),
      },
    ]),
  );
  const times = entries.map(([, info]) => info.time).toSorted();
  return {
    name,
    'dist-tags': { latest: fake.latest ?? entries.at(-1)?.[0] },
    versions,
    modified: times.at(-1),
    // the abbreviated document carries no publish times, like the npm registry's
    ...(full
      ? { time: Object.fromEntries(entries.map(([version, info]) => [version, info.time])) }
      : {}),
  };
}

/** Serves packuments for `packages`; names in `failing` answer HTTP 500 every time. */
export async function startRegistry(
  packages: Record<string, FakePackage>,
  failing: ReadonlySet<string> = new Set(),
): Promise<FakeRegistry> {
  const requests: Array<string> = [];
  const server = createServer((request, response) => {
    const name = decodeURIComponent((request.url ?? '/').slice(1));
    const full = request.headers.accept === 'application/json';
    requests.push(full ? `${name} full` : name);
    const fake = packages[name];
    if (failing.has(name)) {
      response.writeHead(500).end();
      return;
    }
    if (fake === undefined) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(packument(name, fake, full)));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: async () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}
