# kysely-bun-sqlite-adapter

[![NPM version](https://img.shields.io/npm/v/kysely-bun-sqlite-adapter.svg?style=flat-square)](https://www.npmjs.com/package/kysely-bun-sqlite-adapter)
![NPM Downloads](https://img.shields.io/npm/dm/kysely-bun-sqlite-adapter)
[![TypeScript](https://img.shields.io/badge/%3C%2F%3E-TypeScript-%230074c1.svg)](http://www.typescriptlang.org/)

A [Kysely](https://kysely.dev) dialect for Bun's native
[`bun:sqlite`](https://bun.com/docs/runtime/sqlite) driver.

## Why this exists

Kysely's built-in `SqliteDialect` targets `better-sqlite3`. Handed a
`bun:sqlite` `Database` it does not throw — it silently returns no rows. Its
connection decides how to run a statement by reading `better-sqlite3`'s
`Statement.reader`:

```ts
if (stmt.reader) {
  return { rows: stmt.all(parameters) }   // never taken on bun:sqlite
}
```

Bun's `Statement` has no `reader` property, so the check is always `undefined`,
every statement takes the write path, and **every `select` resolves to an empty
array**.

This dialect asks Bun the same question a different way — `stmt.columnNames` is
non-empty exactly when a statement produces rows — and drives the rest of the
`bun:sqlite` API natively.

## Install

```bash
bun add kysely-bun-sqlite-adapter kysely
```

## Usage

```ts
import { Database } from "bun:sqlite";
import { Kysely, type Generated } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite-adapter";

interface DB {
  person: {
    id: Generated<number>;
    name: string;
    age: number;
  };
}

const db = new Kysely<DB>({
  dialect: new BunSqliteDialect({
    database: new Database("app.db"),
  }),
});

const people = await db.selectFrom("person").selectAll().execute();
```

You construct the `Database`, so every `bun:sqlite` option is yours to set —
`strict`, `safeIntegers`, `readonly`, `loadExtension`, and any pragmas.

### Opening the database lazily

Pass a function to defer opening until the first query. This is also the place
to apply pragmas:

```ts
new BunSqliteDialect({
  database: async () => {
    const database = new Database("app.db");
    database.run("pragma journal_mode = WAL");
    database.run("pragma foreign_keys = ON");
    return database;
  },
});
```

The function is called once, on the first query.

### Configuration

| Option                | Type                                                | Default      | Description                                            |
| --------------------- | --------------------------------------------------- | ------------ | ------------------------------------------------------ |
| `database`            | `Database \| (options?) => Promise<Database>`        | —            | A `bun:sqlite` database, or a function returning one    |
| `transactionBehavior` | `"deferred" \| "immediate" \| "exclusive"`           | `"deferred"` | How `begin` opens a transaction                         |
| `onCreateConnection`  | `(connection, options?) => Promise<void>`            | —            | Called once, after the connection is created            |

### Transactions

`db.transaction()`, `db.startTransaction()` and savepoints all work as usual.
By default a transaction opens with a bare `begin`, matching Kysely's built-in
SQLite dialect.

In WAL mode with concurrent writers, prefer `immediate`: a deferred transaction
that reads before it writes can fail with `SQLITE_BUSY` when it tries to upgrade
its read lock to a write lock, and `begin immediate` takes the write lock up
front instead.

```ts
new BunSqliteDialect({ database, transactionBehavior: "immediate" });
```

### Streaming

`.stream()` is supported for `select` queries and yields one row at a time:

```ts
for await (const person of db.selectFrom("person").selectAll().stream()) {
  console.log(person.name);
}
```

SQLite has a single connection, and Kysely holds it for the life of a stream.
**Do not run another query inside a `for await` over a stream** — it will wait
for a connection that the stream is still holding. Collect what you need first,
then query. This is Kysely's behavior for every single-connection dialect, not
something specific to this one.

## Things worth knowing

- **`destroy()` closes your `Database`.** `await db.destroy()` calls
  `database.close()`, the same as Kysely's built-in dialect. That close is lazy
  where streams are concerned: `bun:sqlite` releases the connection only after
  the last prepared statement is finalized, so a stream abandoned without being
  run to completion or closed can defer the real close until GC. Consuming a
  stream fully, or `break`ing out of it, finalizes immediately.
- **`Date` parameters are rejected.** `bun:sqlite` binds only strings,
  `TypedArray`s, booleans, numbers, bigints and null, so a `Date` raises
  `Binding expected string, TypedArray, boolean, number, bigint or null`. Store
  timestamps as ISO strings or epoch numbers. (`better-sqlite3` rejects them
  too.)
- **`insert … returning` gives you rows, not an `insertId`.** As with
  `better-sqlite3`, a statement with a `returning` clause takes the row-reading
  path; read the values out of the returned rows.
- **Statements are cached by Bun.** Queries go through `db.query()`, so Bun's
  compiled-statement LRU owns compilation and finalization. Streams are the one
  exception: they get a private statement, because a cached statement holds a
  single cursor and would be reset by any re-execution of the same SQL.
- **A mistyped column name yields its own name, not an error.** Bun ships SQLite
  compiled with `DQS=3`, the double-quoted-string misfeature fully enabled, so
  an unresolvable double-quoted identifier is accepted as a string literal:
  `select "nope" from person` returns `"nope"` as a value. better-sqlite3
  compiles with `SQLITE_DQS=0` and raises `no such column` instead, so this is a
  real difference to watch for when migrating. Kysely quotes all identifiers, so
  any typo Kysely cannot catch at the type level reaches SQLite this way. It is
  not an injection risk — the whole token is one literal — but it does mean a
  bad column reference fails silently.
- **`safeIntegers` works.** Set it on the `Database` and integer columns come
  back as `bigint`.
- **Errors are not wrapped.** Bun's error reaches you as-is, with its `code`
  (`SQLITE_CONSTRAINT_UNIQUE` and friends) and `errno` intact.

## Kysely compatibility

Requires Kysely `>=0.29.0`. CI runs the full suite and type checks against both
the declared floor and the pinned development version, so the floor cannot drift
from what is actually supported.

Kysely 0.28 is **not** supported, and the reason is worth stating: in 0.28 the
connection mutex that serializes access to a single-connection database lived
inside `SqliteDriver` itself, and 0.29 moved it up into Kysely's `RuntimeDriver`,
driven by the adapter's `supportsMultipleConnections`. A dialect written against
0.29 therefore has no lock of its own, and on 0.28 parallel transactions
interleave on the one connection — a rolled-back transaction's writes can be
committed by another. Measured, not theorized.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Development notes below.

### Toolchain

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

```bash
bun install
bunx lefthook install
bun test
```

`bunfig.toml` sets `[run] bun = true`, so every script and `node_modules/.bin`
entry executes under Bun's runtime rather than deferring to its
`#!/usr/bin/env node` shebang.

`engines.node` is load-bearing even though this package is for Bun: the tsdown
build target is computed from it, the release workflows read it to set up the
npm CLI for OIDC publishing, and `scripts/verify-engines.ts` keeps it in step
with `@types/node`. It says nothing about needing Node at runtime — the built
JavaScript never imports `bun:sqlite` itself, it only accepts a `Database` you
hand it.

It is set to the current Node LTS (`>=24`) rather than the newest release, so
installing under npm or pnpm does not warn `EBADENGINE` over a constraint that
is really about this repo's build. Raising it narrows who can install the
package without changing what the package needs.

Note that `tsdown.config.ts` keeps `nodeProtocol: true` but exempts `bun:sqlite`
via `deps.neverBundle`. The option prefixes builtin specifiers with `node:` and
counts `bun:sqlite` as one, which emits an unresolvable `"node:bun:sqlite"` into
the declaration file — and neither `publint` nor `attw` flags it. Exempting the
one specifier keeps the prefixing working for real node builtins; disabling the
option outright would silently stop normalizing those too.

### Development workflow

- Create a branch and make changes.
- Create a changeset entry: `bun run changeset`
- Commit and open a pull request.
- When the release PR that changesets opens is merged, the version is bumped,
  the changelog updated, and the package published.

Lefthook runs lint, formatting, package checks and type checking on pre-commit,
lint on pre-push, and commitlint on the commit message.

### Scripts

| Script                    | Description                                                        |
| ------------------------- | ------------------------------------------------------------------- |
| `bun run build`           | Bundle to `dist/`, then validate with publint and attw               |
| `bun run test`            | Run the test suite once                                              |
| `bun run test:watch`      | Run the test suite in watch mode                                     |
| `bun run verify-types`    | Type check without emitting                                          |
| `bun run lint`            | Lint and format `src/`                                               |
| `bun run lint:packages`   | Check dependency ranges (syncpack) and the `engines.node` coupling    |
| `bun run syncpack:update` | Update all dependencies to their latest versions and reinstall        |
| `bun run clean`           | Remove `.turbo`, `node_modules` and `dist`                           |
