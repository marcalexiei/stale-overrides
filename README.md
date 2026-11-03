# stale-overrides

Tells you when a dependency override is no longer needed, for npm, Yarn (classic and berry),
Bun and pnpm.

An override is added for a reason: a parent pins a vulnerable range, a shim drags in a
deprecated package, a type package lags a major. Months later the reason is gone, but the
override is still there, forcing a version nobody needs to force. `stale-overrides` reads every
override, finds in the lockfile which packages depend on its target, and asks the registry what
those packages would resolve to without it.

```console
$ npx stale-overrides --verify
stale-overrides · pnpm · pnpm-lock.yaml · pnpm default minimumReleaseAge 1d

pnpm-workspace.yaml#overrides
  PRUNE  ms: ^2.1.2
         every dependent already resolves ms within ^2.1.2
         real-pnpm depends on debug 4.3.4, and debug@4.3.4 asks for ms 2.1.2, which already resolves to 2.1.2
         confirmed by `pnpm install --lockfile-only --ignore-scripts --no-frozen-lockfile` without it
  KEEP   chalk>supports-color: ^7.0.0
         real-pnpm depends on chalk 2.4.2, and chalk@2.4.2 asks for supports-color ^5.3.0, which resolves to 5.5.0, outside ^7.0.0

2 overrides: 1 keep, 1 prune, 0 error
```

It has no runtime dependencies.

## Usage

```sh
npx stale-overrides [dir] [options]
```

| Option            | What it does                                                            |
| ----------------- | ----------------------------------------------------------------------- |
| `--intent <file>` | the intent file, relative to `dir` (default `overrides.json`)           |
| `--init`          | add an empty entry to the intent file for each override without one     |
| `--verify`        | confirm each PRUNE with the package manager's own lockfile-only install |
| `--json`          | print the report as JSON                                                |

`dir` is the project root, where `package.json` and the lockfile are. The package manager is
the one whose lockfile is there; with several, the `packageManager` field decides.

### Exit codes

| Code | Meaning                                                               |
| ---- | --------------------------------------------------------------------- |
| 0    | nothing to do                                                         |
| 1    | an override can be pruned, or the intent file is out of sync          |
| 2    | an error: the project, the lockfile or the registry could not be read |

## Verdicts

- **PRUNE**: the override is a no-op.
  - For a version override: every dependent of the target would already land on a version the
    override allows.
  - For an alias, a removal or any other replacement: no dependent asks for the original name
    any more.
  - Also when nothing in the lockfile depends on the target at all.
- **KEEP**: some dependent still needs it. The report names that dependent, the range it asks
  for, and what that range resolves to. When a newer version of that dependent no longer needs
  the override, the report says which update would end the need.
- **ERROR**: a fetch or a parse failed. A failure is never read as "not needed", so a flaky
  network cannot produce a PRUNE.

## The intent file

`overrides.json` sits next to `package.json`. It records why each override exists, keyed by the
override exactly as written:

```json
{
  "node-fetch": {
    "why": "Keeps the deprecated node-domexception out of the lockfile; no code of node-fetch runs here."
  },
  "sitemap>@types/node": {
    "why": "sitemap 9 pins ^24, and @astrojs/sitemap has no release on sitemap 10 yet."
  },
  "react": {
    "why": "Never 19 until the design system supports it.",
    "ceiling": true
  }
}
```

- `why` is required and must not be empty.
- `ceiling: true` marks a deliberate cap, such as "never 2.x". A ceiling is never reported as
  PRUNE, because a cap is still wanted even when nothing currently exceeds it.
- The check fails (exit 1) when an override has no entry, or an entry has no override. That is
  what keeps the file honest: removing an override means removing its entry too.
- npm nests overrides; their key joins the path with `>`, so
  `{ "overrides": { "debug": { "ms": "^2" } } }` is `debug>ms`.

`--init` writes an empty entry for every override that has none, then the check fails until
each `why` is filled in.

## What it reads

| Package manager | Overrides                                                                                                                                                                                               | Lockfile                                                           | Release age                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| npm             | `overrides`: nested objects, `name@range` keys, `.`, `$name` references                                                                                                                                 | `package-lock.json` or `npm-shrinkwrap.json` v2/v3                 | `min-release-age` in `.npmrc` (days)                                                          |
| Yarn classic    | `resolutions`: `child`, `parent/child`, `**/child`, `parent/**/child`                                                                                                                                   | `yarn.lock` v1                                                     | none                                                                                          |
| Yarn berry      | `resolutions`, including `name@npm:range` descriptors                                                                                                                                                   | `yarn.lock`                                                        | `npmMinimalAgeGate` and `npmPreapprovedPackages` in `.yarnrc.yml`                             |
| Bun             | `overrides` and `resolutions`                                                                                                                                                                           | `bun.lock` (text)                                                  | `install.minimumReleaseAge` (seconds) and `minimumReleaseAgeExcludes` in `bunfig.toml`        |
| pnpm            | `pnpm.overrides` and `resolutions` in `package.json`, `overrides` in `pnpm-workspace.yaml`: `parent>child`, `name@range` selectors, `npm:` aliases, `catalog:` values, `-` removals, `$name` references | `pnpm-lock.yaml` v6 and v9, including pnpm 11+'s two-document form | `minimumReleaseAge` (minutes) and `minimumReleaseAgeExclude`; one day by default from pnpm 11 |

`catalog:` values resolve from pnpm's `catalog`/`catalogs`, Bun's `catalog`/`catalogs` in
`package.json`, and Yarn's in `.yarnrc.yml`.

## How it decides

For each override:

1. It finds, in the lockfile, every package that depends on the target under the name the
   override matches, kept to those inside the override's parent chain (`parent>child`,
   `parent/child`, or npm's nesting, which matches the parent anywhere above).
2. For each such dependent, it reads from the registry the range that dependent declares for
   the target, both at its locked version and at the version its own dependents would resolve
   it to today.
3. It resolves that range against the target's published versions the way the package manager
   would: `latest` when it fits, otherwise the newest match, skipping deprecated versions and
   versions younger than the release age gate.
4. A version selector on the target (`child@<2`) narrows step 1 to dependents whose range it
   matches, with each package manager's rule: pnpm wants the range to be a subset of the
   selector, npm and Bun want them to intersect, and Yarn wants the same descriptor.

### `--verify`

The registry analysis can be wrong where a package manager has its own rules, such as peer
resolution or hoisting. `--verify` checks each PRUNE the package manager's own way: it copies the
manifests, the lockfile and the config files to a temporary folder, removes the override there,
runs a lockfile-only install, and reads the new lockfile.

| Package manager | Command                                                                 |
| --------------- | ----------------------------------------------------------------------- |
| npm             | `npm install --package-lock-only --ignore-scripts --no-audit --no-fund` |
| pnpm            | `pnpm install --lockfile-only --ignore-scripts --no-frozen-lockfile`    |
| Yarn berry      | `yarn install --mode=update-lockfile`                                   |
| Bun             | `bun install --lockfile-only --ignore-scripts`                          |
| Yarn classic    | not supported: it has no lockfile-only install                          |

If the new lockfile puts the target outside the override, or a dependent asks for a removed
name again, the PRUNE becomes a KEEP. If the install fails, it becomes an ERROR. The project
itself is never touched.

## Registry and authentication

Packuments are fetched in their abbreviated form, and in full only when the release age gate
needs publish times. The registry and credentials come from:

- `.npmrc` in the project, then the user's (`npm_config_userconfig` or `~/.npmrc`), with
  `${ENV}` expansion: `registry`, `@scope:registry`, `//host/:_authToken`, `_auth`, and
  `username` with `_password`
- `npm_config_registry` in the environment
- for Yarn berry, which ignores `.npmrc`: `npmRegistryServer`, `npmScopes`, `npmAuthToken` and
  `npmAuthIdent` in `.yarnrc.yml`
- for Bun, on top of `.npmrc`: `install.registry` and `install.scopes` in `bunfig.toml`

## In CI

```yaml
- name: Check overrides
  run: npx stale-overrides
```

Exit 1 fails the job when an override can go or the intent file drifted; exit 2 when the
registry could not be reached, so a network blip shows as an error rather than a clean pass.

## Limits

- Range arithmetic for selectors (`subset`, `intersects`) orders prerelease tags but does not
  model npm's prerelease opt-in rules.
- Up to 20 dependents of each parent are re-resolved to find the version a fresh install would
  pick; the locked version is always checked.
- A pnpm removal without a parent (`foo: '-'`) leaves no trace in the lockfile, so every package
  in it is checked against the registry.
- `--verify` removes one override at a time, so two overrides that force the same thing confirm
  each other.
- `bun.lockb` (binary) and npm lockfile v1 are not read. Run `bun install --save-text-lockfile`
  or npm 7+ to upgrade them.
- The YAML reader covers what package managers write; anchors, aliases and tags are refused
  with an error rather than misread.

## Prior art

[`pnpm-override-prune`](https://github.com/iwamot/pnpm-override-prune) does the registry
resolution, `.npmrc` authentication and release age model this tool builds on, for pnpm and for
overrides that set a version floor. `stale-overrides` extends the idea to every override shape
and package manager, adds the intent file, and confirms verdicts with the package manager itself.

## License

MIT
