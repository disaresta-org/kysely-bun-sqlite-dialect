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
