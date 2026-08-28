import { Database } from "bun:sqlite";
import { type Generated, Kysely } from "kysely";
import { BunSqliteDialect, type BunSqliteDialectConfig } from "../index.js";

export interface Person {
  id: Generated<number>;
  name: string;
  age: number;
}

export interface Pet {
  id: Generated<number>;
  name: string;
  owner_id: number;
}

export interface TestDB {
  person: Person;
  pet: Pet;
}

/** A fresh in-memory database with the test schema already applied. */
export function createDatabase(options?: ConstructorParameters<typeof Database>[1]): Database {
  const database = new Database(":memory:", options);

  database.run(`
    create table "person" (
      "id" integer primary key autoincrement,
      "name" text not null unique,
      "age" integer not null
    )
  `);
  database.run(`
    create table "pet" (
      "id" integer primary key autoincrement,
      "name" text not null,
      "owner_id" integer not null references "person" ("id")
    )
  `);

  return database;
}

export function createKysely(
  config: Partial<BunSqliteDialectConfig> & Pick<BunSqliteDialectConfig, "database">,
): Kysely<TestDB> {
  return new Kysely<TestDB>({
    dialect: new BunSqliteDialect(config as BunSqliteDialectConfig),
  });
}

/**
 * Records every SQL string prepared through the database, in order, so tests
 * can assert on statements the driver issues outside Kysely's query executor
 * (`begin`, `savepoint`, and friends are never seen by Kysely's `log` hook).
 */
export function recordSql(database: Database): string[] {
  const recorded: string[] = [];
  const query = database.query.bind(database);

  database.query = ((sql: string) => {
    recorded.push(sql);
    return query(sql);
  }) as Database["query"];

  return recorded;
}
