---
"kysely-bun-sqlite-adapter": minor
---

Add `BunSqliteDialect`, a Kysely dialect for Bun's native `bun:sqlite` driver.

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
