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

## Implementation findings

Three things the design got wrong, corrected in the implementation.

### Parameters must be passed as one array, never spread

`stmt.all(...parameters)` reads correctly but is wrong. Bun treats a lone object
argument as its named-parameter form, so a single object-valued parameter is
taken for a bindings map, the positional `?` is left unbound, and it silently
binds null. A `Date` parameter — which should raise `Binding expected string,
TypedArray, boolean, number, bigint or null` — instead resolved to
`{ value: null }`. Bun's own types do not permit the array form
(`SQLQueryBindings` has no array member), so the bindings are cast, with the
reason recorded at the cast.

### Streams need a private statement

Statements for `executeQuery` come from `db.query()` as designed, but a cursor
cannot be backed by a cached statement. Bun's cache hands out one statement per
SQL string, and a statement holds a single cursor, so:

- re-executing the same SQL mid-iteration resets the cursor, restarting the
  stream from row one — an unbounded stream, measured as a hang; and
- abandoning a stream part-way leaves its cursor mid-iteration, so the next
  stream of the same SQL resumes from where the last one stopped.

The second is reachable in ordinary sequential code and is what the regression
test pins. `streamQuery` therefore uses `db.prepare()` and `finalize()`s in a
`finally`, as Kysely's built-in dialect does.

Kysely holds the single connection for the life of a stream (its `RuntimeDriver`
takes a connection mutex whenever `supportsMultipleConnections` is false), so
querying inside a `for await` over a stream deadlocks. That is Kysely's
behavior for every single-connection dialect, not this dialect's to fix; it is
documented in the README instead.

### `AbortableOperationOptions` does not exist before Kysely 0.29

The design claimed every import was long-standing public API. It was not:
`AbortableOperationOptions` is new in 0.29, so importing it would have made the
approved `>=0.28.0` peer range a false claim. The dialect declares the shape it
forwards locally instead (`BunSqliteOperationOptions`, `{ signal?: AbortSignal }`),
which satisfies the `Driver` interface structurally on both lines.

The floor is now verified rather than asserted: the full suite and `tsc` were run
against kysely `0.28.7` as well as `0.29.5`, and pass on both. The only
difference is test-side — 0.28 exports `Migrator` from the root, 0.29 from
`kysely/migration` — so the committed tests track the pinned devDependency.

### Packaging

`tsdown`'s `nodeProtocol: true` prefixes builtin specifiers with `node:` and
treats `bun:sqlite` as a builtin, emitting `import { Database } from
"node:bun:sqlite"` into `dist/index.d.ts` — a specifier that resolves nowhere,
and one that neither `attw` nor `publint` flags.

`syncpack` rejects a peer range that differs from the pinned devDependency
version, so an ignore for peer entries records that the floor is deliberate.

## Coverage review against Kysely's own dialect suite

Kysely's shared suite (`test/node/src/*.test.ts` at v0.29.5) runs the same tests
against postgres, mysql, mssql, pglite and sqlite. Most of it exercises the
query builder, which is Kysely's to test, not a dialect's. The tests that do
constrain a driver were ported here, giving 90 tests total. What the comparison
turned up:

- **Concurrency was untested.** Kysely runs 100 parallel transactions, half
  failing, against every dialect including sqlite. Ported at 40 threads, plus
  parallel plain queries and a check that a rolled-back transaction is never
  visible to a query racing it. All pass: the `ConnectionMutex` that Kysely
  installs for `supportsMultipleConnections: false` serializes correctly over a
  single shared connection.
- **The abort-signal contract was untested.** Kysely 0.29's `cancellation.test.ts`
  applies to sqlite except for the database-side `cancel query` / `kill session`
  strategies. Ported: an unaborted signal, an already-aborted signal (asserting
  `__kysely_timing__ === 'before query execution'`), aborted streams, and
  `db.connection()`, where a single-connection dialect must report
  `'before acquireConnection:mutex'`. All pass, which confirms the design's
  decision to forward the signal without consulting it: Kysely's executor owns
  the contract, and a synchronous driver has no in-flight query to interrupt.
- **Injection containment was untested.** Ported from `sql-injection.test.ts`,
  which asserts the table still exists afterwards. Also added the case that
  suite has no reason to cover: a multi-statement string reaching the driver.
  `bun:sqlite` prepares one statement, so a smuggled `; drop table` never runs.
- **Isolation levels and access modes are excluded for sqlite** in Kysely's
  suite too, so ignoring `TransactionSettings` is correct rather than a gap.
- **Driver-contract cases now covered**: a transaction that fails to begin is
  never rolled back (verified by subclassing `BunSqliteDriver`, which is why it
  is exported); queries after commit/rollback are refused; a failed statement
  inside a transaction does not poison it; the userland stack survives on a
  driver error; savepoint release and rollback-after-release; `explain`;
  `executeTakeFirstOrThrow` with no rows; `insert or ignore` reporting zero
  affected rows; blob and null round-trips; a result-transforming plugin;
  `await using`; and introspection depth — no schemas, full column metadata,
  default values, and views.

### Finding: bun ships SQLite with `DQS=3`

`pragma compile_options` reports `DQS=3`, so the double-quoted-string
misfeature is fully enabled and an unresolvable double-quoted identifier is
accepted as a string literal — `select "nope" from person` yields `"nope"` as a
value instead of raising `no such column`. better-sqlite3 compiles with
`SQLITE_DQS=0` and raises. Since Kysely quotes every identifier, any bad column
reference that escapes its type checking fails silently rather than loudly on
this driver. There is nothing to fix — SQLite's DQS setting is compile-time and
Bun does not expose `sqlite3_db_config` — so it is pinned by a test and
documented in the README.

## Correction: the peer floor is 0.29.0, not 0.28.0

The floor was raised after the coverage work found that 0.28 is genuinely
broken for this dialect, not merely untestable.

Running the expanded suite against kysely `0.28.0` failed the parallel-transaction
isolation test: a rolled-back transaction's row survived, committed by another
thread. The cause is structural. In 0.28 the `ConnectionMutex` that serializes a
single-connection database lives **inside `SqliteDriver`**, so every
single-connection dialect had to carry its own lock. 0.29 moved it up into
`RuntimeDriver`, which installs it whenever the adapter reports
`supportsMultipleConnections === false`. This dialect, written against 0.29, has
no lock of its own — correct there, unsafe on 0.28, where parallel transactions
interleave on the one connection and corrupt data.

Supporting 0.28 would mean carrying a driver-side mutex permanently for one
version behind, while still being unable to run the abort-signal tests (0.29
added `signal` options) or resolve `kysely/migration` (0.29 added the subpath).
The floor moved to `>=0.29.0` instead, verified at 0.29.0 exactly: 90 tests and
`tsc` pass.

This also removes the reason the design declared `BunSqliteOperationOptions`
locally. That existed only to keep the 0.28 line compiling, so the config now
imports Kysely's `AbortableOperationOptions` directly and the local type is gone.

`scripts/peer-floor.ts` prints the floor out of `peerDependencies`, and a
`peer-floor` CI job installs it and runs the suite and type checks against it.
An unexercised floor is a promise that rots; this makes it a check.

## Correction: how the packaging and syncpack fixes were finally expressed

Both landed one altitude lower than first written, in a later cleanup pass.

`nodeProtocol` is **not** disabled. Turning it off repo-wide would stop
normalizing real node builtins too, and it was the only guard against a bad
builtin specifier since neither `publint` nor `attw` flags one. The config keeps
`nodeProtocol: true` and exempts the one specifier with
`deps: { neverBundle: ["bun:sqlite"] }`. Both halves were verified: `bun:sqlite`
stays unprefixed in `dist/index.d.ts`, and a bare `fs` import still emits
`node:fs` in both output formats.

The `syncpack` ignore is stated for all peer dependencies rather than naming
`kysely`, matching the `semverGroups` rule beside it, so a second peer
dependency does not trip the same false positive.

## Invariant: one fresh database per test

Several assertions depend on it rather than merely benefiting from it — a
returned autoincrement id of exactly `1`, and two different tests each creating
a table named `toy`. The per-test `beforeEach` that constructs a new
`:memory:` database is therefore load-bearing, not scaffolding. It may be
hoisted to file scope (it has been) but not widened to `beforeAll`.
