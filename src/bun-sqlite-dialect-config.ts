import type { Database } from "bun:sqlite";
import type { AbortableOperationOptions, DatabaseConnection } from "kysely";

/**
 * How the driver opens a transaction.
 *
 * `deferred` emits a bare `begin` and is the default, matching Kysely's
 * built-in SQLite dialect. `immediate` and `exclusive` take a write lock up
 * front, which matters in WAL mode: a deferred transaction that reads before
 * it writes can fail with `SQLITE_BUSY` when it tries to upgrade its lock.
 *
 * https://www.sqlite.org/lang_transaction.html
 */
export type BunSqliteTransactionBehavior = "deferred" | "immediate" | "exclusive";

/**
 * Configuration for {@link BunSqliteDialect}.
 */
export interface BunSqliteDialectConfig {
  /**
   * A `bun:sqlite` {@link Database} instance, or a function returning one.
   *
   * A function is called once, when the first query is executed, and lets the
   * database be opened lazily:
   *
   * ```ts
   * new BunSqliteDialect({
   *   database: async () => {
   *     const database = new Database("app.db");
   *     database.run("pragma journal_mode = WAL");
   *     return database;
   *   },
   * });
   * ```
   */
  database: Database | ((options?: AbortableOperationOptions) => Promise<Database>);

  /**
   * Called once, after the connection is created and before the first query
   * runs.
   *
   * This is a Kysely feature rather than a `bun:sqlite` one.
   */
  onCreateConnection?: (connection: DatabaseConnection, options?: AbortableOperationOptions) => Promise<void>;

  /**
   * How transactions are opened. Defaults to `"deferred"`.
   */
  transactionBehavior?: BunSqliteTransactionBehavior;
}

const TRANSACTION_BEHAVIORS: ReadonlyArray<BunSqliteTransactionBehavior> = ["deferred", "immediate", "exclusive"];

/**
 * Fails at construction time rather than at the first query, so a mistake
 * surfaces where it was made.
 *
 * The `database` check earns its place: this package exists because handing
 * Kysely the wrong SQLite object fails silently, and the likeliest wrong value
 * here is a `better-sqlite3` database passed mid-migration. Without the check
 * that reaches the first query as a bare property-access error naming nothing.
 */
export function assertValidConfig(config: BunSqliteDialectConfig): void {
  const { database, transactionBehavior } = config;

  if (typeof database !== "function" && typeof database?.query !== "function") {
    throw new Error("config.database must be a bun:sqlite Database, or a function returning one");
  }

  if (transactionBehavior !== undefined && !TRANSACTION_BEHAVIORS.includes(transactionBehavior)) {
    throw new Error(
      `invalid transactionBehavior ${JSON.stringify(transactionBehavior)}, expected one of ${TRANSACTION_BEHAVIORS.join(", ")}`,
    );
  }
}
