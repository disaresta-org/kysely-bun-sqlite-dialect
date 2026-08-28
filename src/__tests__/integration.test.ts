import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type Kysely, sql } from "kysely";
import { type Migration, type MigrationProvider, Migrator } from "kysely/migration";
import { createDatabase, createKysely, type TestDB } from "./helpers.js";

describe("BunSqliteDialect integration", () => {
  let database: Database;
  let db: Kysely<TestDB>;

  beforeEach(() => {
    database = createDatabase();
    db = createKysely({ database });
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("introspects tables and columns", async () => {
    const tables = await db.introspection.getTables();

    expect(tables.map((table) => table.name).sort()).toEqual(["person", "pet"]);

    const person = tables.find((table) => table.name === "person");
    expect(person?.columns.map((column) => column.name).sort()).toEqual(["age", "id", "name"]);
    expect(person?.columns.find((column) => column.name === "age")?.isNullable).toBe(false);
  });

  it("runs migrations to the latest version", async () => {
    const migrations: Record<string, Migration> = {
      "001_create_toy": {
        async up(migrationDb) {
          await migrationDb.schema
            .createTable("toy")
            .addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
            .addColumn("name", "text", (col) => col.notNull())
            .execute();
        },
      },
      "002_add_price": {
        async up(migrationDb) {
          await migrationDb.schema.alterTable("toy").addColumn("price", "real").execute();
        },
      },
    };
    const provider: MigrationProvider = {
      async getMigrations() {
        return migrations;
      },
    };

    const { error, results } = await new Migrator({ db, provider }).migrateToLatest();

    expect(error).toBeUndefined();
    expect(results?.map((result) => result.status)).toEqual(["Success", "Success"]);

    const tables = await db.introspection.getTables();
    const toy = tables.find((table) => table.name === "toy");
    expect(toy?.columns.map((column) => column.name).sort()).toEqual(["id", "name", "price"]);
  });

  it("runs raw sql through the sql template tag", async () => {
    await db.insertInto("person").values({ name: "Jennifer", age: 41 }).execute();

    const result = await sql<{ total: number }>`select count(*) as total from "person"`.execute(db);

    expect(result.rows).toEqual([{ total: 1 }]);
  });

  it("reads a pragma through raw sql", async () => {
    const result = await sql<{ journal_mode: string }>`pragma journal_mode`.execute(db);

    expect(result.rows).toEqual([{ journal_mode: "memory" }]);
  });

  it("surfaces sqlite errors with their code intact", async () => {
    await db.insertInto("person").values({ name: "Jennifer", age: 41 }).execute();

    const insertDuplicate = db.insertInto("person").values({ name: "Jennifer", age: 42 }).execute();

    await expect(insertDuplicate).rejects.toMatchObject({ code: "SQLITE_CONSTRAINT_UNIQUE" });
  });

  it("surfaces an error for unknown tables", async () => {
    const query = sql`select * from "nope"`.execute(db);

    await expect(query).rejects.toMatchObject({ code: "SQLITE_ERROR" });
  });

  it("returns bigints when the database uses safe integers", async () => {
    const safe = createDatabase({ safeIntegers: true });
    const safeDb = createKysely({ database: safe });

    await safeDb.insertInto("person").values({ name: "Jennifer", age: 41 }).execute();
    const row = await safeDb.selectFrom("person").select("age").executeTakeFirstOrThrow();

    expect(row.age).toBe(41n as unknown as number);

    await safeDb.destroy();
  });
});

describe("BunSqliteDialect parameter binding", () => {
  let db: Kysely<TestDB>;

  beforeEach(() => {
    db = createKysely({ database: createDatabase() });
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("binds a lone object parameter positionally rather than as named bindings", async () => {
    // Bun reads a single object argument as a named-bindings map, so binding a
    // Date must raise rather than silently leaving the `?` unbound.
    const query = sql`select ${new Date(0)} as value`.execute(db);

    await expect(query).rejects.toThrow(/Binding expected/);
  });

  it("binds a blob parameter", async () => {
    const blob = new Uint8Array([1, 2, 3]);

    const result = await sql<{ value: Uint8Array }>`select ${blob} as value`.execute(db);

    expect(result.rows[0]?.value).toEqual(blob);
  });

  it("binds a lone null parameter", async () => {
    const result = await sql<{ value: null }>`select ${null} as value`.execute(db);

    expect(result.rows).toEqual([{ value: null }]);
  });

  it("binds a lone boolean parameter as an integer", async () => {
    const result = await sql<{ value: number }>`select ${true} as value`.execute(db);

    expect(result.rows).toEqual([{ value: 1 }]);
  });

  it("binds many parameters in order", async () => {
    const result = await sql<{ a: number; b: string; c: number }>`
      select ${1} as a, ${"two"} as b, ${3} as c
    `.execute(db);

    expect(result.rows).toEqual([{ a: 1, b: "two", c: 3 }]);
  });

  it("binds parameters when streaming", async () => {
    await db
      .insertInto("person")
      .values([
        { name: "Jennifer", age: 41 },
        { name: "Arnold", age: 63 },
      ])
      .execute();

    const streamed: string[] = [];
    for await (const row of db.selectFrom("person").select("name").where("age", "=", 63).stream()) {
      streamed.push(row.name);
    }

    expect(streamed).toEqual(["Arnold"]);
  });
});
