# Contributing

## Getting started

```bash
bun install
bunx lefthook install
```

Node.js is not required — `bunfig.toml` makes every script run on Bun's
runtime. See the README for the one exception (publishing).

## Guidelines

- Commit messages should follow the [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) specification.
  * The commit message should be in the format `<type>(<scope>): <description>`. The `scope` is optional. The description must be lowercased.
- This project uses [changeset](https://github.com/changesets/changesets) for managing releases. Use the `bun run changeset` command to add a changeset for your changes.
  * Fixes should be added to the `patch` category.
  * New features should be added to the `minor` category.
  * Breaking changes should be added to the `major` category.
- Make sure to add tests for any code written. They use Bun's built-in [test runner](https://bun.sh/docs/cli/test) (`import { describe, expect, it } from "bun:test"`), which is Jest-compatible. The tests should pass before submitting a PR.
- Make sure to run the linter before submitting a PR. The linter is run using the `bun run lint` command. It uses
  [biome.js](https://biomejs.dev/) for linting.
- If you touch dependencies or `engines.bun`, run `bun run lint:packages`.
- The PR must pass the CI checks before it can be merged. This means it should pass linting and tests.

The lefthook hooks installed above already run linting, formatting, package
checks and type checking on commit, so most of this happens automatically.
