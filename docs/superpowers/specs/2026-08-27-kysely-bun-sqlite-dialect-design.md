# kysely-bun-sqlite-adapter — design

Date: 2026-08-27
Status: proposed — awaiting review

## Problem

Kysely's built-in `SqliteDialect` targets `better-sqlite3`. Handed a `bun:sqlite`
`Database`, it does not error — it silently returns no rows. Its connection
branches on `better-sqlite3`'s `Statement.reader`:

```js
const stmt = this.#db.prepare(sql)
if (stmt.reader) {
  return { rows: stmt.all(parameters) }
}
const { changes, lastInsertRowid } = stmt.run(parameters)
return { insertId: ..., numAffectedRows: ..., rows: [] }
```

Bun's `Statement` has no `reader` property, so the check is `undefined`, every
statement takes the `run()` branch, and **every `select` resolves to
`rows: []`**. Verified against Bun 1.4.0 and kysely 0.29.5.

This package ships a dialect that drives `bun:sqlite` correctly and natively.

## What `bun:sqlite` provides

Verified empirically on Bun 1.4.0, not read off documentation:

| Kysely needs | `bun:sqlite` |
| --- | --- |
| `stmt.reader` | absent — but `stmt.columnNames` is `[]` for non-returning statements and populated for `select` / `… returning` / `pragma`, available before execution |
| `all(parameters)` | accepts a single array argument, same convention Kysely calls with |
| `run(parameters)` | returns `{ changes, lastInsertRowid }` — exact shape Kysely reads |
| `iterate(parameters)` | works and binds parameters (the docs understate this — they show `iterate()` with no arguments) |
| `begin` / `commit` / `rollback` / `savepoint` as raw SQL | work |
| `insert … returning` | works; `columnNames` is `["id"]` |

Other Bun specifics that shape the design:

- `db.query(sql)` caches compiled bytecode in an LRU (20 entries by default) and
  `db.close()` finalizes it. `db.prepare(sql)` does not cache, and its
  statements must be `finalize()`d or they leak.
- Errors are plain `Error` with `code: "SQLITE_ERROR"`, `errno`, `byteOffset`.
- `safeIntegers` (per-`Database` or per-`Statement`) switches integer results to
  `bigint`.
- `Date` parameters **throw**: `Binding expected string, TypedArray, boolean,
  number, bigint or null`. `undefined` binds as `null`; `boolean` binds as 1/0.
- Every `bun:sqlite` call is synchronous. There is no in-flight query to
  interrupt, so an `AbortSignal` cannot cancel one.

## Non-goals

- No compatibility shim for Kysely's built-in `SqliteDialect`.
- No wrapping of `bun:sqlite`'s `Database` constructor. Callers construct the
  `Database` themselves, so every Bun option (`strict`, `safeIntegers`,
  `readonly`, WAL pragmas, `loadExtension`) is theirs to set and this package
  adds no surface that must track Bun releases.
- No statement cache of our own. Bun already has one.
- No error wrapping. Bun's error carries `code`/`errno`; re-wrapping would lose
  it, and Kysely expects driver errors to surface as-is.
- No `Date` parameter coercion. Kysely's `better-sqlite3` dialect does not
  coerce either; the limitation is documented in the README instead.

## Architecture

Four modules, one responsibility each:

```
src/bun-sqlite-dialect-config.ts   BunSqliteDialectConfig
src/bun-sqlite-driver.ts           BunSqliteDriver, BunSqliteConnection
src/bun-sqlite-dialect.ts          BunSqliteDialect
src/index.ts                       public re-exports
```

The template's `src/Num.ts` and `src/__tests__/index.test.ts` are deleted.

Public exports: `BunSqliteDialect`, `BunSqliteDriver`, and the
`BunSqliteDialectConfig` / `BunSqliteTransactionBehavior` types.
`BunSqliteConnection` stays internal.

Only Kysely's documented root exports are used — `Dialect`, `Driver`,
`DatabaseConnection`, `QueryResult`, `TransactionSettings`, `CompiledQuery`,
`SqliteAdapter`, `SqliteIntrospector`, `SqliteQueryCompiler`, `SelectQueryNode`,
`RawNode`, `IdentifierNode`, `createQueryId`, `AbortableOperationOptions`. No
deep imports into `kysely/dist/...`, which the package's `exports` map forbids
anyway.

### `BunSqliteDialectConfig`

```ts
import type { Database } from "bun:sqlite"

export type BunSqliteTransactionBehavior = "deferred" | "immediate" | "exclusive"

export interface BunSqliteDialectConfig {
  database: Database | ((options?: AbortableOperationOptions) => Promise<Database>)
  onCreateConnection?: (
    connection: DatabaseConnection,
    options?: AbortableOperationOptions,
  ) => Promise<void>
  transactionBehavior?: BunSqliteTransactionBehavior
}
```

`import type` from `bun:sqlite` is erased at build time, so the published JS has
no runtime import of `bun:sqlite` and needs no bundler external. Consumers need
`@types/bun`, which anyone calling `bun:sqlite` already has.

`transactionBehavior` defaults to `"deferred"`, which emits a bare `begin` and
matches Kysely's built-in dialect exactly. `"immediate"` and `"exclusive"` exist
because in WAL mode a deferred transaction that reads before it writes can fail
with `SQLITE_BUSY` when it tries to upgrade its lock; `begin immediate` takes the
write lock up front. Anything else throws from the `BunSqliteDialect` constructor, so a typo fails
at setup rather than at the first transaction.

### `BunSqliteDialect`

Implements `Dialect`. `createDriver()` returns a `BunSqliteDriver`; the other
three delegate to Kysely's `SqliteQueryCompiler`, `SqliteAdapter` and
`SqliteIntrospector`. SQLite is SQLite — the generated SQL, the
`supportsReturning` / `supportsTransactionalDdl` / `supportsMultipleConnections`
answers and the `pragma`-based introspection are all identical between
`better-sqlite3` and `bun:sqlite`. Only the driver differs. The config is frozen
in the constructor.

### `BunSqliteDriver`

One shared `BunSqliteConnection` for the whole driver, as the built-in dialect
does. `SqliteAdapter.supportsMultipleConnections` is `false`, and because every
`bun:sqlite` call is synchronous there is no interleaving hazard on the shared
connection; Kysely's `SingleConnectionProvider` serializes transactions on top of
that.

- `init(options)` — resolve `config.database` (calling it with `options` if it is
  a function), construct the connection, then `await config.onCreateConnection`.
- `acquireConnection()` — the shared connection. Throws if `init()` has not run.
- `beginTransaction(connection)` — `CompiledQuery.raw` of `begin`, `begin
  immediate` or `begin exclusive` per `transactionBehavior`. `TransactionSettings`
  is ignored: SQLite has no isolation levels or access modes, and Kysely's own
  dialect ignores it too.
- `commitTransaction` / `rollbackTransaction` — raw `commit` / `rollback`.
- `savepoint` / `rollbackToSavepoint` / `releaseSavepoint` — built the way
  Kysely's own driver builds them, so the name is sanitized as an identifier
  rather than interpolated into SQL:

  ```ts
  const node = RawNode.createWithChildren([
    RawNode.createWithSql(`${command} `),
    IdentifierNode.create(savepointName),
  ])
  await connection.executeQuery(compileQuery(node, createQueryId()))
  ```

  (`command` being `savepoint`, `rollback to` or `release`.)
- `releaseConnection()` — no-op.
- `destroy()` — `db.close()`. This closes the `Database` the caller passed in,
  matching the built-in dialect; the README says so explicitly.

### `BunSqliteConnection`

```ts
async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
  const { sql, parameters } = compiledQuery
  const stmt = this.#db.query(sql)

  if (stmt.columnNames.length > 0) {
    return { rows: stmt.all(parameters) as R[] }
  }

  const { changes, lastInsertRowid } = stmt.run(parameters)
  return {
    insertId: lastInsertRowid != null ? BigInt(lastInsertRowid) : undefined,
    numAffectedRows: changes != null ? BigInt(changes) : undefined,
    rows: [],
  }
}
```

`columnNames.length > 0` is the substitute for `better-sqlite3`'s `reader`, and
it reproduces that flag's semantics rather than approximating them: it is
non-empty for `select`, for `pragma`, and for `insert`/`update`/`delete … 
returning`, and empty for a bare write or for DDL. So `insert … returning` takes
the `all()` path and yields rows without an `insertId` — exactly what the
built-in dialect does, because `better-sqlite3` also reports `reader === true`
there. A bare `update`/`delete` takes `run()` and yields `numAffectedRows`.

Branching on the statement rather than on `SelectQueryNode.is(compiledQuery.query)`
is deliberate: the node check would misclassify `returning` clauses, `pragma`,
and raw SQL.

`streamQuery` mirrors upstream: it rejects anything that is not a
`SelectQueryNode`, then yields one `{ rows: [row] }` per row from
`stmt.iterate(parameters)`. `chunkSize` is ignored, as upstream ignores it.

Statements come from `db.query()`, never `db.prepare()`, so Bun's LRU owns
compilation and finalization and nothing here has to `finalize()`.

`AbortableOperationOptions` is accepted where Kysely's interfaces declare it and
forwarded to the `database` factory and `onCreateConnection`. It is not consulted
per query: a synchronous `bun:sqlite` call cannot be interrupted, and Kysely's
executor already asserts on the signal around the call. `cancelQuery`,
`killSession` and `collectSessionInfo` are left unimplemented for the same
reason.

## Testing

`bun test`, `src/__tests__/`, a fresh `new Database(":memory:")` per test. Every
test goes through a real `Kysely` instance so the assertions cover the wiring,
not just the connection in isolation.

- **`select` round-trip** — the regression that motivates the package. Rows come
  back non-empty.
- `insert` returns `insertId`.
- bare `update` and bare `delete` return `numAffectedRows`.
- `insert … returning` yields rows.
- `on conflict do update` round-trips (exercises `SqliteQueryCompiler` reuse).
- transaction commits; transaction rolls back on a thrown error.
- nested `savepoint` rolls back the inner block without losing the outer one.
- a savepoint name needing quoting is sanitized, not interpolated.
- `transactionBehavior: "immediate"` emits `begin immediate`; an invalid value
  throws from the constructor.
- `streamQuery` yields rows one at a time; a non-select throws.
- `database` as a factory is called once, lazily.
- `onCreateConnection` runs once, before the first query.
- `destroy()` closes the `Database`.
- `SqliteIntrospector.getTables()` works through this driver.
- a full `Migrator` run applies migrations (covers the migration-lock path).
- `safeIntegers: true` yields `bigint` results.
- a SQLite error surfaces with `code: "SQLITE_ERROR"` intact.

## Repo metadata

The repo is still an unmodified `example-typescript-package` template.

- `package.json`: `name` → `kysely-bun-sqlite-adapter`; real `description` and
  `keywords`; `repository` / `bugs` / `homepage` → `theogravity/kysely-bun-sqlite-adapter`.
- `kysely` as a `peerDependency` at `>=0.28.0` and as a `devDependency` pinned to
  the tested version. The exports used are long-standing public API, so a loose
  floor avoids peer-conflict noise.
- `engines`: keep `node` — it is load-bearing, since `tsdown.config.ts` derives
  the build target from it and both release workflows read it for npm's OIDC
  publishing — and add `"bun": ">=1.2.0"`. The built JS has no runtime
  `bun:sqlite` import; it needs a Bun `Database` handed to it.
- README rewritten for this package: install, usage, the `Date` parameter
  limitation, that `destroy()` closes the caller's `Database`, WAL setup via a
  factory, and why the built-in `SqliteDialect` cannot be used.
- A changeset for the initial feature release.

Build, lint, type-check and CI are inherited unchanged.
