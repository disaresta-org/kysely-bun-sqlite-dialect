# example-typescript-package

<!-- REPLACE: point these at your own package name -->
[![NPM version](https://img.shields.io/npm/v/example-typescript-package.svg?style=flat-square)](https://www.npmjs.com/package/example-typescript-package)
![NPM Downloads](https://img.shields.io/npm/dm/example-typescript-package)
[![TypeScript](https://img.shields.io/badge/%3C%2F%3E-TypeScript-%230074c1.svg)](http://www.typescriptlang.org/)

Template for creating a new NPM package with ESM and CJS support.

## Toolchain

| Concern         | Tool                                                   |
| --------------- | ------------------------------------------------------ |
| Package manager | [bun](https://bun.sh)                                   |
| Bundler         | [tsdown](https://tsdown.dev) (Rolldown)                 |
| Type checking   | TypeScript 7 (native compiler)                          |
| Lint / format   | [biome](https://biomejs.dev)                            |
| Tests           | `bun test` (built in, Jest-compatible)                  |
| Task runner     | [turbo](https://turbo.build)                            |
| Versioning      | [changesets](https://github.com/changesets/changesets)  |
| Publishing      | npm OIDC trusted publishing (no long-lived token)       |

`bunfig.toml` sets `[run] bun = true`, so every script and `node_modules/.bin`
entry executes under Bun's runtime rather than deferring to its
`#!/usr/bin/env node` shebang. Building, type checking, linting and testing all
work with no Node.js installed at all.

Publishing is the one exception: changesets shells out to the npm CLI, and npm
is what implements OIDC trusted publishing. So `release.yml` and
`release-snapshot.yml` set up Node; `lint.yml` and `test.yml` do not.

Note that tests therefore run on Bun, while the published package targets Node.
For most library code the two are interchangeable, but anything that leans on
Node-specific runtime behaviour is not covered by this suite.

## Install

```bash
bun install
bunx lefthook install
```

## Setup

Rename first — everything else assumes the package is no longer called
`example-typescript-package`:

- `package.json`: `name`, `description`, `version`, `author`, `keywords`,
  `repository`, `bugs`, `homepage`
- `.changeset/config.json`: the `repo` field
- `README.md`: the badge URLs above
- `LICENSE`: the copyright holder

In GitHub settings:

- `Actions > General > Workflow permissions`
  * `Read and write permissions`
  * `Allow GitHub Actions to create and approve pull requests`

On npmjs.com, for the package you are publishing:

- `Settings > Trusted publisher`
  * Publisher: `GitHub Actions`
  * Repository: your `owner/repo`
  * Workflow filename: `release.yml`

Trusted publishing replaces `NPM_TOKEN`. A package must already exist on npm
before a trusted publisher can be attached, so the very first release needs a
manual `npm publish` (or a temporary token).

## Node version

`engines.node` is the single source of truth. Everything else derives from it:

| Consumer            | How it gets the version                                    |
| ------------------- | ---------------------------------------------------------- |
| tsdown build target | computed in `tsdown.config.ts` (currently `node26`)         |
| CI                  | `node-version-file: package.json` in the workflows          |
| `@types/node`       | **not** derivable — checked by `scripts/verify-engines.ts`  |

`scripts/verify-engines.ts` guards a second pair on the same principle:
`@types/bun` must track the Bun release pinned in `packageManager`, or the
`bun:test` and Bun API typings describe a different runtime than the one you
run.

To move Node versions, edit `engines.node` and run `bun run lint:packages`. The
check will tell you if `@types/node` needs to follow, and in which direction:
typings ahead of the floor let TypeScript accept APIs missing at runtime,
typings behind it hide APIs the runtime actually has. That check runs on
pre-commit and in every CI workflow.

The build targets the runtime rather than an ES year, because an ES year still
downlevels syntax that postdates it — a `using` declaration costs ~1.8 kB of
helpers under `es2025` versus 170 bytes emitted natively under `node26`. A
pinned `nodeNN` is also reproducible where `esnext` drifts with tool versions.
`tsconfig.json` uses `ESNext` for `target`/`lib` so type checking allows
everything the runtime supports.

> **Node 26 is the _Current_ line and does not become LTS until October 2026.**
> Until then this template asks consumers to run a non-LTS Node, and installs on
> Node 24 will warn (`EBADENGINE`) or fail outright under `engineStrict` or
> pnpm. Lower `engines.node` if your package needs broader reach.

## Development workflow

Adding a CHANGELOG entry and versioning the package:

- Create a branch and make changes.
- Create a new changeset entry: `bun run changeset`
- Commit your changes and open a pull request.
- Merge the pull request.
- A new PR will be created with the changeset entry/entries.
- When *that* PR is merged, the version is bumped, the changelog updated, and
  the package published.

Lefthook runs lint, formatting, package checks and type checking on pre-commit,
lint on pre-push, and commitlint on the commit message.

## Scripts

Everyday:

| Script                 | Description                                                 |
| ---------------------- | ------------------------------------------------------------ |
| `bun run build`        | Bundle to `dist/`, then validate with publint and attw        |
| `bun run test`         | Run the test suite once                                       |
| `bun run test:watch`   | Run the test suite in watch mode                              |
| `bun run verify-types` | Type check without emitting                                   |
| `bun run lint`         | Lint and format `src/`                                        |
| `bun run lint:staged`  | Same, limited to staged files (used by the pre-commit hook)   |
| `bun run debug`        | Run `src/index.ts` with the inspector attached                |
| `bun run debug:break`  | Same, breaking on the first line                              |
| `bun run clean`        | Remove `.turbo`, `node_modules` and `dist`                    |

Dependencies and package hygiene:

| Script                    | Description                                                       |
| ------------------------- | ------------------------------------------------------------------ |
| `bun run lint:packages`   | Check dependency ranges (syncpack) and the `engines.node` coupling  |
| `bun run syncpack:lint`   | Dependency range check only                                         |
| `bun run syncpack:format` | Sort `package.json` fields into a consistent order                  |
| `bun run syncpack:update` | Update all dependencies to their latest versions and reinstall      |

Releasing — normally driven by CI, not run by hand:

| Script                     | Description                                              |
| -------------------------- | --------------------------------------------------------- |
| `bun run changeset`        | Record a changeset describing your change                  |
| `bun run version-packages` | Apply pending changesets: bump versions, write CHANGELOG   |
| `bun run release`          | Publish unpublished versions to npm                        |
| `bun run commitlint`       | Lint a commit message (used by the commit-msg hook)        |
