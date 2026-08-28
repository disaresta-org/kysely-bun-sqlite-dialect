---
"kysely-bun-sqlite-dialect": major
---

Declare the API stable at 1.0.0.

No functional change from 0.1.0. `BunSqliteDialect`, `BunSqliteDriver`, the
config surface (`database`, `onCreateConnection`, `transactionBehavior`) and the
exported types are exactly what 0.1.0 shipped — they are now covered by semver
guarantees rather than 0.x's licence to break things.
