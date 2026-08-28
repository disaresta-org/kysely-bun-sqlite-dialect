import {
  type DatabaseIntrospector,
  type Dialect,
  type DialectAdapter,
  type Driver,
  type Kysely,
  type QueryCompiler,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
} from "kysely";
import { assertValidConfig, type BunSqliteDialectConfig } from "./bun-sqlite-dialect-config.js";
import { BunSqliteDriver } from "./bun-sqlite-driver.js";

/**
 * A Kysely dialect for Bun's native `bun:sqlite` module.
 *
 * ```ts
 * import { Database } from "bun:sqlite";
 * import { Kysely } from "kysely";
 * import { BunSqliteDialect } from "kysely-bun-sqlite-adapter";
 *
 * const db = new Kysely<DB>({
 *   dialect: new BunSqliteDialect({
 *     database: new Database("app.db"),
 *   }),
 * });
 * ```
 */
export class BunSqliteDialect implements Dialect {
  readonly #config: BunSqliteDialectConfig;

  constructor(config: BunSqliteDialectConfig) {
    assertValidConfig(config);
    this.#config = Object.freeze({ ...config });
  }

  createDriver(): Driver {
    return new BunSqliteDriver(this.#config);
  }

  createQueryCompiler(): QueryCompiler {
    return new SqliteQueryCompiler();
  }

  createAdapter(): DialectAdapter {
    return new SqliteAdapter();
  }

  createIntrospector(db: Kysely<any>): DatabaseIntrospector {
    return new SqliteIntrospector(db);
  }
}
