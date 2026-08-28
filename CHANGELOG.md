# kysely-bun-sqlite-dialect

## 1.0.0

### Major Changes

- [`79644ca`](https://github.com/disaresta-org/kysely-bun-sqlite-dialect/commit/79644ca9d20358b82e2c0efe505877b4fd5ec55e) Thanks [@theogravity](https://github.com/theogravity)! - Declare the API stable at 1.0.0.
  
  No functional change from 0.1.0. `BunSqliteDialect`, `BunSqliteDriver`, the
  config surface (`database`, `onCreateConnection`, `transactionBehavior`) and the
  exported types are exactly what 0.1.0 shipped — they are now covered by semver
  guarantees rather than 0.x's licence to break things.

## 0.1.0

### Minor Changes

- [`17b69e8`](https://github.com/disaresta-org/kysely-bun-sqlite-dialect/commit/17b69e812445e858c7679154bbc48783352bf5e5) Thanks [@theogravity](https://github.com/theogravity)! - Add `BunSqliteDialect`, a Kysely dialect for Bun's native `bun:sqlite` driver.
  
  Kysely's built-in `SqliteDialect` targets `better-sqlite3` and silently returns
  no rows on `bun:sqlite`, because it branches on `Statement.reader`, which Bun
  does not have. This dialect uses `Statement.columnNames` instead and drives the
  rest of the `bun:sqlite` API natively: prepared-statement caching via
  `db.query()`, private cursors for `.stream()`, savepoints, and `deferred` /
  `immediate` / `exclusive` transaction behavior.
  
  Documents that Bun ships SQLite with `DQS=3`, so an unresolvable double-quoted
  identifier is accepted as a string literal rather than raising `no such column`
  as it does under better-sqlite3.
  
  Requires Kysely `>=0.29.0`. Kysely 0.28 is not supported: its connection mutex
  lived inside `SqliteDriver` rather than `RuntimeDriver`, so a dialect written
  against 0.29 has no lock of its own and parallel transactions interleave on
  0.28's single connection.
  
  Declares `engines.bun` only, with no `engines.node`: the published JavaScript
  never imports `bun:sqlite` itself, so a Node floor would only make npm and pnpm
  warn or fail for consumers over a build-time concern.
