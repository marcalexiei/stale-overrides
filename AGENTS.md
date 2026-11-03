# AGENTS.md

Guidance for coding agents in this repository. Durable rules live here; fix a rule in the change
that makes it untrue.

## Before you change anything

- **Don't commit, push, open a PR or comment on one unless asked.**
- **A change to what ships (`src/`, `bin.js`, `package.json`) carries a changeset, unasked.** See
  [Changesets](#changesets).
- **Run `pnpm check-all` before handing work over**: it is every check CI runs.
- **No runtime dependencies.** The semver, YAML, TOML, JSONC and yarn lockfile readers are
  handwritten in `src/util/` and `src/lockfile/`; extend them rather than adding a package.

## What this is

A CLI, and the library behind it, that tells when a dependency override is no longer needed, for
npm, Yarn classic and berry, Bun and pnpm. The README explains the verdicts and how they are
reached.

| Path               | What it is                                                                |
| ------------------ | ------------------------------------------------------------------------- |
| `src/cli.ts`       | argument parsing, output and the exit code                                |
| `src/check.ts`     | the entry point: project, overrides, intents, verdicts, report            |
| `src/project.ts`   | finds the package manager and reads its manifests and config              |
| `src/overrides.ts` | reads every override shape into one `Override` type                       |
| `src/lockfile/`    | reads each lockfile format into a dependency `Graph`                      |
| `src/registry/`    | `.npmrc`/yarnrc/bunfig auth, release age gates, the packument client      |
| `src/evaluate.ts`  | judges one override: PRUNE, KEEP or ERROR                                 |
| `src/verify.ts`    | `--verify`: reruns a PRUNE through the package manager's lockfile install |
| `src/intent.ts`    | the `overrides.json` sidecar                                              |
| `tests/fixtures/`  | one project per package manager, lockfiles hand-written in its own format |

## Commands

```sh
pnpm test --run       # vitest, one run (`pnpm test` watches)
pnpm test:coverage    # the same run, failing under the floors in vitest.config.coverage.ts
pnpm typecheck        # tsc over src and tests
pnpm lint             # oxlint, type-aware
pnpm lint:knip        # unused files, exports and dependencies
pnpm lint:publish     # attw + publint over the packed tarball; needs `pnpm build` first
pnpm format           # oxfmt (`format:check` in CI)
pnpm build            # tsc into dist/
pnpm dev <dir>        # run the CLI from source
pnpm check-all        # every check CI runs, in one command
```

- **Keep `check-all` in step with `.github/workflows/ci.yml`.**

## Verdicts

- **A failure is never a PRUNE.** Any fetch, parse or install error becomes ERROR, so a flaky
  network cannot tell anyone to delete an override.
- **A ceiling (`ceiling: true` in `overrides.json`) is never a PRUNE.**

## TypeScript

- **Source runs unbuilt through Node's type stripping** (`pnpm dev`, the CLI tests), so only
  erasable syntax: no parameter properties, enums or namespaces. `erasableSyntaxOnly` enforces it.
- **Relative imports carry `.ts`**; `rewriteRelativeImportExtensions` turns them into `.js` in
  `dist`.

## Testing

- **Tests never reach the network.** `tests/helpers/registry.ts` serves the packages in
  `tests/helpers/packages.ts`, with `NOW` fixed so release ages do not drift.
- **A fixture lockfile mirrors what its package manager writes**, so oxfmt skips
  `tests/fixtures/**`.
- **`--verify` tests put a fake package manager on `PATH`**; never run a real install in a test.
- **`test:coverage` floors sit just under what the tests reach**: raise one after adding tests,
  lower one only with the owner. `src/cli.ts` is excluded because only a child process runs it.
- **A test that can pass without the code it covers is a bug**: break the code and watch it fail.

## Comments

**A comment states the reason, never the behaviour**, in one line where possible.

## Linting and formatting

oxlint and oxfmt extend `@marcalexiei/oxlint-config` and `@marcalexiei/oxfmt-config`.

- **Every local override carries its reason in `oxlint.config.ts`.**
- **The autofixer is not a review**: typecheck, test and read the diff after `oxlint --fix`.

## Changesets

- **The first line is a conventional commit with no scope** (`feat: …`, `fix!: …`).
- **Pre-1.0, a breaking change is `minor`.**

## Dependencies and pnpm

- **pnpm is 12.x**; `pnpm-workspace.yaml` gives each setting's reason.
- **Dependabot groups the oxc tools and changesets**, and holds `@types/node` on the `.nvmrc` major.
- **`lefthook` installs a pre-commit hook** (format, lint, test) on `pnpm install`; a workflow that
  commits sets `LEFTHOOK: 0`.
