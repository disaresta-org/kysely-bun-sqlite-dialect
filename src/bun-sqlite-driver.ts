import type { Database, SQLQueryBindings, Statement } from "bun:sqlite";
import {
  CompiledQuery,
  createQueryId,
  type DatabaseConnection,
  type Driver,
  IdentifierNode,
  type QueryCompiler,
  type QueryResult,
  RawNode,
  SelectQueryNode,
} from "kysely";
import {
  assertValidConfig,
  type BunSqliteDialectConfig,
  type BunSqliteOperationOptions,
  type BunSqliteTransactionBehavior,
} from "./bun-sqlite-dialect-config.js";

const BEGIN_SQL: Record<BunSqliteTransactionBehavior, string> = {
  deferred: "begin",
  immediate: "begin immediate",
  exclusive: "begin exclusive",
};

/**
 * Kysely driver for Bun's native `bun:sqlite` module.
 */
export class BunSqliteDriver implements Driver {
  readonly #config: BunSqliteDialectConfig;
  #database?: Database;
  #connection?: DatabaseConnection;

  constructor(config: BunSqliteDialectConfig) {
    assertValidConfig(config);
    this.#config = Object.freeze({ ...config });
  }

  async init(options?: BunSqliteOperationOptions): Promise<void> {
    const { database, onCreateConnection } = this.#config;

    this.#database = typeof database === "function" ? await database(options) : database;
    this.#connection = new BunSqliteConnection(this.#database);

    await onCreateConnection?.(this.#connection, options);
  }

  async acquireConnection(): Promise<DatabaseConnection> {
    if (!this.#connection) {
      throw new Error("BunSqliteDriver.init() has not been called");
    }

    return this.#connection;
  }

  async beginTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw(BEGIN_SQL[this.#config.transactionBehavior ?? "deferred"]));
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("commit"));
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("rollback"));
  }

  async savepoint(
    connection: DatabaseConnection,
    savepointName: string,
    compileQuery: QueryCompiler["compileQuery"],
  ): Promise<void> {
    await this.#executeSavepointCommand(connection, "savepoint", savepointName, compileQuery);
  }

  async rollbackToSavepoint(
    connection: DatabaseConnection,
    savepointName: string,
    compileQuery: QueryCompiler["compileQuery"],
  ): Promise<void> {
    await this.#executeSavepointCommand(connection, "rollback to", savepointName, compileQuery);
  }

  async releaseSavepoint(
    connection: DatabaseConnection,
    savepointName: string,
    compileQuery: QueryCompiler["compileQuery"],
  ): Promise<void> {
    await this.#executeSavepointCommand(connection, "release", savepointName, compileQuery);
  }

  async #executeSavepointCommand(
    connection: DatabaseConnection,
    command: string,
    savepointName: string,
    compileQuery: QueryCompiler["compileQuery"],
  ): Promise<void> {
    // Compiling an `IdentifierNode` rather than interpolating the name means
    // the query compiler sanitizes it, exactly as Kysely's own drivers do.
    const node = RawNode.createWithChildren([
      RawNode.createWithSql(`${command} `),
      IdentifierNode.create(savepointName),
    ]);

    await connection.executeQuery(compileQuery(node, createQueryId()));
  }

  async releaseConnection(): Promise<void> {
    // A single connection is shared for the driver's lifetime, so there is
    // nothing to release.
  }

  async destroy(): Promise<void> {
    this.#database?.close();
  }
}

class BunSqliteConnection implements DatabaseConnection {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    const statement = this.#prepare(compiledQuery.sql);
    const bindings = toBindings(compiledQuery.parameters);

    // `bun:sqlite` has no equivalent of better-sqlite3's `Statement.reader`,
    // but `columnNames` answers the same question before execution: it is
    // non-empty for anything that produces rows (a select, a `pragma`, or a
    // write with a `returning` clause) and empty for a bare write or DDL.
    if (statement.columnNames.length > 0) {
      return { rows: statement.all(bindings) as R[] };
    }

    const { changes, lastInsertRowid } = statement.run(bindings);

    return {
      insertId: lastInsertRowid != null ? BigInt(lastInsertRowid) : undefined,
      numAffectedRows: changes != null ? BigInt(changes) : undefined,
      rows: [],
    };
  }

  async *streamQuery<R>(compiledQuery: CompiledQuery, _chunkSize?: number): AsyncIterableIterator<QueryResult<R>> {
    if (!SelectQueryNode.is(compiledQuery.query)) {
      throw new Error("bun:sqlite only supports streaming of select queries");
    }

    // A cursor cannot be backed by a cached statement. Bun's cache hands out
    // one statement per SQL string, and a statement holds a single cursor: any
    // re-execution of the same SQL resets it, restarting the stream from row
    // one forever, and two streams of the same SQL would consume each other's
    // rows. So a stream gets a private statement and finalizes it on the way
    // out, since nothing else will.
    const statement: Statement<unknown, any[]> = this.#database.prepare(compiledQuery.sql);

    try {
      // `bun:sqlite` iterates row by row, so `chunkSize` has nothing to batch.
      for (const row of statement.iterate(toBindings(compiledQuery.parameters))) {
        yield { rows: [row as R] };
      }
    } finally {
      statement.finalize();
    }
  }

  #prepare(sql: string): Statement<unknown, any[]> {
    // `query` caches the compiled statement in Bun's own LRU, which also owns
    // finalizing it. `prepare` would leak unless finalized by hand.
    return this.#database.query(sql);
  }
}

/**
 * Parameters go to `bun:sqlite` as one array argument, never spread.
 *
 * Spreading looks equivalent but is not: a lone object argument is Bun's
 * named-parameter form, so a single object-valued parameter (a `Date`, say)
 * would be read as a bindings map, leaving the positional `?` unbound and
 * silently binding null instead of raising.
 */
function toBindings(parameters: ReadonlyArray<unknown>): SQLQueryBindings[] {
  return parameters as SQLQueryBindings[];
}
