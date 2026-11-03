# Contributing

## Setup

<https://marcalexiei.github.io/contribute/setup-pnpm-nvm.html>

## Checks

```shell
pnpm run check-all
```

Tests run offline: `tests/helpers/registry.ts` serves the packages in `tests/helpers/packages.ts`
from a local server, so no fixture depends on what npm publishes next.

`tests/fixtures` holds one project per package manager, each with a hand-written lockfile in
that package manager's format.

## Commit rules

<https://marcalexiei.github.io/contribute/commit-rules.html>
